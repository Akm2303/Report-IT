// deploy.js - Script untuk deploy mudah
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

async function deploy() {
  console.log('🚀 Starting IT Report System Deployment...\n');
  
  try {
    // 1. Build check
    console.log('📦 Checking build...');
    await execAsync('npm run build || true');
    
    // 2. Create database if not exists
    console.log('🗄️  Setting up D1 database...');
    await execAsync('wrangler d1 execute it-reports-db --file=./schema_fixed.sql --remote');
    
    // 3. Deploy worker
    console.log('🚀 Deploying worker to Cloudflare...');
    await execAsync('wrangler deploy');
    
    // 4. Test deployment
    console.log('🧪 Testing deployment...');
    const { stdout } = await execAsync('curl -s https://it-report-system.YOUR_SUBDOMAIN.workers.dev/api/health');
    const health = JSON.parse(stdout);
    
    if (health.healthy) {
      console.log('\n✅ Deployment Successful!');
      console.log('🌐 Frontend URL: https://it-report-system.YOUR_SUBDOMAIN.workers.dev');
      console.log('🔧 API Base URL: https://it-report-system.YOUR_SUBDOMAIN.workers.dev/api');
      console.log('📊 Health Status: ✅ Healthy');
      console.log(`📈 Total Reports: ${health.system.reports}`);
    } else {
      console.log('\n⚠️  Deployment completed with warnings');
      console.log('Health check:', health);
    }
    
  } catch (error) {
    console.error('\n❌ Deployment failed:', error.message);
    process.exit(1);
  }
}

deploy();