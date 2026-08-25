#!/usr/bin/env node
/* Marketplace commission = 5%, and no merchant is approved onto it unseen.
 *
 * TWO THINGS ARE BEING PROVED, and they are different in kind.
 *
 * 1. THE RATE. 5% is now the marketplace rate BY INTENT. Before this change the
 *    live rate was already 5% — but only because checkout and the IntaSend
 *    webhook send category "product", which matched nothing and fell through to
 *    RATES.default. A test that merely asserted "product costs 5%" would have
 *    PASSED against the accidental version. So the suite asserts the resolved
 *    CATEGORY as well as the number: "product" must resolve to `marketplace`,
 *    not to `default`. That is the difference between deliberate and incidental.
 *
 * 2. THE GATE. applicationDecide must refuse to approve an application that
 *    carries no acknowledgement — and must still allow reject/suspend/
 *    request_info, or a reviewer could not clear the applications it holds back.
 *
 * Both are read from the SHIPPED source, not from copies.
 *
 *   node scripts/test-commission-5pct-agreement.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ck = (label, ok, detail) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (detail ? '   [' + detail + ']' : ''));
  ok ? pass++ : fail++;
};

const ROOT = path.join(__dirname, '..');
const CC   = require(path.join(ROOT, 'functions', 'commission-config.js'));

/* ── 1. The rate, and that it is deliberate ─────────────────────────────── */
console.log('\nA. Marketplace rate = 5%, by intent\n');
{
  const m = CC.resolveRate('marketplace');
  ck('marketplace resolves to 5%', m.pct === 5, m.pct + '%');
  ck('  ...and matches a real category (not the default bucket)',
     m.matched === true && m.category === 'marketplace', m.category);
}
for (const alias of ['product', 'products', 'pos', 'shopping', 'b2b']) {
  const r = CC.resolveRate(alias);
  ck(`"${alias}" -> marketplace @ 5%`,
     r.pct === 5 && r.category === 'marketplace' && r.matched === true,
     r.pct + '% ' + r.category);
}
{
  /* The regression this guards. "product" is what checkout.html and the IntaSend
     webhook actually send; if it ever falls back to `default` again the rate
     survives by luck and breaks the moment `default` moves. */
  const p = CC.resolveRate('product');
  ck('"product" is NOT resolving via the default bucket', p.category !== 'default', p.category);
}

/* ── 2. Unrelated categories untouched ──────────────────────────────────── */
console.log('\nB. Unrelated categories unchanged\n');
const EXPECTED = {
  food_delivery: 5, property: 2, vehicles: 0, healthcare: 5, legal: 5, events: 5,
  hotel: 5, digital_products: 10, event_tickets: 3, ppv: 15, services: 15,
  education: 15, jobs: 15, classifieds: 8, hub: 12, subscriptions: 100,
  advertising: 100, saas: 0,
};
let drift = [];
for (const [k, want] of Object.entries(EXPECTED)) {
  const got = CC.resolveRate(k).pct;
  if (got !== want) drift.push(`${k}: ${want}% -> ${got}%`);
}
ck('all 18 unrelated category rates are exactly as before', drift.length === 0, drift.join('; ') || 'no drift');
ck('vehicles keeps its flat fee (KES 2000, 0%)', CC.resolveRate('vehicles').fixedKES === 2000);
ck('event_tickets stays 3% (NOT swept up by the marketplace change)', CC.resolveRate('event_tickets').pct === 3);

/* ── 3. The KES 10 minimum ──────────────────────────────────────────────── */
console.log('\nC. Minimum commission — the reason "flat 5%" would be a lie\n');
{
  ck('MIN_COMMISSION_KES is 10', CC.MIN_COMMISSION_KES === 10);
  const raw = (amt) => amt * CC.resolveRate('marketplace').pct / 100;
  const eff = (amt) => Math.max(raw(amt), CC.MIN_COMMISSION_KES);
  ck('KES 97 sale -> KES 10 charged, not 4.85', eff(97) === 10, '5% would be ' + raw(97).toFixed(2));
  ck('  ...which is 10.3%, so copy saying a flat 5% is wrong below ~KES 200',
     +(eff(97) / 97 * 100).toFixed(1) === 10.3);
  ck('KES 1000 sale -> KES 50 (the minimum does not bite)', eff(1000) === 50);
  ck('KES 200 sale -> KES 10 (the crossover)', eff(200) === 10 && raw(200) === 10);
}

/* ── 4. Seller-facing text discloses BOTH the rate and the minimum ──────── */
console.log('\nD. Disclosure — every seller-facing surface\n');
for (const f of ['legal.html', 'seller-terms.html', 'seller.html', 'hub-register.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ck(f + ' states 5%', /5%\s*commission|commission[^.]{0,40}5%|5% per-sale|5% per completed/i.test(src));
  ck('  ...and discloses the KES 10 minimum', /minimum commission of KES 10|min KES 10|minimum of KES 10/i.test(src));
  ck('  ...and does NOT claim commission is deducted from the payment',
     !/deducted (from the buyer|automatically before payout)/i.test(src));
}
{
  const legal = fs.readFileSync(path.join(ROOT, 'legal.html'), 'utf8');
  ck('legal.html no longer advertises the old 12% / 88% split',
     !/12% commission/.test(legal) && !/88% of every sale/.test(legal));
}

/* ── 5. Generated snapshot is in sync, not hand-edited ──────────────────── */
console.log('\nE. Generated client snapshot\n');
{
  const snap = fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
  ck('snapshot carries marketplace 5%', /"marketplace":\s*\{\s*"pct":\s*5/.test(snap));
  ck('snapshot carries the product -> marketplace alias', /"product":\s*"marketplace"/.test(snap));
  ck('snapshot still declares itself generated', /GENERATED FILE\. DO NOT EDIT/.test(snap));
}

/* ── 6. The approval gate ───────────────────────────────────────────────── */
console.log('\nF. Approval gate — server-side, in applicationDecide\n');
const LIFECYCLE = fs.readFileSync(path.join(ROOT, 'functions', 'application-lifecycle.js'), 'utf8');
{
  ck('approve is gated on agreementAccepted === true',
     /if \(decision === 'approve'\)[\s\S]{0,400}?agreementAccepted !== true[\s\S]{0,300}?HttpsError/.test(LIFECYCLE));
  ck('  ...and the gate is ONLY on approve (reject/suspend/request_info still work)',
     /if \(decision === 'approve'\) \{/.test(LIFECYCLE)
     && !/agreementAccepted !== true[\s\S]{0,200}?decision === 'reject'/.test(LIFECYCLE));
  ck('  ...raising failed-precondition, not a generic error',
     /'failed-precondition',\s*\n?\s*'This application cannot be approved/.test(LIFECYCLE));
  ck('approval stamps a SERVER timestamp for the acknowledgement',
     /agreementVerifiedAt:\s+_ts\(\)/.test(LIFECYCLE));
  ck('  ...and records WHICH version was accepted',
     /agreementVerifiedVersion:/.test(LIFECYCLE));
}
{
  /* Negative control. If these detectors cannot fail, they are not evidence. */
  const broken = LIFECYCLE
    .replace(/if \(decision === 'approve'\) \{[\s\S]*?\n    \}\n/, '')
    .replace(/agreementVerifiedAt:\s+_ts\(\),/, '');
  ck('negative control: detectors FAIL against un-gated source',
     !/agreementAccepted !== true/.test(broken) && !/agreementVerifiedAt:\s+_ts\(\)/.test(broken));
}

/* ── 7. The client records the acknowledgement it claims to ─────────────── */
console.log('\nG. Application document carries the acknowledgement\n');
{
  const hr = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
  ck('writes agreementAccepted', /agreementAccepted:\s+true/.test(hr));
  ck('writes agreementVersion', /agreementVersion:\s+AGREEMENT_VERSION/.test(hr));
  ck('writes agreementAcceptedAt', /agreementAcceptedAt:/.test(hr));
  ck('submit is blocked without the checkbox (re-checked, not just disabled)',
     /agreeEl\.checked[\s\S]{0,200}?return;/.test(hr));
  ck('submit button ships disabled', /id="sreg_submit" disabled/.test(hr));
  ck('agreement version is a dated string, not a bare true',
     /AGREEMENT_VERSION = '20\d\d-\d\d-\d\d/.test(hr));
}
{
  const sj = fs.readFileSync(path.join(ROOT, 'seller.js'), 'utf8');
  ck('seller.js verification also gates on the checkbox',
     /agree\.checked[\s\S]{0,200}?return;/.test(sj));
  ck('seller.js agreement version matches hub-register',
     /SELLER_AGREEMENT_VERSION = "2026-08-25-commission-5pct"/.test(sj));
  const hr = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
  const a = (sj.match(/SELLER_AGREEMENT_VERSION = "([^"]+)"/) || [])[1];
  const b = (hr.match(/AGREEMENT_VERSION = '([^']+)'/) || [])[1];
  ck('  ...verified equal, so one acknowledgement means one text', a === b, a + ' vs ' + b);
  ck('seller.js states plainly that this screen is client-only',
     /THIS SCREEN IS CLIENT-ONLY/.test(sj));
}

/* ── 8. Historical ledger records are not recomputed ────────────────────── */
console.log('\nH. Historical records\n');
{
  const idx = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  ck('commissionLedger stores commissionPct at write time', /commissionPct:\s*pct,/.test(idx));
  ck('  ...under a deterministic id (one entry per payment, no duplicates)',
     /commissionLedger"\)\.doc\(paymentId\)/.test(idx));
  ck('nothing re-derives a rate from the table for an existing ledger row',
     !/commissionLedger[\s\S]{0,400}?resolveRate/.test(idx));
}

console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
