import type { Liquid } from 'liquidjs';
import { googleFontsUrl } from '../../themes/fonts';
import { placeholderSvg } from './placeholders';
import type { RenderEnv } from './types';

/**
 * Shopify's Liquid filters, as themes use them. Money arrives in minor units
 * (cents), as on Shopify, so a price is `{{ product.price | money }}` and a
 * theme ported from Shopify needs no arithmetic changes.
 */

type Args = unknown[];

function envOf(self: unknown): RenderEnv {
  return ((self as { context: { globals: Record<string, unknown> } }).context.globals.__env) as RenderEnv;
}

/** Keyword arguments (`width: 400`) arrive as [key, value] pairs. */
function named(args: Args): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of args) if (Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string') out[arg[0]] = arg[1];
  return out;
}

function positional(args: Args): unknown[] {
  return args.filter((arg) => !(Array.isArray(arg) && arg.length === 2 && typeof arg[0] === 'string'));
}

function escapeAttr(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const formatters = new Map<string, Intl.NumberFormat>();
function formatMoney(cents: unknown, env: RenderEnv, style: 'symbol' | 'code' | 'none', trimZeros = false): string {
  const amount = Number(cents ?? 0) / 100;
  const whole = Number.isInteger(amount);
  const key = `${env.moneyLocale}|${env.currency}|${style}|${trimZeros && whole}`;
  let formatter = formatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(env.moneyLocale, {
      style: style === 'none' ? 'decimal' : 'currency',
      currency: env.currency,
      ...(style === 'none' ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : {}),
      ...(trimZeros && whole ? { minimumFractionDigits: 0, maximumFractionDigits: 0 } : {}),
    });
    formatters.set(key, formatter);
  }
  const text = formatter.format(amount);
  return style === 'code' ? `${text} ${env.currency}` : text;
}

/** An image: a drop with src/url, a media URL string, or nothing. */
function imageSrc(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === 'string') return value;
  const object = value as { src?: unknown; url?: unknown; preview_image?: { src?: unknown } };
  if (typeof object.src === 'string') return object.src;
  if (typeof object.url === 'string') return object.url;
  if (object.preview_image && typeof object.preview_image.src === 'string') return object.preview_image.src;
  return null;
}

function withSize(src: string, width?: unknown, height?: unknown): string {
  const params: string[] = [];
  if (width) params.push(`width=${Number(width)}`);
  if (height) params.push(`height=${Number(height)}`);
  if (params.length === 0) return src;
  return `${src}${src.includes('?') ? '&' : '?'}${params.join('&')}`;
}

export function handleize(value: unknown): string {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Looks up "products.product.add_to_cart" in the locale, with {{ interpolation }} and plural keys. */
export function translate(env: RenderEnv, key: string, vars: Record<string, unknown>): string {
  let node: unknown = env.translations;
  for (const part of key.split('.')) node = node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined;
  if (node && typeof node === 'object' && 'count' in vars) {
    const count = Number(vars.count);
    const forms = node as Record<string, unknown>;
    node = count === 0 && forms.zero ? forms.zero : count === 1 ? (forms.one ?? forms.other) : (forms.other ?? forms.one);
  }
  if (typeof node !== 'string') return `translation missing: ${env.locale}.${key}`;
  return node.replace(/{{\s*(\w+)\s*}}/g, (_match, name: string) => (vars[name] === undefined ? '' : String(vars[name])));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const value = match[1].length === 3 ? match[1].split('').map((c) => c + c).join('') : match[1];
  return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)];
}

export function registerFilters(engine: Liquid): void {
  engine.registerFilter('money', function (value: unknown) {
    return formatMoney(value, envOf(this), 'symbol');
  });
  engine.registerFilter('money_with_currency', function (value: unknown) {
    return formatMoney(value, envOf(this), 'code');
  });
  engine.registerFilter('money_without_currency', function (value: unknown) {
    return formatMoney(value, envOf(this), 'none');
  });
  engine.registerFilter('money_without_trailing_zeros', function (value: unknown) {
    return formatMoney(value, envOf(this), 'symbol', true);
  });

  engine.registerFilter('t', function (key: unknown, ...args: Args) {
    return translate(envOf(this), String(key), named(args));
  });

  engine.registerFilter('asset_url', function (file: unknown) {
    const env = envOf(this);
    const entry = env.theme.files.get(`assets/${String(file)}`);
    const version = entry ? entry.checksum.slice(0, 10) : String(env.theme.filesVersion);
    return `${env.assetBase}${encodeURI(String(file))}?v=${version}`;
  });
  engine.registerFilter('asset_img_url', function (file: unknown) {
    const env = envOf(this);
    return `${env.assetBase}${encodeURI(String(file))}?v=${env.theme.filesVersion}`;
  });
  engine.registerFilter('inline_asset_content', function (file: unknown) {
    return envOf(this).theme.files.get(`assets/${String(file)}`)?.content ?? '';
  });
  engine.registerFilter('stylesheet_tag', (url: unknown, ...args: Args) => {
    const preload = named(args).preload ? ' rel="preload" as="style" onload="this.rel=\'stylesheet\'"' : ' rel="stylesheet"';
    return `<link href="${escapeAttr(url)}"${preload} type="text/css" media="all">`;
  });
  engine.registerFilter('script_tag', (url: unknown) => `<script src="${escapeAttr(url)}" type="text/javascript"></script>`);
  engine.registerFilter('preload_tag', (url: unknown, ...args: Args) => `<link rel="preload" href="${escapeAttr(url)}" as="${escapeAttr(named(args).as ?? 'style')}">`);

  // ── images ────────────────────────────────────────────────────────────────
  engine.registerFilter('image_url', (value: unknown, ...args: Args) => {
    const src = imageSrc(value);
    const options = named(args);
    return src ? withSize(src, options.width, options.height) : '';
  });
  engine.registerFilter('img_url', (value: unknown, size?: unknown) => {
    const src = imageSrc(value);
    if (!src) return '';
    const match = /^(\d+)?x(\d+)?$/.exec(String(size ?? ''));
    return match ? withSize(src, match[1], match[2]) : src;
  });
  engine.registerFilter('product_img_url', (value: unknown) => imageSrc(value) ?? '');
  engine.registerFilter('image_tag', (value: unknown, ...args: Args) => {
    const options = named(args);
    const src = typeof value === 'string' ? value : imageSrc(value);
    if (!src) return '';
    const image = (typeof value === 'object' && value) ? (value as { alt?: string; width?: number; height?: number }) : {};
    const attrs: string[] = [`src="${escapeAttr(src)}"`];
    const alt = options.alt ?? image.alt ?? '';
    attrs.push(`alt="${escapeAttr(alt)}"`);
    const width = options.width ?? image.width;
    const height = options.height ?? image.height;
    if (width) attrs.push(`width="${escapeAttr(width)}"`);
    if (height) attrs.push(`height="${escapeAttr(height)}"`);
    if (options.widths) {
      const base = src.split('?')[0];
      const srcset = String(options.widths)
        .split(',')
        .map((w) => w.trim())
        .filter(Boolean)
        .map((w) => `${withSize(base, w)} ${w}w`)
        .join(', ');
      attrs.push(`srcset="${escapeAttr(srcset)}"`);
    }
    for (const key of ['sizes', 'class', 'loading', 'style', 'id', 'fetchpriority']) if (options[key] !== undefined) attrs.push(`${key}="${escapeAttr(options[key])}"`);
    if (options.loading === undefined && options.preload !== true) attrs.push('loading="lazy"');
    return `<img ${attrs.join(' ')}>`;
  });
  engine.registerFilter('placeholder_svg_tag', (name: unknown, className?: unknown) => placeholderSvg(String(name ?? 'image'), className ? String(className) : undefined));

  // ── text and urls ─────────────────────────────────────────────────────────
  engine.registerFilter('handleize', handleize);
  engine.registerFilter('handle', handleize);
  engine.registerFilter('link_to', (title: unknown, url: unknown, attrTitle?: unknown) =>
    `<a href="${escapeAttr(url)}"${attrTitle ? ` title="${escapeAttr(attrTitle)}"` : ''}>${escapeHtml(title)}</a>`,
  );
  engine.registerFilter('within', (url: unknown, collection: unknown) => {
    const handle = (collection as { handle?: string } | null)?.handle;
    return handle ? `/collections/${handle}${String(url)}` : String(url);
  });
  engine.registerFilter('url_for_type', (type: unknown) => `/collections/types?q=${encodeURIComponent(String(type ?? ''))}`);
  engine.registerFilter('url_for_vendor', (vendor: unknown) => `/collections/vendors?q=${encodeURIComponent(String(vendor ?? ''))}`);
  engine.registerFilter('url_param_escape', (value: unknown) => encodeURIComponent(String(value ?? '')));
  engine.registerFilter('pluralize', (count: unknown, singular: unknown, plural: unknown) => (Number(count) === 1 ? singular : plural));
  engine.registerFilter('highlight', (text: unknown, terms: unknown) => {
    const words = String(terms ?? '').split(/\s+/).filter(Boolean).map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return String(text ?? '');
    return String(text ?? '').replace(new RegExp(`(${words.join('|')})`, 'gi'), '<strong class="highlight">$1</strong>');
  });
  engine.registerFilter('time_tag', function (value: unknown, ...args: Args) {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return '';
    const env = envOf(this);
    const format = positional(args)[0];
    const style = format === 'date' || format === undefined ? { dateStyle: 'long' as const } : { dateStyle: 'medium' as const, timeStyle: 'short' as const };
    return `<time datetime="${date.toISOString()}">${new Intl.DateTimeFormat(env.locale, style).format(date)}</time>`;
  });
  engine.registerFilter('weight_with_unit', (grams: unknown) => {
    const value = Number(grams ?? 0);
    return value >= 1000 ? `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 2)} kg` : `${value} g`;
  });
  engine.registerFilter('default_errors', (errors: unknown) => {
    const list = Array.isArray(errors) ? errors : errors ? [errors] : [];
    return list.length ? `<ul class="form__errors">${list.map((error) => `<li>${escapeHtml(error)}</li>`).join('')}</ul>` : '';
  });
  engine.registerFilter('payment_type_svg_tag', () => '');
  engine.registerFilter('format_address', (address: unknown) => {
    const a = (address ?? {}) as Record<string, unknown>;
    return [a.name, a.address1, a.address2, [a.city, a.province, a.zip].filter(Boolean).join(' '), a.country].filter(Boolean).map(escapeHtml).join('<br>');
  });

  // ── pagination ────────────────────────────────────────────────────────────
  engine.registerFilter('default_pagination', (paginate: unknown, ...args: Args) => {
    const p = (paginate ?? {}) as { parts?: { title: unknown; url: string | null; is_link: boolean }[]; previous?: { url: string } | null; next?: { url: string } | null };
    const options = named(args);
    const parts: string[] = [];
    if (p.previous) parts.push(`<span class="prev"><a href="${escapeAttr(p.previous.url)}">${escapeHtml(options.previous ?? '« Previous')}</a></span>`);
    for (const part of p.parts ?? []) {
      parts.push(part.is_link ? `<span class="page"><a href="${escapeAttr(part.url)}">${escapeHtml(part.title)}</a></span>` : `<span class="${part.title === '…' ? 'deco' : 'page current'}">${escapeHtml(part.title)}</span>`);
    }
    if (p.next) parts.push(`<span class="next"><a href="${escapeAttr(p.next.url)}">${escapeHtml(options.next ?? 'Next »')}</a></span>`);
    return parts.join(' ');
  });
  engine.registerFilter('sort_by', function (url: unknown, sort: unknown) {
    const [path, query = ''] = String(url ?? envOf(this).requestPath).split('?');
    const params = new URLSearchParams(query);
    params.set('sort_by', String(sort));
    params.delete('page');
    return `${path}?${params.toString()}`;
  });

  // ── fonts and colours ─────────────────────────────────────────────────────
  engine.registerFilter('font_url', (font: unknown) => {
    const family = typeof font === 'string' ? font : (font as { family?: string } | null)?.family;
    return family ? googleFontsUrl([family]) : '';
  });
  engine.registerFilter('font_face', (font: unknown) => {
    const family = typeof font === 'string' ? font : (font as { family?: string } | null)?.family;
    return family ? `@import url('${googleFontsUrl([family])}');` : '';
  });
  engine.registerFilter('font_modify', (font: unknown) => font);
  engine.registerFilter('font_family', (font: unknown) => {
    const object = font as { family?: string; fallback_families?: string } | string | null;
    if (!object) return 'sans-serif';
    if (typeof object === 'string') return `"${object}", sans-serif`;
    return `"${object.family}", ${object.fallback_families ?? 'sans-serif'}`;
  });
  engine.registerFilter('color_to_rgb', (hex: unknown) => {
    const rgb = hexToRgb(String(hex ?? ''));
    return rgb ? `rgb(${rgb.join(', ')})` : String(hex ?? '');
  });
  engine.registerFilter('color_modify', (hex: unknown, property: unknown, value: unknown) => {
    const rgb = hexToRgb(String(hex ?? ''));
    if (!rgb) return String(hex ?? '');
    if (property === 'alpha') return `rgba(${rgb.join(', ')}, ${Number(value)})`;
    return String(hex);
  });
  engine.registerFilter('color_brightness', (hex: unknown) => {
    const rgb = hexToRgb(String(hex ?? ''));
    if (!rgb) return 0;
    return Math.round((rgb[0] * 299 + rgb[1] * 587 + rgb[2] * 114) / 1000);
  });
  engine.registerFilter('color_lighten', (hex: unknown, amount: unknown) => shade(String(hex ?? ''), Number(amount ?? 0)));
  engine.registerFilter('color_darken', (hex: unknown, amount: unknown) => shade(String(hex ?? ''), -Number(amount ?? 0)));

  // ── SEO ───────────────────────────────────────────────────────────────────
  engine.registerFilter('structured_data', function (value: unknown) {
    const env = envOf(this);
    const product = value as { title?: string; description?: string; featured_image?: unknown; url?: string; vendor?: string; variants?: { price: number; available: boolean; sku?: string }[] } | null;
    if (!product || !product.title) return '';
    const data = {
      '@context': 'https://schema.org',
      '@type': 'Product',
      name: product.title,
      description: String(product.description ?? '').replace(/<[^>]+>/g, '').slice(0, 5000),
      image: imageSrc(product.featured_image) ?? undefined,
      brand: product.vendor ? { '@type': 'Brand', name: product.vendor } : undefined,
      offers: (product.variants ?? []).map((variant) => ({
        '@type': 'Offer',
        price: (Number(variant.price) / 100).toFixed(2),
        priceCurrency: env.currency,
        availability: variant.available ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
        sku: variant.sku ?? undefined,
      })),
    };
    return JSON.stringify(data).replace(/</g, '\\u003c');
  });
}

function shade(hex: string, percent: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const adjust = (channel: number) => Math.max(0, Math.min(255, Math.round(channel + (percent / 100) * (percent > 0 ? 255 - channel : channel))));
  return `#${rgb.map(adjust).map((channel) => channel.toString(16).padStart(2, '0')).join('')}`;
}
