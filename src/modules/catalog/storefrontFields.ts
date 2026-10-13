import { sanitizeMerchantHtml } from '../../core/merchantHtml';
import { query, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import { mediaUrlOf } from './catalog.repository';
import { customDataService, type Definition, type MetafieldValue } from './customData.service';
import { displayText, parseType, referencesOf, type ReferenceKind } from './fieldTypes';

/**
 * Custom fields as a shopper may see them — for the Liquid store
 * (`product.metafields.custom.material`) and the storefront API alike.
 *
 * Only fields whose definition is readable by the storefront are shown, in the
 * order the admin shows them (pinned first). References are resolved to what a
 * page can use — a file to its URL, a metaobject to its entry and fields, a
 * product, collection or page to its link — and anything not public (a draft
 * product, an unpublished page, a draft entry, a private metaobject type) is
 * left out rather than linked to a 404.
 */

export interface StorefrontField {
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  list: boolean;
  /** The value, with references replaced by the records they point at. */
  value: unknown;
  /** One line of plain text: what `{{ product.metafields.ns.key }}` prints. */
  text: string;
  /** Rich text as (cleaned) HTML; null for every other type. */
  html: string | null;
}

export interface ResolvedFile {
  id: number;
  url: string | null;
  alt: string | null;
  media_type: string;
  width: number | null;
  height: number | null;
}

export interface ResolvedLink {
  id: number;
  handle: string;
  title: string;
  url: string;
  image?: string | null;
}

export interface ResolvedMetaobject {
  id: number;
  type: string;
  handle: string;
  display_name: string;
  fields: Record<string, StorefrontField>;
}

type Resolved = Map<string, unknown>;
const refKey = (kind: ReferenceKind, id: number) => `${kind}:${id}`;
const marks = (ids: number[]) => ids.map(() => '?').join(', ');

interface MetaobjectRow extends RowDataPacket {
  id: number;
  handle: string;
  display_name: string;
  fields: unknown;
  type: string;
  def_fields: unknown;
}

const json = <T>(raw: unknown, fallback: T): T => {
  if (typeof raw !== 'string') return (raw as T) ?? fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
};

/** Loads every referenced record the shopper may see, keyed `kind:id`. */
async function resolve(wanted: Map<ReferenceKind, Set<number>>, into: Resolved = new Map()): Promise<Resolved> {
  const ids = (kind: ReferenceKind) => [...(wanted.get(kind) ?? [])].filter((id) => !into.has(refKey(kind, id)));

  const files = ids('file');
  if (files.length) {
    const rows = await query<RowDataPacket & { id: number; storage_key: string | null; absolute_url: string | null; alt_text: string | null; media_type: string; width: number | null; height: number | null }>(
      `SELECT id, storage_key, absolute_url, alt_text, media_type, width, height FROM media WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${marks(files)})`,
      [shopId(), ...files],
    );
    for (const row of rows) {
      into.set(refKey('file', Number(row.id)), { id: Number(row.id), url: mediaUrlOf(row), alt: row.alt_text, media_type: row.media_type, width: row.width === null ? null : Number(row.width), height: row.height === null ? null : Number(row.height) } satisfies ResolvedFile);
    }
  }

  const products = ids('product');
  if (products.length) {
    const rows = await query<RowDataPacket & { id: number; slug: string; name: string; image_key: string | null }>(
      `SELECT p.id, p.slug, p.name,
              (SELECT m.storage_key FROM media_attachments ma JOIN media m ON m.shop_id = ma.shop_id AND m.id = ma.media_id
                WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id AND ma.collection = 'gallery'
                ORDER BY ma.is_primary DESC, ma.sort_order LIMIT 1) AS image_key
         FROM products p
        WHERE p.shop_id = ? AND p.deleted_at IS NULL AND p.status = 'active' AND p.visibility <> 'hidden' AND p.id IN (${marks(products)})`,
      [shopId(), ...products],
    );
    for (const row of rows) {
      into.set(refKey('product', Number(row.id)), { id: Number(row.id), handle: row.slug, title: row.name, url: `/products/${row.slug}`, image: row.image_key ? mediaUrlOf({ storage_key: row.image_key }) : null } satisfies ResolvedLink);
    }
  }

  const variants = ids('variant');
  if (variants.length) {
    const rows = await query<RowDataPacket & { id: number; slug: string; name: string; variant_title: string | null }>(
      `SELECT v.id, p.slug, p.name, v.variant_title FROM product_variants v JOIN products p ON p.shop_id = v.shop_id AND p.id = v.product_id
        WHERE v.shop_id = ? AND v.deleted_at IS NULL AND p.deleted_at IS NULL AND p.status = 'active' AND p.visibility <> 'hidden' AND v.id IN (${marks(variants)})`,
      [shopId(), ...variants],
    );
    for (const row of rows) {
      into.set(refKey('variant', Number(row.id)), { id: Number(row.id), handle: row.slug, title: row.variant_title ? `${row.name} — ${row.variant_title}` : row.name, url: `/products/${row.slug}?variant=${row.id}` } satisfies ResolvedLink);
    }
  }

  const collections = ids('collection');
  if (collections.length) {
    const rows = await query<RowDataPacket & { id: number; slug: string; title: string }>(
      `SELECT id, slug, title FROM collections WHERE shop_id = ? AND deleted_at IS NULL AND is_active = 1 AND id IN (${marks(collections)})`,
      [shopId(), ...collections],
    );
    for (const row of rows) into.set(refKey('collection', Number(row.id)), { id: Number(row.id), handle: row.slug, title: row.title, url: `/collections/${row.slug}` } satisfies ResolvedLink);
  }

  const pages = ids('page');
  if (pages.length) {
    const rows = await query<RowDataPacket & { id: number; slug: string; title: string }>(
      `SELECT id, slug, title FROM cms_pages WHERE shop_id = ? AND deleted_at IS NULL AND status = 'published' AND id IN (${marks(pages)})`,
      [shopId(), ...pages],
    );
    for (const row of rows) into.set(refKey('page', Number(row.id)), { id: Number(row.id), handle: row.slug, title: row.title, url: `/pages/${row.slug}` } satisfies ResolvedLink);
  }

  const entries = ids('metaobject');
  if (entries.length) {
    const rows = await query<MetaobjectRow>(
      `SELECT m.id, m.handle, m.display_name, m.fields, d.type, d.fields AS def_fields
         FROM metaobjects m JOIN metaobject_definitions d ON d.shop_id = m.shop_id AND d.id = m.definition_id
        WHERE m.shop_id = ? AND d.is_public = 1 AND (d.is_publishable = 0 OR m.status = 'active') AND m.id IN (${marks(entries)})`,
      [shopId(), ...entries],
    );
    // An entry's own files (an ingredient's photo) are resolved too; deeper references stay ids.
    const nestedFiles = new Set<number>();
    const parsed = rows.map((row) => {
      const defs = json<{ key: string; name: string; type: string; description?: string | null }[]>(row.def_fields, []);
      const values = json<Record<string, unknown>>(row.fields, {});
      for (const def of defs) {
        const refs = referencesOf(def.type, values[def.key]);
        if (refs?.kind === 'file') refs.ids.forEach((id) => nestedFiles.add(id));
      }
      return { row, defs, values };
    });
    if (nestedFiles.size) await resolve(new Map([['file', nestedFiles]]), into);
    for (const { row, defs, values } of parsed) {
      const fields: Record<string, StorefrontField> = {};
      for (const def of defs) {
        const value = values[def.key];
        if (value === null || value === undefined || value === '') continue;
        const field = present({ namespace: '', key: def.key, name: def.name, description: def.description ?? null, type: def.type }, value, into, false);
        if (field) fields[def.key] = field;
      }
      into.set(refKey('metaobject', Number(row.id)), { id: Number(row.id), type: row.type, handle: row.handle, display_name: row.display_name, fields } satisfies ResolvedMetaobject);
    }
  }
  return into;
}

/** A value laid out for a shopper; null when nothing public is left of it. */
function present(meta: Pick<StorefrontField, 'namespace' | 'key' | 'name' | 'description' | 'type'>, raw: unknown, resolved: Resolved, resolveMetaobjects = true): StorefrontField | null {
  const parsed = parseType(meta.type);
  if (!parsed || raw === null || raw === undefined) return null;
  const refs = referencesOf(meta.type, raw);
  if (refs) {
    if (refs.kind === 'metaobject' && !resolveMetaobjects) return null;
    const found = refs.ids.map((id) => resolved.get(refKey(refs.kind, id))).filter((item): item is NonNullable<typeof item> => item !== undefined);
    if (found.length === 0) return null;
    const label = (item: unknown) => {
      const record = item as { title?: string; display_name?: string; alt?: string | null; url?: string | null };
      return record.title ?? record.display_name ?? record.alt ?? record.url ?? '';
    };
    return { ...meta, list: parsed.list, value: parsed.list ? found : found[0], text: found.map(label).filter(Boolean).join(', '), html: null };
  }
  const html = parsed.base === 'rich_text_field' ? sanitizeMerchantHtml(String(raw)) : null;
  const text = parsed.base === 'rich_text_field' ? String(raw).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() : displayText(meta.type, raw);
  return { ...meta, list: parsed.list, value: raw, text, html };
}

/**
 * The public custom fields of some products or variants, each owner's in the
 * admin's order. One round of queries for the values and one per kind of
 * reference, whatever the number of owners.
 */
export async function storefrontFields(ownerType: 'product' | 'variant', ownerIds: number[]): Promise<Map<number, StorefrontField[]>> {
  const out = new Map<number, StorefrontField[]>();
  if (ownerIds.length === 0) return out;
  const definitions = (await customDataService.definitions(ownerType)).filter((definition) => definition.storefront);
  if (definitions.length === 0) return out;
  const order = [...definitions].sort((a, b) => (a.pinned === b.pinned ? 0 : a.pinned ? -1 : 1) || (a.pinned_position ?? 0) - (b.pinned_position ?? 0));
  const byKey = new Map<string, Definition>(order.map((definition) => [definition.full_key, definition]));
  const values = await customDataService.valuesFor(ownerType, ownerIds);

  const wanted = new Map<ReferenceKind, Set<number>>();
  const kept = new Map<number, { definition: Definition; value: MetafieldValue }[]>();
  for (const [ownerId, list] of values) {
    const mine: { definition: Definition; value: MetafieldValue }[] = [];
    for (const value of list) {
      const definition = byKey.get(`${value.namespace}.${value.key}`);
      if (!definition || value.value === null || value.value === undefined) continue;
      mine.push({ definition, value });
      const refs = referencesOf(definition.type, value.value);
      if (refs) for (const id of refs.ids) (wanted.get(refs.kind) ?? wanted.set(refs.kind, new Set()).get(refs.kind)!).add(id);
    }
    kept.set(ownerId, mine);
  }
  const resolved = wanted.size ? await resolve(wanted) : new Map<string, unknown>();

  const position = new Map(order.map((definition, index) => [definition.id, index]));
  for (const [ownerId, list] of kept) {
    const fields = list
      .sort((a, b) => (position.get(a.definition.id) ?? 0) - (position.get(b.definition.id) ?? 0))
      .map(({ definition, value }) => present({ namespace: definition.namespace, key: definition.key, name: definition.name, description: definition.description, type: definition.type }, value.value, resolved))
      .filter((field): field is StorefrontField => field !== null);
    if (fields.length) out.set(ownerId, fields);
  }
  return out;
}
