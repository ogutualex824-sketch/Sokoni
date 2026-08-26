/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI MERCHANT — FLASH SALE (native, replacing the framed seller.html#flash)
   ══════════════════════════════════════════════════════════════════════════════
   The second of the three routes still mounting the legacy application, and the
   one where the conversion is a real repair rather than a port.

   What it replaces wrote `localStorage.sokoniFlashSales` and called nothing. A
   merchant pressed "Launch Flash Sale", was told it was live, and no buyer ever
   saw a discounted price — the sale existed only on that device. Meanwhile a
   complete, validated flash-sale engine has been sitting in
   functions/marketing-engine.js the whole time.

   ── THE AUTHORITY IS THE SERVER, AND IT ALREADY EXISTS ──────────────────────
       create   commerceDispatch { op: 'createFlashSale' }
                validates the window, the prices and the stock limit, derives
                `discountPct` and `status` ITSELF, and writes mktFlashSales.
       read     mktFlashSales — `allow read: if isAuthed()`, scoped here to the
                merchant's own sales.
       end      concludeExpiredFlashSales, a deployed scheduled function.

   Nothing here duplicates any of it. In particular:

     · NO PRICING MATH. The merchant types the sale price; the server computes
       the discount. A percentage box would mean this file deciding what 30% of
       a price is, and a second answer to that question is how two figures for
       one sale appear.
     · NO WRITE. mktFlashSales is `allow write: if false` — Cloud Functions only.
     · NO ENTITLEMENT LOGIC. Whether a plan permits flash sales is the
       subscription authority's question, and this surface does not ask a second
       one or model the answer.
     · NO STOCK WRITE. `stockLimit` is how many units the SALE may sell; it is
       not an inventory adjustment, and Inventory remains the only stock writer.

   Products come from SokoniMerchantData.listProducts — the ONE product reader
   the whole workspace uses.

   Contract: mount(host, ctx) -> { refresh, destroy }
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantFlash = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-flash-css';
  var HOST_CLASS = 'sk-mflash';
  var CSS = [
    '.sk-mflash{padding:14px 12px 96px}',
    '.fl-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px}',
    '.fl-h{font-size:19px;font-weight:800;letter-spacing:-.01em}',
    '.fl-count{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55))}',
    '.fl-sub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:14px;line-height:1.6}',
    '.fl-new{min-height:44px;border-radius:12px;padding:0 16px;cursor:pointer;font:inherit;font-weight:800;',
    'font-size:13px;background:var(--acc,#71ff00);color:#050505;border:0;white-space:nowrap;margin-bottom:14px}',
    '.fl-list{display:flex;flex-direction:column;gap:9px}',
    '.fl-row{padding:12px 13px;border-radius:13px;min-width:0;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.fl-nm{font-size:13.5px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.fl-px{display:flex;align-items:baseline;gap:9px;margin-top:5px;flex-wrap:wrap}',
    '.fl-sale{font-size:15px;font-weight:800;color:var(--acc,#71ff00)}',
    '.fl-was{font-size:12px;color:var(--txt2,rgba(255,255,255,.45));text-decoration:line-through}',
    '.fl-off{font-size:11.5px;font-weight:800;padding:2px 8px;border-radius:8px;',
    'background:rgba(113,255,0,.12);color:var(--acc,#71ff00)}',
    '.fl-m{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.5));margin-top:6px;line-height:1.6}',
    '.fl-tag{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:8px;',
    'border:1px solid var(--line,rgba(255,255,255,.14));margin-right:6px}',
    '.fl-tag.live{color:#71ff00;border-color:rgba(113,255,0,.4)}',
    '.fl-tag.soon{color:#ffb020;border-color:rgba(255,176,32,.4)}',
    '.fl-tag.done{color:var(--txt2,rgba(255,255,255,.4))}',
    '.fl-state{padding:30px 18px;text-align:center;color:var(--txt2,rgba(255,255,255,.6));font-size:13.5px;line-height:1.7}',
    '.fl-hero{padding:18px 2px 14px}',
    '.fl-hero-t{font-size:26px;font-weight:900;letter-spacing:-.02em}',
    '.fl-hero-s{font-size:12.5px;color:var(--txt3,#8b8b8b);margin-top:6px;line-height:1.6}',
    '.fl-hero-live{display:inline-flex;align-items:center;gap:10px;margin-top:12px;padding:8px 14px;',
      'border-radius:22px;font-size:12px;font-weight:900;letter-spacing:.04em;',
      'background:rgba(255,59,48,.13);color:#ff6b5e;border:1px solid rgba(255,59,48,.3)}',
    '.fl-hero-live.soon{background:rgba(255,176,32,.12);color:#ffb020;border-color:rgba(255,176,32,.3)}',
    '.fl-hero-live.done{background:rgba(255,255,255,.06);color:var(--txt3,#8b8b8b);border-color:var(--line,rgba(255,255,255,.14))}',
    '.fl-cd{font-variant-numeric:tabular-nums;font-weight:900}',
    '.fl-tiles{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}',
    '.fl-tile{flex:1 1 110px;padding:11px 13px;border-radius:13px;background:rgba(255,255,255,.04)}',
    '.fl-tile small{display:block;font-size:10.5px;font-weight:800;color:var(--txt3,#8b8b8b);',
      'text-transform:uppercase;letter-spacing:.04em}',
    '.fl-tile b{display:block;font-size:18px;font-weight:900;margin-top:3px}',
    '.fl-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:4px;margin-bottom:12px}',
    '.fl-chips::-webkit-scrollbar{display:none}',
    '.fl-chip{flex:0 0 auto;min-width:74px;padding:9px 13px;border-radius:13px;cursor:pointer;',
      'font-family:inherit;text-align:left;background:var(--card,#0e0e0e);color:inherit;',
      'border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.fl-chip b{display:block;font-size:16px;font-weight:900}',
    '.fl-chip small{display:block;font-size:10px;font-weight:700;color:var(--txt3,#8b8b8b);',
      'text-transform:uppercase;letter-spacing:.04em;margin-top:2px}',
    '.fl-chip.on{border-color:var(--acc,#71ff00);background:rgba(113,255,0,.09)}',
    '.fl-card{position:relative;padding:14px;border-radius:16px;margin-bottom:10px;',
      'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.fl-card.live{border-color:rgba(255,59,48,.34)}',
    '.fl-c-top{display:flex;gap:12px;align-items:flex-start}',
    '.fl-img{width:66px;height:66px;flex:0 0 66px;border-radius:12px;object-fit:cover;',
      'background:rgba(255,255,255,.05);display:flex;align-items:center;justify-content:center;font-size:24px}',
    '.fl-c-i{flex:1;min-width:0}',
    '.fl-off{display:inline-block;margin-top:5px;padding:3px 9px;border-radius:20px;font-size:10.5px;',
      'font-weight:900;background:rgba(255,59,48,.15);color:#ff6b5e}',
    '.fl-cd-row{margin-top:11px;font-size:12.5px;font-weight:700;color:var(--txt3,#8b8b8b)}',
    '.fl-cd-row b{font-variant-numeric:tabular-nums;color:inherit;font-weight:900}',
    '.fl-bar{height:6px;border-radius:6px;background:rgba(255,255,255,.08);margin-top:11px;overflow:hidden}',
    '.fl-bar i{display:block;height:100%;background:var(--acc,#71ff00);transition:width .4s ease}',
    '.fl-barl{margin-top:6px;font-size:11.5px;font-weight:700;color:var(--txt3,#8b8b8b)}',
    '.fl-acts{display:flex;gap:8px;margin-top:12px}',
    '.fl-acts .fl-btn{flex:1}',
    '.fl-more{flex:0 0 44px;border-radius:12px;cursor:pointer;font:inherit;font-size:17px;',
      'font-weight:900;background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.16))}',
    '.fl-menu{position:absolute;right:12px;bottom:56px;z-index:6;min-width:186px;padding:6px;',
      'border-radius:14px;background:var(--card,#141414);border:1px solid var(--line,rgba(255,255,255,.16));',
      'box-shadow:0 18px 44px rgba(0,0,0,.5)}',
    '.fl-menu button{display:block;width:100%;text-align:left;padding:11px 12px;border:0;',
      'border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:13.5px;font-weight:700;cursor:pointer}',
    '.fl-prev{margin-top:10px;padding:12px 13px;border-radius:13px;',
      'background:rgba(113,255,0,.08);border:1px solid rgba(113,255,0,.24)}',
    '.fl-prev.bad{background:rgba(255,107,107,.10);border-color:rgba(255,107,107,.3)}',
    '.fl-prev b{display:block;font-size:15px;font-weight:900}',
    '.fl-prev span{display:block;font-size:12.5px;font-weight:800;color:var(--acc,#71ff00);margin-top:3px}',
    '.fl-prev i{display:block;font-style:normal;font-size:11px;font-weight:600;',
      'color:var(--txt3,#8b8b8b);margin-top:5px}',
    '.fl-perf{margin-top:6px}',
    '.fl-kv{display:flex;gap:10px;padding:9px 0;font-size:13px;',
      'border-bottom:1px solid var(--line,rgba(255,255,255,.07))}',
    '.fl-kv span{flex:1;color:var(--txt3,#8b8b8b);font-weight:600}',
    '.fl-kv b{font-weight:800}',
    '.fl-back{display:flex;align-items:center;gap:10px;margin-bottom:12px}',
    '.fl-backb{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;padding:2px 6px}',
    '.fl-empty-i{font-size:40px;margin-bottom:10px}',
    '@media (max-width:520px){ .fl-tile{flex:1 1 calc(50% - 4px)} }',

    '.fl-sk{height:74px;border-radius:13px;background:var(--card,#0e0e0e);',
    'border:1px solid var(--line,rgba(255,255,255,.10));animation:flsk 1.1s ease-in-out infinite}',
    '@keyframes flsk{0%,100%{opacity:.55}50%{opacity:.85}}',
    '@media (prefers-reduced-motion:reduce){.fl-sk{animation:none}}',
    '.fl-sheet{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-end;justify-content:center}',
    '.fl-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62)}',
    '.fl-panel{position:relative;width:100%;max-width:520px;max-height:92vh;overflow:auto;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.14));',
    'border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px))}',
    '@media (min-width:600px){.fl-sheet{align-items:center}.fl-panel{border-radius:18px}}',
    '.fl-ph{font-size:17px;font-weight:800;margin-bottom:2px}',
    '.fl-psub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:16px;line-height:1.6}',
    '.fl-f{margin-bottom:13px}',
    '.fl-l{display:block;font-size:12px;font-weight:700;margin-bottom:6px;color:var(--txt2,rgba(255,255,255,.7))}',
    '.fl-i{box-sizing:border-box;width:100%;min-height:46px;border-radius:11px;padding:11px 13px;font:inherit;font-size:16px;',
    'background:rgba(255,255,255,.04);border:1px solid var(--line,rgba(255,255,255,.13));color:inherit}',
    '.fl-i:focus{outline:2px solid var(--acc,#71ff00);outline-offset:1px}',
    '.fl-row2{display:flex;gap:10px}.fl-row2>.fl-f{flex:1;min-width:0}',
    '.fl-err{font-size:12.5px;color:#ff6b6b;margin-top:6px;line-height:1.6}',
    '.fl-note{font-size:12px;color:var(--txt2,rgba(255,255,255,.5));margin-top:5px;line-height:1.55}',
    '.fl-foot{display:flex;gap:9px;margin-top:6px}',
    '.fl-foot>button{flex:1;min-height:48px;border-radius:12px;cursor:pointer;font:inherit;font-weight:800;font-size:14px}',
    '.fl-go{background:var(--acc,#71ff00);color:#050505;border:0}',
    '.fl-go[disabled]{opacity:.55;cursor:progress}',
    '.fl-cancel{background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.16))}',
  ].join('');

  function css () {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    document.head.appendChild(s);
  }

  function esc (v) {
    return String(v == null ? '' : v)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money (n) {
    /* null, undefined and '' are UNKNOWN, not zero. Number(null) is 0, so a bare
       isFinite() check turned an unreported price into "KES 0" — a figure the
       merchant never set, on the screen where they check what buyers are being
       charged. */
    if (n === null || n === undefined || n === '') return null;
    var v = Number(n);
    if (!isFinite(v)) return null;
    return 'KES ' + Math.round(v).toLocaleString('en-KE');
  }
  function toMs (v) {
    if (!v) return null;
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (_) { return null; } }
    if (typeof v === 'number') return v;
    var p = Date.parse(v); return isNaN(p) ? null : p;
  }
  function whenText (ms) {
    if (!ms) return null;
    try { return new Date(ms).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return null; }
  }
  /* For a datetime-local input: local time, no timezone suffix. */
  function localInput (d) {
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function mount (host, ctx) {
    css();
    ctx = ctx || {};
    if (host && host.classList) host.classList.add(HOST_CLASS);

    var S = {
      sales: null, products: null, err: null, editor: null, destroyed: false,
      filter: 'all',
      open: null,          /* the sale whose performance sheet is open */      /* all | live | soon | done */
      pq: '',             /* product search inside the picker */
      tick: null,         /* countdown interval */
      menu: null,         /* index of the card whose ⋮ menu is open */
    };

    function skeleton () {
      var c = '';
      for (var i = 0; i < 3; i++) c += '<div class="fl-sk"></div>';
      host.innerHTML =
        '<div class="fl-top"><div class="fl-h">Flash Sales</div></div>' +
        '<div class="fl-sub">Loading your sales…</div>' +
        '<div class="fl-list">' + c + '</div>';
    }

    /* `status` is the SERVER's word. It is recomputed for display only where the
       clock has moved on since the document was written — never to disagree with
       the server about whether a sale ran. */
    function phase (s) {
      var now = Date.now();
      var st = toMs(s.startAt), en = toMs(s.endAt);
      if (String(s.status) === 'ended' || (en && en <= now)) return 'done';
      if (st && st > now) return 'soon';
      return 'live';
    }


    /* ── THE COUNTDOWN ────────────────────────────────────────────────────────
       Rendered from the sale's own endAt (or startAt while scheduled). Returns null when
       there is no timestamp to count to — a missing window is not "00h 00m 00s", which
       would read as a sale about to end. */
    function countdown (s2) {
      var ph = phase(s2);
      var target = ph === 'soon' ? toMs(s2.startAt) : toMs(s2.endAt);
      if (!target) return null;
      var ms = target - Date.now();
      if (ms <= 0) return ph === 'soon' ? 'starting' : 'ended';
      var h = Math.floor(ms / 3600000);
      var m = Math.floor((ms % 3600000) / 60000);
      var sec = Math.floor((ms % 60000) / 1000);
      var pad = function (n) { return (n < 10 ? '0' : '') + n; };
      if (h >= 24) {
        var d = Math.floor(h / 24);
        return d + (d === 1 ? ' day ' : ' days ') + pad(h % 24) + 'h ' + pad(m) + 'm';
      }
      return pad(h) + 'h ' + pad(m) + 'm ' + pad(sec) + 's';
    }

    /* Product record for a sale, from the ONE catalogue. Used for imagery and stock only —
       the sale's own prices are the server's, never re-read from the product. */
    function productOf (s2) {
      var list = S.products || [];
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === s2.productId) return list[i];
      }
      return null;
    }

    /* ── THE HERO ─────────────────────────────────────────────────────────────
       Every figure is derived from rows the server returned. "Sales generated" is
       soldCount x salePrice and is shown ONLY where soldCount is a real number on every
       counted sale — a partial sum presented as a total is a fabricated figure, and this
       is a revenue line. */
    function heroHTML (rows) {
      var live = rows.filter(function (x) { return phase(x) === 'live'; });
      var soon = rows.filter(function (x) { return phase(x) === 'soon'; });
      var done = rows.filter(function (x) { return phase(x) === 'done'; });

      var soldKnown = true, units = 0, revenue = 0;
      rows.forEach(function (x) {
        if (typeof x.soldCount !== 'number') { soldKnown = false; return; }
        units += x.soldCount;
        if (typeof x.salePrice === 'number') revenue += x.soldCount * x.salePrice;
      });

      /* The soonest ending live sale drives the hero countdown. */
      var next = live.slice().sort(function (a, b) {
        return (toMs(a.endAt) || Infinity) - (toMs(b.endAt) || Infinity);
      })[0];
      var cd = next ? countdown(next) : null;

      return '<div class="fl-hero">' +
          '<div class="fl-hero-t">🔥 Flash Sale</div>' +
          '<div class="fl-hero-s">Time-boxed discounts. Buyers see the sale price while it runs.</div>' +
          (live.length
            ? '<div class="fl-hero-live">🔴 LIVE NOW' +
              (cd ? '<span class="fl-cd" data-fl-cd="1">' + esc(cd) + '</span>' : '') + '</div>'
            : soon.length ? '<div class="fl-hero-live soon">🕐 SCHEDULED</div>'
            : rows.length ? '<div class="fl-hero-live done">ENDED</div>' : '') +
        '</div>' +
        '<div class="fl-tiles">' +
          '<div class="fl-tile"><small>🔥 Live</small><b>' + live.length + '</b></div>' +
          '<div class="fl-tile"><small>🏷️ On sale</small><b>' +
            (function () {
              var ids = {}; live.forEach(function (x) { if (x.productId) ids[x.productId] = 1; });
              return Object.keys(ids).length;
            })() + '</b></div>' +
          '<div class="fl-tile"><small>📦 Units sold</small><b>' +
            (soldKnown ? units : '—') + '</b></div>' +
          '<div class="fl-tile"><small>💰 Sales</small><b>' +
            (soldKnown ? esc(money(revenue)) : '—') + '</b></div>' +
        '</div>' +
        '<div class="fl-chips">' +
          ['all', 'live', 'soon', 'done'].map(function (k) {
            var n = k === 'all' ? rows.length
                  : k === 'live' ? live.length : k === 'soon' ? soon.length : done.length;
            var lb = k === 'all' ? 'All' : k === 'live' ? 'Live' : k === 'soon' ? 'Scheduled' : 'Ended';
            return '<button class="fl-chip' + (S.filter === k ? ' on' : '') +
              '" data-fl="chip" data-k="' + k + '"><b>' + n + '</b><small>' + lb + '</small></button>';
          }).join('') +
        '</div>';
    }

    /* ── THE DISCOUNT PREVIEW ─────────────────────────────────────────────────
       DISPLAY ONLY, and deliberately so. The server derives discountPct from the two prices
       it is given and that value is what is stored and shown to buyers; this is a preview so
       the merchant is not doing arithmetic in their head while typing. It is never sent, and
       the saved card renders the SERVER's number, so the two cannot drift into two figures
       for one sale. */
    function discountPreview (regular, sale) {
      var r = Number(regular), v = Number(sale);
      if (!isFinite(r) || !isFinite(v) || r <= 0 || v <= 0) return '';
      if (v >= r) {
        return '<div class="fl-prev bad">A sale price must be lower than ' + esc(money(r)) + '.</div>';
      }
      var pct = Math.round(((r - v) / r) * 100);
      return '<div class="fl-prev">' +
        '<b>' + esc(money(r)) + ' → ' + esc(money(v)) + '</b>' +
        '<span>' + pct + '% OFF · Save ' + esc(money(r - v)) + '</span>' +
        '<i>Preview — the server confirms the final discount when you publish.</i>' +
      '</div>';
    }

    function saleRow (s2, i) {
      var ph = phase(s2);
      var label = ph === 'live' ? '🔴 Live now' : ph === 'soon' ? '🕐 Scheduled' : 'Ended';
      var sale = money(s2.salePrice), was = money(s2.originalPrice);
      var sold = (typeof s2.soldCount === 'number') ? s2.soldCount : null;
      var cap = (typeof s2.stockLimit === 'number') ? s2.stockLimit : null;
      var p = productOf(s2);
      var img = p && (p.image || (Array.isArray(p.images) && p.images[0]));
      var cd = countdown(s2);

      /* Progress needs BOTH a sold count and a limit. With either missing there is no
         fraction to draw, and a bar at 0% would claim nothing has sold when the truth is
         that we do not know. */
      var bar = (sold !== null && cap) ? Math.min(100, Math.round((sold / cap) * 100)) : null;

      return '<div class="fl-card ' + ph + '">' +
        '<div class="fl-c-top">' +
          (img ? '<img class="fl-img" alt="" loading="lazy" src="' + esc(img) + '">'
               : '<div class="fl-img ph" aria-hidden="true">🏷️</div>') +
          '<div class="fl-c-i">' +
            '<div class="fl-nm">' + esc(s2.productName || (p && p.name) || s2.sku || 'Product') + '</div>' +
            '<div class="fl-px">' +
              '<span class="fl-sale">' + esc(sale === null ? '—' : sale) + '</span>' +
              (was !== null ? '<span class="fl-was">' + esc(was) + '</span>' : '') +
            '</div>' +
            /* The SERVER's discountPct, never one computed here. */
            (typeof s2.discountPct === 'number'
              ? '<span class="fl-off">' + esc(Math.round(s2.discountPct)) + '% OFF</span>' : '') +
          '</div>' +
          '<span class="fl-tag ' + ph + '">' + label + '</span>' +
        '</div>' +
        (cd ? '<div class="fl-cd-row" data-fl-cd="1">' +
              (ph === 'soon' ? 'Starts in ' : ph === 'done' ? '' : 'Ends in ') +
              '<b>' + esc(cd) + '</b></div>' : '') +
        (bar !== null
          ? '<div class="fl-bar"><i style="width:' + bar + '%"></i></div>' +
            '<div class="fl-barl">' + esc(sold) + ' of ' + esc(cap) + ' sold</div>'
          : '<div class="fl-barl">' +
            (sold !== null ? esc(sold) + ' sold' : 'Units sold —') + '</div>') +
        '<div class="fl-acts">' +
          '<button class="fl-btn" data-fl="open" data-i="' + i + '">View</button>' +
          '<button class="fl-more" data-fl="menu" data-i="' + i + '" aria-haspopup="true" ' +
            'aria-expanded="' + (S.menu === i ? 'true' : 'false') + '" aria-label="More actions">⋮</button>' +
        '</div>' +
        /* Always in the DOM, toggled with [hidden] — the rule Products learned when Delete
           existed only after a second tap. */
        '<div class="fl-menu" role="menu"' + (S.menu === i ? '' : ' hidden') + '>' +
          '<button role="menuitem" data-fl="open" data-i="' + i + '">📊 Performance</button>' +
          '<button role="menuitem" data-fl="go" data-route="products">🏷️ Open product</button>' +
        '</div>' +
      '</div>';
    }

    /* ── PERFORMANCE ──────────────────────────────────────────────────────────
       Only what the sale document actually carries. Orders, average sale value and
       conversion are NOT derivable from mktFlashSales — it records soldCount, not the orders
       that produced it — so they are shown as unavailable rather than invented. */
    function performanceHTML (s2) {
      var sold = (typeof s2.soldCount === 'number') ? s2.soldCount : null;
      var cap = (typeof s2.stockLimit === 'number') ? s2.stockLimit : null;
      var rev = (sold !== null && typeof s2.salePrice === 'number') ? sold * s2.salePrice : null;
      var disc = (sold !== null && typeof s2.salePrice === 'number' && typeof s2.originalPrice === 'number')
        ? sold * (s2.originalPrice - s2.salePrice) : null;
      var kv = function (k, v) {
        return '<div class="fl-kv"><span>' + esc(k) + '</span><b>' + (v === null ? '—' : esc(v)) + '</b></div>';
      };
      return '<div class="fl-perf">' +
        kv('Units sold', sold) +
        kv('Revenue', rev === null ? null : money(rev)) +
        kv('Discount given', disc === null ? null : money(disc)) +
        kv('Remaining stock', (sold !== null && cap !== null) ? Math.max(0, cap - sold) : null) +
        kv('Sale price', typeof s2.salePrice === 'number' ? money(s2.salePrice) : null) +
        kv('Regular price', typeof s2.originalPrice === 'number' ? money(s2.originalPrice) : null) +
        '<div class="fl-note">Orders, average sale value and conversion are not recorded ' +
        'against a flash sale — it counts units, not the orders that produced them. They are ' +
        'shown as unavailable rather than estimated.</div>' +
      '</div>';
    }

    function paint () {
      if (S.destroyed) return;
      if (S.sales === null && !S.err) return skeleton();

      if (S.err) {
        host.innerHTML =
          '<div class="fl-top"><div class="fl-h">Flash Sales</div></div>' +
          '<div class="fl-state">Your flash sales couldn’t be loaded just now.<br>' +
          'This is not an empty list — nothing was fetched.<br>' +
          '<button class="fl-new" style="margin-top:14px" data-fl="retry">Try again</button></div>';
        return;
      }

      var rows = S.sales.slice().sort(function (a, b) {
        return (toMs(b.startAt) || 0) - (toMs(a.startAt) || 0);
      });
      var live = rows.filter(function (s) { return phase(s) === 'live'; }).length;

      /* Filtered AFTER the hero counts, so a chip reading 3 opens a list of 3. S.painted is
         the flat list every index addresses. */
      var shown = S.filter === 'all' ? rows : rows.filter(function (x) { return phase(x) === S.filter; });
      S.painted = shown;

      host.innerHTML =
        heroHTML(rows) +
        '<button class="fl-new" data-fl="new">＋ Create flash sale</button>' +
        (shown.length
          ? '<div class="fl-list">' + shown.map(function (x, i) { return saleRow(x, i); }).join('') + '</div>'
          : '<div class="fl-state">' + (rows.length
              ? 'No flash sale in this view.<br><button class="fl-btn" style="margin-top:12px" data-fl="chip" data-k="all">Show all</button>'
              : '<div class="fl-empty-i">🔥</div><b>No flash sales yet.</b><br>' +
                'A flash sale discounts one product for a set window, and ends itself.') + '</div>') +
        (S.editor ? editorHTML() : '') +
        (S.open ? perfSheet() : '');

      startTick();
    }

    /* ── THE FORM ───────────────────────────────────────────────────────────
       The merchant types the SALE PRICE. There is deliberately no percentage
       box: converting a percentage into a price would put a second pricing
       calculation in the client, and the server already derives the discount
       from the two prices it is given. */
    /* The countdown ticks IN PLACE — only the countdown nodes are rewritten, never the whole
       surface. Repainting once a second would tear focus out of the form the merchant is
       typing into and rebuild every card for a clock. Cleared on destroy so a torn-down
       module cannot keep a timer alive. */
    function startTick () {
      if (S.tick || S.destroyed) return;
      S.tick = setInterval(function () {
        if (S.destroyed) return stopTick();
        /* Defensive: a host without querySelectorAll cannot be updated in place, and the
           certification harness stubs exactly such a host. Throwing inside an interval is
           worse than not ticking — it fires every second, forever, into a surface the
           merchant can still see. */
        if (typeof host.querySelectorAll !== 'function') return stopTick();
        var nodes = host.querySelectorAll('[data-fl-cd]');
        if (!nodes || !nodes.length) return;
        var rows = (S.painted || []);
        /* Re-derive from the same rows; if a sale has just ended the phase changes and a
           full repaint IS warranted, because the badge and the filters are now wrong. */
        var flipped = rows.some(function (x) { var c = countdown(x); return c === 'ended' || c === 'starting'; });
        if (flipped) { stopTick(); return paint(); }
        for (var i = 0; i < nodes.length; i++) {
          var row = rows[i];
          if (!row) continue;
          var c2 = countdown(row);
          if (c2) nodes[i].textContent = c2;
        }
      }, 1000);
    }
    function stopTick () { if (S.tick) { clearInterval(S.tick); S.tick = null; } }

    function perfSheet () {
      var s2 = S.open;
      return '<div class="fl-sheet"><div class="fl-scrim" data-fl="closeperf"></div>' +
        '<div class="fl-panel" role="dialog" aria-modal="true" aria-label="Flash sale performance">' +
        '<div class="fl-back"><button class="fl-backb" data-fl="closeperf" aria-label="Back">←</button>' +
          '<span>Performance</span></div>' +
        '<div class="fl-ph">' + esc(s2.productName || s2.sku || 'Flash sale') + '</div>' +
        performanceHTML(s2) +
        '<div class="fl-foot"><button class="fl-cancel" data-fl="closeperf">Close</button></div>' +
      '</div></div>';
    }

    function openEditor () {
      var now = new Date();
      var end = new Date(now.getTime() + 24 * 3600 * 1000);
      S.editor = {
        busy: false, err: null,
        values: { productId: '', salePrice: '', stockLimit: '10',
                  startAt: localInput(now), endAt: localInput(end) },
      };
      paint();
    }
    function closeEditor () { S.editor = null; paint(); }

    function captureForm () {
      if (!S.editor) return;
      ['productId', 'salePrice', 'stockLimit', 'startAt', 'endAt'].forEach(function (k) {
        var el = host.querySelector('[data-ff="' + k + '"]');
        if (el) S.editor.values[k] = el.value;
      });
    }

    function selectedProduct () {
      var id = S.editor && S.editor.values.productId;
      return (S.products || []).filter(function (p) { return String(p.id) === String(id); })[0] || null;
    }

    function editorHTML () {
      var E = S.editor, v = E.values;
      var prods = (S.products || []).filter(function (p) { return typeof p.price === 'number' && p.price > 0; });
      var p = selectedProduct();
      return '<div class="fl-sheet"><div class="fl-scrim" data-fl="close"></div>' +
        '<div class="fl-panel" role="dialog" aria-modal="true" aria-label="New flash sale">' +
        '<div class="fl-ph">New flash sale</div>' +
        '<div class="fl-psub">One product, one window. SOKONI ends it automatically when the ' +
          'window closes or the stock limit is reached.</div>' +
        '<div class="fl-f"><label class="fl-l" for="ff-product">Product</label>' +
          '<select class="fl-i" id="ff-product" data-ff="productId">' +
            '<option value="">Choose a product…</option>' +
            prods.map(function (x) {
              return '<option value="' + esc(x.id) + '"' +
                (String(x.id) === String(v.productId) ? ' selected' : '') + '>' +
                esc(x.name) + ' — ' + esc(money(x.price)) + '</option>';
            }).join('') +
          '</select>' +
          (prods.length ? '' : '<div class="fl-note">No product has a price yet. ' +
             'A flash sale needs something to discount.</div>') + '</div>' +
        '<div class="fl-row2">' +
          '<div class="fl-f"><label class="fl-l" for="ff-sale">Sale price (KES)</label>' +
            '<input class="fl-i" id="ff-sale" data-ff="salePrice" type="number" inputmode="decimal" ' +
              'min="1" step="any" value="' + esc(v.salePrice) + '">' +
            (p ? '<div class="fl-note">Normally ' + esc(money(p.price)) + '. ' +
                 'SOKONI works out the discount.</div>' : '') + '</div>' +
          '<div class="fl-f"><label class="fl-l" for="ff-stock">Units on offer</label>' +
            '<input class="fl-i" id="ff-stock" data-ff="stockLimit" type="number" inputmode="numeric" ' +
              'min="1" step="1" value="' + esc(v.stockLimit) + '">' +
            '<div class="fl-note">How many the sale may sell. Not a stock change.</div></div>' +
        '</div>' +
        /* Live preview of what the merchant is typing. DISPLAY ONLY — never sent; the
           server derives the stored discount from the two prices it is given. */
        (p ? discountPreview(p.price, v.salePrice) : '') +
        '<div class="fl-row2">' +
          '<div class="fl-f"><label class="fl-l" for="ff-start">Starts</label>' +
            '<input class="fl-i" id="ff-start" data-ff="startAt" type="datetime-local" value="' + esc(v.startAt) + '"></div>' +
          '<div class="fl-f"><label class="fl-l" for="ff-end">Ends</label>' +
            '<input class="fl-i" id="ff-end" data-ff="endAt" type="datetime-local" value="' + esc(v.endAt) + '"></div>' +
        '</div>' +
        (E.err ? '<div class="fl-err">' + esc(E.err) + '</div>' : '') +
        '<div class="fl-foot">' +
          '<button class="fl-cancel" data-fl="close">Cancel</button>' +
          '<button class="fl-go" data-fl="launch"' + (E.busy ? ' disabled' : '') + '>' +
            (E.busy ? 'Launching…' : 'Launch') + '</button>' +
        '</div></div></div>';
    }

    function launch () {
      var E = S.editor;
      if (!E || E.busy) return;
      captureForm();
      var v = E.values;
      var p = selectedProduct();

      /* Only what the SERVER cannot be asked about: is a product chosen, and are
         the boxes filled. Every rule about the numbers — sale below original,
         end after start, a positive stock limit — is the server's, and its
         message is what the merchant sees. Restating them here would be a second
         copy to drift. */
      if (!p) { E.err = 'Choose a product first.'; return paint(); }
      if (!v.salePrice || !v.stockLimit || !v.startAt || !v.endAt) {
        E.err = 'Fill in the price, the units and the window.'; return paint();
      }
      if (typeof ctx.callDispatch !== 'function') {
        E.err = 'Flash sales are not available just now.'; return paint();
      }

      E.busy = true; E.err = null; paint();

      Promise.resolve(ctx.callDispatch({
        op: 'createFlashSale',
        merchantId: ctx.scope && ctx.scope.sellerUid,
        productId: p.id,
        sku: p.sku || String(p.id),
        originalPrice: Number(p.price),
        salePrice: Number(v.salePrice),
        stockLimit: Number(v.stockLimit),
        startAt: new Date(v.startAt).toISOString(),
        endAt: new Date(v.endAt).toISOString(),
      })).then(function () {
        if (S.destroyed) return;
        S.editor = null;
        if (typeof ctx.onToast === 'function') ctx.onToast('Flash sale launched.');
        /* Re-READ. The list is never patched from what we believe we sent. */
        S.sales = null; load();
      }).catch(function (e) {
        if (S.destroyed) return;
        E.busy = false;
        /* The server's own words. It validates the window and the prices, and a
           locally-invented message would eventually contradict it. */
        E.err = (e && (e.message || e.details)) || 'The flash sale could not be created.';
        paint();
      });
    }

    /* ── LOAD ───────────────────────────────────────────────────────────────── */
    function load () {
      skeleton();
      var scope = ctx.scope;
      if (!scope || !scope.ok) {
        S.sales = []; S.products = [];
        host.innerHTML =
          '<div class="fl-top"><div class="fl-h">Flash Sales</div></div>' +
          '<div class="fl-state">No shop yet.<br>A flash sale needs a shop and a product.</div>';
        return Promise.resolve();
      }
      var md = (typeof window !== 'undefined') && window.SokoniMerchantData;
      var pSales = (typeof ctx.sales === 'function')
        ? Promise.resolve().then(ctx.sales)
        : Promise.reject(new Error('no-sales-reader'));
      /* Products through the ONE reader. A failure there must not fail the list:
         existing sales still matter when the catalogue is unavailable. */
      var pProds = (md && typeof md.listProducts === 'function' && ctx.db)
        ? Promise.resolve().then(function () { return md.listProducts({ scope: scope, db: ctx.db }); })
            .catch(function () { return []; })
        : Promise.resolve([]);

      return Promise.all([pSales, pProds]).then(function (r) {
        if (S.destroyed) return;
        S.sales = Array.isArray(r[0]) ? r[0] : [];
        S.products = Array.isArray(r[1]) ? r[1] : [];
        S.err = null;
        paint();
      }).catch(function (e) {
        if (S.destroyed) return;
        S.err = (e && e.message) || String(e);
        paint();
      });
    }

    function onClick (ev) {
      var el = ev.target && ev.target.closest && ev.target.closest('[data-fl]');
      if (!el) return;
      var k = el.getAttribute('data-fl');
      if (k === 'retry') { S.err = null; S.sales = null; return load(); }
      if (k === 'new') return openEditor();
      if (k === 'close') { if (S.editor && S.editor.busy) return; return closeEditor(); }
      if (k === 'launch') return launch();
      if (k === 'chip') {
        S.filter = el.getAttribute('data-k') || 'all';
        S.menu = null;               /* a menu index addresses the painted list */
        return paint();
      }
      if (k === 'menu') {
        var mi = Number(el.getAttribute('data-i'));
        S.menu = (S.menu === mi) ? null : mi;   /* the same control closes it */
        return paint();
      }
      if (k === 'open') {
        var oi = Number(el.getAttribute('data-i'));
        var so = S.painted && S.painted[oi];
        if (!so) return;
        S.open = so; S.menu = null; return paint();
      }
      if (k === 'closeperf') { S.open = null; return paint(); }
      if (k === 'go') {
        /* Navigation belongs to the SHELL — this module sets no location and links nowhere. */
        var r = el.getAttribute('data-route');
        try {
          if (typeof ctx.go === 'function') ctx.go(r);
          else if (window.SokoniShell && window.SokoniShell.go) window.SokoniShell.go(r);
        } catch (e) {}
        return;
      }
    }
    function onChange (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute || !S.editor) return;
      var k = el.getAttribute('data-ff');
      if (!k) return;
      S.editor.values[k] = el.value;
      /* The product AND the sale price both change what the form shows: the product sets the
         "normally KES x" note, and the price drives the discount preview. That comment used
         to say only the product mattered, and it was true until the preview existed — the
         price then updated state and repainted nothing, so the preview never appeared at all.
         Caught by mounting the module; a source read would not have noticed. */
      if (k === 'productId' || k === 'salePrice') {
        paint();
        /* A repaint rebuilds the input the merchant is typing into, so focus and caret are
           put back. Without this the field loses focus on every keystroke. */
        try {
          var again = host.querySelector('[data-ff="' + k + '"]');
          if (again && again.focus) {
            again.focus();
            var v = String(again.value == null ? '' : again.value);
            if (again.setSelectionRange && again.type !== 'number') again.setSelectionRange(v.length, v.length);
          }
        } catch (e) {}
      }
    }
    function onKey (ev) {
      if (ev.key !== 'Escape' || !S.editor || S.editor.busy) return;
      closeEditor();
    }

    host.addEventListener('click', onClick);
    host.addEventListener('change', onChange);
    host.addEventListener('input', onChange);
    document.addEventListener('keydown', onKey);
    load();

    return {
      refresh: function () { S.sales = null; S.err = null; return load(); },
      destroy: function () {
        S.destroyed = true;
        /* The countdown interval must die with the module. A surviving timer would keep
           calling paint() into a torn-down host once a second, forever. */
        stopTick();
        host.removeEventListener('click', onClick);
        host.removeEventListener('change', onChange);
        host.removeEventListener('input', onChange);
        document.removeEventListener('keydown', onKey);
        if (host && host.classList) host.classList.remove(HOST_CLASS);
        host.innerHTML = '';
      },
    };
  }

  return { mount: mount };
}));
