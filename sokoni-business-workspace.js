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

  function apply(w) {
    if (!w || !w.modules) return;
    var mods = w.modules;
    document.documentElement.setAttribute('data-ws-state', String(w.state || ''));
    Array.prototype.forEach.call(document.querySelectorAll('[data-hc-section]'), function (el) {
      var m = mods[el.getAttribute('data-hc-section')];
      var show = !!(m && m.state === 'AVAILABLE');
      el.hidden = !show;
      if (show) el.removeAttribute('aria-hidden'); else el.setAttribute('aria-hidden', 'true');
    });
    Array.prototype.forEach.call(document.querySelectorAll('.sb-group'), function (g) {
      var items = g.querySelectorAll ? g.querySelectorAll('[data-hc-section]') : [];
      g.hidden = !Array.prototype.some.call(items, function (el) { return !el.hidden; });
    });
    var box = document.getElementById('hcWorkspace');
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
