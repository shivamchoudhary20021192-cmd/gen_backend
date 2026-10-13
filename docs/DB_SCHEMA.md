# Database schema

Generated from `veylog_upgrade` (MySQL 8.0.46) by `scripts/db-schema-doc.ts`. Do not edit by hand — run `npm run docs:schema` after migrating.

**227 tables**: 41 on the control plane (platform-wide, no `shop_id`), 186 per shop on the pods (every row carries `shop_id`, every unique key and foreign key includes it).

Legend: **PK** primary key · **UQ** unique · **IX** index · **FK** foreign key · ⚙ control-plane table.

## Contents

- [Online Store and themes](#online-store-and-themes) — 11 tables
- [Platform: shops, plans, identities, billing](#platform-shops-plans-identities-billing) — 40 tables
- [Apps, webhooks and integrations](#apps-webhooks-and-integrations) — 11 tables
- [Catalogue](#catalogue) — 43 tables
- [Inventory and fulfilment](#inventory-and-fulfilment) — 13 tables
- [Orders, carts, payments, returns](#orders-carts-payments-returns) — 17 tables
- [Customers and marketing](#customers-and-marketing) — 34 tables
- [Tax and markets](#tax-and-markets) — 7 tables
- [Content (CMS)](#content-cms) — 32 tables
- [Reviews](#reviews) — 5 tables
- [Settings, audit and system](#settings-audit-and-system) — 12 tables
- [Other](#other) — 2 tables

## Online Store and themes

### `contact_messages`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) | yes |  |  |  |
| `email` | varchar(191) |  |  |  |  |
| `phone` | varchar(40) | yes |  |  |  |
| `body` | text |  |  |  |  |
| `fields` | json | yes |  |  |  |
| `page_path` | varchar(255) | yes |  |  |  |
| `status` | enum('new','read','archived') |  | `new` |  |  |
| `ip_address` | varchar(45) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_contact_messages_inbox` (shop_id, status, created_at)
- PK `PRIMARY` (id)

### `seo_meta`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `entity_type` | varchar(40) |  |  |  |  |
| `entity_id` | bigint unsigned |  |  |  |  |
| `locale` | varchar(10) |  | `en-IN` |  |  |
| `meta_title` | varchar(200) | yes |  |  |  |
| `meta_description` | varchar(320) | yes |  |  |  |
| `h1_override` | varchar(191) | yes |  |  |  |
| `canonical_url` | varchar(500) | yes |  |  |  |
| `og_title` | varchar(200) | yes |  |  |  |
| `og_description` | varchar(320) | yes |  |  |  |
| `og_media_id` | bigint unsigned | yes |  | IX |  |
| `twitter_card` | enum('summary','summary_large_image') |  | `summary_large_image` |  |  |
| `robots_index` | tinyint unsigned |  | `1` |  |  |
| `robots_follow` | tinyint unsigned |  | `1` |  |  |
| `structured_data` | json | yes |  |  |  |
| `sitemap_priority` | decimal(2,1) | yes |  |  |  |
| `sitemap_changefreq` | enum('always','hourly','daily','weekly','monthly','yearly','never') | yes |  |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_seo_meta_og_media` (og_media_id)
- IX `fk_seo_meta_updater` (updated_by_admin_id)
- PK `PRIMARY` (id)
- UQ `uq_seo_meta` (shop_id, entity_type, entity_id, locale)
- FK (og_media_id) → `media` (id)
- FK (updated_by_admin_id) → `admin_users` (id)

### `shop_brand`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `slogan` | varchar(160) | yes |  |  |  |
| `short_description` | varchar(500) | yes |  |  |  |
| `logo_media_id` | bigint unsigned | yes |  |  |  |
| `square_logo_media_id` | bigint unsigned | yes |  |  |  |
| `social_links` | json | yes |  |  |  |
| `seo_title` | varchar(70) | yes |  |  |  |
| `seo_description` | varchar(320) | yes |  |  |  |
| `social_image_media_id` | bigint unsigned | yes |  |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (shop_id)
- FK (shop_id) → `shops` (id)

### `shop_languages`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `locale` | varchar(10) |  |  |  |  |
| `published` | tinyint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_shop_languages_locale` (shop_id, locale)
- UQ `uq_shop_languages_tenant` (shop_id, id)

### `shop_theme_drafts`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `theme_id` | bigint unsigned |  |  | PK |  |
| `path` | varchar(255) |  |  | PK |  |
| `content` | mediumtext | yes |  |  |  |
| `is_deleted` | tinyint unsigned |  | `0` |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (shop_id, theme_id, path)
- FK (shop_id, theme_id) → `shop_themes` (shop_id, id)

### `shop_theme_file_versions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `theme_id` | bigint unsigned |  |  |  |  |
| `path` | varchar(255) |  |  |  |  |
| `content` | mediumtext | yes |  |  |  |
| `checksum` | char(64) |  |  |  |  |
| `source` | enum('install','editor','code','upgrade','restore','api') |  |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_shop_theme_file_versions_file` (shop_id, theme_id, path, id)
- PK `PRIMARY` (id)
- FK (shop_id, theme_id) → `shop_themes` (shop_id, id)

### `shop_theme_files`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `theme_id` | bigint unsigned |  |  | PK |  |
| `path` | varchar(255) |  |  | PK |  |
| `content` | mediumtext | yes |  |  |  |
| `storage_key` | varchar(500) | yes |  |  |  |
| `content_type` | varchar(100) |  |  |  |  |
| `checksum` | char(64) |  |  |  |  |
| `size` | int unsigned |  |  |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_shop_theme_files_theme` (theme_id)
- PK `PRIMARY` (shop_id, theme_id, path)
- FK (shop_id, theme_id) → `shop_themes` (shop_id, id)

### `shop_themes`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  |  |  |  |
| `library_theme_id` | int unsigned | yes |  |  |  |
| `library_handle` | varchar(60) |  |  |  |  |
| `architecture` | enum('tokens','liquid') |  | `tokens` |  |  |
| `name` | varchar(120) |  |  |  |  |
| `role` | enum('main','unpublished','development') |  | `unpublished` |  |  |
| `theme_version` | varchar(20) |  |  |  |  |
| `preset` | varchar(60) | yes |  |  |  |
| `settings_data` | json |  |  |  |  |
| `files_version` | int unsigned |  | `0` |  |  |
| `source` | enum('library','duplicate','upload') |  | `library` |  |  |
| `processing` | enum('ready','installing','failed') |  | `ready` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `main_marker` | bigint unsigned | yes |  | UQ | STORED GENERATED |

- IX `ix_shop_themes_role` (shop_id, role)
- PK `PRIMARY` (id)
- UQ `uq_shop_themes_main` (main_marker)
- UQ `uq_shop_themes_public_id` (shop_id, public_id)
- UQ `uq_shop_themes_tenant` (shop_id, id)

### `theme_library` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | int unsigned |  |  | PK | auto_increment |
| `handle` | varchar(60) |  |  | UQ |  |
| `name` | varchar(120) |  |  |  |  |
| `author` | varchar(120) |  | `Veylog` |  |  |
| `version` | varchar(20) |  |  |  |  |
| `architecture` | enum('tokens','liquid') |  | `tokens` |  |  |
| `files_checksum` | char(64) | yes |  |  |  |
| `description` | text | yes |  |  |  |
| `verticals` | json |  |  |  |  |
| `features` | json | yes |  |  |  |
| `industries` | json | yes |  |  |  |
| `preview_image_url` | varchar(500) | yes |  |  |  |
| `demo_url` | varchar(500) | yes |  |  |  |
| `price_amount` | decimal(10,2) |  | `0.00` |  |  |
| `currency` | char(3) |  | `USD` |  |  |
| `settings_schema` | json |  |  |  |  |
| `presets` | json |  |  |  |  |
| `templates` | json |  |  |  |  |
| `section_types` | json |  |  |  |  |
| `is_builtin` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('draft','published','retired') |  | `published` | IX |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_theme_library_status` (status, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_theme_library_handle` (handle)

### `theme_library_files` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `library_theme_id` | int unsigned |  |  | PK |  |
| `path` | varchar(255) |  |  | PK |  |
| `content` | mediumtext |  |  |  |  |
| `content_type` | varchar(100) |  |  |  |  |
| `checksum` | char(64) |  |  |  |  |
| `size` | int unsigned |  |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (library_theme_id, path)
- FK (library_theme_id) → `theme_library` (id)

### `translations`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `resource_type` | varchar(30) |  |  |  |  |
| `resource_id` | bigint unsigned |  |  |  |  |
| `locale` | varchar(10) |  |  |  |  |
| `field` | varchar(191) |  |  |  |  |
| `value` | mediumtext |  |  |  |  |
| `source_digest` | char(64) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_translations_locale` (shop_id, locale, resource_type)
- PK `PRIMARY` (id)
- UQ `uq_translations_field` (shop_id, resource_type, resource_id, locale, field)
- UQ `uq_translations_tenant` (shop_id, id)

## Platform: shops, plans, identities, billing

### `admin_invites`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `email` | varchar(191) |  |  |  |  |
| `role_id` | bigint unsigned | yes |  | IX |  |
| `token_hash` | char(64) |  |  | IX |  |
| `invited_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `expires_at` | datetime |  |  |  |  |
| `accepted_at` | datetime | yes |  |  |  |
| `revoked_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_admin_invites_inviter` (invited_by_admin_id)
- IX `fk_admin_invites_role` (role_id)
- IX `fk_admin_invites_role_t` (shop_id, role_id)
- IX `ix_admin_invites_email` (shop_id, email)
- IX `ix_admin_invites_token_lookup` (token_hash)
- PK `PRIMARY` (id)
- UQ `uq_admin_invites_token` (shop_id, token_hash)
- FK (invited_by_admin_id) → `admin_users` (id)
- FK (shop_id, role_id) → `roles` (shop_id, id)

### `admin_menu_preferences` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `admin_user_id` | bigint unsigned |  |  | IX |  |
| `menu_item_id` | bigint unsigned |  |  | IX |  |
| `is_pinned` | tinyint unsigned |  | `0` |  |  |
| `is_collapsed` | tinyint unsigned |  | `0` |  |  |
| `pin_order` | smallint unsigned |  | `0` |  |  |
| `last_visited_at` | datetime | yes |  |  |  |
| `visit_count` | int unsigned |  | `0` |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_admin_menu_prefs_item` (menu_item_id)
- PK `PRIMARY` (id)
- UQ `uq_admin_menu_preferences` (admin_user_id, menu_item_id)
- FK (admin_user_id) → `admin_users` (id)
- FK (menu_item_id) → `menu_items` (id)

### `admin_notifications`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `admin_user_id` | bigint unsigned | yes |  | IX |  |
| `type` | varchar(60) |  |  |  |  |
| `severity` | enum('info','success','warning','critical') |  | `info` |  |  |
| `title` | varchar(191) |  |  |  |  |
| `body` | varchar(500) | yes |  |  |  |
| `link_url` | varchar(500) | yes |  |  |  |
| `entity_type` | varchar(60) | yes |  |  |  |
| `entity_id` | bigint unsigned | yes |  |  |  |
| `read_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_admin_notifications_inbox` (admin_user_id, read_at, created_at)
- IX `ix_admin_notifications_type` (shop_id, type, created_at)
- PK `PRIMARY` (id)
- FK (admin_user_id) → `admin_users` (id)

### `admin_password_resets` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `admin_user_id` | bigint unsigned |  |  | IX |  |
| `token_hash` | char(64) |  |  | UQ |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `expires_at` | datetime |  |  |  |  |
| `used_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_admin_password_resets_user` (admin_user_id)
- PK `PRIMARY` (id)
- UQ `uq_admin_password_resets_token` (token_hash)
- FK (admin_user_id) → `admin_users` (id)

### `admin_sessions` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `admin_user_id` | bigint unsigned |  |  | IX |  |
| `active_shop_id` | bigint unsigned | yes |  | IX |  |
| `session_token_hash` | char(64) |  |  | UQ |  |
| `refresh_token_hash` | char(64) | yes |  |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `mfa_satisfied_at` | datetime | yes |  |  |  |
| `last_active_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `expires_at` | datetime |  |  | IX |  |
| `revoked_at` | datetime | yes |  |  |  |
| `revoked_reason` | varchar(120) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_admin_sessions_active_shop` (active_shop_id)
- IX `ix_admin_sessions_expiry` (expires_at)
- IX `ix_admin_sessions_user` (admin_user_id, revoked_at)
- PK `PRIMARY` (id)
- UQ `uq_admin_sessions_token` (session_token_hash)
- FK (admin_user_id) → `admin_users` (id)

### `admin_user_permissions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `admin_user_id` | bigint unsigned |  |  | PK |  |
| `permission_id` | bigint unsigned |  |  | PK |  |
| `effect` | enum('allow','deny') |  | `allow` |  |  |
| `expires_at` | datetime | yes |  |  |  |
| `granted_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `granted_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_admin_user_permissions_granter` (granted_by_admin_id)
- IX `ix_admin_user_permissions_admin_user_id` (admin_user_id)
- IX `ix_admin_user_permissions_permission` (permission_id)
- PK `PRIMARY` (shop_id, admin_user_id, permission_id)
- FK (granted_by_admin_id) → `admin_users` (id)
- FK (permission_id) → `permissions` (id)
- FK (admin_user_id) → `admin_users` (id)

### `admin_user_roles`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `admin_user_id` | bigint unsigned |  |  | PK |  |
| `role_id` | bigint unsigned |  |  | PK |  |
| `assigned_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `assigned_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_admin_user_roles_assigner` (assigned_by_admin_id)
- IX `fk_admin_user_roles_role_t` (shop_id, role_id)
- IX `ix_admin_user_roles_role` (role_id)
- IX `ix_admin_user_roles_shop` (shop_id)
- PK `PRIMARY` (admin_user_id, role_id)
- FK (assigned_by_admin_id) → `admin_users` (id)
- FK (shop_id, role_id) → `roles` (shop_id, id)
- FK (admin_user_id) → `admin_users` (id)

### `admin_users` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `public_id` | char(36) |  | `uuid()` | UQ | DEFAULT_GENERATED |
| `email` | varchar(191) |  |  | UQ |  |
| `password_hash` | varchar(255) | yes |  |  |  |
| `first_name` | varchar(80) |  |  |  |  |
| `last_name` | varchar(80) | yes |  |  |  |
| `phone` | varchar(20) | yes |  |  |  |
| `avatar_media_id` | bigint unsigned | yes |  | IX |  |
| `job_title` | varchar(120) | yes |  |  |  |
| `status` | enum('invited','active','suspended','disabled') |  | `invited` | IX |  |
| `is_super_admin` | tinyint unsigned |  | `0` |  |  |
| `platform_role` | enum('none','support','admin') |  | `none` |  |  |
| `account_type` | enum('human','app','system') |  | `human` |  |  |
| `mfa_enabled` | tinyint unsigned |  | `0` |  |  |
| `mfa_secret` | varchar(255) | yes |  |  |  |
| `mfa_recovery_codes` | json | yes |  |  |  |
| `mfa_enforced_at` | datetime | yes |  |  |  |
| `failed_login_attempts` | smallint unsigned |  | `0` |  |  |
| `locked_until` | datetime | yes |  |  |  |
| `last_login_at` | datetime | yes |  |  |  |
| `last_login_ip` | varbinary(16) | yes |  |  |  |
| `password_changed_at` | datetime | yes |  |  |  |
| `must_change_password` | tinyint unsigned |  | `0` |  |  |
| `timezone` | varchar(64) |  | `Asia/Kolkata` |  |  |
| `locale` | varchar(10) |  | `en-IN` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_admin_users_avatar` (avatar_media_id)
- IX `fk_admin_users_creator` (created_by_admin_id)
- IX `ix_admin_users_status` (status)
- PK `PRIMARY` (id)
- UQ `uq_admin_users_email` (email)
- UQ `uq_admin_users_public_id` (public_id)
- FK (avatar_media_id) → `media` (id)
- FK (created_by_admin_id) → `admin_users` (id)

### `api_rate_buckets` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `bucket_key` | varchar(80) |  |  | PK |  |
| `level` | double |  |  |  |  |
| `updated_ms` | bigint unsigned |  |  | IX |  |
| `result` | bigint unsigned |  | `0` |  |  |

- IX `ix_api_rate_buckets_updated` (updated_ms)
- PK `PRIMARY` (bucket_key)

### `billing_accounts` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | UQ |  |
| `provider` | varchar(40) |  |  |  |  |
| `provider_customer_id` | varchar(120) | yes |  |  |  |
| `payment_method_ref` | varchar(120) | yes |  |  |  |
| `payment_method_label` | varchar(120) | yes |  |  |  |
| `payment_method_expires` | char(7) | yes |  |  |  |
| `pending_setup_ref` | varchar(120) | yes |  |  |  |
| `billing_email` | varchar(191) | yes |  |  |  |
| `legal_name` | varchar(160) | yes |  |  |  |
| `tax_id` | varchar(40) | yes |  |  |  |
| `tax_region` | varchar(10) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_billing_accounts_shop` (shop_id)
- FK (shop_id) → `shops` (id)

### `billing_provider_events`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `provider` | varchar(40) |  |  | IX |  |
| `event_id` | varchar(120) |  |  |  |  |
| `type` | varchar(80) |  |  |  |  |
| `invoice_id` | bigint unsigned | yes |  | IX |  |
| `outcome` | varchar(40) | yes |  |  |  |
| `error` | varchar(500) | yes |  |  |  |
| `received_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `processed_at` | datetime | yes |  |  |  |

- IX `ix_billing_provider_events_invoice` (invoice_id)
- PK `PRIMARY` (id)
- UQ `uq_billing_provider_events` (provider, event_id)

### `domain_events` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `domain_id` | bigint unsigned |  |  | IX |  |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `hostname` | varchar(253) |  |  | IX |  |
| `event` | varchar(40) |  |  |  |  |
| `from_status` | varchar(30) | yes |  |  |  |
| `to_status` | varchar(30) | yes |  |  |  |
| `detail` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_domain_events_domain` (domain_id, created_at)
- IX `ix_domain_events_hostname` (hostname, created_at)
- IX `ix_domain_events_shop` (shop_id, created_at)
- PK `PRIMARY` (id)

### `domain_registrations` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `domain` | varchar(253) |  |  | UQ |  |
| `registrar` | varchar(30) |  |  |  |  |
| `kind` | enum('registration','transfer') |  | `registration` |  |  |
| `registrar_order_id` | varchar(120) | yes |  |  |  |
| `status` | enum('pending','transferring','active','expired','transferred_out','failed') |  | `pending` | IX |  |
| `years` | tinyint unsigned |  | `1` |  |  |
| `price_amount` | decimal(12,2) |  |  |  |  |
| `renewal_amount` | decimal(12,2) |  |  |  |  |
| `currency` | char(3) |  |  |  |  |
| `auto_renew` | tinyint unsigned |  | `1` |  |  |
| `privacy` | tinyint unsigned |  | `1` |  |  |
| `registered_at` | datetime | yes |  |  |  |
| `expires_at` | datetime | yes |  |  |  |
| `last_error` | varchar(500) | yes |  |  |  |
| `transfer_checked_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_domain_registrations_expiry` (status, expires_at)
- IX `ix_domain_registrations_shop` (shop_id)
- IX `ix_domain_registrations_transfers` (status, transfer_checked_at)
- PK `PRIMARY` (id)
- UQ `uq_domain_registrations_domain` (domain)
- FK (shop_id) → `shops` (id)

### `feature_flags` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `flag_key` | varchar(80) |  |  | UQ |  |
| `description` | varchar(500) | yes |  |  |  |
| `is_enabled` | tinyint unsigned |  | `0` |  |  |
| `rollout_percent` | tinyint unsigned |  | `0` |  |  |
| `conditions` | json | yes |  |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_feature_flags_admin` (updated_by_admin_id)
- PK `PRIMARY` (id)
- UQ `uq_feature_flags_key` (flag_key)
- FK (updated_by_admin_id) → `admin_users` (id)

### `job_runs` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `job_name` | varchar(80) |  |  | IX |  |
| `status` | enum('running','completed','failed') |  | `running` |  |  |
| `items_processed` | int unsigned |  | `0` |  |  |
| `error_message` | varchar(500) | yes |  |  |  |
| `context` | json | yes |  |  |  |
| `started_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `finished_at` | datetime | yes |  |  |  |
| `duration_ms` | int unsigned | yes |  |  |  |

- IX `ix_job_runs_name` (job_name, started_at)
- PK `PRIMARY` (id)

### `jobs` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `queue` | varchar(40) |  | `default` |  |  |
| `type` | varchar(80) |  |  |  |  |
| `shop_id` | bigint unsigned | yes |  | IX |  |
| `payload` | json |  |  |  |  |
| `status` | enum('pending','running','succeeded','dead','cancelled') |  | `pending` | IX |  |
| `priority` | tinyint unsigned |  | `5` |  |  |
| `attempts` | smallint unsigned |  | `0` |  |  |
| `max_attempts` | smallint unsigned |  | `10` |  |  |
| `run_at` | datetime(3) |  | `CURRENT_TIMESTAMP(3)` |  | DEFAULT_GENERATED |
| `locked_by` | varchar(80) | yes |  |  |  |
| `lock_expires_at` | datetime(3) | yes |  |  |  |
| `unique_key` | varchar(190) | yes |  | UQ |  |
| `last_error` | text | yes |  |  |  |
| `created_at` | datetime(3) |  | `CURRENT_TIMESTAMP(3)` |  | DEFAULT_GENERATED |
| `started_at` | datetime(3) | yes |  |  |  |
| `finished_at` | datetime(3) | yes |  |  |  |

- IX `ix_jobs_claim` (status, queue, run_at, priority)
- IX `ix_jobs_finished` (status, finished_at)
- IX `ix_jobs_lock` (status, lock_expires_at)
- IX `ix_jobs_shop` (shop_id, type, status)
- PK `PRIMARY` (id)
- UQ `uq_jobs_unique_key` (unique_key)

### `maintenance_runs` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `name` | varchar(100) |  |  | PK |  |
| `detail` | json | yes |  |  |  |
| `applied_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (name)

### `organizations` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `public_id` | char(36) |  |  | UQ |  |
| `name` | varchar(160) |  |  |  |  |
| `owner_user_id` | bigint unsigned | yes |  | IX |  |
| `billing_email` | varchar(190) | yes |  |  |  |
| `country_code` | char(2) |  | `IN` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `ix_organizations_owner` (owner_user_id)
- PK `PRIMARY` (id)
- UQ `uq_organizations_public_id` (public_id)
- FK (owner_user_id) → `admin_users` (id)

### `otp_requests`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `request_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `country_code` | varchar(5) |  | `+91` |  |  |
| `phone` | varchar(15) |  |  |  |  |
| `purpose` | enum('login','signup','checkout_verify','phone_change','order_track','cod_confirm') |  | `login` |  |  |
| `channel` | enum('sms','whatsapp') |  |  |  |  |
| `otp_hash` | char(64) |  |  |  |  |
| `otp_length` | tinyint unsigned |  | `6` |  |  |
| `attempts` | tinyint unsigned |  | `0` |  |  |
| `max_attempts` | tinyint unsigned |  | `5` |  |  |
| `resend_count` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('pending','sent','verified','expired','failed','cancelled') |  | `pending` |  |  |
| `provider` | varchar(40) | yes |  |  |  |
| `provider_message_id` | varchar(120) | yes |  |  |  |
| `provider_status` | varchar(60) | yes |  |  |  |
| `error_message` | varchar(255) | yes |  |  |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `device_id` | varchar(64) | yes |  |  |  |
| `sent_at` | datetime | yes |  |  |  |
| `expires_at` | datetime |  |  |  |  |
| `verified_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_otp_requests_customer` (customer_id)
- IX `ix_otp_requests_ip` (shop_id, ip, created_at)
- IX `ix_otp_requests_phone_time` (shop_id, country_code, phone, created_at)
- IX `ix_otp_requests_status` (shop_id, status, expires_at)
- PK `PRIMARY` (id)
- UQ `uq_otp_requests_request_id` (shop_id, request_id)
- FK (customer_id) → `customers` (id)

### `otp_throttle`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `identifier` | varchar(120) |  |  |  |  |
| `identifier_type` | enum('phone','ip','device') |  |  |  |  |
| `window_start` | datetime |  |  |  |  |
| `request_count` | smallint unsigned |  | `0` |  |  |
| `blocked_until` | datetime | yes |  |  |  |
| `block_reason` | varchar(120) | yes |  |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_otp_throttle_blocked` (shop_id, blocked_until)
- PK `PRIMARY` (id)
- UQ `uq_otp_throttle` (shop_id, identifier_type, identifier, window_start)

### `permissions` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `slug` | varchar(80) |  |  | UQ |  |
| `module` | varchar(50) |  |  | IX |  |
| `action` | varchar(50) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `is_dangerous` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `ix_permissions_module` (module)
- PK `PRIMARY` (id)
- UQ `uq_permissions_slug` (slug)

### `plan_prices` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `plan_id` | int unsigned |  |  | PK |  |
| `currency` | char(3) |  |  | PK |  |
| `price_amount` | decimal(12,2) |  |  |  |  |

- PK `PRIMARY` (plan_id, currency)
- FK (plan_id) → `plans` (id)

### `plans` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | int unsigned |  |  | PK | auto_increment |
| `handle` | varchar(40) |  |  | UQ |  |
| `name` | varchar(80) |  |  |  |  |
| `tagline` | varchar(160) | yes |  |  |  |
| `price_amount` | decimal(12,2) |  | `0.00` |  |  |
| `currency` | char(3) |  | `INR` |  |  |
| `billing_interval` | enum('month','year') |  | `month` |  |  |
| `trial_days` | smallint unsigned |  | `14` |  |  |
| `transaction_fee_bps` | smallint unsigned |  | `0` |  |  |
| `limits` | json |  |  |  |  |
| `features` | json |  |  |  |  |
| `is_public` | tinyint unsigned |  | `1` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_plans_handle` (handle)

### `platform_emails` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned | yes |  | IX |  |
| `to_email` | varchar(191) |  |  | IX |  |
| `template` | varchar(60) |  |  |  |  |
| `subject` | varchar(255) |  |  |  |  |
| `body` | mediumtext | yes |  |  |  |
| `sensitive` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('queued','sent','failed') |  | `queued` |  |  |
| `provider` | varchar(40) | yes |  |  |  |
| `provider_message_id` | varchar(191) | yes |  |  |  |
| `error` | varchar(500) | yes |  |  |  |
| `attempts` | smallint unsigned |  | `0` |  |  |
| `dedupe_key` | varchar(191) | yes |  | UQ |  |
| `sent_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_platform_emails_shop` (shop_id, created_at)
- IX `ix_platform_emails_to` (to_email, created_at)
- PK `PRIMARY` (id)
- UQ `uq_platform_emails_dedupe` (dedupe_key)

### `platform_invoice_lines` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `invoice_id` | bigint unsigned | yes |  | IX |  |
| `kind` | enum('subscription','transaction_fee','proration','adjustment','domain','tax') |  |  |  |  |
| `description` | varchar(255) |  |  |  |  |
| `currency` | char(3) |  |  |  |  |
| `amount` | decimal(12,2) |  |  |  |  |
| `period_start` | datetime | yes |  |  |  |
| `period_end` | datetime | yes |  |  |  |
| `reference` | varchar(120) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_platform_invoice_lines_invoice` (invoice_id)
- IX `ix_platform_invoice_lines_pending` (shop_id, invoice_id)
- PK `PRIMARY` (id)
- FK (invoice_id) → `platform_invoices` (id)
- FK (shop_id) → `shops` (id)

### `platform_invoices` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `subscription_id` | bigint unsigned | yes |  |  |  |
| `invoice_number` | varchar(32) | yes |  | UQ |  |
| `kind` | enum('cycle','plan_change','manual') |  | `cycle` |  |  |
| `currency` | char(3) |  |  |  |  |
| `period_start` | datetime |  |  |  |  |
| `period_end` | datetime |  |  |  |  |
| `subtotal` | decimal(12,2) |  | `0.00` |  |  |
| `tax_total` | decimal(12,2) |  | `0.00` |  |  |
| `tax_note` | varchar(200) | yes |  |  |  |
| `customer_tax_id` | varchar(40) | yes |  |  |  |
| `total` | decimal(12,2) |  | `0.00` |  |  |
| `status` | enum('open','paid','failed','void') |  | `open` | IX |  |
| `attempt_count` | smallint unsigned |  | `0` |  |  |
| `next_attempt_at` | datetime | yes |  |  |  |
| `first_failed_at` | datetime | yes |  |  |  |
| `last_error` | varchar(500) | yes |  |  |  |
| `provider` | varchar(40) | yes |  |  |  |
| `provider_payment_id` | varchar(120) | yes |  |  |  |
| `issued_at` | datetime |  |  |  |  |
| `paid_at` | datetime | yes |  |  |  |
| `voided_at` | datetime | yes |  |  |  |
| `cycle_key` | varchar(80) | yes |  | UQ |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_platform_invoices_retry` (status, next_attempt_at)
- IX `ix_platform_invoices_shop` (shop_id, status)
- PK `PRIMARY` (id)
- UQ `uq_platform_invoices_cycle` (cycle_key)
- UQ `uq_platform_invoices_number` (invoice_number)
- FK (shop_id) → `shops` (id)

### `pods` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | int unsigned |  |  | PK | auto_increment |
| `name` | varchar(40) |  |  | UQ |  |
| `region` | varchar(40) |  | `default` |  |  |
| `status` | enum('active','draining','read_only','offline') |  | `active` |  |  |
| `accepts_new_shops` | tinyint unsigned |  | `1` |  |  |
| `capacity` | int unsigned |  | `5000` |  |  |
| `notes` | varchar(255) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_pods_name` (name)

### `rate_limits` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `bucket_key` | varchar(80) |  |  | IX |  |
| `identifier` | varchar(120) |  |  |  |  |
| `hits` | int unsigned |  | `0` |  |  |
| `window_start` | datetime |  |  |  |  |
| `expires_at` | datetime |  |  | IX |  |
| `blocked_until` | datetime | yes |  |  |  |

- IX `ix_rate_limits_expiry` (expires_at)
- PK `PRIMARY` (id)
- UQ `uq_rate_limits` (bucket_key, identifier, window_start)

### `role_permissions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `role_id` | bigint unsigned |  |  | PK |  |
| `permission_id` | bigint unsigned |  |  | PK |  |

- IX `fk_role_permissions_role_t` (shop_id, role_id)
- IX `ix_role_permissions_permission` (permission_id)
- IX `ix_role_permissions_shop` (shop_id)
- PK `PRIMARY` (role_id, permission_id)
- FK (permission_id) → `permissions` (id)
- FK (shop_id, role_id) → `roles` (shop_id, id)

### `roles`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(50) |  |  |  |  |
| `name` | varchar(80) |  |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `is_system` | tinyint unsigned |  | `0` |  |  |
| `level` | smallint unsigned |  | `100` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_roles_slug` (shop_id, slug)
- UQ `uq_roles_tenant` (shop_id, id)

### `shop_domains` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `hostname` | varchar(253) |  |  | UQ |  |
| `root_domain` | varchar(253) | yes |  | IX |  |
| `pair_id` | bigint unsigned | yes |  |  |  |
| `kind` | enum('platform','custom') |  |  |  |  |
| `status` | enum('pending_dns','provisioning_ssl','active','misconfigured','ssl_failed','expired') |  | `pending_dns` | IX |  |
| `source` | enum('platform','connected','purchased','transferred') |  | `connected` |  |  |
| `is_primary` | tinyint unsigned |  | `0` |  |  |
| `verification_status` | enum('pending','verified','failed') |  | `pending` | IX |  |
| `verification_token` | char(32) |  |  |  |  |
| `routing_target` | varchar(253) | yes |  | UQ |  |
| `ownership_method` | enum('txt','cname','sibling','registrar','platform','transfer') | yes |  |  |  |
| `verified_at` | datetime | yes |  |  |  |
| `ssl_status` | enum('pending','active','failed') |  | `pending` |  |  |
| `redirect_to_primary` | tinyint unsigned |  | `1` |  |  |
| `last_checked_at` | datetime | yes |  |  |  |
| `failure_reason` | varchar(255) | yes |  |  |  |
| `dns_snapshot` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `primary_marker` | bigint unsigned | yes |  | UQ | STORED GENERATED |
| `edge_provider` | varchar(30) | yes |  |  |  |
| `edge_hostname_id` | varchar(120) | yes |  |  |  |
| `certificate_status` | enum('none','pending','active','failed') |  | `none` |  |  |
| `certificate_issuer` | varchar(120) | yes |  |  |  |
| `certificate_expires_at` | datetime | yes |  |  |  |
| `market_id` | bigint unsigned | yes |  |  |  |
| `locale` | varchar(10) | yes |  |  |  |
| `check_attempts` | int unsigned |  | `0` |  |  |
| `next_check_at` | datetime | yes |  | IX |  |
| `check_lease` | char(36) | yes |  | IX |  |
| `status_changed_at` | datetime | yes |  |  |  |
| `last_healthy_at` | datetime | yes |  |  |  |

- IX `ix_shop_domains_due` (next_check_at, status)
- IX `ix_shop_domains_lease` (check_lease)
- IX `ix_shop_domains_pending` (verification_status, last_checked_at)
- IX `ix_shop_domains_root` (root_domain)
- IX `ix_shop_domains_shop` (shop_id, kind)
- IX `ix_shop_domains_status` (status, status_changed_at)
- PK `PRIMARY` (id)
- UQ `uq_shop_domains_hostname` (hostname)
- UQ `uq_shop_domains_primary` (primary_marker)
- UQ `uq_shop_domains_routing_target` (routing_target)
- FK (shop_id) → `shops` (id)

### `shop_policies`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `kind` | enum('privacy','terms','refund','shipping','contact','legal_notice') |  |  |  |  |
| `title` | varchar(191) |  |  |  |  |
| `body` | mediumtext |  |  |  |  |
| `version` | int unsigned |  | `1` |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_shop_policies_kind` (shop_id, kind)
- UQ `uq_shop_policies_tenant` (shop_id, id)
- FK (shop_id) → `shops` (id)

### `shop_policy_versions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `kind` | enum('privacy','terms','refund','shipping','contact','legal_notice') |  |  |  |  |
| `version` | int unsigned |  |  |  |  |
| `title` | varchar(191) |  |  |  |  |
| `body` | mediumtext |  |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_shop_policy_versions` (shop_id, kind, version)
- FK (shop_id) → `shops` (id)

### `shop_privacy_settings`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `banner_enabled` | tinyint unsigned |  | `1` |  |  |
| `banner_regions` | enum('required','all','custom') |  | `required` |  |  |
| `banner_countries` | json | yes |  |  |  |
| `banner_position` | enum('bottom','bottom_left','bottom_right','center') |  | `bottom` |  |  |
| `banner_colors` | json | yes |  |  |  |
| `banner_copy` | json | yes |  |  |  |
| `consent_max_age_days` | smallint unsigned |  | `365` |  |  |
| `reprompt_on_policy_change` | tinyint unsigned |  | `1` |  |  |
| `sale_opt_out_enabled` | tinyint unsigned |  | `1` |  |  |
| `sale_opt_out_countries` | json | yes |  |  |  |
| `honor_gpc` | tinyint unsigned |  | `1` |  |  |
| `request_form_enabled` | tinyint unsigned |  | `1` |  |  |
| `request_response_days` | smallint unsigned |  | `30` |  |  |
| `erasure_grace_days` | smallint unsigned |  | `10` |  |  |
| `erasure_order_hold_days` | smallint unsigned |  | `180` |  |  |
| `privacy_email` | varchar(191) | yes |  |  |  |
| `grievance_officer_name` | varchar(120) | yes |  |  |  |
| `grievance_officer_email` | varchar(191) | yes |  |  |  |
| `grievance_officer_phone` | varchar(40) | yes |  |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (shop_id)
- FK (shop_id) → `shops` (id)

### `shop_setup_tasks`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `task_key` | varchar(60) |  |  | PK |  |
| `kind` | enum('provisioning','onboarding') |  |  |  |  |
| `status` | enum('pending','done','skipped','failed') |  | `pending` |  |  |
| `attempts` | smallint unsigned |  | `0` |  |  |
| `last_error` | varchar(500) | yes |  |  |  |
| `meta` | json | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `completed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_shop_setup_tasks_kind` (shop_id, kind, status)
- PK `PRIMARY` (shop_id, task_key)

### `shop_staff` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `admin_user_id` | bigint unsigned |  |  | IX |  |
| `is_owner` | tinyint unsigned |  | `0` |  |  |
| `has_full_access` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('invited','active','suspended') |  | `active` |  |  |
| `job_title` | varchar(120) | yes |  |  |  |
| `invited_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `joined_at` | datetime | yes |  |  |  |
| `last_accessed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `owner_marker` | bigint unsigned | yes |  | UQ | STORED GENERATED |

- IX `fk_shop_staff_inviter` (invited_by_admin_id)
- IX `ix_shop_staff_user` (admin_user_id, status)
- PK `PRIMARY` (id)
- UQ `uq_shop_staff_member` (shop_id, admin_user_id)
- UQ `uq_shop_staff_owner` (owner_marker)
- FK (invited_by_admin_id) → `admin_users` (id)
- FK (shop_id) → `shops` (id)
- FK (admin_user_id) → `admin_users` (id)

### `shop_subscriptions` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `plan_id` | int unsigned |  |  | IX |  |
| `status` | enum('trialing','active','past_due','frozen','cancelled') |  |  | IX |  |
| `price_amount` | decimal(12,2) |  |  |  |  |
| `currency` | char(3) |  |  |  |  |
| `billing_interval` | enum('month','year') |  | `month` |  |  |
| `trial_ends_at` | datetime | yes |  |  |  |
| `current_period_start` | datetime |  |  |  |  |
| `current_period_end` | datetime |  |  |  |  |
| `cancel_at_period_end` | tinyint unsigned |  | `0` |  |  |
| `cancelled_at` | datetime | yes |  |  |  |
| `provider` | varchar(40) |  | `manual` |  |  |
| `provider_subscription_id` | varchar(120) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `live_marker` | bigint unsigned | yes |  | UQ | STORED GENERATED |

- IX `fk_shop_subscriptions_plan` (plan_id)
- IX `ix_shop_subscriptions_period` (status, current_period_end)
- IX `ix_shop_subscriptions_shop` (shop_id, status)
- PK `PRIMARY` (id)
- UQ `uq_shop_subscriptions_live` (live_marker)
- FK (plan_id) → `plans` (id)
- FK (shop_id) → `shops` (id)

### `shops` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `public_id` | char(36) |  |  | UQ |  |
| `handle` | varchar(60) |  |  | UQ |  |
| `name` | varchar(160) |  |  |  |  |
| `email` | varchar(190) | yes |  |  |  |
| `phone` | varchar(20) | yes |  |  |  |
| `organization_id` | bigint unsigned | yes |  | IX |  |
| `owner_user_id` | bigint unsigned | yes |  | IX |  |
| `pod_id` | int unsigned |  | `1` | IX |  |
| `plan_id` | int unsigned | yes |  | IX |  |
| `status` | enum('provisioning','active','paused','frozen','suspended','closed') |  | `provisioning` |  |  |
| `status_reason` | varchar(255) | yes |  |  |  |
| `vertical` | varchar(40) |  | `general` |  |  |
| `country_code` | char(2) |  | `IN` |  |  |
| `currency` | char(3) |  | `INR` |  |  |
| `timezone` | varchar(64) |  | `Asia/Kolkata` |  |  |
| `locale` | varchar(10) |  | `en` |  |  |
| `weight_unit` | enum('g','kg','lb','oz') |  | `g` |  |  |
| `tax_engine` | varchar(40) |  | `none` |  |  |
| `tax_shipping` | tinyint unsigned |  | `1` |  |  |
| `storefront_password_enabled` | tinyint unsigned |  | `0` |  |  |
| `storefront_password_hash` | varchar(255) | yes |  |  |  |
| `provisioned_at` | datetime | yes |  |  |  |
| `closed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_shops_organization` (organization_id)
- IX `ix_shops_owner` (owner_user_id)
- IX `ix_shops_plan` (plan_id)
- IX `ix_shops_pod_status` (pod_id, status)
- PK `PRIMARY` (id)
- UQ `uq_shops_handle` (handle)
- UQ `uq_shops_public_id` (public_id)
- FK (organization_id) → `organizations` (id)
- FK (owner_user_id) → `admin_users` (id)
- FK (plan_id) → `plans` (id)
- FK (pod_id) → `pods` (id)

### `storefront_versions` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `version` | bigint unsigned |  | `1` |  |  |
| `updated_at` | datetime(3) |  |  | IX |  |

- IX `idx_storefront_versions_updated` (updated_at)
- PK `PRIMARY` (shop_id)
- FK (shop_id) → `shops` (id)

### `user_sidebar_preferences` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `user_id` | bigint unsigned |  |  | UQ |  |
| `is_collapsed` | tinyint unsigned |  | `0` |  | Mini/icon-only mode |
| `is_pinned` | tinyint unsigned |  | `1` |  | Stay open vs auto-hide |
| `width` | smallint unsigned | yes | `280` |  | Sidebar width in pixels |
| `collapsed_width` | smallint unsigned | yes | `64` |  | Mini mode width |
| `pinned_items` | json | yes |  |  | Array of menu_item IDs user pinned to top |
| `hidden_items` | json | yes |  |  | Array of menu_item IDs user hid |
| `collapsed_groups` | json | yes |  |  | Array of section/group keys that are collapsed |
| `recent_items` | json | yes |  |  | Recently accessed menu items (max 10) |
| `favorite_items` | json | yes |  |  | User-favorited menu items |
| `auto_collapse` | tinyint unsigned |  | `0` |  | Auto-collapse on route change |
| `show_tooltips` | tinyint unsigned |  | `1` |  | Show hover tooltips |
| `show_badges` | tinyint unsigned |  | `1` |  | Show notification badges |
| `animation_speed` | enum('none','fast','normal','slow') |  | `normal` |  |  |
| `most_used_item_id` | bigint unsigned | yes |  | IX | Most frequently clicked item |
| `total_clicks` | int unsigned |  | `0` |  |  |
| `last_reset_at` | datetime | yes |  |  | When click count was last reset |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `idx_user_sidebar_user_id` (user_id)
- IX `most_used_item_id` (most_used_item_id)
- PK `PRIMARY` (id)
- UQ `user_sidebar_preferences_user_id_unique` (user_id)
- FK (user_id) → `admin_users` (id)
- FK (most_used_item_id) → `menu_items` (id)

## Apps, webhooks and integrations

### `app_access_tokens` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `app_id` | bigint unsigned |  |  | IX |  |
| `installation_id` | bigint unsigned |  |  |  |  |
| `token_hash` | char(64) |  |  | UQ |  |
| `token_hint` | varchar(12) |  |  |  |  |
| `scopes` | json |  |  |  |  |
| `last_used_at` | datetime | yes |  |  |  |
| `revoked_at` | datetime | yes |  |  |  |
| `revoked_reason` | varchar(60) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_app_access_tokens_app` (app_id)
- IX `ix_app_access_tokens_installation` (shop_id, installation_id, revoked_at)
- PK `PRIMARY` (id)
- UQ `uq_app_access_tokens_hash` (token_hash)
- FK (app_id) → `apps` (id)

### `app_installations`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `app_id` | bigint unsigned |  |  |  |  |
| `granted_scopes` | json |  |  |  |  |
| `status` | enum('active','uninstalled') |  | `active` |  |  |
| `installed_by_admin_id` | bigint unsigned | yes |  |  |  |
| `installed_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `uninstalled_at` | datetime | yes |  |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_app_installations_status` (shop_id, status)
- PK `PRIMARY` (id)
- UQ `uq_app_installations_app` (shop_id, app_id)
- UQ `uq_app_installations_tenant` (shop_id, id)

### `app_theme_extensions` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `app_id` | bigint unsigned |  |  | UQ |  |
| `version` | int unsigned |  | `1` |  |  |
| `files` | json |  |  |  |  |
| `checksum` | char(64) |  |  |  |  |
| `deployed_by` | varchar(191) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_app_theme_extensions_app` (app_id)

### `apps` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `public_id` | char(36) |  |  | UQ |  |
| `client_id` | varchar(64) |  |  | UQ |  |
| `client_secret_ciphertext` | text |  |  |  |  |
| `client_secret_hint` | varchar(12) |  |  |  |  |
| `handle` | varchar(80) |  |  | UQ |  |
| `name` | varchar(120) |  |  |  |  |
| `tagline` | varchar(200) | yes |  |  |  |
| `description` | text | yes |  |  |  |
| `icon_url` | varchar(500) | yes |  |  |  |
| `developer_name` | varchar(160) | yes |  |  |  |
| `developer_email` | varchar(190) | yes |  |  |  |
| `support_url` | varchar(500) | yes |  |  |  |
| `privacy_policy_url` | varchar(500) | yes |  |  |  |
| `app_url` | varchar(500) | yes |  |  |  |
| `compliance_webhook_url` | varchar(500) | yes |  |  |  |
| `redirect_urls` | json |  |  |  |  |
| `requested_scopes` | json |  |  |  |  |
| `distribution` | enum('public','custom') |  | `public` | IX |  |
| `owner_shop_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('draft','published','delisted') |  | `draft` |  |  |
| `webhook_api_version` | varchar(10) |  | `2026-10` |  |  |
| `bot_admin_user_id` | bigint unsigned | yes |  | IX |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_apps_bot` (bot_admin_user_id)
- IX `fk_apps_creator` (created_by_admin_id)
- IX `ix_apps_listing` (distribution, status)
- IX `ix_apps_owner_shop` (owner_shop_id)
- PK `PRIMARY` (id)
- UQ `uq_apps_client_id` (client_id)
- UQ `uq_apps_handle` (handle)
- UQ `uq_apps_public_id` (public_id)
- FK (bot_admin_user_id) → `admin_users` (id)
- FK (created_by_admin_id) → `admin_users` (id)

### `events`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `event_uuid` | char(36) |  |  |  |  |
| `topic` | varchar(80) |  |  |  |  |
| `resource_type` | varchar(40) | yes |  |  |  |
| `resource_id` | bigint unsigned | yes |  |  |  |
| `payload` | json |  |  |  |  |
| `actor_type` | varchar(20) | yes |  |  |  |
| `actor_id` | bigint unsigned | yes |  |  |  |
| `only_app_id` | bigint unsigned | yes |  |  |  |
| `occurred_at` | datetime(3) |  | `CURRENT_TIMESTAMP(3)` |  | DEFAULT_GENERATED |
| `dispatched_at` | datetime(3) | yes |  | IX |  |
| `dispatch_attempts` | smallint unsigned |  | `0` |  |  |
| `last_error` | varchar(500) | yes |  |  |  |

- IX `ix_events_pending` (dispatched_at, id)
- IX `ix_events_resource` (shop_id, resource_type, resource_id)
- IX `ix_events_topic` (shop_id, topic, occurred_at)
- PK `PRIMARY` (id)
- UQ `uq_events_tenant` (shop_id, id)
- UQ `uq_events_uuid` (shop_id, event_uuid)

### `integration_connections`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  |  |  |  |
| `provider` | varchar(40) |  |  |  |  |
| `category` | varchar(30) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `status` | enum('active','disabled','error') |  | `active` |  |  |
| `mode` | enum('live','test') |  | `test` |  |  |
| `is_default` | tinyint unsigned |  | `0` |  |  |
| `credentials_sealed` | text | yes |  |  |  |
| `credentials_hint` | varchar(160) | yes |  |  |  |
| `config` | json | yes |  |  |  |
| `last_verified_at` | datetime | yes |  |  |  |
| `last_used_at` | datetime | yes |  |  |  |
| `last_error` | varchar(500) | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `default_marker` | varchar(80) | yes |  | UQ | STORED GENERATED |

- IX `ix_integration_connections_category` (shop_id, category, status)
- PK `PRIMARY` (id)
- UQ `uq_integration_connections_default` (default_marker)
- UQ `uq_integration_connections_name` (shop_id, provider, name)
- UQ `uq_integration_connections_public_id` (shop_id, public_id)
- UQ `uq_integration_connections_tenant` (shop_id, id)

### `integration_webhook_events`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `connection_id` | bigint unsigned | yes |  |  |  |
| `provider` | varchar(40) |  |  |  |  |
| `external_id` | varchar(190) |  |  |  |  |
| `event_type` | varchar(120) | yes |  |  |  |
| `signature_valid` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('received','processed','ignored','failed') |  | `received` |  |  |
| `attempts` | smallint unsigned |  | `0` |  |  |
| `payload` | json | yes |  |  |  |
| `error` | varchar(1000) | yes |  |  |  |
| `received_at` | datetime(3) |  | `CURRENT_TIMESTAMP(3)` | IX | DEFAULT_GENERATED |
| `processed_at` | datetime(3) | yes |  |  |  |

- IX `ix_integration_webhook_events_connection` (shop_id, connection_id, received_at)
- IX `ix_integration_webhook_events_received` (received_at)
- IX `ix_integration_webhook_events_status` (shop_id, status, received_at)
- PK `PRIMARY` (id)
- UQ `uq_integration_webhook_events_external` (shop_id, provider, external_id)
- UQ `uq_integration_webhook_events_tenant` (shop_id, id)

### `oauth_authorization_codes` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `code_hash` | char(64) |  |  | UQ |  |
| `app_id` | bigint unsigned |  |  | IX |  |
| `shop_id` | bigint unsigned |  |  |  |  |
| `admin_user_id` | bigint unsigned |  |  | IX |  |
| `scopes` | json |  |  |  |  |
| `redirect_uri` | varchar(500) |  |  |  |  |
| `expires_at` | datetime |  |  | IX |  |
| `used_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_oauth_codes_admin` (admin_user_id)
- IX `fk_oauth_codes_app` (app_id)
- IX `ix_oauth_codes_expiry` (expires_at)
- PK `PRIMARY` (id)
- UQ `uq_oauth_codes_hash` (code_hash)
- FK (admin_user_id) → `admin_users` (id)
- FK (app_id) → `apps` (id)

### `storefront_access_tokens` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `app_id` | bigint unsigned | yes |  |  |  |
| `title` | varchar(120) |  |  |  |  |
| `token_hash` | char(64) |  |  | UQ |  |
| `token_hint` | varchar(12) |  |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `last_used_at` | datetime | yes |  |  |  |
| `revoked_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_storefront_access_tokens_shop` (shop_id, revoked_at)
- PK `PRIMARY` (id)
- UQ `uq_storefront_access_tokens_hash` (token_hash)

### `webhook_deliveries`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `subscription_id` | bigint unsigned |  |  |  |  |
| `event_id` | bigint unsigned |  |  |  |  |
| `event_uuid` | char(36) |  |  |  |  |
| `topic` | varchar(80) |  |  |  |  |
| `attempt` | smallint unsigned |  |  |  |  |
| `status` | enum('succeeded','failed') |  |  |  |  |
| `response_status` | smallint unsigned | yes |  |  |  |
| `response_body` | varchar(1024) | yes |  |  |  |
| `error` | varchar(500) | yes |  |  |  |
| `duration_ms` | int unsigned |  | `0` |  |  |
| `created_at` | datetime(3) |  | `CURRENT_TIMESTAMP(3)` | IX | DEFAULT_GENERATED |

- IX `ix_webhook_deliveries_created` (created_at)
- IX `ix_webhook_deliveries_event` (shop_id, event_id)
- IX `ix_webhook_deliveries_subscription` (shop_id, subscription_id, created_at)
- PK `PRIMARY` (id)
- FK (shop_id, subscription_id) → `webhook_subscriptions` (shop_id, id)

### `webhook_subscriptions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  |  |  |  |
| `app_id` | bigint unsigned | yes |  |  |  |
| `topic` | varchar(80) |  |  |  |  |
| `address` | varchar(1000) |  |  |  |  |
| `api_version` | varchar(10) |  |  |  |  |
| `include_fields` | json | yes |  |  |  |
| `secret_ciphertext` | text | yes |  |  |  |
| `status` | enum('active','disabled') |  | `active` |  |  |
| `disabled_reason` | varchar(255) | yes |  |  |  |
| `consecutive_failures` | int unsigned |  | `0` |  |  |
| `failing_since` | datetime | yes |  |  |  |
| `last_success_at` | datetime | yes |  |  |  |
| `last_failure_at` | datetime | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `address_hash` | char(64) | yes |  |  | STORED GENERATED |
| `owner_key` | bigint unsigned | yes |  |  | STORED GENERATED |

- IX `ix_webhook_subscriptions_app` (shop_id, app_id)
- IX `ix_webhook_subscriptions_topic` (shop_id, topic, status)
- PK `PRIMARY` (id)
- UQ `uq_webhook_subscriptions_public_id` (shop_id, public_id)
- UQ `uq_webhook_subscriptions_target` (shop_id, owner_key, topic, address_hash)
- UQ `uq_webhook_subscriptions_tenant` (shop_id, id)

## Catalogue

### `adverse_events`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `reference` | varchar(20) |  |  |  |  |
| `ticket_id` | bigint unsigned | yes |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `product_id` | bigint unsigned | yes |  | IX |  |
| `variant_id` | bigint unsigned | yes |  | IX |  |
| `batch_number` | varchar(40) | yes |  |  |  |
| `batch_id` | bigint unsigned | yes |  | IX |  |
| `purchase_source` | enum('veylor_website','amazon','nykaa','flipkart','retail','gift','sample','unknown') |  | `unknown` |  |  |
| `purchase_date` | date | yes |  |  |  |
| `first_use_date` | date | yes |  |  |  |
| `onset_date` | date | yes |  |  |  |
| `symptoms` | text |  |  |  |  |
| `affected_area` | varchar(191) | yes |  |  |  |
| `severity` | enum('mild','moderate','severe','unknown') |  | `unknown` |  |  |
| `is_ongoing` | tinyint unsigned |  | `1` |  |  |
| `stopped_use` | tinyint unsigned |  | `0` |  |  |
| `medical_attention_sought` | tinyint unsigned |  | `0` |  |  |
| `concomitant_products` | text | yes |  |  |  |
| `known_allergies` | text | yes |  |  |  |
| `consent_to_contact` | tinyint unsigned |  | `0` |  |  |
| `consent_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('reported','under_review','contacted','escalated','closed','reported_to_regulator') |  | `reported` |  |  |
| `reviewed_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `reviewed_at` | datetime | yes |  |  |  |
| `outcome_note` | text | yes |  |  |  |
| `regulatory_reported_at` | datetime | yes |  |  |  |
| `regulatory_reference` | varchar(80) | yes |  |  |  |
| `reported_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_adverse_events_batch` (batch_id)
- IX `fk_adverse_events_consent` (consent_id)
- IX `fk_adverse_events_customer` (customer_id)
- IX `fk_adverse_events_order` (order_id)
- IX `fk_adverse_events_reviewer` (reviewed_by_admin_id)
- IX `fk_adverse_events_ticket` (ticket_id)
- IX `fk_adverse_events_variant` (variant_id)
- IX `ix_adverse_events_batch` (shop_id, batch_number)
- IX `ix_adverse_events_product` (product_id, reported_at)
- IX `ix_adverse_events_status` (shop_id, status, severity)
- PK `PRIMARY` (id)
- UQ `uq_adverse_events_reference` (shop_id, reference)
- FK (batch_id) → `product_batches` (id)
- FK (consent_id) → `customer_consents` (id)
- FK (customer_id) → `customers` (id)
- FK (order_id) → `orders` (id)
- FK (product_id) → `products` (id)
- FK (reviewed_by_admin_id) → `admin_users` (id)
- FK (ticket_id) → `support_tickets` (id)
- FK (variant_id) → `product_variants` (id)

### `brands`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | text | yes |  |  |  |
| `logo_media_id` | bigint unsigned | yes |  | IX |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_brands_logo` (logo_media_id)
- PK `PRIMARY` (id)
- UQ `uq_brands_slug` (shop_id, slug)
- FK (logo_media_id) → `media` (id)

### `bundle_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `bundle_product_id` | bigint unsigned |  |  | IX |  |
| `component_variant_id` | bigint unsigned |  |  | IX |  |
| `quantity` | smallint unsigned |  | `1` |  |  |
| `allocated_price` | decimal(10,2) | yes |  |  |  |
| `is_optional` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_bundle_items_bundle_t` (shop_id, bundle_product_id)
- IX `fk_bundle_items_component_t` (shop_id, component_variant_id)
- IX `ix_bundle_items_component` (component_variant_id)
- IX `ix_bundle_items_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_bundle_items` (bundle_product_id, component_variant_id)
- FK (shop_id, bundle_product_id) → `products` (shop_id, id)
- FK (shop_id, component_variant_id) → `product_variants` (shop_id, id)

### `categories`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `parent_id` | bigint unsigned | yes |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `short_description` | varchar(500) | yes |  |  |  |
| `description` | text | yes |  |  |  |
| `banner_media_id` | bigint unsigned | yes |  | IX |  |
| `thumbnail_media_id` | bigint unsigned | yes |  | IX |  |
| `path` | varchar(500) |  | `` |  |  |
| `depth` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `show_in_menu` | tinyint unsigned |  | `1` |  |  |
| `product_count` | int unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_categories_banner` (banner_media_id)
- IX `fk_categories_thumbnail` (thumbnail_media_id)
- IX `ix_categories_active` (shop_id, is_active, deleted_at)
- IX `ix_categories_parent` (parent_id, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_categories_slug` (shop_id, slug)
- UQ `uq_categories_tenant` (shop_id, id)
- FK (banner_media_id) → `media` (id)
- FK (parent_id) → `categories` (id)
- FK (thumbnail_media_id) → `media` (id)

### `claim_evidence`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `claim_id` | bigint unsigned |  |  | IX |  |
| `evidence_type` | enum('clinical','consumer_perception','in_vitro','instrumental','ingredient_literature','certification','stability','safety') |  |  |  |  |
| `method` | text | yes |  |  |  |
| `endpoint` | varchar(255) | yes |  |  |  |
| `duration` | varchar(80) | yes |  |  |  |
| `sample_size` | int unsigned | yes |  |  |  |
| `result_summary` | text | yes |  |  |  |
| `source` | varchar(500) | yes |  |  |  |
| `document_media_id` | bigint unsigned | yes |  | IX |  |
| `verified_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `verified_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_claim_evidence_claim_t` (shop_id, claim_id)
- IX `fk_claim_evidence_document` (document_media_id)
- IX `fk_claim_evidence_verifier` (verified_by_admin_id)
- IX `ix_claim_evidence_claim` (claim_id)
- IX `ix_claim_evidence_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (shop_id, claim_id) → `claims` (shop_id, id)
- FK (document_media_id) → `media` (id)
- FK (verified_by_admin_id) → `admin_users` (id)

### `claims`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `claim_text` | varchar(500) |  |  |  |  |
| `claim_type` | enum('brand_promise','product_benefit','ingredient_role','evidence_stat','safety','certification') |  | `product_benefit` |  |  |
| `status` | enum('draft','under_review','approved','rejected','retired') |  | `draft` |  |  |
| `footnote` | varchar(500) | yes |  |  |  |
| `permitted_placements` | set('pdp','home','collection','ads','packaging','email','sms','whatsapp','social','pr') | yes |  |  |  |
| `qualifier` | varchar(255) | yes |  |  |  |
| `legal_reference` | varchar(255) | yes |  |  |  |
| `approved_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `approved_at` | datetime | yes |  |  |  |
| `review_due_at` | date | yes |  |  |  |
| `retired_at` | datetime | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_claims_approver` (approved_by_admin_id)
- IX `fk_claims_creator` (created_by_admin_id)
- IX `ix_claims_status` (shop_id, status, review_due_at)
- PK `PRIMARY` (id)
- UQ `uq_claims_tenant` (shop_id, id)
- FK (approved_by_admin_id) → `admin_users` (id)
- FK (created_by_admin_id) → `admin_users` (id)

### `collection_products`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `collection_id` | bigint unsigned |  |  | PK |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `position` | smallint unsigned |  | `0` |  |  |
| `is_pinned` | tinyint unsigned |  | `0` |  |  |
| `added_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_collection_products_collection_t` (shop_id, collection_id)
- IX `fk_collection_products_product_t` (shop_id, product_id)
- IX `ix_collection_products_position` (collection_id, position)
- IX `ix_collection_products_product` (product_id)
- IX `ix_collection_products_shop` (shop_id)
- PK `PRIMARY` (collection_id, product_id)
- FK (shop_id, collection_id) → `collections` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `collection_rules`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `collection_id` | bigint unsigned |  |  | IX |  |
| `field` | enum('title','tag','category','brand','price','compare_at_price','inventory_quantity','skin_type','concern','is_new','is_bestseller','rating','created_at') |  |  |  |  |
| `operator` | enum('equals','not_equals','contains','not_contains','starts_with','ends_with','greater_than','less_than','is_set','is_not_set') |  |  |  |  |
| `value` | varchar(255) | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_collection_rules_collection_t` (shop_id, collection_id)
- IX `ix_collection_rules_collection` (collection_id, sort_order)
- IX `ix_collection_rules_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (shop_id, collection_id) → `collections` (shop_id, id)

### `collections`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `title` | varchar(160) |  |  |  |  |
| `subtitle` | varchar(255) | yes |  |  |  |
| `description` | text | yes |  |  |  |
| `meta_title` | varchar(191) | yes |  |  |  |
| `meta_description` | varchar(320) | yes |  |  |  |
| `collection_type` | enum('manual','automatic') |  | `manual` |  |  |
| `match_condition` | enum('all','any') |  | `all` |  |  |
| `sort_type` | enum('manual','best_selling','newest','price_asc','price_desc','title_asc','rating_desc') |  | `manual` |  |  |
| `template_suffix` | varchar(60) | yes |  |  |  |
| `image_media_id` | bigint unsigned | yes |  | IX |  |
| `banner_media_id` | bigint unsigned | yes |  | IX |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `show_in_menu` | tinyint unsigned |  | `0` |  |  |
| `product_count` | int unsigned |  | `0` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_collections_banner` (banner_media_id)
- IX `fk_collections_image` (image_media_id)
- IX `ix_collections_active` (shop_id, is_active, published_at)
- PK `PRIMARY` (id)
- UQ `uq_collections_slug` (shop_id, slug)
- UQ `uq_collections_tenant` (shop_id, id)
- FK (banner_media_id) → `media` (id)
- FK (image_media_id) → `media` (id)

### `ingredient_compatibility`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `ingredient_id` | bigint unsigned |  |  | PK |  |
| `other_ingredient_id` | bigint unsigned |  |  | PK |  |
| `level` | enum('works_with','use_caution','avoid') |  |  |  |  |
| `note` | varchar(500) | yes |  |  |  |
| `reviewed_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `reviewed_at` | datetime | yes |  |  |  |

- IX `fk_ingredient_compat_a_t` (shop_id, ingredient_id)
- IX `fk_ingredient_compat_b_t` (shop_id, other_ingredient_id)
- IX `fk_ingredient_compat_reviewer` (reviewed_by_admin_id)
- IX `ix_ingredient_compat_other` (other_ingredient_id)
- IX `ix_ingredient_compatibility_shop` (shop_id)
- PK `PRIMARY` (ingredient_id, other_ingredient_id)
- FK (shop_id, ingredient_id) → `ingredients` (shop_id, id)
- FK (shop_id, other_ingredient_id) → `ingredients` (shop_id, id)
- FK (reviewed_by_admin_id) → `admin_users` (id)

### `ingredients`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `name` | varchar(140) |  |  | IX |  |
| `inci_name` | varchar(191) | yes |  |  |  |
| `scientific_name` | varchar(191) | yes |  |  |  |
| `origin` | varchar(191) | yes |  |  |  |
| `ingredient_class` | enum('active','botanical','humectant','emollient','occlusive','antioxidant','peptide','exfoliant','surfactant','preservative','uv_filter','other') |  | `active` |  |  |
| `benefit_summary` | varchar(500) | yes |  |  |  |
| `description` | longtext | yes |  |  |  |
| `evidence_note` | text | yes |  |  |  |
| `caution_note` | text | yes |  |  |  |
| `image_media_id` | bigint unsigned | yes |  | IX |  |
| `is_key_active` | tinyint unsigned |  | `0` |  |  |
| `show_in_library` | tinyint unsigned |  | `1` |  |  |
| `status` | enum('draft','published','archived') |  | `draft` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_ingredients_image` (image_media_id)
- IX `ft_ingredients_search` (name, inci_name, benefit_summary)
- IX `ix_ingredients_status` (shop_id, status, show_in_library)
- PK `PRIMARY` (id)
- UQ `uq_ingredients_slug` (shop_id, slug)
- UQ `uq_ingredients_tenant` (shop_id, id)
- FK (image_media_id) → `media` (id)

### `lookup_categories`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `code` | varchar(100) |  |  |  | Unique identifier: benefits, skin_types, etc |
| `name` | varchar(191) |  |  |  | Display name for admin UI |
| `description` | text | yes |  |  | What this lookup is for |
| `is_active` | tinyint(1) |  | `1` |  |  |
| `allow_custom` | tinyint(1) |  | `0` |  | Allow users to add custom values |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- UQ `code` (shop_id, code)
- IX `idx_active` (shop_id, is_active)
- IX `idx_code` (shop_id, code)
- PK `PRIMARY` (id)
- UQ `uq_lookup_categories_tenant` (shop_id, id)

### `lookup_value_audit`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `lookup_value_id` | bigint unsigned |  |  |  |  |
| `action` | enum('created','updated','deleted','activated','deactivated') |  |  |  |  |
| `old_data` | json | yes |  |  |  |
| `new_data` | json | yes |  |  |  |
| `admin_user_id` | bigint unsigned | yes |  |  |  |
| `admin_name` | varchar(191) | yes |  |  |  |
| `ip_address` | varchar(45) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `idx_created_at` (shop_id, created_at)
- IX `idx_lookup_value` (shop_id, lookup_value_id)
- PK `PRIMARY` (id)

### `lookup_values`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `category_id` | bigint unsigned |  |  | IX |  |
| `code` | varchar(100) |  |  |  | Unique value identifier within category |
| `label` | varchar(191) |  |  |  | Display text |
| `description` | text | yes |  |  | Helper text or tooltip |
| `icon` | varchar(191) | yes |  |  | Icon name or URL |
| `color` | varchar(20) | yes |  |  | Badge/chip color |
| `metadata` | json | yes |  |  | Additional attributes |
| `is_active` | tinyint(1) |  | `1` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `idx_category_active` (category_id, is_active)
- IX `idx_sort` (category_id, sort_order)
- IX `ix_lookup_values_shop` (shop_id)
- IX `lookup_values_ibfk_1_t` (shop_id, category_id)
- PK `PRIMARY` (id)
- UQ `uniq_category_code` (category_id, code)
- FK (shop_id, category_id) → `lookup_categories` (shop_id, id)

### `metafield_definitions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `owner_type` | varchar(40) |  |  |  |  |
| `namespace` | varchar(50) |  | `veylor` |  |  |
| `meta_key` | varchar(60) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `value_type` | enum('single_line_text','multi_line_text','rich_text','integer','decimal','boolean','date','datetime','json','url','color','media','media_list','product_ref','collection_ref','entry_ref') |  | `single_line_text` |  |  |
| `validations` | json | yes |  |  |  |
| `is_required` | tinyint unsigned |  | `0` |  |  |
| `is_public` | tinyint unsigned |  | `1` |  |  |
| `is_filterable` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_metafield_definitions` (shop_id, owner_type, namespace, meta_key)

### `metafields`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `definition_id` | bigint unsigned | yes |  | IX |  |
| `owner_type` | varchar(40) |  |  |  |  |
| `owner_id` | bigint unsigned |  |  |  |  |
| `namespace` | varchar(50) |  | `veylor` |  |  |
| `meta_key` | varchar(60) |  |  |  |  |
| `locale` | varchar(10) |  | `en-IN` |  |  |
| `value_text` | longtext | yes |  |  |  |
| `value_number` | decimal(20,6) | yes |  |  |  |
| `value_boolean` | tinyint unsigned | yes |  |  |  |
| `value_datetime` | datetime | yes |  |  |  |
| `value_json` | json | yes |  |  |  |
| `value_media_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_metafields_definition` (definition_id)
- IX `fk_metafields_media` (value_media_id)
- IX `ix_metafields_key_number` (shop_id, namespace, meta_key, value_number)
- IX `ix_metafields_owner` (shop_id, owner_type, owner_id)
- PK `PRIMARY` (id)
- UQ `uq_metafields` (shop_id, owner_type, owner_id, namespace, meta_key, locale)
- FK (definition_id) → `metafield_definitions` (id)
- FK (value_media_id) → `media` (id)

### `product_batches`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | IX |  |
| `batch_number` | varchar(40) |  |  |  |  |
| `manufactured_on` | date | yes |  |  |  |
| `expires_on` | date | yes |  |  |  |
| `best_before_on` | date | yes |  |  |  |
| `quantity_received` | int unsigned |  | `0` |  |  |
| `quantity_remaining` | int unsigned |  | `0` |  |  |
| `supplier_name` | varchar(191) | yes |  |  |  |
| `manufacturing_site` | varchar(255) | yes |  |  |  |
| `coa_media_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('active','quarantined','recalled','depleted','expired') |  | `active` |  |  |
| `notes` | text | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_product_batches_coa` (coa_media_id)
- IX `fk_product_batches_variant_t` (shop_id, variant_id)
- IX `ix_product_batches_expiry` (shop_id, expires_on, status)
- PK `PRIMARY` (id)
- UQ `uq_product_batches` (variant_id, batch_number)
- FK (coa_media_id) → `media` (id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

### `product_benefits`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `benefit` | varchar(255) |  |  |  |  |
| `detail` | text | yes |  |  |  |
| `benefit_kind` | enum('immediate','long_term','sensorial') |  | `long_term` |  |  |
| `icon_media_id` | bigint unsigned | yes |  | IX |  |
| `claim_id` | bigint unsigned | yes |  | IX |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_product_benefits_claim` (claim_id)
- IX `fk_product_benefits_icon` (icon_media_id)
- IX `fk_product_benefits_product_t` (shop_id, product_id)
- IX `ix_product_benefits_product` (product_id, sort_order)
- IX `ix_product_benefits_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (claim_id) → `claims` (id)
- FK (icon_media_id) → `media` (id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `product_claims`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `claim_id` | bigint unsigned |  |  | PK |  |
| `placement` | enum('hero','benefit_list','evidence_block','footnote','badge') |  | `benefit_list` | PK |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_product_claims_claim_t` (shop_id, claim_id)
- IX `fk_product_claims_product_t` (shop_id, product_id)
- IX `ix_product_claims_claim` (claim_id)
- IX `ix_product_claims_shop` (shop_id)
- PK `PRIMARY` (product_id, claim_id, placement)
- FK (shop_id, claim_id) → `claims` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `product_concerns`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `concern_id` | bigint unsigned |  |  | PK |  |
| `is_primary` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_product_concerns_concern_t` (shop_id, concern_id)
- IX `fk_product_concerns_product_t` (shop_id, product_id)
- IX `ix_product_concerns_concern` (concern_id, is_primary)
- IX `ix_product_concerns_shop` (shop_id)
- PK `PRIMARY` (product_id, concern_id)
- FK (shop_id, concern_id) → `skin_concerns` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `product_ingredients`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `ingredient_id` | bigint unsigned |  |  | IX |  |
| `role` | varchar(191) | yes |  |  |  |
| `concentration` | varchar(20) | yes |  |  |  |
| `is_key` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_product_ingredients_ingredient_t` (shop_id, ingredient_id)
- IX `fk_product_ingredients_product_t` (shop_id, product_id)
- IX `ix_product_ingredients_ingredient` (ingredient_id)
- IX `ix_product_ingredients_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_product_ingredients` (product_id, ingredient_id)
- FK (shop_id, ingredient_id) → `ingredients` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `product_option_values`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `option_id` | bigint unsigned |  |  | IX |  |
| `value` | varchar(80) |  |  |  |  |
| `descriptor` | varchar(160) | yes |  |  | shimmery apricot |
| `badge` | varchar(40) | yes |  |  | limited edition, new |
| `description` | varchar(500) | yes |  |  | longer note shown in the shade dropdown |
| `swatch_hex` | char(7) | yes |  |  |  |
| `swatch_media_id` | bigint unsigned | yes |  | IX |  |
| `position` | tinyint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- IX `fk_product_option_values_option_t` (shop_id, option_id)
- IX `fk_product_option_values_swatch` (swatch_media_id)
- IX `ix_product_option_values_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_product_option_values` (option_id, value)
- UQ `uq_product_option_values_tenant` (shop_id, id)
- FK (shop_id, option_id) → `product_options` (shop_id, id)
- FK (swatch_media_id) → `media` (id)

### `product_options`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(50) |  |  |  |  |
| `display_type` | enum('dropdown','pill','swatch') |  | `pill` |  |  |
| `position` | tinyint unsigned |  | `0` |  |  |

- IX `fk_product_options_product_t` (shop_id, product_id)
- IX `ix_product_options_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_product_options` (product_id, name)
- UQ `uq_product_options_tenant` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `product_related`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `related_product_id` | bigint unsigned |  |  | PK |  |
| `relation_type` | enum('routine_pairing','cross_sell','upsell','frequently_bought','alternative','refill') |  | `cross_sell` | PK |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_product_related_product_t` (shop_id, product_id)
- IX `fk_product_related_target_t` (shop_id, related_product_id)
- IX `ix_product_related_shop` (shop_id)
- IX `ix_product_related_target` (related_product_id)
- PK `PRIMARY` (product_id, related_product_id, relation_type)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (shop_id, related_product_id) → `products` (shop_id, id)

### `product_skin_types`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `skin_type_id` | bigint unsigned |  |  | PK |  |

- IX `fk_product_skin_types_product_t` (shop_id, product_id)
- IX `fk_product_skin_types_type_t` (shop_id, skin_type_id)
- IX `ix_product_skin_types_shop` (shop_id)
- IX `ix_product_skin_types_type` (skin_type_id)
- PK `PRIMARY` (product_id, skin_type_id)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (shop_id, skin_type_id) → `skin_types` (shop_id, id)

### `product_usage_steps`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `step_no` | tinyint unsigned |  |  |  |  |
| `instruction` | varchar(500) |  |  |  |  |
| `time_of_day` | enum('AM','PM','BOTH') |  | `BOTH` |  |  |
| `frequency` | varchar(80) | yes |  |  |  |
| `amount` | varchar(80) | yes |  |  |  |
| `media_id` | bigint unsigned | yes |  | IX |  |

- IX `fk_product_usage_steps_media` (media_id)
- IX `fk_product_usage_steps_product_t` (shop_id, product_id)
- IX `ix_product_usage_steps_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_product_usage_steps` (product_id, step_no)
- FK (media_id) → `media` (id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `product_variants`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `product_id` | bigint unsigned |  |  | IX |  |
| `sku` | varchar(64) |  |  |  |  |
| `barcode` | varchar(64) | yes |  |  |  |
| `variant_title` | varchar(160) | yes |  |  |  |
| `net_quantity` | varchar(40) | yes |  |  |  |
| `size_description` | varchar(255) | yes |  |  | how much is in it, in words |
| `volume_ml` | decimal(8,2) | yes |  |  |  |
| `weight_grams` | int unsigned | yes |  |  |  |
| `length_mm` | smallint unsigned | yes |  |  |  |
| `width_mm` | smallint unsigned | yes |  |  |  |
| `height_mm` | smallint unsigned | yes |  |  |  |
| `mrp` | decimal(10,2) |  |  |  |  |
| `price` | decimal(10,2) |  |  |  |  |
| `cost_price` | decimal(10,2) | yes |  |  |  |
| `sale_starts_at` | datetime | yes |  |  |  |
| `sale_ends_at` | datetime | yes |  |  |  |
| `tax_class_id` | bigint unsigned | yes |  | IX |  |
| `position` | smallint unsigned |  | `0` |  |  |
| `is_default` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('active','archived') |  | `active` |  |  |
| `track_inventory` | tinyint unsigned |  | `1` |  |  |
| `allow_backorder` | tinyint unsigned |  | `0` |  |  |
| `low_stock_threshold` | int unsigned |  | `5` |  |  |
| `max_per_order` | smallint unsigned |  | `10` |  |  |
| `image_media_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_product_variants_image` (image_media_id)
- IX `fk_product_variants_product_t` (shop_id, product_id)
- IX `fk_product_variants_tax_class` (tax_class_id)
- IX `ix_product_variants_product` (product_id, position)
- IX `ix_product_variants_status` (shop_id, status, deleted_at)
- PK `PRIMARY` (id)
- UQ `uq_product_variants_public_id` (shop_id, public_id)
- UQ `uq_product_variants_sku` (shop_id, sku)
- UQ `uq_product_variants_tenant` (shop_id, id)
- FK (image_media_id) → `media` (id)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (tax_class_id) → `tax_classes` (id)

### `product_views`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `session_token` | char(36) | yes |  |  |  |
| `source` | varchar(60) | yes |  |  |  |
| `viewed_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_product_views_product_t` (shop_id, product_id)
- IX `ix_product_views_customer` (customer_id, viewed_at)
- IX `ix_product_views_product` (product_id, viewed_at)
- IX `ix_product_views_session` (shop_id, session_token, viewed_at)
- PK `PRIMARY` (id)
- FK (customer_id) → `customers` (id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `products`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `slug` | varchar(191) |  |  |  |  |
| `name` | varchar(191) |  |  | IX |  |
| `subtitle` | varchar(255) | yes |  |  |  |
| `category_id` | bigint unsigned | yes |  | IX |  |
| `brand_id` | bigint unsigned | yes |  | IX |  |
| `product_type` | enum('simple','variable','bundle','kit','gift_card') |  | `simple` |  |  |
| `status` | enum('draft','in_review','active','archived') |  | `draft` |  |  |
| `visibility` | enum('public','hidden','search_only') |  | `public` |  |  |
| `template_suffix` | varchar(60) | yes |  |  |  |
| `short_description` | varchar(500) | yes |  |  |  |
| `description` | longtext | yes |  |  |  |
| `description_json` | json | yes |  |  |  |
| `texture` | varchar(255) | yes |  |  |  |
| `scent` | varchar(120) | yes |  |  |  |
| `fragrance_disclosure` | varchar(255) | yes |  |  |  |
| `suitability_note` | text | yes |  |  |  |
| `benefits` | json | yes |  |  | Array of benefit tags |
| `skin_types` | json | yes |  |  | Array of suitable skin types |
| `skin_concerns` | json | yes |  |  | Array of addressed skin concerns |
| `finish` | varchar(50) | yes |  |  | Product finish type |
| `coverage` | enum('sheer','light','medium','full','buildable') | yes |  |  | Coverage level for makeup |
| `shade_family` | varchar(100) | yes |  |  | Color family (e.g., Warm, Cool, Neutral) |
| `contraindications` | text | yes |  |  |  |
| `patch_test_note` | varchar(500) | yes |  |  |  |
| `routine_position` | enum('cleanse','treat','hydrate','protect','mask','none') |  | `none` |  |  |
| `time_of_day` | enum('AM','PM','BOTH') |  | `BOTH` |  |  |
| `full_inci` | longtext | yes |  |  |  |
| `key_ingredients` | json | yes |  |  | Array of key active ingredients with percentages |
| `ingredient_highlights` | varchar(500) | yes |  |  | Marketing description of key ingredients |
| `free_from` | json | yes |  |  | Array of excluded ingredients/categories |
| `formulation_type` | varchar(80) | yes |  |  | Physical form of product |
| `ph_level` | varchar(20) | yes |  |  | pH range (e.g., 5.0-6.0) |
| `certifications` | json | yes |  |  | Array of product certifications |
| `claims` | json | yes |  |  | Array of product claims |
| `is_hypoallergenic` | tinyint(1) |  | `0` |  | Hypoallergenic formulation |
| `is_non_comedogenic` | tinyint(1) |  | `0` |  | Non-pore-clogging |
| `pregnancy_safe` | enum('safe','consult_doctor','not_recommended') | yes |  |  | Safety during pregnancy |
| `inci_approved_at` | datetime | yes |  |  |  |
| `inci_approved_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `manufacturer_name` | varchar(255) | yes |  |  |  |
| `manufacturer_address` | varchar(500) | yes |  |  |  |
| `marketed_by_name` | varchar(255) | yes |  |  |  |
| `marketed_by_address` | varchar(500) | yes |  |  |  |
| `manufacturing_licence_no` | varchar(80) | yes |  |  |  |
| `country_of_origin` | varchar(80) |  | `India` |  |  |
| `customer_care_contact` | varchar(255) | yes |  |  |  |
| `shelf_life_months` | smallint unsigned | yes |  |  |  |
| `pao_months` | smallint unsigned | yes |  |  |  |
| `storage_instructions` | varchar(500) | yes |  |  |  |
| `usage_instructions` | text | yes |  |  | Step-by-step usage guide |
| `application_method` | varchar(255) | yes |  |  | Recommended application tools/methods |
| `usage_frequency` | varchar(100) | yes |  |  | Recommended frequency of use |
| `best_used_with` | json | yes |  |  | Array of complementary product IDs |
| `results_timeline` | varchar(150) | yes |  |  | Expected time to see results |
| `clinical_study_summary` | text | yes |  |  | Summary of clinical studies/trials |
| `has_before_after_study` | tinyint(1) |  | `0` |  | Has before/after imagery |
| `texture_description` | varchar(500) | yes |  |  | Detailed texture description |
| `color_description` | varchar(255) | yes |  |  | Visual appearance description |
| `absorption_rate` | enum('instant','fast','medium','slow') | yes |  |  | How quickly product absorbs |
| `feel_on_skin` | varchar(255) | yes |  |  | Sensory experience (e.g., lightweight, rich) |
| `packaging_type` | varchar(100) | yes |  |  | Primary packaging format |
| `packaging_material` | varchar(255) | yes |  |  | Packaging materials used |
| `is_recyclable` | tinyint(1) |  | `0` |  | Packaging is recyclable |
| `is_refillable` | tinyint(1) |  | `0` |  | Product has refill option |
| `is_eco_friendly` | tinyint(1) |  | `0` |  | Environmentally friendly product |
| `is_carbon_neutral` | tinyint(1) |  | `0` |  | Carbon neutral production/shipping |
| `size_category` | enum('sample','travel','standard','deluxe','professional','value') | yes |  |  | Size classification |
| `is_professional_use` | tinyint(1) |  | `0` |  | For professional/salon use only |
| `requires_training` | tinyint(1) |  | `0` |  | Requires professional training |
| `regulatory_approvals` | json | yes |  |  | Countries/regions where approved |
| `restricted_regions` | json | yes |  |  | Countries/regions where restricted |
| `awards` | json | yes |  |  | Array of awards received |
| `press_features` | json | yes |  |  | Array of press mentions |
| `age_range` | varchar(50) | yes |  |  | Target age range (e.g., 25-35, 40+) |
| `gender_target` | enum('unisex','female','male','non_binary') |  | `unisex` |  | Target gender demographic |
| `is_seasonal` | tinyint(1) |  | `0` |  | Seasonal availability |
| `season` | enum('spring','summer','fall','winter','all_year') | yes |  |  | Best season for use |
| `is_limited_edition` | tinyint(1) |  | `0` |  | Limited edition product |
| `is_sample` | tinyint(1) |  | `0` |  | Sample/trial size product |
| `sample_of_product_id` | bigint unsigned | yes |  | IX | Full-size product reference |
| `tutorial_video_url` | varchar(500) | yes |  |  | How-to video URL |
| `demo_video_url` | varchar(500) | yes |  |  | Product demo video URL |
| `disposal_instructions` | varchar(500) | yes |  |  |  |
| `is_new` | tinyint unsigned |  | `0` |  |  |
| `is_bestseller` | tinyint unsigned |  | `0` |  |  |
| `badge` | varchar(60) | yes |  |  |  |
| `badge_expires_at` | datetime | yes |  |  |  |
| `rating_average` | decimal(3,2) |  | `0.00` |  |  |
| `rating_count` | int unsigned |  | `0` |  |  |
| `review_count` | int unsigned |  | `0` |  |  |
| `total_sold` | int unsigned |  | `0` |  |  |
| `view_count` | int unsigned |  | `0` |  |  |
| `min_price` | decimal(10,2) | yes |  |  |  |
| `max_price` | decimal(10,2) | yes |  |  |  |
| `in_stock` | tinyint unsigned |  | `0` |  |  |
| `tax_class_id` | bigint unsigned | yes |  | IX |  |
| `default_variant_id` | bigint unsigned | yes |  | IX |  |
| `requires_shipping` | tinyint unsigned |  | `1` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `updated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |
| `is_gift_card` | tinyint unsigned |  | `0` |  |  |

- IX `fk_products_created_by` (created_by_admin_id)
- IX `fk_products_default_variant` (default_variant_id)
- IX `fk_products_inci_approver` (inci_approved_by_admin_id)
- IX `fk_products_sample_of` (sample_of_product_id)
- IX `fk_products_tax_class` (tax_class_id)
- IX `fk_products_updated_by` (updated_by_admin_id)
- IX `ft_products_search` (name, subtitle, short_description)
- IX `idx_products_coverage` (shop_id, coverage)
- IX `idx_products_finish` (shop_id, finish)
- IX `idx_products_formulation_type` (shop_id, formulation_type)
- IX `idx_products_is_eco_friendly` (shop_id, is_eco_friendly)
- IX `idx_products_is_hypoallergenic` (shop_id, is_hypoallergenic)
- IX `idx_products_is_limited_edition` (shop_id, is_limited_edition)
- IX `idx_products_is_non_comedogenic` (shop_id, is_non_comedogenic)
- IX `idx_products_is_professional_use` (shop_id, is_professional_use)
- IX `idx_products_is_refillable` (shop_id, is_refillable)
- IX `idx_products_is_seasonal` (shop_id, is_seasonal)
- IX `ix_products_brand` (brand_id)
- IX `ix_products_category` (category_id, status)
- IX `ix_products_merch` (shop_id, is_bestseller, is_new, sort_order)
- IX `ix_products_price` (shop_id, min_price)
- IX `ix_products_status` (shop_id, status, visibility, published_at)
- PK `PRIMARY` (id)
- UQ `uq_products_public_id` (shop_id, public_id)
- UQ `uq_products_slug` (shop_id, slug)
- UQ `uq_products_tenant` (shop_id, id)
- FK (brand_id) → `brands` (id)
- FK (category_id) → `categories` (id)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (default_variant_id) → `product_variants` (id)
- FK (inci_approved_by_admin_id) → `admin_users` (id)
- FK (sample_of_product_id) → `products` (id)
- FK (tax_class_id) → `tax_classes` (id)
- FK (updated_by_admin_id) → `admin_users` (id)

### `quiz_options`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `question_id` | bigint unsigned |  |  | IX |  |
| `value_key` | varchar(60) |  |  |  |  |
| `label` | varchar(191) |  |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `icon_media_id` | bigint unsigned | yes |  | IX |  |
| `concern_id` | bigint unsigned | yes |  | IX |  |
| `skin_type_id` | bigint unsigned | yes |  | IX |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_quiz_options_concern` (concern_id)
- IX `fk_quiz_options_icon` (icon_media_id)
- IX `fk_quiz_options_question_t` (shop_id, question_id)
- IX `fk_quiz_options_skin_type` (skin_type_id)
- IX `ix_quiz_options_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_quiz_options` (question_id, value_key)
- FK (concern_id) → `skin_concerns` (id)
- FK (icon_media_id) → `media` (id)
- FK (shop_id, question_id) → `quiz_questions` (shop_id, id)
- FK (skin_type_id) → `skin_types` (id)

### `quiz_questions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `quiz_version_id` | bigint unsigned |  |  | IX |  |
| `step_no` | tinyint unsigned |  |  |  |  |
| `question_key` | varchar(60) |  |  |  |  |
| `question` | varchar(255) |  |  |  |  |
| `help_text` | varchar(500) | yes |  |  |  |
| `input_type` | enum('single','multi','scale','text') |  | `single` |  |  |
| `is_required` | tinyint unsigned |  | `1` |  |  |

- IX `fk_quiz_questions_version_t` (shop_id, quiz_version_id)
- IX `ix_quiz_questions_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_quiz_questions` (quiz_version_id, question_key)
- UQ `uq_quiz_questions_tenant` (shop_id, id)
- FK (shop_id, quiz_version_id) → `quiz_versions` (shop_id, id)

### `quiz_rules`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `quiz_version_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(160) |  |  |  |  |
| `condition_json` | json |  |  |  |  |
| `outcome` | enum('recommend','exclude','advise_professional') |  | `recommend` |  |  |
| `recommended_product_ids` | json | yes |  |  |  |
| `routine_id` | bigint unsigned | yes |  | IX |  |
| `rationale` | varchar(500) | yes |  |  |  |
| `caution_note` | varchar(500) | yes |  |  |  |
| `priority` | smallint unsigned |  | `100` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- IX `fk_quiz_rules_routine` (routine_id)
- IX `fk_quiz_rules_version_t` (shop_id, quiz_version_id)
- IX `ix_quiz_rules_shop` (shop_id)
- IX `ix_quiz_rules_version` (quiz_version_id, priority)
- PK `PRIMARY` (id)
- FK (routine_id) → `routines` (id)
- FK (shop_id, quiz_version_id) → `quiz_versions` (shop_id, id)

### `quiz_submissions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `quiz_version_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `session_token` | char(36) | yes |  |  |  |
| `answers` | json |  |  |  |  |
| `result_product_ids` | json | yes |  |  |  |
| `result_routine_id` | bigint unsigned | yes |  | IX |  |
| `matched_rule_ids` | json | yes |  |  |  |
| `consent_given` | tinyint unsigned |  | `0` |  |  |
| `consent_id` | bigint unsigned | yes |  | IX |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `converted_order_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `purge_after` | datetime | yes |  |  |  |

- IX `fk_quiz_submissions_consent` (consent_id)
- IX `fk_quiz_submissions_order` (converted_order_id)
- IX `fk_quiz_submissions_routine` (result_routine_id)
- IX `fk_quiz_submissions_version` (quiz_version_id)
- IX `fk_quiz_submissions_version_t` (shop_id, quiz_version_id)
- IX `ix_quiz_submissions_customer` (customer_id, created_at)
- IX `ix_quiz_submissions_purge` (shop_id, purge_after)
- PK `PRIMARY` (id)
- UQ `uq_quiz_submissions_public_id` (shop_id, public_id)
- FK (consent_id) → `customer_consents` (id)
- FK (customer_id) → `customers` (id)
- FK (converted_order_id) → `orders` (id)
- FK (result_routine_id) → `routines` (id)
- FK (shop_id, quiz_version_id) → `quiz_versions` (shop_id, id)

### `quiz_versions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `version` | varchar(20) |  |  |  |  |
| `name` | varchar(160) |  |  |  |  |
| `status` | enum('draft','in_review','published','retired') |  | `draft` |  |  |
| `disclaimer` | text | yes |  |  |  |
| `reviewed_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `reviewed_at` | datetime | yes |  |  |  |
| `published_at` | datetime | yes |  |  |  |
| `retention_days` | smallint unsigned |  | `365` |  |  |
| `notes` | text | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_quiz_versions_reviewer` (reviewed_by_admin_id)
- PK `PRIMARY` (id)
- UQ `uq_quiz_versions_tenant` (shop_id, id)
- UQ `uq_quiz_versions_version` (shop_id, version)
- FK (reviewed_by_admin_id) → `admin_users` (id)

### `routine_steps`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `routine_id` | bigint unsigned |  |  | IX |  |
| `step_no` | tinyint unsigned |  |  |  |  |
| `time_of_day` | enum('AM','PM','BOTH') |  | `BOTH` |  |  |
| `product_id` | bigint unsigned | yes |  | IX |  |
| `variant_id` | bigint unsigned | yes |  | IX |  |
| `title` | varchar(160) | yes |  |  |  |
| `instruction` | varchar(500) | yes |  |  |  |
| `wait_note` | varchar(120) | yes |  |  |  |

- IX `fk_routine_steps_product` (product_id)
- IX `fk_routine_steps_routine_t` (shop_id, routine_id)
- IX `fk_routine_steps_variant` (variant_id)
- IX `ix_routine_steps_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_routine_steps` (routine_id, time_of_day, step_no)
- FK (product_id) → `products` (id)
- FK (shop_id, routine_id) → `routines` (shop_id, id)
- FK (variant_id) → `product_variants` (id)

### `routines`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `name` | varchar(160) |  |  |  |  |
| `concern_id` | bigint unsigned | yes |  | IX |  |
| `description` | text | yes |  |  |  |
| `hero_media_id` | bigint unsigned | yes |  | IX |  |
| `bundle_product_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('draft','published','archived') |  | `draft` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_routines_bundle` (bundle_product_id)
- IX `fk_routines_hero` (hero_media_id)
- IX `ix_routines_concern` (concern_id)
- PK `PRIMARY` (id)
- UQ `uq_routines_slug` (shop_id, slug)
- UQ `uq_routines_tenant` (shop_id, id)
- FK (bundle_product_id) → `products` (id)
- FK (concern_id) → `skin_concerns` (id)
- FK (hero_media_id) → `media` (id)

### `search_queries`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `query` | varchar(191) |  |  |  |  |
| `normalized_query` | varchar(191) |  |  |  |  |
| `results_count` | int unsigned |  | `0` |  |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `session_token` | char(36) | yes |  |  |  |
| `clicked_product_id` | bigint unsigned | yes |  | IX |  |
| `converted` | tinyint unsigned |  | `0` |  |  |
| `device` | enum('mobile','tablet','desktop','unknown') |  | `unknown` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_search_queries_customer` (customer_id)
- IX `fk_search_queries_product` (clicked_product_id)
- IX `ix_search_queries_normalized` (shop_id, normalized_query, created_at)
- IX `ix_search_queries_zero` (shop_id, results_count, created_at)
- PK `PRIMARY` (id)
- FK (customer_id) → `customers` (id)
- FK (clicked_product_id) → `products` (id)

### `search_synonyms`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `term` | varchar(120) |  |  |  |  |
| `synonyms` | text |  |  |  |  |
| `match_type` | enum('synonym','typo','concept','redirect') |  | `synonym` |  |  |
| `redirect_url` | varchar(500) | yes |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_search_synonyms_term` (shop_id, term)

### `skin_concerns`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(60) |  |  |  |  |
| `name` | varchar(80) |  |  |  |  |
| `short_label` | varchar(80) | yes |  |  |  |
| `description` | text | yes |  |  |  |
| `icon_media_id` | bigint unsigned | yes |  | IX |  |
| `hero_media_id` | bigint unsigned | yes |  | IX |  |
| `has_landing_page` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- IX `fk_skin_concerns_hero` (hero_media_id)
- IX `fk_skin_concerns_icon` (icon_media_id)
- PK `PRIMARY` (id)
- UQ `uq_skin_concerns_slug` (shop_id, slug)
- UQ `uq_skin_concerns_tenant` (shop_id, id)
- FK (hero_media_id) → `media` (id)
- FK (icon_media_id) → `media` (id)

### `skin_types`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(60) |  |  |  |  |
| `name` | varchar(80) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `icon_media_id` | bigint unsigned | yes |  | IX |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- IX `fk_skin_types_icon` (icon_media_id)
- PK `PRIMARY` (id)
- UQ `uq_skin_types_slug` (shop_id, slug)
- UQ `uq_skin_types_tenant` (shop_id, id)
- FK (icon_media_id) → `media` (id)

### `taggables`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `tag_id` | bigint unsigned |  |  | PK |  |
| `taggable_type` | varchar(60) |  |  | PK |  |
| `taggable_id` | bigint unsigned |  |  | PK |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_taggables_tag_t` (shop_id, tag_id)
- IX `ix_taggables_owner` (shop_id, taggable_type, taggable_id)
- PK `PRIMARY` (tag_id, taggable_type, taggable_id)
- FK (shop_id, tag_id) → `tags` (shop_id, id)

### `tags`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(80) |  |  |  |  |
| `name` | varchar(80) |  |  |  |  |
| `tag_type` | enum('product','article','customer','general') |  | `general` |  |  |
| `usage_count` | int unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_tags_slug_type` (shop_id, tag_type, slug)
- UQ `uq_tags_tenant` (shop_id, id)

### `variant_option_values`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | PK |  |
| `option_id` | bigint unsigned |  |  | PK |  |
| `option_value_id` | bigint unsigned |  |  | IX |  |

- IX `fk_variant_option_values_option` (option_id)
- IX `fk_variant_option_values_option_t` (shop_id, option_id)
- IX `fk_variant_option_values_value_t` (shop_id, option_value_id)
- IX `fk_variant_option_values_variant_t` (shop_id, variant_id)
- IX `ix_variant_option_values_shop` (shop_id)
- IX `ix_variant_option_values_value` (option_value_id)
- PK `PRIMARY` (variant_id, option_id)
- FK (shop_id, option_id) → `product_options` (shop_id, id)
- FK (shop_id, option_value_id) → `product_option_values` (shop_id, id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

## Inventory and fulfilment

### `cod_rules`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `min_order_amount` | decimal(10,2) |  | `0.00` |  |  |
| `max_order_amount` | decimal(10,2) | yes |  |  |  |
| `cod_fee` | decimal(10,2) |  | `0.00` |  |  |
| `prepaid_discount_amount` | decimal(10,2) |  | `0.00` |  |  |
| `prepaid_discount_percent` | decimal(5,2) |  | `0.00` |  |  |
| `requires_otp_confirmation` | tinyint unsigned |  | `0` |  |  |
| `max_open_cod_orders` | tinyint unsigned |  | `2` |  |  |
| `block_if_rto_count_gte` | tinyint unsigned | yes |  |  |  |
| `blocked_pincodes` | json | yes |  |  |  |
| `blocked_categories` | json | yes |  |  |  |
| `priority` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_cod_rules_active` (shop_id, is_active, priority)
- PK `PRIMARY` (id)

### `inventory_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | IX |  |
| `location_id` | bigint unsigned |  |  | IX |  |
| `quantity_on_hand` | int |  | `0` |  |  |
| `quantity_reserved` | int |  | `0` |  |  |
| `quantity_incoming` | int |  | `0` |  |  |
| `quantity_available` | int | yes |  |  | STORED GENERATED |
| `safety_stock` | int |  | `0` |  |  |
| `bin_location` | varchar(60) | yes |  |  |  |
| `last_counted_at` | datetime | yes |  |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_inventory_items_location_t` (shop_id, location_id)
- IX `fk_inventory_items_variant_t` (shop_id, variant_id)
- IX `ix_inventory_items_available` (shop_id, quantity_available)
- IX `ix_inventory_items_location` (location_id)
- PK `PRIMARY` (id)
- UQ `uq_inventory_items` (variant_id, location_id)
- FK (shop_id, location_id) → `inventory_locations` (shop_id, id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

### `inventory_locations`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `code` | varchar(40) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `location_type` | enum('warehouse','store','3pl','virtual') |  | `warehouse` |  |  |
| `line1` | varchar(255) | yes |  |  |  |
| `line2` | varchar(255) | yes |  |  |  |
| `city` | varchar(80) | yes |  |  |  |
| `state` | varchar(80) | yes |  |  |  |
| `state_code` | varchar(10) | yes |  |  |  |
| `pincode` | varchar(16) | yes |  |  |  |
| `country` | char(2) |  | `IN` |  |  |
| `gstin` | varchar(32) | yes |  |  |  |
| `contact_name` | varchar(120) | yes |  |  |  |
| `contact_phone` | varchar(20) | yes |  |  |  |
| `is_default` | tinyint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `fulfils_online_orders` | tinyint unsigned |  | `1` |  |  |
| `priority` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_inventory_locations_code` (shop_id, code)
- UQ `uq_inventory_locations_tenant` (shop_id, id)

### `inventory_movements`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | IX |  |
| `location_id` | bigint unsigned |  |  | IX |  |
| `movement_type` | enum('purchase_receipt','sale','cancellation','return_restock','adjustment','damage','expiry','transfer_in','transfer_out','reservation_hold','reservation_release','stock_take','rto_restock') |  |  |  |  |
| `quantity_delta` | int |  |  |  |  |
| `quantity_after` | int |  |  |  |  |
| `reference_type` | varchar(40) | yes |  |  |  |
| `reference_id` | bigint unsigned | yes |  |  |  |
| `batch_id` | bigint unsigned | yes |  | IX |  |
| `unit_cost` | decimal(10,2) | yes |  |  |  |
| `reason` | varchar(255) | yes |  |  |  |
| `admin_user_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_inventory_movements_admin` (admin_user_id)
- IX `fk_inventory_movements_batch` (batch_id)
- IX `fk_inventory_movements_location` (location_id)
- IX `fk_inventory_movements_location_t` (shop_id, location_id)
- IX `fk_inventory_movements_variant_t` (shop_id, variant_id)
- IX `ix_inventory_movements_reference` (shop_id, reference_type, reference_id)
- IX `ix_inventory_movements_type` (shop_id, movement_type, created_at)
- IX `ix_inventory_movements_variant` (variant_id, created_at)
- PK `PRIMARY` (id)
- FK (admin_user_id) → `admin_users` (id)
- FK (batch_id) → `product_batches` (id)
- FK (shop_id, location_id) → `inventory_locations` (shop_id, id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

### `inventory_reservations`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | IX |  |
| `location_id` | bigint unsigned |  |  | IX |  |
| `quantity` | int unsigned |  |  |  |  |
| `cart_id` | bigint unsigned | yes |  | IX |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('held','committed','released','expired') |  | `held` |  |  |
| `expires_at` | datetime |  |  |  |  |
| `released_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_inventory_reservations_location` (location_id)
- IX `fk_inventory_reservations_location_t` (shop_id, location_id)
- IX `fk_inventory_reservations_variant_t` (shop_id, variant_id)
- IX `ix_inventory_reservations_cart` (cart_id)
- IX `ix_inventory_reservations_order` (order_id)
- IX `ix_inventory_reservations_sweep` (shop_id, status, expires_at)
- IX `ix_inventory_reservations_variant` (variant_id, status)
- PK `PRIMARY` (id)
- FK (cart_id) → `carts` (id)
- FK (shop_id, location_id) → `inventory_locations` (shop_id, id)
- FK (order_id) → `orders` (id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

### `pincode_serviceability`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `pincode` | varchar(16) |  |  |  |  |
| `city` | varchar(80) | yes |  |  |  |
| `district` | varchar(80) | yes |  |  |  |
| `state` | varchar(80) | yes |  |  |  |
| `state_code` | varchar(10) | yes |  |  |  |
| `zone` | enum('local','regional','metro','rest_of_india','special') |  | `rest_of_india` |  |  |
| `is_serviceable` | tinyint unsigned |  | `1` |  |  |
| `prepaid_available` | tinyint unsigned |  | `1` |  |  |
| `cod_available` | tinyint unsigned |  | `1` |  |  |
| `express_available` | tinyint unsigned |  | `0` |  |  |
| `standard_eta_min_days` | tinyint unsigned |  | `3` |  |  |
| `standard_eta_max_days` | tinyint unsigned |  | `7` |  |  |
| `express_eta_days` | tinyint unsigned | yes |  |  |  |
| `default_carrier_id` | bigint unsigned | yes |  | IX |  |
| `order_cutoff_time` | time | yes |  |  |  |
| `notes` | varchar(255) | yes |  |  |  |
| `source` | varchar(40) | yes |  |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_pincode_carrier` (default_carrier_id)
- IX `ix_pincode_cod` (shop_id, cod_available, is_serviceable)
- IX `ix_pincode_state` (shop_id, state_code)
- PK `PRIMARY` (id)
- UQ `uq_pincode_serviceability` (shop_id, pincode)
- FK (default_carrier_id) → `shipping_carriers` (id)

### `shipment_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `shipment_id` | bigint unsigned |  |  | IX |  |
| `order_item_id` | bigint unsigned |  |  | IX |  |
| `quantity` | smallint unsigned |  | `1` |  |  |

- IX `fk_shipment_items_order_item_t` (shop_id, order_item_id)
- IX `fk_shipment_items_shipment_t` (shop_id, shipment_id)
- IX `ix_shipment_items_order_item` (order_item_id)
- IX `ix_shipment_items_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_shipment_items` (shipment_id, order_item_id)
- FK (shop_id, order_item_id) → `order_items` (shop_id, id)
- FK (shop_id, shipment_id) → `shipments` (shop_id, id)

### `shipment_tracking_events`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `shipment_id` | bigint unsigned |  |  | IX |  |
| `status_code` | varchar(40) |  |  |  |  |
| `status_label` | varchar(120) | yes |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `location` | varchar(120) | yes |  |  |  |
| `event_at` | datetime |  |  |  |  |
| `is_customer_visible` | tinyint unsigned |  | `1` |  |  |
| `raw` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_shipment_tracking_shipment_t` (shop_id, shipment_id)
- IX `ix_shipment_tracking_events_shop` (shop_id)
- IX `ix_shipment_tracking_shipment` (shipment_id, event_at)
- PK `PRIMARY` (id)
- UQ `uq_shipment_tracking_events` (shipment_id, status_code, event_at)
- FK (shop_id, shipment_id) → `shipments` (shop_id, id)

### `shipments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `shipment_number` | varchar(20) |  |  |  |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `carrier_id` | bigint unsigned | yes |  | IX |  |
| `location_id` | bigint unsigned | yes |  | IX |  |
| `awb_number` | varchar(60) | yes |  |  |  |
| `tracking_url` | varchar(500) | yes |  |  |  |
| `provider_shipment_id` | varchar(80) | yes |  |  |  |
| `status` | enum('created','label_generated','pickup_scheduled','picked_up','in_transit','out_for_delivery','delivered','ndr','rto_initiated','rto_in_transit','rto_delivered','lost','damaged','cancelled') |  | `created` |  |  |
| `shipping_mode` | enum('surface','air','express') |  | `surface` |  |  |
| `weight_grams` | int unsigned | yes |  |  |  |
| `length_mm` | smallint unsigned | yes |  |  |  |
| `width_mm` | smallint unsigned | yes |  |  |  |
| `height_mm` | smallint unsigned | yes |  |  |  |
| `shipping_charge` | decimal(10,2) |  | `0.00` |  |  |
| `cod_amount` | decimal(12,2) |  | `0.00` |  |  |
| `cod_remitted_at` | datetime | yes |  |  |  |
| `label_media_id` | bigint unsigned | yes |  | IX |  |
| `manifest_reference` | varchar(60) | yes |  |  |  |
| `ndr_reason` | varchar(255) | yes |  |  |  |
| `ndr_attempts` | tinyint unsigned |  | `0` |  |  |
| `rto_reason` | varchar(255) | yes |  |  |  |
| `shipped_at` | datetime | yes |  |  |  |
| `estimated_delivery_at` | datetime | yes |  |  |  |
| `delivered_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_shipments_carrier` (carrier_id)
- IX `fk_shipments_label` (label_media_id)
- IX `fk_shipments_location` (location_id)
- IX `fk_shipments_order_t` (shop_id, order_id)
- IX `ix_shipments_awb` (shop_id, awb_number)
- IX `ix_shipments_order` (order_id)
- IX `ix_shipments_status` (shop_id, status, updated_at)
- PK `PRIMARY` (id)
- UQ `uq_shipments_number` (shop_id, shipment_number)
- UQ `uq_shipments_tenant` (shop_id, id)
- FK (carrier_id) → `shipping_carriers` (id)
- FK (label_media_id) → `media` (id)
- FK (location_id) → `inventory_locations` (id)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `shipping_carriers`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `code` | varchar(40) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `tracking_url_template` | varchar(500) | yes |  |  |  |
| `api_provider` | varchar(40) | yes |  |  |  |
| `supports_cod` | tinyint unsigned |  | `1` |  |  |
| `supports_reverse_pickup` | tinyint unsigned |  | `1` |  |  |
| `logo_media_id` | bigint unsigned | yes |  | IX |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `priority` | smallint unsigned |  | `0` |  |  |

- IX `fk_shipping_carriers_logo` (logo_media_id)
- PK `PRIMARY` (id)
- UQ `uq_shipping_carriers_code` (shop_id, code)
- FK (logo_media_id) → `media` (id)

### `shipping_rates`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `zone` | enum('local','regional','metro','rest_of_india','special','all') |  | `all` |  |  |
| `zone_id` | bigint unsigned | yes |  | IX |  |
| `method` | enum('standard','express','pickup') |  | `standard` |  |  |
| `min_order_amount` | decimal(10,2) |  | `0.00` |  |  |
| `max_order_amount` | decimal(10,2) | yes |  |  |  |
| `min_weight_grams` | int unsigned |  | `0` |  |  |
| `max_weight_grams` | int unsigned | yes |  |  |  |
| `rate` | decimal(10,2) |  | `0.00` |  |  |
| `free_above_amount` | decimal(10,2) | yes |  |  |  |
| `eta_min_days` | tinyint unsigned |  | `3` |  |  |
| `eta_max_days` | tinyint unsigned |  | `7` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `priority` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_shipping_rates_zone` (zone_id)
- IX `ix_shipping_rates_lookup` (shop_id, zone, method, is_active, priority)
- IX `ix_shipping_rates_zone_id` (shop_id, zone_id)
- PK `PRIMARY` (id)
- FK (zone_id) → `shipping_zones` (id)

### `shipping_zone_areas`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `zone_id` | bigint unsigned |  |  | IX |  |
| `country_code` | char(2) |  |  |  |  |
| `region_code` | varchar(10) | yes |  |  |  |
| `postal_prefix` | varchar(16) | yes |  |  |  |
| `area_key` | varchar(40) | yes |  |  | STORED GENERATED |

- IX `ix_shipping_zone_areas_zone` (zone_id)
- PK `PRIMARY` (id)
- UQ `uq_shipping_zone_areas_place` (shop_id, area_key)
- FK (zone_id) → `shipping_zones` (id)

### `shipping_zones`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_shipping_zones_name` (shop_id, name)
- FK (shop_id) → `shops` (id)

## Orders, carts, payments, returns

### `cart_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `cart_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | IX |  |
| `quantity` | smallint unsigned |  | `1` |  |  |
| `unit_price` | decimal(10,2) |  |  |  |  |
| `unit_mrp` | decimal(10,2) | yes |  |  |  |
| `item_status` | enum('active','saved_for_later') |  | `active` |  |  |
| `is_gift` | tinyint unsigned |  | `0` |  |  |
| `source_coupon_id` | bigint unsigned | yes |  | IX |  |
| `added_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_cart_items_cart_t` (shop_id, cart_id)
- IX `fk_cart_items_product` (product_id)
- IX `fk_cart_items_product_t` (shop_id, product_id)
- IX `fk_cart_items_source_coupon` (source_coupon_id)
- IX `fk_cart_items_variant_t` (shop_id, variant_id)
- IX `ix_cart_items_shop` (shop_id)
- IX `ix_cart_items_variant` (variant_id)
- PK `PRIMARY` (id)
- UQ `uq_cart_items` (cart_id, variant_id, item_status)
- FK (shop_id, cart_id) → `carts` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (source_coupon_id) → `coupons` (id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

### `carts`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `token` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('active','converted','abandoned','merged','expired') |  | `active` |  |  |
| `currency` | char(3) |  | `INR` |  |  |
| `country_code` | char(2) | yes |  |  |  |
| `coupon_code` | varchar(60) | yes |  |  |  |
| `gift_card_ids` | json | yes |  |  |  |
| `loyalty_points_applied` | int unsigned |  | `0` |  |  |
| `item_count` | smallint unsigned |  | `0` |  |  |
| `subtotal` | decimal(12,2) |  | `0.00` |  |  |
| `estimated_total` | decimal(12,2) |  | `0.00` |  |  |
| `pincode` | varchar(16) | yes |  |  |  |
| `region_code` | varchar(10) | yes |  |  |  |
| `merged_into_cart_id` | bigint unsigned | yes |  | IX |  |
| `converted_order_id` | bigint unsigned | yes |  | IX |  |
| `abandoned_at` | datetime | yes |  |  |  |
| `recovery_email_sent_at` | datetime | yes |  |  |  |
| `recovery_token` | char(36) | yes |  |  |  |
| `last_activity_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `expires_at` | datetime | yes |  |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `utm` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_carts_converted_order` (converted_order_id)
- IX `fk_carts_merged_into` (merged_into_cart_id)
- IX `ix_carts_customer` (customer_id, status)
- IX `ix_carts_expiry` (shop_id, expires_at)
- IX `ix_carts_status_activity` (shop_id, status, last_activity_at)
- PK `PRIMARY` (id)
- UQ `uq_carts_tenant` (shop_id, id)
- UQ `uq_carts_token` (shop_id, token)
- FK (converted_order_id) → `orders` (id)
- FK (customer_id) → `customers` (id)
- FK (merged_into_cart_id) → `carts` (id)

### `gift_card_transactions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `gift_card_id` | bigint unsigned |  |  | IX |  |
| `kind` | enum('issue','debit','credit','adjustment') |  |  |  |  |
| `amount` | decimal(12,2) |  |  |  |  |
| `balance_after` | decimal(12,2) |  |  |  |  |
| `order_id` | bigint unsigned | yes |  |  |  |
| `note` | varchar(500) | yes |  |  |  |
| `actor_type` | enum('admin','customer','system') |  | `system` |  |  |
| `actor_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_gift_card_transactions_card` (gift_card_id)
- IX `ix_gift_card_transactions_card` (shop_id, gift_card_id, id)
- IX `ix_gift_card_transactions_order` (shop_id, order_id)
- PK `PRIMARY` (id)
- FK (gift_card_id) → `gift_cards` (id)

### `gift_cards`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `code_hash` | char(64) |  |  |  |  |
| `code_sealed` | varchar(255) |  |  |  |  |
| `last_characters` | char(4) |  |  |  |  |
| `lookup_token` | char(32) |  |  | UQ |  |
| `initial_value` | decimal(12,2) |  |  |  |  |
| `balance` | decimal(12,2) |  |  |  |  |
| `currency` | char(3) |  |  |  |  |
| `expires_on` | date | yes |  |  |  |
| `status` | enum('enabled','disabled') |  | `enabled` |  |  |
| `source` | enum('manual','purchase','api') |  | `manual` |  |  |
| `customer_id` | bigint unsigned | yes |  |  |  |
| `order_id` | bigint unsigned | yes |  |  |  |
| `order_item_id` | bigint unsigned | yes |  |  |  |
| `order_item_sequence` | smallint unsigned | yes |  |  |  |
| `recipient_name` | varchar(120) | yes |  |  |  |
| `recipient_email` | varchar(191) | yes |  |  |  |
| `recipient_phone` | varchar(24) | yes |  |  |  |
| `message` | varchar(500) | yes |  |  |  |
| `note` | varchar(500) | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `disabled_at` | datetime | yes |  |  |  |
| `last_used_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_gift_cards_customer` (shop_id, customer_id)
- IX `ix_gift_cards_last` (shop_id, last_characters)
- IX `ix_gift_cards_list` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- UQ `uq_gift_cards_code` (shop_id, code_hash)
- UQ `uq_gift_cards_lookup` (lookup_token)
- UQ `uq_gift_cards_order_item` (shop_id, order_item_id, order_item_sequence)
- FK (shop_id) → `shops` (id)

### `invoices`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `invoice_number` | varchar(30) |  |  |  |  |
| `invoice_type` | enum('tax_invoice','credit_note') |  | `tax_invoice` |  |  |
| `tax_regime` | varchar(20) |  | `in_gst` |  |  |
| `currency` | char(3) |  | `INR` |  |  |
| `parent_invoice_id` | bigint unsigned | yes |  | IX |  |
| `invoice_date` | date |  |  |  |  |
| `seller_gstin` | varchar(32) | yes |  |  |  |
| `seller_legal_name` | varchar(191) | yes |  |  |  |
| `buyer_gstin` | varchar(32) | yes |  |  |  |
| `place_of_supply` | varchar(10) | yes |  |  |  |
| `taxable_value` | decimal(12,2) |  | `0.00` |  |  |
| `cgst_amount` | decimal(12,2) |  | `0.00` |  |  |
| `sgst_amount` | decimal(12,2) |  | `0.00` |  |  |
| `igst_amount` | decimal(12,2) |  | `0.00` |  |  |
| `tax_amount` | decimal(12,2) |  | `0.00` |  |  |
| `round_off` | decimal(6,2) |  | `0.00` |  |  |
| `total_amount` | decimal(12,2) |  | `0.00` |  |  |
| `irn` | varchar(64) | yes |  |  |  |
| `pdf_media_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('draft','issued','cancelled') |  | `draft` |  |  |
| `issued_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_invoices_order_t` (shop_id, order_id)
- IX `fk_invoices_parent` (parent_invoice_id)
- IX `fk_invoices_pdf` (pdf_media_id)
- IX `ix_invoices_date` (shop_id, invoice_date)
- IX `ix_invoices_order` (order_id)
- PK `PRIMARY` (id)
- UQ `uq_invoices_number` (shop_id, invoice_number)
- FK (shop_id, order_id) → `orders` (shop_id, id)
- FK (parent_invoice_id) → `invoices` (id)
- FK (pdf_media_id) → `media` (id)

### `number_sequences`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `name` | varchar(40) |  |  | PK |  |
| `prefix` | varchar(10) |  | `` |  |  |
| `current_value` | bigint unsigned |  | `0` |  |  |
| `padding` | tinyint unsigned |  | `7` |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (shop_id, name)

### `order_addresses`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `address_type` | enum('shipping','billing') |  |  |  |  |
| `first_name` | varchar(80) |  |  |  |  |
| `last_name` | varchar(80) | yes |  |  |  |
| `phone` | varchar(15) |  |  |  |  |
| `alternate_phone` | varchar(15) | yes |  |  |  |
| `email` | varchar(191) | yes |  |  |  |
| `line1` | varchar(255) |  |  |  |  |
| `line2` | varchar(255) | yes |  |  |  |
| `landmark` | varchar(120) | yes |  |  |  |
| `city` | varchar(80) |  |  |  |  |
| `state` | varchar(80) |  |  |  |  |
| `state_code` | varchar(10) | yes |  |  |  |
| `pincode` | varchar(16) |  |  |  |  |
| `country` | char(2) |  | `IN` |  |  |
| `gstin` | varchar(32) | yes |  |  |  |
| `delivery_notes` | varchar(255) | yes |  |  |  |

- IX `fk_order_addresses_order_t` (shop_id, order_id)
- IX `ix_order_addresses_pincode` (shop_id, pincode)
- PK `PRIMARY` (id)
- UQ `uq_order_addresses` (order_id, address_type)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `order_discounts`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `discount_type` | enum('coupon','automatic','loyalty','bundle','free_shipping','free_gift','manual') |  |  |  |  |
| `code` | varchar(60) | yes |  |  |  |
| `title` | varchar(191) | yes |  |  |  |
| `amount` | decimal(10,2) |  | `0.00` |  |  |
| `applied_to` | enum('order','items','shipping') |  | `order` |  |  |
| `coupon_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_order_discounts_coupon` (coupon_id)
- IX `fk_order_discounts_order_t` (shop_id, order_id)
- IX `ix_order_discounts_order` (order_id)
- IX `ix_order_discounts_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (coupon_id) → `coupons` (id)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `order_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned | yes |  | IX |  |
| `variant_id` | bigint unsigned | yes |  | IX |  |
| `parent_order_item_id` | bigint unsigned | yes |  | IX |  |
| `line_type` | enum('product','bundle','bundle_component','gift','shipping') |  | `product` |  |  |
| `sku` | varchar(64) | yes |  |  |  |
| `product_name` | varchar(255) |  |  |  |  |
| `variant_title` | varchar(160) | yes |  |  |  |
| `product_slug` | varchar(191) | yes |  |  |  |
| `image_url` | varchar(500) | yes |  |  |  |
| `hsn_code` | varchar(12) | yes |  |  |  |
| `batch_number` | varchar(40) | yes |  |  |  |
| `unit_mrp` | decimal(10,2) |  | `0.00` |  |  |
| `unit_price` | decimal(10,2) |  | `0.00` |  |  |
| `quantity` | smallint unsigned |  | `1` |  |  |
| `discount_amount` | decimal(10,2) |  | `0.00` |  |  |
| `taxable_amount` | decimal(12,2) |  | `0.00` |  |  |
| `tax_rate` | decimal(5,2) |  | `0.00` |  |  |
| `cgst_amount` | decimal(10,2) |  | `0.00` |  |  |
| `sgst_amount` | decimal(10,2) |  | `0.00` |  |  |
| `igst_amount` | decimal(10,2) |  | `0.00` |  |  |
| `tax_amount` | decimal(10,2) |  | `0.00` |  |  |
| `line_total` | decimal(12,2) |  | `0.00` |  |  |
| `fulfilled_quantity` | smallint unsigned |  | `0` |  |  |
| `cancelled_quantity` | smallint unsigned |  | `0` |  |  |
| `returned_quantity` | smallint unsigned |  | `0` |  |  |
| `refunded_amount` | decimal(10,2) |  | `0.00` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_order_items_order_t` (shop_id, order_id)
- IX `fk_order_items_parent_t` (shop_id, parent_order_item_id)
- IX `ix_order_items_order` (order_id)
- IX `ix_order_items_parent` (parent_order_item_id)
- IX `ix_order_items_product` (product_id)
- IX `ix_order_items_shop` (shop_id)
- IX `ix_order_items_variant` (variant_id)
- PK `PRIMARY` (id)
- UQ `uq_order_items_tenant` (shop_id, id)
- FK (shop_id, order_id) → `orders` (shop_id, id)
- FK (shop_id, parent_order_item_id) → `order_items` (shop_id, id)
- FK (product_id) → `products` (id)
- FK (variant_id) → `product_variants` (id)

### `order_status_history`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `status_type` | enum('order','payment','fulfillment') |  |  |  |  |
| `from_status` | varchar(40) | yes |  |  |  |
| `to_status` | varchar(40) |  |  |  |  |
| `note` | varchar(500) | yes |  |  |  |
| `actor_type` | enum('customer','admin','system','webhook','courier') |  | `system` |  |  |
| `actor_id` | bigint unsigned | yes |  |  |  |
| `is_customer_visible` | tinyint unsigned |  | `1` |  |  |
| `notified_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_order_status_history_order_t` (shop_id, order_id)
- IX `ix_order_status_history_order` (order_id, created_at)
- IX `ix_order_status_history_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `order_tracking_lookups`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_number` | varchar(20) | yes |  |  |  |
| `contact_value` | varchar(191) | yes |  |  |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `was_successful` | tinyint unsigned |  | `0` |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_order_tracking_lookups_order` (order_id)
- IX `ix_order_tracking_lookups_ip` (shop_id, ip, created_at)
- IX `ix_order_tracking_lookups_order` (shop_id, order_number, created_at)
- PK `PRIMARY` (id)
- FK (order_id) → `orders` (id)

### `orders`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_number` | varchar(20) |  |  |  |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `cart_id` | bigint unsigned | yes |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `is_guest` | tinyint unsigned |  | `0` |  |  |
| `contact_phone` | varchar(15) |  |  |  |  |
| `contact_email` | varchar(191) | yes |  |  |  |
| `customer_name` | varchar(160) | yes |  |  |  |
| `currency` | char(3) |  | `INR` |  |  |
| `market_id` | bigint unsigned | yes |  |  |  |
| `shop_currency` | char(3) | yes |  |  |  |
| `exchange_rate` | decimal(20,10) |  | `1.0000000000` |  |  |
| `order_status` | enum('pending','confirmed','processing','packed','shipped','out_for_delivery','delivered','cancelled','returned','rto') |  | `pending` |  |  |
| `payment_status` | enum('pending','authorized','paid','cod_pending','cod_collected','partially_refunded','refunded','failed','cancelled') |  | `pending` |  |  |
| `fulfillment_status` | enum('unfulfilled','partially_fulfilled','fulfilled','returned','rto') |  | `unfulfilled` |  |  |
| `payment_method` | varchar(40) | yes |  |  |  |
| `subtotal` | decimal(12,2) |  | `0.00` |  |  |
| `discount_total` | decimal(12,2) |  | `0.00` |  |  |
| `coupon_discount` | decimal(12,2) |  | `0.00` |  |  |
| `loyalty_discount` | decimal(12,2) |  | `0.00` |  |  |
| `shipping_total` | decimal(12,2) |  | `0.00` |  |  |
| `shipping_tax` | decimal(12,2) |  | `0.00` |  |  |
| `cod_fee` | decimal(10,2) |  | `0.00` |  |  |
| `tax_total` | decimal(12,2) |  | `0.00` |  |  |
| `cgst_total` | decimal(12,2) |  | `0.00` |  |  |
| `sgst_total` | decimal(12,2) |  | `0.00` |  |  |
| `igst_total` | decimal(12,2) |  | `0.00` |  |  |
| `tax_lines` | json | yes |  |  |  |
| `grand_total` | decimal(12,2) |  | `0.00` |  |  |
| `amount_paid` | decimal(12,2) |  | `0.00` |  |  |
| `amount_refunded` | decimal(12,2) |  | `0.00` |  |  |
| `amount_due` | decimal(12,2) |  | `0.00` |  |  |
| `gift_card_total` | decimal(12,2) |  | `0.00` |  |  |
| `coupon_id` | bigint unsigned | yes |  | IX |  |
| `coupon_code` | varchar(60) | yes |  |  |  |
| `loyalty_points_used` | int unsigned |  | `0` |  |  |
| `loyalty_points_earned` | int unsigned |  | `0` |  |  |
| `pincode` | varchar(16) | yes |  |  |  |
| `place_of_supply_state_code` | varchar(10) | yes |  |  |  |
| `shipping_method` | enum('standard','express','pickup') |  | `standard` |  |  |
| `estimated_delivery_from` | date | yes |  |  |  |
| `estimated_delivery_to` | date | yes |  |  |  |
| `customer_note` | varchar(500) | yes |  |  |  |
| `admin_note` | text | yes |  |  |  |
| `cancel_reason` | varchar(255) | yes |  |  |  |
| `cancelled_by` | enum('customer','admin','system','payment_timeout') | yes |  |  |  |
| `risk_score` | tinyint unsigned | yes |  |  |  |
| `risk_flags` | json | yes |  |  |  |
| `source_channel` | enum('web','mobile_web','whatsapp','admin','app') |  | `web` |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `utm` | json | yes |  |  |  |
| `quiz_submission_id` | bigint unsigned | yes |  | IX |  |
| `placed_at` | datetime | yes |  |  |  |
| `confirmed_at` | datetime | yes |  |  |  |
| `packed_at` | datetime | yes |  |  |  |
| `shipped_at` | datetime | yes |  |  |  |
| `delivered_at` | datetime | yes |  |  |  |
| `cancelled_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_orders_cart` (cart_id)
- IX `fk_orders_coupon` (coupon_id)
- IX `fk_orders_quiz_submission` (quiz_submission_id)
- IX `ix_orders_created` (shop_id, created_at)
- IX `ix_orders_customer` (customer_id, created_at)
- IX `ix_orders_fulfillment` (shop_id, fulfillment_status, created_at)
- IX `ix_orders_order_status` (shop_id, order_status, created_at)
- IX `ix_orders_payment_status` (shop_id, payment_status, created_at)
- IX `ix_orders_phone` (shop_id, contact_phone)
- IX `ix_orders_placed` (shop_id, placed_at)
- PK `PRIMARY` (id)
- UQ `uq_orders_number` (shop_id, order_number)
- UQ `uq_orders_public_id` (shop_id, public_id)
- UQ `uq_orders_tenant` (shop_id, id)
- FK (cart_id) → `carts` (id)
- FK (coupon_id) → `coupons` (id)
- FK (customer_id) → `customers` (id)
- FK (quiz_submission_id) → `quiz_submissions` (id)

### `payment_webhook_events`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `gateway` | varchar(30) |  | `razorpay` |  |  |
| `event_id` | varchar(120) |  |  |  |  |
| `event_type` | varchar(80) |  |  |  |  |
| `payload` | json |  |  |  |  |
| `signature` | varchar(255) | yes |  |  |  |
| `signature_valid` | tinyint unsigned |  | `0` |  |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `payment_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('received','processing','processed','failed','ignored') |  | `received` |  |  |
| `attempts` | smallint unsigned |  | `0` |  |  |
| `last_error` | varchar(500) | yes |  |  |  |
| `received_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `processed_at` | datetime | yes |  |  |  |

- IX `fk_payment_webhook_payment` (payment_id)
- IX `ix_payment_webhook_order` (order_id)
- IX `ix_payment_webhook_status` (shop_id, status, received_at)
- PK `PRIMARY` (id)
- UQ `uq_payment_webhook_events` (shop_id, gateway, event_id)
- FK (order_id) → `orders` (id)
- FK (payment_id) → `payments` (id)

### `payments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `gateway` | varchar(40) |  | `razorpay` |  |  |
| `connection_id` | bigint unsigned | yes |  |  |  |
| `gateway_order_id` | varchar(80) | yes |  |  |  |
| `gateway_payment_id` | varchar(80) | yes |  |  |  |
| `gateway_signature` | varchar(255) | yes |  |  |  |
| `signature_verified` | tinyint unsigned |  | `0` |  |  |
| `idempotency_key` | varchar(80) | yes |  |  |  |
| `attempt_no` | tinyint unsigned |  | `1` |  |  |
| `method` | enum('upi','card','netbanking','wallet','emi','paylater','cod','other') | yes |  |  |  |
| `amount` | decimal(12,2) |  | `0.00` |  |  |
| `currency` | char(3) |  | `INR` |  |  |
| `status` | enum('created','pending','authorized','captured','failed','cancelled','refunded','partially_refunded') |  | `created` |  |  |
| `card_network` | varchar(30) | yes |  |  |  |
| `card_last4` | char(4) | yes |  |  |  |
| `card_issuer` | varchar(80) | yes |  |  |  |
| `upi_vpa` | varchar(120) | yes |  |  |  |
| `bank` | varchar(80) | yes |  |  |  |
| `wallet` | varchar(40) | yes |  |  |  |
| `is_international` | tinyint unsigned |  | `0` |  |  |
| `gateway_fee` | decimal(10,2) |  | `0.00` |  |  |
| `gateway_tax` | decimal(10,2) |  | `0.00` |  |  |
| `error_code` | varchar(60) | yes |  |  |  |
| `error_description` | varchar(500) | yes |  |  |  |
| `error_source` | varchar(60) | yes |  |  |  |
| `error_step` | varchar(60) | yes |  |  |  |
| `error_reason` | varchar(120) | yes |  |  |  |
| `raw_response` | json | yes |  |  |  |
| `authorized_at` | datetime | yes |  |  |  |
| `captured_at` | datetime | yes |  |  |  |
| `failed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_payments_order_t` (shop_id, order_id)
- IX `ix_payments_gateway_order` (shop_id, gateway_order_id)
- IX `ix_payments_order` (order_id, created_at)
- IX `ix_payments_status` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- UQ `uq_payments_gateway_payment_id` (shop_id, gateway_payment_id)
- UQ `uq_payments_idempotency` (shop_id, idempotency_key)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `refunds`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `payment_id` | bigint unsigned | yes |  | IX |  |
| `return_request_id` | bigint unsigned | yes |  | IX |  |
| `gateway_refund_id` | varchar(80) | yes |  |  |  |
| `amount` | decimal(12,2) |  |  |  |  |
| `refund_type` | enum('full','partial') |  | `partial` |  |  |
| `reason` | varchar(255) | yes |  |  |  |
| `internal_note` | text | yes |  |  |  |
| `status` | enum('pending','processing','processed','failed','cancelled') |  | `pending` |  |  |
| `speed` | enum('normal','optimum','instant') |  | `normal` |  |  |
| `arn` | varchar(60) | yes |  |  |  |
| `initiated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `raw_response` | json | yes |  |  |  |
| `processed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_refunds_admin` (initiated_by_admin_id)
- IX `fk_refunds_order_t` (shop_id, order_id)
- IX `fk_refunds_payment` (payment_id)
- IX `fk_refunds_return` (return_request_id)
- IX `ix_refunds_order` (order_id)
- IX `ix_refunds_status` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- UQ `uq_refunds_gateway_id` (shop_id, gateway_refund_id)
- FK (initiated_by_admin_id) → `admin_users` (id)
- FK (shop_id, order_id) → `orders` (shop_id, id)
- FK (payment_id) → `payments` (id)
- FK (return_request_id) → `return_requests` (id)

### `return_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `return_request_id` | bigint unsigned |  |  | IX |  |
| `order_item_id` | bigint unsigned |  |  | IX |  |
| `quantity` | smallint unsigned |  | `1` |  |  |
| `refund_amount` | decimal(10,2) |  | `0.00` |  |  |
| `item_condition` | enum('unopened','opened','damaged','used','unknown') |  | `unknown` |  |  |
| `restock` | tinyint unsigned |  | `0` |  |  |
| `condition_note` | varchar(500) | yes |  |  |  |

- IX `fk_return_items_order_item_t` (shop_id, order_item_id)
- IX `fk_return_items_request_t` (shop_id, return_request_id)
- IX `ix_return_items_order_item` (order_item_id)
- IX `ix_return_items_request` (return_request_id)
- IX `ix_return_items_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (shop_id, order_item_id) → `order_items` (shop_id, id)
- FK (shop_id, return_request_id) → `return_requests` (shop_id, id)

### `return_requests`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `rma_number` | varchar(20) |  |  |  |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `reason` | enum('damaged','wrong_item','missing_item','not_as_described','adverse_reaction','changed_mind','late_delivery','expired_product','other') |  |  |  |  |
| `reason_detail` | text | yes |  |  |  |
| `status` | enum('requested','approved','rejected','pickup_scheduled','picked_up','received','inspected','refunded','closed') |  | `requested` |  |  |
| `refund_method` | enum('original','store_credit','bank_transfer','none') |  | `original` |  |  |
| `requested_amount` | decimal(12,2) |  | `0.00` |  |  |
| `approved_amount` | decimal(12,2) |  | `0.00` |  |  |
| `pickup_address_id` | bigint unsigned | yes |  | IX |  |
| `pickup_awb` | varchar(60) | yes |  |  |  |
| `rejection_reason` | varchar(500) | yes |  |  |  |
| `inspection_note` | text | yes |  |  |  |
| `requested_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `approved_at` | datetime | yes |  |  |  |
| `approved_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `received_at` | datetime | yes |  |  |  |
| `closed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_return_requests_approver` (approved_by_admin_id)
- IX `fk_return_requests_customer` (customer_id)
- IX `fk_return_requests_order_t` (shop_id, order_id)
- IX `fk_return_requests_pickup_address` (pickup_address_id)
- IX `ix_return_requests_order` (order_id)
- IX `ix_return_requests_status` (shop_id, status, requested_at)
- PK `PRIMARY` (id)
- UQ `uq_return_requests_rma` (shop_id, rma_number)
- UQ `uq_return_requests_tenant` (shop_id, id)
- FK (approved_by_admin_id) → `admin_users` (id)
- FK (customer_id) → `customers` (id)
- FK (shop_id, order_id) → `orders` (shop_id, id)
- FK (pickup_address_id) → `customer_addresses` (id)

## Customers and marketing

### `back_in_stock_requests`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `email` | varchar(191) | yes |  |  |  |
| `phone` | varchar(15) | yes |  |  |  |
| `channel` | enum('email','sms','whatsapp') |  | `email` |  |  |
| `consent_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('pending','notified','cancelled','expired') |  | `pending` |  |  |
| `notified_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_back_in_stock_consent` (consent_id)
- IX `fk_back_in_stock_variant_t` (shop_id, variant_id)
- IX `ix_back_in_stock_customer` (customer_id)
- IX `ix_back_in_stock_requests_shop` (shop_id)
- IX `ix_back_in_stock_variant` (variant_id, status)
- PK `PRIMARY` (id)
- FK (consent_id) → `customer_consents` (id)
- FK (customer_id) → `customers` (id)
- FK (shop_id, variant_id) → `product_variants` (shop_id, id)

### `coupon_categories`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `coupon_id` | bigint unsigned |  |  | PK |  |
| `category_id` | bigint unsigned |  |  | PK |  |
| `is_excluded` | tinyint unsigned |  | `0` |  |  |

- IX `fk_coupon_categories_category_t` (shop_id, category_id)
- IX `fk_coupon_categories_coupon_t` (shop_id, coupon_id)
- IX `ix_coupon_categories_category` (category_id)
- IX `ix_coupon_categories_shop` (shop_id)
- PK `PRIMARY` (coupon_id, category_id)
- FK (shop_id, category_id) → `categories` (shop_id, id)
- FK (shop_id, coupon_id) → `coupons` (shop_id, id)

### `coupon_collections`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `coupon_id` | bigint unsigned |  |  | PK |  |
| `collection_id` | bigint unsigned |  |  | PK |  |
| `is_excluded` | tinyint unsigned |  | `0` |  |  |

- IX `fk_coupon_collections_collection_t` (shop_id, collection_id)
- IX `fk_coupon_collections_coupon_t` (shop_id, coupon_id)
- IX `ix_coupon_collections_collection` (collection_id)
- IX `ix_coupon_collections_shop` (shop_id)
- PK `PRIMARY` (coupon_id, collection_id)
- FK (shop_id, collection_id) → `collections` (shop_id, id)
- FK (shop_id, coupon_id) → `coupons` (shop_id, id)

### `coupon_customers`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `coupon_id` | bigint unsigned |  |  | PK |  |
| `customer_id` | bigint unsigned |  |  | PK |  |

- IX `fk_coupon_customers_coupon_t` (shop_id, coupon_id)
- IX `fk_coupon_customers_customer_t` (shop_id, customer_id)
- IX `ix_coupon_customers_customer` (customer_id)
- IX `ix_coupon_customers_shop` (shop_id)
- PK `PRIMARY` (coupon_id, customer_id)
- FK (shop_id, coupon_id) → `coupons` (shop_id, id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

### `coupon_products`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `coupon_id` | bigint unsigned |  |  | PK |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `is_excluded` | tinyint unsigned |  | `0` |  |  |

- IX `fk_coupon_products_coupon_t` (shop_id, coupon_id)
- IX `fk_coupon_products_product_t` (shop_id, product_id)
- IX `ix_coupon_products_product` (product_id)
- IX `ix_coupon_products_shop` (shop_id)
- PK `PRIMARY` (coupon_id, product_id)
- FK (shop_id, coupon_id) → `coupons` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `coupon_redemptions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `coupon_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `discount_amount` | decimal(10,2) |  | `0.00` |  |  |
| `redeemed_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_coupon_redemptions_coupon_t` (shop_id, coupon_id)
- IX `fk_coupon_redemptions_order` (order_id)
- IX `fk_coupon_redemptions_order_t` (shop_id, order_id)
- IX `ix_coupon_redemptions_customer` (customer_id, coupon_id)
- IX `ix_coupon_redemptions_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_coupon_redemptions` (coupon_id, order_id)
- FK (shop_id, coupon_id) → `coupons` (shop_id, id)
- FK (customer_id) → `customers` (id)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `coupons`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `code` | varchar(60) |  |  |  |  |
| `title` | varchar(191) | yes |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `discount_type` | enum('percentage','fixed_amount','free_shipping','buy_x_get_y','free_gift') |  | `percentage` |  |  |
| `value` | decimal(10,2) |  | `0.00` |  |  |
| `max_discount_amount` | decimal(10,2) | yes |  |  |  |
| `min_order_amount` | decimal(10,2) |  | `0.00` |  |  |
| `min_quantity` | smallint unsigned |  | `0` |  |  |
| `applies_to` | enum('all','products','categories','collections') |  | `all` |  |  |
| `customer_eligibility` | enum('all','new_customers','returning','specific') |  | `all` |  |  |
| `buy_quantity` | smallint unsigned | yes |  |  |  |
| `get_quantity` | smallint unsigned | yes |  |  |  |
| `get_variant_id` | bigint unsigned | yes |  | IX |  |
| `gift_variant_id` | bigint unsigned | yes |  | IX |  |
| `gift_reserves_inventory` | tinyint unsigned |  | `1` |  |  |
| `usage_limit_total` | int unsigned | yes |  |  |  |
| `usage_limit_per_customer` | smallint unsigned |  | `1` |  |  |
| `used_count` | int unsigned |  | `0` |  |  |
| `is_stackable` | tinyint unsigned |  | `0` |  |  |
| `is_automatic` | tinyint unsigned |  | `0` |  |  |
| `is_visible` | tinyint unsigned |  | `0` |  |  |
| `priority` | smallint unsigned |  | `100` |  |  |
| `starts_at` | datetime | yes |  |  |  |
| `ends_at` | datetime | yes |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_coupons_creator` (created_by_admin_id)
- IX `fk_coupons_get_variant` (get_variant_id)
- IX `fk_coupons_gift_variant` (gift_variant_id)
- IX `ix_coupons_active` (shop_id, is_active, starts_at, ends_at)
- IX `ix_coupons_automatic` (shop_id, is_automatic, is_active, priority)
- PK `PRIMARY` (id)
- UQ `uq_coupons_code` (shop_id, code)
- UQ `uq_coupons_tenant` (shop_id, id)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (get_variant_id) → `product_variants` (id)
- FK (gift_variant_id) → `product_variants` (id)

### `customer_addresses`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | IX |  |
| `label` | varchar(40) |  | `Home` |  |  |
| `address_type` | enum('home','work','other') |  | `home` |  |  |
| `first_name` | varchar(80) |  |  |  |  |
| `last_name` | varchar(80) | yes |  |  |  |
| `phone` | varchar(15) |  |  |  |  |
| `alternate_phone` | varchar(15) | yes |  |  |  |
| `line1` | varchar(255) |  |  |  |  |
| `line2` | varchar(255) | yes |  |  |  |
| `landmark` | varchar(120) | yes |  |  |  |
| `city` | varchar(80) |  |  |  |  |
| `state` | varchar(80) |  |  |  |  |
| `state_code` | varchar(10) | yes |  |  |  |
| `pincode` | varchar(16) |  |  |  |  |
| `country` | char(2) |  | `IN` |  |  |
| `latitude` | decimal(10,7) | yes |  |  |  |
| `longitude` | decimal(10,7) | yes |  |  |  |
| `is_default_shipping` | tinyint unsigned |  | `0` |  |  |
| `is_default_billing` | tinyint unsigned |  | `0` |  |  |
| `is_verified` | tinyint unsigned |  | `0` |  |  |
| `delivery_notes` | varchar(255) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_customer_addresses_customer_t` (shop_id, customer_id)
- IX `ix_customer_addresses_customer` (customer_id, deleted_at)
- IX `ix_customer_addresses_pincode` (shop_id, pincode)
- PK `PRIMARY` (id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

### `customer_consents`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `subject_identifier` | varchar(191) | yes |  |  |  |
| `purpose` | enum('transactional','marketing_email','marketing_sms','marketing_whatsapp','analytics_cookies','advertising_cookies','quiz_data','review_media','adverse_event_contact','data_processing') |  |  |  |  |
| `status` | enum('granted','withdrawn') |  |  |  |  |
| `notice_version` | varchar(20) |  |  |  |  |
| `source` | enum('signup','checkout','footer','popup','quiz','preference_center','admin','import','support') |  |  |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `evidence` | json | yes |  |  |  |
| `expires_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_customer_consents_customer_t` (shop_id, customer_id)
- IX `ix_customer_consents_customer` (customer_id, purpose, created_at)
- IX `ix_customer_consents_subject` (shop_id, subject_identifier, purpose, created_at)
- PK `PRIMARY` (id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

### `customer_data_exports`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `data_request_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  |  |  |
| `content` | longtext |  |  |  |  |
| `size_bytes` | int unsigned |  |  |  |  |
| `download_token_hash` | char(64) | yes |  | UQ |  |
| `expires_at` | datetime |  |  | IX |  |
| `downloaded_at` | datetime | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_customer_data_exports_request` (data_request_id)
- IX `ix_customer_data_exports_expiry` (expires_at)
- IX `ix_customer_data_exports_request` (shop_id, data_request_id)
- PK `PRIMARY` (id)
- UQ `uq_customer_data_exports_token` (download_token_hash)
- FK (data_request_id) → `data_requests` (id)
- FK (shop_id) → `shops` (id)

### `customer_notes`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | IX |  |
| `admin_user_id` | bigint unsigned | yes |  | IX |  |
| `note` | text |  |  |  |  |
| `is_pinned` | tinyint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_customer_notes_admin` (admin_user_id)
- IX `fk_customer_notes_customer_t` (shop_id, customer_id)
- IX `ix_customer_notes_customer` (customer_id, created_at)
- IX `ix_customer_notes_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (admin_user_id) → `admin_users` (id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

### `customer_segment_members`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `segment_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | IX |  |
| `added_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `auto_added_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_segment_members_admin` (added_by_admin_id)
- IX `fk_segment_members_customer_t` (shop_id, customer_id)
- IX `fk_segment_members_segment_t` (shop_id, segment_id)
- IX `ix_customer_segment_members_shop` (shop_id)
- IX `ix_segment_members_customer` (customer_id)
- PK `PRIMARY` (id)
- UQ `uq_segment_members` (segment_id, customer_id)
- FK (added_by_admin_id) → `admin_users` (id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)
- FK (shop_id, segment_id) → `customer_segments` (shop_id, id)

### `customer_segments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | text | yes |  |  |  |
| `segment_type` | enum('manual','auto','imported') |  | `manual` |  |  |
| `rules` | json | yes |  |  |  |
| `rules_operator` | enum('all','any') |  | `all` |  |  |
| `customer_count` | int unsigned |  | `0` |  |  |
| `last_calculated_at` | datetime | yes |  |  |  |
| `color` | varchar(7) | yes |  |  |  |
| `icon` | varchar(40) | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_customer_segments_creator` (created_by_admin_id)
- IX `ix_customer_segments_type` (shop_id, segment_type, deleted_at)
- PK `PRIMARY` (id)
- UQ `uq_customer_segments_tenant` (shop_id, id)
- FK (created_by_admin_id) → `admin_users` (id)

### `customer_sessions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | IX |  |
| `refresh_token_hash` | char(64) |  |  |  |  |
| `access_token_jti` | char(36) | yes |  |  |  |
| `rotated_from_session_id` | bigint unsigned | yes |  | IX |  |
| `device_id` | varchar(64) | yes |  |  |  |
| `device_name` | varchar(120) | yes |  |  |  |
| `platform` | enum('web','mobile_web','ios','android') |  | `web` |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `issued_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `last_used_at` | datetime | yes |  |  |  |
| `expires_at` | datetime |  |  |  |  |
| `revoked_at` | datetime | yes |  |  |  |
| `revoked_reason` | enum('logout','rotation','reuse_detected','admin','expired','password_change') | yes |  |  |  |

- IX `fk_customer_sessions_customer_t` (shop_id, customer_id)
- IX `fk_customer_sessions_parent` (rotated_from_session_id)
- IX `ix_customer_sessions_customer` (customer_id, revoked_at)
- IX `ix_customer_sessions_expiry` (shop_id, expires_at)
- PK `PRIMARY` (id)
- UQ `uq_customer_sessions_refresh` (shop_id, refresh_token_hash)
- FK (shop_id, customer_id) → `customers` (shop_id, id)
- FK (rotated_from_session_id) → `customer_sessions` (id)

### `customer_tag_assignments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | IX |  |
| `tag_id` | bigint unsigned |  |  | IX |  |
| `added_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_customer_tag_assignments_admin` (added_by_admin_id)
- IX `fk_customer_tag_assignments_customer_t` (shop_id, customer_id)
- IX `fk_customer_tag_assignments_tag_t` (shop_id, tag_id)
- IX `ix_customer_tag_assignments_shop` (shop_id)
- IX `ix_customer_tag_assignments_tag` (tag_id)
- PK `PRIMARY` (id)
- UQ `uq_customer_tag_assignments` (customer_id, tag_id)
- FK (added_by_admin_id) → `admin_users` (id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)
- FK (shop_id, tag_id) → `customer_tags` (shop_id, id)

### `customer_tags`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(60) |  |  |  |  |
| `color` | varchar(7) | yes |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `usage_count` | int unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_customer_tags_name` (shop_id, name)
- UQ `uq_customer_tags_tenant` (shop_id, id)

### `customer_tracking_consents`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `consent_id` | char(36) |  |  |  |  |
| `customer_id` | bigint unsigned | yes |  |  |  |
| `country` | char(2) | yes |  |  |  |
| `consent_required` | tinyint unsigned |  | `0` |  |  |
| `sale_opt_out_region` | tinyint unsigned |  | `0` |  |  |
| `analytics` | tinyint unsigned |  |  |  |  |
| `marketing` | tinyint unsigned |  |  |  |  |
| `preferences` | tinyint unsigned |  |  |  |  |
| `sale_of_data` | tinyint unsigned |  |  |  |  |
| `method` | enum('accept_all','reject_all','custom','opt_out_page','gpc','api','account') |  |  |  |  |
| `gpc` | tinyint unsigned |  | `0` |  |  |
| `policy_version` | int unsigned | yes |  |  |  |
| `locale` | varchar(10) | yes |  |  |  |
| `page_path` | varchar(255) | yes |  |  |  |
| `ip_prefix` | varchar(45) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_tracking_consents_consent` (shop_id, consent_id)
- IX `ix_tracking_consents_created` (shop_id, created_at)
- IX `ix_tracking_consents_customer` (shop_id, customer_id)
- PK `PRIMARY` (id)
- FK (shop_id) → `shops` (id)

### `customers`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `country_code` | varchar(5) |  | `+91` |  |  |
| `phone` | varchar(15) |  |  |  |  |
| `email` | varchar(191) | yes |  |  |  |
| `first_name` | varchar(80) | yes |  |  |  |
| `last_name` | varchar(80) | yes |  |  |  |
| `gender` | enum('female','male','other','undisclosed') |  | `undisclosed` |  |  |
| `date_of_birth` | date | yes |  |  |  |
| `avatar_media_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('active','blocked','deleted') |  | `active` |  |  |
| `phone_verified_at` | datetime | yes |  |  |  |
| `email_verified_at` | datetime | yes |  |  |  |
| `profile_completed_at` | datetime | yes |  |  |  |
| `accepts_email_marketing` | tinyint unsigned |  | `0` |  |  |
| `accepts_sms_marketing` | tinyint unsigned |  | `0` |  |  |
| `accepts_whatsapp_marketing` | tinyint unsigned |  | `0` |  |  |
| `skin_type_id` | bigint unsigned | yes |  | IX |  |
| `primary_concern_id` | bigint unsigned | yes |  | IX |  |
| `orders_count` | int unsigned |  | `0` |  |  |
| `total_spent` | decimal(12,2) |  | `0.00` |  |  |
| `average_order_value` | decimal(10,2) |  | `0.00` |  |  |
| `first_order_at` | datetime | yes |  |  |  |
| `last_order_at` | datetime | yes |  |  |  |
| `last_seen_at` | datetime | yes |  |  |  |
| `rto_count` | smallint unsigned |  | `0` |  |  |
| `cod_blocked` | tinyint unsigned |  | `0` |  |  |
| `signup_source` | enum('web','mobile_web','whatsapp','import','admin','app') |  | `web` |  |  |
| `signup_utm` | json | yes |  |  |  |
| `referred_by_customer_id` | bigint unsigned | yes |  | IX |  |
| `preferred_language` | varchar(10) |  | `en-IN` |  |  |
| `anonymised_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_customers_avatar` (avatar_media_id)
- IX `fk_customers_concern` (primary_concern_id)
- IX `fk_customers_referrer` (referred_by_customer_id)
- IX `fk_customers_skin_type` (skin_type_id)
- IX `ix_customers_last_order` (shop_id, last_order_at)
- IX `ix_customers_spend` (shop_id, total_spent)
- IX `ix_customers_status` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- UQ `uq_customers_email` (shop_id, email)
- UQ `uq_customers_phone` (shop_id, country_code, phone)
- UQ `uq_customers_public_id` (shop_id, public_id)
- UQ `uq_customers_tenant` (shop_id, id)
- FK (avatar_media_id) → `media` (id)
- FK (primary_concern_id) → `skin_concerns` (id)
- FK (referred_by_customer_id) → `customers` (id)
- FK (skin_type_id) → `skin_types` (id)

### `data_requests`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `reference` | varchar(20) |  |  |  |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `contact_value` | varchar(191) |  |  |  |  |
| `request_type` | enum('access','correction','erasure','portability','grievance','withdraw_consent') |  |  |  |  |
| `source` | enum('storefront','account','admin','api') |  | `admin` |  |  |
| `requester_country` | char(2) | yes |  |  |  |
| `status` | enum('verifying','received','in_progress','scheduled','completed','rejected','cancelled') |  | `received` | IX |  |
| `details` | text | yes |  |  |  |
| `verification_token_hash` | char(64) | yes |  | UQ |  |
| `verification_expires_at` | datetime | yes |  |  |  |
| `verified_at` | datetime | yes |  |  |  |
| `due_at` | datetime | yes |  |  |  |
| `scheduled_for` | datetime | yes |  |  |  |
| `processed_at` | datetime | yes |  |  |  |
| `completed_at` | datetime | yes |  |  |  |
| `outcome_note` | text | yes |  |  |  |
| `export_media_id` | bigint unsigned | yes |  | IX |  |
| `handled_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_data_requests_admin` (handled_by_admin_id)
- IX `fk_data_requests_customer` (customer_id)
- IX `fk_data_requests_export` (export_media_id)
- IX `ix_data_requests_scheduled` (status, scheduled_for)
- IX `ix_data_requests_status` (shop_id, status, due_at)
- PK `PRIMARY` (id)
- UQ `uq_data_requests_reference` (shop_id, reference)
- UQ `uq_data_requests_verification` (verification_token_hash)
- FK (handled_by_admin_id) → `admin_users` (id)
- FK (customer_id) → `customers` (id)
- FK (export_media_id) → `media` (id)

### `loyalty_accounts`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | UQ |  |
| `balance` | int |  | `0` |  |  |
| `lifetime_earned` | int unsigned |  | `0` |  |  |
| `lifetime_redeemed` | int unsigned |  | `0` |  |  |
| `tier` | enum('none','bronze','silver','gold') |  | `none` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_loyalty_accounts_customer_t` (shop_id, customer_id)
- IX `ix_loyalty_accounts_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_loyalty_accounts_customer` (customer_id)
- UQ `uq_loyalty_accounts_tenant` (shop_id, id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

### `loyalty_rules`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `event` | enum('order_delivered','order_placed','review_approved','signup','referral','birthday') |  |  |  |  |
| `points_type` | enum('fixed','percentage_of_order') |  | `fixed` |  |  |
| `points_value` | decimal(10,2) |  | `0.00` |  |  |
| `min_order_amount` | decimal(10,2) |  | `0.00` |  |  |
| `max_points_per_event` | int unsigned | yes |  |  |  |
| `redemption_rate` | decimal(8,2) |  | `10.00` |  |  |
| `min_redeem_points` | int unsigned |  | `100` |  |  |
| `max_redeem_percent` | decimal(5,2) |  | `50.00` |  |  |
| `expiry_days` | smallint unsigned | yes |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `ix_loyalty_rules_event` (shop_id, event, is_active)
- PK `PRIMARY` (id)

### `loyalty_transactions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `loyalty_account_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `transaction_type` | enum('earn','redeem','expire','adjust','reversal') |  |  |  |  |
| `points` | int |  |  |  |  |
| `balance_after` | int |  |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `expires_at` | datetime | yes |  |  |  |
| `admin_user_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_loyalty_transactions_account_t` (shop_id, loyalty_account_id)
- IX `fk_loyalty_transactions_admin` (admin_user_id)
- IX `ix_loyalty_transactions_account` (loyalty_account_id, created_at)
- IX `ix_loyalty_transactions_expiry` (shop_id, expires_at)
- IX `ix_loyalty_transactions_order` (order_id)
- PK `PRIMARY` (id)
- FK (shop_id, loyalty_account_id) → `loyalty_accounts` (shop_id, id)
- FK (admin_user_id) → `admin_users` (id)
- FK (order_id) → `orders` (id)

### `message_campaign_recipients`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `campaign_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `recipient` | varchar(191) |  |  |  |  |
| `status` | enum('pending','sending','sent','delivered','failed','skipped','cancelled') |  | `pending` |  |  |
| `skip_reason` | varchar(40) | yes |  |  |  |
| `error_message` | varchar(500) | yes |  |  |  |
| `log_id` | bigint unsigned | yes |  |  |  |
| `variables` | json | yes |  |  |  |
| `sent_at` | datetime | yes |  |  |  |
| `delivered_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_campaign_recipients_campaign_t` (shop_id, campaign_id)
- IX `fk_campaign_recipients_customer_t` (shop_id, customer_id)
- IX `ix_campaign_recipients_customer` (customer_id)
- IX `ix_campaign_recipients_status` (campaign_id, status, id)
- IX `ix_message_campaign_recipients_log` (shop_id, log_id)
- IX `ix_message_campaign_recipients_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_campaign_customer` (campaign_id, customer_id)
- FK (shop_id, campaign_id) → `message_campaigns` (shop_id, id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

### `message_campaigns`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(160) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `channel` | enum('email','sms','whatsapp','push') |  |  |  |  |
| `template_id` | bigint unsigned | yes |  | IX |  |
| `sender_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('draft','scheduled','sending','paused','completed','cancelled','failed') |  | `draft` |  |  |
| `audience_type` | enum('segment','rules','manual','all') |  | `segment` |  |  |
| `segment_id` | bigint unsigned | yes |  | IX |  |
| `rules` | json | yes |  |  |  |
| `rules_operator` | enum('all','any') |  | `all` |  |  |
| `customer_ids` | json | yes |  |  |  |
| `exclude_recent_hours` | smallint unsigned | yes |  |  |  |
| `scheduled_at` | datetime | yes |  |  |  |
| `timezone` | varchar(40) |  | `Asia/Kolkata` |  |  |
| `started_at` | datetime | yes |  |  |  |
| `completed_at` | datetime | yes |  |  |  |
| `throttle_per_minute` | int unsigned | yes |  |  |  |
| `total_recipients` | int unsigned |  | `0` |  |  |
| `sent_count` | int unsigned |  | `0` |  |  |
| `delivered_count` | int unsigned |  | `0` |  |  |
| `failed_count` | int unsigned |  | `0` |  |  |
| `skipped_count` | int unsigned |  | `0` |  |  |
| `cost` | decimal(12,4) |  | `0.0000` |  |  |
| `variables` | json | yes |  |  |  |
| `utm` | json | yes |  |  | Appended to links in the body |
| `last_error` | varchar(500) | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `approved_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_message_campaigns_admin` (created_by_admin_id)
- IX `fk_message_campaigns_segment` (segment_id)
- IX `fk_message_campaigns_sender` (sender_id)
- IX `fk_message_campaigns_template` (template_id)
- IX `ix_message_campaigns_channel` (shop_id, channel, created_at)
- IX `ix_message_campaigns_status` (shop_id, status, scheduled_at)
- PK `PRIMARY` (id)
- UQ `uq_message_campaigns_tenant` (shop_id, id)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (segment_id) → `customer_segments` (id)
- FK (sender_id) → `messaging_senders` (id)
- FK (template_id) → `notification_templates` (id)

### `messaging_senders`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `channel` | enum('email','sms','whatsapp','push') |  |  |  |  |
| `name` | varchar(120) |  |  |  | What staff call it: "Veylor transactional", "VEYLOR promo" |
| `provider` | varchar(40) |  | `simulator` |  |  |
| `status` | enum('active','paused') |  | `active` |  |  |
| `is_default` | tinyint(1) |  | `0` |  |  |
| `from_email` | varchar(191) | yes |  |  |  |
| `from_name` | varchar(120) | yes |  |  |  |
| `reply_to` | varchar(191) | yes |  |  |  |
| `sms_header` | varchar(12) | yes |  |  | The registered sender ID, e.g. VEYLOR |
| `dlt_pe_id` | varchar(40) | yes |  |  | Principal Entity ID issued by the DLT registry |
| `dlt_entity_name` | varchar(160) | yes |  |  |  |
| `waba_id` | varchar(40) | yes |  |  |  |
| `phone_number_id` | varchar(40) | yes |  |  |  |
| `display_phone` | varchar(20) | yes |  |  |  |
| `quality_rating` | enum('green','yellow','red','unknown') |  | `unknown` |  |  |
| `config` | json | yes |  |  |  |
| `daily_limit` | int unsigned | yes |  |  | Stop sending after this many in a day. NULL is no limit. |
| `notes` | varchar(500) | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_messaging_senders_admin` (created_by_admin_id)
- IX `ix_messaging_senders_channel` (shop_id, channel, status, deleted_at)
- PK `PRIMARY` (id)
- UQ `uq_messaging_senders_name` (shop_id, channel, name)
- FK (created_by_admin_id) → `admin_users` (id)

### `newsletter_subscribers`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `email` | varchar(191) | yes |  |  |  |
| `phone` | varchar(15) | yes |  |  |  |
| `channel` | enum('email','sms','whatsapp') |  | `email` |  |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('pending','subscribed','unsubscribed','bounced','complained') |  | `pending` |  |  |
| `source` | varchar(60) | yes |  |  |  |
| `consent_id` | bigint unsigned | yes |  | IX |  |
| `unsubscribe_token` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `subscribed_at` | datetime | yes |  |  |  |
| `unsubscribed_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_newsletter_consent` (consent_id)
- IX `fk_newsletter_customer` (customer_id)
- IX `ix_newsletter_status` (shop_id, status, channel)
- PK `PRIMARY` (id)
- UQ `uq_newsletter_email_channel` (shop_id, email, channel)
- UQ `uq_newsletter_phone_channel` (shop_id, phone, channel)
- UQ `uq_newsletter_token` (shop_id, unsubscribe_token)
- FK (consent_id) → `customer_consents` (id)
- FK (customer_id) → `customers` (id)

### `notification_logs`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `template_id` | bigint unsigned | yes |  | IX |  |
| `event_key` | varchar(60) |  |  |  |  |
| `channel` | enum('email','sms','whatsapp','push') |  |  |  |  |
| `direction` | enum('outbound','inbound') |  | `outbound` |  |  |
| `recipient` | varchar(191) |  |  |  |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `campaign_id` | bigint unsigned | yes |  |  |  |
| `sent_by_admin_id` | bigint unsigned | yes |  |  | Set when a person sent it by hand from the admin |
| `provider` | varchar(40) | yes |  |  |  |
| `sender_id` | bigint unsigned | yes |  |  |  |
| `provider_message_id` | varchar(120) | yes |  |  |  |
| `status` | enum('queued','sent','delivered','read','failed','bounced') |  | `queued` |  |  |
| `error_message` | varchar(500) | yes |  |  |  |
| `retry_count` | tinyint unsigned |  | `0` |  |  |
| `cost` | decimal(8,4) |  | `0.0000` |  |  |
| `payload` | json | yes |  |  |  |
| `queued_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `sent_at` | datetime | yes |  |  |  |
| `delivered_at` | datetime | yes |  |  |  |
| `failed_at` | datetime | yes |  |  |  |

- IX `fk_notification_logs_template` (template_id)
- IX `ix_notification_logs_campaign` (shop_id, campaign_id, status)
- IX `ix_notification_logs_customer` (customer_id, queued_at)
- IX `ix_notification_logs_inbound` (shop_id, direction, channel, recipient, queued_at)
- IX `ix_notification_logs_order` (order_id)
- IX `ix_notification_logs_provider_message` (shop_id, provider_message_id)
- IX `ix_notification_logs_recipient` (shop_id, recipient, queued_at)
- IX `ix_notification_logs_status` (shop_id, status, queued_at)
- PK `PRIMARY` (id)
- FK (customer_id) → `customers` (id)
- FK (order_id) → `orders` (id)
- FK (template_id) → `notification_templates` (id)

### `notification_preferences`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `event_key` | varchar(60) |  |  |  |  |
| `audience` | enum('customer','staff') |  |  |  |  |
| `channel` | enum('email','sms','whatsapp','push') |  |  |  |  |
| `is_enabled` | tinyint unsigned |  | `1` |  |  |
| `recipients` | json | yes |  |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_notification_preferences` (shop_id, event_key, audience, channel)

### `notification_templates`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `event_key` | varchar(60) |  |  |  |  |
| `channel` | enum('email','sms','whatsapp','push') |  |  |  |  |
| `category` | enum('transactional','utility','marketing','authentication') |  | `transactional` |  | Drives consent, quiet hours, pricing and which approvals apply |
| `locale` | varchar(10) |  | `en-IN` |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | varchar(300) | yes |  |  | What this template is for, for whoever inherits it |
| `subject` | varchar(255) | yes |  |  |  |
| `preheader` | varchar(255) | yes |  |  | The grey line after the subject in an inbox |
| `header_text` | varchar(160) | yes |  |  |  |
| `body` | longtext |  |  |  |  |
| `footer_text` | varchar(160) | yes |  |  |  |
| `buttons` | json | yes |  |  | WhatsApp quick replies and URL buttons |
| `provider` | varchar(40) | yes |  |  |  |
| `sender_id` | bigint unsigned | yes |  |  |  |
| `provider_template_id` | varchar(120) | yes |  |  |  |
| `dlt_template_id` | varchar(60) | yes |  |  |  |
| `approval_status` | enum('not_required','draft','pending','approved','rejected') |  | `not_required` |  | WhatsApp templates need Meta approval; SMS templates need a DLT id |
| `approval_note` | varchar(500) | yes |  |  |  |
| `approved_at` | datetime | yes |  |  |  |
| `variables` | json | yes |  |  |  |
| `sample_variables` | json | yes |  |  |  |
| `is_transactional` | tinyint unsigned |  | `1` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `last_used_at` | datetime | yes |  |  |  |
| `usage_count` | int unsigned |  | `0` |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_by_admin_id` | bigint unsigned | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_notification_templates_admin` (updated_by_admin_id)
- IX `ix_notification_templates_category` (shop_id, category, channel, is_active)
- IX `ix_notification_templates_sender` (shop_id, sender_id)
- PK `PRIMARY` (id)
- UQ `uq_notification_templates` (shop_id, event_key, channel, locale)
- FK (updated_by_admin_id) → `admin_users` (id)

### `support_macros`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `reason` | varchar(60) | yes |  |  |  |
| `body` | text |  |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `usage_count` | int unsigned |  | `0` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_support_macros_creator` (created_by_admin_id)
- IX `ix_support_macros_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (created_by_admin_id) → `admin_users` (id)

### `support_tickets`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `ticket_number` | varchar(20) |  |  |  |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `name` | varchar(160) |  |  |  |  |
| `email` | varchar(191) | yes |  |  |  |
| `phone` | varchar(15) | yes |  |  |  |
| `reason` | enum('product_guidance','order_issue','delivery','return_refund','adverse_reaction','payment','feedback','wholesale','press','other') |  | `other` |  |  |
| `subject` | varchar(255) | yes |  |  |  |
| `status` | enum('open','pending_customer','in_progress','escalated','resolved','closed') |  | `open` |  |  |
| `priority` | enum('low','normal','high','urgent') |  | `normal` |  |  |
| `channel` | enum('web_form','whatsapp','email','phone','chat','instagram') |  | `web_form` |  |  |
| `assigned_admin_id` | bigint unsigned | yes |  | IX |  |
| `first_response_at` | datetime | yes |  |  |  |
| `sla_due_at` | datetime | yes |  |  |  |
| `sla_breached` | tinyint unsigned |  | `0` |  |  |
| `resolved_at` | datetime | yes |  |  |  |
| `closed_at` | datetime | yes |  |  |  |
| `resolution_note` | text | yes |  |  |  |
| `satisfaction_rating` | tinyint unsigned | yes |  |  |  |
| `escalated_at` | datetime | yes |  |  |  |
| `escalated_to_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_support_tickets_escalatee` (escalated_to_admin_id)
- IX `ix_support_tickets_assignee` (assigned_admin_id, status)
- IX `ix_support_tickets_customer` (customer_id, created_at)
- IX `ix_support_tickets_order` (order_id)
- IX `ix_support_tickets_sla` (shop_id, sla_due_at, status)
- IX `ix_support_tickets_status` (shop_id, status, priority, created_at)
- PK `PRIMARY` (id)
- UQ `uq_support_tickets_number` (shop_id, ticket_number)
- UQ `uq_support_tickets_tenant` (shop_id, id)
- FK (assigned_admin_id) → `admin_users` (id)
- FK (customer_id) → `customers` (id)
- FK (escalated_to_admin_id) → `admin_users` (id)
- FK (order_id) → `orders` (id)

### `ticket_messages`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `ticket_id` | bigint unsigned |  |  | IX |  |
| `sender_type` | enum('customer','admin','system') |  |  |  |  |
| `sender_id` | bigint unsigned | yes |  |  |  |
| `sender_name` | varchar(160) | yes |  |  |  |
| `body` | text |  |  |  |  |
| `is_internal_note` | tinyint unsigned |  | `0` |  |  |
| `channel` | enum('web','email','whatsapp','sms','phone') |  | `web` |  |  |
| `provider_message_id` | varchar(120) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_ticket_messages_ticket_t` (shop_id, ticket_id)
- IX `ix_ticket_messages_shop` (shop_id)
- IX `ix_ticket_messages_ticket` (ticket_id, created_at)
- PK `PRIMARY` (id)
- FK (shop_id, ticket_id) → `support_tickets` (shop_id, id)

### `wishlist_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `wishlist_id` | bigint unsigned |  |  | IX |  |
| `product_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned | yes |  | IX |  |
| `note` | varchar(255) | yes |  |  |  |
| `added_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_wishlist_items_product_t` (shop_id, product_id)
- IX `fk_wishlist_items_variant` (variant_id)
- IX `fk_wishlist_items_wishlist_t` (shop_id, wishlist_id)
- IX `ix_wishlist_items_product` (product_id)
- IX `ix_wishlist_items_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_wishlist_items` (wishlist_id, product_id)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (variant_id) → `product_variants` (id)
- FK (shop_id, wishlist_id) → `wishlists` (shop_id, id)

### `wishlists`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned |  |  | UQ |  |
| `name` | varchar(120) |  | `My Wishlist` |  |  |
| `is_public` | tinyint unsigned |  | `0` |  |  |
| `share_token` | char(36) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_wishlists_customer_t` (shop_id, customer_id)
- PK `PRIMARY` (id)
- UQ `uq_wishlists_customer` (customer_id)
- UQ `uq_wishlists_share_token` (shop_id, share_token)
- UQ `uq_wishlists_tenant` (shop_id, id)
- FK (shop_id, customer_id) → `customers` (shop_id, id)

## Tax and markets

### `exchange_rates` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `currency` | char(3) |  |  | PK |  |
| `per_usd` | decimal(24,10) |  |  |  |  |
| `source` | enum('ecb','manual') |  | `ecb` |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (currency)

### `market_countries`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `market_id` | bigint unsigned |  |  | IX |  |
| `country_code` | char(2) |  |  |  |  |

- IX `ix_market_countries_market` (market_id)
- PK `PRIMARY` (id)
- UQ `uq_market_countries_country` (shop_id, country_code)
- FK (market_id) → `markets` (id)

### `markets`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `currency` | char(3) |  |  |  |  |
| `price_adjustment_percent` | decimal(6,2) |  | `0.00` |  |  |
| `rounding` | enum('none','whole','ninety_nine') |  | `none` |  |  |
| `price_list_id` | bigint unsigned | yes |  | IX |  |
| `is_primary` | tinyint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `primary_marker` | bigint unsigned | yes |  | UQ | STORED GENERATED |

- IX `fk_markets_price_list` (price_list_id)
- PK `PRIMARY` (id)
- UQ `uq_markets_name` (shop_id, name)
- UQ `uq_markets_primary` (primary_marker)
- FK (price_list_id) → `price_lists` (id)
- FK (shop_id) → `shops` (id)

### `tax_classes`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `code` | varchar(40) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `hsn_code` | varchar(12) | yes |  |  |  |
| `gst_rate` | decimal(5,2) |  | `18.00` |  |  |
| `cess_rate` | decimal(5,2) |  | `0.00` |  |  |
| `is_inclusive` | tinyint unsigned |  | `0` |  |  |
| `is_exempt` | tinyint unsigned |  | `0` |  |  |
| `is_default` | tinyint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_tax_classes_code` (shop_id, code)
- UQ `uq_tax_classes_tenant` (shop_id, id)

### `tax_rates`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `tax_class_id` | bigint unsigned |  |  | IX |  |
| `country` | char(2) |  | `IN` |  |  |
| `state_code` | varchar(10) | yes |  |  |  |
| `tax_type` | enum('cgst','sgst','igst','ugst','cess') |  |  |  |  |
| `rate` | decimal(5,2) |  |  |  |  |
| `effective_from` | date |  |  |  |  |
| `effective_to` | date | yes |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- IX `fk_tax_rates_class_t` (shop_id, tax_class_id)
- IX `ix_tax_rates_lookup` (tax_class_id, country, state_code, effective_from)
- IX `ix_tax_rates_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (shop_id, tax_class_id) → `tax_classes` (shop_id, id)

### `tax_registrations`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `country_code` | char(2) |  |  |  |  |
| `region_code` | varchar(10) | yes |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `registration_number` | varchar(60) | yes |  |  |  |
| `rate` | decimal(7,4) |  |  |  |  |
| `shipping_taxable` | tinyint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `region_key` | varchar(10) | yes |  |  | STORED GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_tax_registrations_place` (shop_id, country_code, region_key)
- FK (shop_id) → `shops` (id)

### `tax_reports`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  |  |  |
| `kind` | enum('sale','refund') |  |  |  |  |
| `reference_id` | bigint unsigned |  |  |  |  |
| `provider` | varchar(40) |  |  |  |  |
| `external_id` | varchar(80) |  |  |  |  |
| `amount` | decimal(12,2) |  |  |  |  |
| `sales_tax` | decimal(12,2) |  |  |  |  |
| `reported_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_tax_reports_order` (shop_id, order_id)
- PK `PRIMARY` (id)
- UQ `uq_tax_reports_once` (shop_id, kind, reference_id)

## Content (CMS)

### `announcement_settings`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | UQ |  |
| `is_enabled` | tinyint(1) |  | `1` |  |  |
| `display_mode` | enum('rotate','marquee') |  | `rotate` |  |  |
| `transition` | enum('fade','slide','slide_up','typewriter','none') |  | `fade` |  |  |
| `autoplay` | tinyint(1) |  | `1` |  |  |
| `rotation_seconds` | smallint unsigned |  | `30` |  |  |
| `pause_on_hover` | tinyint(1) |  | `1` |  |  |
| `marquee_speed` | smallint unsigned |  | `60` |  |  |
| `marquee_direction` | enum('left','right') |  | `left` |  |  |
| `marquee_separator` | varchar(8) |  | `•` |  |  |
| `height_mode` | enum('auto','uniform','fixed') |  | `uniform` |  |  |
| `fixed_height_desktop` | smallint unsigned |  | `40` |  |  |
| `fixed_height_mobile` | smallint unsigned |  | `44` |  |  |
| `max_lines` | tinyint unsigned |  | `1` |  |  |
| `font_size_desktop` | tinyint unsigned |  | `13` |  |  |
| `font_size_mobile` | tinyint unsigned |  | `12` |  |  |
| `font_weight` | enum('regular','medium','bold') |  | `medium` |  |  |
| `text_transform` | enum('none','uppercase') |  | `none` |  |  |
| `text_align` | enum('center','left') |  | `center` |  |  |
| `is_dismissible` | tinyint(1) |  | `0` |  |  |
| `dismiss_days` | smallint unsigned |  | `7` |  |  |
| `background_hex` | varchar(7) | yes |  |  |  |
| `background_gradient_hex` | varchar(7) | yes |  |  |  |
| `text_hex` | varchar(7) | yes |  |  |  |
| `bar_visibility` | enum('all','desktop','mobile') |  | `all` |  |  |
| `arrows_visibility` | enum('all','desktop','mobile','none') |  | `desktop` |  |  |
| `link_arrow_visibility` | enum('all','desktop','mobile','none') |  | `all` |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_announcement_settings_shop` (shop_id)

### `announcement_stats`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | PK |  |
| `announcement_id` | bigint unsigned |  |  | PK |  |
| `day` | date |  |  | PK |  |
| `views` | int unsigned |  | `0` |  |  |
| `clicks` | int unsigned |  | `0` |  |  |

- IX `fk_announcement_stats_line` (announcement_id)
- IX `ix_announcement_stats_day` (shop_id, day)
- PK `PRIMARY` (shop_id, announcement_id, day)
- FK (announcement_id) → `announcements` (id)
- FK (shop_id) → `shops` (id)

### `announcements`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `message` | varchar(255) |  |  |  |  |
| `kind` | enum('message','free_shipping') |  | `message` |  |  |
| `success_message` | varchar(255) | yes |  |  |  |
| `free_shipping_threshold` | decimal(12,2) | yes |  |  |  |
| `coupon_id` | bigint unsigned | yes |  | IX |  |
| `link_type` | enum('none','url','page','category','collection','product','article','policy') |  | `none` |  |  |
| `link_url` | varchar(500) | yes |  |  |  |
| `link_ref_id` | bigint unsigned | yes |  |  |  |
| `cta_label` | varchar(40) | yes |  |  |  |
| `starts_at` | datetime | yes |  |  |  |
| `ends_at` | datetime | yes |  |  |  |
| `show_countdown` | tinyint(1) |  | `0` |  |  |
| `background_hex` | varchar(7) | yes |  |  |  |
| `text_hex` | varchar(7) | yes |  |  |  |
| `visibility` | enum('all','desktop','mobile') |  | `all` |  |  |
| `show_on` | json | yes |  |  |  |
| `audience` | enum('all','guests','customers') |  | `all` |  |  |
| `countries` | json | yes |  |  |  |
| `is_active` | tinyint(1) |  | `1` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `idx_announcements_coupon` (coupon_id)
- IX `idx_announcements_live` (shop_id, deleted_at, is_active, sort_order)
- PK `PRIMARY` (id)
- FK (coupon_id) → `coupons` (id)

### `blog_comments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `article_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  |  |  |
| `author` | varchar(120) |  |  |  |  |
| `email` | varchar(191) |  |  |  |  |
| `body` | text |  |  |  |  |
| `status` | enum('pending','published','spam','removed') |  | `pending` |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `published_at` | datetime | yes |  |  |  |
| `moderated_by_admin_id` | bigint unsigned | yes |  |  |  |
| `moderated_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_blog_comments_article` (article_id)
- IX `ix_blog_comments_article` (shop_id, article_id, status, created_at)
- IX `ix_blog_comments_queue` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- FK (article_id) → `cms_articles` (id)
- FK (shop_id) → `shops` (id)

### `cms_article_categories`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- PK `PRIMARY` (id)
- UQ `uq_cms_article_categories_slug` (shop_id, slug)

### `cms_article_products`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `article_id` | bigint unsigned |  |  | PK |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |

- IX `fk_cms_article_products_article_t` (shop_id, article_id)
- IX `fk_cms_article_products_product_t` (shop_id, product_id)
- IX `ix_cms_article_products_product` (product_id)
- IX `ix_cms_article_products_shop` (shop_id)
- PK `PRIMARY` (article_id, product_id)
- FK (shop_id, article_id) → `cms_articles` (shop_id, id)
- FK (shop_id, product_id) → `products` (shop_id, id)

### `cms_articles`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `blog_id` | bigint unsigned |  |  | IX |  |
| `category_id` | bigint unsigned | yes |  | IX |  |
| `slug` | varchar(191) |  |  |  |  |
| `title` | varchar(191) |  |  | IX |  |
| `subtitle` | varchar(255) | yes |  |  |  |
| `excerpt` | varchar(500) | yes |  |  |  |
| `body_html` | longtext | yes |  |  |  |
| `body_json` | json | yes |  |  |  |
| `cover_media_id` | bigint unsigned | yes |  | IX |  |
| `locale` | varchar(10) |  | `en-IN` |  |  |
| `author_name` | varchar(120) | yes |  |  |  |
| `author_title` | varchar(160) | yes |  |  |  |
| `author_media_id` | bigint unsigned | yes |  | IX |  |
| `author_admin_id` | bigint unsigned | yes |  | IX |  |
| `medically_reviewed_by` | varchar(160) | yes |  |  |  |
| `reviewed_at` | date | yes |  |  |  |
| `next_review_due` | date | yes |  |  |  |
| `read_time_minutes` | tinyint unsigned | yes |  |  |  |
| `status` | enum('draft','in_review','scheduled','published','archived') |  | `draft` |  |  |
| `is_featured` | tinyint unsigned |  | `0` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `scheduled_at` | datetime | yes |  |  |  |
| `is_indexable` | tinyint unsigned |  | `1` |  |  |
| `view_count` | int unsigned |  | `0` |  |  |
| `current_version` | int unsigned |  | `1` |  |  |
| `preview_token` | char(36) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_cms_articles_author_admin` (author_admin_id)
- IX `fk_cms_articles_author_media` (author_media_id)
- IX `fk_cms_articles_blog_t` (shop_id, blog_id)
- IX `fk_cms_articles_cover` (cover_media_id)
- IX `ft_cms_articles_search` (title, excerpt, body_html)
- IX `ix_cms_articles_blog` (blog_id, status, published_at)
- IX `ix_cms_articles_category` (category_id)
- IX `ix_cms_articles_featured` (shop_id, is_featured, published_at)
- PK `PRIMARY` (id)
- UQ `uq_cms_articles_public_id` (shop_id, public_id)
- UQ `uq_cms_articles_slug_locale` (shop_id, slug, locale)
- UQ `uq_cms_articles_tenant` (shop_id, id)
- FK (author_admin_id) → `admin_users` (id)
- FK (author_media_id) → `media` (id)
- FK (shop_id, blog_id) → `cms_blogs` (shop_id, id)
- FK (category_id) → `cms_article_categories` (id)
- FK (cover_media_id) → `media` (id)

### `cms_banners`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `placement` | enum('announcement_bar','home_hero','home_carousel','category_top','pdp_strip','cart_drawer','checkout','popup','footer') |  |  |  |  |
| `title` | varchar(191) | yes |  |  |  |
| `subtitle` | varchar(255) | yes |  |  |  |
| `body` | varchar(500) | yes |  |  |  |
| `cta_label` | varchar(60) | yes |  |  |  |
| `cta_link_type` | enum('url','page','category','collection','product','article','none') |  | `none` |  |  |
| `cta_link_ref_id` | bigint unsigned | yes |  |  |  |
| `cta_url` | varchar(500) | yes |  |  |  |
| `desktop_media_id` | bigint unsigned | yes |  | IX |  |
| `mobile_media_id` | bigint unsigned | yes |  | IX |  |
| `poster_media_id` | bigint unsigned | yes |  | IX | Still shown before a video banner plays; falls back to the auto-extracted frame |
| `background_hex` | char(7) | yes |  |  |  |
| `text_hex` | char(7) | yes |  |  |  |
| `audience` | enum('all','new_visitors','returning','logged_in','guests') |  | `all` |  |  |
| `starts_at` | datetime | yes |  |  |  |
| `ends_at` | datetime | yes |  |  |  |
| `priority` | smallint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `is_dismissible` | tinyint unsigned |  | `1` |  |  |
| `impression_count` | int unsigned |  | `0` |  |  |
| `click_count` | int unsigned |  | `0` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_cms_banners_creator` (created_by_admin_id)
- IX `fk_cms_banners_desktop_media` (desktop_media_id)
- IX `fk_cms_banners_mobile_media` (mobile_media_id)
- IX `ix_cms_banners_placement_media` (shop_id, placement, is_active, desktop_media_id)
- IX `ix_cms_banners_poster_media` (poster_media_id)
- IX `ix_cms_banners_slot` (shop_id, placement, is_active, priority)
- IX `ix_cms_banners_window` (shop_id, starts_at, ends_at)
- PK `PRIMARY` (id)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (desktop_media_id) → `media` (id)
- FK (mobile_media_id) → `media` (id)
- FK (poster_media_id) → `media` (id)

### `cms_blogs`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `title` | varchar(160) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `comments_policy` | enum('disabled','moderated','published') |  | `disabled` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_cms_blogs_slug` (shop_id, slug)
- UQ `uq_cms_blogs_tenant` (shop_id, id)

### `cms_entries`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `entry_type_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(191) |  |  |  |  |
| `title` | varchar(191) |  |  |  |  |
| `data` | json |  |  |  |  |
| `status` | enum('draft','published','archived') |  | `draft` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_cms_entries_creator` (created_by_admin_id)
- IX `fk_cms_entries_type_t` (shop_id, entry_type_id)
- IX `ix_cms_entries_shop` (shop_id)
- IX `ix_cms_entries_status` (entry_type_id, status, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_cms_entries_slug` (entry_type_id, slug)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (shop_id, entry_type_id) → `cms_entry_types` (shop_id, id)

### `cms_entry_types`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(60) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `has_own_page` | tinyint unsigned |  | `0` |  |  |
| `url_prefix` | varchar(100) | yes |  |  |  |
| `field_schema` | json |  |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_cms_entry_types_slug` (shop_id, slug)
- UQ `uq_cms_entry_types_tenant` (shop_id, id)

### `cms_faq_groups`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(140) |  |  |  |  |
| `name` | varchar(160) |  |  |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- PK `PRIMARY` (id)
- UQ `uq_cms_faq_groups_slug` (shop_id, slug)

### `cms_faqs`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `group_id` | bigint unsigned | yes |  | IX |  |
| `entity_type` | varchar(40) | yes |  |  |  |
| `entity_id` | bigint unsigned | yes |  |  |  |
| `question` | varchar(500) |  |  |  |  |
| `answer` | text |  |  |  |  |
| `claim_id` | bigint unsigned | yes |  | IX |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_published` | tinyint unsigned |  | `1` |  |  |
| `is_indexable` | tinyint unsigned |  | `1` |  |  |
| `helpful_count` | int unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_cms_faqs_claim` (claim_id)
- IX `ix_cms_faqs_entity` (shop_id, entity_type, entity_id, sort_order)
- IX `ix_cms_faqs_group` (group_id, sort_order)
- PK `PRIMARY` (id)
- FK (claim_id) → `claims` (id)
- FK (group_id) → `cms_faq_groups` (id)

### `cms_menu_items`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `menu_id` | bigint unsigned |  |  | IX |  |
| `parent_id` | bigint unsigned | yes |  | IX |  |
| `label` | varchar(120) |  |  |  |  |
| `link_type` | enum('url','page','category','collection','product','article','policy','ingredient','routine','none') |  | `url` |  |  |
| `link_ref_id` | bigint unsigned | yes |  |  |  |
| `url` | varchar(500) | yes |  |  |  |
| `icon_media_id` | bigint unsigned | yes |  | IX |  |
| `image_media_id` | bigint unsigned | yes |  | IX |  |
| `badge_label` | varchar(30) | yes |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `opens_new_tab` | tinyint unsigned |  | `0` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |

- IX `fk_cms_menu_items_icon` (icon_media_id)
- IX `fk_cms_menu_items_image` (image_media_id)
- IX `fk_cms_menu_items_menu_t` (shop_id, menu_id)
- IX `fk_cms_menu_items_parent` (parent_id)
- IX `fk_cms_menu_items_parent_t` (shop_id, parent_id)
- IX `ix_cms_menu_items_menu` (menu_id, parent_id, sort_order)
- IX `ix_cms_menu_items_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_cms_menu_items_tenant` (shop_id, id)
- FK (icon_media_id) → `media` (id)
- FK (image_media_id) → `media` (id)
- FK (shop_id, menu_id) → `cms_menus` (shop_id, id)
- FK (shop_id, parent_id) → `cms_menu_items` (shop_id, id)

### `cms_menus`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(60) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_cms_menus_slug` (shop_id, slug)
- UQ `uq_cms_menus_tenant` (shop_id, id)

### `cms_page_sections`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `page_id` | bigint unsigned |  |  | IX |  |
| `section_key` | varchar(60) |  |  |  |  |
| `name` | varchar(120) | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_enabled` | tinyint unsigned |  | `1` |  |  |
| `settings` | json | yes |  |  |  |
| `background` | varchar(40) | yes |  |  |  |
| `padding_top` | enum('none','sm','md','lg','xl') |  | `md` |  |  |
| `padding_bottom` | enum('none','sm','md','lg','xl') |  | `md` |  |  |
| `visible_from` | datetime | yes |  |  |  |
| `visible_until` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_cms_page_sections_page_t` (shop_id, page_id)
- IX `ix_cms_page_sections_key` (shop_id, section_key)
- IX `ix_cms_page_sections_page` (page_id, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_cms_page_sections_tenant` (shop_id, id)
- FK (shop_id, page_id) → `cms_pages` (shop_id, id)

### `cms_pages`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `parent_id` | bigint unsigned | yes |  | IX |  |
| `slug` | varchar(191) |  |  |  |  |
| `full_path` | varchar(500) |  |  |  |  |
| `title` | varchar(191) |  |  |  |  |
| `subtitle` | varchar(255) | yes |  |  |  |
| `page_type` | enum('home','standard','landing','policy','about','support','concern','ingredient_library','custom') |  | `standard` |  |  |
| `template` | varchar(60) |  | `default` |  |  |
| `locale` | varchar(10) |  | `en-IN` |  |  |
| `body_html` | longtext | yes |  |  |  |
| `body_json` | json | yes |  |  |  |
| `hero_media_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('draft','in_review','scheduled','published','archived') |  | `draft` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `scheduled_at` | datetime | yes |  |  |  |
| `unpublish_at` | datetime | yes |  |  |  |
| `requires_legal_review` | tinyint unsigned |  | `0` |  |  |
| `reviewed_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `reviewed_at` | datetime | yes |  |  |  |
| `review_due_at` | date | yes |  |  |  |
| `is_indexable` | tinyint unsigned |  | `1` |  |  |
| `show_in_sitemap` | tinyint unsigned |  | `1` |  |  |
| `preview_token` | char(36) | yes |  |  |  |
| `current_version` | int unsigned |  | `1` |  |  |
| `view_count` | int unsigned |  | `0` |  |  |
| `author_admin_id` | bigint unsigned | yes |  | IX |  |
| `updated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_cms_pages_author` (author_admin_id)
- IX `fk_cms_pages_hero` (hero_media_id)
- IX `fk_cms_pages_reviewer` (reviewed_by_admin_id)
- IX `fk_cms_pages_updater` (updated_by_admin_id)
- IX `ix_cms_pages_parent` (parent_id)
- IX `ix_cms_pages_scheduled` (shop_id, status, scheduled_at)
- IX `ix_cms_pages_status` (shop_id, status, published_at)
- IX `ix_cms_pages_type` (shop_id, page_type)
- PK `PRIMARY` (id)
- UQ `uq_cms_pages_public_id` (shop_id, public_id)
- UQ `uq_cms_pages_slug_locale` (shop_id, slug, locale)
- UQ `uq_cms_pages_tenant` (shop_id, id)
- FK (author_admin_id) → `admin_users` (id)
- FK (hero_media_id) → `media` (id)
- FK (parent_id) → `cms_pages` (id)
- FK (reviewed_by_admin_id) → `admin_users` (id)
- FK (updated_by_admin_id) → `admin_users` (id)

### `cms_redirects`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `from_path` | varchar(500) |  |  |  |  |
| `to_path` | varchar(500) |  |  |  |  |
| `status_code` | smallint unsigned |  | `301` |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `is_auto` | tinyint unsigned |  | `0` |  |  |
| `hit_count` | int unsigned |  | `0` |  |  |
| `last_hit_at` | datetime | yes |  |  |  |
| `note` | varchar(255) | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_cms_redirects_creator` (created_by_admin_id)
- IX `ix_cms_redirects_active` (shop_id, is_active)
- PK `PRIMARY` (id)
- UQ `uq_cms_redirects_from` (shop_id, from_path)
- FK (created_by_admin_id) → `admin_users` (id)

### `cms_revisions`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `entity_type` | enum('page','article','product','banner','menu','entry','ingredient') |  |  |  |  |
| `entity_id` | bigint unsigned |  |  |  |  |
| `version` | int unsigned |  |  |  |  |
| `snapshot` | json |  |  |  |  |
| `change_note` | varchar(255) | yes |  |  |  |
| `is_published_version` | tinyint unsigned |  | `0` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_cms_revisions_admin` (created_by_admin_id)
- IX `ix_cms_revisions_entity` (shop_id, entity_type, entity_id, created_at)
- PK `PRIMARY` (id)
- UQ `uq_cms_revisions` (shop_id, entity_type, entity_id, version)
- FK (created_by_admin_id) → `admin_users` (id)

### `cms_section_blocks`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `section_id` | bigint unsigned |  |  | IX |  |
| `block_type` | varchar(60) |  |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_enabled` | tinyint unsigned |  | `1` |  |  |
| `heading` | varchar(255) | yes |  |  |  |
| `body` | text | yes |  |  |  |
| `media_id` | bigint unsigned | yes |  | IX |  |
| `link_type` | enum('none','url','page','product','collection','category','article') |  | `none` |  |  |
| `link_ref_id` | bigint unsigned | yes |  |  |  |
| `link_url` | varchar(500) | yes |  |  |  |
| `cta_label` | varchar(60) | yes |  |  |  |
| `claim_id` | bigint unsigned | yes |  | IX |  |
| `settings` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_cms_section_blocks_claim` (claim_id)
- IX `fk_cms_section_blocks_media` (media_id)
- IX `fk_cms_section_blocks_section_t` (shop_id, section_id)
- IX `ix_cms_section_blocks_section` (section_id, sort_order)
- IX `ix_cms_section_blocks_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (claim_id) → `claims` (id)
- FK (media_id) → `media` (id)
- FK (shop_id, section_id) → `cms_page_sections` (shop_id, id)

### `content_block_hotspots`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `block_id` | bigint unsigned |  |  | IX |  |
| `x_pct` | decimal(5,2) |  |  |  | 0-100, from the left edge |
| `y_pct` | decimal(5,2) |  |  |  | 0-100, from the top edge |
| `label` | varchar(120) |  |  |  | Cap \| highlight milk |
| `body` | varchar(500) | yes |  |  | 50% PCR \| apply to bare skin… |
| `product_id` | bigint unsigned | yes |  | IX | so the callout is clickable |
| `media_id` | bigint unsigned | yes |  | IX | the blob shown beside the label |
| `line_direction` | enum('left','right','up','down') |  | `right` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_content_hotspots_block_t` (shop_id, block_id)
- IX `fk_content_hotspots_media` (media_id)
- IX `fk_content_hotspots_product` (product_id)
- IX `ix_content_block_hotspots_shop` (shop_id)
- IX `ix_content_hotspots_block` (block_id, sort_order)
- PK `PRIMARY` (id)
- FK (shop_id, block_id) → `content_section_blocks` (shop_id, id)
- FK (media_id) → `media` (id)
- FK (product_id) → `products` (id)

### `content_section_assignments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `section_id` | bigint unsigned |  |  | IX |  |
| `owner_type` | enum('product','page','collection','template') |  |  |  |  |
| `owner_id` | bigint unsigned |  |  |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_enabled` | tinyint unsigned |  | `1` |  |  |
| `visible_from` | datetime | yes |  |  |  |
| `visible_until` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_content_assignments_section_t` (shop_id, section_id)
- IX `ix_content_assignments_owner` (shop_id, owner_type, owner_id, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_content_assignment` (section_id, owner_type, owner_id)
- FK (shop_id, section_id) → `content_sections` (shop_id, id)

### `content_section_blocks`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `section_id` | bigint unsigned |  |  | IX |  |
| `block_type` | varchar(60) |  |  |  | stat\|look\|diagram\|feature\|step |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_enabled` | tinyint unsigned |  | `1` |  |  |
| `heading` | varchar(255) | yes |  |  | 100% — or: highlight milk |
| `body` | text | yes |  |  |  |
| `media_id` | bigint unsigned | yes |  | IX | the photograph, or the film |
| `secondary_media_id` | bigint unsigned | yes |  | IX | the swatch beside the copy |
| `creator_id` | bigint unsigned | yes |  | IX | whose look this is |
| `credit_creator` | tinyint(1) |  | `1` |  | Carry the credit on this particular use |
| `claim_id` | bigint unsigned | yes |  | IX |  |
| `option_value_id` | bigint unsigned | yes |  | IX | the shade this look wears |
| `link_type` | enum('none','url','product','collection','category','page','article') |  | `none` |  |  |
| `link_ref_id` | bigint unsigned | yes |  |  |  |
| `link_url` | varchar(500) | yes |  |  |  |
| `cta_label` | varchar(60) | yes |  |  |  |
| `settings` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_content_blocks_claim` (claim_id)
- IX `fk_content_blocks_creator` (creator_id)
- IX `fk_content_blocks_media` (media_id)
- IX `fk_content_blocks_option_value` (option_value_id)
- IX `fk_content_blocks_secondary_media` (secondary_media_id)
- IX `fk_content_blocks_section_t` (shop_id, section_id)
- IX `ix_content_section_blocks_section` (section_id, sort_order)
- IX `ix_content_section_blocks_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_content_section_blocks_tenant` (shop_id, id)
- FK (claim_id) → `claims` (id)
- FK (creator_id) → `creators` (id)
- FK (media_id) → `media` (id)
- FK (option_value_id) → `product_option_values` (id)
- FK (secondary_media_id) → `media` (id)
- FK (shop_id, section_id) → `content_sections` (shop_id, id)

### `content_sections`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `section_key` | varchar(60) |  |  |  | claims\|packaging\|model_routine\|feature\|how_to |
| `surface` | enum('product','page') |  | `product` |  |  |
| `name` | varchar(120) |  |  |  | admin-facing label |
| `heading` | varchar(255) | yes |  |  | less harm, more pearl. |
| `standfirst` | varchar(500) | yes |  |  |  |
| `footnote` | varchar(500) | yes |  |  | used when no claim supplies one |
| `layout` | varchar(40) |  | `split` |  | split\|stacked\|carousel\|grid |
| `background` | varchar(40) | yes |  |  |  |
| `padding_top` | enum('none','sm','md','lg','xl') |  | `md` |  |  |
| `padding_bottom` | enum('none','sm','md','lg','xl') |  | `md` |  |  |
| `settings` | json | yes |  |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_content_sections_admin` (created_by_admin_id)
- IX `idx_content_sections_surface` (shop_id, surface, deleted_at)
- IX `ix_content_sections_key` (shop_id, section_key, deleted_at)
- PK `PRIMARY` (id)
- UQ `uq_content_sections_tenant` (shop_id, id)
- FK (created_by_admin_id) → `admin_users` (id)

### `creators`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `slug` | varchar(160) |  |  |  |  |
| `name` | varchar(160) |  |  |  |  |
| `handle` | varchar(80) | yes |  |  | @name, shown under the portrait |
| `role` | varchar(120) | yes |  |  | Founder, Makeup artist, Creator |
| `bio` | varchar(1000) | yes |  |  |  |
| `portrait_media_id` | bigint unsigned | yes |  | IX |  |
| `instagram_url` | varchar(500) | yes |  |  |  |
| `youtube_url` | varchar(500) | yes |  |  |  |
| `tiktok_url` | varchar(500) | yes |  |  |  |
| `website_url` | varchar(500) | yes |  |  |  |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `is_identity_public` | tinyint(1) |  | `1` |  | May this person be named on the site at all |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_creators_admin` (created_by_admin_id)
- IX `fk_creators_portrait` (portrait_media_id)
- IX `ix_creators_active` (shop_id, is_active, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_creators_public_id` (shop_id, public_id)
- UQ `uq_creators_slug` (shop_id, slug)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (portrait_media_id) → `media` (id)

### `menu_item_analytics` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `menu_item_id` | bigint unsigned |  |  | IX |  |
| `user_id` | bigint unsigned |  |  | IX |  |
| `clicked_at` | datetime |  | `CURRENT_TIMESTAMP` | IX | DEFAULT_GENERATED |
| `session_id` | varchar(100) | yes |  |  |  |
| `referrer_route` | varchar(255) | yes |  |  | Where user came from |
| `device_type` | enum('desktop','tablet','mobile') | yes |  |  |  |

- IX `idx_analytics_clicked_at` (clicked_at)
- IX `idx_analytics_menu_item` (menu_item_id)
- IX `idx_analytics_user` (user_id)
- PK `PRIMARY` (id)
- FK (menu_item_id) → `menu_items` (id)
- FK (user_id) → `admin_users` (id)

### `menu_item_permissions` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `menu_item_id` | bigint unsigned |  |  | PK |  |
| `permission_id` | bigint unsigned |  |  | PK |  |

- IX `ix_menu_item_permissions_permission` (permission_id)
- PK `PRIMARY` (menu_item_id, permission_id)
- FK (menu_item_id) → `menu_items` (id)
- FK (permission_id) → `permissions` (id)

### `menu_items` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `parent_id` | bigint unsigned | yes |  | IX |  |
| `menu_key` | varchar(60) |  |  | UQ |  |
| `title` | varchar(120) |  |  |  |  |
| `subtitle` | varchar(191) | yes |  |  |  |
| `hover_description` | varchar(255) | yes |  |  | Tooltip on hover |
| `keyboard_shortcut` | varchar(20) | yes |  |  | e.g., "Ctrl+Shift+P" |
| `icon` | varchar(60) | yes |  |  |  |
| `icon_color` | varchar(20) | yes |  |  | Icon color (hex or theme color) |
| `icon_type` | enum('material','custom','emoji') |  | `material` |  |  |
| `route` | varchar(191) | yes |  |  |  |
| `prefetch_data` | tinyint unsigned |  | `0` |  | Prefetch route data on hover |
| `cache_duration` | int unsigned | yes |  |  | Cache duration in seconds |
| `active_match` | varchar(500) | yes |  |  |  |
| `section` | varchar(60) | yes |  | IX |  |
| `group_key` | varchar(60) | yes |  | IX | Group items together (collapsible groups) |
| `divider_after` | tinyint unsigned |  | `0` |  | Show divider after this item |
| `badge_key` | varchar(40) | yes |  |  |  |
| `analytics_key` | varchar(60) | yes |  |  | Track clicks in analytics |
| `metadata` | json | yes |  |  | Additional flexible data |
| `badge_variant` | enum('default','info','warning','error','success') |  | `default` |  |  |
| `sort_order` | smallint unsigned |  | `0` | IX |  |
| `status` | enum('available','coming_soon','hidden') |  | `available` |  |  |
| `is_active` | tinyint unsigned |  | `1` | IX |  |
| `is_visible` | tinyint unsigned |  | `1` | IX | If 0, hidden from all users |
| `show_in_collapsed` | tinyint unsigned |  | `1` |  | Show in mini/icon-only sidebar |
| `is_pinnable` | tinyint unsigned |  | `1` |  | Can user pin this item |
| `requires_super_admin` | tinyint unsigned |  | `0` |  |  |
| `min_role_level` | tinyint unsigned | yes |  |  | Minimum role level (1=viewer, 5=admin, 10=superadmin) |
| `allowed_roles` | json | yes |  |  | Array of role IDs that can see this |
| `feature_flag` | varchar(80) | yes |  |  |  |
| `show_if_feature` | varchar(80) | yes |  |  | Only show if feature enabled |
| `hide_if_feature` | varchar(80) | yes |  |  | Hide if feature enabled |
| `show_if_permission` | varchar(80) | yes |  |  | Only show if user has permission |
| `is_external` | tinyint unsigned |  | `0` |  |  |
| `opens_new_tab` | tinyint unsigned |  | `0` |  |  |
| `is_system` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `idx_menu_items_group_key` (group_key)
- IX `idx_menu_items_is_visible` (is_visible)
- IX `idx_menu_items_parent_active` (parent_id, is_active)
- IX `idx_menu_items_section` (section)
- IX `idx_menu_items_sort_order` (sort_order)
- IX `ix_menu_items_parent` (parent_id, sort_order)
- IX `ix_menu_items_visible` (is_active, status, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_menu_items_key` (menu_key)
- FK (parent_id) → `menu_items` (id)

### `page_templates`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `template_key` | varchar(60) |  |  |  |  |
| `name` | varchar(120) |  |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `is_system` | tinyint(1) |  | `0` |  |  |
| `is_active` | tinyint(1) |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_page_templates_key` (shop_id, template_key)

### `shelf_products`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `shelf_id` | bigint unsigned |  |  | PK |  |
| `product_id` | bigint unsigned |  |  | PK |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `added_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_shelf_products_product_t` (shop_id, product_id)
- IX `fk_shelf_products_shelf_t` (shop_id, shelf_id)
- IX `idx_shelf_products_order` (shelf_id, sort_order)
- IX `idx_shelf_products_product` (product_id)
- IX `ix_shelf_products_shop` (shop_id)
- PK `PRIMARY` (shelf_id, product_id)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (shop_id, shelf_id) → `shelves` (shop_id, id)

### `shelves`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `title` | varchar(120) |  |  |  |  |
| `eyebrow` | varchar(60) | yes |  |  |  |
| `subtitle` | varchar(240) | yes |  |  |  |
| `placement` | enum('home','shop','category','collection','product') |  | `home` |  |  |
| `scope_ref_id` | bigint unsigned | yes |  |  |  |
| `layout` | enum('carousel','grid','spotlight','ranked') |  | `carousel` |  |  |
| `source` | enum('manual','bestselling','new_arrivals','most_loved','most_repurchased','trending','top_rated','featured','collection') |  | `manual` |  |  |
| `source_collection_id` | bigint unsigned | yes |  | IX |  |
| `window_days` | smallint unsigned | yes |  |  |  |
| `max_products` | tinyint unsigned |  | `8` |  |  |
| `include_sold_out` | tinyint(1) |  | `0` |  |  |
| `tone` | enum('ivory','cream') |  | `ivory` |  |  |
| `cta_label` | varchar(40) | yes |  |  |  |
| `link_type` | enum('none','url','page','category','collection','product','article','policy') |  | `none` |  |  |
| `link_url` | varchar(500) | yes |  |  |  |
| `link_ref_id` | bigint unsigned | yes |  |  |  |
| `starts_at` | datetime | yes |  |  |  |
| `ends_at` | datetime | yes |  |  |  |
| `is_active` | tinyint(1) |  | `1` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `idx_shelves_collection` (source_collection_id)
- IX `idx_shelves_live` (shop_id, deleted_at, is_active, placement, scope_ref_id, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_shelves_tenant` (shop_id, id)
- FK (source_collection_id) → `collections` (id)

### `sidebar_sections` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `key` | varchar(60) |  |  | UQ | Unique section identifier |
| `title` | varchar(120) |  |  |  |  |
| `description` | varchar(255) | yes |  |  |  |
| `icon` | varchar(60) | yes |  |  |  |
| `color` | varchar(20) | yes |  |  | Section accent color |
| `is_collapsible` | tinyint unsigned |  | `1` |  |  |
| `is_collapsed_by_default` | tinyint unsigned |  | `0` |  |  |
| `show_header` | tinyint unsigned |  | `1` |  | Show section header or just items |
| `is_active` | tinyint unsigned |  | `1` |  |  |
| `requires_super_admin` | tinyint unsigned |  | `0` |  |  |
| `min_role_level` | tinyint unsigned | yes |  |  |  |
| `sort_order` | smallint unsigned |  | `0` | IX |  |
| `metadata` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `idx_sections_key` (key)
- IX `idx_sections_sort_order` (sort_order)
- UQ `key` (key)
- PK `PRIMARY` (id)

## Reviews

### `review_invitations`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `order_id` | bigint unsigned |  |  | IX |  |
| `order_item_id` | bigint unsigned |  |  | UQ |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `token` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `channel` | enum('email','sms','whatsapp') |  | `email` |  |  |
| `status` | enum('scheduled','sent','opened','submitted','expired') |  | `scheduled` |  |  |
| `scheduled_for` | datetime | yes |  |  |  |
| `sent_at` | datetime | yes |  |  |  |
| `opened_at` | datetime | yes |  |  |  |
| `submitted_at` | datetime | yes |  |  |  |
| `expires_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_review_invitations_customer` (customer_id)
- IX `fk_review_invitations_item_t` (shop_id, order_item_id)
- IX `fk_review_invitations_order` (order_id)
- IX `fk_review_invitations_order_t` (shop_id, order_id)
- IX `ix_review_invitations_status` (shop_id, status, scheduled_for)
- PK `PRIMARY` (id)
- UQ `uq_review_invitations_item` (order_item_id)
- UQ `uq_review_invitations_token` (shop_id, token)
- FK (customer_id) → `customers` (id)
- FK (shop_id, order_item_id) → `order_items` (shop_id, id)
- FK (shop_id, order_id) → `orders` (shop_id, id)

### `review_replies`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `review_id` | bigint unsigned |  |  | IX |  |
| `admin_user_id` | bigint unsigned | yes |  | IX |  |
| `display_name` | varchar(120) |  | `Veylor` |  |  |
| `body` | text |  |  |  |  |
| `is_public` | tinyint unsigned |  | `1` |  |  |
| `published_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_review_replies_admin` (admin_user_id)
- IX `fk_review_replies_review_t` (shop_id, review_id)
- IX `ix_review_replies_review` (review_id)
- IX `ix_review_replies_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (admin_user_id) → `admin_users` (id)
- FK (shop_id, review_id) → `reviews` (shop_id, id)

### `review_reports`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `review_id` | bigint unsigned |  |  | IX |  |
| `reporter_customer_id` | bigint unsigned | yes |  | IX |  |
| `reporter_hash` | char(64) | yes |  |  |  |
| `reason` | enum('spam','offensive','fake','off_topic','personal_data','other') |  |  |  |  |
| `detail` | varchar(500) | yes |  |  |  |
| `status` | enum('open','reviewed','dismissed','actioned') |  | `open` |  |  |
| `handled_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_review_reports_admin` (handled_by_admin_id)
- IX `fk_review_reports_customer` (reporter_customer_id)
- IX `fk_review_reports_review_t` (shop_id, review_id)
- IX `ix_review_reports_review` (review_id, status)
- IX `ix_review_reports_shop` (shop_id)
- PK `PRIMARY` (id)
- FK (handled_by_admin_id) → `admin_users` (id)
- FK (reporter_customer_id) → `customers` (id)
- FK (shop_id, review_id) → `reviews` (shop_id, id)

### `review_votes`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `review_id` | bigint unsigned |  |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `voter_hash` | char(64) |  |  |  |  |
| `is_helpful` | tinyint unsigned |  | `1` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_review_votes_review_t` (shop_id, review_id)
- IX `ix_review_votes_customer` (customer_id)
- IX `ix_review_votes_shop` (shop_id)
- PK `PRIMARY` (id)
- UQ `uq_review_votes` (review_id, voter_hash)
- FK (customer_id) → `customers` (id)
- FK (shop_id, review_id) → `reviews` (shop_id, id)

### `reviews`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `product_id` | bigint unsigned |  |  | IX |  |
| `variant_id` | bigint unsigned | yes |  | IX |  |
| `customer_id` | bigint unsigned | yes |  | IX |  |
| `order_id` | bigint unsigned | yes |  | IX |  |
| `order_item_id` | bigint unsigned | yes |  | UQ |  |
| `author_name` | varchar(120) |  |  |  |  |
| `author_location` | varchar(120) | yes |  |  |  |
| `author_email` | varchar(191) | yes |  |  |  |
| `rating` | tinyint unsigned |  |  |  |  |
| `title` | varchar(200) | yes |  |  |  |
| `body` | text | yes |  |  |  |
| `skin_type_id` | bigint unsigned | yes |  | IX |  |
| `concern_id` | bigint unsigned | yes |  | IX |  |
| `age_range` | varchar(20) | yes |  |  |  |
| `usage_duration` | varchar(40) | yes |  |  |  |
| `would_recommend` | tinyint unsigned | yes |  |  |  |
| `is_verified_purchase` | tinyint unsigned |  | `0` |  |  |
| `is_incentivized` | tinyint unsigned |  | `0` |  |  |
| `has_media` | tinyint unsigned |  | `0` |  |  |
| `status` | enum('pending','approved','rejected','spam','hidden') |  | `pending` |  |  |
| `rejection_reason` | varchar(255) | yes |  |  |  |
| `moderated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `moderated_at` | datetime | yes |  |  |  |
| `moderation_note` | varchar(500) | yes |  |  |  |
| `flagged_adverse_reaction` | tinyint unsigned |  | `0` |  |  |
| `helpful_count` | int unsigned |  | `0` |  |  |
| `not_helpful_count` | int unsigned |  | `0` |  |  |
| `report_count` | smallint unsigned |  | `0` |  |  |
| `source` | enum('web','email_invite','whatsapp','import','admin') |  | `web` |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `published_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_reviews_concern` (concern_id)
- IX `fk_reviews_moderator` (moderated_by_admin_id)
- IX `fk_reviews_order` (order_id)
- IX `fk_reviews_product_t` (shop_id, product_id)
- IX `fk_reviews_skin_type` (skin_type_id)
- IX `fk_reviews_variant` (variant_id)
- IX `ix_reviews_customer` (customer_id, created_at)
- IX `ix_reviews_moderation` (shop_id, status, created_at)
- IX `ix_reviews_product_display` (product_id, status, published_at)
- IX `ix_reviews_rating` (product_id, rating)
- PK `PRIMARY` (id)
- UQ `uq_reviews_order_item` (order_item_id)
- UQ `uq_reviews_public_id` (shop_id, public_id)
- UQ `uq_reviews_tenant` (shop_id, id)
- FK (concern_id) → `skin_concerns` (id)
- FK (customer_id) → `customers` (id)
- FK (moderated_by_admin_id) → `admin_users` (id)
- FK (order_id) → `orders` (id)
- FK (order_item_id) → `order_items` (id)
- FK (shop_id, product_id) → `products` (shop_id, id)
- FK (skin_type_id) → `skin_types` (id)
- FK (variant_id) → `product_variants` (id)

## Settings, audit and system

### `audit_logs`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned | yes |  | IX |  |
| `actor_type` | enum('admin','customer','system','webhook','job') |  | `admin` |  |  |
| `actor_id` | bigint unsigned | yes |  |  |  |
| `actor_label` | varchar(191) | yes |  |  |  |
| `action` | varchar(80) |  |  |  |  |
| `entity_type` | varchar(60) | yes |  |  |  |
| `entity_id` | bigint unsigned | yes |  |  |  |
| `summary` | varchar(255) | yes |  |  |  |
| `changes` | json | yes |  |  |  |
| `context` | json | yes |  |  |  |
| `ip` | varbinary(16) | yes |  |  |  |
| `user_agent` | varchar(255) | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `ix_audit_logs_action` (shop_id, action, created_at)
- IX `ix_audit_logs_actor` (shop_id, actor_type, actor_id, created_at)
- IX `ix_audit_logs_created` (shop_id, created_at)
- IX `ix_audit_logs_entity` (shop_id, entity_type, entity_id, created_at)
- PK `PRIMARY` (id)

### `export_jobs`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `job_type` | enum('products','inventory','customers','orders','reviews','coupons','gst_report','payouts') |  |  |  |  |
| `status` | enum('queued','running','completed','failed','expired') |  | `queued` |  |  |
| `filters` | json | yes |  |  |  |
| `columns` | json | yes |  |  |  |
| `contains_personal_data` | tinyint unsigned |  | `0` |  |  |
| `row_count` | int unsigned |  | `0` |  |  |
| `result_media_id` | bigint unsigned | yes |  | IX |  |
| `download_count` | smallint unsigned |  | `0` |  |  |
| `expires_at` | datetime | yes |  |  |  |
| `requested_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `justification` | varchar(255) | yes |  |  |  |
| `started_at` | datetime | yes |  |  |  |
| `finished_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_export_jobs_result` (result_media_id)
- IX `ix_export_jobs_admin` (requested_by_admin_id, created_at)
- IX `ix_export_jobs_status` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- FK (requested_by_admin_id) → `admin_users` (id)
- FK (result_media_id) → `media` (id)

### `import_jobs`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `job_type` | enum('products','variants','inventory','customers','orders','pincodes','media','redirects','reviews') |  |  |  |  |
| `source_media_id` | bigint unsigned | yes |  | IX |  |
| `status` | enum('queued','validating','running','completed','failed','cancelled') |  | `queued` |  |  |
| `total_rows` | int unsigned |  | `0` |  |  |
| `processed_rows` | int unsigned |  | `0` |  |  |
| `success_rows` | int unsigned |  | `0` |  |  |
| `error_rows` | int unsigned |  | `0` |  |  |
| `error_report_media_id` | bigint unsigned | yes |  | IX |  |
| `options` | json | yes |  |  |  |
| `started_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `started_at` | datetime | yes |  |  |  |
| `finished_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_import_jobs_admin` (started_by_admin_id)
- IX `fk_import_jobs_error_report` (error_report_media_id)
- IX `fk_import_jobs_source` (source_media_id)
- IX `ix_import_jobs_status` (shop_id, status, created_at)
- PK `PRIMARY` (id)
- FK (started_by_admin_id) → `admin_users` (id)
- FK (error_report_media_id) → `media` (id)
- FK (source_media_id) → `media` (id)

### `media`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `public_id` | char(36) |  | `uuid()` |  | DEFAULT_GENERATED |
| `folder_id` | bigint unsigned | yes |  | IX |  |
| `disk` | enum('local','s3','r2','gcs','supabase','cloudinary','external') |  | `local` |  |  |
| `storage_key` | varchar(500) |  |  |  |  |
| `absolute_url` | varchar(1000) | yes |  |  |  |
| `original_filename` | varchar(255) |  |  |  |  |
| `extension` | varchar(12) |  |  |  |  |
| `mime_type` | varchar(120) |  |  |  |  |
| `media_type` | enum('image','video','audio','document','other') |  | `image` |  |  |
| `size_bytes` | bigint unsigned |  | `0` |  |  |
| `width` | mediumint unsigned | yes |  |  |  |
| `height` | mediumint unsigned | yes |  |  |  |
| `aspect_ratio` | decimal(8,4) | yes |  |  |  |
| `duration_ms` | int unsigned | yes |  |  |  |
| `has_alpha` | tinyint unsigned |  | `0` |  |  |
| `checksum_sha256` | char(64) | yes |  |  |  |
| `alt_text` | varchar(255) | yes |  |  |  |
| `title` | varchar(255) | yes |  |  |  |
| `caption` | varchar(500) | yes |  |  |  |
| `credit` | varchar(255) | yes |  |  |  |
| `usage_rights` | enum('owned','licensed','ugc_permissioned','stock','unknown') |  | `owned` |  |  |
| `rights_expires_at` | date | yes |  |  |  |
| `focal_x` | decimal(5,4) |  | `0.5000` |  |  |
| `focal_y` | decimal(5,4) |  | `0.5000` |  |  |
| `dominant_color` | char(7) | yes |  |  |  |
| `blurhash` | varchar(64) | yes |  |  |  |
| `placeholder_uri` | varchar(2000) | yes |  |  |  |
| `status` | enum('uploading','processing','ready','failed','quarantined') |  | `processing` |  |  |
| `processing_error` | varchar(500) | yes |  |  |  |
| `variants_generated_at` | datetime | yes |  |  |  |
| `virus_scanned_at` | datetime | yes |  |  |  |
| `source` | enum('admin_upload','customer_upload','import','seed','api') |  | `admin_upload` |  |  |
| `uploaded_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `uploaded_by_customer_id` | bigint unsigned | yes |  | IX |  |
| `usage_count` | int unsigned |  | `0` |  |  |
| `last_used_at` | datetime | yes |  |  |  |
| `previous_disk` | varchar(20) | yes |  |  |  |
| `previous_key` | varchar(500) | yes |  |  |  |
| `migrated_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |
| `deleted_at` | datetime | yes |  |  |  |

- IX `fk_media_uploader_admin` (uploaded_by_admin_id)
- IX `fk_media_uploader_customer` (uploaded_by_customer_id)
- IX `ix_media_checksum` (shop_id, checksum_sha256)
- IX `ix_media_folder` (folder_id, created_at)
- IX `ix_media_migration` (shop_id, disk, migrated_at)
- IX `ix_media_orphans` (shop_id, usage_count, created_at)
- IX `ix_media_status` (shop_id, status, created_at)
- IX `ix_media_type` (shop_id, media_type, deleted_at)
- PK `PRIMARY` (id)
- UQ `uq_media_disk_key` (shop_id, disk, storage_key)
- UQ `uq_media_public_id` (shop_id, public_id)
- UQ `uq_media_tenant` (shop_id, id)
- FK (folder_id) → `media_folders` (id)
- FK (uploaded_by_admin_id) → `admin_users` (id)
- FK (uploaded_by_customer_id) → `customers` (id)

### `media_attachments`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `media_id` | bigint unsigned |  |  | IX |  |
| `attachable_type` | varchar(60) |  |  | IX |  |
| `attachable_id` | bigint unsigned |  |  |  |  |
| `collection` | varchar(50) |  | `gallery` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `is_primary` | tinyint unsigned |  | `0` |  |  |
| `alt_override` | varchar(255) | yes |  |  |  |
| `caption_override` | varchar(500) | yes |  |  |  |
| `link_url` | varchar(500) | yes |  |  |  |
| `meta` | json | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_media_attachments_media_t` (shop_id, media_id)
- IX `ix_media_attachments_media` (media_id)
- IX `ix_media_attachments_owner` (shop_id, attachable_type, attachable_id, collection, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_media_attachment` (attachable_type, attachable_id, collection, media_id)
- FK (shop_id, media_id) → `media` (shop_id, id)

### `media_folders`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `parent_id` | bigint unsigned | yes |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `slug` | varchar(140) |  |  |  |  |
| `path` | varchar(500) |  |  |  |  |
| `depth` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `media_count` | int unsigned |  | `0` |  |  |
| `created_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_media_folders_creator` (created_by_admin_id)
- IX `fk_media_folders_parent_t` (shop_id, parent_id)
- IX `ix_media_folders_path` (shop_id, path)
- PK `PRIMARY` (id)
- UQ `uq_media_folders_sibling` (parent_id, slug)
- UQ `uq_media_folders_tenant` (shop_id, id)
- FK (created_by_admin_id) → `admin_users` (id)
- FK (shop_id, parent_id) → `media_folders` (shop_id, id)

### `media_migrations` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `from_disk` | varchar(20) |  |  |  |  |
| `to_disk` | varchar(20) |  |  |  |  |
| `status` | enum('pending','running','completed','failed','rolled_back') |  | `pending` |  |  |
| `total_files` | int unsigned |  | `0` |  |  |
| `migrated_files` | int unsigned |  | `0` |  |  |
| `failed_files` | int unsigned |  | `0` |  |  |
| `last_media_id` | bigint unsigned | yes |  |  |  |
| `bytes_transferred` | bigint unsigned |  | `0` |  |  |
| `error_log` | json | yes |  |  |  |
| `started_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `started_at` | datetime | yes |  |  |  |
| `finished_at` | datetime | yes |  |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_media_migrations_admin` (started_by_admin_id)
- PK `PRIMARY` (id)
- FK (started_by_admin_id) → `admin_users` (id)

### `media_tag_map`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `media_id` | bigint unsigned |  |  | PK |  |
| `tag_id` | bigint unsigned |  |  | PK |  |

- IX `fk_media_tag_map_media_t` (shop_id, media_id)
- IX `fk_media_tag_map_tag_t` (shop_id, tag_id)
- IX `ix_media_tag_map_shop` (shop_id)
- IX `ix_media_tag_map_tag` (tag_id)
- PK `PRIMARY` (media_id, tag_id)
- FK (shop_id, media_id) → `media` (shop_id, id)
- FK (shop_id, tag_id) → `media_tags` (shop_id, id)

### `media_tags`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `slug` | varchar(80) |  |  |  |  |
| `name` | varchar(80) |  |  |  |  |
| `usage_count` | int unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_media_tags_slug` (shop_id, slug)
- UQ `uq_media_tags_tenant` (shop_id, id)

### `media_variants`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `media_id` | bigint unsigned |  |  | IX |  |
| `variant_key` | varchar(32) |  |  |  |  |
| `format` | enum('webp','avif','jpeg','png','gif','svg','mp4','webm') |  |  |  |  |
| `width` | mediumint unsigned | yes |  |  |  |
| `height` | mediumint unsigned | yes |  |  |  |
| `size_bytes` | bigint unsigned |  | `0` |  |  |
| `quality` | tinyint unsigned | yes |  |  |  |
| `disk` | enum('local','s3','r2','gcs','supabase','cloudinary','external') |  | `local` |  |  |
| `storage_key` | varchar(500) |  |  |  |  |
| `is_default` | tinyint unsigned |  | `0` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- IX `fk_media_variants_media_t` (shop_id, media_id)
- IX `ix_media_variants_disk` (shop_id, disk)
- PK `PRIMARY` (id)
- UQ `uq_media_variants` (media_id, variant_key, format)
- FK (shop_id, media_id) → `media` (shop_id, id)

### `schema_migrations` ⚙

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | int unsigned |  |  | PK | auto_increment |
| `version` | varchar(190) |  |  | UQ |  |
| `kind` | enum('legacy','sql','ts') |  |  |  |  |
| `checksum` | char(64) |  |  |  |  |
| `baselined` | tinyint unsigned |  | `0` |  |  |
| `duration_ms` | int unsigned |  | `0` |  |  |
| `applied_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |

- PK `PRIMARY` (id)
- UQ `uq_schema_migrations_version` (version)

### `settings`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `group_key` | varchar(50) |  |  |  |  |
| `setting_key` | varchar(100) |  |  |  |  |
| `label` | varchar(160) | yes |  |  |  |
| `value` | text | yes |  |  |  |
| `default_value` | text | yes |  |  |  |
| `value_type` | enum('string','number','boolean','json','media','html','secret') |  | `string` |  |  |
| `description` | varchar(500) | yes |  |  |  |
| `is_public` | tinyint unsigned |  | `0` |  |  |
| `is_encrypted` | tinyint unsigned |  | `0` |  |  |
| `sort_order` | smallint unsigned |  | `0` |  |  |
| `updated_by_admin_id` | bigint unsigned | yes |  | IX |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_settings_admin` (updated_by_admin_id)
- IX `ix_settings_group` (shop_id, group_key, sort_order)
- PK `PRIMARY` (id)
- UQ `uq_settings_key` (shop_id, setting_key)
- FK (updated_by_admin_id) → `admin_users` (id)

## Other

### `price_list_prices`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `shop_id` | bigint unsigned |  |  | IX |  |
| `price_list_id` | bigint unsigned |  |  | PK |  |
| `variant_id` | bigint unsigned |  |  | PK |  |
| `price` | decimal(12,2) |  |  |  |  |
| `compare_at_price` | decimal(12,2) | yes |  |  |  |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- IX `fk_price_list_prices_variant` (variant_id)
- IX `ix_price_list_prices_variant` (shop_id, variant_id)
- PK `PRIMARY` (price_list_id, variant_id)
- FK (price_list_id) → `price_lists` (id)
- FK (variant_id) → `product_variants` (id)

### `price_lists`

| Column | Type | Null | Default | Key | Notes |
|---|---|---|---|---|---|
| `id` | bigint unsigned |  |  | PK | auto_increment |
| `shop_id` | bigint unsigned |  |  | IX |  |
| `name` | varchar(120) |  |  |  |  |
| `currency` | char(3) |  |  |  |  |
| `adjustment_percent` | decimal(6,2) |  | `0.00` |  |  |
| `created_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED |
| `updated_at` | datetime |  | `CURRENT_TIMESTAMP` |  | DEFAULT_GENERATED on update CURRENT_TIMESTAMP |

- PK `PRIMARY` (id)
- UQ `uq_price_lists_name` (shop_id, name)
- FK (shop_id) → `shops` (id)

