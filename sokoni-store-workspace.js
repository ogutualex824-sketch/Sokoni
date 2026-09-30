/* ════════════════════════════════════════════════════════════════════════════
   SOKONI STORE — operator workspace (merchant-v2.html?store=sokoni)
   sokoni-store-workspace.js

   Owner decision 2026-10-01: the SOKONI Store is owned by its company account and
   operated by ONE named operator. Admin / superAdmin claims grant nothing.

   THE SERVER DECIDES. `?store=sokoni` REQUESTS the store; it authorises nothing.
   The first and only call before anything is rendered is sokoniStoreGetContext,
   which checks the caller against a server-only operator record. Two outcomes:
     · served  → the workspace (profile + contact phone, products, orders, wallet);
     · refused → "Access denied — the SOKONI Store is operated by its owner", and
                 NO further store call is made.
   Nothing from the store is rendered until the server has said yes, so a denied
   admin never sees a flash of store data. The merchant shell does not boot in
   this mode (merchant-v2.html), so the operator's OWN shop is never loaded here.

   Unknown renders "—", never 0. No success message before the server confirms.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var DENIED_TEXT = 'Access denied — the SOKONI Store is operated by its owner';

  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /** Unknown stays unknown. A real canonical 0 renders as 0. */
  function money (v) {
    return (typeof v === 'number' && isFinite(v)) ? 'KES ' + v.toLocaleString('en-KE') : '—';
  }
  function num (v) { return (typeof v === 'number' && isFinite(v)) ? String(v) : '—'; }
  /** Last three digits only. */
  function maskTail (v) {
    var d = String(v == null ? '' : v).replace(/\D/g, '');
    return d.length >= 3 ? '••• ' + d.slice(-3) : null;
  }
  function when (ms) {
    if (typeof ms !== 'number') return '—';
    try { return new Date(ms).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }); } catch (_) { return '—'; }
  }

  /* ── PURE RENDERERS (also driven by the static suite) ───────────────────── */
  function renderLoading () {
    return '<section class="sks-card sks-center" aria-busy="true"><p class="sks-muted">Checking access…</p></section>';
  }

  function renderDenied (kind) {
    var sub = kind === 'signed-out'
      ? 'Sign in with the store operator\'s account to continue.'
      : (kind === 'unavailable'
        ? 'The SOKONI Store could not be verified right now. Nothing was loaded.'
        : 'Only the store\'s named operator can open this workspace. Administrator access does not include it.');
    return '<section class="sks-card sks-denied" role="alert" data-sks-state="denied">' +
      '<div class="sks-denied-icon" aria-hidden="true">&#x1F512;</div>' +
      '<h1 class="sks-h1">' + esc(kind === 'unavailable' ? 'SOKONI Store unavailable' : DENIED_TEXT) + '</h1>' +
      '<p class="sks-muted">' + esc(sub) + '</p>' +
      '<a class="sks-btn" href="admin-os.html">Back to AdminOS</a>' +
      '</section>';
  }

  function renderWorkspace (ctx) {
    var p = (ctx && ctx.profile) || {};
    var dest = ctx && ctx.payoutDestination;
    var masked = dest && dest.status === 'set' ? maskTail(dest.masked || dest.value) : null;
    return '<div class="sks-wrap" data-sks-state="workspace">' +
      '<header class="sks-head"><div><h1 class="sks-h1">SOKONI Store</h1>' +
      '<p class="sks-muted">Operated workspace · ' + esc(ctx.businessName || 'SOKONI Store') + '</p></div></header>' +

      '<section class="sks-card" aria-labelledby="sks-prof-h"><h2 class="sks-h2" id="sks-prof-h">Store profile</h2>' +
      '<form id="sks-profile" class="sks-form" novalidate>' +
      '<label class="sks-field"><span>Store name</span><input name="name" maxlength="120" value="' + esc(p.name || '') + '" autocomplete="off"></label>' +
      '<label class="sks-field"><span>Contact phone <small class="sks-muted">(shown to buyers)</small></span>' +
      '<input name="phone" type="tel" inputmode="tel" maxlength="16" placeholder="0705 726 803" value="' + esc(p.phone || '') + '" autocomplete="off"></label>' +
      '<label class="sks-field"><span>Email</span><input name="email" type="email" maxlength="160" value="' + esc(p.email || '') + '" autocomplete="off"></label>' +
      '<label class="sks-field"><span>Tagline</span><input name="tagline" maxlength="160" value="' + esc(p.tagline || '') + '" autocomplete="off"></label>' +
      '<label class="sks-field"><span>City</span><input name="city" maxlength="80" value="' + esc(p.city || '') + '" autocomplete="off"></label>' +
      '<div class="sks-row"><button type="submit" class="sks-btn sks-primary" id="sks-save">Save profile</button>' +
      '<span class="sks-status" id="sks-prof-status" role="status" aria-live="polite"></span></div>' +
      '</form></section>' +

      '<section class="sks-card" aria-labelledby="sks-wal-h"><h2 class="sks-h2" id="sks-wal-h">Store wallet</h2>' +
      '<div id="sks-wallet"><p class="sks-muted">Loading…</p></div>' +
      '<div class="sks-payout"><div><strong>Payout number</strong><div class="sks-muted" id="sks-payout-val">' +
      (masked ? esc(masked) : 'Not set') + '</div></div>' +
      '<button type="button" class="sks-btn" id="sks-payout-btn" ' + (dest && dest.status === 'available' ? '' : 'disabled aria-disabled="true"') + '>Set payout number</button></div>' +
      (dest && dest.status === 'unavailable'
        ? '<p class="sks-note">The PIN-protected payout flow is not yet available for the store wallet. The payout number cannot be set here until it is.</p>'
        : '') +
      '</section>' +

      '<section class="sks-card" aria-labelledby="sks-ord-h"><h2 class="sks-h2" id="sks-ord-h">Orders</h2><div id="sks-orders"><p class="sks-muted">Loading…</p></div></section>' +
      '<section class="sks-card" aria-labelledby="sks-prod-h"><h2 class="sks-h2" id="sks-prod-h">Products</h2><div id="sks-products"><p class="sks-muted">Loading…</p></div></section>' +
      '</div>';
  }

  function renderWallet (w) {
    var s = (w && w.storeWallet) || {};
    if (!s.exists) {
      return '<p class="sks-muted">The store wallet has not been created yet.</p>' +
        '<dl class="sks-kv"><dt>Balance</dt><dd>—</dd></dl>';
    }
    return '<dl class="sks-kv"><dt>Balance</dt><dd>' + money(s.balance) + '</dd>' +
      '<dt>Pending payout</dt><dd>' + money(s.pendingPayout) + '</dd>' +
      '<dt>Wallet PIN</dt><dd>' + (s.pinSet === true ? 'Set' : s.pinSet === false ? 'Not set' : '—') + '</dd></dl>';
  }

  function renderOrders (r) {
    var rows = (r && r.orders) || [];
    if (!rows.length) return '<p class="sks-muted">No orders yet.</p>';
    return '<div class="sks-table" role="table">' + rows.map(function (o) {
      return '<div class="sks-tr" role="row"><span role="cell" class="sks-mono">' + esc(String(o.id).slice(0, 10)) + '</span>' +
        '<span role="cell">' + esc(o.status || '—') + '</span>' +
        '<span role="cell">' + money(o.total) + '</span>' +
        '<span role="cell" class="sks-muted">' + esc(when(o.createdAt)) + '</span></div>';
    }).join('') + '</div>';
  }

  function renderProducts (r) {
    var rows = (r && r.products) || [];
    if (!rows.length) return '<p class="sks-muted">No products yet.</p>';
    return '<div class="sks-table" role="table">' + rows.map(function (p) {
      return '<div class="sks-tr" role="row"><span role="cell">' + esc(p.name || '—') + '</span>' +
        '<span role="cell">' + money(p.price) + '</span>' +
        '<span role="cell">Stock ' + num(p.stock) + '</span>' +
        '<span role="cell" class="sks-muted">' + esc(p.status || '—') + '</span></div>';
    }).join('') + '</div>';
  }

  /* ── RUNTIME ─────────────────────────────────────────────────────────────── */
  function whenFirebase () {
    return new Promise(function (res, rej) {
      var waited = 0;
      (function tick () {
        if (window.firebaseApp && window.firebaseAuth) return res();
        waited += 80;
        if (waited > 15000) return rej(new Error('no-firebase'));
        setTimeout(tick, 80);
      })();
    });
  }
  function callable (name) {
    return function (payload) {
      return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js').then(function (fn) {
        return fn.httpsCallable(fn.getFunctions(window.firebaseApp), name)(payload || {});
      }).then(function (r) { return r && r.data; });
    };
  }
  function currentUser () {
    return import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js').then(function (a) {
      return new Promise(function (res) {
        var done = false, t = setTimeout(function () { if (!done) { done = true; res(null); } }, 12000);
        var off = a.onAuthStateChanged(window.firebaseAuth, function (u) {
          if (u && !done) { done = true; clearTimeout(t); try { off(); } catch (_) {} res(u); }
        });
      });
    });
  }
  function isDenied (e) {
    var reason = e && e.details && e.details.reason;
    return reason === 'not-store-operator' || (e && /permission-denied/.test(String(e.code || '')));
  }

  function wireProfile (root) {
    var form = root.querySelector('#sks-profile');
    var status = root.querySelector('#sks-prof-status');
    var btn = root.querySelector('#sks-save');
    if (!form) return;
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var profile = {};
      ['name', 'phone', 'email', 'tagline', 'city'].forEach(function (k) {
        var el = form.elements[k]; if (el) profile[k] = el.value;
      });
      btn.disabled = true; status.textContent = 'Saving…'; status.className = 'sks-status';
      deps.callable('sokoniStoreSaveProfile')({ profile: profile }).then(function (r) {
        /* Success is shown only after the server confirmed the write. */
        if (r && r.ok) {
          status.textContent = 'Saved.'; status.className = 'sks-status sks-ok';
          if (r.profile && r.profile.phone && form.elements.phone) form.elements.phone.value = r.profile.phone;
        } else { status.textContent = 'Not saved.'; status.className = 'sks-status sks-err'; }
      }).catch(function (e) {
        status.className = 'sks-status sks-err';
        status.textContent = isDenied(e) ? DENIED_TEXT : ((e && e.message) || 'Not saved.');
      }).then(function () { btn.disabled = false; });
    });
  }

  /* Seam: the static suite swaps these for fakes; production never touches them. */
  var deps = { whenFirebase: whenFirebase, currentUser: currentUser, callable: callable };

  function mount (root) {
    if (!root) return;
    root.innerHTML = renderLoading();
    deps.whenFirebase().then(function () { return deps.currentUser(); }).then(function (u) {
      if (!u) { root.innerHTML = renderDenied('signed-out'); return; }
      return deps.callable('sokoniStoreGetContext')({}).then(function (ctx) {
        if (!ctx || ctx.ok !== true || ctx.operator !== true) { root.innerHTML = renderDenied('denied'); return; }
        root.innerHTML = renderWorkspace(ctx);
        wireProfile(root);
        /* Only an operator reaches these calls. */
        var put = function (id, html) { var el = root.querySelector('#' + id); if (el) el.innerHTML = html; };
        deps.callable('sokoniStoreGetWallet')({}).then(function (w) { put('sks-wallet', renderWallet(w)); })
          .catch(function () { put('sks-wallet', '<p class="sks-muted">Wallet unavailable. Balance: —</p>'); });
        deps.callable('sokoniStoreListOrders')({}).then(function (r) { put('sks-orders', renderOrders(r)); })
          .catch(function () { put('sks-orders', '<p class="sks-muted">Orders unavailable.</p>'); });
        deps.callable('sokoniStoreListProducts')({}).then(function (r) { put('sks-products', renderProducts(r)); })
          .catch(function () { put('sks-products', '<p class="sks-muted">Products unavailable.</p>'); });
      }, function (e) {
        root.innerHTML = renderDenied(isDenied(e) ? 'denied' : 'unavailable');
      });
    }).catch(function () { root.innerHTML = renderDenied('unavailable'); });
  }

  window.SokoniStoreWorkspace = {
    DENIED_TEXT: DENIED_TEXT,
    mount: mount,
    _deps: deps,
    _render: { denied: renderDenied, workspace: renderWorkspace, wallet: renderWallet, orders: renderOrders, products: renderProducts, loading: renderLoading, maskTail: maskTail },
  };

  if (window.__SOKONI_STORE_MODE === true && typeof document !== 'undefined') {
    var go = function () { mount(document.getElementById('sokoni-store-root')); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
})();
