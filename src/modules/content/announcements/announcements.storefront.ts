import { Router, type NextFunction, type Request, type Response } from 'express';
import { rateLimit } from '../../../middleware/rateLimit';
import { requestHost } from '../../../platform/onlineStore/storefrontHttp';
import { announcementsService } from './announcements.service';

/**
 * POST /announcements/track on the Online Store: views and clicks of the
 * announcement bar's lines, sent by the theme only when the shopper has
 * allowed analytics. Counts, never identities: one day's total per line.
 *
 *   { "events": [{ "id": 12, "event": "view" }, { "id": 12, "event": "click" }] }
 */
export const announcementsStorefrontRoutes = Router();

announcementsStorefrontRoutes.post(
  '/announcements/track',
  rateLimit({ bucket: 'storefront.announcements', max: 120, windowSeconds: 600 }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const origin = req.get('origin');
      if (origin && origin !== `${req.protocol}://${requestHost(req)}`) {
        res.status(403).json({ error: 'cross_origin' });
        return;
      }
      const events = Array.isArray(req.body?.events) ? (req.body.events as unknown[]) : [];
      const valid = events
        .map((entry) => entry as { id?: unknown; event?: unknown })
        .filter((entry) => Number.isInteger(Number(entry.id)) && Number(entry.id) > 0 && (entry.event === 'view' || entry.event === 'click'))
        .map((entry) => ({ id: Number(entry.id), event: entry.event as 'view' | 'click' }));
      if (valid.length) await announcementsService.track(valid);
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  },
);
