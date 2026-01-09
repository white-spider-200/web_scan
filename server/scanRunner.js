const { spawn, spawnSync } = require('child_process');
const path = require('path');

const runningScans = new Map();

function resolvePythonBinary() {
  const envBin = String(process.env.PYTHON_BIN || '').trim();
  if (envBin) return envBin;
  const candidates = ['python3', 'python'];
  for (const candidate of candidates) {
    try {
      const res = spawnSync(candidate, ['--version'], { timeout: 2000, windowsHide: true });
      if (!res.error) return candidate;
    } catch (e) {
      // ignore
    }
  }
  return 'python3';
}

const PYTHON_BIN = resolvePythonBinary();

function sanitizeLogLine(line) {
  if (!line) return '';
  let cleaned = line.replace(/\\/g, '/');
  cleaned = cleaned.replace(/\/home\/[^\\s]+/g, '[path]');
  cleaned = cleaned.replace(/[A-Za-z]:\\/g, '[path]/');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  if (cleaned.length > 160) cleaned = `${cleaned.slice(0, 157)}...`;
  return cleaned;
}

function stageLabelForKey(stageKey) {
  switch (stageKey) {
    case 'start': return 'Start';
    case 'subdomains': return 'Subdomains';
    case 'html_links': return 'HyperHTML';
    case 'js_routes': return 'JS Route Discovery';
    case 'dirs': return 'Directories';
    case 'fingerprint': return 'Fingerprint';
    case 'build_graph': return 'Build Graph / Save DB';
    case 'done': return 'Done';
    default: return stageKey;
  }
}

function updateProgress(db, scanId, status, message, stage, stageLabel, currentTarget, logTail) {
  const ts = new Date().toISOString();
  db.run(
    'INSERT OR REPLACE INTO scan_progress (scan_id, status, message, stage, stage_label, current_target, log_tail, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [scanId, status, message, stage, stageLabel, currentTarget, logTail, ts],
    () => {}
  );
  db.run('UPDATE scans SET last_update_at = ? WHERE scan_id = ?', [ts, scanId], () => {});
}

function parseStage(line) {
  const lower = line.toLowerCase();
  if (lower.includes('ffuf_subs')) return { stage: 'subdomains', label: 'Subdomain enumeration' };
  if (lower.includes('html_link_discovery')) return { stage: 'html_links', label: 'HTML link discovery' };
  if (lower.includes('js_route_discovery')) return { stage: 'js_routes', label: 'JS route discovery' };
  if (lower.includes('dirsearch')) return { stage: 'dirs', label: 'Directory discovery' };
  if (lower.includes('simple_fingerprint')) return { stage: 'fingerprint', label: 'Fingerprinting' };
  if (lower.includes('nmap')) return { stage: 'fingerprint', label: 'Nmap scan' };
  if (lower.includes('nmap_vuln')) return { stage: 'nmap_vuln', label: 'Nmap vulnerabilities' };
  if (lower.includes('nuclei')) return { stage: 'fingerprint', label: 'Nuclei scan' };
  if (lower.includes('clean_from_raw')) return { stage: 'build_graph', label: 'Cleaning results' };
  if (lower.includes('minmap_format')) return { stage: 'build_graph', label: 'Building graph' };
  if (lower.includes('import-visualized')) return { stage: 'build_graph', label: 'Importing visualization' };
  return { stage: '', label: '' };
}

function parseStageMarker(line) {
  const match = String(line || '').trim().match(/^\[stage\]\s+([a-z_]+)\s+(start|done|skip)$/i);
  if (!match) return null;
  const stage = match[1].toLowerCase();
  const state = match[2].toLowerCase();
  return { stage, state };
}

function detectStageStatus(line) {
  const lower = line.toLowerCase();
  if (lower.includes('subdomains timed out')) return { stage: 'subdomains', status: 'timed_out' };
  if (lower.includes('directories timed out')) return { stage: 'dirs', status: 'timed_out' };
  if (lower.includes('directories capped')) return { stage: 'dirs', status: 'capped' };
  return null;
}

function extractCurrentTarget(line) {
  const m = line.match(/Processing\\s+([A-Za-z0-9._:-]+)/i);
  if (m) return m[1];
  return '';
}

const logBuffers = new Map();

function pushLog(scanId, line) {
  if (!line) return [];
  const buf = logBuffers.get(scanId) || [];
  buf.push(line);
  while (buf.length > 8) buf.shift();
  logBuffers.set(scanId, buf);
  return buf;
}

function appendLogLine(db, scanId, line) {
  if (!line) return;
  const ts = new Date().toISOString();
  db.run(
    'INSERT INTO scan_logs (scan_id, ts, line) VALUES (?, ?, ?)',
    [scanId, ts, line],
    () => {}
  );
}

function finalizeStage(db, scanId, stageKey, entry, status) {
  if (!stageKey) return;
  if (entry.finalizedStages.has(stageKey)) return;
  const finishedAt = new Date().toISOString();
  const startedAt = entry.stageStarts.get(stageKey);
  const durationSeconds = startedAt ? Math.max(0, Math.floor((new Date(finishedAt) - new Date(startedAt)) / 1000)) : null;
  db.run(
    'UPDATE scan_stages SET status = ?, finished_at = ?, duration_seconds = ? WHERE scan_id = ? AND stage_key = ?',
    [status, finishedAt, durationSeconds, scanId, stageKey],
    () => {}
  );
  entry.finalizedStages.add(stageKey);
  console.log(`[${scanId}] stage=${stageKey} -> ${status}${durationSeconds != null ? ` (${durationSeconds}s)` : ''}`);
}

function markStageRunning(db, scanId, stageKey, label, entry) {
  if (!stageKey) return;
  if (entry.finalizedStages.has(stageKey)) return;
  const now = new Date().toISOString();
  if (entry.lastStage && entry.lastStage !== stageKey) {
    finalizeStage(db, scanId, entry.lastStage, entry, 'done');
  }
  entry.lastStage = stageKey;
  entry.lastStageLabel = label || entry.lastStageLabel;
  if (!entry.stageStarts.has(stageKey)) entry.stageStarts.set(stageKey, now);
  db.run(
    `INSERT INTO scan_stages (scan_id, stage_key, label, status, started_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scan_id, stage_key)
     DO UPDATE SET status = excluded.status, label = excluded.label, started_at = COALESCE(scan_stages.started_at, excluded.started_at)`,
    [scanId, stageKey, label || stageKey, 'running', now],
    () => {}
  );
  console.log(`[${scanId}] stage=${stageKey} -> running`);
}

function finalizeCancel(db, scanId, target, entry) {
  const finishedAt = new Date().toISOString();
  db.run(
    'UPDATE scans SET status = ?, finished_at = ?, cancelled_at = ? WHERE scan_id = ?',
    ['cancelled', finishedAt, finishedAt, scanId],
    () => {}
  );
  const stage = entry?.lastStage || 'start';
  const label = entry?.lastStageLabel || 'Cancelled';
  // cancellation finalization: persist cancelled status + progress
  updateProgress(db, scanId, 'cancelled', 'Scan cancelled by user', stage, label, target, '');
}

function killProcess(proc) {
  if (!proc || proc.killed) return;
  try {
    proc.kill('SIGTERM');
  } catch (e) {
    // ignore
  }
  setTimeout(() => {
    if (!proc.killed) {
      try {
        proc.kill('SIGKILL');
      } catch (e) {
        // ignore
      }
    }
  }, 3000);
}

function startScan({ db, scanId, target, options }) {
  const projectRoot = path.resolve(__dirname, '..');
  const runner = path.join(projectRoot, 'run_all.py');
  const args = ['-u', runner, target];

  const abortController = new AbortController();
  const entry = {
    abortController,
    processes: new Set(),
    cancelled: false,
    lastStage: 'start',
    lastStageLabel: 'Starting',
    stageStarts: new Map(),
    finalizedStages: new Set(),
    lastTarget: target,
    heartbeat: null,
    lastHeartbeatLog: Date.now()
  };
  runningScans.set(scanId, entry);

  markStageRunning(db, scanId, 'start', 'Starting', entry);
  updateProgress(db, scanId, 'running', 'Starting scan', 'start', 'Starting', target, '');
  db.run('UPDATE scans SET status = ? WHERE scan_id = ?', ['running', scanId], () => {});

  entry.heartbeat = setInterval(() => {
    if (entry.cancelled || abortController.signal.aborted) return;
    const tailLines = logBuffers.get(scanId) || [];
    updateProgress(db, scanId, 'running', entry.lastStageLabel || 'Running', entry.lastStage || 'start', entry.lastStageLabel || 'Running', entry.lastTarget || '', tailLines.join('\n'));
    const now = Date.now();
    if (now - entry.lastHeartbeatLog > 10_000) {
      console.log(`[${scanId}] stage=${entry.lastStage || 'start'} still running...`);
      entry.lastHeartbeatLog = now;
    }
  }, 2000);

  const proc = spawn(PYTHON_BIN, args, {
    cwd: projectRoot,
    env: { ...process.env, PYTHONUNBUFFERED: '1' }
  });
  entry.processes.add(proc);
  proc.on('error', (err) => {
    const finishedAt = new Date().toISOString();
    entry.processes.delete(proc);
    if (entry.heartbeat) {
      clearInterval(entry.heartbeat);
      entry.heartbeat = null;
    }
    const msg = err && err.code === 'ENOENT'
      ? `Failed to start scan runner: ${PYTHON_BIN} not found`
      : `Failed to start scan runner: ${err ? err.message : 'unknown error'}`;
    console.error(`[${scanId}] ${msg}`);
    finalizeStage(db, scanId, entry.lastStage, entry, 'failed');
    db.run('UPDATE scans SET status = ?, finished_at = ?, timestamp_end = ? WHERE scan_id = ?', ['failed', finishedAt, finishedAt, scanId], () => {});
    updateProgress(db, scanId, 'failed', msg, 'failed', 'Failed', target, '');
    runningScans.delete(scanId);
  });
  const handleLine = (line, isErr) => {
    const marker = parseStageMarker(line);
    if (marker) {
      const label = stageLabelForKey(marker.stage);
      if (marker.state === 'start') {
        markStageRunning(db, scanId, marker.stage, label, entry);
        updateProgress(db, scanId, 'running', `${label} running`, marker.stage, label, entry.lastTarget || '', (logBuffers.get(scanId) || []).join('\n'));
      } else {
        finalizeStage(db, scanId, marker.stage, entry, 'done');
        updateProgress(db, scanId, 'running', `${label} completed`, marker.stage, label, entry.lastTarget || '', (logBuffers.get(scanId) || []).join('\n'));
      }
      return;
    }

    const statusUpdate = detectStageStatus(line);
    if (statusUpdate?.stage) {
      finalizeStage(db, scanId, statusUpdate.stage, entry, statusUpdate.status);
    }

    const parsed = parseStage(line);
    if (statusUpdate?.stage) {
      parsed.stage = statusUpdate.stage;
      if (!parsed.label) parsed.label = statusUpdate.status === 'timed_out' ? 'Timed out' : 'Capped';
    }
    const currentTarget = extractCurrentTarget(line) || '';
    if (currentTarget) entry.lastTarget = currentTarget;
    const stageLabel = parsed.label || '';
    const stage = parsed.stage || '';
    if (stage && !statusUpdate && !entry.finalizedStages.has(stage)) {
      markStageRunning(db, scanId, stage, stageLabel, entry);
    }

    const logLine = sanitizeLogLine(line);
    if (logLine) {
      appendLogLine(db, scanId, logLine);
      pushLog(scanId, logLine);
    }
    const tailLines = logBuffers.get(scanId) || [];
    const message = stageLabel || logLine || (isErr ? 'Running (stderr)' : 'Running');
    if (stage || logLine) {
      updateProgress(db, scanId, 'running', message, stage, stageLabel, currentTarget, tailLines.join('\n'));
    }
  };

  proc.stdout.on('data', (data) => {
    if (entry.cancelled || abortController.signal.aborted) return;
    const text = data.toString();
    const lines = text.split(/\r?\n/).filter(Boolean);
    lines.forEach((line) => handleLine(line, false));
  });
  proc.stderr.on('data', (data) => {
    if (entry.cancelled || abortController.signal.aborted) return;
    const text = data.toString();
    const lines = text.split(/\r?\n/).filter(Boolean);
    lines.forEach((line) => handleLine(line, true));
  });
  proc.on('close', (code) => {
    const finishedAt = new Date().toISOString();
    entry.processes.delete(proc);
    if (entry.heartbeat) {
      clearInterval(entry.heartbeat);
      entry.heartbeat = null;
    }
    if (entry.cancelled || abortController.signal.aborted) {
      finalizeStage(db, scanId, entry.lastStage, entry, 'cancelled');
      finalizeCancel(db, scanId, target, entry);
      runningScans.delete(scanId);
      return;
    }
    if (code === 0) {
      finalizeStage(db, scanId, entry.lastStage, entry, 'done');
      markStageRunning(db, scanId, 'done', 'Done', entry);
      finalizeStage(db, scanId, 'done', entry, 'done');
      db.run('UPDATE scans SET status = ?, finished_at = ?, timestamp_end = ? WHERE scan_id = ?', ['completed', finishedAt, finishedAt, scanId], () => {});
      updateProgress(db, scanId, 'completed', 'Completed', 'done', 'Completed', target, '');
    } else {
      finalizeStage(db, scanId, entry.lastStage, entry, 'failed');
      db.run('UPDATE scans SET status = ?, finished_at = ?, timestamp_end = ? WHERE scan_id = ?', ['failed', finishedAt, finishedAt, scanId], () => {});
      updateProgress(db, scanId, 'failed', `Failed (exit ${code})`, 'failed', 'Failed', target, '');
    }
    db.get('SELECT id FROM websites WHERE url = ? LIMIT 1', [target], (err, row) => {
      if (!err && row && row.id) {
        db.run('UPDATE scans SET website_id = ? WHERE scan_id = ?', [row.id, scanId], () => {});
      }
    });
    runningScans.delete(scanId);
  });
}

function cancelScan({ db, scanId }) {
  const entry = runningScans.get(scanId);
  if (!entry) {
    return { ok: false, message: 'Scan not running' };
  }
  // cancellation request: abort and terminate active processes
  entry.cancelled = true;
  entry.abortController.abort();
  const tailLines = pushLog(scanId, 'Scan cancelled by user');
  updateProgress(db, scanId, 'cancelling', 'Cancelling', entry.lastStage || 'start', entry.lastStageLabel || 'Cancelling', '', tailLines.join('\n'));
  db.run('UPDATE scans SET status = ? WHERE scan_id = ?', ['cancelling', scanId], () => {});
  entry.processes.forEach((proc) => killProcess(proc));
  return { ok: true };
}

module.exports = { startScan, cancelScan, runningScans };
