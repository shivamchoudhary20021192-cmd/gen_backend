# Veylog Platform - Complete Deployment Overview

Manual deployment guide for all three services on single EC2 instance.

## Table of Contents

1. [EC2 Initial Setup](01-EC2-INITIAL-SETUP.md) - 30-45 min
2. [MySQL Installation](02-MYSQL-INSTALLATION.md) - 20-30 min
3. [Nginx Installation](03-NGINX-INSTALLATION.md) - 30-40 min
4. [Backend Deployment](04-BACKEND-DEPLOYMENT.md) - 20-30 min
5. [Webapp Deployment](05-WEBAPP-DEPLOYMENT.md) - 15-20 min
6. [Admin Deployment](06-ADMIN-DEPLOYMENT.md) - 10-15 min

**Total Time:** 2-3 hours for complete setup

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Domain: veylog.com                  │
└─────────────────────────┬───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│              AWS EC2 Ubuntu 22.04                    │
│              t3.medium (2 vCPU, 4GB RAM)            │
└─────────────────────────┬───────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────┐
│                    Nginx (Port 80/443)               │
│                  Reverse Proxy & Static              │
└─────┬───────────────────┬────────────────────┬──────┘
      │                   │                    │
      │                   │                    │
┌─────▼──────┐    ┌──────▼──────┐    ┌───────▼────────┐
│  Next.js   │    │  Node.js    │    │  React SPA     │
│  Webapp    │    │  Backend    │    │  Admin Panel   │
│  Port 3001 │    │  Port 3000  │    │  Static Files  │
│     /      │    │    /api     │    │    /admin      │
└────────────┘    └──────┬──────┘    └────────────────┘
                         │
                  ┌──────▼──────┐
                  │    MySQL    │
                  │  (Local/RDS)│
                  └─────────────┘
```

## URL Mapping

| URL | Service | Port | Type |
|-----|---------|------|------|
| `https://veylog.com` | Main Webapp | 3001 | Next.js (PM2) |
| `https://veylog.com/api` | Backend API | 3000 | Node.js (PM2) |
| `https://veylog.com/admin` | Admin Panel | N/A | Static Files |

---

## Quick Start (Order of Operations)

### 1. AWS Setup (15 min)

```bash
# Launch EC2 t3.medium
# Ubuntu 22.04 LTS
# 50GB storage
# Security group: 22, 80, 443
```

### 2. EC2 Initial Setup (30 min)

```bash
ssh -i key.pem ubuntu@<EC2-IP>

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Setup PM2 startup
pm2 startup systemd
# Run the command it outputs

# Create directories
sudo mkdir -p /var/www/{veylog-backend,veylor-webapp,admin}
sudo chown -R ubuntu:ubuntu /var/www
```

### 3. MySQL Setup (20 min)

**Option A: Local MySQL**
```bash
sudo apt install -y mysql-server
sudo mysql_secure_installation

mysql -u root -p
CREATE DATABASE veylog_db;
CREATE USER 'veylog_admin'@'localhost' IDENTIFIED BY 'SecurePass123!';
GRANT ALL PRIVILEGES ON veylog_db.* TO 'veylog_admin'@'localhost';
EXIT;
```

**Option B: AWS RDS (Recommended)**
```bash
# Create via AWS Console
# DB: veylog-db, MySQL 8.0, db.t3.medium
# Wait 5-10 minutes for creation
```

### 4. Nginx Setup (20 min)

```bash
sudo apt install -y nginx

# Remove default
sudo rm /etc/nginx/sites-enabled/default

# Create veylog config
sudo nano /etc/nginx/sites-available/veylog
# Paste config from 03-NGINX-INSTALLATION.md

# Create locations config
sudo nano /etc/nginx/snippets/veylog-locations.conf
# Paste config from 03-NGINX-INSTALLATION.md

# Enable site
sudo ln -s /etc/nginx/sites-available/veylog /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

### 5. Backend Deployment (25 min)

```bash
cd /var/www
git clone <backend-repo> veylog-backend
cd veylog-backend

# Create .env
nano .env
# Add configuration from 04-BACKEND-DEPLOYMENT.md

# Install and build
npm install
npm run build

# Run migrations
mysql -h localhost -u veylog_admin -p veylog_db < database/schema_all.sql

# Start with PM2
pm2 start dist/index.js --name veylog-backend-api
pm2 save

# Test
curl http://localhost:3000/api/health
```

### 6. Webapp Deployment (20 min)

```bash
cd /var/www
git clone <webapp-repo> veylor-webapp
cd veylor-webapp

# Create .env.production
nano .env.production
# Add: NEXT_PUBLIC_API_URL=https://veylog.com/api

# Install and build
npm install
npm run build

# Start with PM2 (port 3001)
pm2 start npm --name veylor-webapp -- start
# Or modify package.json: "start": "next start -p 3001"

pm2 save

# Test
curl http://localhost:3001/
```

### 7. Admin Deployment (15 min)

**On local machine:**
```bash
cd D:\veylog-fronend-admin
echo "VITE_API_URL=https://veylog.com/api" > .env.production
npm run build
```

**Upload to EC2:**
```bash
scp -i key.pem -r dist/* ubuntu@<EC2-IP>:/var/www/admin/
```

**On EC2:**
```bash
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin

# Test
curl http://localhost/admin/
```

### 8. SSL Setup (10 min)

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d veylog.com -d www.veylog.com
```

---

## Verification Checklist

After deployment, verify all services:

```bash
# Check PM2 processes
pm2 status

# Should show:
# veylog-backend-api - online
# veylor-webapp - online

# Test backend
curl http://localhost:3000/api/health
# Response: {"status":"ok",...}

# Test webapp
curl -I http://localhost:3001/
# Response: 200 OK

# Test admin
curl -I http://localhost/admin/
# Response: 200 OK

# Test via Nginx
curl http://localhost/api/health
curl http://localhost/
curl http://localhost/admin/

# Test via domain (after DNS)
curl https://veylog.com/api/health
curl https://veylog.com/
curl https://veylog.com/admin/
```

---

## Common Issues & Solutions

### Backend Issues

**Issue:** Database connection failed
```bash
# Check MySQL is running
sudo systemctl status mysql

# Test connection
mysql -u veylog_admin -p veylog_db -e "SELECT 1"

# Check .env credentials
cat /var/www/veylog-backend/.env | grep DB_
```

**Issue:** Port 3000 already in use
```bash
sudo lsof -i :3000
sudo kill -9 <PID>
pm2 restart veylog-backend-api
```

### Webapp Issues

**Issue:** Build fails
```bash
rm -rf .next node_modules
npm install
npm run build
```

**Issue:** API calls fail
```bash
# Check .env.production
cat /var/www/veylor-webapp/.env.production

# Should have: NEXT_PUBLIC_API_URL=https://veylog.com/api
```

### Admin Issues

**Issue:** Blank page
```bash
# Check browser console for errors
# Common: Base path issue

# Rebuild with base path
# vite.config.ts: base: '/admin/'
```

**Issue:** 404 on assets
```bash
# Check files exist
ls -la /var/www/admin/assets/

# Check permissions
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin
```

### Nginx Issues

**Issue:** 502 Bad Gateway
```bash
# Check if services are running
pm2 status

# Start services if stopped
pm2 start veylog-backend-api
pm2 start veylor-webapp

# Check Nginx error log
sudo tail -50 /var/log/nginx/veylog-error.log
```

**Issue:** 404 Not Found
```bash
# Test Nginx config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx

# Check access log
sudo tail -50 /var/log/nginx/veylog-access.log
```

---

## Maintenance Commands

### Daily

```bash
# Check service status
pm2 status

# Check logs
pm2 logs --lines 50

# Check disk space
df -h

# Check system load
uptime
```

### Weekly

```bash
# View error logs
sudo tail -100 /var/log/nginx/veylog-error.log
pm2 logs --err --lines 100

# Check for security updates
sudo apt update
sudo apt list --upgradable

# Backup database
mysqldump -u veylog_admin -p veylog_db > backup_$(date +%Y%m%d).sql
```

### Monthly

```bash
# Update system
sudo apt update && sudo apt upgrade -y

# Update Node.js packages
cd /var/www/veylog-backend && npm update
cd /var/www/veylor-webapp && npm update

# Restart services
pm2 restart all

# Check SSL certificate expiry
sudo certbot certificates
```

---

## Deployment Scripts

### Full Update Script

Save as `update-all.sh`:

```bash
#!/bin/bash

echo "🔄 Updating Veylog Platform..."

# Backend
echo "📦 Updating backend..."
cd /var/www/veylog-backend
git pull origin develop
npm install
npm run build
pm2 restart veylog-backend-api

# Webapp
echo "🌐 Updating webapp..."
cd /var/www/veylor-webapp
git pull origin develop
npm install
npm run build
pm2 restart veylor-webapp

# Check status
echo "✅ Update complete!"
pm2 status

echo "🔍 Testing services..."
curl -s http://localhost:3000/api/health | grep -q "ok" && echo "✅ Backend OK" || echo "❌ Backend Failed"
curl -s -I http://localhost:3001/ | grep -q "200" && echo "✅ Webapp OK" || echo "❌ Webapp Failed"
curl -s -I http://localhost/admin/ | grep -q "200" && echo "✅ Admin OK" || echo "❌ Admin Failed"
```

Make executable:
```bash
chmod +x update-all.sh
```

---

## Cost Estimate

### Monthly Costs (India Region)

**Minimal Setup (Dev/Test):**
- EC2 t3.small: ₹1,200
- RDS t3.micro: ₹1,500
- **Total: ~₹2,700/month**

**Production Setup (Recommended):**
- EC2 t3.medium: ₹2,500
- RDS db.t3.medium: ₹4,000
- S3 (100GB): ₹200
- Data Transfer: ₹500
- CloudFront (optional): ₹600
- **Total: ~₹7,200-7,800/month**

**High Traffic:**
- EC2 t3.large: ₹5,000
- RDS db.m5.large: ₹8,000
- **Total: ~₹14,000+/month**

---

## Security Checklist

- [ ] SSH key-only access (disable password)
- [ ] UFW firewall enabled (22, 80, 443)
- [ ] SSL certificate installed (Let's Encrypt)
- [ ] MySQL not publicly accessible
- [ ] Strong database passwords
- [ ] JWT secrets configured
- [ ] Environment variables secured (.env not in git)
- [ ] Nginx security headers enabled
- [ ] Regular security updates
- [ ] Fail2ban installed (optional)
- [ ] CloudWatch/monitoring setup

---

## Performance Tips

1. **Enable Nginx Caching**
2. **Use CDN for static assets** (CloudFront)
3. **Enable PM2 clustering** for backend
4. **Database query optimization**
5. **Add Redis for caching** (optional)
6. **Enable compression** (gzip)
7. **Monitor with PM2 Plus** (optional)

---

## Support & Resources

### Documentation
- EC2 Setup: `01-EC2-INITIAL-SETUP.md`
- MySQL: `02-MYSQL-INSTALLATION.md`
- Nginx: `03-NGINX-INSTALLATION.md`
- Backend: `04-BACKEND-DEPLOYMENT.md`
- Webapp: `05-WEBAPP-DEPLOYMENT.md`
- Admin: `06-ADMIN-DEPLOYMENT.md`

### Logs Locations
- Nginx Access: `/var/log/nginx/veylog-access.log`
- Nginx Error: `/var/log/nginx/veylog-error.log`
- PM2 Logs: `pm2 logs`
- MySQL Error: `/var/log/mysql/error.log`

### Useful Commands
```bash
# Check all services
pm2 status
sudo systemctl status nginx
sudo systemctl status mysql

# View logs
pm2 logs --lines 100
sudo tail -f /var/log/nginx/veylog-error.log

# Restart services
pm2 restart all
sudo systemctl restart nginx

# Check ports
sudo netstat -tulpn | grep -E ':3000|:3001|:80|:443'
```

---

## Success!

After completing all steps:

- ✅ **Backend API:** https://veylog.com/api
- ✅ **Main Site:** https://veylog.com
- ✅ **Admin Panel:** https://veylog.com/admin

**Total Setup Time:** 2-3 hours  
**Status:** Production Ready 🎉

---

## Next Steps

1. **Monitor Performance**
   - Setup CloudWatch (optional)
   - Enable PM2 monitoring
   - Check error logs daily

2. **Backups**
   - Setup automated database backups
   - S3 versioning for media files
   - Code in git (already backed up)

3. **Scaling**
   - Add load balancer when traffic grows
   - Enable PM2 clustering
   - Consider separate DB server

4. **Security**
   - Regular security updates
   - Enable AWS WAF (optional)
   - Setup intrusion detection

5. **Optimization**
   - Add Redis caching
   - CDN for static assets
   - Database query optimization

---

**Documentation Version:** 1.0  
**Last Updated:** January 2024  
**Maintained By:** DevOps Team
