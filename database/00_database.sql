-- =============================================================================
-- VEYLOG / VEYLOR  —  D2C SKINCARE COMMERCE  —  MySQL 8.0 SCHEMA
-- File 00 : Database creation and global conventions
-- =============================================================================
--
-- Run order:
--   00_database.sql
--   01_admin_rbac.sql
--   02_media.sql
--   03_taxonomy.sql
--   04_catalog.sql
--   05_inventory.sql
--   06_cms.sql
--   07_customers.sql
--   08_cart_orders.sql
--   09_payments_shipping.sql
--   10_marketing.sql
--   11_reviews.sql
--   12_support_ops.sql
--   13_system.sql
--   99_seed_reference.sql
--
-- CONVENTIONS
-- -----------------------------------------------------------------------------
-- Engine        InnoDB, utf8mb4 / utf8mb4_0900_ai_ci (full emoji + Indic support)
-- Primary key   BIGINT UNSIGNED AUTO_INCREMENT named `id`
-- Public id     `public_id CHAR(36)` (UUID) on anything exposed in a URL or API
--               response, so internal sequential ids are never leaked.
-- Money         DECIMAL(10,2) for unit prices, DECIMAL(12,2) for totals. Never
--               FLOAT. Razorpay works in paise: multiply by 100 at the API
--               boundary only, never store paise.
-- Dates         DATETIME (not TIMESTAMP) to avoid the 2038 limit. Application
--               writes UTC; display converts to Asia/Kolkata.
-- created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
-- updated_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
--                        ON UPDATE CURRENT_TIMESTAMP
-- deleted_at    Present only where soft delete is genuinely required
--               (catalog, media, customers, admin users). Everything else is
--               hard-deleted or status-flagged.
-- Booleans      TINYINT(1) UNSIGNED, 0/1, prefixed `is_` / `has_` / `allow_`.
-- Enums         ENUM for closed sets the code branches on (status machines).
--               Lookup tables for anything an admin must be able to add
--               (skin types, concerns, tags, carriers).
-- JSON          Only for genuinely schemaless payloads: gateway responses,
--               section settings, webhook bodies, audit diffs. Never for data
--               you need to filter or join on.
-- IP addresses  VARBINARY(16) via INET6_ATON() — holds IPv4 and IPv6.
-- Secrets       Only *_hash columns are stored (SHA-256 hex, CHAR(64)) for
--               tokens/OTP. Passwords use bcrypt/argon2 in `password_hash`.
--
-- FOREIGN KEY POLICY
-- -----------------------------------------------------------------------------
--   CASCADE   child rows meaningless without the parent (cart_items, variants,
--             page sections, order_items)
--   SET NULL  historical rows that must survive the parent (orders keep their
--             snapshot when a customer or product is deleted)
--   RESTRICT  reference data that must not vanish under live rows
--             (tax classes, carriers, roles)
--
-- Polymorphic relations (media_attachments, metafields, seo_meta, audit_logs)
-- deliberately carry no FK — MySQL cannot express them. Integrity for those is
-- enforced in the application layer and by the nightly orphan-sweep job.
-- =============================================================================

CREATE DATABASE IF NOT EXISTS `veylog`
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE `veylog`;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 1;
SET SESSION sql_require_primary_key = 1;
SET SESSION time_zone = '+00:00';
