/**
 * Access scopes: what a merchant grants an app, in Shopify's vocabulary.
 *
 * Each scope compiles down to the permission slugs the Admin API routes
 * already check, so `requirePermission('products.update')` protects a route
 * from staff and apps alike, and nothing about a route changes to open it to
 * apps. `write_x` implies `read_x`, as it does on Shopify.
 *
 * Deliberately absent: staff management, roles, billing, domains and
 * integrations. Those change who controls the shop, and no app token should be
 * able to — a merchant who wants that has to do it themselves.
 */

export interface ScopeDefinition {
  scope: string;
  /** What the merchant reads on the consent screen. */
  description: string;
  permissions: string[];
}

const DEFINITIONS: ScopeDefinition[] = [
  { scope: 'read_products', description: 'View products, variants and collections', permissions: ['products.view'] },
  {
    scope: 'write_products',
    description: 'Create, edit and delete products and collections',
    permissions: ['products.view', 'products.create', 'products.update', 'products.delete', 'products.publish', 'products.price_update'],
  },
  { scope: 'read_inventory', description: 'View stock levels and locations', permissions: ['inventory.view'] },
  { scope: 'write_inventory', description: 'Adjust stock levels', permissions: ['inventory.view', 'inventory.adjust'] },
  { scope: 'read_orders', description: 'View orders, invoices and returns', permissions: ['orders.view', 'invoices.view'] },
  {
    scope: 'write_orders',
    description: 'Edit, cancel and refund orders; manage returns',
    permissions: ['orders.view', 'invoices.view', 'orders.update', 'orders.cancel', 'orders.refund', 'returns.manage'],
  },
  { scope: 'read_fulfillments', description: 'View shipments and tracking', permissions: ['orders.view'] },
  { scope: 'write_fulfillments', description: 'Create shipments and update tracking', permissions: ['orders.view', 'orders.fulfil'] },
  { scope: 'read_customers', description: 'View customers and their addresses', permissions: ['customers.view'] },
  {
    scope: 'write_customers',
    description: 'Create and edit customers',
    permissions: ['customers.view', 'customers.update', 'customers.delete'],
  },
  { scope: 'read_discounts', description: 'View discount codes', permissions: ['coupons.view'] },
  { scope: 'write_discounts', description: 'Create and edit discount codes', permissions: ['coupons.view', 'coupons.manage'] },
  { scope: 'read_content', description: 'View pages, blog posts, menus and banners', permissions: ['cms.view'] },
  {
    scope: 'write_content',
    description: 'Edit and publish pages, blog posts, menus, banners and SEO',
    permissions: ['cms.view', 'cms.edit', 'cms.publish', 'cms.delete', 'cms.menus', 'cms.redirects', 'seo.manage'],
  },
  { scope: 'read_files', description: 'View uploaded images and files', permissions: ['media.view'] },
  { scope: 'write_files', description: 'Upload and delete images and files', permissions: ['media.view', 'media.upload', 'media.delete'] },
  { scope: 'read_themes', description: 'View themes', permissions: ['themes.view'] },
  { scope: 'write_themes', description: 'Edit and publish themes', permissions: ['themes.view', 'themes.manage'] },
  { scope: 'read_reviews', description: 'View product reviews', permissions: ['reviews.view'] },
  { scope: 'write_reviews', description: 'Moderate and reply to reviews', permissions: ['reviews.view', 'reviews.moderate'] },
  { scope: 'read_analytics', description: 'View sales and traffic reports', permissions: ['analytics.view'] },
  { scope: 'read_marketing', description: 'View campaigns and message templates', permissions: ['notifications.view'] },
  {
    scope: 'write_marketing',
    description: 'Create campaigns and send customer messages',
    permissions: ['notifications.view', 'notifications.manage'],
  },
];

const BY_SCOPE = new Map(DEFINITIONS.map((definition) => [definition.scope, definition]));

export const ALL_SCOPES: readonly string[] = DEFINITIONS.map((definition) => definition.scope);

export function scopeDefinition(scope: string): ScopeDefinition | undefined {
  return BY_SCOPE.get(scope);
}

/**
 * "read_products, write_orders" or an array → a sorted, de-duplicated list with
 * implied reads added. Unknown scopes are returned separately so the caller can
 * refuse them by name.
 */
export function normaliseScopes(input: string | string[]): { scopes: string[]; unknown: string[] } {
  const raw = (Array.isArray(input) ? input : input.split(','))
    .map((scope) => scope.trim().toLowerCase())
    .filter(Boolean);
  const scopes = new Set<string>();
  const unknown: string[] = [];
  for (const scope of raw) {
    if (!BY_SCOPE.has(scope)) {
      unknown.push(scope);
      continue;
    }
    scopes.add(scope);
    if (scope.startsWith('write_')) scopes.add(`read_${scope.slice('write_'.length)}`);
  }
  return { scopes: [...scopes].sort(), unknown };
}

export function permissionsForScopes(scopes: string[]): Set<string> {
  const permissions = new Set<string>();
  for (const scope of scopes) {
    for (const permission of BY_SCOPE.get(scope)?.permissions ?? []) permissions.add(permission);
  }
  return permissions;
}

/** True when every scope in `needed` is covered by `granted` (write covers read). */
export function scopesCover(granted: string[], needed: string[]): boolean {
  const have = new Set(normaliseScopes(granted).scopes);
  return needed.every((scope) => have.has(scope));
}

export function describeScopes(scopes: string[]): ScopeDefinition[] {
  return scopes.map((scope) => BY_SCOPE.get(scope)).filter((d): d is ScopeDefinition => Boolean(d));
}
