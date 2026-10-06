export default async function handler(req, res) {
    const URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    if (!URL || !TOKEN) return res.status(500).json({error: "No DB credentials"});

    if (req.method === 'POST') {
        const newItem = JSON.stringify(req.body);
        await fetch(`${URL}/lpush/lucid_catalog`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${TOKEN}` },
            body: newItem
        });
        return res.status(201).json({ success: true });
    }
    
    const dbRes = await fetch(`${URL}/lrange/lucid_catalog/0/-1`, {
        headers: { Authorization: `Bearer ${TOKEN}` }
    });
    const dbData = await dbRes.json();
    const catalog = (dbData.result || []).map(item => typeof item === 'string' ? JSON.parse(item) : item);
    res.status(200).json(catalog);
}