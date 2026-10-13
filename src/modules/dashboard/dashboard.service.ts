/**
 * Dashboard Service
 * 
 * Business logic for dashboard analytics and aggregations.
 */

import { dashboardRepository } from './dashboard.repository';
import type {
  DashboardOverview,
  RevenueChartData,
  OrderStatusData,
  TopProduct,
  RecentOrder,
  DashboardAlert,
} from './dashboard.types';

export const dashboardService = {
  /**
   * Get dashboard overview KPIs
   */
  async getOverview(): Promise<{ overview: DashboardOverview }> {
    const overview = await dashboardRepository.getOverview();
    return { overview };
  },

  /**
   * Get revenue chart data
   */
  async getRevenueChart(period: string): Promise<RevenueChartData> {
    const { data, previousTotal } = await dashboardRepository.getRevenueChart(period);

    const currentTotal = data.reduce((sum, point) => sum + point.revenue, 0);
    const growth =
      previousTotal > 0 ? ((currentTotal - previousTotal) / previousTotal) * 100 : 0;

    return {
      data,
      comparison: {
        growth: Number(growth.toFixed(2)),
        previousTotal,
      },
    };
  },

  /**
   * Get orders by status chart data
   */
  async getOrdersChart(period: string): Promise<{ data: OrderStatusData[] }> {
    const data = await dashboardRepository.getOrdersChart(period);
    return { data };
  },

  /**
   * Get top selling products
   */
  async getTopProducts(limit: number, period: string): Promise<{ products: TopProduct[] }> {
    const products = await dashboardRepository.getTopProducts(limit, period);
    return { products };
  },

  /**
   * Get recent orders
   */
  async getRecentOrders(limit: number): Promise<{ orders: RecentOrder[] }> {
    const orders = await dashboardRepository.getRecentOrders(limit);
    return { orders };
  },

  /**
   * Get dashboard alerts
   */
  async getAlerts(): Promise<{ alerts: DashboardAlert[] }> {
    const alerts = await dashboardRepository.getAlerts();
    return { alerts };
  },
};
