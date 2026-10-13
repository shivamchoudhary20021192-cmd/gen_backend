import { Router, type Request, type Response } from 'express';
import { announcementsService } from '../announcements/announcements.service';
import { shelvesService } from '../../merchandising/shelves.service';
import { pageBuilderService } from '../page-builder/pageBuilder.service';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { rateLimit } from '../../../middleware/rateLimit';
import { validate } from '../../../middleware/validate';
import { publicArticleListQuerySchema, slugParamSchema } from '../articles/articles.schemas';
import { contentPublicService } from './contentPublic.service';

/**
 * The public face of the CMS: pages, the journal, banners and FAQs.
 *
 * Unauthenticated, like the rest of the storefront API, and mounted on the
 * storefront prefix rather than under the admin tree — the two route trees are
 * kept apart deliberately so an admin middleware can never be assumed to be
 * guarding something a visitor reaches.
 */

const PLACEMENTS = [
  'announcement_bar',
  'home_hero',
  'home_carousel',
  'category_top',
  'pdp_strip',
  'cart_drawer',
  'checkout',
  'popup',
  'footer',
] as const;

const browseLimit = rateLimit({ bucket: 'shop.content', max: 300, windowSeconds: 60 });
/**
 * Impressions and clicks are written by every page view, so this is the one
 * public endpoint that takes a write on ordinary browsing. Generous enough for
 * a real visitor, tight enough that the counters cannot be inflated at scale.
 */
const trackLimit = rateLimit({ bucket: 'shop.content.track', max: 120, windowSeconds: 60 });

const bannerQuerySchema = z.object({
  // Comma-separated so one request can fill every slot a page has.
  placement: z.string().trim().min(1).max(200),
});

const idParamSchema = z.object({ id: z.coerce.number().int().positive() });

export const contentPublicRoutes = Router();

// ── the strip above the header ──────────────────────────────────────────────
// Read on every page load, so it is the cheapest query in the content module:
// one indexed select and one settings row, both tiny.
contentPublicRoutes.get(
  '/announcements',
  browseLimit,
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await announcementsService.publicList());
  }),
);

// ── the merchandised shelves of a page ──────────────────────────────────────
//
// One request per page rather than one per shelf: the home page asks for its
// shelves once and gets them resolved, in order, with their products already
// in card shape. Rules that aggregate over orders are cached in the service
// for a few minutes, so this stays cheap under the traffic a front page takes.
//
// `scope` narrows a placement to one page — a category or collection slug — so
// "Bestsellers in Treat" and "Bestsellers everywhere" are the same endpoint.
contentPublicRoutes.get(
  '/shelves',
  browseLimit,
  validate({
    query: z.object({
      placement: z.enum(['home', 'shop', 'category', 'collection', 'product']).default('home'),
      category: z.string().trim().max(160).optional(),
      collection: z.string().trim().max(160).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { placement, category, collection } = req.query as {
      placement: 'home' | 'shop' | 'category' | 'collection' | 'product';
      category?: string;
      collection?: string;
    };
    const scope = category
      ? ({ kind: 'category', slug: category } as const)
      : collection
        ? ({ kind: 'collection', slug: collection } as const)
        : null;
    res.status(200).json(await shelvesService.publicList(placement, scope));
  }),
);

// ── a built page ────────────────────────────────────────────────────────────
//
// Every section of one page, in order, with its pictures, products, shelves
// and banners already resolved. One request per page rather than one per
// section: a page builder's promise is that a fifteenth section is free, and
// it is not free if each one opens its own connection.
contentPublicRoutes.get(
  '/page',
  browseLimit,
  validate({ query: z.object({ template: z.string().trim().min(1).max(60).default('home') }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await pageBuilderService.forStorefront(String((req.query as { template: string }).template)));
  }),
);

// ── pages ───────────────────────────────────────────────────────────────────
contentPublicRoutes.get(
  '/pages',
  browseLimit,
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await contentPublicService.pageIndex());
  }),
);

/**
 * A draft through its preview link (issued from the admin). Never cached and
 * never indexed: the link is a secret, and what it shows is not public yet.
 */
contentPublicRoutes.get(
  '/pages/preview/:token',
  browseLimit,
  validate({ params: z.object({ token: z.string().uuid() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.status(200).json(await contentPublicService.previewPage(String(req.params.token)));
  }),
);

contentPublicRoutes.get(
  '/pages/:slug',
  browseLimit,
  validate({ params: slugParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await contentPublicService.page(String(req.params.slug)));
  }),
);

// ── blogs ───────────────────────────────────────────────────────────────────
/**
 * The blogs that have something published in them.
 *
 * Listed before `/journal/:slug` so the literal path wins over the parameter —
 * a blog called "blogs" would otherwise be read as an article handle.
 */
contentPublicRoutes.get(
  '/blogs',
  browseLimit,
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await contentPublicService.journal.blogs());
  }),
);

// ── journal ─────────────────────────────────────────────────────────────────
contentPublicRoutes.get(
  '/journal',
  browseLimit,
  validate({ query: publicArticleListQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await contentPublicService.journal.list(req.query as Record<string, unknown>));
  }),
);

contentPublicRoutes.get(
  '/journal/:slug',
  browseLimit,
  validate({ params: slugParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await contentPublicService.journal.detail(String(req.params.slug)));
  }),
);

// ── banners ─────────────────────────────────────────────────────────────────
contentPublicRoutes.get(
  '/banners',
  browseLimit,
  validate({ query: bannerQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const requested = String(req.query.placement)
      .split(',')
      .map((value) => value.trim())
      .filter((value): value is (typeof PLACEMENTS)[number] =>
        (PLACEMENTS as readonly string[]).includes(value),
      );
    // An unknown placement is dropped rather than 400'd: a slot the site asks
    // for and this build does not know about should render nothing, not break
    // the page around it.
    res.status(200).json(await contentPublicService.banners([...new Set(requested)]));
  }),
);

contentPublicRoutes.post(
  '/banners/:id/impression',
  trackLimit,
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(202).json(await contentPublicService.trackBanner(Number(req.params.id), 'impression'));
  }),
);

contentPublicRoutes.post(
  '/banners/:id/click',
  trackLimit,
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(202).json(await contentPublicService.trackBanner(Number(req.params.id), 'click'));
  }),
);

// ── FAQs ────────────────────────────────────────────────────────────────────
contentPublicRoutes.get(
  '/faqs',
  browseLimit,
  validate({ query: z.object({ group: z.string().trim().max(140).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const group = typeof req.query.group === 'string' ? req.query.group : undefined;
    res.status(200).json(await contentPublicService.faqs(group));
  }),
);

contentPublicRoutes.post(
  '/faqs/:id/helpful',
  trackLimit,
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(202).json(await contentPublicService.markFaqHelpful(Number(req.params.id)));
  }),
);
