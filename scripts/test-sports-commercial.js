#!/usr/bin/env node
'use strict';
/* Sports commercial policy (owner 2026-10-03: bookings 5%, tournament entry 5%; every stream explicit)
     S1  explicit rows: sports_venue_bookings / sports_coaching / sports_tournament_entry at 5%, matched (never default)
     S2  venue bookings + coaching are FLAT bookings (no plan moves them); the real engine charges a KES 2,000 venue
         booking KES 100 and records policyVersion 2026-10-03.sports + resolvedCategory
     S3  'sports' alone still means a sports EVENT TICKET (events 5%) — Sports server code must name the explicit
         categories (asserted on functions/sports*.js once it exists)
   NODE_PATH=<functions/node_modules> node scripts/test-sports-commercial.js */
const path = require('path'), fs = require('fs'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 200))); ok ? pass++ : fail++; };
const CC = require(path.join(FN, 'commission-config.js'));
const db = { collection: () => ({ doc: () => ({ async get () { return { exists: false, data: () => undefined }; } }), where () { return this; },
  async get () { return { empty: true, docs: [], forEach () {} }; } }) };
const orig = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin') return { firestore: Object.assign(() => ({}), { Timestamp: { now: () => ({ toMillis: () => Date.now() }) }, FieldValue: {} }) };
  return orig.apply(this, arguments);
};
const FU = require(path.join(FN, 'finos-utils.js'));
Module.prototype.require = orig;

(async () => {
  const rows = { sports_venue: 'sports_venue_bookings', coaching: 'sports_coaching', coach_booking: 'sports_coaching',
    tournament_entry: 'sports_tournament_entry', tournament: 'sports_tournament_entry' };
  ck('S1 explicit Sports rows at 5% (matched, never the default)', Object.entries(rows).every(([k, cat]) => { const r = CC.resolveRate(k); return r.matched && r.category === cat && r.pct === 5; }));
  ck('S2a venue bookings + coaching are FLAT bookings; tournament entry is not', CC.FLAT_BOOKING_CATEGORIES.includes('sports_venue_bookings') && CC.FLAT_BOOKING_CATEGORIES.includes('sports_coaching') && !CC.FLAT_BOOKING_CATEGORIES.includes('sports_tournament_entry'));
  /* called exactly as provider-hub.commissionArgsForHub calls it for bookings: NO subscriptionRole (flat 5%). */
  const c = await FU.calculateCommission(db, { orderAmountCents: 200000, category: 'sports_venue_bookings', sellerId: 'V1' });
  ck('S2b real engine: KES 2,000 venue booking → KES 100 (5%), policy 2026-10-03.sports recorded', c.commissionCents === 10000 && c.effectiveRate === 5 && c.policyVersion === '2026-10-03.sports' && c.resolvedCategory === 'sports_venue_bookings',
    { cents: c.commissionCents, rate: c.effectiveRate, pv: c.policyVersion });
  const sportsFiles = fs.readdirSync(FN).filter((f) => /^sports.*\.js$/.test(f));
  const bare = sportsFiles.filter((f) => /category:\s*['"]sports['"]/.test(fs.readFileSync(path.join(FN, f), 'utf8')));
  ck('S1b bare "venue_booking" (the general venue purpose) is NOT a Sports alias', CC.resolveRate('venue_booking').category !== 'sports_venue_bookings');
  ck('S3 bare "sports" = events (event ticket); no Sports server file prices with bare "sports"', CC.resolveRate('sports').category === 'events' && bare.length === 0, bare);
  /* S4 — coaches book on the provider engine and are priced sports_coaching */
  const H = require(path.join(FN, 'provider-hub.js'));
  const coach = H.classifyDecidedApplication({ role: 'provider', category: 'coach' });
  const args = H.commissionArgsForHub(coach.hub);
  ck('S4a a decided coach application → lane sports_coaching → category sports_coaching (no subscriptionRole, no floor)',
    coach.hub === 'sports_coaching' && args.category === 'sports_coaching' && !('subscriptionRole' in args) && args.skipMinimum === true, { coach, args });
  ck('S4b a non-coach provider stays on the generic services lane; a role-mapped hub (health) still wins',
    H.classifyDecidedApplication({ role: 'provider', category: 'plumber' }).hub === 'provider' && H.classifyDecidedApplication({ role: 'health', category: 'coach' }).hub === 'healthcare');
  const stamped = await H.resolveProviderClassification({ collection: (c) => ({ doc: () => ({ get: async () => ({ exists: true, data: () => ({ business: { lane: { hub: 'sports_coaching' } } }) }) }) }) }, 'C1');
  ck('S4c a lane stamped sports_coaching at approval is honoured at booking time', stamped.hub === 'sports_coaching', stamped);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
