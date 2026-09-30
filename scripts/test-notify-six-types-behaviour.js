/* The six types registered on 2026-09-30 must behave like their peers — and must NOT
 * quietly acquire powers they were never meant to have.
 *
 * Registering a type is not a free act. `critical` bypasses BOTH preferences and quiet
 * hours; a new `category` silently extends the per-user preferences schema, because
 * CATEGORIES is derived from TYPES; and an smsTemplate that names a non-existent
 * template would fail at send time rather than here. This suite EXECUTES the real
 * resolveChannels() for each type rather than reading the table, so what is proven is
 * the routing the engine actually performs.
 *
 *   node scripts/test-notify-six-types-behaviour.js        (needs functions/node_modules)
 */
'use strict';
const path = require('path');
const fs = require('fs');
const N = require(path.resolve('functions/notify.js'));
const { TYPES, CATEGORIES, resolveChannels, defaultPrefs } = N;

let pass = 0, fail = 0;
const ok = (n, v, d) => {
  v ? (pass++, console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')))
    : (fail++, console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')));
};

const SIX = ['booking_confirmed', 'booking_affected', 'order_ready_pickup',
             'order_dispatching', 'payout_paid', 'payout_failed'];

console.log('\n=== control — the engine loaded and the peers are intact ===');
ok('resolveChannels is callable', typeof resolveChannels === 'function');
ok('defaultPrefs is callable', typeof defaultPrefs === 'function');
ok('control — a known critical type still bypasses preferences', (() => {
  const c = resolveChannels('wallet_debit', defaultPrefs(), true);
  return c.forced === true && c.push === true;
})());

const prefs = defaultPrefs();

console.log('\n=== each of the six routes like a commerce peer ===');
for (const ty of SIX) {
  const t = TYPES[ty];
  ok(`${ty} is registered`, !!t);
  if (!t) continue;

  ok(`${ty} is commerce, not critical`, t.priority === 'commerce', t.priority);
  ok(`${ty} carries NO smsTemplate`, t.smsTemplate === null, String(t.smsTemplate));

  const open = resolveChannels(ty, prefs, false);
  ok(`${ty} delivers in-app`, open.inapp === true);
  ok(`${ty} delivers push`, open.push === true);
  ok(`${ty} sends no SMS (no template)`, !open.sms);
  ok(`${ty} is NOT forced past preferences`, open.forced !== true);

  /* quiet hours: commerce is not marketing, so in-app must still land */
  const quiet = resolveChannels(ty, prefs, true);
  ok(`${ty} still lands in-app during quiet hours`, quiet.inapp === true);

  /* a user who switched this category off must actually be obeyed */
  const off = JSON.parse(JSON.stringify(prefs));
  off[t.category] = { ...(off[t.category] || {}), push: false, inapp: false, sms: false };
  const muted = resolveChannels(ty, off, false);
  ok(`${ty} obeys a user who muted ${t.category}`, muted.push === false && muted.inapp === false);
}

console.log('\n=== the six did not extend the preferences schema ===');
const KNOWN_BEFORE = ['security', 'payments', 'wallet', 'orders', 'delivery', 'marketplace',
                      'loyalty', 'procurement', 'support', 'ai', 'system', 'promotions',
                      'subscriptions'];
ok('control — CATEGORIES is derived from TYPES', Array.isArray(CATEGORIES) && CATEGORIES.length > 5,
   CATEGORIES.join(','));
const stray = CATEGORIES.filter((c) => !KNOWN_BEFORE.includes(c));
ok('no new category was introduced', stray.length === 0, stray.join(',') || 'none');
for (const ty of SIX) {
  if (TYPES[ty]) ok(`${ty} reuses an existing category`, KNOWN_BEFORE.includes(TYPES[ty].category),
    TYPES[ty].category);
}

console.log('\n=== each of the six maps to its peer\'s routing ===');
/* If a new type routed differently from the peer it sits beside, that is a silent
   behaviour change hiding inside a "registration". */
const PEER = {
  booking_confirmed:  'booking_new',
  booking_affected:   'booking_new',
  order_ready_pickup: 'order_ready',
  order_dispatching:  'order_dispatched',
  payout_paid:        'wallet_credit',
  payout_failed:      'wallet_credit',
};
for (const [ty, peer] of Object.entries(PEER)) {
  if (!TYPES[ty] || !TYPES[peer]) { ok(`${ty} vs ${peer} comparable`, false); continue; }
  ok(`${ty} has the same priority as ${peer}`, TYPES[ty].priority === TYPES[peer].priority,
     TYPES[ty].priority + ' vs ' + TYPES[peer].priority);
  ok(`${ty} has the same category as ${peer}`, TYPES[ty].category === TYPES[peer].category,
     TYPES[ty].category + ' vs ' + TYPES[peer].category);
}
/* payout_* deliberately differ from wallet_credit on SMS: the peer has a template and
   these do not. Stated explicitly so the difference is a decision, not an oversight. */
ok('payout_paid deliberately has no SMS where wallet_credit does',
   TYPES.payout_paid && TYPES.payout_paid.smsTemplate === null &&
   TYPES.wallet_credit && TYPES.wallet_credit.smsTemplate === 'wallet_credit');

console.log('\n=== no SMS template was invented ===');
const sms = fs.readFileSync(path.resolve('functions/sms-service.js'), 'latin1');
for (const ty of SIX) {
  ok(`sms-service.js has no template named ${ty}`,
     !new RegExp('^\\s{2}' + ty + ':\\s*\\{', 'm').test(sms));
}
ok('control — it DOES have a template for a type that claims one',
   /^\s{2}payment_success:\s*\{/m.test(sms));

console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
process.exitCode = fail ? 1 : 0;
