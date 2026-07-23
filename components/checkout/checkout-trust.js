/* ============================================================================
   SOKONI — Checkout Trust Elements (Premium Checkout, Phase 1)
   components/checkout/checkout-trust.js

   Two small, reusable, ADDITIVE trust elements for the checkout flow. Neither
   touches payment logic or layout structure — drop a placeholder, load the
   script once, and it fills in.

     <div data-sokoni-why></div>              "Why shop with SOKONI?" value panel
     <div data-sokoni-pay-reassurance></div>   pre-button reassurance strip

   Both are pure presentation (static content, self-contained CSS, injected once).
   Premium-dark to match the platform; the reassurance strip is meant to sit
   directly above the primary pay button (section 5 — Commitment) and the value
   panel near the foot of checkout, reinforcing the offer at the decision moment.
   ============================================================================ */
(function (root) {
  'use strict';

  var STYLE_ID = '_sokoniCheckoutTrustCss';

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      /* Why-SOKONI value panel */
      '.sk-why{max-width:520px;margin:18px auto;padding:16px;box-sizing:border-box;',
      '  background:rgba(255,255,255,.02);border:1px solid rgba(255,255,255,.07);border-radius:16px;}',
      '.sk-why__h{font-size:12px;font-weight:800;letter-spacing:.4px;color:rgba(255,255,255,.75);',
      '  text-align:center;margin:0 0 12px;}',
      '.sk-why__grid{display:grid;grid-template-columns:1fr 1fr;gap:10px 14px;}',
      '.sk-why__item{display:flex;align-items:flex-start;gap:8px;font-size:12px;line-height:1.35;',
      '  color:rgba(255,255,255,.62);}',
      '.sk-why__ic{font-size:15px;flex:none;line-height:1.2;}',
      '.sk-why__item b{color:rgba(255,255,255,.85);font-weight:700;display:block;font-size:12px;}',
      /* Pre-button reassurance strip */
      '.sk-reassure{max-width:520px;margin:12px auto;padding:12px 14px;box-sizing:border-box;',
      '  background:rgba(113,255,0,.05);border:1px solid rgba(113,255,0,.16);border-radius:12px;',
      '  display:flex;align-items:center;gap:10px;text-align:left;}',
      '.sk-reassure__lock{font-size:20px;flex:none;}',
      '.sk-reassure__main{font-size:12px;font-weight:800;color:#71ff00;line-height:1.3;}',
      '.sk-reassure__sub{font-size:11px;color:rgba(255,255,255,.5);line-height:1.4;margin-top:2px;}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  var WHY_ITEMS = [
    ['🛡', 'Buyer Protection', 'Covered on every order'],
    ['🚚', 'Live Order Tracking', 'Follow it to your door'],
    ['💬', 'Dedicated Support', 'Real help, fast'],
    ['🔄', 'Easy Returns', 'Where applicable'],
    ['🇰🇪', 'Local Businesses', 'Your order supports Kenya']
  ];

  function renderWhy(el) {
    if (!el || el.getAttribute('data-sk-done') === '1') return;
    el.setAttribute('data-sk-done', '1');
    el.className = (el.className ? el.className + ' ' : '') + 'sk-why';
    var items = WHY_ITEMS.map(function (it) {
      return '<div class="sk-why__item"><span class="sk-why__ic" aria-hidden="true">' + it[0] +
        '</span><span><b>' + it[1] + '</b>' + it[2] + '</span></div>';
    }).join('');
    el.innerHTML = '<div class="sk-why__h">Why shop with SOKONI?</div>' +
      '<div class="sk-why__grid">' + items + '</div>';
  }

  function renderReassure(el) {
    if (!el || el.getAttribute('data-sk-done') === '1') return;
    el.setAttribute('data-sk-done', '1');
    el.className = (el.className ? el.className + ' ' : '') + 'sk-reassure';
    el.innerHTML =
      '<span class="sk-reassure__lock" aria-hidden="true">🔒</span>' +
      '<span><span class="sk-reassure__main">Securely processed by IntaSend</span>' +
      '<span class="sk-reassure__sub">Your payment is encrypted · Covered by Buyer Protection</span></span>';
  }

  function scan(rootEl) {
    injectCss();
    var r = rootEl || document;
    var a = r.querySelectorAll('[data-sokoni-why]');
    for (var i = 0; i < a.length; i++) renderWhy(a[i]);
    var b = r.querySelectorAll('[data-sokoni-pay-reassurance]');
    for (var j = 0; j < b.length; j++) renderReassure(b[j]);
  }

  root.SokoniCheckoutTrust = { render: scan };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(document); });
  } else {
    scan(document);
  }
})(typeof window !== 'undefined' ? window : this);
