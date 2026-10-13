/* eslint-disable @typescript-eslint/no-explicit-any */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { messagingService } from '../../modules/messaging/messaging.service';
import { shopAuthService, verifyCustomerAccessToken } from '../../modules/shop-auth/shopAuth.service';
import { regionCodeFor } from '../geo/regions';
import { shopPhone } from '../geo/phone';
import { markets } from '../markets/markets';
import { privacyRequests, REQUEST_TYPES, type RequestType } from '../privacy/privacyRequests';
import { tenancy } from '../tenancy/context';
import { customerAccountRepository, type AddressInput } from './customerAccount.repository';
import { loadCustomer, loadOrder, sampleCustomer } from './customerDrops';
import { customerSession } from './customerSession';
import { onlineStorePreferences } from './preferences';
import { locals, notFound, page, safeReturn } from './storefrontHttp';
import type { RenderEnv } from './engine/types';

/**
 * Customer accounts on the Online Store — Shopify's /account pages, rendered
 * from the theme's templates/customers/*:
 *
 *   GET  /account/login      customers/login     phone → one-time code → signed in
 *   POST /account/login      form 'customer_login' (customer[phone], then customer[code])
 *   GET  /account/register   customers/register  name, email and phone, then the same code
 *   POST /account            form 'create_customer'
 *   GET  /account            customers/account   orders and the default address
 *   POST /account/profile    form 'customer_profile'
 *   GET  /account/orders/:id customers/order
 *   GET  /account/addresses  customers/addresses
 *   POST /account/addresses[/:id]  form 'customer_address' (_method=delete removes)
 *   GET  /account/logout
 *
 * Passwordless, like Shopify's current customer accounts: the phone number is
 * the identity (as it is for orders — a checkout with the same number is the
 * same customer, so past guest orders are already there when they sign in).
 */

export const customerAccountRoutes = Router();

type Forms = RenderEnv['forms'];

const phoneSchema = shopPhone();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const loginLimit = rateLimit({ bucket: 'shop.account.login', max: 20, windowSeconds: 600, blockSeconds: 900 });
const accountLimit = rateLimit({ bucket: 'shop.account.forms', max: 60, windowSeconds: 600 });

const meta = (req: Request) => ({ ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null });
const text = (value: unknown, max: number) => (typeof value === 'string' ? value.trim().slice(0, max) : '');

// ── the switch, and who is signed in ───────────────────────────────────────

customerAccountRoutes.use('/account', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { customer_accounts: mode } = await onlineStorePreferences.get();
    if (mode === 'disabled' && !locals(res).design) {
      if (req.method === 'GET') return res.redirect(302, '/');
      return notFound(req, res, next);
    }
    next();
  } catch (error) {
    next(error);
  }
});

/** The account pages need a signed-in shopper; in the theme editor, a sample one stands in. */
async function signedIn(req: Request, res: Response): Promise<any | 'sample' | null> {
  const id = locals(res).customerId;
  if (id) {
    const customer = await loadCustomer(id);
    if (customer) return customer;
  }
  if (locals(res).design) return 'sample';
  const back = req.originalUrl.startsWith('/account/login') ? '/account' : req.originalUrl;
  res.redirect(302, `/account/login?return_url=${encodeURIComponent(back)}`);
  return null;
}

// ── signing in ─────────────────────────────────────────────────────────────

function loginForm(req: Request, errors: string[] | null = null, extra: Record<string, unknown> = {}): Forms {
  const pending = customerSession.pending(req);
  const codeStep = Boolean(pending) && (req.query.step === 'code' || extra.step === 'code');
  return {
    customer_login: {
      posted_successfully: false,
      errors,
      step: codeStep ? 'code' : 'phone',
      sent_to: codeStep ? pending!.sentTo : null,
      channel: codeStep ? pending!.channel : null,
      resend_in: codeStep ? Math.max(0, Math.ceil((pending!.resendAt - Date.now()) / 1000)) : 0,
      return_to: pending?.returnTo ?? safeReturn(req.query.return_url, '/account'),
      ...extra,
    },
  };
}

customerAccountRoutes.get('/account/login', async (req, res, next) => {
  if (locals(res).customerId && !locals(res).design) return res.redirect(302, safeReturn(req.query.return_url, '/account'));
  // A fresh visit to the sign-in page (not the code step) forgets a half-finished sign-in.
  if (req.query.step !== 'code' && customerSession.pending(req)) customerSession.clearPending(res);
  const forms = req.query.step === 'code' ? loginForm(req) : { customer_login: { ...loginForm(req).customer_login, step: 'phone' } };
  await page(req, res, next, { template: 'customers/login', title: 'Account' }, forms);
});

/** Sends a code and remembers the sign-in in progress; the caller redirects to the code step. */
async function sendCode(req: Request, res: Response, input: { phone: string; channel: 'sms' | 'whatsapp'; returnTo: string; profile?: any }) {
  const sent = await shopAuthService.requestOtp({ phone: input.phone, channel: input.channel }, meta(req));
  customerSession.setPending(res, {
    requestId: sent.request_id,
    sentTo: sent.sent_to,
    channel: input.channel,
    phone: input.phone,
    returnTo: input.returnTo,
    resendAt: Date.now() + sent.resend_after * 1000,
    profile: input.profile,
  });
}

customerAccountRoutes.post('/account/login', loginLimit, async (req, res, next) => {
  const body = req.body ?? {};
  const fields = (body.customer ?? {}) as Record<string, unknown>;
  try {
    const pending = customerSession.pending(req);

    // "Send a new code" on the code step.
    if (fields.resend !== undefined && pending) {
      if (pending.resendAt > Date.now()) {
        return page(req, res, next, { template: 'customers/login', title: 'Account' }, loginForm(req, [`You can ask for a new code in ${Math.ceil((pending.resendAt - Date.now()) / 1000)} seconds.`], { step: 'code' }), 429);
      }
      await sendCode(req, res, { phone: pending.phone, channel: pending.channel, returnTo: pending.returnTo, profile: pending.profile });
      return res.redirect(303, '/account/login?step=code');
    }

    // The code.
    if (fields.code !== undefined) {
      if (!pending) {
        return page(req, res, next, { template: 'customers/login', title: 'Account' }, loginForm(req, ['That code has expired. Enter your number to get a new one.']), 422);
      }
      const code = text(fields.code, 12).replace(/\s+/g, '');
      if (!/^\d{4,8}$/.test(code)) {
        return page(req, res, next, { template: 'customers/login', title: 'Account' }, loginForm(req, ['Enter the code from the message.'], { step: 'code' }), 422);
      }
      let result: Awaited<ReturnType<typeof shopAuthService.verifyOtp>>;
      try {
        result = await shopAuthService.verifyOtp({ request_id: pending.requestId, code, session_token: locals(res).cartToken }, meta(req));
      } catch (error) {
        if (!(error instanceof ApiError) || error.status >= 500) throw error;
        return page(req, res, next, { template: 'customers/login', title: 'Account' }, loginForm(req, [error.message], { step: 'code' }), 422);
      }
      const claims = verifyCustomerAccessToken(result.access_token);
      const customerId = Number(claims.sub);
      if (pending.profile) await applyProfile(req, customerId, pending.profile, result.is_new_account);
      customerSession.start(res, tenancy.current().id, customerId, Number(claims.sid));
      customerSession.clearPending(res);
      locals(res).customerId = customerId;
      return res.redirect(303, safeReturn(pending.returnTo, '/account'));
    }

    // The number.
    const parsed = phoneSchema.safeParse(text(fields.phone ?? fields.email, 24));
    if (!parsed.success) {
      return page(req, res, next, { template: 'customers/login', title: 'Account' }, loginForm(req, [parsed.error.issues[0]?.message ?? 'Enter a valid mobile number.'], { step: 'phone' }), 422);
    }
    const channel = fields.channel === 'whatsapp' ? 'whatsapp' : 'sms';
    await sendCode(req, res, { phone: parsed.data, channel, returnTo: safeReturn(body.return_to, '/account') });
    res.redirect(303, '/account/login?step=code');
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      return page(req, res, next, { template: 'customers/login', title: 'Account' }, loginForm(req, [error.message], { step: 'phone' }), error.status === 429 ? 429 : 422);
    }
    next(error);
  }
});

/**
 * The name and email typed at sign-up, applied once the code checks out.
 * Only fills blanks on an existing account — someone signing up with a number
 * that already has orders must not be able to rename that customer.
 */
async function applyProfile(req: Request, customerId: number, profile: NonNullable<ReturnType<typeof customerSession.pending>>['profile'], isNew: boolean) {
  if (!profile) return;
  const current = await customerAccountRepository.customer(customerId);
  if (!current) return;
  const changes: Parameters<typeof customerAccountRepository.updateProfile>[1] = {};
  if (profile.first_name && (isNew || !current.first_name)) changes.first_name = profile.first_name;
  if (profile.last_name && (isNew || !current.last_name)) changes.last_name = profile.last_name;
  if (profile.email && !current.email && !(await customerAccountRepository.emailTaken(profile.email, customerId))) changes.email = profile.email;
  await customerAccountRepository.updateProfile(customerId, changes);
  if (profile.accepts_marketing && (changes.email || current.email)) {
    await setEmailMarketing(req, customerId, (changes.email ?? current.email)!, true, 'signup');
  }
}

async function setEmailMarketing(req: Request, customerId: number, email: string, granted: boolean, source: string) {
  await messagingService.setMarketingConsent({ customerId, subjectIdentifier: email, channel: 'email', granted, source, ...meta(req), evidence: { asked: 'online store account form', granted } });
  await customerAccountRepository.updateProfile(customerId, { accepts_email_marketing: granted });
}

// ── signing up ─────────────────────────────────────────────────────────────

customerAccountRoutes.get('/account/register', async (req, res, next) => {
  if (locals(res).customerId && !locals(res).design) return res.redirect(302, '/account');
  await page(req, res, next, { template: 'customers/register', title: 'Create account' }, { create_customer: { posted_successfully: false, errors: null } });
});

customerAccountRoutes.post('/account', loginLimit, async (req, res, next) => {
  const fields = (req.body?.customer ?? {}) as Record<string, unknown>;
  const values = {
    first_name: text(fields.first_name, 80),
    last_name: text(fields.last_name, 80),
    email: text(fields.email, 191).toLowerCase(),
    phone: text(fields.phone, 24),
    accepts_marketing: fields.accepts_marketing === 'true' || fields.accepts_marketing === 'on' || fields.accepts_marketing === '1',
  };
  const errors: string[] = [];
  if (!values.first_name) errors.push('Enter your first name.');
  if (values.email && !EMAIL.test(values.email)) errors.push('Enter a valid email address.');
  const phone = phoneSchema.safeParse(values.phone);
  if (!phone.success) errors.push(phone.error.issues[0]?.message ?? 'Enter a valid mobile number.');
  const again = (messages: string[], status: number) =>
    page(req, res, next, { template: 'customers/register', title: 'Create account' }, { create_customer: { posted_successfully: false, errors: messages, values } }, status);
  if (errors.length) return again(errors, 422);
  try {
    await sendCode(req, res, {
      phone: phone.data!,
      channel: fields.channel === 'whatsapp' ? 'whatsapp' : 'sms',
      returnTo: safeReturn(req.body?.return_to, '/account'),
      profile: { first_name: values.first_name, last_name: values.last_name || null, email: values.email || null, accepts_marketing: values.accepts_marketing },
    });
    res.redirect(303, '/account/login?step=code');
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) return again([error.message], error.status === 429 ? 429 : 422);
    next(error);
  }
});

// ── signing out ────────────────────────────────────────────────────────────

customerAccountRoutes.get('/account/logout', async (req, res, next) => {
  try {
    const sessionId = locals(res).customerSessionId;
    if (sessionId) await shopAuthService.logout(sessionId);
    customerSession.clear(res);
    res.redirect(302, safeReturn(req.query.return_url, '/'));
  } catch (error) {
    next(error);
  }
});

// Passwords do not exist here; Shopify's password pages lead to signing in.
customerAccountRoutes.get(['/account/activate*', '/account/reset*', '/account/recover'], (_req, res) => res.redirect(302, '/account/login'));

// ── the account ────────────────────────────────────────────────────────────

customerAccountRoutes.get('/account', async (req, res, next) => {
  try {
    const customer = await signedIn(req, res);
    if (!customer) return;
    // A privacy request just made from this page: its reference, for the confirmation.
    const privacyRequest = typeof req.query.privacy_request === 'string' && /^PR-[A-Z0-9]{8}$/.test(req.query.privacy_request) ? req.query.privacy_request : null;
    const objects = customer === 'sample' ? { customer: sampleCustomer(locals(res).market.currency).customer } : { customer, privacy_request: privacyRequest };
    const updated = req.query.profile_updated === 'true';
    await page(req, res, next, { template: 'customers/account', title: 'Account', objects }, { customer_profile: { posted_successfully: updated, errors: null } });
  } catch (error) {
    next(error);
  }
});

customerAccountRoutes.post('/account/profile', accountLimit, async (req, res, next) => {
  try {
    const customerId = locals(res).customerId;
    if (!customerId) return res.redirect(303, '/account/login');
    const fields = (req.body?.customer ?? {}) as Record<string, unknown>;
    const email = text(fields.email, 191).toLowerCase();
    const errors: string[] = [];
    if (!text(fields.first_name, 80)) errors.push('Enter your first name.');
    if (email && !EMAIL.test(email)) errors.push('Enter a valid email address.');
    if (email && (await customerAccountRepository.emailTaken(email, customerId))) errors.push('That email address belongs to another account.');
    if (errors.length) {
      const customer = await loadCustomer(customerId);
      return page(req, res, next, { template: 'customers/account', title: 'Account', objects: { customer } }, { customer_profile: { posted_successfully: false, errors } }, 422);
    }
    const current = await customerAccountRepository.customer(customerId);
    await customerAccountRepository.updateProfile(customerId, { first_name: text(fields.first_name, 80), last_name: text(fields.last_name, 80) || null, email: email || null });
    const wants = fields.accepts_marketing === 'true' || fields.accepts_marketing === 'on' || fields.accepts_marketing === '1';
    if (email && current && wants !== (current.accepts_email_marketing === 1)) await setEmailMarketing(req, customerId, email, wants, 'preference_center');
    res.redirect(303, '/account?profile_updated=true');
  } catch (error) {
    next(error);
  }
});

/**
 * "Your data and privacy" on the account page: download my data, stop
 * marketing, delete my account. The session proves who is asking, so the
 * request is verified from the start; staff handle it in Customers →
 * Consents & privacy, and the customer is emailed as it moves.
 */
customerAccountRoutes.post('/account/privacy', accountLimit, async (req, res, next) => {
  try {
    const customerId = locals(res).customerId;
    if (!customerId) return res.redirect(303, '/account/login');
    const type = String(req.body?.request_type ?? '') as RequestType;
    if (!REQUEST_TYPES.includes(type)) return res.redirect(303, '/account#privacy');
    const current = await customerAccountRepository.customer(customerId);
    const created = await privacyRequests.create({
      type,
      source: 'account',
      contact: current?.email || current?.phone || '',
      customerId,
      details: text(req.body?.details, 2000) || null,
      country: locals(res).privacy?.country ?? null,
      verified: true,
    });
    res.redirect(303, `/account?privacy_request=${encodeURIComponent(created.request.reference)}#privacy`);
  } catch (error) {
    next(error);
  }
});

customerAccountRoutes.get('/account/orders/:reference', async (req, res, next) => {
  try {
    const customer = await signedIn(req, res);
    if (!customer) return;
    if (customer === 'sample') {
      const sample = sampleCustomer(locals(res).market.currency);
      return page(req, res, next, { template: 'customers/order', title: `Order ${sample.order.name}`, objects: sample });
    }
    const reference = String(req.params.reference).slice(0, 40);
    const order = await loadOrder(locals(res).customerId!, reference);
    if (!order) return notFound(req, res, next);
    await page(req, res, next, { template: 'customers/order', title: `Order ${order.name}`, objects: { customer, order } });
  } catch (error) {
    next(error);
  }
});

// ── the address book ───────────────────────────────────────────────────────

async function addressesPage(req: Request, res: Response, next: NextFunction, forms: Forms = {}, status = 200) {
  const customer = await signedIn(req, res);
  if (!customer) return;
  const objects = customer === 'sample' ? { customer: sampleCustomer(locals(res).market.currency).customer } : { customer };
  await page(req, res, next, { template: 'customers/addresses', title: 'Addresses', objects }, { customer_address: { posted_successfully: req.query.saved === 'true', errors: null }, ...forms }, status);
}

customerAccountRoutes.get('/account/addresses', (req, res, next) => addressesPage(req, res, next).catch(next));

/** The Shopify address form's fields, checked. */
async function readAddress(body: Record<string, unknown>, fallbackPhone: string): Promise<{ input: AddressInput; errors: string[] }> {
  const field = (name: string, max: number) => text(body[name], max);
  const shop = tenancy.current();
  const catalogue = await markets.catalogue().catch(() => [] as { country: string }[]);
  let country = field('country', 60).toUpperCase();
  if (!/^[A-Z]{2}$/.test(country)) {
    // A theme written for Shopify posts the country's name.
    const byName = catalogue.find((entry) => {
      try {
        return new Intl.DisplayNames(['en'], { type: 'region' }).of(entry.country)?.toUpperCase() === country;
      } catch {
        return false;
      }
    });
    country = byName?.country ?? shop.countryCode;
  }
  const province = field('province', 80);
  const input: AddressInput = {
    first_name: field('first_name', 80),
    last_name: field('last_name', 80) || null,
    phone: field('phone', 15).replace(/[^\d]/g, '').slice(-15) || fallbackPhone,
    line1: field('address1', 255),
    line2: field('address2', 255) || null,
    landmark: field('landmark', 120) || null,
    city: field('city', 80),
    state: province,
    state_code: regionCodeFor(country, province),
    pincode: field('zip', 16),
    country,
  };
  const errors: string[] = [];
  if (!input.first_name) errors.push('Enter a first name.');
  if (!input.line1) errors.push('Enter an address.');
  if (!input.city) errors.push('Enter a city.');
  if (!input.state) errors.push('Enter a state or province.');
  if (!input.pincode) errors.push('Enter a PIN or postal code.');
  if (catalogue.length && !catalogue.some((entry) => entry.country === country)) errors.push('This store does not deliver to that country.');
  return { input, errors };
}

customerAccountRoutes.post(['/account/addresses', '/account/addresses/:id'], accountLimit, async (req, res, next) => {
  try {
    const customerId = locals(res).customerId;
    if (!customerId) return res.redirect(303, '/account/login?return_url=%2Faccount%2Faddresses');
    const id = req.params.id ? Number(req.params.id) : null;
    if (req.params.id && !Number.isInteger(id)) return notFound(req, res, next);
    const body = req.body ?? {};
    if (id && String(body._method ?? '').toLowerCase() === 'delete') {
      await customerAccountRepository.removeAddress(customerId, id);
      return res.redirect(303, '/account/addresses');
    }
    const customer = await customerAccountRepository.customer(customerId);
    const { input, errors } = await readAddress((body.address ?? {}) as Record<string, unknown>, customer?.phone ?? '');
    if (errors.length) {
      return addressesPage(req, res, next, { customer_address: { posted_successfully: false, errors, address_id: id } }, 422);
    }
    const makeDefault = ['1', 'true', 'on'].includes(String((body.address ?? {}).default ?? ''));
    if (id) {
      const updated = await customerAccountRepository.updateAddress(customerId, id, input, makeDefault);
      if (!updated) return notFound(req, res, next);
    } else {
      await customerAccountRepository.addAddress(customerId, input, makeDefault);
    }
    res.redirect(303, '/account/addresses?saved=true');
  } catch (error) {
    logger.warn('online_store.address_failed', { error: String(error) });
    next(error);
  }
});
