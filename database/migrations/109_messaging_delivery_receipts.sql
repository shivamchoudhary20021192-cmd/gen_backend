-- =============================================================================
-- 109 — Indexes for delivery receipts.
--
-- Providers report delivery by their own message id (Twilio's SM…, SendGrid's
-- X-Message-Id, Meta's wamid…). Every receipt looks the message up by that id,
-- and a campaign's recipient row by the log row it produced; without these a
-- busy shop's receipts each scan the whole outbox.
-- =============================================================================

ALTER TABLE `notification_logs`
  ADD KEY `ix_notification_logs_provider_message` (`shop_id`, `provider_message_id`),
  ADD KEY `ix_notification_logs_inbound` (`shop_id`, `direction`, `channel`, `recipient`, `queued_at`);

ALTER TABLE `message_campaign_recipients`
  ADD KEY `ix_message_campaign_recipients_log` (`shop_id`, `log_id`);
