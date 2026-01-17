const sqlite3 = require('sqlite3').verbose();
const path = require('path');

/**
 * Database utility module for managing SQLite operations
 * Provides promise-based wrappers and schema management
 */

class Database {
  constructor(dbPath) {
    this.dbPath = dbPath;
    this.db = null;
  }

  /**
   * Initialize database connection
   * @returns {Promise<void>}
   */
  async init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(this.dbPath, (err) => {
        if (err) {
          console.error('Failed to open DB:', err.message);
          reject(err);
        } else {
          console.log('Connected to SQLite database.');
          resolve();
        }
      });
    });
  }

  /**
   * Execute a single SQL statement
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<void>}
   */
  async run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) {
          console.error('Database run error:', sql, err.message);
          reject(err);
        } else {
          resolve({ lastID: this.lastID, changes: this.changes });
        }
      });
    });
  }

  /**
   * Get a single row from the database
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Object|null>}
   */
  async get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) {
          console.error('Database get error:', sql, err.message);
          reject(err);
        } else {
          resolve(row || null);
        }
      });
    });
  }

  /**
   * Get all rows matching a query
   * @param {string} sql - SQL query
   * @param {Array} params - Query parameters
   * @returns {Promise<Array>}
   */
  async all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) {
          console.error('Database all error:', sql, err.message);
          reject(err);
        } else {
          resolve(rows || []);
        }
      });
    });
  }

  /**
   * Get table column information
   * @param {string} tableName - Table name
   * @returns {Promise<Array>}
   */
  async getTableInfo(tableName) {
    return this.all(`PRAGMA table_info('${tableName}')`);
  }

  /**
   * Check if column exists in table
   * @param {string} tableName - Table name
   * @param {string} columnName - Column name
   * @returns {Promise<boolean>}
   */
  async columnExists(tableName, columnName) {
    const cols = await this.getTableInfo(tableName);
    return cols.some(c => c.name === columnName);
  }

  /**
   * Add column to table if it doesn't exist
   * @param {string} tableName - Table name
   * @param {string} columnDef - Column definition (e.g., 'status TEXT')
   * @returns {Promise<boolean>} - Returns true if column was added
   */
  async addColumnIfNotExists(tableName, columnDef) {
    const columnName = columnDef.split(/\s+/)[0];
    const exists = await this.columnExists(tableName, columnName);
    
    if (!exists) {
      try {
        await this.run(`ALTER TABLE ${tableName} ADD COLUMN ${columnDef}`);
        console.log(`Added column ${columnName} to ${tableName}`);
        return true;
      } catch (err) {
        if (!/duplicate column/i.test(err.message)) {
          console.error(`Error adding column ${columnName} to ${tableName}:`, err.message);
          throw err;
        }
        return false;
      }
    }
    return false;
  }

  /**
   * Create index if it doesn't exist
   * @param {string} indexName - Index name
   * @param {string} tableName - Table name
   * @param {string} columns - Column names for index
   * @returns {Promise<void>}
   */
  async createIndexIfNotExists(indexName, tableName, columns) {
    try {
      await this.run(`CREATE INDEX IF NOT EXISTS ${indexName} ON ${tableName}(${columns})`);
    } catch (err) {
      console.error(`Error creating index ${indexName}:`, err.message);
    }
  }

  /**
   * Begin a transaction
   * @returns {Promise<void>}
   */
  async beginTransaction() {
    return this.run('BEGIN TRANSACTION');
  }

  /**
   * Commit a transaction
   * @returns {Promise<void>}
   */
  async commit() {
    return this.run('COMMIT');
  }

  /**
   * Rollback a transaction
   * @returns {Promise<void>}
   */
  async rollback() {
    return this.run('ROLLBACK');
  }

  /**
   * Close database connection
   * @returns {Promise<void>}
   */
  async close() {
    return new Promise((resolve, reject) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = Database;
