require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

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

// ── Disk exhaustion patterns ─────────────────────────────────────────────────
// 1. Unbounded log file growth - no rotation, no size limit
// 2. Every request writes a large audit trail
// 3. Temp files are created but never cleaned up
const LOG_DIR = '/app/logs';
const TEMP_DIR = '/app/temp';

// Create directories if they don't exist
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  console.log(`[INIT] Created log directory: ${LOG_DIR}`);
}
if (!fs.existsSync(TEMP_DIR)) {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
  console.log(`[INIT] Created temp directory: ${TEMP_DIR}`);
}

// ── Log flooding: append large audit entry on every request ─────────────────
app.use((req, res, next) => {
  const logFile = path.join(LOG_DIR, 'audit.log');
  const timestamp = new Date().toISOString();
  
  try {
    // Write ~100KB per request - simulates verbose logging with stack traces,
    // request bodies, headers, etc. No rotation means this grows unbounded.
    const auditEntry = {
      timestamp,
      method: req.method,
      url: req.url,
      headers: req.headers,
      ip: req.ip,
      // Artificially large payload to accelerate disk exhaustion
      verbose_trace: 'TRACE_DATA: ' + 'x'.repeat(100000),
    };
    
    fs.appendFileSync(logFile, JSON.stringify(auditEntry) + '\n');
    
    // Log file size every 10 requests to show growth
    if (Math.random() < 0.1) {
      const stats = fs.statSync(logFile);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`[AUDIT] audit.log size: ${sizeMB} MB`);
    }
    
    next();
  } catch (err) {
    console.error(`[ERROR] Failed to write audit log: ${err.code} - ${err.message}`);
    // Continue anyway - don't let logging failure break requests (initially)
    next();
  }
});

app.get('/api/items', async (req, res) => {
  try {
    console.log('[GET /api/items] Fetching items from database');
    const items = await Item.find();
    console.log(`[GET /api/items] Retrieved ${items.length} items`);
    res.json(items);
  } catch (err) {
    console.error(`[GET /api/items] ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/items', async (req, res) => {
  try {
    console.log(`[POST /api/items] Creating new item: ${req.body.name}`);
    
    // ── Temp file leak: create a "processing" temp file but never delete it ──
    const tempFile = path.join(TEMP_DIR, `temp_${Date.now()}_${Math.random()}.dat`);
    console.log(`[POST /api/items] Writing temp file: ${path.basename(tempFile)}`);
    
    // Simulate processing artifact - 5MB per POST
    fs.writeFileSync(tempFile, Buffer.alloc(5 * 1024 * 1024));
    
    // Log temp dir size periodically
    const tempFiles = fs.readdirSync(TEMP_DIR);
    if (tempFiles.length % 10 === 0) {
      console.log(`[TEMP] Temp directory now contains ${tempFiles.length} files`);
    }
    
    const newItem = new Item({ name: req.body.name });
    await newItem.save();
    
    console.log(`[POST /api/items] Successfully created item with ID: ${newItem._id}`);
    
    // Forgot to clean up temp file!
    // fs.unlinkSync(tempFile); 
    
    res.json(newItem);
  } catch (err) {
    // ENOSPC (no space left) will surface here when disk is full
    console.error(`[POST /api/items] ERROR: ${err.code} - ${err.message}`);
    if (err.code === 'ENOSPC') {
      console.error('[CRITICAL] No space left on device! Disk is full.');
      console.error('[CRITICAL] Check /app/logs and /app/temp directories');
    }
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
  console.log(`[INIT] Log directory: ${LOG_DIR}`);
  console.log(`[INIT] Temp directory: ${TEMP_DIR}`);
  console.log('[INIT] Application ready - audit logging enabled');
});
