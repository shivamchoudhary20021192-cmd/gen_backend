import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission, requireStaffPermissionOrApp } from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { themeFilesService } from './themeFiles.service';
import { themeResources } from './themeResources';
import { themesService } from './themes.service';

/**
 * Online Store → Themes (Admin API) and the storefront's theme endpoint.
 *
 * Reading is themes.view (or an app with read_themes); changing the live look
 * of the store is themes.manage.
 */
export const themesRoutes = Router();
themesRoutes.use(authenticate);

const canView = requireStaffPermissionOrApp('themes.view');
const canManage = requirePermission('themes.manage');

const idParam = z.object({ id: z.string().uuid() });
const settingValue = z.union([z.string().max(50_000), z.number(), z.boolean(), z.null(), z.array(z.string().max(255)).max(50)]);
const filePath = z.string().trim().min(3).max(255);

/** A theme zip: text files only, so a modest cap is plenty. */
const zipUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 1, fields: 5 },
});

function actor(req: Request) {
  return { id: req.admin?.id ?? null, label: req.admin?.email ?? null };
}

themesRoutes.get(
  '/library',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await themesService.catalog());
  }),
);

/** The live theme's alternate templates of a type: the "Theme template" select on a product, collection or page. */
themesRoutes.get(
  '/templates',
  canView,
  validate({ query: z.object({ type: z.enum(['product', 'collection', 'page', 'blog', 'article']) }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.templatesOf(String(req.query.type)));
  }),
);

/** What the editor's pickers choose from, by handle: products, collections, pages, blogs, menus. */
themesRoutes.get(
  '/resources',
  canView,
  validate({
    query: z.object({
      type: z.enum(['product', 'collection', 'page', 'blog', 'article', 'link_list']),
      q: z.string().trim().max(120).optional(),
      handles: z.string().trim().max(2000).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    const { type, q, handles } = req.query as { type: 'product'; q?: string; handles?: string };
    const list = handles ? handles.split(',').map((handle) => handle.trim()).filter(Boolean).slice(0, 50) : [];
    res.json({ resources: await themeResources.search(type, q ?? null, list) });
  }),
);

themesRoutes.get(
  '/',
  canView,
  asyncHandler(async (_req: Request, res: Response) => {
    res.json(await themesService.list());
  }),
);

themesRoutes.post(
  '/',
  canManage,
  validate({
    body: z.object({
      handle: z.string().trim().min(2).max(60),
      name: z.string().trim().max(120).optional(),
      preset: z.string().trim().max(60).nullish(),
      publish: z.boolean().optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await themesService.install(req.body, actor(req)));
  }),
);

themesRoutes.get(
  '/:id',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themesService.get(String(req.params.id)));
  }),
);

themesRoutes.patch(
  '/:id',
  canManage,
  validate({
    params: idParam,
    body: z.object({
      name: z.string().trim().max(120).optional(),
      preset: z.string().trim().max(60).nullish(),
      settings: z.record(z.string().max(60), settingValue).optional(),
    }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themesService.updateSettings(String(req.params.id), req.body, actor(req)));
  }),
);

for (const [path, action] of [
  ['publish', 'publish'],
  ['reset', 'reset'],
  ['upgrade', 'upgrade'],
] as const) {
  themesRoutes.post(
    `/:id/${path}`,
    canManage,
    validate({ params: idParam }),
    asyncHandler(async (req: Request, res: Response) => {
      res.json(await themesService[action](String(req.params.id), actor(req)));
    }),
  );
}

themesRoutes.post(
  '/:id/duplicate',
  canManage,
  validate({ params: idParam, body: z.object({ name: z.string().trim().max(120).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(201).json(await themesService.duplicate(String(req.params.id), actor(req), req.body?.name));
  }),
);

themesRoutes.delete(
  '/:id',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themesService.remove(String(req.params.id), actor(req)));
  }),
);

themesRoutes.get(
  '/:id/preview',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const theme = await themesService.get(String(req.params.id));
    res.json({ preview: theme.preview });
  }),
);

// ── the theme editor ─────────────────────────────────────────────────────────

themesRoutes.get(
  '/:id/editor',
  canView,
  validate({ params: idParam, query: z.object({ template: z.string().trim().max(80).optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await themeFilesService.editor(String(req.params.id), typeof req.query.template === 'string' ? req.query.template : null));
  }),
);

/** Unsaved editor changes: whole files (a JSON template, a section group, settings_data.json). */
themesRoutes.put(
  '/:id/drafts',
  canManage,
  validate({
    params: idParam,
    body: z.object({ files: z.array(z.object({ path: filePath, content: z.string().max(1_000_000).nullable() })).min(1).max(10) }),
  }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.putDrafts(String(req.params.id), req.body.files, actor(req)));
  }),
);

themesRoutes.delete(
  '/:id/drafts',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.discardDrafts(String(req.params.id)));
  }),
);

themesRoutes.post(
  '/:id/drafts/publish',
  canManage,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.publishDrafts(String(req.params.id), actor(req)));
  }),
);

// ── edit code ────────────────────────────────────────────────────────────────

themesRoutes.get(
  '/:id/files',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.list(String(req.params.id)));
  }),
);

themesRoutes.get(
  '/:id/files/content',
  canView,
  validate({ params: idParam, query: z.object({ path: filePath }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(await themeFilesService.read(String(req.params.id), String(req.query.path)));
  }),
);

themesRoutes.put(
  '/:id/files',
  canManage,
  validate({ params: idParam, body: z.object({ path: filePath, content: z.string().max(1_000_000), checksum: z.string().length(64).nullish() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.write(String(req.params.id), req.body, actor(req), 'code'));
  }),
);

themesRoutes.delete(
  '/:id/files',
  canManage,
  validate({ params: idParam, query: z.object({ path: filePath }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.remove(String(req.params.id), String(req.query.path), actor(req)));
  }),
);

themesRoutes.post(
  '/:id/files/rename',
  canManage,
  validate({ params: idParam, body: z.object({ from: filePath, to: filePath }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.rename(String(req.params.id), req.body.from, req.body.to, actor(req)));
  }),
);

themesRoutes.get(
  '/:id/files/versions',
  canView,
  validate({ params: idParam, query: z.object({ path: filePath }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.versions(String(req.params.id), String(req.query.path)));
  }),
);

themesRoutes.get(
  '/:id/versions/:versionId',
  canView,
  validate({ params: z.object({ id: z.string().uuid(), versionId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.version(String(req.params.id), Number(req.params.versionId)));
  }),
);

themesRoutes.post(
  '/:id/versions/:versionId/restore',
  canManage,
  validate({ params: z.object({ id: z.string().uuid(), versionId: z.coerce.number().int().positive() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await themeFilesService.restore(String(req.params.id), Number(req.params.versionId), actor(req)));
  }),
);

// ── download and upload ──────────────────────────────────────────────────────

themesRoutes.get(
  '/:id/download',
  canView,
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const { filename, zip } = await themeFilesService.download(String(req.params.id));
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(zip);
  }),
);

themesRoutes.post(
  '/upload',
  canManage,
  zipUpload.single('file'),
  asyncHandler(async (req: Request, res: Response) => {
    const file = (req as Request & { file?: Express.Multer.File }).file;
    if (!file) {
      res.status(422).json({ error: { code: 'VALIDATION_FAILED', message: 'Choose a theme .zip file.', details: { file: ['Choose a theme .zip file.'] } } });
      return;
    }
    const { id } = await themeFilesService.upload(file.buffer, actor(req));
    res.status(201).json(await themesService.get(id));
  }),
);

/**
 * GET /api/v1/theme — the storefront's look, for whichever shop the request
 * resolved to. `?preview=<theme id>` renders a draft for the editor; it is a
 * UUID only the merchant's admin has, and exposes nothing but presentation.
 */
export const storefrontThemeRoutes = Router();

storefrontThemeRoutes.get(
  '/theme',
  validate({ query: z.object({ preview: z.string().uuid().optional() }) }),
  asyncHandler(async (req: Request, res: Response) => {
    const preview = typeof req.query.preview === 'string' ? req.query.preview : null;
    const theme = await themesService.storefront(preview);
    res.setHeader('Cache-Control', preview ? 'no-store' : 'public, max-age=60');
    res.json({ theme });
  }),
);
