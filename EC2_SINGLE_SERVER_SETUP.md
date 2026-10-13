# Veylog Platform - Single EC2 Server Setup Guide

## Architecture Overview

```
                    ┌─────────────────────┐
                    │     Domain          │
                    │   veylog.com        │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │   AWS EC2 Instance  │
                    │   Ubuntu 22.04 LTS  │
                    │   t3.medium+        │
                    └──────────┬──────────┘
                               │
                    ┌──────────▼──────────┐
                    │      Nginx          │
                    │  Reverse Proxy      │
                    └──────────┬──────────┘
                               │
         ┌─────────────────────┼─────────────────────┐
         │                     │                     │
    ┌────▼────┐          ┌────▼────┐          ┌────▼────┐
    │  Next.js│          │Node.js  │          │ React   │
    │  Port   │          │  API    │          │  SPA    │
    │  3001   │          │ Port    │          │ Static  │
    │   (/)   │          │  3000   │          │(/admin) │
    └─────────┘          │ (/api)  │          └─────────┘
                         └────┬────┘
                              │
                       ┌──────▼──────┐
                       │  RDS MySQL  │
                       │  Database   │
                       └─────────────┘
```

## URL Mapping

- `https://veylog.com` → Next.js Webapp (Port 3001)
- `https://veylog.com/api` → Node.js Backend (Port 3000)
- `https://veylog.com/admin` → React Admin SPA (Static files)

## EC2 Instance Setup

### 1. Launch EC2 Instance

**Specifications:**
- **AMI:** Ubuntu 22.04 LTS
- **Instance Type:** t3.medium (minimum), t3.large (recommended)
- **Storage:** 50GB SSD (General Purpose SSD - gp3)
- **Security Group:**
  - Port 22 (SSH) - Your IP only
  - Port 80 (HTTP) - 0.0.0.0/0
  - Port 443 (HTTPS) - 0.0.0.0/0
  - Port 3306 (MySQL) - Only if external DB access needed

**Launch Command:**
```bash
aws ec2 run-instances \
  --image-id ami-0c55b159cbfafe1f0 \
  --instance-type t3.medium \
  --key-name veylog-key \
  --security-group-ids sg-xxxxx \
  --subnet-id subnet-xxxxx \
  --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=veylog-server}]'
```

### 2. Connect to EC2

```bash
# Get public IP from AWS Console
ssh -i veylog-key.pem ubuntu@<EC2-PUBLIC-IP>
```

### 3. Install Required Software

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20.x
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version  # Should show v20.x.x
npm --version

# Install PM2 (Process Manager)
sudo npm install -g pm2

# Install Nginx
sudo apt install -y nginx

# Install Git
sudo apt install -y git

# Install MySQL client (for database operations)
sudo apt install -y mysql-client

# Install build essentials (for native modules)
sudo apt install -y build-essential

# Install rsync (for admin frontend deployment)
sudo apt install -y rsync
```

### 4. Create Directory Structure

```bash
# Create application directories
sudo mkdir -p /var/www/{veylog-backend,veylor-webapp,admin}

# Change ownership to ubuntu user
sudo chown -R ubuntu:ubuntu /var/www

# Verify structure
ls -la /var/www/
```

### 5. Clone Repositories

```bash
# Navigate to web root
cd /var/www

# Clone backend
git clone https://bitbucket.org/your-workspace/veylog-backend.git
cd veylog-backend

# Create .env file
cp .env.example .env
nano .env
```

**Backend .env configuration:**
```env
NODE_ENV=production
PORT=3000
BASE_PATH=/api

# Database (RDS)
DB_HOST=veylog-db.xxxxx.ap-south-1.rds.amazonaws.com
DB_USER=veylog_admin
DB_PASSWORD=<your-secure-password>
DB_NAME=veylog_db
DB_PORT=3306

# JWT
JWT_SECRET=<generate-with-openssl-rand-base64-32>
JWT_EXPIRES_IN=7d

# Storage (S3)
STORAGE_DRIVER=s3
AWS_S3_BUCKET=veylog-media-production
AWS_S3_REGION=ap-south-1
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>

# CORS
CORS_ORIGINS=https://veylog.com,https://www.veylog.com

# API
API_PREFIX=/api/v1
```

```bash
# Install dependencies and build
npm ci --production
npm run build

# Start with PM2
pm2 start dist/index.js --name veylog-backend-api
pm2 save
pm2 startup systemd
# Run the command that PM2 outputs
```

**Clone webapp:**
```bash
cd /var/www

# Clone webapp
git clone https://bitbucket.org/your-workspace/veylor_webapp.git
cd veylor-webapp

# Create .env.production
nano .env.production
```

**Webapp .env.production:**
```env
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://veylog.com/api
DATABASE_URL=mysql://veylog_admin:<password>@veylog-db.xxxxx.rds.amazonaws.com:3306/veylog_db
NEXTAUTH_SECRET=<generate-with-openssl>
NEXTAUTH_URL=https://veylog.com
```

```bash
# Install and build
npm ci --production
npm run build

# Start with PM2
pm2 start npm --name veylor-webapp -- start
pm2 save
```

**Prepare admin frontend directory:**
```bash
# Admin frontend will be deployed via Bitbucket Pipeline
# Just ensure directory exists with proper permissions
sudo mkdir -p /var/www/admin
sudo chown -R ubuntu:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin
```

### 6. Configure Nginx

```bash
# Remove default config
sudo rm /etc/nginx/sites-enabled/default

# Create veylog config
sudo nano /etc/nginx/sites-available/veylog
```

**Nginx Configuration:**
```nginx
# Veylog Platform - Main Configuration
# Serves: Main site (root), Backend API (/api), Admin Panel (/admin)

# Upstream definitions
upstream webapp_backend {
    server localhost:3001;
    keepalive 64;
}

upstream api_backend {
    server localhost:3000;
    keepalive 64;
}

# Rate limiting
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=general_limit:10m rate=20r/s;

# HTTP - Redirect to HTTPS
server {
    listen 80;
    listen [::]:80;
    server_name veylog.com www.veylog.com;

    # Redirect all HTTP to HTTPS
    return 301 https://$host$request_uri;
}

# HTTPS - Main Server
server {
    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    server_name veylog.com www.veylog.com;

    # SSL Configuration (will be managed by Certbot)
    ssl_certificate /etc/letsencrypt/live/veylog.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/veylog.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    # Security headers
    add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header X-XSS-Protection "1; mode=block" always;

    # Logging
    access_log /var/log/nginx/veylog-access.log;
    error_log /var/log/nginx/veylog-error.log;

    # Max upload size
    client_max_body_size 50M;

    # ========================================
    # Backend API - /api/*
    # ========================================
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
        proxy_connect_timeout 75s;
        
        # CORS headers (if not handled by backend)
        # add_header Access-Control-Allow-Origin $http_origin always;
        # add_header Access-Control-Allow-Methods "GET, POST, PUT, DELETE, OPTIONS" always;
        # add_header Access-Control-Allow-Headers "Authorization, Content-Type" always;
    }

    # ========================================
    # Admin Panel - /admin/*
    # ========================================
    location /admin {
        alias /var/www/admin;
        try_files $uri $uri/ /admin/index.html;
        
        # Cache static assets
        location ~* \.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot)$ {
            alias /var/www/admin;
            expires 1y;
            add_header Cache-Control "public, immutable";
        }
        
        # No cache for HTML
        location ~* \.html$ {
            alias /var/www/admin;
            expires -1;
            add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
        }
    }

    # ========================================
    # Main Webapp - Next.js at Root
    # ========================================
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
        proxy_read_timeout 300s;
    }

    # Next.js static files
    location /_next/static {
        proxy_pass http://webapp_backend;
        expires 1y;
        add_header Cache-Control "public, immutable";
    }

    # Next.js images
    location /_next/image {
        proxy_pass http://webapp_backend;
        proxy_cache_valid 7d;
    }
}
```

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/veylog /etc/nginx/sites-enabled/

# Test configuration
sudo nginx -t

# If test passes, restart Nginx
sudo systemctl restart nginx
sudo systemctl enable nginx
```

### 7. Setup SSL Certificate (Let's Encrypt)

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d veylog.com -d www.veylog.com --email admin@veylog.com --agree-tos --no-eff-email

# Verify auto-renewal
sudo certbot renew --dry-run

# Certificate will auto-renew every 60 days
```

### 8. Configure PM2 to Run on Boot

```bash
# Save current PM2 processes
pm2 save

# Generate startup script
pm2 startup systemd

# Run the command that PM2 outputs (it will start with 'sudo')
# Example: sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu

# Verify PM2 is running
pm2 list
pm2 status
```

### 9. Setup Database (RDS)

**Create RDS MySQL Instance:**
```bash
aws rds create-db-instance \
  --db-instance-identifier veylog-db \
  --db-instance-class db.t3.medium \
  --engine mysql \
  --engine-version 8.0 \
  --master-username veylog_admin \
  --master-user-password <SecurePassword123!> \
  --allocated-storage 50 \
  --vpc-security-group-ids sg-xxxxx \
  --backup-retention-period 7 \
  --preferred-backup-window "03:00-04:00" \
  --publicly-accessible false
```

**Run Migrations:**
```bash
# Wait for RDS to be available (5-10 minutes)
aws rds describe-db-instances --db-instance-identifier veylog-db

# Get endpoint
RDS_ENDPOINT=$(aws rds describe-db-instances --db-instance-identifier veylog-db --query 'DBInstances[0].Endpoint.Address' --output text)

echo "RDS Endpoint: $RDS_ENDPOINT"

# Run migrations from backend directory
cd /var/www/veylog-backend

# Run schema
mysql -h $RDS_ENDPOINT -u veylog_admin -p veylog_db < database/schema_all.sql

# Run migration 30 (segments fixes)
mysql -h $RDS_ENDPOINT -u veylog_admin -p veylog_db < database/30_fix_menu_active_match.sql
```

## Bitbucket Pipeline Configuration

### Repository Variables (All Repos)

Go to each repository: **Settings → Pipelines → Repository variables**

```
SSH_USER=ubuntu
EC2_SERVER=<EC2-PUBLIC-IP-OR-DOMAIN>
DOMAIN=veylog.com
```

### SSH Key Setup

```bash
# On your local machine
ssh-keygen -t rsa -b 4096 -C "bitbucket-deploy" -f ~/.ssh/bitbucket-veylog

# Copy public key to EC2
ssh-copy-id -i ~/.ssh/bitbucket-veylog.pub ubuntu@<EC2-IP>

# Or manually:
# cat ~/.ssh/bitbucket-veylog.pub
# Then on EC2: nano ~/.ssh/authorized_keys (paste the key)

# Add private key to Bitbucket
# Repository Settings → Pipelines → SSH keys → Add key
# Paste content of: cat ~/.ssh/bitbucket-veylog
```

## Deployment Workflow

### First Time Setup
1. Setup EC2 (steps above) ✅
2. Clone repositories manually
3. Configure .env files
4. Start services with PM2
5. Configure Nginx
6. Setup SSL

### Subsequent Deployments (Automated)

**Backend:**
```bash
git push origin main
# Go to Bitbucket → Pipelines → Run "deploy-to-production"
```

**Admin Frontend:**
```bash
git push origin main
# Go to Bitbucket → Pipelines → Run "deploy-to-production"
# Automatically rsync to /var/www/admin
```

**Webapp:**
```bash
git push origin main
# Go to Bitbucket → Pipelines → Run "deploy-to-production"
```

## Monitoring & Maintenance

### Check Service Status

```bash
# PM2 processes
pm2 status
pm2 logs veylog-backend-api
pm2 logs veylor-webapp

# Nginx
sudo systemctl status nginx
sudo nginx -t
sudo tail -f /var/log/nginx/veylog-access.log
sudo tail -f /var/log/nginx/veylog-error.log

# System resources
htop
df -h
free -m
```

### Restart Services

```bash
# Restart backend API
pm2 restart veylog-backend-api

# Restart webapp
pm2 restart veylor-webapp

# Reload Nginx
sudo systemctl reload nginx

# Restart Nginx
sudo systemctl restart nginx
```

### Update System

```bash
# Update packages
sudo apt update && sudo apt upgrade -y

# Update Node.js packages globally
sudo npm update -g pm2

# Restart services after updates
pm2 restart all
```

## Backup Strategy

### Database Backup

```bash
# Manual backup
mysqldump -h $RDS_ENDPOINT -u veylog_admin -p veylog_db > backup_$(date +%Y%m%d).sql

# Automated backups are enabled on RDS (7 days retention)
```

### Code Backup

```bash
# Git repositories are the source of truth
# Ensure all changes are committed

# Optional: Backup /var/www
tar -czf veylog-backup-$(date +%Y%m%d).tar.gz /var/www
```

## Security Checklist

- [ ] SSH key-based authentication only (disable password login)
- [ ] Firewall configured (UFW)
- [ ] Fail2ban installed for SSH protection
- [ ] SSL certificate active and auto-renewing
- [ ] RDS not publicly accessible
- [ ] Environment variables secured (.env not in git)
- [ ] Regular security updates applied
- [ ] CloudWatch logging enabled
- [ ] Backups automated

## Firewall Setup (UFW)

```bash
# Enable firewall
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP
sudo ufw allow 443/tcp   # HTTPS
sudo ufw enable
sudo ufw status
```

## Cost Estimate (Monthly)

- EC2 t3.medium: ₹2,500
- RDS db.t3.medium: ₹4,000  
- S3 (100GB): ₹200
- Data Transfer: ₹500-1,000
- **Total: ~₹7,200-7,700/month**

## Troubleshooting

### Issue: Nginx 502 Bad Gateway
```bash
# Check if services are running
pm2 status

# Check service logs
pm2 logs veylog-backend-api
pm2 logs veylor-webapp

# Restart services
pm2 restart all
```

### Issue: Admin /admin showing 404
```bash
# Check if files exist
ls -la /var/www/admin

# Check Nginx config
sudo nginx -t

# Check permissions
sudo chown -R ubuntu:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin
```

### Issue: API not responding
```bash
# Check backend logs
pm2 logs veylog-backend-api --lines 100

# Check if port is listening
sudo netstat -tulpn | grep :3000

# Restart backend
pm2 restart veylog-backend-api
```

## Success Verification

After setup, verify:

- ✅ `https://veylog.com` loads (webapp)
- ✅ `https://veylog.com/admin` loads (admin panel)
- ✅ `https://veylog.com/api/health` returns JSON (backend)
- ✅ SSL certificate valid
- ✅ PM2 processes running
- ✅ Nginx status active
