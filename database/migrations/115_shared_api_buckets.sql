-- =============================================================================
-- 115 — App API rate limits shared by every API node.
--
-- The leaky bucket per (shop, app) lived in each process, so behind N nodes an
-- app could reach N times its plan's rate. One row per bucket, updated by a
-- single atomic statement per call, makes the limit the limit.
--
-- `result` exists only to hand the statement's outcome back through
-- LAST_INSERT_ID(): whether the call was accepted, and the level after it.
-- =============================================================================

CREATE TABLE IF NOT EXISTS `api_rate_buckets` (
  `bucket_key`  VARCHAR(80)     NOT NULL,
  `level`       DOUBLE          NOT NULL,
  -- Milliseconds since the epoch, from the API node's clock.
  `updated_ms`  BIGINT UNSIGNED NOT NULL,
  `result`      BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (`bucket_key`),
  KEY `ix_api_rate_buckets_updated` (`updated_ms`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
