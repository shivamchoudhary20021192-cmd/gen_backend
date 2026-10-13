import { ApiError } from '../../core/ApiError';
import { buildMeta, parsePagination } from '../../core/pagination';
import { auditService } from '../../shared/audit.service';
import { clearCredentialsCache } from './gateway';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import {
  paymentsRepository,
  type PaymentTransactionRow,
  type RefundRow,
  type WebhookEventRow,
} from './payments.repository';
import { shopPricing } from '../../platform/commerce/shopPricing';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId: string;
}

function maskSecret(val: string | null): string {
  if (!val || val.length === 0) return '';
  if (val.length <= 4) return '••••';
  return `••••••••${val.slice(-4)}`;
}

function presentTransaction(row: PaymentTransactionRow) {
  return {
    id: row.id,
    order_id: row.order_id,
    order_number: row.order_number,
    gateway: row.gateway,
    gateway_order_id: row.gateway_order_id,
    gateway_payment_id: row.gateway_payment_id,
    method: row.method,
    amount: Number(row.amount),
    currency: row.currency,
    status: row.status,
    card_network: row.card_network,
    card_last4: row.card_last4,
    card_issuer: row.card_issuer,
    upi_vpa: row.upi_vpa,
    bank: row.bank,
    wallet: row.wallet,
    is_international: row.is_international === 1,
    gateway_fee: Number(row.gateway_fee),
    gateway_tax: Number(row.gateway_tax),
    error_code: row.error_code,
    error_description: row.error_description,
    authorized_at: row.authorized_at,
    captured_at: row.captured_at,
    failed_at: row.failed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function presentRefund(row: RefundRow) {
  return {
    id: row.id,
    order_id: row.order_id,
    order_number: row.order_number,
    payment_id: row.payment_id,
    gateway_refund_id: row.gateway_refund_id,
    amount: Number(row.amount),
    refund_type: row.refund_type,
    reason: row.reason,
    internal_note: row.internal_note,
    status: row.status,
    speed: row.speed,
    arn: row.arn,
    initiated_by_admin_id: row.initiated_by_admin_id,
    admin_name: row.admin_name ?? null,
    processed_at: row.processed_at,
    created_at: row.created_at,
  };
}

function presentWebhook(row: WebhookEventRow) {
  return {
    id: row.id,
    gateway: row.gateway,
    event_id: row.event_id,
    event_type: row.event_type,
    status: row.status,
    attempts: row.attempts,
    last_error: row.last_error,
    order_id: row.order_id,
    order_number: row.order_number ?? null,
    payment_id: row.payment_id,
    received_at: row.received_at,
    processed_at: row.processed_at,
  };
}

export const paymentsService = {
  // ── Settings ─────────────────────────────────────────────────────────────

  async getSettings() {
    const rows = await paymentsRepository.getPaymentSettings();
    const map: Record<string, string | null> = {};
    for (const r of rows) {
      map[r.setting_key] = r.value;
    }

    return {
      settings: {
        gateway: map['payment.gateway'] ?? 'razorpay',
        cod_enabled: map['payment.cod_enabled'] === '1' || map['payment.cod_enabled'] === 'true',
        capture_mode: (map['payment.capture_mode'] ?? 'automatic') as 'automatic' | 'manual',
        razorpay_key_id: map['payment.razorpay_key_id'] ?? '',
        has_key_secret: Boolean(map['payment.razorpay_key_secret']),
        razorpay_key_secret_masked: maskSecret(map['payment.razorpay_key_secret']),
        has_webhook_secret: Boolean(map['payment.razorpay_webhook_secret']),
        razorpay_webhook_secret_masked: maskSecret(map['payment.razorpay_webhook_secret']),
        test_mode: map['payment.test_mode'] === '1' || map['payment.test_mode'] === 'true',
        enabled_methods: map['payment.enabled_methods']
          ? JSON.parse(map['payment.enabled_methods'])
          : ['upi', 'card', 'netbanking', 'wallet'],
      },
    };
  },

  async updateSettings(
    data: {
      gateway?: string;
      cod_enabled?: boolean;
      capture_mode?: 'automatic' | 'manual';
      razorpay_key_id?: string;
      razorpay_key_secret?: string;
      razorpay_webhook_secret?: string;
      test_mode?: boolean;
      enabled_methods?: string[];
    },
    admin: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    if (data.gateway !== undefined) {
      await paymentsRepository.upsertSetting('payment.gateway', 'Active gateway', data.gateway, 'string', false, admin.id);
    }
    if (data.cod_enabled !== undefined) {
      await paymentsRepository.upsertSetting('payment.cod_enabled', 'COD enabled', data.cod_enabled ? '1' : '0', 'boolean', true, admin.id);
    }
    if (data.capture_mode !== undefined) {
      await paymentsRepository.upsertSetting('payment.capture_mode', 'Capture mode', data.capture_mode, 'string', false, admin.id);
    }
    if (data.razorpay_key_id !== undefined) {
      await paymentsRepository.upsertSetting('payment.razorpay_key_id', 'Razorpay Key ID', data.razorpay_key_id, 'string', true, admin.id);
    }
    if (data.razorpay_key_secret !== undefined && data.razorpay_key_secret.trim() !== '') {
      await paymentsRepository.upsertSetting('payment.razorpay_key_secret', 'Razorpay Key Secret', data.razorpay_key_secret, 'string', false, admin.id);
    }
    if (data.razorpay_webhook_secret !== undefined && data.razorpay_webhook_secret.trim() !== '') {
      await paymentsRepository.upsertSetting('payment.razorpay_webhook_secret', 'Razorpay Webhook Secret', data.razorpay_webhook_secret, 'string', false, admin.id);
    }
    if (data.test_mode !== undefined) {
      await paymentsRepository.upsertSetting('payment.test_mode', 'Test mode', data.test_mode ? '1' : '0', 'boolean', false, admin.id);
    }
    if (data.enabled_methods !== undefined) {
      await paymentsRepository.upsertSetting('payment.enabled_methods', 'Enabled payment methods', JSON.stringify(data.enabled_methods), 'json', true, admin.id);
    }

    /**
     * Credentials are cached for half a minute, so without this the keys you
     * just saved do not take effect until the cache expires — and the shop
     * keeps saying online payment is unavailable while the screen shows the
     * keys saved. Cleared here so the change is live before the response.
     */
    clearCredentialsCache();
    // COD on/off feeds the cart's payment options.
    shopPricing.invalidate();

    await auditService.log({
      actorId: admin.id,
      actorLabel: admin.email,
      action: 'payment.settings_updated',
      entityType: 'settings',
      summary: 'Updated payment settings',
      changes: {
        ...data,
        razorpay_key_secret: data.razorpay_key_secret ? '[UPDATED]' : undefined,
        razorpay_webhook_secret: data.razorpay_webhook_secret ? '[UPDATED]' : undefined,
      },
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    return this.getSettings();
  },

  // ── Transactions ─────────────────────────────────────────────────────────

  async listTransactions(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const filters = {
      status: queryParams.status as string | undefined,
      gateway: queryParams.gateway as string | undefined,
      method: queryParams.method as string | undefined,
      search: queryParams.search as string | undefined,
    };

    const [rows, total] = await Promise.all([
      paymentsRepository.listPayments(filters, page.limit, page.offset),
      paymentsRepository.countPayments(filters),
    ]);

    return { transactions: rows.map(presentTransaction), pagination: buildMeta(total, page) };
  },

  async getTransaction(id: number) {
    const row = await paymentsRepository.getPaymentById(id);
    if (!row) throw ApiError.notFound('Payment transaction');
    return { transaction: presentTransaction(row) };
  },

  // ── Refunds ──────────────────────────────────────────────────────────────

  async listRefunds(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const [rows, total] = await Promise.all([
      paymentsRepository.listRefunds(page.limit, page.offset),
      paymentsRepository.countRefunds(),
    ]);

    return { refunds: rows.map(presentRefund), pagination: buildMeta(total, page) };
  },

  // ── Webhooks ─────────────────────────────────────────────────────────────

  async listWebhooks(queryParams: Record<string, unknown>) {
    const page = parsePagination(queryParams);
    const [rows, total] = await Promise.all([
      paymentsRepository.listWebhooks(page.limit, page.offset),
      paymentsRepository.countWebhooks(),
    ]);

    return { webhooks: rows.map(presentWebhook), pagination: buildMeta(total, page) };
  },
};
