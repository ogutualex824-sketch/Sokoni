/**
 * sokoni-profile-switcher.js
 * Floating role-switcher widget — drop-in on any dashboard page.
 *
 * Usage: <script src="sokoni-profile-switcher.js" defer></script>
 *
 * The widget auto-hides on pages listed in SKIP_PAGES.
 * It reads accounts/{uid} via onboardingDispatch/onbGetProfiles,
 * then calls onbSwitchRole before navigating to the correct dashboard.
 */
(function () {
  'use strict';

  /* ── Configuration ─────────────────────────────────────────────── */
  const SKIP_PAGES = ['onboarding', 'provider-onboarding', 'login', 'signup', 'forgot-password', 'index'];
  const DASH = {
    buyer:        'index.html',
    merchant:     'pos.html',
    provider:     'provider-dashboard.html',
    freelancer:   'provider-dashboard.html',
    rider:        'rider-dashboard.html',
    driver:       'driver-dashboard.html',
    courier:      'courier-dashboard.html',
    property:     'property-dashboard.html',
    hotel:        'hotel-dashboard.html',
    restaurant:   'restaurant-dashboard.html',
    pharmacy:     'pharmacy-dashboard.html',
    events:       'event-manager.html',
    healthcare:   'healthcare-dashboard.html',
    employer:     'employer-dashboard.html',
    distributor:  'distributor-dashboard.html',
    wholesaler:   'wholesale-portal.html',
    manufacturer: 'manufacturer-dashboard.html',
    ngo:          'ngo-dashboard.html',
    school:       'school-dashboard.html',
    finance:      'finance-dashboard.html'
  };
  const META = {
    buyer:        { icon: '🛍️', label: 'Buyer' },
    merchant:     { icon: '🏪', label: 'Merchant' },
    provider:     { icon: '🔧', label: 'Service Provider' },
    freelancer:   { icon: '🎯', label: 'Freelancer' },
    rider:        { icon: '🛵', label: 'Rider' },
    driver:       { icon: '🚗', label: 'Driver' },
    courier:      { icon: '📦', label: 'Courier' },
    property:     { icon: '🏠', label: 'Property Manager' },
    hotel:        { icon: '🏨', label: 'Hotel' },
    restaurant:   { icon: '🍽️', label: 'Restaurant' },
    pharmacy:     { icon: '💊', label: 'Pharmacy' },
    events:       { icon: '🎟️', label: 'Events' },
    healthcare:   { icon: '🏥', label: 'Healthcare' },
    employer:     { icon: '💼', label: 'Employer' },
    distributor:  { icon: '🚚', label: 'Distributor' },
    wholesaler:   { icon: '🏭', label: 'Wholesaler' },
    manufacturer: { icon: '⚙️', label: 'Manufacturer' },
    ngo:          { icon: '🤝', label: 'NGO' },
    school:       { icon: '🎓', label: 'School' },
    finance:      { icon: '💰', label: 'Finance' }
  };

  /* ── Skip check ─────────────────────────────────────────────────── */
  const _page = location.pathname.split('/').pop().replace('.html', '').toLowerCase();
  if (SKIP_PAGES.some(p => _page === p || _page === '')) return;

  /* ── State ──────────────────────────────────────────────────────── */
  let _open = false;
  let _profiles = [];
  let _currentRole = null;
  let _loaded = false;
  let _switching = false;

  /* ── Inject styles ──────────────────────────────────────────────── */
  const _css = `
    #skSwFab{position:fixed;bottom:76px;right:16px;z-index:8500;width:48px;height:48px;border-radius:50%;background:#71ff00;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:1.3rem;box-shadow:0 4px 18px rgba(113,255,0,.35);transition:transform .2s ease,box-shadow .2s ease;user-select:none}
    #skSwFab:hover{transform:scale(1.08);box-shadow:0 6px 24px rgba(113,255,0,.5)}
    #skSwFab.loading{animation:skSwPulse 1.2s ease-in-out infinite}
    @keyframes skSwPulse{0%,100%{opacity:1}50%{opacity:.5}}
    #skSwPanel{position:fixed;bottom:134px;right:16px;z-index:8499;width:260px;background:#0d0d0d;border:1px solid #1a1a1a;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.7);transform:translateY(10px) scale(.96);opacity:0;pointer-events:none;transition:all .22s cubic-bezier(.4,0,.2,1);overflow:hidden}
    #skSwPanel.vis{transform:translateY(0) scale(1);opacity:1;pointer-events:auto}
    .sk-sw-hdr{padding:12px 14px 8px;border-bottom:1px solid #1a1a1a}
    .sk-sw-hdr-t{font-size:.68rem;color:#666;text-transform:uppercase;letter-spacing:.8px;font-weight:700}
    .sk-sw-hdr-u{font-size:.83rem;color:#e8e8e8;font-weight:600;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sk-sw-list{padding:6px 0;max-height:320px;overflow-y:auto}
    .sk-sw-item{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;transition:background .15s ease;border:none;background:transparent;width:100%;text-align:left}
    .sk-sw-item:hover{background:#141414}
    .sk-sw-item.active{background:#0f1a00}
    .sk-sw-ico{width:34px;height:34px;border-radius:50%;background:#141414;display:flex;align-items:center;justify-content:center;font-size:1rem;flex-shrink:0}
    .sk-sw-item.active .sk-sw-ico{background:rgba(113,255,0,.12)}
    .sk-sw-info{flex:1;min-width:0}
    .sk-sw-nm{font-size:.83rem;font-weight:600;color:#e8e8e8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .sk-sw-item.active .sk-sw-nm{color:#71ff00}
    .sk-sw-id{font-size:.66rem;color:#555;font-weight:500}
    .sk-sw-tick{color:#71ff00;font-size:.9rem;flex-shrink:0}
    .sk-sw-spin{width:14px;height:14px;border:2px solid #1a1a1a;border-top-color:#71ff00;border-radius:50%;animation:skSwSp .8s linear infinite;flex-shrink:0}
    @keyframes skSwSp{to{transform:rotate(360deg)}}
    .sk-sw-foot{border-top:1px solid #1a1a1a;padding:6px 0}
    .sk-sw-add{display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;transition:background .15s ease;border:none;background:transparent;width:100%;text-align:left}
    .sk-sw-add:hover{background:#141414}
    .sk-sw-add-ico{width:34px;height:34px;border-radius:50%;background:#141414;border:1.5px dashed #333;display:flex;align-items:center;justify-content:center;font-size:.9rem;flex-shrink:0}
    .sk-sw-add-nm{font-size:.82rem;font-weight:600;color:#555}
    .sk-sw-empty{padding:18px 14px;font-size:.8rem;color:#555;text-align:center}
    @media(max-width:400px){#skSwPanel{right:8px;width:calc(100vw - 16px);max-width:260px}}
    @media(min-width:769px){#skSwFab{bottom:24px}}
  `;
  const _style = document.createElement('style');
  _style.textContent = _css;
  document.head.appendChild(_style);

  /* ── Build DOM ──────────────────────────────────────────────────── */
  const _fab = document.createElement('button');
  _fab.id = 'skSwFab';
  _fab.title = 'Switch role';
  _fab.setAttribute('aria-label', 'Switch role');
  _fab.innerHTML = '<span id="skSwIco">⚡</span>';

  const _panel = document.createElement('div');
  _panel.id = 'skSwPanel';
  _panel.setAttribute('role', 'dialog');
  _panel.setAttribute('aria-label', 'Switch role');
  _panel.innerHTML = `
    <div class="sk-sw-hdr">
      <div class="sk-sw-hdr-t">SOKONI Account</div>
      <div class="sk-sw-hdr-u" id="skSwUser">Loading…</div>
    </div>
    <div class="sk-sw-list" id="skSwList"><div class="sk-sw-empty">Loading roles…</div></div>
    <div class="sk-sw-foot">
      <button class="sk-sw-add" onclick="SokoniSwitcher.addRole()">
        <div class="sk-sw-add-ico">＋</div>
        <span class="sk-sw-add-nm">Add a role</span>
      </button>
    </div>`;

  document.body.appendChild(_fab);
  document.body.appendChild(_panel);

  /* ── Toggle ─────────────────────────────────────────────────────── */
  function _toggle() {
    _open = !_open;
    _panel.classList.toggle('vis', _open);
    _fab.setAttribute('aria-expanded', String(_open));
    if (_open && !_loaded) _load();
  }

  _fab.addEventListener('click', function (e) { e.stopPropagation(); _toggle(); });
  document.addEventListener('click', function (e) {
    if (_open && !_panel.contains(e.target) && e.target !== _fab) {
      _open = false;
      _panel.classList.remove('vis');
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && _open) { _open = false; _panel.classList.remove('vis'); }
  });

  /* ── Load profiles ──────────────────────────────────────────────── */
  function _load() {
    const u = _getUser();
    if (!u) { _renderGuest(); return; }
    document.getElementById('skSwUser').textContent = u.displayName || u.email || 'Your account';
    _fab.classList.add('loading');

    _call('onbGetProfiles').then(function (r) {
      _fab.classList.remove('loading');
      _loaded = true;
      _profiles = (r && r.profiles) ? r.profiles : [];
      _currentRole = r && r.currentRole ? r.currentRole : null;
      _setFabIcon(_currentRole);
      _renderList();
    }).catch(function () {
      _fab.classList.remove('loading');
      _loaded = true;
      _renderError();
    });
  }

  function _getUser() {
    try { return window.firebaseAuth?.currentUser || null; } catch (e) { return null; }
  }

  function _call(op, data) {
    return window.sokoniCallable('onboardingDispatch')(
      Object.assign({ op: op }, data || {})
    ).then(function (r) { return r.data; });
  }

  /* ── Render ─────────────────────────────────────────────────────── */
  function _setFabIcon(role) {
    const m = role && META[role];
    document.getElementById('skSwIco').textContent = m ? m.icon : '⚡';
  }

  function _renderList() {
    const list = document.getElementById('skSwList');
    if (!_profiles.length) { list.innerHTML = '<div class="sk-sw-empty">No active roles found.<br>Use "Add a role" below.</div>'; return; }

    list.innerHTML = _profiles.map(function (p) {
      const m = META[p.role] || { icon: '👤', label: p.role };
      const active = p.role === _currentRole;
      const pid = p.profileId || '';
      return '<button class="sk-sw-item' + (active ? ' active' : '') + '" '
        + 'onclick="SokoniSwitcher._switch(\'' + _esc(p.role) + '\',\'' + _esc(pid) + '\',this)">'
        + '<div class="sk-sw-ico">' + m.icon + '</div>'
        + '<div class="sk-sw-info">'
        + '<div class="sk-sw-nm">' + _esc(m.label) + '</div>'
        + (pid ? '<div class="sk-sw-id">' + _esc(pid) + '</div>' : '')
        + '</div>'
        + (active ? '<div class="sk-sw-tick">✓</div>' : '')
        + '</button>';
    }).join('');
  }

  function _renderGuest() {
    document.getElementById('skSwUser').textContent = 'Not signed in';
    document.getElementById('skSwList').innerHTML = '<div class="sk-sw-empty">Sign in to see your roles.</div>';
  }

  function _renderError() {
    document.getElementById('skSwList').innerHTML = '<div class="sk-sw-empty">Could not load roles.<br><a href="onboarding.html" style="color:#71ff00">Try signing in again</a></div>';
  }

  function _esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ── Switch role ────────────────────────────────────────────────── */
  function _switch(role, profileId, btn) {
    if (_switching || role === _currentRole) {
      if (role === _currentRole) { _go(role); return; }
      return;
    }
    _switching = true;

    // Show spinner on the item
    const tick = btn.querySelector('.sk-sw-tick');
    const spinner = document.createElement('div');
    spinner.className = 'sk-sw-spin';
    if (tick) tick.replaceWith(spinner);
    else btn.appendChild(spinner);

    _call('onbSwitchRole', { role: role, profileId: profileId || undefined })
      .then(function () {
        _currentRole = role;
        _setFabIcon(role);
        _go(role);
      })
      .catch(function (e) {
        _switching = false;
        spinner.remove();
        if (tick) btn.appendChild(tick);
        console.error('[SokoniSwitcher] switch failed:', e && e.message);
        // Navigate anyway — the dashboard will handle auth state
        _go(role);
      });
  }

  function _go(role) {
    const dest = DASH[role] || 'index.html';
    // Don't navigate if we're already on the correct page
    const cur = location.pathname.split('/').pop() || 'index.html';
    if (cur === dest) { _open = false; _panel.classList.remove('vis'); _switching = false; return; }
    window.location.href = dest;
  }

  /* ── Public API ─────────────────────────────────────────────────── */
  window.SokoniSwitcher = {
    _switch: _switch,
    addRole: function () {
      _open = false;
      _panel.classList.remove('vis');
      window.location.href = 'onboarding.html';
    },
    refresh: function () {
      _loaded = false;
      if (_open) _load();
    },
    setRole: function (role) {
      _currentRole = role;
      _setFabIcon(role);
    }
  };

  /* ── Auto-init on Firebase Auth ready ───────────────────────────── */
  function _init() {
    if (!window.firebaseSDK || !window.firebaseAuth) {
      setTimeout(_init, 200); return;
    }
    window.firebaseSDK.onAuthStateChanged(function (user) {
      if (user) {
        _setFabIcon(_currentRole);
        document.getElementById('skSwUser').textContent = user.displayName || user.email || 'Your account';
        _loaded = false;
      } else {
        _setFabIcon(null);
        _profiles = [];
        _currentRole = null;
        _loaded = true;
        document.getElementById('skSwUser').textContent = 'Not signed in';
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }
})();
