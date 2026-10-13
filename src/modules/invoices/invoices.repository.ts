import { insert, pool, query, queryOne, execute, type Executor, type RowDataPacket } from '../../db/pool';
import { shopId } from '../../platform/tenancy/context';

export interface InvoiceRow extends RowDataPacket {
  id: number;
  order_id: number;
  order_number: string;
  invoice_number: string;
  invoice_type: string;
  parent_invoice_id: number | null;
  parent_invoice_number: string | null;
  invoice_date: Date;
  seller_gstin: string | null;
  seller_legal_name: string | null;
  buyer_gstin: string | null;
  place_of_supply: string | null;
  taxable_value: string;
  cgst_amount: string;
  sgst_amount: string;
  igst_amount: string;
  tax_amount: string;
  tax_regime: string | null;
  currency: string | null;
  round_off: string;
  total_amount: string;
  irn: string | null;
  pdf_media_id: number | null;
  pdf_key: string | null;
  status: string;
  issued_at: Date | null;
  created_at: Date;
  customer_name: string | null;
  contact_phone: string | null;
  shipping_total: string;
  cod_fee: string;
}

const INVOICE_COLUMNS = `
  i.id, i.order_id, i.invoice_number, i.invoice_type, i.parent_invoice_id, i.invoice_date,
  i.seller_gstin, i.seller_legal_name, i.buyer_gstin, i.place_of_supply, i.taxable_value,
  i.cgst_amount, i.sgst_amount, i.igst_amount, i.tax_amount, i.tax_regime, i.currency, i.round_off, i.total_amount, i.irn,
  i.pdf_media_id, i.status, i.issued_at, i.created_at,
  o.order_number, o.contact_phone,
  -- Charges that are on the invoice but not stored on the invoice row. Without
  -- them the document cannot be checked against itself: taxable + tax alone
  -- never equals the total on an order that paid for delivery or COD.
  o.shipping_total, o.cod_fee,
  p.invoice_number AS parent_invoice_number,
  m.storage_key AS pdf_key,
  TRIM(CONCAT(COALESCE(a.first_name, ''), ' ', COALESCE(a.last_name, ''))) AS customer_name`;

const INVOICE_FROM = `
  FROM invoices i
  JOIN orders o ON o.id = i.order_id
  LEFT JOIN invoices p ON p.id = i.parent_invoice_id AND p.shop_id = i.shop_id
  LEFT JOIN media m ON m.id = i.pdf_media_id AND m.shop_id = i.shop_id
  LEFT JOIN order_addresses a ON a.order_id = o.id AND a.address_type = 'shipping'`;

export interface InvoiceFilters {
  search?: string;
  status?: string;
  type?: string;
  orderId?: number;
  from?: string;
  to?: string;
}

function buildWhere(filters: InvoiceFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = ['i.shop_id = ?'];
  const params: unknown[] = [shopId()];

  if (filters.search) {
    conditions.push('(i.invoice_number LIKE ? OR o.order_number LIKE ? OR o.contact_phone LIKE ?)');
    const like = `%${filters.search}%`;
    params.push(like, like, like);
  }
  if (filters.status) {
    conditions.push('i.status = ?');
    params.push(filters.status);
  }
  if (filters.type) {
    conditions.push('i.invoice_type = ?');
    params.push(filters.type);
  }
  if (filters.orderId) {
    conditions.push('i.order_id = ?');
    params.push(filters.orderId);
  }
  if (filters.from) {
    conditions.push('i.invoice_date >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    conditions.push('i.invoice_date <= ?');
    params.push(filters.to);
  }

  return { clause: `WHERE ${conditions.join(' AND ')}`, params };
}

export const invoicesRepository = {
  async list(filters: InvoiceFilters, orderBy: string, limit: number, offset: number, exec: Executor = pool) {
    const { clause, params } = buildWhere(filters);
    return query<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS} ${INVOICE_FROM} ${clause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      [...params, limit, offset],
      exec,
    );
  },

  async count(filters: InvoiceFilters, exec: Executor = pool): Promise<number> {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<RowDataPacket & { total: number }>(
      `SELECT COUNT(*) AS total ${INVOICE_FROM} ${clause}`,
      params,
      exec,
    );
    return row?.total ?? 0;
  },

  /**
   * The month's taxable value and tax, which is what a GSTR-1 filing needs.
   *
   * Credit notes are subtracted rather than listed separately, because the
   * figure a filing wants is net.
   */
  async summary(filters: InvoiceFilters, exec: Executor = pool) {
    const { clause, params } = buildWhere(filters);
    const row = await queryOne<
      RowDataPacket & { taxable: string; cgst: string; sgst: string; igst: string; total: string; count: number }
    >(
      `SELECT
         COALESCE(SUM(CASE WHEN i.invoice_type = 'credit_note' THEN -i.taxable_value ELSE i.taxable_value END), 0) AS taxable,
         COALESCE(SUM(CASE WHEN i.invoice_type = 'credit_note' THEN -i.cgst_amount ELSE i.cgst_amount END), 0) AS cgst,
         COALESCE(SUM(CASE WHEN i.invoice_type = 'credit_note' THEN -i.sgst_amount ELSE i.sgst_amount END), 0) AS sgst,
         COALESCE(SUM(CASE WHEN i.invoice_type = 'credit_note' THEN -i.igst_amount ELSE i.igst_amount END), 0) AS igst,
         COALESCE(SUM(CASE WHEN i.invoice_type = 'credit_note' THEN -i.total_amount ELSE i.total_amount END), 0) AS total,
         COUNT(*) AS count
       ${INVOICE_FROM} ${clause} AND i.status = 'issued'`,
      params,
      exec,
    );
    return row;
  },

  async findById(id: number, exec: Executor = pool): Promise<InvoiceRow | null> {
    return queryOne<InvoiceRow>(`SELECT ${INVOICE_COLUMNS} ${INVOICE_FROM} WHERE i.shop_id = ? AND i.id = ? LIMIT 1`, [shopId(), id], exec);
  },

  async findForOrder(orderId: number, type: string, exec: Executor = pool): Promise<InvoiceRow | null> {
    return queryOne<InvoiceRow>(
      `SELECT ${INVOICE_COLUMNS} ${INVOICE_FROM}
        WHERE i.shop_id = ? AND i.order_id = ? AND i.invoice_type = ? AND i.status <> 'cancelled'
        ORDER BY i.id DESC LIMIT 1`,
      [shopId(), orderId, type],
      exec,
    );
  },

  async create(
    data: {
      orderId: number;
      invoiceNumber: string;
      invoiceType: string;
      parentInvoiceId: number | null;
      invoiceDate: string;
      sellerGstin: string | null;
      sellerLegalName: string;
      buyerGstin: string | null;
      placeOfSupply: string | null;
      taxableValue: number;
      cgst: number;
      sgst: number;
      igst: number;
      /** Total tax, whatever the regime. */
      tax: number;
      regime: string;
      currency: string;
      roundOff: number;
      totalAmount: number;
      pdfMediaId: number | null;
    },
    exec: Executor = pool,
  ): Promise<number> {
    return insert(
      `INSERT INTO invoices
         (shop_id, order_id, invoice_number, invoice_type, tax_regime, currency, parent_invoice_id, invoice_date, seller_gstin,
          seller_legal_name, buyer_gstin, place_of_supply, taxable_value, cgst_amount, sgst_amount,
          igst_amount, tax_amount, round_off, total_amount, pdf_media_id, status, issued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NOW())`,
      [
        shopId(),
        data.orderId,
        data.invoiceNumber,
        data.invoiceType,
        data.regime,
        data.currency,
        data.parentInvoiceId,
        data.invoiceDate,
        data.sellerGstin,
        data.sellerLegalName,
        data.buyerGstin,
        data.placeOfSupply,
        data.taxableValue,
        data.cgst,
        data.sgst,
        data.igst,
        data.tax,
        data.roundOff,
        data.totalAmount,
        data.pdfMediaId,
      ],
      exec,
    );
  },

  async setPdf(id: number, mediaId: number, exec: Executor = pool): Promise<void> {
    await execute('UPDATE invoices SET pdf_media_id = ? WHERE shop_id = ? AND id = ?', [mediaId, shopId(), id], exec);
  },

  async cancel(id: number, exec: Executor = pool): Promise<void> {
    await execute("UPDATE invoices SET status = 'cancelled' WHERE shop_id = ? AND id = ?", [shopId(), id], exec);
  },

  async settings(exec: Executor = pool): Promise<Record<string, string>> {
    const rows = await query<RowDataPacket & { setting_key: string; value: string | null }>(
      "SELECT setting_key, value FROM settings WHERE shop_id = ? AND group_key = 'invoice'",
      [shopId()],
      exec,
    );
    return Object.fromEntries(rows.map((row) => [row.setting_key, row.value ?? '']));
  },

  async storePdfMedia(
    data: { disk: string; key: string; bytes: number; filename: string; title: string },
    exec: Executor = pool,
  ): Promise<number> {
    // The disk is whichever driver wrote the file — hardcoding 'local' would
    // point every PDF at the wrong place the day storage moves to S3.
    return insert(
      `INSERT INTO media
         (shop_id, disk, storage_key, original_filename, extension, mime_type, media_type, size_bytes,
          alt_text, title, usage_rights, status, source)
       VALUES (?, ?, ?, ?, 'pdf', 'application/pdf', 'document', ?, ?, ?, 'owned', 'ready', 'api')`,
      [shopId(), data.disk, data.key, data.filename, data.bytes, data.title, data.title],
      exec,
    );
  },
};
