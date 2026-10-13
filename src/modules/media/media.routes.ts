import { Router, type Request, type Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { clientIp } from '../../middleware/requestContext';
import { requirePermission } from '../../middleware/requirePermission';
import { upload } from '../../middleware/upload';
import { validate } from '../../middleware/validate';
import { env } from '../../config/env';
import { idParamSchema } from '../auth/auth.schemas';
import { mediaService } from './media.service';
import { createFolderSchema, listMediaQuerySchema, updateMediaSchema, uploadBodySchema } from './media.schemas';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const mediaRoutes = Router();
mediaRoutes.use(authenticate);

mediaRoutes.get(
  '/',
  requirePermission('media.view'),
  validate({ query: listMediaQuerySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    res.status(200).json(await mediaService.list(req.query as Record<string, unknown>));
  }),
);

/**
 * multer runs BEFORE validate, because the body fields only exist once the
 * multipart stream has been parsed.
 */
mediaRoutes.post(
  '/',
  requirePermission('media.upload'),
  upload.array('files', env.storage.maxFilesPerRequest),
  validate({ body: uploadBodySchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[]) ?? [];
    const body = req.body as { folder_id?: number; alt_text?: string };
    const created = await mediaService.upload(
      files,
      { folderId: body.folder_id, altText: body.alt_text },
      req.admin!,
      meta(req),
    );
    res.status(201).json({ media: created, count: created.length });
  }),
);

mediaRoutes.get(
  '/folders',
  requirePermission('media.view'),
  asyncHandler(async (_req: Request, res: Response) => {
    res.status(200).json(await mediaService.listFolders());
  }),
);

mediaRoutes.post(
  '/folders',
  requirePermission('media.upload'),
  validate({ body: createFolderSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { folder } = req.body as { folder: { name: string; parent_id?: number | null } };
    res.status(201).json(await mediaService.createFolder(folder, req.admin!));
  }),
);

mediaRoutes.get(
  '/:id',
  requirePermission('media.view'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ media: await mediaService.get(id) });
  }),
);

mediaRoutes.patch(
  '/:id',
  requirePermission('media.upload'),
  validate({ params: idParamSchema, body: updateMediaSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { media: Record<string, unknown> }).media;
    res.status(200).json({ media: await mediaService.update(id, body, req.admin!, meta(req)) });
  }),
);

mediaRoutes.delete(
  '/:id',
  requirePermission('media.delete'),
  validate({ params: idParamSchema }),
  asyncHandler(async (req: Request, res: Response) => {
    const { id } = req.params as unknown as { id: number };
    await mediaService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  }),
);
