export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { channelId, message } = req.body;
    const token = process.env.DISCORD_BOT_TOKEN;

    if (!token) return res.status(500).json({ error: 'Missing Bot Token' });

    try {
        const response = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bot ${token}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify({ content: message })
        });

        if (response.ok) return res.status(200).json({ success: true });
        
        const err = await response.text();
        return res.status(response.status).json({ error: err });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to send message' });
    }
}