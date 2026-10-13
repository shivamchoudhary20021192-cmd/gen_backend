import { logger } from '../../core/logger';
import { controlPlane, execute, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { withTransaction } from '../../db/transaction';
import { shopId } from '../tenancy/context';
import { contentTypeFor, loadBundles, sha256, type ThemeBundle } from './bundles';
import { themeFilesRepository } from './themeFiles.repository';
import { themesRepository, type LibraryThemeRow, type ShopThemeRow } from './themes.repository';

/**
 * Moves theme files around: from the repository into the theme store
 * (library), and from the theme store into a store's installed theme.
 *
 * The library lives in the control plane and a store's themes on its pod, so
 * an install reads the library's files and writes them to the pod — never a
 * cross-database INSERT … SELECT.
 */

export type SettingsData = { current: Record<string, unknown> | string; presets?: Record<string, Record<string, unknown>> };

function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return raw as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function sectionTypes(bundle: ThemeBundle): string[] {
  return [...bundle.files.keys()]
    .filter((file) => file.startsWith('sections/') && file.endsWith('.liquid'))
    .map((file) => file.slice('sections/'.length, -'.liquid'.length))
    .sort();
}

/** Rows inserted in batches: one statement per 25 files keeps a 60-file install to three round trips. */
async function insertFiles(themeId: number, files: { path: string; content: string; contentType: string; checksum: string }[], adminId: number | null, exec: Executor): Promise<void> {
  for (let i = 0; i < files.length; i += 25) {
    const chunk = files.slice(i, i + 25);
    await execute(
      `INSERT INTO shop_theme_files (shop_id, theme_id, path, content, storage_key, content_type, checksum, size, updated_by_admin_id)
       VALUES ${chunk.map(() => '(?, ?, ?, ?, NULL, ?, ?, ?, ?)').join(', ')}
       ON DUPLICATE KEY UPDATE content = VALUES(content), content_type = VALUES(content_type), checksum = VALUES(checksum), size = VALUES(size)`,
      chunk.flatMap((file) => [shopId(), themeId, file.path, file.content, file.contentType, file.checksum, Buffer.byteLength(file.content), adminId]),
      exec,
    );
  }
}

export const themeInstaller = {
  /**
   * Boot: makes the theme store match the themes in this build. A theme whose
   * files are unchanged (same checksum) is not rewritten; a changed theme gets
   * a new `version`, and installed copies offer "Update available".
   */
  async syncLibrary(): Promise<{ synced: number; rewritten: number }> {
    const bundles = loadBundles({ fresh: true });
    let rewritten = 0;
    for (const bundle of bundles) {
      const { manifest } = bundle;
      const schema = parseJson<unknown[]>(bundle.files.get('config/settings_schema.json') ?? '[]', []);
      const presets = Object.entries(manifest.presets).map(([name, settings]) => ({ key: name, name, settings }));
      const indexTemplate = parseJson<Record<string, unknown>>(bundle.files.get('templates/index.json') ?? '{}', {});
      await execute(
        `INSERT INTO theme_library
           (handle, name, author, version, architecture, description, verticals, features, industries, preview_image_url,
            price_amount, settings_schema, presets, templates, section_types, is_builtin, status, sort_order)
         VALUES (?, ?, ?, ?, 'liquid', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'published', ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name), author = VALUES(author), version = VALUES(version), architecture = 'liquid',
           description = VALUES(description), verticals = VALUES(verticals), features = VALUES(features),
           industries = VALUES(industries), preview_image_url = VALUES(preview_image_url), price_amount = VALUES(price_amount),
           settings_schema = VALUES(settings_schema), presets = VALUES(presets), templates = VALUES(templates),
           section_types = VALUES(section_types), sort_order = VALUES(sort_order), is_builtin = 1, status = 'published'`,
        [
          manifest.handle,
          manifest.name,
          manifest.author,
          manifest.version,
          manifest.description,
          JSON.stringify(manifest.verticals),
          JSON.stringify(manifest.features),
          JSON.stringify(manifest.industries),
          manifest.previewImageUrl,
          manifest.price,
          JSON.stringify(schema),
          JSON.stringify(presets),
          JSON.stringify({ index: indexTemplate }),
          JSON.stringify(sectionTypes(bundle)),
          manifest.sortOrder,
        ],
        controlPlane,
      );
      const row = await themesRepository.libraryByHandle(manifest.handle);
      if (!row || row.files_checksum === bundle.checksum) continue;
      await withTransaction(async (tx) => {
        await themeFilesRepository.replaceLibraryFiles(
          row.id,
          [...bundle.files.entries()].map(([path, content]) => ({ path, content, contentType: contentTypeFor(path), checksum: sha256(content) })),
          tx,
        );
        await execute('UPDATE theme_library SET files_checksum = ? WHERE id = ?', [bundle.checksum, row.id], tx);
      }, controlPlane);
      rewritten += 1;
    }
    logger.info('themes.library_synced', { themes: bundles.length, rewritten });
    return { synced: bundles.length, rewritten };
  },

  /**
   * Copies a theme store theme's files into an installed theme. `settings`
   * replaces config/settings_data.json's `current` (a chosen style, or the
   * look carried over from an older theme).
   */
  async installFiles(
    themeId: number,
    library: LibraryThemeRow,
    options: { preset?: string | null; current?: Record<string, unknown> | null; adminId?: number | null; transform?: (path: string, content: string) => string } = {},
    exec: Executor = pool,
  ): Promise<void> {
    const rows = await themeFilesRepository.libraryFiles(library.id);
    if (rows.length === 0) throw new Error(`Theme ${library.handle} has no files in the library; run the library sync.`);
    const files = rows.map((row) => {
      let content = row.content ?? '';
      if (row.path === 'config/settings_data.json') {
        const data = parseJson<SettingsData>(content, { current: {} });
        const fromPreset = options.preset && data.presets?.[options.preset] ? { ...data.presets[options.preset] } : null;
        const current = { ...(typeof data.current === 'object' ? data.current : {}), ...(fromPreset ?? {}), ...(options.current ?? {}) };
        content = `${JSON.stringify({ ...data, current }, null, 2)}\n`;
      }
      if (options.transform) content = options.transform(row.path, content);
      return { path: row.path, content, contentType: row.content_type, checksum: sha256(content) };
    });
    await insertFiles(themeId, files, options.adminId ?? null, exec);
    await execute(
      "UPDATE shop_themes SET architecture = 'liquid', files_version = files_version + 1, processing = 'ready', theme_version = ? WHERE shop_id = ? AND id = ?",
      [library.version, shopId(), themeId],
      exec,
    );
  },

  /**
   * A theme installed when themes were only colours and fonts: give it the
   * files of its theme, keeping the merchant's style and customisations. Runs
   * on first render, once — the row lock makes a concurrent request wait and
   * then find the work done.
   */
  async materialize(row: ShopThemeRow): Promise<ShopThemeRow> {
    return withTransaction(async (tx) => {
      const locked = await queryOne<ShopThemeRow>('SELECT * FROM shop_themes WHERE shop_id = ? AND id = ? FOR UPDATE', [shopId(), row.id], tx);
      if (!locked) throw new Error('Theme vanished while it was being converted.');
      if (locked.architecture === 'liquid' && Number(locked.files_version) > 0) return locked;
      const library = await themesRepository.libraryByHandle(locked.library_handle);
      if (!library || library.architecture !== 'liquid') throw new Error(`Theme ${locked.library_handle} has no files to convert to.`);
      const overrides = parseJson<Record<string, unknown>>(locked.settings_data, {});
      await this.installFiles(locked.id, library, { preset: locked.preset, current: overrides }, tx);
      logger.info('themes.materialized', { theme_id: locked.id, handle: locked.library_handle });
      return (await queryOne<ShopThemeRow>('SELECT * FROM shop_themes WHERE shop_id = ? AND id = ?', [shopId(), row.id], tx))!;
    });
  },

  /** How many installed themes still have no files (for the conversion job's log). */
  async pendingConversions(exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>("SELECT COUNT(*) AS total FROM shop_themes WHERE shop_id = ? AND architecture = 'tokens'", [shopId()], exec);
    return Number(row?.total ?? 0);
  },
};
