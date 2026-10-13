#!/bin/bash

# Veylog Platform - EC2 Initial Setup Script
# Run this script on a fresh Ubuntu 22.04 EC2 instance

set -e

echo "🚀 Veylog Platform - EC2 Initial Setup"
echo "======================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Check if running as ubuntu user
if [ "$USER" != "ubuntu" ]; then
    echo -e "${RED}❌ This script should be run as ubuntu user${NC}"
    exit 1
fi

echo -e "${BLUE}📋 System Information${NC}"
echo "User: $USER"
echo "Hostname: $(hostname)"
echo "OS: $(lsb_release -d | cut -f2)"
echo ""

# Update system
echo -e "${BLUE}📦 Updating system packages...${NC}"
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
echo -e "${BLUE}📦 Installing Node.js 20...${NC}"
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

node --version
npm --version
echo -e "${GREEN}✅ Node.js installed${NC}"

# Install PM2
echo -e "${BLUE}📦 Installing PM2...${NC}"
sudo npm install -g pm2
pm2 --version
echo -e "${GREEN}✅ PM2 installed${NC}"

# Install Nginx
echo -e "${BLUE}📦 Installing Nginx...${NC}"
sudo apt install -y nginx
nginx -v
echo -e "${GREEN}✅ Nginx installed${NC}"

# Install other tools
echo -e "${BLUE}📦 Installing additional tools...${NC}"
sudo apt install -y git mysql-client build-essential rsync htop
echo -e "${GREEN}✅ Additional tools installed${NC}"

# Create directory structure
echo -e "${BLUE}📁 Creating directory structure...${NC}"
sudo mkdir -p /var/www/{veylog-backend,veylor-webapp,admin}
sudo chown -R ubuntu:ubuntu /var/www
ls -la /var/www/
echo -e "${GREEN}✅ Directories created${NC}"

# Configure UFW firewall
echo -e "${BLUE}🔒 Configuring firewall...${NC}"
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp   # SSH
sudo ufw allow 80/tcp   # HTTP
sudo ufw allow 443/tcp  # HTTPS
echo "y" | sudo ufw enable
sudo ufw status
echo -e "${GREEN}✅ Firewall configured${NC}"

# Prompt for git repository URLs
echo ""
echo -e "${YELLOW}📝 Please provide repository URLs:${NC}"
read -p "Backend repo URL (e.g., https://bitbucket.org/workspace/veylog-backend.git): " BACKEND_REPO
read -p "Webapp repo URL (e.g., https://bitbucket.org/workspace/veylor_webapp.git): " WEBAPP_REPO

# Clone repositories
if [ ! -z "$BACKEND_REPO" ]; then
    echo -e "${BLUE}📥 Cloning backend repository...${NC}"
    cd /var/www
    git clone $BACKEND_REPO veylog-backend || echo "Repository already exists"
    echo -e "${GREEN}✅ Backend cloned${NC}"
fi

if [ ! -z "$WEBAPP_REPO" ]; then
    echo -e "${BLUE}📥 Cloning webapp repository...${NC}"
    cd /var/www
    git clone $WEBAPP_REPO veylor-webapp || echo "Repository already exists"
    echo -e "${GREEN}✅ Webapp cloned${NC}"
fi

# Prompt for RDS details
echo ""
echo -e "${YELLOW}📝 Database Configuration:${NC}"
read -p "RDS Endpoint (e.g., veylog-db.xxxxx.ap-south-1.rds.amazonaws.com): " RDS_ENDPOINT
read -p "Database name (default: veylog_db): " DB_NAME
DB_NAME=${DB_NAME:-veylog_db}
read -p "Database user (default: veylog_admin): " DB_USER
DB_USER=${DB_USER:-veylog_admin}
read -sp "Database password: " DB_PASSWORD
echo ""

# Create backend .env
if [ -d "/var/www/veylog-backend" ]; then
    echo -e "${BLUE}⚙️  Creating backend .env file...${NC}"
    cat > /var/www/veylog-backend/.env <<EOF
NODE_ENV=production
PORT=3000
BASE_PATH=/api

# Database
DB_HOST=$RDS_ENDPOINT
DB_USER=$DB_USER
DB_PASSWORD=$DB_PASSWORD
DB_NAME=$DB_NAME
DB_PORT=3306

# JWT
JWT_SECRET=$(openssl rand -base64 32)
JWT_EXPIRES_IN=7d

# Storage (Update with your S3 details)
STORAGE_DRIVER=s3
AWS_S3_BUCKET=veylog-media-production
AWS_S3_REGION=ap-south-1
AWS_ACCESS_KEY_ID=REPLACE_WITH_YOUR_KEY
AWS_SECRET_ACCESS_KEY=REPLACE_WITH_YOUR_SECRET

# CORS
CORS_ORIGINS=https://veylog.com,https://www.veylog.com

# API
API_PREFIX=/api/v1
EOF
    echo -e "${GREEN}✅ Backend .env created (remember to update S3 credentials)${NC}"
fi

# Create webapp .env.production
if [ -d "/var/www/veylor-webapp" ]; then
    echo -e "${BLUE}⚙️  Creating webapp .env.production file...${NC}"
    read -p "Domain name (e.g., veylog.com): " DOMAIN
    cat > /var/www/veylor-webapp/.env.production <<EOF
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://$DOMAIN/api
DATABASE_URL=mysql://$DB_USER:$DB_PASSWORD@$RDS_ENDPOINT:3306/$DB_NAME
NEXTAUTH_SECRET=$(openssl rand -base64 32)
NEXTAUTH_URL=https://$DOMAIN
EOF
    echo -e "${GREEN}✅ Webapp .env.production created${NC}"
fi

# Build and start backend
if [ -d "/var/www/veylog-backend" ]; then
    echo -e "${BLUE}🔨 Building backend...${NC}"
    cd /var/www/veylog-backend
    npm ci --production
    npm run build
    pm2 start dist/index.js --name veylog-backend-api
    echo -e "${GREEN}✅ Backend started${NC}"
fi

# Build and start webapp
if [ -d "/var/www/veylor-webapp" ]; then
    echo -e "${BLUE}🔨 Building webapp...${NC}"
    cd /var/www/veylor-webapp
    npm ci --production
    npm run build
    pm2 start npm --name veylor-webapp -- start
    echo -e "${GREEN}✅ Webapp started${NC}"
fi

# Save PM2 processes
pm2 save
pm2 startup systemd
echo ""
echo -e "${YELLOW}⚠️  IMPORTANT: Run the command above (starts with 'sudo env') to enable PM2 on boot${NC}"
echo ""

# Show PM2 status
pm2 status

# Create Nginx config
echo ""
read -p "Domain name for Nginx config (e.g., veylog.com): " NGINX_DOMAIN

echo -e "${BLUE}⚙️  Creating Nginx configuration...${NC}"
sudo tee /etc/nginx/sites-available/veylog > /dev/null <<'EOF'
# Veylog Platform - Main Configuration

upstream webapp_backend {
    server localhost:3001;
    keepalive 64;
}

upstream api_backend {
    server localhost:3000;
    keepalive 64;
}

limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=general_limit:10m rate=20r/s;

server {
    listen 80;
    listen [::]:80;
    server_name DOMAIN www.DOMAIN;

    client_max_body_size 50M;

    # Logging
    access_log /var/log/nginx/veylog-access.log;
    error_log /var/log/nginx/veylog-error.log;

    # Backend API - /api/*
    location /api {
        limit_req zone=api_limit burst=20 nodelay;
        
        proxy_pass http://api_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
        proxy_read_timeout 300s;
    }

    # Admin Panel - /admin/*
    location /admin {
        alias /var/www/admin;
        try_files $uri $uri/ /admin/index.html;
        
        location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$ {
            alias /var/www/admin;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
        
        location ~* \.html$ {
            alias /var/www/admin;
            expires -1;
            add_header Cache-Control "no-store, no-cache, must-revalidate";
        }
    }

    # Main Webapp - Next.js at Root
    location / {
        limit_req zone=general_limit burst=50 nodelay;
        
        proxy_pass http://webapp_backend;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
        proxy_buffering off;
    }

    location /_next/static {
        proxy_pass http://webapp_backend;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    location /_next/image {
        proxy_pass http://webapp_backend;
        proxy_cache_valid 7d;
    }
}
EOF

# Replace DOMAIN placeholder
sudo sed -i "s/DOMAIN/$NGINX_DOMAIN/g" /etc/nginx/sites-available/veylog

# Enable site
sudo rm -f /etc/nginx/sites-enabled/default
sudo ln -sf /etc/nginx/sites-available/veylog /etc/nginx/sites-enabled/

# Test Nginx
sudo nginx -t

if [ $? -eq 0 ]; then
    sudo systemctl restart nginx
    sudo systemctl enable nginx
    echo -e "${GREEN}✅ Nginx configured and started${NC}"
else
    echo -e "${RED}❌ Nginx configuration error${NC}"
fi

# Install Certbot
echo -e "${BLUE}📦 Installing Certbot for SSL...${NC}"
sudo apt install -y certbot python3-certbot-nginx

echo ""
echo "======================================="
echo -e "${GREEN}🎉 EC2 Setup Complete!${NC}"
echo "======================================="
echo ""
echo -e "${YELLOW}📝 Next Steps:${NC}"
echo "1. Update backend .env with S3 credentials:"
echo "   nano /var/www/veylog-backend/.env"
echo ""
echo "2. Run database migrations:"
echo "   cd /var/www/veylog-backend"
echo "   mysql -h $RDS_ENDPOINT -u $DB_USER -p $DB_NAME < database/schema_all.sql"
echo ""
echo "3. Setup SSL certificate:"
echo "   sudo certbot --nginx -d $NGINX_DOMAIN -d www.$NGINX_DOMAIN"
echo ""
echo "4. Configure Bitbucket SSH key for deployments"
echo ""
echo "5. Deploy admin frontend via Bitbucket Pipeline"
echo ""
echo -e "${BLUE}📊 Current Status:${NC}"
pm2 status
echo ""
echo -e "${BLUE}🌐 URLs (after DNS/SSL setup):${NC}"
echo "   Main site: https://$NGINX_DOMAIN"
echo "   Admin: https://$NGINX_DOMAIN/admin"
echo "   API: https://$NGINX_DOMAIN/api"
echo ""
echo -e "${GREEN}✅ All services running!${NC}"
