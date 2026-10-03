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
/* SUPERSEDED 2026-09-28: the owner-confirmed schedule makes online product sales 15% and gives POS / Till / Quick
   Charge its OWN 5% key (it no longer rides the marketplace alias). The full schedule is specified in
   scripts/test-commission-schedule.js; this suite keeps its original purpose — the rates are deliberate, real
   categories, the minimum is disclosed — against the new schedule. */
console.log('\nA. Online sales rate = 15%, by intent (owner schedule 2026-09-28)\n');
{
  const m = CC.resolveRate('marketplace');
  ck('marketplace resolves to 15%', m.pct === 15, m.pct + '%');
  ck('  ...and matches a real category (not the default bucket)',
     m.matched === true && m.category === 'marketplace', m.category);
}
/* 'b2b' → b2b_order 0% since 2026-10-03 (owner: lead fee, no % on wholesale orders) — asserted below and in test-b2b-lead-fee.js. */
{
  const r = CC.resolveRate('b2b');
  ck('"b2b" -> b2b_order @ 0% (lead model, never the marketplace rate)', r.pct === 0 && r.category === 'b2b_order' && r.matched === true, r.pct + '% ' + r.category);
}
for (const alias of ['product', 'products', 'shopping']) {
  const r = CC.resolveRate(alias);
  ck(`"${alias}" -> marketplace @ 15%`,
     r.pct === 15 && r.category === 'marketplace' && r.matched === true,
     r.pct + '% ' + r.category);
}
{
  const r = CC.resolveRate('pos');
  ck('"pos" -> its OWN pos category @ 5% (never the online rate)', r.pct === 5 && r.category === 'pos' && r.matched === true, r.pct + '% ' + r.category);
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
const EXPECTED = {   /* owner schedule 2026-09-28 (jobs/classifieds/ppv/advertising/saas unchanged;
                        property -> KES 5,000 flat and hub -> 17% floor of the 17-25% delivery share were
                        reconciled to the owner's table on 2026-09-30 - docs/COMMERCIAL_CONVERGENCE_2026-09-30.md) */
  /* owner 2026-10-03: healthcare bookings 12 -> 5 (every service booking 5%); vehicles KES 2,000 flat -> 2% of the sale price */
  food_delivery: 15, property: 0, vehicles: 2, healthcare: 5, legal: 5, events: 5,
  hotel: 15, digital_products: 10, event_tickets: 5, ppv: 15, services: 5,
  education: 5, jobs: 0, classifieds: 8, hub: 17, subscriptions: 100,
  advertising: 100, saas: 0,
};
let drift = [];
for (const [k, want] of Object.entries(EXPECTED)) {
  const got = CC.resolveRate(k).pct;
  if (got !== want) drift.push(`${k}: ${want}% -> ${got}%`);
}
ck('all 18 other category rates match the owner schedule (2026-09-28, as amended 2026-10-03)', drift.length === 0, drift.join('; ') || 'no drift');
ck('vehicles is 2% of the sale price with NO flat fee (owner 2026-10-03; was KES 2,000 flat)', CC.resolveRate('vehicles').pct === 2 && CC.resolveRate('vehicles').fixedKES === 0);
ck('property is a flat KES 5,000 (owner schedule 2026-09-28; was 2%)', CC.resolveRate('property').fixedKES === 5000 && CC.resolveRate('property').pct === 0);
ck('hub/delivery floor equals delivery-quote-authority.SHARE_MIN_PCT', CC.resolveRate('delivery').pct === require(path.join(ROOT, 'functions', 'delivery-quote-authority')).SHARE_MIN_PCT);
ck('event_tickets is 5% (owner schedule 2026-09-28; was 3%)', CC.resolveRate('event_tickets').pct === 5);

/* ── 3. The KES 10 minimum ──────────────────────────────────────────────── */
console.log('\nC. Minimum commission — the reason "flat 5%" would be a lie (on the 5% POS / Till lane)\n');
{
  ck('MIN_COMMISSION_KES is 10', CC.MIN_COMMISSION_KES === 10);
  const raw = (amt) => amt * CC.resolveRate('pos').pct / 100;
  const eff = (amt) => Math.max(raw(amt), CC.MIN_COMMISSION_KES);
  ck('KES 97 sale -> KES 10 charged, not 4.85', eff(97) === 10, '5% would be ' + raw(97).toFixed(2));
  ck('  ...which is 10.3%, so copy saying a flat 5% is wrong below ~KES 200',
     +(eff(97) / 97 * 100).toFixed(1) === 10.3);
  ck('KES 1000 sale -> KES 50 (the minimum does not bite)', eff(1000) === 50);
  ck('KES 200 sale -> KES 10 (the crossover)', eff(200) === 10 && raw(200) === 10);
  const rawOnline = (amt) => amt * CC.resolveRate('marketplace').pct / 100;
  ck('online: KES 1000 order -> KES 150 at 15%', Math.max(rawOnline(1000), CC.MIN_COMMISSION_KES) === 150);
  ck('online: the KES 10 minimum only bites below ~KES 67', Math.max(rawOnline(60), CC.MIN_COMMISSION_KES) === 10 && rawOnline(70) > 10);
}

/* ── 4. Seller-facing text discloses BOTH LANES and the minimum ─────────── */
/* The commercial rule changed on 2026-09-07 from one flat 5% to two lanes:
   MARKETPLACE orders are priced by the seller's plan (15/10/5/0) and POS/TILL
   sales are a flat 5%. A disclosure that still says only "5% per sale" is now
   INACCURATE for a Free seller by a factor of three, so each surface must state
   both lanes — and must not be allowed to satisfy this check by mentioning 5%
   alone, which every one of them already did under the old rule. */
console.log('\nD. Disclosure — every seller-facing surface states BOTH lanes\n');
for (const f of ['legal.html', 'seller-terms.html', 'seller.html', 'hub-register.js']) {
  const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
  ck(f + ' discloses the MARKETPLACE plan ladder',
     /marketplace[\s\S]{0,400}?(plan|Free)[\s\S]{0,400}?15%|Free\s*1?5?%?[\s\S]{0,80}?15%/i.test(src)
     || /marketplacePct/.test(src));
  ck('  ...and the flat POS / Till rate',
     /(POS|Till)[\s\S]{0,300}?5%/i.test(src) || /posPct/.test(src));
  ck('  ...and discloses the KES 10 minimum',
     /minimum commission of KES 10|min KES 10|minimum of KES 10|minimum commission of KES '/i.test(src)
     || /MIN_COMMISSION_KES/.test(src));
  ck('  ...and does NOT claim commission is deducted from the payment',
     !/deducted (from the buyer|automatically before payout)/i.test(src));
}
{
  const legal = fs.readFileSync(path.join(ROOT, 'legal.html'), 'utf8');
  /* was /12% commission/ — which never matched the page's actual wording ("12% platform fee … you keep 88%") */
  ck('legal.html no longer advertises the old 12% / 88% split',
     !/12% (commission|platform fee)/.test(legal) && !/(keep|of every sale)[^<]{0,20}88%|88%[^<]{0,20}(of every sale)/.test(legal) && !/you keep 88%/.test(legal));
}

/* ── 5. Generated snapshot is in sync, not hand-edited ──────────────────── */
console.log('\nE. Generated client snapshot\n');
{
  const snap = fs.readFileSync(path.join(ROOT, 'sokoni-commission-rates.js'), 'utf8');
  ck('snapshot carries marketplace 15%', /"marketplace":\s*\{\s*"pct":\s*15/.test(snap));
  ck('snapshot carries the product -> marketplace alias', /"product":\s*"marketplace"/.test(snap));
  ck('snapshot still declares itself generated', /GENERATED FILE\. DO NOT EDIT/.test(snap));
}

/* ── 6. The approval gate ───────────────────────────────────────────────── */
console.log('\nF. Approval gate — server-side, in applicationDecide\n');
const LIFECYCLE = fs.readFileSync(path.join(ROOT, 'functions', 'application-lifecycle.js'), 'utf8');
{
  /* SCOPED BY STRUCTURE, NOT DISTANCE. This used to span the two anchors with
     `[\s\S]{0,400}?`. When the healthcare branch was added to the same block
     (2026-09-13 — healthcare is gated on canonical legalAcceptances, not on this
     boolean) the gate moved ~1,900 characters further down and the detector went
     red while the thing it tests was still true. A window measured in characters
     rots on the next edit; extract the block the same way the negative control
     below already does, and assert inside it. */
  const approveBlock = (LIFECYCLE.match(/if \(decision === 'approve'\) \{[\s\S]*?\n    \}\n/) || [''])[0];
  ck('the approve block is still extractable (guards the two checks below)',
     approveBlock.length > 0);
  ck('approve is gated on agreementAccepted === true',
     /agreementAccepted !== true/.test(approveBlock) && /HttpsError/.test(approveBlock));
  ck('  ...and healthcare is gated on the CANONICAL record instead of that boolean',
     /_role === 'health'/.test(approveBlock) && /complianceFor/.test(approveBlock));
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
  /* DERIVED, never pinned. This used to assert a literal version string, so every
     terms change required editing the test — and the day someone forgot, the suite
     would certify a version that no longer shipped. What matters is not WHICH
     string it is, but that it is a dated version and that all THREE surfaces carry
     the same one: one acknowledgement must mean one text. */
  ck('seller.js carries a dated agreement version',
     /SELLER_AGREEMENT_VERSION = "20\d\d-\d\d-\d\d[^"]*"/.test(sj),
     (sj.match(/SELLER_AGREEMENT_VERSION = "([^"]+)"/) || [])[1]);
  const hr = fs.readFileSync(path.join(ROOT, 'hub-register.js'), 'utf8');
  const a = (sj.match(/SELLER_AGREEMENT_VERSION = "([^"]+)"/) || [])[1];
  const b = (hr.match(/AGREEMENT_VERSION = '([^']+)'/) || [])[1];
  ck('  ...verified equal, so one acknowledgement means one text', a === b, a + ' vs ' + b);
  /* THREE surfaces write this acknowledgement, not two. sokoni-merchant-application.js
     (the 2A intake) was added later and was missed by the original pair-check — which is
     exactly how two of three drift apart while a green suite reports agreement. */
  const ma = fs.readFileSync(path.join(ROOT, 'sokoni-merchant-application.js'), 'utf8');
  const c = (ma.match(/AGREEMENT_VERSION = '([^']+)'/) || [])[1];
  ck('  ...and sokoni-merchant-application.js carries the SAME version',
     c === b && !!c, c + ' vs ' + b);
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
