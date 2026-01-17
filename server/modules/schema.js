/**
 * Schema management module for database initialization
 */

const SCHEMA_DEFINITIONS = {
  websites: {
    sql: `CREATE TABLE IF NOT EXISTS websites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      url TEXT UNIQUE,
      name TEXT
    )`,
    indexes: []
  },
  nodes: {
    sql: `CREATE TABLE IF NOT EXISTS nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      value TEXT NOT NULL,
      type TEXT,
      status INTEGER,
      size INTEGER,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (website_id) REFERENCES websites(id) ON DELETE CASCADE
    )`,
    indexes: [
      { name: 'idx_nodes_website_id', columns: 'website_id' },
      { name: 'idx_nodes_type', columns: 'type' },
      { name: 'idx_nodes_value', columns: 'value' }
    ]
  },
  node_headers: {
    sql: `CREATE TABLE IF NOT EXISTS node_headers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      header_key TEXT,
      header_value TEXT,
      name TEXT,
      value TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )`,
    indexes: [
      { name: 'idx_node_headers_node_id', columns: 'node_id' }
    ]
  },
  node_technologies: {
    sql: `CREATE TABLE IF NOT EXISTS node_technologies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      technology TEXT,
      name TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )`,
    indexes: [
      { name: 'idx_node_technologies_node_id', columns: 'node_id' }
    ]
  },
  node_vulnerabilities: {
    sql: `CREATE TABLE IF NOT EXISTS node_vulnerabilities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id INTEGER NOT NULL,
      vulnerability TEXT,
      FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
    )`,
    indexes: [
      { name: 'idx_node_vulnerabilities_node_id', columns: 'node_id' }
    ]
  },
  node_relationships: {
    sql: `CREATE TABLE IF NOT EXISTS node_relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_node_id INTEGER NOT NULL,
      target_node_id INTEGER NOT NULL,
      relationship_type TEXT,
      FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
      UNIQUE(source_node_id, target_node_id)
    )`,
    indexes: [
      { name: 'idx_node_rel_source', columns: 'source_node_id' },
      { name: 'idx_node_rel_target', columns: 'target_node_id' }
    ]
  },
  scans: {
    sql: `CREATE TABLE IF NOT EXISTS scans (
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
    )`,
    indexes: [
      { name: 'idx_scans_target', columns: 'target' },
      { name: 'idx_scans_started_at', columns: 'started_at' },
      { name: 'idx_scans_status', columns: 'status' }
    ]
  },
  scan_progress: {
    sql: `CREATE TABLE IF NOT EXISTS scan_progress (
      scan_id TEXT PRIMARY KEY,
      status TEXT,
      message TEXT,
      stage TEXT,
      stage_label TEXT,
      current_target TEXT,
      log_tail TEXT,
      updated_at TEXT,
      FOREIGN KEY (scan_id) REFERENCES scans(scan_id) ON DELETE CASCADE
    )`,
    indexes: []
  },
  scan_stages: {
    sql: `CREATE TABLE IF NOT EXISTS scan_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL,
      stage_key TEXT NOT NULL,
      label TEXT,
      status TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_seconds INTEGER,
      UNIQUE(scan_id, stage_key),
      FOREIGN KEY (scan_id) REFERENCES scans(scan_id) ON DELETE CASCADE
    )`,
    indexes: [
      { name: 'idx_scan_stages_scan_id', columns: 'scan_id' }
    ]
  },
  scan_logs: {
    sql: `CREATE TABLE IF NOT EXISTS scan_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scan_id TEXT NOT NULL,
      ts TEXT,
      line TEXT,
      FOREIGN KEY (scan_id) REFERENCES scans(scan_id) ON DELETE CASCADE
    )`,
    indexes: [
      { name: 'idx_scan_logs_scan_id', columns: 'scan_id' }
    ]
  }
};

/**
 * Initialize database schema
 * @param {Database} db - Database instance
 * @returns {Promise<void>}
 */
async function initializeSchema(db) {
  try {
    for (const [tableName, definition] of Object.entries(SCHEMA_DEFINITIONS)) {
      await db.run(definition.sql);
      
      // Create indexes
      for (const index of definition.indexes) {
        await db.createIndexIfNotExists(index.name, tableName, index.columns);
      }
    }
    console.log('Database schema initialized successfully');
  } catch (err) {
    console.error('Failed to initialize schema:', err.message);
    throw err;
  }
}

module.exports = {
  SCHEMA_DEFINITIONS,
  initializeSchema
};
