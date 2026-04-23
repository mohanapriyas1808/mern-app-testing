require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

// ── Tight buffer timeout ─────────────────────────────────────────────────────
// bufferTimeoutMS controls how long mongoose will wait for a command to be
// sent to MongoDB before throwing a buffering timeout error.  Setting it low
// (2 s) makes slow queries surface as errors quickly rather than hanging
// indefinitely.  In a real scenario this would be the default 10 s timeout
// being hit because queries are genuinely slow (missing index, large COLLSCAN).
const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-docker-deploy';
mongoose.connect(mongoURI, { bufferTimeoutMS: 2000 })
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.log(err));

// ── Schema without index ─────────────────────────────────────────────────────
// No index on `name`.  With a small collection this is invisible.
// As the collection grows, find() and find({name: ...}) become full collection
// scans.  MongoDB's explain() would show COLLSCAN, and slow query logs would
// appear in mongod output once the slowms threshold is crossed.
const itemSchema = new mongoose.Schema({ name: String });
const Item = mongoose.model('Item', itemSchema);

// ── Artificially slow find to simulate index-miss latency ────────────────────
// In a real scenario the slowness comes from MongoDB itself (COLLSCAN on a
// large collection).  Here we add a deliberate sort on an unindexed field
// which forces a full in-memory sort — the same symptom a missing index causes.
app.get('/api/items', async (req, res) => {
  try {
    // sort on an unindexed field forces MongoDB to load and sort the entire
    // collection in memory — equivalent to a missing index on a sort field.
    const items = await Item.find().sort({ name: 1 });
    res.json(items);
  } catch (err) {
    // MongooseError: buffering timed out  OR  MongoServerError: sort exceeded memory limit
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items', async (req, res) => {
  try {
    const newItem = new Item({ name: req.body.name });
    await newItem.save();
    res.json(newItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/items/:id', async (req, res) => {
  try {
    const updatedItem = await Item.findByIdAndUpdate(
      req.params.id,
      { name: req.body.name },
      { new: true }
    );
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    await Item.findByIdAndDelete(req.params.id);
    res.json({ message: 'Item deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
