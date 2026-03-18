const Database = require('better-sqlite3');
const path = require('path');
const config = require('./config.json');

const dbPath = path.resolve(__dirname, config.paths.db);
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// --------------- Schema ---------------

function init() {
  db.exec(`
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
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(config.defaultUser.username);
  if (!existing) {
    const hash = bcrypt.hashSync(config.defaultUser.password, 10);
    db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(config.defaultUser.username, hash);
  }
}

// --------------- Jobs CRUD ---------------

function createJob(name, sourceFile, totalItems, speed) {
  const stmt = db.prepare(`
    INSERT INTO jobs (name, source_file, total_items, speed)
    VALUES (?, ?, ?, ?)
  `);
  const info = stmt.run(name, sourceFile || null, totalItems || 0, speed || config.defaultSpeed);
  return getJob(info.lastInsertRowid);
}

function getJobs() {
  return db.prepare(`
    SELECT j.*,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'done') AS parsed_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'error') AS error_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id) AS total_items
    FROM jobs j
    ORDER BY j.created_at DESC
  `).all();
}

function getJob(id) {
  const job = db.prepare(`
    SELECT j.*,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'done') AS parsed_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id AND status = 'error') AS error_items,
      (SELECT COUNT(*) FROM queue WHERE job_id = j.id) AS total_items
    FROM jobs j
    WHERE j.id = ?
  `).get(id);
  return job || null;
}

function updateJobStatus(id, status) {
  const updates = { status };
  if (status === 'running') {
    updates.started_at = new Date().toISOString();
  }
  if (status === 'done' || status === 'stopped') {
    updates.finished_at = new Date().toISOString();
  }

  const setClauses = Object.keys(updates).map(k => `${k} = ?`).join(', ');
  const values = Object.values(updates);
  values.push(id);

  db.prepare(`UPDATE jobs SET ${setClauses} WHERE id = ?`).run(...values);
  return getJob(id);
}

function deleteJob(id) {
  const deleteItems = db.prepare('DELETE FROM queue WHERE job_id = ?');
  const deleteJobStmt = db.prepare('DELETE FROM jobs WHERE id = ?');

  const transaction = db.transaction(() => {
    deleteItems.run(id);
    deleteJobStmt.run(id);
  });
  transaction();
}

// --------------- Queue CRUD ---------------

function addItems(jobId, skus) {
  const stmt = db.prepare(`
    INSERT INTO queue (job_id, sku) VALUES (?, ?)
  `);

  const transaction = db.transaction((items) => {
    for (const sku of items) {
      stmt.run(jobId, sku);
    }
    // Update total_items count on the job
    const count = db.prepare('SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ?').get(jobId).cnt;
    db.prepare('UPDATE jobs SET total_items = ? WHERE id = ?').run(count, jobId);
  });

  transaction(skus);
  return { added: skus.length };
}

function getItems(jobId, page, limit) {
  page = page || 1;
  limit = limit || 50;
  const offset = (page - 1) * limit;

  const items = db.prepare(`
    SELECT * FROM queue WHERE job_id = ? ORDER BY id ASC LIMIT ? OFFSET ?
  `).all(jobId, limit, offset);

  const total = db.prepare('SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ?').get(jobId).cnt;

  return {
    items,
    total,
    page,
    limit,
    pages: Math.ceil(total / limit)
  };
}

function getItem(itemId) {
  return db.prepare('SELECT * FROM queue WHERE id = ?').get(itemId) || null;
}

function getNextPending(jobId) {
  return db.prepare(`
    SELECT * FROM queue
    WHERE job_id = ? AND status = 'pending'
    ORDER BY id ASC
    LIMIT 1
  `).get(jobId) || null;
}

function updateItem(itemId, data) {
  if (!data || Object.keys(data).length === 0) return getItem(itemId);

  // Always update updated_at
  data.updated_at = new Date().toISOString();

  const keys = Object.keys(data);
  const setClauses = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => data[k]);
  values.push(itemId);

  db.prepare(`UPDATE queue SET ${setClauses} WHERE id = ?`).run(...values);

  // Update job counters
  const item = getItem(itemId);
  if (item) {
    const parsed = db.prepare("SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ? AND status = 'done'").get(item.job_id).cnt;
    const errors = db.prepare("SELECT COUNT(*) AS cnt FROM queue WHERE job_id = ? AND status = 'error'").get(item.job_id).cnt;
    db.prepare('UPDATE jobs SET parsed_items = ?, error_items = ? WHERE id = ?').run(parsed, errors, item.job_id);
  }

  return getItem(itemId);
}

// --------------- Stats ---------------

function getStats() {
  const totalJobs = db.prepare('SELECT COUNT(*) AS cnt FROM jobs').get().cnt;
  const activeJobs = db.prepare("SELECT COUNT(*) AS cnt FROM jobs WHERE status = 'running'").get().cnt;
  const totalItems = db.prepare('SELECT COUNT(*) AS cnt FROM queue').get().cnt;
  const parsedItems = db.prepare("SELECT COUNT(*) AS cnt FROM queue WHERE status = 'done'").get().cnt;
  const errorItems = db.prepare("SELECT COUNT(*) AS cnt FROM queue WHERE status = 'error'").get().cnt;
  const pendingItems = db.prepare("SELECT COUNT(*) AS cnt FROM queue WHERE status = 'pending'").get().cnt;

  return {
    totalJobs,
    activeJobs,
    totalItems,
    parsedItems,
    errorItems,
    pendingItems
  };
}

module.exports = {
  db,
  init,
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
  getStats
};
