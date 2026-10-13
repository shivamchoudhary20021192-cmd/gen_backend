import type { Request, Response } from 'express';
import { clientIp } from '../../middleware/requestContext';
import { paymentsService } from './payments.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const paymentsController = {
  async getSettings(_req: Request, res: Response): Promise<void> {
    res.status(200).json(await paymentsService.getSettings());
  },

  async updateSettings(req: Request, res: Response): Promise<void> {
    res.status(200).json(await paymentsService.updateSettings(req.body, req.admin!, meta(req)));
  },

  async listTransactions(req: Request, res: Response): Promise<void> {
    res.status(200).json(await paymentsService.listTransactions(req.query as Record<string, unknown>));
  },

  async getTransaction(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await paymentsService.getTransaction(id));
  },

  async listRefunds(req: Request, res: Response): Promise<void> {
    res.status(200).json(await paymentsService.listRefunds(req.query as Record<string, unknown>));
  },

  async listWebhooks(req: Request, res: Response): Promise<void> {
    res.status(200).json(await paymentsService.listWebhooks(req.query as Record<string, unknown>));
  },
};
