require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const crypto = require('crypto');

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

// ── CPU hog ──────────────────────────────────────────────────────────────────
// Synchronous, blocking computation on the main thread.
// Realistic pattern: a report/export endpoint that serialises a large result
// set inline, or a naive implementation of a search/sort/hash over unbounded
// data.  Because Node.js is single-threaded, this blocks the event loop —
// no other request can be processed until this function returns.
//
// The work here is repeated synchronous hashing (CPU-bound, not I/O-bound)
// so it cannot be "fixed" by awaiting — it genuinely needs to move to a
// worker thread or be offloaded to a job queue.
function blockingHeavyComputation() {
  const iterations = 500_000;
  let hash = 'seed';
  for (let i = 0; i < iterations; i++) {
    hash = crypto.createHash('sha256').update(hash + i).digest('hex');
  }
  return hash;
}

// This endpoint represents a "generate report" or "export all" feature that
// was implemented synchronously without realising the cost.
app.get('/api/slow', (req, res) => {
  const result = blockingHeavyComputation();
  res.json({ status: 'done', checksum: result });
});

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
