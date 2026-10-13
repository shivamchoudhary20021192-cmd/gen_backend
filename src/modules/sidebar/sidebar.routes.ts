import { Router } from 'express'
import { sidebarController } from './sidebar.controller'

const router = Router()

// Get menu
router.get('/menu', sidebarController.getMenu)
router.get('/menu/collapsed', sidebarController.getCollapsedMenu)

// Get sections
router.get('/sections', sidebarController.getSections)

// User preferences
router.get('/preferences', sidebarController.getPreferences)
router.patch('/preferences', sidebarController.updatePreferences)

// Quick actions
router.post('/toggle-pin', sidebarController.togglePin)
router.post('/toggle-collapse', sidebarController.toggleCollapse)

// Pin/favorite management
router.post('/pin-item', sidebarController.pinItem)
router.post('/unpin-item', sidebarController.unpinItem)
router.post('/favorite', sidebarController.addFavorite)
router.delete('/favorite/:id', sidebarController.removeFavorite)

// Analytics
router.post('/track-click', sidebarController.trackClick)
router.get('/analytics', sidebarController.getAnalytics)

export default router
