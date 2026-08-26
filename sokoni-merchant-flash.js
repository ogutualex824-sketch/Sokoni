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

    var S = { sales: null, products: null, err: null, editor: null, destroyed: false };

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

    function saleRow (s) {
      var ph = phase(s);
      var label = ph === 'live' ? 'Live now' : ph === 'soon' ? 'Scheduled' : 'Ended';
      var sale = money(s.salePrice), was = money(s.originalPrice);
      var ends = whenText(toMs(s.endAt));
      var sold = (typeof s.soldCount === 'number') ? s.soldCount : null;
      var cap = (typeof s.stockLimit === 'number') ? s.stockLimit : null;
      return '<div class="fl-row">' +
        '<div class="fl-nm">' + esc(s.productName || s.sku || s.productId || 'Product') + '</div>' +
        '<div class="fl-px">' +
          '<span class="fl-sale">' + esc(sale === null ? '—' : sale) + '</span>' +
          (was !== null ? '<span class="fl-was">' + esc(was) + '</span>' : '') +
          /* The server's discountPct, never one computed here. */
          (typeof s.discountPct === 'number'
            ? '<span class="fl-off">' + esc(Math.round(s.discountPct)) + '% off</span>' : '') +
        '</div>' +
        '<div class="fl-m">' +
          '<span class="fl-tag ' + ph + '">' + label + '</span>' +
          (ends ? (ph === 'done' ? 'Ended ' : 'Ends ') + esc(ends) : '') +
          /* Sold is shown only when the server has said; an unknown count is not 0. */
          (sold !== null ? '<br>' + esc(sold) + (cap !== null ? ' of ' + esc(cap) : '') + ' sold' : '') +
        '</div>' +
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

      host.innerHTML =
        '<div class="fl-top"><div class="fl-h">Flash Sales</div>' +
          '<div class="fl-count">' + esc(live + (live === 1 ? ' live' : ' live')) + '</div></div>' +
        '<div class="fl-sub">A time-boxed discount on one product. Buyers see the sale price ' +
          'while it runs; it ends itself.</div>' +
        '<button class="fl-new" data-fl="new">+ New flash sale</button>' +
        (rows.length
          ? '<div class="fl-list">' + rows.map(saleRow).join('') + '</div>'
          : '<div class="fl-state">No flash sales yet.<br>A flash sale discounts one product for a set window.</div>') +
        (S.editor ? editorHTML() : '');
    }

    /* ── THE FORM ───────────────────────────────────────────────────────────
       The merchant types the SALE PRICE. There is deliberately no percentage
       box: converting a percentage into a price would put a second pricing
       calculation in the client, and the server already derives the discount
       from the two prices it is given. */
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
    }
    function onChange (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute || !S.editor) return;
      var k = el.getAttribute('data-ff');
      if (!k) return;
      S.editor.values[k] = el.value;
      /* Only the product changes what the form SHOWS (the "normally KES x" note). */
      if (k === 'productId') paint();
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
