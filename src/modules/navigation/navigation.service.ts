import { ApiError } from '../../core/ApiError';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { rolesRepository } from '../roles/roles.repository';
import { navigationRepository, type MenuItemRow } from './navigation.repository';

export interface MenuNode {
  id: number;
  key: string;
  title: string;
  subtitle: string | null;
  hover_description: string | null;
  icon: string | null;
  icon_color: string | null;
  icon_type: 'material' | 'custom' | 'emoji';
  route: string | null;
  /** Extra path prefixes that should mark this item active. */
  active_match: string[];
  section: string | null;
  group_key: string | null;
  badge: { key: string; count: number; variant: string } | null;
  status: 'available' | 'coming_soon';
  is_external: boolean;
  opens_new_tab: boolean;
  keyboard_shortcut: string | null;
  divider_after: boolean;
  show_in_collapsed: boolean;
  is_pinnable: boolean;
  analytics_key: string | null;
  metadata: Record<string, any> | null;
  children: MenuNode[];
}

export interface MenuSection {
  section: string;
  items: MenuNode[];
}

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

function canSee(row: MenuItemRow, admin: AuthenticatedAdmin): boolean {
  // Check is_visible flag (0 = hidden from everyone)
  if (row.is_visible === 0) return false;
  if (row.requires_super_admin === 1 && !admin.isSuperAdmin) return false;
  if (admin.isSuperAdmin) return true;
  // No permission rows at all = visible to every signed-in admin.
  if (!row.permission_slugs) return true;
  return row.permission_slugs.split(',').some((slug) => admin.permissions.has(slug));
}

function toNode(row: MenuItemRow, badges: Record<string, number>): MenuNode {
  return {
    id: row.id,
    key: row.menu_key,
    title: row.title,
    subtitle: row.subtitle,
    hover_description: row.hover_description || null,
    icon: row.icon,
    icon_color: row.icon_color || null,
    icon_type: (row.icon_type as any) || 'material',
    route: row.route,
    active_match: row.active_match ? row.active_match.split(',').map((s) => s.trim()).filter(Boolean) : [],
    section: row.section,
    group_key: row.group_key || null,
    badge:
      row.badge_key && badges[row.badge_key] > 0
        ? { key: row.badge_key, count: badges[row.badge_key], variant: row.badge_variant }
        : null,
    status: row.status === 'hidden' ? 'coming_soon' : row.status,
    is_external: row.is_external === 1,
    opens_new_tab: row.opens_new_tab === 1,
    keyboard_shortcut: row.keyboard_shortcut || null,
    divider_after: row.divider_after === 1,
    show_in_collapsed: row.show_in_collapsed === 1,
    is_pinnable: row.is_pinnable === 1,
    analytics_key: row.analytics_key || null,
    metadata: row.metadata ? (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata) : null,
    children: [],
  };
}

export const navigationService = {
  /**
   * GET /menu-navigation — the sidebar for whoever is asking.
   *
   * The menu is presentation only. Every route still enforces its own
   * permission, so hiding an item here is a convenience, never a control.
   */
  async forAdmin(admin: AuthenticatedAdmin): Promise<{
    sections: MenuSection[];
    flat: { key: string; route: string | null; status: string }[];
    generated_at: string;
  }> {
    const rows = await navigationRepository.allItems();
    const visible = rows.filter((row) => canSee(row, admin));

    // Only count badges this admin will actually see.
    const badgeKeys = Array.from(
      new Set(visible.map((row) => row.badge_key).filter((key): key is string => Boolean(key))),
    );
    const badges = await navigationRepository.badgeCounts(badgeKeys);

    const byId = new Map<number, MenuNode>();
    for (const row of visible) byId.set(row.id, toNode(row, badges));

    const roots: MenuNode[] = [];
    for (const row of visible) {
      const node = byId.get(row.id)!;
      // A child whose parent the admin cannot see is promoted to top level
      // rather than silently disappearing with it.
      const parent = row.parent_id !== null ? byId.get(row.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }

    // Drop group headers left with nothing under them — an Operations user
    // should not see an empty "Settings".
    const pruned = roots.filter((node) => node.route !== null || node.children.length > 0);

    const sections: MenuSection[] = [];
    for (const node of pruned) {
      const label = node.section ?? 'General';
      let bucket = sections.find((s) => s.section === label);
      if (!bucket) {
        bucket = { section: label, items: [] };
        sections.push(bucket);
      }
      bucket.items.push(node);
    }

    const flat = visible
      .filter((row) => row.route)
      .map((row) => ({ key: row.menu_key, route: row.route, status: row.status }));

    return { sections, flat, generated_at: new Date().toISOString() };
  },

  /** Super-admin view: everything, including hidden rows and their permissions. */
  async listAll() {
    const rows = await navigationRepository.allItems(true);
    return {
      menu_items: rows.map((row) => ({
        id: row.id,
        parent_id: row.parent_id,
        key: row.menu_key,
        title: row.title,
        subtitle: row.subtitle,
        icon: row.icon,
        route: row.route,
        section: row.section,
        badge_key: row.badge_key,
        sort_order: row.sort_order,
        status: row.status,
        is_active: row.is_active === 1,
        requires_super_admin: row.requires_super_admin === 1,
        is_system: row.is_system === 1,
        permissions: row.permission_slugs ? row.permission_slugs.split(',') : [],
      })),
    };
  },

  async update(
    id: number,
    input: {
      title?: string;
      subtitle?: string | null;
      icon?: string | null;
      section?: string | null;
      sort_order?: number;
      status?: 'available' | 'coming_soon' | 'hidden';
      is_active?: boolean;
      permission_slugs?: string[];
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await navigationRepository.findById(id);
    if (!existing) throw ApiError.notFound('Menu item');

    const fields: Record<string, unknown> = {};
    if (input.title !== undefined) fields.title = input.title;
    if (input.subtitle !== undefined) fields.subtitle = input.subtitle;
    if (input.icon !== undefined) fields.icon = input.icon;
    if (input.section !== undefined) fields.section = input.section;
    if (input.sort_order !== undefined) fields.sort_order = input.sort_order;
    if (input.status !== undefined) fields.status = input.status;
    if (input.is_active !== undefined) fields.is_active = input.is_active ? 1 : 0;

    let permissionIds: number[] | undefined;
    if (input.permission_slugs) {
      const all = await rolesRepository.allPermissions();
      const matched = all.filter((permission) => input.permission_slugs!.includes(permission.slug));
      const unknown = input.permission_slugs.filter(
        (slug) => !matched.some((permission) => permission.slug === slug),
      );
      if (unknown.length > 0) {
        throw ApiError.validation({ permission_slugs: [`Unknown permission(s): ${unknown.join(', ')}`] });
      }
      permissionIds = matched.map((permission) => permission.id);
    }

    await withTransaction(async (tx) => {
      if (Object.keys(fields).length > 0) await navigationRepository.update(id, fields, tx);
      if (permissionIds) await navigationRepository.setPermissions(id, permissionIds, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'menu_item.updated',
          entityType: 'menu_item',
          entityId: id,
          summary: `Updated menu item "${existing.title}"`,
          changes: {
            ...(auditService.diff(existing as unknown as Record<string, unknown>, fields) ?? {}),
            ...(input.permission_slugs ? { permissions: { to: input.permission_slugs } } : {}),
          },
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.listAll();
  },

  async reorder(items: { id: number; sort_order: number; parent_id?: number | null }[]) {
    await withTransaction(async (tx) => {
      await navigationRepository.reorder(items, tx);
    });
    return this.listAll();
  },
};
