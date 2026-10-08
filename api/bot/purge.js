export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { channelId, count } = req.body;
    const token = process.env.DISCORD_BOT_TOKEN;

    try {
        // 1. Fetch the messages
        const getRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=${count}`, {
            headers: { 'Authorization': `Bot ${token}` }
        });
        const messages = await getRes.json();
        
        if (!messages || messages.length === 0) return res.status(200).json({ success: true });
        
        const messageIds = messages.map(m => m.id);

        // 2. Delete them
        if (messageIds.length === 1) {
            await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageIds[0]}`, {
                method: 'DELETE',
                headers: { 'Authorization': `Bot ${token}` }
            });
        } else {
            await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/bulk-delete`, {
                method: 'POST',
                headers: { 'Authorization': `Bot ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: messageIds })
            });
        }

        return res.status(200).json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Purge failed' });
    }
}