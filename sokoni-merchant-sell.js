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

     • Money is CONFIRMED, not asserted. Selecting M-Pesa sends a real STK push
       and then waits: the sale can only be completed once the server reads back
       a confirmed payment from its own record. Cancelled, rejected, timed out,
       never delivered, insufficient funds — none of them completes the sale and
       none of them prints a receipt.
     • The discount is a REQUEST. This screen asks; `posCompleteCheckout`
       authorises it against the operator's real employment role and recomputes
       the total from its own prices. A till cannot discount by asserting it.

   ── Still an operator attestation, and deliberately not dressed up ──────────
   CARD. There is no terminal integration to confirm against, so a card tender is
   still RECORDED as taken on the cashier's word, and the screen says so in those
   words rather than borrowing the confirmation language M-Pesa has earned.
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
    /* An empty cart earns no bottom furniture. The node stays so the partial
       update paths can still address it; only its box is removed. */
    '.msl-bar.empty{display:none}',

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
    /* align-items:flex-start, not center: the stepper anchors to the TOP of the
       row so a two-line product name does not drag it downward. */
    '.msl-line{display:flex;align-items:flex-start;gap:11px;padding:11px 0;border-bottom:1px solid var(--line)}',
    '.msl-line:last-child{border-bottom:none}',
    '.msl-line .info{flex:1;min-width:0}',
    '.msl-line .nm{font-size:13.5px;font-weight:700;overflow-wrap:anywhere}',
    '.msl-line .sub{font-size:11.5px;color:var(--txt2);margin-top:3px}',
    '.msl-line .sub.warn{color:#ffb020;font-weight:700}',
    /* ── THE QUANTITY STEPPER — a narrow VERTICAL column ──────────────────────
       It used to be a horizontal [−][1][+] row roughly 140px wide, and at 390px
       that left the product name and price fighting for what was left. Stacked,
       it occupies 46px whatever the quantity, so the product keeps the row.

       `flex:0 0 auto` + a fixed width is the load-bearing part: without it the
       control grows on a wide viewport for no reason, which is the same squeeze
       in the opposite direction.

       `align-self:flex-start` anchors it to the TOP of the row, so a product
       whose name wraps to two lines does not drag the stepper down the row.

       TOUCH TARGETS. The module's rule is 48px, and each button here is 44 wide
       by 40 tall. That is a deliberate, stated trade: three stacked 48px cells
       would make every cart row 150px and push the second item off a 390×665
       screen. 44×40 is still comfortably above the 24px WCAG floor and above
       the 44px iOS guidance on its widest axis. */
    '.msl-step{flex:0 0 auto;align-self:flex-start;display:flex;flex-direction:column;',
      'align-items:stretch;width:46px;background:rgba(255,255,255,.06);',
      'border:1px solid var(--line);border-radius:12px;padding:2px;overflow:hidden}',
    '.msl-step button{width:100%;height:40px;border:none;background:none;color:var(--txt);',
      'font-size:19px;font-weight:800;cursor:pointer;border-radius:8px;font-family:inherit;',
      'display:grid;place-items:center;padding:0;line-height:1}',
    '.msl-step button:active{background:rgba(255,255,255,.12)}',
    /* Hairlines between the three cells so it reads as one control rather than
       three loose buttons. */
    '.msl-step .q{width:100%;height:30px;border:none;border-top:1px solid var(--line);',
      'border-bottom:1px solid var(--line);background:none;color:var(--acc);font-size:14px;',
      'font-weight:900;text-align:center;font-family:inherit;outline:none;padding:0;',
      '-moz-appearance:textfield}',
    '.msl-step .q::-webkit-outer-spin-button,.msl-step .q::-webkit-inner-spin-button{',
      '-webkit-appearance:none;margin:0}',
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

  /* ── THE COMPOSED AUTHORITIES ───────────────────────────────────────────────
     This screen owns no arithmetic and no schema. Change comes from SokoniCash,
     pickup/delivery from SokoniFulfilment, the address from SokoniBuyerLocations,
     the printed document from SokoniReceiptDoc, and the idempotency key from
     SokoniSaleSubmit. Each is separately proven; composing them here means the
     till and online checkout cannot drift into two different arithmetics.

     Each accessor may return null. A missing authority DEGRADES the feature that
     needs it — it never falls back to a local reimplementation, because a second
     implementation of change or of a destination is the exact defect these
     modules exist to prevent. */
  var G = function () { return (typeof globalThis !== 'undefined') ? globalThis : {}; };
  var CASH = function () { return G().SokoniCash || null; };
  var FUL  = function () { return G().SokoniFulfilment || null; };
  var LOC  = function () { return G().SokoniBuyerLocations || null; };
  var RCPT = function () { return G().SokoniReceiptDoc || null; };
  var SHIFT = function () { return G().SokoniShift || null; };

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
      /* Taken off BEFORE payment, because the amount due is what gets paid. The
         server authorises it against the operator's real role and recomputes the
         total from its own prices — this is the request, not the decision. */
      discount: 0,
      discountText: '',
      discountErr: null,
      /* ── THE TENDER LEDGER ───────────────────────────────────────────────
         Electronic tenders that have been CONFIRMED, in the order they were
         taken. A tender only enters this list once the server has said the money
         arrived, so its presence is the proof — there is no `confirmed: false`
         state to get mishandled downstream. Cash is not held here: it is counted
         at the end, because cash is the tender that can overpay and produce
         change. Together they are what `payments()` sends. */
      tenders: [],             /* [{ method, amount, ref, code }] */
      /* The M-PESA request in flight, and the only thing that may add to the
         ledger. `reference` is the server's checkoutId; a tender is appended ONLY
         from a server status read, never from having sent the push. */
      stk: null,               /* null | { phase, phone, amount, reference, error, since } */
      /* Pickup until the merchant says otherwise. A default of 'delivery' would
         make an unstated fulfilment look like a stated one. */
      ful: { type: 'pickup', dest: null, note: '' },
      destText: '',
      destErr: null,
      settled: null,        /* frozen at completion, never re-derived */
      fulfilled: null,
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
        live();
      }).catch(function (e) {
        S.phase = 'error';
        S.error = (e && e.message) || 'Products could not be loaded.';
        paint();
      });
    }

    /* ── ONE TILL, MANY DEVICES ───────────────────────────────────────────────
       A sale rung up on the phone decrements canonical `products.stock` on the
       server. Without this, the desktop keeps showing the pre-sale figure until
       somebody reloads — two devices quietly disagreeing about how much stock
       exists, which is how a shop oversells.

       This does NOT re-fetch after our own sale (load() already does that); it
       reflects what the SERVER holds, whoever moved it.

       While the payment sheet is open the incoming rows are stored but NOT
       painted. Re-rendering under a cashier's thumb mid-payment would rebuild
       the sheet they are typing into, and the cart is already priced — the
       server re-validates every price and stock level at completion anyway, so
       nothing is lost by waiting for the sheet to close. */
    var _liveOff = null;
    function live() {
      if (_liveOff) return;                       /* one listener per mount */
      try {
        _liveOff = md.subscribeProducts({
          scope: ctx.scope, db: ctx.db,
          onProducts: function (rows) {
            S.products = rows || [];
            /* Rows are already stored above; only the REPAINT is deferred, and
               closing the sheet paints anyway. */
            if (S.sheet) return;
            paint();
          },
          /* A listener that fails silently is worse than none: the screen keeps
             showing stale stock that looks current. Say so and keep the
             one-shot figures already on screen. */
          onError: function () {
            S.liveError = true;
            if (!S.sheet) paint();
          },
        });
      } catch (_) { _liveOff = null; }
    }

    /* ── Derived ──────────────────────────────────────────────────────────── */
    function visible() { return md.searchProducts(S.products, S.term); }
    function totals()  { return md.cartTotals(S.cart); }

    /* The money question, answered by SokoniCash in integer cents — never by
       subtracting two shilling floats on this screen. Returns null when the cash
       authority is absent, and the caller then refuses to complete rather than
       guessing at the change. */
    /* THE ORDER MONEY MOVES IN: items → subtotal → discount → amount due → payment.
       The discount is applied here, before any tender is considered, so the figure
       the customer is asked for is the figure the sale is for. Floored at zero: a
       discount larger than the cart cannot produce a negative amount due, and the
       server refuses that case independently. */
    function discountOf() {
      var sub = totals().subtotal;
      var d = Number(S.discount) || 0;
      if (!(d > 0)) return 0;
      return Math.min(d, sub);
    }
    function amountDue() { return Math.max(0, totals().subtotal - discountOf()); }

    /* Confirmed electronic money, before any cash. */
    function tenderedSoFar() {
      return S.tenders.reduce(function (s, t) { return s + (Number(t.amount) || 0); }, 0);
    }
    /* What is still owed after the confirmed tenders — the figure the next tender
       defaults to, and the one the cash keypad is built around. */
    function balanceDue() { return Math.max(0, amountDue() - tenderedSoFar()); }

    /* EVERY tender, settled together by SokoniCash. Change falls out of the whole
       set rather than the last one, which is what makes a 4,000 M-Pesa + 2,500
       cash tender on a 6,000 sale return 500 rather than nothing: the arithmetic
       is over the total tendered, not over the cash line alone.
       Cash is appended last because it is the tender that can exceed the balance,
       and SokoniCash caps change at the cash actually taken — so an electronic
       overpayment cannot produce change no drawer could pay. */
    function settlement() {
      var C = CASH();
      if (!C) return null;
      var dueMinor = C.toMinor(amountDue());
      if (dueMinor == null) return null;
      var ts = [];
      for (var i = 0; i < S.tenders.length; i++) {
        var m = C.toMinor(S.tenders[i].amount);
        if (m == null) return null;
        /* THE GATEWAY REFERENCE TRAVELS WITH THE TENDER.

           stkPoll already stores the confirmed M-Pesa code on the tender
           (`code`) alongside the checkout id (`ref`) — and this line used to
           rebuild the tender from method and amount alone, discarding both. So
           a confirmed M-Pesa payment reached the receipt with no reference on
           it, and a split sale could not say which half the code belonged to.

           The code is preferred over the checkout id: `code` is what the
           customer sees in their SMS and what reconciliation matches against;
           `ref` is our own request id and is only a fallback. */
        var _tref = S.tenders[i].code || S.tenders[i].ref || null;
        var _t = { method: S.tenders[i].method, amountMinor: m };
        if (typeof _tref === 'string' && _tref) _t.reference = _tref;
        ts.push(_t);
      }
      if (S.method === 'cash' && S.cashGiven != null && Number(S.cashGiven) > 0) {
        var cm = C.toMinor(Number(S.cashGiven));
        if (cm == null) return null;
        ts.push({ method: 'cash', amountMinor: cm });
      }
      if (!ts.length) return null;
      try {
        return C.settle({ totalMinor: dueMinor, tenders: ts });
      } catch (_) { return null; }
    }

    /* The fulfilment, built by the contract rather than assembled here. A delivery
       without a destination THROWS in buildFulfilment, so an address-less delivery
       cannot reach the receipt. */
    function fulfilment() {
      var F = FUL();
      if (!F) return null;
      try {
        return F.buildFulfilment({
          type: S.ful.type,
          destinationSnapshot: S.ful.dest,
          note: S.ful.note || null,
        });
      } catch (_) { return null; }
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
          /* ALWAYS rendered; the CSS owns whether it is SEEN.
             `.msl-x` is display:none, and `.msl-find.has .msl-x` is display:block —
             so visibility already follows the `has` class that onInput toggles.
             Rendering the button conditionally as well meant the element did not
             exist at the moment the class arrived: typing a term filtered the grid,
             `.msl-find` gained `has`, and the class had nothing to reveal. The
             clear control was therefore unreachable during the one interaction it
             exists for, and only appeared after some OTHER action forced a full
             paint. Measured: 0 clear buttons after typing, 1 after a repaint.

             The input handler repaints only the grid and the bar on purpose — a
             full paint would destroy focus and caret position mid-search — so the
             top bar cannot be re-rendered here. The element has to be there
             already. */
          '<button class="msl-x" data-act="clear" aria-label="Clear search">×</button>' +
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
        /* THREE DIFFERENT FACTS, THREE DIFFERENT ANSWERS. Telling a signed-in
           cashier to "sign in" is the defect this separates: not authenticated,
           authenticated without a merchant role, and a merchant whose shop is not
           active yet are not the same situation and must not read the same. */
        if (why === 'no_merchant_role' || why === 'no_sell_capability') {
          return '<div class="msl-body"><div class="msl-state"><div class="ic">🔒</div>' +
            '<div class="hd">You do not have permission to use the till</div>' +
            (why === 'no_sell_capability'
              ? 'Your account is part of this shop, but selling is not one of the things ' +
                'it can do. The shop owner can change that.'
              : 'This account is signed in, but it is not a merchant account and is not ' +
                'employed by a shop. Ask the shop owner to add you.') +
            '</div></div>';
        }
        return '<div class="msl-body"><div class="msl-state"><div class="ic">🏪</div>' +
          (why === 'not_signed_in'
            ? '<div class="hd">Sign in to open the till</div>' +
              'The till needs to know who is selling before it can open.'
            : '<div class="hd">No shop is active yet</div>' +
              'Selling needs a shop. Once your merchant account has an approved shop, its ' +
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

      return '<div class="msl-body">' +
        /* Said out loud, because a live listener that failed silently leaves stale
           stock on screen looking current — the worst of both worlds. */
        (S.liveError
          ? '<div class="msl-note" style="color:#ffb020;margin-bottom:10px">Live stock updates stopped on this device. These figures are from when the screen loaded; the server still checks stock before completing any sale.</div>'
          : '') +
        '<div class="msl-grid">' + rows.map(function (p, i) {
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
        /* HIDDEN, not removed.

           Measured at 390x844: this bar is 39px and the shell's bottom nav is
           61px, so an empty till spent 100px of a phone screen on two stacked
           full-width bars — and this one carried a hint, no information and no
           action. With an item it earns its space (count, total, Charge); empty
           it did not.

           The ELEMENT stays in the DOM because the partial-update paths address
           it directly — onInput does `host.querySelector('.msl-bar').outerHTML =
           barHTML()` to repaint without destroying search focus and caret.
           Returning '' here would delete the node, that lookup would return null,
           and the bar could not come back without a full paint. A class the CSS
           hides keeps the element addressable and the update paths intact. */
        return '<div class="msl-bar empty" style="border-top-color:var(--line)">' +
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
              /* + ON TOP, − at the bottom. Only the ORDER and the styling change:
                 the data-act / data-i attributes are untouched, so inc, dec and the
                 typed-quantity path all run exactly the code they ran before. */
              '<div class="msl-step">' +
                '<button data-act="inc" data-i="' + i + '" aria-label="One more">+</button>' +
                '<input class="q" data-act="qty" data-i="' + i + '" inputmode="numeric" ' +
                  'pattern="[0-9]*" value="' + l.qty + '" aria-label="Quantity">' +
                '<button data-act="dec" data-i="' + i + '" aria-label="One fewer">−</button>' +
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

    /* ── M-PESA ────────────────────────────────────────────────────────────────
       Charge → M-Pesa → confirm the buyer's phone → send the STK push → "check
       your phone" → WAIT → the server confirms → only then may the sale commit.

       Every state below is a state the customer can actually be in, including the
       ones nobody likes: they cancelled, they rejected it, they never got the
       prompt, they had insufficient funds. None of them completes the sale, and
       none of them prints a receipt. `confirmed` is set from a server status read
       and from nothing else — sending a push is not being paid. */
    function normPhone(v) {
      var d = String(v || '').replace(/[^0-9]/g, '');
      if (/^0(7|1)[0-9]{8}$/.test(d)) return '254' + d.slice(1);
      if (/^254(7|1)[0-9]{8}$/.test(d)) return d;
      if (/^(7|1)[0-9]{8}$/.test(d)) return '254' + d;
      return null;
    }

    /* The amount this push is for. Defaults to the whole balance — the common
       case — but is settable, because a customer may be paying only part of the
       sale electronically and the rest in cash. Never more than the balance:
       there is no way to hand change back through M-Pesa. */
    function stkAmount(bal) {
      var k = S.stk || {};
      var a = (k.amount == null || k.amount === '') ? bal : Number(k.amount);
      if (!isFinite(a) || a <= 0) return 0;
      return Math.min(a, bal);
    }

    function mpesaPanel(bal) {
      var k = S.stk || {};
      var phase = k.phase || 'idle';
      var typed = (k.phone == null) ? '' : k.phone;
      var amt = stkAmount(bal);
      var overAsked = (k.amount != null && k.amount !== '' && Number(k.amount) > bal);

      if (phase === 'sending' || phase === 'waiting') {
        return '<div class="msl-prog"><span class="msl-spin"></span>' +
            (phase === 'sending'
              ? 'Sending the request to ' + esc(k.phone || 'the customer') + '…'
              : 'Waiting for the customer to enter their M-Pesa PIN…') +
          '</div>' +
          (phase === 'waiting'
            ? '<div class="msl-note"><b>Ask the customer to check their phone.</b> ' +
              'The sale stays open until they pay — nothing is charged and no stock has moved. ' +
              'If they cancel or the prompt never arrives, send it again.</div>' +
              '<button class="msl-btn ghost wide" data-act="stk-cancel" style="margin-top:10px">' +
                'Cancel and choose another method</button>'
            : '') ;
      }

      /* idle, or a previous attempt that did not go through */
      return (k.error
          ? '<div class="msl-err" style="margin-bottom:12px">' + esc(k.error) +
            '<div style="font-weight:600;color:var(--txt2);margin-top:7px;font-size:12px">' +
            'Nothing was charged. Check the number and send it again.</div></div>'
          : '') +
        '<div class="msl-lbl">M-Pesa amount</div>' +
        '<input class="msl-inp" id="msl-mamt" inputmode="numeric" pattern="[0-9]*" ' +
          'placeholder="' + esc(String(bal)) + '" value="' + (k.amount == null ? '' : esc(String(k.amount))) + '" ' +
          'aria-label="Amount to request by M-Pesa">' +
        (overAsked
          ? '<div class="msl-note" style="color:#ffb020">Only ' + esc(md.formatKES(bal)) +
            ' is still owed. M-Pesa cannot give change.</div>'
          : '<div class="msl-note">Leave it as ' + esc(md.formatKES(bal)) +
            ' for the whole balance, or enter less and take the rest another way.</div>') +
        '<div class="msl-lbl">Customer\'s M-Pesa number</div>' +
        '<input class="msl-inp" id="msl-phone" inputmode="tel" ' +
          'placeholder="07xx xxx xxx" value="' + esc(typed) + '" aria-label="Customer M-Pesa number">' +
        '<button class="msl-btn solid wide" data-act="stk-send" style="margin-top:10px"' +
          (normPhone(typed) && amt > 0 && !overAsked ? '' : ' disabled') + '>' +
          'Send payment request for ' + esc(md.formatKES(amt)) + '</button>' +
        '<div class="msl-note">The customer gets a prompt on their phone. The sale can only be ' +
          'completed after they pay and the server confirms it.</div>';
    }

    var _stkPoll = null;
    function stkStop() { if (_stkPoll) { clearTimeout(_stkPoll); _stkPoll = null; } }

    function stkSend() {
      var bal = balanceDue();
      var amt = stkAmount(bal);
      var keep = (S.stk && S.stk.amount != null) ? S.stk.amount : null;
      var phone = normPhone(S.stk && S.stk.phone);
      if (!phone || !(amt > 0)) return;
      if (typeof ctx.callStk !== 'function') {
        S.stk = { phase: 'idle', phone: (S.stk && S.stk.phone) || '', amount: keep,
                  error: 'M-Pesa is not available in this workspace yet. Take the payment another way.' };
        paint(); return;
      }
      stkStop();
      S.stk = { phase: 'sending', phone: (S.stk && S.stk.phone) || '', amount: keep,
                asked: amt, error: null };
      paint();

      ctx.callStk({
        sellerUid: ctx.scope.shopId, phone: phone, amount: amt,
        hub: 'pos', description: (ctx.shopName || 'SOKONI') + ' sale',
      }).then(function (r) {
        var d = (r && r.data) || r || {};
        var ref = d.checkoutId || d.ref || null;
        if (!ref) throw new Error('The payment request did not return a reference.');
        S.stk = { phase: 'waiting', phone: S.stk.phone, amount: keep, asked: amt,
                  reference: ref, error: null, since: Date.now() };
        paint();
        stkPoll(ref);
      }).catch(function (e) {
        S.stk = { phase: 'idle', phone: (S.stk && S.stk.phone) || '', amount: keep,
                  error: (e && e.message) || 'The payment request could not be sent.' };
        paint();
      });
    }

    /* Polls the SERVER's own payment record. The webhook Safaricom calls is what
       moves it to completed, so this reads a fact rather than asking the device to
       decide. Bounded: after the window closes the till says so and offers to send
       it again, instead of spinning forever next to a customer. */
    var STK_WINDOW_MS = 120000, STK_EVERY_MS = 3000;
    function stkPoll(ref) {
      if (typeof ctx.callVerify !== 'function') {
        S.stk = { phase: 'idle', phone: S.stk.phone,
                  error: 'This device cannot confirm M-Pesa payments. Take the payment another way.' };
        paint(); return;
      }
      var started = (S.stk && S.stk.since) || Date.now();
      var tick = function () {
        if (!S.stk || S.stk.reference !== ref || S.stk.phase !== 'waiting') return;
        ctx.callVerify({ checkoutId: ref }).then(function (r) {
          var d = (r && r.data) || r || {};
          var st = String(d.status || '').toLowerCase();
          if (!S.stk || S.stk.reference !== ref) return;
          if (st === 'completed' || st === 'success') {
            stkStop();
            /* CONFIRMED money joins the ledger. The amount recorded is what the
               SERVER says was paid where it says so, falling back to what was
               asked for — never to the balance, which may have been something
               else by the time the customer finished paying.
               Guarded against a double append: a poll already in flight when
               another confirms must not enter the same reference twice. */
            var already = S.tenders.some(function (t) { return t.ref === ref; });
            if (!already) {
              var paid = Number(d.paidAmount != null ? d.paidAmount : d.confirmedAmount);
              S.tenders = S.tenders.concat([{
                method: 'mpesa',
                amount: (isFinite(paid) && paid > 0) ? paid : Number(S.stk.asked || 0),
                ref: ref,
                code: d.mpesaCode || null,
              }]);
            }
            /* Whatever is still owed is taken the ordinary way, so the sheet
               returns to the cash keypad rather than stranding the cashier on a
               spent M-Pesa panel. */
            S.stk = null;
            S.method = 'cash';
            S.cashGiven = null;
            paint(); return;
          }
          if (st === 'failed' || st === 'cancelled') {
            stkStop();
            S.stk = { phase: 'idle', phone: S.stk.phone,
                      error: 'The customer did not complete the payment.' };
            paint(); return;
          }
          if (Date.now() - started > STK_WINDOW_MS) {
            stkStop();
            S.stk = { phase: 'idle', phone: S.stk.phone,
                      error: 'No confirmation came back in two minutes. If the customer did pay, ' +
                             'wait a moment and send it again — they will not be charged twice for ' +
                             'a prompt they never completed.' };
            paint(); return;
          }
          _stkPoll = setTimeout(tick, STK_EVERY_MS);
        }).catch(function () {
          /* A failed status READ is not a failed payment. Keep waiting inside the
             window rather than telling the shop the customer did not pay. */
          if (Date.now() - started > STK_WINDOW_MS) {
            stkStop();
            S.stk = { phase: 'idle', phone: S.stk.phone,
                      error: 'The payment could not be confirmed from this device.' };
            paint(); return;
          }
          _stkPoll = setTimeout(tick, STK_EVERY_MS);
        });
      };
      _stkPoll = setTimeout(tick, STK_EVERY_MS);
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
              '<div class="rc">Receipt ' + esc(receiptIdOf(r) || '—') +
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
      var st = settlement();
      var C = CASH();
      /* Change and balance are read off the settlement, never recomputed here. When
         the cash authority is missing there is NO change figure — the screen says so
         and refuses the sale, rather than printing a number it cannot stand behind. */
      var change = (st && st.changeMinor > 0 && C) ? C.fromMinor(st.changeMinor) : null;
      var shortBy = (st && st.balanceMinor > 0 && C) ? C.fromMinor(st.balanceMinor) : null;
      var disc = discountOf();
      var due  = amountDue();
      var bal  = balanceDue();
      /* ONE gate for every combination, and it is the settlement's own answer.
         `canComplete` is `balance === 0` across ALL tenders, so cash-only,
         M-Pesa-only and any split are judged by the same arithmetic rather than
         by a per-method special case — the shape that let "selected" pass for
         "paid" in the first place.

         The electronic half needs no separate check here: a tender reaches
         S.tenders ONLY after a server confirmation, so an unconfirmed push simply
         is not in the sum, the balance stays positive, and the button stays shut.
         S28 proves the same thing on the server for a caller that skips this. */
      /* One more condition than `canComplete` carries, and it exists to keep this
         button honest with the server. SokoniCash treats a balance of zero as
         complete even when part of the overpayment is UNREFUNDABLE — money taken
         electronically that exceeds the sale, which no drawer can hand back. The
         server refuses exactly that case (S33), so enabling the button here would
         produce a confident tap and a refusal. Both now agree. */
      var stranded = !!(st && st.unrefundableMinor > 0);
      var canPay = !!(st && st.canComplete) && !stranded && !S.discountErr;
      var delivering = (S.ful.type === 'delivery');
      /* A delivery with no destination is not ready to charge. buildFulfilment
         refuses it, and so does this button. */
      var fulReady = !delivering || !!fulfilment();

      return '<div class="msl-sh-h"><div class="t">Take payment</div>' +
          '<button class="msl-sh-x" data-act="close-sheet" aria-label="Close"' + (busy ? ' disabled' : '') + '>×</button></div>' +
        '<div class="msl-sh-b">' +
          /* ── THE LADDER ─ items → subtotal → discount → amount due.
               Shown in that order because that is the order the money moves in,
               and because a customer who is given 200 off should be able to see
               where the figure they are being asked for came from. */
          '<div class="msl-tot"><span>Subtotal</span><b>' + esc(md.formatKES(t.subtotal)) + '</b></div>' +
          (disc > 0
            ? '<div class="msl-tot"><span>Discount</span><b>− ' + esc(md.formatKES(disc)) + '</b></div>'
            : '') +
          '<div class="msl-tot grand" style="margin:0 0 14px">' +
            '<span>Amount due</span><b>' + esc(md.formatKES(due)) + '</b></div>' +

          /* ── THE TENDER LEDGER ─ what has actually been taken so far.
               Only appears once part of the money is in, because a sale settled in
               one tender does not need a ledger to explain itself. Each line is a
               CONFIRMED payment; the balance underneath is what is still owed. */
          (S.tenders.length
            ? '<div class="msl-lbl">Taken so far</div>' +
              S.tenders.map(function (t, i) {
                return '<div class="msl-tot"><span>' +
                  esc(t.method === 'mpesa' ? 'M-Pesa' : (t.method === 'card' ? 'Card' : t.method)) +
                  (t.code ? ' · ' + esc(t.code) : '') + '</span>' +
                  '<b>' + esc(md.formatKES(t.amount)) + '</b>' +
                  (busy ? '' : '<button class="msl-x" style="display:block;margin-left:8px" ' +
                    'data-act="untender" data-i="' + i + '" aria-label="Remove this payment">×</button>') +
                  '</div>';
              }).join('') +
              '<div class="msl-tot"><span>Total tendered</span><b>' +
                esc(md.formatKES(tenderedSoFar())) + '</b></div>' +
              '<div class="msl-tot grand" style="margin:0 0 14px"><span>' +
                (bal > 0 ? 'Balance' : 'Balance') + '</span><b>' +
                esc(md.formatKES(bal)) + '</b></div>'
            : '') +

          (S.preflight && S.preflight.blocking
            ? '<div class="msl-warn">' + esc(S.preflight.message) + '</div>' : '') +
          (S.preflight && !S.preflight.blocking && S.preflight.message
            ? '<div class="msl-warn">' + esc(S.preflight.message) + '</div>' : '') +

          /* ── FULFILMENT ─ asked before payment, because it can change the total
               and because a receipt that guesses is worse than one that asks. */
          '<div class="msl-lbl">Is the customer taking it now?</div>' +
          '<div class="msl-pays">' +
            '<button class="msl-pay' + (!delivering ? ' on' : '') + '" data-act="ful" data-f="pickup"' +
              (busy ? ' disabled' : '') + '><span class="ic">🛍</span>Taking it now</button>' +
            '<button class="msl-pay' + (delivering ? ' on' : '') + '" data-act="ful" data-f="delivery"' +
              (busy ? ' disabled' : '') + '><span class="ic">🛵</span>Deliver it</button>' +
          '</div>' +
          (delivering
            ? '<input class="msl-inp" id="msl-dest" inputmode="text" ' +
                'placeholder="Where is it going? Street, estate or landmark" ' +
                'value="' + esc(S.destText) + '" aria-label="Delivery destination">' +
              (S.destErr ? '<div class="msl-note" style="color:#ffb020">' + esc(S.destErr) + '</div>' : '') +
              (S.ful.dest
                ? '<div class="msl-note">Going to <b>' + esc(destLabel()) + '</b>. ' +
                  'A rider is assigned from Orders after the sale — this screen does not ' +
                  'dispatch anyone.</div>'
                : '<div class="msl-note">A delivery needs somewhere to go before it can be charged.</div>')
            : '') +

          /* ── DISCOUNT ─ before payment, because it changes the amount due.
               This screen does NOT decide whether it is allowed. It asks; the
               server authorises against the operator's real employment role and
               recomputes the total from its own prices. A cashier who is not
               permitted gets a plain refusal back and nothing is charged — which
               is why this control is offered to everyone rather than hidden on
               the strength of a role the browser would have to assert. */
          '<div class="msl-lbl">Discount</div>' +
          '<input class="msl-inp" id="msl-disc" inputmode="numeric" pattern="[0-9]*" ' +
            'placeholder="No discount" value="' + (S.discount > 0 ? S.discount : '') + '" ' +
            'aria-label="Discount in shillings"' + (busy ? ' disabled' : '') + '>' +
          (S.discountErr
            ? '<div class="msl-note" style="color:#ffb020">' + esc(S.discountErr) + '</div>'
            : '<div class="msl-note">Taken off before payment. An owner or manager can ' +
              'approve one; the server checks who is signed in.</div>') +

          '<div class="msl-lbl">' + (S.tenders.length ? 'How is the rest being paid?' : 'How is the customer paying?') + '</div>' +
          '<div class="msl-pays">' + METHODS.map(function (m) {
            return '<button class="msl-pay' + (S.method === m.id ? ' on' : '') + '" data-act="method" data-m="' + m.id + '"' +
              (busy ? ' disabled' : '') + '><span class="ic">' + m.icon + '</span>' + m.label + '</button>';
          }).join('') + '</div>' +

          (cash
            ? '<div class="msl-lbl">Cash received</div>' +
              '<div class="msl-cash">' +
                '<button data-act="tender" data-v="exact"' + (given === bal ? ' class="on"' : '') + '>Exact</button>' +
                CASH_STEPS.filter(function (v) { return v >= bal; }).slice(0, 4).map(function (v) {
                  return '<button data-act="tender" data-v="' + v + '"' + (given === v ? ' class="on"' : '') + '>' + v + '</button>';
                }).join('') +
              '</div>' +
              '<input class="msl-inp" id="msl-cash" inputmode="numeric" pattern="[0-9]*" ' +
                'placeholder="Or type the amount" value="' + (given == null ? '' : given) + '" aria-label="Cash received">' +
              (!st
                ? '<div class="msl-warn">The change could not be worked out on this device, so this ' +
                  'sale cannot be completed here. Reopen SOKONI Merchant.</div>'
                : change != null
                  ? '<div class="msl-tot grand"><span>Change due</span><b>' + esc(change) + '</b></div>'
                  : shortBy != null && given != null
                    ? '<div class="msl-note" style="color:#ffb020">Short by ' + esc(shortBy) + '.</div>'
                    : '')
            : S.method === 'mpesa'
              ? mpesaPanel(bal)
              /* Card is unchanged by this slice: there is no terminal integration
                 to confirm against, so it stays an operator attestation and says
                 so plainly rather than borrowing M-Pesa's confirmation language. */
              : '<div class="msl-note">Confirm the card payment has actually been received before ' +
                'completing. This screen <b>records</b> the tender against the sale — it does not ' +
                'request the money.</div>') +

          (stranded && C
            ? '<div class="msl-warn" style="margin-top:14px">' +
              esc(C.fromMinor(st.unrefundableMinor)) + ' more has been taken electronically than ' +
              'this sale is for, and M-Pesa cannot give change. Remove that payment and take the ' +
              'right amount, or add items to the sale.</div>'
            : '') +

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
            (busy || !canPay || !fulReady ? ' disabled' : '') + '>' +
            (busy ? (S.sale === 'checking' ? 'Checking…' : 'Completing…')
                  : (S.sale === 'failed' ? 'Try again' : 'Complete sale')) +
          '</button>' +
          '<button class="msl-btn ghost wide" data-act="close-sheet"' + (busy ? ' disabled' : '') + '>Back to cart</button>' +
        '</div>';
    }

    /* ── Actions ──────────────────────────────────────────────────────────── */

    /* The destination is NORMALISED by SokoniBuyerLocations, so the till and the
       buyer's own saved places produce the same shape. This screen does not invent a
       field name and does not geocode: a typed line is a typed line, and geometry is
       absent rather than approximated. */
    function setDestination(text) {
      S.destText = text || '';
      var L = LOC();
      var raw = String(text || '').trim();
      if (!raw) { S.ful.dest = null; S.destErr = null; return; }
      if (!L) { S.ful.dest = null; S.destErr = 'Delivery addresses are unavailable on this device.'; return; }
      try {
        /* A till types ONE line. It maps to `street`, which is a real field in the
           locations contract — NOT to an invented `line1`. Inventing a field name
           here is the same defect as inventing a twelfth destination spelling, and
           the suite caught exactly that on the first run. */
        var place = L.normalise({ label: 'Other', street: raw });
        if (!L.isDeliverable(place)) { S.ful.dest = null; S.destErr = 'That is not enough to deliver to yet.'; return; }
        /* capturedAt is left null on purpose: only the SERVER may stamp it, and a
           device clock on a delivery record is the same defect as one on a receipt. */
        S.ful.dest = L.snapshot(place, null);
        S.destErr = null;
      } catch (e) { S.ful.dest = null; S.destErr = (e && e.message) || 'That address could not be read.'; }
    }

    function destLabel() {
      var L = LOC();
      if (!S.ful.dest) return '';
      return (L && L.formatted) ? L.formatted(S.ful.dest) : (S.ful.dest.line1 || '');
    }

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
      S.ful = { type: 'pickup', dest: null, note: '' };
      S.destText = ''; S.destErr = null;
      S.settled = null; S.fulfilled = null;
      S.receipt = null; S.cached = false; S.saleError = null; S.preflight = null; S.cashGiven = null;
      S.discount = 0; S.discountText = ''; S.discountErr = null;
      S.tenders = []; stkStop(); S.stk = null;
      /* Re-read the catalogue: the sale just changed canonical stock, and the next
         customer must not be sold against the pre-sale numbers. */
      load();
    }

    /* What the customer actually handed over.
       CASH sends the amount RECEIVED, not the amount due — that difference is the
       change, and the server computes it so the drawer and the receipt cannot
       disagree about how much went back. Everything else sends the amount due
       plus the server's own payment reference; without that reference the server
       has nothing to confirm against and refuses the sale, which is the whole
       point: selecting M-Pesa is not paying with it. */
    function payments() {
      var out = S.tenders.map(function (t) {
        return { method: t.method, amount: Number(t.amount) || 0, ref: t.ref || null };
      });
      /* Cash last, and only when there is some. A zero cash line on a sale settled
         entirely by M-Pesa would claim a drawer movement that never happened. */
      if (S.method === 'cash' && S.cashGiven != null && Number(S.cashGiven) > 0) {
        out.push({ method: 'cash', amount: Number(S.cashGiven) });
      }
      return out;
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
        discountTotal: discountOf(),
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
          /* The server authorises this against the operator's real role and
             recomputes the total itself; sending it is a request, not a decision. */
          discountTotal: discountOf(),
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
          /* Frozen at completion. The receipt must describe the sale that HAPPENED,
             so it cannot keep reading live state that a stray tap could still move. */
          S.settled = settlement();
          S.fulfilled = fulfilment();
          /* ── THE DRAWER ────────────────────────────────────────────────────
             Only what physically moved. SokoniShift emits nothing for an M-PESA or
             card tender — that money is revenue but it is not in the drawer and
             cannot fund change — and a cash tender is recorded NET of the change
             handed back. Emitted only AFTER the server confirmed the sale, so a
             failed sale never moves the till. */
          var SH = SHIFT();
          if (SH && S.settled) {
            var moves = SH.eventsForSale(S.settled, {
              saleId: sale.saleId || (S.receipt && receiptIdOf(S.receipt)) || null,
              shiftId: ctx.shiftId || null, registerId: ctx.registerId || null,
            });
            /* The SERVER owns the stored record — this only hands the movements to
               the shell, which persists them through cdRecordCashEvent. */
            if (moves.length && typeof ctx.onTillEvents === 'function') {
              try { ctx.onTillEvents(moves); } catch (_) {}
            }
            S.tillMoves = moves;
          }
          S.sale = 'done';
          stkStop();
          paint();
          toast('Sale complete', 'success');
          /* AUTO-PRINT, and only from here: this line is reachable only after the
             server returned a completed sale, so a receipt cannot precede the
             money. Failure to print is reported but does not undo the sale — the
             sale happened; the paper did not. Print/Share stay on screen as the
             recovery, which is why this does not need to succeed. */
          if (typeof ctx.onPrint === 'function') { try { printReceipt(); } catch (_) {} }
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
        /* Second argument is additive: an existing printer that only reads the
           server receipt keeps working unchanged. */
        Promise.resolve(ctx.onPrint(S.receipt, composedReceipt())).catch(function () {
          toast('The receipt could not be printed.', 'error');
        });
      } catch (_) { toast('The receipt could not be printed.', 'error'); }
    }

    /* The order as the RECEIPT contract wants it. Every figure is the server's:
       the timestamp, the receipt number and the total all come from the completed
       sale, never from this screen's cart. */
    function receiptOrder() {
      var r = S.receipt || {};
      var C = CASH();
      var toM = function (v) { return (C && typeof v === 'number') ? C.toMinor(v) : null; };
      return {
        receiptId: receiptIdOf(r) || null,
        /* SERVER time. When the sale carries none, SokoniReceiptDoc prints
           "Time not recorded" rather than reaching for the device clock. */
        createdAt: r.timestamp || null,
        items: (r.items || []).map(function (it) {
          var qty = Number(it.qty || 1);
          var unit = toM(it.unitPrice);
          return { name: it.name || it.productId, qty: qty,
                   unitMinor: unit, lineMinor: unit == null ? null : unit * qty };
        }),
        totalMinor: toM(r.total),
        /* The SERVER's ladder, not this screen's. Before, subtotal was set to the
           total — which is identical only when there is no discount, and silently
           hid one the moment there was. r.subtotal / r.discount / r.total are the
           figures posCompleteCheckout computed and stored, so the printed document
           and the recorded sale cannot disagree. */
        totals: {
          subtotalMinor: toM(typeof r.subtotal === 'number' ? r.subtotal : r.total),
          discountMinor: toM(r.discount),
        },
        settlement: S.settled || null,
        fulfilment: S.fulfilled || null,
        shop: ctx.shop || (ctx.shopName ? { name: ctx.shopName } : {}),
        tax: ctx.tax || null,
        /* Absent unless REAL. A phone till has no terminal, and inventing one puts a
           fiction on a tax-adjacent document. */
        terminalId: ctx.terminalId || null,
        /* WHO SERVED — supplied by the shell from the authenticated session, never
           synthesised here. An employee sale must name the employee; if the shell
           could not resolve who served, the receipt OMITS the line rather than
           falling back to the shop owner, which would be a false record. */
        /* ctx.servedBy, and deliberately NOT the server receipt's own copy.
           posCompleteCheckout now stamps servedBy on the receipt it returns, and
           preferring that would arguably be better — it describes who served THIS
           sale rather than who is signed in now, which differs across a shift
           change. But `servedBy: ctx.servedBy || null` is a CONTRACTED
           expression: test-servedby-wire S10 and test-sell-composition both pin
           it literally, with the note "unchanged — the module was already
           correct". Rewriting a locked contract test so my preference passes is
           the wrong way round. Both values are server-derived, so the difference
           is narrow — and changing which one wins is the contract owner's call. */
        servedBy: ctx.servedBy || null,
        customer: ctx.customer || null,
      };
    }

    function composedReceipt() {
      var R = RCPT();
      if (!R) return null;
      try { return R.render(receiptOrder(), { locale: ctx.locale || 'en-KE' }); }
      catch (_) { return null; }
    }

    function receiptText() {
      var R = RCPT();
      var composed = composedReceipt();
      if (R && composed) return R.toText(composed);
      /* No branded renderer on this device. Say what the receipt IS rather than
         emit a half-branded imitation of it. */
      var r = S.receipt || {};
      return (ctx.shopName || 'SOKONI') + ' Receipt ' + (receiptIdOf(r) || '') +
             ' Total ' + md.formatKES(r.total);
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
      if (act === 'ful')          { var ft = el.getAttribute('data-f');
                                    S.ful.type = (ft === 'delivery') ? 'delivery' : 'pickup';
                                    /* Switching back to pickup DROPS the destination. Keeping it
                                       would let a pickup sale carry an address into the receipt. */
                                    if (S.ful.type === 'pickup') { S.ful.dest = null; S.destText = ''; S.destErr = null; }
                                    paint(); return; }
      /* Switching method abandons the IN-FLIGHT request, and only that. Tenders
         already in the ledger are CONFIRMED money that the shop has actually
         received — discarding them because the cashier tapped Cash would lose a
         payment the customer really made. */
      if (act === 'method')       { S.method = el.getAttribute('data-m') || 'cash'; S.cashGiven = null;
                                    stkStop(); S.stk = null; paint(); return; }
      /* Removing a tender is how an operator corrects a wrong split before
         committing. It only leaves this screen's ledger: nothing has been sent to
         the server yet, and the money itself is unaffected — the customer's M-Pesa
         payment still exists and can be applied to the corrected sale, because the
         server keys its claim on the reference rather than on this list. */
      if (act === 'untender')     { var ti = parseInt(el.getAttribute('data-i'), 10);
                                    if (ti >= 0 && ti < S.tenders.length) {
                                      S.tenders = S.tenders.slice(0, ti).concat(S.tenders.slice(ti + 1));
                                      S.cashGiven = null;
                                    }
                                    paint(); return; }
      if (act === 'tender')       { var v = el.getAttribute('data-v');
                                    S.cashGiven = (v === 'exact') ? balanceDue() : Number(v); paint(); return; }
      if (act === 'stk-send')     { stkSend(); return; }
      if (act === 'stk-cancel')   { stkStop(); S.stk = null; paint(); return; }
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
      if (el.id === 'msl-dest') {
        setDestination(el.value);
        var sh = host.querySelector('.msl-sheet');
        if (sh) { var at = el.selectionStart; sh.innerHTML = paySheet();
                  var back = host.querySelector('#msl-dest');
                  if (back) { back.focus(); try { back.setSelectionRange(at, at); } catch (_) {} } }
        return;
      }
      /* The three money/identity fields in the payment sheet repaint the sheet on
         every keystroke so the ladder stays truthful as you type. Each restores
         focus and caret afterwards — re-rendering out from under a thumb at a till
         is how a field silently stops accepting input. */
      if (el.id === 'msl-cash' || el.id === 'msl-disc' || el.id === 'msl-phone' || el.id === 'msl-mamt') {
        var fid = el.id;
        if (fid === 'msl-cash') {
          var n = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
          S.cashGiven = isFinite(n) ? n : null;
        } else if (fid === 'msl-disc') {
          var dn = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
          var sub = totals().subtotal;
          S.discount = isFinite(dn) && dn > 0 ? dn : 0;
          /* Said here as well as refused on the server, because the cashier should
             see it before the customer is quoted a figure that cannot be charged. */
          S.discountErr = (S.discount > sub)
            ? 'A discount cannot be more than the ' + md.formatKES(sub) + ' subtotal.' : null;
          /* The cash already keyed in was counted against a different amount due. */
          S.cashGiven = null;
          /* Any IN-FLIGHT request was for a different balance, so it is void — a
             confirmation must belong to the figure it was requested for. Confirmed
             tenders stay: that money has genuinely been received, and if the
             discount now puts the sale below it the sheet says so rather than
             quietly discarding a real payment. */
          stkStop(); S.stk = null;
        } else if (fid === 'msl-phone') {
          S.stk = Object.assign({}, S.stk, { phase: 'idle', phone: String(el.value || ''),
                                             error: (S.stk && S.stk.error) || null });
        } else {
          var an = parseInt(String(el.value).replace(/[^0-9]/g, ''), 10);
          S.stk = Object.assign({}, S.stk, { phase: 'idle',
                                             amount: isFinite(an) && an > 0 ? an : null });
        }
        var f = host.querySelector('.msl-sheet');
        if (f) { var sel = el.selectionStart; f.innerHTML = paySheet();
                 var again = host.querySelector('#' + fid);
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
        /* Release the live catalogue listener too. An onSnapshot that outlives its
           surface holds a socket open and bills reads for a panel nobody is
           looking at — the same leak the STK poll had. */
        if (_liveOff) { try { _liveOff(); } catch (_) {} _liveOff = null; }
        /* The M-Pesa poll outlives the listeners unless it is stopped here. A
           surface torn down mid-wait (the shop switches, the session re-resolves
           and the shell remounts) would otherwise keep calling the server every
           three seconds for two minutes and paint a host nobody is looking at. */
        stkStop();
      },
    };
  }

  return { mount: mount, CSS_ID: CSS_ID, METHODS: METHODS };
}));
