# Veylog Platform - Quick Deploy Reference Card

## 🚀 Quick Commands

### Initial Setup (One Time)

```bash
# 1. Setup AWS Infrastructure
cd d:\veylog-backend\scripts
bash deploy-setup.sh

# 2. Get RDS Endpoint
aws rds describe-db-instances \
  --db-instance-identifier veylog-db \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text

# 3. Run Database Migrations
mysql -h <rds-endpoint> -u veylog_admin -p veylog_db < database/schema_all.sql
```

### Deploy Backend

```bash
# To Staging
git checkout develop
git push origin develop
# Pipeline runs automatically

# To Production
git checkout main
git merge develop
git push origin main
# Go to Bitbucket → Pipelines → Run "deploy-to-production"
```

### Deploy Admin Frontend

```bash
# To Staging
git checkout develop
git push origin develop

# To Production
git checkout main
git merge develop
git push origin main
# Approve deployment in Bitbucket Pipelines
```

### Deploy Webapp (Vercel)

```bash
# Preview
vercel

# Production
vercel --prod
```

### Deploy Webapp (AWS)

```bash
git checkout main
git push origin main
# Approve deployment in Bitbucket Pipelines
```

## 📋 Bitbucket Pipeline Variables

### Backend (veylog-backend)
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION=ap-south-1
AWS_ECR_URL=<account>.dkr.ecr.ap-south-1.amazonaws.com
SSH_USER=ubuntu
STAGING_SERVER=staging-api.veylog.com
PRODUCTION_SERVER=api.veylog.com
```

### Admin (veylog-fronend-admin)
```
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION=ap-south-1
STAGING_CF_DISTRIBUTION_ID=E1XXXXX
PRODUCTION_CF_DISTRIBUTION_ID=E2XXXXX
```

### Webapp (veylor_webapp)
```
# For AWS
AWS_ACCESS_KEY_ID
AWS_SECRET_ACCESS_KEY
AWS_REGION=ap-south-1
SSH_USER=ubuntu
STAGING_SERVER=staging.veylog.com
PRODUCTION_SERVER=www.veylog.com

# OR for Vercel
VERCEL_TOKEN=<token>
```

## 🔧 Common Operations

### Check Backend Status (EC2)
```bash
ssh ubuntu@api.veylog.com
pm2 status
pm2 logs veylog-backend-api
```

### Check Database
```bash
mysql -h <rds-endpoint> -u veylog_admin -p
use veylog_db;
show tables;
```

### Invalidate CloudFront Cache
```bash
aws cloudfront create-invalidation \
  --distribution-id E2XXXXX \
  --paths "/*"
```

### View CloudWatch Logs
```bash
aws logs tail /veylog/backend --follow
```

### Restart Backend (EC2)
```bash
ssh ubuntu@api.veylog.com
pm2 restart veylog-backend-api
```

### Rollback Backend (EC2)
```bash
ssh ubuntu@api.veylog.com
cd /var/www/veylog-backend
git log --oneline -n 5
git checkout <previous-commit>
npm ci --production
npm run build
pm2 restart veylog-backend-api
```

### Rollback Admin (S3/CloudFront)
```bash
# Enable versioning first
aws s3api put-bucket-versioning \
  --bucket veylog-admin-production \
  --versioning-configuration Status=Enabled

# Restore previous version
aws s3api list-object-versions \
  --bucket veylog-admin-production \
  --prefix index.html

aws s3api copy-object \
  --copy-source veylog-admin-production/index.html?versionId=<OLD_VERSION> \
  --bucket veylog-admin-production \
  --key index.html
```

## 🔍 Troubleshooting

### Backend not responding
```bash
# Check service
ssh ubuntu@api.veylog.com
pm2 status
pm2 logs veylog-backend-api --lines 100

# Check Nginx
sudo nginx -t
sudo systemctl status nginx
```

### Database connection issues
```bash
# Test connection
mysql -h <rds-endpoint> -u veylog_admin -p -e "SELECT 1"

# Check security group
aws ec2 describe-security-groups --group-ids <db-sg-id>
```

### Pipeline failing
```bash
# Check pipeline logs in Bitbucket
# Verify all repository variables are set
# Check SSH keys are added to EC2
```

### 502 Bad Gateway
```bash
# Backend not running
pm2 restart veylog-backend-api

# Or rebuild
cd /var/www/veylog-backend
npm ci --production
npm run build
pm2 restart veylog-backend-api
```

## 📊 Monitoring URLs

- **Backend Health:** https://api.veylog.com/health
- **Admin Panel:** https://admin.veylog.com
- **Storefront:** https://www.veylog.com
- **AWS Console:** https://console.aws.amazon.com
- **CloudWatch:** https://console.aws.amazon.com/cloudwatch
- **Bitbucket Pipelines:** https://bitbucket.org/workspace/repo/pipelines

## 🔐 Security Checks

```bash
# Check security group rules
aws ec2 describe-security-groups --group-ids <sg-id>

# Check RDS public accessibility (should be false)
aws rds describe-db-instances \
  --db-instance-identifier veylog-db \
  --query 'DBInstances[0].PubliclyAccessible'

# Check S3 bucket policies
aws s3api get-bucket-policy --bucket veylog-media-production

# Verify SSL certificates
openssl s_client -connect api.veylog.com:443 -servername api.veylog.com
```

## 💰 Cost Monitoring

```bash
# Get current month costs
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics BlendedCost

# Set budget alert
aws budgets create-budget \
  --account-id <account-id> \
  --budget file://budget.json
```

## 📞 Emergency Contacts

- **AWS Support:** https://console.aws.amazon.com/support/
- **DevOps Team:** devops@veylog.com
- **On-Call:** +91-XXXXX-XXXXX

## 📚 Documentation Links

- [Master Deployment Guide](AWS_DEPLOYMENT_MASTER_GUIDE.md)
- [Backend Details](DEPLOYMENT.md)
- [Admin Frontend Details](../veylog-fronend-admin/DEPLOYMENT.md)
- [Webapp Details](../veylor_webapp/DEPLOYMENT.md)

---

**Last Updated:** 2024-01-10  
**Maintained By:** DevOps Team
