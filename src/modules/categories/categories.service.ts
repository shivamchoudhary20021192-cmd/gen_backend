import { ApiError } from '../../core/ApiError';
import { slugify, uniqueSlug } from '../../core/slug';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { categoriesRepository, type CategoryRow } from './categories.repository';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface PresentedCategory {
  id: number;
  parent_id: number | null;
  slug: string;
  name: string;
  short_description: string | null;
  description: string | null;
  banner_media_id: number | null;
  thumbnail_media_id: number | null;
  path: string;
  depth: number;
  sort_order: number;
  is_active: boolean;
  show_in_menu: boolean;
  /** Products filed directly in this category. */
  product_count: number;
  /** ...plus everything in its descendants — matches ?category_id= filtering. */
  total_product_count: number;
  children?: PresentedCategory[];
}

function present(row: CategoryRow): PresentedCategory {
  return {
    id: row.id,
    parent_id: row.parent_id,
    slug: row.slug,
    name: row.name,
    short_description: row.short_description,
    description: row.description,
    banner_media_id: row.banner_media_id,
    thumbnail_media_id: row.thumbnail_media_id,
    path: row.path,
    depth: row.depth,
    sort_order: row.sort_order,
    is_active: row.is_active === 1,
    show_in_menu: row.show_in_menu === 1,
    // Fall back to the stored column only for rows read outside list() (which
    // is the one query that computes these); it is stale, but it is never the
    // number the list screen shows.
    product_count: Number(row.live_product_count ?? row.product_count),
    total_product_count: Number(
      row.subtree_product_count ?? row.live_product_count ?? row.product_count,
    ),
  };
}

/** Flat list → nested tree in one pass, without recursive queries. */
function buildTree(flat: PresentedCategory[]): PresentedCategory[] {
  const byId = new Map<number, PresentedCategory>();
  const roots: PresentedCategory[] = [];

  for (const node of flat) byId.set(node.id, { ...node, children: [] });
  for (const node of byId.values()) {
    if (node.parent_id && byId.has(node.parent_id)) byId.get(node.parent_id)!.children!.push(node);
    else roots.push(node);
  }
  return roots;
}

export const categoriesService = {
  async list(options: { tree?: boolean; includeInactive?: boolean }) {
    const rows = await categoriesRepository.list(options.includeInactive === true);
    const flat = rows.map(present);
    return { categories: options.tree ? buildTree(flat) : flat };
  },

  async get(id: number): Promise<PresentedCategory> {
    const row = await categoriesRepository.findById(id);
    if (!row) throw ApiError.notFound('Category');
    return present(row);
  },

  async create(
    input: {
      name: string;
      slug?: string;
      parent_id?: number | null;
      short_description?: string | null;
      description?: string | null;
      banner_media_id?: number | null;
      thumbnail_media_id?: number | null;
      sort_order?: number;
      is_active?: boolean;
      show_in_menu?: boolean;
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PresentedCategory> {
    let parentPath = '';
    let depth = 0;

    if (input.parent_id) {
      const parent = await categoriesRepository.findById(input.parent_id);
      if (!parent) throw ApiError.validation({ 'category.parent_id': ['Parent category does not exist.'] });
      if (parent.depth >= 3) throw ApiError.validation({ 'category.parent_id': ['Category nesting is limited to 4 levels.'] });
      parentPath = parent.path;
      depth = parent.depth + 1;
    }

    const slug = await uniqueSlug('categories', input.slug ?? input.name);

    const id = await withTransaction(async (tx) => {
      const newId = await categoriesRepository.create(
        {
          parentId: input.parent_id ?? null,
          slug,
          name: input.name,
          shortDescription: input.short_description ?? null,
          description: input.description ?? null,
          bannerMediaId: input.banner_media_id ?? null,
          thumbnailMediaId: input.thumbnail_media_id ?? null,
          path: parentPath ? `${parentPath}/${slug}` : slug,
          depth,
          sortOrder: input.sort_order ?? 0,
          isActive: input.is_active ?? true,
          showInMenu: input.show_in_menu ?? true,
        },
        tx,
      );

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'category.created',
          entityType: 'category',
          entityId: newId,
          summary: `Created category ${input.name}`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return newId;
    });

    return this.get(id);
  },

  async update(
    id: number,
    input: Record<string, unknown>,
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PresentedCategory> {
    const existing = await categoriesRepository.findById(id);
    if (!existing) throw ApiError.notFound('Category');

    const fields: Record<string, unknown> = {};
    if (typeof input.name === 'string') fields.name = input.name;
    if ('short_description' in input) fields.short_description = input.short_description ?? null;
    if ('description' in input) fields.description = input.description ?? null;
    if ('banner_media_id' in input) fields.banner_media_id = input.banner_media_id ?? null;
    if ('thumbnail_media_id' in input) fields.thumbnail_media_id = input.thumbnail_media_id ?? null;
    if (typeof input.sort_order === 'number') fields.sort_order = input.sort_order;
    if (typeof input.is_active === 'boolean') fields.is_active = input.is_active ? 1 : 0;
    if (typeof input.show_in_menu === 'boolean') fields.show_in_menu = input.show_in_menu ? 1 : 0;

    let newSlug: string | undefined;
    if (typeof input.slug === 'string' && slugify(input.slug) !== existing.slug) {
      newSlug = await uniqueSlug('categories', input.slug, id);
      fields.slug = newSlug;
    }

    let newParentId: number | null | undefined;
    if ('parent_id' in input) {
      newParentId = (input.parent_id as number | null) ?? null;
      if (newParentId === id) throw ApiError.validation({ 'category.parent_id': ['A category cannot be its own parent.'] });
      if (newParentId) {
        const parent = await categoriesRepository.findById(newParentId);
        if (!parent) throw ApiError.validation({ 'category.parent_id': ['Parent category does not exist.'] });
        // Reparenting into your own subtree would create a cycle.
        if (parent.path === existing.path || parent.path.startsWith(`${existing.path}/`)) {
          throw ApiError.validation({ 'category.parent_id': ['Cannot move a category into its own subtree.'] });
        }
      }
    }

    await withTransaction(async (tx) => {
      // A slug or parent change rewrites this node's path and every descendant's.
      if (newSlug !== undefined || newParentId !== undefined) {
        const effectiveSlug = newSlug ?? existing.slug;
        const parentId = newParentId !== undefined ? newParentId : existing.parent_id;
        let parentPath = '';
        let depth = 0;
        if (parentId) {
          const parent = await categoriesRepository.findById(parentId, tx);
          parentPath = parent?.path ?? '';
          depth = (parent?.depth ?? 0) + 1;
        }
        const newPath = parentPath ? `${parentPath}/${effectiveSlug}` : effectiveSlug;
        fields.parent_id = parentId;
        fields.path = newPath;
        fields.depth = depth;
        await categoriesRepository.rewriteDescendantPaths(existing.path, newPath, depth - existing.depth, tx);
      }

      await categoriesRepository.update(id, fields, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'category.updated',
          entityType: 'category',
          entityId: id,
          summary: `Updated category ${existing.name}`,
          changes: auditService.diff(existing as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const existing = await categoriesRepository.findById(id);
    if (!existing) throw ApiError.notFound('Category');

    const [children, products] = await Promise.all([
      categoriesRepository.countChildren(id),
      categoriesRepository.countProducts(id),
    ]);
    if (children > 0) throw ApiError.conflict(`Move or delete the ${children} sub-categories first.`, 'IN_USE');
    if (products > 0) throw ApiError.conflict(`${products} product(s) are still in this category.`, 'IN_USE');

    await withTransaction(async (tx) => {
      await categoriesRepository.softDelete(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'category.deleted',
          entityType: 'category',
          entityId: id,
          summary: `Deleted category ${existing.name}`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  },

  async reorder(items: { id: number; sort_order: number }[]): Promise<void> {
    await withTransaction(async (tx) => {
      await categoriesRepository.reorder(items, tx);
    });
  },
};
