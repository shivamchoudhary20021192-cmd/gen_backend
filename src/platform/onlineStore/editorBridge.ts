import { env } from '../../config/env';

/**
 * Runs inside the theme editor's preview (design mode). It does for the
 * editor what Shopify's does:
 *
 *   - outlines the section or block under the pointer and names it;
 *   - clicking one tells the editor to open its settings;
 *   - the editor sends back re-rendered sections, which replace the old ones
 *     in place (no reload, the page keeps its scroll position);
 *   - theme JavaScript gets the standard editor events —
 *     shopify:section:load / unload / select / deselect / reorder,
 *     shopify:block:select / deselect — so sliders re-initialise, drawers
 *     open when selected, and so on.
 *
 * Messages are only accepted from the parent window at the admin's origin.
 */

/**
 * Outside production, an admin served from any local port may use the editor:
 * dev servers move between ports, and PLATFORM_ADMIN_URL rarely follows them.
 */
const LOCAL_ADMIN = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const source = (adminOrigins: string[], allowLocal: boolean) => `(function(){
if (window.__veylogEditor) return; window.__veylogEditor = true;
var ADMINS = ${JSON.stringify(adminOrigins)};
var LOCAL = ${allowLocal ? String(LOCAL_ADMIN) : 'null'};
function isAdmin(o){ return ADMINS.indexOf(o) >= 0 || (LOCAL !== null && LOCAL.test(o)); }
var parentWin = window.parent;
// The frame's parent: ancestorOrigins survives navigation inside the preview; the referrer does not.
var ADMIN = (function(){
  var a = location.ancestorOrigins && location.ancestorOrigins[0]; if (a && isAdmin(a)) return a;
  try { var o = new URL(document.referrer).origin; if (isAdmin(o)) return o; } catch (e) {}
  return ADMINS[0];
})();
function send(msg){ try { parentWin.postMessage(Object.assign({ source: 'veylog-preview' }, msg), ADMIN); } catch (e) {} }
function info(el, attr){ try { return JSON.parse(el.getAttribute(attr)); } catch (e) { return null; } }
function fire(el, name, detail){ el.dispatchEvent(new CustomEvent(name, { bubbles: true, detail: detail })); }
var style = document.createElement('style');
style.textContent = '[data-veylog-hover]{outline:2px solid #2c6ecb!important;outline-offset:-2px;position:relative}'
 + '[data-veylog-selected]{outline:2px solid #2c6ecb!important;outline-offset:-2px}'
 + '#veylog-editor-label{position:fixed;z-index:2147483647;background:#2c6ecb;color:#fff;font:600 12px/1 system-ui,sans-serif;padding:5px 8px;border-radius:4px 4px 0 0;pointer-events:none;display:none}';
document.documentElement.appendChild(style);
var label = document.createElement('div'); label.id = 'veylog-editor-label';
document.addEventListener('DOMContentLoaded', function(){ document.body.appendChild(label); send({ type: 'ready', path: location.pathname + location.search, template: (window.Shopify && window.Shopify.template) || null }); });
var hovered = null, selected = null;
function target(node){
  var block = node.closest && node.closest('[data-shopify-editor-block]');
  var section = node.closest && node.closest('[data-shopify-editor-section]');
  return { block: block, section: section };
}
document.addEventListener('mouseover', function(e){
  var t = target(e.target); var el = t.block || t.section;
  if (hovered === el) return;
  if (hovered) hovered.removeAttribute('data-veylog-hover');
  hovered = el;
  if (!el) { label.style.display = 'none'; return; }
  el.setAttribute('data-veylog-hover', '');
  var sec = t.section ? info(t.section, 'data-shopify-editor-section') : null;
  var blk = t.block ? info(t.block, 'data-shopify-editor-block') : null;
  label.textContent = blk ? (blk.type) : (sec ? sec.name : '');
  var r = el.getBoundingClientRect();
  label.style.display = 'block'; label.style.left = Math.max(0, r.left) + 'px'; label.style.top = Math.max(0, r.top - 22) + 'px';
}, true);
document.addEventListener('click', function(e){
  var t = target(e.target);
  if (!t.section) return;
  var link = e.target.closest && e.target.closest('a[href]');
  var sec = info(t.section, 'data-shopify-editor-section');
  var blk = t.block ? info(t.block, 'data-shopify-editor-block') : null;
  if (!link) { send({ type: 'select', section: sec && sec.id, block: blk && blk.id }); }
}, true);
// Links keep the preview in design mode. The editor frame is often on another
// site than the admin, where cookies are not sent — so the preview key rides
// in every same-origin link and GET form rather than in a cookie.
var KEY = (function(){ try { return new URL(location.href).searchParams.get('preview_key'); } catch (e) { return null; } })();
function keep(root){
  if (!KEY) return;
  (root.querySelectorAll ? root : document).querySelectorAll('a[href]').forEach(function(a){
    var url; try { url = new URL(a.getAttribute('href'), location.href); } catch (e) { return; }
    if (url.origin !== location.origin || url.searchParams.has('preview_key') || /^#/.test(a.getAttribute('href'))) return;
    url.searchParams.set('preview_key', KEY); a.setAttribute('href', url.pathname + url.search + url.hash);
  });
  (root.querySelectorAll ? root : document).querySelectorAll('form[method="get"], form:not([method])').forEach(function(f){
    if (f.querySelector('input[name="preview_key"]')) return;
    var input = document.createElement('input'); input.type = 'hidden'; input.name = 'preview_key'; input.value = KEY; f.appendChild(input);
  });
}
document.addEventListener('DOMContentLoaded', function(){
  keep(document);
  new MutationObserver(function(list){ list.forEach(function(m){ m.addedNodes.forEach(function(n){ if (n.nodeType === 1) keep(n); }); }); }).observe(document.body, { childList: true, subtree: true });
});
document.addEventListener('click', function(e){
  var a = e.target.closest && e.target.closest('a[href]');
  if (!a || a.target === '_blank') return;
  var url; try { url = new URL(a.href, location.href); } catch (err) { return; }
  if (url.origin !== location.origin) { e.preventDefault(); return; }
  send({ type: 'navigate', path: url.pathname + url.search });
});
function findSection(id){
  var all = document.querySelectorAll('[data-shopify-editor-section]');
  for (var i = 0; i < all.length; i++) { var d = info(all[i], 'data-shopify-editor-section'); if (d && d.id === id) return all[i]; }
  return null;
}
function select(el){
  if (selected) { selected.removeAttribute('data-veylog-selected'); }
  selected = el; if (el) { el.setAttribute('data-veylog-selected', ''); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
}
window.addEventListener('message', function(e){
  if (e.source !== parentWin || !isAdmin(e.origin)) return;
  var m = e.data || {}; if (m.source !== 'veylog-editor') return;
  if (m.type === 'section:replace') {
    var old = findSection(m.id);
    if (!old) { send({ type: 'reload-needed' }); return; }
    fire(old, 'shopify:section:unload', { sectionId: m.id });
    var box = document.createElement('div'); box.innerHTML = m.html; var fresh = box.firstElementChild;
    if (!fresh) { old.remove(); return; }
    old.replaceWith(fresh);
    // Scripts in re-rendered HTML do not run by themselves.
    fresh.querySelectorAll('script').forEach(function(s){ var n = document.createElement('script'); for (var i = 0; i < s.attributes.length; i++) n.setAttribute(s.attributes[i].name, s.attributes[i].value); n.textContent = s.textContent; s.replaceWith(n); });
    fire(fresh, 'shopify:section:load', { sectionId: m.id });
    if (m.select) select(fresh);
  } else if (m.type === 'section:select') {
    var el = findSection(m.id); if (!el) return;
    fire(el, 'shopify:section:select', { sectionId: m.id, load: false }); select(el);
  } else if (m.type === 'section:deselect') {
    var d = findSection(m.id); if (d) fire(d, 'shopify:section:deselect', { sectionId: m.id }); select(null);
  } else if (m.type === 'block:select') {
    var s = findSection(m.section); if (!s) return;
    var blocks = s.querySelectorAll('[data-shopify-editor-block]');
    for (var i = 0; i < blocks.length; i++) { var b = info(blocks[i], 'data-shopify-editor-block'); if (b && b.id === m.block) { fire(blocks[i], 'shopify:block:select', { sectionId: m.section, blockId: m.block, load: false }); select(blocks[i]); return; } }
  } else if (m.type === 'sections:reorder') {
    var first = m.order.map(findSection).filter(Boolean);
    if (first.length < 2) return;
    var parent = first[0].parentNode, anchor = first[0];
    var placeholder = document.createComment('reorder'); parent.insertBefore(placeholder, anchor);
    first.forEach(function(node){ parent.insertBefore(node, placeholder); });
    placeholder.remove();
    fire(document, 'shopify:section:reorder', {});
  } else if (m.type === 'sections:refresh') {
    // The editor saved a draft: re-render just those sections, from this page's own URL.
    var ids = (m.ids || []).slice(0, 5); if (!ids.length) return;
    var url = location.pathname + location.search + (location.search ? '&' : '?') + 'sections=' + encodeURIComponent(ids.join(','));
    fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }).then(function(r){ return r.json(); }).then(function(map){
      ids.forEach(function(id){
        var html = map[id]; var old = findSection(id);
        if (html === null || html === undefined) { if (old) old.remove(); return; }
        if (!old) { location.reload(); return; }
        fire(old, 'shopify:section:unload', { sectionId: id });
        var box = document.createElement('div'); box.innerHTML = html; var fresh = box.firstElementChild;
        if (!fresh) { old.remove(); return; }
        old.replaceWith(fresh);
        fresh.querySelectorAll('script').forEach(function(s){ var n = document.createElement('script'); for (var i = 0; i < s.attributes.length; i++) n.setAttribute(s.attributes[i].name, s.attributes[i].value); n.textContent = s.textContent; s.replaceWith(n); });
        fire(fresh, 'shopify:section:load', { sectionId: id });
        if (m.select === id) select(fresh);
      });
      send({ type: 'refreshed', ids: ids });
    }).catch(function(){ location.reload(); });
  } else if (m.type === 'reload') {
    location.reload();
  }
});
})();`;

function origins(): string[] {
  const list = [env.platform.adminUrl, ...env.corsOrigins]
    .map((url) => {
      try {
        return new URL(url).origin;
      } catch {
        return null;
      }
    })
    .filter((origin): origin is string => Boolean(origin));
  return [...new Set(list)];
}

/** The admin origins the preview may talk to: the platform admin, and CORS_ORIGINS. */
export const editorBridgeScript = source(origins(), !env.isProd);

/** CSP frame-ancestors sources for the design-mode preview — the same admins as the bridge. */
export function previewFrameAncestors(): string[] {
  return [...origins(), ...(env.isProd ? [] : ['http://localhost:*', 'http://127.0.0.1:*'])];
}
