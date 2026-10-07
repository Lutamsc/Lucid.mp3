export default function handler(req, res) {
    // URL updated to only request "identify" scope, removing auto-join
    const discordLoginUrl = "https://discord.com/oauth2/authorize?client_id=1556227335634817054&response_type=code&redirect_uri=https%3A%2F%2Fwww.lucidmp3.com%2Fapi%2Fauth%2Fcallback&scope=identify";
    
    res.redirect(discordLoginUrl);
}
