/**
 * Splits a .sql file into individual statements the way the `mysql` client
 * does, so migrations can run through the driver instead of shelling out.
 *
 * The legacy schema files lean on two client-side features the driver does not
 * understand: `DELIMITER $$` blocks around stored procedures, and statement
 * separators that only count when they sit outside quotes and comments. Both
 * are handled here, and nothing else is — this is a splitter, not a parser.
 *
 * Comments are kept inside the statement they belong to. MySQL ignores them,
 * and keeping them means an error message quotes the statement the way it
 * appears in the file.
 */
export function splitSqlStatements(source: string): string[] {
  const statements: string[] = [];
  let delimiter = ';';
  let current = '';
  let i = 0;

  const flush = () => {
    const trimmed = current.trim();
    if (trimmed.length > 0 && !isOnlyComments(trimmed)) statements.push(trimmed);
    current = '';
  };

  while (i < source.length) {
    // DELIMITER is only recognised at the start of a line, like the client.
    if (atLineStart(source, i)) {
      const lineEnd = indexOfOr(source, '\n', i);
      const line = source.slice(i, lineEnd);
      const match = /^\s*DELIMITER\s+(\S+)\s*$/i.exec(line);
      if (match) {
        flush();
        delimiter = match[1];
        i = lineEnd + 1;
        continue;
      }
    }

    const ch = source[i];
    const next = source[i + 1];

    // Line comments: `-- ` (MySQL requires the space) and `#`.
    if ((ch === '-' && next === '-' && /\s/.test(source[i + 2] ?? ' ')) || ch === '#') {
      const end = indexOfOr(source, '\n', i);
      current += source.slice(i, end);
      i = end;
      continue;
    }

    // Block comments, including /*! versioned */ ones, which are kept verbatim.
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      current += source.slice(i, stop);
      i = stop;
      continue;
    }

    // Quoted strings and identifiers. A doubled quote is an escaped quote, and
    // a backslash escapes the next character inside '...' and "...".
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\' && ch !== '`') {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          if (source[i + 1] === ch) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      current += source.slice(start, i);
      continue;
    }

    if (source.startsWith(delimiter, i)) {
      flush();
      i += delimiter.length;
      continue;
    }

    current += ch;
    i += 1;
  }

  flush();
  return statements;
}

function atLineStart(source: string, index: number): boolean {
  return index === 0 || source[index - 1] === '\n';
}

function indexOfOr(source: string, needle: string, from: number): number {
  const found = source.indexOf(needle, from);
  return found === -1 ? source.length : found;
}

function isOnlyComments(statement: string): boolean {
  const stripped = statement
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|\n)\s*(--\s|#)[^\n]*/g, '\n')
    .trim();
  return stripped.length === 0;
}
