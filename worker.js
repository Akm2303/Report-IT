// worker.js - Cloudflare Worker dengan D1 Database
export default {
  async fetch(request, env) {
    // CORS headers untuk development
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };

    // Handle preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Routing
      if (path === '/api/reports' && request.method === 'GET') {
        return await getReports(env.DB);
      } else if (path === '/api/reports' && request.method === 'POST') {
        return await createReport(request, env.DB);
      } else if (path.match(/^\/api\/reports\/[^\/]+$/) && request.method === 'GET') {
        const id = path.split('/').pop();
        return await getReport(id, env.DB);
      } else if (path.match(/^\/api\/reports\/[^\/]+$/) && request.method === 'DELETE') {
        const id = path.split('/').pop();
        return await deleteReport(id, env.DB);
      } else if (path === '/api/images' && request.method === 'POST') {
        return await uploadImage(request, env.DB);
      } else if (path.match(/^\/api\/images\/[^\/]+$/)) {
        const id = path.split('/').pop();
        return await getImage(id, env.DB);
      } else if (path === '/api/stats') {
        return await getStats(env.DB);
      } else if (path === '/api/health') {
        return new Response(JSON.stringify({ status: 'ok' }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        // Serve frontend HTML
        return serveFrontend();
      }
    } catch (error) {
      console.error('Error:', error);
      return new Response(JSON.stringify({ 
        error: error.message,
        success: false 
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },
};

// 1. GET all reports (with pagination)
async function getReports(db) {
  const { results } = await db.prepare(`
    SELECT 
      r.*,
      COUNT(i.id) as image_count,
      GROUP_CONCAT(i.filename) as image_filenames
    FROM reports r
    LEFT JOIN images i ON r.id = i.report_id
    GROUP BY r.id
    ORDER BY r.created_at DESC
    LIMIT 100
  `).all();

  return new Response(JSON.stringify({
    success: true,
    data: results,
    total: results.length
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 2. GET single report dengan images
async function getReport(id, db) {
  // Get report details
  const report = await db.prepare(`
    SELECT * FROM reports WHERE id = ?
  `).bind(id).first();

  if (!report) {
    return new Response(JSON.stringify({
      error: 'Report not found',
      success: false
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
      images: images.results
    }
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 3. CREATE new report
async function createReport(request, db) {
  const data = await request.json();
  
  // Validasi
  if (!data.server_name || !data.status || !data.priority) {
    return new Response(JSON.stringify({
      error: 'Missing required fields',
      success: false
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Generate ID
  const id = `rep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  const timestamp = new Date().toISOString();

  // Insert report
  await db.prepare(`
    INSERT INTO reports (id, server_name, ip_address, description, status, priority, platform, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    data.server_name,
    data.ip_address || null,
    data.description || null,
    data.status,
    data.priority,
    data.platform || null,
    data.timestamp || timestamp,
    timestamp
  ).run();

  // Update stats
  await updateStats(db);

  return new Response(JSON.stringify({
    success: true,
    id: id,
    message: 'Report created successfully'
  }), {
    status: 201,
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 4. DELETE report
async function deleteReport(id, db) {
  // Hapus report (images akan terhapus otomatis karena cascade)
  const result = await db.prepare(`
    DELETE FROM reports WHERE id = ?
  `).bind(id).run();

  if (result.changes === 0) {
    return new Response(JSON.stringify({
      error: 'Report not found',
      success: false
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Update stats
  await updateStats(db);

  return new Response(JSON.stringify({
    success: true,
    message: 'Report deleted successfully'
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 5. UPLOAD image
async function uploadImage(request, db) {
  const data = await request.json();
  
  if (!data.report_id || !data.image_data || !data.filename) {
    return new Response(JSON.stringify({
      error: 'Missing required fields',
      success: false
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Cek apakah report exists
  const report = await db.prepare(`
    SELECT id FROM reports WHERE id = ?
  `).bind(data.report_id).first();

  if (!report) {
    return new Response(JSON.stringify({
      error: 'Report not found',
      success: false
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Generate image ID
  const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  
  // Simpan image (base64 di D1, maksimal 1MB per row)
  const base64Data = data.image_data.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(base64Data, 'base64');
  
  if (buffer.length > 1 * 1024 * 1024) { // 1MB limit
    return new Response(JSON.stringify({
      error: 'Image too large (max 1MB)',
      success: false
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  await db.prepare(`
    INSERT INTO images (id, report_id, filename, file_size, mime_type, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    imageId,
    data.report_id,
    data.filename,
    buffer.length,
    data.mime_type || 'image/png',
    base64Data, // Simpan sebagai TEXT (base64)
    new Date().toISOString()
  ).run();

  return new Response(JSON.stringify({
    success: true,
    id: imageId,
    url: `/api/images/${imageId}`,
    message: 'Image uploaded successfully'
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 6. GET image
async function getImage(id, db) {
  const image = await db.prepare(`
    SELECT filename, mime_type, data FROM images WHERE id = ?
  `).bind(id).first();

  if (!image) {
    return new Response(JSON.stringify({
      error: 'Image not found',
      success: false
    }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // Convert base64 to buffer
  const buffer = Buffer.from(image.data, 'base64');
  
  return new Response(buffer, {
    headers: {
      'Content-Type': image.mime_type,
      'Content-Disposition': `inline; filename="${image.filename}"`,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000'
    }
  });
}

// 7. GET stats
async function getStats(db) {
  // Get report statistics
  const stats = await db.prepare(`
    SELECT 
      COUNT(*) as total_reports,
      SUM(CASE WHEN status IN ('on-progress', 'pending') THEN 1 ELSE 0 END) as active_issues,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) as critical_count
    FROM reports
  `).first();

  // Get image statistics
  const imageStats = await db.prepare(`
    SELECT 
      COUNT(*) as total_images,
      COALESCE(SUM(file_size), 0) as total_size_bytes
    FROM images
  `).first();

  return new Response(JSON.stringify({
    success: true,
    data: {
      reports: stats,
      images: imageStats,
      updated_at: new Date().toISOString()
    }
  }), {
    headers: { 
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}

// 8. Update stats helper
async function updateStats(db) {
  const stats = await db.prepare(`
    SELECT 
      COUNT(*) as total_reports,
      SUM(CASE WHEN status IN ('on-progress', 'pending') THEN 1 ELSE 0 END) as active_issues
    FROM reports
  `).first();

  await db.prepare(`
    UPDATE system_stats 
    SET total_reports = ?, active_issues = ?, last_updated = ?
    WHERE id = 1
  `).bind(
    stats.total_reports || 0,
    stats.active_issues || 0,
    new Date().toISOString()
  ).run();
}

// 9. Serve frontend HTML
async function serveFrontend() {
  const html = `
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>IT Report System - Cloudflare D1</title>
        <style>
            body { font-family: Arial, sans-serif; padding: 20px; max-width: 1200px; margin: 0 auto; }
            .header { background: linear-gradient(135deg, #2c3e50, #3498db); color: white; padding: 20px; border-radius: 10px; }
            .card { background: white; border-radius: 10px; padding: 20px; margin: 20px 0; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .api-info { background: #f8f9fa; padding: 15px; border-radius: 5px; margin: 10px 0; }
        </style>
    </head>
    <body>
        <div class="header">
            <h1>🚀 IT Report System API</h1>
            <p>Powered by Cloudflare D1 Database (SQLite) - 100% Gratis</p>
        </div>
        
        <div class="card">
            <h2>📊 API Endpoints</h2>
            <div class="api-info">
                <h3>GET <code>/api/reports</code></h3>
                <p>Get all reports</p>
            </div>
            <div class="api-info">
                <h3>POST <code>/api/reports</code></h3>
                <p>Create new report</p>
                <pre>{
  "server_name": "PROD-WEB-01",
  "ip_address": "192.168.1.100",
  "status": "on-progress",
  "priority": "high"
}</pre>
            </div>
            <div class="api-info">
                <h3>GET <code>/api/stats</code></h3>
                <p>Get system statistics</p>
            </div>
        </div>
        
        <div class="card">
            <h2>🛠️ How to Use</h2>
            <ol>
                <li>Use the API endpoints with your frontend</li>
                <li>All data stored in D1 SQLite database</li>
                <li>Images stored as base64 in database</li>
                <li>100% Free Cloudflare tier</li>
            </ol>
        </div>
    </body>
    </html>
  `;

  return new Response(html, {
    headers: {
      'Content-Type': 'text/html',
      'Access-Control-Allow-Origin': '*'
    }
  });
}