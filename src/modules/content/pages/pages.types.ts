/**
 * Pages Module - TypeScript Type Definitions
 * 
 * Defines all types for the CMS Pages module following the database schema.
 */

export type PageType = 
  | 'home'
  | 'standard'
  | 'landing'
  | 'policy'
  | 'about'
  | 'support'
  | 'concern'
  | 'ingredient_library'
  | 'custom'

export type PageStatus = 
  | 'draft'
  | 'in_review'
  | 'scheduled'
  | 'published'
  | 'archived'

export type SectionPadding = 'none' | 'sm' | 'md' | 'lg' | 'xl'

export type BlockLinkType = 
  | 'none'
  | 'url'
  | 'page'
  | 'product'
  | 'collection'
  | 'category'
  | 'article'

/**
 * Core Page entity
 */
export interface Page {
  id: number
  public_id: string
  parent_id: number | null
  slug: string
  full_path: string
  title: string
  subtitle: string | null
  page_type: PageType
  template: string
  locale: string
  body_html: string | null
  body_json: any | null
  hero_media_id: number | null
  status: PageStatus
  published_at: Date | null
  scheduled_at: Date | null
  unpublish_at: Date | null
  requires_legal_review: boolean
  reviewed_by_admin_id: number | null
  reviewed_at: Date | null
  review_due_at: Date | null
  is_indexable: boolean
  show_in_sitemap: boolean
  preview_token: string | null
  current_version: number
  view_count: number
  author_admin_id: number | null
  updated_by_admin_id: number | null
  created_at: Date
  updated_at: Date
  deleted_at: Date | null
}

/**
 * Page Section (modular content blocks)
 */
export interface PageSection {
  id: number
  page_id: number
  section_key: string
  name: string | null
  sort_order: number
  is_enabled: boolean
  settings: any | null
  background: string | null
  padding_top: SectionPadding
  padding_bottom: SectionPadding
  visible_from: Date | null
  visible_until: Date | null
  created_at: Date
  updated_at: Date
}

/**
 * Section Block (repeatable items within sections)
 */
export interface SectionBlock {
  id: number
  section_id: number
  block_type: string
  sort_order: number
  is_enabled: boolean
  heading: string | null
  body: string | null
  media_id: number | null
  link_type: BlockLinkType
  link_ref_id: number | null
  link_url: string | null
  cta_label: string | null
  claim_id: number | null
  settings: any | null
  created_at: Date
  updated_at: Date
}

/**
 * Page with populated relationships
 */
export interface PageWithRelations extends Page {
  sections?: PageSection[]
  author?: {
    id: number
    name: string
    email: string
  } | null
  reviewer?: {
    id: number
    name: string
    email: string
  } | null
  hero_media?: {
    id: number
    storage_key: string
    url: string
    alt_text: string | null
  } | null
}

/**
 * Page list item (for table views)
 */
export interface PageListItem {
  id: number
  public_id: string
  slug: string
  full_path: string
  title: string
  page_type: PageType
  status: PageStatus
  published_at: Date | null
  scheduled_at: Date | null
  view_count: number
  author_name: string | null
  updated_at: Date
  section_count: number
}

/**
 * Page filters for list queries
 */
export interface PageFilters {
  search?: string
  status?: PageStatus | PageStatus[]
  page_type?: PageType | PageType[]
  author_id?: number
  requires_legal_review?: boolean
  is_indexable?: boolean
  created_after?: Date
  created_before?: Date
  published_after?: Date
  published_before?: Date
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
 * Create page DTO
 */
export interface CreatePageDto {
  slug: string
  title: string
  subtitle?: string
  page_type: PageType
  template?: string
  locale?: string
  body_html?: string
  body_json?: any
  hero_media_id?: number
  status?: PageStatus
  scheduled_at?: Date
  unpublish_at?: Date
  requires_legal_review?: boolean
  review_due_at?: Date
  is_indexable?: boolean
  show_in_sitemap?: boolean
  parent_id?: number
}

/**
 * Update page DTO
 */
export interface UpdatePageDto {
  slug?: string
  title?: string
  subtitle?: string
  page_type?: PageType
  template?: string
  body_html?: string
  body_json?: any
  hero_media_id?: number
  status?: PageStatus
  published_at?: Date
  scheduled_at?: Date
  unpublish_at?: Date
  requires_legal_review?: boolean
  reviewed_by_admin_id?: number
  reviewed_at?: Date
  review_due_at?: Date
  is_indexable?: boolean
  show_in_sitemap?: boolean
  parent_id?: number
}

/**
 * Create section DTO
 */
export interface CreateSectionDto {
  section_key: string
  name?: string
  sort_order?: number
  is_enabled?: boolean
  settings?: any
  background?: string
  padding_top?: SectionPadding
  padding_bottom?: SectionPadding
  visible_from?: Date
  visible_until?: Date
}

/**
 * Update section DTO
 */
export interface UpdateSectionDto {
  section_key?: string
  name?: string
  sort_order?: number
  is_enabled?: boolean
  settings?: any
  background?: string
  padding_top?: SectionPadding
  padding_bottom?: SectionPadding
  visible_from?: Date
  visible_until?: Date
}

/**
 * Publish page DTO
 */
export interface PublishPageDto {
  scheduled_at?: Date
  unpublish_at?: Date
}

/**
 * Page status transition validation
 */
export const PAGE_STATUS_TRANSITIONS: Record<PageStatus, PageStatus[]> = {
  draft: ['in_review', 'published', 'archived'],
  in_review: ['draft', 'published', 'archived'],
  scheduled: ['draft', 'published', 'archived'],
  published: ['draft', 'archived'],
  archived: ['draft'],
}

/**
 * Available section types (from schema)
 */
export const SECTION_TYPES = [
  'announcement_bar',
  'hero',
  'trust_strip',
  'two_product_routine',
  'ingredient_story',
  'texture_proof',
  'evidence_results',
  'reviews_ugc',
  'education_articles',
  'founder_note',
  'optin',
  'faq',
  'rich_text',
  'image_with_text',
  'product_grid',
  'collection_banner',
  'comparison_table',
  'support_panel',
] as const

export type SectionType = typeof SECTION_TYPES[number]

/**
 * Available block types
 */
export const BLOCK_TYPES = [
  'claim_tile',
  'ingredient_card',
  'slide',
  'step',
  'faq_item',
] as const

export type BlockType = typeof BLOCK_TYPES[number]
