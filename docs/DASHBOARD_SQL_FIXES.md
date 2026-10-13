# Dashboard SQL Query Fixes

## Issue Summary
All 6 dashboard API endpoints were returning 500 errors due to incorrect column names in SQL queries that didn't match the actual database schema.

## Root Cause
The initial implementation assumed certain columns existed in the database that were not actually present:
- `orders.deleted_at` - **DOES NOT EXIST**
- `media.url` - **DOES NOT EXIST** (uses `storage_key` instead)
- `product_variants.inventory_quantity` - **DOES NOT EXIST** (inventory is in `inventory_items` table)
- Table name `returns` - Actually named `return_requests`

## Fixed Queries

### 1. Revenue Query (getOverview)
**Problem:** `WHERE deleted_at IS NULL` on orders table
**Fix:** Removed `deleted_at IS NULL` condition
```sql
-- BEFORE
WHERE payment_status IN ('paid', 'cod_collected', 'authorized')
  AND deleted_at IS NULL

-- AFTER
WHERE payment_status IN ('paid', 'cod_collected', 'authorized')
```

### 2. Orders Query (getOverview)
**Problem:** `WHERE deleted_at IS NULL` on orders table
**Fix:** Removed `deleted_at IS NULL` condition
```sql
-- BEFORE
FROM orders
WHERE deleted_at IS NULL

-- AFTER
FROM orders
```

### 3. Products Query (getOverview)
**Problem:** Referenced non-existent `product_variants.inventory_quantity` and `low_stock_threshold`
**Fix:** Query `inventory_items` table with correct columns
```sql
-- BEFORE
COUNT(CASE WHEN v.inventory_quantity > 0 
  AND v.inventory_quantity <= v.low_stock_threshold THEN 1 END) AS lowStock,
COUNT(CASE WHEN v.inventory_quantity = 0 THEN 1 END) AS outOfStock
FROM products p
LEFT JOIN product_variants v ON v.product_id = p.id

-- AFTER
COUNT(CASE WHEN ii.quantity_available > 0 
  AND ii.quantity_available <= ii.safety_stock THEN 1 END) AS lowStock,
COUNT(CASE WHEN ii.quantity_available <= 0 THEN 1 END) AS outOfStock
FROM products p
LEFT JOIN product_variants v ON v.product_id = p.id
LEFT JOIN inventory_items ii ON ii.variant_id = v.id
```

### 4. Revenue Chart Query (getRevenueChart)
**Problem:** `WHERE deleted_at IS NULL` on orders table (appears twice)
**Fix:** Removed both `deleted_at IS NULL` conditions

### 5. Orders Chart Query (getOrdersChart)
**Problem:** `WHERE deleted_at IS NULL` on orders table
**Fix:** Removed `deleted_at IS NULL` condition

### 6. Top Products Query (getTopProducts)
**Problem:** 
- Referenced `m.url` which doesn't exist
- Checked `o.deleted_at IS NULL` which doesn't exist
- Used wrong column names: `entity_type`, `entity_id`, `position` don't exist

**Fix:** 
- Changed `m.url` to `m.storage_key`
- Removed `o.deleted_at IS NULL` condition
- Kept `p.deleted_at IS NULL` (products table HAS this column)
- Fixed media_attachments JOIN: `entity_type` → `attachable_type`, `entity_id` → `attachable_id`, `position = 0` → `collection = 'gallery' AND is_primary = 1`

```sql
-- BEFORE
m.url AS thumbnail
...
LEFT JOIN media_attachments ma ON ma.entity_type = 'product' 
  AND ma.entity_id = p.id 
  AND ma.position = 0
LEFT JOIN media m ON m.id = ma.media_id
WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
  AND o.payment_status IN ('paid', 'cod_collected', 'authorized')
  AND o.deleted_at IS NULL
  AND p.deleted_at IS NULL

-- AFTER
m.storage_key AS thumbnail
...
LEFT JOIN media_attachments ma ON ma.attachable_type = 'product' 
  AND ma.attachable_id = p.id 
  AND ma.collection = 'gallery' 
  AND ma.is_primary = 1
LEFT JOIN media m ON m.id = ma.media_id
WHERE o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
  AND o.payment_status IN ('paid', 'cod_collected', 'authorized')
  AND p.deleted_at IS NULL
```

### 7. Recent Orders Query (getRecentOrders)
**Problem:** `WHERE o.deleted_at IS NULL`
**Fix:** Removed the WHERE clause entirely

### 8. Low Stock Alerts (getAlerts)
**Problem:** Queried `product_variants.inventory_quantity` which doesn't exist
**Fix:** Query `inventory_items` table instead
```sql
-- BEFORE
SELECT COUNT(*) AS count
FROM product_variants
WHERE inventory_quantity > 0 
  AND inventory_quantity <= low_stock_threshold

-- AFTER
SELECT COUNT(*) AS count
FROM inventory_items
WHERE quantity_available > 0 
  AND quantity_available <= safety_stock
```

### 9. Out of Stock Alerts (getAlerts)
**Problem:** Queried `product_variants.inventory_quantity`
**Fix:** Query `inventory_items.quantity_available`
```sql
-- BEFORE
SELECT COUNT(*) AS count
FROM product_variants
WHERE inventory_quantity = 0

-- AFTER
SELECT COUNT(*) AS count
FROM inventory_items
WHERE quantity_available <= 0
```

### 10. Pending Returns Alerts (getAlerts)
**Problem:** Table name was `returns`
**Fix:** Changed to `return_requests`
```sql
-- BEFORE
FROM returns
WHERE status = 'pending'

-- AFTER
FROM return_requests
WHERE status = 'pending'
```

## Schema Reference

### Tables WITH `deleted_at` column:
- ✅ `products` (line 109 in 04_catalog.sql)
- ✅ `customers` (line 71 in 07_customers.sql)
- ✅ `product_variants` (confirmed in schema)

### Tables WITHOUT `deleted_at` column:
- ❌ `orders` - Uses status enums instead
- ❌ `order_items` - Cascade deletes with orders

### Media Table Structure:
```sql
CREATE TABLE `media` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `disk` ENUM('local','s3','r2','gcs',...) NOT NULL DEFAULT 'local',
  `storage_key` VARCHAR(500) NOT NULL,  -- This is the path
  `absolute_url` VARCHAR(1000) NULL,    -- Only for external CDN
  -- NO `url` column exists
)
```

### Media Attachments Table Structure:
```sql
CREATE TABLE `media_attachments` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `media_id` BIGINT UNSIGNED NOT NULL,
  `attachable_type` VARCHAR(60) NOT NULL,  -- NOT entity_type!
  `attachable_id` BIGINT UNSIGNED NOT NULL, -- NOT entity_id!
  `collection` VARCHAR(50) NOT NULL DEFAULT 'gallery', -- NOT position!
  `sort_order` SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `is_primary` TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- Polymorphic: attachable_type values: 'product', 'category', 'collection', etc.
  -- Collections: 'gallery', 'thumbnail', 'hero_desktop', 'og', etc.
)
```

### Inventory Structure:
```sql
CREATE TABLE `inventory_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `variant_id` BIGINT UNSIGNED NOT NULL,
  `location_id` BIGINT UNSIGNED NOT NULL,
  `quantity_on_hand` INT NOT NULL DEFAULT 0,
  `quantity_reserved` INT NOT NULL DEFAULT 0,
  `quantity_available` INT AS (`quantity_on_hand` - `quantity_reserved`) STORED,
  `safety_stock` INT NOT NULL DEFAULT 0,
  -- Stored as computed column
)
```

## Files Modified
- `d:\veylog-backend\src\modules\dashboard\dashboard.repository.ts` - All SQL queries fixed

## Testing Instructions
1. Restart the backend server
2. Login to admin panel at http://localhost:5173
3. Navigate to Dashboard
4. All 6 endpoints should now return 200:
   - `/admin/api/v1/dashboard/overview`
   - `/admin/api/v1/dashboard/revenue-chart?period=30d`
   - `/admin/api/v1/dashboard/orders-chart?period=30d`
   - `/admin/api/v1/dashboard/top-products?limit=5&period=30d`
   - `/admin/api/v1/dashboard/recent-orders?limit=10`
   - `/admin/api/v1/dashboard/alerts`

## Status
✅ All SQL queries corrected to match actual database schema
✅ Zero breaking changes to existing code
✅ Ready for testing
