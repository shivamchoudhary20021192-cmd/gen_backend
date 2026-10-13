import path from 'node:path';
import sharp from 'sharp';
import { env } from '../../config/env';
import { ApiError } from '../../core/ApiError';
import { sha256, uuid } from '../../core/crypto';
import { logger } from '../../core/logger';
import { buildMeta, parsePagination, parseSort, type PaginationMeta } from '../../core/pagination';
import { slugify } from '../../core/slug';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { extractPoster } from './videoPoster';
import { mediaRepository, type MediaRow, type MediaVariantRow } from './media.repository';
import { storage } from './storage';
import { tenancy } from '../../platform/tenancy/context';

const SORTABLE: Record<string, string> = {
  created_at: 'm.created_at',
  size: 'm.size_bytes',
  filename: 'm.original_filename',
  usage: 'm.usage_count',
};

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

export interface PresentedMedia {
  id: number;
  public_id: string;
  url: string;
  storage_key: string;
  disk: string;
  folder_id: number | null;
  original_filename: string;
  mime_type: string;
  media_type: string;
  size_bytes: number;
  width: number | null;
  height: number | null;
  aspect_ratio: number | null;
  /** Video only. */
  duration_ms: number | null;
  /**
   * Video only: a still frame from the file, for a grid tile, a form preview
   * and the `poster` a player paints before the first byte of video arrives.
   * Null when ffmpeg was not available to pull one.
   */
  poster_url: string | null;
  alt_text: string | null;
  title: string | null;
  caption: string | null;
  focal_point: { x: number; y: number };
  dominant_color: string | null;
  blurhash: string | null;
  placeholder: string | null;
  status: string;
  usage_count: number;
  created_at: string;
  variants?: { key: string; format: string; width: number; height: number; size_bytes: number; url: string }[];
  srcset?: Record<string, string>;
}

function mediaTypeFor(mime: string): string {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime === 'application/pdf') return 'document';
  return 'other';
}

/**
 * The widest poster variant that actually exists.
 *
 * A short vertical clip may only ever get a thumb, so this walks down the
 * ladder rather than assuming 'md' was generated.
 */
function posterUrl(variants: MediaVariantRow[]): string | null {
  for (const key of ['lg', 'md', 'sm', 'thumb']) {
    const variant = variants.find((v) => v.variant_key === key && v.format === 'webp');
    if (variant) return storage.publicUrl(variant.storage_key);
  }
  return null;
}

export function presentMedia(row: MediaRow, variants: MediaVariantRow[] = []): PresentedMedia {
  const mine = variants.filter((v) => v.media_id === row.id);
  const srcset: Record<string, string> = {};
  for (const v of mine) srcset[`${v.variant_key}_${v.format}`] = storage.publicUrl(v.storage_key);

  return {
    id: row.id,
    public_id: row.public_id,
    url: row.absolute_url ?? storage.publicUrl(row.storage_key),
    storage_key: row.storage_key,
    disk: row.disk,
    folder_id: row.folder_id,
    original_filename: row.original_filename,
    mime_type: row.mime_type,
    media_type: row.media_type,
    size_bytes: Number(row.size_bytes),
    width: row.width,
    height: row.height,
    aspect_ratio: row.aspect_ratio ? Number(row.aspect_ratio) : null,
    duration_ms: row.duration_ms === null ? null : Number(row.duration_ms),
    // The widest poster that was actually generated. A short video shot
    // vertically may only have a thumb, so this walks down rather than
    // assuming 'md' exists.
    poster_url: row.media_type === 'video' ? posterUrl(mine) : null,
    alt_text: row.alt_text,
    title: row.title,
    caption: row.caption,
    focal_point: { x: Number(row.focal_x), y: Number(row.focal_y) },
    dominant_color: row.dominant_color,
    blurhash: row.blurhash,
    placeholder: row.placeholder_uri,
    status: row.status,
    usage_count: Number(row.usage_count),
    created_at: row.created_at.toISOString(),
    ...(mine.length > 0
      ? {
          variants: mine.map((v) => ({
            key: v.variant_key,
            format: v.format,
            width: v.width ?? 0,
            height: v.height ?? 0,
            size_bytes: Number(v.size_bytes),
            url: storage.publicUrl(v.storage_key),
          })),
          srcset,
        }
      : {}),
  };
}

/**
 * Storage key layout:  shops/{shop}/media/{YYYY}/{MM}/{uuid}/{variant}.{ext}
 * Sharded by year and month so no single directory grows past a few thousand
 * entries — which matters on ext4/NTFS once the UGC library is large.
 */
function buildKeyPrefix(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  // Namespaced by shop, so a bucket listing, a backup or a shop's data export
  // is one prefix. Rows written before multi-tenancy keep their old keys —
  // the key is stored, never derived, so both layouts resolve.
  return `shops/${tenancy.current().publicId}/media/${yyyy}/${mm}/${uuid()}`;
}

export const mediaService = {
  async upload(
    files: Express.Multer.File[],
    options: { folderId?: number; altText?: string },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PresentedMedia[]> {
    if (files.length === 0) throw ApiError.validation({ files: ['At least one file is required.'] });

    if (options.folderId !== undefined) {
      const folder = await mediaRepository.findFolder(options.folderId);
      if (!folder) throw ApiError.validation({ folder_id: ['That folder does not exist.'] });
    }

    const results: PresentedMedia[] = [];

    for (const file of files) {
      const checksum = sha256(file.buffer);

      // Dedupe: the same pack shot uploaded from three different screens is
      // one file on disk and one row, not three.
      const existing = await mediaRepository.findByChecksum(checksum);
      if (existing) {
        logger.info('media.deduplicated', { media_id: existing.id, filename: file.originalname });
        const variants = await mediaRepository.variantsFor([existing.id]);
        results.push(presentMedia(existing, variants));
        continue;
      }

      const mediaType = mediaTypeFor(file.mimetype);
      const extension = (path.extname(file.originalname).replace('.', '') || 'bin').toLowerCase();
      const prefix = buildKeyPrefix();
      const originalKey = `${prefix}/original.${extension}`;

      let width: number | null = null;
      let height: number | null = null;
      let hasAlpha = false;
      let dominantColor: string | null = null;
      let placeholderUri: string | null = null;
      let durationMs: number | null = null;

      /**
       * The buffer the picture-shaped work runs on.
       *
       * For an image that is the file itself. For a video it is one frame
       * pulled out of it, which is why everything below — the dimensions, the
       * dominant colour, the inline preview, the whole variant ladder — needs
       * no idea which of the two it was handed.
       */
      let pictureBuffer: Buffer | null = mediaType === 'image' ? file.buffer : null;

      if (mediaType === 'video') {
        const poster = await extractPoster(file.buffer, extension);
        if (poster) {
          pictureBuffer = poster.frame;
          durationMs = poster.durationMs;
        }
      }

      if (pictureBuffer) {
        try {
          const image = sharp(pictureBuffer, { failOn: 'none' });
          const metadata = await image.metadata();
          width = metadata.width ?? null;
          height = metadata.height ?? null;
          hasAlpha = Boolean(metadata.hasAlpha);

          const stats = await image.stats();
          const { r, g, b } = stats.dominant;
          dominantColor = `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('')}`;

          // A 20px inline preview. Renders instantly, holds the layout, and
          // keeps CLS inside the BRD's 0.1 budget while the real file loads.
          const placeholder = await sharp(pictureBuffer, { failOn: 'none' })
            .resize(20, 20, { fit: 'inside' })
            .webp({ quality: 40 })
            .toBuffer();
          placeholderUri = `data:image/webp;base64,${placeholder.toString('base64')}`;
        } catch (error) {
          logger.warn('media.metadata_failed', { filename: file.originalname, error: String(error) });
          // A frame that sharp cannot read is not a frame worth making
          // variants from.
          if (mediaType === 'video') pictureBuffer = null;
        }
      }

      await storage.put(originalKey, file.buffer, file.mimetype);

      const mediaId = await withTransaction(async (tx) => {
        const id = await mediaRepository.create(
          {
            folderId: options.folderId ?? null,
            disk: storage.name,
            storageKey: originalKey,
            originalFilename: file.originalname.slice(0, 255),
            extension,
            mimeType: file.mimetype,
            mediaType,
            sizeBytes: file.size,
            width,
            height,
            aspectRatio: width && height ? Number((width / height).toFixed(4)) : null,
            durationMs,
            hasAlpha,
            checksum,
            altText: options.altText ?? null,
            title: path.basename(file.originalname, path.extname(file.originalname)).slice(0, 255),
            dominantColor,
            placeholderUri,
            // 'processing' only while there is a variant ladder still to
            // build. A video whose poster could not be extracted is finished
            // the moment it is stored — it is never going to become readier.
            status: pictureBuffer && width ? 'processing' : 'ready',
            uploadedByAdminId: actor.id,
          },
          tx,
        );

        await auditService.log(
          {
            actorId: actor.id,
            actorLabel: actor.email,
            action: 'media.uploaded',
            entityType: 'media',
            entityId: id,
            summary: `Uploaded ${file.originalname}`,
            context: { request_id: meta.requestId, size_bytes: file.size, mime: file.mimetype },
            ip: meta.ip,
            userAgent: meta.userAgent,
          },
          tx,
        );

        return id;
      });

      // Variants are generated after the response. Twelve 2000×2500 pack shots
      // would otherwise hold the request open for the better part of a minute.
      if (pictureBuffer && width) {
        void this.generateVariants(mediaId, pictureBuffer, prefix, width).catch((error) => {
          logger.error('media.variant_generation_failed', { media_id: mediaId, error: String(error) });
          void mediaRepository.markFailed(mediaId, String(error));
        });
      }

      const row = await mediaRepository.findById(mediaId);
      if (row) results.push(presentMedia(row));
    }

    return results;
  },

  /**
   * Never upscales: a 400px logo does not get a 1800px variant, it just stops
   * at its own width. Wasting bytes to widen a small image helps nobody.
   */
  async generateVariants(mediaId: number, buffer: Buffer, prefix: string, sourceWidth: number): Promise<void> {
    const widths = env.storage.variantWidths;
    const formats = env.storage.variantFormats;

    for (const [variantKey, targetWidth] of Object.entries(widths)) {
      if (targetWidth > sourceWidth && variantKey !== 'thumb') continue;

      for (const format of formats) {
        try {
          const pipeline = sharp(buffer, { failOn: 'none' }).resize(targetWidth, null, {
            fit: 'inside',
            withoutEnlargement: true,
          });
          const output =
            format === 'avif'
              ? await pipeline.avif({ quality: 55, effort: 3 }).toBuffer({ resolveWithObject: true })
              : await pipeline.webp({ quality: 78 }).toBuffer({ resolveWithObject: true });

          const key = `${prefix}/${variantKey}.${format}`;
          await storage.put(key, output.data, `image/${format}`);
          await mediaRepository.addVariant({
            mediaId,
            variantKey,
            format,
            width: output.info.width,
            height: output.info.height,
            sizeBytes: output.info.size,
            disk: storage.name,
            storageKey: key,
          });
        } catch (error) {
          logger.warn('media.variant_failed', { media_id: mediaId, variantKey, format, error: String(error) });
        }
      }
    }

    await mediaRepository.markReady(mediaId);
    logger.info('media.variants_ready', { media_id: mediaId });
  },

  async list(queryParams: Record<string, unknown>): Promise<{ media: PresentedMedia[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const orderBy = parseSort(queryParams.sort, SORTABLE, 'm.created_at DESC');
    const filters = {
      folderId: queryParams.folder_id as number | undefined,
      mediaType: queryParams.media_type as string | undefined,
      status: queryParams.status as string | undefined,
      search: queryParams.q as string | undefined,
      unusedOnly: queryParams.unused === true,
    };

    const [rows, total] = await Promise.all([
      mediaRepository.list(filters, orderBy, page.limit, page.offset),
      mediaRepository.count(filters),
    ]);

    const variants = await mediaRepository.variantsFor(rows.map((r) => r.id));
    return { media: rows.map((r) => presentMedia(r, variants)), pagination: buildMeta(total, page) };
  },

  async get(id: number): Promise<PresentedMedia> {
    const row = await mediaRepository.findById(id);
    if (!row) throw ApiError.notFound('Media');
    const variants = await mediaRepository.variantsFor([id]);
    return presentMedia(row, variants);
  },

  async update(
    id: number,
    input: Record<string, unknown>,
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ): Promise<PresentedMedia> {
    const row = await mediaRepository.findById(id);
    if (!row) throw ApiError.notFound('Media');

    const fields: Record<string, unknown> = {};
    if ('alt_text' in input) fields.alt_text = input.alt_text ?? null;
    if ('title' in input) fields.title = input.title ?? null;
    if ('caption' in input) fields.caption = input.caption ?? null;
    if ('credit' in input) fields.credit = input.credit ?? null;
    if ('folder_id' in input) fields.folder_id = input.folder_id ?? null;
    if ('usage_rights' in input) fields.usage_rights = input.usage_rights;
    if ('focal_x' in input) fields.focal_x = input.focal_x;
    if ('focal_y' in input) fields.focal_y = input.focal_y;

    if (Object.keys(fields).length === 0) return this.get(id);

    await withTransaction(async (tx) => {
      await mediaRepository.update(id, fields, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'media.updated',
          entityType: 'media',
          entityId: id,
          summary: `Updated ${row.original_filename}`,
          changes: auditService.diff(row as unknown as Record<string, unknown>, fields),
          context: { request_id: meta.requestId },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    return this.get(id);
  },

  /**
   * Soft delete only, and refused while anything still points at the file.
   * The bytes are removed later by a sweep, so an accidental delete is
   * recoverable for as long as that window lasts.
   */
  async remove(id: number, actor: AuthenticatedAdmin, meta: ActorMeta): Promise<void> {
    const row = await mediaRepository.findById(id);
    if (!row) throw ApiError.notFound('Media');

    if (Number(row.usage_count) > 0) {
      throw ApiError.conflict(
        `This file is used in ${row.usage_count} place(s). Detach it before deleting.`,
        'IN_USE',
        { usage_count: Number(row.usage_count) },
      );
    }

    await withTransaction(async (tx) => {
      await mediaRepository.softDelete(id, tx);
      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'media.deleted',
          entityType: 'media',
          entityId: id,
          summary: `Deleted ${row.original_filename}`,
          context: { request_id: meta.requestId, storage_key: row.storage_key },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });
  },

  async listFolders() {
    const folders = await mediaRepository.listFolders();
    return {
      folders: folders.map((f) => ({
        id: f.id,
        parent_id: f.parent_id,
        name: f.name,
        slug: f.slug,
        path: f.path,
        depth: f.depth,
        media_count: Number(f.media_count),
      })),
    };
  },

  async createFolder(input: { name: string; parent_id?: number | null }, actor: AuthenticatedAdmin) {
    const slug = slugify(input.name);
    let parentPath = '';
    let depth = 0;

    if (input.parent_id) {
      const parent = await mediaRepository.findFolder(input.parent_id);
      if (!parent) throw ApiError.validation({ parent_id: ['Parent folder does not exist.'] });
      parentPath = parent.path;
      depth = parent.depth + 1;
    }

    const id = await mediaRepository.createFolder({
      parentId: input.parent_id ?? null,
      name: input.name,
      slug,
      path: parentPath ? `${parentPath}/${slug}` : slug,
      depth,
      createdBy: actor.id,
    });

    const folder = await mediaRepository.findFolder(id);
    return { folder };
  },
};
