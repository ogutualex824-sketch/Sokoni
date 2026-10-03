/* sokoni-fitness-memberships.js — Fitness Memberships, gym side (provider workspace module) + shared core.
 *
 * THE BROWSER ONLY REQUESTS AND DISPLAYS (owner 2026-10-03). Every figure on this screen comes from a server answer:
 *   fitnessScannerStatus()                       → may this account scan, and if not, the REAL reason
 *   fitnessGymMemberships({status, limit, cursor}) → the gym's memberships (server-scoped to the caller's gym)
 *   fitnessGymMembership({membershipId})         → one membership + attendance ledger + settlement rows
 *   fitnessCheckIn({token})                      → the ONLY thing that records attendance
 *   providerServices (read-only query)           → the gym's membership offers, listed, never written
 * Nothing here writes Firestore. "ATTENDANCE RECORDED" is rendered ONLY from a fitnessCheckIn response.
 * Unknown values render "—"; an uncapped membership renders "Unlimited"; nothing is guessed.
 *
 * VISIBILITY is the server workspace's decision (b2 shell, sokoni-business-workspace.js): this module renders only when
 * window.__sokoniWorkspace.modules.memberships.state === 'AVAILABLE' (or the sokoni:workspace event says so). It makes
 * no second call to decide visibility. fitnessScannerStatus decides ONLY the scan button's enable state and reason.
 *
 * Mount: provider-dashboard.html → P.show('memberships') → SokoniFitnessMemberships.mount(_q('mbList')).
 * The member page (fitness-memberships.html + sokoni-fitness-member.js) reuses the shared core (._core).
 * See docs/FITNESS_MEMBERSHIP_UI.md.
 */
(function (root) {
  'use strict';

  /* ── escaping: the canonical escapeHTML from security.js; identical fallback if the page lacks it ── */
  var FALLBACK_ESC = function (s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;').replace(/\//g, '&#x2F;').replace(/`/g, '&#x60;');
  };
  function esc(v) { return (typeof root.escapeHTML === 'function' ? root.escapeHTML : FALLBACK_ESC)(v); }

  var DASH = '—';
  var OFFLINE_TEXT = 'Attendance unavailable — retry when connected';
  var TZ = 'Africa/Nairobi';

  /* ── callables: the same client path as sokoni-book-service.js (compat httpsCallable over firebase.js, App Check on) ── */
  function call(name, data) {
    var fb = root.firebase;
    if (!fb || typeof fb.functions !== 'function') {
      var e = new Error('Service unavailable.'); e.code = 'unavailable'; return Promise.reject(e);
    }
    try {
      return Promise.resolve(fb.functions().httpsCallable(name)(data || {})).then(function (r) { return r ? r.data : null; });
    } catch (err) { return Promise.reject(err); }
  }

  /* ── value helpers ── */
  function isCount(n) { return typeof n === 'number' && Number.isInteger(n) && n >= 0; }
  function toDate(v) {
    if (v === null || v === undefined || v === '') return null;
    var d = null;
    if (v instanceof Date) d = v;
    else if (typeof v === 'number') d = new Date(v);
    else if (typeof v === 'string') d = new Date(v);
    else if (typeof v.toDate === 'function') { try { d = v.toDate(); } catch (_) { d = null; } }
    else if (typeof v._seconds === 'number') d = new Date(v._seconds * 1000);
    else if (typeof v.seconds === 'number') d = new Date(v.seconds * 1000);
    return d && !isNaN(d.getTime()) ? d : null;
  }
  function fmtDate(v) {
    var d = toDate(v); if (!d) return DASH;
    try { return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric', timeZone: TZ }); }
    catch (_) { return d.toISOString().slice(0, 10); }
  }
  function fmtTime(v) {   /* HH:MM, 24h, Nairobi */
    var d = toDate(v); if (!d) return DASH;
    try { return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: TZ }); }
    catch (_) { return d.toISOString().slice(11, 16); }
  }
  function fmtDateTime(v) { var d = toDate(v); return d ? fmtDate(d) + ' ' + fmtTime(d) : DASH; }
  /* integer cents → "KES 3,500" (UI only). Anything that is not integer cents is unknown. */
  function fmtKES(cents) {
    if (typeof cents !== 'number' || !Number.isInteger(cents) || cents < 0) return DASH;
    var kes = cents / 100;
    return 'KES ' + kes.toLocaleString('en-KE', { minimumFractionDigits: kes % 1 ? 2 : 0, maximumFractionDigits: 2 });
  }
  function shortRef(id) { return id ? '#' + String(id).slice(-6).toUpperCase() : DASH; }
  function periodText(count, unit) {
    if (!isCount(count) || count < 1) return DASH;
    var u = unit === 'month' || !unit ? 'month' : String(unit);
    return count + ' ' + u + (count === 1 ? '' : 's');
  }

  /* Session cap. `absentMeans` says what a MISSING field means for this source:
     - membership DOCUMENT (contract): sessionsIncluded absent = unlimited in period → 'unlimited'
     - callable RESPONSE: key absent = the server did not say → 'unknown'
     null (explicit) = no cap = Unlimited. A positive integer = the cap. Anything else = unknown. */
  function capOf(obj, key, absentMeans) {
    if (!obj || !(key in obj) || obj[key] === undefined) return absentMeans === 'unlimited' ? { unlimited: true } : { unknown: true };
    var v = obj[key];
    if (v === null) return { unlimited: true };
    if (isCount(v) && v > 0) return { cap: v };
    return { unknown: true };
  }
  function capText(c) { return c.unlimited ? 'Unlimited' : c.unknown ? DASH : String(c.cap); }
  function countText(n) { return isCount(n) ? String(n) : DASH; }

  /* remaining sessions: a server-provided `remaining` wins; otherwise cap − attended when BOTH are known. */
  function remainingText(obj, absentMeans) {
    var c = capOf(obj, 'sessionsIncluded', absentMeans);
    if (obj && 'remaining' in obj && obj.remaining !== undefined) {
      if (isCount(obj.remaining)) return String(obj.remaining);
      if (obj.remaining === null && c.unlimited) return 'Unlimited';
      return DASH;
    }
    if (c.unlimited) return 'Unlimited';
    if (c.cap && isCount(obj.attendedSessions)) return String(Math.max(0, c.cap - obj.attendedSessions));
    return DASH;
  }

  /* "Session N of M" — N and M straight from the server answer; M = "Unlimited" when uncapped. */
  function sessionLine(res) {
    return 'Session ' + countText(res && res.attendedSessions) + ' of ' + capText(capOf(res, 'sessionsIncluded', 'unknown'));
  }

  var STATUS_LABEL = {
    pending_payment: 'Waiting for payment', active: 'Active', expired: 'Expired', refund_requested: 'Refund requested',
    refunded: 'Refunded', cancelled: 'Cancelled', suspended: 'Suspended', completed: 'Completed', disputed: 'Disputed',
  };
  var PAY_LABEL = {
    pending: 'Awaiting payment', paid_held: 'Paid · held by SOKONI', payment_review: 'Payment under review',
    partially_released: 'Partly released to gym', released: 'Released to gym', refund_requested: 'Refund requested',
    refunded: 'Refunded',
  };
  function label(map, v) { return v === null || v === undefined || v === '' ? DASH : (map[v] || String(v)); }

  /* ── check-in refusals: the server's reason code → human text (owner reject list) ── */
  var REFUSAL = {
    token_invalid: 'This QR code is not valid. Ask the member to refresh it in their app.',
    token_expired: 'This QR code has expired. Ask the member to refresh it in their app.',
    not_found: 'Membership not found.',
    expired: 'This membership has expired.',
    cancelled: 'This membership has been cancelled.',
    suspended: 'This membership is suspended.',
    wrong_member: 'This QR code does not belong to this membership holder.',
    not_covered: 'This membership does not cover a session right now.',
    other_gym: 'This membership is for a different gym.',
    entitlement_exhausted: 'All sessions on this membership have been used.',
    no_permission: "You don't have permission to record attendance for this gym.",
    self_scan: 'You cannot check yourself in.',
  };
  function errCode(err) { return String((err && err.code) || '').replace(/^functions\//, ''); }
  function errReason(err) { var d = err && err.details; return d && typeof d === 'object' && d.reason ? String(d.reason) : null; }
  function isOffline(err) {
    if (root.navigator && root.navigator.onLine === false) return true;
    if (!err) return false;
    if (errReason(err)) return false;
    var c = errCode(err), d = err.details;
    if (c === 'unavailable' && d && d.correlationId) return false;           /* the server answered: it failed, not the network */
    return c === 'unavailable' || c === 'deadline-exceeded' || (c === 'internal' && /^internal$/i.test(String(err.message || '')))
      || /network|failed to fetch|load failed/i.test(String(err.message || ''));
  }
  function refusalText(err) {
    if (isOffline(err)) return OFFLINE_TEXT;
    var r = errReason(err);
    if (r && REFUSAL[r]) return REFUSAL[r];
    var c = errCode(err);
    if (c === 'unauthenticated') return 'Your session has ended. Sign in again to record attendance.';
    if (c === 'permission-denied') return REFUSAL.no_permission;
    return (err && err.message) ? String(err.message) : 'Attendance was not recorded.';
  }

  /* ── the check-in result card — built ONLY from the server response ── */
  function memberName(res) {
    var n = res && ((res.member && res.member.displayName) || res.memberName || res.displayName);
    return n ? String(n) : DASH;
  }
  function checkInCardHTML(res) {
    if (!res || res.ok !== true || typeof res.attendanceId !== 'string' || !res.attendanceId) {
      return '<div class="sfm-card sfm-bad" role="alert"><strong>Attendance was not recorded.</strong> The server did not confirm this check-in — scan again.</div>';
    }
    var line = esc(memberName(res)) + ' — Membership ' + esc(shortRef(res.membershipId)) + ' · ' + esc(sessionLine(res)) +
      ' · Check-in: ' + esc(fmtTime(res.checkedInAt));
    if (res.duplicate === true) {
      return '<div class="sfm-card sfm-warn" role="status" data-sfm-result="duplicate"><strong>Already checked in today</strong>' +
        '<div class="sfm-line">' + line + '</div><div class="sfm-sub">Existing record ' + esc(shortRef(res.attendanceId)) +
        ' · ' + esc(label({ checked_in: 'Checked in', completed: 'Completed', voided_by_admin: 'Voided by admin' }, res.status)) + '</div></div>';
    }
    return '<div class="sfm-card sfm-ok" role="status" data-sfm-result="recorded"><strong>ATTENDANCE RECORDED</strong> · ' + line + '</div>';
  }
  function refusalCardHTML(err) {
    var t = refusalText(err);
    var cid = err && err.details && err.details.correlationId ? '<div class="sfm-sub">Ref ' + esc(String(err.details.correlationId).slice(0, 12)) + '</div>' : '';
    return '<div class="sfm-card ' + (t === OFFLINE_TEXT ? 'sfm-warn' : 'sfm-bad') + '" role="alert" data-sfm-result="refused"><strong>' + esc(t) + '</strong>' + cid + '</div>';
  }

  /* ── scanner-status reasons (fitnessScannerStatus) ── */
  function scannerReasonHTML(s) {
    var r = s && s.reason;
    if (r === 'BUSINESS_LINK_MISSING') {
      /* No self-serve "link your business record" surface exists in this tree — support is the real path. */
      return "Your gym isn't linked to a business record yet — <a href=\"support.html\">contact SOKONI support</a> to finish setup.";
    }
    if (r === 'NOT_APPROVED') return "Your gym isn't approved yet. Scanning opens as soon as SOKONI approves it.";
    if (r === 'NO_PERMISSION') return esc(REFUSAL.no_permission);
    if (r) return 'Scanning is unavailable for this account (' + esc(r) + ').';
    return 'Scanning is unavailable for this account.';
  }

  /* ── gym rows ── */
  function refundStateText(r) {
    if (!r || !('refundState' in r) || r.refundState === undefined) return DASH;
    if (r.refundState === null) return 'None';
    return label({ requested: 'Requested', approved: 'Approved', rejected: 'Rejected', executed: 'Refunded', exception_requested: 'Exception requested' }, r.refundState);
  }
  function settlementText(r) {
    var parts = [];
    if (isCount(r.releasedPeriods)) parts.push(r.releasedPeriods + (isCount(r.periodCount) ? ' of ' + r.periodCount : '') + ' month(s) released');
    if (isCount(r.releasedCents)) parts.push(fmtKES(r.releasedCents));
    return parts.join(' · ');
  }
  function kv(k, v, raw) { return '<div class="sfm-kv"><span>' + esc(k) + '</span><b>' + (raw ? v : esc(v)) + '</b></div>'; }
  function rowHTML(r) {
    r = r || {};
    var settle = settlementText(r);
    return '<div class="sfm-row" data-id="' + esc(r.membershipId || '') + '">' +
      '<div class="sfm-row-h"><div><div class="sfm-name">' + esc((r.member && r.member.displayName) || DASH) + '</div>' +
      '<div class="sfm-sub">' + esc(r.title || DASH) + ' · ' + esc(shortRef(r.membershipId)) + '</div></div>' +
      '<span class="sfm-pill">' + esc(label(STATUS_LABEL, r.status)) + '</span></div>' +
      '<div class="sfm-grid">' +
      kv('Start', fmtDate(r.startAt)) + kv('Expiry', fmtDate(r.endsAt)) +
      kv('Sessions included', capText(capOf(r, 'sessionsIncluded', 'unknown'))) + kv('Attended', countText(r.attendedSessions)) +
      kv('Remaining', remainingText(r, 'unknown')) + kv('Last attendance', fmtDateTime(r.lastAttendedAt)) +
      kv('Refund', refundStateText(r)) + kv('Payment', label(PAY_LABEL, r.paymentStatus)) +
      (settle ? kv('Settlement', settle) : '') +
      '</div>' +
      (r.membershipId ? '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="detail" data-id="' + esc(r.membershipId) + '">Details</button>' : '') +
      '</div>';
  }
  var ATT_LABEL = { checked_in: 'Checked in', completed: 'Completed', voided_by_admin: 'Voided by admin' };
  function detailHTML(d) {
    d = d || {};
    var m = d.membership || d;
    var att = Array.isArray(d.attendance) ? d.attendance : [];
    var st = Array.isArray(d.settlement) ? d.settlement : (d.settlement && Array.isArray(d.settlement.rows) ? d.settlement.rows : []);
    var ledger = att.length ? att.map(function (a) {
      return '<li>' + esc(fmtDateTime(a.checkedInAt)) + ' · ' + esc(label(ATT_LABEL, a.status)) + ' · ' + esc(a.method || DASH) +
        (a.actorRole ? ' · by ' + esc(a.actorRole) : '') + (a.completedAt ? ' · completed ' + esc(fmtTime(a.completedAt)) : '') + '</li>';
    }).join('') : '<li>No attendance recorded.</li>';
    var settle = st.length ? st.map(function (p) {
      return '<li>' + esc(fmtDate(p.createdAt || p.releasedAt)) + ' · ' + esc(fmtKES(p.amountCents)) + ' · ' + esc(p.status || DASH) + '</li>';
    }).join('') : '<li>No settlement rows yet.</li>';
    return '<div class="sfm-drawer-h"><div><div class="sfm-name">' + esc((m.member && m.member.displayName) || DASH) + '</div>' +
      '<div class="sfm-sub">' + esc(m.title || DASH) + ' · ' + esc(shortRef(m.membershipId)) + ' · ' + esc(periodText(m.periodCount, m.periodUnit)) + '</div></div>' +
      '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="close" aria-label="Close details">Close</button></div>' +
      '<div class="sfm-grid">' + kv('Status', label(STATUS_LABEL, m.status)) + kv('Payment', label(PAY_LABEL, m.paymentStatus)) +
      kv('Start', fmtDate(m.startAt)) + kv('Expiry', fmtDate(m.endsAt)) +
      kv('Sessions included', capText(capOf(m, 'sessionsIncluded', 'unknown'))) + kv('Attended', countText(m.attendedSessions)) +
      kv('Remaining', remainingText(m, 'unknown')) + kv('Refund', refundStateText(m)) + '</div>' +
      '<h4 class="sfm-h4">Attendance ledger</h4><ul class="sfm-list">' + ledger + '</ul>' +
      '<h4 class="sfm-h4">Settlement</h4><ul class="sfm-list">' + settle + '</ul>' +
      '<p class="sfm-sub">Attendance can only be corrected by SOKONI through an audited correction — never deleted from here.</p>';
  }
  function offerHTML(o) {
    o = o || {};
    var live = o.active !== false && !o.removedAt;
    return '<li><b>' + esc(o.name || DASH) + '</b> · ' + esc(fmtKES(o.price)) + ' · ' + esc(periodText(o.periodCount, o.periodUnit)) +
      ' · ' + (live ? 'Active' : 'Inactive') + '</li>';
  }

  var CSS = '.sfm{font:14px/1.45 system-ui,-apple-system,sans-serif;color:var(--text,#e8e8e8);max-width:100%;overflow-x:hidden}' +
    '.sfm *{box-sizing:border-box}.sfm-top{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}' +
    '.sfm-scan{flex:1 1 100%;min-height:52px;font-size:1rem;font-weight:800;letter-spacing:.3px;border:none;border-radius:12px;background:var(--acc,#71ff00);color:#000;cursor:pointer}' +
    '.sfm-scan[disabled]{background:var(--surf2,#141414);color:var(--sub,#888);cursor:not-allowed;border:1px solid var(--border,#1a1a1a)}' +
    '.sfm-btn{padding:9px 14px;border-radius:10px;border:none;font-weight:700;cursor:pointer;font-size:.85rem;min-height:40px}' +
    '.sfm-btn-p{background:var(--acc,#71ff00);color:#000}.sfm-btn-s{background:var(--surf2,#141414);color:var(--text,#e8e8e8);border:1px solid var(--border,#262626)}' +
    '.sfm button:focus-visible,.sfm a:focus-visible,.sfm textarea:focus-visible{outline:2px solid var(--acc,#71ff00);outline-offset:2px}' +
    '.sfm-note{font-size:.82rem;color:var(--sub,#9a9a9a);flex:1 1 100%}.sfm-note a{color:var(--acc,#71ff00)}' +
    '.sfm-card{border-radius:12px;padding:12px 14px;margin:10px 0;border:1px solid var(--border,#262626);overflow-wrap:anywhere}' +
    '.sfm-ok{background:rgba(113,255,0,.1);border-color:rgba(113,255,0,.4)}.sfm-warn{background:rgba(255,184,0,.08);border-color:rgba(255,184,0,.4)}' +
    '.sfm-bad{background:rgba(255,77,77,.08);border-color:rgba(255,77,77,.4)}.sfm-line{margin-top:4px}' +
    '.sfm-scanbox{border:1px solid var(--border,#262626);border-radius:12px;padding:12px;margin-bottom:10px}' +
    '.sfm-scanbox video{width:100%;max-height:300px;border-radius:10px;background:#000;display:block}' +
    '.sfm-scanbox textarea{width:100%;min-height:64px;margin:8px 0;border-radius:10px;border:1px solid var(--border,#262626);background:var(--surf2,#141414);color:inherit;padding:8px;font:12px monospace}' +
    '.sfm-tabs{display:flex;gap:6px;overflow-x:auto;margin:8px 0}.sfm-tab{flex:0 0 auto}.sfm-tab[aria-selected="true"]{background:var(--acc,#71ff00);color:#000}' +
    '.sfm-row{border:1px solid var(--border,#1a1a1a);background:var(--surf,#0d0d0d);border-radius:12px;padding:12px;margin-bottom:10px}' +
    '.sfm-row-h,.sfm-drawer-h{display:flex;justify-content:space-between;gap:8px;align-items:flex-start;margin-bottom:8px}' +
    '.sfm-name{font-weight:800;overflow-wrap:anywhere}.sfm-sub{font-size:.78rem;color:var(--sub,#888);overflow-wrap:anywhere}' +
    '.sfm-pill{font-size:.7rem;font-weight:700;padding:3px 8px;border-radius:99px;background:var(--surf2,#141414);white-space:nowrap}' +
    '.sfm-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 12px;margin-bottom:8px}@media(min-width:720px){.sfm-grid{grid-template-columns:repeat(4,minmax(0,1fr))}}' +
    '.sfm-kv span{display:block;font-size:.7rem;color:var(--sub,#888)}.sfm-kv b{font-weight:600;overflow-wrap:anywhere}' +
    '.sfm-drawer{border:1px solid var(--acc,#71ff00);border-radius:12px;padding:12px;margin:10px 0;background:var(--surf,#0d0d0d)}' +
    '.sfm-h4{margin:10px 0 4px;font-size:.85rem}.sfm-list{margin:0;padding-left:18px;font-size:.82rem}' +
    '.sfm-offers{margin-top:16px;border-top:1px solid var(--border,#1a1a1a);padding-top:12px}';

  /* ── workspace gate (server answer only) ── */
  function moduleAvailable(w) {
    w = w === undefined ? root.__sokoniWorkspace : w;
    var m = w && w.modules && w.modules.memberships;
    return !!(m && m.state === 'AVAILABLE');
  }

  /* ── gym module state ── */
  var S = { el: null, ui: null, tab: 'active', cursor: null, rows: [], busy: false, canScan: false, scanStop: null, mounted: false };
  var TABS = [['active', 'Active'], ['pending', 'Pending'], ['expired', 'Expired'], ['refund', 'Refunds']];

  function mk(tag, cls, html) {
    var d = root.document.createElement(tag);
    if (cls) d.className = cls;
    if (html !== undefined) d.innerHTML = html;
    return d;
  }

  function unmount(el) {
    stopCamera();
    if (el) { el.innerHTML = ''; el.hidden = true; if (el.setAttribute) el.setAttribute('aria-hidden', 'true'); }
    S.mounted = false; S.ui = null;
  }

  function mount(el) {
    if (!el) return false;
    S.el = el;
    if (!moduleAvailable()) { unmount(el); return false; }
    if (S.mounted && S.ui) { loadTab(S.tab); return true; }
    el.hidden = false; if (el.removeAttribute) el.removeAttribute('aria-hidden');
    el.innerHTML = '';
    var wrap = mk('div', 'sfm');
    wrap.appendChild(mk('style', null, CSS));
    var top = mk('div', 'sfm-top');
    var scan = mk('button', 'sfm-scan'); scan.type = 'button'; scan.textContent = 'SCAN MEMBER QR'; scan.disabled = true;
    scan.setAttribute('aria-describedby', 'sfmScanNote');
    var note = mk('div', 'sfm-note', 'Checking scanner access…'); note.id = 'sfmScanNote'; note.setAttribute('aria-live', 'polite');
    top.appendChild(scan); top.appendChild(note);
    var scanBox = mk('div', 'sfm-scanbox'); scanBox.hidden = true;
    var result = mk('div', 'sfm-result'); result.setAttribute('aria-live', 'assertive');
    var tabs = mk('div', 'sfm-tabs'); tabs.setAttribute('role', 'tablist'); tabs.setAttribute('aria-label', 'Membership status');
    var list = mk('div', 'sfm-rows', '');
    var more = mk('div', 'sfm-more'); more.hidden = true;
    var drawer = mk('div', 'sfm-drawer'); drawer.hidden = true; drawer.setAttribute('role', 'region'); drawer.setAttribute('aria-label', 'Membership details');
    var offers = mk('div', 'sfm-offers');
    [top, scanBox, result, tabs, drawer, list, more, offers].forEach(function (n) { wrap.appendChild(n); });
    el.appendChild(wrap);
    S.ui = { scan: scan, note: note, scanBox: scanBox, result: result, tabs: tabs, list: list, more: more, drawer: drawer, offers: offers };
    scan.addEventListener('click', openScanner);
    el.addEventListener('click', onClick);
    S.mounted = true;
    renderTabs();
    loadStatus();
    loadTab('active');
    loadOffers();
    return true;
  }

  function onClick(e) {
    var t = e && e.target && e.target.closest ? e.target.closest('[data-sfm-act]') : null;
    if (!t) return;
    act(t.getAttribute('data-sfm-act'), t.getAttribute('data-id'));
  }
  function act(name, arg) {
    if (name === 'tab') return loadTab(arg);
    if (name === 'more') return loadTab(S.tab, true);
    if (name === 'detail') return openDetail(arg);
    if (name === 'close') { if (S.ui) S.ui.drawer.hidden = true; return null; }
    if (name === 'status') return loadStatus();
    if (name === 'submit') return submitToken(S.ui && S.ui.paste ? S.ui.paste.value : '');
    if (name === 'stop') { stopCamera(); if (S.ui) S.ui.scanBox.hidden = true; return null; }
    if (name === 'retry') return loadTab(S.tab);
    return null;
  }

  function renderTabs() {
    S.ui.tabs.innerHTML = TABS.map(function (t) {
      return '<button type="button" role="tab" class="sfm-btn sfm-btn-s sfm-tab" data-sfm-act="tab" data-id="' + t[0] + '" aria-selected="' + (S.tab === t[0]) + '">' + t[1] + '</button>';
    }).join('');
  }

  function loadStatus() {
    var ui = S.ui; if (!ui) return Promise.resolve();
    ui.scan.disabled = true; S.canScan = false;
    return call('fitnessScannerStatus', {}).then(function (s) {
      if (!S.ui) return;
      if (s && s.canScan === true) {
        S.canScan = true; ui.scan.disabled = false;
        ui.note.textContent = 'Scan the member’s membership QR. Attendance is recorded only when SOKONI confirms it.';
      } else {
        ui.note.innerHTML = scannerReasonHTML(s);
      }
    }, function (err) {
      if (!S.ui) return;
      ui.note.innerHTML = (isOffline(err) ? esc(OFFLINE_TEXT) : 'Scanner access could not be checked.') +
        ' <button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="status">Retry</button>';
    });
  }

  function loadTab(tab, append) {
    var ui = S.ui; if (!ui) return Promise.resolve();
    if (!TABS.some(function (t) { return t[0] === tab; })) tab = 'active';
    if (!append) { S.tab = tab; S.cursor = null; S.rows = []; renderTabs(); ui.list.innerHTML = '<div class="sfm-sub">Loading memberships…</div>'; }
    var req = { status: tab, limit: 25 };
    if (append && S.cursor) req.cursor = S.cursor;
    var asked = tab;
    return call('fitnessGymMemberships', req).then(function (r) {
      if (!S.ui || S.tab !== asked) return;
      if (!r || !Array.isArray(r.rows)) { ui.list.innerHTML = '<div class="sfm-card sfm-bad" role="alert">Memberships could not be loaded.</div>'; return; }
      S.rows = append ? S.rows.concat(r.rows) : r.rows;
      S.cursor = r.nextCursor || null;
      ui.list.innerHTML = S.rows.length ? S.rows.map(rowHTML).join('') : '<div class="sfm-sub">No memberships in this tab yet.</div>';
      ui.more.hidden = !S.cursor;
      ui.more.innerHTML = S.cursor ? '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="more">Load more</button>' : '';
    }, function (err) {
      if (!S.ui) return;
      ui.list.innerHTML = '<div class="sfm-card sfm-bad" role="alert">' + esc(isOffline(err) ? 'Memberships unavailable — retry when connected' : ((err && err.message) || 'Memberships could not be loaded.')) +
        ' <button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="retry">Retry</button></div>';
    });
  }

  function openDetail(id) {
    var ui = S.ui; if (!ui || !id) return Promise.resolve();
    ui.drawer.hidden = false; ui.drawer.innerHTML = '<div class="sfm-sub">Loading…</div>';
    return call('fitnessGymMembership', { membershipId: String(id) }).then(function (d) {
      if (S.ui) ui.drawer.innerHTML = detailHTML(d);
    }, function (err) {
      if (S.ui) ui.drawer.innerHTML = '<div class="sfm-card sfm-bad" role="alert">' + esc(isOffline(err) ? 'Details unavailable — retry when connected' : ((err && err.message) || 'Details could not be loaded.')) +
        '</div><button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="close">Close</button>';
    });
  }

  /* Membership offers: LISTED from providerServices (the services editor writes them; this module never does). */
  function loadOffers() {
    var ui = S.ui; if (!ui) return Promise.resolve();
    var intro = '<h4 class="sfm-h4">Membership offers</h4><p class="sfm-sub">Members buy these plans. Adding or editing an offer uses your existing Services editor once membership offers are enabled there — this screen only lists them.</p>';
    var fb = root.firebase, user = fb && fb.auth && fb.auth().currentUser;
    if (!fb || !fb.firestore || !user) { ui.offers.innerHTML = intro + '<p class="sfm-sub">' + DASH + '</p>'; return Promise.resolve(); }
    ui.offers.innerHTML = intro + '<p class="sfm-sub">Loading offers…</p>';
    return fb.firestore().collection('providerServices').where('providerId', '==', user.uid).where('serviceKind', '==', 'membership').limit(50).get()
      .then(function (snap) {
        var docs = (snap && snap.docs) || [];
        ui.offers.innerHTML = intro + (docs.length ? '<ul class="sfm-list">' + docs.map(function (d) { return offerHTML(d.data()); }).join('') + '</ul>'
          : '<p class="sfm-sub">No membership offers yet.</p>');
      }, function () { ui.offers.innerHTML = intro + '<p class="sfm-sub">Offers could not be loaded.</p>'; });
  }

  /* ── scanner: camera via the repo's SokoniQR.scan (BarcodeDetector); paste fallback always present ── */
  function ensureQR() {
    if (root.SokoniQR) return Promise.resolve(root.SokoniQR);
    return new Promise(function (resolve) {
      try {
        var s = root.document.createElement('script'); s.src = 'sokoni-qr.js'; s.async = true;
        s.onload = function () { resolve(root.SokoniQR || null); }; s.onerror = function () { resolve(null); };
        root.document.head.appendChild(s);
      } catch (_) { resolve(null); }
    });
  }
  function stopCamera() { if (typeof S.scanStop === 'function') { try { S.scanStop(); } catch (_) {} } S.scanStop = null; }

  function openScanner() {
    var ui = S.ui; if (!ui || !S.canScan) return Promise.resolve();
    if (root.navigator && root.navigator.onLine === false) { ui.result.innerHTML = refusalCardHTML(null); return Promise.resolve(); }
    ui.scanBox.hidden = false;
    ui.scanBox.innerHTML = '<video playsinline muted aria-label="Camera preview for the member QR"></video>' +
      '<div class="sfm-sub" data-sfm-cam>Starting camera…</div>' +
      '<label class="sfm-sub" for="sfmPaste">Or paste the member’s code</label>' +
      '<textarea id="sfmPaste" autocomplete="off" spellcheck="false"></textarea>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="sfm-btn sfm-btn-p" data-sfm-act="submit">Check in</button>' +
      '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="stop">Close scanner</button></div>';
    var q = function (sel) { return ui.scanBox.querySelector ? ui.scanBox.querySelector(sel) : null; };
    S.ui.paste = q('#sfmPaste');
    var video = q('video'), camNote = q('[data-sfm-cam]');
    var unsupported = function () { if (camNote) camNote.textContent = 'Camera scanning isn’t available on this device — paste the member’s code below.'; };
    if (!video || !(root.navigator && root.navigator.mediaDevices)) { unsupported(); return Promise.resolve(); }
    return ensureQR().then(function (QR) {
      if (!QR || typeof QR.scan !== 'function') { unsupported(); return; }
      return QR.scan(video, function (code) { S.scanStop = null; submitToken(code); }).then(function (h) {
        if (!h || h.supported === false) { unsupported(); return; }
        S.scanStop = h.stop; if (camNote) camNote.textContent = 'Point the camera at the member’s QR.';
      });
    }).catch(unsupported);
  }

  function submitToken(raw) {
    var ui = S.ui; if (!ui) return Promise.resolve();
    var token = String(raw || '').trim();
    if (!token) { ui.result.innerHTML = '<div class="sfm-card sfm-warn" role="alert">Scan or paste a member code first.</div>'; return Promise.resolve(); }
    if (S.busy) return Promise.resolve();
    if (root.navigator && root.navigator.onLine === false) { ui.result.innerHTML = refusalCardHTML(null); return Promise.resolve(); }
    S.busy = true;
    ui.result.innerHTML = '<div class="sfm-card" role="status">Checking with SOKONI…</div>';
    return call('fitnessCheckIn', { token: token }).then(function (res) {
      ui.result.innerHTML = checkInCardHTML(res);
      if (ui.paste) ui.paste.value = '';
      if (res && res.ok === true) loadTab(S.tab);
    }, function (err) {
      ui.result.innerHTML = refusalCardHTML(err);
    }).then(function () { S.busy = false; });
  }

  /* Re-evaluate on the server workspace answer (fail closed until it says AVAILABLE). */
  if (root.document && root.document.addEventListener) {
    root.document.addEventListener('sokoni:workspace', function (ev) {
      if (!S.el) return;
      var ok = moduleAvailable(ev && ev.detail ? ev.detail : undefined);
      if (!ok) unmount(S.el); else if (!S.mounted) mount(S.el);
    });
  }

  root.SokoniFitnessMemberships = {
    mount: mount,
    _core: {
      esc: esc, call: call, DASH: DASH, OFFLINE_TEXT: OFFLINE_TEXT, toDate: toDate, fmtDate: fmtDate, fmtTime: fmtTime, fmtDateTime: fmtDateTime,
      fmtKES: fmtKES, shortRef: shortRef, periodText: periodText, capOf: capOf, capText: capText, countText: countText,
      remainingText: remainingText, sessionLine: sessionLine, label: label, STATUS_LABEL: STATUS_LABEL, PAY_LABEL: PAY_LABEL,
      isCount: isCount, isOffline: isOffline, errCode: errCode,
    },
    _t: { checkInCardHTML: checkInCardHTML, refusalCardHTML: refusalCardHTML, refusalText: refusalText, rowHTML: rowHTML, detailHTML: detailHTML,
      offerHTML: offerHTML, scannerReasonHTML: scannerReasonHTML, moduleAvailable: moduleAvailable, act: act, submitToken: submitToken,
      openScanner: openScanner, loadStatus: loadStatus, state: S, REFUSAL: REFUSAL },
  };
})(typeof window !== 'undefined' ? window : this);
