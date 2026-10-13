# MySQL 8.0 Installation and Configuration

Complete guide to install and configure MySQL 8.0 on Ubuntu 22.04.

## Option A: Local MySQL Installation (Development/Testing)

Use this if you want MySQL on the same EC2 instance.

### Step 1: Install MySQL Server

```bash
# Update package list
sudo apt update

# Install MySQL Server 8.0
sudo apt install -y mysql-server

# Verify installation
mysql --version
# Should show: mysql Ver 8.0.x
```

### Step 2: Secure MySQL Installation

```bash
# Run security script
sudo mysql_secure_installation
```

**Answer the prompts:**

1. **Enter password for user root:** Press Enter (no password yet)
2. **Switch to unix_socket authentication:** No
3. **Change the root password:** Yes
   - Enter new password: `<YourStrongPassword>`
   - Re-enter password: `<YourStrongPassword>`
4. **Remove anonymous users:** Yes
5. **Disallow root login remotely:** Yes
6. **Remove test database:** Yes
7. **Reload privilege tables:** Yes

### Step 3: Login to MySQL

```bash
# Login as root
sudo mysql -u root -p
# Enter the password you just set
```

You should see:
```
Welcome to the MySQL monitor.
mysql>
```

### Step 4: Create Database and User

```sql
-- Create database
CREATE DATABASE veylog_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Create user with password
CREATE USER 'veylog_admin'@'localhost' IDENTIFIED BY 'VeylogSecure123!';

-- Grant all privileges on veylog_db
GRANT ALL PRIVILEGES ON veylog_db.* TO 'veylog_admin'@'localhost';

-- Flush privileges
FLUSH PRIVILEGES;

-- Verify
SHOW DATABASES;
SELECT user, host FROM mysql.user WHERE user = 'veylog_admin';

-- Exit
EXIT;
```

### Step 5: Test Connection

```bash
# Test login with new user
mysql -u veylog_admin -p veylog_db
# Enter password: VeylogSecure123!
```

If successful, you're in!

```sql
-- Check current database
SELECT DATABASE();

-- Exit
EXIT;
```

### Step 6: Configure MySQL Settings

Edit MySQL configuration:

```bash
sudo nano /etc/mysql/mysql.conf.d/mysqld.cnf
```

**Add/Modify these settings:**

```ini
[mysqld]
# Basic Settings
max_connections = 200
max_allowed_packet = 64M
wait_timeout = 600

# InnoDB Settings (for better performance)
innodb_buffer_pool_size = 1G
innodb_log_file_size = 256M
innodb_flush_log_at_trx_commit = 2
innodb_flush_method = O_DIRECT

# Query Cache (disabled in MySQL 8.0)
# Performance Schema
performance_schema = ON

# Logging
log_error = /var/log/mysql/error.log
slow_query_log = 1
slow_query_log_file = /var/log/mysql/slow-query.log
long_query_time = 2

# Character Set
character-set-server = utf8mb4
collation-server = utf8mb4_unicode_ci
```

Save and exit (Ctrl+X, Y, Enter)

**Restart MySQL:**
```bash
sudo systemctl restart mysql
sudo systemctl status mysql
```

### Step 7: Import Database Schema

```bash
# Navigate to backend directory (after cloning)
cd /var/www/veylog-backend

# Import main schema
mysql -u veylog_admin -p veylog_db < database/schema_all.sql

# Import menu fixes
mysql -u veylog_admin -p veylog_db < database/30_fix_menu_active_match.sql

# Verify tables
mysql -u veylog_admin -p veylog_db -e "SHOW TABLES;"
```

**Expected output:**
```
+---------------------------+
| Tables_in_veylog_db       |
+---------------------------+
| admin_menu_items          |
| admin_users               |
| categories                |
| customer_segments         |
| customers                 |
| orders                    |
| products                  |
| ... (many more tables)    |
+---------------------------+
```

---

## Option B: AWS RDS MySQL (Production Recommended)

Use managed MySQL service for better reliability, backups, and scaling.

### Step 1: Create RDS MySQL Instance

**Via AWS Console:**

1. Go to **AWS Console → RDS → Create database**
2. **Engine options:**
   - Engine type: MySQL
   - Version: MySQL 8.0.35
3. **Templates:** Production (or Dev/Test for testing)
4. **Settings:**
   - DB instance identifier: `veylog-db`
   - Master username: `veylog_admin`
   - Master password: `<YourSecurePassword>`
5. **DB instance class:**
   - Burstable: db.t3.medium (2 vCPU, 4GB RAM)
   - Or Standard: db.m5.large for production
6. **Storage:**
   - Allocated storage: 50 GB
   - Storage type: General Purpose SSD (gp3)
   - Enable storage autoscaling: Yes, up to 100GB
7. **Connectivity:**
   - VPC: Use same VPC as EC2
   - Public access: No
   - VPC security group: Create new
   - Availability Zone: Same as EC2 (optional)
8. **Additional configuration:**
   - Initial database name: `veylog_db`
   - Backup retention: 7 days
   - Enable automatic backups: Yes
   - Backup window: 03:00-04:00 UTC
   - Monitoring: Enable Enhanced Monitoring
9. Click **Create database**

**Wait 5-10 minutes for creation...**

### Step 2: Configure Security Group

1. Go to **RDS → veylog-db → Connectivity & Security**
2. Click on the **VPC security group**
3. Edit **Inbound rules**
4. Add rule:
   - **Type:** MySQL/Aurora
   - **Protocol:** TCP
   - **Port:** 3306
   - **Source:** EC2 security group (or EC2 private IP)
   - **Description:** Allow from EC2
5. Save rules

### Step 3: Get RDS Endpoint

```bash
# Via AWS CLI
aws rds describe-db-instances \
  --db-instance-identifier veylog-db \
  --query 'DBInstances[0].Endpoint.Address' \
  --output text
```

Or find in **AWS Console → RDS → veylog-db → Connectivity & Security → Endpoint**

Example: `veylog-db.c9akciq32.ap-south-1.rds.amazonaws.com`

### Step 4: Test Connection from EC2

```bash
# Install MySQL client
sudo apt install -y mysql-client

# Test connection
mysql -h veylog-db.c9akciq32.ap-south-1.rds.amazonaws.com \
      -u veylog_admin \
      -p \
      veylog_db

# Enter password when prompted
```

If connected successfully:
```
Welcome to the MySQL monitor.
mysql>
```

### Step 5: Import Database Schema

```bash
# From your backend directory
cd /var/www/veylog-backend

# Set RDS endpoint as variable
export RDS_ENDPOINT="veylog-db.c9akciq32.ap-south-1.rds.amazonaws.com"

# Import schema
mysql -h $RDS_ENDPOINT -u veylog_admin -p veylog_db < database/schema_all.sql

# Import menu fixes
mysql -h $RDS_ENDPOINT -u veylog_admin -p veylog_db < database/30_fix_menu_active_match.sql

# Verify
mysql -h $RDS_ENDPOINT -u veylog_admin -p veylog_db -e "SHOW TABLES;"
```

### Step 6: Create Read-Only User (Optional)

For monitoring/reporting without write access:

```bash
mysql -h $RDS_ENDPOINT -u veylog_admin -p veylog_db
```

```sql
CREATE USER 'veylog_readonly'@'%' IDENTIFIED BY 'ReadOnlyPass123!';
GRANT SELECT ON veylog_db.* TO 'veylog_readonly'@'%';
FLUSH PRIVILEGES;
EXIT;
```

---

## Database Configuration Reference

### Connection Details for Application

**Local MySQL:**
```
DB_HOST=localhost
DB_PORT=3306
DB_USER=veylog_admin
DB_PASSWORD=VeylogSecure123!
DB_NAME=veylog_db
```

**RDS MySQL:**
```
DB_HOST=veylog-db.c9akciq32.ap-south-1.rds.amazonaws.com
DB_PORT=3306
DB_USER=veylog_admin
DB_PASSWORD=<YourPassword>
DB_NAME=veylog_db
```

### Connection String Format

```
mysql://veylog_admin:PASSWORD@HOST:3306/veylog_db
```

---

## Common MySQL Commands

### Database Operations

```sql
-- Show all databases
SHOW DATABASES;

-- Use database
USE veylog_db;

-- Show all tables
SHOW TABLES;

-- Describe table structure
DESCRIBE products;

-- Show table indexes
SHOW INDEX FROM products;

-- Check table size
SELECT 
    table_name AS 'Table',
    ROUND(((data_length + index_length) / 1024 / 1024), 2) AS 'Size (MB)'
FROM information_schema.TABLES
WHERE table_schema = 'veylog_db'
ORDER BY (data_length + index_length) DESC;
```

### User Management

```sql
-- Show all users
SELECT user, host FROM mysql.user;

-- Show user privileges
SHOW GRANTS FOR 'veylog_admin'@'localhost';

-- Change password
ALTER USER 'veylog_admin'@'localhost' IDENTIFIED BY 'NewPassword123!';
FLUSH PRIVILEGES;
```

### Performance Monitoring

```sql
-- Show running queries
SHOW PROCESSLIST;

-- Show slow queries
SELECT * FROM mysql.slow_log ORDER BY query_time DESC LIMIT 10;

-- Show table status
SHOW TABLE STATUS FROM veylog_db;

-- Show server status
SHOW STATUS LIKE '%connection%';
SHOW STATUS LIKE '%thread%';
```

### Backup and Restore

```bash
# Backup single database
mysqldump -u veylog_admin -p veylog_db > backup_$(date +%Y%m%d).sql

# Backup with RDS
mysqldump -h $RDS_ENDPOINT -u veylog_admin -p veylog_db > backup_$(date +%Y%m%d).sql

# Compress backup
mysqldump -u veylog_admin -p veylog_db | gzip > backup_$(date +%Y%m%d).sql.gz

# Restore from backup
mysql -u veylog_admin -p veylog_db < backup_20240110.sql

# Restore compressed backup
gunzip < backup_20240110.sql.gz | mysql -u veylog_admin -p veylog_db
```

---

## Troubleshooting

### Cannot connect to MySQL

**Check if MySQL is running:**
```bash
sudo systemctl status mysql
sudo systemctl start mysql
```

**Check if port 3306 is listening:**
```bash
sudo netstat -tulpn | grep 3306
```

**Check error logs:**
```bash
sudo tail -f /var/log/mysql/error.log
```

### Access denied for user

```bash
# Reset password
sudo mysql
```

```sql
ALTER USER 'veylog_admin'@'localhost' IDENTIFIED BY 'NewPassword123!';
FLUSH PRIVILEGES;
EXIT;
```

### RDS connection timeout

- Check EC2 security group allows outbound on port 3306
- Check RDS security group allows inbound from EC2
- Verify RDS endpoint is correct
- Check VPC and subnet configuration

### Too many connections

```sql
-- Check max connections
SHOW VARIABLES LIKE 'max_connections';

-- Increase limit
SET GLOBAL max_connections = 500;

-- Kill stuck connections
SHOW PROCESSLIST;
KILL <process_id>;
```

### Slow queries

```sql
-- Enable slow query log
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 2;

-- Check slow queries
SELECT * FROM mysql.slow_log ORDER BY query_time DESC LIMIT 10;
```

---

## Performance Tuning Tips

### For t3.medium (4GB RAM)

```bash
sudo nano /etc/mysql/mysql.conf.d/mysqld.cnf
```

```ini
innodb_buffer_pool_size = 2G
innodb_log_file_size = 256M
max_connections = 150
```

### For t3.large (8GB RAM)

```ini
innodb_buffer_pool_size = 4G
innodb_log_file_size = 512M
max_connections = 300
```

### For RDS

Adjust parameter group:
- `innodb_buffer_pool_size`: 75% of RAM
- `max_connections`: Based on expected load
- Enable Performance Insights

---

## Maintenance Tasks

### Weekly

```bash
# Check disk usage
df -h

# Check slow queries
mysql -u veylog_admin -p -e "SELECT * FROM mysql.slow_log ORDER BY query_time DESC LIMIT 10;"

# Optimize tables
mysqlcheck -u veylog_admin -p --optimize --all-databases
```

### Monthly

```bash
# Full backup
mysqldump -u veylog_admin -p --all-databases > full_backup_$(date +%Y%m%d).sql

# Analyze tables
mysqlcheck -u veylog_admin -p --analyze --all-databases
```

---

## Next Steps

MySQL is now ready! Proceed to:

**Next:** Nginx Installation → `03-NGINX-INSTALLATION.md`

---

**Setup Time:** 20-30 minutes (Local) or 15-20 minutes (RDS)  
**RDS Creation Time:** 5-10 minutes additional
