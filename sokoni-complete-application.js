/* sokoni-complete-application.js — the "Complete your business application" surface (REAPPLICATION_REQUIRED).
 *
 * The browser asks the ONE workspace authority (providerDispatch {op:'businessWorkspace'} → functions/business-workspace.js,
 * whose first answer is the server-DERIVED approval state) and renders what it says. It decides nothing:
 *
 *   REAPPLICATION_REQUIRED   fresh                → "Start your application" → the EXISTING intake (HubRegister.open)
 *                            redecide_existing    → acknowledge the current agreement on that application (/agreement-acknowledge),
 *                            continue_existing      then SOKONI decides — the page explains; the acknowledgement surface writes
 *                            select_among_pending → every pending application listed; the applicant WITHDRAWS the extras
 *                                                   (status 'withdrawn' — a non-decisive status the rules let the owner write)
 *                                                   and continues one; nothing is chosen for them, nothing is created
 *   PENDING_APPROVAL         "with SOKONI for review" (+ acknowledgement prompt if the agreement is not at the current version)
 *   REFUSED                  the server's message + "Submit a new application" (the existing intake)
 *   REMEDIATION_WITHHELD     "under SOKONI review", no action
 *   AVAILABLE / other found  "approved" + a link to the server-named route
 *   found:false              buyer: nothing to complete; the intake is offered, never forced
 *   APPROVAL_UNREADABLE      retry
 *
 * The page never writes approval state, never creates an application itself, never touches wallet/bookings/services.
 * Its ONLY write is the applicant's own `status: 'withdrawn'` on a pending application they chose to withdraw.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SokoniCompleteApplication = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  /* PURE: what to show for a workspace answer. Unit-tested; the DOM below only renders this. */
  function decide(w) {
    if (!w) return { view: 'unreadable', cta: null };
    if (w.state === 'APPROVAL_UNREADABLE' || (w.approval && w.approval.state === 'UNREADABLE')) return { view: 'unreadable', cta: null };
    if (w.found === false) return { view: 'buyer', cta: 'intake', optional: true };
    var rem = w.remediation || {}; var path = rem.applicationPath || {}; var ag = rem.agreement || {};
    /* several pending applications: the applicant must choose, whether the server holds the account as PENDING_APPROVAL
       (Heights: pending provider) or as REAPPLICATION_REQUIRED (a live-by-status record with duplicates) */
    if (path.mode === 'select_among_pending' && (w.state === 'REAPPLICATION_REQUIRED' || w.state === 'PENDING_APPROVAL')) return { view: 'select', candidates: path.candidates || [], cta: 'withdraw' };
    if (w.state === 'REAPPLICATION_REQUIRED') {
      if (path.mode === 'fresh') return { view: 'fresh', cta: 'intake' };
      if (path.mode === 'redecide_existing' || path.mode === 'continue_existing') return { view: ag.satisfied ? 'awaiting_decision' : 'acknowledge', applicationId: path.applicationId, cta: ag.satisfied ? null : 'acknowledge' };
      return { view: 'fresh', cta: 'intake' };
    }
    if (w.state === 'PENDING_APPROVAL' && w.reason === 'NOT_APPROVED' && rem.applicationPath) return { view: ag.satisfied === false && ag.required ? 'acknowledge' : 'pending', applicationId: path.applicationId || null, cta: ag.satisfied === false && ag.required ? 'acknowledge' : null };
    if (w.state === 'REFUSED') return { view: 'refused', cta: 'intake' };
    if (w.state === 'REMEDIATION_WITHHELD') return { view: 'withheld', cta: null };
    if (w.route && w.route !== 'complete-application.html') return { view: 'approved', route: w.route, cta: 'route' };
    return { view: 'pending', cta: null };
  }

  var COPY = {
    fresh: ['Complete your business application', 'Your previous registration needs to be completed before your business workspace can be activated. Start your application below; it goes to SOKONI for review through the normal process.'],
    acknowledge: ['Acknowledge the current Seller Agreement', 'Your application is on file. Before SOKONI can decide it, you need to acknowledge the current SOKONI Seller Agreement and its commission rates.'],
    awaiting_decision: ['Your application is complete', 'Your application and your agreement acknowledgement are on file. SOKONI reviews it and decides; nothing more is needed from you.'],
    select: ['You have more than one pending application', 'SOKONI can only review one. Withdraw the ones you do not want to keep, then acknowledge the agreement on the one you keep. Nothing is chosen for you.'],
    pending: ['Your application is with SOKONI for review', 'You will be notified when it is decided.'],
    refused: ['SOKONI did not approve this business record', 'You may submit a new application; it will be reviewed through the normal process.'],
    withheld: ['Your business record is under SOKONI review', 'Nothing is required from you right now.'],
    approved: ['Your business is approved', 'Your workspace is ready.'],
    buyer: ['No business application to complete', 'This account has no business registration. You can register a business at any time.'],
    unreadable: ['Your approval record could not be read just now', 'Nothing has changed. Please try again shortly.'],
  };

  function mount(o) {
    o = o || {}; var host = o.host; if (!host) throw new Error('host required');
    var state = { w: null, d: null, busy: false };
    host.setAttribute('data-ca-state', 'loading');
    function render() {
      var d = state.d; var c = COPY[d.view] || COPY.unreadable; var w = state.w || {};
      var body = '<h1 class="ca-h1">' + esc(c[0]) + '</h1><p class="ca-lede">' + esc(w.message && d.view !== 'approved' && d.view !== 'buyer' ? w.message : c[1]) + '</p>';
      if (d.view === 'select') {
        body += '<ul class="ca-list">' + d.candidates.map(function (id) { return '<li class="ca-row" data-ca-candidate="' + esc(id) + '"><span>Application <code>' + esc(id) + '</code></span><span class="ca-actions"><a class="ca-btn" href="/agreement-acknowledge" data-ca-keep="' + esc(id) + '">Keep &amp; acknowledge</a><button type="button" class="ca-btn ca-btn-quiet" data-ca-withdraw="' + esc(id) + '">Withdraw</button></span></li>'; }).join('') + '</ul><p class="ca-note" data-ca-result aria-live="polite"></p>';
      }
      if (d.cta === 'intake') body += '<button type="button" class="ca-btn ca-btn-primary" data-ca-intake>' + (d.view === 'refused' ? 'Submit a new application' : d.view === 'buyer' ? 'Register a business' : 'Start your application') + '</button>';
      if (d.cta === 'acknowledge') body += '<a class="ca-btn ca-btn-primary" href="/agreement-acknowledge" data-ca-acknowledge>Acknowledge the agreement</a>';
      if (d.cta === 'route') body += '<a class="ca-btn ca-btn-primary" href="/' + esc(String(d.route).replace(/^\//, '')) + '" data-ca-route>Open your workspace</a>';
      host.innerHTML = body;
      host.setAttribute('data-ca-state', d.view);
      host.setAttribute('data-ws-state', String(w.state || ''));
    }
    host.addEventListener('click', function (ev) {
      var t = ev.target.closest ? ev.target : null; if (!t) return;
      var intake = t.closest('[data-ca-intake]'); if (intake) { if (o.openIntake) o.openIntake(); else if (root && root.HubRegister) root.HubRegister.open({}); return; }
      var wd = t.closest('[data-ca-withdraw]'); if (wd) withdraw(wd.getAttribute('data-ca-withdraw'));
    });
    function withdraw(id) {
      if (state.busy || !o.withdraw) return;
      var out = host.querySelector('[data-ca-result]'); state.busy = true; if (out) out.textContent = 'Withdrawing ' + id + '…';
      Promise.resolve().then(function () { return o.withdraw(id); }).then(function () { state.busy = false; if (out) out.textContent = 'Application ' + id + ' withdrawn.'; return load(); })
        .catch(function (e) { state.busy = false; if (out) out.textContent = 'Not withdrawn: ' + esc((e && e.message) || 'unknown error') + '. Try again.'; });
    }
    function load() {
      return Promise.resolve().then(function () { return o.workspace(); }).then(function (w) { state.w = w; state.d = decide(w); render(); })
        .catch(function (e) { state.w = null; state.d = decide(null); render(); host.setAttribute('data-ca-error', (e && e.code) || 'call_failed'); });
    }
    load();
    return { state: state, reload: load };
  }

  return { decide: decide, mount: mount, COPY: COPY };
}));
