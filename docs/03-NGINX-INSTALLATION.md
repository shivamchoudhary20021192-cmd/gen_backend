# Nginx Installation and Configuration

Complete guide to install and configure Nginx as reverse proxy for Veylog platform.

## Architecture

```
User Request → Nginx (Port 80/443)
                │
                ├─ / → Next.js Webapp (Port 3001)
                ├─ /api → Backend API (Port 3000)
                └─ /admin → React Admin (Static files)
```

## Step 1: Install Nginx

```bash
# Update package list
sudo apt update

# Install Nginx
sudo apt install -y nginx

# Verify installation
nginx -v
# Should show: nginx version: nginx/1.18.0 (Ubuntu)

# Check status
sudo systemctl status nginx
```

**Expected output:**
```
● nginx.service - A high performance web server
     Loaded: loaded
     Active: active (running)
```

## Step 2: Verify Nginx is Working

```bash
# Check if Nginx is listening on port 80
sudo netstat -tulpn | grep :80
```

**Test in browser:**
```
http://<EC2-PUBLIC-IP>
```

You should see: "Welcome to nginx!" page.

## Step 3: Remove Default Configuration

```bash
# Remove default site
sudo rm /etc/nginx/sites-enabled/default

# Verify
ls -la /etc/nginx/sites-enabled/
# Should show empty or only symbolic links
```

## Step 4: Create Veylog Configuration

```bash
# Create configuration file
sudo nano /etc/nginx/sites-available/veylog
```

**Paste this complete configuration:**

```nginx
# ============================================
# Veylog Platform - Nginx Configuration
# ============================================
# Main Site: veylog.com (Port 3001 - Next.js)
# API: veylog.com/api (Port 3000 - Node.js)
# Admin: veylog.com/admin (Static files)
# ============================================

# Upstream servers
upstream webapp_backend {
    server 127.0.0.1:3001;
    keepalive 64;
}

upstream api_backend {
    server 127.0.0.1:3000;
    keepalive 64;
}

# Rate limiting zones
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
limit_req_zone $binary_remote_addr zone=general_limit:10m rate=30r/s;
limit_req_zone $binary_remote_addr zone=admin_limit:10m rate=20r/s;

# HTTP Server - Redirect to HTTPS (after SSL setup)
server {
    listen 80;
    listen [::]:80;
    server_name veylog.com www.veylog.com;

    # For now, serve normally (comment out after SSL setup)
    # return 301 https://$server_name$request_uri;

    # Temporary: Forward to HTTPS server config below
    root /var/www/html;
    
    # Include the main location blocks
    include /etc/nginx/snippets/veylog-locations.conf;
}

# HTTPS Server (will be configured by Certbot)
# Uncomment after SSL certificate is installed
# server {
#     listen 443 ssl http2;
#     listen [::]:443 ssl http2;
#     server_name veylog.com www.veylog.com;
#
#     # SSL certificates (managed by Certbot)
#     # ssl_certificate /etc/letsencrypt/live/veylog.com/fullchain.pem;
#     # ssl_certificate_key /etc/letsencrypt/live/veylog.com/privkey.pem;
#     # include /etc/letsencrypt/options-ssl-nginx.conf;
#     # ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;
#
#     # Security headers
#     add_header Strict-Transport-Security "max-age=31536000; includeSubDomains; preload" always;
#     add_header X-Frame-Options "SAMEORIGIN" always;
#     add_header X-Content-Type-Options "nosniff" always;
#     add_header X-XSS-Protection "1; mode=block" always;
#     add_header Referrer-Policy "strict-origin-when-cross-origin" always;
#
#     # Include location blocks
#     include /etc/nginx/snippets/veylog-locations.conf;
# }

# Common logging
access_log /var/log/nginx/veylog-access.log;
error_log /var/log/nginx/veylog-error.log warn;
```

Save and exit (Ctrl+X, Y, Enter)

## Step 5: Create Location Blocks Snippet

This separates the location configuration for reuse:

```bash
# Create snippets directory if not exists
sudo mkdir -p /etc/nginx/snippets

# Create locations config
sudo nano /etc/nginx/snippets/veylog-locations.conf
```

**Paste this configuration:**

```nginx
# ============================================
# Location Blocks - Shared between HTTP/HTTPS
# ============================================

# General settings
client_max_body_size 50M;
client_body_timeout 60s;
client_header_timeout 60s;

# Logging
access_log /var/log/nginx/veylog-access.log;
error_log /var/log/nginx/veylog-error.log;

# ============================================
# Backend API - /api/*
# ============================================
location /api {
    # Rate limiting
    limit_req zone=api_limit burst=20 nodelay;
    limit_req_status 429;

    # Proxy to Node.js API
    proxy_pass http://api_backend;
    proxy_http_version 1.1;
    
    # Headers
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-Host $host;
    proxy_set_header X-Forwarded-Port $server_port;
    
    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 300s;
    
    # Buffering
    proxy_buffering off;
    proxy_cache_bypass $http_upgrade;
    
    # Additional settings
    proxy_redirect off;
}

# ============================================
# Admin Panel - /admin/*
# ============================================
location /admin {
    # Rate limiting
    limit_req zone=admin_limit burst=30 nodelay;
    
    # Serve static files
    alias /var/www/admin;
    try_files $uri $uri/ /admin/index.html;
    
    # Index file
    index index.html;
    
    # Cache static assets
    location ~* /admin/.*\.(js|css|png|jpg|jpeg|gif|svg|ico|woff|woff2|ttf|eot|json)$ {
        alias /var/www/admin;
        expires 1y;
        add_header Cache-Control "public, immutable";
        access_log off;
    }
    
    # No cache for HTML
    location ~* /admin/.*\.html$ {
        alias /var/www/admin;
        expires -1;
        add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0";
    }
}

# Admin root redirect
location = /admin/ {
    return 301 /admin/index.html;
}

# ============================================
# Main Webapp - Next.js at Root
# ============================================
location / {
    # Rate limiting
    limit_req zone=general_limit burst=50 nodelay;
    
    # Proxy to Next.js
    proxy_pass http://webapp_backend;
    proxy_http_version 1.1;
    
    # Headers
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    
    # Timeouts
    proxy_connect_timeout 60s;
    proxy_send_timeout 60s;
    proxy_read_timeout 300s;
    
    # Buffering
    proxy_buffering off;
    proxy_cache_bypass $http_upgrade;
}

# Next.js static assets
location /_next/static {
    proxy_pass http://webapp_backend;
    expires 1y;
    add_header Cache-Control "public, immutable";
    access_log off;
}

# Next.js image optimization
location /_next/image {
    proxy_pass http://webapp_backend;
    proxy_cache_valid 200 7d;
    expires 7d;
}

# Next.js data endpoints
location /_next/data {
    proxy_pass http://webapp_backend;
    proxy_cache_bypass $http_upgrade;
}

# ============================================
# Health Checks
# ============================================
location /health {
    proxy_pass http://api_backend/health;
    access_log off;
}

location /api/health {
    proxy_pass http://api_backend/api/health;
    access_log off;
}

# ============================================
# Security - Block access to hidden files
# ============================================
location ~ /\. {
    deny all;
    access_log off;
    log_not_found off;
}

# Block access to sensitive files
location ~* \.(env|git|gitignore|htaccess|htpasswd|ini|log|sh|sql|conf)$ {
    deny all;
    access_log off;
}
```

Save and exit (Ctrl+X, Y, Enter)

## Step 6: Test and Enable Configuration

```bash
# Test configuration
sudo nginx -t
```

**Expected output:**
```
nginx: the configuration file /etc/nginx/nginx.conf syntax is ok
nginx: configuration file /etc/nginx/nginx.conf test is successful
```

If test passes:

```bash
# Enable site
sudo ln -s /etc/nginx/sites-available/veylog /etc/nginx/sites-enabled/

# Reload Nginx
sudo systemctl reload nginx

# Check status
sudo systemctl status nginx
```

## Step 7: Configure Log Rotation

```bash
# Create log rotation config
sudo nano /etc/logrotate.d/veylog-nginx
```

**Paste:**

```
/var/log/nginx/veylog-*.log {
    daily
    missingok
    rotate 14
    compress
    delaycompress
    notifempty
    create 0640 www-data adm
    sharedscripts
    postrotate
        if [ -f /var/run/nginx.pid ]; then
            kill -USR1 $(cat /var/run/nginx.pid)
        fi
    endscript
}
```

Save and exit.

## Step 8: Setup SSL Certificate (Let's Encrypt)

**Install Certbot:**

```bash
# Install Certbot
sudo apt install -y certbot python3-certbot-nginx

# Verify installation
certbot --version
```

**Update your DNS first!**

Before running Certbot, ensure your domain points to EC2:

```bash
# Check DNS resolution
nslookup veylog.com
dig veylog.com

# Should return your EC2 public IP
```

**Obtain SSL Certificate:**

```bash
# Obtain certificate
sudo certbot --nginx -d veylog.com -d www.veylog.com

# Follow the prompts:
# 1. Enter email: admin@veylog.com
# 2. Agree to terms: Yes
# 3. Share email: No (optional)
# 4. Redirect HTTP to HTTPS: Yes (option 2)
```

Certbot will automatically:
- Obtain SSL certificate
- Update Nginx configuration
- Setup auto-renewal

**Test auto-renewal:**

```bash
sudo certbot renew --dry-run
```

**Check certificate:**

```bash
sudo certbot certificates
```

## Step 9: Optimize Nginx Performance

Edit main nginx config:

```bash
sudo nano /etc/nginx/nginx.conf
```

**Modify/Add these settings:**

```nginx
user www-data;
worker_processes auto;
worker_rlimit_nofile 65535;
pid /run/nginx.pid;

events {
    worker_connections 4096;
    use epoll;
    multi_accept on;
}

http {
    # Basic Settings
    sendfile on;
    tcp_nopush on;
    tcp_nodelay on;
    keepalive_timeout 65;
    keepalive_requests 100;
    types_hash_max_size 2048;
    server_tokens off;
    
    # Buffer Settings
    client_body_buffer_size 128k;
    client_max_body_size 50m;
    client_header_buffer_size 1k;
    large_client_header_buffers 4 16k;
    
    # Gzip Compression
    gzip on;
    gzip_vary on;
    gzip_proxied any;
    gzip_comp_level 6;
    gzip_types text/plain text/css text/xml text/javascript 
               application/json application/javascript application/xml+rss 
               application/rss+xml font/truetype font/opentype 
               application/vnd.ms-fontobject image/svg+xml;
    gzip_disable "msie6";
    
    # Existing configs...
    include /etc/nginx/mime.types;
    default_type application/octet-stream;
    
    # Rest of configuration...
}
```

**Restart Nginx:**

```bash
sudo systemctl restart nginx
```

## Step 10: Verify Setup

### Test Backend API

```bash
# Test locally (before DNS)
curl http://localhost/api/health

# Test via domain (after DNS)
curl https://veylog.com/api/health
```

**Expected response:**
```json
{
  "status": "ok",
  "service": "veylog-admin-api",
  "database": "connected"
}
```

### Test Admin Panel

```bash
# Check if directory exists
ls -la /var/www/admin

# Test access
curl -I http://localhost/admin
```

### Test Main Webapp

```bash
curl -I http://localhost/
```

---

## Common Nginx Commands

```bash
# Test configuration
sudo nginx -t

# Reload (graceful restart)
sudo systemctl reload nginx

# Restart (full restart)
sudo systemctl restart nginx

# Stop
sudo systemctl stop nginx

# Start
sudo systemctl start nginx

# Check status
sudo systemctl status nginx

# Enable on boot
sudo systemctl enable nginx

# View error log
sudo tail -f /var/log/nginx/veylog-error.log

# View access log
sudo tail -f /var/log/nginx/veylog-access.log

# Check configuration
sudo nginx -T
```

---

## Troubleshooting

### Nginx fails to start

```bash
# Check error log
sudo tail -50 /var/log/nginx/error.log

# Check if ports are in use
sudo netstat -tulpn | grep :80
sudo netstat -tulpn | grep :443

# Check configuration
sudo nginx -t
```

### 502 Bad Gateway

**Means backend is not running:**

```bash
# Check if services are running
pm2 status

# Check if ports are listening
sudo netstat -tulpn | grep :3000  # API
sudo netstat -tulpn | grep :3001  # Webapp

# Start services if needed
pm2 start veylog-backend-api
pm2 start veylor-webapp
```

### 404 Not Found for /admin

```bash
# Check if admin files exist
ls -la /var/www/admin/

# Check permissions
sudo chown -R www-data:www-data /var/www/admin
sudo chmod -R 755 /var/www/admin

# Reload Nginx
sudo systemctl reload nginx
```

### SSL Certificate Issues

```bash
# Check certificates
sudo certbot certificates

# Renew certificates
sudo certbot renew

# Test renewal
sudo certbot renew --dry-run

# Check certificate expiry
echo | openssl s_client -servername veylog.com -connect veylog.com:443 2>/dev/null | openssl x509 -noout -dates
```

### Performance Issues

```bash
# Check active connections
sudo netstat -an | grep :80 | wc -l

# Check nginx processes
ps aux | grep nginx

# Monitor logs in real-time
sudo tail -f /var/log/nginx/veylog-access.log

# Check error rate
sudo grep -c "error" /var/log/nginx/veylog-error.log
```

---

## Security Best Practices

### Hide Nginx Version

```bash
sudo nano /etc/nginx/nginx.conf
```

Add in http block:
```nginx
server_tokens off;
```

### Limit Request Rate

Already configured in the config above. Adjust rates as needed:

```nginx
limit_req_zone $binary_remote_addr zone=api_limit:10m rate=10r/s;
```

### Block Bad Bots

```bash
sudo nano /etc/nginx/conf.d/block-bots.conf
```

```nginx
# Block bad bots
map $http_user_agent $bad_bot {
    default 0;
    ~*^$ 1;
    ~*(bot|crawler|spider|scraper) 1;
}

server {
    if ($bad_bot) {
        return 403;
    }
}
```

### Fail2Ban for Nginx

```bash
sudo apt install -y fail2ban

# Create jail
sudo nano /etc/fail2ban/jail.d/nginx.conf
```

```ini
[nginx-http-auth]
enabled = true
port = http,https
logpath = /var/log/nginx/veylog-error.log

[nginx-limit-req]
enabled = true
port = http,https
logpath = /var/log/nginx/veylog-error.log
maxretry = 5
bantime = 600
```

```bash
sudo systemctl restart fail2ban
```

---

## Performance Monitoring

### Check Nginx Status

Enable status page (optional):

```bash
sudo nano /etc/nginx/snippets/veylog-locations.conf
```

Add:
```nginx
location /nginx_status {
    stub_status on;
    access_log off;
    allow 127.0.0.1;
    deny all;
}
```

Test:
```bash
curl http://localhost/nginx_status
```

### Monitor Logs

```bash
# Real-time access log
sudo tail -f /var/log/nginx/veylog-access.log

# Real-time error log
sudo tail -f /var/log/nginx/veylog-error.log

# Count requests per minute
sudo tail -n 1000 /var/log/nginx/veylog-access.log | awk '{print $4}' | sort | uniq -c

# Top IPs
sudo awk '{print $1}' /var/log/nginx/veylog-access.log | sort | uniq -c | sort -nr | head -10
```

---

## Next Steps

Nginx is configured! Proceed to deploy applications:

1. **Backend Deployment** → `04-BACKEND-DEPLOYMENT.md`
2. **Webapp Deployment** → `05-WEBAPP-DEPLOYMENT.md`
3. **Admin Deployment** → `06-ADMIN-DEPLOYMENT.md`

---

**Setup Time:** 30-40 minutes  
**SSL Setup:** 10 minutes additional  
**Next:** Backend Deployment
