/* eslint-disable @typescript-eslint/no-explicit-any */
import { googleFontsUrl } from '../themes/fonts';

/**
 * The checkout. As on Shopify, it belongs to the platform, not the theme: a
 * theme can brand it (colours, fonts, logo — from the theme's settings) but
 * cannot change what it asks or how payment happens, so every store's
 * checkout is equally trustworthy and equally maintained.
 *
 * One page: contact, delivery address, delivery method, discount, payment,
 * with the order summary alongside. It talks to the Storefront API on the
 * same origin (the same endpoints a headless storefront uses), then hands
 * over to the store's payment gateway (Razorpay, Stripe or PayPal).
 */

interface CheckoutInput {
  cart: any;
  shop: { name: string; brand?: { logo?: { src?: string } | null } | null; permanent_domain?: string; policies?: { title: string; url: string }[] };
  settings: Record<string, any>;
  countries?: { country: string; currency: string; market: string }[];
  shopHandle?: string;
  locale: string;
  /** The signed-in shopper: contact details and address book, to fill the form in. */
  customer?: {
    name: string;
    email: string | null;
    phone: string;
    first_name: string;
    last_name: string;
    accepts_marketing: boolean;
    addresses: { id: number | null; first_name: string; last_name: string; address1: string; address2: string; city: string; province: string; zip: string; country_code: string; default: boolean; summary: string }[];
  } | null;
  /** Whether to offer signing in (the store's customer accounts setting). */
  accountsEnabled?: boolean;
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const hex = (value: unknown, fallback: string) => (typeof value === 'string' && /^#[0-9a-f]{3,8}$/i.test(value) ? value : fallback);
const family = (value: any, fallback: string) => {
  const name = typeof value === 'string' ? value : value?.family;
  return typeof name === 'string' && /^[\w\s-]{2,40}$/.test(name) ? name : fallback;
};

export function checkoutPage(input: CheckoutInput): string {
  const s = input.settings ?? {};
  const bg = hex(s.color_background, '#ffffff');
  const text = hex(s.color_text, '#1a1a1a');
  const muted = hex(s.color_text_muted, '#6b6b6b');
  const accent = hex(s.color_accent, '#1a1a1a');
  const onAccent = hex(s.color_accent_contrast, '#ffffff');
  const border = hex(s.color_border, '#e3e3e3');
  const surface = hex(s.color_ivory ?? s.color_cream, '#fafafa');
  const headingFont = family(s.font_heading, 'Inter');
  const bodyFont = family(s.font_body, 'Inter');
  const fontsUrl = googleFontsUrl([headingFont, bodyFont]);
  const logo = s.logo?.src ?? input.shop.brand?.logo?.src ?? null;
  const radius = Math.min(16, Math.max(0, Number(s.radius ?? 8)));
  const boot = JSON.stringify({ cart: input.cart, countries: input.countries ?? [], shop: input.shopHandle ?? '', name: input.shop.name, customer: input.customer ?? null }).replace(/</g, '\\u003c');
  const back = encodeURIComponent(`/checkouts/${input.cart.token}`);
  const account = input.customer
    ? `<p class="account-line">Signed in as <strong>${esc(input.customer.name)}</strong> · <a href="/account/logout?return_url=${back}">Sign out</a></p>`
    : input.accountsEnabled
      ? `<p class="account-line">Have an account? <a href="/account/login?return_url=${back}">Sign in</a></p>`
      : '';
  const saved = input.customer?.addresses.length
    ? `<div class="row"><div class="field"><label for="saved">Saved addresses</label><select id="saved"><option value="">Use a new address</option>${input.customer.addresses
        .map((address, index) => `<option value="${index}"${address.default ? ' selected' : ''}>${esc(address.summary)}</option>`)
        .join('')}</select></div></div>`
    : '';

  return `<!doctype html>
<html lang="${esc(input.locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Checkout – ${esc(input.shop.name)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="${fontsUrl}">
<style>
:root{--bg:${bg};--text:${text};--muted:${muted};--accent:${accent};--on-accent:${onAccent};--border:${border};--surface:${surface};--radius:${radius}px;--danger:#c0392b}
*{box-sizing:border-box}html,body{margin:0}body{background:var(--bg);color:var(--text);font:15px/1.5 "${bodyFont}",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--accent)}h1,h2{font-family:"${headingFont}",serif;font-weight:600;margin:0}
.wrap{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,440px);min-height:100vh}
.main{padding:40px clamp(16px,5vw,64px);max-width:720px;justify-self:end;width:100%}
.aside{background:var(--surface);border-left:1px solid var(--border);padding:40px clamp(16px,4vw,48px)}
.aside-inner{position:sticky;top:32px;max-width:420px}
.brand{display:flex;align-items:center;gap:12px;margin-bottom:24px;text-decoration:none;color:var(--text)}.brand img{max-height:40px;max-width:180px}.brand span{font-family:"${headingFont}",serif;font-size:22px;font-weight:600}
.crumbs{font-size:13px;color:var(--muted);margin-bottom:28px}.crumbs a{text-decoration:none}
section.step{margin-bottom:32px}section.step h2{font-size:19px;margin-bottom:14px}
.row{display:grid;gap:12px;margin-bottom:12px}.two{grid-template-columns:1fr 1fr}.three{grid-template-columns:1fr 1fr 1fr}
.field{position:relative}.field input,.field select,.field textarea{width:100%;font:inherit;color:var(--text);background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:13px 12px;outline:none;transition:border-color .15s,box-shadow .15s}
.field input:focus,.field select:focus,.field textarea:focus{border-color:var(--accent);box-shadow:0 0 0 3px color-mix(in srgb,var(--accent) 18%,transparent)}
.field label{display:block;font-size:13px;color:var(--muted);margin-bottom:6px}.field .err{color:var(--danger);font-size:13px;margin-top:4px;display:none}.field.invalid input,.field.invalid select{border-color:var(--danger)}.field.invalid .err{display:block}
.check{display:flex;gap:10px;align-items:center;font-size:14px;margin-top:4px}
.options{border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;background:#fff}
.option{display:flex;align-items:center;gap:12px;padding:14px 16px;border-top:1px solid var(--border);cursor:pointer}.option:first-child{border-top:0}
.option input{accent-color:var(--accent);width:18px;height:18px}.option .grow{flex:1}.option small{display:block;color:var(--muted)}
.option.selected{background:color-mix(in srgb,var(--accent) 6%,#fff)}
.muted{color:var(--muted)}.empty{padding:16px;border:1px dashed var(--border);border-radius:var(--radius);color:var(--muted);font-size:14px}
.btn{appearance:none;border:0;border-radius:var(--radius);background:var(--accent);color:var(--on-accent);font:600 16px/1 inherit;font-family:inherit;padding:18px 24px;cursor:pointer;width:100%;transition:opacity .15s}
.btn[disabled]{opacity:.55;cursor:progress}.btn.secondary{background:transparent;color:var(--text);border:1px solid var(--border);width:auto;padding:12px 16px;font-size:14px}
.alert{border-radius:var(--radius);padding:12px 14px;margin-bottom:18px;font-size:14px;display:none}.alert.show{display:block}.alert.error{background:#fdecea;color:#8e1f0b}.alert.info{background:#eef4ff;color:#1f3b73}
.lines{list-style:none;margin:0 0 20px;padding:0}.line{display:flex;gap:14px;align-items:center;margin-bottom:14px}
.thumb{position:relative;width:64px;height:64px;border-radius:var(--radius);border:1px solid var(--border);background:#fff;flex:none}.thumb img{width:100%;height:100%;object-fit:cover;border-radius:inherit}
.qty{position:absolute;top:-8px;right:-8px;background:var(--muted);color:#fff;border-radius:999px;font-size:12px;min-width:22px;height:22px;display:grid;place-items:center;padding:0 6px}
.line .name{flex:1;font-size:14px}.line .name small{display:block;color:var(--muted)}.line .price{font-size:14px;white-space:nowrap}
.discount{display:flex;gap:8px;margin:18px 0}.discount .field{flex:1}
.totals{border-top:1px solid var(--border);padding-top:14px}.totals div{display:flex;justify-content:space-between;margin:6px 0;font-size:14px}
.totals .grand{font-size:19px;font-weight:600;margin-top:12px;padding-top:12px;border-top:1px solid var(--border)}.totals .grand small{font-size:12px;color:var(--muted);font-weight:400;margin-right:6px}
.tag{display:inline-flex;gap:6px;align-items:center;background:#fff;border:1px solid var(--border);border-radius:999px;padding:3px 10px;font-size:12px}
.tag button{border:0;background:none;cursor:pointer;color:var(--muted);font-size:14px;padding:0}
.account-line{margin:-4px 0 12px;font-size:14px;color:var(--muted)}.account-line a{color:var(--accent)}
.summary-toggle{display:none}
.done{text-align:left;max-width:560px}.done .tick{width:56px;height:56px;border-radius:999px;border:2px solid var(--accent);display:grid;place-items:center;color:var(--accent);font-size:28px;margin-bottom:16px}
.done .card{border:1px solid var(--border);border-radius:var(--radius);padding:18px;margin:18px 0}
footer{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);font-size:12px;color:var(--muted)}
@media (max-width:900px){.wrap{grid-template-columns:1fr}.aside{order:-1;border-left:0;border-bottom:1px solid var(--border);padding:16px}.aside-inner{position:static;max-width:none}.main{justify-self:stretch;padding:24px 16px}
.summary-toggle{display:flex;justify-content:space-between;width:100%;background:none;border:0;font:inherit;color:var(--accent);padding:4px 0;cursor:pointer}.aside .collapsible{display:none;margin-top:16px}.aside.open .collapsible{display:block}.two,.three{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="wrap">
  <main class="main" id="main">
    <a class="brand" href="/">${logo ? `<img src="${esc(logo)}" alt="${esc(input.shop.name)}">` : `<span>${esc(input.shop.name)}</span>`}</a>
    <nav class="crumbs"><a href="/cart">Cart</a> › <strong>Information</strong> › Delivery › Payment</nav>
    <div class="alert error" id="alert" role="alert"></div>
    <form id="checkout" novalidate>
      <section class="step">
        <h2>Contact</h2>
        ${account}
        <div class="row"><div class="field" data-f="contact.email"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="email" required><div class="err"></div></div></div>
        <div class="row"><div class="field" data-f="contact.phone"><label for="phone">Mobile number</label><input id="phone" name="phone" type="tel" autocomplete="tel" required><div class="err"></div></div></div>
        <label class="check"><input type="checkbox" id="marketing"> Email me with news and offers</label>
      </section>
      <section class="step">
        <h2>Delivery</h2>
        ${saved}
        <div class="row"><div class="field" data-f="shipping_address.country"><label for="country">Country/Region</label><select id="country" autocomplete="country"></select><div class="err"></div></div></div>
        <div class="row two">
          <div class="field" data-f="contact.first_name"><label for="first_name">First name</label><input id="first_name" autocomplete="given-name" required><div class="err"></div></div>
          <div class="field" data-f="contact.last_name"><label for="last_name">Last name</label><input id="last_name" autocomplete="family-name"><div class="err"></div></div>
        </div>
        <div class="row"><div class="field" data-f="shipping_address.line1"><label for="line1">Address</label><input id="line1" autocomplete="address-line1" required><div class="err"></div></div></div>
        <div class="row"><div class="field" data-f="shipping_address.line2"><label for="line2">Apartment, suite, etc. (optional)</label><input id="line2" autocomplete="address-line2"><div class="err"></div></div></div>
        <div class="row three">
          <div class="field" data-f="shipping_address.city"><label for="city">City</label><input id="city" autocomplete="address-level2" required><div class="err"></div></div>
          <div class="field" data-f="shipping_address.state"><label for="state">State</label><input id="state" autocomplete="address-level1" required><div class="err"></div></div>
          <div class="field" data-f="shipping_address.pincode"><label for="pincode">PIN / postal code</label><input id="pincode" autocomplete="postal-code" inputmode="numeric" required><div class="err"></div></div>
        </div>
      </section>
      <section class="step">
        <h2>Delivery method</h2>
        <div id="methods" class="empty">Enter your address to see delivery options.</div>
      </section>
      <section class="step">
        <h2>Payment</h2>
        <p class="muted" style="margin:-6px 0 12px;font-size:14px">All transactions are secure and encrypted.</p>
        <div class="options" id="payments"></div>
      </section>
      <section class="step">
        <div class="field"><label for="note">Order note (optional)</label><textarea id="note" rows="2" maxlength="500"></textarea></div>
      </section>
      <button class="btn" id="pay" type="submit">Complete order</button>
    </form>
    <footer>${(input.shop.policies ?? []).map((policy) => `<a href="${esc(policy.url)}">${esc(policy.title)}</a>`).join(' · ')}</footer>
  </main>
  <aside class="aside" id="aside">
    <div class="aside-inner">
      <button class="summary-toggle" type="button" id="toggle"><span>Show order summary</span><strong id="toggle-total"></strong></button>
      <div class="collapsible">
        <ul class="lines" id="lines"></ul>
        <form class="discount" id="discount-form">
          <div class="field"><input id="code" placeholder="Discount code or gift card" aria-label="Discount code or gift card" autocomplete="off"></div>
          <button class="btn secondary" type="submit">Apply</button>
        </form>
        <div id="codes"></div>
        <div class="totals" id="totals"></div>
      </div>
    </div>
  </aside>
</div>
<script>
(function(){
var BOOT = ${boot};
var cart = BOOT.cart, token = cart.token;
var state = { shipping: cart.delivery && cart.delivery.selected_method || null, payment: null, gateway: null, busy: false };
var $ = function(id){ return document.getElementById(id); };
function money(v){ if (v === null || v === undefined) return ''; try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cart.totals.currency || 'INR' }).format(v); } catch (e) { return cart.totals.currency + ' ' + Number(v).toFixed(2); } }
function api(method, path, body, extra){
  var headers = { 'Accept': 'application/json', 'X-Veylog-Shop-Domain': BOOT.shop };
  if (body) headers['Content-Type'] = 'application/json';
  if (extra) for (var k in extra) headers[k] = extra[k];
  return fetch('/api/v1' + path, { method: method, headers: headers, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' })
    .then(function(r){ return r.json().catch(function(){ return {}; }).then(function(j){ if (!r.ok) { var e = new Error((j.error && j.error.message) || 'Something went wrong.'); e.details = j.error && j.error.details; e.status = r.status; throw e; } return j; }); });
}
function alertMsg(msg, kind){ var a = $('alert'); a.textContent = msg || ''; a.className = 'alert ' + (kind || 'error') + (msg ? ' show' : ''); if (msg) a.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
function clearErrors(){ document.querySelectorAll('.field.invalid').forEach(function(f){ f.classList.remove('invalid'); }); }
function fieldError(path, msg){ var f = document.querySelector('[data-f="' + path + '"]'); if (!f) return false; f.classList.add('invalid'); f.querySelector('.err').textContent = msg; return true; }

// countries
var sel = $('country'); var list = BOOT.countries.length ? BOOT.countries : [{ country: (cart.market && cart.market.country) || 'IN' }];
var names = (window.Intl && Intl.DisplayNames) ? new Intl.DisplayNames(['en'], { type: 'region' }) : null;
list.forEach(function(c){ var o = document.createElement('option'); o.value = c.country; o.textContent = names ? names.of(c.country) : c.country; sel.appendChild(o); });
sel.value = (cart.market && cart.market.country) || list[0].country;
// the signed-in shopper's details and saved addresses
var me = BOOT.customer;
function fillAddress(a){
  if (!a) return;
  [['first_name', a.first_name], ['last_name', a.last_name], ['line1', a.address1], ['line2', a.address2], ['city', a.city], ['state', a.province], ['pincode', a.zip]].forEach(function(pair){ $(pair[0]).value = pair[1] || ''; });
  if (a.country_code && list.some(function(c){ return c.country === a.country_code; })) sel.value = a.country_code;
}
if (me) {
  if (me.email) $('email').value = me.email;
  $('phone').value = me.phone || '';
  $('first_name').value = me.first_name || ''; $('last_name').value = me.last_name || '';
  $('marketing').checked = !!me.accepts_marketing;
  var preferred = me.addresses.filter(function(a){ return a.default; })[0] || me.addresses[0];
  fillAddress(preferred);
  if ($('saved')) $('saved').addEventListener('change', function(e){ var a = me.addresses[Number(e.target.value)]; if (a) { fillAddress(a); lookupDelivery(); } });
}
sel.addEventListener('change', function(){ api('PUT', '/cart/' + token + '/market', { country: sel.value }).then(function(r){ cart = r.cart; render(); lookupDelivery(); }).catch(function(e){ alertMsg(e.message); }); });

// delivery
var timer = null;
function lookupDelivery(){
  var pin = $('pincode').value.trim(); if (pin.length < 3) return;
  api('PUT', '/cart/' + token + '/delivery', { pincode: pin, state: $('state').value.trim() || null }).then(function(r){ cart = r.cart; render(); }).catch(function(e){ fieldError('shipping_address.pincode', e.message); });
}
['pincode', 'state'].forEach(function(id){ $(id).addEventListener('input', function(){ clearTimeout(timer); timer = setTimeout(lookupDelivery, 500); }); });

function renderMethods(){
  var d = cart.delivery || {}; var box = $('methods');
  if (!d.options || !d.options.length) { box.className = 'empty'; box.textContent = d.message || 'Enter your address to see delivery options.'; return; }
  box.className = 'options'; box.innerHTML = '';
  if (!state.shipping || !d.options.some(function(o){ return o.method === state.shipping; })) state.shipping = d.options[0].method;
  d.options.forEach(function(o){
    var row = document.createElement('label'); row.className = 'option' + (o.method === state.shipping ? ' selected' : '');
    var eta = o.eta_min_days ? (o.eta_min_days === o.eta_max_days ? o.eta_min_days : o.eta_min_days + '–' + o.eta_max_days) + ' business days' : '';
    row.innerHTML = '<input type="radio" name="shipping"><span class="grow"></span><strong></strong>';
    row.querySelector('input').checked = o.method === state.shipping;
    row.querySelector('.grow').innerHTML = '<span></span><small></small>'; row.querySelector('.grow span').textContent = o.name; row.querySelector('.grow small').textContent = eta;
    row.querySelector('strong').textContent = o.price ? money(o.price) : 'Free';
    row.addEventListener('click', function(){ state.shipping = o.method; refreshTotals(); });
    box.appendChild(row);
  });
}
function renderPayments(){
  var box = $('payments'); box.innerHTML = '';
  if (cart.totals && cart.totals.gift_cards > 0 && cart.totals.total_due === 0) {
    box.className = 'empty'; box.textContent = 'Your gift card covers this order — there is nothing more to pay.';
    state.payment = 'online'; $('pay').disabled = false; $('pay').textContent = 'Complete order'; return;
  }
  var opts = [];
  if (state.gateway && state.gateway.online_enabled) opts.push({ value: 'online', name: state.gateway.provider === 'stripe' ? 'Credit / debit card' : state.gateway.provider === 'paypal' ? 'PayPal' : 'UPI, cards, wallets & netbanking', note: state.gateway.test_mode ? 'Test mode — no real money will be charged' : '' });
  if (cart.payment_options && cart.payment_options.cod) opts.push({ value: 'cod', name: 'Cash on delivery (COD)', note: cart.payment_options.cod_fee ? 'A ' + money(cart.payment_options.cod_fee) + ' COD fee applies' : '' });
  if (!opts.length) { box.className = 'empty'; box.textContent = (cart.payment_options && cart.payment_options.cod_unavailable_reason) || 'This store is not accepting payments right now.'; $('pay').disabled = true; return; }
  box.className = 'options'; $('pay').disabled = false;
  if (!state.payment || !opts.some(function(o){ return o.value === state.payment; })) state.payment = opts[0].value;
  opts.forEach(function(o){
    var row = document.createElement('label'); row.className = 'option' + (o.value === state.payment ? ' selected' : '');
    row.innerHTML = '<input type="radio" name="payment"><span class="grow"><span></span><small></small></span>';
    row.querySelector('input').checked = o.value === state.payment; row.querySelector('.grow span').textContent = o.name; row.querySelector('small').textContent = o.note;
    row.addEventListener('click', function(){ state.payment = o.value; refreshTotals(); });
    box.appendChild(row);
  });
  $('pay').textContent = state.payment === 'online' ? 'Pay now' : 'Complete order';
}
function renderSummary(){
  var ul = $('lines'); ul.innerHTML = '';
  cart.items.forEach(function(l){
    var li = document.createElement('li'); li.className = 'line';
    li.innerHTML = '<div class="thumb">' + (l.image ? '<img alt="">' : '') + '<span class="qty"></span></div><div class="name"><span></span><small></small></div><div class="price"></div>';
    if (l.image) li.querySelector('img').src = l.image;
    li.querySelector('.qty').textContent = l.quantity; li.querySelector('.name span').textContent = l.name; li.querySelector('.name small').textContent = l.variant_title || '';
    li.querySelector('.price').textContent = money(l.line_total);
    ul.appendChild(li);
  });
  var codes = $('codes'); codes.innerHTML = '';
  if (cart.discount_code) {
    var t = document.createElement('div'); t.style.margin = '-6px 0 12px';
    t.innerHTML = '<span class="tag"><span></span><button type="button" aria-label="Remove code">×</button></span> <small class="muted"></small>';
    t.querySelector('.tag span').textContent = cart.discount_code.code; t.querySelector('small').textContent = cart.discount_code.message || '';
    t.querySelector('button').addEventListener('click', function(){ api('DELETE', '/cart/' + token + '/discount').then(function(r){ cart = r.cart; render(); }); });
    codes.appendChild(t);
  }
  (cart.gift_cards || []).forEach(function(g){
    var t = document.createElement('div'); t.style.margin = '-6px 0 12px';
    t.innerHTML = '<span class="tag"><span></span><button type="button" aria-label="Remove gift card">×</button></span> <small class="muted"></small>';
    t.querySelector('.tag span').textContent = 'Gift card •••• ' + g.last_characters;
    t.querySelector('small').textContent = g.usable ? 'Balance after this order: ' + money(g.balance_after) : (g.message || '');
    t.querySelector('button').addEventListener('click', function(){ api('DELETE', '/cart/' + token + '/gift-cards/' + g.id).then(function(r){ cart = r.cart; render(); }); });
    codes.appendChild(t);
  });
  var tt = cart.totals, rows = [['Subtotal', money(tt.subtotal)]];
  if (tt.discount) rows.push(['Discount', '−' + money(tt.discount)]);
  rows.push(['Shipping', cart.delivery && cart.delivery.options && cart.delivery.options.length ? (tt.shipping ? money(tt.shipping) : 'Free') : 'Enter address']);
  if (tt.cod_fee) rows.push(['COD fee', money(tt.cod_fee)]);
  if (tt.tax_total && !tt.tax_included_in_prices) rows.push(['Taxes', money(tt.tax_total)]);
  var cards = (cart.gift_cards || []).filter(function(g){ return g.amount > 0; });
  $('totals').innerHTML = rows.map(function(r){ return '<div><span>' + r[0] + '</span><span>' + r[1] + '</span></div>'; }).join('') +
    '<div class="grand"><span>Total</span><span><small>' + (tt.currency || '') + '</small>' + money(tt.total) + '</span></div>' +
    (tt.tax_included_in_prices && tt.tax_total ? '<p class="muted" style="font-size:12px;margin:6px 0 0">Including ' + money(tt.tax_total) + ' in taxes</p>' : '') +
    cards.map(function(g){ return '<div><span>Gift card •••• ' + g.last_characters + '</span><span>−' + money(g.amount) + '</span></div>'; }).join('') +
    (cards.length ? '<div class="grand"><span>Total due</span><span><small>' + (tt.currency || '') + '</small>' + money(tt.total_due) + '</span></div>' : '');
  $('toggle-total').textContent = money(cards.length ? tt.total_due : tt.total);
}
function render(){ renderMethods(); renderPayments(); renderSummary(); }
function refreshTotals(){
  var q = []; if (state.shipping) q.push('shipping_method=' + encodeURIComponent(state.shipping)); if (state.payment) q.push('payment_method=' + encodeURIComponent(state.payment));
  api('GET', '/cart/' + token + (q.length ? '?' + q.join('&') : '')).then(function(r){ cart = r.cart; render(); }).catch(function(){ render(); });
}
$('toggle').addEventListener('click', function(){ var a = $('aside'); a.classList.toggle('open'); this.querySelector('span').textContent = a.classList.contains('open') ? 'Hide order summary' : 'Show order summary'; });
$('discount-form').addEventListener('submit', function(e){ e.preventDefault(); var code = $('code').value.trim(); if (!code) return;
  api('POST', '/cart/' + token + '/discount', { code: code }).then(function(r){ cart = r.cart; $('code').value = ''; render(); }).catch(function(err){ alertMsg(err.message); }); });

function payload(){
  return {
    payment_method: state.payment, shipping_method: state.shipping,
    contact: { first_name: $('first_name').value.trim(), last_name: $('last_name').value.trim() || null, phone: $('phone').value.trim(), email: $('email').value.trim() || null },
    shipping_address: { line1: $('line1').value.trim(), line2: $('line2').value.trim() || null, city: $('city').value.trim(), state: $('state').value.trim(), country: sel.value, pincode: $('pincode').value.trim() },
    customer_note: $('note').value.trim() || null, accepts_marketing: $('marketing').checked
  };
}
var idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
$('checkout').addEventListener('submit', function(e){
  e.preventDefault(); if (state.busy) return; clearErrors(); alertMsg('');
  var body = payload(); state.busy = true; $('pay').disabled = true; $('pay').textContent = 'Processing…';
  api('POST', '/cart/' + token + '/checkout', body, { 'Idempotency-Key': idem }).then(function(r){
    var order = r.order;
    if (!order.payment_required) return done(order);
    return pay(order, body);
  }).catch(function(err){
    var shown = false; var det = err.details || {};
    Object.keys(det).forEach(function(k){ var m = Array.isArray(det[k]) ? det[k][0] : det[k]; if (fieldError(k, m)) shown = true; });
    alertMsg(shown ? 'Please check the highlighted fields.' : err.message);
    idem = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
  }).then(function(){ state.busy = false; if ($('pay')) { $('pay').disabled = false; renderPayments(); } });
});
function loadScript(src){ return new Promise(function(res, rej){ var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function(){ rej(new Error('The payment window could not be loaded.')); }; document.head.appendChild(s); }); }
function pay(order, body){
  var phone = body.contact.phone;
  return api('POST', '/payments/orders/' + encodeURIComponent(order.order_number) + '/start', { phone: phone }).then(function(r){
    var p = r.payment, c = p.checkout || {};
    if (p.provider === 'razorpay') {
      return loadScript('https://checkout.razorpay.com/v1/checkout.js').then(function(){
        return new Promise(function(resolve){
          var rz = new window.Razorpay({ key: c.key_id || p.key_id, order_id: c.gateway_order_id || p.gateway_order_id, amount: p.amount_minor, currency: p.currency, name: BOOT.name,
            prefill: { name: p.prefill && p.prefill.name, contact: phone, email: body.contact.email || undefined }, theme: { color: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() },
            handler: function(resp){ api('POST', '/payments/orders/' + encodeURIComponent(order.order_number) + '/verify', Object.assign({ phone: phone }, resp)).then(function(){ done(order, true); }).catch(function(err){ alertMsg(err.message); }).then(resolve); },
            modal: { ondismiss: function(){ alertMsg('Payment was not completed. Your order ' + order.order_number + ' is saved — you can try paying again.', 'info'); resolve(); } } });
          rz.open();
        });
      });
    }
    if (p.provider === 'paypal' && c.approve_url) { location.href = c.approve_url; return; }
    if (p.provider === 'stripe' && c.client_secret) {
      return loadScript('https://js.stripe.com/v3/').then(function(){
        var stripe = window.Stripe(c.publishable_key); var elements = stripe.elements({ clientSecret: c.client_secret });
        var box = document.createElement('div'); box.style.margin = '12px 0'; $('payments').after(box); elements.create('payment').mount(box);
        $('pay').textContent = 'Pay ' + money(p.amount);
        return new Promise(function(resolve){
          var handler = function(ev){ ev.preventDefault(); ev.stopImmediatePropagation();
            stripe.confirmPayment({ elements: elements, redirect: 'if_required' }).then(function(res){
              if (res.error) { alertMsg(res.error.message); return; }
              return api('POST', '/payments/orders/' + encodeURIComponent(order.order_number) + '/verify', { phone: phone, payment_intent: res.paymentIntent.id }).then(function(){ done(order, true); });
            }).catch(function(err){ alertMsg(err.message); }).then(resolve);
          };
          $('checkout').addEventListener('submit', handler, { capture: true, once: true });
        });
      });
    }
    alertMsg('Online payment is not available right now. Your order ' + order.order_number + ' is saved; the store will contact you.', 'info');
  });
}
function done(order, paid){
  document.cookie = 'cart=; Path=/; Max-Age=0';
  var m = $('main'); var total = money(order.total);
  m.innerHTML = '<a class="brand" href="/">' + document.querySelector('.brand').innerHTML + '</a><div class="done"><div class="tick">✓</div><p class="muted" style="margin:0">Order ' + order.order_number + '</p><h1 style="font-size:26px;margin:4px 0 8px">Thank you, ' + (payload().contact.first_name || '').replace(/[<>&]/g, '') + '!</h1>' +
    '<div class="card"><strong>Your order is confirmed</strong><p class="muted" style="margin:6px 0 0">' + (order.payment_method === 'gift_card' ? 'Paid in full with your gift card.' : order.payment_method === 'cod' ? 'Pay ' + money(order.total_due !== undefined ? order.total_due : order.total) + ' in cash when your order arrives.' : (paid ? 'We have received your payment of ' + money(order.total_due !== undefined ? order.total_due : order.total) + '.' : 'We will confirm your payment shortly.')) + ' You will get updates on ' + order.contact_phone + '.</p></div>' +
    '<a class="btn" style="display:inline-block;width:auto;text-decoration:none" href="/">Continue shopping</a></div>';
  window.scrollTo(0, 0);
}
fetch('/api/v1/payments/availability', { headers: { 'X-Veylog-Shop-Domain': BOOT.shop, 'Accept': 'application/json' } }).then(function(r){ return r.json(); }).then(function(g){ state.gateway = g; renderPayments(); refreshTotals(); }).catch(function(){ renderPayments(); });
render();
})();
</script>
</body>
</html>`;
}
