import mongoose from 'mongoose';

const catalogSchema = new mongoose.Schema({
    spotify: String,
    artist: String
});
const Catalog = mongoose.models.Catalog || mongoose.model('Catalog', catalogSchema);

export default async function handler(req, res) {
    if (mongoose.connection.readyState === 0) await mongoose.connect(process.env.MONGO_URI);
    
    if (req.method === 'POST') {
        const newRelease = await Catalog.create(req.body);
        return res.status(201).json(newRelease);
    }
    
    const catalog = await Catalog.find({});
    res.status(200).json(catalog);
}