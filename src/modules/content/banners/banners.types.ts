/**
 * Banners Module - TypeScript Type Definitions
 * 
 * Defines all types for the CMS Banners module following the database schema.
 * Banners support: announcement bars, hero carousels, promo strips, popups.
 */

export type BannerPlacement = 
  | 'announcement_bar'
  | 'home_hero'
  | 'home_carousel'
  | 'category_top'
  | 'pdp_strip'
  | 'cart_drawer'
  | 'checkout'
  | 'popup'
  | 'footer'

export type BannerAudience = 
  | 'all'
  | 'new_visitors'
  | 'returning'
  | 'logged_in'
  | 'guests'

export type LinkType =
  // A banner with no call to action at all. This is the column default and what
  // linkTypeSchema validates against, so it belongs in the union: without it the
  // "CTA label requires a link type other than none" guard is unreachable code.
  | 'none'
  | 'url'
  | 'page'
  | 'category'
  | 'collection'
  | 'product'
  | 'article'
  | 'none'

/**
 * Core Banner entity
 */
export interface Banner {
  id: number
  name: string
  placement: BannerPlacement
  title: string | null
  subtitle: string | null
  body: string | null
  cta_label: string | null
  cta_link_type: LinkType
  cta_link_ref_id: number | null
  cta_url: string | null
  desktop_media_id: number | null
  mobile_media_id: number | null
  poster_media_id: number | null
  background_hex: string | null
  text_hex: string | null
  audience: BannerAudience
  starts_at: Date | null
  ends_at: Date | null
  priority: number
  is_active: boolean
  is_dismissible: boolean
  impression_count: number
  click_count: number
  created_by_admin_id: number | null
  created_at: Date
  updated_at: Date
}

/**
 * Banner with populated relationships
 */
export interface BannerWithRelations extends Banner {
  creator?: {
    id: number
    name: string
    email: string
  } | null
  desktop_media?: {
    id: number
    url: string
    alt_text: string | null
    /** 'image' or 'video' — the desktop slot takes either. */
    media_type: string
    duration_ms: number | null
    size_bytes: number | null
    /** The still frame pulled out of a video on upload. Null for an image. */
    auto_poster_url: string | null
  } | null
  mobile_media?: {
    id: number
    url: string
    alt_text: string | null
    media_type: string
  } | null
  /** A poster chosen by hand, which wins over the auto-extracted frame. */
  poster_media?: {
    id: number
    url: string
    alt_text: string | null
  } | null
}

/**
 * Banner list item (for table views)
 */
export interface BannerListItem {
  id: number
  name: string
  placement: BannerPlacement
  title: string | null
  audience: BannerAudience
  starts_at: Date | null
  ends_at: Date | null
  priority: number
  is_active: boolean
  impression_count: number
  click_count: number
  ctr: number | null
  creator_name: string | null
  created_at: Date
  updated_at: Date
  status: 'scheduled' | 'active' | 'expired' | 'inactive'
}

/**
 * Banner filters for list queries
 */
export interface BannerFilters {
  search?: string
  placement?: BannerPlacement | BannerPlacement[]
  audience?: BannerAudience | BannerAudience[]
  is_active?: boolean
  status?: 'scheduled' | 'active' | 'expired' | 'inactive'
  creator_id?: number
  starts_after?: Date
  starts_before?: Date
  ends_after?: Date
  ends_before?: Date
}

/**
 * Pagination parameters
 */
export interface PaginationParams {
  page: number
  limit: number
  sort_by?: string
  sort_order?: 'asc' | 'desc'
}

/**
 * Paginated response
 */
export interface PaginatedResponse<T> {
  data: T[]
  pagination: {
    page: number
    limit: number
    total: number
    totalPages: number
    hasNext: boolean
    hasPrev: boolean
  }
}

/**
 * Create banner DTO
 */
export interface CreateBannerDto {
  name: string
  placement: BannerPlacement
  title?: string
  subtitle?: string
  body?: string
  cta_label?: string
  cta_link_type?: LinkType
  cta_link_ref_id?: number
  cta_url?: string
  desktop_media_id?: number
  mobile_media_id?: number
  poster_media_id?: number | null
  background_hex?: string
  text_hex?: string
  audience?: BannerAudience
  starts_at?: Date
  ends_at?: Date
  priority?: number
  is_active?: boolean
  is_dismissible?: boolean
}

/**
 * Update banner DTO
 */
export interface UpdateBannerDto {
  name?: string
  placement?: BannerPlacement
  title?: string
  subtitle?: string
  body?: string
  cta_label?: string
  cta_link_type?: LinkType
  cta_link_ref_id?: number
  cta_url?: string
  desktop_media_id?: number
  mobile_media_id?: number
  poster_media_id?: number | null
  background_hex?: string
  text_hex?: string
  audience?: BannerAudience
  starts_at?: Date
  ends_at?: Date
  priority?: number
  is_active?: boolean
  is_dismissible?: boolean
}

/**
 * Banner stats DTO
 */
export interface BannerStatsDto {
  banner_id: number
  impressions?: number
  clicks?: number
}

/**
 * Placement labels
 */
export const PLACEMENT_LABELS: Record<BannerPlacement, string> = {
  announcement_bar: 'Announcement Bar',
  home_hero: 'Home Hero',
  home_carousel: 'Home Carousel',
  category_top: 'Category Top',
  pdp_strip: 'Product Page Strip',
  cart_drawer: 'Cart Drawer',
  checkout: 'Checkout',
  popup: 'Popup',
  footer: 'Footer',
}

/**
 * Audience labels
 */
export const AUDIENCE_LABELS: Record<BannerAudience, string> = {
  all: 'All Visitors',
  new_visitors: 'New Visitors',
  returning: 'Returning Visitors',
  logged_in: 'Logged In Users',
  guests: 'Guest Users',
}

/**
 * Link type labels
 */
export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  none: 'No Link',
  url: 'URL',
  page: 'Page',
  category: 'Category',
  collection: 'Collection',
  product: 'Product',
  article: 'Article',
}

/**
 * Status colors for UI
 */
export const STATUS_COLORS: Record<string, string> = {
  scheduled: '#1976D2',
  active: '#2E7D32',
  expired: '#757575',
  inactive: '#616161',
}
