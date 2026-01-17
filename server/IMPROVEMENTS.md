# Server Improvements Documentation

This document outlines the improvements made to the web recon server to enhance code quality, maintainability, and robustness.

## New Modules

### 1. **Database Module** (`modules/database.js`)
A promise-based wrapper around SQLite3 for better error handling and cleaner async/await patterns.

**Features:**
- Promise-based database operations
- Automatic error logging
- Transaction support
- Schema column management
- Index creation helpers

**Usage:**
```javascript
const Database = require('./modules/database');

const db = new Database('./data.db');
await db.init();

// Query operations
const row = await db.get('SELECT * FROM nodes WHERE id = ?', [1]);
const rows = await db.all('SELECT * FROM nodes WHERE website_id = ?', [123]);

// Schema operations
await db.addColumnIfNotExists('nodes', 'new_column TEXT');
await db.createIndexIfNotExists('idx_name', 'table_name', 'column_name');

// Transactions
await db.beginTransaction();
try {
  await db.run('INSERT INTO nodes ...');
  await db.commit();
} catch (err) {
  await db.rollback();
}
```

### 2. **Schema Module** (`modules/schema.js`)
Centralized schema definitions and initialization logic.

**Features:**
- Declarative schema definitions
- Automatic table and index creation
- Organized schema structure

**Usage:**
```javascript
const { initializeSchema } = require('./modules/schema');

await initializeSchema(db);
```

### 3. **Validation Module** (`modules/validation.js`)
API validation middleware and utilities for request validation.

**Features:**
- Target validation middleware
- Scan ID validation
- JSON content-type validation
- Query parameter validation factory
- Filename sanitization

**Usage:**
```javascript
const { validateTarget, validateScanId, validateJson } = require('./modules/validation');

app.use(validateJson);
app.post('/api/scans', validateTarget, (req, res) => {
  const target = req.normalizedTarget;
  // ...
});
```

### 4. **Logger Module** (`modules/logger.js`)
Structured logging with file support and color output.

**Features:**
- Multiple log levels (debug, info, warn, error)
- Console output with colors
- File logging support
- Configurable via environment variables
- Stack trace for errors

**Usage:**
```javascript
const Logger = require('./modules/logger');
const logger = Logger.default;

logger.info('Scan started', { target: 'example.com' });
logger.error('Database error', error);
logger.warn('High memory usage detected');
logger.debug('Query executed', { query: '...' });
```

### 5. **Error Handling Module** (`modules/errors.js`)
Centralized error handling utilities.

**Features:**
- Standard error response format
- `ApiError` class for custom errors
- Async handler wrapper
- Global error handler middleware
- 404 handler

**Usage:**
```javascript
const { sendError, asyncHandler, ApiError } = require('./modules/errors');

// Using asyncHandler for async routes
app.get('/api/data', asyncHandler(async (req, res) => {
  const data = await fetchData();
  res.json(data);
}));

// Throwing custom errors
throw new ApiError('Invalid target', 400, { field: 'target' });

// Sending error responses
sendError(res, 404, 'Not found');
```

### 6. **Route Helpers Module** (`modules/routeHelpers.js`)
Common utilities for route handlers.

**Features:**
- Progress calculation
- Elapsed time computation
- Pagination
- Filter building
- Sort building
- Byte formatting

**Usage:**
```javascript
const { computeProgress, paginate, buildFilters } = require('./modules/routeHelpers');

const progress = computeProgress(50, 'running');
// Returns: { done: 50, total: 51, percent: 98 }

const result = paginate(items, 0, 20);
// Returns: { items: [...], total: 100, page: 0, hasMore: true, ... }

const { where, params } = buildFilters({ status: 'completed', search: 'api' });
```

## Enhanced Modules

### Config Module (`config.js`)
**Improvements:**
- Added database configuration
- Added logging configuration
- Added PDF timeout configuration
- Configuration validation
- Better JSDoc comments
- More comprehensive settings

**New Configuration Options:**
```javascript
{
  nodeEnv: 'development',
  database: {
    path: './data.db',
    timeout: 30000
  },
  logging: {
    level: 'info',
    file: null
  },
  pdf: {
    timeout: 30000,
    allowNoSandbox: false
  }
}
```

### Validators Module (`validators.js`)
**Improvements:**
- Added `isValidScanId()` function
- Added `isValidEmail()` function
- Added `sanitizeString()` function
- Added `isValidPort()` function
- Comprehensive JSDoc comments
- Better validation logic

## Best Practices Implemented

### 1. **Error Handling**
- Centralized error handling with standard response format
- Proper HTTP status codes
- Detailed error logging
- Stack traces in development mode

### 2. **Validation**
- Input validation at the middleware level
- Consistent validation across endpoints
- Safe error messages (no data leaks)
- Schema-based validation

### 3. **Logging**
- Structured logging with timestamps
- Color-coded console output
- File logging support
- Environment-controlled log levels

### 4. **Security**
- Input sanitization
- Rate limiting (already in place)
- CORS validation (improved)
- SQL injection prevention via parameterized queries
- No sensitive data in error messages

### 5. **Code Organization**
- Separation of concerns
- Reusable utility modules
- Consistent patterns across modules
- Clear JSDoc documentation

### 6. **Database**
- Promise-based operations
- Transaction support
- Automatic schema migration
- Index management
- Connection pooling ready

## Environment Variables

New environment variables you can configure:

```bash
# Logging
LOG_LEVEL=info              # debug, info, warn, error
LOG_FILE=/var/log/app.log   # Optional log file path

# Database
DATABASE_PATH=./data.db     # Database file path
DATABASE_TIMEOUT_MS=30000   # Query timeout

# PDF
PDF_TIMEOUT_MS=30000        # PDF generation timeout
```

## Migration Guide

### For Existing Code Using index.js

The improvements are backward compatible. However, you can gradually migrate to the new modules:

**Before:**
```javascript
db.all('SELECT * FROM nodes WHERE website_id = ?', [id], (err, rows) => {
  if (err) {
    console.error('Error:', err);
    res.status(500).json({ error: err.message });
  } else {
    res.json(rows);
  }
});
```

**After:**
```javascript
try {
  const rows = await db.all('SELECT * FROM nodes WHERE website_id = ?', [id]);
  res.json(rows);
} catch (err) {
  logger.error('Database error', err);
  sendError(res, 500, 'Failed to fetch nodes');
}
```

## Future Improvements

1. **Connection Pooling**: Use a connection pool for better concurrent performance
2. **Caching**: Add Redis for caching frequently accessed data
3. **API Documentation**: Generate OpenAPI/Swagger documentation
4. **Testing**: Add unit and integration tests
5. **Monitoring**: Add metrics and performance monitoring
6. **GraphQL**: Consider GraphQL API for more flexible queries
7. **WebSockets**: Real-time updates for scan progress

## File Structure

```
server/
├── modules/
│   ├── database.js          (NEW) Database utility class
│   ├── schema.js            (NEW) Schema definitions
│   ├── validation.js        (NEW) Validation middleware
│   ├── logger.js            (NEW) Logging utility
│   ├── errors.js            (NEW) Error handling
│   ├── routeHelpers.js      (NEW) Route utilities
│   ├── dbIntegrity.js       (existing)
│   ├── directory-scanner.js (existing)
│   └── preflight.js         (existing)
├── routes/
│   └── report.js            (existing)
├── config.js                (IMPROVED)
├── validators.js            (IMPROVED)
├── index.js                 (existing, ready for migration)
└── package.json
```

## Testing the Improvements

```bash
# Start the server with debug logging
LOG_LEVEL=debug npm start

# Test an endpoint
curl -X POST http://localhost:3001/api/scans \
  -H "Content-Type: application/json" \
  -d '{"target": "example.com"}'

# Check logs
tail -f server.log
```

## Performance Notes

- Promise-based async/await is more efficient than callback chains
- Transaction support enables atomic operations
- Index management improves query performance
- Proper error handling prevents resource leaks

## Backward Compatibility

All improvements are **100% backward compatible** with existing code. You can:
- Use new modules alongside old code
- Gradually migrate to new patterns
- Keep existing callback-based code working
- Mix promises and callbacks as needed

## Contributing

When adding new features:
1. Use the new modules for validation, logging, and error handling
2. Follow the established JSDoc comment pattern
3. Add proper error handling
4. Use environment variables for configuration
5. Test with different log levels
6. Consider async/await patterns over callbacks
