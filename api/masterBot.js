import spotifyUrlInfo from 'spotify-url-info';

const { getTracks } = spotifyUrlInfo(fetch);

export default async function handler(req, res) {
    const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const GUILD_ID = '1554157703067336875'; 
    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    // ==========================================
    // 1. SPOTIFY AUTOMATOR (Triggered via background ping from cron-job.org)
    // ==========================================
    if (req.method === 'GET') {
        const PLAYLIST_URL = process.env.SPOTIFY_PLAYLIST_URL;
        const CHANNEL_ID = process.env.RELEASES_CHANNEL_ID; 
        const ROLE_ID = process.env.NEW_RELEASE_ROLE_ID; 

        if (!PLAYLIST_URL || !DISCORD_TOKEN || !UPSTASH_URL) {
            return res.status(500).json({ error: 'Missing configuration variables.' });
        }

        try {
            const tracks = await getTracks(PLAYLIST_URL);
            if (!tracks || tracks.length === 0) return res.status(200).json({ message: 'Playlist empty or not found.' });

            const currentTracks = tracks.map(track => track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`);

            const dbRes = await fetch(`${UPSTASH_URL}/get/spotify_last_checked`, { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } });
            const dbData = await dbRes.json();
            
            let previouslyPosted = [];
            if (dbData.result) previouslyPosted = typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result;

            const newTracks = currentTracks.filter(trackUrl => !previouslyPosted.includes(trackUrl));
            if (newTracks.length === 0) return res.status(200).json({ message: 'No new tracks to post.' });

            let discordMessage = `<@&${ROLE_ID}>\n`;
            if (newTracks.length === 1) discordMessage += `**New Lucid.Mp3 Release!**\n${newTracks[0]}`;
            else discordMessage += `**${newTracks.length} New Lucid.Mp3 Releases:**\n\n${newTracks.join('\n')}`;

            await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ content: discordMessage })
            });

            const updatedMemory = [...newTracks, ...previouslyPosted].slice(0, 50); 
            await fetch(`${UPSTASH_URL}/set/spotify_last_checked`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(updatedMemory)
            });

            return res.status(200).json({ success: true, posted: newTracks.length });
        } catch (error) {
            return res.status(500).json({ error: 'Failed to process Spotify sync.' });
        }
    }

    // ==========================================
    // 2. DISCORD ADMIN COMMANDS (Triggered from Website Admin Panel)
    // ==========================================
    if (req.method === 'POST') {
        const data = req.body;
        const command = data.command; 

        try {
            if (command === 'announce') {
                await fetch(`https://discord.com/api/v10/channels/${data.channelId}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: data.message })
                });
                return res.status(200).json({ success: true });
            }

            if (command === 'purge') {
                const getRes = await fetch(`https://discord.com/api/v10/channels/${data.channelId}/messages?limit=${data.count}`, {
                    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` }
                });
                const messages = await getRes.json();
                if (!messages || messages.length === 0) return res.status(200).json({ success: true });
                
                const messageIds = messages.map(m => m.id);
                if (messageIds.length === 1) {
                    await fetch(`https://discord.com/api/v10/channels/${data.channelId}/messages/${messageIds[0]}`, { method: 'DELETE', headers: { 'Authorization': `Bot ${DISCORD_TOKEN}` } });
                } else {
                    await fetch(`https://discord.com/api/v10/channels/${data.channelId}/messages/bulk-delete`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({ messages: messageIds })
                    });
                }
                return res.status(200).json({ success: true });
            }

            if (command === 'moderate') {
                let url = '', method = '', body = null;
                const headers = { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'X-Audit-Log-Reason': data.reason || 'Admin Panel' };

                if (data.action === 'kick') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${data.userId}`; method = 'DELETE'; }
                else if (data.action === 'ban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${data.userId}`; method = 'PUT'; }
                else if (data.action === 'unban') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${data.userId}`; method = 'DELETE'; }
                else if (data.action === 'timeout') {
                    url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${data.userId}`; method = 'PATCH'; headers['Content-Type'] = 'application/json';
                    const until = new Date(Date.now() + parseInt(data.duration) * 1000).toISOString();
                    body = JSON.stringify({ communication_disabled_until: until });
                }
                else if (data.action === 'unmute') {
                    url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${data.userId}`; method = 'PATCH'; headers['Content-Type'] = 'application/json';
                    body = JSON.stringify({ communication_disabled_until: null });
                }

                await fetch(url, { method, headers, body });
                return res.status(200).json({ success: true });
            }

            if (command === 'config') {
                await fetch(`${UPSTASH_URL}/set/bot_config:welcome_message`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(data.welcomeMessage)
                });
                return res.status(200).json({ success: true });
            }

            if (command === 'status') {
                return res.status(200).json({ success: true });
            }

            return res.status(400).json({ error: 'Unknown command' });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
}