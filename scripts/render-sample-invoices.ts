/**
 * Renders one sample invoice per tax regime into a folder, for eyeballing the
 * layouts after changing the renderer:
 *
 *   npx tsx scripts/render-sample-invoices.ts ./tmp/invoices
 *
 * Touches no database.
 */
import fs from 'node:fs';
import path from 'node:path';
import { presentationFor, renderInvoicePdf, type InvoiceDocument } from '../src/modules/invoices/invoicePdf';

const outDir = path.resolve(process.argv[2] ?? './tmp/invoices');
fs.mkdirSync(outDir, { recursive: true });

function sample(engine: string, currency: string, locale: string, brand: string, taxRate: number, inclusive: boolean): InvoiceDocument {
  const price = 1180;
  const taxable = inclusive ? Number((price / (1 + taxRate / 100)).toFixed(2)) : price;
  const tax = inclusive ? Number((price - taxable).toFixed(2)) : Number(((price * taxRate) / 100).toFixed(2));
  const gst = engine === 'in_gst';
  return {
    brand,
    presentation: presentationFor(engine),
    currency,
    locale,
    invoiceNumber: 'INV0000042',
    invoiceType: 'tax_invoice',
    invoiceDate: new Date('2026-09-24T10:00:00Z'),
    orderNumber: 'ORD0000042',
    orderDate: new Date('2026-09-22T10:00:00Z'),
    placeOfSupply: gst ? '29' : null,
    seller: {
      name: `${brand} Ltd`,
      gstin: gst ? '29ABCDE1234F1Z5' : engine === 'us_sales_tax' ? null : 'GB123456789',
      address: gst ? '12 MG Road, Bengaluru, Karnataka 560001' : '1 Market Street, San Francisco, CA 94105',
      stateCode: gst ? '29' : null,
    },
    buyer: {
      name: 'Asha Rao',
      gstin: null,
      address: gst ? '4 Residency Road, Bengaluru, Karnataka 560025' : '350 Fifth Avenue, New York, NY 10118',
      stateCode: gst ? '29' : null,
      phone: '9876543210',
      email: 'asha@example.com',
    },
    lines: [
      {
        description: 'Niacinamide Serum',
        variantTitle: '30 ml',
        hsnCode: gst ? '3304' : null,
        quantity: 1,
        unitPrice: price,
        discount: 0,
        taxableValue: taxable,
        taxRate,
        cgst: gst ? tax / 2 : 0,
        sgst: gst ? tax / 2 : 0,
        igst: 0,
        tax,
        total: inclusive ? price : price + tax,
      },
    ],
    totals: {
      taxableValue: taxable,
      cgst: gst ? tax / 2 : 0,
      sgst: gst ? tax / 2 : 0,
      igst: 0,
      tax,
      shipping: 0,
      codFee: 0,
      roundOff: 0,
      grandTotal: inclusive ? price : price + tax,
    },
  };
}

async function main() {
  const samples: [string, InvoiceDocument][] = [
    ['india-gst.pdf', sample('in_gst', 'INR', 'en-IN', 'Lotus Botanics', 18, true)],
    ['us-sales-tax.pdf', sample('us_sales_tax', 'USD', 'en-US', 'Volt Supply', 8.875, false)],
    ['uk-vat.pdf', sample('uk_vat', 'GBP', 'en-GB', 'Thread & Loom', 20, true)],
  ];
  for (const [name, doc] of samples) {
    const pdf = await renderInvoicePdf(doc);
    fs.writeFileSync(path.join(outDir, name), pdf);
    console.log(`${name}  ${pdf.length} bytes`);
  }
}

void main();
