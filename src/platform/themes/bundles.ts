import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The built-in themes' source, as it lives in the repository:
 *
 *   themes/_kit/…            the shared framework every built-in theme is made of
 *   themes/<handle>/theme.json   a theme's manifest (name, verticals, presets…)
 *   themes/<handle>/…        files that replace or add to the kit's
 *
 * This is how a theme family is built (one codebase, several products): the
 * kit holds the sections, snippets, layout and styles; each theme brings its
 * own look (presets → config/settings_data.json), its own home page
 * (templates/index.json) and a few signature sections. What a store installs
 * is the merged result, a plain Online Store 2.0 theme with no trace of the
 * kit — exactly what a Shopify theme looks like on disk.
 */

export interface ThemeManifest {
  handle: string;
  name: string;
  version: string;
  author: string;
  description: string;
  /** The kinds of store the theme is made for: 'beauty', 'fashion'… */
  verticals: string[];
  /** What the theme store lists: "Mega menu", "Quick add", "Countdown"… */
  features: string[];
  industries: string[];
  sortOrder: number;
  previewImageUrl: string | null;
  price: number;
  /** The theme's own look: replaces the kit's defaults in config/settings_schema.json. */
  defaults: Record<string, unknown>;
  /** Named styles: settings that differ from the theme's defaults. */
  presets: Record<string, Record<string, unknown>>;
  defaultPreset: string;
  /** Kit files this theme does not ship. */
  remove: string[];
}

export interface ThemeBundle {
  manifest: ThemeManifest;
  files: Map<string, string>;
  checksum: string;
}

const TEXT_TYPES: Record<string, string> = {
  '.liquid': 'text/x-liquid',
  '.json': 'application/json',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
};

export function contentTypeFor(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  if (TEXT_TYPES[ext]) return TEXT_TYPES[ext];
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.woff2') return 'font/woff2';
  if (ext === '.woff') return 'font/woff';
  return 'application/octet-stream';
}

export function isTextPath(filePath: string): boolean {
  return contentTypeFor(filePath) in { 'text/x-liquid': 1, 'application/json': 1, 'text/css': 1, 'application/javascript': 1, 'image/svg+xml': 1, 'text/plain': 1, 'text/markdown': 1 };
}

/** The folders a theme may have files in, as on Shopify. */
export const THEME_FOLDERS = ['layout', 'templates', 'sections', 'snippets', 'assets', 'config', 'locales', 'blocks'] as const;

export function isValidThemePath(filePath: string): boolean {
  if (!/^[a-z]+\/[A-Za-z0-9._\-/]+$/.test(filePath) || filePath.includes('..') || filePath.length > 255) return false;
  const folder = filePath.split('/')[0];
  if (!(THEME_FOLDERS as readonly string[]).includes(folder)) return false;
  // Only templates/customers/ nests; everywhere else is one level deep.
  const depth = filePath.split('/').length;
  return depth === 2 || (folder === 'templates' && depth === 3 && filePath.startsWith('templates/customers/'));
}

export function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Where the theme sources are: THEMES_DIR, or `themes/` next to package.json. */
export function themesRoot(): string {
  if (process.env.THEMES_DIR) return path.resolve(process.env.THEMES_DIR);
  let dir = __dirname;
  for (let i = 0; i < 6; i++) {
    const candidate = path.join(dir, 'themes');
    if (existsSync(path.join(candidate, '_kit'))) return candidate;
    dir = path.dirname(dir);
  }
  return path.resolve(process.cwd(), 'themes');
}

function walk(root: string, base = root, out = new Map<string, string>()): Map<string, string> {
  if (!existsSync(root)) return out;
  for (const entry of readdirSync(root)) {
    const full = path.join(root, entry);
    // A theme's screenshots are the theme store's, not files of the theme.
    if (root === base && entry === 'screenshots') continue;
    if (statSync(full).isDirectory()) walk(full, base, out);
    else {
      const relative = path.relative(base, full).split(path.sep).join('/');
      if (relative === 'theme.json' || relative.toLowerCase() === 'readme.md') continue;
      out.set(relative, readFileSync(full, 'utf8'));
    }
  }
  return out;
}

export function bundleChecksum(files: Map<string, string>): string {
  const lines = [...files.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([file, content]) => `${file}:${sha256(content)}`);
  return sha256(lines.join('\n'));
}

function readManifest(dir: string): ThemeManifest {
  const raw = JSON.parse(readFileSync(path.join(dir, 'theme.json'), 'utf8')) as Partial<ThemeManifest>;
  if (!raw.handle || !raw.name || !raw.version) throw new Error(`${dir}/theme.json needs handle, name and version`);
  const presets = raw.presets ?? {};
  return {
    handle: raw.handle,
    name: raw.name,
    version: raw.version,
    author: raw.author ?? 'Veylog',
    description: raw.description ?? '',
    verticals: raw.verticals ?? [],
    features: raw.features ?? [],
    industries: raw.industries ?? [],
    sortOrder: raw.sortOrder ?? 100,
    previewImageUrl: raw.previewImageUrl ?? null,
    price: raw.price ?? 0,
    defaults: raw.defaults ?? {},
    presets,
    defaultPreset: raw.defaultPreset ?? Object.keys(presets)[0] ?? 'Default',
    remove: raw.remove ?? [],
  };
}

/**
 * config/settings_data.json for a fresh install: the default preset is
 * "current", and every preset is offered — the theme editor's style picker.
 */
function settingsData(manifest: ThemeManifest, existing: string | undefined): string {
  if (existing) return existing;
  const current = manifest.presets[manifest.defaultPreset] ?? {};
  return `${JSON.stringify({ current: { ...current }, presets: manifest.presets }, null, 2)}\n`;
}

let cached: { at: number; bundles: ThemeBundle[] } | null = null;

/** Every built-in theme, merged from the kit and its overlay. */
export function loadBundles(options: { fresh?: boolean } = {}): ThemeBundle[] {
  if (cached && !options.fresh && Date.now() - cached.at < 5_000) return cached.bundles;
  const root = themesRoot();
  const kit = walk(path.join(root, '_kit'));
  const bundles: ThemeBundle[] = [];
  for (const entry of existsSync(root) ? readdirSync(root) : []) {
    const dir = path.join(root, entry);
    if (entry.startsWith('_') || !statSync(dir).isDirectory() || !existsSync(path.join(dir, 'theme.json'))) continue;
    const manifest = readManifest(dir);
    const files = new Map(kit);
    for (const removed of manifest.remove) files.delete(removed);
    for (const [file, content] of walk(dir)) files.set(file, content);
    files.set('config/settings_data.json', settingsData(manifest, walk(dir).get('config/settings_data.json')));
    // The theme's identity, where Shopify keeps it: theme_info in settings_schema.json.
    const schema = files.get('config/settings_schema.json');
    if (schema) {
      const parsed = JSON.parse(schema) as { name: string; settings?: { id?: string; default?: unknown }[] }[];
      for (const group of parsed) {
        for (const setting of group.settings ?? []) if (setting.id && setting.id in manifest.defaults) setting.default = manifest.defaults[setting.id];
      }
      const info = { name: 'theme_info', theme_name: manifest.name, theme_version: manifest.version, theme_author: manifest.author, theme_documentation_url: null, theme_support_url: null };
      const rest = parsed.filter((group) => group.name !== 'theme_info');
      files.set('config/settings_schema.json', `${JSON.stringify([info, ...rest], null, 2)}\n`);
    }
    bundles.push({ manifest, files, checksum: bundleChecksum(files) });
  }
  bundles.sort((a, b) => a.manifest.sortOrder - b.manifest.sortOrder || a.manifest.name.localeCompare(b.manifest.name));
  cached = { at: Date.now(), bundles };
  return bundles;
}
