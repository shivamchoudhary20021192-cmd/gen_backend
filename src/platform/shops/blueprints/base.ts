import { callingCodeFor } from '../../geo/phone';
import type {
  NotificationTemplateSeed,
  ProvisionInput,
  RegionProfile,
  RoleSeed,
  SettingSeed,
} from './types';

/**
 * What every shop starts with, whatever it sells and wherever it is.
 *
 * Drawn from the founding shop's own configuration, with everything that was
 * specific to it (its name, its GSTIN, its rupee thresholds, "Veylor" in the
 * templates) turned into values that come from the new shop or its region.
 */

export const BASE_ROLES: RoleSeed[] = [
  {
    slug: 'founder',
    name: 'Administrator',
    description: 'Everything in the store, including staff, billing and apps.',
    level: 10,
    permissions: '*',
  },
  {
    slug: 'developer',
    name: 'Developer',
    description: 'Apps, webhooks, integrations, themes and store settings. No orders or customers beyond viewing.',
    level: 20,
    permissions: [
      'analytics.view', 'apps.develop', 'apps.manage', 'apps.view', 'audit.view', 'cms.view', 'integrations.manage',
      'integrations.view', 'inventory.view', 'media.migrate', 'media.view', 'orders.view', 'products.view',
      'settings.manage', 'settings.view', 'shop.view', 'themes.manage', 'themes.view', 'webhooks.manage',
    ],
  },
  {
    slug: 'operations',
    name: 'Operations',
    description: 'Orders, fulfilment, inventory, cancellations and returns.',
    level: 30,
    permissions: [
      'analytics.view', 'coupons.view', 'customers.view', 'gift_cards.view', 'inventory.adjust', 'inventory.view', 'invoices.view',
      'orders.cancel', 'orders.fulfil', 'orders.update', 'orders.view', 'products.view', 'returns.manage', 'support.view',
    ],
  },
  {
    slug: 'content',
    name: 'Content',
    description: 'Pages, blog, media, SEO and the theme. No payment or refund access.',
    level: 40,
    permissions: [
      'analytics.view', 'apps.view', 'claims.manage', 'cms.edit', 'cms.menus', 'cms.publish', 'cms.redirects', 'cms.view',
      'integrations.view', 'media.delete', 'media.upload', 'media.view', 'products.view', 'reviews.moderate',
      'reviews.view', 'seo.manage', 'shop.view', 'themes.manage', 'themes.view',
    ],
  },
  {
    slug: 'growth',
    name: 'Marketing',
    description: 'Discounts, campaigns, landing pages and reports.',
    level: 45,
    permissions: [
      'analytics.view', 'cms.edit', 'cms.publish', 'cms.view', 'coupons.manage', 'coupons.view', 'gift_cards.manage', 'gift_cards.view',
      'media.upload', 'media.view', 'notifications.manage', 'notifications.view', 'products.view', 'seo.manage',
    ],
  },
  {
    slug: 'support',
    name: 'Customer support',
    description: 'Order lookup, notes, approved refunds and returns.',
    level: 50,
    permissions: [
      'coupons.view', 'customers.view', 'gift_cards.view', 'invoices.view', 'orders.update', 'orders.view', 'returns.manage',
      'reviews.view', 'support.respond', 'support.view',
    ],
  },
];

/** Order-number prefix: the handle's first letters, "VEY" for "veylor". */
export function orderPrefix(handle: string): string {
  const letters = handle.replace(/[^a-z]/gi, '').toUpperCase();
  return (letters.slice(0, 3) || 'ORD').padEnd(3, 'X');
}

export function sequences(input: ProvisionInput) {
  return [
    { name: 'order', prefix: orderPrefix(input.handle), padding: 7 },
    { name: 'invoice', prefix: 'INV', padding: 7 },
    { name: 'credit_note', prefix: 'CRN', padding: 6 },
    { name: 'shipment', prefix: 'SHP', padding: 6 },
    { name: 'return', prefix: 'RET', padding: 7 },
    { name: 'rma', prefix: 'RMA', padding: 6 },
  ];
}

const bool = (value: boolean) => (value ? '1' : '0');

/** The settings catalogue, valued for this shop and its region. */
export function settings(input: ProvisionInput, region: RegionProfile): SettingSeed[] {
  const india = input.countryCode === 'IN';
  const calling = callingCodeFor(input.countryCode) ?? '';
  const r = region.settings;
  const list: SettingSeed[] = [
    // store
    { group: 'store', key: 'store.name', label: 'Store name', type: 'string', value: input.shopName, isPublic: true },
    { group: 'store', key: 'store.legal_name', label: 'Legal name', type: 'string', value: input.shopName },
    { group: 'store', key: 'store.currency', label: 'Currency', type: 'string', value: input.currency, isPublic: true },
    { group: 'store', key: 'store.timezone', label: 'Timezone', type: 'string', value: input.timezone },
    { group: 'store', key: 'store.support_email', label: 'Support email', type: 'string', value: input.email ?? '', isPublic: true },
    { group: 'store', key: 'store.support_phone', label: 'Support phone', type: 'string', value: input.phone ?? '', isPublic: true },
    { group: 'store', key: 'store.support_hours', label: 'Support hours', type: 'string', value: '', isPublic: true },
    { group: 'store', key: 'store.gstin', label: india ? 'GSTIN' : 'Tax registration number', type: 'string', value: '' },
    { group: 'store', key: 'store.grievance_officer', label: 'Grievance officer', type: 'json', value: '', isPublic: true },
    // auth
    { group: 'auth', key: 'auth.access_token_minutes', label: 'Access token lifetime (min)', type: 'number', value: '15' },
    { group: 'auth', key: 'auth.refresh_token_days', label: 'Refresh token lifetime (days)', type: 'number', value: '30' },
    { group: 'auth', key: 'auth.admin_session_hours', label: 'Admin session lifetime (hours)', type: 'number', value: '8' },
    { group: 'auth', key: 'auth.admin_mfa_required', label: 'Require MFA for staff', type: 'boolean', value: '0' },
    // cart
    { group: 'cart', key: 'cart.expiry_days', label: 'Cart persistence (days)', type: 'number', value: '30' },
    { group: 'cart', key: 'cart.max_line_quantity', label: 'Max units per line', type: 'number', value: '10', isPublic: true },
    { group: 'cart', key: 'cart.reservation_minutes', label: 'Checkout stock hold (min)', type: 'number', value: '15' },
    // inventory
    { group: 'inventory', key: 'inventory.low_stock_threshold', label: 'Low stock alert threshold', type: 'number', value: '5' },
    { group: 'inventory', key: 'inventory.allow_backorder', label: 'Allow backorders', type: 'boolean', value: '0' },
    // invoice
    { group: 'invoice', key: 'seller_legal_name', label: 'Legal entity name', type: 'string', value: input.shopName, sortOrder: 10, description: 'Printed as the seller on every invoice.' },
    { group: 'invoice', key: 'seller_gstin', label: india ? 'Seller GSTIN' : 'Seller tax number', type: 'string', value: '', sortOrder: 20, description: 'Your registration number, printed on tax invoices.' },
    { group: 'invoice', key: 'seller_address', label: 'Registered address', type: 'string', value: '', sortOrder: 30, description: 'The registered address printed on the invoice.' },
    { group: 'invoice', key: 'invoice_prefix', label: 'Invoice number prefix', type: 'string', value: 'INV', sortOrder: 40, description: 'Changing this mid-year breaks the sequence auditors expect.' },
    // media
    { group: 'media', key: 'media.max_upload_mb', label: 'Max upload size (MB)', type: 'number', value: '25' },
    { group: 'media', key: 'media.allowed_mime', label: 'Allowed MIME types', type: 'json', value: '["image/jpeg","image/png","image/webp","image/avif","image/gif","video/mp4","video/webm","application/pdf"]' },
    { group: 'media', key: 'media.variant_widths', label: 'Variant widths', type: 'json', value: '{"thumb":160,"sm":400,"md":800,"lg":1200,"xl":1920}' },
    { group: 'media', key: 'media.variant_formats', label: 'Variant formats', type: 'json', value: '["webp","avif"]' },
    { group: 'media', key: 'media.keep_original', label: 'Keep original file', type: 'boolean', value: '1' },
    // messaging
    { group: 'messaging', key: 'messaging.timezone', label: 'Messaging timezone', type: 'string', value: input.timezone, defaultValue: input.timezone, sortOrder: 10, description: 'The clock every quiet-hours rule is read against.' },
    { group: 'messaging', key: 'messaging.marketing_window_start', label: 'Promotional messages from', type: 'string', value: r['messaging.marketing_window_start'] ?? '09:00', defaultValue: r['messaging.marketing_window_start'] ?? '09:00', sortOrder: 20 },
    { group: 'messaging', key: 'messaging.marketing_window_end', label: 'Promotional messages until', type: 'string', value: r['messaging.marketing_window_end'] ?? '21:00', defaultValue: r['messaging.marketing_window_end'] ?? '21:00', sortOrder: 30 },
    { group: 'messaging', key: 'messaging.frequency_cap_hours', label: 'Leave alone for (hours)', type: 'number', value: '72', defaultValue: '72', sortOrder: 40, description: 'How long after a marketing message before the same person may receive another.' },
    { group: 'messaging', key: 'messaging.enforce_dlt', label: 'Require a DLT template ID for SMS', type: 'boolean', value: india ? 'true' : 'false', defaultValue: india ? 'true' : 'false', sortOrder: 50, description: 'Indian operators reject commercial SMS without one.' },
    { group: 'messaging', key: 'messaging.require_opt_out', label: 'Require an opt-out line in marketing', type: 'boolean', value: 'true', defaultValue: 'true', sortOrder: 60 },
    { group: 'messaging', key: 'messaging.opt_out_text_sms', label: 'SMS opt-out wording', type: 'string', value: 'To stop, reply STOP', defaultValue: 'To stop, reply STOP', sortOrder: 70 },
    { group: 'messaging', key: 'messaging.default_country_code', label: 'Default country code', type: 'string', value: calling, defaultValue: calling, sortOrder: 80, description: 'Used when a stored phone number has none.' },
    { group: 'messaging', key: 'messaging.campaign_batch_size', label: 'Messages per batch', type: 'number', value: '200', defaultValue: '200', sortOrder: 90 },
    { group: 'messaging', key: 'messaging.simulator_delivery_rate', label: 'Simulator delivery rate (%)', type: 'number', value: '94', defaultValue: '94', sortOrder: 100 },
    // otp
    { group: 'otp', key: 'otp.length', label: 'OTP length', type: 'number', value: '6' },
    { group: 'otp', key: 'otp.expiry_seconds', label: 'OTP expiry (seconds)', type: 'number', value: '300' },
    { group: 'otp', key: 'otp.resend_cooldown_seconds', label: 'Resend cooldown', type: 'number', value: '30', isPublic: true },
    { group: 'otp', key: 'otp.max_attempts', label: 'Max verify attempts', type: 'number', value: '5' },
    { group: 'otp', key: 'otp.max_per_phone_per_hour', label: 'Max sends per phone per hour', type: 'number', value: '5' },
    { group: 'otp', key: 'otp.max_per_ip_per_hour', label: 'Max sends per IP per hour', type: 'number', value: '20' },
    { group: 'otp', key: 'otp.default_channel', label: 'Default channel', type: 'string', value: r['otp.default_channel'] ?? 'sms', isPublic: true },
    // payment
    { group: 'payment', key: 'payment.gateway', label: 'Active gateway', type: 'string', value: '' },
    { group: 'payment', key: 'payment.cod_enabled', label: 'Cash on delivery enabled', type: 'boolean', value: bool(region.cod !== null), isPublic: true },
    { group: 'payment', key: 'payment.capture_mode', label: 'Capture mode', type: 'string', value: 'automatic' },
    { group: 'payment', key: 'payment.test_mode', label: 'Test mode', type: 'boolean', value: '0' },
    { group: 'payment', key: 'payment.enabled_methods', label: 'Enabled payment methods', type: 'json', value: r['payment.enabled_methods'] ?? '["card","wallet"]', isPublic: true },
    // privacy
    { group: 'privacy', key: 'privacy.notice_version', label: 'Privacy notice version', type: 'string', value: '1.0', isPublic: true, description: 'Recorded on every consent row.' },
    { group: 'privacy', key: 'privacy.otp_log_retention_days', label: 'OTP log retention (days)', type: 'number', value: '90' },
    // seo
    { group: 'seo', key: 'seo.default_title_suffix', label: 'Title suffix', type: 'string', value: ` | ${input.shopName}`, isPublic: true },
    { group: 'seo', key: 'seo.noindex_site', label: 'Hide the store from search engines', type: 'boolean', value: '1', description: 'On until the store launches.' },
    // shipping
    { group: 'shipping', key: 'shipping.free_threshold', label: 'Free shipping above', type: 'number', value: String(region.shippingRates[0]?.freeAbove ?? ''), isPublic: true },
    { group: 'shipping', key: 'shipping.standard_cost', label: 'Standard shipping cost', type: 'number', value: String(region.shippingRates[0]?.rate ?? 0), isPublic: true },
    { group: 'shipping', key: 'shipping.origin_state_code', label: 'Ships from (region code)', type: 'string', value: '' },
  ];
  return list;
}

/**
 * Notification templates every shop starts with. `{{shop_name}}` everywhere a
 * brand name was, so they read right for any store. Merchants edit them in
 * Settings → Notifications.
 */
export const BASE_TEMPLATES: NotificationTemplateSeed[] = [
  { eventKey: 'otp.login', channel: 'sms', category: 'authentication', name: 'Sign-in code — SMS', body: '{{otp}} is your {{shop_name}} verification code. Valid for 5 minutes. Do not share it.' },
  { eventKey: 'otp.login', channel: 'whatsapp', category: 'authentication', name: 'Sign-in code — WhatsApp', body: '{{otp}} is your {{shop_name}} verification code. Valid for 5 minutes.' },
  { eventKey: 'order.confirmed', channel: 'email', category: 'transactional', name: 'Order confirmed — Email', subject: 'Your {{shop_name}} order {{order_number}}', body: 'Hi {{first_name}},\n\nThank you — your order {{order_number}} is confirmed, and we are getting it ready.\n\nTotal: {{order_total}}\n\nWe will write again the moment it ships.\n\n— {{shop_name}}' },
  { eventKey: 'order.confirmed', channel: 'sms', category: 'transactional', name: 'Order confirmed — SMS', body: '{{shop_name}}: order {{order_number}} confirmed. Track it at {{tracking_url}}' },
  { eventKey: 'order.confirmed', channel: 'whatsapp', category: 'transactional', name: 'Order confirmed — WhatsApp', body: 'Thank you for shopping with {{shop_name}}. Order {{order_number}} is confirmed.' },
  { eventKey: 'order.shipped', channel: 'email', category: 'transactional', name: 'Order shipped — Email', subject: 'Order {{order_number}} is on its way', body: 'Hi {{first_name}},\n\nGood news — order {{order_number}} has shipped.\n\nTrack it here: {{tracking_url}}\n\n— {{shop_name}}' },
  { eventKey: 'order.shipped', channel: 'sms', category: 'transactional', name: 'Order shipped — SMS', body: '{{shop_name}}: order {{order_number}} has shipped. Track: {{tracking_url}}' },
  { eventKey: 'order.shipped', channel: 'whatsapp', category: 'transactional', name: 'Order shipped — WhatsApp', body: 'Your {{shop_name}} order {{order_number}} is on its way. Track it: {{tracking_url}}' },
  { eventKey: 'order.out_for_delivery', channel: 'sms', category: 'transactional', name: 'Out for delivery — SMS', body: '{{shop_name}}: order {{order_number}} is out for delivery today.' },
  { eventKey: 'order.delivered', channel: 'email', category: 'transactional', name: 'Delivered — Email', subject: 'Order {{order_number}} was delivered', body: 'Hi {{first_name}},\n\nYour order {{order_number}} has been delivered. We hope you love it.\n\n— {{shop_name}}' },
  { eventKey: 'order.delivered', channel: 'whatsapp', category: 'transactional', name: 'Delivered — WhatsApp', body: 'Your {{shop_name}} order {{order_number}} has been delivered.' },
  { eventKey: 'order.cancelled', channel: 'email', category: 'transactional', name: 'Order cancelled — Email', subject: 'Order {{order_number}} cancelled', body: 'Hi {{first_name}},\n\nYour order {{order_number}} has been cancelled, and nothing further will be charged. Anything already paid is refunded to the original payment method.\n\nIf this was not you, reply to this email and we will look into it.\n\n— {{shop_name}}' },
  { eventKey: 'payment.failed', channel: 'email', category: 'transactional', name: 'Payment failed — Email', subject: 'We could not complete your payment', body: 'Hi {{first_name}},\n\nThe payment for order {{order_number}} did not go through, so we have not been able to start on it. Nothing has been charged.\n\nYou can try again here: {{link}}\n\n— {{shop_name}}' },
  { eventKey: 'gift_card.issued', channel: 'email', category: 'transactional', name: 'Gift card — Email', subject: 'Your {{gift_card_value}} {{shop_name}} gift card', body: 'Hi {{first_name}},\n\n{{gift_card_message}}You have a {{gift_card_value}} gift card for {{shop_name}}.\n\nCode: {{gift_card_code}}\n{{gift_card_expiry}}\nUse it at checkout, or see its balance any time: {{gift_card_url}}\n\n— {{shop_name}}' },
  { eventKey: 'gift_card.issued', channel: 'sms', category: 'transactional', name: 'Gift card — SMS', body: '{{shop_name}}: your {{gift_card_value}} gift card code is {{gift_card_code}}. Balance: {{gift_card_url}}' },
  { eventKey: 'gift_card.issued', channel: 'whatsapp', category: 'transactional', name: 'Gift card — WhatsApp', body: 'You have a {{gift_card_value}} gift card for {{shop_name}}. Code: {{gift_card_code}}. See it any time: {{gift_card_url}}' },
  { eventKey: 'refund.processed', channel: 'email', category: 'transactional', name: 'Refund processed — Email', subject: 'Your refund for {{order_number}}', body: 'Hi {{first_name}},\n\nYour refund for order {{order_number}} has been processed: {{order_total}}. Banks usually take a few working days to show it.\n\n— {{shop_name}}' },
  { eventKey: 'staff.order_placed', channel: 'email', category: 'transactional', name: 'New order — Staff email', subject: 'New order {{order_number}}', body: '{{title}}\n\n{{body}}\n\n— {{shop_name}}' },
  { eventKey: 'cart.abandoned', channel: 'email', category: 'marketing', name: 'Abandoned cart — Email', subject: 'You left something behind', body: 'Hi {{first_name}},\n\nYou left a few things in your bag at {{shop_name}}. They are saved for you here: {{link}}\n\n— {{shop_name}}\nNot interested in these? {{unsubscribe_url}}' },
  { eventKey: 'review.invite', channel: 'email', category: 'marketing', name: 'Review invitation — Email', subject: 'How are you finding your order?', body: 'Hi {{first_name}},\n\nYou ordered from {{shop_name}} a little while ago. If you have a minute, we would love to hear how it is going — it helps everyone who reads it before buying.\n\nLeave a review: {{link}}\n\n— {{shop_name}}\nNot interested in these? {{unsubscribe_url}}' },
  { eventKey: 'privacy.request_verify', channel: 'email', category: 'transactional', name: 'Privacy request: confirm it is you — Email', subject: 'Confirm your privacy request to {{shop_name}}', body: 'Hi,\n\nWe received a request to {{request_action}} the personal data {{shop_name}} holds about {{contact}}.\n\nIf this was you, confirm it here (the link works for 48 hours):\n{{link}}\n\nIf it was not you, ignore this email — nothing will happen.\n\nReference: {{reference}}\n\n— {{shop_name}}' },
  { eventKey: 'privacy.request_received', channel: 'email', category: 'transactional', name: 'Privacy request received — Email', subject: 'We have your privacy request {{reference}}', body: 'Hi {{first_name}},\n\nWe have your request to {{request_action}} your personal data, reference {{reference}}. We will respond by {{due_date}}.\n\nQuestions about it: {{privacy_contact}}\n\n— {{shop_name}}' },
  { eventKey: 'privacy.request_completed', channel: 'email', category: 'transactional', name: 'Privacy request completed — Email', subject: 'Your privacy request {{reference}} is complete', body: 'Hi {{first_name}},\n\n{{outcome}}\n\n{{link_line}}If you are not satisfied with how we handled it, contact {{privacy_contact}}.\n\n— {{shop_name}}' },
  { eventKey: 'staff.privacy_request', channel: 'email', category: 'transactional', name: 'New privacy request — Staff email', subject: 'New privacy request {{reference}}', body: '{{title}}\n\n{{body}}\n\n— {{shop_name}}' },
  { eventKey: 'stock.back_in_stock', channel: 'email', category: 'marketing', name: 'Back in stock — Email', subject: '{{product_name}} is back', body: 'Hi {{first_name}},\n\n{{product_name}} is back in stock at {{shop_name}}.\n\nHave a look: {{link}}\n\n— {{shop_name}}\nNot interested in these? {{unsubscribe_url}}' },
];

export const BASE_MENUS = [
  { slug: 'main', name: 'Main header' },
  { slug: 'mobile_drawer', name: 'Mobile drawer' },
  { slug: 'footer_shop', name: 'Footer — Shop' },
  { slug: 'footer_learn', name: 'Footer — About' },
  { slug: 'footer_support', name: 'Footer — Support' },
  { slug: 'footer_legal', name: 'Footer — Legal' },
];

export const BASE_MEDIA_FOLDERS = [
  { name: 'Products', slug: 'products' },
  { name: 'Banners', slug: 'banners' },
  { name: 'Brand', slug: 'brand' },
  { name: 'Editorial', slug: 'editorial' },
  { name: 'Documents', slug: 'documents' },
];

export const BASE_FAQ_GROUPS = [
  { slug: 'general', name: 'General', description: 'About the store and how it works.' },
  { slug: 'shipping', name: 'Shipping & delivery', description: 'Where we ship, how long it takes, what it costs.' },
  { slug: 'returns', name: 'Returns & refunds', description: 'How to send something back.' },
];

/** Customer segments, with spend thresholds in the shop's own currency. */
export function segments(region: RegionProfile) {
  const vip = region.currency === 'INR' ? 10000 : region.currency === 'JPY' ? 100000 : 1000;
  const high = vip / 2;
  return [
    { name: 'VIP customers', description: `Lifetime spend of ${vip} or more`, rules: [{ field: 'total_spent', operator: '>=', value: vip }], color: '#9C27B0', icon: 'star' },
    { name: 'High value', description: `Lifetime spend of ${high} or more`, rules: [{ field: 'total_spent', operator: '>=', value: high }], color: '#FF9800', icon: 'diamond' },
    { name: 'Repeat buyers', description: 'Three or more orders', rules: [{ field: 'orders_count', operator: '>=', value: 3 }], color: '#4CAF50', icon: 'repeat' },
    { name: 'First-time buyers', description: 'Exactly one order', rules: [{ field: 'orders_count', operator: '=', value: 1 }], color: '#2196F3', icon: 'new_releases' },
    {
      name: 'At risk',
      description: 'Bought before, nothing in 90 days',
      rules: [
        { field: 'last_order_at', operator: '<', value: '90_days_ago' },
        { field: 'orders_count', operator: '>', value: 0 },
      ],
      color: '#F44336',
      icon: 'warning',
    },
    { name: 'Email subscribers', description: 'Agreed to marketing email', rules: [{ field: 'accepts_email_marketing', operator: '=', value: 1 }], color: '#00BCD4', icon: 'email' },
  ];
}

/** The merchant's setup guide, in the order it is shown. */
export const ONBOARDING_TASKS = [
  { key: 'add_product', title: 'Add your first product' },
  { key: 'customize_theme', title: 'Customise your theme' },
  { key: 'set_up_payments', title: 'Set up payments' },
  { key: 'set_up_shipping', title: 'Review shipping rates' },
  { key: 'connect_messaging', title: 'Connect email or SMS for order updates' },
  { key: 'add_domain', title: 'Add a custom domain' },
  { key: 'launch_store', title: 'Launch your store' },
];
