import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { ApiError } from '../../core/ApiError';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { rateLimit } from '../../middleware/rateLimit';
import {
  requireApp,
  requirePermission,
  requirePlatformAdmin,
  requireStaff,
} from '../../middleware/requirePermission';
import { validate } from '../../middleware/validate';
import { tenancy } from '../tenancy/context';
import { appsRepository, jsonList } from './apps.repository';
import { appsService, presentApp } from './apps.service';
import { OAuthError, oauthService } from './oauth.service';
import { ALL_SCOPES, describeScopes } from './scopes';
import { themeExtensions } from './themeExtensions';
import { readZip, ZipError } from '../themes/zip';
import multer from 'multer';

const httpsUrl = z
  .string()
  .trim()
  .url('Enter a full URL.')
  .max(500)
  .refine((value) => value.startsWith('https://') || value.startsWith('http://localhost'), 'Use an https URL.');

const scopeList = z.array(z.enum(ALL_SCOPES as [string, ...string[]])).max(40);

const authorizeQuery = z.object({
  client_id: z.string().trim().min(8).max(64),
  scope: z.string().trim().max(1000).optional(),
  redirect_uri: z.string().trim().url().max(500),
  state: z.string().trim().max(200).optional(),
});

const customAppBody = z.object({
  name: z.string().trim().min(2).max(120),
  scopes: scopeList.min(1, 'Choose at least one scope.'),
});

const storefrontTokenBody = z.object({ title: z.string().trim().min(2).max(120) });
const idParam = z.object({ id: z.coerce.number().int().positive() });
const publicIdParam = z.object({ id: z.string().uuid() });

const registerAppBody = z.object({
  name: z.string().trim().min(2).max(120),
  handle: z.string().trim().max(80).optional(),
  tagline: z.string().trim().max(200).nullish(),
  description: z.string().trim().max(5000).nullish(),
  icon_url: httpsUrl.nullish(),
  developer_name: z.string().trim().max(160).nullish(),
  developer_email: z.string().trim().email().max(190).nullish(),
  support_url: httpsUrl.nullish(),
  privacy_policy_url: httpsUrl.nullish(),
  app_url: httpsUrl.nullish(),
  compliance_webhook_url: httpsUrl.nullish(),
  redirect_urls: z.array(httpsUrl).min(1, 'Register at least one redirect URL.').max(10),
  requested_scopes: scopeList,
});

const updateAppBody = registerAppBody.partial().omit({ handle: true });

// ── Admin API: what a merchant (or an installed app) does with apps ─────────

export const adminAppsRoutes = Router();
// Mounted at the Admin API root, so authentication is scoped to this router's
// own paths; a router-wide `use(authenticate)` would turn every unmatched
// admin path into a 401 instead of a 404.
adminAppsRoutes.use(['/apps', '/oauth', '/api_permissions', '/storefront_access_tokens'], authenticate);

adminAppsRoutes.get(
  '/apps',
  requirePermission('apps.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ installations: await appsService.installations() });
  }),
);

adminAppsRoutes.get(
  '/apps/catalog',
  requirePermission('apps.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ apps: await appsService.catalog() });
  }),
);

adminAppsRoutes.get(
  '/apps/scopes',
  requirePermission('apps.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ scopes: describeScopes([...ALL_SCOPES]) });
  }),
);

adminAppsRoutes.delete(
  '/apps/installations/:id',
  requireStaff,
  requirePermission('apps.manage'),
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await appsService.uninstall(Number(req.params.id), { id: req.admin!.id, email: req.admin!.email });
    res.status(204).send();
  }),
);

/** Custom apps: built by this store for itself, with a token issued directly. */
adminAppsRoutes.get(
  '/apps/custom',
  requirePermission('apps.develop'),
  asyncHandler(async (_req: Request, res: Response) => {
    const apps = await appsRepository.listCustomFor(tenancy.current().id);
    res.json({ apps: apps.map(presentApp) });
  }),
);

adminAppsRoutes.post(
  '/apps/custom',
  requireStaff,
  requirePermission('apps.develop'),
  validate({ body: customAppBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await appsService.createCustomApp(req.shop!, req.body, { id: req.admin!.id, email: req.admin!.email });
    res.status(201).json({
      ...result,
      notice: 'Copy the access token and client secret now. They will not be shown again.',
    });
  }),
);

adminAppsRoutes.post(
  '/apps/custom/:id/access-token',
  requireStaff,
  requirePermission('apps.develop'),
  validate({ params: publicIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await appsRepository.findByPublicId(String(req.params.id));
    if (!app || app.distribution !== 'custom' || Number(app.owner_shop_id) !== req.shop!.id) throw ApiError.notFound('App');
    const installation = await appsRepository.findInstallation(app.id);
    if (!installation || installation.status !== 'active') throw ApiError.conflict('The app is not installed.');
    const token = await appsService.issueAccessToken(app, Number(installation.id), jsonList(installation.granted_scopes));
    res.status(201).json({ access_token: token, notice: 'The previous token has been revoked.' });
  }),
);

// ── theme app extensions ────────────────────────────────────────────────────

/** An extension bundle, as JSON ({ files: { path: content } }) or a zip upload (field "file"). */
const extensionUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 5 } });

function extensionFiles(req: Request): Map<string, string> {
  if (req.file) {
    try {
      const entries = readZip(req.file.buffer);
      // A zip made from a folder may wrap everything in one top-level directory.
      const paths = entries.map((entry) => entry.path);
      const prefix = paths.length && paths.every((path) => path.split('/')[0] === paths[0].split('/')[0]) && !['blocks', 'assets'].includes(paths[0].split('/')[0]) ? `${paths[0].split('/')[0]}/` : '';
      return new Map(entries.filter((entry) => !entry.path.endsWith('/')).map((entry) => [entry.path.slice(prefix.length), entry.data.toString('utf8')]));
    } catch (error) {
      if (error instanceof ZipError) throw ApiError.validation({ file: [error.message] });
      throw error;
    }
  }
  const files = (req.body?.files ?? null) as Record<string, unknown> | null;
  if (!files || typeof files !== 'object') throw ApiError.validation({ files: ['Send the extension as { files: { "blocks/x.liquid": "…" } } or as a zip.'] });
  return new Map(Object.entries(files).map(([path, content]) => [path, String(content ?? '')]));
}

async function ownCustomApp(req: Request) {
  const app = await appsRepository.findByPublicId(String(req.params.id));
  if (!app || app.distribution !== 'custom' || Number(app.owner_shop_id) !== req.shop!.id) throw ApiError.notFound('App');
  return app;
}

adminAppsRoutes.get(
  '/apps/custom/:id/theme-extension',
  requirePermission('apps.develop'),
  validate({ params: publicIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await ownCustomApp(req);
    res.json({ extension: await themeExtensions.forApp(app.id) });
  }),
);

adminAppsRoutes.put(
  '/apps/custom/:id/theme-extension',
  requireStaff,
  requirePermission('apps.develop'),
  extensionUpload.single('file'),
  validate({ params: publicIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await ownCustomApp(req);
    res.json({ extension: await themeExtensions.deploy(app.id, extensionFiles(req), req.admin?.email ?? null) });
  }),
);

adminAppsRoutes.delete(
  '/apps/custom/:id',
  requireStaff,
  requirePermission('apps.develop'),
  validate({ params: publicIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await appsRepository.findByPublicId(String(req.params.id));
    if (!app || app.distribution !== 'custom' || Number(app.owner_shop_id) !== req.shop!.id) throw ApiError.notFound('App');
    const installation = await appsRepository.findInstallation(app.id);
    if (installation?.status === 'active') {
      await appsService.uninstall(Number(installation.id), { id: req.admin!.id, email: req.admin!.email }, 'deleted');
    }
    await appsRepository.softDeleteApp(app.id);
    res.status(204).send();
  }),
);

/** The consent screen's data, then the approval that returns the redirect. */
adminAppsRoutes.get(
  '/oauth/authorize',
  requireStaff,
  requirePermission('apps.manage'),
  validate({ query: authorizeQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await oauthService.preview(req.query as z.infer<typeof authorizeQuery>, req.admin!));
  }),
);

adminAppsRoutes.post(
  '/oauth/authorize',
  requireStaff,
  requirePermission('apps.manage'),
  validate({ body: authorizeQuery }),
  asyncHandler(async (req: Request, res: Response) => {
    res.json(await oauthService.approve(req.body, req.admin!));
  }),
);

/** What this token may do. Shopify: GET /admin/oauth/access_scopes. */
adminAppsRoutes.get(
  '/oauth/access_scopes',
  requireApp,
  asyncHandler(async (req: Request, res: Response) => {
    res.json({ access_scopes: req.admin!.app!.scopes.map((handle) => ({ handle })) });
  }),
);

/** An app uninstalling itself. Shopify: DELETE /admin/api_permissions/current. */
adminAppsRoutes.delete(
  '/api_permissions/current',
  requireApp,
  asyncHandler(async (req: Request, res: Response) => {
    await appsService.uninstall(req.admin!.app!.installationId, null, 'uninstalled_by_app');
    res.status(204).send();
  }),
);

adminAppsRoutes.get(
  '/storefront_access_tokens',
  requirePermission('apps.develop'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.json({ storefront_access_tokens: await appsService.listStorefrontTokens() });
  }),
);

adminAppsRoutes.post(
  '/storefront_access_tokens',
  requirePermission('apps.develop'),
  validate({ body: storefrontTokenBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const appId = req.admin!.kind === 'app' ? req.admin!.app!.appId : null;
    res.status(201).json({
      storefront_access_token: await appsService.createStorefrontToken(req.body.title, { id: req.admin!.id, email: req.admin!.email }, appId),
    });
  }),
);

adminAppsRoutes.delete(
  '/storefront_access_tokens/:id',
  requirePermission('apps.develop'),
  validate({ params: idParam }),
  asyncHandler(async (req: Request, res: Response) => {
    await appsService.revokeStorefrontToken(Number(req.params.id));
    res.status(204).send();
  }),
);

// ── Public: the app server's side of OAuth ───────────────────────────────────

export const oauthPublicRoutes = Router();

oauthPublicRoutes.post(
  '/access_token',
  rateLimit({ bucket: 'oauth.token', max: 60, windowSeconds: 60 }),
  async (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as Record<string, string | undefined>;
      res.json(await oauthService.exchange({ client_id: body.client_id, client_secret: body.client_secret, code: body.code }));
    } catch (error) {
      // OAuth clients expect RFC 6749 errors, not the Admin API envelope.
      if (error instanceof OAuthError) {
        res.status(error.status).json({ error: error.error, error_description: error.description });
        return;
      }
      res.status(500).json({ error: 'server_error', error_description: 'Something went wrong on our side.' });
    }
  },
);

// ── Platform: operators curating the app store ──────────────────────────────

export const platformAppsRoutes = Router();

platformAppsRoutes.get(
  '/apps',
  asyncHandler(async (_req: Request, res: Response) => {
    const apps = await appsRepository.listAll();
    res.json({ apps: apps.map(presentApp) });
  }),
);

platformAppsRoutes.post(
  '/apps',
  requirePlatformAdmin,
  validate({ body: registerAppBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const result = await appsService.register(req.body, {
      distribution: 'public',
      ownerShopId: null,
      actor: { id: req.identity!.id, email: req.identity!.email },
    });
    res.status(201).json({ ...result, notice: 'Copy the client secret now. It will not be shown again.' });
  }),
);

platformAppsRoutes.patch(
  '/apps/:id',
  requirePlatformAdmin,
  validate({ params: publicIdParam, body: updateAppBody }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await appsRepository.findByPublicId(String(req.params.id));
    if (!app) throw ApiError.notFound('App');
    await appsRepository.updateApp(app.id, req.body);
    res.json({ app: presentApp((await appsRepository.findById(app.id))!) });
  }),
);

for (const [action, status] of [
  ['publish', 'published'],
  ['delist', 'delisted'],
] as const) {
  platformAppsRoutes.post(
    `/apps/:id/${action}`,
    requirePlatformAdmin,
    validate({ params: publicIdParam }),
    asyncHandler(async (req: Request, res: Response) => {
      const app = await appsRepository.findByPublicId(String(req.params.id));
      if (!app) throw ApiError.notFound('App');
      if (status === 'published' && app.distribution === 'public' && !app.compliance_webhook_url) {
        throw ApiError.validation({
          compliance_webhook_url: ['A public app must handle privacy requests before it can be published.'],
        });
      }
      await appsRepository.updateApp(app.id, { status });
      res.json({ app: presentApp((await appsRepository.findById(app.id))!) });
    }),
  );
}

/** A public app's theme extension, deployed by the platform on the developer's behalf. */
platformAppsRoutes.put(
  '/apps/:id/theme-extension',
  requirePlatformAdmin,
  extensionUpload.single('file'),
  validate({ params: publicIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await appsRepository.findByPublicId(String(req.params.id));
    if (!app) throw ApiError.notFound('App');
    res.json({ extension: await themeExtensions.deploy(app.id, extensionFiles(req), req.identity?.email ?? null) });
  }),
);

platformAppsRoutes.post(
  '/apps/:id/rotate-secret',
  requirePlatformAdmin,
  validate({ params: publicIdParam }),
  asyncHandler(async (req: Request, res: Response) => {
    const app = await appsRepository.findByPublicId(String(req.params.id));
    if (!app) throw ApiError.notFound('App');
    res.json({ ...(await appsService.rotateClientSecret(app)), notice: 'The previous secret stops working immediately.' });
  }),
);
