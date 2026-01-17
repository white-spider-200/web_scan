/**
 * Error handling utilities and middleware
 */

const Logger = require('./logger');
const logger = Logger.default;

/**
 * Standard error response format
 */
function sendError(res, status, message, details = null) {
  const response = {
    error: message,
    status: status,
    timestamp: new Date().toISOString()
  };
  
  if (details) {
    response.details = details;
  }
  
  return res.status(status).json(response);
}

/**
 * Wrap async route handlers to catch errors
 * @param {Function} fn - Route handler function
 * @returns {Function} - Wrapped handler
 */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      logger.error('Request handler error:', err);
      
      if (err.statusCode) {
        return sendError(res, err.statusCode, err.message, err.details);
      }
      
      if (err.message.includes('ENOENT')) {
        return sendError(res, 404, 'Resource not found');
      }
      
      if (err.message.includes('SQLITE')) {
        return sendError(res, 500, 'Database error', err.message);
      }
      
      sendError(res, 500, 'Internal server error');
    });
  };
}

/**
 * Custom error class for API errors
 */
class ApiError extends Error {
  constructor(message, statusCode = 500, details = null) {
    super(message);
    this.name = 'ApiError';
    this.statusCode = statusCode;
    this.details = details;
    Error.captureStackTrace(this, ApiError);
  }
}

/**
 * Global error handler middleware
 */
function errorHandler(err, req, res, next) {
  logger.error('Unhandled error:', err);
  
  if (err instanceof ApiError) {
    return sendError(res, err.statusCode, err.message, err.details);
  }
  
  if (err.statusCode) {
    return sendError(res, err.statusCode, err.message, err.details);
  }
  
  // Don't expose internal error details in production
  const isDevelopment = process.env.NODE_ENV !== 'production';
  const message = isDevelopment ? err.message : 'Internal server error';
  const details = isDevelopment ? err.stack : null;
  
  sendError(res, 500, message, details);
}

/**
 * 404 handler middleware
 */
function notFoundHandler(req, res) {
  sendError(res, 404, 'Endpoint not found', `${req.method} ${req.path}`);
}

module.exports = {
  sendError,
  asyncHandler,
  ApiError,
  errorHandler,
  notFoundHandler
};
