/* sokoni-merchant-success.js — Merchant Success & Growth Engine v1.0
 * Client SDK for merchant-success.html
 * Pattern: IIFE, XSS-safe _esc(), lazy section loading, cached CF results
 */
window.SokoniMerchantSuccess = (() => {
  'use strict';

  // ─── State ──────────────────────────────────────────────────────────────────
  let _uid = null, _shopId = null, _shopName = '';
  let _activeSection = 'dashboard';
  const _loaded = {};        // tracks which sections have loaded
  const _cache  = {};        // CF result cache
  let   _crmAll = [];        // all CRM rows for client-side filter

  // ─── Helpers ────────────────────────────────────────────────────────────────
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function _fmt(n) {
    if (!n && n !== 0) return '—';
    return 'KSh ' + Number(n).toLocaleString('en-KE', { maximumFractionDigits: 0 });
  }

  function _fmtNum(n) {
    if (!n && n !== 0) return '—';
    return Number(n).toLocaleString('en-KE');
  }

  function _timeAgo(ts) {
    if (!ts) return '';
    const ms = typeof ts === 'object' && ts.seconds ? ts.seconds * 1000
              : typeof ts === 'number' ? ts : new Date(ts).getTime();
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff/60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff/3600000) + 'h ago';
    if (diff < 2592000000) return Math.floor(diff/86400000) + 'd ago';
    return new Date(ms).toLocaleDateString('en-KE');
  }

  function _el(id) { return document.getElementById(id); }

  function _set(id, html) {
    const el = _el(id);
    if (el) el.innerHTML = html;
  }

  function _loading(id, text) {
    _set(id, '<div class="mgs-loading">' + _esc(text || 'Loading...') + '</div>');
  }

  function _empty(id, text) {
    _set(id, '<div class="mgs-empty">' + _esc(text || 'No data yet.') + '</div>');
  }

  function _error(id, msg) {
    _set(id, '<div class="mgs-error">⚠ ' + _esc(msg) + '</div>');
  }

  function toast(msg, type) {
    const c = _el('mgsToasts');
    if (!c) return;
    const t = document.createElement('div');
    t.className = 'mgs-toast mgs-toast-' + (type || 'info');
    t.textContent = msg;
    c.appendChild(t);
    requestAnimationFrame(() => t.classList.add('mgs-toast-show'));
    setTimeout(() => {
      t.classList.remove('mgs-toast-show');
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  function _cf(name) {
    /* getInventoryInsights is a SmartPOS op — route via smartPosDispatch. */
    if (name === 'getInventoryInsights') {
      var _d = firebase.functions().httpsCallable('smartPosDispatch');
      return function (data) { return _d(Object.assign({ op: name }, data || {})); };
    }
    return firebase.functions().httpsCallable(name);
  }

  // ─── Auth + Init ────────────────────────────────────────────────────────────
  function init() {
    firebase.auth().onAuthStateChanged(async user => {
      if (!user) {
        window.location.href = 'login.html?redirect=merchant-success.html';
        return;
      }
      _uid = user.uid;
      await _loadShop();
      _initNav();
      _initMobileNav();
      _initSidebarToggle();
      showSection('dashboard');
    });
  }

  async function _loadShop() {
    try {
      const snap = await firebase.firestore()
        .collection('shops')
        .where('sellerUid', '==', _uid)
        .limit(1)
        .get();
      if (!snap.empty) {
        const doc = snap.docs[0];
        _shopId = doc.id;
        _shopName = doc.data().name || 'My Shop';
      } else {
        // Try sellers collection as fallback
        const sSnap = await firebase.firestore()
          .collection('sellers')
          .doc(_uid)
          .get();
        if (sSnap.exists) {
          _shopId = sSnap.data().shopId || _uid;
          _shopName = sSnap.data().shopName || sSnap.data().name || 'My Shop';
        } else {
          _shopId = _uid;
          _shopName = 'My Shop';
        }
      }
      const nameEl = _el('mgsShopName');
      if (nameEl) nameEl.textContent = _shopName;
    } catch (e) {
      console.warn('[MerchantSuccess] shop load failed:', e.message);
      _shopId = _uid;
    }
  }

  // ─── Navigation ─────────────────────────────────────────────────────────────
  function _initNav() {
    document.querySelectorAll('.mgs-nav-item').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.section;
        if (section) showSection(section);
      });
    });
  }

  function _initMobileNav() {
    document.querySelectorAll('.mgs-mobile-nav-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const section = btn.dataset.section;
        if (section) showSection(section);
      });
    });
  }

  function _initSidebarToggle() {
    const btn = _el('mgsSidebarToggle');
    if (btn) btn.addEventListener('click', toggleSidebar);
  }

  function showSection(name) {
    _activeSection = name;

    // Update sidebar active
    document.querySelectorAll('.mgs-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.section === name);
    });

    // Update mobile nav active
    document.querySelectorAll('.mgs-mobile-nav-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.section === name);
    });

    // Show/hide panels
    document.querySelectorAll('.mgs-panel').forEach(panel => {
      const isTarget = panel.id === 'panel-' + name;
      panel.hidden = !isTarget;
      if (isTarget) panel.classList.add('active');
      else panel.classList.remove('active');
    });

    // Close sidebar on mobile
    if (window.innerWidth <= 768) closeSidebar();

    // Lazy load section data
    if (!_loaded[name]) {
      _loaded[name] = true;
      _sectionLoaders[name] && _sectionLoaders[name]();
    }
  }

  const _sectionLoaders = {
    dashboard:    () => { loadHealth(); _loadDashboardKpis(); },
    coach:        () => loadCoach(false),
    opportunities:() => loadOpportunities(),
    customers:    () => loadCRM(),
    inventory:    () => loadInventory(),
    marketing:    () => { loadMarketing(); _initSubtabs(); },
    analytics:    () => loadAnalytics('30d', document.querySelector('[data-period="30d"]')),
    automations:  () => loadAutomations(),
    academy:      () => loadAcademy(),
    benchmarks:   () => loadBenchmarks(),
  };

  function toggleSidebar() {
    const sidebar = _el('mgsSidebar');
    const overlay = _el('mgsSidebarOverlay');
    if (!sidebar) return;
    const open = sidebar.classList.toggle('mgs-sidebar-open');
    if (overlay) overlay.classList.toggle('mgs-overlay-show', open);
  }

  function closeSidebar() {
    const sidebar = _el('mgsSidebar');
    const overlay = _el('mgsSidebarOverlay');
    if (sidebar) sidebar.classList.remove('mgs-sidebar-open');
    if (overlay) overlay.classList.remove('mgs-overlay-show');
  }

  // ─── DASHBOARD ──────────────────────────────────────────────────────────────
  async function loadHealth(force) {
    _loading('mgsHealthDims', 'Calculating health score...');
    _loading('mgsHealthRecs', 'Loading recommendations...');
    try {
      const result = await _cf('getMerchantHealthScore')({ shopId: _shopId, forceRefresh: !!force });
      const data = result.data;
      _cache.health = data;
      _renderHealthScore(data);
      _renderHealthDims(data.dimensions || []);
      _renderHealthRecs(data.recommendations || []);
    } catch (e) {
      _error('mgsHealthDims', 'Could not load health score: ' + e.message);
      _error('mgsHealthRecs', '');
    }
  }

  function refreshHealth(force) {
    loadHealth(true);
    toast('Recalculating health score...', 'info');
  }

  function _renderHealthScore(data) {
    const score = data.score || 0;
    const grade = data.grade || '—';
    const gradeColors = { A: '#4caf50', B: '#8bc34a', C: '#ff9800', D: '#f44336', F: '#9e9e9e' };
    const color = gradeColors[grade] || '#00bcd4';

    // Update score text
    const scoreEl = _el('mgsHealthScore');
    if (scoreEl) {
      scoreEl.textContent = score;
      scoreEl.style.color = color;
    }

    // Update grade
    const gradeEl = _el('mgsHealthGrade');
    if (gradeEl) {
      gradeEl.textContent = grade;
      gradeEl.style.color = color;
    }

    // Animate ring
    const ring = _el('mgsHealthRing');
    if (ring) {
      const circumference = 439.8;
      const offset = circumference * (1 - score / 100);
      ring.style.strokeDashoffset = offset;
      ring.style.stroke = color;
      ring.style.transition = 'stroke-dashoffset 1s ease, stroke 0.5s ease';
    }
  }

  function _renderHealthDims(dims) {
    if (!dims.length) { _empty('mgsHealthDims', 'No data available.'); return; }
    const html = dims.map(d => {
      const pct = Math.round((d.score / d.max) * 100);
      const color = pct >= 80 ? '#4caf50' : pct >= 60 ? '#ff9800' : '#f44336';
      const statusIcon = pct >= 80 ? '✅' : pct >= 60 ? '⚠' : '❌';
      return `<div class="mgs-dim-row">
        <div class="mgs-dim-label">
          <span>${statusIcon} ${_esc(d.name)}</span>
          <span style="color:${color};font-weight:700">${_esc(String(d.score))}/${_esc(String(d.max))}</span>
        </div>
        <div class="mgs-progress-bar" style="margin-top:4px">
          <div class="mgs-progress-fill" style="width:${pct}%;background:${color};transition:width 0.8s ease"></div>
        </div>
      </div>`;
    }).join('');
    _set('mgsHealthDims', html);
  }

  function _renderHealthRecs(recs) {
    if (!recs.length) {
      _set('mgsHealthRecs', '<div class="mgs-empty">🎉 Looking great! Keep it up.</div>');
      return;
    }
    const html = recs.map(r => `
      <div class="mgs-rec-item">
        <div class="mgs-rec-icon">💡</div>
        <div class="mgs-rec-text">${_esc(r)}</div>
      </div>`).join('');
    _set('mgsHealthRecs', html);
  }

  async function _loadDashboardKpis() {
    try {
      const result = await _cf('getMerchantFinancials')({ shopId: _shopId, period: '30d' });
      const d = result.data;
      _set('kpiRevenue30', _fmt(d.revenue));
      _set('kpiOrders30', _fmtNum(d.orderCount));
      _set('kpiAOV', _fmt(d.averageOrderValue));
      _set('kpiCustomers', _fmtNum(d.uniqueCustomers || 0));
    } catch (e) {
      ['kpiRevenue30','kpiOrders30','kpiAOV','kpiCustomers'].forEach(id => _set(id, '—'));
    }
  }

  // ─── AI COACH ───────────────────────────────────────────────────────────────
  async function loadCoach(force) {
    const btn = _el('mgsCoachRefreshBtn');
    _loading('mgsCoachInsights', 'Your AI Coach is analysing your business...');
    if (btn) { btn.disabled = true; btn.textContent = '✨ Generating...'; }
    try {
      const result = await _cf('getAICoachInsights')({ shopId: _shopId });
      const insights = result.data.insights || [];
      _renderCoachInsights(insights);
    } catch (e) {
      _error('mgsCoachInsights', e.message.includes('rate') ? 'You have used all 5 AI insights today. Try again tomorrow.' : 'Could not load AI insights: ' + e.message);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ Get New Insights'; }
    }
  }

  const _priorityColors = { high: '#f44336', medium: '#ff9800', low: '#4caf50' };
  const _categoryIcons  = { sales: '💰', marketing: '📣', operations: '⚙', products: '📦', customers: '👥' };

  function _renderCoachInsights(insights) {
    if (!insights.length) { _empty('mgsCoachInsights', 'No insights available. Click "Get New Insights".'); return; }
    const html = insights.map(i => {
      const pColor = _priorityColors[i.priority] || '#8888aa';
      const catIcon = _categoryIcons[i.category] || '💡';
      return `<div class="mgs-insight-card">
        <div class="mgs-insight-header">
          <span class="mgs-insight-cat">${catIcon} ${_esc(i.category || '')}</span>
          <span class="mgs-insight-priority" style="color:${pColor}">${_esc(i.priority || '')}</span>
        </div>
        <div class="mgs-insight-title">${_esc(i.title || '')}</div>
        <div class="mgs-insight-desc">${_esc(i.description || '')}</div>
      </div>`;
    }).join('');
    _set('mgsCoachInsights', html);
  }

  // ─── OPPORTUNITIES ──────────────────────────────────────────────────────────
  async function loadOpportunities() {
    _loading('mgsOppsList', 'Scanning for opportunities...');
    try {
      const result = await _cf('getMerchantOpportunities')({ shopId: _shopId });
      const opps = result.data.opportunities || [];
      _renderOpps(opps);
    } catch (e) {
      _error('mgsOppsList', 'Could not load opportunities: ' + e.message);
    }
  }

  function _renderOpps(opps) {
    if (!opps.length) { _empty('mgsOppsList', 'No specific opportunities right now. Check back later!'); return; }
    const urgencyColors = { high: '#f44336', medium: '#ff9800', low: '#4caf50' };
    const html = opps.map(o => `
      <div class="mgs-opportunity-card mgs-opp-${_esc(o.urgency || 'low')}">
        <div class="mgs-opp-header">
          <span class="mgs-opp-type">${_esc(o.type || '')}</span>
          <span class="mgs-opp-urgency" style="color:${urgencyColors[o.urgency] || '#8888aa'}">${_esc(o.urgency || '')}</span>
        </div>
        <div class="mgs-opp-title">${_esc(o.title || '')}</div>
        <div class="mgs-opp-desc">${_esc(o.description || '')}</div>
        ${o.action ? `<div class="mgs-opp-action">→ ${_esc(o.action)}</div>` : ''}
        ${o.potentialRevenue ? `<div class="mgs-opp-rev">Potential: ${_fmt(o.potentialRevenue)}</div>` : ''}
      </div>`).join('');
    _set('mgsOppsList', html);
  }

  // ─── CRM ────────────────────────────────────────────────────────────────────
  async function loadCRM() {
    _loading('mgsCrmList', 'Loading customers...');
    try {
      const result = await _cf('getMerchantCRM')({ shopId: _shopId });
      const d = result.data;
      _crmAll = d.customers || [];
      const s = d.stats || {};
      _set('crmTotal',  _fmtNum(s.total || _crmAll.length));
      _set('crmLoyal',  _fmtNum(s.loyal || 0));
      _set('crmAtRisk', _fmtNum(s.atRisk || 0));
      _set('crmCLV',    _fmt(s.avgLifetimeValue || 0));
      _renderCrmList(_crmAll);
    } catch (e) {
      _error('mgsCrmList', 'Could not load customers: ' + e.message);
    }
  }

  function filterCrm(q) {
    const filtered = q
      ? _crmAll.filter(c => (c.name||'').toLowerCase().includes(q.toLowerCase()) || (c.phone||'').includes(q) || (c.email||'').toLowerCase().includes(q.toLowerCase()))
      : _crmAll;
    _renderCrmList(filtered);
  }

  function _renderCrmList(customers) {
    if (!customers.length) { _empty('mgsCrmList', 'No customers found.'); return; }
    const html = customers.map(c => {
      const initials = (c.name || 'C').split(' ').map(w => w[0]).join('').slice(0,2).toUpperCase();
      const seg = c.segment || 'new';
      return `<div class="mgs-customer-row">
        <div class="mgs-cust-avatar" style="background:var(--accent2)">${_esc(initials)}</div>
        <div class="mgs-cust-info">
          <div class="mgs-cust-name">${_esc(c.name || 'Customer')}</div>
          <div class="mgs-cust-meta">${_esc(c.phone || c.email || '')}</div>
        </div>
        <div class="mgs-cust-stats">
          <div class="mgs-cust-orders">${_esc(String(c.orderCount || 0))} orders</div>
          <div class="mgs-cust-spend">${_fmt(c.totalSpent)}</div>
          <div class="mgs-cust-last">${_timeAgo(c.lastOrderDate)}</div>
        </div>
        <span class="mgs-segment-badge mgs-segment-${_esc(seg)}">${_esc(seg.replace('_',' '))}</span>
      </div>`;
    }).join('');
    _set('mgsCrmList', html);
  }

  // ─── INVENTORY ──────────────────────────────────────────────────────────────
  async function loadInventory() {
    _loading('mgsInvAlerts', 'Analysing inventory...');
    try {
      const result = await _cf('getInventoryInsights')({ shopId: _shopId });
      const d = result.data;
      _renderInvSummary(d.summary || {});
      _renderInvAlerts(d.alerts || []);
      _renderInvList(d.products || []);
    } catch (e) {
      _error('mgsInvAlerts', 'Could not load inventory: ' + e.message);
    }
  }

  function _renderInvSummary(s) {
    const items = [
      { label: 'Out of Stock', value: s.outOfStock || 0, color: '#f44336' },
      { label: 'Low Stock',    value: s.lowStock || 0,   color: '#ff9800' },
      { label: 'Fast Sellers', value: s.fastSellers || 0, color: '#4caf50' },
      { label: 'Slow Movers',  value: s.slowMovers || 0,  color: '#8888aa' },
    ];
    const html = items.map(i => `
      <div class="mgs-kpi-card">
        <div class="mgs-kpi-value" style="color:${i.color}">${_esc(String(i.value))}</div>
        <div class="mgs-kpi-label">${_esc(i.label)}</div>
      </div>`).join('');
    _set('mgsInvSummary', html);
  }

  function _renderInvAlerts(alerts) {
    if (!alerts.length) {
      _set('mgsInvAlerts', '<div class="mgs-empty">✅ No inventory alerts right now.</div>');
      return;
    }
    const html = alerts.map(a => `
      <div class="mgs-inv-alert mgs-alert-${_esc(a.urgency || 'low')}">
        <div class="mgs-alert-title">${_esc(a.name || a.issue || '')}</div>
        <div class="mgs-alert-issue">${_esc(a.issue || '')}</div>
        <div class="mgs-alert-rec">→ ${_esc(a.recommendation || '')}</div>
      </div>`).join('');
    _set('mgsInvAlerts', html);
  }

  function _renderInvList(products) {
    if (!products.length) { _empty('mgsInvList', 'No products found.'); return; }
    const statusColors = { 'out_of_stock': '#f44336', 'low_stock': '#ff9800', 'fast_seller': '#4caf50', 'dead_stock': '#9e9e9e', 'overstock': '#7c4dff', 'ok': '#8888aa' };
    const html = `<table class="mgs-table">
      <thead><tr><th>Product</th><th>Qty</th><th>Status</th><th>Price</th></tr></thead>
      <tbody>` +
      products.map(p => {
        const st = p.status || 'ok';
        const color = statusColors[st] || '#8888aa';
        return `<tr>
          <td>${_esc(p.name || '')}</td>
          <td>${_esc(String(p.quantity ?? '—'))}</td>
          <td><span class="mgs-badge" style="background:${color}20;color:${color}">${_esc(st.replace(/_/g,' '))}</span></td>
          <td>${_fmt(p.price)}</td>
        </tr>`;
      }).join('') +
      '</tbody></table>';
    _set('mgsInvList', html);
  }

  // ─── ANALYTICS ──────────────────────────────────────────────────────────────
  async function loadAnalytics(period, btn) {
    // Update active button
    document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');

    _loading('mgsAnalyticsBody', 'Loading analytics...');
    try {
      const result = await _cf('getMerchantFinancials')({ shopId: _shopId, period: period || '30d' });
      const d = result.data;
      _renderAnalytics(d);
    } catch (e) {
      _error('mgsAnalyticsBody', 'Could not load analytics: ' + e.message);
    }
  }

  function _renderAnalytics(d) {
    const kpis = [
      { label: 'Total Revenue',    value: _fmt(d.revenue) },
      { label: 'Orders',           value: _fmtNum(d.orderCount) },
      { label: 'Avg Order Value',  value: _fmt(d.averageOrderValue) },
      { label: 'Net Revenue',      value: _fmt(d.netRevenue) },
      { label: 'Refunds',          value: _fmtNum(d.refunds) },
      { label: 'Cancellations',    value: _fmtNum(d.cancellations) },
      { label: 'Unique Customers', value: _fmtNum(d.uniqueCustomers) },
      { label: 'Customer LTV',     value: _fmt(d.customerLifetimeValue) },
    ];

    const kpiHtml = `<div class="mgs-kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(160px,1fr))">` +
      kpis.map(k => `<div class="mgs-kpi-card">
        <div class="mgs-kpi-value">${_esc(String(k.value))}</div>
        <div class="mgs-kpi-label">${_esc(k.label)}</div>
      </div>`).join('') + '</div>';

    // Top products
    const topProds = (d.topProducts || []).slice(0,5);
    const prodHtml = topProds.length ? `
      <div class="mgs-card" style="margin-top:16px">
        <div class="mgs-card-title">Top Products by Revenue</div>
        <table class="mgs-table"><thead><tr><th>#</th><th>Product</th><th>Revenue</th><th>Orders</th></tr></thead>
        <tbody>` + topProds.map((p,i) => `<tr>
          <td style="color:var(--gold);font-weight:700">${i+1}</td>
          <td>${_esc(p.name || '')}</td>
          <td>${_fmt(p.revenue)}</td>
          <td>${_fmtNum(p.orders)}</td>
        </tr>`).join('') + '</tbody></table></div>' : '';

    // Daily revenue chart
    const daily = d.dailyRevenue || {};
    const days = Object.keys(daily).sort();
    let chartHtml = '';
    if (days.length > 0) {
      const maxVal = Math.max(...days.map(k => daily[k]), 1);
      chartHtml = `<div class="mgs-card" style="margin-top:16px">
        <div class="mgs-card-title">Daily Revenue</div>
        <div class="mgs-bar-chart">` +
        days.slice(-14).map(day => {
          const val = daily[day] || 0;
          const pct = Math.round((val / maxVal) * 100);
          const label = day.slice(5); // MM-DD
          return `<div class="mgs-bar-wrap">
            <div class="mgs-bar" style="height:${pct}%" title="${_esc(day)}: ${_fmt(val)}"></div>
            <div class="mgs-bar-label">${_esc(label)}</div>
          </div>`;
        }).join('') +
        '</div></div>';
    }

    // Peak hours
    const hours = d.peakHours || {};
    const hourKeys = Object.keys(hours).sort((a,b) => Number(a)-Number(b));
    let hoursHtml = '';
    if (hourKeys.length > 0) {
      const maxH = Math.max(...hourKeys.map(k => hours[k]), 1);
      hoursHtml = `<div class="mgs-card" style="margin-top:16px">
        <div class="mgs-card-title">Peak Hours</div>
        <div class="mgs-bar-chart mgs-hours-chart">` +
        hourKeys.map(h => {
          const val = hours[h] || 0;
          const pct = Math.round((val / maxH) * 100);
          const label = Number(h) < 12 ? h + 'am' : (Number(h)===12 ? '12pm' : (Number(h)-12) + 'pm');
          return `<div class="mgs-bar-wrap">
            <div class="mgs-bar" style="height:${pct}%;background:var(--accent2)" title="${_esc(label)}: ${_esc(String(val))} orders"></div>
            <div class="mgs-bar-label">${_esc(label)}</div>
          </div>`;
        }).join('') +
        '</div></div>';
    }

    _set('mgsAnalyticsBody', kpiHtml + prodHtml + chartHtml + hoursHtml);
  }

  // ─── MARKETING ──────────────────────────────────────────────────────────────
  function _initSubtabs() {
    document.querySelectorAll('.mgs-subtab').forEach(tab => {
      tab.addEventListener('click', () => {
        const name = tab.dataset.subtab;
        document.querySelectorAll('.mgs-subtab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.mgs-subtab-content').forEach(c => c.hidden = true);
        tab.classList.add('active');
        const content = document.getElementById('mgs-subtab-' + name);
        if (content) content.hidden = false;
      });
    });
  }

  async function loadMarketing() {
    _loading('mgsCampaignList', 'Loading campaigns...');
    try {
      const result = await _cf('getMinishopCampaigns')({ shopId: _shopId });
      const campaigns = result.data.campaigns || [];
      _renderCampaigns(campaigns);
    } catch (e) {
      _error('mgsCampaignList', 'Could not load campaigns: ' + e.message);
    }
  }

  function _renderCampaigns(campaigns) {
    if (!campaigns.length) {
      _set('mgsCampaignList', `<div class="mgs-empty">No campaigns yet. <button class="mgs-btn mgs-btn-sm mgs-btn-primary" onclick="document.querySelectorAll('.mgs-subtab')[1].click()">Create your first</button></div>`);
      return;
    }
    const html = campaigns.map(c => `
      <div class="mgs-campaign-card">
        <div class="mgs-campaign-header">
          <span class="mgs-campaign-name">${_esc(c.name || '')}</span>
          <span class="mgs-badge" style="background:rgba(0,188,212,.15);color:var(--accent)">${_esc(c.type || '')}</span>
        </div>
        ${c.url ? `<div class="mgs-campaign-url" style="font-size:12px;color:var(--muted);word-break:break-all">${_esc(c.url)}</div>` : ''}
        <div class="mgs-campaign-stats">
          <span>👆 ${_esc(String(c.clicks || 0))} clicks</span>
          <span>📅 ${_timeAgo(c.createdAt)}</span>
        </div>
        ${c.url ? `<button class="mgs-btn mgs-btn-sm" onclick="navigator.clipboard.writeText('${_esc(c.url)}');SokoniMerchantSuccess._toast('Link copied!','success')">📋 Copy Link</button>` : ''}
      </div>`).join('');
    _set('mgsCampaignList', html);
  }

  async function createCampaign() {
    const name = (_el('mgsCampaignName')?.value || '').trim();
    const type = _el('mgsCampaignType')?.value || 'custom';
    const description = (_el('mgsCampaignDesc')?.value || '').trim();
    const startAt  = _el('mgsCampaignStart')?.value;
    const endAt    = _el('mgsCampaignEnd')?.value;

    if (!name) { toast('Please enter a campaign name.', 'error'); return; }

    try {
      await _cf('createMinishopCampaign')({ shopId: _shopId, name, type, description,
        startAt: startAt ? new Date(startAt).getTime() : null,
        endAt:   endAt   ? new Date(endAt).getTime()   : null,
      });
      toast('Campaign created!', 'success');
      // Switch to campaigns tab and reload
      document.querySelectorAll('.mgs-subtab')[0].click();
      delete _loaded.marketing;
      loadMarketing();
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  }

  // ─── AUTOMATIONS ────────────────────────────────────────────────────────────
  async function loadAutomations() {
    _loading('mgsAutoList', 'Loading automations...');
    try {
      const result = await _cf('getMerchantAutomations')({ shopId: _shopId });
      const autos = result.data.automations || [];
      _renderAutomations(autos);
    } catch (e) {
      _error('mgsAutoList', 'Could not load automations: ' + e.message);
    }
  }

  const _autoLabels = {
    low_stock_alert:    { label: 'Low Stock Alert', icon: '📦', desc: 'Notify you when products run low' },
    review_request:     { label: 'Review Request',  icon: '⭐', desc: 'Ask customers for a review after delivery' },
    win_back:           { label: 'Win-Back',         icon: '🔄', desc: 'Re-engage inactive customers' },
    reorder_reminder:   { label: 'Reorder Reminder', icon: '🔔', desc: 'Remind customers to reorder consumables' },
    flash_sale:         { label: 'Flash Sale',       icon: '⚡', desc: 'Schedule automatic discounts' },
  };

  function _renderAutomations(autos) {
    // Render all possible types with enable/disable toggle
    const types = Object.keys(_autoLabels);
    const existingByType = {};
    autos.forEach(a => { existingByType[a.type] = a; });

    const html = types.map(type => {
      const meta = _autoLabels[type];
      const existing = existingByType[type];
      const isActive = existing ? (existing.active !== false) : false;
      return `<div class="mgs-automation-card">
        <div class="mgs-auto-header">
          <div class="mgs-auto-info">
            <span class="mgs-auto-icon">${meta.icon}</span>
            <div>
              <div class="mgs-auto-label">${_esc(meta.label)}</div>
              <div class="mgs-auto-desc" style="font-size:12px;color:var(--muted)">${_esc(meta.desc)}</div>
            </div>
          </div>
          <label class="mgs-toggle-switch">
            <input type="checkbox" ${isActive ? 'checked' : ''} onchange="SokoniMerchantSuccess._toggleAuto('${_esc(type)}',this.checked)">
            <span class="mgs-toggle-slider"></span>
          </label>
        </div>
        ${existing ? `<div class="mgs-auto-status" style="font-size:11px;color:var(--muted);margin-top:6px">Last triggered: ${_timeAgo(existing.lastTriggeredAt)}</div>` : ''}
      </div>`;
    }).join('');
    _set('mgsAutoList', html);
  }

  function showNewAutomation() {
    const form = _el('mgsAutoForm');
    if (form) { form.hidden = false; updateAutoForm('low_stock_alert'); }
  }

  function updateAutoForm(type) {
    const fields = {
      low_stock_alert:   '<label>Alert when quantity below</label><input type="number" id="mgsAutoThreshold" value="5" min="1" style="font-size:16px">',
      review_request:    '<label>Hours after order delivered</label><input type="number" id="mgsAutoDelay" value="24" min="1" max="168" style="font-size:16px">',
      win_back:          '<label>Days customer has been inactive</label><input type="number" id="mgsAutoDays" value="30" min="7" style="font-size:16px">',
      reorder_reminder:  '<label>Days after last purchase</label><input type="number" id="mgsAutoDays" value="14" min="3" style="font-size:16px">',
      flash_sale:        '<label>Discount %</label><input type="number" id="mgsAutoDiscount" value="10" min="1" max="80" style="font-size:16px">',
    };
    _set('mgsAutoConfigFields', `<div class="mgs-form-group">${fields[type] || ''}</div>`);
  }

  async function _toggleAuto(type, active) {
    try {
      await _cf('createMerchantAutomation')({ shopId: _shopId, type, config: { active } });
      toast((active ? '✅ ' : '⏸ ') + (_autoLabels[type]?.label || type) + (active ? ' enabled' : ' paused'), 'info');
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  }

  async function saveAutomation() {
    const type   = _el('mgsAutoType')?.value;
    const message= (_el('mgsAutoMessage')?.value || '').trim();
    const config = { active: true, message };

    if (_el('mgsAutoThreshold')) config.threshold   = parseInt(_el('mgsAutoThreshold').value) || 5;
    if (_el('mgsAutoDelay'))     config.delayHours   = parseInt(_el('mgsAutoDelay').value) || 24;
    if (_el('mgsAutoDays'))      config.daysInactive  = parseInt(_el('mgsAutoDays').value) || 30;
    if (_el('mgsAutoDiscount'))  config.discount      = parseInt(_el('mgsAutoDiscount').value) || 10;

    try {
      await _cf('createMerchantAutomation')({ shopId: _shopId, type, config });
      toast('Automation saved!', 'success');
      const form = _el('mgsAutoForm');
      if (form) form.hidden = true;
      delete _loaded.automations;
      loadAutomations();
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  }

  // ─── ACADEMY ────────────────────────────────────────────────────────────────
  async function loadAcademy() {
    _loading('mgsAcademyModules', 'Loading academy...');
    try {
      const result = await _cf('getMerchantAcademy')({ shopId: _shopId });
      const d = result.data;
      const prog = d.progress || {};
      const pct = prog.percentage || 0;

      _set('mgsAcademyProgressText', `${prog.completed || 0} of ${prog.total || 0} lessons completed`);
      _set('mgsAcademyPct', pct + '%');
      const bar = _el('mgsAcademyBar');
      if (bar) { bar.style.width = '0%'; setTimeout(() => { bar.style.width = pct + '%'; bar.style.transition = 'width 1s ease'; }, 100); }

      _renderAcademyModules(d.modules || [], prog.completedLessons || []);
    } catch (e) {
      _error('mgsAcademyModules', 'Could not load academy: ' + e.message);
    }
  }

  function _renderAcademyModules(modules, completedLessons) {
    if (!modules.length) { _empty('mgsAcademyModules', 'No modules available.'); return; }
    const html = modules.map((mod, mi) => {
      const modLessons = mod.lessons || [];
      const completedCount = modLessons.filter(l => completedLessons.includes(l.id)).length;
      const modPct = modLessons.length ? Math.round(completedCount / modLessons.length * 100) : 0;

      const lessonsHtml = modLessons.map(l => {
        const done = completedLessons.includes(l.id);
        return `<div class="mgs-lesson-row ${done ? 'mgs-lesson-done' : ''}">
          <span class="mgs-lesson-check">${done ? '✅' : '○'}</span>
          <span class="mgs-lesson-title">${_esc(l.title || '')}</span>
          ${!done ? `<button class="mgs-btn mgs-btn-sm" onclick="SokoniMerchantSuccess.completeLesson('${_esc(l.id)}')">Mark Done</button>` : '<span style="color:var(--green);font-size:12px">Done</span>'}
        </div>`;
      }).join('');

      return `<div class="mgs-module-card">
        <div class="mgs-module-header">
          <span class="mgs-module-icon">${_esc(mod.icon || '📚')}</span>
          <div class="mgs-module-meta">
            <div class="mgs-module-title">${_esc(mod.title || '')}</div>
            <div class="mgs-module-progress-text" style="font-size:12px;color:var(--muted)">${completedCount}/${modLessons.length} lessons • ${modPct}%</div>
          </div>
        </div>
        <div class="mgs-progress-bar" style="margin:8px 0">
          <div class="mgs-progress-fill" style="width:${modPct}%;background:var(--accent)"></div>
        </div>
        <div class="mgs-lesson-list">${lessonsHtml}</div>
      </div>`;
    }).join('');
    _set('mgsAcademyModules', html);
  }

  async function completeLesson(lessonId) {
    try {
      await _cf('completeMerchantLesson')({ shopId: _shopId, lessonId });
      toast('✅ Lesson marked complete!', 'success');
      delete _loaded.academy;
      loadAcademy();
    } catch (e) {
      toast('Error: ' + e.message, 'error');
    }
  }

  // ─── BENCHMARKS ─────────────────────────────────────────────────────────────
  async function loadBenchmarks() {
    _loading('mgsBenchmarkBody', 'Loading benchmarks...');
    try {
      const result = await _cf('getMerchantBenchmarks')({ shopId: _shopId });
      const d = result.data;
      _renderBenchmarks(d);
    } catch (e) {
      _error('mgsBenchmarkBody', 'Could not load benchmarks: ' + e.message);
    }
  }

  function _renderBenchmarks(d) {
    const m = d.merchant || {};
    const b = d.benchmark || {};
    const gaps = d.gaps || [];

    const pct = d.percentile || 0;
    const pctColor = pct >= 75 ? '#4caf50' : pct >= 50 ? '#ff9800' : '#f44336';

    let html = `<div class="mgs-card" style="margin-bottom:16px">
      <div class="mgs-card-title">Your Ranking</div>
      <div style="display:flex;align-items:center;gap:24px;flex-wrap:wrap">
        <div style="text-align:center">
          <div style="font-size:48px;font-weight:900;color:${pctColor}">${_esc(String(pct))}%</div>
          <div style="color:var(--muted);font-size:13px">Percentile in ${_esc(m.category || 'your category')}</div>
        </div>
        <div>
          <div>Your Health Score: <strong style="color:var(--accent)">${_esc(String(m.score || '—'))}</strong></div>
          <div>Category Average: <strong>${_esc(String(b.avgScore || '—'))}</strong></div>
          <div>Top 25%: <strong style="color:var(--gold)">${_esc(String(b.topQuartileScore || '—'))}</strong></div>
        </div>
      </div>
      <div class="mgs-progress-bar" style="margin-top:16px;height:10px">
        <div class="mgs-progress-fill" style="width:${pct}%;background:${pctColor};transition:width 1s ease"></div>
      </div>
    </div>`;

    if (gaps.length) {
      html += `<div class="mgs-card">
        <div class="mgs-card-title">Improvement Gaps</div>` +
        gaps.map(g => `<div class="mgs-benchmark-row">
          <div class="mgs-bench-metric">${_esc(g.metric || '')}</div>
          <div class="mgs-bench-vals">
            <span>You: <strong>${_esc(String(g.merchantValue || '—'))}</strong></span>
            <span>Avg: <strong>${_esc(String(g.benchmarkValue || '—'))}</strong></span>
          </div>
          <div class="mgs-bench-rec" style="color:var(--muted);font-size:12px">${_esc(g.recommendation || '')}</div>
        </div>`).join('') + '</div>';
    }

    _set('mgsBenchmarkBody', html);
  }

  // ─── Public API ─────────────────────────────────────────────────────────────
  return {
    init,
    showSection,
    closeSidebar,
    toggleSidebar,
    refreshHealth,
    loadHealth,
    loadCoach,
    loadOpportunities,
    loadCRM,
    filterCrm,
    loadInventory,
    loadAnalytics,
    loadMarketing,
    createCampaign,
    loadAutomations,
    showNewAutomation,
    updateAutoForm,
    saveAutomation,
    loadAcademy,
    completeLesson,
    loadBenchmarks,
    toast,
    _toggleAuto,
    _toast: toast,
  };
})();
