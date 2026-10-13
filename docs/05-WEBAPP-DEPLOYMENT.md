# Webapp (Main Site) - Manual Deployment Guide

Deploy Next.js storefront at root domain using PM2.

## Prerequisites

- ✅ EC2 setup complete
- ✅ Backend API deployed and running
- ✅ Nginx configured

## Step 1: Clone Repository

```bash
cd /var/www

# Clone webapp repository
git clone https://bitbucket.org/your-workspace/veylor_webapp.git

cd veylor-webapp

# Checkout develop branch
git checkout develop
```

## Step 2: Create Environment File

```bash
# Create .env.production
nano .env.production
```

**Configuration:**

```env
# Environment
NODE_ENV=production

# API Configuration
NEXT_PUBLIC_API_URL=https://veylog.com/api

# Database (if webapp connects directly)
DATABASE_URL=mysql://veylog_admin:VeylogSecure123!@localhost:3306/veylog_db

# NextAuth Configuration
NEXTAUTH_URL=https://veylog.com
NEXTAUTH_SECRET=generate-with-openssl-rand-base64-32

# Optional: Analytics
NEXT_PUBLIC_GA_ID=G-XXXXXXXXXX

# Optional: Payment
NEXT_PUBLIC_RAZORPAY_KEY=rzp_live_...
NEXT_PUBLIC_STRIPE_KEY=pk_live_...
```

**Generate NEXTAUTH_SECRET:**

```bash
openssl rand -base64 32
# Copy output to NEXTAUTH_SECRET
```

Save and exit.

## Step 3: Install Dependencies

```bash
npm install

# This may take 3-5 minutes...
```

## Step 4: Build Next.js Application

```bash
# Build for production
npm run build
```

**Expected output:**
```
Route (app)                               Size     First Load JS
┌ ○ /                                     1.2 kB         85.4 kB
├ ○ /products                             2.1 kB         87.3 kB
└ ○ /checkout                             1.8 kB         86.9 kB

○  (Static)  automatically rendered as static HTML
```

**Verify build:**
```bash
ls -la .next/
# Should show compiled Next.js build
```

## Step 5: Test Application

```bash
# Test run in foreground
npm start
```

**Expected output:**
```
> veylor-webapp@1.0.0 start
> next start

  ▲ Next.js 14.0.0
  - Local:        http://localhost:3000
  - Network:      http://0.0.0.0:3000

 ✓ Ready in 1.5s
```

**In another terminal, test:**

```bash
curl http://localhost:3000/
# Should return HTML
```

**Note:** Next.js runs on port 3000 by default. We need to change it to 3001.

Stop the test server (Ctrl+C).

## Step 6: Configure Next.js Port

**Option A: Using package.json**

```bash
nano package.json
```

Find the start script and modify:

```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start -p 3001",
    "lint": "next lint"
  }
}
```

**Option B: Create ecosystem file**

```bash
nano ecosystem.config.js
```

```javascript
module.exports = {
  apps: [{
    name: 'veylor-webapp',
    script: 'node_modules/.bin/next',
    args: 'start -p 3001',
    env: {
      NODE_ENV: 'production',
      PORT: 3001
    },
    instances: 1,
    exec_mode: 'fork',
    max_memory_restart: '500M'
  }]
};
```

## Step 7: Start with PM2

**Option A: Simple start**

```bash
pm2 start npm --name veylor-webapp -- start

# PM2 will use the modified package.json script
```

**Option B: Using ecosystem**

```bash
pm2 start ecosystem.config.js
```

**Check status:**

```bash
pm2 status
```

**Expected output:**
```
┌─────┬──────────────────┬─────────┬─────────┬──────────┬─────────┐
│ id  │ name             │ mode    │ ↺       │ status   │ cpu     │
├─────┼──────────────────┼─────────┼─────────┼──────────┼─────────┤
│ 0   │ veylog-backend   │ fork    │ 0       │ online   │ 0%      │
│ 1   │ veylor-webapp    │ fork    │ 0       │ online   │ 0%      │
└─────┴──────────────────┴─────────┴─────────┴──────────┴─────────┘
```

## Step 8: View Logs

```bash
pm2 logs veylor-webapp
```

Should show:
```
  ▲ Next.js 14.0.0
  - Local:        http://localhost:3001
  ✓ Ready
```

## Step 9: Save PM2 Configuration

```bash
pm2 save
```

## Step 10: Test via Nginx

```bash
# Test root domain
curl http://localhost/

# Should return HTML of home page

# Or from browser (if DNS configured)
# https://veylog.com
```

## Step 11: Verify Routes

Test different routes:

```bash
# Homepage
curl -I http://localhost/

# Products page
curl -I http://localhost/products

# Should all return 200 OK
```

---

## Updating Webapp

When deploying new code:

```bash
cd /var/www/veylor-webapp

# Pull latest code
git pull origin develop

# Install new dependencies
npm install

# Rebuild
npm run build

# Restart PM2
pm2 restart veylor-webapp

# Check logs
pm2 logs veylor-webapp --lines 20
```

**One-liner:**

```bash
cd /var/www/veylor-webapp && \
git pull origin develop && \
npm install && \
npm run build && \
pm2 restart veylor-webapp && \
pm2 logs veylor-webapp --lines 20
```

---

## Troubleshooting

### Port 3001 already in use

```bash
sudo lsof -i :3001
sudo kill -9 <PID>
pm2 restart veylor-webapp
```

### Build errors

```bash
# Clear Next.js cache
rm -rf .next
npm run build
```

### API connection errors

Check .env.production:
```bash
cat .env.production | grep API_URL
# Should be: NEXT_PUBLIC_API_URL=https://veylog.com/api
```

### 502 Bad Gateway

```bash
# Check if webapp is running
pm2 status

# Check logs
pm2 logs veylor-webapp --err

# Restart
pm2 restart veylor-webapp
```

---

## Performance Tips

### Enable Caching

Next.js automatically handles caching. Ensure these are in `next.config.js`:

```javascript
module.exports = {
  compress: true,
  generateEtags: true,
  poweredByHeader: false,
  images: {
    domains: ['veylog-media.s3.ap-south-1.amazonaws.com'],
  },
}
```

### Enable ISR (Incremental Static Regeneration)

In your pages:

```javascript
export const revalidate = 3600; // Revalidate every hour
```

---

## Next Steps

Webapp is deployed!

**Verify:**
- ✅ `curl http://localhost:3001/` returns HTML
- ✅ `pm2 status` shows webapp online
- ✅ `https://veylog.com` loads in browser

**Next:** Admin Frontend Deployment → `06-ADMIN-DEPLOYMENT.md`

---

**Deployment Time:** 15-20 minutes  
**Status:** Webapp Running on Port 3001 ✅
