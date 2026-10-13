# Veylog Platform - Manual Deployment Documentation

Complete manual deployment guides for deploying all three services on a single EC2 instance.

## 📚 Documentation Index

### Quick Start
- **[Deployment Overview](00-DEPLOYMENT-OVERVIEW.md)** - Start here! Complete overview and quick reference

### Step-by-Step Guides

1. **[EC2 Initial Setup](01-EC2-INITIAL-SETUP.md)** ⏱️ 30-45 min
   - Launch EC2 instance
   - Install Node.js, PM2, and basic tools
   - Setup firewall and swap
   - Create directory structure

2. **[MySQL Installation](02-MYSQL-INSTALLATION.md)** ⏱️ 20-30 min
   - Install MySQL 8.0 (local or RDS)
   - Create database and users
   - Run migrations
   - Performance tuning

3. **[Nginx Installation](03-NGINX-INSTALLATION.md)** ⏱️ 30-40 min
   - Install and configure Nginx
   - Setup reverse proxy
   - Configure SSL (Let's Encrypt)
   - Performance optimization

4. **[Backend Deployment](04-BACKEND-DEPLOYMENT.md)** ⏱️ 20-30 min
   - Clone backend repository
   - Configure environment variables
   - Build TypeScript application
   - Start with PM2

5. **[Webapp Deployment](05-WEBAPP-DEPLOYMENT.md)** ⏱️ 15-20 min
   - Clone Next.js webapp
   - Configure environment
   - Build and start with PM2
   - Test routing

6. **[Admin Deployment](06-ADMIN-DEPLOYMENT.md)** ⏱️ 10-15 min
   - Build React admin panel
   - Upload static files
   - Configure Nginx serving
   - Test login

**Total Time: 2-3 hours** for complete setup from scratch

---

## 🏗️ Architecture

```
Single EC2 Server
├── Nginx (Reverse Proxy & Static Server)
│   ├── / → Next.js Webapp (Port 3001)
│   ├── /api → Node.js Backend (Port 3000)
│   └── /admin → React SPA (Static Files)
│
├── PM2 (Process Manager)
│   ├── veylog-backend-api
│   └── veylor-webapp
│
└── MySQL (Local or RDS)
    └── veylog_db
```

---

## 🎯 URL Structure

| Path | Service | Port | Technology |
|------|---------|------|------------|
| `/` | Main Webapp | 3001 | Next.js |
| `/api/*` | Backend API | 3000 | Node.js/Express |
| `/admin/*` | Admin Panel | N/A | React (Static) |

**Example URLs:**
- `https://veylog.com` - Main storefront
- `https://veylog.com/api/health` - API health check
- `https://veylog.com/admin` - Admin panel login

---

## ✅ Prerequisites

Before starting deployment:

- [ ] AWS account with EC2 access
- [ ] Domain name (e.g., veylog.com)
- [ ] Git repository access (Bitbucket)
- [ ] SSH key pair for EC2
- [ ] Basic terminal/command line knowledge

---

## 🚀 Quick Start Commands

### 1. EC2 Setup
```bash
ssh -i key.pem ubuntu@<EC2-IP>
sudo apt update && sudo apt upgrade -y
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs mysql-server nginx
sudo npm install -g pm2
```

### 2. Deploy Backend
```bash
cd /var/www
git clone <backend-repo> veylog-backend
cd veylog-backend
npm install && npm run build
pm2 start dist/index.js --name veylog-backend-api
```

### 3. Deploy Webapp
```bash
cd /var/www
git clone <webapp-repo> veylor-webapp
cd veylor-webapp
npm install && npm run build
pm2 start npm --name veylor-webapp -- start
```

### 4. Deploy Admin
```bash
# Build locally, then upload
scp -r dist/* ubuntu@<EC2-IP>:/var/www/admin/
```

### 5. Setup SSL
```bash
sudo certbot --nginx -d veylog.com -d www.veylog.com
```

---

## 📋 Configuration Files

### Backend `.env`
```env
NODE_ENV=production
PORT=3000
DB_HOST=localhost
DB_USER=veylog_admin
DB_PASSWORD=<password>
DB_NAME=veylog_db
JWT_SECRET=<generate-with-openssl>
CORS_ORIGINS=https://veylog.com
```

### Webapp `.env.production`
```env
NODE_ENV=production
NEXT_PUBLIC_API_URL=https://veylog.com/api
NEXTAUTH_URL=https://veylog.com
NEXTAUTH_SECRET=<generate-with-openssl>
```

### Admin `.env.production`
```env
VITE_API_URL=https://veylog.com/api
```

---

## 🔍 Verification

After deployment, verify all services:

```bash
# Check PM2 processes
pm2 status

# Test backend
curl http://localhost:3000/api/health

# Test webapp
curl http://localhost:3001/

# Test admin
curl http://localhost/admin/

# Test via domain
curl https://veylog.com/api/health
curl https://veylog.com/
curl https://veylog.com/admin/
```

Expected: All return 200 OK

---

## 🔧 Common Tasks

### Update Backend
```bash
cd /var/www/veylog-backend
git pull origin develop
npm install && npm run build
pm2 restart veylog-backend-api
```

### Update Webapp
```bash
cd /var/www/veylor-webapp
git pull origin develop
npm install && npm run build
pm2 restart veylor-webapp
```

### Update Admin
```bash
# Build locally
npm run build

# Upload
scp -r dist/* ubuntu@<EC2-IP>:/var/www/admin/
```

### View Logs
```bash
# PM2 logs
pm2 logs

# Nginx logs
sudo tail -f /var/log/nginx/veylog-error.log

# MySQL logs
sudo tail -f /var/log/mysql/error.log
```

### Restart Services
```bash
pm2 restart all
sudo systemctl restart nginx
sudo systemctl restart mysql
```

---

## 🐛 Troubleshooting

### Backend not responding
```bash
pm2 logs veylog-backend-api --err
pm2 restart veylog-backend-api
curl http://localhost:3000/api/health
```

### Webapp showing 502
```bash
pm2 status
pm2 restart veylor-webapp
sudo systemctl status nginx
```

### Admin blank page
- Check browser console for errors
- Verify `/var/www/admin/` has files
- Check `VITE_API_URL` during build
- Rebuild with correct base path

### Database connection failed
```bash
sudo systemctl status mysql
mysql -u veylog_admin -p veylog_db -e "SELECT 1"
```

### SSL issues
```bash
sudo certbot certificates
sudo certbot renew --dry-run
```

---

## 📊 Monitoring

### Health Checks
```bash
# Backend health
curl https://veylog.com/api/health

# Check all services
pm2 status

# System resources
htop
df -h
free -m
```

### Performance
```bash
# PM2 monitoring
pm2 monit

# Nginx status
curl http://localhost/nginx_status

# Database queries
mysql -u veylog_admin -p -e "SHOW PROCESSLIST;"
```

---

## 💰 Cost Estimate

### Development
- EC2 t3.small: ₹1,200/month
- RDS t3.micro: ₹1,500/month
- **Total: ~₹2,700/month**

### Production
- EC2 t3.medium: ₹2,500/month
- RDS db.t3.medium: ₹4,000/month
- Data transfer & S3: ₹700/month
- **Total: ~₹7,200/month**

---

## 🔐 Security Checklist

- [ ] SSH key-only access
- [ ] UFW firewall enabled
- [ ] SSL certificate active
- [ ] MySQL not publicly accessible
- [ ] Strong passwords for all services
- [ ] Environment variables secured
- [ ] Regular security updates
- [ ] Nginx security headers enabled
- [ ] Fail2ban installed (optional)

---

## 📞 Support

For deployment issues:

1. **Check logs**
   ```bash
   pm2 logs --err
   sudo tail -50 /var/log/nginx/veylog-error.log
   ```

2. **Verify services**
   ```bash
   pm2 status
   sudo systemctl status nginx
   sudo systemctl status mysql
   ```

3. **Consult specific guide**
   - See individual deployment documents above
   - Check troubleshooting sections

---

## 📝 Notes

- **No CI/CD** - All deployments are manual
- **Single server** - All services on one EC2 instance
- **PM2** - Process manager for Node.js services
- **Nginx** - Reverse proxy and static file server
- **MySQL** - Can be local or RDS

---

## 🎓 Learning Resources

- [PM2 Documentation](https://pm2.keymetrics.io/docs/)
- [Nginx Documentation](https://nginx.org/en/docs/)
- [MySQL Documentation](https://dev.mysql.com/doc/)
- [Next.js Documentation](https://nextjs.org/docs)
- [AWS EC2 Documentation](https://docs.aws.amazon.com/ec2/)

---

## 📅 Maintenance Schedule

### Daily
- Check service status
- Monitor error logs
- Check disk space

### Weekly
- Review access logs
- Check for security updates
- Backup database

### Monthly
- Update system packages
- Update Node.js dependencies
- Review SSL certificate expiry
- Performance review

---

## ✨ Success Criteria

Platform is successfully deployed when:

- ✅ All PM2 processes show "online"
- ✅ Nginx returns 200 for all paths
- ✅ Backend API health check passes
- ✅ Webapp loads correctly
- ✅ Admin login works
- ✅ SSL certificate valid
- ✅ All URLs accessible via domain

---

**Documentation Version:** 1.0  
**Last Updated:** January 2024  
**Platform:** Single EC2 Manual Deployment  
**Status:** Production Ready

---

## 🚀 Get Started

Begin with **[Deployment Overview](00-DEPLOYMENT-OVERVIEW.md)** for complete walkthrough!
