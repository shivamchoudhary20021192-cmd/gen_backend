/**
 * The merge fields a template may use, and the values behind them.
 *
 * This is the messaging equivalent of the page builder's section catalogue: the
 * admin does not hard-code a list of placeholders, it asks for one. Adding a
 * field here puts it in the editor's insert menu, in the preview, and in every
 * campaign's per-recipient resolution, with no frontend release.
 *
 * DLT note: India's registry counts placeholders and caps them — most operators
 * at six per template, each resolving to at most thirty characters. The
 * compliance check reads `dltCountsTowardsLimit` to know which of these are
 * variables in the registry's eyes; `unsubscribe_url` and the shop's own
 * constants are not, because they are fixed text in the registered template.
 */

export type VariableScope = 'customer' | 'shop' | 'order' | 'campaign' | 'product';

export interface VariableDefinition {
  key: string;
  label: string;
  scope: VariableScope;
  /** Shown in the insert menu and used to fill an empty preview. */
  example: string;
  help?: string;
  /** False for values that are constants in the registered template. */
  dltCountsTowardsLimit: boolean;
  /** Available when sending to a chosen audience, as opposed to only on an event. */
  availableInCampaigns: boolean;
}

export const MESSAGE_VARIABLES: VariableDefinition[] = [
  // ── the person ────────────────────────────────────────────────────────────
  { key: 'first_name', label: 'First name', scope: 'customer', example: 'Ananya', dltCountsTowardsLimit: true, availableInCampaigns: true },
  { key: 'last_name', label: 'Last name', scope: 'customer', example: 'Rao', dltCountsTowardsLimit: true, availableInCampaigns: true },
  {
    key: 'full_name',
    label: 'Full name',
    scope: 'customer',
    example: 'Ananya Rao',
    help: 'Falls back to the first name, then to "there", so a greeting is never blank.',
    dltCountsTowardsLimit: true,
    availableInCampaigns: true,
  },
  { key: 'phone', label: 'Phone', scope: 'customer', example: '98765 43210', dltCountsTowardsLimit: true, availableInCampaigns: true },
  { key: 'email', label: 'Email', scope: 'customer', example: 'ananya@example.com', dltCountsTowardsLimit: true, availableInCampaigns: true },
  { key: 'orders_count', label: 'Orders placed', scope: 'customer', example: '3', dltCountsTowardsLimit: true, availableInCampaigns: true },
  { key: 'total_spent', label: 'Lifetime spend', scope: 'customer', example: '₹8,450', dltCountsTowardsLimit: true, availableInCampaigns: true },
  { key: 'last_order_date', label: 'Last order date', scope: 'customer', example: '12 Aug', dltCountsTowardsLimit: true, availableInCampaigns: true },

  // ── the shop ──────────────────────────────────────────────────────────────
  { key: 'shop_name', label: 'Shop name', scope: 'shop', example: 'Veylor', dltCountsTowardsLimit: false, availableInCampaigns: true },
  { key: 'shop_url', label: 'Shop link', scope: 'shop', example: 'veylor.co.in', dltCountsTowardsLimit: false, availableInCampaigns: true },
  { key: 'support_phone', label: 'Support phone', scope: 'shop', example: '1800 000 000', dltCountsTowardsLimit: false, availableInCampaigns: true },
  {
    key: 'unsubscribe_url',
    label: 'Unsubscribe link',
    scope: 'shop',
    example: 'veylor.co.in/unsubscribe',
    help: 'Required in marketing email. Resolves per customer, so it stops only them.',
    dltCountsTowardsLimit: false,
    availableInCampaigns: true,
  },

  // ── the campaign ──────────────────────────────────────────────────────────
  {
    key: 'offer_code',
    label: 'Offer code',
    scope: 'campaign',
    example: 'VEYLOR15',
    help: 'Typed once on the campaign, the same for everyone who receives it.',
    dltCountsTowardsLimit: true,
    availableInCampaigns: true,
  },
  { key: 'offer_ends', label: 'Offer ends', scope: 'campaign', example: '30 Sep', dltCountsTowardsLimit: true, availableInCampaigns: true },
  { key: 'link', label: 'Link', scope: 'campaign', example: 'veylor.co.in/serum', dltCountsTowardsLimit: true, availableInCampaigns: true },

  // ── event-only ────────────────────────────────────────────────────────────
  { key: 'order_number', label: 'Order number', scope: 'order', example: 'VY-10482', dltCountsTowardsLimit: true, availableInCampaigns: false },
  { key: 'order_total', label: 'Order total', scope: 'order', example: '₹2,340', dltCountsTowardsLimit: true, availableInCampaigns: false },
  { key: 'tracking_url', label: 'Tracking link', scope: 'order', example: 'veylor.co.in/track/VY-10482', dltCountsTowardsLimit: true, availableInCampaigns: false },
  { key: 'otp', label: 'One-time code', scope: 'order', example: '482915', dltCountsTowardsLimit: true, availableInCampaigns: false },
  { key: 'product_name', label: 'Product name', scope: 'product', example: 'Radiance Serum', dltCountsTowardsLimit: true, availableInCampaigns: false },
];

const BY_KEY = new Map(MESSAGE_VARIABLES.map((variable) => [variable.key, variable]));

export function variableDefinition(key: string): VariableDefinition | null {
  return BY_KEY.get(key) ?? null;
}

/** An example value for anything, so a preview never shows a raw placeholder. */
export function exampleFor(key: string): string {
  return BY_KEY.get(key)?.example ?? key.replace(/[_.]/g, ' ');
}

/** Placeholders a campaign cannot fill, because they belong to an event. */
export function unavailableInCampaigns(keys: string[]): string[] {
  return keys.filter((key) => {
    const definition = BY_KEY.get(key);
    // An unknown key is assumed to be campaign-level and supplied by hand.
    return definition ? !definition.availableInCampaigns : false;
  });
}
