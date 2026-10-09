import { verifyKey } from 'discord-interactions';
import nodemailer from 'nodemailer';
import cookie from 'cookie';

// Disable default Vercel bodyParser so raw Ed25519 signature checks succeed
export const config = {
    api: {
        bodyParser: false,
    },
};

/**
 * Buffer stream reader to extract unparsed raw string body.
 * Required for Discord cryptographic signature verification.
 */
async function getRawBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Safe parameter unwrapper for Vercel dynamic routing rewrites.
 */
function unwrapParam(val) {
    if (!val) return '';
    if (Array.isArray(val)) return val.join('/');
    return String(val);
}

/**
 * Sanitizes Upstash string IDs from nested quote serialization.
 */
function cleanRedisId(rawId) {
    if (!rawId) return null;
    let str = String(rawId).trim();
    if (str.startsWith('"') && str.endsWith('"')) {
        try { 
            str = JSON.parse(str); 
        } catch (e) { 
            str = str.slice(1, -1); 
        }
    }
    return str;
}

export default async function handler(req, res) {
    // 1. Extract raw body and attempt JSON parsing for standard API endpoints
    const rawBody = await getRawBody(req);
    
    if (rawBody && rawBody.trim().length > 0) {
        try {
            req.body = JSON.parse(rawBody);
        } catch (e) {
            req.body = rawBody;
        }
    } else {
        req.body = {};
    }

    // 2. URL and routing parameters normalization
    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname.toLowerCase();

    const matchParam = unwrapParam(req.query.match);
    const actionParam = unwrapParam(req.query.action || req.query.route || matchParam || req.body?.action);
    const action = actionParam.toLowerCase();

    // Helper for multi-path routing matching
    const isRoute = (name) => {
        const lowerName = name.toLowerCase();
        return pathname.includes(lowerName) || action.includes(lowerName);
    };

    // 3. Environment variables configuration
    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const DISCORD_PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1556227335634817054';
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    const GUILD_ID = '1554157703067336875';

    const redisHeaders = {
        'Authorization': `Bearer ${UPSTASH_TOKEN}`,
        'Content-Type': 'application/json'
    };

    const discordHeaders = {
        'Authorization': `Bot ${DISCORD_TOKEN}`,
        'Content-Type': 'application/json'
    };

    // =========================================================================
    // SECTION 0: DIRECT MEDIA STORAGE PROXY (NO GOFILE / NO CATBOX IP BLOCKS)
    // =========================================================================
    if (isRoute('upload')) {
        if (req.method !== 'POST') return res.status(405).json({ error: "Method not allowed" });
        try {
            const { fileData, fileName } = req.body;
            if (!fileData) return res.status(400).json({ error: "Missing fileData payload" });

            let base64Content = fileData;
            let mimeType = 'application/octet-stream';
            if (fileData.includes(';base64,')) {
                const parts = fileData.split(';base64,');
                mimeType = parts[0].replace('data:', '');
                base64Content = parts[1];
            }

            const buffer = Buffer.from(base64Content, 'base64');
            const blob = new Blob([buffer], { type: mimeType });

            // Provider 1: qu.ax (High-speed open CDN, raw audio/video/image links)
            try {
                const fd = new FormData();
                fd.append('files[]', blob, fileName || 'media.bin');
                const qRes = await fetch('https://qu.ax/api/upload', { method: 'POST', body: fd });
                const qData = await qRes.json();
                if (qData.success && qData.files && qData.files[0]?.url) {
                    return res.status(200).json({ success: true, url: qData.files[0].url });
                }
            } catch (err) {}

            // Provider 2: tmpfiles.org direct download stream fallback
            try {
                const fd2 = new FormData();
                fd2.append('file', blob, fileName || 'media.bin');
                const tRes = await fetch('https://tmpfiles.org/api/v1/upload', { method: 'POST', body: fd2 });
                const tData = await tRes.json();
                if (tData.data?.url) {
                    const directUrl = tData.data.url.replace('tmpfiles.org/', 'tmpfiles.org/dl/');
                    return res.status(200).json({ success: true, url: directUrl });
                }
            } catch (err) {}

            return res.status(500).json({ error: "Direct storage providers currently unreachable" });
        } catch (err) {
            return res.status(500).json({ error: err.message });
        }
    }

    // =========================================================================
    // SECTION 1: DISCORD OAUTH2 AUTHENTICATION & SESSION SUITE
    // =========================================================================
    if (isRoute('discord') || isRoute('auth/discord')) {
        const redirectUri = encodeURIComponent('https://www.lucidmp3.com/api/auth/callback');
        const discordLoginUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${redirectUri}&scope=identify`;
        return res.redirect(discordLoginUrl);
    }

    if (isRoute('callback') || isRoute('auth/callback')) {
        const code = req.query.code;
        if (!code) return res.status(400).send('Authorization code missing from Discord callback.');
        const redirectUri = 'https://www.lucidmp3.com/api/auth/callback';

        try {
            const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
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

            const tokenData = await tokenResponse.json();
            if (!tokenData.access_token) return res.status(400).send('Failed to obtain Discord access token.');

            const userResponse = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            const userData = await userResponse.json();

            res.setHeader('Set-Cookie', cookie.serialize('discord_user', JSON.stringify({
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                discriminator: userData.discriminator || '0'
            }), {
                httpOnly: true,
                secure: process.env.NODE_ENV !== 'development',
                maxAge: 60 * 60 * 24 * 7, // 1 Week
                path: '/'
            }));

            return res.redirect('/');
        } catch (error) {
            return res.status(500).send(`Authentication error: ${error.message}`);
        }
    }

    if (isRoute('logout') || isRoute('auth/logout')) {
        res.setHeader('Set-Cookie', 'discord_user=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        return res.redirect('/');
    }

    if (isRoute('me') || isRoute('auth/me')) {
        const cookies = cookie.parse(req.headers.cookie || '');
        if (!cookies.discord_user) {
            return res.status(401).json({ error: 'Not authenticated' });
        }
        try {
            const user = JSON.parse(cookies.discord_user);
            return res.status(200).json(user);
        } catch (e) {
            return res.status(401).json({ error: 'Invalid user session token' });
        }
    }

    // =========================================================================
    // SECTION 2: DISCORD INTERACTIONS WEBHOOK (MODALS, EMAILS & DISPATCH)
    // =========================================================================
    if (isRoute('interactions') || (req.headers['x-signature-ed25519'] && req.headers['x-signature-timestamp'])) {
        if (req.method !== 'POST') return res.status(405).end();

        const signature = req.headers['x-signature-ed25519'];
        const timestamp = req.headers['x-signature-timestamp'];

        if (!signature || !timestamp || !DISCORD_PUBLIC_KEY) {
            return res.status(401).send('Missing request cryptographic signature headers or public key.');
        }

        const isValidRequest = verifyKey(rawBody, signature, timestamp, DISCORD_PUBLIC_KEY);
        if (!isValidRequest) {
            return res.status(401).send('Invalid Ed25519 request signature.');
        }

        const interaction = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);

        // Ping Handshake (Type 1)
        if (interaction.type === 1) {
            return res.status(200).json({ type: 1 });
        }

        // Button Click -> Trigger Interactive Modal (Type 3 -> Type 9)
        if (interaction.type === 3) {
            const customId = interaction.data?.custom_id;
            if (customId === 'btn_accept' || customId === 'btn_reject') {
                const isAccept = customId === 'btn_accept';
                return res.status(200).json({
                    type: 9,
                    data: {
                        title: isAccept ? "Accept Demo Submission" : "Reject Demo Submission",
                        custom_id: isAccept ? "modal_accept" : "modal_reject",
                        components: [{
                            type: 1,
                            components: [{
                                type: 4,
                                custom_id: "reason_input",
                                label: isAccept ? "Feedback / Next steps for artist:" : "Feedback / Rejection reason:",
                                style: 2,
                                required: true,
                                placeholder: isAccept ? "Next steps or server onboarding notes..." : "State reasons for track rejection..."
                            }]
                        }]
                    }
                });
            }
        }

        // Modal Submit -> Process Multi-recipient Email Dispatch & Close Channel (Type 5)
        if (interaction.type === 5) {
            const customId = interaction.data?.custom_id;
            const reason = interaction.data?.components?.[0]?.components?.[0]?.value || "No feedback provided.";
            const channelId = interaction.channel?.id;

            try {
                const channelMessagesRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=15`, {
                    headers: discordHeaders
                });
                const channelMessages = await channelMessagesRes.json();

                let subDetails = "";
                if (Array.isArray(channelMessages)) {
                    for (const msg of channelMessages) {
                        if (msg.content && msg.content.includes("**Song title**:")) {
                            subDetails = msg.content;
                            break;
                        }
                    }
                }

                const titleMatch = subDetails.match(/\*\*Song title\*\*: (.*)/);
                const artistMatch = subDetails.match(/\*\*artist\(s\)\*\*: (.*)/);
                const emailMatch = subDetails.match(/\*\*email\(s\)\*\*: (.*)/) || subDetails.match(/\*\*email adress\*\*: (.*)/);
                const fileMatch = subDetails.match(/\*\*mp3\/wav file\*\*: (.*)/);

                const title = titleMatch ? titleMatch[1].trim() : "Unknown Track";
                const artist = artistMatch ? artistMatch[1].trim() : "Unknown Artist";
                const rawEmails = emailMatch ? emailMatch[1].trim() : "";
                const fileLink = fileMatch ? fileMatch[1].trim() : "No File Provided";

                const recipientEmails = rawEmails.split(',').map(e => e.trim()).filter(e => e.length > 0 && e.includes('@'));

                const transporter = nodemailer.createTransport({
                    host: process.env.SMTP_HOST || "smtp.gmail.com",
                    port: 465,
                    secure: true,
                    auth: {
                        user: process.env.SMTP_EMAIL,
                        pass: process.env.SMTP_PASSWORD
                    }
                });

                let emailSubject = "";
                let emailBody = "";

                if (customId === 'modal_accept') {
                    emailSubject = "Your demo has been accepted! - Lucid.mp3";
                    emailBody = `Hey,\n\nCongratulations! Our A&R team reviewed your track and approved it for release on Lucid.mp3.\n\n` +
                                `To proceed with your release, join our server: https://discord.gg/ECMHzfWyrD\n\n` +
                                `Track Title: ${title}\n` +
                                `Artist: ${artist}\n` +
                                `Audio Link: ${fileLink}\n\n` +
                                `Feedback: ${reason}\n\n` +
                                `Best regards,\nLucid.mp3 A&R Team`;
                } else {
                    emailSubject = "Update on your demo submission - Lucid.mp3";
                    emailBody = `Hey,\n\nThank you for submitting your demo to Lucid.mp3.\n\n` +
                                `Our team reviewed "${title}" and decided it is not quite the right fit for our catalog right now.\n\n` +
                                `Feedback: ${reason}\n\n` +
                                `Please feel free to submit future demos to us!\n\n` +
                                `Best regards,\nLucid.mp3 A&R Team`;
                }

                if (recipientEmails.length > 0) {
                    for (const targetEmail of recipientEmails) {
                        try {
                            await transporter.sendMail({
                                from: `"Lucid.mp3 A&R" <${process.env.SMTP_EMAIL}>`,
                                to: targetEmail,
                                subject: emailSubject,
                                text: emailBody
                            });
                        } catch (mailErr) {
                            console.error(`Failed to dispatch email to ${targetEmail}:`, mailErr);
                        }
                    }
                }

                await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                    method: 'DELETE',
                    headers: discordHeaders
                });

                return res.status(200).json({ type: 6 });
            } catch (err) {
                return res.status(500).json({ error: err.message });
            }
        }

        return res.status(400).send('Unhandled interaction type.');
    }

    // =========================================================================
    // SECTION 3: A&R DEMO SUBMISSION PIPELINE & ADMIN LOOKUP
    // =========================================================================
    if (isRoute('submitdemo')) {
        if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

        const CATEGORY_ID = '1554160433722691594';
        const ROLE_1 = '1556218488425812079';
        const ROLE_2 = '1556249102444925039';

        if (!DISCORD_TOKEN || !UPSTASH_URL || !UPSTASH_TOKEN) {
            return res.status(500).json({ error: 'Missing Discord Token or Upstash Redis configuration.' });
        }

        const cookies = cookie.parse(req.headers.cookie || '');
        let loggedInUserId = null;
        if (cookies.discord_user) {
            try {
                const userObj = JSON.parse(cookies.discord_user);
                loggedInUserId = userObj.id;
            } catch (e) {}
        }

        try {
            const data = req.body;
            const title = data["Song title"] || data.title || "Untitled";
            const artist = data["artist(s)"] || data.artist || "Unknown";
            const email = data["email adress"] || data.email || "No Email Provided";
            const fileLink = data["mp3/wav file"] || data.fileUrl || "No File";

            const countRes = await fetch(`${UPSTASH_URL}/incr/submission_counter`, { headers: redisHeaders });
            const countData = await countRes.json();
            const nextCount = countData.result || 1;

            const paddedCount = String(nextCount).padStart(4, '0');
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
                headers: redisHeaders,
                body: JSON.stringify(record)
            });

            const formattedFileName = `${title} - ${artist}`;
            const safeArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
            const channelName = `web-ticket-${safeArtist}`.substring(0, 100);

            const channelPayload = {
                name: channelName,
                type: 0,
                parent_id: CATEGORY_ID,
                permission_overwrites: [
                    { id: GUILD_ID, type: 0, deny: "1024" },
                    { id: ROLE_1, type: 0, allow: "17408" },
                    { id: ROLE_2, type: 0, allow: "17408" }
                ]
            };

            const createChannelRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
                method: 'POST',
                headers: discordHeaders,
                body: JSON.stringify(channelPayload)
            });

            if (!createChannelRes.ok) {
                const errText = await createChannelRes.text();
                return res.status(500).json({ error: `Discord Channel Creation Error: ${errText}` });
            }

            const channelData = await createChannelRes.json();

            const embedPayload = {
                content: `<@&${ROLE_1}> <@&${ROLE_2}>`,
                embeds: [{
                    title: "Demo Review Request",
                    description: `New submission received from website.\nSubmission Reference: **${submissionId}**`,
                    color: 0x2b2d31,
                    footer: { text: "Powered by Lucid.Mp3 A&R Gateway" }
                }]
            };

            await fetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
                method: 'POST',
                headers: discordHeaders,
                body: JSON.stringify(embedPayload)
            });

            const detailsPayload = {
                content: `**New Submission (ID: ${submissionId})**\n> **Song title**: ${title}\n> **artist(s)**: ${artist}\n> **File Name**: ${formattedFileName}\n> **email(s)**: ${email}\n> **mp3/wav file**: ${fileLink}`,
                components: [{
                    type: 1,
                    components: [
                        { type: 2, style: 3, label: "Accept Demo", custom_id: "btn_accept", emoji: { name: "✅" } },
                        { type: 2, style: 4, label: "Reject (Close Ticket)", custom_id: "btn_reject", emoji: { name: "❌" } }
                    ]
                }]
            };

            await fetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
                method: 'POST',
                headers: discordHeaders,
                body: JSON.stringify(detailsPayload)
            });

            return res.status(200).json({ success: true, submissionId });
        } catch (error) {
            return res.status(500).json({ error: error.message });
        }
    }

    if (isRoute('adminsearch')) {
        if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');
        const searchId = req.query.id;
        if (!searchId) return res.status(400).json({ error: 'Missing submission ID parameter.' });

        try {
            const dbRes = await fetch(`${UPSTASH_URL}/get/submission:${searchId}`, { headers: redisHeaders });
            const dbData = await dbRes.json();

            if (dbData.result) {
                const record = typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result;
                return res.status(200).json(record);
            }
            return res.status(404).json({ error: 'Submission ID not found in database.' });
        } catch (e) {
            return res.status(500).json({ error: 'Server database lookup error.' });
        }
    }

    // =========================================================================
    // SECTION 4: CATALOG & RELEASES CRUD MANAGEMENT
    // =========================================================================
    if (isRoute('catalog')) {
        if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ error: "Missing Upstash database keys" });

        if (req.method === 'POST') {
            const newItem = JSON.stringify(req.body.item || req.body);
            await fetch(`${UPSTASH_URL}/rpush/lucid_catalog`, {
                method: 'POST',
                headers: redisHeaders,
                body: newItem
            });
            return res.status(201).json({ success: true });
        }

        if (req.method === 'PUT') {
            await fetch(`${UPSTASH_URL}/del/lucid_catalog`, { method: 'POST', headers: redisHeaders });
            const items = Array.isArray(req.body) ? req.body : [];
            for (const item of items) {
                await fetch(`${UPSTASH_URL}/rpush/lucid_catalog`, {
                    method: 'POST',
                    headers: redisHeaders,
                    body: JSON.stringify(item)
                });
            }
            return res.status(200).json({ success: true });
        }

        const dbRes = await fetch(`${UPSTASH_URL}/lrange/lucid_catalog/0/-1`, { headers: redisHeaders });
        const dbData = await dbRes.json();
        const catalog = (dbData.result || []).map(item => typeof item === 'string' ? JSON.parse(item) : item);
        return res.status(200).json(catalog);
    }

    // =========================================================================
    // SECTION 5: ARTISTS ROSTER CRUD MANAGEMENT
    // =========================================================================
    if (isRoute('artists')) {
        if (!UPSTASH_URL || !UPSTASH_TOKEN) return res.status(500).json({ error: "Missing Upstash database keys" });

        if (req.method === 'POST') {
            const newItem = JSON.stringify(req.body.item || req.body);
            await fetch(`${UPSTASH_URL}/rpush/lucid_artists`, {
                method: 'POST',
                headers: redisHeaders,
                body: newItem
            });
            return res.status(201).json({ success: true });
        }

        if (req.method === 'PUT') {
            await fetch(`${UPSTASH_URL}/del/lucid_artists`, { method: 'POST', headers: redisHeaders });
            const items = Array.isArray(req.body) ? req.body : [];
            for (const item of items) {
                await fetch(`${UPSTASH_URL}/rpush/lucid_artists`, {
                    method: 'POST',
                    headers: redisHeaders,
                    body: JSON.stringify(item)
                });
            }
            return res.status(200).json({ success: true });
        }

        const dbRes = await fetch(`${UPSTASH_URL}/lrange/lucid_artists/0/-1`, { headers: redisHeaders });
        const dbData = await dbRes.json();
        const artists = (dbData.result || []).map(item => typeof item === 'string' ? JSON.parse(item) : item);
        return res.status(200).json(artists);
    }

    // =========================================================================
    // SECTION 6: PROFILE & IDENTITY ENGINE (CUSTOM TABS, METADATA & BADGES)
    // =========================================================================
    if (isRoute('profile')) {
        if (req.method === 'GET') {
            const { userId, username } = req.query;
            let key = userId ? `bio:user:${userId}` : null;
            let resolvedHandle = username ? username.toLowerCase() : null;

            if (!key && username) {
                const handleRes = await fetch(`${UPSTASH_URL}/get/bio:handle:${username.toLowerCase()}`, { headers: redisHeaders });
                const handleData = await handleRes.json();
                if (handleData.result) {
                    const cleanId = cleanRedisId(handleData.result);
                    key = `bio:user:${cleanId}`;
                }
            }

            if (!key) return res.status(404).json({ error: "Profile not found" });

            const profileRes = await fetch(`${UPSTASH_URL}/get/${key}`, { headers: redisHeaders });
            const profileData = await profileRes.json();
            const data = profileData.result ? (typeof profileData.result === 'string' ? JSON.parse(profileData.result) : profileData.result) : null;

            if (data) {
                const handleToRank = resolvedHandle || data.handle || data.username;
                if (handleToRank) {
                    await fetch(`${UPSTASH_URL}/zincrby/bio_leaderboard/1/${handleToRank.toLowerCase()}`, {
                        method: 'POST',
                        headers: redisHeaders
                    });
                }
            }

            return res.status(200).json(data || {});
        }

        if (req.method === 'POST') {
            const body = req.body.profileData || req.body;
            const targetUserId = req.body.userId || body.userId;
            const username = req.body.username || body.username || body.handle;

            if (!targetUserId) return res.status(400).json({ error: "Missing userId" });

            const getExisting = await fetch(`${UPSTASH_URL}/get/bio:user:${targetUserId}`, { headers: redisHeaders });
            const existingData = await getExisting.json();
            let existing = existingData.result ? (typeof existingData.result === 'string' ? JSON.parse(existingData.result) : existingData.result) : {};

            const updatedData = {
                ...existing,
                ...body,
                userId: targetUserId,
                staffBadges: existing.staffBadges || []
            };

            await fetch(`${UPSTASH_URL}/set/bio:user:${targetUserId}`, {
                method: 'POST',
                headers: redisHeaders,
                body: JSON.stringify(updatedData)
            });

            if (username) {
                const cleanHandle = username.toLowerCase();
                await fetch(`${UPSTASH_URL}/set/bio:handle:${cleanHandle}`, {
                    method: 'POST',
                    headers: redisHeaders,
                    body: JSON.stringify(targetUserId)
                });
                await fetch(`${UPSTASH_URL}/zadd/bio_leaderboard/0/${cleanHandle}`, {
                    method: 'POST',
                    headers: redisHeaders
                });
            }

            return res.status(200).json({ success: true });
        }

        if (req.method === 'PATCH') {
            const { userId, action: badgeAction, badge } = req.body;
            if (!userId || !badge) return res.status(400).json({ error: "Missing required fields" });

            const getExisting = await fetch(`${UPSTASH_URL}/get/bio:user:${userId}`, { headers: redisHeaders });
            const existingData = await getExisting.json();
            let profile = existingData.result ? (typeof existingData.result === 'string' ? JSON.parse(existingData.result) : existingData.result) : { userId };

            profile.staffBadges = profile.staffBadges || [];

            if (badgeAction === 'add' || badgeAction === 'grant') {
                if (!profile.staffBadges.includes(badge)) profile.staffBadges.push(badge);
            } else if (badgeAction === 'remove' || badgeAction === 'revoke') {
                profile.staffBadges = profile.staffBadges.filter(b => b !== badge);
            }

            await fetch(`${UPSTASH_URL}/set/bio:user:${userId}`, {
                method: 'POST',
                headers: redisHeaders,
                body: JSON.stringify(profile)
            });

            return res.status(200).json({ success: true, staffBadges: profile.staffBadges });
        }
    }

    // =========================================================================
    // SECTION 7: LIVE DATASTORE LEADERBOARD ENGINE
    // =========================================================================
    if (isRoute('leaderboard')) {
        try {
            const lbRes = await fetch(`${UPSTASH_URL}/zrevrange/bio_leaderboard/0/9/WITHSCORES`, { headers: redisHeaders });
            const lbData = await lbRes.json();
            const rawList = lbData.result || [];

            const leaderboard = [];
            for (let i = 0; i < rawList.length; i += 2) {
                const handle = rawList[i];
                const views = parseInt(rawList[i + 1], 10) || 0;

                let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
                try {
                    const uIdRes = await fetch(`${UPSTASH_URL}/get/bio:handle:${handle.toLowerCase()}`, { headers: redisHeaders });
                    const uIdData = await uIdRes.json();
                    if (uIdData.result) {
                        const cleanUid = cleanRedisId(uIdData.result);
                        const profRes = await fetch(`${UPSTASH_URL}/get/bio:user:${cleanUid}`, { headers: redisHeaders });
                        const profData = await profRes.json();
                        const prof = profData.result ? (typeof profData.result === 'string' ? JSON.parse(profData.result) : profData.result) : {};
                        if (prof.avatarUrl || prof.avatar) avatar = prof.avatarUrl || prof.avatar;
                    }
                } catch (e) {}

                leaderboard.push({
                    rank: (i / 2) + 1,
                    handle,
                    views,
                    avatar
                });
            }

            return res.status(200).json(leaderboard);
        } catch (e) {
            return res.status(500).json({ error: "Failed to load datastore leaderboard." });
        }
    }

    // =========================================================================
    // SECTION 8: PER-USER ANALYTICS ENGINE (TRACK & QUERY)
    // =========================================================================
    if (isRoute('track_event')) {
        const { handle, userId, type, device, referrer } = req.body;
        let targetId = userId;

        if (!targetId && handle) {
            const uRes = await fetch(`${UPSTASH_URL}/get/bio:handle:${handle.toLowerCase()}`, { headers: redisHeaders });
            const uData = await uRes.json();
            if (uData.result) {
                targetId = cleanRedisId(uData.result);
            }
        }

        if (!targetId) return res.status(400).json({ error: "Missing identifier" });

        if (type === 'view') {
            await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:views`, { method: 'POST', headers: redisHeaders });
            await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:views_month`, { method: 'POST', headers: redisHeaders });

            if (device === 'mobile') {
                await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:dev_mobile`, { method: 'POST', headers: redisHeaders });
            } else {
                await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:dev_desktop`, { method: 'POST', headers: redisHeaders });
            }

            if (referrer === 'discord') {
                await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:ref_discord`, { method: 'POST', headers: redisHeaders });
            } else if (referrer === 'tiktok') {
                await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:ref_tiktok`, { method: 'POST', headers: redisHeaders });
            } else {
                await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:ref_direct`, { method: 'POST', headers: redisHeaders });
            }

            if (handle) {
                await fetch(`${UPSTASH_URL}/zincrby/bio_leaderboard/1/${handle.toLowerCase()}`, { method: 'POST', headers: redisHeaders });
            }
        }

        if (type === 'click') {
            await fetch(`${UPSTASH_URL}/incr/analytics:${targetId}:clicks`, { method: 'POST', headers: redisHeaders });
        }

        return res.status(200).json({ success: true });
    }

    if (isRoute('get_analytics')) {
        const targetUserId = req.query.userId;
        if (!targetUserId) return res.status(400).json({ error: "Missing userId" });

        const keys = [
            `analytics:${targetUserId}:views`,
            `analytics:${targetUserId}:views_month`,
            `analytics:${targetUserId}:clicks`,
            `analytics:${targetUserId}:dev_mobile`,
            `analytics:${targetUserId}:dev_desktop`,
            `analytics:${targetUserId}:ref_discord`,
            `analytics:${targetUserId}:ref_tiktok`,
            `analytics:${targetUserId}:ref_direct`
        ];

        const [views, viewsMonth, clicks, mobile, desktop, discord, tiktok, direct] = await Promise.all(
            keys.map(async (k) => {
                const r = await fetch(`${UPSTASH_URL}/get/${k}`, { headers: redisHeaders });
                const j = await r.json();
                return parseInt(j.result || 0, 10);
            })
        );

        const totalDevices = (mobile + desktop) || 1;
        const mobilePct = Math.round((mobile / totalDevices) * 100);
        const desktopPct = 100 - mobilePct;

        const totalRefs = (discord + tiktok + direct) || 1;
        const discordPct = Math.round((discord / totalRefs) * 100);
        const tiktokPct = Math.round((tiktok / totalRefs) * 100);
        const directPct = Math.max(0, 100 - (discordPct + tiktokPct));
        const ctr = views > 0 ? ((clicks / views) * 100).toFixed(1) : "0.0";

        return res.status(200).json({
            totalViews: views || 0,
            selectedPeriodViews: viewsMonth || views || 0,
            linkClicks: clicks || 0,
            ctr: `${ctr}%`,
            mobilePct,
            desktopPct,
            discordPct,
            tiktokPct,
            directPct
        });
    }

    // =========================================================================
    // SECTION 9: COMMUNITY TEMPLATES GALLERY ENGINE
    // =========================================================================
    if (isRoute('save_template')) {
        const { name, author, authorId, previewUrl, config: templateConfig } = req.body;
        if (!name || !templateConfig) return res.status(400).json({ error: "Missing template configuration" });

        const templateId = `tpl_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        const templateRecord = {
            id: templateId,
            name: name.trim(),
            author: author || 'Anonymous',
            authorId: authorId || 'Guest',
            previewUrl: previewUrl || templateConfig.background || '',
            uses: 0,
            createdAt: Date.now(),
            config: templateConfig
        };

        await fetch(`${UPSTASH_URL}/set/template:${templateId}`, {
            method: 'POST',
            headers: redisHeaders,
            body: JSON.stringify(templateRecord)
        });

        await fetch(`${UPSTASH_URL}/zadd/templates:by_uses/0/${templateId}`, { method: 'POST', headers: redisHeaders });
        await fetch(`${UPSTASH_URL}/zadd/templates:by_date/${Date.now()}/${templateId}`, { method: 'POST', headers: redisHeaders });

        return res.status(200).json({ success: true, templateId });
    }

    if (isRoute('get_templates')) {
        const filter = req.query.filter || 'top';
        const zsetKey = filter === 'recent' ? 'templates:by_date' : 'templates:by_uses';

        const idsRes = await (await fetch(`${UPSTASH_URL}/zrevrange/${zsetKey}/0/59`, { headers: redisHeaders })).json();
        const templateIds = idsRes.result || [];

        const templates = [];
        for (const tid of templateIds) {
            try {
                const tRes = await (await fetch(`${UPSTASH_URL}/get/template:${tid}`, { headers: redisHeaders })).json();
                if (tRes.result) {
                    const parsed = typeof tRes.result === 'string' ? JSON.parse(tRes.result) : tRes.result;
                    const scoreRes = await (await fetch(`${UPSTASH_URL}/zscore/templates:by_uses/${tid}`, { headers: redisHeaders })).json();
                    parsed.uses = parseInt(scoreRes.result || 0, 10);
                    templates.push(parsed);
                }
            } catch (err) {}
        }

        return res.status(200).json(templates);
    }

    if (isRoute('apply_template')) {
        const { templateId } = req.body;
        if (!templateId) return res.status(400).json({ error: "Missing templateId" });

        await fetch(`${UPSTASH_URL}/zincrby/templates:by_uses/1/${templateId}`, { method: 'POST', headers: redisHeaders });

        const tRes = await (await fetch(`${UPSTASH_URL}/get/template:${templateId}`, { headers: redisHeaders })).json();
        if (!tRes.result) return res.status(404).json({ error: "Template not found" });

        const record = typeof tRes.result === 'string' ? JSON.parse(tRes.result) : tRes.result;
        return res.status(200).json({ success: true, config: record.config });
    }

    // =========================================================================
    // SECTION 10: GUILD MEMBERS & ROSTER API
    // =========================================================================
    if (isRoute('getroles')) {
        try {
            const response = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
                method: 'GET',
                headers: discordHeaders
            });

            if (!response.ok) return res.status(response.status).send("Discord API Guild Member Query Error");

            const data = await response.json();
            const humanMembers = data.filter(member => !member.user?.bot);

            return res.status(200).json(humanMembers);
        } catch (error) {
            return res.status(500).json({ error: "Failed to fetch guild members." });
        }
    }

    // =========================================================================
    // SECTION 11: DISCORD SERVER MANAGEMENT & MODERATION SUITE
    // =========================================================================
    if (isRoute('masterbot') || isRoute('moderate')) {
        if (req.method === 'POST') {
            const {
                command,
                userId,
                action: modAction,
                duration,
                roleId,
                reason,
                channelId,
                message,
                title,
                imageUrl,
                count,
                rateLimit,
                botNick
            } = req.body;

            const modHeaders = {
                ...discordHeaders,
                'X-Audit-Log-Reason': reason || 'Lucid.Mp3 Admin Action'
            };

            try {
                // Change Bot Nickname
                if (command === 'botNick') {
                    await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members/@me`, {
                        method: 'PATCH',
                        headers: discordHeaders,
                        body: JSON.stringify({ nick: botNick || 'Lucid Bot' })
                    });
                    return res.status(200).json({ success: true });
                }

                // Channel Slowmode
                if (command === 'slowmode') {
                    await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
                        method: 'PATCH',
                        headers: discordHeaders,
                        body: JSON.stringify({ rate_limit_per_user: parseInt(rateLimit || 0, 10) })
                    });
                    return res.status(200).json({ success: true });
                }

                // Welcome / Leave Embed Builder
                if (command === 'welcomeLeave' || action === 'welcomeleave') {
                    const isWelcome = modAction === 'welcome' || req.body.type === 'welcome';
                    const userRes = await fetch(`https://discord.com/api/v10/users/${userId}`, { headers: discordHeaders });
                    const userData = await userRes.json();

                    let avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
                    if (userData.id && userData.avatar) {
                        avatarUrl = `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=256`;
                    }

                    const embed = {
                        title: isWelcome ? "Member Joined" : "Member Left",
                        description: isWelcome ? `Welcome <@${userId}> to **Lucid.Mp3**.` : `<@${userId}> has left **Lucid.Mp3**.`,
                        color: 0x2b2d31,
                        thumbnail: { url: avatarUrl },
                        timestamp: new Date().toISOString()
                    };

                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: discordHeaders,
                        body: JSON.stringify({ embeds: [embed] })
                    });
                    return res.status(200).json({ success: true });
                }

                // Announcement Broadcast
                if (command === 'announce') {
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: discordHeaders,
                        body: JSON.stringify({ content: message })
                    });
                    return res.status(200).json({ success: true });
                }

                // Embed Broadcast
                if (command === 'embed') {
                    const embedObj = {
                        title: title || "Lucid Announcement",
                        description: message,
                        color: 0x2b2d31,
                        image: imageUrl ? { url: imageUrl } : null,
                        timestamp: new Date().toISOString()
                    };
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
                        method: 'POST',
                        headers: discordHeaders,
                        body: JSON.stringify({ embeds: [embedObj] })
                    });
                    return res.status(200).json({ success: true });
                }

                // Bulk Message Purge
                if (command === 'purge' || modAction === 'purge') {
                    const limitCount = Math.min(parseInt(count || 10, 10), 100);
                    const getRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${limitCount}`, { headers: discordHeaders });
                    const messages = await getRes.json();

                    if (!messages || messages.length === 0) return res.status(200).json({ success: true });

                    const messageIds = messages.map(m => m.id);
                    if (messageIds.length === 1) {
                        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageIds[0]}`, {
                            method: 'DELETE',
                            headers: discordHeaders
                        });
                    } else {
                        await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, {
                            method: 'POST',
                            headers: discordHeaders,
                            body: JSON.stringify({ messages: messageIds })
                        });
                    }
                    return res.status(200).json({ success: true, count: messageIds.length });
                }

                // Channel Lockdown
                if (command === 'lockdown') {
                    const isLock = modAction === 'lock';
                    const payload = {
                        type: 0,
                        deny: isLock ? "2048" : "0",
                        allow: isLock ? "0" : "2048"
                    };
                    await fetch(`https://discord.com/api/v10/channels/${channelId}/permissions/${GUILD_ID}`, {
                        method: 'PUT',
                        headers: discordHeaders,
                        body: JSON.stringify(payload)
                    });
                    return res.status(200).json({ success: true });
                }

                // Moderation Suite
                if (command === 'moderate' || action === 'moderate') {
                    let url = '', method = '', bodyPayload = null;

                    if (modAction === 'kick') {
                        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`;
                        method = 'DELETE';
                    } else if (modAction === 'ban') {
                        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
                        method = 'PUT';
                    } else if (modAction === 'unban') {
                        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
                        method = 'DELETE';
                    } else if (modAction === 'timeout') {
                        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`;
                        method = 'PATCH';
                        const until = new Date(Date.now() + parseInt(duration || 300, 10) * 1000).toISOString();
                        bodyPayload = JSON.stringify({ communication_disabled_until: until });
                    } else if (modAction === 'warn') {
                        await fetch(`${UPSTASH_URL}/rpush/warnings:${userId}`, {
                            method: 'POST',
                            headers: redisHeaders,
                            body: JSON.stringify({
                                reason: reason || "Administrative warning",
                                date: new Date().toISOString()
                            })
                        });
                        return res.status(200).json({ success: true });
                    } else if (modAction === 'warnings') {
                        const resWarn = await fetch(`${UPSTASH_URL}/lrange/warnings:${userId}/0/-1`, { headers: redisHeaders });
                        const dataWarn = await resWarn.json();
                        return res.status(200).json({ success: true, warnings: dataWarn.result || [] });
                    } else if (modAction === 'clearwarnings') {
                        await fetch(`${UPSTASH_URL}/del/warnings:${userId}`, { method: 'POST', headers: redisHeaders });
                        return res.status(200).json({ success: true });
                    }

                    if (url) {
                        const modResult = await fetch(url, { method, headers: modHeaders, body: bodyPayload });
                        if (!modResult.ok) {
                            const errTxt = await modResult.text();
                            return res.status(modResult.status).json({ error: errTxt });
                        }
                    }
                    return res.status(200).json({ success: true });
                }
            } catch (cmdErr) {
                return res.status(500).json({ error: cmdErr.message });
            }
        }
    }

    // =========================================================================
    // SECTION 12: SPOTIFY AUTOMATOR & DISCORD RELEASE ANNOUNCER
    // =========================================================================
    if (isRoute('masterbot') || isRoute('spotifysync')) {
        if (req.method === 'GET' || action.includes('spotifysync')) {
            const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
            const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
            const SPOTIFY_PLAYLIST_ID = process.env.SPOTIFY_PLAYLIST_ID;
            const CHANNEL_ID = process.env.RELEASES_CHANNEL_ID;
            const ROLE_ID = process.env.NEW_RELEASE_ROLE_ID;

            if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET || !SPOTIFY_PLAYLIST_ID || !DISCORD_TOKEN) {
                return res.status(500).json({ error: 'Missing Spotify API or Discord Releases credentials.' });
            }

            try {
                const authHeader = Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64');
                const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Basic ${authHeader}`,
                        'Content-Type': 'application/x-www-form-urlencoded'
                    },
                    body: 'grant_type=client_credentials'
                });

                const tokenData = await tokenRes.json();
                if (!tokenData.access_token) {
                    return res.status(500).json({ error: 'Failed to authenticate with Spotify Web API.' });
                }

                const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${SPOTIFY_PLAYLIST_ID}/tracks?limit=30`, {
                    headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
                });
                const playlistData = await playlistRes.json();
                const items = playlistData.items || [];

                if (items.length === 0) {
                    return res.status(200).json({ message: 'Spotify playlist empty.' });
                }

                const currentTracks = items.map(item => {
                    const track = item.track || item;
                    if (!track) return null;

                    const trackUrl = track.external_urls?.spotify || (track.id ? `https://open.spotify.com/track/${track.id}` : null);
                    if (!trackUrl) return null;

                    return {
                        url: trackUrl,
                        name: track.name || "Untitled Track",
                        artists: track.artists ? track.artists.map(a => a.name).join(', ') : "Lucid.mp3 Artist"
                    };
                }).filter(Boolean);

                const dbRes = await fetch(`${UPSTASH_URL}/get/spotify_last_checked`, { headers: redisHeaders });
                const dbData = await dbRes.json();
                let previouslyPosted = dbData.result ? (typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result) : [];

                let newTracks = currentTracks.filter(t => !previouslyPosted.includes(t.url));

                if (previouslyPosted.length === 0 && newTracks.length > 3) {
                    newTracks = newTracks.slice(0, 3);
                }

                if (newTracks.length === 0) {
                    return res.status(200).json({ message: 'No new tracks to post.', checked: currentTracks.length });
                }

                for (const track of newTracks) {
                    const discordMessage = `<@&${ROLE_ID}>\n\n` +
                                           `## 💿 **NEW LUCID.MP3 RELEASE**\n\n` +
                                           `**Track**: ${track.name}\n` +
                                           `**Artist(s)**: ${track.artists}\n\n` +
                                           `▶️ **Listen on Spotify**:\n${track.url}`;

                    await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
                        method: 'POST',
                        headers: discordHeaders,
                        body: JSON.stringify({ content: discordMessage })
                    });
                }

                const allUrls = currentTracks.map(t => t.url);
                const updatedMemory = Array.from(new Set([...allUrls, ...previouslyPosted])).slice(0, 500);

                await fetch(`${UPSTASH_URL}/set/spotify_last_checked`, {
                    method: 'POST',
                    headers: redisHeaders,
                    body: JSON.stringify(updatedMemory)
                });

                return res.status(200).json({ success: true, postedCount: newTracks.length });
            } catch (error) {
                return res.status(500).json({ error: error.message });
            }
        }
    }

    // =========================================================================
    // SECTION 13: SYSTEM DIAGNOSTICS & DEFAULT 404
    // =========================================================================
    if (isRoute('health') || isRoute('ping')) {
        let redisConnected = false;
        try {
            const pingRes = await fetch(`${UPSTASH_URL}/ping`, { headers: redisHeaders });
            redisConnected = pingRes.ok;
        } catch (e) {}

        return res.status(200).json({
            status: "online",
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
            database: redisConnected ? "connected" : "offline",
            service: "Lucid.mp3 Unified Core API"
        });
    }

    return res.status(404).json({
        error: "Endpoint not found",
        path: pathname,
        action: action || "none"
    });
}
