/**
 * Dashboard Module Types
 */

export interface DashboardOverview {
  revenue: {
    today: number;
    month: number;
    lastMonth: number;
    growth: number;
  };
  orders: {
    today: number;
    pending: number;
    processing: number;
    avgValue: number;
  };
  products: {
    total: number;
    published: number;
    lowStock: number;
    outOfStock: number;
  };
  customers: {
    newToday: number;
    totalActive: number;
    clv: number;
    returningRate: number;
  };
}

export interface RevenueDataPoint {
  date: string;
  revenue: number;
  orders: number;
}

export interface RevenueChartData {
  data: RevenueDataPoint[];
  comparison: {
    growth: number;
    previousTotal: number;
  };
}

export interface OrderStatusData {
  status: string;
  count: number;
  revenue: number;
}

export interface TopProduct {
  id: number;
  name: string;
  thumbnail: string | null;
  unitsSold: number;
  revenue: number;
}

export interface RecentOrder {
  id: number;
  publicId: string;
  customerName: string;
  amount: number;
  status: string;
  createdAt: string;
}

export interface DashboardAlert {
  id: number;
  type: 'low_stock' | 'failed_payment' | 'pending_return' | 'system_error';
  severity: 'info' | 'warning' | 'critical';
  title: string;
  message: string;
  link?: string;
  createdAt: string;
}
