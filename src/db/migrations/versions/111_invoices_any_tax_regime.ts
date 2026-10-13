import { addColumnIfMissing, rows } from '../helpers';
import type { TsMigration } from '../runner';
import type { RowDataPacket } from 'mysql2/promise';

/**
 * Invoices outside Indian GST.
 *
 * The invoice table recorded tax only as CGST/SGST/IGST and a GSTIN, sized for
 * a 15-character Indian number. A UK or EU shop issues VAT invoices with a VAT
 * number (up to ~14 characters plus a country prefix), an Australian shop an
 * ABN, a US shop none at all. So:
 *
 *   tax_amount  — total tax on the document, whatever the regime (backfilled
 *                 as CGST + SGST + IGST for existing invoices);
 *   tax_regime  — which rules the document follows (the shop's tax engine);
 *   currency    — what it is denominated in;
 *   tax id columns widened to 32; place_of_supply to a region code.
 *
 * The GST columns stay: Indian invoices still split tax that way.
 */

interface ColumnRow extends RowDataPacket {
  table_name: string;
  column_name: string;
  is_nullable: 'YES' | 'NO';
  character_maximum_length: number | null;
}

const WIDEN: [string, string, string][] = [
  ['invoices', 'seller_gstin', 'VARCHAR(32)'],
  ['invoices', 'buyer_gstin', 'VARCHAR(32)'],
  ['invoices', 'place_of_supply', 'VARCHAR(10)'],
  ['order_addresses', 'gstin', 'VARCHAR(32)'],
  ['inventory_locations', 'gstin', 'VARCHAR(32)'],
];

const migration: TsMigration = {
  description: 'Invoices record tax for any regime, with room for any tax id',
  async up(ctx) {
    await addColumnIfMissing(ctx, 'invoices', 'tax_amount', 'DECIMAL(12,2) NOT NULL DEFAULT 0.00 AFTER `igst_amount`');
    await addColumnIfMissing(ctx, 'invoices', 'tax_regime', "VARCHAR(20) NOT NULL DEFAULT 'in_gst' AFTER `invoice_type`");
    await addColumnIfMissing(ctx, 'invoices', 'currency', "CHAR(3) NOT NULL DEFAULT 'INR' AFTER `tax_regime`");
    await ctx.exec('UPDATE `invoices` SET `tax_amount` = `cgst_amount` + `sgst_amount` + `igst_amount` WHERE `tax_amount` = 0');

    const columns = await rows<ColumnRow>(
      ctx,
      `SELECT TABLE_NAME AS table_name, COLUMN_NAME AS column_name, IS_NULLABLE AS is_nullable,
              CHARACTER_MAXIMUM_LENGTH AS character_maximum_length
         FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`,
      [ctx.database],
    );
    for (const [table, column, type] of WIDEN) {
      const found = columns.find((row) => row.table_name === table && row.column_name === column);
      const target = Number(/\((\d+)\)/.exec(type)?.[1] ?? 0);
      if (!found || Number(found.character_maximum_length ?? 0) >= target) continue;
      await ctx.exec(`ALTER TABLE \`${table}\` MODIFY \`${column}\` ${type} ${found.is_nullable === 'YES' ? 'NULL' : 'NOT NULL'}`);
    }
  },
};

export default migration;
