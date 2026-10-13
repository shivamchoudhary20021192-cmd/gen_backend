import { Hash, RenderTag, Tag, TypeGuards, evalToken, type Context, type Emitter, type Liquid, type Parser, type TagToken, type Template, type TopLevelToken, type ValueToken } from 'liquidjs';
import type { RenderEnv } from './types';

/**
 * Shopify's theme tags, on top of standard Liquid:
 *
 *   {% schema %}…{% endschema %}         a section's settings (read by the editor, never output)
 *   {% style %}…{% endstyle %}           Liquid-rendered CSS the editor can live-update
 *   {% stylesheet %} / {% javascript %}  a section's static CSS / JS
 *   {% form 'product', product %}        the <form> for a cart add, contact, newsletter, localization
 *   {% paginate collection.products by 12 %}   one page of a list, with a `paginate` object
 *   {% section 'name' %} / {% sections 'group' %}   static sections and section groups
 *   {% layout none %}                    a template choosing another (or no) layout
 */

function envOf(ctx: Context): RenderEnv {
  return (ctx.globals as Record<string, unknown>).__env as RenderEnv;
}

function collectUntil(end: string, tagToken: TagToken, remainTokens: TopLevelToken[]): TopLevelToken[] {
  const tokens: TopLevelToken[] = [];
  while (remainTokens.length) {
    const token = remainTokens.shift()!;
    if (TypeGuards.isTagToken(token) && token.name === end) return tokens;
    tokens.push(token);
  }
  throw new Error(`tag ${tagToken.getText()} not closed`);
}

function parseUntil(end: string, tagToken: TagToken, remainTokens: TopLevelToken[], parser: Parser): Template[] {
  const templates: Template[] = [];
  while (remainTokens.length) {
    const token = remainTokens.shift()!;
    if (TypeGuards.isTagToken(token) && token.name === end) return templates;
    templates.push(parser.parseToken(token, remainTokens));
  }
  throw new Error(`tag ${tagToken.getText()} not closed`);
}

class SchemaTag extends Tag {
  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(tagToken, remainTokens, liquid);
    collectUntil('endschema', tagToken, remainTokens);
  }
  render(): string {
    return '';
  }
}

class RawBodyTag extends Tag {
  private readonly body: string;
  constructor(
    tagToken: TagToken,
    remainTokens: TopLevelToken[],
    liquid: Liquid,
    private readonly wrap: 'style' | 'script',
  ) {
    super(tagToken, remainTokens, liquid);
    this.body = collectUntil(`end${tagToken.name}`, tagToken, remainTokens)
      .map((token) => token.getText())
      .join('');
  }
  render(): string {
    const body = this.body.trim();
    if (!body) return '';
    return this.wrap === 'style' ? `<style>${body}</style>` : `<script>${body}</script>`;
  }
}

class StyleTag extends Tag {
  private readonly templates: Template[];
  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(tagToken, remainTokens, liquid);
    this.templates = parseUntil('endstyle', tagToken, remainTokens, parser);
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const css = (yield this.liquid.renderer.renderTemplates(this.templates, ctx)) as string;
    emitter.write(`<style data-veylog>${css}</style>`);
  }
}

const FORM_ACTIONS: Record<string, string> = {
  product: '/cart/add',
  cart: '/cart',
  contact: '/contact',
  customer: '/contact#contact_form',
  localization: '/localization',
  storefront_password: '/password',
  new_comment: '/blogs/comments',
  customer_login: '/account/login',
  create_customer: '/account',
  recover_customer_password: '/account/recover',
  customer_address: '/account/addresses',
  customer_profile: '/account/profile',
};

class FormTag extends Tag {
  private readonly typeToken: ValueToken;
  private readonly objectToken: ValueToken | undefined;
  private readonly hash: Hash;
  private readonly templates: Template[];

  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(tagToken, remainTokens, liquid);
    const tokenizer = this.tokenizer;
    const type = tokenizer.readValue();
    if (!type) throw new Error(`illegal tag: ${tagToken.getText()}`);
    this.typeToken = type;
    tokenizer.skipBlank();
    if (tokenizer.peek() === ',') tokenizer.advance();
    // An optional object (`product`) before the named arguments.
    const save = tokenizer.p;
    tokenizer.skipBlank();
    const candidate = tokenizer.readValue();
    tokenizer.skipBlank();
    if (candidate && tokenizer.peek() !== ':') {
      this.objectToken = candidate;
      if (tokenizer.peek() === ',') tokenizer.advance();
    } else {
      tokenizer.p = save;
    }
    this.hash = new Hash(tokenizer, liquid.options.keyValueSeparator);
    this.templates = parseUntil('endform', tagToken, remainTokens, parser);
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const env = envOf(ctx);
    const type = String(yield evalToken(this.typeToken, ctx));
    const object = this.objectToken ? yield evalToken(this.objectToken, ctx) : undefined;
    const args = (yield this.hash.render(ctx)) as Record<string, unknown>;
    let action = FORM_ACTIONS[type] ?? '/';
    // {% form 'customer_address', address %} edits that address; with customer.new_address it adds one.
    const addressId = type === 'customer_address' && object && typeof object === 'object' ? (object as { id?: unknown }).id : null;
    if (addressId) action = `/account/addresses/${encodeURIComponent(String(addressId))}`;
    // {% form 'new_comment', article %} posts to that article's comments.
    if (type === 'new_comment' && object && typeof object === 'object' && typeof (object as { url?: unknown }).url === 'string') {
      action = `${(object as { url: string }).url}/comments#comment_form`;
      if (!args.id) args.id = 'comment_form';
    }
    const attrs: string[] = [`method="post"`, `action="${action}"`, 'accept-charset="UTF-8"'];
    for (const [key, value] of Object.entries(args)) {
      if (value === undefined || value === null || key === 'return_to') continue;
      const name = key.replace(/_/g, '-').replace(/^data-/, 'data-');
      attrs.push(`${name === 'class' || name === 'id' || name.startsWith('data-') || name === 'novalidate' ? name : key}="${String(value).replace(/"/g, '&quot;')}"`);
    }
    // URL-encoded (not multipart): the cart endpoints read plain form fields.
    if (type === 'product') attrs.push('data-type="add-to-cart-form"');
    const hidden = [`<input type="hidden" name="form_type" value="${type}">`, '<input type="hidden" name="utf8" value="✓">'];
    if (args.return_to) hidden.push(`<input type="hidden" name="return_to" value="${String(args.return_to).replace(/"/g, '&quot;')}">`);
    // As on Shopify, the theme adds the variant `id` input itself; the object only names the form.
    if (type === 'product' && object && typeof object === 'object') {
      const handle = (object as { handle?: string }).handle;
      if (handle) attrs.push(`data-product-handle="${String(handle).replace(/"/g, '&quot;')}"`);
    }
    if (type === 'localization') hidden.push(`<input type="hidden" name="_method" value="put">`, `<input type="hidden" name="return_to" value="${env.requestPath.replace(/"/g, '&quot;')}">`);
    let result = env.forms[type] ?? { posted_successfully: false, errors: null };
    let fields: Record<string, unknown> = {};
    if (type === 'customer_address') {
      // The address being edited fills the form; a failed save's errors belong only to the form it came from.
      if (object && typeof object === 'object') {
        const address = object as Record<string, unknown>;
        fields = Object.fromEntries(['first_name', 'last_name', 'company', 'address1', 'address2', 'city', 'province', 'province_code', 'zip', 'country', 'country_code', 'phone', 'default'].map((key) => [key, address[key] ?? '']));
      }
      if ('address_id' in result && (result.address_id ?? null) !== (addressId ?? null)) result = { posted_successfully: false, errors: null };
    }
    ctx.push({ form: { ...fields, ...result, posted_successfully: result.posted_successfully, 'posted_successfully?': result.posted_successfully, errors: result.errors, id: args.id ?? addressId ?? null } });
    const inner = (yield this.liquid.renderer.renderTemplates(this.templates, ctx)) as string;
    ctx.pop();
    emitter.write(`<form ${attrs.join(' ')}>${hidden.join('')}${inner}</form>`);
  }
}

interface Paginatable {
  paginateProperty?: (property: string, pageSize: number, page: number) => Promise<{ items: unknown[]; total: number }>;
}

function pageUrl(env: RenderEnv, page: number): string {
  const params = new URLSearchParams(env.requestQuery);
  if (page <= 1) params.delete('page');
  else params.set('page', String(page));
  const query = params.toString();
  return `${env.requestPath}${query ? `?${query}` : ''}`;
}

/** The `paginate` object: pages 1 … 4 5 [6] 7 8 … 20. */
function paginateObject(env: RenderEnv, total: number, pageSize: number, page: number) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pages);
  const window = 2;
  const parts: { title: string | number; url: string | null; is_link: boolean }[] = [];
  let lastShown = 0;
  for (let i = 1; i <= pages; i++) {
    if (i === 1 || i === pages || Math.abs(i - current) <= window) {
      if (lastShown && i - lastShown > 1) parts.push({ title: '…', url: null, is_link: false });
      parts.push({ title: i, url: i === current ? null : pageUrl(env, i), is_link: i !== current });
      lastShown = i;
    }
  }
  return {
    current_page: current,
    current_offset: (current - 1) * pageSize,
    items: total,
    page_size: pageSize,
    pages,
    previous: current > 1 ? { title: '« Previous', url: pageUrl(env, current - 1), is_link: true } : null,
    next: current < pages ? { title: 'Next »', url: pageUrl(env, current + 1), is_link: true } : null,
    parts,
  };
}

class PaginateTag extends Tag {
  private readonly path: string[];
  private readonly sizeToken: ValueToken;
  private readonly templates: Template[];

  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid, parser: Parser) {
    super(tagToken, remainTokens, liquid);
    const tokenizer = this.tokenizer;
    const target = tokenizer.readValue();
    tokenizer.skipBlank();
    const by = tokenizer.readIdentifier();
    tokenizer.skipBlank();
    const size = tokenizer.readValue();
    if (!target || by.content !== 'by' || !size) throw new Error(`illegal tag: ${tagToken.getText()}`);
    this.path = target.getText().trim().split('.');
    this.sizeToken = size;
    this.templates = parseUntil('endpaginate', tagToken, remainTokens, parser);
  }

  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const env = envOf(ctx);
    const pageSize = Math.min(250, Math.max(1, Number(yield evalToken(this.sizeToken, ctx)) || 12));
    const page = env.currentPage;
    const property = this.path[this.path.length - 1];
    const basePath = this.path.slice(0, -1);
    const scope: Record<string, unknown> = {};
    let total = 0;

    if (basePath.length === 0) {
      // {% paginate collections by 12 %}: the value itself is the list.
      const value = (yield ctx._get([property])) as unknown;
      const list = Array.isArray(value) ? value : ((yield (value as { all?: unknown })?.all) as unknown[] | undefined) ?? [];
      total = list.length;
      scope[property] = list.slice((page - 1) * pageSize, page * pageSize);
    } else {
      const base = (yield ctx._get(basePath)) as Paginatable | Record<string, unknown> | null;
      if (base && typeof (base as Paginatable).paginateProperty === 'function') {
        const result = (yield (base as Paginatable).paginateProperty!(property, pageSize, page)) as { items: unknown[]; total: number };
        total = result.total;
        const shadow = Object.create(base as object) as Record<string, unknown>;
        Object.defineProperty(shadow, property, { value: result.items, enumerable: true });
        scope[basePath[0]] = basePath.length === 1 ? shadow : base;
      } else if (base) {
        const list = ((yield (base as Record<string, unknown>)[property]) as unknown[]) ?? [];
        total = list.length;
        const shadow = Object.create(base as object) as Record<string, unknown>;
        Object.defineProperty(shadow, property, { value: list.slice((page - 1) * pageSize, page * pageSize), enumerable: true });
        scope[basePath[0]] = basePath.length === 1 ? shadow : base;
      }
    }

    scope.paginate = paginateObject(env, total, pageSize, page);
    ctx.push(scope);
    const html = (yield this.liquid.renderer.renderTemplates(this.templates, ctx)) as string;
    ctx.pop();
    emitter.write(html);
  }
}

class SectionTag extends Tag {
  private readonly nameToken: ValueToken;
  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(tagToken, remainTokens, liquid);
    const name = this.tokenizer.readValue();
    if (!name) throw new Error(`illegal tag: ${tagToken.getText()}`);
    this.nameToken = name;
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const env = envOf(ctx);
    const name = String(yield evalToken(this.nameToken, ctx));
    // A static section keeps its settings in settings_data.json (current.sections).
    const html = (yield env.renderSection(name, name, undefined, undefined, undefined)) as string;
    emitter.write(html);
  }
}

class SectionsTag extends Tag {
  private readonly nameToken: ValueToken;
  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(tagToken, remainTokens, liquid);
    const name = this.tokenizer.readValue();
    if (!name) throw new Error(`illegal tag: ${tagToken.getText()}`);
    this.nameToken = name;
  }
  *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const env = envOf(ctx);
    const name = String(yield evalToken(this.nameToken, ctx));
    emitter.write((yield env.renderGroup(name)) as string);
  }
}

class LayoutTag extends Tag {
  private readonly valueToken: ValueToken | undefined;
  private readonly none: boolean;
  constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
    super(tagToken, remainTokens, liquid);
    this.tokenizer.skipBlank();
    const rest = this.tokenizer.remaining().trim();
    this.none = rest === 'none';
    this.valueToken = this.none ? undefined : this.tokenizer.readValue();
  }
  *render(ctx: Context): Generator<unknown, string, unknown> {
    const env = envOf(ctx);
    env.state.layout = this.none ? false : String(yield evalToken(this.valueToken!, ctx));
    return '';
  }
}

/**
 * {% render 'snippet' %} as usual — and {% render block %} for an app block,
 * which is how a section hands an "@app" block to the app that made it.
 */
class AppAwareRenderTag extends RenderTag {
  override *render(ctx: Context, emitter: Emitter): Generator<unknown, void, unknown> {
    const file = (this as unknown as { file?: unknown }).file;
    if (file && typeof file === 'object' && !Array.isArray(file) && typeof (file as ValueToken).getText === 'function') {
      const value = (yield evalToken(file as ValueToken, ctx)) as Record<string, unknown> | null;
      if (value && typeof value === 'object' && '__app_block' in value) {
        const env = envOf(ctx);
        emitter.write(env.renderAppBlock ? ((yield env.renderAppBlock(value)) as string) : '');
        return;
      }
    }
    yield* super.render(ctx, emitter) as Generator<unknown, void, unknown>;
  }
}

export function registerTags(engine: Liquid): void {
  engine.registerTag('render', AppAwareRenderTag);
  engine.registerTag('schema', SchemaTag);
  engine.registerTag('style', StyleTag);
  engine.registerTag(
    'stylesheet',
    class extends RawBodyTag {
      constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
        super(tagToken, remainTokens, liquid, 'style');
      }
    },
  );
  engine.registerTag(
    'javascript',
    class extends RawBodyTag {
      constructor(tagToken: TagToken, remainTokens: TopLevelToken[], liquid: Liquid) {
        super(tagToken, remainTokens, liquid, 'script');
      }
    },
  );
  engine.registerTag('form', FormTag);
  engine.registerTag('paginate', PaginateTag);
  engine.registerTag('section', SectionTag);
  engine.registerTag('sections', SectionsTag);
  engine.registerTag('layout', LayoutTag);
}
