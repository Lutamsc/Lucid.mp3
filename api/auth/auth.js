import cookie from 'cookie';

export default async function handler(req, res) {
    const action = (req.query.action || '').toLowerCase();
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID || '1556227335634817054';
    const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
    const redirectUri = 'https://www.lucidmp3.com/api/auth?action=callback';

    if (action === 'discord') {
        return res.redirect(`https://discord.com/oauth2/authorize?client_id=${CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=identify`);
    }

    if (action === 'callback') {
        const code = req.query.code;
        if (!code) return res.status(400).send('No code provided');
        
        try {
            const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
            });
            const tokenData = await tokenRes.json();
            if (!tokenData.access_token) return res.status(400).send('OAuth failed');

            const userRes = await fetch('https://discord.com/api/users/@me', { headers: { Authorization: `Bearer ${tokenData.access_token}` } });
            const userData = await userRes.json();

            const discordAvatarUrl = userData.avatar ? `https://cdn.discordapp.com/avatars/${userData.id}/${userData.avatar}.${userData.avatar.startsWith('a_') ? 'gif' : 'png'}?size=256` : `https://cdn.discordapp.com/embed/avatars/0.png`;

            res.setHeader('Set-Cookie', cookie.serialize('discord_user', JSON.stringify({ id: userData.id, username: userData.username, global_name: userData.global_name || userData.username, avatar: discordAvatarUrl }), { httpOnly: true, secure: process.env.NODE_ENV !== 'development', maxAge: 604800, path: '/' }));
            return res.redirect('/');
        } catch (error) { return res.status(500).send(`Auth error: ${error.message}`); }
    }

    if (action === 'logout') {
        res.setHeader('Set-Cookie', 'discord_user=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        return res.redirect('/');
    }

    if (action === 'me') {
        const cookies = cookie.parse(req.headers.cookie || '');
        if (!cookies.discord_user) return res.status(401).json({ error: 'Not authenticated' });
        try { return res.status(200).json(JSON.parse(cookies.discord_user)); } catch (e) { return res.status(401).json({ error: 'Invalid session' }); }
    }

    return res.status(404).json({ error: 'Auth action not found' });
}
