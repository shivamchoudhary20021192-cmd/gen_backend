# Admin Panel - Manual Deployment Guide

Deploy React/Vite admin panel as static files served at /admin path.

## Prerequisites

- ✅ EC2 setup complete
- ✅ Backend API running
- ✅ Nginx configured with /admin location

## Architecture

Admin panel is built as static files (HTML, JS, CSS) and served directly by Nginx. No PM2 needed.

```
Nginx → /var/www/admin/ (static files)
```

## Step 1: Build Admin Panel Locally

**On your local development machine:**

```bash
cd D:\veylog-fronend-admin

# Create production environment file
echo "VITE_API_URL=https://veylog.com/api" > .env.production

# Install dependencies (if needed)
npm install

# Build for production
npm run build
```

**Expected output:**
```
vite v5.0.0 building for production...
✓ 1234 modules transformed.
dist/index.html                  1.23 kB │ gzip:  0.58 kB
dist/assets/index-abc123.js    456.78 kB │ gzip: 123.45 kB
✓ built in 12.34s
```

**Verify build:**
```cmd
dir dist
```

Should show:
```
index.html
assets/
  index-abc123.js
  index-xyz456.css
```

## Step 2: Upload to EC2

### Option A: Using SCP (From Windows)

```cmd
REM Navigate to admin directory
cd D:\veylog-fronend-admin

REM Upload dist folder to EC2
scp -i path\to\veylog-key.pem -r dist/* ubuntu@<EC2-IP>:/tmp/admin-build/
```

**Then on EC2:**

```bash
# SSH into EC2
ssh -i veylog-key.pem ubuntu@<EC2-IP>

# Move files to web root
sudo rm -rf /var/www/admin/*
sudo mv /tmp/admin-build/* /var/www/admin/

# Set permissions
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin

# Verify
ls -la /var/www/admin/
```

### Option B: Git Clone and Build on EC2

```bash
# SSH into EC2
ssh -i veylog-key.pem ubuntu@<EC2-IP>

# Navigate to temp directory
cd /tmp

# Clone admin repository
git clone https://bitbucket.org/your-workspace/veylog-fronend-admin.git admin-build

cd admin-build

# Checkout develop branch
git checkout develop

# Create production env
echo "VITE_API_URL=https://veylog.com/api" > .env.production

# Install dependencies
npm install

# Build
npm run build

# Move build files
sudo rm -rf /var/www/admin/*
sudo cp -r dist/* /var/www/admin/

# Set permissions
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin

# Cleanup
cd ~
rm -rf /tmp/admin-build
```

### Option C: Using Rsync (Linux/Mac)

```bash
# From local machine
cd D:\veylog-fronend-admin

rsync -avz -e "ssh -i path/to/veylog-key.pem" \
  dist/ \
  ubuntu@<EC2-IP>:/var/www/admin/
```

## Step 3: Verify Files

```bash
# Check files exist
ls -la /var/www/admin/

# Should show:
# index.html
# assets/
# favicon.ico (if present)
```

**Check index.html:**

```bash
cat /var/www/admin/index.html | head -20
```

Should show HTML with script tags pointing to `/admin/assets/...`

## Step 4: Fix Base Path (If Needed)

If assets are not loading, you may need to configure base path.

**vite.config.ts** (build locally with this):

```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
  }
})
```

Rebuild and redeploy.

## Step 5: Test Admin Panel

```bash
# Test from EC2
curl -I http://localhost/admin

# Should return:
# HTTP/1.1 301 Moved Permanently (redirect to /admin/)

curl -I http://localhost/admin/

# Should return:
# HTTP/1.1 200 OK
```

**Test in browser:**

```
http://<EC2-IP>/admin
# Or after DNS/SSL:
https://veylog.com/admin
```

You should see the admin login page.

## Step 6: Test API Connection

Login with test credentials (after creating admin user in backend):

```
Email: admin@veylog.com
Password: Admin@123
```

If login works, admin is correctly connected to backend API!

## Step 7: Verify Nginx Serving

```bash
# Check Nginx access log
sudo tail -f /var/log/nginx/veylog-access.log

# Access admin in browser, should see requests like:
# GET /admin/ 200
# GET /admin/assets/index-abc123.js 200
```

---

## Updating Admin Panel

When deploying new admin code:

### From Local Machine

```bash
# Build locally
cd D:\veylog-fronend-admin
npm run build

# Upload to EC2
scp -i path\to\key.pem -r dist/* ubuntu@<EC2-IP>:/tmp/admin-update/
```

**On EC2:**

```bash
# Backup current version (optional)
sudo cp -r /var/www/admin /var/www/admin-backup-$(date +%Y%m%d)

# Update files
sudo rm -rf /var/www/admin/*
sudo mv /tmp/admin-update/* /var/www/admin/
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin

# No restart needed! Nginx serves static files immediately
```

### Building on EC2

```bash
cd /tmp
git clone <admin-repo> admin-build || (cd admin-build && git pull origin develop)
cd admin-build
git checkout develop
git pull origin develop

echo "VITE_API_URL=https://veylog.com/api" > .env.production

npm install
npm run build

sudo rm -rf /var/www/admin/*
sudo cp -r dist/* /var/www/admin/
sudo chown -R www-data:www-data /var/www/admin

# Cleanup
cd ~
rm -rf /tmp/admin-build
```

---

## File Structure

```
/var/www/admin/
├── index.html              # Main HTML file
├── assets/
│   ├── index-[hash].js     # Main JavaScript bundle
│   ├── index-[hash].css    # Main CSS bundle
│   └── ...                 # Other assets
├── favicon.ico             # Favicon (if present)
└── robots.txt              # (optional)
```

---

## Troubleshooting

### Admin shows blank page

**Check browser console:**
- 404 errors on /admin/assets/... → Base path issue
- CORS errors → Check API CORS settings
- API connection failed → Check VITE_API_URL

**Check Nginx logs:**

```bash
sudo tail -50 /var/log/nginx/veylog-error.log
```

### Assets not loading (404)

**Option 1: Rebuild with correct base**

```typescript
// vite.config.ts
export default defineConfig({
  base: '/admin/'
})
```

**Option 2: Fix Nginx alias**

```bash
sudo nano /etc/nginx/snippets/veylog-locations.conf
```

Ensure:
```nginx
location /admin {
    alias /var/www/admin;
    try_files $uri $uri/ /admin/index.html;
}
```

### API calls failing

**Check .env.production used during build:**

```bash
# Should be:
VITE_API_URL=https://veylog.com/api

# NOT:
VITE_API_URL=http://localhost:3000
```

Rebuild with correct URL.

### Permission denied

```bash
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin
sudo systemctl reload nginx
```

---

## Nginx Configuration Verification

```bash
# Test Nginx config
sudo nginx -t

# Check admin location block
sudo nginx -T | grep -A 20 "location /admin"
```

Should show:
```nginx
location /admin {
    alias /var/www/admin;
    try_files $uri $uri/ /admin/index.html;
    # ...
}
```

---

## Cache Control

For faster loads and bandwidth savings:

### Browser Caching

Nginx config already includes:

```nginx
location ~* /admin/.*\.(js|css|png|jpg|jpeg|gif|svg|ico)$ {
    alias /var/www/admin;
    expires 1y;
    add_header Cache-Control "public, immutable";
}
```

### Clear Browser Cache

After deploying updates, users may need to clear cache or hard refresh (Ctrl+F5).

**To force cache busting**, Vite automatically adds hashes to filenames:
```
index-abc123.js
index-xyz456.css
```

---

## Security

### Headers

Already configured in Nginx:

```nginx
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-XSS-Protection "1; mode=block" always;
```

### Prevent Direct File Access

```nginx
location ~ /admin/\.(env|git|gitignore) {
    deny all;
}
```

---

## Monitoring

### Check Admin Access

```bash
# Count admin requests
sudo grep "/admin" /var/log/nginx/veylog-access.log | wc -l

# Check recent admin access
sudo tail -50 /var/log/nginx/veylog-access.log | grep "/admin"

# Check for errors
sudo grep "/admin" /var/log/nginx/veylog-error.log
```

---

## Performance

Admin is already optimized:

- ✅ Static files (no server processing)
- ✅ Gzip compression (Nginx)
- ✅ Browser caching (1 year for assets)
- ✅ Minified JS/CSS (Vite)
- ✅ Code splitting (Vite)

Typical load time: < 1 second

---

## Deployment Checklist

- [ ] Build admin locally with correct VITE_API_URL
- [ ] Upload/copy files to /var/www/admin
- [ ] Set correct permissions (www-data:www-data, 755)
- [ ] Test http://localhost/admin
- [ ] Test login functionality
- [ ] Test API calls from admin
- [ ] Check browser console for errors
- [ ] Test on different browsers
- [ ] Verify HTTPS access (after SSL setup)

---

## Quick Deployment Script

Save as `deploy-admin.sh`:

```bash
#!/bin/bash

# Admin deployment script
echo "🚀 Deploying Admin Panel..."

# Build locally
cd /path/to/veylog-fronend-admin
echo "VITE_API_URL=https://veylog.com/api" > .env.production
npm run build

# Upload to EC2
scp -i ~/.ssh/veylog-key.pem -r dist/* ubuntu@<EC2-IP>:/tmp/admin-deploy/

# SSH and move files
ssh -i ~/.ssh/veylog-key.pem ubuntu@<EC2-IP> << 'EOF'
  sudo rm -rf /var/www/admin/*
  sudo mv /tmp/admin-deploy/* /var/www/admin/
  sudo chown -R www-data:www-data /var/www/admin
  sudo chmod -R 755 /var/www/admin
  echo "✅ Admin deployed!"
EOF

echo "✅ Deployment complete!"
echo "🌐 Admin URL: https://veylog.com/admin"
```

---

## Next Steps

All three services are now deployed!

**Verify Everything:**

```bash
# Backend API
curl http://localhost:3000/api/health

# Webapp
curl http://localhost:3001/

# Admin
curl http://localhost/admin/

# Via Nginx
curl http://localhost/api/health
curl http://localhost/
curl http://localhost/admin/
```

**Final Steps:**
1. Configure DNS to point to EC2 IP
2. Setup SSL certificate (Let's Encrypt)
3. Test all services via domain
4. Monitor logs and performance

---

**Deployment Time:** 10-15 minutes  
**Status:** Admin Panel Deployed at /admin ✅

## Complete Platform Status

- ✅ Backend API - Port 3000 - `/api/*`
- ✅ Webapp - Port 3001 - `/`
- ✅ Admin Panel - Static - `/admin/*`
- ✅ Nginx - Reverse Proxy
- ✅ MySQL - Database
- ✅ PM2 - Process Manager

🎉 **Veylog Platform Fully Deployed!**
