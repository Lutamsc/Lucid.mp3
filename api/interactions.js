const { verifyKey } = require('discord-interactions');
const nodemailer = require('nodemailer');

export const config = { api: { bodyParser: false } };

async function getRawBody(req) {
    const chunks = [];
    for await (const chunk of req) {
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString('utf8');
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const signature = req.headers['x-signature-ed25519'];
    const timestamp = req.headers['x-signature-timestamp'];
    const PUBLIC_KEY = process.env.DISCORD_PUBLIC_KEY;

    if (!signature || !timestamp || !PUBLIC_KEY) {
        console.error("ERROR: Missing Signature or Vercel Environment Variable");
        return res.status(401).send('Missing headers or public key in Vercel');
    }

    const rawBody = await getRawBody(req);

    const isValidRequest = verifyKey(rawBody, signature, timestamp, PUBLIC_KEY);
    if (!isValidRequest) {
        console.error("ERROR: Discord signature verification failed");
        return res.status(401).send('Invalid request signature');
    }

    const interaction = JSON.parse(rawBody);

    // 1. Initial Ping Verification
    if (interaction.type === 1) {
        return res.status(200).json({ type: 1 });
    }

    // 2. Button Clicked -> Send Popup (Modal)
    if (interaction.type === 3) {
        const customId = interaction.data.custom_id;
        if (customId === 'btn_accept' || customId === 'btn_reject') {
            const isAccept = customId === 'btn_accept';
            return res.status(200).json({
                type: 9,
                data: {
                    title: isAccept ? "Accept Demo" : "Reject Demo",
                    custom_id: isAccept ? "modal_accept" : "modal_reject",
                    components: [{
                        type: 1,
                        components: [{
                            type: 4, 
                            custom_id: "reason_input",
                            label: isAccept ? "Notes for the artist:" : "Enter your reason:",
                            style: 2,
                            required: true
                        }]
                    }]
                }
            });
        }
    }

    // 3. Modal Submitted -> Send Email & Delete Channel
    if (interaction.type === 5) {
        const customId = interaction.data.custom_id;
        const reason = interaction.data.components[0].components[0].value;
        const channelId = interaction.channel.id;
        const token = process.env.DISCORD_BOT_TOKEN;

        const msgRes = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages?limit=10`, {
            headers: { 'Authorization': `Bot ${token}` }
        });
        const messages = await msgRes.json();
        
        let subDetails = "";
        for (const msg of messages) {
            if (msg.content && msg.content.includes("**email adress**:")) {
                subDetails = msg.content;
                break;
            }
        }

        const titleMatch = subDetails.match(/\*\*Song title\*\*: (.*)/);
        const artistMatch = subDetails.match(/\*\*artist\(s\)\*\*: (.*)/);
        const emailMatch = subDetails.match(/\*\*email adress\*\*: (.*)/);
        const fileMatch = subDetails.match(/\*\*mp3\/wav file\*\*: (.*)/);

        const title = titleMatch ? titleMatch[1].trim() : "Unknown";
        const artist = artistMatch ? artistMatch[1].trim() : "Unknown";
        const userEmail = emailMatch ? emailMatch[1].trim() : "";
        const fileLink = fileMatch ? fileMatch[1].trim() : "Unknown";

        const transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || "smtp.gmail.com",
            port: 465,
            secure: true,
            auth: {
                user: process.env.SMTP_EMAIL,
                pass: process.env.SMTP_PASSWORD
            }
        });

        let emailSubject = "";
        let emailText = "";

        if (customId === 'modal_accept') {
            emailSubject = "Your demo has been accepted! - Lucid.mp3";
            emailText = `Hey,\n\nTo continue with this track on the easiest way, we suggest you to join our discord server: https://discord.gg/ECMHzfWyrD\n\nSong title: ${title}\nArtist(s): ${artist}\nmp3/wav file: ${fileLink}\n\nNotes: ${reason}\n\nRegards,\nLucid.mp3`;
        } else {
            emailSubject = "Update on your demo submission - Lucid.mp3";
            emailText = `Hey,\n\nOur team has listened to your track and heard its not quite fitting to what Lucid.mp3 is looking for\n\nReason: ${reason}\n\nPlease still feel free to send us more demos!\n\nRegards,\nLucid.mp3`;
        }

        if (userEmail) {
            await transporter.sendMail({
                from: `"Lucid.mp3" <${process.env.SMTP_EMAIL}>`,
                to: userEmail,
                subject: emailSubject,
                text: emailText
            });
        }

        await fetch(`https://discord.com/api/v10/channels/${channelId}`, {
            method: 'DELETE',
            headers: { 'Authorization': `Bot ${token}` }
        });

        return res.status(200).json({ type: 6 });
    }

    return res.status(400).send('Unknown interaction');
}