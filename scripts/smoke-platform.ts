/**
 * End-to-end check of the multi-tenant platform, against a running API.
 *
 *   BASE_URL=http://localhost:4100 npx tsx scripts/smoke-platform.ts
 *
 * Opens two stores in different countries and verticals, gives each a product,
 * sells one through the storefront, and checks at every step that:
 *
 *   - each store was provisioned from its own blueprints (currency, tax,
 *     theme, taxonomy);
 *   - money is computed from the store's own configuration (shipping, COD,
 *     tax regime), not from constants;
 *   - nothing one store owns is visible, addressable or purchasable from the
 *     other — through the Admin API or the Storefront API;
 *   - the order produced a domain event that the worker turned into a
 *     customer notification.
 *
 * Creates real rows. Point it at a scratch database, never production.
 */

export {};

const BASE = (process.env.BASE_URL ?? 'http://localhost:4100').replace(/\/$/, '');
const run = Date.now().toString(36);

let failures = 0;
function check(label: string, condition: unknown, detail?: unknown): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.log(`  ✗ ${label}${detail === undefined ? '' : `\n      ${JSON.stringify(detail).slice(0, 400)}`}`);
  }
}

interface ApiResponse<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T = Record<string, unknown>>(
  method: string,
  path: string,
  options: { token?: string; shop?: string; body?: unknown } = {},
): Promise<ApiResponse<T>> {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.shop ? { 'X-Veylog-Shop-Domain': options.shop } : {}),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // leave as text
  }
  return { status: response.status, body: body as T };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

async function signup(name: string, country: string, vertical: string) {
  const email = `owner+${run}-${country.toLowerCase()}@smoke.test`;
  const response = await call<Any>('POST', '/platform/api/v1/signup', {
    body: {
      email,
      password: 'Sm0keTestPassw0rd',
      first_name: 'Smoke',
      last_name: country,
      shop: { name: `${name} ${run}`, vertical, country_code: country },
    },
  });
  if (response.status !== 201) throw new Error(`signup ${country} failed: ${response.status} ${JSON.stringify(response.body)}`);
  return { token: response.body.access_token as string, handle: response.body.shop.handle as string, email };
}

async function createProduct(token: string, name: string, price: number) {
  const slug = `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${run}`;
  const response = await call<Any>('POST', '/admin/api/v1/products', {
    token,
    body: {
      product: {
        name,
        slug,
        status: 'active',
        visibility: 'public',
        variants: [{ sku: `SKU-${slug}`.slice(0, 60), mrp: price, price, inventory_quantity: 50, track_inventory: true }],
      },
    },
  });
  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`product create failed: ${response.status} ${JSON.stringify(response.body).slice(0, 500)}`);
  }
  const product = response.body.product ?? response.body;
  return { id: Number(product.id), slug: product.slug ?? slug, variantId: Number(product.variants?.[0]?.id) };
}

async function main() {
  console.log(`Platform smoke test against ${BASE} (run ${run})\n`);

  console.log('1. Opening two stores');
  const india = await signup('Lotus Botanics', 'IN', 'beauty');
  const usa = await signup('Volt Supply', 'US', 'electronics');
  check('both stores signed up with distinct handles', india.handle !== usa.handle, [india.handle, usa.handle]);

  const inShop = (await call<Any>('GET', '/admin/api/v1/shop', { token: india.token })).body;
  const usShop = (await call<Any>('GET', '/admin/api/v1/shop', { token: usa.token })).body;
  check('India store: INR, GST, Asia/Kolkata', inShop.shop?.currency === 'INR' && inShop.shop?.tax_engine === 'in_gst' && inShop.shop?.timezone === 'Asia/Kolkata', inShop.shop);
  check('US store: USD, sales tax, America/New_York', usShop.shop?.currency === 'USD' && usShop.shop?.tax_engine === 'us_sales_tax', usShop.shop);
  check('both fully provisioned', inShop.setup?.provisioning?.done === inShop.setup?.provisioning?.total && usShop.setup?.provisioning?.failed?.length === 0, [inShop.setup?.provisioning, usShop.setup?.provisioning]);

  const inTheme = (await call<Any>('GET', '/api/v1/theme', { shop: india.handle })).body.theme;
  const usTheme = (await call<Any>('GET', '/api/v1/theme', { shop: usa.handle })).body.theme;
  check('each store opens with its vertical\'s theme (lumen / circuit)', inTheme?.theme === 'lumen' && usTheme?.theme === 'circuit', [inTheme?.theme, usTheme?.theme]);

  console.log('\n2. Catalogue');
  const serum = await createProduct(india.token, 'Niacinamide Serum', 1180);
  const cable = await createProduct(usa.token, 'USB-C Cable', 100);
  check('products created in both stores', serum.variantId > 0 && cable.variantId > 0, [serum, cable]);

  const inList = (await call<Any>('GET', '/admin/api/v1/products', { token: india.token })).body;
  check('India admin sees only its own product', inList.products?.length === 1 && inList.products[0].id === serum.id, inList.products?.map((p: Any) => p.id));
  const crossAdmin = await call('GET', `/admin/api/v1/products/${serum.id}`, { token: usa.token });
  check('US admin cannot read the India product by id', crossAdmin.status === 404, crossAdmin.status);
  const crossStorefront = await call('GET', `/api/v1/products/${serum.slug}`, { shop: usa.handle });
  check('US storefront cannot see the India product', crossStorefront.status === 404, crossStorefront.status);

  console.log('\n3. Pricing from each store\'s own configuration');
  const inCart = (await call<Any>('POST', '/api/v1/cart', { shop: india.handle })).body.cart;
  const inAdded = await call<Any>('POST', `/api/v1/cart/${inCart.token}/items`, { shop: india.handle, body: { variant_id: serum.variantId, quantity: 1 } });
  const inTotals = inAdded.body.cart?.totals;
  check('India: GST extracted from the inclusive price (180 of 1180)', inTotals?.tax_total === 180 && inTotals?.taxable_value === 1000, inTotals);
  check(
    'India: the bag names its taxes (CGST 9% + SGST 9%)',
    JSON.stringify(inTotals?.tax_lines) === JSON.stringify([{ name: 'CGST 9%', rate: 9, amount: 90 }, { name: 'SGST 9%', rate: 9, amount: 90 }]),
    inTotals?.tax_lines,
  );
  check('India: free delivery above the region threshold', inTotals?.shipping === 0, inTotals);
  check('India: COD offered with the store\'s fee', inAdded.body.cart?.payment_options?.cod === true && inAdded.body.cart?.payment_options?.cod_fee === 49, inAdded.body.cart?.payment_options);

  const crossCart = await call('POST', `/api/v1/cart/${inCart.token}/items`, { shop: usa.handle, body: { variant_id: serum.variantId, quantity: 1 } });
  check('the India cart token is meaningless to the US store', crossCart.status === 404, crossCart.status);

  const usCart = (await call<Any>('POST', '/api/v1/cart', { shop: usa.handle })).body.cart;
  const usCross = await call('POST', `/api/v1/cart/${usCart.token}/items`, { shop: usa.handle, body: { variant_id: serum.variantId, quantity: 1 } });
  check('the US store cannot sell the India variant', usCross.status >= 400 && usCross.status < 500, usCross.status);
  const usAdded = await call<Any>('POST', `/api/v1/cart/${usCart.token}/items`, { shop: usa.handle, body: { variant_id: cable.variantId, quantity: 1 } });
  check('US: no cash on delivery in this region', usAdded.body.cart?.payment_options?.cod === false, usAdded.body.cart?.payment_options);
  check('US: prices shown in USD', usAdded.body.cart?.totals?.currency === 'USD', usAdded.body.cart?.totals);

  const usCod = await call<Any>('POST', `/api/v1/cart/${usCart.token}/checkout`, {
    shop: usa.handle,
    body: {
      payment_method: 'cod',
      contact: { first_name: 'Sam', phone: '4155550132', email: 'sam@smoke.test' },
      shipping_address: { line1: '1 Market Street', city: 'San Francisco', state: 'California', state_code: 'CA', pincode: '94105' },
    },
  });
  check('US: COD checkout refused', usCod.status === 409, [usCod.status, usCod.body]);

  console.log('\n4. Checkout and the event pipeline');
  const order = await call<Any>('POST', `/api/v1/cart/${inCart.token}/checkout`, {
    shop: india.handle,
    body: {
      payment_method: 'cod',
      contact: { first_name: 'Asha', last_name: 'Rao', phone: '9876543210', email: `asha+${run}@smoke.test` },
      shipping_address: { line1: '12 MG Road, Flat 4', city: 'Bengaluru', state: 'Karnataka', state_code: 'KA', pincode: '560001' },
    },
  });
  check('India COD order placed', order.status === 201 || order.status === 200, [order.status, order.body]);
  const orderNumber = order.body.order?.order_number as string;
  check('order total = price + COD fee (1229)', order.body.order?.total === 1229, order.body.order);

  const usOrders = (await call<Any>('GET', '/admin/api/v1/orders', { token: usa.token })).body;
  check('US admin sees no orders', (usOrders.orders ?? []).length === 0, usOrders.orders?.length);
  const inOrders = (await call<Any>('GET', '/admin/api/v1/orders', { token: india.token })).body;
  const placed = (inOrders.orders ?? []).find((row: Any) => row.order_number === orderNumber);
  check('India admin sees the order', Boolean(placed), inOrders.orders?.map((row: Any) => row.order_number));
  if (placed) {
    const detail = (await call<Any>('GET', `/admin/api/v1/orders/${placed.id}`, { token: india.token })).body;
    const orderRow = detail.order ?? detail;
    const totals = orderRow.totals ?? {};
    check(
      'order carries the intra-state GST split (CGST 90 + SGST 90, no IGST)',
      totals.cgst_total === 90 && totals.sgst_total === 90 && totals.igst_total === 0 && totals.tax_total === 180,
      totals,
    );
    const cross = await call('GET', `/admin/api/v1/orders/${placed.id}`, { token: usa.token });
    check('US admin cannot open the India order', cross.status === 404, cross.status);
  }

  let confirmation: Any = null;
  for (let attempt = 0; attempt < 30 && !confirmation; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const activity = (await call<Any>('GET', '/admin/api/v1/messaging/activity?limit=50', { token: india.token })).body;
    confirmation = (activity.messages ?? []).find((message: Any) => message.event_key === 'order.confirmed' && message.channel === 'email');
  }
  check('the worker sent the order confirmation email (event → notification)', Boolean(confirmation), confirmation);
  const usActivity = (await call<Any>('GET', '/admin/api/v1/messaging/activity?limit=50', { token: usa.token })).body;
  check('the US store\'s outbox is empty', (usActivity.messages ?? []).length === 0, usActivity.messages?.length);

  console.log('\n5. Discounts and delivery options');
  const sachet = await createProduct(india.token, 'Travel Sachet', 50);
  const welcome = await call<Any>('POST', '/admin/api/v1/discounts', {
    token: india.token,
    body: {
      discount: {
        code: 'welcome10',
        title: 'Welcome 10% off',
        discount_type: 'percentage',
        value: 10,
        min_order_amount: 500,
        customer_eligibility: 'new_customers',
        usage_limit_per_customer: 1,
      },
    },
  });
  check('code discount created (stored upper-case)', welcome.status === 201 && welcome.body.discount?.code === 'WELCOME10', [welcome.status, welcome.body]);
  const gift = await call<Any>('POST', '/admin/api/v1/discounts', {
    token: india.token,
    body: {
      discount: {
        code: 'AUTO-GIFT',
        title: 'Free travel sachet',
        discount_type: 'free_gift',
        is_automatic: true,
        is_stackable: true,
        gift_variant_id: sachet.variantId,
        gift_reserves_inventory: true,
        min_order_amount: 1000,
      },
    },
  });
  check('automatic free-gift offer created', gift.status === 201, [gift.status, gift.body]);
  const foreignGift = await call<Any>('POST', '/admin/api/v1/discounts', {
    token: usa.token,
    body: { discount: { code: 'STEAL', discount_type: 'free_gift', gift_variant_id: sachet.variantId } },
  });
  check('a store cannot offer another store\'s variant as a gift', foreignGift.status === 422, [foreignGift.status, foreignGift.body]);

  const bag = (await call<Any>('POST', '/api/v1/cart', { shop: india.handle })).body.cart;
  await call<Any>('POST', `/api/v1/cart/${bag.token}/items`, { shop: india.handle, body: { variant_id: serum.variantId, quantity: 1 } });
  const bogus = await call<Any>('POST', `/api/v1/cart/${bag.token}/discount`, { shop: india.handle, body: { code: 'NOPE' } });
  check('an unknown code is refused with a reason', bogus.status === 422 && bogus.body.error?.message === 'That code is not valid.', [bogus.status, bogus.body]);
  const crossCode = await call<Any>('POST', `/api/v1/cart/${usCart.token}/discount`, { shop: usa.handle, body: { code: 'WELCOME10' } });
  check('the India code does not exist in the US store', crossCode.status === 422, crossCode.status);

  const applied = (await call<Any>('POST', `/api/v1/cart/${bag.token}/discount`, { shop: india.handle, body: { code: ' welcome10 ' } })).body.cart;
  const t = applied?.totals ?? {};
  check('code applied: 10% of 1180 = 118 off', applied?.discount_code?.applied === true && t.discount === 118, [applied?.discount_code, t]);
  check('GST recomputed on the discounted price (162 of 1062)', t.tax_total === 162 && t.taxable_value === 900, t);
  check('free delivery judged on the discounted value (1062 >= 499)', t.shipping === 0, t);
  check('automatic gift earned alongside the code', applied?.free_gift?.variant_id === sachet.variantId && applied?.discounts?.length === 2, [applied?.free_gift, applied?.discounts]);
  const express = (applied?.delivery?.options ?? []).find((option: Any) => option.method === 'express');
  check('delivery options list the store\'s express rate (199)', express?.price === 199, applied?.delivery);

  const preview = (await call<Any>('GET', `/api/v1/cart/${bag.token}?shipping_method=express&payment_method=cod`, { shop: india.handle })).body.cart;
  check('previewing express + COD: 1062 + 199 + 49 = 1310', preview?.totals?.total === 1310 && preview?.totals?.shipping === 199, preview?.totals);

  const newcomer = { first_name: 'Meera', phone: '9876500001', email: `meera+${run}@smoke.test` };
  const address = { line1: '7 Park Street, Flat 2', city: 'Bengaluru', state: 'Karnataka', state_code: 'KA', pincode: '560001' };
  const discounted = await call<Any>('POST', `/api/v1/cart/${bag.token}/checkout`, {
    shop: india.handle,
    body: { payment_method: 'cod', shipping_method: 'express', contact: newcomer, shipping_address: address },
  });
  check('discounted express order placed for 1310', discounted.status === 201 && discounted.body.order?.total === 1310 && discounted.body.order?.shipping_method === 'express', [discounted.status, discounted.body]);
  const discountedOrder = (await call<Any>('GET', '/admin/api/v1/orders', { token: india.token })).body.orders?.find((row: Any) => row.order_number === discounted.body.order?.order_number);
  if (discountedOrder) {
    const detail = (await call<Any>('GET', `/admin/api/v1/orders/${discountedOrder.id}`, { token: india.token })).body.order;
    check('order records the code and the discount', detail?.coupon_code === 'WELCOME10' && detail?.totals?.discount_total === 118 && detail?.totals?.coupon_discount === 118, [detail?.coupon_code, detail?.totals]);
    const lines = detail?.items ?? [];
    const serumLine = lines.find((line: Any) => line.variant_id === serum.variantId);
    const giftLine = lines.find((line: Any) => line.line_type === 'gift');
    check('the product line carries its discount and sells for 1062', serumLine?.discount_amount === 118 && serumLine?.line_total === 1062, serumLine);
    check('the gift is a zero-priced line', giftLine?.variant_id === sachet.variantId && giftLine?.line_total === 0, giftLine);
  } else {
    check('discounted order visible in admin', false);
  }
  const used = (await call<Any>('GET', `/admin/api/v1/discounts/${welcome.body.discount?.id}`, { token: india.token })).body.discount;
  check('the code\'s use was counted', used?.used_count === 1, used);

  const again = (await call<Any>('POST', '/api/v1/cart', { shop: india.handle })).body.cart;
  await call<Any>('POST', `/api/v1/cart/${again.token}/items`, { shop: india.handle, body: { variant_id: serum.variantId, quantity: 1 } });
  await call<Any>('POST', `/api/v1/cart/${again.token}/discount`, { shop: india.handle, body: { code: 'WELCOME10' } });

  const closed = await call<Any>('POST', '/admin/api/v1/shipping/serviceability', { token: india.token, body: { pincode: '110001', is_serviceable: false } });
  check('a postcode marked as not served', closed.status === 200 || closed.status === 201, [closed.status, closed.body]);
  const unserved = (await call<Any>('PUT', `/api/v1/cart/${again.token}/delivery`, { shop: india.handle, body: { pincode: '110001' } })).body.cart;
  check('the bag says it cannot deliver there', unserved?.delivery?.deliverable === false && Boolean(unserved?.delivery?.message), unserved?.delivery);
  const refusedAddress = await call<Any>('POST', `/api/v1/cart/${again.token}/checkout`, {
    shop: india.handle,
    body: { payment_method: 'cod', contact: newcomer, shipping_address: { ...address, pincode: '110001', state: 'Delhi', state_code: 'DL' } },
  });
  check('checkout to an unserved postcode refused (UNDELIVERABLE)', refusedAddress.status === 409 && refusedAddress.body.error?.code === 'UNDELIVERABLE', [refusedAddress.status, refusedAddress.body]);

  const secondUse = await call<Any>('POST', `/api/v1/cart/${again.token}/checkout`, {
    shop: india.handle,
    body: { payment_method: 'cod', contact: newcomer, shipping_address: address },
  });
  check('a first-order code refused on the second order', secondUse.status === 409 && secondUse.body.error?.code === 'DISCOUNT_NOT_APPLICABLE', [secondUse.status, secondUse.body]);
  await call<Any>('DELETE', `/api/v1/cart/${again.token}/discount`, { shop: india.handle });
  const fullPrice = await call<Any>('POST', `/api/v1/cart/${again.token}/checkout`, {
    shop: india.handle,
    body: { payment_method: 'cod', contact: newcomer, shipping_address: address },
  });
  check('without the code the order goes through at full price (1229)', fullPrice.status === 201 && fullPrice.body.order?.total === 1229 && fullPrice.body.order?.discount === 0, [fullPrice.status, fullPrice.body]);

  console.log('\n6. Themes, domains, integrations');
  const themes = (await call<Any>('GET', '/admin/api/v1/themes', { token: india.token })).body.themes;
  const main = themes?.find((theme: Any) => theme.role === 'main');
  const customised = await call<Any>('PATCH', `/admin/api/v1/themes/${main?.id}`, { token: india.token, body: { settings: { color_accent: '#0B6E4F' } } });
  check('theme customised', customised.status === 200, customised.body);
  const bad = await call<Any>('PATCH', `/admin/api/v1/themes/${main?.id}`, { token: india.token, body: { settings: { color_accent: 'green' } } });
  check('invalid theme values refused', bad.status === 422 || bad.status === 400, bad.status);
  await new Promise((resolve) => setTimeout(resolve, 100));
  const liveTheme = (await call<Any>('GET', '/api/v1/theme', { shop: india.handle })).body.theme;
  check('storefront serves the customised colour', liveTheme?.css_variables?.['--color-accent'] === '#0B6E4F', liveTheme?.css_variables);
  const usLive = (await call<Any>('GET', '/api/v1/theme', { shop: usa.handle })).body.theme;
  check('the US store\'s theme is untouched', usLive?.css_variables?.['--color-accent'] !== '#0B6E4F', usLive?.css_variables?.['--color-accent']);

  const domain = await call<Any>('POST', '/admin/api/v1/domains', { token: india.token, body: { hostname: `shop-${run}.lotus-example.com` } });
  const added = (domain.body.domains ?? []).find((entry: Any) => entry.hostname === `shop-${run}.lotus-example.com`);
  check('custom domain added, pending DNS, with instructions', domain.status === 201 && added?.status === 'pending_dns' && (added?.dns?.records?.length ?? 0) >= 1, domain.body);
  const stolen = await call<Any>('POST', '/admin/api/v1/domains', { token: usa.token, body: { hostname: `shop-${run}.lotus-example.com` } });
  check('another store cannot claim the same domain', stolen.status === 409, stolen.status);

  const catalog = (await call<Any>('GET', '/admin/api/v1/integrations/catalog', { token: india.token })).body.providers ?? [];
  check('integration catalogue lists payment, messaging and shipping providers', ['razorpay', 'stripe', 'paypal', 'twilio', 'sendgrid', 'shiprocket'].every((key) => catalog.some((provider: Any) => provider.key === key)), catalog.map((provider: Any) => provider.key));
  const malformed = await call<Any>('POST', '/admin/api/v1/integrations', { token: india.token, body: { provider: 'stripe', credentials: { secret_key: 'nope', publishable_key: 'nope' } } });
  check('malformed credentials rejected before any network call', malformed.status === 422, [malformed.status, malformed.body]);

  console.log('\n7. Sales tax by destination (US)');
  const taxSettings = (await call<Any>('GET', '/admin/api/v1/tax', { token: usa.token })).body;
  check('a US store takes its rate from the address, and collects nowhere yet', taxSettings.rate_source === 'destination' && taxSettings.collecting === false, taxSettings);
  check('its exempt class is marked exempt', (taxSettings.classes ?? []).some((taxClass: Any) => taxClass.code === 'EXEMPT' && taxClass.exempt === true), taxSettings.classes);

  const usBag = (await call<Any>('POST', '/api/v1/cart', { shop: usa.handle })).body.cart;
  await call<Any>('POST', `/api/v1/cart/${usBag.token}/items`, { shop: usa.handle, body: { variant_id: cable.variantId, quantity: 1 } });
  const unregistered = (await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '94105', state: 'California' } })).body.cart;
  check('not registered in California: no tax', unregistered?.totals?.tax_total === 0 && unregistered?.delivery?.region === 'CA', [unregistered?.totals, unregistered?.delivery]);

  const california = await call<Any>('POST', '/admin/api/v1/tax/registrations', { token: usa.token, body: { region_code: 'ca', name: 'California sales tax', rate: 7.25 } });
  const newYork = await call<Any>('POST', '/admin/api/v1/tax/registrations', { token: usa.token, body: { region_code: 'NY', name: 'New York sales tax', rate: 8.875, shipping_taxable: true } });
  check('registered in California and New York', california.status === 201 && newYork.status === 201 && california.body.registration?.region_code === 'CA', [california.status, newYork.status, california.body]);
  const twice = await call<Any>('POST', '/admin/api/v1/tax/registrations', { token: usa.token, body: { region_code: 'CA', name: 'Again', rate: 1 } });
  const abroad = await call<Any>('POST', '/admin/api/v1/tax/registrations', { token: usa.token, body: { country_code: 'CA', region_code: 'ON', name: 'Ontario HST', rate: 13 } });
  check('a second California registration and one abroad are refused', twice.status === 409 && abroad.status === 422, [twice.status, abroad.status]);
  const indiaCannot = await call<Any>('GET', `/admin/api/v1/tax`, { token: india.token });
  check('the India store does not see them', (indiaCannot.body.registrations ?? []).length === 0 && indiaCannot.body.rate_source === 'class', indiaCannot.body.registrations);

  const inCalifornia = (await call<Any>('GET', `/api/v1/cart/${usBag.token}`, { shop: usa.handle })).body.cart?.totals;
  check(
    'California: 7.25% added on top, named on the bag (107.25)',
    inCalifornia?.tax_total === 7.25 && inCalifornia?.total === 107.25 && inCalifornia?.tax_included_in_prices === false && inCalifornia?.tax_lines?.[0]?.name === 'California sales tax',
    inCalifornia,
  );
  const californiaExpress = (await call<Any>('GET', `/api/v1/cart/${usBag.token}?shipping_method=express`, { shop: usa.handle })).body.cart?.totals;
  check('California does not tax delivery (express: 100 + 19.99 + 7.25)', californiaExpress?.shipping_tax === 0 && californiaExpress?.total === 127.24, californiaExpress);

  await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '10001', state: 'NY' } });
  const newYorkExpress = (await call<Any>('GET', `/api/v1/cart/${usBag.token}?shipping_method=express`, { shop: usa.handle })).body.cart?.totals;
  check(
    'New York taxes goods and delivery at 8.875% (8.88 + 1.77, total 130.64)',
    newYorkExpress?.tax_total === 10.65 && newYorkExpress?.shipping_tax === 1.77 && newYorkExpress?.total === 130.64,
    newYorkExpress,
  );

  const oregon = (await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '97201', state: 'Oregon' } })).body.cart?.totals;
  check('Oregon, where the store is not registered: no tax', oregon?.tax_total === 0 && oregon?.tax_calculated_at_checkout === false, oregon);
  const zipOnly = (await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '94105' } })).body.cart?.totals;
  check('a ZIP without a state: "calculated at checkout"', zipOnly?.tax_calculated_at_checkout === true && zipOnly?.tax_total === 0, zipOnly);
  const narnia = await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '94105', state: 'Narnia' } });
  check('an unknown state is refused', narnia.status === 422, narnia.status);

  const taxed = (await call<Any>('POST', '/admin/api/v1/tax/preview', { token: usa.token, body: { region: 'CA', amount: 100 } })).body;
  const exempt = (await call<Any>('POST', '/admin/api/v1/tax/preview', { token: usa.token, body: { region: 'CA', amount: 100, exempt: true } })).body;
  check('the settings preview agrees, and exempt products are not taxed', taxed.tax === 7.25 && exempt.tax === 0, [taxed, exempt]);

  const badState = await call<Any>('POST', `/api/v1/cart/${usBag.token}/checkout`, {
    shop: usa.handle,
    body: {
      payment_method: 'online',
      contact: { first_name: 'Sam', phone: '4155550132' },
      shipping_address: { line1: '1 Market Street', city: 'San Francisco', state: 'Narnia', pincode: '94105' },
    },
  });
  check('checkout refuses an address whose state it cannot tax', badState.status === 422 && badState.body.error?.code === 'VALIDATION_FAILED', [badState.status, badState.body.error]);

  console.log('\n7b. Shipping zones');
  const zones = (await call<Any>('GET', '/admin/api/v1/shipping/zones', { token: usa.token })).body.zones ?? [];
  const remote = zones.find((zone: Any) => zone.name === 'Alaska, Hawaii & territories');
  check('a US store opens with an Alaska, Hawaii & territories zone and its own rate', remote?.rate_count === 1 && remote?.areas?.some((place: Any) => place.region === 'AK'), zones);
  const alaska = (await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '99501', state: 'Alaska' } })).body.cart;
  check(
    'to Alaska: only the zone\'s standard rate, not free, no express (119.99)',
    alaska?.delivery?.options?.length === 1 && alaska?.delivery?.options?.[0]?.price === 19.99 && alaska?.totals?.total === 119.99,
    alaska?.delivery,
  );

  const sfZone = await call<Any>('POST', '/admin/api/v1/shipping/zones', { token: usa.token, body: { name: 'San Francisco', areas: [{ postal_prefix: '941' }] } });
  const sfId = sfZone.body.zone?.id;
  const courier = await call<Any>('POST', '/admin/api/v1/shipping/rates', { token: usa.token, body: { name: 'Local courier', zone_id: sfId, method: 'standard', rate: 4.99, eta_min_days: 1, eta_max_days: 1 } });
  const sameDay = await call<Any>('POST', '/admin/api/v1/shipping/rates', { token: usa.token, body: { name: 'Same day', zone_id: sfId, method: 'express', rate: 9.99, eta_min_days: 1, eta_max_days: 1 } });
  check('a merchant draws a zone by postcode prefix and prices it', sfZone.status === 201 && courier.status === 201 && sameDay.status === 201 && courier.body.rate?.zone_id === sfId, [sfZone.status, courier.status, sameDay.status]);
  const taken = await call<Any>('POST', '/admin/api/v1/shipping/zones', { token: usa.token, body: { name: 'Pacific', areas: [{ region: 'Hawaii' }] } });
  check('a place already in a zone cannot join another', taken.status === 409 && /already in the zone/.test(taken.body.error?.message ?? ''), [taken.status, taken.body.error?.message]);
  const foreignZone = await call<Any>('POST', '/admin/api/v1/shipping/rates', { token: india.token, body: { name: 'Sneaky', zone_id: sfId, method: 'standard', rate: 1 } });
  check('another store cannot price this store\'s zone', foreignZone.status === 422, foreignZone.status);

  const sf = (await call<Any>('PUT', `/api/v1/cart/${usBag.token}/delivery`, { shop: usa.handle, body: { pincode: '94105', state: 'CA' } })).body.cart;
  const sfOptions = Object.fromEntries((sf?.delivery?.options ?? []).map((option: Any) => [option.method, option.price]));
  check('in San Francisco the local courier and same-day rates apply', sfOptions.standard === 4.99 && sfOptions.express === 9.99 && sf?.totals?.shipping === 4.99, sf?.delivery);
  const newYorkPreview = (await call<Any>('POST', '/admin/api/v1/shipping/quote-preview', { token: usa.token, body: { postal_code: '10001', region: 'NY', subtotal: 100 } })).body.quote;
  check('elsewhere the everywhere rates still apply (free standard over $75)', newYorkPreview?.options?.find((option: Any) => option.method === 'standard')?.price === 0, newYorkPreview);
  await call<Any>('DELETE', `/admin/api/v1/shipping/zones/${sfId}`, { token: usa.token });
  const afterDelete = (await call<Any>('POST', '/admin/api/v1/shipping/quote-preview', { token: usa.token, body: { postal_code: '94105', region: 'CA', subtotal: 100 } })).body.quote;
  check('deleting the zone returns its postcodes to the everywhere rates', afterDelete?.options?.find((option: Any) => option.method === 'standard')?.price === 0 && afterDelete?.zone === null, afterDelete);

  console.log('\n7c. Selling abroad (markets)');
  const fxOperator = (
    await call<Any>('POST', '/admin/api/v1/auth/login', {
      body: { email: process.env.SUPERADMIN_EMAIL ?? 'admin@veylor.com', password: process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!2026' },
    })
  ).body.access_token as string | undefined;
  if (!fxOperator) {
    console.log('  (skipped: needs a platform administrator to set an exchange rate)');
  } else {
    const rate = await call<Any>('PUT', '/platform/api/v1/exchange-rates/CAD', { token: fxOperator, body: { per_usd: 1.36 } });
    check('an operator pins the Canadian dollar at 1.36 per US dollar', rate.status === 200 && rate.body.source === 'manual', [rate.status, rate.body]);

    const canada = await call<Any>('POST', '/admin/api/v1/markets', { token: usa.token, body: { name: 'Canada', countries: ['CA'], currency: 'CAD', rounding: 'ninety_nine' } });
    check('the US store opens a Canada market in CAD', canada.status === 201 && canada.body.market?.rate === 1.36, [canada.status, canada.body]);
    const home = await call<Any>('POST', '/admin/api/v1/markets', { token: usa.token, body: { name: 'Home again', countries: ['US'] } });
    const twice = await call<Any>('POST', '/admin/api/v1/markets', { token: usa.token, body: { name: 'North', countries: ['CA'], currency: 'CAD' } });
    const noRate = await call<Any>('POST', '/admin/api/v1/markets', { token: usa.token, body: { name: 'Central Africa', countries: ['CM'], currency: 'XAF' } });
    check(
      'the home country, a country already in a market, and a currency without a rate are refused',
      home.status === 422 && twice.status === 409 && noRate.status === 422,
      [home.status, twice.status, noRate.status],
    );

    const picker = (await call<Any>('GET', '/api/v1/markets', { shop: usa.handle })).body.countries ?? [];
    check('the storefront\'s country picker lists the US in USD and Canada in CAD', picker.some((entry: Any) => entry.country === 'US' && entry.currency === 'USD') && picker.some((entry: Any) => entry.country === 'CA' && entry.currency === 'CAD'), picker);

    const fetchProduct = async (countryCode?: string) => {
      const response = await fetch(`${BASE}/api/v1/products/${cable.slug}`, {
        headers: { 'X-Veylog-Shop-Domain': usa.handle, ...(countryCode ? { 'X-Veylog-Country': countryCode } : {}) },
      });
      return (await response.json()) as Any;
    };
    const inCanada = await fetchProduct('CA');
    const atHome = await fetchProduct();
    check('a Canadian shopper sees C$136.99 (100 × 1.36, up to .99); at home it is $100', inCanada.currency === 'CAD' && inCanada.product?.price === 136.99 && atHome.currency === 'USD' && atHome.product?.price === 100, [inCanada.currency, inCanada.product?.price, atHome.product?.price]);

    const abroadBag = (await call<Any>('POST', '/api/v1/cart', { shop: usa.handle })).body.cart;
    await call<Any>('PUT', `/api/v1/cart/${abroadBag.token}/market`, { shop: usa.handle, body: { country: 'CA' } });
    const inBag = (await call<Any>('POST', `/api/v1/cart/${abroadBag.token}/items`, { shop: usa.handle, body: { variant_id: cable.variantId, quantity: 1 } })).body.cart;
    check(
      'the bag is in CAD, with no cash on delivery and no shipping to Canada yet',
      inBag?.totals?.currency === 'CAD' && inBag?.items?.[0]?.unit_price === 136.99 && inBag?.payment_options?.cod === false && inBag?.delivery?.deliverable === false,
      [inBag?.totals, inBag?.delivery],
    );
    const nowhere = await call<Any>('PUT', `/api/v1/cart/${abroadBag.token}/market`, { shop: usa.handle, body: { country: 'DE' } });
    check('a country the store does not sell to is refused', nowhere.status === 422, nowhere.status);

    const toCanada = await call<Any>('POST', '/admin/api/v1/shipping/zones', { token: usa.token, body: { name: 'Canada', areas: [{ country: 'CA' }] } });
    await call<Any>('POST', '/admin/api/v1/shipping/rates', { token: usa.token, body: { name: 'International standard', zone_id: toCanada.body.zone?.id, method: 'standard', rate: 15, eta_min_days: 5, eta_max_days: 10 } });
    const delivered = (await call<Any>('PUT', `/api/v1/cart/${abroadBag.token}/delivery`, { shop: usa.handle, body: { pincode: 'M5V 2T6', state: 'Ontario' } })).body.cart;
    check(
      'with a Canada zone: C$20.40 delivery ($15), no US tax on an export, C$157.39 in all',
      delivered?.delivery?.options?.[0]?.price === 20.4 && delivered?.totals?.tax_total === 0 && (delivered?.totals?.tax_lines ?? []).length === 0 && delivered?.totals?.total === 157.39,
      [delivered?.delivery, delivered?.totals],
    );
    const usPostcode = await call<Any>('PUT', `/api/v1/cart/${abroadBag.token}/delivery`, { shop: usa.handle, body: { pincode: '94105' } });
    check('a US ZIP is not a Canadian postcode', usPostcode.status === 422, usPostcode.status);

    const canadianCheckout = (paymentMethod: string, address: Record<string, unknown>) =>
      call<Any>('POST', `/api/v1/cart/${abroadBag.token}/checkout`, {
        shop: usa.handle,
        body: {
          payment_method: paymentMethod,
          contact: { first_name: 'Jean', phone: '416 555 0132' },
          shipping_address: { line1: '100 King Street West', city: 'Toronto', state: 'Ontario', country: 'CA', pincode: 'M5V 2T6', ...address },
        },
      });
    const codAbroad = await canadianCheckout('cod', {});
    check('cash on delivery is refused abroad', codAbroad.status === 409 && codAbroad.body.error?.code === 'COD_UNAVAILABLE', [codAbroad.status, codAbroad.body.error]);
    const badPostcode = await canadianCheckout('cod', { pincode: '94105' });
    const germany = await canadianCheckout('cod', { country: 'DE', pincode: '10115', state: 'Berlin' });
    check('checkout checks the postcode for the country, and refuses countries not sold to', badPostcode.status === 422 && germany.status === 422, [badPostcode.status, germany.status]);

    const adjusted = await call<Any>('PATCH', `/admin/api/v1/markets/${canada.body.market?.id}`, { token: usa.token, body: { price_adjustment_percent: 10 } });
    const pricier = await fetchProduct('CA');
    check('a +10% market adjustment: C$149.99 (136 × 1.1, up to .99)', adjusted.status === 200 && pricier.product?.price === 149.99, [adjusted.status, pricier.product?.price]);

    await call<Any>('DELETE', `/admin/api/v1/markets/${canada.body.market?.id}`, { token: usa.token });
    const closed = await fetch(`${BASE}/api/v1/products/${cable.slug}`, { headers: { 'X-Veylog-Shop-Domain': usa.handle, 'X-Veylog-Country': 'CA' } });
    const closedBody = (await closed.json()) as Any;
    check('with the market gone, Canadians see US prices and are told so', closed.headers.get('X-Veylog-Market') === 'unavailable' && closedBody.currency === 'USD', [closed.headers.get('X-Veylog-Market'), closedBody.currency]);
    await call<Any>('DELETE', '/platform/api/v1/exchange-rates/CAD/manual', { token: fxOperator });
  }

  console.log('\n8. Billing the merchant (test clock)');
  const operatorLogin = await call<Any>('POST', '/admin/api/v1/auth/login', {
    body: { email: process.env.SUPERADMIN_EMAIL ?? 'admin@veylor.com', password: process.env.SUPERADMIN_PASSWORD ?? 'ChangeMe!2026' },
  });
  const operator = operatorLogin.body.access_token as string | undefined;
  const overview = (await call<Any>('GET', '/admin/api/v1/billing', { token: india.token })).body;
  if (!operator || overview.provider !== 'simulator') {
    console.log(`  (skipped: needs a platform administrator and PLATFORM_BILLING_PROVIDER=simulator; provider is ${overview.provider})`);
  } else {
    const runAt = (at: Date) =>
      call<Any>('POST', '/platform/api/v1/billing/run', { token: operator, body: { now: at.toISOString(), shop: india.handle } });
    const hour = 3_600_000;
    const day = 24 * hour;

    check('a new store starts on a trial with nothing owed and no card', overview.payment_method === null && overview.outstanding?.length === 0, overview);
    const trial = (await call<Any>('GET', '/admin/api/v1/billing/subscription', { token: india.token })).body.subscription;
    check('the subscription is trialing, priced in the store\'s currency', trial?.status === 'trialing' && trial?.currency === 'INR' && Number(trial?.price_amount) === 1499, trial);

    const trialEnd = new Date(trial.trial_ends_at);
    const reminder = (await runAt(new Date(trialEnd.getTime() - 2 * day))).body;
    const reminderAgain = (await runAt(new Date(trialEnd.getTime() - 2 * day + hour))).body;
    check('two days before the trial ends the owner is reminded, once', reminder.reminded === 1 && reminderAgain.reminded === 0 && reminder.billed === 0, [reminder, reminderAgain]);
    const firstRun = (await runAt(new Date(trialEnd.getTime() + hour))).body;
    check('at trial end the first period is billed', firstRun.billed === 1, firstRun);
    const owed = (await call<Any>('GET', '/admin/api/v1/billing', { token: india.token })).body;
    const firstBill = owed.outstanding?.[0];
    // Before the platform's own tax, which PLATFORM_TAX_* may add on top.
    check('with no card the bill fails and says why', firstBill?.status === 'failed' && (firstBill?.subtotal ?? firstBill?.total) === 1499 && /No payment method/.test(firstBill?.last_error ?? ''), firstBill);
    const pastDue = (await call<Any>('GET', '/admin/api/v1/billing/subscription', { token: india.token })).body.subscription;
    check('the subscription is past due', pastDue?.status === 'past_due', pastDue?.status);
    const usSees = (await call<Any>('GET', `/admin/api/v1/billing/invoices/${firstBill?.id}`, { token: usa.token }));
    check('another store cannot open this bill', usSees.status === 404, usSees.status);

    const setup = (await call<Any>('POST', '/admin/api/v1/billing/payment-method', { token: india.token })).body;
    check('adding a card offers the simulator\'s test cards', (setup.test_tokens ?? []).some((card: Any) => card.token === 'sim_card_visa'), setup);
    const card = (await call<Any>('POST', '/admin/api/v1/billing/payment-method/confirm', { token: india.token, body: { reference: 'sim_card_visa' } })).body;
    check('saving a card retries the failed bill at once, and it is paid', card.payment_method?.label === 'Visa •••• 4242' && card.retried?.[0]?.outcome === 'paid', card);
    const recovered = (await call<Any>('GET', '/admin/api/v1/billing/subscription', { token: india.token })).body.subscription;
    check('the subscription is active again', recovered?.status === 'active', recovered?.status);

    const upgrade = (await call<Any>('POST', '/admin/api/v1/billing/subscription', { token: india.token, body: { plan: 'growth' } })).body;
    // The paid period has not begun on the real clock, so all of it is credited: 4999 − 1499.
    const upgradeBill = upgrade.charge?.invoice_id ? (await call<Any>('GET', `/admin/api/v1/billing/invoices/${upgrade.charge.invoice_id}`, { token: india.token })).body.invoice : null;
    check('upgrading bills the new plan less the unused old one (3500), paid', upgrade.charge?.outcome === 'paid' && (upgradeBill?.subtotal ?? upgrade.charge?.total) === 3500, [upgrade.charge, upgradeBill?.subtotal]);
    check('the plan-change bill shows the plan and the proration credit', upgradeBill?.lines?.some((line: Any) => line.kind === 'subscription' && line.amount === 4999) && upgradeBill?.lines?.some((line: Any) => line.kind === 'proration' && line.amount === -1499), upgradeBill?.lines);

    await call<Any>('POST', '/admin/api/v1/billing/payment-method/confirm', { token: india.token, body: { reference: 'sim_card_declined' } });
    const growth = (await call<Any>('GET', '/admin/api/v1/billing/subscription', { token: india.token })).body.subscription;
    const renewal = new Date(growth.current_period_end);
    const renewed = (await runAt(new Date(renewal.getTime() + hour))).body;
    check('at renewal the next period is billed', renewed.billed === 1, renewed);
    const declined = (await call<Any>('GET', '/admin/api/v1/billing', { token: india.token })).body.outstanding?.[0];
    check('a declined card fails the bill and schedules a retry', declined?.status === 'failed' && /declined/.test(declined?.last_error ?? '') && Boolean(declined?.next_attempt_at), declined);

    const graceOver = (await runAt(new Date(renewal.getTime() + 8 * day))).body;
    check('past the grace period the store is frozen', graceOver.frozen === 1 && graceOver.retried >= 1, graceOver);
    const frozenShop = (await call<Any>('GET', '/admin/api/v1/shop', { token: india.token })).body.shop;
    check('the store reports frozen, with the bill as the reason', frozenShop?.status === 'frozen' && /PB-/.test(frozenShop?.status_reason ?? ''), frozenShop);
    const blocked = await call<Any>('POST', '/admin/api/v1/products', { token: india.token, body: { product: { name: 'Frozen', slug: `frozen-${run}`, status: 'draft', variants: [{ sku: `FRZ-${run}`, mrp: 10, price: 10 }] } } });
    check('a frozen store\'s admin cannot make changes', blocked.status === 403 && blocked.body.error?.code === 'SHOP_UNAVAILABLE', [blocked.status, blocked.body.error?.code]);
    const storefront = await call<Any>('GET', '/api/v1/storefront/shop', { shop: india.handle });
    check("a frozen store's storefront is unavailable", storefront.status === 403 && storefront.body.error?.code === 'SHOP_UNAVAILABLE', [storefront.status, storefront.body]);

    const fixed = (await call<Any>('POST', '/admin/api/v1/billing/payment-method/confirm', { token: india.token, body: { reference: 'sim_card_visa' } })).body;
    check('a working card pays the bill', fixed.retried?.every((attempt: Any) => attempt.outcome === 'paid'), fixed.retried);
    const thawed = (await call<Any>('GET', '/admin/api/v1/shop', { token: india.token })).body.shop;
    check('and the store is unfrozen', thawed?.status === 'active', thawed?.status);
    const open = (await call<Any>('GET', '/api/v1/storefront/shop', { shop: india.handle })).body.shop;
    check('and takes orders again', open?.accepting_orders === true, open);

    const ledger = (await call<Any>('GET', `/platform/api/v1/billing/invoices?status=paid`, { token: operator })).body.invoices ?? [];
    const mine = ledger.filter((invoice: Any) => invoice.shop?.handle === india.handle);
    check('operators see the store\'s three paid bills', mine.length === 3, mine.map((invoice: Any) => [invoice.number, invoice.kind, invoice.total]));
    const notOperator = await call<Any>('GET', '/platform/api/v1/billing/invoices', { token: india.token });
    check('a merchant cannot read the platform\'s ledger', notOperator.status === 403, notOperator.status);

    const mail = (await call<Any>('GET', `/platform/api/v1/emails?to=${encodeURIComponent(india.email)}&limit=100`, { token: operator })).body.emails ?? [];
    const sentTemplates = new Set(mail.map((email: Any) => email.template));
    check(
      'the owner was emailed at every step: reminder, failures, receipts, frozen, reopened',
      ['billing.trial_ending', 'billing.payment_failed', 'billing.receipt', 'billing.store_frozen', 'billing.store_unfrozen'].every((template) => sentTemplates.has(template)),
      [...sentTemplates],
    );
    const failedMail = mail.find((email: Any) => email.template === 'billing.store_frozen');
    check('the frozen-store email names the unpaid bill', /PB-\d+/.test(failedMail?.subject ?? ''), failedMail?.subject);
  }

  console.log('\n9. Staff invitations and password recovery');
  if (!operator) {
    console.log('  (skipped: needs a platform administrator to read the outbox)');
  } else {
    const outbox = async (to: string, template: string) => {
      const rows = (await call<Any>('GET', `/platform/api/v1/emails?to=${encodeURIComponent(to)}&template=${template}&limit=5`, { token: operator })).body.emails ?? [];
      return rows[0] as Any | undefined;
    };
    const linkToken = (body: string | null | undefined) => /token=([A-Za-z0-9_-]+)/.exec(body ?? '')?.[1] ?? null;

    const invitee = `staff+${run}@smoke.test`;
    const invited = await call<Any>('POST', '/admin/api/v1/admin-users', {
      token: india.token,
      body: { admin_user: { email: invitee, first_name: 'Priya', is_super_admin: true } },
    });
    check('the owner invites a colleague, who has no password yet', invited.status === 201 && invited.body.admin_user?.status !== 'active', [invited.status, invited.body.admin_user?.status ?? invited.body]);
    const invitation = await outbox(invitee, 'staff.invitation');
    const inviteToken = linkToken(invitation?.body);
    check('an invitation email with a link is on its way', Boolean(inviteToken) && /invited you to Lotus Botanics/.test(invitation?.subject ?? ''), invitation?.subject);

    const described = (await call<Any>('GET', `/admin/api/v1/auth/invitations/${inviteToken}`)).body;
    check('the link says which store, and that a password is needed', described.needs_password === true && /Lotus Botanics/.test(described.shop?.name ?? ''), described);
    const chosen = 'Welcome2Lotus!';
    const accepted = await call<Any>('POST', '/admin/api/v1/auth/invitations/accept', { body: { token: inviteToken, password: chosen, first_name: 'Priya' } });
    check('accepting sets the password and joins the store', accepted.status === 200 && accepted.body.accepted === true, [accepted.status, accepted.body]);
    const again = await call<Any>('POST', '/admin/api/v1/auth/invitations/accept', { body: { token: inviteToken, password: chosen } });
    check('the link works once', again.status === 400, again.status);
    const staffLogin = await call<Any>('POST', '/admin/api/v1/auth/login', { body: { email: invitee, password: chosen } });
    const staffShop = (await call<Any>('GET', '/admin/api/v1/shop', { token: staffLogin.body.access_token })).body.shop;
    check('the new colleague signs in to the store', staffLogin.status === 200 && staffShop?.handle === india.handle, [staffLogin.status, staffShop?.handle]);

    const forgot = await call<Any>('POST', '/admin/api/v1/auth/password/forgot', { body: { email: invitee } });
    const nobody = await call<Any>('POST', '/admin/api/v1/auth/password/forgot', { body: { email: `nobody+${run}@smoke.test` } });
    check('"forgot password" answers the same whether or not the account exists', forgot.status === 202 && nobody.status === 202 && forgot.body.message === nobody.body.message, [forgot.status, nobody.status]);
    check('and emails only the real account', (await outbox(`nobody+${run}@smoke.test`, 'auth.password_reset')) === undefined);
    const resetMail = await outbox(invitee, 'auth.password_reset');
    const resetToken = linkToken(resetMail?.body);
    const weak = await call<Any>('POST', '/admin/api/v1/auth/password/reset', { body: { token: resetToken, password: 'short' } });
    check('a weak new password is refused', weak.status === 422, weak.status);
    const fresh = 'Fresh2Password!';
    const reset = await call<Any>('POST', '/admin/api/v1/auth/password/reset', { body: { token: resetToken, password: fresh } });
    check('the reset link sets a new password', reset.status === 200 && reset.body.reset === true, [reset.status, reset.body]);
    const oldSession = await call<Any>('GET', '/admin/api/v1/shop', { token: staffLogin.body.access_token });
    check('and signs out every existing session', oldSession.status === 401, oldSession.status);
    const oldPassword = await call<Any>('POST', '/admin/api/v1/auth/login', { body: { email: invitee, password: chosen } });
    const newPassword = await call<Any>('POST', '/admin/api/v1/auth/login', { body: { email: invitee, password: fresh } });
    check('the old password stops working and the new one works', oldPassword.status === 401 && newPassword.status === 200, [oldPassword.status, newPassword.status]);
    const reused = await call<Any>('POST', '/admin/api/v1/auth/password/reset', { body: { token: resetToken, password: 'Another3Password!' } });
    check('a reset link cannot be used twice', reused.status === 400, reused.status);
    check('the account holder is told the password changed', Boolean(await outbox(invitee, 'auth.password_changed')));
  }

  console.log('\n10. Apps and the shared API rate limit');
  const onStarter = await call<Any>('POST', '/admin/api/v1/apps/custom', { token: usa.token, body: { name: `Stock sync ${run}`, scopes: ['read_products'] } });
  check('API access is a plan feature: Starter is offered an upgrade', onStarter.status === 402 && onStarter.body.error?.code === 'FEATURE_NOT_IN_PLAN', [onStarter.status, onStarter.body.error?.code]);
  const upgraded = (await call<Any>('POST', '/admin/api/v1/billing/subscription', { token: usa.token, body: { plan: 'growth' } })).body;
  check('upgrading during the trial is free', upgraded.plan?.handle === 'growth' && upgraded.charge === null, [upgraded.plan?.handle, upgraded.charge]);
  const custom = await call<Any>('POST', '/admin/api/v1/apps/custom', { token: usa.token, body: { name: `Stock sync ${run}`, scopes: ['read_products'] } });
  const appToken = custom.body.access_token as string | undefined;
  check('a store builds a custom app and gets its token', custom.status === 201 && Boolean(appToken), [custom.status, custom.body]);
  const appCall = async (path: string) => {
    const response = await fetch(`${BASE}${path}`, { headers: { 'X-Veylog-Access-Token': appToken ?? '' } });
    return { status: response.status, limit: response.headers.get('X-Veylog-Shop-Api-Call-Limit'), retryAfter: response.headers.get('Retry-After') };
  };
  const first = await appCall('/admin/api/v1/products');
  check('the app reads the store\'s products, and is told where its bucket stands', first.status === 200 && first.limit === '1/40', first);
  const forbidden = await appCall('/admin/api/v1/orders');
  check('outside its scopes it is refused', forbidden.status === 403, forbidden.status);
  const burst = await Promise.all(Array.from({ length: 70 }, () => appCall('/admin/api/v1/products')));
  const served = burst.filter((response) => response.status === 200).length;
  const throttled = burst.filter((response) => response.status === 429);
  check(
    'a burst of 70 is cut at the bucket (40, less what the first two calls used), the rest told when to retry',
    served <= 40 && served >= 36 && throttled.length === 70 - served && throttled.every((response) => Number(response.retryAfter) >= 1),
    { served, throttled: throttled.length, sample: throttled[0] },
  );

  console.log('\n11. Brand, and the operators\' console');
  const noBrand = (await call<Any>('GET', '/api/v1/storefront/shop', { shop: usa.handle })).body;
  check('a new store has no brand yet, and the storefront says so', noBrand.brand?.slogan === null && Array.isArray(noBrand.brand?.social_links), noBrand.brand);
  const badLink = await call<Any>('PUT', '/admin/api/v1/shop/brand', { token: usa.token, body: { social_links: [{ platform: 'instagram', url: 'http://insecure.example' }] } });
  check('a social link must be https', badLink.status === 422, badLink.status);
  const branded = await call<Any>('PUT', '/admin/api/v1/shop/brand', {
    token: usa.token,
    body: { slogan: 'Power for the everyday', short_description: 'Chargers and cables.', social_links: [{ platform: 'instagram', url: 'https://instagram.com/volt' }] },
  });
  check('the owner sets a slogan, a description and a social link', branded.status === 200 && branded.body.brand?.slogan === 'Power for the everyday', [branded.status, branded.body]);
  const storefrontBrand = (await call<Any>('GET', '/api/v1/storefront/shop', { shop: usa.handle })).body;
  check(
    'the storefront gets the brand at once (the cache is dropped on save), with the store\'s contact',
    storefrontBrand.brand?.short_description === 'Chargers and cables.' && storefrontBrand.brand?.social_links?.[0]?.platform === 'instagram' && 'contact' in storefrontBrand,
    storefrontBrand.brand,
  );
  const otherBrand = (await call<Any>('GET', '/api/v1/storefront/shop', { shop: india.handle })).body;
  check('another store\'s brand is untouched', otherBrand.brand?.slogan === null, otherBrand.brand);
  const staffOnly = await call<Any>('GET', '/platform/api/v1/overview', { token: usa.token });
  check('a merchant cannot open the operators\' console', staffOnly.status === 403, staffOnly.status);
  if (operator) {
    const board = (await call<Any>('GET', '/platform/api/v1/overview', { token: operator })).body;
    check(
      'the console overview has revenue, outstanding bills, sign-ups and the newest stores',
      Array.isArray(board.revenue) && Array.isArray(board.outstanding) && Array.isArray(board.signups_last_30_days) && board.newest_shops?.some((shop: Any) => shop.handle === usa.handle),
      Object.keys(board),
    );
    const listed = (await call<Any>('GET', `/platform/api/v1/shops?q=${usa.handle}`, { token: operator })).body.shops?.[0];
    const detail = (await call<Any>('GET', `/platform/api/v1/shops/${listed?.id}`, { token: operator })).body;
    check('a store\'s console page has its plan and bills', detail.plan?.handle === 'growth' && Array.isArray(detail.invoices), [detail.plan?.handle, detail.invoices?.length]);
    const handle = `smoke-${run}`.toLowerCase();
    const created = await call<Any>('POST', '/platform/api/v1/plans', {
      token: operator,
      body: { handle, name: 'Smoke deal', price_amount: 999, currency: 'INR', limits: { products: 50 }, features: { api_access: true } },
    });
    const limits = typeof created.body.plan?.limits === 'string' ? JSON.parse(created.body.plan.limits) : created.body.plan?.limits;
    check('an operator creates a private plan, every limit spelled out', created.status === 201 && created.body.plan?.is_public === 0 && limits?.products === 50 && limits?.staff_accounts === null, [created.status, limits]);
    const duplicate = await call<Any>('POST', '/platform/api/v1/plans', { token: operator, body: { handle, name: 'Again', price_amount: 1 } });
    check('a plan handle is unique', duplicate.status === 409, duplicate.status);
    await call<Any>('PATCH', `/platform/api/v1/plans/${handle}`, { token: operator, body: { is_active: false } });
    const revived = await call<Any>('PATCH', `/platform/api/v1/plans/${handle}`, { token: operator, body: { is_active: true, trial_days: 30 } });
    check('a retired plan can be brought back', revived.status === 200 && revived.body.plan?.is_active === 1 && revived.body.plan?.trial_days === 30, [revived.status, revived.body.plan?.is_active]);
    await call<Any>('PATCH', `/platform/api/v1/plans/${handle}`, { token: operator, body: { is_active: false } });
  }

  console.log(`\n${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
