/**
 * The built-in theme library.
 *
 * A theme is presentation, never content. It declares:
 *
 *   settings_schema — the knobs a merchant turns in the theme editor (colours,
 *                     fonts, layout, product cards), each with a type and a
 *                     default. The editor is generated from this, and saved
 *                     settings are validated against it.
 *   presets         — named starting points ("Porcelain", "Midnight") that
 *                     override some defaults.
 *   templates       — how each page type is laid out, and the starter sections
 *                     a new shop's home page gets.
 *   section_types   — which page-builder sections the theme can render.
 *
 * Colour settings use the page builder's background slots as their names
 * (ivory, cream, champagne, espresso), so a section saved with background
 * "cream" renders in whatever the current theme says cream is.
 *
 * Built-ins are synced into theme_library at boot (see themes.service), keyed
 * by handle. Bumping `version` is how a change reaches the table.
 */

export type ThemeSettingType = 'color' | 'font' | 'range' | 'select' | 'checkbox' | 'text' | 'url' | 'image';

export interface ThemeSettingDef {
  id: string;
  type: ThemeSettingType;
  label: string;
  default: string | number | boolean | null;
  info?: string;
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
}

export interface ThemeSettingGroup {
  name: string;
  settings: ThemeSettingDef[];
}

export interface ThemePreset {
  key: string;
  name: string;
  settings: Record<string, string | number | boolean | null>;
}

export interface ThemeTemplateSection {
  key: string;
  name: string;
  settings: Record<string, unknown>;
}

export interface ThemeDefinition {
  handle: string;
  name: string;
  version: string;
  description: string;
  verticals: string[];
  previewImageUrl: string | null;
  sortOrder: number;
  defaults: Record<string, string | number | boolean | null>;
  presets: ThemePreset[];
  templates: {
    home: ThemeTemplateSection[];
    product: Record<string, unknown>;
    collection: Record<string, unknown>;
  };
}

export const FONT_OPTIONS = [
  'Inter', 'DM Sans', 'Manrope', 'Work Sans', 'IBM Plex Sans', 'Poppins', 'Nunito Sans', 'Karla', 'Space Grotesk',
  'Playfair Display', 'Cormorant Garamond', 'Libre Baskerville', 'Lora', 'Fraunces', 'EB Garamond', 'DM Serif Display',
  'Archivo', 'Bebas Neue', 'Syne', 'Outfit',
].map((font) => ({ value: font, label: font }));

const option = (...entries: [string, string][]) => entries.map(([value, label]) => ({ value, label }));

/** The schema every built-in theme shares; themes differ in defaults, presets and layouts. */
export function baseSchema(defaults: Record<string, string | number | boolean | null>): ThemeSettingGroup[] {
  const d = (id: string, fallback: string | number | boolean | null) => (id in defaults ? defaults[id] : fallback);
  return [
    {
      name: 'Colours',
      settings: [
        { id: 'color_background', type: 'color', label: 'Page background', default: d('color_background', '#FFFFFF') },
        { id: 'color_ivory', type: 'color', label: 'Surface', default: d('color_ivory', '#FAFAF7'), info: 'Sections with the "Ivory" background.' },
        { id: 'color_cream', type: 'color', label: 'Surface, alternate', default: d('color_cream', '#F3EFE7'), info: 'Sections with the "Cream" background.' },
        { id: 'color_champagne', type: 'color', label: 'Accent surface', default: d('color_champagne', '#EADFCB'), info: 'Sections with the "Champagne" background.' },
        { id: 'color_espresso', type: 'color', label: 'Inverse surface', default: d('color_espresso', '#1F1B16'), info: 'Dark sections.' },
        { id: 'color_text', type: 'color', label: 'Text', default: d('color_text', '#1A1A1A') },
        { id: 'color_text_muted', type: 'color', label: 'Secondary text', default: d('color_text_muted', '#6B6B6B') },
        { id: 'color_accent', type: 'color', label: 'Buttons and links', default: d('color_accent', '#1A1A1A') },
        { id: 'color_accent_contrast', type: 'color', label: 'Text on buttons', default: d('color_accent_contrast', '#FFFFFF') },
        { id: 'color_border', type: 'color', label: 'Borders', default: d('color_border', '#E5E5E5') },
        { id: 'color_sale', type: 'color', label: 'Sale price', default: d('color_sale', '#B42318') },
      ],
    },
    {
      name: 'Typography',
      settings: [
        { id: 'font_heading', type: 'font', label: 'Headings', default: d('font_heading', 'Inter'), options: FONT_OPTIONS },
        { id: 'font_body', type: 'font', label: 'Body', default: d('font_body', 'Inter'), options: FONT_OPTIONS },
        { id: 'font_base_size', type: 'range', label: 'Base size', default: d('font_base_size', 16), min: 14, max: 20, step: 1, unit: 'px' },
        { id: 'heading_scale', type: 'range', label: 'Heading scale', default: d('heading_scale', 120), min: 90, max: 160, step: 5, unit: '%' },
        {
          id: 'heading_case',
          type: 'select',
          label: 'Heading case',
          default: d('heading_case', 'none'),
          options: option(['none', 'As written'], ['uppercase', 'Uppercase']),
        },
      ],
    },
    {
      name: 'Layout',
      settings: [
        { id: 'page_width', type: 'range', label: 'Page width', default: d('page_width', 1280), min: 1000, max: 1600, step: 20, unit: 'px' },
        { id: 'radius', type: 'range', label: 'Corner radius', default: d('radius', 8), min: 0, max: 24, step: 2, unit: 'px' },
        {
          id: 'button_style',
          type: 'select',
          label: 'Buttons',
          default: d('button_style', 'rounded'),
          options: option(['square', 'Square'], ['rounded', 'Rounded'], ['pill', 'Pill']),
        },
        {
          id: 'header_layout',
          type: 'select',
          label: 'Header',
          default: d('header_layout', 'logo_left'),
          options: option(['logo_left', 'Logo left, menu centre'], ['logo_center', 'Logo centred'], ['minimal', 'Logo and icons only']),
        },
        { id: 'sticky_header', type: 'checkbox', label: 'Keep the header visible on scroll', default: d('sticky_header', true) },
        { id: 'show_announcement', type: 'checkbox', label: 'Show the announcement bar', default: d('show_announcement', true) },
      ],
    },
    {
      name: 'Products',
      settings: [
        {
          id: 'image_ratio',
          type: 'select',
          label: 'Product image shape',
          default: d('image_ratio', 'portrait'),
          options: option(['square', 'Square'], ['portrait', 'Portrait (4:5)'], ['landscape', 'Landscape (4:3)'], ['natural', 'As uploaded']),
        },
        {
          id: 'card_style',
          type: 'select',
          label: 'Product cards',
          default: d('card_style', 'minimal'),
          options: option(['minimal', 'Minimal'], ['bordered', 'Bordered'], ['elevated', 'Shadowed'], ['overlay', 'Text over image']),
        },
        { id: 'show_secondary_image', type: 'checkbox', label: 'Show second image on hover', default: d('show_secondary_image', true) },
        { id: 'quick_add', type: 'checkbox', label: 'Quick add to bag', default: d('quick_add', true) },
        { id: 'show_ratings', type: 'checkbox', label: 'Show star ratings', default: d('show_ratings', true) },
        { id: 'show_sale_badge', type: 'checkbox', label: 'Show sale badge', default: d('show_sale_badge', true) },
      ],
    },
    {
      name: 'Brand',
      settings: [
        { id: 'logo', type: 'image', label: 'Logo', default: null },
        { id: 'logo_width', type: 'range', label: 'Logo width', default: d('logo_width', 120), min: 60, max: 260, step: 10, unit: 'px' },
        { id: 'favicon', type: 'image', label: 'Favicon', default: null },
      ],
    },
    {
      name: 'Social',
      settings: [
        { id: 'social_instagram', type: 'url', label: 'Instagram', default: null },
        { id: 'social_facebook', type: 'url', label: 'Facebook', default: null },
        { id: 'social_x', type: 'url', label: 'X (Twitter)', default: null },
        { id: 'social_youtube', type: 'url', label: 'YouTube', default: null },
        { id: 'social_tiktok', type: 'url', label: 'TikTok', default: null },
      ],
    },
  ];
}

/** The home page every theme starts a new shop with, filled from the vertical's copy. */
function standardHome(
  options: { heroHeight?: string; heroAlign?: string; tileColumns?: number; promisesBackground?: string } = {},
): ThemeTemplateSection[] {
  return [
    { key: 'hero', name: 'Home — hero', settings: { height: options.heroHeight ?? 'tall', align: options.heroAlign ?? 'left', overlay: 30 } },
    { key: 'promises', name: 'Home — promises', settings: { columns: 4, background: options.promisesBackground ?? 'cream', spacing: 'tight' } },
    { key: 'collection_tiles', name: 'Home — shop by collection', settings: { source: 'auto', columns: options.tileColumns ?? 3, heading: 'Shop the collections', background: 'none' } },
    { key: 'banner_slot', name: 'Home — campaign slot', settings: { placement: 'home_carousel' } },
    { key: 'newsletter', name: 'Home — newsletter', settings: { heading: 'Be the first to know', body: 'New arrivals, offers and stories, now and then.', background: 'ivory' } },
  ];
}

const STANDARD_PRODUCT = { gallery: 'grid', sticky_info: true, show_breadcrumbs: true, related_products: 4, show_share: true };
const STANDARD_COLLECTION = { filters: 'sidebar', products_per_page: 24, show_sort: true, columns_desktop: 4, columns_mobile: 2 };

export const BUILT_IN_THEMES: ThemeDefinition[] = [
  {
    handle: 'aurora',
    name: 'Aurora',
    version: '1.0.0',
    description: 'Clean and versatile. Works for any catalogue, from ten products to ten thousand.',
    verticals: ['general', 'pets', 'toys'],
    previewImageUrl: null,
    sortOrder: 10,
    defaults: { font_heading: 'Manrope', font_body: 'Inter', radius: 10, button_style: 'rounded', card_style: 'minimal', color_accent: '#2F5BEA' },
    presets: [
      { key: 'daylight', name: 'Daylight', settings: {} },
      { key: 'midnight', name: 'Midnight', settings: { color_background: '#0F1115', color_ivory: '#151821', color_cream: '#1B1F2A', color_text: '#F5F6F8', color_text_muted: '#A3A9B6', color_border: '#2A2F3B', color_accent: '#7AA2FF', color_accent_contrast: '#0F1115' } },
      { key: 'playful', name: 'Playful', settings: { color_accent: '#FF5A5F', color_cream: '#FFF4E6', font_heading: 'Poppins', radius: 16, button_style: 'pill' } },
    ],
    templates: { home: standardHome(), product: STANDARD_PRODUCT, collection: STANDARD_COLLECTION },
  },
  {
    handle: 'atelier',
    name: 'Atelier',
    version: '1.0.0',
    description: 'Editorial and image-led, for fashion labels that want the clothes to do the talking.',
    verticals: ['fashion'],
    previewImageUrl: null,
    sortOrder: 20,
    defaults: {
      font_heading: 'Cormorant Garamond', font_body: 'Work Sans', heading_scale: 140, heading_case: 'uppercase', radius: 0,
      button_style: 'square', header_layout: 'logo_center', image_ratio: 'portrait', card_style: 'minimal', color_accent: '#111111',
    },
    presets: [
      { key: 'monochrome', name: 'Monochrome', settings: {} },
      { key: 'sand', name: 'Sand', settings: { color_background: '#F7F3EC', color_ivory: '#F2ECE2', color_cream: '#E9E0D1', color_accent: '#6B4F3A' } },
      { key: 'noir', name: 'Noir', settings: { color_background: '#0B0B0B', color_ivory: '#121212', color_cream: '#1A1A1A', color_text: '#F2F2F2', color_text_muted: '#A0A0A0', color_border: '#2B2B2B', color_accent: '#F2F2F2', color_accent_contrast: '#0B0B0B' } },
    ],
    templates: { home: standardHome({ heroHeight: 'full', heroAlign: 'center', tileColumns: 2, promisesBackground: 'none' }), product: { ...STANDARD_PRODUCT, gallery: 'stacked', size_guide: true }, collection: { ...STANDARD_COLLECTION, filters: 'drawer', columns_desktop: 3 } },
  },
  {
    handle: 'lumen',
    name: 'Lumen',
    version: '1.0.0',
    description: 'Warm, calm and precise — built for beauty, skincare and wellness brands that explain their formulas.',
    verticals: ['beauty', 'health'],
    previewImageUrl: null,
    sortOrder: 30,
    defaults: {
      font_heading: 'Fraunces', font_body: 'DM Sans', color_background: '#FBF8F3', color_ivory: '#FBF8F3', color_cream: '#F3ECE1',
      color_champagne: '#E8D9C0', color_espresso: '#2B2118', color_text: '#2B2118', color_text_muted: '#7A6A5A', color_accent: '#2B2118',
      radius: 6, button_style: 'pill', image_ratio: 'portrait',
    },
    presets: [
      { key: 'porcelain', name: 'Porcelain', settings: {} },
      { key: 'blush', name: 'Blush', settings: { color_cream: '#F8E8E4', color_champagne: '#F0D0C8', color_accent: '#9C4A4A' } },
      { key: 'botanical', name: 'Botanical', settings: { color_cream: '#EEF1E6', color_champagne: '#D8E0C8', color_accent: '#3E5B3A', color_espresso: '#1E2A1C' } },
    ],
    templates: { home: standardHome({ heroAlign: 'left' }), product: { ...STANDARD_PRODUCT, gallery: 'carousel', show_ingredients: true }, collection: STANDARD_COLLECTION },
  },
  {
    handle: 'circuit',
    name: 'Circuit',
    version: '1.0.0',
    description: 'Dense, fast and spec-forward, for electronics stores with big catalogues and comparison shoppers.',
    verticals: ['electronics'],
    previewImageUrl: null,
    sortOrder: 40,
    defaults: {
      font_heading: 'Space Grotesk', font_body: 'IBM Plex Sans', radius: 6, button_style: 'rounded', image_ratio: 'square',
      card_style: 'bordered', color_accent: '#0A66FF', color_cream: '#F4F6FA', page_width: 1440,
    },
    presets: [
      { key: 'electric', name: 'Electric', settings: {} },
      { key: 'graphite', name: 'Graphite', settings: { color_background: '#0E1116', color_ivory: '#141922', color_cream: '#1A202B', color_text: '#E8ECF2', color_text_muted: '#94A0B4', color_border: '#263042', color_accent: '#3DDC97', color_accent_contrast: '#0E1116' } },
    ],
    templates: { home: standardHome({ heroHeight: 'medium', tileColumns: 4 }), product: { ...STANDARD_PRODUCT, gallery: 'carousel', show_specs_table: true, compare: true }, collection: { ...STANDARD_COLLECTION, filters: 'sidebar', products_per_page: 36, columns_desktop: 5 } },
  },
  {
    handle: 'harvest',
    name: 'Harvest',
    version: '1.0.0',
    description: 'Friendly and quick to shop, for grocery and food stores where people buy many things at once.',
    verticals: ['grocery'],
    previewImageUrl: null,
    sortOrder: 50,
    defaults: {
      font_heading: 'Outfit', font_body: 'Nunito Sans', radius: 14, button_style: 'pill', image_ratio: 'square', card_style: 'elevated',
      color_accent: '#1F8A4C', color_cream: '#F4F8EE', color_champagne: '#FFF3D6', quick_add: true,
    },
    presets: [
      { key: 'fresh', name: 'Fresh', settings: {} },
      { key: 'market', name: 'Market', settings: { color_accent: '#D9480F', color_cream: '#FFF4E6' } },
    ],
    templates: { home: standardHome({ heroHeight: 'short', tileColumns: 4 }), product: { ...STANDARD_PRODUCT, gallery: 'carousel', show_nutrition: true }, collection: { ...STANDARD_COLLECTION, columns_desktop: 5, columns_mobile: 2 } },
  },
  {
    handle: 'hearth',
    name: 'Hearth',
    version: '1.0.0',
    description: 'Spacious and tactile, for furniture and homeware brands that sell with room settings.',
    verticals: ['home'],
    previewImageUrl: null,
    sortOrder: 60,
    defaults: {
      font_heading: 'DM Serif Display', font_body: 'Karla', radius: 4, button_style: 'square', image_ratio: 'landscape',
      color_background: '#FCFBF8', color_cream: '#F1EDE6', color_champagne: '#E4DACB', color_accent: '#5A4632',
    },
    presets: [
      { key: 'linen', name: 'Linen', settings: {} },
      { key: 'terracotta', name: 'Terracotta', settings: { color_accent: '#B5532E', color_cream: '#F6E9E1' } },
    ],
    templates: { home: standardHome({ heroHeight: 'full' }), product: { ...STANDARD_PRODUCT, gallery: 'grid', show_dimensions: true }, collection: STANDARD_COLLECTION },
  },
  {
    handle: 'gleam',
    name: 'Gleam',
    version: '1.0.0',
    description: 'Quiet luxury for jewellery and watches: generous space, fine type, close-up imagery.',
    verticals: ['jewelry'],
    previewImageUrl: null,
    sortOrder: 70,
    defaults: {
      font_heading: 'Playfair Display', font_body: 'Manrope', heading_case: 'uppercase', radius: 0, button_style: 'square',
      header_layout: 'logo_center', image_ratio: 'square', color_background: '#FFFFFF', color_cream: '#F7F4EF', color_champagne: '#EFE6D6', color_accent: '#8C6A2F',
    },
    presets: [
      { key: 'gold', name: 'Gold', settings: {} },
      { key: 'onyx', name: 'Onyx', settings: { color_background: '#0D0D0D', color_ivory: '#141414', color_cream: '#1C1C1C', color_text: '#F5F1E8', color_text_muted: '#B3AA99', color_border: '#2E2A22', color_accent: '#D4AF6A', color_accent_contrast: '#0D0D0D' } },
    ],
    templates: { home: standardHome({ heroAlign: 'center', tileColumns: 3, promisesBackground: 'none' }), product: { ...STANDARD_PRODUCT, gallery: 'stacked', zoom: true }, collection: { ...STANDARD_COLLECTION, columns_desktop: 3 } },
  },
  {
    handle: 'stride',
    name: 'Stride',
    version: '1.0.0',
    description: 'Bold and energetic, for sports, fitness and outdoor brands.',
    verticals: ['sports'],
    previewImageUrl: null,
    sortOrder: 80,
    defaults: { font_heading: 'Archivo', font_body: 'Inter', heading_case: 'uppercase', heading_scale: 150, radius: 4, button_style: 'square', color_accent: '#FF4D00', image_ratio: 'square' },
    presets: [
      { key: 'volt', name: 'Volt', settings: {} },
      { key: 'night-run', name: 'Night run', settings: { color_background: '#0A0A0A', color_ivory: '#111111', color_cream: '#181818', color_text: '#FFFFFF', color_text_muted: '#9A9A9A', color_border: '#262626', color_accent: '#D4FF3A', color_accent_contrast: '#0A0A0A' } },
    ],
    templates: { home: standardHome({ heroHeight: 'full', tileColumns: 4 }), product: STANDARD_PRODUCT, collection: STANDARD_COLLECTION },
  },
  {
    handle: 'folio',
    name: 'Folio',
    version: '1.0.0',
    description: 'Literary and calm, for bookshops and stationers.',
    verticals: ['books'],
    previewImageUrl: null,
    sortOrder: 90,
    defaults: { font_heading: 'Libre Baskerville', font_body: 'Lora', radius: 2, button_style: 'square', image_ratio: 'portrait', color_background: '#FFFDF8', color_cream: '#F5EFE3', color_accent: '#7A2E2E' },
    presets: [
      { key: 'paper', name: 'Paper', settings: {} },
      { key: 'library', name: 'Library', settings: { color_background: '#1C1A17', color_ivory: '#23201C', color_cream: '#2B2823', color_text: '#F3EDE2', color_text_muted: '#B8AE9D', color_border: '#3A352D', color_accent: '#E0B15C', color_accent_contrast: '#1C1A17' } },
    ],
    templates: { home: standardHome({ tileColumns: 4 }), product: { ...STANDARD_PRODUCT, gallery: 'single', show_details_table: true }, collection: { ...STANDARD_COLLECTION, columns_desktop: 5 } },
  },
];

export function builtInTheme(handle: string): ThemeDefinition | undefined {
  return BUILT_IN_THEMES.find((theme) => theme.handle === handle);
}
