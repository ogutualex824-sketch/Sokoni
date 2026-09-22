/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — MERCHANT ROSTER SURFACE
   sokoni-merchant-roster.js

   The missing front end for an authority that already exists.

   ── WHY THIS FILE, AND WHY IT IS ONLY A SURFACE ────────────────────────────

   `functions/pos-shift-scheduler.js` exports TWELVE roster callables, every one
   re-exported by name in `functions/index.js` — and, measured 2026-09-22, NOT
   ONE of them had a client caller anywhere in the repo. The scan covered `.html`
   AND `.js` and carried a positive control (`openShift`, found in five files),
   so the silence was the codebase's, not the detector's.

   `pos-staff-ops.html` — what Merchant V2's "Shifts & rosters" card opened —
   calls sixteen CFs and every one of them is SHIFT or ATTENDANCE: openShift,
   closeShift, clockIn, clockOut, getAttendance, getCashReconciliation,
   approvals, commissions. No roster. So the roster backend was complete,
   deployed, hardened and unreachable.

   This module therefore INVENTS NOTHING. It holds:
     · no roster state of its own
     · no employee record
     · no second schedule store
     · no permission decision

   Every action is one of the twelve existing callables, invoked with the exact
   payload that callable destructures. The contracts were read out of
   pos-shift-scheduler.js, not guessed:

     getRoster            { sellerId, branchId, startDate, endDate }
     getRosterGaps        { sellerId, branchId }
     getStaffRoster       { }                        (resolves the caller)
     publishWeeklyRoster  { sellerId, branchId, weekStartDate, slots }
     createShiftTemplate  { sellerId, name, startTime, endTime, requiredStaff,
                            rolesNeeded, days, description }
     assignShift          { rosterId, slotIndex, staffUid, note }
     setStaffAvailability { sellerId, entries }
     swapShiftRequest     { rosterId, mySlotIndex, targetUid, reason }
     approveShiftSwap     { swapId, action, note }
     acknowledgeShift     { rosterId, slotIndex }

   ── AUTHORIZATION IS THE SERVER'S ─────────────────────────────────────────

   Several of these are manager-gated server-side. This surface does NOT
   pre-judge that: it renders the control, and when the server refuses it shows
   the refusal. Hiding a button is a courtesy; it is never a permission, and a
   client-side role check here would be a SECOND authorization authority — the
   exact thing the convergence work exists to prevent. A cashier does not gain
   manager rights because a button rendered.

   ── FIGURES ARE NEVER INVENTED ────────────────────────────────────────────

   An unresolved count renders as an em dash, never 0. An EMPTY roster and a
   FAILED load are different states and are shown differently — an empty week is
   a successful query, and reporting it as an error is how a working system looks
   broken.

   ── IDENTITY ──────────────────────────────────────────────────────────────

   `sellerId` comes from the shell's already-resolved scope. This module never
   resolves identity itself; a second answer to "which merchant am I" is the
   defect the ecosystem work removed from the till.
   ══════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  var API = {};

  /* ── helpers ─────────────────────────────────────────────────────────────── */
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  /* An unknown is an em dash. A real zero is a zero. They are not the same and this
     is the one place that decides which is being shown. */
  function num (v) { return (v === 0 || (typeof v === 'number' && isFinite(v))) ? String(v) : '—'; }
  function pad (n) { return n < 10 ? '0' + n : String(n); }
  function iso (d) { return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate()); }
  /* Monday of the week containing `d`, in UTC — the scheduler's weeks start Monday and
     a local-time week boundary would shift the whole roster for anyone east of UTC. */
  function weekStart (d) {
    var x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
    var dow = x.getUTCDay();              /* 0=Sun */
    x.setUTCDate(x.getUTCDate() - ((dow + 6) % 7));
    return x;
  }
  function addDays (d, n) {
    var x = new Date(d.getTime());
    x.setUTCDate(x.getUTCDate() + n);
    return x;
  }
  var DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

  /* A server refusal is shown as what it is. `permission-denied` is not a bug and must
     not be dressed as one — it is the server declining, which is the system working. */
  function reason (e) {
    var code = (e && (e.code || e.message)) || '';
    if (/permission-denied/.test(code)) return 'You do not have permission for this action.';
    if (/unauthenticated/.test(code))   return 'Your session has expired. Sign in again.';
    if (/failed-precondition/.test(code)) return (e && e.message) || 'That is not possible right now.';
    if (/not-found/.test(code))         return 'That record no longer exists.';
    if (/already-exists/.test(code))    return 'That has already been done.';
    return (e && e.message) || 'Something went wrong.';
  }

  API.mount = function (host, ctx) {
    ctx = ctx || {};
    var call     = ctx.call;                       /* name -> payload -> Promise */
    var scope    = ctx.scope || {};
    var onToast  = ctx.onToast || function () {};
    var sellerId = scope.shopId || scope.sellerUid || null;
    var branchId = scope.branchId || 'default';

    var S = {
      state: 'idle',          /* idle | loading | ready | empty | error */
      err: null,
      week: weekStart(new Date()),
      roster: null,
      gaps: null,
      tab: 'week',            /* week | gaps | mine | availability */
      mine: null,
    };

    /* CONTEXT IS REFUSED BEFORE MOUNT, not blanked after it. Without a shop there is no
       roster to ask for, and an empty grid would read as "no shifts scheduled". */
    if (!sellerId) {
      host.innerHTML =
        '<div class="state"><span class="ico">🗓️</span><b>No active shop</b>' +
        '<small>A roster belongs to a shop, and none is selected yet. This is not an empty ' +
        'roster — nothing was requested.</small></div>';
      return { destroy: function () {} };
    }
    if (typeof call !== 'function') {
      host.innerHTML =
        '<div class="state"><span class="ico">⚠️</span><b>Roster unavailable</b>' +
        '<small>The workspace did not provide a way to reach the server, so nothing was ' +
        'fetched. This is not an empty roster.</small></div>';
      return { destroy: function () {} };
    }

    /* ── data ──────────────────────────────────────────────────────────────── */
    function loadWeek () {
      S.state = 'loading'; S.err = null; render();
      var start = iso(S.week), end = iso(addDays(S.week, 6));
      return call('getRoster', { sellerId: sellerId, branchId: branchId, startDate: start, endDate: end })
        .then(function (res) {
          var d = (res && res.data) || {};
          var slots = d.slots || d.roster || d.rosters || [];
          S.roster = { id: d.rosterId || d.id || null, slots: Array.isArray(slots) ? slots : [] };
          /* EMPTY IS A SUCCESSFUL QUERY. A week with no shifts published is a real answer. */
          S.state = S.roster.slots.length ? 'ready' : 'empty';
        })
        .catch(function (e) { S.state = 'error'; S.err = reason(e); })
        .then(render);
    }

    function loadGaps () {
      S.gaps = null; S.state = 'loading'; S.err = null; render();
      return call('getRosterGaps', { sellerId: sellerId, branchId: branchId })
        .then(function (res) {
          var d = (res && res.data) || {};
          S.gaps = d.gaps || d.items || [];
          S.state = S.gaps.length ? 'ready' : 'empty';
        })
        .catch(function (e) { S.state = 'error'; S.err = reason(e); })
        .then(render);
    }

    function loadMine () {
      S.mine = null; S.state = 'loading'; S.err = null; render();
      /* getStaffRoster resolves the CALLER server-side — no uid is sent, because a
         client-supplied uid here would be asking the server to trust the browser about
         whose schedule it is. */
      return call('getStaffRoster', {})
        .then(function (res) {
          var d = (res && res.data) || {};
          S.mine = d.shifts || d.slots || d.roster || [];
          S.state = S.mine.length ? 'ready' : 'empty';
        })
        .catch(function (e) { S.state = 'error'; S.err = reason(e); })
        .then(render);
    }

    function reload () {
      if (S.tab === 'week') return loadWeek();
      if (S.tab === 'gaps') return loadGaps();
      if (S.tab === 'mine') return loadMine();
      S.state = 'ready'; render();
    }

    /* ── actions — each is ONE existing callable ───────────────────────────── */
    function act (name, payload, okMsg) {
      return call(name, payload)
        .then(function () { onToast(okMsg); return reload(); })
        /* The server's refusal is surfaced verbatim in meaning. Nothing is retried
           silently and no optimistic state is written — the roster on screen only ever
           reflects what the server returned. */
        .catch(function (e) { onToast(reason(e)); });
    }

    function doAssign (rosterId, slotIndex) {
      var uid = global.prompt && global.prompt('Staff UID to assign to this slot:');
      if (!uid) return;
      act('assignShift', { rosterId: rosterId, slotIndex: Number(slotIndex), staffUid: String(uid).trim(), note: null },
          'Assigned.');
    }
    function doAcknowledge (rosterId, slotIndex) {
      act('acknowledgeShift', { rosterId: rosterId, slotIndex: Number(slotIndex) }, 'Shift acknowledged.');
    }
    function doSwap (rosterId, slotIndex) {
      var target = global.prompt && global.prompt('Swap with which staff UID?');
      if (!target) return;
      var why = (global.prompt && global.prompt('Reason (optional):')) || null;
      act('swapShiftRequest', { rosterId: rosterId, mySlotIndex: Number(slotIndex), targetUid: String(target).trim(), reason: why },
          'Swap requested.');
    }
    function doPublish () {
      /* PUBLISH WITH NO SLOTS IS REFUSED HERE, deliberately: publishWeeklyRoster takes
         `slots`, and sending an empty array would publish an empty week over whatever is
         there. The slot composer is not built yet and this says so rather than offering a
         control that would erase a roster. */
      onToast('Publishing a week needs a shift template and slots — that composer is not built yet, ' +
              'so this would publish an EMPTY week over the current one. Not offered.');
    }

    /* ── render ────────────────────────────────────────────────────────────── */
    var TABS = [
      { k: 'week', label: 'This week' },
      { k: 'gaps', label: 'Unfilled' },
      { k: 'mine', label: 'My shifts' },
    ];

    function slotRow (s, i, rosterId) {
      var who = s.staffName || s.staffUid || null;
      return '<tr>' +
        '<td>' + esc(s.day || s.date || DAYS[i % 7] || '—') + '</td>' +
        '<td>' + esc(s.startTime || s.start || '—') + '–' + esc(s.endTime || s.end || '—') + '</td>' +
        '<td>' + esc(s.role || s.roleNeeded || '—') + '</td>' +
        '<td>' + (who ? esc(who) : '<em>unassigned</em>') + '</td>' +
        '<td class="rst-act">' +
          (rosterId ? '<button class="act ghost sm" data-rst="assign" data-roster="' + esc(rosterId) + '" data-slot="' + i + '">Assign</button>' +
                      '<button class="act ghost sm" data-rst="ack" data-roster="' + esc(rosterId) + '" data-slot="' + i + '">Ack</button>' +
                      '<button class="act ghost sm" data-rst="swap" data-roster="' + esc(rosterId) + '" data-slot="' + i + '">Swap</button>'
                    : '') +
        '</td></tr>';
    }

    function body () {
      if (S.state === 'loading') {
        return '<div class="state"><span class="ico">⏳</span><b>Loading…</b>' +
               '<small>Asking the roster service.</small></div>';
      }
      if (S.state === 'error') {
        return '<div class="state"><span class="ico">⚠️</span><b>Could not load the roster</b>' +
               '<small>' + esc(S.err || '') + ' Nothing was changed.</small>' +
               '<button class="act ghost" data-rst="retry">↻ Try again</button></div>';
      }
      if (S.tab === 'gaps') {
        if (S.state === 'empty') {
          return '<div class="state"><span class="ico">✅</span><b>No unfilled shifts</b>' +
                 '<small>Every published slot has someone assigned.</small></div>';
        }
        return '<table class="rst-tbl"><thead><tr><th>Day</th><th>Time</th><th>Role</th>' +
               '<th>Staff</th><th></th></tr></thead><tbody>' +
               (S.gaps || []).map(function (g, i) { return slotRow(g, i, g.rosterId || null); }).join('') +
               '</tbody></table>';
      }
      if (S.tab === 'mine') {
        if (S.state === 'empty') {
          return '<div class="state"><span class="ico">🗓️</span><b>No shifts assigned to you</b>' +
                 '<small>This is your own schedule, resolved by the server from your sign-in.</small></div>';
        }
        return '<table class="rst-tbl"><thead><tr><th>Day</th><th>Time</th><th>Role</th>' +
               '<th>Staff</th><th></th></tr></thead><tbody>' +
               (S.mine || []).map(function (s, i) { return slotRow(s, i, s.rosterId || null); }).join('') +
               '</tbody></table>';
      }
      if (S.state === 'empty') {
        return '<div class="state"><span class="ico">🗓️</span><b>No roster published for this week</b>' +
               '<small>That is an answer, not a failure — nothing is scheduled between ' +
               esc(iso(S.week)) + ' and ' + esc(iso(addDays(S.week, 6))) + '.</small></div>';
      }
      var r = S.roster || { slots: [] };
      return '<table class="rst-tbl"><thead><tr><th>Day</th><th>Time</th><th>Role</th>' +
             '<th>Staff</th><th></th></tr></thead><tbody>' +
             r.slots.map(function (s, i) { return slotRow(s, i, r.id); }).join('') +
             '</tbody></table>';
    }

    function render () {
      var filled = S.roster ? S.roster.slots.filter(function (s) { return s.staffUid || s.staffName; }).length : null;
      var total  = S.roster ? S.roster.slots.length : null;
      host.innerHTML =
        '<div class="greet"><b>Roster</b><small>Shift scheduling on the SmartPOS roster service — ' +
        'the same authority the scheduler and its weekly digest use. This screen keeps no ' +
        'schedule of its own.</small></div>' +
        '<div class="rst-head">' +
          '<button class="act ghost sm" data-rst="prev">‹ Prev</button>' +
          '<b>' + esc(iso(S.week)) + ' – ' + esc(iso(addDays(S.week, 6))) + '</b>' +
          '<button class="act ghost sm" data-rst="next">Next ›</button>' +
          '<span class="rst-sp"></span>' +
          '<span class="rst-kpi">Filled <b>' + num(filled) + '</b> / ' + num(total) + '</span>' +
        '</div>' +
        '<div class="rst-tabs">' +
          TABS.map(function (t) {
            return '<button class="chip' + (S.tab === t.k ? ' on' : '') + '" data-rst="tab" data-tab="' +
                   t.k + '">' + esc(t.label) + '</button>';
          }).join('') +
        '</div>' +
        body() +
        '<div class="note" style="margin-top:14px"><b>Permissions are the server\'s.</b> Publishing, ' +
        'assigning and approving swaps are manager-gated in the roster service. These controls are ' +
        'shown to everyone and the server decides — a hidden button is a courtesy, never a ' +
        'permission.</div>';
    }

    /* ── one delegated listener ────────────────────────────────────────────── */
    function onClick (e) {
      var b = e.target && e.target.closest && e.target.closest('[data-rst]');
      if (!b || !host.contains(b)) return;
      var a = b.dataset.rst;
      if (a === 'prev')  { S.week = addDays(S.week, -7); return reload(); }
      if (a === 'next')  { S.week = addDays(S.week, 7);  return reload(); }
      if (a === 'retry') return reload();
      if (a === 'tab')   { S.tab = b.dataset.tab; return reload(); }
      if (a === 'assign') return doAssign(b.dataset.roster, b.dataset.slot);
      if (a === 'ack')    return doAcknowledge(b.dataset.roster, b.dataset.slot);
      if (a === 'swap')   return doSwap(b.dataset.roster, b.dataset.slot);
      if (a === 'publish') return doPublish();
    }
    host.addEventListener('click', onClick);

    render();
    reload();

    return {
      refresh: reload,
      destroy: function () { try { host.removeEventListener('click', onClick); } catch (_) {} },
    };
  };

  /* The callable names this surface uses, exported so the gate can assert they match
     pos-shift-scheduler.js exactly rather than being checked by eye. */
  API.CALLABLES = ['getRoster', 'getRosterGaps', 'getStaffRoster', 'assignShift',
                   'acknowledgeShift', 'swapShiftRequest'];
  /* Declared but NOT invoked by this surface, and why — so the gap is visible rather than
     looking like an oversight. */
  API.NOT_WIRED = {
    publishWeeklyRoster:  'needs a slot composer; publishing an empty slots[] would erase the week',
    createShiftTemplate:  'template editor not built',
    setStaffAvailability: 'availability editor not built',
    approveShiftSwap:     'swap inbox not built — requests can be raised, not yet approved here',
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.SokoniMerchantRoster = API;
})(typeof window !== 'undefined' ? window : globalThis);
