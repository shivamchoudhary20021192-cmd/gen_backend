/**
 * Tables that belong to the platform rather than to any one shop.
 *
 * Everything else with a `shop_id` column is tenant data, and the tenant guard
 * will refuse a statement that touches it without scoping by shop. A table is
 * on this list because it is read BEFORE a shop is known — resolving a
 * hostname, signing a person in, claiming the next job — or because it is the
 * same for every shop (the admin menu, the permission catalogue).
 *
 * Adding a table here is a security decision: it switches the guard off for
 * that table. It should be rare, and reviewed as such.
 */
export const CONTROL_PLANE_TABLES: ReadonlySet<string> = new Set([
  'schema_migrations',

  // the platform
  'pods',
  'plans',
  'organizations',
  'shops',
  'shop_domains',
  // a domain's history and the domains bought for shops: resolved and swept across every shop
  'domain_events',
  'domain_registrations',
  // each shop's storefront content version, polled by every API pod
  'storefront_versions',
  'shop_subscriptions',
  'shop_staff',

  // platform billing: the platform's bills to its shops, run by the billing
  // job across every shop before any one is in context
  'plan_prices',
  'billing_accounts',
  'platform_invoices',
  'platform_invoice_lines',
  'maintenance_runs',

  // the platform's own email to merchants and staff
  'platform_emails',

  // identity — one person, many shops
  'admin_users',
  'admin_sessions',
  'admin_password_resets',

  // admin chrome, identical in every shop
  'permissions',
  'menu_items',
  'menu_item_permissions',
  'menu_items_with_section',
  'sidebar_sections',
  'admin_menu_preferences',
  'user_sidebar_preferences',
  'menu_item_analytics',

  // infrastructure
  'exchange_rates',
  'rate_limits',
  'api_rate_buckets',
  'job_runs',
  'media_migrations',
  'feature_flags',
  'jobs',
  'job_schedules',

  // app platform: resolved from a token or client id before the shop is known
  'apps',
  'app_access_tokens',
  'oauth_authorization_codes',
  'storefront_access_tokens',

  // theme store
  'theme_library',
  // …and its files: the theme store's source, shared by every store.
  'theme_library_files',
  // apps' theme extensions: an app's blocks, the same on every store it is installed on
  'app_theme_extensions',
]);
