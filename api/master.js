import { verifyKey } from 'discord-interactions';
import nodemailer from 'nodemailer';
import fs from 'fs';
import path from 'path';
import cookie from 'cookie';

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
    const rawBody = await getRawBody(req);
    
    if (rawBody) {
        try {
            req.body = JSON.parse(rawBody);
        } catch (e) {
            req.body = rawBody;
        }
    } else {
        req.body = {};
    }

    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname.toLowerCase();

    let matchParam = req.query.match || '';
    if (Array.isArray(matchParam)) matchParam = matchParam.join('/');

    let actionParam = req.query.action || req.query.route || matchParam || req.body?.action || '';
    if (Array.isArray(actionParam)) actionParam = actionParam.join('/');
    const action = actionParam.toLowerCase();

    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1556227335634817054';
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    const GUILD_ID = '1554157703067336875';

    const isRoute = (name) => pathname.includes(name) || action.includes(name);

    // =========================================================================
    // 0. AUTH FALLBACK (In case requests hit master directly)
    // =========================================================================
    if (isRoute('discord')) {
        const redirectUri = encodeURIComponent('https://www.lucidmp3.com/api/auth/callback');
        const discordLoginUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&scope=identify`;
        return res.redirect(discordLoginUrl);
    }

    if (isRoute('callback')) {
        const { code } = req.query;
        if (!code) return res.status(400).send('No code provided from Discord');
        const redirectUri = 'https://www.lucidmp3.com/api/auth/callback';

        try {
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: redirectUri,
                }),
            });

            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) return res.status(400).send('Failed to obtain access token');

            const userRes = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            const userData = await userRes.json();

            res.setHeader('Set-Cookie', cookie.serialize('discord_user', JSON.stringify({
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar
            }), {
                httpOnly: true,
                secure: process.env.NODE_ENV !== 'development',
                maxAge: 60 * 60 * 24 * 7,
                path: '/'
            }));

            return res.redirect('/');
        } catch (error) {
            return res.status(500).send('Authentication error');
        }
    }

    if (isRoute('logout')) {
        res.setHeader('Set-Cookie', 'discord_user=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        return res.redirect('/');
    }

    if (isRoute('me')) {
        const cookies = cookie.parse(req.headers.cookie || '');
        if (!cookies.discord_user) return res.status(401).json({ error: 'Not authenticated' });
        try {
            return res.status(200).json(JSON.parse(cookies.discord_user));
        } catch (e) {
            return res.status(401).json({ error: 'Invalid session' });
        }
    }

    // =========================================================================
    // 1. DISCORD INTERACTIONS
    // =========================================================================
    if (isRoute('interactions') || (req.headers['x-signature-ed25519'] && req.headers['x-signature-timestamp'])) {
        if (req.method !== 'POST') return res.status(405).end();

        const signature = req.headers['x-signature-ed25519'];
        const timestamp = req.headers['x-signature-timestamp'];
        const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

        if (!signature || !timestamp || !PUBLIC_KEY) return res.status(401).send('Missing headers or public key');

        const isValidRequest = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
        if (!isValidRequest) return res.status(401).send('Invalid request signature');

        const interaction = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);

        if (interaction.type === 1) return res.status(200).json({ type: 1 });

        if (interaction.type === 3) {
            const customId = interaction.data.custom_id;
            if (customId === 'btn_accept' || customId === 'btn_reject') {
                const isAccept = customId === 'btn_accept';
                return res.status(200).json({
                    type: 9,
                    data: {
                        title: isAccept ? "Accept Demo" : "Reject Demo",
                        custom_id: isAccept ? "modal_accept" : "modal_reject",
                        components: [{
                            type: 1,
                            components: [{
                                type: 4, 
                                custom_id: "reason_input",
                                label: isAccept ? "Notes for the artist:" : "Enter your reason:",
                                style: 2,
                                required: true
                            }]
                        }]
                    }
                });
            }
        }

        if (interaction.type === 5) {
            const customId = interaction.data.custom_id;
            const reason = interaction.data.components[0].components[0].value;
            const channelId = interaction.channel.id;
            const token = process.env.DISCORD_BOT_TOKEN;

            const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=10`, {
                headers: { 'Authorization': `Bot ${token}` }
            });
            const messages = await msgRes.json();
            
            let subDetails = "";
            for (const msg of messages) {
                if (msg.content && msg.content.includes("**Song title**:")) {
                    subDetails = msg.content;
                    break;
                }
            }

            const titleMatch = subDetails.match(/\*\*Song title\*\*: (.*)/);
            const artistMatch = subDetails.match(/\*\*artist\(s\)\*\*: (.*)/);
            const emailMatch = subDetails.match(/\*\*email\(s\)\*\*: (.*)/) || subDetails.match(/\*\*email adress\*\*: (.*)/);
            const fileMatch = subDetails.match(/\*\*mp3\/wav file\*\*: (.*)/);

            const title = titleMatch ? titleMatch[1].trim() : "Unknown";
            const artist = artistMatch ? artistMatch[1].trim() : "Unknown";
            const rawEmails = emailMatch ? emailMatch[1].trim() : "";
            const fileLink = fileMatch ? fileMatch[1].trim() : "Unknown";

            const recipientEmails = rawEmails.split(',').map(e => e.trim()).filter(e => e.length > 0);

            const transporter = nodemailer.createTransport({
                host: process.env.SMTP_HOST || "smtp.gmail.com",
                port: 465,
                secure: true,
                auth: {
                    user: process.env.SMTP_EMAIL,
                    pass: process.env.SMTP_PASSWORD
                }
            });

            let emailSubject = customId === 'modal_accept' ? "Your demo has been accepted! - Lucid.mp3" : "Update on your demo submission - Lucid.mp3";
            let emailText = customId === 'modal_accept'
                ? `Hey,\n\nTo continue with this track, join our Discord server: https://discord.gg/ECMHzfWyrD\n\nSong title: ${title}\nArtist(s): ${artist}\nFile Link: ${fileLink}\n\nNotes: ${reason}\n\nRegards,\nLucid.mp3`
                : `Hey,\n\nOur team reviewed your track and decided it's not quite the right fit for Lucid.mp3 right now.\n\nReason: ${reason}\n\nPlease keep sending us more demos in the future!\n\nRegards,\nLucid.mp3`;

            if (recipientEmails.length > 0) {
                for (const targetEmail of recipientEmails) {
                    try {
                        await transporter.sendMail({
                            from: `"Lucid.mp3" <${process.env.SMTP_EMAIL}>`,
                            to: targetEmail,
                            subject: emailSubject,
                            text: emailText
                        });
                    } catch (err) {}
                }
            }

            await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${token}` }
            });

            return res.status(200).json({ type: 6 });
        }

        return res.status(400).send('Unknown interaction');
    }

    // =========================================================================
    // 2. GET ROLES
    // =========================================================================
    if (isRoute('getroles')) {
        try {
            const response = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
                method: 'GET',
                headers: { "Authorization": `Bot ${DISCORD_TOKEN}` }
            });
            if (!response.ok) return res.status(response.status).send("Discord API Error");
            const data = await response.json();
            return res.status(200).json(data.filter(member => !member.user.bot));
        } catch(error) {
            return res.status(500).json({ error: "Server Error" });
        }
    }

    // =========================================================================
    // 3. CATALOG
    // =========================================================================
    if (isRoute('catalog')) {
        if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ error: "No DB credentials" });

        if (req.method === 'POST') {
            const newItem = JSON.stringify(req.body.item || req.body);
            await fetch(`${UPSTASH_URL}/rpush/lucid_catalog`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
                body: newItem
            });
            return res.status(201).json({ success: true });
        }

        if (req.method === 'PUT') {
            await fetch(`${UPSTASH_URL}/del/lucid_catalog`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
            });
            const items = Array.isArray(req.body) ? req.body : [];
            for (const item of items) {
                await fetch(`${UPSTASH_URL}/rpush/lucid_catalog`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(item)
                });
            }
            return res.status(200).json({ success: true });
        }
        
        const dbRes = await fetch(`${UPSTASH_URL}/lrange/lucid_catalog/0/-1`, {
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        const dbData = await dbRes.json();
        return res.status(200).json((dbData.result || []).map(item => typeof item === 'string' ? JSON.parse(item) : item));
    }

    // =========================================================================
    // 4. ARTISTS
    // =========================================================================
    if (isRoute('artists')) {
        if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ error: "No DB credentials" });

        if (req.method === 'POST') {
            const newItem = JSON.stringify(req.body.item || req.body);
            await fetch(`${UPSTASH_URL}/rpush/lucid_artists`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
                body: newItem
            });
            return res.status(201).json({ success: true });
        }

        if (req.method === 'PUT') {
            await fetch(`${UPSTASH_URL}/del/lucid_artists`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
            });
            const items = Array.isArray(req.body) ? req.body : [];
            for (const item of items) {
                await fetch(`${UPSTASH_URL}/rpush/lucid_artists`, {
                    method: 'POST',
                    headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(item)
                });
            }
            return res.status(200).json({ success: true });
        }
        
        const dbRes = await fetch(`${UPSTASH_URL}/lrange/lucid_artists/0/-1`, {
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        const dbData = await dbRes.json();
        return res.status(200).json((dbData.result || []).map(item => typeof item === 'string' ? JSON.parse(item) : item));
    }

    // =========================================================================
    // 5. ADMIN SEARCH
    // =========================================================================
    if (isRoute('adminsearch')) {
        if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
        const searchId = req.query.id;
        if (!searchId) return res.status(400).json({ error: 'Missing submission ID parameter' });

        try {
            const dbRes = await fetch(`${UPSTASH_URL}/get/submission:${searchId}`, {
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
            });
            const dbData = await dbRes.json();
            if (dbData.result) {
                return res.status(200).json(typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result);
            }
            return res.status(404).json({ error: 'Submission ID not found' });
        } catch (e) {
            return res.status(500).json({ error: 'Server lookup error' });
        }
    }

    // =========================================================================
    // 6. SUBMIT DEMO
    // =========================================================================
    if (isRoute('submitdemo')) {
        if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

        const CATEGORY_ID = '1554160433722691594'; 
        const ROLE_1 = '1556218488425812079'; 
        const ROLE_2 = '1556249102444925039'; 

        const cookies = cookie.parse(req.headers.cookie || '');
        let loggedInUserId = null;
        if (cookies.discord_user) {
            try { loggedInUserId = JSON.parse(cookies.discord_user).id; } catch(e) {}
        }

        try {
            const data = req.body;
            const title = data["Song title"] || data.title;
            const artist = data["artist(s)"] || data.artist;
            const email = data["email adress"] || data.email;
            const fileLink = data["mp3/wav file"] || data.fileUrl;

            const countRes = await fetch(`${UPSTASH_URL}/incr/submission_counter`, {
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
            });
            const countData = await countRes.json();
            const paddedCount = String(countData.result).padStart(4, '0');
            const submissionId = `lcd-demo-${paddedCount}`;

            const record = {
                submissionId,
                title,
                artist,
                email,
                fileLink,
                discordId: loggedInUserId || "Guest",
                timestamp: new Date().toISOString()
            };

            await fetch(`${UPSTASH_URL}/set/submission:${submissionId}`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(record)
            });

            const safeArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
            const channelName = `web-ticket-${safeArtist}`.substring(0, 100);

            const createChannelRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    name: channelName,
                    type: 0,
                    parent_id: CATEGORY_ID,
                    permission_overwrites: [
                        { id: GUILD_ID, type: 0, deny: "1024" }, 
                        { id: ROLE_1, type: 0, allow: "17408" },  
                        { id: ROLE_2, type: 0, allow: "17408" }   
                    ]
                })
            });

            if (!createChannelRes.ok) return res.status(500).send(`Discord API Error`);
            const channelData = await createChannelRes.json();

            await fetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `<@&${ROLE_1}> <@&${ROLE_2}>`,
                    embeds: [{
                        title: "Wait for Demo review",
                        description: `Thank you for opening a ticket! Submission ID: **${submissionId}**`,
                        color: 0x2b2d31,
                        footer: { text: "Powered by Lucid.Mp3" } 
                    }]
                })
            });

            await fetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    content: `**New Submission (ID: ${submissionId})**\n> **Song title**: ${title}\n> **artist(s)**: ${artist}\n> **File Name**: ${title} - ${artist}\n> **email(s)**: ${email}\n> **mp3/wav file**: ${fileLink}`,
                    components: [{
                        type: 1,
                        components: [
                            { type: 2, style: 3, label: "Accept Demo", custom_id: "btn_accept", emoji: { name: "✅" } },
                            { type: 2, style: 4, label: "Reject (Close with Reason)", custom_id: "btn_reject", emoji: { name: "❌" } }
                        ]
                    }]
                })
            });

            return res.status(200).json({ success: true, submissionId });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    // =========================================================================
    // 7. PROFILE
    // =========================================================================
    if (isRoute('profile')) {
        const headers = { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' };

        if (req.method === 'GET') {
            const { userId, username } = req.query;
            let key = userId ? `bio:user:${userId}` : null;
            let resolvedHandle = username ? username.toLowerCase() : null;

            if (!key && username) {
                const handleRes = await fetch(`${UPSTASH_URL}/get/bio:handle:${username.toLowerCase()}`, { headers });
                const handleData = await handleRes.json();
                if (handleData.result) {
                    const rawId = handleData.result;
                    const cleanId = typeof rawId === 'string' && rawId.startsWith('"') ? JSON.parse(rawId) : rawId;
                    key = `bio:user:${cleanId}`;
                }
            }

            if (!key) return res.status(404).json({ error: "Profile not found" });

            const profileRes = await fetch(`${UPSTASH_URL}/get/${key}`, { headers });
            const profileData = await profileRes.json();
            const data = profileData.result ? (typeof profileData.result === 'string' ? JSON.parse(profileData.result) : profileData.result) : null;
            
            if (data) {
                const handleToRank = resolvedHandle || data.handle || data.username;
                if (handleToRank) {
                    await fetch(`${UPSTASH_URL}/zincrby/bio_leaderboard/1/${handleToRank.toLowerCase()}`, { method: 'POST', headers });
                }
            }

            return res.status(200).json(data || {});
        }

        if (req.method === 'POST') {
            const body = req.body.profileData || req.body;
            const userId = req.body.userId || body.userId;
            const username = req.body.username || body.username || body.handle;
            
            if (!userId) return res.status(400).json({ error: "Missing userId" });

            const getExisting = await fetch(`${UPSTASH_URL}/get/bio:user:${userId}`, { headers });
            const existingData = await getExisting.json();
            let existing = existingData.result ? (typeof existingData.result === 'string' ? JSON.parse(existingData.result) : existingData.result) : {};

            const updatedData = {
                ...existing,
                ...body,
                userId: userId,
                staffBadges: existing.staffBadges || []
            };

            await fetch(`${UPSTASH_URL}/set/bio:user:${userId}`, { method: 'POST', headers, body: JSON.stringify(updatedData) });
            if (username) {
                const cleanHandle = username.toLowerCase();
                await fetch(`${UPSTASH_URL}/set/bio:handle:${cleanHandle}`, { method: 'POST', headers, body: JSON.stringify(userId) });
                await fetch(`${UPSTASH_URL}/zadd/bio_leaderboard/0/${cleanHandle}`, { method: 'POST', headers });
            }

            return res.status(200).json({ success: true });
        }

        if (req.method === 'PATCH') {
            const { userId, action: badgeAction, badge } = req.body;
            if (!userId || !badge) return res.status(400).json({ error: "Missing fields" });

            const getExisting = await fetch(`${UPSTASH_URL}/get/bio:user:${userId}`, { headers });
            const existingData = await getExisting.json();
            let profile = existingData.result ? (typeof existingData.result === 'string' ? JSON.parse(existingData.result) : existingData.result) : { userId };

            profile.staffBadges = profile.staffBadges || [];

            if (badgeAction === 'add' || badgeAction === 'grant') {
                if (!profile.staffBadges.includes(badge)) profile.staffBadges.push(badge);
            } else if (badgeAction === 'remove' || badgeAction === 'revoke') {
                profile.staffBadges = profile.staffBadges.filter(b => b !== badge);
            }

            await fetch(`${UPSTASH_URL}/set/bio:user:${userId}`, { method: 'POST', headers, body: JSON.stringify(profile) });
            return res.status(200).json({ success: true, staffBadges: profile.staffBadges });
        }
    }

    // =========================================================================
    // 8. LEADERBOARD
    // =========================================================================
    if (isRoute('leaderboard')) {
        const headers = { 'Authorization': `Bearer ${UPSTASH_TOKEN}` };

        try {
            const lbRes = await fetch(`${UPSTASH_URL}/zrevrange/bio_leaderboard/0/9/WITHSCORES`, { headers });
            const lbData = await lbRes.json();
            const rawList = lbData.result || [];

            const leaderboard = [];
            for (let i = 0; i < rawList.length; i += 2) {
                const handle = rawList[i];
                const views = parseInt(rawList[i + 1], 10) || 0;

                let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
                try {
                    const uIdRes = await fetch(`${UPSTASH_URL}/get/bio:handle:${handle.toLowerCase()}`, { headers });
                    const uIdData = await uIdRes.json();
                    if (uIdData.result) {
                        const cleanUid = typeof uIdData.result === 'string' && uIdData.result.startsWith('"') ? JSON.parse(uIdData.result) : uIdData.result;
                        const profRes = await fetch(`${UPSTASH_URL}/get/bio:user:${cleanUid}`, { headers });
                        const profData = await profRes.json();
                        const prof = profData.result ? (typeof profData.result === 'string' ? JSON.parse(profData.result) : profData.result) : {};
                        if (prof.avatarUrl || prof.avatar) avatar = prof.avatarUrl || prof.avatar;
                    }
                } catch(e) {}

                leaderboard.push({
                    rank: (i / 2) + 1,
                    handle,
                    views,
                    avatar
                });
            }

            return res.status(200).json(leaderboard);
        } catch(e) {
            return res.status(500).json({ error: "Failed to load datastore leaderboard" });
        }
    }

    // =========================================================================
    // 9. MASTERBOT & SPOTIFY AUTOMATION
    // =========================================================================
    if (isRoute('masterbot') || isRoute('spotifysync')) {
        if (req.method === 'GET' || action.includes('spotifysync')) {
            const CLIENT_ID_SPOT = process.env.SPOTIFY_CLIENT_ID;
            const CLIENT_SECRET_SPOT = process.env.SPOTIFY_CLIENT_SECRET;
            const PLAYLIST_ID = process.env.SPOTIFY_PLAYLIST_ID;
            const CHANNEL_ID = process.env.RELEASES_CHANNEL_ID; 
            const ROLE_ID = process.env.NEW_RELEASE_ROLE_ID; 

            if (!CLIENT_ID_SPOT || !CLIENT_SECRET_SPOT || !PLAYLIST_ID || !DISCORD_TOKEN) {
                return res.status(500).json({ error: 'Missing Spotify API Environment Variables.' });
            }

            try {
                const authString = Buffer.from(`${CLIENT_ID_SPOT}:${CLIENT_SECRET_SPOT}`).toString('base64');
                const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: { 'Authorization': `Basic ${authString}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: 'grant_type=client_credentials'
                });
                const tokenData = await tokenRes.json();
                if (!tokenData.access_token) return res.status(500).json({ error: 'Failed to authenticate with Spotify API' });

                const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?limit=25`, {
                    headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                });
                const playlistData = await playlistRes.json();
                if (!playlistData.items || playlistData.items.length === 0) return res.status(200).json({ message: 'Playlist empty.' });

                const currentTracksData = playlistData.items.map(item => {
                    const track = item.track;
                    if (!track || !track.external_urls?.spotify) return null;
                    return {
                        url: track.external_urls.spotify,
                        name: track.name || "Unknown Track",
                        artists: track.artists ? track.artists.map(a => a.name).join(', ') : "Unknown Artist"
                    };
                }).filter(Boolean);

                const dbRes = await fetch(`${UPSTASH_URL}/get/spotify_last_checked`, { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } });
                const dbData = await dbRes.json();
                let previouslyPosted = dbData.result ? (typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result) : [];

                let newTracks = currentTracksData.filter(track => !previouslyPosted.includes(track.url));
                if (previouslyPosted.length === 0 && newTracks.length > 3) newTracks = newTracks.slice(0, 3);
                if (newTracks.length === 0) return res.status(200).json({ message: 'No new tracks to post.', tracksFound: currentTracksData.length });

                let discordMessage = `<@&${ROLE_ID}>\n## New **Lucid.Mp3** Releases\n\n`;
                newTracks.forEach(track => {
                    discordMessage += `* ${track.name} - ${track.artists}:\n   ${track.url}\n\n`;
                });

                await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: discordMessage.trim() })
                });

                const allUrls = currentTracksData.map(t => t.url);
                const updatedMemory = Array.from(new Set([...allUrls, ...previouslyPosted])).slice(0, 500); 
                await fetch(`${UPSTASH_URL}/set/spotify_last_checked`, {
                    method: 'POST', headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(updatedMemory)
                });

                return res.status(200).json({ success: true, posted: newTracks.length });
            } catch (error) {
                return res.status(500).json({ error: error.message });
            }
        }

        if (req.method === 'POST') {
            const { command, userId, action: modAction, duration, roleId, reason, channelId, message, title, imageUrl, count } = req.body; 
            const headers = { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'X-Audit-Log-Reason': reason || 'Admin Panel' };

            try {
                if (command === 'welcomeLeave') {
                    const isWelcome = modAction === 'welcome' || req.body.type === 'welcome';
                    const userRes = await fetch(`https://discord.com/api/v10/users/${userId}`, { headers });
                    const userData = await userRes.json();
                    
                    let avatarUrl = userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=256` : 'https://cdn.discordapp.com/embed/avatars/0.png';

                    const embed = {
                        title: isWelcome ? "Member Joined" : "Member Left",
                        description: isWelcome ? `Welcome <@${userId}> to **Lucid.Mp3**.` : `<@${userId}> has left **Lucid.Mp3**.`,
                        color: 0x2b2d31,
                        thumbnail: { url: avatarUrl },
                        timestamp: new Date().toISOString()
                    };

                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                        method: 'POST', headers, body: JSON.stringify({ embeds: [embed] })
                    });
                    return res.status(200).json({ success: true });
                }

                if (command === 'announce') {
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers, body: JSON.stringify({ content: message }) });
                    return res.status(200).json({ success: true });
                }
                if (command === 'embed') {
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers, body: JSON.stringify({ embeds: [{ title: title, description: message, color: 0x2b2d31, image: imageUrl ? { url: imageUrl } : null }] }) });
                    return res.status(200).json({ success: true });
                }
                if (command === 'moderate' && modAction === 'purge') {
                    const getRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${count}`, { headers });
                    const messages = await getRes.json();
                    if (!messages || messages.length === 0) return res.status(200).json({ success: true });
                    const messageIds = messages.map(m => m.id);
                    if (messageIds.length === 1) await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageIds[0]}`, { method: 'DELETE', headers });
                    else await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, { method: 'POST', headers, body: JSON.stringify({ messages: messageIds }) });
                    return res.status(200).json({ success: true });
                }
                if (command === 'lockdown') {
                    const lockState = modAction === 'lock' ? "2048" : "0"; 
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/permissions/${GUILD_ID}`, { method: 'PUT', headers, body: JSON.stringify({ type: 0, deny: lockState, allow: modAction === 'unlock' ? "2048" : "0" }) });
                    return res.status(200).json({ success: true });
                }

                if (command === 'moderate') {
                    let url = '', method = '', bodyPayload = null;

                    if (modAction === 'kick') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'DELETE'; }
                    else if (modAction === 'ban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`; method = 'PUT'; }
                    else if (modAction === 'unban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`; method = 'DELETE'; }
                    else if (modAction === 'softban') {
                        const banUrl = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
                        await fetch(banUrl, { method: 'PUT', headers, body: JSON.stringify({ delete_message_seconds: 604800 }) });
                        await fetch(banUrl, { method: 'DELETE', headers });
                        return res.status(200).json({ success: true });
                    }
                    else if (modAction === 'timeout') {
                        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'PATCH';
                        const until = new Date(Date.now() + parseInt(duration) * 1000).toISOString();
                        bodyPayload = JSON.stringify({ communication_disabled_until: until });
                    }
                    else if (modAction === 'untimeout') {
                        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'PATCH';
                        bodyPayload = JSON.stringify({ communication_disabled_until: null });
                    }
                    else if (modAction === 'warn') {
                        await fetch(`${UPSTASH_URL}/rpush/warnings:${userId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || "No reason", date: new Date().toISOString() }) });
                        return res.status(200).json({ success: true });
                    }
                    else if (modAction === 'warnings') {
                        const resWarn = await fetch(`${UPSTASH_URL}/lrange/warnings:${userId}/0/-1`, { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } });
                        const dataWarn = await resWarn.json();
                        return res.status(200).json({ success: true, warnings: dataWarn.result || [] });
                    }
                    else if (modAction === 'addRole') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`; method = 'PUT'; }
                    else if (modAction === 'removeRole') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`; method = 'DELETE'; }
                    else if (modAction === 'roleall') {
                        const membersRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, { headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` } });
                        const members = await membersRes.json();
                        for (const m of members) {
                            if (!m.user.bot) await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/${m.user.id}/roles/${roleId}`, { method: 'PUT', headers });
                        }
                        return res.status(200).json({ success: true });
                    }

                    if (url) await fetch(url, { method, headers, body: bodyPayload });
                    return res.status(200).json({ success: true });
                }
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
    }

    return res.status(404).json({ error: "Endpoint not found" });
}
