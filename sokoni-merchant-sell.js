/* ════════════════════════════════════════════════════════════════════════════
   SOKONI Merchant Sell — the phone-first till (2D-1C)

   The surface a merchant uses standing up, one-handed, with a customer waiting:

       search / scan → tap product → adjust qty → charge → pay → receipt

   ── What it is built on, and what it therefore cannot do ────────────────────
   Every figure comes from `SokoniMerchantData`, which reads canonical `products`
   scoped by `shopId` and submits sales to `posCompleteCheckout`. This module adds
   NO data path of its own: no localStorage business state, no client stock write,
   no locally computed "success".

   Consequences that matter at the till:

     • Opening or abandoning a checkout moves NOTHING. There is no reservation
       and no decrement — the cart lives in memory and dies there. Stock changes
       only when the server says a sale completed.
     • The pay button cannot show success. It shows CHECKING, then CHARGING, then
       whatever the server returned. A dropped response is a failure with a retry,
       never a receipt.
     • A retry cannot double-sell. The sale token is minted once per attempt and
       held across retries, so `idempotencyKey` is reproduced identically and
       posCompleteCheckout completes the sale exactly once.
     • Oversell is guarded BEFORE charging, using the server's own side-effect-free
       dry run — and when that check cannot run, it says so rather than passing.

   ── Not in this slice, and deliberately not faked ───────────────────────────
   No STK push. A payment here is RECORDED as tendered, exactly as the existing
   till records it; the screen says so in those words rather than implying money
   moved. Collecting through SokoniPay is a separate, larger piece of work.
   ════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantSell = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-sell-css';

  /* Touch targets are ≥48px throughout, the grid uses minmax(0,1fr) so a long
     product name can never widen a column, and nothing is wider than its
     container — the page must not scroll sideways at 320px. */
  var CSS = [
    '#native-sell{padding:0!important;overflow:hidden!important;display:flex;flex-direction:column}',
    '.msl{display:flex;flex-direction:column;height:100%;min-height:0;overflow:hidden;',
      'font-variant-numeric:tabular-nums}',

    /* ── Search bar ── */
    '.msl-top{flex:0 0 auto;display:flex;gap:8px;padding:12px 14px;border-bottom:1px solid var(--line);',
      'background:var(--panel)}',
    '.msl-find{flex:1;min-width:0;display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:13px;padding:0 12px;height:48px}',
    /* height:100% so the INPUT itself is the 48px target. Relying on the wrapping
       label to be tappable leaves a control that measures 20px, and a thumb at a
       till aims at what it can see. */
    '.msl-find input{flex:1;min-width:0;height:100%;background:none;border:none;outline:none;color:var(--txt);',
      /* 16px: anything smaller makes iOS Safari zoom the whole page on focus, which
         at the till reads as the app breaking. */
      'font-size:16px;font-weight:600;font-family:inherit}',
    '.msl-find input::placeholder{color:var(--txt3);font-weight:500}',
    '.msl-x{flex:0 0 auto;width:28px;height:28px;border:none;background:rgba(255,255,255,.08);',
      'color:var(--txt2);border-radius:50%;font-size:15px;cursor:pointer;display:none}',
    '.msl-find.has .msl-x{display:block}',
    '.msl-scan{flex:0 0 auto;width:48px;height:48px;border-radius:13px;border:1px solid rgba(113,255,0,.3);',
      'background:rgba(113,255,0,.12);color:var(--acc);font-size:19px;cursor:pointer}',

    /* ── Product grid ── */
    '.msl-body{flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:14px}',
    '.msl-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(148px,100%),1fr));gap:10px}',
    '.msl-card{position:relative;text-align:left;background:var(--card);border:1px solid var(--line);',
      'border-radius:16px;padding:13px 12px 12px;min-height:96px;cursor:pointer;color:var(--txt);',
      'font-family:inherit;display:flex;flex-direction:column;justify-content:space-between;gap:8px;',
      'transition:transform .08s,border-color .15s;overflow:hidden}',
    '.msl-card:active{transform:scale(.97);border-color:rgba(113,255,0,.45)}',
    '.msl-card .nm{font-size:13.5px;font-weight:700;line-height:1.3;overflow-wrap:anywhere;',
      'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}',
    '.msl-card .pr{font-size:15px;font-weight:900;color:var(--acc)}',
    '.msl-card .st{font-size:10.5px;font-weight:700;color:var(--txt3);text-transform:uppercase;letter-spacing:.03em}',
    '.msl-card .st.low{color:#ffb020}',
    '.msl-card .st.out{color:#ff5a5a}',
    '.msl-card.out{opacity:.55}',
    '.msl-badge{position:absolute;top:8px;right:8px;min-width:24px;height:24px;border-radius:12px;',
      'background:var(--acc);color:#000;font-size:12px;font-weight:900;display:flex;align-items:center;',
      'justify-content:center;padding:0 7px}',

    /* ── States ── */
    '.msl-state{padding:44px 26px;text-align:center;color:var(--txt2);font-size:13.5px;line-height:1.6}',
    '.msl-state .ic{font-size:34px;margin-bottom:12px}',
    '.msl-state .hd{font-weight:800;font-size:15px;color:var(--txt);margin-bottom:8px}',
    '.msl-btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:48px;',
      'padding:0 20px;border-radius:13px;font-weight:800;font-size:14px;cursor:pointer;font-family:inherit;',
      'border:1px solid rgba(113,255,0,.32);background:rgba(113,255,0,.13);color:var(--acc)}',
    '.msl-btn.ghost{background:rgba(255,255,255,.05);border-color:var(--line);color:var(--txt2)}',
    '.msl-btn.solid{background:var(--acc);border-color:var(--acc);color:#000}',
    '.msl-btn[disabled]{opacity:.5;cursor:default}',
    '.msl-btn.wide{width:100%}',

    /* ── Cart bar — always visible once there is a cart, never overlapping the nav ── */
    '.msl-bar{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:11px 14px;',
      'border-top:1px solid rgba(113,255,0,.28);background:linear-gradient(180deg,#0c0c0c,#080808)}',
    '.msl-bar .sum{flex:1;min-width:0}',
    '.msl-bar .n{font-size:17px;font-weight:900;color:var(--acc);line-height:1.2}',
    '.msl-bar .l{font-size:11px;color:var(--txt2);font-weight:600}',
    '.msl-bar .msl-btn{flex:0 0 auto}',

    /* ── Sheet ── */
    '.msl-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62);z-index:60;',
      'animation:mslFade .16s ease both}',
    '@keyframes mslFade{from{opacity:0}to{opacity:1}}',
    '.msl-sheet{position:absolute;left:0;right:0;bottom:0;z-index:61;background:var(--panel);',
      'border-top:1px solid var(--line);border-radius:20px 20px 0 0;max-height:88%;display:flex;',
      'flex-direction:column;animation:mslUp .2s cubic-bezier(.2,.7,.3,1) both;',
      'padding-bottom:env(safe-area-inset-bottom,0px)}',
    '@keyframes mslUp{from{transform:translateY(14px);opacity:.4}to{transform:none;opacity:1}}',
    '@media (prefers-reduced-motion:reduce){.msl-sheet,.msl-scrim{animation:none}.msl-card:active{transform:none}}',
    '.msl-sh-h{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:15px 16px 11px;',
      'border-bottom:1px solid var(--line)}',
    '.msl-sh-h .t{flex:1;min-width:0;font-size:15px;font-weight:800;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.msl-sh-x{width:34px;height:34px;flex:0 0 auto;border-radius:10px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt2);font-size:17px;cursor:pointer}',
    '.msl-sh-b{flex:1;min-height:0;overflow-y:auto;padding:14px 16px}',
    '.msl-sh-f{flex:0 0 auto;padding:12px 16px 16px;border-top:1px solid var(--line);display:flex;',
      'flex-direction:column;gap:9px}',

    /* ── Cart lines ── */
    '.msl-line{display:flex;align-items:center;gap:11px;padding:11px 0;border-bottom:1px solid var(--line)}',
    '.msl-line:last-child{border-bottom:none}',
    '.msl-line .info{flex:1;min-width:0}',
    '.msl-line .nm{font-size:13.5px;font-weight:700;overflow-wrap:anywhere}',
    '.msl-line .sub{font-size:11.5px;color:var(--txt2);margin-top:3px}',
    '.msl-line .sub.warn{color:#ffb020;font-weight:700}',
    '.msl-step{flex:0 0 auto;display:flex;align-items:center;gap:2px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:12px;padding:3px}',
    '.msl-step button{width:44px;height:44px;border:none;background:none;color:var(--txt);font-size:18px;',
      'font-weight:800;cursor:pointer;border-radius:9px;font-family:inherit}',
    '.msl-step button:active{background:rgba(255,255,255,.10)}',
    '.msl-step .q{min-width:44px;height:44px;border:none;background:none;color:var(--acc);font-size:15px;',
      'font-weight:900;text-align:center;font-family:inherit;outline:none;padding:0}',
    '.msl-tot{display:flex;justify-content:space-between;align-items:baseline;padding:13px 0 2px;',
      'font-size:13px;color:var(--txt2)}',
    '.msl-tot.grand{font-size:15px;color:var(--txt);font-weight:800;border-top:1px solid var(--line);margin-top:8px;padding-top:13px}',
    '.msl-tot.grand b{font-size:21px;font-weight:900;color:var(--acc)}',

    /* ── Payment ── */
    '.msl-pays{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(104px,100%),1fr));gap:9px;margin-bottom:14px}',
    '.msl-pay{min-height:64px;border-radius:14px;border:1px solid var(--line);background:rgba(255,255,255,.04);',
      'color:var(--txt2);font-family:inherit;font-weight:800;font-size:12.5px;cursor:pointer;display:flex;',
      'flex-direction:column;align-items:center;justify-content:center;gap:5px}',
    '.msl-pay .ic{font-size:19px}',
    '.msl-pay.on{border-color:rgba(113,255,0,.5);background:rgba(113,255,0,.12);color:var(--acc)}',
    '.msl-cash{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(76px,100%),1fr));gap:8px;margin:4px 0 12px}',
    '.msl-cash button{min-height:44px;border-radius:11px;border:1px solid var(--line);',
      'background:rgba(255,255,255,.05);color:var(--txt);font-weight:800;font-size:13px;cursor:pointer;font-family:inherit}',
    '.msl-cash button.on{border-color:rgba(113,255,0,.5);color:var(--acc);background:rgba(113,255,0,.10)}',
    '.msl-inp{width:100%;height:52px;background:rgba(255,255,255,.06);border:1px solid var(--line);',
      'border-radius:13px;padding:0 14px;color:var(--txt);font-size:17px;font-weight:800;font-family:inherit;outline:none}',
    '.msl-inp:focus{border-color:rgba(113,255,0,.42)}',
    '.msl-lbl{font-size:11px;font-weight:800;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--txt3);margin:0 0 7px}',
    '.msl-note{font-size:11.5px;color:var(--txt3);line-height:1.55;margin-top:10px}',

    /* ── Truthful progress + outcome ── */
    '.msl-prog{display:flex;align-items:center;gap:11px;padding:13px 14px;border-radius:13px;',
      'background:rgba(255,255,255,.05);border:1px solid var(--line);font-size:13px;font-weight:700;color:var(--txt2)}',
    '.msl-spin{width:17px;height:17px;flex:0 0 auto;border-radius:50%;border:2px solid rgba(255,255,255,.18);',
      'border-top-color:var(--acc);animation:mslSpin .7s linear infinite}',
    '@keyframes mslSpin{to{transform:rotate(360deg)}}',
    '.msl-err{padding:13px 14px;border-radius:13px;background:rgba(255,90,90,.10);',
      'border:1px solid rgba(255,90,90,.34);color:#ff9a9a;font-size:13px;font-weight:700;line-height:1.5}',
    '.msl-warn{padding:12px 14px;border-radius:13px;background:rgba(255,176,32,.10);',
      'border:1px solid rgba(255,176,32,.32);color:#ffc45e;font-size:12.5px;font-weight:700;line-height:1.5;margin-bottom:12px}',
    '.msl-ok{text-align:center;padding:20px 6px 8px}',
    '.msl-ok .ic{font-size:44px;margin-bottom:10px}',
    '.msl-ok .hd{font-size:19px;font-weight:900;color:var(--acc)}',
    '.msl-ok .rc{font-size:12.5px;color:var(--txt2);margin-top:7px;font-weight:700}',
    '.msl-rl{display:flex;justify-content:space-between;gap:12px;font-size:12.5px;color:var(--txt2);padding:5px 0}',
    '.msl-rl span:last-child{color:var(--txt);font-weight:700;flex:0 0 auto}',
    '@media (min-width:821px){.msl-sheet{left:50%;transform:translateX(-50%);width:min(560px,100%);',
      'border-radius:20px 20px 0 0}}',
  ].join('');

  function injectCSS(doc) {
    if (!doc || doc.getElementById(CSS_ID)) return;
    var s = doc.createElement('style');
    s.id = CSS_ID; s.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(s);
  }

  /* Text is escaped at the point of interpolation; every action travels as a
     data-attribute read by ONE delegated listener, never as an inline handler
     built from user data. */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var MD = function () {
    return (typeof globalThis !== 'undefined' && globalThis.SokoniMerchantData) || null;
  };

  var METHODS = [
    { id: 'cash',  icon: '💵', label: 'Cash'   },
    { id: 'mpesa', icon: '📱', label: 'M-Pesa' },
    { id: 'card',  icon: '💳', label: 'Card'   },
  ];
  var CASH_STEPS = [50, 100, 200, 500, 1000];

  /**
   * Mount the Sell surface.
   *
   * ctx:
   *   scope        resolved merchant scope from SokoniMerchantData.resolveScope()
   *   db           { queryProducts(spec) }
   *   callSale     (payload) => Promise  — bound to posCompleteCheckout
   *   shopName     display only
   *   onPrint      (receipt) => Promise|void        (optional)
   *   onToast      (message, kind) => void          (optional)
   *   openScanner  () => Promise<string|null>       (optional)
   */
  function mount(host, ctx) {
    if (!host) return null;
    var doc = host.ownerDocument || document;
    injectCSS(doc);
    ctx = ctx || {};

    var S = {
      phase: 'loading',        /* loading | no_shop | error | ready */
      error: null,
      products: [],
      term: '',
      cart: [],
      sheet: null,             /* null | 'cart' | 'pay' */
      method: 'cash',
      cashGiven: null,
      saleToken: null,         /* ONE per attempt, held across retries */
      sale: 'idle',            /* idle | checking | charging | done | failed */
      saleError: null,
      preflight: null,
      receipt: null,
      cached: false,
    };

    var md = MD();
    if (!md) {
      host.innerHTML = '<div class="msl"><div class="msl-state"><div class="ic">⚠️</div>' +
        '<div class="hd">Sell is unavailable</div>The merchant data layer did not load. ' +
        'Reopen SOKONI Merchant.</div></div>';
      return null;
    }

    /* ── Data ─────────────────────────────────────────────────────────────── */
    function load() {
      if (!ctx.scope || !ctx.scope.ok) {
        S.phase = 'no_shop'; paint(); return Promise.resolve();
      }
      S.phase = 'loading'; paint();
      return md.listProducts({ scope: ctx.scope, db: ctx.db }).then(function (rows) {
        S.products = rows || [];
        S.phase = 'ready';
        paint();
      }).catch(function (e) {
        S.phase = 'error';
        S.error = (e && e.message) || 'Products could not be loaded.';
        paint();
      });
    }

    /* ── Derived ──────────────────────────────────────────────────────────── */
    function visible() { return md.searchProducts(S.products, S.term); }
    function totals()  { return md.cartTotals(S.cart); }
    function inCart(id) {
      for (var i = 0; i < S.cart.length; i++) if (S.cart[i].productId === id) return S.cart[i].qty;
      return 0;
    }

    /* ── Render ───────────────────────────────────────────────────────────── */
    function paint() {
      host.innerHTML = '<div class="msl">' + topHTML() + bodyHTML() + barHTML() + '</div>' + sheetHTML();
      var inp = host.querySelector('#msl-q');
      if (inp && S.focusSearch) { inp.focus(); S.focusSearch = false; }
    }

    function topHTML() {
      return '<div class="msl-top">' +
        '<label class="msl-find' + (S.term ? ' has' : '') + '">' +
          '<span aria-hidden="true">🔎</span>' +
          '<input id="msl-q" type="search" inputmode="search" autocomplete="off" ' +
            'placeholder="Search or scan a product" value="' + esc(S.term) + '" aria-label="Search products">' +
          (S.term ? '<button class="msl-x" data-act="clear" aria-label="Clear search">×</button>' : '') +
        '</label>' +
        '<button class="msl-scan" data-act="scan" aria-label="Scan barcode">▣</button>' +
      '</div>';
    }

    function bodyHTML() {
      if (S.phase === 'loading') {
        return '<div class="msl-body"><div class="msl-grid">' +
          new Array(6).join('x').split('x').map(function () {
            return '<div class="msl-card" style="pointer-events:none"><div class="sk-line" style="width:80%"></div>' +
                   '<div class="sk-line" style="width:45%;margin:0"></div></div>';
          }).join('') + '</div></div>';
      }
      if (S.phase === 'no_shop') {
        var why = (ctx.scope && ctx.scope.reason) || 'no_active_shop';
        return '<div class="msl-body"><div class="msl-state"><div class="ic">🏪</div>' +
          '<div class="hd">No shop is active yet</div>' +
          (why === 'not_signed_in'
            ? 'Sign in to open the till.'
            : 'Selling needs a shop. Once your merchant account has an approved shop, its ' +
              'products appear here and you can start selling.') +
          '</div></div>';
      }
      if (S.phase === 'error') {
        return '<div class="msl-body"><div class="msl-state"><div class="ic">⚠️</div>' +
          '<div class="hd">Products could not be loaded</div>' + esc(S.error || '') +
          '<div style="margin-top:18px"><button class="msl-btn" data-act="reload">Try again</button></div>' +
          '</div></div>';
      }

      var rows = visible();
      if (!rows.length) {
        return '<div class="msl-body"><div class="msl-state"><div class="ic">' + (S.term ? '🔍' : '📦') + '</div>' +
          '<div class="hd">' + (S.term ? 'Nothing matches “' + esc(S.term) + '”' : 'This shop has no products yet') + '</div>' +
          (S.term ? 'Try part of the name, or scan the barcode.'
                  : 'Add products to your catalogue and they appear here instantly.') +
          '</div></div>';
      }

      return '<div class="msl-body"><div class="msl-grid">' + rows.map(function (p, i) {
        var q = inCart(p.id);
        var out = (p.stock === 0);
        var stockTxt = (p.stock == null) ? 'Stock —'          /* unknown, never "0 left" */
                     : out ? 'Out of stock'
                     : p.stock + ' in stock';
        var cls = out ? 'out' : (p.lowStock ? 'low' : '');
        return '<button class="msl-card' + (out ? ' out' : '') + '" data-act="add" data-i="' + i + '">' +
          (q ? '<span class="msl-badge">' + q + '</span>' : '') +
          '<div class="nm">' + esc(p.name || 'Unnamed product') + '</div>' +
          '<div><div class="pr">' + esc(md.formatKES(p.price)) + '</div>' +
          '<div class="st ' + cls + '">' + esc(stockTxt) + '</div></div>' +
        '</button>';
      }).join('') + '</div></div>';
    }

    function barHTML() {
      var t = totals();
      if (!S.cart.length) {
        return '<div class="msl-bar" style="border-top-color:var(--line)">' +
          '<div class="sum"><div class="l" style="font-size:12px">Tap a product to start a sale</div></div>' +
        '</div>';
      }
      return '<div class="msl-bar">' +
        '<button class="msl-btn ghost" data-act="open-cart" style="min-width:0;padding:0 14px">' +
          t.units + ' item' + (t.units === 1 ? '' : 's') + '</button>' +
        '<div class="sum" data-act="open-cart" style="cursor:pointer">' +
          '<div class="n">' + esc(md.formatKES(t.subtotal)) + '</div>' +
          '<div class="l">Tap to review</div>' +
        '</div>' +
        '<button class="msl-btn solid" data-act="charge">Charge</button>' +
      '</div>';
    }

    /* ── Sheets ───────────────────────────────────────────────────────────── */
    function sheetHTML() {
      if (!S.sheet) return '';
      var inner = (S.sheet === 'cart') ? cartSheet() : paySheet();
      return '<div class="msl-scrim" data-act="close-sheet"></div><div class="msl-sheet" role="dialog" aria-modal="true">' + inner + '</div>';
    }

    function cartSheet() {
      var t = totals();
      var warn = md.cartWarnings(S.cart);
      var warnBy = {};
      warn.forEach(function (w) { warnBy[w.productId] = w; });

      return '<div class="msl-sh-h"><div class="t">This sale</div>' +
          '<button class="msl-sh-x" data-act="close-sheet" aria-label="Close">×</button></div>' +
        '<div class="msl-sh-b">' +
          S.cart.map(function (l, i) {
            var w = warnBy[l.productId];
            return '<div class="msl-line">' +
              '<div class="info"><div class="nm">' + esc(l.name || 'Product') + '</div>' +
                '<div class="sub' + (w ? ' warn' : '') + '">' +
                  (w ? 'Only ' + w.available + ' in stock' :
                       esc(md.formatKES(l.price)) + ' each · ' + esc(md.formatKES(l.price * l.qty))) +
                '</div></div>' +
              '<div class="msl-step">' +
                '<button data-act="dec" data-i="' + i + '" aria-label="One fewer">−</button>' +
                '<input class="q" data-act="qty" data-i="' + i + '" inputmode="numeric" ' +
                  'pattern="[0-9]*" value="' + l.qty + '" aria-label="Quantity">' +
                '<button data-act="inc" data-i="' + i + '" aria-label="One more">+</button>' +
              '</div>' +
            '</div>';
          }).join('') +
          '<div class="msl-tot grand"><span>Total</span><b>' + esc(md.formatKES(t.subtotal)) + '</b></div>' +
        '</div>' +
        '<div class="msl-sh-f">' +
          '<button class="msl-btn solid wide" data-act="charge">Charge ' + esc(md.formatKES(t.subtotal)) + '</button>' +
          '<button class="msl-btn ghost wide" data-act="clear-cart">Cancel this sale</button>' +
        '</div>';
    }

    function paySheet() {
      var t = totals();

      /* ── Completed ─────────────────────────────────────────────────────
         The ONLY place a success is shown, and only from a server result. */
      if (S.sale === 'done') {
        var r = S.receipt || {};
        var items = r.items || [];
        return '<div class="msl-sh-h"><div class="t">Sale complete</div>' +
            '<button class="msl-sh-x" data-act="new-sale" aria-label="Close">×</button></div>' +
          '<div class="msl-sh-b">' +
            '<div class="msl-ok"><div class="ic">✅</div>' +
              '<div class="hd">' + esc(md.formatKES(r.total != null ? r.total : t.subtotal)) + '</div>' +
              '<div class="rc">Receipt ' + esc(r.receiptNo || '—') +
                (S.cached ? ' · already completed earlier' : '') + '</div>' +
            '</div>' +
            (S.cached ? '<div class="msl-warn">This sale had already been completed on the server, so ' +
              'nothing was charged twice. The receipt below is the original.</div>' : '') +
            items.map(function (it) {
              return '<div class="msl-rl"><span>' + esc(it.name || it.productId) + ' × ' + (it.qty || 1) + '</span>' +
                '<span>' + esc(md.formatKES((it.unitPrice || 0) * (it.qty || 1))) + '</span></div>';
            }).join('') +
            (r.total != null ? '<div class="msl-tot grand"><span>Paid</span><b>' + esc(md.formatKES(r.total)) + '</b></div>' : '') +
          '</div>' +
          '<div class="msl-sh-f">' +
            '<div style="display:flex;gap:9px">' +
              '<button class="msl-btn ghost" style="flex:1" data-act="print">🖨 Print</button>' +
              '<button class="msl-btn ghost" style="flex:1" data-act="share">↗ Share</button>' +
            '</div>' +
            '<button class="msl-btn solid wide" data-act="new-sale">New sale</button>' +
          '</div>';
      }

      var busy = (S.sale === 'checking' || S.sale === 'charging');
      var cash = (S.method === 'cash');
      var given = (S.cashGiven == null) ? null : Number(S.cashGiven);
      var change = (cash && given != null && given >= t.subtotal) ? given - t.subtotal : null;

      return '<div class="msl-sh-h"><div class="t">Take payment</div>' +
          '<button class="msl-sh-x" data-act="close-sheet" aria-label="Close"' + (busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="msl-sh-b">' +
          '<div class="msl-tot grand" style="border-top:none;margin:0 0 14px;padding-top:0">' +
            '<span>Amount due</span><b>' + esc(md.formatKES(t.subtotal)) + '</b></div>' +

          (S.preflight && S.preflight.blocking
            ? '<div class="msl-warn">' + esc(S.preflight.message) + '</div>' : '') +
          (S.preflight && !S.preflight.blocking && S.preflight.message
            ? '<div class="msl-warn">' + esc(S.preflight.message) + '</div>' : '') +

          '<div class="msl-lbl">How is the customer paying?</div>' +
          '<div class="msl-pays">' + METHODS.map(function (m) {
            return '<button class="msl-pay' + (S.method === m.id ? ' on' : '') + '" data-act="method" data-m="' + m.id + '"' +
              (busy ? ' disabled' : '') + '><span class="ic">' + m.icon + '</span>' + m.label + '</button>';
          }).join('') + '</div>' +

          (cash
            ? '<div class="msl-lbl">Cash received</div>' +
              '<div class="msl-cash">' +
                '<button data-act="tender" data-v="exact"' + (given === t.subtotal ? ' class="on"' : '') + '>Exact</button>' +
                CASH_STEPS.filter(function (v) { return v >= t.subtotal; }).slice(0, 4).map(function (v) {
                  return '<button data-act="tender" data-v="' + v + '"' + (given === v ? ' class="on"' : '') + '>' + v + '</button>';
                }).join('') +
              '</div>' +
              '<input class="msl-inp" id="msl-cash" inputmode="numeric" pattern="[0-9]*" ' +
                'placeholder="Or type the amount" value="' + (given == null ? '' : given) + '" aria-label="Cash received">' +
              (change != null
                ? '<div class="msl-tot grand"><span>Change due</span><b>' + esc(md.formatKES(change)) + '</b></div>'
                : (given != null && given < t.subtotal
                    ? '<div class="msl-note" style="color:#ffb020">That is less than the amount due.</div>' : ''))
            : '<div class="msl-note">Confirm the ' + esc(S.method === 'mpesa' ? 'M-Pesa' : 'card') +
              ' payment has actually been received before completing. This screen <b>records</b> the ' +
              'tender against the sale — it does not request the money.</div>') +

          (S.sale === 'failed'
            ? '<div class="msl-err" style="margin-top:14px">' + esc(S.saleError || 'The sale was not completed.') +
              '<div style="font-weight:600;color:var(--txt2);margin-top:7px;font-size:12px">' +
              'Nothing was charged and no stock moved. Trying again completes this same sale once — ' +
              'it cannot sell twice.</div></div>'
            : '') +

          (busy
            ? '<div class="msl-prog" style="margin-top:14px"><span class="msl-spin"></span>' +
              (S.sale === 'checking' ? 'Checking stock and prices…' : 'Completing the sale on the server…') +
              '</div>'
            : '') +
        '</div>' +
        '<div class="msl-sh-f">' +
          '<button class="msl-btn solid wide" data-act="complete"' +
            (busy || (cash && given != null && given < t.subtotal) ? ' disabled' : '') + '>' +
            (busy ? (S.sale === 'checking' ? 'Checking…' : 'Completing…')
                  : (S.sale === 'failed' ? 'Try again' : 'Complete sale')) +
          '</button>' +
          '<button class="msl-btn ghost wide" data-act="close-sheet"' + (busy ? ' disabled' : '') + '>Back to cart</button>' +
        '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */

    function addProduct(p) {
      try {
        S.cart = md.addToCart(S.cart, p, 1, ctx.scope);
      } catch (e) {
        toast((e && e.message) || 'That product cannot be sold here.', 'error');
        return;
      }
      paint();
    }

    function toast(msg, kind) {
      if (typeof ctx.onToast === 'function') { try { ctx.onToast(msg, kind); return; } catch (_) {} }
      if (kind === 'error') console.error('[merchant sell] ' + msg);
    }

    /* One sale token per ATTEMPT — minted when the payment sheet opens and kept
       across every retry, so `idempotencyKey` is identical and the server can
       recognise the retry. Cleared only on a completed sale or a new sale. */
    /* PERSISTED, and that is the whole point of the change. The token was held only
       in memory, which covers a double-tap but NOT a refresh: reload the page
       mid-submission and S.saleToken is gone, the next attempt mints a fresh key,
       and the server's idempotency guard is bypassed because it has never seen that
       key. The customer is then charged twice by a guard that worked perfectly.

       sessionStorage survives a reload and dies with the tab, which is exactly the
       lifetime of one sale attempt. It is scoped by shop so two shops open in two
       tabs cannot inherit each other's attempt. */
    var TOKEN_KEY = 'sokoni.sell.token';

    function _tokenStore() {
      try { return root.sessionStorage || null; } catch (_) { return null; }
    }
    function _shopScope() {
      return String((ctx.scope && (ctx.scope.shopId || ctx.scope.sellerUid)) || 'nos');
    }

    function mintToken() {
      if (S.saleToken) return S.saleToken;
      var st = _tokenStore(), scope = _shopScope();
      if (st) {
        try {
          var prev = JSON.parse(st.getItem(TOKEN_KEY) || 'null');
          /* Only resume an attempt belonging to THIS shop. */
          if (prev && prev.token && prev.scope === scope) { S.saleToken = prev.token; return S.saleToken; }
        } catch (_) {}
      }
      var rnd = Math.random().toString(36).slice(2, 10);
      S.saleToken = String(Date.now().toString(36)) + rnd;
      if (st) { try { st.setItem(TOKEN_KEY, JSON.stringify({ token: S.saleToken, scope: scope })); } catch (_) {} }
      return S.saleToken;
    }

    /* Cleared ONLY when the sale is genuinely finished or abandoned. A failed call
       must never clear it — the retry has to reuse the same key or the guard is
       bypassed exactly as described above. */
    function clearToken() {
      S.saleToken = null;
      var st = _tokenStore();
      if (st) { try { st.removeItem(TOKEN_KEY); } catch (_) {} }
    }

    function openPay() {
      if (!S.cart.length) return;
      mintToken();
      S.sheet = 'pay'; S.sale = 'idle'; S.saleError = null; S.preflight = null;
      S.cashGiven = null;
      paint();
    }

    function newSale() {
      S.cart = []; clearToken(); S.sheet = null; S.sale = 'idle';
      S.receipt = null; S.cached = false; S.saleError = null; S.preflight = null; S.cashGiven = null;
      /* Re-read the catalogue: the sale just changed canonical stock, and the next
         customer must not be sold against the pre-sale numbers. */
      load();
    }

    function payments() {
      var t = totals();
      return [{ method: S.method, amount: t.subtotal }];
    }

    /* Pre-charge guard. Uses the server's own side-effect-free dry run: it prices
       the cart against canonical `products` and reports the stock deltas WITHOUT
       claiming an idempotency key or writing anything.

       A check that could not RUN is reported as "not checked" and does not block —
       the real transaction re-validates atomically and is the actual authority.
       What must never happen is an unavailable check being treated as a pass. */
    function preflight() {
      if (typeof ctx.callSale !== 'function') return Promise.resolve({ blocking: false, message: null });
      return md.previewSale({
        scope: ctx.scope, cart: S.cart, saleToken: S.saleToken,
        payments: payments(), callable: ctx.callSale,
      }).then(function (r) {
        if (!r.ran) {
          return { blocking: false, message: 'Stock and prices could not be checked first — the server ' +
            'still verifies both before completing, so an oversell is refused there.' };
        }
        /* The dry run floors stock at zero, so a line the shop cannot cover shows a
           delta smaller than the quantity asked for.
           Matched by productId, NOT by index: the server SKIPS a missing product
           when building stockDeltas (it records a difference instead), so the two
           arrays are not positionally aligned and an index join would blame the
           wrong line the moment one product had been deleted. */
        var byId = {};
        (r.stockDeltas || []).forEach(function (d) { byId[String(d.productId)] = d; });
        var short = S.cart.filter(function (line) {
          var d = byId[line.productId];
          return d && Math.abs(d.delta) < line.qty;
        }).map(function (line) {
          var d = byId[line.productId];
          return (line.name || line.productId) + ' (' + d.from + ' left)';
        });
        if (short.length) {
          return { blocking: true, message: 'Not enough stock for ' + short.join(', ') +
            '. Reduce the quantity, or correct the stock count in Inventory first.' };
        }
        var priced = (r.differences || []).filter(function (x) { return x.field === 'unitPrice'; });
        if (priced.length) {
          return { blocking: true, message: 'The price of ' + priced.length + ' item' +
            (priced.length === 1 ? ' has' : 's have') + ' changed since this screen loaded. ' +
            'Reload the products and ring the sale up again.' };
        }
        if ((r.differences || []).length) {
          return { blocking: true, message: 'The server could not accept this cart: ' +
            (r.differences[0].error || 'a product is no longer available') + '.' };
        }
        return { blocking: false, message: null };
      });
    }

    function complete() {
      if (S.sale === 'checking' || S.sale === 'charging') return;
      if (!S.cart.length) return;
      mintToken();
      S.sale = 'checking'; S.saleError = null; S.preflight = null; paint();

      preflight().then(function (pf) {
        S.preflight = pf;
        if (pf.blocking) { S.sale = 'idle'; paint(); return null; }

        S.sale = 'charging'; paint();
        return md.completeSale({
          scope: ctx.scope, cart: S.cart, saleToken: S.saleToken,
          payments: payments(), callable: ctx.callSale,
          checkoutStartedAt: S.startedAt || null,
        }).then(function (res) {
          if (!res.ok) {
            S.sale = 'failed';
            S.saleError = res.error || 'The sale was not completed.';
            paint();
            return null;
          }
          var sale = res.sale || {};
          S.receipt = sale.receipt || null;
          S.cached = sale.cached === true;
          S.sale = 'done';
          paint();
          toast('Sale complete', 'success');
          return null;
        });
      }).catch(function (e) {
        S.sale = 'failed';
        S.saleError = (e && e.message) || 'The sale could not be completed.';
        paint();
      });
    }

    function printReceipt() {
      if (!S.receipt) return;
      if (typeof ctx.onPrint !== 'function') { toast('No printer is set up on this device.', 'error'); return; }
      try {
        Promise.resolve(ctx.onPrint(S.receipt)).catch(function () {
          toast('The receipt could not be printed.', 'error');
        });
      } catch (_) { toast('The receipt could not be printed.', 'error'); }
    }

    function receiptText() {
      var r = S.receipt || {};
      var lines = [(ctx.shopName || 'SOKONI') + ' — Receipt ' + (r.receiptNo || '')];
      (r.items || []).forEach(function (it) {
        lines.push((it.name || it.productId) + ' x' + (it.qty || 1) + '  ' + md.formatKES((it.unitPrice || 0) * (it.qty || 1)));
      });
      lines.push('Total  ' + md.formatKES(r.total));
      if (r.timestamp) lines.push(r.timestamp);
      return lines.join('\n');
    }

    function shareReceipt() {
      var text = receiptText();
      var nav = (typeof navigator !== 'undefined') ? navigator : null;
      if (nav && typeof nav.share === 'function') {
        nav.share({ title: 'Receipt', text: text }).catch(function () {});
        return;
      }
      if (nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(text).then(function () { toast('Receipt copied', 'success'); })
          .catch(function () { toast('The receipt could not be copied.', 'error'); });
        return;
      }
      toast('Sharing is not available on this device.', 'error');
    }

    function scan() {
      if (typeof ctx.openScanner !== 'function') { toast('No scanner is available on this device.', 'error'); return; }
      Promise.resolve(ctx.openScanner()).then(function (code) {
        if (!code) return;
        var hit = md.findByCode(S.products, code);
        if (hit) { addProduct(hit); return; }
        /* No single unambiguous match — show the operator what the code found
           rather than silently adding the wrong item. */
        S.term = String(code); paint();
        toast('No product matches that code exactly.', 'error');
      }).catch(function () { toast('The scanner could not start.', 'error'); });
    }

    /* ── One delegated listener. No inline handlers, so no user string is ever
          interpolated into executable context. ───────────────────────────── */
    function onClick(ev) {
      var el = ev.target && ev.target.closest ? ev.target.closest('[data-act]') : null;
      if (!el || !host.contains(el)) return;
      var act = el.getAttribute('data-act');
      var i = parseInt(el.getAttribute('data-i'), 10);

      if (act === 'add')          { var rows = visible(); if (rows[i]) addProduct(rows[i]); return; }
      if (act === 'open-cart')    { S.sheet = 'cart'; paint(); return; }
      /* Never closable mid-flight: a sheet that vanishes while the server is deciding
         leaves the operator with no idea whether the sale happened. */
      if (act === 'close-sheet')  { if (S.sale === 'checking' || S.sale === 'charging') return;
                                    if (S.sheet === 'pay') {
                                      /* Back to the cart, with the attempt discarded but the
                                         SALE TOKEN kept — reopening pay must not mint a new key
                                         for what is still the same sale. */
                                      S.sheet = S.cart.length ? 'cart' : null;
                                      S.sale = 'idle'; S.saleError = null; S.preflight = null;
                                    } else S.sheet = null;
                                    paint(); return; }
      if (act === 'charge')       { S.startedAt = Date.now(); openPay(); return; }
      if (act === 'clear-cart')   { S.cart = []; S.sheet = null; clearToken(); paint(); return; }
      if (act === 'inc')          { var l1 = S.cart[i]; if (l1) { S.cart = md.setLineQty(S.cart, l1.productId, l1.qty + 1); paint(); } return; }
      if (act === 'dec')          { var l2 = S.cart[i]; if (l2) { S.cart = md.setLineQty(S.cart, l2.productId, l2.qty - 1);
                                    if (!S.cart.length) S.sheet = null; paint(); } return; }
      if (act === 'method')       { S.method = el.getAttribute('data-m') || 'cash'; S.cashGiven = null; paint(); return; }
      if (act === 'tender')       { var v = el.getAttribute('data-v');
                                    S.cashGiven = (v === 'exact') ? totals().subtotal : Number(v); paint(); return; }
      if (act === 'complete')     { complete(); return; }
      if (act === 'new-sale')     { newSale(); return; }
      if (act === 'print')        { printReceipt(); return; }
      if (act === 'share')        { shareReceipt(); return; }
      if (act === 'clear')        { S.term = ''; S.focusSearch = true; paint(); return; }
      if (act === 'scan')         { scan(); return; }
      if (act === 'reload')       { load(); return; }
    }

    function onInput(ev) {
      var el = ev.target;
      if (!el) return;
      if (el.id === 'msl-q') {
        S.term = el.value || '';
        /* Repaint only the grid so the field keeps focus and the caret position. */
        var body = host.querySelector('.msl-body');
        if (body) body.outerHTML = bodyHTML();
        var bar = host.querySelector('.msl-bar');
        if (bar) bar.outerHTML = barHTML();
        var find = host.querySelector('.msl-find');
        if (find) find.classList.toggle('has', !!S.term);
        return;
      }
      if (el.id === 'msl-cash') {
        var n = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
        S.cashGiven = isFinite(n) ? n : null;
        var f = host.querySelector('.msl-sheet');
        if (f) { var sel = el.selectionStart; f.innerHTML = paySheet();
                 var again = host.querySelector('#msl-cash');
                 if (again) { again.focus(); try { again.setSelectionRange(sel, sel); } catch (_) {} } }
        return;
      }
      if (el.getAttribute && el.getAttribute('data-act') === 'qty') {
        var idx = parseInt(el.getAttribute('data-i'), 10);
        var line = S.cart[idx];
        if (!line) return;
        var q = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
        if (!isFinite(q)) return;                 /* mid-edit empty field — wait */
        S.cart = md.setLineQty(S.cart, line.productId, q);
      }
    }

    function onChange(ev) {
      var el = ev.target;
      if (el && el.getAttribute && el.getAttribute('data-act') === 'qty') paint();
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
        host.removeEventListener('change', onChange);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID, METHODS: METHODS };
}));
