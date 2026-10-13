-- ─────────────────────────────────────────────────────────────────────────────
-- 32 · Saved products, customer accounts and re-engagement
--
-- No schema change. Every table this phase uses — wishlists, wishlist_items,
-- product_views, customer_consents, otp_requests, otp_throttle,
-- customer_sessions, notification_templates, notification_logs — was created in
-- phase 1 and has never been written to.
--
-- What this does add is the one message template the re-engagement send needs,
-- and the indexes the audience query leans on once those tables stop being
-- empty.
--
-- Idempotent: safe to run more than once.
--
-- Run it with the database named on the command line, not with USE:
--   mysql -u <user> -p <database> < database/32_saved_products_and_reengagement.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ── the nudge template ──────────────────────────────────────────────────────
--
-- WhatsApp will not let a business start a conversation with free text: the
-- message must be a template approved by Meta beforehand, and
-- `provider_template_id` is where that approved template's name goes. It is
-- deliberately left NULL — until it is filled in, the pipeline records the
-- message and the admin screen says plainly that nothing was delivered.
--
-- `is_transactional = 0` is the important column. It is what makes the sending
-- code demand a recorded opt-in before this ever reaches anybody.

INSERT INTO notification_templates
  (event_key, channel, locale, name, subject, body, provider, provider_template_id,
   is_transactional, is_active)
SELECT 'cart.abandoned', 'whatsapp', 'en', 'Saved but not bought — WhatsApp', NULL,
       'Hi {{name}}, you saved {{product_name}} at Veylor but haven''t ordered it yet. It''s still available: {{product_url}}. Reply STOP to stop receiving these.',
       NULL, NULL, 0, 1
WHERE NOT EXISTS (
  SELECT 1 FROM notification_templates
   WHERE event_key = 'cart.abandoned' AND channel = 'whatsapp' AND locale = 'en'
);

-- The email version was seeded with an empty body, which would send a blank
-- email if anything ever used it. Given a body, and left inactive.
UPDATE notification_templates
   SET body = 'Hi {{name}}, you left {{product_name}} behind. It is still waiting for you: {{product_url}}'
 WHERE event_key = 'cart.abandoned' AND channel = 'email' AND (body IS NULL OR body = '');

-- ── indexes the audience query needs ────────────────────────────────────────
--
-- The audience joins wishlist_items and cart_items to customers and then to
-- orders. These are the lookups that go from "instant" to "scan the table" the
-- day the shop has real customers.

DROP PROCEDURE IF EXISTS veylor_add_index_32;
DELIMITER //
CREATE PROCEDURE veylor_add_index_32(
  IN table_name VARCHAR(64), IN index_name VARCHAR(64), IN index_def VARCHAR(255)
)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = table_name AND INDEX_NAME = index_name
  ) THEN
    SET @sql = CONCAT('ALTER TABLE `', table_name, '` ADD INDEX `', index_name, '` ', index_def);
    PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
  END IF;
END //
DELIMITER ;

-- "what has this person saved", and "who saved this product"
CALL veylor_add_index_32('wishlists', 'ix_wishlists_customer', '(customer_id)');

-- "what did this person look at", and the guest-history claim on sign-in
CALL veylor_add_index_32('product_views', 'ix_product_views_customer_time', '(customer_id, viewed_at)');
CALL veylor_add_index_32('product_views', 'ix_product_views_session', '(session_token)');

-- the consent lookup, which runs once per person per send
CALL veylor_add_index_32('customer_consents', 'ix_consents_customer_purpose', '(customer_id, purpose, id)');

-- the frequency cap: "when did we last message this person on this channel"
CALL veylor_add_index_32('notification_logs', 'ix_logs_customer_channel', '(customer_id, channel, queued_at)');

-- "has this customer already bought this product" — the NOT EXISTS in the
-- audience query, run for every interested row
CALL veylor_add_index_32('order_items', 'ix_order_items_product_order', '(product_id, order_id)');

DROP PROCEDURE IF EXISTS veylor_add_index_32;

-- ── the storefront menu row ─────────────────────────────────────────────────
-- Enables the re-engagement screen in the admin sidebar. The screen itself
-- ships with the next admin build; the row being 'available' before then only
-- means the link is not greyed out.

UPDATE menu_items
   SET status = 'available'
 WHERE menu_key IN ('customers.reengagement');

INSERT INTO menu_items (menu_key, title, route, status, parent_id, sort_order, icon)
SELECT 'customers.reengagement', 'Wanted, not bought', '/reengagement', 'available',
       (SELECT id FROM (SELECT id FROM menu_items WHERE menu_key = 'customers' LIMIT 1) AS parent),
       50, 'heart'
WHERE NOT EXISTS (SELECT 1 FROM menu_items WHERE menu_key = 'customers.reengagement')
  AND EXISTS (SELECT 1 FROM menu_items WHERE menu_key = 'customers');

SELECT 'Migration 32 applied.' AS result;
