/**
 * Just enough SQL understanding for the tenant guard: which tables a statement
 * touches, whether it mentions shop_id, and which bound parameters land in a
 * shop_id slot.
 *
 * It is a scanner, not a parser, and is honest about that: it works on the
 * statement with comments and string literals blanked out, so a `?` or a table
 * name inside a quoted value can never be mistaken for SQL. Anything it cannot
 * read with confidence it leaves alone rather than guess — a missed check is
 * caught by the database's composite foreign keys, a false alarm would take a
 * working endpoint down.
 */

export interface SqlScan {
  /** Referenced table names, lower-case, de-duplicated. */
  tables: string[];
  mentionsShopId: boolean;
  /** Indexes into the params array of values bound to shop_id. */
  shopParamIndexes: number[];
}

interface Masked {
  text: string;
  /** Character offsets of each placeholder, in order. */
  placeholders: number[];
}

/**
 * Blanks out comments and string literals (keeping length, so offsets line up)
 * and records where every placeholder sits. `??` is mysql2's identifier
 * placeholder and consumes one parameter, like `?`.
 */
export function maskSql(sql: string): Masked {
  const out = sql.split('');
  const placeholders: number[] = [];
  let i = 0;

  const blank = (from: number, to: number) => {
    for (let j = from; j < to && j < out.length; j += 1) if (out[j] !== '\n') out[j] = ' ';
  };

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    if ((ch === '-' && next === '-' && /\s/.test(sql[i + 2] ?? ' ')) || ch === '#') {
      const end = sql.indexOf('\n', i);
      const stop = end === -1 ? sql.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === '\\') {
          j += 2;
          continue;
        }
        if (sql[j] === ch) {
          if (sql[j + 1] === ch) {
            j += 2;
            continue;
          }
          break;
        }
        j += 1;
      }
      // Keep the quotes, blank the contents.
      blank(i + 1, j);
      i = j + 1;
      continue;
    }

    if (ch === '`') {
      const end = sql.indexOf('`', i + 1);
      i = end === -1 ? sql.length : end + 1;
      continue;
    }

    if (ch === '?') {
      placeholders.push(i);
      i += next === '?' ? 2 : 1;
      continue;
    }

    i += 1;
  }

  return { text: out.join(''), placeholders };
}

// FROM/JOIN/INTO/UPDATE followed by an optionally qualified, optionally
// backticked identifier. `ON DUPLICATE KEY UPDATE col = …` is not a table
// reference and is excluded by the lookbehind.
const TABLE_REF =
  /\b(?:FROM|JOIN|INTO|(?<!KEY\s{1,20})UPDATE)\s+`?([A-Za-z_][A-Za-z0-9_$]*)`?(?:\s*\.\s*`?([A-Za-z_][A-Za-z0-9_$]*)`?)?/gi;

const SHOP_EQUALS = /\bshop_id`?\s*(?:=|<=>)\s*\?/gi;

const INSERT_HEAD = /\b(?:INSERT|REPLACE)\s+(?:LOW_PRIORITY\s+|DELAYED\s+|HIGH_PRIORITY\s+)?(?:IGNORE\s+)?INTO\s+`?[A-Za-z_][A-Za-z0-9_$]*`?(?:\s*\.\s*`?[A-Za-z_][A-Za-z0-9_$]*`?)?\s*\(([^()]*)\)\s*VALUES\s*/gi;

function ordinalOf(placeholders: number[], offset: number): number {
  let low = 0;
  let high = placeholders.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (placeholders[mid] === offset) return mid;
    if (placeholders[mid] < offset) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

/**
 * For `INSERT INTO t (a, shop_id, b) VALUES (?, ?, ?), (?, ?, ?)`, the offsets
 * of the placeholders in the shop_id position of every tuple. Tuples whose
 * shop_id slot is an expression rather than a bare `?` are skipped.
 */
function insertShopOffsets(masked: string): number[] {
  const offsets: number[] = [];
  INSERT_HEAD.lastIndex = 0;
  let head: RegExpExecArray | null;

  while ((head = INSERT_HEAD.exec(masked)) !== null) {
    const columns = head[1].split(',').map((column) => column.trim().replace(/`/g, '').toLowerCase());
    const position = columns.indexOf('shop_id');
    if (position === -1) continue;

    let i = head.index + head[0].length;
    for (;;) {
      while (i < masked.length && /\s/.test(masked[i])) i += 1;
      if (masked[i] !== '(') break;

      // Walk one tuple, splitting on top-level commas.
      let depth = 0;
      let elementStart = i + 1;
      let element = 0;
      let j = i;
      for (; j < masked.length; j += 1) {
        const c = masked[j];
        if (c === '(') {
          depth += 1;
          continue;
        }
        if (c === ')') {
          depth -= 1;
          if (depth === 0) {
            if (element === position) {
              const value = masked.slice(elementStart, j);
              if (value.trim() === '?') offsets.push(elementStart + value.indexOf('?'));
            }
            break;
          }
          continue;
        }
        if (c === ',' && depth === 1) {
          if (element === position) {
            const value = masked.slice(elementStart, j);
            if (value.trim() === '?') offsets.push(elementStart + value.indexOf('?'));
          }
          element += 1;
          elementStart = j + 1;
        }
      }

      i = j + 1;
      while (i < masked.length && /\s/.test(masked[i])) i += 1;
      if (masked[i] !== ',') break;
      i += 1;
    }
  }
  return offsets;
}

export function scanSql(sql: string): SqlScan {
  const { text, placeholders } = maskSql(sql);

  const tables = new Set<string>();
  TABLE_REF.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TABLE_REF.exec(text)) !== null) {
    // `db.table` → table
    tables.add((match[2] ?? match[1]).toLowerCase());
  }

  const shopOffsets: number[] = [];
  SHOP_EQUALS.lastIndex = 0;
  while ((match = SHOP_EQUALS.exec(text)) !== null) {
    shopOffsets.push(match.index + match[0].length - 1);
  }
  shopOffsets.push(...insertShopOffsets(text));

  const shopParamIndexes = [...new Set(shopOffsets.map((offset) => ordinalOf(placeholders, offset)).filter((n) => n >= 0))].sort(
    (a, b) => a - b,
  );

  return {
    tables: [...tables],
    mentionsShopId: /\bshop_id\b/i.test(text),
    shopParamIndexes,
  };
}
