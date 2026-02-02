-- Schema for web reconnaissance results

-- Stores basic information about each scan
CREATE TABLE IF NOT EXISTS scans (
    scan_id TEXT PRIMARY KEY,
    target TEXT NOT NULL,
    timestamp_start TEXT NOT NULL,
    timestamp_end TEXT,
    duration REAL,
    status TEXT,
    risk_level TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Stores discovered subdomains
CREATE TABLE IF NOT EXISTS subdomains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    subdomain TEXT NOT NULL,
    status_code INTEGER,
    ip_address TEXT,
    is_active BOOLEAN,
    discovered_at TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id)
);

-- Stores discovered directories and files
CREATE TABLE IF NOT EXISTS directories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    path TEXT NOT NULL,
    status_code INTEGER,
    content_length INTEGER,
    content_type TEXT,
    discovered_at TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id)
);

-- Stores discovered vulnerabilities
CREATE TABLE IF NOT EXISTS vulnerabilities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    name TEXT NOT NULL,
    severity TEXT,
    description TEXT,
    url TEXT,
    details TEXT,  -- JSON field for additional details
    discovered_at TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id)
);

-- Stores detected technologies
CREATE TABLE IF NOT EXISTS technologies (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    name TEXT NOT NULL,
    version TEXT,
    category TEXT,
    website TEXT,
    discovered_at TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id)
);

-- Stores HTTP service information
CREATE TABLE IF NOT EXISTS http_services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    port INTEGER,
    service TEXT,
    version TEXT,
    ssl_enabled BOOLEAN,
    headers TEXT,  -- JSON field for headers
    discovered_at TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id)
);

 Stores interesting/sensitive files
CREATE TABLE IF NOT EXISTS interesting_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT,
    path TEXT NOT NULL,
    type TEXT,
    reason TEXT,
    discovered_at TEXT,
    FOREIGN KEY (scan_id) REFERENCES scans(scan_id)
);

-- Create indexes for better query performance
CREATE INDEX IF NOT EXISTS idx_scans_target ON scans(target);
CREATE INDEX IF NOT EXISTS idx_subdomains_scan_id ON subdomains(scan_id);
CREATE INDEX IF NOT EXISTS idx_directories_scan_id ON directories(scan_id);
CREATE INDEX IF NOT EXISTS idx_vulnerabilities_scan_id ON vulnerabilities(scan_id);
CREATE INDEX IF NOT EXISTS idx_technologies_scan_id ON technologies(scan_id);
CREATE INDEX IF NOT EXISTS idx_http_services_scan_id ON http_services(scan_id);CREATE INDEX IF NOT EXISTS idx_interesting_files_scan_id ON interesting_files(scan_id);
