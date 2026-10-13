/* eslint-disable @typescript-eslint/no-explicit-any */
import type { SettingDefinition, SettingValue } from '../themes/themeSchema';
import { settingDefaults } from '../themes/themeSchema';
import { BlogDrop, imageDrop, loadCollection, loadPage, loadProduct, type LinklistsDrop } from './drops';
import { mediaUrl, onlineStoreRepository } from './onlineStore.repository';

/**
 * Turns saved setting values into what Liquid code expects of each setting
 * type, as Shopify does: an `image_picker` is an image object (not an id), a
 * `collection` is the collection, a `link_list` is the menu, a
 * `font_picker` is a font object.
 *
 * Anything that needs a query is a lazy thenable: it is only fetched if the
 * template reads it, and fetched once per request however often it is read.
 */

type Any = any;

/** A value Liquid awaits when read, fetched on first read. */
export function lazy<T>(load: () => Promise<T>): PromiseLike<T> {
  let promise: Promise<T> | null = null;
  return {
    then(onFulfilled, onRejected) {
      promise ??= load();
      return promise.then(onFulfilled, onRejected);
    },
  };
}

/** Per request: batches image lookups and remembers resolved objects. */
export class SettingsScope {
  private readonly pendingMedia = new Map<number, ((row: Any) => void)[]>();
  private readonly mediaCache = new Map<number, Promise<Any>>();
  private flushScheduled = false;

  constructor(readonly linklists: LinklistsDrop) {}

  image(value: unknown): PromiseLike<unknown> | unknown {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value)) {
      // A URL chosen before the media library existed, or an asset path.
      return imageDrop(value, '');
    }
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) return null;
    let cached = this.mediaCache.get(id);
    if (!cached) {
      cached = new Promise((resolve) => {
        this.pendingMedia.set(id, [...(this.pendingMedia.get(id) ?? []), resolve]);
        this.scheduleFlush();
      });
      this.mediaCache.set(id, cached);
    }
    return lazy(() => cached!);
  }

  /** One query for every image a render asks for in the same tick. */
  private scheduleFlush() {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    queueMicrotask(async () => {
      this.flushScheduled = false;
      const ids = [...this.pendingMedia.keys()];
      const waiting = new Map(this.pendingMedia);
      this.pendingMedia.clear();
      let rows: Awaited<ReturnType<typeof onlineStoreRepository.media>> = [];
      try {
        rows = await onlineStoreRepository.media(ids);
      } catch {
        rows = [];
      }
      const byId = new Map(rows.map((row) => [Number(row.id), row]));
      for (const [id, resolvers] of waiting) {
        const row = byId.get(id);
        const image = row ? imageDrop(mediaUrl(row.storage_key), row.alt_text ?? '', { width: row.width, height: row.height, id: row.id }) : null;
        for (const resolve of resolvers) resolve(image);
      }
    });
  }
}

export function fontDrop(value: unknown) {
  const family = typeof value === 'string' && value ? value.replace(/_[nib]\d$/, '').replace(/_/g, ' ') : 'Inter';
  const serif = /serif|garamond|baskerville|playfair|lora|fraunces|display/i.test(family) && !/sans/i.test(family);
  return {
    family,
    fallback_families: serif ? 'serif' : 'sans-serif',
    weight: 400,
    style: 'normal',
    system: false,
    variants: [],
    baseline_ratio: 0.2,
    toString() {
      return family;
    },
  };
}

function videoUrl(value: unknown) {
  if (typeof value !== 'string' || !value) return null;
  const youtube = /(?:youtube\.com\/(?:watch\?v=|embed\/|shorts\/)|youtu\.be\/)([\w-]{6,})/.exec(value);
  if (youtube) return { type: 'youtube', id: youtube[1], url: value, toString: () => value };
  const vimeo = /vimeo\.com\/(?:video\/)?(\d+)/.exec(value);
  if (vimeo) return { type: 'vimeo', id: vimeo[1], url: value, toString: () => value };
  return null;
}

/** One setting's value as Liquid sees it. */
export function typedValue(definition: SettingDefinition, value: SettingValue | undefined, scope: SettingsScope): unknown {
  switch (definition.type) {
    case 'image_picker':
      return scope.image(value);
    case 'font_picker':
      return fontDrop(value ?? definition.default);
    case 'collection':
      return typeof value === 'string' && value ? lazy(() => loadCollection(value)) : null;
    case 'collection_list':
      return Array.isArray(value) && value.length
        ? lazy(async () => (await Promise.all((value as string[]).map((handle) => loadCollection(handle)))).filter(Boolean))
        : [];
    case 'product':
      return typeof value === 'string' && value ? lazy(() => loadProduct(value)) : null;
    case 'product_list':
      return Array.isArray(value) && value.length
        ? lazy(async () => (await Promise.all((value as string[]).map((handle) => loadProduct(handle)))).filter(Boolean))
        : [];
    case 'link_list':
      return typeof value === 'string' && value ? scope.linklists.liquidMethodMissing(value) : null;
    case 'page':
      return typeof value === 'string' && value ? lazy(() => loadPage(value)) : null;
    case 'blog':
      return typeof value === 'string' && value ? new BlogDrop({ handle: value, title: value }) : null;
    case 'video_url':
      return videoUrl(value);
    case 'checkbox':
      return value === true || value === 'true' || value === 1;
    case 'range':
    case 'number':
      return value === null || value === undefined || value === '' ? null : Number(value);
    default:
      return value ?? null;
  }
}

/** A setting list's saved values, defaults filled in and typed. */
export function typedSettings(definitions: SettingDefinition[] | undefined, saved: Record<string, SettingValue> | undefined, scope: SettingsScope): Record<string, unknown> {
  const values = { ...settingDefaults(definitions), ...(saved ?? {}) };
  const out: Record<string, unknown> = {};
  const byId = new Map((definitions ?? []).filter((definition) => definition.id).map((definition) => [definition.id!, definition]));
  for (const [id, value] of Object.entries(values)) {
    const definition = byId.get(id);
    out[id] = definition ? typedValue(definition, value, scope) : value;
  }
  return out;
}

/** The global settings (config/settings_schema.json ⊕ settings_data.json). */
export function flattenSchema(schema: unknown): SettingDefinition[] {
  if (!Array.isArray(schema)) return [];
  return schema.flatMap((group: Any) => (Array.isArray(group?.settings) ? (group.settings as SettingDefinition[]) : []));
}

export interface SettingsDataFile {
  current: Record<string, SettingValue> | string;
  presets?: Record<string, Record<string, SettingValue>>;
}

/** settings_data.json's current values; `current` may name a preset, as on Shopify. */
export function currentSettings(data: SettingsDataFile | null): Record<string, SettingValue> {
  if (!data) return {};
  if (typeof data.current === 'string') return { ...(data.presets?.[data.current] ?? {}) };
  return data.current ?? {};
}
