import type { Request, Response } from 'express';
import { clientIp } from '../../middleware/requestContext';
import { inventoryService } from './inventory.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const inventoryController = {
  // ── Stock levels ─────────────────────────────────────────────────────────

  async list(req: Request, res: Response): Promise<void> {
    res.status(200).json(await inventoryService.list(req.query as Record<string, unknown>));
  },

  async get(req: Request, res: Response): Promise<void> {
    const { variantId } = req.params as unknown as { variantId: number };
    const locationId = req.query.location_id ? Number(req.query.location_id) : undefined;
    res.status(200).json(await inventoryService.get(variantId, locationId));
  },

  // ── Adjustments ──────────────────────────────────────────────────────────

  async adjust(req: Request, res: Response): Promise<void> {
    const { variantId } = req.params as unknown as { variantId: number };
    const body = req.body as { quantity_delta: number; location_id?: number; reason: string };
    res.status(200).json(await inventoryService.adjust(variantId, body, req.admin!, meta(req)));
  },

  async setStock(req: Request, res: Response): Promise<void> {
    const { variantId } = req.params as unknown as { variantId: number };
    const body = req.body as { quantity: number; location_id?: number; reason: string };
    res.status(200).json(await inventoryService.setStock(variantId, body, req.admin!, meta(req)));
  },

  async bulkAdjust(req: Request, res: Response): Promise<void> {
    const body = req.body as {
      items: { variant_id: number; location_id?: number; quantity_delta: number }[];
      reason: string;
    };
    res.status(200).json(await inventoryService.bulkAdjust(body, req.admin!, meta(req)));
  },

  // ── Movements ────────────────────────────────────────────────────────────

  async movements(req: Request, res: Response): Promise<void> {
    res.status(200).json(await inventoryService.movements(req.query as Record<string, unknown>));
  },

  // ── Summary ──────────────────────────────────────────────────────────────

  async summary(req: Request, res: Response): Promise<void> {
    // Accepts the list's filters so a filtered table and its cards agree.
    res.status(200).json(await inventoryService.summary(req.query as Record<string, unknown>));
  },

  // ── Locations ────────────────────────────────────────────────────────────

  async listLocations(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await inventoryService.listLocations());
  },

  async getLocation(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await inventoryService.getLocation(id));
  },

  async createLocation(req: Request, res: Response): Promise<void> {
    const { location } = req.body as { location: Parameters<typeof inventoryService.createLocation>[0] };
    res.status(201).json(await inventoryService.createLocation(location, req.admin!, meta(req)));
  },

  async updateLocation(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const { location } = req.body as { location: Record<string, unknown> };
    res.status(200).json(await inventoryService.updateLocation(id, location, req.admin!, meta(req)));
  },
};
