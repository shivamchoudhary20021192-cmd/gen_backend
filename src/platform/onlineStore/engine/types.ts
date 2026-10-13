/** What the Liquid engine renders with. */

export interface ThemeFileEntry {
  content: string | null;
  contentType: string;
  storageKey: string | null;
  checksum: string;
}

/** An installed theme's files, as one render sees them (drafts laid over when previewing). */
export interface LoadedTheme {
  /** Theme ids are unique per database pod, so caches key on the shop too. */
  shopId: number;
  id: number;
  publicId: string;
  name: string;
  role: 'main' | 'unpublished' | 'development';
  libraryHandle: string;
  filesVersion: number;
  /** Set when unsaved editor changes are laid over the files. */
  draftStamp: string | null;
  files: Map<string, ThemeFileEntry>;
}

/** Per request: what filters and tags need beyond the template's own variables. */
export interface RenderEnv {
  theme: LoadedTheme;
  /** The shopper's currency and how to write money in it. */
  currency: string;
  moneyLocale: string;
  shopCurrency: string;
  locale: string;
  translations: Record<string, unknown>;
  /** "/cdn/shop/t/<id>/assets/" (with the version appended per file). */
  assetBase: string;
  /** The theme editor is showing this page. */
  designMode: boolean;
  /** ?page= for {% paginate %}. */
  currentPage: number;
  /** The path and query of this request, for pagination and sort links. */
  requestPath: string;
  requestQuery: URLSearchParams;
  /** The template being rendered: "product", "collection.alternate"… */
  templateName: string;
  /** Written to by {% layout %}; read by the renderer after the template. */
  state: { layout: string | false | null; stylesheets: string[]; scripts: string[] };
  /** Form results posted back: { contact: { posted_successfully, errors } }, plus any state a form shows (the sign-in step…). */
  forms: Record<string, { posted_successfully: boolean; errors: string[] | null; [key: string]: unknown }>;
  /** The loader the section tags use to render a section by type. */
  renderSection: (type: string, id: string, settings: Record<string, unknown> | undefined, blocks: Record<string, unknown> | undefined, blockOrder: string[] | undefined, extra?: { group?: string }) => Promise<string>;
  renderGroup: (name: string) => Promise<string>;
  /** {% render block %} for an app block (a theme app extension's block). */
  renderAppBlock?: (block: Record<string, unknown>) => Promise<string>;
}
