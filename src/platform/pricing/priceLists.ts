import { ApiError } from '../../core/ApiError';
import { execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { ShopScopedCache } from '../cache/shopCache';
import { roundMoney } from '../money/currency';
import { shopId, tenancy } from '../tenancy/context';

/**
 * Price lists — prices a merchant sets by hand, in a currency, for a market
 * or (B2B) a company. Shopify's "fixed prices" per market and its B2B
 * catalogs are both this.
 *
 * A variant's price in a list is its fixed price when one is set; otherwise
 * the store's price as the market would show it, moved by the list's
 * percentage (−30% for a wholesale catalog). A fixed price is final: it is
 * not converted, rounded or reduced for export tax.
 */

export interface PriceListRow extends RowDataPacket {
  id: number;
  name: string;
  currency: string;
  adjustment_percent: string;
  created_at: Date;
  fixed_count?: number;
  markets?: string | null;
}

export interface LoadedPriceList {
  id: number;
  name: string;
  currency: string;
  adjustmentPercent: number;
  prices: Map<number, { price: number; compareAt: number | null }>;
}

/** Per shop: each list's fixed prices, read once a minute at most (and cleared on any change). */
const cache = new ShopScopedCache<LoadedPriceList | null>(60_000, 200);

export async function loadPriceList(id: number | null | undefined, exec?: Executor): Promise<LoadedPriceList | null> {
  if (!id) return null;
  return cache.get(`list:${id}`, async () => {
    const row = await queryOne<PriceListRow>('SELECT id, name, currency, adjustment_percent FROM price_lists WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
    if (!row) return null;
    const prices = await query<RowDataPacket & { variant_id: number; price: string; compare_at_price: string | null }>(
      'SELECT variant_id, price, compare_at_price FROM price_list_prices WHERE shop_id = ? AND price_list_id = ?',
      [shopId(), id],
      exec,
    );
    return {
      id: Number(row.id),
      name: row.name,
      currency: row.currency,
      adjustmentPercent: Number(row.adjustment_percent),
      prices: new Map(prices.map((price) => [Number(price.variant_id), { price: Number(price.price), compareAt: price.compare_at_price === null ? null : Number(price.compare_at_price) }])),
    };
  });
}

/**
 * A variant's price and compare-at price under a price list, given how the
 * market would present the store's price (`presented`). Pure.
 */
export function listPrice(
  list: Pick<LoadedPriceList, 'adjustmentPercent' | 'prices' | 'currency'> | null | undefined,
  variantId: number,
  presented: { price: number; mrp: number | null },
): { price: number; mrp: number | null; fixed: boolean } {
  if (!list) return { ...presented, fixed: false };
  const fixed = list.prices.get(variantId);
  if (fixed) return { price: fixed.price, mrp: fixed.compareAt !== null && fixed.compareAt > fixed.price ? fixed.compareAt : null, fixed: true };
  if (!list.adjustmentPercent) return { ...presented, fixed: false };
  const price = roundMoney(presented.price * (1 + list.adjustmentPercent / 100), list.currency);
  // A discounted catalog shows the price it discounts from.
  const mrp = list.adjustmentPercent < 0 ? (presented.mrp !== null && presented.mrp > presented.price ? presented.mrp : presented.price) : presented.mrp;
  return { price, mrp: mrp !== null && mrp > price ? mrp : null, fixed: false };
}

function presentList(row: PriceListRow) {
  return {
    id: Number(row.id),
    name: row.name,
    currency: row.currency,
    adjustment_percent: Number(row.adjustment_percent),
    fixed_prices: Number(row.fixed_count ?? 0),
    markets: row.markets ? String(row.markets).split('\u001f') : [],
    created_at: row.created_at,
  };
}

/** One CSV field, RFC 4180 style. */
function csvField(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Rows of a CSV text (quotes, escaped quotes and newlines inside quotes handled). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ',') {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      if (row.some((cell) => cell !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((cell) => cell !== '')) rows.push(row);
  return rows;
}

export const priceLists = {
  async list() {
    const rows = await query<PriceListRow>(
      `SELECT l.id, l.name, l.currency, l.adjustment_percent, l.created_at,
              (SELECT COUNT(*) FROM price_list_prices p WHERE p.shop_id = l.shop_id AND p.price_list_id = l.id) AS fixed_count,
              (SELECT GROUP_CONCAT(m.name SEPARATOR '\u001f') FROM markets m WHERE m.shop_id = l.shop_id AND m.price_list_id = l.id) AS markets
         FROM price_lists l WHERE l.shop_id = ? ORDER BY l.name`,
      [shopId()],
    );
    return { price_lists: rows.map(presentList) };
  },

  async get(id: number) {
    const all = (await this.list()).price_lists;
    const found = all.find((list) => list.id === id);
    if (!found) throw ApiError.notFound('Price list');
    return found;
  },

  async create(input: { name: string; currency: string; adjustment_percent?: number }) {
    try {
      const id = await insert('INSERT INTO price_lists (shop_id, name, currency, adjustment_percent) VALUES (?, ?, ?, ?)', [shopId(), input.name.trim(), input.currency.toUpperCase(), input.adjustment_percent ?? 0]);
      return { price_list: await this.get(id) };
    } catch (error) {
      if ((error as { code?: string }).code === 'ER_DUP_ENTRY') throw ApiError.conflict(`There is already a price list called "${input.name}".`);
      throw error;
    }
  },

  async update(id: number, input: { name?: string; adjustment_percent?: number }) {
    await this.get(id);
    await execute('UPDATE price_lists SET name = COALESCE(?, name), adjustment_percent = COALESCE(?, adjustment_percent) WHERE shop_id = ? AND id = ?', [input.name?.trim() ?? null, input.adjustment_percent ?? null, shopId(), id]);
    return { price_list: await this.get(id) };
  },

  async remove(id: number) {
    await this.get(id);
    await execute('DELETE FROM price_lists WHERE shop_id = ? AND id = ?', [shopId(), id]);
    return { deleted: true };
  },

  /** The store's variants with their fixed price in this list (if any), for the editor. */
  async prices(id: number, input: { q?: string; fixed_only?: boolean; page?: number; limit?: number }) {
    const list = await this.get(id);
    const page = Math.max(1, Number(input.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(input.limit) || 50));
    const where = ['v.shop_id = ?', 'v.deleted_at IS NULL', 'p.deleted_at IS NULL'];
    const params: unknown[] = [shopId()];
    if (input.q?.trim()) {
      const like = `%${input.q.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
      where.push('(p.name LIKE ? OR v.sku LIKE ? OR v.variant_title LIKE ?)');
      params.push(like, like, like);
    }
    if (input.fixed_only) where.push('lp.variant_id IS NOT NULL');
    const from = `FROM product_variants v
      JOIN products p ON p.shop_id = v.shop_id AND p.id = v.product_id
      LEFT JOIN price_list_prices lp ON lp.shop_id = v.shop_id AND lp.price_list_id = ? AND lp.variant_id = v.id`;
    const [count] = await query<RowDataPacket & { total: number }>(`SELECT COUNT(*) AS total ${from} WHERE ${where.join(' AND ')}`, [id, ...params]);
    const rows = await query<RowDataPacket & { variant_id: number; product_id: number; product_name: string; variant_title: string | null; sku: string; price: string; mrp: string | null; fixed_price: string | null; fixed_compare_at: string | null }>(
      `SELECT v.id AS variant_id, p.id AS product_id, p.name AS product_name, v.variant_title, v.sku, v.price, v.mrp, lp.price AS fixed_price, lp.compare_at_price AS fixed_compare_at
         ${from} WHERE ${where.join(' AND ')} ORDER BY p.name, v.position, v.id LIMIT ? OFFSET ?`,
      [id, ...params, limit, (page - 1) * limit],
    );
    return {
      price_list: list,
      store_currency: tenancy.current().currency,
      variants: rows.map((row) => ({
        variant_id: Number(row.variant_id),
        product_id: Number(row.product_id),
        product: row.product_name,
        title: row.variant_title,
        sku: row.sku,
        store_price: Number(row.price),
        store_compare_at: row.mrp === null ? null : Number(row.mrp),
        price: row.fixed_price === null ? null : Number(row.fixed_price),
        compare_at_price: row.fixed_compare_at === null ? null : Number(row.fixed_compare_at),
      })),
      pagination: { page, limit, total: Number(count?.total ?? 0), total_pages: Math.max(1, Math.ceil(Number(count?.total ?? 0) / limit)) },
    };
  },

  /** Sets (or, with price null, clears) fixed prices. All or nothing. */
  async setPrices(id: number, entries: Array<{ variant_id: number; price: number | null; compare_at_price?: number | null }>) {
    const list = await this.get(id);
    if (entries.length > 5000) throw ApiError.validation({ prices: ['At most 5,000 prices at a time.'] });
    const ids = [...new Set(entries.map((entry) => entry.variant_id))];
    if (ids.length) {
      const known = await query<RowDataPacket & { id: number }>(`SELECT id FROM product_variants WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(', ')})`, [shopId(), ...ids]);
      const missing = ids.filter((variantId) => !known.some((row) => Number(row.id) === variantId));
      if (missing.length) throw ApiError.validation({ prices: [`Unknown variant${missing.length > 1 ? 's' : ''}: ${missing.slice(0, 10).join(', ')}`] });
    }
    for (const entry of entries) {
      if (entry.price !== null && (!(entry.price >= 0) || entry.price > 100_000_000)) throw ApiError.validation({ prices: [`Variant ${entry.variant_id}: enter a price of 0 or more.`] });
    }
    await withTransaction(async (tx) => {
      for (const entry of entries) {
        if (entry.price === null) {
          await execute('DELETE FROM price_list_prices WHERE shop_id = ? AND price_list_id = ? AND variant_id = ?', [shopId(), id, entry.variant_id], tx);
        } else {
          await execute(
            `INSERT INTO price_list_prices (shop_id, price_list_id, variant_id, price, compare_at_price) VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE price = VALUES(price), compare_at_price = VALUES(compare_at_price)`,
            [shopId(), id, entry.variant_id, roundMoney(entry.price, list.currency), entry.compare_at_price ?? null],
            tx,
          );
        }
      }
    });
    cache.clear();
    return { price_list: await this.get(id), updated: entries.length };
  },

  /** sku,variant_id,product,variant,store_price,price,compare_at_price — what the editor exports and imports. */
  async exportCsv(id: number): Promise<string> {
    const all = await this.prices(id, { limit: 200, page: 1 });
    const rows = [...all.variants];
    for (let page = 2; page <= all.pagination.total_pages; page += 1) rows.push(...(await this.prices(id, { limit: 200, page })).variants);
    const header = ['sku', 'variant_id', 'product', 'variant', 'store_price', 'price', 'compare_at_price'];
    return [header.join(','), ...rows.map((row) => [row.sku, row.variant_id, row.product, row.title ?? '', row.store_price, row.price ?? '', row.compare_at_price ?? ''].map(csvField).join(','))].join('\n') + '\n';
  },

  /** Imports fixed prices by SKU (or variant_id); an empty price clears a fixed price. */
  async importCsv(id: number, text: string) {
    const rows = parseCsv(text.replace(/^﻿/, ''));
    if (rows.length < 2) throw ApiError.validation({ file: ['The file has no rows.'] });
    const header = rows[0].map((cell) => cell.trim().toLowerCase());
    const column = (name: string) => header.indexOf(name);
    if (column('price') < 0 || (column('sku') < 0 && column('variant_id') < 0)) throw ApiError.validation({ file: ['The file needs a "price" column and a "sku" or "variant_id" column.'] });
    const skus = new Map(
      (await query<RowDataPacket & { id: number; sku: string }>('SELECT id, sku FROM product_variants WHERE shop_id = ? AND deleted_at IS NULL', [shopId()])).map((row) => [row.sku.trim().toLowerCase(), Number(row.id)]),
    );
    const entries: Array<{ variant_id: number; price: number | null; compare_at_price: number | null }> = [];
    const problems: string[] = [];
    rows.slice(1).forEach((row, index) => {
      const line = index + 2;
      const byId = column('variant_id') >= 0 ? Number(row[column('variant_id')]) : NaN;
      const variantId = Number.isInteger(byId) && byId > 0 ? byId : skus.get((row[column('sku')] ?? '').trim().toLowerCase());
      if (!variantId) return void problems.push(`Line ${line}: no variant with that SKU.`);
      const raw = (row[column('price')] ?? '').trim();
      const price = raw === '' ? null : Number(raw.replace(/,/g, ''));
      if (price !== null && !Number.isFinite(price)) return void problems.push(`Line ${line}: "${raw}" is not a price.`);
      const compareRaw = column('compare_at_price') >= 0 ? (row[column('compare_at_price')] ?? '').trim() : '';
      const compareAt = compareRaw === '' ? null : Number(compareRaw.replace(/,/g, ''));
      entries.push({ variant_id: variantId, price, compare_at_price: compareAt !== null && Number.isFinite(compareAt) ? compareAt : null });
    });
    if (problems.length) throw ApiError.validation({ file: problems.slice(0, 20) });
    return this.setPrices(id, entries);
  },

  clearCache(): void {
    cache.clear();
  },
};
