#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MERCHANT ACTION CHIPS — declared by the shell, rendered by the surface owner
   ------------------------------------------------------------------------------
   sokoni-merchant-routes.js now declares every contextual chip bar in /merchant.
   validate() proves the declaration is well-formed. It CANNOT prove the other half:
   that a bar marked `live` is bound to a handler that actually exists in the file
   that renders it. This gate closes that half by reading the owning surface.

   The rule being enforced, in one line:

       A CHIP IS BOUND TO A REAL HANDLER, OR IT IS NOT ON SCREEN.

   Both failure directions are covered:
     · live bar whose handler was renamed/deleted  → a dead control in a shop  → FAIL
     · planned bar whose handler leaked into a renderer → a button that ships
       before its capability exists                                            → FAIL

   Section 4 runs NEGATIVE CONTROLS: deliberately malformed declarations that the
   detector MUST reject. Without them a validator that silently returns [] would
   report a perfect score, which is how a gate becomes decorative.

     node scripts/test-merchant-actions.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let pass = 0, fail = 0;
const failures = [];
const ok = (label, cond, detail) => {
  if (cond) { pass++; console.log('  PASS  ' + label); return true; }
  fail++; failures.push(label + (detail ? '  → ' + detail : ''));
  console.log('  FAIL  ' + label + (detail ? '   → ' + detail : ''));
  return false;
};

/* The registry is a browser global module; load it the way merchant.html would. */
global.window = {};
require(path.join(ROOT, 'sokoni-merchant-routes.js'));
const R = global.window.SokoniMerchantRoutes;

/* Which file renders which owner's chips. A live handler is proven to exist HERE and
   nowhere else — grepping the whole repo would happily match an unrelated definition
   in a file the merchant never loads. */
const OWNER_FILES = {
  native: ['merchant.html'],
  seller: ['seller.html', 'seller.js'],
  pos:    ['pos.html']
};

const srcCache = {};
const readOwner = (owner) => {
  if (srcCache[owner]) return srcCache[owner];
  const parts = OWNER_FILES[owner].map((f) => {
    const p = path.join(ROOT, f);
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  });
  return (srcCache[owner] = parts.join('\n'));
};

/* A handler is "defined" if the owning surface assigns it as a global or declares it as
   a function. Matching the assignment rather than any mention is deliberate: an onclick
   string that CALLS __ordTab does not prove __ordTab exists. */
const definesHandler = (src, h) => {
  const n = h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(?:window\\s*\\.\\s*' + n + '\\s*=|function\\s+' + n + '\\b|var\\s+' + n + '\\s*=|' + n + '\\s*:\\s*function)').test(src);
};

console.log('\n' + '='.repeat(74));
console.log('  MERCHANT ACTION CHIPS');
console.log('='.repeat(74));

/* ── 1. The declaration itself ─────────────────────────────────────────────── */
console.log('\n1. CONTRACT');
const errs = R.validate();
ok('registry contract holds', errs.length === 0, errs.join(' | '));
ok('ACTIONS is exported', !!R.ACTIONS && typeof R.actions === 'function');

/* ── 2. Live bars are really bound ─────────────────────────────────────────── */
console.log('\n2. LIVE BARS ARE BOUND TO A REAL HANDLER');
let liveBars = 0;
Object.keys(R.ACTIONS).forEach((routeId) => {
  const a = R.ACTIONS[routeId];
  const src = readOwner(a.owner);
  a.bars.filter((b) => b.status === 'live').forEach((b) => {
    liveBars++;
    const where = OWNER_FILES[a.owner].join(' + ');
    ok(routeId + '/' + b.key + ': ' + b.handler + ' defined in ' + where,
       definesHandler(src, b.handler),
       'declared live but no definition found — this is a dead control');

    /* The chip ids are the arguments the handler is driven with. They are emitted
       dynamically (onclick="__ordTab(' + t[0] + ')"), so the literal call never appears;
       what must appear is the id as a quoted string in the renderer's own table. */
    const missing = b.chips.filter((c) =>
      !new RegExp("['\"]" + c.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "['\"]").test(src));
    ok(routeId + '/' + b.key + ': all ' + b.chips.length + ' chip ids present in renderer',
       missing.length === 0,
       missing.length ? 'not found: ' + missing.map((c) => c.id).join(', ') : '');
  });
});
ok('at least one live bar exists', liveBars > 0, 'nothing is adopted — the registry would be inert');

/* ── 3. Planned bars ship nothing ──────────────────────────────────────────── */
console.log('\n3. PLANNED BARS RENDER NOTHING');
const planned = R.plannedActions();
ok('planned bars are tracked', Array.isArray(planned));
planned.forEach((p) => {
  const bar = R.ACTIONS[p.route].bars.find((b) => b.key === p.bar);
  ok(p.route + '/' + p.bar + ': names no handler',
     !bar.handler, 'a planned bar with a handler is a button that ships early');
});
/* Dashboard Export is the canonical case: no export capability exists anywhere in
   merchant.html, so nothing may render it. If someone builds export, this test tells
   them to flip the status rather than leaving the registry lying. */
ok('dashboard/export is still planned (no export capability exists)',
   R.actions('dashboard', 'live').length === 0,
   'dashboard now claims a live bar — if export was built, that is correct; update this gate');
ok('no live bar is owned by seller or pos yet',
   !Object.keys(R.ACTIONS).some((id) => R.ACTIONS[id].owner !== 'native'
      && R.ACTIONS[id].bars.some((b) => b.status === 'live')),
   'a seller/pos bar went live — prove it renders inside that surface, not as a second shell bar');

/* ── 4. Negative controls — the detector must reject bad declarations ──────── */
console.log('\n4. NEGATIVE CONTROLS (these MUST be rejected)');
/* One pristine snapshot, and every restore installs a FRESH deep copy of it. Restoring
   the snapshot object itself would hand the next mutation a reference into the very
   thing being restored from — the snapshot would drift with each test and the positive
   control below would fail. (It did, which is the whole reason that control is here.) */
const PRISTINE = JSON.parse(JSON.stringify(R.ACTIONS));
const restore = () => {
  const fresh = JSON.parse(JSON.stringify(PRISTINE));
  Object.keys(R.ACTIONS).forEach((k) => delete R.ACTIONS[k]);
  Object.keys(fresh).forEach((k) => { R.ACTIONS[k] = fresh[k]; });
};
const rejects = (label, mutate) => {
  mutate(R.ACTIONS);
  ok(label, R.validate().length > 0, 'validate() accepted it — the gate is decorative');
  restore();
};

rejects('a live bar with no handler is rejected',
  (A) => { A.orders.bars[0].handler = undefined; });
rejects('a planned bar that names a handler is rejected',
  (A) => { A.products.bars[0].handler = '__fakeProductChip'; A.products.bars[0].status = 'planned'; });
rejects('chips on an unregistered route are rejected',
  (A) => { A.notARoute = { owner:'native', bars:[{ key:'x', status:'live', handler:'__x', chips:[{ id:'a', label:'A' }] }] }; });
rejects('an owner that contradicts the route kind is rejected',
  (A) => { A.products.owner = 'native'; });
rejects('two bars sharing one handler are rejected',
  (A) => { A.orders.bars[1].handler = '__ordTab'; });
rejects('a bar with no chips is rejected',
  (A) => { A.payments.bars[0].chips = []; });
rejects('a chip with no label is rejected',
  (A) => { A.payments.bars[0].chips[0] = { id:'payouts' }; });

/* Positive control — after all that mutation the real registry must still be clean,
   proving the restores worked and section 4 did not leave damage behind. */
ok('registry still clean after negative controls', R.validate().length === 0);

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
if (planned.length) {
  console.log('\n  DECLARED, NOT YET RENDERED (' + planned.length + ' bar' + (planned.length === 1 ? '' : 's') + '):');
  planned.forEach((p) => console.log('    · ' + p.route + '/' + p.bar +
    '  [' + p.owner + ']  ' + p.chips.join(', ')));
  console.log('\n  These are tracked gaps, not failures. No chip above is on screen.');
}
if (fail) { console.log('\n  FAILURES:'); failures.forEach((f) => console.log('    ✗ ' + f)); }
console.log('='.repeat(74) + '\n');
process.exit(fail ? 1 : 0);
