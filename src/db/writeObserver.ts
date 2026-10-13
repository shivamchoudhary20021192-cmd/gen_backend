import { maskSql } from '../platform/tenancy/sqlScan';

/**
 * Tells interested modules that a shop's data changed — after the write is
 * durable, never before.
 *
 * The driver wrapper in pods.ts reports every INSERT / UPDATE / DELETE /
 * REPLACE made while a shop is in context: a statement on the pool as soon as
 * it succeeds (autocommit), a statement inside a transaction only when the
 * transaction commits (and not at all if it rolls back). Reporting before
 * commit would let another request read the "new" signal, render the old rows
 * and cache them as new.
 *
 * Kept free of imports from the rest of the platform so the database layer
 * can depend on it without a cycle; listeners register themselves.
 */

export type WriteListener = (shopId: number, tables: readonly string[]) => void;

const listeners: WriteListener[] = [];

export const writeObserver = {
  subscribe(listener: WriteListener): void {
    if (!listeners.includes(listener)) listeners.push(listener);
  },

  get active(): boolean {
    return listeners.length > 0;
  },

  emit(shopId: number, tables: readonly string[]): void {
    for (const listener of listeners) {
      try {
        listener(shopId, tables);
      } catch {
        /* an observer never fails the write it observes */
      }
    }
  },
};

const MAX_CACHED = 5000;
const classified = new Map<string, readonly string[] | null>();

const MODIFIERS = '(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY|QUICK|IGNORE)\\s+)*';
const NAME = '`?([A-Za-z0-9_$]+)`?(?:\\s*\\.\\s*`?([A-Za-z0-9_$]+)`?)?';
const INSERT_TARGET = new RegExp(`^\\s*(?:INSERT|REPLACE)\\s+${MODIFIERS}(?:INTO\\s+)?${NAME}`, 'i');
/** A table named after UPDATE, FROM, JOIN or a comma — in the clause that says what is written. */
const TABLE_REFERENCE = new RegExp(`(?:\\bUPDATE|\\bFROM|\\bJOIN|,)\\s+${MODIFIERS}${NAME}`, 'gi');

function tableOf(match: RegExpExecArray): string {
  return (match[2] ?? match[1]).toLowerCase();
}

/**
 * The table(s) a statement writes, lower-case; null for anything that is not
 * a write (SELECT, SET, DDL, …). `db.table` names are reduced to the table.
 * For multi-table UPDATE and DELETE every table in the target clause is
 * reported (a joined table may be the one changed). A write whose target
 * cannot be read comes back as ['*'] — treated as relevant, because missing a
 * change is worse than an extra cache miss.
 */
export function writtenTables(sql: string): readonly string[] | null {
  const cached = classified.get(sql);
  if (cached !== undefined) return cached;
  const text = maskSql(sql).text;
  const verb = /^\s*(INSERT|REPLACE|UPDATE|DELETE)\b/i.exec(text)?.[1]?.toUpperCase();
  let result: readonly string[] | null = null;
  if (verb === 'INSERT' || verb === 'REPLACE') {
    const match = INSERT_TARGET.exec(text);
    result = match ? [tableOf(match)] : ['*'];
  } else if (verb === 'UPDATE' || verb === 'DELETE') {
    // UPDATE a [JOIN b …] SET …   |   DELETE [a] FROM a [JOIN b …] WHERE …
    const start = verb === 'UPDATE' ? 0 : text.search(/\bFROM\b/i);
    const end = text.slice(Math.max(start, 0)).search(verb === 'UPDATE' ? /\bSET\b/i : /\b(WHERE|ORDER|LIMIT)\b/i);
    const clause = start < 0 ? '' : end < 0 ? text.slice(start) : text.slice(start, start + end);
    const tables = new Set<string>();
    for (const match of clause.matchAll(TABLE_REFERENCE)) tables.add(tableOf(match));
    result = tables.size ? [...tables] : ['*'];
  }
  if (classified.size >= MAX_CACHED) classified.clear();
  classified.set(sql, result);
  return result;
}

/**
 * Columns that record that something was used or looked at — never what a
 * shopper sees. An article's view counter goes up on every view; if that
 * counted as a change, every view would invalidate the shop's cached pages.
 */
const BOOKKEEPING_COLUMNS = new Set([
  'view_count',
  'views',
  'usage_count',
  'use_count',
  'last_used_at',
  'last_viewed_at',
  'last_seen_at',
  'last_activity_at',
  'last_login_at',
  'updated_at',
]);
const bookkeeping = new Map<string, boolean>();

/** The columns an UPDATE's SET clause assigns, lower-case; null if it cannot be read. */
export function assignedColumns(sql: string): string[] | null {
  const text = maskSql(sql).text;
  if (!/^\s*UPDATE\b/i.test(text)) return null;
  const set = text.search(/\bSET\b/i);
  if (set < 0) return null;
  const rest = text.slice(set + 3);
  const stop = rest.search(/\b(WHERE|ORDER\s+BY|LIMIT)\b/i);
  const clause = stop < 0 ? rest : rest.slice(0, stop);
  // Split on the commas between assignments, not those inside IF(…, …) and friends.
  const assignments: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of clause) {
    if (character === '(') depth += 1;
    if (character === ')') depth -= 1;
    if (character === ',' && depth === 0) {
      assignments.push(current);
      current = '';
    } else {
      current += character;
    }
  }
  assignments.push(current);
  const columns: string[] = [];
  for (const assignment of assignments) {
    const match = /^\s*(?:`?[A-Za-z0-9_$]+`?\s*\.\s*)?`?([A-Za-z0-9_$]+)`?\s*=/.exec(assignment);
    if (!match) return null;
    columns.push(match[1].toLowerCase());
  }
  return columns;
}

/** An UPDATE that only moves counters and last-seen stamps: nothing anyone sees has changed. */
export function bookkeepingOnly(sql: string): boolean {
  const cached = bookkeeping.get(sql);
  if (cached !== undefined) return cached;
  const columns = assignedColumns(sql);
  const result = columns !== null && columns.length > 0 && columns.every((column) => BOOKKEEPING_COLUMNS.has(column));
  if (bookkeeping.size >= MAX_CACHED) bookkeeping.clear();
  bookkeeping.set(sql, result);
  return result;
}
