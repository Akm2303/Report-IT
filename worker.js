// worker.js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    
    // CORS headers untuk semua response
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-API-Key',
      'Access-Control-Max-Age': '86400',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { 
        headers: corsHeaders,
        status: 204 
      });
    }

    // API Key validation (opsional untuk production)
    const apiKey = request.headers.get('X-API-Key');
    const isPublicEndpoint = path.startsWith('/api/health') || path === '/' || path.includes('.html');
    
    if (!isPublicEndpoint && env.API_KEY && apiKey !== env.API_KEY) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unauthorized',
        message: 'Valid API key required'
      }), {
        status: 401,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }

    // Log API request
    const startTime = Date.now();
    
    try {
      let response;
      
      // Route API requests
      if (path === '/api/health' && request.method === 'GET') {
        response = await handleHealthCheck(env.DB);
      } else if (path === '/api/reports' && request.method === 'GET') {
        response = await handleGetReports(request, env.DB);
      } else if (path === '/api/reports' && request.method === 'POST') {
        response = await handleCreateReport(request, env.DB);
      } else if (path.startsWith('/api/reports/') && request.method === 'GET') {
        const id = path.split('/').pop();
        response = await handleGetReport(id, env.DB);
      } else if (path.startsWith('/api/reports/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        response = await handleDeleteReport(id, env.DB);
      } else if (path === '/api/reports/search' && request.method === 'GET') {
        response = await handleSearchReports(request, env.DB);
      } else if (path === '/api/stats' && request.method === 'GET') {
        response = await handleGetStats(env.DB);
      } else if (path === '/api/analytics' && request.method === 'GET') {
        response = await handleGetAnalytics(request, env.DB);
      } else if (path === '/api/upload' && request.method === 'POST') {
        response = await handleUploadImage(request, env.DB, env.R2_BUCKET);
      } else if (path.startsWith('/api/images/')) {
        const id = path.split('/').pop();
        response = await handleGetImage(id, env.DB, env.R2_BUCKET);
      } else if (path === '/' || path === '/index.html') {
        response = await serveFrontend();
      } else {
        response = new Response('Not Found', { 
          status: 404,
          headers: { 'Content-Type': 'text/plain', ...corsHeaders }
        });
      }

      // Add CORS headers to response
      const newHeaders = new Headers(response.headers);
      Object.entries(corsHeaders).forEach(([key, value]) => {
        newHeaders.set(key, value);
      });

      // Calculate response time
      const responseTime = Date.now() - startTime;
      
      // Log successful request (async - don't wait)
      ctx.waitUntil(logRequest(
        env.DB, 
        path, 
        request.method, 
        response.status, 
        responseTime,
        request.headers.get('user-agent')
      ));

      return new Response(response.body, {
        status: response.status,
        headers: newHeaders
      });

    } catch (error) {
      console.error('API Error:', error);
      
      // Log error (async)
      ctx.waitUntil(logRequest(
        env.DB, 
        path, 
        request.method, 
        500, 
        Date.now() - startTime,
        request.headers.get('user-agent')
      ));

      return new Response(JSON.stringify({
        success: false,
        error: 'Internal Server Error',
        message: error.message,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { 
          'Content-Type': 'application/json',
          ...corsHeaders 
        }
      });
    }
  },
};

// ============ API HANDLERS ============

// 1. Health Check Endpoint
async function handleHealthCheck(db) {
  try {
    // Test database connection
    const dbTest = await db.prepare('SELECT 1 as test').first();
    
    // Get system info
    const stats = await db.prepare(`
      SELECT 
        COUNT(*) as total_reports,
        COUNT(CASE WHEN status IN ('on-progress', 'pending') THEN 1 END) as active_issues,
        (SELECT COUNT(*) FROM images) as total_images
      FROM reports
    `).first();

    return new Response(JSON.stringify({
      success: true,
      healthy: true,
      status: 'operational',
      database: dbTest ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
      system: {
        reports: stats?.total_reports || 0,
        active_issues: stats?.active_issues || 0,
        images: stats?.total_images || 0
      },
      version: '1.0.0',
      environment: 'production'
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({
      success: false,
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// 2. GET All Reports with filtering
async function handleGetReports(request, db) {
  try {
    const url = new URL(request.url);
    const params = url.searchParams;
    
    const limit = parseInt(params.get('limit')) || 50;
    const offset = parseInt(params.get('offset')) || 0;
    const status = params.get('status');
    const priority = params.get('priority');
    
    let query = `
      SELECT 
        r.*,
        COALESCE((SELECT COUNT(*) FROM images WHERE report_id = r.id), 0) as image_count,
        COALESCE((SELECT filename FROM images WHERE report_id = r.id ORDER BY created_at LIMIT 1), '') as preview_image
      FROM reports r
      WHERE 1=1
    `;
    
    const queryParams = [];
    
    if (status) {
      query += ` AND r.status = ?`;
      queryParams.push(status);
    }
    
    if (priority) {
      query += ` AND r.priority = ?`;
      queryParams.push(priority);
    }
    
    query += ` ORDER BY r.timestamp DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);
    
    const reports = await db.prepare(query).bind(...queryParams).all();
    
    // Get total count for pagination
    let countQuery = `SELECT COUNT(*) as total FROM reports WHERE 1=1`;
    const countParams = [];
    
    if (status) {
      countQuery += ` AND status = ?`;
      countParams.push(status);
    }
    
    if (priority) {
      countQuery += ` AND priority = ?`;
      countParams.push(priority);
    }
    
    const total = await db.prepare(countQuery).bind(...countParams).first();
    
    return new Response(JSON.stringify({
      success: true,
      data: reports.results || [],
      meta: {
        total: total?.total || 0,
        limit,
        offset,
        has_more: (offset + limit) < (total?.total || 0)
      },
      filters: {
        status,
        priority
      },
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error(`Failed to get reports: ${error.message}`);
  }
}

// 3. CREATE New Report
async function handleCreateReport(request, db) {
  try {
    const data = await request.json();
    
    // Validation
    const requiredFields = ['server_name', 'status', 'priority'];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Missing required fields',
        missing: missingFields,
        message: `Required: ${missingFields.join(', ')}`
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Generate IDs
    const id = `rep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const reportId = `REP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const timestamp = new Date().toISOString();
    
    // Insert report
    const result = await db.prepare(`
      INSERT INTO reports (
        id, report_id, server_name, ip_address, description, 
        status, priority, platform, created_by, timestamp, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      reportId,
      data.server_name,
      data.ip_address || '',
      data.description || '',
      data.status,
      data.priority,
      data.platform || '',
      data.created_by || 'System',
      data.timestamp || timestamp,
      timestamp
    ).run();
    
    if (result.success) {
      // Get the created report
      const createdReport = await db.prepare(`
        SELECT * FROM reports WHERE id = ?
      `).bind(id).first();
      
      // Update system stats
      await updateSystemStats(db);
      
      return new Response(JSON.stringify({
        success: true,
        message: 'Report created successfully',
        data: createdReport,
        report_id: reportId,
        id: id,
        timestamp: timestamp
      }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      throw new Error('Database insertion failed');
    }
  } catch (error) {
    throw new Error(`Failed to create report: ${error.message}`);
  }
}

// 4. GET Single Report
async function handleGetReport(id, db) {
  try {
    // Get report details
    const report = await db.prepare(`
      SELECT * FROM reports WHERE id = ?
    `).bind(id).first();
    
    if (!report) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Report not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Get associated images
    const images = await db.prepare(`
      SELECT id, filename, file_size, mime_type, created_at 
      FROM images 
      WHERE report_id = ?
      ORDER BY created_at
    `).bind(id).all();
    
    return new Response(JSON.stringify({
      success: true,
      data: {
        ...report,
        images: images.results || []
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error(`Failed to get report: ${error.message}`);
  }
}

// 5. DELETE Report
async function handleDeleteReport(id, db) {
  try {
    // First, delete associated images
    await db.prepare(`
      DELETE FROM images WHERE report_id = ?
    `).bind(id).run();
    
    // Then delete the report
    const result = await db.prepare(`
      DELETE FROM reports WHERE id = ?
    `).bind(id).run();
    
    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Report not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Update system stats
    await updateSystemStats(db);
    
    return new Response(JSON.stringify({
      success: true,
      message: 'Report deleted successfully',
      deleted: result.meta.changes
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error(`Failed to delete report: ${error.message}`);
  }
}

// 6. SEARCH Reports
async function handleSearchReports(request, db) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    
    if (!query || query.trim().length < 2) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Search query must be at least 2 characters'
      }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    const searchTerm = `%${query}%`;
    
    const results = await db.prepare(`
      SELECT 
        id, report_id, server_name, ip_address, 
        description, status, priority, timestamp
      FROM reports 
      WHERE 
        server_name LIKE ? OR
        ip_address LIKE ? OR
        description LIKE ? OR
        report_id LIKE ?
      ORDER BY timestamp DESC
      LIMIT 20
    `).bind(searchTerm, searchTerm, searchTerm, searchTerm).all();
    
    return new Response(JSON.stringify({
      success: true,
      query: query,
      results: results.results || [],
      count: results.results?.length || 0,
      timestamp: new Date().toISOString()
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error(`Search failed: ${error.message}`);
  }
}

// 7. GET System Statistics
async function handleGetStats(db) {
  try {
    // Get comprehensive statistics
    const stats = await db.prepare(`
      SELECT 
        COUNT(*) as total_reports,
        COUNT(CASE WHEN status = 'on-progress' THEN 1 END) as on_progress,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'cancelled' THEN 1 END) as cancelled,
        COUNT(CASE WHEN priority = 'critical' THEN 1 END) as critical,
        COUNT(CASE WHEN priority = 'high' THEN 1 END) as high,
        COUNT(CASE WHEN priority = 'medium' THEN 1 END) as medium,
        COUNT(CASE WHEN priority = 'low' THEN 1 END) as low,
        (SELECT COUNT(*) FROM images) as total_images,
        (SELECT COUNT(DISTINCT DATE(created_at)) FROM reports) as active_days
      FROM reports
    `).first();
    
    // Get recent activity
    const recent = await db.prepare(`
      SELECT 
        COUNT(*) as reports_today,
        COUNT(DISTINCT server_name) as unique_servers_today
      FROM reports 
      WHERE DATE(created_at) = DATE('now')
    `).first();
    
    // Get platform distribution
    const platforms = await db.prepare(`
      SELECT 
        platform,
        COUNT(*) as count
      FROM reports 
      WHERE platform IS NOT NULL AND platform != ''
      GROUP BY platform
      ORDER BY count DESC
    `).all();
    
    // Get status timeline (last 7 days)
    const timeline = await db.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(*) as total,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
      FROM reports 
      WHERE created_at >= DATE('now', '-7 days')
      GROUP BY DATE(created_at)
      ORDER BY date
    `).all();
    
    return new Response(JSON.stringify({
      success: true,
      data: {
        overview: stats || {},
        activity: recent || {},
        platforms: platforms.results || [],
        timeline: timeline.results || [],
        timestamp: new Date().toISOString()
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error(`Failed to get stats: ${error.message}`);
  }
}

// 8. GET Advanced Analytics
async function handleGetAnalytics(request, db) {
  try {
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get('days')) || 30;
    
    // Response time trends
    const responseTimes = await db.prepare(`
      SELECT 
        DATE(created_at) as date,
        AVG(CASE 
          WHEN status = 'completed' 
          THEN (julianday(updated_at) - julianday(created_at)) * 24 * 60 
          ELSE NULL 
        END) as avg_response_minutes
      FROM reports 
      WHERE created_at >= DATE('now', ?)
      GROUP BY DATE(created_at)
      ORDER BY date
    `).bind(`-${days} days`).all();
    
    // Priority distribution over time
    const priorityTrends = await db.prepare(`
      SELECT 
        DATE(created_at) as date,
        COUNT(CASE WHEN priority = 'critical' THEN 1 END) as critical,
        COUNT(CASE WHEN priority = 'high' THEN 1 END) as high,
        COUNT(CASE WHEN priority = 'medium' THEN 1 END) as medium,
        COUNT(CASE WHEN priority = 'low' THEN 1 END) as low
      FROM reports 
      WHERE created_at >= DATE('now', ?)
      GROUP BY DATE(created_at)
      ORDER BY date
    `).bind(`-${days} days`).all();
    
    // Server with most incidents
    const topServers = await db.prepare(`
      SELECT 
        server_name,
        COUNT(*) as incident_count,
        COUNT(CASE WHEN priority = 'critical' THEN 1 END) as critical_count
      FROM reports 
      GROUP BY server_name
      ORDER BY incident_count DESC
      LIMIT 10
    `).all();
    
    // Hourly distribution
    const hourlyDistribution = await db.prepare(`
      SELECT 
        strftime('%H', created_at) as hour,
        COUNT(*) as count
      FROM reports
      WHERE created_at >= DATE('now', ?)
      GROUP BY strftime('%H', created_at)
      ORDER BY hour
    `).bind(`-${days} days`).all();
    
    return new Response(JSON.stringify({
      success: true,
      data: {
        response_times: responseTimes.results || [],
        priority_trends: priorityTrends.results || [],
        top_servers: topServers.results || [],
        hourly_distribution: hourlyDistribution.results || [],
        period_days: days,
        timestamp: new Date().toISOString()
      }
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    throw new Error(`Failed to get analytics: ${error.message}`);
  }
}

// 9. UPLOAD Image (using R2 for production, fallback to base64)
async function handleUploadImage(request, db, r2Bucket) {
  try {
    const contentType = request.headers.get('content-type');
    
    if (contentType.includes('application/json')) {
      // Base64 upload (for small images or testing)
      const data = await request.json();
      
      if (!data.report_id || !data.image_data || !data.filename) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: report_id, image_data, filename'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Validate report exists
      const report = await db.prepare(`
        SELECT id FROM reports WHERE id = ?
      `).bind(data.report_id).first();
      
      if (!report) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Report not found'
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Save to database (base64)
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      await db.prepare(`
        INSERT INTO images (id, report_id, filename, file_size, mime_type, image_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        imageId,
        data.report_id,
        data.filename,
        data.file_size || 0,
        data.mime_type || 'image/png',
        data.image_data, // base64 string
        new Date().toISOString()
      ).run();
      
      return new Response(JSON.stringify({
        success: true,
        id: imageId,
        filename: data.filename,
        message: 'Image uploaded successfully (base64)'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
      
    } else if (contentType.includes('multipart/form-data')) {
      // R2 upload for production
      if (!r2Bucket) {
        return new Response(JSON.stringify({
          success: false,
          error: 'R2 bucket not configured'
        }), {
          status: 501,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      const formData = await request.formData();
      const reportId = formData.get('report_id');
      const file = formData.get('file');
      
      if (!reportId || !file) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required fields: report_id, file'
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
      
      // Generate unique filename
      const filename = `${reportId}_${Date.now()}_${file.name}`;
      
      // Upload to R2
      await r2Bucket.put(filename, file);
      
      // Get R2 URL
      const r2Url = `https://pub-${env.R2_ACCOUNT_ID}.r2.dev/${filename}`;
      
      // Save metadata to database
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      await db.prepare(`
        INSERT INTO images (id, report_id, filename, file_size, mime_type, image_data, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        imageId,
        reportId,
        file.name,
        file.size,
        file.type,
        r2Url, // Store R2 URL instead of base64
        new Date().toISOString()
      ).run();
      
      return new Response(JSON.stringify({
        success: true,
        id: imageId,
        filename: file.name,
        url: r2Url,
        message: 'Image uploaded to R2 successfully'
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    } else {
      return new Response(JSON.stringify({
        success: false,
        error: 'Unsupported content type. Use application/json or multipart/form-data'
      }), {
        status: 415,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  } catch (error) {
    throw new Error(`Upload failed: ${error.message}`);
  }
}

// 10. GET Image
async function handleGetImage(id, db, r2Bucket) {
  try {
    const image = await db.prepare(`
      SELECT * FROM images WHERE id = ?
    `).bind(id).first();
    
    if (!image) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Image not found'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    if (image.image_data.startsWith('http')) {
      // Redirect to R2 URL
      return Response.redirect(image.image_data, 302);
    } else {
      // Return base64 image
      const base64Data = image.image_data.split(',')[1] || image.image_data;
      const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
      
      return new Response(buffer, {
        headers: {
          'Content-Type': image.mime_type || 'image/png',
          'Content-Disposition': `inline; filename="${image.filename}"`,
          'Cache-Control': 'public, max-age=86400'
        }
      });
    }
  } catch (error) {
    throw new Error(`Failed to get image: ${error.message}`);
  }
}

// ============ HELPER FUNCTIONS ============

// Update system statistics
async function updateSystemStats(db) {
  try {
    const stats = await db.prepare(`
      SELECT 
        COUNT(*) as total_reports,
        COUNT(CASE WHEN status IN ('on-progress', 'pending') THEN 1 END) as active_issues,
        COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed_reports,
        COUNT(CASE WHEN priority = 'critical' THEN 1 END) as critical_issues
      FROM reports
    `).first();
    
    await db.prepare(`
      INSERT OR REPLACE INTO system_stats 
      (id, total_reports, active_issues, completed_reports, critical_issues, last_updated)
      VALUES (1, ?, ?, ?, ?, ?)
    `).bind(
      stats?.total_reports || 0,
      stats?.active_issues || 0,
      stats?.completed_reports || 0,
      stats?.critical_issues || 0,
      new Date().toISOString()
    ).run();
  } catch (error) {
    console.error('Failed to update system stats:', error);
  }
}

// Log API request
async function logRequest(db, endpoint, method, statusCode, responseTime, userAgent) {
  try {
    await db.prepare(`
      INSERT INTO api_logs (endpoint, method, status_code, response_time, user_agent, timestamp)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      endpoint,
      method,
      statusCode,
      responseTime,
      userAgent || '',
      new Date().toISOString()
    ).run();
  } catch (error) {
    console.error('Failed to log request:', error);
  }
}

// Serve frontend HTML
async function serveFrontend() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IT Report System API</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            min-height: 100vh;
            padding: 20px;
        }
        .container {
            max-width: 1200px;
            margin: 0 auto;
            background: white;
            border-radius: 15px;
            padding: 40px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.1);
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
        }
        .header h1 {
            font-size: 2.5rem;
            color: #2c3e50;
            margin-bottom: 10px;
        }
        .badge {
            display: inline-block;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            padding: 8px 20px;
            border-radius: 20px;
            font-size: 0.9rem;
            font-weight: 600;
            margin-top: 10px;
        }
        .health-check {
            padding: 20px;
            background: #e8f4fd;
            border-radius: 10px;
            margin: 20px 0;
            display: flex;
            align-items: center;
            gap: 15px;
        }
        .health-dot {
            width: 12px;
            height: 12px;
            background: #27ae60;
            border-radius: 50%;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0% { opacity: 1; }
            50% { opacity: 0.5; }
            100% { opacity: 1; }
        }
        .endpoint {
            background: #f8f9fa;
            border-left: 4px solid #3498db;
            padding: 20px;
            margin: 15px 0;
            border-radius: 8px;
        }
        .method {
            display: inline-block;
            padding: 5px 12px;
            background: #3498db;
            color: white;
            border-radius: 4px;
            font-weight: bold;
            margin-right: 10px;
        }
        .method.get { background: #28a745; }
        .method.post { background: #007bff; }
        .method.delete { background: #dc3545; }
        code {
            background: #2c3e50;
            color: white;
            padding: 3px 8px;
            border-radius: 4px;
            font-family: monospace;
        }
        pre {
            background: #2c3e50;
            color: white;
            padding: 15px;
            border-radius: 8px;
            overflow-x: auto;
            margin: 10px 0;
        }
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
            gap: 20px;
            margin: 30px 0;
        }
        .stat-card {
            background: #f8f9fa;
            padding: 20px;
            border-radius: 10px;
            text-align: center;
            border-left: 4px solid #3498db;
        }
        .stat-value {
            font-size: 2.5rem;
            font-weight: bold;
            color: #2c3e50;
            margin: 10px 0;
        }
        .action-buttons {
            margin-top: 30px;
            display: flex;
            gap: 15px;
            flex-wrap: wrap;
        }
        .btn {
            padding: 12px 25px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            text-decoration: none;
            display: inline-block;
        }
        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(0,0,0,0.1);
        }
        @media (max-width: 768px) {
            .container { padding: 20px; }
            .header h1 { font-size: 2rem; }
            .stats-grid { grid-template-columns: 1fr; }
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 IT Report System API</h1>
            <p>Powered by Cloudflare D1 Database (SQLite) • 100% Free Tier</p>
            <div class="badge">🟢 Online • D1 Database Connected</div>
        </div>
        
        <div id="healthStatus" class="health-check">
            <div class="health-dot"></div>
            <div>
                <h3>API Status: Checking...</h3>
                <p>Timestamp: Loading...</p>
            </div>
        </div>
        
        <div class="stats-grid" id="statsGrid">
            <!-- Stats will be loaded here -->
        </div>
        
        <h2>📚 API Documentation