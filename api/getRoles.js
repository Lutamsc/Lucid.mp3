export default async function handler(req, res) {
    const GUILD_ID = '1554157703067336875'; 
    const TOKEN = process.env.DISCORD_BOT_TOKEN;

    try {
        const response = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/members?limit=1000`, {
            method: 'GET',
            headers: {
                "Authorization": `Bot ${TOKEN}`
            }
        });
        
        if (!response.ok) return res.status(response.status).send("Discord API Error");

        const data = await response.json();
        
        // Filter out all bot accounts so they don't show up in the member list
        const humanMembers = data.filter(member => !member.user.bot);

        return res.status(200).json(humanMembers);
    } catch(error) {
        return res.status(500).json({ error: "Server Error" });
    }
}