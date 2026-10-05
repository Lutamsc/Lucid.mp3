export default function handler(req, res) {
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const redirectUri = `${process.env.NEXT_PUBLIC_SITE_URL || 'https://' + req.headers.host}/api/auth/callback`;
    
    const discordLoginUrl = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=identify`;
    
    res.redirect(discordLoginUrl);
}