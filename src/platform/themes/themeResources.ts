import { pool, query, type RowDataPacket } from '../../db/pool';
import { storage } from '../../modules/media/storage';
import { shopId } from '../tenancy/context';

/**
 * What the theme editor's pickers choose from. Theme settings store handles
 * (a `collection` setting holds "summer-sale", not an id) — the way Shopify
 * themes do, so a template survives being copied to another store with the
 * same handles, and reads naturally in the code editor.
 */

export type ResourceType = 'product' | 'collection' | 'page' | 'blog' | 'link_list' | 'article';

export interface Resource {
  handle: string;
  title: string;
  image: string | null;
  hint: string | null;
}

interface Row extends RowDataPacket {
  handle: string;
  title: string;
  image_key: string | null;
  hint: string | null;
}

const LIMIT = 25;

function like(term: string): string {
  return `%${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function present(rows: Row[]): Resource[] {
  return rows.map((row) => ({ handle: row.handle, title: row.title, image: row.image_key ? storage.publicUrl(row.image_key) : null, hint: row.hint }));
}

export const themeResources = {
  /** Search by title or handle; `handles` resolves chosen values back to titles. */
  async search(type: ResourceType, term: string | null, handles: string[] = []): Promise<Resource[]> {
    const q = term?.trim() ? like(term.trim()) : null;
    const byHandle = handles.length > 0;
    const handleSql = (column: string) => (byHandle ? ` AND ${column} IN (${handles.map(() => '?').join(', ')})` : '');
    const termSql = (title: string, handle: string) => (q ? ` AND (${title} LIKE ? OR ${handle} LIKE ?)` : '');
    const params = (): unknown[] => [shopId(), ...(q ? [q, q] : []), ...handles];

    switch (type) {
      case 'product':
        return present(
          await query<Row>(
            `SELECT p.slug AS handle, p.name AS title, p.status AS hint,
                    (SELECT m.storage_key FROM media_attachments ma JOIN media m ON m.id = ma.media_id
                      WHERE ma.shop_id = p.shop_id AND ma.attachable_type = 'product' AND ma.attachable_id = p.id AND ma.collection = 'gallery'
                      ORDER BY ma.is_primary DESC, ma.sort_order ASC LIMIT 1) AS image_key
               FROM products p
              WHERE p.shop_id = ? AND p.deleted_at IS NULL${termSql('p.name', 'p.slug')}${handleSql('p.slug')}
              ORDER BY p.status = 'active' DESC, p.name LIMIT ${LIMIT}`,
            params(),
            pool,
          ),
        );
      case 'collection': {
        const curated = await query<Row>(
          `SELECT c.slug AS handle, c.title, m.storage_key AS image_key, 'Collection' AS hint
             FROM collections c LEFT JOIN media m ON m.shop_id = c.shop_id AND m.id = COALESCE(c.image_media_id, c.banner_media_id)
            WHERE c.shop_id = ? AND c.deleted_at IS NULL${termSql('c.title', 'c.slug')}${handleSql('c.slug')}
            ORDER BY c.title LIMIT ${LIMIT}`,
          params(),
          pool,
        );
        const categories = await query<Row>(
          `SELECT g.slug AS handle, g.name AS title, m.storage_key AS image_key, 'Category' AS hint
             FROM categories g LEFT JOIN media m ON m.shop_id = g.shop_id AND m.id = COALESCE(g.thumbnail_media_id, g.banner_media_id)
            WHERE g.shop_id = ? AND g.deleted_at IS NULL${termSql('g.name', 'g.slug')}${handleSql('g.slug')}
            ORDER BY g.name LIMIT ${LIMIT}`,
          params(),
          pool,
        );
        const seen = new Set<string>();
        return present([...curated, ...categories].filter((row) => !seen.has(row.handle) && seen.add(row.handle))).slice(0, LIMIT);
      }
      case 'page':
        return present(
          await query<Row>(
            `SELECT slug AS handle, title, NULL AS image_key, status AS hint FROM cms_pages
              WHERE shop_id = ? AND deleted_at IS NULL${termSql('title', 'slug')}${handleSql('slug')} ORDER BY title LIMIT ${LIMIT}`,
            params(),
            pool,
          ),
        );
      case 'blog':
        return present(
          await query<Row>(
            `SELECT slug AS handle, title, NULL AS image_key, NULL AS hint FROM cms_blogs
              WHERE shop_id = ?${termSql('title', 'slug')}${handleSql('slug')} ORDER BY title LIMIT ${LIMIT}`,
            params(),
            pool,
          ),
        );
      case 'article':
        return present(
          await query<Row>(
            `SELECT slug AS handle, title, NULL AS image_key, status AS hint FROM cms_articles
              WHERE shop_id = ? AND deleted_at IS NULL${termSql('title', 'slug')}${handleSql('slug')} ORDER BY published_at DESC LIMIT ${LIMIT}`,
            params(),
            pool,
          ),
        );
      case 'link_list': {
        const menus = present(
          await query<Row>(
            `SELECT slug AS handle, name AS title, NULL AS image_key, NULL AS hint FROM cms_menus
              WHERE shop_id = ?${termSql('name', 'slug')}${handleSql('slug')} ORDER BY name LIMIT ${LIMIT}`,
            params(),
            pool,
          ),
        );
        // Shopify's default menu handles work too; they map onto this store's menus.
        const aliases: Resource[] = [
          { handle: 'main-menu', title: 'Main menu', image: null, hint: 'Default' },
          { handle: 'footer', title: 'Footer menu', image: null, hint: 'Default' },
        ].filter((alias) => (!byHandle || handles.includes(alias.handle)) && (!q || alias.title.toLowerCase().includes(term!.trim().toLowerCase())));
        return [...aliases, ...menus];
      }
      default:
        return [];
    }
  },
};
