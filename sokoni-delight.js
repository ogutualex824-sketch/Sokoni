/* ══════════════════════════════════════════════════════════════════════════
   SOKONI DELIGHT LAYER  —  sokoni-delight.js

   The ONE place a "something good just happened" moment is expressed.

   ── Why this exists ─────────────────────────────────────────────────────
   The platform already had a shared toast (SokoniUI.toast). It also had ~80
   bespoke re-implementations of it — toast / showToast / showNotif /
   showNotification / _toast / _drvToast — across ~2,600 call sites, plus 184
   raw alert() calls. Every one of them says the same thing in a different voice.

   That fragmentation hid something worse than inconsistency. An audit of the
   ten moments that matter most found that MONEY ARRIVES SILENTLY:

     wallet credited     → no feedback at all
     cashback received   → no feedback at all
     loyalty points      → silent on purchase (only signup ever said anything)
     refund approved     → the ADMIN gets a toast; the buyer is told nothing
     rider assigned      → the DRIVER gets a toast + haptic; the buyer gets nothing

   For a platform whose whole promise is trust, funds landing in a wallet with
   no acknowledgement is not a missing animation. It is a trust defect. A user
   who is not told their money arrived has to go and check — and a user who has
   to check does not trust you yet.

   ── The vocabulary ──────────────────────────────────────────────────────
   Moments are keyed by the SAME type names the server notification engine uses
   (functions/notify.js TYPES): payment_success, wallet_credit, rider_assigned,
   order_dispatched, refund_processed, subscription_activated…

   That is deliberate. The server already decided what these events are called.
   Inventing a second vocabulary for the client is how you end up with
   fcmToken vs fcmTokens — two names for one thing, drifting apart quietly.
   One event has one name, end to end.

   ── The rules ───────────────────────────────────────────────────────────
   • Celebration is EARNED, not sprayed. Confetti fires for money and milestones
     — never for "added to cart". A platform that celebrates everything
     celebrates nothing, and the animation becomes noise the user learns to
     ignore precisely when you need them to look.
   • prefers-reduced-motion is obeyed, always. For some users motion is not
     delight, it is nausea or a migraine. They still get the full message and
     the haptic — they simply do not get the movement. Reduced motion must never
     mean reduced information.
   • Haptics are short and rare. A buzz is an interruption; spend them on money.
   • Zero dependencies. Confetti is capped DOM nodes on GPU-composited transforms
     (opacity + transform only — never layout-triggering properties), removed on
     completion. It must never cost a frame on a cheap Android phone, which is
     what most of Kenya is actually holding.

   Usage
     SokoniDelight.moment('wallet_credit', { amount: 2500 });
     SokoniDelight.moment('payment_success', { orderId: 'SK123' });
     SokoniDelight.haptic('success');
═════════════════════════════════════════════════════════════════════════ */
(function (global) {
  'use strict';

  if (global.SokoniDelight) return;               /* singleton — never double-bind */

  /* ── Accessibility gate ────────────────────────────────────────────────
     Read live rather than cached: a user can change this setting mid-session,
     and honouring it only at load time would ignore them for the rest of it. */
  function _reducedMotion() {
    try {
      return global.matchMedia &&
             global.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch (e) { return false; }
  }

  /* ── Money formatting — Kenyan Shilling, no decimals on whole amounts ──
     "KSh 2,500" reads like money. "KSh 2500.00" reads like a database row. */
  function _ksh(n) {
    var v = Number(n);
    if (!isFinite(v)) return '';
    var whole = Math.round(v * 100) % 100 === 0;
    return 'KSh ' + v.toLocaleString('en-KE', {
      minimumFractionDigits: whole ? 0 : 2,
      maximumFractionDigits: 2
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     MOMENT REGISTRY

     Keys mirror functions/notify.js TYPES. Adding a moment is a registry
     entry, not a code change.

       level    'celebrate' → confetti + haptic + toast   (money, milestones)
                'confirm'   → toast + light haptic        (progress worth noticing)
                'quiet'     → toast only                  (routine acknowledgement)
       haptic   success | tap | none
  ══════════════════════════════════════════════════════════════════════ */
  var MOMENTS = {
    /* ── Money. These were the silent ones. They celebrate. ── */
    wallet_credit: {
      level: 'celebrate', haptic: 'success', icon: '💰',
      title: 'Wallet Credited',
      body: function (d) {
        return d.amount ? _ksh(d.amount) + ' has landed in your SOKONI wallet.'
                        : 'Your SOKONI wallet has been credited.';
      }
    },
    cashback_received: {
      level: 'celebrate', haptic: 'success', icon: '🎁',
      title: 'Cashback Received',
      body: function (d) {
        return d.amount ? 'You earned ' + _ksh(d.amount) + ' cashback.'
                        : 'You earned cashback on that order.';
      }
    },
    refund_processed: {
      level: 'celebrate', haptic: 'success', icon: '↩️',
      title: 'Refund Approved',
      body: function (d) {
        return d.amount ? _ksh(d.amount) + ' is on its way back to you.'
                        : 'Your refund has been approved.';
      }
    },
    payment_success: {
      level: 'celebrate', haptic: 'success', icon: '✅',
      title: 'Payment Confirmed',
      /* SOKONI confirms the payment. Bravilex is the Merchant of Record and the
         settlement entity — but the customer never transacts with a name they
         have never heard of. See docs/BRAND_POLICY.md. */
      body: function (d) {
        return d.orderId ? 'SOKONI has confirmed your payment for order ' + d.orderId + '.'
                         : 'SOKONI has confirmed your payment.';
      }
    },
    loyalty_earned: {
      level: 'celebrate', haptic: 'success', icon: '⭐',
      title: 'Points Earned',
      body: function (d) {
        return d.points ? 'You earned ' + d.points + ' SOKONI points.'
                        : 'You earned SOKONI points.';
      }
    },
    subscription_activated: {
      level: 'celebrate', haptic: 'success', icon: '🚀',
      title: 'Subscription Active',
      body: function (d) {
        return (d.plan ? d.plan + ' is now active.' : 'Your plan is now active.');
      }
    },

    /* ── Progress worth noticing. Confirmed, not celebrated. ── */
    rider_assigned: {
      level: 'confirm', haptic: 'tap', icon: '🏍',
      title: 'Rider Assigned',
      body: function (d) {
        return (d.riderName ? d.riderName + ' is collecting your order.'
                            : 'A rider is collecting your order.');
      }
    },
    order_dispatched: {
      level: 'confirm', haptic: 'tap', icon: '📦',
      title: 'Package Picked Up',
      body: function () { return 'Your package is on its way to you.'; }
    },
    order_delivered: {
      level: 'celebrate', haptic: 'success', icon: '🎉',
      title: 'Delivered',
      body: function () { return 'Your order has arrived. Enjoy!'; }
    },
    seller_verified: {
      level: 'celebrate', haptic: 'success', icon: '🛡️',
      title: 'You’re Verified',
      body: function () { return 'Your SOKONI seller account is now verified.'; }
    },

    /* ── Routine. A toast, and nothing more.
         "Added to cart" happens dozens of times a session. Celebrating it would
         devalue every celebration that actually matters. ── */
    cart_add: {
      level: 'quiet', haptic: 'tap', icon: '🛒',
      title: '', body: function (d) {
        return (d.name ? d.name + ' added to cart.' : 'Added to cart.');
      }
    }
  };

  /* ── Haptics ────────────────────────────────────────────────────────────
     navigator.vibrate is ignored by iOS Safari and is a no-op on desktop. It is
     an ENHANCEMENT: nothing may depend on it firing. Wrapped in try/catch
     because some Android browsers throw rather than no-op. */
  var HAPTICS = {
    success: [12, 40, 18],   /* two light taps — felt, not startling */
    tap:     [10],
    none:    null
  };

  function haptic(kind) {
    if (!global.navigator || typeof global.navigator.vibrate !== 'function') return;
    var pattern = HAPTICS[kind || 'tap'];
    if (!pattern) return;
    try { global.navigator.vibrate(pattern); } catch (e) { /* enhancement only */ }
  }

  /* ── Styles: injected once, on first use ───────────────────────────────
     Deliberately NOT added to the global CSS bundle. Every page already pays
     403 KB across 18 files; a page that never celebrates anything should not
     download the confetti. */
  var _styled = false;
  function _ensureStyles() {
    if (_styled || !global.document) return;
    _styled = true;
    var css =
      '@keyframes sk-dl-fall{' +
        '0%{opacity:1;transform:translate3d(0,-12vh,0) rotate(0)}' +
        '100%{opacity:0;transform:translate3d(var(--sk-dl-x,0),102vh,0) rotate(var(--sk-dl-r,360deg))}' +
      '}' +
      '.sk-dl-piece{position:fixed;top:0;width:9px;height:9px;border-radius:2px;' +
        'pointer-events:none;z-index:2147483000;will-change:transform,opacity;' +
        'animation:sk-dl-fall var(--sk-dl-d,2.4s) cubic-bezier(.16,.62,.4,1) forwards}' +
      /* Reduced motion: the confetti is never created at all (see celebrate()),
         but if a piece somehow exists, it must not move. */
      '@media (prefers-reduced-motion: reduce){.sk-dl-piece{display:none!important}}';
    var el = global.document.createElement('style');
    el.id = 'sk-delight-styles';
    el.textContent = css;
    global.document.head.appendChild(el);
  }

  /* SOKONI green, plus two supporting tones. Brand, not a rainbow. */
  var COLORS = ['#71ff00', '#b8ff7a', '#ffffff', '#4ade80'];

  /* ── Confetti ──────────────────────────────────────────────────────────
     Capped at 28 nodes. Transform + opacity only, so it composites on the GPU
     and never triggers layout — the difference between "premium" and "janky" on
     the low-end Android that most Kenyan users actually carry.

     Every node is removed on animationend, with a belt-and-braces timeout in
     case the tab is backgrounded mid-flight and the event never fires. Leaking
     DOM nodes on a long-lived PWA session is how a fast app slowly dies. */
  function celebrate(opts) {
    opts = opts || {};
    if (_reducedMotion() || !global.document || !global.document.body) return;

    _ensureStyles();

    var count = Math.min(opts.count || 28, 40);
    var frag  = global.document.createDocumentFragment();
    var nodes = [];

    for (var i = 0; i < count; i++) {
      var p = global.document.createElement('div');
      p.className = 'sk-dl-piece';
      p.style.left            = (Math.random() * 100) + 'vw';
      p.style.background      = COLORS[i % COLORS.length];
      p.style.setProperty('--sk-dl-x', (Math.random() * 160 - 80) + 'px');
      p.style.setProperty('--sk-dl-r', (Math.random() * 720 - 360) + 'deg');
      p.style.setProperty('--sk-dl-d', (1.8 + Math.random() * 1.4).toFixed(2) + 's');
      p.style.animationDelay   = (Math.random() * 0.25).toFixed(2) + 's';
      if (i % 3 === 0) p.style.borderRadius = '50%';
      frag.appendChild(p);
      nodes.push(p);
    }
    global.document.body.appendChild(frag);

    var cleaned = false;
    function _clean() {
      if (cleaned) return;
      cleaned = true;
      for (var j = 0; j < nodes.length; j++) {
        if (nodes[j].parentNode) nodes[j].parentNode.removeChild(nodes[j]);
      }
    }
    nodes[nodes.length - 1].addEventListener('animationend', _clean, { once: true });
    global.setTimeout(_clean, 4200);   /* backgrounded tabs never fire animationend */
  }

  /* ── Say it ────────────────────────────────────────────────────────────
     Reuse before create: if SokoniUI.toast exists (it is injected on 302/308
     pages) we use it, so the delight layer inherits its a11y — role="alert",
     aria-live, click-to-dismiss, stacking cap.

     The fallback is NOT alert(). A blocking modal dialog to say "your wallet was
     credited" would be worse than the silence we are fixing. */
  function _say(icon, title, body, level) {
    var msg  = (icon ? icon + '  ' : '') + (title ? title + ' — ' : '') + body;
    var type = 'success';

    if (global.SokoniUI && typeof global.SokoniUI.toast === 'function') {
      global.SokoniUI.toast(body, type, {
        title:    (icon ? icon + ' ' : '') + (title || ''),
        duration: level === 'celebrate' ? 5000 : 3500
      });
      return;
    }
    /* No shared toast on this page — degrade to console, never to alert(). */
    if (global.console && global.console.info) global.console.info('[SOKONI] ' + msg);
  }

  /* ── The one entry point ───────────────────────────────────────────────
     An unknown moment must not throw. A delight layer that can break a payment
     confirmation by throwing on a typo'd key is a liability, not a feature. */
  function moment(type, data) {
    data = data || {};
    var m = MOMENTS[type];

    if (!m) {
      if (global.console && global.console.warn) {
        global.console.warn('[SokoniDelight] unknown moment "' + type + '" — ignored');
      }
      return false;
    }

    var body = typeof m.body === 'function' ? m.body(data) : String(m.body || '');

    /* Message first, always. If celebrate() were to fail on some exotic browser,
       the user must still be TOLD. The information is the product; the confetti
       is the polish. */
    _say(m.icon, m.title, body, m.level);
    haptic(m.haptic);

    if (m.level === 'celebrate') celebrate({ count: data.count });

    return true;
  }

  global.SokoniDelight = {
    moment:    moment,
    celebrate: celebrate,
    haptic:    haptic,
    ksh:       _ksh,
    MOMENTS:   MOMENTS
  };

})(typeof window !== 'undefined' ? window : this);
