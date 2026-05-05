require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const EventEmitter = require('events');

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

// ── Leak 1: unbounded response cache ─────────────────────────────────────────
// Looks like a legitimate API response cache. No TTL, no max size.
// Every unique query string gets its own entry and is never evicted.
// In production this appears as a "performance optimisation" that slowly
// consumes all available memory over hours or days.
const responseCache = {};

// ── Leak 2: accumulating event listeners ─────────────────────────────────────
// A new EventEmitter listener is registered on every request but never removed.
// Node will warn at >10 listeners but the leak continues silently beyond that.
// Common in real apps that attach listeners inside request handlers or
// middleware without a corresponding removeListener / once call.
const bus = new EventEmitter();
bus.setMaxListeners(0); // suppress the warning so the leak is silent

// ── Leak 3: session-style store with no expiry ───────────────────────────────
// Mimics a naive in-memory session or audit log store. Each request appends
// the full payload and a timestamp. Never pruned. Grows linearly with traffic.
const auditLog = [];

app.get('/api/items', async (req, res) => {
  const cacheKey = JSON.stringify(req.query);

  // Leak 1: cache miss populates the cache; hit returns stale data — but the
  // cache entry is never invalidated or evicted regardless of which path runs.
  if (!responseCache[cacheKey]) {
    try {
      // Leak: fetch ALL documents with no limit — as the collection grows,
      // each cache entry holds the entire result set in memory.
      const items = await Item.find();
      responseCache[cacheKey] = { data: items, cachedAt: Date.now() };
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // Leak 2: new listener registered on every GET, never removed.
  bus.on('item:created', (item) => {
    // intentionally empty — the closure keeps `item` alive in memory
  });

  res.json(responseCache[cacheKey].data);
});

app.post('/api/items', async (req, res) => {
  try {
    const newItem = new Item({ name: req.body.name });
    await newItem.save();

    // Leak 3: every POST appends to the audit log indefinitely.
    auditLog.push({
      action: 'create',
      payload: req.body,
      result: newItem.toObject(),
      ts: new Date().toISOString(),
    });

    // Leak 1: invalidate cache by adding a new key rather than clearing —
    // the old entries remain, so the cache only ever grows.
    responseCache[Date.now()] = { data: [newItem], cachedAt: Date.now() };

    bus.emit('item:created', newItem);
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

    // Leak 3: audit log grows on every mutation.
    auditLog.push({
      action: 'update',
      id: req.params.id,
      payload: req.body,
      result: updatedItem?.toObject(),
      ts: new Date().toISOString(),
    });

    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/items/:id', async (req, res) => {
  try {
    await Item.findByIdAndDelete(req.params.id);

    auditLog.push({
      action: 'delete',
      id: req.params.id,
      ts: new Date().toISOString(),
    });

    res.json({ message: 'Item deleted successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Backend running on http://localhost:${PORT}`);
});
