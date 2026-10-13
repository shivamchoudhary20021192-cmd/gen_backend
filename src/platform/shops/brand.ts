import { ApiError } from '../../core/ApiError';
import { execute, queryOne, type RowDataPacket } from '../../db/pool';
import { storage } from '../../modules/media/storage';
import { auditService } from '../../shared/audit.service';
import { ShopScopedCache } from '../cache/shopCache';
import { shopId } from '../tenancy/context';

/**
 * Settings → Brand: what makes a storefront look like its store wherever it
 * is drawn — logo, slogan, a line about the business, social profiles.
 * Kept apart from themes so switching theme never loses them.
 */

export const SOCIAL_PLATFORMS = ['instagram', 'facebook', 'x', 'youtube', 'tiktok', 'pinterest', 'linkedin', 'whatsapp', 'threads'] as const;
export type SocialPlatform = (typeof SOCIAL_PLATFORMS)[number];

interface BrandRow extends RowDataPacket {
  shop_id: number;
  slogan: string | null;
  short_description: string | null;
  logo_media_id: number | null;
  square_logo_media_id: number | null;
  social_links: unknown;
  updated_at: Date;
}

interface MediaRow extends RowDataPacket {
  id: number;
  storage_key: string;
  alt_text: string | null;
  width: number | null;
  height: number | null;
}

export interface BrandInput {
  slogan?: string | null;
  short_description?: string | null;
  logo_media_id?: number | null;
  square_logo_media_id?: number | null;
  social_links?: { platform: SocialPlatform; url: string }[];
}

function parseLinks(value: unknown): { platform: SocialPlatform; url: string }[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return Array.isArray(parsed) ? (parsed as { platform: SocialPlatform; url: string }[]) : [];
}

async function media(id: number | null): Promise<MediaRow | null> {
  if (!id) return null;
  return queryOne<MediaRow>(
    'SELECT id, storage_key, alt_text, width, height FROM media WHERE shop_id = ? AND id = ? AND deleted_at IS NULL LIMIT 1',
    [shopId(), id],
  );
}

function presentMedia(row: MediaRow | null) {
  return row ? { id: Number(row.id), url: storage.publicUrl(row.storage_key), alt: row.alt_text, width: row.width, height: row.height } : null;
}

type StorefrontBrand = Awaited<ReturnType<typeof presentForStorefront>>;

async function presentForStorefront() {
  const row = await queryOne<BrandRow>('SELECT * FROM shop_brand WHERE shop_id = ? LIMIT 1', [shopId()]);
  const [logo, square] = await Promise.all([media(row?.logo_media_id ?? null), media(row?.square_logo_media_id ?? null)]);
  return {
    slogan: row?.slogan ?? null,
    short_description: row?.short_description ?? null,
    logo: presentMedia(logo),
    square_logo: presentMedia(square),
    social_links: parseLinks(row?.social_links ?? null),
  };
}

/** What storefronts read on every page view: cached per shop, dropped on save. */
const storefrontCache = new ShopScopedCache<StorefrontBrand>(5 * 60_000);

export const brandService = {
  async get() {
    return { brand: await presentForStorefront(), platforms: SOCIAL_PLATFORMS };
  },

  /** For the storefront: the same shape, cached. */
  async storefront() {
    return storefrontCache.get('brand', presentForStorefront);
  },

  async update(input: BrandInput, actor: { id: number | null; label: string | null }) {
    for (const key of ['logo_media_id', 'square_logo_media_id'] as const) {
      const id = input[key];
      if (id && !(await media(id))) throw ApiError.validation({ [key]: ['Choose an image from this store’s media library.'] });
    }
    const current = await queryOne<BrandRow>('SELECT * FROM shop_brand WHERE shop_id = ? LIMIT 1', [shopId()]);
    const next = {
      slogan: input.slogan !== undefined ? input.slogan?.trim() || null : (current?.slogan ?? null),
      short_description: input.short_description !== undefined ? input.short_description?.trim() || null : (current?.short_description ?? null),
      logo_media_id: input.logo_media_id !== undefined ? input.logo_media_id : (current?.logo_media_id ?? null),
      square_logo_media_id: input.square_logo_media_id !== undefined ? input.square_logo_media_id : (current?.square_logo_media_id ?? null),
      social_links: input.social_links !== undefined ? input.social_links : parseLinks(current?.social_links ?? null),
    };
    await execute(
      `INSERT INTO shop_brand (shop_id, slogan, short_description, logo_media_id, square_logo_media_id, social_links, updated_by_admin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE slogan = VALUES(slogan), short_description = VALUES(short_description),
         logo_media_id = VALUES(logo_media_id), square_logo_media_id = VALUES(square_logo_media_id),
         social_links = VALUES(social_links), updated_by_admin_id = VALUES(updated_by_admin_id)`,
      [shopId(), next.slogan, next.short_description, next.logo_media_id, next.square_logo_media_id, JSON.stringify(next.social_links), actor.id],
    );
    storefrontCache.clear();
    await auditService.log({
      actorId: actor.id,
      actorLabel: actor.label,
      action: 'shop.brand_updated',
      entityType: 'shop',
      entityId: shopId(),
      summary: 'Updated brand',
      changes: { fields: Object.keys(input) },
    });
    return this.get();
  },
};
