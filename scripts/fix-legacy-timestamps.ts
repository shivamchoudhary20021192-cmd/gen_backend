/**
 * Moves timestamps written in the MySQL server's local zone to UTC.
 *
 *   npx tsx scripts/fix-legacy-timestamps.ts                 # report only
 *   npx tsx scripts/fix-legacy-timestamps.ts --apply         # rewrite
 *   npx tsx scripts/fix-legacy-timestamps.ts --offset=+05:30 # instead of the server's zone
 *
 * Why: the driver has always read DATETIMEs as UTC, but until the pool pinned
 * `time_zone = '+00:00'` every session ran in the server's SYSTEM zone, so
 * whatever the database clock wrote — `DEFAULT CURRENT_TIMESTAMP`, `NOW()` —
 * was local wall-clock time. On a UTC server (any managed MySQL, any
 * container) that was the same thing and this script has nothing to do. On a
 * developer machine in, say, India, those values are 5½ hours ahead.
 *
 * Only columns the database clock alone writes are moved. The application's
 * own SQL is read statically: a column written anywhere from a JavaScript
 * value (`?`), which the driver already sent as UTC, is "mixed" and left
 * alone, because a row cannot say which writer produced it. Tables written
 * with column lists built at runtime are reported too. Everything skipped is
 * listed, so a person can decide.
 *
 * Run it once, with the API stopped, right after deploying the pool change.
 * It records itself in `maintenance_runs` and refuses to run twice.
 */
import { readFileSync } from 'node:fs';
import mysql, { type RowDataPacket } from 'mysql2/promise';
import { env } from '../src/config/env';
import { scanWrites, sourceFiles, type Assignment } from './lib/sqlScan';

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const offsetArg = process.argv.find((arg) => arg.startsWith('--offset='))?.slice('--offset='.length);
const NAME = 'datetimes_to_utc';

type Kind = 'local' | 'utc' | 'param' | 'none';

function kindOf(expression: string): Kind {
  const text = expression.toUpperCase();
  if (/\bUTC_TIMESTAMP\b/.test(text)) return 'utc';
  if (/\b(NOW|SYSDATE|CURDATE|CURRENT_TIMESTAMP|LOCALTIME|LOCALTIMESTAMP|CURRENT_DATE)\b/.test(text)) return 'local';
  if (text.includes('?')) return 'param';
  return 'none'; // NULL, a literal, another column, VALUES(col)
}

function parseOffset(value: string): number {
  const match = /^([+-])(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`--offset must look like +05:30 or -04:00, not "${value}"`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === '-' ? -minutes : minutes;
}

async function main(): Promise<void> {
  const connection = await mysql.createConnection({
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.database,
    timezone: 'Z',
  });

  try {
    const [[zone]] = await connection.query<RowDataPacket[]>(
      "SELECT @@global.time_zone AS global_zone, @@system_time_zone AS system_zone, TIMESTAMPDIFF(MINUTE, UTC_TIMESTAMP(), CONVERT_TZ(UTC_TIMESTAMP(), '+00:00', 'SYSTEM')) AS system_offset",
    );
    const offset = offsetArg ? parseOffset(offsetArg) : Number(zone.system_offset);
    console.log(`Database ${env.db.database}: server zone ${zone.global_zone} (${zone.system_zone}), shifting by ${-offset} minutes.`);
    if (offset === 0) {
      console.log('The server runs in UTC: stored times are already UTC. Nothing to do.');
      return;
    }

    await connection.query(
      `CREATE TABLE IF NOT EXISTS maintenance_runs (
         name VARCHAR(100) NOT NULL PRIMARY KEY,
         detail JSON NULL,
         applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
       ) ENGINE=InnoDB`,
    );
    const [done] = await connection.query<RowDataPacket[]>('SELECT applied_at FROM maintenance_runs WHERE name = ?', [NAME]);
    if (done.length > 0) {
      console.log(`Already applied at ${new Date(done[0].applied_at).toISOString()}. Refusing to shift twice.`);
      return;
    }

    const files = sourceFiles('src');
    const { assignments, dynamicTables } = scanWrites(files);
    const writes = new Map<string, Assignment[]>();
    for (const assignment of assignments) {
      if (!assignment.table) continue;
      const key = `${assignment.table}.${assignment.column}`;
      writes.set(key, [...(writes.get(key) ?? []), assignment]);
    }
    // Runtime-built statements take their columns from objects, so a column a
    // service sets to `new Date()` (`{ published_at: new Date() }`) is written
    // from JavaScript somewhere the SQL scan cannot see.
    const jsDated = new Set<string>();
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(/\b([a-z][a-z0-9_]*_(?:at|until|from|start|end))\b['"]?\s*[:=]\s*[^,;\n]*?new Date\(/g)) {
        jsDated.add(match[1]);
      }
    }

    const [columns] = await connection.query<RowDataPacket[]>(
      `SELECT c.table_name AS table_name, c.column_name AS column_name, c.column_default AS column_default, c.extra AS extra
         FROM information_schema.columns c
         JOIN information_schema.tables t
           ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = DATABASE() AND c.data_type = 'datetime'
          AND c.table_name NOT IN ('schema_migrations', 'maintenance_runs')
        ORDER BY c.table_name, c.ordinal_position`,
    );

    const plan = new Map<string, { shift: string[]; freeze: string[] }>();
    const mixed: string[] = [];
    const unknown: string[] = [];

    for (const column of columns) {
      const table = String(column.table_name);
      const name = String(column.column_name);
      const key = `${table}.${name}`;
      const clockDefault = /CURRENT_TIMESTAMP/i.test(String(column.column_default ?? ''));
      const onUpdate = /on update CURRENT_TIMESTAMP/i.test(String(column.extra ?? ''));
      const kinds = new Set<Kind>(
        (writes.get(key) ?? []).map((assignment) =>
          // Migrations run with the session pinned to UTC: what they wrote is already right.
          /[\\/]db[\\/]migrations[\\/]/.test(assignment.file) ? 'utc' : kindOf(assignment.expression),
        ),
      );
      if (clockDefault) kinds.add('local');
      // created_at/updated_at are the database clock's own columns; the odd
      // service that stamps one with `new Date()` also means "now", and letting
      // it mark every table's copy as mixed would leave nearly all of them wrong.
      if (dynamicTables.has(table) && jsDated.has(name) && !clockDefault) kinds.add('param');
      kinds.delete('none');

      const entry = plan.get(table) ?? { shift: [], freeze: [] };
      if (kinds.has('local') && !kinds.has('param') && !kinds.has('utc')) {
        entry.shift.push(name);
        if (VERBOSE && !clockDefault) {
          const where = (writes.get(key) ?? []).map((assignment) => `${assignment.file}:${assignment.line}`);
          console.log(`  moves ${key}  (written by NOW() at ${where.slice(0, 2).join(', ')}${where.length > 2 ? ', …' : ''})`);
        }
      } else {
        if (kinds.has('local')) mixed.push(key);
        else if (kinds.size === 0 && dynamicTables.has(table)) unknown.push(key);
        // An auto-updating column that is not being moved must be assigned to
        // itself, or rewriting its neighbours would stamp it with "now".
        if (onUpdate) entry.freeze.push(name);
      }
      plan.set(table, entry);
    }

    let shifted = 0;
    const statements: { table: string; sql: string; columns: string[] }[] = [];
    for (const [table, { shift, freeze }] of plan) {
      if (shift.length === 0) continue;
      const assignmentsSql = [
        ...shift.map((name) => `\`${name}\` = DATE_SUB(\`${name}\`, INTERVAL ${offset} MINUTE)`),
        ...freeze.map((name) => `\`${name}\` = \`${name}\``),
      ].join(', ');
      statements.push({ table, sql: `UPDATE \`${table}\` SET ${assignmentsSql}`, columns: shift });
      shifted += shift.length;
    }

    console.log(`\n${shifted} column(s) in ${statements.length} table(s) are written only by the database clock and will move.`);
    if (mixed.length > 0) {
      console.log(`\n${mixed.length} column(s) are written both by the database clock and from application values; left as they are:`);
      console.log(`  ${mixed.join('\n  ')}`);
    }
    if (unknown.length > 0) {
      console.log(`\n${unknown.length} column(s) belong to tables written with runtime-built column lists; left as they are:`);
      console.log(`  ${unknown.join('\n  ')}`);
    }

    if (!APPLY) {
      console.log('\nReport only. Re-run with --apply to rewrite (take a backup first).');
      return;
    }

    await connection.beginTransaction();
    try {
      for (const statement of statements) {
        const [result] = await connection.query<mysql.ResultSetHeader>(statement.sql);
        console.log(`  ${statement.table}: ${result.affectedRows} row(s) — ${statement.columns.join(', ')}`);
      }
      await connection.query('INSERT INTO maintenance_runs (name, detail, applied_at) VALUES (?, ?, UTC_TIMESTAMP())', [
        NAME,
        JSON.stringify({ offset_minutes: offset, columns: shifted, mixed, unknown }),
      ]);
      await connection.commit();
      console.log('\nDone.');
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
