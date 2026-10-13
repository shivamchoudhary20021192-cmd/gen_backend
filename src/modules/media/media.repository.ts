import { execute, insert, query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface MediaRow extends RowDataPacket {
  id: number;
  public_id: string;
  folder_id: number | null;
  disk: string;
  storage_key: string;
  absolute_url: string | null;
  original_filename: string;
  extension: string;
  mime_type: string;
  media_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  aspect_ratio: string | null;
  duration_ms: number | null;
  alt_text: string | null;
  title: string | null;
  caption: string | null;
  credit: string | null;
  usage_rights: string;
  focal_x: string;
  focal_y: string;
  dominant_color: string | null;
  blurhash: string | null;
  placeholder_uri: string | null;
  status: string;
  processing_error: string | null;
  usage_count: number;
  source: string;
  uploaded_by_admin_id: number | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface MediaVariantRow extends RowDataPacket {
  id: number;
  media_id: number;
  variant_key: string;
  format: string;
  width: number | null;
  height: number | null;
  size_bytes: number;
  disk: string;
  storage_key: string;
}

export interface FolderRow extends RowDataPacket {
  id: number;
  parent_id: number | null;
  name: string;
  slug: string;
  path: string;
  depth: number;
  media_count: number;
}

interface CountRow extends RowDataPacket {
  total: number;
}

export interface MediaFilters {
  folderId?: number;
  mediaType?: string;
  status?: string;
  search?: string;
  unusedOnly?: boolean;
}

function buildWhere(filters: MediaFilters): { clause: string; params: unknown[] } {
  const conditions = ['m.shop_id = ?', 'm.deleted_at IS NULL'];
  const params: unknown[] = [shopId()];

  if (filters.folderId !== undefined) {
    conditions.push('m.folder_id = ?');
    params.push(filters.folderId);
  }
  if (filters.mediaType) {
    conditions.push('m.media_type = ?');
    params.push(filters.mediaType);
  }
  if (filters.status) {
    conditions.push('m.status = ?');
    params.push(filters.status);
  }
  if (filters.unusedOnly) conditions.push('m.usage_count = 0');
  if (filters.search) {
    conditions.push('(m.original_filename LIKE ? OR m.alt_text LIKE ? OR m.title LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const mediaRepository = {
  async findByChecksum(checksum: string, exec: Executor = pool): Promise<MediaRow | null> {
    return queryOne<MediaRow>(
      'SELECT * FROM media WHERE shop_id = ? AND checksum_sha256 = ? AND deleted_at IS NULL LIMIT 1',
      [shopId(), checksum],
      exec,
    );
  },

  async findById(id: number, exec: Executor = pool): Promise<MediaRow | null> {
    return queryOne<MediaRow>('SELECT * FROM media WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1', [shopId(), id], exec);
  },

  async findManyByIds(ids: number[], exec: Executor = pool): Promise<MediaRow[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return query<MediaRow>(
      `SELECT * FROM media WHERE shop_id = ? AND id IN (${placeholders}) AND deleted_at IS NULL`,
      [shopId(), ...ids],
      exec,
    );
  },

  async list(
    filters: MediaFilters,
    orderBy: string,
    limit: number,
    offset: number,
    exec: Executor = pool,
  ): Promise<MediaRow[]> {
    const { clause, params } = buildWhere(filters);
    return query<MediaRow>(
      `SELECT m.* FROM media m ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: MediaFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<CountRow>(`SELECT COUNT(*) AS total FROM media m ${clause}`, params, exec);
    return row?.total ?? 0;
  },

  async create(
    data: {
      folderId: number | null;
      disk: string;
      storageKey: string;
      originalFilename: string;
      extension: string;
      mimeType: string;
      mediaType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      aspectRatio: number | null;
      durationMs: number | null;
      hasAlpha: boolean;
      checksum: string;
      altText: string | null;
      title: string | null;
      dominantColor: string | null;
      placeholderUri: string | null;
      status: string;
      uploadedByAdminId: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    // `blurhash` is a VARCHAR(64) reserved for a real BlurHash string; the
    // base64 LQIP belongs in `placeholder_uri` (VARCHAR(2000)). Mixing them up
    // is an ER_DATA_TOO_LONG waiting to happen.
    return insert(
      `INSERT INTO media
         (shop_id, folder_id, disk, storage_key, original_filename, extension, mime_type, media_type,
          size_bytes, width, height, aspect_ratio, duration_ms, has_alpha, checksum_sha256,
          alt_text, title, dominant_color, placeholder_uri, status, source, uploaded_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'admin_upload', ?)`,
      [
        shopId(),
        data.folderId,
        data.disk,
        data.storageKey,
        data.originalFilename,
        data.extension,
        data.mimeType,
        data.mediaType,
        data.sizeBytes,
        data.width,
        data.height,
        data.aspectRatio,
        data.durationMs,
        data.hasAlpha ? 1 : 0,
        data.checksum,
        data.altText,
        data.title,
        data.dominantColor,
        data.placeholderUri,
        data.status,
        data.uploadedByAdminId,
      ],
      exec,
    );
  },

  async update(id: number, fields: Record<string, unknown>, exec: Executor = pool): Promise<void> {
    const keys = Object.keys(fields);
    if (keys.length === 0) return;
    const assignments = keys.map((k) => `\`${k}\` = ?`).join(', ');
    await execute(`UPDATE media SET ${assignments} WHERE shop_id = ? AND id = ?`, [...Object.values(fields), shopId(), id], exec);
  },

  /**
   * `variants_generated_at IS NOT NULL` is the schema's way of saying
   * "optimised renditions exist" — there is no separate boolean.
   */
  async markReady(id: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE media SET status = 'ready', variants_generated_at = NOW(), processing_error = NULL WHERE shop_id = ? AND id = ?`,
      [shopId(), id],
      exec,
    );
  },

  async markFailed(id: number, error: string, exec: Executor = pool): Promise<void> {
    await execute(`UPDATE media SET status = 'failed', processing_error = ? WHERE shop_id = ? AND id = ?`, [error.slice(0, 500), shopId(), id], exec);
  },

  async softDelete(id: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE media SET deleted_at = NOW() WHERE shop_id = ? AND id = ?', [shopId(), id], exec);
  },

  async addVariant(
    data: {
      mediaId: number;
      variantKey: string;
      format: string;
      width: number;
      height: number;
      sizeBytes: number;
      disk: string;
      storageKey: string;
    },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO media_variants (shop_id, media_id, variant_key, format, width, height, size_bytes, disk, storage_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE width = VALUES(width), height = VALUES(height),
                               size_bytes = VALUES(size_bytes), storage_key = VALUES(storage_key)`,
      [shopId(), data.mediaId, data.variantKey, data.format, data.width, data.height, data.sizeBytes, data.disk, data.storageKey],
      exec,
    );
  },

  async variantsFor(mediaIds: number[], exec: Executor = pool): Promise<MediaVariantRow[]> {
    if (mediaIds.length === 0) return [];
    const placeholders = mediaIds.map(() => '?').join(',');
    return query<MediaVariantRow>(
      `SELECT * FROM media_variants WHERE shop_id = ? AND media_id IN (${placeholders}) ORDER BY media_id, width`,
      [shopId(), ...mediaIds],
      exec,
    );
  },

  /** Counter maintained on attach/detach; drives the orphan sweep. */
  async bumpUsage(mediaId: number, delta: number, exec: Executor = pool): Promise<void> {
    await execute(
      `UPDATE media
          SET usage_count = GREATEST(0, CAST(usage_count AS SIGNED) + ?),
              last_used_at = CASE WHEN ? > 0 THEN NOW() ELSE last_used_at END
        WHERE shop_id = ? AND id = ?`,
      [delta, delta, shopId(), mediaId],
      exec,
    );
  },

  // ── folders ────────────────────────────────────────────────────────────────
  async listFolders(exec: Executor = pool): Promise<FolderRow[]> {
    return query<FolderRow>('SELECT * FROM media_folders WHERE shop_id = ? ORDER BY path', [shopId()], exec);
  },

  async findFolder(id: number, exec: Executor = pool): Promise<FolderRow | null> {
    return queryOne<FolderRow>('SELECT * FROM media_folders WHERE shop_id = ? AND id = ? LIMIT 1', [shopId(), id], exec);
  },

  async createFolder(
    data: { parentId: number | null; name: string; slug: string; path: string; depth: number; createdBy: number | null },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO media_folders (shop_id, parent_id, name, slug, path, depth, created_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [shopId(), data.parentId, data.name, data.slug, data.path, data.depth, data.createdBy],
      exec,
    );
  },
};
