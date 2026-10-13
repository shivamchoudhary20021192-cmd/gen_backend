/**
 * Dashboard Controller
 * 
 * HTTP request handlers for dashboard endpoints.
 */

import type { Request, Response } from 'express';
import { dashboardService } from './dashboard.service';

export const dashboardController = {
  async getOverview(req: Request, res: Response): Promise<void> {
    const data = await dashboardService.getOverview();
    res.status(200).json(data);
  },

  async getRevenueChart(req: Request, res: Response): Promise<void> {
    const { period = '30d' } = req.query as { period?: string };
    const data = await dashboardService.getRevenueChart(period);
    res.status(200).json(data);
  },

  async getOrdersChart(req: Request, res: Response): Promise<void> {
    const { period = '30d' } = req.query as { period?: string };
    const data = await dashboardService.getOrdersChart(period);
    res.status(200).json(data);
  },

  async getTopProducts(req: Request, res: Response): Promise<void> {
    const { limit = '5', period = '30d' } = req.query as { limit?: string; period?: string };
    const data = await dashboardService.getTopProducts(Number(limit), period);
    res.status(200).json(data);
  },

  async getRecentOrders(req: Request, res: Response): Promise<void> {
    const { limit = '10' } = req.query as { limit?: string };
    const data = await dashboardService.getRecentOrders(Number(limit));
    res.status(200).json(data);
  },

  async getAlerts(req: Request, res: Response): Promise<void> {
    const data = await dashboardService.getAlerts();
    res.status(200).json(data);
  },
};
