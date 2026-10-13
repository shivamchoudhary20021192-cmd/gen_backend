/**
 * Dashboard Repository
 *
 * Data access layer for dashboard aggregations and analytics.
 */

import type { PoolConnection } from 'mysql2/promise';
import { pool } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';
import type {
  DashboardOverview,
  RevenueDataPoint,
  OrderStatusData,
  TopProduct,
  RecentOrder,
  DashboardAlert,
} from './dashboard.types';

export const dashboardRepository = {
  /**
   * Get dashboard overview KPIs
   */
  async getOverview(): Promise<DashboardOverview> {
    const conn = await pool.getConnection();
    try {
      // Revenue in the store's currency: orders from other markets carry their rate.
      const [revenueRows] = await conn.query<any[]>(`
        SELECT
          COALESCE(SUM(CASE WHEN DATE(created_at) = CURDATE() THEN grand_total * exchange_rate ELSE 0 END), 0) AS today,
          COALESCE(SUM(CASE WHEN YEAR(created_at) = YEAR(CURDATE()) AND MONTH(created_at) = MONTH(CURDATE()) THEN grand_total * exchange_rate ELSE 0 END), 0) AS month,
          COALESCE(SUM(CASE WHEN YEAR(created_at) = YEAR(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) AND MONTH(created_at) = MONTH(DATE_SUB(CURDATE(), INTERVAL 1 MONTH)) THEN grand_total * exchange_rate ELSE 0 END), 0) AS lastMonth
        FROM orders
        WHERE shop_id = ? AND payment_status IN ('paid', 'cod_collected', 'authorized')
      `, [shopId()]);

      const revenue = revenueRows[0];
      const growth = revenue.lastMonth > 0
        ? ((revenue.month - revenue.lastMonth) / revenue.lastMonth) * 100
        : 0;

      // Order metrics - using order_status instead of status
      const [orderRows] = await conn.query<any[]>(`
        SELECT
          COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS today,
          COUNT(CASE WHEN order_status = 'pending' THEN 1 END) AS pending,
          COUNT(CASE WHEN order_status = 'processing' THEN 1 END) AS processing,
          COALESCE(AVG(CASE WHEN order_status NOT IN ('cancelled', 'returned') THEN grand_total * exchange_rate END), 0) AS avgValue
        FROM orders
        WHERE shop_id = ?
      `, [shopId()]);

      // Product metrics - Query inventory_items table for stock information
      const [productRows] = await conn.query<any[]>(`
        SELECT
          COUNT(DISTINCT p.id) AS total,
          COUNT(DISTINCT CASE WHEN p.status = 'active' THEN p.id END) AS published,
          COUNT(CASE WHEN ii.quantity_available > 0 AND ii.quantity_available <= ii.safety_stock THEN 1 END) AS lowStock,
          COUNT(CASE WHEN ii.quantity_available <= 0 THEN 1 END) AS outOfStock
        FROM products p
        LEFT JOIN product_variants v ON v.product_id = p.id AND v.shop_id = p.shop_id
        LEFT JOIN inventory_items ii ON ii.variant_id = v.id AND ii.shop_id = v.shop_id
        WHERE p.shop_id = ? AND p.deleted_at IS NULL
      `, [shopId()]);

      // Customer metrics - using orders_count and total_spent
      const [customerRows] = await conn.query<any[]>(`
        SELECT
          COUNT(CASE WHEN DATE(created_at) = CURDATE() THEN 1 END) AS newToday,
          COUNT(CASE WHEN status = 'active' THEN 1 END) AS totalActive,
          COALESCE(AVG(CASE WHEN total_spent > 0 THEN total_spent END), 0) AS clv,
          COALESCE((COUNT(CASE WHEN orders_count > 1 THEN 1 END) * 100.0 / NULLIF(COUNT(CASE WHEN orders_count > 0 THEN 1 END), 0)), 0) AS returningRate
        FROM customers
        WHERE shop_id = ? AND deleted_at IS NULL
      `, [shopId()]);

      return {
        revenue: {
          today: Number(revenue.today),
          month: Number(revenue.month),
          lastMonth: Number(revenue.lastMonth),
          growth: Number(growth.toFixed(2)),
        },
        orders: {
          today: Number(orderRows[0].today),
          pending: Number(orderRows[0].pending),
          processing: Number(orderRows[0].processing),
          avgValue: Number(orderRows[0].avgValue),
        },
        products: {
          total: Number(productRows[0].total),
          published: Number(productRows[0].published),
          lowStock: Number(productRows[0].lowStock),
          outOfStock: Number(productRows[0].outOfStock),
        },
        customers: {
          newToday: Number(customerRows[0].newToday),
          totalActive: Number(customerRows[0].totalActive),
          clv: Number(customerRows[0].clv),
          returningRate: Number(customerRows[0].returningRate),
        },
      };
    } finally {
      conn.release();
    }
  },

  /**
   * Get revenue chart data for a period
   */
  async getRevenueChart(period: string): Promise<{ data: RevenueDataPoint[]; previousTotal: number }> {
    const conn = await pool.getConnection();
    try {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;

      const [rows] = await conn.query<any[]>(
        `
        SELECT
          DATE(created_at) AS date,
          COALESCE(SUM(grand_total * exchange_rate), 0) AS revenue,
          COUNT(*) AS orders
        FROM orders
        WHERE shop_id = ?
          AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND payment_status IN ('paid', 'cod_collected', 'authorized')
        GROUP BY DATE(created_at)
        ORDER BY date ASC
      `,
        [shopId(), days]
      );

      // Get previous period total for comparison
      const [prevRows] = await conn.query<any[]>(
        `
        SELECT COALESCE(SUM(grand_total * exchange_rate), 0) AS total
        FROM orders
        WHERE shop_id = ?
          AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND created_at < DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND payment_status IN ('paid', 'cod_collected', 'authorized')
      `,
        [shopId(), days * 2, days]
      );

      return {
        data: rows.map((row) => ({
          date: row.date,
          revenue: Number(row.revenue),
          orders: Number(row.orders),
        })),
        previousTotal: Number(prevRows[0]?.total || 0),
      };
    } finally {
      conn.release();
    }
  },

  /**
   * Get orders by status chart data
   */
  async getOrdersChart(period: string): Promise<OrderStatusData[]> {
    const conn = await pool.getConnection();
    try {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;

      const [rows] = await conn.query<any[]>(
        `
        SELECT
          order_status AS status,
          COUNT(*) AS count,
          COALESCE(SUM(grand_total * exchange_rate), 0) AS revenue
        FROM orders
        WHERE shop_id = ? AND created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
        GROUP BY order_status
        ORDER BY count DESC
      `,
        [shopId(), days]
      );

      return rows.map((row) => ({
        status: row.status,
        count: Number(row.count),
        revenue: Number(row.revenue),
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * Get top selling products
   */
  async getTopProducts(limit: number, period: string): Promise<TopProduct[]> {
    const conn = await pool.getConnection();
    try {
      const days = period === '7d' ? 7 : period === '30d' ? 30 : period === '90d' ? 90 : 365;

      const [rows] = await conn.query<any[]>(
        `
        SELECT
          p.id,
          p.name,
          m.storage_key AS thumbnail,
          COALESCE(SUM(oi.quantity), 0) AS unitsSold,
          COALESCE(SUM(oi.line_total * o.exchange_rate), 0) AS revenue
        FROM products p
        INNER JOIN order_items oi ON oi.product_id = p.id
        INNER JOIN orders o ON o.id = oi.order_id
        LEFT JOIN media_attachments ma ON ma.shop_id = p.shop_id
          AND ma.attachable_type = 'product'
          AND ma.attachable_id = p.id
          AND ma.collection = 'gallery'
          AND ma.is_primary = 1
        LEFT JOIN media m ON m.id = ma.media_id
        WHERE p.shop_id = ?
          AND o.created_at >= DATE_SUB(CURDATE(), INTERVAL ? DAY)
          AND o.payment_status IN ('paid', 'cod_collected', 'authorized')
          AND p.deleted_at IS NULL
        GROUP BY p.id, p.name, m.storage_key
        HAVING SUM(oi.quantity) > 0
        ORDER BY revenue DESC
        LIMIT ?
      `,
        [shopId(), days, limit]
      );

      return rows.map((row) => ({
        id: row.id,
        name: row.name,
        thumbnail: row.thumbnail,
        unitsSold: Number(row.unitsSold),
        revenue: Number(row.revenue),
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * Get recent orders
   */
  async getRecentOrders(limit: number): Promise<RecentOrder[]> {
    const conn = await pool.getConnection();
    try {
      const [rows] = await conn.query<any[]>(
        `
        SELECT
          o.id,
          o.public_id AS publicId,
          COALESCE(CONCAT(COALESCE(c.first_name, ''), ' ', COALESCE(c.last_name, '')), o.customer_name, 'Guest') AS customerName,
          o.grand_total * o.exchange_rate AS amount,
          o.order_status AS status,
          o.created_at AS createdAt
        FROM orders o
        LEFT JOIN customers c ON c.id = o.customer_id AND c.shop_id = o.shop_id
        WHERE o.shop_id = ?
        ORDER BY o.created_at DESC
        LIMIT ?
      `,
        [shopId(), limit]
      );

      return rows.map((row) => ({
        id: row.id,
        publicId: row.publicId,
        customerName: row.customerName?.trim() || 'Guest',
        amount: Number(row.amount),
        status: row.status,
        createdAt: row.createdAt,
      }));
    } finally {
      conn.release();
    }
  },

  /**
   * Get dashboard alerts
   */
  async getAlerts(): Promise<DashboardAlert[]> {
    const conn = await pool.getConnection();
    try {
      const alerts: DashboardAlert[] = [];

      // Low stock alerts - Query inventory_items table
      const [lowStockRows] = await conn.query<any[]>(`
        SELECT COUNT(*) AS count
        FROM inventory_items
        WHERE shop_id = ? AND quantity_available > 0 AND quantity_available <= safety_stock
      `, [shopId()]);

      if (lowStockRows[0].count > 0) {
        alerts.push({
          id: alerts.length + 1,
          type: 'low_stock',
          severity: 'warning',
          title: 'Low Stock Alert',
          message: `${lowStockRows[0].count} product variants are running low on stock`,
          link: '/inventory',
          createdAt: new Date().toISOString(),
        });
      }

      // Out of stock alerts - Query inventory_items table
      const [outOfStockRows] = await conn.query<any[]>(`
        SELECT COUNT(*) AS count
        FROM inventory_items
        WHERE shop_id = ? AND quantity_available <= 0
      `, [shopId()]);

      if (outOfStockRows[0].count > 0) {
        alerts.push({
          id: alerts.length + 1,
          type: 'low_stock',
          severity: 'critical',
          title: 'Out of Stock',
          message: `${outOfStockRows[0].count} product variants are out of stock`,
          link: '/inventory',
          createdAt: new Date().toISOString(),
        });
      }

      // Pending returns (if return_requests table exists)
      try {
        const [returnsRows] = await conn.query<any[]>(`
          SELECT COUNT(*) AS count
          FROM return_requests
          WHERE shop_id = ? AND status = 'pending'
        `, [shopId()]);

        if (returnsRows[0].count > 0) {
          alerts.push({
            id: alerts.length + 1,
            type: 'pending_return',
            severity: 'warning',
            title: 'Pending Returns',
            message: `${returnsRows[0].count} return requests need attention`,
            link: '/returns',
            createdAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        // Returns table might not exist yet
      }

      return alerts;
    } finally {
      conn.release();
    }
  },
};
