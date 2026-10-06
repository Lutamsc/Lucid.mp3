import mongoose from 'mongoose';

// Ensure the schema matches exactly what is in submitDemo.js
const submissionSchema = new mongoose.Schema({
    submissionId: String,
    title: String,
    artist: String,
    email: String,
    fileLink: String,
    discordId: String,
    timestamp: { type: Date, default: Date.now }
});
const Submission = mongoose.models.Submission || mongoose.model('Submission', submissionSchema);

export default async function handler(req, res) {
    if (req.method !== 'GET') return res.status(405).send('Method Not Allowed');

    const searchId = req.query.id;
    if (!searchId) return res.status(400).json({ error: 'Missing submission ID parameter' });

    if (!process.env.MONGO_URI) {
        return res.status(500).json({ error: 'Database not configured (Missing MONGO_URI)' });
    }

    try {
        // Connect to MongoDB if not already connected
        if (mongoose.connection.readyState === 0) {
            await mongoose.connect(process.env.MONGO_URI);
        }

        // Fetch the exact record from MongoDB
        const record = await Submission.findOne({ submissionId: searchId });
        
        if (record) {
            return res.status(200).json(record);
        }
        
        return res.status(404).json({ error: 'Submission ID not found' });
    } catch (e) {
        console.error("Database lookup error:", e);
        return res.status(500).json({ error: 'Server lookup error' });
    }
}