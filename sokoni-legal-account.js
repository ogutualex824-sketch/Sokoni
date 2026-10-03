/* ============================================================================
   SOKONI Legal Hub — the client's and the advocate's account views (Legal Hub L3b).
   Reads ONLY canonical state; writes nothing itself:
     • My legal bookings  — providerBookings where customerUid == me (rules allow the customer to read their own), kept
                            to Legal providers by the server-projected providers/{id} (category legal / legalProviderId).
       Open / Review       → SokoniBookService.review (the canonical booking view; reviews = bookingSubmitReview)
       My completion PIN   → serviceBookingPin { op:'getMyBookingPin' } — issued only once SOKONI holds the payment
       Message             → SokoniInbox.openForTransaction('service_booking', id) (server-checked parties)
       Help / refund       → a SOKONI support request carrying the booking ref (a request is not a refund)
     • Advocate          — status card (legalDispatch legalMyProfile) + the canonical provider dashboard for bookings,
                            services & rates, availability, PIN entry, earnings and the business wallet.
   Overrides the legacy tab loaders (renderAppointments, renderClientDashboard, renderMyLegalCompletions,
   initProDashboard) — they read localStorage and Legal-only collections.
   ========================================================================== */
(function (W) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); };
  var kes = function (cents) { return 'KES ' + (Math.round(Number(cents) || 0) / 100).toLocaleString(); };
  function stateLabel(b) {
    if (b.paymentStatus === 'settled' || b.status === 'completed') return ['✅ Completed', 'ok'];
    if (b.status === 'cancelled' || b.status === 'declined' || b.status === 'expired') return ['✕ ' + b.status.charAt(0).toUpperCase() + b.status.slice(1), 'off'];
    if (/refund/.test(String(b.paymentStatus || ''))) return ['↩︎ Refund ' + String(b.paymentStatus).replace(/_/g, ' '), 'off'];
    if (b.paymentStatus === 'paid_held') return ['💰 Paid — held by SOKONI until you confirm', 'held'];
    if (b.paymentStatus === 'pending') return ['⏳ Awaiting payment', 'wait'];
    return ['⏳ ' + String(b.status || 'pending'), 'wait'];
  }
  async function ready() {
    for (var i = 0; i < 80 && !(W.firebase && W.firebase.firestore && W.firebase.auth); i++) await new Promise(function (r) { setTimeout(r, 100); });
    if (typeof W._lhAuthReady === 'function') { try { await W._lhAuthReady(); } catch (_) {} }
    return !!(W.firebase && W.firebase.firestore);
  }
  async function myLegalBookings() {
    var u = W.firebase.auth().currentUser;
    if (!u) return { signedOut: true };
    var db = W.firebase.firestore();
    var snap = await db.collection('providerBookings').where('customerUid', '==', u.uid).limit(100).get();
    var rows = snap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var ids = rows.map(function (b) { return b.providerId; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; });
    var provs = {};
    await Promise.all(ids.map(async function (pid) {
      try { var p = await db.collection('providers').doc(pid).get(); if (p.exists) provs[pid] = p.data(); } catch (_) {}
    }));
    rows = rows.filter(function (b) { var p = provs[b.providerId]; return p && (p.category === 'legal' || p.legalProviderId || p.provisionedBy === 'legal-verification'); });
    rows.sort(function (a, b) { return (Number(b.startTs) || 0) - (Number(a.startTs) || 0); });
    return { rows: rows, provs: provs };
  }
  function rowHtml(b, p) {
    var st = stateLabel(b), name = (p && (p.businessName || p.name)) || 'Advocate';
    var when = (b.date || '') + (b.startTime ? ' · ' + b.startTime : '');
    var acts = '<button type="button" class="lc-filter-btn" data-lb-open="' + esc(b.id) + '">Open</button>';
    if (b.paymentStatus === 'paid_held') acts += '<button type="button" class="lc-filter-btn active-lf" data-lb-pin="' + esc(b.id) + '">🔐 My completion PIN</button>';
    if (b.paymentStatus === 'paid_held' || b.status === 'confirmed' || b.status === 'in_progress' || b.status === 'completed') acts += '<button type="button" class="lc-filter-btn" data-lb-msg="' + esc(b.id) + '">💬 Message</button>';
    if (b.paymentStatus === 'paid_held' || b.paymentStatus === 'settled') acts += '<a class="lc-filter-btn" style="text-decoration:none" href="support.html?topic=refund&ref=' + encodeURIComponent('booking_' + b.id) + '">Help / refund request</a>';
    return '<div class="lh-section" style="padding:14px 16px;">' +
      '<div style="display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;"><strong style="color:#fff;">' + esc(b.service || 'Legal consultation') + '</strong><span style="font-weight:900;color:#c8ff80;">' + esc(kes(b.price)) + '</span></div>' +
      '<div style="font-size:12px;color:rgba(255,255,255,0.55);margin:4px 0 8px;"><a href="legal-profile.html?id=' + encodeURIComponent(b.providerId) + '" style="color:#c8ff80;">' + esc(name) + '</a> · ' + esc(when) + '</div>' +
      '<div style="font-size:12px;margin-bottom:8px;">' + esc(st[0]) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' + acts + '</div><div data-lb-out="' + esc(b.id) + '" style="font-size:12px;margin-top:8px;"></div></div>';
  }
  async function mountBookings(hostId) {
    var host = document.getElementById(hostId); if (!host) return;
    host.innerHTML = '<div style="padding:16px;color:rgba(255,255,255,0.4);font-size:12px;">Loading your bookings…</div>';
    if (!(await ready())) { host.innerHTML = '<div class="law-alert">Bookings could not load — please refresh.</div>'; return; }
    var r;
    try { r = await myLegalBookings(); }
    catch (_) { host.innerHTML = '<div class="law-alert">We couldn’t load your bookings just now. This is not an empty list — please try again.</div>'; return; }
    if (r.signedOut) { host.innerHTML = '<div class="law-alert"><a href="login.html?redirect=' + encodeURIComponent('/legal-hub.html#appointments') + '" style="color:#71ff00;font-weight:800;">Sign in</a> to see your legal bookings.</div>'; return; }
    if (!r.rows.length) { host.innerHTML = '<div style="text-align:center;padding:28px 12px;color:rgba(255,255,255,0.45);font-size:13px;">No legal bookings yet. <a href="legal-hub.html#lawyers" style="color:#c8ff80;">Find a verified advocate</a>.</div>'; return; }
    host.innerHTML = r.rows.map(function (b) { return rowHtml(b, r.provs[b.providerId]); }).join('');
    host._rows = r.rows;
  }
  document.addEventListener('click', async function (e) {
    var t = e.target.closest('[data-lb-open],[data-lb-pin],[data-lb-msg]'); if (!t) return;
    var id = t.getAttribute('data-lb-open') || t.getAttribute('data-lb-pin') || t.getAttribute('data-lb-msg');
    var out = document.querySelector('[data-lb-out="' + id + '"]');
    if (t.hasAttribute('data-lb-open')) {
      if (W.SokoniBookService && typeof W.SokoniBookService.review === 'function') W.SokoniBookService.review({ bookingId: id });
      else if (out) out.textContent = 'The booking view is loading — try again in a moment.';
      return;
    }
    if (t.hasAttribute('data-lb-msg')) {
      if (W.SokoniInbox && typeof W.SokoniInbox.openForTransaction === 'function') W.SokoniInbox.openForTransaction('service_booking', id);
      else location.href = 'messages.html?tx=service_booking&txId=' + encodeURIComponent(id);
      return;
    }
    /* PIN YAKO NI BOOKING YAKO — shown only to this booking's buyer, only once SOKONI holds the payment. Give it to the
       advocate ONLY after the service is delivered: it is what releases their payment. */
    if (out) out.textContent = 'Fetching your PIN…';
    try {
      var r = (await W.firebase.functions().httpsCallable('serviceBookingPin')({ op: 'getMyBookingPin', bookingId: id })).data || {};
      if (!out) return;
      if (r.issued && r.pin) out.innerHTML = 'Your completion PIN: <strong style="font-size:18px;letter-spacing:3px;color:#fff;">' + esc(r.pin) + '</strong><br><span style="color:rgba(255,255,255,0.5);">Share it with the advocate only after the service is done — it releases their payment.</span>';
      else out.textContent = r.reason === 'unpaid' ? 'Your PIN is issued once your payment is held by SOKONI.' : 'Your PIN is not ready yet — refresh in a moment.';
    } catch (err) { if (out) out.textContent = (err && err.message) || 'Could not fetch your PIN just now.'; }
  });

  W.renderAppointments = function () { return mountBookings('lhMyBookings'); };
  W.renderClientDashboard = function () { return mountBookings('lhDashBookings'); };
  W.renderMyLegalCompletions = function () {};   /* the completion tab is now an explanation; nothing is logged by hand */
  W.initProDashboard = function () { if (typeof W.checkExistingApp === 'function') { var h = document.getElementById('lhProStatus'); if (h) h.textContent = ''; } };
  W.SokoniLegalAccount = { mountBookings: mountBookings, _stateLabel: stateLabel, _rowHtml: rowHtml };
})(window);
