const net = require('net');

/**
 * Normalize target URL to hostname:port format
 * @param {*} raw - Raw target value
 * @returns {string} - Normalized hostname or empty string if invalid
 */
function normalizeTarget(raw) {
  if (!raw) return '';
  let value = String(raw).trim();
  if (!value) return '';

  // Add protocol if missing
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

/**
 * Validate if target is in correct format
 * Targets must be host/IP only without paths, query params, or credentials
 * @param {*} raw - Raw target value
 * @returns {boolean} - True if valid
 */
function isValidTarget(raw) {
  const input = String(raw || '').trim();
  if (!input) return false;

  // Validate URL format if protocol present
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
    // Reject invalid characters for raw hostnames
    if (/[/?#@]/.test(input)) return false;
  }

  const normalized = normalizeTarget(input);
  if (!normalized) return false;
  if (normalized.length > 255) return false;
  if (normalized.includes('/')) return false;
  if (normalized.includes('@')) return false;
  if (normalized.startsWith('.') || normalized.endsWith('.')) return false;

  const host = normalized.split(':')[0];
  
  // Check if it's an IP address
  if (net.isIP(host)) return true;
  
  // Check if it's a valid hostname
  if (!/^[a-z0-9.-]+$/.test(host)) return false;
  if (host.split('.').some(part => !part.length)) return false;
  
  return true;
}

/**
 * Validate scan ID format
 * @param {*} scanId - Scan ID to validate
 * @returns {boolean} - True if valid
 */
function isValidScanId(scanId) {
  const id = String(scanId || '').trim();
  if (!id) return false;
  
  // Accept UUID format or legacy format
  const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
  const isLegacy = /^legacy-\d+$/.test(id);
  
  return isUUID || isLegacy;
}

/**
 * Validate email format (for future use)
 * @param {*} email - Email to validate
 * @returns {boolean} - True if valid
 */
function isValidEmail(email) {
  const str = String(email || '').trim();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(str);
}

/**
 * Sanitize string to prevent injection attacks
 * @param {string} str - String to sanitize
 * @returns {string} - Sanitized string
 */
function sanitizeString(str) {
  return String(str || '')
    .replace(/[<>\"'&]/g, char => {
      const map = {
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#x27;',
        '&': '&amp;'
      };
      return map[char];
    });
}

/**
 * Validate port number
 * @param {*} port - Port number to validate
 * @returns {boolean} - True if valid
 */
function isValidPort(port) {
  const num = Number.parseInt(port, 10);
  return Number.isFinite(num) && num > 0 && num <= 65535;
}

module.exports = {
  normalizeTarget,
  isValidTarget,
  isValidScanId,
  isValidEmail,
  sanitizeString,
  isValidPort
};
