#!/bin/bash
# deploy.sh - Deploy IT Report System to Cloudflare

echo "🚀 Deploying IT Report System to Cloudflare..."

# 1. Install dependencies
echo "📦 Installing dependencies..."
npm install -g wrangler

# 2. Login to Cloudflare
echo "🔐 Logging in to Cloudflare..."
wrangler login

# 3. Create D1 database (if not exists)
echo "🗄️  Creating D1 database..."
wrangler d1 create it-reports-db

# 4. Get database ID
DB_ID=$(wrangler d1 list | grep it-reports-db | awk '{print $2}')
echo "📊 Database ID: $DB_ID"

# 5. Update wrangler.toml with database ID
echo "⚙️  Updating configuration..."
sed -i.bak "s/YOUR_D1_DATABASE_ID/$DB_ID/g" wrangler.toml

# 6. Create database schema
echo "📐 Creating database schema..."
wrangler d1 execute it-reports-db --file=./schema.sql

# 7. Deploy Worker
echo "🚀 Deploying Worker..."
wrangler deploy

# 8. Get Worker URL
WORKER_URL=$(wrangler whoami | grep workers.dev | head -1)
echo "🌐 Worker URL: https://it-report-d1-system.$WORKER_URL"

# 9. Update frontend with Worker URL
echo "🔧 Updating frontend configuration..."
sed -i.bak "s|https://your-worker.your-account.workers.dev|https://it-report-d1-system.$WORKER_URL|g" index.html

echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Open https://it-report-d1-system.$WORKER_URL"
echo "2. Test the system"
echo "3. Share with your team"