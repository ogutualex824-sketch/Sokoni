'use strict';
/**
 * SOKONI Command Palette — Sprint 4.6
 * Global Ctrl+K / Cmd+K launcher injected on every page via shared-header.js.
 * Pure client-side — no Firebase calls required for navigation.
 * Exposed as window.SokoniCP = { open, close, toggle }
 */
(function SokoniCommandPalette() {
  if (window.__skCP) return;
  window.__skCP = true;

  // ── Page catalogue ────────────────────────────────────────────────────────
  const PAGES = [
    // Marketplace
    { cat:'Marketplace', icon:'🛍️', label:'Home — Marketplace',       href:'index.html' },
    { cat:'Marketplace', icon:'🛒', label:'Shopping Cart',             href:'cart.html' },
    { cat:'Marketplace', icon:'❤️', label:'Wishlist',                  href:'wishlist.html' },
    { cat:'Marketplace', icon:'📦', label:'My Orders',                 href:'orders.html' },
    { cat:'Marketplace', icon:'🏷️', label:'Auctions',                  href:'auction.html' },
    { cat:'Marketplace', icon:'💳', label:'Checkout',                  href:'checkout.html' },
    { cat:'Marketplace', icon:'🔍', label:'Search',                    href:'search.html' },
    // Seller
    { cat:'Seller', icon:'🏪', label:'Seller Dashboard',              href:'seller.html' },
    { cat:'Seller', icon:'📊', label:'Analytics',                     href:'analytics.html' },
    { cat:'Seller', icon:'📦', label:'My Products',                   href:'products.html' },
    { cat:'Seller', icon:'📋', label:'Seller Orders',                 href:'seller-orders.html' },
    { cat:'Seller', icon:'💰', label:'Finance OS',                    href:'financial-os.html' },
    { cat:'Seller', icon:'🎯', label:'Merchant Success',              href:'merchant-success.html' },
    { cat:'Seller', icon:'🏬', label:'MiniShop',                      href:'minishop.html' },
    // SmartPOS
    { cat:'SmartPOS', icon:'🖥️', label:'SmartPOS Checkout',           href:'pos.html' },
    { cat:'SmartPOS', icon:'📅', label:'POS Daily Report',            href:'pos-daily.html' },
    { cat:'SmartPOS', icon:'📈', label:'POS Observability',           href:'pos-observability.html' },
    { cat:'SmartPOS', icon:'🔗', label:'POS Marketplace Sync',        href:'pos-marketplace.html' },
    // Logistics
    { cat:'Logistics', icon:'🚛', label:'Fleet Manager',              href:'fleet-manager.html' },
    { cat:'Logistics', icon:'🗺️', label:'Route Planner',              href:'route-planner.html' },
    { cat:'Logistics', icon:'🏭', label:'Warehouse',                  href:'warehouse.html' },
    { cat:'Logistics', icon:'📊', label:'Logistics Reports',          href:'logistics-reports.html' },
    // Hubs
    { cat:'Hubs', icon:'🍔', label:'Food Hub',                       href:'food.html' },
    { cat:'Hubs', icon:'🎭', label:'Events',                         href:'events.html' },
    { cat:'Hubs', icon:'🏠', label:'Properties (BnB)',               href:'bnb.html' },
    { cat:'Hubs', icon:'🚗', label:'Vehicles',                       href:'car-rental.html' },
    { cat:'Hubs', icon:'💼', label:'Jobs',                           href:'jobs.html' },
    { cat:'Hubs', icon:'🏥', label:'Healthcare',                     href:'healthcare.html' },
    { cat:'Hubs', icon:'🎓', label:'Education',                      href:'education.html' },
    { cat:'Hubs', icon:'⚖️', label:'Legal Services',                 href:'legal.html' },
    { cat:'Hubs', icon:'🎬', label:'Entertainment',                  href:'entertainment.html' },
    { cat:'Hubs', icon:'🏗️', label:'Construction',                   href:'construction.html' },
    // Platform
    { cat:'Platform', icon:'💰', label:'Wallet',                     href:'wallet.html' },
    { cat:'Platform', icon:'🎁', label:'Loyalty & Rewards',          href:'loyalty.html' },
    { cat:'Platform', icon:'🔔', label:'Notifications',              href:'notifications.html' },
    { cat:'Platform', icon:'💬', label:'Messages',                   href:'messages.html' },
    { cat:'Platform', icon:'⭐', label:'Reviews',                    href:'reviews.html' },
    { cat:'Platform', icon:'🆔', label:'Profile',                    href:'profile.html' },
    { cat:'Platform', icon:'🔐', label:'Security Settings',          href:'security.html' },
    // Admin
    { cat:'Admin', icon:'⚙️', label:'Admin OS',                     href:'admin-os.html' },
    { cat:'Admin', icon:'🔒', label:'Security Center',               href:'security-center.html' },
    { cat:'Admin', icon:'📡', label:'Observability',                 href:'observability.html' },
    { cat:'Admin', icon:'🔗', label:'Webhooks',                     href:'webhooks.html' },
    { cat:'Admin', icon:'⏳', label:'Task Queue',                   href:'task-queue.html' },
    { cat:'Admin', icon:'🌐', label:'API Gateway',                  href:'api-gateway.html' },
    { cat:'Admin', icon:'🤖', label:'Automation Center',            href:'automation-center.html' },
    { cat:'Admin', icon:'🛡️', label:'Trust & Safety',               href:'trust-safety.html' },
    { cat:'Admin', icon:'👑', label:'Super Admin',                   href:'super-admin.html' },
    { cat:'Admin', icon:'🏗️', label:'Platform Hub',                  href:'platform-hub.html' },
    { cat:'Admin', icon:'💻', label:'Developer Portal',              href:'developer-portal.html' },
  ];

  const ACTIONS = [
    { cat:'Quick Action', icon:'➕', label:'Add New Product',  fn:() => { location.href='products.html?action=new'; } },
    { cat:'Quick Action', icon:'📋', label:'View All Orders',  fn:() => { location.href='seller-orders.html'; } },
    { cat:'Quick Action', icon:'💸', label:'View Wallet',       fn:() => { location.href='wallet.html'; } },
    { cat:'Quick Action', icon:'📊', label:'Open Analytics',   fn:() => { location.href='analytics.html'; } },
    { cat:'Quick Action', icon:'🚚', label:'Fleet Dashboard',   fn:() => { location.href='fleet-manager.html'; } },
    { cat:'Quick Action', icon:'📡', label:'Observability',     fn:() => { location.href='observability.html'; } },
  ];

  // ── Recent pages (localStorage) ───────────────────────────────────────────
  const REC_KEY = 'sk_cp_recent';
  function _getRecent() {
    try { return JSON.parse(localStorage.getItem(REC_KEY) || '[]'); } catch { return []; }
  }
  function _addRecent(pg) {
    const list = _getRecent().filter(p => p.href !== pg.href);
    list.unshift({ label: pg.label, href: pg.href, icon: pg.icon });
    try { localStorage.setItem(REC_KEY, JSON.stringify(list.slice(0, 6))); } catch {}
  }

  // ── Fuzzy match + score ───────────────────────────────────────────────────
  function _fuzzy(q, text) {
    const ql = q.toLowerCase(), tl = text.toLowerCase();
    let qi = 0;
    for (let i = 0; i < tl.length && qi < ql.length; i++) {
      if (tl[i] === ql[qi]) qi++;
    }
    return qi === ql.length;
  }
  function _score(q, text) {
    if (!q) return 0;
    const ql = q.toLowerCase(), tl = text.toLowerCase();
    if (tl === ql) return 100;
    if (tl.startsWith(ql)) return 80;
    if (tl.includes(ql)) return 60;
    return 20;
  }

  function _buildItems(query) {
    const q = query.toLowerCase();
    const items = [];

    if (!q) {
      _getRecent().forEach(r => items.push({ ...r, cat:'Recent', type:'page' }));
    }

    PAGES
      .filter(p => !q || _fuzzy(q, p.label) || _fuzzy(q, p.cat))
      .sort((a, b) => _score(q, b.label) - _score(q, a.label))
      .slice(0, q ? 14 : 6)
      .forEach(p => items.push({ ...p, type:'page' }));

    ACTIONS
      .filter(a => !q || _fuzzy(q, a.label))
      .slice(0, q ? 4 : 3)
      .forEach(a => items.push({ ...a, type:'action' }));

    return items;
  }

  // ── HTML escaping ─────────────────────────────────────────────────────────
  function _esc(s) {
    return String(s || '').replace(/[<>"'&]/g, c =>
      ({ '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;', '&':'&amp;' }[c]));
  }

  // ── DOM state ─────────────────────────────────────────────────────────────
  let _overlay = null, _inp = null, _list = null, _cursor = -1, _items = [];
  let _initialized = false;

  function _init() {
    if (_initialized) return;
    _initialized = true;

    const style = document.createElement('style');
    style.id = 'sk-cp-css';
    style.textContent =
      '#sk-cp{position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.72);' +
        'backdrop-filter:blur(6px);display:flex;align-items:flex-start;justify-content:center;' +
        'padding-top:clamp(56px,11vh,130px);opacity:0;pointer-events:none;' +
        'transition:opacity .18s ease}' +
      '#sk-cp.sk-cp-open{opacity:1;pointer-events:auto}' +
      '#sk-cp-box{background:#0e0e0e;border:1px solid #1e1e1e;border-radius:14px;' +
        'width:min(620px,96vw);max-height:72vh;display:flex;flex-direction:column;' +
        'overflow:hidden;box-shadow:0 28px 72px rgba(0,0,0,.8);' +
        'transform:translateY(-10px) scale(.98);transition:transform .18s ease}' +
      '#sk-cp.sk-cp-open #sk-cp-box{transform:translateY(0) scale(1)}' +
      '#sk-cp-hd{display:flex;align-items:center;gap:11px;padding:13px 16px;' +
        'border-bottom:1px solid #1a1a1a;background:#0a0a0a}' +
      '#sk-cp-hd svg{flex-shrink:0;color:#71ff00;opacity:.7}' +
      '#sk-cp-inp{flex:1;background:0 0;border:0;outline:0;font:500 15px/1 system-ui,sans-serif;' +
        'color:#ececec;caret-color:#71ff00;padding:0}' +
      '#sk-cp-inp::placeholder{color:#3a3a3a}' +
      '.sk-cp-esc{font-size:10px;color:#2e2e2e;border:1px solid #222;border-radius:5px;' +
        'padding:2px 7px;white-space:nowrap;font-family:monospace}' +
      '#sk-cp-list{overflow-y:auto;padding:6px 0;' +
        'scrollbar-width:thin;scrollbar-color:#1e1e1e transparent}' +
      '#sk-cp-list::-webkit-scrollbar{width:4px}' +
      '#sk-cp-list::-webkit-scrollbar-thumb{background:#1e1e1e;border-radius:2px}' +
      '.sk-cp-sec{padding:5px 16px 3px;font-size:10px;font-weight:700;letter-spacing:.1em;' +
        'color:#333;text-transform:uppercase;margin-top:4px}' +
      '.sk-cp-row{display:flex;align-items:center;gap:11px;padding:9px 16px;cursor:pointer;' +
        'color:#bbb;font-size:13.5px;transition:background .1s,color .1s;border-left:2px solid transparent}' +
      '.sk-cp-row:hover,.sk-cp-row.sk-cp-hi{background:#141414;color:#f0f0f0;' +
        'border-left-color:#71ff00}' +
      '.sk-cp-ico{font-size:15px;width:22px;text-align:center;flex-shrink:0;line-height:1}' +
      '.sk-cp-lbl{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.sk-cp-tag{font-size:10px;color:#2e2e2e;white-space:nowrap;flex-shrink:0}' +
      '#sk-cp-empty{padding:36px 0;text-align:center;color:#2a2a2a;font-size:13px}' +
      '#sk-cp-foot{padding:8px 16px;border-top:1px solid #141414;display:flex;gap:16px;' +
        'font-size:10px;color:#292929;background:#080808}' +
      '.sk-cp-hint{display:flex;align-items:center;gap:4px}' +
      '.sk-cp-hint kbd{border:1px solid #1e1e1e;border-radius:3px;padding:1px 4px;' +
        'font-family:monospace;font-size:9px;color:#333}';
    document.head.appendChild(style);

    _overlay = document.createElement('div');
    _overlay.id = 'sk-cp';
    _overlay.setAttribute('role', 'dialog');
    _overlay.setAttribute('aria-modal', 'true');
    _overlay.setAttribute('aria-label', 'Command palette');
    _overlay.innerHTML =
      '<div id="sk-cp-box">' +
        '<div id="sk-cp-hd">' +
          '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
            '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/>' +
          '</svg>' +
          '<input id="sk-cp-inp" type="text" placeholder="Search pages and actions…" autocomplete="off" spellcheck="false" aria-label="Command search" aria-autocomplete="list" aria-controls="sk-cp-list">' +
          '<span class="sk-cp-esc">ESC</span>' +
        '</div>' +
        '<div id="sk-cp-list" role="listbox" aria-label="Search results"></div>' +
        '<div id="sk-cp-foot">' +
          '<span class="sk-cp-hint"><kbd>↑</kbd><kbd>↓</kbd> navigate</span>' +
          '<span class="sk-cp-hint"><kbd>↵</kbd> open</span>' +
          '<span class="sk-cp-hint"><kbd>ESC</kbd> close</span>' +
        '</div>' +
      '</div>';

    document.body.appendChild(_overlay);
    _inp  = _overlay.querySelector('#sk-cp-inp');
    _list = _overlay.querySelector('#sk-cp-list');

    _overlay.addEventListener('click', e => { if (e.target === _overlay) _close(); });
    _inp.addEventListener('input', () => { _cursor = -1; _paint(_inp.value.trim()); });
    _inp.addEventListener('keydown', _onKey);
  }

  // ── Render list ───────────────────────────────────────────────────────────
  function _paint(query) {
    _items = _buildItems(query);
    if (!_items.length) {
      _list.innerHTML = '<div id="sk-cp-empty">No results for &ldquo;' + _esc(query) + '&rdquo;</div>';
      return;
    }

    const frag = document.createDocumentFragment();
    let lastCat = null;

    _items.forEach((item, i) => {
      if (item.cat !== lastCat) {
        lastCat = item.cat;
        const sec = document.createElement('div');
        sec.className = 'sk-cp-sec';
        sec.textContent = item.cat;
        frag.appendChild(sec);
      }
      const row = document.createElement('div');
      row.className = 'sk-cp-row' + (i === _cursor ? ' sk-cp-hi' : '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', i === _cursor ? 'true' : 'false');
      row.dataset.idx = i;
      row.innerHTML =
        '<span class="sk-cp-ico" aria-hidden="true">' + _esc(item.icon || '📄') + '</span>' +
        '<span class="sk-cp-lbl">' + _esc(item.label) + '</span>' +
        '<span class="sk-cp-tag">' + _esc(item.cat) + '</span>';
      row.addEventListener('click', () => _activate(item));
      frag.appendChild(row);
    });

    _list.innerHTML = '';
    _list.appendChild(frag);
  }

  // ── Keyboard navigation ───────────────────────────────────────────────────
  function _onKey(e) {
    const rows = _list.querySelectorAll('.sk-cp-row');
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      _cursor = Math.min(_cursor + 1, rows.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      _cursor = Math.max(_cursor - 1, 0);
    } else if (e.key === 'Enter') {
      const target = _items[_cursor] || _items[0];
      if (target) _activate(target);
      return;
    } else if (e.key === 'Escape') {
      _close();
      return;
    } else {
      return;
    }
    rows.forEach((r, i) => {
      r.classList.toggle('sk-cp-hi', i === _cursor);
      r.setAttribute('aria-selected', i === _cursor ? 'true' : 'false');
    });
    if (rows[_cursor]) rows[_cursor].scrollIntoView({ block: 'nearest' });
  }

  // ── Actions ───────────────────────────────────────────────────────────────
  function _activate(item) {
    _close();
    if (item.fn) { item.fn(); return; }
    if (item.href) { _addRecent(item); location.href = item.href; }
  }

  function _open() {
    _init();
    _cursor = -1;
    _inp.value = '';
    _paint('');
    _overlay.classList.add('sk-cp-open');
    document.documentElement.style.overflowY = 'hidden';
    requestAnimationFrame(() => _inp.focus());
  }

  function _close() {
    if (!_overlay) return;
    _overlay.classList.remove('sk-cp-open');
    document.documentElement.style.overflowY = '';
  }

  function _toggle() {
    if (_overlay && _overlay.classList.contains('sk-cp-open')) _close(); else _open();
  }

  // ── Global keyboard shortcut (Ctrl+K / Cmd+K) ────────────────────────────
  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key === 'k') {
      const tag = (document.activeElement || {}).tagName || '';
      if (tag === 'TEXTAREA') return; // let text areas keep Ctrl+K
      e.preventDefault();
      _toggle();
    }
  }, true);

  // ── Public API ────────────────────────────────────────────────────────────
  window.SokoniCP = { open: _open, close: _close, toggle: _toggle };
})();
