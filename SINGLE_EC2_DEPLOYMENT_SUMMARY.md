# ✅ Single EC2 Deployment - Setup Complete

## Overview

All three applications deployed on a single EC2 instance with Nginx reverse proxy.

## Architecture

```
Domain: veylog.com
    │
    ├── / (root)           → Next.js Webapp (Port 3001)
    ├── /api               → Node.js Backend (Port 3000)
    └── /admin             → React Admin SPA (Static files)
```

## Files Created

### Backend Repository (`d:\veylog-backend`)
- ✅ `bitbucket-pipelines.yml` - Auto-deploy to EC2
- ✅ `EC2_SINGLE_SERVER_SETUP.md` - Complete setup guide
- ✅ `scripts/ec2-initial-setup.sh` - Automated setup script
- ✅ `SINGLE_EC2_DEPLOYMENT_SUMMARY.md` - This file

### Admin Frontend (`D:\veylog-fronend-admin`)
- ✅ `bitbucket-pipelines.yml` - Build and rsync to /var/www/admin

### Webapp (`D:\veylor_webapp`)
- ✅ `bitbucket-pipelines.yml` - Auto-deploy Next.js to EC2

## Quick Start

### 1. Launch EC2 Instance

**Minimum Specs:**
- Ubuntu 22.04 LTS
- t3.medium (2 vCPU, 4GB RAM)
- 50GB SSD storage
- Security Group: Ports 22, 80, 443 open

### 2. Run Initial Setup

```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@<EC2-IP>

# Download setup script
wget https://raw.githubusercontent.com/your-repo/veylog-backend/main/scripts/ec2-initial-setup.sh

# Make executable
chmod +x ec2-initial-setup.sh

# Run setup
./ec2-initial-setup.sh
```

**Or manually follow:** `EC2_SINGLE_SERVER_SETUP.md`

### 3. Configure DNS

Point your domain to EC2:

```
Type: A
Name: @
Value: <EC2-PUBLIC-IP>

Type: A
Name: www
Value: <EC2-PUBLIC-IP>
```

### 4. Setup SSL

```bash
sudo certbot --nginx -d veylog.com -d www.veylog.com
```

### 5. Configure Bitbucket Pipelines

**For all three repositories**, add these variables:

**Repository Settings → Pipelines → Repository variables:**
```
SSH_USER=ubuntu
EC2_SERVER=<EC2-IP-OR-DOMAIN>
DOMAIN=veylog.com
```

**Add SSH Key:**
1. Generate key: `ssh-keygen -t rsa -b 4096 -f ~/.ssh/bitbucket-veylog`
2. Copy to EC2: `ssh-copy-id -i ~/.ssh/bitbucket-veylog.pub ubuntu@<EC2-IP>`
3. Add private key to Bitbucket: **Settings → Pipelines → SSH keys**

### 6. Deploy!

```bash
# Backend
cd d:\veylog-backend
git push origin main
# Bitbucket → Pipelines → deploy-to-production

# Admin
cd D:\veylog-fronend-admin
git push origin main
# Bitbucket → Pipelines → deploy-to-production

# Webapp
cd D:\veylor_webapp
git push origin main
# Bitbucket → Pipelines → deploy-to-production
```

## Directory Structure on EC2

```
/var/www/
├── veylog-backend/          (Node.js API - Port 3000)
│   ├── dist/                (Built TypeScript)
│   ├── .env                 (Environment config)
│   └── ...
├── veylor-webapp/           (Next.js - Port 3001)
│   ├── .next/               (Built Next.js)
│   ├── .env.production
│   └── ...
└── admin/                   (React SPA - Static)
    ├── index.html
    ├── assets/
    └── ...
```

## Service Management

### Check Status
```bash
pm2 status
pm2 logs veylog-backend-api
pm2 logs veylor-webapp
sudo systemctl status nginx
```

### Restart Services
```bash
pm2 restart veylog-backend-api
pm2 restart veylor-webapp
sudo systemctl reload nginx
```

### View Logs
```bash
# PM2 logs
pm2 logs --lines 100

# Nginx logs
sudo tail -f /var/log/nginx/veylog-access.log
sudo tail -f /var/log/nginx/veylog-error.log
```

## Nginx Configuration

Location: `/etc/nginx/sites-available/veylog`

**URL Routing:**
- `https://veylog.com/` → webapp (localhost:3001)
- `https://veylog.com/api/*` → backend (localhost:3000)
- `https://veylog.com/admin/*` → static files (/var/www/admin)

## Database Setup

### RDS MySQL
```bash
# Create RDS instance
aws rds create-db-instance \
  --db-instance-identifier veylog-db \
  --db-instance-class db.t3.medium \
  --engine mysql \
  --master-username veylog_admin \
  --master-user-password <password> \
  --allocated-storage 50

# Run migrations
mysql -h <rds-endpoint> -u veylog_admin -p veylog_db < database/schema_all.sql
mysql -h <rds-endpoint> -u veylog_admin -p veylog_db < database/30_fix_menu_active_match.sql
```

## Environment Variables

### Backend (.env)
```env
NODE_ENV=production
PORT=3000
BASE_PATH=/api
DB_HOST=<rds-endpoint>
DB_USER=veylog_admin
DB_PASSWORD=<password>
DB_NAME=veylog_db
JWT_SECRET=<generate-with-openssl>
STORAGE_DRIVER=s3
AWS_S3_BUCKET=veylog-media-production
CORS_ORIGINS=https://veylog.com
API_PREFIX=/api/v1
```

### Webapp (.env.production)
```env
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://veylog.com/api
DATABASE_URL=mysql://...
NEXTAUTH_SECRET=<generate-with-openssl>
NEXTAUTH_URL=https://veylog.com
```

### Admin (build time)
Set in `bitbucket-pipelines.yml`:
```bash
VITE_API_URL=https://veylog.com/api
```

## Deployment Workflow

```
1. Developer pushes code → Bitbucket
2. Bitbucket Pipeline triggers
3. Build application
4. SSH into EC2
5. Pull latest code
6. Install dependencies
7. Build application
8. Restart PM2 service
9. ✅ Deployment complete
```

**For Admin:**
- Build static files
- Rsync to `/var/www/admin`
- Nginx serves files

## Troubleshooting

### Issue: 502 Bad Gateway
```bash
pm2 status
pm2 restart all
sudo systemctl restart nginx
```

### Issue: /admin shows 404
```bash
ls -la /var/www/admin
sudo chown -R ubuntu:www-data /var/www/admin
sudo systemctl reload nginx
```

### Issue: API not responding
```bash
pm2 logs veylog-backend-api --lines 50
cd /var/www/veylog-backend
npm run build
pm2 restart veylog-backend-api
```

### Issue: Database connection error
```bash
# Check RDS security group allows EC2 security group
# Verify credentials in .env
mysql -h <rds-endpoint> -u veylog_admin -p -e "SELECT 1"
```

## Cost Estimate (Monthly)

- EC2 t3.medium: ₹2,500
- RDS db.t3.medium: ₹4,000
- S3 (100GB): ₹200
- Data Transfer: ₹500
- **Total: ~₹7,200/month**

## Monitoring

### Health Checks
- Backend API: `https://veylog.com/api/health`
- Webapp: `https://veylog.com`
- Admin: `https://veylog.com/admin`

### Server Health
```bash
# CPU/Memory
htop

# Disk space
df -h

# PM2 monitoring
pm2 monit
```

## Backup Strategy

### Code
- Git repositories (source of truth)
- No backup needed on server

### Database
```bash
# Manual backup
mysqldump -h <rds-endpoint> -u veylog_admin -p veylog_db > backup.sql

# RDS automated backups (7 days retention)
```

### Media Files (S3)
- Versioning enabled
- Cross-region replication (optional)

## Security Checklist

- ✅ SSH key-only access (no passwords)
- ✅ UFW firewall enabled
- ✅ SSL certificate installed
- ✅ RDS not publicly accessible
- ✅ Environment variables secured
- ✅ Nginx rate limiting enabled
- ✅ Regular security updates
- ✅ CloudWatch monitoring

## URLs After Deployment

- **Main Site:** https://veylog.com
- **Admin Panel:** https://veylog.com/admin
- **Backend API:** https://veylog.com/api
- **API Health:** https://veylog.com/api/health

## Support

For deployment issues:
- Check logs: `pm2 logs`
- Check Nginx: `sudo nginx -t`
- Review: `EC2_SINGLE_SERVER_SETUP.md`

## Success Verification

After deployment, test:
```bash
# API health check
curl https://veylog.com/api/health

# Check services
pm2 status

# Check Nginx
sudo systemctl status nginx

# Verify SSL
curl -I https://veylog.com
```

All services should be running and accessible via HTTPS!

---

**Setup Time:** 1-2 hours  
**Deployment Time:** 5-10 minutes per service  
**Status:** Ready for production ✅
