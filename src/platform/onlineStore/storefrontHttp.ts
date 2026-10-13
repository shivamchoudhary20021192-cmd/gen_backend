/* eslint-disable @typescript-eslint/no-explicit-any */
import type { PrivacyRegion } from '../privacy/regions';
import type { NextFunction, Request, Response } from 'express';
import { env } from '../../config/env';
import { storefrontService } from '../../modules/storefront/storefront.service';
import type { Market } from '../markets/markets';
import { languageHomes, type HostRoute, type LanguageHome } from '../domains/hostRouting';
import { shopLanguages } from './languages';
import { loadCustomer } from './customerDrops';
import type { LoadedTheme, RenderEnv } from './engine/types';
import { PageRenderer, TemplateMissingError, type PageSpec } from './renderer';

/**
 * What every Online Store route shares: the request's shop-scoped state
 * (theme, market, cart, signed-in customer), cookies, and rendering a page
 * from the theme — or just some of its sections, for the Section Rendering API.
 */

export interface Locals {
  theme: LoadedTheme;
  design: boolean;
  market: Market;
  cartToken: string | null;
  /** The signed-in shopper, from the customer session cookie. */
  customerId: number | null;
  customerSessionId: number | null;
  /** The storefront language: its ISO code and the path prefix it is served under ('' for the host's default). */
  locale: { code: string; prefix: string; hostDefault?: string };
  /** What the hostname means: the shop's domain it came in on, the primary, market domains. */
  hostRoute: HostRoute;
  /** The privacy rules for this visitor's region (banner, sale opt-out): pages are cached by them. */
  privacy?: PrivacyRegion;
}

export const locals = (res: Response) => res.locals as Locals;

// ── cookies ─────────────────────────────────────────────────────────────────

export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.header('Cookie') ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    try {
      out[name] = decodeURIComponent(part.slice(index + 1).trim());
    } catch {
      /* a malformed cookie is ignored, not fatal */
    }
  }
  return out;
}

export function setCookie(res: Response, name: string, value: string, maxAgeSeconds: number | null, httpOnly = true) {
  const secure = env.nodeEnv === 'production' ? '; Secure' : '';
  const age = maxAgeSeconds === null ? '' : `; Max-Age=${maxAgeSeconds}`;
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${httpOnly ? '; HttpOnly' : ''}${secure}${age}`);
}

// ── pages ───────────────────────────────────────────────────────────────────

/**
 * The host the shopper asked for, with its port: behind the edge worker the
 * request arrives addressed to the origin, with the shopper's host in
 * X-Forwarded-Host — trusted exactly as far as Express trusts it for
 * `req.hostname` (the `trust proxy` setting).
 */
export function requestHost(req: Request): string {
  const trust = req.app?.get('trust proxy fn') as ((address: string, hop: number) => boolean) | undefined;
  const forwarded = trust?.(req.socket?.remoteAddress ?? '', 0) ? req.get('x-forwarded-host')?.split(',')[0]?.trim() : undefined;
  return forwarded || req.get('host') || req.hostname;
}

export function requestOf(req: Request) {
  const host = requestHost(req);
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(req.query)) {
    if (typeof value === 'string') query.set(key, value);
  }
  return { path: req.path, query, host, origin: `${req.protocol}://${host}` };
}

export async function currentCart(res: Response): Promise<any | null> {
  const token = locals(res).cartToken;
  if (!token) return null;
  try {
    return (await storefrontService.getCart(token)).cart;
  } catch {
    return null;
  }
}

/** Where each of the store's languages lives, seen from this request's host (language domains, subfolders). */
export async function homesOf(req: Request, res: Response): Promise<Map<string, LanguageHome>> {
  const languages = await shopLanguages.get();
  const route = locals(res).hostRoute;
  const hostDefault = locals(res).locale?.hostDefault ?? languages.primary.code;
  const origin = `${req.protocol}://${requestHost(req)}`;
  // A development host (<handle>.localhost) is not one of the store's domains: every language stays on it.
  if (!route?.domain) return new Map(languages.all.map((language) => [language.code, { origin, prefix: language.code === hostDefault ? '' : `/${language.code}` }]));
  return languageHomes(route, origin, languages.all.map((language) => language.code), languages.primary.code, hostDefault);
}

/** What a PageRenderer needs from this request. */
export async function renderOptions(req: Request, res: Response, forms: RenderEnv['forms'] = {}) {
  return {
    theme: locals(res).theme,
    request: requestOf(req),
    shopper: {
      market: locals(res).market,
      cart: await currentCart(res),
      customer: locals(res).customerId ? await loadCustomer(locals(res).customerId!) : null,
      locale: { ...(locals(res).locale ?? { code: '', prefix: '' }), homes: await homesOf(req, res) },
      privacy: locals(res).privacy ?? null,
    },
    designMode: locals(res).design,
    forms,
  };
}

/** Renders a page, or — with ?sections= / ?section_id= — just those sections. */
export async function page(req: Request, res: Response, next: NextFunction, spec: PageSpec, forms: RenderEnv['forms'] = {}, status = 200): Promise<void> {
  try {
    const view = typeof req.query.view === 'string' && /^[\w-]{1,60}$/.test(req.query.view) ? req.query.view : null;
    // A form posted back here with its result in the query (?contact_posted=true), as Shopify does.
    for (const type of ['contact', 'customer'] as const) {
      const posted = req.query[`${type}_posted`];
      if ((posted === 'true' || posted === 'false') && !forms[type]) {
        forms[type] = { posted_successfully: posted === 'true', errors: posted === 'true' ? null : [type === 'customer' ? 'Enter a valid email address.' : 'Please check your email address and message.'] };
      }
    }
    // A comment posted and redirected back here (?comment_posted=true#comments).
    if (req.query.comment_posted === 'true' && !forms.new_comment) forms.new_comment = { posted_successfully: true, errors: null };
    const renderer = new PageRenderer(await renderOptions(req, res, forms), { ...spec, suffix: view ?? spec.suffix ?? null });
    res.setHeader('Cache-Control', 'private, no-cache');
    const sectionsParam = typeof req.query.sections === 'string' ? req.query.sections : null;
    const sectionId = typeof req.query.section_id === 'string' ? req.query.section_id : null;
    const prefix = locals(res).locale?.prefix ?? '';
    if (sectionsParam) {
      const sections = await renderer.renderSections(sectionsParam.split(',').map((id) => id.trim()).filter(Boolean));
      res.status(status).json(Object.fromEntries(Object.entries(sections).map(([id, html]) => [id, html === null ? null : localizeHtml(html, prefix)])));
      return;
    }
    if (sectionId) {
      const html = (await renderer.renderSections([sectionId]))[sectionId];
      if (html === null) return notFoundText(res);
      res.status(status).type('html').send(localizeHtml(html, prefix));
      return;
    }
    res.status(status).type('html').send(localizeHtml(await renderer.render(), prefix));
  } catch (error) {
    if (error instanceof TemplateMissingError && spec.template !== '404') {
      await notFound(req, res, next);
      return;
    }
    next(error);
  }
}

export async function notFound(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!locals(res).theme.files.has('templates/404.json') && !locals(res).theme.files.has('templates/404.liquid')) {
    notFoundText(res);
    return;
  }
  await page(req, res, next, { template: '404', title: 'Page not found' }, {}, 404);
}

export function notFoundText(res: Response): void {
  res.status(404).type('text').send('Not found');
}

/** A path in a language: '/products/x' → '/hi/products/x' (left alone if it is already, or is not a page). */
export function localizePath(url: string, prefix: string): string {
  if (!prefix || !url.startsWith('/') || url.startsWith('//')) return url;
  if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) return url;
  if (/^\/(cdn|checkouts?|localization|api|media|admin|platform)(\/|$|\?)/.test(url)) return url;
  return url === '/' ? prefix : `${prefix}${url}`;
}

/** Every same-site link and form in a page, in the page's language. */
export function localizeHtml(html: string, prefix: string): string {
  if (!prefix) return html;
  return html.replace(/(\s(?:href|action)=")(\/[^"]*)"/g, (_whole, attr: string, url: string) => `${attr}${localizePath(url, prefix)}"`);
}

/** A same-site path to go back to after a form: `return_to` if it is one, else the fallback. */
export function safeReturn(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\') ? value.slice(0, 500) : fallback;
}
