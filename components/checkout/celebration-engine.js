/* ============================================================================
   SOKONI — Celebration Engine
   components/checkout/celebration-engine.js

   The signature finish to a successful order. Instead of one static "success"
   screen, the celebration changes with the customer's journey — first order,
   milestones, birthday, holidays, and the occasional surprise — so checkout
   stays fresh and gives people something to look forward to beyond the receipt.

   PURE BY DESIGN. SokoniCelebration.pick(ctx) is a deterministic function of its
   input — it reads no clock and no globals. The CALLER passes the date and the
   order count, so the same order always renders the same celebration (no flicker
   on reload) and the whole thing is unit-testable without mocking time. That also
   sidesteps environments where `new Date()` is unavailable.

   USAGE
     var c = SokoniCelebration.pick({
       orderCount: 10,                 // this customer's lifetime successful orders
       dateISO:    '2026-12-25',       // order date (YYYY-MM-DD), caller-supplied
       birthdayMMDD: '07-23',          // optional 'MM-DD', or null
       orderId:    'SK-2026-019384'    // used only as a stable surprise seed
     });
     // -> { key, tier, emoji, headline, subline, accent, confetti, reward|null, priority }

   PRECEDENCE (highest first) — a customer hitting several at once gets the rarest:
     exact major milestone (1/10/50/100/…) > birthday > fixed-date holiday >
     every-100th beyond 100 > deterministic surprise (~1 in 8) > default
   ============================================================================ */
(function (root) {
  'use strict';

  var ACCENT = '#71ff00';               // SOKONI brand green
  var GOLD   = '#ffc107';
  var SILVER = '#cfd8e3';
  var BRONZE = '#cd7f32';

  /* Each config is display-only data; the renderer decides how to paint it. */
  function C(key, tier, emoji, headline, subline, accent, confetti, reward, priority) {
    return { key: key, tier: tier, emoji: emoji, headline: headline, subline: subline,
             accent: accent, confetti: !!confetti, reward: reward || null, priority: priority };
  }

  var DEFAULT = C('order_confirmed', null, '🎉',
    'Order Confirmed', 'Thank you for shopping with SOKONI.', ACCENT, false, null, 0);

  /* Exact milestones — keyed by lifetime order count. */
  var MILESTONES = {
    1:   C('first_order',  'Welcome',  '🎉', 'Welcome to SOKONI!',
           'Your very first order is on its way. This is the start of something good.',
           ACCENT, true, null, 100),
    10:  C('bronze',       'Bronze',   '🥉', '10 Orders — Bronze Unlocked',
           'You are officially a SOKONI regular. Thank you for keeping it local.',
           BRONZE, true, null, 100),
    50:  C('silver',       'Silver',   '🥈', '50 Orders — Silver Status',
           'Fifty orders. You are part of the fabric of SOKONI now.',
           SILVER, true, null, 100),
    100: C('gold',         'Gold',     '🥇', '100 Orders — Gold Member',
           'One hundred orders. You are SOKONI royalty. Watch for a little something extra.',
           GOLD, true, { label: 'Free Delivery', detail: 'on your next order' }, 100)
  };

  /* Fixed-date Kenyan holidays (MM-DD). Movable feasts (Easter, Eid) are left out
     on purpose — they need a lunar/paschal calc the caller can pass in later. */
  var HOLIDAYS = {
    '01-01': C('new_year',  'Season', '🎆', 'Happy New Year!',    'A fresh start, delivered.', GOLD,   true, null, 60),
    '05-01': C('labour',    'Season', '💪', 'Happy Labour Day',   'Powered by the people who make Kenya work.', ACCENT, false, null, 60),
    '06-01': C('madaraka',  'Season', '🇰🇪', 'Happy Madaraka Day', 'Self-rule, self-made. Asante.', ACCENT, true, null, 60),
    '10-20': C('mashujaa',  'Season', '🦁', 'Happy Mashujaa Day', 'For the heroes among us — including you.', GOLD, true, null, 60),
    '12-12': C('jamhuri',   'Season', '🇰🇪', 'Happy Jamhuri Day',  'Celebrating the Republic, one order at a time.', ACCENT, true, null, 60),
    '12-25': C('christmas', 'Season', '🎄', 'Merry Christmas!',    'Wishing you joy this festive season.', '#ef4444', true, null, 60),
    '12-26': C('boxing',    'Season', '🎁', 'Happy Boxing Day',    'The giving continues.', '#ef4444', true, null, 60),
    '12-31': C('new_year',  'Season', '🎆', 'Happy New Year!',     'Ending the year on a high.', GOLD, true, null, 60)
  };

  var BIRTHDAY = C('birthday', 'Birthday', '🎂', 'Happy Birthday!',
    'A little SOKONI treat on your special day. Enjoy!', GOLD, true,
    { label: 'Birthday Bonus', detail: 'double loyalty points on this order' }, 80);

  var SURPRISE = C('surprise', 'Surprise', '🎁', 'Surprise!',
    'A random reward, just because. You caught a lucky one.', ACCENT, true,
    { label: 'Surprise Reward', detail: 'a bonus is on your account' }, 20);

  function _mmdd(dateISO) {
    var m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(dateISO || ''));
    return m ? (m[1] + '-' + m[2]) : null;
  }

  /* Stable pseudo-random from the orderId so "surprise" is fixed per order (no
     reroll on refresh) yet unpredictable to the customer. ~1 in 8. */
  function _isSurprise(orderId) {
    var s = String(orderId || '');
    if (!s) return false;
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) & 0x7fffffff; }
    return (h % 8) === 0;
  }

  function pick(ctx) {
    ctx = ctx || {};
    var n = Math.max(0, parseInt(ctx.orderCount, 10) || 0);
    var mmdd = _mmdd(ctx.dateISO);

    var candidates = [];

    if (MILESTONES[n]) candidates.push(MILESTONES[n]);
    if (ctx.birthdayMMDD && mmdd && ctx.birthdayMMDD === mmdd) candidates.push(BIRTHDAY);
    if (mmdd && HOLIDAYS[mmdd]) candidates.push(HOLIDAYS[mmdd]);

    /* Every 100th beyond the named 100 (200, 300…) still deserves a Gold moment. */
    if (n > 100 && n % 100 === 0) {
      candidates.push(C('century', 'Gold', '🏆', n + ' Orders!',
        'Another hundred. Genuinely remarkable. Thank you.', GOLD, true, null, 90));
    }

    if (_isSurprise(ctx.orderId)) candidates.push(SURPRISE);

    if (!candidates.length) return DEFAULT;
    candidates.sort(function (a, b) { return b.priority - a.priority; });
    return candidates[0];
  }

  root.SokoniCelebration = { pick: pick, DEFAULT: DEFAULT };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SokoniCelebration;

})(typeof window !== 'undefined' ? window : this);
