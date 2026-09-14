#!/usr/bin/env node
/* Delivery visibility — the buyer can see where their order actually is.
 *
 *   node scripts/test-delivery-visibility.js
 *
 * THE GAP
 * The buyer's timeline went "Rider assigned" -> "Picked up" with nothing in between, so the
 * longest silent stretch of the journey — the rider accepting and riding to the shop — was
 * invisible. That silence is when people call support to ask whether anything is happening.
 *
 * Worse, the trip-status map actively discarded the signal that DID exist:
 *   en_route_pickup -> 'assigned'   the timeline stood still while the rider was moving
 *   arrived_pickup  -> 'ready'      'ready' is EARLIER than 'assigned' — it went BACKWARDS
 *
 * A progress timeline that can move backwards is worse than one with a missing step: it
 * tells the buyer something untrue about their own order.
 *
 * Static analysis of the shipped sources — no browser, no network.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label +
    (detail !== undefined && detail !== '' ? '   [' + String(detail).slice(0, 160) + ']' : ''));
  ok ? pass++ : fail++;
};

const track = fs.readFileSync(path.join(ROOT, 'track.html'), 'utf8');

/* Parse the two structures out of the shipped page rather than restating them here — a
   restated copy is a second source of truth and would pass while the page was broken. */
function stageOrder() {
  const m = track.match(/var STAGES\s*=\s*\[([\s\S]*?)\];/);
  if (!m) return null;
  return [...m[1].matchAll(/\{\s*k\s*:\s*'([a-z_]+)'/g)].map((x) => x[1]);
}
function tripMap() {
  const m = track.match(/var TRIP_TO_STAGE\s*=\s*\{([\s\S]*?)\};/);
  if (!m) return null;
  const out = {};
  for (const x of m[1].matchAll(/([a-z_]+)\s*:\s*'([a-z_]+)'/g)) out[x[1]] = x[2];
  return out;
}

const STAGES = stageOrder();
const TRIP = tripMap();
const IDX = {};
(STAGES || []).forEach((k, i) => { IDX[k] = i; });

console.log('\nPART A — the extractors can see\n');
ck('A1  the STAGES timeline was parsed', !!STAGES && STAGES.length > 5, STAGES && STAGES.length);
ck('A2  the trip->stage map was parsed', !!TRIP && Object.keys(TRIP).length > 5,
  TRIP && Object.keys(TRIP).length);
if (!STAGES || !TRIP) {
  console.log('\nEXTRACTOR FAILED — refusing to report results that would be vacuous.\n');
  process.exit(1);
}

console.log('\nPART B — the ride to the shop is visible\n');
ck('B1  there is a stage for the rider heading to the shop', IDX.to_shop !== undefined, String(IDX.to_shop));
ck('B2  ...it sits AFTER the rider is assigned', IDX.to_shop > IDX.assigned,
  'assigned@' + IDX.assigned + ' to_shop@' + IDX.to_shop);
ck('B3  ...and BEFORE the parcel is picked up', IDX.to_shop < IDX.picked_up,
  'to_shop@' + IDX.to_shop + ' picked_up@' + IDX.picked_up);
ck('B4  ...and it says so in words a buyer understands',
  /to_shop[^}]*l\s*:\s*'[^']*shop/i.test(track),
  (track.match(/\{k:'to_shop'[^}]*\}/) || [''])[0]);

console.log('\nPART C — the timeline never moves backwards\n');
{
  /* Every trip status must map to a stage that exists, and the pickup-leg statuses must
     advance monotonically through it. */
  const unknown = Object.entries(TRIP).filter(([, v]) => IDX[v] === undefined);
  ck('C1  every trip status maps to a stage that exists', unknown.length === 0,
    unknown.map(([k, v]) => k + '->' + v).join(', '));

  ck('C2  en_route_pickup no longer collapses back into "assigned"',
    TRIP.en_route_pickup !== 'assigned', TRIP.en_route_pickup);
  ck('C3  ...it advances the timeline', IDX[TRIP.en_route_pickup] > IDX.assigned,
    TRIP.en_route_pickup + '@' + IDX[TRIP.en_route_pickup]);

  ck('C4  arrived_pickup no longer maps EARLIER than assigned (the backwards jump)',
    IDX[TRIP.arrived_pickup] >= IDX.assigned,
    TRIP.arrived_pickup + '@' + IDX[TRIP.arrived_pickup] + ' vs assigned@' + IDX.assigned);

  /* The pickup leg, in the order it actually happens. */
  const leg = ['assigned', 'en_route_pickup', 'arrived_pickup', 'en_route_delivery', 'arrived_delivery', 'completed'];
  let monotonic = true, detail = '';
  for (let i = 1; i < leg.length; i++) {
    const a = IDX[TRIP[leg[i - 1]]], b = IDX[TRIP[leg[i]]];
    if (a === undefined || b === undefined) continue;
    if (b < a) { monotonic = false; detail = leg[i - 1] + '(' + a + ') -> ' + leg[i] + '(' + b + ')'; break; }
  }
  ck('C5  the whole trip sequence never goes backwards', monotonic, detail);
}

console.log('\nPART D — the buyer is TOLD, not only shown\n');
for (const f of ['functions/sokoni-logistics.js', 'sokoni-logistics.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ck('D1  ' + f + ' has a notification for the ride to the shop',
    /driver_en_route_pickup\s*:/.test(src));
  ck('D2  ' + f + ' ...says the rider is heading to the shop',
    /driver_en_route_pickup[\s\S]{0,400}?heading to the shop/i.test(src));

  /* THE COPY BUG. `driver_at_seller` is the rider ARRIVING at the shop, but announced
     "has collected your parcel and is heading to you" — a post-collection message on a
     pre-collection event. A buyer told the parcel is collected, then left waiting while it
     is still on the counter, has been told something untrue. */
  ck('D3  ' + f + ' driver_at_seller no longer claims the parcel is already collected',
    !/driver_at_seller[\s\S]{0,400}?has collected your parcel and is heading to you/i.test(src));
  ck('D4  ' + f + ' ...it describes arriving at the shop instead',
    /driver_at_seller[\s\S]{0,400}?(arrived at the shop|at the shop collecting)/i.test(src));
}

console.log('\nPART E — the two client copies agree\n');
{
  const a = fs.readFileSync(path.join(ROOT, 'functions/sokoni-logistics.js'), 'utf8');
  const b = fs.readFileSync(path.join(ROOT, 'sokoni-logistics.js'), 'utf8');
  const stagesOf = (s) => [...s.matchAll(/^\s{4}([a-z_]+)\s*:\s*\{/gm)].map((m) => m[1]);
  const sa = stagesOf(a), sb = stagesOf(b);
  const onlyA = sa.filter((x) => !sb.includes(x));
  const onlyB = sb.filter((x) => !sa.includes(x));
  /* RECONCILED 2026-09-07. `return_initiated` and `refund_initiated` existed only in the
     browser copy; both now exist on the server too, with the client copy's own wording
     rather than a second phrasing of the same event.

     WHY THE DIVERGENCE MATTERED: renderNotification returns null for an unknown stage, and
     a null return is indistinguishable from "nothing to send" — so a server-side return or
     refund reached the customer as SILENCE, on exactly the two events people chase support
     about. Nothing errored; the message simply never went.

     The baseline that tracked it is now EMPTY, and the assertion is symmetric: neither copy
     may declare a stage the other lacks. An empty allowance is the strongest form of the
     "can only shrink" rule — there is nothing left to shrink. */
  const KNOWN_CLIENT_ONLY = [];
  const newOnlyB = onlyB.filter((x) => !KNOWN_CLIENT_ONLY.includes(x));
  ck('E1  no stage exists on the SERVER copy alone', onlyA.length === 0, onlyA.join(','));
  ck('E2  no stage exists on the CLIENT copy alone', newOnlyB.length === 0, newOnlyB.join(','));
  ck('E3  the tracked-divergence baseline is empty — the two copies fully agree',
    KNOWN_CLIENT_ONLY.length === 0 && onlyA.length === 0 && onlyB.length === 0,
    'baseline=' + KNOWN_CLIENT_ONLY.length + ' onlyA=' + onlyA.length + ' onlyB=' + onlyB.length);
  /* The specific two, named, so a future deletion of either is caught as a regression and
     not merely as "the sets still match" — which would also be true if BOTH lost them. */
  for (const stage of ['return_initiated', 'refund_initiated']) {
    ck('E4  both copies declare ' + stage,
      sa.includes(stage) && sb.includes(stage),
      'server=' + sa.includes(stage) + ' client=' + sb.includes(stage));
  }
}

console.log('\nPART F — adversarial controls\n');
{
  /* If the parser returned a list where every lookup is undefined, every ordering assertion
     above would compare undefined with undefined and could pass vacuously. */
  ck('F1  the stage index resolves real positions', IDX.assigned !== undefined
    && IDX.picked_up !== undefined && IDX.delivered !== undefined,
    'assigned@' + IDX.assigned + ' picked_up@' + IDX.picked_up + ' delivered@' + IDX.delivered);
  ck('F2  the ordering test can FAIL — delivered is after assigned, not before',
    IDX.delivered > IDX.assigned);
  ck('F3  a stage that does not exist is detected as missing', IDX.no_such_stage === undefined);
  /* And the map must actually contain the keys the assertions read. */
  ck('F4  the trip map contains the pickup-leg keys the assertions depend on',
    !!TRIP.en_route_pickup && !!TRIP.arrived_pickup,
    TRIP.en_route_pickup + '/' + TRIP.arrived_pickup);
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
