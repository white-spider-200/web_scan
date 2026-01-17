#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const child_process = require('child_process');
const config = require('./config');

const DB_FILE = path.resolve(__dirname, config.database.path);
const SCHEMA_FILE = path.join(__dirname, 'schema.sql');

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

function ensureSqlite3() {
  try {
    const sqlite3 = require('sqlite3').verbose();
    return sqlite3;
  } catch (err) {
    console.error('Missing dependency: sqlite3');
    console.error('Run:');
    console.error('  cd server && npm install sqlite3');
    fail('Please install sqlite3 and re-run this script.');
  }
}

function applySchemaIfMissing(sqlite3) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_FILE, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
      if (err) return reject(err);

      db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='nodes' LIMIT 1", (err, row) => {
        if (err) {
          db.close(() => {});
          return reject(err);
        }
        if (row && row.name === 'nodes') {
          console.log('Database exists and contains required tables.');
          db.close(() => resolve(false));
          return;
        }

        // nodes table missing (or DB empty) -> apply schema
        if (!fs.existsSync(SCHEMA_FILE)) {
          db.close(() => {});
          return reject(new Error('schema.sql not found in server/'));
        }
        console.log('Applying schema from server/schema.sql...');
        const sql = fs.readFileSync(SCHEMA_FILE, 'utf8');
        db.exec(sql, (err) => {
          db.close(() => {});
          if (err) return reject(err);
          console.log('Schema applied successfully.');
          resolve(true);
        });
      });
    });
  });
}

function runOrchestrator(domainArg) {
  if (!domainArg) {
    console.log('No domain supplied; skipping orchestrator run.');
    return 0;
  }
  // Locate python executable
  const py = process.env.PYTHON || 'python3';
  const runAll = path.join(__dirname, '..', 'run_all.py');
  if (!fs.existsSync(runAll)) {
    console.error('run_all.py not found at project root; cannot run orchestrator.');
    return 2;
  }
  console.log(`Running orchestrator: ${py} ${runAll} ${domainArg}`);
  const res = child_process.spawnSync(py, [runAll, domainArg], {
    stdio: 'inherit',
    cwd: path.join(__dirname, '..')
  });
  if (res.error) {
    console.error('Failed to execute orchestrator:', res.error);
    return 3;
  }
  return res.status;
}

async function main() {
  // parse args: --domain <domain> or just domain
  const argv = process.argv.slice(2);
  let domain = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--domain' || a === '-d') {
      domain = argv[i+1];
      i++;
    } else if (!domain) {
      domain = a;
    }
  }

  const sqlite3 = ensureSqlite3();

  try {
    const created = await applySchemaIfMissing(sqlite3);
    if (created) {
      console.log('Database initialization completed.');
    }
  } catch (err) {
    fail('Error initializing DB: ' + err);
  }

  const status = runOrchestrator(domain);
  if (status === 0) {
    console.log('Orchestrator completed (or was skipped).');
    process.exit(0);
  } else {
    fail('Orchestrator failed with status ' + status);
  }
}

main();
