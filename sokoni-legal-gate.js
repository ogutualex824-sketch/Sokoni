/* ============================================================================
   SOKONI — Universal Legal Acceptance Gate  (sokoni-legal-gate.js)

   One reusable component used by EVERY module/role. It is the browser-side of
   the Legal Compliance Engine (backend: legalDispatch). No framework required —
   works on any SOKONI page (compat or modular Firebase).

     SokoniLegalGate.mount(el, { role, onComplete })   // gate: accept-to-continue
     SokoniLegalGate.settings(el, { role })            // Account → Legal & Agreements
     SokoniLegalGate.check(role) -> { compliant, missing }

   Reuses the existing SOKONI legal doc pages (no new pages) and inherits the
   page's design tokens (--sk-green / --sk-accent / --sk-border) — no redesign.
   ========================================================================== */
(function () {
  'use strict';

  var LEGAL_DOC = {
    'terms-of-service': 'terms.html', 'privacy-policy': 'privacy.html',
    'cookie-policy': 'cookie-policy.html', 'community-standards': 'community-guidelines.html',
    'acceptable-use': 'trust-and-safety.html',
    'merchant-agreement': 'seller-terms.html', 'marketplace-seller-terms': 'seller-terms.html',
    'returns-refund-policy': 'returns-policy.html', 'data-processing-agreement': 'privacy.html',
    'service-provider-agreement': 'provider-terms.html', 'booking-cancellation-policy': 'provider-terms.html',
  };
  function docFor(id) { return LEGAL_DOC[id] || 'legal-hub.html'; }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Resolve a legalDispatch caller — prefers an injected one, else compat SDK. */
  function caller() {
    if (typeof firebase !== 'undefined' && firebase.functions) {
      var fns = firebase.functions();
      return function (op, data) {
        return fns.httpsCallable('legalDispatch', { timeout: 30000 })(
          Object.assign({ op: op }, data || {})
        ).then(function (r) { return r.data; });
      };
    }
    throw new Error('SokoniLegalGate: Firebase Functions SDK not found on page.');
  }

  /* Inject scoped styles once (neutral, token-aware — blends into any SOKONI page). */
  function injectCSS() {
    if (document.getElementById('slg-css')) return;
    var s = document.createElement('style');
    s.id = 'slg-css';
    s.textContent =
      '.slg{width:100%;text-align:left;font:inherit}' +
      '.slg-head{font-size:13px;font-weight:800;margin-bottom:2px;color:var(--sk-text,inherit)}' +
      '.slg-sub{font-size:12px;opacity:.7;margin-bottom:10px}' +
      '.slg-done{font-size:13px;font-weight:700;color:var(--sk-green,#71ff00);padding:10px 12px;border:1px solid rgba(113,255,0,.3);background:rgba(113,255,0,.06);border-radius:12px}' +
      '.slg-list{display:flex;flex-direction:column;gap:8px}' +
      '.slg-item{display:flex;align-items:flex-start;gap:10px;font-size:13px;line-height:1.4;cursor:pointer;padding:8px 10px;border:1px solid var(--sk-border,rgba(150,150,150,.25));border-radius:10px}' +
      '.slg-item input{width:18px;height:18px;margin-top:1px;flex-shrink:0;accent-color:var(--sk-green,#71ff00)}' +
      '.slg-item a{color:var(--sk-accent,#4c8dff);text-decoration:underline}' +
      '.slg-btn{margin-top:10px;width:100%;min-height:40px;font-size:13px;font-weight:700;border:none;border-radius:10px;cursor:pointer;background:var(--sk-green,#71ff00);color:#050505}' +
      '.slg-btn:disabled{opacity:.55;cursor:default}' +
      '.slg-row{display:flex;justify-content:space-between;gap:8px;font-size:12.5px;padding:7px 0;border-bottom:1px solid var(--sk-border,rgba(150,150,150,.15))}' +
      '.slg-badge{font-size:10px;font-weight:800;padding:2px 7px;border-radius:999px}' +
      '.slg-ok{background:rgba(113,255,0,.14);color:var(--sk-green,#71ff00)}' +
      '.slg-pending{background:rgba(255,149,0,.16);color:#ff9500}';
    document.head.appendChild(s);
  }

  /* ── check(role) — reusable compliance read (for gating actions) ── */
  function check(role) {
    return caller()('legalCheckCompliance', { role: role || '' });
  }

  /* ── mount(el, {role, onComplete}) — accept-to-continue gate ── */
  function mount(el, opts) {
    opts = opts || {};
    var role = opts.role || '';
    var done = typeof opts.onComplete === 'function' ? opts.onComplete : function () {};
    if (typeof el === 'string') el = document.getElementById(el) || document.querySelector(el);
    if (!el) return;
    injectCSS();
    el.classList.add('slg');
    var call = caller();

    call('legalCheckCompliance', { role: role }).then(function (comp) {
      if (comp && comp.compliant) {
        el.innerHTML = '<div class="slg-done">✓ Legal agreements accepted</div>';
        el.style.display = 'block'; done(true, comp); return;
      }
      /* Not compliant -> hand off to the guided Digital Agreement experience.
         A DELEGATION, not a rewrite: every existing caller of mount() keeps
         working, and if sokoni-legal-sign.js is absent we fall through to the
         original checkbox flow below. Same server contract either way. */
      if (window.SokoniLegalSign) {
        el.classList.remove('slg');
        window.SokoniLegalSign.mount(el, {
          role: role, businessId: opts.businessId || '',
          onComplete: function (res) { done(true, res); }
        });
        return;
      }
      return call('legalGetAgreements', { role: role }).then(function (ag) {
        var all = (ag.core || []).concat(ag.roleSpecific || []);
        if (!all.length) { done(true, { compliant: true }); return; }
        el.innerHTML =
          '<div class="slg-head">Review &amp; accept to continue</div>' +
          '<div class="slg-sub">Required before you continue. Tap a name to read it.</div>' +
          '<div class="slg-list">' + all.map(function (a) {
            return '<label class="slg-item"><input type="checkbox" class="slg-cb">' +
              '<span>I agree to the <a href="' + docFor(a.id) + '" target="_blank" rel="noopener">' +
              esc(a.name) + '</a></span></label>';
          }).join('') + '</div>' +
          '<button class="slg-btn" disabled>Accept &amp; Continue</button>';
        el.style.display = 'block';
        var cbs = [].slice.call(el.querySelectorAll('.slg-cb'));
        var btn = el.querySelector('.slg-btn');
        cbs.forEach(function (c) { c.addEventListener('change', function () {
          btn.disabled = !cbs.every(function (x) { return x.checked; });
        }); });
        btn.addEventListener('click', function () {
          btn.disabled = true; btn.textContent = 'Saving…';
          call('legalAccept', {
            role: role,
            acceptances: all.map(function (a) { return { agreementId: a.id, version: a.version }; }),
            meta: { device: navigator.userAgent, browser: navigator.userAgent,
                    language: navigator.language || '', country: '' }
          }).then(function () {
            el.innerHTML = '<div class="slg-done">✓ Legal agreements accepted</div>';
            done(true, { compliant: true, justAccepted: true });
          }).catch(function (e) {
            btn.disabled = false; btn.textContent = 'Accept & Continue';
            alert((e && e.message) || 'Could not save. Please try again.');
          });
        });
        done(false, comp);
      });
    }).catch(function () {
      /* Non-blocking: if the legal service is unavailable, do not trap the user. */
      done(true, { compliant: true, unavailable: true });
    });
  }

  /* ── settings(el, {role}) — Account → Legal & Agreements (accepted + pending) ── */
  function settings(el, opts) {
    opts = opts || {};
    if (typeof el === 'string') el = document.getElementById(el) || document.querySelector(el);
    if (!el) return;
    injectCSS();
    el.classList.add('slg');
    var call = caller();
    Promise.all([
      call('legalGetAgreements', { role: opts.role || '' }),
      call('legalGetMyAcceptances', {})
    ]).then(function (res) {
      var ag = res[0], acc = res[1];
      var required = (ag.core || []).concat(ag.roleSpecific || []);
      var accepted = {};
      (acc.acceptances || []).forEach(function (a) { if (a.accepted) accepted[a.agreementId] = a; });
      el.innerHTML = '<div class="slg-head">Legal &amp; Agreements</div>' +
        required.map(function (a) {
          var mine = accepted[a.id];
          var ok = mine && mine.version === a.version;
          var when = mine && mine.acceptedAt && mine.acceptedAt._seconds
            ? new Date(mine.acceptedAt._seconds * 1000).toLocaleDateString() : '';
          return '<div class="slg-row"><span><a href="' + docFor(a.id) + '" target="_blank" rel="noopener">' +
            esc(a.name) + '</a> <span style="opacity:.6">v' + esc(a.version) + '</span>' +
            (when ? ' <span style="opacity:.5">· ' + esc(when) + '</span>' : '') + '</span>' +
            '<span class="slg-badge ' + (ok ? 'slg-ok">Accepted' : 'slg-pending">' + (mine ? 'Update needed' : 'Pending')) +
            '</span></div>';
        }).join('');
    }).catch(function () { el.innerHTML = '<div class="slg-sub">Legal agreements unavailable right now.</div>'; });
  }

  window.SokoniLegalGate = { mount: mount, settings: settings, check: check, docFor: docFor, LEGAL_DOC: LEGAL_DOC };
})();
