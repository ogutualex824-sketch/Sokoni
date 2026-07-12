/* ============================================================================
   SOKONI — Universal Footer Component
   sokoni-footer.js

   ONE footer for the entire platform. No page-specific implementations.

   Loaded by shared-header.js, so every page that has the SOKONI header gets
   the SOKONI footer — automatically, with no per-page markup.

   Design principles
   -----------------
   • Every element has a purpose. No decorative squares, no placeholder chips.
   • Icons are inline SVG (16px, 1.5px stroke, currentColor) — never emoji.
     Emoji render inconsistently across platforms and read as unprofessional
     next to legal and security links.
   • The brand is the standalone SOKONI icon + a TYPOGRAPHIC wordmark. No image
     wordmark, so it never blurs, never distorts, and costs no bytes.
   • Dark, muted, high-contrast-where-it-matters. WCAG AA on every text colour.
   • Zero layout shift: the footer is appended at the end of the document flow,
     so nothing above it ever moves.

   Accessibility
   -------------
   • <footer role="contentinfo"> landmark
   • Each column is a <nav> with its own aria-label
   • Icons are aria-hidden (the link text is the accessible name)
   • Visible :focus-visible ring for keyboard users
   • Status indicator carries a text label, not colour alone

   Link policy
   -----------
   Only pages verified to exist are linked. A footer full of 404s is worse than
   a short footer. Admin surfaces (security-center) are deliberately NOT linked.
============================================================================ */
(function () {
  'use strict';

  if (window.__SOKONI_FOOTER__) return;          // idempotent — never double-mount
  window.__SOKONI_FOOTER__ = true;

  var VERSION = '1.0.0';

  /* ── Where the footer does NOT belong ───────────────────────────────────────
     shared-header.js is on 302 pages, including POS terminals, kitchen display
     screens and customer-facing kiosks. Those are operational app shells, not
     marketing surfaces: a cashier mid-sale has no use for "Careers" or "Flash
     Sales", and a customer-facing display must show the basket and nothing else.
     Injecting there would be a regression, so they opt out.

     Any page can also opt out explicitly with <body data-no-footer>.          */
  var EXCLUDE = /^(pos-|customer-display|kiosk)/;

  function excluded() {
    var page = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    if (EXCLUDE.test(page)) return true;
    return !!(document.body && document.body.hasAttribute('data-no-footer'));
  }

  /* ── Icons: 16px line icons, inherit colour, purely decorative ──────────── */
  var I = {
    shield:   '<path d="M8 1.5 2.5 4v4c0 3.2 2.3 5.6 5.5 6.5 3.2-.9 5.5-3.3 5.5-6.5V4L8 1.5Z"/>',
    lock:     '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>',
    doc:      '<path d="M4 1.5h5l3 3v10H4v-13Z"/><path d="M9 1.5v3h3"/>',
    cookie:   '<circle cx="8" cy="8" r="6.5"/><circle cx="6" cy="6.5" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="9.5" r=".9" fill="currentColor" stroke="none"/><circle cx="6.5" cy="10.5" r=".7" fill="currentColor" stroke="none"/>',
    help:     '<circle cx="8" cy="8" r="6.5"/><path d="M6.2 6.2a1.9 1.9 0 1 1 2.4 2.2c-.4.2-.6.5-.6.9v.3"/><circle cx="8" cy="11.9" r=".7" fill="currentColor" stroke="none"/>',
    box:      '<path d="M8 1.8 2.5 4.6v6.8L8 14.2l5.5-2.8V4.6L8 1.8Z"/><path d="M2.5 4.6 8 7.4l5.5-2.8M8 7.4v6.8"/>',
    scale:    '<path d="M8 2v12M4 5.5h8M5.5 5.5 3.5 10h4l-2-4.5ZM10.5 5.5 8.5 10h4l-2-4.5Z"/>',
    users:    '<circle cx="6" cy="6" r="2.3"/><path d="M2.5 13.2a3.7 3.7 0 0 1 7 0"/><path d="M10.6 4.1a2.3 2.3 0 0 1 0 4.4M11.3 13.2a3.7 3.7 0 0 0-1.1-2.7"/>',
    store:    '<path d="M2.5 6.2 3.6 3h8.8l1.1 3.2"/><path d="M3 6.2v7.3h10V6.2"/><path d="M2.5 6.2a1.8 1.8 0 0 0 3.7 0 1.8 1.8 0 0 0 3.6 0 1.8 1.8 0 0 0 3.7 0"/>',
    bag:      '<path d="M3.5 5.5h9l.8 8h-10.6l.8-8Z"/><path d="M6 5.5V4a2 2 0 0 1 4 0v1.5"/>',
    code:     '<path d="M5.5 5 2.5 8l3 3M10.5 5l3 3-3 3M9.2 3.4 6.8 12.6"/>',
    building: '<path d="M3.5 14V3.2L9 1.8V14"/><path d="M9 5.6h3.5V14"/><path d="M5.5 5h1.5M5.5 7.6h1.5M5.5 10.2h1.5M10.7 8h.6M10.7 10.6h.6"/>',
    pin:      '<path d="M8 14.5s5-4.1 5-7.6a5 5 0 0 0-10 0c0 3.5 5 7.6 5 7.6Z"/><circle cx="8" cy="6.9" r="1.8"/>',
    phone:    '<path d="M5.4 2.5 3 3.4c-.6.2-.9.9-.7 1.5A11.3 11.3 0 0 0 11.1 13.7c.6.2 1.3-.1 1.5-.7l.9-2.4-3-1.4-1.2 1.4A8.6 8.6 0 0 1 6.8 6.7l1.4-1.2-1.4-3Z"/>',
    mail:     '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.4 4.6 5.6 4 5.6-4"/>',
    sparkle:  '<path d="M8 1.8 9.4 5.9 13.5 7.3 9.4 8.7 8 12.8 6.6 8.7 2.5 7.3 6.6 5.9 8 1.8Z"/>',
    activity: '<path d="M1.8 8h3l2-5 3 10 2-5h2.4"/>',
  };

  function icon(name) {
    return '<svg class="skf-i" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
           'stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ' +
           'aria-hidden="true" focusable="false">' + (I[name] || '') + '</svg>';
  }

  /* ── Social: brand marks, 18px, no emoji ────────────────────────────────── */
  var SOCIALS = [
    ['Facebook',  'https://facebook.com/SokoniKe',      '<path d="M12.5 2H10a3.5 3.5 0 0 0-3.5 3.5V8H4.5v2.5h2V18h2.5v-7.5h2.2l.4-2.5H9V5.6c0-.6.4-1.1 1-1.1h2V2Z"/>'],
    ['X',         'https://twitter.com/SokoniKe',       '<path d="M3 3h3.3l3.6 5 4-5H16l-5.4 6.6L16.4 17H13l-3.8-5.3L4.7 17H3l5.7-7L3 3Z"/>'],
    ['Instagram', 'https://instagram.com/sokoni.ke',    '<rect x="3" y="3" width="14" height="14" rx="4.2"/><circle cx="10" cy="10" r="3.4"/><circle cx="14.1" cy="5.9" r=".9" fill="currentColor" stroke="none"/>'],
    ['TikTok',    'https://tiktok.com/@sokoni.ke',      '<path d="M12.4 2.5c.3 1.7 1.4 2.9 3.1 3.1v2.5a5.6 5.6 0 0 1-3.1-1v4.8a4.7 4.7 0 1 1-4.7-4.7c.3 0 .5 0 .8.1v2.6a2.2 2.2 0 1 0 1.5 2.1V2.5h2.4Z"/>'],
    ['YouTube',   'https://youtube.com/@SokoniKenya',   '<rect x="2.2" y="4.8" width="15.6" height="10.4" rx="3"/><path d="M8.4 7.9v4.2l3.6-2.1-3.6-2.1Z" fill="currentColor" stroke="none"/>'],
    ['WhatsApp',  'https://wa.me/254705726803',         '<path d="M3 17l1-3.5A6.9 6.9 0 1 1 6.6 16L3 17Z"/><path d="M7.4 7.1c.2-.4.4-.4.6-.4h.5c.2 0 .4 0 .6.5l.6 1.4c.1.2 0 .4-.1.5l-.4.5c-.1.1-.2.3-.1.5a5 5 0 0 0 2.3 2.2c.2.1.4 0 .5-.1l.5-.5c.2-.2.3-.2.5-.1l1.3.7c.2.1.3.3.2.5a1.7 1.7 0 0 1-1.6 1.2 6.4 6.4 0 0 1-5.5-5.5 2 2 0 0 1 .1-1.4Z" stroke="none" fill="currentColor"/>'],
  ];

  /* ── Link model. Only verified-existing pages. ──────────────────────────── */
  var COLUMNS = [
    { title: 'Company', links: [
      ['About SOKONI',   'about.html',      'building'],
      ['Careers',        'careers.html',    'users'],
      ['Community',      'community.html',  'users'],
      ['Foundation',     'foundation.html', 'sparkle'],
      ['Contact',        'contact.html',    'mail'],
    ]},
    { title: 'Marketplace', links: [
      ['Shop All',       'category.html?cat=all', 'store'],
      ['Flash Sales',    'flashsale.html',        'sparkle'],
      ['Properties',     'property-hub.html',     'building'],
      ['Vehicles',       'car-hub.html',          'box'],
      ['Stays & BnB',    'bnb-hub.html',          'building'],
      ['Digital Esoko',  'digital-esoko.html',    'bag'],
      ['Services',       'services.html',         'store'],
    ]},
    { title: 'Sell', links: [
      ['Start Selling',  'sell.html',          'store'],
      ['Seller Hub',     'seller.html',        'bag'],
      ['Subscriptions',  'subscriptions.html', 'sparkle'],
      ['Delivery',       'delivery.html',      'box'],
    ]},
    { title: 'Support', links: [
      ['Help Center',    'help.html',    'help'],
      ['Track Order',    'track.html',   'box'],
      ['Returns',        'returns.html', 'box'],
      ['File a Dispute', 'dispute.html', 'scale'],
      ['Contact Support','contact.html', 'mail'],
    ]},
    { title: 'Legal', links: [
      ['Terms of Service', 'legal.html#terms',   'doc'],
      ['Privacy Policy',   'legal.html#privacy', 'lock'],
      ['Cookie Policy',    'legal.html#cookies', 'cookie'],
      ['Data Protection',  'legal.html#data',    'shield'],
      ['Seller Agreement', 'legal.html#sellers', 'doc'],
    ]},
    { title: 'Trust & Developers', links: [
      ['Trust Center',     'trust-and-safety.html', 'shield'],
      ['Platform Status',  'status.html',           'activity'],
      ['Report Abuse',     'dispute.html',          'scale'],
      ['Developer Portal', 'developer-portal.html', 'code'],
    ]},
  ];

  /* ── CSS ────────────────────────────────────────────────────────────────── */
  var CSS = `
.sk-footer{
  --skf-bg:#050505; --skf-line:rgba(255,255,255,.07);
  --skf-txt:rgba(255,255,255,.62);      /* AA on #050505 */
  --skf-hd:rgba(255,255,255,.95);
  --skf-mut:rgba(255,255,255,.42);
  --skf-acc:#71ff00;
  background:var(--skf-bg); color:var(--skf-txt);
  border-top:1px solid var(--skf-line);
  padding:64px 24px 0;
  font:400 14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,sans-serif;
  -webkit-font-smoothing:antialiased;
}
.sk-footer *{box-sizing:border-box}
.skf-wrap{max-width:1240px;margin:0 auto}

/* Brand + columns */
.skf-top{
  display:grid;
  grid-template-columns:minmax(240px,1.4fr) repeat(3,minmax(140px,1fr));
  gap:40px 32px;
}
@media(min-width:1080px){ .skf-top{grid-template-columns:minmax(260px,1.5fr) repeat(6,minmax(120px,1fr))} }

/* Brand — standalone icon, TYPOGRAPHIC wordmark. No card, no shadow, no image. */
.skf-brand{max-width:340px}
.skf-mark{display:flex;align-items:center;gap:10px;margin:0 0 14px;text-decoration:none}
.skf-mark svg{width:32px;height:32px;display:block;flex:0 0 32px}
.skf-word{
  font-size:19px;font-weight:700;letter-spacing:.14em;
  color:var(--skf-hd);text-transform:uppercase;line-height:1;
}
.skf-tag{margin:0 0 18px;font-size:13.5px;line-height:1.65;color:var(--skf-txt)}
.skf-by{margin:0 0 22px;font-size:11.5px;letter-spacing:.02em;color:var(--skf-mut)}
.skf-by strong{color:rgba(255,255,255,.6);font-weight:600}

/* Social */
.skf-social{display:flex;gap:8px;flex-wrap:wrap}
.skf-social a{
  width:38px;height:38px;border-radius:10px;
  display:inline-flex;align-items:center;justify-content:center;
  border:1px solid var(--skf-line);color:var(--skf-mut);
  background:rgba(255,255,255,.02);
  transition:color .2s ease,border-color .2s ease,transform .2s ease,background .2s ease;
}
.skf-social a svg{width:18px;height:18px}
.skf-social a:hover{
  color:var(--skf-acc);border-color:rgba(113,255,0,.4);
  background:rgba(113,255,0,.06);transform:translateY(-2px);
}

/* Columns */
.skf-col h3{
  margin:0 0 14px;font-size:11px;font-weight:700;
  letter-spacing:.13em;text-transform:uppercase;color:var(--skf-hd);
}
.skf-col nav{display:flex;flex-direction:column;gap:2px}
.skf-col a{
  display:flex;align-items:center;gap:8px;
  padding:5px 0;color:var(--skf-txt);text-decoration:none;font-size:13.5px;
  transition:color .18s ease,transform .18s ease;
}
.skf-col a:hover{color:var(--skf-hd);transform:translateX(2px)}
.skf-i{width:15px;height:15px;flex:0 0 15px;opacity:.5;transition:opacity .18s ease,color .18s ease}
.skf-col a:hover .skf-i{opacity:1;color:var(--skf-acc)}

/* Contact */
.skf-contact{margin-top:44px;padding-top:28px;border-top:1px solid var(--skf-line);
  display:flex;flex-wrap:wrap;gap:12px 32px}
.skf-contact a,.skf-contact span{
  display:inline-flex;align-items:center;gap:8px;
  color:var(--skf-txt);text-decoration:none;font-size:13.5px;
  transition:color .18s ease;
}
.skf-contact a:hover{color:var(--skf-acc)}
.skf-contact .skf-i{opacity:.55}

/* Bottom bar */
.skf-bot{
  margin-top:32px;padding:22px 0 28px;border-top:1px solid var(--skf-line);
  display:flex;align-items:center;justify-content:space-between;gap:16px;flex-wrap:wrap;
}
.skf-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
.skf-status{
  display:inline-flex;align-items:center;gap:7px;
  font-size:12px;color:var(--skf-txt);text-decoration:none;
  padding:5px 10px;border:1px solid var(--skf-line);border-radius:999px;
  background:rgba(255,255,255,.02);transition:border-color .2s ease,color .2s ease;
}
.skf-status:hover{color:var(--skf-hd);border-color:rgba(255,255,255,.18)}
.skf-dot{
  width:6px;height:6px;border-radius:50%;background:var(--skf-acc);flex:0 0 6px;
  box-shadow:0 0 0 3px rgba(113,255,0,.14);
}
.skf-ver{font-size:11.5px;color:var(--skf-mut);font-variant-numeric:tabular-nums}
.skf-copy{margin:0;font-size:12px;color:var(--skf-mut);line-height:1.6}
.skf-copy .skf-sep{margin:0 7px;opacity:.4}

/* KASS — typographic, subtle AI mark, no emoji */
.skf-kass{
  display:inline-flex;align-items:center;gap:7px;
  font-size:11.5px;letter-spacing:.04em;color:var(--skf-mut);
  text-decoration:none;transition:color .22s ease;
}
.skf-kass svg{width:13px;height:13px;opacity:.6;transition:opacity .22s ease,color .22s ease}
.skf-kass b{font-weight:600;letter-spacing:.1em;color:rgba(255,255,255,.62);transition:color .22s ease}
.skf-kass:hover{color:rgba(255,255,255,.75)}
.skf-kass:hover b{color:var(--skf-acc)}
.skf-kass:hover svg{opacity:1;color:var(--skf-acc)}

/* Payments */
.skf-pay{display:flex;align-items:center;gap:10px}
.skf-pay img{height:22px;width:auto;opacity:.55;transition:opacity .2s ease}
.skf-pay:hover img{opacity:.85}

/* Keyboard focus — visible, never removed */
.sk-footer a:focus-visible{
  outline:2px solid var(--skf-acc);outline-offset:3px;border-radius:4px;
}

/* Clear the fixed bottom-nav on mobile so nothing is clipped */
@media(max-width:768px){
  .sk-footer{padding:48px 18px 0}
  .skf-top{grid-template-columns:repeat(2,minmax(0,1fr));gap:32px 20px}
  .skf-brand{grid-column:1/-1;max-width:none}
  .skf-contact{gap:10px 20px;margin-top:34px}
  .skf-bot{flex-direction:column;align-items:flex-start;gap:14px}
  .sk-footer{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px))}
}
@media(max-width:380px){
  .skf-top{grid-template-columns:1fr}
}
@media(prefers-reduced-motion:reduce){
  .sk-footer *{transition:none!important}
}
`;

  /* ── Build ──────────────────────────────────────────────────────────────── */
  function cols() {
    return COLUMNS.map(function (c) {
      return '<div class="skf-col"><h3>' + c.title + '</h3>' +
        '<nav aria-label="' + c.title + '">' +
        c.links.map(function (l) {
          return '<a href="' + l[1] + '">' + icon(l[2]) + '<span>' + l[0] + '</span></a>';
        }).join('') +
        '</nav></div>';
    }).join('');
  }

  function social() {
    return SOCIALS.map(function (s) {
      /* rel=noopener noreferrer — without it, target=_blank lets the opened page
         reach back via window.opener (reverse tabnabbing). */
      return '<a href="' + s[1] + '" target="_blank" rel="noopener noreferrer me" ' +
             'aria-label="SOKONI on ' + s[0] + '">' +
             '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" ' +
             'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' +
             s[2] + '</svg></a>';
    }).join('');
  }

  function html() {
    var year = new Date().getFullYear();
    return '' +
    '<div class="skf-wrap">' +
      '<div class="skf-top">' +
        '<div class="skf-brand">' +
          '<a class="skf-mark" href="index.html" aria-label="SOKONI home">' +
            /* Standalone icon — no card, no drop-shadow, no bounding box. */
            '<svg viewBox="0 0 80 80" fill="none" aria-hidden="true" focusable="false">' +
              '<defs><linearGradient id="skf-g" x1="0" y1="0" x2="0" y2="1">' +
                '<stop offset="0%" stop-color="#71ff00"/><stop offset="100%" stop-color="#237000"/>' +
              '</linearGradient></defs>' +
              '<rect x="10" y="29" width="60" height="43" rx="9" fill="url(#skf-g)"/>' +
              '<path d="M28 33V24a12 12 0 0 1 24 0v9" stroke="#71ff00" stroke-width="6" ' +
                'stroke-linecap="round" fill="none"/>' +
            '</svg>' +
            /* Literal SOKONI — not lowercase relying on text-transform. If the CSS
               ever fails to load, the brand must still read SOKONI. */
            '<span class="skf-word">SOKONI</span>' +
          '</a>' +
          '<p class="skf-tag">Kenya’s marketplace for everything — shop, sell, book and ' +
            'get paid. Built for buyers, sellers, service providers and riders nationwide.</p>' +
          '<p class="skf-by">Powered by <strong>Bravilex International Company Limited</strong></p>' +
          '<div class="skf-social">' + social() + '</div>' +
        '</div>' +
        cols() +
      '</div>' +

      '<div class="skf-contact">' +
        '<a href="https://maps.google.com/?q=Nairobi,Kenya" target="_blank" rel="noopener noreferrer">' +
          icon('pin') + '<span>Nairobi, Kenya</span></a>' +
        '<a href="tel:+254705726803">' + icon('phone') + '<span>+254 705 726 803</span></a>' +
        /* mailto — an email address must open an email client, not WhatsApp. */
        '<a href="mailto:info@mysokoni.co.ke">' + icon('mail') + '<span>info@mysokoni.co.ke</span></a>' +
      '</div>' +

      '<div class="skf-bot">' +
        '<div class="skf-meta">' +
          '<a class="skf-status" href="status.html">' +
            '<span class="skf-dot" aria-hidden="true"></span>' +
            '<span>All systems operational</span></a>' +
          '<span class="skf-ver">v' + VERSION + '</span>' +
          '<div class="skf-pay" aria-label="Accepted payment methods">' +
            '<img src="assets/mpesa.PNG" alt="M-Pesa" width="48" height="22" loading="lazy" decoding="async">' +
            '<img src="assets/visa.PNG" alt="Visa" width="48" height="22" loading="lazy" decoding="async">' +
            '<img src="assets/mastercard.PNG" alt="Mastercard" width="48" height="22" loading="lazy" decoding="async">' +
            '<img src="assets/paypal.PNG" alt="PayPal" width="48" height="22" loading="lazy" decoding="async">' +
          '</div>' +
        '</div>' +
        '<p class="skf-copy">' +
          '© ' + year + ' SOKONI' +
          '<span class="skf-sep">·</span>All rights reserved.' +
        '</p>' +
        /* A credit, not navigation. There is no public KASS landing page — KASS is
           an embedded concierge — so this must not be a link. A dead link in the
           footer is exactly the defect class we removed in C3. */
        '<span class="skf-kass">' +
          icon('sparkle') + '<span>Intelligence powered by <b>KASS AI</b></span>' +
        '</span>' +
      '</div>' +
    '</div>';
  }

  function mount() {
    if (excluded()) return;

    /* Retire any legacy page-specific footer. One component, platform-wide.
       :not(.sk-footer) ensures we never remove the global footer itself on
       a second mount() call. Excluded pages (POS/kiosk) already returned above
       so we will never accidentally strip an operational screen's own footer. */
    var legacy = document.querySelectorAll('footer:not(.sk-footer)');
    for (var i = 0; i < legacy.length; i++) legacy[i].remove();

    if (document.querySelector('footer.sk-footer')) return;

    var style = document.createElement('style');
    style.id = 'sk-footer-css';
    style.textContent = CSS;
    (document.head || document.documentElement).appendChild(style);

    var f = document.createElement('footer');
    f.className = 'sk-footer';
    f.setAttribute('role', 'contentinfo');
    f.innerHTML = html();

    /* Insert before the fixed bottom-nav if present, else at end of body. */
    var nav = document.querySelector('.bottom-nav');
    if (nav && nav.parentNode === document.body) document.body.insertBefore(f, nav);
    else document.body.appendChild(f);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount, { once: true });
  } else {
    mount();
  }
})();
