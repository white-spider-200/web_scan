const fs = require('fs');
const path = require('path');

function runAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function allAsync(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function safeJsonParse(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  const text = String(value);
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function safeJsonStringify(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function chooseType(existingType, incomingType) {
  const a = (existingType || '').toLowerCase();
  const b = (incomingType || '').toLowerCase();
  if (!a) return incomingType || null;
  if (!b) return existingType;

  const rank = (t) => {
    switch (t) {
      case 'domain': return 50;
      case 'subdomain': return 45;
      case 'ip': return 40;
      case 'endpoint':
      case 'path':
      case 'file':
        return 30;
      case 'directory':
      case 'dir':
        return 20;
      case 'unknown': return 0;
      default: return 10;
    }
  };

  return rank(b) > rank(a) ? incomingType : existingType;
}

function mergeNodeRows(keepRow, otherRows) {
  const merged = { ...keepRow };
  const conflicts = {};

  const consider = (key, incoming, strategy = 'coalesce') => {
    if (incoming == null || incoming === '') return;
    const existing = merged[key];
    if (existing == null || existing === '') {
      merged[key] = incoming;
      return;
    }
    if (existing === incoming) return;

    const stashConflict = () => {
      conflicts[key] = conflicts[key] || [];
      conflicts[key].push(existing, incoming);
      conflicts[key] = Array.from(new Set(conflicts[key].map(String)));
    };

    if (strategy === 'max_number') {
      const a = Number(existing);
      const b = Number(incoming);
      if (Number.isFinite(a) && Number.isFinite(b) && b > a) merged[key] = incoming;
      stashConflict();
      return;
    }
    if (strategy === 'min_number') {
      const a = Number(existing);
      const b = Number(incoming);
      if (Number.isFinite(a) && Number.isFinite(b) && b < a) merged[key] = incoming;
      stashConflict();
      return;
    }
    stashConflict();
  };

  for (const row of otherRows) {
    merged.type = chooseType(merged.type, row.type);
    consider('status', row.status, 'coalesce');
    consider('size', row.size, 'max_number');
    consider('ip', row.ip, 'coalesce');
    consider('response_time_ms', row.response_time_ms, 'min_number');
    consider('title', row.title, 'coalesce');
    consider('ports', row.ports, 'coalesce');
    consider('tls_cert', row.tls_cert, 'coalesce');
    consider('dirsearch_count', row.dirsearch_count, 'max_number');
    consider('wappalyzer', row.wappalyzer, 'coalesce');
    consider('details', row.details, 'coalesce');
  }

  const baseDetails = safeJsonParse(keepRow.details) || {};
  const mergedFrom = [];
  for (const row of otherRows) {
    mergedFrom.push(row.id);
    const d = safeJsonParse(row.details);
    if (!d || typeof d !== 'object') continue;
    for (const [k, v] of Object.entries(d)) {
      if (baseDetails[k] === undefined) {
        baseDetails[k] = v;
      } else if (JSON.stringify(baseDetails[k]) !== JSON.stringify(v)) {
        conflicts.details = conflicts.details || [];
        conflicts.details.push(`${k}: ${safeJsonStringify(baseDetails[k])}`, `${k}: ${safeJsonStringify(v)}`);
        conflicts.details = Array.from(new Set(conflicts.details));
      }
    }
  }

  if (Object.keys(conflicts).length) {
    baseDetails._dedupe = baseDetails._dedupe || {};
    baseDetails._dedupe.conflicts = baseDetails._dedupe.conflicts || {};
    for (const [k, arr] of Object.entries(conflicts)) {
      baseDetails._dedupe.conflicts[k] = Array.from(new Set([...(baseDetails._dedupe.conflicts[k] || []), ...(arr || [])]));
    }
  }
  if (mergedFrom.length) {
    baseDetails._dedupe = baseDetails._dedupe || {};
    const existing = Array.isArray(baseDetails._dedupe.merged_from) ? baseDetails._dedupe.merged_from : [];
    baseDetails._dedupe.merged_from = Array.from(new Set(existing.concat(mergedFrom)));
    baseDetails._dedupe.merged_at = new Date().toISOString();
  }
  merged.details = safeJsonStringify(baseDetails);
  return merged;
}

async function hasUniqueIndexOnNodes(db) {
  const indexes = await allAsync(db, "PRAGMA index_list('nodes')");
  for (const idx of indexes) {
    if (!idx || !idx.name || !idx.unique) continue;
    const safeName = String(idx.name).replace(/'/g, "''");
    const info = await allAsync(db, `PRAGMA index_info('${safeName}')`);
    const cols = info.map((c) => c && c.name).filter(Boolean);
    if (cols.length === 2 && cols.includes('website_id') && cols.includes('value')) return true;
  }
  return false;
}

function backupDatabaseFile(dbPath) {
  if (!dbPath) return null;
  try {
    const dir = path.dirname(dbPath);
    const base = path.basename(dbPath);
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = path.join(dir, `${base}.bak-${ts}`);
    fs.copyFileSync(dbPath, backupPath);
    return backupPath;
  } catch {
    return null;
  }
}

async function ensureNodeValueUniqueness({ db, dbPath } = {}) {
  const result = {
    migrated: false,
    deduped_groups: 0,
    deduped_nodes: 0,
    created_unique_index: false,
    backup_path: null
  };

  if (!db) return result;
  const already = await hasUniqueIndexOnNodes(db);
  if (already) return result;

  const dupGroups = await allAsync(
    db,
    'SELECT website_id, value, COUNT(*) as cnt FROM nodes GROUP BY website_id, value HAVING cnt > 1'
  );

  result.backup_path = backupDatabaseFile(dbPath);

  await runAsync(db, 'BEGIN IMMEDIATE');
  try {
    for (const group of dupGroups) {
      const rows = await allAsync(
        db,
        'SELECT * FROM nodes WHERE website_id = ? AND value = ? ORDER BY id ASC',
        [group.website_id, group.value]
      );
      if (rows.length < 2) continue;
      const keep = rows[0];
      const dups = rows.slice(1);
      const merged = mergeNodeRows(keep, dups);

      const upCols = [
        'type',
        'status',
        'size',
        'ip',
        'response_time_ms',
        'title',
        'ports',
        'tls_cert',
        'dirsearch_count',
        'wappalyzer',
        'details'
      ];
      const sets = [];
      const params = [];
      for (const col of upCols) {
        if (merged[col] === undefined) continue;
        sets.push(`${col} = ?`);
        params.push(merged[col]);
      }
      if (sets.length) {
        await runAsync(db, `UPDATE nodes SET ${sets.join(', ')} WHERE id = ?`, params.concat([keep.id]));
      }

      for (const dup of dups) {
        await runAsync(db, 'UPDATE node_headers SET node_id = ? WHERE node_id = ?', [keep.id, dup.id]).catch(() => {});
        await runAsync(db, 'UPDATE node_technologies SET node_id = ? WHERE node_id = ?', [keep.id, dup.id]).catch(() => {});
        await runAsync(db, 'UPDATE node_vulnerabilities SET node_id = ? WHERE node_id = ?', [keep.id, dup.id]).catch(() => {});

        await runAsync(
          db,
          `INSERT OR IGNORE INTO node_relationships (source_node_id, target_node_id, relationship_type)
           SELECT ?, target_node_id, relationship_type FROM node_relationships WHERE source_node_id = ?`,
          [keep.id, dup.id]
        ).catch(() => {});
        await runAsync(
          db,
          `INSERT OR IGNORE INTO node_relationships (source_node_id, target_node_id, relationship_type)
           SELECT source_node_id, ?, relationship_type FROM node_relationships WHERE target_node_id = ?`,
          [keep.id, dup.id]
        ).catch(() => {});
        await runAsync(db, 'DELETE FROM node_relationships WHERE source_node_id = ? OR target_node_id = ?', [dup.id, dup.id]).catch(() => {});

        await runAsync(db, 'DELETE FROM nodes WHERE id = ?', [dup.id]).catch(() => {});
        result.deduped_nodes += 1;
      }
      result.deduped_groups += 1;
    }

    await runAsync(db, 'DELETE FROM node_relationships WHERE source_node_id = target_node_id').catch(() => {});
    await runAsync(db, 'CREATE UNIQUE INDEX IF NOT EXISTS ux_nodes_website_value ON nodes(website_id, value)');
    result.created_unique_index = true;
    await runAsync(db, 'COMMIT');
    result.migrated = true;
    return result;
  } catch (e) {
    await runAsync(db, 'ROLLBACK').catch(() => {});
    throw e;
  }
}

module.exports = { ensureNodeValueUniqueness };

