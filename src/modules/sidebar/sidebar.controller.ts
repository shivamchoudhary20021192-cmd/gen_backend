import type { Response } from 'express'
import type { AuthRequest } from '../../middleware/authenticate'
import { asyncHandler } from '../../core/asyncHandler'
import { sidebarService } from './sidebar.service'

export const sidebarController = {
  /**
   * GET /api/v1/sidebar/menu
   * Get complete menu tree for current user
   */
  getMenu: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const isSuperAdmin = req.admin.isSuperAdmin
    

    const menuTree = await sidebarService.getMenuTree(userId, isSuperAdmin)

    res.json({
      menu: menuTree.items,
      sections: menuTree.sections,
      preferences: menuTree.preferences,
    })
  }),

  /**
   * GET /api/v1/sidebar/menu/collapsed
   * Get mini/icon-only menu items
   */
  getCollapsedMenu: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const isSuperAdmin = req.admin.isSuperAdmin

    const items = await sidebarService.getCollapsedMenu(userId, isSuperAdmin)

    res.json({ items })
  }),

  /**
   * GET /api/v1/sidebar/preferences
   * Get user's sidebar preferences
   */
  getPreferences: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const preferences = await sidebarService.updatePreferences(userId, {})

    res.json({ preferences })
  }),

  /**
   * PATCH /api/v1/sidebar/preferences
   * Update user's sidebar preferences
   */
  updatePreferences: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const updates = req.body

    const preferences = await sidebarService.updatePreferences(userId, updates)

    res.json({ preferences })
  }),

  /**
   * POST /api/v1/sidebar/toggle-pin
   * Toggle sidebar pin state
   */
  togglePin: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const result = await sidebarService.togglePin(userId)

    res.json(result)
  }),

  /**
   * POST /api/v1/sidebar/toggle-collapse
   * Toggle sidebar collapsed state
   */
  toggleCollapse: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const result = await sidebarService.toggleCollapse(userId)

    res.json(result)
  }),

  /**
   * POST /api/v1/sidebar/pin-item
   * Pin a menu item
   */
  pinItem: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const { menu_item_id } = req.body

    await sidebarService.pinItem(userId, menu_item_id)

    res.json({ success: true, message: 'Item pinned' })
  }),

  /**
   * POST /api/v1/sidebar/unpin-item
   * Unpin a menu item
   */
  unpinItem: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const { menu_item_id } = req.body

    await sidebarService.unpinItem(userId, menu_item_id)

    res.json({ success: true, message: 'Item unpinned' })
  }),

  /**
   * POST /api/v1/sidebar/favorite
   * Add item to favorites
   */
  addFavorite: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const { menu_item_id } = req.body

    await sidebarService.addFavorite(userId, menu_item_id)

    res.json({ success: true, message: 'Added to favorites' })
  }),

  /**
   * DELETE /api/v1/sidebar/favorite/:id
   * Remove item from favorites
   */
  removeFavorite: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const menuItemId = Number(req.params.id)

    await sidebarService.removeFavorite(userId, menuItemId)

    res.json({ success: true, message: 'Removed from favorites' })
  }),

  /**
   * POST /api/v1/sidebar/track-click
   * Track menu item click for analytics
   */
  trackClick: asyncHandler(async (req: AuthRequest, res: Response) => {
    const userId = req.admin.id
    const { menu_item_id, session_id, referrer_route, device_type } = req.body

    await sidebarService.trackClick(
      menu_item_id,
      userId,
      session_id,
      referrer_route,
      device_type
    )

    res.json({ success: true })
  }),

  /**
   * GET /api/v1/sidebar/analytics
   * Get menu analytics (admin only)
   */
  getAnalytics: asyncHandler(async (req: AuthRequest, res: Response) => {
    const { menu_item_id, user_id, start_date, end_date } = req.query

    const analytics = await sidebarService.getAnalytics({
      menuItemId: menu_item_id ? Number(menu_item_id) : undefined,
      userId: user_id ? Number(user_id) : undefined,
      startDate: start_date ? new Date(start_date as string) : undefined,
      endDate: end_date ? new Date(end_date as string) : undefined,
    })

    res.json({ analytics })
  }),

  /**
   * GET /api/v1/sidebar/sections
   * Get all sidebar sections
   */
  getSections: asyncHandler(async (req: AuthRequest, res: Response) => {
    const sections = await sidebarService.getSections()

    res.json({ sections })
  }),
}
