/**
 * The section catalogue: what a page can be built out of.
 *
 * This file is the single definition of every section kind — what it is called,
 * what it is for, which settings it takes, and which kinds of block may sit
 * inside it. The admin's editing form is *generated* from it and the storefront
 * renders by the same keys, so adding a section means editing this file and
 * writing one storefront component. No new table, no new endpoint, no new form.
 *
 * It is Shopify's `{% schema %}` idea with the pieces moved around: Shopify
 * keeps the schema in the theme file and the content in a JSON template. Here
 * the schema is served by the API — the admin is a separate application that
 * cannot read the storefront's source, so the catalogue has to travel over the
 * wire or the two drift apart within a week.
 *
 * ── the shape of a page ─────────────────────────────────────────────────────
 *
 *   page_templates            'home', and any page that follows
 *     └── content_section_assignments   which sections, in what order, when
 *           └── content_sections        the section itself: kind + settings
 *                 └── content_section_blocks   its repeated parts, in order
 *
 * Every one of those tables already existed for product storytelling. The page
 * builder adds a template to point at and a vocabulary of kinds — not a
 * parallel system, which is how a codebase ends up with three ways to put a
 * heading on a page.
 */

export type FieldKind =
  | 'text'
  | 'textarea'
  | 'richtext'
  | 'select'
  | 'toggle'
  | 'number'
  | 'color'
  | 'media'
  | 'product'
  | 'collection'
  | 'shelf'
  | 'link'
  | 'icon';

/**
 * Which panel of the editor a field belongs in.
 *
 * Sixteen settings in one scroll is a wall; the same sixteen under Content,
 * Layout, Style and Schedule are four short lists, and a merchandiser looking
 * for "how wide" knows without reading which one to open. Derived from the
 * field's own key rather than written out per field — every section calls its
 * background `background`, and a map of forty keys is one place to be wrong
 * instead of two hundred.
 */
export type FieldGroup = 'content' | 'layout' | 'style' | 'schedule';

export interface Field {
  key: string;
  label: string;
  kind: FieldKind;
  /** Filled in by the catalogue; never written by hand in the schemas below. */
  group?: FieldGroup;
  /** One line under the input, in the admin's own words. */
  help?: string;
  placeholder?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  default?: unknown;
  /** Media fields only: what may be chosen. */
  accepts?: 'image' | 'video' | 'any';
}

export interface BlockSchema {
  key: string;
  label: string;
  help?: string;
  fields: Field[];
  /** How many of this block a section may hold. */
  max?: number;
}

export interface SectionSchema {
  key: string;
  label: string;
  /** What it is for, in the words a merchandiser would use. */
  description: string;
  /** Groups the "add a section" list, which is otherwise a wall of names. */
  group: 'hero' | 'products' | 'story' | 'media' | 'utility';
  settings: Field[];
  blocks: BlockSchema[];
  /** Total blocks, whatever their kind. */
  maxBlocks?: number;
  /** A section with nothing in it renders nothing; this says what "empty" is. */
  emptyWhen?: 'no_blocks' | 'never';
}

// ── field shorthands ─────────────────────────────────────────────────────────
// Written out rather than abbreviated into a builder: a schema is read far more
// often than it is written, and `text('heading', 'Heading')` hides which of the
// four optional properties a field actually sets.

const BACKGROUND: Field = {
  key: 'background',
  label: 'Background',
  kind: 'select',
  default: 'ivory',
  options: [
    { value: 'ivory', label: 'Ivory' },
    { value: 'cream', label: 'Cream' },
    { value: 'champagne', label: 'Champagne' },
    { value: 'espresso', label: 'Espresso (dark)' },
    { value: 'none', label: 'None — inherit the page' },
  ],
};

const SPACING: Field = {
  key: 'spacing',
  label: 'Vertical space',
  kind: 'select',
  default: 'normal',
  options: [
    { value: 'tight', label: 'Tight' },
    { value: 'normal', label: 'Normal' },
    { value: 'roomy', label: 'Roomy' },
  ],
};

const SIDE: Field = {
  key: 'media_side',
  label: 'Picture on the',
  kind: 'select',
  default: 'left',
  options: [
    { value: 'left', label: 'Left' },
    { value: 'right', label: 'Right' },
  ],
  help: 'On a phone the picture is always on top — side-by-side at 390px gives neither half enough room.',
};

const CTA_LABEL: Field = { key: 'cta_label', label: 'Button text', kind: 'text', placeholder: 'Shop now' };
const CTA_LINK: Field = { key: 'cta_link', label: 'Button goes to', kind: 'link' };

/**
 * The catalogue.
 *
 * Order matters only for the admin's "add a section" list, where it is grouped
 * and then read top to bottom.
 */
export const SECTION_SCHEMAS: SectionSchema[] = [
  // ── hero ───────────────────────────────────────────────────────────────────
  {
    key: 'hero',
    label: 'Hero',
    description: 'A full-width picture or film with the headline over it. The first thing on the page.',
    group: 'hero',
    settings: [
      { key: 'media', label: 'Picture or film', kind: 'media', accepts: 'any' },
      {
        key: 'media_mobile',
        label: 'Picture for phones',
        kind: 'media',
        accepts: 'image',
        help: 'Optional. A wide crop loses its subject at 390px; this is where the portrait version goes.',
      },
      { key: 'eyebrow', label: 'Small line above', kind: 'text', placeholder: 'Small batch · Made in India' },
      { key: 'heading', label: 'Headline', kind: 'textarea', placeholder: 'Skincare that earns its place' },
      {
        key: 'heading_accent',
        label: 'Italic line inside the headline',
        kind: 'text',
        help: 'Set apart in italic on its own line — the phrase the headline turns on.',
      },
      {
        key: 'heading_tail',
        label: 'Line after the italic one',
        kind: 'text',
        help: 'Optional. Together the three read as one sentence across three lines.',
      },
      { key: 'body', label: 'Paragraph', kind: 'textarea' },
      CTA_LABEL,
      CTA_LINK,
      { key: 'cta_secondary_label', label: 'Second button text', kind: 'text' },
      { key: 'cta_secondary_link', label: 'Second button goes to', kind: 'link' },
      {
        key: 'align',
        label: 'Words sit',
        kind: 'select',
        default: 'left',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centred' },
        ],
      },
      {
        key: 'height',
        label: 'Height',
        kind: 'select',
        default: 'tall',
        options: [
          { value: 'short', label: 'Short' },
          { value: 'tall', label: 'Tall' },
          { value: 'full', label: 'Full screen' },
        ],
      },
      {
        key: 'overlay',
        label: 'Darken the picture',
        kind: 'number',
        min: 0,
        max: 80,
        default: 30,
        help: 'Per cent. White words on an undarkened photograph are unreadable about half the time.',
      },
      { key: 'text_color', label: 'Text colour', kind: 'color' },
      BACKGROUND,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  // ── the Dior split ─────────────────────────────────────────────────────────
  {
    key: 'media_products',
    label: 'Picture with products',
    description:
      'A picture or film down one side, a heading and any number of products down the other. The layout luxury houses use to put a campaign image next to the thing it is selling.',
    group: 'products',
    settings: [
      { key: 'media', label: 'Picture or film', kind: 'media', accepts: 'any' },
      { key: 'media_mobile', label: 'Picture for phones', kind: 'media', accepts: 'image' },
      SIDE,
      {
        key: 'media_ratio',
        label: 'Picture shape',
        kind: 'select',
        default: 'portrait',
        options: [
          { value: 'portrait', label: 'Portrait (4:5)' },
          { value: 'square', label: 'Square' },
          { value: 'tall', label: 'Tall (2:3)' },
          { value: 'fill', label: 'Fill the whole side' },
        ],
      },
      { key: 'eyebrow', label: 'Small line above', kind: 'text', placeholder: 'Rouge Dior' },
      { key: 'heading', label: 'Heading', kind: 'textarea', placeholder: 'The new 24-hour matte lipsticks' },
      { key: 'body', label: 'Paragraph', kind: 'textarea' },
      {
        key: 'columns',
        label: 'Products across',
        kind: 'number',
        min: 1,
        max: 4,
        default: 2,
        help: 'On a phone this is always two, or one when the cards carry a description.',
      },
      {
        key: 'card_style',
        label: 'Product shown as',
        kind: 'select',
        default: 'compact',
        options: [
          { value: 'compact', label: 'Picture and name only' },
          { value: 'full', label: 'The full shelf card' },
        ],
        help: 'Compact keeps the section about the campaign; the full card sells from it directly.',
      },
      {
        key: 'align',
        label: 'Words sit',
        kind: 'select',
        default: 'center',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centred' },
        ],
      },
      CTA_LABEL,
      CTA_LINK,
      BACKGROUND,
      SPACING,
    ],
    blocks: [
      {
        key: 'product',
        label: 'Product',
        fields: [
          { key: 'product', label: 'Which product', kind: 'product' },
          { key: 'label', label: 'Name to show instead', kind: 'text', help: 'Optional — the product’s own name is used when this is empty.' },
          { key: 'media', label: 'Picture to show instead', kind: 'media', accepts: 'image' },
        ],
        max: 8,
      },
    ],
    maxBlocks: 8,
    emptyWhen: 'no_blocks',
  },

  // ── products ───────────────────────────────────────────────────────────────
  {
    key: 'shelf_embed',
    label: 'Product shelf',
    description:
      'One of the shelves from Merchandising, dropped in at this point of the page — carousel, grid, spotlight or ranked chart, with its rule still deciding what is in it. A shelf set to this page and not placed here appears at the end of it.',
    group: 'products',
    settings: [
      { key: 'shelf', label: 'Which shelf', kind: 'shelf' },
      {
        key: 'override_heading',
        label: 'Heading to show instead',
        kind: 'text',
        help: 'Optional — the shelf’s own heading is used when this is empty.',
      },
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'collection_tiles',
    label: 'Collection tiles',
    description: 'Large tiles that lead into collections — the "shop by edit" row.',
    group: 'products',
    settings: [
      { key: 'eyebrow', label: 'Small line above', kind: 'text', placeholder: 'Curated' },
      { key: 'heading', label: 'Heading', kind: 'text', placeholder: 'Shop by edit' },
      {
        key: 'source',
        label: 'Which collections',
        kind: 'select',
        default: 'auto',
        options: [
          { value: 'auto', label: 'The first few shown in the menu' },
          { value: 'chosen', label: 'Only the ones I add below' },
        ],
        help: 'Automatic keeps the row current on its own as collections come and go.',
      },
      { key: 'columns', label: 'Tiles across', kind: 'number', min: 2, max: 4, default: 3 },
      BACKGROUND,
      SPACING,
    ],
    blocks: [
      {
        key: 'tile',
        label: 'Tile',
        fields: [
          { key: 'collection', label: 'Collection', kind: 'collection' },
          { key: 'label', label: 'Title to show instead', kind: 'text' },
          { key: 'body', label: 'One line under it', kind: 'text' },
          { key: 'media', label: 'Picture', kind: 'media', accepts: 'image' },
          { key: 'color', label: 'Colour, when there is no picture', kind: 'color' },
        ],
        max: 6,
      },
    ],
    maxBlocks: 6,
    emptyWhen: 'no_blocks',
  },

  // ── story ──────────────────────────────────────────────────────────────────
  {
    key: 'image_text',
    label: 'Picture and words',
    description: 'A picture one side, a heading, copy and a link the other.',
    group: 'story',
    settings: [
      { key: 'media', label: 'Picture', kind: 'media', accepts: 'image' },
      SIDE,
      { key: 'eyebrow', label: 'Small line above', kind: 'text' },
      { key: 'heading', label: 'Heading', kind: 'textarea' },
      { key: 'body', label: 'Copy', kind: 'richtext' },
      CTA_LABEL,
      CTA_LINK,
      BACKGROUND,
      SPACING,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'story_panel',
    label: 'Story panel with figures',
    description:
      'An editorial panel — a line of type inside a framed block, with figures under it — beside the argument it is making. The brand story, as the home page has it today.',
    group: 'story',
    settings: [
      { key: 'panel_quote', label: 'Line inside the panel', kind: 'textarea' },
      { key: 'panel_icon', label: 'Icon above it', kind: 'icon' },
      { key: 'media', label: 'Picture instead of the panel', kind: 'media', accepts: 'image' },
      SIDE,
      { key: 'eyebrow', label: 'Small line above', kind: 'text' },
      { key: 'heading', label: 'Heading', kind: 'textarea' },
      { key: 'body', label: 'Copy', kind: 'richtext' },
      CTA_LABEL,
      CTA_LINK,
      BACKGROUND,
      SPACING,
    ],
    blocks: [
      {
        key: 'stat',
        label: 'Figure',
        fields: [
          { key: 'value', label: 'The number', kind: 'text', placeholder: '9' },
          { key: 'label', label: 'What it counts', kind: 'text', placeholder: 'Formulas' },
        ],
        max: 4,
      },
    ],
    maxBlocks: 4,
    emptyWhen: 'never',
  },

  {
    key: 'promises',
    label: 'Promise strip',
    description: 'A row of icon, title and one line — delivery, testing, what the brand guarantees.',
    group: 'story',
    settings: [
      { key: 'columns', label: 'Across', kind: 'number', min: 2, max: 4, default: 4 },
      BACKGROUND,
      SPACING,
    ],
    blocks: [
      {
        key: 'item',
        label: 'Promise',
        fields: [
          { key: 'icon', label: 'Icon', kind: 'icon' },
          { key: 'title', label: 'Title', kind: 'text' },
          { key: 'body', label: 'One line', kind: 'textarea' },
        ],
        max: 6,
      },
    ],
    maxBlocks: 6,
    emptyWhen: 'no_blocks',
  },

  {
    key: 'rich_text',
    label: 'Words only',
    description: 'A heading and copy, centred or ranged left. For a statement that needs no picture.',
    group: 'story',
    settings: [
      { key: 'eyebrow', label: 'Small line above', kind: 'text' },
      { key: 'heading', label: 'Heading', kind: 'textarea' },
      { key: 'body', label: 'Copy', kind: 'richtext' },
      {
        key: 'align',
        label: 'Ranged',
        kind: 'select',
        default: 'center',
        options: [
          { value: 'left', label: 'Left' },
          { value: 'center', label: 'Centred' },
        ],
      },
      {
        key: 'width',
        label: 'Column width',
        kind: 'select',
        default: 'narrow',
        options: [
          { value: 'narrow', label: 'Narrow — comfortable to read' },
          { value: 'wide', label: 'Wide' },
        ],
      },
      CTA_LABEL,
      CTA_LINK,
      BACKGROUND,
      SPACING,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'quote',
    label: 'Pull quote',
    description: 'One sentence, set large, with who said it.',
    group: 'story',
    settings: [
      { key: 'quote', label: 'The line', kind: 'textarea' },
      { key: 'attribution', label: 'Who said it', kind: 'text' },
      { key: 'media', label: 'Portrait', kind: 'media', accepts: 'image' },
      BACKGROUND,
      SPACING,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  // ── media ──────────────────────────────────────────────────────────────────
  {
    key: 'gallery',
    label: 'Gallery',
    description: 'A row or grid of pictures, each able to lead somewhere.',
    group: 'media',
    settings: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'columns', label: 'Across', kind: 'number', min: 2, max: 5, default: 3 },
      {
        key: 'ratio',
        label: 'Shape',
        kind: 'select',
        default: 'portrait',
        options: [
          { value: 'square', label: 'Square' },
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
      },
      {
        key: 'scroll_on_phone',
        label: 'Scroll sideways on a phone',
        kind: 'toggle',
        default: true,
        help: 'Rather than stacking — a gallery of twelve is a very long page on a phone.',
      },
      BACKGROUND,
      SPACING,
    ],
    blocks: [
      {
        key: 'image',
        label: 'Picture',
        fields: [
          { key: 'media', label: 'Picture', kind: 'media', accepts: 'image' },
          { key: 'caption', label: 'Caption', kind: 'text' },
          { key: 'link', label: 'Leads to', kind: 'link' },
        ],
        max: 12,
      },
    ],
    maxBlocks: 12,
    emptyWhen: 'no_blocks',
  },

  {
    key: 'video',
    label: 'Film',
    description: 'A film that fills the width, with the words over or under it.',
    group: 'media',
    settings: [
      { key: 'media', label: 'Film', kind: 'media', accepts: 'video' },
      { key: 'poster', label: 'Frame to show first', kind: 'media', accepts: 'image' },
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'body', label: 'Paragraph', kind: 'textarea' },
      {
        key: 'autoplay',
        label: 'Play by itself',
        kind: 'toggle',
        default: true,
        help: 'Muted either way — no browser autoplays sound, so an unmuted film never plays at all. Phones always get the frame instead.',
      },
      CTA_LABEL,
      CTA_LINK,
      BACKGROUND,
      SPACING,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'marquee',
    label: 'Scrolling line',
    description: 'A line of words sliding across the page. Small, loud, and easy to overuse.',
    group: 'utility',
    settings: [
      { key: 'text', label: 'The words', kind: 'text', placeholder: 'Complimentary delivery over ₹999' },
      { key: 'separator', label: 'Between repeats', kind: 'text', default: '·' },
      {
        key: 'speed',
        label: 'Speed',
        kind: 'select',
        default: 'normal',
        options: [
          { value: 'slow', label: 'Slow' },
          { value: 'normal', label: 'Normal' },
          { value: 'fast', label: 'Fast' },
        ],
      },
      BACKGROUND,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  // ── utility ────────────────────────────────────────────────────────────────
  {
    key: 'faq_embed',
    label: 'Questions',
    description: 'An FAQ group, as an accordion. The answers stay in Content → FAQs.',
    group: 'utility',
    settings: [
      { key: 'heading', label: 'Heading', kind: 'text', placeholder: 'Questions' },
      { key: 'group', label: 'Which group', kind: 'text', help: 'The FAQ group’s handle. Empty shows every published question.' },
      { key: 'limit', label: 'How many', kind: 'number', min: 1, max: 20, default: 6 },
      BACKGROUND,
      SPACING,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'newsletter',
    label: 'Email sign-up',
    description: 'A heading, a line and one field.',
    group: 'utility',
    settings: [
      { key: 'heading', label: 'Heading', kind: 'text' },
      { key: 'body', label: 'One line', kind: 'textarea' },
      { key: 'placeholder', label: 'Field placeholder', kind: 'text', default: 'you@example.com' },
      { key: 'cta_label', label: 'Button text', kind: 'text', default: 'Sign up' },
      BACKGROUND,
      SPACING,
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'banner_slot',
    label: 'Campaign banner slot',
    description:
      'Renders whatever banner is scheduled for a placement, and nothing at all when none is. Lets a campaign appear mid-page without anyone rebuilding the page.',
    group: 'utility',
    settings: [
      {
        key: 'placement',
        label: 'Which slot',
        kind: 'select',
        default: 'home_carousel',
        options: [
          { value: 'home_carousel', label: 'Home carousel' },
          { value: 'home_hero', label: 'Home hero' },
          { value: 'category_top', label: 'Category top' },
          { value: 'pdp_strip', label: 'Product strip' },
        ],
      },
    ],
    blocks: [],
    emptyWhen: 'never',
  },

  {
    key: 'spacer',
    label: 'Space',
    description: 'Empty room, and optionally a hairline. For when two sections need air between them.',
    group: 'utility',
    settings: [
      {
        key: 'size',
        label: 'How much',
        kind: 'select',
        default: 'normal',
        options: [
          { value: 'tight', label: 'A little' },
          { value: 'normal', label: 'Some' },
          { value: 'roomy', label: 'A lot' },
        ],
      },
      { key: 'rule', label: 'Draw a line', kind: 'toggle', default: false },
      BACKGROUND,
    ],
    blocks: [],
    emptyWhen: 'never',
  },
];

const BY_KEY = new Map(SECTION_SCHEMAS.map((schema) => [schema.key, schema]));

export function sectionSchema(key: string): SectionSchema | null {
  return BY_KEY.get(key) ?? null;
}

export function isPageSectionKey(key: unknown): key is string {
  return typeof key === 'string' && BY_KEY.has(key);
}

/**
 * The fields of one block kind, for validation.
 *
 * Returns null for a block kind the section does not allow, which is how an
 * "add block" of the wrong type is refused rather than stored and puzzled over.
 */
export function blockSchema(sectionKey: string, blockKey: string): BlockSchema | null {
  return sectionSchema(sectionKey)?.blocks.find((block) => block.key === blockKey) ?? null;
}

/**
 * Only keys the schema declares survive, and each is coerced to the kind the
 * field says it is.
 *
 * A settings blob is the one place in this system where an admin can put
 * arbitrary JSON in the database, so it is filtered on the way in rather than
 * trusted on the way out — a stray key is harmless today and a rendering bug
 * the day somebody reads settings with a spread.
 */
export function cleanSettings(sectionKey: string, raw: unknown): Record<string, unknown> {
  const schema = sectionSchema(sectionKey);
  if (!schema || typeof raw !== 'object' || raw === null) return {};
  const input = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const field of schema.settings) {
    if (!(field.key in input)) continue;
    const value = input[field.key];
    if (value === null || value === '') {
      out[field.key] = null;
      continue;
    }
    switch (field.kind) {
      case 'number': {
        const numeric = Number(value);
        if (!Number.isFinite(numeric)) break;
        out[field.key] = Math.min(field.max ?? Number.MAX_SAFE_INTEGER, Math.max(field.min ?? 0, numeric));
        break;
      }
      case 'toggle':
        out[field.key] = Boolean(value);
        break;
      case 'media':
      case 'product':
      case 'collection':
      case 'shelf': {
        const id = Number(value);
        if (Number.isInteger(id) && id > 0) out[field.key] = id;
        break;
      }
      case 'select': {
        const allowed = field.options?.map((option) => option.value) ?? [];
        if (allowed.includes(String(value))) out[field.key] = String(value);
        break;
      }
      case 'link':
        // `{ type, ref_id, url }`, in the same vocabulary the banners, menus and
        // announcement lines use.
        if (typeof value === 'object') {
          const link = value as Record<string, unknown>;
          out[field.key] = {
            type: typeof link.type === 'string' ? link.type : 'none',
            ref_id: Number.isInteger(Number(link.ref_id)) && Number(link.ref_id) > 0 ? Number(link.ref_id) : null,
            url: typeof link.url === 'string' ? link.url.slice(0, 500) : null,
          };
        }
        break;
      default:
        out[field.key] = String(value).slice(0, field.kind === 'richtext' ? 8000 : 2000);
    }
  }

  return out;
}

/**
 * Which panel each setting belongs in.
 *
 * Anything not listed is content — which is the right default, because a field
 * nobody thought about is almost always a word the author is writing.
 */
const FIELD_GROUPS: Record<string, FieldGroup> = {
  // how it is arranged
  media_side: 'layout',
  media_ratio: 'layout',
  columns: 'layout',
  align: 'layout',
  height: 'layout',
  width: 'layout',
  ratio: 'layout',
  card_style: 'layout',
  scroll_on_phone: 'layout',
  size: 'layout',
  // how it looks
  background: 'style',
  spacing: 'style',
  tone: 'style',
  overlay: 'style',
  text_color: 'style',
  color: 'style',
  rule: 'style',
  speed: 'style',
};

function grouped(fields: Field[]): Field[] {
  return fields.map((field) => ({ ...field, group: field.group ?? FIELD_GROUPS[field.key] ?? 'content' }));
}

/** The catalogue as the admin's "add a section" list wants it. */
export function sectionCatalogue() {
  return SECTION_SCHEMAS.map((schema) => ({
    key: schema.key,
    label: schema.label,
    description: schema.description,
    group: schema.group,
    settings: grouped(schema.settings),
    blocks: schema.blocks.map((block) => ({ ...block, fields: grouped(block.fields) })),
    max_blocks: schema.maxBlocks ?? null,
  }));
}
