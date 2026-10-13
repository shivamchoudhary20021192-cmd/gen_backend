import { controlPlane, execute, insert, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

export interface LibraryThemeRow extends RowDataPacket {
  id: number;
  handle: string;
  name: string;
  author: string;
  version: string;
  description: string | null;
  verticals: unknown;
  preview_image_url: string | null;
  demo_url: string | null;
  price_amount: string;
  currency: string;
  settings_schema: unknown;
  presets: unknown;
  templates: unknown;
  section_types: unknown;
  is_builtin: number;
  status: 'draft' | 'published' | 'retired';
  sort_order: number;
  architecture: 'tokens' | 'liquid';
  files_checksum: string | null;
  features: unknown;
  industries: unknown;
}

export interface ShopThemeRow extends RowDataPacket {
  id: number;
  shop_id: number;
  public_id: string;
  library_theme_id: number | null;
  library_handle: string;
  name: string;
  role: 'main' | 'unpublished' | 'development';
  theme_version: string;
  preset: string | null;
  settings_data: unknown;
  architecture: 'tokens' | 'liquid';
  /** Bumped on every saved file change: the renderer's cache key. */
  files_version: number;
  source: 'library' | 'duplicate' | 'upload';
  processing: 'ready' | 'installing' | 'failed';
  published_at: Date | null;
  created_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
}

export const themesRepository = {
  // ── library (control plane) ───────────────────────────────────────────────

  async upsertLibraryTheme(
    theme: {
      handle: string;
      name: string;
      version: string;
      description: string;
      verticals: string[];
      previewImageUrl: string | null;
      settingsSchema: unknown;
      presets: unknown;
      templates: unknown;
      sectionTypes: string[];
      sortOrder: number;
    },
    exec: Executor = controlPlane,
  ): Promise<void> {
    await execute(
      `INSERT INTO theme_library
         (handle, name, version, description, verticals, preview_image_url, settings_schema, presets, templates,
          section_types, is_builtin, status, sort_order)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'published', ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name), version = VALUES(version), description = VALUES(description),
         verticals = VALUES(verticals), preview_image_url = VALUES(preview_image_url),
         settings_schema = VALUES(settings_schema), presets = VALUES(presets), templates = VALUES(templates),
         section_types = VALUES(section_types), sort_order = VALUES(sort_order), is_builtin = 1`,
      [
        theme.handle,
        theme.name,
        theme.version,
        theme.description,
        JSON.stringify(theme.verticals),
        theme.previewImageUrl,
        JSON.stringify(theme.settingsSchema),
        JSON.stringify(theme.presets),
        JSON.stringify(theme.templates),
        JSON.stringify(theme.sectionTypes),
        theme.sortOrder,
      ],
      exec,
    );
  },

  async publishedLibrary(exec: Executor = controlPlane): Promise<LibraryThemeRow[]> {
    return query<LibraryThemeRow>("SELECT * FROM theme_library WHERE status = 'published' ORDER BY sort_order, name", [], exec);
  },

  async libraryByHandle(handle: string, exec: Executor = controlPlane): Promise<LibraryThemeRow | null> {
    return queryOne<LibraryThemeRow>('SELECT * FROM theme_library WHERE handle = ? LIMIT 1', [handle], exec);
  },

  async libraryById(id: number, exec: Executor = controlPlane): Promise<LibraryThemeRow | null> {
    return queryOne<LibraryThemeRow>('SELECT * FROM theme_library WHERE id = ? LIMIT 1', [id], exec);
  },

  // ── installed themes (tenant) ─────────────────────────────────────────────

  async list(exec: Executor = pool): Promise<ShopThemeRow[]> {
    return query<ShopThemeRow>(
      "SELECT * FROM shop_themes WHERE shop_id = ? ORDER BY role = 'main' DESC, updated_at DESC",
      [shopId()],
      exec,
    );
  },

  async count(exec: Executor = pool): Promise<number> {
    const row = await queryOne<RowDataPacket & { total: number }>('SELECT COUNT(*) AS total FROM shop_themes WHERE shop_id = ?', [
      shopId(),
    ], exec);
    return Number(row?.total ?? 0);
  },

  async byPublicId(publicId: string, exec: Executor = pool): Promise<ShopThemeRow | null> {
    return queryOne<ShopThemeRow>('SELECT * FROM shop_themes WHERE shop_id = ? AND public_id = ? LIMIT 1', [shopId(), publicId], exec);
  },

  async main(exec: Executor = pool): Promise<ShopThemeRow | null> {
    return queryOne<ShopThemeRow>("SELECT * FROM shop_themes WHERE shop_id = ? AND role = 'main' LIMIT 1", [shopId()], exec);
  },

  async create(
    data: {
      publicId: string;
      libraryThemeId: number | null;
      libraryHandle: string;
      name: string;
      role: 'main' | 'unpublished' | 'development';
      version: string;
      preset: string | null;
      settings: Record<string, unknown>;
      adminId: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO shop_themes
         (shop_id, public_id, library_theme_id, library_handle, name, role, theme_version, preset, settings_data,
          published_at, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ${data.role === 'main' ? 'NOW()' : 'NULL'}, ?)`,
      [
        shopId(),
        data.publicId,
        data.libraryThemeId,
        data.libraryHandle,
        data.name,
        data.role,
        data.version,
        data.preset,
        JSON.stringify(data.settings),
        data.adminId,
      ],
      exec,
    );
  },

  async update(id: number, patch: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const columns = Object.keys(patch);
    if (columns.length === 0) return;
    await execute(
      `UPDATE shop_themes SET ${columns.map((column) => `\`${column}\` = ?`).join(', ')} WHERE shop_id = ? AND id = ?`,
      [...columns.map((column) => patch[column]), shopId(), id],
      exec,
    );
  },

  /** Demotes whatever is live, in the caller's transaction, before another theme is promoted. */
  async demoteMain(exec: Executor = pool): Promise<void> {
    await execute("UPDATE shop_themes SET role = 'unpublished' WHERE shop_id = ? AND role = 'main'", [shopId()], exec);
  },

  async remove(id: number, exec: Executor = pool): Promise<void> {
    await execute("DELETE FROM shop_themes WHERE shop_id = ? AND id = ? AND role <> 'main'", [shopId(), id], exec);
  },

  async mediaKey(mediaId: number, exec: Executor = pool): Promise<string | null> {
    const row = await queryOne<RowDataPacket & { storage_key: string }>(
      'SELECT storage_key FROM media WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), mediaId],
      exec,
    );
    return row?.storage_key ?? null;
  },
};
