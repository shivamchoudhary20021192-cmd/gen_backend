import { ApiError, type FieldErrors } from '../../core/ApiError';
import { slugify } from '../../core/slug';
import { execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { shopId } from '../../platform/tenancy/context';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { storage } from '../media/storage';
import {
  checkValidations,
  checkValue,
  displayText,
  fromStored,
  parseType,
  referencesOf,
  toStored,
  UNIQUE_CAPABLE,
  type ReferenceKind,
  type Validations,
} from './fieldTypes';

/**
 * Custom data: the fields a merchant adds to products and variants
 * (metafield definitions and their values) and the structured types of their
 * own that fields can point at (metaobjects).
 *
 *   definition  owner (product | variant), namespace.key, name, type,
 *               validations, required, pinned (shown on the edit page, in
 *               order), storefront access, filterable, unique values, and
 *               optional constraints (only for some product types/categories).
 *   value       one row per owner and field in `metafields`, laid out across
 *               typed, indexed columns (fieldTypes.toStored).
 *   metaobject  a type (Ingredient, Size chart) with its own typed fields,
 *               and its entries.
 */

export const OWNER_TYPES = ['product', 'variant'] as const;
export type OwnerType = (typeof OWNER_TYPES)[number];

/** Shopify's limit per resource type. */
export const MAX_DEFINITIONS_PER_OWNER = 256;
export const MAX_METAOBJECT_FIELDS = 40;
export const MAX_METAOBJECT_TYPES = 200;

const KEY_RE = /^[a-z0-9_-]{2,60}$/;
const NAMESPACE_RE = /^[a-z0-9_-]{2,50}$/;
const RESERVED_NAMESPACES = new Set(['shopify', 'reviews', 'details', 'seo', 'app']);
const METAOBJECT_TYPE_RE = /^[a-z0-9][a-z0-9_-]{1,63}$/;
const FIELD_KEY_RE = /^[a-z0-9_]{1,64}$/;

export interface DefinitionRow extends RowDataPacket {
  id: number;
  owner_type: string;
  namespace: string;
  meta_key: string;
  name: string;
  description: string | null;
  value_type: string;
  validations: unknown;
  constraints: unknown;
  is_required: number;
  is_public: number;
  is_filterable: number;
  unique_values: number;
  pinned_position: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Constraints {
  product_types?: string[];
  categories?: string[];
}

export interface Definition {
  id: number;
  owner_type: string;
  namespace: string;
  key: string;
  full_key: string;
  name: string;
  description: string | null;
  type: string;
  validations: Validations;
  constraints: Constraints | null;
  required: boolean;
  storefront: boolean;
  filterable: boolean;
  unique_values: boolean;
  pinned: boolean;
  pinned_position: number | null;
  values_count?: number;
}

function json<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw as T;
}

function presentDefinition(row: DefinitionRow, count?: number): Definition {
  return {
    id: Number(row.id),
    owner_type: row.owner_type,
    namespace: row.namespace,
    key: row.meta_key,
    full_key: `${row.namespace}.${row.meta_key}`,
    name: row.name,
    description: row.description,
    type: row.value_type,
    validations: json<Validations>(row.validations, {}),
    constraints: json<Constraints | null>(row.constraints, null),
    required: Number(row.is_required) === 1,
    storefront: Number(row.is_public) === 1,
    filterable: Number(row.is_filterable) === 1,
    unique_values: Number(row.unique_values) === 1,
    pinned: row.pinned_position !== null,
    pinned_position: row.pinned_position === null ? null : Number(row.pinned_position),
    ...(count === undefined ? {} : { values_count: count }),
  };
}

const DEFINITION_COLUMNS = `id, owner_type, namespace, meta_key, name, description, value_type, validations, constraints,
  is_required, is_public, is_filterable, unique_values, pinned_position, created_at, updated_at`;

export interface DefinitionInput {
  owner_type?: OwnerType;
  name?: string;
  namespace?: string;
  key?: string;
  description?: string | null;
  type?: string;
  validations?: Record<string, unknown> | null;
  constraints?: Constraints | null;
  required?: boolean;
  storefront?: boolean;
  filterable?: boolean;
  unique_values?: boolean;
  pinned?: boolean;
}

export interface MetafieldInput {
  namespace: string;
  key: string;
  value: unknown;
  /** Only for a field with no definition (apps, imports): its type. */
  type?: string;
}

export interface MetafieldValue {
  definition_id: number | null;
  namespace: string;
  key: string;
  type: string;
  value: unknown;
}

interface ValueRow extends RowDataPacket {
  id: number;
  owner_id: number;
  definition_id: number | null;
  namespace: string;
  meta_key: string;
  value_type: string | null;
  value_text: string | null;
  value_number: string | null;
  value_boolean: number | null;
  value_datetime: Date | null;
  value_json: unknown;
  value_media_id: number | null;
  value_ref: number | null;
  def_type: string | null;
}

function cleanConstraints(raw: Constraints | null | undefined): Constraints | null {
  if (!raw) return null;
  const types = [...new Set((raw.product_types ?? []).map((type) => String(type).trim()).filter(Boolean))].slice(0, 50);
  const categories = [...new Set((raw.categories ?? []).map((code) => String(code).trim()).filter(Boolean))].slice(0, 50);
  if (types.length === 0 && categories.length === 0) return null;
  return { ...(types.length ? { product_types: types } : {}), ...(categories.length ? { categories } : {}) };
}

/** Whether a definition applies to a product of this type and category (its constraints). */
export function appliesTo(definition: Pick<Definition, 'constraints'>, product: { product_type?: string | null; category_code?: string | null }): boolean {
  const constraints = definition.constraints;
  if (!constraints) return true;
  const typeOk = !constraints.product_types?.length || constraints.product_types.some((type) => type.toLowerCase() === (product.product_type ?? '').toLowerCase());
  const categoryOk =
    !constraints.categories?.length ||
    constraints.categories.some((code) => product.category_code === code || (product.category_code ?? '').startsWith(`${code}/`));
  return typeOk && categoryOk;
}

interface ActorMeta {
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

// ── references ───────────────────────────────────────────────────────────────

export interface ReferenceLabel {
  id: number;
  label: string;
  sublabel?: string | null;
  image?: string | null;
  missing?: boolean;
}

async function existingIds(kind: ReferenceKind, ids: number[], exec: Executor, metaobjectType?: string | null): Promise<Set<number>> {
  if (ids.length === 0) return new Set();
  const marks = ids.map(() => '?').join(', ');
  let rows: RowDataPacket[] = [];
  switch (kind) {
    case 'product':
      rows = await query(`SELECT id FROM products WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${marks})`, [shopId(), ...ids], exec);
      break;
    case 'variant':
      rows = await query(`SELECT id FROM product_variants WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${marks})`, [shopId(), ...ids], exec);
      break;
    case 'collection':
      rows = await query(`SELECT id FROM collections WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${marks})`, [shopId(), ...ids], exec);
      break;
    case 'file':
      rows = await query(`SELECT id FROM media WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${marks})`, [shopId(), ...ids], exec);
      break;
    case 'page':
      rows = await query(`SELECT id FROM cms_pages WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${marks})`, [shopId(), ...ids], exec);
      break;
    case 'metaobject':
      rows = metaobjectType
        ? await query(
            `SELECT m.id FROM metaobjects m JOIN metaobject_definitions d ON d.shop_id = m.shop_id AND d.id = m.definition_id
              WHERE m.shop_id = ? AND d.type = ? AND m.id IN (${marks})`,
            [shopId(), metaobjectType, ...ids],
            exec,
          )
        : await query(`SELECT id FROM metaobjects WHERE shop_id = ? AND id IN (${marks})`, [shopId(), ...ids], exec);
      break;
  }
  return new Set(rows.map((row) => Number(row.id)));
}

async function fileKindsOf(ids: number[], exec: Executor): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  const rows = await query<RowDataPacket & { id: number; media_type: string }>(
    `SELECT id, media_type FROM media WHERE shop_id = ? AND id IN (${ids.map(() => '?').join(', ')})`,
    [shopId(), ...ids],
    exec,
  );
  return new Map(rows.map((row) => [Number(row.id), row.media_type === 'image' || row.media_type === 'video' ? row.media_type : 'document']));
}

/** Checks that what a value points at exists (and is the right kind). Returns an error message or null. */
async function checkReferences(type: string, validations: Validations, value: unknown, exec: Executor): Promise<string | null> {
  const refs = referencesOf(type, value);
  if (!refs || refs.ids.length === 0) return null;
  const found = await existingIds(refs.kind, refs.ids, exec, refs.kind === 'metaobject' ? validations.metaobject_type : null);
  const missing = refs.ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return refs.kind === 'metaobject' && validations.metaobject_type
      ? `Choose entries of ${validations.metaobject_type}; ${missing.length === 1 ? 'one was' : `${missing.length} were`} not found.`
      : `${missing.length === 1 ? 'One chosen item no longer exists' : `${missing.length} chosen items no longer exist`}.`;
  }
  if (refs.kind === 'file' && validations.file_types?.length) {
    const kinds = await fileKindsOf(refs.ids, exec);
    const wrong = refs.ids.find((id) => !validations.file_types!.includes((kinds.get(id) ?? 'document') as 'image'));
    if (wrong) return `Choose ${validations.file_types.join(' or ')} files.`;
  }
  return null;
}

// ── the service ──────────────────────────────────────────────────────────────

export const customDataService = {
  // ── definitions ────────────────────────────────────────────────────────────

  async definitions(ownerType: string, exec: Executor = pool, withCounts = false): Promise<Definition[]> {
    const rows = await query<DefinitionRow>(
      `SELECT ${DEFINITION_COLUMNS} FROM metafield_definitions
        WHERE shop_id = ? AND owner_type = ?
        ORDER BY pinned_position IS NULL, pinned_position, sort_order, name`,
      [shopId(), ownerType],
      exec,
    );
    if (!withCounts || rows.length === 0) return rows.map((row) => presentDefinition(row));
    const counts = await query<RowDataPacket & { definition_id: number; n: number }>(
      `SELECT definition_id, COUNT(*) AS n FROM metafields
        WHERE shop_id = ? AND owner_type = ? AND definition_id IS NOT NULL
        GROUP BY definition_id`,
      [shopId(), ownerType],
      exec,
    );
    const byId = new Map(counts.map((row) => [Number(row.definition_id), Number(row.n)]));
    return rows.map((row) => presentDefinition(row, byId.get(Number(row.id)) ?? 0));
  },

  async definition(id: number, exec: Executor = pool): Promise<Definition> {
    const row = await queryOne<DefinitionRow>(`SELECT ${DEFINITION_COLUMNS} FROM metafield_definitions WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
    if (!row) throw ApiError.notFound('Custom field');
    const count = await queryOne<RowDataPacket & { n: number }>('SELECT COUNT(*) AS n FROM metafields WHERE shop_id = ? AND definition_id = ?', [shopId(), id], exec);
    return presentDefinition(row, Number(count?.n ?? 0));
  },

  async createDefinition(input: DefinitionInput, actor: AuthenticatedAdmin, meta: ActorMeta = {}): Promise<Definition> {
    const errors: FieldErrors = {};
    const ownerType = input.owner_type ?? 'product';
    const name = (input.name ?? '').trim();
    if (!name) errors.name = ['Name the field.'];
    const namespace = (input.namespace ?? 'custom').trim().toLowerCase();
    const key = (input.key ?? slugify(name).replace(/-/g, '_')).trim().toLowerCase();
    if (!NAMESPACE_RE.test(namespace)) errors.namespace = ['2–50 lower-case letters, digits, - or _.'];
    else if (RESERVED_NAMESPACES.has(namespace)) errors.namespace = [`${namespace} is reserved.`];
    if (!KEY_RE.test(key)) errors.key = ['2–60 lower-case letters, digits, - or _.'];
    const type = (input.type ?? '').trim();
    const parsed = parseType(type);
    if (!parsed) errors.type = ['Choose a type.'];
    let validations: Validations = {};
    if (parsed) {
      const checked = checkValidations(type, input.validations ?? {});
      if (!checked.ok) for (const [field, message] of Object.entries(checked.errors)) errors[`validations.${field}`] = [message];
      else validations = checked.validations;
    }
    if (input.unique_values && (!parsed || parsed.list || !UNIQUE_CAPABLE.has(parsed.base))) errors.unique_values = ['Only single-line text, URL and number fields can require unique values.'];
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    if (validations.metaobject_type) await this.metaobjectDefinitionByType(validations.metaobject_type);

    return withTransaction(async (tx) => {
      const count = await queryOne<RowDataPacket & { n: number }>('SELECT COUNT(*) AS n FROM metafield_definitions WHERE shop_id = ? AND owner_type = ?', [shopId(), ownerType], tx);
      if (Number(count?.n ?? 0) >= MAX_DEFINITIONS_PER_OWNER) throw ApiError.conflict(`A store can have at most ${MAX_DEFINITIONS_PER_OWNER} ${ownerType} fields.`, 'PLAN_LIMIT_REACHED');
      const taken = await queryOne('SELECT id FROM metafield_definitions WHERE shop_id = ? AND owner_type = ? AND namespace = ? AND meta_key = ?', [shopId(), ownerType, namespace, key], tx);
      if (taken) throw ApiError.validation({ key: [`There is already a ${ownerType} field ${namespace}.${key}.`] });
      let pinned: number | null = null;
      if (input.pinned ?? true) {
        const top = await queryOne<RowDataPacket & { top: number | null }>('SELECT MAX(pinned_position) AS top FROM metafield_definitions WHERE shop_id = ? AND owner_type = ?', [shopId(), ownerType], tx);
        pinned = Number(top?.top ?? 0) + 1;
      }
      const id = await insert(
        `INSERT INTO metafield_definitions
           (shop_id, owner_type, namespace, meta_key, name, description, value_type, validations, constraints,
            is_required, is_public, is_filterable, unique_values, pinned_position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          shopId(),
          ownerType,
          namespace,
          key,
          name.slice(0, 120),
          input.description?.trim().slice(0, 500) || null,
          type,
          JSON.stringify(validations),
          JSON.stringify(cleanConstraints(input.constraints)),
          input.required ? 1 : 0,
          input.storefront === false ? 0 : 1,
          input.filterable ? 1 : 0,
          input.unique_values ? 1 : 0,
          pinned,
        ],
        tx,
      );
      await auditService.log(
        { actorId: actor.id, actorLabel: actor.email, action: 'custom_field.created', entityType: 'metafield_definition', entityId: id, summary: `Added the ${ownerType} field "${name}" (${namespace}.${key}, ${type})`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        tx,
      );
      return this.definition(id, tx);
    });
  },

  async updateDefinition(id: number, input: DefinitionInput, actor: AuthenticatedAdmin, meta: ActorMeta = {}): Promise<Definition> {
    const current = await this.definition(id);
    const errors: FieldErrors = {};
    const fields: Record<string, unknown> = {};
    if (input.name !== undefined) {
      const name = input.name.trim();
      if (!name) errors.name = ['Name the field.'];
      else fields.name = name.slice(0, 120);
    }
    if (input.description !== undefined) fields.description = input.description?.trim().slice(0, 500) || null;
    const used = (current.values_count ?? 0) > 0;
    let type = current.type;
    if (input.type !== undefined && input.type !== current.type) {
      const next = parseType(input.type);
      const prev = parseType(current.type)!;
      const textSwap = next && !next.list && !prev.list && ['single_line_text_field', 'multi_line_text_field'].includes(next.base) && ['single_line_text_field', 'multi_line_text_field'].includes(prev.base);
      if (!next) errors.type = ['Choose a type.'];
      else if (used && !textSwap) errors.type = ['The type cannot change once products have values for this field (single- and multi-line text can swap).'];
      else {
        type = input.type;
        fields.value_type = type;
      }
    }
    for (const [prop, re] of [['namespace', NAMESPACE_RE], ['key', KEY_RE]] as const) {
      const value = input[prop];
      if (value === undefined) continue;
      const next = value.trim().toLowerCase();
      const now = prop === 'namespace' ? current.namespace : current.key;
      if (next === now) continue;
      if (used) errors[prop] = ['This cannot change once products have values for this field: themes read it by this name.'];
      else if (!re.test(next)) errors[prop] = ['Lower-case letters, digits, - or _.'];
      else fields[prop === 'namespace' ? 'namespace' : 'meta_key'] = next;
    }
    if (input.validations !== undefined || fields.value_type !== undefined) {
      const checked = checkValidations(type, input.validations ?? current.validations);
      if (!checked.ok) for (const [field, message] of Object.entries(checked.errors)) errors[`validations.${field}`] = [message];
      else {
        fields.validations = JSON.stringify(checked.validations);
        if (checked.validations.metaobject_type) await this.metaobjectDefinitionByType(checked.validations.metaobject_type);
      }
    }
    if (input.constraints !== undefined) fields.constraints = JSON.stringify(cleanConstraints(input.constraints));
    if (input.required !== undefined) fields.is_required = input.required ? 1 : 0;
    if (input.storefront !== undefined) fields.is_public = input.storefront ? 1 : 0;
    if (input.filterable !== undefined) fields.is_filterable = input.filterable ? 1 : 0;
    if (input.unique_values !== undefined) {
      const parsed = parseType(type)!;
      if (input.unique_values && (parsed.list || !UNIQUE_CAPABLE.has(parsed.base))) errors.unique_values = ['Only single-line text, URL and number fields can require unique values.'];
      else fields.unique_values = input.unique_values ? 1 : 0;
    }
    if (Object.keys(errors).length) throw ApiError.validation(errors);

    await withTransaction(async (tx) => {
      if (input.unique_values && !current.unique_values) {
        const clash = await queryOne<RowDataPacket & { value_index: string }>(
          `SELECT value_index FROM metafields WHERE shop_id = ? AND definition_id = ? AND value_index IS NOT NULL
            GROUP BY value_index HAVING COUNT(*) > 1 LIMIT 1`,
          [shopId(), id],
          tx,
        );
        if (clash) throw ApiError.validation({ unique_values: [`More than one ${current.owner_type} has the value "${clash.value_index}".`] });
      }
      if (input.pinned !== undefined && input.pinned !== current.pinned) {
        if (input.pinned) {
          const top = await queryOne<RowDataPacket & { top: number | null }>('SELECT MAX(pinned_position) AS top FROM metafield_definitions WHERE shop_id = ? AND owner_type = ?', [shopId(), current.owner_type], tx);
          fields.pinned_position = Number(top?.top ?? 0) + 1;
        } else fields.pinned_position = null;
      }
      const columns = Object.keys(fields);
      if (columns.length) {
        await execute(
          `UPDATE metafield_definitions SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
          [...columns.map((column) => fields[column]), shopId(), id],
          tx,
        );
        if (fields.namespace !== undefined || fields.meta_key !== undefined) {
          await execute('UPDATE metafields SET namespace = ?, meta_key = ? WHERE shop_id = ? AND definition_id = ?', [fields.namespace ?? current.namespace, fields.meta_key ?? current.key, shopId(), id], tx);
        }
        await auditService.log(
          { actorId: actor.id, actorLabel: actor.email, action: 'custom_field.updated', entityType: 'metafield_definition', entityId: id, summary: `Changed the ${current.owner_type} field "${current.name}"`, changes: Object.fromEntries(columns.map((column) => [column, fields[column]])), context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
          tx,
        );
      }
    });
    return this.definition(id);
  },

  /** Removes a field and every value entered in it. */
  async removeDefinition(id: number, actor: AuthenticatedAdmin, meta: ActorMeta = {}): Promise<void> {
    const current = await this.definition(id);
    await withTransaction(async (tx) => {
      await execute('DELETE FROM metafields WHERE shop_id = ? AND definition_id = ?', [shopId(), id], tx);
      await execute('DELETE FROM metafield_definitions WHERE shop_id = ? AND id = ?', [shopId(), id], tx);
      await auditService.log(
        { actorId: actor.id, actorLabel: actor.email, action: 'custom_field.deleted', entityType: 'metafield_definition', entityId: id, summary: `Removed the ${current.owner_type} field "${current.name}" and ${current.values_count ?? 0} value(s)`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        tx,
      );
    });
  },

  /** Pins these fields to the edit page in this order; every other field of the owner is unpinned. */
  async setPinned(ownerType: string, ids: number[]): Promise<Definition[]> {
    await withTransaction(async (tx) => {
      await execute('UPDATE metafield_definitions SET pinned_position = NULL WHERE shop_id = ? AND owner_type = ?', [shopId(), ownerType], tx);
      for (const [index, id] of ids.entries()) {
        await execute('UPDATE metafield_definitions SET pinned_position = ? WHERE shop_id = ? AND owner_type = ? AND id = ?', [index + 1, shopId(), ownerType, id], tx);
      }
    });
    return this.definitions(ownerType, pool, true);
  },

  // ── values ─────────────────────────────────────────────────────────────────

  /** Every value of these owners, by owner id. */
  async valuesFor(ownerType: string, ownerIds: number[], exec: Executor = pool): Promise<Map<number, MetafieldValue[]>> {
    const out = new Map<number, MetafieldValue[]>();
    if (ownerIds.length === 0) return out;
    const rows: ValueRow[] = [];
    for (let start = 0; start < ownerIds.length; start += 1000) {
      const chunk = ownerIds.slice(start, start + 1000);
      rows.push(
        ...(await query<ValueRow>(
          `SELECT m.id, m.owner_id, m.definition_id, m.namespace, m.meta_key, m.value_type, m.value_text, m.value_number,
                  m.value_boolean, m.value_datetime, m.value_json, m.value_media_id, m.value_ref, d.value_type AS def_type
             FROM metafields m
             LEFT JOIN metafield_definitions d ON d.shop_id = m.shop_id AND d.id = m.definition_id
            WHERE m.shop_id = ? AND m.owner_type = ? AND m.locale = 'en-IN' AND m.owner_id IN (${chunk.map(() => '?').join(', ')})
            ORDER BY m.id`,
          [shopId(), ownerType, ...chunk],
          exec,
        )),
      );
    }
    for (const row of rows) {
      const type = row.def_type ?? row.value_type ?? 'single_line_text_field';
      const list = out.get(Number(row.owner_id)) ?? [];
      list.push({ definition_id: row.definition_id === null ? null : Number(row.definition_id), namespace: row.namespace, key: row.meta_key, type, value: fromStored(type, row) });
      out.set(Number(row.owner_id), list);
    }
    return out;
  },

  /**
   * Writes an owner's field values inside the caller's transaction. Each is
   * checked against its definition (type, validations, references, unique
   * values); null clears it. `requiredFor` makes the definitions that apply
   * to this product and are marked required refuse to be empty — on create,
   * and whenever the product's fields are sent. Errors are keyed
   * `metafields.<namespace>.<key>` so the admin can put them on the field.
   */
  async writeValues(
    ownerType: OwnerType,
    ownerId: number,
    inputs: MetafieldInput[],
    tx: Executor,
    options: { requiredFor?: { product_type?: string | null; category_code?: string | null } | null; errorPrefix?: string } = {},
  ): Promise<void> {
    const prefix = options.errorPrefix ?? 'metafields';
    const definitions = await this.definitions(ownerType, tx);
    const byKey = new Map(definitions.map((definition) => [definition.full_key, definition]));
    const errors: FieldErrors = {};
    const writes: { definition: Definition | null; namespace: string; key: string; type: string; value: unknown }[] = [];
    const seen = new Set<string>();

    for (const input of inputs) {
      const namespace = String(input.namespace ?? '').trim().toLowerCase();
      const key = String(input.key ?? '').trim().toLowerCase();
      const fullKey = `${namespace}.${key}`;
      const path = `${prefix}.${fullKey}`;
      if (seen.has(fullKey)) continue;
      seen.add(fullKey);
      const definition = byKey.get(fullKey) ?? null;
      const type = definition?.type ?? input.type ?? '';
      if (!definition && (!NAMESPACE_RE.test(namespace) || !KEY_RE.test(key))) {
        errors[path] = ['Unknown field.'];
        continue;
      }
      if (!definition && !parseType(type)) {
        errors[path] = ['A field without a definition needs a type.'];
        continue;
      }
      const checked = checkValue(type, definition?.validations ?? {}, input.value);
      if (!checked.ok) {
        errors[path] = [checked.error];
        continue;
      }
      if (checked.value !== null) {
        const refError = await checkReferences(type, definition?.validations ?? {}, checked.value, tx);
        if (refError) {
          errors[path] = [refError];
          continue;
        }
      }
      writes.push({ definition, namespace, key, type, value: checked.value });
    }

    if (options.requiredFor) {
      const existing = (await this.valuesFor(ownerType, [ownerId], tx)).get(ownerId) ?? [];
      for (const definition of definitions) {
        if (!definition.required || !appliesTo(definition, options.requiredFor)) continue;
        const write = writes.find((candidate) => candidate.definition?.id === definition.id);
        const has = write ? write.value !== null : existing.some((value) => value.definition_id === definition.id && value.value !== null);
        if (!has) errors[`${prefix}.${definition.full_key}`] = [`${definition.name} is required.`];
      }
    }
    if (Object.keys(errors).length) throw ApiError.validation(errors, 'Some custom fields need attention.');

    for (const write of writes) {
      if (write.value === null) {
        await execute(
          `DELETE FROM metafields WHERE shop_id = ? AND owner_type = ? AND owner_id = ? AND namespace = ? AND meta_key = ? AND locale = 'en-IN'`,
          [shopId(), ownerType, ownerId, write.namespace, write.key],
          tx,
        );
        continue;
      }
      const stored = toStored(write.type, write.value);
      if (write.definition?.unique_values && stored.value_index !== null) {
        const clash = await queryOne(
          `SELECT owner_id FROM metafields WHERE shop_id = ? AND definition_id = ? AND value_index = ? AND owner_id <> ? LIMIT 1`,
          [shopId(), write.definition.id, stored.value_index, ownerId],
          tx,
        );
        if (clash) throw ApiError.validation({ [`${prefix}.${write.definition.full_key}`]: [`Another ${ownerType} already has "${String(write.value)}".`] });
      }
      await execute(
        `INSERT INTO metafields
           (shop_id, definition_id, owner_type, owner_id, namespace, meta_key, locale, value_type,
            value_text, value_number, value_boolean, value_datetime, value_json, value_media_id, value_ref, value_index)
         VALUES (?, ?, ?, ?, ?, ?, 'en-IN', ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           definition_id = VALUES(definition_id), value_type = VALUES(value_type), value_text = VALUES(value_text),
           value_number = VALUES(value_number), value_boolean = VALUES(value_boolean), value_datetime = VALUES(value_datetime),
           value_json = VALUES(value_json), value_media_id = VALUES(value_media_id), value_ref = VALUES(value_ref),
           value_index = VALUES(value_index)`,
        [
          shopId(),
          write.definition?.id ?? null,
          ownerType,
          ownerId,
          write.namespace,
          write.key,
          stored.value_type,
          stored.value_text,
          stored.value_number,
          stored.value_boolean,
          stored.value_datetime,
          stored.value_json,
          stored.value_media_id,
          stored.value_ref,
          stored.value_index,
        ],
        tx,
      );
    }
  },

  async removeValuesOf(ownerType: OwnerType, ownerIds: number[], tx: Executor): Promise<void> {
    for (let start = 0; start < ownerIds.length; start += 1000) {
      const chunk = ownerIds.slice(start, start + 1000);
      await execute(`DELETE FROM metafields WHERE shop_id = ? AND owner_type = ? AND owner_id IN (${chunk.map(() => '?').join(', ')})`, [shopId(), ownerType, ...chunk], tx);
    }
  },

  // ── references, for the admin's pickers ────────────────────────────────────

  async resolveReferences(kind: ReferenceKind, ids: number[]): Promise<ReferenceLabel[]> {
    const unique = [...new Set(ids.filter((id) => Number.isSafeInteger(id) && id > 0))].slice(0, 500);
    if (unique.length === 0) return [];
    const labels = await this.lookup(kind, { ids: unique });
    const byId = new Map(labels.map((label) => [label.id, label]));
    return unique.map((id) => byId.get(id) ?? { id, label: `#${id}`, missing: true });
  },

  async searchReferences(kind: ReferenceKind, q: string, metaobjectType?: string | null): Promise<ReferenceLabel[]> {
    return this.lookup(kind, { q: q.trim(), metaobjectType });
  },

  async lookup(kind: ReferenceKind, { ids, q, metaobjectType }: { ids?: number[]; q?: string; metaobjectType?: string | null }): Promise<ReferenceLabel[]> {
    const byIds = ids && ids.length > 0;
    const marks = byIds ? ids!.map(() => '?').join(', ') : '';
    const like = `%${(q ?? '').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const limit = byIds ? '' : ' LIMIT 20';
    type Row = RowDataPacket & { id: number; label: string; sublabel: string | null; image_key: string | null; image_url: string | null };
    let rows: Row[] = [];
    switch (kind) {
      case 'product':
        rows = await query<Row>(
          `SELECT p.id, p.name AS label, p.status AS sublabel, NULL AS image_url,
                  (SELECT m.storage_key FROM media_attachments ma JOIN media m ON m.shop_id = ma.shop_id AND m.id = ma.media_id
                    WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id AND ma.collection = 'gallery'
                    ORDER BY ma.is_primary DESC, ma.sort_order LIMIT 1) AS image_key
             FROM products p
            WHERE p.shop_id = ? AND p.deleted_at IS NULL AND ${byIds ? `p.id IN (${marks})` : 'p.name LIKE ?'}
            ORDER BY p.name${limit}`,
          [shopId(), ...(byIds ? ids! : [like])],
        );
        break;
      case 'variant':
        rows = await query<Row>(
          `SELECT v.id, CONCAT(p.name, CASE WHEN v.variant_title IS NULL OR v.variant_title = '' THEN '' ELSE CONCAT(' — ', v.variant_title) END) AS label,
                  v.sku AS sublabel, NULL AS image_key, NULL AS image_url
             FROM product_variants v JOIN products p ON p.shop_id = v.shop_id AND p.id = v.product_id
            WHERE v.shop_id = ? AND v.deleted_at IS NULL AND ${byIds ? `v.id IN (${marks})` : '(p.name LIKE ? OR v.sku LIKE ?)'}
            ORDER BY p.name, v.position${limit}`,
          [shopId(), ...(byIds ? ids! : [like, like])],
        );
        break;
      case 'collection':
        rows = await query<Row>(
          `SELECT id, title AS label, slug AS sublabel, NULL AS image_key, NULL AS image_url FROM collections
            WHERE shop_id = ? AND deleted_at IS NULL AND ${byIds ? `id IN (${marks})` : 'title LIKE ?'} ORDER BY title${limit}`,
          [shopId(), ...(byIds ? ids! : [like])],
        );
        break;
      case 'page':
        rows = await query<Row>(
          `SELECT id, title AS label, slug AS sublabel, NULL AS image_key, NULL AS image_url FROM cms_pages
            WHERE shop_id = ? AND deleted_at IS NULL AND ${byIds ? `id IN (${marks})` : 'title LIKE ?'} ORDER BY title${limit}`,
          [shopId(), ...(byIds ? ids! : [like])],
        );
        break;
      case 'file':
        rows = await query<Row>(
          `SELECT id, COALESCE(NULLIF(title, ''), original_filename, CONCAT('File ', id)) AS label, media_type AS sublabel,
                  storage_key AS image_key, absolute_url AS image_url
             FROM media WHERE shop_id = ? AND deleted_at IS NULL AND ${byIds ? `id IN (${marks})` : '(original_filename LIKE ? OR title LIKE ?)'}
            ORDER BY id DESC${limit}`,
          [shopId(), ...(byIds ? ids! : [like, like])],
        );
        break;
      case 'metaobject':
        rows = await query<Row>(
          `SELECT m.id, m.display_name AS label, d.name AS sublabel, NULL AS image_key, NULL AS image_url
             FROM metaobjects m JOIN metaobject_definitions d ON d.shop_id = m.shop_id AND d.id = m.definition_id
            WHERE m.shop_id = ? AND ${byIds ? `m.id IN (${marks})` : 'm.display_name LIKE ?'}${metaobjectType && !byIds ? ' AND d.type = ?' : ''}
            ORDER BY m.display_name${limit}`,
          [shopId(), ...(byIds ? ids! : [like]), ...(metaobjectType && !byIds ? [metaobjectType] : [])],
        );
        break;
    }
    return rows.map((row) => ({
      id: Number(row.id),
      label: String(row.label ?? `#${row.id}`),
      sublabel: row.sublabel ?? null,
      image: row.image_url ?? (row.image_key && (kind === 'product' || row.sublabel === 'image') ? storage.publicUrl(row.image_key) : null),
    }));
  },

  // ── metaobjects: types ─────────────────────────────────────────────────────

  async metaobjectDefinitions(): Promise<MetaobjectDefinition[]> {
    const rows = await query<MetaobjectDefinitionRow>(`SELECT ${METAOBJECT_DEFINITION_COLUMNS} FROM metaobject_definitions WHERE shop_id = ? ORDER BY name`, [shopId()]);
    return rows.map(presentMetaobjectDefinition);
  },

  async metaobjectDefinitionByType(type: string, exec: Executor = pool): Promise<MetaobjectDefinition> {
    const row = await queryOne<MetaobjectDefinitionRow>(`SELECT ${METAOBJECT_DEFINITION_COLUMNS} FROM metaobject_definitions WHERE shop_id = ? AND type = ?`, [shopId(), type], exec);
    if (!row) throw ApiError.validation({ 'validations.metaobject_type': [`There is no metaobject type ${type}.`] });
    return presentMetaobjectDefinition(row);
  },

  /** The type an entry route names; unknown is a 404, not a validation error. */
  async metaobjectType(type: string): Promise<MetaobjectDefinition> {
    const row = await queryOne<MetaobjectDefinitionRow>(`SELECT ${METAOBJECT_DEFINITION_COLUMNS} FROM metaobject_definitions WHERE shop_id = ? AND type = ?`, [shopId(), type]);
    if (!row) throw ApiError.notFound('Metaobject type');
    return presentMetaobjectDefinition(row);
  },

  async metaobjectDefinition(id: number, exec: Executor = pool): Promise<MetaobjectDefinition> {
    const row = await queryOne<MetaobjectDefinitionRow>(`SELECT ${METAOBJECT_DEFINITION_COLUMNS} FROM metaobject_definitions WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
    if (!row) throw ApiError.notFound('Metaobject type');
    return presentMetaobjectDefinition(row);
  },

  async saveMetaobjectDefinition(id: number | null, input: MetaobjectDefinitionInput, actor: AuthenticatedAdmin, meta: ActorMeta = {}): Promise<MetaobjectDefinition> {
    const current = id ? await this.metaobjectDefinition(id) : null;
    const errors: FieldErrors = {};
    const name = (input.name ?? current?.name ?? '').trim();
    if (!name) errors.name = ['Name the type, e.g. Ingredient.'];
    const type = current ? current.type : (input.type ?? slugify(name)).trim().toLowerCase();
    if (!current && !METAOBJECT_TYPE_RE.test(type)) errors.type = ['2–64 lower-case letters, digits, - or _.'];
    const fieldsIn = input.fields ?? current?.fields ?? [];
    if (fieldsIn.length === 0) errors.fields = ['Add at least one field.'];
    if (fieldsIn.length > MAX_METAOBJECT_FIELDS) errors.fields = [`At most ${MAX_METAOBJECT_FIELDS} fields.`];
    const fields: MetaobjectField[] = [];
    for (const [index, field] of fieldsIn.entries()) {
      const key = (field.key ?? slugify(field.name ?? '').replace(/-/g, '_')).trim().toLowerCase();
      const fieldName = (field.name ?? '').trim();
      if (!fieldName) errors[`fields.${index}.name`] = ['Name the field.'];
      if (!FIELD_KEY_RE.test(key)) errors[`fields.${index}.key`] = ['Lower-case letters, digits and _.'];
      else if (fields.some((other) => other.key === key)) errors[`fields.${index}.key`] = [`${key} is used twice.`];
      const parsed = parseType(field.type ?? '');
      if (!parsed) {
        errors[`fields.${index}.type`] = ['Choose a type.'];
        continue;
      }
      const checked = checkValidations(field.type, field.validations ?? {});
      if (!checked.ok) {
        for (const [prop, message] of Object.entries(checked.errors)) errors[`fields.${index}.validations.${prop}`] = [message];
        continue;
      }
      if (current) {
        const before = current.fields.find((other) => other.key === key);
        if (before && before.type !== field.type && current.entry_count > 0) errors[`fields.${index}.type`] = ['The type of a field cannot change once there are entries.'];
      }
      fields.push({ key, name: fieldName.slice(0, 120), type: field.type, description: field.description?.trim().slice(0, 300) || null, required: Boolean(field.required), validations: checked.validations });
    }
    const displayKey = input.display_name_key ?? current?.display_name_key ?? fields.find((field) => field.type === 'single_line_text_field')?.key ?? null;
    if (displayKey && !fields.some((field) => field.key === displayKey)) errors.display_name_key = ['Choose one of the fields.'];
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    for (const field of fields) if (field.validations.metaobject_type && field.validations.metaobject_type !== type) await this.metaobjectDefinitionByType(field.validations.metaobject_type);

    const savedId = await withTransaction(async (tx) => {
      if (!current) {
        const count = await queryOne<RowDataPacket & { n: number }>('SELECT COUNT(*) AS n FROM metaobject_definitions WHERE shop_id = ?', [shopId()], tx);
        if (Number(count?.n ?? 0) >= MAX_METAOBJECT_TYPES) throw ApiError.conflict(`A store can have at most ${MAX_METAOBJECT_TYPES} metaobject types.`, 'PLAN_LIMIT_REACHED');
        const taken = await queryOne('SELECT id FROM metaobject_definitions WHERE shop_id = ? AND type = ?', [shopId(), type], tx);
        if (taken) throw ApiError.validation({ type: [`There is already a type ${type}.`] });
        const newId = await insert(
          `INSERT INTO metaobject_definitions (shop_id, type, name, description, display_name_key, fields, is_publishable, is_translatable, is_public)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [shopId(), type, name.slice(0, 120), input.description?.trim().slice(0, 500) || null, displayKey, JSON.stringify(fields), input.publishable === false ? 0 : 1, input.translatable ? 1 : 0, input.storefront === false ? 0 : 1],
          tx,
        );
        await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'metaobject_type.created', entityType: 'metaobject_definition', entityId: newId, summary: `Added the metaobject type "${name}"`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, tx);
        return newId;
      }
      await execute(
        `UPDATE metaobject_definitions SET name = ?, description = ?, display_name_key = ?, fields = ?, is_publishable = ?, is_translatable = ?, is_public = ?
          WHERE shop_id = ? AND id = ?`,
        [
          name.slice(0, 120),
          input.description === undefined ? current.description : input.description?.trim().slice(0, 500) || null,
          displayKey,
          JSON.stringify(fields),
          (input.publishable ?? current.publishable) ? 1 : 0,
          (input.translatable ?? current.translatable) ? 1 : 0,
          (input.storefront ?? current.storefront) ? 1 : 0,
          shopId(),
          current.id,
        ],
        tx,
      );
      if (displayKey !== current.display_name_key) await this.refreshDisplayNames(current.id, displayKey, fields, tx);
      await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'metaobject_type.updated', entityType: 'metaobject_definition', entityId: current.id, summary: `Changed the metaobject type "${name}"`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, tx);
      return current.id;
    });
    return this.metaobjectDefinition(savedId);
  },

  async removeMetaobjectDefinition(id: number, actor: AuthenticatedAdmin, meta: ActorMeta = {}): Promise<void> {
    const current = await this.metaobjectDefinition(id);
    const usedBy = await queryOne<RowDataPacket & { name: string }>(
      `SELECT name FROM metafield_definitions WHERE shop_id = ? AND JSON_UNQUOTE(JSON_EXTRACT(validations, '$.metaobject_type')) = ? LIMIT 1`,
      [shopId(), current.type],
    );
    if (usedBy) throw ApiError.conflict(`The field "${usedBy.name}" points at ${current.name}. Remove that field first.`, 'IN_USE');
    const optionUse = await queryOne('SELECT id FROM catalog_product_options WHERE shop_id = ? AND linked_metaobject_type = ? LIMIT 1', [shopId(), current.type]);
    if (optionUse) throw ApiError.conflict(`A product option takes its values from ${current.name}.`, 'IN_USE');
    await withTransaction(async (tx) => {
      await execute('DELETE FROM metaobject_definitions WHERE shop_id = ? AND id = ?', [shopId(), id], tx);
      await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'metaobject_type.deleted', entityType: 'metaobject_definition', entityId: id, summary: `Removed the metaobject type "${current.name}" and its ${current.entry_count} entries`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, tx);
    });
  },

  // ── metaobjects: entries ───────────────────────────────────────────────────

  async entries(type: string, { q, limit = 50, after }: { q?: string; limit?: number; after?: string | null } = {}) {
    const definition = await this.metaobjectType(type);
    const params: unknown[] = [shopId(), definition.id];
    let where = 'shop_id = ? AND definition_id = ?';
    if (q?.trim()) {
      where += ' AND (display_name LIKE ? OR handle LIKE ?)';
      const like = `%${q.trim().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    if (after) {
      const [name, id] = decodeCursor(after);
      where += ' AND (display_name > ? OR (display_name = ? AND id > ?))';
      params.push(name, name, Number(id));
    }
    const size = Math.min(Math.max(limit, 1), 250);
    const rows = await query<MetaobjectRow>(`SELECT ${METAOBJECT_COLUMNS} FROM metaobjects WHERE ${where} ORDER BY display_name, id LIMIT ${size + 1}`, params);
    const page = rows.slice(0, size);
    return {
      definition,
      entries: page.map((row) => presentMetaobject(row, definition)),
      next: rows.length > size ? encodeCursor([page[page.length - 1].display_name, page[page.length - 1].id]) : null,
    };
  },

  async entry(id: number, exec: Executor = pool) {
    const row = await queryOne<MetaobjectRow>(`SELECT ${METAOBJECT_COLUMNS} FROM metaobjects WHERE shop_id = ? AND id = ?`, [shopId(), id], exec);
    if (!row) throw ApiError.notFound('Entry');
    const definition = await this.metaobjectDefinition(Number(row.definition_id), exec);
    return presentMetaobject(row, definition);
  },

  async saveEntry(type: string, id: number | null, input: MetaobjectEntryInput, actor: AuthenticatedAdmin, meta: ActorMeta = {}) {
    const definition = await this.metaobjectType(type);
    const current = id ? await this.entry(id) : null;
    if (current && current.definition_id !== definition.id) throw ApiError.notFound('Entry');
    const errors: FieldErrors = {};
    const values: Record<string, unknown> = { ...(current?.fields ?? {}) };
    const given = input.fields ?? {};
    for (const field of definition.fields) {
      if (!(field.key in given) && current) continue;
      const checked = checkValue(field.type, field.validations, given[field.key]);
      if (!checked.ok) {
        errors[`fields.${field.key}`] = [checked.error];
        continue;
      }
      if (checked.value !== null) {
        const refError = await checkReferences(field.type, field.validations, checked.value, pool);
        if (refError) {
          errors[`fields.${field.key}`] = [refError];
          continue;
        }
      }
      if (checked.value === null) delete values[field.key];
      else values[field.key] = checked.value;
    }
    for (const field of definition.fields) if (field.required && (values[field.key] === undefined || values[field.key] === null)) errors[`fields.${field.key}`] ??= [`${field.name} is required.`];
    if (Object.keys(errors).length) throw ApiError.validation(errors);
    const displayName = displayNameOf(definition.display_name_key, definition.fields, values) || input.handle || current?.handle || 'Untitled';
    const handleBase = slugify(input.handle ?? current?.handle ?? displayName) || 'entry';
    const status = input.status ?? current?.status ?? 'active';

    const savedId = await withTransaction(async (tx) => {
      let handle = handleBase;
      for (let n = 2; ; n += 1) {
        const taken = await queryOne<RowDataPacket & { id: number }>('SELECT id FROM metaobjects WHERE shop_id = ? AND definition_id = ? AND handle = ?', [shopId(), definition.id, handle], tx);
        if (!taken || Number(taken.id) === current?.id) break;
        if (input.handle && current?.handle !== input.handle) throw ApiError.validation({ handle: [`Another entry is already called ${handle}.`] });
        handle = `${handleBase}-${n}`;
      }
      let entryId = current?.id ?? 0;
      if (current) {
        await execute(
          'UPDATE metaobjects SET handle = ?, display_name = ?, status = ?, fields = ?, updated_by_admin_id = ? WHERE shop_id = ? AND id = ?',
          [handle, displayName.slice(0, 255), status, JSON.stringify(values), actor.id, shopId(), current.id],
          tx,
        );
      } else {
        entryId = await insert(
          'INSERT INTO metaobjects (shop_id, definition_id, handle, display_name, status, fields, updated_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [shopId(), definition.id, handle, displayName.slice(0, 255), status, JSON.stringify(values), actor.id],
          tx,
        );
        await execute('UPDATE metaobject_definitions SET entry_count = entry_count + 1 WHERE shop_id = ? AND id = ?', [shopId(), definition.id], tx);
      }
      await auditService.log(
        { actorId: actor.id, actorLabel: actor.email, action: current ? 'metaobject.updated' : 'metaobject.created', entityType: 'metaobject', entityId: entryId, summary: `${current ? 'Changed' : 'Added'} the ${definition.name} "${displayName}"`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null },
        tx,
      );
      return entryId;
    });
    return this.entry(savedId);
  },

  async removeEntry(type: string, id: number, actor: AuthenticatedAdmin, meta: ActorMeta = {}): Promise<void> {
    const definition = await this.metaobjectType(type);
    const current = await this.entry(id);
    if (current.definition_id !== definition.id) throw ApiError.notFound('Entry');
    const option = await queryOne<RowDataPacket & { name: string }>(
      `SELECT p.title AS name FROM catalog_option_values v JOIN catalog_products p ON p.shop_id = v.shop_id AND p.id = v.product_id
        WHERE v.shop_id = ? AND v.linked_metaobject_id = ? AND p.deleted_at IS NULL LIMIT 1`,
      [shopId(), id],
    );
    if (option) throw ApiError.conflict(`"${current.display_name}" is an option value of ${option.name}.`, 'IN_USE');
    await withTransaction(async (tx) => {
      await execute('DELETE FROM metaobjects WHERE shop_id = ? AND id = ?', [shopId(), id], tx);
      await execute('UPDATE metaobject_definitions SET entry_count = GREATEST(entry_count, 1) - 1 WHERE shop_id = ? AND id = ?', [shopId(), definition.id], tx);
      await execute(`DELETE FROM metafields WHERE shop_id = ? AND value_ref = ? AND value_type = 'metaobject_reference'`, [shopId(), id], tx);
      await auditService.log({ actorId: actor.id, actorLabel: actor.email, action: 'metaobject.deleted', entityType: 'metaobject', entityId: id, summary: `Removed the ${definition.name} "${current.display_name}"`, context: { request_id: meta.requestId }, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null }, tx);
    });
  },

  async refreshDisplayNames(definitionId: number, displayKey: string | null, fields: MetaobjectField[], tx: Executor): Promise<void> {
    const rows = await query<MetaobjectRow>(`SELECT ${METAOBJECT_COLUMNS} FROM metaobjects WHERE shop_id = ? AND definition_id = ?`, [shopId(), definitionId], tx);
    for (const row of rows) {
      const name = displayNameOf(displayKey, fields, json<Record<string, unknown>>(row.fields, {})) || row.handle;
      if (name !== row.display_name) await execute('UPDATE metaobjects SET display_name = ? WHERE shop_id = ? AND id = ?', [name.slice(0, 255), shopId(), row.id], tx);
    }
  },
};

// ── metaobject shapes ────────────────────────────────────────────────────────

export interface MetaobjectField {
  key: string;
  name: string;
  type: string;
  description: string | null;
  required: boolean;
  validations: Validations;
}

export interface MetaobjectDefinition {
  id: number;
  type: string;
  name: string;
  description: string | null;
  display_name_key: string | null;
  fields: MetaobjectField[];
  publishable: boolean;
  translatable: boolean;
  storefront: boolean;
  entry_count: number;
  updated_at: string;
}

export interface MetaobjectDefinitionInput {
  type?: string;
  name?: string;
  description?: string | null;
  display_name_key?: string | null;
  fields?: { key?: string; name: string; type: string; description?: string | null; required?: boolean; validations?: Record<string, unknown> | null }[];
  publishable?: boolean;
  translatable?: boolean;
  storefront?: boolean;
}

export interface MetaobjectEntryInput {
  handle?: string;
  status?: 'draft' | 'active';
  fields?: Record<string, unknown>;
}

interface MetaobjectDefinitionRow extends RowDataPacket {
  id: number;
  type: string;
  name: string;
  description: string | null;
  display_name_key: string | null;
  fields: unknown;
  is_publishable: number;
  is_translatable: number;
  is_public: number;
  entry_count: number;
  updated_at: Date;
}

interface MetaobjectRow extends RowDataPacket {
  id: number;
  definition_id: number;
  handle: string;
  display_name: string;
  status: 'draft' | 'active';
  fields: unknown;
  updated_at: Date;
}

const METAOBJECT_DEFINITION_COLUMNS = 'id, type, name, description, display_name_key, fields, is_publishable, is_translatable, is_public, entry_count, updated_at';
const METAOBJECT_COLUMNS = 'id, definition_id, handle, display_name, status, fields, updated_at';

function presentMetaobjectDefinition(row: MetaobjectDefinitionRow): MetaobjectDefinition {
  return {
    id: Number(row.id),
    type: row.type,
    name: row.name,
    description: row.description,
    display_name_key: row.display_name_key,
    fields: json<MetaobjectField[]>(row.fields, []),
    publishable: Number(row.is_publishable) === 1,
    translatable: Number(row.is_translatable) === 1,
    storefront: Number(row.is_public) === 1,
    entry_count: Number(row.entry_count),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

function presentMetaobject(row: MetaobjectRow, definition: MetaobjectDefinition) {
  return {
    id: Number(row.id),
    definition_id: Number(row.definition_id),
    type: definition.type,
    handle: row.handle,
    display_name: row.display_name,
    status: row.status,
    fields: json<Record<string, unknown>>(row.fields, {}),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

export function displayNameOf(displayKey: string | null, fields: MetaobjectField[], values: Record<string, unknown>): string {
  const field = fields.find((candidate) => candidate.key === displayKey);
  if (!field) return '';
  return displayText(field.type, values[field.key]).slice(0, 255);
}

export function encodeCursor(parts: unknown[]): string {
  return Buffer.from(JSON.stringify(parts)).toString('base64url');
}

export function decodeCursor(cursor: string): unknown[] {
  try {
    const parts = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (Array.isArray(parts)) return parts;
  } catch {
    /* fall through */
  }
  throw ApiError.badRequest('That page link is no longer valid.');
}
