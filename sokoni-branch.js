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
    _syncBranchesToFirestore(arr);
  }

  /* Mirror branches onto the seller's OWN Firestore doc (sellers/{uid}.branches).
     localStorage alone is per-device and invisible to buyers; an owned copy in
     Firestore is what gives each branch a public, shareable storefront URL
     (store.html?id=<uid>&branch=<id>) and lets the owner's profile list them.
     Best-effort and fire-and-forget: a branch write must never block the POS.
     firestore.rules permits an owner (auth.uid == uid) to update non-admin
     fields, so this only persists when the shop OWNER manages branches — the
     correct constraint. */
  function _cleanBranches(arr) {
    return (arr || []).map(function (b) {
      return {
        id:      String(b.id || ''),
        name:    String(b.name || ''),
        address: String(b.address || ''),
        phone:   String(b.phone || ''),
        isMain:  !!b.isMain,
      };
    });
  }

  function _syncBranchesToFirestore(arr) {
    try {
      var u   = JSON.parse(localStorage.getItem('sokoniUser') || 'null');
      var uid = u && (u.uid || u.id);
      if (!uid) return;                       /* not signed in — nothing to own */
      var clean = _cleanBranches(arr);

      /* Prefer the compat SDK when a page provides it (POS pages are compat and
         expose firebase.firestore()), and fall back to the modular window
         handle otherwise. This is why sync "just works" on both kinds of page
         instead of silently no-opping on the POS. */
      if (global.firebase && global.firebase.firestore) {
        try {
          global.firebase.firestore().collection('sellers').doc(String(uid))
            .set({ branches: clean, updatedAt: new Date() }, { merge: true })
            .catch(function () {});
          return;
        } catch (e) { /* fall through to modular */ }
      }

      /* Modular path — window.firebaseDB may publish a moment after this fires,
         so retry briefly rather than dropping the write. */
      var tries = 0;
      (function attempt() {
        var db = global.firebaseDB;
        if (!db) {
          if (tries++ < 40) { setTimeout(attempt, 150); }
          return;
        }
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js')
          .then(function (m) {
            m.setDoc(m.doc(db, 'sellers', String(uid)),
              { branches: clean, updatedAt: m.serverTimestamp() }, { merge: true })
              .catch(function () {});
          })
          .catch(function () {});
      })();
    } catch (e) { /* never let branch persistence break the POS */ }
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
    _resetForm();   /* never carry an edit-in-progress into the next open */
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
          '<div id="so-bm-form-title" style="font-size:10px;font-weight:900;color:rgba(255,255,255,0.25);',
            'text-transform:uppercase;letter-spacing:.09em;margin-bottom:10px;">Add Branch</div>',
          '<div style="display:flex;flex-direction:column;gap:8px;">',
            '<input id="so-bm-new-name" placeholder="Branch name (e.g. Westlands)" autocomplete="off" ',
              'style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);',
              'border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;',
              'font-size:16px;outline:none;font-family:inherit;">',
            /* Address + phone: each branch is its own storefront, so these are
               what store.html?branch= shows as the location details. */
            '<input id="so-bm-new-address" placeholder="Address / area (e.g. Kimathi St, CBD)" autocomplete="off" ',
              'style="width:100%;padding:12px 14px;background:rgba(255,255,255,0.06);',
              'border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;',
              'font-size:16px;outline:none;font-family:inherit;">',
            '<div style="display:flex;gap:8px;">',
              '<input id="so-bm-new-phone" placeholder="Branch phone (optional)" autocomplete="off" inputmode="tel" ',
                'style="flex:1;padding:12px 14px;background:rgba(255,255,255,0.06);',
                'border:1px solid rgba(255,255,255,0.1);border-radius:10px;color:white;',
                'font-size:16px;outline:none;font-family:inherit;" ',
                'onkeydown="if(event.key===\'Enter\')SokoniBranch.addBranch()">',
              '<button id="so-bm-add-btn" onclick="SokoniBranch.addBranch()" ',
                'style="padding:12px 16px;background:rgba(113,255,0,0.12);',
                'border:1px solid rgba(113,255,0,0.3);color:#71ff00;border-radius:10px;',
                'font-weight:800;font-size:13px;cursor:pointer;font-family:inherit;',
                'white-space:nowrap;min-height:44px;">+ Add</button>',
            '</div>',
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
          '<div style="min-width:0;flex:1;">',
            '<div style="font-size:14px;font-weight:800;color:' + (isActive ? '#71ff00' : 'white') + ';',
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">',
              _esc(b.name),
            '</div>',
            b.address
              ? '<div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">📍 ' + _esc(b.address) + '</div>'
              : (b.isMain ? '<div style="font-size:10px;color:rgba(255,255,255,0.3);margin-top:2px;">Headquarters</div>' : ''),
          '</div>',
          '<div style="display:flex;align-items:center;gap:6px;flex-shrink:0;margin-left:10px;">',
            isActive ? '<span style="color:#71ff00;font-size:18px;" aria-label="selected">✓</span>' : '',
            /* Edit is available for every branch (incl. the main one, so its
               address/phone can be set); Remove only for non-main branches. */
            '<button onclick="event.stopPropagation();SokoniBranch.editBranch(\'' + b.id + '\')" ' +
              'style="background:rgba(113,255,0,0.08);border:1px solid rgba(113,255,0,0.22);' +
              'color:#71ff00;border-radius:8px;padding:6px 11px;font-size:11px;font-weight:800;' +
              'cursor:pointer;font-family:inherit;min-height:36px;" aria-label="Edit ' + _esc(b.name) + '">Edit</button>',
            (!b.isMain
              ? '<button onclick="event.stopPropagation();SokoniBranch.removeBranch(\'' + b.id + '\')" ' +
                'style="background:rgba(255,60,60,0.08);border:1px solid rgba(255,60,60,0.2);' +
                'color:#ff6464;border-radius:8px;padding:6px 11px;font-size:11px;font-weight:800;' +
                'cursor:pointer;font-family:inherit;min-height:36px;" ' +
                'aria-label="Remove ' + _esc(b.name) + '">Remove</button>'
              : ''),
          '</div>',
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

  var _editingId = null;   /* set while the form is editing an existing branch */

  function addBranch() {
    var nameEl = document.getElementById('so-bm-new-name');
    var addrEl = document.getElementById('so-bm-new-address');
    var phoneEl= document.getElementById('so-bm-new-phone');
    var name   = (nameEl && nameEl.value.trim()) || '';
    var address= (addrEl && addrEl.value.trim()) || '';
    var phone  = (phoneEl && phoneEl.value.trim()) || '';
    if (!name) { if (nameEl) nameEl.focus(); return; }
    var branches = _getBranches();
    /* Prevent duplicate names (ignoring the branch being edited). */
    if (branches.some(function (b) {
      return b.id !== _editingId && b.name.toLowerCase() === name.toLowerCase();
    })) {
      if (nameEl) { nameEl.style.borderColor = '#ff6464'; nameEl.focus(); } return;
    }
    if (_editingId) {
      /* Edit in place — keep id/isMain, update the editable fields. */
      branches = branches.map(function (b) {
        return b.id === _editingId ? Object.assign({}, b, { name: name, address: address, phone: phone }) : b;
      });
    } else {
      var biz = localStorage.getItem('sokoniBizName') ||
                localStorage.getItem('posBizName') || 'My Business';
      branches.push({ id: 'branch_' + Date.now(), name: name, address: address, phone: phone, biz: biz, isMain: false });
    }
    _saveBranches(branches);
    _resetForm();
    var modal = document.getElementById('so-branch-modal');
    if (modal) _fillList(modal);
  }

  /* Load a branch into the form for editing. */
  function editBranch(id) {
    var b = _getBranches().find(function (x) { return x.id === id; });
    if (!b) return;
    _editingId = id;
    var nameEl = document.getElementById('so-bm-new-name');
    var addrEl = document.getElementById('so-bm-new-address');
    var phoneEl= document.getElementById('so-bm-new-phone');
    var title  = document.getElementById('so-bm-form-title');
    var btn    = document.getElementById('so-bm-add-btn');
    if (nameEl)  { nameEl.value  = b.name || '';    nameEl.style.borderColor = ''; nameEl.focus(); }
    if (addrEl)  addrEl.value  = b.address || '';
    if (phoneEl) phoneEl.value = b.phone || '';
    if (title)   title.textContent = 'Edit Branch';
    if (btn)     btn.textContent = 'Save';
  }

  function _resetForm() {
    _editingId = null;
    var nameEl = document.getElementById('so-bm-new-name');
    var addrEl = document.getElementById('so-bm-new-address');
    var phoneEl= document.getElementById('so-bm-new-phone');
    var title  = document.getElementById('so-bm-form-title');
    var btn    = document.getElementById('so-bm-add-btn');
    if (nameEl)  { nameEl.value  = ''; nameEl.style.borderColor = ''; }
    if (addrEl)  addrEl.value  = '';
    if (phoneEl) phoneEl.value = '';
    if (title)   title.textContent = 'Add Branch';
    if (btn)     btn.textContent = '+ Add';
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
    editBranch:    editBranch,
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
