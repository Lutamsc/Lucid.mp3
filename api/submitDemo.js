export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const GUILD_ID = '1554157703067336875';
    const CATEGORY_ID = '1554160433722691594'; 
    const ROLE_1 = '1556218488425812079'; 
    const ROLE_2 = '1556249102444925039'; 
    const TOKEN = process.env.DISCORD_BOT_TOKEN;

    if (!TOKEN) return res.status(500).send('FATAL ERROR: Bot Token is missing.');

    try {
        const data = req.body;
        const title = data["Song title"];
        const artist = data["artist(s)"];
        const email = data["email adress"];
        const fileLink = data["mp3/wav file"];

        // Formats the custom name format: song name - artist(s)
        const formattedFileName = `${title} - ${artist}`;

        let safeArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const channelName = `web-ticket-${safeArtist}`.substring(0, 100);

        const channelPayload = {
            name: channelName,
            type: 0,
            parent_id: CATEGORY_ID,
            permission_overwrites: [
                { id: GUILD_ID, type: 0, deny: "1024" }, 
                { id: ROLE_1, type: 0, allow: "17408" },  
                { id: ROLE_2, type: 0, allow: "17408" }   
            ]
        };

        const createChannelRes = await fetch(`https://discord.com/api/v10/guilds/${GUILD_ID}/channels`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(channelPayload)
        });

        if (!createChannelRes.ok) return res.status(500).send(`Discord API Error`);
        const channelData = await createChannelRes.json();

        // MESSAGE 1: The Pings and the Embed
        const embedPayload = {
            content: `<@&${ROLE_1}> <@&${ROLE_2}>`,
            embeds: [
                {
                    title: "Wait for Demo review",
                    description: "Thank you for opening a ticket! A member of our team will be with you shortly.",
                    color: 0x2b2d31,
                    footer: { text: "Powered by Lucid.Mp3" } 
                }
            ]
        };

        await fetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(embedPayload)
        });

        // MESSAGE 2: Submission Details with the clean file reference name
        const detailsPayload = {
            content: `**You've received a new submission from lucid.mp3**\n> **Song title**: ${title}\n> **artist(s)**: ${artist}\n> **File Name**: ${formattedFileName}\n> **email adress**: ${email}\n> **mp3/wav file**: ${fileLink}`,
            components: [
                {
                    type: 1,
                    components: [
                        { type: 2, style: 3, label: "Accept Demo", custom_id: "btn_accept", emoji: { name: "✅" } },
                        { type: 2, style: 4, label: "Reject (Close with Reason)", custom_id: "btn_reject", emoji: { name: "❌" } }
                    ]
                }
            ]
        };

        await fetch(`https://discord.com/api/v10/channels/${channelData.id}/messages`, {
            method: 'POST',
            headers: { 'Authorization': `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(detailsPayload)
        });

        return res.status(200).send('Ticket generated successfully');
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}