/* sokoni-food-public-menu.js — a real restaurant's PUBLISHED menu on the buyer Food page (Food Hub Gate 2, 2026-10-03).
 *
 * food-menu.html?shop=<shopId> asks the server — foodMenu {op:'public'} — and renders exactly what it returns:
 *   - only a shop that passes the one shop discovery gate AND holds an approved food workspace;
 *   - only published, listed items, with the server's availability (a sold-out dish says so);
 *   - real names, prices, sizes and photos from the canonical products — no demo restaurant, no fallback menu.
 * ORDERING IS NOT OPEN (Gate 3): there is no cart, no add button and no payment here, and the page says so. Anything
 * other than a real menu (no shop, not public, not a food business, offline) leaves the page's "Ordering opens soon"
 * message untouched. Every server string is escaped.
 */
(function () {
  'use strict';
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var kes = function (n) { return typeof n === 'number' && isFinite(n) ? 'KES ' + n.toLocaleString('en-KE', { maximumFractionDigits: 2 }) : '—'; };
  var safeImg = function (u) { return /^https:\/\/[^\s"'<>]+$/.test(String(u || '')) ? String(u) : null; };
  var SOLD = { out_of_stock: 'Sold out', unavailable: 'Not available' };

  function render(d) {
    var body = document.getElementById('menuBody'); if (!body) return 'no-body';
    var title = document.getElementById('pageTitle');
    if (title) title.textContent = d.shop && d.shop.name ? d.shop.name : 'Food Hub';
    if (d.shop && d.shop.name) document.title = d.shop.name + ' — SOKONI Food';
    var bySec = {};
    (d.items || []).forEach(function (it) { (bySec[it.sectionId] = bySec[it.sectionId] || []).push(it); });
    var h = '<div class="food-opening-soon" style="max-width:720px;margin:16px auto;padding:14px 16px;background:rgba(249,115,22,0.06);border:1px solid rgba(249,115,22,0.22);border-radius:16px;font-size:13px;color:rgba(255,255,255,0.7);line-height:1.5">' +
      '<b style="color:#fff">Ordering opens soon.</b> This is ' + esc(d.shop && d.shop.name) + '\'s real menu. Food orders and payments are not open on SOKONI yet.</div>';
    var secs = (d.sections || []).filter(function (s) { return (bySec[s.id] || []).length; });
    if (!secs.length) {
      h += '<div style="max-width:720px;margin:24px auto;text-align:center;color:rgba(255,255,255,0.5);font-size:13px">This restaurant has not published its menu yet.</div>';
    }
    secs.forEach(function (s) {
      h += '<section style="max-width:720px;margin:18px auto 0;padding:0 14px"><h2 style="font-size:15px;font-weight:900;color:#fff;margin:0 0 10px">' + esc(s.name) + '</h2>';
      bySec[s.id].sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); }).forEach(function (it) {
        var img = safeImg(it.image);
        var sold = it.sellable === false ? (SOLD[it.availability] || 'Not available') : '';
        h += '<div style="display:flex;gap:12px;padding:12px;margin-bottom:8px;border-radius:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08)">' +
          (img ? '<img src="' + esc(img) + '" alt="" loading="lazy" style="width:72px;height:72px;border-radius:10px;object-fit:cover;flex:0 0 72px">' : '') +
          '<div style="min-width:0;flex:1"><div style="font-weight:800;color:#fff;font-size:14px">' + esc(it.name) + '</div>' +
          (it.description ? '<div style="font-size:12px;color:rgba(255,255,255,0.55);margin:3px 0">' + esc(it.description) + '</div>' : '') +
          '<div style="font-size:13px;font-weight:800;color:#f97316">' + esc(kes(it.price)) +
          ((it.variants || []).length ? '<span style="font-weight:600;color:rgba(255,255,255,0.55)"> · ' + it.variants.map(function (v) { return esc(v.name) + ' ' + esc(kes(v.price)); }).join(' · ') + '</span>' : '') + '</div>' +
          (sold ? '<div style="margin-top:6px;display:inline-block;font-size:11px;font-weight:800;padding:3px 8px;border-radius:999px;border:1px solid rgba(255,82,82,.4);color:#ff6b6b">' + esc(sold) + '</div>' : '') +
          '</div></div>';
      });
      h += '</section>';
    });
    body.innerHTML = h;
    return 'menu';
  }

  function waitCallable(ms) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        if (typeof window.sokoniCallable === 'function') return resolve(window.sokoniCallable);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(poll, 100);
      })();
    });
  }

  /** Returns what happened: 'no-shop' | 'unreachable' | 'not-available' | 'menu'. Exposed for tests. */
  function show(shopId) {
    if (!shopId || !/^[A-Za-z0-9_-]{1,128}$/.test(shopId)) return Promise.resolve('no-shop');
    return waitCallable(10000).then(function (mk) {
      if (!mk) return 'unreachable';
      return mk('foodMenu')({ op: 'public', shopId: shopId }).then(function (r) {
        var d = r && r.data;
        if (!d || d.ok !== true || d.available !== true) return 'not-available';
        return render(d);
      }, function () { return 'unreachable'; });
    });
  }

  window.SokoniFoodPublicMenu = { show: show, _render: render, _esc: esc };
  try {
    var sid = new URLSearchParams(window.location.search).get('shop');
    if (sid) show(sid);
  } catch (_) {}
})();
