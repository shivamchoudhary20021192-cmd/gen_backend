import crypto from 'node:crypto';
import type { PrivacyCopy } from './privacyCopy';
import type { PrivacySettings } from './privacySettings';
import type { PrivacyRegion } from './regions';

/**
 * What runs in the shopper's browser.
 *
 * The core (inline in <head>, small) is Shopify's Customer Privacy API —
 * `window.Shopify.customerPrivacy` with the same methods and the same
 * `visitorConsentCollected` event — so theme and app code written for Shopify
 * works unchanged. It reads the `_tracking_consent` cookie, applies the
 * region's defaults (nothing non-essential until a yes where consent is
 * required; allowed, bar a Global Privacy Control opt-out, elsewhere), and
 * turns on scripts parked as <script type="text/plain" data-consent="…">
 * once their purposes are allowed.
 *
 * The banner and the preferences dialog (banner.js, a cached file) load only
 * where the banner may show, or when someone opens their preferences.
 *
 * The page is the same for every visitor in a region, so it can be cached:
 * nothing here depends on the visitor until it runs in their browser.
 */

export interface PrivacyClientConfig {
  v: 1;
  region: string;
  consentRequired: boolean;
  saleOptOut: boolean;
  honorGpc: boolean;
  maxAgeDays: number;
  reprompt: boolean;
  policyVersion: number;
  endpoint: string;
  bannerSrc: string;
  root: string;
  position: PrivacySettings['banner_position'];
  colors: PrivacySettings['banner_colors'];
  links: { privacyPolicy: string | null; choices: string | null; request: string | null };
  copy: Pick<
    PrivacyCopy,
    | 'title' | 'message' | 'accept' | 'decline' | 'manage' | 'save' | 'close' | 'privacy_policy' | 'preferences_title'
    | 'preferences_intro' | 'always_on' | 'essential_title' | 'essential_description' | 'preferences_category_title'
    | 'preferences_category_description' | 'analytics_title' | 'analytics_description' | 'marketing_title'
    | 'marketing_description' | 'sale_title' | 'sale_description' | 'cookie_preferences_link' | 'saved'
  >;
}

const CORE = `(function(){
if (window.__veylogPrivacy) return; window.__veylogPrivacy = true;
var C = window.__privacyConfig || {};
var S = window.Shopify = window.Shopify || {};
function read(){ var m = document.cookie.match(/(?:^|;\\s*)_tracking_consent=([^;]*)/); if (!m) return null;
  try { var d = JSON.parse(decodeURIComponent(m[1])); if (d && d.v === 1 && d.id && d.p) return d; } catch (e) {} return null; }
function valid(d){ if (!d) return false; if (Date.now() / 1000 - (d.ts || 0) > C.maxAgeDays * 86400) return false;
  if (C.reprompt && C.policyVersion > 0 && (d.pv || 0) < C.policyVersion) return false; return true; }
var stored = read(); if (!valid(stored)) stored = null;
var gpc = !!(C.honorGpc && navigator.globalPrivacyControl === true);
function flag(k){ if (stored) { if (k === 's' && gpc) return false; return stored.p[k] === 1; }
  if (C.consentRequired) return null; if (k === 's' && gpc) return false; return true; }
function yn(v){ return v === null ? '' : (v ? 'yes' : 'no'); }
function allowed(k){ return flag(k) === true; }
function detail(){ var m = allowed('m'), s = allowed('s');
  return { analyticsAllowed: allowed('a'), marketingAllowed: m, preferencesAllowed: allowed('p'), saleOfDataAllowed: s,
    firstPartyMarketingAllowed: m, thirdPartyMarketingAllowed: m && s }; }
var PURPOSE = { analytics: 'a', marketing: 'm', preferences: 'p', sale_of_data: 's' };
function permits(list){ var parts = String(list || '').split(/[\\s,]+/); for (var i = 0; i < parts.length; i++) { var p = parts[i];
  if (!p) continue; if (p === 'marketing') { if (!(allowed('m') && allowed('s'))) return false; } else if (!PURPOSE[p] || !allowed(PURPOSE[p])) return false; } return true; }
function activate(){ var list = document.querySelectorAll('script[type="text/plain"][data-consent]');
  for (var i = 0; i < list.length; i++) { var old = list[i]; if (!permits(old.getAttribute('data-consent'))) continue;
    var s = document.createElement('script'); for (var j = 0; j < old.attributes.length; j++) { var a = old.attributes[j];
      if (a.name !== 'type' && a.name !== 'data-consent') s.setAttribute(a.name, a.value); }
    s.type = old.getAttribute('data-type') || 'text/javascript'; if (!old.src) s.text = old.text; old.parentNode.replaceChild(s, old); } }
function fire(){ try { document.dispatchEvent(new CustomEvent('visitorConsentCollected', { detail: detail() })); } catch (e) {} activate(); }
function localCookie(p, method){ var d = { v: 1, id: (stored && stored.id) || '00000000-0000-4000-8000-000000000000', ts: Math.floor(Date.now() / 1000),
  p: p, pv: C.policyVersion, src: method, gpc: gpc ? 1 : 0 };
  document.cookie = '_tracking_consent=' + encodeURIComponent(JSON.stringify(d)) + '; Path=/; SameSite=Lax; Max-Age=' + (C.maxAgeDays * 86400); }
var api = {
  currentVisitorConsent: function(){ return { analytics: yn(flag('a')), marketing: yn(flag('m')), preferences: yn(flag('p')), sale_of_data: yn(flag('s')) }; },
  analyticsProcessingAllowed: function(){ return allowed('a'); },
  marketingAllowed: function(){ return allowed('m'); },
  preferencesProcessingAllowed: function(){ return allowed('p'); },
  saleOfDataAllowed: function(){ return allowed('s'); },
  userCanBeTracked: function(){ return allowed('a') && allowed('m'); },
  getTrackingConsent: function(){ var m = flag('m'); return m === null ? 'no_interaction' : (m ? 'yes' : 'no'); },
  shouldShowBanner: function(){ return !!C.consentRequired && !stored; },
  saleOfDataRegion: function(){ return !!C.saleOptOut; },
  getRegion: function(){ return C.region || ''; },
  consentId: function(){ return stored ? stored.id : null; },
  setTrackingConsent: function(consent, callback, method){
    if (typeof consent === 'boolean') consent = { analytics: consent, marketing: consent, preferences: consent, sale_of_data: consent };
    consent = consent || {};
    function pick(k, key){ return typeof consent[key] === 'boolean' ? consent[key] : allowed(k); }
    var body = { analytics: pick('a', 'analytics'), marketing: pick('m', 'marketing'), preferences: pick('p', 'preferences'),
      sale_of_data: pick('s', 'sale_of_data'), method: method || 'api', gpc: gpc, page: location.pathname };
    fetch(C.endpoint, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
      .then(function(r){ if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function(){ stored = read(); fire(); if (callback) callback(); })
      .catch(function(err){
        // Keep a refusal even if it could not be recorded: nothing non-essential should run.
        if (!body.analytics && !body.marketing && !body.preferences) { localCookie({ a: 0, m: 0, p: 0, s: body.sale_of_data ? 1 : 0 }, method || 'api'); stored = read(); fire(); }
        if (callback) callback({ error: String(err) }); });
  }
};
S.customerPrivacy = api; S.trackingConsent = api;
S.loadFeatures = S.loadFeatures || function(features, cb){ if (cb) setTimeout(function(){ cb(null); }, 0); };
var ui = null;
function loadUi(then){ if (window.privacyBanner && window.privacyBanner.ready) { then(window.privacyBanner); return; }
  (window.__privacyQueue = window.__privacyQueue || []).push(then);
  if (!ui) { ui = document.createElement('script'); ui.src = C.bannerSrc; ui.defer = true; document.head.appendChild(ui); } }
window.privacyBanner = window.privacyBanner || {
  loadBanner: function(){ loadUi(function(b){ b.loadBanner(); }); },
  showPreferences: function(){ loadUi(function(b){ b.showPreferences(); }); }
};
function wire(){
  var prefs = document.querySelectorAll('[data-privacy-preferences]');
  for (var i = 0; i < prefs.length; i++) { prefs[i].hidden = false; prefs[i].removeAttribute('hidden');
    prefs[i].addEventListener('click', function(e){ e.preventDefault(); window.privacyBanner.showPreferences(); }); }
  var choices = document.querySelectorAll('[data-privacy-choices]');
  for (var k = 0; k < choices.length; k++) { if (C.saleOptOut) { choices[k].hidden = false; choices[k].removeAttribute('hidden'); } }
  activate();
  if (C.consentRequired) loadUi(function(b){ b.loadBanner(); });
  // A Global Privacy Control signal is an opt-out of sale and sharing: record it once.
  if (gpc && C.saleOptOut && !C.consentRequired && (!stored || stored.p.s === 1)) api.setTrackingConsent({ sale_of_data: false }, null, 'gpc');
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire); else wire();
S.__privacyInternal = { read: function(){ return stored; }, refresh: function(){ stored = read(); if (!valid(stored)) stored = null; fire(); }, config: C };
})();`;

const BANNER = `(function(){
if (window.privacyBanner && window.privacyBanner.ready) return;
var C = window.__privacyConfig || {}, T = C.copy || {}, S = window.Shopify || {}, P = S.customerPrivacy, I = S.__privacyInternal;
var K = C.colors || {};
var css = '.vlp,.vlp *{box-sizing:border-box}.vlp{position:fixed;z-index:2147483600;font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;color:' + K.text + ';background:' + K.background + ';box-shadow:0 8px 32px rgba(0,0,0,.18);border:1px solid rgba(0,0,0,.08)}'
 + '.vlp--bottom{left:0;right:0;bottom:0;border-radius:0;padding:20px 24px}.vlp--bottom .vlp__in{max-width:1200px;margin:0 auto;display:flex;gap:24px;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}'
 + '.vlp--bottom_left,.vlp--bottom_right{bottom:16px;max-width:420px;width:calc(100% - 32px);border-radius:12px;padding:20px}.vlp--bottom_left{left:16px}.vlp--bottom_right{right:16px}'
 + '.vlp--center{top:50%;left:50%;transform:translate(-50%,-50%);max-width:520px;width:calc(100% - 32px);border-radius:12px;padding:24px}'
 + '.vlp__veil{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483599}'
 + '.vlp__text{flex:1 1 420px;min-width:0}.vlp__title{font-size:16px;font-weight:700;margin:0 0 6px}.vlp__msg{margin:0}.vlp__msg a{color:inherit;text-decoration:underline}'
 + '.vlp__actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:14px}.vlp--bottom .vlp__actions{margin-top:0}'
 + '.vlp__btn{appearance:none;border:1px solid ' + K.button + ';border-radius:8px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer;min-height:44px}'
 + '.vlp__btn--solid{background:' + K.button + ';color:' + K.button_text + '}.vlp__btn--quiet{background:transparent;color:' + K.text + '}'
 + '.vlp__btn:focus-visible,.vlp__switch input:focus-visible+.vlp__track,.vlp__x:focus-visible,.vlp-fab:focus-visible{outline:3px solid #2c6ecb;outline-offset:2px}'
 + '.vlp-dlg{position:fixed;z-index:2147483601;top:50%;left:50%;transform:translate(-50%,-50%);width:calc(100% - 32px);max-width:560px;max-height:calc(100vh - 32px);overflow:auto;background:' + K.background + ';color:' + K.text + ';border-radius:12px;padding:24px;box-shadow:0 12px 48px rgba(0,0,0,.3);font:14px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}'
 + '.vlp-dlg h2{font-size:18px;margin:0 0 8px}.vlp__x{position:absolute;top:12px;right:12px;border:0;background:transparent;color:inherit;font-size:22px;line-height:1;cursor:pointer;padding:6px;border-radius:6px}'
 + '.vlp__cat{border-top:1px solid rgba(0,0,0,.1);padding:14px 0;display:flex;gap:16px;align-items:flex-start;justify-content:space-between}.vlp__cat h3{font-size:15px;margin:0 0 2px}.vlp__cat p{margin:0;opacity:.8}'
 + '.vlp__switch{position:relative;display:inline-flex;flex:none;align-items:center;gap:8px;cursor:pointer}.vlp__switch input{position:absolute;opacity:0;width:44px;height:24px;margin:0;cursor:pointer}'
 + '.vlp__track{width:44px;height:24px;border-radius:12px;background:#b5b5b5;position:relative;transition:background .15s}.vlp__track:after{content:"";position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s}'
 + '.vlp__switch input:checked+.vlp__track{background:' + K.button + '}.vlp__switch input:checked+.vlp__track:after{left:23px}.vlp__switch input:disabled+.vlp__track{opacity:.6}'
 + '.vlp__side{display:flex;flex:none;align-items:center;gap:8px}.vlp__always{font-size:12px;opacity:.75;white-space:nowrap}'
 + '.vlp-fab{position:fixed;left:16px;bottom:16px;z-index:2147483590;width:44px;height:44px;border-radius:50%;border:1px solid rgba(0,0,0,.12);background:' + K.background + ';color:' + K.text + ';box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer;display:grid;place-items:center}'
 + '.vlp-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483602;background:#1a1a1a;color:#fff;padding:10px 16px;border-radius:8px;font:14px system-ui,sans-serif}'
 // On a phone "Reject all" and "Accept all" stay side by side at the same width; the third button gets its own row.
 + '@media (max-width:640px){.vlp--bottom{padding:16px}.vlp__actions{width:100%;display:grid;grid-template-columns:1fr 1fr}.vlp__actions [data-privacy-manage],.vlp__actions [data-privacy-save]{grid-column:1/-1}}';
function el(tag, attrs, text){ var n = document.createElement(tag); if (attrs) for (var k in attrs) n.setAttribute(k, attrs[k]); if (text) n.textContent = text; return n; }
var style = el('style'); style.textContent = css; document.head.appendChild(style);
var banner = null, veil = null, dialog = null, lastFocus = null;
function choose(consent, method){ P.setTrackingConsent(consent, function(result){ close(); if (!result || !result.error) toast(T.saved); fab(); }, method); }
function acceptAll(){ choose({ analytics: true, marketing: true, preferences: true, sale_of_data: true }, 'accept_all'); }
function rejectAll(){ choose({ analytics: false, marketing: false, preferences: false, sale_of_data: false }, 'reject_all'); }
function toast(text){ if (!text) return; var t = el('div', { role: 'status', 'class': 'vlp-toast' }, text); document.body.appendChild(t); setTimeout(function(){ t.remove(); }, 2600); }
function close(){ if (banner) { banner.remove(); banner = null; } if (veil) { veil.remove(); veil = null; } closeDialog(); }
function buttons(onManage){ var row = el('div', { 'class': 'vlp__actions' });
  var manage = el('button', { type: 'button', 'class': 'vlp__btn vlp__btn--quiet', 'data-privacy-manage': '' }, T.manage); manage.addEventListener('click', onManage);
  // Equal weight: "Reject all" and "Accept all" are the same button, on the same layer.
  var reject = el('button', { type: 'button', 'class': 'vlp__btn vlp__btn--solid', 'data-privacy-reject': '' }, T.decline); reject.addEventListener('click', rejectAll);
  var accept = el('button', { type: 'button', 'class': 'vlp__btn vlp__btn--solid', 'data-privacy-accept': '' }, T.accept); accept.addEventListener('click', acceptAll);
  row.appendChild(manage); row.appendChild(reject); row.appendChild(accept); return row; }
function loadBanner(){
  if (banner || !P.shouldShowBanner()) return;
  var center = C.position === 'center';
  if (center) { veil = el('div', { 'class': 'vlp__veil' }); document.body.appendChild(veil); }
  banner = el('div', { 'class': 'vlp vlp--' + (C.position || 'bottom'), role: center ? 'dialog' : 'region', 'aria-label': T.title, 'data-privacy-banner': '' });
  if (center) banner.setAttribute('aria-modal', 'true');
  var inner = el('div', { 'class': 'vlp__in' }), text = el('div', { 'class': 'vlp__text' });
  text.appendChild(el('p', { 'class': 'vlp__title', role: 'heading', 'aria-level': '2' }, T.title));
  var msg = el('p', { 'class': 'vlp__msg' }, T.message + ' ');
  if (C.links && C.links.privacyPolicy) msg.appendChild(el('a', { href: C.links.privacyPolicy }, T.privacy_policy));
  text.appendChild(msg); inner.appendChild(text); inner.appendChild(buttons(showPreferences)); banner.appendChild(inner);
  document.body.appendChild(banner);
  if (center) { var first = banner.querySelector('button'); if (first) first.focus(); }
}
var CATS = [['p', 'preferences', 'preferences_category_title', 'preferences_category_description'], ['a', 'analytics', 'analytics_title', 'analytics_description'], ['m', 'marketing', 'marketing_title', 'marketing_description']];
function closeDialog(){ if (!dialog) return; dialog.remove(); dialog = null; document.removeEventListener('keydown', onKey, true);
  var v = document.querySelector('.vlp__veil[data-dialog]'); if (v) v.remove(); if (lastFocus && lastFocus.focus) lastFocus.focus(); }
function onKey(e){ if (!dialog) return; if (e.key === 'Escape') { e.preventDefault(); closeDialog(); return; }
  if (e.key === 'Tab') { var f = dialog.querySelectorAll('button,input:not([disabled]),a[href]'); if (!f.length) return;
    var a = f[0], z = f[f.length - 1]; if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); } else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); } } }
function row(title, description, input){ var r = el('div', { 'class': 'vlp__cat' }), t = el('div');
  var h = el('h3', { id: 'vlp-' + Math.random().toString(36).slice(2) }, title); t.appendChild(h); t.appendChild(el('p', null, description)); r.appendChild(t);
  var side = el('div', { 'class': 'vlp__side' }), sw = el('label', { 'class': 'vlp__switch' }); input.setAttribute('aria-labelledby', h.id);
  sw.appendChild(input); sw.appendChild(el('span', { 'class': 'vlp__track', 'aria-hidden': 'true' })); side.appendChild(sw); r.appendChild(side); return { row: r, side: side }; }
function showPreferences(){
  if (dialog) return; lastFocus = document.activeElement;
  var v = el('div', { 'class': 'vlp__veil', 'data-dialog': '' }); v.addEventListener('click', closeDialog); document.body.appendChild(v);
  dialog = el('div', { 'class': 'vlp-dlg', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'vlp-dlg-title', 'data-privacy-preferences-dialog': '' });
  var x = el('button', { type: 'button', 'class': 'vlp__x', 'aria-label': T.close }, '\\u00d7'); x.addEventListener('click', closeDialog); dialog.appendChild(x);
  dialog.appendChild(el('h2', { id: 'vlp-dlg-title' }, T.preferences_title)); dialog.appendChild(el('p', null, T.preferences_intro));
  var always = el('input', { type: 'checkbox', role: 'switch', checked: '', disabled: '' });
  var essential = row(T.essential_title, T.essential_description, always); essential.side.insertBefore(el('span', { 'class': 'vlp__always' }, T.always_on), essential.side.firstChild); dialog.appendChild(essential.row);
  var current = P.currentVisitorConsent(), inputs = {};
  for (var i = 0; i < CATS.length; i++) { var c = CATS[i], box = el('input', { type: 'checkbox', role: 'switch', name: c[1] });
    // Never pre-ticked where consent is required and nothing was chosen yet.
    box.checked = current[c[1]] === 'yes' || (current[c[1]] === '' && !C.consentRequired); inputs[c[1]] = box; dialog.appendChild(row(T[c[2]], T[c[3]], box).row); }
  if (C.saleOptOut) { var sale = el('input', { type: 'checkbox', role: 'switch', name: 'sale_of_data' }); sale.checked = P.saleOfDataAllowed(); inputs.sale_of_data = sale; dialog.appendChild(row(T.sale_title, T.sale_description, sale).row); }
  var actions = el('div', { 'class': 'vlp__actions' });
  var save = el('button', { type: 'button', 'class': 'vlp__btn vlp__btn--quiet', 'data-privacy-save': '' }, T.save);
  save.addEventListener('click', function(){ var consent = {}; for (var key in inputs) consent[key] = inputs[key].checked;
    if (!C.saleOptOut) consent.sale_of_data = consent.marketing; choose(consent, 'custom'); });
  var reject = el('button', { type: 'button', 'class': 'vlp__btn vlp__btn--solid' }, T.decline); reject.addEventListener('click', rejectAll);
  var accept = el('button', { type: 'button', 'class': 'vlp__btn vlp__btn--solid' }, T.accept); accept.addEventListener('click', acceptAll);
  actions.appendChild(save); actions.appendChild(reject); actions.appendChild(accept); dialog.appendChild(actions);
  if (C.links && C.links.privacyPolicy) { var p = el('p', { style: 'margin:14px 0 0' }); p.appendChild(el('a', { href: C.links.privacyPolicy, style: 'color:inherit' }, T.privacy_policy)); dialog.appendChild(p); }
  document.body.appendChild(dialog); document.addEventListener('keydown', onKey, true); x.focus();
}
// A way back to the choices on every page, for themes without a "Cookie preferences" link.
function fab(){ if (!C.consentRequired || document.querySelector('[data-privacy-preferences]') || document.querySelector('.vlp-fab') || !I.read()) return;
  var b = el('button', { type: 'button', 'class': 'vlp-fab', 'aria-label': T.cookie_preferences_link, title: T.cookie_preferences_link });
  b.innerHTML = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M21 12.3A9 9 0 1 1 11.7 3a3 3 0 0 0 3.8 3.8A3 3 0 0 0 21 12.3Z"/><circle cx="8.5" cy="10.5" r="1"/><circle cx="12" cy="15.5" r="1"/><circle cx="15.5" cy="12" r="1"/></svg>';
  b.addEventListener('click', showPreferences); document.body.appendChild(b); }
window.privacyBanner = { ready: true, loadBanner: loadBanner, showPreferences: showPreferences };
var queue = window.__privacyQueue || []; window.__privacyQueue = [];
for (var q = 0; q < queue.length; q++) try { queue[q](window.privacyBanner); } catch (e) {}
fab();
})();`;

export const bannerScript = BANNER;
export const bannerVersion = crypto.createHash('sha1').update(BANNER).digest('hex').slice(0, 12);

/** The <head> part: the config, and the Customer Privacy API. */
export function privacyHead(config: PrivacyClientConfig): string {
  const json = JSON.stringify(config).replace(/</g, '\\u003c');
  return `<script>window.__privacyConfig=${json};</script>\n<script>${CORE}</script>`;
}

export function privacyClientConfig(input: {
  region: PrivacyRegion;
  settings: PrivacySettings;
  policyVersion: number;
  copy: PrivacyCopy;
  root: string;
  privacyPolicyUrl: string | null;
}): PrivacyClientConfig {
  const { region, settings, copy } = input;
  const root = input.root.endsWith('/') ? input.root : `${input.root}/`;
  return {
    v: 1,
    region: region.country ?? '',
    consentRequired: region.consentRequired,
    saleOptOut: region.saleOptOut,
    honorGpc: settings.honor_gpc,
    maxAgeDays: settings.consent_max_age_days,
    reprompt: settings.reprompt_on_policy_change,
    policyVersion: input.policyVersion,
    endpoint: '/privacy/consent',
    bannerSrc: `/cdn/privacy/${bannerVersion}/banner.js`,
    root,
    position: settings.banner_position,
    colors: settings.banner_colors,
    links: {
      privacyPolicy: input.privacyPolicyUrl ? `${root}${input.privacyPolicyUrl.replace(/^\//, '')}` : null,
      choices: region.saleOptOut ? `${root}pages/data-sharing-opt-out` : null,
      request: settings.request_form_enabled ? `${root}privacy/request` : null,
    },
    copy: {
      title: copy.title,
      message: copy.message,
      accept: copy.accept,
      decline: copy.decline,
      manage: copy.manage,
      save: copy.save,
      close: copy.close,
      privacy_policy: copy.privacy_policy,
      preferences_title: copy.preferences_title,
      preferences_intro: copy.preferences_intro,
      always_on: copy.always_on,
      essential_title: copy.essential_title,
      essential_description: copy.essential_description,
      preferences_category_title: copy.preferences_category_title,
      preferences_category_description: copy.preferences_category_description,
      analytics_title: copy.analytics_title,
      analytics_description: copy.analytics_description,
      marketing_title: copy.marketing_title,
      marketing_description: copy.marketing_description,
      sale_title: copy.sale_title,
      sale_description: copy.sale_description,
      cookie_preferences_link: copy.cookie_preferences_link,
      saved: copy.saved,
    },
  };
}
