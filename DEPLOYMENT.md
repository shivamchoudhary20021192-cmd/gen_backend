# Veylog Backend - AWS Deployment Guide

## Overview
This guide covers deploying the Veylog Backend API to AWS using multiple methods:
- EC2 (Direct deployment)
- ECS/Fargate (Docker containers)
- Elastic Beanstalk (Alternative)

## Prerequisites

### 1. AWS Account Setup
- AWS Account with appropriate permissions
- AWS CLI installed and configured
- IAM user with programmatic access

### 2. Required AWS Services
- **EC2** or **ECS/Fargate** for compute
- **RDS MySQL** for database
- **S3** for file storage (media uploads)
- **CloudWatch** for logging
- **ALB** (Application Load Balancer) for HTTPS
- **Route 53** for DNS (optional)
- **ACM** for SSL certificates

### 3. Bitbucket Repository Variables
Go to **Repository Settings → Pipelines → Repository variables** and add:

```
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
AWS_REGION=ap-south-1
AWS_ECR_URL=<account-id>.dkr.ecr.ap-south-1.amazonaws.com

# EC2 Deployment
SSH_USER=ubuntu
STAGING_SERVER=staging-api.veylog.com
PRODUCTION_SERVER=api.veylog.com

# Database
DB_HOST=<rds-endpoint>
DB_USER=veylog_admin
DB_PASSWORD=<secure-password>
DB_NAME=veylog_db

# Storage
STORAGE_DRIVER=s3
S3_BUCKET=veylog-media-production
S3_REGION=ap-south-1
```

## Deployment Method 1: EC2 (Direct)

### Setup EC2 Instance

1. **Launch EC2 Instance**
   - AMI: Ubuntu 22.04 LTS
   - Type: t3.medium (minimum)
   - Storage: 30GB SSD
   - Security Group: Allow 22, 80, 443, 3000

2. **Install Dependencies**
```bash
# SSH into EC2
ssh -i your-key.pem ubuntu@<instance-ip>

# Update system
sudo apt update && sudo apt upgrade -y

# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Install PM2
sudo npm install -g pm2

# Install Git
sudo apt install -y git

# Install Nginx
sudo apt install -y nginx
```

3. **Clone Repository**
```bash
cd /var/www
sudo git clone https://bitbucket.org/your-org/veylog-backend.git
sudo chown -R ubuntu:ubuntu veylog-backend
cd veylog-backend
```

4. **Configure Environment**
```bash
cp .env.example .env
nano .env
```

Update with production values:
```env
NODE_ENV=production
PORT=3000
DATABASE_URL=mysql://user:pass@rds-endpoint:3306/veylog_db
STORAGE_DRIVER=s3
AWS_S3_BUCKET=veylog-media-production
JWT_SECRET=<generate-secure-secret>
```

5. **Build and Start**
```bash
npm ci --production
npm run build
pm2 start dist/index.js --name veylog-backend-api
pm2 startup systemd
pm2 save
```

6. **Configure Nginx**
```bash
sudo nano /etc/nginx/sites-available/veylog-backend
```

```nginx
server {
    listen 80;
    server_name api.veylog.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/veylog-backend /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

7. **Setup SSL with Certbot**
```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d api.veylog.com
```

### CI/CD with Bitbucket Pipelines

The pipeline automatically:
- Runs on push to `develop` → deploys to staging
- Runs on push to `main` → deploys to production (manual trigger)

SSH keys setup:
```bash
# On your local machine, generate deployment key
ssh-keygen -t rsa -b 4096 -C "bitbucket-deploy"

# Add public key to EC2
ssh ubuntu@<instance-ip>
nano ~/.ssh/authorized_keys
# Paste public key

# Add private key to Bitbucket
# Repository Settings → Pipelines → SSH keys
```

## Deployment Method 2: ECS/Fargate (Docker)

### Setup ECR Repository

```bash
# Create ECR repository
aws ecr create-repository --repository-name veylog-backend --region ap-south-1

# Note the repository URI
<account-id>.dkr.ecr.ap-south-1.amazonaws.com/veylog-backend
```

### Create ECS Cluster

1. **Via AWS Console**
   - Go to ECS → Clusters → Create Cluster
   - Name: `veylog-cluster`
   - Infrastructure: AWS Fargate

2. **Create Task Definition**
```json
{
  "family": "veylog-backend",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "512",
  "memory": "1024",
  "containerDefinitions": [
    {
      "name": "veylog-backend",
      "image": "<account-id>.dkr.ecr.ap-south-1.amazonaws.com/veylog-backend:latest",
      "portMappings": [
        {
          "containerPort": 3000,
          "protocol": "tcp"
        }
      ],
      "environment": [
        {"name": "NODE_ENV", "value": "production"},
        {"name": "PORT", "value": "3000"}
      ],
      "secrets": [
        {
          "name": "DATABASE_URL",
          "valueFrom": "arn:aws:secretsmanager:ap-south-1:account:secret:veylog/database-url"
        }
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "/ecs/veylog-backend",
          "awslogs-region": "ap-south-1",
          "awslogs-stream-prefix": "ecs"
        }
      }
    }
  ]
}
```

3. **Create Service**
   - Cluster: veylog-cluster
   - Task Definition: veylog-backend
   - Desired tasks: 2
   - Load Balancer: Application Load Balancer
   - Target Group: veylog-backend-tg

### Deploy Using Pipeline

Run custom pipeline:
```bash
# In Bitbucket → Pipelines → Run Pipeline
# Select: deploy-to-ecs-production
```

## Database Migration

### RDS MySQL Setup

1. **Create RDS Instance**
   - Engine: MySQL 8.0
   - Instance: db.t3.medium
   - Storage: 50GB SSD
   - Multi-AZ: Yes (production)

2. **Run Migrations**
```bash
# SSH into EC2 or run locally
mysql -h <rds-endpoint> -u veylog_admin -p veylog_db < database/schema_all.sql

# Run individual migrations
for file in database/*.sql; do
  echo "Running $file..."
  mysql -h <rds-endpoint> -u veylog_admin -p veylog_db < "$file"
done
```

## Monitoring and Logs

### CloudWatch Logs

```bash
# View logs
aws logs tail /ecs/veylog-backend --follow
```

### PM2 Monitoring (EC2)

```bash
pm2 monit
pm2 logs veylog-backend-api
pm2 restart veylog-backend-api
```

### Health Check

```bash
curl https://api.veylog.com/health
```

## Rollback

### EC2 Rollback
```bash
cd /var/www/veylog-backend
git log --oneline -n 5
git checkout <previous-commit-hash>
npm ci --production
npm run build
pm2 restart veylog-backend-api
```

### ECS Rollback
```bash
# Update service to previous task definition revision
aws ecs update-service \
  --cluster veylog-cluster \
  --service veylog-backend-service \
  --task-definition veylog-backend:5
```

## Performance Optimization

1. **Enable Node.js clustering** (PM2 does this automatically)
2. **Setup Redis for caching**
3. **Configure CloudFront for static assets**
4. **Enable RDS read replicas**

## Security Checklist

- [ ] Environment variables stored in AWS Secrets Manager
- [ ] Security groups properly configured
- [ ] SSL/TLS enabled via ALB
- [ ] Database not publicly accessible
- [ ] IAM roles with least privilege
- [ ] CloudWatch alarms configured
- [ ] Backup strategy in place
- [ ] WAF rules configured (optional)

## Cost Estimation (Monthly - India Region)

### EC2 Deployment
- EC2 t3.medium: ₹2,500
- RDS db.t3.medium: ₹4,000
- S3 (100GB): ₹200
- Data Transfer: ₹500
- **Total: ~₹7,200/month**

### ECS/Fargate Deployment
- Fargate (2 tasks): ₹5,000
- RDS db.t3.medium: ₹4,000
- ALB: ₹1,500
- S3 (100GB): ₹200
- **Total: ~₹10,700/month**

## Support

For deployment issues:
- Check CloudWatch Logs
- Review PM2 logs: `pm2 logs`
- Check Nginx error logs: `sudo tail -f /var/log/nginx/error.log`
