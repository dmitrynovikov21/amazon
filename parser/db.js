const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const config = require('./config.json');

const dbPath = path.resolve(__dirname, config.paths.db);

let db = null;

// Auto-save to disk every 5 seconds if there are changes
let dirty = false;
setInterval(() => {
  if (dirty && db) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    dirty = false;
  }
}, 5000);

function save() {
  dirty = true;
}

function saveToDisk() {
  if (db) {
    const data = db.export();
    fs.writeFileSync(dbPath, Buffer.from(data));
    dirty = false;
  }
}

// --------------- Init ---------------

async function init() {
  const SQL = await initSqlJs();

  // Load existing DB or create new
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      total_items INTEGER DEFAULT 0,
      parsed_items INTEGER DEFAULT 0,
      error_items INTEGER DEFAULT 0,
      speed INTEGER DEFAULT 50,
      source_file TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      sku TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      zoro_brand TEXT, zoro_mfr_no TEXT, zoro_upc TEXT,
      zoro_title TEXT, zoro_price REAL, zoro_qty TEXT,
      zoro_image_main TEXT, zoro_url TEXT,
      asin TEXT, amazon_title TEXT, amazon_price REAL,
      amazon_seller TEXT, amazon_qty TEXT,
      amazon_rating REAL, amazon_review_count INTEGER,
      amazon_bsr TEXT, amazon_weight TEXT, amazon_dimensions TEXT,
      amazon_image_main TEXT, amazon_url TEXT,
      competitor_amazon TEXT, seller_is_brand TEXT,
      is_oversized TEXT, is_minority_owned TEXT,
      margin_percent REAL, recommendation TEXT,
      ai_model TEXT, ai_photo_match TEXT,
      ai_analysis TEXT, ai_recommendation_reason TEXT,
      retries INTEGER DEFAULT 0, error_message TEXT,
      log TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_queue_status ON queue(status);
    CREATE INDEX IF NOT EXISTS idx_queue_job ON queue(job_id);
  `);

  // Create default user if not exists
  const bcrypt = require('bcryptjs');
  const existing = db.exec('SELECT id FROM users WHERE username = ?', [config.defaultUser.username]);
  if (!existing.length || !existing[0].values.length) {
    const hash = bcrypt.hashSync(config.defaultUser.password, 10);
    db.run('INSERT INTO users (username, password_hash) VALUES (?, ?)', [config.defaultUser.username, hash]);
  }

  saveToDisk();
}

// --------------- Helpers ---------------

function queryOne(sql, params) {
  const result = db.exec(sql, params || []);
  if (!result.length || !result[0].values.length) return null;
  const cols = result[0].columns;
  const vals = result[0].values[0];
  const obj = {};
  cols.forEach((c, i) => { obj[c] = vals[i]; });
  return obj;
}

function queryAll(sql, params) {
  const result = db.exec(sql, params || []);
  if (!result.length) return [];
  const cols = result[0].columns;
  return result[0].values.map(vals => {
    const obj = {};
    cols.forEach((c, i) => { obj[c] = vals[i]; });
    return obj;
  });
}

function runSql(sql, params) {
  db.run(sql, params || []);
  save();
}

function getLastInsertRowId() {
  const r = db.exec('SELECT last_insert_rowid() AS id');
  return r[0].values[0][0];
}

// --------------- Jobs CRUD ---------------

function createJob(name, sourceFile, totalItems, speed) {
  runSql(
    'INSERT INTO jobs (name, source_file, total_items, speed) VALUES (?, ?, ?, ?)',
    [name, sourceFile || null, totalItems || 0, speed || config.defaultSpeed]
  );
  const id = getLastInsertRowId();
  return getJob(id);
}

function getJobs() {
  return queryAll(`
    SELECT j.*,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'done') AS parsed_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'error') AS error_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id) AS total_items
    FROM jobs j
    ORDER BY j.created_at DESC
  `);
}

function getJob(id) {
  return queryOne(`
    SELECT j.*,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'done') AS parsed_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'error') AS error_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id) AS total_items
    FROM jobs j
    WHERE j.id = ?
  `, [id]);
}

function updateJobStatus(id, status) {
  if (status === 'running') {
    runSql('UPDATE jobs SET status = ?, started_at = ? WHERE id = ?', [status, new Date().toISOString(), id]);
  } else if (status === 'done' || status === 'stopped') {
    runSql('UPDATE jobs SET status = ?, finished_at = ? WHERE id = ?', [status, new Date().toISOString(), id]);
  } else {
    runSql('UPDATE jobs SET status = ? WHERE id = ?', [status, id]);
  }
  return getJob(id);
}

function deleteJob(id) {
  runSql('DELETE FROM queue WHERE job_id = ?', [id]);
  runSql('DELETE FROM jobs WHERE id = ?', [id]);
}

// --------------- Queue CRUD ---------------

function addItems(jobId, skus) {
  for (const sku of skus) {
    runSql('INSERT INTO queue (job_id, sku) VALUES (?, ?)', [jobId, sku]);
  }
  const count = queryOne('SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ?', [jobId]).cnt;
  runSql('UPDATE jobs SET total_items = ? WHERE id = ?', [count, jobId]);
  saveToDisk();
  return { added: skus.length };
}

function getItems(jobId, page, limit) {
  page = page || 1;
  limit = limit || 50;
  const offset = (page - 1) * limit;

  const items = queryAll(
    'SELECT * FROM queue WHERE job_id = ? ORDER BY id ASC LIMIT ? OFFSET ?',
    [jobId, limit, offset]
  );

  const total = queryOne('SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ?', [jobId]).cnt;

  return {
    items,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit)
  };
}

function getItem(itemId) {
  return queryOne('SELECT * FROM queue WHERE id = ?', [itemId]);
}

function getNextPending(jobId) {
  return queryOne(
    "SELECT * FROM queue WHERE job_id = ? AND status = 'pending' ORDER BY id ASC LIMIT 1",
    [jobId]
  );
}

function updateItem(itemId, data) {
  if (!data || Object.keys(data).length === 0) return getItem(itemId);

  data.updated_at = new Date().toISOString();

  const keys = Object.keys(data);
  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => data[k]);
  values.push(itemId);

  runSql(`UPDATE queue SET ${setClauses} WHERE id = ?`, values);

  // Update job counters
  const item = getItem(itemId);
  if (item) {
    const parsed = queryOne("SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ? AND status = 'done'", [item.job_id]).cnt;
    const errors = queryOne("SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ? AND status = 'error'", [item.job_id]).cnt;
    runSql('UPDATE jobs SET parsed_items = ?, error_items = ? WHERE id = ?', [parsed, errors, item.job_id]);
  }

  return getItem(itemId);
}

// --------------- Stats ---------------

function getStats() {
  const totalJobs = queryOne('SELECT COUNT(*) AS cnt FROM jobs').cnt;
  const activeJobs = queryOne("SELECT COUNT(*) AS cnt FROM jobs WHERE status = 'running'").cnt;
  const totalItems = queryOne('SELECT COUNT(*) AS cnt FROM queue').cnt;
  const parsedItems = queryOne("SELECT COUNT(*) AS cnt FROM queue WHERE status = 'done'").cnt;
  const errorItems = queryOne("SELECT COUNT(*) AS cnt FROM queue WHERE status = 'error'").cnt;
  const pendingItems = queryOne("SELECT COUNT(*) AS cnt FROM queue WHERE status = 'pending'").cnt;

  return { totalJobs, activeJobs, totalItems, parsedItems, errorItems, pendingItems };
}

// --------------- User queries ---------------

function getUserByUsername(username) {
  return queryOne('SELECT * FROM users WHERE username = ?', [username]);
}

module.exports = {
  init,
  saveToDisk,
  createJob,
  getJobs,
  getJob,
  updateJobStatus,
  deleteJob,
  addItems,
  getItems,
  getItem,
  getNextPending,
  updateItem,
  getStats,
  getUserByUsername,
  getDb: () => db
};
