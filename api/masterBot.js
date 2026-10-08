import spotifyUrlInfo from 'spotify-url-info';

const { getTracks } = spotifyUrlInfo(fetch);

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
            return res.status(500).json({ error: 'Missing configuration variables.' });
        }

        try {
            const tracks = await getTracks(PLAYLIST_URL);
            if (!tracks || tracks.length === 0) return res.status(200).json({ message: 'Playlist empty or not found.' });

            // Fix for undefined: safely extract URL whether it's a playlist or standard array
            const currentTracks = tracks.map(item => {
                const trackObj = item.track || item;
                return trackObj.external_urls?.spotify || (trackObj.id ? `https://open.spotify.com/track/${trackObj.id}` : null);
            }).filter(Boolean); // removes any nulls

            const dbRes = await fetch(`${UPSTASH_URL}/get/spotify_last_checked`, { headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` } });
            const dbData = await dbRes.json();
            
            let previouslyPosted = [];
            if (dbData.result) previouslyPosted = typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result;

            const newTracks = currentTracks.filter(trackUrl => !previouslyPosted.includes(trackUrl));
            if (newTracks.length === 0) return res.status(200).json({ message: 'No new tracks to post.' });

            // Professional Formatting with Spacing
            let discordMessage = `<@&${ROLE_ID}>\n\n`;
            if (newTracks.length === 1) {
                discordMessage += `**🎵 New Lucid.Mp3 Release!**\n\n🎧 **Listen Here:**\n${newTracks[0]}`;
            } else {
                discordMessage += `**🎵 ${newTracks.length} New Lucid.Mp3 Releases!**\n\n`;
                newTracks.forEach(trackUrl => {
                    discordMessage += `🎧 ${trackUrl}\n\n`;
                });
            }

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
    // 2. DISCORD ADMIN COMMANDS
    // ==========================================
    if (req.method === 'POST') {
        const data = req.body;
        const command = data.command; 

        try {
            // Basic Message
            if (command === 'announce') {
                await fetch(`https://discord.com/api/v10/channels/${data.channelId}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: data.message })
                });
                return res.status(200).json({ success: true });
            }

            // Rich Embed Message
            if (command === 'embed') {
                await fetch(`https://discord.com/api/v10/channels/${data.channelId}/messages`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        embeds: [{
                            title: data.title,
                            description: data.message,
                            color: 0xffffff,
                            image: data.imageUrl ? { url: data.imageUrl } : null
                        }]
                    })
                });
                return res.status(200).json({ success: true });
            }

            // Purge Messages
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

            // Lock / Unlock Channel
            if (command === 'lockdown') {
                const lockState = data.action === 'lock' ? "2048" : "0"; // 2048 is SEND_MESSAGES
                await fetch(`https://discord.com/api/v10/channels/${data.channelId}/permissions/${GUILD_ID}`, {
                    method: 'PUT',
                    headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ type: 0, deny: lockState, allow: data.action === 'unlock' ? "2048" : "0" })
                });
                return res.status(200).json({ success: true });
            }

            // Roles & Moderation
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
                else if (data.action === 'addRole') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${data.userId}/roles/${data.roleId}`; method = 'PUT'; }
                else if (data.action === 'removeRole') { url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${data.userId}/roles/${data.roleId}`; method = 'DELETE'; }

                await fetch(url, { method, headers, body });
                return res.status(200).json({ success: true });
            }

            // Welcome Message Config
            if (command === 'config') {
                await fetch(`${UPSTASH_URL}/set/bot_config:welcome_message`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(data.welcomeMessage)
                });
                return res.status(200).json({ success: true });
            }

            return res.status(400).json({ error: 'Unknown command' });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
}