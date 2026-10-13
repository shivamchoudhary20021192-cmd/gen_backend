#!/bin/bash

# Veylog Platform - AWS Deployment Setup Script
# This script helps set up the initial AWS infrastructure

set -e

echo "🚀 Veylog Platform - AWS Deployment Setup"
echo "=========================================="
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Check if AWS CLI is installed
if ! command -v aws &> /dev/null; then
    echo -e "${RED}❌ AWS CLI not found. Please install it first.${NC}"
    echo "Visit: https://aws.amazon.com/cli/"
    exit 1
fi

echo -e "${GREEN}✅ AWS CLI found${NC}"

# Check AWS credentials
if ! aws sts get-caller-identity &> /dev/null; then
    echo -e "${RED}❌ AWS credentials not configured${NC}"
    echo "Run: aws configure"
    exit 1
fi

echo -e "${GREEN}✅ AWS credentials configured${NC}"
echo ""

# Get account info
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
AWS_REGION=${AWS_REGION:-ap-south-1}

echo "📋 AWS Account: $ACCOUNT_ID"
echo "📍 Region: $AWS_REGION"
echo ""

# Prompt for project details
read -p "Enter domain name (e.g., veylog.com): " DOMAIN
read -p "Enter database password: " -s DB_PASSWORD
echo ""

PROJECT_NAME="veylog"

echo ""
echo "🏗️  Creating AWS Infrastructure..."
echo ""

# 1. Create S3 Buckets
echo "📦 Creating S3 buckets..."

aws s3 mb s3://${PROJECT_NAME}-admin-production --region $AWS_REGION 2>/dev/null || echo "Bucket already exists"
aws s3 mb s3://${PROJECT_NAME}-admin-staging --region $AWS_REGION 2>/dev/null || echo "Bucket already exists"
aws s3 mb s3://${PROJECT_NAME}-media-production --region $AWS_REGION 2>/dev/null || echo "Bucket already exists"
aws s3 mb s3://${PROJECT_NAME}-logs --region $AWS_REGION 2>/dev/null || echo "Bucket already exists"

echo -e "${GREEN}✅ S3 buckets created${NC}"

# 2. Create ECR Repositories
echo ""
echo "🐳 Creating ECR repositories..."

aws ecr create-repository --repository-name ${PROJECT_NAME}-backend --region $AWS_REGION 2>/dev/null || echo "Repository already exists"
aws ecr create-repository --repository-name veylor-webapp --region $AWS_REGION 2>/dev/null || echo "Repository already exists"

ECR_URL="${ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo -e "${GREEN}✅ ECR repositories created${NC}"
echo "   ECR URL: $ECR_URL"

# 3. Create VPC (optional - can use default)
echo ""
read -p "Create new VPC? (y/N): " CREATE_VPC

if [[ $CREATE_VPC =~ ^[Yy]$ ]]; then
    echo "🌐 Creating VPC..."
    
    VPC_ID=$(aws ec2 create-vpc --cidr-block 10.0.0.0/16 --region $AWS_REGION --query 'Vpc.VpcId' --output text)
    aws ec2 create-tags --resources $VPC_ID --tags Key=Name,Value=${PROJECT_NAME}-vpc --region $AWS_REGION
    
    # Create subnets
    SUBNET1=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.1.0/24 --availability-zone ${AWS_REGION}a --query 'Subnet.SubnetId' --output text)
    SUBNET2=$(aws ec2 create-subnet --vpc-id $VPC_ID --cidr-block 10.0.2.0/24 --availability-zone ${AWS_REGION}b --query 'Subnet.SubnetId' --output text)
    
    echo -e "${GREEN}✅ VPC created: $VPC_ID${NC}"
else
    VPC_ID=$(aws ec2 describe-vpcs --filters "Name=isDefault,Values=true" --query 'Vpcs[0].VpcId' --output text --region $AWS_REGION)
    echo "Using default VPC: $VPC_ID"
fi

# 4. Create Security Groups
echo ""
echo "🔒 Creating security groups..."

# Backend SG
BACKEND_SG=$(aws ec2 create-security-group \
    --group-name ${PROJECT_NAME}-backend-sg \
    --description "Security group for Veylog backend" \
    --vpc-id $VPC_ID \
    --region $AWS_REGION \
    --query 'GroupId' \
    --output text 2>/dev/null || aws ec2 describe-security-groups --filters "Name=group-name,Values=${PROJECT_NAME}-backend-sg" --query 'SecurityGroups[0].GroupId' --output text --region $AWS_REGION)

# Allow HTTPS
aws ec2 authorize-security-group-ingress --group-id $BACKEND_SG --protocol tcp --port 443 --cidr 0.0.0.0/0 --region $AWS_REGION 2>/dev/null || true
# Allow HTTP (for health checks)
aws ec2 authorize-security-group-ingress --group-id $BACKEND_SG --protocol tcp --port 80 --cidr 0.0.0.0/0 --region $AWS_REGION 2>/dev/null || true

# Database SG
DB_SG=$(aws ec2 create-security-group \
    --group-name ${PROJECT_NAME}-db-sg \
    --description "Security group for Veylog database" \
    --vpc-id $VPC_ID \
    --region $AWS_REGION \
    --query 'GroupId' \
    --output text 2>/dev/null || aws ec2 describe-security-groups --filters "Name=group-name,Values=${PROJECT_NAME}-db-sg" --query 'SecurityGroups[0].GroupId' --output text --region $AWS_REGION)

# Allow MySQL from backend SG
aws ec2 authorize-security-group-ingress --group-id $DB_SG --protocol tcp --port 3306 --source-group $BACKEND_SG --region $AWS_REGION 2>/dev/null || true

echo -e "${GREEN}✅ Security groups created${NC}"

# 5. Create RDS Instance
echo ""
read -p "Create RDS database? (y/N): " CREATE_RDS

if [[ $CREATE_RDS =~ ^[Yy]$ ]]; then
    echo "🗄️  Creating RDS instance (this takes 5-10 minutes)..."
    
    aws rds create-db-instance \
        --db-instance-identifier ${PROJECT_NAME}-db \
        --db-instance-class db.t3.medium \
        --engine mysql \
        --engine-version 8.0 \
        --master-username ${PROJECT_NAME}_admin \
        --master-user-password "$DB_PASSWORD" \
        --allocated-storage 50 \
        --vpc-security-group-ids $DB_SG \
        --backup-retention-period 7 \
        --preferred-backup-window "03:00-04:00" \
        --region $AWS_REGION \
        2>/dev/null || echo "RDS instance already exists"
    
    echo -e "${YELLOW}⏳ RDS instance is being created. This takes 5-10 minutes.${NC}"
    echo "   Check status: aws rds describe-db-instances --db-instance-identifier ${PROJECT_NAME}-db"
fi

# 6. Create CloudWatch Log Groups
echo ""
echo "📊 Creating CloudWatch log groups..."

aws logs create-log-group --log-group-name /veylog/backend --region $AWS_REGION 2>/dev/null || true
aws logs create-log-group --log-group-name /veylog/webapp --region $AWS_REGION 2>/dev/null || true
aws logs put-retention-policy --log-group-name /veylog/backend --retention-in-days 30 --region $AWS_REGION 2>/dev/null || true

echo -e "${GREEN}✅ CloudWatch log groups created${NC}"

# 7. Generate summary file
echo ""
echo "📝 Generating configuration summary..."

cat > aws-config-summary.txt <<EOF
Veylog Platform - AWS Configuration Summary
==========================================
Generated: $(date)

AWS Account ID: $ACCOUNT_ID
Region: $AWS_REGION
Domain: $DOMAIN

S3 Buckets:
-----------
Admin (Production): ${PROJECT_NAME}-admin-production
Admin (Staging): ${PROJECT_NAME}-admin-staging
Media: ${PROJECT_NAME}-media-production
Logs: ${PROJECT_NAME}-logs

ECR Repositories:
-----------------
Backend: ${ECR_URL}/${PROJECT_NAME}-backend
Webapp: ${ECR_URL}/veylor-webapp

VPC & Network:
--------------
VPC ID: $VPC_ID
Backend Security Group: $BACKEND_SG
Database Security Group: $DB_SG

RDS Database:
-------------
Instance ID: ${PROJECT_NAME}-db
Master Username: ${PROJECT_NAME}_admin
Endpoint: (will be available after creation)

Bitbucket Pipeline Variables to Add:
------------------------------------
AWS_ACCESS_KEY_ID=<your-access-key>
AWS_SECRET_ACCESS_KEY=<your-secret-key>
AWS_REGION=$AWS_REGION
AWS_ECR_URL=$ECR_URL

For Backend:
SSH_USER=ubuntu
STAGING_SERVER=staging-api.$DOMAIN
PRODUCTION_SERVER=api.$DOMAIN

For Admin Frontend:
STAGING_CF_DISTRIBUTION_ID=<to-be-created>
PRODUCTION_CF_DISTRIBUTION_ID=<to-be-created>

Next Steps:
-----------
1. Wait for RDS instance to be available
2. Get RDS endpoint: aws rds describe-db-instances --db-instance-identifier ${PROJECT_NAME}-db --query 'DBInstances[0].Endpoint.Address'
3. Run database migrations
4. Setup CloudFront distributions for admin frontend
5. Configure DNS in Route 53
6. Request SSL certificates from ACM
7. Add pipeline variables to Bitbucket repositories
8. Push code to trigger deployments

EOF

echo -e "${GREEN}✅ Configuration saved to aws-config-summary.txt${NC}"

echo ""
echo "=========================================="
echo -e "${GREEN}🎉 AWS Infrastructure Setup Complete!${NC}"
echo "=========================================="
echo ""
echo "📄 Review: aws-config-summary.txt"
echo ""
echo "Next steps:"
echo "1. Wait for RDS to be available (5-10 minutes)"
echo "2. Setup CloudFront distributions"
echo "3. Configure DNS and SSL"
echo "4. Add pipeline variables to Bitbucket"
echo "5. Deploy applications"
echo ""
echo "Full guide: AWS_DEPLOYMENT_MASTER_GUIDE.md"
