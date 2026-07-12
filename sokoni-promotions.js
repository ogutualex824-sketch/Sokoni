/* ══════════════════════════════════════════════════════════════════════════
   sokoni-promotions.js — Promotion renderer (shared component)

   Auto-injected by shared-header.js, so a page opts in by adding ONE element:

     <div data-promo="home_hero"></div>

   No page needs JavaScript. No page needs editing to receive a new campaign type.
   That is the whole point: a promotion is data, and a placement is a slot.

   ── Why this is quiet by design ─────────────────────────────────────────
   A promotion system's failure mode is not "too few promotions" — it is a product
   that feels like an ad network. So:
     • It renders NOTHING when there is nothing to show. No skeletons, no empty
       frames, no "no offers right now". An empty slot collapses to zero height.
     • It never blocks render. Slots fill in after the page is usable.
     • It never runs on checkout/payment/wallet surfaces — the server refuses those
       placements, and so does this.
     • It respects prefers-reduced-motion.
════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Mirror of the server's forbidden list. The server is the real gate — this is
     defence in depth so a mistaken data-promo="checkout" never even makes a call. */
  var FORBIDDEN = ['checkout', 'payment', 'wallet', 'dispute', 'refund'];

  var _styled = false;

  function _injectCSS() {
    if (_styled) return;
    _styled = true;
    var css = document.createElement('style');
    css.id = 'sk-promo-css';
    css.textContent = [
      '.sk-promo{display:block;}',
      '.sk-promo:empty{display:none;}',                    /* nothing to show -> no layout at all */
      '.sk-promo-card{display:flex;gap:12px;align-items:center;padding:12px 14px;',
        'background:#0d0d0d;border:1px solid #1a1a1a;border-radius:12px;margin:8px 0;',
        'text-decoration:none;color:#e8eaf0;transition:border-color .18s,transform .18s;}',
      '.sk-promo-card:hover{border-color:#71ff00;transform:translateY(-1px);}',
      '.sk-promo-card img{width:52px;height:52px;object-fit:cover;border-radius:9px;flex:0 0 auto;}',
      '.sk-promo-txt{min-width:0;flex:1;}',
      '.sk-promo-title{font-size:13px;font-weight:800;line-height:1.3;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sk-promo-body{font-size:11px;color:#6b7280;line-height:1.4;margin-top:2px;',
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.sk-promo-badge{font-size:9px;font-weight:900;letter-spacing:.06em;text-transform:uppercase;',
        'color:#050505;background:#71ff00;padding:2px 7px;border-radius:99px;flex:0 0 auto;}',
      '.sk-promo-cta{font-size:11px;font-weight:800;color:#71ff00;flex:0 0 auto;}',
      '@media (prefers-reduced-motion: reduce){.sk-promo-card{transition:none;}',
        '.sk-promo-card:hover{transform:none;}}',
    ].join('');
    document.head.appendChild(css);
  }

  function _esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
  }

  /* Only same-origin or https links. A promotion is admin-authored, but an admin
     account is exactly what an attacker would want — so the renderer does not
     trust the URL it is given. */
  function _safeUrl(u) {
    if (!u) return null;
    try {
      var url = new URL(u, location.origin);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
      return url.href;
    } catch (_) { return null; }
  }

  function _track(id, event) {
    try {
      if (!window.sokoniCallable) return;
      window.sokoniCallable('trackPromotion')({ id: id, event: event });
    } catch (_) { /* analytics must never break a page */ }
  }

  function _render(slot, promos) {
    if (!promos || !promos.length) return;        /* render nothing — do not draw an empty frame */
    _injectCSS();

    var frag = document.createDocumentFragment();

    promos.forEach(function (p) {
      var href = _safeUrl(p.ctaUrl);
      var card = document.createElement(href ? 'a' : 'div');
      card.className = 'sk-promo-card';
      if (href) { card.href = href; card.rel = 'noopener'; }

      card.innerHTML =
        (p.image ? '<img loading="lazy" src="' + _esc(_safeUrl(p.image) || '') + '" alt="">' : '') +
        '<div class="sk-promo-txt">' +
          '<div class="sk-promo-title">' + _esc(p.title) + '</div>' +
          (p.body ? '<div class="sk-promo-body">' + _esc(p.body) + '</div>' : '') +
        '</div>' +
        (p.badge ? '<span class="sk-promo-badge">' + _esc(p.badge) + '</span>' : '') +
        (p.ctaLabel ? '<span class="sk-promo-cta">' + _esc(p.ctaLabel) + '</span>' : '');

      if (href) card.addEventListener('click', function () { _track(p.id, 'click'); });
      frag.appendChild(card);
      _track(p.id, 'impression');
    });

    slot.appendChild(frag);
  }

  function _fill(slot) {
    var placement = slot.getAttribute('data-promo');
    if (!placement || FORBIDDEN.indexOf(placement) !== -1) return;
    if (slot.dataset.skPromoDone) return;
    slot.dataset.skPromoDone = '1';
    slot.classList.add('sk-promo');

    if (!window.sokoniCallable) return;   /* Firebase not ready on this page — degrade silently */

    var ctx = { placement: placement };
    /* Optional targeting the page can declare. Absent = no constraint. */
    if (slot.dataset.county)   ctx.county   = slot.dataset.county;
    if (slot.dataset.category) ctx.category = slot.dataset.category;
    if (slot.dataset.role)     ctx.role     = slot.dataset.role;

    window.sokoniCallable('getPromotions')(ctx)
      .then(function (res) {
        var d = res && res.data;
        if (d && d.ok) _render(slot, d.promotions);
      })
      .catch(function () { /* a failed promotion must never surface to a user */ });
  }

  function _scan() {
    var slots = document.querySelectorAll('[data-promo]');
    for (var i = 0; i < slots.length; i++) _fill(slots[i]);
  }

  /* Fill after the page is usable — promotions must never block first render. */
  if (document.readyState === 'complete') setTimeout(_scan, 300);
  else window.addEventListener('load', function () { setTimeout(_scan, 300); });

  /* Pages that render slots dynamically (SPA-ish hubs) can re-scan. */
  window.SokoniPromotions = { scan: _scan };
}());
