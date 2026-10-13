# EC2 Server - Initial Setup Guide

Complete guide to setup Ubuntu EC2 instance for hosting Veylog platform.

## Prerequisites

- AWS Account
- Domain name (e.g., veylog.com)
- SSH key pair for EC2 access

## Step 1: Launch EC2 Instance

### 1.1 Create EC2 Instance

**Go to AWS Console → EC2 → Launch Instance**

**Settings:**
- **Name:** veylog-production-server
- **AMI:** Ubuntu Server 22.04 LTS (64-bit x86)
- **Instance Type:** t3.medium (2 vCPU, 4GB RAM) - Minimum
  - For production: t3.large (2 vCPU, 8GB RAM) - Recommended
- **Key pair:** Create new or use existing
- **Network Settings:**
  - Create security group or use existing
  - Allow SSH (22) from your IP
  - Allow HTTP (80) from anywhere
  - Allow HTTPS (443) from anywhere
- **Storage:** 50 GB gp3 SSD

**Security Group Rules:**
```
Type            Protocol    Port    Source
SSH             TCP         22      Your-IP/32
HTTP            TCP         80      0.0.0.0/0
HTTPS           TCP         443     0.0.0.0/0
```

Click **Launch Instance**

### 1.2 Connect to EC2

```bash
# Download your key pair (.pem file)
# Change permissions
chmod 400 veylog-key.pem

# Connect
ssh -i veylog-key.pem ubuntu@<EC2-PUBLIC-IP>
```

**Note:** Replace `<EC2-PUBLIC-IP>` with your EC2 instance's public IP from AWS Console.

## Step 2: Update System

```bash
# Update package lists
sudo apt update

# Upgrade all packages
sudo apt upgrade -y

# Install basic utilities
sudo apt install -y curl wget git unzip vim htop
```

## Step 3: Install Node.js 20

```bash
# Install Node.js 20 using NodeSource repository
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Verify installation
node --version
# Should show: v20.x.x

npm --version
# Should show: 10.x.x
```

## Step 4: Install PM2 Process Manager

```bash
# Install PM2 globally
sudo npm install -g pm2

# Verify installation
pm2 --version

# Setup PM2 to start on boot
pm2 startup systemd
# Run the command that PM2 outputs (it starts with 'sudo env...')

# Example output:
# sudo env PATH=$PATH:/usr/bin /usr/local/lib/node_modules/pm2/bin/pm2 startup systemd -u ubuntu --hp /home/ubuntu
```

## Step 5: Setup Firewall (UFW)

```bash
# Check UFW status
sudo ufw status

# Configure default rules
sudo ufw default deny incoming
sudo ufw default allow outgoing

# Allow SSH (IMPORTANT: Do this first!)
sudo ufw allow 22/tcp

# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp

# Enable firewall
sudo ufw enable

# Verify rules
sudo ufw status verbose
```

**Output should show:**
```
Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80/tcp                     ALLOW       Anywhere
443/tcp                    ALLOW       Anywhere
```

## Step 6: Create Application Directories

```bash
# Create web root directories
sudo mkdir -p /var/www/{veylog-backend,veylor-webapp,admin}

# Change ownership to ubuntu user
sudo chown -R ubuntu:ubuntu /var/www

# Verify
ls -la /var/www/
```

**Expected output:**
```
drwxr-xr-x  5 ubuntu ubuntu 4096 Jan 10 10:00 .
drwxr-xr-x 14 root   root   4096 Jan 10 09:55 ..
drwxr-xr-x  2 ubuntu ubuntu 4096 Jan 10 10:00 admin
drwxr-xr-x  2 ubuntu ubuntu 4096 Jan 10 10:00 veylog-backend
drwxr-xr-x  2 ubuntu ubuntu 4096 Jan 10 10:00 veylor-webapp
```

## Step 7: Configure Git

```bash
# Set git user (optional but recommended)
git config --global user.name "Your Name"
git config --global user.email "your.email@example.com"

# Generate SSH key for Git access (if using SSH)
ssh-keygen -t rsa -b 4096 -C "server@veylog.com"
# Press Enter for all prompts (use default location)

# Display public key
cat ~/.ssh/id_rsa.pub
# Copy this key and add to Bitbucket/GitHub SSH keys
```

## Step 8: Setup Swap File (Optional but Recommended)

Helps prevent out-of-memory issues during builds.

```bash
# Create 2GB swap file
sudo fallocate -l 2G /swapfile

# Set permissions
sudo chmod 600 /swapfile

# Setup swap
sudo mkswap /swapfile

# Enable swap
sudo swapon /swapfile

# Make permanent
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab

# Verify
sudo swapon --show
free -h
```

## Step 9: Increase File Limits (Optional)

For high-traffic applications:

```bash
# Edit limits.conf
sudo nano /etc/security/limits.conf

# Add these lines at the end:
* soft nofile 65536
* hard nofile 65536
ubuntu soft nofile 65536
ubuntu hard nofile 65536
```

Save and exit (Ctrl+X, Y, Enter)

```bash
# Edit sysctl.conf
sudo nano /etc/sysctl.conf

# Add at the end:
fs.file-max = 2097152
net.core.somaxconn = 65535
```

Apply changes:
```bash
sudo sysctl -p
```

## Step 10: Setup Timezone

```bash
# Set timezone to India
sudo timedatectl set-timezone Asia/Kolkata

# Verify
timedatectl
```

## Step 11: Enable Automatic Security Updates

```bash
# Install unattended-upgrades
sudo apt install -y unattended-upgrades

# Enable it
sudo dpkg-reconfigure -plow unattended-upgrades
# Select "Yes"
```

## Verification Checklist

Run these commands to verify everything is installed:

```bash
# Check Node.js
node --version      # Should show v20.x.x

# Check npm
npm --version       # Should show 10.x.x

# Check PM2
pm2 --version       # Should show version number

# Check directories
ls -la /var/www/    # Should show 3 directories

# Check firewall
sudo ufw status     # Should show active with ports 22, 80, 443

# Check swap
free -h             # Should show swap space

# Check disk space
df -h               # Should show available space
```

## System Information

Check your system specs:

```bash
# CPU info
lscpu

# Memory info
free -h

# Disk info
df -h

# System info
uname -a
```

## Security Recommendations

### Disable Root Login

```bash
# Edit SSH config
sudo nano /etc/ssh/sshd_config

# Find and set:
PermitRootLogin no
PasswordAuthentication no

# Restart SSH
sudo systemctl restart ssh
```

### Install Fail2Ban (Optional)

Protects against brute-force attacks:

```bash
sudo apt install -y fail2ban

# Start and enable
sudo systemctl start fail2ban
sudo systemctl enable fail2ban

# Check status
sudo fail2ban-client status
```

## Next Steps

Your EC2 instance is now ready! Proceed to:

1. **MySQL Installation** → `02-MYSQL-INSTALLATION.md`
2. **Nginx Installation** → `03-NGINX-INSTALLATION.md`
3. **Backend Deployment** → `04-BACKEND-DEPLOYMENT.md`
4. **Webapp Deployment** → `05-WEBAPP-DEPLOYMENT.md`
5. **Admin Deployment** → `06-ADMIN-DEPLOYMENT.md`

## Troubleshooting

### Cannot connect via SSH
- Check security group allows port 22 from your IP
- Verify key file permissions: `chmod 400 veylog-key.pem`
- Check EC2 instance is running in AWS Console

### Out of disk space
```bash
# Check space
df -h

# Clean package cache
sudo apt clean
sudo apt autoremove

# Check large files
du -sh /var/* | sort -rh | head -10
```

### System running slow
```bash
# Check memory
free -h

# Check CPU
htop

# Check running processes
ps aux --sort=-%mem | head -10
```

## Useful Commands

```bash
# Check system load
uptime

# Check memory usage
free -m

# Check disk usage
df -h

# Check who's logged in
who

# View system logs
sudo journalctl -xe

# Reboot server
sudo reboot
```

---

**Setup Time:** 30-45 minutes  
**Next:** MySQL Installation
