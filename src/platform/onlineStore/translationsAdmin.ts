import { createHash } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { execute, query, queryOne, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';
import { extractSchema, parseJsonTemplate, type JsonTemplate, type SectionSchema } from '../themes/themeSchema';
import { themesRepository } from '../themes/themes.repository';
import { themeLoader } from './themeLoader';
import { shopLanguages } from './languages';

/**
 * The translation editor's side of `translations` — Shopify's
 * Translate & Adapt: pick a language and a kind of content, see each
 * resource's original text beside its translation, and save.
 *
 * A translation remembers a digest of the text it was made from, so when a
 * product's description is rewritten the editor can say its French is
 * "outdated" rather than silently showing the old meaning.
 */

export type ResourceKind = 'product' | 'collection' | 'page' | 'article' | 'link' | 'theme';

interface SourceField {
  key: string;
  label: string;
  /** 'text' for one line, 'html' for rich text, 'multiline' for plain paragraphs. */
  format: 'text' | 'html' | 'multiline';
  original: string;
}

interface SourceResource {
  id: number;
  title: string;
  subtitle: string | null;
  fields: SourceField[];
}

const digest = (text: string) => createHash('sha256').update(text).digest('hex');

interface Row extends RowDataPacket {
  [key: string]: unknown;
}

/** Where each kind's text lives, and which of its columns a merchant translates. */
const SPECS: Record<Exclude<ResourceKind, 'theme'>, { table: string; where: string; title: string; subtitle: string; order: string; fields: { key: string; column: string; label: string; format: SourceField['format'] }[] }> = {
  product: {
    table: 'products',
    where: 'deleted_at IS NULL',
    title: 'name',
    subtitle: 'slug',
    order: 'updated_at DESC, id DESC',
    fields: [
      { key: 'title', column: 'name', label: 'Title', format: 'text' },
      { key: 'excerpt', column: 'short_description', label: 'Short description', format: 'multiline' },
      { key: 'body_html', column: 'description', label: 'Description', format: 'html' },
    ],
  },
  collection: {
    table: 'collections',
    where: 'deleted_at IS NULL',
    title: 'title',
    subtitle: 'slug',
    order: 'updated_at DESC, id DESC',
    fields: [
      { key: 'title', column: 'title', label: 'Title', format: 'text' },
      { key: 'description', column: 'description', label: 'Description', format: 'html' },
    ],
  },
  page: {
    table: 'cms_pages',
    where: 'deleted_at IS NULL',
    title: 'title',
    subtitle: 'slug',
    order: 'updated_at DESC, id DESC',
    fields: [
      { key: 'title', column: 'title', label: 'Title', format: 'text' },
      { key: 'body_html', column: 'body_html', label: 'Content', format: 'html' },
    ],
  },
  article: {
    table: 'cms_articles',
    where: 'deleted_at IS NULL',
    title: 'title',
    subtitle: 'slug',
    order: 'updated_at DESC, id DESC',
    fields: [
      { key: 'title', column: 'title', label: 'Title', format: 'text' },
      { key: 'excerpt', column: 'excerpt', label: 'Excerpt', format: 'multiline' },
      { key: 'body_html', column: 'body_html', label: 'Content', format: 'html' },
    ],
  },
  link: {
    table: 'cms_menu_items',
    where: 'is_active = 1',
    title: 'label',
    subtitle: '(SELECT m.name FROM cms_menus m WHERE m.shop_id = cms_menu_items.shop_id AND m.id = cms_menu_items.menu_id)',
    order: 'menu_id, sort_order, id',
    fields: [{ key: 'title', column: 'label', label: 'Link title', format: 'text' }],
  },
};

function toResource(kind: Exclude<ResourceKind, 'theme'>, row: Row, keepEmpty: boolean): SourceResource {
  return {
    id: Number(row.id),
    title: String(row.title ?? ''),
    subtitle: row.subtitle === null || row.subtitle === undefined ? null : String(row.subtitle),
    fields: SPECS[kind].fields
      .map((field) => ({ key: field.key, label: field.label, format: field.format, original: String(row[`f_${field.key}`] ?? '') }))
      .filter((field) => keepEmpty || field.original.trim() !== ''),
  };
}

const selectList = (kind: Exclude<ResourceKind, 'theme'>) => {
  const spec = SPECS[kind];
  return `id, ${spec.title} AS title, ${spec.subtitle} AS subtitle, ${spec.fields.map((field) => `${field.column} AS f_${field.key}`).join(', ')}`;
};

/** The resources of a kind, with their translatable text, one page at a time. */
async function sources(kind: Exclude<ResourceKind, 'theme'>, search: string, limit: number, offset: number): Promise<{ total: number; items: SourceResource[] }> {
  const spec = SPECS[kind];
  const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  const filter = search ? ` AND ${spec.title} LIKE ?` : '';
  const params = search ? [shopId(), like] : [shopId()];
  const countRow = await queryOne<Row>(`SELECT COUNT(*) AS total FROM ${spec.table} WHERE shop_id = ? AND ${spec.where}${filter}`, params);
  const rows = await query<Row>(
    `SELECT ${selectList(kind)} FROM ${spec.table} WHERE shop_id = ? AND ${spec.where}${filter} ORDER BY ${spec.order} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { total: Number(countRow?.total ?? 0), items: rows.map((row) => toResource(kind, row, false)) };
}

/** One resource's text, found by id. */
async function sourceById(kind: Exclude<ResourceKind, 'theme'>, id: number): Promise<SourceResource> {
  const spec = SPECS[kind];
  const row = await queryOne<Row>(`SELECT ${selectList(kind)} FROM ${spec.table} WHERE shop_id = ? AND id = ? LIMIT 1`, [shopId(), id]);
  if (!row) throw ApiError.notFound('Resource');
  return toResource(kind, row, true);
}

const TEXT_TYPES = new Set(['text', 'textarea', 'richtext', 'inline_richtext', 'html']);

/**
 * The live theme's text: every text setting of every section and block in its
 * templates and section groups, keyed the way the renderer looks them up
 * ("templates/index.json::hero::heading", "…::hero::button_1::label").
 */
async function themeSources(): Promise<{ themeId: number; items: SourceResource[] }> {
  const main = await themesRepository.main();
  if (!main) return { themeId: 0, items: [] };
  const theme = await themeLoader.load(main);
  const schemas = new Map<string, SectionSchema | null>();
  const schemaOf = (type: string) => {
    if (!schemas.has(type)) {
      const content = theme.files.get(`sections/${type}.liquid`)?.content;
      try {
        schemas.set(type, content ? extractSchema(content, `sections/${type}.liquid`) : null);
      } catch {
        schemas.set(type, null);
      }
    }
    return schemas.get(type) ?? null;
  };
  const items: SourceResource[] = [];
  const files = [...theme.files.keys()].filter((path) => (path.startsWith('templates/') || path.startsWith('sections/')) && path.endsWith('.json')).sort();
  for (const file of files) {
    let template: JsonTemplate;
    try {
      template = parseJsonTemplate(theme.files.get(file)?.content ?? '', file);
    } catch {
      continue;
    }
    const fields: SourceField[] = [];
    for (const key of template.order) {
      const section = template.sections[key];
      if (!section || section.disabled) continue;
      const schema = schemaOf(section.type);
      const sectionName = schema?.name ?? section.type;
      for (const setting of schema?.settings ?? []) {
        const value = section.settings?.[setting.id ?? ''];
        if (!setting.id || !TEXT_TYPES.has(setting.type) || typeof value !== 'string' || !value.trim()) continue;
        fields.push({ key: `${file}::${key}::${setting.id}`, label: `${sectionName} › ${setting.label ?? setting.id}`, format: setting.type === 'richtext' || setting.type === 'html' ? 'html' : setting.type === 'textarea' ? 'multiline' : 'text', original: value });
      }
      for (const blockId of section.block_order ?? Object.keys(section.blocks ?? {})) {
        const block = section.blocks?.[blockId];
        if (!block || block.disabled) continue;
        const definition = schema?.blocks?.find((candidate) => candidate.type === block.type);
        for (const setting of definition?.settings ?? []) {
          const value = block.settings?.[setting.id ?? ''];
          if (!setting.id || !TEXT_TYPES.has(setting.type) || typeof value !== 'string' || !value.trim()) continue;
          fields.push({ key: `${file}::${key}::${blockId}::${setting.id}`, label: `${sectionName} › ${definition?.name ?? block.type} › ${setting.label ?? setting.id}`, format: setting.type === 'richtext' || setting.type === 'html' ? 'html' : setting.type === 'textarea' ? 'multiline' : 'text', original: value });
        }
      }
    }
    if (fields.length) {
      const name = file.replace(/^templates\//, '').replace(/^sections\//, '').replace(/\.json$/, '');
      items.push({ id: main.id, title: file.startsWith('sections/') ? `${name.replace(/-group$/, '')} (all pages)` : name, subtitle: file, fields });
    }
  }
  return { themeId: main.id, items };
}

interface TranslationRow extends RowDataPacket {
  resource_id: number;
  field: string;
  value: string;
  source_digest: string | null;
}

async function requireLanguage(locale: string) {
  const languages = await shopLanguages.get();
  const language = languages.all.find((candidate) => candidate.code === locale.toLowerCase());
  if (!language) throw ApiError.notFound('Language');
  if (language.primary) throw ApiError.validation({ locale: ['The primary language is the original; pick another language to translate into.'] });
  return language;
}

export const translationsAdmin = {
  async list(locale: string, kind: ResourceKind, options: { q?: string; page?: number; limit?: number }) {
    const language = await requireLanguage(locale);
    const limit = Math.min(50, Math.max(1, options.limit ?? 20));
    const page = Math.max(1, options.page ?? 1);
    let total: number;
    let items: SourceResource[];
    if (kind === 'theme') {
      const theme = await themeSources();
      const filtered = options.q ? theme.items.filter((item) => item.title.toLowerCase().includes(options.q!.toLowerCase())) : theme.items;
      total = filtered.length;
      items = filtered.slice((page - 1) * limit, page * limit);
    } else {
      ({ total, items } = await sources(kind, options.q?.trim() ?? '', limit, (page - 1) * limit));
    }
    const ids = [...new Set(items.map((item) => item.id))];
    const rows = ids.length
      ? await query<TranslationRow>(
          'SELECT resource_id, field, value, source_digest FROM translations WHERE shop_id = ? AND locale = ? AND resource_type = ? AND resource_id IN (?)',
          [shopId(), language.code, kind, ids],
        )
      : [];
    const byKey = new Map(rows.map((row) => [`${row.resource_id}:${row.field}`, row]));
    return {
      language,
      kind,
      pagination: { page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) },
      resources: items.map((item) => {
        const fields = item.fields.map((field) => {
          const saved = byKey.get(`${item.id}:${field.key}`);
          return {
            ...field,
            translation: saved?.value ?? '',
            outdated: Boolean(saved && saved.source_digest && saved.source_digest !== digest(field.original)),
          };
        });
        return {
          id: item.id,
          // Theme content is one resource per file; the file is what tells two apart.
          key: kind === 'theme' ? item.subtitle : String(item.id),
          title: item.title,
          subtitle: item.subtitle,
          fields,
          translated: fields.filter((field) => field.translation.trim() !== '').length,
        };
      }),
    };
  },

  /** Saves a resource's translations; an empty value removes that field's translation. */
  async save(locale: string, kind: ResourceKind, id: number, values: Record<string, string>) {
    const language = await requireLanguage(locale);
    // The originals, to record what each translation was made from.
    let originals = new Map<string, string>();
    if (kind === 'theme') {
      const theme = await themeSources();
      if (theme.themeId !== id) throw ApiError.conflict('That is not the live theme any more. Reload and translate the live theme.');
      originals = new Map(theme.items.flatMap((item) => item.fields.map((field) => [field.key, field.original] as const)));
    } else {
      const row = await sourceById(kind, id);
      originals = new Map(row.fields.map((field) => [field.key, field.original]));
    }
    let saved = 0;
    for (const [field, raw] of Object.entries(values)) {
      if (!originals.has(field)) throw ApiError.validation({ [field]: ['That field cannot be translated.'] });
      const value = String(raw ?? '').slice(0, 200_000);
      if (!value.trim()) {
        await execute('DELETE FROM translations WHERE shop_id = ? AND resource_type = ? AND resource_id = ? AND locale = ? AND field = ?', [shopId(), kind, id, language.code, field]);
        continue;
      }
      await execute(
        `INSERT INTO translations (shop_id, resource_type, resource_id, locale, field, value, source_digest)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE value = VALUES(value), source_digest = VALUES(source_digest)`,
        [shopId(), kind, id, language.code, field, value, digest(originals.get(field) ?? '')],
      );
      saved += 1;
    }
    return { saved };
  },

  /** How much of each kind is translated into a language, for the languages screen. */
  async summary(locale: string) {
    const language = await requireLanguage(locale);
    const rows = await query<Row>(
      `SELECT resource_type, COUNT(DISTINCT resource_id) AS resources, COUNT(*) AS fields
         FROM translations WHERE shop_id = ? AND locale = ? GROUP BY resource_type`,
      [shopId(), language.code],
    );
    return { language, counts: Object.fromEntries(rows.map((row) => [String(row.resource_type), { resources: Number(row.resources), fields: Number(row.fields) }])) };
  },
};
