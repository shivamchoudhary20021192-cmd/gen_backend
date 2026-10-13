import { screenshotsFor } from './screenshots';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { logger } from '../../core/logger';
import { withTransaction } from '../../db/transaction';
import { storage } from '../../modules/media/storage';
import { auditService } from '../../shared/audit.service';
import { ShopScopedCache } from '../cache/shopCache';
import { eventBus } from '../events/eventBus';
import { entitlements } from '../plans/entitlements';
import { forgetEngines } from '../onlineStore/engine/engine';
import { themeLoader } from '../onlineStore/themeLoader';
import { shopId, tenancy } from '../tenancy/context';
import { contentTypeFor, loadBundles, sha256 } from './bundles';
import { googleFontsUrl } from './fonts';
import { BUILT_IN_THEMES } from './library';
import { settingProblem } from './settingValidation';
import { themeFilesRepository } from './themeFiles.repository';
import { themeFilesService, type Actor } from './themeFiles.service';
import { themeInstaller, type SettingsData } from './themeInstaller';
import { parseJsonTemplate, type JsonTemplate, type SettingDefinition } from './themeSchema';
import { themesRepository, type LibraryThemeRow, type ShopThemeRow } from './themes.repository';

export type { Actor } from './themeFiles.service';

/**
 * Online Store → Themes: the theme store, installing, customising,
 * publishing — Shopify's model.
 *
 * A theme is a bundle of files (see migration 123). A store may hold several
 * installed themes (its plan decides how many); one is `main` and is what
 * shoppers see. The others are drafts to customise and preview before
 * publishing, so the editor never changes a live site by accident.
 *
 * The merchant's customisations live in the theme's own files — the global
 * look in config/settings_data.json, each page's sections in its JSON
 * template — exactly where Shopify keeps them. That is what lets
 * "duplicate", "download", "edit code" and "update" work on everything.
 */

type Settings = Record<string, unknown>;

const storefrontCache = new ShopScopedCache<Record<string, unknown> | null>(60_000);

function parse<T>(raw: unknown, fallback: T): T {
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

interface SchemaGroup {
  name: string;
  settings?: SettingDefinition[];
}

function flatten(schema: SchemaGroup[]): SettingDefinition[] {
  return schema.filter((group) => group.name !== 'theme_info').flatMap((group) => group.settings ?? []).filter((setting) => setting.id);
}

function defaultsOf(schema: SchemaGroup[]): Settings {
  const out: Settings = {};
  for (const setting of flatten(schema)) out[setting.id!] = setting.default ?? (setting.type === 'checkbox' ? false : null);
  return out;
}

function currentOf(data: SettingsData | null): Settings {
  if (!data) return {};
  if (typeof data.current === 'string') return { ...(data.presets?.[data.current] ?? {}) };
  return data.current ?? {};
}

/** The settings a thumbnail needs: colours, fonts and the button shape. */
function lookOf(settings: Settings): Settings {
  return Object.fromEntries(Object.entries(settings).filter(([id]) => id.startsWith('color_') || id === 'font_heading' || id === 'font_body' || id === 'button_style' || id === 'radius'));
}

function presentInstalled(row: ShopThemeRow, library: LibraryThemeRow | null) {
  return {
    id: row.public_id,
    name: row.name,
    role: row.role,
    theme: row.library_handle,
    theme_name: library?.name ?? (row.library_handle === 'custom' ? 'Uploaded theme' : row.library_handle),
    version: row.theme_version,
    latest_version: library?.version ?? row.theme_version,
    update_available: Boolean(library && library.version !== row.theme_version),
    preset: row.preset,
    source: row.source,
    processing: row.processing,
    files_version: Number(row.files_version ?? 0),
    published_at: row.published_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentLibrary(row: LibraryThemeRow, vertical: string) {
  const verticals = parse<string[]>(row.verticals, []);
  const schema = parse<SchemaGroup[]>(row.settings_schema, []);
  const defaults = defaultsOf(schema);
  return {
    handle: row.handle,
    name: row.name,
    author: row.author,
    version: row.version,
    description: row.description,
    verticals,
    features: parse<string[]>(row.features, []),
    industries: parse<string[]>(row.industries, []),
    recommended: verticals.includes(vertical),
    preview_image_url: row.preview_image_url,
    demo_url: row.demo_url,
    price: { amount: Number(row.price_amount), currency: row.currency },
    section_count: parse<string[]>(row.section_types, []).length,
    // Real pages of the theme in each style, where `npm run theme:screenshots` has captured them.
    screenshots: screenshotsFor(row.handle, parse<{ key: string }[]>(row.presets, []).map((preset) => preset.key)),
    presets: parse<{ key: string; name: string; settings: Settings }[]>(row.presets, []).map((preset) => ({
      key: preset.key,
      name: preset.name,
      settings: preset.settings,
      // The whole look the style produces (theme defaults under it), for a thumbnail.
      style: lookOf({ ...defaults, ...preset.settings }),
    })),
  };
}

/** Maps resolved settings to CSS custom properties, so a headless storefront styles the same way. */
function cssVariables(settings: Settings): Record<string, string> {
  const px = (value: unknown) => `${Number(value ?? 0)}px`;
  const vars: Record<string, string> = {};
  for (const [id, value] of Object.entries(settings)) {
    if (id.startsWith('color_') && typeof value === 'string') vars[`--${id.replace(/_/g, '-')}`] = value;
  }
  vars['--font-heading'] = `"${settings.font_heading ?? 'Inter'}", serif`;
  vars['--font-body'] = `"${settings.font_body ?? 'Inter'}", system-ui, sans-serif`;
  vars['--font-base-size'] = px(settings.font_base_size ?? 16);
  vars['--heading-scale'] = String(Number(settings.heading_scale ?? 120) / 100);
  vars['--heading-case'] = String(settings.heading_case ?? 'none');
  vars['--page-width'] = px(settings.page_width ?? 1280);
  vars['--radius'] = px(settings.radius ?? 8);
  vars['--button-radius'] = settings.button_style === 'pill' ? '999px' : settings.button_style === 'square' ? '0px' : px(settings.radius);
  vars['--logo-width'] = px(settings.logo_width ?? 120);
  return vars;
}

async function requireLibrary(handle: string): Promise<LibraryThemeRow> {
  const library = await themesRepository.libraryByHandle(handle);
  if (!library || library.status !== 'published') throw ApiError.notFound('Theme');
  return library;
}

async function requireInstalled(publicId: string): Promise<ShopThemeRow> {
  const row = await themesRepository.byPublicId(publicId);
  if (!row) throw ApiError.notFound('Theme');
  return row;
}

async function ensureFiles(row: ShopThemeRow): Promise<ShopThemeRow> {
  return row.architecture === 'liquid' && Number(row.files_version) > 0 ? row : themeInstaller.materialize(row);
}

/** A theme's settings files, loaded (saved state, no drafts). */
async function settingsFiles(row: ShopThemeRow): Promise<{ schema: SchemaGroup[]; data: SettingsData }> {
  const theme = await themeLoader.load(row);
  return {
    schema: parse<SchemaGroup[]>(theme.files.get('config/settings_schema.json')?.content ?? '[]', []),
    data: parse<SettingsData>(theme.files.get('config/settings_data.json')?.content ?? '{"current":{}}', { current: {} }),
  };
}

function forget(row: ShopThemeRow) {
  forgetEngines(shopId(), row.id);
  themeLoader.forget();
  storefrontCache.clear();
}

/**
 * Personalises a new store's home page with its own words: the vertical's
 * headline in the hero, rather than the theme's sample copy.
 */
function personalise(content: { heading?: string; body?: string; cta?: string } | undefined) {
  if (!content) return undefined;
  return (path: string, source: string): string => {
    if (path !== 'templates/index.json') return source;
    try {
      const template = parseJsonTemplate(source, path);
      const heroKey = template.order.find((key) => ['image-banner', 'slideshow'].includes(template.sections[key]?.type));
      const hero = heroKey ? template.sections[heroKey] : null;
      if (!hero) return source;
      for (const block of Object.values(hero.blocks ?? {})) {
        if (block.type === 'heading' && content.heading) block.settings = { ...block.settings, heading: content.heading };
        if (block.type === 'text' && content.body) block.settings = { ...block.settings, text: content.body };
        if (block.type === 'buttons' && content.cta) block.settings = { ...block.settings, button_label_1: content.cta };
        if (block.type === 'slide' && content.heading) {
          block.settings = { ...block.settings, heading: content.heading, ...(content.body ? { subheading: content.body } : {}) };
          break;
        }
      }
      return `${JSON.stringify(template, null, 2)}\n`;
    } catch {
      return source;
    }
  };
}

export const themesService = {
  /**
   * Makes the theme store match the themes in this build (the `themes/`
   * folder). Idempotent; runs at boot. Installed themes that predate theme
   * files are converted when they are first opened or rendered.
   */
  async syncBuiltIns(): Promise<void> {
    if (loadBundles().length === 0) {
      logger.warn('themes.no_bundles', { message: 'No themes/ folder found; the theme store is unchanged.' });
      return;
    }
    await themeInstaller.syncLibrary();
  },

  async catalog() {
    const vertical = tenancy.current().vertical;
    const rows = await themesRepository.publishedLibrary();
    const themes = rows.filter((row) => row.architecture === 'liquid').map((row) => presentLibrary(row, vertical));
    themes.sort((a, b) => Number(b.recommended) - Number(a.recommended));
    return { themes };
  },

  /** The theme store for someone not signed in yet: signup's "pick a look". */
  async publicCatalog() {
    const rows = await themesRepository.publishedLibrary();
    return rows.filter((row) => row.architecture === 'liquid').map((row) => presentLibrary(row, ''));
  },

  async list() {
    const rows = await themesRepository.list();
    const libraries = new Map<number, LibraryThemeRow | null>();
    for (const row of rows) {
      if (row.library_theme_id && !libraries.has(row.library_theme_id)) {
        libraries.set(row.library_theme_id, await themesRepository.libraryById(row.library_theme_id));
      }
    }
    return {
      themes: rows.map((row) => presentInstalled(row, row.library_theme_id ? (libraries.get(row.library_theme_id) ?? null) : null)),
    };
  },

  /** One installed theme: its settings schema, styles and values (the theme settings panel). */
  async get(publicId: string) {
    const row = await ensureFiles(await requireInstalled(publicId));
    const library = row.library_theme_id ? await themesRepository.libraryById(row.library_theme_id) : null;
    const { schema, data } = await settingsFiles(row);
    const overrides = currentOf(data);
    return {
      theme: presentInstalled(row, library),
      settings_schema: schema.filter((group) => group.name !== 'theme_info'),
      presets: Object.entries(data.presets ?? {}).map(([key, settings]) => ({ key, name: key, settings, style: lookOf({ ...defaultsOf(schema), ...settings }) })),
      overrides,
      settings: { ...defaultsOf(schema), ...overrides },
      preview: await themeFilesService.previewUrls(row, 'index', null),
    };
  },

  async install(
    input: { handle: string; name?: string; preset?: string | null; publish?: boolean; content?: { heading?: string; body?: string; cta?: string } },
    actor: Actor,
    options: { skipLimit?: boolean } = {},
  ) {
    const library = await requireLibrary(input.handle);
    const presets = parse<{ key: string }[]>(library.presets, []);
    if (input.preset && !presets.some((preset) => preset.key === input.preset)) {
      throw ApiError.validation({ preset: ['That style does not exist for this theme.'] });
    }
    if (!options.skipLimit) await entitlements.assertWithinLimit('themes', await themesRepository.count());

    const publicId = randomUUID();
    const hasMain = (await themesRepository.main()) !== null;
    const publish = input.publish === true || !hasMain;

    await withTransaction(async (tx) => {
      if (publish && hasMain) await themesRepository.demoteMain(tx);
      const id = await themesRepository.create(
        {
          publicId,
          libraryThemeId: library.id,
          libraryHandle: library.handle,
          name: input.name?.trim() || library.name,
          role: publish ? 'main' : 'unpublished',
          version: library.version,
          preset: input.preset ?? presets[0]?.key ?? null,
          settings: {},
          adminId: actor.id,
        },
        tx,
      );
      await themeInstaller.installFiles(id, library, { preset: input.preset ?? null, adminId: actor.id, transform: personalise(input.content) }, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.label,
          action: 'theme.installed',
          entityType: 'shop_theme',
          entityId: id,
          summary: `Added ${library.name}${publish ? ' and published it' : ''}`,
        },
        tx,
      );
      if (publish) {
        await eventBus.publish('themes/publish', { theme_id: publicId, theme: library.handle }, { resourceType: 'theme', resourceId: id, actorType: actor.id ? 'admin' : 'system', actorId: actor.id, tx });
      }
    });
    storefrontCache.clear();
    return this.get(publicId);
  },

  /**
   * Theme settings (config/settings_data.json): only settings the theme
   * declares, with values their type accepts. Choosing a style replaces the
   * look with that style, as on Shopify.
   */
  async updateSettings(publicId: string, input: { settings?: Record<string, unknown>; preset?: string | null; name?: string }, actor: Actor) {
    const row = await ensureFiles(await requireInstalled(publicId));
    if (input.name !== undefined) {
      await themesRepository.update(row.id, { name: input.name.trim().slice(0, 120) || row.name });
    }
    if (input.settings || input.preset) {
      const { schema, data } = await settingsFiles(row);
      const definitions = new Map(flatten(schema).map((setting) => [setting.id!, setting]));
      let current = currentOf(data);
      if (input.preset) {
        if (!data.presets?.[input.preset]) throw ApiError.validation({ preset: ['That style does not exist for this theme.'] });
        current = { ...data.presets[input.preset] };
        await themesRepository.update(row.id, { preset: input.preset });
      }
      const errors: Record<string, string[]> = {};
      for (const [id, value] of Object.entries(input.settings ?? {})) {
        const definition = definitions.get(id);
        if (!definition) {
          errors[`settings.${id}`] = ['is not a setting this theme has'];
          continue;
        }
        const problem = settingProblem(definition, value);
        if (problem) {
          errors[`settings.${id}`] = [problem];
          continue;
        }
        if (definition.type === 'image_picker' && typeof value === 'number' && !(await themesRepository.mediaKey(value))) {
          errors[`settings.${id}`] = [`${definition.label ?? id} must be an image in this store's media library`];
          continue;
        }
        current[id] = value;
      }
      if (Object.keys(errors).length > 0) throw ApiError.validation(errors, 'Some theme settings are invalid.');
      const content = `${JSON.stringify({ ...data, current }, null, 2)}\n`;
      await themeFilesService.write(publicId, { path: 'config/settings_data.json', content }, actor, 'editor');
    }
    forget(row);
    return this.get(publicId);
  },

  /** Back to the chosen style's look, dropping individual changes. */
  async reset(publicId: string, actor: Actor) {
    const row = await ensureFiles(await requireInstalled(publicId));
    const { data } = await settingsFiles(row);
    const preset = row.preset && data.presets?.[row.preset] ? row.preset : Object.keys(data.presets ?? {})[0];
    const current = preset ? { ...(data.presets?.[preset] ?? {}) } : {};
    await themeFilesService.write(publicId, { path: 'config/settings_data.json', content: `${JSON.stringify({ ...data, current }, null, 2)}\n` }, actor, 'editor');
    forget(row);
    return this.get(publicId);
  },

  async publish(publicId: string, actor: Actor) {
    const row = await ensureFiles(await requireInstalled(publicId));
    if (row.role === 'main') return this.get(publicId);
    if (row.processing !== 'ready') throw ApiError.conflict('This theme is still being prepared. Try again in a moment.', 'INVALID_OPERATION');
    await withTransaction(async (tx) => {
      await themesRepository.demoteMain(tx);
      await themesRepository.update(row.id, { role: 'main', published_at: new Date() }, tx);
      await auditService.log(
        { actorId: actor.id, actorLabel: actor.label, action: 'theme.published', entityType: 'shop_theme', entityId: row.id, summary: `Published ${row.name}` },
        tx,
      );
      await eventBus.publish('themes/publish', { theme_id: row.public_id, theme: row.library_handle }, { resourceType: 'theme', resourceId: row.id, actorType: 'admin', actorId: actor.id, tx });
    });
    forget(row);
    return this.get(publicId);
  },

  async duplicate(publicId: string, actor: Actor, name?: string) {
    const row = await ensureFiles(await requireInstalled(publicId));
    await entitlements.assertWithinLimit('themes', await themesRepository.count());
    const copyId = randomUUID();
    await withTransaction(async (tx) => {
      const id = await themesRepository.create(
        {
          publicId: copyId,
          libraryThemeId: row.library_theme_id,
          libraryHandle: row.library_handle,
          name: name?.trim() || `Copy of ${row.name}`,
          role: 'unpublished',
          version: row.theme_version,
          preset: row.preset,
          settings: {},
          adminId: actor.id,
        },
        tx,
      );
      await themeFilesRepository.copyFiles(row.id, id, tx);
      await themesRepository.update(id, { architecture: 'liquid', source: 'duplicate', files_version: 1 }, tx);
      await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'theme.duplicated', entityType: 'shop_theme', entityId: id, summary: `Duplicated ${row.name}` }, tx);
    });
    return this.get(copyId);
  },

  /**
   * "Update available": like Shopify, the update is added as a new,
   * unpublished copy on the latest version — with the merchant's
   * customisations carried over (theme settings, every JSON template and
   * section group, alternate templates, their own snippets and sections) —
   * so they can check it before publishing. The theme they have is untouched.
   */
  async upgrade(publicId: string, actor: Actor) {
    const row = await ensureFiles(await requireInstalled(publicId));
    const library = await requireLibrary(row.library_handle);
    if (library.version === row.theme_version) return this.get(publicId);
    await entitlements.assertWithinLimit('themes', await themesRepository.count());

    const [libraryFiles, ownFiles] = await Promise.all([themeFilesRepository.libraryFiles(library.id), themeFilesRepository.files(row.id)]);
    const fromLibrary = new Map(libraryFiles.map((file) => [file.path, file.content ?? '']));
    const merged = new Map(fromLibrary);
    const sectionTypes = new Set(
      [...fromLibrary.keys(), ...ownFiles.map((file) => file.path)].filter((path) => path.startsWith('sections/') && path.endsWith('.liquid')).map((path) => path.slice(9, -7)),
    );
    for (const file of ownFiles) {
      const path = file.path;
      const content = file.content ?? '';
      if (path === 'config/settings_data.json') {
        const next = parse<SettingsData>(fromLibrary.get(path), { current: {} });
        merged.set(path, `${JSON.stringify({ ...next, current: currentOf(parse<SettingsData>(content, { current: {} })) }, null, 2)}\n`);
      } else if ((path.startsWith('templates/') || path.startsWith('sections/')) && path.endsWith('.json')) {
        try {
          const template = parseJsonTemplate(content, path) as JsonTemplate;
          // Sections the new version no longer has are dropped rather than breaking the page.
          for (const [key, section] of Object.entries(template.sections)) if (!sectionTypes.has(section.type)) delete template.sections[key];
          template.order = template.order.filter((key) => template.sections[key]);
          merged.set(path, `${JSON.stringify(template, null, 2)}\n`);
        } catch {
          merged.set(path, fromLibrary.get(path) ?? content);
        }
      } else if (!fromLibrary.has(path)) {
        // Files the merchant added (a snippet, an alternate template) come along.
        merged.set(path, content);
      }
    }

    const copyId = randomUUID();
    await withTransaction(async (tx) => {
      const id = await themesRepository.create(
        {
          publicId: copyId,
          libraryThemeId: library.id,
          libraryHandle: library.handle,
          name: `${row.name} (${library.version})`.slice(0, 120),
          role: 'unpublished',
          version: library.version,
          preset: row.preset,
          settings: {},
          adminId: actor.id,
        },
        tx,
      );
      for (const [path, content] of merged) {
        await themeFilesRepository.upsertFile(id, { path, content, contentType: contentTypeFor(path), checksum: sha256(content), size: Buffer.byteLength(content), adminId: actor.id }, tx);
      }
      await themesRepository.update(id, { architecture: 'liquid', source: 'library', files_version: 1 }, tx);
      await auditService.log(
        { actorId: actor.id, actorLabel: actor.label, action: 'theme.upgraded', entityType: 'shop_theme', entityId: id, summary: `Added ${library.name} ${library.version} with the customisations of ${row.name}` },
        tx,
      );
    });
    return this.get(copyId);
  },

  async remove(publicId: string, actor: Actor) {
    const row = await requireInstalled(publicId);
    if (row.role === 'main') throw ApiError.conflict('The published theme cannot be deleted. Publish another theme first.', 'IN_USE');
    await themesRepository.remove(row.id);
    forget(row);
    await auditService.log({ actorId: actor.id, actorLabel: actor.label, action: 'theme.deleted', entityType: 'shop_theme', entityId: row.id, summary: `Deleted ${row.name}` });
    return { deleted: true };
  },

  /**
   * The theme as design tokens, for a headless storefront (the React
   * storefront): the live theme's resolved settings, CSS custom properties
   * and a font stylesheet URL, so any frontend can wear the store's look.
   */
  async storefront(previewId?: string | null) {
    const produce = async () => {
      const found = previewId ? await themesRepository.byPublicId(previewId) : await themesRepository.main();
      if (!found) return null;
      const row = await ensureFiles(found);
      const { schema, data } = await settingsFiles(row);
      const settings = { ...defaultsOf(schema), ...currentOf(data) };

      const images: Record<string, string | null> = {};
      for (const setting of flatten(schema)) {
        if (setting.type !== 'image_picker') continue;
        const value = settings[setting.id!];
        const key = typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value)) ? await themesRepository.mediaKey(Number(value)) : null;
        images[`${setting.id}_url`] = key ? storage.publicUrl(key) : typeof value === 'string' && /^https?:\/\//.test(value) ? value : null;
      }
      const builtIn = BUILT_IN_THEMES.find((theme) => theme.handle === row.library_handle);

      return {
        id: row.public_id,
        name: row.name,
        theme: row.library_handle,
        version: row.theme_version,
        preset: row.preset,
        preview: Boolean(previewId),
        settings: { ...settings, ...images },
        css_variables: cssVariables(settings),
        font_stylesheet: googleFontsUrl([settings.font_heading as string, settings.font_body as string]),
        templates: builtIn?.templates ?? {},
      };
    };
    return previewId ? produce() : storefrontCache.get('main', produce);
  },

  /** The starter home layout of a theme, for provisioning the headless storefront's page builder. */
  async starterHome(handle: string) {
    return BUILT_IN_THEMES.find((theme) => theme.handle === handle)?.templates.home ?? [];
  },
};
