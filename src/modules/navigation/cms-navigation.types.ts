/**
 * Types for CMS Navigation (Storefront Menus)
 * Manages cms_menus and cms_menu_items tables
 */

import type { RowDataPacket } from 'mysql2'

// ── Enums ────────────────────────────────────────────────────────────────────

export type LinkType =
  | 'url'
  | 'page'
  | 'category'
  | 'collection'
  | 'product'
  | 'article'
  | 'policy'
  | 'ingredient'
  | 'routine'
  | 'none'

export const LINK_TYPES: LinkType[] = [
  'url',
  'page',
  'category',
  'collection',
  'product',
  'article',
  'policy',
  'ingredient',
  'routine',
  'none',
]

export const LINK_TYPE_LABELS: Record<LinkType, string> = {
  url: 'External URL',
  page: 'CMS Page',
  category: 'Category',
  collection: 'Collection',
  product: 'Product',
  article: 'Article',
  policy: 'Policy Page',
  ingredient: 'Ingredient',
  routine: 'Routine',
  none: 'No Link',
}

// ── Database Row Types ───────────────────────────────────────────────────────

export interface MenuRow extends RowDataPacket {
  id: number
  slug: string
  name: string
  is_active: number
  created_at: Date
  updated_at: Date
}

export interface MenuItemRow extends RowDataPacket {
  id: number
  menu_id: number
  parent_id: number | null
  label: string
  link_type: LinkType
  link_ref_id: number | null
  url: string | null
  icon_media_id: number | null
  image_media_id: number | null
  badge_label: string | null
  description: string | null
  sort_order: number
  opens_new_tab: number
  is_active: number
}

export interface MenuItemWithMediaRow extends MenuItemRow {
  icon_storage_key: string | null
  icon_alt_text: string | null
  image_storage_key: string | null
  image_alt_text: string | null
}

export interface MenuItemWithCountRow extends MenuItemRow {
  children_count: number
}

// ── Model Interfaces ─────────────────────────────────────────────────────────

export interface Menu {
  id: number
  slug: string
  name: string
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface MenuListItem extends Menu {
  item_count: number
}

export interface MenuItem {
  id: number
  menu_id: number
  parent_id: number | null
  label: string
  link_type: LinkType
  link_ref_id: number | null
  url: string | null
  icon_media_id: number | null
  image_media_id: number | null
  badge_label: string | null
  description: string | null
  sort_order: number
  opens_new_tab: boolean
  is_active: boolean
}

export interface MenuItemWithMedia extends MenuItem {
  icon_media: {
    id: number
    url: string
    alt_text: string | null
  } | null
  image_media: {
    id: number
    url: string
    alt_text: string | null
  } | null
}

export interface MenuItemTreeNode extends MenuItemWithMedia {
  children: MenuItemTreeNode[]
}

export interface MenuWithItems extends Menu {
  items: MenuItemTreeNode[]
}

// ── DTO Types ────────────────────────────────────────────────────────────────

export interface CreateMenuDto {
  slug: string
  name: string
  is_active?: boolean
}

export interface UpdateMenuDto {
  slug?: string
  name?: string
  is_active?: boolean
}

export interface CreateMenuItemDto {
  menu_id: number
  parent_id?: number | null
  label: string
  link_type: LinkType
  link_ref_id?: number | null
  url?: string | null
  icon_media_id?: number | null
  image_media_id?: number | null
  badge_label?: string | null
  description?: string | null
  sort_order?: number
  opens_new_tab?: boolean
  is_active?: boolean
}

export interface UpdateMenuItemDto {
  parent_id?: number | null
  label?: string
  link_type?: LinkType
  link_ref_id?: number | null
  url?: string | null
  icon_media_id?: number | null
  image_media_id?: number | null
  badge_label?: string | null
  description?: string | null
  sort_order?: number
  opens_new_tab?: boolean
  is_active?: boolean
}

export interface BulkReorderMenuItemDto {
  updates: Array<{
    id: number
    parent_id: number | null
    sort_order: number
  }>
}

// ── Query Params ─────────────────────────────────────────────────────────────

export interface ListMenusParams {
  is_active?: boolean
}

export interface ListMenuItemsParams {
  menu_id?: number
  parent_id?: number | null
  link_type?: LinkType
  is_active?: boolean
  include_nested?: boolean
}

// ── Link Resolution ──────────────────────────────────────────────────────────

export interface ResolvedLink {
  type: LinkType
  url: string | null
  ref_id: number | null
  ref_slug: string | null
  ref_title: string | null
  is_available: boolean
}

export interface MenuItemWithResolvedLink extends MenuItemWithMedia {
  resolved_link: ResolvedLink
}

// ── Helper Types ─────────────────────────────────────────────────────────────

export interface MenuItemPosition {
  id: number
  parent_id: number | null
  sort_order: number
}
