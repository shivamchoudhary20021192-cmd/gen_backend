import PDFDocument from 'pdfkit';
import { amountInWords, stateNameFor } from '../../core/india';

export interface InvoiceParty {
  name: string;
  gstin: string | null;
  address: string;
  stateCode: string | null;
  phone?: string | null;
  email?: string | null;
}

export interface InvoiceLine {
  description: string;
  variantTitle: string | null;
  hsnCode: string | null;
  quantity: number;
  unitPrice: number;
  discount: number;
  taxableValue: number;
  taxRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Total tax on the line, whatever the regime. */
  tax: number;
  total: number;
}

/**
 * How a tax regime is written on the document. Only Indian GST splits tax
 * into CGST/SGST/IGST and prints the total in words; everything else shows one
 * tax column under its own name.
 */
export interface TaxPresentation {
  regime: string;
  title: string;
  taxLabel: string;
  taxIdLabel: string | null;
  gstSplit: boolean;
  amountInWords: boolean;
}

export function presentationFor(engine: string): TaxPresentation {
  switch (engine) {
    case 'in_gst':
      return { regime: engine, title: 'TAX INVOICE', taxLabel: 'GST', taxIdLabel: 'GSTIN', gstSplit: true, amountInWords: true };
    case 'uk_vat':
    case 'eu_vat':
    case 'ae_vat':
      return { regime: engine, title: 'VAT INVOICE', taxLabel: 'VAT', taxIdLabel: 'VAT no.', gstSplit: false, amountInWords: false };
    case 'au_gst':
      return { regime: engine, title: 'TAX INVOICE', taxLabel: 'GST', taxIdLabel: 'ABN', gstSplit: false, amountInWords: false };
    case 'sg_gst':
      return { regime: engine, title: 'TAX INVOICE', taxLabel: 'GST', taxIdLabel: 'GST reg. no.', gstSplit: false, amountInWords: false };
    case 'ca_gst':
      return { regime: engine, title: 'INVOICE', taxLabel: 'GST/HST', taxIdLabel: 'GST/HST no.', gstSplit: false, amountInWords: false };
    case 'us_sales_tax':
      return { regime: engine, title: 'INVOICE', taxLabel: 'Sales tax', taxIdLabel: null, gstSplit: false, amountInWords: false };
    default:
      return { regime: engine, title: 'INVOICE', taxLabel: 'Tax', taxIdLabel: 'Tax ID', gstSplit: false, amountInWords: false };
  }
}

export interface InvoiceDocument {
  /** The store's name, printed as the document's masthead. */
  brand: string;
  presentation: TaxPresentation;
  currency: string;
  locale: string;
  invoiceNumber: string;
  invoiceType: 'tax_invoice' | 'credit_note';
  invoiceDate: Date;
  orderNumber: string;
  orderDate: Date | null;
  placeOfSupply: string | null;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: InvoiceLine[];
  totals: {
    taxableValue: number;
    cgst: number;
    sgst: number;
    igst: number;
    tax: number;
    shipping: number;
    codFee: number;
    roundOff: number;
    grandTotal: number;
  };
  /** Printed on a credit note so it can be tied to what it reverses. */
  againstInvoiceNumber?: string | null;
  notes?: string | null;
}

const INK = '#1A1208';
const MUTED = '#6B6257';
const RULE = '#D8D2C8';
const PAGE_MARGIN = 40;

/**
 * Renders an invoice under the shop's tax regime.
 *
 * For Indian GST (the regime this renderer was first written for):
 * The layout is dictated by what Rule 46 of the CGST Rules requires on the face
 * of an invoice — supplier and recipient with GSTINs, a consecutive serial
 * number, HSN per line, taxable value and tax split per rate, place of supply,
 * and the total in words. This is not a design exercise; a pretty invoice that
 * omits the place of supply is not a valid one.
 *
 * Intra-state supplies show CGST and SGST columns; inter-state shows IGST. Both
 * are never shown together, because a supply is one or the other and printing
 * empty columns invites someone to fill them in.
 *
 * Every other regime gets one tax column under its own name (VAT, GST, sales
 * tax), the seller's tax id under its own label, and amounts in the shop's
 * currency and locale.
 */
export function renderInvoicePdf(doc: InvoiceDocument): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
    const chunks: Buffer[] = [];
    pdf.on('data', (chunk: Buffer) => chunks.push(chunk));
    pdf.on('end', () => resolve(Buffer.concat(chunks)));
    pdf.on('error', reject);

    const isCreditNote = doc.invoiceType === 'credit_note';
    const gst = doc.presentation.gstSplit;
    const intraState = doc.totals.igst === 0;
    const money = moneyFormatter(doc.currency, doc.locale);
    const number = (value: number) => value.toFixed(2);
    const pageWidth = pdf.page.width - PAGE_MARGIN * 2;
    const right = PAGE_MARGIN + pageWidth;

    // ── header ───────────────────────────────────────────────────────────────
    pdf.font('Helvetica-Bold').fontSize(18).fillColor(INK).text(doc.brand.toUpperCase(), PAGE_MARGIN, PAGE_MARGIN, {
      characterSpacing: 3,
      width: pageWidth * 0.55,
    });

    pdf
      .font('Helvetica-Bold')
      .fontSize(13)
      .fillColor(INK)
      .text(isCreditNote ? 'CREDIT NOTE' : doc.presentation.title, PAGE_MARGIN, PAGE_MARGIN + 4, {
        width: pageWidth,
        align: 'right',
      });
    pdf
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        [
          `${isCreditNote ? 'Credit note' : 'Invoice'} no.  ${doc.invoiceNumber}`,
          `Date  ${formatDate(doc.invoiceDate, doc.locale)}`,
          `Order  ${doc.orderNumber}`,
          doc.againstInvoiceNumber ? `Against invoice  ${doc.againstInvoiceNumber}` : null,
        ]
          .filter(Boolean)
          .join('\n'),
        PAGE_MARGIN,
        pdf.y + 4,
        { width: pageWidth, align: 'right' },
      );

    let y = Math.max(pdf.y, PAGE_MARGIN + 62) + 12;
    rule(pdf, y, right);
    y += 12;

    // ── parties ──────────────────────────────────────────────────────────────
    const columnWidth = (pageWidth - 20) / 2;
    const partyTop = y;

    party(pdf, gst ? 'Supplier' : 'From', doc.seller, PAGE_MARGIN, partyTop, columnWidth, doc.presentation);
    const sellerBottom = pdf.y;
    party(pdf, isCreditNote ? 'Credited to' : 'Billed to', doc.buyer, PAGE_MARGIN + columnWidth + 20, partyTop, columnWidth, doc.presentation);

    y = Math.max(sellerBottom, pdf.y) + 10;

    // Place of supply is required on the face of the invoice, and it is what
    // justifies the CGST/SGST versus IGST choice below.
    if (gst) pdf
      .font('Helvetica')
      .fontSize(8.5)
      .fillColor(MUTED)
      .text(
        `Place of supply:  ${doc.placeOfSupply ? `${doc.placeOfSupply} — ${stateNameFor(doc.placeOfSupply) ?? 'Unknown'}` : 'Not recorded'}` +
          `     ·     Supply type:  ${intraState ? 'Intra-state' : 'Inter-state'}` +
          `     ·     Reverse charge:  No`,
        PAGE_MARGIN,
        y,
        { width: pageWidth },
      );
    y = pdf.y + 10;
    rule(pdf, y, right);
    y += 10;

    // ── line items ───────────────────────────────────────────────────────────
    // Columns are laid out right-to-left from fixed widths so the money always
    // lines up, whatever the description does.
    const cols = !gst
      ? { desc: 214, hsn: 0, qty: 36, rate: 70, taxable: 70, tax: 60, total: 65 }
      : intraState
        ? // Every layout sums to the printable width (A4 less margins, 515pt).
          { desc: 147, hsn: 52, qty: 30, rate: 58, taxable: 62, cgst: 52, sgst: 52, total: 62 }
        : { desc: 161, hsn: 58, qty: 32, rate: 62, taxable: 68, igst: 66, total: 68 };

    const headers: [string, number, 'left' | 'right'][] = !gst
      ? [
          ['Description', cols.desc, 'left'],
          ['Qty', cols.qty, 'right'],
          ['Price', cols.rate, 'right'],
          ['Net', cols.taxable, 'right'],
          [doc.presentation.taxLabel, cols.tax!, 'right'],
          ['Total', cols.total, 'right'],
        ]
      : intraState
      ? [
          ['Description', cols.desc, 'left'],
          ['HSN', cols.hsn, 'left'],
          ['Qty', cols.qty, 'right'],
          ['Rate', cols.rate, 'right'],
          ['Taxable', cols.taxable, 'right'],
          ['CGST', cols.cgst!, 'right'],
          ['SGST', cols.sgst!, 'right'],
          ['Total', cols.total, 'right'],
        ]
      : [
          ['Description', cols.desc, 'left'],
          ['HSN', cols.hsn, 'left'],
          ['Qty', cols.qty, 'right'],
          ['Rate', cols.rate, 'right'],
          ['Taxable', cols.taxable, 'right'],
          ['IGST', cols.igst!, 'right'],
          ['Total', cols.total, 'right'],
        ];

    pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED);
    let x = PAGE_MARGIN;
    for (const [label, width, align] of headers) {
      pdf.text(label.toUpperCase(), x, y, { width, align, characterSpacing: 0.6 });
      x += width;
    }
    y = pdf.y + 5;
    rule(pdf, y, right);
    y += 6;

    pdf.font('Helvetica').fontSize(8.5).fillColor(INK);
    for (const line of doc.lines) {
      // A long product name must not overwrite the row below it, so the row
      // height comes from what the description actually needed.
      const descriptionHeight = pdf.heightOfString(line.description, { width: cols.desc - 6 });
      const rowHeight = Math.max(descriptionHeight + (line.variantTitle ? 9 : 0), 14);

      if (y + rowHeight > pdf.page.height - 170) {
        pdf.addPage();
        y = PAGE_MARGIN;
      }

      const values: [string, number, 'left' | 'right'][] = !gst
        ? [
            [line.description, cols.desc, 'left'],
            [String(line.quantity), cols.qty, 'right'],
            [number(line.unitPrice), cols.rate, 'right'],
            [number(line.taxableValue), cols.taxable, 'right'],
            [number(line.tax), cols.tax!, 'right'],
            [number(line.total), cols.total, 'right'],
          ]
        : intraState
        ? [
            [line.description, cols.desc, 'left'],
            [line.hsnCode ?? '—', cols.hsn, 'left'],
            [String(line.quantity), cols.qty, 'right'],
            [line.unitPrice.toFixed(2), cols.rate, 'right'],
            [line.taxableValue.toFixed(2), cols.taxable, 'right'],
            [line.cgst.toFixed(2), cols.cgst!, 'right'],
            [line.sgst.toFixed(2), cols.sgst!, 'right'],
            [line.total.toFixed(2), cols.total, 'right'],
          ]
        : [
            [line.description, cols.desc, 'left'],
            [line.hsnCode ?? '—', cols.hsn, 'left'],
            [String(line.quantity), cols.qty, 'right'],
            [line.unitPrice.toFixed(2), cols.rate, 'right'],
            [line.taxableValue.toFixed(2), cols.taxable, 'right'],
            [line.igst.toFixed(2), cols.igst!, 'right'],
            [line.total.toFixed(2), cols.total, 'right'],
          ];

      x = PAGE_MARGIN;
      for (const [value, width, align] of values) {
        pdf.text(value, x, y, { width: width - 6, align });
        x += width;
      }

      if (line.variantTitle) {
        pdf.font('Helvetica').fontSize(7).fillColor(MUTED).text(line.variantTitle, PAGE_MARGIN, y + descriptionHeight, {
          width: cols.desc - 6,
        });
        pdf.font('Helvetica').fontSize(8.5).fillColor(INK);
      }

      // The tax rate belongs on the invoice per line, not only in the total.
      pdf
        .font('Helvetica')
        .fontSize(6.5)
        .fillColor(MUTED)
        .text(`@ ${line.taxRate}%`, PAGE_MARGIN + cols.desc + cols.hsn + (gst ? 0 : cols.qty + cols.rate + cols.taxable), y + 10, {
          width: gst ? cols.qty + cols.rate : cols.tax!,
          align: 'right',
        });
      pdf.font('Helvetica').fontSize(8.5).fillColor(INK);

      y += rowHeight + 6;
    }

    rule(pdf, y, right);
    y += 10;

    // ── totals ───────────────────────────────────────────────────────────────
    const totalsLeft = right - 220;
    const totalRows: [string, number][] = [
      [gst ? 'Taxable value' : 'Net', doc.totals.taxableValue],
      ...(!gst
        ? ([[doc.presentation.taxLabel, doc.totals.tax]] as [string, number][])
        : intraState
        ? ([
            ['CGST', doc.totals.cgst],
            ['SGST', doc.totals.sgst],
          ] as [string, number][])
        : ([['IGST', doc.totals.igst]] as [string, number][])),
      ...(doc.totals.shipping !== 0 ? ([['Delivery', doc.totals.shipping]] as [string, number][]) : []),
      ...(doc.totals.codFee !== 0 ? ([['Cash handling', doc.totals.codFee]] as [string, number][]) : []),
      ...(doc.totals.roundOff !== 0 ? ([['Round off', doc.totals.roundOff]] as [string, number][]) : []),
    ];

    pdf.font('Helvetica').fontSize(8.5);
    for (const [label, value] of totalRows) {
      pdf.fillColor(MUTED).text(label, totalsLeft, y, { width: 130, align: 'left' });
      pdf.fillColor(INK).text(money(value), totalsLeft + 130, y, { width: 90, align: 'right' });
      y += 13;
    }

    y += 2;
    rule(pdf, y, right, totalsLeft);
    y += 7;
    pdf.font('Helvetica-Bold').fontSize(11).fillColor(INK);
    pdf.text(isCreditNote ? 'Total credited' : 'Total', totalsLeft, y, { width: 130, align: 'left' });
    pdf.text(money(doc.totals.grandTotal), totalsLeft + 130, y, { width: 90, align: 'right' });
    y += 20;

    // Required on an Indian tax invoice; noise anywhere else.
    if (doc.presentation.amountInWords) {
      pdf
        .font('Helvetica-Oblique')
        .fontSize(8)
        .fillColor(MUTED)
        .text(`Amount in words: ${amountInWords(doc.totals.grandTotal)}`, PAGE_MARGIN, y, { width: pageWidth });
      y = pdf.y + 14;
    }

    // ── footer ───────────────────────────────────────────────────────────────
    rule(pdf, y, right);
    y += 10;

    pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text('DECLARATION', PAGE_MARGIN, y, { characterSpacing: 0.6 });
    pdf
      .font('Helvetica')
      .fontSize(7.5)
      .fillColor(MUTED)
      .text(
        isCreditNote
          ? 'This credit note reverses the charges listed above against the referenced tax invoice.'
          : 'We declare that this invoice shows the actual price of the goods described and that all particulars are true and correct. Goods once sold are returnable only within the published returns window.',
        PAGE_MARGIN,
        pdf.y + 2,
        { width: pageWidth - 170 },
      );

    pdf
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`For ${doc.seller.name}`, right - 160, y, { width: 160, align: 'right' });
    pdf.text('Authorised signatory', right - 160, y + 42, { width: 160, align: 'right' });

    if (doc.notes) {
      pdf.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(doc.notes, PAGE_MARGIN, pdf.page.height - 96, {
        width: pageWidth,
      });
    }

    pdf
      .font('Helvetica')
      .fontSize(7)
      .fillColor(MUTED)
      .text(
        'This is a computer-generated document and does not require a physical signature.',
        PAGE_MARGIN,
        pdf.page.height - 62,
        { width: pageWidth, align: 'center' },
      );

    pdf.end();
  });
}

function rule(pdf: PDFKit.PDFDocument, y: number, right: number, left = PAGE_MARGIN): void {
  pdf.moveTo(left, y).lineTo(right, y).lineWidth(0.5).strokeColor(RULE).stroke();
}

function party(
  pdf: PDFKit.PDFDocument,
  heading: string,
  detail: InvoiceParty,
  x: number,
  y: number,
  width: number,
  presentation: TaxPresentation,
): void {
  pdf.font('Helvetica-Bold').fontSize(7.5).fillColor(MUTED).text(heading.toUpperCase(), x, y, {
    width,
    characterSpacing: 0.6,
  });
  pdf.font('Helvetica-Bold').fontSize(9.5).fillColor(INK).text(detail.name, x, pdf.y + 3, { width });
  pdf
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      [
        detail.address,
        detail.gstin && presentation.taxIdLabel ? `${presentation.taxIdLabel}  ${detail.gstin}` : null,
        detail.stateCode && presentation.gstSplit ? `State code  ${detail.stateCode}` : null,
        detail.phone ? `Phone  ${detail.phone}` : null,
        detail.email ?? null,
      ]
        .filter(Boolean)
        .join('\n'),
      x,
      pdf.y + 2,
      { width },
    );
}

function formatDate(date: Date, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  } catch {
    return new Intl.DateTimeFormat('en', { day: '2-digit', month: 'short', year: 'numeric' }).format(date);
  }
}

/**
 * Money for the document. The PDF's standard fonts (WinAnsi) have £, € and $
 * but no ₹ glyph — printed, it came out as a stray "¹" — so rupees are
 * written "Rs." with the Indian lakh grouping, as Indian invoices commonly are.
 */
function moneyFormatter(currency: string, locale: string): (value: number) => string {
  if (currency === 'INR') {
    const grouping = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (value: number) => `Rs. ${grouping.format(value)}`;
  }
  let format: Intl.NumberFormat;
  try {
    format = new Intl.NumberFormat(locale, { style: 'currency', currency, minimumFractionDigits: 2 });
  } catch {
    format = new Intl.NumberFormat('en', { style: 'currency', currency, minimumFractionDigits: 2 });
  }
  return (value: number) => format.format(value);
}
