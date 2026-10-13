/**
 * Staff are trusted with HTML — policies, pages, product descriptions, rich
 * text fields — but the platform renders it on the shop's own origin, so what
 * could run is taken out: scripts, frames, embedded objects, forms, inline
 * event handlers and script URLs. Headings, lists, links, tables, images and
 * emphasis pass.
 */
export function sanitizeMerchantHtml(html: string): string {
  return html
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    .replace(/<\s*(script|style|iframe|object|embed|form|input|button|textarea|select|link|meta|base)\b[^>]*\/?>/gi, '')
    .replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/(href|src|action|formaction|xlink:href)\s*=\s*("|')\s*(javascript|vbscript|data):[^"']*\2/gi, '$1="#"')
    .replace(/(href|src)\s*=\s*(javascript|vbscript|data):[^\s>]*/gi, '$1="#"')
    .trim();
}
