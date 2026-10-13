/**
 * Banners Service
 * 
 * Business logic layer for CMS Banners.
 * Handles validation, date range logic, audience targeting, and orchestration.
 */

import { bannersRepository } from './banners.repository'
import { ApiError } from '../../../core/ApiError'
import type {
  BannerWithRelations,
  BannerListItem,
  BannerFilters,
  PaginationParams,
  PaginatedResponse,
  CreateBannerDto,
  UpdateBannerDto,
  BannerStatsDto,
} from './banners.types'

export const bannersService = {
  /**
   * Get paginated list of banners
   */
  async list(
    filters: BannerFilters = {},
    pagination: PaginationParams
  ): Promise<PaginatedResponse<BannerListItem>> {
    return bannersRepository.list(filters, pagination)
  },

  /**
   * Get single banner by ID
   */
  async getById(id: number): Promise<BannerWithRelations> {
    const banner = await bannersRepository.getById(id)

    if (!banner) {
      throw new ApiError(404, 'NOT_FOUND', 'Banner not found')
    }

    return banner
  },

  /**
   * Create new banner
   */
  async create(data: CreateBannerDto, adminId: number): Promise<BannerWithRelations> {
    // Validate date range
    if (data.starts_at && data.ends_at) {
      if (new Date(data.ends_at) <= new Date(data.starts_at)) {
        throw new ApiError(400, 'INVALID_DATE_RANGE', 'End date must be after start date')
      }
    }

    // Validate CTA configuration
    if (data.cta_label) {
      if (data.cta_link_type === 'none') {
        throw new ApiError(400, 'INVALID_CTA', 'CTA label requires a link type other than "none"')
      }

      if (data.cta_link_type === 'url' && !data.cta_url) {
        throw new ApiError(400, 'INVALID_CTA', 'CTA link type "url" requires cta_url')
      }

      // 'none' was rejected by the guard above, so this only has to separate
      // 'url' (which needs cta_url) from the reference types (which need an id).
      if (data.cta_link_type !== 'url' && !data.cta_link_ref_id) {
        throw new ApiError(400, 'INVALID_CTA', `CTA link type "${data.cta_link_type}" requires cta_link_ref_id`)
      }
    }

    // Validate color hex codes
    if (data.background_hex && !this.isValidHexColor(data.background_hex)) {
      throw new ApiError(400, 'INVALID_COLOR', 'Invalid background_hex color format. Use #RRGGBB format')
    }

    if (data.text_hex && !this.isValidHexColor(data.text_hex)) {
      throw new ApiError(400, 'INVALID_COLOR', 'Invalid text_hex color format. Use #RRGGBB format')
    }

    // Create banner
    const bannerId = await bannersRepository.create(data, adminId)

    // Return created banner
    return this.getById(bannerId)
  },

  /**
   * Update existing banner
   */
  async update(id: number, data: UpdateBannerDto): Promise<BannerWithRelations> {
    // Check banner exists
    const existingBanner = await this.getById(id)

    // Validate date range if both dates are being updated
    const starts_at = data.starts_at !== undefined ? data.starts_at : existingBanner.starts_at
    const ends_at = data.ends_at !== undefined ? data.ends_at : existingBanner.ends_at

    if (starts_at && ends_at) {
      if (new Date(ends_at) <= new Date(starts_at)) {
        throw new ApiError(400, 'INVALID_DATE_RANGE', 'End date must be after start date')
      }
    }

    // Validate CTA configuration
    const cta_label = data.cta_label !== undefined ? data.cta_label : existingBanner.cta_label
    const cta_link_type = data.cta_link_type !== undefined ? data.cta_link_type : existingBanner.cta_link_type
    const cta_url = data.cta_url !== undefined ? data.cta_url : existingBanner.cta_url
    const cta_link_ref_id = data.cta_link_ref_id !== undefined ? data.cta_link_ref_id : existingBanner.cta_link_ref_id

    if (cta_label) {
      if (cta_link_type === 'none') {
        throw new ApiError(400, 'INVALID_CTA', 'CTA label requires a link type other than "none"')
      }

      if (cta_link_type === 'url' && !cta_url) {
        throw new ApiError(400, 'INVALID_CTA', 'CTA link type "url" requires cta_url')
      }

      // Same as create: 'none' is already out of the picture here.
      if (cta_link_type !== 'url' && !cta_link_ref_id) {
        throw new ApiError(400, 'INVALID_CTA', `CTA link type "${cta_link_type}" requires cta_link_ref_id`)
      }
    }

    // Validate color hex codes
    if (data.background_hex && !this.isValidHexColor(data.background_hex)) {
      throw new ApiError(400, 'INVALID_COLOR', 'Invalid background_hex color format. Use #RRGGBB format')
    }

    if (data.text_hex && !this.isValidHexColor(data.text_hex)) {
      throw new ApiError(400, 'INVALID_COLOR', 'Invalid text_hex color format. Use #RRGGBB format')
    }

    // Update banner
    const updated = await bannersRepository.update(id, data)

    if (!updated) {
      throw new ApiError(404, 'NOT_FOUND', 'Banner not found')
    }

    // Return updated banner
    return this.getById(id)
  },

  /**
   * Delete banner
   */
  async delete(id: number): Promise<void> {
    const banner = await this.getById(id)

    // Don't allow deletion of active banners
    if (banner.is_active) {
      throw new ApiError(400, 'INVALID_OPERATION', 'Cannot delete active banner. Deactivate it first.')
    }

    const deleted = await bannersRepository.delete(id)

    if (!deleted) {
      throw new ApiError(404, 'NOT_FOUND', 'Banner not found')
    }
  },

  /**
   * Activate banner
   */
  async activate(id: number): Promise<BannerWithRelations> {
    await this.getById(id) // Check exists

    await bannersRepository.update(id, { is_active: true })

    return this.getById(id)
  },

  /**
   * Deactivate banner
   */
  async deactivate(id: number): Promise<BannerWithRelations> {
    await this.getById(id) // Check exists

    await bannersRepository.update(id, { is_active: false })

    return this.getById(id)
  },

  /**
   * Duplicate banner
   */
  async duplicate(id: number, adminId: number): Promise<BannerWithRelations> {
    const original = await this.getById(id)

    // Create duplicate with modified name and inactive status
    const duplicateData: CreateBannerDto = {
      name: `${original.name} (Copy)`,
      placement: original.placement,
      title: original.title || undefined,
      subtitle: original.subtitle || undefined,
      body: original.body || undefined,
      cta_label: original.cta_label || undefined,
      cta_link_type: original.cta_link_type,
      cta_link_ref_id: original.cta_link_ref_id || undefined,
      cta_url: original.cta_url || undefined,
      desktop_media_id: original.desktop_media_id || undefined,
      mobile_media_id: original.mobile_media_id || undefined,
      background_hex: original.background_hex || undefined,
      text_hex: original.text_hex || undefined,
      audience: original.audience,
      starts_at: original.starts_at || undefined,
      ends_at: original.ends_at || undefined,
      priority: original.priority,
      is_active: false, // Duplicate starts inactive
      is_dismissible: original.is_dismissible,
    }

    const newBannerId = await bannersRepository.create(duplicateData, adminId)

    return this.getById(newBannerId)
  },

  /**
   * Update banner stats
   */
  async updateStats(id: number, stats: BannerStatsDto): Promise<void> {
    // Verify banner exists
    await this.getById(id)

    if (stats.impressions && stats.impressions > 0) {
      await bannersRepository.incrementImpressions(id, stats.impressions)
    }

    if (stats.clicks && stats.clicks > 0) {
      await bannersRepository.incrementClicks(id, stats.clicks)
    }
  },

  /**
   * Track impression (called by storefront)
   */
  async trackImpression(id: number): Promise<void> {
    await bannersRepository.incrementImpressions(id, 1)
  },

  /**
   * Track click (called by storefront)
   */
  async trackClick(id: number): Promise<void> {
    await bannersRepository.incrementClicks(id, 1)
  },

  /**
   * Get active banners for placement
   * Used by storefront to fetch banners to display
   */
  async getActiveByPlacement(placement: string, audience: string = 'all'): Promise<BannerWithRelations[]> {
    const banners = await bannersRepository.getActiveByPlacement(placement, audience)

    // Enrich with full data (though storefront might not need all fields)
    const enrichedBanners = await Promise.all(
      banners.map(banner => this.getById(banner.id))
    )

    return enrichedBanners
  },

  /**
   * Bulk activate banners
   */
  async bulkActivate(ids: number[]): Promise<number> {
    if (ids.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'At least one banner ID required')
    }

    return bannersRepository.bulkUpdateStatus(ids, true)
  },

  /**
   * Bulk deactivate banners
   */
  async bulkDeactivate(ids: number[]): Promise<number> {
    if (ids.length === 0) {
      throw new ApiError(400, 'BAD_REQUEST', 'At least one banner ID required')
    }

    return bannersRepository.bulkUpdateStatus(ids, false)
  },

  /**
   * Helper: Validate hex color format
   */
  isValidHexColor(hex: string): boolean {
    return /^#[0-9A-F]{6}$/i.test(hex)
  },

  /**
   * Get banner statistics summary
   */
  async getStatsSummary(filters: BannerFilters = {}): Promise<{
    total_banners: number
    active_banners: number
    total_impressions: number
    total_clicks: number
    average_ctr: number
  }> {
    // Get all banners matching filters
    const result = await bannersRepository.list(filters, { page: 1, limit: 1000 })

    const total_banners = result.pagination.total
    const active_banners = result.data.filter(b => b.status === 'active').length
    const total_impressions = result.data.reduce((sum, b) => sum + b.impression_count, 0)
    const total_clicks = result.data.reduce((sum, b) => sum + b.click_count, 0)
    const average_ctr = total_impressions > 0 ? (total_clicks / total_impressions) * 100 : 0

    return {
      total_banners,
      active_banners,
      total_impressions,
      total_clicks,
      average_ctr: Math.round(average_ctr * 100) / 100,
    }
  },
}
