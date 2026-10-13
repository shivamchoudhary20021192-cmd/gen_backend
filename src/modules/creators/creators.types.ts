import type { RowDataPacket } from '../../db/pool';

export interface CreatorRow extends RowDataPacket {
  id: number;
  public_id: string;
  slug: string;
  name: string;
  handle: string | null;
  role: string | null;
  bio: string | null;
  portrait_media_id: number | null;
  portrait_key: string | null;
  portrait_alt: string | null;
  instagram_url: string | null;
  youtube_url: string | null;
  tiktok_url: string | null;
  website_url: string | null;
  is_active: number;
  is_identity_public: number;
  sort_order: number;
  /** How many story blocks feature this person — the delete guard reads it. */
  block_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface CreatorInput {
  name?: string;
  slug?: string;
  handle?: string | null;
  role?: string | null;
  bio?: string | null;
  portrait_media_id?: number | null;
  instagram_url?: string | null;
  youtube_url?: string | null;
  tiktok_url?: string | null;
  website_url?: string | null;
  is_active?: boolean;
  is_identity_public?: boolean;
  sort_order?: number;
}
