import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../../core/asyncHandler';
import { authenticate } from '../../../middleware/authenticate';
import { requirePermission } from '../../../middleware/requirePermission';
import { validate } from '../../../middleware/validate';
import { announcementsService, MAX_ROTATION_SECONDS, MIN_ROTATION_SECONDS, PAGE_TYPES } from './announcements.service';

const linkTypes = ['none', 'url', 'page', 'category', 'collection', 'product', 'article', 'policy'] as const;

const hex = z.string().regex(/^#[0-9A-Fa-f]{6}$/);
const visibility = z.enum(['all', 'desktop', 'mobile']);
const deviceChoice = z.enum(['all', 'desktop', 'mobile', 'none']);

const announcementSchema = z.object({
  message: z.string().trim().min(1).max(255),
  kind: z.enum(['message', 'free_shipping']).optional(),
  success_message: z.string().trim().max(255).nullish(),
  free_shipping_threshold: z.coerce.number().positive().max(10_000_000).nullish(),
  show_countdown: z.boolean().optional(),
  background_hex: hex.nullish(),
  text_hex: hex.nullish(),
  visibility: visibility.optional(),
  show_on: z.array(z.enum(PAGE_TYPES)).max(PAGE_TYPES.length).optional(),
  audience: z.enum(['all', 'guests', 'customers']).optional(),
  countries: z.array(z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/)).max(250).optional(),
  coupon_id: z.coerce.number().int().positive().nullish(),
  link_type: z.enum(linkTypes).optional(),
  link_url: z.string().trim().max(500).nullish(),
  link_ref_id: z.coerce.number().int().positive().nullish(),
  cta_label: z.string().trim().max(40).nullish(),
  starts_at: z.coerce.date().nullish(),
  ends_at: z.coerce.date().nullish(),
  is_active: z.boolean().optional(),
  sort_order: z.coerce.number().int().min(0).max(999).optional(),
});

const settingsSchema = z
  .object({
    is_enabled: z.boolean(),
    display_mode: z.enum(['rotate', 'marquee']),
    transition: z.enum(['fade', 'slide', 'slide_up', 'typewriter', 'none']),
    autoplay: z.boolean(),
    rotation_seconds: z.coerce.number().int().min(MIN_ROTATION_SECONDS).max(MAX_ROTATION_SECONDS),
    pause_on_hover: z.boolean(),
    marquee_speed: z.coerce.number().int().min(10).max(300),
    marquee_direction: z.enum(['left', 'right']),
    marquee_separator: z.string().max(8),
    height_mode: z.enum(['auto', 'uniform', 'fixed']),
    fixed_height_desktop: z.coerce.number().int().min(24).max(160),
    fixed_height_mobile: z.coerce.number().int().min(24).max(160),
    max_lines: z.coerce.number().int().min(1).max(3),
    font_size_desktop: z.coerce.number().int().min(10).max(24),
    font_size_mobile: z.coerce.number().int().min(10).max(22),
    font_weight: z.enum(['regular', 'medium', 'bold']),
    text_transform: z.enum(['none', 'uppercase']),
    text_align: z.enum(['center', 'left']),
    background_hex: hex.nullable(),
    background_gradient_hex: hex.nullable(),
    text_hex: hex.nullable(),
    bar_visibility: visibility,
    arrows_visibility: deviceChoice,
    link_arrow_visibility: deviceChoice,
    is_dismissible: z.boolean(),
    dismiss_days: z.coerce.number().int().min(0).max(365),
  })
  .partial()
  .strict();

const router = Router();

router.use(authenticate);

/**
 * Permissions ride on the banners' own, deliberately.
 *
 * This is the same job by a different name — the line above the header — and
 * inventing `announcements.*` would mean every existing content editor loses
 * access to a thing they could edit yesterday until somebody remembers to
 * re-grant it.
 */
const canRead = requirePermission('banners.read');
const canWrite = requirePermission('banners.update');

router.get('/settings', canRead, asyncHandler(async (_req: Request, res: Response) => {
  res.json({ settings: await announcementsService.settings() });
}));

router.patch(
  '/settings',
  canWrite,
  validate({ body: settingsSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ settings: await announcementsService.updateSettings(req.body as Record<string, unknown>) });
  }),
);

router.put(
  '/order',
  canWrite,
  validate({ body: z.object({ ids: z.array(z.coerce.number().int().positive()).max(50) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await announcementsService.reorder((req.body as { ids: number[] }).ids));
  }),
);

router.get('/', canRead, asyncHandler(async (_req: Request, res: Response) => {
  res.json(await announcementsService.list());
}));

router.post(
  '/',
  canWrite,
  validate({ body: announcementSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await announcementsService.create(req.body as Record<string, unknown>));
  }),
);

router.get('/:id', canRead, asyncHandler(async (req: Request, res: Response) => {
  res.json(await announcementsService.byId(Number(req.params.id)));
}));

router.patch(
  '/:id',
  canWrite,
  validate({ body: announcementSchema.partial() }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await announcementsService.update(Number(req.params.id), req.body as Record<string, unknown>));
  }),
);

router.delete('/:id', canWrite, asyncHandler(async (req: Request, res: Response) => {
  res.json(await announcementsService.remove(Number(req.params.id)));
}));

export { router as announcementsRoutes };
