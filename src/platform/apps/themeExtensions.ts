import { createHash } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { controlPlane, query, queryOne, execute, type RowDataPacket } from '../../db/pool';
import { ShopScopedCache } from '../cache/shopCache';
import { checkLiquid } from '../onlineStore/engine/engine';
import { extractSchema, type SettingDefinition } from '../themes/themeSchema';
import { appsRepository } from './apps.repository';

/**
 * Theme app extensions — how an app puts something on a storefront without
 * editing the merchant's theme (Shopify's model, and for the same reason: an
 * app that edits theme files leaves code behind when it is uninstalled).
 *
 * An app deploys a bundle:
 *
 *   blocks/<handle>.liquid   a block, with a {% schema %}:
 *                              "target": "section"  an app block the merchant adds to any
 *                                                   section that accepts {"type": "@app"}
 *                              "target": "head"|"body"  an app embed, switched on in the
 *                                                   editor's App embeds panel
 *                            plus "settings", and optionally "stylesheet"/"javascript"
 *                            naming files in assets/, which the platform loads with the block
 *   assets/<file>            CSS, JS or SVG, served from /cdn/apps/<app>/<version>/assets/
 *   snippets/<name>.liquid   partials the extension's blocks {% render %} — the
 *                            extension's own, never the theme's (as on Shopify)
 *   locales/<code>.json      the extension's words for {{ 'key' | t }} in its blocks,
 *                            en.default.json first, then the shopper's language
 *
 * A block's type in a theme's JSON is
 *   shopify://apps/<app handle>/blocks/<block handle>/<app id>
 * as on Shopify. Blocks render only while the app is installed: uninstalling
 * an app makes its blocks disappear from every page at once, and reinstalling
 * brings them back with their settings.
 */

export interface AppBlockDefinition {
  /** shopify://apps/<app>/blocks/<block>/<app id> */
  type: string;
  handle: string;
  name: string;
  target: 'section' | 'head' | 'body';
  settings: SettingDefinition[];
  stylesheet: string | null;
  javascript: string | null;
  /** The block's Liquid, schema included (it renders as nothing). */
  liquid: string;
  app: { id: string; handle: string; name: string; version: number };
  /** The whole extension (blocks, snippets, locales, assets), shared by its blocks. */
  files: Record<string, string>;
}

interface ExtensionRow extends RowDataPacket {
  app_id: number;
  version: number;
  files: string | Record<string, string>;
  checksum: string;
  updated_at: Date;
}

const MAX_FILES = 60;
const MAX_BYTES = 2 * 1024 * 1024;
const ASSET_TYPES: Record<string, string> = { css: 'text/css', js: 'application/javascript', svg: 'image/svg+xml', json: 'application/json' };

function filesOf(row: ExtensionRow): Record<string, string> {
  return typeof row.files === 'string' ? (JSON.parse(row.files) as Record<string, string>) : row.files;
}

export function appBlockType(appHandle: string, blockHandle: string, appPublicId: string): string {
  return `shopify://apps/${appHandle}/blocks/${blockHandle}/${appPublicId}`;
}

export function isAppBlockType(type: string): boolean {
  return type.startsWith('shopify://apps/');
}

/** Problems with a bundle before it is stored; the deploy is all or nothing. */
export function extensionProblems(files: Map<string, string>): string[] {
  const problems: string[] = [];
  if (files.size === 0) problems.push('The extension has no files.');
  if (files.size > MAX_FILES) problems.push(`An extension can have at most ${MAX_FILES} files.`);
  const total = [...files.values()].reduce((sum, content) => sum + Buffer.byteLength(content), 0);
  if (total > MAX_BYTES) problems.push('An extension can be at most 2 MB.');
  let blocks = 0;
  for (const [path, content] of files) {
    const block = /^blocks\/([a-z0-9][a-z0-9_-]{0,59})\.liquid$/.exec(path);
    const asset = /^assets\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}\.([a-z0-9]+)$/.exec(path);
    const snippet = /^snippets\/[a-z0-9][a-z0-9_-]{0,59}\.liquid$/.test(path);
    const locale = /^locales\/[a-z]{2}(-[A-Za-z]{2,4})?(\.default)?\.json$/.test(path);
    if (block) {
      blocks += 1;
      const syntax = checkLiquid(content, path);
      if (syntax) problems.push(`${path}: ${syntax}`);
      let schema: ReturnType<typeof extractSchema> = null;
      try {
        schema = extractSchema(content, path);
      } catch (error) {
        problems.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (!schema) problems.push(`${path} needs a {% schema %} with a name and a target.`);
      const target = (schema as { target?: string } | null)?.target;
      if (schema && target !== 'section' && target !== 'head' && target !== 'body') problems.push(`${path}: "target" must be "section", "head" or "body".`);
      for (const key of ['stylesheet', 'javascript'] as const) {
        const file = (schema as Record<string, unknown> | null)?.[key];
        if (typeof file === 'string' && !files.has(`assets/${file}`)) problems.push(`${path}: ${key} "${file}" is not in assets/.`);
      }
    } else if (asset) {
      if (!ASSET_TYPES[asset[1]]) problems.push(`${path}: only CSS, JavaScript, SVG and JSON assets are allowed.`);
    } else if (snippet) {
      const syntax = checkLiquid(content, path);
      if (syntax) problems.push(`${path}: ${syntax}`);
    } else if (locale) {
      try {
        const parsed: unknown = JSON.parse(content);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) problems.push(`${path}: a locale file is a JSON object of strings.`);
      } catch (error) {
        problems.push(`${path}: ${error instanceof Error ? error.message : 'not valid JSON'}`);
      }
    } else {
      problems.push(`${path}: extensions have blocks/, snippets/, locales/ and assets/ only.`);
    }
  }
  if (files.size > 0 && blocks === 0) problems.push('The extension needs at least one block in blocks/.');
  const locales = [...files.keys()].filter((path) => path.startsWith('locales/'));
  if (locales.length > 0 && !locales.some((path) => path.endsWith('.default.json'))) problems.push('locales/ needs a default file (e.g. locales/en.default.json).');
  return problems;
}

// Which apps are installed changes rarely; the list is short. A minute is plenty.
const cache = new ShopScopedCache<Map<string, AppBlockDefinition>>(60_000);

export const themeExtensions = {
  /** Stores a new version of an app's extension. */
  async deploy(appId: number, files: Map<string, string>, deployedBy: string | null) {
    const problems = extensionProblems(files);
    if (problems.length) throw ApiError.validation({ files: problems });
    const payload = Object.fromEntries([...files.entries()].sort(([a], [b]) => a.localeCompare(b)));
    const checksum = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
    const existing = await queryOne<ExtensionRow>('SELECT app_id, version, checksum FROM app_theme_extensions WHERE app_id = ?', [appId], controlPlane);
    if (existing?.checksum === checksum) return { version: existing.version, unchanged: true, blocks: this.describe(payload) };
    await execute(
      `INSERT INTO app_theme_extensions (app_id, version, files, checksum, deployed_by)
       VALUES (?, 1, ?, ?, ?)
       ON DUPLICATE KEY UPDATE version = version + 1, files = VALUES(files), checksum = VALUES(checksum), deployed_by = VALUES(deployed_by)`,
      [appId, JSON.stringify(payload), checksum, deployedBy],
      controlPlane,
    );
    cache.clearAll();
    const row = await queryOne<ExtensionRow>('SELECT version FROM app_theme_extensions WHERE app_id = ?', [appId], controlPlane);
    return { version: row?.version ?? 1, unchanged: false, blocks: this.describe(payload) };
  },

  /** What a bundle's blocks are, for the deploy response and the developer screen. */
  describe(files: Record<string, string>) {
    return Object.entries(files)
      .filter(([path]) => path.startsWith('blocks/'))
      .map(([path, content]) => {
        const schema = (extractSchema(content, path) ?? {}) as { name?: string; target?: string };
        return { handle: path.slice(7, -7), name: schema.name ?? path, target: schema.target ?? 'section' };
      });
  },

  async forApp(appId: number) {
    const row = await queryOne<ExtensionRow>('SELECT app_id, version, files, checksum, updated_at FROM app_theme_extensions WHERE app_id = ?', [appId], controlPlane);
    if (!row) return null;
    return { version: row.version, updated_at: row.updated_at, blocks: this.describe(filesOf(row)) };
  },

  /** An asset of an app's extension, for the storefront's /cdn/apps route. */
  async asset(appPublicId: string, file: string): Promise<{ content: string; contentType: string } | null> {
    const app = await appsRepository.findByPublicId(appPublicId);
    if (!app) return null;
    const row = await queryOne<ExtensionRow>('SELECT app_id, version, files FROM app_theme_extensions WHERE app_id = ?', [app.id], controlPlane);
    const content = row ? filesOf(row)[`assets/${file}`] : undefined;
    if (content === undefined) return null;
    return { content, contentType: ASSET_TYPES[file.split('.').pop() ?? ''] ?? 'text/plain' };
  },

  /** Every block of every app installed on this shop, by type. */
  async forShop(): Promise<Map<string, AppBlockDefinition>> {
    return cache.get('blocks', async () => {
      const installations = await appsRepository.listInstallations();
      if (installations.length === 0) return new Map();
      const apps = await appsRepository.findManyByIds(installations.map((installation) => installation.app_id));
      const rows = await query<ExtensionRow>('SELECT app_id, version, files FROM app_theme_extensions WHERE app_id IN (?)', [apps.map((app) => app.id)], controlPlane);
      const out = new Map<string, AppBlockDefinition>();
      for (const row of rows) {
        const app = apps.find((candidate) => candidate.id === row.app_id);
        if (!app || app.deleted_at) continue;
        const files = filesOf(row);
        for (const [path, liquid] of Object.entries(files)) {
          const match = /^blocks\/(.+)\.liquid$/.exec(path);
          if (!match) continue;
          let schema: Record<string, unknown> | null = null;
          try {
            schema = extractSchema(liquid, path) as Record<string, unknown> | null;
          } catch {
            schema = null;
          }
          if (!schema) continue;
          const type = appBlockType(app.handle, match[1], app.public_id);
          out.set(type, {
            type,
            handle: match[1],
            name: String(schema.name ?? match[1]),
            target: schema.target === 'head' || schema.target === 'body' ? schema.target : 'section',
            settings: (schema.settings as SettingDefinition[] | undefined) ?? [],
            stylesheet: typeof schema.stylesheet === 'string' ? schema.stylesheet : null,
            javascript: typeof schema.javascript === 'string' ? schema.javascript : null,
            liquid,
            app: { id: app.public_id, handle: app.handle, name: app.name, version: row.version },
            files,
          });
        }
      }
      return out;
    });
  },

  clearCache(): void {
    cache.clear();
  },
};
