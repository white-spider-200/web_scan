#!/usr/bin/env node
const sqlite3 = require('sqlite3');
const path = require('path');
const { ensureNodeValueUniqueness } = require('./modules/dbIntegrity');

const dbPath = path.join(__dirname, 'data.db');
const db = new sqlite3.Database(dbPath);

(async () => {
  try {
    const r = await ensureNodeValueUniqueness({ db, dbPath });
    if (!r.migrated && !r.created_unique_index) {
      console.log('No migration needed (unique index already present).');
      return;
    }
    console.log(`OK: deduped_groups=${r.deduped_groups} deduped_nodes=${r.deduped_nodes} unique_index=${r.created_unique_index}`);
    if (r.backup_path) console.log(`Backup: ${r.backup_path}`);
  } catch (e) {
    console.error('Dedupe/migration failed:', e && e.message ? e.message : e);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
