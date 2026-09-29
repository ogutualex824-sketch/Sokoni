/* ============================================================================
   SOKONI Verification Review — sokoni-verification-review.js   v1.0.0
   ============================================================================
   The ONE reviewer for badge/tier verification requests, mounted by the canonical
   admin workspace:

     admin-os.html    → Applications & Verification → tab "Verification requests"
                        route  #applications/verification
     super-admin.html → reaches the same tab through its AdminOS link

   It replaces the review logic that lived only in verification-admin.html, which
   ran its own Firebase app and took the reviewer's identity from localStorage.
   Here the identity is the page's real session (firebase.auth().currentUser) and
   every write goes through the same client SDK the standalone page used, so the
   SAME Firestore rules decide — this file invents no permission and hides nothing
   the rules would allow.

   DATA (all canonical; rules quoted from the SERVED ruleset, 2026-09-29):
     verificationRequests/{id}   applicant-written (create needs applicantUid == auth.uid
                                 and status 'pending'); admin update/read.
     verifications/{uid}         the BADGE. create: only the applicant, own uid, status
                                 'pending', no verifiedAt/approvedBy. update: admin.
                                 sokoni-verifications.js renders `status == 'approved'`.
     users/{uid}                 verifiedTier / verifiedAt / isVerified projection (admin update).
     adminLog/{id}               admin create.
   Notifications go through the ONE sender (functions/notify.js → notifySend), never a
   raw notifications write with an invented shape.

   FAIL CLOSED, IN THIS ORDER
   --------------------------
   An approval issues the badge FIRST (update verifications/{applicantUid}); only if
   that write is accepted does the request become 'approved'. The standalone page did
   it the other way round, so a refused badge write left a request marked approved
   with no badge — an "approved" the applicant could never see. A request whose
   applicant never created their own pending badge record (every legacy request, and
   any submitted while verification.html lacked applicantUid) CANNOT be approved from
   a browser: the rules let only the applicant create that document. The card says
   so and offers no Approve button that would fail after half the writes.

   NO SUCCESS UNTIL THE DATABASE SAYS SO. Nothing here reports an outcome before the
   write that constitutes it has resolved.
   ========================================================================== */
(function (global) {
  'use strict';

  var COLL_REQ = 'verificationRequests', COLL_BADGE = 'verifications';
  var STATUSES = ['pending', 'under_review', 'approved', 'rejected'];
  var LABEL = { pending: 'Pending', under_review: 'Under review', approved: 'Approved', rejected: 'Rejected' };
  var TIER = {
    'Verified Business':       '&#x2705;', 'Verified Professional': '&#x1F393;', 'Verified Driver': '&#x1F697;',
    'Verified Doctor':         '&#x1F3E5;', 'Verified Lawyer':       '&#x2696;&#xFE0F;', 'Verified Property Agent': '&#x1F3D8;&#xFE0F;',
  };
  /* The registered type on the ONE sender for a badge approval. There is NO
     registered type for a badge rejection (po_rejected is procurement), so a
     rejection records the decision and says a notice was not sent. */
  var NOTIFY_TYPE_APPROVED = 'seller_verified';

  var _root = null, _all = [], _filter = 'pending', _busy = false, _open = null, _pendingOpen = null, _notice = null;

  function _esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function _db() { return global.firebase.firestore(); }
  function _me() {
    var u = global.firebase && global.firebase.auth && global.firebase.auth().currentUser;
    return u ? { uid: u.uid, email: u.email || '' } : null;
  }
  function _when(ts) {
    try { var d = ts && ts.toDate ? ts.toDate() : (ts ? new Date(ts) : null); return d ? d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; }
    catch (_) { return '—'; }
  }
  function _failure(e) {
    var code = (e && e.code) || '';
    if (/permission-denied/.test(code)) return 'Refused by Firestore rules (permission-denied).';
    if (/unauthenticated/.test(code)) return 'Sign in required.';
    if (/not-found/.test(code)) return 'The record no longer exists.';
    return (e && e.message) ? e.message : String(e);
  }
  function _say(el, cls, html) { if (el) el.innerHTML = '<div class="vr-msg ' + cls + '">' + html + '</div>'; }
  /* After a decision the queue is re-read and the card re-rendered, so the element the
     outcome was written into no longer exists. Reload, keep the card open, and say the
     outcome on the NEW card — otherwise a successful decision shows nothing at all. */
  async function _finish(a, cls, html) {
    await _load(); _open = a.id; _renderList();
    var card = _root.querySelector('.vr-card[data-id="' + a.id + '"]');
    _say(card ? card.querySelector('.vr-out') : null, cls, html);
  }

  /* ── Reads ─────────────────────────────────────────────────────────────── */
  async function _load() {
    var list = _root.querySelector('#vrList');
    list.innerHTML = '<div class="aos-spinner"><div></div></div>';
    try {
      var snap = await _db().collection(COLL_REQ).orderBy('createdAt', 'desc').limit(300).get();
      _all = [];
      snap.forEach(function (d) { _all.push(Object.assign({ id: d.id }, d.data())); });
      /* A record asked for by id (from a ticket) opens on any status filter. */
      if (_pendingOpen) {
        var want = _pendingOpen; _pendingOpen = null;
        if (_all.some(function (x) { return x.id === want; })) { _filter = 'all'; _open = want; _notice = null; }
        else { _open = null; _notice = 'No verification request with id ' + _esc(want) + ' among the ' + _all.length + ' loaded — nothing was opened.'; }
      }
      _renderStats(); _renderList();
      if (_open) { var el = _root.querySelector('.vr-card[data-id="' + _open + '"]'); if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {} } }
    } catch (e) {
      /* A failed read must never look like an empty queue. */
      list.innerHTML = '<div class="empty-state"><span>&#x26A0;&#xFE0F;</span><p><strong>Could not read verification requests.</strong></p>' +
        '<p class="aos-muted">' + _esc(_failure(e)) + '</p><p class="aos-muted">This is not "no requests" — the list could not be read.</p></div>';
      _renderStats(true);
    }
  }
  function _renderStats(unreadable) {
    var s = _root.querySelector('#vrStats'); if (!s) return;
    if (unreadable) { s.innerHTML = ''; return; }
    var monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
    var c = { pending: 0, under_review: 0, rejected: 0, approvedMonth: 0, legacy: 0 };
    _all.forEach(function (a) {
      if (c[a.status] !== undefined) c[a.status]++;
      if (a.status === 'approved') { var t = a.approvedAt || a.createdAt; if (t && t.toDate && t.toDate() >= monthStart) c.approvedMonth++; }
      if (!a.applicantUid) c.legacy++;
    });
    s.innerHTML = [['Pending', c.pending], ['Under review', c.under_review], ['Approved this month', c.approvedMonth], ['Rejected', c.rejected],
                   ['Without applicant record', c.legacy]].map(function (p) {
      return '<div class="delivery-stat"><span>' + p[0] + '</span><strong>' + p[1] + '</strong></div>';
    }).join('');
  }
  function _renderList() {
    var list = _root.querySelector('#vrList');
    var rows = _filter === 'all' ? _all : _all.filter(function (a) { return (a.status || 'pending') === _filter; });
    _root.querySelectorAll('.vr-filter').forEach(function (b) { b.classList.toggle('active', b.dataset.filter === _filter); b.setAttribute('aria-pressed', String(b.dataset.filter === _filter)); });
    /* A notice (an id that was asked for and is not here) sits above the list and
       survives re-renders until the operator changes filter or reloads. */
    var notice = _notice ? '<div class="vr-msg err" id="vrNotice">' + _notice + '</div>' : '';
    if (!rows.length) { list.innerHTML = notice + '<div class="empty-state"><span>&#x1F4ED;</span><p>No verification requests match this filter.</p></div>'; return; }
    list.innerHTML = notice + rows.map(_card).join('');
  }
  function _card(a) {
    var st = a.status || 'pending', legacy = !a.applicantUid, decided = st === 'approved' || st === 'rejected';
    var open = _open === a.id;
    return '<div class="vr-card status-' + _esc(st) + '" data-id="' + _esc(a.id) + '">' +
      '<div class="vr-head">' +
        '<div class="vr-tier" title="' + _esc(a.verifyType || '') + '">' + (TIER[a.verifyType] || '&#x2753;') + '</div>' +
        '<div style="flex:1;min-width:0">' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><strong>' + _esc(a.fullName || '—') + '</strong>' +
            '<span class="status-badge st-' + _esc(st) + '">' + _esc(LABEL[st] || st) + '</span>' +
            (legacy ? '<span class="status-badge st-warn" title="Submitted without a signed-in applicant; no badge record exists to approve">no applicant record</span>' : '') + '</div>' +
          '<div class="aos-muted" style="font-size:12px">' + _esc(a.practiceName || '') + (a.county ? ' &middot; ' + _esc(a.county) : '') + ' &middot; ' + _esc(a.verifyType || '') + '</div>' +
          '<div class="aos-muted" style="font-size:12px">' + _esc(a.email || '') + (a.phone ? ' &middot; ' + _esc(a.phone) : '') + ' &middot; <span class="aos-mono">' + _esc(a.refNumber || a.id) + '</span> &middot; ' + _when(a.createdAt) + '</div>' +
        '</div>' +
        '<button type="button" class="aos-btn-sm" data-act="toggle" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Details') + '</button>' +
      '</div>' +
      (open ? _detail(a, st, legacy, decided) : '') +
    '</div>';
  }
  function _detail(a, st, legacy, decided) {
    var fields = [['National ID', a.idNumber], ['KRA PIN', a.kraPin], ['Address', a.address], ['Links', a.links],
                  ['Applicant uid', a.applicantUid], ['Admin notes', a.adminNotes], ['Rejection reason', a.rejectionReason],
                  ['Approved', a.approvedAt ? _when(a.approvedAt) + ' by ' + (a.approvedBy || '?') : null],
                  ['Rejected', a.rejectedAt ? _when(a.rejectedAt) + ' by ' + (a.rejectedBy || '?') : null]];
    var grid = fields.filter(function (f) { return f[1]; }).map(function (f) {
      return '<div class="vr-kv"><span>' + _esc(f[0]) + '</span><strong>' + _esc(f[1]) + '</strong></div>'; }).join('');
    var actions = '';
    if (!decided) {
      actions += (legacy
        ? '<p class="aos-muted" style="font-size:12px;margin:0 0 8px">Cannot approve from here: the rules let only the applicant create their badge record, and this request has no applicant. Ask them to re-submit from the Verification Centre while signed in.</p>'
        : '<button type="button" class="aos-btn-sm success" data-act="approve">Approve &amp; issue badge</button> ');
      if (st !== 'under_review') actions += '<button type="button" class="aos-btn-sm" data-act="review">Mark under review</button> ';
      actions += '<button type="button" class="aos-btn-sm danger" data-act="reject">Reject&hellip;</button>';
    }
    /* Ticket ↔ record (Slice V2): raise a case ABOUT this request, or see the cases
       already about it. Both go through AdminOS's one ticket dialog / support list. */
    var links = '<button type="button" class="aos-btn-sm" data-act="ticket">Support ticket&hellip;</button> ' +
                '<button type="button" class="aos-btn-sm" data-act="tickets">Related tickets</button>' +
                /* Video verification (Slice V3): only while the decision is open AND the
                   applicant's uid is known — the server needs a subject, and a decided
                   request has nothing left to verify. */
                (_videoEligible(a) ? ' <button type="button" class="aos-btn-sm" data-act="video">Video verification&hellip;</button>' : '') +
                (a.videoVerificationId ? ' <span class="aos-muted" style="font-size:12px">video verification <span class="aos-mono">' + _esc(a.videoVerificationId) + '</span> <button type="button" class="aos-btn-sm" data-act="connect">Connect console</button></span>' : '');
    return '<div class="vr-body">' +
      '<div class="vr-grid">' + grid + '</div>' +
      (a.description ? '<p style="font-size:12.5px;white-space:pre-wrap;margin:8px 0">' + _esc(a.description) + '</p>' : '') +
      '<label class="aos-muted" style="font-size:12px;display:block;margin-top:8px">Admin notes<br><input type="text" class="aos-input" data-f="notes" value="' + _esc(a.adminNotes || '') + '" style="width:100%;max-width:520px"></label>' +
      (!decided ? '<label class="aos-muted" style="font-size:12px;display:block;margin-top:6px">Rejection reason (required to reject; shown to the applicant)<br><input type="text" class="aos-input" data-f="reason" style="width:100%;max-width:520px"></label>' : '') +
      '<div class="vr-actions" style="margin-top:10px">' + actions + (actions ? ' ' : '') + links + '</div>' +
      '<div class="vr-video"></div>' +
      '<div class="vr-out" aria-live="polite"></div>' +
    '</div>';
  }

  /* ── Writes ────────────────────────────────────────────────────────────── */
  function _reqUpdate(id, patch) { return _db().collection(COLL_REQ).doc(id).update(patch); }
  function _log(action, a, extra) {
    var me = _me() || {};
    return _db().collection('adminLog').add(Object.assign({
      action: action + ': ' + (a.refNumber || a.id), adminUid: me.uid || null, adminEmail: me.email || '',
      targetUser: a.fullName || '', tier: a.verifyType || '', docId: a.id,
      createdAt: global.firebase.firestore.FieldValue.serverTimestamp(),
    }, extra || {}));
  }
  async function _notify(uid, type, title, body) {
    try {
      var r = await global.firebase.functions().httpsCallable('notifySend')({ uid: uid, type: type, title: title, body: body });
      return { ok: true, r: r && r.data };
    } catch (e) { return { ok: false, why: _failure(e) }; }
  }

  async function _approve(a, out, notes) {
    var me = _me(); if (!me) { _say(out, 'err', 'Sign in required.'); return; }
    if (!a.applicantUid) { _say(out, 'err', 'No applicant record — cannot issue a badge.'); return; }
    var F = global.firebase.firestore.FieldValue;
    var now = F.serverTimestamp();
    /* 1. THE BADGE, first. If the rules refuse this, nothing else is written. */
    try {
      await _db().collection(COLL_BADGE).doc(a.applicantUid).update({
        status: 'approved', tier: a.verifyType || null, verifyType: a.verifyType || null,
        name: a.fullName || null, business: a.practiceName || null, county: a.county || null,
        description: a.description || null, uid: a.applicantUid, requestId: a.id,
        approvedAt: now, approvedBy: me.email || me.uid, approvedByUid: me.uid,
      });
    } catch (e) {
      _say(out, 'err', '<strong>Not approved.</strong> The badge write was refused, so the request was left as it is: ' + _esc(_failure(e)) +
        (/permission-denied|not-found/.test((e && e.code) || '') ? ' The applicant may not have created their badge record (verifications/' + _esc(a.applicantUid) + ').' : ''));
      return;
    }
    var lines = ['Badge issued (verifications/' + _esc(a.applicantUid) + ').'];
    /* 2. Profile projection — reported, never fatal: the badge is already real. */
    try { await _db().collection('users').doc(a.applicantUid).update({ verifiedTier: a.verifyType || null, verifiedAt: now, isVerified: true }); lines.push('Profile updated.'); }
    catch (e) { lines.push('Profile NOT updated: ' + _esc(_failure(e))); }
    /* 3. The request becomes approved only now. */
    try { await _reqUpdate(a.id, { status: 'approved', approvedAt: now, approvedBy: me.email || me.uid, approvedByUid: me.uid, adminNotes: notes || '' }); lines.push('Request marked approved.'); }
    catch (e) { lines.push('<strong>Request NOT marked approved</strong> (badge is issued): ' + _esc(_failure(e))); }
    /* 4. Log, 5. notify through the one sender — both reported. */
    try { await _log('verify_approved', a, { notes: notes || '' }); } catch (e) { lines.push('Admin log NOT written: ' + _esc(_failure(e))); }
    var n = await _notify(a.applicantUid, NOTIFY_TYPE_APPROVED, "You're verified", 'Your ' + (a.verifyType || 'SOKONI') + ' verification has been approved. Your badge is now live on SOKONI.');
    lines.push(n.ok ? 'Applicant notified.' : 'Applicant NOT notified: ' + _esc(n.why));
    await _finish(a, 'ok', lines.join('<br>'));
  }
  async function _reject(a, out, reason, notes) {
    var me = _me(); if (!me) { _say(out, 'err', 'Sign in required.'); return; }
    if (!reason) { _say(out, 'err', 'A rejection reason is required — it is shown to the applicant.'); return; }
    var now = global.firebase.firestore.FieldValue.serverTimestamp();
    try { await _reqUpdate(a.id, { status: 'rejected', rejectionReason: reason, rejectedAt: now, rejectedBy: me.email || me.uid, rejectedByUid: me.uid, adminNotes: notes || '' }); }
    catch (e) { _say(out, 'err', '<strong>Not rejected.</strong> ' + _esc(_failure(e))); return; }
    var lines = ['Request marked rejected.'];
    try { await _log('verify_rejected', a, { reason: reason }); } catch (e) { lines.push('Admin log NOT written: ' + _esc(_failure(e))); }
    lines.push(a.applicantUid
      ? 'No notice sent: the notification sender has no registered type for a verification rejection (recorded as a follow-up).'
      : 'No notice sent: the request has no applicant uid.');
    await _finish(a, 'ok', lines.join('<br>'));
  }
  async function _review(a, out, notes) {
    var me = _me(); if (!me) { _say(out, 'err', 'Sign in required.'); return; }
    try { await _reqUpdate(a.id, { status: 'under_review', adminNotes: notes || '', reviewedBy: me.email || me.uid, reviewedByUid: me.uid }); }
    catch (e) { _say(out, 'err', _esc(_failure(e))); return; }
    try { await _log('verify_status_update', a, { to: 'under_review' }); } catch (_) {}
    await _finish(a, 'ok', 'Marked under review.');
  }

  /* ── Video verification (Slice V3) ───────────────────────────────────────
     Through SokoniConnectVerify.request — the Connect console's own callable path,
     the same server gate — with the subject prefilled from the request. On success
     the returned verification id is ATTACHED to the request (an admin update the
     rules allow), so the evidence is findable from the record it is about. It is
     evidence, not a verdict: Approve / Reject stay the only decisions. */
  var VIDEO_STATUSES = { pending: 1, under_review: 1, request_info: 1 };
  function _videoEligible(a) { return !!(a && a.applicantUid && VIDEO_STATUSES[a.status || 'pending']); }
  var REASON_BY_TIER = { 'Verified Business': 'business_verification', 'Verified Property Agent': 'business_verification',
    'Verified Driver': 'rider_verification' };
  function _videoForm(a, card) {
    var box = card.querySelector('.vr-video'), out = card.querySelector('.vr-out');
    if (!box) return;
    var V = global.SokoniConnectVerify;
    if (!V || !V.request) { _say(out, 'err', 'The Connect verification module did not load (sokoni-connect-verify.js).'); return; }
    if (!_videoEligible(a)) { _say(out, 'err', 'Not eligible: a video verification needs an open request and a known applicant account.'); return; }
    var def = REASON_BY_TIER[a.verifyType] || 'identity_verification';
    box.innerHTML = '<div class="compose-form" style="margin-top:8px">' +
      '<div class="aos-muted" style="font-size:12px">Opens a SOKONI Connect video verification with <span class="aos-mono">' + _esc(a.applicantUid) + '</span>. The subject sees a consent dialog; recording is OFF; the server refuses to connect until they accept.</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:6px">' +
        '<select class="aos-input" data-v="reason" aria-label="Reason">' + V.REASONS.map(function (r) { return '<option value="' + _esc(r) + '"' + (r === def ? ' selected' : '') + '>' + _esc(r.replace(/_/g, ' ')) + '</option>'; }).join('') + '</select>' +
        '<input class="aos-input" data-v="notes" placeholder="Notes for the record (optional)" maxlength="500" aria-label="Notes">' +
      '</div>' +
      '<button type="button" class="aos-btn" data-v="go" style="margin-top:8px">Open video verification</button>' +
      '<div data-v="out" aria-live="polite"></div></div>';
    var btn = box.querySelector('[data-v="go"]'), vout = box.querySelector('[data-v="out"]');
    btn.onclick = function () {
      btn.disabled = true; btn.textContent = 'Opening…';
      V.request({ subjectUid: a.applicantUid, reason: box.querySelector('[data-v="reason"]').value,
        notes: 'verificationRequests/' + a.id + (a.refNumber ? ' (' + a.refNumber + ')' : '') + (box.querySelector('[data-v="notes"]').value ? ' — ' + box.querySelector('[data-v="notes"]').value : '') })
      .then(function (r) {
        var lines = [V.resultHtml(r)];
        /* ATTACH the evidence to the record it is about. Reported, never fatal: the
           verification exists on the server whether or not this pointer is written. */
        var me = _me() || {};
        return _reqUpdate(a.id, { videoVerificationId: r.verificationId || null, videoSessionId: r.sessionId || null,
          videoRequestedAt: global.firebase.firestore.FieldValue.serverTimestamp(), videoRequestedBy: me.email || me.uid || null })
          .then(function () { lines.push('<span class="aos-muted">Attached to this request as videoVerificationId.</span>'); })
          .catch(function (e) { lines.push('<span class="aos-muted">NOT attached to the request (' + _esc(_failure(e)) + ') — find it in the Connect console by subject.</span>'); })
          .then(function () {
            vout.innerHTML = '<div class="notif-row" style="border-left:3px solid var(--aos-accent);margin-top:8px">' + lines.join('') +
              '<span><button type="button" class="aos-btn-sm" data-act="connect">Connect console</button></span></div>';
            btn.textContent = 'Opened';
          });
      })
      .catch(function (e) {
        btn.disabled = false; btn.textContent = 'Open video verification';
        vout.innerHTML = '<div class="notif-row" style="border-left:3px solid #ff4d4d;margin-top:8px"><span>' + V.failure(e) + '</span></div>';
      });
    };
  }

  /* ── Events ────────────────────────────────────────────────────────────── */
  function _onClick(e) {
    var f = e.target.closest && e.target.closest('.vr-filter');
    if (f) { _filter = f.dataset.filter; _notice = null; _renderList(); return; }
    if (e.target.closest && e.target.closest('#vrReload')) { _notice = null; _load(); return; }
    var b = e.target.closest && e.target.closest('[data-act]'); if (!b) return;
    var card = b.closest('.vr-card'); var id = card && card.dataset.id;
    var a = _all.find(function (x) { return x.id === id; }); if (!a) return;
    var act = b.dataset.act;
    if (act === 'toggle') { _open = _open === id ? null : id; _renderList(); return; }
    var out = card.querySelector('.vr-out');
    if (act === 'ticket') {
      if (global.SokoniAOS && global.SokoniAOS.ticketDialog) global.SokoniAOS.ticketDialog({ requestId: a.id }, 'Verification ' + (a.refNumber || a.id));
      else _say(out, 'err', 'The support dialog is only available inside AdminOS.');
      return;
    }
    if (act === 'tickets') {
      if (global.SokoniAOS && global.SokoniAOS.openTicketsFor) global.SokoniAOS.openTicketsFor({ requestId: a.id });
      else _say(out, 'err', 'The support list is only available inside AdminOS.');
      return;
    }
    if (act === 'connect') { if (global.SokoniAOS) global.SokoniAOS.navigate('comms', 'connect'); return; }
    if (act === 'video') { _videoForm(a, card); return; }
    if (_busy) return;
    var notes = (card.querySelector('[data-f="notes"]') || {}).value || '';
    var reason = ((card.querySelector('[data-f="reason"]') || {}).value || '').trim();
    _busy = true; b.disabled = true;
    var p = act === 'approve' ? _approve(a, out, notes) : act === 'reject' ? _reject(a, out, reason, notes) : act === 'review' ? _review(a, out, notes) : Promise.resolve();
    p.catch(function (e) { _say(out, 'err', _esc(_failure(e))); }).then(function () { _busy = false; b.disabled = false; });
  }

  function _css() {
    if (document.getElementById('vr-css')) return;
    var st = document.createElement('style'); st.id = 'vr-css';
    st.textContent =
      '.vr-filters{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}' +
      '.vr-filter{padding:6px 12px;border-radius:999px;border:1px solid var(--aos-border);background:none;color:var(--aos-muted);font-size:12px;cursor:pointer}' +
      '.vr-filter.active{color:var(--aos-accent);border-color:var(--aos-accent);background:rgba(113,255,0,.08)}' +
      '.vr-filter:focus-visible,.vr-card button:focus-visible{outline:2px solid var(--aos-accent);outline-offset:2px}' +
      '.vr-card{background:var(--aos-surface);border:1px solid var(--aos-border);border-radius:var(--aos-radius);padding:12px 14px;margin-bottom:10px;min-width:0}' +
      '.vr-head{display:flex;gap:12px;align-items:flex-start}' +
      '.vr-tier{width:36px;height:36px;border-radius:10px;background:var(--aos-surface2);display:flex;align-items:center;justify-content:center;font-size:18px;flex:0 0 auto}' +
      '.vr-body{border-top:1px solid var(--aos-border);margin-top:10px;padding-top:10px}' +
      '.vr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}' +
      '.vr-kv span{display:block;font-size:11px;color:var(--aos-muted)}.vr-kv strong{font-size:12.5px;word-break:break-word}' +
      '.vr-msg{margin-top:10px;padding:8px 10px;border-radius:8px;font-size:12.5px;line-height:1.5}' +
      '.vr-msg.ok{background:rgba(113,255,0,.08);border:1px solid rgba(113,255,0,.3)}.vr-msg.err{background:rgba(244,67,54,.08);border:1px solid rgba(244,67,54,.35)}' +
      '.status-badge.st-warn{background:rgba(255,152,0,.15);color:#ffb74d}.status-badge.st-under_review{background:rgba(0,170,255,.15);color:#4fc3f7}';
    document.head.appendChild(st);
  }

  function mount(target) {
    _root = typeof target === 'string' ? document.getElementById(target) : target;
    if (!_root) return false;
    if (!global.firebase || !global.firebase.firestore) {
      _root.innerHTML = '<div class="empty-state"><span>&#x26A0;&#xFE0F;</span><p>Firebase is not available on this page, so verification requests cannot be read.</p></div>';
      return false;
    }
    _css();
    _root.innerHTML =
      '<div class="delivery-stats" id="vrStats"></div>' +
      '<div class="vr-filters" role="group" aria-label="Filter verification requests">' +
        ['pending', 'under_review', 'approved', 'rejected', 'all'].map(function (s) {
          return '<button type="button" class="vr-filter" data-filter="' + s + '" aria-pressed="false">' + (LABEL[s] || 'All') + '</button>'; }).join('') +
        '<button type="button" class="aos-btn-sm" id="vrReload" style="margin-left:auto">&#x1F504; Reload</button>' +
      '</div>' +
      '<div id="vrList"></div>';
    _root.removeEventListener('click', _onClick); _root.addEventListener('click', _onClick);
    _load();
    return true;
  }

  /* open(id): show one request by id — from a support ticket's context chip. If the
     queue is already loaded it opens now; otherwise it opens after the next load. */
  function open(id) {
    id = String(id || ''); if (!id) return;
    if (_all.length && _all.some(function (x) { return x.id === id; })) { _filter = 'all'; _open = id; _renderList();
      var el = _root && _root.querySelector('.vr-card[data-id="' + id + '"]'); if (el && el.scrollIntoView) { try { el.scrollIntoView({ block: 'nearest' }); } catch (_) {} } }
    else { _pendingOpen = id; if (_root && _all.length) _load(); }
  }
  global.SokoniVerificationReview = { mount: mount, reload: _load, open: open, version: '1.1.0', NOTIFY_TYPE_APPROVED: NOTIFY_TYPE_APPROVED };
})(window);
