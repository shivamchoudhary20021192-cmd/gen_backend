# Veylog Platform - Complete AWS Deployment Guide

## Overview

Complete CI/CD setup for three separate Bitbucket repositories deploying to AWS:

1. **veylog-backend** - Node.js/TypeScript API
2. **veylog-fronend-admin** - React/Vite Admin Panel  
3. **veylor_webapp** - Next.js Storefront

## Architecture Diagram

```
                                    ┌─────────────────┐
                                    │   Route 53      │
                                    │   DNS           │
                                    └────────┬────────┘
                                             │
                    ┌────────────────────────┼────────────────────────┐
                    │                        │                        │
            ┌───────▼───────┐        ┌──────▼──────┐        ┌───────▼───────┐
            │  CloudFront   │        │     ALB     │        │  CloudFront   │
            │  (Admin SPA)  │        │  (Backend)  │        │  (Storefront) │
            └───────┬───────┘        └──────┬──────┘        └───────┬───────┘
                    │                       │                        │
            ┌───────▼───────┐        ┌──────▼──────┐        ┌───────▼───────┐
            │      S3       │        │   EC2/ECS   │        │   Vercel or   │
            │   (Static)    │        │  (Node.js)  │        │   EC2/ECS     │
            └───────────────┘        └──────┬──────┘        └───────────────┘
                                             │
                                      ┌──────▼──────┐
                                      │  RDS MySQL  │
                                      │  (Database) │
                                      └─────────────┘
                                             │
                                      ┌──────▼──────┐
                                      │     S3      │
                                      │   (Media)   │
                                      └─────────────┘
```

## Quick Start (Production Deployment)

### Phase 1: AWS Infrastructure Setup (1-2 hours)

```bash
# 1. Setup AWS CLI
aws configure
# Enter your credentials

# 2. Create VPC and Subnets (optional, can use default)
aws ec2 create-vpc --cidr-block 10.0.0.0/16

# 3. Create RDS Database
aws rds create-db-instance \
  --db-instance-identifier veylog-db \
  --db-instance-class db.t3.medium \
  --engine mysql \
  --master-username veylog_admin \
  --master-user-password <SecurePassword> \
  --allocated-storage 50 \
  --vpc-security-group-ids sg-xxxxx \
  --db-subnet-group-name default

# 4. Create S3 Buckets
aws s3 mb s3://veylog-admin-production
aws s3 mb s3://veylog-media-production

# 5. Create ECR Repositories (if using Docker)
aws ecr create-repository --repository-name veylog-backend
aws ecr create-repository --repository-name veylor-webapp
```

### Phase 2: Backend Deployment (30 minutes)

```bash
# 1. Navigate to backend repo
cd d:\veylog-backend

# 2. Add Bitbucket Pipeline Variables
# Go to Repository Settings → Pipelines → Repository variables
# Add all variables from DEPLOYMENT.md

# 3. Push to trigger pipeline
git add .
git commit -m "Add CI/CD pipeline"
git push origin main

# 4. Go to Bitbucket Pipelines and trigger production deployment
```

### Phase 3: Admin Frontend Deployment (20 minutes)

```bash
# 1. Navigate to admin repo
cd D:\veylog-fronend-admin

# 2. Setup CloudFront distribution (via Console or CLI)
# Follow steps in DEPLOYMENT.md

# 3. Add pipeline variables to Bitbucket

# 4. Push and deploy
git add .
git commit -m "Add CI/CD pipeline"
git push origin main
```

### Phase 4: Webapp Deployment (30 minutes)

**Option A: Vercel (Recommended)**
```bash
cd D:\veylor_webapp
npm install -g vercel
vercel login
vercel link
vercel --prod
```

**Option B: AWS EC2**
```bash
# Follow EC2 setup in veylor_webapp/DEPLOYMENT.md
```

## Repository Setup Checklist

### All Repositories

#### 1. Bitbucket Repository Variables

Navigate to each repo: **Settings → Pipelines → Repository variables**

**Common Variables:**
```
AWS_ACCESS_KEY_ID=AKIA...
AWS_SECRET_ACCESS_KEY=xxx...
AWS_REGION=ap-south-1
```

#### 2. Enable Pipelines

- Repository Settings → Pipelines → Settings
- Enable Pipelines: ✅

### Backend Repository (veylog-backend)

**Additional Variables:**
```
AWS_ECR_URL=<account-id>.dkr.ecr.ap-south-1.amazonaws.com
SSH_USER=ubuntu
STAGING_SERVER=staging-api.veylog.com
PRODUCTION_SERVER=api.veylog.com
```

**Files to commit:**
- ✅ bitbucket-pipelines.yml
- ✅ Dockerfile
- ✅ .dockerignore
- ✅ DEPLOYMENT.md

### Admin Frontend Repository (veylog-fronend-admin)

**Additional Variables:**
```
STAGING_CF_DISTRIBUTION_ID=E1XXXXX
PRODUCTION_CF_DISTRIBUTION_ID=E2XXXXX
```

**Files to commit:**
- ✅ bitbucket-pipelines.yml
- ✅ DEPLOYMENT.md

### Webapp Repository (veylor_webapp)

**Additional Variables (if using AWS):**
```
SSH_USER=ubuntu
STAGING_SERVER=staging.veylog.com
PRODUCTION_SERVER=www.veylog.com
```

**Or for Vercel:**
```
VERCEL_TOKEN=xxx
VERCEL_ORG_ID=xxx
VERCEL_PROJECT_ID=xxx
```

**Files to commit:**
- ✅ bitbucket-pipelines.yml
- ✅ Dockerfile
- ✅ DEPLOYMENT.md

## DNS Configuration

### Route 53 Hosted Zone

```bash
# Create hosted zone
aws route53 create-hosted-zone --name veylog.com --caller-reference $(date +%s)
```

### DNS Records

```
# Backend API
api.veylog.com          A       → ALB or EC2 Elastic IP
staging-api.veylog.com  A       → Staging ALB/EC2

# Admin Panel
admin.veylog.com        A       → CloudFront (Alias)
staging-admin.veylog.com A      → CloudFront (Alias)

# Storefront
www.veylog.com          A       → Vercel or CloudFront
veylog.com              A       → Redirect to www
```

## SSL Certificates

### Request Certificates

```bash
# For CloudFront (must be in us-east-1)
aws acm request-certificate \
  --domain-name "*.veylog.com" \
  --subject-alternative-names "veylog.com" \
  --validation-method DNS \
  --region us-east-1

# For ALB (in your region)
aws acm request-certificate \
  --domain-name "*.veylog.com" \
  --subject-alternative-names "veylog.com" \
  --validation-method DNS \
  --region ap-south-1
```

## Database Setup

### 1. Create RDS Instance

**Via Console:**
- Engine: MySQL 8.0
- Template: Production
- DB instance: db.t3.medium
- Storage: 50GB SSD
- Multi-AZ: Yes
- Public access: No
- VPC: Default or custom

### 2. Run Migrations

```bash
# Get RDS endpoint from AWS Console
export DB_HOST=veylog-db.xxxxx.ap-south-1.rds.amazonaws.com

# Run migrations
mysql -h $DB_HOST -u veylog_admin -p veylog_db < database/schema_all.sql

# Run individual migrations in order
for file in database/*.sql; do
  echo "Running $file..."
  mysql -h $DB_HOST -u veylog_admin -p veylog_db < "$file"
done
```

### 3. Seed Data

```bash
# From backend repo
npm run seed:superadmin
npm run seed:catalogue
```

## Deployment Workflow

### Development → Staging → Production

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   develop   │────▶│   staging    │────▶│    main     │
│   branch    │     │  auto-deploy │     │   manual    │
└─────────────┘     └──────────────┘     └─────────────┘
      │                    │                     │
      ▼                    ▼                     ▼
  Build & Test       Staging Env          Production Env
                   staging-api.com         api.veylog.com
```

### Deployment Commands

**Backend:**
```bash
# Develop → Staging (automatic on push)
git push origin develop

# Main → Production (manual trigger in Bitbucket)
git push origin main
# Then: Pipelines → deploy-to-production → Run
```

**Admin Frontend:**
```bash
# Same workflow as backend
git push origin develop  # → Staging
git push origin main     # → Production (manual)
```

**Webapp:**
```bash
# Vercel
vercel          # Preview
vercel --prod   # Production

# AWS
git push origin main
# Pipelines → deploy-to-production → Run
```

## Monitoring and Logging

### CloudWatch

```bash
# Create log groups
aws logs create-log-group --log-group-name /veylog/backend
aws logs create-log-group --log-group-name /veylog/webapp

# Set retention
aws logs put-retention-policy \
  --log-group-name /veylog/backend \
  --retention-in-days 30
```

### Alarms

```bash
# CPU Utilization
aws cloudwatch put-metric-alarm \
  --alarm-name veylog-backend-high-cpu \
  --alarm-description "Backend CPU > 80%" \
  --metric-name CPUUtilization \
  --namespace AWS/EC2 \
  --statistic Average \
  --period 300 \
  --threshold 80 \
  --comparison-operator GreaterThanThreshold \
  --evaluation-periods 2

# Database Connections
aws cloudwatch put-metric-alarm \
  --alarm-name veylog-db-connections \
  --alarm-description "RDS connections > 100" \
  --metric-name DatabaseConnections \
  --namespace AWS/RDS \
  --statistic Average \
  --period 300 \
  --threshold 100 \
  --comparison-operator GreaterThanThreshold
```

## Security Best Practices

### 1. IAM Roles (Principle of Least Privilege)

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "s3:GetObject",
        "s3:PutObject",
        "s3:DeleteObject"
      ],
      "Resource": "arn:aws:s3:::veylog-media-production/*"
    },
    {
      "Effect": "Allow",
      "Action": [
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "arn:aws:secretsmanager:ap-south-1:*:secret:veylog/*"
    }
  ]
}
```

### 2. Security Groups

**Backend (EC2/ECS):**
- Inbound: 443 (HTTPS), 22 (SSH - your IP only)
- Outbound: All

**Database (RDS):**
- Inbound: 3306 (from backend security group only)
- Outbound: None

### 3. Secrets Management

```bash
# Store secrets in AWS Secrets Manager
aws secretsmanager create-secret \
  --name veylog/backend/production \
  --secret-string '{
    "DATABASE_URL": "mysql://...",
    "JWT_SECRET": "...",
    "STRIPE_SECRET": "..."
  }'
```

### 4. Enable AWS WAF (Optional)

```bash
# Protect CloudFront and ALB
aws wafv2 create-web-acl \
  --name veylog-waf \
  --scope CLOUDFRONT \
  --default-action Allow={} \
  --rules file://waf-rules.json
```

## Cost Optimization

### Monthly Cost Estimate (India Region)

#### Minimal Setup (Development)
- EC2 t3.small: ₹1,200
- RDS t3.micro: ₹1,500
- S3 (10GB): ₹20
- CloudFront (100GB): ₹600
- **Total: ~₹3,320/month**

#### Production Setup (Medium Traffic)
- EC2 t3.medium: ₹2,500
- RDS db.t3.medium: ₹4,000
- S3 (100GB): ₹200
- CloudFront (1TB): ₹6,000
- ALB: ₹1,500
- **Total: ~₹14,200/month**

#### Alternative: Serverless
- RDS: ₹4,000
- S3: ₹200
- CloudFront: ₹6,000
- Lambda/Fargate: ₹3,000
- Vercel Pro: ₹1,600
- **Total: ~₹14,800/month**

### Cost Saving Tips

1. **Use Reserved Instances** (30-50% savings)
2. **Enable S3 Lifecycle Policies**
3. **Use CloudFront caching** (reduce origin requests)
4. **Auto-scaling** (scale down during low traffic)
5. **Spot Instances** for non-critical workloads

## Backup Strategy

### Database Backups

```bash
# Automated backups (already enabled on RDS)
aws rds modify-db-instance \
  --db-instance-identifier veylog-db \
  --backup-retention-period 7 \
  --preferred-backup-window "03:00-04:00"

# Manual snapshot
aws rds create-db-snapshot \
  --db-instance-identifier veylog-db \
  --db-snapshot-identifier veylog-db-$(date +%Y%m%d)
```

### S3 Versioning

```bash
aws s3api put-bucket-versioning \
  --bucket veylog-media-production \
  --versioning-configuration Status=Enabled
```

## Disaster Recovery

### Backup Recovery

```bash
# Restore RDS from snapshot
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier veylog-db-restored \
  --db-snapshot-identifier veylog-db-20240101

# Restore S3 file version
aws s3api list-object-versions --bucket veylog-media-production --prefix myfile.jpg
aws s3api get-object --bucket veylog-media-production --key myfile.jpg --version-id VERSION_ID myfile.jpg
```

## Troubleshooting

### Common Issues

**1. Pipeline Fails - Permission Denied**
```bash
# Check IAM permissions for Bitbucket user
# Ensure SSH key is added to EC2 ~/.ssh/authorized_keys
```

**2. CloudFront Shows Old Content**
```bash
# Invalidate cache
aws cloudfront create-invalidation --distribution-id E2XXXXX --paths "/*"
```

**3. Database Connection Refused**
```bash
# Check security group allows backend SG on port 3306
# Verify DATABASE_URL is correct
# Check RDS is in available state
```

**4. 502 Bad Gateway**
```bash
# Check backend is running
pm2 status
pm2 logs veylog-backend-api

# Check Nginx config
sudo nginx -t
sudo systemctl status nginx
```

## Next Steps

1. **Setup monitoring dashboards** (CloudWatch/Grafana)
2. **Configure auto-scaling** based on metrics
3. **Implement blue-green deployments**
4. **Setup staging environment** (clone production)
5. **Add error tracking** (Sentry)
6. **Setup backup automation**
7. **Performance testing** (Load testing)
8. **Security audit** (AWS Inspector)

## Support Contacts

- AWS Support: https://console.aws.amazon.com/support/
- Bitbucket Support: https://support.atlassian.com/bitbucket-cloud/
- Internal DevOps: devops@veylog.com

## Additional Resources

- [Backend Deployment Details](veylog-backend/DEPLOYMENT.md)
- [Admin Frontend Details](veylog-fronend-admin/DEPLOYMENT.md)
- [Webapp Deployment Details](veylor_webapp/DEPLOYMENT.md)
- [AWS Well-Architected Framework](https://aws.amazon.com/architecture/well-architected/)
