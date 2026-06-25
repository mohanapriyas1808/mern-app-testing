require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 5000;

// Gorge tuning — controllable via env vars (set in docker-compose)
const GORGE_CHUNK_MB   = parseInt(process.env.GORGE_CHUNK_MB   || '10',   10);
const GORGE_INTERVAL_MS = parseInt(process.env.GORGE_INTERVAL_MS || '5000', 10);

app.use(cors());
app.use(express.json());

const mongoURI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/mern-docker-deploy';
mongoose.connect(mongoURI)
  .then(() => console.log('Connected to MongoDB'))
  .catch((err) => console.log(err));

const itemSchema = new mongoose.Schema({ name: String });
const Item = mongoose.model('Item', itemSchema);

// ── Directories ──────────────────────────────────────────────────────────────
// Both paths are backed by named Docker volumes on the HOST filesystem.
// Writes here increment the real host partition (node_exporter reports this),
// which is what triggers the Prometheus HighDiskUtilization alert.
const LOG_DIR  = '/app/logs';
const TEMP_DIR = '/app/temp';

[LOG_DIR, TEMP_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[INIT] Created directory: ${dir}`);
  }
});

// ── Helper: get df stats for a path ─────────────────────────────────────────
function getDiskStats(dir) {
  try {
    // df -k outputs 1 KB blocks; parse the last matching line
    const out = execSync(`df -k "${dir}" 2>/dev/null | tail -1`, { encoding: 'utf8' }).trim();
    const [, total, used, avail, pct] = out.split(/\s+/);
    return {
      path:       dir,
      total_mb:   Math.round(parseInt(total,  10) / 1024),
      used_mb:    Math.round(parseInt(used,   10) / 1024),
      avail_mb:   Math.round(parseInt(avail,  10) / 1024),
      used_pct:   pct,
    };
  } catch {
    return { path: dir, error: 'unavailable' };
  }
}

// ── Background gorge ─────────────────────────────────────────────────────────
// Writes GORGE_CHUNK_MB every GORGE_INTERVAL_MS to /app/logs/gorge.bin.
// Because /app/logs is a real host-backed volume, this grows the host partition
// that node_exporter monitors — no HTTP traffic required to trigger the alert.
let gorgeSeq = 0;
function backgroundGorge() {
  const gorgeFile = path.join(LOG_DIR, 'gorge.bin');
  try {
    const chunk = Buffer.alloc(GORGE_CHUNK_MB * 1024 * 1024, gorgeSeq % 256);
    fs.appendFileSync(gorgeFile, chunk);
    gorgeSeq++;

    const stats    = fs.statSync(gorgeFile);
    const sizeMB   = (stats.size / (1024 * 1024)).toFixed(1);
    const diskInfo = getDiskStats(LOG_DIR);
    console.log(
      `[GORGE] gorge.bin = ${sizeMB} MB written | ` +
      `disk ${diskInfo.used_mb}/${diskInfo.total_mb} MB (${diskInfo.used_pct})`
    );
  } catch (err) {
    if (err.code === 'ENOSPC') {
      console.error('[GORGE] *** ENOSPC — host disk is FULL. Gorge stopping. ***');
      // Stop gorging once full — the disk pressure is now sustained
      return;
    }
    console.error(`[GORGE] Unexpected error: ${err.message}`);
  }
  // Schedule next run only if we haven't hit ENOSPC
  setTimeout(backgroundGorge, GORGE_INTERVAL_MS);
}

// Start gorging after a short warm-up delay so the server is ready first
setTimeout(backgroundGorge, 3000);
console.log(`[INIT] Background gorge started — ${GORGE_CHUNK_MB} MB every ${GORGE_INTERVAL_MS} ms → ${LOG_DIR}`);

// ── Middleware: log flooding ──────────────────────────────────────────────────
// Appends ~100 KB per request to audit.log (no rotation).
// Accelerates disk fill when traffic is sent alongside the background gorge.
app.use((req, res, next) => {
  const logFile  = path.join(LOG_DIR, 'audit.log');
  const timestamp = new Date().toISOString();

  try {
    const auditEntry = {
      timestamp,
      method:        req.method,
      url:           req.url,
      headers:       req.headers,
      ip:            req.ip,
      // ~100 KB padding per entry — simulates verbose request/response bodies
      verbose_trace: 'TRACE: ' + 'x'.repeat(100_000),
    };
    fs.appendFileSync(logFile, JSON.stringify(auditEntry) + '\n');

    // Sample log size so growth is visible without flooding stdout
    if (Math.random() < 0.2) {
      const sizeMB = (fs.statSync(logFile).size / (1024 * 1024)).toFixed(2);
      console.log(`[AUDIT] audit.log = ${sizeMB} MB`);
    }
  } catch (err) {
    if (err.code === 'ENOSPC') {
      console.error('[AUDIT] *** ENOSPC — cannot write audit log. Host disk full. ***');
    }
    // Don't block the request — let it reach the route handler so the
    // DB write also fails with ENOSPC (double failure, realistic scenario)
  }
  next();
});

// ── GET /api/disk-status ─────────────────────────────────────────────────────
// Diagnostic endpoint — real-time disk usage for both host-backed volumes.
app.get('/api/disk-status', (req, res) => {
  const logStats  = getDiskStats(LOG_DIR);
  const tempStats = getDiskStats(TEMP_DIR);

  let auditLogMB  = 0;
  let gorgeFileMB = 0;
  let tempFileCount = 0;
  let tempTotalMB   = 0;

  try {
    const auditPath = path.join(LOG_DIR, 'audit.log');
    if (fs.existsSync(auditPath))
      auditLogMB = (fs.statSync(auditPath).size / (1024 * 1024)).toFixed(2);

    const gorgePath = path.join(LOG_DIR, 'gorge.bin');
    if (fs.existsSync(gorgePath))
      gorgeFileMB = (fs.statSync(gorgePath).size / (1024 * 1024)).toFixed(2);

    const tempFiles = fs.readdirSync(TEMP_DIR).filter(f => f.startsWith('temp_'));
    tempFileCount = tempFiles.length;
    tempTotalMB   = tempFiles
      .reduce((sum, f) => {
        try { return sum + fs.statSync(path.join(TEMP_DIR, f)).size; } catch { return sum; }
      }, 0);
    tempTotalMB = (tempTotalMB / (1024 * 1024)).toFixed(2);
  } catch { /* best-effort */ }

  res.json({
    logs_volume:  logStats,
    temp_volume:  tempStats,
    files: {
      'audit.log_mb':  parseFloat(auditLogMB),
      'gorge.bin_mb':  parseFloat(gorgeFileMB),
      temp_file_count: tempFileCount,
      temp_total_mb:   parseFloat(tempTotalMB),
    },
    gorge_config: {
      chunk_mb:    GORGE_CHUNK_MB,
      interval_ms: GORGE_INTERVAL_MS,
    },
  });
});

// ── GET /api/items ───────────────────────────────────────────────────────────
app.get('/api/items', async (req, res) => {
  try {
    console.log('[GET /api/items] Fetching items');
    const items = await Item.find();
    console.log(`[GET /api/items] ${items.length} items returned`);
    res.json(items);
  } catch (err) {
    console.error(`[GET /api/items] ERROR: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/items ──────────────────────────────────────────────────────────
app.post('/api/items', async (req, res) => {
  try {
    console.log(`[POST /api/items] name=${req.body.name}`);

    // ── Temp file leak: 5 MB file created per POST, never deleted ────────────
    const tempFile = path.join(TEMP_DIR, `temp_${Date.now()}_${Math.random()}.dat`);
    fs.writeFileSync(tempFile, Buffer.alloc(5 * 1024 * 1024));
    // Intentionally NOT calling fs.unlinkSync(tempFile) ← the bug

    const tempCount = fs.readdirSync(TEMP_DIR).length;
    if (tempCount % 5 === 0)
      console.log(`[TEMP] ${tempCount} orphaned temp files in ${TEMP_DIR}`);

    const newItem = new Item({ name: req.body.name });
    await newItem.save();

    console.log(`[POST /api/items] Created _id=${newItem._id}`);
    res.json(newItem);
  } catch (err) {
    console.error(`[POST /api/items] ERROR: ${err.code} - ${err.message}`);
    if (err.code === 'ENOSPC') {
      console.error('[CRITICAL] ENOSPC on POST — host disk is full.');
      console.error('[CRITICAL] Run: docker exec <container> df -h /app/logs /app/temp');
      console.error('[CRITICAL] On host: df -h /var/lib/docker');
      res.status(507).json({
        error:   'Insufficient Storage',
        code:    'ENOSPC',
        message: 'Host disk full — check /app/logs and /app/temp (fault_disk_logs / fault_disk_temp volumes)',
      });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

// ── PUT /api/items/:id ───────────────────────────────────────────────────────
app.put('/api/items/:id', async (req, res) => {
  try {
    const updatedItem = await Item.findByIdAndUpdate(
      req.params.id, { name: req.body.name }, { new: true }
    );
    res.json(updatedItem);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/items/:id ────────────────────────────────────────────────────
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
  console.log(`[INIT] Log dir : ${LOG_DIR}  (host volume: fault_disk_logs)`);
  console.log(`[INIT] Temp dir: ${TEMP_DIR} (host volume: fault_disk_temp)`);
  console.log('[INIT] Disk pressure fault scenario active');
});
