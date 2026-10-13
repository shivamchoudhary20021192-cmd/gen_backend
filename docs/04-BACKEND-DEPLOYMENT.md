# Backend API - Manual Deployment Guide

Complete guide to deploy Veylog Backend Node.js/TypeScript API using PM2.

## Prerequisites

- ✅ EC2 instance setup complete
- ✅ MySQL installed and database created
- ✅ Nginx installed and configured
- ✅ Node.js 20 and PM2 installed

## Step 1: Clone Repository

```bash
# Navigate to web root
cd /var/www

# Clone from Bitbucket (using HTTPS)
git clone https://bitbucket.org/your-workspace/veylog-backend.git

# Or using SSH (if SSH key added to Bitbucket)
git clone git@bitbucket.org:your-workspace/veylog-backend.git

# Navigate to directory
cd veylog-backend

# Check current branch
git branch
# Should show: * develop or * main

# Switch to develop branch if needed
git checkout develop
```

## Step 2: Create Environment File

```bash
# Copy example env file
cp .env.example .env

# Edit environment file
nano .env
```

**Complete .env configuration:**

```env
# ============================================
# Environment
# ============================================
NODE_ENV=production
PORT=3000
BASE_PATH=/api

# ============================================
# Database Configuration
# ============================================
# For Local MySQL:
DB_HOST=localhost
# For RDS MySQL:
# DB_HOST=veylog-db.xxxxx.ap-south-1.rds.amazonaws.com

DB_PORT=3306
DB_USER=veylog_admin
DB_PASSWORD=VeylogSecure123!
DB_NAME=veylog_db

# Database Pool Settings
DB_CONNECTION_LIMIT=10
DB_QUEUE_LIMIT=0
DB_WAIT_FOR_CONNECTIONS=true

# ============================================
# JWT Configuration
# ============================================
# Generate with: openssl rand -base64 32
JWT_SECRET=your-super-secret-jwt-key-change-this-in-production-please
JWT_EXPIRES_IN=7d
JWT_REFRESH_EXPIRES_IN=30d

# ============================================
# API Configuration
# ============================================
API_PREFIX=/api/v1

# ============================================
# CORS Configuration
# ============================================
# Add your domain
CORS_ORIGINS=https://veylog.com,https://www.veylog.com,http://localhost:5173

# ============================================
# Storage Configuration (AWS S3)
# ============================================
STORAGE_DRIVER=s3
AWS_S3_BUCKET=veylog-media-production
AWS_S3_REGION=ap-south-1
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=...

# Optional: CloudFront CDN
CLOUDFRONT_URL=https://d1234567890.cloudfront.net

# For local storage (development only):
# STORAGE_DRIVER=local
# LOCAL_STORAGE_PATH=./uploads
# LOCAL_BASE_URL=/uploads

# ============================================
# Email Configuration (Optional)
# ============================================
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=noreply@veylog.com
SMTP_PASSWORD=your-email-password
SMTP_FROM=Veylog <noreply@veylog.com>

# ============================================
# Rate Limiting
# ============================================
RATE_LIMIT_WINDOW_MS=900000
RATE_LIMIT_MAX_REQUESTS=100

# ============================================
# Logging
# ============================================
LOG_LEVEL=info
LOG_FILE_PATH=./logs

# ============================================
# Session
# ============================================
SESSION_SECRET=your-session-secret-change-this

# ============================================
# Payment Gateway (Optional)
# ============================================
RAZORPAY_KEY_ID=rzp_live_...
RAZORPAY_KEY_SECRET=...
STRIPE_SECRET_KEY=sk_live_...

# ============================================
# Frontend URLs
# ============================================
ADMIN_URL=https://veylog.com/admin
WEBAPP_URL=https://veylog.com
```

Save and exit (Ctrl+X, Y, Enter)

**Generate JWT Secret:**

```bash
# Generate secure JWT secret
openssl rand -base64 32

# Copy output and paste in .env as JWT_SECRET value
```

## Step 3: Install Dependencies

```bash
# Install all dependencies (including devDependencies for build)
npm install

# This will take 2-3 minutes...
```

**Expected output:**
```
added 500+ packages in 2m
```

## Step 4: Build TypeScript

```bash
# Build the application
npm run build
```

**Expected output:**
```
> veylog-backend@1.0.0 build
> tsc

Build successful!
```

**Verify build:**
```bash
ls -la dist/
# Should show compiled JavaScript files
```

## Step 5: Run Database Migrations

```bash
# Set database connection (if using RDS)
export DB_HOST="veylog-db.xxxxx.ap-south-1.rds.amazonaws.com"

# Or for local MySQL
export DB_HOST="localhost"

# Run main schema
mysql -h $DB_HOST -u veylog_admin -p veylog_db < database/schema_all.sql

# Run segment menu fixes
mysql -h $DB_HOST -u veylog_admin -p veylog_db < database/30_fix_menu_active_match.sql

# Verify tables created
mysql -h $DB_HOST -u veylog_admin -p veylog_db -e "SHOW TABLES;"
```

**Expected output:**
```
+---------------------------+
| Tables_in_veylog_db       |
+---------------------------+
| admin_menu_items          |
| admin_users               |
| categories                |
| customer_segments         |
| customers                 |
| media                     |
| orders                    |
| products                  |
| ... (50+ tables)          |
+---------------------------+
```

## Step 6: Create Super Admin User

```bash
# Run seed script (if available)
npm run seed:superadmin

# Or manually create admin user
mysql -h $DB_HOST -u veylog_admin -p veylog_db
```

```sql
-- Create super admin user
INSERT INTO admin_users (
    email, 
    password, 
    first_name, 
    last_name, 
    is_super_admin,
    is_active
) VALUES (
    'admin@veylog.com',
    -- Password: Admin@123
    -- This is bcrypt hash, generate proper one in production
    '$2b$10$rGfJw.8kXCLlz4LwZZdqYeLLjKbVMvqh2y2YvqKJ8zQZJLNJYVH6W',
    'Super',
    'Admin',
    1,
    1
);

-- Verify
SELECT id, email, first_name, is_super_admin FROM admin_users;

EXIT;
```

## Step 7: Test Application Locally

```bash
# Test run (foreground)
npm start
```

**Expected output:**
```
> veylog-backend@1.0.0 start
> node dist/index.js

[INFO] Server starting...
[INFO] Database connected
[INFO] Server listening on port 3000
[INFO] API available at http://localhost:3000/api
```

**In another terminal, test the API:**

```bash
# Test health endpoint
curl http://localhost:3000/api/health

# Or
curl http://localhost:3000/health
```

**Expected response:**
```json
{
  "status": "ok",
  "service": "veylog-admin-api",
  "database": "connected",
  "uptime_seconds": 5,
  "timestamp": "2024-01-10T10:30:00.000Z"
}
```

**If working, stop the test server:**
```bash
# Press Ctrl+C to stop
```

## Step 8: Start with PM2

```bash
# Start application with PM2
pm2 start dist/index.js --name veylog-backend-api

# Check status
pm2 status
```

**Expected output:**
```
┌─────┬──────────────────────┬─────────┬─────────┬──────────┬─────────┐
│ id  │ name                 │ mode    │ ↺       │ status   │ cpu     │
├─────┼──────────────────────┼─────────┼─────────┼──────────┼─────────┤
│ 0   │ veylog-backend-api   │ fork    │ 0       │ online   │ 0%      │
└─────┴──────────────────────┴─────────┴─────────┴──────────┴─────────┘
```

## Step 9: View Logs

```bash
# View real-time logs
pm2 logs veylog-backend-api

# View last 100 lines
pm2 logs veylog-backend-api --lines 100

# View only errors
pm2 logs veylog-backend-api --err

# Clear logs
pm2 flush
```

## Step 10: Save PM2 Configuration

```bash
# Save current PM2 processes
pm2 save

# This ensures PM2 restarts this app after server reboot
```

## Step 11: Test via Nginx

```bash
# Test via nginx proxy
curl http://localhost/api/health

# Or from browser (if DNS configured)
curl https://veylog.com/api/health
```

## Step 12: Verify All Endpoints

```bash
# Health check
curl http://localhost/api/health

# API v1 base
curl http://localhost/api/v1/

# Test login endpoint (should return 400 without body)
curl -X POST http://localhost/api/v1/auth/login \
  -H "Content-Type: application/json"
```

---

## PM2 Management Commands

### Basic Commands

```bash
# Start application
pm2 start dist/index.js --name veylog-backend-api

# Stop application
pm2 stop veylog-backend-api

# Restart application
pm2 restart veylog-backend-api

# Delete from PM2
pm2 delete veylog-backend-api

# List all applications
pm2 list

# Show detailed info
pm2 show veylog-backend-api

# Monitor resources
pm2 monit
```

### Logs

```bash
# View logs
pm2 logs veylog-backend-api

# View logs with timestamp
pm2 logs veylog-backend-api --timestamp

# View only errors
pm2 logs veylog-backend-api --err

# Follow logs
pm2 logs veylog-backend-api --lines 0

# Clear logs
pm2 flush
```

### Advanced

```bash
# Restart with 0 downtime
pm2 reload veylog-backend-api

# Scale application (cluster mode)
pm2 scale veylog-backend-api 2

# Update PM2
pm2 update

# Save process list
pm2 save

# Resurrect saved processes
pm2 resurrect
```

---

## Updating Backend (Manual Deployment)

When you need to deploy new code:

```bash
# Navigate to backend directory
cd /var/www/veylog-backend

# Pull latest code
git fetch origin
git pull origin develop
# Or for production: git pull origin main

# Install new dependencies (if any)
npm install

# Rebuild
npm run build

# Restart PM2
pm2 restart veylog-backend-api

# Check logs
pm2 logs veylog-backend-api --lines 50

# Verify health
curl http://localhost/api/health
```

**One-liner update script:**

```bash
cd /var/www/veylog-backend && \
git pull origin develop && \
npm install && \
npm run build && \
pm2 restart veylog-backend-api && \
pm2 logs veylog-backend-api --lines 20
```

---

## Environment-Specific Configurations

### Development

```env
NODE_ENV=development
LOG_LEVEL=debug
CORS_ORIGINS=http://localhost:5173,http://localhost:3001
```

### Staging

```env
NODE_ENV=staging
LOG_LEVEL=info
CORS_ORIGINS=https://staging.veylog.com
```

### Production

```env
NODE_ENV=production
LOG_LEVEL=warn
CORS_ORIGINS=https://veylog.com,https://www.veylog.com
```

---

## Troubleshooting

### Port 3000 already in use

```bash
# Find process using port 3000
sudo lsof -i :3000

# Kill the process
sudo kill -9 <PID>

# Or stop via PM2
pm2 stop veylog-backend-api
```

### Database connection failed

```bash
# Test database connection
mysql -h $DB_HOST -u veylog_admin -p veylog_db -e "SELECT 1"

# Check credentials in .env
cat .env | grep DB_

# Test from application
node -e "require('./dist/index.js')"
```

### Build errors

```bash
# Clean and rebuild
rm -rf dist node_modules
npm install
npm run build
```

### Module not found errors

```bash
# Clear npm cache
npm cache clean --force

# Reinstall
rm -rf node_modules package-lock.json
npm install
```

### PM2 process crashes

```bash
# Check error logs
pm2 logs veylog-backend-api --err --lines 100

# Check if port is available
sudo netstat -tulpn | grep :3000

# Restart with logs
pm2 restart veylog-backend-api
pm2 logs veylog-backend-api
```

### High memory usage

```bash
# Check PM2 status
pm2 status

# Reload with 0 downtime
pm2 reload veylog-backend-api

# Monitor memory
pm2 monit
```

---

## Performance Optimization

### Enable Clustering

```bash
# Stop current instance
pm2 delete veylog-backend-api

# Start in cluster mode (use all CPU cores)
pm2 start dist/index.js --name veylog-backend-api -i max

# Or specific number of instances
pm2 start dist/index.js --name veylog-backend-api -i 2
```

### PM2 Ecosystem File

Create `ecosystem.config.js`:

```javascript
module.exports = {
  apps: [{
    name: 'veylog-backend-api',
    script: './dist/index.js',
    instances: 'max',
    exec_mode: 'cluster',
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    max_memory_restart: '500M',
    watch: false,
    ignore_watch: ['node_modules', 'logs', 'uploads'],
    max_restarts: 10,
    min_uptime: '10s'
  }]
};
```

Start using ecosystem:

```bash
pm2 start ecosystem.config.js
```

---

## Monitoring and Alerts

### Setup PM2 Plus (Optional)

```bash
# Install PM2 Plus
pm2 install pm2-server-monit

# Link to PM2 Plus account (optional paid service)
pm2 link <secret> <public>
```

### Log Rotation

PM2 handles log rotation automatically, but you can customize:

```bash
# Install PM2 log rotate module
pm2 install pm2-logrotate

# Configure
pm2 set pm2-logrotate:max_size 50M
pm2 set pm2-logrotate:retain 7
pm2 set pm2-logrotate:compress true
```

---

## Security Checklist

- [ ] Change default JWT_SECRET
- [ ] Use strong database password
- [ ] Set NODE_ENV=production
- [ ] Configure CORS properly
- [ ] Use HTTPS only (after SSL setup)
- [ ] Keep dependencies updated
- [ ] Enable firewall (UFW)
- [ ] Restrict database access
- [ ] Use environment variables for secrets
- [ ] Enable rate limiting

---

## Health Monitoring Script

Create monitoring script:

```bash
nano /home/ubuntu/monitor-backend.sh
```

```bash
#!/bin/bash

# Check if backend is responding
HEALTH_CHECK=$(curl -s http://localhost:3000/api/health | grep -o "ok")

if [ "$HEALTH_CHECK" != "ok" ]; then
    echo "Backend is down! Restarting..."
    pm2 restart veylog-backend-api
    # Send alert (optional)
    # curl -X POST https://hooks.slack.com/... -d "Backend down, restarted"
fi
```

```bash
chmod +x /home/ubuntu/monitor-backend.sh

# Add to crontab (check every 5 minutes)
crontab -e
```

Add:
```
*/5 * * * * /home/ubuntu/monitor-backend.sh
```

---

## Next Steps

Backend API is deployed and running! 

**Verify:**
- ✅ `curl http://localhost:3000/api/health` returns OK
- ✅ `pm2 status` shows online
- ✅ `curl http://localhost/api/health` works via Nginx

**Next:** 
1. **Webapp Deployment** → `05-WEBAPP-DEPLOYMENT.md`
2. **Admin Deployment** → `06-ADMIN-DEPLOYMENT.md`

---

**Deployment Time:** 20-30 minutes  
**Status:** Backend API Running on Port 3000 ✅
