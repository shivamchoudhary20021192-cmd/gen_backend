/* eslint-disable @typescript-eslint/no-explicit-any */
import bcrypt from 'bcryptjs';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { rateLimit } from '../../middleware/rateLimit';
import { clientIp } from '../../middleware/requestContext';
import { contentPublicService } from '../../modules/content/public/contentPublic.service';
import { newsletterService } from '../../modules/newsletter/newsletter.service';
import { storefrontService } from '../../modules/storefront/storefront.service';
import { storage } from '../../modules/media/storage';
import { MissingRateError } from '../markets/fx';
import { marketContext, markets, type Market } from '../markets/markets';
import { shopDirectory, normaliseHostname } from '../shops/shopDirectory';
import { brandService } from '../shops/brand';
import { shopsRepository } from '../shops/shops.repository';
import { assertServable } from '../tenancy/resolveShop';
import { isValidStorefrontUnlock, issueStorefrontUnlock, TOKEN_TTL_MS } from '../tenancy/storefrontGate';
import { tenancy, type ShopContext } from '../tenancy/context';
import { checkoutPage } from './checkoutPage';
import { routeForShop } from '../domains/hostRouting';
import { themeExtensions } from '../apps/themeExtensions';
import { customerAccountRepository } from './customerAccount.repository';
import { customerAccountRoutes } from './customerAccount.routes';
import { previewFrameAncestors } from './editorBridge';
import { addressDrop } from './customerDrops';
import { customerSession } from './customerSession';
import { onlineStorePreferences } from './preferences';
import {
  articleDrop,
  BlogDrop,
  cartDrop,
  loadCollection,
  loadPage,
  loadProduct,
  ProductDrop,
} from './drops';
import { engineFor } from './engine/engine';
import type { LoadedTheme } from './engine/types';
import { onlineStoreRepository } from './onlineStore.repository';
import { giftCardsService, giftCardUrl, dateOnly, stateOf } from '../../modules/giftCards/giftCards.service';
import { commentHtml, commentsService } from '../../modules/content/comments/comments.service';
import { formatCode } from '../../modules/giftCards/giftCardCodes';
import { pageCache } from './pageCache';
import { privacyContext, privacyStorefrontRoutes } from '../privacy/privacyStorefront';
import { announcementsStorefrontRoutes } from '../../modules/content/announcements/announcements.storefront';
import { verifyPreview } from './previewTokens';
import { PageRenderer } from './renderer';
import { cookies, currentCart, homesOf, locals, localizePath, notFound, notFoundText, page, requestHost, requestOf, safeReturn, setCookie, type Locals } from './storefrontHttp';
import { shopLanguages } from './languages';
import { translationContext } from './translations';
import { themeLoader } from './themeLoader';

/**
 * The Online Store: a shop's storefront rendered on the server from its
 * published theme, on the shop's own domain — Shopify's Online Store channel.
 *
 *   GET  /  /collections  /collections/:handle  /products/:handle  /pages/:handle
 *        /blogs/:blog  /blogs/:blog/:article  /cart  /search  /password
 *   GET  /products/:handle.js  /cart.js  /search/suggest  /recommendations/products
 *   POST /cart/add  /cart/change  /cart/update  /cart/clear   (and .js — the AJAX Cart API)
 *   POST /contact  /localization  /password
 *   GET  /cdn/shop/t/:theme/assets/:file   theme assets
 *   GET  /checkout → the platform's checkout (/checkouts/:token)
 *   ?sections=a,b / ?section_id=a on any page — the Section Rendering API
 *   ?view=<suffix> — an alternate template
 *
 * Mounted after every API route, and only answers for hosts that are a
 * shop's storefront: the shop's domains, `<handle>.<platform domain>`, and
 * `<handle>.localhost` outside production.
 */

export const onlineStoreRoutes = Router();

// ── which shop ──────────────────────────────────────────────────────────────

async function shopForHost(hostname: string): Promise<ShopContext | null> {
  const host = normaliseHostname(hostname);
  const byDomain = await shopDirectory.byHostname(host);
  if (byDomain) return byDomain;
  const platform = `.${env.platform.storefrontDomain}`;
  if (host.endsWith(platform)) {
    const handle = host.slice(0, -platform.length);
    if (/^[a-z0-9-]+$/.test(handle)) return shopDirectory.byHandle(handle);
  }
  // Development: http://<handle>.localhost:4000 — *.localhost resolves to this machine.
  if (env.nodeEnv !== 'production' && host.endsWith('.localhost')) {
    const handle = host.slice(0, -'.localhost'.length);
    if (/^[a-z0-9-]+$/.test(handle)) return shopDirectory.byHandle(handle);
  }
  return null;
}

onlineStoreRoutes.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = await shopForHost(req.hostname ?? '');
    if (!shop) return next('router');
    assertServable(shop);
    req.shop = shop;
    locals(res).hostRoute = await routeForShop(shop, req.hostname ?? '');
    tenancy.run(shop, () => next());
  } catch (error) {
    next(error);
  }
});

// ── one address per store: redirects to the primary domain, HTTPS, HSTS ─────

/** Paths that must answer on whatever host they are asked on. */
const HOST_AGNOSTIC = /^\/(cdn|\.well-known|internal|checkouts?)(\/|$)/;

onlineStoreRoutes.use((req: Request, res: Response, next: NextFunction) => {
  const route = locals(res).hostRoute;
  const current = route.domain;
  // Development hosts (<handle>.localhost) are not a domain of the shop: never redirected.
  if (!current || HOST_AGNOSTIC.test(req.path)) return next();
  const previewing = typeof req.query.preview_key === 'string' || Boolean(cookies(req).veylog_preview);
  const readOnly = req.method === 'GET' || req.method === 'HEAD';
  // Every other address — www or apex, an old domain, the platform subdomain — sends shoppers
  // (and search engines, with a 301) to the primary domain (or its market's), path and query intact.
  const target = current.redirectTo;
  if (readOnly && !previewing && target && target.hostname !== current.hostname) {
    res.redirect(301, `${target.https ? 'https' : 'http'}://${target.hostname}${req.originalUrl}`);
    return;
  }
  if (current.https) {
    if (req.protocol !== 'https' && readOnly) {
      res.redirect(301, `https://${current.hostname}${req.originalUrl}`);
      return;
    }
    // Not includeSubDomains: the merchant's other subdomains may not be on HTTPS.
    res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  }
  next();
});

// ── the storefront language: /<code>/… for every published language but the primary ─

onlineStoreRoutes.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const languages = await shopLanguages.get();
    // A domain can have its own language at its root (example.fr → French); otherwise the store's.
    const domainLocale = locals(res).hostRoute.domain?.locale ?? null;
    const hostDefault = domainLocale && languages.published.some((candidate) => candidate.code === domainLocale) ? domainLocale : languages.primary.code;
    locals(res).locale = { code: hostDefault, prefix: '', hostDefault };
    const match = /^\/([a-z]{2}(?:-[a-z]{2})?)(?=\/|$)/i.exec(req.path);
    const language = match ? languages.all.find((candidate) => candidate.code !== hostDefault && candidate.code === match[1].toLowerCase()) : undefined;
    // An unpublished language is only reachable from the admin (a preview link), to check translations before going live.
    const previewing = Boolean(verifyPreview(typeof req.query.preview_key === 'string' ? req.query.preview_key : cookies(req).veylog_preview, tenancy.current().id));
    if (!language || (!language.published && !previewing)) {
      if (hostDefault !== languages.primary.code) return translationContext.run(hostDefault, () => next());
      return next();
    }
    const prefix = `/${language.code}`;
    let rest = req.url.slice(prefix.length);
    if (!rest.startsWith('/')) rest = `/${rest}`;
    // A language with a domain of its own is served there: /fr/products/x → https://fr.example.com/products/x.
    if ((req.method === 'GET' || req.method === 'HEAD') && !previewing && locals(res).hostRoute.domain) {
      const home = (await homesOf(req, res)).get(language.code);
      if (home && home.origin !== `${req.protocol}://${requestHost(req)}`) {
        res.redirect(301, `${home.origin}${home.prefix}${rest === '/' && home.prefix ? '' : rest}`);
        return;
      }
    }
    req.url = rest;
    locals(res).locale = { code: language.code, prefix, hostDefault };
    // Redirects stay in the language: /account → /hi/account.
    const redirect = res.redirect.bind(res) as (status: number, url: string) => void;
    (res as any).redirect = (statusOrUrl: number | string, maybeUrl?: string) => {
      const status = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      const url = typeof statusOrUrl === 'number' ? maybeUrl! : statusOrUrl;
      redirect(status, localizePath(url, prefix));
    };
    if (language.primary) return next();
    translationContext.run(language.code, () => next());
  } catch (error) {
    next(error);
  }
});

// ── the shopper's market (the `localization` cookie, as on Shopify) ────────

onlineStoreRoutes.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jar = cookies(req);
    let requested = (typeof req.query.country === 'string' ? req.query.country : jar.localization ?? '').toUpperCase();
    // A market's own domain serves that market: the shopper's country if it is in it, else the market's first.
    const domainMarket = locals(res).hostRoute.domain?.marketId ?? null;
    if (domainMarket) {
      const countries = await markets.countriesOf(domainMarket);
      if (countries.length && !countries.includes(requested)) requested = countries[0];
    }
    let market: Market | null = null;
    if (/^[A-Z]{2}$/.test(requested)) {
      try {
        market = await markets.forCountry(requested);
      } catch (error) {
        if (!(error instanceof MissingRateError)) throw error;
      }
    }
    market ??= (await markets.forCountry(null))!;
    locals(res).market = market;
    locals(res).cartToken = /^[0-9a-f-]{36}$/i.test(jar.cart ?? '') ? jar.cart : null;
    marketContext.run(market, () => next());
  } catch (error) {
    next(error);
  }
});

// ── which theme: the published one, or a preview ───────────────────────────

onlineStoreRoutes.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    const shop = tenancy.current();
    const jar = cookies(req);
    // ?preview_key= comes from the admin; it becomes a session cookie so links keep previewing.
    let token: string | undefined = typeof req.query.preview_key === 'string' ? req.query.preview_key : jar.veylog_preview;
    if (req.query.preview_theme_id === '') token = undefined;
    const grant = verifyPreview(token, shop.id);
    if (typeof req.query.preview_key === 'string' && grant) setCookie(res, 'veylog_preview', req.query.preview_key, null);
    if (req.query.preview_theme_id === '' || (jar.veylog_preview && !grant)) setCookie(res, 'veylog_preview', '', 0);

    let theme: LoadedTheme | null = null;
    if (grant) theme = await themeLoader.byPublicId(grant.themeId, { drafts: grant.design });
    theme ??= await themeLoader.main();
    if (!theme) {
      res.status(503).type('html').send(comingSoon(shop.name));
      return;
    }
    locals(res).theme = theme;
    locals(res).design = Boolean(grant?.design && theme.publicId === grant.themeId);
    res.setHeader('Vary', 'Cookie');
    // A storefront's pages link to each other and post forms to themselves; the
    // API's no-referrer default would make those posts arrive as `Origin: null`.
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (grant) {
      // The editor shows the store in a frame on the admin's origin.
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', `frame-ancestors 'self' ${previewFrameAncestors().join(' ')}`);
      res.setHeader('X-Robots-Tag', 'noindex');
      (res.locals as any).previewing = true;
    }
    next();
  } catch (error) {
    next(error);
  }
});

// ── who is signed in (the customer session cookie) ─────────────────────────

onlineStoreRoutes.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    locals(res).customerId = null;
    locals(res).customerSessionId = null;
    if (!req.path.startsWith('/cdn/')) {
      const session = await customerSession.current(req, tenancy.current().id);
      if (session) {
        locals(res).customerId = session.customerId;
        locals(res).customerSessionId = session.sessionId;
      }
    }
    next();
  } catch (error) {
    next(error);
  }
});

// ── theme assets ────────────────────────────────────────────────────────────

/** A theme app extension's asset; the version in the path makes it cacheable forever. */
onlineStoreRoutes.get('/cdn/apps/:app/:version/assets/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!/^[0-9a-f-]{36}$/i.test(String(req.params.app))) return notFoundText(res);
    const asset = await themeExtensions.asset(String(req.params.app), String(req.params.file));
    if (!asset) return notFoundText(res);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(asset.contentType).send(asset.content);
  } catch (error) {
    next(error);
  }
});

onlineStoreRoutes.get('/cdn/shop/t/:theme/assets/:file', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const file = `assets/${req.params.file}`;
    let theme = locals(res).theme;
    if (theme.publicId !== req.params.theme) {
      const other = await themeLoader.byPublicId(String(req.params.theme));
      if (!other) return notFoundText(res);
      theme = other;
    }
    let entry = theme.files.get(file);
    // assets/theme.css.liquid is served as theme.css, rendered with the theme's settings.
    const liquid = !entry ? theme.files.get(`${file}.liquid`) : null;
    if (!entry && !liquid) return notFoundText(res);
    res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'public, max-age=300');
    if (liquid) {
      const renderer = new PageRenderer({ theme, request: requestOf(req), shopper: { market: locals(res).market, cart: null } }, { template: 'asset', title: '' });
      const engine = engineFor(theme);
      const settings = ((await (renderer as any).buildGlobals()) as Record<string, unknown>).settings;
      const css = await engine.engine.render(engine.parse(`${file}.liquid`), { settings }, { globals: { settings, __env: {} } });
      res.type(file.split('.').pop() ?? 'txt').send(css);
      return;
    }
    entry = entry!;
    if (entry.storageKey) {
      res.redirect(302, storage.publicUrl(entry.storageKey));
      return;
    }
    res.type(entry.contentType).send(entry.content ?? '');
  } catch (error) {
    next(error);
  }
});

// ── the password page ───────────────────────────────────────────────────────

async function unlocked(req: Request, res: Response): Promise<boolean> {
  const shop = tenancy.current();
  if (!shop.storefrontLocked || (res.locals as any).previewing) return true;
  const token = cookies(req).storefront_digest;
  if (!token) return false;
  const row = await shopsRepository.byId(shop.id);
  return Boolean(row?.storefront_password_hash && isValidStorefrontUnlock(token, shop.id, row.storefront_password_hash));
}

// A gift card's page stays open on a locked store: its recipient needs the code.
const OPEN_WHEN_LOCKED = [/^\/password$/, /^\/cdn\//, /^\/localization$/, /^\/contact$/, /^\/robots\.txt$/, /^\/gift_cards\/[0-9a-f]{32}$/, /^\/privacy\/consent$/, /^\/policies\/[a-z-]+$/, /^\/privacy\/exports\//];

onlineStoreRoutes.use(async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (OPEN_WHEN_LOCKED.some((pattern) => pattern.test(req.path)) || (await unlocked(req, res))) return next();
    if (req.method === 'GET' && !req.path.endsWith('.js') && !req.path.endsWith('.json')) {
      res.redirect(302, '/password');
      return;
    }
    res.status(401).json({ status: 401, message: 'Unauthorized', description: 'This store is password protected.' });
  } catch (error) {
    next(error);
  }
});

// ── the visitor's privacy rules, then the full-page cache (which keys by them) ──

onlineStoreRoutes.use(privacyContext);
onlineStoreRoutes.use(pageCache);

// Policies, the consent endpoint, "Your privacy choices", privacy requests.
onlineStoreRoutes.use(privacyStorefrontRoutes);
// The announcement bar's view and click counts.
onlineStoreRoutes.use(announcementsStorefrontRoutes);

onlineStoreRoutes.get('/password', async (req: Request, res: Response, next: NextFunction) => {
  if (!tenancy.current().storefrontLocked) return res.redirect(302, '/');
  await page(req, res, next, { template: 'password', title: tenancy.current().name });
});

onlineStoreRoutes.post(
  '/password',
  rateLimit({ bucket: 'storefront.unlock', max: 10, windowSeconds: 300, blockSeconds: 900 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const shop = tenancy.current();
      const row = await shopsRepository.byId(shop.id);
      const password = String(req.body?.password ?? '');
      if (row?.storefront_password_hash && password && (await bcrypt.compare(password, row.storefront_password_hash))) {
        setCookie(res, 'storefront_digest', issueStorefrontUnlock(shop.id, row.storefront_password_hash), Math.floor(TOKEN_TTL_MS / 1000));
        res.redirect(302, '/');
        return;
      }
      await page(req, res, next, { template: 'password', title: shop.name, objects: { password_failed: true } }, { storefront_password: { posted_successfully: false, errors: ['Incorrect password'] } }, 401);
    } catch (error) {
      next(error);
    }
  },
);

// ── pages ───────────────────────────────────────────────────────────────────

onlineStoreRoutes.get('/', (req, res, next) => {
  const shop = tenancy.current();
  return page(req, res, next, { template: 'index', title: shop.name });
});

onlineStoreRoutes.get('/collections', (req, res, next) => page(req, res, next, { template: 'list-collections', title: 'Collections' }));

/**
 * A gift card's page (the link in its email): balance and code, in the card's
 * own currency. Never cached (it holds the code) and never indexed.
 */
onlineStoreRoutes.get('/gift_cards/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const found = await giftCardsService.forPage(String(req.params.token));
    if (!found) return notFound(req, res, next);
    const { card, code, today } = found;
    const current = locals(res).market;
    let market = current;
    if (current.currency !== card.currency) {
      const entry = ((await markets.catalogue().catch(() => [])) as Array<{ country: string; currency: string }>).find((candidate) => candidate.currency === card.currency);
      if (entry) market = (await markets.forCountry(entry.country).catch(() => null)) ?? current;
    }
    locals(res).market = market;
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    const cents = (amount: unknown) => Math.round(Number(amount) * 100);
    const state = stateOf(card, today);
    const giftCard = {
      id: card.id,
      balance: cents(card.balance),
      initial_value: cents(card.initial_value),
      currency: card.currency,
      code: code ? formatCode(code) : null,
      last_four_characters: card.last_characters,
      enabled: card.status === 'enabled',
      expired: state === 'expired',
      expires_on: dateOnly(card.expires_on),
      message: card.message,
      recipient: card.recipient_name || card.recipient_email ? { name: card.recipient_name, email: card.recipient_email } : null,
      url: giftCardUrl(card),
      qr_identifier: card.lookup_token,
      template_suffix: null,
      properties: {},
    };
    const theme = locals(res).theme;
    // Every Shopify theme has templates/gift_card.liquid; one that does not still gets a working page.
    if (!theme.files.has('templates/gift_card.liquid') && !theme.files.has('templates/gift_card.json')) {
      res.setHeader('Cache-Control', 'private, no-store');
      res.type('html').send(giftCardFallback(tenancy.current().name, giftCard, market.currency));
      return;
    }
    await marketContext.run(market, () => page(req, res, next, { template: 'gift_card', title: 'Gift card', objects: { gift_card: giftCard } }));
  } catch (error) {
    next(error);
  }
});

async function collectionPage(req: Request, res: Response, next: NextFunction) {
  const handle = String(req.params.handle);
  const sortBy = typeof req.query.sort_by === 'string' ? req.query.sort_by : null;
  const filters: Record<string, unknown> = {};
  const min = Number(req.query['filter.v.price.gte']);
  const max = Number(req.query['filter.v.price.lte']);
  if (Number.isFinite(min) && min > 0) filters.min_price = min;
  if (Number.isFinite(max) && max > 0) filters.max_price = max;
  if (req.query['filter.v.availability'] === '1') filters.in_stock = true;
  const collection = await loadCollection(handle, sortBy, filters);
  if (!collection) return notFound(req, res, next);
  return page(req, res, next, {
    template: 'collection',
    suffix: collection.template_suffix,
    objects: { collection },
    title: await collection.title,
    description: (await collection.description).replace(/<[^>]+>/g, '').slice(0, 320) || null,
    image: collection.image,
    handle,
  });
}

onlineStoreRoutes.get('/collections/:handle', collectionPage);

async function productJson(product: ProductDrop) {
  const variants = product.variants.map((variant) => ({
    id: variant.id,
    title: variant.title,
    option1: variant.option1,
    option2: variant.option2,
    option3: variant.option3,
    sku: variant.sku,
    requires_shipping: true,
    taxable: true,
    featured_image: variant.featured_image ? { src: variant.featured_image.src, alt: variant.featured_image.alt } : null,
    available: variant.available,
    name: variant.name,
    public_title: variant.options[0] === 'Default Title' ? null : variant.title,
    options: variant.options,
    price: variant.price,
    compare_at_price: variant.compare_at_price,
    weight: variant.weight,
    inventory_management: 'veylog',
    barcode: variant.barcode,
  }));
  return {
    id: product.id,
    title: await product.title,
    handle: product.handle,
    description: await product.description,
    published_at: product.published_at,
    created_at: product.created_at,
    vendor: product.vendor,
    type: product.type,
    tags: product.tags,
    price: product.price,
    price_min: product.price_min,
    price_max: product.price_max,
    available: product.available,
    price_varies: product.price_varies,
    compare_at_price: product.compare_at_price,
    compare_at_price_min: product.compare_at_price_min,
    compare_at_price_max: product.compare_at_price_max,
    compare_at_price_varies: product.compare_at_price_varies,
    variants,
    images: product.images.map((image) => image.src),
    featured_image: product.featured_image?.src ?? null,
    options: product.options_with_values.map((option: any) => ({ name: option.name, position: option.position, values: option.values })),
    url: product.url,
    media: product.images.map((image, index) => ({ id: index + 1, alt: image.alt, position: index + 1, media_type: 'image', src: image.src, aspect_ratio: image.aspect_ratio })),
  };
}

async function productPage(req: Request, res: Response, next: NextFunction) {
  let handle = String(req.params.handle);
  const asJson = /\.(js|json)$/.test(handle);
  handle = handle.replace(/\.(js|json)$/, '');
  const variantId = Number(req.query.variant) || null;
  const product = await loadProduct(handle, variantId);
  if (!product) {
    if (asJson) return res.status(404).json({ status: 404, message: 'Not Found', description: 'Product not found' });
    return notFound(req, res, next);
  }
  if (asJson) {
    const json = await productJson(product);
    res.json(handle && req.params.handle.endsWith('.json') ? { product: json } : json);
    return;
  }
  const seo = product.seo as { title?: string; meta_title?: string; description?: string; meta_description?: string } | null;
  return page(req, res, next, {
    template: 'product',
    suffix: product.template_suffix,
    objects: { product, collection: req.params.collection ? await loadCollection(String(req.params.collection)) : null },
    title: seo?.meta_title ?? seo?.title ?? (await product.title),
    description: seo?.meta_description ?? seo?.description ?? product.excerpt,
    image: product.featured_image,
    handle,
  });
}

onlineStoreRoutes.get('/products/:handle', productPage);
onlineStoreRoutes.get('/collections/:collection/products/:handle', productPage);

onlineStoreRoutes.get('/pages/:handle', async (req, res, next) => {
  const handle = String(req.params.handle);
  const pageDrop = await loadPage(handle);
  if (!pageDrop) {
    // A new store has no contact page yet; the theme's contact template still works.
    if (handle === 'contact' && (locals(res).theme.files.has('templates/page.contact.json') || locals(res).theme.files.has('templates/page.contact.liquid'))) {
      return page(req, res, next, { template: 'page', suffix: 'contact', objects: { page: { title: 'Contact', handle: 'contact', url: '/pages/contact', content: '' } }, title: 'Contact', handle });
    }
    return notFound(req, res, next);
  }
  const suffix = pageDrop.template_suffix && pageDrop.template_suffix !== 'default' ? pageDrop.template_suffix : handle === 'contact' ? 'contact' : null;
  return page(req, res, next, { template: 'page', suffix, objects: { page: pageDrop }, title: await pageDrop.title, description: pageDrop.summary_html || null, handle });
});

onlineStoreRoutes.get('/blogs/:blog', async (req, res, next) => {
  const handle = String(req.params.blog);
  const blogs = await onlineStoreRepository.blogs();
  const row = blogs.find((candidate) => candidate.slug === handle);
  if (!row && handle !== 'journal' && handle !== 'news') return notFound(req, res, next);
  const blog = new BlogDrop({ handle, title: row?.title ?? 'Journal', description: row?.description ?? null, commentsPolicy: row?.comments_policy });
  return page(req, res, next, { template: 'blog', objects: { blog }, title: blog.title, handle });
});

/** An article with its published comments (Shopify's article.comments, comments_count, comments_enabled?, moderated?). */
async function articleWithComments(detail: any, handle: string, forms: Record<string, unknown>) {
  const article = articleDrop(detail.article, handle) as ReturnType<typeof articleDrop> & Record<string, unknown>;
  const target = await commentsService.target(handle, String(detail.article?.slug ?? ''));
  const policy = target?.policy ?? 'disabled';
  const comments = target && policy !== 'disabled' ? await commentsService.published(target.articleId, 50) : [];
  const count = target && policy !== 'disabled' ? await commentsService.publishedCount(target.articleId) : 0;
  Object.assign(article, {
    comments: comments.map((comment) => ({
      id: comment.id,
      author: comment.author,
      content: commentHtml(comment.body),
      created_at: comment.published_at ?? comment.created_at,
      status: 'published',
      url: `/blogs/${handle}/${detail.article.slug}#comment-${comment.id}`,
    })),
    comments_count: count,
    comments_enabled: policy !== 'disabled',
    'comments_enabled?': policy !== 'disabled',
    'moderated?': policy === 'moderated',
    comment_post_url: `/blogs/${handle}/${detail.article.slug}/comments`,
  });
  return { article, policy, target, forms };
}

onlineStoreRoutes.get('/blogs/:blog/:article', async (req, res, next) => {
  const handle = String(req.params.blog);
  let detail: any;
  try {
    detail = await contentPublicService.journal.detail(String(req.params.article));
  } catch {
    return notFound(req, res, next);
  }
  const { article, policy } = await articleWithComments(detail, handle, {});
  const blog = new BlogDrop({ handle, title: detail.article?.blog?.title ?? 'Journal', commentsPolicy: policy });
  return page(req, res, next, {
    template: 'article',
    objects: { article, blog },
    title: detail.article?.seo?.meta_title ?? (await article.title),
    description: detail.article?.seo?.meta_description ?? article.excerpt,
    image: article.image,
    handle: article.handle,
  });
});

/**
 * {% form 'new_comment', article %}: a shopper's comment. Posted, it goes back
 * to the article (?comment_posted=true#comments — "awaiting moderation" where
 * the blog is moderated); refused, the article is shown again with the errors
 * and what was typed.
 */
onlineStoreRoutes.post(
  '/blogs/:blog/:article/comments',
  rateLimit({ bucket: 'storefront.comment', max: 5, windowSeconds: 600, blockSeconds: 900 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const handle = String(req.params.blog);
      const target = await commentsService.target(handle, String(req.params.article));
      if (!target || target.policy === 'disabled') return notFound(req, res, next);
      const fields = (req.body?.comment ?? {}) as Record<string, unknown>;
      const input = {
        author: String(fields.author ?? req.body?.['comment[author]'] ?? ''),
        email: String(fields.email ?? req.body?.['comment[email]'] ?? ''),
        body: String(fields.body ?? req.body?.['comment[body]'] ?? ''),
        honeypot: String(fields.website ?? req.body?.['comment[website]'] ?? '') || null,
        customerId: locals(res).customerId,
      };
      try {
        await commentsService.post(target, input, { ip: clientIp(req), userAgent: req.get('user-agent') ?? null });
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 422) throw error;
        const detail = await contentPublicService.journal.detail(target.articleSlug);
        const errors = Object.values((error as ApiError & { details?: Record<string, string[]> }).details ?? {}).flat();
        const { article } = await articleWithComments(detail, handle, {});
        const blog = new BlogDrop({ handle, title: detail.article?.blog?.title ?? 'Journal', commentsPolicy: target.policy });
        return page(req, res, next, { template: 'article', objects: { article, blog }, title: target.articleTitle, handle: target.articleSlug }, { new_comment: { posted_successfully: false, errors: errors.length ? errors : [error.message], author: input.author, email: input.email, body: input.body } }, 422);
      }
      res.redirect(303, `/blogs/${handle}/${target.articleSlug}?comment_posted=true#comments`);
    } catch (error) {
      next(error);
    }
  },
);

onlineStoreRoutes.get('/search', async (req, res, next) => {
  const terms = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
  const pageSize = 24;
  const current = Math.max(1, Number(req.query.page) || 1);
  const result = terms ? await storefrontService.listProducts({ q: terms, page: current, limit: pageSize, sort: 'featured' }) : null;
  const products = ((result?.products ?? []) as any[]).map((card) => new ProductDrop(card));
  const total = Number(result?.pagination.total ?? 0);
  const search = {
    performed: Boolean(terms),
    terms,
    results: products.map((product) => Object.assign(product, { object_type: 'product' })),
    results_count: total,
    types: ['product'],
    sort_by: 'relevance',
    sort_options: [{ value: 'relevance', name: 'Relevance' }],
    filters: [],
    // For {% paginate search.results by N %}: the page already loaded is the one asked for.
    paginateProperty: async (_property: string, _size: number, _page: number) => ({ items: products, total }),
  };
  return page(req, res, next, { template: 'search', objects: { search }, title: terms ? `Search: ${terms}` : 'Search' });
});

onlineStoreRoutes.get(['/search/suggest', '/search/suggest.json'], async (req, res, next) => {
  try {
    const terms = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 120) : '';
    const limit = Math.min(10, Math.max(1, Number(req.query['resources[limit]'] ?? req.query.limit) || 4));
    const result = terms ? await storefrontService.listProducts({ q: terms, limit, page: 1 }) : null;
    const products = ((result?.products ?? []) as any[]).map((card) => new ProductDrop(card));
    const predictive = { performed: Boolean(terms), terms, resources: { products, collections: [], pages: [], articles: [], queries: [] } };
    if (typeof req.query.section_id === 'string') {
      return page(req, res, next, { template: 'search', objects: { predictive_search: predictive }, title: 'Search' });
    }
    res.json({ resources: { results: { products: await Promise.all(products.map((product) => productJson(product))) } } });
  } catch (error) {
    next(error);
  }
});

onlineStoreRoutes.get(['/recommendations/products', '/recommendations/products.json'], async (req, res, next) => {
  try {
    const productId = Number(req.query.product_id);
    const limit = Math.min(10, Math.max(1, Number(req.query.limit) || 4));
    let products: ProductDrop[] = [];
    if (productId) {
      const handle = await onlineStoreRepository.productHandle(productId);
      const product = handle ? await loadProduct(handle) : null;
      products = product ? product.related.slice(0, limit) : [];
    }
    const recommendations = { performed: true, products, products_count: products.length, intent: 'related' };
    if (typeof req.query.section_id === 'string') {
      return page(req, res, next, { template: 'product', objects: { recommendations }, title: 'Recommendations' });
    }
    res.json({ products: await Promise.all(products.map((product) => productJson(product))) });
  } catch (error) {
    next(error);
  }
});

// ── the AJAX Cart API ───────────────────────────────────────────────────────

async function ensureCart(res: Response): Promise<string> {
  const existing = locals(res).cartToken;
  if (existing) {
    try {
      await storefrontService.getCart(existing);
      return existing;
    } catch {
      /* expired or deleted: start a new one */
    }
  }
  const created = await storefrontService.createCart();
  const token = created.cart.token as string;
  const market = locals(res).market;
  if (!market.isPrimary || market.country !== tenancy.current().countryCode) {
    await storefrontService.setMarket(token, market.country).catch(() => undefined);
  }
  setCookie(res, 'cart', token, 14 * 86_400);
  locals(res).cartToken = token;
  return token;
}

function cartJson(cart: any) {
  const drop = cartDrop(cart);
  return {
    token: drop.token,
    note: drop.note,
    attributes: drop.attributes,
    original_total_price: drop.original_total_price,
    total_price: drop.total_price,
    total_discount: drop.total_discount,
    total_weight: 0,
    item_count: drop.item_count,
    items: drop.items.map(lineJson),
    requires_shipping: drop.requires_shipping,
    currency: drop.currency.iso_code,
    items_subtotal_price: drop.items_subtotal_price,
    cart_level_discount_applications: drop.cart_level_discount_applications,
  };
}

function lineJson(line: ReturnType<typeof cartDrop>['items'][number]) {
  return {
    id: line.variant_id,
    key: line.key,
    properties: {},
    quantity: line.quantity,
    variant_id: line.variant_id,
    product_id: line.product_id,
    title: line.title,
    product_title: line.product_title,
    variant_title: line.variant_title,
    sku: line.sku,
    price: line.price,
    original_price: line.original_price,
    discounted_price: line.final_price,
    final_price: line.final_price,
    line_price: line.line_price,
    original_line_price: line.original_line_price,
    final_line_price: line.final_line_price,
    total_discount: line.line_level_total_discount,
    discounts: [],
    url: line.url,
    handle: line.product.handle,
    image: line.image?.src ?? null,
    featured_image: line.image ? { url: line.image.src, alt: line.image.alt, aspect_ratio: 1, width: null, height: null } : null,
    requires_shipping: true,
    product_has_only_default_variant: line.product.has_only_default_variant,
    options_with_values: line.options_with_values,
    gift_card: false,
  };
}

function cartError(res: Response, error: unknown, asJson: boolean) {
  const message = error instanceof ApiError ? error.message : 'Something went wrong with the cart.';
  const status = error instanceof ApiError && error.status < 500 ? 422 : 500;
  if (!(error instanceof ApiError)) logger.error('online_store.cart_failed', { error: String(error) });
  if (asJson) res.status(status).json({ status, message: 'Cart Error', description: message });
  else res.redirect(303, `/cart?error=${encodeURIComponent(message)}`);
}

/** Sections to render along with a cart change (Dawn's cart drawer and bubble). */
async function withSections(req: Request, res: Response, body: Record<string, unknown>) {
  const raw = req.body?.sections;
  const ids = (Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : []).map((id: unknown) => String(id).trim()).filter(Boolean).slice(0, 5);
  if (ids.length === 0) return body;
  const sectionsUrl = typeof req.body?.sections_url === 'string' && req.body.sections_url.startsWith('/') ? req.body.sections_url : '/';
  const renderer = new PageRenderer(
    { theme: locals(res).theme, request: { ...requestOf(req), path: sectionsUrl.split('?')[0] }, shopper: { market: locals(res).market, cart: await currentCart(res) } },
    { template: templateForPath(sectionsUrl), title: '' },
  );
  return { ...body, sections: await renderer.renderSections(ids) };
}

function templateForPath(path: string): string {
  const clean = path.split('?')[0];
  if (clean === '/' || clean === '') return 'index';
  if (clean.startsWith('/products/')) return 'product';
  if (clean.startsWith('/collections/')) return 'collection';
  if (clean === '/cart') return 'cart';
  if (clean.startsWith('/search')) return 'search';
  if (clean.startsWith('/pages/')) return 'page';
  return 'index';
}

const cartLimit = rateLimit({ bucket: 'shop.cart', max: 60, windowSeconds: 60 });

onlineStoreRoutes.get(['/cart.js', '/cart.json'], async (_req, res, next) => {
  try {
    const cart = await currentCart(res);
    res.setHeader('Cache-Control', 'no-store');
    res.json(cartJson(cart ?? { items: [], item_count: 0, totals: { currency: locals(res).market.currency } }));
  } catch (error) {
    next(error);
  }
});

onlineStoreRoutes.get('/cart', (req, res, next) =>
  page(req, res, next, {
    template: 'cart',
    title: 'Your cart',
    // A cart change that failed without JavaScript comes back here with its reason.
    objects: { request_error: typeof req.query.error === 'string' ? req.query.error.slice(0, 200) : null },
  }),
);

onlineStoreRoutes.post(['/cart/add', '/cart/add.js'], cartLimit, async (req, res) => {
  const asJson = req.path.endsWith('.js') || req.accepts(['html', 'json']) === 'json';
  try {
    const token = await ensureCart(res);
    const body = req.body ?? {};
    const lines: { id: number; quantity: number }[] = Array.isArray(body.items)
      ? body.items.map((item: any) => ({ id: Number(item.id), quantity: Math.max(1, Number(item.quantity) || 1) }))
      : [{ id: Number(body.id), quantity: Math.max(1, Number(body.quantity) || 1) }];
    let cart: any = null;
    for (const line of lines) {
      if (!Number.isInteger(line.id) || line.id <= 0) throw ApiError.validation({ id: ['Choose a variant.'] });
      cart = (await storefrontService.addItem(token, line.id, Math.min(line.quantity, 999))).cart;
    }
    // "Buy it now" posts return_to=/checkout; anything else lands on the cart.
    const back = typeof body.return_to === 'string' && body.return_to.startsWith('/') && !body.return_to.startsWith('//') ? body.return_to : '/cart';
    if (!asJson) return res.redirect(303, back);
    const added = cartJson(cart).items.filter((item) => lines.some((line) => line.id === item.variant_id));
    const payload = Array.isArray(body.items) ? { items: added } : { ...(added[0] ?? {}) };
    res.json(await withSections(req, res, payload));
  } catch (error) {
    cartError(res, error, asJson);
  }
});

onlineStoreRoutes.post(['/cart/change', '/cart/change.js'], cartLimit, async (req, res) => {
  const asJson = req.path.endsWith('.js') || req.accepts(['html', 'json']) === 'json';
  try {
    const token = await ensureCart(res);
    const body = req.body ?? {};
    const quantity = Math.max(0, Math.min(999, Number(body.quantity) || 0));
    const current = (await storefrontService.getCart(token)).cart;
    const items = current.items as any[];
    let target: any = null;
    if (body.line) target = items[Number(body.line) - 1];
    else if (body.id !== undefined) target = items.find((item) => String(item.id) === String(body.id)) ?? items.find((item) => String(item.variant_id) === String(body.id));
    if (!target) throw ApiError.validation({ id: ['That item is not in the cart.'] });
    const cart = (await storefrontService.updateItem(token, Number(target.id), quantity)).cart;
    if (!asJson) return res.redirect(303, '/cart');
    res.json(await withSections(req, res, cartJson(cart)));
  } catch (error) {
    cartError(res, error, asJson);
  }
});

onlineStoreRoutes.post(['/cart/update', '/cart/update.js', '/cart'], cartLimit, async (req, res) => {
  const asJson = req.path.endsWith('.js') || req.accepts(['html', 'json']) === 'json';
  try {
    const token = await ensureCart(res);
    const body = req.body ?? {};
    const current = (await storefrontService.getCart(token)).cart;
    const items = current.items as any[];
    let cart = current;
    const updates = body.updates;
    if (Array.isArray(updates)) {
      for (const [index, value] of updates.entries()) {
        const item = items[index];
        if (item && Number(value) !== item.quantity) cart = (await storefrontService.updateItem(token, Number(item.id), Math.max(0, Number(value) || 0))).cart;
      }
    } else if (updates && typeof updates === 'object') {
      for (const [key, value] of Object.entries(updates)) {
        const item = items.find((candidate) => String(candidate.id) === key) ?? items.find((candidate) => String(candidate.variant_id) === key);
        if (item) cart = (await storefrontService.updateItem(token, Number(item.id), Math.max(0, Number(value) || 0))).cart;
        else if (Number(value) > 0) cart = (await storefrontService.addItem(token, Number(key), Number(value))).cart;
      }
    }
    if (typeof body.discount === 'string' && body.discount.trim()) {
      cart = (await storefrontService.applyDiscountCode(token, body.discount.trim())).cart;
    }
    if (!asJson) return res.redirect(303, body.checkout !== undefined ? '/checkout' : '/cart');
    res.json(await withSections(req, res, cartJson(cart)));
  } catch (error) {
    cartError(res, error, asJson);
  }
});

onlineStoreRoutes.post(['/cart/clear', '/cart/clear.js'], cartLimit, async (req, res) => {
  const asJson = req.path.endsWith('.js') || req.accepts(['html', 'json']) === 'json';
  try {
    const token = await ensureCart(res);
    let cart = (await storefrontService.getCart(token)).cart;
    for (const item of cart.items as any[]) cart = (await storefrontService.removeItem(token, Number(item.id))).cart;
    if (!asJson) return res.redirect(303, '/cart');
    res.json(await withSections(req, res, cartJson(cart)));
  } catch (error) {
    cartError(res, error, asJson);
  }
});

// ── checkout (the platform's, not the theme's — as on Shopify) ─────────────

onlineStoreRoutes.get('/checkout', async (_req, res) => {
  const token = locals(res).cartToken;
  if (!token) return res.redirect(303, '/cart');
  res.redirect(303, `/checkouts/${token}`);
});

onlineStoreRoutes.get('/checkouts/:token', async (req, res, next) => {
  try {
    const token = String(req.params.token);
    if (!/^[0-9a-f-]{36}$/i.test(token)) return notFoundText(res);
    let cart: any;
    try {
      cart = (await storefrontService.getCart(token)).cart;
    } catch {
      return res.redirect(303, '/cart');
    }
    if (!cart.items?.length) return res.redirect(303, '/cart');
    const renderer = new PageRenderer({ theme: locals(res).theme, request: requestOf(req), shopper: { market: locals(res).market, cart } }, { template: 'checkout', title: 'Checkout' });
    const globals = (await (renderer as any).buildGlobals()) as Record<string, any>;
    res.setHeader('Cache-Control', 'no-store');
    res.type('html').send(
      checkoutPage({
        cart,
        shop: globals.shop,
        settings: await resolveLookSettings(globals.settings),
        countries: await markets.catalogue().catch(() => []),
        shopHandle: tenancy.current().handle,
        locale: 'en',
        customer: await checkoutCustomer(locals(res).customerId),
        accountsEnabled: (await onlineStorePreferences.get()).customer_accounts !== 'disabled',
      }),
    );
  } catch (error) {
    next(error);
  }
});

/** The signed-in shopper's details and address book, for filling in the checkout. */
async function checkoutCustomer(customerId: number | null) {
  if (!customerId) return null;
  const customer = await customerAccountRepository.customer(customerId);
  if (!customer || customer.status !== 'active') return null;
  const addresses = (await customerAccountRepository.addresses(customerId)).map((row) => addressDrop(row)!);
  return {
    name: [customer.first_name, customer.last_name].filter(Boolean).join(' ') || `${customer.country_code}${customer.phone}`,
    email: customer.email,
    phone: customer.phone,
    first_name: customer.first_name ?? '',
    last_name: customer.last_name ?? '',
    accepts_marketing: customer.accepts_email_marketing === 1,
    addresses: addresses.map((address) => ({
      id: address.id,
      first_name: address.first_name,
      last_name: address.last_name,
      address1: address.address1,
      address2: address.address2,
      city: address.city,
      province: address.province,
      zip: address.zip,
      country_code: address.country_code,
      default: address.default,
      summary: address.summary,
    })),
  };
}

/** The theme's colours, fonts and logo, for branding the checkout. */
async function resolveLookSettings(settings: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(settings ?? {})) {
    out[key] = value && typeof (value as PromiseLike<unknown>).then === 'function' ? await (value as PromiseLike<unknown>) : value;
  }
  return out;
}

// ── forms ───────────────────────────────────────────────────────────────────

onlineStoreRoutes.post(
  '/contact',
  rateLimit({ bucket: 'shop.contact', max: 8, windowSeconds: 600, blockSeconds: 600 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body = req.body ?? {};
      const contact = (body.contact ?? {}) as Record<string, string>;
      const email = String(contact.email ?? '').trim().toLowerCase();
      const back = typeof body.return_to === 'string' && body.return_to.startsWith('/') ? body.return_to : req.get('referer') ? new URL(req.get('referer')!).pathname : '/';
      const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 191;
      if (body.form_type === 'customer') {
        // The newsletter form (form 'customer' with contact[tags] "newsletter").
        if (!valid) return res.redirect(303, `${back}?form_type=customer&customer_posted=false#contact_form`);
        await newsletterService.subscribe({ email, source: 'footer', wording: null, countryCode: locals(res).market.country }, { ip: clientIp(req), userAgent: req.header('User-Agent')?.slice(0, 255) ?? null });
        return res.redirect(303, `${back}?customer_posted=true#contact_form`);
      }
      const message = String(contact.body ?? contact.comment ?? '').trim();
      if (!valid || !message) {
        return res.redirect(303, `${back}?contact_posted=false#contact_form`);
      }
      const extra = Object.fromEntries(Object.entries(contact).filter(([key]) => !['email', 'body', 'comment', 'name', 'phone'].includes(key)).slice(0, 20));
      await onlineStoreRepository.saveContactMessage({
        name: String(contact.name ?? '').trim().slice(0, 120) || null,
        email,
        phone: String(contact.phone ?? '').trim().slice(0, 40) || null,
        body: message.slice(0, 5000),
        fields: extra,
        pagePath: back.slice(0, 255),
        ip: clientIp(req),
        userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
      });
      res.redirect(303, `${back}?contact_posted=true#contact_form`);
    } catch (error) {
      next(error);
    }
  },
);

onlineStoreRoutes.post('/localization', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const route = locals(res).hostRoute;
    const here = `${req.protocol}://${requestHost(req)}`;
    // The page to come back to, without a language prefix (the form sends request.path).
    const path = safeReturn(req.body?.return_to, '/');
    const at = (prefix: string) => `${prefix}${prefix && path === '/' ? '' : path}` || '/';

    const country = String(req.body?.country_code ?? '').toUpperCase();
    let chosen: Market | null = null;
    if (/^[A-Z]{2}$/.test(country)) {
      setCookie(res, 'localization', country, 365 * 86_400);
      const token = locals(res).cartToken;
      if (token) await storefrontService.setMarket(token, country).catch(() => undefined);
      chosen = await markets.forCountry(country).catch(() => null);
    }
    const code = String(req.body?.language_code ?? req.body?.locale_code ?? '').toLowerCase();
    const languages = await shopLanguages.get();
    const language = languages.published.find((candidate) => candidate.code === code);
    const hostDefault = locals(res).locale.hostDefault ?? languages.primary.code;
    // The same page in the chosen (or current) language, on this host.
    const back = language ? at(language.code === hostDefault ? '' : `/${language.code}`) : at(locals(res).locale.prefix);

    // 1. A market with its own domain is shopped there; leaving a market's domain goes home.
    if (chosen && chosen.id !== locals(res).market.id) {
      const target = route.marketDomains.find((domain) => domain.marketId === chosen!.id);
      const destination = target ?? (route.domain?.marketId && chosen.id !== route.domain.marketId ? route.primary : null);
      if (destination && destination.hostname !== route.domain?.hostname) {
        res.status(303).location(`${destination.https ? 'https' : 'http'}://${destination.hostname}${back}`).end();
        return;
      }
    }
    // 2. A language lives where its home is: its own domain (fr.example.com), or a subfolder.
    const home = language ? (await homesOf(req, res)).get(language.code) : undefined;
    if (home) {
      res.status(303).location(`${home.origin === here ? '' : home.origin}${at(home.prefix)}`).end();
      return;
    }
    res.status(303).location(back).end();
  } catch (error) {
    next(error);
  }
});

// ── customer accounts ───────────────────────────────────────────────────────

onlineStoreRoutes.use(customerAccountRoutes);

// ── crawlers ────────────────────────────────────────────────────────────────

onlineStoreRoutes.get('/robots.txt', (req, res) => {
  const origin = requestOf(req).origin;
  const locked = tenancy.current().storefrontLocked;
  res.type('text').send(
    locked
      ? 'User-agent: *\nDisallow: /\n'
      : `User-agent: *\nDisallow: /cart\nDisallow: /checkout\nDisallow: /checkouts/\nDisallow: /search\nDisallow: /*?*sort_by*\nDisallow: /cdn/\n\nSitemap: ${origin}/sitemap.xml\n`,
  );
});

onlineStoreRoutes.get('/sitemap.xml', async (req, res, next) => {
  try {
    const origin = requestOf(req).origin;
    const entries = await onlineStoreRepository.sitemapEntries();
    const url = (path: string, updated?: Date | null) =>
      `<url><loc>${origin}${path}</loc>${updated ? `<lastmod>${new Date(updated).toISOString()}</lastmod>` : ''}</url>`;
    const body = [
      url('/'),
      ...entries.products.map((row) => url(`/products/${row.handle}`, row.updated_at)),
      ...entries.collections.map((row) => url(`/collections/${row.handle}`, row.updated_at)),
      ...entries.pages.map((row) => url(`/pages/${row.handle}`, row.updated_at)),
      ...entries.articles.map((row) => url(`/blogs/${row.blog ?? 'journal'}/${row.handle}`, row.updated_at)),
    ].join('');
    res.type('application/xml').send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${body}</urlset>`);
  } catch (error) {
    next(error);
  }
});

// Browsers ask for /favicon.ico whatever the page says; answer without rendering a 404 page.
onlineStoreRoutes.get('/favicon.ico', async (_req, res) => {
  const brand = await brandService.storefront().catch(() => null);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  if (brand?.square_logo?.url) return res.redirect(302, brand.square_logo.url);
  res.status(204).end();
});

// Everything else on a storefront host is the theme's 404 page.
onlineStoreRoutes.get('*', (req, res, next) => notFound(req, res, next));

// Errors on a storefront are pages, not JSON.
onlineStoreRoutes.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  // A refusal the shopper can act on — too many attempts, a bad request — keeps its status and says why.
  if (error instanceof ApiError && error.status < 500) {
    const wantsJson = /\.js(on)?$/.test(req.path) || (req.get('accept') ?? '').includes('application/json') || req.xhr;
    const message = error.status === 429 ? 'Too many attempts. Please wait a few minutes and try again.' : error.message;
    if (wantsJson) {
      res.status(error.status).json({ status: error.status, message, description: message });
      return;
    }
    res
      .status(error.status)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${error.status === 429 ? 'Please wait' : 'That did not work'}</title><body style="font:16px/1.5 system-ui;padding:48px;max-width:640px;margin:auto"><h1 style="font-size:22px">${error.status === 429 ? 'Please wait a moment' : 'That did not work'}</h1><p>${message.replace(/[<>&]/g, '')}</p><p><a href="javascript:history.back()">Go back</a></p></body>`,
      );
    return;
  }
  logger.error('online_store.render_failed', { path: req.path, error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  const design = (res.locals as Locals).design;
  res.status(500).type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Something went wrong</title><body style="font:16px/1.5 system-ui;padding:48px;max-width:640px;margin:auto"><h1 style="font-size:22px">Something went wrong</h1><p>This page could not be shown. Please try again in a moment.</p>${
      design && error instanceof Error ? `<pre style="white-space:pre-wrap;background:#fff4f4;padding:12px;border-radius:8px;color:#8e1f0b">${error.message.replace(/</g, '&lt;')}</pre>` : ''
    }</body>`,
  );
});

/** A plain gift card page, for a theme without a gift_card template. */
function giftCardFallback(shopName: string, card: { balance: number; initial_value: number; code: string | null; enabled: boolean; expired: boolean; expires_on: string | null }, currency: string): string {
  const safe = (value: unknown) => String(value ?? '').replace(/[<>&"]/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' })[character]!);
  const money = (cents: number) => {
    try {
      return new Intl.NumberFormat('en', { style: 'currency', currency }).format(cents / 100);
    } catch {
      return `${currency} ${(cents / 100).toFixed(2)}`;
    }
  };
  const state = !card.enabled ? 'This gift card has been disabled' : card.expired ? `Expired on ${card.expires_on}` : card.expires_on ? `Expires on ${card.expires_on}` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex, nofollow"><meta name="referrer" content="no-referrer"><title>Your ${safe(shopName)} gift card</title>
<body style="font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#f6f6f4;color:#1a1a1a;padding:24px;box-sizing:border-box">
<main style="max-width:30rem;width:100%;text-align:center"><p style="font-size:22px;font-weight:600;margin:0 0 24px">${safe(shopName)}</p>
<section style="background:#fff;border:1px solid #e5e5e0;border-radius:16px;padding:36px 24px"><p style="margin:0;color:#666">Your gift card balance</p>
<h1 style="font-size:44px;margin:4px 0">${money(card.balance)}</h1>${card.balance !== card.initial_value ? `<p style="margin:0;color:#666">Original value ${money(card.initial_value)}</p>` : ''}${state ? `<p style="margin:12px 0 0;font-weight:600">${safe(state)}</p>` : ''}
${card.code ? `<p style="margin:28px 0 8px;color:#666;font-size:14px">Gift card code</p><p style="font:600 20px ui-monospace,Menlo,Consolas,monospace;letter-spacing:.08em;border:1px dashed #bbb;border-radius:8px;padding:12px;margin:0">${safe(card.code)}</p>` : ''}</section>
<p style="color:#666">Use this code at checkout, in the discount code or gift card field.</p><a href="/" style="display:inline-block;background:#1a1a1a;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">Start shopping</a></main></body></html>`;
}

function comingSoon(name: string): string {
  const safe = name.replace(/[<>&"]/g, '');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safe}</title><body style="font:16px/1.5 system-ui;display:grid;place-items:center;min-height:100vh;margin:0;background:#fafafa;color:#1a1a1a"><div style="text-align:center"><h1 style="font-size:28px;margin:0 0 8px">${safe}</h1><p style="color:#666">Opening soon.</p></div></body>`;
}

