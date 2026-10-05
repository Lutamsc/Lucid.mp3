import cookie from 'cookie';

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

    const GUILD_ID = '1554157703067336875';
    const CATEGORY_ID = '1554160433722691594'; 
    const ROLE_1 = '1556218488425812079'; 
    const ROLE_2 = '1556249102444925039'; 
    const TOKEN = process.env.DISCORD_BOT_TOKEN;
    
    const UPSTASH_URL = process.env.UPSTASH_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN;

    if (!TOKEN || !UPSTASH_URL || !UPSTASH_TOKEN) {
        return res.status(500).send('FATAL ERROR: Missing Bot Token or Upstash DB keys.');
    }

    // See if the user is currently logged in via Discord (to log their ID in the database)
    const cookies = cookie.parse(req.headers.cookie || '');
    let loggedInUserId = null;
    if (cookies.discord_user) {
        try {
            const user = JSON.parse(cookies.discord_user);
            loggedInUserId = user.id;
        } catch(e) {}
    }

    try {
        const data = req.body;
        const title = data["Song title"];
        const artist = data["artist(s)"];
        const email = data["email adress"];
        const fileLink = data["mp3/wav file"];

        const countRes = await fetch(`${UPSTASH_URL}/incr/submission_counter`, {
            headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` }
        });
        const countData = await countRes.json();
        const nextCount = countData.result; 

        const paddedCount = String(nextCount).padStart(4, '0');
        const submissionId = `lcd-demo-${paddedCount}`;

        const record = {
            submissionId,
            title,
            artist,
            email,
            fileLink,
            discordId: loggedInUserId || "Guest",
            timestamp: new Date().toISOString()
        };

        await fetch(`${UPSTASH_URL}/set/submission:${submissionId}`, {
            method: 'POST',
            headers: { 
                Authorization: `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(record)
        });

        const formattedFileName = `${title} - ${artist}`;
        let safeArtist = artist.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-');
        const channelName = `web-ticket-${safeArtist}`.substring(0, 100);

        // ONLY Staff and Guild have permissions, User is NOT added to the ticket
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

        // Tag the staff ONLY
        const embedPayload = {
            content: `<@&${ROLE_1}> <@&${ROLE_2}>`,
            embeds: [
                {
                    title: "Wait for Demo review",
                    description: `Thank you for opening a ticket! Submission ID: **${submissionId}**`,
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

        const detailsPayload = {
            content: `**New Submission (ID: ${submissionId})**\n> **Song title**: ${title}\n> **artist(s)**: ${artist}\n> **File Name**: ${formattedFileName}\n> **email(s)**: ${email}\n> **mp3/wav file**: ${fileLink}`,
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

        return res.status(200).json({ success: true, submissionId });
    } catch (error) {
        return res.status(500).json({ error: error.message });
    }
}