/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI MERCHANT — PRODUCTS 2a + 2b + 2c  (list, edit, and photographs)
   ══════════════════════════════════════════════════════════════════════════════
   List, search, filter, sort and view; create, edit and delete; and attach
   photographs to a product that already exists.

   ── IT OWNS THE FORM, AND NOTHING ELSE ──────────────────────────────────────
   Every mutation goes through SokoniMerchantData's certified writer. Ownership
   checks, validation, the publication gate, the three projections and
   idempotency all live there, proven independently of this file, so a defect in
   the write path cannot arrive hidden inside a UI conversion.

   Photos are the same story: this surface CHOOSES files and reports what
   happened. attachProductImages owns the sequence — ownership, then Storage,
   then the canonical record, then the projections — so the product record is
   only ever told about addresses Storage actually returned.

   Still absent, deliberately: no stock adjustment (Inventory owns that), no
   productCounters write, no boost or promote-to-story (2d), and no localStorage
   cache treated as authority — the list is re-READ from Firestore after every
   successful mutation.

   ── AND IT OWNS NO AUTHORITY ────────────────────────────────────────────────
       products      SokoniMerchantData.listProducts({scope, db})
                     the canonical reader, scoped by shopId — the SAME one the
                     native Inventory surface uses
       the ceiling   ctx.entitlement().uploadLimit
                     display only, from getMerchantEntitlements, which resolves
                     through subscription-catalog.entitlementFor()

       the gate      ctx.canPublish -> canPublishProduct
                     CONSULTED before any write, by the writer, never modelled
                     here. This surface performs no limit arithmetic and shows
                     the server's own refusal text rather than inventing one.

   ── PRODUCTS IS NOT INVENTORY ───────────────────────────────────────────────
   Inventory owns stock and adjustment (merchantAdjustStock). This surface shows
   stock as a READ and offers no way to change it. The two must not merge.

   Contract: mount(host, ctx) -> { refresh, destroy }
   ══════════════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniMerchantProducts = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CSS_ID = 'sokoni-merchant-products-css';
  /* Scoped by CLASS, never by host id: merchant.html names panels #native-<id>
     and merchant-v2 names them #panel-<id>. Targeting either would render this
     surface unstyled in the other shell — a defect that passes every functional
     check, and one this programme has already made once. */
  var HOST_CLASS = 'sk-mprod';
  var CSS = [
    '.sk-mprod{padding:14px 12px 96px}',
    '.pr-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;margin-bottom:4px}',
    '.pr-h{font-size:19px;font-weight:800;letter-spacing:-.01em}',
    '.pr-count{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55))}',
    '.pr-sub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:14px}',
    '.pr-tools{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}',
    '.pr-search{flex:1 1 180px;min-width:0;min-height:44px;border-radius:12px;padding:0 14px;font:inherit;font-size:16px;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));color:inherit}',
    '.pr-sel{min-height:44px;border-radius:12px;padding:0 10px;font:inherit;font-size:13px;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));color:inherit}',
    '.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(150px,100%),1fr));gap:10px}',
    '.pr-card{background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.12));',
    'border-radius:14px;overflow:hidden;min-width:0;display:flex;flex-direction:column}',
    '.pr-img{width:100%;aspect-ratio:1/1;object-fit:cover;background:rgba(255,255,255,.04);display:block}',
    '.pr-ph{width:100%;aspect-ratio:1/1;background:rgba(255,255,255,.04);display:flex;align-items:center;',
    'justify-content:center;font-size:24px;color:var(--txt2,rgba(255,255,255,.3))}',
    '.pr-b{padding:10px 11px 12px;min-width:0}',
    '.pr-n{font-size:13px;font-weight:700;line-height:1.35;overflow:hidden;display:-webkit-box;',
    '-webkit-line-clamp:2;-webkit-box-orient:vertical;word-break:break-word}',
    '.pr-p{font-size:14px;font-weight:800;margin-top:5px}',
    '.pr-m{font-size:11.5px;color:var(--txt2,rgba(255,255,255,.5));margin-top:4px}',
    '.pr-tag{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 7px;border-radius:8px;margin-top:6px;',
    'border:1px solid var(--line,rgba(255,255,255,.14))}',
    '.pr-tag.out{color:#ff6b6b;border-color:rgba(255,107,107,.4)}',
    '.pr-tag.draft{color:#ffb020;border-color:rgba(255,176,32,.4)}',
    '.pr-state{padding:30px 18px;text-align:center;color:var(--txt2,rgba(255,255,255,.6));font-size:13.5px;line-height:1.7}',
    '.pr-sk{aspect-ratio:1/1;border-radius:14px;background:var(--card,#0e0e0e);',
    'border:1px solid var(--line,rgba(255,255,255,.10));animation:prsk 1.1s ease-in-out infinite}',
    '@keyframes prsk{0%,100%{opacity:.55}50%{opacity:.85}}',
    '@media (prefers-reduced-motion:reduce){.pr-sk{animation:none}}',
    /* ── 2b: the editor ─────────────────────────────────────────────────── */
    '.pr-add{min-height:44px;border-radius:12px;padding:0 16px;cursor:pointer;font:inherit;font-weight:800;',
    'font-size:13px;background:var(--acc,#71ff00);color:#050505;border:0;white-space:nowrap}',
    '.pr-acts{display:flex;gap:6px;margin-top:9px}',
    '.pr-act{flex:1;min-height:36px;border-radius:9px;cursor:pointer;font:inherit;font-weight:700;font-size:12px;',
    'background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.14))}',
    '.pr-act.danger{color:#ff6b6b;border-color:rgba(255,107,107,.35)}',
    '.pr-sheet{position:fixed;inset:0;z-index:70;display:flex;align-items:flex-end;justify-content:center}',
    '.pr-scrim{position:absolute;inset:0;background:rgba(0,0,0,.62)}',
    '.pr-panel{position:relative;width:100%;max-width:520px;max-height:92vh;overflow:auto;',
    'background:var(--card,#0e0e0e);border:1px solid var(--line,rgba(255,255,255,.14));',
    'border-radius:18px 18px 0 0;padding:18px 16px calc(18px + env(safe-area-inset-bottom,0px))}',
    '@media (min-width:600px){.pr-sheet{align-items:center}.pr-panel{border-radius:18px}}',
    '.pr-ph2{font-size:17px;font-weight:800;margin-bottom:2px}',
    '.pr-psub{font-size:12.5px;color:var(--txt2,rgba(255,255,255,.55));margin-bottom:16px}',
    '.pr-f{margin-bottom:13px}',
    '.pr-l{display:block;font-size:12px;font-weight:700;margin-bottom:6px;color:var(--txt2,rgba(255,255,255,.7))}',
    /* border-box, because these are width:100% AND padded: with the default
       content-box the padding is added OUTSIDE the 100% and every field spills
       past the sheet — measured at 390px, where the file input ran off the
       right edge. */
    '.pr-i{box-sizing:border-box;width:100%;min-height:46px;border-radius:11px;padding:11px 13px;font:inherit;font-size:16px;',
    'background:rgba(255,255,255,.04);border:1px solid var(--line,rgba(255,255,255,.13));color:inherit}',
    '.pr-i:focus{outline:2px solid var(--acc,#71ff00);outline-offset:1px}',
    'textarea.pr-i{min-height:84px;resize:vertical}',
    '.pr-row{display:flex;gap:10px}.pr-row>.pr-f{flex:1;min-width:0}',
    '.pr-err{font-size:12.5px;color:#ff6b6b;margin-top:6px}',
    '.pr-note{font-size:12px;color:var(--txt2,rgba(255,255,255,.5));margin-top:5px;line-height:1.5}',
    '.pr-foot{display:flex;gap:9px;margin-top:6px}',
    '.pr-foot>button{flex:1;min-height:48px;border-radius:12px;cursor:pointer;font:inherit;font-weight:800;font-size:14px}',
    '.pr-save{background:var(--acc,#71ff00);color:#050505;border:0}',
    '.pr-save[disabled]{opacity:.55;cursor:progress}',
    '.pr-cancel{background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.16))}',
    '.pr-danger{background:#ff6b6b;color:#0a0a0a;border:0}',
    '.pr-warn{font-size:12.5px;line-height:1.6;padding:11px 12px;border-radius:11px;margin-bottom:14px;',
    'background:rgba(255,176,32,.09);border:1px solid rgba(255,176,32,.3);color:#ffb020}',
    /* ── 2c: photos ─────────────────────────────────────────────────────── */
    '.pr-thumbs{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}',
    '.pr-thumb{width:74px;height:74px;object-fit:cover;border-radius:10px;background:rgba(255,255,255,.05);',
    'border:1px solid var(--line,rgba(255,255,255,.12))}',
    'input[type=file].pr-i{padding:11px 12px;line-height:1.4}',
    '.pr-block{font-size:12.5px;line-height:1.6;padding:11px 12px;border-radius:11px;margin-bottom:14px;',
    'background:rgba(255,107,107,.08);border:1px solid rgba(255,107,107,.3);color:#ff8a8a}',
    '.pr-btn{min-height:44px;border-radius:12px;padding:0 16px;cursor:pointer;font:inherit;font-weight:700;',
    'font-size:13px;background:transparent;color:inherit;border:1px solid var(--line,rgba(255,255,255,.14))}',
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
    var v = Number(n);
    if (!isFinite(v)) return null;          /* never "KES NaN" */
    return 'KES ' + Math.round(v).toLocaleString('en-KE');
  }

  function mount (host, ctx) {
    css();
    ctx = ctx || {};
    if (host && host.classList) host.classList.add(HOST_CLASS);

    var S = {
      rows: null,        /* null = not loaded; [] = loaded and genuinely empty */
      err: null,
      q: '',
      status: 'all',
      sort: 'recent',
      limit: undefined,  /* undefined = unknown; -1 = unlimited */
      editor: null,      /* null = closed; otherwise the open create/edit/delete form */
      destroyed: false,
    };

    function skeleton () {
      var cells = '';
      for (var i = 0; i < 6; i++) cells += '<div class="pr-sk"></div>';
      host.innerHTML =
        '<div class="pr-top"><div class="pr-h">Products</div></div>' +
        '<div class="pr-sub">Loading your catalogue…</div>' +
        '<div class="pr-grid">' + cells + '</div>';
    }

    /* ── THE CEILING IS DISPLAYED, NEVER ENFORCED HERE ──────────────────────
       uploadLimit answers "what is my ceiling"; canPublishProduct answers "may
       I publish", and that is a WRITE question this slice never asks. Unknown
       renders as nothing at all — never as 0, and never as a guessed tier. */
    function countLine () {
      if (S.rows === null) return '';
      var n = S.rows.length;
      if (S.limit === -1) return n + ' of unlimited';
      if (typeof S.limit === 'number' && isFinite(S.limit)) return n + ' of ' + S.limit;
      return n + (n === 1 ? ' product' : ' products');
    }

    function visible () {
      var rows = (S.rows || []).slice();
      var q = S.q.trim().toLowerCase();
      if (q) {
        rows = rows.filter(function (p) {
          return String(p.name || p.title || '').toLowerCase().indexOf(q) > -1 ||
                 String(p.sku || '').toLowerCase().indexOf(q) > -1 ||
                 String(p.category || '').toLowerCase().indexOf(q) > -1;
        });
      }
      if (S.status === 'active')  rows = rows.filter(function (p) { return p.status === 'active'; });
      if (S.status === 'draft')   rows = rows.filter(function (p) { return p.status && p.status !== 'active'; });
      if (S.status === 'out')     rows = rows.filter(function (p) { return Number(p.stock) === 0; });

      var by = S.sort;
      rows.sort(function (a, b) {
        if (by === 'name')      return String(a.name || '').localeCompare(String(b.name || ''));
        if (by === 'price-asc') return (Number(a.price) || 0) - (Number(b.price) || 0);
        if (by === 'price-desc')return (Number(b.price) || 0) - (Number(a.price) || 0);
        if (by === 'stock')     return (Number(a.stock) || 0) - (Number(b.stock) || 0);
        var at = a.createdAt && a.createdAt.seconds ? a.createdAt.seconds : 0;
        var bt = b.createdAt && b.createdAt.seconds ? b.createdAt.seconds : 0;
        return bt - at;                                  /* recent first */
      });
      return rows;
    }

    function card (p, i) {
      var img = p.image || (Array.isArray(p.images) && p.images[0]) || null;
      var price = money(p.price);
      var out = Number(p.stock) === 0;
      var draft = p.status && p.status !== 'active';
      return '<div class="pr-card">' +
        (img ? '<img class="pr-img" loading="lazy" alt="" src="' + esc(img) + '">'
             : '<div class="pr-ph" aria-hidden="true">📦</div>') +
        '<div class="pr-b">' +
          '<div class="pr-n">' + esc(p.name || p.title || 'Untitled') + '</div>' +
          '<div class="pr-p">' + esc(price === null ? '—' : price) + '</div>' +
          /* Stock is READ here. Changing it belongs to Inventory. */
          '<div class="pr-m">' + (typeof p.stock === 'number' ? esc(p.stock) + ' in stock' : 'Stock —') + '</div>' +
          (out ? '<span class="pr-tag out">Out of stock</span>' : '') +
          (draft ? '<span class="pr-tag draft">' + esc(p.status) + '</span>' : '') +
          /* Indices, never interpolated ids: an id spliced into an inline handler
             is the inline-handler XSS this codebase has already been bitten by. */
          '<div class="pr-acts">' +
            '<button class="pr-act" data-pr="edit" data-i="' + i + '">Edit</button>' +
            '<button class="pr-act" data-pr="photos" data-i="' + i + '">' +
              (p.image ? 'Photos' : '+ Photo') + '</button>' +
            '<button class="pr-act danger" data-pr="del" data-i="' + i + '">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    function paint () {
      if (S.destroyed) return;
      if (S.rows === null && !S.err) return skeleton();

      if (S.err) {
        host.innerHTML =
          '<div class="pr-top"><div class="pr-h">Products</div></div>' +
          '<div class="pr-state">Your products couldn’t be loaded just now.<br>' +
          'This is not an empty catalogue — nothing was fetched.<br>' +
          '<button class="pr-btn" style="margin-top:14px" data-pr="retry">Try again</button></div>';
        return;
      }

      var rows = visible();
      var body;
      if (!rows.length) {
        body = '<div class="pr-state">' +
          (S.rows.length ? 'No products match this search or filter.'
                         : 'No products yet.<br>Add your first product to start selling.') +
          '</div>';
      } else {
        body = '<div class="pr-grid">' + rows.map(function (p, i) { return card(p, i); }).join('') + '</div>';
      }
      /* The rows the buttons index into — captured at paint time, so a filter
         change between paint and click cannot resolve to the wrong product. */
      S.painted = rows;

      host.innerHTML =
        '<div class="pr-top"><div class="pr-h">Products</div>' +
          '<div class="pr-count">' + esc(countLine()) + '</div></div>' +
        '<div class="pr-tools" style="margin-bottom:10px">' +
          '<button class="pr-add" data-pr="add">+ Add product</button></div>' +
        '<div class="pr-sub">Your catalogue</div>' +
        '<div class="pr-tools">' +
          '<input class="pr-search" type="search" inputmode="search" placeholder="Search products" ' +
            'aria-label="Search products" value="' + esc(S.q) + '" data-pr="q">' +
          '<select class="pr-sel" aria-label="Filter by status" data-pr="status">' +
            opt('all', 'All', S.status) + opt('active', 'Active', S.status) +
            opt('draft', 'Draft', S.status) + opt('out', 'Out of stock', S.status) +
          '</select>' +
          '<select class="pr-sel" aria-label="Sort products" data-pr="sort">' +
            opt('recent', 'Newest', S.sort) + opt('name', 'Name', S.sort) +
            opt('price-asc', 'Price ↑', S.sort) + opt('price-desc', 'Price ↓', S.sort) +
            opt('stock', 'Stock', S.sort) +
          '</select>' +
        '</div>' + body +
        (S.editor ? editorHTML() : '');
    }

    function opt (v, label, cur) {
      return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>';
    }

    /* ── LOAD: the canonical reader, and the ceiling for display ──────────── */
    function load () {
      skeleton();
      var md = (typeof window !== 'undefined') && window.SokoniMerchantData;
      if (!md || typeof md.listProducts !== 'function') {
        S.err = 'SokoniMerchantData unavailable';
        return Promise.resolve(paint());
      }
      var pRows = md.listProducts({ scope: ctx.scope, db: ctx.db });
      /* Display-only. A failure here must NOT fail the list — the merchant's
         products matter more than the ceiling caption, and an unknown ceiling
         renders as nothing rather than as a number we did not read. */
      var pLimit = (typeof ctx.entitlement === 'function')
        ? Promise.resolve().then(ctx.entitlement).catch(function () { return null; })
        : Promise.resolve(null);

      return Promise.all([pRows, pLimit]).then(function (r) {
        if (S.destroyed) return;
        S.rows = Array.isArray(r[0]) ? r[0] : [];
        var ent = r[1];
        S.limit = (ent && typeof ent.uploadLimit === 'number') ? ent.uploadLimit : undefined;
        S.err = null;
        paint();
      }).catch(function (e) {
        if (S.destroyed) return;
        S.err = (e && e.message) || String(e);
        paint();
      });
    }

    /* ══ 2b — CREATE / EDIT / DELETE ═══════════════════════════════════════
       This surface owns the FORM and nothing else. Every mutation goes through
       SokoniMerchantData, which owns ownership checks, validation, the
       publication gate, the three projections and idempotency, and which is
       certified independently of this file.

       What deliberately does NOT live here:
         · no Firestore SDK import — ctx.db is the only way to touch storage
         · no plan-limit arithmetic — canPublishProduct is asked, never modelled
         · no productCounters write of any kind
         · no Storage, no image field — a product is valid without pictures and
           media attaches in 2c
         · no localStorage. A cache is never the authority for what exists; the
           list is re-read from Firestore after every successful mutation. */

    function draftToken () {
      /* One token per ATTEMPT, not per keystroke and not per product. The writer
         derives a deterministic id from it, so pressing Save twice — or retrying
         after a dropped response — claims the same document instead of creating
         a second product. It is regenerated only when a NEW form is opened. */
      return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 9);
    }

    function openEditor (mode, product) {
      S.editor = {
        mode: mode,                       /* 'create' | 'edit' | 'delete' */
        product: product || null,
        /* What the merchant has typed, held in STATE. Rendering the form from
           the product alone means any re-paint — a blocked gate, a validation
           message, the busy state — silently discards their work. */
        values: Object.assign({}, product || {}),
        token: draftToken(),
        busy: false,
        err: null,
        blocked: null,                    /* the server's refusal, verbatim */
      };
      paint();
      /* Focus the first field so a keyboard user is not dropped at the scrim. */
      var f = host.querySelector('.pr-panel [data-pf]');
      if (f && f.focus) { try { f.focus(); } catch (_) {} }
    }
    function closeEditor () { S.editor = null; _picked = []; paint(); }

    var FORM_KEYS = ['name', 'price', 'costPrice', 'stock', 'sku', 'category', 'description', 'status'];
    var NUMERIC = { price: 1, costPrice: 1, stock: 1 };

    /* Pull every field the form is showing into editor state. */
    function captureForm () {
      if (!S.editor) return;
      FORM_KEYS.forEach(function (k) {
        var el = host.querySelector('[data-pf="' + k + '"]');
        if (el) S.editor.values[k] = el.value;
      });
    }

    function fieldsFromForm () {
      var v = (S.editor && S.editor.values) || {};
      var out = {};
      FORM_KEYS.forEach(function (k) {
        var raw = v[k];
        if (raw === undefined) return;
        if (NUMERIC[k]) {
          /* Empty is ABSENT, not zero. A blank cost must not become a cost of 0,
             which would report a 100% margin on the product. */
          if (raw === '' || raw === null) return;
          out[k] = Number(raw);
        } else {
          out[k] = raw;
        }
      });
      return out;
    }
    /* Only what actually CHANGED is sent. Sending the whole form on every edit
       would rewrite fields the merchant never touched, and would silently
       clobber a value another surface (Inventory, POS) had changed meanwhile. */
    function changedOnly (next, prev) {
      var out = {};
      Object.keys(next).forEach(function (k) {
        if (next[k] === undefined) return;
        var before = prev ? prev[k] : undefined;
        if (k === 'sku' || k === 'category' || k === 'description' || k === 'status' || k === 'name') {
          if (String(next[k] || '') !== String(before == null ? '' : before)) out[k] = next[k];
        } else if (Number(next[k]) !== Number(before == null ? NaN : before)) {
          out[k] = next[k];
        }
      });
      return out;
    }

    function md () {
      var m = (typeof window !== 'undefined') && window.SokoniMerchantData;
      if (!m || typeof m.createProduct !== 'function') {
        throw new Error('The product editor is not available just now.');
      }
      return m;
    }

    function say (msg) { if (typeof ctx.onToast === 'function') ctx.onToast(msg); }

    /* A mutation reports what ACTUALLY happened, including partial success. A
       product that reached the catalogue but not the till is not a plain
       success, and saying so is the difference between a merchant who knows to
       retry and one who wonders why the till cannot find their product. */
    function reportCreate (res) {
      if (res.replayed) return say('Already saved — no duplicate was created.');
      if (res.complete) return say('Product added, and it is ready at the till.');
      var missing = Object.keys(res.mirrors || {}).filter(function (k) {
        return res.mirrors[k].state !== 'written';
      });
      say('Product added to your catalogue. Not yet available at ' +
          (missing.indexOf('pos') > -1 ? 'the till' : 'Inventory') +
          ' — open Products again to finish syncing.');
    }

    function submit () {
      var E = S.editor;
      if (!E || E.busy) return;
      /* Read the form BEFORE any repaint. paint() rebuilds the inputs from state,
         so reading afterwards would read the freshly rendered fields and not the
         ones the merchant filled in. */
      if (E.mode !== 'delete') captureForm();
      E.busy = true; E.err = null; E.blocked = null; paint();

      var done = function (fn) {
        return function (v) {
          if (S.destroyed) return;
          E.busy = false;
          fn(v);
        };
      };

      var run;
      try {
        var M = md();
        if (E.mode === 'delete') {
          run = M.deleteProduct({ scope: ctx.scope, db: ctx.db, id: E.product.id });
        } else if (E.mode === 'edit') {
          var patch = changedOnly(fieldsFromForm(), E.product);   /* stored record, not the form */
          if (!Object.keys(patch).length) { E.busy = false; closeEditor(); return say('Nothing changed.'); }
          run = M.updateProduct({ scope: ctx.scope, db: ctx.db, id: E.product.id, patch: patch });
        } else {
          run = M.createProduct({
            scope: ctx.scope, db: ctx.db, draftToken: E.token,
            product: fieldsFromForm(),
            /* CONSULTED, not reimplemented — and consulted by the WRITER, before
               it writes anything, so a refusal mutates nothing at all. */
            canPublish: (typeof ctx.canPublish === 'function') ? ctx.canPublish : null,
            /* createdAt is NOT stamped here. A client clock is not a timestamp
               authority; the adapter applies serverTimestamp() at the write. */
          });
        }
      } catch (e) {
        E.busy = false; E.err = (e && e.message) || String(e); return paint();
      }

      run.then(done(function (res) {
        var mode = E.mode;
        S.editor = null;
        if (mode === 'create') reportCreate(res || {});
        else if (mode === 'edit') say('Changes saved.');
        else say('Product deleted.');
        /* Re-READ. The list is never patched from what we believe we wrote. */
        S.rows = null; load();
      })).catch(done(function (e) {
        if (e && e.code === 'publish-refused') {
          /* The server's own words. Never a locally invented limit message. */
          E.blocked = e.message || 'Your plan does not allow another product.';
        } else {
          E.err = (e && e.message) || String(e);
        }
        paint();
      }));
    }

    /* ══ 2c — PHOTOS ═══════════════════════════════════════════════════════
       Photos attach to a product that ALREADY EXISTS, which is why this is a
       per-product action and not a field on the create form: the Storage path
       is product-images/{sellerUid}/{productId}/{i}.jpg, so there is no path to
       write to until the product has an id.

       This surface chooses files and reports what happened. It performs no
       upload of its own — SokoniMerchantData.attachProductImages owns the
       sequence (ownership, then Storage, then the record, then the projections),
       and the record is only ever told about addresses Storage actually
       returned. */

    function mediaModule () {
      var m = (typeof window !== 'undefined') && window.SokoniMerchantMedia;
      if (!m || typeof m.validateAll !== 'function') {
        throw new Error('The photo uploader is not available just now.');
      }
      return m;
    }

    function openPhotos (product) {
      S.editor = {
        mode: 'photos',
        product: product,
        values: {},
        busy: false,
        err: null,
        blocked: null,
        rejected: [],          /* files refused before any upload was attempted */
        progress: null,        /* {done, total} while bytes are moving */
      };
      paint();
    }

    /* Chosen files are held here rather than read from the input at submit time:
       a repaint replaces the <input type=file>, and a replaced file input is
       empty. Reading it later would silently upload nothing. */
    var _picked = [];

    function onFiles (fileList) {
      var E = S.editor;
      if (!E || E.mode !== 'photos') return;
      var M;
      try { M = mediaModule(); } catch (e) { E.err = e.message; return paint(); }

      var check = M.validateAll(fileList);
      _picked = check.accepted;
      E.rejected = check.rejected;
      E.err = null;
      /* Every refusal is shown, and the acceptable files are still offered —
         one bad file in a selection of four must not discard the other three. */
      paint();
    }

    function submitPhotos () {
      var E = S.editor;
      if (!E || E.busy) return;
      if (!_picked.length) { E.err = 'Choose at least one photo first.'; return paint(); }

      E.busy = true; E.err = null; E.progress = { done: 0, total: _picked.length };
      paint();

      var M;
      try { M = md(); mediaModule(); }
      catch (e) { E.busy = false; E.err = e.message; return paint(); }

      M.attachProductImages({
        scope: ctx.scope, db: ctx.db, media: mediaModule(), storage: ctx.storage,
        id: E.product.id, files: _picked,
        onProgress: function (done, total) {
          if (S.destroyed || !S.editor) return;
          S.editor.progress = { done: done, total: total };
          paint();
        },
      }).then(function (res) {
        if (S.destroyed) return;
        _picked = [];
        S.editor = null;
        if (res.complete) {
          say(res.urls.length === 1 ? 'Photo added.' : res.urls.length + ' photos added.');
        } else {
          /* The photo IS on the product; it has not reached the till's copy. */
          say('Photo saved to your product. The till’s copy has not updated yet — ' +
              'open Products again to finish syncing.');
        }
        S.rows = null; load();
      }).catch(function (e) {
        if (S.destroyed) return;
        E.busy = false;
        E.progress = null;
        /* The writer sets wrote:false when nothing reached the product record.
           Saying so plainly is the difference between a merchant who retries and
           one who believes a broken image is live. */
        E.err = (e && e.message) || 'The photo could not be uploaded.';
        E.wroteNothing = (e && e.wrote === false);
        paint();
      });
    }

    function photosHTML () {
      var E = S.editor, p = E.product || {};
      var M = (typeof window !== 'undefined') && window.SokoniMerchantMedia;
      var have = (p.images && p.images.length) ? p.images : (p.image ? [p.image] : []);
      var accept = (M && M.accept) || 'image/*';

      var thumbs = have.length
        ? '<div class="pr-thumbs">' + have.map(function (u) {
            return '<img class="pr-thumb" alt="" src="' + esc(u) + '">';
          }).join('') + '</div>'
        : '<div class="pr-note" style="margin-bottom:14px">This product has no photos yet. ' +
          'It can still be sold — a photo simply helps it sell.</div>';

      var chosen = _picked.length
        ? '<div class="pr-note">' + _picked.length +
          (_picked.length === 1 ? ' photo ready to upload.' : ' photos ready to upload.') + '</div>'
        : '';

      var rejected = (E.rejected && E.rejected.length)
        ? '<div class="pr-block">' + E.rejected.map(function (r) {
            return esc((r.name ? r.name + ': ' : '') + r.reason);
          }).join('<br>') + '</div>'
        : '';

      var progress = E.progress
        ? '<div class="pr-note">Uploading ' + E.progress.done + ' of ' + E.progress.total + '…</div>'
        : '';

      return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div>' +
        '<div class="pr-panel" role="dialog" aria-modal="true" aria-label="Product photos">' +
        '<div class="pr-ph2">Photos</div>' +
        '<div class="pr-psub">' + esc(p.name || 'Untitled') + '</div>' +
        thumbs + rejected +
        '<div class="pr-f"><label class="pr-l" for="pf-photos">Add photos</label>' +
          /* `accept` mirrors the deployed Storage rule's safeImageOnly list, and
             no `capture` attribute — on iOS `capture` forces the camera and takes
             away the merchant's photo library, which is where their product
             pictures already are. */
          '<input class="pr-i" type="file" id="pf-photos" data-pf="photos" ' +
            'accept="' + esc(accept) + '" multiple>' +
          '<div class="pr-note">JPEG, PNG, WebP, GIF or AVIF, up to 15 MB each. ' +
          'Large photos are shrunk before upload.</div></div>' +
        chosen + progress +
        (E.err ? '<div class="pr-err">' + esc(E.err) +
          (E.wroteNothing ? '<br>Nothing was changed — your product is exactly as it was.' : '') +
          '</div>' : '') +
        '<div class="pr-foot">' +
          '<button class="pr-cancel" data-pr="close">' + (E.busy ? 'Close' : 'Done') + '</button>' +
          '<button class="pr-save" data-pr="submit-photos"' + (E.busy ? ' disabled' : '') + '>' +
            (E.busy ? 'Uploading…' : 'Upload') + '</button>' +
        '</div></div></div>';
    }

    function fld (key, label, attrs, val, note) {
      return '<div class="pr-f"><label class="pr-l" for="pf-' + key + '">' + esc(label) + '</label>' +
        '<input class="pr-i" id="pf-' + key + '" data-pf="' + key + '" ' + attrs +
        ' value="' + esc(val == null ? '' : val) + '">' +
        (note ? '<div class="pr-note">' + esc(note) + '</div>' : '') + '</div>';
    }

    function editorHTML () {
      var E = S.editor;
      if (E.mode === 'photos') return photosHTML();
      /* Render from the TYPED values, falling back to the stored record. */
      var p = (E.mode === 'delete') ? (E.product || {}) : (E.values || {});
      if (E.mode === 'delete') {
        return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div><div class="pr-panel" role="dialog" aria-modal="true" aria-label="Delete product">' +
          '<div class="pr-ph2">Delete this product?</div>' +
          '<div class="pr-psub">' + esc(p.name || 'Untitled') + '</div>' +
          '<div class="pr-warn">It will be removed from your catalogue and from the till. ' +
          'Orders already placed keep their record. This cannot be undone.</div>' +
          (E.err ? '<div class="pr-err">' + esc(E.err) + '</div>' : '') +
          '<div class="pr-foot">' +
            '<button class="pr-cancel" data-pr="close">Keep it</button>' +
            '<button class="pr-danger" data-pr="submit"' + (E.busy ? ' disabled' : '') + '>' +
              (E.busy ? 'Deleting…' : 'Delete') + '</button>' +
          '</div></div></div>';
      }
      var creating = E.mode === 'create';
      return '<div class="pr-sheet"><div class="pr-scrim" data-pr="close"></div><div class="pr-panel" role="dialog" aria-modal="true" aria-label="' +
        (creating ? 'Add a product' : 'Edit product') + '">' +
        '<div class="pr-ph2">' + (creating ? 'Add a product' : 'Edit product') + '</div>' +
        '<div class="pr-psub">' + (creating
          ? 'It goes to your shop, your Inventory and the till.'
          : esc(p.name || 'Untitled')) + '</div>' +
        (E.blocked ? '<div class="pr-block">' + esc(E.blocked) + '</div>' : '') +
        fld('name', 'Product name', 'type="text" autocomplete="off" maxlength="200" required', p.name) +
        '<div class="pr-row">' +
          fld('price', 'Price (KES)', 'type="number" inputmode="decimal" min="1" step="any" required', p.price) +
          fld('costPrice', 'Cost (KES)', 'type="number" inputmode="decimal" min="0" step="any"', p.costPrice) +
        '</div>' +
        '<div class="pr-row">' +
          fld('stock', 'Stock', 'type="number" inputmode="numeric" min="0" step="1"', p.stock) +
          fld('sku', 'SKU', 'type="text" autocomplete="off" maxlength="64"', p.sku) +
        '</div>' +
        fld('category', 'Category', 'type="text" autocomplete="off" maxlength="64"', p.category) +
        '<div class="pr-f"><label class="pr-l" for="pf-description">Description</label>' +
          '<textarea class="pr-i" id="pf-description" data-pf="description" maxlength="4000">' +
          esc(p.description || '') + '</textarea></div>' +
        '<div class="pr-f"><label class="pr-l" for="pf-status">Visibility</label>' +
          '<select class="pr-i" id="pf-status" data-pf="status">' +
            opt('active', 'Active — on sale', p.status || 'active') +
            opt('draft', 'Draft — hidden', p.status || 'active') +
          '</select>' +
          '<div class="pr-note">Photos are added separately. A product sells without one.</div></div>' +
        (E.err ? '<div class="pr-err">' + esc(E.err) + '</div>' : '') +
        '<div class="pr-foot">' +
          '<button class="pr-cancel" data-pr="close">Cancel</button>' +
          '<button class="pr-save" data-pr="submit"' + (E.busy ? ' disabled' : '') + '>' +
            (E.busy ? 'Saving…' : (creating ? 'Add product' : 'Save changes')) + '</button>' +
        '</div></div></div>';
    }

    var _t = null;
    function onInput (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      /* Every keystroke in the editor is mirrored into state, so a repaint
         mid-edit keeps the merchant's work. */
      if (S.editor && el.getAttribute('data-pf')) {
        S.editor.values[el.getAttribute('data-pf')] = el.value;
        return;
      }
      var k = el.getAttribute('data-pr');
      if (k === 'q') {
        clearTimeout(_t);
        var v = el.value;
        _t = setTimeout(function () {
          S.q = v;
          paint();
          var s = host.querySelector('[data-pr="q"]');
          if (s) { s.focus(); try { s.setSelectionRange(v.length, v.length); } catch (_) {} }
        }, 200);
      }
    }
    function onChange (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;
      if (S.editor && el.getAttribute('data-pf') === 'photos') return onFiles(el.files);
      if (S.editor && el.getAttribute('data-pf')) {
        S.editor.values[el.getAttribute('data-pf')] = el.value;
        return;
      }
      var k = el.getAttribute('data-pr');
      if (k === 'status') { S.status = el.value; paint(); }
      if (k === 'sort')   { S.sort = el.value; paint(); }
    }
    function onClick (ev) {
      var el = ev.target && ev.target.closest && ev.target.closest('[data-pr]');
      if (!el) return;
      var k = el.getAttribute('data-pr');

      if (k === 'retry') { S.err = null; S.rows = null; return load(); }
      if (k === 'add')   return openEditor('create', null);
      if (k === 'close') { if (S.editor && S.editor.busy) return; return closeEditor(); }
      if (k === 'submit') return submit();
      if (k === 'submit-photos') return submitPhotos();

      if (k === 'edit' || k === 'del' || k === 'photos') {
        /* Resolve through the rows captured at paint time. An index into a list
           that has since been re-filtered would open the wrong product — and for
           `del` that is a merchant losing a product they did not choose. */
        var i = Number(el.getAttribute('data-i'));
        var p = (S.painted || [])[i];
        if (!p) return say('That product is no longer in view — reopen Products and try again.');
        if (k === 'photos') return openPhotos(p);
        return openEditor(k === 'edit' ? 'edit' : 'delete', p);
      }
    }

    /* Escape closes the sheet, but never mid-write: dismissing the form while a
       mutation is in flight would leave the merchant with no idea whether it
       landed. */
    function onKey (ev) {
      if (ev.key !== 'Escape' || !S.editor || S.editor.busy) return;
      closeEditor();
    }

    host.addEventListener('input', onInput);
    host.addEventListener('change', onChange);
    host.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey);
    load();

    return {
      refresh: function () { S.rows = null; S.err = null; return load(); },
      destroy: function () {
        S.destroyed = true;
        clearTimeout(_t);
        host.removeEventListener('input', onInput);
        host.removeEventListener('change', onChange);
        host.removeEventListener('click', onClick);
        document.removeEventListener('keydown', onKey);
        if (host && host.classList) host.classList.remove(HOST_CLASS);
        host.innerHTML = '';
      },
    };
  }

  return { mount: mount };
}));
