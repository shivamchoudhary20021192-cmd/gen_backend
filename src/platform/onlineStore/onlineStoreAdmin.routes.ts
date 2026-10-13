import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { onlineStoreUrl } from '../shops/urls';
import { signPreview } from './previewTokens';
import { themesRepository } from '../themes/themes.repository';
import { shopId } from '../tenancy/context';
import { SUPPORTED_LANGUAGES, shopLanguages } from './languages';
import { onlineStorePreferences } from './preferences';
import { translationsAdmin, type ResourceKind } from './translationsAdmin';

/**
 * Admin API for the Online Store's settings that are not the theme:
 *
 *   GET/PUT  /online-store/preferences          customer accounts on or off
 *   GET      /online-store/languages            the store's languages, and what can be added
 *   POST     /online-store/languages            add one (unpublished)
 *   PATCH    /online-store/languages/:locale    publish / unpublish
 *   DELETE   /online-store/languages/:locale
 *   GET      /online-store/translations/:locale/:kind        originals beside translations
 *   PUT      /online-store/translations/:locale/:kind/:id    save a resource's translations
 */
export const onlineStoreAdminRoutes = Router();
onlineStoreAdminRoutes.use(authenticate);

const canView = requirePermission('settings.view');
const canManage = requirePermission('settings.manage');
const localeParam = z.object({ locale: z.string().trim().toLowerCase().regex(/^[a-z]{2}(-[a-z]{2})?$/) });
const KINDS = ['product', 'collection', 'page', 'article', 'link', 'theme'] as const;

onlineStoreAdminRoutes.get(
  '/preferences',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ preferences: await onlineStorePreferences.get(), storefront_url: onlineStoreUrl() });
  }),
);

onlineStoreAdminRoutes.put(
  '/preferences',
  canManage,
  validate({ body: z.object({ customer_accounts: z.enum(['optional', 'disabled']).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ preferences: await onlineStorePreferences.update(req.body) });
  }),
);

/** A link that shows the storefront in a language, published or not (it carries a preview grant). */
async function previewLink(code: string, primary: boolean) {
  const main = await themesRepository.main();
  const origin = onlineStoreUrl();
  const path = primary ? '/' : `/${code}`;
  if (!main) return `${origin}${path}`;
  const key = signPreview({ shopId: shopId(), themeId: main.public_id, design: false });
  return `${origin}${path}?preview_key=${encodeURIComponent(key)}`;
}

async function languagesPayload() {
  const languages = await shopLanguages.get();
  const added = new Set(languages.all.map((language) => language.code));
  return {
    primary: languages.primary,
    languages: await Promise.all(languages.all.map(async (language) => ({ ...language, preview_url: await previewLink(language.code, language.primary), theme_strings: SUPPORTED_LANGUAGES.find((entry) => entry.code === language.code)?.theme ?? false }))),
    available: SUPPORTED_LANGUAGES.filter((language) => !added.has(language.code)),
  };
}

onlineStoreAdminRoutes.get(
  '/languages',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await languagesPayload());
  }),
);

onlineStoreAdminRoutes.post(
  '/languages',
  canManage,
  validate({ body: localeParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await shopLanguages.add(req.body.locale);
    res.status(201).json(await languagesPayload());
  }),
);

onlineStoreAdminRoutes.patch(
  '/languages/:locale',
  canManage,
  validate({ params: localeParam, body: z.object({ published: z.boolean() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    await shopLanguages.setPublished(String(req.params.locale), req.body.published);
    res.json(await languagesPayload());
  }),
);

onlineStoreAdminRoutes.delete(
  '/languages/:locale',
  canManage,
  validate({ params: localeParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await shopLanguages.remove(String(req.params.locale));
    res.json(await languagesPayload());
  }),
);

onlineStoreAdminRoutes.get(
  '/translations/:locale',
  canView,
  validate({ params: localeParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await translationsAdmin.summary(String(req.params.locale)));
  }),
);

onlineStoreAdminRoutes.get(
  '/translations/:locale/:kind',
  canView,
  validate({
    params: localeParam.extend({ kind: z.enum(KINDS) }),
    query: z.object({ q: z.string().trim().max(120).optional(), page: z.coerce.number().int().positive().optional(), limit: z.coerce.number().int().positive().max(50).optional() }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const query = req.query as { q?: string; page?: number; limit?: number };
    res.json(await translationsAdmin.list(String(req.params.locale), req.params.kind as ResourceKind, query));
  }),
);

onlineStoreAdminRoutes.put(
  '/translations/:locale/:kind/:id',
  canManage,
  validate({
    params: localeParam.extend({ kind: z.enum(KINDS), id: z.coerce.number().int().positive() }),
    body: z.object({ fields: z.record(z.string().max(191), z.string().max(200_000)) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await translationsAdmin.save(String(req.params.locale), req.params.kind as ResourceKind, Number(req.params.id), req.body.fields));
  }),
);
