-- ────────────────────────────────────────────────────────────────────────────
-- 48 · Messaging — templates, senders, campaigns
--
--   mysql -u <user> -p <database> < database/48_messaging.sql
--
-- The shop can already send one message: `messaging.service.send()` renders a
-- row of `notification_templates`, checks consent, hands it to a provider and
-- writes `notification_logs`. That is the whole of it. There is no way to
-- author a template, no identity to send it from, and no way to send the same
-- message to four thousand people and find out what happened to it.
--
-- This migration adds those three things and nothing else.
--
-- ── the shape, and why ──────────────────────────────────────────────────────
--
--   messaging_senders            WHO a message comes from. An email From
--                                address, a six-character SMS header with the
--                                DLT entity that registered it, a WhatsApp
--                                business number. Separate from the template
--                                because one header carries fifty templates,
--                                and because the compliance identifiers
--                                (PE ID, WABA id) belong to the identity, not
--                                to the words.
--
--   notification_templates(+)    WHAT is said, plus what the regulators need
--                                to know about it: the category, the approval
--                                state, a sample of its variables so it can be
--                                previewed without inventing data.
--
--   message_campaigns            ONE send to many people: an audience, a
--                                template, a schedule, and running counters.
--
--   message_campaign_recipients  one row per person per campaign. The
--                                expensive table, and the one that makes a
--                                campaign resumable, auditable and honest
--                                about who was skipped and why.
--
-- `notification_logs` stays the single outbox — a campaign message is logged
-- there exactly like an order confirmation, with `campaign_id` filled in.
-- Two outboxes would mean two answers to "what did we send this customer".
--
-- ── what is deliberately NOT here ───────────────────────────────────────────
--
-- No provider credentials in a column. Secrets stay in the environment; a
-- sender holds the public half of the connection (which WABA, which header)
-- and a `config` blob for non-secret provider options.
--
-- No inbound message table. Replies need a webhook from a provider we have not
-- connected; `notification_logs.direction` is here so adding one later is a
-- row, not a migration.
--
-- Idempotent: every statement is guarded. Safe to run twice.
-- ────────────────────────────────────────────────────────────────────────────

SET NAMES utf8mb4;

-- ── a small helper, so the guards below read as one line each ───────────────
DROP PROCEDURE IF EXISTS veylor_add_column;
DELIMITER $$
CREATE PROCEDURE veylor_add_column(IN tbl VARCHAR(64), IN col VARCHAR(64), IN spec TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND COLUMN_NAME = col
  ) THEN
    SET @ddl := CONCAT('ALTER TABLE `', tbl, '` ADD COLUMN `', col, '` ', spec);
    PREPARE statement FROM @ddl;
    EXECUTE statement;
    DEALLOCATE PREPARE statement;
  END IF;
END$$

DROP PROCEDURE IF EXISTS veylor_add_index$$
CREATE PROCEDURE veylor_add_index(IN tbl VARCHAR(64), IN idx VARCHAR(64), IN cols TEXT)
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = tbl AND INDEX_NAME = idx
  ) THEN
    SET @ddl := CONCAT('ALTER TABLE `', tbl, '` ADD KEY `', idx, '` (', cols, ')');
    PREPARE statement FROM @ddl;
    EXECUTE statement;
    DEALLOCATE PREPARE statement;
  END IF;
END$$
DELIMITER ;

-- ── 1 · senders ─────────────────────────────────────────────────────────────
--
-- One row per identity a message can come from. Three channels, three sets of
-- columns, one table: they are all answering the same question, and a shop with
-- two SMS headers and one WhatsApp number should see them in one list.
--
-- The India-specific columns are not optional decoration. Under TRAI's DLT
-- regime every commercial SMS is sent by a registered Principal Entity (the
-- PE ID) through a registered header, against a template registered under that
-- header. A send missing any of the three is rejected by the operator, not by
-- us — so the identity that holds them is the thing that has to exist first.
CREATE TABLE IF NOT EXISTS messaging_senders (
  id                  BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  channel             ENUM('email','sms','whatsapp','push') NOT NULL,
  name                VARCHAR(120) NOT NULL
                        COMMENT 'What staff call it: "Veylor transactional", "VEYLOR promo"',

  -- Which adapter delivers it. 'simulator' until a real account exists: it
  -- behaves like a provider — queues, sends, delivers, occasionally fails —
  -- without anything leaving the building.
  provider            VARCHAR(40) NOT NULL DEFAULT 'simulator',
  status              ENUM('active','paused') NOT NULL DEFAULT 'active',
  is_default          TINYINT(1) NOT NULL DEFAULT 0,

  -- email
  from_email          VARCHAR(191) NULL,
  from_name           VARCHAR(120) NULL,
  reply_to            VARCHAR(191) NULL,

  -- sms · India DLT
  sms_header          VARCHAR(12) NULL  COMMENT 'The registered sender ID, e.g. VEYLOR',
  dlt_pe_id           VARCHAR(40) NULL  COMMENT 'Principal Entity ID issued by the DLT registry',
  dlt_entity_name     VARCHAR(160) NULL,

  -- whatsapp · Meta Cloud API vocabulary, because every BSP speaks it
  waba_id             VARCHAR(40) NULL,
  phone_number_id     VARCHAR(40) NULL,
  display_phone       VARCHAR(20) NULL,
  quality_rating      ENUM('green','yellow','red','unknown') NOT NULL DEFAULT 'unknown',

  -- Non-secret provider options only. API keys live in the environment.
  config              JSON NULL,

  daily_limit         INT UNSIGNED NULL COMMENT 'Stop sending after this many in a day. NULL is no limit.',
  notes               VARCHAR(500) NULL,

  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at          DATETIME NULL,

  PRIMARY KEY (id),
  UNIQUE KEY uq_messaging_senders_name (channel, name),
  KEY ix_messaging_senders_channel (channel, status, deleted_at),
  CONSTRAINT fk_messaging_senders_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 2 · what a template has to say about itself ─────────────────────────────
--
-- `is_transactional` is kept — half the codebase reads it — but it is a
-- two-value answer to a four-value question. WhatsApp routes on MARKETING /
-- UTILITY / AUTHENTICATION and prices them differently; DLT routes on
-- transactional / service / promotional and bans promotional at night. The
-- category is the real discriminator, and `is_transactional` is now derived
-- from it on write.
CALL veylor_add_column('notification_templates', 'category',
  "ENUM('transactional','utility','marketing','authentication') NOT NULL DEFAULT 'transactional'
     COMMENT 'Drives consent, quiet hours, pricing and which approvals apply'
   AFTER channel");

CALL veylor_add_column('notification_templates', 'description',
  "VARCHAR(300) NULL COMMENT 'What this template is for, for whoever inherits it' AFTER name");

CALL veylor_add_column('notification_templates', 'sender_id',
  'BIGINT UNSIGNED NULL AFTER provider');

CALL veylor_add_column('notification_templates', 'approval_status',
  "ENUM('not_required','draft','pending','approved','rejected') NOT NULL DEFAULT 'not_required'
     COMMENT 'WhatsApp templates need Meta approval; SMS templates need a DLT id'
   AFTER dlt_template_id");

CALL veylor_add_column('notification_templates', 'approval_note',
  'VARCHAR(500) NULL AFTER approval_status');

CALL veylor_add_column('notification_templates', 'approved_at', 'DATETIME NULL AFTER approval_note');

-- A worked example of every variable, so the preview shows a real message
-- rather than {{first_name}}, and so a test send needs no invented data.
CALL veylor_add_column('notification_templates', 'sample_variables', 'JSON NULL AFTER variables');

-- WhatsApp's own anatomy. Held as columns rather than buried in the body
-- because the provider sends them as separate components.
CALL veylor_add_column('notification_templates', 'header_text', 'VARCHAR(160) NULL AFTER subject');
CALL veylor_add_column('notification_templates', 'footer_text', 'VARCHAR(160) NULL AFTER body');
CALL veylor_add_column('notification_templates', 'buttons',
  "JSON NULL COMMENT 'WhatsApp quick replies and URL buttons' AFTER footer_text");
CALL veylor_add_column('notification_templates', 'preheader',
  "VARCHAR(255) NULL COMMENT 'The grey line after the subject in an inbox' AFTER subject");

CALL veylor_add_column('notification_templates', 'last_used_at', 'DATETIME NULL AFTER is_active');
CALL veylor_add_column('notification_templates', 'usage_count', 'INT UNSIGNED NOT NULL DEFAULT 0 AFTER last_used_at');
CALL veylor_add_column('notification_templates', 'created_by_admin_id', 'BIGINT UNSIGNED NULL AFTER updated_by_admin_id');
CALL veylor_add_column('notification_templates', 'deleted_at', 'DATETIME NULL');

CALL veylor_add_index('notification_templates', 'ix_notification_templates_category', 'category, channel, is_active');
CALL veylor_add_index('notification_templates', 'ix_notification_templates_sender', 'sender_id');

-- Classify what is already there. Authentication first, because an OTP is not
-- a transactional message in WhatsApp's vocabulary and is priced separately.
UPDATE notification_templates SET category = 'authentication'
 WHERE event_key LIKE 'otp.%' AND category = 'transactional';

UPDATE notification_templates SET category = 'marketing'
 WHERE is_transactional = 0 AND category = 'transactional';

-- WhatsApp is the only channel with a pre-approval gate; everything already in
-- the table predates it and is treated as approved rather than blocked.
UPDATE notification_templates
   SET approval_status = 'approved', approved_at = COALESCE(approved_at, created_at)
 WHERE channel = 'whatsapp' AND approval_status = 'not_required';

-- ── 2b · make the marketing templates legal ─────────────────────────────────
--
-- The compliance gate refuses a marketing email with no way to unsubscribe and
-- a marketing SMS with no way to stop. Three of the rows already in this table
-- would be refused by that rule, and two of them have an empty body — they were
-- seeded as placeholders and have never been sendable. Rather than let the new
-- gate silently switch off three flows, they are brought up to the standard the
-- gate expects, with wording the shop can rewrite in the editor.
UPDATE notification_templates
   SET subject = COALESCE(NULLIF(subject, ''), 'How are you getting on with your order?'),
       body = 'Hi {{first_name}},

You ordered from us a little while ago. If you have a minute, we would love to know how it is working for you — it helps everyone who reads it before buying.

Leave a review: {{link}}

— {{shop_name}}
Not interested in these? {{unsubscribe_url}}'
 WHERE event_key = 'review.invite' AND channel = 'email' AND TRIM(body) = '';

UPDATE notification_templates
   SET subject = COALESCE(NULLIF(subject, ''), '{{product_name}} is back'),
       body = 'Hi {{first_name}},

{{product_name}} is back in stock. It went quickly last time, so this is the early word rather than an announcement.

Have a look: {{link}}

— {{shop_name}}
Not interested in these? {{unsubscribe_url}}'
 WHERE event_key = 'stock.back_in_stock' AND channel = 'email' AND TRIM(body) = '';

-- The transactional emails were seeded with a subject and an empty body, which
-- means four of them have been capable of sending a blank email since the day
-- they were created. The compliance gate now refuses an empty body outright —
-- correctly — so they are given the words they should always have had, in the
-- shop's own voice, for whoever edits them next.
UPDATE notification_templates
   SET body = 'Hi {{first_name}},

Thank you — your order {{order_number}} is confirmed, and we are getting it ready.

Total: {{order_total}}

We will write again the moment it ships.

— {{shop_name}}'
 WHERE event_key = 'order.confirmed' AND channel = 'email' AND TRIM(body) = '';

UPDATE notification_templates
   SET body = 'Hi {{first_name}},

Your order {{order_number}} has been cancelled, and nothing further will be charged. Anything already paid is refunded to the original payment method.

If this was not you, reply to this email and we will look into it.

— {{shop_name}}'
 WHERE event_key = 'order.cancelled' AND channel = 'email' AND TRIM(body) = '';

UPDATE notification_templates
   SET body = 'Hi {{first_name}},

The payment for order {{order_number}} did not go through, so we have not been able to start on it. Nothing has been charged.

You can try again here: {{link}}

— {{shop_name}}'
 WHERE event_key = 'payment.failed' AND channel = 'email' AND TRIM(body) = '';

UPDATE notification_templates
   SET body = 'Hi {{first_name}},

Your refund for order {{order_number}} has been processed: {{order_total}}. Banks usually take three to five working days to show it.

— {{shop_name}}'
 WHERE event_key = 'refund.processed' AND channel = 'email' AND TRIM(body) = '';

-- Anything else marketing and by email gets the unsubscribe line appended once.
UPDATE notification_templates
   SET body = CONCAT(body, '

Not interested in these? {{unsubscribe_url}}')
 WHERE category = 'marketing'
   AND channel = 'email'
   AND body NOT LIKE '%unsubscribe%'
   AND TRIM(body) <> '';

-- And marketing SMS gets the stop line.
UPDATE notification_templates
   SET body = CONCAT(body, ' To stop, reply STOP')
 WHERE category = 'marketing'
   AND channel = 'sms'
   AND UPPER(body) NOT LIKE '%STOP%'
   AND TRIM(body) <> '';

-- ── 3 · one send to many people ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS message_campaigns (
  id                    BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,

  name                  VARCHAR(160) NOT NULL,
  description           VARCHAR(500) NULL,
  channel               ENUM('email','sms','whatsapp','push') NOT NULL,
  template_id           BIGINT UNSIGNED NULL,
  sender_id             BIGINT UNSIGNED NULL,

  -- draft → scheduled → sending → completed, with paused and cancelled as the
  -- two ways out. 'sending' is the only state the worker picks up, and the only
  -- one that may not be edited.
  status                ENUM('draft','scheduled','sending','paused','completed','cancelled','failed')
                          NOT NULL DEFAULT 'draft',

  -- Where the people come from. A saved segment is the normal answer; `rules`
  -- is the same rule language applied live, for "everyone who bought in the
  -- last 30 days" without saving a segment first; `manual` is a chosen list.
  audience_type         ENUM('segment','rules','manual','all') NOT NULL DEFAULT 'segment',
  segment_id            BIGINT UNSIGNED NULL,
  rules                 JSON NULL,
  rules_operator        ENUM('all','any') NOT NULL DEFAULT 'all',

  -- Extra narrowing that applies whatever the audience is, and is on by
  -- default: never message the same person twice about the same thing.
  exclude_recent_hours  SMALLINT UNSIGNED NULL,

  scheduled_at          DATETIME NULL,
  timezone              VARCHAR(40) NOT NULL DEFAULT 'Asia/Kolkata',
  started_at            DATETIME NULL,
  completed_at          DATETIME NULL,

  -- Sends per minute. Providers rate-limit, and a WhatsApp number that bursts
  -- ten thousand messages in a minute is a number that gets its quality rating
  -- cut. NULL means as fast as the batch allows.
  throttle_per_minute   INT UNSIGNED NULL,

  total_recipients      INT UNSIGNED NOT NULL DEFAULT 0,
  sent_count            INT UNSIGNED NOT NULL DEFAULT 0,
  delivered_count       INT UNSIGNED NOT NULL DEFAULT 0,
  failed_count          INT UNSIGNED NOT NULL DEFAULT 0,
  skipped_count         INT UNSIGNED NOT NULL DEFAULT 0,
  cost                  DECIMAL(12,4) NOT NULL DEFAULT 0.0000,

  -- Values for the template's placeholders that are the same for everyone
  -- ({{offer_code}}), alongside the per-customer ones resolved at send time.
  variables             JSON NULL,
  utm                   JSON NULL COMMENT 'Appended to links in the body',

  -- Filled when a send is refused, so the screen can say which rule stopped it.
  last_error            VARCHAR(500) NULL,

  created_by_admin_id   BIGINT UNSIGNED NULL,
  approved_by_admin_id  BIGINT UNSIGNED NULL,
  created_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at            DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  deleted_at            DATETIME NULL,

  PRIMARY KEY (id),
  KEY ix_message_campaigns_status (status, scheduled_at),
  KEY ix_message_campaigns_channel (channel, created_at),
  KEY fk_message_campaigns_template (template_id),
  KEY fk_message_campaigns_sender (sender_id),
  KEY fk_message_campaigns_segment (segment_id),
  CONSTRAINT fk_message_campaigns_template
    FOREIGN KEY (template_id) REFERENCES notification_templates (id) ON DELETE SET NULL,
  CONSTRAINT fk_message_campaigns_sender
    FOREIGN KEY (sender_id) REFERENCES messaging_senders (id) ON DELETE SET NULL,
  CONSTRAINT fk_message_campaigns_segment
    FOREIGN KEY (segment_id) REFERENCES customer_segments (id) ON DELETE SET NULL,
  CONSTRAINT fk_message_campaigns_admin
    FOREIGN KEY (created_by_admin_id) REFERENCES admin_users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- A chosen list, for `audience_type = 'manual'`. A column rather than rows:
-- the frozen audience in `message_campaign_recipients` is the real list, and
-- this is only the instruction that produced it.
CALL veylor_add_column('message_campaigns', 'customer_ids', 'JSON NULL AFTER rules_operator');

-- ── 4 · one row per person per campaign ─────────────────────────────────────
--
-- The audience is frozen into this table the moment a campaign starts, not
-- recomputed per batch. Two reasons: a rule that matches "ordered in the last
-- 30 days" would otherwise drift while the send runs, and a send that is
-- interrupted has to resume without messaging anyone twice — which the unique
-- key on (campaign_id, customer_id) enforces rather than hopes for.
CREATE TABLE IF NOT EXISTS message_campaign_recipients (
  id             BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  campaign_id    BIGINT UNSIGNED NOT NULL,
  customer_id    BIGINT UNSIGNED NULL,

  -- Frozen at audience time: the address as it was when the campaign was built.
  recipient      VARCHAR(191) NOT NULL,

  status         ENUM('pending','sending','sent','delivered','failed','skipped','cancelled')
                   NOT NULL DEFAULT 'pending',

  -- Why it was not sent, in the vocabulary of the compliance gate:
  -- no_consent, too_soon, quiet_hours, no_recipient, no_template, provider_failed.
  skip_reason    VARCHAR(40) NULL,
  error_message  VARCHAR(500) NULL,

  -- The outbox row, so one click goes from the campaign to what was actually sent.
  log_id         BIGINT UNSIGNED NULL,
  variables      JSON NULL,

  sent_at        DATETIME NULL,
  delivered_at   DATETIME NULL,
  created_at     DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,

  PRIMARY KEY (id),
  UNIQUE KEY uq_campaign_customer (campaign_id, customer_id),
  KEY ix_campaign_recipients_status (campaign_id, status, id),
  KEY ix_campaign_recipients_customer (customer_id),
  CONSTRAINT fk_campaign_recipients_campaign
    FOREIGN KEY (campaign_id) REFERENCES message_campaigns (id) ON DELETE CASCADE,
  CONSTRAINT fk_campaign_recipients_customer
    FOREIGN KEY (customer_id) REFERENCES customers (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

-- ── 5 · the outbox learns about campaigns ───────────────────────────────────
CALL veylor_add_column('notification_logs', 'campaign_id', 'BIGINT UNSIGNED NULL AFTER order_id');
CALL veylor_add_column('notification_logs', 'sender_id', 'BIGINT UNSIGNED NULL AFTER provider');
CALL veylor_add_column('notification_logs', 'sent_by_admin_id',
  "BIGINT UNSIGNED NULL COMMENT 'Set when a person sent it by hand from the admin' AFTER campaign_id");
CALL veylor_add_column('notification_logs', 'direction',
  "ENUM('outbound','inbound') NOT NULL DEFAULT 'outbound' AFTER channel");
CALL veylor_add_index('notification_logs', 'ix_notification_logs_campaign', 'campaign_id, status');

-- ── 6 · the rules, as settings rather than constants ────────────────────────
--
-- Every one of these is a number someone will need to change without a deploy:
-- the quiet-hours window moves with the regulator, the frequency cap moves with
-- how often the shop wants to be heard from.
INSERT INTO settings (group_key, setting_key, label, value, default_value, value_type, description, is_public, sort_order)
VALUES
  ('messaging', 'messaging.timezone', 'Messaging timezone', 'Asia/Kolkata', 'Asia/Kolkata', 'string',
   'The clock every quiet-hours rule is read against.', 0, 10),
  ('messaging', 'messaging.marketing_window_start', 'Promotional messages from', '10:00', '10:00', 'string',
   'TRAI prohibits promotional messages outside 10:00–21:00. Earlier than 10:00 is not permitted.', 0, 20),
  ('messaging', 'messaging.marketing_window_end', 'Promotional messages until', '21:00', '21:00', 'string',
   'Later than 21:00 is not permitted.', 0, 30),
  ('messaging', 'messaging.frequency_cap_hours', 'Leave alone for (hours)', '72', '72', 'number',
   'How long after a marketing message before the same person may receive another on that channel.', 0, 40),
  ('messaging', 'messaging.enforce_dlt', 'Require a DLT template ID for SMS', 'true', 'true', 'boolean',
   'Indian operators reject commercial SMS without one. Turn off only for a test gateway.', 0, 50),
  ('messaging', 'messaging.require_opt_out', 'Require an opt-out line in marketing', 'true', 'true', 'boolean',
   'Blocks a marketing template that gives no way to stop receiving them.', 0, 60),
  ('messaging', 'messaging.opt_out_text_sms', 'SMS opt-out wording', 'To stop, reply STOP', 'To stop, reply STOP', 'string',
   NULL, 0, 70),
  ('messaging', 'messaging.default_country_code', 'Default country code', '91', '91', 'string',
   'Used when a stored phone number has none.', 0, 80),
  ('messaging', 'messaging.campaign_batch_size', 'Messages per batch', '200', '200', 'number',
   'How many recipients one pass of the sender takes.', 0, 90),
  ('messaging', 'messaging.simulator_delivery_rate', 'Simulator delivery rate (%)', '94', '94', 'number',
   'While no provider is connected: what share of simulated sends report delivered.', 0, 100)
ON DUPLICATE KEY UPDATE
  label         = VALUES(label),
  default_value = VALUES(default_value),
  value_type    = VALUES(value_type),
  description   = VALUES(description),
  group_key     = VALUES(group_key);

-- ── 7 · a sender to start from ──────────────────────────────────────────────
--
-- Three rows, one per channel, on the simulator. A shop that opens this screen
-- should be able to build and preview a campaign immediately; connecting a real
-- provider is then editing a row rather than understanding a concept.
INSERT INTO messaging_senders (channel, name, provider, status, is_default, from_email, from_name, sms_header, display_phone, notes)
SELECT * FROM (
  SELECT 'email' AS channel, 'Veylor (default)' AS name, 'simulator' AS provider, 'active' AS status, 1 AS is_default,
         'hello@veylor.co.in' AS from_email, 'Veylor' AS from_name, NULL AS sms_header, NULL AS display_phone,
         'Simulated until a real mail provider is connected.' AS notes
  UNION ALL
  SELECT 'sms', 'VEYLOR (default)', 'simulator', 'active', 1, NULL, NULL, 'VEYLOR', NULL,
         'Add the PE ID and the registered header before sending anything commercial.'
  UNION ALL
  SELECT 'whatsapp', 'Veylor Business (default)', 'simulator', 'active', 1, NULL, NULL, NULL, NULL,
         'Add the WABA and phone number ID once the business account is verified.'
) AS seed
WHERE NOT EXISTS (SELECT 1 FROM messaging_senders WHERE deleted_at IS NULL);

-- Point the existing templates at the default sender for their channel, so a
-- preview has a From line on the first load.
UPDATE notification_templates t
  JOIN messaging_senders s ON s.channel = t.channel AND s.is_default = 1 AND s.deleted_at IS NULL
   SET t.sender_id = s.id
 WHERE t.sender_id IS NULL;

-- ── 8 · permissions ─────────────────────────────────────────────────────────
-- `notifications.manage` already exists. Reading the outbox is a different act
-- from sending to four thousand people, so it gets its own slug.
INSERT INTO permissions (slug, module, action, name, description)
SELECT 'notifications.view', 'notifications', 'view', 'View messaging',
       'Read message templates, campaigns and the delivery log'
WHERE NOT EXISTS (SELECT 1 FROM permissions WHERE slug = 'notifications.view');

-- Whoever can already send can already read.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, (SELECT id FROM permissions WHERE slug = 'notifications.view')
  FROM role_permissions rp
  JOIN permissions p ON p.id = rp.permission_id AND p.slug = 'notifications.manage'
 WHERE NOT EXISTS (
   SELECT 1 FROM role_permissions existing
    WHERE existing.role_id = rp.role_id
      AND existing.permission_id = (SELECT id FROM permissions WHERE slug = 'notifications.view')
 );

DROP PROCEDURE IF EXISTS veylor_add_column;
DROP PROCEDURE IF EXISTS veylor_add_index;

SELECT 'Migration 48 applied.' AS result;
