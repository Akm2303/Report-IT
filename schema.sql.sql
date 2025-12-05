-- schema.sql
-- Database schema untuk IT Report System

-- Table: reports
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    server_name TEXT NOT NULL,
    ip_address TEXT,
    description TEXT,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    platform TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Table: images (untuk evidence screenshots)
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    data BLOB, -- Base64 encoded image
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

-- Table: system_stats (untuk dashboard)
CREATE TABLE IF NOT EXISTS system_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_reports INTEGER DEFAULT 0,
    active_issues INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index untuk performa
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_images_report ON images(report_id);

-- Insert initial stats
INSERT OR IGNORE INTO system_stats (id, total_reports, active_issues) VALUES (1, 0, 0);