// worker.js - Cloudflare Worker dengan D1 Database - FIXED
export default {
  async fetch(request, env) {
    // CORS headers untuk semua response
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
        return await handleGetReports(env.DB);
      } else if (path === '/api/reports' && request.method === 'POST') {
        return await handleCreateReport(request, env.DB);
      } else if (path.startsWith('/api/reports/') && request.method === 'GET') {
        const id = path.split('/').pop();
        return await handleGetReport(id, env.DB);
      } else if (path.startsWith('/api/reports/') && request.method === 'DELETE') {
        const id = path.split('/').pop();
        return await handleDeleteReport(id, env.DB);
      } else if (path === '/api/images' && request.method === 'POST') {
        return await handleUploadImage(request, env.DB);
      } else if (path.startsWith('/api/images/')) {
        const id = path.split('/').pop();
        return await handleGetImage(id, env.DB);
      } else if (path === '/api/stats') {
        return await handleGetStats(env.DB);
      } else if (path === '/api/health') {
        return new Response(JSON.stringify({ 
          status: 'ok',
          database: env.DB ? 'connected' : 'not connected'
        }), {
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      } else {
        // Serve frontend HTML
        return await serveFrontend();
      }
    } catch (error) {
      console.error('Error in worker:', error);
      return new Response(JSON.stringify({ 
        error: error.message,
        success: false,
        timestamp: new Date().toISOString()
      }), {
        status: 500,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
  },
};

// 1. GET all reports
async function handleGetReports(db) {
  try {
    const { results } = await db.prepare(`
      SELECT 
        r.*,
        (SELECT COUNT(*) FROM images WHERE report_id = r.id) as image_count
      FROM reports r
      ORDER BY r.created_at DESC
      LIMIT 100
    `).all();

    return new Response(JSON.stringify({
      success: true,
      data: results,
      total: results.length,
      timestamp: new Date().toISOString()
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    throw new Error(`Failed to get reports: ${error.message}`);
  }
}

// 2. GET single report
async function handleGetReport(id, db) {
  try {
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
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
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
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    throw new Error(`Failed to get report: ${error.message}`);
  }
}

// 3. CREATE new report
async function handleCreateReport(request, db) {
  try {
    const data = await request.json();
    
    // Validasi
    if (!data.server_name || !data.status || !data.priority) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: server_name, status, priority',
        success: false
      }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Generate ID
    const id = `rep_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const timestamp = new Date().toISOString();

    // Insert report
    const result = await db.prepare(`
      INSERT INTO reports (id, server_name, ip_address, description, status, priority, platform, timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      id,
      data.server_name,
      data.ip_address || '',
      data.description || '',
      data.status,
      data.priority,
      data.platform || '',
      data.timestamp || timestamp,
      timestamp
    ).run();

    if (result.success) {
      return new Response(JSON.stringify({
        success: true,
        id: id,
        message: 'Report created successfully',
        timestamp: timestamp
      }), {
        status: 201,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } else {
      throw new Error('Failed to insert report');
    }
  } catch (error) {
    throw new Error(`Failed to create report: ${error.message}`);
  }
}

// 4. DELETE report
async function handleDeleteReport(id, db) {
  try {
    // Hapus report (images akan terhapus otomatis karena cascade)
    const result = await db.prepare(`
      DELETE FROM reports WHERE id = ?
    `).bind(id).run();

    if (result.meta.changes === 0) {
      return new Response(JSON.stringify({
        error: 'Report not found',
        success: false
      }), {
        status: 404,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      message: 'Report deleted successfully',
      deleted: result.meta.changes
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    throw new Error(`Failed to delete report: ${error.message}`);
  }
}

// 5. UPLOAD image (simplified - simpan metadata saja)
async function handleUploadImage(request, db) {
  try {
    const data = await request.json();
    
    if (!data.report_id || !data.filename || !data.image_data) {
      return new Response(JSON.stringify({
        error: 'Missing required fields: report_id, filename, image_data',
        success: false
      }), {
        status: 400,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
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
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    // Generate image ID
    const imageId = `img_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    // Simpan metadata saja (simplified untuk D1)
    // Di production, sebaiknya simpan di R2 dan hanya simpan URL di D1
    const result = await db.prepare(`
      INSERT INTO images (id, report_id, filename, file_size, mime_type, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).bind(
      imageId,
      data.report_id,
      data.filename,
      data.file_size || 0,
      data.mime_type || 'image/png',
      new Date().toISOString()
    ).run();

    if (result.success) {
      return new Response(JSON.stringify({
        success: true,
        id: imageId,
        filename: data.filename,
        message: 'Image metadata saved successfully'
      }), {
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    } else {
      throw new Error('Failed to save image metadata');
    }
  } catch (error) {
    throw new Error(`Failed to upload image: ${error.message}`);
  }
}

// 6. GET image metadata (simplified)
async function handleGetImage(id, db) {
  try {
    const image = await db.prepare(`
      SELECT id, filename, file_size, mime_type, created_at 
      FROM images WHERE id = ?
    `).bind(id).first();

    if (!image) {
      return new Response(JSON.stringify({
        error: 'Image not found',
        success: false
      }), {
        status: 404,
        headers: { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    return new Response(JSON.stringify({
      success: true,
      data: image
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    throw new Error(`Failed to get image: ${error.message}`);
  }
}

// 7. GET stats
async function handleGetStats(db) {
  try {
    // Get report statistics
    const stats = await db.prepare(`
      SELECT 
        COUNT(*) as total_reports,
        SUM(CASE WHEN status IN ('on-progress', 'pending') THEN 1 ELSE 0 END) as active_issues,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN priority = 'critical' THEN 1 ELSE 0 END) as critical_count,
        SUM(CASE WHEN priority = 'high' THEN 1 ELSE 0 END) as high_count
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
        reports: stats || {
          total_reports: 0,
          active_issues: 0,
          completed: 0,
          critical_count: 0,
          high_count: 0
        },
        images: imageStats || {
          total_images: 0,
          total_size_bytes: 0
        },
        timestamp: new Date().toISOString()
      }
    }), {
      headers: { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    throw new Error(`Failed to get stats: ${error.message}`);
  }
}

// 8. Serve frontend HTML
async function serveFrontend() {
  const html = `
    <!DOCTYPE html>
    <html lang="id">
    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>IT Report System - Cloudflare D1</title>
        <style>
            body { 
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                padding: 20px; 
                max-width: 1200px; 
                margin: 0 auto;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                min-height: 100vh;
            }
            .container {
                background: white;
                border-radius: 20px;
                padding: 40px;
                margin-top: 20px;
                box-shadow: 0 20px 60px rgba(0,0,0,0.1);
            }
            .header { 
                text-align: center;
                margin-bottom: 40px;
            }
            .header h1 { 
                color: #2c3e50; 
                margin-bottom: 10px;
                font-size: 2.5rem;
            }
            .badge {
                display: inline-block;
                padding: 8px 16px;
                background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
                color: white;
                border-radius: 20px;
                font-size: 0.9rem;
                font-weight: 600;
                margin-top: 10px;
            }
            .api-endpoint {
                background: #f8f9fa;
                border-left: 4px solid #3498db;
                padding: 15px;
                margin: 15px 0;
                border-radius: 5px;
            }
            .api-endpoint code {
                background: #2c3e50;
                color: white;
                padding: 5px 10px;
                border-radius: 4px;
                font-family: monospace;
            }
            .status {
                padding: 20px;
                background: #e8f4fd;
                border-radius: 10px;
                margin: 20px 0;
            }
            .status.good { background: #d4edda; }
            .status.error { background: #f8d7da; }
        </style>
        <script>
            async function checkHealth() {
                try {
                    const response = await fetch('/api/health');
                    const data = await response.json();
                    const statusDiv = document.getElementById('healthStatus');
                    statusDiv.className = 'status ' + (data.status === 'ok' ? 'good' : 'error');
                    statusDiv.innerHTML = \`
                        <h3>Health Check: \${data.status === 'ok' ? '✅ Healthy' : '❌ Error'}</h3>
                        <p>Database: \${data.database}</p>
                        <p>Timestamp: \${new Date().toLocaleString()}</p>
                    \`;
                } catch (error) {
                    document.getElementById('healthStatus').innerHTML = \`
                        <h3>Health Check: ❌ Error</h3>
                        <p>Error: \${error.message}</p>
                    \`;
                }
            }
            
            async function testAPI() {
                try {
                    const response = await fetch('/api/stats');
                    const data = await response.json();
                    document.getElementById('testResult').innerHTML = \`
                        <h4>✅ API Test Successful</h4>
                        <pre>\${JSON.stringify(data, null, 2)}</pre>
                    \`;
                } catch (error) {
                    document.getElementById('testResult').innerHTML = \`
                        <h4>❌ API Test Failed</h4>
                        <p>Error: \${error.message}</p>
                    \`;
                }
            }
            
            window.onload = function() {
                checkHealth();
                testAPI();
            };
        </script>
    </head>
    <body>
        <div class="container">
            <div class="header">
                <h1>🚀 IT Report System API</h1>
                <p>Powered by Cloudflare D1 Database (SQLite) - 100% Gratis</p>
                <div class="badge">Status: Online • D1 Database Connected</div>
            </div>
            
            <div id="healthStatus" class="status">
                Checking health status...
            </div>
            
            <div style="margin: 30px 0;">
                <h2>📊 API Endpoints</h2>
                
                <div class="api-endpoint">
                    <h3>GET <code>/api/reports</code></h3>
                    <p>Get all reports (latest 100)</p>
                    <button onclick="fetch('/api/reports').then(r => r.json()).then(d => alert(JSON.stringify(d, null, 2)))">Test</button>
                </div>
                
                <div class="api-endpoint">
                    <h3>POST <code>/api/reports</code></h3>
                    <p>Create new report</p>
                    <pre style="background: #f1f1f1; padding: 10px; border-radius: 5px;">
{
  "server_name": "PROD-WEB-01",
  "ip_address": "192.168.1.100",
  "status": "on-progress",
  "priority": "high"
}</pre>
                </div>
                
                <div class="api-endpoint">
                    <h3>GET <code>/api/stats</code></h3>
                    <p>Get system statistics</p>
                    <div id="testResult"></div>
                </div>
                
                <div class="api-endpoint">
                    <h3>GET <code>/api/health</code></h3>
                    <p>Health check endpoint</p>
                </div>
            </div>
            
            <div style="margin-top: 40px; padding: 20px; background: #f8f9fa; border-radius: 10px;">
                <h3>🛠️ Getting Started</h3>
                <ol>
                    <li>Use the API endpoints with your frontend application</li>
                    <li>All data is stored in Cloudflare D1 SQLite database</li>
                    <li>100% Free Tier - no credit card required</li>
                    <li>Global CDN with automatic HTTPS</li>
                </ol>
                
                <p style="margin-top: 20px;">
                    <strong>Frontend URL:</strong> 
                    <a href="/index.html" id="frontendLink">/index.html</a>
                </p>
            </div>
            
            <div style="margin-top: 30px; text-align: center; color: #666; font-size: 0.9rem;">
                <p>Powered by Cloudflare Workers + D1 Database</p>
                <p>Deployed: ${new Date().toLocaleDateString()}</p>
            </div>
        </div>
        
        <script>
            // Set frontend link dynamically
            document.getElementById('frontendLink').href = window.location.origin + '/index.html';
        </script>
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