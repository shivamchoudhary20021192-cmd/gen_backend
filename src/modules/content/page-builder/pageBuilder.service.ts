import { ApiError } from '../../../core/ApiError';
import { withTransaction } from '../../../db/transaction';
import { storage } from '../../media/storage';
import { cardsWithVariants } from '../../storefront/storefront.service';
import { storefrontRepository } from '../../storefront/storefront.repository';
import { shelvesService } from '../../merchandising/shelves.service';
import { contentPublicService } from '../public/contentPublic.service';
import {
  blockSchema,
  cleanSettings,
  isPageSectionKey,
  sectionCatalogue,
  sectionSchema,
  type Field,
} from './sectionSchema';
import {
  pageBuilderRepository,
  type PageBlockRow,
  type PageSectionRow,
} from './pageBuilder.repository';
import { ShopScopedCache } from '../../../platform/cache/shopCache';

/**
 * A built page: sections in order, with everything they point at resolved.
 *
 * The storefront gets one request per page and no ids. A section that names a
 * product gets the product's card; one that names a shelf gets the shelf's
 * products; one that names a picture gets a URL, an alt and the file's shape.
 * Doing that here rather than in the browser is what keeps a page from opening
 * with fourteen requests and a waterfall — and it is the only place that knows
 * how to turn a storage key into a URL.
 *
 * Resolution is done in **one pass over every section at once**: all the media
 * ids on the page are collected and fetched together, all the product ids
 * together, and so on. Resolving per section would be a query per section, and
 * a page builder's whole promise is that adding a fifteenth section is free.
 */

/** How long a resolved page is reused. Cleared on any write. */
const CACHE_TTL_MS = 60 * 1000;

/** Partitioned by shop: `page:home` means a different page in every shop. */
const cache = new ShopScopedCache(CACHE_TTL_MS);

function cached<T>(key: string, produce: () => Promise<T>): Promise<T> {
  return cache.get(key, produce);
}

function clearCache(): void {
  cache.clear();
}

function asSettings(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>;
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return {};
}

function mediaUrl(key: string | null | undefined): string | null {
  return key ? storage.publicUrl(key) : null;
}

/**
 * Where a link points, as a path the storefront can follow.
 *
 * The same vocabulary the banners, menus, announcement lines and shelves use.
 * Five places now speak it, which is the argument for it being a shared shape
 * rather than five slightly different ones.
 */
function href(link: unknown, slugs: { products: Map<number, string>; collections: Map<number, string> }): string | null {
  if (!link || typeof link !== 'object') return null;
  const { type, ref_id: refId, url } = link as { type?: string; ref_id?: number | null; url?: string | null };
  switch (type) {
    case 'url':
      return url ?? null;
    case 'product': {
      const slug = refId ? slugs.products.get(refId) : undefined;
      return slug ? `/product/${slug}` : refId ? `/shop?product=${refId}` : null;
    }
    case 'collection': {
      const slug = refId ? slugs.collections.get(refId) : undefined;
      return slug ? `/shop?collection=${slug}` : refId ? `/shop?collection_id=${refId}` : null;
    }
    case 'category':
      return refId ? `/shop?category_id=${refId}` : null;
    case 'article':
      return '/journal';
    case 'page':
    case 'policy':
      return url ?? null;
    default:
      return null;
  }
}

/** Every field of a section kind and of its block kinds, keyed for lookup. */
function fieldsOf(sectionKey: string): { settings: Field[]; blocks: Map<string, Field[]> } {
  const schema = sectionSchema(sectionKey);
  return {
    settings: schema?.settings ?? [],
    blocks: new Map((schema?.blocks ?? []).map((block) => [block.key, block.fields])),
  };
}

interface Gathered {
  media: Set<number>;
  products: Set<number>;
  collections: Set<number>;
  shelves: Set<number>;
}

function gatherFrom(fields: Field[], settings: Record<string, unknown>, into: Gathered): void {
  for (const field of fields) {
    const value = settings[field.key];
    if (value === null || value === undefined) continue;
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (field.kind === 'media') into.media.add(id);
    else if (field.kind === 'product') into.products.add(id);
    else if (field.kind === 'collection') into.collections.add(id);
    else if (field.kind === 'shelf') into.shelves.add(id);
  }
}

export const pageBuilderService = {
  /** The vocabulary this build knows. Drives the admin's whole editing form. */
  catalogue() {
    return { sections: sectionCatalogue() };
  },

  async templates() {
    const rows = await pageBuilderRepository.templates();
    return {
      templates: rows.map((row) => ({
        id: row.id,
        key: row.template_key,
        name: row.name,
        description: row.description,
        is_system: row.is_system === 1,
      })),
    };
  },

  /**
   * The page as the admin edits it: everything, in order, including sections
   * that are switched off or scheduled, with their raw settings.
   */
  async forAdmin(templateKey: string) {
    const template = await pageBuilderRepository.template(templateKey);
    if (!template) throw ApiError.notFound('Page template');

    const sections = await pageBuilderRepository.sections(template.id, false);
    const blocks = await pageBuilderRepository.blocks(
      sections.map((section) => section.section_id),
      false,
    );

    const bySection = new Map<number, PageBlockRow[]>();
    for (const block of blocks) {
      const list = bySection.get(block.section_id) ?? [];
      list.push(block);
      bySection.set(block.section_id, list);
    }

    return {
      template: { id: template.id, key: template.template_key, name: template.name },
      sections: sections.map((section) => ({
        id: section.section_id,
        key: section.section_key,
        label: sectionSchema(section.section_key)?.label ?? section.section_key,
        name: section.name,
        settings: asSettings(section.settings),
        is_enabled: section.is_enabled === 1,
        visible_from: section.visible_from,
        visible_until: section.visible_until,
        sort_order: section.sort_order,
        /** Why this section is not on the site, in plain words, or null. */
        hidden_because: hiddenBecause(section),
        blocks: (bySection.get(section.section_id) ?? []).map((block) => ({
          id: block.id,
          key: block.block_type,
          settings: {
            ...asSettings(block.settings),
            // The three fields that live in real columns rather than in the
            // JSON, so that media and products can be joined rather than
            // hunted for inside a blob.
            ...(block.media_id ? { media: block.media_id } : {}),
            ...(block.link_type === 'product' && block.link_ref_id ? { product: block.link_ref_id } : {}),
            ...(block.link_type === 'collection' && block.link_ref_id ? { collection: block.link_ref_id } : {}),
          },
          is_enabled: block.is_enabled === 1,
        })),
      })),
    };
  },

  /**
   * The page as a visitor sees it: live sections only, everything resolved.
   */
  async forStorefront(templateKey: string) {
    const kept = await cached(`page:${templateKey}`, async () => {
      const template = await pageBuilderRepository.template(templateKey);
      if (!template || template.is_active !== 1) return [];

      const sections = await pageBuilderRepository.sections(template.id, true);
      if (sections.length === 0) return [];

      const blocks = await pageBuilderRepository.blocks(
        sections.map((section) => section.section_id),
        true,
      );

      // ── one pass to find everything the page points at ──────────────────────
      const gathered: Gathered = { media: new Set(), products: new Set(), collections: new Set(), shelves: new Set() };
      const blocksBySection = new Map<number, PageBlockRow[]>();

      for (const section of sections) {
        const fields = fieldsOf(section.section_key);
        gatherFrom(fields.settings, asSettings(section.settings), gathered);
      }
      for (const block of blocks) {
        const list = blocksBySection.get(block.section_id) ?? [];
        list.push(block);
        blocksBySection.set(block.section_id, list);
        if (block.media_id) gathered.media.add(block.media_id);
        if (block.link_type === 'product' && block.link_ref_id) gathered.products.add(block.link_ref_id);
        if (block.link_type === 'collection' && block.link_ref_id) gathered.collections.add(block.link_ref_id);
      }

      // Automatic tile rows need collections nobody named.
      const autoTileSections = sections.filter(
        (section) =>
          section.section_key === 'collection_tiles' && (asSettings(section.settings).source ?? 'auto') === 'auto',
      );

      // ── one fetch per kind, whatever the page's size ───────────────────────
      const [mediaRows, productRows, collectionRows, autoCollections] = await Promise.all([
        pageBuilderRepository.media([...gathered.media]),
        storefrontRepository.productsByIds([...gathered.products]),
        pageBuilderRepository.collections([...gathered.collections]),
        autoTileSections.length > 0 ? pageBuilderRepository.menuCollections(6) : Promise.resolve([]),
      ]);

      const cards = await cardsWithVariants(productRows);
      const shelfEntries = await Promise.all(
        [...gathered.shelves].map(async (id) => [id, await shelvesService.publicById(id)] as const),
      );

      const mediaById = new Map(
        mediaRows.map((row) => [
          Number(row.id),
          {
            url: mediaUrl(row.storage_key as string),
            alt: (row.alt_text as string | null) ?? '',
            type: (row.media_type as string) === 'video' ? 'video' : 'image',
            width: row.width === null ? null : Number(row.width),
            height: row.height === null ? null : Number(row.height),
          },
        ]),
      );
      const cardById = new Map(cards.map((card) => [(card as { id: number }).id, card]));
      const collectionById = new Map(
        collectionRows.map((row) => [
          Number(row.id),
          {
            slug: row.slug as string,
            title: row.title as string,
            subtitle: (row.subtitle as string | null) ?? null,
            image: mediaUrl(row.image_key as string | null),
          },
        ]),
      );
      const shelfById = new Map(shelfEntries);
      const slugs = {
        products: new Map(productRows.map((row) => [row.id, row.slug])),
        collections: new Map(collectionRows.map((row) => [Number(row.id), row.slug as string])),
      };

      /** Replaces ids with the things they name, by the field's declared kind. */
      const resolveFields = (fields: Field[], raw: Record<string, unknown>) => {
        const out: Record<string, unknown> = { ...raw };
        for (const field of fields) {
          const value = raw[field.key];
          if (field.kind === 'link') {
            out[field.key] = value ? { ...(value as object), href: href(value, slugs) } : null;
            continue;
          }
          if (value === null || value === undefined) continue;
          const id = Number(value);
          switch (field.kind) {
            case 'media':
              out[field.key] = mediaById.get(id) ?? null;
              break;
            case 'product':
              out[field.key] = cardById.get(id) ?? null;
              break;
            case 'collection':
              out[field.key] = collectionById.get(id) ?? null;
              break;
            case 'shelf':
              out[field.key] = shelfById.get(id) ?? null;
              break;
            default:
              break;
          }
        }
        return out;
      };

      const resolved = await Promise.all(
        sections.map(async (section) => {
          const fields = fieldsOf(section.section_key);
          const settings = resolveFields(fields.settings, asSettings(section.settings));

          const sectionBlocks = (blocksBySection.get(section.section_id) ?? []).map((block) => {
            const blockFields = fields.blocks.get(block.block_type) ?? [];
            const raw = {
              ...asSettings(block.settings),
              ...(block.media_id ? { media: block.media_id } : {}),
              ...(block.link_type === 'product' && block.link_ref_id ? { product: block.link_ref_id } : {}),
              ...(block.link_type === 'collection' && block.link_ref_id ? { collection: block.link_ref_id } : {}),
              ...(block.link_url || block.link_ref_id
                ? { link: { type: block.link_type, ref_id: block.link_ref_id, url: block.link_url } }
                : {}),
            };
            return {
              id: block.id,
              key: block.block_type,
              settings: resolveFields(blockFields, raw),
            };
          });

          // ── the kinds that fetch something of their own ────────────────────
          //
          // Kept here rather than in each storefront component: a section that
          // needs a second request to render is a section that renders late,
          // and the page is supposed to arrive in one piece.
          let extra: Record<string, unknown> = {};
          if (section.section_key === 'collection_tiles' && (settings.source ?? 'auto') === 'auto') {
            extra = {
              tiles: autoCollections.slice(0, Number(settings.columns ?? 3)).map((row) => ({
                slug: row.slug as string,
                title: row.title as string,
                subtitle: (row.subtitle as string | null) ?? null,
                image: mediaUrl(row.image_key as string | null),
              })),
            };
          }
          // `banner_slot` and `faq_embed` are filled in *after* the cache —
          // both read another module's rows, and a banner published a moment
          // ago appearing a minute later is exactly the kind of "is it broken
          // or is it me" that makes people stop trusting a scheduler.

          return {
            id: section.section_id,
            key: section.section_key,
            settings,
            blocks: sectionBlocks,
            ...extra,
          };
        }),
      );

      // A section with nothing to show is dropped here rather than in the
      // browser: a heading over a gap is the most obvious kind of broken, and
      // the storefront should not have to know which kinds can be empty.
      const hasSomething = (section: {
        key: string;
        blocks: unknown[];
        settings: Record<string, unknown>;
        tiles?: unknown[];
        banners?: unknown[];
      }): boolean => {
        const schema = sectionSchema(section.key);
        if (!schema) return false;
        switch (section.key) {
          case 'shelf_embed':
            // Null when the shelf is gone, switched off or itself empty.
            return Boolean(section.settings.shelf);
          case 'collection_tiles':
            return (section.tiles ?? []).length > 0 || section.blocks.length > 0;
          default:
            return schema.emptyWhen === 'no_blocks' ? section.blocks.length > 0 : true;
        }
      };

      return resolved.filter(hasSomething);
    });

    /**
     * What the other modules own, read fresh every time.
     *
     * Cheap — one indexed query each, and a page has at most a couple of these
     * — and it is the difference between a campaign going live when it was
     * scheduled and a campaign going live a minute later for reasons nobody
     * can see.
     */
    const filled = (
      await Promise.all(
        kept.map(async (section) => {
          if (section.key === 'banner_slot') {
            const placement = String(section.settings.placement ?? 'home_carousel');
            const banners = await contentPublicService.banners([placement as never]);
            const rows = (banners as { banners?: Record<string, unknown[]> }).banners?.[placement] ?? [];
            // The slot's whole point is that it disappears when no campaign is
            // scheduled for it, rather than leaving a gap where one was.
            return rows.length > 0 ? { ...section, banners: rows } : null;
          }
          if (section.key === 'faq_embed') {
            const group =
              typeof section.settings.group === 'string' && section.settings.group ? section.settings.group : undefined;
            const faqs = await contentPublicService.faqs(group);
            const rows = ((faqs as { faqs?: unknown[] }).faqs ?? []).slice(0, Number(section.settings.limit ?? 6));
            return rows.length > 0 ? { ...section, faqs: rows } : null;
          }
          return section;
        }),
      )
    ).filter((section): section is NonNullable<typeof section> => section !== null);

    /**
     * Shelves placed on this page but not put anywhere on it.
     *
     * Before the builder, a shelf whose placement was "Home page" simply
     * appeared on the home page. That flow has to keep working: a merchandiser
     * who sets a shelf to Home and never opens the builder should still see it,
     * at the end of the page, rather than discover that their shelf went
     * nowhere and that there is a second screen they were supposed to know
     * about.
     *
     * Anything a `shelf_embed` section already places is excluded, so a shelf
     * that has been positioned deliberately is never also appended.
     *
     * Deliberately outside the cache above. The shelves service keeps its own,
     * and clears it whenever a shelf is written; caching the appended list here
     * as well would mean a shelf switched off still showing up on the page for
     * another minute, with nothing able to clear it.
     */
    const placed = new Set(
      filled
        .filter((section) => section.key === 'shelf_embed')
        .map((section) => (section.settings.shelf as { id?: number } | null)?.id)
        .filter((id): id is number => typeof id === 'number'),
    );
    const loose = await shelvesService.publicList(templateKey as 'home', null);
    const appended = (loose.shelves as { id: number }[])
      .filter((shelf) => !placed.has(shelf.id))
      .map((shelf) => ({
        // Negative, so it can never collide with a section id — and so the
        // admin's preview bridge, which scrolls by section id, simply does not
        // find it rather than scrolling to the wrong band.
        id: -shelf.id,
        key: 'shelf_embed',
        settings: { shelf },
        blocks: [] as { id: number; key: string; settings: Record<string, unknown> }[],
      }));

    return { sections: [...filled, ...appended] };
  },

  // ── writes ─────────────────────────────────────────────────────────────────

  async addSection(templateKey: string, input: { section_key: string; name?: string; after_section_id?: number | null }) {
    const template = await pageBuilderRepository.template(templateKey);
    if (!template) throw ApiError.notFound('Page template');
    if (!isPageSectionKey(input.section_key)) {
      throw ApiError.badRequest(`Unknown section kind "${String(input.section_key)}".`);
    }
    const schema = sectionSchema(input.section_key)!;

    // Defaults from the schema, so a section added from the list looks like
    // something immediately rather than like an empty box the author has to
    // guess the shape of.
    const settings: Record<string, unknown> = {};
    for (const field of schema.settings) {
      if (field.default !== undefined) settings[field.key] = field.default;
    }

    const id = await withTransaction(async (connection) => {
      const sectionId = await pageBuilderRepository.createSection(
        { section_key: input.section_key, name: input.name?.trim() || schema.label, settings },
        connection,
      );
      // Placed where the author asked for it rather than always at the end.
      // "Add a section" in a builder nearly always means "add one *here*", and
      // a new band that lands eight screens below the one being looked at is a
      // new band the author then has to drag all the way back up.
      const order = await pageBuilderRepository.sections(template.id, false, connection);
      const at = order.findIndex((row) => row.section_id === input.after_section_id);
      const next = await pageBuilderRepository.nextSortOrder(template.id, connection);
      await pageBuilderRepository.attach(template.id, sectionId, next, connection);

      if (at >= 0) {
        const ids = order.map((row) => row.section_id);
        ids.splice(at + 1, 0, sectionId);
        await pageBuilderRepository.setOrder(template.id, ids, connection);
      }
      return sectionId;
    });

    clearCache();
    return { section_id: id };
  },

  /**
   * A copy of a section, its blocks included, directly after it.
   *
   * The most-used button in any builder after "add": a merchandiser building
   * three picture-with-products bands builds one, gets it right, and copies it
   * twice. Without it they add three empty ones and fill each in from memory.
   */
  async duplicateSection(sectionId: number) {
    const section = await pageBuilderRepository.section(sectionId);
    if (!section) throw ApiError.notFound('Section');
    const template = await pageBuilderRepository.template('home');

    const blocks = await pageBuilderRepository.blocks([sectionId], false);
    const owner = await pageBuilderRepository.templateOf(sectionId);
    const templateId = owner ?? template?.id;
    if (!templateId) throw ApiError.notFound('Page template');

    const id = await withTransaction(async (connection) => {
      const copyId = await pageBuilderRepository.createSection(
        {
          section_key: section.section_key,
          name: `${section.name} copy`,
          settings: asSettings(section.settings),
        },
        connection,
      );
      for (const block of blocks) {
        await pageBuilderRepository.createBlock(
          copyId,
          {
            block_type: block.block_type,
            sort_order: block.sort_order,
            media_id: block.media_id,
            link_type: block.link_type,
            link_ref_id: block.link_ref_id,
            link_url: block.link_url,
            cta_label: block.cta_label,
            settings: asSettings(block.settings),
          },
          connection,
        );
      }

      const order = await pageBuilderRepository.sections(templateId, false, connection);
      const next = await pageBuilderRepository.nextSortOrder(templateId, connection);
      await pageBuilderRepository.attach(templateId, copyId, next, connection);

      const at = order.findIndex((row) => row.section_id === sectionId);
      if (at >= 0) {
        const ids = order.map((row) => row.section_id);
        ids.splice(at + 1, 0, copyId);
        await pageBuilderRepository.setOrder(templateId, ids, connection);
      }
      return copyId;
    });

    clearCache();
    return { section_id: id };
  },

  async updateSection(sectionId: number, input: Record<string, unknown>) {
    const section = await pageBuilderRepository.section(sectionId);
    if (!section) throw ApiError.notFound('Section');

    const data: Record<string, unknown> = {};
    if (typeof input.name === 'string' && input.name.trim()) data.name = input.name.trim();
    if ('settings' in input) {
      // Merged rather than replaced: the admin form saves one panel at a time,
      // and a replace would drop every setting the open panel does not show.
      const merged = { ...asSettings(section.settings), ...cleanSettings(section.section_key, input.settings) };
      data.settings = JSON.stringify(merged);
    }
    await pageBuilderRepository.updateSection(sectionId, data);

    const assignment: Record<string, unknown> = {};
    if ('is_enabled' in input) assignment.is_enabled = input.is_enabled ? 1 : 0;
    if ('visible_from' in input) assignment.visible_from = input.visible_from ?? null;
    if ('visible_until' in input) assignment.visible_until = input.visible_until ?? null;
    await pageBuilderRepository.updateAssignment(sectionId, assignment);

    clearCache();
    return { updated: true };
  },

  async removeSection(sectionId: number) {
    const section = await pageBuilderRepository.section(sectionId);
    if (!section) throw ApiError.notFound('Section');
    await pageBuilderRepository.removeSection(sectionId);
    clearCache();
    return { deleted: true };
  },

  async reorder(templateKey: string, sectionIds: number[]) {
    const template = await pageBuilderRepository.template(templateKey);
    if (!template) throw ApiError.notFound('Page template');
    await withTransaction(async (connection) => {
      await pageBuilderRepository.setOrder(template.id, sectionIds, connection);
    });
    clearCache();
    return this.forAdmin(templateKey);
  },

  async addBlock(sectionId: number, blockKey: string) {
    const section = await pageBuilderRepository.section(sectionId);
    if (!section) throw ApiError.notFound('Section');
    const schema = blockSchema(section.section_key, blockKey);
    if (!schema) throw ApiError.badRequest(`A ${section.section_key} section has no "${blockKey}" to add.`);

    const existing = await pageBuilderRepository.blocks([sectionId], false);
    const sectionMax = sectionSchema(section.section_key)?.maxBlocks;
    if (sectionMax && existing.length >= sectionMax) {
      throw ApiError.badRequest(`This section holds at most ${sectionMax}.`);
    }
    if (schema.max && existing.filter((block) => block.block_type === blockKey).length >= schema.max) {
      throw ApiError.badRequest(`At most ${schema.max} of those.`);
    }

    const id = await pageBuilderRepository.createBlock(sectionId, {
      block_type: blockKey,
      sort_order: await pageBuilderRepository.nextBlockOrder(sectionId),
      media_id: null,
      link_type: 'none',
      link_ref_id: null,
      link_url: null,
      cta_label: null,
      settings: {},
    });
    clearCache();
    return { block_id: id };
  },

  /**
   * A block's fields, split back into the columns and the blob.
   *
   * `media`, `product` and `collection` go to real columns so they can be
   * joined and so a deleted product does not leave an orphan id buried in JSON;
   * everything else is the blob.
   */
  async updateBlock(sectionId: number, blockId: number, settings: Record<string, unknown>) {
    const section = await pageBuilderRepository.section(sectionId);
    if (!section) throw ApiError.notFound('Section');
    const blocks = await pageBuilderRepository.blocks([sectionId], false);
    const block = blocks.find((row) => row.id === blockId);
    if (!block) throw ApiError.notFound('Block');

    const schema = blockSchema(section.section_key, block.block_type);
    const fields = schema?.fields ?? [];
    const data: Record<string, unknown> = {};
    const blob: Record<string, unknown> = asSettings(block.settings);

    for (const field of fields) {
      if (!(field.key in settings)) continue;
      const value = settings[field.key];
      const asId = Number(value);
      const hasId = Number.isInteger(asId) && asId > 0;

      if (field.kind === 'media') {
        data.media_id = hasId ? asId : null;
      } else if (field.kind === 'product') {
        data.link_type = hasId ? 'product' : 'none';
        data.link_ref_id = hasId ? asId : null;
      } else if (field.kind === 'collection') {
        data.link_type = hasId ? 'collection' : 'none';
        data.link_ref_id = hasId ? asId : null;
      } else if (field.kind === 'link') {
        const link = (value ?? {}) as { type?: string; ref_id?: number | null; url?: string | null };
        data.link_type = link.type ?? 'none';
        data.link_ref_id = link.ref_id ?? null;
        data.link_url = link.url ?? null;
      } else if (field.kind === 'number') {
        blob[field.key] = value === null || value === '' ? null : Number(value);
      } else if (field.kind === 'toggle') {
        blob[field.key] = Boolean(value);
      } else {
        blob[field.key] = value === null || value === '' ? null : String(value).slice(0, 2000);
      }
    }

    data.settings = JSON.stringify(blob);
    if ('is_enabled' in settings) data.is_enabled = settings.is_enabled ? 1 : 0;

    await pageBuilderRepository.updateBlock(blockId, data);
    clearCache();
    return { updated: true };
  },

  async removeBlock(sectionId: number, blockId: number) {
    await pageBuilderRepository.removeBlock(blockId);
    clearCache();
    return { deleted: true };
  },

  async reorderBlocks(sectionId: number, blockIds: number[]) {
    await withTransaction(async (connection) => {
      await pageBuilderRepository.setBlockOrder(sectionId, blockIds, connection);
    });
    clearCache();
    return { reordered: true };
  },
};

function hiddenBecause(section: PageSectionRow): string | null {
  if (section.is_enabled !== 1) return 'Switched off';
  const now = Date.now();
  if (section.visible_from && new Date(section.visible_from).getTime() > now) return 'Scheduled — not started yet';
  if (section.visible_until && new Date(section.visible_until).getTime() < now) return 'Finished';
  return null;
}
