const net = require('net');

function normalizeTarget(raw) {
  if (!raw) return '';
  let value = String(raw).trim();
  if (!value) return '';

  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) {
    value = `http://${value}`;
  }
  try {
    const parsed = new URL(value);
    const host = parsed.hostname;
    if (!host) return '';
    const port = parsed.port ? `:${parsed.port}` : '';
    return `${host}${port}`.toLowerCase();
  } catch (e) {
    return '';
  }
}

function isValidTarget(raw) {
  const input = String(raw || '').trim();
  if (!input) return false;

  // Reject paths/query/fragment in target input. Targets must be host/IP only.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(input)) {
    try {
      const parsed = new URL(input);
      if (parsed.username || parsed.password) return false;
      if (parsed.pathname && parsed.pathname !== '/') return false;
      if (parsed.search) return false;
      if (parsed.hash) return false;
    } catch (e) {
      return false;
    }
  } else {
    if (/[/?#]/.test(input)) return false;
  }

  const normalized = normalizeTarget(input);
  if (!normalized) return false;
  if (normalized.length > 255) return false;
  if (normalized.includes('/')) return false;
  if (normalized.includes('@')) return false;
  if (normalized.startsWith('.') || normalized.endsWith('.')) return false;
  const host = normalized.split(':')[0];
  if (net.isIP(host)) return true;
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (host.split('.').some(part => !part.length)) return false;
  return true;
}

module.exports = { normalizeTarget, isValidTarget };
