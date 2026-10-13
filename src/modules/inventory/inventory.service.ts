import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { productsRepository } from '../products/products.repository';
import { storage } from '../media/storage';
import {
  inventoryRepository,
  type StockFilters,
  type StockLevelRow,
  type MovementRow,
  type LocationRow,
} from './inventory.repository';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

const STOCK_SORTABLE: Record<string, string> = {
  sku: 'v.sku',
  product_name: 'p.name',
  quantity_on_hand: 'ii.quantity_on_hand',
  quantity_available: 'ii.quantity_available',
  updated_at: 'ii.updated_at',
};

function presentStockLevel(row: StockLevelRow) {
  return {
    inventory_item_id: row.inventory_item_id,
    variant_id: row.variant_id,
    location_id: row.location_id,
    sku: row.sku,
    barcode: row.barcode,
    variant_title: row.variant_title,
    product_id: row.product_id,
    product_name: row.product_name,
    product_status: row.product_status,
    track_inventory: row.track_inventory === 1,
    allow_backorder: row.allow_backorder === 1,
    low_stock_threshold: row.low_stock_threshold,
    quantity_on_hand: row.quantity_on_hand,
    quantity_reserved: row.quantity_reserved,
    quantity_available: row.quantity_available,
    quantity_incoming: row.quantity_incoming,
    safety_stock: row.safety_stock,
    bin_location: row.bin_location,
    last_counted_at: row.last_counted_at,
    location_code: row.location_code,
    location_name: row.location_name,
    // Computed by the same SQL expression that drives the low/out-of-stock
    // counters, so the badge can never disagree with the card above it.
    stock_state: row.stock_state,
    image: row.primary_image_key ? storage.publicUrl(row.primary_image_key) : null,
    updated_at: row.updated_at,
  };
}

function presentSummary(row: {
  total_skus: number; total_on_hand: number; total_available: number;
  low_stock_count: number; out_of_stock_count: number;
}) {
  // Every one of these is a COUNT or SUM, so every one needs the cast.
  return {
    total_skus: Number(row.total_skus),
    total_on_hand: Number(row.total_on_hand),
    total_available: Number(row.total_available),
    low_stock_count: Number(row.low_stock_count),
    out_of_stock_count: Number(row.out_of_stock_count),
  };
}

/** Query string → filters, in one place so the list and its summary never drift. */
function readStockFilters(queryParams: Record<string, unknown>): StockFilters {
  const state = queryParams.stock_status;
  return {
    search: (queryParams.q as string | undefined) || undefined,
    locationId: queryParams.location_id as number | undefined,
    stockStatus: state === 'all' || !state ? undefined : (state as StockFilters['stockStatus']),
    productStatus: (queryParams.product_status as string | undefined) || undefined,
  };
}

function presentMovement(row: MovementRow) {
  return {
    id: row.id,
    variant_id: row.variant_id,
    location_id: row.location_id,
    movement_type: row.movement_type,
    quantity_delta: row.quantity_delta,
    quantity_after: row.quantity_after,
    reference_type: row.reference_type,
    reference_id: row.reference_id,
    batch_id: row.batch_id,
    unit_cost: row.unit_cost ? Number(row.unit_cost) : null,
    reason: row.reason,
    admin_user_id: row.admin_user_id,
    admin_name: row.admin_name,
    created_at: row.created_at,
    sku: row.sku,
    variant_title: row.variant_title,
    product_name: row.product_name,
    location_code: row.location_code,
  };
}

function presentLocation(row: LocationRow) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    location_type: row.location_type,
    address: {
      line1: row.line1,
      line2: row.line2,
      city: row.city,
      state: row.state,
      state_code: row.state_code,
      pincode: row.pincode,
      country: row.country,
    },
    gstin: row.gstin,
    contact_name: row.contact_name,
    contact_phone: row.contact_phone,
    is_default: row.is_default === 1,
    is_active: row.is_active === 1,
    fulfils_online_orders: row.fulfils_online_orders === 1,
    priority: row.priority,
    item_count: Number(row.item_count ?? 0),
    // SUM() arrives as a string from mysql2; without the cast the client gets
    // "3965" here and 3965 from /inventory/summary, and adding the two concatenates.
    total_on_hand: Number(row.total_on_hand ?? 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Resolve which location a write lands on, make sure the stock row exists, and
 * return it locked.
 *
 * All three write paths go through this so they share one answer to "which
 * location?" and one lock discipline. Resolving the default location to a
 * concrete id up front also removes the `is_default = 1 LIMIT 1` lookup from the
 * write path, which would pick arbitrarily if two locations were ever flagged
 * default at once.
 */
async function lockFor(
  variantId: number,
  locationId: number | undefined,
  tx: Parameters<Parameters<typeof withTransaction>[0]>[0],
) {
  const resolved = locationId ?? (await inventoryRepository.defaultLocationId(tx));
  if (!resolved) {
    throw ApiError.badRequest('No inventory location is marked as the default.');
  }

  await inventoryRepository.ensureItemExists(variantId, resolved, tx);
  const locked = await inventoryRepository.lockStockItem(variantId, resolved, tx);
  if (!locked) throw ApiError.notFound('Inventory item');

  // The presentable row (SKU, product, image) is read unlocked — only the
  // quantity needs the lock, and `locked.quantity_on_hand` is the authority on it.
  const item = await inventoryRepository.findStockItem(variantId, resolved, tx);
  if (!item) throw ApiError.notFound('Inventory item');

  return { locked, item, locationId: resolved };
}

export const inventoryService = {
  // ── Stock levels ─────────────────────────────────────────────────────────

  async list(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, STOCK_SORTABLE, 'ii.quantity_available ASC');
    const filters = readStockFilters(queryParams);

    // The summary rides along on the same filters so the cards describe the rows
    // on screen. One round trip for the page instead of two unrelated ones.
    const [rows, total, summary] = await Promise.all([
      inventoryRepository.listStock(filters, orderBy, page.limit, page.offset),
      inventoryRepository.countStock(filters),
      inventoryRepository.summary(filters),
    ]);

    return {
      items: rows.map(presentStockLevel),
      pagination: buildMeta(total, page),
      summary: presentSummary(summary),
    };
  },

  async get(variantId: number, locationId?: number) {
    const item = await inventoryRepository.findStockItem(variantId, locationId);
    if (!item) throw ApiError.notFound('Inventory item');

    const movements = await inventoryRepository.listMovements(
      { variantId, locationId: locationId ?? item.location_id },
      20,
      0,
    );

    return {
      item: presentStockLevel(item),
      recent_movements: movements.map(presentMovement),
    };
  },

  // ── Stock adjustments ──────────────────────────────────────────────────

  async adjust(
    variantId: number,
    input: { quantity_delta: number; location_id?: number; reason: string },
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    return withTransaction(async (tx) => {
      const { locked, item, locationId } = await lockFor(variantId, input.location_id, tx);

      const currentOnHand = locked.quantity_on_hand;
      const newOnHand = currentOnHand + input.quantity_delta;
      if (newOnHand < 0) {
        throw ApiError.badRequest(
          `Adjustment would result in negative stock (current: ${currentOnHand}, delta: ${input.quantity_delta}).`,
        );
      }

      await inventoryRepository.adjustOnHand(locked.id, input.quantity_delta, tx);
      await inventoryRepository.recordMovement(
        {
          variantId,
          locationId,
          movementType: 'adjustment',
          quantityDelta: input.quantity_delta,
          quantityAfter: newOnHand,
          reason: input.reason,
          adminUserId: admin.id,
        },
        tx,
      );

      // Keep the product-level in_stock flag in sync
      await productsRepository.refreshDerivedFields(item.product_id, tx);

      await auditService.log(
        {
          actorId: admin.id,
          actorLabel: admin.email,
          action: 'inventory.adjust',
          entityType: 'product_variant',
          entityId: variantId,
          summary: `Adjusted stock by ${input.quantity_delta > 0 ? '+' : ''}${input.quantity_delta} → ${newOnHand} on hand (${item.sku})`,
          changes: {
            quantity_on_hand: { from: currentOnHand, to: newOnHand },
            delta: input.quantity_delta,
            reason: input.reason,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      const updated = await inventoryRepository.findStockItem(variantId, locationId, tx);
      return { item: presentStockLevel(updated!) };
    });
  },

  async setStock(
    variantId: number,
    input: { quantity: number; location_id?: number; reason: string },
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    return withTransaction(async (tx) => {
      const { locked, item, locationId } = await lockFor(variantId, input.location_id, tx);

      const currentOnHand = locked.quantity_on_hand;
      const delta = input.quantity - currentOnHand;
      if (delta === 0) {
        return { item: presentStockLevel(item) };
      }

      await inventoryRepository.setOnHand(locked.id, input.quantity, tx);
      await inventoryRepository.recordMovement(
        {
          variantId,
          locationId,
          movementType: 'stock_take',
          quantityDelta: delta,
          quantityAfter: input.quantity,
          reason: input.reason,
          adminUserId: admin.id,
        },
        tx,
      );

      await productsRepository.refreshDerivedFields(item.product_id, tx);

      await auditService.log(
        {
          actorId: admin.id,
          actorLabel: admin.email,
          action: 'inventory.set_stock',
          entityType: 'product_variant',
          entityId: variantId,
          summary: `Set stock to ${input.quantity} (was ${currentOnHand}, delta ${delta > 0 ? '+' : ''}${delta}) on ${item.sku}`,
          changes: {
            quantity_on_hand: { from: currentOnHand, to: input.quantity },
            delta,
            reason: input.reason,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      const updated = await inventoryRepository.findStockItem(variantId, locationId, tx);
      return { item: presentStockLevel(updated!) };
    });
  },

  async bulkAdjust(
    input: {
      items: { variant_id: number; location_id?: number; quantity_delta: number }[];
      reason: string;
    },
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    return withTransaction(async (tx) => {
      const results: { variant_id: number; sku: string; old: number; new: number; delta: number }[] = [];

      // Locks are taken in ascending variant order so two bulk adjustments over
      // overlapping variants queue behind each other instead of deadlocking.
      const entries = [...input.items].sort((a, b) => a.variant_id - b.variant_id);

      for (const entry of entries) {
        const { locked, item, locationId } = await lockFor(entry.variant_id, entry.location_id, tx);

        const currentOnHand = locked.quantity_on_hand;
        const newOnHand = currentOnHand + entry.quantity_delta;
        if (newOnHand < 0) {
          throw ApiError.badRequest(
            `Adjustment would result in negative stock for ${item.sku} (current: ${currentOnHand}, delta: ${entry.quantity_delta}).`,
          );
        }

        await inventoryRepository.adjustOnHand(locked.id, entry.quantity_delta, tx);
        await inventoryRepository.recordMovement(
          {
            variantId: entry.variant_id,
            locationId,
            movementType: 'adjustment',
            quantityDelta: entry.quantity_delta,
            quantityAfter: newOnHand,
            reason: input.reason,
            adminUserId: admin.id,
          },
          tx,
        );

        await productsRepository.refreshDerivedFields(item.product_id, tx);
        results.push({
          variant_id: entry.variant_id,
          sku: item.sku,
          old: currentOnHand,
          new: newOnHand,
          delta: entry.quantity_delta,
        });
      }

      await auditService.log(
        {
          actorId: admin.id,
          actorLabel: admin.email,
          action: 'inventory.bulk_adjust',
          entityType: 'inventory',
          summary: `Bulk adjusted ${results.length} variant(s): ${input.reason}`,
          changes: { adjustments: results },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return { adjusted: results.length, items: results };
    });
  },

  // ── Movement history ─────────────────────────────────────────────────────

  async movements(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const filters = {
      variantId: queryParams.variant_id as number | undefined,
      locationId: queryParams.location_id as number | undefined,
      movementType: queryParams.movement_type as string | undefined,
      from: queryParams.from as string | undefined,
      to: queryParams.to as string | undefined,
    };

    const [rows, total] = await Promise.all([
      inventoryRepository.listMovements(filters, page.limit, page.offset),
      inventoryRepository.countMovements(filters),
    ]);

    return { movements: rows.map(presentMovement), pagination: buildMeta(total, page) };
  },

  // ── Summary ──────────────────────────────────────────────────────────────

  async summary(queryParams: Record<string, unknown> = {}) {
    const row = await inventoryRepository.summary(readStockFilters(queryParams));
    return { summary: presentSummary(row) };
  },

  // ── Locations ────────────────────────────────────────────────────────────

  async listLocations() {
    const rows = await inventoryRepository.listLocations();
    return { locations: rows.map(presentLocation) };
  },

  async getLocation(id: number) {
    const row = await inventoryRepository.findLocationById(id);
    if (!row) throw ApiError.notFound('Location');
    return { location: presentLocation(row) };
  },

  async createLocation(
    data: Parameters<typeof inventoryRepository.createLocation>[0],
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    // Check for duplicate code
    const existing = await inventoryRepository.findLocationByCode(data.code);
    if (existing) {
      throw ApiError.conflict(`A location with code "${data.code}" already exists.`);
    }

    // Promoting a location to default has to demote the old one in the same
    // transaction. Two rows with is_default = 1 would make every write that omits
    // a location land wherever the table happened to return first.
    const id = await withTransaction(async (tx) => {
      const newId = await inventoryRepository.createLocation(data, tx);
      if (data.is_default) await inventoryRepository.clearDefaultLocation(newId, tx);
      return newId;
    });

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'inventory.location_created',
      entityType: 'inventory_location',
      entityId: id,
      summary: `Created location "${data.name}" (${data.code})`,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const row = await inventoryRepository.findLocationById(id);
    return { location: presentLocation(row!) };
  },

  async updateLocation(
    id: number,
    data: Record<string, unknown>,
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const existing = await inventoryRepository.findLocationById(id);
    if (!existing) throw ApiError.notFound('Location');

    await withTransaction(async (tx) => {
      await inventoryRepository.updateLocation(id, data, tx);
      if (data.is_default === true) {
        await inventoryRepository.clearDefaultLocation(id, tx);
      } else if (data.is_default === false && existing.is_default === 1) {
        // Refusing this is kinder than silently leaving the store with no default
        // and failing every later adjustment with "no default location".
        throw ApiError.badRequest(
          'Mark another location as the default first — the store must always have one.',
        );
      }
    });

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'inventory.location_updated',
      entityType: 'inventory_location',
      entityId: id,
      summary: `Updated location "${existing.name}" (${existing.code})`,
      changes: data,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const updated = await inventoryRepository.findLocationById(id);
    return { location: presentLocation(updated!) };
  },
};
