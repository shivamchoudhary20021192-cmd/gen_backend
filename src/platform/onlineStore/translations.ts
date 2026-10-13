import { AsyncLocalStorage } from 'node:async_hooks';
import { query, type RowDataPacket } from '../../db/pool';
import { shopId } from '../tenancy/context';

/**
 * Translated content on the storefront.
 *
 * A request in a language other than the store's primary one runs inside
 * `translationContext`. The Liquid objects then ask `tr()` for each field
 * they show; with no context, or in the primary language, it returns the
 * original synchronously and costs nothing.
 *
 * Loading is batched. Every product, collection or link object registers its
 * id when it is created (a collection's 24 products are created together), and
 * the first field any of them is asked for loads the translations for all
 * registered ids of that kind in one query. After that, fields are answered
 * synchronously from memory. Pages and articles reach the storefront by handle,
 * so they are looked up by handle.
 */

export type TranslatableType = 'product' | 'collection' | 'page' | 'article' | 'link';

const HANDLE_TABLES: Partial<Record<TranslatableType, string>> = { page: 'cms_pages', article: 'cms_articles' };

interface FieldRow extends RowDataPacket {
  resource_id: number;
  handle?: string;
  field: string;
  value: string;
}

class TranslationLoader {
  private readonly loaded = new Map<string, Record<string, string>>();
  private readonly pending = new Map<TranslatableType, Set<string>>();
  private readonly inflight = new Map<string, Promise<void>>();
  private theme: Promise<Map<string, string>> | null = null;

  constructor(readonly locale: string) {}

  private key(type: TranslatableType, ref: string | number) {
    return `${type}:${ref}`;
  }

  register(type: TranslatableType, ref: string | number | null | undefined): void {
    if (ref === null || ref === undefined || ref === '') return;
    if (this.loaded.has(this.key(type, ref))) return;
    let set = this.pending.get(type);
    if (!set) this.pending.set(type, (set = new Set()));
    set.add(String(ref));
  }

  peek(type: TranslatableType, ref: string | number): Record<string, string> | undefined {
    return this.loaded.get(this.key(type, ref));
  }

  async load(type: TranslatableType, ref: string | number): Promise<Record<string, string>> {
    const key = this.key(type, ref);
    if (this.loaded.has(key)) return this.loaded.get(key)!;
    this.register(type, ref);
    const running = this.inflight.get(key);
    if (running) {
      await running;
      return this.loaded.get(key) ?? {};
    }
    const refs = [...(this.pending.get(type) ?? [])].slice(0, 500);
    this.pending.get(type)?.clear();
    const flight = this.fetch(type, refs);
    for (const each of refs) this.inflight.set(this.key(type, each), flight);
    try {
      await flight;
    } finally {
      for (const each of refs) this.inflight.delete(this.key(type, each));
    }
    return this.loaded.get(key) ?? {};
  }

  private async fetch(type: TranslatableType, refs: string[]): Promise<void> {
    for (const ref of refs) this.loaded.set(this.key(type, ref), {});
    if (refs.length === 0) return;
    const table = HANDLE_TABLES[type];
    const rows = table
      ? await query<FieldRow>(
          `SELECT t.resource_id, r.slug AS handle, t.field, t.value
             FROM translations t
             JOIN ${table} r ON r.id = t.resource_id AND r.shop_id = t.shop_id
            WHERE t.shop_id = ? AND t.locale = ? AND t.resource_type = ? AND r.slug IN (?)`,
          [shopId(), this.locale, type, refs],
        )
      : await query<FieldRow>(
          `SELECT resource_id, field, value FROM translations
            WHERE shop_id = ? AND locale = ? AND resource_type = ? AND resource_id IN (?)`,
          [shopId(), this.locale, type, refs.map(Number).filter(Number.isFinite)],
        );
    for (const row of rows) {
      const ref = table ? row.handle! : String(row.resource_id);
      const entry = this.loaded.get(this.key(type, ref)) ?? {};
      if (row.value !== '') entry[row.field] = row.value;
      this.loaded.set(this.key(type, ref), entry);
    }
  }

  /** The live theme's translated text settings, keyed "file::section::setting" (or "file::section::block::setting"). */
  themeContent(themeId: number): Promise<Map<string, string>> {
    this.theme ??= query<FieldRow>(
      `SELECT field, value FROM translations WHERE shop_id = ? AND locale = ? AND resource_type = 'theme' AND resource_id = ?`,
      [shopId(), this.locale, themeId],
    ).then((rows) => new Map(rows.filter((row) => row.value !== '').map((row) => [row.field, row.value])));
    return this.theme;
  }
}

interface TranslationState {
  locale: string;
  loader: TranslationLoader;
}

const storage = new AsyncLocalStorage<TranslationState>();

export const translationContext = {
  /** Runs `fn` in a non-primary language; everything it renders is translated. */
  run<T>(locale: string, fn: () => T): T {
    return storage.run({ locale, loader: new TranslationLoader(locale) }, fn);
  },
  current(): TranslationState | undefined {
    return storage.getStore();
  },
};

/** Registers a resource that will be shown, so its translations load with the others'. */
export function willTranslate(type: TranslatableType, ref: string | number | null | undefined): void {
  storage.getStore()?.loader.register(type, ref);
}

/**
 * A field in the shopper's language: the translation if there is one,
 * otherwise the original. Synchronous whenever it can be; a promise (which
 * Liquid awaits) the first time a batch has to be loaded.
 */
export function tr<T>(type: TranslatableType, ref: string | number | null | undefined, field: string, original: T): T | Promise<T> {
  const state = storage.getStore();
  if (!state || ref === null || ref === undefined || ref === '') return original;
  const loaded = state.loader.peek(type, ref);
  if (loaded) return (loaded[field] as T | undefined) ?? original;
  return state.loader.load(type, ref).then((entry) => (entry[field] as T | undefined) ?? original);
}

/** Awaits a value that may be a translation still loading (for code, not templates, that needs the string). */
export async function resolved<T>(value: T | Promise<T>): Promise<T> {
  return value;
}
