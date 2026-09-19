/* ============================================================================
   SOKONI AdminOS — Products workspace      sokoni-aos-products.js   v1.0.0
   ============================================================================
   A richer catalogue surface for the Marketplace → Products tab in admin-os.html.

   ADDITIVE, BY THE SAME CONTRACT AS THE ORDERS AND USERS WORKSPACES
   ------------------------------------------------------------------
       window.SokoniAOSProducts.mount({ host, products, actions }) -> truthy

   It renders into `host` and returns true when it did. Returning falsy, or
   throwing, leaves `sokoni-aos.js` to render the original five-column table
   exactly as before. It is never the only way to see a product.

   IT COUNTS WHAT IT LOADED, AND SAYS SO
   --------------------------------------
   `adminGetProducts` is capped server-side. Every figure here is therefore a
   figure about the LOADED PAGE, labelled as such. None of them is a catalogue
   total, and none is presented as one — the same rule the orders workspace
   already follows.

   ── THE INVARIANT THIS FILE EXISTS TO RESPECT ────────────────────────────
   SOKONI's hard product rule is:

       stock 0 = OUT OF STOCK, and the product is NEVER deleted.
       ABSENT stock = UNMETERED, which is NOT zero.

   So a product with `stock: 0` is a real, canonical zero and is shown as
   "Out of stock". A product with NO stock field has never been metered — it is
   not out of stock, it is not in stock, and it must not be counted in either
   bucket or drawn as an empty bar. It renders as "Not metered" with an em dash.

   Collapsing those two is how a catalogue invents a stockout that never
   happened, and it is the one thing certification checks in both directions.

   ── THE STATUS VOCABULARY IS NOT ASSUMED ─────────────────────────────────
   Product documents are written by many paths and this file does not claim to
   know the closed set. Whatever `status` a document carries is rendered
   VERBATIM; statuses this file has no styling for fall into a neutral bucket
   rather than being coerced to "active". A surface that defaults an unknown
   status to active tells an operator a product is live when nothing proved it.

   ── WHAT IS DELIBERATELY NOT BUILT ───────────────────────────────────────
   The reference design carries fields this platform has no source for:
   margin, compare-at price, variant matrices, reserved stock, vendor records,
   and multi-channel publishing state (Amazon / eBay / Retail POS). SOKONI
   publishes to its own storefront; there is no channel registry to read. None
   of those is rendered, and the panel says so rather than showing a plausible
   blank.

   READ-ONLY except for the ONE write AdminOS already owns: the product status
   action, delegated back through `actions.updateStatus`. No pricing, no stock
   and no deletion control is offered — stock is inventory-authority work and a
   product is never deleted, only tombstoned.
   ========================================================================== */
(function () {
  'use strict';

  var EM = '—';

  /* Statuses this surface has styling for. Anything else still renders, in a
     neutral chip — see the vocabulary note above. */
  var KNOWN_STATUS = { active: 'ok', draft: 'muted', pending: 'warn',
                       suspended: 'bad', removed: 'bad', archived: 'muted' };

  /* Low-stock threshold for the bar's colour ONLY. It is a display hint, never
     a business rule: nothing here writes it and no decision is taken from it. */
  var LOW_AT = 10;

  var _state = null;

  /* ── Helpers ─────────────────────────────────────────────────────────── */

  function _esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /** A measured number, or null. Anything else is NOT a measurement. */
  function _num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : null;
  }

  /* Stock is read through this one function so the invariant lives in a single
     place. It returns a STATE, never a bare number, because "0" and "absent"
     must not share a representation anywhere downstream. */
  function _stockState(p) {
    var raw = (p && Object.prototype.hasOwnProperty.call(p, 'stock')) ? p.stock : undefined;
    if (raw === undefined || raw === null || raw === '') {
      return { kind: 'unmetered', n: null };      /* never metered — not zero */
    }
    var n = _num(typeof raw === 'string' ? Number(raw) : raw);
    if (n === null)  return { kind: 'unreadable', n: null };
    if (n <= 0)      return { kind: 'out', n: 0 };   /* a real, canonical zero */
    if (n <= LOW_AT) return { kind: 'low', n: n };
    return { kind: 'in', n: n };
  }

  function _kes(v) {
    var n = _num(v);
    if (n === null) return EM;
    try { return 'KES ' + n.toLocaleString(undefined, { maximumFractionDigits: 0 }); }
    catch (e) { return 'KES ' + Math.round(n); }
  }

  function _ms(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
    if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return 0; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    if (typeof v._seconds === 'number') return v._seconds * 1000;
    return 0;
  }

  function _ago(ms) {
    if (!ms) return EM;
    var d = Date.now() - ms, m = Math.floor(d / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function _statusOf(p) {
    var s = String((p && p.status) || '').trim();
    return s || '(none)';
  }

  /* ── Derived, over the LOADED page only ──────────────────────────────── */

  function _tally(rows) {
    var t = { total: rows.length, byStatus: {}, out: 0, low: 0, inStock: 0,
              unmetered: 0, unreadable: 0, priced: 0 };
    rows.forEach(function (p) {
      var s = _statusOf(p);
      t.byStatus[s] = (t.byStatus[s] || 0) + 1;
      var st = _stockState(p);
      if (st.kind === 'out')        t.out++;
      else if (st.kind === 'low')   t.low++;
      else if (st.kind === 'in')    t.inStock++;
      else if (st.kind === 'unmetered')  t.unmetered++;
      else                           t.unreadable++;
      if (_num(p && p.price) !== null) t.priced++;
    });
    return t;
  }

  function _filtered() {
    var q = _state.q.trim().toLowerCase();
    return _state.products.filter(function (p) {
      if (_state.status && _statusOf(p) !== _state.status) return false;
      if (_state.stock) {
        var k = _stockState(p).kind;
        if (_state.stock === 'unmetered' && k !== 'unmetered') return false;
        if (_state.stock === 'out' && k !== 'out') return false;
        if (_state.stock === 'low' && k !== 'low') return false;
      }
      if (!q) return true;
      return [p.name, p.id, p.sku, p.category, p.sellerName, p.sellerUid, p.sellerId]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    }).sort(function (a, b) {
      if (_state.sort === 'name') return String(a.name || '').localeCompare(String(b.name || ''));
      if (_state.sort === 'price') return (_num(b.price) || 0) - (_num(a.price) || 0);
      return _ms(b.updatedAt || b.createdAt) - _ms(a.updatedAt || a.createdAt);
    });
  }

  /* ── Rendering ───────────────────────────────────────────────────────── */

  function _stockCell(p) {
    var st = _stockState(p);
    if (st.kind === 'unmetered') {
      return '<div class="ap-stock"><span class="ap-em" title="This product has no stock field. ' +
             'It has never been metered — that is not the same as zero.">' + EM + '</span>' +
             '<span class="ap-stock-l">not metered</span></div>';
    }
    if (st.kind === 'unreadable') {
      return '<div class="ap-stock"><span class="ap-em">' + EM + '</span>' +
             '<span class="ap-stock-l bad">unreadable</span></div>';
    }
    var pct = st.kind === 'out' ? 0 : Math.max(4, Math.min(100, (st.n / 200) * 100));
    return '<div class="ap-stock"><span class="ap-n ' + st.kind + '">' + st.n + '</span>' +
           '<span class="ap-bar"><i class="' + st.kind + '" style="width:' + pct.toFixed(0) + '%"></i></span></div>';
  }

  function _statusChip(p) {
    var s = _statusOf(p);
    var cls = KNOWN_STATUS[s.toLowerCase()] || 'unknown';
    return '<span class="ap-chip ' + cls + '">' + _esc(s) + '</span>';
  }

  function _rows(rows) {
    if (!rows.length) {
      return '<div class="ap-empty">No product on the loaded page matches these filters.</div>';
    }
    return '<div class="ap-scroll"><table class="ap-table">' +
      '<thead><tr><th>Product</th><th>Seller</th><th>Category</th>' +
      '<th>Inventory</th><th>Price</th><th>Status</th><th>Updated</th></tr></thead><tbody>' +
      rows.map(function (p, i) {
        return '<tr tabindex="0" aria-selected="' + (_state.selected === p.id) + '" ' +
          'onclick="SokoniAOSProducts.select(\'' + _esc(p.id) + '\')" ' +
          'onkeydown="if(event.key===\'Enter\'){SokoniAOSProducts.select(\'' + _esc(p.id) + '\')}">' +
          '<td><div class="ap-name">' + _esc(p.name || '(untitled)') + '</div>' +
          '<div class="ap-sub ap-mono">' + _esc(p.sku || p.id || EM) + '</div></td>' +
          '<td class="ap-sub">' + _esc(p.sellerName || p.sellerUid || p.sellerId || EM) + '</td>' +
          '<td class="ap-sub">' + _esc(p.category || EM) + '</td>' +
          '<td>' + _stockCell(p) + '</td>' +
          '<td>' + _kes(p.price) + '</td>' +
          '<td>' + _statusChip(p) + '</td>' +
          '<td class="ap-sub">' + _esc(_ago(_ms(p.updatedAt || p.createdAt))) + '</td>' +
          '</tr>';
      }).join('') + '</tbody></table></div>';
  }

  function _detail() {
    if (!_state.selected) return '';
    var p = null;
    _state.products.forEach(function (x) { if (x.id === _state.selected) p = x; });
    if (!p) return '';
    var st = _stockState(p);

    var stockLine =
      st.kind === 'unmetered' ? EM + '  <span class="ap-sub">never metered — not zero</span>' :
      st.kind === 'unreadable' ? EM + '  <span class="ap-sub">stock field unreadable</span>' :
      st.kind === 'out' ? '0  <span class="ap-sub">out of stock (a real zero)</span>' :
      String(st.n);

    function kv(k, v) {
      return '<div class="ap-kv"><span>' + _esc(k) + '</span><strong>' + v + '</strong></div>';
    }

    return '<aside class="ap-detail" aria-label="Product detail">' +
      '<div class="ap-detail-h"><div><h4>' + _esc(p.name || '(untitled)') + '</h4>' +
      '<div class="ap-sub ap-mono">' + _esc(p.id) + '</div></div>' +
      '<button class="ap-x" aria-label="Close" onclick="SokoniAOSProducts.select(null)">✕</button></div>' +

      kv('Status', _statusChip(p)) +
      kv('Inventory', stockLine) +
      kv('Price', _kes(p.price)) +
      kv('Category', _esc(p.category || EM)) +
      kv('Seller', '<span class="ap-mono">' + _esc(p.sellerUid || p.sellerId || EM) + '</span>') +
      kv('SKU', '<span class="ap-mono">' + _esc(p.sku || EM) + '</span>') +
      kv('Created', _esc(_ago(_ms(p.createdAt)))) +
      kv('Updated', _esc(_ago(_ms(p.updatedAt)))) +
      (_num(p.inventoryVersion) !== null
        ? kv('Inventory version', String(p.inventoryVersion)) : '') +

      '<div class="ap-sect">Status action</div>' +
      (_state.actions && typeof _state.actions.updateStatus === 'function'
        ? '<button class="ap-btn" onclick="SokoniAOSProducts.act(\'' + _esc(p.id) + '\')">' +
          'Change status…</button>' +
          '<p class="ap-note">Delegated to the action AdminOS already owns, which writes an ' +
          'audit record. No price, stock or delete control is offered here: stock belongs to ' +
          'inventory authority, and a product is tombstoned, never deleted.</p>'
        : '<p class="ap-note">No status action was supplied to this workspace.</p>') +

      '<div class="ap-sect">Not shown</div>' +
      '<p class="ap-note">Margin, compare-at price, variants, reserved stock, vendor records ' +
      'and per-channel publishing state have no source in this platform. They are omitted ' +
      'rather than rendered blank.</p>' +
      '</aside>';
  }

  function _render() {
    if (!_state || !_state.host) return;
    var rows = _filtered();
    var t = _tally(_state.products);
    var statuses = Object.keys(t.byStatus).sort();

    function stat(cls, label, value, sub) {
      return '<div class="ap-stat ' + cls + '"><div class="l">' + _esc(label) + '</div>' +
             '<div class="v">' + value + '</div><div class="s">' + _esc(sub) + '</div></div>';
    }

    _state.host.innerHTML = '<div class="ap">' +
      '<div class="ap-stats">' +
      stat('', 'Loaded', String(t.total), 'products on this page') +
      stat('ok', 'In stock', String(t.inStock), 'above ' + LOW_AT) +
      stat('warn', 'Low', String(t.low), '1–' + LOW_AT) +
      stat('bad', 'Out of stock', String(t.out), 'stock is a real 0') +
      stat('', 'Not metered', String(t.unmetered), 'no stock field — not zero') +
      '</div>' +

      '<div class="ap-bar-row">' +
      '<input class="ap-in" type="search" placeholder="Search name, SKU, seller, category…" ' +
      'aria-label="Search loaded products" value="' + _esc(_state.q) + '" ' +
      'oninput="SokoniAOSProducts.filter({q:this.value})">' +
      '<select class="ap-in" aria-label="Filter by status" onchange="SokoniAOSProducts.filter({status:this.value})">' +
      '<option value="">All statuses</option>' + statuses.map(function (s) {
        return '<option value="' + _esc(s) + '"' + (_state.status === s ? ' selected' : '') + '>' +
               _esc(s) + ' (' + t.byStatus[s] + ')</option>';
      }).join('') + '</select>' +
      '<select class="ap-in" aria-label="Filter by inventory" onchange="SokoniAOSProducts.filter({stock:this.value})">' +
      '<option value="">All inventory</option>' +
      '<option value="out"' + (_state.stock === 'out' ? ' selected' : '') + '>Out of stock (' + t.out + ')</option>' +
      '<option value="low"' + (_state.stock === 'low' ? ' selected' : '') + '>Low (' + t.low + ')</option>' +
      '<option value="unmetered"' + (_state.stock === 'unmetered' ? ' selected' : '') + '>Not metered (' + t.unmetered + ')</option>' +
      '</select>' +
      '<select class="ap-in" aria-label="Sort" onchange="SokoniAOSProducts.filter({sort:this.value})">' +
      '<option value="updated"' + (_state.sort === 'updated' ? ' selected' : '') + '>Last updated</option>' +
      '<option value="name"' + (_state.sort === 'name' ? ' selected' : '') + '>Name</option>' +
      '<option value="price"' + (_state.sort === 'price' ? ' selected' : '') + '>Price</option>' +
      '</select>' +
      '<span class="ap-count">' + rows.length + ' of ' + t.total + '</span>' +
      '</div>' +

      '<div class="ap-layout' + (_state.selected ? ' has-detail' : '') + '">' +
      '<div>' + _rows(rows) + '</div>' + _detail() + '</div>' +

      '<p class="ap-foot">Every figure counts the <strong>loaded page</strong>, not the ' +
      'catalogue. <span class="ap-mono">adminGetProducts</span> is capped server-side, so none ' +
      'of these is a platform total. A product with no <span class="ap-mono">stock</span> field ' +
      'is <strong>not metered</strong> — it is counted separately and never as zero.</p>' +
      '</div>';
  }

  /* ── Styles ──────────────────────────────────────────────────────────── */
  function _styles() {
    if (document.getElementById('apStyles')) return;
    var el = document.createElement('style');
    el.id = 'apStyles';
    el.textContent = [
      '.ap{--ap-s:var(--aos-surface,rgba(255,255,255,.03));--ap-s2:var(--aos-surface2,rgba(255,255,255,.06));',
      '--ap-b:var(--aos-border,rgba(255,255,255,.08));--ap-a:var(--aos-accent,#71ff00);',
      '--ap-t:var(--aos-text,rgba(255,255,255,.9));--ap-m:var(--aos-muted,rgba(255,255,255,.4));',
      '--ap-ok:var(--aos-success,#4caf50);--ap-wa:var(--aos-warn,#ff9800);--ap-ba:var(--aos-danger,#f44336);',
      '--ap-r:var(--aos-radius,10px);display:block;color:var(--ap-t);font-size:13px}',
      '.ap-stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px}',
      '.ap-stat{background:var(--ap-s);border:1px solid var(--ap-b);border-radius:var(--ap-r);padding:11px}',
      '.ap-stat .l{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ap-m)}',
      '.ap-stat .v{font-size:20px;font-weight:800;margin:3px 0 2px;line-height:1}',
      '.ap-stat .s{font-size:10px;color:var(--ap-m)}',
      '.ap-stat.ok .v{color:var(--ap-ok)}.ap-stat.warn .v{color:var(--ap-wa)}.ap-stat.bad .v{color:var(--ap-ba)}',
      '.ap-bar-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}',
      '.ap-in{background:var(--ap-s2);border:1px solid var(--ap-b);border-radius:8px;color:var(--ap-t);',
      'padding:7px 10px;font-size:12.5px;font-family:inherit;outline:none}',
      '.ap-in[type="search"]{flex:1 1 210px;min-width:180px;max-width:340px}',
      '.ap-in:focus{border-color:var(--ap-a)}',
      '.ap-count{margin-left:auto;font-size:11px;color:var(--ap-m)}',
      '.ap-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:12px}',
      '.ap-layout.has-detail{grid-template-columns:minmax(0,1fr) 300px}',
      '@media(max-width:1100px){.ap-layout.has-detail{grid-template-columns:minmax(0,1fr)}}',
      '.ap-scroll{overflow-x:auto}',
      '.ap-table{width:100%;border-collapse:collapse;font-size:12.5px;min-width:720px}',
      '.ap-table th{text-align:left;font-size:9.5px;letter-spacing:.05em;text-transform:uppercase;',
      'color:var(--ap-m);padding:8px 10px;border-bottom:1px solid var(--ap-b);white-space:nowrap}',
      '.ap-table td{padding:9px 10px;border-bottom:1px solid var(--ap-b);vertical-align:top}',
      '.ap-table tbody tr{cursor:pointer}',
      '.ap-table tbody tr:hover{background:rgba(255,255,255,.04)}',
      '.ap-table tbody tr[aria-selected="true"]{background:rgba(255,255,255,.07)}',
      '.ap-name{font-weight:600}',
      '.ap-sub{font-size:11px;color:var(--ap-m)}',
      '.ap-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}',
      '.ap-stock{display:flex;align-items:center;gap:7px;min-width:96px}',
      '.ap-n{font-weight:700;min-width:26px}',
      '.ap-n.out{color:var(--ap-ba)}.ap-n.low{color:var(--ap-wa)}.ap-n.in{color:var(--ap-ok)}',
      '.ap-em{color:var(--ap-m);font-weight:700;min-width:26px;display:inline-block}',
      '.ap-stock-l{font-size:10px;color:var(--ap-m)}.ap-stock-l.bad{color:var(--ap-ba)}',
      '.ap-bar{flex:1;height:4px;background:var(--ap-b);border-radius:99px;overflow:hidden;max-width:70px}',
      '.ap-bar i{display:block;height:100%;border-radius:99px;background:var(--ap-ok)}',
      '.ap-bar i.low{background:var(--ap-wa)}.ap-bar i.out{background:var(--ap-ba)}',
      '.ap-chip{font-size:10px;font-weight:700;border-radius:5px;padding:2px 7px;border:1px solid var(--ap-b);white-space:nowrap}',
      '.ap-chip.ok{color:var(--ap-ok);border-color:rgba(76,175,80,.4)}',
      '.ap-chip.warn{color:var(--ap-wa);border-color:rgba(255,152,0,.4)}',
      '.ap-chip.bad{color:var(--ap-ba);border-color:rgba(244,67,54,.4)}',
      '.ap-chip.muted,.ap-chip.unknown{color:var(--ap-m)}',
      '.ap-detail{background:var(--ap-s);border:1px solid var(--ap-b);border-radius:var(--ap-r);',
      'padding:14px;position:sticky;top:76px;max-height:calc(100vh - 110px);overflow-y:auto}',
      '@media(max-width:1100px){.ap-detail{position:static;max-height:none}}',
      '.ap-detail-h{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}',
      '.ap-detail-h h4{font-size:13.5px;margin:0;font-weight:700}',
      '.ap-x{margin-left:auto;background:none;border:none;color:var(--ap-m);cursor:pointer;font-size:14px}',
      '.ap-x:hover{color:var(--ap-ba)}',
      '.ap-kv{display:flex;justify-content:space-between;gap:12px;padding:6px 0;',
      'border-bottom:1px solid var(--ap-b);font-size:12px}',
      '.ap-kv>span{color:var(--ap-m);flex-shrink:0}',
      '.ap-kv>strong{text-align:right;word-break:break-word;font-weight:600}',
      '.ap-sect{font-size:9.5px;text-transform:uppercase;letter-spacing:.06em;color:var(--ap-m);',
      'font-weight:700;margin:14px 0 7px;padding-top:10px;border-top:1px solid var(--ap-b)}',
      '.ap-btn{background:var(--ap-s2);border:1px solid var(--ap-b);border-radius:7px;color:var(--ap-t);',
      'padding:7px 12px;font-size:12px;cursor:pointer;font-family:inherit}',
      '.ap-btn:hover{border-color:var(--ap-a);color:var(--ap-a)}',
      '.ap-note{font-size:10.5px;color:var(--ap-m);line-height:1.55;margin:7px 0 0}',
      '.ap-empty{padding:26px 12px;text-align:center;color:var(--ap-m);font-size:12.5px}',
      '.ap-foot{font-size:10.5px;color:var(--ap-m);margin-top:12px;line-height:1.6}',
    ].join('');
    document.head.appendChild(el);
  }

  /* ── Public contract ─────────────────────────────────────────────────── */
  window.SokoniAOSProducts = {
    version: '1.0.0',

    /** Returns truthy when it rendered; falsy hands back to the legacy table. */
    mount: function (opts) {
      opts = opts || {};
      var host = opts.host;
      var products = opts.products;
      if (!host || !Array.isArray(products)) return false;

      _styles();
      _state = {
        host: host,
        products: products,
        actions: opts.actions || null,
        q: '', status: '', stock: '', sort: 'updated',
        selected: null,
      };
      _render();
      return true;
    },

    filter: function (patch) {
      if (!_state) return;
      Object.keys(patch || {}).forEach(function (k) { _state[k] = patch[k]; });
      _state.selected = null;
      _render();
    },

    select: function (id) {
      if (!_state) return;
      _state.selected = (id && _state.selected !== id) ? id : null;
      _render();
    },

    /* The single write, handed straight back to AdminOS. This workspace never
       calls a callable itself, so it cannot become a second write authority. */
    act: function (id) {
      if (_state && _state.actions && typeof _state.actions.updateStatus === 'function') {
        _state.actions.updateStatus(id);
      }
    },

    /* Exposed for certification. */
    _stockState: _stockState,
    _tally: _tally,
  };
})();
