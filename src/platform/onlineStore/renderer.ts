/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash } from 'node:crypto';
import type { Liquid } from 'liquidjs';
import { env as config } from '../../config/env';
import { logger } from '../../core/logger';
import { brandService } from '../shops/brand';
import { markets, type Market } from '../markets/markets';
import { tenancy } from '../tenancy/context';
import {
  parseJsonTemplate,
  type JsonTemplate,
  type SectionGroup,
  type SectionSchema,
  type SettingValue,
  type TemplateSection,
} from '../themes/themeSchema';
import {
  AllProductsDrop,
  BlogsDrop,
  cartDrop,
  collectionsDrop,
  imageDrop,
  LinklistsDrop,
  PagesDrop,
} from './drops';
import { createEngine, engineFor, type ThemeEngine } from './engine/engine';
import type { LoadedTheme, RenderEnv } from './engine/types';
import { editorBridgeScript } from './editorBridge';
import { announcementsService } from '../../modules/content/announcements/announcements.service';
import { policies, type Policy, type PolicyKind } from '../privacy/policies';
import { privacyCopy } from '../privacy/privacyCopy';
import { privacyClientConfig, privacyHead } from '../privacy/privacyRuntime';
import { privacySettings } from '../privacy/privacySettings';
import type { PrivacyRegion } from '../privacy/regions';
import { shopLanguages, type ShopLanguage } from './languages';
import { onlineStorePreferences } from './preferences';
import { isAppBlockType, themeExtensions, type AppBlockDefinition } from '../apps/themeExtensions';
import { translationContext } from './translations';
import { currentSettings, flattenSchema, lazy, SettingsScope, typedSettings, type SettingsDataFile } from './settings';

/**
 * Renders an Online Store page from a theme, the way Shopify does:
 *
 *   1. find the template — templates/<type>[.<suffix>].json (or .liquid)
 *   2. render each section the JSON template lists, in `order`, each with its
 *      schema's defaults under the merchant's settings, into
 *      <div id="shopify-section-…" class="shopify-section">
 *   3. render the layout (layout/theme.liquid) with content_for_layout and
 *      content_for_header; the layout pulls in section groups with
 *      {% sections 'header-group' %}
 *
 * The same class answers the Section Rendering API (?sections=a,b), which
 * re-renders single sections for the AJAX cart and the theme editor.
 */

type Any = any;

/**
 * An app extension as the engine sees it: a small "theme" of the extension's
 * own files, so a block's {% render %} finds the extension's snippets (never
 * the merchant's) and asset_url its assets. One engine per extension version,
 * shared by every shop that has the app installed.
 */
interface ExtensionRuntime {
  theme: LoadedTheme;
  engine: Liquid;
  blocks: Map<string, ReturnType<Liquid['parse']>>;
}
const extensionRuntimes = new Map<string, ExtensionRuntime>();
function extensionRuntime(definition: AppBlockDefinition): ExtensionRuntime {
  const key = `${definition.app.id}@${definition.app.version}`;
  let runtime = extensionRuntimes.get(key);
  if (!runtime) {
    const files = new Map<string, { content: string; contentType: string; storageKey: null; checksum: string }>();
    for (const [path, content] of Object.entries(definition.files ?? {})) {
      files.set(path, { content, contentType: path.endsWith('.json') ? 'application/json' : 'text/plain', storageKey: null, checksum: createHash('sha1').update(content).digest('hex') });
    }
    const theme: LoadedTheme = { shopId: 0, id: 0, publicId: definition.app.id, name: definition.app.name, role: 'unpublished', libraryHandle: `app:${definition.app.handle}`, filesVersion: definition.app.version, draftStamp: null, files };
    runtime = { theme, engine: createEngine(theme), blocks: new Map() };
    extensionRuntimes.set(key, runtime);
    if (extensionRuntimes.size > 128) extensionRuntimes.delete(extensionRuntimes.keys().next().value!);
  }
  return runtime;
}

function parsedAppBlock(runtime: ExtensionRuntime, definition: AppBlockDefinition) {
  let templates = runtime.blocks.get(definition.handle);
  if (!templates) {
    templates = runtime.engine.parse(definition.liquid, `app:${definition.app.handle}/${definition.handle}`);
    runtime.blocks.set(definition.handle, templates);
  }
  return templates;
}

/** For tests: an extension block's engine and parsed Liquid. */
export function appBlockTemplates(definition: AppBlockDefinition) {
  const runtime = extensionRuntime(definition);
  return { runtime, templates: parsedAppBlock(runtime, definition) };
}

/** For tests: an extension's words in a language. */
export function extensionWords(files: Record<string, string>, locale: string) {
  return extensionTranslations(files, locale);
}

/** An extension's words in a language: its default locale file, overlaid by the language's own. */
function extensionTranslations(files: Record<string, string>, locale: string): Record<string, unknown> {
  const read = (path: string | undefined) => {
    if (!path) return {};
    try {
      return JSON.parse(files[path]) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  const paths = Object.keys(files).filter((path) => path.startsWith('locales/') && path.endsWith('.json'));
  const fallback = paths.find((path) => path.endsWith('.default.json'));
  const exact = paths.find((path) => path === `locales/${locale}.json` || path === `locales/${locale}.default.json`);
  return exact && exact !== fallback ? deepMerge(read(fallback), read(exact)) : read(fallback);
}

/** The setting types whose text a merchant translates. */
const TEXT_SETTINGS = new Set(['text', 'textarea', 'richtext', 'inline_richtext', 'html']);

export interface PageRequest {
  path: string;
  query: URLSearchParams;
  host: string;
  origin: string;
}

export interface Shopper {
  market: Market;
  cart: Any | null;
  /** The signed-in customer (a CustomerDrop), or null. */
  customer?: unknown;
  /** The storefront language, the path prefix it is served under, and the host's own default language. */
  locale?: { code: string; prefix: string; hostDefault?: string; homes?: Map<string, { origin: string; prefix: string }> };
  /** The visitor's privacy rules: whether the cookie banner shows, whether the US sale opt-out applies. */
  privacy?: PrivacyRegion | null;
}

export interface PageSpec {
  /** The template type: index, product, collection, page, blog, article, cart, search, 404, password, list-collections, gift_card… */
  template: string;
  /** An alternate template ("product.<suffix>"), from the resource or ?view=. */
  suffix?: string | null;
  /** Objects for this page type: product, collection, page, blog, article, search, recommendations… */
  objects?: Record<string, unknown>;
  title: string;
  description?: string | null;
  image?: unknown;
  handle?: string | null;
  /**
   * A page the platform writes rather than the theme — a policy, "Your
   * privacy choices", the privacy request form — shown in the theme's layout
   * as Shopify shows its policy pages. No template is looked up.
   */
  content?: string;
}

export interface RenderOptions {
  theme: LoadedTheme;
  request: PageRequest;
  shopper: Shopper;
  designMode?: boolean;
  forms?: RenderEnv['forms'];
}

export class TemplateMissingError extends Error {
  constructor(readonly template: string) {
    super(`The theme has no template for "${template}".`);
    this.name = 'TemplateMissingError';
  }
}

const esc = (value: unknown) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

function countryName(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

function currencySymbol(currency: string, locale: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).formatToParts(0).find((part) => part.type === 'currency')?.value ?? currency;
  } catch {
    return currency;
  }
}

function moneyLocale(locale: string, country: string): string {
  if (/^[a-z]{2}-[A-Z]{2}$/.test(locale)) return locale;
  return `${(locale || 'en').slice(0, 2)}-${country}`;
}

function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const current = out[key];
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
        ? deepMerge(current as Record<string, unknown>, value as Record<string, unknown>)
        : value;
  }
  return out;
}

interface SectionInstance {
  key: string;
  domId: string;
  data: TemplateSection;
  location: string;
  index: number;
  /** The file the section's settings live in: its template, section group, or settings_data.json. */
  file?: string;
}

export class PageRenderer {
  private readonly theme: LoadedTheme;
  private readonly engine: ThemeEngine;
  private readonly env: RenderEnv;
  private readonly scope: SettingsScope;
  private globals: Record<string, unknown> | null = null;
  /** <link rel="alternate" hreflang> for each language the page is published in. */
  private alternates = '';
  /** The Customer Privacy API and its config, for <head> (privacy/privacyRuntime.ts). */
  private privacyHead = '';
  private template: { file: string; json: JsonTemplate | null; name: string; suffix: string | null } | null = null;

  constructor(
    private readonly options: RenderOptions,
    private readonly page: PageSpec,
  ) {
    this.theme = options.theme;
    this.engine = engineFor(options.theme);
    const shop = tenancy.current();
    const market = options.shopper.market;
    const linklists = new LinklistsDrop(options.request.path);
    this.scope = new SettingsScope(linklists);
    const locale = options.shopper.locale?.code || (shop.locale || 'en').slice(0, 2).toLowerCase();
    this.env = {
      theme: this.theme,
      currency: market.currency,
      moneyLocale: moneyLocale(shop.locale, shop.countryCode),
      shopCurrency: shop.currency,
      locale,
      translations: this.translations(locale),
      assetBase: `/cdn/shop/t/${this.theme.publicId}/assets/`,
      designMode: Boolean(options.designMode),
      currentPage: Math.max(1, Math.min(10_000, Number(options.request.query.get('page')) || 1)),
      requestPath: options.request.path,
      requestQuery: options.request.query,
      templateName: page.suffix ? `${page.template}.${page.suffix}` : page.template,
      state: { layout: null, stylesheets: [], scripts: [] },
      forms: options.forms ?? {},
      renderSection: (type, id, settings, blocks, blockOrder, extra) => this.renderStaticSection(type, id, settings, blocks, blockOrder, extra),
      renderGroup: (name) => this.renderGroup(name),
      renderAppBlock: (block) => this.renderAppBlock(block),
    };
  }

  // ── public ──────────────────────────────────────────────────────────────

  /** The whole page. */
  async render(): Promise<string> {
    const template = this.page.content === undefined ? this.resolveTemplate() : null;
    const globals = await this.buildGlobals();
    let content: string;
    let layout: string | false = 'theme';
    if (!template) {
      content = this.page.content!;
    } else if (template.json) {
      const sections = this.templateSections(template.json);
      content = (await Promise.all(sections.map((instance) => this.renderInstance(instance)))).join('');
      if (template.json.layout !== undefined) layout = template.json.layout;
    } else {
      content = await this.engine.engine.render(this.engine.parse(template.file), {}, { globals: { ...globals, __env: this.env } });
      if (this.env.state.layout !== null) layout = this.env.state.layout;
    }
    // App embeds: the ones for <head> go into content_for_header, the rest before </body>.
    const [headEmbeds, bodyEmbeds] = await Promise.all([this.renderEmbeds('head'), this.renderEmbeds('body')]);
    if (layout === false || !this.theme.files.has(`layout/${layout}.liquid`)) return content + bodyEmbeds;
    const html = await this.engine.engine.render(this.engine.parse(`layout/${layout}.liquid`), {}, {
      globals: { ...globals, content_for_layout: content, content_for_header: this.contentForHeader() + headEmbeds, __env: this.env },
    });
    if (!bodyEmbeds) return html;
    const end = html.lastIndexOf('</body>');
    return end < 0 ? html + bodyEmbeds : html.slice(0, end) + bodyEmbeds + html.slice(end);
  }

  /**
   * The Section Rendering API: each requested section's HTML, keyed by the
   * id it was asked for. An id may be a full DOM id
   * ("template--12__main"), a key in this page's template or section
   * groups ("main", "header"), or a section file for a static section
   * ("cart-drawer"). Unknown ids map to null, as on Shopify.
   */
  async renderSections(ids: string[]): Promise<Record<string, string | null>> {
    const out: Record<string, string | null> = {};
    let template: JsonTemplate | null = null;
    try {
      template = this.resolveTemplate().json;
    } catch {
      template = null;
    }
    await this.buildGlobals();
    for (const requested of ids.slice(0, 5)) {
      const key = requested.replace(/^(template|sections)--[^_]+__/, '');
      const instance = this.findInstance(key, template);
      if (instance) out[requested] = await this.renderInstance(instance);
      else if (this.theme.files.has(`sections/${key}.liquid`)) out[requested] = await this.renderStaticSection(key, key, undefined, undefined, undefined);
      else out[requested] = null;
    }
    return out;
  }

  // ── templates ───────────────────────────────────────────────────────────

  private resolveTemplate() {
    if (this.template) return this.template;
    const base = this.page.template;
    const candidates = [
      ...(this.page.suffix ? [`templates/${base}.${this.page.suffix}.json`, `templates/${base}.${this.page.suffix}.liquid`] : []),
      `templates/${base}.json`,
      `templates/${base}.liquid`,
    ];
    const file = candidates.find((candidate) => this.theme.files.has(candidate));
    if (!file) throw new TemplateMissingError(this.env.templateName);
    const json = file.endsWith('.json') ? this.engine.json(file, parseJsonTemplate) : null;
    const suffix = file.replace(/^templates\//, '').replace(/\.(json|liquid)$/, '').split('.').slice(1).join('.') || null;
    this.template = { file, json, name: base, suffix };
    this.env.templateName = suffix ? `${base}.${suffix}` : base;
    return this.template;
  }

  private templateSections(template: JsonTemplate): SectionInstance[] {
    return template.order
      .filter((key) => template.sections[key] && !template.sections[key].disabled)
      .map((key, index) => ({ key, domId: `template--${this.theme.id}__${key}`, data: template.sections[key], location: 'template', index: index + 1, file: this.template?.file }));
  }

  private groupFiles(): string[] {
    return [...this.theme.files.keys()].filter((file) => file.startsWith('sections/') && file.endsWith('.json'));
  }

  private group(file: string): SectionGroup | null {
    try {
      return this.engine.json(file, (source, name) => parseJsonTemplate(source, name) as SectionGroup);
    } catch (error) {
      logger.warn('online_store.group_invalid', { file, error: String(error) });
      return null;
    }
  }

  private findInstance(key: string, template: JsonTemplate | null): SectionInstance | null {
    if (template) {
      const instance = this.templateSections(template).find((candidate) => candidate.key === key);
      if (instance) return instance;
    }
    for (const file of this.groupFiles()) {
      const group = this.group(file);
      if (!group?.sections[key] || group.sections[key].disabled) continue;
      const index = group.order.indexOf(key) + 1;
      return { key, domId: `sections--${this.theme.id}__${key}`, data: group.sections[key], location: group.type ?? 'custom', index, file };
    }
    return null;
  }

  /** {% sections 'header-group' %} */
  async renderGroup(name: string): Promise<string> {
    const file = `sections/${name}.json`;
    const group = this.theme.files.has(file) ? this.group(file) : null;
    if (!group) return this.env.designMode ? `<!-- section group ${esc(name)} does not exist -->` : '';
    const instances = group.order
      .filter((key) => group.sections[key] && !group.sections[key].disabled)
      .map((key, index) => ({ key, domId: `sections--${this.theme.id}__${key}`, data: group.sections[key], location: group.type ?? 'custom', index: index + 1, file }));
    const html = await Promise.all(instances.map((instance) => this.renderInstance(instance)));
    return `<!-- BEGIN sections: ${esc(name)} -->${html.join('')}<!-- END sections: ${esc(name)} -->`;
  }

  // ── sections ────────────────────────────────────────────────────────────

  /** {% section 'name' %}: a static section, its settings kept in settings_data.json. */
  private async renderStaticSection(
    type: string,
    id: string,
    settings: Record<string, unknown> | undefined,
    blocks: Record<string, unknown> | undefined,
    blockOrder: string[] | undefined,
    _extra?: { group?: string },
  ): Promise<string> {
    const data = this.settingsData();
    const saved = (typeof data?.current === 'object' ? ((data.current as Any).sections?.[id] as TemplateSection | undefined) : undefined) ?? null;
    return this.renderInstance({
      key: id,
      domId: id,
      location: 'static',
      index: 1,
      file: 'config/settings_data.json',
      data: {
        type,
        settings: (settings as Record<string, SettingValue>) ?? saved?.settings,
        blocks: (blocks as TemplateSection['blocks']) ?? saved?.blocks,
        block_order: blockOrder ?? saved?.block_order,
      },
    });
  }

  private async renderInstance(instance: SectionInstance): Promise<string> {
    const file = `sections/${instance.data.type}.liquid`;
    if (!this.theme.files.has(file)) {
      return this.env.designMode ? `<div class="shopify-section" id="shopify-section-${esc(instance.domId)}"><!-- sections/${esc(instance.data.type)}.liquid does not exist --></div>` : '';
    }
    let schema: SectionSchema | null = null;
    try {
      schema = this.engine.schema(file);
    } catch (error) {
      return this.errorBox(instance, error);
    }
    const section = this.sectionObject(instance, schema, await this.themeContent(), await this.installedAppBlocks());
    let html: string;
    try {
      html = await this.engine.engine.render(this.engine.parse(file), { section }, { globals: { ...(await this.buildGlobals()), __env: this.env } });
    } catch (error) {
      return this.errorBox(instance, error);
    }
    const tag = /^(div|section|header|footer|aside|article|main|nav)$/.test(schema?.tag ?? '') ? schema!.tag! : 'div';
    const classes = ['shopify-section', schema?.class, instance.location !== 'template' && instance.location !== 'static' ? `shopify-section-group-${instance.location}-group` : null]
      .filter(Boolean)
      .join(' ');
    const editor = this.env.designMode
      ? ` data-shopify-editor-section="${esc(JSON.stringify({ id: instance.key, type: instance.data.type, location: instance.location, name: schema?.name ?? instance.data.type }))}"`
      : '';
    return `<${tag} id="shopify-section-${esc(instance.domId)}" class="${esc(classes)}"${editor}>${html}</${tag}>`;
  }

  // ── app blocks and app embeds ──────────────────────────────────────────

  private appBlocks: Promise<Map<string, AppBlockDefinition>> | null = null;
  private readonly appAssets = new Set<string>();

  private installedAppBlocks(): Promise<Map<string, AppBlockDefinition>> {
    this.appBlocks ??= themeExtensions.forShop().catch((error) => {
      logger.warn('online_store.app_blocks_failed', { error: String(error) });
      return new Map();
    });
    return this.appBlocks;
  }

  /** The <link>/<script> an app block asks for, once per page. */
  private appAssetTags(definition: AppBlockDefinition): string {
    const tags: string[] = [];
    const base = `/cdn/apps/${definition.app.id}/${definition.app.version}/assets/`;
    if (definition.stylesheet && !this.appAssets.has(base + definition.stylesheet)) {
      this.appAssets.add(base + definition.stylesheet);
      tags.push(`<link rel="stylesheet" href="${esc(base + definition.stylesheet)}">`);
    }
    if (definition.javascript && !this.appAssets.has(base + definition.javascript)) {
      this.appAssets.add(base + definition.javascript);
      tags.push(`<script src="${esc(base + definition.javascript)}" defer></script>`);
    }
    return tags.join('');
  }

  private async renderAppLiquid(definition: AppBlockDefinition, block: Record<string, unknown>): Promise<string> {
    try {
      const runtime = extensionRuntime(definition);
      const templates = parsedAppBlock(runtime, definition);
      // The page as the theme sees it, but the extension's snippets, words and assets.
      const env: RenderEnv = {
        ...this.env,
        theme: runtime.theme,
        translations: extensionTranslations(definition.files ?? {}, this.env.locale),
        assetBase: `/cdn/apps/${definition.app.id}/${definition.app.version}/assets/`,
      };
      return await runtime.engine.render(templates, { block, app: block.app ?? definition.app }, { globals: { ...(await this.buildGlobals()), __env: env } });
    } catch (error) {
      logger.warn('online_store.app_block_failed', { block: definition.type, error: String(error) });
      return this.env.designMode ? `<p style="color:#8e1f0b;font:13px system-ui">${esc(definition.app.name)}: ${esc(error instanceof Error ? error.message : String(error))}</p>` : '';
    }
  }

  /** {% render block %} for an app block. */
  private async renderAppBlock(block: Record<string, unknown>): Promise<string> {
    const definition = block.__app_block as AppBlockDefinition;
    const html = await this.renderAppLiquid(definition, block);
    return `${this.appAssetTags(definition)}<div id="shopify-block-${esc(block.id)}" class="shopify-app-block" ${block.shopify_attributes ?? ''}>${html}</div>`;
  }

  /** The app embeds switched on in settings_data.json ("current.blocks"), for one target. */
  private async renderEmbeds(target: 'head' | 'body'): Promise<string> {
    const data = this.settingsData();
    const entries = (typeof data?.current === 'object' ? ((data.current as Any).blocks as Record<string, { type: string; disabled?: boolean; settings?: Record<string, SettingValue> }> | undefined) : undefined) ?? {};
    if (Object.keys(entries).length === 0) return '';
    const apps = await this.installedAppBlocks();
    const out: string[] = [];
    for (const [id, entry] of Object.entries(entries)) {
      const definition = apps.get(entry?.type);
      if (!definition || entry.disabled === true || definition.target !== target) continue;
      const block = { id, type: entry.type, settings: typedSettings(definition.settings, entry.settings, this.scope), shopify_attributes: '', app: definition.app };
      out.push(this.appAssetTags(definition) + (await this.renderAppLiquid(definition, block)));
    }
    return out.join('\n');
  }

  /** The live theme's text settings in the shopper's language, when it is not the primary one. */
  private themeContent(): Promise<Map<string, string> | null> {
    const state = translationContext.current();
    return state ? state.loader.themeContent(this.theme.id) : Promise.resolve(null);
  }

  /** Text settings replaced by their translations ("file::section::setting", "file::section::block::setting"). */
  private translated(settings: Record<string, unknown>, definitions: SectionSchema['settings'], content: Map<string, string> | null, key: string): Record<string, unknown> {
    if (!content || content.size === 0) return settings;
    for (const definition of definitions ?? []) {
      if (!definition.id || !TEXT_SETTINGS.has(definition.type)) continue;
      const value = content.get(`${key}::${definition.id}`);
      if (value !== undefined) settings[definition.id] = value;
    }
    return settings;
  }

  private sectionObject(instance: SectionInstance, schema: SectionSchema | null, content: Map<string, string> | null = null, apps: Map<string, AppBlockDefinition> = new Map()) {
    const blocks = instance.data.blocks ?? {};
    const base = `${instance.file ?? ''}::${instance.key}`;
    // An app block shows only while its app is installed, and only where the section accepts app blocks.
    const acceptsApps = (schema?.blocks ?? []).some((block) => block.type === '@app');
    const order = (instance.data.block_order ?? Object.keys(blocks)).filter(
      (id) => blocks[id] && !blocks[id].disabled && (!isAppBlockType(blocks[id].type) || (acceptsApps && apps.has(blocks[id].type))),
    );
    const blockDefs = new Map((schema?.blocks ?? []).map((block) => [block.type, block]));
    const designMode = this.env.designMode;
    return {
      id: instance.domId,
      type: instance.data.type,
      index: instance.index,
      index0: instance.index - 1,
      location: instance.location,
      settings: this.withLiquid(schema?.settings, typedSettings(schema?.settings, this.translated({ ...(instance.data.settings ?? {}) }, schema?.settings, content, base) as Record<string, SettingValue>, this.scope)),
      blocks: order.map((id) => {
        const block = blocks[id];
        const app = isAppBlockType(block.type) ? apps.get(block.type)! : null;
        if (app) {
          return {
            id,
            // As on Shopify: the section sees "@app" and hands the block back with {% render block %}.
            type: '@app',
            settings: typedSettings(app.settings, block.settings, this.scope),
            shopify_attributes: designMode ? `data-shopify-editor-block="${esc(JSON.stringify({ id, type: block.type }))}"` : '',
            app: app.app,
            __app_block: app,
          };
        }
        const definitions = blockDefs.get(block.type)?.settings;
        return {
          id,
          type: block.type,
          settings: this.withLiquid(definitions, typedSettings(definitions, this.translated({ ...(block.settings ?? {}) }, definitions, content, `${base}::${id}`) as Record<string, SettingValue>, this.scope)),
          shopify_attributes: designMode ? `data-shopify-editor-block="${esc(JSON.stringify({ id, type: block.type }))}"` : '',
        };
      }),
    };
  }

  /**
   * A `liquid` setting is Liquid the merchant wrote in the editor: rendered,
   * with the page's objects, when the section outputs it — as on Shopify.
   */
  private withLiquid(definitions: SectionSchema['settings'], settings: Record<string, unknown>): Record<string, unknown> {
    for (const definition of definitions ?? []) {
      if (definition.type !== 'liquid' || !definition.id) continue;
      const source = settings[definition.id];
      if (typeof source !== 'string' || !source.includes('{')) continue;
      settings[definition.id] = lazy(async () => {
        try {
          return await this.engine.engine.parseAndRender(source, {}, { globals: { ...(await this.buildGlobals()), __env: this.env } });
        } catch (error) {
          return this.env.designMode ? `<p style="color:#8e1f0b">Liquid error: ${esc(error instanceof Error ? error.message : String(error))}</p>` : '';
        }
      });
    }
    return settings;
  }

  private errorBox(instance: SectionInstance, error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('online_store.section_failed', { theme_id: this.theme.id, section: instance.data.type, error: message });
    // Shopify's behaviour: the page still renders; the error is visible to the merchant, invisible to shoppers.
    const body = this.env.designMode
      ? `<div style="padding:16px;margin:8px;border:1px solid #d72c0d;border-radius:8px;background:#fff4f4;color:#8e1f0b;font:14px/1.4 system-ui">Liquid error in sections/${esc(instance.data.type)}.liquid: ${esc(message)}</div>`
      : `<!-- Liquid error (sections/${esc(instance.data.type)}.liquid): ${esc(message)} -->`;
    return `<div id="shopify-section-${esc(instance.domId)}" class="shopify-section">${body}</div>`;
  }

  // ── globals ─────────────────────────────────────────────────────────────

  private settingsData(): SettingsDataFile | null {
    try {
      return this.engine.json('config/settings_data.json', (source) => JSON.parse(source) as SettingsDataFile);
    } catch {
      return null;
    }
  }

  private translations(locale: string): Record<string, unknown> {
    const files = [...this.theme.files.keys()].filter((file) => file.startsWith('locales/') && file.endsWith('.json') && !file.endsWith('.schema.json'));
    const fallback = files.find((file) => /\.default\.json$/.test(file));
    const exact = files.find((file) => file === `locales/${locale}.json` || file === `locales/${locale}.default.json`);
    const read = (file: string | undefined) => {
      if (!file) return {};
      try {
        return this.engine.json(file, (source) => JSON.parse(source) as Record<string, unknown>) ?? {};
      } catch {
        return {};
      }
    };
    return exact && exact !== fallback ? deepMerge(read(fallback), read(exact)) : read(fallback);
  }

  private async buildGlobals(): Promise<Record<string, unknown>> {
    if (this.globals) return this.globals;
    const shop = tenancy.current();
    const { request, shopper } = this.options;
    const market = shopper.market;
    const brand = await brandService.storefront().catch(() => null);
    const template = this.resolveTemplateSafe();
    const schema = this.engine.json('config/settings_schema.json', (source) => JSON.parse(source) as unknown[]);
    const settings = typedSettings(flattenSchema(schema), currentSettings(this.settingsData()), this.scope);
    const shopLanguageList = await shopLanguages.get();
    // On a domain with its own language (example.fr), that language is at the root and the others under /<code>.
    const hostDefault = shopper.locale?.hostDefault ?? shopLanguageList.primary.code;
    // A language may live on another domain (fr.example.com): its root_url is then absolute.
    const homes = shopper.locale?.homes;
    const rootOf = (code: string) => {
      const home = homes?.get(code);
      if (!home) return code === hostDefault ? '/' : `/${code}`;
      return home.origin === request.origin ? home.prefix || '/' : `${home.origin}${home.prefix || '/'}`;
    };
    const rooted = (entry: ShopLanguage): ShopLanguage => ({ ...entry, primary: entry.code === hostDefault, root_url: rootOf(entry.code) });
    const languages = { primary: rooted(shopLanguageList.all.find((entry) => entry.code === hostDefault) ?? shopLanguageList.primary), all: shopLanguageList.all.map(rooted), published: shopLanguageList.published.map(rooted) };
    const languageDrop = (entry: ShopLanguage) => ({ iso_code: entry.code, name: entry.name, endonym_name: entry.endonym, primary: entry.primary, root_url: entry.root_url, rtl: entry.rtl });
    const current = languages.all.find((entry) => entry.code === this.env.locale) ?? languages.primary;
    const language = languageDrop(current);
    const publishedLanguages = languages.published.map(languageDrop);
    if (languages.published.length > 1) {
      // Each language's copy of this page, wherever that language lives; x-default is the store's own language.
      const href = (code: string) => {
        const home = homes?.get(code) ?? { origin: request.origin, prefix: code === hostDefault ? '' : `/${code}` };
        return `${home.origin}${home.prefix}${home.prefix && request.path === '/' ? '' : request.path}`;
      };
      this.alternates = [
        ...languages.published.map((entry) => `<link rel="alternate" hreflang="${esc(entry.code)}" href="${esc(href(entry.code))}">`),
        `<link rel="alternate" hreflang="x-default" href="${esc(href(shopLanguageList.primary.code))}">`,
      ].join('\n');
    }
    const currency = { iso_code: market.currency, name: market.currency, symbol: currencySymbol(market.currency, this.env.moneyLocale) };
    const country = { iso_code: market.country, name: countryName(market.country), currency, unit_system: 'metric', market: { id: market.id, handle: market.name.toLowerCase().replace(/\W+/g, '-') } };
    const catalogue = await markets.catalogue().catch(() => []);
    const logo = brand?.logo ? imageDrop(brand.logo.url, brand.logo.alt ?? shop.name, { width: brand.logo.width, height: brand.logo.height, id: brand.logo.id }) : null;
    const squareLogo = brand?.square_logo ? imageDrop(brand.square_logo.url, brand.square_logo.alt ?? shop.name, { id: brand.square_logo.id }) : null;
    const canonicalPath = request.path + (this.env.currentPage > 1 ? `?page=${this.env.currentPage}` : '');
    const page = this.page;
    const preferences = await onlineStorePreferences.get();
    const policyList = await policies.list();
    // Content → Announcement bar, resolved for this kind of page and this shopper. The
    // free-shipping amount is converted to the shopper's currency, in minor units, as
    // the money filter and /cart.js count.
    const rate = Number(market.rate) || 1;
    const announcementBar = await announcementsService
      .forStorefront({ template: page.template, signedIn: Boolean(shopper.customer), country: market.country })
      .then((bar) => ({
        ...bar,
        lines: bar.lines.map((line) => ({ ...line, threshold_cents: line.free_shipping_threshold ? Math.ceil(line.free_shipping_threshold * rate * 100) : null })),
      }))
      .catch(() => ({ enabled: false, settings: {}, version: '', lines: [] }));
    const policyDrop = (policy: Policy) => ({ id: policy.id, title: policy.title, body: policy.body, url: policy.url, handle: policy.handle });
    const policyOf = (kind: PolicyKind) => {
      const found = policyList.find((policy) => policy.kind === kind);
      return found ? policyDrop(found) : null;
    };
    // The cookie banner and Customer Privacy API — not in the theme editor, where it would sit over the page being designed.
    if (shopper.privacy && !this.env.designMode) {
      const privacy = await privacySettings.get();
      const privacyPolicy = policyList.find((policy) => policy.kind === 'privacy') ?? null;
      this.privacyHead = privacyHead(
        privacyClientConfig({
          region: shopper.privacy,
          settings: privacy,
          policyVersion: privacyPolicy?.version ?? 0,
          copy: privacyCopy(this.env.locale, privacy.banner_copy),
          root: shopper.locale?.prefix ? `${shopper.locale.prefix}/` : '/',
          privacyPolicyUrl: privacyPolicy?.url ?? null,
        }),
      );
    }
    // templates/customers/login.json → template.name "login", template.directory "customers", as on Shopify.
    const [directory, templateBase] = page.template.includes('/') ? page.template.split('/') : [null, page.template];

    this.globals = {
      shop: {
        id: shop.publicId,
        name: shop.name,
        email: null,
        phone: null,
        description: brand?.short_description ?? '',
        domain: request.host,
        permanent_domain: `${shop.handle}.${config.platform.storefrontDomain}`,
        url: request.origin,
        secure_url: request.origin,
        currency: shop.currency,
        money_format: `${currencySymbol(shop.currency, this.env.moneyLocale)}{{amount}}`,
        money_with_currency_format: `${currencySymbol(shop.currency, this.env.moneyLocale)}{{amount}} ${shop.currency}`,
        enabled_currencies: [...new Set(catalogue.map((entry: Any) => entry.currency))].map((iso) => ({ iso_code: iso, symbol: currencySymbol(String(iso), this.env.moneyLocale), name: iso })),
        locale: this.env.locale,
        published_locales: publishedLanguages,
        customer_accounts_enabled: preferences.customer_accounts !== 'disabled',
        customer_accounts_optional: true,
        accepts_gift_cards: false,
        policies: policyList.map(policyDrop),
        privacy_policy: policyOf('privacy'),
        refund_policy: policyOf('refund'),
        shipping_policy: policyOf('shipping'),
        terms_of_service: policyOf('terms'),
        contact_information: policyOf('contact'),
        legal_notice: policyOf('legal_notice'),
        metafields: {},
        brand: {
          logo,
          square_logo: squareLogo,
          slogan: brand?.slogan ?? null,
          short_description: brand?.short_description ?? null,
          social_links: brand?.social_links ?? [],
        },
        social_links: brand?.social_links ?? [],
      },
      announcement_bar: announcementBar,
      settings,
      request: {
        host: request.host,
        origin: request.origin,
        path: request.path,
        page_type: page.template,
        locale: language,
        design_mode: this.env.designMode,
        visual_preview_mode: false,
      },
      routes: {
        root_url: language.root_url,
        account_url: '/account',
        account_login_url: '/account/login',
        account_logout_url: '/account/logout',
        account_register_url: '/account/register',
        account_addresses_url: '/account/addresses',
        collections_url: '/collections',
        all_products_collection_url: '/collections/all',
        search_url: '/search',
        predictive_search_url: '/search/suggest',
        cart_url: '/cart',
        cart_add_url: '/cart/add',
        cart_change_url: '/cart/change',
        cart_clear_url: '/cart/clear',
        cart_update_url: '/cart/update',
        product_recommendations_url: '/recommendations/products',
      },
      localization: {
        country,
        language,
        market: country.market,
        available_languages: publishedLanguages,
        available_countries: catalogue.map((entry: Any) => ({
          iso_code: entry.country,
          name: countryName(entry.country),
          currency: { iso_code: entry.currency, name: entry.currency, symbol: currencySymbol(entry.currency, this.env.moneyLocale) },
          market: { handle: String(entry.market).toLowerCase().replace(/\W+/g, '-') },
        })),
      },
      cart: cartDrop(shopper.cart),
      linklists: this.scope.linklists,
      collections: lazy(() => collectionsDrop()),
      all_products: new AllProductsDrop(),
      pages: new PagesDrop(),
      blogs: new BlogsDrop(),
      customer: shopper.customer ?? null,
      template: {
        name: templateBase,
        suffix: template?.suffix ?? null,
        directory,
        toString: () => this.env.templateName,
      },
      page_title: page.title,
      page_description: page.description ?? brand?.short_description ?? '',
      page_image: page.image ?? squareLogo ?? logo,
      canonical_url: `${request.origin}${canonicalPath}`,
      current_page: this.env.currentPage,
      current_tags: null,
      handle: page.handle ?? '',
      powered_by_link: '',
      additional_checkout_buttons: false,
      content_for_additional_checkout_buttons: '',
      theme: { id: this.theme.id, name: this.theme.name, role: this.theme.role },
      ...(page.objects ?? {}),
    };
    return this.globals;
  }

  private resolveTemplateSafe() {
    try {
      return this.resolveTemplate();
    } catch {
      return null;
    }
  }

  /** What the platform puts in <head>: the storefront's runtime config, and the editor bridge when designing. */
  private contentForHeader(): string {
    const shop = tenancy.current();
    const market = this.options.shopper.market;
    const runtime = {
      shop: `${shop.handle}.${config.platform.storefrontDomain}`,
      locale: this.env.locale,
      currency: { active: market.currency, rate: String(market.rate) },
      country: market.country,
      theme: { name: this.theme.name, id: this.theme.id, schema_name: this.theme.libraryHandle, role: this.theme.role },
      routes: { root: this.options.shopper.locale?.prefix ? `${this.options.shopper.locale.prefix}/` : '/' },
      // The template the page used ("product.alternate"): the theme editor follows the preview with it.
      template: this.env.templateName,
      designMode: this.env.designMode,
    };
    const json = JSON.stringify(runtime).replace(/</g, '\\u003c');
    const parts = [
      `<meta name="veylog-checkout-api-token" content="">`,
      ...(this.alternates ? [this.alternates] : []),
      `<script>window.Shopify=Object.assign(window.Shopify||{},${json});window.Veylog=window.Shopify;</script>`,
      ...(this.privacyHead ? [this.privacyHead] : []),
    ];
    if (this.env.designMode) parts.push(`<script>${editorBridgeScript}</script>`);
    return parts.join('\n');
  }
}

export async function renderPage(options: RenderOptions, page: PageSpec): Promise<string> {
  return new PageRenderer(options, page).render();
}
