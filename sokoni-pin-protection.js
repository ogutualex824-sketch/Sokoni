/* ═══════════════════════════════════════════════════════════════════════════════════════════
   PIN YAKO NI PRODUCT YAKO — the buyer's protection screen.

   PROVENANCE. Lifted VERBATIM from sokoni-delivery-hub.js @ f996e80 on
   release/merchant-launch-rc. The markup, the copy in both languages, the class names and the
   stylesheet are byte-for-byte the ones that were built and browser-certified there — this is a
   RECOVERY, not a reimplementation. A rewritten protection screen would be a different screen
   wearing the same slogan.

   WHY ONLY THE SCREEN CAME ACROSS. The original lives inside the 722-line delivery hub client,
   whose rider board, dispatch chat and tracking map call delivery-hub callables that DO NOT EXIST
   on this branch. Importing the whole module would have added a rider rail that cannot work here
   in order to deliver a screen that can. The screen is self-contained — it reads no PIN, invokes
   no callable and moves no delivery — so it travels alone cleanly.

   WHY A BOOK AND NOT TWO CARDS (the original's reasoning, preserved): two stacked cards read as
   two different messages, and a buyer skims the one in their language and never learns the other
   exists. A book with a centre seam reads as one document published in two languages. Neither
   page is a translation of the other — each carries the full lead, all five checks, the warning
   and the rights statement — so a reader of either language gets the whole protection without
   cross-referencing. The slogan is NOT translated: it is the name of the protection, not a
   sentence inside it, and it sits above the seam belonging to both pages equally.

   IT ACKNOWLEDGES AND NOTHING ELSE. No PIN is read, held or sent; no callable is invoked; no
   lifecycle moves. It resolves, and the caller decides where the buyer goes — a protection screen
   that could confirm a delivery would be the opposite of a protection.

   IT IS SHOWN WHEN A BUYER CAN STILL ACT ON IT: after the order is placed, not at the doorstep
   with a rider waiting, which is when they are least able to do anything about it.
   ═══════════════════════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var PIN_YAKO_CHECKS = [
    { icon: '📦', en: 'Check that the product is correct',    sw: 'Hakikisha bidhaa ni uliyoagiza' },
    { icon: '🔢', en: 'Confirm the quantity',                 sw: 'Thibitisha idadi ya bidhaa' },
    { icon: '🎨', en: 'Check the size, colour or model',      sw: 'Angalia size, rangi au model' },
    { icon: '🔍', en: "Inspect the product's condition",      sw: 'Kagua hali ya bidhaa' },
    { icon: '✅', en: 'Make sure it matches your order',      sw: 'Hakikisha kila kitu kiko sawa' },
  ];

  var PIN_YAKO = {
    slogan: 'PIN YAKO NI PRODUCT YAKO!',
    checks: PIN_YAKO_CHECKS,
    en: {
      label: 'ENGLISH',
      lead: 'Before giving your PIN to the rider:',
      warn: 'Your PIN confirms that you have received the order.',
      warnSub: "If something isn't right, don't give out your PIN yet.",
      rights: 'Your PIN does not remove your warranty, refund, replacement or repair ' +
              'rights where the seller\'s policy offers them.',
    },
    sw: {
      label: 'KISWAHILI',
      lead: 'Kabla ya kumpa rider PIN yako:',
      warn: 'PIN yako inathibitisha kuwa umepokea oda yako.',
      warnSub: 'Ikiwa kuna kitu si sawa, usitoe PIN yako bado.',
      rights: 'PIN yako haiondoi haki zako za warranty, kurudishiwa pesa, kubadilishiwa ' +
              'bidhaa au matengenezo pale sera ya muuzaji inaporuhusu.',
    },
    /* The compact form, for a card away from the doorway. Both languages, still. */
    shortEn: 'Check your product before you give out your PIN.',
    shortSw: 'Usitoe PIN yako mpaka uhakikishe bidhaa uliyopewa ndiyo uliyoagiza.',
    action: '✓ GOT IT  |  NIMEELEWA  →',
  };

  function pinYakoPage(side, lang) {
    var checks = PIN_YAKO.checks.map(function (c) {
      return '<li class="dh-py-check">' +
        '<span class="dh-py-ico" aria-hidden="true">' + esc(c.icon) + '</span>' +
        '<span>' + esc(c[side]) + '</span></li>';
    }).join('');
    return '' +
      '<article class="dh-py-page dh-py-' + esc(side) + '" lang="' + esc(lang) + '">' +
        '<div class="dh-py-lang">' + esc(PIN_YAKO[side].label) + '</div>' +
        '<p class="dh-py-lead">' + esc(PIN_YAKO[side].lead) + '</p>' +
        '<ul class="dh-py-checks">' + checks + '</ul>' +
        '<div class="dh-py-warn">' +
          '<span class="dh-py-warn-ico" aria-hidden="true">⚠️</span>' +
          '<span><b>' + esc(PIN_YAKO[side].warn) + '</b>' +
          '<span class="dh-py-warn-sub">' + esc(PIN_YAKO[side].warnSub) + '</span></span>' +
        '</div>' +
        '<p class="dh-py-rights">' + esc(PIN_YAKO[side].rights) + '</p>' +
      '</article>';
  }

  /**
   * The whole protection screen: headline, open book, one action.
   *
   * `dismissable: false` renders the book without its action, for a caller that supplies
   * its own (or that shows this where there is nothing to acknowledge).
   */
  function pinProtectionHTML(opts) {
    var o = opts || {};
    return '' +
      '<div class="dh-py" role="dialog" aria-modal="true" aria-label="' + esc(PIN_YAKO.slogan) + '">' +
        '<div class="dh-py-crest" aria-hidden="true">🔐</div>' +
        '<h2 class="dh-py-slogan">' + esc(PIN_YAKO.slogan) + '</h2>' +
        '<div class="dh-py-book">' +
          pinYakoPage('en', 'en') +
          '<div class="dh-py-seam" aria-hidden="true"></div>' +
          pinYakoPage('sw', 'sw') +
        '</div>' +
        (o.dismissable === false ? '' :
          /* The platform's own button component — not a second button system. */
          '<button type="button" class="sk-btn sk-btn-primary dh-py-ok">' +
            esc(PIN_YAKO.action) + '</button>') +
      '</div>';
  }

  /** The compact form, for an order card or a tracking view that is not the doorway. */
  function pinProtectionBadgeHTML() {
    return '' +
      '<div class="dh-py-badge" role="note">' +
        '<span class="dh-py-badge-slogan">🔐 ' + esc(PIN_YAKO.slogan) + '</span>' +
        '<span class="dh-py-badge-sub">' + esc(PIN_YAKO.shortSw) + '</span>' +
        '<span class="dh-py-badge-sub">' + esc(PIN_YAKO.shortEn) + '</span>' +
      '</div>';
  }


  /**
   * Present it full-screen and resolve when the buyer acknowledges.
   *
   * IT RESOLVES AND NOTHING ELSE. No PIN is read, held or sent; no callable is invoked; no
   * lifecycle moves. The caller decides where the buyer goes next, which is why this returns
   * a promise rather than navigating: a protection screen that could confirm a delivery
   * would be the opposite of a protection.
   */
  function showPinProtection(opts) {
    var o = opts || {};
    var doc = global.document;
    if (!doc) return Promise.resolve(false);

    var host = doc.createElement('div');
    host.className = 'dh-py-screen';
    host.innerHTML = pinProtectionHTML(o);
    (o.mount || doc.body).appendChild(host);

    /* Scroll is locked while the screen is up, and restored to EXACTLY what it was — a
       protection screen that leaves a page unable to scroll is a support ticket. */
    var prevOverflow = doc.body.style.overflow;
    doc.body.style.overflow = 'hidden';

    return new Promise(function (resolve) {
      function done() {
        doc.body.style.overflow = prevOverflow;
        if (host.parentNode) host.parentNode.removeChild(host);
        resolve(true);
      }
      var btn = host.querySelector('.dh-py-ok');
      if (btn) btn.addEventListener('click', done);
      /* Escape acknowledges too. Trapping a reader inside a message they have read is not
         protection, it is an obstacle — and the badge keeps the warning up afterwards. */
      host.addEventListener('keydown', function (e) { if (e.key === 'Escape') done(); });
      if (btn && btn.focus) { try { btn.focus(); } catch (_) {} }
    });
  }
  /* The original exposed this as SokoniDeliveryHub.showPinProtection. It is named for what it IS
     here, because on this branch there is no delivery hub — claiming that name would promise a
     rider rail this file does not carry. */
  global.SokoniPinProtection = {
    show: showPinProtection,
    html: pinProtectionHTML,
    badgeHTML: pinProtectionBadgeHTML,
    COPY: PIN_YAKO,
  };
}(typeof window !== 'undefined' ? window : this));
