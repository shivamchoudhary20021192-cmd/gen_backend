import { controlPlane, execute, insert, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { platformTax, platformTaxConfig, type TaxBuyer } from './platformTax';

/**
 * The platform's bills to its shops. Every table here is control plane: the
 * billing job reads across shops before any one is in context, and a shop's
 * admin reads its own rows through the same functions with its own id.
 */

export interface BillingAccountRow extends RowDataPacket {
  id: number;
  shop_id: number;
  provider: string;
  provider_customer_id: string | null;
  payment_method_ref: string | null;
  payment_method_label: string | null;
  payment_method_expires: string | null;
  pending_setup_ref: string | null;
  billing_email: string | null;
  legal_name: string | null;
  tax_id: string | null;
  tax_region: string | null;
}

export interface InvoiceRow extends RowDataPacket {
  id: number;
  shop_id: number;
  subscription_id: number | null;
  invoice_number: string | null;
  kind: 'cycle' | 'plan_change' | 'manual';
  currency: string;
  period_start: Date;
  period_end: Date;
  subtotal: string;
  tax_total: string;
  tax_note: string | null;
  customer_tax_id: string | null;
  total: string;
  status: 'open' | 'paid' | 'failed' | 'void';
  attempt_count: number;
  next_attempt_at: Date | null;
  first_failed_at: Date | null;
  last_error: string | null;
  provider: string | null;
  provider_payment_id: string | null;
  issued_at: Date;
  paid_at: Date | null;
  voided_at: Date | null;
}

export interface InvoiceLineRow extends RowDataPacket {
  id: number;
  invoice_id: number | null;
  kind: 'subscription' | 'transaction_fee' | 'proration' | 'adjustment' | 'domain' | 'tax';
  description: string;
  currency: string;
  amount: string;
  period_start: Date | null;
  period_end: Date | null;
  reference: string | null;
}

export interface NewLine {
  kind: InvoiceLineRow['kind'];
  description: string;
  currency: string;
  amount: number;
  periodStart?: Date | null;
  periodEnd?: Date | null;
  reference?: string | null;
}

export const billingRepository = {
  // ── accounts ─────────────────────────────────────────────────────────────

  async account(shopId: number, exec: Executor = controlPlane): Promise<BillingAccountRow | null> {
    return queryOne<BillingAccountRow>('SELECT * FROM billing_accounts WHERE shop_id = ? LIMIT 1', [shopId], exec);
  },

  async upsertAccount(
    shopId: number,
    provider: string,
    patch: Partial<Pick<BillingAccountRow, 'provider_customer_id' | 'payment_method_ref' | 'payment_method_label' | 'payment_method_expires' | 'pending_setup_ref' | 'billing_email' | 'legal_name' | 'tax_id' | 'tax_region'>>,
    exec: Executor = controlPlane,
  ): Promise<void> {
    await execute('INSERT IGNORE INTO billing_accounts (shop_id, provider) VALUES (?, ?)', [shopId, provider], exec);
    const columns = Object.keys(patch) as (keyof typeof patch)[];
    await execute(
      `UPDATE billing_accounts SET provider = ?${columns.map((column) => `, \`${column}\` = ?`).join('')} WHERE shop_id = ?`,
      [provider, ...columns.map((column) => patch[column] ?? null), shopId],
      exec,
    );
  },

  // ── invoices ─────────────────────────────────────────────────────────────

  async createInvoice(
    data: {
      shopId: number;
      subscriptionId: number | null;
      kind: InvoiceRow['kind'];
      currency: string;
      periodStart: Date;
      periodEnd: Date;
      issuedAt: Date;
      cycleKey: string | null;
      provider: string;
    },
    exec: Executor,
  ): Promise<number> {
    const id = await insert(
      `INSERT INTO platform_invoices (shop_id, subscription_id, kind, currency, period_start, period_end, issued_at, cycle_key, provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [data.shopId, data.subscriptionId, data.kind, data.currency, data.periodStart, data.periodEnd, data.issuedAt, data.cycleKey, data.provider],
      exec,
    );
    // Numbered from the id, so the sequence has no gaps a rollback could leave
    // anywhere but in ids nobody sees.
    await execute("UPDATE platform_invoices SET invoice_number = CONCAT('PB-', LPAD(id, 7, '0')) WHERE id = ?", [id], exec);
    return id;
  },

  async addLines(shopId: number, invoiceId: number | null, lines: NewLine[], exec: Executor): Promise<void> {
    for (const line of lines) {
      await execute(
        `INSERT INTO platform_invoice_lines (shop_id, invoice_id, kind, description, currency, amount, period_start, period_end, reference)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [shopId, invoiceId, line.kind, line.description, line.currency, line.amount, line.periodStart ?? null, line.periodEnd ?? null, line.reference ?? null],
        exec,
      );
    }
  },

  /** Attaches the shop's pending lines (prorations, credits) to an invoice. */
  async sweepPendingLines(shopId: number, invoiceId: number, currency: string, exec: Executor): Promise<void> {
    await execute(
      'UPDATE platform_invoice_lines SET invoice_id = ? WHERE shop_id = ? AND invoice_id IS NULL AND currency = ?',
      [invoiceId, shopId, currency],
      exec,
    );
  },

  /**
   * Sums the lines into the total, with the platform's tax on top (see
   * platformTax.ts; `buyer` is the store as the tax sees it — none, no tax).
   * A net credit is carried to the next bill, untaxed.
   */
  async finaliseTotal(invoiceId: number, shopId: number, currency: string, exec: Executor, buyer: TaxBuyer | null = null): Promise<number> {
    // Finalising again (a re-run) starts from the bill's own lines, not its old tax.
    await execute("DELETE FROM platform_invoice_lines WHERE invoice_id = ? AND kind = 'tax'", [invoiceId], exec);
    const row = await queryOne<RowDataPacket & { total: string }>(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM platform_invoice_lines WHERE invoice_id = ?',
      [invoiceId],
      exec,
    );
    let subtotal = Number(row?.total ?? 0);
    if (subtotal < 0) {
      await this.addLines(shopId, invoiceId, [{ kind: 'adjustment', description: 'Credit carried to your next bill', currency, amount: -subtotal }], exec);
      await this.addLines(shopId, null, [{ kind: 'adjustment', description: 'Credit from a previous bill', currency, amount: subtotal }], exec);
      subtotal = 0;
    }
    const tax = buyer ? platformTax(platformTaxConfig(), buyer, subtotal, currency) : { lines: [], note: null };
    if (tax.lines.length) {
      await this.addLines(shopId, invoiceId, tax.lines.map((line) => ({ kind: 'tax' as const, description: line.name, currency, amount: line.amount })), exec);
    }
    const taxTotal = Math.round(tax.lines.reduce((sum, line) => sum + line.amount, 0) * 100) / 100;
    const total = Math.round((subtotal + taxTotal) * 100) / 100;
    await execute(
      'UPDATE platform_invoices SET subtotal = ?, tax_total = ?, tax_note = ?, customer_tax_id = ?, total = ? WHERE id = ?',
      [subtotal, taxTotal, tax.note, buyer?.taxId ?? null, total, invoiceId],
      exec,
    );
    return total;
  },

  /** The bill a processor's payment belongs to, by the payment's id. */
  async invoiceByProviderPayment(providerPaymentId: string, exec: Executor = controlPlane): Promise<InvoiceRow | null> {
    return queryOne<InvoiceRow>('SELECT * FROM platform_invoices WHERE provider_payment_id = ? LIMIT 1', [providerPaymentId], exec);
  },

  // ── processor events ─────────────────────────────────────────────────────

  /** Records an event before handling it; false when it was already seen (a retry). */
  async recordEvent(provider: string, eventId: string, type: string, exec: Executor = controlPlane): Promise<boolean> {
    const result = await execute('INSERT IGNORE INTO billing_provider_events (provider, event_id, type) VALUES (?, ?, ?)', [provider, eventId, type], exec);
    return result.affectedRows === 1;
  },

  async finishEvent(provider: string, eventId: string, outcome: { invoiceId: number | null; outcome: string; error?: string | null }, exec: Executor = controlPlane): Promise<void> {
    await execute(
      'UPDATE billing_provider_events SET invoice_id = ?, outcome = ?, error = ?, processed_at = NOW() WHERE provider = ? AND event_id = ?',
      [outcome.invoiceId, outcome.outcome, outcome.error?.slice(0, 500) ?? null, provider, eventId],
      exec,
    );
  },

  /** An event that failed half way may be retried by the processor: forget it so the retry is handled. */
  async forgetEvent(provider: string, eventId: string, exec: Executor = controlPlane): Promise<void> {
    await execute('DELETE FROM billing_provider_events WHERE provider = ? AND event_id = ? AND processed_at IS NULL', [provider, eventId], exec);
  },

  async invoice(id: number, exec: Executor = controlPlane): Promise<InvoiceRow | null> {
    return queryOne<InvoiceRow>('SELECT * FROM platform_invoices WHERE id = ?', [id], exec);
  },

  async invoiceForUpdate(id: number, exec: Executor): Promise<InvoiceRow | null> {
    return queryOne<InvoiceRow>('SELECT * FROM platform_invoices WHERE id = ? FOR UPDATE', [id], exec);
  },

  async lines(invoiceId: number, exec: Executor = controlPlane): Promise<InvoiceLineRow[]> {
    return query<InvoiceLineRow>('SELECT * FROM platform_invoice_lines WHERE invoice_id = ? ORDER BY id', [invoiceId], exec);
  },

  async pendingLines(shopId: number, exec: Executor = controlPlane): Promise<InvoiceLineRow[]> {
    return query<InvoiceLineRow>('SELECT * FROM platform_invoice_lines WHERE shop_id = ? AND invoice_id IS NULL ORDER BY id', [shopId], exec);
  },

  async invoicesForShop(shopId: number, limit = 50, exec: Executor = controlPlane): Promise<InvoiceRow[]> {
    return query<InvoiceRow>('SELECT * FROM platform_invoices WHERE shop_id = ? ORDER BY id DESC LIMIT ?', [shopId, limit], exec);
  },

  async unpaidForShop(shopId: number, exec: Executor = controlPlane): Promise<InvoiceRow[]> {
    return query<InvoiceRow>("SELECT * FROM platform_invoices WHERE shop_id = ? AND status IN ('open', 'failed') ORDER BY id", [shopId], exec);
  },

  async markPaid(id: number, providerPaymentId: string | null, at: Date, exec: Executor): Promise<void> {
    await execute(
      `UPDATE platform_invoices
          SET status = 'paid', paid_at = ?, provider_payment_id = COALESCE(?, provider_payment_id),
              next_attempt_at = NULL, last_error = NULL
        WHERE id = ?`,
      [at, providerPaymentId, id],
      exec,
    );
  },

  async markFailed(
    id: number,
    data: { error: string; attempts: number; nextAttemptAt: Date | null; firstFailedAt: Date; providerPaymentId: string | null },
    exec: Executor,
  ): Promise<void> {
    await execute(
      `UPDATE platform_invoices
          SET status = 'failed', attempt_count = ?, next_attempt_at = ?, first_failed_at = COALESCE(first_failed_at, ?),
              last_error = ?, provider_payment_id = COALESCE(?, provider_payment_id)
        WHERE id = ?`,
      [data.attempts, data.nextAttemptAt, data.firstFailedAt, data.error.slice(0, 500), data.providerPaymentId, id],
      exec,
    );
  },

  async markVoid(id: number, at: Date, exec: Executor): Promise<void> {
    await execute("UPDATE platform_invoices SET status = 'void', voided_at = ?, next_attempt_at = NULL WHERE id = ?", [at, id], exec);
  },

  // ── what the billing job looks for ───────────────────────────────────────

  /** Live subscriptions whose period (or trial) has ended. */
  async dueSubscriptions(now: Date, shopId: number | null = null, limit = 100, exec: Executor = controlPlane) {
    return query<RowDataPacket & { id: number; shop_id: number }>(
      `SELECT s.id, s.shop_id FROM shop_subscriptions s
         JOIN shops sh ON sh.id = s.shop_id AND sh.status NOT IN ('closed', 'provisioning')
        WHERE s.status IN ('trialing', 'active', 'past_due') AND s.current_period_end <= ?
          AND (? IS NULL OR s.shop_id = ?)
        ORDER BY s.current_period_end LIMIT ?`,
      [now, shopId, shopId, limit],
      exec,
    );
  },

  async dueRetries(now: Date, shopId: number | null = null, limit = 100, exec: Executor = controlPlane): Promise<InvoiceRow[]> {
    return query<InvoiceRow>(
      `SELECT * FROM platform_invoices
        WHERE status = 'failed' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ? AND (? IS NULL OR shop_id = ?)
        ORDER BY next_attempt_at LIMIT ?`,
      [now, shopId, shopId, limit],
      exec,
    );
  },

  /** Shops with a bill unpaid since before `cutoff`, not yet frozen. */
  async shopsPastGrace(cutoff: Date, shopId: number | null = null, exec: Executor = controlPlane) {
    return query<RowDataPacket & { shop_id: number; invoice_number: string }>(
      `SELECT i.shop_id, MIN(i.invoice_number) AS invoice_number FROM platform_invoices i
         JOIN shops sh ON sh.id = i.shop_id AND sh.status IN ('active', 'paused')
        WHERE i.status = 'failed' AND i.first_failed_at <= ? AND (? IS NULL OR i.shop_id = ?)
        GROUP BY i.shop_id`,
      [cutoff, shopId, shopId],
      exec,
    );
  },

  async planPrice(planId: number, currency: string, exec: Executor = controlPlane): Promise<number | null> {
    const row = await queryOne<RowDataPacket & { price_amount: string }>(
      'SELECT price_amount FROM plan_prices WHERE plan_id = ? AND currency = ?',
      [planId, currency],
      exec,
    );
    return row ? Number(row.price_amount) : null;
  },

  // ── operators ────────────────────────────────────────────────────────────

  async search(filters: { status?: string; shopId?: number; limit: number; offset: number }, exec: Executor = controlPlane) {
    const where = ['1 = 1'];
    const params: unknown[] = [];
    if (filters.status) {
      where.push('i.status = ?');
      params.push(filters.status);
    }
    if (filters.shopId) {
      where.push('i.shop_id = ?');
      params.push(filters.shopId);
    }
    return query<InvoiceRow & { shop_handle: string; shop_name: string }>(
      `SELECT i.*, sh.handle AS shop_handle, sh.name AS shop_name
         FROM platform_invoices i JOIN shops sh ON sh.id = i.shop_id
        WHERE ${where.join(' AND ')}
        ORDER BY i.id DESC LIMIT ? OFFSET ?`,
      [...params, filters.limit, filters.offset],
      exec,
    );
  },
};
