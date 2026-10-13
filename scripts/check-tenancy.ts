/**
 *   npm run check:tenancy            report unscoped SQL, exit 1 if any
 *   npm run check:tenancy -- --list  per-file counts only
 *
 * The static half of tenant isolation. The runtime guard stops an unscoped
 * query when it runs; this finds it before it ships, by reading every SQL
 * string in src/ and flagging the ones that touch a shop-owned table without
 * mentioning shop_id.
 *
 * Works per function: a query assembled from fragments (a shared SELECT
 * constant plus a WHERE built below it) passes when the function that runs it
 * scopes by shop anywhere — in another fragment, or by calling shopId(). A
 * fragment that is genuinely scoped by its caller can say so with a
 * `// tenancy: scoped by caller` comment on the line above.
 *
 * Tenant tables are read from the database (every table with a shop_id,
 * minus the control plane), so the check always matches the real schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import mysql from 'mysql2/promise';
import { env, projectRoot } from '../src/config/env';
import { scanSql } from '../src/platform/tenancy/sqlScan';
import { CONTROL_PLANE_TABLES } from '../src/platform/tenancy/tables';

interface Finding {
  file: string;
  line: number;
  tables: string[];
  sql: string;
}

const SQL_HINT = /\b(SELECT|INSERT\s+(IGNORE\s+)?INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\b/i;
const SUPPRESS = /tenancy:\s*scoped by caller/i;

function literalText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    // Interpolations become an identifier-shaped placeholder: a `${where}`
    // could hold anything, including the shop predicate, so it never counts
    // as mentioning a table.
    return node.head.text + node.templateSpans.map((span) => ` __expr__ ${span.literal.text}`).join('');
  }
  return null;
}

function enclosingFunction(node: ts.Node): ts.Node | null {
  let current: ts.Node | undefined = node.parent;
  while (current) {
    if (
      ts.isFunctionDeclaration(current) ||
      ts.isMethodDeclaration(current) ||
      ts.isArrowFunction(current) ||
      ts.isFunctionExpression(current)
    ) {
      // Arrow functions nested inside a method belong to the method: callbacks
      // that build fragments share their parent's scoping.
      const outer = enclosingFunction(current);
      return outer ?? current;
    }
    current = current.parent;
  }
  return null;
}

const SCOPING = /\bshopId\(\)|\bshop_id\b|tenancy\.current\(\)|\.shop\.id\b|tenancy\.unscoped\(/;

/**
 * Names declared in this file whose body or value scopes by shop: a
 * `buildWhere()` that starts with `shop_id = ?`, or a `SELECT_BASE` constant
 * that joins on it. A function that uses one is scoped through it.
 */
function scopedHelpers(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.name && SCOPING.test(node.getText(source))) names.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && SCOPING.test(node.initializer.getText(source))) {
      names.add(node.name.text);
    }
    if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && SCOPING.test(node.getText(source))) names.add(node.name.text);
    if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && SCOPING.test(node.initializer.getText(source))) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

function scopesByShop(fn: ts.Node, source: ts.SourceFile, helpers: Set<string>): boolean {
  const text = fn.getText(source);
  if (SCOPING.test(text)) return true;
  for (const name of helpers) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return true;
  }
  return false;
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'migrations') continue;
      walkFiles(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

async function tenantTables(): Promise<Set<string>> {
  const conn = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: process.env.CHECK_DATABASE ?? env.db.database,
  });
  try {
    const [rows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT DISTINCT table_name AS t FROM information_schema.columns WHERE table_schema = DATABASE() AND column_name = 'shop_id'`,
    );
    return new Set(rows.map((row) => String(row.t).toLowerCase()).filter((t) => !CONTROL_PLANE_TABLES.has(t)));
  } finally {
    await conn.end();
  }
}

async function main(): Promise<void> {
  const listOnly = process.argv.includes('--list');
  const tenant = await tenantTables();
  if (tenant.size === 0) {
    throw new Error('No tenant tables found — run the migrations first (or set CHECK_DATABASE).');
  }

  const findings: Finding[] = [];
  for (const file of walkFiles(path.join(projectRoot, 'src'))) {
    const content = fs.readFileSync(file, 'utf8');
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.ES2022, true);
    const lines = content.split('\n');
    const helpers = scopedHelpers(source);

    const visit = (node: ts.Node) => {
      const text = literalText(node);
      if (text && SQL_HINT.test(text)) {
        const scan = scanSql(text);
        const touched = scan.tables.filter((table) => tenant.has(table));
        if (touched.length > 0 && !scan.mentionsShopId) {
          const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line;
          const fn = enclosingFunction(node);
          const suppressed = SUPPRESS.test(lines[line - 1] ?? '') || SUPPRESS.test(lines[line] ?? '');
          if (!suppressed && !(fn && scopesByShop(fn, source, helpers))) {
            findings.push({
              file: path.relative(projectRoot, file).replace(/\\/g, '/'),
              line: line + 1,
              tables: touched,
              sql: text.replace(/\s+/g, ' ').trim().slice(0, 140),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const byFile = new Map<string, Finding[]>();
  for (const finding of findings) byFile.set(finding.file, [...(byFile.get(finding.file) ?? []), finding]);

  for (const [file, list] of [...byFile].sort((a, b) => b[1].length - a[1].length)) {
    process.stdout.write(`${String(list.length).padStart(4)}  ${file}\n`);
    if (!listOnly) {
      for (const finding of list) process.stdout.write(`        :${finding.line}  [${finding.tables.join(',')}]  ${finding.sql}\n`);
    }
  }
  process.stdout.write(`\n${findings.length} unscoped statement(s) in ${byFile.size} file(s)\n`);
  if (findings.length > 0) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
