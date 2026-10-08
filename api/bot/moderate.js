export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { userId, action, duration, reason } = req.body;
    const token = process.env.DISCORD_BOT_TOKEN;
    const GUILD_ID = '1554157703067336875'; 
    
    let url = '';
    let method = '';
    let body = null;
    
    const headers = {
        'Authorization': `Bot ${token}`,
        'X-Audit-Log-Reason': reason || 'Action applied via Lucid Admin Panel'
    };

    if (action === 'kick') {
        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`;
        method = 'DELETE';
    } else if (action === 'ban') {
        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
        method = 'PUT';
    } else if (action === 'unban') {
        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/bans/${userId}`;
        method = 'DELETE';
    } else if (action === 'timeout') {
        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`;
        method = 'PATCH';
        headers['Content-Type'] = 'application/json';
        
        // Calculate timeout expiration timestamp
        const until = new Date(Date.now() + parseInt(duration) * 1000).toISOString();
        body = JSON.stringify({ communication_disabled_until: until });
    } else if (action === 'unmute') {
        url = `https://discord.com/api/v10/guilds/${GUILD_ID}/members/${userId}`;
        method = 'PATCH';
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify({ communication_disabled_until: null });
    }

    try {
        const response = await fetch(url, { method, headers, body });
        if (response.ok || response.status === 204) return res.status(200).json({ success: true });
        
        const err = await response.text();
        return res.status(response.status).json({ error: err });
    } catch (e) {
        return res.status(500).json({ error: 'Moderation action failed' });
    }
}