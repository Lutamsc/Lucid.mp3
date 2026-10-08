export default async function handler(req, res) {
    const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const GUILD_ID = '1554157703067336875'; 
    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    // ==========================================
    // 1. SPOTIFY AUTOMATOR (Official API)
    // ==========================================
    if (req.method === 'GET') {
        const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
        const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;
        const PLAYLIST_ID = process.env.SPOTIFY_PLAYLIST_ID;
        const CHANNEL_ID = process.env.RELEASES_CHANNEL_ID; 
        const ROLE_ID = process.env.NEW_RELEASE_ROLE_ID; 

        if (!CLIENT_ID || !CLIENT_SECRET || !PLAYLIST_ID || !DISCORD_TOKEN) {
            return res.status(500).json({ error: 'Missing Spotify API Environment Variables.' });
        }

        try {
            // A. Authenticate with Spotify API
            const authString = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
            const tokenRes = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Authorization': `Basic ${authString}`, 'Content-Type': 'application/x-www-form-urlencoded' },
                body: 'grant_type=client_credentials'
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) return res.status(500).json({ error: 'Failed to authenticate with Spotify API' });

            // B. Fetch Playlist Tracks
            const playlistRes = await fetch(`https://api.spotify.com/v1/playlists/${PLAYLIST_ID}/tracks?limit=25`, {
                headers: { 'Authorization': `Bearer ${tokenData.access_token}` }
            });
            const playlistData = await playlistRes.json();
            if (!playlistData.items || playlistData.items.length === 0) return res.status(200).json({ message: 'Playlist empty.' });

            // C. Extract Links & Metadata
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

            // D. Find New Tracks
            let newTracks = currentTracksData.filter(track => !previouslyPosted.includes(track.url));
            
            // First Run Safety Limit
            if (previouslyPosted.length === 0 && newTracks.length > 3) newTracks = newTracks.slice(0, 3);
            if (newTracks.length === 0) return res.status(200).json({ message: 'No new tracks to post.', tracksFound: currentTracksData.length });

            // E. Format Exact Message
            let discordMessage = `<@&${ROLE_ID}>\n## New **Lucid.Mp3** Releases\n\n`;
            newTracks.forEach(track => {
                discordMessage += `* ${track.name} - ${track.artists}:\n   ${track.url}\n\n`;
            });

            await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: discordMessage.trim() })
            });

            // F. Save Memory
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

    // ==========================================
    // 2. DISCORD ADMIN COMMANDS
    // ==========================================
    if (req.method === 'POST') {
        const { command, userId, action, duration, roleId, reason, channelId, message, title, imageUrl, count } = req.body; 
        const headers = { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json', 'X-Audit-Log-Reason': reason || 'Admin Panel' };

        try {
            // Welcome & Leave Embed Builder
            if (command === 'welcomeLeave') {
                const isWelcome = action === 'welcome';
                const userRes = await fetch(`https://discord.com/api/v10/users/${userId}`, { headers });
                const userData = await userRes.json();
                
                let avatarUrl = 'https://cdn.discordapp.com/embed/avatars/0.png';
                if (userData.id && userData.avatar) avatarUrl = `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.png?size=256`;

                const embed = {
                    title: isWelcome ? "Member Joined" : "Member Left",
                    description: isWelcome ? `Welcome <@${userId}> to **Lucid.Mp3**.` : `<@${userId}> has left **Lucid.Mp3**.`,
                    color: 0x2b2d31, // Invisible Dark Gray
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
            if (command === 'purge') {
                const getRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${count}`, { headers });
                const messages = await getRes.json();
                if (!messages || messages.length === 0) return res.status(200).json({ success: true });
                const messageIds = messages.map(m => m.id);
                if (messageIds.length === 1) await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageIds[0]}`, { method: 'DELETE', headers });
                else await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, { method: 'POST', headers, body: JSON.stringify({ messages: messageIds }) });
                return res.status(200).json({ success: true });
            }
            if (command === 'lockdown') {
                const lockState = action === 'lock' ? "2048" : "0"; 
                await fetch(`https://discord.com/api/v10/channels/${channelId}/permissions/${GUILD_ID}`, { method: 'PUT', headers, body: JSON.stringify({ type: 0, deny: lockState, allow: action === 'unlock' ? "2048" : "0" }) });
                return res.status(200).json({ success: true });
            }

            // User Moderation
            if (command === 'moderate') {
                let url = '', method = '', bodyPayload = null;

                if (action === 'kick') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'DELETE'; }
                else if (action === 'ban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`; method = 'PUT'; }
                else if (action === 'unban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`; method = 'DELETE'; }
                else if (action === 'softban') {
                    const banUrl = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
                    await fetch(banUrl, { method: 'PUT', headers, body: JSON.stringify({ delete_message_seconds: 604800 }) });
                    await fetch(banUrl, { method: 'DELETE', headers });
                    return res.status(200).json({ success: true });
                }
                else if (action === 'timeout') {
                    url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'PATCH';
                    const until = new Date(Date.now() + parseInt(duration) * 1000).toISOString();
                    bodyPayload = JSON.stringify({ communication_disabled_until: until });
                }
                else if (action === 'untimeout') {
                    url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'PATCH';
                    bodyPayload = JSON.stringify({ communication_disabled_until: null });
                }
                else if (action === 'warn') {
                    await fetch(`${UPSTASH_URL}/rpush/warnings:${userId}`, { method: 'POST', headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ reason: reason || "No reason", date: new Date().toISOString() }) });
                    return res.status(200).json({ success: true });
                }
                else if (action === 'warnings') {
                    const resWarn = await fetch(`${UPSTASH_URL}/lrange/warnings:${userId}/0/-1`, { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } });
                    const dataWarn = await resWarn.json();
                    return res.status(200).json({ success: true, warnings: dataWarn.result || [] });
                }
                else if (action === 'addRole') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`; method = 'PUT'; }
                else if (action === 'removeRole') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}/roles/${roleId}`; method = 'DELETE'; }
                else if (action === 'roleall') {
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