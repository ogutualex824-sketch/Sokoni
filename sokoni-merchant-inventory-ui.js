/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Inventory — stock on hand, and CORRECTIONS only (2D-1C)

   This screen exists to answer two questions and perform exactly one action:

       "What is on the shelf?"        canonical products.stock, scoped by shopId
       "Why doesn't it match?"        merchantAdjustStock — a movement, not a sale

   ── The line this screen must never cross ───────────────────────────────────
   A correction is not a sale. Adjusting stock here writes a `stockMovements`
   record and moves `products.stock`; it does NOT touch `sold`, does NOT create an
   order, a receipt or a payment, and does NOT appear in revenue. Selling is the
   Sell screen's job and goes through `posCompleteCheckout`.

   That separation is enforced upstream — `functions/merchant-inventory.js` never
   writes `sold`, and its suite asserts the word is absent from the update patch —
   and it is stated here because the screen is where a merchant could otherwise
   reasonably assume "removing 3 units" means "selling 3 units".

   ── Honesty rules this screen follows ───────────────────────────────────────
     • Unknown stock renders as “—”, never as 0. A product with no `stock` field
       is unmeasured, not empty, and adjusting it is refused rather than guessed.
     • Nothing is shown as applied until the server says it applied. The new
       figure displayed after an adjustment is the server's `after`, not a local
       sum.
     • A refused correction shows the server's own wording, which is written for
       the person holding the stock.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantInventoryUI = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-inv-css';

  var CSS = [
    '#native-inventory{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.mnv{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;font-variant-numeric:tabular-nums}',

    '.mnv-top{flex:0 0 auto;padding:12px 14px;border-bottom:1px solid var(--line);background:var(--panel)}',
    '.mnv-find{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:13px;padding:0 12px;height:48px}',
    '.mnv-find input{flex:1;min-width:0;height:100%;background:none;border:none;outline:none;color:var(--txt);',
      'font-size:16px;font-weight:600;font-family:inherit}',
    '.mnv-find input::placeholder{color:var(--txt3);font-weight:500}',
    '.mnv-tabs{display:flex;gap:8px;margin-top:11px;overflow-x:auto;scrollbar-width:none}',
    '.mnv-tabs::-webkit-scrollbar{display:none}',
    '.mnv-tab{flex:0 0 auto;min-height:44px;padding:0 14px;border-radius:11px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:12.5px;cursor:pointer;font-family:inherit}',
    '.mnv-tab.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.12);color:var(--acc)}',

    '.mnv-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 14px 16px}',
    '.mnv-row{display:flex;align-items:center;gap:12px;padding:13px 0;border-bottom:1px solid var(--line);',
      'width:100%;background:none;border-left:none;border-right:none;border-top:none;text-align:left;',
      'color:var(--txt);font-family:inherit;cursor:pointer;min-height:64px}',
    '.mnv-row:active{background:rgba(255,255,255,.03)}',
    '.mnv-row .info{flex:1;min-width:0}',
    '.mnv-row .nm{font-size:13.5px;font-weight:700;overflow-wrap:anywhere;line-height:1.35}',
    '.mnv-row .sub{font-size:11.5px;color:var(--txt3);margin-top:3px}',
    '.mnv-qty{flex:0 0 auto;text-align:right}',
    '.mnv-qty .v{font-size:19px;font-weight:900;color:var(--acc);line-height:1.1}',
    '.mnv-qty .v.unknown{color:var(--txt3)}',
    '.mnv-qty .v.low{color:#ffb020}',
    '.mnv-qty .v.out{color:#ff5a5a}',
    '.mnv-qty .k{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em;margin-top:2px}',

    '.mnv-state{padding:44px 26px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.mnv-state .ic{font-size:34px;margin-bottom:12px}',
    '.mnv-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.mnv-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;',
      'padding:0 20px;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.mnv-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.mnv-btn.solid{background:var(--acc);border-color:var(--acc);color:#000}',
    '.mnv-btn[disabled]{opacity:.5;cursor:default}',
    '.mnv-btn.wide{width:100%}',

    '.mnv-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:60;animation:mnvFade .16s ease both}',
    '@keyframes mnvFade{from{opacity:0}to{opacity:1}}',
    '.mnv-sheet{position:absolute;left:0;right:0;bottom:0;z-index:61;background:var(--panel);',
      'border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:90%;display:flex;',
      'flex-direction:column;animation:mnvUp .2s cubic-bezier(.2,.7,.3,1) both;',
      'padding-bottom:env(safe-area-inset-bottom,0px)}',
    '@keyframes mnvUp{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.mnv-sheet,.mnv-scrim{animation:none}}',
    '.mnv-sh-h{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:15px 16px 11px;border-bottom:1px solid var(--line)}',
    '.mnv-sh-h .t{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.mnv-sh-x{width:34px;height:34px;flex:0 0 auto;border-radius:10px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:17px;cursor:pointer}',
    '.mnv-sh-b{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.mnv-sh-f{flex:0 0 auto;padding:12px 16px 16px;border-top:1px solid var(--line);display:flex;flex-direction:column;gap:9px}',

    '.mnv-dir{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-bottom:14px}',
    '.mnv-dir button{min-height:56px;border-radius:14px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);font-weight:800;font-size:13px;cursor:pointer;font-family:inherit}',
    '.mnv-dir button.on.add{border-color:rgba(113,255,0,.5);background:rgba(113,255,0,.12);color:var(--acc)}',
    '.mnv-dir button.on.sub{border-color:rgba(255,90,90,.5);background:rgba(255,90,90,.12);color:#ff9a9a}',
    '.mnv-amt{display:flex;align-items:center;gap:2px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:14px;padding:4px;margin-bottom:6px}',
    '.mnv-amt button{width:52px;height:52px;border:none;background:none;color:var(--txt);font-size:22px;',
      'font-weight:800;cursor:pointer;border-radius:11px;font-family:inherit}',
    '.mnv-amt button:active{background:rgba(255,255,255,.10)}',
    '.mnv-amt input{flex:1;min-width:0;height:52px;border:none;background:none;color:var(--acc);font-size:22px;',
      'font-weight:900;text-align:center;font-family:inherit;outline:none}',
    '.mnv-quick{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(64px,100%),1fr));gap:8px;margin-bottom:14px}',
    '.mnv-quick button{min-height:44px;border-radius:11px;border:1px solid var(--line);background:rgba(255,255,255,.05);',
      'color:var(--txt);font-weight:800;font-size:13px;cursor:pointer;font-family:inherit}',
    '.mnv-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--txt3);margin:0 0 7px}',
    '.mnv-reasons{display:grid;gap:7px;margin-bottom:14px}',
    '.mnv-reason{min-height:52px;padding:9px 13px;border-radius:12px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.04);color:var(--txt2);cursor:pointer;font-family:inherit;text-align:left}',
    '.mnv-reason .rl{font-size:13px;font-weight:800;color:var(--txt)}',
    '.mnv-reason .rh{font-size:11px;color:var(--txt3);margin-top:2px}',
    '.mnv-reason.on{border-color:rgba(113,255,0,.45);background:rgba(113,255,0,.10)}',
    '.mnv-reason.on .rl{color:var(--acc)}',
    '.mnv-inp{width:100%;min-height:48px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:13px;padding:13px 14px;color:var(--txt);font-size:15px;font-family:inherit;outline:none;resize:none}',
    '.mnv-inp:focus{border-color:rgba(113,255,0,.42)}',

    '.mnv-pre{display:flex;align-items:center;justify-content:center;gap:14px;padding:14px;border-radius:14px;',
      'background:rgba(255,255,255,.04);border:1px solid var(--line);margin-bottom:14px}',
    '.mnv-pre .n{font-size:24px;font-weight:900;line-height:1}',
    '.mnv-pre .n.from{color:var(--txt2)}',
    '.mnv-pre .n.to{color:var(--acc)}',
    '.mnv-pre .n.bad{color:#ff5a5a}',
    '.mnv-pre .c{font-size:19px;color:var(--txt3)}',
    '.mnv-pre .k{font-size:10px;color:var(--txt3);text-transform:uppercase;letter-spacing:.04em;text-align:center;margin-top:4px}',

    '.mnv-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2)}',
    '.mnv-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mnvSpin .7s linear infinite}',
    '@keyframes mnvSpin{to{transform:rotate(360deg)}}',
    '.mnv-err{padding:13px 14px;border-radius:13px;background:rgba(255,90,90,.10);border:1px solid rgba(255,90,90,.34);',
      'color:#ff9a9a;font-size:13px;font-weight:700;line-height:1.5;margin-top:12px}',
    '.mnv-note{font-size:11.5px;color:var(--txt3);line-height:1.55;margin-top:10px}',
    '.mnv-ok{text-align:center;padding:18px 6px 6px}',
    '.mnv-ok .ic{font-size:40px;margin-bottom:10px}',
    '.mnv-ok .hd{font-size:18px;font-weight:900;color:var(--acc)}',
    '.mnv-ok .sb{font-size:12.5px;color:var(--txt2);margin-top:7px;font-weight:700}',

    '.mnv-mv{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}',
    '.mnv-mv .d{flex:0 0 auto;min-width:48px;text-align:center;font-size:15px;font-weight:900}',
    '.mnv-mv .d.up{color:var(--acc)}',
    '.mnv-mv .d.down{color:#ff9a9a}',
    '.mnv-mv .info{flex:1;min-width:0}',
    '.mnv-mv .nm{font-size:13px;font-weight:700;overflow-wrap:anywhere}',
    '.mnv-mv .sub{font-size:11.5px;color:var(--txt3);margin-top:2px}',
    '@media (min-width:821px){.mnv-sheet{left:50%;transform:translateX(-50%);width:min(560px,100%)}}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var QUICK = [1, 2, 5, 10, 20, 50];

  /**
   * ctx:
   *   scope       resolved merchant scope
   *   db          { queryProducts(spec), queryMovements(spec) }
   *   callAdjust  (payload) => Promise — bound to merchantAdjustStock
   *   onToast     (message, kind) => void   (optional)
   */
  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var md = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantData) || null;
    var ms = (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantStock) || null;
    if (!md || !ms) {
      host.innerHTML = '<div class="mnv"><div class="mnv-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Inventory is unavailable</div>A required module did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    var S = {
      phase: 'loading',      /* loading | no_shop | error | ready */
      error: null,
      tab: 'all',            /* all | low | history */
      term: '',
      products: [],
      movements: null,
      movesLoading: false,
      sheet: null,           /* null | product id being adjusted */
      product: null,
      dir: -1,               /* -1 remove, +1 add */
      amount: 1,
      reason: null,
      note: '',
      apply: 'idle',         /* idle | applying | done | failed */
      applyError: null,
      applied: null,
      attemptToken: null,
    };

    function load() {
      if (!ctx.scope || !ctx.scope.ok) { S.phase = 'no_shop'; paint(); return Promise.resolve(); }
      S.phase = 'loading'; paint();
      return md.listProducts({ scope: ctx.scope, db: ctx.db }).then(function (rows) {
        S.products = rows || [];
        S.phase = 'ready';
        paint();
      }).catch(function (e) {
        S.phase = 'error';
        S.error = (e && e.message) || 'Stock could not be loaded.';
        paint();
      });
    }

    function loadMovements() {
      if (S.movesLoading || !ctx.db || typeof ctx.db.queryMovements !== 'function') return;
      S.movesLoading = true;
      ms.listMovements({ scope: ctx.scope, db: ctx.db, limit: 50 }).then(function (rows) {
        S.movements = rows || []; S.movesLoading = false;
        if (S.tab === 'history') paint();
      }).catch(function (e) {
        S.movements = { error: (e && e.message) || 'History could not be loaded.' };
        S.movesLoading = false;
        if (S.tab === 'history') paint();
      });
    }

    function visible() {
      var rows = md.searchProducts(S.products, S.term);
      if (S.tab === 'low') {
        rows = rows.filter(function (p) { return p.lowStock === true || p.stock === 0; });
      }
      return rows;
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="mnv">' + topHTML() + bodyHTML() + '</div>' + sheetHTML();
    }

    function topHTML() {
      var lowCount = S.products.filter(function (p) { return p.lowStock === true || p.stock === 0; }).length;
      return '<div class="mnv-top">' +
        '<label class="mnv-find"><span aria-hidden="true">🔎</span>' +
          '<input id="mnv-q" type="search" inputmode="search" autocomplete="off" ' +
            'placeholder="Find a product" value="' + esc(S.term) + '" aria-label="Find a product">' +
        '</label>' +
        '<div class="mnv-tabs">' +
          '<button class="mnv-tab' + (S.tab === 'all' ? ' on' : '') + '" data-act="tab" data-t="all">All stock</button>' +
          '<button class="mnv-tab' + (S.tab === 'low' ? ' on' : '') + '" data-act="tab" data-t="low">' +
            'Low or out' + (lowCount ? ' · ' + lowCount : '') + '</button>' +
          '<button class="mnv-tab' + (S.tab === 'history' ? ' on' : '') + '" data-act="tab" data-t="history">Adjustments</button>' +
        '</div>' +
      '</div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="mnv-body">' +
          '<div class="sk-line" style="width:70%"></div><div class="sk-line" style="width:52%"></div>' +
          '<div class="sk-line" style="width:64%"></div><div class="sk-line" style="width:44%"></div></div>';
      }
      if (S.phase === 'no_shop') {
        return '<div class="mnv-body"><div class="mnv-state"><div class="ic">🏪</div>' +
          '<div class="hd">No shop is active yet</div>' +
          'Stock belongs to a shop. Once your merchant account has an approved shop, its ' +
          'products and their stock appear here.</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="mnv-body"><div class="mnv-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Stock could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="mnv-btn" data-act="reload">Try again</button></div>' +
          '</div></div>';
      }
      if (S.tab === 'history') return historyHTML();

      var rows = visible();
      if (!rows.length) {
        return '<div class="mnv-body"><div class="mnv-state"><div class="ic">📦</div>' +
          '<div class="hd">' +
            (S.term ? 'Nothing matches “' + esc(S.term) + '”'
                    : S.tab === 'low' ? 'Nothing is low or out of stock' : 'This shop has no products yet') +
          '</div>' +
          (S.tab === 'low' ? 'Every product with a tracked count is above its low-stock level.' :
           S.term ? 'Try part of the name or the barcode.' :
           'Add products to your catalogue and their stock appears here.') +
          '</div></div>';
      }

      return '<div class="mnv-body">' + rows.map(function (p, i) {
        var cls = (p.stock == null) ? 'unknown' : (p.stock === 0 ? 'out' : (p.lowStock ? 'low' : ''));
        /* Unknown is an em dash. A product with no stock field is UNMEASURED, and
           rendering that as 0 would be a fabricated figure. */
        var val = (p.stock == null) ? '—' : String(p.stock);
        return '<button class="mnv-row" data-act="open" data-i="' + i + '">' +
          '<div class="info"><div class="nm">' + esc(p.name || 'Unnamed product') + '</div>' +
            '<div class="sub">' + esc(md.formatKES(p.price)) +
              (p.sku ? ' · ' + esc(p.sku) : '') + '</div></div>' +
          '<div class="mnv-qty"><div class="v ' + cls + '">' + esc(val) + '</div>' +
            '<div class="k">' + (p.stock == null ? 'not tracked' : 'on hand') + '</div></div>' +
        '</button>';
      }).join('') + '</div>';
    }

    function historyHTML() {
      if (S.movements == null) { loadMovements();
        return '<div class="mnv-body"><div class="sk-line" style="width:68%"></div>' +
               '<div class="sk-line" style="width:48%"></div></div>'; }
      if (S.movements && S.movements.error) {
        return '<div class="mnv-body"><div class="mnv-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Adjustment history could not be loaded</div>' + esc(S.movements.error) +
          '<div style="margin-top:18px"><button class="mnv-btn" data-act="reload-history">Try again</button></div>' +
          '</div></div>';
      }
      if (!S.movements.length) {
        return '<div class="mnv-body"><div class="mnv-state"><div class="ic">🧾</div>' +
          '<div class="hd">No stock corrections yet</div>' +
          'Every correction you make is recorded here with its reason — sales are not, ' +
          'because a sale is not a correction.</div></div>';
      }
      return '<div class="mnv-body">' + S.movements.map(function (m) {
        var up = (m.delta || 0) > 0;
        return '<div class="mnv-mv">' +
          '<div class="d ' + (up ? 'up' : 'down') + '">' + (up ? '+' : '') + esc(String(m.delta == null ? '—' : m.delta)) + '</div>' +
          '<div class="info"><div class="nm">' + esc(m.productName || m.productId || 'Product') + '</div>' +
            '<div class="sub">' + esc(ms.reasonLabel(m.reason)) +
              (m.before != null && m.after != null ? ' · ' + m.before + ' → ' + m.after : '') +
              ' · ' + esc(when(m.createdAt)) +
              (m.note ? ' · ' + esc(m.note) : '') +
            '</div></div>' +
        '</div>';
      }).join('') + '</div>';
    }

    function when(ts) {
      if (!ts) return '—';
      try {
        var d = ts.seconds ? new Date(ts.seconds * 1000)
              : (ts.toDate ? ts.toDate() : new Date(ts));
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' }) + ' ' +
               d.toLocaleTimeString('en-KE', { hour: '2-digit', minute: '2-digit' });
      } catch (_) { return '—'; }
    }

    /* ── Adjustment sheet ─────────────────────────────────────────────────── */
    function sheetHTML() {
      if (!S.sheet || !S.product) return '';
      return '<div class="mnv-scrim" data-act="close"></div>' +
        '<div class="mnv-sheet" role="dialog" aria-modal="true">' + adjustSheet() + '</div>';
    }

    function adjustSheet() {
      var p = S.product;

      if (S.apply === 'done' && S.applied) {
        return '<div class="mnv-sh-h"><div class="t">Stock corrected</div>' +
            '<button class="mnv-sh-x" data-act="close" aria-label="Close">×</button></div>' +
          '<div class="mnv-sh-b"><div class="mnv-ok"><div class="ic">✅</div>' +
            '<div class="hd">' + esc(String(S.applied.after)) + ' on hand</div>' +
            '<div class="sb">' + esc(p.name || '') + ' · ' +
              esc(String(S.applied.before)) + ' → ' + esc(String(S.applied.after)) +
              (S.applied.idempotent ? ' · already applied earlier' : '') + '</div>' +
          '</div>' +
          '<div class="mnv-note">Recorded as <b>' + esc(ms.reasonLabel(S.reason)) + '</b>. ' +
            'This is a stock movement, not a sale — your sales, revenue and <i>sold</i> counts are ' +
            'unchanged.</div></div>' +
          '<div class="mnv-sh-f"><button class="mnv-btn solid wide" data-act="close">Done</button></div>';
      }

      var busy = (S.apply === 'applying');
      var known = (typeof p.stock === 'number');
      var delta = S.dir * Math.max(1, S.amount || 1);
      var after = known ? p.stock + delta : null;
      var impossible = (after != null && after < 0);

      return '<div class="mnv-sh-h"><div class="t">' + esc(p.name || 'Adjust stock') + '</div>' +
          '<button class="mnv-sh-x" data-act="close" aria-label="Close"' + (busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="mnv-sh-b">' +

          (!known
            ? '<div class="mnv-err" style="margin-top:0">This product has no tracked stock count, so there ' +
              'is nothing to correct yet. Set an opening stock figure on the product first — ' +
              'guessing a starting number here would invent inventory that was never counted.</div>'
            :

          '<div class="mnv-pre">' +
            '<div><div class="n from">' + esc(String(p.stock)) + '</div><div class="k">now</div></div>' +
            '<div class="c">→</div>' +
            '<div><div class="n ' + (impossible ? 'bad' : 'to') + '">' + esc(after == null ? '—' : String(after)) + '</div>' +
              '<div class="k">after</div></div>' +
          '</div>' +

          '<div class="mnv-dir">' +
            '<button class="add' + (S.dir === 1 ? ' on' : '') + '" data-act="dir" data-d="1"' + (busy ? ' disabled' : '') + '>+ Add stock</button>' +
            '<button class="sub' + (S.dir === -1 ? ' on' : '') + '" data-act="dir" data-d="-1"' + (busy ? ' disabled' : '') + '>− Remove stock</button>' +
          '</div>' +

          '<div class="mnv-lbl">How many units?</div>' +
          '<div class="mnv-amt">' +
            '<button data-act="amt-dec" aria-label="One fewer"' + (busy ? ' disabled' : '') + '>−</button>' +
            '<input id="mnv-amt" inputmode="numeric" pattern="[0-9]*" value="' + esc(String(S.amount)) + '" aria-label="Units">' +
            '<button data-act="amt-inc" aria-label="One more"' + (busy ? ' disabled' : '') + '>+</button>' +
          '</div>' +
          '<div class="mnv-quick">' + QUICK.map(function (n) {
            return '<button data-act="amt-set" data-n="' + n + '"' + (busy ? ' disabled' : '') + '>' + n + '</button>';
          }).join('') + '</div>' +

          '<div class="mnv-lbl">Why is it changing?</div>' +
          '<div class="mnv-reasons">' + ms.REASONS.map(function (r) {
            return '<button class="mnv-reason' + (S.reason === r.id ? ' on' : '') + '" data-act="reason" data-r="' + r.id + '"' +
              (busy ? ' disabled' : '') + '><div class="rl">' + esc(r.label) + '</div>' +
              '<div class="rh">' + esc(r.hint) + '</div></button>';
          }).join('') + '</div>' +

          '<div class="mnv-lbl">Note (optional)</div>' +
          '<textarea class="mnv-inp" id="mnv-note" rows="2" maxlength="500" ' +
            'placeholder="Anything a future you would want to know">' + esc(S.note) + '</textarea>' +

          (impossible
            ? '<div class="mnv-err">There are only ' + esc(String(p.stock)) + ' in stock, so this would ' +
              'leave ' + esc(String(after)) + '. Count again, or remove at most ' + esc(String(p.stock)) + '.</div>'
            : '') +

          (S.apply === 'failed'
            ? '<div class="mnv-err">' + esc(S.applyError || 'The adjustment was not applied.') +
              '<div style="font-weight:600;color:var(--txt2);margin-top:7px;font-size:12px">' +
              'Nothing changed. Trying again applies this correction once — it cannot double.</div></div>'
            : '') +

          (busy ? '<div class="mnv-prog" style="margin-top:14px"><span class="mnv-spin"></span>' +
                  'Applying the correction on the server…</div>' : '') +

          '<div class="mnv-note">A correction moves stock and records a movement. It does <b>not</b> ' +
            'create a sale, and it does not change your revenue or units-sold figures.</div>'
          ) +
        '</div>' +
        '<div class="mnv-sh-f">' +
          (known
            ? '<button class="mnv-btn solid wide" data-act="apply"' +
                (busy || impossible || !S.reason ? ' disabled' : '') + '>' +
                (busy ? 'Applying…' : (S.apply === 'failed' ? 'Try again'
                  : (!S.reason ? 'Choose a reason' : 'Apply correction'))) +
              '</button>'
            : '') +
          '<button class="mnv-btn ghost wide" data-act="close"' + (busy ? ' disabled' : '') + '>' +
            (known ? 'Cancel' : 'Close') + '</button>' +
        '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */
    function openProduct(p) {
      S.sheet = p.id; S.product = p;
      S.dir = -1; S.amount = 1; S.reason = null; S.note = '';
      S.apply = 'idle'; S.applyError = null; S.applied = null;
      /* One token per adjustment attempt, held across retries so the server sees
         the SAME adjustmentId and applies the correction exactly once. */
      S.attemptToken = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      paint();
    }

    function toast(msg, kind) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(msg, kind); return; } catch (_) {} }
      if (kind === 'error') console.error('[merchant inventory] ' + msg);
    }

    function apply() {
      if (S.apply === 'applying' || !S.product || !S.reason) return;
      if (typeof ctx.callAdjust !== 'function') {
        S.apply = 'failed';
        S.applyError = 'The stock authority is unavailable on this device.';
        paint(); return;
      }
      var delta = S.dir * Math.max(1, S.amount || 1);
      S.apply = 'applying'; S.applyError = null; paint();

      ms.adjustStock({
        scope: ctx.scope, productId: S.product.id, delta: delta,
        reason: S.reason, note: S.note, attemptToken: S.attemptToken,
        callable: ctx.callAdjust,
      }).then(function (r) {
        if (!r.ok) {
          S.apply = 'failed';
          S.applyError = r.error || 'The adjustment was not applied.';
          paint(); return;
        }
        S.applied = r.result;
        S.apply = 'done';
        /* The displayed figure is the SERVER's `after`, not a local sum. */
        S.products = S.products.map(function (p) {
          return (p.id === S.product.id)
            ? Object.assign({}, p, {
                stock: r.result.after,
                inventoryVersion: r.result.inventoryVersion,
                lowStock: (typeof r.result.after === 'number') ? r.result.after <= 5 : null,
              })
            : p;
        });
        S.movements = null;         /* history is now stale */
        paint();
        toast('Stock corrected', 'success');
      }).catch(function (e) {
        S.apply = 'failed';
        S.applyError = (e && e.message) || 'The adjustment could not be applied.';
        paint();
      });
    }

    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');

      if (act === 'tab')      { S.tab = el.getAttribute('data-t') || 'all';
                                if (S.tab === 'history' && S.movements == null) loadMovements();
                                paint(); return; }
      if (act === 'open')     { var rows = visible(); var p = rows[parseInt(el.getAttribute('data-i'), 10)];
                                if (p) openProduct(p); return; }
      if (act === 'close')    { if (S.apply === 'applying') return;
                                S.sheet = null; S.product = null; paint(); return; }
      if (act === 'dir')      { S.dir = (el.getAttribute('data-d') === '1') ? 1 : -1;
                                S.apply = 'idle'; S.applyError = null; paint(); return; }
      if (act === 'amt-inc')  { S.amount = Math.max(1, (S.amount || 1) + 1); S.apply = 'idle'; paint(); return; }
      if (act === 'amt-dec')  { S.amount = Math.max(1, (S.amount || 1) - 1); S.apply = 'idle'; paint(); return; }
      if (act === 'amt-set')  { S.amount = Math.max(1, parseInt(el.getAttribute('data-n'), 10) || 1);
                                S.apply = 'idle'; paint(); return; }
      if (act === 'reason')   { S.reason = el.getAttribute('data-r'); S.apply = 'idle'; paint(); return; }
      if (act === 'apply')    { apply(); return; }
      if (act === 'reload')   { load(); return; }
      if (act === 'reload-history') { S.movements = null; loadMovements(); paint(); return; }
    }

    function onInput(ev) {
      var el = ev.target;
      if (!el) return;
      if (el.id === 'mnv-q') {
        S.term = el.value || '';
        var body = host.querySelector('.mnv-body');
        if (body) body.outerHTML = (S.tab === 'history') ? historyHTML() : bodyHTML();
        return;
      }
      if (el.id === 'mnv-note') { S.note = el.value || ''; return; }
      if (el.id === 'mnv-amt') {
        var n = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
        if (!isFinite(n) || n < 1) return;         /* mid-edit — wait for a real number */
        S.amount = n;
        /* Repaint only the preview so the field keeps focus. */
        var pre = host.querySelector('.mnv-pre');
        if (pre && S.product && typeof S.product.stock === 'number') {
          var after = S.product.stock + S.dir * S.amount;
          pre.innerHTML = '<div><div class="n from">' + esc(String(S.product.stock)) + '</div><div class="k">now</div></div>' +
            '<div class="c">→</div><div><div class="n ' + (after < 0 ? 'bad' : 'to') + '">' + esc(String(after)) +
            '</div><div class="k">after</div></div>';
        }
      }
    }

    function onBlur(ev) {
      if (ev.target && ev.target.id === 'mnv-amt') paint();
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('focusout', onBlur);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
        host.removeEventListener('focusout', onBlur);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID };
}));
