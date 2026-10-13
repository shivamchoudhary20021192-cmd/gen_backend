/**
 * Shared Content Module Types
 * 
 * Common types used across all content modules (pages, articles, banners, etc.)
 */

/**
 * Generic status type used across content entities
 */
export type ContentStatus = 
  | 'draft'
  | 'in_review'
  | 'scheduled'
  | 'published'
  | 'archived'

/**
 * Entity types for polymorphic relationships
 */
export type EntityType = 
  | 'page'
  | 'article'
  | 'product'
  | 'banner'
  | 'menu'
  | 'entry'
  | 'ingredient'

/**
 * Link types for navigation and CTAs
 */
export type LinkType = 
  | 'none'
  | 'url'
  | 'page'
  | 'category'
  | 'collection'
  | 'product'
  | 'article'
  | 'policy'
  | 'ingredient'
  | 'routine'

/**
 * Revision snapshot for version control
 */
export interface Revision {
  id: number
  entityType: EntityType
  entityId: number
  version: number
  snapshot: any
  changeNote: string | null
  isPublishedVersion: boolean
  createdByAdminId: number | null
  createdAt: Date
}

/**
 * SEO metadata (polymorphic)
 */
export interface SEOMeta {
  id: number
  entityType: string
  entityId: number
  locale: string
  metaTitle: string | null
  metaDescription: string | null
  h1Override: string | null
  canonicalUrl: string | null
  ogTitle: string | null
  ogDescription: string | null
  ogMediaId: number | null
  twitterCard: 'summary' | 'summary_large_image'
  robotsIndex: boolean
  robotsFollow: boolean
  structuredData: any | null
  sitemapPriority: number | null
  sitemapChangefreq: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never' | null
  updatedByAdminId: number | null
  updatedAt: Date
}

/**
 * Create/Update SEO DTO
 */
export interface SEOMetaDto {
  metaTitle?: string
  metaDescription?: string
  h1Override?: string
  canonicalUrl?: string
  ogTitle?: string
  ogDescription?: string
  ogMediaId?: number
  twitterCard?: 'summary' | 'summary_large_image'
  robotsIndex?: boolean
  robotsFollow?: boolean
  structuredData?: any
  sitemapPriority?: number
  sitemapChangefreq?: 'always' | 'hourly' | 'daily' | 'weekly' | 'monthly' | 'yearly' | 'never'
}

/**
 * Admin user reference (for author, reviewer fields)
 */
export interface AdminUserRef {
  id: number
  name: string
  email: string
}

/**
 * Media reference (for images, videos)
 */
export interface MediaRef {
  id: number
  storageKey: string
  url: string
  altText: string | null
  mimeType: string
  fileSize: number
}

/**
 * Audit fields (common across entities)
 */
export interface AuditFields {
  createdAt: Date
  updatedAt: Date
  deletedAt: Date | null
}

/**
 * Publishing fields (common across entities)
 */
export interface PublishingFields {
  status: ContentStatus
  publishedAt: Date | null
  scheduledAt: Date | null
  unpublishAt: Date | null
}

/**
 * Preview token for sharing unpublished content
 */
export interface PreviewToken {
  token: string
  entityType: EntityType
  entityId: number
  expiresAt: Date
}
