#!/usr/bin/env node
/* TECH HUB SLICE 4a — every Tech business id is CLASSIFIABLE (business-category) and CAPABLE (service-capabilities),
 * and capabilities come only from valid approvals, composed per provider.
 *   node scripts/test-tech-taxonomy.js          BASE=13f74f3 node scripts/test-tech-taxonomy.js (must FAIL T1/T3) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tt4-'));
  execSync('git archive ' + process.env.BASE + ' functions/business-category.js functions/healthcare-category.js functions/shared | tar -x -C "' + d.replace(/\\/g, '/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\nTech taxonomy (Tech Hub slice 4a)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

const BC = require(path.join(FN, 'business-category.js'));
const SC = require(path.join(FN, 'shared', 'service-capabilities.js'));

/* The Tech business ids = every id the capability engine maps to a tech or service capability (food excluded). */
const TECH_IDS = Object.keys(SC.FROM_BUSINESS_ID).filter((id) => SC.FROM_BUSINESS_ID[id].some((c) => ['tech', 'service'].includes(SC.CAPABILITIES[c].vertical)));

/* T1 — classifiable: an approved application for each id gets ONE category (else workspaceFor = PENDING_CLASSIFICATION) */
const unclassified = TECH_IDS.map((id) => [id, BC.categoryFromApplication({ category: id, role: 'provider' }, 'provider')]).filter(([, r]) => !r.category);
ck('T1', unclassified.length === 0, 'every Tech business id classifies to a category at approval (no PENDING_CLASSIFICATION dashboard)', unclassified.map(([id, r]) => id + ':' + r.reason));

/* T2 — repair / networking / POS support are SERVICES, never the goods-selling `electronics` merchant category */
const svc = ['laptop-repair', 'computer-repair', 'electronics-repair', 'networking', 'pos-support'].map((id) => [id, BC.categoryFromApplication({ category: id, role: 'provider' }, 'provider').category]);
ck('T2', svc.every(([, c]) => c === 'it_services') && !BC.SELLER_CATEGORIES.includes('it_services'),
  'laptop / computer / electronics repair, networking and POS support → it_services (a service, not a merchant-v2 seller)', svc);

/* T3 — electrical keeps its trades category and now carries service-mode capabilities (no invented trade capability) */
const el = BC.categoryFromApplication({ category: 'electrical', role: 'provider' }, 'provider').category;
const elCaps = SC.FROM_BUSINESS_ID.electrical || [];
ck('T3', el === 'trades' && ['FIELD_SERVICE', 'ONSITE_SUPPORT', 'QUOTE_REQUEST', 'DIRECT_BOOKING'].every((c) => elCaps.includes(c)) && elCaps.every((c) => SC.CAPABILITIES[c].vertical === 'service'),
  'electrical → trades with service-mode capabilities only', { el, elCaps });

/* T4 — composition across approvals (A only, B only, A+B, A+B+C, pending A + approved B) */
const ap = (id, category, valid) => ({ id, app: { category }, valid, why: valid ? undefined : 'not_approved' });
const A = 'phone-repair', B = 'laptop-repair', C = 'it-support';
const caps = (list) => SC.compose(list).capabilities;
const rows = {
  A: caps([ap('a', A, true)]),
  B: caps([ap('b', B, true)]),
  AB: caps([ap('a', A, true), ap('b', B, true)]),
  ABC: caps([ap('a', A, true), ap('b', B, true), ap('c', C, true)]),
  pendA_B: caps([ap('a', 'cctv', false), ap('b', B, true)]),
};
ck('T4a', rows.A.includes('DEVICE_REPAIR') && !rows.A.includes('IT_SUPPORT'), 'A only → A\'s capabilities', rows.A);
ck('T4b', rows.AB.join() === [...new Set(rows.A.concat(rows.B))].sort().join(), 'A + B → the union, nothing overwritten', rows.AB);
ck('T4c', rows.ABC.includes('IT_SUPPORT') && rows.ABC.includes('DEVICE_REPAIR') && rows.ABC.includes('REMOTE_SUPPORT'), 'A + B + C → one set with all three', rows.ABC);
ck('T4d', !rows.pendA_B.includes('CCTV_SECURITY') && rows.pendA_B.includes('DEVICE_REPAIR'), 'a PENDING approval grants nothing; the approved one still counts', rows.pendA_B);

/* T5 — a browser-chosen category string that is not a business id grants nothing */
ck('T5', caps([{ id: 'x', app: { category: 'Network Engineer' }, valid: true }]).length === 0 && caps([{ id: 'y', app: { category: 'networking' }, valid: false }]).length === 0,
  'a free-text label or an unapproved id grants no capability');

console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
