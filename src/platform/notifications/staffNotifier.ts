import { execute } from '../../db/pool';
import { logger } from '../../core/logger';
import { shopId } from '../tenancy/context';

/**
 * Notices for the people running a shop, shown in the admin's bell menu:
 * "your webhook endpoint was disabled", "your custom domain failed to verify".
 * A null recipient is everyone on the shop's staff.
 */
export const staffNotifier = {
  async notify(notice: {
    type: string;
    severity?: 'info' | 'success' | 'warning' | 'critical';
    title: string;
    body?: string;
    linkUrl?: string;
    entityType?: string;
    entityId?: number;
    adminUserId?: number | null;
  }): Promise<void> {
    try {
      await execute(
        `INSERT INTO admin_notifications (shop_id, admin_user_id, type, severity, title, body, link_url, entity_type, entity_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          notice.adminUserId ?? null,
          notice.type,
          notice.severity ?? 'info',
          notice.title.slice(0, 191),
          notice.body?.slice(0, 500) ?? null,
          notice.linkUrl ?? null,
          notice.entityType ?? null,
          notice.entityId ?? null,
        ],
      );
    } catch (error) {
      // A notice that fails to save must not fail the work it describes.
      logger.error('staff_notifier.failed', { type: notice.type, error: String(error) });
    }
  },
};
