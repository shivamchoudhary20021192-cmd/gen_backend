/* eslint-disable @typescript-eslint/no-explicit-any */
import { Drop } from 'liquidjs';
import { storefrontService } from '../../modules/storefront/storefront.service';
import { contentPublicService } from '../../modules/content/public/contentPublic.service';
import { handleize } from './engine/filters';
import { mediaUrl, onlineStoreRepository, type CollectionRow, type MenuLinkRow } from './onlineStore.repository';
import { tr, willTranslate } from './translations';

/**
 * The Liquid objects a theme sees, shaped like Shopify's so theme code
 * written against Shopify's documentation works: prices in cents,
 * `product.selected_or_first_available_variant`, `collection.products`,
 * `linklists['main-menu'].links`, `cart.items`, `all_products['handle']`…
 *
 * They wrap the same services the Storefront API uses, so the Online Store
 * and a headless storefront can never price or stock a product differently.
 * Everything that costs a query is lazy: a template that never mentions
 * `collections.sale.products` never loads them.
 */

type Any = any;

export const cents = (value: unknown): number | null => (value === null || value === undefined ? null : Math.round(Number(value) * 100));

export interface ImageLike {
  src: string;
  url: string;
  alt: string;
  width: number | null;
  height: number | null;
  aspect_ratio: number;
  id: number | string | null;
  media_type: 'image';
  preview_image: { src: string; alt: string; aspect_ratio: number; width: number | null; height: number | null };
}

export function imageDrop(src: string | null | undefined, alt = '', size?: { width?: number | null; height?: number | null; id?: number | string | null }): ImageLike | null {
  if (!src) return null;
  const width = size?.width ?? null;
  const height = size?.height ?? null;
  const ratio = width && height ? width / height : 1;
  return {
    src,
    url: src,
    alt,
    width,
    height,
    aspect_ratio: ratio,
    id: size?.id ?? null,
    media_type: 'image',
    preview_image: { src, alt, aspect_ratio: ratio, width, height },
    toString() {
      return src;
    },
  } as ImageLike;
}

// ── custom fields (Products (new) › Custom fields) ─────────────────────────

interface StorefrontFieldLike {
  namespace: string;
  key: string;
  name: string;
  description: string | null;
  type: string;
  list: boolean;
  value: unknown;
  text: string;
  html: string | null;
}

/**
 * A custom field as Shopify themes read one: printed, it is its text (rich
 * text as HTML) — `{{ product.metafields.custom.material }}`; `.value` is the
 * value itself (a measurement's `.value.unit`, a file as an image for
 * `image_url`, a metaobject entry's fields, a product's `url`), `.type` its type.
 */
export class MetafieldDrop extends Drop {
  constructor(private readonly field: StorefrontFieldLike) {
    super();
  }
  get value() {
    const one = (item: unknown): unknown => {
      const record = item as Any;
      if (this.field.type.endsWith('file_reference')) {
        return record?.media_type === 'image' ? imageDrop(record.url, record.alt ?? this.field.name, { width: record.width, height: record.height, id: record.id }) : record;
      }
      if (this.field.type.endsWith('metaobject_reference')) return new MetaobjectDrop(record);
      return item;
    };
    return this.field.list && Array.isArray(this.field.value) ? this.field.value.map(one) : one(this.field.value);
  }
  /** Always a list — one item for a single value — so a template can loop over either. */
  get values() {
    const value = this.value;
    return Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
  }
  get list() {
    return this.field.list;
  }
  get type() {
    return this.field.type;
  }
  get key() {
    return this.field.key;
  }
  get namespace() {
    return this.field.namespace;
  }
  get name() {
    return this.field.name;
  }
  get description() {
    return this.field.description;
  }
  get text() {
    return this.field.text;
  }
  get html() {
    return this.field.html;
  }
  override valueOf() {
    return this.field.html ?? this.field.text;
  }
  toJSON() {
    return this.field.value;
  }
}

/** A metaobject entry: `entry.display_name`, `entry.handle`, and each field by key — `entry.benefit.value`. */
export class MetaobjectDrop extends Drop {
  constructor(private readonly entry: { id: number; type: string; handle: string; display_name: string; fields: Record<string, StorefrontFieldLike> }) {
    super();
  }
  get id() {
    return this.entry.id;
  }
  get handle() {
    return this.entry.handle;
  }
  get type() {
    return this.entry.type;
  }
  get display_name() {
    return this.entry.display_name;
  }
  get system() {
    return { id: this.entry.id, handle: this.entry.handle, type: this.entry.type, display_name: this.entry.display_name };
  }
  /** Every field, in the type's order — for a block that shows an entry without knowing its fields. */
  get fields() {
    return Object.values(this.entry.fields).map((field) => new MetafieldDrop(field));
  }
  override liquidMethodMissing(key: string) {
    const field = this.entry.fields[key];
    return field ? new MetafieldDrop(field) : undefined;
  }
  override valueOf() {
    return this.entry.display_name;
  }
}

/** `{namespace: {key: MetafieldDrop}}` from a product's or variant's public custom fields. */
function customMetafields(fields: StorefrontFieldLike[] | undefined): Record<string, Record<string, MetafieldDrop>> {
  const out: Record<string, Record<string, MetafieldDrop>> = {};
  for (const field of fields ?? []) (out[field.namespace] ??= {})[field.key] = new MetafieldDrop(field);
  return out;
}

// ── products ────────────────────────────────────────────────────────────────

interface OptionGroup {
  name: string;
  values: { id: number; value: string; swatch_hex: string | null }[];
}

export class VariantDrop extends Drop {
  constructor(
    private readonly data: Any,
    private readonly product: { handle: string; title: string; image: ImageLike | null },
    private readonly optionValues: string[],
  ) {
    super();
  }
  get id() {
    return this.data.id;
  }
  get title() {
    return this.optionValues.length ? this.optionValues.join(' / ') : (this.data.title ?? 'Default Title');
  }
  get name() {
    return `${this.product.title}${this.optionValues.length ? ` - ${this.title}` : ''}`;
  }
  get price() {
    return cents(this.data.price) ?? 0;
  }
  get compare_at_price() {
    return cents(this.data.mrp);
  }
  get available() {
    return this.data.in_stock !== false;
  }
  get sku() {
    return this.data.sku ?? null;
  }
  get barcode() {
    return this.data.barcode ?? null;
  }  /** The variant's public custom fields: `variant.metafields.custom.fit`. */
  get metafields() {
    return customMetafields(this.data.custom_fields);
  }

  get options() {
    return this.optionValues.length ? this.optionValues : ['Default Title'];
  }
  get option1() {
    return this.options[0] ?? null;
  }
  get option2() {
    return this.optionValues[1] ?? null;
  }
  get option3() {
    return this.optionValues[2] ?? null;
  }
  get featured_image() {
    return this.product.image;
  }
  get featured_media() {
    return this.product.image;
  }
  get image() {
    return this.product.image;
  }
  get url() {
    return `/products/${this.product.handle}?variant=${this.data.id}`;
  }
  get requires_shipping() {
    return true;
  }
  get taxable() {
    return true;
  }
  get inventory_management() {
    return 'veylog';
  }
  get inventory_policy() {
    return 'deny';
  }
  get weight() {
    return this.data.weight_grams ?? 0;
  }
  get unit_price() {
    return null;
  }
  get selected() {
    return false;
  }
  get size_description() {
    return this.data.size_description ?? null;
  }
  /** `{{ variant | json }}` — what theme JavaScript reads to switch variants. */
  toJSON() {
    return {
      id: this.id,
      title: this.title,
      name: this.name,
      options: this.options,
      option1: this.option1,
      option2: this.option2,
      option3: this.option3,
      price: this.price,
      compare_at_price: this.compare_at_price,
      available: this.available,
      sku: this.sku,
      featured_image: this.product.image ? { src: this.product.image.src, alt: this.product.image.alt } : null,
    };
  }
}

export class ProductDrop extends Drop {
  private readonly variantDrops: VariantDrop[];
  private readonly optionGroups: OptionGroup[];
  private readonly imageList: ImageLike[];
  constructor(
    private readonly data: Any,
    private readonly selectedVariantId: number | null = null,
  ) {
    super();
    willTranslate('product', data.id);
    const images: ImageLike[] = [];
    const seen = new Set<string>();
    for (const image of (data.images ?? []) as { url: string; alt?: string }[]) {
      if (!image?.url || seen.has(image.url)) continue;
      seen.add(image.url);
      images.push(imageDrop(image.url, image.alt ?? data.name, { id: images.length + 1 })!);
    }
    if (images.length === 0 && data.image) images.push(imageDrop(data.image, data.image_alt ?? data.name, { id: 1 })!);
    this.imageList = images;
    this.optionGroups = ((data.options ?? []) as Any[]).map((group) => ({
      name: group.name,
      values: (group.values ?? []).map((value: Any) => ({ id: Number(value.id), value: value.value, swatch_hex: value.swatch_hex ?? null })),
    }));
    const valueName = new Map<number, string>();
    for (const group of this.optionGroups) for (const value of group.values) valueName.set(value.id, value.value);
    const product = { handle: data.slug, title: data.name, image: images[0] ?? null };
    this.variantDrops = ((data.variants ?? []) as Any[]).map((variant) => {
      const optionValues = ((variant.option_value_ids ?? []) as number[]).map((id) => valueName.get(Number(id))).filter((value): value is string => Boolean(value));
      // Without option groups, a variant's own title is its one option (e.g. "30 ml").
      const values = optionValues.length ? optionValues : (data.variants?.length > 1 && variant.title ? [String(variant.title)] : []);
      return new VariantDrop(variant, product, values);
    });
  }

  get id() {
    return this.data.id;
  }
  get handle() {
    return this.data.slug;
  }
  get title() {
    return tr('product', this.data.id, 'title', this.data.name);
  }
  get subtitle() {
    return this.data.subtitle ?? null;
  }
  get url() {
    return `/products/${this.data.slug}`;
  }
  get description() {
    return tr('product', this.data.id, 'body_html', this.data.description ?? this.data.short_description ?? '');
  }
  get content() {
    return this.description;
  }
  get excerpt() {
    return tr('product', this.data.id, 'excerpt', this.data.short_description ?? '');
  }
  get type() {
    return this.data.category?.name ?? '';
  }
  get vendor() {
    return this.data.brand?.name ?? this.data.vendor ?? '';
  }
  get tags() {
    const tags: string[] = [];
    if (this.data.is_new) tags.push('new');
    if (this.data.is_bestseller) tags.push('bestseller');
    if (this.data.tag?.label) tags.push(this.data.tag.label);
    return tags;
  }
  get template_suffix() {
    return this.data.template_suffix ?? null;
  }
  get price() {
    const prices = this.variantDrops.map((variant) => variant.price);
    return prices.length ? Math.min(...prices) : (cents(this.data.price) ?? 0);
  }
  get price_min() {
    return this.price;
  }
  get price_max() {
    const prices = this.variantDrops.map((variant) => variant.price);
    return prices.length ? Math.max(...prices) : this.price;
  }
  get price_varies() {
    return this.price_min !== this.price_max;
  }
  get compare_at_price() {
    const first = this.selected_or_first_available_variant;
    return first ? first.compare_at_price : cents(this.data.mrp);
  }
  get compare_at_price_min() {
    return this.compare_at_price;
  }
  get compare_at_price_max() {
    const values = this.variantDrops.map((variant) => variant.compare_at_price ?? 0);
    return values.length ? Math.max(...values) : (this.compare_at_price ?? 0);
  }
  get compare_at_price_varies() {
    return false;
  }
  get available() {
    return this.variantDrops.length ? this.variantDrops.some((variant) => variant.available) : this.data.in_stock !== false;
  }
  get featured_image() {
    return this.imageList[0] ?? null;
  }
  get featured_media() {
    return this.imageList[0] ?? null;
  }
  get images() {
    return this.imageList;
  }
  get media() {
    return this.imageList;
  }
  get variants() {
    return this.variantDrops;
  }
  get variants_count() {
    return this.variantDrops.length;
  }
  get has_only_default_variant() {
    return this.variantDrops.length <= 1 && this.optionGroups.length === 0;
  }
  get options() {
    if (this.optionGroups.length) return this.optionGroups.map((group) => group.name);
    return this.variantDrops.length > 1 ? ['Option'] : ['Title'];
  }
  get options_with_values() {
    const selected = this.selected_or_first_available_variant;
    if (this.optionGroups.length) {
      return this.optionGroups.map((group, index) => ({
        name: group.name,
        position: index + 1,
        values: group.values.map((value) => value.value),
        selected_value: selected?.options[index] ?? group.values[0]?.value ?? null,
        swatches: group.values.map((value) => value.swatch_hex),
      }));
    }
    if (this.variantDrops.length > 1) {
      return [{ name: 'Option', position: 1, values: this.variantDrops.map((variant) => variant.title), selected_value: selected?.title ?? null, swatches: [] }];
    }
    return [];
  }
  get selected_variant() {
    return this.selectedVariantId ? (this.variantDrops.find((variant) => variant.id === this.selectedVariantId) ?? null) : null;
  }
  get first_available_variant() {
    return this.variantDrops.find((variant) => variant.available) ?? this.variantDrops[0] ?? null;
  }
  get selected_or_first_available_variant() {
    return this.selected_variant ?? this.first_available_variant;
  }
  get requires_selling_plan() {
    return false;
  }
  get gift_card() {
    return false;
  }
  get published_at() {
    return this.data.published_at ?? null;
  }
  get created_at() {
    return this.data.created_at ?? null;
  }
  /**
   * Ratings, the store's own product details, and the merchant's custom fields
   * (`product.metafields.custom.material`), the way apps and themes read them on Shopify.
   */
  get metafields() {
    const d = this.data;
    const custom = customMetafields(d.custom_fields);
    const builtIn: Record<string, Any> = {
      details: {
        benefits: d.benefits ?? [],
        key_ingredients: d.key_ingredients ?? [],
        how_to_use: d.usage_instructions ?? null,
        ingredients: d.full_inci ?? null,
        country_of_origin: d.country_of_origin ?? null,
        certifications: d.certifications ?? [],
        claims: d.claims ?? [],
      },
      seo: d.seo ?? null,
    };
    for (const [namespace, fields] of Object.entries(custom)) builtIn[namespace] = { ...(builtIn[namespace] ?? {}), ...fields };
    return builtIn;
  }
  /** The public custom fields in the admin's order — for a block that lists them all. */
  get custom_fields() {
    return ((this.data.custom_fields ?? []) as StorefrontFieldLike[]).map((field) => new MetafieldDrop(field));
  }
  get rating() {
    return Number(this.data.rating ?? 0);
  }
  get review_count() {
    return Number(this.data.review_count ?? 0);
  }
  get on_sale() {
    const compare = this.compare_at_price;
    return compare !== null && compare > this.price;
  }
  /** Hand-picked and same-category products (the product page already loaded them). */
  get related() {
    return ((this.data.related ?? []) as Any[]).map((card) => new ProductDrop(card));
  }
  get seo() {
    return this.data.seo ?? { title: this.data.name, description: this.data.short_description ?? null };
  }
  /** `{{ product | json }}`, the shape of Shopify's /products/<handle>.js. */
  toJSON() {
    return {
      id: this.id,
      handle: this.handle,
      title: this.title,
      url: this.url,
      vendor: this.vendor,
      type: this.type,
      available: this.available,
      price: this.price,
      price_min: this.price_min,
      price_max: this.price_max,
      compare_at_price: this.compare_at_price,
      options: this.options,
      options_with_values: this.options_with_values,
      images: this.imageList.map((image) => image.src),
      featured_image: this.imageList[0]?.src ?? null,
      variants: this.variantDrops.map((variant) => variant.toJSON()),
    };
  }
}

/** A product fetched only when a template actually asks for it. */
export async function loadProduct(handle: string, variantId: number | null = null): Promise<ProductDrop | null> {
  try {
    const { product } = await storefrontService.getProduct(handle);
    return new ProductDrop(product, variantId);
  } catch {
    return null;
  }
}

export class AllProductsDrop extends Drop {
  private readonly cache = new Map<string, Promise<ProductDrop | null>>();
  override liquidMethodMissing(handle: string) {
    if (!this.cache.has(handle)) this.cache.set(handle, loadProduct(handle));
    return this.cache.get(handle);
  }
}

// ── collections ─────────────────────────────────────────────────────────────

export const SORT_OPTIONS = [
  { value: 'manual', name: 'Featured', api: 'featured' },
  { value: 'best-selling', name: 'Best selling', api: 'best_selling' },
  { value: 'title-ascending', name: 'Alphabetically, A-Z', api: 'name' },
  { value: 'title-descending', name: 'Alphabetically, Z-A', api: 'name_desc' },
  { value: 'price-ascending', name: 'Price, low to high', api: 'price_asc' },
  { value: 'price-descending', name: 'Price, high to low', api: 'price_desc' },
  { value: 'created-ascending', name: 'Date, old to new', api: 'oldest' },
  { value: 'created-descending', name: 'Date, new to old', api: 'newest' },
];

function apiSort(sortBy: string | null): string | undefined {
  return SORT_OPTIONS.find((option) => option.value === sortBy)?.api;
}

/** A collection row, or a synthetic one such as `all`. */
export type CollectionSource = Pick<CollectionRow, 'handle' | 'title'> &
  Partial<Pick<CollectionRow, 'id' | 'kind' | 'description' | 'image_key' | 'product_count' | 'template_suffix'>>;

export class CollectionDrop extends Drop {
  private firstPage: Promise<{ items: ProductDrop[]; total: number }> | null = null;
  constructor(
    private readonly row: CollectionSource,
    private readonly sortBy: string | null = null,
    private readonly filterQuery: Record<string, unknown> = {},
  ) {
    super();
    willTranslate('collection', row.id);
  }
  get id() {
    return this.row.id ?? 0;
  }
  get handle() {
    return this.row.handle;
  }
  get title() {
    return tr('collection', this.row.id, 'title', this.row.title);
  }
  get description() {
    return tr('collection', this.row.id, 'description', this.row.description ?? '');
  }
  get url() {
    return `/collections/${this.row.handle}`;
  }
  get image() {
    return imageDrop(mediaUrl(this.row.image_key ?? null), this.row.title);
  }
  get featured_image() {
    return this.image;
  }
  get products_count() {
    // `collections.all` has no row to carry a count: ask the catalogue.
    if (this.row.product_count === undefined && this.row.handle === 'all') return this.load(1, 1).then((result) => result.total);
    return Number(this.row.product_count ?? 0);
  }
  get all_products_count() {
    return this.products_count;
  }
  get template_suffix() {
    return this.row.template_suffix ?? null;
  }
  get sort_by() {
    return this.sortBy ?? this.default_sort_by;
  }
  get default_sort_by() {
    return 'manual';
  }
  get sort_options() {
    return SORT_OPTIONS.map(({ value, name }) => ({ value, name }));
  }
  get filters() {
    return [];
  }
  get all_types() {
    return [];
  }
  get all_vendors() {
    return [];
  }
  private query(pageSize: number, page: number): Record<string, unknown> {
    const scope: Record<string, unknown> =
      this.row.handle === 'all' ? {} : this.row.kind === 'category' ? { category: this.row.handle } : { collection: this.row.handle };
    return { ...scope, ...this.filterQuery, sort: apiSort(this.sortBy), page, limit: pageSize };
  }
  private async load(pageSize: number, page: number) {
    const result = await storefrontService.listProducts(this.query(pageSize, page));
    return { items: (result.products as Any[]).map((card) => new ProductDrop(card)), total: Number(result.pagination.total ?? result.products.length) };
  }
  /** For {% paginate collection.products by N %}. */
  async paginateProperty(property: string, pageSize: number, page: number) {
    if (property !== 'products') return { items: [], total: 0 };
    return this.load(pageSize, page);
  }
  /** Without pagination, the first 50 — Shopify's limit too. */
  get products() {
    this.firstPage ??= this.load(50, 1);
    return this.firstPage.then((result) => result.items);
  }
}

export async function loadCollection(handle: string, sortBy: string | null = null, filters: Record<string, unknown> = {}): Promise<CollectionDrop | null> {
  const row = await onlineStoreRepository.collectionByHandle(handle);
  if (row) return new CollectionDrop(row, sortBy, filters);
  // /collections/all: every product, unless the store made its own "all" collection.
  return handle === 'all' ? new CollectionDrop({ handle: 'all', title: 'Products', kind: 'collection' }, sortBy, filters) : null;
}

/**
 * `collections`: iterable (every collection), and addressable by handle —
 * `collections['summer']`, `collections.all`. An array with named members
 * gives both without an async iterator.
 */
export async function collectionsDrop(): Promise<CollectionDrop[] & Record<string, CollectionDrop>> {
  const rows = await onlineStoreRepository.allCollections();
  const list = rows.map((row) => new CollectionDrop(row)) as CollectionDrop[] & Record<string, CollectionDrop>;
  for (const drop of list) if (!(drop.handle in list)) Object.defineProperty(list, drop.handle, { value: drop, enumerable: false });
  // A store's own collection with the handle "all" wins, as on Shopify.
  if (!('all' in list)) Object.defineProperty(list, 'all', { value: new CollectionDrop({ handle: 'all', title: 'Products', kind: 'collection' }), enumerable: false });
  return list;
}

// ── navigation ──────────────────────────────────────────────────────────────

export interface LinkLike {
  title: string;
  url: string;
  type: string;
  active: boolean;
  current: boolean;
  child_active: boolean;
  child_current: boolean;
  levels: number;
  links: LinkLike[];
  handle: string;
  image: ImageLike | null;
}

function linkUrl(row: MenuLinkRow): string {
  switch (row.link_type) {
    case 'url':
      return row.url ?? '#';
    case 'product':
      return row.ref_handle ? `/products/${row.ref_handle}` : '#';
    case 'collection':
    case 'category':
      return row.ref_handle ? `/collections/${row.ref_handle}` : '#';
    case 'page':
      return row.ref_handle ? `/pages/${row.ref_handle}` : '#';
    case 'blog':
      return row.ref_handle ? `/blogs/${row.ref_handle}` : '#';
    case 'article':
      return row.ref_handle ? `/blogs/journal/${row.ref_handle}` : '#';
    default:
      return row.url ?? '#';
  }
}

function link(title: string, url: string, currentPath: string, type = 'http_link', children: LinkLike[] = [], image: ImageLike | null = null): LinkLike {
  const path = url.split('?')[0];
  const current = path === currentPath;
  const active = current || (path !== '/' && currentPath.startsWith(`${path}/`));
  const childActive = children.some((child) => child.active || child.child_active);
  return {
    title,
    url,
    type,
    active,
    current,
    child_active: childActive,
    child_current: children.some((child) => child.current || child.child_current),
    levels: children.length ? 1 + Math.max(...children.map((child) => child.levels)) : 0,
    links: children,
    handle: handleize(title),
    image,
  };
}

/** Shopify's handles for the default menus, onto this platform's. */
const MENU_ALIASES: Record<string, string> = { 'main-menu': 'main', footer: 'footer_shop' };

export class LinklistsDrop extends Drop {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(private readonly currentPath: string) {
    super();
  }
  override liquidMethodMissing(handle: string) {
    if (!this.cache.has(handle)) this.cache.set(handle, this.load(handle));
    return this.cache.get(handle);
  }
  private async load(handle: string) {
    const slug = MENU_ALIASES[handle] ?? handle;
    const menu = await onlineStoreRepository.menuBySlug(slug);
    const rows = menu ? await onlineStoreRepository.menuLinks(menu.id) : [];
    let links: LinkLike[];
    if (rows.length) {
      const children = new Map<number, MenuLinkRow[]>();
      for (const row of rows) if (row.parent_id) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row]);
      // Translated labels first, all in one query, so the links stay plain strings.
      for (const row of rows) willTranslate('link', row.id);
      const labels = new Map(await Promise.all(rows.map(async (row) => [row.id, await tr('link', row.id, 'title', row.label)] as const)));
      const build = (row: MenuLinkRow): LinkLike => {
        const built = link(labels.get(row.id) ?? row.label, linkUrl(row), this.currentPath, row.link_type, (children.get(row.id) ?? []).map(build), imageDrop(mediaUrl(row.image_key), row.label));
        return { ...built, handle: handleize(row.label) };
      };
      links = rows.filter((row) => !row.parent_id).map(build);
    } else {
      links = await this.fallback(slug);
    }
    return { handle, title: menu?.name ?? handle, levels: links.length ? 1 + Math.max(0, ...links.map((l) => l.levels)) : 0, links };
  }
  /**
   * A new store has empty menus; the storefront still needs a way around.
   * The main menu defaults to the home page, the catalogue, the top
   * collections and contact — what a new Shopify store starts with.
   */
  private async fallback(slug: string): Promise<LinkLike[]> {
    if (slug === 'main' || slug === 'mobile_drawer') {
      // What the merchant marked "show in menu" first, then anything with products in it.
      const collections = (await onlineStoreRepository.allCollections())
        .filter((row) => row.handle !== 'all' && Number(row.product_count) > 0)
        .sort((a, b) => Number(b.show_in_menu) - Number(a.show_in_menu))
        .slice(0, 4);
      return [
        link('Home', '/', this.currentPath, 'frontpage'),
        link('Catalog', '/collections/all', this.currentPath, 'collection'),
        ...collections.map((row) => link(row.title, `/collections/${row.handle}`, this.currentPath, 'collection')),
        link('Contact', '/pages/contact', this.currentPath, 'page'),
      ];
    }
    if (slug === 'footer_shop') {
      return [link('Search', '/search', this.currentPath, 'search'), link('All products', '/collections/all', this.currentPath, 'collection')];
    }
    if (slug === 'footer_support' || slug === 'footer_legal') {
      const pages = await onlineStoreRepository.publishedPages();
      return pages.slice(0, 6).map((page) => link(page.title, `/pages/${page.slug}`, this.currentPath, 'page'));
    }
    return [];
  }
}

// ── content ─────────────────────────────────────────────────────────────────

export function pageDrop(page: Any) {
  willTranslate('page', page.slug);
  return {
    id: page.id ?? null,
    title: tr('page', page.slug, 'title', page.title),
    handle: page.slug,
    url: `/pages/${page.slug}`,
    content: tr('page', page.slug, 'body_html', page.body_html ?? page.content ?? ''),
    author: null,
    image: imageDrop(page.hero ?? null, page.hero_alt ?? page.title),
    seo: page.seo ?? null,
    published_at: page.published_at ?? null,
    template_suffix: page.template ?? null,
    summary_html: page.subtitle ?? '',
  };
}

export async function loadPage(handle: string) {
  try {
    const result = (await contentPublicService.page(handle)) as Any;
    const page = result.page ?? result;
    return page ? pageDrop(page) : null;
  } catch {
    return null;
  }
}

export class PagesDrop extends Drop {
  override liquidMethodMissing(handle: string) {
    return loadPage(handle);
  }
}

export function articleDrop(article: Any, blogHandle: string) {
  willTranslate('article', article.slug);
  return {
    id: article.id ?? null,
    title: tr('article', article.slug, 'title', article.title),
    handle: article.slug,
    url: `/blogs/${blogHandle}/${article.slug}`,
    content: tr('article', article.slug, 'body_html', article.body_html ?? article.content ?? ''),
    excerpt: tr('article', article.slug, 'excerpt', article.excerpt ?? ''),
    excerpt_or_content: article.excerpt || article.body_html || '',
    image: imageDrop(article.cover ?? article.image ?? null, article.cover_alt ?? article.title),
    author: typeof article.author === 'object' ? (article.author?.name ?? '') : (article.author ?? ''),
    published_at: article.published_at ?? null,
    created_at: article.published_at ?? null,
    tags: article.tags ?? [],
    comments_count: 0,
    comments_enabled: false,
  };
}

export class BlogDrop extends Drop {
  constructor(private readonly blog: { handle: string; title: string; description?: string | null; commentsPolicy?: 'disabled' | 'moderated' | 'published' }) {
    super();
  }
  /** Shopify's `blog.comments_enabled?` and `blog.moderated?`. */
  override liquidMethodMissing(key: string) {
    if (key === 'comments_enabled?') return this.comments_enabled;
    if (key === 'moderated?') return this.moderated;
    return undefined;
  }
  get moderated() {
    return this.blog.commentsPolicy === 'moderated';
  }
  get handle() {
    return this.blog.handle;
  }
  get title() {
    return this.blog.title;
  }
  get url() {
    return `/blogs/${this.blog.handle}`;
  }
  get description() {
    return this.blog.description ?? '';
  }
  get all_tags() {
    return [];
  }
  get comments_enabled() {
    return (this.blog.commentsPolicy ?? 'disabled') !== 'disabled';
  }
  private async load(pageSize: number, page: number) {
    const query: Record<string, unknown> = { page, limit: pageSize };
    if (this.blog.handle !== 'journal') query.blog = this.blog.handle;
    const result = (await contentPublicService.journal.list(query)) as Any;
    const items = ((result.articles ?? result.items ?? []) as Any[]).map((article) => articleDrop(article, this.blog.handle));
    return { items, total: Number(result.pagination?.total ?? items.length) };
  }
  async paginateProperty(property: string, pageSize: number, page: number) {
    return property === 'articles' ? this.load(pageSize, page) : { items: [], total: 0 };
  }
  get articles() {
    return this.load(20, 1).then((result) => result.items);
  }
  get articles_count() {
    return this.load(1, 1).then((result) => result.total);
  }
}

export class BlogsDrop extends Drop {
  override liquidMethodMissing(handle: string) {
    return onlineStoreRepository.blogs().then((blogs) => {
      const blog = blogs.find((entry) => entry.slug === handle);
      if (blog) return new BlogDrop({ handle: blog.slug, title: blog.title, description: blog.description, commentsPolicy: blog.comments_policy });
      return handle === 'journal' || handle === 'news' ? new BlogDrop({ handle, title: 'Journal' }) : null;
    });
  }
}

// ── cart ────────────────────────────────────────────────────────────────────

/** The cart as Shopify themes (and /cart.js) expect it, from the Storefront API's cart. */
export function cartDrop(cart: Any | null) {
  const items = ((cart?.items ?? []) as Any[]).map((line) => {
    const image = imageDrop(line.image, line.name);
    const price = cents(line.unit_price) ?? 0;
    const linePrice = cents(line.line_total) ?? 0;
    const finalLine = cents(line.line_total_after_discount ?? line.line_total) ?? 0;
    return {
      id: line.variant_id,
      key: String(line.id),
      variant_id: line.variant_id,
      product_id: line.product_id,
      quantity: line.quantity,
      title: line.variant_title ? `${line.name} - ${line.variant_title}` : line.name,
      product_title: line.name,
      variant_title: line.variant_title ?? null,
      sku: line.sku,
      url: `/products/${line.slug}?variant=${line.variant_id}`,
      image,
      featured_image: image,
      price,
      original_price: price,
      final_price: line.quantity ? Math.round(finalLine / line.quantity) : price,
      line_price: linePrice,
      original_line_price: cents(line.line_mrp) ?? linePrice,
      final_line_price: finalLine,
      line_level_total_discount: Math.max(0, linePrice - finalLine),
      compare_at_price: cents(line.unit_mrp),
      available: line.in_stock,
      requires_shipping: true,
      options_with_values: line.variant_title ? [{ name: 'Option', value: line.variant_title }] : [],
      product: { title: line.name, handle: line.slug, url: `/products/${line.slug}`, has_only_default_variant: !line.variant_title },
      variant: { id: line.variant_id, title: line.variant_title ?? 'Default Title', available: line.in_stock },
      discounts: [],
      properties: {},
    };
  });
  const totals = cart?.totals ?? {};
  const discounts = ((cart?.discounts ?? []) as Any[]).map((discount) => ({
    title: discount.code ?? discount.title,
    total_allocated_amount: cents(discount.amount) ?? 0,
    type: discount.type,
    value_type: 'fixed_amount',
  }));
  return {
    token: cart?.token ?? null,
    item_count: Number(cart?.item_count ?? 0),
    items,
    items_subtotal_price: cents(totals.subtotal) ?? 0,
    original_total_price: cents(totals.mrp_total ?? totals.subtotal) ?? 0,
    total_price: cents(totals.total) ?? 0,
    total_discount: cents(totals.discount) ?? 0,
    total_weight: 0,
    cart_level_discount_applications: discounts,
    discount_applications: discounts,
    currency: { iso_code: totals.currency ?? cart?.market?.currency ?? null },
    requires_shipping: items.length > 0,
    note: null,
    attributes: {},
    empty: items.length === 0,
    free_gift: cart?.free_gift ?? null,
    discount_code: cart?.discount_code ?? null,
    tax_included_in_prices: totals.tax_included_in_prices ?? true,
    checkout_charge_amount: cents(totals.total) ?? 0,
    // Progress to free delivery, for the cart's "spend X more" bar.
    free_shipping_threshold: cents(totals.free_shipping_threshold) ?? 0,
    amount_to_free_shipping: cents(totals.amount_to_free_shipping) ?? 0,
  };
}
