export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

    const { welcomeMessage } = req.body;
    const URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    try {
        // Save the welcome message format to Upstash
        await fetch(`${URL}/set/bot_config:welcome_message`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${TOKEN}`, 
                'Content-Type': 'application/json' 
            },
            body: JSON.stringify(welcomeMessage)
        });

        return res.status(200).json({ success: true });
    } catch (e) {
        return res.status(500).json({ error: 'Failed to save config' });
    }
}