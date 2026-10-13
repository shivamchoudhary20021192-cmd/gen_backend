-- =============================================================================
-- 138 — Idempotency-Key replays shared by every API node.
--
-- The Idempotency-Key middleware kept its keys in a Map inside each process.
-- Behind more than one node, a double-clicked "Ship" or "Refund" could land on
-- two nodes and run twice; after a deploy, a retry of a request that had
-- already succeeded ran again. One row per key on the control plane makes the
-- key mean the same thing everywhere.
--
--   key_hash          SHA-256 of shop : principal : method : path : key. The
--                     key itself is client data and is not stored.
--   state             in_flight while the first request runs, completed once
--                     its 2xx response is stored. Failures delete the row, so
--                     a corrected retry runs.
--   lease_expires_at  An in-flight claim is abandoned after this (the node
--                     died mid-request) and the next request with the key
--                     takes it over instead of getting 409 until expiry.
--   expires_at        When the key may be reused for a new request.
--
-- Swept by platform.maintenance. Idempotent: safe to run again.
-- =============================================================================

SET NAMES utf8mb4;

CREATE TABLE IF NOT EXISTS `idempotency_keys` (
  `key_hash`          CHAR(64)                       NOT NULL,
  `state`             ENUM('in_flight','completed')  NOT NULL,
  `response_status`   SMALLINT UNSIGNED              NULL,
  `response_body`     MEDIUMTEXT                     NULL,
  `lease_expires_at`  DATETIME(3)                    NOT NULL,
  `expires_at`        DATETIME(3)                    NOT NULL,
  `created_at`        DATETIME(3)                    NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`key_hash`),
  KEY `ix_idempotency_keys_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
