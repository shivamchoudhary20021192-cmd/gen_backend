import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { queryOne, type RowDataPacket } from '../../db/pool';
import { cookies, locals, notFound, page, requestHost, setCookie } from '../onlineStore/storefrontHttp';
import { shopId, tenancy } from '../tenancy/context';
import { CONSENT_COOKIE, newConsentId, parseConsent, serializeConsent, type ConsentMethod, type TrackingConsent } from './consentCookie';
import { policies } from './policies';
import { privacyCopy, type PrivacyCopy } from './privacyCopy';
import { privacyRequests, REQUEST_TYPES, type RequestType } from './privacyRequests';
import { bannerScript, bannerVersion } from './privacyRuntime';
import { privacySettings } from './privacySettings';
import { classifyRegion, countryFromHeaders } from './regions';
import { trackingConsents } from './trackingConsents';

/**
 * The storefront side of customer privacy:
 *
 *   (middleware)                   which rules apply to this visitor — their
 *                                  country from the edge, else the market's
 *   GET  /cdn/privacy/:v/banner.js the banner and preferences dialog (cached forever; the version is its hash)
 *   POST /privacy/consent          a choice, from the banner or setTrackingConsent(): recorded, and the cookie set
 *   GET  /policies/:handle         the store's policies, in the theme's layout
 *   GET  /pages/data-sharing-opt-out  "Your privacy choices" (Shopify's path), and POST /privacy/opt-out without JS
 *   GET  /privacy/request          ask to see, correct or erase your data; POST sends a confirmation link
 *   GET  /privacy/request/verify   the link: confirms the request is the requester's
 *   GET  /privacy/exports/:token   the data file an access request produced
 */
export const privacyStorefrontRoutes = Router();

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function language(res: Response): string {
  return locals(res).locale?.code || tenancy.current().locale || 'en';
}

async function copyFor(res: Response): Promise<PrivacyCopy> {
  return privacyCopy(language(res), (await privacySettings.get()).banner_copy);
}

/** The rules for this visitor: set before the page cache, which keys pages by them. */
export async function privacyContext(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const settings = await privacySettings.get();
    const country = countryFromHeaders((name) => req.get(name)) ?? locals(res).market?.country ?? tenancy.current().countryCode;
    locals(res).privacy = classifyRegion(country, settings);
    next();
  } catch (error) {
    next(error);
  }
}

const PAGE_STYLE = `<style>
.shopify-policy__container{max-width:48rem;margin:0 auto;padding:48px 16px 64px}
.shopify-policy__title h1{margin:0 0 24px}
.shopify-policy__body h2{margin:32px 0 8px;font-size:1.25em}
.shopify-policy__body table{width:100%;border-collapse:collapse;margin:16px 0}
.shopify-policy__body th,.shopify-policy__body td{border:1px solid rgba(0,0,0,.15);padding:8px 10px;text-align:left;vertical-align:top}
.vl-privacy-form{display:grid;gap:16px;margin:24px 0}
.vl-privacy-form label{display:grid;gap:6px;font-weight:600}
.vl-privacy-form input[type=email],.vl-privacy-form textarea{font:inherit;padding:10px 12px;border:1px solid rgba(0,0,0,.3);border-radius:6px;width:100%}
.vl-privacy-form fieldset{border:0;padding:0;margin:0;display:grid;gap:8px}
.vl-privacy-form fieldset label{display:flex;gap:8px;font-weight:400;align-items:center}
.vl-privacy-note{padding:12px 16px;border-radius:8px;background:rgba(0,0,0,.05)}
.vl-privacy-actions{display:flex;flex-wrap:wrap;gap:12px;margin:20px 0}
.vl-hp{position:absolute!important;left:-10000px!important;width:1px;height:1px;overflow:hidden}
</style>`;

function frame(title: string, body: string): string {
  return `${PAGE_STYLE}<div class="shopify-policy__container page-width"><div class="shopify-policy__title"><h1>${esc(title)}</h1></div><div class="shopify-policy__body"><div class="rte">${body}</div></div></div>`;
}

async function builtIn(req: Request, res: Response, next: NextFunction, title: string, body: string, status = 200): Promise<void> {
  await page(req, res, next, { template: 'policy', title, content: frame(title, body) }, {}, status);
}

// ── the banner's file ───────────────────────────────────────────────────────

privacyStorefrontRoutes.get('/cdn/privacy/:version/banner.js', (req: Request, res: Response) => {
  // Any version is served the current script; only the current one is cached for long.
  res.setHeader('Cache-Control', req.params.version === bannerVersion ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
  res.type('application/javascript').send(bannerScript);
});

// ── recording a choice ──────────────────────────────────────────────────────

const METHODS: ConsentMethod[] = ['accept_all', 'reject_all', 'custom', 'opt_out_page', 'gpc', 'api'];

async function recordChoice(req: Request, res: Response, input: { analytics?: boolean; marketing?: boolean; preferences?: boolean; sale_of_data?: boolean; method: ConsentMethod; gpc: boolean; page: string | null }): Promise<TrackingConsent> {
  const settings = await privacySettings.get();
  const region = locals(res).privacy ?? classifyRegion(tenancy.current().countryCode, settings);
  const existing = parseConsent(cookies(req)[CONSENT_COOKIE]);
  const gpc = settings.honor_gpc && input.gpc;
  // A purpose not mentioned keeps its current value: the stored choice, else the region's default.
  const fallback = (key: 'analytics' | 'marketing' | 'preferences' | 'sale_of_data') => (existing ? existing.purposes[key] : !region.consentRequired);
  const pick = (key: 'analytics' | 'marketing' | 'preferences' | 'sale_of_data') => (typeof input[key] === 'boolean' ? input[key]! : fallback(key));
  const consent: TrackingConsent = {
    id: existing?.id && existing.id !== '00000000-0000-4000-8000-000000000000' ? existing.id : newConsentId(),
    ts: Math.floor(Date.now() / 1000),
    purposes: { analytics: pick('analytics'), marketing: pick('marketing'), preferences: pick('preferences'), sale_of_data: pick('sale_of_data') && !gpc },
    policyVersion: await policies.privacyVersion(),
    method: input.method,
    gpc,
  };
  await trackingConsents.record({
    consent,
    customerId: locals(res).customerId,
    region,
    locale: language(res),
    pagePath: input.page,
    ip: clientIp(req),
    userAgent: req.get('user-agent') ?? null,
  });
  // Readable by scripts: the Customer Privacy API reads it. It identifies no one.
  setCookie(res, CONSENT_COOKIE, decodeURIComponent(serializeConsent(consent)), settings.consent_max_age_days * 86_400, false);
  return consent;
}

privacyStorefrontRoutes.post(
  '/privacy/consent',
  rateLimit({ bucket: 'storefront.consent', max: 40, windowSeconds: 600 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      // Only the store's own pages may record a choice: a cross-site page must
      // not accept (or refuse) on a visitor's behalf. JSON also forces a CORS
      // preflight on any cross-origin attempt.
      const origin = req.get('origin');
      if (origin && origin !== `${req.protocol}://${requestHost(req)}`) {
        res.status(403).json({ error: 'cross_origin' });
        return;
      }
      if (!req.is('application/json')) {
        res.status(415).json({ error: 'json_required' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const flag = (value: unknown) => (typeof value === 'boolean' ? value : undefined);
      const method = METHODS.includes(body.method as ConsentMethod) ? (body.method as ConsentMethod) : 'api';
      const consent = await recordChoice(req, res, {
        analytics: flag(body.analytics),
        marketing: flag(body.marketing),
        preferences: flag(body.preferences),
        sale_of_data: flag(body.sale_of_data),
        method,
        gpc: req.get('sec-gpc') === '1' || body.gpc === true,
        page: typeof body.page === 'string' ? body.page.slice(0, 255) : null,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ consent: { id: consent.id, ...consent.purposes, policy_version: consent.policyVersion, method: consent.method, gpc: consent.gpc } });
    } catch (error) {
      next(error);
    }
  },
);

// ── policies ────────────────────────────────────────────────────────────────

privacyStorefrontRoutes.get('/policies/:handle', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const policy = await policies.byHandle(String(req.params.handle));
    if (!policy) return notFound(req, res, next);
    await page(req, res, next, { template: 'policy', title: policy.title, content: frame(policy.title, policy.body), handle: policy.handle });
  } catch (error) {
    next(error);
  }
});

// ── "Your privacy choices" (the US opt-out of sale and sharing) ────────────

privacyStorefrontRoutes.get('/pages/data-sharing-opt-out', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await privacySettings.get();
    if (!settings.sale_opt_out_enabled) return next();
    const t = await copyFor(res);
    const privacy = await policies.get('privacy');
    const saved = req.query.opted === 'out' ? t.choices_opted_out : req.query.opted === 'in' ? t.choices_opted_in : '';
    const body = `<p>${esc(t.choices_intro)}</p>
<p class="vl-privacy-note" data-privacy-status role="status">${esc(saved)}</p>
${settings.honor_gpc ? `<p data-privacy-gpc hidden>${esc(t.choices_gpc)}</p>` : ''}
<form method="post" action="/privacy/opt-out" class="vl-privacy-actions" data-privacy-optout>
  <button class="button" type="submit" name="choice" value="opt_out">${esc(t.choices_opt_out)}</button>
  <button class="button button--secondary" type="submit" name="choice" value="opt_in">${esc(t.choices_opt_in)}</button>
</form>
${settings.request_form_enabled ? `<p>${esc(t.choices_request)} <a href="/privacy/request">${esc(t.request_title)}</a></p>` : ''}
${privacy ? `<p><a href="${privacy.url}">${esc(t.privacy_policy)}</a></p>` : ''}
<script>(function(){
  var out = ${JSON.stringify(t.choices_opted_out)}, inn = ${JSON.stringify(t.choices_opted_in)};
  function show(){ var p = window.Shopify && window.Shopify.customerPrivacy; if (!p) return;
    var s = document.querySelector('[data-privacy-status]'); if (s) s.textContent = p.saleOfDataAllowed() ? inn : out;
    var g = document.querySelector('[data-privacy-gpc]'); if (g && navigator.globalPrivacyControl === true) g.hidden = false; }
  document.addEventListener('visitorConsentCollected', show);
  var f = document.querySelector('[data-privacy-optout]');
  if (f) f.addEventListener('submit', function(e){ var p = window.Shopify && window.Shopify.customerPrivacy; if (!p) return; e.preventDefault();
    var allow = e.submitter && e.submitter.value === 'opt_in'; p.setTrackingConsent({ sale_of_data: allow }, show, 'opt_out_page'); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', show); else show();
})();</script>`;
    await builtIn(req, res, next, t.choices_title, body);
  } catch (error) {
    next(error);
  }
});

privacyStorefrontRoutes.post(
  '/privacy/opt-out',
  rateLimit({ bucket: 'storefront.consent', max: 40, windowSeconds: 600 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const allow = String(req.body?.choice ?? '') === 'opt_in';
      await recordChoice(req, res, { sale_of_data: allow, method: 'opt_out_page', gpc: req.get('sec-gpc') === '1', page: '/pages/data-sharing-opt-out' });
      res.redirect(303, `/pages/data-sharing-opt-out?opted=${allow ? 'in' : 'out'}`);
    } catch (error) {
      next(error);
    }
  },
);

// ── privacy requests ────────────────────────────────────────────────────────

async function signedInContact(res: Response): Promise<{ email: string | null; phone: string | null } | null> {
  const customerId = locals(res).customerId;
  if (!customerId) return null;
  return queryOne<RowDataPacket & { email: string | null; phone: string | null }>('SELECT email, phone FROM customers WHERE shop_id = ? AND id = ?', [shopId(), customerId]);
}

async function grievanceLine(): Promise<string> {
  const settings = await privacySettings.get();
  const name = settings.grievance_officer_name;
  const email = settings.grievance_officer_email ?? settings.privacy_email;
  if (!name && !email) return '';
  return `<p><strong>Grievance officer:</strong> ${esc([name, email ? `<${email}>` : null].filter(Boolean).join(' '))}${settings.grievance_officer_phone ? `, ${esc(settings.grievance_officer_phone)}` : ''}</p>`;
}

privacyStorefrontRoutes.get('/privacy/request', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const settings = await privacySettings.get();
    if (!settings.request_form_enabled) return notFound(req, res, next);
    const t = await copyFor(res);
    const signedIn = await signedInContact(res);
    const notice = req.query.sent === '1' ? t.request_sent : req.query.confirmed === '1' ? t.request_verified : '';
    const types = REQUEST_TYPES.map(
      (type, index) => `<label><input type="radio" name="request_type" value="${type}"${index === 0 ? ' checked' : ''}> ${esc(t.request_types[type])}</label>`,
    ).join('\n');
    const body = `<p>${esc(t.request_intro)}</p>
${notice ? `<p class="vl-privacy-note" role="status">${esc(notice)}</p>` : ''}
<form method="post" action="/privacy/request" class="vl-privacy-form">
  <label>${esc(t.request_email)}<input type="email" name="email" required maxlength="191" autocomplete="email" value="${esc(signedIn?.email ?? '')}"></label>
  <fieldset><legend><strong>${esc(t.request_type)}</strong></legend>${types}</fieldset>
  <label>${esc(t.request_details)}<textarea name="details" rows="4" maxlength="4000"></textarea></label>
  <label class="vl-hp" aria-hidden="true">Website<input type="text" name="website" tabindex="-1" autocomplete="off"></label>
  <div><button class="button" type="submit">${esc(t.request_submit)}</button></div>
</form>
${signedIn ? '' : `<p>${esc(t.request_account_hint)} <a href="/account">/account</a></p>`}
${await grievanceLine()}`;
    await builtIn(req, res, next, t.request_title, body);
  } catch (error) {
    next(error);
  }
});

privacyStorefrontRoutes.post(
  '/privacy/request',
  rateLimit({ bucket: 'storefront.privacy_request', max: 5, windowSeconds: 900, blockSeconds: 900 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const settings = await privacySettings.get();
      if (!settings.request_form_enabled) return notFound(req, res, next);
      const body = (req.body ?? {}) as Record<string, unknown>;
      // A filled honeypot is a bot: answer as if it worked, do nothing.
      if (typeof body.website === 'string' && body.website.trim()) return res.redirect(303, '/privacy/request?sent=1');
      const email = String(body.email ?? '').trim().toLowerCase();
      const type = REQUEST_TYPES.includes(body.request_type as RequestType) ? (body.request_type as RequestType) : null;
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 191 || !type) return res.redirect(303, '/privacy/request');
      const signedIn = await signedInContact(res);
      // Signed in, asking about their own account: who they are is already proven.
      const own = Boolean(signedIn && signedIn.email && signedIn.email.toLowerCase() === email);
      await privacyRequests.create({
        type,
        source: own ? 'account' : 'storefront',
        contact: email,
        customerId: own ? locals(res).customerId : null,
        details: typeof body.details === 'string' ? body.details : null,
        country: locals(res).privacy?.country ?? null,
        verified: own,
      });
      // The same answer whether or not the address is a customer's: no one learns who shops here.
      res.redirect(303, own ? '/privacy/request?confirmed=1' : '/privacy/request?sent=1');
    } catch (error) {
      next(error);
    }
  },
);

privacyStorefrontRoutes.get('/privacy/request/verify', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const t = await copyFor(res);
    const token = typeof req.query.token === 'string' ? req.query.token : '';
    const verified = await privacyRequests.verify(token);
    res.setHeader('Cache-Control', 'no-store');
    await builtIn(req, res, next, t.request_title, `<p class="vl-privacy-note" role="status">${esc(verified ? t.request_verified : t.request_invalid)}</p>${verified ? `<p>Reference: <strong>${esc(verified.reference)}</strong></p>` : ''}`, verified ? 200 : 410);
  } catch (error) {
    next(error);
  }
});

privacyStorefrontRoutes.get('/privacy/exports/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = await privacyRequests.exportByToken(String(req.params.token));
    if (!file) {
      const t = await copyFor(res);
      return builtIn(req, res, next, t.request_title, `<p class="vl-privacy-note">${esc(t.request_invalid)}</p>`, 410);
    }
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.type('application/json').send(file.content);
  } catch (error) {
    next(error);
  }
});
