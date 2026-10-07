export default function handler(req, res) {
    // Encoded URL for https://www.lucidmp3.com/api/auth/callback
    const discordLoginUrl = "https://discord.com/oauth2/authorize?client_id=1556227335634817054&response_type=code&redirect_uri=https%3A%2F%2Fwww.lucidmp3.com%2Fapi%2Fauth%2Fcallback&scope=identify";
    
    res.redirect(discordLoginUrl);
}
