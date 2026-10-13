/**
 * Banners Controller
 * 
 * HTTP request handlers for CMS Banners endpoints.
 * Handles validation, authentication, and response formatting.
 */

import type { Request, Response } from 'express'
import { bannersService } from './banners.service'
import { asyncHandler } from '../../../core/asyncHandler'
import type { AuthRequest } from '../../../middleware/authenticate'
import type { BannerFilters } from './banners.types'

/**
 * List banners with filters and pagination
 * GET /admin/api/v1/content/banners
 */
export const list = asyncHandler(async (req: Request, res: Response) => {
  // `validate({ query: listBannersQuerySchema })` has already parsed and coerced
  // these, so the cast names the domain type rather than the raw string that
  // arrived on the wire.
  const filters: BannerFilters = {
    search: req.query.search as string | undefined,
    placement: req.query.placement as BannerFilters['placement'],
    audience: req.query.audience as BannerFilters['audience'],
    is_active: req.query.is_active ? req.query.is_active === 'true' : undefined,
    status: req.query.status as 'scheduled' | 'active' | 'expired' | 'inactive' | undefined,
    creator_id: req.query.creator_id ? Number(req.query.creator_id) : undefined,
    starts_after: req.query.starts_after ? new Date(req.query.starts_after as string) : undefined,
    starts_before: req.query.starts_before ? new Date(req.query.starts_before as string) : undefined,
    ends_after: req.query.ends_after ? new Date(req.query.ends_after as string) : undefined,
    ends_before: req.query.ends_before ? new Date(req.query.ends_before as string) : undefined,
  }

  const pagination = {
    page: Number(req.query.page) || 1,
    limit: Number(req.query.limit) || 20,
    sort_by: (req.query.sort_by as string) || 'priority',
    sort_order: (req.query.sort_order as 'asc' | 'desc') || 'desc',
  }

  const result = await bannersService.list(filters, pagination)

  res.json({
    success: true,
    data: result.data,
    pagination: result.pagination,
  })
})

/**
 * Get banner by ID
 * GET /admin/api/v1/content/banners/:id
 */
export const getById = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const banner = await bannersService.getById(id)

  res.json({
    success: true,
    data: banner,
  })
})

/**
 * Create new banner
 * POST /admin/api/v1/content/banners
 */
export const create = asyncHandler(async (req: AuthRequest, res: Response) => {
  const adminId = req.admin!.id
  const data = req.body

  // Convert date strings to Date objects
  if (data.starts_at) data.starts_at = new Date(data.starts_at)
  if (data.ends_at) data.ends_at = new Date(data.ends_at)

  const banner = await bannersService.create(data, adminId)

  res.status(201).json({
    success: true,
    data: banner,
    message: 'Banner created successfully',
  })
})

/**
 * Update banner
 * PUT /admin/api/v1/content/banners/:id
 */
export const update = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const data = req.body

  // Convert date strings to Date objects
  if (data.starts_at) data.starts_at = new Date(data.starts_at)
  if (data.ends_at) data.ends_at = new Date(data.ends_at)

  const banner = await bannersService.update(id, data)

  res.json({
    success: true,
    data: banner,
    message: 'Banner updated successfully',
  })
})

/**
 * Delete banner
 * DELETE /admin/api/v1/content/banners/:id
 */
export const deleteBanner = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  await bannersService.delete(id)

  res.json({
    success: true,
    message: 'Banner deleted successfully',
  })
})

/**
 * Activate banner
 * POST /admin/api/v1/content/banners/:id/activate
 */
export const activate = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const banner = await bannersService.activate(id)

  res.json({
    success: true,
    data: banner,
    message: 'Banner activated successfully',
  })
})

/**
 * Deactivate banner
 * POST /admin/api/v1/content/banners/:id/deactivate
 */
export const deactivate = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const banner = await bannersService.deactivate(id)

  res.json({
    success: true,
    data: banner,
    message: 'Banner deactivated successfully',
  })
})

/**
 * Duplicate banner
 * POST /admin/api/v1/content/banners/:id/duplicate
 */
export const duplicate = asyncHandler(async (req: AuthRequest, res: Response) => {
  const id = Number(req.params.id)
  const adminId = req.admin!.id
  const banner = await bannersService.duplicate(id, adminId)

  res.status(201).json({
    success: true,
    data: banner,
    message: 'Banner duplicated successfully',
  })
})

/**
 * Update banner stats (impressions/clicks)
 * POST /admin/api/v1/content/banners/:id/stats
 */
export const updateStats = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  const stats = req.body

  await bannersService.updateStats(id, stats)

  res.json({
    success: true,
    message: 'Banner stats updated successfully',
  })
})

/**
 * Track impression
 * POST /admin/api/v1/content/banners/:id/track/impression
 */
export const trackImpression = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  await bannersService.trackImpression(id)

  res.json({
    success: true,
    message: 'Impression tracked',
  })
})

/**
 * Track click
 * POST /admin/api/v1/content/banners/:id/track/click
 */
export const trackClick = asyncHandler(async (req: Request, res: Response) => {
  const id = Number(req.params.id)
  await bannersService.trackClick(id)

  res.json({
    success: true,
    message: 'Click tracked',
  })
})

/**
 * Get active banners by placement (for storefront)
 * GET /admin/api/v1/content/banners/placement/:placement
 */
export const getByPlacement = asyncHandler(async (req: Request, res: Response) => {
  const placement = req.params.placement
  const audience = (req.query.audience as string) || 'all'

  const banners = await bannersService.getActiveByPlacement(placement, audience)

  res.json({
    success: true,
    data: banners,
  })
})

/**
 * Bulk activate banners
 * POST /admin/api/v1/content/banners/bulk-activate
 */
export const bulkActivate = asyncHandler(async (req: Request, res: Response) => {
  const { ids } = req.body
  const count = await bannersService.bulkActivate(ids)

  res.json({
    success: true,
    data: { updated_count: count },
    message: `${count} banner(s) activated successfully`,
  })
})

/**
 * Bulk deactivate banners
 * POST /admin/api/v1/content/banners/bulk-deactivate
 */
export const bulkDeactivate = asyncHandler(async (req: Request, res: Response) => {
  const { ids } = req.body
  const count = await bannersService.bulkDeactivate(ids)

  res.json({
    success: true,
    data: { updated_count: count },
    message: `${count} banner(s) deactivated successfully`,
  })
})

/**
 * Get banner statistics summary
 * GET /admin/api/v1/content/banners/stats/summary
 */
export const getStatsSummary = asyncHandler(async (req: Request, res: Response) => {
  const filters: BannerFilters = {
    placement: req.query.placement as BannerFilters['placement'],
    audience: req.query.audience as BannerFilters['audience'],
    is_active: req.query.is_active ? req.query.is_active === 'true' : undefined,
  }

  const stats = await bannersService.getStatsSummary(filters)

  res.json({
    success: true,
    data: stats,
  })
})
