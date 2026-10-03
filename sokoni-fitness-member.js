/* sokoni-fitness-member.js — Fitness Memberships, member side (fitness-memberships.html).
 *
 * THE BROWSER ONLY REQUESTS AND DISPLAYS (owner 2026-10-03):
 *   providerMemberships where buyerUid == me     → read under rules, live listener (payment state flips arrive here)
 *   providerMemberships/{id}/attendance           → read under rules (member sees history, never edits)
 *   fitnessMembershipQr({membershipId})           → short-lived signed token, ACTIVE memberships only
 *   membershipRequestRefund({membershipId})       → a REQUEST; the server decides; refusals shown verbatim
 *   providerServices (serviceKind 'membership')   → a gym's offers, read-only
 *   fitnessCreateMembership({serviceId}) → {membershipId, reused, priceCents, periodCount, periodUnit, title, payBy}
 *     → REVIEW step rendered from THAT response (never from the offer doc) → on "Pay":
 *     createPaymentIntent({purpose:'fitness_membership', membershipId}) → SokoniIntaSend.initiateSTKPush
 *     (the existing client payment path; amount + ref from the server intent, and it must equal the reviewed price)
 * Selling is OFF unless featureFlags/fitness_membership_sales.enabled === true (server-written by AdminOS;
 * publicly readable). Missing doc / unreadable / anything else = OFF.
 * No Firestore writes. No localStorage source of truth. Never "success" before the server state.
 */
(function (root) {
  'use strict';
  var C = root.SokoniFitnessMemberships && root.SokoniFitnessMemberships._core;
  if (!C) { try { console.error('[fitness-member] sokoni-fitness-memberships.js must load first'); } catch (_) {} return; }
  var esc = C.esc, DASH = C.DASH;

  var FLAG_DOC = 'fitness_membership_sales';
  var ID_RE = /^[A-Za-z0-9_-]{6,128}$/;
  var REFUND_ELIGIBLE = 'Eligible to request, subject to policy';
  var REFUND_USED = 'Not available — membership already used';
  var NOT_ON_SALE = "Memberships aren't on sale yet";
  var SALES_DISABLED_TEXT = "Memberships aren't on sale yet.";
  var LATE_REFUNDED = 'Payment refunded — please start again';
  /* Purchase refusals (API §1, plus 2f's purpose refusal details {code:'SALES_DISABLED'}). Branch on the code, never the
     message; anything not listed shows the server's user-safe message as-is. */
  var CREATE_REFUSAL = {
    SALES_DISABLED: SALES_DISABLED_TEXT,
    missing: 'Membership offer not found.',
    self_purchase: 'You cannot buy a membership at your own gym.',
    provider_missing: 'This gym isn’t currently selling memberships.',
    provider_not_active: 'This gym isn’t currently selling memberships.',
    not_fitness: 'Memberships can only be bought from a fitness business.',
  };
  function createRefusalText(e, fallback) {
    if (C.isOffline(e)) return 'Unavailable — retry when connected';
    var r = C.errReason(e);
    if (r && Object.prototype.hasOwnProperty.call(CREATE_REFUSAL, r)) return CREATE_REFUSAL[r];
    if (C.errCode(e) === 'unauthenticated') return 'Sign in required.';
    return (e && e.message) ? String(e.message) : fallback;
  }
  var REFRESH_BEFORE_MS = 30 * 1000;

  var S = { uid: null, docs: [], unsub: null, flagOn: false, offers: [], confirm: {}, msg: {}, att: {}, buy: null, busy: false, qr: null };

  function $(id) { return root.document.getElementById(id); }
  function fs() { return root.firebase && root.firebase.firestore ? root.firebase.firestore() : null; }

  /* attendedSessions on the membership DOCUMENT: the check-in path writes it on the first valid check-in; before that the
     server's own reading of an absent field is 0 (fitness-attendance.js). A non-integer value, or an absent count on a
     record that HAS a first attendance, is unknown → null → "—". */
  function attendedOf(m) {
    if (C.isCount(m.attendedSessions)) return m.attendedSessions;
    if (m.attendedSessions === undefined && !m.firstAttendedAt) return 0;
    return null;
  }
  function sessionsObj(m) {
    var o = { attendedSessions: attendedOf(m) };
    if ('sessionsIncluded' in m) o.sessionsIncluded = m.sessionsIncluded;
    return o;
  }

  function statusText(m) {
    if (m.paymentStatus === 'refunded_late') return LATE_REFUNDED;
    if (m.paymentStatus === 'payment_review') return 'Payment under review';
    if (m.status === 'pending_payment') return 'Waiting for payment confirmation';
    return C.label(C.STATUS_LABEL, m.status);
  }

  /* refund wording — owner's exact text */
  function refundState(m) {
    var att = attendedOf(m);
    var rs = m.refund && typeof m.refund === 'object' ? m.refund.state : null;
    if (m.paymentStatus === 'refunded_late') return { text: 'Refunded to your SOKONI wallet (payment arrived too late)' };
    if (rs === 'refunded' || m.status === 'refunded' || m.paymentStatus === 'refunded') {
      return { text: m.refund && m.refund.destination === 'sokoni_wallet' ? 'Refunded to your SOKONI wallet' : 'Refunded' };
    }
    if (rs === 'requested' || m.status === 'refund_requested' || m.paymentStatus === 'refund_requested') return { text: 'Refund requested — under review' };
    if (rs === 'rejected') return { text: 'Refund declined' };
    if (m.status !== 'active') return { text: DASH };
    if (m.refundEligible === false || (C.isCount(att) && att >= 1)) return { text: REFUND_USED };
    if (att === 0) return { text: REFUND_ELIGIBLE, canRequest: true };
    return { text: DASH };
  }

  function kv(k, v) { return '<div class="fm-kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }

  function cardHTML(id, m) {
    m = m || {};
    var so = sessionsObj(m), rs = refundState(m), active = m.status === 'active';
    var late = m.paymentStatus === 'refunded_late';
    var pend = !late && (m.status === 'pending_payment' || m.paymentStatus === 'payment_review');
    var refund = '<div class="fm-refund"><span>Refund</span> <b data-fm-refund>' + esc(rs.text) + '</b>';
    if (rs.canRequest) {
      refund += S.confirm[id]
        ? '<div class="fm-confirm"><p>Ask SOKONI to refund this membership? The decision follows the refund policy.</p>' +
          '<button type="button" class="fm-btn fm-btn-p" data-fm-act="refund-go" data-id="' + esc(id) + '">Send refund request</button> ' +
          '<button type="button" class="fm-btn fm-btn-s" data-fm-act="refund-cancel" data-id="' + esc(id) + '">Keep membership</button></div>'
        : ' <button type="button" class="fm-btn fm-btn-s" data-fm-act="refund" data-id="' + esc(id) + '">REQUEST REFUND</button>';
    }
    refund += S.msg[id] ? '<div class="fm-msg" role="status">' + esc(S.msg[id]) + '</div>' : '';
    refund += '</div>';
    var att = S.att[id];
    var hist = att === undefined ? '' : att === null ? '<p class="fm-sub">Loading attendance…</p>'
      : att.error ? '<p class="fm-sub" role="alert">' + esc(att.error) + '</p>'
      : '<ul class="fm-list">' + (att.rows.length ? att.rows.map(function (a) {
          return '<li>' + esc(C.fmtDateTime(a.checkedInAt)) + ' · ' + esc(C.label({ checked_in: 'Checked in', completed: 'Completed', voided_by_admin: 'Voided by SOKONI' }, a.status)) + '</li>';
        }).join('') : '<li>No attendance recorded yet.</li>') + '</ul>';
    return '<article class="fm-card" data-id="' + esc(id) + '" aria-label="Membership ' + esc(C.shortRef(id)) + '">' +
      '<div class="fm-card-h"><div><div class="fm-title">' + esc(m.title || DASH) + '</div><div class="fm-sub">Membership ' + esc(C.shortRef(id)) + ' · ' + esc(C.periodText(m.periodCount, m.periodUnit)) + '</div></div>' +
      '<span class="fm-pill' + (pend ? ' fm-pill-wait' : active ? ' fm-pill-ok' : '') + '">' + esc(statusText(m)) + '</span></div>' +
      (late ? '<p class="fm-sub" role="status">Your payment reached SOKONI after this membership\'s payment window closed, so it was not activated and the money went back to your SOKONI wallet. Start a new membership to continue.</p>' : '') +
      (pend ? '<p class="fm-sub" role="status">' + esc(m.paymentStatus === 'payment_review' ? 'SOKONI is checking this payment. Nothing is active until it is cleared.' : 'This updates automatically once your M-Pesa payment is confirmed.') + '</p>' : '') +
      '<div class="fm-grid">' + kv('Start', C.fmtDate(m.startAt)) + kv('Expiry', C.fmtDate(m.endsAt)) +
      kv('Sessions included', C.capText(C.capOf(m, 'sessionsIncluded', 'unlimited'))) + kv('Used', C.countText(so.attendedSessions)) +
      kv('Remaining', C.remainingText(so, 'unlimited')) + kv('Price', C.fmtKES(m.priceCents)) + '</div>' +
      refund +
      '<div class="fm-actions">' +
      (active ? '<button type="button" class="fm-btn fm-btn-p" data-fm-act="qr" data-id="' + esc(id) + '">VIEW MEMBERSHIP QR</button>' : '') +
      (pend || late ? '' : '<button type="button" class="fm-btn fm-btn-s" data-fm-act="history" data-id="' + esc(id) + '" aria-expanded="' + (att !== undefined) + '">Attendance history</button>') +
      '</div>' + hist + '</article>';
  }

  function render() {
    var list = $('fmList'); if (!list) return;
    if (!S.docs.length) { list.innerHTML = '<p class="fm-empty">You have no gym memberships yet.</p>'; return; }
    list.innerHTML = S.docs.map(function (d) { return cardHTML(d.id, d.data); }).join('');
  }

  function listen() {
    var db = fs(); if (!db || !S.uid) return;
    if (S.unsub) { try { S.unsub(); } catch (_) {} }
    $('fmList').innerHTML = '<p class="fm-sub">Loading your memberships…</p>';
    S.unsub = db.collection('providerMemberships').where('buyerUid', '==', S.uid).limit(50).onSnapshot(function (snap) {
      S.docs = (snap.docs || []).map(function (d) { return { id: d.id, data: d.data() || {} }; })
        .sort(function (a, b) { var x = C.toDate(a.data.createdAt || a.data.startAt), y = C.toDate(b.data.createdAt || b.data.startAt); return (y ? y.getTime() : 0) - (x ? x.getTime() : 0); });
      render();
      if (S.qr) { var cur = S.docs.filter(function (d) { return d.id === S.qr.id; })[0]; if (!cur || cur.data.status !== 'active') closeQR(); }
    }, function () { var l = $('fmList'); if (l) l.innerHTML = '<p class="fm-sub" role="alert">Your memberships could not be loaded. Check your connection and reload.</p>'; });
  }

  function loadHistory(id) {
    if (S.att[id] !== undefined && S.att[id] !== null) { delete S.att[id]; render(); return Promise.resolve(); }
    var db = fs(); if (!db) return Promise.resolve();
    S.att[id] = null; render();
    return db.collection('providerMemberships').doc(id).collection('attendance').orderBy('checkedInAt', 'desc').limit(50).get()
      .then(function (snap) { S.att[id] = { rows: (snap.docs || []).map(function (d) { return d.data() || {}; }) }; render(); },
        function () { S.att[id] = { error: 'Attendance history could not be loaded.' }; render(); });
  }

  function refundGo(id) {
    if (S.busy) return Promise.resolve();
    S.busy = true; S.msg[id] = 'Sending your request…'; render();
    return C.call('membershipRequestRefund', { membershipId: id }).then(function (r) {
      S.confirm[id] = false;
      S.msg[id] = (r && r.message) ? String(r.message) : 'Request received by SOKONI. This card shows the decision when it is made.';
    }, function (e) {
      S.confirm[id] = false;
      var detail = e && e.details && typeof e.details === 'object' && e.details.detail ? ' ' + String(e.details.detail) : '';
      S.msg[id] = (C.isOffline(e) ? 'Refund request unavailable — retry when connected' : ((e && e.message) || 'Refund request was not accepted.')) + detail;
    }).then(function () { S.busy = false; render(); });
  }

  /* ── membership QR (ACTIVE only) ── */
  function closeQR() {
    if (!S.qr) return;
    clearInterval(S.qr.tick); clearTimeout(S.qr.refresh);
    var box = $('fmQr'); if (box) { box.hidden = true; box.innerHTML = ''; }
    var back = S.qr.returnFocus; S.qr = null;
    if (back && back.focus) { try { back.focus(); } catch (_) {} }
  }
  function openQR(id, opener) {
    var d = S.docs.filter(function (x) { return x.id === id; })[0];
    if (!d || d.data.status !== 'active') return Promise.resolve(false);
    closeQR();
    S.qr = { id: id, tick: null, refresh: null, returnFocus: opener || null };
    var box = $('fmQr'); box.hidden = false;
    box.innerHTML = '<div class="fm-qr-card" role="dialog" aria-modal="true" aria-labelledby="fmQrT">' +
      '<div class="fm-card-h"><div id="fmQrT" class="fm-title">Membership QR · ' + esc(C.shortRef(id)) + '</div>' +
      '<button type="button" class="fm-btn fm-btn-s" data-fm-act="qr-close" aria-label="Close QR">Close</button></div>' +
      '<div id="fmQrImg" class="fm-qr-img"><p class="fm-sub">Getting your code…</p></div><p id="fmQrCount" class="fm-sub" aria-live="polite"></p>' +
      '<p class="fm-sub">Show this to gym staff. It refreshes automatically and works only for this membership.</p></div>';
    var closeBtn = box.querySelector ? box.querySelector('[data-fm-act="qr-close"]') : null;
    if (closeBtn && closeBtn.focus) { try { closeBtn.focus(); } catch (_) {} }
    return fetchQR(id);
  }
  function fetchQR(id) {
    if (!S.qr || S.qr.id !== id) return Promise.resolve(false);
    return C.call('fitnessMembershipQr', { membershipId: id }).then(function (r) {
      if (!S.qr || S.qr.id !== id) return false;
      var img = $('fmQrImg'), exp = C.toDate(r && r.expiresAt);
      if (!r || typeof r.token !== 'string' || !r.token || !exp) { img.innerHTML = '<p class="fm-sub" role="alert">Your code could not be created. Try again.</p>'; return false; }
      var canvas = null;
      try { canvas = root.SokoniQR && root.SokoniQR.generateCanvas(r.token, 240); } catch (_) { canvas = null; }
      img.innerHTML = '';
      if (canvas) { canvas.setAttribute('role', 'img'); canvas.setAttribute('aria-label', 'Membership QR code ' + C.shortRef(id)); img.appendChild(canvas); }
      else img.innerHTML = '<p class="fm-sub" role="alert">This device can’t draw the QR. Ask staff to try again, or update your browser.</p>';
      var expMs = exp.getTime();
      clearInterval(S.qr.tick); clearTimeout(S.qr.refresh);
      var count = function () {
        var el = $('fmQrCount'); if (!el) return;
        var left = Math.max(0, Math.round((expMs - Date.now()) / 1000));
        el.textContent = left > 0 ? 'Valid for ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') : 'Refreshing…';
      };
      count();
      S.qr.tick = setInterval(count, 1000);
      S.qr.refresh = setTimeout(function () { fetchQR(id); }, Math.max(5000, expMs - Date.now() - REFRESH_BEFORE_MS));
      return true;
    }, function (e) {
      if (!S.qr || S.qr.id !== id) return false;
      var img = $('fmQrImg');
      if (img) img.innerHTML = '<p class="fm-sub" role="alert">' + esc(C.isOffline(e) ? 'QR unavailable — retry when connected' : ((e && e.message) || 'Your code could not be created.')) + '</p>' +
        '<button type="button" class="fm-btn fm-btn-s" data-fm-act="qr-retry" data-id="' + esc(id) + '">Try again</button>';
      return false;
    });
  }

  /* ── BUY (feature-flagged; default OFF) ── */
  function readFlag() {
    var db = fs(); if (!db) return Promise.resolve(false);
    return db.collection('featureFlags').doc(FLAG_DOC).get().then(function (d) {
      var v = d && d.exists ? (d.data() || {}) : null; return !!(v && v.enabled === true);
    }, function () { return false; });
  }
  function offersHTML() {
    var head = '<h2 class="fm-h2">Membership plans</h2>';
    if (!S.offers.length) return head + '<p class="fm-sub">This gym has no membership plans on SOKONI yet.</p>';
    return head + (S.flagOn ? '' : '<p class="fm-note" role="status">' + esc(NOT_ON_SALE) + '</p>') +
      S.offers.map(function (o) {
        return '<div class="fm-offer"><div><div class="fm-title">' + esc(o.name || DASH) + '</div><div class="fm-sub">' + esc(C.periodText(o.periodCount, o.periodUnit)) + '</div></div>' +
          '<div class="fm-price">' + esc(C.fmtKES(o.price)) + '</div>' +
          '<button type="button" class="fm-btn fm-btn-p" data-fm-act="buy" data-id="' + esc(o.id) + '"' + (S.flagOn ? '' : ' disabled aria-disabled="true"') + '>BUY MEMBERSHIP</button></div>';
      }).join('') + '<div id="fmPay"></div>';
  }
  function loadOffers(pid) {
    var box = $('fmBuy'); if (!box) return Promise.resolve();
    if (!ID_RE.test(String(pid || ''))) { box.innerHTML = '<p class="fm-sub" role="alert">This gym link is not valid.</p>'; return Promise.resolve(); }
    var db = fs(); if (!db) return Promise.resolve();
    box.innerHTML = '<p class="fm-sub">Loading plans…</p>';
    return Promise.all([readFlag(), db.collection('providerServices').where('providerId', '==', pid).where('serviceKind', '==', 'membership').where('active', '==', true).limit(20).get()])
      .then(function (r) {
        S.flagOn = r[0] === true;
        S.offers = ((r[1] && r[1].docs) || []).map(function (d) { var o = d.data() || {}; o.id = d.id; return o; }).filter(function (o) { return !o.removedAt; });
        box.innerHTML = offersHTML();
      }, function () { box.innerHTML = '<p class="fm-sub" role="alert">Plans could not be loaded.</p>'; });
  }
  function payNote(t, alert) { var n = $('fmPayNote'); if (n) { n.textContent = t; if (alert) n.setAttribute('role', 'alert'); } }
  /* The review step is built ONLY from fitnessCreateMembership's answer (server-priced snapshot). */
  function reviewHTML(b) {
    return '<div class="fm-paybox" data-fm-review>' +
      (b.reused ? '<p class="fm-note" role="status">Continuing your pending membership — nothing new was created.</p>' : '') +
      '<div class="fm-title">' + esc(b.title || DASH) + '</div><div class="fm-sub">Membership ' + esc(C.shortRef(b.membershipId)) + ' · ' + esc(C.periodText(b.periodCount, b.periodUnit)) + '</div>' +
      '<div class="fm-price">' + esc(C.fmtKES(b.priceCents)) + '</div>' +
      '<p class="fm-sub">Pay by ' + esc(C.fmtTime(b.payBy)) + ' (Nairobi). Paid to SOKONI and held for the gym. Refundable before your first visit, subject to policy.</p>' +
      '<label class="fm-sub" for="fmPhone">M-Pesa number</label>' +
      '<input id="fmPhone" class="fm-in" inputmode="numeric" autocomplete="tel" placeholder="e.g. 0712345678" value="' + esc(b.phone || '') + '">' +
      '<button type="button" class="fm-btn fm-btn-p" data-fm-act="pay" id="fmPayBtn">Pay with M-Pesa</button><p id="fmPayNote" class="fm-sub" aria-live="polite"></p></div>';
  }
  function validCreate(r) {
    return !!(r && typeof r.membershipId === 'string' && ID_RE.test(r.membershipId) && typeof r.reused === 'boolean' &&
      C.isCount(r.priceCents) && r.priceCents > 0 && C.isCount(r.periodCount) && r.periodCount >= 1);
  }
  function buy(serviceId) {
    var pay = $('fmPay');
    if (!S.flagOn) { if (pay) pay.innerHTML = '<p class="fm-note" role="status">' + esc(NOT_ON_SALE) + '</p>'; return Promise.resolve(false); }
    if (S.busy || !pay) return Promise.resolve(false);
    if (!S.offers.some(function (o) { return o.id === serviceId; })) return Promise.resolve(false);
    S.busy = true;
    pay.innerHTML = '<p class="fm-sub" role="status">Starting your membership…</p>';
    return C.call('fitnessCreateMembership', { serviceId: serviceId }).then(function (r) {
      if (!validCreate(r)) throw new Error('Could not start the membership. Please try again.');
      var phone = ((root.firebase.auth().currentUser || {}).phoneNumber || '').replace('+', '');
      S.buy = { membershipId: r.membershipId, reused: r.reused, priceCents: r.priceCents, periodCount: r.periodCount, periodUnit: r.periodUnit,
        title: r.title || null, payBy: r.payBy || null, phone: phone, ref: null, amount: null };
      pay.innerHTML = reviewHTML(S.buy);
      return true;
    }).catch(function (e) {
      pay.innerHTML = '<p class="fm-sub" role="alert">' + esc(createRefusalText(e, 'Could not start the membership.')) + '</p>';
      return false;
    }).then(function (ok) { S.busy = false; return ok; });
  }
  function payNow() {
    if (!S.buy || S.busy) return Promise.resolve(false);
    var input = $('fmPhone'), btn = $('fmPayBtn');
    var phone = String((input && input.value) || '').replace(/\D/g, '').replace(/^0/, '254');
    if (!/^254[17]\d{8}$/.test(phone)) { payNote('Enter a valid Kenyan M-Pesa number.', true); return Promise.resolve(false); }
    if (!root.SokoniIntaSend || typeof root.SokoniIntaSend.initiateSTKPush !== 'function') { payNote('Payment unavailable right now. Please try again.', true); return Promise.resolve(false); }
    S.busy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Preparing payment…'; }
    var b = S.buy;
    return C.call('createPaymentIntent', { purpose: 'fitness_membership', membershipId: b.membershipId }).then(function (intent) {
      if (!intent || !intent.ref || !(Number(intent.amount) > 0)) throw new Error('Payment could not be prepared. Please try again.');
      /* The intent is the server's price; it must equal the price the member just reviewed, or nothing is pushed. */
      if (Math.round(Number(intent.amount) * 100) !== b.priceCents) throw new Error('The price changed. Please start again.');
      b.ref = intent.ref; b.amount = Number(intent.amount);
      if (btn) btn.textContent = 'Check your phone…';
      return Promise.resolve(root.SokoniIntaSend.initiateSTKPush(phone, b.amount, b.ref, { category: 'fitness', serviceDesc: b.title || 'Gym membership' })).then(function () {
        /* NOT a success message: the membership card says "Waiting for payment confirmation" until the server flips it. */
        payNote('Enter your M-Pesa PIN on your phone. Your membership below updates automatically once SOKONI confirms the payment.');
        return true;
      });
    }).catch(function (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Pay with M-Pesa'; }
      payNote(createRefusalText(e, 'Could not send the M-Pesa request.'), true);
      return false;
    }).then(function (ok) { S.busy = false; return ok; });
  }

  function act(name, id, el) {
    if (name === 'qr') return openQR(id, el);
    if (name === 'qr-close') { closeQR(); return Promise.resolve(); }
    if (name === 'qr-retry') return fetchQR(id);
    if (name === 'history') return loadHistory(id);
    if (name === 'refund') { S.confirm[id] = true; S.msg[id] = ''; render(); return Promise.resolve(); }
    if (name === 'refund-cancel') { S.confirm[id] = false; render(); return Promise.resolve(); }
    if (name === 'refund-go') return refundGo(id);
    if (name === 'buy') return buy(id);
    if (name === 'pay') return payNow();
    return Promise.resolve();
  }

  function onClick(e) {
    var t = e && e.target && e.target.closest ? e.target.closest('[data-fm-act]') : null;
    if (!t || t.disabled) return;
    act(t.getAttribute('data-fm-act'), t.getAttribute('data-id'), t);
  }

  function start() {
    var root$ = $('fmRoot'); if (!root$) return;
    root$.addEventListener('click', onClick);
    root.document.addEventListener('keydown', function (e) { if (e && e.key === 'Escape' && S.qr) closeQR(); });
    var params = new URLSearchParams((root.location && root.location.search) || '');
    var pid = params.get('provider');
    /* firebase.js (module) publishes waitForFirebaseReady; if this script ran first, wait for its one-shot event. */
    var ready = typeof root.waitForFirebaseReady === 'function' ? root.waitForFirebaseReady() : new Promise(function (res) {
      root.document.addEventListener('sokoniFirebaseReady', function () { res(); }, { once: true });
      setTimeout(res, 8000);
    });
    ready.then(function () {
      if (!root.firebase || !root.firebase.auth) { $('fmList').innerHTML = '<p class="fm-sub" role="alert">SOKONI could not load. Reload the page.</p>'; return; }
      root.firebase.auth().onAuthStateChanged(function (user) {
        if (!user) {
          S.uid = null; if (S.unsub) { try { S.unsub(); } catch (_) {} S.unsub = null; }
          var next = encodeURIComponent('/fitness-memberships.html' + (root.location.search || ''));
          $('fmList').innerHTML = '<p class="fm-empty">Sign in to see your memberships. <a href="login.html?next=' + next + '">Sign in</a></p>';
          if ($('fmBuy')) $('fmBuy').innerHTML = '';
          return;
        }
        S.uid = user.uid;
        listen();
        if (pid && $('fmBuy')) loadOffers(pid);
      });
    });
  }

  root.SokoniFitnessMember = {
    _t: { cardHTML: cardHTML, refundState: refundState, attendedOf: attendedOf, statusText: statusText, offersHTML: offersHTML, readFlag: readFlag,
      loadOffers: loadOffers, buy: buy, payNow: payNow, act: act, openQR: openQR, closeQR: closeQR, render: render, state: S,
      REFUND_ELIGIBLE: REFUND_ELIGIBLE, REFUND_USED: REFUND_USED, NOT_ON_SALE: NOT_ON_SALE, start: start, createRefusalText: createRefusalText,
      reviewHTML: reviewHTML, LATE_REFUNDED: LATE_REFUNDED, CREATE_REFUSAL: CREATE_REFUSAL },
  };
  if (root.document && root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start); else start();
})(typeof window !== 'undefined' ? window : this);
