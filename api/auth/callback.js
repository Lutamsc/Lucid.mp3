import cookie from 'cookie';

export default async function handler(req, res) {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code provided from Discord');

    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://' + req.headers.host}/api/auth/callback`;

    try {
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
        if (!tokenData.access_token) return res.status(400).send('Failed to obtain access token from Discord');

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        const userData = await userRes.json();
        
        // Save user session in an encrypted secure cookie
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

        res.redirect('/');
    } catch (error) {
        res.status(500).send('Authentication error');
    }
}