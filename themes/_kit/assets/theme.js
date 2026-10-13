/* Veylog theme kit — storefront behaviour.
   Plain JavaScript and custom elements; no framework. Everything that
   changes page content asks the server for re-rendered sections (the
   Section Rendering API), so prices, stock and translations are always
   formatted exactly as the theme's Liquid formats them. */
(function () {
  'use strict';

  var theme = window.theme || { routes: { root: '/', cart: '/cart' }, strings: {} };

  function $(selector, root) { return (root || document).querySelector(selector); }
  function $all(selector, root) { return Array.prototype.slice.call((root || document).querySelectorAll(selector)); }
  function debounce(fn, wait) { var t; return function () { var args = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, wait); }; }
  function parseHTML(html) { return new DOMParser().parseFromString(html, 'text/html'); }

  function toast(message) {
    var el = document.getElementById('Toast');
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, 3200);
  }

  function fetchJSON(url, options) {
    return fetch(url, Object.assign({ credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Accept: 'application/json' } }, options)).then(function (response) {
      return response.json().then(function (body) {
        if (!response.ok) { var error = new Error(body.description || body.message || theme.strings.cartError); error.body = body; throw error; }
        return body;
      });
    });
  }

  /* ── cart ───────────────────────────────────────────────────────────── */

  var CART_SECTIONS = ['cart-drawer', 'cart-icon-bubble'];

  function sectionsToRender() {
    var ids = CART_SECTIONS.slice();
    var page = $('[data-cart-page]');
    if (page) ids.push(page.getAttribute('data-section-id'));
    var footer = $('[data-cart-footer]');
    if (footer && footer.closest('.shopify-section')) ids.push(footer.closest('.shopify-section').id.replace('shopify-section-', ''));
    return ids;
  }

  function renderCartSections(sections) {
    document.dispatchEvent(new CustomEvent('cart:updated'));
    if (!sections) return;
    Object.keys(sections).forEach(function (id) {
      var html = sections[id];
      if (html === null || html === undefined) return;
      if (id === 'cart-icon-bubble') {
        var bubble = document.getElementById('cart-icon-bubble');
        var doc = parseHTML(html);
        var inner = doc.querySelector('.shopify-section');
        if (bubble && inner) bubble.innerHTML = inner.innerHTML;
        return;
      }
      var target = document.getElementById('shopify-section-' + id);
      if (!target) return;
      var fresh = parseHTML(html).getElementById('shopify-section-' + id);
      if (!fresh) return;
      var wasOpen = id === 'cart-drawer' && $('#CartDrawer.is-open');
      target.innerHTML = fresh.innerHTML;
      if (wasOpen) $('#CartDrawer').classList.add('is-open');
    });
  }

  var Cart = {
    add: function (formData) {
      formData.append('sections', sectionsToRender().join(','));
      formData.append('sections_url', window.location.pathname);
      return fetch(theme.routes.cart_add + '.js', { method: 'POST', body: new URLSearchParams(formData), credentials: 'same-origin', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' } })
        .then(function (response) { return response.json().then(function (body) { if (!response.ok) { throw new Error(body.description || theme.strings.cartError); } return body; }); });
    },
    change: function (line, quantity) {
      return fetchJSON(theme.routes.cart_change + '.js', { method: 'POST', body: JSON.stringify({ line: line, quantity: quantity, sections: sectionsToRender(), sections_url: window.location.pathname }) });
    }
  };

  function openCartDrawer() {
    var drawer = $('#CartDrawer');
    if (!drawer) return false;
    drawer.classList.add('is-open');
    document.body.style.overflow = 'hidden';
    var panel = $('.cart-drawer__panel', drawer);
    if (panel) panel.focus();
    return true;
  }
  function closeCartDrawer() {
    var drawer = $('#CartDrawer');
    if (!drawer) return;
    drawer.classList.remove('is-open');
    document.body.style.overflow = '';
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-cart-toggle]');
    if (toggle && theme.cartType === 'drawer' && openCartDrawer()) { event.preventDefault(); return; }
    if (event.target.closest('[data-cart-close]')) { closeCartDrawer(); return; }
    var remove = event.target.closest('[data-cart-remove]');
    if (remove) { event.preventDefault(); updateLine(remove, Number(remove.getAttribute('data-cart-remove')), 0); }
  });
  document.addEventListener('keydown', function (event) { if (event.key === 'Escape') { closeCartDrawer(); $all('details[open][data-search-modal], details[open][data-menu-drawer]').forEach(function (d) { d.removeAttribute('open'); }); } });

  function updateLine(source, line, quantity) {
    var item = source.closest('.cart-item');
    if (item) item.classList.add('is-loading');
    Cart.change(line, quantity)
      .then(function (cart) { renderCartSections(cart.sections); })
      .catch(function (error) { if (item) item.classList.remove('is-loading'); toast(error.message); });
  }

  // Product forms: add without leaving the page. "Buy it now" goes straight to checkout.
  document.addEventListener('submit', function (event) {
    var form = event.target.closest('form[data-product-form]');
    if (!form) return;
    var submitter = event.submitter;
    if (submitter && submitter.hasAttribute('data-buy-now')) return;
    event.preventDefault();
    var button = $('[data-add-button]', form) || submitter;
    if (button) { button.classList.add('is-loading'); button.setAttribute('aria-busy', 'true'); }
    var formData = new FormData(form);
    // A quantity input outside the form (form="…") is part of it already; FormData includes it.
    Cart.add(formData)
      .then(function (response) {
        renderCartSections(response.sections);
        if (theme.cartType === 'drawer' && openCartDrawer()) return;
        if (theme.cartType === 'page') { window.location.href = theme.routes.cart; return; }
        toast(theme.strings.added);
      })
      .catch(function (error) { toast(error.message); })
      .finally(function () { if (button) { button.classList.remove('is-loading'); button.removeAttribute('aria-busy'); } });
  });

  /* ── quantity inputs ────────────────────────────────────────────────── */

  var lineChange = debounce(function (input) {
    var line = Number(input.getAttribute('data-line'));
    if (line) updateLine(input, line, Math.max(0, Number(input.value) || 0));
  }, 350);

  document.addEventListener('click', function (event) {
    var step = event.target.closest('[data-quantity-step]');
    if (!step) return;
    var wrapper = step.closest('[data-quantity]');
    var input = $('input', wrapper);
    var min = Number(input.min || 0);
    var next = Math.max(min, (Number(input.value) || 0) + Number(step.getAttribute('data-quantity-step')));
    if (input.max && next > Number(input.max)) next = Number(input.max);
    input.value = next;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  document.addEventListener('change', function (event) {
    var input = event.target.closest('.quantity__input[data-line]');
    if (input) lineChange(input);
  });

  /* ── variant picker ─────────────────────────────────────────────────── */

  function initVariantPicker(picker) {
    var jsonEl = $('[data-product-json]', picker);
    if (!jsonEl) return;
    var product;
    try { product = JSON.parse(jsonEl.textContent); } catch (e) { return; }
    var section = picker.closest('[data-product-section]');
    var sectionId = picker.getAttribute('data-section');

    function selectedOptions() {
      var values = [];
      $all('fieldset', picker).forEach(function (group) {
        var checked = $('input:checked', group);
        values.push(checked ? checked.value : null);
      });
      $all('select[data-option-index]', picker).forEach(function (select) { values[Number(select.getAttribute('data-option-index'))] = select.value; });
      return values;
    }

    function markUnavailable(values) {
      // A value is crossed out when no available variant has it together with the other choices.
      $all('input[data-option-index]', picker).forEach(function (input) {
        var index = Number(input.getAttribute('data-option-index'));
        var candidate = values.slice(); candidate[index] = input.value;
        var available = product.variants.some(function (variant) {
          return variant.available && variant.options.every(function (value, i) { return i === index ? value === input.value : candidate[i] === null || value === candidate[i]; });
        });
        var label = picker.querySelector('label[for="' + input.id + '"]');
        if (label) label.classList.toggle('is-unavailable', !available);
      });
    }

    function onChange() {
      var values = selectedOptions();
      $all('fieldset', picker).forEach(function (group, i) { var label = $('[data-selected-value]', group); if (label) label.textContent = values[i] || ''; });
      markUnavailable(values);
      var variant = product.variants.find(function (candidate) { return candidate.options.every(function (value, i) { return value === values[i]; }); });
      var idInput = section && $('[data-variant-id]', section);
      var addButton = section && $('[data-add-button]', section);
      if (!variant) {
        if (addButton) { addButton.disabled = true; addButton.textContent = theme.strings.unavailable; }
        return;
      }
      if (idInput) idInput.value = variant.id;
      var url = new URL(window.location.href);
      url.searchParams.set('variant', variant.id);
      window.history.replaceState({}, '', url.toString());
      if (variant.featured_image && section) showMedia(section, variant.featured_image.src);
      // Price, stock and buttons re-rendered by the server for this variant.
      fetch(section.getAttribute('data-product-url') + '?variant=' + variant.id + '&section_id=' + encodeURIComponent(sectionId), { credentials: 'same-origin' })
        .then(function (response) { return response.text(); })
        .then(function (html) {
          var doc = parseHTML(html);
          ['price', 'inventory', 'buttons', 'sku'].forEach(function (key) {
            var fresh = doc.querySelector('[data-dynamic="' + key + '"]');
            var current = section.querySelector('[data-dynamic="' + key + '"]');
            if (fresh && current) current.innerHTML = fresh.innerHTML;
          });
        })
        .catch(function () { /* the add-to-cart id is already right; the price text just stays */ });
    }

    picker.addEventListener('change', onChange);
    markUnavailable(selectedOptions());
  }

  function showMedia(section, src) {
    var base = src.split('?')[0];
    var items = $all('[data-media-src]', section);
    items.forEach(function (item, index) {
      var match = item.getAttribute('data-media-src').split('?')[0] === base;
      item.classList.toggle('is-active', match);
      if (match) {
        var list = item.parentElement;
        list.scrollTo({ left: item.offsetLeft - list.offsetLeft, behavior: 'smooth' });
        $all('[data-thumb]', section).forEach(function (thumb) { thumb.classList.toggle('is-active', Number(thumb.getAttribute('data-thumb')) === index); });
      }
    });
  }

  document.addEventListener('click', function (event) {
    var thumb = event.target.closest('[data-thumb]');
    if (!thumb) return;
    var gallery = thumb.closest('[data-gallery]');
    var item = $all('[data-media-src]', gallery)[Number(thumb.getAttribute('data-thumb'))];
    if (item) showMedia(gallery, item.getAttribute('data-media-src'));
  });

  /* ── sliders and slideshows ─────────────────────────────────────────── */

  function initSlider(root) {
    var track = $('[data-slider-track]', root);
    if (!track || track.__slider) return;
    track.__slider = true;
    var prev = $('[data-slider-prev]', root);
    var next = $('[data-slider-next]', root);
    var dots = $all('[data-slider-dot]', root);
    function page() { return Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); }
    function step() { var first = track.firstElementChild; return first ? first.getBoundingClientRect().width + parseFloat(getComputedStyle(track).columnGap || 0) : track.clientWidth; }
    function update() {
      if (prev) prev.disabled = track.scrollLeft <= 2;
      if (next) next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
      dots.forEach(function (dot, i) { dot.classList.toggle('is-active', i === page()); });
    }
    if (prev) prev.addEventListener('click', function () { track.scrollBy({ left: -step(), behavior: 'smooth' }); });
    if (next) next.addEventListener('click', function () { track.scrollBy({ left: step(), behavior: 'smooth' }); });
    dots.forEach(function (dot) { dot.addEventListener('click', function () { track.scrollTo({ left: Number(dot.getAttribute('data-slider-dot')) * track.clientWidth, behavior: 'smooth' }); }); });
    track.addEventListener('scroll', debounce(update, 60));
    update();
    if (root.getAttribute('data-autoplay') === 'true' && !window.Shopify.designMode) {
      var speed = Number(root.getAttribute('data-speed') || 5) * 1000;
      var timer = setInterval(function () {
        if (document.hidden || root.matches(':hover')) return;
        var atEnd = track.scrollLeft + track.clientWidth >= track.scrollWidth - 2;
        track.scrollTo({ left: atEnd ? 0 : track.scrollLeft + track.clientWidth, behavior: 'smooth' });
      }, speed);
      root.__timer = timer;
    }
  }

  /* ── announcement bar ─────────────────────────────────────────────────
     Rotating lines (fade, slide, slide up, typewriter, none) or a ticker;
     arrows, pause, close; countdowns; a free-shipping line that follows the
     cart; views and clicks counted only with analytics consent. */

  var reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var abQueue = [];
  var abFlushTimer = null;

  function abAnalyticsAllowed() {
    var privacy = window.Shopify && window.Shopify.customerPrivacy;
    return Boolean(privacy && privacy.analyticsProcessingAllowed && privacy.analyticsProcessingAllowed());
  }

  function abFlush() {
    abFlushTimer = null;
    if (!abQueue.length) return;
    var body = JSON.stringify({ events: abQueue.splice(0, 20) });
    try {
      if (navigator.sendBeacon && navigator.sendBeacon('/announcements/track', new Blob([body], { type: 'application/json' }))) return;
    } catch (e) {}
    fetch('/announcements/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body, keepalive: true, credentials: 'same-origin' }).catch(function () {});
  }

  function abTrack(bar, line, event) {
    if (!bar.hasAttribute('data-track') || !line || !line.getAttribute('data-line-id') || !abAnalyticsAllowed()) return;
    var id = Number(line.getAttribute('data-line-id'));
    if (event === 'view') {
      var key = 'vl-ab-seen:' + id;
      try { if (sessionStorage.getItem(key)) return; sessionStorage.setItem(key, '1'); } catch (e) {}
    }
    abQueue.push({ id: id, event: event });
    if (!abFlushTimer) abFlushTimer = setTimeout(abFlush, 1500);
  }
  window.addEventListener('pagehide', abFlush);

  function abMoney(cents) {
    try {
      return new Intl.NumberFormat(theme.locale || undefined, { style: 'currency', currency: theme.currency || 'INR', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
    } catch (e) {
      return (cents / 100).toFixed(2);
    }
  }

  function abPad(n) { return (n < 10 ? '0' : '') + n; }

  function initAnnouncementBar(bar) {
    if (bar.__ab) { bar.__ab.destroy(); }
    var track = $('.vl-ab__track', bar);
    var lines = $all('.vl-ab__line', bar);
    if (!track || !lines.length) return;
    var strings = (bar.getAttribute('data-strings') || '').split('|');
    var mode = bar.getAttribute('data-mode');
    var transition = reduceMotion ? 'none' : bar.getAttribute('data-transition');
    var autoplay = bar.getAttribute('data-autoplay') === 'true' && !reduceMotion;
    var interval = Math.max(3, Number(bar.getAttribute('data-interval') || 5)) * 1000;
    var index = 0;
    var timer = null;
    var ticker = null;
    var paused = false;
    var hovering = false;
    var typing = null;

    function candidates() { return lines.filter(function (line) { return !line.hasAttribute('data-expired') && getComputedStyle(line).display !== 'none'; }); }

    function paint(line) {
      // The bar takes the showing line's own colours, if it has them.
      if (line.getAttribute('data-bg')) bar.style.setProperty('--ab-line-bg', line.getAttribute('data-bg')); else bar.style.removeProperty('--ab-line-bg');
      if (line.getAttribute('data-fg')) bar.style.setProperty('--ab-line-fg', line.getAttribute('data-fg')); else bar.style.removeProperty('--ab-line-fg');
    }

    function type(line) {
      if (typing) { clearInterval(typing.timer); typing.el.textContent = typing.full; typing.el.classList.remove('vl-ab__typed'); typing = null; }
      if (transition !== 'typewriter') return;
      var el = $('.vl-ab__text', line);
      if (!el) return;
      var full = el.textContent;
      var shown = 0;
      el.setAttribute('aria-label', full);
      el.classList.add('vl-ab__typed');
      el.textContent = '';
      typing = { el: el, full: full, timer: setInterval(function () {
        shown += 1;
        el.textContent = full.slice(0, shown);
        if (shown >= full.length) { clearInterval(typing.timer); el.classList.remove('vl-ab__typed'); typing = null; }
      }, Math.max(18, Math.min(60, 1400 / Math.max(full.length, 1)))) };
    }

    function show(next, direction) {
      var list = candidates();
      if (!list.length) return;
      var current = lines[index];
      var target = typeof next === 'number' ? lines[next] : next;
      if (!target || target === current && current.classList.contains('is-active')) return;
      bar.style.setProperty('--ab-dir', direction < 0 ? '-1' : '1');
      lines.forEach(function (line) { line.classList.remove('is-leaving'); });
      if (current && current !== target) {
        current.classList.remove('is-active');
        current.classList.add('is-leaving');
        current.setAttribute('aria-hidden', 'true');
        $all('a, button', current).forEach(function (el) { el.setAttribute('tabindex', '-1'); });
        setTimeout(function () { current.classList.remove('is-leaving'); }, 650);
      }
      target.classList.add('is-active');
      target.removeAttribute('aria-hidden');
      $all('a, button', target).forEach(function (el) { el.removeAttribute('tabindex'); });
      index = lines.indexOf(target);
      paint(target);
      type(target);
      abTrack(bar, target, 'view');
    }

    function step(direction) {
      var list = candidates();
      if (list.length < 2) return;
      var at = list.indexOf(lines[index]);
      var next = list[(at + direction + list.length) % list.length];
      show(next, direction);
    }

    function stop() { clearInterval(timer); timer = null; }
    function start() {
      stop();
      if (mode !== 'rotate' || !autoplay || paused || hovering || candidates().length < 2) return;
      timer = setInterval(function () { if (!document.hidden) step(1); }, interval);
    }

    // ── the ticker: two copies side by side, sliding by one copy's width ──
    function buildTicker() {
      if (mode !== 'marquee') return;
      $all('[data-clone]', track).forEach(function (clone) { clone.remove(); });
      var originals = lines.slice();
      var width = track.scrollWidth;
      var viewport = $('.vl-ab__viewport', bar).clientWidth || bar.clientWidth;
      // Enough copies that one set is at least as wide as the bar, then that set doubled.
      var copies = Math.max(1, Math.ceil(viewport / Math.max(width, 1)));
      for (var c = 1; c < copies * 2; c++) {
        originals.forEach(function (line) {
          var clone = line.cloneNode(true);
          clone.setAttribute('data-clone', '');
          clone.setAttribute('aria-hidden', 'true');
          $all('a, button', clone).forEach(function (el) { el.setAttribute('tabindex', '-1'); });
          track.appendChild(clone);
        });
      }
      var speed = Math.max(10, Number(bar.getAttribute('data-speed') || 60));
      bar.style.setProperty('--ab-duration', (track.scrollWidth / 2 / speed).toFixed(2) + 's');
      originals.forEach(function (line) { abTrack(bar, line, 'view'); });
    }

    // ── countdowns: tick every second; an ended line leaves the rotation ──
    function tick() {
      var now = Date.now();
      $all('[data-ab-countdown]', bar).forEach(function (el) {
        var end = Date.parse(el.getAttribute('data-ab-countdown'));
        var left = Math.floor((end - now) / 1000);
        var line = el.closest('.vl-ab__line');
        if (!(left > 0)) {
          if (line && !line.hasAttribute('data-expired')) {
            line.setAttribute('data-expired', '');
            line.hidden = true;
            if (line.classList.contains('is-active')) step(1);
            if (!candidates().length) bar.hidden = true;
          }
          return;
        }
        var d = Math.floor(left / 86400), h = Math.floor(left % 86400 / 3600), m = Math.floor(left % 3600 / 60), sec = left % 60;
        el.textContent = (strings[0] || 'Ends in') + ' ' + (d ? d + 'd ' : '') + abPad(h) + ':' + abPad(m) + ':' + abPad(sec);
      });
    }

    // ── free shipping: what is left to spend, from the cart ──
    function freeShipping() {
      var progress = $all('[data-free-shipping]', bar);
      if (!progress.length) return;
      fetch((theme.routes.root || '/').replace(/\/?$/, '/') + 'cart.js', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
        .then(function (response) { return response.json(); })
        .then(function (cart) {
          var subtotal = Number(cart.items_subtotal_price || 0);
          progress.forEach(function (line) {
            var threshold = Number(line.getAttribute('data-free-shipping')) || 0;
            var left = Math.max(0, threshold - subtotal);
            var text = $('.vl-ab__text', line);
            if (text) text.textContent = left > 0 || !line.getAttribute('data-success')
              ? line.getAttribute('data-template').replace('{amount}', abMoney(left > 0 ? left : threshold))
              : line.getAttribute('data-success');
            line.style.setProperty('--ab-progress', (threshold ? Math.min(100, subtotal / threshold * 100) : 0).toFixed(1) + '%');
          });
        })
        .catch(function () {});
    }

    function onClick(event) {
      var copy = event.target.closest('[data-ab-copy]');
      if (copy) {
        var code = copy.getAttribute('data-ab-copy');
        var done = function () { toast(strings[1] || 'Copied'); };
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done, done); else done();
        abTrack(bar, copy.closest('.vl-ab__line'), 'click');
        return;
      }
      if (event.target.closest('[data-ab-click]')) abTrack(bar, event.target.closest('.vl-ab__line'), 'click');
      if (event.target.closest('[data-ab-prev]')) { stop(); step(-1); start(); }
      if (event.target.closest('[data-ab-next]')) { stop(); step(1); start(); }
      var pause = event.target.closest('[data-ab-pause]');
      if (pause) {
        paused = !paused;
        bar.classList.toggle('is-paused', paused);
        pause.setAttribute('aria-pressed', String(paused));
        pause.setAttribute('aria-label', paused ? strings[3] || 'Play' : strings[2] || 'Pause');
        if (paused) stop(); else start();
      }
      if (event.target.closest('[data-ab-close]')) {
        var days = Number(bar.getAttribute('data-dismiss-days') || 0);
        var key = 'vl-ab:' + bar.getAttribute('data-version');
        try {
          if (days > 0) localStorage.setItem(key, String(Date.now() + days * 86400000));
          else sessionStorage.setItem(key, '1');
        } catch (e) {}
        bar.hidden = true;
        destroy();
      }
    }

    function onKey(event) {
      if (mode !== 'rotate') return;
      if (event.key === 'ArrowRight') { stop(); step(1); start(); }
      if (event.key === 'ArrowLeft') { stop(); step(-1); start(); }
    }
    function onEnter() { if (bar.classList.contains('vl-ab--hover-pause')) { hovering = true; stop(); } }
    function onLeave() { hovering = false; start(); }
    // Keyboard focus pauses (WCAG 2.2.2); a mouse click on an arrow must not stop it for good.
    function onFocusIn(event) { var el = event.target; try { if (!el.matches(':focus-visible')) return; } catch (e) {} hovering = true; stop(); }
    function onFocusOut(event) { if (!bar.contains(event.relatedTarget)) { hovering = false; start(); } }
    function onCart() { freeShipping(); }
    var resizeTimer = null;
    function onResize() { clearTimeout(resizeTimer); resizeTimer = setTimeout(buildTicker, 200); }

    function destroy() {
      stop();
      clearInterval(ticker);
      bar.removeEventListener('click', onClick);
      bar.removeEventListener('keydown', onKey);
      bar.removeEventListener('mouseenter', onEnter);
      bar.removeEventListener('mouseleave', onLeave);
      bar.removeEventListener('focusin', onFocusIn);
      bar.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('cart:updated', onCart);
      window.removeEventListener('resize', onResize);
      bar.__ab = null;
    }

    bar.addEventListener('click', onClick);
    bar.addEventListener('keydown', onKey);
    bar.addEventListener('mouseenter', onEnter);
    bar.addEventListener('mouseleave', onLeave);
    bar.addEventListener('focusin', onFocusIn);
    bar.addEventListener('focusout', onFocusOut);
    document.addEventListener('cart:updated', onCart);

    if (bar.hidden) return;
    if (mode === 'marquee') {
      buildTicker();
      window.addEventListener('resize', onResize);
    } else {
      // The first line that is visible on this device starts the rotation.
      var first = candidates()[0];
      if (first && first !== lines[0]) show(first, 1); else if (first) { paint(first); type(first); abTrack(bar, first, 'view'); }
      start();
    }
    if ($('[data-ab-countdown]', bar)) { tick(); ticker = setInterval(tick, 1000); }
    freeShipping();
    bar.__ab = { destroy: destroy, show: function (i) { stop(); show(i, 1); } };
  }

  /* ── header ─────────────────────────────────────────────────────────── */

  function initHeader() {
    var wrapper = $('sticky-header');
    if (!wrapper) return;
    var section = wrapper.closest('.shopify-section');
    var mode = wrapper.getAttribute('data-sticky');
    var setHeights = function () {
      var rect = wrapper.getBoundingClientRect();
      document.documentElement.style.setProperty('--header-height', rect.height + 'px');
      document.documentElement.style.setProperty('--header-bottom', Math.max(0, rect.bottom) + 'px');
    };
    setHeights();
    window.addEventListener('resize', debounce(setHeights, 100));
    if (!section || mode === 'none') return;
    section.classList.add('is-sticky');
    var last = window.scrollY;
    window.addEventListener('scroll', function () {
      var y = window.scrollY;
      section.classList.toggle('is-scrolled', y > 10);
      if (mode === 'on-scroll-up') section.classList.toggle('is-hidden', y > last && y > 240 && !$('details[open]', section));
      last = y;
      setHeights();
    }, { passive: true });
  }

  // Dropdown menus open on hover on desktop, and close when another opens.
  document.addEventListener('mouseover', function (event) {
    var menu = event.target.closest('[data-hover-menu]');
    if (!menu || window.matchMedia('(hover: none)').matches) return;
    $all('[data-hover-menu][open]').forEach(function (other) { if (other !== menu) other.removeAttribute('open'); });
    menu.setAttribute('open', '');
  });
  document.addEventListener('mouseout', function (event) {
    var menu = event.target.closest('[data-hover-menu]');
    if (!menu || window.matchMedia('(hover: none)').matches) return;
    if (!menu.contains(event.relatedTarget)) menu.removeAttribute('open');
  });
  document.addEventListener('click', function (event) {
    $all('details[open][data-hover-menu], details[open][data-facet]').forEach(function (details) { if (!details.contains(event.target)) details.removeAttribute('open'); });
    if (event.target.closest('[data-close-details]')) { var d = event.target.closest('details'); if (d) d.removeAttribute('open'); }
  });
  document.addEventListener('toggle', function (event) {
    var details = event.target;
    if (details.matches && details.matches('[data-menu-drawer]')) document.body.style.overflow = details.open ? 'hidden' : '';
    if (details.matches && details.matches('[data-search-modal]') && details.open) { var input = $('input[type="search"]', details); if (input) setTimeout(function () { input.focus(); }, 30); }
  }, true);

  /* ── predictive search ──────────────────────────────────────────────── */

  function initPredictiveSearch(input) {
    var results = input.closest('form').querySelector('[data-predictive-results]');
    if (!results) return;
    var controller;
    var search = debounce(function () {
      var terms = input.value.trim();
      if (terms.length < 2) { results.hidden = true; results.innerHTML = ''; return; }
      if (controller) controller.abort();
      controller = new AbortController();
      fetch(theme.routes.predictive_search + '?q=' + encodeURIComponent(terms) + '&section_id=predictive-search', { signal: controller.signal, credentials: 'same-origin' })
        .then(function (response) { return response.text(); })
        .then(function (html) {
          var inner = parseHTML(html).querySelector('#predictive-search-results');
          results.innerHTML = inner ? inner.outerHTML : '';
          results.hidden = !inner;
        })
        .catch(function () {});
    }, 220);
    input.addEventListener('input', search);
    input.addEventListener('focus', function () { if (results.innerHTML) results.hidden = false; });
  }

  /* ── forms that submit themselves ───────────────────────────────────── */

  document.addEventListener('change', function (event) {
    var select = event.target.closest('[data-autosubmit]');
    if (!select) return;
    var form = select.closest('form');
    if (!form) return;
    if (form.hasAttribute('data-facets-form')) {
      var url = new URL(form.action, window.location.origin);
      new FormData(form).forEach(function (value, key) { if (value !== '') url.searchParams.set(key, value); });
      window.location.href = url.pathname + url.search;
      return;
    }
    form.submit();
  });

  /* ── deferred media (video) and share ───────────────────────────────── */

  document.addEventListener('click', function (event) {
    var poster = event.target.closest('[data-load-media]');
    if (poster) {
      var media = poster.closest('deferred-media');
      var template = $('template', media);
      if (template) { media.appendChild(template.content.cloneNode(true)); poster.remove(); }
      return;
    }
    var share = event.target.closest('share-button .share-button__button');
    if (share) {
      var root = share.closest('share-button');
      var data = { url: root.getAttribute('data-url'), title: root.getAttribute('data-title') };
      if (navigator.share) { navigator.share(data).catch(function () {}); return; }
      navigator.clipboard.writeText(data.url).then(function () { var note = $('.share-button__copied', root); if (note) { note.hidden = false; setTimeout(function () { note.hidden = true; }, 2500); } });
    }
  });

  /* ── tabs and countdowns (used by several themes' own sections) ───────── */

  document.addEventListener('click', function (event) {
    var tab = event.target.closest('[data-tab]');
    if (!tab) return;
    var root = tab.closest('[data-tabs]');
    var index = tab.getAttribute('data-tab');
    $all('[data-tab]', root).forEach(function (t) { var on = t === tab; t.classList.toggle('is-active', on); t.setAttribute('aria-selected', on ? 'true' : 'false'); });
    $all('[data-panel]', root).forEach(function (panel) { panel.hidden = panel.getAttribute('data-panel') !== index; });
  });

  function initCountdown(root) {
    var end = new Date(root.getAttribute('data-end')).getTime();
    if (!end || isNaN(end) || root.__timer) return;
    var units = {}; $all('[data-unit]', root).forEach(function (el) { units[el.getAttribute('data-unit')] = el; });
    function pad(n) { return (n < 10 ? '0' : '') + n; }
    function tick() {
      var left = Math.max(0, end - Date.now());
      var s = Math.floor(left / 1000);
      if (units.days) units.days.textContent = pad(Math.floor(s / 86400));
      if (units.hours) units.hours.textContent = pad(Math.floor((s % 86400) / 3600));
      if (units.minutes) units.minutes.textContent = pad(Math.floor((s % 3600) / 60));
      if (units.seconds) units.seconds.textContent = pad(s % 60);
      if (left === 0) {
        clearInterval(root.__timer);
        if (root.getAttribute('data-hide-when-done') === 'true' && !(window.Shopify && window.Shopify.designMode)) root.closest('.shopify-section').hidden = true;
      }
    }
    tick();
    root.__timer = setInterval(tick, 1000);
  }

  /* ── reveal on scroll ───────────────────────────────────────────────── */

  var revealer = 'IntersectionObserver' in window ? new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) { if (entry.isIntersecting) { entry.target.classList.add('is-revealed'); revealer.unobserve(entry.target); } });
  }, { rootMargin: '0px 0px -8% 0px' }) : null;

  function initReveal(root) {
    $all('[data-reveal]', root).forEach(function (el) { if (revealer && !(window.Shopify && window.Shopify.designMode)) revealer.observe(el); else el.classList.add('is-revealed'); });
  }

  /* ── start, and restart a section the theme editor re-rendered ──────── */

  function init(root) {
    $all('variant-picker', root).forEach(initVariantPicker);
    $all('slider-component, slide-show', root).forEach(initSlider);
    $all('[data-announcement-bar]', root).forEach(initAnnouncementBar);
    $all('[data-predictive-search]', root).forEach(initPredictiveSearch);
    $all('count-down', root).forEach(initCountdown);
    initReveal(root);
  }

  document.addEventListener('DOMContentLoaded', function () { initHeader(); init(document); });
  document.addEventListener('shopify:section:load', function (event) { init(event.target); if (event.target.querySelector('sticky-header')) initHeader(); });
  document.addEventListener('shopify:section:select', function (event) {
    if (event.target.querySelector('#CartDrawer')) openCartDrawer();
  });
  document.addEventListener('shopify:section:deselect', function (event) {
    if (event.target.querySelector('#CartDrawer')) closeCartDrawer();
  });
  document.addEventListener('shopify:block:select', function (event) {
    var abLine = event.target.closest && event.target.closest('.vl-ab__line');
    var abBar = abLine && abLine.closest('[data-announcement-bar]');
    if (abBar && abBar.__ab) abBar.__ab.show($all('.vl-ab__line', abBar).indexOf(abLine));
    var slide = event.target.closest('[data-slide]');
    if (slide) { var track = slide.parentElement; track.scrollTo({ left: slide.offsetLeft - track.offsetLeft, behavior: 'smooth' }); }
  });

  window.theme.cart = Cart;
  window.theme.openCartDrawer = openCartDrawer;
})();
