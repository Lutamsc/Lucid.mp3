import spotifyUrlInfo from 'spotify-url-info';

// Disguise the Vercel server as a real Google Chrome web browser
const customFetch = (url, options) => {
    return fetch(url, {
        ...options,
        headers: {
            ...options?.headers,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5'
        }
    });
};

const { getTracks } = spotifyUrlInfo(customFetch);

export default async function handler(req, res) {
    const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const GUILD_ID = '1554157703067336875'; 
    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    // ==========================================
    // 1. SPOTIFY AUTOMATOR
    // ==========================================
    if (req.method === 'GET') {
        const PLAYLIST_URL = process.env.SPOTIFY_PLAYLIST_URL;
        const CHANNEL_ID = process.env.RELEASES_CHANNEL_ID; 
        const ROLE_ID = process.env.NEW_RELEASE_ROLE_ID; 

        if (!PLAYLIST_URL || !DISCORD_TOKEN || !UPSTASH_URL) {
            return res.status(500).json({ error: 'Missing configuration variables in Vercel.' });
        }

        try {
            const tracks = await getTracks(PLAYLIST_URL);
            if (!tracks || tracks.length === 0) return res.status(200).json({ message: 'Playlist empty or not found.' });

            // Extract valid links AND metadata (Title, Artist)
            const currentTracksData = tracks.map(item => {
                const trackObj = item.track || item;
                
                let url = null;
                if (trackObj.external_urls?.spotify) url = trackObj.external_urls.spotify;
                else if (trackObj.id) url = `https://open.spotify.com/track/${trackObj.id}`;
                else if (trackObj.uri && trackObj.uri.includes('track:')) url = `https://open.spotify.com/track/${trackObj.uri.split(':').pop()}`;
                else if (trackObj.url) url = trackObj.url;
                
                if (!url) return null;

                const name = trackObj.name || "Unknown Track";
                const artists = trackObj.artists ? trackObj.artists.map(a => a.name).join(', ') : "Unknown Artist";

                return { url, name, artists };
            }).filter(Boolean); 

            const dbRes = await fetch(`${UPSTASH_URL}/get/spotify_last_checked`, { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } });
            const dbData = await dbRes.json();
            
            let previouslyPosted = [];
            if (dbData.result) previouslyPosted = typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result;

            // Find new tracks by comparing URLs
            const newTracks = currentTracksData.filter(track => !previouslyPosted.includes(track.url));
            
            if (newTracks.length === 0) {
                return res.status(200).json({ 
                    message: 'No new tracks to post. The database already remembers these songs.',
                    tracksFound: currentTracksData.length 
                });
            }

            // FORMAT EXACTLY AS REQUESTED
            let discordMessage = `<@&${ROLE_ID}>\n## New **Lucid.Mp3** Releases\n\n`;
            
            newTracks.forEach(track => {
                discordMessage += `* ${track.name} - ${track.artists}\n   ${track.url}\n\n`;
            });

            await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: discordMessage.trim() })
            });

            // Save just the URLs to memory to prevent duplicates
            const newUrls = newTracks.map(t => t.url);
            const updatedMemory = [...newUrls, ...previouslyPosted].slice(0, 200); 
            await fetch(`${UPSTASH_URL}/set/spotify_last_checked`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedMemory)
            });

            return res.status(200).json({ success: true, posted: newTracks.length });
        } catch (error) {
            return res.status(500).json({ error: 'Failed to process Spotify sync.', details: error.message });
        }
    }

    // ==========================================
    // 2. DISCORD MODERATION COMMANDS
    // ==========================================
    if (req.method === 'POST') {
        const { command, userId, action, duration, roleId, reason, channelId, message, title, imageUrl, count } = req.body; 

        if (command === 'announce') {
            await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ content: message }) });
            return res.status(200).json({ success: true });
        }
        if (command === 'embed') {
            await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, { method: 'POST', headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ embeds: [{ title: title, description: message, color: 0xffffff, image: imageUrl ? { url: imageUrl } : null }] }) });
            return res.status(200).json({ success: true });
        }
        if (command === 'purge') {
            const getRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${count}`, { headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` } });
            const messages = await getRes.json();
            if (!messages || messages.length === 0) return res.status(200).json({ success: true });
            const messageIds = messages.map(m => m.id);
            if (messageIds.length === 1) await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageIds[0]}`, { method: 'DELETE', headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` } });
            else await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, { method: 'POST', headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ messages: messageIds }) });
            return res.status(200).json({ success: true });
        }
        if (command === 'lockdown') {
            const lockState = action === 'lock' ? "2048" : "0"; 
            await fetch(`https://discord.com/api/v10/channels/${channelId}/permissions/${GUILD_ID}`, { method: 'PUT', headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 0, deny: lockState, allow: action === 'unlock' ? "2048" : "0" }) });
            return res.status(200).json({ success: true });
        }

        if (command === 'moderate') {
            let url = '', method = '', bodyPayload = null;
            const headers = { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'X-Audit-Log-Reason': reason || 'Admin Panel' };

            try {
                if (action === 'kick') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'DELETE'; }
                else if (action === 'ban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`; method = 'PUT'; }
                else if (action === 'unban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`; method = 'DELETE'; }
                else if (action === 'softban') {
                    const banUrl = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
                    await fetch(banUrl, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json'}, body: JSON.stringify({ delete_message_seconds: 604800 }) });
                    await fetch(banUrl, { method: 'DELETE', headers });
                    return res.status(200).json({ success: true });
                }
                else if (action === 'timeout') {
                    url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'PATCH'; headers['Content-Type'] = 'application/json';
                    const until = new Date(Date.now() + parseInt(duration) * 1000).toISOString();
                    bodyPayload = JSON.stringify({ communication_disabled_until: until });
                }
                else if (action === 'untimeout') {
                    url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`; method = 'PATCH'; headers['Content-Type'] = 'application/json';
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
            } catch (e) {
                return res.status(500).json({ error: e.message });
            }
        }
    }
}
