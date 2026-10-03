/* sokoni-food-entry.js — the ONE way into a food business workspace (Food Hub S1, owner 2026-10-03).
 *
 * The old "Restaurant Portal" (food-dashboard.html) gave every signed-in user a made-up restaurant. Food businesses now
 * enter through the server's workspace authority — providerDispatch {op:'businessWorkspace'} (functions/business-
 * workspace.js: approval → category → capability → route). This module ASKS and FOLLOWS the answer; it decides nothing:
 *
 *   signed out                                   → sign in, then come back here
 *   approved food business (route merchant-v2)   → /merchant-v2
 *   re-application required (server names page)  → that page (complete-application)
 *   no business on SOKONI                        → the food business application (HubRegister, hub food)
 *   another kind of business                     → told where its own workspace is
 *   pending / suspended / unclassified / conflict→ the server's own explanation
 *   the call fails                               → "could not reach SOKONI" — nothing invented, no route guessed
 *
 * A browser-chosen category never routes anyone: the route comes only from the server's answer.
 * Any element with [data-food-entry] opens it; a page loaded with #food-business opens it on arrival.
 */
(function () {
  'use strict';
  var MERCHANT_URL = '/merchant-v2';
  var SIGNIN_URL = '/login';
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  };
  var MESSAGE = {
    NOT_APPROVED: 'Your food business application is with SOKONI for review. Your workspace opens as soon as it is approved.',
    SUSPENDED: 'Your business is suspended. Contact SOKONI support to restore your workspace.',
    UNCLASSIFIED: 'SOKONI is confirming what kind of business you are. Your workspace opens as soon as that is done.',
    CAPABILITY_CONFLICT: 'Your business records need a SOKONI review before your workspace opens.',
    CATEGORY_CAPABILITY_DISAGREEMENT: 'Your business records need a SOKONI review before your workspace opens.',
    REFUSED: 'SOKONI did not approve this business record. You may submit a new application.',
    APPROVAL_UNREADABLE: 'Your approval record could not be read just now. Nothing has changed; please try again shortly.',
    CAPABILITY_UNREADABLE: 'Your business record could not be read just now. Nothing has changed; please try again shortly.',
  };

  function notice(title, body, cta) {
    var old = document.getElementById('skFoodEntryNotice'); if (old) old.remove();
    var el = document.createElement('div');
    el.id = 'skFoodEntryNotice';
    el.setAttribute('role', 'dialog'); el.setAttribute('aria-modal', 'true'); el.setAttribute('aria-labelledby', 'skFoodEntryTitle');
    el.style.cssText = 'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(0,0,0,.6)';
    el.innerHTML = '<div style="max-width:440px;width:100%;background:#0d130d;border:1px solid rgba(249,115,22,.3);border-radius:18px;padding:22px;color:#fff;font-family:inherit">' +
      '<div id="skFoodEntryTitle" style="font-size:17px;font-weight:900;margin-bottom:8px">' + esc(title) + '</div>' +
      '<div style="font-size:13px;line-height:1.6;color:rgba(255,255,255,.7);margin-bottom:16px">' + esc(body) + '</div>' +
      '<div style="display:flex;gap:10px;justify-content:flex-end;flex-wrap:wrap">' + (cta || '') +
      '<button type="button" data-sk-close style="padding:10px 18px;border-radius:12px;border:1px solid rgba(255,255,255,.2);background:transparent;color:#fff;font-weight:700;cursor:pointer;min-height:44px">Close</button></div></div>';
    el.addEventListener('click', function (e) { if (e.target === el || (e.target && e.target.hasAttribute && e.target.hasAttribute('data-sk-close'))) el.remove(); });
    document.body.appendChild(el);
    var b = el.querySelector('[data-sk-close]'); if (b && b.focus) b.focus();
    return el;
  }

  function currentUser() {
    return new Promise(function (resolve) {
      var a = window.firebaseAuth;
      if (!a) return resolve(null);
      if (a.currentUser) return resolve(a.currentUser);
      if (typeof a.onAuthStateChanged !== 'function') return resolve(null);
      var off = a.onAuthStateChanged(function (u) { try { off && off(); } catch (_) {} resolve(u || null); });
    });
  }

  function apply() {
    var reg = window.HubRegister;
    if (reg && typeof reg.open === 'function') { reg.open({ hub: 'food', category: 'restaurant' }); return 'apply'; }
    window.location.assign('/food.html#food-apply');
    return 'apply-redirect';
  }

  /** Decide from the SERVER's answer only. Exposed for tests. Returns the action taken. */
  function follow(w) {
    if (!w || typeof w !== 'object') { notice('Something went wrong', 'SOKONI did not return an answer. Nothing has changed; please try again.'); return 'error'; }
    if (w.route === 'merchant-v2.html' && w.state === 'AVAILABLE') { window.location.assign(MERCHANT_URL); return 'merchant'; }
    if (w.state === 'REAPPLICATION_REQUIRED' && w.route) { window.location.assign('/' + String(w.route).replace(/^\//, '')); return 'reapply'; }
    if (w.found === false || w.reason === 'NO_APPROVED_BUSINESS') return apply();
    if (w.route && w.state === 'AVAILABLE') {
      notice('Food tools are for food businesses', 'Your SOKONI business is registered as ' + (w.label || 'another kind of business') + '. Your workspace is ready.',
        '<a href="/' + esc(String(w.route).replace(/^\//, '')) + '" style="padding:10px 18px;border-radius:12px;background:#f97316;color:#060b06;font-weight:900;text-decoration:none;min-height:44px;display:inline-flex;align-items:center">Open my workspace</a>');
      return 'other-workspace';
    }
    notice('Your food business', w.message || MESSAGE[w.reason] || MESSAGE[w.state] || 'Your workspace is not available yet.');
    return 'held';
  }

  async function open() {
    var u = await currentUser();
    if (!u) { window.location.assign(SIGNIN_URL + '?next=' + encodeURIComponent((window.location.pathname || '/food.html') + '#food-business')); return 'signin'; }
    var call = typeof window.sokoniCallable === 'function' ? window.sokoniCallable('providerDispatch') : null;
    if (!call) { notice('Could not reach SOKONI', 'Check your connection and try again. Nothing has changed.'); return 'error'; }
    var w;
    try { var r = await call({ op: 'businessWorkspace' }); w = r && r.data; }
    catch (e) { notice('Could not reach SOKONI', 'Check your connection and try again. Nothing has changed.'); return 'error'; }
    return follow(w);
  }

  document.addEventListener('click', function (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-food-entry]') : null;
    if (!t) return;
    e.preventDefault(); e.stopPropagation();
    open();
  });
  function arrive() {
    if (window.location.hash === '#food-business') open();
    else if (window.location.hash === '#food-apply') { var tries = 0; (function waitReg() { if (window.HubRegister && window.HubRegister.open) apply(); else if (tries++ < 40) setTimeout(waitReg, 150); })(); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', arrive); else arrive();
  window.SokoniFoodEntry = { open: open, follow: follow };
})();
