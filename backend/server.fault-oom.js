require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-docker-deploy';
mongoose.connect(mongoURI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.log(err));

const itemSchema = new mongoose.Schema({ name: String });
const Item = mongoose.model('Item', itemSchema);

// ── Memory leak ──────────────────────────────────────────────────────────────
// A module-level cache that is never evicted.  Each POST /api/items appends
// the full request body plus a 10 MB buffer to this array.  In a real app
// this pattern appears as: an unbounded in-memory cache, an event listener
// accumulation, a growing session store, or a result set that is never
// paginated.  The leak is silent — no error is thrown — so the only signals
// are rising RSS in `docker stats` and, eventually, an OOM kill (exit 137).
const requestCache = [];

app.get('/api/items', async (req, res) => {
  try {
    const items = await Item.find();
    res.json(items);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items', async (req, res) => {
  try {
    // Leak: store every request payload + a large buffer in the module-level array.
    // The buffer is allocated with random data so the allocator cannot deduplicate it.
    requestCache.push({
      body: req.body,
      ts: Date.now(),
      _leak: Buffer.allocUnsafe(10 * 1024 * 1024), // 10 MB per request
    });

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
