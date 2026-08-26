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

    var S = { rows: null, err: null, q: '', open: null, destroyed: false };

    function skeleton () {
      var c = '';
      for (var i = 0; i < 5; i++) c += '<div class="rc-sk"></div>';
      host.innerHTML =
        '<div class="rc-top"><div class="rc-h">Receipts</div></div>' +
        '<div class="rc-sub">Loading your sales…</div>' +
        '<div class="rc-list">' + c + '</div>';
    }

    function visible () {
      var rows = (S.rows || []).slice();
      var q = S.q.trim().toLowerCase();
      if (q) {
        rows = rows.filter(function (o) {
          return String(o.ref || '').toLowerCase().indexOf(q) > -1 ||
                 String(o.customer || '').toLowerCase().indexOf(q) > -1 ||
                 String(o.phone || '').indexOf(q) > -1;
        });
      }
      return rows;
    }

    function row (o, i) {
      var amt = money(o.total, o.currency);
      var t = when(o.ts);
      return '<div class="rc-row">' +
        '<div class="rc-i">' +
          '<div class="rc-ref">' + esc(o.ref || o.id) + '</div>' +
          '<div class="rc-m">' + esc(o.customer || 'Walk-in') +
            (t ? ' · ' + esc(t) : '') + '</div>' +
        '</div>' +
        /* Amount is shown only when it is known. An unknown total rendered as
           KES 0 is a fabricated figure on a financial document. */
        '<div class="rc-amt">' + esc(amt === null ? '—' : amt) + '</div>' +
        '<button class="rc-btn" data-rc="open" data-i="' + i + '">Receipt</button>' +
      '</div>';
    }

    /* ── THE DOCUMENT ───────────────────────────────────────────────────────
       Rendered by the locked contract, never by markup written here. If the
       contract is not loaded the surface says so — it does not improvise a
       second receipt layout, which is how two receipt formats appear. */
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

    function sheet () {
      var o = S.open;
      var d = docFor(o);
      var body = d
        ? '<div class="rc-doc">' + esc(d.text) + '</div>'
        : '<div class="rc-state">The receipt document could not be produced.<br>' +
          'Nothing is shown rather than a different-looking receipt.</div>';
      var warn = (d && d.warnings.length)
        ? '<div class="rc-note">' + d.warnings.map(esc).join('<br>') + '</div>' : '';
      return '<div class="rc-sheet"><div class="rc-scrim" data-rc="close"></div>' +
        '<div class="rc-panel" role="dialog" aria-modal="true" aria-label="Receipt">' +
        body + warn +
        '<div class="rc-foot">' +
          '<button class="rc-close" data-rc="close">Close</button>' +
          (d ? '<button class="rc-print" data-rc="print">Print</button>' : '') +
        '</div></div></div>';
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
      var body = rows.length
        ? '<div class="rc-list">' + rows.map(function (o, i) { return row(o, i); }).join('') + '</div>'
        : '<div class="rc-state">' + (S.rows.length
            ? 'No sale matches that search.'
            : 'No sales yet.<br>A receipt is produced for every completed sale.') + '</div>';

      host.innerHTML =
        '<div class="rc-top"><div class="rc-h">Receipts</div>' +
          '<div class="rc-count">' + esc(S.rows.length +
            (S.rows.length === 1 ? ' sale' : ' sales')) + '</div></div>' +
        '<div class="rc-sub">Every completed sale, with its SOKONI receipt.</div>' +
        '<div class="rc-tools">' +
          '<input class="rc-search" type="search" inputmode="search" placeholder="Search by reference, customer or phone" ' +
            'aria-label="Search receipts" value="' + esc(S.q) + '" data-rc="q">' +
        '</div>' + body +
        (S.open ? sheet() : '');
    }

    /* ── LOAD: the shell's ONE orders reader ────────────────────────────── */
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
      if (!el || !el.getAttribute || el.getAttribute('data-rc') !== 'q') return;
      clearTimeout(_t);
      var v = el.value;
      _t = setTimeout(function () {
        S.q = v; paint();
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
        S.open = o; return paint();
      }
      if (k === 'print') {
        var d = docFor(S.open);
        if (!d) return;
        /* Printing goes through the shell's device layer — the same connection
           POS uses — because a second printer path is a second queue. */
        if (typeof ctx.onPrint === 'function') return ctx.onPrint({ text: d.text, order: S.open });
        if (typeof ctx.onToast === 'function') ctx.onToast('No printer service is loaded.');
      }
    }

    function onKey (ev) { if (ev.key === 'Escape' && S.open) { S.open = null; paint(); } }

    host.addEventListener('input', onInput);
    host.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    load();

    return {
      refresh: function () { S.rows = null; S.err = null; return load(); },
      destroy: function () {
        S.destroyed = true;
        clearTimeout(_t);
        host.removeEventListener('input', onInput);
        host.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        if (host && host.classList) host.classList.remove(HOST_CLASS);
        host.innerHTML = '';
      },
    };
  }

  return { mount: mount };
}));
