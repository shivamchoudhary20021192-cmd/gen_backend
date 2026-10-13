/**
 * Bundles the whole schema into one file: database/veylor_final_update.sql.
 *
 *   npm run db:bundle              build, dump, verify, clean up
 *   npm run db:bundle -- --keep    leave the two scratch databases behind
 *
 * The legacy files, the numbered SQL migrations and the TypeScript migrations
 * cannot simply be concatenated — the TypeScript ones look at the database
 * before deciding what to do. So the bundle is made the only way that is
 * faithful: replay every migration into a brand-new scratch database, dump
 * that database (schema, seed data and the migration ledger), then load the
 * dump into a second empty database and prove it matches the first.
 *
 * The ledger is included so `npm run db:migrate` on a database made from the
 * bundle reports it up to date and applies only migrations added later.
 *
 * Only databases named veylor_bundle_* are ever created or dropped.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import mysql, { type Connection, type RowDataPacket } from 'mysql2/promise';
import { env, projectRoot } from '../src/config/env';
import { discoverMigrations, MigrationRunner } from '../src/db/migrations/runner';

const BUILD_DB = 'veylor_bundle_build';
const VERIFY_DB = 'veylor_bundle_verify';
const OUTPUT = path.join(projectRoot, 'database', 'veylor_final_update.sql');

function mysqlBin(name: 'mysql' | 'mysqldump'): string {
  const dir = process.env.MYSQL_BIN_DIR;
  if (dir) return path.join(dir, name);
  const windows = `C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\${name}.exe`;
  return process.platform === 'win32' && fs.existsSync(windows) ? windows : name;
}

/** Credentials go through the environment, never the command line. */
function clientArgs(): string[] {
  return [`--host=${env.db.host}`, `--port=${env.db.port}`, `--user=${env.db.user}`, '--default-character-set=utf8mb4'];
}

function run(bin: string, args: string[], io: { stdin?: string; stdout?: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env: { ...process.env, MYSQL_PWD: env.db.password },
      stdio: [io.stdin ? 'pipe' : 'ignore', io.stdout ? 'pipe' : 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr!.on('data', (chunk) => (stderr += chunk));
    if (io.stdout) child.stdout!.pipe(fs.createWriteStream(io.stdout));
    if (io.stdin) fs.createReadStream(io.stdin).pipe(child.stdin!);
    child.on('error', reject);
    child.on('close', (code) => {
      const noise = stderr
        .split('\n')
        .filter((line) => line.trim() && !/Using a password on the command line|MYSQL_PWD/i.test(line))
        .join('\n');
      code === 0 ? resolve() : reject(new Error(`${path.basename(bin)} exited ${code}: ${noise}`));
    });
  });
}

async function connect(database?: string): Promise<Connection> {
  return mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database,
    charset: 'utf8mb4_0900_ai_ci',
    timezone: 'Z',
  });
}

async function dropScratch(conn: Connection, name: string): Promise<void> {
  if (!name.startsWith('veylor_bundle_')) throw new Error(`refusing to drop ${name}`);
  await conn.query(`DROP DATABASE IF EXISTS \`${name}\``);
}

/** Everything that defines a schema, as comparable text — plus row counts. */
async function fingerprint(conn: Connection, database: string): Promise<Map<string, string>> {
  const queries: Record<string, string> = {
    columns: `SELECT CONCAT_WS('|', table_name, column_name, ordinal_position, column_type, is_nullable,
                IFNULL(column_default,'∅'), extra, IFNULL(collation_name,''), generation_expression)
                FROM information_schema.columns WHERE table_schema = ?`,
    indexes: `SELECT CONCAT_WS('|', table_name, index_name, non_unique, seq_in_index, column_name, IFNULL(sub_part,''), index_type)
                FROM information_schema.statistics WHERE table_schema = ?`,
    foreignKeys: `SELECT CONCAT_WS('|', k.table_name, k.constraint_name, k.column_name, k.referenced_table_name,
                    k.referenced_column_name, r.update_rule, r.delete_rule)
                    FROM information_schema.key_column_usage k
                    JOIN information_schema.referential_constraints r
                      ON r.constraint_schema = k.constraint_schema AND r.constraint_name = k.constraint_name
                   WHERE k.table_schema = ?`,
    checks: `SELECT CONCAT_WS('|', t.table_name, c.constraint_name, c.check_clause)
               FROM information_schema.check_constraints c
               JOIN information_schema.table_constraints t
                 ON t.constraint_schema = c.constraint_schema AND t.constraint_name = c.constraint_name
              WHERE c.constraint_schema = ?`,
    triggers: `SELECT CONCAT_WS('|', trigger_name, event_object_table, action_timing, event_manipulation, action_statement)
                 FROM information_schema.triggers WHERE trigger_schema = ?`,
    views: `SELECT CONCAT_WS('|', table_name, view_definition) FROM information_schema.views WHERE table_schema = ?`,
    routines: `SELECT CONCAT_WS('|', routine_name, routine_type, routine_definition) FROM information_schema.routines WHERE routine_schema = ?`,
  };
  // The mysql client strips `-- comments` from routine bodies as it loads a
  // file, so bodies are compared as code: no comments, whitespace collapsed.
  const asCode = (text: string) => text.replace(/--[^\n]*/g, '').replace(/\s+/g, ' ').trim();
  const result = new Map<string, string>();
  for (const [kind, sql] of Object.entries(queries)) {
    const [rows] = await conn.query<RowDataPacket[]>(sql, [database]);
    const lines = rows.map((row) => asCode(String(Object.values(row)[0]).replaceAll(`\`${database}\`.`, ''))).sort();
    result.set(kind, lines.join('\n'));
  }
  const [tables] = await conn.query<RowDataPacket[]>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name",
    [database],
  );
  const counts: string[] = [];
  for (const { t } of tables) {
    const [[row]] = await conn.query<RowDataPacket[]>(`SELECT COUNT(*) AS n FROM \`${database}\`.\`${t}\``);
    counts.push(`${t}=${row.n}`);
  }
  result.set('rowCounts', counts.join('\n'));
  result.set('tables', String(tables.length));
  return result;
}

function header(tables: number, rows: number, last: string): string {
  return `-- =============================================================================
-- Veylor / Veylog — complete database in one file
-- =============================================================================
--
-- Everything a brand-new database needs, in final form:
--   * all ${tables} tables with every column, index, foreign key and check
--     (legacy files 00–49 + migrations 100–${last.split('_')[0]}, already merged)
--   * all seed / reference data (roles, permissions, admin menu, lookups,
--     plans, tax rates, markets, notification templates, founding shop #1)
--   * the schema_migrations ledger, so \`npm run db:migrate\` sees this
--     database as up to date and only applies migrations added after
--     ${last}
--
-- HOW TO RUN (on an EMPTY database — it never drops anything):
--
--   CREATE DATABASE veylor_new CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
--
--   mysql -u root -p veylor_new < veylor_final_update.sql            (cmd / bash)
--   mysql -u root -p veylor_new -e "source veylor_final_update.sql"  (PowerShell)
--
--   (MySQL Workbench: double-click veylor_new to make it the default schema,
--    then File → Open SQL Script → this file → Execute.)
--
-- THEN, in the backend: set DB_NAME=veylor_new in .env and run
--   npm run db:seed        creates the super admin from SUPERADMIN_EMAIL /
--                          SUPERADMIN_PASSWORD and makes them owner of shop #1
--   then sign in to the admin → Online Store → Themes → add and publish a
--   theme (the storefront shows "Opening soon" until one is published)
--
-- Generated by \`npm run db:bundle\` (scripts/build-final-sql.ts) — edit the
-- migrations, not this file, and regenerate. Total seed rows: ${rows}.
-- =============================================================================

`;
}

async function main(): Promise<void> {
  const keep = process.argv.includes('--keep');
  const admin = await connect();
  try {
    await dropScratch(admin, BUILD_DB);
    await dropScratch(admin, VERIFY_DB);

    console.log(`1/4 replaying every migration into ${BUILD_DB}`);
    await new MigrationRunner({
      projectRoot,
      database: BUILD_DB,
      connection: { host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password },
      log: () => undefined,
    }).up();

    console.log('2/4 dumping it');
    const raw = `${OUTPUT}.tmp`;
    await run(
      mysqlBin('mysqldump'),
      [
        ...clientArgs(),
        '--single-transaction',
        '--routines',
        '--triggers',
        '--events',
        '--skip-add-drop-table',
        '--complete-insert',
        '--order-by-primary',
        '--hex-blob',
        '--skip-dump-date',
        '--set-gtid-purged=OFF',
        '--no-tablespaces',
        '--column-statistics=0',
        BUILD_DB,
      ],
      { stdout: raw },
    );
    const body = fs
      .readFileSync(raw, 'utf8')
      // Portable across servers and users: no definer, no source database name.
      .replace(/\/\*!50013 DEFINER=[^*]*\*\/\s*/g, '')
      .replace(/\/\*!50017 DEFINER=[^*]*\*\/\s*/g, '')
      .replace(/DEFINER=`[^`]*`@`[^`]*`\s*/g, '')
      .replaceAll(`\`${BUILD_DB}\`.`, '')
      .replaceAll(` for database '${BUILD_DB}'`, '')
      .replace(/^-- Host: .*$/m, '-- Host: (build server)')
      .replace(/^-- Dump completed.*$/m, '-- Dump completed')
      .replace(/\r\n/g, '\n');
    fs.rmSync(raw);

    const built = await fingerprint(admin, BUILD_DB);
    const totalRows = built
      .get('rowCounts')!
      .split('\n')
      .reduce((sum, line) => sum + Number(line.split('=')[1]), 0);
    const last = discoverMigrations(projectRoot).at(-1)!.version;
    fs.writeFileSync(OUTPUT, header(Number(built.get('tables')), totalRows, last) + body);

    console.log(`3/4 loading the file into an empty ${VERIFY_DB}`);
    await admin.query(`CREATE DATABASE \`${VERIFY_DB}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await run(mysqlBin('mysql'), [...clientArgs(), VERIFY_DB], { stdin: OUTPUT });

    console.log('4/4 comparing');
    const loaded = await fingerprint(admin, VERIFY_DB);
    const mismatched = [...built.keys()].filter((kind) => built.get(kind) !== loaded.get(kind));
    if (mismatched.length > 0) throw new Error(`the file does not reproduce the build: ${mismatched.join(', ')} differ`);
    const status = await new MigrationRunner({
      projectRoot,
      database: VERIFY_DB,
      connection: { host: env.db.host, port: env.db.port, user: env.db.user, password: env.db.password },
    }).status();
    const pending = status.filter((row) => !row.applied || row.drifted).map((row) => row.migration.version);
    if (pending.length > 0) throw new Error(`ledger incomplete; pending: ${pending.join(', ')}`);

    const size = (fs.statSync(OUTPUT).size / 1024).toFixed(0);
    console.log(
      `\n${path.relative(projectRoot, OUTPUT)}  ${size} KB — ${built.get('tables')} tables, ${totalRows} seed rows, ` +
        `${status.length} migrations recorded; loads into an empty database identically.`,
    );
  } finally {
    if (!keep) {
      await dropScratch(admin, BUILD_DB);
      await dropScratch(admin, VERIFY_DB);
    }
    await admin.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
