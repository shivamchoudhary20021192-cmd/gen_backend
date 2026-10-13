import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { themesRoot } from './bundles';

/**
 * The theme store's screenshots: real pages of each theme, in each of its
 * styles, captured by `npm run theme:screenshots` into
 * themes/<handle>/screenshots/<style>-desktop.jpg and <style>-mobile.jpg.
 * They ship with the code (a theme's screenshot changes when the theme does)
 * and are served from the platform API, so the admin's theme store and the
 * signup flow show them without any upload step.
 */

export interface StyleScreenshots {
  desktop: string | null;
  mobile: string | null;
}

export const SCREENSHOT_ROUTE = '/platform/api/v1/theme-store/screenshots';

export function styleSlug(style: string): string {
  return style.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'default';
}

let cache: { at: number; byTheme: Map<string, Map<string, StyleScreenshots>> } | null = null;

function scan(): Map<string, Map<string, StyleScreenshots>> {
  if (cache && Date.now() - cache.at < 60_000) return cache.byTheme;
  const byTheme = new Map<string, Map<string, StyleScreenshots>>();
  const root = themesRoot();
  for (const handle of existsSync(root) ? readdirSync(root) : []) {
    const dir = path.join(root, handle, 'screenshots');
    if (handle.startsWith('_') || !existsSync(dir) || !statSync(dir).isDirectory()) continue;
    const styles = new Map<string, StyleScreenshots>();
    for (const file of readdirSync(dir)) {
      const match = /^(.+)-(desktop|mobile)\.(jpg|png|webp)$/.exec(file);
      if (!match) continue;
      const entry = styles.get(match[1]) ?? { desktop: null, mobile: null };
      const version = Math.floor(statSync(path.join(dir, file)).mtimeMs / 1000);
      entry[match[2] as 'desktop' | 'mobile'] = `${SCREENSHOT_ROUTE}/${handle}/${file}?v=${version}`;
      styles.set(match[1], entry);
    }
    byTheme.set(handle, styles);
  }
  cache = { at: Date.now(), byTheme };
  return byTheme;
}

/** A theme's screenshots by style name; a style without its own falls back to the theme's first. */
export function screenshotsFor(handle: string, styles: string[]): Record<string, StyleScreenshots> {
  const found = scan().get(handle);
  if (!found || found.size === 0) return {};
  const first = found.values().next().value as StyleScreenshots;
  return Object.fromEntries(styles.map((style) => [style, found.get(styleSlug(style)) ?? first]));
}

/** The file on disk for a screenshot URL's handle and name, or null. */
export function screenshotFile(handle: string, file: string): string | null {
  if (!/^[a-z0-9-]+$/.test(handle) || !/^[a-z0-9-]+-(desktop|mobile)\.(jpg|png|webp)$/.test(file)) return null;
  const full = path.join(themesRoot(), handle, 'screenshots', file);
  return existsSync(full) ? full : null;
}

export function forgetScreenshots(): void {
  cache = null;
}
