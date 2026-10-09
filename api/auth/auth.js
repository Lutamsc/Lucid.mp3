import cookie from 'cookie';

export default async function handler(req, res) {
    const urlObj = new URL(req.url, 'http://localhost');
    const pathname = urlObj.pathname.toLowerCase();
    const action = (req.query.action || '').toLowerCase();

    // ==========================================
    // 1. DISCORD LOGIN (Redirect to OAuth)
    // ==========================================
    if (pathname.endsWith('/discord') || action === 'discord') {
        const discordLoginUrl = "https://discord.com/oauth2/authorize?client_id=1556227335634817054&response_type=code&redirect_uri=https%3A%2F%2Fwww.lucidmp3.com%2Fapi%2Fauth%2Fcallback&scope=identify";
        return res.redirect(discordLoginUrl);
    }

    // ==========================================
    // 2. DISCORD CALLBACK (Token Exchange & Cookie Set)
    // ==========================================
    if (pathname.endsWith('/callback') || action === 'callback') {
        const { code } = req.query;
        if (!code) return res.status(400).send('No code provided from Discord');

        const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
        const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
        const redirectUri = 'https://www.lucidmp3.com/api/auth/callback';

        try {
            // 1. Get the user's access token
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({
                    client_id: CLIENT_ID,
                    client_secret: CLIENT_SECRET,
                    grant_type: 'authorization_code',
                    code: code,
                    redirect_uri: redirectUri,
                }),
            });

            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) return res.status(400).send('Failed to obtain access token');

            // 2. Get the user's Discord profile data
            const userRes = await fetch('https://discord.com/api/users/@me', {
                headers: { Authorization: `Bearer ${tokenData.access_token}` },
            });
            const userData = await userRes.json();
            
            // 3. Save their session cookie
            res.setHeader('Set-Cookie', cookie.serialize('discord_user', JSON.stringify({
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar
            }), {
                httpOnly: true,
                secure: process.env.NODE_ENV !== 'development',
                maxAge: 60 * 60 * 24 * 7, // 1 week
                path: '/'
            }));

            return res.redirect('/');
        } catch (error) {
            return res.status(500).send('Authentication error');
        }
    }

    // ==========================================
    // 3. LOGOUT (Clear Session Cookie)
    // ==========================================
    if (pathname.endsWith('/logout') || action === 'logout') {
        res.setHeader('Set-Cookie', 'discord_user=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        return res.redirect('/');
    }

    // ==========================================
    // 4. ME / SESSION VERIFICATION (Current User)
    // ==========================================
    if (pathname.endsWith('/me') || action === 'me') {
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