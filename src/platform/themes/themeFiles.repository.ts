import { controlPlane, execute, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

export interface ThemeFileRow extends RowDataPacket {
  path: string;
  content: string | null;
  storage_key: string | null;
  content_type: string;
  checksum: string;
  size: number;
  updated_at: Date;
}

export interface DraftRow extends RowDataPacket {
  path: string;
  content: string | null;
  is_deleted: number;
  updated_at: Date;
}

export interface FileVersionRow extends RowDataPacket {
  id: number;
  path: string;
  content: string | null;
  checksum: string;
  source: string;
  created_by_admin_id: number | null;
  created_at: Date;
}

/** Files of built-in themes (control plane) and of each store's installed themes (tenant). */
export const themeFilesRepository = {
  // ── the library ───────────────────────────────────────────────────────────

  async libraryFiles(libraryThemeId: number, exec: Executor = controlPlane): Promise<ThemeFileRow[]> {
    return query<ThemeFileRow>(
      'SELECT path, content, NULL AS storage_key, content_type, checksum, size, updated_at FROM theme_library_files WHERE library_theme_id = ?',
      [libraryThemeId],
      exec,
    );
  },

  async replaceLibraryFiles(libraryThemeId: number, files: { path: string; content: string; contentType: string; checksum: string }[], exec: Executor): Promise<void> {
    await execute('DELETE FROM theme_library_files WHERE library_theme_id = ?', [libraryThemeId], exec);
    for (const file of files) {
      await execute(
        'INSERT INTO theme_library_files (library_theme_id, path, content, content_type, checksum, size) VALUES (?, ?, ?, ?, ?, ?)',
        [libraryThemeId, file.path, file.content, file.contentType, file.checksum, Buffer.byteLength(file.content)],
        exec,
      );
    }
  },

  // ── installed themes ──────────────────────────────────────────────────────

  async files(themeId: number, exec: Executor = pool): Promise<ThemeFileRow[]> {
    return query<ThemeFileRow>(
      'SELECT path, content, storage_key, content_type, checksum, size, updated_at FROM shop_theme_files WHERE shop_id = ? AND theme_id = ?',
      [shopId(), themeId],
      exec,
    );
  },

  async fileList(themeId: number, exec: Executor = pool): Promise<ThemeFileRow[]> {
    return query<ThemeFileRow>(
      'SELECT path, NULL AS content, storage_key, content_type, checksum, size, updated_at FROM shop_theme_files WHERE shop_id = ? AND theme_id = ? ORDER BY path',
      [shopId(), themeId],
      exec,
    );
  },

  async file(themeId: number, path: string, exec: Executor = pool): Promise<ThemeFileRow | null> {
    return queryOne<ThemeFileRow>(
      'SELECT path, content, storage_key, content_type, checksum, size, updated_at FROM shop_theme_files WHERE shop_id = ? AND theme_id = ? AND path = ? LIMIT 1',
      [shopId(), themeId, path],
      exec,
    );
  },

  async upsertFile(
    themeId: number,
    file: { path: string; content: string | null; storageKey?: string | null; contentType: string; checksum: string; size: number; adminId: number | null },
    exec: Executor,
  ): Promise<void> {
    await execute(
      `INSERT INTO shop_theme_files (shop_id, theme_id, path, content, storage_key, content_type, checksum, size, updated_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), storage_key = VALUES(storage_key), content_type = VALUES(content_type),
         checksum = VALUES(checksum), size = VALUES(size), updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [shopId(), themeId, file.path, file.content, file.storageKey ?? null, file.contentType, file.checksum, file.size, file.adminId],
      exec,
    );
  },

  async deleteFile(themeId: number, path: string, exec: Executor): Promise<number> {
    const result = await execute('DELETE FROM shop_theme_files WHERE shop_id = ? AND theme_id = ? AND path = ?', [shopId(), themeId, path], exec);
    return result.affectedRows;
  },

  async copyFiles(fromThemeId: number, toThemeId: number, exec: Executor): Promise<void> {
    await execute(
      `INSERT INTO shop_theme_files (shop_id, theme_id, path, content, storage_key, content_type, checksum, size, updated_by_admin_id)
       SELECT shop_id, ?, path, content, storage_key, content_type, checksum, size, updated_by_admin_id
         FROM shop_theme_files WHERE shop_id = ? AND theme_id = ?`,
      [toThemeId, shopId(), fromThemeId],
      exec,
    );
  },

  async bumpVersion(themeId: number, exec: Executor): Promise<void> {
    await execute('UPDATE shop_themes SET files_version = files_version + 1 WHERE shop_id = ? AND id = ?', [shopId(), themeId], exec);
  },

  // ── drafts ────────────────────────────────────────────────────────────────

  async drafts(themeId: number, exec: Executor = pool): Promise<DraftRow[]> {
    return query<DraftRow>('SELECT path, content, is_deleted, updated_at FROM shop_theme_drafts WHERE shop_id = ? AND theme_id = ?', [shopId(), themeId], exec);
  },

  async putDraft(themeId: number, path: string, content: string | null, deleted: boolean, adminId: number | null, exec: Executor = pool): Promise<void> {
    await execute(
      `INSERT INTO shop_theme_drafts (shop_id, theme_id, path, content, is_deleted, updated_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE content = VALUES(content), is_deleted = VALUES(is_deleted), updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [shopId(), themeId, path, content, deleted ? 1 : 0, adminId],
      exec,
    );
  },

  async clearDrafts(themeId: number, exec: Executor = pool): Promise<void> {
    await execute('DELETE FROM shop_theme_drafts WHERE shop_id = ? AND theme_id = ?', [shopId(), themeId], exec);
  },

  // ── history ───────────────────────────────────────────────────────────────

  async addVersion(themeId: number, version: { path: string; content: string | null; checksum: string; source: string; adminId: number | null }, exec: Executor): Promise<void> {
    await execute(
      'INSERT INTO shop_theme_file_versions (shop_id, theme_id, path, content, checksum, source, created_by_admin_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [shopId(), themeId, version.path, version.content, version.checksum, version.source, version.adminId],
      exec,
    );
    // Twenty versions a file is plenty to undo with, and bounds the table.
    await execute(
      `DELETE FROM shop_theme_file_versions
        WHERE shop_id = ? AND theme_id = ? AND path = ?
          AND id < (SELECT floor_id FROM (SELECT id AS floor_id FROM shop_theme_file_versions
                      WHERE shop_id = ? AND theme_id = ? AND path = ? ORDER BY id DESC LIMIT 1 OFFSET 19) AS keep)`,
      [shopId(), themeId, version.path, shopId(), themeId, version.path],
      exec,
    );
  },

  async versions(themeId: number, path: string, exec: Executor = pool): Promise<FileVersionRow[]> {
    return query<FileVersionRow>(
      'SELECT id, path, NULL AS content, checksum, source, created_by_admin_id, created_at FROM shop_theme_file_versions WHERE shop_id = ? AND theme_id = ? AND path = ? ORDER BY id DESC LIMIT 20',
      [shopId(), themeId, path],
      exec,
    );
  },

  async version(themeId: number, id: number, exec: Executor = pool): Promise<FileVersionRow | null> {
    return queryOne<FileVersionRow>('SELECT * FROM shop_theme_file_versions WHERE shop_id = ? AND theme_id = ? AND id = ? LIMIT 1', [shopId(), themeId, id], exec);
  },
};
