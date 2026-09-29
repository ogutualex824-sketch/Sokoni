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
    '.msl-tot.msl-offer b{color:var(--acc)}',
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
    /* U7c2 (2026-09-29): THE SHOP'S OFFERS, AS THE SERVER PRICES THEM. The discount is never computed here: it is the
       figure the server's own pre-sale check returns for THIS cart (posCompleteCheckout dryRun → shop-offers), and the
       real sale re-applies the same offers and refuses a total that disagrees. `due` is what the customer pays. */
    function cartKey() { return S.cart.map(function (l) { return l.productId + 'x' + l.qty; }).join('|'); }
    function totals()  {
      var t = md.cartTotals(S.cart);
      var off = (S.offer && S.offer.key === cartKey()) ? S.offer : null;
      t.offerDiscount = off ? off.discount : 0;
      t.offers = off ? off.applied : [];
      t.offersChecked = !!off;
      t.due = Math.max(0, t.subtotal - t.offerDiscount);
      /* Points P2b: points held by the BUYER'S confirmation pay part of it; the rest is paid in money */
      t.pointsKES = (S.pts && S.pts.state === 'held') ? Number(S.pts.kes) || 0 : 0;
      t.payable = Math.max(0, t.due - t.pointsKES);
      return t;
    }
    /* Asked ONCE, when the cashier taps Charge — building or correcting a cart calls no sale authority — and under
       the SALE's own token, so the quote, the pre-sale check and the sale are one idempotency key. */
    function quoteOffers() {
      var key = cartKey();
      if (!S.cart.length || typeof ctx.callSale !== 'function') return;
      if (S.offer && S.offer.key === key) return;
      S.offerPending = true;
      md.previewSale({ scope: ctx.scope, cart: S.cart, saleToken: S.saleToken, payments: payments(), callable: ctx.callSale })
        .then(function (r) {
          S.offerPending = false;
          if (cartKey() !== key) return paint();
          if (r && r.ran && typeof r.offerDiscount === 'number') S.offer = { key: key, discount: r.offerDiscount, applied: r.offersApplied || [] };
          /* the quote IS the pre-sale dry run — kept so Complete does not ask the same question twice */
          if (r && r.ran) S.preview = { key: key, at: Date.now(), r: r };
          paint();
        }).catch(function () { S.offerPending = false; paint(); });
    }
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
          '<div class="n">' + esc(md.formatKES(t.due)) + '</div>' +
          '<div class="l">' + (t.offerDiscount > 0 ? 'Offer applied · tap to review' : 'Tap to review') + '</div>' +
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
          (t.offerDiscount > 0
            ? '<div class="msl-tot"><span>Subtotal</span><b>' + esc(md.formatKES(t.subtotal)) + '</b></div>' +
              t.offers.map(function (o) {
                return '<div class="msl-tot msl-offer"><span>🏷 ' + esc(o.label || 'Offer') + '</span><b>−' + esc(md.formatKES(o.amount)) + '</b></div>';
              }).join('')
            : '') +
          '<div class="msl-tot grand"><span>Total</span><b>' + esc(md.formatKES(t.due)) + '</b></div>' +
        '</div>' +
        '<div class="msl-sh-f">' +
          '<button class="msl-btn solid wide" data-act="charge">Charge ' + esc(md.formatKES(t.due)) + '</button>' +
          '<button class="msl-btn ghost wide" data-act="clear-cart">Cancel this sale</button>' +
        '</div>';
    }

    /* ── SOKONI POINTS (P1, 2026-09-29) ──────────────────────────────────────────────────────────────────────────
       The cashier identifies the buyer by PHONE. The server shows only a masked name and the balance; the points are
       credited by the server from the completed sale's own total — nothing typed here is a points figure. A buyer with
       no SOKONI account can have one created, with their CONSENT; SOKONI texts them, and they claim it with their own
       number and a code. The cashier never sees a password, a link or a code. */
    function buyerHTML(busy) {
      if (typeof ctx.callBuyerLookup !== 'function') return '';
      var b = S.buyer || {};
      var st = b.state || 'idle';
      var head = '<div class="msl-lbl">Customer points (optional)</div>';
      if (st === 'found') {
        return head + '<div class="msl-note msl-buyer"><b>' + esc(b.maskedName || 'SOKONI member') + '</b> · ' + esc(b.maskedPhone || '') +
          ' · Available: ' + Number(b.points || 0).toLocaleString() + ' points' +
          (b.valueKES != null ? ' · Value: KES ' + Number(b.valueKES).toFixed(2) : '') + (b.created ? ' · account created — a text is on its way' : '') +
          ' <button class="msl-btn ghost" data-act="buyer-clear"' + (busy || (S.pts && S.pts.state === 'held') ? ' disabled' : '') + ' style="min-height:32px;padding:0 10px;margin-left:6px">Change</button></div>' +
          pointsHTML(busy);
      }
      var out = head + '<div style="display:flex;gap:8px;margin-bottom:8px">' +
        '<input class="msl-inp" id="msl-bphone" inputmode="tel" autocomplete="off" placeholder="07XX XXX XXX" value="' + esc(b.phone || '') + '" aria-label="Customer phone for points" style="flex:1;margin:0">' +
        '<button class="msl-btn ghost" data-act="buyer-look"' + (busy || st === 'looking' ? ' disabled' : '') + ' style="min-height:44px">' + (st === 'looking' ? 'Checking…' : 'Look up') + '</button></div>';
      if (st === 'notfound' || st === 'creating') {
        out += '<div class="msl-note">No SOKONI account on this number. Create one so the customer earns points on this and every purchase — ' +
          'SOKONI texts them; they sign in with their own number (no smartphone needed to receive the text).</div>' +
          '<input class="msl-inp" id="msl-bname" autocomplete="off" placeholder="Customer name (optional)" value="' + esc(b.name || '') + '" aria-label="Customer name">' +
          '<label class="msl-note" style="display:flex;gap:8px;align-items:flex-start"><input type="checkbox" id="msl-bconsent"' + (b.consent ? ' checked' : '') + '> ' +
          '<span>The customer agreed to a SOKONI account on this number.</span></label>' +
          '<button class="msl-btn ghost wide" data-act="buyer-create"' + (!b.consent || st === 'creating' || busy ? ' disabled' : '') + '>' +
          (st === 'creating' ? 'Creating…' : 'Create account & continue') + '</button>';
      }
      if (st === 'error') out += '<div class="msl-note" style="color:#ffb020">' + esc(b.error || 'That did not work.') + '</div>';
      return out;
    }
    /* ── PAY WITH POINTS (P2b) ─────────────────────────────────────────────────────────────────────────────────────
       SOKONI texts the BUYER a one-time code; the buyer reads it to the cashier; only then does the server HOLD the
       points for this sale. Every figure here is the server's (points, KES value, the 25% limit). The cashier never sees
       a credential — only the code the buyer chooses to read out. */
    function pointsHTML(busy) {
      if (typeof ctx.callPointsStart !== 'function' || !(S.buyer && Number(S.buyer.points) >= 10)) return '';
      var p = S.pts || { state: 'idle' };
      if (p.state === 'held') {
        return '<div class="msl-note msl-buyer msl-pts">⭐ ' + Number(p.points).toLocaleString() + ' points = ' + esc(p.valueText || md.formatKES(p.kes)) +
          ' paid with points <button class="msl-btn ghost" data-act="pts-cancel"' + (busy ? ' disabled' : '') + ' style="min-height:32px;padding:0 10px;margin-left:6px">Remove</button></div>';
      }
      if (p.state === 'code' || p.state === 'confirming') {
        return '<div class="msl-note msl-pts">A code was texted to the customer (' + esc(p.maskedPhone || '') + '): ' + Number(p.points).toLocaleString() +
          ' points = ' + esc(p.valueText || '') + '. Ask them to read it to you.</div>' +
          '<div style="display:flex;gap:8px;margin-bottom:8px">' +
          '<input class="msl-inp" id="msl-pcode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6-digit code" value="' + esc(p.code || '') + '" aria-label="Customer\u2019s points code" style="flex:1;margin:0">' +
          '<button class="msl-btn ghost" data-act="pts-confirm"' + (busy || p.state === 'confirming' ? ' disabled' : '') + ' style="min-height:44px">' + (p.state === 'confirming' ? 'Checking…' : 'Confirm') + '</button>' +
          '<button class="msl-btn ghost" data-act="pts-cancel" style="min-height:44px">Cancel</button></div>' +
          (p.error ? '<div class="msl-note" style="color:#ffb020">' + esc(p.error) + '</div>' : '');
      }
      return '<button class="msl-btn ghost wide msl-pts" data-act="pts-start"' + (busy || p.state === 'sending' ? ' disabled' : '') + '>' +
        (p.state === 'sending' ? 'Sending the code…' : '⭐ Pay with points') + '</button>' +
        (p.error ? '<div class="msl-note" style="color:#ffb020">' + esc(p.error) + '</div>' : '');
    }
    function saleKey() { mintToken(); return md.idempotencyKey({ scope: ctx.scope, cart: S.cart, saleToken: S.saleToken }); }
    function ptsStart() {
      var t = totals();
      S.pts = { state: 'sending' }; repaintPay();
      Promise.resolve(ctx.callPointsStart({ shopId: ctx.scope && ctx.scope.shopId, phone: S.buyer && S.buyer.phone, saleKey: saleKey(), saleTotalKES: t.due }))
        .then(function (r) { var d = (r && r.data) || r || {};
          S.pts = { state: 'code', redemptionId: d.redemptionId, points: d.points, kes: d.kes, valueText: d.valueText, maskedPhone: d.maskedPhone }; repaintPay('msl-pcode'); })
        .catch(function (e) { S.pts = { state: 'idle', error: (e && e.message) || 'The code could not be sent.' }; repaintPay(); });
    }
    function ptsConfirm() {
      var p = S.pts; if (!p || !p.redemptionId) return;
      p.state = 'confirming'; p.error = null; repaintPay();
      Promise.resolve(ctx.callPointsConfirm({ shopId: ctx.scope && ctx.scope.shopId, redemptionId: p.redemptionId, code: p.code || '' }))
        .then(function (r) { var d = (r && r.data) || r || {};
          S.pts = { state: 'held', redemptionId: d.redemptionId, points: d.points, kes: d.kes, valueText: d.valueText }; S.cashGiven = null; repaintPay(); })
        .catch(function (e) { p.state = 'code'; p.error = (e && e.message) || 'That code did not work.'; repaintPay('msl-pcode'); });
    }
    function ptsCancel() {
      var p = S.pts; S.pts = null;
      if (p && p.redemptionId && typeof ctx.callPointsCancel === 'function') {
        Promise.resolve(ctx.callPointsCancel({ shopId: ctx.scope && ctx.scope.shopId, redemptionId: p.redemptionId })).catch(function () {});
      }
      repaintPay();
    }

    /* ── M-PESA / CARD THROUGH INTASEND (convergence slice 13, 2026-09-29) ───────────────────────────────────────
       All electronic money goes through IntaSend (owner). The sale asks the server for a Quick Charge payment for
       exactly what is still due, bound to THIS sale (its idempotency key): an M-PESA prompt to the customer's phone,
       or a QR the customer pays on their own phone (M-PESA or card). Only when the server says PAID is the sale
       completed — with that payment as its proof. Nothing typed here is a payment. */
    function payHTML(t, busy) {
      if (typeof ctx.callCreateIntent !== 'function' || typeof ctx.readIntent !== 'function') {
        return '<div class="msl-note">M-PESA and card payments are not available on this screen.</div>';
      }
      var p = S.pay || { state: 'idle' };
      var card = S.method === 'card';
      var out = '<div class="msl-lbl">' + (card ? 'Card (paid on the customer\u2019s phone)' : 'Customer\u2019s M-PESA number') + '</div>';
      if (p.state === 'idle' || p.state === 'failed') {
        if (!card) out += '<input class="msl-inp" id="msl-mphone" inputmode="tel" autocomplete="off" placeholder="07XX XXX XXX" value="' +
          esc(p.phone || (S.buyer && S.buyer.state === 'found' ? S.buyer.phone : '') || '') + '" aria-label="Customer M-PESA number">';
        out += '<button class="msl-btn ghost wide" data-act="pay-request"' + (busy || !(t.payable > 0) ? ' disabled' : '') + '>' +
          (card ? 'Show payment QR · ' : 'Send M-PESA request · ') + esc(md.formatKES(t.payable)) + '</button>';
        if (p.state === 'failed') out += '<div class="msl-note" style="color:#ffb020">' + esc(p.error || 'The payment did not go through.') + '</div>';
        return out;
      }
      if (p.state === 'requesting') return out + '<div class="msl-prog"><span class="msl-spin"></span>Asking IntaSend for ' + esc(md.formatKES(p.amount || t.payable)) + '…</div>';
      if (p.state === 'waiting') {
        return out + '<div class="msl-prog msl-waiting"><span class="msl-spin"></span>Waiting for the customer to pay ' + esc(md.formatKES(p.amount)) +
          (card ? ' — they scan the QR and pay on their phone.' : ' — the prompt is on their phone.') + '</div>' +
          (p.qrUrl ? '<div class="msl-qr" data-qr="' + esc(p.qrUrl) + '"></div><div class="msl-note">' + esc(p.qrUrl) + '</div>' : '') +
          '<button class="msl-btn ghost wide" data-act="pay-cancel">Stop waiting</button>';
      }
      if (p.state === 'paid') return out + '<div class="msl-note msl-buyer">✅ ' + esc(md.formatKES(p.amount)) + ' paid through IntaSend — completing the sale…</div>';
      return out;
    }
    function stopWatch() { if (S.payTimer) { clearInterval(S.payTimer); S.payTimer = null; } }
    function payRequest() {
      var t = totals();
      var p = S.pay = { state: 'requesting', amount: t.payable, phone: S.pay && S.pay.phone };
      var card = S.method === 'card';
      if (!card && !p.phone) { S.pay = { state: 'failed', error: 'Type the customer\u2019s M-PESA number.' }; return repaintPay('msl-mphone'); }
      repaintPay();
      var shopId = ctx.scope && ctx.scope.shopId;
      Promise.resolve(ctx.callMyTill({ shopId: shopId })).then(function (r) {
        var till = (r && r.data) || r || {};
        if (!till.exists || !till.sokoniTillId) throw new Error('This shop has no SOKONI Till yet, so M-PESA and card cannot be taken here.');
        return ctx.callCreateIntent({ purpose: 'pos_till_sale', sokoniTillId: till.sokoniTillId, saleId: saleKey(),
          items: [{ name: 'Till sale', price: t.payable, qty: 1 }] });
      }).then(function (r) {
        var d = (r && r.data) || r || {};
        p.ref = d.ref; p.amount = d.amount != null ? d.amount : t.payable;
        if (card) return Promise.resolve(ctx.callMintQR ? ctx.callMintQR({ ref: d.ref }) : null).then(function (q) { var qd = (q && q.data) || q || {}; p.qrUrl = qd.qrUrl || null; });
        return ctx.callStkPush({ phone: normPhone(p.phone), amount: p.amount, ref: d.ref });
      }).then(function () {
        p.state = 'waiting'; repaintPay(); drawPayQR(); watch();
      }).catch(function (e) { S.pay = { state: 'failed', phone: p.phone, error: (e && e.message) || 'The payment request could not be sent.' }; repaintPay(); });
    }
    function normPhone(v) { var c = String(v || '').replace(/[\s\-().+]/g, ''); var m = c.match(/^(?:254|0)?([17]\d{8})$/); return m ? '254' + m[1] : c; }
    function drawPayQR() {
      var el = host.querySelector('.msl-qr'); if (!el) return;
      try { if (window.SokoniQR && typeof window.SokoniQR.generateCanvas === 'function') { el.innerHTML = ''; el.appendChild(window.SokoniQR.generateCanvas(el.getAttribute('data-qr'), 180)); } } catch (_) {}
    }
    function watch() {
      stopWatch();
      var started = Date.now();
      S.payTimer = setInterval(function () {
        var p = S.pay; if (!p || !p.ref || p.state !== 'waiting') return stopWatch();
        if (Date.now() - started > 180000) { stopWatch(); S.pay = { state: 'failed', phone: p.phone, error: 'No payment yet after 3 minutes. You can send the request again.' }; return repaintPay(); }
        Promise.resolve(ctx.readIntent(p.ref)).then(function (it) {
          var st = it && it.status;
          if (st === 'paid' || st === 'completed') { stopWatch(); p.state = 'paid'; repaintPay(); complete(); }
          else if (st === 'failed' || st === 'cancelled' || st === 'expired') { stopWatch(); S.pay = { state: 'failed', phone: p.phone, error: 'The payment was ' + st + '. You can send the request again.' }; repaintPay(); }
        }).catch(function () { /* keep waiting; a read blip is not a failure */ });
      }, 3000);
    }

    function repaintPay(focusId) {
      var f = host.querySelector('.msl-sheet'); if (!f) return;
      f.innerHTML = paySheet();
      if (focusId) { var e = host.querySelector('#' + focusId); if (e) { e.focus(); try { var v = e.value || ''; e.setSelectionRange(v.length, v.length); } catch (_) {} } }
    }
    function buyerLook() {
      var b = S.buyer = Object.assign({}, S.buyer || {});
      if (!b.phone) { b.state = 'error'; b.error = 'Type the customer’s phone number.'; return repaintPay('msl-bphone'); }
      b.state = 'looking'; repaintPay();
      Promise.resolve(ctx.callBuyerLookup({ shopId: ctx.scope && ctx.scope.shopId, phone: b.phone })).then(function (r) {
        var d = (r && r.data) || r || {};
        if (d.found) Object.assign(b, { state: 'found', maskedName: d.maskedName, maskedPhone: d.maskedPhone, points: d.points, valueKES: d.valueKES, created: false });
        else b.state = 'notfound';
        repaintPay();
      }).catch(function (e) { b.state = 'error'; b.error = (e && e.message) || 'The number could not be checked.'; repaintPay(); });
    }
    function buyerCreate() {
      var b = S.buyer = Object.assign({}, S.buyer || {});
      if (!b.consent) return;
      b.state = 'creating'; repaintPay();
      Promise.resolve(ctx.callCreateBuyer({ shopId: ctx.scope && ctx.scope.shopId, phone: b.phone, name: b.name || '', consent: true })).then(function (r) {
        var d = (r && r.data) || r || {};
        Object.assign(b, { state: 'found', maskedName: d.maskedName, maskedPhone: d.maskedPhone, points: d.points, created: !!d.created });
        repaintPay();
      }).catch(function (e) { b.state = 'error'; b.error = (e && e.message) || 'The account could not be created.'; repaintPay(); });
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
              '<div class="hd">' + esc(md.formatKES(r.total != null ? r.total : t.due)) + '</div>' +
              '<div class="rc">Receipt ' + esc(r.receiptNo || '—') +
                (S.cached ? ' · already completed earlier' : '') + '</div>' +
            '</div>' +
            (r.pointsRedeemed ? '<div class="msl-note msl-buyer">⭐ ' + Number(r.pointsRedeemed.points).toLocaleString() + ' points paid ' +
              esc(md.formatKES(r.pointsRedeemed.kes)) + ' · money paid ' + esc(md.formatKES(r.paidInMoney)) + '</div>' : '') +
            (S.points && S.points.points > 0 ? '<div class="msl-note msl-buyer">⭐ ' + Number(S.points.points).toLocaleString() + ' SOKONI points credited' +
              (S.points.balance != null ? ' · balance ' + Number(S.points.balance).toLocaleString() : '') + '</div>'
              : (S.points && S.points.reason ? '<div class="msl-note">No points this time (' + esc(S.points.reason) + ').</div>' : '')) +
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
      var change = (cash && given != null && given >= t.payable) ? given - t.payable : null;

      return '<div class="msl-sh-h"><div class="t">Take payment</div>' +
          '<button class="msl-sh-x" data-act="close-sheet" aria-label="Close"' + (busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="msl-sh-b">' +
          '<div class="msl-tot grand" style="border-top:none;margin:0 0 14px;padding-top:0">' +
            '<span>Amount due</span><b>' + esc(md.formatKES(t.payable)) + '</b></div>' +
          (t.pointsKES > 0 ? '<div class="msl-note">Sale ' + esc(md.formatKES(t.due)) + ' − ' + esc(md.formatKES(t.pointsKES)) + ' paid with SOKONI points.</div>' : '') +
          (S.offerPending ? '<div class="msl-note"><span class="msl-spin"></span> Checking the shop’s offers…</div>' : '') +
          (t.offerDiscount > 0 ? '<div class="msl-note">Includes ' + t.offers.map(function (o) { return esc(o.label || 'an offer') + ' −' + esc(md.formatKES(o.amount)); }).join(', ') + '.</div>' : '') +

          (S.preflight && S.preflight.blocking
            ? '<div class="msl-warn">' + esc(S.preflight.message) + '</div>' : '') +
          (S.preflight && !S.preflight.blocking && S.preflight.message
            ? '<div class="msl-warn">' + esc(S.preflight.message) + '</div>' : '') +

          buyerHTML(busy) +
          '<div class="msl-lbl">How is the customer paying?</div>' +
          '<div class="msl-pays">' + METHODS.map(function (m) {
            return '<button class="msl-pay' + (S.method === m.id ? ' on' : '') + '" data-act="method" data-m="' + m.id + '"' +
              (busy ? ' disabled' : '') + '><span class="ic">' + m.icon + '</span>' + m.label + '</button>';
          }).join('') + '</div>' +

          (cash
            ? '<div class="msl-lbl">Cash received</div>' +
              '<div class="msl-cash">' +
                '<button data-act="tender" data-v="exact"' + (given === t.payable ? ' class="on"' : '') + '>Exact</button>' +
                CASH_STEPS.filter(function (v) { return v >= t.payable; }).slice(0, 4).map(function (v) {
                  return '<button data-act="tender" data-v="' + v + '"' + (given === v ? ' class="on"' : '') + '>' + v + '</button>';
                }).join('') +
              '</div>' +
              '<input class="msl-inp" id="msl-cash" inputmode="numeric" pattern="[0-9]*" ' +
                'placeholder="Or type the amount" value="' + (given == null ? '' : given) + '" aria-label="Cash received">' +
              (change != null
                ? '<div class="msl-tot grand"><span>Change due</span><b>' + esc(md.formatKES(change)) + '</b></div>'
                : (given != null && given < t.payable
                    ? '<div class="msl-note" style="color:#ffb020">That is less than the amount due.</div>' : ''))
            : payHTML(t, busy)) +

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
            (busy || S.offerPending || (S.pts && (S.pts.state === 'code' || S.pts.state === 'confirming' || S.pts.state === 'sending')) || (cash && given != null && given < t.payable)
              || (!cash && t.payable > 0 && !(S.pay && S.pay.state === 'paid')) ? ' disabled' : '') + '>' +
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
    function mintToken() {
      if (S.saleToken) return S.saleToken;
      var rnd = Math.random().toString(36).slice(2, 10);
      S.saleToken = String(Date.now().toString(36)) + rnd;
      return S.saleToken;
    }

    function openPay() {
      if (!S.cart.length) return;
      mintToken();
      S.sheet = 'pay'; S.sale = 'idle'; S.saleError = null; S.preflight = null;
      S.cashGiven = null;
      quoteOffers();                                   /* U7c2: the server's offer figure for THIS cart */
      paint();
    }

    function newSale() {
      stopWatch(); S.pay = null;
      S.cart = []; S.saleToken = null; S.sheet = null; S.sale = 'idle'; S.buyer = null; S.points = null; S.pts = null;
      S.receipt = null; S.cached = false; S.saleError = null; S.preflight = null; S.cashGiven = null;
      /* Re-read the catalogue: the sale just changed canonical stock, and the next
         customer must not be sold against the pre-sale numbers. */
      load();
    }

    function tender(method, amount) {
      var o = { method: method, amount: amount };
      if (method !== 'cash' && S.pay && S.pay.state === 'paid' && S.pay.ref) o.intentRef = S.pay.ref;   /* the IntaSend proof */
      return o;
    }
    function payments() {
      var t = totals();
      if (t.pointsKES > 0) {
        var ps = [{ method: 'points', amount: t.pointsKES, redemptionId: S.pts.redemptionId }];
        if (t.payable > 0) ps.push(tender(S.method, t.payable));
        return ps;
      }
      return [tender(S.method, t.due)];
    }

    /* Pre-charge guard. Uses the server's own side-effect-free dry run: it prices
       the cart against canonical `products` and reports the stock deltas WITHOUT
       claiming an idempotency key or writing anything.

       A check that could not RUN is reported as "not checked" and does not block —
       the real transaction re-validates atomically and is the actual authority.
       What must never happen is an unavailable check being treated as a pass. */
    function preflight() {
      if (typeof ctx.callSale !== 'function') return Promise.resolve({ blocking: false, message: null });
      /* U7c2: the dry run taken when Charge was tapped answers for THIS cart once, if fresh; a retry asks again. */
      var fresh = (S.preview && S.preview.key === cartKey() && Date.now() - S.preview.at < 60000) ? S.preview.r : null;
      S.preview = null;
      return (fresh ? Promise.resolve(fresh) : md.previewSale({
        scope: ctx.scope, cart: S.cart, saleToken: S.saleToken,
        payments: payments(), callable: ctx.callSale,
      })).then(function (r) {
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
        /* U7c2: the offers must be READ, and must match what this screen is showing — otherwise the customer would
           be charged a figure they were not shown. A change is shown first; the cashier completes again. */
        if (r.offersUnavailable) {
          return { blocking: true, message: 'The shop’s offers could not be checked just now, so nothing was charged. Try again in a moment.' };
        }
        var shown = totals();
        if (typeof r.offerDiscount === 'number' && (!shown.offersChecked || Math.abs(r.offerDiscount - shown.offerDiscount) > 0.5)) {
          S.offer = { key: cartKey(), discount: r.offerDiscount, applied: r.offersApplied || [] };
          return { blocking: true, message: 'The shop’s offers changed this total to ' + md.formatKES(Math.max(0, shown.subtotal - r.offerDiscount)) +
            '. Check the amount with the customer, then complete the sale.' };
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
          offerDiscount: totals().offerDiscount,          /* U7c2: the server's own figure, re-checked by the sale */
          buyerPhone: (S.buyer && S.buyer.state === 'found') ? S.buyer.phone : null,   /* Points P1: WHO, never how many */
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
          S.points = sale.pointsEarned || null;
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
                                      if (S.pts && S.pts.redemptionId) ptsCancel();   /* P2b: bound to this cart — give the points back */
                                    } else S.sheet = null;
                                    paint(); return; }
      if (act === 'charge')       { S.startedAt = Date.now(); openPay(); return; }
      if (act === 'clear-cart')   { S.cart = []; S.sheet = null; S.saleToken = null; paint(); return; }
      if (act === 'inc')          { var l1 = S.cart[i]; if (l1) { S.cart = md.setLineQty(S.cart, l1.productId, l1.qty + 1); paint(); } return; }
      if (act === 'dec')          { var l2 = S.cart[i]; if (l2) { S.cart = md.setLineQty(S.cart, l2.productId, l2.qty - 1);
                                    if (!S.cart.length) S.sheet = null; paint(); } return; }
      if (act === 'method')       { if (S.pay && (S.pay.state === 'waiting' || S.pay.state === 'paid')) return;
                                    S.method = el.getAttribute('data-m') || 'cash'; S.cashGiven = null; stopWatch(); S.pay = null; paint(); return; }
      if (act === 'tender')       { var v = el.getAttribute('data-v');
                                    S.cashGiven = (v === 'exact') ? totals().payable : Number(v); paint(); return; }
      if (act === 'complete')     { complete(); return; }
      if (act === 'new-sale')     { newSale(); return; }
      if (act === 'buyer-look')   { buyerLook(); return; }
      if (act === 'buyer-create') { buyerCreate(); return; }
      if (act === 'buyer-clear')  { S.buyer = { phone: '' }; repaintPay('msl-bphone'); return; }
      if (act === 'pay-request')  { payRequest(); return; }
      if (act === 'pay-cancel')   { stopWatch(); S.pay = { state: 'idle', phone: S.pay && S.pay.phone }; repaintPay(); return; }
      if (act === 'pts-start')    { ptsStart(); return; }
      if (act === 'pts-confirm')  { ptsConfirm(); return; }
      if (act === 'pts-cancel')   { ptsCancel(); return; }
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
      if (el.id === 'msl-mphone') { S.pay = Object.assign({}, S.pay || { state: 'idle' }, { phone: el.value }); return; }
      if (el.id === 'msl-pcode')  { if (S.pts) S.pts.code = String(el.value || '').replace(/\D/g, '').slice(0, 6); return; }
      if (el.id === 'msl-bphone') { S.buyer = Object.assign({}, S.buyer || {}, { phone: el.value, state: 'idle' }); return; }
      if (el.id === 'msl-bname')  { S.buyer = Object.assign({}, S.buyer || {}, { name: el.value }); return; }
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
      /* Points P1: the customer's consent to an account — nothing is created without it */
      if (el && el.id === 'msl-bconsent') { S.buyer = Object.assign({}, S.buyer || {}, { consent: !!el.checked }); repaintPay(); }
    }

    host.addEventListener('click', onClick);
    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);

    load();

    return {
      refresh: load,
      state: function () { return S; },
      destroy: function () {
        stopWatch();
        host.removeEventListener('click', onClick);
        host.removeEventListener('input', onInput);
        host.removeEventListener('change', onChange);
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID, METHODS: METHODS };
}));
