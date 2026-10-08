import spotifyUrlInfo from 'spotify-url-info';

// Initialize the scraper using Node's native fetch
const { getTracks } = spotifyUrlInfo(fetch);

export default async function handler(req, res) {
    // 1. Load Environment Variables
    const PLAYLIST_URL = process.env.SPOTIFY_PLAYLIST_URL; // Just paste your normal playlist link!
    const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
    const CHANNEL_ID = process.env.RELEASES_CHANNEL_ID; 
    const ROLE_ID = process.env.NEW_RELEASE_ROLE_ID; 

    const UPSTASH_URL = process.env.UPSTASH_URL || process.env.UPSTASH_REDIS_REST_URL;
    const UPSTASH_TOKEN = process.env.UPSTASH_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

    if (!PLAYLIST_URL || !DISCORD_TOKEN || !UPSTASH_URL) {
        return res.status(500).json({ error: 'Missing configuration variables.' });
    }

    try {
        // 2. Read the public playlist WITHOUT Spotify API Keys!
        const tracks = await getTracks(PLAYLIST_URL);
        
        if (!tracks || tracks.length === 0) {
            return res.status(200).json({ message: 'Playlist empty or not found.' });
        }

        // 3. Extract the actual Spotify web links for the songs
        const currentTracks = tracks.map(track => {
            return track.external_urls?.spotify || `https://open.spotify.com/track/${track.id}`;
        });

        // 4. Check Upstash for what we have already posted
        const dbRes = await fetch(`${UPSTASH_URL}/get/spotify_last_checked`, {
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
        });
        const dbData = await dbRes.json();
        
        let previouslyPosted = [];
        if (dbData.result) {
            previouslyPosted = typeof dbData.result === 'string' ? JSON.parse(dbData.result) : dbData.result;
        }

        // 5. Find the brand new tracks
        const newTracks = currentTracks.filter(trackUrl => !previouslyPosted.includes(trackUrl));

        if (newTracks.length === 0) {
            return res.status(200).json({ message: 'No new tracks to post.' });
        }

        // 6. Format the Discord Message
        let discordMessage = `<@&${ROLE_ID}>\n`;
        
        if (newTracks.length === 1) {
            discordMessage += `**New Lucid.Mp3 Release!**\n${newTracks[0]}`;
        } else {
            discordMessage += `**${newTracks.length} New Lucid.Mp3 Releases:**\n\n`;
            discordMessage += newTracks.join('\n');
        }

        // 7. Post to Discord
        await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bot ${DISCORD_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ content: discordMessage })
        });

        // 8. Save the updated list to Upstash so we don't post them again
        // Keep a memory of the last 50 tracks to keep the database fast
        const updatedMemory = [...newTracks, ...previouslyPosted].slice(0, 50); 
        await fetch(`${UPSTASH_URL}/set/spotify_last_checked`, {
            method: 'POST',
            headers: { 
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(updatedMemory)
        });

        return res.status(200).json({ success: true, posted: newTracks.length });

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: 'Failed to process Spotify sync.' });
    }
}