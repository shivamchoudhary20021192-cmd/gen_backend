import { themeExtensions } from '../apps/themeExtensions';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { execute } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { storage } from '../../modules/media/storage';
import { auditService } from '../../shared/audit.service';
import { eventBus } from '../events/eventBus';
import { entitlements } from '../plans/entitlements';
import { checkLiquid, forgetEngines } from '../onlineStore/engine/engine';
import { onlineStoreRepository } from '../onlineStore/onlineStore.repository';
import { signPreview } from '../onlineStore/previewTokens';
import { themeLoader } from '../onlineStore/themeLoader';
import { onlineStoreUrl } from '../shops/urls';
import { shopId } from '../tenancy/context';
import { contentTypeFor, isTextPath, isValidThemePath, sha256 } from './bundles';
import { sectionSettingProblems } from './settingValidation';
import { themeFilesRepository } from './themeFiles.repository';
import { themeInstaller } from './themeInstaller';
import {
  extractSchema,
  parseJsonTemplate,
  templateName,
  validateTemplate,
  type JsonTemplate,
  type SectionGroup,
  type SectionSchema,
} from './themeSchema';
import { themesRepository, type ShopThemeRow } from './themes.repository';
import { createZip, readZip, ZipError } from './zip';

/**
 * A theme's files: what "Edit code", the theme editor's Save, "Download
 * theme file" and "Upload theme" all come down to.
 *
 * Every save is checked first — Liquid must parse, JSON must be JSON, a
 * template may only use sections that exist with blocks they declare and
 * values their settings accept — so a broken file never reaches a live store.
 * Every save is kept as a version (twenty per file), so any change can be
 * undone from "Older versions".
 */

export interface Actor {
  id: number | null;
  label: string | null;
}

/** Files a theme cannot work without (Shopify refuses to delete them too). */
const REQUIRED = new Set(['layout/theme.liquid', 'config/settings_schema.json', 'config/settings_data.json', 'templates/index.json']);
const MAX_FILE_BYTES = 1024 * 1024;

const TEMPLATE_LABELS: Record<string, string> = {
  index: 'Home page',
  product: 'Products',
  collection: 'Collections',
  'list-collections': 'Collections list',
  page: 'Pages',
  blog: 'Blogs',
  article: 'Blog posts',
  cart: 'Cart',
  search: 'Search',
  '404': '404 page',
  password: 'Password',
  gift_card: 'Gift card',
  'customers/login': 'Customer sign in',
  'customers/register': 'Customer sign up',
  'customers/account': 'Customer account',
  'customers/order': 'Customer order',
  'customers/addresses': 'Customer addresses',
};

async function requireTheme(publicId: string): Promise<ShopThemeRow> {
  const row = await themesRepository.byPublicId(publicId);
  if (!row) throw ApiError.notFound('Theme');
  if (row.architecture !== 'liquid' || Number(row.files_version) === 0) return themeInstaller.materialize(row);
  return row;
}

function assertPath(path: string): void {
  if (!isValidThemePath(path)) {
    throw ApiError.validation({ path: ['Files live in layout/, templates/, sections/, snippets/, assets/, config/, locales/ or blocks/, with letters, numbers, dots, dashes and underscores in their names.'] });
  }
}

/** Every section's schema, from a set of files (saved, or with drafts laid over). */
function schemasOf(files: Map<string, { content: string | null }>): Map<string, SectionSchema | null> {
  const schemas = new Map<string, SectionSchema | null>();
  for (const [path, entry] of files) {
    if (!path.startsWith('sections/') || !path.endsWith('.liquid')) continue;
    try {
      schemas.set(path.slice(9, -7), entry.content ? extractSchema(entry.content, path) : null);
    } catch {
      schemas.set(path.slice(9, -7), null);
    }
  }
  return schemas;
}

/** The problems with a file's content, given the rest of the theme. */
export function fileProblems(path: string, content: string, files: Map<string, { content: string | null }>): string[] {
  if (Buffer.byteLength(content) > MAX_FILE_BYTES) return [`${path} is larger than 1 MB.`];
  if (path.endsWith('.json')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, ''));
    } catch (error) {
      return [`${path} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`];
    }
    if (path.startsWith('templates/') || (path.startsWith('sections/') && path.endsWith('.json'))) {
      let template: JsonTemplate;
      try {
        template = parseJsonTemplate(content, path);
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
      const next = new Map(files);
      next.set(path, { content });
      const schemas = schemasOf(next);
      return [...validateTemplate(template, schemas, path), ...sectionSettingProblems(template, schemas, path)];
    }
    if (path === 'config/settings_data.json') {
      const data = parsed as { current?: unknown };
      if (!data || typeof data !== 'object' || (typeof data.current !== 'object' && typeof data.current !== 'string')) {
        return ['config/settings_data.json needs a "current" object (or the name of a preset).'];
      }
    }
    if (path === 'config/settings_schema.json' && !Array.isArray(parsed)) return ['config/settings_schema.json must be a list of setting groups.'];
    return [];
  }
  if (path.endsWith('.liquid')) {
    const problem = checkLiquid(content, path);
    if (problem) return [`${path}: ${problem}`];
    if (path.startsWith('sections/')) {
      try {
        extractSchema(content, path);
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    }
  }
  return [];
}

function assertNoProblems(problems: string[]): void {
  if (problems.length) throw ApiError.validation({ content: problems.slice(0, 20) }, problems[0]);
}

async function savedFiles(row: ShopThemeRow): Promise<Map<string, { content: string | null }>> {
  const theme = await themeLoader.load(row);
  return new Map([...theme.files.entries()].map(([path, entry]) => [path, { content: entry.content }]));
}

async function afterChange(row: ShopThemeRow, actor: Actor, summary: string, changes: Record<string, unknown>) {
  forgetEngines(shopId(), row.id);
  themeLoader.forget();
  await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'theme.files_changed', entityType: 'shop_theme', entityId: row.id, summary, changes });
  if (row.role === 'main') {
    await eventBus.publish('themes/update', { theme_id: row.public_id }, { resourceType: 'theme', resourceId: row.id, actorType: actor.id ? 'admin' : 'system', actorId: actor.id });
  }
}

function sectionGroupsOf(layout: string | null | undefined): string[] {
  const names = new Set<string>();
  for (const match of (layout ?? '').matchAll(/{%-?\s*sections\s+['"]([\w-]+)['"]\s*-?%}/g)) names.add(match[1]);
  return [...names];
}

export const themeFilesService = {
  async list(publicId: string) {
    const row = await requireTheme(publicId);
    const [files, drafts] = await Promise.all([themeFilesRepository.fileList(row.id), themeFilesRepository.drafts(row.id)]);
    const drafted = new Set(drafts.map((draft) => draft.path));
    return {
      theme: { id: row.public_id, name: row.name, role: row.role, files_version: Number(row.files_version) },
      files: files.map((file) => ({
        path: file.path,
        size: Number(file.size),
        content_type: file.content_type,
        checksum: file.checksum,
        updated_at: file.updated_at,
        has_draft: drafted.has(file.path),
        required: REQUIRED.has(file.path),
      })),
    };
  },

  async read(publicId: string, path: string) {
    assertPath(path);
    const row = await requireTheme(publicId);
    const file = await themeFilesRepository.file(row.id, path);
    if (!file) throw ApiError.notFound('File');
    return {
      file: {
        path: file.path,
        content: file.content,
        url: file.storage_key ? storage.publicUrl(file.storage_key) : null,
        content_type: file.content_type,
        checksum: file.checksum,
        size: Number(file.size),
        updated_at: file.updated_at,
      },
    };
  },

  /**
   * Saves one file. `checksum` is the version the editor loaded: if someone
   * saved in between, this is refused rather than overwriting their work.
   */
  async write(publicId: string, input: { path: string; content: string; checksum?: string | null }, actor: Actor, source: 'code' | 'editor' | 'restore' | 'api' = 'code') {
    assertPath(input.path);
    if (!isTextPath(input.path)) throw ApiError.validation({ path: ['Only text files (Liquid, JSON, CSS, JS, SVG) can be edited here.'] });
    const row = await requireTheme(publicId);
    const existing = await themeFilesRepository.file(row.id, input.path);
    if (input.checksum && existing && existing.checksum !== input.checksum) {
      throw ApiError.conflict('This file was changed by someone else since you opened it. Reload it to see their changes.', 'STALE_FILE');
    }
    assertNoProblems(fileProblems(input.path, input.content, await savedFiles(row)));
    const checksum = sha256(input.content);
    if (existing?.checksum === checksum) return this.read(publicId, input.path);
    await withTransaction(async (tx) => {
      await themeFilesRepository.upsertFile(
        row.id,
        { path: input.path, content: input.content, contentType: contentTypeFor(input.path), checksum, size: Buffer.byteLength(input.content), adminId: actor.id },
        tx,
      );
      await themeFilesRepository.addVersion(row.id, { path: input.path, content: input.content, checksum, source, adminId: actor.id }, tx);
      await themeFilesRepository.bumpVersion(row.id, tx);
    });
    await afterChange(row, actor, `${existing ? 'Edited' : 'Created'} ${input.path} in ${row.name}`, { path: input.path, source });
    return this.read(publicId, input.path);
  },

  async remove(publicId: string, path: string, actor: Actor) {
    assertPath(path);
    if (REQUIRED.has(path)) throw ApiError.conflict(`${path} is required by every theme and cannot be deleted.`, 'REQUIRED_FILE');
    const row = await requireTheme(publicId);
    const existing = await themeFilesRepository.file(row.id, path);
    if (!existing) throw ApiError.notFound('File');
    await withTransaction(async (tx) => {
      // The last content is kept as a version, so a deleted file can be brought back.
      await themeFilesRepository.addVersion(row.id, { path, content: existing.content, checksum: existing.checksum, source: 'code', adminId: actor.id }, tx);
      await themeFilesRepository.deleteFile(row.id, path, tx);
      await themeFilesRepository.bumpVersion(row.id, tx);
    });
    await afterChange(row, actor, `Deleted ${path} from ${row.name}`, { path });
    return { deleted: true };
  },

  async rename(publicId: string, from: string, to: string, actor: Actor) {
    assertPath(from);
    assertPath(to);
    if (from.split('/')[0] !== to.split('/')[0]) throw ApiError.validation({ path: ['A file stays in its folder when renamed.'] });
    if (REQUIRED.has(from)) throw ApiError.conflict(`${from} is required and cannot be renamed.`, 'REQUIRED_FILE');
    const row = await requireTheme(publicId);
    const existing = await themeFilesRepository.file(row.id, from);
    if (!existing) throw ApiError.notFound('File');
    if (await themeFilesRepository.file(row.id, to)) throw ApiError.conflict(`${to} already exists.`, 'FILE_EXISTS');
    await withTransaction(async (tx) => {
      await themeFilesRepository.upsertFile(
        row.id,
        { path: to, content: existing.content, storageKey: existing.storage_key, contentType: contentTypeFor(to), checksum: existing.checksum, size: Number(existing.size), adminId: actor.id },
        tx,
      );
      await themeFilesRepository.deleteFile(row.id, from, tx);
      await themeFilesRepository.bumpVersion(row.id, tx);
    });
    await afterChange(row, actor, `Renamed ${from} to ${to} in ${row.name}`, { from, to });
    return this.read(publicId, to);
  },

  async versions(publicId: string, path: string) {
    assertPath(path);
    const row = await requireTheme(publicId);
    const versions = await themeFilesRepository.versions(row.id, path);
    return { versions: versions.map((version) => ({ id: version.id, source: version.source, checksum: version.checksum, created_at: version.created_at, created_by_admin_id: version.created_by_admin_id })) };
  },

  async version(publicId: string, id: number) {
    const row = await requireTheme(publicId);
    const version = await themeFilesRepository.version(row.id, id);
    if (!version) throw ApiError.notFound('Version');
    return { version: { id: version.id, path: version.path, content: version.content, source: version.source, created_at: version.created_at } };
  },

  async restore(publicId: string, id: number, actor: Actor) {
    const row = await requireTheme(publicId);
    const version = await themeFilesRepository.version(row.id, id);
    if (!version || version.content === null) throw ApiError.notFound('Version');
    return this.write(publicId, { path: version.path, content: version.content }, actor, 'restore');
  },

  // ── the theme editor ────────────────────────────────────────────────────

  /** Stores unsaved editor work; the preview shows it, the live store does not. */
  async putDrafts(publicId: string, drafts: { path: string; content: string | null }[], actor: Actor) {
    const row = await requireTheme(publicId);
    const files = await savedFiles(row);
    for (const draft of await themeFilesRepository.drafts(row.id)) {
      if (draft.is_deleted) files.delete(draft.path);
      else files.set(draft.path, { content: draft.content });
    }
    for (const draft of drafts) {
      assertPath(draft.path);
      if (draft.content !== null) files.set(draft.path, { content: draft.content });
    }
    const problems = drafts.flatMap((draft) => (draft.content === null ? [] : fileProblems(draft.path, draft.content, files)));
    assertNoProblems(problems);
    for (const draft of drafts) {
      if (draft.content === null && REQUIRED.has(draft.path)) throw ApiError.conflict(`${draft.path} is required and cannot be deleted.`, 'REQUIRED_FILE');
      await themeFilesRepository.putDraft(row.id, draft.path, draft.content, draft.content === null, actor.id);
    }
    return { saved: drafts.map((draft) => draft.path) };
  },

  async discardDrafts(publicId: string) {
    const row = await requireTheme(publicId);
    await themeFilesRepository.clearDrafts(row.id);
    return { discarded: true };
  },

  /** Save: every draft becomes the theme's file, in one transaction. */
  async publishDrafts(publicId: string, actor: Actor) {
    const row = await requireTheme(publicId);
    const drafts = await themeFilesRepository.drafts(row.id);
    if (drafts.length === 0) return { saved: [] as string[] };
    const files = await savedFiles(row);
    for (const draft of drafts) {
      if (draft.is_deleted) files.delete(draft.path);
      else files.set(draft.path, { content: draft.content });
    }
    assertNoProblems(drafts.flatMap((draft) => (draft.is_deleted || draft.content === null ? [] : fileProblems(draft.path, draft.content, files))));
    await withTransaction(async (tx) => {
      for (const draft of drafts) {
        if (draft.is_deleted || draft.content === null) {
          await themeFilesRepository.deleteFile(row.id, draft.path, tx);
          continue;
        }
        const checksum = sha256(draft.content);
        await themeFilesRepository.upsertFile(
          row.id,
          { path: draft.path, content: draft.content, contentType: contentTypeFor(draft.path), checksum, size: Buffer.byteLength(draft.content), adminId: actor.id },
          tx,
        );
        await themeFilesRepository.addVersion(row.id, { path: draft.path, content: draft.content, checksum, source: 'editor', adminId: actor.id }, tx);
      }
      await themeFilesRepository.clearDrafts(row.id, tx);
      await themeFilesRepository.bumpVersion(row.id, tx);
    });
    await afterChange(row, actor, `Customised ${row.name}`, { files: drafts.map((draft) => draft.path) });
    // Saving in the theme editor is what "Customise your theme" in the setup guide asks for.
    await execute(
      "UPDATE shop_setup_tasks SET status = 'done', completed_at = NOW() WHERE shop_id = ? AND task_key = 'customize_theme' AND kind = 'onboarding' AND status = 'pending'",
      [shopId()],
    ).catch(() => undefined);
    return { saved: drafts.map((draft) => draft.path) };
  },

  /**
   * Everything the theme editor needs for one template: the template and the
   * section groups the layout shows (drafts laid over), every section's
   * schema (for "Add section" and the settings panels), the theme settings,
   * and a signed URL for the preview frame.
   */
  async editor(publicId: string, templateKey?: string | null) {
    const row = await requireTheme(publicId);
    const theme = await themeLoader.load(row, { drafts: true });
    const drafts = await themeFilesRepository.drafts(row.id);
    const read = (path: string) => theme.files.get(path)?.content ?? null;
    const parseOr = <T>(path: string, fallback: T): T => {
      const content = read(path);
      if (!content) return fallback;
      try {
        return JSON.parse(content.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '')) as T;
      } catch {
        return fallback;
      }
    };

    const templates = [...theme.files.keys()]
      .filter((path) => path.startsWith('templates/') && (path.endsWith('.json') || path.endsWith('.liquid')))
      .map((path) => {
        const { type, suffix } = templateName(path);
        return { key: suffix ? `${type}.${suffix}` : type, type, suffix, file: path, json: path.endsWith('.json'), label: TEMPLATE_LABELS[type] ?? type };
      })
      .sort((a, b) => Object.keys(TEMPLATE_LABELS).indexOf(a.type) - Object.keys(TEMPLATE_LABELS).indexOf(b.type) || (a.suffix ?? '').localeCompare(b.suffix ?? ''));
    const current = templates.find((template) => template.key === (templateKey ?? 'index')) ?? templates.find((template) => template.key === 'index') ?? templates[0];
    const template = current?.json ? parseOr<JsonTemplate | null>(current.file, null) : null;

    const layoutName = template && template.layout === false ? null : ((template?.layout as string | undefined) ?? (current?.type === 'password' ? 'password' : 'theme'));
    const groups = sectionGroupsOf(layoutName ? read(`layout/${layoutName}.liquid`) : null).map((name) => {
      const file = `sections/${name}.json`;
      return { name, file, data: parseOr<SectionGroup | null>(file, null) };
    });

    const schemas: Record<string, SectionSchema> = {};
    for (const [path, entry] of theme.files) {
      if (!path.startsWith('sections/') || !path.endsWith('.liquid') || !entry.content) continue;
      try {
        const schema = extractSchema(entry.content, path);
        if (schema) schemas[path.slice(9, -7)] = schema;
      } catch {
        /* a section with a broken schema is left out of the editor */
      }
    }

    const settingsSchema = parseOr<{ name: string; settings?: unknown[] }[]>('config/settings_schema.json', []);
    const settingsData = parseOr<{ current: Record<string, unknown> | string; presets?: Record<string, Record<string, unknown>> }>('config/settings_data.json', { current: {} });
    const currentSettings = typeof settingsData.current === 'string' ? (settingsData.presets?.[settingsData.current] ?? {}) : settingsData.current;
    const info = settingsSchema.find((group) => group.name === 'theme_info') as Record<string, unknown> | undefined;

    return {
      theme: {
        id: row.public_id,
        name: row.name,
        role: row.role,
        theme: row.library_handle,
        version: row.theme_version,
        theme_name: info?.theme_name ?? row.library_handle,
      },
      templates,
      template: current ? { ...current, data: template } : null,
      groups,
      schemas,
      settings_schema: settingsSchema.filter((group) => group.name !== 'theme_info'),
      settings: currentSettings,
      // The whole file, so saving theme settings keeps its styles (presets) intact.
      settings_data: settingsData,
      presets: Object.keys(settingsData.presets ?? {}),
      drafts: drafts.map((draft) => draft.path),
      preview: await this.previewUrls(row, current?.type ?? 'index', current?.suffix ?? null),
      // Blocks from installed apps: "@app" blocks for sections that accept them, and app embeds.
      app_blocks: [...(await themeExtensions.forShop()).values()].map((block) => ({
        type: block.type,
        name: block.name,
        target: block.target,
        app: { id: block.app.id, name: block.app.name, handle: block.app.handle },
        settings: block.settings,
      })),
    };
  },

  /** The live theme's templates of one type, for a product's or page's "Theme template" choice. */
  async templatesOf(type: string) {
    const main = await themesRepository.main();
    if (!main) return { templates: [] as { suffix: string | null; label: string }[] };
    const files = await themeFilesRepository.fileList((await requireTheme(main.public_id)).id);
    const suffixes = files
      .map((file) => file.path)
      .filter((path) => path.startsWith(`templates/${type}.`) && /\.(json|liquid)$/.test(path))
      .map((path) => templateName(path).suffix)
      .filter((suffix): suffix is string => Boolean(suffix));
    return { templates: [{ suffix: null, label: `Default ${type}` }, ...[...new Set(suffixes)].sort().map((suffix) => ({ suffix, label: `${type}.${suffix}` }))] };
  },

  async previewUrls(row: ShopThemeRow, type: string, suffix: string | null) {
    const samples = await onlineStoreRepository.sampleHandles();
    const view = suffix ? `view=${encodeURIComponent(suffix)}` : '';
    const paths: Record<string, string> = {
      index: '/',
      product: samples.product ? `/products/${samples.product}` : '/collections/all',
      collection: samples.collection ? `/collections/${samples.collection}` : '/collections/all',
      'list-collections': '/collections',
      page: samples.page ? `/pages/${samples.page}` : '/pages/contact',
      blog: samples.article ? `/blogs/${samples.article.blog}` : '/blogs/journal',
      article: samples.article ? `/blogs/${samples.article.blog}/${samples.article.handle}` : '/blogs/journal',
      cart: '/cart',
      search: '/search?q=a',
      '404': '/404-page-not-found',
      password: '/password',
      // In the editor the account pages show a sample customer.
      'customers/login': '/account/login',
      'customers/register': '/account/register',
      'customers/account': '/account',
      'customers/order': '/account/orders/sample',
      'customers/addresses': '/account/addresses',
    };
    const path = paths[type] ?? '/';
    const origin = onlineStoreUrl();
    const joiner = (url: string) => (url.includes('?') ? '&' : '?');
    const base = view ? `${path}${joiner(path)}${view}` : path;
    const design = signPreview({ shopId: shopId(), themeId: row.public_id, design: true });
    const preview = signPreview({ shopId: shopId(), themeId: row.public_id, design: false });
    return {
      origin,
      path: base,
      design_url: `${origin}${base}${joiner(base)}preview_key=${encodeURIComponent(design)}`,
      preview_url: `${origin}${base}${joiner(base)}preview_key=${encodeURIComponent(preview)}`,
    };
  },

  // ── download and upload ─────────────────────────────────────────────────

  async download(publicId: string) {
    const row = await requireTheme(publicId);
    const files = await themeFilesRepository.files(row.id);
    const zip = createZip(files.filter((file) => file.content !== null).map((file) => ({ path: file.path, data: Buffer.from(file.content ?? '', 'utf8') })));
    const name = row.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'theme';
    return { filename: `${name}.zip`, zip };
  },

  /** "Add theme → Upload zip file": a theme from outside the theme store. */
  async upload(zip: Buffer, actor: Actor) {
    await entitlements.assertWithinLimit('themes', await themesRepository.count());
    let entries: { path: string; data: Buffer }[];
    try {
      entries = readZip(zip);
    } catch (error) {
      throw ApiError.validation({ file: [error instanceof ZipError ? error.message : 'The zip file could not be read.'] });
    }
    // Zips made by "compress folder" put everything under one top folder.
    const tops = new Set(entries.map((entry) => entry.path.split('/')[0]));
    const strip = tops.size === 1 && !['layout', 'templates', 'sections', 'snippets', 'assets', 'config', 'locales'].includes([...tops][0]);
    const files = new Map<string, string>();
    for (const entry of entries) {
      const path = strip ? entry.path.split('/').slice(1).join('/') : entry.path;
      if (!path || path.startsWith('__MACOSX') || path.endsWith('.DS_Store')) continue;
      if (!isValidThemePath(path) || !isTextPath(path)) continue;
      files.set(path, entry.data.toString('utf8'));
    }
    const missing = [...REQUIRED].filter((path) => !files.has(path));
    if (missing.length) throw ApiError.validation({ file: [`This is not a theme: it has no ${missing.join(', ')}.`] });
    const contents = new Map([...files.entries()].map(([path, content]) => [path, { content }]));
    const problems = [...files.entries()].flatMap(([path, content]) => fileProblems(path, content, contents));
    assertNoProblems(problems);

    const schema = JSON.parse(files.get('config/settings_schema.json')!) as Record<string, unknown>[];
    const info = schema.find((group) => group.name === 'theme_info') ?? {};
    const publicId = randomUUID();
    await withTransaction(async (tx) => {
      const id = await themesRepository.create(
        {
          publicId,
          libraryThemeId: null,
          libraryHandle: 'custom',
          name: String(info.theme_name ?? 'Uploaded theme').slice(0, 120),
          role: 'unpublished',
          version: String(info.theme_version ?? '1.0.0').slice(0, 20),
          preset: null,
          settings: {},
          adminId: actor.id,
        },
        tx,
      );
      for (const [path, content] of files) {
        await themeFilesRepository.upsertFile(id, { path, content, contentType: contentTypeFor(path), checksum: sha256(content), size: Buffer.byteLength(content), adminId: actor.id }, tx);
      }
      await themesRepository.update(id, { architecture: 'liquid', source: 'upload', files_version: 1 }, tx);
      await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'theme.uploaded', entityType: 'shop_theme', entityId: id, summary: `Uploaded ${info.theme_name ?? 'a theme'}` }, tx);
    });
    return { id: publicId };
  },
};
