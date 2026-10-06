import mongoose from 'mongoose';

const artistSchema = new mongoose.Schema({
    spotify: String,
    name: String,
    listeners: String
});
const Artist = mongoose.models.Artist || mongoose.model('Artist', artistSchema);

export default async function handler(req, res) {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI);
    
    if (req.method === 'POST') {
        const newArtist = await Artist.create(req.body);
        return res.status(201).json(newArtist);
    }
    
    const artists = await Artist.find({});
    res.status(200).json(artists);
}