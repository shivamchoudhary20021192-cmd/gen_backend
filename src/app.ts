import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import path from 'node:path';
import fs from 'node:fs';
import { env } from './config/env';
import { ApiError } from './core/ApiError';
import { asyncHandler } from './core/asyncHandler';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { requestContext } from './middleware/requestContext';
import { controlPlane, pool } from './db/pool';
import { podRouter } from './db/pods';
import { authRoutes } from './modules/auth/auth.routes';
import { adminUsersRoutes } from './modules/admin-users/adminUsers.routes';
import { permissionsRoutes, rolesRoutes } from './modules/roles/roles.routes';
import { creatorsRouter } from './modules/creators/creators.routes';
import {
  productSectionsRouter,
  sectionsRouter,
} from './modules/content/sections/sections.routes';
import { mediaRoutes } from './modules/media/media.routes';
import { categoriesRoutes } from './modules/categories/categories.routes';
import { collectionsRoutes, productCollectionsRoutes } from './modules/collections/collections.routes';
import { customersRoutes } from './modules/customers/customers.routes';
import { storefrontRoutes } from './modules/storefront/storefront.routes';
import { publicPaymentsRoutes } from './modules/payments/payments.public.routes';
import { shopAccountRoutes } from './modules/shop-account/shopAccount.routes';
import { reengagementRoutes } from './modules/reengagement/reengagement.routes';
import { ordersRoutes } from './modules/orders/orders.routes';
import { shipmentsRoutes } from './modules/shipments/shipments.routes';
import { returnsRoutes } from './modules/returns/returns.routes';
import { invoicesRoutes } from './modules/invoices/invoices.routes';
import { cartsRoutes } from './modules/carts/carts.routes';
import { reviewsRoutes } from './modules/reviews/reviews.routes';
import { productsRoutes } from './modules/products/products.routes';
import { catalogRoutes } from './modules/catalog/catalog.routes';
import { discountsRoutes, productDiscountsRoutes } from './modules/discounts/discounts.routes';
import { giftCardsRoutes } from './modules/giftCards/giftCards.routes';
import { privacyRoutes } from './platform/privacy/privacy.routes';
import { inventoryRoutes } from './modules/inventory/inventory.routes';
import { shippingRoutes } from './modules/shipping/shipping.routes';
import { taxRoutes } from './modules/tax/tax.routes';
import { marketsRoutes } from './modules/markets/markets.routes';
import { storefrontMarket, storefrontMarketRoutes } from './platform/markets/storefrontMarket';
import { paymentsRoutes } from './modules/payments/payments.routes';
import { menuItemsRoutes, menuNavigationRoutes } from './modules/navigation/navigation.routes';
import cmsNavigationRouter from './modules/navigation/cms-navigation.routes';
import dashboardRoutes from './modules/dashboard/dashboard.routes';
import { pagesRouter } from './modules/content/pages/pages.routes';
import bannersRouter from './modules/content/banners/banners.routes';
import faqsRouter from './modules/content/faqs/faqs.routes';
import { articlesRouter } from './modules/content/articles/articles.routes';
import { blogsRouter } from './modules/content/blogs/blogs.routes';
import { commentsRouter } from './modules/content/comments/comments.routes';
import { contentPublicRoutes } from './modules/content/public/contentPublic.routes';
import lookupsRoutes from './modules/lookups/lookups.routes';
import { linkTargetsRoutes } from './modules/link-targets/link-targets.routes';
import { announcementsRoutes } from './modules/content/announcements/announcements.routes';
import { shelvesRoutes } from './modules/merchandising/shelves.routes';
import { pageBuilderRoutes } from './modules/content/page-builder/pageBuilder.routes';
import sidebarRoutes from './modules/sidebar/sidebar.routes';
import segmentsRoutes from './modules/segments/segments.routes';
import { messagingRoutes } from './modules/messaging/messaging.routes';
import { LocalDiskDriver } from './modules/media/storage';
import { platformRoutes } from './platform/admin/platform.routes';
import { billingWebhooks } from './platform/billing/billingWebhooks';
import { apiVersion } from './platform/api/versions';
import { adminAppsRoutes, oauthPublicRoutes } from './platform/apps/apps.routes';
import { inboundRoutes } from './platform/integrations/inbound';
import { integrationsRoutes } from './platform/integrations/integrations.routes';
import './platform/integrations/providers';
import { notificationPreferencesRoutes } from './platform/notifications/notifications.routes';
import { metrics } from './platform/observability/metrics';
import { normaliseHostname, shopDirectory } from './platform/shops/shopDirectory';
import { billingRoutes, identityShopsRoutes, shopAdminRoutes, signupRoutes } from './platform/shops/shops.routes';
import { domainsRoutes } from './platform/domains/domains.routes';
import { edgeRoutes } from './platform/domains/edge.routes';
import { resolveStorefrontShop } from './platform/tenancy/resolveShop';
import { storefrontGate, storefrontGateRoutes } from './platform/tenancy/storefrontGate';
import { storefrontThemeRoutes, themesRoutes } from './platform/themes/themes.routes';
import { onlineStoreRoutes } from './platform/onlineStore/onlineStore.routes';
import { contactMessagesRoutes } from './platform/onlineStore/contactMessages';
import { onlineStoreAdminRoutes } from './platform/onlineStore/onlineStoreAdmin.routes';
import { webhooksRoutes } from './platform/webhooks/webhooks.routes';
import { newsletterAdminRoutes, newsletterStorefrontRoutes } from './modules/newsletter/newsletter.routes';
import { auditRoutes } from './modules/audit/audit.routes';

export function createApp(): Express {
  const app = express();

  // Behind nginx/ALB this makes req.ip and X-Forwarded-For trustworthy, which
  // the rate limiter and the audit trail both depend on.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use(
    helmet({
      // The API returns JSON, not documents; CSP belongs on the storefront.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  const corsPolicy = cors({
    origin: (origin, callback) => {
      // Server-to-server calls and curl have no Origin header.
      if (!origin || allowedStaticOrigin(origin)) return callback(null, true);
      // A storefront on a shop's own domain calling the Storefront API.
      void isShopOrigin(origin)
        .then((ok) =>
          ok
            ? callback(null, true)
            : callback(
                // Saying which origin was refused turns an hour of guessing
                // into a one-line fix, especially behind a reverse proxy.
                ApiError.forbidden(
                  `Origin ${origin} is not allowed. Add it to CORS_ORIGINS, or connect it to a store as a domain.`,
                  { origin },
                ),
              ),
        )
        .catch(() => callback(ApiError.forbidden(`Origin ${origin} is not allowed.`, { origin })));
    },
    credentials: true,
    exposedHeaders: [
      'X-Request-Id',
      'X-RateLimit-Remaining',
      'Retry-After',
      'Idempotent-Replay',
      'X-Veylog-Api-Version',
      'X-Veylog-Api-Version-Warning',
    ],
  });
  // A page calling its own origin (the Online Store's cart and checkout on a
  // shop's domain) is not a cross-origin request; CORS only governs the rest.
  app.use((req: Request, res: Response, next: NextFunction) => {
    // Under a no-referrer policy a same-origin form POST arrives as `Origin: null`;
    // the browser's own Sec-Fetch-Site still says where it came from.
    if (req.header('Sec-Fetch-Site') === 'same-origin') return next();
    const origin = req.header('Origin');
    if (origin) {
      try {
        if (new URL(origin).host === req.get('host')) return next();
      } catch {
        /* a malformed Origin goes through the policy and is refused there */
      }
    }
    corsPolicy(req, res, next);
  });

  app.use(compression());

  // ── provider webhooks ─────────────────────────────────────────────────────
  // Before any body parser: every provider signs the exact bytes it sent, in
  // whatever content type it likes (JSON, form-encoded), so these routes get
  // the raw buffer and nothing else.
  app.use(
    '/integrations',
    express.raw({ type: () => true, limit: '2mb' }),
    (req: Request, _res: Response, next: NextFunction) => {
      req.rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      next();
    },
    inboundRoutes,
  );

  app.use(
    express.json({
      limit: '2mb',
      /**
       * Keeps the raw bytes for the payment webhook, and only for it.
       *
       * Razorpay signs the exact body it sent. Re-serialising the parsed object
       * changes key order, whitespace and number formatting, so a webhook
       * verified against `JSON.stringify(req.body)` fails intermittently in a
       * way that looks like the gateway's fault. Scoped to the one path so
       * every other request is parsed and the buffer dropped as before.
       */
      verify: (req, _res, buf) => {
        if (req.url?.includes('/webhook')) {
          (req as typeof req & { rawBody?: Buffer }).rawBody = Buffer.from(buf);
        }
      },
    }),
  );
  app.use(express.urlencoded({ extended: true, limit: '2mb' }));
  app.use(requestContext);

  // ── health and metrics ────────────────────────────────────────────────────
  // /health/live: the process is up (for restarts). /health/ready: every
  // database this process talks to answers (for load balancers). /health is
  // kept as it was for existing monitors.
  app.get('/health/live', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', uptime_seconds: Math.round(process.uptime()) });
  });

  app.get(
    '/health/ready',
    asyncHandler(async (_req: Request, res: Response) => {
      const checks: Record<string, 'ok' | 'down'> = {};
      const ping = async (name: string, target: typeof controlPlane) => {
        try {
          await target.query('SELECT 1');
          checks[name] = 'ok';
        } catch {
          checks[name] = 'down';
        }
      };
      await ping('control_plane', controlPlane);
      for (const podId of podRouter.configuredPods()) await ping(`pod_${podId}`, podRouter.poolFor(podId));
      const ready = Object.values(checks).every((status) => status === 'ok');
      res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'degraded', checks });
    }),
  );

  app.get(
    '/health',
    asyncHandler(async (_req: Request, res: Response) => {
      const conn = await controlPlane.getConnection();
      try {
        await conn.ping();
      } finally {
        conn.release();
      }
      res.status(200).json({
        status: 'ok',
        service: 'veylog-api',
        database: 'connected',
        storage: env.storage.driver,
        uptime_seconds: Math.round(process.uptime()),
      });
    }),
  );

  // Prometheus. Protected by METRICS_TOKEN when set; without one it is only
  // served outside production.
  app.get(
    '/metrics',
    asyncHandler(async (req: Request, res: Response) => {
      const token = process.env.METRICS_TOKEN;
      if (token ? req.header('Authorization') !== `Bearer ${token}` : env.nodeEnv === 'production') {
        res.status(404).end();
        return;
      }
      res.setHeader('Content-Type', 'text/plain; version=0.0.4');
      res.send(await metrics.render());
    }),
  );

  // ── media file serving (local driver only) ────────────────────────────────
  // Deliberately a route rather than express.static pointed at the upload dir:
  // this way the path is validated by the driver, unknown keys 404 cleanly, and
  // the cache header is ours to set. Behind a CDN in production.
  if (env.storage.driver === 'local') {
    const driver = new LocalDiskDriver();
    app.get(`${env.storage.localBaseUrl}/*`, (req: Request, res: Response) => {
      const key = decodeURIComponent(req.path.slice(env.storage.localBaseUrl.length + 1));
      let absolute: string;
      try {
        absolute = driver.absolutePath(key);
      } catch {
        res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid media path.' } });
        return;
      }
      if (!fs.existsSync(absolute)) {
        res.status(404).json({ error: { code: 'NOT_FOUND', message: 'File not found.' } });
        return;
      }
      // Storage keys embed a UUID, so a given key's bytes never change.
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.sendFile(absolute);
    });
  }

  // ── admin API ─────────────────────────────────────────────────────────────
  const api = express.Router();
  api.use('/auth', authRoutes);
  api.use('/admin-users', adminUsersRoutes);
  api.use('/roles', rolesRoutes);
  api.use('/permissions', permissionsRoutes);
  api.use('/media', mediaRoutes);
  api.use('/creators', creatorsRouter);
  api.use('/content/sections', sectionsRouter);
  // Mounted under the product because that is where someone edits it, and
  // mergeParams is what lets the router read :productId.
  api.use('/products/:productId/sections', productSectionsRouter);
  api.use('/categories', categoriesRoutes);
  api.use('/collections', collectionsRoutes);
  api.use('/products', productsRoutes);
  // Products (new): the generic catalog, beside the classic one until it replaces it.
  api.use('/catalog', catalogRoutes);
  // Second router on the same mount: /products/:id/discounts lives in the
  // discounts module, everything else stays in products.
  api.use('/products', productDiscountsRoutes);
  api.use('/products', productCollectionsRoutes);
  api.use('/inventory', inventoryRoutes);
  api.use('/discounts', discountsRoutes);
  api.use('/gift-cards', giftCardsRoutes);
  // Customers → Consents & privacy, Settings → Customer privacy and Policies.
  api.use('/privacy', privacyRoutes);
  api.use('/orders', ordersRoutes);
  api.use('/customers', customersRoutes);
  api.use('/shipments', shipmentsRoutes);
  api.use('/shipping', shippingRoutes);
  api.use('/tax', taxRoutes);
  api.use('/markets', marketsRoutes);
  api.use('/payments', paymentsRoutes);
  api.use('/returns', returnsRoutes);
  api.use('/invoices', invoicesRoutes);
  api.use('/carts', cartsRoutes);
  api.use('/reviews', reviewsRoutes);
  api.use('/menu-navigation', menuNavigationRoutes);
  api.use('/menu-items', menuItemsRoutes);
  api.use('/dashboard', dashboardRoutes);
  api.use('/reengagement', reengagementRoutes);
  api.use('/content/pages', pagesRouter);
  api.use('/content/banners', bannersRouter);
  api.use('/content/announcements', announcementsRoutes);
  api.use('/merchandising/shelves', shelvesRoutes);
  api.use('/content/page-builder', pageBuilderRoutes);
  api.use('/content/blogs', blogsRouter);
  api.use('/content/comments', commentsRouter);
  api.use('/content/articles', articlesRouter);
  api.use('/content', faqsRouter);
  api.use('/cms', cmsNavigationRouter);
  api.use('/lookups', lookupsRoutes);
  api.use('/link-targets', linkTargetsRoutes);
  api.use('/sidebar', sidebarRoutes);
  // Its own paths are absolute: /segments, /tags, /customers/:customerId/tags.
  api.use(segmentsRoutes);
  // Templates, senders, campaigns and the outbox. One prefix because they are
  // one subject: nothing here makes sense without the other three.
  api.use('/messaging', messagingRoutes);

  // ── the platform, from inside a shop ──
  api.use('/shop', shopAdminRoutes);
  api.use('/shops', identityShopsRoutes);
  api.use('/domains', domainsRoutes);
  api.use('/billing', billingRoutes);
  api.use('/themes', themesRoutes);
  api.use('/integrations', integrationsRoutes);
  api.use('/webhooks', webhooksRoutes);
  api.use('/notifications/preferences', notificationPreferencesRoutes);
  api.use('/newsletter', newsletterAdminRoutes);
  // The Online Store's contact form inbox.
  api.use('/contact-messages', contactMessagesRoutes);
  // Online Store settings beyond the theme: customer accounts, languages, translations.
  api.use('/online-store', onlineStoreAdminRoutes);
  api.use('/audit', auditRoutes);
  // Apps, OAuth consent, custom apps and storefront tokens. Last, because it
  // is mounted at the root and owns several top-level paths.
  api.use(adminAppsRoutes);

  // Date-versioned, like Shopify's: /admin/api/2026-10/products. The existing
  // admin frontend's /admin/api/v1 is an alias for the first version.
  app.use('/admin/api/:version', apiVersion, api);
  if (!/^\/admin\/api\/[^/]+$/.test(env.apiPrefix)) app.use(env.apiPrefix, api);

  // The app server's side of OAuth: exchanging an authorization code for an
  // offline access token. Public; the client secret is the credential.
  app.use('/admin/oauth', oauthPublicRoutes);

  // ── public storefront API ─────────────────────────────────────────────────
  // A separate tree from the admin API: nothing here is staff-authenticated,
  // and keeping the two apart means an admin middleware can never be assumed
  // to be protecting a public route. Every request first resolves the shop it
  // is for (storefront token, declared domain, Host, or the only shop), then
  // passes the password gate if the shop is not open yet.
  const storefront = express.Router();
  storefront.use(resolveStorefrontShop, storefrontGate);
  // Prices in the shopper's market: their country's currency, adjusted and rounded.
  storefront.use(storefrontMarket);
  storefront.use(storefrontMarketRoutes);
  storefront.use(storefrontGateRoutes);
  storefront.use(storefrontThemeRoutes);
  storefront.use(storefrontRoutes);
  // The mailing list: sign up from the footer or the password page, leave by link.
  storefront.use(newsletterStorefrontRoutes);
  // Pages, the journal, banners and FAQs — published-only reads.
  storefront.use('/content', contentPublicRoutes);
  // Payment start/verify, and the legacy Razorpay webhook.
  storefront.use('/payments', publicPaymentsRoutes);
  // Customer accounts: phone sign-in, saved products, the marketing opt-in.
  storefront.use('/account', shopAccountRoutes);
  app.use('/api/v1', storefront);

  // ── platform API ──────────────────────────────────────────────────────────
  // Signing up is public; everything else is for platform operators.
  // The platform's processor reporting on bills: signed, not signed in — so before the operators' routes.
  app.post('/platform/api/v1/billing/webhooks/stripe', async (req: Request, res: Response) => {
    const result = await billingWebhooks.stripe((req as Request & { rawBody?: Buffer }).rawBody, req.get('stripe-signature'));
    res.status(result.status).json(result.body);
  });
  app.use('/platform/api/v1', signupRoutes);
  app.use('/platform/api/v1', platformRoutes);

  // ── the Online Store ──────────────────────────────────────────────────────
  // Server-rendered theme pages on a shop's own domain. Last, so every API
  // path above wins; it passes on any host that is not a storefront.
  // What the edge asks: may a certificate be issued for this host, where does it route.
  app.use(edgeRoutes);
  app.use(onlineStoreRoutes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/** The admin frontends and anything listed in CORS_ORIGINS. */
function allowedStaticOrigin(origin: string): boolean {
  return env.corsOrigins.includes(origin) || origin === env.platform.adminUrl;
}

/**
 * Whether an origin is one of the platform's storefronts: a shop's platform
 * subdomain, or a custom domain some shop has verified.
 */
async function isShopOrigin(origin: string): Promise<boolean> {
  let hostname: string;
  try {
    const url = new URL(origin);
    if (url.protocol !== 'https:' && env.nodeEnv === 'production') return false;
    hostname = normaliseHostname(url.hostname);
  } catch {
    return false;
  }
  if (hostname.endsWith(`.${env.platform.storefrontDomain}`)) return true;
  return (await shopDirectory.byHostname(hostname)) !== null;
}

export const projectRoot = path.resolve(__dirname, '..');
