export default function handler(req, res) {
    // Paste the NEW URL with both "identify" and "guilds.join" scopes here:
    const discordLoginUrl = "https://discord.com/oauth2/authorize?client_id=1556227335634817054&response_type=code&redirect_uri=https%3A%2F%2Flucidmp3-eight.vercel.app%2Fapi%2Fauth%2Fcallback&scope=identify+guilds.join+guilds";
    
    res.redirect(discordLoginUrl);
}