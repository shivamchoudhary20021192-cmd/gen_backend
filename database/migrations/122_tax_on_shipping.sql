-- =============================================================================
-- 122 — Tax on delivery, for stores taxed by product class (GST, VAT).
--
-- Under VAT and GST a delivery charge is part of what is sold and is taxed
-- like the goods it delivers: at their rate, or — when an order mixes rates —
-- split across the rates in proportion to the goods (exempt goods take their
-- share untaxed). Until now class-rate stores never taxed delivery at all.
--
-- On by default, because that is what the regimes require. Where prices
-- include tax (the common case), the customer pays exactly what they did
-- before: the tax already inside the delivery charge is now shown on the
-- invoice instead of being counted as untaxed. A store with a reason to
-- differ turns it off in Settings → Taxes. Stores taxed by destination (US,
-- Canada) keep deciding per registration, as before.
-- =============================================================================

ALTER TABLE `shops`
  ADD COLUMN `tax_shipping` TINYINT(1) UNSIGNED NOT NULL DEFAULT 1 AFTER `tax_engine`;
