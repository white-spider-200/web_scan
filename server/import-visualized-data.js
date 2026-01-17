#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');
const config = require('./config');
const { normalizeTarget } = require('./validators');

if (process.argv.length < 3) {
  console.error('Usage: node import-visualized-data.js <viz.json>');
  process.exit(2);
}

const vizPath = path.resolve(process.argv[2]);
if (!fs.existsSync(vizPath)) {
  console.error('File not found:', vizPath);
  process.exit(2);
}

const dbPath = path.resolve(__dirname, config.database.path);
const db = new sqlite3.Database(dbPath);

const runAsync = (sql, params=[]) => new Promise((resolve, reject) => db.run(sql, params, function(err){ if(err) reject(err); else resolve(this); }));
const allAsync = (sql, params=[]) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
const getAsync = (sql, params=[]) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));

async function getTableColumns(tableName){
  try{
    const rows = await allAsync(`PRAGMA table_info(${tableName})`);
    return Array.isArray(rows) ? rows.map(r => r.name) : [];
  }catch(e){
    return [];
  }
}

function safeStringify(x){
  if (x === undefined || x === null) return null;
  if (typeof x === 'string') return x;
  try { return JSON.stringify(x); } catch(e){ return String(x); }
}

async function importViz(filePath){
  const raw = fs.readFileSync(filePath, 'utf8');
  const viz = JSON.parse(raw);
  if (!viz.nodes || !Array.isArray(viz.nodes)) throw new Error('viz JSON missing nodes array');

  const nodeCols = await getTableColumns('nodes');
  const availableNodeCols = new Set(nodeCols);
  const headerCols = await getTableColumns('node_headers');
  const headerKey = headerCols.includes('header_key') ? 'header_key' : (headerCols.includes('name') ? 'name' : null);
  const headerVal = headerCols.includes('header_value') ? 'header_value' : (headerCols.includes('value') ? 'value' : null);
  const techCols = await getTableColumns('node_technologies');
  const techCol = techCols.includes('technology') ? 'technology' : (techCols.includes('name') ? 'name' : null);

  const metaCandidates = ['ip','response_time_ms','title','ports','tls_cert','dirsearch_count','wappalyzer','headers'];

  // ensure website row if possible
  const websiteUrlRaw = (viz.website && viz.website.url) ? viz.website.url : path.basename(filePath).replace(/_viz.json$/i, '');
  const websiteUrl = normalizeTarget(websiteUrlRaw) || websiteUrlRaw;
  let websiteId = null;
  try {
    const existing = await getAsync('SELECT id FROM websites WHERE url = ?', [websiteUrl]).catch(()=>null);
    if (existing && existing.id) websiteId = existing.id;
    else await runAsync('INSERT OR IGNORE INTO websites (url, name) VALUES (?, ?)', [websiteUrl, websiteUrl]);
    const row = await getAsync('SELECT id FROM websites WHERE url = ?', [websiteUrl]).catch(()=>null);
    if (row && row.id) websiteId = row.id;
  } catch (e) { /* ignore */ }

  // start transaction
  await runAsync('BEGIN TRANSACTION');
  try {
    if (websiteId != null) {
      // Clear existing nodes for this website to avoid stale/partial graphs.
      await runAsync(
        'DELETE FROM node_relationships WHERE source_node_id IN (SELECT id FROM nodes WHERE website_id = ?) OR target_node_id IN (SELECT id FROM nodes WHERE website_id = ?)',
        [websiteId, websiteId]
      ).catch(() => {});
      await runAsync(
        'DELETE FROM node_headers WHERE node_id IN (SELECT id FROM nodes WHERE website_id = ?)',
        [websiteId]
      ).catch(() => {});
      await runAsync(
        'DELETE FROM node_technologies WHERE node_id IN (SELECT id FROM nodes WHERE website_id = ?)',
        [websiteId]
      ).catch(() => {});
      await runAsync('DELETE FROM nodes WHERE website_id = ?', [websiteId]).catch(() => {});
    }
    const nodeIdMap = {};

    // Insert or update nodes (merge-on-import)
    for (const node of viz.nodes) {
      const nodeValue = node.value || node.id;
      // find existing node by website_id+value when possible
      let existing = null;
      try {
        if (websiteId != null) existing = await getAsync('SELECT id FROM nodes WHERE website_id = ? AND value = ? LIMIT 1', [websiteId, nodeValue]).catch(()=>null);
        if (!existing) existing = await getAsync('SELECT id FROM nodes WHERE value = ? LIMIT 1', [nodeValue]).catch(()=>null);
      } catch (e) { existing = null; }

      // prepare columns/values
      const cols = [];
      const vals = [];
      const placeholders = [];
      const mapping = {
        website_id: websiteId,
        value: nodeValue,
        type: node.type || null,
        status: node.status ?? null,
        size: node.size ?? null,
      };
      for (const [k,v] of Object.entries(mapping)) {
        if (availableNodeCols.has(k) && v !== undefined) {
          cols.push(k); placeholders.push('?'); vals.push(v);
        }
      }
      for (const m of metaCandidates) {
        if (availableNodeCols.has(m) && node.meta && Object.prototype.hasOwnProperty.call(node.meta, m)) {
          cols.push(m); placeholders.push('?');
          const v = node.meta[m];
          vals.push((m === 'ports' || m === 'tls_cert' || m === 'wappalyzer' || m === 'headers') ? safeStringify(v) : v);
        }
      }

      let dbNodeId = null;
      if (existing && existing.id) {
        // delete existing node and its child rows so we can insert a fresh one
        try {
          await runAsync('DELETE FROM node_headers WHERE node_id = ?', [existing.id]).catch(()=>{});
          await runAsync('DELETE FROM node_technologies WHERE node_id = ?', [existing.id]).catch(()=>{});
          await runAsync('DELETE FROM node_relationships WHERE source_node_id = ? OR target_node_id = ?', [existing.id, existing.id]).catch(()=>{});
          await runAsync('DELETE FROM nodes WHERE id = ?', [existing.id]).catch(()=>{});
        } catch(e) { /* ignore deletion errors */ }
      }

      // insert (fresh) node
      if (cols.length > 0) {
        const sql = `INSERT INTO nodes (${cols.join(',')}) VALUES (${placeholders.join(',')})`;
        const res = await runAsync(sql, vals).catch(()=>null);
        if (res && res.lastID) dbNodeId = res.lastID;
      }

      if (!dbNodeId) {
        // fallback: try to find id by value
        const found = await getAsync('SELECT id FROM nodes WHERE value = ? LIMIT 1', [nodeValue]).catch(()=>null);
        if (found && found.id) dbNodeId = found.id;
      }

      if (dbNodeId) nodeIdMap[node.id || nodeValue] = dbNodeId;

      // replace child headers and technologies for this node id
      if (dbNodeId) {
        if (headerKey && headerVal) {
          await runAsync('DELETE FROM node_headers WHERE node_id = ?', [dbNodeId]).catch(()=>{});
          if (node.meta && node.meta.headers) {
            for (const [hk, hv] of Object.entries(node.meta.headers)) {
              const hcols = ['node_id', headerKey, headerVal];
              await runAsync(`INSERT INTO node_headers (${hcols.join(',')}) VALUES (?, ?, ?)`, [dbNodeId, hk, String(hv)]).catch(()=>{});
            }
          }
        }
        if (techCol) {
          await runAsync('DELETE FROM node_technologies WHERE node_id = ?', [dbNodeId]).catch(()=>{});
          if (Array.isArray(node.technologies)) {
            for (const t of node.technologies) {
              await runAsync(`INSERT INTO node_technologies (node_id, ${techCol}) VALUES (?, ?)`, [dbNodeId, String(t)]).catch(()=>{});
            }
          }
        }
      }
    }

    // Insert relationships (after nodes inserted)
    if (Array.isArray(viz.relationships)) {
      const relCols = await getTableColumns('node_relationships');
      if (relCols && relCols.length) {
        for (const rel of viz.relationships) {
          const src = nodeIdMap[rel.source];
          const tgt = nodeIdMap[rel.target];
          if (src && tgt) await runAsync('INSERT OR IGNORE INTO node_relationships (source_node_id, target_node_id, relationship_type) VALUES (?, ?, ?)', [src, tgt, rel.type || 'contains']);
        }
      }
    }

    await runAsync('COMMIT');
    console.log('Import completed successfully.');
  } catch (err) {
    await runAsync('ROLLBACK').catch(()=>{});
    throw err;
  }
}

(async () => {
  try {
    await importViz(vizPath);
  } catch (err) {
    console.error('Import failed:', err && err.message ? err.message : err);
    process.exitCode = 1;
  } finally {
    db.close();
  }
})();
