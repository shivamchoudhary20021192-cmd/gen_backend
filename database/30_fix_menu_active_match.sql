-- ============================================================================
-- Fix Menu Active Match Patterns
-- ============================================================================
-- This migration fixes the active_match field to prevent multiple menu items
-- from being highlighted simultaneously. Parent items use $ anchor for exact
-- match, child items use full paths.
-- 
-- ALSO: Changes segments route from /customers/segments to /segments
-- ============================================================================

-- No USE: the migration runner connects to the configured database already
-- (this said `USE veylog_db`, which is not this project's database name).

-- ============================================================================
-- FIX ROUTES (Simplify nested routes to root level)
-- ============================================================================

-- Change segments route from /customers/segments to /segments
UPDATE menu_items 
SET route = '/segments' 
WHERE menu_key = 'customers.segments';

-- Change abandoned carts route from /orders/abandoned to /abandoned
UPDATE menu_items 
SET route = '/abandoned' 
WHERE menu_key = 'orders.abandoned';

-- ============================================================================
-- PARENT MENU ITEMS (Top-level with dropdowns)
-- These should ONLY highlight on their exact path, not child routes
-- ============================================================================

-- Dashboard - exact match only
UPDATE menu_items 
SET active_match = '/dashboard$' 
WHERE menu_key = 'dashboard';

-- Orders - exact match only (don't highlight when on /orders/abandoned)
UPDATE menu_items 
SET active_match = '/orders$' 
WHERE menu_key = 'orders';

-- Products - exact match only (don't highlight when on /products/:id)
UPDATE menu_items 
SET active_match = '/products$' 
WHERE menu_key = 'products';

-- Customers - matches base route and customer detail pages, but NOT /segments
UPDATE menu_items 
SET active_match = '/customers(/[0-9]+)?$' 
WHERE menu_key = 'customers';

-- Discounts - exact match only
UPDATE menu_items 
SET active_match = '/discounts$' 
WHERE menu_key = 'discounts';

-- Content - no route (parent only, never highlights)
UPDATE menu_items 
SET active_match = NULL 
WHERE menu_key = 'content';

-- Settings - no route (parent only, never highlights)
UPDATE menu_items 
SET active_match = NULL 
WHERE menu_key = 'settings';

-- Support - exact match only
UPDATE menu_items 
SET active_match = '/support$' 
WHERE menu_key = 'support';

-- ============================================================================
-- ORDERS SUB-MENU ITEMS
-- ============================================================================

-- All orders - exact /orders path
UPDATE menu_items 
SET active_match = '/orders$' 
WHERE menu_key = 'orders.all';

-- Abandoned carts - specific path
UPDATE menu_items 
SET active_match = '/abandoned' 
WHERE menu_key = 'orders.abandoned';

-- Returns - specific path
UPDATE menu_items 
SET active_match = '/returns' 
WHERE menu_key = 'orders.returns';

-- Shipments - specific path
UPDATE menu_items 
SET active_match = '/shipments' 
WHERE menu_key = 'orders.shipments';

-- Invoices - specific path
UPDATE menu_items 
SET active_match = '/invoices' 
WHERE menu_key = 'orders.invoices';

-- ============================================================================
-- PRODUCTS SUB-MENU ITEMS
-- ============================================================================

-- All products - matches /products, /products/new, /products/:id
UPDATE menu_items 
SET active_match = '/products(/new|/[0-9]+(/edit)?)?$' 
WHERE menu_key = 'products.all';

-- Inventory - specific path
UPDATE menu_items 
SET active_match = '/inventory' 
WHERE menu_key = 'products.inventory';

-- Categories - specific path
UPDATE menu_items 
SET active_match = '/categories' 
WHERE menu_key = 'products.categories';

-- Collections - specific path
UPDATE menu_items 
SET active_match = '/collections' 
WHERE menu_key = 'products.collections';

-- Ingredients - specific path
UPDATE menu_items 
SET active_match = '/ingredients' 
WHERE menu_key = 'products.ingredients';

-- Claims - specific path
UPDATE menu_items 
SET active_match = '/claims' 
WHERE menu_key = 'products.claims';

-- Reviews - specific path
UPDATE menu_items 
SET active_match = '/reviews' 
WHERE menu_key = 'products.reviews';

-- ============================================================================
-- CUSTOMERS SUB-MENU ITEMS
-- ============================================================================

-- All customers - matches /customers and /customers/:id (detail pages)
UPDATE menu_items 
SET active_match = '/customers(/[0-9]+)?$' 
WHERE menu_key = 'customers.all';

-- Segments - NEW ROUTE: /segments (parent_id still customers)
UPDATE menu_items 
SET active_match = '/segments' 
WHERE menu_key = 'customers.segments';

-- Privacy - specific path
UPDATE menu_items 
SET active_match = '/privacy' 
WHERE menu_key = 'customers.privacy';

-- ============================================================================
-- CONTENT SUB-MENU ITEMS
-- ============================================================================

-- Pages - specific path
UPDATE menu_items 
SET active_match = '/content/pages' 
WHERE menu_key = 'content.pages';

-- Articles/Journal - specific path
UPDATE menu_items 
SET active_match = '/content/articles' 
WHERE menu_key = 'content.articles';

-- Banners - specific path
UPDATE menu_items 
SET active_match = '/content/banners' 
WHERE menu_key = 'content.banners';

-- FAQs - specific path
UPDATE menu_items 
SET active_match = '/content/faqs' 
WHERE menu_key = 'content.faqs';

-- Storefront navigation/Menus - specific path
UPDATE menu_items 
SET active_match = '/content/menus' 
WHERE menu_key = 'content.menus';

-- Redirects - specific path
UPDATE menu_items 
SET active_match = '/content/redirects' 
WHERE menu_key = 'content.redirects';

-- ============================================================================
-- STANDALONE MENU ITEMS
-- ============================================================================

-- Media - specific path
UPDATE menu_items 
SET active_match = '/media' 
WHERE menu_key = 'media';

-- Analytics - specific path
UPDATE menu_items 
SET active_match = '/analytics' 
WHERE menu_key = 'analytics';

-- Analytics Search - specific path
UPDATE menu_items 
SET active_match = '/analytics/search' 
WHERE menu_key = 'analytics.search';

-- Loyalty - specific path
UPDATE menu_items 
SET active_match = '/loyalty' 
WHERE menu_key = 'loyalty';

-- Subscribers - specific path
UPDATE menu_items 
SET active_match = '/subscribers' 
WHERE menu_key = 'subscribers';

-- Notifications - specific path
UPDATE menu_items 
SET active_match = '/notifications' 
WHERE menu_key = 'notifications';

-- ============================================================================
-- SUPPORT SUB-MENU ITEMS
-- ============================================================================

-- Tickets - exact /support path
UPDATE menu_items 
SET active_match = '/support$' 
WHERE menu_key = 'support.tickets';

-- Adverse events - specific path
UPDATE menu_items 
SET active_match = '/support/adverse-events' 
WHERE menu_key = 'support.adverse';

-- ============================================================================
-- SETTINGS SUB-MENU ITEMS
-- ============================================================================

-- Store details - specific path
UPDATE menu_items 
SET active_match = '/settings/store' 
WHERE menu_key = 'settings.store';

-- Shipping - specific path
UPDATE menu_items 
SET active_match = '/settings/shipping' 
WHERE menu_key = 'settings.shipping';

-- Taxes - specific path
UPDATE menu_items 
SET active_match = '/settings/taxes' 
WHERE menu_key = 'settings.taxes';

-- Payments - specific path
UPDATE menu_items 
SET active_match = '/settings/payments' 
WHERE menu_key = 'settings.payments';

-- Staff - specific path
UPDATE menu_items 
SET active_match = '/settings/staff' 
WHERE menu_key = 'settings.staff';

-- Roles - specific path
UPDATE menu_items 
SET active_match = '/settings/roles' 
WHERE menu_key = 'settings.roles';

-- Navigation - specific path
UPDATE menu_items 
SET active_match = '/settings/navigation' 
WHERE menu_key = 'settings.navigation';

-- Audit log - specific path
UPDATE menu_items 
SET active_match = '/settings/audit' 
WHERE menu_key = 'settings.audit';

-- Import & Export - specific path
UPDATE menu_items 
SET active_match = '/settings/data' 
WHERE menu_key = 'settings.data';

-- ============================================================================
-- VERIFICATION
-- ============================================================================

SELECT 
    id,
    menu_key,
    title,
    route,
    active_match,
    parent_id
FROM menu_items 
WHERE is_active = 1 
ORDER BY sort_order;

-- ============================================================================
-- NOTES
-- ============================================================================
-- Pattern Explanation:
-- 1. '/path$' - Exact match only (e.g., /orders matches, /orders/123 does not)
-- 2. '/path' - Prefix match (e.g., /segments matches /segments, /segments/123, /segments/new)
-- 3. '/path(/sub1|/sub2)?$' - Regex pattern for multiple specific paths
-- 4. '/path(/[0-9]+)?$' - Matches /path and /path/:id but NOT /path/segments
-- 5. NULL - Never highlights (used for parent-only menu items)
--
-- Examples:
-- - When on /customers → "All customers" highlights
-- - When on /customers/123 → "All customers" highlights
-- - When on /segments → "Segments" highlights (NOT "All customers")
-- - When on /segments/new → "Segments" highlights
-- - When on /orders → "All orders" highlights
-- - When on /abandoned → "Abandoned carts" highlights (NOT "All orders")
-- - When on /products → "All products" highlights
-- - When on /inventory → "Inventory" highlights (NOT "All products")
--
-- Route Changes (Simplified):
-- - OLD: /customers/segments → NEW: /segments (still under Customers parent)
-- - OLD: /orders/abandoned → NEW: /abandoned (still under Orders parent)
--
-- This ensures only ONE menu item highlights at a time based on current route.
-- ============================================================================
