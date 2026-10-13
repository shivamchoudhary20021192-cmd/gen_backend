/**
 * TypeScript types for FAQs module
 * Handles both FAQ Groups and individual FAQs
 */

// ── FAQ Group Types ──────────────────────────────────────────────────────────

export interface FAQGroup {
  id: number
  slug: string
  name: string
  description: string | null
  sort_order: number
  is_active: boolean
}

export interface FAQGroupListItem extends FAQGroup {
  faq_count: number
}

export interface CreateFAQGroupDto {
  slug: string
  name: string
  description?: string
  sort_order?: number
  is_active?: boolean
}

export interface UpdateFAQGroupDto {
  slug?: string
  name?: string
  description?: string
  sort_order?: number
  is_active?: boolean
}

// ── FAQ Types ────────────────────────────────────────────────────────────────

export interface FAQ {
  id: number
  group_id: number | null
  entity_type: string | null
  entity_id: number | null
  question: string
  answer: string
  claim_id: number | null
  sort_order: number
  is_published: boolean
  is_indexable: boolean
  helpful_count: number
  created_at: string
  updated_at: string
}

export interface FAQListItem extends FAQ {
  group_name: string | null
  group_slug: string | null
}

export interface FAQWithRelations extends FAQ {
  group: {
    id: number
    name: string
    slug: string
  } | null
}

export interface CreateFAQDto {
  group_id?: number
  entity_type?: string
  entity_id?: number
  question: string
  answer: string
  claim_id?: number
  sort_order?: number
  is_published?: boolean
  is_indexable?: boolean
}

export interface UpdateFAQDto {
  group_id?: number
  entity_type?: string
  entity_id?: number
  question?: string
  answer?: string
  claim_id?: number
  sort_order?: number
  is_published?: boolean
  is_indexable?: boolean
}

// ── Query Parameters ─────────────────────────────────────────────────────────

export interface ListFAQsParams {
  page?: number
  limit?: number
  sort_by?: 'question' | 'group_id' | 'sort_order' | 'helpful_count' | 'created_at' | 'updated_at'
  sort_order?: 'asc' | 'desc'
  search?: string
  group_id?: number
  entity_type?: string
  entity_id?: number
  is_published?: boolean
  is_indexable?: boolean
}

export interface ListFAQGroupsParams {
  page?: number
  limit?: number
  sort_by?: 'name' | 'sort_order' | 'created_at'
  sort_order?: 'asc' | 'desc'
  search?: string
  is_active?: boolean
}

// ── Label Mappings ───────────────────────────────────────────────────────────

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  product: 'Product',
  cms_page: 'Page',
  collection: 'Collection',
  category: 'Category',
  article: 'Article',
}
