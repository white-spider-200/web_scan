/**
 * API validation middleware and utilities
 */

const { normalizeTarget, isValidTarget } = require('../validators');

/**
 * Middleware to validate JSON payloads
 */
function validateJson(req, res, next) {
  if (!req.is('json') && Object.keys(req.body || {}).length > 0) {
    return res.status(400).json({ error: 'Content-Type must be application/json' });
  }
  next();
}

/**
 * Middleware to validate scan ID format
 */
function validateScanId(req, res, next) {
  const scanId = req.params.scanId || req.query.scanId;
  if (!scanId) {
    return res.status(400).json({ error: 'scanId is required' });
  }
  
  // Validate scan ID format (UUID or legacy format)
  const isValidUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(scanId);
  const isLegacyFormat = /^legacy-\d+$/.test(scanId);
  
  if (!isValidUUID && !isLegacyFormat) {
    return res.status(400).json({ error: 'Invalid scanId format' });
  }
  
  req.scanId = scanId;
  next();
}

/**
 * Middleware to validate target parameter
 */
function validateTarget(req, res, next) {
  const rawTarget = String(req.body?.target || req.query?.target || '').trim();
  
  if (!rawTarget) {
    return res.status(400).json({ error: 'target is required' });
  }
  
  if (!isValidTarget(rawTarget)) {
    return res.status(400).json({
      error: 'Invalid target',
      message: 'Expected a hostname or IP without paths, query params, or credentials'
    });
  }
  
  const normalized = normalizeTarget(rawTarget);
  req.normalizedTarget = normalized;
  next();
}

/**
 * Sanitize filename for safe output
 * @param {string} str - Filename to sanitize
 * @returns {string} - Safe filename
 */
function sanitizeFilename(str) {
  return String(str || '')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 255);
}

/**
 * Validate and sanitize request query parameters
 * @param {Object} query - Query parameters
 * @param {Object} schema - Validation schema
 * @returns {Object} - Validated parameters
 */
function validateQuery(query, schema) {
  const result = {};
  
  for (const [key, rules] of Object.entries(schema || {})) {
    const value = query[key];
    
    if (rules.required && !value) {
      throw new Error(`${key} is required`);
    }
    
    if (value && rules.type === 'number') {
      const num = Number.parseInt(value, 10);
      if (!Number.isFinite(num) || num < 0) {
        throw new Error(`${key} must be a non-negative number`);
      }
      result[key] = num;
    } else if (value && rules.type === 'string') {
      if (typeof value !== 'string') {
        throw new Error(`${key} must be a string`);
      }
      result[key] = value.trim();
    } else {
      result[key] = value;
    }
  }
  
  return result;
}

/**
 * Create a validation middleware factory
 * @param {Object} schema - Validation schema
 * @returns {Function} - Express middleware
 */
function createValidationMiddleware(schema) {
  return (req, res, next) => {
    try {
      const validated = validateQuery(req.query, schema);
      req.validated = validated;
      next();
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  };
}

module.exports = {
  validateJson,
  validateScanId,
  validateTarget,
  sanitizeFilename,
  validateQuery,
  createValidationMiddleware
};
