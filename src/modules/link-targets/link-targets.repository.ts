import { query, queryOne, pool, type Executor, type RowDataPacket } from '../../db/pool';

/**
 * The things a link can point at, searchable by name.
 *
 * One module rather than a fetch per entity in the admin, because the admin has
 * the same job in three places — a banner's call to action, a menu item, a story
 * section's link — and each of them used to make the merchandiser type a numeric
 * id. Doing the lookup here means the search happens in SQL against an indexed
 * column rather than by pulling the whole catalogue into a browser and filtering
 * it, and it means adding a new kind of link target is a change on the server
 * rather than in three forms.
 */

export interface LinkTargetRow extends RowDataPacket {
  id: number;
  label: string;
  /** The second line: a slug, a path, whatever tells two similar rows apart. */
  hint: string | null;
  /** Set when this target would not actually be reachable on the storefront. */
  warning: string | null;
}

export const LINK_TARGET_TYPES = [
  'product',
  'category',
  'collection',
  'page',
  'policy',
  'article',
  'ingredient',
  'routine',
  'coupon',
] as const;

export type LinkTargetType = (typeof LINK_TARGET_TYPES)[number];

/**
 * A source, in parts, so the search query and the by-id query are composed from
 * the same pieces.
 *
 * Every one of these tables spells its own name differently — `name` here,
 * `title` there, `is_active` on one and `status` on the next — so each is
 * written out. What is *not* written out twice is the SELECT list and the
 * filter that decides whether a row exists at all: if those two queries drifted
 * apart, a form would open showing one label and searching would offer another.
 */
interface Source {
  /** The columns, aliased to id / label / hint / warning. */
  select: string;
  from: string;
  /** True for any row that may be offered at all — not deleted, right subtype. */
  scope: string;
  /** Columns a search term is matched against. */
  searchable: string[];
  order: string;
  /** Qualifies `id` when the FROM clause uses an alias. */
  idColumn: string;
}

const SOURCES: Record<LinkTargetType, Source> = {
  product: {
    select: `p.id,
             p.name AS label,
             CONCAT(p.slug, COALESCE(CONCAT(' · ', c.name), '')) AS hint,
             CASE
               WHEN p.status <> 'active' THEN CONCAT('Not live — ', p.status)
               WHEN p.visibility <> 'public' THEN 'Hidden from the storefront'
               ELSE NULL
             END AS warning`,
    from: `products p LEFT JOIN categories c ON c.id = p.category_id AND c.deleted_at IS NULL`,
    // Drafts stay — a banner is often built for something going live on Friday,
    // and the row says so. Archived ones go: they are retired, a link to one is
    // dead on arrival, and they are exactly the rows that pile up under
    // identical names and bury the products someone is actually looking for.
    scope: `p.deleted_at IS NULL AND p.status <> 'archived'`,
    searchable: ['p.name', 'p.slug'],
    order: `(p.status = 'active') DESC, p.name ASC`,
    idColumn: 'p.id',
  },
  category: {
    select: `id, name AS label, slug AS hint,
             CASE WHEN is_active = 0 THEN 'Not active' ELSE NULL END AS warning`,
    from: 'categories',
    scope: 'deleted_at IS NULL',
    searchable: ['name', 'slug'],
    order: 'is_active DESC, name ASC',
    idColumn: 'id',
  },
  collection: {
    select: `id, title AS label, slug AS hint,
             CASE WHEN is_active = 0 THEN 'Not active' ELSE NULL END AS warning`,
    from: 'collections',
    scope: 'deleted_at IS NULL',
    searchable: ['title', 'slug'],
    order: 'is_active DESC, title ASC',
    idColumn: 'id',
  },
  page: {
    select: `id, title AS label, COALESCE(full_path, slug) AS hint,
             CASE WHEN status <> 'published' THEN CONCAT('Not live — ', status) ELSE NULL END AS warning`,
    from: 'cms_pages',
    // Policies live in this same table behind a page_type. They are offered as
    // their own list rather than buried among the standard pages, so each side
    // excludes the other.
    scope: `deleted_at IS NULL AND page_type <> 'policy'`,
    searchable: ['title', 'slug'],
    order: `(status = 'published') DESC, title ASC`,
    idColumn: 'id',
  },
  policy: {
    select: `id, title AS label, COALESCE(full_path, slug) AS hint,
             CASE WHEN status <> 'published' THEN CONCAT('Not live — ', status) ELSE NULL END AS warning`,
    from: 'cms_pages',
    scope: `deleted_at IS NULL AND page_type = 'policy'`,
    searchable: ['title', 'slug'],
    order: `(status = 'published') DESC, title ASC`,
    idColumn: 'id',
  },
  article: {
    select: `id, title AS label, slug AS hint,
             CASE WHEN status <> 'published' THEN CONCAT('Not live — ', status) ELSE NULL END AS warning`,
    from: 'cms_articles',
    scope: 'deleted_at IS NULL',
    searchable: ['title', 'slug'],
    order: `(status = 'published') DESC, published_at DESC, title ASC`,
    idColumn: 'id',
  },
  ingredient: {
    select: `id, name AS label, COALESCE(inci_name, slug) AS hint,
             CASE WHEN status <> 'active' THEN CONCAT('Not live — ', status) ELSE NULL END AS warning`,
    from: 'ingredients',
    scope: 'deleted_at IS NULL',
    searchable: ['name', 'slug', 'inci_name'],
    order: `(status = 'active') DESC, name ASC`,
    idColumn: 'id',
  },
  // Offers, for the announcement strip. The hint carries what the code is
  // actually worth, because a merchandiser choosing between DIWALI20 and
  // DIWALI25 should not have to open another tab to tell them apart.
  coupon: {
    select: `id, code AS label,
             CONCAT(
               COALESCE(CONCAT(title, ' · '), ''),
               CASE discount_type
                 WHEN 'percentage'    THEN CONCAT(FORMAT(value, 0), '% off')
                 WHEN 'fixed_amount'  THEN CONCAT(FORMAT(value, 0), ' off')
                 WHEN 'free_shipping' THEN 'Free delivery'
                 ELSE discount_type
               END
             ) AS hint,
             CASE
               WHEN is_active = 0 THEN 'Switched off'
               WHEN starts_at IS NOT NULL AND starts_at > NOW() THEN 'Not started yet'
               WHEN ends_at IS NOT NULL AND ends_at < NOW() THEN 'Finished'
               WHEN usage_limit_total IS NOT NULL AND used_count >= usage_limit_total THEN 'Fully used'
               ELSE NULL
             END AS warning`,
    from: 'coupons',
    scope: '1 = 1',
    searchable: ['code', 'title'],
    order: `is_active DESC, (ends_at IS NULL OR ends_at >= NOW()) DESC, code ASC`,
    idColumn: 'id',
  },
  routine: {
    select: `id, name AS label, slug AS hint,
             CASE WHEN status <> 'active' THEN CONCAT('Not live — ', status) ELSE NULL END AS warning`,
    from: 'routines',
    scope: '1 = 1',
    searchable: ['name', 'slug'],
    order: `(status = 'active') DESC, name ASC`,
    idColumn: 'id',
  },
};

export const linkTargetsRepository = {
  async search(
    type: LinkTargetType,
    term: string,
    limit: number,
    exec: Executor = pool,
  ): Promise<LinkTargetRow[]> {
    const source = SOURCES[type];
    // An empty term lists the first page rather than nothing: opening the picker
    // and being shown a blank panel reads as broken, and for a short list it is
    // the whole answer without anyone typing.
    const filter = term ? ` AND (${source.searchable.map((column) => `${column} LIKE ?`).join(' OR ')})` : '';
    const params = term ? source.searchable.map(() => `%${term}%`) : [];
    // The limit is interpolated because MySQL will not take a placeholder for
    // LIMIT in a prepared statement. It is a validated integer by the time it
    // reaches here, never a string from the client.
    return query<LinkTargetRow>(
      `SELECT ${source.select} FROM ${source.from} WHERE ${source.scope}${filter} ORDER BY ${source.order} LIMIT ${limit}`,
      params,
      exec,
    );
  },

  /**
   * One target by id, for a form opening on a value saved months ago.
   *
   * Without this the picker would show a bare number until the merchandiser
   * searched for what it was — which is the problem it exists to remove.
   */
  async byId(type: LinkTargetType, id: number, exec: Executor = pool): Promise<LinkTargetRow | null> {
    const source = SOURCES[type];
    const row = await queryOne<LinkTargetRow>(
      `SELECT ${source.select} FROM ${source.from} WHERE ${source.scope} AND ${source.idColumn} = ? LIMIT 1`,
      [id],
      exec,
    );
    return row ?? null;
  },
};
