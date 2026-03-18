const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const config = require('./config.json');
const db = require('./db');

// Initialize database (async for sql.js) then start server
async function startServer() {
  await db.init();
  console.log('Database initialized');

  const PORT = config.port || 8080;
  app.listen(PORT, () => {
    console.log(`Amazon Parser server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error('Failed to start:', err);
  process.exit(1);
});

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Serve images
app.use('/images', express.static(path.resolve(__dirname, config.paths.images)));

// Upload config
const uploadDir = path.resolve(__dirname, config.paths.uploads);
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

// Ensure other directories exist
const imagesDir = path.resolve(__dirname, config.paths.images);
const logsDir = path.resolve(__dirname, config.paths.logs);
if (!fs.existsSync(imagesDir)) fs.mkdirSync(imagesDir, { recursive: true });
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

// --------------- Auth middleware ---------------

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.startsWith('Bearer ')
    ? authHeader.split(' ')[1]
    : null;

  if (!token) {
    return res.status(401).json({ error: 'No token provided' });
  }

  try {
    req.user = jwt.verify(token, config.jwtSecret);
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// --------------- Auth ---------------

// POST /api/auth/login
app.post('/api/auth/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }

    const user = db.getUserByUsername(username);
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const valid = bcrypt.compareSync(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: user.id, username: user.username },
      config.jwtSecret,
      { expiresIn: '24h' }
    );

    res.json({ token, username: user.username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Jobs ---------------

// GET /api/jobs
app.get('/api/jobs', authMiddleware, (req, res) => {
  try {
    const jobs = db.getJobs();
    res.json(jobs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs
app.post('/api/jobs', authMiddleware, (req, res) => {
  try {
    const { name, speed } = req.body;
    if (!name) {
      return res.status(400).json({ error: 'Job name is required' });
    }
    const job = db.createJob(name, null, 0, speed || config.defaultSpeed);
    res.status(201).json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id
app.get('/api/jobs/:id', authMiddleware, (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/jobs/:id
app.patch('/api/jobs/:id', authMiddleware, (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const { action, speed } = req.body;

    // Handle speed update
    if (speed !== undefined) {
      db.getDb().run('UPDATE jobs SET speed = ? WHERE id = ?', [speed, req.params.id]);
    }

    // Handle status actions
    if (action) {
      let newStatus;
      switch (action) {
        case 'start':
          newStatus = 'running';
          break;
        case 'pause':
          newStatus = 'paused';
          break;
        case 'stop':
          newStatus = 'stopped';
          break;
        default:
          return res.status(400).json({ error: 'Invalid action. Use: start, pause, stop' });
      }
      const updated = db.updateJobStatus(req.params.id, newStatus);
      return res.json(updated);
    }

    res.json(db.getJob(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/jobs/:id
app.delete('/api/jobs/:id', authMiddleware, (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    db.deleteJob(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Upload ---------------

// POST /api/jobs/:id/upload
app.post('/api/jobs/:id/upload', authMiddleware, upload.single('file'), (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    if (!data || data.length === 0) {
      return res.status(400).json({ error: 'Empty file' });
    }

    // Find SKU column: check if first row has "SKU" header
    let skuColIndex = 0;
    let minRetailQtyColIndex = -1;
    const header = data[0];
    if (Array.isArray(header)) {
      const skuIdx = header.findIndex(
        (h) => typeof h === 'string' && h.trim().toUpperCase() === 'SKU'
      );
      if (skuIdx >= 0) {
        skuColIndex = skuIdx;
      }

      // Find minRetailQty column (case-insensitive search)
      const qtyIdx = header.findIndex(
        (h) => typeof h === 'string' && h.trim().toLowerCase().replace(/[\s_-]/g, '') === 'minretailqty'
      );
      if (qtyIdx >= 0) {
        minRetailQtyColIndex = qtyIdx;
      }
    }

    // Determine start row: skip header if "SKU" column was found by name
    const startRow = skuColIndex > 0 || (typeof header[0] === 'string' && header[0].trim().toUpperCase() === 'SKU') ? 1 : 0;

    const items = [];
    for (let i = startRow; i < data.length; i++) {
      const row = data[i];
      if (row && row[skuColIndex] !== undefined && row[skuColIndex] !== null && String(row[skuColIndex]).trim() !== '') {
        const sku = String(row[skuColIndex]).trim();
        let minRetailQty = null;
        if (minRetailQtyColIndex >= 0 && row[minRetailQtyColIndex] !== undefined && row[minRetailQtyColIndex] !== null) {
          const parsed = parseInt(row[minRetailQtyColIndex]);
          if (!isNaN(parsed)) {
            minRetailQty = parsed;
          }
        }
        items.push({ sku, minRetailQty });
      }
    }

    if (items.length === 0) {
      return res.status(400).json({ error: 'No SKUs found in the file' });
    }

    // Save source file reference
    db.getDb().run('UPDATE jobs SET source_file = ? WHERE id = ?', [req.file.originalname, req.params.id]);

    // Add items to queue
    const result = db.addItems(req.params.id, items);

    // Clean up uploaded file
    try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }

    res.json({
      success: true,
      filename: req.file.originalname,
      skus_found: items.length,
      ...result
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/jobs/:id/add-skus — add SKUs from text input
app.post('/api/jobs/:id/add-skus', authMiddleware, (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) return res.status(404).json({ error: 'Job not found' });

    const { items } = req.body;
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'No SKUs provided' });
    }

    // Validate and clean
    const cleanItems = items
      .filter(i => i && i.sku && String(i.sku).trim())
      .map(i => ({
        sku: String(i.sku).trim(),
        minRetailQty: i.minRetailQty ? parseInt(i.minRetailQty) || null : null
      }));

    if (cleanItems.length === 0) {
      return res.status(400).json({ error: 'No valid SKUs found' });
    }

    const result = db.addItems(req.params.id, cleanItems);
    res.json({ success: true, added: cleanItems.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Items ---------------

// GET /api/jobs/:id/items
app.get('/api/jobs/:id/items', authMiddleware, (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 50;
    const result = db.getItems(req.params.id, page, limit);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/jobs/:id/items/:itemId
app.get('/api/jobs/:id/items/:itemId', authMiddleware, (req, res) => {
  try {
    const item = db.getItem(req.params.itemId);
    if (!item || item.job_id !== parseInt(req.params.id)) {
      return res.status(404).json({ error: 'Item not found' });
    }
    res.json(item);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Export ---------------

// GET /api/jobs/:id/export
app.get('/api/jobs/:id/export', authMiddleware, async (req, res) => {
  try {
    const job = db.getJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    // Get all items for this job
    const items = db.getItems(req.params.id, 1, 100000).items;

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'Amazon Parser';
    workbook.created = new Date();

    const sheet = workbook.addWorksheet('Results');

    // Define columns
    sheet.columns = [
      { header: 'SKU', key: 'sku', width: 18 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Zoro Brand', key: 'zoro_brand', width: 18 },
      { header: 'Zoro MFR No', key: 'zoro_mfr_no', width: 18 },
      { header: 'Zoro UPC', key: 'zoro_upc', width: 18 },
      { header: 'Zoro Title', key: 'zoro_title', width: 40 },
      { header: 'Zoro Price', key: 'zoro_price', width: 12 },
      { header: 'Zoro Qty', key: 'zoro_qty', width: 10 },
      { header: 'Zoro Image', key: 'zoro_image_main', width: 30 },
      { header: 'Zoro URL', key: 'zoro_url', width: 40 },
      { header: 'ASIN', key: 'asin', width: 14 },
      { header: 'Amazon Title', key: 'amazon_title', width: 40 },
      { header: 'Amazon Price', key: 'amazon_price', width: 12 },
      { header: 'Amazon Seller', key: 'amazon_seller', width: 20 },
      { header: 'Amazon Qty', key: 'amazon_qty', width: 10 },
      { header: 'Amazon Rating', key: 'amazon_rating', width: 12 },
      { header: 'Amazon Reviews', key: 'amazon_review_count', width: 14 },
      { header: 'Amazon BSR', key: 'amazon_bsr', width: 14 },
      { header: 'Amazon Weight', key: 'amazon_weight', width: 14 },
      { header: 'Amazon Dimensions', key: 'amazon_dimensions', width: 20 },
      { header: 'Amazon Image', key: 'amazon_image_main', width: 30 },
      { header: 'Amazon URL', key: 'amazon_url', width: 40 },
      { header: 'Competitor Amazon', key: 'competitor_amazon', width: 18 },
      { header: 'Seller is Brand', key: 'seller_is_brand', width: 14 },
      { header: 'Is Oversized', key: 'is_oversized', width: 12 },
      { header: 'Is Minority Owned', key: 'is_minority_owned', width: 16 },
      { header: 'Margin %', key: 'margin_percent', width: 10 },
      { header: 'Recommendation', key: 'recommendation', width: 18 },
      { header: 'AI Model', key: 'ai_model', width: 14 },
      { header: 'AI Photo Match', key: 'ai_photo_match', width: 14 },
      { header: 'AI Analysis', key: 'ai_analysis', width: 40 },
      { header: 'AI Recommendation', key: 'ai_recommendation_reason', width: 40 },
      { header: 'Error', key: 'error_message', width: 30 },
    ];

    // Style header row
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF4472C4' }
    };
    sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };

    // Add data rows
    for (const item of items) {
      sheet.addRow({
        sku: item.sku,
        status: item.status,
        zoro_brand: item.zoro_brand,
        zoro_mfr_no: item.zoro_mfr_no,
        zoro_upc: item.zoro_upc,
        zoro_title: item.zoro_title,
        zoro_price: item.zoro_price,
        zoro_qty: item.zoro_qty,
        zoro_image_main: item.zoro_image_main,
        zoro_url: item.zoro_url,
        asin: item.asin,
        amazon_title: item.amazon_title,
        amazon_price: item.amazon_price,
        amazon_seller: item.amazon_seller,
        amazon_qty: item.amazon_qty,
        amazon_rating: item.amazon_rating,
        amazon_review_count: item.amazon_review_count,
        amazon_bsr: item.amazon_bsr,
        amazon_weight: item.amazon_weight,
        amazon_dimensions: item.amazon_dimensions,
        amazon_image_main: item.amazon_image_main,
        amazon_url: item.amazon_url,
        competitor_amazon: item.competitor_amazon,
        seller_is_brand: item.seller_is_brand,
        is_oversized: item.is_oversized,
        is_minority_owned: item.is_minority_owned,
        margin_percent: item.margin_percent,
        recommendation: item.recommendation,
        ai_model: item.ai_model,
        ai_photo_match: item.ai_photo_match,
        ai_analysis: item.ai_analysis,
        ai_recommendation_reason: item.ai_recommendation_reason,
        error_message: item.error_message,
      });
    }

    // Send file
    const filename = `${job.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_export_${Date.now()}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Stats ---------------

// GET /api/stats
app.get('/api/stats', authMiddleware, (req, res) => {
  try {
    const stats = db.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Browser Status ---------------

// GET /api/status/browser
app.get('/api/status/browser', authMiddleware, async (req, res) => {
  try {
    const { chromium } = require('playwright');
    let browserStatus = { chrome: false, sellerCentral: false, url: '', error: null };

    let browser = null;
    try {
      browser = await chromium.connectOverCDP(config.cdpEndpoint, { timeout: 5000 });
      browserStatus.chrome = true;

      const ctx = browser.contexts()[0];
      if (ctx) {
        const pages = ctx.pages();
        for (const page of pages) {
          const url = page.url();
          if (url.includes('sellercentral.amazon.com')) {
            browserStatus.url = url;
            // Check if we're on a login/auth page
            const isLoginPage = url.includes('/ap/signin') || url.includes('/ap/widget') || url.includes('/authorization/');
            browserStatus.sellerCentral = !isLoginPage;
            break;
          }
        }
      }
    } catch (err) {
      browserStatus.error = err.message;
    } finally {
      if (browser) {
        try { await browser.close(); } catch(e) {}
      }
    }

    res.json(browserStatus);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --------------- Admin API ---------------

const { exec, spawn } = require('child_process');
const os = require('os');

// Track server start time
const serverStartTime = Date.now();

// GET /api/admin/status — system info
app.get('/api/admin/status', authMiddleware, async (req, res) => {
  try {
    const dbPath = path.resolve(__dirname, config.paths.db);
    let dbSize = 0;
    try { dbSize = fs.statSync(dbPath).size; } catch (e) {}

    const logsDir = path.resolve(__dirname, config.paths.logs);
    let logFiles = [];
    try {
      logFiles = fs.readdirSync(logsDir)
        .filter(f => f.endsWith('.log'))
        .sort()
        .reverse()
        .slice(0, 10);
    } catch (e) {}

    // Check if worker.js is running (look for node process with worker.js)
    let workerRunning = false;
    try {
      const isWin = os.platform() === 'win32';
      const cmd = isWin
        ? 'tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH'
        : 'ps aux | grep "node worker.js" | grep -v grep';
      const result = require('child_process').execSync(cmd, { encoding: 'utf8', timeout: 5000 });
      workerRunning = isWin
        ? result.includes('node.exe') // approximation; will refine with PID file
        : result.trim().length > 0;
    } catch (e) {}

    // Check worker PID file
    const pidFile = path.resolve(__dirname, 'worker.pid');
    let workerPid = null;
    try {
      workerPid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
      // Verify PID is still alive
      try { process.kill(workerPid, 0); } catch (e) { workerPid = null; }
    } catch (e) {}

    res.json({
      server: {
        uptime: Math.floor((Date.now() - serverStartTime) / 1000),
        uptimeStr: formatUptime(Date.now() - serverStartTime),
        pid: process.pid,
        nodeVersion: process.version,
        platform: os.platform(),
        hostname: os.hostname(),
        cwd: process.cwd(),
      },
      memory: {
        total: os.totalmem(),
        free: os.freemem(),
        used: os.totalmem() - os.freemem(),
        processRss: process.memoryUsage().rss,
      },
      db: {
        path: dbPath,
        size: dbSize,
        sizeStr: formatBytes(dbSize),
      },
      worker: {
        pid: workerPid,
        running: workerPid !== null,
      },
      config: {
        port: config.port,
        cdpEndpoint: config.cdpEndpoint,
        defaultSpeed: config.defaultSpeed,
      },
      logFiles,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/admin/logs?file=parser-2026-03-18.log&lines=200
app.get('/api/admin/logs', authMiddleware, (req, res) => {
  try {
    const logsDir = path.resolve(__dirname, config.paths.logs);
    const fileName = req.query.file || '';
    const lines = parseInt(req.query.lines) || 200;

    if (!fileName) {
      // Return list of log files
      let files = [];
      try {
        files = fs.readdirSync(logsDir)
          .filter(f => f.endsWith('.log'))
          .map(f => {
            const stat = fs.statSync(path.join(logsDir, f));
            return { name: f, size: stat.size, sizeStr: formatBytes(stat.size), modified: stat.mtime };
          })
          .sort((a, b) => new Date(b.modified) - new Date(a.modified));
      } catch (e) {}
      return res.json({ files });
    }

    // Sanitize filename
    const safe = path.basename(fileName);
    const filePath = path.join(logsDir, safe);
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'Log file not found' });
    }

    const content = fs.readFileSync(filePath, 'utf8');
    const allLines = content.split('\n');
    const tail = allLines.slice(-lines).join('\n');

    res.json({ file: safe, totalLines: allLines.length, lines: tail });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/admin/command — execute predefined commands
app.post('/api/admin/command', authMiddleware, (req, res) => {
  const { command } = req.body;
  const isWin = os.platform() === 'win32';

  const commands = {
    'start-worker': () => {
      const pidFile = path.resolve(__dirname, 'worker.pid');
      // Check if already running
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        process.kill(pid, 0); // throws if not running
        return { success: false, message: 'Worker already running (PID: ' + pid + ')' };
      } catch (e) {}

      // Start worker as detached process
      const workerPath = path.resolve(__dirname, 'worker.js');
      const logFile = path.resolve(__dirname, config.paths.logs, 'worker-stdout.log');
      const out = fs.openSync(logFile, 'a');
      const err = fs.openSync(logFile, 'a');
      const child = spawn('node', [workerPath], {
        detached: true,
        stdio: ['ignore', out, err],
        cwd: __dirname,
      });
      child.unref();
      fs.writeFileSync(pidFile, String(child.pid));
      return { success: true, message: 'Worker started (PID: ' + child.pid + ')' };
    },

    'stop-worker': () => {
      const pidFile = path.resolve(__dirname, 'worker.pid');
      try {
        const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim());
        if (isWin) {
          require('child_process').execSync(`taskkill /PID ${pid} /F`, { timeout: 5000 });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        try { fs.unlinkSync(pidFile); } catch (e) {}
        return { success: true, message: 'Worker stopped (PID: ' + pid + ')' };
      } catch (e) {
        try { fs.unlinkSync(pidFile); } catch (e2) {}
        return { success: false, message: 'Worker not running or already stopped' };
      }
    },

    'start-chrome': () => {
      if (isWin) {
        const chromeCmd = `start "" "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir=C:\\chrome-parser-profile --no-first-run`;
        exec(chromeCmd, { shell: 'cmd.exe' });
        return { success: true, message: 'Chrome start command sent' };
      }
      return { success: false, message: 'Chrome start only available on Windows VPS' };
    },

    'stop-chrome': () => {
      if (isWin) {
        try {
          require('child_process').execSync('taskkill /IM chrome.exe /F', { timeout: 5000 });
          return { success: true, message: 'Chrome processes killed' };
        } catch (e) {
          return { success: false, message: 'No Chrome processes found' };
        }
      }
      return { success: false, message: 'Chrome stop only available on Windows VPS' };
    },

    'db-backup': () => {
      const dbPath = path.resolve(__dirname, config.paths.db);
      if (!fs.existsSync(dbPath)) {
        return { success: false, message: 'Database file not found' };
      }
      db.saveToDisk();
      const backupName = `parser-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
      const backupPath = path.resolve(__dirname, backupName);
      fs.copyFileSync(dbPath, backupPath);
      return { success: true, message: 'Backup created: ' + backupName };
    },

    'clear-logs': () => {
      const logsDir = path.resolve(__dirname, config.paths.logs);
      try {
        const files = fs.readdirSync(logsDir).filter(f => f.endsWith('.log'));
        let deleted = 0;
        for (const f of files) {
          // Keep today's log
          const today = new Date().toISOString().split('T')[0];
          if (!f.includes(today)) {
            fs.unlinkSync(path.join(logsDir, f));
            deleted++;
          }
        }
        return { success: true, message: `Deleted ${deleted} old log files` };
      } catch (e) {
        return { success: false, message: e.message };
      }
    },

    'save-db': () => {
      db.saveToDisk();
      return { success: true, message: 'Database saved to disk' };
    },
  };

  if (!command || !commands[command]) {
    return res.status(400).json({
      error: 'Invalid command. Available: ' + Object.keys(commands).join(', ')
    });
  }

  try {
    const result = commands[command]();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Helper functions
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// --------------- SPA fallback ---------------

app.get('*', (req, res) => {
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// --------------- Start is handled by startServer() above ---------------
