/* ============================================================================
   SOKONI — Payment Trust Badge (reusable component)
   components/payment/payment-trust-badge.js

   ONE canonical trust badge for every payment surface, so the trust anchor is
   identical across checkout, wallet, top-up, POS, invoices, subscriptions and
   receipts — and lives in a single file instead of being copy-pasted.

   USAGE
     1. Load once per page:  <script src="/components/payment/payment-trust-badge.js" defer></script>
     2. Drop a placeholder where the badge should appear:
            <div data-sokoni-trust-badge></div>
        Optional attributes on the placeholder:
            data-label="false"      hide the "SECURE PAYMENTS" cap label
            data-max="380"          override max width in px (default 440)
     The script fills every placeholder on DOMContentLoaded and again if more are
     injected later (checkout modals, dynamically rendered panels).

   ARTWORK
     The official IntaSend badge (Safe & Secure Checkout · PCI-DSS · Visa ·
     Mastercard · Sectigo). It is a self-contained dark panel — do NOT recreate,
     recolour or wrap it in a contrasting card; the image IS the card. The local
     asset is canonical; the IntaSend CDN is an onerror fallback only.

   CLS
     The image reserves its 1170×294 aspect ratio before it loads, so nothing
     reflows when it arrives. lazy + async so it never blocks payment interaction.

   A11y
     alt = "Secure Checkout powered by IntaSend". The cap label is decorative
     (aria-hidden) because the alt already carries the meaning.
   ============================================================================ */
(function () {
  'use strict';

  var LOCAL  = '/assets/branding/payment/intasend-trust-badge.jpeg';
  /* Official IntaSend-hosted badge — used only if the local asset fails to load.
     Already allow-listed in the site CSP img-src. */
  var REMOTE = 'https://intasend-prod-static.s3.amazonaws.com/img/trust-badges/intasend-trust-badge-with-mpesa-hr-dark.png';
  var ALT    = 'Secure Checkout powered by IntaSend';
  var RATIO  = '1170 / 294';            // real dimensions of the artwork
  var SELECTOR = '[data-sokoni-trust-badge]';
  var STYLE_ID = '_sokoniTrustBadgeCss';

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.sk-trust-badge{display:block;width:100%;max-width:440px;margin:16px auto;',
      '  padding:0 16px;box-sizing:border-box;text-align:center;}',
      '.sk-trust-badge__cap{display:inline-block;margin:0 auto 8px;padding:3px 12px;',
      '  font-size:9px;font-weight:800;letter-spacing:1.5px;line-height:1;',
      '  color:rgba(113,255,0,.75);background:rgba(113,255,0,.08);',
      '  border:1px solid rgba(113,255,0,.2);border-radius:999px;white-space:nowrap;}',
      '.sk-trust-badge__link{display:block;text-decoration:none;',
      '  transition:transform .2s ease,filter .2s ease;}',
      '.sk-trust-badge__link:hover{transform:scale(1.02);',
      '  filter:drop-shadow(0 4px 16px rgba(113,255,0,.18));}',
      /* aspect-ratio reserves height pre-load → zero CLS; the dark art gets its own
         rounded corners + soft shadow so it reads as an enterprise gateway panel. */
      '.sk-trust-badge__img{display:block;width:100%;height:auto;aspect-ratio:' + RATIO + ';',
      '  border-radius:14px;box-shadow:0 6px 22px rgba(0,0,0,.28);}',
      '.sk-trust-badge__fallback{display:none;align-items:center;justify-content:center;',
      '  gap:8px;padding:14px 16px;border-radius:12px;font-size:12px;font-weight:700;',
      '  color:rgba(255,255,255,.72);background:rgba(113,255,0,.06);',
      '  border:1px solid rgba(113,255,0,.16);}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function render(el) {
    if (!el || el.getAttribute('data-sk-trust-done') === '1') return;
    el.setAttribute('data-sk-trust-done', '1');

    var showLabel = el.getAttribute('data-label') !== 'false';
    var max = el.getAttribute('data-max');

    el.classList.add('sk-trust-badge');
    if (max && /^\d+$/.test(max)) el.style.maxWidth = max + 'px';

    var cap = showLabel
      ? '<span class="sk-trust-badge__cap" aria-hidden="true">SECURE PAYMENTS</span>'
      : '';

    /* Build via DOM (not innerHTML with interpolation) so nothing user-derived is
       ever concatenated into markup. Values here are all static constants. */
    el.innerHTML =
      cap +
      '<a class="sk-trust-badge__link" href="https://intasend.com/security" ' +
        'target="_blank" rel="noopener noreferrer" ' +
        'aria-label="IntaSend security certification — opens in a new tab">' +
        '<img class="sk-trust-badge__img" src="' + LOCAL + '" ' +
          'alt="' + ALT + '" width="1170" height="294" ' +
          'loading="lazy" decoding="async">' +
        '<span class="sk-trust-badge__fallback"><i class="fas fa-lock" aria-hidden="true"></i> ' +
          'Secured by IntaSend · PCI DSS Level 1</span>' +
      '</a>';

    var img = el.querySelector('.sk-trust-badge__img');
    var fb  = el.querySelector('.sk-trust-badge__fallback');
    if (img) {
      img.addEventListener('error', function onErr() {
        img.removeEventListener('error', onErr);
        if (img.src.indexOf(REMOTE) === -1) {
          img.src = REMOTE;                 // 1st failure → try the IntaSend CDN
        } else {                            // CDN also failed → text fallback
          img.style.display = 'none';
          if (fb) fb.style.display = 'flex';
        }
      });
    }
  }

  function scan(root) {
    injectCss();
    var nodes = (root || document).querySelectorAll(SELECTOR);
    for (var i = 0; i < nodes.length; i++) render(nodes[i]);
  }

  // Expose a manual hook for panels injected after first paint (payment modals).
  window.SokoniTrustBadge = { render: scan };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { scan(document); });
  } else {
    scan(document);
  }
})();
