/* sokoni-business-workspace.js — provider-dashboard.html is a PROJECTION of the server workspace (CHANGELOG 241, C2d).
 *
 * The browser asks "what workspace am I entitled to?" (providerDispatch {op:'businessWorkspace'}, functions/business-
 * workspace.js — C1 category + business model + plan) and renders the answer. It decides nothing:
 *
 *   AVAILABLE                         shown
 *   every other state                 hidden — NOT_APPLICABLE, NOT_IMPLEMENTED, LOCKED, COMMERCIAL_DECISION_REQUIRED,
 *                                     PENDING_APPROVAL
 *   a sidebar group left empty        hidden with its heading
 *
 * Hiding is presentation. Every operation behind a hidden module is ALSO refused by the server (C2b), so a crafted
 * call gets the same answer the sidebar gives.
 *
 * A pending / unclassified / suspended business, and a category whose workspace is not built yet (hotel, restaurant,
 * property), get an explanatory banner. Internal commercial states are never shown to the provider as such.
 * If the call fails, nothing is hidden or invented — the server gates still hold.
 */
(function () {
  'use strict';
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var MESSAGE = {
    NOT_APPROVED: 'Your business is not approved yet. Your workspace opens as soon as SOKONI approves it.',
    SUSPENDED: 'Your business is suspended. Contact SOKONI support to restore your workspace.',
    UNCLASSIFIED: 'SOKONI is confirming what kind of business you are. Your full workspace opens as soon as that is done.',
    NO_APPROVED_BUSINESS: 'You do not have an approved business on SOKONI yet.',
  };

  /* SHELL GATE (REAPPLICATION_REQUIRED): the server's derived approval state decides where this account belongs.
     An account whose registration must be completed is sent to the completion surface the server names — the
     dashboard never renders for it. REFUSED / withheld / pending accounts see the server's explanation here. */
  var GATE_MESSAGE = {
    REFUSED: 'SOKONI did not approve this business record. You may submit a new application.',
    CLEANUP_OWNED: 'Your business record is under SOKONI review. Nothing is required from you right now.',
    APPROVAL_UNREADABLE: 'Your approval record could not be read just now. Nothing has changed; please try again shortly.',
  };
  function apply(w) {
    if (!w || !w.modules) return;
    if (w.state === 'REAPPLICATION_REQUIRED' && w.route && !window.__sokoniNoRedirect) {
      document.documentElement.setAttribute('data-ws-state', 'REAPPLICATION_REQUIRED');
      window.location.replace('/' + String(w.route).replace(/^\//, ''));
      return;
    }
    var mods = w.modules;
    document.documentElement.setAttribute('data-ws-state', String(w.state || ''));
    if (GATE_MESSAGE[w.reason] && !w.message) w.message = GATE_MESSAGE[w.reason];
    Array.prototype.forEach.call(document.querySelectorAll('[data-hc-section]'), function (el) {
      var m = mods[el.getAttribute('data-hc-section')];
      var show = !!(m && m.state === 'AVAILABLE');
      el.hidden = !show;
      if (show) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
    });
    /* [data-hc-module] (Tech Hub slice 4b): looked up by MODULE key — [data-hc-section] above is keyed by section name,
       which differs from the module key for ratecards / bookingpin / supporteddevices … and so never matched them.
       Elements carrying it start hidden in the markup: no workspace answer → they stay hidden (fail closed). */
    Array.prototype.forEach.call(document.querySelectorAll('[data-hc-module]'), function (el) {
      var m = mods[el.getAttribute('data-hc-module')];
      var show = !!(m && m.state === 'AVAILABLE');
      el.hidden = !show;
      if (show) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
    });
    /* Consumers that need the granted capabilities (the Tech service editor) read the same answer — never a second call. */
    window.__sokoniWorkspace = w;
    try { document.dispatchEvent(new CustomEvent('sokoni:workspace', { detail: w })); } catch (_) {}
    Array.prototype.forEach.call(document.querySelectorAll('.sb-group'), function (g) {
      var items = g.querySelectorAll ? g.querySelectorAll('[data-hc-section]') : [];
      g.hidden = !Array.prototype.some.call(items, function (el) { return !el.hidden; });
    });
    var box = document.getElementById('hcWorkspace');
    /* A dashboard without the workspace notice box (the live provider-dashboard.html) still gets the server's
       explanation for a held account: the box is created at the top of the page rather than the message being lost. */
    if (!box && w.state !== 'AVAILABLE' && (w.message || MESSAGE[w.reason])) {
      box = document.createElement('div'); box.id = 'hcWorkspace'; box.className = 'hc-ws-notice';
      box.setAttribute('role', 'status'); box.style.cssText = 'margin:12px 16px;padding:12px 14px;border:1px solid rgba(255,255,255,.18);border-radius:10px;background:rgba(255,255,255,.04);font:14px/1.5 system-ui;color:#eee';
      var anchor = document.querySelector('main') || document.body; anchor.insertBefore(box, anchor.firstChild);
    }
    var note = w.message || MESSAGE[w.reason] || null;
    /* A non-AVAILABLE workspace always explains itself; an AVAILABLE one does so only when the server sends a message —
       a profile notice for capabilities that apply but are not built yet (a hotel's stays), which the sidebar would
       otherwise hide without a word. */
    if (box && note && (w.state !== 'AVAILABLE' || w.message) && w.state !== 'LEGACY_UNCLASSIFIED') {
      box.innerHTML = '<div class="hc-ws-head"><span class="hc-ws-cat">' + esc(w.label || 'Your business') + '</span></div>' +
        '<ul class="hc-ws-notes"><li>' + esc(note) + '</li></ul>';
      box.hidden = false;
    }
  }

  function load() {
    if (typeof firebase === 'undefined' || !firebase.auth || !firebase.functions) return;
    var off = firebase.auth().onAuthStateChanged(function (user) {
      if (typeof off === 'function') off();
      if (!user) return;
      firebase.functions().httpsCallable('providerDispatch')({ op: 'businessWorkspace' })
        .then(function (r) { apply(r && r.data); })
        .catch(function (e) { try { console.warn('[business-workspace] not applied', e && (e.code || e.message)); } catch (_) {} });
    });
  }

  window.SokoniBusinessWorkspace = { apply: apply };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load); else load();
})();
