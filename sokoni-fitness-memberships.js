/* sokoni-fitness-memberships.js — Fitness Memberships, gym side (provider workspace module) + shared core.
 *
 * THE BROWSER ONLY REQUESTS AND DISPLAYS (owner 2026-10-03). Every figure on this screen comes from a server answer:
 *   fitnessScannerStatus()                       → may this account scan, and if not, the REAL reason
 *   fitnessGymMemberships({status, limit, cursor}) → the gym's memberships (server-scoped to the caller's gym)
 *   fitnessGymMembership({membershipId})         → one membership + attendance ledger + settlement rows
 *   fitnessCheckIn({token})                      → the ONLY thing that records attendance
 *   providerServices (read-only query + re-read)  → the gym's membership offers (listed; re-read after a save)
 *   providerDispatch({op:'providerAddService'|'providerUpdateService'|'providerToggleService', …})
 *                                                → the ONLY offer writers (provider-ops, server-validated)
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
  /* Plan length. Day and week offers are single passes (owner 2026-10-03: count 1); months run 1..60. */
  function periodText(count, unit) {
    if (!isCount(count) || count < 1) return DASH;
    if (unit === 'day') return count === 1 ? 'Day pass' : count + ' days';
    if (unit === 'week') return count === 1 ? 'Week pass' : count + ' weeks';
    if (unit !== 'month' && unit !== undefined && unit !== null && unit !== '') return DASH;   /* an unknown unit is unknown */
    return count + ' month' + (count === 1 ? '' : 's');
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
    expired_unused: 'Expired (unused)',
  };
  var PAY_LABEL = {
    pending: 'Awaiting payment', paid_held: 'Paid · held by SOKONI', payment_review: 'Payment under review',
    partially_released: 'Partly released to gym', released: 'Released to gym', refund_requested: 'Refund requested',
    refunded: 'Refunded', refunded_late: 'Payment refunded — please start again',
  };
  function label(map, v) { return v === null || v === undefined || v === '' ? DASH : (map[v] || String(v)); }

  /* ── check-in refusals: the server's reason code → human text. The table is docs/FITNESS_MEMBERSHIP_API.md §3 (15 reasons, @ d5fbd37);
     scripts/fixtures/fitness-api-fixtures.json is the source of truth and the UI suite drives every fixture through it. ── */
  var REFUSAL = {
    token_invalid: 'This QR code is not valid. Ask the member to refresh it in their app.',
    token_expired: 'This QR code has expired. Ask the member to refresh it in their app.',
    not_found: 'Membership not found.',
    no_permission: "You don't have permission to record attendance for this gym.",
    other_gym: 'This membership is not for your gym.',
    self_scan: 'You cannot check yourself in.',
    wrong_member: 'This QR code does not belong to this membership holder.',
    expired: 'This membership has expired.',
    cancelled: 'This membership has been cancelled.',
    suspended: 'This membership is suspended.',
    not_covered: 'This membership does not cover a session right now.',
    entitlement_exhausted: 'All sessions on this membership have been used.',
    business_link_missing: "Staff attendance isn't set up for this gym yet. Ask the gym owner to scan.",
    not_approved: "This gym isn't approved to record attendance right now.",
    module_unavailable: "Memberships aren't enabled for this business.",
  };
  var UNAUTH_TEXT = 'Sign in required.';
  var UNAVAILABLE_TEXT = 'Attendance could not be recorded. Please try again.';
  /* Gym read-scope refusals (fitnessGymMemberships / fitnessGymMembership) and scanner-status reasons — UPPER_SNAKE. */
  var SCOPE = {
    NO_PERMISSION: "You don't have permission to view this gym's memberships.",
    NOT_APPROVED: "This gym isn't approved to manage memberships right now.",
    BUSINESS_LINK_MISSING: "Staff access isn't set up for this gym yet.",
    MODULE_NOT_AVAILABLE: "Memberships aren't enabled for this business.",
    MULTIPLE_GYMS: 'You are staff at more than one gym. Ask the gym owner for access to this view.',
  };
  /* The web SDK surfaces an HttpsError as code "functions/<code>" with .details. e3's callables put the machine code in
     details.reason; 2f's (membership-settlement, payment-purposes) put it in details.code. Read both. */
  function errCode(err) { return String((err && err.code) || '').replace(/^functions\//, ''); }
  function errReason(err) {
    var d = err && err.details;
    if (!d || typeof d !== 'object') return null;
    var r = d.reason || d.code;
    return r ? String(r) : null;
  }
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
    if (r && Object.prototype.hasOwnProperty.call(REFUSAL, r)) return REFUSAL[r];
    var c = errCode(err);
    if (c === 'unauthenticated') return UNAUTH_TEXT;
    if (c === 'unavailable') return UNAVAILABLE_TEXT;
    if (c === 'permission-denied') return REFUSAL.no_permission;
    return (err && err.message) ? String(err.message) : 'Attendance was not recorded.';
  }
  /* list/detail load failures: scope reason → text; otherwise the server's user-safe message. */
  function scopeText(err, offlineText, fallback) {
    if (isOffline(err)) return offlineText;
    var r = errReason(err);
    if (r && Object.prototype.hasOwnProperty.call(SCOPE, r)) return SCOPE[r];
    if (r === 'not_found') return 'Membership not found.';
    return (err && err.message) ? String(err.message) : fallback;
  }

  /* ── the check-in result card — built ONLY from the server response (success and duplicate share one key set, API §3) ── */
  function memberName(res) {
    var n = res && res.member && res.member.displayName;
    return typeof n === 'string' && n ? n : DASH;
  }
  var USED_LINE = 'Refund no longer available — membership used';
  function checkInCardHTML(res) {
    if (!res || res.ok !== true || typeof res.attendanceId !== 'string' || !res.attendanceId || typeof res.duplicate !== 'boolean') {
      return '<div class="sfm-card sfm-bad" role="alert"><strong>Attendance was not recorded.</strong> The server did not confirm this check-in — scan again.</div>';
    }
    var head = esc(memberName(res)) + ' — Membership ' + esc(shortRef(res.membershipId)) + (res.title ? ' · ' + esc(res.title) : '') +
      ' · ' + esc(sessionLine(res));
    if (res.duplicate === true) {
      return '<div class="sfm-card sfm-warn" role="status" data-sfm-result="duplicate"><strong>Already checked in today</strong>' +
        '<div class="sfm-line">' + head + ' · Original check-in: ' + esc(fmtTime(res.checkedInAt)) + '</div><div class="sfm-sub">Existing record ' + esc(res.attendanceId) +
        ' · ' + esc(label({ checked_in: 'Checked in', completed: 'Completed', voided_by_admin: 'Voided by admin' }, res.status)) + ' · nothing new was recorded</div></div>';
    }
    return '<div class="sfm-card sfm-ok" role="status" data-sfm-result="recorded"><strong>ATTENDANCE RECORDED</strong> · ' + head +
      ' · Check-in: ' + esc(fmtTime(res.checkedInAt)) +
      (res.firstCheckIn === true ? '<div class="sfm-sub" data-sfm-first>' + esc(USED_LINE) + '</div>' : '') + '</div>';
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
    if (r === 'MODULE_NOT_AVAILABLE') return "Memberships aren't enabled for this business yet, so scanning is off.";
    if (r === 'MULTIPLE_GYMS') return esc(SCOPE.MULTIPLE_GYMS);
    if (r) return 'Scanning is unavailable for this account.';
    return 'Scanning is unavailable for this account.';
  }

  /* ── gym rows ── */
  function refundStateText(r) {
    if (!r || !('refundState' in r) || r.refundState === undefined) return DASH;
    if (r.refundState === null) return 'None';
    return label({ requested: 'Requested', approved: 'Approved', rejected: 'Rejected', executed: 'Refunded', exception_requested: 'Exception requested' }, r.refundState);
  }
  /* refundEligible: true only for a PAID membership with an empty ledger; false once used (never back); null = unpaid/unknown. */
  function refundableText(r) {
    if (!r || r.refundEligible === null || r.refundEligible === undefined) return DASH;
    return r.refundEligible === true ? 'Yes — not used yet' : r.refundEligible === false ? 'No — membership used' : DASH;
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
      kv('Refund', refundStateText(r)) + kv('Refundable', refundableText(r)) + kv('Payment', label(PAY_LABEL, r.paymentStatus)) +
      (settle ? kv('Settlement', settle) : '') +
      '</div>' +
      (r.membershipId ? '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="detail" data-id="' + esc(r.membershipId) + '">Details</button>' : '') +
      '</div>';
  }
  /* settlement is an OBJECT (API §6): {releases[], releasedPeriods, releasedCents, netSettledCents}. Anything else = unknown. */
  function settlementOf(d) {
    var st = d && d.settlement;
    if (!st || typeof st !== 'object' || Array.isArray(st) || !Array.isArray(st.releases)) return null;
    return st;
  }
  function settlementHTML(st) {
    if (!st) return '<p class="sfm-sub" data-sfm-settle="unknown">Settlement: ' + DASH + '</p>';
    var rel = st.releases.length ? '<ul class="sfm-list" data-sfm-settle="releases">' + st.releases.map(function (p) {
      p = p || {};
      return '<li>Period ' + esc(isCount(p.periodIndex) ? String(p.periodIndex) : DASH) + ' · gross ' + esc(fmtKES(p.grossCents)) +
        ' · commission ' + esc(fmtKES(p.commissionCents)) + ' · net ' + esc(fmtKES(p.netCents)) + ' · ' + esc(label({ settled: 'Settled' }, p.status)) +
        ' · ' + esc(fmtDate(p.settledAt)) + '</li>';
    }).join('') + '</ul>' : '<p class="sfm-sub">No releases yet.</p>';
    return rel + '<div class="sfm-grid" data-sfm-settle="totals">' + kv('Periods released', countText(st.releasedPeriods)) +
      kv('Released (gross)', fmtKES(st.releasedCents)) + kv('Net settled to gym', fmtKES(st.netSettledCents)) + '</div>';
  }
  var ATT_LABEL = { checked_in: 'Checked in', completed: 'Completed', voided_by_admin: 'Voided by admin' };
  function detailHTML(d) {
    d = d || {};
    var m = d.membership || d;
    var att = Array.isArray(d.attendance) ? d.attendance : [];
    var so = settlementOf(d);
    var ledger = att.length ? att.map(function (a) {
      return '<li>' + esc(fmtDateTime(a.checkedInAt)) + ' · ' + esc(label(ATT_LABEL, a.status)) + ' · ' + esc(a.method || DASH) +
        (a.actorRole ? ' · by ' + esc(a.actorRole) : '') + (a.completedAt ? ' · completed ' + esc(fmtTime(a.completedAt)) : '') + '</li>';
    }).join('') : '<li>No attendance recorded.</li>';
    var settle = settlementHTML(so);
    return '<div class="sfm-drawer-h"><div><div class="sfm-name">' + esc((m.member && m.member.displayName) || DASH) + '</div>' +
      '<div class="sfm-sub">' + esc(m.title || DASH) + ' · ' + esc(shortRef(m.membershipId)) + ' · ' + esc(periodText(m.periodCount, m.periodUnit)) + '</div></div>' +
      '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="close" aria-label="Close details">Close</button></div>' +
      '<div class="sfm-grid">' + kv('Status', label(STATUS_LABEL, m.status)) + kv('Payment', label(PAY_LABEL, m.paymentStatus)) +
      kv('Start', fmtDate(m.startAt)) + kv('Expiry', fmtDate(m.endsAt)) +
      kv('Sessions included', capText(capOf(m, 'sessionsIncluded', 'unknown'))) + kv('Attended', countText(m.attendedSessions)) +
      kv('Remaining', remainingText(m, 'unknown')) + kv('Refund', refundStateText(m)) + kv('Refundable', refundableText(m)) + '</div>' +
      '<h4 class="sfm-h4">Attendance ledger</h4><ul class="sfm-list">' + ledger + '</ul>' +
      '<h4 class="sfm-h4">Settlement</h4>' + settle +
      '<p class="sfm-sub">Attendance can only be corrected by SOKONI through an audited correction — never deleted from here.</p>';
  }
  /* ── MEMBERSHIP OFFER EDITOR (owner 2026-10-03, "Defaults gyms can edit") ───────────────────────────────────────────
     OFFER_DEFAULTS MIRRORS functions/shared/fitness-offer-defaults.js (origin/convergence/commercial-fn-on-ef1e992 @ fe33bcc),
     the ONE source of SOKONI's starting prices. scripts/test-fitness-memberships-ui.js row OF-DEF fails if they differ.
     They only PRE-FILL the form; the member always pays the gym's PUBLISHED offer, priced by the server. */
  var OFFER_DEFAULTS = [
    { key: 'daily', label: 'Daily Pass', priceCents: 50000, periodUnit: 'day', periodCount: 1 },
    { key: 'weekly', label: 'Weekly Pass', priceCents: 150000, periodUnit: 'week', periodCount: 1 },
    { key: 'monthly', label: 'Monthly', priceCents: 500000, periodUnit: 'month', periodCount: 1 },
    { key: 'quarter', label: '3 Months', priceCents: 1400000, periodUnit: 'month', periodCount: 3 },
    { key: 'half', label: '6 Months', priceCents: 2600000, periodUnit: 'month', periodCount: 6 },
    { key: 'annual', label: 'Annual', priceCents: 4800000, periodUnit: 'month', periodCount: 12 },
  ];
  /* Same arithmetic as the server's withSavings(): multi-month offers vs the SAME list's 1-month price. */
  function withSavings(list) {
    var src = Array.isArray(list) ? list : OFFER_DEFAULTS;
    var monthly = src.filter(function (o) { return o.periodUnit === 'month' && o.periodCount === 1 && isCount(o.priceCents) && o.priceCents > 0; })[0];
    return src.map(function (o) {
      var out = {}; Object.keys(o).forEach(function (k) { out[k] = o[k]; });
      if (!monthly || o.periodUnit !== 'month' || !(o.periodCount > 1) || !isCount(o.priceCents)) { out.effectiveMonthlyCents = null; out.savingPct = null; return out; }
      var eff = Math.round(o.priceCents / o.periodCount);
      var saving = Math.round((1 - eff / monthly.priceCents) * 100);
      out.effectiveMonthlyCents = eff; out.savingPct = saving > 0 ? saving : 0;
      return out;
    });
  }
  function savingText(o) { return o && isCount(o.savingPct) && o.savingPct > 0 ? 'Save ' + o.savingPct + '%' : ''; }
  var OFFER_UNITS = ['day', 'week', 'month'];
  var NOT_ENABLED = "Membership offers aren't enabled on the server yet.";

  /* Draft → the exact typed payload provider-ops receives. Returns {data} or {error}. Never trusts the form's types. */
  function offerPayload(draft) {
    draft = draft || {};
    var name = String(draft.name == null ? '' : draft.name).trim();
    if (!name) return { error: 'Give the offer a name.' };
    if (name.length > 200) return { error: 'The name is too long (200 characters at most).' };
    var kes = typeof draft.priceKes === 'number' ? draft.priceKes : Number(String(draft.priceKes == null ? '' : draft.priceKes).replace(/[,\s]/g, ''));
    if (!Number.isInteger(kes) || kes < 1 || kes > 10000000) return { error: 'Enter the price in whole shillings (for example 5000).' };
    var unit = String(draft.periodUnit || '');
    if (OFFER_UNITS.indexOf(unit) < 0) return { error: 'Choose day, week or month.' };
    var count = unit === 'month' ? Number(draft.periodCount) : 1;
    if (!Number.isInteger(count) || count < 1 || count > 60) return { error: 'A monthly offer runs for 1 to 60 months.' };
    return { data: { name: name, price: kes * 100, priceType: 'fixed', serviceKind: 'membership', periodCount: count, periodUnit: unit } };
  }
  /* "Saved" is claimed ONLY when the server's own copy of the service is a membership with what we sent.
     Until 5b's providerDispatch release carries the membership-offer hooks, provider-ops DROPS serviceKind/periodUnit/
     periodCount — the re-read then shows a plain rate card and this returns false. */
  function savedAsMembership(doc, sent) {
    return !!(doc && sent && doc.serviceKind === 'membership' && doc.periodUnit === sent.periodUnit && doc.periodCount === sent.periodCount &&
      doc.price === sent.price);
  }
  function offerRowHTML(o) {
    o = o || {};
    var live = o.active !== false && !o.removedAt;
    var save = savingText(o);
    return '<li class="sfm-offer" data-id="' + esc(o.id || '') + '"><b>' + esc(o.name || DASH) + '</b> · ' + esc(fmtKES(o.price)) + ' · ' +
      esc(periodText(o.periodCount, o.periodUnit)) + (save ? ' · <span class="sfm-save">' + esc(save) + '</span>' : '') + ' · ' + (live ? 'Active' : 'Paused') +
      (o.id && !o.removedAt ? ' <button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="offer-edit" data-id="' + esc(o.id) + '">Edit</button>' +
        ' <button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="' + (live ? 'offer-pause' : 'offer-activate') + '" data-id="' + esc(o.id) + '">' + (live ? 'Pause' : 'Activate') + '</button>' : '') +
      '</li>';
  }
  function defaultsPickerHTML() {
    return '<div class="sfm-defaults" role="group" aria-label="Start from a SOKONI default"><p class="sfm-sub">Start from a SOKONI default — you can change the name and price before saving.</p>' +
      withSavings(OFFER_DEFAULTS).map(function (d) {
        var save = savingText(d);
        return '<button type="button" class="sfm-btn sfm-btn-s sfm-def" data-sfm-act="offer-default" data-id="' + esc(d.key) + '">' + esc(d.label) + ' · ' +
          esc(fmtKES(d.priceCents)) + (save ? ' · ' + esc(save) : '') + '</button>';
      }).join('') + '</div>';
  }
  function offerFormHTML(ed) {
    ed = ed || {};
    var unit = ed.periodUnit || 'month';
    return '<form class="sfm-form" data-sfm-form="offer" novalidate>' +
      '<label class="sfm-sub" for="sfmOfName">Offer name</label><input id="sfmOfName" class="sfm-in" maxlength="200" autocomplete="off" value="' + esc(ed.name || '') + '">' +
      '<label class="sfm-sub" for="sfmOfPrice">Price (KES, whole shillings)</label><input id="sfmOfPrice" class="sfm-in" inputmode="numeric" value="' + esc(ed.priceKes == null ? '' : String(ed.priceKes)) + '">' +
      '<label class="sfm-sub" for="sfmOfUnit">Length</label><select id="sfmOfUnit" class="sfm-in">' +
      [['day', 'Day pass'], ['week', 'Week pass'], ['month', 'Months']].map(function (u) { return '<option value="' + u[0] + '"' + (u[0] === unit ? ' selected' : '') + '>' + u[1] + '</option>'; }).join('') + '</select>' +
      '<label class="sfm-sub" for="sfmOfMonths">Months (monthly offers only, 1–60)</label><input id="sfmOfMonths" class="sfm-in" inputmode="numeric" value="' + esc(unit === 'month' ? String(ed.periodCount || 1) : '1') + '">' +
      '<div class="sfm-formbtns"><button type="button" class="sfm-btn sfm-btn-p" data-sfm-act="offer-save">' + (ed.serviceId ? 'Save changes' : 'Save offer') + '</button> ' +
      '<button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="offer-cancel">Cancel</button></div>' +
      '<p class="sfm-sub" data-sfm-offer-msg role="status" aria-live="polite">' + esc(ed.msg || '') + '</p></form>';
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
    '.sfm-offers{margin-top:16px;border-top:1px solid var(--border,#1a1a1a);padding-top:12px}.sfm-offer{margin-bottom:6px}' +
    '.sfm-save{color:var(--acc,#71ff00);font-weight:700}.sfm-defaults{display:flex;flex-wrap:wrap;gap:6px;margin:8px 0}' +
    '.sfm-form{display:grid;gap:4px;max-width:420px;margin-top:8px}.sfm-in{width:100%;min-height:44px;border-radius:10px;border:1px solid var(--border,#262626);background:var(--surf2,#141414);color:inherit;padding:8px 10px;font-size:15px}' +
    '.sfm-in:focus-visible{outline:2px solid var(--acc,#71ff00);outline-offset:2px}.sfm-formbtns{display:flex;flex-wrap:wrap;gap:8px;margin-top:6px}';

  /* ── workspace gate (server answer only) ── */
  function moduleAvailable(w) {
    w = w === undefined ? root.__sokoniWorkspace : w;
    var m = w && w.modules && w.modules.memberships;
    return !!(m && m.state === 'AVAILABLE');
  }

  /* ── gym module state ── */
  var S = { el: null, ui: null, tab: 'active', cursor: null, rows: [], busy: false, canScan: false, scanStop: null, mounted: false,
    offers: null, offerErr: '', offerMsg: '', ed: null, offerBusy: false };
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
    if (name === 'offer-add') return offerStart('monthly');
    if (name === 'offer-default') return offerStart(arg);
    if (name === 'offer-edit') return offerStart(null, arg);
    if (name === 'offer-cancel') { S.ed = null; S.offerMsg = ''; renderOffers(); return null; }
    if (name === 'offer-save') return saveOffer();
    if (name === 'offer-pause') return toggleOffer(arg, false);
    if (name === 'offer-activate') return toggleOffer(arg, true);
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
      ui.list.innerHTML = '<div class="sfm-card sfm-bad" role="alert">' + esc(scopeText(err, 'Memberships unavailable — retry when connected', 'Memberships could not be loaded.')) +
        ' <button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="retry">Retry</button></div>';
    });
  }

  function openDetail(id) {
    var ui = S.ui; if (!ui || !id) return Promise.resolve();
    ui.drawer.hidden = false; ui.drawer.innerHTML = '<div class="sfm-sub">Loading…</div>';
    return call('fitnessGymMembership', { membershipId: String(id) }).then(function (d) {
      if (S.ui) ui.drawer.innerHTML = detailHTML(d);
    }, function (err) {
      if (S.ui) ui.drawer.innerHTML = '<div class="sfm-card sfm-bad" role="alert">' + esc(scopeText(err, 'Details unavailable — retry when connected', 'Details could not be loaded.')) +
        '</div><button type="button" class="sfm-btn sfm-btn-s" data-sfm-act="close">Close</button>';
    });
  }

  /* Membership offers: LISTED from providerServices (read under rules); WRITTEN only through providerDispatch. */
  function offersIntro() {
    return '<h4 class="sfm-h4">Membership offers</h4><p class="sfm-sub">Members buy these plans at the price you publish. SOKONI checks every offer on the server.</p>';
  }
  function renderOffers() {
    var ui = S.ui; if (!ui) return;
    var ed = S.ed;
    var listHtml = S.offerErr ? '<p class="sfm-sub" role="alert">' + esc(S.offerErr) + '</p>'
      : S.offers === null ? '<p class="sfm-sub">Loading offers…</p>'
      : S.offers.length ? '<ul class="sfm-list">' + withSavings(S.offers.map(function (o) { var c = {}; Object.keys(o).forEach(function (k) { c[k] = o[k]; }); c.priceCents = o.price; return c; })).map(offerRowHTML).join('') + '</ul>'
      : '<p class="sfm-sub">No membership offers yet.</p>';
    ui.offers.innerHTML = offersIntro() + listHtml +
      (S.offerMsg ? '<p class="sfm-sub" role="status" data-sfm-offer-note>' + esc(S.offerMsg) + '</p>' : '') +
      (ed ? (ed.serviceId ? '' : defaultsPickerHTML()) + offerFormHTML(ed)
        : '<button type="button" class="sfm-btn sfm-btn-p" data-sfm-act="offer-add">Add membership offer</button>');
  }
  function loadOffers() {
    var ui = S.ui; if (!ui) return Promise.resolve();
    var fb = root.firebase, user = fb && fb.auth && fb.auth().currentUser;
    if (!fb || !fb.firestore || !user) { S.offers = []; S.offerErr = 'Sign in to manage your membership offers.'; renderOffers(); return Promise.resolve(); }
    S.offers = null; S.offerErr = ''; renderOffers();
    return fb.firestore().collection('providerServices').where('providerId', '==', user.uid).where('serviceKind', '==', 'membership').limit(50).get()
      .then(function (snap) {
        S.offers = ((snap && snap.docs) || []).map(function (d) { var o = d.data() || {}; o.id = d.id; return o; });
        renderOffers();
      }, function () { S.offers = []; S.offerErr = 'Offers could not be loaded.'; renderOffers(); });
  }
  function offerFormValues() {
    var g = function (id) { var e = root.document.getElementById(id); return e ? e.value : undefined; };
    var unit = g('sfmOfUnit');
    if (unit === undefined) return null;
    return { name: g('sfmOfName'), priceKes: g('sfmOfPrice'), periodUnit: unit, periodCount: Number(g('sfmOfMonths')) };
  }
  function offerStart(key, serviceId) {
    S.offerMsg = '';
    if (serviceId) {
      var o = (S.offers || []).filter(function (x) { return x.id === serviceId; })[0]; if (!o) return;
      S.ed = { serviceId: o.id, name: o.name || '', priceKes: isCount(o.price) ? Math.round(o.price / 100) : '', periodUnit: o.periodUnit || 'month', periodCount: o.periodCount || 1 };
    } else {
      var d = OFFER_DEFAULTS.filter(function (x) { return x.key === key; })[0] || OFFER_DEFAULTS[2];
      S.ed = { serviceId: null, name: d.label, priceKes: d.priceCents / 100, periodUnit: d.periodUnit, periodCount: d.periodCount };
    }
    renderOffers();
  }
  function offerMsg(t) { if (S.ed) S.ed.msg = t; renderOffers(); }
  /* Re-read the service the server wrote (rules: providerServices readable by any signed-in user). */
  function rereadService(id) {
    var fb = root.firebase;
    if (!fb || !fb.firestore || !id) return Promise.resolve(null);
    return fb.firestore().collection('providerServices').doc(String(id)).get()
      .then(function (d) { return d && d.exists ? (d.data() || {}) : null; }, function () { return null; });
  }
  function saveOffer(draft) {
    var ed = S.ed; if (!ed || S.offerBusy) return Promise.resolve(false);
    var v = draft || offerFormValues() || ed;
    var p = offerPayload(v);
    if (p.error) { ed.name = v.name; ed.priceKes = v.priceKes; ed.periodUnit = v.periodUnit; ed.periodCount = v.periodCount; offerMsg(p.error); return Promise.resolve(false); }
    S.offerBusy = true;
    ed.name = p.data.name; ed.priceKes = p.data.price / 100; ed.periodUnit = p.data.periodUnit; ed.periodCount = p.data.periodCount;
    offerMsg('Saving…');
    var req = { op: ed.serviceId ? 'providerUpdateService' : 'providerAddService' };
    if (ed.serviceId) req.serviceId = ed.serviceId;
    Object.keys(p.data).forEach(function (k) { req[k] = p.data[k]; });
    var sid = ed.serviceId;
    return call('providerDispatch', req).then(function (r) {
      sid = sid || (r && r.serviceId) || null;
      if (!sid) { offerMsg('The server did not confirm the save. Reload and check your offers.'); return false; }
      return rereadService(sid).then(function (doc) {
        if (savedAsMembership(doc, p.data)) { S.ed = null; S.offerMsg = 'Saved — ' + p.data.name + '.'; renderOffers(); loadOffers(); return true; }
        if (doc === null) { offerMsg('Saved status unknown — the offer could not be re-read. Reload to check.'); return false; }
        /* The server stored a plain rate card (membership fields dropped). Never call that "Saved". A NEW card would be a
           bookable fixed-price service nobody asked for, so it is archived through the server's own soft-delete. */
        if (!ed.serviceId) {
          return call('providerDispatch', { op: 'providerRemoveService', serviceId: sid }).then(function () {
            offerMsg(NOT_ENABLED + ' Nothing was published.'); return false;
          }, function () {
            offerMsg(NOT_ENABLED + ' A plain rate card named "' + p.data.name + '" may have been created — archive it in Services.'); return false;
          });
        }
        offerMsg(NOT_ENABLED); return false;
      });
    }, function (e) {
      offerMsg(isOffline(e) ? 'Offers unavailable — retry when connected' : ((e && e.message) ? String(e.message) : 'The offer was not saved.'));
      return false;
    }).then(function (ok) { S.offerBusy = false; return ok; });
  }
  function toggleOffer(id, active) {
    if (!id || S.offerBusy) return Promise.resolve(false);
    S.offerBusy = true; S.offerMsg = 'Updating…'; renderOffers();
    return call('providerDispatch', { op: 'providerToggleService', serviceId: String(id), active: active === true }).then(function () {
      S.offerMsg = ''; return loadOffers().then(function () { return true; });
    }, function (e) {
      S.offerMsg = isOffline(e) ? 'Offers unavailable — retry when connected' : ((e && e.message) ? String(e.message) : 'The offer was not updated.'); renderOffers(); return false;
    }).then(function (ok) { S.offerBusy = false; return ok; });
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
      isCount: isCount, isOffline: isOffline, errCode: errCode, errReason: errReason,
    },
    _t: { checkInCardHTML: checkInCardHTML, refusalCardHTML: refusalCardHTML, refusalText: refusalText, rowHTML: rowHTML, detailHTML: detailHTML,
      offerRowHTML: offerRowHTML, offerPayload: offerPayload, savedAsMembership: savedAsMembership, saveOffer: saveOffer, toggleOffer: toggleOffer,
      offerStart: offerStart, withSavings: withSavings, OFFER_DEFAULTS: OFFER_DEFAULTS, NOT_ENABLED: NOT_ENABLED, renderOffers: renderOffers, scannerReasonHTML: scannerReasonHTML, moduleAvailable: moduleAvailable, act: act, submitToken: submitToken,
      openScanner: openScanner, loadStatus: loadStatus, state: S, REFUSAL: REFUSAL, SCOPE: SCOPE, scopeText: scopeText, refundableText: refundableText,
      settlementOf: settlementOf, settlementHTML: settlementHTML, USED_LINE: USED_LINE },
  };
})(typeof window !== 'undefined' ? window : this);
