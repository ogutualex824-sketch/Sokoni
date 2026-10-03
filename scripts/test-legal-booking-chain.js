#!/usr/bin/env node
/* LEGAL HUB L4 — a Legal consultation is a CANONICAL provider booking, end to end on the server, in-process:
 *   register → AdminOS approve → LSK verified (Mode B) → projection opens providers/{uid} + legal_consult rate card
 *   → bookingCreateService (server price) → [paid_held: FIXTURE of the verified IntaSend webhook's effect]
 *   → settleOnPinRelease → ONE commission (5%) → provider wallet net → second release is a no-op
 *   → AdminOS suspend closes booking; retired bookLegalConsultation writes nothing; fee edit re-prices the rate card.
 *   node scripts/test-legal-booking-chain.js        BASE=<ref> (pre-L4 must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const ROOT = path.join(__dirname, '..');
let FN = process.env.FN_DIR || path.join(ROOT, 'functions');
if (process.env.BASE) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'lgb-'));
  cp.execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.split(path.sep).join('/') + '"', { cwd: ROOT, shell: 'bash' });
  FN = path.join(d, 'functions');
}
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 320) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
const run = (exp) => (r) => exp.run(r);
const tomorrow = () => new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
console.log('\nLegal Hub L4 — Legal consultation on the canonical booking + settlement rails   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');

(async () => {
  const LH = require(path.join(FN, 'legal-hub.js'));
  const LV = require(path.join(FN, 'legal-verification.js'));
  const BS = require(path.join(FN, 'booking-service.js'))._h;
  const PO = require(path.join(FN, 'provider-ops.js'));
  H.reset();
  DOCS.set('users/cust', { displayName: 'Client' });
  DOCS.set('users/adv', { displayName: 'Wanjiru Kamau' });
  DOCS.set('providerAvailability/adv', { modes: ['open_24_7'], appt: {} });

  let r = await call(run(LH.registerLegalProvider), 'adv', { name: 'Wanjiru Kamau', licenseNumber: 'P.105/1234/15', practiceAreas: ['family-law'], consultationFee: 5000, county: 'Nairobi' });
  ck('C0', !!r.ok, 'advocate registers (pending review)', r);

  await LV.applyAdminDecision(H.db, { uid: 'adv', app: DOCS.get('applications/legal_adv'), appId: 'legal_adv', status: 'approved', decidedBy: 'admin1' });
  const prov1 = DOCS.get('providers/adv') || {};
  const b0 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '10:00', idempotencyKey: 'k0' });
  ck('C1', prov1.acceptsBookings === false && prov1.searchable === false && b0.code === 'failed-precondition' && !Object.keys(Object.fromEntries(DOCS)).some((k) => k.startsWith('providerBookings/')),
    'admin approval ALONE does not open booking (LSK pending): identity linked but closed, booking refused, nothing written', { prov1, b0: b0.code });

  r = await call(LV._adminH.legalAdminRecordLsk, 'admin1', { uid: 'adv', p105Number: 'P.105/1234/15', practiceStatus: 'Active', verifiedName: 'Wanjiru Kamau', evidenceRef: 'LSK search screenshot #1', checkedAt: Date.now() - 3600000 }, { admin: true });
  const prov2 = DOCS.get('providers/adv') || {}, svc = DOCS.get('providerServices/legal_consult_adv') || {};
  const BCAT = require(path.join(FN, 'business-category.js'));
  const pe2 = BCAT.publicEligibility(DOCS.get('providers/adv'));
  ck('C2', !!r.ok && prov2.acceptsBookings === true && prov2.searchable === true && prov2.status === 'active' && svc.active === true && svc.price === 500000 && svc.priceType === 'fixed',
    'admin approval + current LSK Active → providers/{uid} bookable & discoverable; consultation rate card active at the advocate fee (KES 5,000 = 500000 cents)', { r: r.code || 'ok', prov2, svc });

  const bk = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '10:00', idempotencyKey: 'k1', price: 100, amount: 100, totalCents: 100 });
  const bid = bk.ok && (bk.ok.bookingId || bk.ok.id);
  const B = bid ? DOCS.get('providerBookings/' + bid) : null;
  ck('C3', !!B && B.providerId === 'adv' && B.customerUid === 'cust' && Number(B.price) === 500000 && B.paymentStatus !== 'paid_held' && B.paymentStatus !== 'paid',
    'client books via bookingCreateService: providerBookings row at the SERVER price (client price 100 ignored), not paid', { bk, B });

  /* FIXTURE: the verified IntaSend webhook's effect on a service_booking (createPaymentIntent → webhook → paid_held). The
     webhook/intent path itself is certified by the payment suites (2f), not here. */
  if (!bid) { ck('C4', false, 'no booking to settle (C3 failed) — fail closed'); return done(); }
  DOCS.set('providerBookings/' + bid, Object.assign({}, DOCS.get('providerBookings/' + bid), { paymentStatus: 'paid_held', status: 'confirmed' }));
  const s1 = await PO.settleOnPinRelease(bid, 'cust');
  const B2 = DOCS.get('providerBookings/' + bid);
  const wtx = [...DOCS.keys()].filter((k) => /^walletTransactions\//.test(k)).map((k) => DOCS.get(k)).filter((t) => JSON.stringify(t).includes(bid));
  const PAY = DOCS.get('providerPayouts/' + bid) || {}, W = DOCS.get('wallets/adv') || {};
  ck('C4', s1 && s1.credited === 4750 && B2.status === 'completed' && B2.paymentStatus === 'settled' && PAY.gross === 500000 && PAY.commission === 25000 && PAY.net === 475000 && W.balance === 4750 && wtx.length === 1,
    'PIN release settles ONCE through the shared pipeline: KES 5,000 → SOKONI 5% = 250 → provider 4,750 net: payout record gross/commission/net in cents, provider wallet +KES 4,750, one wallet transaction, booking settled', { s1, PAY, W, B2: { status: B2.status, paymentStatus: B2.paymentStatus }, wtx: wtx.length });
  const s2 = await PO.settleOnPinRelease(bid, 'cust');
  ck('C5', s2 && s2.skipped && s2.credited === undefined, 'a second PIN release is a no-op — no double commission, no double credit', s2);

  /* C10 — Legal rate cards name a taxonomy practice area; only a server-classified lawyer may set one (L6) */
  /* fixture: an unlimited plan — the free plan's 1 active service is already the auto consultation card (OPEN owner decision, docs) */
  DOCS.set('providerSubscriptions/adv', { limits: { listings: -1 } }); DOCS.set('providerSubscriptions/plumb', { limits: { listings: -1 } });
  DOCS.set('providers/plumb', { status: 'active', category: 'plumbing', business: { category: 'plumbing', source: 'application' } });
  const sA = await call(PO._h.providerAddService, 'adv', { name: 'Term sheet review', price: 1500000, priceType: 'fixed', durationMins: 90, legalArea: 'term-sheets' });
  const sB = await call(PO._h.providerAddService, 'adv', { name: 'Bogus', price: 1000, legalArea: 'astrology' });
  const before = [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).length;
  const sC = await call(PO._h.providerAddService, 'plumb', { name: 'Pipe law', price: 1000, legalArea: 'mediation' });
  const after = [...DOCS.keys()].filter((k) => k.startsWith('providerServices/')).length;
  const newSvc = sA.ok && DOCS.get('providerServices/' + sA.ok.serviceId);
  const sD = sA.ok ? await call(PO._h.providerUpdateService, 'adv', { serviceId: sA.ok.serviceId, legalArea: null }) : { code: 'skip' };
  ck('C10', !!newSvc && newSvc.legalArea === 'term-sheets' && sB.det && sB.det.code === 'LEGAL_AREA_UNKNOWN'
    && sC.det && sC.det.code === 'LEGAL_AREA_NOT_LEGAL_PROVIDER' && before === after && !!sD.ok && DOCS.get('providerServices/' + sA.ok.serviceId).legalArea === undefined,
    'Legal rate card carries a taxonomy practice area; unknown area refused; a non-Legal provider cannot claim one (nothing written); null clears it', { sA, sB: sB.det, sC: sC.det, sD });
  /* C11 — a specialist area on a rate card only once SOKONI confirmed it (owner 10-03) */
  await call(require(path.join(FN, 'legal-dispatch.js')).legalDispatch.run.bind(null), 'adv', { op: 'legalUpdateProfile', specialistAreas: ['tax-law'] });
  const t1 = await call(PO._h.providerAddService, 'adv', { name: 'Tax dispute', price: 800000, priceType: 'fixed', legalArea: 'tax-law' });
  await call(LV._adminH.legalAdminConfirmSpecialist, 'admin1', { uid: 'adv', area: 'tax-law', confirm: true, reason: 'Verified tax practice' }, { admin: true });
  const t2 = await call(PO._h.providerAddService, 'adv', { name: 'Tax dispute', price: 800000, priceType: 'fixed', legalArea: 'tax-law' });
  ck('C11', t1.det && t1.det.code === 'LEGAL_SPECIALIST_NOT_CONFIRMED' && !!t2.ok && DOCS.get('providerServices/' + t2.ok.serviceId).legalArea === 'tax-law',
    'a specialist practice area (tax) is refused on a rate card until AdminOS confirms it, then allowed', { t1: t1.det, t2 });
  r = await call(run(LH.bookLegalConsultation), 'cust', { providerId: 'adv', dateTime: new Date(Date.now() + 86400000).toISOString(), matter: 'x', idempotencyKey: 'old1' });
  ck('C6', r.code === 'failed-precondition' && r.det && r.det.code === 'LEGAL_BOOKING_MOVED' && ![...DOCS.keys()].some((k) => k.startsWith('legalConsultations/')),
    'the retired Legal-only booking engine refuses and writes nothing (no legalConsultations, no money-less "booking")', r);

  r = await call(run(LH.registerLegalProvider), 'adv', {});
  const up = await call(require(path.join(FN, 'legal-dispatch.js')).legalDispatch.run.bind(null), 'adv', { op: 'legalUpdateProfile', consultationFee: 6000 });
  ck('C7', !!up.ok && DOCS.get('providerServices/legal_consult_adv').price === 600000 && DOCS.get('providerServices/legal_consult_adv').active === true,
    'advocate changes the fee → the consultation rate card is re-priced server-side (KES 6,000)', up);

  await LV.applyAdminDecision(H.db, { uid: 'adv', app: DOCS.get('applications/legal_adv'), appId: 'legal_adv_s', status: 'suspended', decidedBy: 'admin1' });
  const prov3 = DOCS.get('providers/adv') || {}, svc3 = DOCS.get('providerServices/legal_consult_adv') || {};
  const b3 = await call(BS.bookingCreateService, 'cust', { providerId: 'adv', serviceId: 'legal_consult_adv', date: tomorrow(), startTime: '12:00', idempotencyKey: 'k3' });
  ck('C8', prov3.acceptsBookings === false && prov3.searchable === false && svc3.active === false && b3.code === 'failed-precondition',
    'AdminOS suspension re-projects: not bookable, not discoverable, rate card off, new booking refused', { prov3, svc3: svc3.active, b3: b3.code });
  const pe3 = BCAT.publicEligibility(DOCS.get('providers/adv'));
  ck('C9', pe2.eligible === true && pe2.category === 'lawyer' && pe3.eligible === false && pe3.reasons.includes('SUSPENDED'),
    'search: the eligible lawyer is publicly discoverable through the canonical providers gate (C1 category lawyer); suspension removes it (owner 09-28: legacy lawyers registry stays de-indexed)', { pe2, pe3 });
  done();
})().catch((e) => { console.log('CRASH (fail closed): ' + (e && e.stack || e)); process.exit(2); });
function done() {
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  console.log('NOT proven here: createPaymentIntent(service_booking) + IntaSend webhook for a Legal booking (fixture above); rules/emulator; browser.');
  process.exit(fail ? 1 : 0);
}
