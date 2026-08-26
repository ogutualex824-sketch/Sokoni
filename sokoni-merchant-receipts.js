/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI MERCHANT — RECEIPTS (native, replacing the framed seller.html#receipts)
   ══════════════════════════════════════════════════════════════════════════════
   The first of the three routes still mounting the legacy application. What it
   replaces read `localStorage.sellerOrders` — a device-local cache — so a
   merchant's receipt list was whatever happened to be on the device they were
   holding, and a fresh phone showed none.

   ── IT OWNS NOTHING ─────────────────────────────────────────────────────────
       the orders   ctx.orders() — the shell's ONE canonical reader, the same
                    query and the same 60s cache the Orders surface uses. Two
                    readers would be two answers to "what have I sold".
       the document  SokoniReceiptDoc.render(order) — the LOCKED receipt
                    contract, 113/0. Not SokoniReceipt: that global belongs to
                    the POS print path, and claiming it would break printing on
                    any page loading both, while looking healthy until someone
                    pressed Print.

   ── AND IT WRITES NOTHING ───────────────────────────────────────────────────
   A receipt is a RENDERING of an order, not a record this surface creates. The
   deployed rule agrees: posReceipts is `allow write: if false` — Cloud Functions
   only. Nothing here creates, edits or numbers a receipt.

   ── WHY IT DOES NOT READ posReceipts ────────────────────────────────────────
   That collection holds POS-issued receipts and is the natural-looking source.
   It is not usable: measured 2026-08-20, all six production documents carry
   `merchantId` and none carries `sellerId`, while the deployed rule authorises
   reads on `sellerId == request.auth.uid`. No merchant can read any of their own
   POS receipts today. Reading it here would render an empty list for everyone
   and look like "no receipts yet". That divergence is reported separately; this
   surface renders from orders, which a seller genuinely can read.

   Contract: mount(host, ctx) -> { refresh, destroy }
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantReceipts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-receipts-css';
  /* Scoped by CLASS, never by host id — merchant.html names panels #native-<id>
     and merchant-v2 names them #panel-<id>. */
  var HOST_CLASS = 'sk-mrcpt';
  var CSS = [
    '.sk-mrcpt{padding:14px 12px 96px}',
    '.rc-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px}',
    '.rc-h{font-size:19px;font-weight:800;letter-spacing:-.01em}',
    '.rc-count{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55))}',
    '.rc-sub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:14px;line-height:1.6}',
    '.rc-tools{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
    '.rc-sum{padding:16px 2px 12px}',
    '.rc-sum-l{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;color:var(--txt3,#8b8b8b)}',
    '.rc-sum-v{font-size:31px;font-weight:900;letter-spacing:-.02em;line-height:1.1;margin-top:4px}',
    '.rc-sum-s{font-size:12.5px;font-weight:600;color:var(--txt3,#8b8b8b);margin-top:5px}',
    '.rc-tiles{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
    '.rc-tile{flex:1 1 128px;padding:11px 13px;border-radius:13px;background:rgba(255,255,255,.04)}',
    '.rc-tile small{display:block;font-size:10.5px;font-weight:800;color:var(--txt3,#8b8b8b);text-transform:uppercase;letter-spacing:.04em}',
    '.rc-tile b{display:block;font-size:16px;font-weight:900;margin-top:3px}',
    '.rc-sel{min-height:44px;border-radius:12px;padding:0 12px;font:inherit;font-size:13px;font-weight:700;',
      'background:var(--card,#0e0e0e);color:inherit;border:1px solid var(--line,rgba(255,255,255,.14))}',
    '.rc-g{font-size:11px;font-weight:900;text-transform:uppercase;letter-spacing:.06em;',
      'color:var(--txt3,#8b8b8b);margin:18px 0 8px}',
    '.rc-card{padding:14px;border-radius:16px;margin-bottom:10px;background:var(--card,#0e0e0e);',
      'border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.rc-card.void{opacity:.62}',
    '.rc-hd{display:flex;align-items:center;gap:8px;margin-bottom:9px}',
    '.rc-hd .rc-ref{flex:1;min-width:0;font-size:12.5px;font-weight:900;letter-spacing:.02em;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rc-b{font-size:10.5px;font-weight:900;padding:4px 9px;border-radius:20px;background:rgba(255,255,255,.08)}',
    '.rc-b.ok{background:rgba(113,255,0,.14);color:var(--acc,#71ff00)}',
    '.rc-b.warn{background:rgba(255,176,32,.15);color:#ffb020}',
    '.rc-b.bad{background:rgba(255,107,107,.15);color:#ff6b6b}',
    '.rc-pin{border:0;background:transparent;cursor:pointer;font-size:14px;opacity:.32;padding:2px 4px}',
    '.rc-pin.on{opacity:1}',
    '.rc-who{font-size:14px;font-weight:800}',
    '.rc-lines{margin-top:9px}',
    '.rc-line{display:flex;gap:10px;font-size:12.5px;padding:3px 0;color:var(--txt2,#c9c9c9)}',
    '.rc-line span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rc-line.more{color:var(--txt3,#8b8b8b);font-weight:700}',
    '.rc-tot{display:flex;align-items:baseline;gap:10px;margin-top:10px;padding-top:10px;',
      'border-top:1px dashed var(--line,rgba(255,255,255,.16))}',
    '.rc-tot span{flex:1;font-size:10.5px;font-weight:900;letter-spacing:.06em;color:var(--txt3,#8b8b8b)}',
    '.rc-tot b{font-size:18px;font-weight:900}',
    '.rc-del{margin-top:10px;padding:10px 12px;border-radius:12px;font-size:12px;font-weight:700;',
      'background:rgba(0,170,255,.09);border:1px solid rgba(0,170,255,.24)}',
    '.rc-del span{display:block;font-weight:600;color:var(--txt2,#c9c9c9);margin-top:2px}',
    '.rc-meta{display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:10px;font-size:11.5px;',
      'font-weight:600;color:var(--txt3,#8b8b8b)}',
    '.rc-acts{margin-top:11px}',
    '.rc-acts .rc-btn{width:100%}',
    '.rc-perr{margin-top:12px;padding:12px 13px;border-radius:12px;font-size:12.5px;',
      'background:rgba(255,107,107,.10);border:1px solid rgba(255,107,107,.30)}',
    '.rc-empty-i{font-size:40px;margin-bottom:10px}',
    '.rc-delta{display:inline-block;margin-top:8px;padding:5px 10px;border-radius:20px;',
      'font-size:11.5px;font-weight:800;background:rgba(255,255,255,.06)}',
    '.rc-delta.up{background:rgba(113,255,0,.12);color:var(--acc,#71ff00)}',
    '.rc-delta.down{background:rgba(255,176,32,.13);color:#ffb020}',
    '.rc-back{display:flex;align-items:center;gap:10px;margin-bottom:14px}',
    '.rc-backb{border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer;padding:2px 6px}',
    '.rc-back span{font-size:13px;font-weight:800;color:var(--txt3,#8b8b8b)}',
    '.rc-vhd{text-align:center;margin-bottom:16px}',
    '.rc-vref{font-size:12.5px;font-weight:800;color:var(--txt3,#8b8b8b);margin-top:9px;letter-spacing:.03em}',
    '.rc-vamt{font-size:30px;font-weight:900;letter-spacing:-.02em;margin-top:4px}',
    '.rc-dsec{margin-top:14px;padding:13px;border-radius:14px;',
      'background:rgba(0,170,255,.08);border:1px solid rgba(0,170,255,.24)}',
    '.rc-dsec-h{font-size:11.5px;font-weight:900;letter-spacing:.05em;margin-bottom:9px}',
    '.rc-dk{display:flex;align-items:center;gap:10px;padding:6px 0;font-size:12.5px}',
    '.rc-dk span{flex:1;color:var(--txt3,#8b8b8b);font-weight:600}',
    '.rc-dk b{font-weight:800;display:flex;align-items:center;gap:8px}',
    '.rc-ver{margin-top:14px;padding:12px 13px;border-radius:13px;font-size:12.5px;font-weight:800;',
      'background:rgba(113,255,0,.08);border:1px solid rgba(113,255,0,.24)}',
    '.rc-ver span{display:block;font-weight:600;color:var(--txt2,#c9c9c9);margin-top:3px}',
    '.rc-vacts{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-top:16px}',
    '.rc-ph{font-size:17px;font-weight:900;margin-bottom:14px}',
    '.rc-step{width:34px;height:34px;border-radius:9px;cursor:pointer;font:inherit;font-size:16px;',
      'font-weight:900;background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.18))}',
    '.rc-copies{min-width:26px;text-align:center;font-size:15px;font-weight:900}',
    '.rc-chk{display:flex;align-items:center;gap:9px;margin-top:12px;font-size:13px;font-weight:700;cursor:pointer}',
    '.rc-tile i{display:block;font-style:normal;font-size:11px;font-weight:800;',
      'color:var(--txt3,#8b8b8b);margin-top:2px}',
    '.rc-acts{display:flex;gap:8px;align-items:stretch}',
    '.rc-acts .rc-btn{flex:1}',
    '.rc-more{flex:0 0 44px;border-radius:12px;cursor:pointer;font:inherit;font-size:17px;',
      'font-weight:900;background:transparent;color:inherit;',
      'border:1px solid var(--line,rgba(255,255,255,.16))}',
    '.rc-card{position:relative}',
    '.rc-menu{position:absolute;right:12px;bottom:56px;z-index:6;min-width:190px;padding:6px;',
      'border-radius:14px;background:var(--card,#141414);border:1px solid var(--line,rgba(255,255,255,.16));',
      'box-shadow:0 18px 44px rgba(0,0,0,.5)}',
    '.rc-menu button{display:block;width:100%;text-align:left;padding:11px 12px;border:0;',
      'border-radius:10px;background:transparent;color:inherit;font:inherit;font-size:13.5px;',
      'font-weight:700;cursor:pointer}',



    '.rc-search{flex:1 1 180px;min-width:0;min-height:44px;border-radius:12px;padding:0 14px;font:inherit;font-size:16px;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));color:inherit}',
    '.rc-list{display:flex;flex-direction:column;gap:9px}',
    '.rc-row{display:flex;align-items:center;gap:12px;padding:12px 13px;border-radius:13px;min-width:0;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12))}',
    '.rc-i{flex:1;min-width:0}',
    '.rc-ref{font-size:13px;font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '.rc-m{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.5));margin-top:3px}',
    '.rc-amt{font-size:14px;font-weight:800;white-space:nowrap}',
    '.rc-btn{min-height:40px;border-radius:11px;padding:0 14px;cursor:pointer;font:inherit;font-weight:700;font-size:12.5px;',
    'background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.14));white-space:nowrap}',
    '.rc-state{padding:30px 18px;text-align:center;color:var(--txt2,rgba(255,255,255,.6));font-size:13.5px;line-height:1.7}',
    '.rc-sk{height:66px;border-radius:13px;background:var(--card,#0e0e0e);',
    'border:1px solid var(--line,rgba(255,255,255,.10));animation:rcsk 1.1s ease-in-out infinite}',
    '@keyframes rcsk{0%,100%{opacity:.55}50%{opacity:.85}}',
    '@media (prefers-reduced-motion:reduce){.rc-sk{animation:none}}',
    /* The document sheet */
    '.rc-sheet{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-end;justify-content:center}',
    '.rc-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62)}',
    '.rc-panel{position:relative;width:100%;max-width:420px;max-height:92vh;overflow:auto;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.14));',
    'border-radius:18px 18px 0 0;padding:16px 14px calc(16px + env(safe-area-inset-bottom,0px))}',
    '@media (min-width:600px){.rc-sheet{align-items:center}.rc-panel{border-radius:18px}}',
    /* A receipt is monospace because that is what it is: a 32-column document. */
    '.rc-doc{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;',
    'line-height:1.5;white-space:pre-wrap;word-break:break-word;background:#fff;color:#111;',
    'padding:14px 12px;border-radius:10px;margin-bottom:12px}',
    '.rc-foot{display:flex;gap:9px}',
    '.rc-foot>button{flex:1;min-height:46px;border-radius:12px;cursor:pointer;font:inherit;font-weight:800;font-size:13.5px}',
    '.rc-close{background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.16))}',
    '.rc-print{background:var(--acc,#71ff00);color:#050505;border:0}',
    '.rc-note{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.45));margin-top:9px;line-height:1.6}',
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
  function money (n, cur) {
    var v = Number(n);
    if (!isFinite(v)) return null;            /* never "KES NaN" */
    return (cur || 'KES') + ' ' + Math.round(v).toLocaleString('en-KE');
  }
  function when (ts) {
    if (!ts) return null;                     /* unknown is unknown */
    try { return new Date(ts).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }); }
    catch (_) { return null; }
  }

  function mount (host, ctx) {
    css();
    ctx = ctx || {};
    if (host && host.classList) host.classList.add(HOST_CLASS);

    /* Pinned receipts are a per-shop UI preference, not business data: a merchant marks the
     disputed sale or the one they must reconcile. Kept in localStorage keyed by SHOP, so a
     merchant with two shops does not see one shop's pins on the other. It is never a source
     of truth about a sale — the receipt itself always is. */


    function pinKey () { return 'sk.rcpt.pin.' + ((ctx.scope && ctx.scope.shopId) || 'unknown'); }


    function loadPins () {


      try { return JSON.parse(localStorage.getItem(pinKey()) || '[]') || []; } catch (e) { return []; }


    }


    function savePins (list) {


      try { localStorage.setItem(pinKey(), JSON.stringify(list.slice(0, 50))); } catch (e) {}


    }


    /* EVERY filter key is declared here with its default. An undefined filter is not a
       neutral one: `if (S.pay !== 'all')` is TRUE for undefined, so the list would filter on
       payKind(o) === undefined — which matches nothing, and every merchant would see an
       empty Receipts page. That is exactly what shipped in b6371ad and 4043df7, because the
       state extension silently failed to apply and the suites asserted SOURCE TEXT rather
       than behaviour. Anything read by visible() must have a value from the first paint. */
    var S = {
      rows: null, err: null, q: '', open: null, destroyed: false,
      range: 'today',          /* today | yesterday | 7d | 30d | all */
      pay: 'all',              /* all | cash | mpesa | mixed */
      kind: 'all',             /* all | shop | delivery | returned | cancelled */
      cashier: 'all',          /* all | <served-by name> */
      pins: [],                /* replaced by loadPins() on mount */
      printSheet: false,       /* the print OPTIONS sheet, not the print itself */
      printing: false,
      printErr: null,
      copies: 1,
      withQr: true,
      from: '', to: '',       /* custom range, ISO dates; empty until the merchant sets them */
      menu: null,             /* index of the card whose overflow menu is open */
    };

    function skeleton () {
      var c = '';
      for (var i = 0; i < 5; i++) c += '<div class="rc-sk"></div>';
      host.innerHTML =
        '<div class="rc-top"><div class="rc-h">Receipts</div></div>' +
        '<div class="rc-sub">Loading your sales…</div>' +
        '<div class="rc-list">' + c + '</div>';
    }


    /* ── ONE CLASSIFIER PER QUESTION ──────────────────────────────────────────
       Every count, filter and badge below asks THESE, so the summary strip cannot report a
       figure the list does not contain. */
    /* WHO SERVED IT, read from the order exactly as the server resolved it. Never defaulted
       to the shop owner: the receipt contract refuses to launder an unnamed employee sale
       into an owner sale, and a filter that did so would undo that. */
    function servedName (o) {
      return (o.servedBy && (o.servedBy.name || o.servedBy.label)) || o.cashierName || null;
    }
    /* The cashier list is derived from the loaded rows, so it can only ever offer people who
       actually served a sale in this shop — no staff directory read, no invented names. */
    function cashierNames () {
      var seen = {}, out = [];
      (S.rows || []).forEach(function (o) {
        var n = servedName(o);
        if (n && !seen[n]) { seen[n] = 1; out.push(n); }
      });
      return out.sort();
    }

    function payKind (o) {
      var m = String(o.method || o.paymentMethod || '').toLowerCase();
      if (/mixed|split/.test(m)) return 'mixed';
      if (/mpesa|m-pesa|stk|paybill|till/.test(m)) return 'mpesa';
      if (/cash/.test(m)) return 'cash';
      return 'other';
    }
    function saleKind (o) {
      var st = String(o.status || '').toLowerCase();
      if (/cancel/.test(st)) return 'cancelled';
      if (/refund|return/.test(st)) return 'returned';
      var ch = String(o.channel || o.orderType || '').toLowerCase();
      if (/deliver/.test(ch) || o.deliveryId || o.rider) return 'delivery';
      return 'shop';
    }
    function isDelivery (o) { return saleKind(o) === 'delivery'; }

    /* Day boundaries from the DEVICE clock, which is the merchant's own — a shop closing at
       21:00 in Nairobi must see its own day, not UTC's. */
    function dayStart (offsetDays) {
      var d = new Date();
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - (offsetDays || 0));
      return d.getTime();
    }
    function inRange (o) {
      var t = o.ts || (o.when && o.when.getTime());
      if (!t) return S.range === 'all';        /* undated: only ever shown under "All" */
      if (S.range === 'all') return true;
      if (S.range === 'today') return t >= dayStart(0);
      if (S.range === 'yesterday') return t >= dayStart(1) && t < dayStart(0);
      if (S.range === '7d') return t >= dayStart(6);
      if (S.range === '30d') return t >= dayStart(29);
      if (S.range === 'custom') {
        /* An unset bound is OPEN, not zero: a merchant who fills only "from" means
           "since then", and treating the empty "to" as epoch would show nothing. */
        var f = S.from ? new Date(S.from + 'T00:00:00').getTime() : null;
        var tt = S.to ? new Date(S.to + 'T23:59:59.999').getTime() : null;
        if (f !== null && isFinite(f) && t < f) return false;
        if (tt !== null && isFinite(tt) && t > tt) return false;
        return true;
      }
      return true;
    }

    /* ── THE SUMMARY, FROM THE CANONICAL ENGINE ───────────────────────────────
       SokoniAnalyticsEngine.aggregate() — the SAME one Dashboard, Revenue, Analytics and
       Reports read. Receipts does not add a sales calculator; a second one is two answers to
       "what did the shop take today", and this surface is where a merchant checks.

       No engine, no figures: the strip renders em-dashes rather than a locally summed total.
       An unknown must stay unknown (CLAUDE.md, UI Data Integrity). */
    function toEngineOrder (o) {
      return {
        status: o.status, paymentStatus: o.payment, paymentMethod: o.method,
        channel: o.channel, total: Number(o.total) || 0, items: o.items || [],
        customer: o.customer, tax: Number(o.tax) || 0, discount: Number(o.discount) || 0,
        deliveryFee: Number(o.deliveryFee) || 0,
        source: o.channel === 'in_store' ? 'pos' : 'online',
      };
    }
    function summaryFor (rows) {
      var AE = (typeof window !== 'undefined') && window.SokoniAnalyticsEngine;
      if (!AE || typeof AE.aggregate !== 'function') return null;
      return AE.aggregate(rows.map(toEngineOrder));
    }

    /* ── DAY OVER DAY ─────────────────────────────────────────────────────────
       Shown ONLY when yesterday genuinely has sales to compare against. With no rows for
       yesterday there is no percentage to state — a shop that did not trade did not fall
       100%, and a first-day shop has nothing to be up from. Both would be this surface
       inventing a trend out of an absence, which is the same defect class as rendering an
       unknown total as zero. */
    function deltaHTML () {
      if (S.range !== 'today') return '';           /* only meaningful for today */
      var all = S.rows || [];
      var t0 = dayStart(0), t1 = dayStart(1);
      var sum = function (from, to) {
        var n = 0, seen = 0;
        all.forEach(function (o) {
          var t = o.ts || (o.when && o.when.getTime());
          if (!t || t < from || (to && t >= to)) return;
          if (saleKind(o) === 'cancelled') return;
          seen++; n += Number(o.total) || 0;
        });
        return { total: n, count: seen };
      };
      var today = sum(t0, null), yest = sum(t1, t0);
      if (!yest.count || !yest.total) return '';    /* nothing to compare against */
      var pct = ((today.total - yest.total) / yest.total) * 100;
      var up = pct >= 0;
      return '<div class="rc-delta ' + (up ? 'up' : 'down') + '">' +
        (up ? '↑ ' : '↓ ') + Math.abs(pct).toFixed(1) + '% from yesterday</div>';
    }

    function summaryHTML (rows) {
      var a = summaryFor(rows);
      var dash = '—';
      var label = S.range === 'today' ? 'Today'
                : S.range === 'yesterday' ? 'Yesterday'
                : S.range === '7d' ? 'Last 7 days'
                : S.range === '30d' ? 'Last 30 days' : 'All time';
      /* Payment split is counted from the rows on screen through payKind — the same
         classifier the filter uses — so the split and the list always agree. */
      var byPay = { cash: 0, mpesa: 0, mixed: 0, other: 0 };
      rows.forEach(function (o) {
        if (saleKind(o) === 'cancelled') return;    /* cancelled money was never taken */
        byPay[payKind(o)] += Number(o.total) || 0;
      });
      /* Percentages need a denominator. With no takings there is no split to state — 0% and
         0% would be a claim about a day that has not happened yet, so the share is simply
         omitted and the amount stands alone. */
      var takings = byPay.cash + byPay.mpesa + byPay.mixed + byPay.other;
      var share = function (n) {
        if (!takings) return '';
        return '<i>' + Math.round((n / takings) * 100) + '%</i>';
      };
      var tile = function (icon, name, amount, show) {
        if (!show) return '';
        return '<div class="rc-tile"><small>' + icon + ' ' + name + '</small>' +
          '<b>' + esc(money(amount)) + '</b>' + share(amount) + '</div>';
      };
      return '<div class="rc-sum">' +
          '<div class="rc-sum-l">' + esc(label) + '</div>' +
          '<div class="rc-sum-v">' + (a ? esc(money(a.revenue)) : dash) + '</div>' +
          '<div class="rc-sum-s">' + rows.length +
            (rows.length === 1 ? ' receipt' : ' receipts') +
            (a ? '' : ' · totals unavailable') + '</div>' +
          deltaHTML() +
        '</div>' +
        '<div class="rc-tiles">' +
          '<div class="rc-tile"><small>💰 Sales</small><b>' +
            (a ? esc(money(a.revenue)) : dash) + '</b></div>' +
          '<div class="rc-tile"><small>🧾 Receipts</small><b>' + rows.length + '</b></div>' +
        '</div>' +
        '<div class="rc-tiles">' +
          tile('💳', 'M-PESA', byPay.mpesa, true) +
          tile('💵', 'Cash', byPay.cash, true) +
          tile('💰', 'Mixed', byPay.mixed, byPay.mixed > 0) +
          tile('🧾', 'Other', byPay.other, byPay.other > 0) +
        '</div>';
    }

    function visible () {
      var rows = (S.rows || []).slice();
      rows = rows.filter(inRange);
      if (S.pay !== 'all')  rows = rows.filter(function (o) { return payKind(o) === S.pay; });
      if (S.kind !== 'all') rows = rows.filter(function (o) { return saleKind(o) === S.kind; });
      if (S.cashier !== 'all') rows = rows.filter(function (o) { return servedName(o) === S.cashier; });

      var q = S.q.trim().toLowerCase();
      if (q) {
        /* One box, everything a merchant might hold: "find the receipt for that KSh 4,300
           M-PESA payment from Jane" has to work whether they remember the reference, the
           customer, the product or the M-PESA code. Every field is one the order already
           carries — nothing is derived for searching. */
        rows = rows.filter(function (o) {
          var hay = [o.ref, o.id, o.orderNumber, o.customer, o.phone, o.method,
                     o.mpesaRef, o.transactionId, o.deliveryId, o.rider,
                     (o.servedBy && (o.servedBy.name || o.servedBy.label)), o.cashierName];
          (o.items || []).forEach(function (it) { hay.push(it.name, it.sku); });
          for (var i = 0; i < hay.length; i++) {
            if (hay[i] && String(hay[i]).toLowerCase().indexOf(q) > -1) return true;
          }
          return false;
        });
      }
      return rows;
    }


    /* Pinned first, then newest-first by day. Grouping is by the merchant's own day
       boundary, so "Today" means the day they are trading in. */
    function groupRows (rows) {
      var pins = S.pins || [];
      var pinned = [], today = [], yest = [], older = [];
      rows.forEach(function (o) {
        var id = String(o.ref || o.id || '');
        if (pins.indexOf(id) >= 0) { pinned.push(o); return; }
        var t = o.ts || (o.when && o.when.getTime()) || 0;
        if (t >= dayStart(0)) today.push(o);
        else if (t >= dayStart(1)) yest.push(o);
        else older.push(o);
      });
      return [
        { key: 'pinned', label: '⭐ Pinned', rows: pinned },
        { key: 'today',  label: 'Today',     rows: today },
        { key: 'yest',   label: 'Yesterday', rows: yest },
        { key: 'older',  label: 'Older',     rows: older },
      ].filter(function (g) { return g.rows.length; });
    }

    function row (o, i) {
      var amt = money(o.total, o.currency);
      var t = when(o.ts);
      var kind = saleKind(o);
      var pay = payKind(o);
      var id = String(o.ref || o.id || '');
      var pinned = (S.pins || []).indexOf(id) >= 0;
      var items = (o.items || []);
      var PAY_ICON = { mpesa: '💳', cash: '💵', mixed: '💰', other: '🧾' };

      /* Up to three lines, then a count. A receipt card is a reminder of a sale, not the
         document — the sheet is the document. */
      var lines = items.slice(0, 3).map(function (it) {
        var qty = Number(it.qty || it.quantity || 1) || 1;
        var line = money((Number(it.price) || 0) * qty, o.currency);
        return '<div class="rc-line"><span>' + esc(it.name || 'Item') +
          (qty > 1 ? ' ×' + qty : '') + '</span><b>' + esc(line === null ? '—' : line) + '</b></div>';
      }).join('');
      var more = items.length > 3
        ? '<div class="rc-line more">+' + (items.length - 3) + ' more</div>' : '';

      /* Served-by comes from the order as the server resolved it. It is never defaulted to
         the shop owner: the receipt contract already refuses to launder an unnamed employee
         sale into an owner sale, and this card must not undo that. */
      var served = o.servedBy && (o.servedBy.name || o.servedBy.label);
      var role = o.servedBy && o.servedBy.role;

      /* Delivery is shown ONLY for a delivery. An ordinary counter sale gets no empty
         delivery block. Address and rider come from the order; rider LOCATION is never
         queried here — that belongs to the tracking authority. */
      var delivery = kind === 'delivery'
        ? '<div class="rc-del">🚚 <b>Delivery</b>' +
            (o.address ? '<span>' + esc(o.address) + '</span>' : '') +
            (o.rider ? '<span>' + esc(o.rider) + ' · Rider</span>' : '') +
          '</div>'
        : '';

      var badge = kind === 'cancelled' ? '<span class="rc-b bad">✕ Cancelled</span>'
                : kind === 'returned'  ? '<span class="rc-b warn">↩︎ Returned</span>'
                : /paid|success|complete/i.test(String(o.payment || '')) ? '<span class="rc-b ok">✓ Paid</span>'
                : '<span class="rc-b">Unpaid</span>';

      return '<div class="rc-card' + (kind === 'cancelled' ? ' void' : '') + '">' +
        '<div class="rc-hd">' +
          '<span class="rc-ref">🧾 ' + esc(id) + '</span>' + badge +
          '<button class="rc-pin' + (pinned ? ' on' : '') + '" data-rc="pin" data-i="' + i + '" ' +
            'aria-pressed="' + (pinned ? 'true' : 'false') + '" aria-label="Pin this receipt">⭐</button>' +
        '</div>' +
        '<div class="rc-who">' + esc(o.customer || 'Walk-in') +
          (items.length ? ' · ' + items.length + (items.length === 1 ? ' item' : ' items') : '') +
        '</div>' +
        (lines ? '<div class="rc-lines">' + lines + more + '</div>' : '') +
        '<div class="rc-tot"><span>TOTAL</span><b>' + esc(amt === null ? '—' : amt) + '</b></div>' +
        delivery +
        '<div class="rc-meta">' +
          '<span>' + (PAY_ICON[pay] || '🧾') + ' ' + esc(o.method || 'Payment —') +
            (o.mpesaRef ? ' · ' + esc(o.mpesaRef) : '') + '</span>' +
          (served ? '<span>👤 ' + esc(served) + (role ? ' · ' + esc(role) : '') + '</span>' : '') +
          (t ? '<span>🕐 ' + esc(t) + '</span>' : '') +
        '</div>' +
        '<div class="rc-acts">' +
          '<button class="rc-btn" data-rc="open" data-i="' + i + '">View receipt</button>' +
          '<button class="rc-more" data-rc="menu" data-i="' + i + '" aria-haspopup="true" ' +
            'aria-expanded="' + (S.menu === i ? 'true' : 'false') + '" aria-label="More actions">⋮</button>' +
        '</div>' +
        /* ALWAYS in the DOM, toggled with [hidden]. Rendering it only when open removes every
           action from the document for every closed card — the exact defect the Products
           certification caught, where Delete existed only after a second tap. */
        '<div class="rc-menu" role="menu"' + (S.menu === i ? '' : ' hidden') + '>' +
          '<button role="menuitem" data-rc="open" data-i="' + i + '">🧾 View receipt</button>' +
          '<button role="menuitem" data-rc="quickprint" data-i="' + i + '">🖨️ Print</button>' +
          '<button role="menuitem" data-rc="pin" data-i="' + i + '">' +
            (pinned ? '☆ Unpin' : '⭐ Pin') + '</button>' +
          '<button role="menuitem" data-rc="quickcopy" data-i="' + i + '">📋 Copy reference</button>' +
        '</div>' +
      '</div>';
    }

    /* ── THE DOCUMENT ───────────────────────────────────────────────────────
       Rendered by the locked contract, never by markup written here. If the
       contract is not loaded the surface says so — it does not improvise a
       second receipt layout, which is how two receipt formats appear. */
    /* ONE copy implementation, shared by the sheet action and the card menu. Reported
       honestly: clipboard access is refused in plenty of contexts, and a "Copied" toast over
       a failed write is a small lie the merchant then acts on. */
    function copyRef (o) {
      var ref = o && (o.ref || o.id);
      if (!ref) return;
      try {
        navigator.clipboard.writeText(String(ref))
          .then(function () { say('Reference copied.'); })
          .catch(function () { say('Could not copy. The reference is ' + ref + '.'); });
      } catch (e) { say('Could not copy. The reference is ' + ref + '.'); }
    }

    function say (m) { if (typeof ctx.onToast === 'function') ctx.onToast(m); }

    function docFor (order) {
      var R = (typeof window !== 'undefined') && window.SokoniReceiptDoc;
      if (!R || typeof R.render !== 'function' || typeof R.toText !== 'function') return null;
      try {
        var doc = R.render(Object.assign({}, order, {
          shop: ctx.shop || { name: ctx.shopName || '' },
        }), { shop: ctx.shop || { name: ctx.shopName || '' } });
        return { text: R.toText(doc), warnings: (doc && doc.warnings) || [] };
      } catch (_) { return null; }
    }


    /* ── VERIFICATION ─────────────────────────────────────────────────────────
       The QR destination is the contract's own RECEIPT_URL_BASE — the customer-facing
       verification page keyed by REFERENCE only. The contract is explicit that the QR must
       never carry a phone number, a uid or an amount, and this surface must not invent a
       richer link: it composes the same URL the printed QR encodes, so scanning the paper
       and tapping the screen reach the same place. */
    function verifyUrl (o) {
      var R = (typeof window !== 'undefined') && window.SokoniReceiptDoc;
      var base = R && R.RECEIPT_URL_BASE;
      var ref = o && (o.ref || o.id);
      if (!base || !ref) return null;
      return base + encodeURIComponent(String(ref));
    }

    /* ── DELIVERY, IN THE SHEET ───────────────────────────────────────────────
       Everything here is a field the ORDER already carries. Rider LOCATION is deliberately
       absent: live position belongs to the tracking authority and its own rules, and a
       receipt reaching for it would be this surface widening a security boundary to
       decorate a document. The tracking ENTRY POINT is a route, not a coordinate. */
    function deliveryBlock (o) {
      if (saleKind(o) !== 'delivery') return '';
      var fee = money(o.deliveryFee, o.currency);
      var stage = o.fulfilment || o.deliveryStatus || null;
      return '<div class="rc-dsec">' +
        '<div class="rc-dsec-h">🚚 SOKONI DELIVERY</div>' +
        (o.deliveryId ? '<div class="rc-dk"><span>Delivery ID</span><b>' + esc(o.deliveryId) + '</b></div>' : '') +
        (o.address ? '<div class="rc-dk"><span>Address</span><b>' + esc(o.address) + '</b></div>' : '') +
        (o.rider ? '<div class="rc-dk"><span>Rider</span><b>' + esc(o.rider) + '</b></div>' : '') +
        (fee !== null ? '<div class="rc-dk"><span>Delivery fee</span><b>' + esc(fee) + '</b></div>' : '') +
        /* Stage is shown only when the order carries one. "Pending" invented for an order
           with no fulfilment field would be this surface asserting a delivery state. */
        (stage ? '<div class="rc-dk"><span>Stage</span><b>' + esc(stage) + '</b></div>' : '') +
        '<button class="rc-btn" data-rc="go" data-route="fulfilment">📍 Open tracking</button>' +
      '</div>';
    }

    /* ── THE PRINT OPTIONS SHEET ──────────────────────────────────────────────
       Opening options is NOT printing. The old flow fired a job the moment Print was
       pressed; a merchant reprinting a customer copy had no way to say "two". */
    function printSheet () {
      var o = S.open;
      var dev = (typeof ctx.device === 'function') ? ctx.device() : null;
      var connected = dev && dev.connected;
      var name = (dev && dev.name) || 'Printer';
      return '<div class="rc-sheet"><div class="rc-scrim" data-rc="closeprint"></div>' +
        '<div class="rc-panel" role="dialog" aria-modal="true" aria-label="Print receipt">' +
        '<div class="rc-ph">🖨️ Print receipt</div>' +
        /* The device state is REPORTED, never assumed. With no device layer we say we
           cannot tell — not "Connected", which a merchant would act on. */
        '<div class="rc-dk"><span>Printer</span><b>' +
          (dev === null ? 'Status unavailable'
                        : (connected ? '● ' + esc(name) + ' — Connected'
                                     : '○ ' + esc(name) + ' — Disconnected')) + '</b></div>' +
        (dev && !connected
          ? '<div class="rc-perr"><b>Printer disconnected.</b><br>Reconnect ' + esc(name) +
            ' to continue.<br><button class="rc-btn" data-rc="reconnect">Reconnect</button></div>'
          : '') +
        '<div class="rc-dk"><span>Copies</span><b>' +
          '<button class="rc-step" data-rc="copies" data-d="-1" aria-label="Fewer copies">−</button>' +
          '<span class="rc-copies">' + S.copies + '</span>' +
          '<button class="rc-step" data-rc="copies" data-d="1" aria-label="More copies">+</button>' +
        '</b></div>' +
        '<label class="rc-chk"><input type="checkbox" data-rc="qr"' + (S.withQr ? ' checked' : '') +
          '> Include QR verification</label>' +
        (S.printErr ? '<div class="rc-perr"><b>The receipt did not print.</b><br>' + esc(S.printErr) + '</div>' : '') +
        '<div class="rc-foot">' +
          '<button class="rc-close" data-rc="closeprint">Cancel</button>' +
          '<button class="rc-print" data-rc="doprint"' + (S.printing ? ' disabled' : '') + '>' +
            (S.printing ? 'Printing…' : 'PRINT') + '</button>' +
        '</div></div></div>';
    }

    function sheet () {
      var o = S.open;
      var d = docFor(o);
      var body = d
        ? '<div class="rc-doc">' + esc(d.text) + '</div>'
        : '<div class="rc-state">The receipt document could not be produced.<br>' +
          'Nothing is shown rather than a different-looking receipt.</div>';
      var warn = (d && d.warnings.length)
        ? '<div class="rc-note">' + d.warnings.map(esc).join('<br>') + '</div>' : '';
      var amt = money(o.total, o.currency);
      var paid = /paid|success|complete/i.test(String(o.payment || ''));
      var vurl = verifyUrl(o);
      return '<div class="rc-sheet"><div class="rc-scrim" data-rc="close"></div>' +
        '<div class="rc-panel" role="dialog" aria-modal="true" aria-label="Receipt">' +
        '<div class="rc-back"><button class="rc-backb" data-rc="close" aria-label="Back">←</button>' +
          '<span>Receipt</span></div>' +
        '<div class="rc-vhd">' +
          (saleKind(o) === 'cancelled' ? '<span class="rc-b bad">✕ Cancelled</span>'
            : paid ? '<span class="rc-b ok">✓ PAID</span>' : '<span class="rc-b">Unpaid</span>') +
          '<div class="rc-vref">' + esc(o.ref || o.id) + '</div>' +
          '<div class="rc-vamt">' + esc(amt === null ? '—' : amt) + '</div>' +
        '</div>' +
        body + warn +
        deliveryBlock(o) +
        /* Verification, only when a reference actually resolves to a URL. A verify control
           that leads nowhere is worse than none: it invites a customer to check something
           that will not confirm. */
        (vurl
          ? '<div class="rc-ver">✓ Verified SOKONI receipt' +
            '<span>Scan the QR on the printed receipt, or open the verification page.</span>' +
            '</div>'
          : '') +
        '<div class="rc-vacts">' +
          '<button class="rc-btn" data-rc="openprint">🖨️ Print</button>' +
          '<button class="rc-btn" data-rc="share">📤 Share</button>' +
          '<button class="rc-btn" data-rc="save">📥 Save</button>' +
          '<button class="rc-btn" data-rc="copyref">📋 Copy reference</button>' +
          (vurl ? '<button class="rc-btn" data-rc="verify">🔗 Verify receipt</button>' : '') +
        '</div>' +
        /* The print OUTCOME, stated. A failure names what to do about it; it never
           disappears into a toast the merchant may have missed while looking at the
           printer. */
        (S.printErr ? '<div class="rc-perr"><b>The receipt did not print.</b><br>' +
           esc(S.printErr) + '<br><button class="rc-btn" data-rc="print">Try again</button></div>' : '') +
        '<div class="rc-foot">' +
          '<button class="rc-close" data-rc="close">Close</button>' +
          (d ? '<button class="rc-print" data-rc="print"' + (S.printing ? ' disabled' : '') + '>' +
               (S.printing ? 'Printing…' : '🖨️ Print') + '</button>' : '') +
        '</div></div></div>';
    }

    function sel (v, label, cur) {
      return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
    }

    function paint () {
      if (S.destroyed) return;
      if (S.rows === null && !S.err) return skeleton();

      if (S.err) {
        host.innerHTML =
          '<div class="rc-top"><div class="rc-h">Receipts</div></div>' +
          '<div class="rc-state">Your sales couldn’t be loaded just now.<br>' +
          'This is not an empty history — nothing was fetched.<br>' +
          '<button class="rc-btn" style="margin-top:14px" data-rc="retry">Try again</button></div>';
        return;
      }

      var rows = visible();
      S.painted = rows;
      /* Grouped, but the INDEX still addresses S.painted — the flat list captured at paint
         time. Rendering groups over their own indices would make every button after the
         first group resolve to the wrong receipt. */
      var groups = groupRows(rows);
      var body = rows.length
        ? groups.map(function (g) {
            return '<div class="rc-g">' + esc(g.label) + '</div>' +
              '<div class="rc-list">' + g.rows.map(function (o) {
                return row(o, rows.indexOf(o));
              }).join('') + '</div>';
          }).join('')
        : '<div class="rc-state">' + (S.rows.length
            ? 'No receipt matches that search or filter.<br>' +
              '<button class="rc-btn" style="margin-top:14px" data-rc="clear">Clear filters</button>'
            : '<div class="rc-empty-i">🧾</div><b>Your receipts, safely kept.</b><br>' +
              'Every sale. Every payment. One place.') + '</div>';

      host.innerHTML =
        '<div class="rc-top"><div class="rc-h">Receipts</div>' +
          '<div class="rc-count">' + esc(S.rows.length +
            (S.rows.length === 1 ? ' sale' : ' sales')) + '</div></div>' +
        '<div class="rc-sub">Your sales, beautifully organised.</div>' +
        summaryHTML(rows) +
        '<div class="rc-tools">' +
          '<input class="rc-search" type="search" inputmode="search" ' +
            'placeholder="Reference, customer, product, M-PESA code, cashier…" ' +
            'aria-label="Search receipts" value="' + esc(S.q) + '" data-rc="q">' +
        '</div>' +
        '<div class="rc-tools">' +
          '<select class="rc-sel" aria-label="Date range" data-rc="range">' +
            sel('today', 'Today', S.range) + sel('yesterday', 'Yesterday', S.range) +
            sel('7d', 'Last 7 days', S.range) + sel('30d', 'Last 30 days', S.range) +
            sel('all', 'All time', S.range) +
            sel('custom', 'Custom…', S.range) +
          '</select>' +
          '<select class="rc-sel" aria-label="Payment method" data-rc="pay">' +
            sel('all', 'All payments', S.pay) + sel('mpesa', '💳 M-PESA', S.pay) +
            sel('cash', '💵 Cash', S.pay) + sel('mixed', '💰 Mixed', S.pay) +
          '</select>' +
          (cashierNames().length > 1
            ? '<select class="rc-sel" aria-label="Cashier" data-rc="cashier">' +
                sel('all', '👤 All cashiers', S.cashier) +
                cashierNames().map(function (n) { return sel(n, n, S.cashier); }).join('') +
              '</select>'
            : '') +
          '<select class="rc-sel" aria-label="Sale type" data-rc="kind">' +
            sel('all', 'All sales', S.kind) + sel('shop', '🛍️ Shop sale', S.kind) +
            sel('delivery', '🚚 Delivery', S.kind) + sel('returned', '↩️ Returned', S.kind) +
            sel('cancelled', '❌ Cancelled', S.kind) +
          '</select>' +
        (S.range === 'custom'
          ? '<div class="rc-tools">' +
              '<input class="rc-sel" type="date" aria-label="From" data-rc="from" value="' + esc(S.from) + '">' +
              '<input class="rc-sel" type="date" aria-label="To" data-rc="to" value="' + esc(S.to) + '">' +
            '</div>'
          : '') +
        '</div>' + body +
        (S.open ? sheet() : '') +
        (S.open && S.printSheet ? printSheet() : '');
    }

    /* ── LOAD: the shell's ONE orders reader ────────────────────────────── */
    S.pins = loadPins();

    function load () {
      skeleton();
      if (typeof ctx.orders !== 'function') {
        S.err = 'no-orders-reader';
        return Promise.resolve(paint());
      }
      return Promise.resolve()
        .then(function () { return ctx.orders(); })
        .then(function (r) {
          if (S.destroyed) return;
          if (r && r.error) { S.err = r.error; return paint(); }
          S.rows = (r && r.rows) ? r.rows.slice() : [];
          S.err = null;
          paint();
        })
        .catch(function (e) {
          if (S.destroyed) return;
          S.err = (e && e.message) || String(e);
          paint();
        });
    }

    var _t = null;
    function onInput (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      var key = el.getAttribute('data-rc');

      /* THE FILTERS. This guard used to be `!== 'q'` and returned early for everything else,
         so every select rendered and did nothing at all: the merchant changed Payment to
         M-PESA and the list did not move. A control that looks live and is inert is worse
         than a missing one, because it is trusted.

         Applied immediately rather than debounced — a select is a decision already made,
         unlike typing. Any change also closes an open card menu: its index addresses the
         painted list, and a re-filtered list would point it at a different receipt. */
      if (key === 'range' || key === 'pay' || key === 'kind' || key === 'cashier') {
        S[key] = el.value; S.menu = null; paint(); return;
      }
      if (key === 'from' || key === 'to') { S[key] = el.value || ''; S.menu = null; paint(); return; }
      if (key === 'qr') { S.withQr = !!el.checked; return; }

      if (key !== 'q') return;
      clearTimeout(_t);
      var v = el.value;
      _t = setTimeout(function () {
        S.q = v; S.menu = null; paint();
        var s = host.querySelector('[data-rc="q"]');
        if (s) { s.focus(); try { s.setSelectionRange(v.length, v.length); } catch (_) {} }
      }, 200);
    }

    function onClick (ev) {
      var el = ev.target && ev.target.closest && ev.target.closest('[data-rc]');
      if (!el) return;
      var k = el.getAttribute('data-rc');
      if (k === 'retry') { S.err = null; S.rows = null; return load(); }
      if (k === 'close') { S.open = null; return paint(); }
      if (k === 'open') {
        /* Resolved through the rows captured at paint time, so a search typed
           between paint and tap cannot open a different sale's receipt. */
        var o = (S.painted || [])[Number(el.getAttribute('data-i'))];
        if (!o) return;
        S.open = o; S.printErr = null; return paint();
      }
      if (k === 'pin') {
        var pi = Number(el.getAttribute('data-i'));
        var po = S.painted && S.painted[pi];
        if (!po) return;
        var pid = String(po.ref || po.id || '');
        var list = (S.pins || []).slice();
        var at = list.indexOf(pid);
        if (at >= 0) list.splice(at, 1); else list.unshift(pid);
        S.pins = list; savePins(list); paint();
        return;
      }
      if (k === 'clear') {
        S.q = ''; S.range = 'today'; S.pay = 'all'; S.kind = 'all'; paint();
        return;
      }
      if (k === 'menu') {
        var mi = Number(el.getAttribute('data-i'));
        S.menu = (S.menu === mi) ? null : mi;   /* tapping the same control closes it */
        paint(); return;
      }
      if (k === 'quickprint' || k === 'quickcopy') {
        var qi = Number(el.getAttribute('data-i'));
        var qo = S.painted && S.painted[qi];
        if (!qo) return;
        S.menu = null;
        if (k === 'quickcopy') { copyRef(qo); paint(); return; }
        /* Print from the card opens the OPTIONS sheet on that receipt, rather than firing a
           job the merchant did not size. */
        S.open = qo; S.printErr = null; S.printSheet = true; paint();
        return;
      }
      if (k === 'save') {
        var sd2 = docFor(S.open);
        if (!sd2) return;
        /* A download the browser refused is not a saved file. Reported either way. */
        try {
          var blob = new Blob([sd2.text], { type: 'text/plain;charset=utf-8' });
          var url = URL.createObjectURL(blob);
          var a2 = document.createElement('a');
          a2.href = url;
          a2.download = 'receipt-' + String(S.open.ref || S.open.id || 'sokoni') + '.txt';
          document.body.appendChild(a2); a2.click(); document.body.removeChild(a2);
          setTimeout(function () { try { URL.revokeObjectURL(url); } catch (e) {} }, 1000);
          say('Receipt saved.');
        } catch (e) { say('The receipt could not be saved on this device.'); }
        return;
      }
      if (k === 'openprint') { S.printSheet = true; S.printErr = null; paint(); return; }
      if (k === 'closeprint') { S.printSheet = false; paint(); return; }
      if (k === 'copies') {
        var dstep = Number(el.getAttribute('data-d')) || 0;
        S.copies = Math.max(1, Math.min(9, S.copies + dstep));
        paint(); return;
      }
      if (k === 'reconnect') {
        if (typeof ctx.reconnectPrinter === 'function') {
          Promise.resolve(ctx.reconnectPrinter()).then(function () { paint(); })
            .catch(function () { paint(); });
        } else { say('Reconnect the printer from POS settings.'); }
        return;
      }
      if (k === 'copyref') { copyRef(S.open); return; }
      if (k === 'verify') {
        var vu = verifyUrl(S.open);
        if (!vu) return;
        try { window.open(vu, '_blank', 'noopener'); } catch (e) { say('Could not open the verification page.'); }
        return;
      }
      if (k === 'share') {
        var sd = docFor(S.open);
        if (!sd) return;
        /* The SAME text the printer receives — a shared receipt that differs from the
           printed one is the very divergence this surface exists to prevent. */
        if (navigator.share) {
          Promise.resolve(navigator.share({ title: 'Receipt ' + (S.open.ref || ''), text: sd.text }))
            .catch(function () {});
        } else { say('Sharing is not available on this device.'); }
        return;
      }
      if (k === 'go') {
        var r2 = el.getAttribute('data-route');
        try {
          if (typeof ctx.go === 'function') ctx.go(r2);
          else if (window.SokoniShell && window.SokoniShell.go) window.SokoniShell.go(r2);
        } catch (e) {}
        return;
      }
      if (k === 'doprint' || k === 'print') {
        var d = docFor(S.open);
        if (!d) return;
        /* Printing goes through the shell's device layer — the same connection POS uses,
           because a second printer path is a second queue.

           THE RESULT IS READ. This used to `return ctx.onPrint(...)` and say nothing,
           so a printer that answered {ok:false} — out of paper, disconnected mid-job,
           GATT dropped — produced a silent success. A merchant would hand a customer
           nothing and believe the receipt had printed. */
        if (typeof ctx.onPrint !== 'function') {
          if (typeof ctx.onToast === 'function') ctx.onToast('No printer service is loaded.');
          return;
        }
        S.printing = true; paint();
        Promise.resolve(ctx.onPrint({
          text: d.text, order: S.open,
          copies: S.copies, includeQr: S.withQr,
        })).then(function (res) {
          S.printing = false;
          /* undefined is NOT success. A device layer that returns nothing has told us
             nothing, and this surface must not upgrade silence into a printed receipt. */
          var okd = res && res.ok === true;
          if (okd) { say(S.copies > 1 ? S.copies + ' copies printed.' : 'Receipt printed.'); S.printSheet = false; }
          else {
            S.printErr = (res && (res.error || res.reason)) ||
              'The receipt did not print. Check the printer is connected, then try again.';
          }
          paint();
        }).catch(function (e) {
          S.printing = false;
          S.printErr = (e && e.message) || 'The receipt did not print.';
          paint();
        });
        return;
      }
    }

    function onKey (ev) { if (ev.key === 'Escape' && S.open) { S.open = null; paint(); } }

    host.addEventListener('input', onInput);
    /* A <select> fires change, not input, in every browser that matters — wiring only input
       left the three filters inert on some of them, which reads as a dead control. */
    host.addEventListener('change', onInput);
    host.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    load();

    return {
      refresh: function () { S.rows = null; S.err = null; return load(); },
      destroy: function () {
        S.destroyed = true;
        clearTimeout(_t);
        host.removeEventListener('input', onInput);
        host.removeEventListener('change', onInput);
        host.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        if (host && host.classList) host.classList.remove(HOST_CLASS);
        host.innerHTML = '';
      },
    };
  }

  return { mount: mount };
}));
