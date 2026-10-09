import cookie from 'cookie';

export default async function handler(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname.toLowerCase();

    // Safely unwrap action whether passed as string or array by Vercel's :action* rewrite
    let actionParam = req.query.action || '';
    if (Array.isArray(actionParam)) actionParam = actionParam.join('/');
    const action = actionParam.toLowerCase();

    const isAction = (name) => pathname.includes(name) || action.includes(name);

    const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1556227335634817054';
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    const REDIRECT_URI = 'https://www.lucidmp3.com/api/auth/callback';

    // 1. DISCORD LOGIN
    if (isAction('discord')) {
        const discordLoginUrl = `https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&scope=identify`;
        return res.redirect(discordLoginUrl);
    }

    // 2. DISCORD CALLBACK
    if (isAction('callback')) {
        const { code } = req.query;
        if (!code) return res.status(400).send('No code provided from Discord');

        try {
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: REDIRECT_URI,
                }),
            });

            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) return res.status(400).send('Failed to obtain access token');

            const userRes = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            const userData = await userRes.json();

            res.setHeader('Set-Cookie', cookie.serialize('discord_user', JSON.stringify({
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar
            }), {
                httpOnly: true,
                secure: process.env.NODE_ENV !== 'development',
                maxAge: 60 * 60 * 24 * 7,
                path: '/'
            }));

            return res.redirect('/');
        } catch (error) {
            return res.status(500).send('Authentication error');
        }
    }

    // 3. LOGOUT
    if (isAction('logout')) {
        res.setHeader('Set-Cookie', 'discord_user=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        return res.redirect('/');
    }

    // 4. ME / SESSION CHECK
    if (isAction('me')) {
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

    return res.status(404).json({ error: 'Auth action not found' });
}
