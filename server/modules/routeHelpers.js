/**
 * Common route utilities and helpers
 */

/**
 * Compute progress for a resource count
 * @param {number} done - Number of completed items
 * @param {string} status - Scan status
 * @returns {Object} - Progress object with done, total, and percent
 */
function computeProgress(done, status) {
  const base = Math.max(0, Number(done) || 0);
  const total = status === 'completed' ? base : base + 1;
  const percent = total === 0 ? 0 : Math.round((base / total) * 100);
  return { done: base, total, percent };
}

/**
 * Compute elapsed seconds between two timestamps
 * @param {string} startedAt - Start timestamp
 * @param {string} finishedAt - Finish timestamp (optional)
 * @returns {number|null} - Elapsed seconds or null if invalid
 */
function computeElapsedSeconds(startedAt, finishedAt) {
  if (!startedAt) return null;
  
  const start = new Date(startedAt).getTime();
  const end = finishedAt ? new Date(finishedAt).getTime() : Date.now();
  
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  
  return Math.max(0, Math.floor((end - start) / 1000));
}

/**
 * Format bytes to human-readable size
 * @param {number} bytes - Size in bytes
 * @returns {string} - Formatted size
 */
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(Math.abs(bytes)) / Math.log(k));
  
  return Math.round((bytes / Math.pow(k, i)) * 100) / 100 + ' ' + sizes[i];
}

/**
 * Paginate array results
 * @param {Array} items - Items to paginate
 * @param {number} page - Page number (0-indexed)
 * @param {number} limit - Items per page
 * @returns {Object} - Paginated result with items, total, and page info
 */
function paginate(items, page = 0, limit = 20) {
  const total = items.length;
  const offset = Math.max(0, page * limit);
  const paginatedItems = items.slice(offset, offset + limit);
  
  return {
    items: paginatedItems,
    total,
    page,
    limit,
    hasMore: offset + limit < total,
    totalPages: Math.ceil(total / limit)
  };
}

/**
 * Build filter parameters for database query
 * @param {Object} filters - Filter object
 * @returns {Object} - SQL WHERE clause and parameters
 */
function buildFilters(filters = {}) {
  const conditions = [];
  const params = [];
  
  if (filters.status) {
    conditions.push('status = ?');
    params.push(filters.status);
  }
  
  if (filters.type) {
    conditions.push('type = ?');
    params.push(filters.type);
  }
  
  if (filters.search) {
    conditions.push('value LIKE ?');
    params.push(`%${filters.search}%`);
  }
  
  if (filters.startDate) {
    conditions.push('created_at >= ?');
    params.push(filters.startDate);
  }
  
  if (filters.endDate) {
    conditions.push('created_at <= ?');
    params.push(filters.endDate);
  }
  
  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params
  };
}

/**
 * Build sorting parameters for database query
 * @param {string} sortBy - Sort field
 * @param {string} order - Sort order (asc/desc)
 * @returns {string} - SQL ORDER BY clause
 */
function buildSort(sortBy = 'created_at', order = 'desc') {
  const validFields = ['created_at', 'status', 'type', 'value'];
  const field = validFields.includes(sortBy) ? sortBy : 'created_at';
  const direction = order === 'asc' ? 'ASC' : 'DESC';
  
  return `ORDER BY ${field} ${direction}`;
}

module.exports = {
  computeProgress,
  computeElapsedSeconds,
  formatBytes,
  paginate,
  buildFilters,
  buildSort
};
