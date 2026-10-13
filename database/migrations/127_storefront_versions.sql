-- =============================================================================
-- 127 — Storefront content versions: page caching without purges.
--
-- Every shop has a content version. Any committed write to a table that can
-- change what a shopper sees (products, collections, pages, the theme,
-- settings, markets, translations, …) bumps it, at most once every couple of
-- seconds per shop. Rendered pages are cached under a key that includes the
-- version — in each API pod's memory and at the edge — so a change makes every
-- cached page of that shop unreachable at once, everywhere, without a single
-- purge call. Old entries simply age out.
--
-- API pods poll this table for rows changed since their last look (one query
-- per pod every ~2 s, whatever the number of shops) and clear their in-process
-- caches for those shops, which is also how a change made on one pod reaches
-- the others.
-- =============================================================================

CREATE TABLE IF NOT EXISTS storefront_versions (
  shop_id     BIGINT UNSIGNED NOT NULL,
  version     BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at  DATETIME(3)     NOT NULL,
  PRIMARY KEY (shop_id),
  KEY idx_storefront_versions_updated (updated_at),
  CONSTRAINT fk_storefront_versions_shop FOREIGN KEY (shop_id) REFERENCES shops (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
