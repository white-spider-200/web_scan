const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const DEFAULT_TIMEOUT_MS = 4000;
const MIN_NODE = { major: 16, minor: 0, patch: 0 };
const MIN_PYTHON = { major: 3, minor: 8, patch: 0 };

function parseVersion(text) {
  const cleaned = String(text || '').trim();
  const m = cleaned.match(/(\d+)\.(\d+)\.(\d+)/) || cleaned.match(/(\d+)\.(\d+)/);
  if (!m) return null;
  const major = Number(m[1]);
  const minor = Number(m[2] || 0);
  const patch = Number(m[3] || 0);
  if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) return null;
  return { major, minor, patch, raw: m[0] };
}

function compareVersion(a, b) {
  if (!a || !b) return null;
  if (a.major !== b.major) return a.major > b.major ? 1 : -1;
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1;
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1;
  return 0;
}

function overallStatusFromChecks(checks) {
  if (checks.some((c) => c.status === 'fatal')) return 'fatal';
  if (checks.some((c) => c.status === 'degraded')) return 'degraded';
  return 'ok';
}

function normalizeOutput(stdout, stderr) {
  const out = String(stdout || '');
  const err = String(stderr || '');
  return `${out}${out && err ? '\n' : ''}${err}`.trim();
}

function runCommand(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => {
      const combined = normalizeOutput(stdout, stderr);
      if (!error) {
        return resolve({ ok: true, output: combined, error: null });
      }
      const code = error.code;
      const isMissing = code === 'ENOENT';
      const isTimeout = error.killed && error.signal === 'SIGTERM';
      resolve({
        ok: false,
        output: combined,
        error: {
          code: isMissing ? 'missing' : (isTimeout ? 'timeout' : 'error'),
          details: error.message
        }
      });
    });
  });
}

async function ensureWritableDir(dirPath) {
  try {
    await fs.promises.mkdir(dirPath, { recursive: true });
  } catch (e) {
    return { ok: false, details: `Failed to create directory: ${e.message}` };
  }

  const probeName = `.preflight_write_${Date.now()}_${Math.random().toString(16).slice(2)}.tmp`;
  const probePath = path.join(dirPath, probeName);
  try {
    await fs.promises.writeFile(probePath, 'ok', { flag: 'wx' });
    await fs.promises.unlink(probePath);
    return { ok: true, details: null };
  } catch (e) {
    return { ok: false, details: `Directory not writable: ${e.message}` };
  }
}

async function checkNodeVersion() {
  const current = parseVersion(process.version);
  if (!current) {
    return {
      name: 'node',
      status: 'fatal',
      required: true,
      impact: 'API server cannot run reliably',
      fix: `Install Node.js ${MIN_NODE.major}.${MIN_NODE.minor}+`,
      version: process.version
    };
  }
  const cmp = compareVersion(current, MIN_NODE);
  if (cmp === -1) {
    return {
      name: 'node',
      status: 'fatal',
      required: true,
      impact: 'API server uses newer Node APIs',
      fix: `Upgrade Node.js to ${MIN_NODE.major}.${MIN_NODE.minor}+`,
      version: current.raw
    };
  }
  return {
    name: 'node',
    status: 'ok',
    required: true,
    impact: 'Node runtime available',
    fix: '',
    version: current.raw
  };
}

async function checkPythonVersion() {
  const attempts = [
    { bin: 'python3', args: ['--version'] },
    { bin: 'python', args: ['--version'] }
  ];
  for (const attempt of attempts) {
    // eslint-disable-next-line no-await-in-loop
    const res = await runCommand(attempt.bin, attempt.args);
    if (!res.ok && res.error?.code === 'missing') continue;
    const v = parseVersion(res.output);
    if (!v) {
      return {
        name: 'python',
        status: 'fatal',
        required: true,
        impact: 'Scan runner requires Python 3',
        fix: `Install Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor}+ and ensure '${attempt.bin}' is on PATH`,
        version: res.output || null,
        details: res.ok ? 'Unable to parse Python version' : res.error?.details
      };
    }
    const cmp = compareVersion(v, MIN_PYTHON);
    if (cmp === -1) {
      return {
        name: 'python',
        status: 'fatal',
        required: true,
        impact: 'Scan runner requires a newer Python version',
        fix: `Upgrade Python to ${MIN_PYTHON.major}.${MIN_PYTHON.minor}+ (found ${v.raw})`,
        version: v.raw
      };
    }
    return {
      name: 'python',
      status: 'ok',
      required: true,
      impact: 'Python runtime available',
      fix: '',
      version: v.raw,
      binary: attempt.bin
    };
  }
  return {
    name: 'python',
    status: 'fatal',
    required: true,
    impact: 'Scan runner cannot start',
    fix: `Install Python ${MIN_PYTHON.major}.${MIN_PYTHON.minor}+ (python3 recommended)`
  };
}

async function checkExternalTool({ name, required, versionArgs, impactIfMissing, fixIfMissing }) {
  const res = await runCommand(name, versionArgs);
  if (res.ok) {
    const v = parseVersion(res.output);
    return {
      name,
      status: 'ok',
      required,
      impact: `${name} available`,
      fix: '',
      version: v ? v.raw : null,
      details: v ? null : (res.output ? 'Version output not parsed' : null)
    };
  }
  const missing = res.error?.code === 'missing';
  const status = required ? 'fatal' : 'degraded';
  return {
    name,
    status: missing ? status : status,
    required,
    impact: impactIfMissing,
    fix: fixIfMissing,
    version: null,
    details: missing ? 'Not found on PATH' : (res.output || res.error?.details || 'Failed to execute')
  };
}

async function checkDirsearch(projectRoot) {
  const expectedScript = path.join(projectRoot, 'recon', 'dirsearch', 'dirsearch.py');
  const scriptExists = fs.existsSync(expectedScript);
  if (scriptExists) {
    const pythonBins = ['python3', 'python'];
    for (const bin of pythonBins) {
      // eslint-disable-next-line no-await-in-loop
      const res = await runCommand(bin, [expectedScript, '--help'], { timeoutMs: DEFAULT_TIMEOUT_MS });
      if (!res.ok && res.error?.code === 'missing') continue;
      if (res.ok) {
        return {
          name: 'dirsearch',
          status: 'ok',
          required: false,
          impact: 'Directory discovery available',
          fix: '',
          version: null,
          details: 'Using bundled recon/dirsearch/dirsearch.py'
        };
      }
      return {
        name: 'dirsearch',
        status: 'degraded',
        required: false,
        impact: 'Directory discovery disabled',
        fix: 'Fix the bundled dirsearch script (or vendor a working copy under recon/dirsearch/dirsearch.py)',
        version: null,
        details: res.output || res.error?.details || 'dirsearch script failed to run'
      };
    }
  }

  const binRes = await runCommand('dirsearch', ['--version'], { timeoutMs: DEFAULT_TIMEOUT_MS });
  if (binRes.ok) {
    const v = parseVersion(binRes.output);
    return {
      name: 'dirsearch',
      status: 'degraded',
      required: false,
      impact: 'dirsearch is installed but not wired into this repo',
      fix: 'Vendor dirsearch under recon/dirsearch/dirsearch.py or adapt the runner to call the global dirsearch binary',
      version: v ? v.raw : null,
      details: 'Global dirsearch detected, but recon/dirsearch/dirsearch.py is missing'
    };
  }

  return {
    name: 'dirsearch',
    status: 'degraded',
    required: false,
    impact: 'Directory discovery disabled',
    fix: 'Install dirsearch or vendor it under recon/dirsearch/dirsearch.py',
    version: null,
    details: 'recon/dirsearch/dirsearch.py missing and dirsearch not found on PATH'
  };
}

async function checkSqlite(dbPath, db) {
  try {
    await fs.promises.access(dbPath, fs.constants.R_OK | fs.constants.W_OK);
  } catch (e) {
    return {
      name: 'sqlite',
      status: 'fatal',
      required: true,
      impact: 'Scan results cannot be stored',
      fix: `Ensure ${path.basename(dbPath)} exists and is readable/writable (or run the API once to initialize it)`,
      details: e.message
    };
  }

  if (db && typeof db.get === 'function') {
    const quick = await new Promise((resolve) => {
      db.get('PRAGMA quick_check', (err, row) => {
        if (err) return resolve({ ok: false, details: err.message });
        const val = row ? Object.values(row)[0] : null;
        if (String(val).toLowerCase() !== 'ok') return resolve({ ok: false, details: `quick_check=${val}` });
        resolve({ ok: true, details: null });
      });
    });
    if (!quick.ok) {
      return {
        name: 'sqlite',
        status: 'fatal',
        required: true,
        impact: 'SQLite database appears unhealthy',
        fix: 'Check file permissions/locks; consider rebuilding server/data.db',
        details: quick.details
      };
    }
  }

  return {
    name: 'sqlite',
    status: 'ok',
    required: true,
    impact: 'SQLite database available',
    fix: '',
    details: path.basename(dbPath)
  };
}

async function runPreflight({ projectRoot, dbPath, db } = {}) {
  const root = projectRoot || path.resolve(__dirname, '..', '..');
  const resolvedDbPath = dbPath || path.join(root, 'server', 'data.db');
  const resultsDir = path.join(root, 'results');
  const cleanDir = path.join(resultsDir, 'clean');

  const [
    nodeCheck,
    pythonCheck,
    resultsCheck,
    cleanCheck,
    sqliteCheck,
    ffufCheck,
    nmapCheck,
    nucleiCheck,
    dirsearchCheck
  ] = await Promise.all([
    checkNodeVersion(),
    checkPythonVersion(),
    (async () => {
      const w = await ensureWritableDir(resultsDir);
      return w.ok
        ? { name: 'results_dir', status: 'ok', required: true, impact: 'Writable', fix: '', path: resultsDir }
        : { name: 'results_dir', status: 'fatal', required: true, impact: 'Scan cannot write results', fix: `Fix permissions for ${resultsDir}`, details: w.details, path: resultsDir };
    })(),
    (async () => {
      const w = await ensureWritableDir(cleanDir);
      return w.ok
        ? { name: 'results_clean_dir', status: 'ok', required: true, impact: 'Writable', fix: '', path: cleanDir }
        : { name: 'results_clean_dir', status: 'fatal', required: true, impact: 'Scan cannot write cleaned results', fix: `Fix permissions for ${cleanDir}`, details: w.details, path: cleanDir };
    })(),
    checkSqlite(resolvedDbPath, db),
    checkExternalTool({
      name: 'ffuf',
      required: true,
      versionArgs: ['-V'],
      impactIfMissing: 'Subdomain enumeration disabled (scan cannot start)',
      fixIfMissing: 'Install ffuf and ensure it is on PATH'
    }),
    checkExternalTool({
      name: 'nmap',
      required: false,
      versionArgs: ['--version'],
      impactIfMissing: 'Port scanning disabled',
      fixIfMissing: 'Install nmap'
    }),
    checkExternalTool({
      name: 'nuclei',
      required: false,
      versionArgs: ['-version'],
      impactIfMissing: 'Template vulnerability scanning disabled',
      fixIfMissing: 'Install nuclei (projectdiscovery) and ensure templates are available'
    }),
    checkDirsearch(root)
  ]);

  const checks = [
    nodeCheck,
    pythonCheck,
    sqliteCheck,
    resultsCheck,
    cleanCheck,
    ffufCheck,
    dirsearchCheck,
    nmapCheck,
    nucleiCheck
  ];

  return {
    overall_status: overallStatusFromChecks(checks),
    checks,
    meta: {
      generated_at: new Date().toISOString(),
      hostname: os.hostname(),
      platform: `${os.platform()} ${os.release()}`
    }
  };
}

module.exports = { runPreflight };

