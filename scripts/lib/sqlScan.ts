/**
 * A small static reader for the SQL written as template literals in the
 * codebase — enough to find INSERT column lists with their VALUES tuples and
 * UPDATE assignments, which is what the static checks need. Statements built
 * dynamically (`${columns.join(', ')}`) are reported as such, never guessed at.
 */
import fs from 'node:fs';
import path from 'node:path';

export function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * Splits a parenthesised list at top-level commas, starting just after its
 * "(". Returns null if the template literal ends before the list does.
 */
export function tuple(source: string, start: number): { values: string[]; end: number } | null {
  let depth = 1;
  let quote: string | null = null;
  let current = '';
  const values: string[] = [];
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === quote && source[index - 1] !== '\\') quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (char === '`') return null; // the template literal ended mid-tuple
    if (char === '(') depth += 1;
    if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        values.push(current.trim());
        return { values, end: index };
      }
    }
    if (char === ',' && depth === 1) {
      values.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  return null;
}

/** Splits text at top-level commas (not inside parentheses or quotes). */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = null;
      current += char;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    if (char === '(') depth += 1;
    if (char === ')') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

export const INSERT = /INSERT\s+(?:IGNORE\s+)?INTO\s+`?(\w+)`?\s*\(([^()]*)\)\s*VALUES\s*\(/gi;

export interface Assignment {
  table: string | null;
  column: string;
  expression: string;
  file: string;
  line: number;
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/**
 * The string delimiter a statement starting at `statementStart` sits in: the
 * quote just before it, or a backtick for a statement mid-literal.
 */
function delimiterOf(source: string, statementStart: number): string {
  let index = statementStart - 1;
  while (index >= 0 && /\s/.test(source[index])) index -= 1;
  return ['`', "'", '"'].includes(source[index]) ? source[index] : '`';
}

/** The rest of the string literal from `start`, up to its closing delimiter. */
function literalRest(source: string, start: number, delimiter = '`'): string {
  let end = source.indexOf(delimiter, start);
  while (end > 0 && source[end - 1] === '\\') end = source.indexOf(delimiter, end + 1);
  return end === -1 ? source.slice(start) : source.slice(start, end);
}

/**
 * Every column a statement writes, with the expression it writes, from
 * INSERT column lists and VALUES, ON DUPLICATE KEY UPDATE, and UPDATE … SET.
 * `dynamicTables` names tables some statement writes with a column list the
 * scanner cannot see.
 */
export function scanWrites(files: string[]): { assignments: Assignment[]; dynamicTables: Set<string> } {
  const assignments: Assignment[] = [];
  const dynamicTables = new Set<string>();

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');

    for (const match of source.matchAll(INSERT)) {
      const table = match[1];
      const columns = match[2];
      const line = lineOf(source, match.index ?? 0);
      if (columns.includes('${')) {
        dynamicTables.add(table);
        continue;
      }
      const parsed = tuple(source, (match.index ?? 0) + match[0].length);
      if (!parsed || parsed.values.some((value) => value.includes('${'))) {
        dynamicTables.add(table);
        continue;
      }
      const names = columns.split(',').map((column) => column.trim().replace(/`/g, '')).filter(Boolean);
      names.forEach((column, index) => assignments.push({ table, column, expression: parsed.values[index] ?? '', file, line }));

      const rest = literalRest(source, parsed.end + 1, delimiterOf(source, match.index ?? 0));
      const duplicate = /ON\s+DUPLICATE\s+KEY\s+UPDATE\s+([\s\S]*)$/i.exec(rest);
      if (duplicate) {
        if (duplicate[1].includes('${')) dynamicTables.add(table);
        for (const part of splitTopLevel(duplicate[1].replace(/\$\{[^}]*\}/g, ''))) {
          const assignment = /^`?(\w+)`?\s*=\s*([\s\S]+)$/.exec(part);
          if (assignment) assignments.push({ table, column: assignment[1], expression: assignment[2].trim(), file, line });
        }
      }
    }

    const UPDATE = /UPDATE\s+`?(\w+)`?(?:\s+(?:AS\s+)?(\w+))?\s+(?:(?:LEFT\s+|INNER\s+)?JOIN[\s\S]*?\s+)?SET\s+/gi;
    for (const match of source.matchAll(UPDATE)) {
      const table = match[1];
      const alias = match[2] && !/^SET$/i.test(match[2]) ? match[2] : null;
      const line = lineOf(source, match.index ?? 0);
      const body = literalRest(source, (match.index ?? 0) + match[0].length, delimiterOf(source, match.index ?? 0)).split(/\bWHERE\b|\bORDER\s+BY\b|\bLIMIT\b/i)[0];
      if (body.includes('${')) dynamicTables.add(table);
      for (const part of splitTopLevel(body.replace(/\$\{[^}]*\}/g, ''))) {
        const assignment = /^(?:`?(\w+)`?\.)?`?(\w+)`?\s*=\s*([\s\S]+)$/.exec(part);
        if (!assignment) continue;
        const qualifier = assignment[1];
        // An assignment qualified with another table's alias (UPDATE a JOIN b SET b.x = …)
        // is not this table's; it is recorded against no table.
        const owner = !qualifier || qualifier === table || qualifier === alias ? table : null;
        assignments.push({ table: owner, column: assignment[2], expression: assignment[3].trim(), file, line });
      }
    }
  }
  return { assignments, dynamicTables };
}
