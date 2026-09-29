/* sokoni-agreement-acknowledge.js — re-acknowledge the SOKONI Seller Agreement on an EXISTING application.
 *
 * WHY THIS EXISTS (owner decision 2026-09-29, Kasindi repair)
 *   The Seller Agreement acknowledgement is written by the intake forms at submission (hub-register.js,
 *   sokoni-merchant-application.js): `agreementAccepted`, `agreementVersion`, `agreementAcceptedAt`. An application
 *   filed before the gate existed, or acknowledged against an older version, has no way to catch up: the reviewer's
 *   approve is refused (failed-precondition) and the business has no surface to act on. This is that surface — the
 *   SMALLEST one: it lists the signed-in user's own applications, shows the agreement, and writes the SAME three
 *   fields the intake writes, dated NOW. Nothing else.
 *
 * WHAT IT NEVER DOES
 *   · backdate — `agreementAcceptedAt` is the moment the button is pressed, never the application's date
 *   · write for someone else — only the signed-in uid's own applications are listed; firestore.rules refuses the rest
 *   · touch a decision — status, decidedBy, priorDecisions, agreementVerifiedAt are server-only (rules + FORBIDDEN)
 *   · invent a version — the version comes from sokoni-merchant-application.js (one string for every surface);
 *     without it the surface refuses to mount rather than acknowledge "something"
 *   · cover roles whose acceptance is versioned elsewhere — healthcare, advocates and event organizers accept
 *     their instruments through legalAccept; for those the page points, it does not write
 *
 * API (UMD: window.SokoniAgreementAck / module.exports)
 *   eligible(app, version)           → { state: 'eligible' | 'current' | 'versioned_elsewhere' | 'closed', ... }
 *   buildAcknowledgement(version, now) → the exact patch written (pure)
 *   mount({ host, version, uid, listApplications, write, fetchTerms, now })
 *     listApplications(uid) → Promise<[{id, ...data}]>   write(id, patch) → Promise   fetchTerms() → Promise<html>
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniAgreementAck = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  var G = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
  var SURFACE = 'agreement-acknowledge';
  var VERSIONED_ROLES = ['health', 'legal', 'event_organizer'];
  var CLOSED = ['rejected', 'declined', 'denied', 'revoked', 'banned', 'disabled', 'withdrawn'];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function statusOf(a) { return String((a && (a.statusCanonical || a.status)) || 'pending').toLowerCase(); }
  function roleOf(a) { return String((a && a.role) || '').toLowerCase(); }
  function isHealthcare(a) { return roleOf(a) === 'health' || String((a && a.hub) || '').toLowerCase() === 'healthcare'; }

  function eligible(app, version) {
    if (!version) return { state: 'closed', reason: 'no_version' };
    if (!app) return { state: 'closed', reason: 'no_application' };
    if (isHealthcare(app) || VERSIONED_ROLES.indexOf(roleOf(app)) !== -1) return { state: 'versioned_elsewhere', reason: 'legal_acceptances' };
    if (CLOSED.indexOf(statusOf(app)) !== -1) return { state: 'closed', reason: 'status_' + statusOf(app) };
    if (app.agreementAccepted === true && app.agreementVersion === version) return { state: 'current', acceptedAt: app.agreementAcceptedAt || null };
    return { state: 'eligible', reason: app.agreementAccepted === true ? 'outdated_version' : 'never', previousVersion: app.agreementVersion || null };
  }

  /* The exact patch. Same three fields the intake writes + the surface marker (provenance for the census). */
  function buildAcknowledgement(version, now) {
    if (!version) throw new Error('agreement version required');
    var d = now instanceof Date ? now : new Date();
    if (isNaN(d.getTime())) throw new Error('invalid clock');
    return { agreementAccepted: true, agreementVersion: version, agreementAcceptedAt: d.toISOString(), agreementAcknowledgedSurface: SURFACE };
  }

  function mount(o) {
    o = o || {};
    var host = o.host; if (!host) throw new Error('host required');
    var version = o.version || (G.SokoniMerchantApplication && G.SokoniMerchantApplication.AGREEMENT_VERSION) || null;
    var now = typeof o.now === 'function' ? o.now : function () { return new Date(); };
    var state = { apps: [], termsLoaded: false, busy: false };
    host.setAttribute('data-ack-state', 'loading');
    if (!version) { host.setAttribute('data-ack-state', 'no_version'); host.innerHTML = '<p class="ack-note" data-ack-error>The current agreement version is unavailable on this page, so nothing can be acknowledged. Reload and try again.</p>'; return { state: state }; }
    if (!o.uid) { host.setAttribute('data-ack-state', 'signed_out'); host.innerHTML = '<p class="ack-note" data-ack-signed-out>Sign in with the account that submitted the application to acknowledge the agreement.</p>'; return { state: state }; }

    function render() {
      var rows = state.apps.map(function (a) {
        var e = eligible(a, version);
        var name = esc(a.name || a.businessName || a.storeName || a.type || a.id);
        var meta = esc([a.type || a.category || '', 'status: ' + statusOf(a)].filter(Boolean).join(' · '));
        var body;
        if (e.state === 'current') body = '<span class="ack-pill ack-pill-ok" data-ack-current>Acknowledged ' + esc(e.acceptedAt ? String(e.acceptedAt).slice(0, 10) : '') + ' (current version)</span>';
        else if (e.state === 'versioned_elsewhere') body = '<span class="ack-pill" data-ack-elsewhere>This application accepts its agreements in its own hub (versioned instruments), not here.</span>';
        else if (e.state === 'closed') body = '<span class="ack-pill" data-ack-closed>No acknowledgement needed for a ' + esc(statusOf(a)) + ' application.</span>';
        else body = '<button type="button" class="ack-btn" data-ack-open="' + esc(a.id) + '">' + (e.reason === 'outdated_version' ? 'Acknowledge the updated agreement' : 'Read and acknowledge the agreement') + '</button>';
        return '<li class="ack-row" data-ack-app="' + esc(a.id) + '" data-ack-eligible="' + e.state + '"><div class="ack-row-main"><strong>' + name + '</strong><span class="ack-meta">' + meta + '</span></div>' + body + '</li>';
      });
      host.innerHTML = rows.length
        ? '<ul class="ack-list">' + rows.join('') + '</ul><div class="ack-panel" data-ack-panel hidden></div>'
        : '<p class="ack-note" data-ack-empty>No applications are linked to this account.</p>';
      host.setAttribute('data-ack-state', 'ready');
    }

    function openFor(id) {
      var a = state.apps.filter(function (x) { return x.id === id; })[0]; if (!a) return;
      var panel = host.querySelector('[data-ack-panel]'); if (!panel) return;
      panel.hidden = false;
      panel.innerHTML =
        '<h2 class="ack-h2">SOKONI Seller Agreement</h2>' +
        '<p class="ack-note">Version <code>' + esc(version) + '</code>. You are acknowledging it for <strong>' + esc(a.name || a.type || a.id) + '</strong> today; the acknowledgement is dated when you press the button.</p>' +
        '<div class="ack-terms" data-ack-terms aria-live="polite">Loading the agreement…</div>' +
        '<label class="ack-check"><input type="checkbox" data-ack-tick> <span>I have read and agree to the SOKONI Seller Agreement and its commission rates — by plan on marketplace orders, and 5% on in-shop POS / Till sales.</span></label>' +
        '<button type="button" class="ack-btn ack-btn-primary" data-ack-confirm="' + esc(a.id) + '" disabled>Acknowledge now</button>' +
        '<p class="ack-note" data-ack-result aria-live="polite"></p>';
      var terms = panel.querySelector('[data-ack-terms]');
      (o.fetchTerms ? o.fetchTerms() : Promise.reject(new Error('no terms loader')))
        .then(function (html) { if (!html) throw new Error('empty'); terms.innerHTML = html; })
        .catch(function () { terms.innerHTML = '<p>The agreement could not be loaded here. <a href="/seller-terms" target="_blank" rel="noopener">Open the SOKONI Seller Agreement in a new tab</a> to read it in full.</p>'; });
      panel.querySelector('[data-ack-tick]').addEventListener('change', function (ev) { panel.querySelector('[data-ack-confirm]').disabled = !ev.target.checked; });
      panel.querySelector('[data-ack-confirm]').addEventListener('click', function () { confirm(a, panel); });
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    function confirm(a, panel) {
      if (state.busy) return;
      var tick = panel.querySelector('[data-ack-tick]'); var btn = panel.querySelector('[data-ack-confirm]'); var out = panel.querySelector('[data-ack-result]');
      if (!tick || !tick.checked) { out.textContent = 'Tick the box to confirm you have read the agreement.'; return; }
      var patch;
      try { patch = buildAcknowledgement(version, now()); } catch (e) { out.textContent = 'Could not build the acknowledgement: ' + e.message; return; }
      state.busy = true; btn.disabled = true; out.textContent = 'Saving…';
      Promise.resolve().then(function () { return o.write(a.id, patch); }).then(function () {
        /* Success is shown only after the write returned — never before. */
        a.agreementAccepted = true; a.agreementVersion = patch.agreementVersion; a.agreementAcceptedAt = patch.agreementAcceptedAt; a.agreementAcknowledgedSurface = SURFACE;
        state.busy = false; render();
        host.setAttribute('data-ack-last', a.id);
      }).catch(function (e) {
        state.busy = false; btn.disabled = false;
        out.textContent = 'The acknowledgement was NOT saved: ' + esc((e && e.message) || 'unknown error') + '. Check your connection and try again.';
        host.setAttribute('data-ack-error', (e && e.code) || 'write_failed');
      });
    }

    host.addEventListener('click', function (ev) { var b = ev.target.closest && ev.target.closest('[data-ack-open]'); if (b) openFor(b.getAttribute('data-ack-open')); });
    Promise.resolve().then(function () { return o.listApplications(o.uid); }).then(function (apps) {
      state.apps = (apps || []).filter(function (a) { return a && a.uid === o.uid; });
      render();
    }).catch(function (e) {
      host.setAttribute('data-ack-state', 'unreadable');
      host.innerHTML = '<p class="ack-note" data-ack-error>Your applications could not be read: ' + esc((e && e.message) || 'unknown error') + '</p>';
    });
    return { state: state, render: render };
  }

  return { SURFACE: SURFACE, eligible: eligible, buildAcknowledgement: buildAcknowledgement, mount: mount };
}));
