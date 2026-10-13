/**
 * The Journal — long-form articles: routines, ingredient explainers, what to
 * expect from a product.
 *
 * Skincare content is regulated content. The schema already carries
 * `medically_reviewed_by`, `reviewed_at` and `next_review_due`, and those are
 * not decoration: a claim that was safe to publish in March can need revisiting,
 * and an article nobody has re-read in a year is a liability. The admin surfaces
 * them; the storefront publishes the reviewer's name alongside the byline.
 */

export type ArticleStatus = 'draft' | 'in_review' | 'scheduled' | 'published' | 'archived';

export interface ArticleRow {
  id: number;
  public_id: string;
  blog_id: number;
  category_id: number | null;
  slug: string;
  title: string;
  subtitle: string | null;
  excerpt: string | null;
  body_html: string | null;
  cover_media_id: number | null;
  locale: string;
  author_name: string | null;
  author_title: string | null;
  author_media_id: number | null;
  medically_reviewed_by: string | null;
  reviewed_at: Date | string | null;
  next_review_due: Date | string | null;
  read_time_minutes: number | null;
  status: ArticleStatus;
  is_featured: number;
  published_at: Date | null;
  scheduled_at: Date | null;
  is_indexable: number;
  view_count: number;
  created_at: Date;
  updated_at: Date;
}

/** What a list row carries — joined names, no body. */
export interface ArticleListRow extends Omit<ArticleRow, 'body_html'> {
  category_name: string | null;
  category_slug: string | null;
  blog_slug: string;
  blog_title: string;
  cover_key: string | null;
  cover_alt: string | null;
}

export interface ArticleDetailRow extends ArticleListRow {
  body_html: string | null;
  author_media_key: string | null;
  meta_title: string | null;
  meta_description: string | null;
}

export interface ArticleInput {
  blog_id?: number;
  category_id?: number | null;
  slug?: string;
  title: string;
  subtitle?: string | null;
  excerpt?: string | null;
  body_html?: string | null;
  cover_media_id?: number | null;
  author_name?: string | null;
  author_title?: string | null;
  author_media_id?: number | null;
  medically_reviewed_by?: string | null;
  reviewed_at?: string | null;
  next_review_due?: string | null;
  read_time_minutes?: number | null;
  is_featured?: boolean;
  is_indexable?: boolean;
  scheduled_at?: string | null;
  product_ids?: number[];
}

export interface ArticleFilters {
  q?: string;
  status?: ArticleStatus;
  category_id?: number;
  blog_id?: number;
  featured?: boolean;
  /** Reviewed content whose next review date has passed. */
  review_due?: boolean;
}
