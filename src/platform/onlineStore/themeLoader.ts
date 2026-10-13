import { createHash } from 'node:crypto';
import { ShopScopedCache } from '../cache/shopCache';
import { shopId } from '../tenancy/context';
import { themeFilesRepository } from '../themes/themeFiles.repository';
import { themeInstaller } from '../themes/themeInstaller';
import { themesRepository, type ShopThemeRow } from '../themes/themes.repository';
import type { LoadedTheme, ThemeFileEntry } from './engine/types';

/**
 * Loads an installed theme's files for rendering.
 *
 * A theme's files are read once per saved version (`files_version` is in the
 * cache key, and every save bumps it), so a busy storefront reads the theme
 * from memory. The editor's preview lays the merchant's unsaved drafts over
 * the saved files; those are read fresh on every preview request.
 */

const cache = new ShopScopedCache<LoadedTheme>(10 * 60_000, 500, { versioned: true });
/**
 * Which theme is published: asked on every storefront request, so kept in
 * memory. Publishing writes shop_themes, which clears this on every pod
 * (storefrontVersions.ts); the TTL is only a backstop.
 */
const mainRows = new ShopScopedCache<ShopThemeRow | null>(60_000, 4);

async function loadSaved(row: ShopThemeRow): Promise<LoadedTheme> {
  return cache.get(`${row.id}:${row.files_version}`, async () => {
    const files = new Map<string, ThemeFileEntry>();
    for (const file of await themeFilesRepository.files(row.id)) {
      files.set(file.path, { content: file.content, contentType: file.content_type, storageKey: file.storage_key, checksum: file.checksum });
    }
    return {
      shopId: shopId(),
      id: row.id,
      publicId: row.public_id,
      name: row.name,
      role: row.role,
      libraryHandle: row.library_handle,
      filesVersion: Number(row.files_version),
      draftStamp: null,
      files,
    };
  });
}

export const themeLoader = {
  /** The theme as a render sees it; `drafts` lays unsaved editor changes over it. */
  async load(row: ShopThemeRow, options: { drafts?: boolean } = {}): Promise<LoadedTheme> {
    const ready = row.architecture === 'liquid' && Number(row.files_version) > 0 ? row : await themeInstaller.materialize(row);
    const saved = await loadSaved(ready);
    if (!options.drafts) return saved;
    const drafts = await themeFilesRepository.drafts(ready.id);
    if (drafts.length === 0) return saved;
    const files = new Map(saved.files);
    const stamp = createHash('sha1');
    for (const draft of drafts) {
      stamp.update(`${draft.path}:${new Date(draft.updated_at).getTime()}:${draft.is_deleted};`);
      if (draft.is_deleted) files.delete(draft.path);
      else files.set(draft.path, { content: draft.content, contentType: draft.path.endsWith('.json') ? 'application/json' : 'text/x-liquid', storageKey: null, checksum: stamp.copy().digest('hex').slice(0, 16) });
    }
    return { ...saved, files, draftStamp: stamp.digest('hex').slice(0, 16) };
  },

  /** The published theme; null for a store with none (a brand-new store before provisioning). */
  async main(): Promise<LoadedTheme | null> {
    const row = await mainRows.get('main', () => themesRepository.main());
    return row ? this.load(row) : null;
  },

  /** An installed theme by its public id, for previews and the editor. */
  async byPublicId(publicId: string, options: { drafts?: boolean } = {}): Promise<LoadedTheme | null> {
    const row = await themesRepository.byPublicId(publicId);
    return row ? this.load(row, options) : null;
  },

  forget(): void {
    cache.clear();
    mainRows.clear();
  },
};
