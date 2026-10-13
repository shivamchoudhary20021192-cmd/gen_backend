-- ─────────────────────────────────────────────────────────────────────────────
-- Turn on the remaining Orders group entries now that the screens exist.
--
-- Same rule as migration 18: a row is only flipped to `available` once the
-- admin build can render it. `src/navigation/routeRegistry.ts` is the other half
-- of that pairing, and both change on the same commit.
--
-- Idempotent: safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE menu_items
   SET status = 'available', is_active = 1
 WHERE menu_key IN ('orders.abandoned', 'orders.returns', 'orders.shipments', 'orders.invoices');
