import type { Request, Response } from 'express';
import { clientIp } from '../../middleware/requestContext';
import { productsService } from './products.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const productsController = {
  async list(req: Request, res: Response): Promise<void> {
    res.status(200).json(await productsService.list(req.query as Record<string, unknown>));
  },

  async get(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ product: await productsService.get(id) });
  },

  async create(req: Request, res: Response): Promise<void> {
    const body = (req.body as { product: Parameters<typeof productsService.create>[0] }).product;
    const created = await productsService.create(body, req.admin!, meta(req));
    res.status(201).json({ product: created });
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { product: Parameters<typeof productsService.update>[1] }).product;
    res.status(200).json({ product: await productsService.update(id, body, req.admin!, meta(req)) });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    await productsService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  },

  async publish(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ product: await productsService.setStatus(id, 'active', req.admin!, meta(req)) });
  },

  async unpublish(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ product: await productsService.setStatus(id, 'draft', req.admin!, meta(req)) });
  },

  async archive(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ product: await productsService.setStatus(id, 'archived', req.admin!, meta(req)) });
  },

  async duplicate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(201).json({ product: await productsService.duplicate(id, req.admin!, meta(req)) });
  },

  async bulk(req: Request, res: Response): Promise<void> {
    const { ids, action, category_id } = req.body as {
      ids: number[];
      action: 'publish' | 'unpublish' | 'archive' | 'delete' | 'set_category';
      category_id?: number | null;
    };
    res.status(200).json(await productsService.bulk(ids, action, category_id, req.admin!, meta(req)));
  },

  async listVariants(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await productsService.listVariants(id));
  },

  async addVariant(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const { variant } = req.body as { variant: Parameters<typeof productsService.addVariant>[1] };
    res.status(201).json(await productsService.addVariant(id, variant, req.admin!, meta(req)));
  },

  async updateVariant(req: Request, res: Response): Promise<void> {
    const { id, variantId } = req.params as unknown as { id: number; variantId: number };
    const { variant } = req.body as { variant: Parameters<typeof productsService.updateVariant>[2] };
    res.status(200).json(await productsService.updateVariant(id, variantId, variant, req.admin!, meta(req)));
  },

  async removeVariant(req: Request, res: Response): Promise<void> {
    const { id, variantId } = req.params as unknown as { id: number; variantId: number };
    await productsService.removeVariant(id, variantId, req.admin!, meta(req));
    res.status(204).send();
  },

  async setShadeImages(req: Request, res: Response): Promise<void> {
    const id = Number(req.params.id);
    const optionValueId = Number(req.params.optionValueId);
    const { media_ids: mediaIds } = req.body as { media_ids: number[] };
    res.status(200).json({
      product: await productsService.setShadeImages(id, optionValueId, mediaIds, req.admin!),
    });
  },

  async attachImages(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const { images } = req.body as { images: Parameters<typeof productsService.attachImages>[1] };
    res.status(200).json({ product: await productsService.attachImages(id, images, req.admin!, meta(req)) });
  },

  async detachImage(req: Request, res: Response): Promise<void> {
    const { id, mediaId } = req.params as unknown as { id: number; mediaId: number };
    await productsService.detachImage(id, mediaId, req.admin!, meta(req));
    res.status(204).send();
  },

  async reorderImages(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const { media_ids } = req.body as { media_ids: number[] };
    res.status(200).json({ product: await productsService.reorderImages(id, media_ids) });
  },
};
