-- =============================================================================
-- File 99b : NAVIGATION SEED — the full admin menu
-- =============================================================================
-- Runs AFTER 99_seed_reference.sql, because menu items map onto permission
-- slugs that file creates.
--
-- 46 items in total: 14 top level, 32 children, across 7 sections.
--
--   Overview    1     Dashboard
--   Commerce   18     Orders (5), Products (7), Customers (3) + 3 group rows
--   Marketing   4     Discounts, Loyalty, Subscribers, Message templates
--   Content     8     Content group (6) + Media
--   Insights    2     Reports, Search insights
--   Support     3     Support group (2)
--   Settings   10     Settings group (9)
--
-- `status` is the honest bit: only the screens that actually exist in the
-- current build are 'available'. Everything else is 'coming_soon', so the
-- sidebar shows the shape of the product without handing anyone a dead link.
-- Flip a row to 'available' the day its screen ships — no migration, no deploy.
--
-- Safe to re-run.
-- =============================================================================

-- No USE statement: the database name differs per environment (veylog locally,
-- veylor_db on the server). Hardcoding one here made every migration below fail
-- with "Access denied" on the deployed box. Connect to the right database
-- instead: `mysql -D <database> < this-file.sql`.
-- ── 1. the items themselves (parents resolved in step 2) ─────────────────────
INSERT INTO `menu_items`
  (`menu_key`, `title`, `subtitle`, `icon`, `route`, `active_match`, `section`,
   `badge_key`, `badge_variant`, `sort_order`, `status`, `requires_super_admin`)
VALUES
-- ── Overview ────────────────────────────────────────────────────────────────
  ('dashboard','Dashboard','Today at a glance','dashboard','/dashboard',NULL,'Overview',NULL,'default',10,'available',0),

-- ── Commerce ────────────────────────────────────────────────────────────────
  ('orders','Orders',NULL,'orders','/orders','/orders','Commerce','orders.pending','warning',20,'coming_soon',0),
  ('orders.all','All orders',NULL,'list','/orders',NULL,NULL,NULL,'default',10,'coming_soon',0),
  ('orders.abandoned','Abandoned carts',NULL,'cart','/orders/abandoned',NULL,NULL,NULL,'default',20,'coming_soon',0),
  ('orders.returns','Returns & refunds',NULL,'returns','/returns',NULL,NULL,'returns.open','warning',30,'coming_soon',0),
  ('orders.shipments','Shipments',NULL,'shipping','/shipments',NULL,NULL,NULL,'default',40,'coming_soon',0),
  ('orders.invoices','Invoices',NULL,'invoice','/invoices',NULL,NULL,NULL,'default',50,'coming_soon',0),

  ('products','Products',NULL,'products','/products','/products','Commerce',NULL,'default',30,'available',0),
  ('products.all','All products',NULL,'list','/products','/products/new,/products/:id',NULL,NULL,'default',10,'available',0),
  ('products.inventory','Inventory',NULL,'inventory','/inventory',NULL,NULL,'inventory.low','error',20,'coming_soon',0),
  ('products.categories','Categories',NULL,'category','/categories',NULL,NULL,NULL,'default',30,'available',0),
  ('products.collections','Collections',NULL,'collections','/collections',NULL,NULL,NULL,'default',40,'available',0),
  ('products.ingredients','Ingredients',NULL,'science','/ingredients',NULL,NULL,NULL,'default',50,'coming_soon',0),
  ('products.claims','Claims & evidence',NULL,'verified','/claims',NULL,NULL,'claims.review_due','warning',60,'coming_soon',0),
  ('products.reviews','Reviews',NULL,'reviews','/reviews',NULL,NULL,'reviews.pending','info',70,'coming_soon',0),

  ('customers','Customers',NULL,'customers','/customers','/customers','Commerce',NULL,'default',40,'coming_soon',0),
  ('customers.all','All customers',NULL,'list','/customers',NULL,NULL,NULL,'default',10,'coming_soon',0),
  ('customers.segments','Segments',NULL,'segment','/customers/segments',NULL,NULL,NULL,'default',20,'coming_soon',0),
  ('customers.privacy','Consents & privacy',NULL,'privacy','/privacy',NULL,NULL,'privacy.open','warning',30,'coming_soon',0),

-- ── Marketing ───────────────────────────────────────────────────────────────
  ('discounts','Discounts','Codes and automatic offers','discounts','/discounts','/discounts/new,/discounts/:id','Marketing',NULL,'default',50,'available',0),
  ('loyalty','Loyalty',NULL,'loyalty','/loyalty',NULL,'Marketing',NULL,'default',60,'coming_soon',0),
  ('subscribers','Subscribers',NULL,'subscribers','/subscribers',NULL,'Marketing',NULL,'default',70,'coming_soon',0),
  ('notifications','Message templates',NULL,'message','/notifications',NULL,'Marketing',NULL,'default',80,'coming_soon',0),

-- ── Content ─────────────────────────────────────────────────────────────────
  ('content','Content',NULL,'content',NULL,NULL,'Content',NULL,'default',90,'coming_soon',0),
  ('content.pages','Pages',NULL,'page','/content/pages',NULL,NULL,NULL,'default',10,'coming_soon',0),
  ('content.articles','Journal',NULL,'article','/content/articles',NULL,NULL,NULL,'default',20,'coming_soon',0),
  ('content.banners','Banners',NULL,'banner','/content/banners',NULL,NULL,NULL,'default',30,'coming_soon',0),
  ('content.faqs','FAQs',NULL,'faq','/content/faqs',NULL,NULL,NULL,'default',40,'coming_soon',0),
  ('content.menus','Storefront navigation',NULL,'menu','/content/menus',NULL,NULL,NULL,'default',50,'coming_soon',0),
  ('content.redirects','Redirects',NULL,'redirect','/content/redirects',NULL,NULL,NULL,'default',60,'coming_soon',0),

  ('media','Media','Images, video and documents','media','/media',NULL,'Content',NULL,'default',100,'available',0),

-- ── Insights ────────────────────────────────────────────────────────────────
  ('analytics','Reports',NULL,'analytics','/analytics',NULL,'Insights',NULL,'default',110,'coming_soon',0),
  ('analytics.search','Search insights','What people look for','search','/analytics/search',NULL,'Insights',NULL,'default',120,'coming_soon',0),

-- ── Support ─────────────────────────────────────────────────────────────────
  ('support','Support',NULL,'support','/support','/support','Support','support.open','info',130,'coming_soon',0),
  ('support.tickets','Tickets',NULL,'ticket','/support',NULL,NULL,NULL,'default',10,'coming_soon',0),
  ('support.adverse','Adverse events',NULL,'warning','/support/adverse-events',NULL,NULL,'adverse.open','error',20,'coming_soon',0),

-- ── Settings ────────────────────────────────────────────────────────────────
  ('settings','Settings',NULL,'settings',NULL,NULL,'Settings',NULL,'default',140,'available',0),
  ('settings.store','Store details',NULL,'store','/settings/store',NULL,NULL,NULL,'default',10,'coming_soon',0),
  ('settings.shipping','Shipping & delivery',NULL,'shipping','/settings/shipping',NULL,NULL,NULL,'default',20,'coming_soon',0),
  ('settings.taxes','Taxes',NULL,'tax','/settings/taxes',NULL,NULL,NULL,'default',30,'coming_soon',0),
  ('settings.payments','Payments',NULL,'payment','/settings/payments',NULL,NULL,NULL,'default',40,'coming_soon',0),
  ('settings.staff','Staff',NULL,'staff','/settings/staff',NULL,NULL,NULL,'default',50,'available',0),
  ('settings.roles','Roles & permissions',NULL,'shield','/settings/roles',NULL,NULL,NULL,'default',60,'available',0),
  ('settings.navigation','Menu navigation','Edit this sidebar','navigation','/settings/navigation',NULL,NULL,NULL,'default',70,'available',1),
  ('settings.audit','Audit log',NULL,'history','/settings/audit',NULL,NULL,NULL,'default',80,'coming_soon',0),
  ('settings.data','Import & export',NULL,'data','/settings/data',NULL,NULL,NULL,'default',90,'coming_soon',0)
ON DUPLICATE KEY UPDATE
  `title` = VALUES(`title`),
  `subtitle` = VALUES(`subtitle`),
  `icon` = VALUES(`icon`),
  `route` = VALUES(`route`),
  `active_match` = VALUES(`active_match`),
  `section` = VALUES(`section`),
  `badge_key` = VALUES(`badge_key`),
  `badge_variant` = VALUES(`badge_variant`),
  `sort_order` = VALUES(`sort_order`),
  `requires_super_admin` = VALUES(`requires_super_admin`);
-- NOTE: `status` is deliberately NOT overwritten on re-run. Once someone flips
-- a screen to 'available' in production, re-seeding must not silently bury it.

-- ── 2. wire up parents ───────────────────────────────────────────────────────
CREATE TEMPORARY TABLE `_menu_parents` (
  `child_key`  VARCHAR(60) NOT NULL,
  `parent_key` VARCHAR(60) NOT NULL,
  PRIMARY KEY (`child_key`)
) ENGINE=InnoDB;

INSERT INTO `_menu_parents` VALUES
  ('orders.all','orders'),('orders.abandoned','orders'),('orders.returns','orders'),
  ('orders.shipments','orders'),('orders.invoices','orders'),
  ('products.all','products'),('products.inventory','products'),('products.categories','products'),
  ('products.collections','products'),('products.ingredients','products'),
  ('products.claims','products'),('products.reviews','products'),
  ('customers.all','customers'),('customers.segments','customers'),('customers.privacy','customers'),
  ('content.pages','content'),('content.articles','content'),('content.banners','content'),
  ('content.faqs','content'),('content.menus','content'),('content.redirects','content'),
  ('support.tickets','support'),('support.adverse','support'),
  ('settings.store','settings'),('settings.shipping','settings'),('settings.taxes','settings'),
  ('settings.payments','settings'),('settings.staff','settings'),('settings.roles','settings'),
  ('settings.navigation','settings'),('settings.audit','settings'),('settings.data','settings');

UPDATE `menu_items` child
  JOIN `_menu_parents` map ON map.child_key = child.menu_key
  JOIN `menu_items` parent ON parent.menu_key = map.parent_key
   SET child.parent_id = parent.id;

DROP TEMPORARY TABLE `_menu_parents`;

-- ── 3. permissions ("any of" wins) ───────────────────────────────────────────
CREATE TEMPORARY TABLE `_menu_perms` (
  `menu_key`        VARCHAR(60) NOT NULL,
  `permission_slug` VARCHAR(80) NOT NULL,
  PRIMARY KEY (`menu_key`, `permission_slug`)
) ENGINE=InnoDB;

INSERT INTO `_menu_perms` VALUES
  ('dashboard','analytics.view'),

  ('orders','orders.view'),
  ('orders.all','orders.view'),
  ('orders.abandoned','orders.view'),
  ('orders.returns','returns.manage'),
  ('orders.shipments','orders.fulfil'),
  ('orders.invoices','invoices.view'),

  ('products','products.view'),
  ('products.all','products.view'),
  ('products.inventory','inventory.view'),
  ('products.categories','products.view'),
  ('products.collections','products.view'),
  ('products.ingredients','products.view'),
  ('products.claims','claims.manage'),
  ('products.reviews','reviews.view'),

  ('customers','customers.view'),
  ('customers.all','customers.view'),
  ('customers.segments','customers.view'),
  ('customers.privacy','data_requests.manage'),

  ('discounts','coupons.view'),
  ('loyalty','loyalty.manage'),
  ('subscribers','notifications.manage'),
  ('notifications','notifications.manage'),

  ('content','cms.view'),
  ('content.pages','cms.view'),
  ('content.articles','cms.view'),
  ('content.banners','cms.view'),
  ('content.faqs','cms.view'),
  ('content.menus','cms.menus'),
  ('content.redirects','cms.redirects'),
  ('media','media.view'),

  ('analytics','analytics.view'),
  ('analytics.search','analytics.view'),

  ('support','support.view'),
  ('support.tickets','support.view'),
  ('support.adverse','adverse_events.view'),

  ('settings','settings.view'),
  ('settings.store','settings.view'),
  ('settings.shipping','settings.manage'),
  ('settings.taxes','settings.manage'),
  ('settings.payments','settings.manage'),
  ('settings.staff','admins.view'),
  ('settings.roles','roles.manage'),
  ('settings.audit','audit.view'),
  ('settings.data','customers.export');
-- settings.navigation intentionally has no permission row: it is gated by
-- requires_super_admin instead.

INSERT IGNORE INTO `menu_item_permissions` (`menu_item_id`, `permission_id`)
SELECT m.id, p.id
  FROM `_menu_perms` x
  JOIN `menu_items` m  ON m.menu_key = x.menu_key
  JOIN `permissions` p ON p.slug = x.permission_slug;

DROP TEMPORARY TABLE `_menu_perms`;

-- ── 4. the Discounts permissions the menu references ─────────────────────────
-- coupons.view / coupons.manage already exist from 99_seed_reference.sql, but
-- Content and Operations were never granted read access to the discount list.
-- Growth owns discounts; Operations needs to see them to answer "why is this
-- order ₹120 cheaper".
INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
 WHERE r.slug = 'operations' AND p.slug = 'coupons.view';

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`)
SELECT r.id, p.id FROM `roles` r JOIN `permissions` p
 WHERE r.slug = 'support' AND p.slug = 'coupons.view';
