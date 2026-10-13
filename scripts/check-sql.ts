/**
 * Static checks on every INSERT whose column list and VALUES tuple are written
 * out literally: as many values as columns, and no unquoted reserved word as
 * a column name.
 *
 *   npm run check:sql
 *
 * Either is a runtime SQL error on a path a test may never reach — this is
 * exactly how a payment upsert with 30 columns and 31 placeholders slipped
 * through a refactor. Statements built dynamically (`${columns.join(', ')}`)
 * are skipped; they are correct by construction or not checkable here.
 */
import fs from 'node:fs';
import { INSERT, sourceFiles, tuple } from './lib/sqlScan';

const ROOTS = ['src', 'scripts'];

/**
 * MySQL 8 reserved words that make plausible column names. Unquoted in a
 * statement they are a syntax error at runtime — `sensitive` on the platform
 * email outbox was one — so a column list naming one must quote it.
 */
const RESERVED = new Set([
  'condition', 'cube', 'desc', 'function', 'group', 'groups', 'index', 'interval', 'key', 'keys', 'lag', 'lead',
  'match', 'member', 'of', 'option', 'order', 'range', 'rank', 'read', 'recursive', 'release', 'row', 'rows',
  'sensitive', 'system', 'usage', 'window', 'write',
]);

let problems = 0;
let checked = 0;
for (const root of ROOTS) {
  for (const file of sourceFiles(root)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const match of source.matchAll(INSERT)) {
      const columns = match[2];
      if (columns.includes('${')) continue;
      for (const raw of columns.split(',').map((column) => column.trim())) {
        if (!raw.includes('`') && RESERVED.has(raw.toLowerCase())) {
          problems += 1;
          const line = source.slice(0, match.index).split('\n').length;
          console.log(`${file}:${line}  INSERT INTO ${match[1]}: column "${raw}" is a reserved word and must be quoted`);
        }
      }
      const parsed = tuple(source, (match.index ?? 0) + match[0].length);
      if (!parsed || parsed.values.some((value) => value.includes('${'))) continue;
      const columnCount = columns.split(',').filter((column) => column.trim()).length;
      checked += 1;
      if (columnCount !== parsed.values.length) {
        problems += 1;
        const line = source.slice(0, match.index).split('\n').length;
        console.log(`${file}:${line}  INSERT INTO ${match[1]}: ${columnCount} columns, ${parsed.values.length} values`);
      }
    }
  }
}

console.log(`${checked} literal INSERT statement(s) checked, ${problems} problem(s).`);
process.exit(problems === 0 ? 0 : 1);
