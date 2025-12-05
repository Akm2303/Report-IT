#!/bin/bash
# deploy.sh - Deploy IT Report System to Cloudflare (FIXED)

echo "🚀 Starting deployment of IT Report System..."
echo "============================================"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Step 1: Check if wrangler is installed
echo -e "${YELLOW}Step 1: Checking dependencies...${NC}"
if ! command -v wrangler &> /dev/null; then
    echo -e "${RED}❌ wrangler CLI is not installed${NC}"
    echo "Installing wrangler..."
    npm install -g wrangler
else
    echo -e "${GREEN}✅ wrangler is installed${NC}"
fi

# Step 2: Login to Cloudflare (if not already)
echo -e "\n${YELLOW}Step 2: Checking Cloudflare login...${NC}"
if ! wrangler whoami &> /dev/null; then
    echo -e "${YELLOW}⚠️  Not logged in to Cloudflare${NC}"
    wrangler login
else
    echo -e "${GREEN}✅ Already logged in to Cloudflare${NC}"
fi

# Step 3: Create D1 database if not exists
echo -e "\n${YELLOW}Step 3: Setting up D1 database...${NC}"
DB_EXISTS=$(wrangler d1 list | grep it-reports-db | wc -l)

if [ "$DB_EXISTS" -eq "0" ]; then
    echo -e "${YELLOW}Creating new D1 database...${NC}"
    wrangler d1 create it-reports-db
else
    echo -e "${GREEN}✅ D1 database already exists${NC}"
fi

# Step 4: Get database ID
echo -e "\n${YELLOW}Step 4: Getting database ID...${NC}"
DB_INFO=$(wrangler d1 list | grep it-reports-db)
DB_ID=$(echo $DB_INFO | awk '{print $2}')

if [ -z "$DB_ID" ]; then
    echo -e "${RED}❌ Could not get database ID${NC}"
    exit 1
fi

echo -e "${GREEN}✅ Database ID: $DB_ID${NC}"

# Step 5: Update wrangler.toml with database ID
echo -e "\n${YELLOW}Step 5: Updating configuration...${NC}"
if [ -f "wrangler.toml" ]; then
    sed -i.bak "s/YOUR_DATABASE_ID_HERE/$DB_ID/g" wrangler.toml
    echo -e "${GREEN}✅ Updated wrangler.toml${NC}"
else
    echo -e "${RED}❌ wrangler.toml not found${NC}"
    exit 1
fi

# Step 6: Create database schema
echo -e "\n${YELLOW}Step 6: Creating database schema...${NC}"
if [ -f "schema.sql" ]; then
    echo "Executing schema.sql..."
    wrangler d1 execute it-reports-db --file=./schema.sql
    echo -e "${GREEN}✅ Database schema created${NC}"
else
    echo -e "${RED}❌ schema.sql not found${NC}"
    exit 1
fi

# Step 7: Deploy Worker
echo -e "\n${YELLOW}Step 7: Deploying Worker...${NC}"
if [ -f "worker.js" ]; then
    wrangler deploy
    echo -e "${GREEN}✅ Worker deployed successfully${NC}"
else
    echo -e "${RED}❌ worker.js not found${NC}"
    exit 1
fi

# Step 8: Get Worker URL
echo -e "\n${YELLOW}Step 8: Getting Worker URL...${NC}"
WORKER_NAME=$(grep '^name =' wrangler.toml | cut -d'"' -f2)
ACCOUNT_ID=$(wrangler whoami | grep "Account ID" | awk '{print $3}' | head -1)

if [ -n "$ACCOUNT_ID" ] && [ -n "$WORKER_NAME" ]; then
    WORKER_URL="https://${WORKER_NAME}.${ACCOUNT_ID}.workers.dev"
    echo -e "${GREEN}✅ Worker URL: $WORKER_URL${NC}"
    
    # Update frontend with Worker URL
    if [ -f "index.html" ]; then
        sed -i.bak "s|const WORKER_URL = .*;|const WORKER_URL = '$WORKER_URL';|g" index.html
        echo -e "${GREEN}✅ Updated frontend with Worker URL${NC}"
    fi
else
    echo -e "${YELLOW}⚠️  Could not determine Worker URL${NC}"
fi

# Step 9: Create test data
echo -e "\n${YELLOW}Step 9: Creating test data...${NC}"
read -p "Do you want to create test data? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    echo "Creating test reports..."
    curl -X POST "$WORKER_URL/api/reports" \
        -H "Content-Type: application/json" \
        -d '{"server_name":"TEST-SERVER-01","ip_address":"192.168.1.100","status":"on-progress","priority":"high","platform":"Zabbix"}'
    
    curl -X POST "$WORKER_URL/api/reports" \
        -H "Content-Type: application/json" \
        -d '{"server_name":"TEST-SERVER-02","ip_address":"192.168.1.101","status":"completed","priority":"medium","platform":"Prometheus"}'
    
    echo -e "${GREEN}✅ Test data created${NC}"
fi

# Step 10: Final instructions
echo -e "\n${GREEN}============================================"
echo "✅ Deployment completed successfully!"
echo "============================================"
echo ""
echo "📋 Next steps:"
echo "1. Open your Worker URL: $WORKER_URL"
echo "2. Test the API endpoints:"
echo "   - $WORKER_URL/api/health"
echo "   - $WORKER_URL/api/reports"
echo "   - $WORKER_URL/api/stats"
echo "3. Open the frontend: $WORKER_URL/index.html"
echo "4. Start creating IT reports!"
echo ""
echo "🔧 Troubleshooting:"
echo "   - Check Cloudflare Dashboard for logs"
echo "   - Run 'wrangler tail' to see real-time logs"
echo "   - Run 'wrangler d1 execute it-reports-db --command=\"SELECT * FROM reports\"' to check data"
echo "============================================"