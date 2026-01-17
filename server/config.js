const DEFAULT_CORS_ORIGINS = [
  'http://localhost:3000',
  'http://localhost:5500'
];

/**
 * Parse integer from environment variable with fallback
 * @param {*} value - Environment variable value
 * @param {number} fallback - Fallback value if parsing fails
 * @returns {number} - Parsed integer
 */
function parseNumber(value, fallback) {
  const n = Number.parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Parse CORS origins from environment variable
 * @param {string} raw - Raw CORS origins string
 * @returns {Object} - CORS configuration
 */
function parseCorsOrigins(raw) {
  if (!raw) return { allowAll: false, origins: DEFAULT_CORS_ORIGINS };
  const trimmed = String(raw).trim();
  if (trimmed === '*') return { allowAll: true, origins: [] };
  const origins = trimmed
    .split(',')
    .map(o => o.trim())
    .filter(Boolean);
  return { allowAll: false, origins: origins.length ? origins : DEFAULT_CORS_ORIGINS };
}

const corsConfig = parseCorsOrigins(process.env.CORS_ORIGINS);

const config = {
  // Server configuration
  port: parseNumber(process.env.PORT, 3001),
  nodeEnv: process.env.NODE_ENV || 'development',
  bodyLimit: process.env.BODY_LIMIT || '1mb',
  
  // CORS configuration
  cors: corsConfig,
  
  // Rate limiting
  rateLimit: {
    windowMs: parseNumber(process.env.RATE_LIMIT_WINDOW_MS, 60_000),
    max: parseNumber(process.env.RATE_LIMIT_MAX, 300)
  },
  
  // Scan-specific rate limiting
  scanRateLimit: {
    windowMs: parseNumber(process.env.SCAN_RATE_LIMIT_WINDOW_MS, 60_000),
    max: parseNumber(process.env.SCAN_RATE_LIMIT_MAX, 10)
  },
  
  // Report-specific rate limiting
  reportRateLimit: {
    windowMs: parseNumber(process.env.REPORT_RATE_LIMIT_WINDOW_MS, 60_000),
    max: parseNumber(process.env.REPORT_RATE_LIMIT_MAX, 30)
  },
  
  // PDF generation
  pdf: {
    allowNoSandbox: String(process.env.PDF_ALLOW_NO_SANDBOX || '').toLowerCase() === 'true',
    timeout: parseNumber(process.env.PDF_TIMEOUT_MS, 30_000)
  },
  
  // Database
  database: {
    path: process.env.DATABASE_PATH || 'data.db',
    timeout: parseNumber(process.env.DATABASE_TIMEOUT_MS, 30_000)
  },
  
  // Logging
  logging: {
    level: process.env.LOG_LEVEL || 'info',
    file: process.env.LOG_FILE || null
  }
};

// Validate configuration
function validateConfig() {
  const errors = [];
  
  if (config.port < 1 || config.port > 65535) {
    errors.push('Invalid port number');
  }
  
  if (config.rateLimit.max < 1) {
    errors.push('Invalid rate limit max');
  }
  
  if (config.scanRateLimit.max < 1) {
    errors.push('Invalid scan rate limit max');
  }
  
  if (errors.length > 0) {
    throw new Error('Configuration validation failed: ' + errors.join(', '));
  }
}

validateConfig();

module.exports = config;
