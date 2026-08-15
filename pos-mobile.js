/* SOKONI SmartPOS — Mobile Controller v1.0
   Phone-First: bottom navigation, one-tap actions, manager dashboard,
   PWA install, screen wake lock, Bluetooth pairing, voice extensions. */

'use strict';

const PosMobile = (() => {

  /* ── Detection ─────────────────────────────────────────────── */
  const isMobile  = () => window.matchMedia('(max-width: 767px)').matches;
  const isTablet  = () => window.matchMedia('(max-width: 1024px)').matches;
  const isTouchDevice = () => ('ontouchstart' in window) || navigator.maxTouchPoints > 0;

  let _installPrompt = null;
  let _wakeLock      = null;
  let _cartCount     = 0;
  let _activeTab     = 'home';
  let _swipeStart    = null;
  /* True once init() has made its default-panel decision (see the note at the
     end of init). A late listener that missed the event can read this instead,
     so readiness is not lost to a subscribe-after-the-fact race. */
  let _shellReady    = false;

  /* ── Boot ──────────────────────────────────────────────────── */
  async function init() {
    if (!isTouchDevice() && !isMobile()) return;

    _buildBottomNav();
    _buildFAB();
    _buildHomePanel();
    _attachSwipeHandlers();

    /* PWA install prompt */
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      _installPrompt = e;
      _showInstallBanner();
    });

    /* Screen wake lock to prevent sleep during sales */
    if ('wakeLock' in navigator) {
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible' && !_wakeLock) {
          _wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
        }
      });
      _wakeLock = await navigator.wakeLock.request('screen').catch(() => null);
    }

    /* Voice command extensions for mobile */
    _extendVoice();

    /* Load home dashboard */
    await refreshDashboard();

    /* Set mobile home as default */
    tab('home');

    /* ── Shell readiness ────────────────────────────────────────────────────
       The default-panel decision is complete. It is announced HERE, after
       tab('home'), because that call IS the decision — everything before it is
       construction.

       This exists because the panel choice was previously unobservable. pos.html
       ships #panel-pos active in its markup, and this function only overrides
       that at the very end of init, behind an await. Anything watching from
       outside could not tell "the shell chose Checkout" from "the shell has not
       decided yet", and a test that sampled too early saw the static default and
       reported a selection failure that had not happened.

       It deliberately says ONLY that the decision is made. Not that SPos exists,
       not that Firebase succeeded, not that dashboard data loaded, not that any
       particular panel is active — a reader must inspect the result themselves,
       or the signal would just be the answer restated.

       It fires even when the backend is unreachable: refreshDashboard() catches
       its own failure, so tab('home') runs regardless, and this must follow it
       just as unconditionally. App Check refusing to attest 127.0.0.1 stops the
       dashboard from POPULATING; it does not stop the shell from DECIDING. */
    _shellReady = true;
    try {
      document.dispatchEvent(new CustomEvent('sokoniPosMobileReady', {
        detail: { activeTab: _activeTab },
      }));
    } catch (_) { /* readiness must never break init */ }
  }

  /* ── Bottom Navigation ─────────────────────────────────────── */
  function _buildBottomNav() {
    document.getElementById('mobile-bottom-nav')?.remove();
    const nav = document.createElement('nav');
    nav.id        = 'mobile-bottom-nav';
    nav.className = 'mobile-bottom-nav';
    nav.innerHTML = `
      <button class="mbn-btn active" id="mbn-home"  onclick="PosMobile.tab('home')">
        <span class="mbn-icon">🏠</span><span class="mbn-label">Home</span>
      </button>
      <button class="mbn-btn" id="mbn-pos" onclick="PosMobile.tab('pos')">
        <span class="mbn-icon">🛒</span>
        <span class="mbn-label">Sell</span>
        <span class="mbn-badge" id="cart-badge" style="display:none">0</span>
      </button>
      <button class="mbn-btn mbn-scan" onclick="PosScanner.open('auto')">
        <span class="mbn-scan-circle">📷</span>
        <span class="mbn-label">Scan</span>
      </button>
      <button class="mbn-btn" id="mbn-inventory" onclick="PosMobile.tab('inventory')">
        <span class="mbn-icon">📦</span><span class="mbn-label">Stock</span>
      </button>
      <button class="mbn-btn" id="mbn-more" onclick="PosMobile.openMore()">
        <span class="mbn-icon">☰</span><span class="mbn-label">More</span>
      </button>
    `;
    document.body.appendChild(nav);
  }

  function tab(name) {
    _activeTab = name;
    /* Update bottom nav */
    document.querySelectorAll('.mbn-btn').forEach(b => b.classList.remove('active'));
    document.getElementById(`mbn-${name}`)?.classList.add('active');

    if (name === 'home') {
      _showMobileHome();
    } else if (window.SPos) {
      _hideMobileHome();
      SPos.ui.switchTab(name);
    }
  }

  function _showMobileHome() {
    document.querySelectorAll('.pos-panel').forEach(p => p.classList.remove('active'));
    document.getElementById('mobile-home-panel')?.classList.add('active');
  }

  function _hideMobileHome() {
    document.getElementById('mobile-home-panel')?.classList.remove('active');
  }

  /* ── FAB (Floating Action Button) ─────────────────────────── */
  function _buildFAB() {
    document.getElementById('mobile-fab')?.remove();
    /* FAB removed — scanner is in bottom nav center. Keep for non-mobile fallback */
  }

  /* ── Mobile Home Panel ─────────────────────────────────────── */
  function _buildHomePanel() {
    document.getElementById('mobile-home-panel')?.remove();
    const panel = document.createElement('div');
    panel.id        = 'mobile-home-panel';
    panel.className = 'mobile-home-panel pos-panel';
    panel.innerHTML = `
      <!-- Header -->
      <div class="mhp-header">
        <div>
          <div class="mhp-greeting" id="mhp-greeting">Good morning 👋</div>
          <div class="mhp-biz-name" id="mhp-biz-name">SOKONI SmartPOS</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center">
          <button class="mhp-icon-btn" onclick="PosMobile.tab('reports')" title="Reports">📊</button>
          <button class="mhp-icon-btn" onclick="PosMobile.tab('settings')" title="Settings">⚙️</button>
        </div>
      </div>

      <!-- Today's KPIs -->
      <div class="mhp-kpis" id="mhp-kpis">
        <div class="mhp-kpi-card green">
          <div class="mhp-kpi-label">Today's Sales</div>
          <div class="mhp-kpi-val" id="kpi-sales">KES —</div>
          <div class="mhp-kpi-sub" id="kpi-sales-count">— transactions</div>
        </div>
        <div class="mhp-kpi-card">
          <div class="mhp-kpi-label">Profit</div>
          <div class="mhp-kpi-val" id="kpi-profit">KES —</div>
          <div class="mhp-kpi-sub" id="kpi-profit-margin">—% margin</div>
        </div>
        <div class="mhp-kpi-card">
          <div class="mhp-kpi-label">M-PESA</div>
          <div class="mhp-kpi-val" id="kpi-mpesa">KES —</div>
          <div class="mhp-kpi-sub" id="kpi-cash">Cash: —</div>
        </div>
        <div class="mhp-kpi-card amber" id="kpi-stock-card">
          <div class="mhp-kpi-label">Low Stock</div>
          <div class="mhp-kpi-val" id="kpi-low-stock">—</div>
          <div class="mhp-kpi-sub" id="kpi-low-stock-sub">items</div>
        </div>
      </div>

      <!-- Quick Actions -->
      <div class="mhp-section-title">Quick Actions</div>
      <div class="mhp-actions" id="mhp-actions">
        ${_quickActionTiles().join('')}
      </div>

      <!-- Recent Transactions -->
      <div class="mhp-section-title" style="display:flex;justify-content:space-between">
        <span>Recent Sales</span>
        <button onclick="PosMobile.tab('reports')" style="font-size:11px;color:var(--green);background:none;border:none;cursor:pointer">See all →</button>
      </div>
      <div id="mhp-recent-txns" class="mhp-recent">
        <div style="color:var(--txt2);font-size:13px;padding:20px;text-align:center">Loading…</div>
      </div>

      <!-- Low Stock Alerts -->
      <div id="mhp-low-stock-list"></div>

      <!-- Shift status -->
      <div class="mhp-shift-bar" id="mhp-shift-bar">
        <span id="mhp-shift-label">No shift open</span>
        <button class="mhp-shift-btn" id="mhp-shift-btn" onclick="PosMobile._toggleShift()">Open Shift</button>
      </div>
    `;

    /* Insert before bottom nav */
    const bottomNav = document.getElementById('mobile-bottom-nav');
    document.body.insertBefore(panel, bottomNav);
  }

  function _quickActionTiles() {
    return [
      { icon: '🛒', label: 'Quick Sale',    color: 'var(--green)', fn: "PosMobile.tab('pos')" },
      { icon: '📷', label: 'Scan Product',  color: '#60a5fa',      fn: "PosScanner.open('barcode')" },
      { icon: '📦', label: 'Add Stock',     color: '#f59e0b',      fn: "PosMobile.openStockIn()" },
      { icon: '➕', label: 'New Product',   color: '#c8ff80',      fn: "PosMobile.openCreateProduct()" },
      { icon: '🏷️', label: 'Print Label',   color: '#f43f5e',      fn: "PosScanner.open('barcode',PosMobile._printLabelResult)" },
      { icon: '🧾', label: 'Scan Invoice',  color: '#34d399',      fn: "PosScanner.open('invoice')" },
      { icon: '🔐', label: 'Check Warranty',color: '#94a3b8',      fn: "PosScanner.open('serial')" },
      { icon: '📊', label: 'Dashboard',     color: '#818cf8',      fn: "PosMobile.tab('reports')" },
    ].map(a => `
      <button class="mhp-action-tile" onclick="${a.fn}" style="border-color:${a.color}20">
        <span class="mhp-action-icon" style="background:${a.color}18;color:${a.color}">${a.icon}</span>
        <span class="mhp-action-label">${a.label}</span>
      </button>
    `);
  }

  /* ── Dashboard data refresh ────────────────────────────────── */
  async function refreshDashboard() {
    const start = new Date().setHours(0, 0, 0, 0);
    const end   = new Date().setHours(23, 59, 59, 999);

    try {
      const [report, low] = await Promise.all([
        PosDB.reports.forDateRange(start, end),
        PosDB.products.getLowStock(10),
      ]);

      /* KPIs */
      _setText('kpi-sales',         'KES ' + (report.total || 0).toLocaleString());
      _setText('kpi-sales-count',   (report.count || 0) + ' transactions');
      _setText('kpi-profit',        'KES ' + (report.profit || 0).toLocaleString());
      _setText('kpi-profit-margin', report.total > 0 ? Math.round(report.profit / report.total * 100) + '% margin' : '—');
      _setText('kpi-mpesa',         'KES ' + (report.mpesa || 0).toLocaleString());
      _setText('kpi-cash',          'Cash: KES ' + (report.cash || 0).toLocaleString());
      _setText('kpi-low-stock',     low.length.toString());
      _setText('kpi-low-stock-sub', low.length > 0 ? 'need restocking' : 'all stocked');
      const stockCard = document.getElementById('kpi-stock-card');
      if (stockCard) stockCard.className = `mhp-kpi-card ${low.length > 0 ? 'amber' : 'green'}`;

      /* Greeting */
      const h = new Date().getHours();
      const greeting = h < 12 ? 'Good morning 👋' : h < 17 ? 'Good afternoon 👋' : 'Good evening 👋';
      _setText('mhp-greeting', greeting);

      /* Biz name */
      const settings = await PosDB.settings.getAll();
      _setText('mhp-biz-name', settings.bizName || 'SOKONI SmartPOS');

      /* Recent transactions */
      const allTxns = await PosDB.transactions.getAll();
      const recent  = allTxns
        .filter(t => t.status === 'completed')
        .sort((a, b) => (b.completedAt || b.timestamp) - (a.completedAt || a.timestamp))
        .slice(0, 8);
      _renderRecentTxns(recent);

      /* Low stock list */
      _renderLowStockList(low.slice(0, 5));

      /* Shift status */
      _updateShiftBar(settings);

    } catch (e) {
      console.error('[PosMobile] Dashboard error:', e);
    }
  }

  function _renderRecentTxns(txns) {
    const el = document.getElementById('mhp-recent-txns');
    if (!el) return;
    if (!txns.length) {
      el.innerHTML = '<div style="color:var(--txt2);font-size:13px;padding:16px;text-align:center">No sales yet today</div>';
      return;
    }
    el.innerHTML = txns.map(t => `
      <div class="mhp-txn-row">
        <div class="mhp-txn-icon ${t.paymentMethod}">${t.paymentMethod === 'mpesa' ? '📱' : t.paymentMethod === 'card' ? '💳' : '💵'}</div>
        <div class="mhp-txn-info">
          <div class="mhp-txn-no">${_esc(t.receiptNo || '—')}</div>
          <div class="mhp-txn-time">${new Date(t.completedAt || t.timestamp).toLocaleTimeString('en-KE', { hour:'2-digit', minute:'2-digit' })} · ${(t.items||[]).length} items</div>
        </div>
        <div class="mhp-txn-amt">KES ${(t.total || 0).toLocaleString()}</div>
      </div>
    `).join('');
  }

  function _renderLowStockList(items) {
    const el = document.getElementById('mhp-low-stock-list');
    if (!el || !items.length) return;
    el.innerHTML = `
      <div class="mhp-section-title" style="color:#f59e0b">⚠️ Low Stock Alerts</div>
      ${items.map(p => `
        <div class="mhp-txn-row" onclick="PosMobile.openStockIn(${JSON.stringify({id:p.id,name:p.name,stock:p.stock}).replace(/"/g,'&quot;')})">
          <div class="mhp-txn-icon" style="background:rgba(245,158,11,.1);color:#f59e0b">📦</div>
          <div class="mhp-txn-info">
            <div class="mhp-txn-no">${_esc(p.name)}</div>
            <div class="mhp-txn-time">${p.stock} ${p.unit || 'units'} remaining</div>
          </div>
          <div class="mhp-txn-amt" style="color:#f59e0b">Restock</div>
        </div>
      `).join('')}
    `;
  }

  async function _updateShiftBar(settings) {
    const shift = settings?.currentShift;
    const label = document.getElementById('mhp-shift-label');
    const btn   = document.getElementById('mhp-shift-btn');
    if (!label || !btn) return;
    if (shift?.status === 'open') {
      const hrs = ((Date.now() - shift.openTime) / 3600000).toFixed(1);
      label.textContent = `Shift open · ${hrs}h`;
      btn.textContent   = 'Close Shift';
    } else {
      label.textContent = 'No shift open';
      btn.textContent   = 'Open Shift';
    }
  }

  async function _toggleShift() {
    if (window.SPos) {
      const shift = SPos.state?.currentShift;
      if (shift?.status === 'open') SPos.shift.close();
      else                           SPos.shift.open();
    }
  }

  /* ── More menu (bottom sheet) ──────────────────────────────── */
  function openMore() {
    _openSheet('More Options', `
      <div class="more-grid">
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('reports')">   📊<span>Reports</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('customers')"> 👤<span>Customers</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('bos')">       📡<span>BOS Hub</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('finance')">   💰<span>Finance</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('repair')">    🔧<span>Repairs</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('audit')">     📋<span>Audit</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.tab('settings')">  ⚙️<span>Settings</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.openBluetooth()">  🔵<span>Bluetooth</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();window.location='print-station.html'">  🖨️<span>Print Station</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();window.location='manager-auth.html'">   🔐<span>Mgr Auth</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();window.location='commissioning.html'"> 🏭<span>Commission</span></button>
        <button class="more-tile" onclick="PosMobile.closeSheet();PosMobile.installApp()">     📲<span>Install App</span></button>
      </div>
      <div style="height:16px"></div>
    `);
  }

  /* ── One-Tap Action Handlers ───────────────────────────────── */
  function openStockIn(product) {
    const name = product?.name || '';
    _openSheet('Add Stock', `
      <div class="msheet-field">
        <label>Product</label>
        <input id="stock-in-product" class="msheet-input" value="${_esc(name)}" placeholder="Search or scan…"
          oninput="PosMobile._stockSearch(this.value)">
      </div>
      <div id="stock-in-search-results"></div>
      <div class="msheet-field">
        <label>Quantity to Add</label>
        <input id="stock-in-qty" class="msheet-input" type="number" min="1" value="1" inputmode="numeric">
      </div>
      <div class="msheet-field">
        <label>Cost Price (optional)</label>
        <input id="stock-in-cost" class="msheet-input" type="number" min="0" placeholder="0.00" inputmode="decimal">
      </div>
      <div class="msheet-field">
        <label>Note</label>
        <input id="stock-in-note" class="msheet-input" placeholder="e.g. Supplier delivery">
      </div>
      <button class="msheet-btn-primary" onclick="PosMobile._saveStockIn()">Add Stock</button>
    `);
    if (product) _stockInSelected = product;
  }

  let _stockInSelected = null;

  async function _stockSearch(query) {
    if (!query || query.length < 2) return;
    const results = await PosDB.products.search(query);
    const el = document.getElementById('stock-in-search-results');
    if (!el) return;
    el.innerHTML = results.slice(0, 5).map(p => `
      <div class="msheet-search-row" onclick="PosMobile._selectStockIn('${p.id}','${_esc(p.name)}')">
        <span>${_esc(p.name)}</span>
        <span style="color:var(--txt2);font-size:12px">${p.stock} in stock</span>
      </div>
    `).join('');
  }

  async function _selectStockIn(id, name) {
    const products = await PosDB.products.getAll();
    _stockInSelected = products.find(p => p.id === id);
    const inp = document.getElementById('stock-in-product');
    if (inp) inp.value = name;
    const el = document.getElementById('stock-in-search-results');
    if (el) el.innerHTML = '';
  }

  async function _saveStockIn() {
    if (!_stockInSelected) {
      if (window.SPos) SPos.toast('Select a product first', 'error'); return;
    }
    const qty  = parseInt(document.getElementById('stock-in-qty')?.value || 0, 10);
    if (!qty || qty <= 0) {
      if (window.SPos) SPos.toast('Enter a valid quantity', 'error'); return;
    }
    const cost = parseFloat(document.getElementById('stock-in-cost')?.value || 0);
    const note = document.getElementById('stock-in-note')?.value || 'manual_stock_in';
    await PosDB.products.adjustStock(_stockInSelected.id, qty, note, SPos?.state?.currentCashier?.id);
    if (cost > 0) {
      await PosDB.products.update(_stockInSelected.id, { costPrice: cost });
    }
    if (window.PosAudit) PosAudit.log('stock_adjusted', { productId: _stockInSelected.id, qty, note });
    if (window.SPos) { SPos.toast(`✓ +${qty} ${_stockInSelected.name}`, 'success'); SPos.products.reload(); }
    closeSheet();
    await refreshDashboard();
    _stockInSelected = null;
  }

  function openCreateProduct(prefill = {}) {
    _openSheet('Create Product', `
      <div class="msheet-field"><label>Product Name *</label>
        <input id="cp-name" class="msheet-input" placeholder="e.g. Unga Pembe 2kg" value="${_esc(prefill.name || '')}"></div>
      <div class="msheet-row">
        <div class="msheet-field"><label>Selling Price (KES) *</label>
          <input id="cp-price" class="msheet-input" type="number" min="0" placeholder="0.00" inputmode="decimal"></div>
        <div class="msheet-field"><label>Cost Price</label>
          <input id="cp-cost" class="msheet-input" type="number" min="0" placeholder="0.00" inputmode="decimal"></div>
      </div>
      <div class="msheet-row">
        <div class="msheet-field"><label>Stock Qty</label>
          <input id="cp-stock" class="msheet-input" type="number" min="0" value="0" inputmode="numeric"></div>
        <div class="msheet-field"><label>Unit</label>
          <select id="cp-unit" class="msheet-input">
            <option>pcs</option><option>kg</option><option>g</option><option>L</option>
            <option>ml</option><option>bottle</option><option>bag</option><option>box</option>
          </select></div>
      </div>
      <div class="msheet-field"><label>Barcode</label>
        <div style="display:flex;gap:8px">
          <input id="cp-barcode" class="msheet-input" style="flex:1" placeholder="Scan or enter" value="${_esc(prefill.barcode || '')}">
          <button class="msheet-icon-btn" onclick="PosScanner.open('barcode',r=>{ document.getElementById('cp-barcode').value=r.value; PosScanner.close(); })">📷</button>
        </div></div>
      <div class="msheet-field"><label>Category</label>
        <input id="cp-category" class="msheet-input" placeholder="Food, Electronics…"></div>
      <button class="msheet-btn-primary" onclick="PosMobile._saveNewProduct()">Create Product</button>
    `);
  }

  async function _saveNewProduct() {
    const name  = document.getElementById('cp-name')?.value?.trim();
    const price = parseFloat(document.getElementById('cp-price')?.value || 0);
    if (!name || !price) { if (window.SPos) SPos.toast('Name and price required', 'error'); return; }
    const product = {
      name,
      price,
      costPrice: parseFloat(document.getElementById('cp-cost')?.value || 0) || price * 0.7,
      stock:     parseInt(document.getElementById('cp-stock')?.value || 0, 10),
      unit:      document.getElementById('cp-unit')?.value || 'pcs',
      barcode:   document.getElementById('cp-barcode')?.value?.trim() || '',
      category:  document.getElementById('cp-category')?.value?.trim() || 'Other',
      updatedAt: Date.now(),
    };
    const saved = await PosDB.products.save(product);
    if (window.PosAudit) PosAudit.log('product_created', { name, price });
    if (window.PosPlugins) PosPlugins.emit('inventory:updated', saved);
    if (window.SPos) { SPos.toast('✓ Product created: ' + name, 'success'); SPos.products.reload(); }
    closeSheet();
  }

  function openProductEdit(product) {
    if (!product) return;
    _openSheet('Edit Product', `
      <div class="msheet-field"><label>Name</label>
        <input id="ep-name" class="msheet-input" value="${_esc(product.name || '')}"></div>
      <div class="msheet-row">
        <div class="msheet-field"><label>Price (KES)</label>
          <input id="ep-price" class="msheet-input" type="number" value="${product.price || 0}" inputmode="decimal"></div>
        <div class="msheet-field"><label>Stock</label>
          <input id="ep-stock" class="msheet-input" type="number" value="${product.stock || 0}" inputmode="numeric"></div>
      </div>
      <div class="msheet-field"><label>Barcode</label>
        <input id="ep-barcode" class="msheet-input" value="${_esc(product.barcode || '')}"></div>
      <div style="font-size:11px;color:var(--txt2);margin:4px 0">Cost: KES ${product.costPrice || 0} · Category: ${product.category || '—'}</div>
      <div style="display:flex;gap:8px;margin-top:10px">
        <button class="msheet-btn-primary" style="flex:2" onclick="PosMobile._updateProduct('${product.id}')">Save Changes</button>
        <button class="msheet-btn-danger" onclick="PosMobile._deleteProduct('${product.id}')">Delete</button>
      </div>
    `);
  }

  async function _updateProduct(id) {
    const patch = {
      name:  document.getElementById('ep-name')?.value?.trim(),
      price: parseFloat(document.getElementById('ep-price')?.value || 0),
      stock: parseInt(document.getElementById('ep-stock')?.value || 0, 10),
      barcode: document.getElementById('ep-barcode')?.value?.trim(),
    };
    await PosDB.products.update(id, patch);
    if (window.PosAudit) PosAudit.log('product_updated', { id, ...patch });
    if (window.SPos) { SPos.toast('✓ Product updated', 'success'); SPos.products.reload(); }
    closeSheet();
  }

  async function _deleteProduct(id) {
    if(!_c){_skConfirm('Delete this product?',()=>_doPosMobDel(_pid,true));return;}
    await PosDB.products.delete(id);
    if (window.PosAudit) PosAudit.log('product_deleted', { id });
    if (window.SPos) { SPos.toast('Product deleted', 'info'); SPos.products.reload(); }
    closeSheet();
  }

  function showWarranty(warranty) {
    const w = warranty;
    _openSheet('Warranty Status', `
      <div class="warranty-result-card ${w.valid ? 'valid' : 'expired'}">
        <div class="warranty-icon">${w.valid ? '✅' : '⚠️'}</div>
        <div class="warranty-status">${w.valid ? 'Warranty Valid' : w.expired ? 'Warranty Expired' : 'No Warranty'}</div>
        <div class="warranty-detail">${w.expiresDate ? (w.valid ? w.daysLeft + ' days remaining (expires ' + w.expiresDate + ')' : 'Expired ' + w.expiresDate) : ''}</div>
        ${w.productName ? `<div class="warranty-product">${_esc(w.productName)}</div>` : ''}
        ${w.customerName ? `<div class="warranty-customer">👤 ${_esc(w.customerName)}${w.customerPhone ? ' · ' + w.customerPhone : ''}</div>` : ''}
        ${w.saleDate ? `<div class="warranty-date">Purchased: ${new Date(w.saleDate).toLocaleDateString()}</div>` : ''}
      </div>
      ${w.valid ? '<button class="msheet-btn-primary" onclick="PosMobile.closeSheet()">Close</button>' : ''}
    `);
  }

  function openRegisterSerial(value, type) {
    _openSheet('Register Serial Number', `
      <div class="msheet-field">
        <label>${type === 'imei' ? 'IMEI' : 'Serial Number'}</label>
        <input id="rs-value" class="msheet-input" value="${_esc(value)}" readonly style="font-family:monospace">
      </div>
      <div class="msheet-field"><label>Product</label>
        <input id="rs-product" class="msheet-input" placeholder="Search product…" oninput="PosMobile._stockSearch(this.value)"></div>
      <div id="rs-search-results"></div>
      <div class="msheet-field"><label>Customer Name</label>
        <input id="rs-cust" class="msheet-input" placeholder="Optional"></div>
      <div class="msheet-field"><label>Warranty (months)</label>
        <input id="rs-warranty" class="msheet-input" type="number" value="12" inputmode="numeric"></div>
      <button class="msheet-btn-primary" onclick="PosMobile._saveSerial()">Register</button>
    `);
  }

  async function _saveSerial() {
    const serial  = document.getElementById('rs-value')?.value?.trim();
    const months  = parseInt(document.getElementById('rs-warranty')?.value || 0, 10);
    const custName = document.getElementById('rs-cust')?.value?.trim();
    if (!serial) return;
    await PosDB.serial_numbers.add({
      serial,
      productId:     _stockInSelected?.id || null,
      productName:   _stockInSelected?.name || null,
      customerName:  custName,
      saleDate:      Date.now(),
      warrantyMonths: months,
      status:        'registered',
    });
    if (window.SPos) SPos.toast('✓ Serial registered', 'success');
    closeSheet();
    _stockInSelected = null;
  }

  function _printLabelResult(result) {
    if (result?.product && window.PosLabels) {
      PosLabels.printProductLabels([result.product], 'standard');
    }
  }

  /* ── Bluetooth Pairing Sheet ───────────────────────────────── */
  function openBluetooth() {
    const btOk = !!navigator.bluetooth;
    const btNote = btOk ? '' :
      `<div style="background:rgba(245,158,11,0.12);border:1px solid rgba(245,158,11,0.3);border-radius:10px;padding:10px 12px;margin-bottom:12px;font-size:12px;color:#f59e0b">
        ⚠ Web Bluetooth requires <strong>Chrome on Android</strong>. It is not available on iOS, Firefox, or Safari.<br>Use Network printer below — works on any device.
       </div>`;
    const btDis = btOk ? '' : 'style="opacity:0.4;pointer-events:none"';
    _openSheet('Bluetooth Devices', `
      ${btNote}
      <div class="msheet-section-title">Receipt Printer</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:8px">
        Connect to ESC/POS thermal printer via Bluetooth
      </div>
      <button class="msheet-btn-outline" ${btDis} onclick="PosMobile._connectBtPrinter()">📡 Connect Receipt Printer</button>

      <div class="msheet-section-title" style="margin-top:16px">Label Printer</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:8px">
        Connect to Zebra or Brother label printer
      </div>
      <button class="msheet-btn-outline" ${btDis} onclick="PosMobile._connectLabelPrinter()">📡 Connect Label Printer</button>

      <div class="msheet-section-title" style="margin-top:16px">Cash Drawer</div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:8px">
        Connect via printer or standalone Bluetooth relay
      </div>
      <button class="msheet-btn-outline" ${btDis} onclick="PosMobile._connectCashDrawer()">📡 Connect Cash Drawer</button>

      <div id="bt-status" style="margin-top:12px;font-size:12px;color:var(--txt2)"></div>

      <div class="msheet-section-title" style="margin-top:16px">Network Printer</div>
      <div class="msheet-field"><label>Printer IP Address</label>
        <input id="bt-net-ip" class="msheet-input" placeholder="192.168.1.100" type="text" inputmode="numeric"></div>
      <button class="msheet-btn-outline" onclick="PosMobile._connectNetPrinter()">🌐 Connect via Network</button>
    `);
  }

  async function _connectBtPrinter() {
    const status = document.getElementById('bt-status');
    if (!navigator.bluetooth) {
      if (status) { status.style.color = 'var(--amber)'; status.textContent = '⚠ Bluetooth not available — requires Chrome on Android.'; }
      return;
    }
    if (status) { status.style.color = 'var(--txt2)'; status.textContent = 'Searching for Bluetooth printers…'; }
    try {
      await PosPrinter.connectBluetooth();
      if (status) { status.style.color = 'var(--green)'; status.textContent = '✓ Bluetooth printer connected'; }
      if (window.SPos) SPos.toast('✓ Bluetooth printer connected', 'success');
    } catch (e) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ ' + e.message; }
    }
  }

  async function _connectLabelPrinter() {
    const status = document.getElementById('bt-status');
    if (!navigator.bluetooth) {
      if (status) { status.style.color = 'var(--amber)'; status.textContent = '⚠ Bluetooth not available — requires Chrome on Android.'; }
      return;
    }
    if (status) { status.style.color = 'var(--txt2)'; status.textContent = 'Connecting to label printer…'; }
    try {
      await PosPrinter.connectBluetooth();
      if (status) { status.style.color = 'var(--green)'; status.textContent = '✓ Label printer connected'; }
    } catch (e) {
      if (status) { status.style.color = 'var(--red)'; status.textContent = '✗ ' + e.message; }
    }
  }

  async function _connectCashDrawer() {
    const status = document.getElementById('bt-status');

    /* Manager authorization gate — only enforced when requireManagerForCashDrawer is on */
    if (window.ManagerAuth) {
      const cfg = ManagerAuth.getConfig();
      if (cfg.requireManagerForCashDrawer) {
        const ok = await ManagerAuth.request('cash_drawer', {
          cashier: window.state?.currentCashier?.name,
        });
        if (!ok) {
          if (window.SPos) SPos.toast('Cash drawer access denied — authorization required', 'error');
          return;
        }
      }
    }

    if (!navigator.bluetooth) {
      if (status) { status.style.color = 'var(--amber)'; status.textContent = '⚠ Bluetooth not available — requires Chrome on Android.'; }
      return;
    }
    if (status) { status.style.color = 'var(--txt2)'; status.textContent = 'Connecting cash drawer…'; }
    try {
      await PosPrinter.connectBluetooth();
      PosPrinter.openCashDrawer();
      if (window.SPos) SPos.toast('✓ Cash drawer connected & opened', 'success');
    } catch (e) {
      if (window.SPos) SPos.toast('Drawer error: ' + e.message, 'error');
    }
  }

  async function _connectNetPrinter() {
    const ip = document.getElementById('bt-net-ip')?.value?.trim();
    if (!ip) return;
    try {
      await PosPrinter.connectNetwork(ip);
      if (window.SPos) SPos.toast(`✓ Network printer connected at ${ip}`, 'success');
    } catch (e) {
      if (window.SPos) SPos.toast('Network error: ' + e.message, 'error');
    }
  }

  /* ── PWA install ────────────────────────────────────────────── */
  function _showInstallBanner() {
    const existing = document.getElementById('pwa-install-banner');
    if (existing) return;
    const banner = document.createElement('div');
    banner.id = 'pwa-install-banner';
    banner.className = 'pwa-install-banner';
    banner.innerHTML = `
      <div>
        <div style="font-weight:700;font-size:13px">Install Sokoni SmartPOS</div>
        <div style="font-size:11px;color:var(--txt2)">Add to home screen for full-screen mode</div>
      </div>
      <button class="pwa-install-btn" onclick="PosMobile.installApp()">Install</button>
      <button class="pwa-dismiss-btn" onclick="document.getElementById('pwa-install-banner')?.remove()">✕</button>
    `;
    document.body.appendChild(banner);
  }

  async function installApp() {
    if (_installPrompt) {
      _installPrompt.prompt();
      const { outcome } = await _installPrompt.userChoice;
      _installPrompt = null;
      document.getElementById('pwa-install-banner')?.remove();
      if (outcome === 'accepted') {
        if (window.SPos) SPos.toast('App installed successfully!', 'success');
      }
    } else {
      (window._skToast||alert)('To install:\n• iOS Safari: tap Share → Add to Home Screen\n• Android Chrome: tap ⋮ → Add to Home Screen\n• Desktop Chrome: click + in address bar');
    }
  }

  /* ── Cart badge ─────────────────────────────────────────────── */
  function showCartBadge() {
    _cartCount++;
    const badge = document.getElementById('cart-badge');
    if (badge) { badge.textContent = _cartCount; badge.style.display = 'flex'; }
  }

  function resetCartBadge() {
    _cartCount = 0;
    const badge = document.getElementById('cart-badge');
    if (badge) badge.style.display = 'none';
  }

  /* ── Bottom sheet ───────────────────────────────────────────── */
  function _openSheet(title, content) {
    document.getElementById('mobile-sheet-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.id        = 'mobile-sheet-overlay';
    overlay.className = 'mobile-sheet-overlay';
    overlay.onclick   = e => { if (e.target === overlay) closeSheet(); };

    overlay.innerHTML = `
      <div class="mobile-sheet" id="mobile-sheet">
        <div class="mobile-sheet-handle"></div>
        <div class="mobile-sheet-title">${title}</div>
        <div class="mobile-sheet-content">${content}</div>
      </div>
    `;
    document.body.appendChild(overlay);
    requestAnimationFrame(() => overlay.classList.add('open'));
  }

  function closeSheet() {
    const overlay = document.getElementById('mobile-sheet-overlay');
    if (!overlay) return;
    overlay.classList.remove('open');
    setTimeout(() => overlay.remove(), 280);
  }

  /* ── Swipe to navigate ─────────────────────────────────────── */
  function _attachSwipeHandlers() {
    const content = document.querySelector('.pos-content');
    if (!content) return;

    content.addEventListener('touchstart', e => {
      _swipeStart = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    }, { passive: true });

    content.addEventListener('touchend', e => {
      if (!_swipeStart) return;
      const dx = e.changedTouches[0].clientX - _swipeStart.x;
      const dy = e.changedTouches[0].clientY - _swipeStart.y;
      _swipeStart = null;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      /* Swipe right → previous tab, swipe left → next tab */
      const tabs  = ['home', 'pos', 'inventory', 'reports', 'customers'];
      const idx   = tabs.indexOf(_activeTab);
      if (dx < -60 && idx < tabs.length - 1) tab(tabs[idx + 1]);
      if (dx >  60 && idx > 0)               tab(tabs[idx - 1]);
    }, { passive: true });
  }

  /* ── Voice command extensions ──────────────────────────────── */
  function _extendVoice() {
    if (!window.PosVoice) return;

    /* Patch: add mobile-specific intents */
    const _origAsk = PosVoice.ask.bind(PosVoice);

    /* Override with extended ask that handles mobile intents */
    const mobileIntents = [
      { pattern: /create product (.+) price (\d+)/i, handler: async m => {
        await openCreateProduct({ name: m[1], price: parseFloat(m[2]) });
        return `Opening create product for ${m[1]} at KES ${m[2]}.`;
      }},
      { pattern: /(?:open|go to|show) (.+)/i, handler: async m => {
        const tabMap = { home:'home', sell:'pos', stock:'inventory', sales:'reports', customers:'customers', settings:'settings' };
        const target = Object.keys(tabMap).find(k => m[1].toLowerCase().includes(k));
        if (target) { tab(tabMap[target]); return `Opening ${m[1]}.`; }
        return null;
      }},
      { pattern: /(?:bluetooth|printer|connect)/i, handler: async () => {
        openBluetooth(); return 'Opening Bluetooth settings.';
      }},
      { pattern: /(?:install|add to home)/i, handler: async () => {
        installApp(); return 'Opening app install prompt.';
      }},
      { pattern: /(?:dashboard|today|home)/i, handler: async () => {
        tab('home'); return 'Switching to home dashboard.';
      }},
    ];

    /* We can't directly override PosVoice internals — we add hook via existing ask */
    PosVoice.askMobile = async (text) => {
      for (const intent of mobileIntents) {
        const m = text.match(intent.pattern);
        if (m) {
          const result = await intent.handler(m);
          if (result) return { ok: true, text: result };
        }
      }
      return _origAsk(text);
    };
  }

  /* ── Helpers ────────────────────────────────────────────────── */
  function _setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }

  function _esc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

  return {
    /* Readiness — see the note at the end of init(). Reports ONLY that the
       default-panel decision has been made, never which panel won. Present so a
       reader that subscribed after the event still gets a truthful answer. */
    isShellReady: () => _shellReady,
    init, tab, refreshDashboard, openMore, openStockIn, openCreateProduct,
    openProductEdit, showWarranty, openRegisterSerial, openBluetooth, installApp,
    showCartBadge, resetCartBadge, closeSheet,
    _stockSearch, _selectStockIn, _saveStockIn, _saveNewProduct, _updateProduct,
    _deleteProduct, _saveSerial, _toggleShift, _printLabelResult,
    _connectBtPrinter, _connectLabelPrinter, _connectCashDrawer, _connectNetPrinter,
  };
})();

window.PosMobile = PosMobile;


