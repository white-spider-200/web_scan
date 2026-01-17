/**
 * Centralized logging module
 */

const fs = require('fs');
const path = require('path');

class Logger {
  constructor(options = {}) {
    this.level = options.level || 'info'; // debug, info, warn, error
    this.logFile = options.logFile || null;
    this.colors = {
      reset: '\x1b[0m',
      red: '\x1b[31m',
      yellow: '\x1b[33m',
      blue: '\x1b[34m',
      gray: '\x1b[90m'
    };
  }

  /**
   * Get timestamp
   * @returns {string}
   */
  getTimestamp() {
    return new Date().toISOString();
  }

  /**
   * Get log level number for comparison
   * @param {string} level
   * @returns {number}
   */
  getLevelNumber(level) {
    const levels = { debug: 0, info: 1, warn: 2, error: 3 };
    return levels[level] || 1;
  }

  /**
   * Should log this level
   * @param {string} level
   * @returns {boolean}
   */
  shouldLog(level) {
    return this.getLevelNumber(level) >= this.getLevelNumber(this.level);
  }

  /**
   * Format log message
   * @param {string} level
   * @param {string} message
   * @param {*} data
   * @returns {string}
   */
  formatMessage(level, message, data) {
    const timestamp = this.getTimestamp();
    const levelStr = level.toUpperCase().padEnd(5);
    let msg = `[${timestamp}] ${levelStr} ${message}`;
    
    if (data) {
      if (typeof data === 'string') {
        msg += ` ${data}`;
      } else if (data instanceof Error) {
        msg += ` ${data.message}`;
        if (data.stack) {
          msg += `\n${data.stack}`;
        }
      } else {
        try {
          msg += ` ${JSON.stringify(data)}`;
        } catch (e) {
          msg += ` [Unable to serialize data]`;
        }
      }
    }
    
    return msg;
  }

  /**
   * Write log to file
   * @param {string} message
   * @returns {void}
   */
  writeToFile(message) {
    if (!this.logFile) return;
    
    try {
      const dir = path.dirname(this.logFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.appendFileSync(this.logFile, message + '\n');
    } catch (err) {
      console.error('Failed to write to log file:', err.message);
    }
  }

  /**
   * Log message at specified level
   * @param {string} level
   * @param {string} message
   * @param {*} data
   */
  log(level, message, data) {
    if (!this.shouldLog(level)) return;
    
    const formatted = this.formatMessage(level, message, data);
    
    // Write to console with color
    const color = {
      debug: this.colors.gray,
      info: this.colors.blue,
      warn: this.colors.yellow,
      error: this.colors.red
    }[level] || '';
    
    console.log(color + formatted + this.colors.reset);
    
    // Write to file
    this.writeToFile(formatted);
  }

  /**
   * Log debug message
   * @param {string} message
   * @param {*} data
   */
  debug(message, data) {
    this.log('debug', message, data);
  }

  /**
   * Log info message
   * @param {string} message
   * @param {*} data
   */
  info(message, data) {
    this.log('info', message, data);
  }

  /**
   * Log warning message
   * @param {string} message
   * @param {*} data
   */
  warn(message, data) {
    this.log('warn', message, data);
  }

  /**
   * Log error message
   * @param {string} message
   * @param {*} data
   */
  error(message, data) {
    this.log('error', message, data);
  }
}

// Create default logger instance
const defaultLogger = new Logger({
  level: process.env.LOG_LEVEL || 'info',
  logFile: process.env.LOG_FILE || null
});

module.exports = Logger;
module.exports.default = defaultLogger;
