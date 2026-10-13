import type { RowDataPacket } from '../../../db/pool';

export interface SectionRow extends RowDataPacket {
  id: number;
  section_key: string;
  name: string;
  heading: string | null;
  standfirst: string | null;
  footnote: string | null;
  layout: string;
  background: string | null;
  padding_top: string;
  padding_bottom: string;
  settings: unknown;
  created_at: Date;
  updated_at: Date;
  /** How many products and pages this section is attached to. */
  usage_count: number;
}

export interface BlockRow extends RowDataPacket {
  id: number;
  section_id: number;
  block_type: string;
  sort_order: number;
  is_enabled: number;
  heading: string | null;
  body: string | null;
  media_id: number | null;
  media_key: string | null;
  media_alt: string | null;
  media_type: string | null;
  media_poster_key: string | null;
  secondary_media_id: number | null;
  secondary_media_key: string | null;
  creator_id: number | null;
  /** Carry the credit on this particular use. */
  credit_creator?: boolean;
  creator_name: string | null;
  creator_handle: string | null;
  creator_role: string | null;
  creator_portrait_key: string | null;
  creator_portrait_alt: string | null;
  creator_instagram_url: string | null;
  claim_id: number | null;
  claim_text: string | null;
  claim_footnote: string | null;
  claim_status: string | null;
  option_value_id: number | null;
  option_value_label: string | null;
  option_value_descriptor: string | null;
  option_value_hex: string | null;
  link_type: string;
  link_ref_id: number | null;
  link_url: string | null;
  cta_label: string | null;
  settings: unknown;
}

export interface HotspotRow extends RowDataPacket {
  id: number;
  block_id: number;
  x_pct: string;
  y_pct: string;
  label: string;
  body: string | null;
  product_id: number | null;
  product_slug: string | null;
  product_name: string | null;
  media_id: number | null;
  media_key: string | null;
  line_direction: string;
  sort_order: number;
}

export interface AssignmentRow extends RowDataPacket {
  id: number;
  section_id: number;
  owner_type: string;
  owner_id: number;
  sort_order: number;
  is_enabled: number;
  visible_from: Date | null;
  visible_until: Date | null;
}

export interface SectionInput {
  section_key?: string;
  name?: string;
  heading?: string | null;
  standfirst?: string | null;
  footnote?: string | null;
  layout?: string;
  background?: string | null;
  padding_top?: string;
  padding_bottom?: string;
  settings?: Record<string, unknown> | null;
}

export interface BlockInput {
  block_type?: string;
  sort_order?: number;
  is_enabled?: boolean;
  heading?: string | null;
  body?: string | null;
  media_id?: number | null;
  secondary_media_id?: number | null;
  creator_id?: number | null;
  credit_creator?: boolean;
  claim_id?: number | null;
  option_value_id?: number | null;
  link_type?: string;
  link_ref_id?: number | null;
  link_url?: string | null;
  cta_label?: string | null;
  settings?: Record<string, unknown> | null;
}

export interface HotspotInput {
  x_pct: number;
  y_pct: number;
  label: string;
  body?: string | null;
  product_id?: number | null;
  media_id?: number | null;
  line_direction?: string;
}
