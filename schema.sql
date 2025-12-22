-- schema_fixed.sql
-- Drop existing tables if they exist
DROP TABLE IF EXISTS api_logs;
DROP TABLE IF EXISTS images;
DROP TABLE IF EXISTS system_stats;
DROP TABLE IF EXISTS reports;

-- Create tables in correct order

-- 1. Main reports table
CREATE TABLE IF NOT EXISTS reports (
    id TEXT PRIMARY KEY,
    report_id TEXT UNIQUE NOT NULL,
    server_name TEXT NOT NULL,
    ip_address TEXT,
    description TEXT,
    status TEXT NOT NULL CHECK (status IN ('on-progress', 'completed', 'pending', 'cancelled')),
    priority TEXT NOT NULL CHECK (priority IN ('critical', 'high', 'medium', 'low')),
    platform TEXT,
    evidence_images TEXT, -- JSON array untuk URL gambar
    created_by TEXT DEFAULT 'System',
    assigned_to TEXT,
    notes TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 2. Images table (foreign key ke reports)
CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    file_size INTEGER,
    mime_type TEXT,
    image_data TEXT, -- Base64 atau URL ke R2
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
);

-- 3. System stats table
CREATE TABLE IF NOT EXISTS system_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    total_reports INTEGER DEFAULT 0,
    active_issues INTEGER DEFAULT 0,
    completed_reports INTEGER DEFAULT 0,
    critical_issues INTEGER DEFAULT 0,
    avg_response_time INTEGER DEFAULT 0,
    last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 4. API logs table
CREATE TABLE IF NOT EXISTS api_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL,
    status_code INTEGER,
    response_time INTEGER,
    user_agent TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes untuk performa
CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_priority ON reports(priority);
CREATE INDEX IF NOT EXISTS idx_reports_timestamp ON reports(timestamp);
CREATE INDEX IF NOT EXISTS idx_reports_created_at ON reports(created_at);
CREATE INDEX IF NOT EXISTS idx_images_report_id ON images(report_id);
CREATE INDEX IF NOT EXISTS idx_api_logs_timestamp ON api_logs(timestamp);

-- Trigger untuk update otomatis
CREATE TRIGGER IF NOT EXISTS update_reports_timestamp 
AFTER UPDATE ON reports 
BEGIN
    UPDATE reports SET updated_at = CURRENT_TIMESTAMP WHERE id = NEW.id;
END;

-- Insert sample data untuk testing
INSERT OR IGNORE INTO reports (id, report_id, server_name, ip_address, description, status, priority, platform) VALUES
('rep_1', 'REP-2024-001', 'WEB-SVR-01', '192.168.1.10', 'Server overload during peak hours', 'on-progress', 'high', 'Zabbix'),
('rep_2', 'REP-2024-002', 'DB-SVR-01', '192.168.1.20', 'Database connection pool exhausted', 'completed', 'critical', 'Prometheus'),
('rep_3', 'REP-2024-003', 'API-SVR-01', '192.168.1.30', 'Increased latency in API responses', 'pending', 'medium', 'Grafana'),
('rep_4', 'REP-2024-004', 'CACHE-SVR-01', '192.168.1.40', 'Redis cache memory usage at 95%', 'on-progress', 'high', 'Zabbix'),
('rep_5', 'REP-2024-005', 'BACKUP-SVR-01', '192.168.1.50', 'Backup job failed - disk space issue', 'pending', 'low', 'Custom');

-- Insert sample images
INSERT OR IGNORE INTO images (id, report_id, filename, file_size, mime_type, image_data) VALUES
('img_1', 'rep_1', 'server-load.png', 102400, 'image/png', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='),
('img_2', 'rep_2', 'database-error.png', 153600, 'image/png', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==');

-- Initialize system stats
INSERT OR IGNORE INTO system_stats (id, total_reports, active_issues, completed_reports, critical_issues) VALUES
(1, 5, 3, 1, 1);

-- Print success message
SELECT 'Database schema created successfully!' as message;