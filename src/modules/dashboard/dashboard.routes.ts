/**
 * Dashboard Routes
 * 
 * Defines all dashboard endpoints with authentication and authorization.
 */

import { Router } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { authenticate } from '../../middleware/authenticate';
import { requirePermission } from '../../middleware/requirePermission';
import { dashboardController } from './dashboard.controller';

const router = Router();

/**
 * GET /dashboard/overview
 * Get dashboard overview KPIs (revenue, orders, products, customers)
 * Requires: analytics.view permission
 */
router.get(
  '/overview',
  authenticate,
  requirePermission('analytics.view'),
  asyncHandler(dashboardController.getOverview)
);

/**
 * GET /dashboard/revenue-chart?period=30d
 * Get revenue chart data with period filter
 * Requires: analytics.view permission
 */
router.get(
  '/revenue-chart',
  authenticate,
  requirePermission('analytics.view'),
  asyncHandler(dashboardController.getRevenueChart)
);

/**
 * GET /dashboard/orders-chart?period=30d
 * Get orders by status chart data
 * Requires: analytics.view permission
 */
router.get(
  '/orders-chart',
  authenticate,
  requirePermission('analytics.view'),
  asyncHandler(dashboardController.getOrdersChart)
);

/**
 * GET /dashboard/top-products?limit=5&period=30d
 * Get top selling products
 * Requires: analytics.view permission
 */
router.get(
  '/top-products',
  authenticate,
  requirePermission('analytics.view'),
  asyncHandler(dashboardController.getTopProducts)
);

/**
 * GET /dashboard/recent-orders?limit=10
 * Get recent orders list
 * Requires: analytics.view permission
 */
router.get(
  '/recent-orders',
  authenticate,
  requirePermission('analytics.view'),
  asyncHandler(dashboardController.getRecentOrders)
);

/**
 * GET /dashboard/alerts
 * Get dashboard alerts and notifications
 * Requires: analytics.view permission
 */
router.get(
  '/alerts',
  authenticate,
  requirePermission('analytics.view'),
  asyncHandler(dashboardController.getAlerts)
);

export default router;
