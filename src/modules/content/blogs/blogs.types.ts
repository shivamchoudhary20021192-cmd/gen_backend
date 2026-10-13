/**
 * Blogs — the publications that articles are filed under.
 *
 * Shopify's model, and the one `cms_blogs` was built for: a shop runs one or
 * more blogs ("Journal", "News", "Ingredient guides"), each with its own handle
 * and its own page on the storefront, and every article belongs to exactly one.
 * Until now the table held a single row nobody could see or change, and every
 * article was silently filed into whichever blog happened to be first.
 */

export interface BlogRow {
  id: number;
  slug: string;
  title: string;
  description: string | null;
  is_active: number;
  comments_policy: 'disabled' | 'moderated' | 'published';
  created_at: Date;
}

/** A list row carries the counts an editor needs to decide anything. */
export interface BlogListRow extends BlogRow {
  article_count: number;
  published_count: number;
  last_published_at: Date | null;
}

export interface BlogInput {
  slug?: string;
  title: string;
  description?: string | null;
  is_active?: boolean;
  comments_policy?: 'disabled' | 'moderated' | 'published';
}
