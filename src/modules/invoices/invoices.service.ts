import { randomUUID } from 'node:crypto';
import { ApiError } from '../../core/ApiError';
import { splitGst, stateCodeFor, stateNameFor } from '../../core/india';
import { buildMeta, parsePagination, type PaginationMeta } from '../../core/pagination';
import { withTransaction } from '../../db/transaction';
import { auditService } from '../../shared/audit.service';
import type { AuthenticatedAdmin } from '../auth/auth.types';
import { storage } from '../media/storage';
import { tenancy } from '../../platform/tenancy/context';
import { ordersRepository } from '../orders/orders.repository';
import { shipmentsRepository } from '../shipments/shipments.repository';
import { renderInvoicePdf, type InvoiceLine } from './invoicePdf';
import { invoicesRepository, type InvoiceRow } from './invoices.repository';
import { formatMoney } from '../../platform/shops/format';
import { presentationFor } from './invoicePdf';

interface ActorMeta {
  ip: string | null;
  userAgent: string | null;
  requestId?: string;
}

const SORTABLE: Record<string, string> = {
  newest: 'i.invoice_date DESC, i.id DESC',
  oldest: 'i.invoice_date ASC, i.id ASC',
  amount: 'i.total_amount DESC',
  number: 'i.invoice_number DESC',
};

function money(value: string | number | null): number {
  return value === null ? 0 : Number(Number(value).toFixed(2));
}

function present(row: InvoiceRow) {
  return {
    id: row.id,
    invoice_number: row.invoice_number,
    invoice_type: row.invoice_type,
    against_invoice: row.parent_invoice_number,
    order: { id: row.order_id, order_number: row.order_number },
    customer: { name: row.customer_name?.trim() || null, phone: row.contact_phone },
    invoice_date: new Date(row.invoice_date).toISOString().slice(0, 10),
    seller_gstin: row.seller_gstin,
    seller_legal_name: row.seller_legal_name,
    buyer_gstin: row.buyer_gstin,
    place_of_supply: row.place_of_supply,
    place_of_supply_name: stateNameFor(row.place_of_supply),
    taxable_value: money(row.taxable_value),
    cgst: money(row.cgst_amount),
    sgst: money(row.sgst_amount),
    igst: money(row.igst_amount),
    shipping: money(row.shipping_total),
    cod_fee: money(row.cod_fee),
    round_off: money(row.round_off),
    total_amount: money(row.total_amount),
    /** Everything on the document, so it can be checked against itself. */
    tax_total: money(row.tax_amount) || money(money(row.cgst_amount) + money(row.sgst_amount) + money(row.igst_amount)),
    tax_regime: row.tax_regime ?? 'in_gst',
    currency: row.currency ?? 'INR',
    /** Inter-state when there is IGST and no CGST — one is always zero. */
    is_inter_state: money(row.igst_amount) > 0,
    status: row.status,
    pdf_url: row.pdf_key ? storage.publicUrl(row.pdf_key) : null,
    issued_at: row.issued_at ? row.issued_at.toISOString() : null,
    created_at: row.created_at.toISOString(),
  };
}

export const invoicesService = {
  async list(queryParams: Record<string, unknown>): Promise<{ invoices: unknown[]; pagination: PaginationMeta }> {
    const page = parsePagination(queryParams);
    const sortKey = typeof queryParams.sort === 'string' ? queryParams.sort : '';
    const orderBy = SORTABLE[sortKey] ?? SORTABLE.newest;

    const filters = {
      search: queryParams.q as string | undefined,
      status: queryParams.status as string | undefined,
      type: queryParams.type as string | undefined,
      orderId: queryParams.order_id as number | undefined,
      from: queryParams.from as string | undefined,
      to: queryParams.to as string | undefined,
    };

    const [rows, total, summary] = await Promise.all([
      invoicesRepository.list(filters, orderBy, page.limit, page.offset),
      invoicesRepository.count(filters),
      invoicesRepository.summary(filters),
    ]);

    return {
      invoices: rows.map(present),
      pagination: buildMeta(total, page),
      // Net of credit notes — the figure a GSTR-1 filing actually wants.
      summary: {
        invoice_count: Number(summary?.count ?? 0),
        taxable_value: money(summary?.taxable ?? 0),
        cgst: money(summary?.cgst ?? 0),
        sgst: money(summary?.sgst ?? 0),
        igst: money(summary?.igst ?? 0),
        total: money(summary?.total ?? 0),
      },
    } as never;
  },

  async get(id: number) {
    const row = await invoicesRepository.findById(id);
    if (!row) throw ApiError.notFound('Invoice');
    const items = await ordersRepository.items(row.order_id);
    return {
      invoice: {
        ...present(row),
        items: items
          .filter((item) => item.line_type !== 'shipping')
          .map((item) => ({
            sku: item.sku,
            name: item.product_name,
            variant_title: item.variant_title,
            hsn_code: item.hsn_code,
            quantity: item.quantity,
            unit_price: money(item.unit_price),
            taxable_value: money(item.taxable_amount),
            tax_rate: money(item.tax_rate),
            tax_amount: money(item.tax_amount),
            line_total: money(item.line_total),
          })),
      },
    };
  },

  /**
   * Issues the tax invoice for an order.
   *
   * Two rules make this more than a formatting job. First, an invoice number is
   * consecutive and permanent — issuing twice for one order is a compliance
   * problem, so a second call returns the invoice that already exists rather
   * than minting another. Second, the CGST/SGST versus IGST split is decided
   * here from the place of supply, not copied from the order: the storefront
   * writes CGST/SGST optimistically at checkout, and an order shipped outside
   * the warehouse state has to be re-split before it goes on a document.
   */
  async issueForOrder(orderId: number, actor: AuthenticatedAdmin, meta: ActorMeta) {
    const existing = await invoicesRepository.findForOrder(orderId, 'tax_invoice');
    if (existing) return { invoice: present(existing), already_existed: true };

    const order = await ordersRepository.findById(orderId);
    if (!order) throw ApiError.notFound('Order');
    if (['pending', 'cancelled'].includes(order.order_status)) {
      throw ApiError.conflict(
        `An order that is "${order.order_status}" is not ready to be invoiced.`,
        'INVALID_TRANSITION',
      );
    }

    const [items, addresses, settings, location] = await Promise.all([
      ordersRepository.items(orderId),
      ordersRepository.addresses(orderId),
      invoicesRepository.settings(),
      shipmentsRepository.defaultLocation(),
    ]);

    const shipTo = addresses.find((address) => address.address_type === 'shipping');
    const billTo = addresses.find((address) => address.address_type === 'billing') ?? shipTo;
    if (!shipTo) throw ApiError.conflict('This order has no address, so there is no place of supply.');

    // The document follows the shop's tax regime: GST's CGST/SGST/IGST split
    // and place-of-supply rules for Indian shops, one tax line elsewhere.
    const shop = tenancy.current();
    const presentation = presentationFor(shop.taxEngine);
    const gst = presentation.gstSplit;

    // Prefer the stored code, fall back to deriving it from the state name.
    const placeOfSupply = gst ? (shipTo.state_code ?? stateCodeFor(shipTo.state)) : (shipTo.state_code ?? null);
    const sellerStateCode = location?.state_code ?? (gst ? stateCodeFor(location?.state ?? null) : null);
    if (gst && !placeOfSupply) {
      throw ApiError.conflict(
        `"${shipTo.state}" is not a state we can map to a GST code, so the place of supply cannot be set. Correct the address and try again.`,
      );
    }

    const sellerName = settings.seller_legal_name || shop.name;
    const sellerGstin = settings.seller_gstin || location?.gstin || null;

    const productLines = items.filter((item) => item.line_type !== 'shipping');
    const shipping = money(order.shipping_total);
    const codFee = money(order.cod_fee);

    let taxableTotal = 0;
    let cgstTotal = 0;
    let sgstTotal = 0;
    let igstTotal = 0;
    let taxTotal = 0;

    const lines: InvoiceLine[] = productLines.map((item) => {
      const taxable = money(item.taxable_amount);
      const tax = money(item.tax_amount);
      // Re-split rather than trusting the order's columns — see the doc comment.
      const split = gst ? splitGst(tax, sellerStateCode, placeOfSupply) : { cgst: 0, sgst: 0, igst: 0 };
      taxableTotal += taxable;
      taxTotal += tax;
      cgstTotal += split.cgst;
      sgstTotal += split.sgst;
      igstTotal += split.igst;

      return {
        description: item.product_name,
        variantTitle: item.variant_title,
        hsnCode: item.hsn_code,
        quantity: item.quantity,
        unitPrice: money(item.unit_price),
        discount: money(item.discount_amount),
        taxableValue: taxable,
        taxRate: money(item.tax_rate),
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        tax,
        total: money(item.line_total),
      };
    });

    // Tax on delivery: GST or VAT inside the delivery charge (class-rate
    // stores), or sales tax added on top of it (destination regimes). Either
    // way the invoice shows delivery net of its tax and the tax in the tax
    // columns — split into CGST/SGST or IGST like the goods. Which of the two
    // it was is read off the grand total: whichever reading it agrees with.
    const grandTotal = money(order.grand_total);
    const shippingTax = money(order.shipping_tax);
    const readingIncluded = Math.abs(grandTotal - (taxableTotal + taxTotal + shipping + codFee));
    const readingAdded = Math.abs(grandTotal - (taxableTotal + taxTotal + shipping + shippingTax + codFee));
    const shippingIncludesTax = shippingTax > 0 && readingIncluded < readingAdded;
    const shippingNet = shippingIncludesTax ? money(shipping - shippingTax) : shipping;
    if (shippingTax > 0 && gst) {
      const split = splitGst(shippingTax, sellerStateCode, placeOfSupply);
      cgstTotal += split.cgst;
      sgstTotal += split.sgst;
      igstTotal += split.igst;
    }
    taxTotal += shippingTax;
    const computed = money(taxableTotal + taxTotal + shippingNet + codFee);
    // The difference between the sum of the parts and what was charged. It is
    // almost always a paisa or two from rounding, and printing it is what makes
    // the invoice foot rather than being quietly off.
    const roundOff = money(grandTotal - computed);

    const invoiceNumber = await shipmentsRepository.nextNumber('invoice');
    const invoiceDate = new Date();

    const pdf = await renderInvoicePdf({
      brand: shop.name,
      presentation,
      currency: order.currency,
      locale: shop.locale,
      invoiceNumber,
      invoiceType: 'tax_invoice',
      invoiceDate,
      orderNumber: order.order_number,
      orderDate: order.placed_at ? new Date(order.placed_at) : null,
      placeOfSupply,
      seller: {
        name: sellerName,
        gstin: sellerGstin,
        address: settings.seller_address || [location?.line1, location?.city, location?.state, location?.pincode].filter(Boolean).join(', '),
        stateCode: sellerStateCode,
        phone: location?.contact_phone ?? null,
      },
      buyer: {
        name: [billTo?.first_name, billTo?.last_name].filter(Boolean).join(' ') || 'Customer',
        gstin: billTo?.gstin ?? null,
        address: [billTo?.line1, billTo?.line2, billTo?.city, billTo?.state, billTo?.pincode]
          .filter(Boolean)
          .join(', '),
        stateCode: placeOfSupply,
        phone: billTo?.phone ?? order.contact_phone,
        email: billTo?.email ?? order.contact_email,
      },
      lines,
      totals: {
        taxableValue: money(taxableTotal),
        cgst: money(cgstTotal),
        sgst: money(sgstTotal),
        igst: money(igstTotal),
        tax: money(taxTotal),
        shipping: shippingNet,
        codFee,
        roundOff,
        grandTotal,
      },
    });

    const key = `shops/${tenancy.current().publicId}/invoices/${invoiceDate.getFullYear()}/${String(invoiceDate.getMonth() + 1).padStart(2, '0')}/${invoiceNumber}-${randomUUID().slice(0, 8)}.pdf`;
    await storage.put(key, pdf, 'application/pdf');

    const id = await withTransaction(async (tx) => {
      const mediaId = await invoicesRepository.storePdfMedia(
        {
          disk: storage.name,
          key,
          bytes: pdf.length,
          filename: `${invoiceNumber}.pdf`,
          title: `${gst ? 'Tax invoice' : 'Invoice'} ${invoiceNumber} · ${order.order_number}`,
        },
        tx,
      );

      const invoiceId = await invoicesRepository.create(
        {
          orderId,
          invoiceNumber,
          invoiceType: 'tax_invoice',
          parentInvoiceId: null,
          invoiceDate: invoiceDate.toISOString().slice(0, 10),
          sellerGstin,
          sellerLegalName: sellerName,
          buyerGstin: billTo?.gstin ?? null,
          placeOfSupply,
          taxableValue: money(taxableTotal),
          cgst: money(cgstTotal),
          sgst: money(sgstTotal),
          igst: money(igstTotal),
          tax: money(taxTotal),
          regime: presentation.regime,
          currency: order.currency,
          roundOff,
          totalAmount: grandTotal,
          pdfMediaId: mediaId,
        },
        tx,
      );

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'invoice.issued',
          entityType: 'invoice',
          entityId: invoiceId,
          summary: `Issued ${invoiceNumber} for ${order.order_number} (${grandTotal})`,
          context: { request_id: meta.requestId, place_of_supply: placeOfSupply },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return invoiceId;
    });

    const row = await invoicesRepository.findById(id);
    return { invoice: present(row!), already_existed: false };
  },

  /**
   * A credit note against an issued invoice.
   *
   * Refunds do not amend the original invoice — under GST you cannot edit an
   * issued one. A credit note is its own numbered document that reverses part
   * or all of it, and it inherits the original's tax split so the reversal
   * lands in the same buckets the sale did.
   */
  async issueCreditNote(
    invoiceId: number,
    input: { amount: number; reason: string },
    actor: AuthenticatedAdmin,
    meta: ActorMeta,
  ) {
    const parent = await invoicesRepository.findById(invoiceId);
    if (!parent) throw ApiError.notFound('Invoice');
    if (parent.invoice_type !== 'tax_invoice') {
      throw ApiError.conflict('A credit note can only be raised against a tax invoice.');
    }
    if (parent.status !== 'issued') {
      throw ApiError.conflict(`That invoice is "${parent.status}" — nothing to credit.`, 'INVALID_TRANSITION');
    }

    const parentTotal = money(parent.total_amount);
    if (input.amount <= 0 || input.amount > parentTotal) {
      throw ApiError.validation({
        amount: [`A credit note has to be more than zero and at most the invoice total of ${formatMoney(parentTotal)}.`],
      });
    }

    const order = await ordersRepository.findById(parent.order_id);
    if (!order) throw ApiError.notFound('Order');

    const [items, addresses, settings, location] = await Promise.all([
      ordersRepository.items(parent.order_id),
      ordersRepository.addresses(parent.order_id),
      invoicesRepository.settings(),
      shipmentsRepository.defaultLocation(),
    ]);
    const billTo =
      addresses.find((address) => address.address_type === 'billing') ??
      addresses.find((address) => address.address_type === 'shipping');

    // The credited amount is tax-inclusive, so the tax inside it is extracted at
    // the invoice's own effective rate rather than added on top.
    const effectiveRate = parentTotal > 0 ? (parentTotal - money(parent.taxable_value)) / parentTotal : 0;
    const creditedTax = money(input.amount * effectiveRate);
    const creditedTaxable = money(input.amount - creditedTax);
    const shop = tenancy.current();
    const presentation = presentationFor(parent.tax_regime ?? shop.taxEngine);
    const gst = presentation.gstSplit;
    const noSplit = { cgst: 0, sgst: 0, igst: 0 };
    const split = gst ? splitGst(creditedTax, parent.seller_gstin?.slice(0, 2) ?? null, parent.place_of_supply) : noSplit;

    const creditNumber = await shipmentsRepository.nextNumber('credit_note');
    const invoiceDate = new Date();

    const productLines = items.filter((item) => item.line_type !== 'shipping');
    const proportion = parentTotal > 0 ? input.amount / parentTotal : 0;

    const pdf = await renderInvoicePdf({
      brand: shop.name,
      presentation,
      currency: parent.currency ?? order.currency,
      locale: shop.locale,
      invoiceNumber: creditNumber,
      invoiceType: 'credit_note',
      invoiceDate,
      orderNumber: order.order_number,
      orderDate: order.placed_at ? new Date(order.placed_at) : null,
      placeOfSupply: parent.place_of_supply,
      againstInvoiceNumber: parent.invoice_number,
      seller: {
        name: parent.seller_legal_name ?? settings.seller_legal_name ?? shop.name,
        gstin: parent.seller_gstin,
        address: settings.seller_address ?? '',
        stateCode: parent.seller_gstin?.slice(0, 2) ?? location?.state_code ?? null,
      },
      buyer: {
        name: [billTo?.first_name, billTo?.last_name].filter(Boolean).join(' ') || 'Customer',
        gstin: parent.buyer_gstin,
        address: [billTo?.line1, billTo?.city, billTo?.state, billTo?.pincode].filter(Boolean).join(', '),
        stateCode: parent.place_of_supply,
        phone: billTo?.phone ?? order.contact_phone,
      },
      // Lines are shown proportionally, which is what a partial credit against a
      // multi-line invoice means when the refund was not tied to one item.
      lines: productLines.map((item) => {
        const lineCredit = money(money(item.line_total) * proportion);
        const lineTax = money(lineCredit * effectiveRate);
        const lineSplit = gst ? splitGst(lineTax, parent.seller_gstin?.slice(0, 2) ?? null, parent.place_of_supply) : noSplit;
        return {
          description: item.product_name,
          variantTitle: item.variant_title,
          hsnCode: item.hsn_code,
          quantity: item.quantity,
          unitPrice: money(item.unit_price),
          discount: 0,
          taxableValue: money(lineCredit - lineTax),
          taxRate: money(item.tax_rate),
          cgst: lineSplit.cgst,
          sgst: lineSplit.sgst,
          igst: lineSplit.igst,
          tax: lineTax,
          total: lineCredit,
        };
      }),
      totals: {
        taxableValue: creditedTaxable,
        cgst: split.cgst,
        sgst: split.sgst,
        igst: split.igst,
        tax: creditedTax,
        shipping: 0,
        codFee: 0,
        roundOff: 0,
        grandTotal: money(input.amount),
      },
      notes: `Reason: ${input.reason}`,
    });

    const key = `shops/${tenancy.current().publicId}/invoices/${invoiceDate.getFullYear()}/${String(invoiceDate.getMonth() + 1).padStart(2, '0')}/${creditNumber}-${randomUUID().slice(0, 8)}.pdf`;
    await storage.put(key, pdf, 'application/pdf');

    const id = await withTransaction(async (tx) => {
      const mediaId = await invoicesRepository.storePdfMedia(
        {
          disk: storage.name,
          key,
          bytes: pdf.length,
          filename: `${creditNumber}.pdf`,
          title: `Credit note ${creditNumber} · ${order.order_number}`,
        },
        tx,
      );

      const creditId = await invoicesRepository.create(
        {
          orderId: parent.order_id,
          invoiceNumber: creditNumber,
          invoiceType: 'credit_note',
          parentInvoiceId: parent.id,
          invoiceDate: invoiceDate.toISOString().slice(0, 10),
          sellerGstin: parent.seller_gstin,
          sellerLegalName: parent.seller_legal_name ?? shop.name,
          buyerGstin: parent.buyer_gstin,
          placeOfSupply: parent.place_of_supply,
          taxableValue: creditedTaxable,
          cgst: split.cgst,
          sgst: split.sgst,
          igst: split.igst,
          tax: creditedTax,
          regime: presentation.regime,
          currency: parent.currency ?? order.currency,
          roundOff: 0,
          totalAmount: money(input.amount),
          pdfMediaId: mediaId,
        },
        tx,
      );

      await auditService.log(
        {
          actorId: actor.id,
          actorLabel: actor.email,
          action: 'invoice.credit_note_issued',
          entityType: 'invoice',
          entityId: creditId,
          summary: `Issued ${creditNumber} against ${parent.invoice_number} for ${input.amount}`,
          context: { request_id: meta.requestId, reason: input.reason },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );

      return creditId;
    });

    const row = await invoicesRepository.findById(id);
    return { invoice: present(row!) };
  },
};
