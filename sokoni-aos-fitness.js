/* sokoni-aos-fitness.js — AdminOS "Fitness Memberships" workspace (owner brief §19–20). Self-contained module.
 *
 *   window.SokoniAOSFitness.mount(el)   — renders into el (AdminOS panel #panel-fitness → #fitnessBody)
 *
 * READS (admin, directly under the candidate rules — isAdmin() read on providerMemberships + attendance/events/releases,
 * providerPayouts, adminAudit, and the public featureFlags doc). Every query is bounded (limit ≤ 50, cursor paging):
 *   providerMemberships                [where <one filter> ==] orderBy createdAt desc · limit 25 · startAfter(cursor)
 *   providerMemberships/{id}           the membership document (2f + e3 fields)
 *     /attendance                      orderBy checkedInAt desc · limit 50
 *     /events                          orderBy at desc · limit 50 (2f's append-only lifecycle story)
 *   providerPayouts                    where membershipId == id && sourceType == 'membership' · limit 50
 *   adminAudit                         where hub == 'fitness' [&& action ==] orderBy createdAt desc · limit 50
 *   featureFlags/fitness_membership_sales
 * ACTIONS (admin only; the SERVER enforces role, separation of duties, state and money — this page only asks):
 *   membershipDecideRefund({membershipId, decision:'approve'|'reject', reason})        (2f)
 *   membershipRequestException({membershipId, reason ≥ 10 chars})                       (2f)
 *   fitnessCorrectAttendance({membershipId, attendanceId, reason})                       (e3) — never restores refund eligibility
 *   adminOsDispatch({op:'adminUpdateFeatureFlag', key:'fitness_membership_sales', enabled:<explicit boolean>})
 *     The handler writes `enabled: enabled ?? true` — a call WITHOUT enabled turns sales ON. This module always sends
 *     a boolean, and claims the new state only after re-reading the flag document.
 * No Firestore writes. Unknown renders "—" (never 0). Every server string is escaped. Server refusals are shown verbatim.
 * Inner navigation deliberately does NOT use .tab-bar/.tab-btn: those are AdminOS router tab selectors
 * (scripts/test-adminos-nav-coverage.js requires every one to be deep-linkable). See docs/FITNESS_MEMBERSHIP_UI.md.
 */
(function (root) {
  'use strict';
  var FALLBACK_ESC = function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;');
  };
  function esc(v) { return (typeof root.escapeHTML === 'function' ? root.escapeHTML : FALLBACK_ESC)(v); }
  var DASH = '—', TZ = 'Africa/Nairobi', PAGE = 25, SUB_LIMIT = 50;
  var FLAG_KEY = 'fitness_membership_sales';
  var ID_RE = /^[A-Za-z0-9_-]{6,128}$/;

  /* ── helpers ── */
  function db() { return root.firebase && root.firebase.firestore ? root.firebase.firestore() : null; }
  function call(name, data) {
    var fb = root.firebase;
    if (!fb || typeof fb.functions !== 'function') { var e = new Error('Service unavailable.'); e.code = 'unavailable'; return Promise.reject(e); }
    try { return Promise.resolve(fb.functions().httpsCallable(name)(data)).then(function (r) { return r ? r.data : null; }); }
    catch (err) { return Promise.reject(err); }
  }
  function isCount(n) { return typeof n === 'number' && Number.isInteger(n) && n >= 0; }
  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    var d = null;
    if (v instanceof Date) d = v;
    else if (typeof v === 'string' || typeof v === 'number') d = new Date(v);
    else if (typeof v.toDate === 'function') { try { d = v.toDate(); } catch (_) { d = null; } }
    else if (typeof v.seconds === 'number') d = new Date(v.seconds * 1000);
    else if (typeof v._seconds === 'number') d = new Date(v._seconds * 1000);
    return d && !isNaN(d.getTime()) ? d : null;
  }
  function fmtDT(v) {
    var d = toDate(v); if (!d) return DASH;
    try {
      return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }) + ' ' +
        d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ });
    } catch (_) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }
  function fmtCents(c) {
    if (!isCount(c)) return DASH;
    var k = c / 100;
    return 'KES ' + k.toLocaleString('en-KE', { minimumFractionDigits: k % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function fmtShillings(n) { return isCount(n) ? 'KES ' + n.toLocaleString('en-KE') : DASH; }
  function txt(v) { return v === null || v === undefined || v === '' ? DASH : String(v); }
  function cnt(v) { return isCount(v) ? String(v) : DASH; }
  function bool(v) { return v === true ? 'Yes' : v === false ? 'No' : DASH; }
  function short(id) { return id ? '#' + String(id).slice(-6).toUpperCase() : DASH; }
  function kv(k, v) { return '<div class="afz-kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>'; }
  function errText(e, fallback) {
    if (root.navigator && root.navigator.onLine === false) return 'Unavailable — retry when connected';
    var m = e && e.message ? String(e.message) : fallback;
    var d = e && e.details && typeof e.details === 'object' ? (e.details.reason || e.details.code) : null;
    return d ? m + ' (' + d + ')' : m;
  }

  var STATUS = ['pending_payment', 'active', 'refund_requested', 'refunded', 'expired', 'expired_unused', 'cancelled', 'suspended'];
  var PAY = ['pending', 'paid_held', 'payment_review', 'partially_released', 'released', 'refund_requested', 'refunded', 'refunded_late'];
  var REFUND = ['requested', 'rejected', 'refunded'];
  var FILTER_FIELDS = { status: STATUS, paymentStatus: PAY, 'refund.state': REFUND };
  var AUDIT_ACTIONS = [['', 'All fitness actions'], ['fitness_checkin', 'Check-in'], ['fitness_checkin_duplicate', 'Duplicate check-in'],
    ['fitness_session_completed', 'Session completed'], ['fitness_attendance_corrected', 'Attendance voided (admin)']];

  /* ── WHY the refund is locked: from the SERVER document only (attendedSessions, else refund.attendedSessionsAtRequest).
     Never from the ledger rows this page happened to load — a page of 50 rows is not the count. ── */
  function whyLocked(m) {
    m = m || {};
    var r = m.refund && typeof m.refund === 'object' ? m.refund : {};
    var n = isCount(m.attendedSessions) ? m.attendedSessions : isCount(r.attendedSessionsAtRequest) ? r.attendedSessionsAtRequest : null;
    if (n !== null && n > 0) return 'Member attended ' + n + ' session(s).';
    if (m.refundEligible === false || r.used === true) return 'Membership used — attendance count unavailable (' + DASH + ').';
    return '';
  }

  /* ── render pieces ── */
  function rowHTML(id, m) {
    m = m || {};
    var r = m.refund && typeof m.refund === 'object' ? m.refund : {};
    return '<tr><td><button type="button" class="afz-link" data-afz-act="open" data-id="' + esc(id) + '">' + esc(short(id)) + '</button></td>' +
      '<td>' + esc(txt(m.title)) + '</td><td>' + esc(short(m.providerId)) + '</td><td>' + esc(txt(m.status)) + '</td><td>' + esc(txt(m.paymentStatus)) + '</td>' +
      '<td>' + esc(txt(r.state)) + '</td><td>' + esc(fmtCents(m.priceCents)) + '</td><td>' + esc(fmtDT(m.createdAt)) + '</td></tr>';
  }
  function listHTML() {
    var f = S.filter;
    var sel = function (field, opts) {
      return '<label class="afz-f"><span>' + esc(field) + '</span><select data-afz-filter="' + esc(field) + '" aria-label="Filter by ' + esc(field) + '">' +
        '<option value="">Any</option>' + opts.map(function (o) { return '<option value="' + esc(o) + '"' + (f && f.field === field && f.value === o ? ' selected' : '') + '>' + esc(o) + '</option>'; }).join('') +
        '</select></label>';
    };
    var body = S.listErr ? '<tr><td colspan="8" role="alert">' + esc(S.listErr) + '</td></tr>'
      : S.rows === null ? '<tr><td colspan="8">Loading…</td></tr>'
      : S.rows.length ? S.rows.map(function (x) { return rowHTML(x.id, x.data); }).join('')
      : '<tr><td colspan="8">No memberships match.</td></tr>';
    return '<div class="afz-filters">' + sel('status', STATUS) + sel('paymentStatus', PAY) + sel('refund.state', REFUND) +
      '<p class="afz-sub">One filter at a time (each has one Firestore index). Newest first.</p></div>' +
      '<div class="afz-scroll"><table class="afz-table"><thead><tr><th>Membership</th><th>Plan</th><th>Gym</th><th>Status</th><th>Payment</th><th>Refund</th><th>Price</th><th>Created</th></tr></thead><tbody>' +
      body + '</tbody></table></div>' +
      (S.cursor ? '<button type="button" class="afz-btn" data-afz-act="more">Load more</button>' : '');
  }
  function attRowHTML(mid, a) {
    a = a || {};
    var voided = a.status === 'voided_by_admin';
    return '<li>' + esc(fmtDT(a.checkedInAt)) + ' · ' + esc(txt(a.method)) + ' · ' + esc(txt(a.actorRole)) + ' · <b>' + esc(txt(a.status)) + '</b>' +
      (a.completedAt ? ' · completed ' + esc(fmtDT(a.completedAt)) : '') +
      (voided ? ' · voided ' + esc(fmtDT(a.voidedAt)) + ' — ' + esc(txt(a.voidReason)) : '') +
      (!voided && a.id ? ' <button type="button" class="afz-btn afz-btn-s" data-afz-act="void" data-id="' + esc(a.id) + '">Void</button>' : '') + '</li>';
  }
  function detailHTML(d) {
    var m = d.doc || {};
    var r = m.refund && typeof m.refund === 'object' ? m.refund : null;
    var why = whyLocked(m);
    var open = r && r.state === 'requested';
    var refundBlock = r ? '<div class="afz-grid">' + kv('State', txt(r.state)) + kv('Exception', bool(r.exception)) + kv('Used', bool(r.used)) +
      kv('Attended at request', cnt(r.attendedSessionsAtRequest)) + kv('Requested by', short(r.requestedBy)) + kv('Decided by', short(r.decidedBy)) +
      kv('Decision reason', txt(r.decisionReason)) + kv('Executed', fmtDT(r.executedAt)) + kv('Destination', txt(r.destination)) +
      kv('Wallet credit', fmtShillings(r.walletCreditShillings)) + kv('Ledger', txt(r.ledgerId)) + '</div>' : '<p class="afz-sub">No refund on this membership.</p>';
    var actions = '<div class="afz-actions">' +
      (open ? '<label class="afz-sub" for="afzDecReason">Decision reason</label><textarea id="afzDecReason" class="afz-in" maxlength="500"></textarea>' +
        '<button type="button" class="afz-btn afz-btn-p" data-afz-act="approve">Approve refund</button> <button type="button" class="afz-btn" data-afz-act="reject">Reject refund</button>' +
        '<p class="afz-sub">A different admin from the one who requested must decide — the server refuses otherwise.</p>' : '') +
      (!r || (r.state !== 'requested' && r.state !== 'refunded') ? '<label class="afz-sub" for="afzExcReason">Exception reason (at least 10 characters)</label><textarea id="afzExcReason" class="afz-in" maxlength="500"></textarea>' +
        '<button type="button" class="afz-btn" data-afz-act="exception">Request exception</button>' : '') +
      '<p class="afz-msg" role="status" aria-live="polite" data-afz-msg>' + esc(S.msg || '') + '</p></div>';
    var att = d.att === null ? '<li>' + DASH + ' (attendance could not be read)</li>' : d.att.length ? d.att.map(function (a) { return attRowHTML(d.id, a); }).join('') : '<li>No attendance recorded.</li>';
    var ev = d.events === null ? '<li>' + DASH + ' (events could not be read)</li>' : d.events.length ? d.events.map(function (e) {
      return '<li>' + esc(fmtDT(e.at)) + ' · <b>' + esc(txt(e.type)) + '</b>' + (e.by ? ' · by ' + esc(short(e.by)) : '') +
        (isCount(e.amountCents) ? ' · ' + esc(fmtCents(e.amountCents)) : '') + (e.reason ? ' · ' + esc(String(e.reason)) : '') + '</li>';
    }).join('') : '<li>No events.</li>';
    var po = d.payouts === null ? '<tr><td colspan="6">' + DASH + ' (payouts could not be read)</td></tr>' : d.payouts.length ? d.payouts.map(function (p) {
      return '<tr><td>' + esc(cnt(p.periodIndex)) + '</td><td>' + esc(fmtCents(p.gross)) + '</td><td>' + esc(fmtCents(p.commission)) + '</td><td>' + esc(fmtCents(p.net)) + '</td><td>' +
        esc(txt(p.status)) + '</td><td>' + esc(fmtDT(p.settledAt)) + '</td></tr>';
    }).join('') : '<tr><td colspan="6">No settlement rows.</td></tr>';
    return '<div class="afz-detail"><div class="afz-head"><h3>' + esc(txt(m.title)) + ' · ' + esc(short(d.id)) + '</h3>' +
      '<button type="button" class="afz-btn" data-afz-act="back">Back to list</button></div>' +
      '<p class="afz-sub">Membership ' + esc(d.id) + ' · gym ' + esc(txt(m.providerId)) + ' · member ' + esc(txt(m.buyerUid)) + '</p>' +
      (why ? '<p class="afz-why" data-afz-why><b>Why the refund is locked:</b> ' + esc(why) + '</p>' : '') +
      '<h4>Payment</h4><div class="afz-grid">' + kv('Payment status', txt(m.paymentStatus)) + kv('Payment ref', txt(m.paymentRef)) + kv('Held', fmtCents(m.heldCents)) + kv('Price', fmtCents(m.priceCents)) + '</div>' +
      '<h4>Lifecycle</h4><div class="afz-grid">' + kv('Status', txt(m.status)) + kv('Start', fmtDT(m.startAt)) + kv('Ends', fmtDT(m.endsAt)) +
      kv('Released periods', cnt(m.releasedPeriods)) + kv('Released', fmtCents(m.releasedCents)) + kv('Next release', fmtDT(m.nextReleaseAt)) +
      kv('Attended sessions', cnt(m.attendedSessions)) + kv('Voided sessions', cnt(m.voidedSessions)) + kv('Refund eligible', bool(m.refundEligible)) + '</div>' +
      '<h4>Refund</h4>' + refundBlock + actions +
      '<h4>Attendance ledger</h4><p class="afz-sub">Voiding a check-in corrects the session count. It never restores refund eligibility.</p>' +
      '<label class="afz-sub" for="afzVoidReason">Void reason</label><input id="afzVoidReason" class="afz-in" maxlength="500"><ul class="afz-list">' + att + '</ul>' +
      '<h4>Events</h4><ul class="afz-list">' + ev + '</ul>' +
      '<h4>Settlement (providerPayouts · membership)</h4><div class="afz-scroll"><table class="afz-table"><thead><tr><th>Period</th><th>Gross</th><th>Commission</th><th>Net</th><th>Status</th><th>Settled</th></tr></thead><tbody>' + po + '</tbody></table></div></div>';
  }
  function auditRowHTML(a) {
    a = a || {};
    var outcome = a.outcome === 'refused' ? 'Refused' + (a.reason ? ' (' + a.reason + ')' : '') : a.outcome === 'ok' ? 'OK' + (a.duplicate === true ? ' (duplicate)' : '') : DASH;
    return '<tr><td>' + esc(fmtDT(a.createdAt)) + '</td><td>' + esc(txt(a.action)) + '</td><td>' + esc(outcome) + '</td><td>' + esc(short(a.membershipId)) + '</td>' +
      '<td>' + esc(short(a.providerId)) + '</td><td>' + esc(short(a.performedBy)) + (a.actorRole ? ' · ' + esc(a.actorRole) : '') + '</td><td>' + esc(txt(a.method)) + '</td>' +
      '<td>' + esc(a.firstCheckIn === true ? 'First check-in' : '') + '</td></tr>';
  }
  function auditHTML() {
    var body = S.auditErr ? '<tr><td colspan="8" role="alert">' + esc(S.auditErr) + '</td></tr>' : S.audit === null ? '<tr><td colspan="8">Loading…</td></tr>'
      : S.audit.length ? S.audit.map(auditRowHTML).join('') : '<tr><td colspan="8">No fitness audit entries.</td></tr>';
    return '<label class="afz-f"><span>Action</span><select data-afz-audit aria-label="Filter check-in audit by action">' +
      AUDIT_ACTIONS.map(function (a) { return '<option value="' + esc(a[0]) + '"' + (S.auditAction === a[0] ? ' selected' : '') + '>' + esc(a[1]) + '</option>'; }).join('') + '</select></label>' +
      '<p class="afz-sub">From adminAudit (hub fitness), written by the server on every check-in, completion and correction — refusals included. Method is shown only where the entry records it.</p>' +
      '<div class="afz-scroll"><table class="afz-table"><thead><tr><th>Time</th><th>Action</th><th>Result</th><th>Membership</th><th>Gym</th><th>Actor</th><th>Method</th><th></th></tr></thead><tbody>' +
      body + '</tbody></table></div>' + (S.auditCursor ? '<button type="button" class="afz-btn" data-afz-act="audit-more">Load more</button>' : '');
  }
  /* Flag state from the document: ON only when enabled === true (the server's own predicate). */
  function flagState(snap) {
    if (snap === null) return { known: false, label: DASH, on: null };
    if (!snap.exists) return { known: true, label: 'OFF (not set)', on: false };
    var v = snap.data() || {};
    if (v.enabled === true) return { known: true, label: 'ON', on: true };
    return { known: true, label: 'OFF' + (v.enabled === false ? '' : ' (enabled is not the boolean true)'), on: false };
  }
  function flagHTML() {
    var f = S.flag || { known: false, label: DASH, on: null };
    return '<div class="afz-flag"><p>Membership sales: <b data-afz-flag>' + esc(f.label) + '</b></p>' +
      '<p class="afz-sub">featureFlags/' + FLAG_KEY + '. Sales are open only when enabled is the boolean true; the server checks it on every purchase.</p>' +
      (f.known ? '<button type="button" class="afz-btn ' + (f.on ? '' : 'afz-btn-p') + '" data-afz-act="flag" data-id="' + (f.on ? 'off' : 'on') + '">' + (f.on ? 'Turn sales OFF' : 'Turn sales ON') + '</button>' : '') +
      '<p class="afz-sub">Only a Super Admin can change this; the server refuses others.</p><p class="afz-msg" role="status" aria-live="polite" data-afz-flagmsg>' + esc(S.flagMsg || '') + '</p></div>';
  }

  var CSS = '.afz{font-size:13px;color:var(--aos-text,#e8e8e8);max-width:100%;overflow-x:hidden}.afz *{box-sizing:border-box}' +
    '.afz-nav{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:12px}.afz-nav button[aria-pressed="true"]{background:var(--aos-accent,#71ff00);color:#000}' +
    '.afz-btn{min-height:40px;padding:8px 12px;border-radius:8px;border:1px solid var(--aos-border,#262626);background:var(--aos-surface,#141414);color:inherit;font-weight:700;cursor:pointer}' +
    '.afz-btn-p{background:var(--aos-accent,#71ff00);color:#000;border:none}.afz-btn-s{min-height:32px;padding:4px 8px}' +
    '.afz-link{background:none;border:none;color:var(--aos-accent,#71ff00);font-weight:700;cursor:pointer;padding:4px}' +
    '.afz button:focus-visible,.afz select:focus-visible,.afz textarea:focus-visible,.afz input:focus-visible{outline:2px solid var(--aos-accent,#71ff00);outline-offset:2px}' +
    '.afz-filters{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end;margin-bottom:8px}.afz-f{display:flex;flex-direction:column;gap:2px}' +
    '.afz-f select,.afz-in{min-height:40px;border-radius:8px;border:1px solid var(--aos-border,#262626);background:var(--aos-surface,#141414);color:inherit;padding:6px 8px}' +
    '.afz-in{width:100%;max-width:520px;display:block;margin:4px 0}textarea.afz-in{min-height:60px}' +
    '.afz-scroll{overflow-x:auto;max-width:100%}.afz-table{width:100%;border-collapse:collapse;min-width:640px}.afz-table th,.afz-table td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--aos-border,#262626);overflow-wrap:anywhere}' +
    '.afz-sub{font-size:12px;color:var(--aos-muted,#888);margin:4px 0}.afz-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;margin:6px 0}' +
    '@media(min-width:900px){.afz-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}.afz-kv span{display:block;font-size:11px;color:var(--aos-muted,#888)}.afz-kv b{overflow-wrap:anywhere}' +
    '.afz-head{display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap}.afz-head h3{margin:0;overflow-wrap:anywhere}' +
    '.afz-why{border:1px solid rgba(255,184,0,.5);background:rgba(255,184,0,.08);border-radius:8px;padding:8px 10px}' +
    '.afz-list{padding-left:18px}.afz-list li{margin:4px 0;overflow-wrap:anywhere}.afz-msg{min-height:1em;overflow-wrap:anywhere}.afz-actions{margin:8px 0}';

  /* ── state ── */
  var S = { el: null, view: 'memberships', filter: null, rows: null, cursor: null, listErr: '', detail: null, msg: '', busy: false,
    audit: null, auditCursor: null, auditErr: '', auditAction: '', flag: null, flagMsg: '' };
  var VIEWS = [['memberships', 'Memberships'], ['checkins', 'Check-ins audit'], ['sales', 'Sales switch']];

  function render() {
    if (!S.el) return;
    var nav = '<div class="afz-nav" role="group" aria-label="Fitness views">' + VIEWS.map(function (v) {
      return '<button type="button" class="afz-btn" data-afz-act="view" data-id="' + v[0] + '" aria-pressed="' + (S.view === v[0] && !S.detail) + '">' + v[1] + '</button>';
    }).join('') + '</div>';
    var body = S.detail ? (S.detail.loading ? '<p>Loading…</p>' : S.detail.error ? '<p role="alert">' + esc(S.detail.error) + '</p><button type="button" class="afz-btn" data-afz-act="back">Back to list</button>' : detailHTML(S.detail))
      : S.view === 'checkins' ? auditHTML() : S.view === 'sales' ? flagHTML() : listHTML();
    S.el.innerHTML = '<div class="afz"><style>' + CSS + '</style>' + nav + body + '</div>';
  }

  /* ── reads ── */
  function loadList(append) {
    var d = db(); if (!d) { S.listErr = 'Firestore unavailable.'; render(); return Promise.resolve(); }
    if (!append) { S.rows = null; S.cursor = null; S.listErr = ''; render(); }
    var q = d.collection('providerMemberships');
    if (S.filter) q = q.where(S.filter.field, '==', S.filter.value);
    q = q.orderBy('createdAt', 'desc').limit(PAGE);
    if (append && S.cursor) q = q.startAfter(S.cursor);
    var token = S.listToken = {};
    return q.get().then(function (snap) {
      if (S.listToken !== token) return;
      var docs = (snap && snap.docs) || [];
      var rows = docs.map(function (x) { return { id: x.id, data: x.data() || {} }; });
      S.rows = append ? (S.rows || []).concat(rows) : rows;
      S.cursor = docs.length === PAGE ? docs[docs.length - 1] : null;
      render();
    }, function (e) { if (S.listToken !== token) return; S.listErr = errText(e, 'Memberships could not be loaded.'); S.rows = S.rows || []; render(); });
  }
  function subGet(q) { return q.get().then(function (s) { return ((s && s.docs) || []).map(function (x) { var o = x.data() || {}; o.id = x.id; return o; }); }, function () { return null; }); }
  function openDetail(id) {
    if (!ID_RE.test(String(id || ''))) return Promise.resolve();
    var d = db(); if (!d) return Promise.resolve();
    S.detail = { id: id, loading: true }; S.msg = ''; render();
    var ref = d.collection('providerMemberships').doc(id);
    return Promise.all([
      ref.get().then(function (s) { return s && s.exists ? (s.data() || {}) : false; }, function (e) { return { __err: e }; }),
      subGet(ref.collection('attendance').orderBy('checkedInAt', 'desc').limit(SUB_LIMIT)),
      subGet(ref.collection('events').orderBy('at', 'desc').limit(SUB_LIMIT)),
      subGet(d.collection('providerPayouts').where('membershipId', '==', id).where('sourceType', '==', 'membership').limit(SUB_LIMIT)),
    ]).then(function (r) {
      if (!S.detail || S.detail.id !== id) return;
      if (r[0] === false) { S.detail = { id: id, error: 'Membership not found.' }; render(); return; }
      if (r[0] && r[0].__err) { S.detail = { id: id, error: errText(r[0].__err, 'Membership could not be loaded.') }; render(); return; }
      var po = r[3] === null ? null : r[3].slice().sort(function (a, b) { return (isCount(a.periodIndex) ? a.periodIndex : 1e9) - (isCount(b.periodIndex) ? b.periodIndex : 1e9); });
      S.detail = { id: id, doc: r[0], att: r[1], events: r[2], payouts: po };
      render();
    });
  }
  function loadAudit(append) {
    var d = db(); if (!d) { S.auditErr = 'Firestore unavailable.'; render(); return Promise.resolve(); }
    if (!append) { S.audit = null; S.auditCursor = null; S.auditErr = ''; render(); }
    var q = d.collection('adminAudit').where('hub', '==', 'fitness');
    if (S.auditAction) q = q.where('action', '==', S.auditAction);
    q = q.orderBy('createdAt', 'desc').limit(SUB_LIMIT);
    if (append && S.auditCursor) q = q.startAfter(S.auditCursor);
    var token = S.auditToken = {};
    return q.get().then(function (snap) {
      if (S.auditToken !== token) return;
      var docs = (snap && snap.docs) || [];
      var rows = docs.map(function (x) { return x.data() || {}; });
      S.audit = append ? (S.audit || []).concat(rows) : rows;
      S.auditCursor = docs.length === SUB_LIMIT ? docs[docs.length - 1] : null;
      render();
    }, function (e) { if (S.auditToken !== token) return; S.auditErr = errText(e, 'Audit entries could not be loaded.'); S.audit = S.audit || []; render(); });
  }
  function readFlag() {
    var d = db(); if (!d) { S.flag = flagState(null); render(); return Promise.resolve(S.flag); }
    return d.collection('featureFlags').doc(FLAG_KEY).get().then(function (s) { S.flag = flagState(s); render(); return S.flag; },
      function () { S.flag = flagState(null); render(); return S.flag; });
  }

  /* ── actions (server decides; the page only asks, after a confirm) ── */
  function confirmOk(message) { try { return typeof root.confirm === 'function' ? root.confirm(message) === true : false; } catch (_) { return false; } }
  function actMsg(t) { S.msg = t; render(); }
  function afterAction(id, okText) { return openDetail(id).then(function () { S.msg = okText; render(); }); }
  function decide(id, decision, reason) {
    if (S.busy || !ID_RE.test(String(id || ''))) return Promise.resolve(false);
    if (decision !== 'approve' && decision !== 'reject') return Promise.resolve(false);
    reason = String(reason || '').trim();
    if (reason.length < 3) { actMsg('Write a decision reason first.'); return Promise.resolve(false); }
    if (!confirmOk((decision === 'approve' ? 'Approve' : 'Reject') + ' the refund on membership ' + short(id) + '? ' +
      (decision === 'approve' ? 'SOKONI credits the held amount to the member\'s SOKONI wallet.' : 'The member keeps the membership.'))) return Promise.resolve(false);
    S.busy = true; actMsg('Sending decision…');
    return call('membershipDecideRefund', { membershipId: id, decision: decision, reason: reason }).then(function (r) {
      return afterAction(id, 'Server recorded: ' + txt(r && r.state)).then(function () { return true; });
    }, function (e) { actMsg(errText(e, 'The decision was not accepted.')); return false; }).then(function (x) { S.busy = false; return x; });
  }
  function requestException(id, reason) {
    if (S.busy || !ID_RE.test(String(id || ''))) return Promise.resolve(false);
    reason = String(reason || '').trim();
    if (reason.length < 10) { actMsg('An exception needs a written reason (at least 10 characters).'); return Promise.resolve(false); }
    if (!confirmOk('Open a refund exception on membership ' + short(id) + '? A second admin must still approve it.')) return Promise.resolve(false);
    S.busy = true; actMsg('Sending…');
    return call('membershipRequestException', { membershipId: id, reason: reason }).then(function () {
      return afterAction(id, 'Exception opened — awaiting a second admin\'s decision.').then(function () { return true; });
    }, function (e) { actMsg(errText(e, 'The exception was not accepted.')); return false; }).then(function (x) { S.busy = false; return x; });
  }
  function voidAttendance(id, attendanceId, reason) {
    if (S.busy || !ID_RE.test(String(id || '')) || !/^[A-Za-z0-9_-]{1,80}$/.test(String(attendanceId || ''))) return Promise.resolve(false);
    reason = String(reason || '').trim();
    if (reason.length < 3) { actMsg('Write a reason for the correction first.'); return Promise.resolve(false); }
    if (!confirmOk('Void check-in ' + attendanceId + '? It is removed from the session count. This NEVER restores refund eligibility — the refund lock stays.')) return Promise.resolve(false);
    S.busy = true; actMsg('Sending correction…');
    return call('fitnessCorrectAttendance', { membershipId: id, attendanceId: String(attendanceId), reason: reason }).then(function (r) {
      return afterAction(id, r && r.duplicate ? 'Already voided — nothing changed.' : 'Check-in voided. Refund lock unchanged.').then(function () { return true; });
    }, function (e) { actMsg(errText(e, 'The correction was not accepted.')); return false; }).then(function (x) { S.busy = false; return x; });
  }
  /* enabled is ALWAYS an explicit boolean: adminUpdateFeatureFlag writes `enabled ?? true`. */
  function setSales(on) {
    if (S.busy || (on !== true && on !== false)) return Promise.resolve(false);
    if (!confirmOk('Turn membership sales ' + (on ? 'ON' : 'OFF') + ' for every gym on SOKONI?')) return Promise.resolve(false);
    S.busy = true; S.flagMsg = 'Saving…'; render();
    return call('adminOsDispatch', { op: 'adminUpdateFeatureFlag', key: FLAG_KEY, enabled: on === true, description: 'Fitness membership sales (AdminOS Fitness)' }).then(function () {
      return readFlag().then(function (f) {
        S.flagMsg = f.known && f.on === on ? 'Sales are now ' + (on ? 'ON' : 'OFF') + ' (read back from the flag).' : 'The server answered, but the flag reads ' + f.label + ' — reload and check.';
        render(); return f.on === on;
      });
    }, function (e) { S.flagMsg = errText(e, 'The change was not accepted.'); render(); return false; }).then(function (x) { S.busy = false; return x; });
  }

  function val(id) { var e = root.document && root.document.getElementById(id); return e ? e.value : ''; }
  function act(name, arg) {
    if (name === 'view') { S.detail = null; S.view = arg; if (arg === 'checkins') return loadAudit(); if (arg === 'sales') return readFlag(); return loadList(); }
    if (name === 'open') return openDetail(arg);
    if (name === 'back') { S.detail = null; S.view = 'memberships'; render(); return Promise.resolve(); }
    if (name === 'more') return loadList(true);
    if (name === 'audit-more') return loadAudit(true);
    if (name === 'approve' || name === 'reject') return decide(S.detail && S.detail.id, name, val('afzDecReason'));
    if (name === 'exception') return requestException(S.detail && S.detail.id, val('afzExcReason'));
    if (name === 'void') return voidAttendance(S.detail && S.detail.id, arg, val('afzVoidReason'));
    if (name === 'flag') return setSales(arg === 'on');
    return Promise.resolve();
  }
  function setFilter(field, value) {
    if (!Object.prototype.hasOwnProperty.call(FILTER_FIELDS, field)) return Promise.resolve();
    S.filter = value && FILTER_FIELDS[field].indexOf(value) >= 0 ? { field: field, value: value } : null;
    return loadList();
  }
  function setAuditAction(a) {
    S.auditAction = AUDIT_ACTIONS.some(function (x) { return x[0] === a; }) ? a : '';
    return loadAudit();
  }

  function mount(el) {
    if (!el) return false;
    var first = S.el !== el;
    S.el = el;
    if (first && el.addEventListener) {
      el.addEventListener('click', function (e) {
        var t = e && e.target && e.target.closest ? e.target.closest('[data-afz-act]') : null;
        if (t && !t.disabled) act(t.getAttribute('data-afz-act'), t.getAttribute('data-id'));
      });
      el.addEventListener('change', function (e) {
        var t = e && e.target; if (!t || !t.getAttribute) return;
        var f = t.getAttribute('data-afz-filter');
        if (f) return setFilter(f, t.value);
        if (t.hasAttribute && t.hasAttribute('data-afz-audit')) return setAuditAction(t.value);
      });
    }
    S.detail = null; S.view = 'memberships';
    loadList();
    return true;
  }

  root.SokoniAOSFitness = {
    mount: mount,
    _t: { state: S, act: act, setFilter: setFilter, setAuditAction: setAuditAction, decide: decide, requestException: requestException,
      voidAttendance: voidAttendance, setSales: setSales, readFlag: readFlag, openDetail: openDetail, loadList: loadList, loadAudit: loadAudit,
      whyLocked: whyLocked, flagState: flagState, detailHTML: detailHTML, render: render, FLAG_KEY: FLAG_KEY },
  };
})(typeof window !== 'undefined' ? window : this);
