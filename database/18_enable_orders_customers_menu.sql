-- ─────────────────────────────────────────────────────────────────────────────
-- Turn on the Orders and Customers menu entries now that the screens exist.
--
-- Only the rows that have a screen behind them. The rest of the Orders group
-- (abandoned carts, returns, shipments, invoices) and of the Customers group
-- (segments, consents & privacy) stay `coming_soon` on purpose — the admin
-- build greys out anything it cannot render, and flipping a row to `available`
-- without a screen just produces a link that falls through to the catch-all
-- redirect.
--
-- Note the parent rows and the ".all" children both point at the same route.
-- Setting only the parent leaves the child greyed inside an enabled group,
-- which looks broken; setting both is what makes the group behave.
--
-- Idempotent: safe to run more than once.
-- ─────────────────────────────────────────────────────────────────────────────

UPDATE menu_items
   SET status = 'available', is_active = 1
 WHERE menu_key IN ('orders', 'orders.all', 'customers', 'customers.all');
