// worker.js - Cloudflare Worker untuk IT Report System
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
    const isPublicEndpoint = path.startsWith('/api/health') || 
                             path === '/' || 
                             path === '/index.html' ||
                             path === '/api.html' ||
                             path.startsWith('/static/');
    
    if (!isPublicEndpoint && env.API_KEY && apiKey !== env.API_KEY) {
      return jsonResponse({
        success: false,
        error: 'Unauthorized',
        message: 'Valid API key required'
      }, 401, corsHeaders);
    }

    // Log API request
    const startTime = Date.now();
    
    try {
      let response;
      
      // Route API requests
      switch (true) {
        case path === '/api/health' && request.method === 'GET':
          response = await handleHealthCheck(env.DB);
          break;
          
        case path === '/api/reports' && request.method === 'GET':
          response = await handleGetReports(request, env.DB);
          break;
          
        case path === '/api/reports' && request.method === 'POST':
          response = await handleCreateReport(request, env.DB);
          break;
          
        case path.startsWith('/api/reports/') && request.method === 'GET':
          const reportId = path.split('/').pop();
          response = await handleGetReport(reportId, env.DB);
          break;
          
        case path.startsWith('/api/reports/') && request.method === 'DELETE':
          const deleteId = path.split('/').pop();
          response = await handleDeleteReport(deleteId, env.DB);
          break;
          
        case path === '/api/reports/search' && request.method === 'GET':
          response = await handleSearchReports(request, env.DB);
          break;
          
        case path === '/api/stats' && request.method === 'GET':
          response = await handleGetStats(env.DB);
          break;
          
        case path === '/api/analytics' && request.method === 'GET':
          response = await handleGetAnalytics(request, env.DB);
          break;
          
        case path === '/api/upload' && request.method === 'POST':
          response = await handleUploadImage(request, env.DB, env.R2_BUCKET);
          break;
          
        case path.startsWith('/api/images/'):
          const imageId = path.split('/').pop();
          response = await handleGetImage(imageId, env.DB, env.R2_BUCKET);
          break;
          
        case path === '/' || path === '/index.html':
          response = await serveFrontend();
          break;
          
        case path === '/api.html':
          response = await serveAPIDocs();
          break;
          
        default:
          // Serve static assets if any
          if (path.startsWith('/static/')) {
            response = await serveStatic(path, env);
          } else {
            response = jsonResponse({
              success: false,
              error: 'Not Found',
              message: 'Endpoint not found',
              path: path
            }, 404, corsHeaders);
          }
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
        request.headers.get('user-agent') || 'Unknown'
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
        request.headers.get('user-agent') || 'Unknown'
      ));

      return jsonResponse({
        success: false,
        error: 'Internal Server Error',
        message: error.message,
        timestamp: new Date().toISOString()
      }, 500, corsHeaders);
    }
  },
};

// ============ HELPER FUNCTIONS ============

// Helper untuk JSON response
function jsonResponse(data, status = 200, corsHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders
    }
  });
}

// ============ API HANDLERS ============

// 1. Health Check Endpoint
async function handleHealthCheck(db) {
  try {
    // Test database connection
    let dbTest;
    try {
      dbTest = await db.prepare('SELECT 1 as test').first();
    } catch (dbError) {
      console.error('Database connection error:', dbError);
      dbTest = null;
    }
    
    // Get system info
    let stats = {
      total_reports: 0,
      active_issues: 0,
      total_images: 0
    };
    
    try {
      const statsResult = await db.prepare(`
        SELECT 
          COUNT(*) as total_reports,
          COUNT(CASE WHEN status IN ('on-progress', 'pending') THEN 1 END) as active_issues,
          (SELECT COUNT(*) FROM images) as total_images
        FROM reports
      `).first();
      
      if (statsResult) {
        stats = statsResult;
      }
    } catch (statsError) {
      console.error('Stats query error:', statsError);
    }

    return jsonResponse({
      success: true,
      healthy: true,
      status: 'operational',
      database: dbTest ? 'connected' : 'disconnected',
      timestamp: new Date().toISOString(),
      system: {
        reports: stats.total_reports || 0,
        active_issues: stats.active_issues || 0,
        images: stats.total_images || 0
      },
      version: '1.0.0',
      environment: 'production'
    });
  } catch (error) {
    console.error('Health check error:', error);
    return jsonResponse({
      success: false,
      healthy: false,
      error: error.message,
      timestamp: new Date().toISOString()
    }, 503);
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
    const search = params.get('search');
    
    let query = `
      SELECT 
        r.*,
        COALESCE((SELECT COUNT(*) FROM images WHERE report_id = r.id), 0) as image_count,
        COALESCE((SELECT filename FROM images WHERE report_id = r.id ORDER BY created_at LIMIT 1), '') as preview_image
      FROM reports r
      WHERE 1=1
    `;
    
    const queryParams = [];
    let paramIndex = 1;
    
    if (status) {
      query += ` AND r.status = ?`;
      queryParams.push(status);
    }
    
    if (priority) {
      query += ` AND r.priority = ?`;
      queryParams.push(priority);
    }
    
    if (search) {
      query += ` AND (r.server_name LIKE ? OR r.description LIKE ? OR r.report_id LIKE ?)`;
      const searchTerm = `%${search}%`;
      queryParams.push(searchTerm, searchTerm, searchTerm);
    }
    
    query += ` ORDER BY r.created_at DESC LIMIT ? OFFSET ?`;
    queryParams.push(limit, offset);
    
    let reports;
    try {
      const stmt = db.prepare(query);
      reports = await stmt.bind(...queryParams).all();
    } catch (queryError) {
      console.error('Query error:', queryError);
      reports = { results: [] };
    }
    
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
    
    if (search) {
      countQuery += ` AND (server_name LIKE ? OR description LIKE ? OR report_id LIKE ?)`;
      const searchTerm = `%${search}%`;
      countParams.push(searchTerm, searchTerm, searchTerm);
    }
    
    let total = { total: 0 };
    try {
      total = await db.prepare(countQuery).bind(...countParams).first();
    } catch (countError) {
      console.error('Count query error:', countError);
    }
    
    return jsonResponse({
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
        priority,
        search
      },
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Get reports error:', error);
    throw new Error(`Failed to get reports: ${error.message}`);
  }
}

// 3. CREATE New Report
async function handleCreateReport(request, db) {
  try {
    let data;
    try {
      data = await request.json();
    } catch (parseError) {
      return jsonResponse({
        success: false,
        error: 'Invalid JSON',
        message: 'Request body must be valid JSON'
      }, 400);
    }
    
    // Validation
    const requiredFields = ['server_name', 'status', 'priority'];
    const missingFields = requiredFields.filter(field => !data[field]);
    
    if (missingFields.length > 0) {
      return jsonResponse({
        success: false,
        error: 'Missing required fields',
        missing: missingFields,
        message: `Required: ${missingFields.join(', ')}`
      }, 400);
    }
    
    // Generate IDs
    const id = `rep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const reportId = `REP-${new Date().getFullYear()}-${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
    const timestamp = new Date().toISOString();
    
    // Insert report
    let result;
    try {
      result = await db.prepare(`
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
    } catch (insertError) {
      console.error('Insert error:', insertError);
      throw new Error('Database insertion failed');
    }
    
    if (result.success) {
      // Get the created report
      let createdReport;
      try {
        createdReport = await db.prepare(`
          SELECT * FROM reports WHERE id = ?
        `).bind(id).first();
      } catch (selectError) {
        console.error('Select created report error:', selectError);
        createdReport = { id, report_id: reportId };
      }
      
      // Update system stats (async)
      ctx.waitUntil(updateSystemStats(db));
      
      return jsonResponse({
        success: true,
        message: 'Report created successfully',
        data: createdReport,
        report_id: reportId,
        id: id,
        timestamp: timestamp
      }, 201);
    } else {
      throw new Error('Database insertion failed');
    }
  } catch (error) {
    console.error('Create report error:', error);
    throw new Error(`Failed to create report: ${error.message}`);
  }
}

// 4. GET Single Report
async function handleGetReport(id, db) {
  try {
    // Get report details
    let report;
    try {
      report = await db.prepare(`
        SELECT * FROM reports WHERE id = ?
      `).bind(id).first();
    } catch (selectError) {
      console.error('Select report error:', selectError);
      report = null;
    }
    
    if (!report) {
      return jsonResponse({
        success: false,
        error: 'Report not found'
      }, 404);
    }
    
    // Get associated images
    let images = { results: [] };
    try {
      images = await db.prepare(`
        SELECT id, filename, file_size, mime_type, image_data, created_at 
        FROM images 
        WHERE report_id = ?
        ORDER BY created_at
      `).bind(id).all();
    } catch (imagesError) {
      console.error('Get images error:', imagesError);
    }
    
    return jsonResponse({
      success: true,
      data: {
        ...report,
        images: images.results || []
      }
    });
  } catch (error) {
    console.error('Get report error:', error);
    throw new Error(`Failed to get report: ${error.message}`);
  }
}

// 5. DELETE Report
async function handleDeleteReport(id, db) {
  try {
    // First, delete associated images
    try {
      await db.prepare(`
        DELETE FROM images WHERE report_id = ?
      `).bind(id).run();
    } catch (deleteImagesError) {
      console.error('Delete images error:', deleteImagesError);
      // Continue even if image deletion fails
    }
    
    // Then delete the report
    let result;
    try {
      result = await db.prepare(`
        DELETE FROM reports WHERE id = ?
      `).bind(id).run();
    } catch (deleteError) {
      console.error('Delete report error:', deleteError);
      throw new Error('Failed to delete report');
    }
    
    if (result.meta.changes === 0) {
      return jsonResponse({
        success: false,
        error: 'Report not found'
      }, 404);
    }
    
    // Update system stats (async)
    ctx.waitUntil(updateSystemStats(db));
    
    return jsonResponse({
      success: true,
      message: 'Report deleted successfully',
      deleted: result.meta.changes
    });
  } catch (error) {
    console.error('Delete report error:', error);
    throw new Error(`Failed to delete report: ${error.message}`);
  }
}

// 6. SEARCH Reports
async function handleSearchReports(request, db) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get('q');
    
    if (!query || query.trim().length < 2) {
      return jsonResponse({
        success: false,
        error: 'Search query must be at least 2 characters'
      }, 400);
    }
    
    const searchTerm = `%${query}%`;
    
    let results;
    try {
      results = await db.prepare(`
        SELECT 
          id, report_id, server_name, ip_address, 
          description, status, priority, timestamp, created_at
        FROM reports 
        WHERE 
          server_name LIKE ? OR
          ip_address LIKE ? OR
          description LIKE ? OR
          report_id LIKE ?
        ORDER BY created_at DESC
        LIMIT 20
      `).bind(searchTerm, searchTerm, searchTerm, searchTerm).all();
    } catch (searchError) {
      console.error('Search error:', searchError);
      results = { results: [] };
    }
    
    return jsonResponse({
      success: true,
      query: query,
      results: results.results || [],
      count: results.results?.length || 0,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Search reports error:', error);
    throw new Error(`Search failed: ${error.message}`);
  }
}

// 7. GET System Statistics
async function handleGetStats(db) {
  try {
    // Get comprehensive statistics
    let stats = {
      total_reports: 0,
      on_progress: 0,
      completed: 0,
      pending: 0,
      cancelled: 0,
      critical: 0,
      high: 0,
      medium: 0,
      low: 0,
      total_images: 0,
      active_days: 0
    };
    
    try {
      const statsResult = await db.prepare(`
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
      
      if (statsResult) {
        stats = statsResult;
      }
    } catch (statsError) {
      console.error('Stats query error:', statsError);
    }
    
    // Get recent activity
    let recent = { reports_today: 0, unique_servers_today: 0 };
    try {
      const recentResult = await db.prepare(`
        SELECT 
          COUNT(*) as reports_today,
          COUNT(DISTINCT server_name) as unique_servers_today
        FROM reports 
        WHERE DATE(created_at) = DATE('now')
      `).first();
      
      if (recentResult) {
        recent = recentResult;
      }
    } catch (recentError) {
      console.error('Recent activity error:', recentError);
    }
    
    // Get platform distribution
    let platforms = { results: [] };
    try {
      platforms = await db.prepare(`
        SELECT 
          platform,
          COUNT(*) as count
        FROM reports 
        WHERE platform IS NOT NULL AND platform != ''
        GROUP BY platform
        ORDER BY count DESC
      `).all();
    } catch (platformsError) {
      console.error('Platforms error:', platformsError);
    }
    
    // Get status timeline (last 7 days)
    let timeline = { results: [] };
    try {
      timeline = await db.prepare(`
        SELECT 
          DATE(created_at) as date,
          COUNT(*) as total,
          COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed
        FROM reports 
        WHERE created_at >= DATE('now', '-7 days')
        GROUP BY DATE(created_at)
        ORDER BY date
      `).all();
    } catch (timelineError) {
      console.error('Timeline error:', timelineError);
    }
    
    return jsonResponse({
      success: true,
      data: {
        overview: stats,
        activity: recent,
        platforms: platforms.results || [],
        timeline: timeline.results || [],
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get stats error:', error);
    throw new Error(`Failed to get stats: ${error.message}`);
  }
}

// 8. GET Advanced Analytics
async function handleGetAnalytics(request, db) {
  try {
    const url = new URL(request.url);
    const days = parseInt(url.searchParams.get('days')) || 30;
    
    // Response time trends
    let responseTimes = { results: [] };
    try {
      responseTimes = await db.prepare(`
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
    } catch (responseTimeError) {
      console.error('Response times error:', responseTimeError);
    }
    
    // Priority distribution over time
    let priorityTrends = { results: [] };
    try {
      priorityTrends = await db.prepare(`
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
    } catch (priorityError) {
      console.error('Priority trends error:', priorityError);
    }
    
    // Server with most incidents
    let topServers = { results: [] };
    try {
      topServers = await db.prepare(`
        SELECT 
          server_name,
          COUNT(*) as incident_count,
          COUNT(CASE WHEN priority = 'critical' THEN 1 END) as critical_count
        FROM reports 
        GROUP BY server_name
        ORDER BY incident_count DESC
        LIMIT 10
      `).all();
    } catch (serversError) {
      console.error('Top servers error:', serversError);
    }
    
    // Hourly distribution
    let hourlyDistribution = { results: [] };
    try {
      hourlyDistribution = await db.prepare(`
        SELECT 
          strftime('%H', created_at) as hour,
          COUNT(*) as count
        FROM reports
        WHERE created_at >= DATE('now', ?)
        GROUP BY strftime('%H', created_at)
        ORDER BY hour
      `).bind(`-${days} days`).all();
    } catch (hourlyError) {
      console.error('Hourly distribution error:', hourlyError);
    }
    
    return jsonResponse({
      success: true,
      data: {
        response_times: responseTimes.results || [],
        priority_trends: priorityTrends.results || [],
        top_servers: topServers.results || [],
        hourly_distribution: hourlyDistribution.results || [],
        period_days: days,
        timestamp: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error('Get analytics error:', error);
    throw new Error(`Failed to get analytics: ${error.message}`);
  }
}

// 9. UPLOAD Image
async function handleUploadImage(request, db, r2Bucket) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    if (contentType.includes('application/json')) {
      // Base64 upload (for small images or testing)
      let data;
      try {
        data = await request.json();
      } catch (parseError) {
        return jsonResponse({
          success: false,
          error: 'Invalid JSON'
        }, 400);
      }
      
      if (!data.report_id || !data.image_data || !data.filename) {
        return jsonResponse({
          success: false,
          error: 'Missing required fields: report_id, image_data, filename'
        }, 400);
      }
      
      // Validate report exists
      let report;
      try {
        report = await db.prepare(`
          SELECT id FROM reports WHERE id = ?
        `).bind(data.report_id).first();
      } catch (reportError) {
        console.error('Report check error:', reportError);
        report = null;
      }
      
      if (!report) {
        return jsonResponse({
          success: false,
          error: 'Report not found'
        }, 404);
      }
      
      // Save to database (base64)
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        await db.prepare(`
          INSERT INTO images (id, report_id, filename, file_size, mime_type, image_data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          imageId,
          data.report_id,
          data.filename,
          data.file_size || 0,
          data.mime_type || 'image/png',
          data.image_data,
          new Date().toISOString()
        ).run();
      } catch (insertError) {
        console.error('Insert image error:', insertError);
        throw new Error('Failed to save image');
      }
      
      return jsonResponse({
        success: true,
        id: imageId,
        filename: data.filename,
        message: 'Image uploaded successfully'
      });
      
    } else if (contentType.includes('multipart/form-data')) {
      // R2 upload for production
      if (!r2Bucket) {
        return jsonResponse({
          success: false,
          error: 'R2 bucket not configured'
        }, 501);
      }
      
      const formData = await request.formData();
      const reportId = formData.get('report_id');
      const file = formData.get('file');
      
      if (!reportId || !file) {
        return jsonResponse({
          success: false,
          error: 'Missing required fields: report_id, file'
        }, 400);
      }
      
      // Generate unique filename
      const filename = `${reportId}_${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
      
      try {
        // Upload to R2
        await r2Bucket.put(filename, file);
      } catch (r2Error) {
        console.error('R2 upload error:', r2Error);
        throw new Error('Failed to upload to R2');
      }
      
      // Get R2 URL
      const r2Url = `https://pub-${env.R2_ACCOUNT_ID}.r2.dev/${filename}`;
      
      // Save metadata to database
      const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      
      try {
        await db.prepare(`
          INSERT INTO images (id, report_id, filename, file_size, mime_type, image_data, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).bind(
          imageId,
          reportId,
          file.name,
          file.size,
          file.type,
          r2Url,
          new Date().toISOString()
        ).run();
      } catch (metaError) {
        console.error('Save metadata error:', metaError);
        // Continue even if metadata save fails
      }
      
      return jsonResponse({
        success: true,
        id: imageId,
        filename: file.name,
        url: r2Url,
        message: 'Image uploaded to R2 successfully'
      });
    } else {
      return jsonResponse({
        success: false,
        error: 'Unsupported content type. Use application/json or multipart/form-data'
      }, 415);
    }
  } catch (error) {
    console.error('Upload image error:', error);
    throw new Error(`Upload failed: ${error.message}`);
  }
}

// 10. GET Image
async function handleGetImage(id, db, r2Bucket) {
  try {
    let image;
    try {
      image = await db.prepare(`
        SELECT * FROM images WHERE id = ?
      `).bind(id).first();
    } catch (selectError) {
      console.error('Select image error:', selectError);
      image = null;
    }
    
    if (!image) {
      return jsonResponse({
        success: false,
        error: 'Image not found'
      }, 404);
    }
    
    if (image.image_data && image.image_data.startsWith('http')) {
      // Redirect to R2 URL
      return Response.redirect(image.image_data, 302);
    } else if (image.image_data) {
      // Return base64 image
      const base64Data = image.image_data.split(',')[1] || image.image_data;
      try {
        const buffer = Uint8Array.from(atob(base64Data), c => c.charCodeAt(0));
        
        return new Response(buffer, {
          headers: {
            'Content-Type': image.mime_type || 'image/png',
            'Content-Disposition': `inline; filename="${image.filename}"`,
            'Cache-Control': 'public, max-age=86400'
          }
        });
      } catch (decodeError) {
        console.error('Base64 decode error:', decodeError);
        return jsonResponse({
          success: false,
          error: 'Invalid image data'
        }, 400);
      }
    } else {
      return jsonResponse({
        success: false,
        error: 'No image data available'
      }, 404);
    }
  } catch (error) {
    console.error('Get image error:', error);
    throw new Error(`Failed to get image: ${error.message}`);
  }
}

// ============ STATIC FILE SERVING ============

// Serve frontend HTML
async function serveFrontend() {
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IT Report System - Cloudflare D1</title>
    <style>
        /* CSS dari index.html sebelumnya */
        body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: #333;
            min-height: 100vh;
            padding: 20px;
        }
        /* ... full CSS dari index.html ... */
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>🚀 IT Report System</h1>
            <p>Powered by Cloudflare D1 Database • 100% Free • No Server Required</p>
            <div class="badge">
                <span id="workerStatus">Checking Connection...</span>
            </div>
        </div>
        <!-- ... konten HTML dari index.html ... -->
    </div>
    <script>
        // JavaScript dari index.html
        const API_BASE_URL = window.location.origin;
        // ... full JavaScript dari index.html ...
    </script>
</body>
</html>`;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

// Serve API documentation
async function serveAPIDocs() {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>IT Report System - API Documentation</title>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            line-height: 1.6;
            max-width: 1200px;
            margin: 0 auto;
            padding: 20px;
            background: #f5f7fa;
        }
        .header {
            text-align: center;
            margin-bottom: 40px;
            padding: 40px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border-radius: 15px;
        }
        .endpoint {
            background: white;
            border-radius: 10px;
            padding: 25px;
            margin-bottom: 25px;
            box-shadow: 0 5px 15px rgba(0,0,0,0.08);
        }
        .method {
            display: inline-block;
            padding: 5px 15px;
            background: #3498db;
            color: white;
            border-radius: 4px;
            font-weight: bold;
            margin-right: 10px;
        }
        .method.get { background: #28a745; }
        .method.post { background: #007bff; }
        .method.delete { background: #dc3545; }
        pre {
            background: #2c3e50;
            color: white;
            padding: 15px;
            border-radius: 8px;
            overflow-x: auto;
        }
        code {
            background: #e9ecef;
            padding: 2px 6px;
            border-radius: 4px;
            font-family: monospace;
        }
    </style>
</head>
<body>
    <div class="header">
        <h1>📚 IT Report System API Documentation</h1>
        <p>Version 1.0.0 | Powered by Cloudflare D1</p>
    </div>

    <div class="endpoint">
        <span class="method get">GET</span>
        <strong>/api/health</strong>
        <p>Health check endpoint</p>
        <pre>curl https://your-worker.workers.dev/api/health</pre>
        <p><strong>Response:</strong></p>
        <pre>{
  "success": true,
  "healthy": true,
  "database": "connected",
  "timestamp": "2024-01-01T00:00:00.000Z"
}</pre>
    </div>

    <div class="endpoint">
        <span class="method get">GET</span>
        <strong>/api/reports</strong>
        <p>Get all reports with pagination and filtering</p>
        <pre>curl "https://your-worker.workers.dev/api/reports?limit=10&offset=0&status=on-progress"</pre>
    </div>

    <div class="endpoint">
        <span class="method post">POST</span>
        <strong>/api/reports</strong>
        <p>Create new report</p>
        <pre>curl -X POST https://your-worker.workers.dev/api/reports \\
  -H "Content-Type: application/json" \\
  -d '{
    "server_name": "WEB-SVR-01",
    "status": "on-progress",
    "priority": "high"
  }'</pre>
    </div>

    <div class="endpoint">
        <span class="method get">GET</span>
        <strong>/api/stats</strong>
        <p>Get system statistics</p>
        <pre>curl https://your-worker.workers.dev/api/stats</pre>
    </div>

    <div class="endpoint">
        <span class="method post">POST</span>
        <strong>/api/upload</strong>
        <p>Upload image evidence</p>
        <pre>curl -X POST https://your-worker.workers.dev/api/upload \\
  -H "Content-Type: application/json" \\
  -d '{
    "report_id": "rep_123456",
    "filename": "screenshot.png",
    "image_data": "data:image/png;base64,..."
  }'</pre>
    </div>

    <div class="endpoint">
        <h3>📊 Example Report Object</h3>
        <pre>{
  "id": "rep_1703232000000_abc123",
  "report_id": "REP-2024-0001",
  "server_name": "WEB-SVR-01",
  "ip_address": "192.168.1.100",
  "description": "Server overload during peak hours",
  "status": "on-progress",
  "priority": "high",
  "platform": "Zabbix",
  "created_by": "System",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "created_at": "2024-01-01T12:00:00.000Z",
  "updated_at": "2024-01-01T12:00:00.000Z",
  "image_count": 2
}</pre>
    </div>
</body>
</html>`;
  
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=3600'
    }
  });
}

// Serve static files (if needed)
async function serveStatic(path, env) {
  // You can implement static file serving if needed
  // For now, just return 404
  return jsonResponse({
    success: false,
    error: 'Not Found',
    message: 'Static file not found'
  }, 404);
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

// ============ ERROR HANDLING MIDDLEWARE ============

// Global error handler (already implemented in main fetch)