/**
 * Writes docs/DB_SCHEMA.md from the live database — every table, column,
 * index and foreign key, grouped by domain, with the control plane and the
 * tenant (pod) tables told apart. Generated, so it cannot drift from the
 * migrations: run it after migrating.
 *
 *   DB_NAME=veylog_upgrade npm run docs:schema
 *
 * Read-only: it runs SELECTs against information_schema and nothing else.
 */
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';
import { env, projectRoot } from '../src/config/env';
import { CONTROL_PLANE_TABLES } from '../src/platform/tenancy/tables';

interface Column {
  TABLE_NAME: string;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  IS_NULLABLE: 'YES' | 'NO';
  COLUMN_DEFAULT: string | null;
  COLUMN_KEY: string;
  EXTRA: string;
  COLUMN_COMMENT: string;
}
interface Table {
  TABLE_NAME: string;
  TABLE_ROWS: number;
  TABLE_COMMENT: string;
}
interface Index {
  TABLE_NAME: string;
  INDEX_NAME: string;
  NON_UNIQUE: number;
  COLUMN_NAME: string;
  SEQ_IN_INDEX: number;
}
interface ForeignKey {
  TABLE_NAME: string;
  CONSTRAINT_NAME: string;
  COLUMN_NAME: string;
  REFERENCED_TABLE_NAME: string;
  REFERENCED_COLUMN_NAME: string;
}

/** Domain groups, first match wins. */
const DOMAINS: [string, RegExp][] = [
  ['Online Store and themes', /^(theme_library|shop_theme|contact_messages|shop_brand|seo_meta|shop_languages$|translations$)/],
  ['Platform: shops, plans, identities, billing', /^(shops?|shop_domains|domain_events|domain_registrations|storefront_versions|shop_setup_tasks|organizations|plans?|plan_|pods|subscriptions|platform_|billing_|identities|admin_|password_resets|email_|rate_limits|api_rate_buckets|jobs|job_|feature_flags|maintenance_runs|permissions|roles|role_permissions|user_sidebar|otp_)/],
  ['Apps, webhooks and integrations', /^(apps?|app_|oauth_|webhook|integration|storefront_access|events|event_|inbound_)/],
  ['Catalogue', /^(products?|product_|variants?|variant_|options?|option_|categories|category_|collections?|collection_|brands?|attributes?|attribute_|metafield|lookup|search_|ingredients?|concerns?|skin_|shades?|routines?|bundle_|tags|taggables|claims?|claim_|adverse_events|quiz_)/],
  ['Inventory and fulfilment', /^(inventory|stock|warehouses?|locations?|shipments?|shipment_|shipping|couriers?|courier_|pickup|delivery|zones?|pincode|cod_rules)/],
  ['Orders, carts, payments, returns', /^(orders?|order_|carts?|cart_|payments?|payment_|refunds?|returns?|return_|invoices?|invoice_|checkout|gift|number_sequences)/],
  ['Customers and marketing', /^(customers?|customer_|segments?|segment_|newsletter|consents?|coupons?|coupon_|discounts?|discount_|loyalty|referral|wishlist|reengagement|campaigns?|campaign_|messag|notification|abandon|back_in_stock|data_requests|support_|ticket_)/],
  ['Tax and markets', /^(tax|markets?|market_|exchange_rates|fx_)/],
  ['Content (CMS)', /^(cms_|content_|page_|pages?|banners?|announcement|faqs?|faq_|articles?|blogs?|creators?|merch|shelves|shelf_|menu|navigation|sidebar)/],
  ['Reviews', /^(reviews?|review_)/],
  ['Settings, audit and system', /^(settings?|audit|activity|sequences|media|schema_migrations|migrations|import_jobs|export_jobs)/],
];

function domainOf(table: string): string {
  return DOMAINS.find(([, pattern]) => pattern.test(table))?.[0] ?? 'Other';
}

const escape = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');

async function main() {
  const connection = await mysql.createConnection({ host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password, database: env.db.database });
  const schema = env.db.database;
  const [tables] = await connection.query<(Table & mysql.RowDataPacket)[]>(
    "SELECT TABLE_NAME, TABLE_ROWS, TABLE_COMMENT FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME",
    [schema],
  );
  const [columns] = await connection.query<(Column & mysql.RowDataPacket)[]>(
    'SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLUMN_COMMENT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION',
    [schema],
  );
  const [indexes] = await connection.query<(Index & mysql.RowDataPacket)[]>(
    'SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, COLUMN_NAME, SEQ_IN_INDEX FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX',
    [schema],
  );
  const [foreignKeys] = await connection.query<(ForeignKey & mysql.RowDataPacket)[]>(
    'SELECT TABLE_NAME, CONSTRAINT_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL ORDER BY TABLE_NAME, CONSTRAINT_NAME, ORDINAL_POSITION',
    [schema],
  );
  const [[version]] = await connection.query<mysql.RowDataPacket[]>('SELECT VERSION() AS version');
  const [migrations] = await connection.query<mysql.RowDataPacket[]>('SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1').catch(() => [[]] as unknown as [mysql.RowDataPacket[]]);
  await connection.end();

  const controlPlane = new Set<string>(CONTROL_PLANE_TABLES);
  const byTable = <T extends { TABLE_NAME: string }>(rows: T[]) => {
    const map = new Map<string, T[]>();
    for (const row of rows) map.set(row.TABLE_NAME, [...(map.get(row.TABLE_NAME) ?? []), row]);
    return map;
  };
  const columnsOf = byTable(columns);
  const indexesOf = byTable(indexes);
  const fksOf = byTable(foreignKeys);

  const groups = new Map<string, Table[]>();
  for (const table of tables) groups.set(domainOf(table.TABLE_NAME), [...(groups.get(domainOf(table.TABLE_NAME)) ?? []), table]);
  const order = [...DOMAINS.map(([name]) => name), 'Other'].filter((name) => groups.has(name));

  const out: string[] = [];
  out.push('# Database schema');
  out.push('');
  out.push(`Generated from \`${schema}\` (MySQL ${String(version.version)}) by \`scripts/db-schema-doc.ts\`${migrations[0] ? `, at migration \`${String(migrations[0].name)}\`` : ''}. Do not edit by hand — run \`npm run docs:schema\` after migrating.`);
  out.push('');
  out.push(`**${tables.length} tables**: ${tables.filter((table) => controlPlane.has(table.TABLE_NAME)).length} on the control plane (platform-wide, no \`shop_id\`), ${tables.filter((table) => !controlPlane.has(table.TABLE_NAME)).length} per shop on the pods (every row carries \`shop_id\`, every unique key and foreign key includes it).`);
  out.push('');
  out.push('Legend: **PK** primary key · **UQ** unique · **IX** index · **FK** foreign key · ⚙ control-plane table.');
  out.push('');
  out.push('## Contents');
  out.push('');
  for (const name of order) out.push(`- [${name}](#${name.toLowerCase().replace(/[^a-z0-9 -]/g, '').replace(/ /g, '-')}) — ${groups.get(name)!.length} tables`);
  out.push('');

  for (const name of order) {
    out.push(`## ${name}`);
    out.push('');
    for (const table of groups.get(name)!) {
      const tableName = table.TABLE_NAME;
      out.push(`### \`${tableName}\`${controlPlane.has(tableName) ? ' ⚙' : ''}`);
      out.push('');
      if (table.TABLE_COMMENT) out.push(`${table.TABLE_COMMENT}`, '');
      out.push('| Column | Type | Null | Default | Key | Notes |');
      out.push('|---|---|---|---|---|---|');
      for (const column of columnsOf.get(tableName) ?? []) {
        const key = column.COLUMN_KEY === 'PRI' ? 'PK' : column.COLUMN_KEY === 'UNI' ? 'UQ' : column.COLUMN_KEY === 'MUL' ? 'IX' : '';
        const notes = [column.EXTRA, column.COLUMN_COMMENT].filter(Boolean).join(' · ');
        out.push(`| \`${column.COLUMN_NAME}\` | ${escape(column.COLUMN_TYPE)} | ${column.IS_NULLABLE === 'YES' ? 'yes' : ''} | ${column.COLUMN_DEFAULT === null ? '' : `\`${escape(String(column.COLUMN_DEFAULT))}\``} | ${key} | ${escape(notes)} |`);
      }
      const keyed = new Map<string, Index[]>();
      for (const index of indexesOf.get(tableName) ?? []) keyed.set(index.INDEX_NAME, [...(keyed.get(index.INDEX_NAME) ?? []), index]);
      const indexLines = [...keyed.entries()].map(([indexName, parts]) => `${indexName === 'PRIMARY' ? 'PK' : parts[0].NON_UNIQUE ? 'IX' : 'UQ'} \`${indexName}\` (${parts.map((part) => part.COLUMN_NAME).join(', ')})`);
      const constraints = new Map<string, ForeignKey[]>();
      for (const fk of fksOf.get(tableName) ?? []) constraints.set(fk.CONSTRAINT_NAME, [...(constraints.get(fk.CONSTRAINT_NAME) ?? []), fk]);
      const fkLines = [...constraints.values()].map((parts) => `FK (${parts.map((part) => part.COLUMN_NAME).join(', ')}) → \`${parts[0].REFERENCED_TABLE_NAME}\` (${parts.map((part) => part.REFERENCED_COLUMN_NAME).join(', ')})`);
      if (indexLines.length || fkLines.length) {
        out.push('');
        out.push([...indexLines, ...fkLines].map((line) => `- ${line}`).join('\n'));
      }
      out.push('');
    }
  }

  const target = path.join(projectRoot, 'docs', 'DB_SCHEMA.md');
  fs.writeFileSync(target, `${out.join('\n')}\n`);
  console.log(`Wrote ${path.relative(projectRoot, target)}: ${tables.length} tables, ${columns.length} columns, ${foreignKeys.length} foreign-key columns.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
