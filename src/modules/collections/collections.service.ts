import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { uniqueSlug } from '../../core/slug';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { collectionsRepository, type CollectionRow, type CollectionRuleRow } from './collections.repository';
import { compileRules } from './ruleCompiler';

const SORTABLE: Record<string, string> = {
  created_at: 'c.created_at',
  title: 'c.title',
  product_count: 'c.product_count',
  sort_order: 'c.sort_order',
};

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface RuleInput {
  field: string;
  operator: string;
  value: string | null;
}

function present(row: CollectionRow, rules: CollectionRuleRow[] = []) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    subtitle: row.subtitle,
    description: row.description,
    meta_title: row.meta_title,
    meta_description: row.meta_description,
    collection_type: row.collection_type,
    match_condition: row.match_condition,
    sort_type: row.sort_type,
    template_suffix: (row as { template_suffix?: string | null }).template_suffix ?? null,
    image_media_id: row.image_media_id,
    banner_media_id: row.banner_media_id,
    is_active: row.is_active === 1,
    show_in_menu: row.show_in_menu === 1,
    product_count: Number(row.live_product_count ?? row.product_count),
    published_at: row.published_at ? row.published_at.toISOString() : null,
    sort_order: row.sort_order,
    created_at: row.created_at.toISOString(),
    ...(row.collection_type === 'automatic'
      ? { rules: rules.map((r) => ({ field: r.field, operator: r.operator, value: r.value })) }
      : {}),
  };
}

export const collectionsService = {
  async list(queryParams: Record<string, unknown>): Promise<{ collections: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'c.sort_order ASC, c.created_at DESC');
    const filters = {
      search: queryParams.q as string | undefined,
      type: queryParams.type as string | undefined,
      active: queryParams.active as boolean | undefined,
    };
    const [rows, total] = await Promise.all([
      collectionsRepository.list(filters, orderBy, page.limit, page.offset),
      collectionsRepository.count(filters),
    ]);
    return { collections: rows.map((r) => present(r)), pagination: buildMeta(total, page) };
  },

  async get(id: number) {
    const row = await collectionsRepository.findById(id);
    if (!row) throw ApiError.notFound('Collection');
    const rules = row.collection_type === 'automatic' ? await collectionsRepository.rulesFor(id) : [];
    return present(row, rules);
  },

  async create(
    input: {
      title: string;
      slug?: string;
      subtitle?: string | null;
      description?: string | null;
      meta_title?: string | null;
      meta_description?: string | null;
      collection_type: 'manual' | 'automatic';
      match_condition?: 'all' | 'any';
      sort_type?: string;
      template_suffix?: string | null;
      image_media_id?: number | null;
      banner_media_id?: number | null;
      is_active?: boolean;
      show_in_menu?: boolean;
      rules?: RuleInput[];
      product_ids?: number[];
    },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    if (input.collection_type === 'automatic' && (!input.rules || input.rules.length === 0)) {
      throw ApiError.validation({ 'collection.rules': ['An automatic collection needs at least one rule.'] });
    }

    const slug = await uniqueSlug('collections', input.slug ?? input.title);

    const id = await withTransaction(async (tx) => {
      const newId = await collectionsRepository.create(
        {
          slug,
          title: input.title,
          subtitle: input.subtitle ?? null,
          description: input.description ?? null,
          metaTitle: input.meta_title ?? null,
          metaDescription: input.meta_description ?? null,
          collectionType: input.collection_type,
          matchCondition: input.match_condition ?? 'all',
          sortType: input.sort_type ?? 'manual',
          imageMediaId: input.image_media_id ?? null,
          bannerMediaId: input.banner_media_id ?? null,
          isActive: input.is_active ?? true,
          showInMenu: input.show_in_menu ?? false,
        },
        tx,
      );

      if (input.collection_type === 'automatic' && input.rules) {
        await collectionsRepository.replaceRules(newId, input.rules, tx);
      } else if (input.product_ids?.length) {
        for (const [index, productId] of input.product_ids.entries()) {
          await collectionsRepository.addMember(newId, productId, index, tx);
        }
      }
      await collectionsRepository.syncProductCount(newId, tx);

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'collection.created',
          entityType: 'collection',
          entityId: newId,
          summary: `Created ${input.collection_type} collection "${input.title}"`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return newId;
    });

    if (input.collection_type === 'automatic') await this.recalculate(id);
    return this.get(id);
  },

  async update(id: number, input: Record<string, unknown>, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await collectionsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Collection');

    const fields: Record<string, unknown> = {};
    if (typeof input.title === 'string') fields.title = input.title;
    if ('subtitle' in input) fields.subtitle = input.subtitle ?? null;
    if ('description' in input) fields.description = input.description ?? null;
    if ('meta_title' in input) fields.meta_title = input.meta_title ?? null;
    if ('meta_description' in input) fields.meta_description = input.meta_description ?? null;
    if ('image_media_id' in input) fields.image_media_id = input.image_media_id ?? null;
    if ('banner_media_id' in input) fields.banner_media_id = input.banner_media_id ?? null;
    if (typeof input.sort_type === 'string') fields.sort_type = input.sort_type;
    if ('template_suffix' in input) fields.template_suffix = input.template_suffix || null;
    if (typeof input.match_condition === 'string') fields.match_condition = input.match_condition;
    if (typeof input.sort_order === 'number') fields.sort_order = input.sort_order;
    if (typeof input.show_in_menu === 'boolean') fields.show_in_menu = input.show_in_menu ? 1 : 0;
    if (typeof input.is_active === 'boolean') {
      fields.is_active = input.is_active ? 1 : 0;
      if (input.is_active && !existing.published_at) fields.published_at = new Date();
    }
    if (typeof input.slug === 'string') fields.slug = await uniqueSlug('collections', input.slug, id);

    const rules = input.rules as RuleInput[] | undefined;

    await withTransaction(async (tx) => {
      if (Object.keys(fields).length > 0) await collectionsRepository.update(id, fields, tx);
      if (rules && existing.collection_type === 'automatic') {
        await collectionsRepository.replaceRules(id, rules, tx);
      }
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'collection.updated',
          entityType: 'collection',
          entityId: id,
          summary: `Updated collection "${existing.title}"`,
          changes: auditService.diff(existing as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    if (existing.collection_type === 'automatic' && (rules || 'match_condition' in input)) {
      await this.recalculate(id);
    }
    return this.get(id);
  },

  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const existing = await collectionsRepository.findById(id);
    if (!existing) throw ApiError.notFound('Collection');

    await withTransaction(async (tx) => {
      await collectionsRepository.softDelete(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'collection.deleted',
          entityType: 'collection',
          entityId: id,
          summary: `Deleted collection "${existing.title}"`,
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  },

  /**
   * Re-runs an automatic collection's rules and materialises the result into
   * collection_products. Pinned rows survive, so a merchandiser can force a
   * product into an otherwise rule-driven collection.
   */
  async recalculate(id: number): Promise<{ product_count: number }> {
    const collection = await collectionsRepository.findById(id);
    if (!collection) throw ApiError.notFound('Collection');
    if (collection.collection_type !== 'automatic') {
      throw ApiError.conflict('Only automatic collections can be recalculated.');
    }

    const rules = await collectionsRepository.rulesFor(id);
    const compiled = compileRules(
      rules.map((r) => ({ field: r.field, operator: r.operator, value: r.value })),
      collection.match_condition,
    );
    const productIds = await collectionsRepository.findProductsMatching(compiled.sql, compiled.params);

    await withTransaction(async (tx) => {
      await collectionsRepository.setMembers(id, productIds, tx);
      await collectionsRepository.syncProductCount(id, tx);
    });

    const refreshed = await collectionsRepository.findById(id);
    return { product_count: Number(refreshed?.product_count ?? 0) };
  },

  async addProduct(id: number, productId: number, position: number): Promise<void> {
    const collection = await collectionsRepository.findById(id);
    if (!collection) throw ApiError.notFound('Collection');
    await withTransaction(async (tx) => {
      await collectionsRepository.addMember(id, productId, position, tx);
      await collectionsRepository.syncProductCount(id, tx);
    });
  },

  async removeProduct(id: number, productId: number): Promise<void> {
    const collection = await collectionsRepository.findById(id);
    if (!collection) throw ApiError.notFound('Collection');
    const removed = await collectionsRepository.removeMember(id, productId);
    if (removed === 0) throw ApiError.notFound('Product in this collection');
    await collectionsRepository.syncProductCount(id);
  },

  /**
   * Replace a manual collection's membership in one call.
   *
   * The single-product endpoint is fine for a drag-and-drop nudge, but a
   * merchandiser picking thirty products in a dialog should not fire thirty
   * requests — half-applied membership after a dropped connection is the kind
   * of thing nobody notices until a storefront row is wrong.
   *
   * Automatic collections are refused outright: their membership is derived
   * from rules, so anything written here would be erased by the next
   * recalculation. Better a 422 than a change that silently disappears.
   */
  async setProducts(id: number, productIds: number[]): Promise<void> {
    const collection = await collectionsRepository.findById(id);
    if (!collection) throw ApiError.notFound('Collection');
    if (collection.collection_type === 'automatic') {
      throw ApiError.validation({
        'collection.product_ids': [
          'An automatic collection picks its own products from its rules. Edit the rules instead.',
        ],
      });
    }

    await withTransaction(async (tx) => {
      await collectionsRepository.clearMembers(id, tx);
      for (const [index, productId] of productIds.entries()) {
        await collectionsRepository.addMember(id, productId, index, tx);
      }
      await collectionsRepository.syncProductCount(id, tx);
    });
  },

  /**
   * The collections a product belongs to, as the product form needs them.
   *
   * `editable_here` is the honest bit: an automatic collection chose this
   * product from its rules, so the product page cannot remove it — only
   * changing the rules or the product can. Showing it without that flag would
   * invite a click that silently does nothing.
   */
  async forProduct(productId: number) {
    const rows = await collectionsRepository.forProduct(productId);
    return {
      collections: rows.map((row) => ({
        ...present(row),
        editable_here: row.collection_type === 'manual',
      })),
      manual_collection_ids: rows.filter((r) => r.collection_type === 'manual').map((r) => r.id),
    };
  },

  /**
   * Set which MANUAL collections a product belongs to, from the product form.
   *
   * Automatic memberships are deliberately untouched: they are derived, and a
   * write here would be undone by the next recalculation anyway. Every affected
   * collection's cached count is resynced — both the ones it left and the ones
   * it joined, which is easy to forget and shows up later as a wrong number in
   * the list.
   */
  async setProductCollections(productId: number, collectionIds: number[]) {
    const before = await collectionsRepository.forProduct(productId);
    const beforeManual = before.filter((c) => c.collection_type === 'manual').map((c) => c.id);

    for (const id of collectionIds) {
      const collection = await collectionsRepository.findById(id);
      if (!collection) throw ApiError.notFound('Collection');
      if (collection.collection_type === 'automatic') {
        throw ApiError.validation({
          'product.collection_ids': [
            `"${collection.title}" is an automatic collection — it picks its own products from its rules.`,
          ],
        });
      }
    }

    await withTransaction(async (tx) => {
      await collectionsRepository.clearManualMemberships(productId, tx);
      for (const id of collectionIds) {
        await collectionsRepository.addMember(id, productId, 0, tx);
      }
      for (const id of new Set([...beforeManual, ...collectionIds])) {
        await collectionsRepository.syncProductCount(id, tx);
      }
    });

    return this.forProduct(productId);
  },

  async reorder(id: number, productIds: number[]): Promise<void> {
    const collection = await collectionsRepository.findById(id);
    if (!collection) throw ApiError.notFound('Collection');
    await withTransaction(async (tx) => {
      for (const [index, productId] of productIds.entries()) {
        await collectionsRepository.addMember(id, productId, index, tx);
      }
      await collectionsRepository.syncProductCount(id, tx);
    });
  },
};
