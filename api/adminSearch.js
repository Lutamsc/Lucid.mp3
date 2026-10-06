export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    const searchId = req.query.id;
    if (!searchId) return res.status(400).json({ error: 'Missing submission ID parameter' });

    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!UPSTASH_URL || !UPSTASH_TOKEN) {
        return res.status(500).json({ error: 'Database not configured' });
    }

    try {
        const dbRes = await fetch(`${UPSTASH_URL}/get/submission:${searchId}`, {
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        const dbData = await dbRes.json();
        
        if (dbData.result) {
            const record = typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result;
            return res.status(200).json(record);
        }
        
        return res.status(404).json({ error: 'Submission ID not found' });
    } catch (e) {
        return res.status(500).json({ error: 'Server lookup error' });
    }
}