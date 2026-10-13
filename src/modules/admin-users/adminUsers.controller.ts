import type { Request, Response } from 'express';
import { clientIp } from '../../middleware/requestContext';
import { adminUsersService } from './adminUsers.service';

function meta(req: Request) {
  return {
    ip: clientIp(req),
    userAgent: req.header('User-Agent')?.slice(0, 255) ?? null,
    requestId: req.requestId,
  };
}

export const adminUsersController = {
  async list(req: Request, res: Response): Promise<void> {
    const result = await adminUsersService.list(req.query as Record<string, unknown>);
    res.status(200).json(result);
  },

  async get(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ admin_user: await adminUsersService.get(id) });
  },

  async create(req: Request, res: Response): Promise<void> {
    const body = (req.body as { admin_user: Parameters<typeof adminUsersService.create>[0] }).admin_user;
    const created = await adminUsersService.create(body, req.admin!, meta(req));
    res.status(201).json({ admin_user: created });
  },

  async update(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const body = (req.body as { admin_user: Record<string, unknown> }).admin_user;
    res.status(200).json({ admin_user: await adminUsersService.update(id, body, req.admin!, meta(req)) });
  },

  async remove(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    await adminUsersService.remove(id, req.admin!, meta(req));
    res.status(204).send();
  },

  async setRoles(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const { role_ids } = req.body as { role_ids: number[] };
    res.status(200).json({ admin_user: await adminUsersService.setRoles(id, role_ids, req.admin!, meta(req)) });
  },

  async suspend(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ admin_user: await adminUsersService.setStatus(id, 'suspended', req.admin!, meta(req)) });
  },

  async resendInvitation(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await adminUsersService.resendInvitation(id, req.admin!, meta(req)));
  },

  async activate(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json({ admin_user: await adminUsersService.setStatus(id, 'active', req.admin!, meta(req)) });
  },

  async resetPassword(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    const { new_password, must_change_password, revoke_sessions } = req.body as {
      new_password: string;
      must_change_password: boolean;
      revoke_sessions: boolean;
    };
    await adminUsersService.resetPassword(
      id,
      new_password,
      { mustChange: must_change_password, revokeSessions: revoke_sessions },
      req.admin!,
      meta(req),
    );
    res.status(200).json({ message: 'Password reset.' });
  },

  async permissions(req: Request, res: Response): Promise<void> {
    const { id } = req.params as unknown as { id: number };
    res.status(200).json(await adminUsersService.permissions(id));
  },
};
