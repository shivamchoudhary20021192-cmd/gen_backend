import type { Request, Response } from 'express';
import { ApiError } from '../../core/ApiError';
import { clientIp } from '../../middleware/requestContext';
import { authService, toPublicAdmin, type SessionActor } from './auth.service';
import { authRepository } from './auth.repository';
import { mfaService } from './mfa.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

/** The person and session behind the request; a shop only if they have one. */
function sessionActor(req: Request): SessionActor {
  const identity = req.identity;
  if (!identity) throw ApiError.unauthenticated();
  return { id: identity.id, email: identity.email, sessionId: identity.sessionId, shop: req.shop };
}

/**
 * Controllers do three things and nothing else: pull validated input off the
 * request, call one service method, shape the response envelope.
 */
export const authController = {
  async login(req: Request, res: Response): Promise<void> {
    const { email, password } = req.body as { email: string; password: string };
    const result = await authService.login(email, password, meta(req));
    res.status(200).json(result);
  },

  async completeMfaLogin(req: Request, res: Response): Promise<void> {
    const { mfa_token, code } = req.body as { mfa_token: string; code: string };
    res.status(200).json(await authService.completeMfaLogin(mfa_token, code, meta(req)));
  },

  async mfaStatus(req: Request, res: Response): Promise<void> {
    res.status(200).json({ mfa: await mfaService.status(req.identity!.id) });
  },

  async mfaSetup(req: Request, res: Response): Promise<void> {
    const { password } = req.body as { password: string };
    res.status(200).json(await mfaService.beginSetup(sessionActor(req), password));
  },

  async mfaEnable(req: Request, res: Response): Promise<void> {
    const { code } = req.body as { code: string };
    res.status(200).json(await mfaService.enable(sessionActor(req), code, meta(req)));
  },

  async mfaDisable(req: Request, res: Response): Promise<void> {
    const { password, code } = req.body as { password: string; code: string };
    res.status(200).json({ mfa: await mfaService.disable(sessionActor(req), password, code, meta(req)) });
  },

  async mfaRecoveryCodes(req: Request, res: Response): Promise<void> {
    const { code } = req.body as { code: string };
    res.status(200).json(await mfaService.regenerateRecoveryCodes(sessionActor(req), code, meta(req)));
  },

  async refresh(req: Request, res: Response): Promise<void> {
    const { refresh_token } = req.body as { refresh_token: string };
    const result = await authService.refresh(refresh_token, meta(req));
    res.status(200).json(result);
  },

  async logout(req: Request, res: Response): Promise<void> {
    await authService.logout(sessionActor(req), meta(req));
    res.status(204).send();
  },

  /** Who am I, where can I go, and where am I now. */
  async me(req: Request, res: Response): Promise<void> {
    const identity = req.identity!;
    const row = await authRepository.findById(identity.id);
    if (!row) throw ApiError.notFound('Account');

    const shops = await authService.listShops(identity.id);
    const admin = req.admin;
    res.status(200).json({
      admin: toPublicAdmin(row, admin?.isSuperAdmin ?? false),
      permissions: admin ? (admin.isSuperAdmin ? ['*'] : [...admin.permissions]) : [],
      is_super_admin: admin?.isSuperAdmin ?? false,
      is_shop_owner: admin?.isShopOwner ?? false,
      platform_role: identity.platformRole,
      shops,
      active_shop: admin ? (shops.find((shop) => shop.shop_id === admin.shop.id) ?? null) : null,
    });
  },

  async shops(req: Request, res: Response): Promise<void> {
    res.status(200).json({ shops: await authService.listShops(req.identity!.id) });
  },

  async switchShop(req: Request, res: Response): Promise<void> {
    const { shop } = req.body as { shop: string };
    res.status(200).json(await authService.switchShop(sessionActor(req), shop, meta(req)));
  },

  async changePassword(req: Request, res: Response): Promise<void> {
    const { current_password, new_password } = req.body as {
      current_password: string;
      new_password: string;
    };
    await authService.changePassword(sessionActor(req), current_password, new_password, meta(req));
    res.status(200).json({ message: 'Password updated. Other devices have been signed out.' });
  },

  async listSessions(req: Request, res: Response): Promise<void> {
    const sessions = await authService.listSessions(req.identity!.id);
    res.status(200).json({ sessions, current_session_id: req.identity!.sessionId });
  },

  async revokeSession(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    await authService.revokeSession(sessionActor(req), id);
    res.status(204).send();
  },
};
