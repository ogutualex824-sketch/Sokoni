/* ═══════════════════════════════════════════════════════════════════
   SOKONI BRANCH MANAGER  v1.0
   Canonical single-source-of-truth for branch state.
   Shared by seller.html, pos.html, inventory, reports, employees.
   Fires 'soBranchChanged' CustomEvent on every switch so all
   page sections can react without polling.
═══════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var STORE_KEY   = 'sokoniBranches';
  var CURRENT_KEY = 'sokoniCurrentBranch';

  /* ── Storage helpers ───────────────────────────────────────────── */
  function _getBranches() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
  }
  function _saveBranches(arr) {
    localStorage.setItem(STORE_KEY, JSON.stringify(arr));
  }
  function _getCurrent() {
    try { return JSON.parse(localStorage.getItem(CURRENT_KEY) || 'null'); } catch (e) { return null; }
  }
  function _persist(branch) {
    localStorage.setItem(CURRENT_KEY, JSON.stringify(branch));
    global._currentBranchId   = branch ? branch.id   : null;
    global._currentBranchName = branch ? branch.name : null;
  }

  /* ── Init ──────────────────────────────────────────────────────── */
  function init() {
    var branches = _getBranches();
    if (!branches.length) {
      var biz = localStorage.getItem('sokoniBizName') ||
                localStorage.getItem('posBizName')    || 'My Business';
      branches = [{ id: 'main', name: 'Main Branch', biz: biz, isMain: true }];
      _saveBranches(branches);
    }
    if (!_getCurrent()) _persist(branches[0]);
    else                _persist(_getCurrent()); /* sync globals */
    _updateLabels();
  }

  /* ── Event ─────────────────────────────────────────────────────── */
  function _fire(branch) {
    document.dispatchEvent(new CustomEvent('soBranchChanged', {
      bubbles: true,
      detail: { branch: branch, id: branch.id, name: branch.name }
    }));
  }

  /* ── Label sync ────────────────────────────────────────────────── */
  function _updateLabels() {
    var current = _getCurrent();
    var name = current ? current.name : 'Main Branch';
    document.querySelectorAll('.so-branch-label').forEach(function (el) {
      el.textContent = name;
    });
    /* POS-specific element */
    var posEl = document.getElementById('branch-name-text');
    if (posEl) posEl.textContent = name;
  }

  /* ── Switcher renderer ─────────────────────────────────────────── */
  function renderSwitcher(containerId) {
    var container = typeof containerId === 'string'
      ? document.getElementById(containerId) : containerId;
    if (!container) return;
    var current = _getCurrent() || { name: 'Main Branch' };
    container.innerHTML =
      '<button class="so-branch-switcher" onclick="SokoniBranch.openPicker()" ' +
      'aria-label="Switch branch" title="Switch branch">' +
      '<span class="so-branch-icon" aria-hidden="true">🏢</span>' +
      '<span class="so-branch-label">' + _esc(current.name) + '</span>' +
      '<span class="so-branch-caret" aria-hidden="true">▼</span>' +
      '</button>';
  }

  /* ── Modal ─────────────────────────────────────────────────────── */
  function openPicker() {
    var modal = document.getElementById('so-branch-modal');
    if (!modal) { _buildModal(); modal = document.getElementById('so-branch-modal'); }
    _fillList(modal);
    modal.style.display = 'flex';
    /* Prevent body scroll */
    document.body.style.overflow = 'hidden';
  }

  function closePicker() {
    var modal = document.getElementById('so-branch-modal');
    if (modal) modal.style.display = 'none';
    document.body.style.overflow = '';
  }

  function _buildModal() {
    var m = document.createElement('div');
    m.id = 'so-branch-modal';
    m.setAttribute('role', 'dialog');
    m.setAttribute('aria-modal', 'true');
    m.setAttribute('aria-label', 'Select branch');
    m.style.cssText = [
      'display:none;position:fixed;inset:0;z-index:var(--sk-z-sheet,100010);',
      'background:rgba(0,0,0,0.78);backdrop-filter:blur(8px);',
      'align-items:flex-end;justify-content:center;',
      'padding-bottom:env(safe-area-inset-bottom);'
    ].join('');
    m.innerHTML = [
      '<div style="background:#111;border:1px solid rgba(255,255,255,0.1);',
        'border-radius:20px 20px 0 0;width:100%;max-width:520px;',
        'padding:24px 20px;max-height:85vh;overflow-y:auto;',
        '-webkit-overflow-scrolling:touch;">',
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:20px;">',
          '<div>',
            '<div style="font-size:16px;font-weight:900;color:white;">Select Branch</div>',
            '<div id="so-bm-biz" style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:2px;"></div>',
          '</div>',
          '<button onclick="SokoniBranch.closePicker()" aria-label="Close" ',
            'style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);',
            'color:rgba(255,255,255,0.5);border-radius:8px;padding:8px 14px;cursor:pointer;',
            'font-size:14px;line-height:1;min-width:44px;min-height:44px;">✕</button>',
        '</div>',
        '<div id="so-bm-list" style="margin-bottom:20px;"></div>',
        '<div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;">',
          '<div style="font-size:10px;font-weight:900;color:rgba(255,255,255,0.25);',
            'text-transform:uppercase;letter-spacing:.09em;margin-bottom:10px;">Add Branch</div>',
          '<div style="display:flex;gap:8px;">',
            '<input id="so-bm-new-name" placeholder="Branch name (e.g. Westlands)" autocomplete="off" ',
              'style="flex:1;padding:12px 14px;background:rgba(255,255,255,0.06);',
              'border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;',
              'font-size:16px;outline:none;font-family:inherit;" ',
              'onkeydown="if(event.key===\'Enter\')SokoniBranch.addBranch()">',
            '<button onclick="SokoniBranch.addBranch()" ',
              'style="padding:12px 16px;background:rgba(113,255,0,0.12);',
              'border:1px solid rgba(113,255,0,0.3);color:#71ff00;border-radius:10px;',
              'font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;',
              'white-space:nowrap;min-height:44px;">+ Add</button>',
          '</div>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(m);
    /* Close on backdrop click */
    m.addEventListener('click', function (e) { if (e.target === m) closePicker(); });
    /* Close on Escape */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && m.style.display === 'flex') closePicker();
    });
  }

  function _fillList(modal) {
    var branches = _getBranches();
    var current  = _getCurrent();
    var biz      = localStorage.getItem('sokoniBizName') ||
                   localStorage.getItem('posBizName') || 'My Business';
    var bizEl = document.getElementById('so-bm-biz');
    if (bizEl) bizEl.textContent = biz;
    var list = document.getElementById('so-bm-list');
    if (!list) return;
    list.innerHTML = branches.map(function (b) {
      var isActive = current && current.id === b.id;
      return [
        '<div onclick="SokoniBranch.select(\'' + b.id + '\')" ',
          'style="display:flex;align-items:center;justify-content:space-between;',
          'padding:14px 16px;border-radius:12px;cursor:pointer;margin-bottom:8px;',
          'background:' + (isActive ? 'rgba(113,255,0,0.1)' : 'rgba(255,255,255,0.04)') + ';',
          'border:1px solid ' + (isActive ? 'rgba(113,255,0,0.3)' : 'rgba(255,255,255,0.08)') + ';',
          'transition:background .12s;min-height:52px;">',
          '<div>',
            '<div style="font-size:14px;font-weight:800;color:' + (isActive ? '#71ff00' : 'white') + ';">',
              _esc(b.name),
            '</div>',
            b.isMain ? '<div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:2px;">Headquarters</div>' : '',
          '</div>',
          isActive
            ? '<span style="color:#71ff00;font-size:20px;" aria-label="selected">✓</span>'
            : (!b.isMain
              ? '<button onclick="event.stopPropagation();SokoniBranch.removeBranch(\'' + b.id + '\')" ' +
                'style="background:rgba(255,60,60,0.08);border:1px solid rgba(255,60,60,0.2);' +
                'color:#ff6464;border-radius:8px;padding:6px 12px;font-size:11px;font-weight:800;' +
                'cursor:pointer;font-family:inherit;min-height:36px;" ' +
                'aria-label="Remove ' + _esc(b.name) + '">Remove</button>'
              : ''),
        '</div>'
      ].join('');
    }).join('');
  }

  /* ── Core CRUD ─────────────────────────────────────────────────── */
  function select(id) {
    var branches = _getBranches();
    var branch   = branches.find(function (b) { return b.id === id; });
    if (!branch) return;
    _persist(branch);
    _updateLabels();
    closePicker();
    _fire(branch);
  }

  function addBranch() {
    var input = document.getElementById('so-bm-new-name');
    var name  = (input && input.value.trim()) || '';
    if (!name) { if (input) input.focus(); return; }
    var branches = _getBranches();
    /* Prevent duplicate names */
    if (branches.some(function (b) { return b.name.toLowerCase() === name.toLowerCase(); })) {
      if (input) { input.style.borderColor = '#ff6464'; input.focus(); } return;
    }
    var biz = localStorage.getItem('sokoniBizName') ||
              localStorage.getItem('posBizName') || 'My Business';
    branches.push({ id: 'branch_' + Date.now(), name: name, biz: biz, isMain: false });
    _saveBranches(branches);
    if (input) { input.value = ''; input.style.borderColor = ''; }
    var modal = document.getElementById('so-branch-modal');
    if (modal) _fillList(modal);
  }

  function removeBranch(id) {
    var branches = _getBranches().filter(function (b) { return b.id !== id; });
    _saveBranches(branches);
    var current = _getCurrent();
    if (current && current.id === id) {
      var fallback = branches[0] || null;
      if (fallback) { _persist(fallback); _updateLabels(); _fire(fallback); }
    }
    var modal = document.getElementById('so-branch-modal');
    if (modal) _fillList(modal);
  }

  /* ── XSS helper ────────────────────────────────────────────────── */
  function _esc(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ── Public API ────────────────────────────────────────────────── */
  global.SokoniBranch = {
    init:          init,
    openPicker:    openPicker,
    closePicker:   closePicker,
    select:        select,
    addBranch:     addBranch,
    removeBranch:  removeBranch,
    renderSwitcher: renderSwitcher,
    getCurrent:    _getCurrent,
    getBranches:   _getBranches
  };

  /* Auto-init */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

}(window));
