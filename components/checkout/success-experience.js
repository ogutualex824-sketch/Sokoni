/* ============================================================================
   SOKONI — Success Experience (Checkout 2.0, Phase 3)
   components/checkout/success-experience.js

   The premium finish to a successful order. Renders a milestone-aware celebration
   (via SokoniCelebration), the order summary, loyalty earned, donation impact, an
   order-tracking QR, and a continue-shopping action — into any container.

   Reusable and data-driven, like the trust badge. It reads nothing from the DOM
   or storage itself; the caller assembles the data and passes it in. That keeps
   it testable and lets success.html, a post-checkout modal, or a future
   Checkout 2.0 page all share one renderer.

   USAGE
     <script src="/components/checkout/celebration-engine.js" defer></script>
     <script src="/components/checkout/success-experience.js" defer></script>
     ...
     SokoniSuccess.render(document.getElementById('slot'), {
       customerName: 'Alex',
       orderId:   'SK-2026-019384',
       orderCount: 10,               // lifetime successful orders (drives the celebration)
       dateISO:   '2026-12-25',
       birthdayMMDD: '07-23',        // optional
       total:     2350, currency: 'KES',
       points:    180, tier: 'Gold',
       donation:  { amount: 50, cause: 'Education Fund' },   // optional
       trackUrl:  'https://mysokoni.co.ke/track/SK-2026-019384',
       continueUrl: '/'
     });

   QR — the tracking QR is drawn by the IntaSend-independent QR image service
   already used for receipts (api.qrserver.com). It needs that host in the site
   CSP img-src; added on this feature branch. If the image fails, the deep link is
   always shown as tappable text beneath it, so tracking is never gated on the QR.
   ============================================================================ */
(function (root) {
  'use strict';

  var STYLE_ID = '_sokoniSuccessCss';
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n, cur) {
    var v = Number(n) || 0;
    return (cur || 'KES') + ' ' + v.toLocaleString('en-KE');
  };

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.sk-succ{max-width:440px;margin:0 auto;padding:8px 16px 28px;box-sizing:border-box;',
      '  text-align:center;color:#fff;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;}',
      '.sk-succ__emoji{font-size:60px;line-height:1;margin:8px 0 6px;',
      '  animation:sk-pop .5s cubic-bezier(.2,1.3,.5,1) both;}',
      '@keyframes sk-pop{0%{transform:scale(.4);opacity:0}100%{transform:scale(1);opacity:1}}',
      '.sk-succ__tier{display:inline-block;font-size:10px;font-weight:800;letter-spacing:1.4px;',
      '  text-transform:uppercase;padding:3px 12px;border-radius:999px;margin-bottom:10px;}',
      '.sk-succ__h{font-size:24px;font-weight:900;letter-spacing:-.02em;margin:0 0 6px;}',
      '.sk-succ__sub{font-size:14px;line-height:1.5;color:rgba(255,255,255,.6);margin:0 auto 18px;max-width:340px;}',
      '.sk-succ__card{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);',
      '  border-radius:16px;padding:16px;margin:12px 0;text-align:left;}',
      '.sk-succ__row{display:flex;justify-content:space-between;align-items:center;gap:12px;',
      '  padding:6px 0;font-size:14px;}',
      '.sk-succ__row+.sk-succ__row{border-top:1px solid rgba(255,255,255,.05);}',
      '.sk-succ__k{color:rgba(255,255,255,.5);}',
      '.sk-succ__v{font-weight:800;text-align:right;}',
      '.sk-succ__reward{margin:12px 0;padding:12px 14px;border-radius:14px;font-weight:800;font-size:14px;',
      '  background:rgba(255,193,7,.09);border:1px solid rgba(255,193,7,.28);color:#ffd54a;}',
      '.sk-succ__pts{display:flex;align-items:center;justify-content:center;gap:8px;margin:4px 0 2px;',
      '  font-size:15px;font-weight:900;}',
      '.sk-succ__pts b{font-size:20px;}',
      '.sk-succ__impact{background:rgba(113,255,0,.05);border:1px solid rgba(113,255,0,.16);}',
      '.sk-succ__qr{margin:16px auto 6px;width:168px;height:168px;border-radius:14px;overflow:hidden;',
      '  background:#fff;display:flex;align-items:center;justify-content:center;}',
      '.sk-succ__qr img{width:100%;height:100%;display:block;}',
      '.sk-succ__qrcap{font-size:12px;color:rgba(255,255,255,.45);margin-bottom:2px;}',
      '.sk-succ__link{font-size:12px;color:#71ff00;word-break:break-all;text-decoration:none;font-weight:700;}',
      '.sk-succ__btns{margin-top:18px;display:flex;flex-direction:column;gap:10px;}',
      '.sk-succ__btn{display:block;padding:14px 16px;border-radius:12px;font-weight:800;font-size:15px;',
      '  text-decoration:none;text-align:center;box-sizing:border-box;}',
      '.sk-succ__btn--primary{background:#71ff00;color:#04210a;}',
      '.sk-succ__btn--ghost{background:rgba(255,255,255,.05);color:#fff;border:1px solid rgba(255,255,255,.12);}',
      '.sk-succ__foot{margin-top:20px;font-size:12px;line-height:1.6;color:rgba(255,255,255,.4);}',
      '.sk-succ__foot b{color:rgba(255,255,255,.7);}'
    ].join('');
    (document.head || document.documentElement).appendChild(s);
  }

  function render(container, data) {
    if (!container) return null;
    injectCss();
    data = data || {};

    var CE = root.SokoniCelebration;
    var cel = CE ? CE.pick({
      orderCount: data.orderCount, dateISO: data.dateISO,
      birthdayMMDD: data.birthdayMMDD, orderId: data.orderId
    }) : { emoji: '🎉', headline: 'Order Confirmed', subline: 'Thank you for shopping with SOKONI.',
           accent: '#71ff00', tier: null, reward: null, confetti: false };

    var name = data.customerName ? (', ' + esc(data.customerName)) : '';
    var parts = [];

    parts.push('<div class="sk-succ__emoji">' + esc(cel.emoji) + '</div>');
    if (cel.tier) {
      parts.push('<span class="sk-succ__tier" style="color:' + esc(cel.accent) +
        ';background:' + esc(cel.accent) + '1f;border:1px solid ' + esc(cel.accent) + '55;">' +
        esc(cel.tier) + '</span>');
    }
    parts.push('<h1 class="sk-succ__h">' + esc(cel.headline) + '</h1>');
    parts.push('<p class="sk-succ__sub">Thank you' + name + '. ' + esc(cel.subline) + '</p>');

    if (cel.reward) {
      parts.push('<div class="sk-succ__reward">🎁 ' + esc(cel.reward.label) +
        (cel.reward.detail ? ' <span style="font-weight:600;opacity:.85">— ' + esc(cel.reward.detail) + '</span>' : '') +
        '</div>');
    }

    /* Order summary */
    var rows = '';
    if (data.orderId) rows += row('Order', esc(data.orderId));
    rows += row('Status', '<span style="color:#71ff00">✓ Confirmed</span>');
    if (data.total != null) rows += row('Total paid', money(data.total, data.currency));
    parts.push('<div class="sk-succ__card">' + rows + '</div>');

    /* Loyalty */
    if (data.points != null && Number(data.points) > 0) {
      parts.push('<div class="sk-succ__card"><div class="sk-succ__pts">' +
        '<span>⭐</span><b style="color:#71ff00">+' + (Number(data.points) || 0) + '</b>' +
        '<span>loyalty points' + (data.tier ? ' · ' + esc(data.tier) + ' member' : '') + '</span></div></div>');
    }

    /* Donation impact */
    if (data.donation && Number(data.donation.amount) > 0) {
      parts.push('<div class="sk-succ__card sk-succ__impact">' +
        '<div class="sk-succ__row"><span class="sk-succ__k">🌍 Your impact</span>' +
        '<span class="sk-succ__v">' + money(data.donation.amount, data.currency) + '</span></div>' +
        (data.donation.cause ? '<div class="sk-succ__row"><span class="sk-succ__k">Supporting</span>' +
          '<span class="sk-succ__v" style="color:#71ff00">' + esc(data.donation.cause) + '</span></div>' : '') +
        '</div>');
    }

    /* Tracking QR — deep link is always shown as text so tracking never depends on it. */
    if (data.trackUrl) {
      var qr = 'https://api.qrserver.com/v1/create-qr-code/?size=320x320&margin=8&data=' +
        encodeURIComponent(data.trackUrl);
      parts.push(
        '<div class="sk-succ__qrcap">Scan to track your order</div>' +
        '<div class="sk-succ__qr"><img alt="QR code linking to your order tracking page" ' +
          'src="' + esc(qr) + '" width="168" height="168" loading="lazy" decoding="async" ' +
          'onerror="this.parentNode.style.display=\'none\'"></div>' +
        '<a class="sk-succ__link" href="' + esc(data.trackUrl) + '">' + esc(data.trackUrl) + '</a>');
    }

    /* Actions */
    parts.push('<div class="sk-succ__btns">' +
      (data.trackUrl ? '<a class="sk-succ__btn sk-succ__btn--primary" href="' + esc(data.trackUrl) + '">📦 Track my order</a>' : '') +
      '<a class="sk-succ__btn sk-succ__btn--ghost" href="' + esc(data.continueUrl || '/') + '">Continue shopping</a>' +
      '</div>');

    /* Brand close — ties the order back to purpose. */
    parts.push('<div class="sk-succ__foot"><b>Thank you for choosing SOKONI.</b><br>' +
      'Every order strengthens local businesses, empowers delivery partners, and helps build ' +
      "Kenya's digital commerce. 🇰🇪</div>");

    container.className = (container.className ? container.className + ' ' : '') + 'sk-succ';
    container.innerHTML = parts.join('');
    return cel;

    function row(k, v) {
      return '<div class="sk-succ__row"><span class="sk-succ__k">' + k +
        '</span><span class="sk-succ__v">' + v + '</span></div>';
    }
  }

  root.SokoniSuccess = { render: render };

})(typeof window !== 'undefined' ? window : this);
