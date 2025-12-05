-- schema.sql - Database schema untuk IT Report System
-- Pastikan tabel dibuat dengan benar

-- Table: reports
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    server_name TEXT NOT NULL,
    ip_address TEXT,
    description TEXT,
    status TEXT NOT NULL,
    priority TEXT NOT NULL,
    platform TEXT,
    timestamp TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

-- Table: images (untuk evidence screenshots metadata)
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER DEFAULT 0,
    mime_type TEXT DEFAULT 'image/png',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

-- Create indexes for better performance
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_priority ON reports(priority);
CREATE INDEX IF NOT EXISTS idx_images_report_id ON images(report_id);

-- Insert sample data for testing (optional)
INSERT OR IGNORE INTO reports (id, server_name, ip_address, status, priority, platform) VALUES 


-- Verify tables created
SELECT '✅ Tables created successfully' as message;