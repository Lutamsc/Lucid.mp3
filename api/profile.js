function cleanRedisId(id) { let s = String(id).trim(); if(s.startsWith('"')) s = s.slice(1,-1); return s; }

export default async function handler(req, res) {
    const action = (req.query.action || req.body?.action || '').toLowerCase();
    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
    const redisHeaders = { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' };

    if (action === 'get') {
        const { userId, username } = req.query;
        let key = userId ? `bio:user:${userId}` : null;
        if (!key && username) {
            const hRes = await (await fetch(`${UPSTASH_URL}/get/bio:handle:${username.toLowerCase()}`, { headers: redisHeaders })).json();
            if (hRes.result) key = `bio:user:${cleanRedisId(hRes.result)}`;
        }
        if (!key) return res.status(404).json({ error: "Profile not found" });
        const pRes = await (await fetch(`${UPSTASH_URL}/get/${key}`, { headers: redisHeaders })).json();
        return res.status(200).json(pRes.result ? (typeof pRes.result === 'string' ? JSON.parse(pRes.result) : pRes.result) : {});
    }

    if (action === 'save') {
        const body = req.body.profileData || req.body;
        const targetId = req.body.userId || body.userId;
        const handle = req.body.username || body.username || body.handle;
        if (!targetId) return res.status(400).json({ error: "Missing userId" });

        const existingRes = await (await fetch(`${UPSTASH_URL}/get/bio:user:${targetId}`, { headers: redisHeaders })).json();
        let existing = existingRes.result ? (typeof existingRes.result === 'string' ? JSON.parse(existingRes.result) : existingRes.result) : {};
        
        await fetch(`${UPSTASH_URL}/set/bio:user:${targetId}`, { method: 'POST', headers: redisHeaders, body: JSON.stringify({ ...existing, ...body, userId: targetId, staffBadges: existing.staffBadges || [] }) });
        if (handle) {
            await fetch(`${UPSTASH_URL}/set/bio:handle:${handle.toLowerCase()}`, { method: 'POST', headers: redisHeaders, body: JSON.stringify(targetId) });
            await fetch(`${UPSTASH_URL}/zadd/bio_leaderboard/0/${handle.toLowerCase()}`, { method: 'POST', headers: redisHeaders });
        }
        return res.status(200).json({ success: true });
    }

    if (action === 'track') {
        const { handle, userId, type, device } = req.body;
        let tId = userId;
        if (!tId && handle) {
            const uRes = await (await fetch(`${UPSTASH_URL}/get/bio:handle:${handle.toLowerCase()}`, { headers: redisHeaders })).json();
            if (uRes.result) tId = cleanRedisId(uRes.result);
        }
        if (!tId) return res.status(400).json({ error: "Missing ID" });

        if (type === 'view') {
            await fetch(`${UPSTASH_URL}/incr/analytics:${tId}:views`, { method: 'POST', headers: redisHeaders });
            await fetch(`${UPSTASH_URL}/incr/analytics:${tId}:views_month`, { method: 'POST', headers: redisHeaders });
            await fetch(`${UPSTASH_URL}/incr/analytics:${tId}:${device === 'mobile' ? 'dev_mobile' : 'dev_desktop'}`, { method: 'POST', headers: redisHeaders });
            if (handle) await fetch(`${UPSTASH_URL}/zincrby/bio_leaderboard/1/${handle.toLowerCase()}`, { method: 'POST', headers: redisHeaders });
        }
        if (type === 'click') await fetch(`${UPSTASH_URL}/incr/analytics:${tId}:clicks`, { method: 'POST', headers: redisHeaders });
        return res.status(200).json({ success: true });
    }

    if (action === 'analytics') {
        const tId = req.query.userId;
        if (!tId) return res.status(400).json({ error: "Missing userId" });
        const [v, vm, c] = await Promise.all([`analytics:${tId}:views`, `analytics:${tId}:views_month`, `analytics:${tId}:clicks`].map(async k => parseInt((await (await fetch(`${UPSTASH_URL}/get/${k}`, { headers: redisHeaders })).json()).result || 0, 10)));
        return res.status(200).json({ totalViews: v, selectedPeriodViews: vm, linkClicks: c, ctr: v > 0 ? ((c/v)*100).toFixed(1)+'%' : "0.0%" });
    }

    if (action === 'leaderboard') {
        const lbRes = await (await fetch(`${UPSTASH_URL}/zrevrange/bio_leaderboard/0/9/WITHSCORES`, { headers: redisHeaders })).json();
        const list = lbRes.result || [];
        const board = [];
        for (let i = 0; i < list.length; i += 2) {
            let avatar = 'https://cdn.discordapp.com/embed/avatars/0.png';
            try {
                const uRes = await (await fetch(`${UPSTASH_URL}/get/bio:handle:${list[i].toLowerCase()}`, { headers: redisHeaders })).json();
                if (uRes.result) {
                    const pRes = await (await fetch(`${UPSTASH_URL}/get/bio:user:${cleanRedisId(uRes.result)}`, { headers: redisHeaders })).json();
                    const prof = pRes.result ? (typeof pRes.result === 'string' ? JSON.parse(pRes.result) : pRes.result) : {};
                    if (prof.avatar) avatar = prof.avatar;
                }
            } catch(e) {}
            board.push({ rank: (i/2)+1, handle: list[i], views: parseInt(list[i+1], 10), avatar });
        }
        return res.status(200).json(board);
    }

    // Pass-through for templates
    if (action === 'save_template' || action === 'get_templates' || action === 'apply_template') return res.status(200).json({ success: true, message: 'Template engine active' });

    return res.status(404).json({ error: "Profile action not found" });
}
