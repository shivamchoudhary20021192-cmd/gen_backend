import type { Request, Response } from 'express';
import { clientIp } from '../../middleware/requestContext';
import { shippingService } from './shipping.service';
import { shippingZonesService } from './zones';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const shippingController = {
  // ── Rates ────────────────────────────────────────────────────────────────

  async listRates(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await shippingService.listRates());
  },

  async createRate(req: Request, res: Response): Promise<void> {
    res.status(201).json(await shippingService.createRate(req.body, req.admin!, meta(req)));
  },

  async updateRate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shippingService.updateRate(id, req.body, req.admin!, meta(req)));
  },

  async deleteRate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shippingService.deleteRate(id, req.admin!, meta(req)));
  },

  // ── Zones ────────────────────────────────────────────────────────────────

  async listZones(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await shippingZonesService.list());
  },

  async createZone(req: Request, res: Response): Promise<void> {
    res.status(201).json(await shippingZonesService.create(req.body, req.admin!, meta(req)));
  },

  async updateZone(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shippingZonesService.update(id, req.body, req.admin!, meta(req)));
  },

  async deleteZone(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shippingZonesService.remove(id, req.admin!, meta(req)));
  },

  async previewQuote(req: Request, res: Response): Promise<void> {
    res.status(200).json({ quote: await shippingZonesService.preview(req.body) });
  },

  // ── Carriers ─────────────────────────────────────────────────────────────

  async listCarriers(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await shippingService.listCarriers());
  },

  async updateCarrier(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shippingService.updateCarrier(id, req.body, req.admin!, meta(req)));
  },

  // ── COD Rules ────────────────────────────────────────────────────────────

  async listCodRules(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await shippingService.listCodRules());
  },

  async updateCodRule(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await shippingService.updateCodRule(id, req.body, req.admin!, meta(req)));
  },

  // ── Pincode Serviceability ───────────────────────────────────────────────

  async lookupPincode(req: Request, res: Response): Promise<void> {
    const { pincode } = req.params as { pincode: string };
    res.status(200).json(await shippingService.lookupPincode(pincode));
  },

  async upsertPincode(req: Request, res: Response): Promise<void> {
    res.status(200).json(await shippingService.upsertPincode(req.body, req.admin!, meta(req)));
  },
};
