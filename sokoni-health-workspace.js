/* sokoni-health-workspace.js — the category-aware Healthcare workspace on provider-dashboard.html (CHANGELOG 233).
 *
 * The SERVER decides what a Healthcare practice's dashboard offers (functions/healthcare-workspace.js via
 * providerDispatch {op:'healthcareWorkspace'}): its category (admin/server-classified, never free text) and
 * its live plan. This file only APPLIES that answer — it hides sections the practice is not offered, labels
 * the roster "Patients", and states the category, the plan and what is blocked. Hiding is presentation;
 * every hidden operation is refused on the server as well.
 *
 * A provider that is not a Healthcare account (server says healthcare:false) is left exactly as it was.
 * If the call fails, nothing is hidden and nothing is invented (no guessed category); the full menu stays and
 * the server gates still refuse what the category does not offer.
 */
(function () {
  'use strict';
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };

  function apply(w) {
    var root = document.documentElement;
    root.setAttribute('data-hc-workspace', w.category || 'unclassified');
    routeAvailability();
    var allowed = {};
    (w.sections || []).forEach(function (s) { allowed[s] = true; });
    Array.prototype.forEach.call(document.querySelectorAll('[data-hc-section]'), function (el) {
      if (!allowed[el.getAttribute('data-hc-section')]) { el.hidden = true; el.setAttribute('aria-hidden', 'true'); }
    });
    Array.prototype.forEach.call(document.querySelectorAll('[data-hc-label="customers"]'), function (el) {
      el.textContent = w.customersLabel || 'Patients';
    });
    var box = document.getElementById('hcWorkspace');
    if (!box) return;
    var plan = w.plan && w.plan.found && w.plan.tier
      ? esc(String(w.plan.tier).replace(/_/g, ' ')) + ' plan · ' + esc(w.plan.status)
      : 'No active Healthcare plan';
    var notes = [];
    if (!w.classified) notes.push('SOKONI has not yet classified your practice. Until it does, you can manage your appointments and patients; other tools unlock once it is classified.');
    if (w.blocked && w.blocked.quickCharge) notes.push(esc(w.blocked.quickCharge));
    if (w.blocked && w.blocked.calls) notes.push(esc(w.blocked.calls));
    box.innerHTML =
      '<div class="hc-ws-head"><span class="hc-ws-cat">' + esc(w.label) + '</span>' +
      '<span class="hc-ws-plan">' + plan + '</span></div>' +
      (notes.length ? '<ul class="hc-ws-notes">' + notes.map(function (n) { return '<li>' + n + '</li>'; }).join('') + '</ul>' : '');
    box.hidden = false;
  }

  /* ── Availability through the server, never a direct write (CHANGELOG 234) ──────────────────────
     firestore.rules deny a Healthcare provider direct writes to providerAvailability/{uid} and its overrides:
     the ONE availability authority is the server. The dashboard's quick actions (AvQ) and its bottom-sheet
     editor (AvE) write that doc from the browser, so for a Healthcare workspace they are routed to the existing
     callables instead:
       editor                 → the workspace editor (entAvailSetConfig — audited, plan-enforced)
       close today / block    → addAvailabilityOverride      (server-validated date, closed)
       open today             → removeAvailabilityOverride + setVacationMode(false)
       vacation               → setVacationMode              (a start AND an end date — the server requires both)
     Success is shown only after the server answered. Other providers keep the page as it was. */
  function routeAvailability() {
    var AvQ = window.AvQ, AvE = window.AvE;
    if (!AvQ || AvQ._hcRouted) return;
    var call = function (op, data) {
      return firebase.functions().httpsCallable('bookingDispatch')(Object.assign({ op: op }, data || {}));
    };
    var say = function (m, kind) { try { window.toast ? window.toast(m, kind) : alert(m); } catch (_) {} };
    var busy = function (m) { try { if (window.showLoad) window.showLoad(m); } catch (_) {} };
    var done = function () { try { if (window.hideLoad) window.hideLoad(); } catch (_) {} };
    var failed = function (e) { say((e && e.message) || 'That did not save. Try again.', 'err'); };
    var today = function () { return new Date().toISOString().slice(0, 10); };
    var isDate = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); };
    var refresh = function () { try { AvQ._refresh(); } catch (_) {} };
    var close = function (date, label, okMsg) {
      busy('Saving…');
      return call('addAvailabilityOverride', { date: date, closed: true, label: label })
        .then(function () { done(); say(okMsg); refresh(); }, function (e) { done(); failed(e); });
    };
    AvQ.emergencyClose = function () {
      var go = function () { return close(today(), 'Closed today', 'Closed today for new bookings.'); };
      if (window.SK && SK.dialog && SK.dialog.confirm) {
        return SK.dialog.confirm('Close TODAY for new bookings? Existing confirmed bookings are unaffected.', null, null,
          { title: 'Close today', variant: 'danger', confirmLabel: 'Close today' }).then(function (ok) { if (ok) return go(); });
      }
      return go();
    };
    AvQ.blockDate = function () {
      var d = (prompt('Block which date? (YYYY-MM-DD)') || '').trim();
      if (!d) return;
      if (!isDate(d)) { say('Use YYYY-MM-DD format.', 'err'); return; }
      return close(d, 'Blocked', 'Date blocked: ' + d);
    };
    AvQ.openToday = function () {
      busy('Opening today…');
      return call('removeAvailabilityOverride', { date: today() })
        .then(function () { return call('setVacationMode', { active: false }); })
        .then(function () { done(); say("You're open today."); refresh(); }, function (e) { done(); failed(e); });
    };
    AvQ.vacation = function () {
      var start = (prompt('Vacation from? (YYYY-MM-DD)', today()) || '').trim();
      if (!start) return;
      var end = (prompt('Vacation until? (YYYY-MM-DD)') || '').trim();
      if (!isDate(start) || !isDate(end) || end < start) { say('Enter a start and an end date (YYYY-MM-DD), end on or after start.', 'err'); return; }
      busy('Saving…');
      return call('setVacationMode', { active: true, startDate: start, endDate: end })
        .then(function () { done(); say('Vacation set until ' + end + '.'); refresh(); }, function (e) { done(); failed(e); });
    };
    if (AvE) {
      AvE.open = function () {
        /* WS is a top-level const in provider-dashboard.html: a shared global binding, NOT a window property. */
        if (typeof WS !== 'undefined' && WS && typeof WS.open === 'function') return WS.open('availability', null);
        say('The availability editor is still loading. Try again in a moment.', 'err');
      };
    }
    AvQ._hcRouted = true;
  }

  /* A failed call cannot tell us whether this is a Healthcare account at all, so nothing is shown to a
     non-Healthcare provider and nothing is hidden from anyone. Every hidden operation is refused
     server-side anyway — the page falling back to the full menu opens no capability. */
  function fail(e) {
    try { console.warn('[health-workspace] not applied', e && (e.code || e.message)); } catch (_) {}
  }

  function load() {
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) return;
    var off = firebase.auth().onAuthStateChanged(function (user) {
      if (typeof off === 'function') off();
      if (!user) return;
      firebase.functions().httpsCallable('providerDispatch')({ op: 'healthcareWorkspace' })
        .then(function (r) { var w = r && r.data; if (w && w.healthcare) apply(w); })
        .catch(fail);
    });
  }

  var css = document.createElement('style');
  css.textContent =
    '.hc-ws{margin:0 0 14px;padding:12px 14px;border:1px solid var(--bdr,#2a2a2a);border-radius:12px;background:var(--card,#141414)}' +
    '.hc-ws-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between}' +
    '.hc-ws-cat{font-weight:800}' +
    '.hc-ws-plan{font-size:.78rem;color:var(--sub,#9a9a9a);text-transform:capitalize}' +
    '.hc-ws-notes{margin:8px 0 0;padding-left:18px;font-size:.78rem;color:var(--sub,#9a9a9a)}' +
    '.hc-ws-notes li{margin:2px 0;overflow-wrap:anywhere}';
  document.head.appendChild(css);

  window.SokoniHealthWorkspace = { apply: apply, routeAvailability: routeAvailability };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
