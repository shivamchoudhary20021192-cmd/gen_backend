import { Liquid, type FS, type Template } from 'liquidjs';
import { registerFilters } from './filters';
import { registerTags } from './tags';
import { extractSchema, type SectionSchema } from '../../themes/themeSchema';
import type { LoadedTheme } from './types';

/**
 * One Liquid engine per theme version.
 *
 * The engine's "file system" is the theme's files in memory: `{% render
 * 'price' %}` reads snippets/price.liquid from the theme, never the disk.
 * Parsed templates are cached inside the engine, so a theme's Liquid is
 * parsed once per saved version — a save bumps `files_version`, which is part
 * of the cache key, so the next request builds a fresh engine.
 */

function themeFs(theme: LoadedTheme): FS {
  const read = (file: string): string => {
    const entry = theme.files.get(file);
    if (!entry || entry.content === null) throw new Error(`${file} does not exist in the theme`);
    return entry.content;
  };
  return {
    exists: async (file) => theme.files.has(file),
    existsSync: (file) => theme.files.has(file),
    readFile: async (file) => read(file),
    readFileSync: read,
    // `render 'card'` → snippets/card.liquid; a path with a folder is taken as given.
    resolve: (dir, file, ext) => {
      const name = file.endsWith(ext) ? file : `${file}${ext}`;
      return name.includes('/') ? name : `${dir}/${name}`;
    },
    contains: async () => true,
    containsSync: () => true,
    sep: '/',
    dirname: (file) => file.split('/').slice(0, -1).join('/'),
  };
}

export function createEngine(theme: LoadedTheme): Liquid {
  const engine = new Liquid({
    fs: themeFs(theme),
    root: ['snippets'],
    partials: ['snippets'],
    layouts: ['layout'],
    extname: '.liquid',
    relativeReference: false,
    cache: true,
    // Shopify's semantics: an unknown variable is empty, not an error.
    strictVariables: false,
    strictFilters: false,
    lenientIf: true,
    // Guards against a theme looping forever.
    renderLimit: 4000,
    parseLimit: 2_000_000,
    memoryLimit: 64_000_000,
    ownPropertyOnly: false,
    outputEscape: undefined,
  });
  registerFilters(engine);
  registerTags(engine);
  return engine;
}

const MAX_ENGINES = 64;
interface EngineEntry {
  engine: Liquid;
  parsed: Map<string, Template[]>;
  schemas: Map<string, SectionSchema | null>;
  json: Map<string, unknown>;
}

const engines = new Map<string, EngineEntry>();

function key(theme: LoadedTheme): string {
  return `${theme.shopId}:${theme.id}:${theme.filesVersion}:${theme.draftStamp ?? ''}`;
}

/** The engine for this exact version of the theme (and its drafts, when previewing). */
export interface ThemeEngine {
  engine: Liquid;
  /** A file's parsed Liquid, parsed once per theme version. */
  parse(file: string): Template[];
  /** A section's {% schema %}, or null. */
  schema(file: string): SectionSchema | null;
  /** A JSON file (template, section group, config), parsed once per theme version. */
  json<T>(file: string, parse: (source: string, file: string) => T): T | null;
}

export function engineFor(theme: LoadedTheme): ThemeEngine {
  const k = key(theme);
  let entry = engines.get(k);
  if (!entry) {
    entry = { engine: createEngine(theme), parsed: new Map(), schemas: new Map(), json: new Map() };
    engines.set(k, entry);
    // A plain insertion-ordered map as an LRU: drop the oldest when full.
    if (engines.size > MAX_ENGINES) engines.delete(engines.keys().next().value!);
  } else {
    engines.delete(k);
    engines.set(k, entry);
  }
  const current = entry;
  return {
    engine: current.engine,
    parse(file: string): Template[] {
      let templates = current.parsed.get(file);
      if (!templates) {
        const content = theme.files.get(file)?.content;
        if (content === undefined || content === null) throw new Error(`${file} does not exist in the theme`);
        templates = current.engine.parse(content, file);
        current.parsed.set(file, templates);
      }
      return templates;
    },
    schema(file: string): SectionSchema | null {
      if (!current.schemas.has(file)) {
        const content = theme.files.get(file)?.content;
        current.schemas.set(file, content ? extractSchema(content, file) : null);
      }
      return current.schemas.get(file) ?? null;
    },
    json<T>(file: string, parse: (source: string, file: string) => T): T | null {
      if (!current.json.has(file)) {
        const content = theme.files.get(file)?.content;
        current.json.set(file, content ? parse(content, file) : null);
      }
      return (current.json.get(file) as T | null) ?? null;
    },
  };
}

/** Drops engines for a theme whose files changed (a new version supersedes them anyway). */
export function forgetEngines(shopId: number, themeId: number): void {
  for (const k of [...engines.keys()]) if (k.startsWith(`${shopId}:${themeId}:`)) engines.delete(k);
}

/** Parses Liquid without rendering, for the code editor's "check before save". */
export function checkLiquid(source: string, file: string): string | null {
  try {
    const probe = new Liquid({ templates: {}, strictVariables: false, lenientIf: true });
    registerFilters(probe);
    registerTags(probe);
    probe.parse(source, file);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
