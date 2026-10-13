export interface PageParams {
  page: number;
  limit: number;
  offset: number;
}

export interface PaginationMeta {
  total: number;
  page: number;
  limit: number;
  pages: number;
  has_next: boolean;
  has_prev: boolean;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

export function parsePagination(query: Record<string, unknown>): PageParams {
  const rawLimit = Number(query.limit);
  const rawPage = Number(query.page);

  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.floor(rawPage) : 1;

  return { page, limit, offset: (page - 1) * limit };
}

export function buildMeta(total: number, { page, limit }: PageParams): PaginationMeta {
  const pages = limit > 0 ? Math.ceil(total / limit) : 0;
  return {
    total,
    page,
    limit,
    pages,
    has_next: page < pages,
    has_prev: page > 1,
  };
}

/**
 * Whitelisted sorting. Accepting a raw column name from the query string and
 * interpolating it is the classic ORDER BY injection, so the caller declares
 * which columns are sortable and anything else falls back to the default.
 */
export function parseSort(
  raw: unknown,
  allowed: Record<string, string>,
  fallback: string,
): string {
  if (typeof raw !== 'string' || raw.length === 0) return fallback;
  const [field, dirRaw] = raw.split(':');
  const column = allowed[field];
  if (!column) return fallback;
  const direction = dirRaw?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  return `${column} ${direction}`;
}

/** Parses `?fields=id,name,slug` into a validated subset. */
export function parseFields(raw: unknown, allowed: string[]): string[] | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const requested = raw
    .split(',')
    .map((f) => f.trim())
    .filter((f) => allowed.includes(f));
  return requested.length > 0 ? requested : null;
}
