import cookie from 'cookie';

export default function handler(req, res) {
    const cookies = cookie.parse(req.headers.cookie || '');
    if (!cookies.discord_user) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const user = JSON.parse(cookies.discord_user);
        return res.status(200).json(user);
    } catch (e) {
        return res.status(401).json({ error: 'Invalid session' });
    }
}