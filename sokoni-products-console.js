/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   SOKONI Products Console — ONE products page for AdminOS and Super Admin (owner 2026-10-04)
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   Mount:  SokoniProductsConsole.mount(rootEl, { call, toast, confirm })
     call(op, data) → Promise<result>   the page's own server caller (AdminOS _call / Super Admin adminOsDispatch)
     toast(msg, kind)                   optional
     confirm(text, title) → Promise<bool> optional (defaults to window.confirm)

   DATA INTEGRITY (CLAUDE.md "UI Data Integrity"): every figure comes from the server's product records
   (adminGetProducts) or is arithmetic on two real fields of the same record (discount = price vs compare-at;
   margin = price vs cost). Nothing is invented:
     · tab COUNTS are shown only when the server returns them (`counts`); otherwise "—". The live op returns a page,
       not a catalogue total, so a count of the loaded page is never presented as the catalogue;
     · "Low stock" only when the product carries its OWN threshold (lowStockThreshold / reorderLevel); "Out of stock"
       only for a real stock of 0; an unknown stock is "—", never 0;
     · channels / variants / margin / reserved stock render only from fields the record actually has.
   ACTIONS go to server authorities only (adminUpdateProductStatus — admin-gated, audited). Success is shown only
   after the server answers; a refusal shows the server's reason. There are no controls without a server behind
   them (no Duplicate / Discount / Import buttons that do nothing).
   Every value is escaped before it reaches the DOM.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SokoniProductsConsole) return;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const money = (v) => { const n = num(v); return n === null ? '—' : 'KES ' + n.toLocaleString('en-KE', { maximumFractionDigits: 2 }); };
  const ms = (v) => { if (!v) return null; if (typeof v === 'number') return v; if (typeof v === 'string') { const t = Date.parse(v); return Number.isFinite(t) ? t : null; } if (v._seconds) return v._seconds * 1000; if (v.seconds) return v.seconds * 1000; if (typeof v.toMillis === 'function') return v.toMillis(); return null; };
  const ago = (v) => { const t = ms(v); if (!t) return '—'; const s = Math.max(0, (Date.now() - t) / 1000);
    if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago'; if (s < 86400) return Math.floor(s / 3600) + 'h ago'; if (s < 2592000) return Math.floor(s / 86400) + 'd ago';
    return new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const dateOf = (v) => { const t = ms(v); return t ? new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };

  /* ── field readers (defensive, alias-aware; absent → null) ─────────────────────────────────────────── */
  const F = {
    name: (p) => p.name || p.title || '—',
    image: (p) => { const u = (Array.isArray(p.images) && p.images[0]) || p.imageUrl || p.image || p.thumbnail || null; return typeof u === 'string' && /^https:\/\//.test(u) ? u : null; },
    sku: (p) => p.sku || p.barcode || null,
    category: (p) => p.categoryLabel || p.category || null,
    seller: (p) => p.sellerName || p.shopName || p.storeName || null,
    sellerId: (p) => p.sellerUid || p.sellerId || p.shopId || null,
    stock: (p) => num(p.stock != null ? p.stock : (p.inventory != null && typeof p.inventory !== 'object' ? p.inventory : p.quantity)),
    reserved: (p) => num(p.reserved != null ? p.reserved : p.reservedStock),
    threshold: (p) => num(p.lowStockThreshold != null ? p.lowStockThreshold : p.reorderLevel),
    price: (p) => num(p.price),
    compareAt: (p) => num(p.compareAtPrice != null ? p.compareAtPrice : p.originalPrice),
    cost: (p) => num(p.costPrice != null ? p.costPrice : p.cost),
    variants: (p) => (Array.isArray(p.variants) ? p.variants : null),
    tags: (p) => (Array.isArray(p.tags) ? p.tags.filter((x) => typeof x === 'string').slice(0, 6) : []),
    status: (p) => String(p.status || '').toLowerCase() || null,
    updated: (p) => p.updatedAt || p.createdAt || null,
  };
  function stockState(p) {
    const s = F.stock(p); if (s === null) return null;
    if (s <= 0) return 'out';
    const th = F.threshold(p);
    return th !== null && s <= th ? 'low' : 'ok';
  }
  function discountPct(p) {
    const pr = F.price(p), ca = F.compareAt(p);
    return pr !== null && ca !== null && ca > pr && ca > 0 ? Math.round((1 - pr / ca) * 100) : null;
  }
  function marginPct(p) {
    const pr = F.price(p), co = F.cost(p);
    return pr !== null && co !== null && pr > 0 ? Math.round(((pr - co) / pr) * 100) : null;
  }
  const STATUS_LABEL = { active: 'Active', pending: 'Pending review', draft: 'Draft', archived: 'Archived', removed: 'Removed', suspended: 'Suspended', rejected: 'Rejected' };

  /* ── styles (scoped under .spc) ───────────────────────────────────────────────────────────────────── */
  const CSS = `
  .spc{--spc-bg:transparent;--spc-card:rgba(255,255,255,.03);--spc-card2:rgba(255,255,255,.05);--spc-line:rgba(255,255,255,.08);
       --spc-text:#e8eaf6;--spc-muted:#8a8fa8;--spc-accent:#6d5dfc;--spc-accent-soft:rgba(109,93,252,.16);
       --spc-ok:#34d399;--spc-warn:#f59e0b;--spc-bad:#f87171;color:var(--spc-text);font:14px/1.45 inherit;position:relative}
  .spc *{box-sizing:border-box}
  .spc-head{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:16px}
  .spc-title{font-size:24px;font-weight:700;margin:0;display:flex;align-items:center;gap:8px}
  .spc-sub{color:var(--spc-muted);margin:4px 0 0;font-size:13px}
  .spc-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 14px;border-radius:10px;border:1px solid var(--spc-line);background:var(--spc-card);color:var(--spc-text);cursor:pointer;font:inherit;font-size:13px}
  .spc-btn:hover{border-color:rgba(255,255,255,.18)} .spc-btn:disabled{opacity:.5;cursor:not-allowed}
  .spc-btn.primary{background:var(--spc-accent);border-color:var(--spc-accent);color:#fff}
  .spc-btn.danger{color:var(--spc-bad);border-color:rgba(248,113,113,.35)}
  .spc-tabs{display:flex;gap:6px;overflow-x:auto;padding-bottom:4px;margin-bottom:14px;scrollbar-width:thin}
  .spc-tab{flex:0 0 auto;display:inline-flex;align-items:center;gap:8px;padding:9px 14px;border-radius:10px;border:1px solid transparent;background:none;color:var(--spc-muted);cursor:pointer;font:inherit;font-size:13px}
  .spc-tab[aria-selected="true"]{color:var(--spc-text);background:var(--spc-card2);border-color:var(--spc-accent)}
  .spc-count{font-size:11px;padding:1px 7px;border-radius:999px;background:var(--spc-card2);color:var(--spc-muted)}
  .spc-tab[aria-selected="true"] .spc-count{background:var(--spc-accent-soft);color:#c7c0ff}
  .spc-count.warn{color:var(--spc-warn)} .spc-count.bad{color:var(--spc-bad)}
  .spc-bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px}
  .spc-input,.spc-select{background:var(--spc-card);border:1px solid var(--spc-line);color:var(--spc-text);border-radius:10px;padding:8px 12px;font:inherit;font-size:13px;min-height:36px}
  .spc-input{flex:1 1 220px;min-width:0} .spc-select{flex:0 1 auto}
  .spc-input:focus,.spc-select:focus,.spc-btn:focus-visible,.spc-tab:focus-visible{outline:2px solid var(--spc-accent);outline-offset:1px}
  .spc-grow{flex:1 1 auto}
  .spc-view{display:inline-flex;border:1px solid var(--spc-line);border-radius:10px;overflow:hidden}
  .spc-view button{background:none;border:0;color:var(--spc-muted);padding:7px 10px;cursor:pointer}
  .spc-view button[aria-pressed="true"]{background:var(--spc-card2);color:var(--spc-text)}
  .spc-layout{display:grid;grid-template-columns:minmax(0,1fr);gap:16px;align-items:start}
  .spc-layout.has-drawer{grid-template-columns:minmax(0,1fr) 360px}
  .spc-card{background:var(--spc-card);border:1px solid var(--spc-line);border-radius:14px;min-width:0}
  .spc-tablewrap{overflow-x:auto}
  .spc-table{width:100%;border-collapse:collapse;min-width:820px}
  .spc-table th{font-size:12px;font-weight:500;color:var(--spc-muted);text-align:left;padding:12px 14px;border-bottom:1px solid var(--spc-line);white-space:nowrap}
  .spc-table td{padding:10px 14px;border-bottom:1px solid var(--spc-line);vertical-align:middle;font-size:13px}
  .spc-table tr:last-child td{border-bottom:0}
  .spc-row{cursor:pointer} .spc-row:hover td{background:rgba(255,255,255,.02)} .spc-row[aria-selected="true"] td{background:var(--spc-accent-soft)}
  .spc-prod{display:flex;align-items:center;gap:12px;min-width:220px}
  .spc-thumb{width:42px;height:42px;border-radius:10px;background:var(--spc-card2);flex:0 0 42px;object-fit:cover;display:flex;align-items:center;justify-content:center;color:var(--spc-muted);font-size:18px;overflow:hidden}
  .spc-pname{font-weight:600;line-height:1.25} .spc-meta{color:var(--spc-muted);font-size:12px}
  .spc-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--spc-muted)}
  .spc-stock{display:flex;align-items:center;gap:8px;min-width:90px}
  .spc-meter{width:46px;height:4px;border-radius:4px;background:var(--spc-card2);overflow:hidden}
  .spc-meter i{display:block;height:100%;border-radius:4px}
  .spc-pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:6px;white-space:nowrap}
  .spc-pill.ok{background:rgba(52,211,153,.12);color:var(--spc-ok)} .spc-pill.warn{background:rgba(245,158,11,.12);color:var(--spc-warn)}
  .spc-pill.bad{background:rgba(248,113,113,.12);color:var(--spc-bad)} .spc-pill.muted{background:var(--spc-card2);color:var(--spc-muted)}
  .spc-pill.accent{background:var(--spc-accent-soft);color:#c7c0ff}
  .spc-foot{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:12px 14px;color:var(--spc-muted);font-size:12px;border-top:1px solid var(--spc-line)}
  .spc-empty{padding:40px 16px;text-align:center;color:var(--spc-muted)}
  .spc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;padding:12px}
  .spc-tile{background:var(--spc-card2);border:1px solid var(--spc-line);border-radius:12px;padding:12px;cursor:pointer;text-align:left;color:inherit;font:inherit}
  .spc-tile[aria-selected="true"]{border-color:var(--spc-accent)}
  .spc-tile .spc-thumb{width:100%;height:120px;flex:none;margin-bottom:10px}
  .spc-drawer{position:sticky;top:12px;padding:16px;max-height:calc(100vh - 24px);overflow:auto}
  .spc-dh{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px}
  .spc-dh .spc-thumb{width:64px;height:64px;flex:0 0 64px}
  .spc-dtitle{font-size:17px;font-weight:700;margin:0;flex:1;min-width:0;word-break:break-word}
  .spc-x{background:none;border:0;color:var(--spc-muted);font-size:20px;cursor:pointer;line-height:1;padding:2px 6px}
  .spc-kv{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:12px 0}
  .spc-box{background:var(--spc-card2);border:1px solid var(--spc-line);border-radius:12px;padding:12px;min-width:0}
  .spc-box small{display:block;color:var(--spc-muted);font-size:11px;margin-bottom:4px}
  .spc-big{font-size:20px;font-weight:700}
  .spc-sec{font-size:13px;font-weight:600;margin:16px 0 8px}
  .spc-chips{display:flex;flex-wrap:wrap;gap:6px}
  .spc-sw{width:30px;height:30px;border-radius:8px;border:1px solid var(--spc-line);background:var(--spc-card2);overflow:hidden;display:inline-flex;align-items:center;justify-content:center;font-size:11px;color:var(--spc-muted)}
  .spc-sw img{width:100%;height:100%;object-fit:cover}
  .spc-list{display:flex;flex-direction:column;gap:8px}
  .spc-li{display:flex;justify-content:space-between;gap:8px;font-size:13px}
  .spc-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .spc-note{color:var(--spc-muted);font-size:11px;margin-top:14px;line-height:1.5}
  .spc-err{background:rgba(248,113,113,.08);border:1px solid rgba(248,113,113,.3);color:#fecaca;border-radius:12px;padding:12px 14px;margin-bottom:12px;font-size:13px}
  .spc-chk{width:16px;height:16px;accent-color:var(--spc-accent)}
  .spc-bulk{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--spc-line);background:var(--spc-accent-soft);font-size:13px}
  @media (max-width:1100px){.spc-layout.has-drawer{grid-template-columns:minmax(0,1fr)}
    .spc-drawer{position:fixed;inset:auto 0 0 0;top:auto;max-height:82vh;border-radius:18px 18px 0 0;z-index:1200;box-shadow:0 -12px 40px rgba(0,0,0,.5);background:#14161f}}
  @media (max-width:640px){.spc-title{font-size:20px}.spc-kv{grid-template-columns:1fr}.spc-actions{grid-template-columns:1fr}}
  `;
  function injectCss() {
    if (document.getElementById('spc-css')) return;
    const s = document.createElement('style'); s.id = 'spc-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  const TABS = [
    { key: 'all', label: 'All Products', status: 'all' },
    { key: 'active', label: 'Active', status: 'active' },
    { key: 'pending', label: 'Pending review', status: 'pending' },
    { key: 'draft', label: 'Draft', status: 'draft' },
    { key: 'archived', label: 'Archived', status: 'archived' },
    { key: 'low', label: 'Low Stock', status: 'all', stock: 'low', tone: 'warn' },
    { key: 'out', label: 'Out of Stock', status: 'all', stock: 'out', tone: 'bad' },
  ];
  const PAGE = 50, MAX = 200;

  function mount(root, opts) {
    if (!root) return null;
    injectCss();
    const o = opts || {};
    const call = o.call;
    const toast = o.toast || (() => {});
    const confirmFn = o.confirm || (async (text) => window.confirm(text));
    const st = { tab: 'all', q: '', cat: '', sort: 'updated', view: 'list', limit: PAGE, rows: [], counts: null, loading: false, error: null, sel: null, picked: new Set(), busy: false };
    root.classList.add('spc');

    async function load() {
      if (typeof call !== 'function') { st.error = 'This page has no server connection.'; render(); return; }
      st.loading = true; st.error = null; render();
      const tab = TABS.find((t) => t.key === st.tab);
      try {
        const r = await call('adminGetProducts', { status: tab.status, query: st.q || undefined, limit: st.limit });
        st.rows = Array.isArray(r && r.products) ? r.products : [];
        st.counts = r && r.counts && typeof r.counts === 'object' ? r.counts : null;   /* only a SERVER count is ever shown */
      } catch (e) {
        st.rows = []; st.error = (e && e.message) ? String(e.message) : 'The products could not be loaded.';
      }
      st.loading = false;
      if (st.sel && !st.rows.some((p) => p.id === st.sel)) st.sel = null;
      render();
    }

    function visible() {
      const tab = TABS.find((t) => t.key === st.tab);
      let rows = st.rows.slice();
      if (tab.stock) rows = rows.filter((p) => stockState(p) === tab.stock);
      if (st.cat) rows = rows.filter((p) => (F.category(p) || '') === st.cat);
      const by = { updated: (p) => -(ms(F.updated(p)) || 0), price: (p) => -(F.price(p) ?? -Infinity), stock: (p) => F.stock(p) ?? Infinity, name: (p) => F.name(p).toLowerCase() };
      const k = by[st.sort] || by.updated;
      rows.sort((a, b) => { const x = k(a), y = k(b); return x < y ? -1 : x > y ? 1 : 0; });
      return rows;
    }

    function countFor(t) {
      const v = st.counts && Number.isFinite(Number(st.counts[t.key])) ? Number(st.counts[t.key]) : null;
      return v === null ? '—' : v.toLocaleString('en-KE');
    }

    function statusPill(p) {
      const s = F.status(p); const ss = stockState(p);
      if (s === 'active' && ss === 'out') return '<span class="spc-pill bad">Out of stock</span>';
      if (s === 'active' && ss === 'low') return '<span class="spc-pill warn">Low stock</span>';
      if (!s) return '<span class="spc-pill muted">—</span>';
      const tone = s === 'active' ? 'ok' : (s === 'removed' || s === 'rejected' || s === 'suspended') ? 'bad' : (s === 'pending' ? 'warn' : 'muted');
      return '<span class="spc-pill ' + tone + '">' + esc(STATUS_LABEL[s] || s) + '</span>';
    }
    function stockCell(p) {
      const s = F.stock(p); if (s === null) return '<span class="spc-meta">—</span>';
      const ss = stockState(p);
      const color = ss === 'out' ? 'var(--spc-bad)' : ss === 'low' ? 'var(--spc-warn)' : 'var(--spc-ok)';
      /* no level bar: a bar needs a scale, and inventing one (a multiple of the threshold) would be a fabricated figure */
      const bar = '';
      return '<span class="spc-stock"><span style="color:' + color + ';font-weight:600">' + esc(s.toLocaleString('en-KE')) + '</span>' + bar + '</span>';
    }
    function priceCell(p) {
      const d = discountPct(p);
      return '<span style="font-weight:600">' + esc(money(F.price(p))) + '</span>' + (d !== null ? ' <span class="spc-pill accent">' + d + '% OFF</span>' : '');
    }
    function thumb(p) {
      const u = F.image(p);
      return u ? '<img class="spc-thumb" src="' + esc(u) + '" alt="" loading="lazy" referrerpolicy="no-referrer">' : '<span class="spc-thumb" aria-hidden="true">📦</span>';
    }

    function render() {
      const tab = TABS.find((t) => t.key === st.tab);
      const rows = visible();
      const cats = [...new Set(st.rows.map((p) => F.category(p)).filter(Boolean))].sort();
      const sel = st.sel ? st.rows.find((p) => p.id === st.sel) : null;
      const pickedRows = rows.filter((p) => st.picked.has(p.id));
      root.innerHTML =
        '<div class="spc-head"><div><h2 class="spc-title">Products</h2>' +
          '<p class="spc-sub">The marketplace catalogue — every product record, its stock and its listing status.</p></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap">' +
            '<button class="spc-btn" data-act="export"' + (rows.length ? '' : ' disabled') + ' title="Download the products shown below as CSV">⤓ Export</button>' +
            '<button class="spc-btn" data-act="refresh">↻ Refresh</button></div></div>' +
        '<div class="spc-tabs" role="tablist" aria-label="Product status">' + TABS.map((t) =>
          '<button class="spc-tab" role="tab" data-tab="' + t.key + '" aria-selected="' + (t.key === st.tab) + '">' + esc(t.label) +
          ' <span class="spc-count' + (t.tone ? ' ' + t.tone : '') + '" title="' + (st.counts ? 'From the server' : 'The server does not report catalogue totals') + '">' + countFor(t) + '</span></button>').join('') + '</div>' +
        '<div class="spc-bar">' +
          '<input class="spc-input" type="search" data-in="q" placeholder="Search products by name or seller id…" value="' + esc(st.q) + '" aria-label="Search products">' +
          '<select class="spc-select" data-in="cat" aria-label="Category"><option value="">All categories</option>' + cats.map((c) => '<option' + (c === st.cat ? ' selected' : '') + ' value="' + esc(c) + '">' + esc(c) + '</option>').join('') + '</select>' +
          '<select class="spc-select" data-in="sort" aria-label="Sort">' + [['updated', 'Sort: Last updated'], ['name', 'Sort: Name'], ['price', 'Sort: Price'], ['stock', 'Sort: Lowest stock']].map(([v, l]) => '<option value="' + v + '"' + (v === st.sort ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
          '<span class="spc-grow"></span>' +
          '<span class="spc-view" role="group" aria-label="View"><button data-view="list" aria-pressed="' + (st.view === 'list') + '" title="List">☰</button><button data-view="grid" aria-pressed="' + (st.view === 'grid') + '" title="Grid">▦</button></span>' +
        '</div>' +
        (st.error ? '<div class="spc-err" role="alert">Could not load products — ' + esc(st.error) + '</div>' : '') +
        '<div class="spc-layout' + (sel ? ' has-drawer' : '') + '">' +
          '<div class="spc-card">' +
            (pickedRows.length ? '<div class="spc-bulk" role="region" aria-label="Bulk actions"><strong>' + pickedRows.length + ' selected</strong>' +
              '<button class="spc-btn" data-act="bulk" data-status="active"' + (st.busy ? ' disabled' : '') + '>Approve</button>' +
              '<button class="spc-btn danger" data-act="bulk" data-status="removed"' + (st.busy ? ' disabled' : '') + '>Remove</button>' +
              '<button class="spc-btn" data-act="clearpick">Clear</button></div>' : '') +
            (st.loading ? '<div class="spc-empty">Loading products…</div>'
              : !rows.length ? '<div class="spc-empty">' + (st.error ? 'No products to show.' : tab.stock ? 'No ' + (tab.stock === 'out' ? 'out-of-stock' : 'low-stock') + ' products among those loaded.' : 'No products.') + '</div>'
              : st.view === 'grid' ? '<div class="spc-grid">' + rows.map((p) =>
                  '<button class="spc-tile" data-open="' + esc(p.id) + '" aria-selected="' + (p.id === st.sel) + '">' + thumb(p) +
                  '<div class="spc-pname">' + esc(F.name(p)) + '</div><div class="spc-meta">' + esc(F.category(p) || '—') + '</div>' +
                  '<div style="margin-top:6px;display:flex;justify-content:space-between;gap:6px;align-items:center">' + priceCell(p) + '</div>' +
                  '<div style="margin-top:6px">' + statusPill(p) + '</div></button>').join('') + '</div>'
              : '<div class="spc-tablewrap"><table class="spc-table"><thead><tr>' +
                  '<th style="width:36px"><input type="checkbox" class="spc-chk" data-act="pickall" aria-label="Select all shown"' + (rows.length && rows.every((p) => st.picked.has(p.id)) ? ' checked' : '') + '></th>' +
                  '<th>Product</th><th>SKU</th><th>Category</th><th>Inventory</th><th>Price</th><th>Status</th><th>Updated</th></tr></thead><tbody>' +
                  rows.map((p) => {
                    const v = F.variants(p);
                    return '<tr class="spc-row" data-open="' + esc(p.id) + '" aria-selected="' + (p.id === st.sel) + '" tabindex="0">' +
                      '<td><input type="checkbox" class="spc-chk" data-pick="' + esc(p.id) + '" aria-label="Select ' + esc(F.name(p)) + '"' + (st.picked.has(p.id) ? ' checked' : '') + '></td>' +
                      '<td><div class="spc-prod">' + thumb(p) + '<div><div class="spc-pname">' + esc(F.name(p)) + '</div><div class="spc-meta">' +
                        (v ? esc(v.length) + ' variant' + (v.length === 1 ? '' : 's') : esc(F.seller(p) || '')) + '</div></div></div></td>' +
                      '<td class="spc-mono">' + esc(F.sku(p) || '—') + '</td>' +
                      '<td>' + esc(F.category(p) || '—') + '</td>' +
                      '<td>' + stockCell(p) + '</td>' +
                      '<td>' + priceCell(p) + '</td>' +
                      '<td>' + statusPill(p) + '</td>' +
                      '<td class="spc-meta">' + esc(ago(F.updated(p))) + '</td></tr>';
                  }).join('') + '</tbody></table></div>') +
            '<div class="spc-foot"><span>' + (st.loading ? '' : 'Showing ' + rows.length + ' of ' + st.rows.length + ' loaded (newest first' + (tab.stock || st.cat ? ', filtered' : '') + ')') + '</span>' +
              (st.rows.length >= st.limit && st.limit < MAX ? '<button class="spc-btn" data-act="more">Load more</button>' : (st.limit >= MAX && st.rows.length >= MAX ? '<span>Showing the newest ' + MAX + ' — narrow with search or a status tab</span>' : '')) + '</div>' +
          '</div>' +
          (sel ? drawer(sel) : '') +
        '</div>';
    }

    function drawer(p) {
      const s = F.stock(p), r = F.reserved(p), ss = stockState(p), d = discountPct(p), m = marginPct(p), v = F.variants(p), tags = F.tags(p);
      const avail = s !== null && r !== null ? Math.max(0, s - r) : null;
      const health = ss === null ? ['—', 'muted', 'Stock not recorded'] : ss === 'out' ? ['Out of stock', 'bad', 'No units available'] : ss === 'low' ? ['Low stock', 'warn', 'At or below its reorder level'] : ['Healthy', 'ok', F.threshold(p) !== null ? 'Above its reorder level' : 'In stock'];
      const st0 = F.status(p);
      const sw = v ? v.slice(0, 6).map((x) => { const u = x && (x.image || x.imageUrl); const label = esc((x && (x.name || x.color || x.size || x.title)) || ''); return u && /^https:\/\//.test(u) ? '<span class="spc-sw" title="' + label + '"><img src="' + esc(u) + '" alt="' + label + '" loading="lazy"></span>' : '<span class="spc-sw" title="' + label + '">' + (label ? label.slice(0, 2) : '·') + '</span>'; }).join('') + (v.length > 6 ? '<span class="spc-sw">+' + (v.length - 6) + '</span>' : '') : '';
      const store = '/product.html?id=' + encodeURIComponent(p.id);
      return '<aside class="spc-card spc-drawer" role="dialog" aria-label="Product details: ' + esc(F.name(p)) + '">' +
        '<div class="spc-dh">' + thumb(p) + '<div style="flex:1;min-width:0"><h3 class="spc-dtitle">' + esc(F.name(p)) + '</h3>' +
          '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:6px;align-items:center">' + statusPill(p) + (p.featured === true ? '<span class="spc-pill accent">Featured</span>' : '') +
          '<span class="spc-mono">' + (F.sku(p) ? 'SKU: ' + esc(F.sku(p)) : 'No SKU') + '</span></div>' +
          '<div class="spc-meta" style="margin-top:4px">Seller: ' + esc(F.seller(p) || F.sellerId(p) || '—') + '</div></div>' +
          '<button class="spc-x" data-act="close" aria-label="Close details">×</button></div>' +
        ((F.category(p) || tags.length) ? '<div class="spc-chips">' + [F.category(p)].concat(tags).filter(Boolean).map((t) => '<span class="spc-pill muted">' + esc(t) + '</span>').join('') + '</div>' : '') +
        '<div class="spc-kv">' +
          '<div class="spc-box"><small>Price</small><div class="spc-big">' + esc(money(F.price(p))) + (d !== null ? ' <span class="spc-pill accent" style="font-size:11px">' + d + '% OFF</span>' : '') + '</div>' +
            '<div class="spc-meta">' + (F.compareAt(p) !== null ? 'Compare at ' + esc(money(F.compareAt(p))) : 'No compare-at price') + '</div></div>' +
          '<div class="spc-box"><small>Margin</small><div class="spc-big">' + (m === null ? '—' : m + '%') + '</div><div class="spc-meta">' + (m === null ? 'No cost price recorded' : 'Cost ' + esc(money(F.cost(p)))) + '</div></div>' +
          '<div class="spc-box"><small>Inventory</small><div class="spc-big">' + (s === null ? '—' : esc(s.toLocaleString('en-KE'))) + ' <span class="spc-meta">in stock</span></div>' +
            '<div class="spc-meta">' + (r !== null ? esc(r.toLocaleString('en-KE')) + ' reserved · ' + (avail === null ? '—' : esc(avail.toLocaleString('en-KE'))) + ' available' : 'Reservations not recorded') + '</div></div>' +
          '<div class="spc-box"><small>Stock health</small><div class="spc-big"><span class="spc-pill ' + health[1] + '" style="font-size:13px">' + health[0] + '</span></div><div class="spc-meta">' + health[2] + '</div></div>' +
        '</div>' +
        '<div class="spc-sec">Variants</div>' + (v ? '<div class="spc-meta" style="margin-bottom:8px">' + v.length + ' variant' + (v.length === 1 ? '' : 's') + '</div><div class="spc-chips">' + sw + '</div>' : '<div class="spc-meta">No variants on this product.</div>') +
        '<div class="spc-sec">Listing</div><div class="spc-list">' +
          '<div class="spc-li"><span>SOKONI Marketplace</span>' + (st0 === 'active' ? '<span class="spc-pill ok">Published</span>' : '<span class="spc-pill muted">Not published</span>') + '</div>' +
          (typeof p.searchable === 'boolean' ? '<div class="spc-li"><span>Search</span>' + (p.searchable ? '<span class="spc-pill ok">Indexed</span>' : '<span class="spc-pill muted">Hidden</span>') + '</div>' : '') +
        '</div>' +
        '<div class="spc-sec">Actions</div><div class="spc-actions">' +
          (st0 !== 'active' ? '<button class="spc-btn primary" data-act="status" data-status="active"' + (st.busy ? ' disabled' : '') + '>Approve listing</button>' : '') +
          (st0 !== 'removed' ? '<button class="spc-btn danger" data-act="status" data-status="removed"' + (st.busy ? ' disabled' : '') + '>Remove listing</button>' : '') +
          (st0 ? '<button class="spc-btn" data-act="feature"' + (st.busy ? ' disabled' : '') + '>' + (p.featured === true ? 'Unfeature' : 'Feature') + '</button>' : '') +
          '<a class="spc-btn" href="' + esc(store) + '" target="_blank" rel="noopener">View on store ↗</a>' +
        '</div>' +
        '<p class="spc-note">Created ' + esc(dateOf(p.createdAt)) + (F.seller(p) ? ' by ' + esc(F.seller(p)) : '') + ' · Last updated ' + esc(dateOf(p.updatedAt)) + (p.updatedBy ? ' by ' + esc(p.updatedBy) : '') + '<br>Status changes are made by the server and recorded in the admin audit log.</p>' +
      '</aside>';
    }

    async function setStatus(ids, status, extra) {
      const label = status === 'active' ? 'Approve' : status === 'removed' ? 'Remove' : 'Update';
      const ok = await confirmFn(label + ' ' + ids.length + ' product' + (ids.length === 1 ? '' : 's') + '? The change is made by the server and audited.', label + ' listing');
      if (!ok) return;
      st.busy = true; render();
      let done = 0; const failed = [];
      for (const id of ids) {
        const p = st.rows.find((x) => x.id === id) || {};
        try {
          const r = await call('adminUpdateProductStatus', Object.assign({ productId: id, status }, extra || {}));
          if (r && r.success === true) done++; else failed.push((F.name(p)) + ': the server did not confirm');
        } catch (e) { failed.push(F.name(p) + ': ' + ((e && e.message) || 'refused')); }
      }
      st.busy = false; st.picked.clear();
      if (done) toast(label + ' — ' + done + ' product' + (done === 1 ? '' : 's') + ' updated', 'success');
      if (failed.length) toast(label + ' failed for ' + failed.length + ': ' + failed.slice(0, 2).join('; '), 'error');
      await load();
    }

    function exportCsv() {
      const rows = visible();
      const head = ['id', 'name', 'sku', 'category', 'stock', 'price', 'compareAt', 'status', 'seller', 'updated'];
      const cell = (v) => { const s = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return '"' + safe.replace(/"/g, '""') + '"'; };
      const lines = [head.join(',')].concat(rows.map((p) => [p.id, F.name(p), F.sku(p), F.category(p), F.stock(p), F.price(p), F.compareAt(p), F.status(p), F.seller(p) || F.sellerId(p), ms(F.updated(p)) ? new Date(ms(F.updated(p))).toISOString() : ''].map(cell).join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sokoni-products-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    /* ── events (delegated, bound once) ─────────────────────────────────────────────────────────────── */
    let qTimer = null;
    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab],[data-view],[data-act],[data-open],[data-pick]');
      if (!t || !root.contains(t)) return;
      if (t.dataset.pick) { e.stopPropagation(); t.checked ? st.picked.add(t.dataset.pick) : st.picked.delete(t.dataset.pick); render(); return; }
      if (t.dataset.tab) { if (st.tab !== t.dataset.tab) { const prev = TABS.find((x) => x.key === st.tab); const next = TABS.find((x) => x.key === t.dataset.tab); st.tab = t.dataset.tab; st.picked.clear(); prev.status === next.status ? render() : load(); } return; }
      if (t.dataset.view) { st.view = t.dataset.view; render(); return; }
      if (t.dataset.open && !t.dataset.act) { st.sel = t.dataset.open; render(); return; }
      const a = t.dataset.act;
      if (a === 'close') { st.sel = null; render(); }
      else if (a === 'refresh') load();
      else if (a === 'more') { st.limit = Math.min(MAX, st.limit + PAGE); load(); }
      else if (a === 'export') exportCsv();
      else if (a === 'pickall') { const rows = visible(); const all = rows.every((p) => st.picked.has(p.id)); rows.forEach((p) => (all ? st.picked.delete(p.id) : st.picked.add(p.id))); render(); }
      else if (a === 'clearpick') { st.picked.clear(); render(); }
      else if (a === 'bulk') setStatus([...st.picked], t.dataset.status);
      else if (a === 'status' && st.sel) setStatus([st.sel], t.dataset.status);
      else if (a === 'feature' && st.sel) { const p = st.rows.find((x) => x.id === st.sel); if (p && F.status(p)) setStatus([p.id], F.status(p), { featured: p.featured !== true }); }   /* status unchanged — never defaulted */
    });
    root.addEventListener('keydown', (e) => {
      const r = e.target.closest && e.target.closest('tr[data-open]');
      if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.sel = r.dataset.open; render(); }
      if (e.key === 'Escape' && st.sel) { st.sel = null; render(); }
    });
    root.addEventListener('change', (e) => {
      const t = e.target;
      if (t.dataset.in === 'cat') { st.cat = t.value; render(); }
      else if (t.dataset.in === 'sort') { st.sort = t.value; render(); }
    });
    root.addEventListener('input', (e) => {
      if (e.target.dataset.in !== 'q') return;
      const v = e.target.value; clearTimeout(qTimer);
      qTimer = setTimeout(() => { st.q = v.trim().slice(0, 80); load().then(() => { const i = root.querySelector('[data-in="q"]'); if (i) { i.focus(); i.setSelectionRange(i.value.length, i.value.length); } }); }, 350);
    });

    load();
    return { reload: load, _state: st };
  }

  window.SokoniProductsConsole = { mount, _internal: { F, stockState, discountPct, marginPct, esc, TABS } };
  /* the shared admin-console look (Products, Invoices …): one stylesheet, injected once */
  window.SokoniConsoleStyles = { inject: injectCss, esc };
})();
