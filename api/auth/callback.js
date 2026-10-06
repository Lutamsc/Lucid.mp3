import cookie from 'cookie';

export default async function handler(req, res) {
    const { code } = req.query;
    if (!code) return res.status(400).send('No code provided from Discord');

    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    
    const redirectUri = 'https://lucidmp3-eight.vercel.app/api/auth/callback';

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

        res.redirect('/');
    } catch (error) {
        res.status(500).send('Authentication error');
    }
}