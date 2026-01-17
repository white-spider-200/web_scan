const fs = require('fs');
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const reportRoutes = require('./routes/report');
const { startScan, cancelScan } = require('./scanRunner');
const { runPreflight } = require('./modules/preflight');
const { ensureNodeValueUniqueness } = require('./modules/dbIntegrity');
const config = require('./config');
const { normalizeTarget, isValidTarget, isValidScanId } = require('./validators');

if (config.cors.allowAll) {
  console.warn('[config] CORS is set to allow all origins. Restrict this in production.');
}
if (config.pdf.allowNoSandbox) {
  console.warn('[config] PDF_ALLOW_NO_SANDBOX=true reduces sandboxing. Use only if required.');
}

const app = express();
const PORT = config.port;
const DB_PATH = path.resolve(__dirname, config.database.path);

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});

app.use(express.json({ limit: config.bodyLimit }));
app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (config.cors.allowAll) return cb(null, true);
    if (config.cors.origins.includes(origin)) return cb(null, true);
    return cb(new Error('CORS blocked'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));
// rate limiters are defined later after helper setup

// Open DB
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('Failed to open DB:', err.message);
    process.exit(1);
  }
  console.log('Connected to SQLite database.');
  try {
    db.configure('busyTimeout', config.database.timeout);
  } catch (e) {
    // ignore
  }
  db.run('PRAGMA foreign_keys = ON');
  ensureSchema();
  // Ensure websites/nodes/scans tables have the meta columns we expect, then detect header/tech column names
  ensureWebsiteColumns(() =>
    ensureNodeColumns(() =>
      ensureScansColumns(() =>
        ensureScanProgressTable(() =>
          ensureScanStagesTable(() =>
            ensureScanLogsTable(() =>
              backfillLegacyScans(() => {
                ensureNodeValueUniqueness({ db, dbPath: DB_PATH })
                  .then((r) => {
                    if (r && (r.migrated || r.created_unique_index)) {
                      console.log(`[db] node uniqueness ensured (deduped_groups=${r.deduped_groups}, deduped_nodes=${r.deduped_nodes})`);
                      if (r.backup_path) console.log(`[db] backup created at ${r.backup_path}`);
                    }
                  })
                  .catch((e) => {
                    console.error('[db] Failed to ensure node uniqueness:', e && e.message ? e.message : e);
                  })
                  .finally(() => detectSchemaColumns());
              })
            )
          )
        )
      )
    )
  );
});

// Detected column names (default to common names)
let headerKeyCol = 'header_key';
let headerValueCol = 'header_value';
let techCol = 'technology';

function detectSchemaColumns() {
  // Inspect node_headers
  db.all("PRAGMA table_info('node_headers')", (err, cols) => {
    if (!err && Array.isArray(cols)) {
      const names = cols.map(c => c.name);
      if (!names.includes('header_key') && names.includes('name')) headerKeyCol = 'name';
      if (!names.includes('header_value') && names.includes('value')) headerValueCol = 'value';
    }
  });

  // Inspect node_technologies
  db.all("PRAGMA table_info('node_technologies')", (err, cols) => {
    if (!err && Array.isArray(cols)) {
      const names = cols.map(c => c.name);
      if (!names.includes('technology') && names.includes('name')) techCol = 'name';
    }
  });
}

function ensureSchema() {
  // Create websites table
  db.run(`CREATE TABLE IF NOT EXISTS websites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    url TEXT UNIQUE,
    name TEXT
  )`);

  // Create nodes table
  db.run(`CREATE TABLE IF NOT EXISTS nodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    website_id INTEGER NOT NULL,
    value TEXT NOT NULL,
    type TEXT,
    status INTEGER,
    size INTEGER,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
  )`);

  // Create node_headers (use canonical columns)
  db.run(`CREATE TABLE IF NOT EXISTS node_headers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    header_key TEXT,
    header_value TEXT,
    name TEXT,
    value TEXT,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
  )`);

  // Create node_technologies
  db.run(`CREATE TABLE IF NOT EXISTS node_technologies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    technology TEXT,
    name TEXT,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
  )`);

  // Create node_vulnerabilities
  db.run(`CREATE TABLE IF NOT EXISTS node_vulnerabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id INTEGER NOT NULL,
    vulnerability TEXT,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
  )`);

  // Create node_relationships
  db.run(`CREATE TABLE IF NOT EXISTS node_relationships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_node_id INTEGER NOT NULL,
    target_node_id INTEGER NOT NULL,
    relationship_type TEXT,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    UNIQUE(source_node_id, target_node_id)
  )`);

  // Indexes
  db.run('CREATE INDEX IF NOT EXISTS idx_nodes_website_id ON nodes(website_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type)');
  db.run('CREATE INDEX IF NOT EXISTS idx_nodes_value ON nodes(value)');
  db.run('CREATE INDEX IF NOT EXISTS idx_node_rel_source ON node_relationships(source_node_id)');
  db.run('CREATE INDEX IF NOT EXISTS idx_node_rel_target ON node_relationships(target_node_id)');

  // Create scans table
  db.run(`CREATE TABLE IF NOT EXISTS scans (
    scan_id TEXT PRIMARY KEY,
    website_id INTEGER,
    target TEXT,
    started_at TEXT,
    finished_at TEXT,
    cancelled_at TEXT,
    last_update_at TEXT,
    status TEXT,
    options_json TEXT,
    error TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE SET NULL
  )`);
  db.run('CREATE INDEX IF NOT EXISTS idx_scans_target ON scans(target)');
}

function sendError(res, status, message, details) {
  const payload = { error: message };
  if (details) payload.details = details;
  return res.status(status).json(payload);
}

function createRateLimiter({ windowMs, max }) {
  const hits = new Map();
  return (req, res, next) => {
    const key = req.ip || 'unknown';
    const now = Date.now();
    const entry = hits.get(key);
    if (!entry || entry.resetAt <= now) {
      hits.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count += 1;
    if (entry.count > max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return sendError(res, 429, 'Too many requests');
    }
    return next();
  };
}

const apiLimiter = createRateLimiter(config.rateLimit);
const scanLimiter = createRateLimiter(config.scanRateLimit);
const reportLimiter = createRateLimiter(config.reportRateLimit);

app.use('/api', apiLimiter);
app.use('/websites', apiLimiter);
app.use('/nodes', apiLimiter);
app.use('/api/report', reportLimiter, reportRoutes);

app.get('/system/preflight', apiLimiter, async (req, res) => {
  try {
    const projectRoot = path.resolve(__dirname, '..');
    const dbPath = DB_PATH;
    const result = await runPreflight({ projectRoot, dbPath, db });
    res.json(result);
  } catch (err) {
    console.error('Preflight failed:', err && err.message ? err.message : err);
    sendError(res, 500, 'Preflight failed', err && err.message ? err.message : String(err));
  }
});

async function loadHeadersByWebsite(websiteId) {
  const query = `
    SELECT nh.node_id as node_id, ${headerKeyCol} as keycol, ${headerValueCol} as valcol
    FROM node_headers nh
    JOIN nodes n ON n.id = nh.node_id
    WHERE n.website_id = ?
  `;
  const rows = await new Promise((resolve) => {
    db.all(query, [websiteId], (err, hRows) => {
      if (err) return resolve([]);
      resolve(hRows || []);
    });
  });
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.node_id)) map.set(row.node_id, { obj: {}, list: [] });
    const entry = map.get(row.node_id);
    if (row.keycol != null) entry.obj[String(row.keycol)] = row.valcol == null ? '' : String(row.valcol);
    entry.list.push({ key: row.keycol, value: row.valcol });
  });
  return map;
}

async function loadTechnologiesByWebsite(websiteId) {
  const query = `
    SELECT nt.node_id as node_id, ${techCol} as techcol
    FROM node_technologies nt
    JOIN nodes n ON n.id = nt.node_id
    WHERE n.website_id = ?
  `;
  const rows = await new Promise((resolve) => {
    db.all(query, [websiteId], (err, tRows) => {
      if (err) return resolve([]);
      resolve(tRows || []);
    });
  });
  const map = new Map();
  rows.forEach((row) => {
    if (!map.has(row.node_id)) map.set(row.node_id, []);
    map.get(row.node_id).push(row.techcol);
  });
  return map;
}

function ensureScansColumns(cb) {
  db.all("PRAGMA table_info('scans')", (err, cols) => {
    if (err || !Array.isArray(cols)) return cb && cb();
    const names = cols.map(c => c.name);
    const adds = [];
    if (!names.includes('started_at')) adds.push('started_at TEXT');
    if (!names.includes('finished_at')) adds.push('finished_at TEXT');
    if (!names.includes('status')) adds.push('status TEXT');
    if (!names.includes('cancelled_at')) adds.push('cancelled_at TEXT');
    if (!names.includes('last_update_at')) adds.push('last_update_at TEXT');
    if (!names.includes('target')) adds.push('target TEXT');
    if (!names.includes('website_id')) adds.push('website_id INTEGER');
    if (!names.includes('options_json')) adds.push('options_json TEXT');
    if (!names.includes('error')) adds.push('error TEXT');

    const ensureIndexes = () => {
      if (names.includes('started_at') || adds.some(a => a.startsWith('started_at'))) {
        db.run('CREATE INDEX IF NOT EXISTS idx_scans_started_at ON scans(started_at)', () => {});
      }
    };

    if (adds.length === 0) {
      ensureIndexes();
      return cb && cb();
    }

    let i = 0;
    const next = () => {
      if (i >= adds.length) {
        ensureIndexes();
        return cb && cb();
      }
      const sql = `ALTER TABLE scans ADD COLUMN ${adds[i]}`;
      db.run(sql, (aErr) => {
        if (aErr && !/duplicate column/i.test(aErr.message)) console.error('Error adding column to scans:', aErr.message);
        i++; next();
      });
    };
    next();
  });
}

function ensureScanProgressTable(cb) {
  db.run(`CREATE TABLE IF NOT EXISTS scan_progress (
    scan_id TEXT PRIMARY KEY,
    status TEXT,
    message TEXT,
    stage TEXT,
    stage_label TEXT,
    current_target TEXT,
    log_tail TEXT,
    updated_at TEXT
  )`, (err) => {
    if (err) console.error('Error creating scan_progress table:', err.message);
    ensureScanProgressColumns(cb);
  });
}

function ensureScanStagesTable(cb) {
  db.run(`CREATE TABLE IF NOT EXISTS scan_stages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL,
    stage_key TEXT NOT NULL,
    label TEXT,
    status TEXT,
    started_at TEXT,
    finished_at TEXT,
    duration_seconds INTEGER,
    UNIQUE(scan_id, stage_key)
  )`, (err) => {
    if (err) console.error('Error creating scan_stages table:', err.message);
    db.run('CREATE INDEX IF NOT EXISTS idx_scan_stages_scan_id ON scan_stages(scan_id)', () => {
      if (cb) cb();
    });
  });
}

function ensureScanLogsTable(cb) {
  db.run(`CREATE TABLE IF NOT EXISTS scan_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL,
    ts TEXT,
    line TEXT
  )`, (err) => {
    if (err) console.error('Error creating scan_logs table:', err.message);
    db.run('CREATE INDEX IF NOT EXISTS idx_scan_logs_scan_id ON scan_logs(scan_id)', () => {
      if (cb) cb();
    });
  });
}

function ensureScanProgressColumns(cb) {
  db.all("PRAGMA table_info('scan_progress')", (err, cols) => {
    if (err || !Array.isArray(cols)) return cb && cb();
    const names = cols.map(c => c.name);
    const adds = [];
    if (!names.includes('stage')) adds.push('stage TEXT');
    if (!names.includes('stage_label')) adds.push('stage_label TEXT');
    if (!names.includes('current_target')) adds.push('current_target TEXT');
    if (!names.includes('log_tail')) adds.push('log_tail TEXT');
    if (adds.length === 0) return cb && cb();
    let i = 0;
    const next = () => {
      if (i >= adds.length) return cb && cb();
      const sql = `ALTER TABLE scan_progress ADD COLUMN ${adds[i]}`;
      db.run(sql, (aErr) => {
        if (aErr && !/duplicate column/i.test(aErr.message)) console.error('Error adding column to scan_progress:', aErr.message);
        i++; next();
      });
    };
    next();
  });
}

function backfillLegacyScans(cb) {
  db.all('SELECT id, url, scan_started_at, scan_finished_at FROM websites', [], (err, rows) => {
    if (err || !Array.isArray(rows)) return cb && cb();
    const inserts = rows.map(r => ({
      website_id: r.id,
      target: r.url,
      started_at: r.scan_started_at || null,
      finished_at: r.scan_finished_at || null,
      status: r.scan_finished_at ? 'completed' : (r.scan_started_at ? 'running' : 'completed'),
      scan_id: `legacy-${r.id}`
    }));
    if (!inserts.length) return cb && cb();
    let i = 0;
    const next = () => {
      if (i >= inserts.length) return cb && cb();
      const s = inserts[i];
      db.run(
        'INSERT OR IGNORE INTO scans (scan_id, website_id, target, started_at, finished_at, status) VALUES (?, ?, ?, ?, ?, ?)',
        [s.scan_id, s.website_id, s.target, s.started_at, s.finished_at, s.status],
        () => { i++; next(); }
      );
    };
    next();
  });
}

// Ensure optional meta columns exist on websites table (safe ALTER TABLE)
function ensureWebsiteColumns(cb) {
  db.all("PRAGMA table_info('websites')", (err, cols) => {
    if (err || !Array.isArray(cols)) return cb && cb();
    const names = cols.map(c => c.name);
    const adds = [];
    if (!names.includes('scan_started_at')) adds.push('scan_started_at TEXT');
    if (!names.includes('scan_finished_at')) adds.push('scan_finished_at TEXT');

    if (adds.length === 0) {
      return cb && cb();
    }

    let i = 0;
    const next = () => {
      if (i >= adds.length) return cb && cb();
      const sql = `ALTER TABLE websites ADD COLUMN ${adds[i]}`;
      db.run(sql, (aErr) => {
        if (aErr && !/duplicate column/i.test(aErr.message)) console.error('Error adding column to websites:', aErr.message);
        i++; next();
      });
    };
    next();
  });
}

// Ensure optional meta columns exist on nodes table (safe ALTER TABLE)
function ensureNodeColumns(cb) {
  db.all("PRAGMA table_info('nodes')", (err, cols) => {
    if (err || !Array.isArray(cols)) return cb && cb();
    const names = cols.map(c => c.name);
    const adds = [];
    if (!names.includes('ip')) adds.push('ip TEXT');
    if (!names.includes('response_time_ms')) adds.push('response_time_ms REAL');
    if (!names.includes('title')) adds.push('title TEXT');
    if (!names.includes('ports')) adds.push('ports TEXT');
    if (!names.includes('tls_cert')) adds.push('tls_cert TEXT');
    if (!names.includes('dirsearch_count')) adds.push('dirsearch_count INTEGER');
    if (!names.includes('wappalyzer')) adds.push('wappalyzer TEXT');
    if (!names.includes('details')) adds.push('details TEXT');

    if (adds.length === 0) {
      return cb && cb();
    }

    // Add columns sequentially to avoid SQLITE_BUSY issues
    let i = 0;
    const next = () => {
      if (i >= adds.length) return cb && cb();
      const sql = `ALTER TABLE nodes ADD COLUMN ${adds[i]}`;
      db.run(sql, (aErr) => {
        if (aErr && !/duplicate column/i.test(aErr.message)) console.error('Error adding column to nodes:', aErr.message);
        i++; next();
      });
    };
    next();
  });
}

// API Endpoints

async function fetchWebsiteGraphData(websiteId) {
  const websiteMeta = await new Promise((resolve) => {
    db.get('SELECT scan_started_at, scan_finished_at FROM websites WHERE id = ? LIMIT 1', [websiteId], (wErr, row) => {
      if (wErr) return resolve({});
      resolve(row || {});
    });
  });

  const nodesQuery = `SELECT * FROM nodes WHERE website_id = ?`;
  const rawNodes = await new Promise((resolve, reject) => {
    db.all(nodesQuery, [websiteId], (err, rows) => err ? reject(err) : resolve(rows || []));
  });

  const headerMap = await loadHeadersByWebsite(websiteId);
  const techMap = await loadTechnologiesByWebsite(websiteId);

  const nodes = rawNodes.map((row) => {
    const node = {
      id: row.value,
      group: row.type || 'unknown',
      type: row.type || 'unknown',
      value: row.value,
      status: row.status,
      size: row.size,
      scan_started_at: websiteMeta.scan_started_at,
      scan_finished_at: websiteMeta.scan_finished_at,
      timestamp: row.created_at,
      meta: {}
    };
    if (websiteMeta.scan_started_at) node.meta.scan_started_at = websiteMeta.scan_started_at;
    if (websiteMeta.scan_finished_at) node.meta.scan_finished_at = websiteMeta.scan_finished_at;

    const headers = headerMap.get(row.id) || { obj: {}, list: [] };
    node.meta.headers = headers.obj || {};
    node.headers = headers.list || [];
    const techs = techMap.get(row.id) || [];
    node.meta.technologies = techs;
    node.technologies = techs;

    try {
      if (row.ip) node.meta.ip = row.ip;
      if (row.response_time_ms != null) node.meta.response_time_ms = row.response_time_ms;
      if (row.title) node.meta.title = row.title;
      if (row.dirsearch_count != null) node.meta.dirsearch_count = row.dirsearch_count;
      if (row.ports) {
        try { node.meta.ports = JSON.parse(row.ports); } catch (e) { node.meta.ports = Array.isArray(row.ports) ? row.ports : [row.ports]; }
      }
      if (row.tls_cert) {
        try { node.meta.tls_cert = JSON.parse(row.tls_cert); } catch (e) { node.meta.tls_cert = row.tls_cert; }
      }
      if (row.wappalyzer) {
        try { node.meta.wappalyzer = JSON.parse(row.wappalyzer); } catch (e) { node.meta.wappalyzer = row.wappalyzer; }
      }
    } catch (e) { /* ignore */ }

    if (row.details) {
      try {
        const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
        if (details && typeof details === 'object') {
          for (const k of Object.keys(details)) {
            if (node.meta[k] === undefined) node.meta[k] = details[k];
          }
        }
      } catch (e) {
        // ignore malformed JSON
      }
    }

    return node;
  });

  const relationshipsQuery = `
    SELECT (SELECT value FROM nodes WHERE id = nr.source_node_id) as source,
           (SELECT value FROM nodes WHERE id = nr.target_node_id) as target,
           relationship_type as type
    FROM node_relationships nr
    WHERE EXISTS (SELECT 1 FROM nodes WHERE nodes.id = nr.source_node_id AND nodes.website_id = ?)
  `;
  const relationships = await new Promise((resolve, reject) => {
    db.all(relationshipsQuery, [websiteId], (err, rows) => err ? reject(err) : resolve((rows || []).map(rel => ({ source: rel.source, target: rel.target, type: rel.type || 'contains' }))));
  });

  return { nodes, relationships };
}

// Get all websites
app.get('/websites', (req, res) => {
  db.all('SELECT * FROM websites', [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});


// Create a new website
app.post('/websites', (req, res) => {
  const { url, name } = req.body;
  const rawUrl = String(url || '').trim();
  if (!rawUrl) return sendError(res, 400, 'url is required');
  if (!isValidTarget(rawUrl)) return sendError(res, 400, 'Invalid url', 'Expected a hostname or IP without paths');
  const normalizedUrl = normalizeTarget(rawUrl);
  const cleanName = name != null ? String(name).trim() : null;
  db.run('INSERT INTO websites (url, name) VALUES (?, ?)', [normalizedUrl, cleanName], function (err) {
    if (err) {
      if (String(err.message || '').includes('UNIQUE constraint failed: websites.url')) {
        return sendError(res, 409, 'Website already exists');
      }
      return res.status(500).json({ error: err.message });
    }
    res.status(201).json({ id: this.lastID, url: normalizedUrl, name: cleanName });
  });
});

// Get all nodes for a specific website
app.get('/websites/:websiteId/nodes', async (req, res) => {
  const { websiteId } = req.params;
  try {
    const nodesQuery = `SELECT * FROM nodes WHERE website_id = ?`;
    const rawNodes = await new Promise((resolve, reject) => {
      db.all(nodesQuery, [websiteId], (err, rows) => err ? reject(err) : resolve(rows));
    });
    const websiteMeta = await new Promise((resolve) => {
      db.get('SELECT scan_started_at, scan_finished_at FROM websites WHERE id = ? LIMIT 1', [websiteId], (wErr, row) => {
        if (wErr) return resolve({});
        resolve(row || {});
      });
    });
    const headerMap = await loadHeadersByWebsite(websiteId);
    const techMap = await loadTechnologiesByWebsite(websiteId);

    // Build nodes with headers and technologies using detected column names
    const nodes = rawNodes.map((row) => {
      const node = {
        id: row.value,
        group: row.type || 'unknown',
        type: row.type || 'unknown',
        value: row.value,
        status: row.status,
        size: row.size,
        scan_started_at: websiteMeta.scan_started_at,
        scan_finished_at: websiteMeta.scan_finished_at,
        timestamp: row.created_at,
        meta: {}
      };
      if (websiteMeta.scan_started_at) node.meta.scan_started_at = websiteMeta.scan_started_at;
      if (websiteMeta.scan_finished_at) node.meta.scan_finished_at = websiteMeta.scan_finished_at;

      const headers = headerMap.get(row.id) || { obj: {}, list: [] };
      node.meta.headers = headers.obj || {};
      node.headers = headers.list || [];
      const techs = techMap.get(row.id) || [];
      node.meta.technologies = techs;
      node.technologies = techs;

      // attach persisted meta columns if present on row
      try {
        if (row.ip) node.meta.ip = row.ip;
        if (row.response_time_ms != null) node.meta.response_time_ms = row.response_time_ms;
        if (row.title) node.meta.title = row.title;
        if (row.dirsearch_count != null) node.meta.dirsearch_count = row.dirsearch_count;
        if (row.ports) {
          try { node.meta.ports = JSON.parse(row.ports); } catch (e) { node.meta.ports = Array.isArray(row.ports) ? row.ports : [row.ports]; }
        }
        if (row.tls_cert) {
          try { node.meta.tls_cert = JSON.parse(row.tls_cert); } catch (e) { node.meta.tls_cert = row.tls_cert; }
        }
        if (row.wappalyzer) {
          try { node.meta.wappalyzer = JSON.parse(row.wappalyzer); } catch (e) { node.meta.wappalyzer = row.wappalyzer; }
        }
      } catch (e) { /* ignore */ }

      // Backwards-compat: some imports store a JSON blob in `details` column. Merge it into node.meta
      if (row.details) {
        try {
          const details = typeof row.details === 'string' ? JSON.parse(row.details) : row.details;
          if (details && typeof details === 'object') {
            // shallow merge, don't overwrite explicit columns already set above
            for (const k of Object.keys(details)) {
              if (node.meta[k] === undefined) node.meta[k] = details[k];
            }
          }
        } catch (e) {
          // ignore malformed JSON
        }
      }

      return node;
    });

    // Relationships
    const relationshipsQuery = `
      SELECT (SELECT value FROM nodes WHERE id = nr.source_node_id) as source,
             (SELECT value FROM nodes WHERE id = nr.target_node_id) as target,
             relationship_type as type
      FROM node_relationships nr
      WHERE EXISTS (SELECT 1 FROM nodes WHERE nodes.id = nr.source_node_id AND nodes.website_id = ?)
    `;
    const relationships = await new Promise((resolve, reject) => {
      db.all(relationshipsQuery, [websiteId], (err, rows) => err ? reject(err) : resolve((rows || []).map(rel => ({ source: rel.source, target: rel.target, type: rel.type || 'contains' }))));
    });

    res.json({ nodes, relationships });
  } catch (err) {
    console.error('Error fetching nodes:', err.message);
    sendError(res, 500, 'Failed to fetch graph data', err.message);
  }
});

function computeProgress(done, status) {
  const base = Math.max(0, Number(done) || 0);
  const total = status === 'completed' ? base : base + 1;
  const percent = total === 0 ? 0 : Math.round((base / total) * 100);
  return { done: base, total, percent };
}

function computeElapsedSeconds(startedAt, finishedAt) {
  if (!startedAt) return null;
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, Math.floor((end - start) / 1000));
}

async function handleStartScan(req, res) {
  const body = req.body || {};
  const rawTarget = String(body.target || '').trim();
  if (!rawTarget) return sendError(res, 400, 'target is required');
  if (!isValidTarget(rawTarget)) return sendError(res, 400, 'Invalid target', 'Expected a hostname or IP without paths');
  const normalized = normalizeTarget(rawTarget);

  let preflight;
  try {
    const projectRoot = path.resolve(__dirname, '..');
    const dbPath = DB_PATH;
    preflight = await runPreflight({ projectRoot, dbPath, db });
  } catch (err) {
    console.error('Preflight failed:', err && err.message ? err.message : err);
    return sendError(res, 500, 'Preflight failed', err && err.message ? err.message : String(err));
  }

  if (preflight.overall_status === 'fatal') {
    return res.status(412).json({
      ...preflight,
      error: 'Preflight checks failed',
      message: 'Fix fatal checks before starting a scan'
    });
  }

  const scanId = require('crypto').randomUUID();
  const startedAt = new Date().toISOString();
  const optionsJson = JSON.stringify(body.options || {});
  db.all("PRAGMA table_info('scans')", (cErr, cols) => {
    if (cErr) return res.status(500).json({ error: cErr.message });
    const names = (cols || []).map(c => c.name);
    const colList = ['scan_id', 'target', 'started_at', 'status', 'options_json'];
    const params = [scanId, normalized, startedAt, 'queued', optionsJson];
    if (names.includes('timestamp_start')) {
      colList.push('timestamp_start');
      params.push(startedAt);
    }
    const sql = `INSERT INTO scans (${colList.join(',')}) VALUES (${colList.map(() => '?').join(',')})`;
    db.run(sql, params, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      db.run(
        'INSERT OR REPLACE INTO scan_progress (scan_id, status, message, updated_at) VALUES (?, ?, ?, ?)',
        [scanId, 'queued', 'Queued', startedAt],
        () => {}
      );
      startScan({ db, scanId, target: normalized, options: body.options || {} });
      res.json({ scanId, scan_id: scanId, status: 'queued', preflight_status: preflight.overall_status });
    });
  });
}

app.post('/api/scans', scanLimiter, handleStartScan);
app.post('/api/scans/start', scanLimiter, handleStartScan);

app.get('/api/scans/:scanId/status', (req, res) => {
  const scanId = req.params.scanId;
  if (!isValidScanId(scanId)) return sendError(res, 400, 'Invalid scanId');
  db.get('SELECT * FROM scans WHERE scan_id = ? LIMIT 1', [scanId], (err, scanRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!scanRow) return res.status(404).json({ error: 'Scan not found' });
    db.get('SELECT * FROM scan_progress WHERE scan_id = ? LIMIT 1', [scanId], (pErr, pRow) => {
      if (pErr) return res.status(500).json({ error: pErr.message });
      const status = scanRow.status || (pRow && pRow.status) || 'queued';
      const message = (pRow && pRow.message) || '';
      const updatedAt = (pRow && pRow.updated_at) || scanRow.started_at;
      const stage = (pRow && pRow.stage) || '';
      const stageLabel = (pRow && pRow.stage_label) || '';
      const currentTarget = (pRow && pRow.current_target) || '';
      const logTail = (pRow && pRow.log_tail) || '';
      const logLines = logTail ? logTail.split('\n').filter(Boolean) : [];
      const websiteId = scanRow.website_id;
      if (!websiteId) {
        return res.json({
          scan_id: scanId,
          target: scanRow.target,
          status,
          stage,
          stage_label: stageLabel,
          current_target: currentTarget,
          message,
          log_tail: logLines,
          started_at: scanRow.started_at || scanRow.timestamp_start,
          updated_at: updatedAt,
          progress: {
            subdomains: computeProgress(0, status),
            directories: computeProgress(0, status),
            endpoints: computeProgress(0, status)
          }
        });
      }
      const countSql = `
        SELECT
          (SELECT COUNT(*) FROM nodes WHERE website_id = ? AND type IN ('subdomain')) as subdomains_count,
          (SELECT COUNT(*) FROM nodes WHERE website_id = ? AND type IN ('directory','dir')) as directories_count,
          (SELECT COUNT(*) FROM nodes WHERE website_id = ? AND type IN ('endpoint','path','file')) as endpoints_count
      `;
      db.get(countSql, [websiteId, websiteId, websiteId], (cErr, cRow) => {
        if (cErr) return res.status(500).json({ error: cErr.message });
        res.json({
          scan_id: scanId,
          target: scanRow.target,
          status,
          stage,
          stage_label: stageLabel,
          current_target: currentTarget,
          message,
          log_tail: logLines,
          started_at: scanRow.started_at || scanRow.timestamp_start,
          updated_at: updatedAt,
          progress: {
            subdomains: computeProgress(cRow.subdomains_count || 0, status),
            directories: computeProgress(cRow.directories_count || 0, status),
            endpoints: computeProgress(cRow.endpoints_count || 0, status)
          }
        });
      });
    });
  });
});

app.post('/api/scans/:scanId/cancel', (req, res) => {
  const scanId = req.params.scanId;
  if (!isValidScanId(scanId)) return sendError(res, 400, 'Invalid scanId');
  db.get('SELECT status FROM scans WHERE scan_id = ? LIMIT 1', [scanId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row) return res.status(404).json({ error: 'Scan not found' });
    if (row.status === 'completed' || row.status === 'failed' || row.status === 'cancelled') {
      return res.json({ ok: false, message: 'Scan already finished' });
    }
    // cancellation endpoint: update status + terminate running scan
    const result = cancelScan({ db, scanId });
    res.json({ ok: result.ok });
  });
});

// List scans (newest first)
app.get('/api/scans', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const domain = (req.query.domain || '').trim();
  const status = (req.query.status || '').trim();

  const where = [];
  const params = [];
  if (domain) {
    where.push('s.target LIKE ?');
    params.push(`%${domain}%`);
  }
  if (status) {
    where.push('s.status = ?');
    params.push(status);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const countSql = `SELECT COUNT(*) as total FROM scans s ${whereSql}`;
  db.get(countSql, params, (cErr, cRow) => {
    if (cErr) return res.status(500).json({ error: cErr.message });
    const total = cRow ? cRow.total : 0;
    const sql = `
      SELECT
        s.scan_id,
        COALESCE(s.target, s.scan_id) as target,
        COALESCE(s.started_at, s.timestamp_start) as started_at,
        COALESCE(s.finished_at, s.timestamp_end) as finished_at,
        COALESCE(s.status, 'completed') as status,
        s.website_id,
        (SELECT COUNT(*) FROM nodes n WHERE n.website_id = s.website_id AND n.type IN ('subdomain')) as subdomains_count,
        (SELECT COUNT(*) FROM nodes n WHERE n.website_id = s.website_id AND n.type IN ('directory','dir')) as directories_count,
        (SELECT COUNT(*) FROM nodes n WHERE n.website_id = s.website_id AND n.type IN ('endpoint','path','file')) as endpoints_count,
        (SELECT GROUP_CONCAT(DISTINCT ${techCol}) FROM node_technologies nt JOIN nodes n ON nt.node_id = n.id WHERE n.website_id = s.website_id) as technologies,
        COALESCE(s.finished_at, s.started_at, s.timestamp_end, s.timestamp_start) as last_seen
      FROM scans s
      ${whereSql}
      ORDER BY COALESCE(s.started_at, s.timestamp_start) DESC
      LIMIT ? OFFSET ?
    `;
    db.all(sql, [...params, limit, offset], (err, rows) => {
      if (err) return res.status(500).json({ error: err.message });
      const scans = (rows || []).map(r => ({
        scan_id: r.scan_id,
        target: r.target,
        started_at: r.started_at,
        finished_at: r.finished_at,
        status: r.status || 'completed',
        elapsed_seconds: computeElapsedSeconds(r.started_at, r.finished_at),
        subdomains_count: r.subdomains_count || 0,
        directories_count: r.directories_count || 0,
        endpoints_count: r.endpoints_count || 0,
        technologies: r.technologies ? r.technologies.split(',').filter(Boolean) : [],
        last_seen: r.last_seen
      }));
      res.json({ scans, total });
    });
  });
});

// Group scans by domain
app.get('/api/scans/domains', (req, res) => {
  const sql = `
    SELECT
      s.target as domain,
      COUNT(*) as scanCount,
      MAX(COALESCE(s.started_at, s.timestamp_start, s.created_at)) as lastScanAt,
      (
        SELECT s2.status
        FROM scans s2
        WHERE s2.target = s.target
        ORDER BY COALESCE(s2.started_at, s2.timestamp_start, s2.created_at) DESC
        LIMIT 1
      ) as lastStatus
    FROM scans s
    WHERE s.target IS NOT NULL AND s.target <> ''
    GROUP BY s.target
    ORDER BY lastScanAt DESC
  `;
  db.all(sql, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const domains = (rows || []).map(r => ({
      domain: r.domain,
      scanCount: r.scanCount || 0,
      lastScanAt: r.lastScanAt,
      lastStatus: r.lastStatus || 'completed'
    }));
    res.json({ domains });
  });
});

// Scans for a specific domain
app.get('/api/scans/domain/:domain', (req, res) => {
  const domain = String(req.params.domain || '').trim();
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 200);
  const offset = Math.max(parseInt(req.query.offset || '0', 10), 0);
  const sql = `
    SELECT
      s.scan_id,
      s.target,
      COALESCE(s.started_at, s.timestamp_start) as started_at,
      COALESCE(s.finished_at, s.timestamp_end) as finished_at,
      COALESCE(s.status, 'completed') as status
    FROM scans s
    WHERE s.target = ?
    ORDER BY COALESCE(s.started_at, s.timestamp_start) DESC
    LIMIT ? OFFSET ?
  `;
  db.all(sql, [domain, limit, offset], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    const scans = (rows || []).map(r => ({
      scan_id: r.scan_id,
      target: r.target,
      started_at: r.started_at,
      finished_at: r.finished_at,
      status: r.status,
      elapsed_seconds: computeElapsedSeconds(r.started_at, r.finished_at)
    }));
    res.json({ scans, total: scans.length });
  });
});

// Fetch a scan by ID with full graph data
app.get('/api/scans/:scanId', async (req, res) => {
  const scanId = req.params.scanId;
  if (!isValidScanId(scanId)) return sendError(res, 400, 'Invalid scanId');
  db.get('SELECT * FROM scans WHERE scan_id = ? LIMIT 1', [scanId], async (err, scanRow) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!scanRow) return res.status(404).json({ error: 'Scan not found' });
    try {
      const summaryOnly = String(req.query.summary || '').toLowerCase() === '1' || String(req.query.summary || '').toLowerCase() === 'true';
      let websiteId = scanRow.website_id;
      if (!websiteId && scanRow.target) {
        websiteId = await new Promise((resolve) => {
          db.get('SELECT id FROM websites WHERE url = ? LIMIT 1', [scanRow.target], (wErr, row) => {
            if (wErr) return resolve(null);
            resolve(row?.id || null);
          });
        });
        if (websiteId) {
          db.run('UPDATE scans SET website_id = ? WHERE scan_id = ?', [websiteId, scanId], () => {});
        }
      }
      const progress = await new Promise((resolve) => {
        db.get('SELECT updated_at FROM scan_progress WHERE scan_id = ? LIMIT 1', [scanId], (pErr, pRow) => {
          if (pErr) return resolve(null);
          resolve(pRow?.updated_at || null);
        });
      });
      const rootNode = await new Promise((resolve) => {
        if (!websiteId) return resolve(null);
        const sql = `
          SELECT
            n.id,
            n.value,
            n.type,
            EXISTS(SELECT 1 FROM node_relationships nr2 WHERE nr2.source_node_id = n.id) as has_children
          FROM nodes n
          WHERE n.website_id = ? AND n.type = 'domain'
          ORDER BY (n.value = ?) DESC, n.value ASC
          LIMIT 1
        `;
        db.get(sql, [websiteId, scanRow.target || ''], (rErr, row) => {
          if (rErr || !row) return resolve(null);
          resolve({
            id: String(row.id),
            parent_id: null,
            label: row.value,
            type: 'domain',
            value: row.value,
            has_children: !!row.has_children
          });
        });
      });
      const stages = await new Promise((resolve) => {
        db.all('SELECT stage_key, label, status, started_at, finished_at, duration_seconds FROM scan_stages WHERE scan_id = ? ORDER BY started_at ASC', [scanId], (sErr, sRows) => {
          if (sErr) return resolve([]);
          resolve((sRows || []).map(r => ({
            key: r.stage_key,
            label: r.label,
            status: r.status,
            startedAt: r.started_at,
            finishedAt: r.finished_at,
            durationSeconds: r.duration_seconds
          })));
        });
      });
      const logs = await new Promise((resolve) => {
        db.all('SELECT line FROM scan_logs WHERE scan_id = ? ORDER BY id ASC', [scanId], (lErr, lRows) => {
          if (lErr) return resolve([]);
          resolve((lRows || []).map(r => r.line).filter(Boolean));
        });
      });
      const fallbackLogs = logs.length ? logs : await new Promise((resolve) => {
        db.get('SELECT log_tail FROM scan_progress WHERE scan_id = ? LIMIT 1', [scanId], (pErr, pRow) => {
          if (pErr) return resolve([]);
          const tail = pRow && pRow.log_tail ? pRow.log_tail.split('\n').filter(Boolean) : [];
          resolve(tail);
        });
      });
      const graph = (!summaryOnly && websiteId) ? await fetchWebsiteGraphData(websiteId) : { nodes: [], relationships: [] };
      res.json({
        scan: {
          scan_id: scanRow.scan_id,
          target: scanRow.target,
          started_at: scanRow.started_at,
          finished_at: scanRow.finished_at,
          status: scanRow.status,
          website_id: websiteId || scanRow.website_id,
          last_update_at: scanRow.last_update_at || progress,
          elapsed_seconds: computeElapsedSeconds(scanRow.started_at, scanRow.finished_at)
        },
        root_node: rootNode,
        stages,
        logs: fallbackLogs,
        nodes: graph.nodes,
        relationships: graph.relationships
      });
    } catch (e) {
      res.status(500).json({ error: 'Failed to load scan data', details: e.message });
    }
  });
});

// Lazy tree fetcher for nodes by parent (filesystem-like)
app.get('/api/nodes', async (req, res) => {
  const parentId = req.query.parent_id ? String(req.query.parent_id).trim() : '';
  const rawType = String(req.query.type || '').toLowerCase();
  const rawLimit = req.query.limit ? Number(req.query.limit) : 120;
  const rawCursor = req.query.cursor ? Number(req.query.cursor) : 0;
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 500) : 120;
  const offset = Number.isFinite(rawCursor) && rawCursor > 0 ? Math.floor(rawCursor) : 0;
  if (!parentId) return sendError(res, 400, 'parent_id is required');
  if (!rawType) return sendError(res, 400, 'type is required');
  const type = rawType === 'subdomain' ? 'subdomain' : rawType === 'directory' ? 'directory' : rawType === 'url' ? 'url' : '';
  if (!type) return sendError(res, 400, 'type must be subdomain, directory, or url');

  const getWebsiteId = () => new Promise((resolve) => {
    db.get('SELECT website_id FROM nodes WHERE id = ? LIMIT 1', [parentId], (err, row) => {
      if (err) return resolve(null);
      resolve(row?.website_id || null);
    });
  });

  try {
    const websiteId = await getWebsiteId();
    if (!websiteId) return sendError(res, 404, 'Parent not found');

    const typeClause = type === 'subdomain'
      ? "n.type = 'subdomain'"
      : type === 'directory'
        ? "n.type IN ('directory','dir')"
        : "n.type IN ('endpoint','path','file')";

    const sql = `
      SELECT
        n.id,
        n.value,
        n.type,
        n.status,
        GROUP_CONCAT(DISTINCT nt.technology) as technologies,
        EXISTS(SELECT 1 FROM node_relationships nr2 WHERE nr2.source_node_id = n.id) as has_children
      FROM node_relationships nr
      JOIN nodes n ON n.id = nr.target_node_id
      LEFT JOIN node_technologies nt ON nt.node_id = n.id
      WHERE nr.source_node_id = ? AND n.website_id = ? AND ${typeClause}
      GROUP BY n.id
      ORDER BY n.value ASC
      LIMIT ? OFFSET ?
    `;

    db.all(sql, [parentId, websiteId, limit + 1, offset], (err, rows) => {
      if (err) return sendError(res, 500, 'Failed to load nodes', err.message);
      const hasMore = (rows || []).length > limit;
      const trimmed = hasMore ? rows.slice(0, limit) : rows;
      const nodes = (trimmed || []).map((row) => {
        const rawValue = String(row.value || '');
        let label = rawValue;
        if (rawValue.includes('/')) {
          const parts = rawValue.split('/').filter(Boolean);
          label = parts.length ? parts[parts.length - 1] : '/';
        }
        return {
          id: String(row.id),
          parent_id: String(parentId),
          label,
          value: rawValue,
          type,
          status: row.status != null ? row.status : null,
          technologies: row.technologies ? row.technologies.split(',').filter(Boolean) : [],
          has_children: !!row.has_children
        };
      });
      res.json({ nodes, next_cursor: hasMore ? offset + limit : null });
    });
  } catch (e) {
    sendError(res, 500, 'Failed to load nodes', e.message);
  }
});

app.get('/api/nodes/summary', async (req, res) => {
  const parentId = req.query.parent_id ? String(req.query.parent_id).trim() : '';
  if (!parentId) return sendError(res, 400, 'parent_id is required');

  const getWebsiteId = () => new Promise((resolve) => {
    db.get('SELECT website_id FROM nodes WHERE id = ? LIMIT 1', [parentId], (err, row) => {
      if (err) return resolve(null);
      resolve(row?.website_id || null);
    });
  });

  try {
    const websiteId = await getWebsiteId();
    if (!websiteId) return sendError(res, 404, 'Parent not found');
    const sql = `
      SELECT
        SUM(CASE WHEN n.type = 'subdomain' THEN 1 ELSE 0 END) as subdomains,
        SUM(CASE WHEN n.type IN ('directory','dir') THEN 1 ELSE 0 END) as directories,
        SUM(CASE WHEN n.type IN ('endpoint','path','file') THEN 1 ELSE 0 END) as urls
      FROM node_relationships nr
      JOIN nodes n ON n.id = nr.target_node_id
      WHERE nr.source_node_id = ? AND n.website_id = ?
    `;
    const counts = await new Promise((resolve) => {
      db.get(sql, [parentId, websiteId], (err, row) => {
        if (err) return resolve({ subdomains: 0, directories: 0, urls: 0 });
        resolve({
          subdomains: row?.subdomains || 0,
          directories: row?.directories || 0,
          urls: row?.urls || 0
        });
      });
    });

    const statusCounts = await new Promise((resolve) => {
      const statusSql = `
        SELECT n.status as status, COUNT(*) as count
        FROM node_relationships nr
        JOIN nodes n ON n.id = nr.target_node_id
        WHERE nr.source_node_id = ? AND n.website_id = ? AND n.type IN ('endpoint','path','file')
        GROUP BY n.status
      `;
      db.all(statusSql, [parentId, websiteId], (err, rows) => {
        if (err) return resolve({});
        const map = {};
        (rows || []).forEach(r => {
          const key = r.status != null ? String(r.status) : 'unknown';
          map[key] = r.count || 0;
        });
        resolve(map);
      });
    });

    res.json({
      counts,
      status_counts: {
        urls: statusCounts
      }
    });
  } catch (e) {
    sendError(res, 500, 'Failed to load summary', e.message);
  }
});

app.get('/api/nodes/path', (req, res) => {
  const nodeId = req.query.node_id ? String(req.query.node_id).trim() : '';
  if (!nodeId) return sendError(res, 400, 'node_id is required');

  const sql = `
    WITH RECURSIVE chain(id, parent_id, depth) AS (
      SELECT n.id, nr.source_node_id, 0
      FROM nodes n
      LEFT JOIN node_relationships nr ON nr.target_node_id = n.id
      WHERE n.id = ?
      UNION ALL
      SELECT n2.id, nr2.source_node_id, c.depth + 1
      FROM nodes n2
      LEFT JOIN node_relationships nr2 ON nr2.target_node_id = n2.id
      JOIN chain c ON c.parent_id = n2.id
      WHERE c.parent_id IS NOT NULL
    )
    SELECT c.id, c.parent_id, n.value, n.type, n.status
    FROM chain c
    JOIN nodes n ON n.id = c.id
    ORDER BY c.depth DESC
  `;

  db.all(sql, [nodeId], (err, rows) => {
    if (err) return sendError(res, 500, 'Failed to load path', err.message);
    const path = (rows || []).map((row) => {
      const rawValue = String(row.value || '');
      let label = rawValue;
      if (rawValue.includes('/')) {
        const parts = rawValue.split('/').filter(Boolean);
        label = parts.length ? parts[parts.length - 1] : '/';
      }
      return {
        id: String(row.id),
        parent_id: row.parent_id != null ? String(row.parent_id) : null,
        label,
        value: rawValue,
        type: row.type || null,
        status: row.status != null ? row.status : null
      };
    });
    res.json({ path });
  });
});

// Serve raw viz JSON file (results/clean/<website>_viz.json) so frontend can fetch the original file
app.get('/websites/:websiteId/viz', (req, res) => {
  const websiteId = req.params.websiteId;
  db.get('SELECT url FROM websites WHERE id = ? LIMIT 1', [websiteId], (err, row) => {
    if (err) return res.status(500).json({ error: err.message });
    if (!row || !row.url) return res.status(404).json({ error: 'Website not found' });
    const baseDir = path.resolve(__dirname, '..', 'results', 'clean');
    const normalized = normalizeTarget(row.url);
    const filenameBase = normalized || String(row.url || '').trim();
    const safeBase = String(filenameBase || '').replace(/[\\/]/g, '_').replace(/\0/g, '').slice(0, 180);
    if (!safeBase) return sendError(res, 400, 'Invalid website url');
    const vizPath = path.join(baseDir, `${safeBase}_viz.json`);
    if (!vizPath.startsWith(baseDir + path.sep)) {
      return sendError(res, 400, 'Invalid viz path');
    }
    fs.readFile(vizPath, 'utf8', (rErr, data) => {
      if (rErr) return res.status(404).json({ error: 'Viz file not found' });
      try {
        const parsed = JSON.parse(data);
        res.json(parsed);
      } catch (e) {
        // if file is not valid JSON, return raw text
        res.type('text').send(data);
      }
    });
  });
});

// Get a single node (by node value/id) for a specific website
app.get('/websites/:websiteId/nodes/:nodeId', async (req, res) => {
  const { websiteId, nodeId } = req.params;
  try {
    const nodeRow = await new Promise((resolve, reject) => {
      const isNumeric = /^[0-9]+$/.test(String(nodeId || ''));
      const sql = isNumeric
        ? 'SELECT * FROM nodes WHERE website_id = ? AND id = ? LIMIT 1'
        : 'SELECT * FROM nodes WHERE website_id = ? AND value = ? LIMIT 1';
      const params = isNumeric ? [websiteId, nodeId] : [websiteId, nodeId];
      db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
    });
    if (!nodeRow) return sendError(res, 404, 'Node not found');
    const websiteMeta = await new Promise((resolve) => {
      db.get('SELECT scan_started_at, scan_finished_at FROM websites WHERE id = ? LIMIT 1', [websiteId], (wErr, row) => {
        if (wErr) return resolve({});
        resolve(row || {});
      });
    });

    const node = {
      id: nodeRow.value,
      group: nodeRow.type || 'unknown',
      type: nodeRow.type || 'unknown',
      value: nodeRow.value,
      status: nodeRow.status,
      size: nodeRow.size,
      scan_started_at: websiteMeta.scan_started_at,
      scan_finished_at: websiteMeta.scan_finished_at,
      timestamp: nodeRow.created_at,
      meta: {}
    };
    if (websiteMeta.scan_started_at) node.meta.scan_started_at = websiteMeta.scan_started_at;
    if (websiteMeta.scan_finished_at) node.meta.scan_finished_at = websiteMeta.scan_finished_at;

    const hQuery = `SELECT ${headerKeyCol} as keycol, ${headerValueCol} as valcol FROM node_headers WHERE node_id = ?`;
    const headers = await new Promise((resolve) => {
      db.all(hQuery, [nodeRow.id], (hErr, hRows) => {
        if (hErr) {
          console.error('Error loading headers for node', nodeRow.id, hErr.message);
          return resolve([]);
        }
        resolve(hRows || []);
      });
    });
    node.meta.headers = {};
    node.headers = [];
    headers.forEach(h => {
      if (h.keycol != null) node.meta.headers[String(h.keycol)] = h.valcol == null ? '' : String(h.valcol);
      node.headers.push({ key: h.keycol, value: h.valcol });
    });

    const tQuery = `SELECT ${techCol} as techcol FROM node_technologies WHERE node_id = ?`;
    const techs = await new Promise((resolve) => {
      db.all(tQuery, [nodeRow.id], (tErr, tRows) => {
        if (tErr) {
          console.error('Error loading technologies for node', nodeRow.id, tErr.message);
          return resolve([]);
        }
        resolve((tRows || []).map(r => r.techcol));
      });
    });
    node.meta.technologies = techs;
    node.technologies = techs;

    // attach stored meta columns from nodes table (if present)
    try {
      if (nodeRow.ip) node.meta.ip = nodeRow.ip;
      if (nodeRow.response_time_ms != null) node.meta.response_time_ms = nodeRow.response_time_ms;
      if (nodeRow.title) node.meta.title = nodeRow.title;
      if (nodeRow.dirsearch_count != null) node.meta.dirsearch_count = nodeRow.dirsearch_count;
      if (nodeRow.ports) {
        try { node.meta.ports = JSON.parse(nodeRow.ports); } catch (e) { node.meta.ports = Array.isArray(nodeRow.ports) ? nodeRow.ports : [nodeRow.ports]; }
      }
      if (nodeRow.tls_cert) {
        try { node.meta.tls_cert = JSON.parse(nodeRow.tls_cert); } catch (e) { node.meta.tls_cert = nodeRow.tls_cert; }
      }
      if (nodeRow.wappalyzer) {
        try { node.meta.wappalyzer = JSON.parse(nodeRow.wappalyzer); } catch (e) { node.meta.wappalyzer = nodeRow.wappalyzer; }
      }
    } catch (e) { /* ignore */ }

    // Backwards-compat: merge legacy `details` JSON blob if present
    if (nodeRow.details) {
      try {
        const details = typeof nodeRow.details === 'string' ? JSON.parse(nodeRow.details) : nodeRow.details;
        if (details && typeof details === 'object') {
          for (const k of Object.keys(details)) {
            if (node.meta[k] === undefined) node.meta[k] = details[k];
          }
        }
      } catch (e) { /* ignore malformed details */ }
    }

    res.json({ node });
  } catch (err) {
    console.error('Error fetching node:', err.message);
    sendError(res, 500, 'Failed to fetch node', err.message);
  }
});

// Get all nodes (across all websites)
app.get('/nodes', (req, res) => {
  const query = `
    SELECT n.*, w.url as website_url
    FROM nodes n
    LEFT JOIN websites w ON n.website_id = w.id
  `;
  db.all(query, [], (err, rows) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(rows);
  });
});

// Save new node data (simple endpoint)
app.post('/websites/:websiteId/nodes', (req, res) => {
  const websiteId = req.params.websiteId;
  const { nodeId, type, status, size, headers, technologies, vulnerabilities } = req.body;
  if (!nodeId) return sendError(res, 400, 'nodeId is required');
  db.serialize(() => {
    db.run('BEGIN TRANSACTION;');
    // Idempotent node creation/update (nodes(website_id,value) is UNIQUE)
    db.run('INSERT OR IGNORE INTO nodes (website_id, value, type, status, size) VALUES (?, ?, ?, ?, ?)', [websiteId, nodeId, type, status, size], function (err) {
      if (err) { db.run('ROLLBACK;'); return res.status(500).json({ error: err.message }); }
      db.get('SELECT id FROM nodes WHERE website_id = ? AND value = ? LIMIT 1', [websiteId, nodeId], (gErr, row) => {
        if (gErr || !row) { db.run('ROLLBACK;'); return res.status(500).json({ error: (gErr && gErr.message) || 'Failed to resolve node id' }); }
        const resolvedNodeId = row.id;
        db.run(
          'UPDATE nodes SET type = COALESCE(?, type), status = COALESCE(?, status), size = COALESCE(?, size) WHERE id = ?',
          [type, status, size, resolvedNodeId],
          () => {}
        );

        // Replace child rows to keep this endpoint idempotent
        db.run('DELETE FROM node_headers WHERE node_id = ?', [resolvedNodeId], () => {});
        db.run('DELETE FROM node_technologies WHERE node_id = ?', [resolvedNodeId], () => {});
        db.run('DELETE FROM node_vulnerabilities WHERE node_id = ?', [resolvedNodeId], () => {});

        if (Array.isArray(headers)) {
          const headerCols = `${headerKeyCol}, ${headerValueCol}`;
          const headerQuery = `INSERT INTO node_headers (node_id, ${headerCols}) VALUES (?, ?, ?)`;
          headers.forEach(h => db.run(headerQuery, [resolvedNodeId, h.key, h.value], (e) => { if (e) console.error('Header insert error', e.message); }));
        }
        if (Array.isArray(technologies)) {
          const techQuery = `INSERT INTO node_technologies (node_id, ${techCol}) VALUES (?, ?)`;
          technologies.forEach(t => db.run(techQuery, [resolvedNodeId, t], (e) => { if (e) console.error('Tech insert error', e.message); }));
        }
        if (Array.isArray(vulnerabilities)) {
          const vulnQuery = `INSERT INTO node_vulnerabilities (node_id, vulnerability) VALUES (?, ?)`;
          vulnerabilities.forEach(v => db.run(vulnQuery, [resolvedNodeId, v], (e) => { if (e) console.error('Vuln insert error', e.message); }));
        }
        db.run('COMMIT;', (cErr) => {
          if (cErr) { db.run('ROLLBACK;'); return res.status(500).json({ error: cErr.message }); }
          return res.status(201).json({ id: resolvedNodeId });
        });
      });
    });
  });
});

// Create a relationship between two nodes
app.post('/nodes/:sourceNodeId/relationships/:targetNodeId', (req, res) => {
  const sourceNodeId = req.params.sourceNodeId;
  const targetNodeId = req.params.targetNodeId;
  const { relationshipType } = req.body;
  db.run('INSERT INTO node_relationships (source_node_id, target_node_id, relationship_type) VALUES (?, ?, ?)', [sourceNodeId, targetNodeId, relationshipType], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: this.lastID, sourceNodeId, targetNodeId, relationshipType });
  });
});

// Get relationships for a node
app.get('/nodes/:nodeId/relationships', (req, res) => {
  const nodeId = req.params.nodeId;
  const query = `
    SELECT nr.*, 
           s.value as source_node_id_text,
           t.value as target_node_id_text
    FROM node_relationships nr
    JOIN nodes s ON nr.source_node_id = s.id
    JOIN nodes t ON nr.target_node_id = t.id
    WHERE nr.source_node_id = ? OR nr.target_node_id = ?
  `;
  
  db.all(query, [nodeId, nodeId], (err, rows) => {
    if (err) {
      res.status(500).json({ error: err.message });
    } else {
      res.json(rows);
    }
  });
});

app.use('/api', (req, res) => {
  sendError(res, 404, 'Not found');
});

app.use((err, req, res, next) => {
  if (err && err.message === 'CORS blocked') return sendError(res, 403, 'CORS blocked');
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, 400, 'Invalid JSON');
  }
  console.error('Unhandled error:', err?.message || err);
  return sendError(res, 500, 'Server error');
});

// Start server
app.post('/api/graph/query', apiLimiter, async (req, res) => {
  const {
    websiteId,
    mode = 'global',
    centerId,
    hops = 1,
    filters = {}
  } = req.body;

  if (!websiteId && !centerId) {
    return sendError(res, 400, 'websiteId or centerId is required');
  }

  const typeFilter = Array.isArray(filters.types) && filters.types.length 
    ? `AND n.type IN (${filters.types.map(t => `'${t}'`).join(',')})` 
    : '';
  
  const statusFilter = Array.isArray(filters.status) && filters.status.length
    ? `AND n.status IN (${filters.status.map(s => parseInt(s, 10)).filter(n => !isNaN(n)).join(',')})`
    : '';

  try {
    let nodes = [];
    
    if (mode === 'local' && centerId) {
      // Recursive CTE for Local Mode (BFS)
      const query = `
        WITH RECURSIVE bfs_tree(id, depth) AS (
          SELECT id, 0 FROM nodes WHERE id = ?
          UNION
          SELECT 
            CASE WHEN r.source_node_id = b.id THEN r.target_node_id ELSE r.source_node_id END, 
            b.depth + 1
          FROM nodes n
          JOIN node_relationships r ON (r.source_node_id = n.id OR r.target_node_id = n.id)
          JOIN bfs_tree b ON n.id = b.id
          WHERE b.depth < ?
        )
        SELECT DISTINCT n.* 
        FROM nodes n
        JOIN bfs_tree b ON n.id = b.id
        WHERE 1=1 ${typeFilter} ${statusFilter}
        LIMIT 2000
      `;
      
      nodes = await new Promise((resolve, reject) => {
        db.all(query, [centerId, hops], (err, rows) => err ? reject(err) : resolve(rows || []));
      });
    } else {
      // Global Mode
      const query = `
        SELECT * FROM nodes n 
        WHERE website_id = ? 
        ${typeFilter} ${statusFilter}
        LIMIT 5000
      `;
      nodes = await new Promise((resolve, reject) => {
        db.all(query, [websiteId], (err, rows) => err ? reject(err) : resolve(rows || []));
      });
    }

    if (nodes.length === 0) {
      return res.json({ nodes: [], links: [] });
    }

    const nodeIds = nodes.map(n => n.id);
    // SQLite limit for variables is usually 999 or 32766 depending on version. 
    // Splitting into chunks if necessary, but 5000 nodes might hit limits if we map 2 params per link check?
    // Actually `IN (...)` counts as variables.
    
    // Optimization: Fetch all links for website, then filter in JS? 
    // Or just fetch links where source/target are in the ID set.
    
    // Chunked fetching for links to avoid SQL variable limit
    const chunkSize = 900;
    const links = [];
    const uniqueLinks = new Set();

    for (let i = 0; i < nodeIds.length; i += chunkSize) {
      const chunk = nodeIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(',');
      const linkQuery = `
        SELECT * FROM node_relationships 
        WHERE source_node_id IN (${placeholders}) 
        OR target_node_id IN (${placeholders})
      `;
      
      const chunkLinks = await new Promise((resolve, reject) => {
        db.all(linkQuery, chunk.concat(chunk), (err, rows) => err ? reject(err) : resolve(rows || []));
      });

      // We only want links where BOTH ends are in our node set (for a clean graph), 
      // OR maybe allow "dangling" edges to show there's more? 
      // Standard graph view: only show edges between visible nodes.
      const nodeIdSet = new Set(nodeIds);
      
      chunkLinks.forEach(l => {
        if (nodeIdSet.has(l.source_node_id) && nodeIdSet.has(l.target_node_id)) {
          const key = `${l.source_node_id}-${l.target_node_id}`;
          if (!uniqueLinks.has(key)) {
            uniqueLinks.add(key);
            links.push(l);
          }
        }
      });
    }

    res.json({ nodes, links });

  } catch (err) {
    console.error('[graph] Query failed', err);
    sendError(res, 500, 'Graph query failed', err.message);
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
