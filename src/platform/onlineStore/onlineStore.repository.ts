import { execute, pool, query, queryOne, type Executor, type RowDataPacket } from '../../db/pool';
import { storage } from '../../modules/media/storage';
import { shopId } from '../tenancy/context';

/**
 * The reads the Online Store renderer needs that the Storefront API does not
 * expose one at a time: a collection by handle (a curated collection, or a
 * category — both are "collections" to a theme, as they are on Shopify),
 * every collection, a menu with its links resolved to Online Store URLs.
 */

export interface CollectionRow extends RowDataPacket {
  id: number;
  kind: 'collection' | 'category';
  handle: string;
  title: string;
  description: string | null;
  meta_title: string | null;
  meta_description: string | null;
  image_key: string | null;
  product_count: number;
  template_suffix: string | null;
  sort_type: string | null;
  published_at: Date | null;
  updated_at: Date | null;
  /** The merchant's "show in menu": what an empty menu falls back to first. */
  show_in_menu: number;
}

export interface MenuLinkRow extends RowDataPacket {
  id: number;
  parent_id: number | null;
  label: string;
  link_type: string;
  link_ref_id: number | null;
  url: string | null;
  ref_handle: string | null;
  ref_available: number | null;
  image_key: string | null;
  opens_new_tab: number;
}

export function mediaUrl(key: string | null | undefined): string | null {
  return key ? storage.publicUrl(key) : null;
}

const COLLECTION_SELECT = `
  SELECT c.id, 'collection' AS kind, c.slug AS handle, c.title, c.description, c.meta_title, c.meta_description,
         m.storage_key AS image_key, c.product_count, c.template_suffix, c.sort_type, c.published_at, c.updated_at, c.show_in_menu
    FROM collections c
    LEFT JOIN media m ON m.shop_id = c.shop_id AND m.id = COALESCE(c.image_media_id, c.banner_media_id) AND m.deleted_at IS NULL
   WHERE c.shop_id = ? AND c.deleted_at IS NULL AND c.is_active = 1 AND (c.published_at IS NULL OR c.published_at <= NOW())`;

const CATEGORY_SELECT = `
  SELECT g.id, 'category' AS kind, g.slug AS handle, g.name AS title, g.description, NULL AS meta_title, g.short_description AS meta_description,
         m.storage_key AS image_key, g.product_count, NULL AS template_suffix, NULL AS sort_type, NULL AS published_at, g.updated_at, 1 AS show_in_menu
    FROM categories g
    LEFT JOIN media m ON m.shop_id = g.shop_id AND m.id = COALESCE(g.thumbnail_media_id, g.banner_media_id) AND m.deleted_at IS NULL
   WHERE g.shop_id = ? AND g.deleted_at IS NULL AND g.is_active = 1`;

export interface MediaRow extends RowDataPacket {
  id: number;
  storage_key: string;
  alt_text: string | null;
  width: number | null;
  height: number | null;
}

export const onlineStoreRepository = {
  /** Images chosen in theme settings (image_picker), by media id. */
  async media(ids: number[], exec: Executor = pool): Promise<MediaRow[]> {
    if (ids.length === 0) return [];
    return query<MediaRow>(
      `SELECT id, storage_key, alt_text, width, height FROM media WHERE shop_id = ? AND id IN (${ids.map(() => '?').join(', ')}) AND deleted_at IS NULL`,
      [shopId(), ...ids],
      exec,
    );
  },

  /** A curated collection first, then a category with that handle. */
  async collectionByHandle(handle: string, exec: Executor = pool): Promise<CollectionRow | null> {
    return (
      (await queryOne<CollectionRow>(`${COLLECTION_SELECT} AND c.slug = ? LIMIT 1`, [shopId(), handle], exec)) ??
      (await queryOne<CollectionRow>(`${CATEGORY_SELECT} AND g.slug = ? LIMIT 1`, [shopId(), handle], exec))
    );
  },

  /** Every collection a shopper can browse: curated ones, then top-level categories. */
  async allCollections(exec: Executor = pool): Promise<CollectionRow[]> {
    const curated = await query<CollectionRow>(`${COLLECTION_SELECT} ORDER BY c.sort_order, c.title LIMIT 100`, [shopId()], exec);
    const categories = await query<CollectionRow>(`${CATEGORY_SELECT} AND g.parent_id IS NULL ORDER BY g.sort_order, g.name LIMIT 100`, [shopId()], exec);
    return [...curated, ...categories];
  },

  async menuBySlug(slug: string, exec: Executor = pool): Promise<{ id: number; slug: string; name: string } | null> {
    return queryOne<RowDataPacket & { id: number; slug: string; name: string }>(
      'SELECT id, slug, name FROM cms_menus WHERE shop_id = ? AND slug = ? AND is_active = 1 LIMIT 1',
      [shopId(), slug],
      exec,
    );
  },

  async menus(exec: Executor = pool): Promise<{ id: number; slug: string; name: string }[]> {
    return query<RowDataPacket & { id: number; slug: string; name: string }>('SELECT id, slug, name FROM cms_menus WHERE shop_id = ? AND is_active = 1 ORDER BY id', [shopId()], exec);
  },

  /** A menu's links with what each points at, in one query. */
  async menuLinks(menuId: number, exec: Executor = pool): Promise<MenuLinkRow[]> {
    return query<MenuLinkRow>(
      `SELECT i.id, i.parent_id, i.label, i.link_type, i.link_ref_id, i.url, i.opens_new_tab, m.storage_key AS image_key,
              CASE i.link_type
                WHEN 'product'    THEN (SELECT p.slug  FROM products p    WHERE p.shop_id = i.shop_id AND p.id = i.link_ref_id AND p.deleted_at IS NULL)
                WHEN 'collection' THEN (SELECT c.slug  FROM collections c WHERE c.shop_id = i.shop_id AND c.id = i.link_ref_id AND c.deleted_at IS NULL)
                WHEN 'category'   THEN (SELECT g.slug  FROM categories g  WHERE g.shop_id = i.shop_id AND g.id = i.link_ref_id AND g.deleted_at IS NULL)
                WHEN 'page'       THEN (SELECT pg.slug FROM cms_pages pg  WHERE pg.shop_id = i.shop_id AND pg.id = i.link_ref_id AND pg.deleted_at IS NULL)
                WHEN 'article'    THEN (SELECT a.slug  FROM cms_articles a WHERE a.shop_id = i.shop_id AND a.id = i.link_ref_id AND a.deleted_at IS NULL)
                WHEN 'blog'       THEN (SELECT b.slug  FROM cms_blogs b   WHERE b.shop_id = i.shop_id AND b.id = i.link_ref_id)
              END AS ref_handle,
              1 AS ref_available
         FROM cms_menu_items i
         LEFT JOIN media m ON m.shop_id = i.shop_id AND m.id = i.image_media_id AND m.deleted_at IS NULL
        WHERE i.shop_id = ? AND i.menu_id = ? AND i.is_active = 1
        ORDER BY i.parent_id IS NOT NULL, i.sort_order, i.id`,
      [shopId(), menuId],
      exec,
    );
  },

  async publishedPages(exec: Executor = pool) {
    return query<RowDataPacket & { slug: string; title: string }>(
      "SELECT slug, title FROM cms_pages WHERE shop_id = ? AND status = 'published' AND deleted_at IS NULL AND (published_at IS NULL OR published_at <= NOW()) ORDER BY title LIMIT 100",
      [shopId()],
      exec,
    );
  },

  async blogs(exec: Executor = pool) {
    return query<RowDataPacket & { id: number; slug: string; title: string; description: string | null; comments_policy: 'disabled' | 'moderated' | 'published' }>(
      'SELECT id, slug, title, description, comments_policy FROM cms_blogs WHERE shop_id = ? AND is_active = 1 ORDER BY id',
      [shopId()],
      exec,
    );
  },

  /** /recommendations/products?product_id= names a product by id. */
  async productHandle(productId: number, exec: Executor = pool): Promise<string | null> {
    const row = await queryOne<RowDataPacket & { slug: string }>(
      "SELECT slug FROM products WHERE shop_id = ? AND id = ? AND status = 'active' AND deleted_at IS NULL LIMIT 1",
      [shopId(), productId],
      exec,
    );
    return row?.slug ?? null;
  },

  /** The contact form (form 'contact'): kept for the merchant's inbox. */
  async saveContactMessage(
    message: { name: string | null; email: string; phone: string | null; body: string; fields: Record<string, unknown>; pagePath: string; ip: string | null; userAgent: string | null },
    exec: Executor = pool,
  ): Promise<void> {
    await execute(
      `INSERT INTO contact_messages (shop_id, name, email, phone, body, fields, page_path, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [shopId(), message.name, message.email, message.phone, message.body, JSON.stringify(message.fields), message.pagePath, message.ip, message.userAgent],
      exec,
    );
  },

  /** A real product, collection, page and article to preview each template with in the editor. */
  async sampleHandles(exec: Executor = pool) {
    const [product, collection, page, article] = await Promise.all([
      queryOne<RowDataPacket & { handle: string }>(
        "SELECT slug AS handle FROM products WHERE shop_id = ? AND status = 'active' AND deleted_at IS NULL ORDER BY is_bestseller DESC, id DESC LIMIT 1",
        [shopId()],
        exec,
      ),
      queryOne<RowDataPacket & { handle: string }>(
        'SELECT slug AS handle FROM collections WHERE shop_id = ? AND deleted_at IS NULL AND is_active = 1 ORDER BY sort_order, id LIMIT 1',
        [shopId()],
        exec,
      ),
      queryOne<RowDataPacket & { handle: string }>(
        "SELECT slug AS handle FROM cms_pages WHERE shop_id = ? AND status = 'published' AND deleted_at IS NULL ORDER BY id LIMIT 1",
        [shopId()],
        exec,
      ),
      queryOne<RowDataPacket & { handle: string; blog: string }>(
        `SELECT a.slug AS handle, COALESCE(b.slug, 'journal') AS blog FROM cms_articles a LEFT JOIN cms_blogs b ON b.shop_id = a.shop_id AND b.id = a.blog_id
          WHERE a.shop_id = ? AND a.status = 'published' AND a.deleted_at IS NULL ORDER BY a.published_at DESC LIMIT 1`,
        [shopId()],
        exec,
      ),
    ]);
    return { product: product?.handle ?? null, collection: collection?.handle ?? null, page: page?.handle ?? null, article: article ? { blog: article.blog, handle: article.handle } : null };
  },

  /** For sitemap.xml. */
  async sitemapEntries(exec: Executor = pool) {
    const [products, collections, pages, articles] = await Promise.all([
      query<RowDataPacket & { handle: string; updated_at: Date }>(
        "SELECT slug AS handle, updated_at FROM products WHERE shop_id = ? AND status = 'active' AND deleted_at IS NULL AND (published_at IS NULL OR published_at <= NOW()) ORDER BY id LIMIT 5000",
        [shopId()],
        exec,
      ),
      this.allCollections(exec),
      query<RowDataPacket & { handle: string; updated_at: Date }>(
        "SELECT slug AS handle, updated_at FROM cms_pages WHERE shop_id = ? AND status = 'published' AND deleted_at IS NULL AND show_in_sitemap = 1 LIMIT 1000",
        [shopId()],
        exec,
      ),
      query<RowDataPacket & { handle: string; blog: string; updated_at: Date }>(
        `SELECT a.slug AS handle, COALESCE(b.slug, 'journal') AS blog, a.updated_at FROM cms_articles a LEFT JOIN cms_blogs b ON b.shop_id = a.shop_id AND b.id = a.blog_id
          WHERE a.shop_id = ? AND a.status = 'published' AND a.deleted_at IS NULL LIMIT 2000`,
        [shopId()],
        exec,
      ),
    ]);
    return { products, collections, pages, articles };
  },
};
