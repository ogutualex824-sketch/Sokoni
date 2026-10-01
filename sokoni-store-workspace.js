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
      renderPayoutPanel(ctx) +
      '</section>' +

      '<section class="sks-card" aria-labelledby="sks-ord-h"><h2 class="sks-h2" id="sks-ord-h">Orders</h2><div id="sks-orders"><p class="sks-muted">Loading…</p></div></section>' +
      '<section class="sks-card" aria-labelledby="sks-prod-h"><h2 class="sks-h2" id="sks-prod-h">Products</h2><div id="sks-products"><p class="sks-muted">Loading…</p></div></section>' +
      '</div>';
  }

  /** The server sends last3 only. Anything else renders "Not set". */
  function destText (dest) {
    return (dest && dest.status === 'set' && /^\d{3}$/.test(String(dest.last3 || ''))) ? '••• ' + dest.last3 : null;
  }

  function renderPayoutPanel (ctx) {
    var on = !!(ctx && ctx.payoutsEnabled === true);
    var dest = ctx && ctx.payoutDestination;
    var masked = destText(dest);
    var dis = on ? '' : ' disabled aria-disabled="true"';
    return '<div class="sks-payout"><div><strong>Payout number</strong><div class="sks-muted" id="sks-payout-val">' +
      (masked ? esc(masked) : 'Not set') + '</div></div>' +
      '<div class="sks-row"><button type="button" class="sks-btn" id="sks-dest-btn"' + dis + '>Set payout number</button>' +
      '<button type="button" class="sks-btn sks-primary" id="sks-wd-btn"' + (on && masked ? '' : ' disabled aria-disabled="true"') + '>Withdraw</button></div></div>' +
      (on ? '' : '<p class="sks-note" id="sks-payout-held">Store withdrawals are awaiting owner approval.</p>') +
      /* Set-destination form: the number must be the operator's own verified phone (server-checked). */
      '<form id="sks-dest-form" class="sks-form sks-sub" hidden novalidate>' +
      '<label class="sks-field"><span>Payout number <small class="sks-muted">(your verified phone)</small></span>' +
      '<input name="msisdn" type="tel" inputmode="tel" maxlength="16" placeholder="0705 726 803" autocomplete="off"></label>' +
      '<label class="sks-field"><span>Wallet PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off"></label>' +
      '<div class="sks-row"><button type="submit" class="sks-btn sks-primary">Save payout number</button>' +
      '<span class="sks-status" id="sks-dest-status" role="status" aria-live="polite"></span></div></form>' +
      /* Withdraw form: amount + PIN only — the destination is the stored one, never typed here. */
      '<form id="sks-wd-form" class="sks-form sks-sub" hidden novalidate>' +
      '<label class="sks-field"><span>Amount (KES)</span><input name="amount" type="number" inputmode="numeric" min="100" step="1" autocomplete="off"></label>' +
      '<label class="sks-field"><span>Wallet PIN</span><input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="off"></label>' +
      '<p class="sks-note">Paid to ' + esc(masked || 'the store payout number') + ' after an admin approves.</p>' +
      '<div class="sks-row"><button type="submit" class="sks-btn sks-primary">Request withdrawal</button>' +
      '<span class="sks-status" id="sks-wd-status" role="status" aria-live="polite"></span></div></form>';
  }

  function renderWallet (w) {
    var s = (w && w.storeWallet) || {};
    if (!s.exists) {
      return '<p class="sks-muted" data-sks-wallet="none">No store sale has settled yet.</p>' +
        '<dl class="sks-kv"><dt>Balance</dt><dd>—</dd></dl>';
    }
    return '<dl class="sks-kv"><dt>Balance</dt><dd>' + money(s.balance) + '</dd>' +
      '<dt>Pending payout</dt><dd>' + money(s.pendingPayout) + '</dd></dl>' +
      (s.frozen === true ? '<p class="sks-note">The store wallet is frozen.</p>' : '');
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

  function newRequestId () {
    try { if (window.crypto && window.crypto.randomUUID) return 'sks-' + window.crypto.randomUUID(); } catch (_) {}
    return 'sks-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
  }
  function reasonText (e) {
    var r = e && e.details && e.details.reason;
    var map = {
      'store-payouts-not-enabled': 'Store withdrawals are awaiting owner approval.',
      'pin-not-set': 'Set your wallet PIN first.',
      'pin-required': 'Enter your 4-digit wallet PIN.',
      'destination-not-operator-verified-phone': 'The payout number must be your own verified phone number.',
      'operator-phone-not-verified': 'Verify a phone number on your account first.',
      'payout-destination-not-set': 'Set the store payout number first.',
      'no-store-sale-settled-yet': 'No store sale has settled yet.',
      'insufficient-store-balance': 'Insufficient store balance for this payout.',
      'invalid-amount': 'Minimum payout amount is KSh 100.',
      'daily-payout-limit': 'Daily payout limit reached. Try again tomorrow.',
      'store-wallet-frozen': 'The store wallet is frozen.',
      'not-store-operator': DENIED_TEXT,
    };
    return map[r] || (e && e.message) || 'Not completed.';
  }

  function wirePayout (root, ctx) {
    var on = !!(ctx && ctx.payoutsEnabled === true);
    var destBtn = root.querySelector('#sks-dest-btn'), wdBtn = root.querySelector('#sks-wd-btn');
    var destForm = root.querySelector('#sks-dest-form'), wdForm = root.querySelector('#sks-wd-form');
    if (!on || !destForm || !wdForm) return;   /* held: nothing is wired, buttons stay disabled */
    var wdRequestId = null;
    if (destBtn) destBtn.addEventListener('click', function () { destForm.hidden = !destForm.hidden; wdForm.hidden = true; });
    if (wdBtn) wdBtn.addEventListener('click', function () { wdForm.hidden = !wdForm.hidden; destForm.hidden = true; wdRequestId = newRequestId(); });
    destForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var st = root.querySelector('#sks-dest-status'), b = destForm.querySelector('button[type=submit]');
      b.disabled = true; st.textContent = 'Saving…'; st.className = 'sks-status';
      deps.callable('sokoniStoreSetPayoutDestination')({ msisdn: destForm.elements.msisdn.value, pin: destForm.elements.pin.value })
        .then(function (r) {
          if (r && r.ok && r.payoutDestination) {
            st.textContent = 'Saved.'; st.className = 'sks-status sks-ok';
            var v = root.querySelector('#sks-payout-val'); if (v) v.textContent = destText(r.payoutDestination) || 'Not set';
            if (wdBtn && destText(r.payoutDestination)) { wdBtn.disabled = false; wdBtn.removeAttribute('aria-disabled'); }
          } else { st.textContent = 'Not saved.'; st.className = 'sks-status sks-err'; }
        }, function (e) { st.textContent = reasonText(e); st.className = 'sks-status sks-err'; })
        .then(function () { destForm.elements.pin.value = ''; b.disabled = false; });
    });
    wdForm.addEventListener('submit', function (ev) {
      ev.preventDefault();
      var st = root.querySelector('#sks-wd-status'), b = wdForm.querySelector('button[type=submit]');
      if (!wdRequestId) wdRequestId = newRequestId();
      b.disabled = true; st.textContent = 'Submitting…'; st.className = 'sks-status';
      /* Same requestId on a retry of THIS submission → the server de-duplicates. */
      deps.callable('sokoniStorePayoutRequest')({ amount: Number(wdForm.elements.amount.value), pin: wdForm.elements.pin.value, requestId: wdRequestId })
        .then(function (r) {
          if (r && r.ok) {
            st.textContent = r.deduplicated ? 'Already submitted.' : 'Submitted — awaiting admin approval.'; st.className = 'sks-status sks-ok';
            wdRequestId = null;
            deps.callable('sokoniStoreGetWallet')({}).then(function (w) { var el = root.querySelector('#sks-wallet'); if (el) el.innerHTML = renderWallet(w); }, function () {});
          } else { st.textContent = 'Not submitted.'; st.className = 'sks-status sks-err'; }
        }, function (e) { st.textContent = reasonText(e); st.className = 'sks-status sks-err'; })
        .then(function () { wdForm.elements.pin.value = ''; b.disabled = false; });
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
        wirePayout(root, ctx);
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
    _render: { payout: renderPayoutPanel, destText: destText, denied: renderDenied, workspace: renderWorkspace, wallet: renderWallet, orders: renderOrders, products: renderProducts, loading: renderLoading, maskTail: maskTail },
  };

  if (window.__SOKONI_STORE_MODE === true && typeof document !== 'undefined') {
    var go = function () { mount(document.getElementById('sokoni-store-root')); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go); else go();
  }
})();
