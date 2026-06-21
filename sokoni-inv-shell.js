/**
 * sokoni-inv-shell.js — SOKONI Inventory Enterprise Shell v1.0
 * Shared: sidebar, command palette, theme, notifications, toast, keyboard shortcuts, utilities
 */
(function () {
  'use strict';

  /* ── UTILITIES ────────────────────────────────────────────── */
  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  function fmtCurrency(n) {
    const v = parseFloat(n) || 0;
    if (v >= 1_000_000) return 'KES ' + (v / 1_000_000).toFixed(1) + 'M';
    if (v >= 1_000)     return 'KES ' + (v / 1_000).toFixed(1) + 'K';
    return 'KES ' + v.toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }

  function fmtDate(d) {
    if (!d) return '—';
    const dt = d?.toDate ? d.toDate() : new Date(d);
    return dt.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function fmtRelative(d) {
    if (!d) return '';
    const dt    = d?.toDate ? d.toDate() : new Date(d);
    const diff  = Date.now() - dt.getTime();
    if (diff < 60_000)    return 'just now';
    if (diff < 3_600_000) return Math.floor(diff / 60_000) + 'm ago';
    if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + 'h ago';
    return Math.floor(diff / 86_400_000) + 'd ago';
  }

  function stockClass(available, reorderPoint) {
    if (available <= 0)                  return 'stock-out';
    if (available <= (reorderPoint || 5)) return 'stock-low';
    return 'stock-in';
  }

  function stockLabel(available, reorderPoint) {
    if (available <= 0)                  return 'Out of Stock';
    if (available <= (reorderPoint || 5)) return 'Low Stock';
    return 'In Stock';
  }

  function stockBadgeClass(available, reorderPoint) {
    if (available <= 0)                  return 'inv-badge-danger';
    if (available <= (reorderPoint || 5)) return 'inv-badge-warn';
    return 'inv-badge-success';
  }

  /* ── SIDEBAR ──────────────────────────────────────────────── */
  function toggleSidebar() {
    const sb = document.getElementById('invSidebar');
    if (!sb) return;
    sb.classList.toggle('collapsed');
    localStorage.setItem('inv-sidebar-collapsed', sb.classList.contains('collapsed') ? '1' : '0');
  }

  function openMobileSidebar() {
    document.getElementById('invSidebar')?.classList.add('mobile-open');
    const ov = document.getElementById('sidebarOverlay');
    if (ov) ov.classList.add('visible');
  }

  function closeMobileSidebar() {
    document.getElementById('invSidebar')?.classList.remove('mobile-open');
    const ov = document.getElementById('sidebarOverlay');
    if (ov) ov.classList.remove('visible');
  }

  /* ── THEME ────────────────────────────────────────────────── */
  function applyTheme() {
    const saved = localStorage.getItem('inv-theme') || 'dark';
    document.documentElement.setAttribute('data-theme', saved);
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    const next    = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('inv-theme', next);
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = next === 'dark' ? '☀' : '🌙';
  }

  /* ── COMMAND PALETTE ──────────────────────────────────────── */
  const COMMANDS = [
    { icon:'📦', label:'Dashboard',        desc:'Inventory overview',          href:'inv-dashboard.html',       kbd:'G D' },
    { icon:'📋', label:'Products',         desc:'Product catalogue',            href:'inv-products.html',        kbd:'G P' },
    { icon:'➕', label:'Add Product',      desc:'Create new product',           action:'addProduct',             kbd:'N' },
    { icon:'📑', label:'Purchase Orders',  desc:'View & create POs',            href:'inventory.html#purchases', kbd:'G O' },
    { icon:'🚚', label:'Stock Transfers',  desc:'Transfer between warehouses',  href:'inventory.html#transfers'          },
    { icon:'🚛', label:'Suppliers',        desc:'Supplier directory',           href:'inventory.html#suppliers'          },
    { icon:'📈', label:'Analytics',        desc:'Reports and insights',         href:'inventory.html#analytics'          },
    { icon:'⚠',  label:'Low Stock',        desc:'Items running low',            href:'inv-products.html?filter=low'      },
    { icon:'⌛', label:'Expiring Products',desc:'Batch expiry alerts',          href:'inventory.html#batches'            },
    { icon:'🔍', label:'Audit Log',        desc:'Full audit trail',             href:'inventory.html#audit'              },
    { icon:'🤖', label:'AI Assistant',     desc:'Ask the AI anything',          href:'inv-ai.html',              kbd:'AI' },
    { icon:'☀',  label:'Toggle Theme',     desc:'Switch light / dark mode',     action:'toggleTheme',            kbd:'⌘T' },
    { icon:'⚙',  label:'Settings',         desc:'Inventory settings',           href:'inventory.html#settings'           },
  ];

  let _cmdOpen   = false;
  let _cmdFocusI = 0;

  function openCmdPalette() {
    const ov = document.getElementById('cmdOverlay');
    if (!ov) return;
    ov.classList.add('open');
    _cmdOpen   = true;
    _cmdFocusI = 0;
    const inp = document.getElementById('cmdInput');
    if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 40); }
    _renderCmdResults('');
  }

  function closeCmdPalette(e) {
    if (e && e.target !== document.getElementById('cmdOverlay')) return;
    _closeCmdPalette();
  }

  function _closeCmdPalette() {
    document.getElementById('cmdOverlay')?.classList.remove('open');
    _cmdOpen = false;
  }

  function filterCmdResults() {
    _renderCmdResults(document.getElementById('cmdInput')?.value || '');
  }

  function _renderCmdResults(q) {
    const lower   = q.toLowerCase().trim();
    const matched = lower
      ? COMMANDS.filter(c => c.label.toLowerCase().includes(lower) || c.desc.toLowerCase().includes(lower))
      : COMMANDS;
    const el = document.getElementById('cmdResults');
    if (!el) return;
    if (!matched.length) {
      el.innerHTML = '<div class="inv-empty" style="padding:20px;font-size:13px">No results</div>';
      return;
    }
    el.innerHTML = matched.map((c, i) => `
      <div class="inv-cmd-item${i === 0 ? ' focused' : ''}" onclick="window.invShell.executeCmdItem(${COMMANDS.indexOf(c)})">
        <span class="inv-cmd-item-icon">${c.icon}</span>
        <div style="flex:1;min-width:0">
          <div class="inv-cmd-item-label">${escHtml(c.label)}</div>
          <div class="inv-cmd-item-desc">${escHtml(c.desc)}</div>
        </div>
        ${c.kbd ? `<span class="inv-cmd-item-kbd">${escHtml(c.kbd)}</span>` : ''}
      </div>
    `).join('');
  }

  function executeCmdItem(idx) {
    const cmd = COMMANDS[idx];
    if (!cmd) return;
    _closeCmdPalette();
    if (cmd.action === 'toggleTheme') { toggleTheme(); return; }
    if (cmd.action === 'addProduct')  { (typeof openAddProductModal === 'function' ? openAddProductModal : () => window.location.href = 'inv-products.html#add')(); return; }
    if (cmd.href) { window.location.href = cmd.href; }
  }

  /* ── TOAST ────────────────────────────────────────────────── */
  function showToast(message, type = 'success', duration = 3500) {
    const container = document.getElementById('toastContainer');
    if (!container) return;
    const icons = { success: '✓', warn: '⚠', error: '✕', info: 'ℹ' };
    const el    = document.createElement('div');
    el.className = `inv-toast ${type}`;
    el.innerHTML = `
      <span class="inv-toast-icon">${icons[type] || '•'}</span>
      <span class="inv-toast-msg">${escHtml(message)}</span>
      <span class="inv-toast-close" onclick="this.parentElement.remove()">✕</span>
    `;
    container.appendChild(el);
    setTimeout(() => {
      el.style.cssText += 'opacity:0;transform:translateX(20px);transition:all .25s';
      setTimeout(() => el.remove(), 270);
    }, duration);
  }

  /* ── NOTIFICATIONS ────────────────────────────────────────── */
  function toggleNotifications() {
    const panel = document.getElementById('notifPanel');
    if (!panel) return;
    panel.classList.toggle('open');
  }

  async function loadNotifications() {
    if (!window.SokoniInventory) return;
    try {
      const notifs  = await SokoniInventory.getAlerts().catch(() => []);
      const unread  = notifs.filter(n => !n.read);
      const dot     = document.getElementById('notifDot');
      if (dot) dot.style.display = unread.length ? 'block' : 'none';

      // Low stock badge on sidebar
      const badge = document.getElementById('navLowBadge');
      const low   = notifs.filter(n => n.type === 'low_stock');
      if (badge) { badge.textContent = low.length || ''; badge.style.display = low.length ? 'inline-flex' : 'none'; }

      const list = document.getElementById('notifList');
      if (!list) return;
      list.innerHTML = notifs.length === 0
        ? '<div class="inv-empty" style="padding:24px"><div class="inv-empty-icon">🔔</div><div class="inv-empty-title">All clear</div><div class="inv-empty-desc">No alerts right now.</div></div>'
        : notifs.map(n => `
          <div class="inv-notif-item${n.read ? '' : ' unread'}">
            <div class="inv-notif-dot" style="background:${n.severity === 'critical' || n.type === 'out_of_stock' ? 'var(--danger)' : n.severity === 'warn' || n.type === 'low_stock' ? 'var(--warn)' : 'var(--success)'}"></div>
            <div style="flex:1;min-width:0">
              <div class="inv-notif-title">${escHtml(n.title || n.productName || 'Alert')}</div>
              <div class="inv-notif-desc">${escHtml(n.message || '')}</div>
              <div class="inv-notif-time">${fmtRelative(n.createdAt || n.ts)}</div>
            </div>
          </div>
        `).join('');
    } catch (_) {}
  }

  function markAllRead() {
    if (window.SokoniInventoryV2?.markAllNotifsRead) {
      SokoniInventoryV2.markAllNotifsRead().then(loadNotifications);
    }
    document.getElementById('notifPanel')?.classList.remove('open');
  }

  /* ── KEYBOARD SHORTCUTS ───────────────────────────────────── */
  document.addEventListener('keydown', e => {
    const tag = document.activeElement?.tagName;
    const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || document.activeElement?.isContentEditable;

    if ((e.metaKey || e.ctrlKey) && e.key === 'k') { e.preventDefault(); _cmdOpen ? _closeCmdPalette() : openCmdPalette(); return; }
    if ((e.metaKey || e.ctrlKey) && e.key === 't') { e.preventDefault(); toggleTheme(); return; }

    if (e.key === 'Escape') {
      _closeCmdPalette();
      document.getElementById('notifPanel')?.classList.remove('open');
      closeMobileSidebar();
      return;
    }

    if (_cmdOpen && e.key === 'Enter') {
      const focused = document.querySelector('.inv-cmd-item.focused');
      if (focused) focused.click();
      return;
    }

    if (_cmdOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      const items = document.querySelectorAll('.inv-cmd-item');
      if (!items.length) return;
      items[_cmdFocusI]?.classList.remove('focused');
      _cmdFocusI = e.key === 'ArrowDown'
        ? (_cmdFocusI + 1) % items.length
        : (_cmdFocusI - 1 + items.length) % items.length;
      items[_cmdFocusI]?.classList.add('focused');
      items[_cmdFocusI]?.scrollIntoView({ block: 'nearest' });
      return;
    }

    if (typing) return;
    // G-key shortcuts (two-key combos)
    if (e.key === 'd') { window.location.href = 'inv-dashboard.html'; }
    if (e.key === 'p') { window.location.href = 'inv-products.html'; }
  });

  /* ── INIT ─────────────────────────────────────────────────── */
  function initShell() {
    applyTheme();

    // Restore sidebar collapsed state
    if (localStorage.getItem('inv-sidebar-collapsed') === '1') {
      document.getElementById('invSidebar')?.classList.add('collapsed');
    }

    // Mark active nav item
    const current = window.location.pathname.split('/').pop().replace('.html', '');
    document.querySelectorAll('.inv-nav-item[href]').forEach(item => {
      const href = item.getAttribute('href') || '';
      const name = href.split('/').pop().split('?')[0].split('#')[0].replace('.html', '');
      if (name === current || (current === '' && name === 'inv-dashboard')) {
        item.classList.add('active');
      }
    });

    // Theme button icon
    const btn = document.getElementById('themeBtn');
    if (btn) btn.textContent = (localStorage.getItem('inv-theme') || 'dark') === 'dark' ? '☀' : '🌙';

    // Load notifications after auth ready
    window.addEventListener('invReady', loadNotifications, { once: true });

    // Auto-show sidebar on wide screens
    if (window.innerWidth < 769) {
      document.getElementById('invSidebar')?.classList.remove('collapsed');
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initShell);
  } else {
    initShell();
  }

  /* ── EXPOSE API ───────────────────────────────────────────── */
  window.invShell = {
    toggleSidebar, openMobileSidebar, closeMobileSidebar,
    toggleTheme, applyTheme,
    openCmdPalette, closeCmdPalette, filterCmdResults, executeCmdItem,
    showToast, toggleNotifications, loadNotifications, markAllRead,
    escHtml, fmtCurrency, fmtDate, fmtRelative,
    stockClass, stockLabel, stockBadgeClass,
  };

  // Also expose top-level so onclick="" attributes work without prefix
  window.toggleSidebar     = toggleSidebar;
  window.openMobileSidebar = openMobileSidebar;
  window.closeMobileSidebar= closeMobileSidebar;
  window.toggleTheme       = toggleTheme;
  window.openCmdPalette    = openCmdPalette;
  window.closeCmdPalette   = closeCmdPalette;
  window.filterCmdResults  = filterCmdResults;
  window.showToast         = showToast;
  window.toggleNotifications = toggleNotifications;
  window.markAllRead       = markAllRead;
  window.escHtml           = escHtml;
  window.fmtCurrency       = fmtCurrency;
  window.fmtDate           = fmtDate;
  window.fmtRelative       = fmtRelative;
  window.stockClass        = stockClass;
  window.stockLabel        = stockLabel;

})();
