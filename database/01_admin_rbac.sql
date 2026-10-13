-- =============================================================================
-- File 01 : ADMIN PANEL — staff accounts, roles, permissions, sessions, audit
-- =============================================================================
-- Staff and customers are deliberately separate tables.
--   * Staff  : email + password + MFA, this file.
--   * Customer: phone + OTP, file 07.
-- They have different lifecycles, different threat models and different
-- deletion rules (DPDP erasure applies to customers, not to staff records that
-- back an audit trail). One `users` table for both would force every query to
-- filter on a type column and would let a customer row ever become an admin.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- roles — Founder/Admin, Content, Operations, Support, Growth, Developer
-- (BRD §17 "Admin and Operations"). Seeded in 99_seed_reference.sql.
-- -----------------------------------------------------------------------------
CREATE TABLE `roles` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(50)     NOT NULL,
  `name`          VARCHAR(80)     NOT NULL,
  `description`   VARCHAR(255)        NULL,
  -- system roles cannot be renamed or deleted from the UI
  `is_system`     TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  -- lower number = more powerful; used to stop a role escalating above itself
  `level`         SMALLINT UNSIGNED   NOT NULL DEFAULT 100,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_roles_slug` (`slug`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- permissions — one row per capability, slug is `module.action`
-- e.g. orders.refund, products.publish, cms.publish, customers.export
-- -----------------------------------------------------------------------------
CREATE TABLE `permissions` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `slug`          VARCHAR(80)     NOT NULL,
  `module`        VARCHAR(50)     NOT NULL,
  `action`        VARCHAR(50)     NOT NULL,
  `name`          VARCHAR(120)    NOT NULL,
  `description`   VARCHAR(255)        NULL,
  -- money movement, PII export, role changes: always re-authenticate + audit
  `is_dangerous`  TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `sort_order`    SMALLINT UNSIGNED   NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_permissions_slug` (`slug`),
  KEY `ix_permissions_module` (`module`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `role_permissions` (
  `role_id`       BIGINT UNSIGNED NOT NULL,
  `permission_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`role_id`, `permission_id`),
  KEY `ix_role_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_role_permissions_role`
    FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_role_permissions_permission`
    FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- admin_users — staff accounts
-- -----------------------------------------------------------------------------
CREATE TABLE `admin_users` (
  `id`                     BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `public_id`              CHAR(36)        NOT NULL DEFAULT (UUID()),
  `email`                  VARCHAR(191)    NOT NULL,
  `password_hash`          VARCHAR(255)        NULL,   -- NULL until invite accepted
  `first_name`             VARCHAR(80)     NOT NULL,
  `last_name`              VARCHAR(80)         NULL,
  `phone`                  VARCHAR(20)         NULL,
  `avatar_media_id`        BIGINT UNSIGNED     NULL,   -- FK added in 02_media.sql
  `job_title`              VARCHAR(120)        NULL,
  `status`                 ENUM('invited','active','suspended','disabled')
                                           NOT NULL DEFAULT 'invited',
  -- super admin bypasses the permission table entirely; keep the count tiny
  `is_super_admin`         TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  -- MFA is mandatory for Founder/Admin per BRD §17
  `mfa_enabled`            TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,
  `mfa_secret`             VARCHAR(255)        NULL,   -- encrypted at rest
  `mfa_recovery_codes`     JSON                NULL,   -- array of hashes
  `mfa_enforced_at`        DATETIME            NULL,

  -- brute-force protection
  `failed_login_attempts`  SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  `locked_until`           DATETIME            NULL,
  `last_login_at`          DATETIME            NULL,
  `last_login_ip`          VARBINARY(16)       NULL,
  `password_changed_at`    DATETIME            NULL,
  `must_change_password`   TINYINT(1) UNSIGNED NOT NULL DEFAULT 0,

  `timezone`               VARCHAR(64)     NOT NULL DEFAULT 'Asia/Kolkata',
  `locale`                 VARCHAR(10)     NOT NULL DEFAULT 'en-IN',
  `created_by_admin_id`    BIGINT UNSIGNED     NULL,
  `created_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`             DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  `deleted_at`             DATETIME            NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_users_email` (`email`),
  UNIQUE KEY `uq_admin_users_public_id` (`public_id`),
  KEY `ix_admin_users_status` (`status`),
  CONSTRAINT `fk_admin_users_creator`
    FOREIGN KEY (`created_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admin_user_roles` (
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `role_id`       BIGINT UNSIGNED NOT NULL,
  `assigned_by_admin_id` BIGINT UNSIGNED NULL,
  `assigned_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`admin_user_id`, `role_id`),
  KEY `ix_admin_user_roles_role` (`role_id`),
  CONSTRAINT `fk_admin_user_roles_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_user_roles_role`
    FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_admin_user_roles_assigner`
    FOREIGN KEY (`assigned_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- Per-user override on top of role grants. `deny` always wins over any role
-- allow — this is how you take refund rights off one Support agent without
-- inventing a new role.
CREATE TABLE `admin_user_permissions` (
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `permission_id` BIGINT UNSIGNED NOT NULL,
  `effect`        ENUM('allow','deny') NOT NULL DEFAULT 'allow',
  `expires_at`    DATETIME            NULL,   -- time-boxed developer access
  `granted_by_admin_id` BIGINT UNSIGNED NULL,
  `granted_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`admin_user_id`, `permission_id`),
  KEY `ix_admin_user_permissions_permission` (`permission_id`),
  CONSTRAINT `fk_admin_user_permissions_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_user_permissions_permission`
    FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_admin_user_permissions_granter`
    FOREIGN KEY (`granted_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- admin_sessions — server-side session records so a stolen JWT can be killed
-- -----------------------------------------------------------------------------
CREATE TABLE `admin_sessions` (
  `id`                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id`       BIGINT UNSIGNED NOT NULL,
  `session_token_hash`  CHAR(64)        NOT NULL,   -- sha256 of the token
  `refresh_token_hash`  CHAR(64)            NULL,
  `ip`                  VARBINARY(16)       NULL,
  `user_agent`          VARCHAR(255)        NULL,
  `mfa_satisfied_at`    DATETIME            NULL,
  `last_active_at`      DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at`          DATETIME        NOT NULL,
  `revoked_at`          DATETIME            NULL,
  `revoked_reason`      VARCHAR(120)        NULL,
  `created_at`          DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_sessions_token` (`session_token_hash`),
  KEY `ix_admin_sessions_user` (`admin_user_id`, `revoked_at`),
  KEY `ix_admin_sessions_expiry` (`expires_at`),
  CONSTRAINT `fk_admin_sessions_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admin_password_resets` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id` BIGINT UNSIGNED NOT NULL,
  `token_hash`    CHAR(64)        NOT NULL,
  `ip`            VARBINARY(16)       NULL,
  `expires_at`    DATETIME        NOT NULL,
  `used_at`       DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_password_resets_token` (`token_hash`),
  KEY `ix_admin_password_resets_user` (`admin_user_id`),
  CONSTRAINT `fk_admin_password_resets_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `admin_invites` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `email`         VARCHAR(191)    NOT NULL,
  `role_id`       BIGINT UNSIGNED NOT NULL,
  `token_hash`    CHAR(64)        NOT NULL,
  `invited_by_admin_id` BIGINT UNSIGNED NULL,
  `expires_at`    DATETIME        NOT NULL,
  `accepted_at`   DATETIME            NULL,
  `revoked_at`    DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_admin_invites_token` (`token_hash`),
  KEY `ix_admin_invites_email` (`email`),
  CONSTRAINT `fk_admin_invites_role`
    FOREIGN KEY (`role_id`) REFERENCES `roles` (`id`) ON DELETE RESTRICT,
  CONSTRAINT `fk_admin_invites_inviter`
    FOREIGN KEY (`invited_by_admin_id`) REFERENCES `admin_users` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- -----------------------------------------------------------------------------
-- audit_logs — BRD §17: "All material price, refund, role and content changes
-- are auditable." Deliberately polymorphic and append-only: no UPDATE, no
-- DELETE, no FK to the entity (the entity may later be deleted; the log must
-- outlive it).
-- Partition or archive to cold storage by `created_at` once past ~12 months.
-- -----------------------------------------------------------------------------
CREATE TABLE `audit_logs` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `actor_type`   ENUM('admin','customer','system','webhook','job') NOT NULL DEFAULT 'admin',
  `actor_id`     BIGINT UNSIGNED     NULL,
  `actor_label`  VARCHAR(191)        NULL,   -- denormalised: survives deletion
  `action`       VARCHAR(80)     NOT NULL,   -- product.price_changed, order.refunded
  `entity_type`  VARCHAR(60)         NULL,   -- 'product', 'order', 'cms_page'
  `entity_id`    BIGINT UNSIGNED     NULL,
  `summary`      VARCHAR(255)        NULL,   -- human line for the activity feed
  `changes`      JSON                NULL,   -- {"field":{"from":x,"to":y}}
  `context`      JSON                NULL,   -- request id, route, reason given
  `ip`           VARBINARY(16)       NULL,
  `user_agent`   VARCHAR(255)        NULL,
  `created_at`   DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_audit_logs_entity` (`entity_type`, `entity_id`, `created_at`),
  KEY `ix_audit_logs_actor` (`actor_type`, `actor_id`, `created_at`),
  KEY `ix_audit_logs_action` (`action`, `created_at`),
  KEY `ix_audit_logs_created` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- In-panel alerts: low stock, failed payment, new adverse-event report,
-- webhook dead-letter. admin_user_id NULL = broadcast to everyone with the
-- matching permission.
CREATE TABLE `admin_notifications` (
  `id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `admin_user_id` BIGINT UNSIGNED     NULL,
  `type`          VARCHAR(60)     NOT NULL,
  `severity`      ENUM('info','success','warning','critical') NOT NULL DEFAULT 'info',
  `title`         VARCHAR(191)    NOT NULL,
  `body`          VARCHAR(500)        NULL,
  `link_url`      VARCHAR(500)        NULL,
  `entity_type`   VARCHAR(60)         NULL,
  `entity_id`     BIGINT UNSIGNED     NULL,
  `read_at`       DATETIME            NULL,
  `created_at`    DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ix_admin_notifications_inbox` (`admin_user_id`, `read_at`, `created_at`),
  KEY `ix_admin_notifications_type` (`type`, `created_at`),
  CONSTRAINT `fk_admin_notifications_user`
    FOREIGN KEY (`admin_user_id`) REFERENCES `admin_users` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
