-- =============================================================================
-- File 99 : REFERENCE SEED DATA
-- =============================================================================
-- Only data the application logic depends on: roles, permissions, taxonomy,
-- tax classes, settings, menus, notification event keys. No products, no
-- customers, no fake reviews.
-- Safe to re-run: every insert uses INSERT IGNORE or ON DUPLICATE KEY UPDATE.
-- =============================================================================

USE `veylog`;

-- -----------------------------------------------------------------------------
-- Roles (BRD §17)
-- -----------------------------------------------------------------------------
INSERT INTO `roles` (`slug`, `name`, `description`, `is_system`, `level`) VALUES
  ('founder',   'Founder / Admin', 'Full configuration, catalogue, pricing, orders, users, analytics. MFA required.', 1, 10),
  ('content',   'Content',         'Pages, articles, media, SEO. No payment or refund access.', 1, 40),
  ('operations','Operations',      'Orders, shipments, inventory, cancellation and RTO. Limited customer data.', 1, 30),
  ('support',   'Support',         'Order lookup, notes, approved refunds and escalation. Masked data where possible.', 1, 50),
  ('growth',    'Growth',          'Offers, landing pages, tags and reports. No unrestricted admin.', 1, 45),
  ('developer', 'Developer',       'Technical configuration via controlled environments. Production access is time-boxed.', 1, 20)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Permissions
-- -----------------------------------------------------------------------------
INSERT INTO `permissions` (`slug`, `module`, `action`, `name`, `is_dangerous`) VALUES
  -- catalog
  ('products.view','products','view','View products',0),
  ('products.create','products','create','Create products',0),
  ('products.update','products','update','Edit products',0),
  ('products.publish','products','publish','Publish / unpublish products',0),
  ('products.delete','products','delete','Delete products',1),
  ('products.price_update','products','price_update','Change prices and MRP',1),
  ('inventory.view','inventory','view','View inventory',0),
  ('inventory.adjust','inventory','adjust','Adjust stock levels',1),
  ('claims.manage','claims','manage','Manage claims and evidence',1),
  ('claims.approve','claims','approve','Approve claims for use',1),
  -- cms
  ('cms.view','cms','view','View content',0),
  ('cms.edit','cms','edit','Edit content',0),
  ('cms.publish','cms','publish','Publish content',0),
  ('cms.delete','cms','delete','Delete content',1),
  ('cms.menus','cms','menus','Manage navigation',0),
  ('cms.redirects','cms','redirects','Manage redirects',0),
  ('seo.manage','seo','manage','Manage SEO metadata',0),
  -- media
  ('media.view','media','view','View media library',0),
  ('media.upload','media','upload','Upload media',0),
  ('media.delete','media','delete','Delete media',1),
  ('media.migrate','media','migrate','Run storage migrations',1),
  -- orders
  ('orders.view','orders','view','View orders',0),
  ('orders.update','orders','update','Update order status',0),
  ('orders.cancel','orders','cancel','Cancel orders',1),
  ('orders.refund','orders','refund','Issue refunds',1),
  ('orders.fulfil','orders','fulfil','Create shipments',0),
  ('returns.manage','returns','manage','Approve and process returns',1),
  ('invoices.view','invoices','view','View and download invoices',0),
  -- customers
  ('customers.view','customers','view','View customers',0),
  ('customers.update','customers','update','Edit customers',0),
  ('customers.export','customers','export','Export customer data',1),
  ('customers.delete','customers','delete','Erase customer data',1),
  ('data_requests.manage','privacy','manage','Handle DPDP data requests',1),
  -- marketing
  ('coupons.view','coupons','view','View coupons',0),
  ('coupons.manage','coupons','manage','Create and edit coupons',1),
  ('loyalty.manage','loyalty','manage','Adjust loyalty points',1),
  ('notifications.manage','notifications','manage','Edit message templates',0),
  -- reviews and support
  ('reviews.view','reviews','view','View reviews',0),
  ('reviews.moderate','reviews','moderate','Approve or reject reviews',0),
  ('support.view','support','view','View support tickets',0),
  ('support.respond','support','respond','Respond to tickets',0),
  ('adverse_events.view','safety','view','View adverse event reports',1),
  ('adverse_events.manage','safety','manage','Manage adverse event reports',1),
  -- system
  ('analytics.view','analytics','view','View reports and analytics',0),
  ('settings.view','settings','view','View settings',0),
  ('settings.manage','settings','manage','Change store settings',1),
  ('admins.view','admins','view','View staff accounts',0),
  ('admins.manage','admins','manage','Create and edit staff accounts',1),
  ('roles.manage','roles','manage','Change roles and permissions',1),
  ('audit.view','audit','view','View the audit log',0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- Role → permission grants
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'founder';

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'content' AND p.slug IN (
  'products.view','cms.view','cms.edit','cms.publish','cms.menus','cms.redirects',
  'seo.manage','media.view','media.upload','media.delete','reviews.view',
  'reviews.moderate','claims.manage','analytics.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'operations' AND p.slug IN (
  'products.view','inventory.view','inventory.adjust','orders.view','orders.update',
  'orders.cancel','orders.fulfil','returns.manage','invoices.view','customers.view',
  'support.view','analytics.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'support' AND p.slug IN (
  'orders.view','orders.update','invoices.view','customers.view','support.view',
  'support.respond','reviews.view','returns.manage','adverse_events.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'growth' AND p.slug IN (
  'products.view','cms.view','cms.edit','cms.publish','seo.manage','media.view',
  'media.upload','coupons.view','coupons.manage','notifications.manage','analytics.view');

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
WHERE r.slug = 'developer' AND p.slug IN (
  'products.view','inventory.view','orders.view','cms.view','media.view',
  'settings.view','settings.manage','analytics.view','audit.view','media.migrate');

-- -----------------------------------------------------------------------------
-- Skin taxonomy
-- -----------------------------------------------------------------------------
INSERT INTO `skin_types` (`slug`,`name`,`sort_order`) VALUES
  ('all','All skin types',0),
  ('normal','Normal',1),
  ('dry','Dry',2),
  ('oily','Oily',3),
  ('combination','Combination',4),
  ('sensitive','Sensitive',5)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- Wording is deliberately appearance-based, per the BRD claims framework.
INSERT INTO `skin_concerns` (`slug`,`name`,`short_label`,`sort_order`,`has_landing_page`) VALUES
  ('dullness','Dullness','Dull-looking skin',0,1),
  ('uneven-tone','Uneven tone','Uneven-looking tone',1,1),
  ('pigmentation','Pigmentation','Dark spots',2,1),
  ('brightening','Brightening','Radiance',3,0),
  ('hydration','Hydration','Dehydrated-looking skin',4,1),
  ('barrier','Barrier support','Barrier discomfort',5,1),
  ('acne','Blemish-prone','Blemish-prone skin',6,0),
  ('aging','Visible ageing','Fine lines',7,0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Tax (18% GST on cosmetics, HSN 3304). Confirm with your CA before launch.
-- -----------------------------------------------------------------------------
INSERT INTO `tax_classes` (`code`,`name`,`hsn_code`,`gst_rate`,`is_inclusive`,`is_default`) VALUES
  ('GST_18_COSMETICS','GST 18% — Cosmetics','3304',18.00,1,1),
  ('GST_18_SKINCARE_PREP','GST 18% — Skin care preparations','3307',18.00,1,0),
  ('GST_0','Exempt','',0.00,0,0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `tax_rates` (`tax_class_id`,`country`,`state_code`,`tax_type`,`rate`,`effective_from`)
SELECT id,'IN',NULL,'cgst',9.00,'2026-01-01' FROM `tax_classes` WHERE `code`='GST_18_COSMETICS';
INSERT INTO `tax_rates` (`tax_class_id`,`country`,`state_code`,`tax_type`,`rate`,`effective_from`)
SELECT id,'IN',NULL,'sgst',9.00,'2026-01-01' FROM `tax_classes` WHERE `code`='GST_18_COSMETICS';
INSERT INTO `tax_rates` (`tax_class_id`,`country`,`state_code`,`tax_type`,`rate`,`effective_from`)
SELECT id,'IN',NULL,'igst',18.00,'2026-01-01' FROM `tax_classes` WHERE `code`='GST_18_COSMETICS';

-- -----------------------------------------------------------------------------
-- Media folders
-- -----------------------------------------------------------------------------
INSERT INTO `media_folders` (`parent_id`,`name`,`slug`,`path`,`depth`,`sort_order`) VALUES
  (NULL,'Products','products','products',0,0),
  (NULL,'Ingredients','ingredients','ingredients',0,1),
  (NULL,'Editorial','editorial','editorial',0,2),
  (NULL,'Banners','banners','banners',0,3),
  (NULL,'UGC & Reviews','ugc','ugc',0,4),
  (NULL,'Documents','documents','documents',0,5),
  (NULL,'Brand','brand','brand',0,6)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Navigation shells (BRD §6 information architecture)
-- -----------------------------------------------------------------------------
INSERT INTO `cms_menus` (`slug`,`name`) VALUES
  ('main','Main header'),
  ('mobile_drawer','Mobile drawer'),
  ('footer_shop','Footer — Shop'),
  ('footer_learn','Footer — Learn'),
  ('footer_support','Footer — Support'),
  ('footer_legal','Footer — Legal')
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `cms_blogs` (`slug`,`title`,`description`) VALUES
  ('journal','Journal','Education, routines and ingredient explainers.')
ON DUPLICATE KEY UPDATE `title` = VALUES(`title`);

INSERT INTO `cms_article_categories` (`slug`,`name`,`sort_order`) VALUES
  ('routine','Routine',0),
  ('education','Education',1),
  ('ingredient','Ingredient',2),
  ('safety','Safety',3),
  ('expectation','What to expect',4),
  ('concern','Concern',5)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `cms_faq_groups` (`slug`,`name`,`sort_order`) VALUES
  ('general','General',0),
  ('shipping','Shipping & delivery',1),
  ('returns','Returns & refunds',2),
  ('payments','Payments',3),
  ('products','Using our products',4)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Fulfilment defaults
-- -----------------------------------------------------------------------------
INSERT INTO `inventory_locations` (`code`,`name`,`location_type`,`country`,`is_default`,`is_active`) VALUES
  ('MAIN','Primary warehouse','warehouse','IN',1,1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

INSERT INTO `shipping_rates` (`name`,`zone`,`method`,`min_order_amount`,`rate`,`free_above_amount`,`eta_min_days`,`eta_max_days`,`priority`) VALUES
  ('Standard shipping','all','standard',0.00,99.00,500.00,3,7,0),
  ('Express shipping','metro','express',0.00,199.00,NULL,1,3,10);

INSERT INTO `cod_rules` (`name`,`is_active`,`min_order_amount`,`max_order_amount`,`cod_fee`,`prepaid_discount_amount`,`requires_otp_confirmation`,`max_open_cod_orders`,`block_if_rto_count_gte`) VALUES
  ('Default COD policy',1,299.00,5000.00,49.00,25.00,1,2,2);

-- -----------------------------------------------------------------------------
-- Notification event keys (bodies to be written by the content team)
-- -----------------------------------------------------------------------------
INSERT INTO `notification_templates` (`event_key`,`channel`,`locale`,`name`,`subject`,`body`,`is_transactional`,`is_active`) VALUES
  ('otp.login','sms','en-IN','Login OTP — SMS',NULL,'{{otp}} is your Veylor verification code. Valid for 5 minutes. Do not share it.',1,1),
  ('otp.login','whatsapp','en-IN','Login OTP — WhatsApp',NULL,'{{otp}} is your Veylor verification code. Valid for 5 minutes.',1,1),
  ('order.confirmed','sms','en-IN','Order confirmed — SMS',NULL,'Order {{order_number}} confirmed. Track it at {{tracking_url}}',1,1),
  ('order.confirmed','whatsapp','en-IN','Order confirmed — WhatsApp',NULL,'Thank you. Order {{order_number}} is confirmed.',1,1),
  ('order.confirmed','email','en-IN','Order confirmed — Email','Your Veylor order {{order_number}}','',1,1),
  ('order.shipped','sms','en-IN','Order shipped — SMS',NULL,'Order {{order_number}} has shipped. AWB {{awb}}. Track: {{tracking_url}}',1,1),
  ('order.shipped','whatsapp','en-IN','Order shipped — WhatsApp',NULL,'Your Veylor order is on its way.',1,1),
  ('order.out_for_delivery','sms','en-IN','Out for delivery — SMS',NULL,'Order {{order_number}} is out for delivery today.',1,1),
  ('order.delivered','whatsapp','en-IN','Delivered — WhatsApp',NULL,'Your Veylor order has been delivered.',1,1),
  ('order.cancelled','email','en-IN','Order cancelled — Email','Order {{order_number}} cancelled','',1,1),
  ('payment.failed','email','en-IN','Payment failed — Email','We could not complete your payment','',1,1),
  ('refund.processed','email','en-IN','Refund processed — Email','Your refund for {{order_number}}','',1,1),
  ('cart.abandoned','email','en-IN','Abandoned cart — Email','You left something behind','',0,0),
  ('review.invite','email','en-IN','Review invitation — Email','How is your Veylor routine going?','',0,1),
  ('stock.back_in_stock','email','en-IN','Back in stock — Email','{{product_name}} is back','',0,1)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Settings
-- -----------------------------------------------------------------------------
-- media.* is what makes the local → S3 move a config change plus a copy job.
INSERT INTO `settings` (`group_key`,`setting_key`,`label`,`value`,`value_type`,`is_public`,`description`) VALUES
  ('store','store.name','Store name','Veylor','string',1,NULL),
  ('store','store.legal_name','Legal entity name','','string',0,'As registered, for invoices'),
  ('store','store.gstin','GSTIN','','string',0,NULL),
  ('store','store.support_email','Support email','','string',1,NULL),
  ('store','store.support_phone','Support phone','','string',1,NULL),
  ('store','store.support_hours','Support hours','Mon–Sat, 10:00–18:00 IST','string',1,NULL),
  ('store','store.currency','Currency','INR','string',1,NULL),
  ('store','store.timezone','Timezone','Asia/Kolkata','string',0,NULL),
  ('store','store.grievance_officer','Grievance officer','','json',1,'Name, email and address required by consumer rules'),

  ('media','media.disk','Active storage disk','local','string',0,'local | s3 | r2'),
  ('media','media.local_base_url','Local media base URL','/media','string',1,'Prefix joined to media.storage_key while disk = local'),
  ('media','media.local_root','Local storage root','/storage/media','string',0,'Absolute path on the server, outside the web root'),
  ('media','media.s3_base_url','S3/CDN base URL','','string',1,'Set before switching disk to s3'),
  ('media','media.max_upload_mb','Max upload size (MB)','25','number',0,NULL),
  ('media','media.allowed_mime','Allowed MIME types','["image/jpeg","image/png","image/webp","image/avif","video/mp4","application/pdf"]','json',0,NULL),
  ('media','media.variant_widths','Variant widths','{"thumb":160,"sm":400,"md":800,"lg":1200,"xl":1800}','json',0,NULL),
  ('media','media.variant_formats','Variant formats','["webp","avif"]','json',0,NULL),
  ('media','media.keep_original','Keep original file','1','boolean',0,NULL),

  ('otp','otp.length','OTP length','6','number',0,NULL),
  ('otp','otp.expiry_seconds','OTP expiry (seconds)','300','number',0,NULL),
  ('otp','otp.resend_cooldown_seconds','Resend cooldown','30','number',1,NULL),
  ('otp','otp.max_attempts','Max verify attempts','5','number',0,NULL),
  ('otp','otp.max_per_phone_per_hour','Max sends per phone per hour','5','number',0,'Cost and abuse control'),
  ('otp','otp.max_per_ip_per_hour','Max sends per IP per hour','20','number',0,NULL),
  ('otp','otp.default_channel','Default channel','whatsapp','string',1,NULL),

  ('auth','auth.access_token_minutes','Access token lifetime (min)','15','number',0,NULL),
  ('auth','auth.refresh_token_days','Refresh token lifetime (days)','30','number',0,NULL),
  ('auth','auth.admin_session_hours','Admin session lifetime (hours)','8','number',0,NULL),
  ('auth','auth.admin_mfa_required','Require MFA for admins','1','boolean',0,NULL),

  ('cart','cart.expiry_days','Cart persistence (days)','30','number',0,'BRD FR-03'),
  ('cart','cart.max_line_quantity','Max units per line','10','number',1,NULL),
  ('cart','cart.reservation_minutes','Checkout stock hold (min)','15','number',0,NULL),

  ('shipping','shipping.free_threshold','Free shipping above (₹)','500','number',1,NULL),
  ('shipping','shipping.standard_cost','Standard shipping (₹)','99','number',1,NULL),
  ('shipping','shipping.origin_state_code','Origin state code','','string',0,'Decides CGST+SGST vs IGST'),

  ('payment','payment.gateway','Active gateway','razorpay','string',0,NULL),
  ('payment','payment.cod_enabled','COD enabled','1','boolean',1,NULL),
  ('payment','payment.capture_mode','Capture mode','automatic','string',0,NULL),

  ('privacy','privacy.notice_version','Privacy notice version','1.0','string',1,'Recorded on every consent row'),
  ('privacy','privacy.quiz_retention_days','Quiz answer retention (days)','365','number',0,NULL),
  ('privacy','privacy.otp_log_retention_days','OTP log retention (days)','90','number',0,NULL),

  ('seo','seo.default_title_suffix','Title suffix',' | Veylor','string',1,NULL),
  ('seo','seo.noindex_site','Noindex whole site','1','boolean',0,'Keep 1 on staging, set 0 at launch'),

  ('inventory','inventory.low_stock_threshold','Low stock alert threshold','5','number',0,NULL),
  ('inventory','inventory.allow_backorder','Allow backorders','0','boolean',0,NULL)
ON DUPLICATE KEY UPDATE `label` = VALUES(`label`);

-- -----------------------------------------------------------------------------
-- Metafield definitions — a couple of useful starters
-- -----------------------------------------------------------------------------
INSERT INTO `metafield_definitions` (`owner_type`,`namespace`,`meta_key`,`name`,`value_type`,`is_public`,`is_filterable`) VALUES
  ('product','veylor','clinical_report','Clinical study report (PDF)','media',1,0),
  ('product','veylor','ph_value','Formula pH','decimal',1,1),
  ('product','veylor','spf_rating','SPF rating','integer',1,1),
  ('product','veylor','vegan','Vegan','boolean',1,1),
  ('product','veylor','cruelty_free','Cruelty free','boolean',1,1),
  ('product','veylor','patch_test_required','Patch test recommended','boolean',1,0),
  ('cms_page','veylor','hero_video','Hero video','media',1,0)
ON DUPLICATE KEY UPDATE `name` = VALUES(`name`);

-- -----------------------------------------------------------------------------
-- Search synonyms (BRD FR-11)
-- -----------------------------------------------------------------------------
INSERT INTO `search_synonyms` (`term`,`synonyms`,`match_type`) VALUES
  ('vitamin c','ascorbic acid,vit c,vitc,l-ascorbic','synonym'),
  ('niacinamide','vitamin b3,nicotinamide,b3','synonym'),
  ('moisturizer','moisturiser,cream,lotion,hydrator','synonym'),
  ('sunscreen','spf,sun screen,sunblock,sun cream','synonym'),
  ('dark spots','pigmentation,hyperpigmentation,melasma,marks','concept'),
  ('dullness','dull skin,glow,radiance,tired skin','concept'),
  ('cica','centella,centella asiatica,tiger grass','synonym'),
  ('serum','seram,cerum','typo')
ON DUPLICATE KEY UPDATE `synonyms` = VALUES(`synonyms`);
