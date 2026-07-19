/* Parity gate: the client lifecycle mirror must not drift from the server.

   Duplicating the vocabulary client-side is only safe if drift cannot ship.
   This asserts both modules agree EXACTLY on stages, aliases and labels, and on
   the behaviour derived from them. Add an alias on one side only and this fails.

   Without this gate the mirror is a fork, and a fork is how a rider ends up
   refused an address because two files disagreed about what "assigned" means. */
'use strict';
const fs = require('fs');
const vm = require('vm');

const S = require('../functions/fulfilment-lifecycle');

const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync('./sokoni-fulfilment-lifecycle.js', 'utf8'), sandbox);
const C = sandbox.window.SokoniLifecycle;

let pass = 0, fail = 0;
const check = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};

console.log('\n── Vocabulary parity ──');
check('client module loads', !!C);
check('CANONICAL identical, same order',
      JSON.stringify(C.CANONICAL) === JSON.stringify(S.CANONICAL),
      C.CANONICAL.length + ' vs ' + S.CANONICAL.length);

const ak = (o) => Object.keys(o).sort();
const missingClient = ak(S.ALIASES).filter(k => !(k in C.ALIASES));
const missingServer  = ak(C.ALIASES).filter(k => !(k in S.ALIASES));
check('no alias missing from client', missingClient.length === 0, missingClient.join(',') || 'none');
check('no alias missing from server',  missingServer.length === 0,  missingServer.join(',')  || 'none');

const divergent = ak(S.ALIASES).filter(k => k in C.ALIASES && S.ALIASES[k] !== C.ALIASES[k]);
check('every shared alias resolves identically', divergent.length === 0,
      divergent.map(k => k + ': ' + S.ALIASES[k] + '/' + C.ALIASES[k]).join(', ') || 'none');

check('LABELS identical', JSON.stringify(C.LABELS) === JSON.stringify(S.LABELS));
check('UNKNOWN sentinel identical', C.UNKNOWN === S.UNKNOWN);

console.log('\n── Behavioural parity across every known value ──');
const ALL = [...new Set([...ak(S.ALIASES), ...ak(C.ALIASES),
                         'teleported', '', 'IN-TRANSIT', '  Delivered  '])];
let nMismatch = 0, aMismatch = 0, tMismatch = 0;
for (const v of ALL) {
  if (S.normalize(v)     !== C.normalize(v))     nMismatch++;
  if (S.isRiderActive(v) !== C.isRiderActive(v)) aMismatch++;
  if (S.isTerminal(v)    !== C.isTerminal(v))    tMismatch++;
}
check('normalize() agrees on all ' + ALL.length + ' values', nMismatch === 0, nMismatch + ' differ');
check('isRiderActive() agrees on all values',                aMismatch === 0, aMismatch + ' differ');
check('isTerminal() agrees on all values',                   tMismatch === 0, tMismatch + ' differ');

let cMismatch = 0;
for (const a of S.CANONICAL) for (const b of S.CANONICAL) {
  if (S.canAdvance(a, b) !== C.canAdvance(a, b)) cMismatch++;
}
check('canAdvance() agrees across all stage pairs', cMismatch === 0, cMismatch + ' differ');

console.log('\n── UI helpers never leak a legacy value ──');
const LEGACY = ['driver_assigned', 'rider_assigned', 'driver_accepted', 'offered',
                'picking_up', 'rider_en_route', 'out_for_delivery', 'exhausted'];
for (const v of LEGACY) {
  const l = C.label(v);
  check('label(' + v + ') is a canonical label', Object.values(S.LABELS).includes(l), l);
}
check('unknown value renders as "Unknown", not raw', C.label('teleported') === 'Unknown');
check('label() never returns the raw input',
      LEGACY.every(v => C.label(v) !== v));

console.log('\n── Board + transition helpers ──');
check('board shows 9 working columns (returned is an exception queue)',
      C.boardColumns().length === 9, String(C.boardColumns().length));
check('board columns are canonical stages',
      C.boardColumns().every(c => S.CANONICAL.includes(c.stage)));
check('board columns carry labels, not raw stages',
      C.boardColumns().every(c => c.label && c.label !== c.stage));

check('allowedTransitions never offers a backward move',
      C.allowedTransitions('in_transit').every(t => S.canAdvance('in_transit', t.stage)));
check('allowedTransitions from a terminal stage is empty',
      C.allowedTransitions('completed').length === 0, String(C.allowedTransitions('completed').length));
check('seller cannot mark an order delivered by hand',
      !C.sellerActions('assigned').some(t => t.stage === 'delivered'));
check('seller CAN move accepted -> packing',
      C.sellerActions('accepted').some(t => t.stage === 'packing'));
check('every offered transition would be accepted by canAdvance',
      S.CANONICAL.every(from => C.allowedTransitions(from).every(t => S.canAdvance(from, t.stage))));

console.log('\n── notify.js ORDER_TIMELINE absorbed (the fifth vocabulary) ──');
const TIMELINE = ['received', 'paid', 'accepted', 'preparing', 'ready', 'assigned',
                  'picked_up', 'halfway', 'near', 'delivered', 'completed'];
for (const k of TIMELINE) {
  check('timeline key "' + k + '" resolves', S.normalize(k) !== S.UNKNOWN, S.normalize(k));
}
check('timeline keys agree client/server',
      TIMELINE.every(k => S.normalize(k) === C.normalize(k)));
check('halfway + near collapse to in_transit',
      S.normalize('halfway') === 'in_transit' && S.normalize('near') === 'in_transit');

console.log('\n── resolveStage takes the furthest-along field ──');
const CASES = [
  { o: { status: 'paid', timelineStage: 'picked_up' },                       want: 'picked_up' },
  { o: { status: 'accepted', deliveryStatus: 'driver_assigned' },            want: 'assigned'  },
  { o: { status: 'paid', deliveryStatus: 'in_transit', timelineStage: 'ready' }, want: 'in_transit' },
  { o: { timelineStage: 'received' },                                        want: 'pending'   },
  { o: { status: 'teleported' },                                             want: S.UNKNOWN   },
  { o: {},                                                                   want: S.UNKNOWN   },
];
for (const c of CASES) {
  check('resolveStage ' + JSON.stringify(c.o).slice(0, 52), S.resolveStage(c.o) === c.want, S.resolveStage(c.o));
}
check('resolveStage agrees client/server',
      CASES.every(c => S.resolveStage(c.o) === C.resolveStage(c.o)));
check('a stale field cannot drag an order backwards',
      S.resolveStage({ status: 'pending', timelineStage: 'delivered' }) === 'delivered');

console.log('\n── Stall detection ──');
check('fresh order is not stalled', C.isStalled('pending', Date.now() - 60 * 1000) === false);
check('old pending order is stalled', C.isStalled('pending', Date.now() - 60 * 60 * 1000) === true);
check('unknown stage is never stalled', C.isStalled('teleported', 0) === false);

console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
