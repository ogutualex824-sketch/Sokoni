'use strict';
/**
 * CERTIFICATION — M0-4a: abandoned POS commission payment attempts converge through the ONE confirm authority.
 *
 *   OPEN attempt ─▶ provider status ─▶ judgeEvidence ─▶ exactly one transactional transition
 *   Confirm callable and the scheduled sweep both call confirmAttempt; there is no second settlement path.
 *
 * NOTHING IS SENT. `https.request` is replaced IN-PROCESS by a scripted IntaSend double before any module loads; the
 * suite refuses to run if the double is not the transport in use, and any unscripted request fails the suite. Runs
 * the REAL module (pos-commission-settlement) against the Firestore EMULATOR; every sweep runs at a CONTROLLED time
 * measured from the attempt's own createdAtMs, so the thresholds are tested exactly.
 *
 *   Y   the sweep leaves an attempt alone until it is 10 minutes old
 *   S   an attempt with a provider reference: proven → PAID (debt settled once, claims kept); failed → FAILED
 *       (claims released, debt OUTSTANDING); unproven → NEEDS_REVIEW; still pending → OPEN until the cap,
 *       NEEDS_REVIEW after it; provider silent → the same
 *   E   an attempt with NO reference: provider never called → expired (FAILED, claims released); outcome
 *       unknown or accepted-without-reference → NEEDS_REVIEW (money may be moving)
 *   R   review is transactional: it can never overwrite PAID; an attempt in review is left to M0-5
 *   X   Confirm and the sweep racing on ONE attempt (both reads forced to overlap): one settlement, one winner,
 *       nothing resurrected
 *   B   boundaries: cash attempts untouched; no wallet written; the sweep never opens a payment or sends an STK;
 *       a second run changes nothing; the till gate is still OFF
 *
 * Pointed at the pre-M0-4a tree (REPAIR_ROOT = export of 6d8b0da) there is no sweep and no confirm authority.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const path = require('path');
const EventEmitter = require('events');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-m04a-sweep';
process.env.INTASEND_PRIVATE_KEY = 'test-only-private';
delete process.env.INTASEND_PUBLISHABLE_KEY;
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 280s\n'); process.exit(3); }, 280000);

/* ── the IntaSend double (with an optional barrier on status reads, to force two readers to overlap) ── */
const https = require('https');
const CALLS = [];
const SCRIPT = { stk: [], status: {} };
const BARRIER = { n: 0, arrived: 0, release: null, gate: null };
let UNSCRIPTED = 0;
https.request = function (opts, cb) {
  const req = new EventEmitter(); let body = '';
  req.write = (c) => { body += c; }; req.setTimeout = () => req;
  req.end = () => setImmediate(async () => {
    const call = { host: opts.hostname, path: opts.path, body: body ? JSON.parse(body) : null };
    CALLS.push(call);
    let reply = null;
    if (opts.path === '/api/v1/payment/mpesa-stk-push/') reply = SCRIPT.stk.shift();
    else if (opts.path === '/api/v1/payment/status/') {
      if (BARRIER.n > 0) { BARRIER.arrived++; if (BARRIER.arrived >= BARRIER.n) BARRIER.release(); else await BARRIER.gate; }
      const q = SCRIPT.status[call.body && call.body.invoice_id] || []; reply = q.length > 1 ? q.shift() : q[0];
    }
    if (!reply) { UNSCRIPTED++; req.emit('error', new Error('UNSCRIPTED IntaSend call ' + opts.path)); return; }
    if (reply.throw) { req.emit('error', new Error(reply.throw)); return; }
    if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
    const res = new EventEmitter(); res.statusCode = reply.status;
    cb(res); res.emit('data', JSON.stringify(reply.body || {})); res.emit('end');
  });
  return req;
};
if (require('https').request !== https.request) { console.log('  ✖ SETUP — the IntaSend double is not installed'); process.exit(2); }
const armBarrier = (n) => { BARRIER.n = n; BARRIER.arrived = 0; BARRIER.gate = new Promise((r) => { BARRIER.release = r; }); };
const disarmBarrier = () => { BARRIER.n = 0; if (BARRIER.release) BARRIER.release(); };

const admin = require(require.resolve('firebase-admin', { paths: [FN] }));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
const db = admin.firestore();

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };
const _REAL = { so: process.stdout.write.bind(process.stdout), se: process.stderr.write.bind(process.stderr), cw: console.warn, ce: console.error, cl: console.log };
let _q = 0;
async function quiet(fn) {
  if (_q++ === 0) { process.stdout.write = () => true; process.stderr.write = () => true; console.warn = () => {}; console.error = () => {}; console.log = () => {}; }
  try { return await fn(); } finally { if (--_q === 0) { process.stdout.write = _REAL.so; process.stderr.write = _REAL.se; console.warn = _REAL.cw; console.error = _REAL.ce; console.log = _REAL.cl; } }
}
const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));

const RAIL = require(path.join(FN, 'pos-commission-rail.js'));
const PS = require(path.join(FN, 'pos-commission-settlement.js'));
const P = require(path.join(FN, 'pos-sale-commission.js')); const MA = require(path.join(FN, 'money-authority.js'));
const HAS = typeof PS.sweepOpenAttempts === 'function' && typeof PS.confirmAttempt === 'function';
const REQ = (uid, data) => ({ data, auth: { uid, token: { uid } }, rawRequest: { headers: {} }, acceptsStreaming: false });
const call = (name, uid, data) => res(quiet(() => PS._h[name](REQ(uid, data))));
const sweepAt = (atMs) => (HAS ? quiet(() => PS.sweepOpenAttempts({ nowMs: atMs })) : Promise.resolve(null));
const pay = async (id) => { const s = id ? await db.collection('posCommissionPayments').doc(id).get() : null; return s && s.exists ? s.data() : {}; };
const debt = async (id) => { const s = await db.collection('posCommissionLiabilities').doc(id).get(); return s.exists ? s.data() : {}; };
const claimsOf = async (payId) => !payId ? [] : (await db.collection('posCommissionSettlementClaims').where('payId', '==', payId).get()).docs.map((d) => d.data());
/* per attempt: the sweep processes EVERY open attempt, so a check about ONE attempt counts only its own reads */
const readsOf = (inv) => CALLS.filter((c) => c.path === '/api/v1/payment/status/' && c.body && c.body.invoice_id === inv).length;
const stkCalls = () => CALLS.filter((c) => c.path === '/api/v1/payment/mpesa-stk-push/').length;
const sale = (sid, uid, kes) => RAIL.recordSaleLiability(db, P.planSaleCommission({ rail: 'POS_CASH', gross: MA.fromMinor(Math.round(kes * 100)), planId: null, soldAtMs: Date.now(), saleId: sid, merchantUid: uid }));
const COMPLETE = (payId, kes, inv) => ({ status: 200, body: { invoice: { invoice_id: inv, state: 'COMPLETE', api_ref: payId, value: kes, currency: 'KES', provider: 'M-PESA' } } });
const STATE = (payId, state, inv) => ({ status: 200, body: { invoice: { invoice_id: inv, state, api_ref: payId } } });
const MIN = 60 * 1000;

let N = 0;
/* One business, one owner, one 1000 KES cash sale → one debt of 50 KES (5000 minor). */
async function business(tag) {
  N++; const biz = 'SOK-M4A-' + String(N).padStart(2, '0') + tag, owner = 'm4a-owner-' + N;
  await db.collection('businesses').doc(biz).set({ ownerId: owner, name: biz, status: 'active' });
  await sale('m4a-' + N, owner, 1000);
  return { biz, owner, debtId: 'poscomm_m4a-' + N };
}
/* Pay Now through the real callable with a scripted STK reply; returns the attempt. */
async function openViaPayNow(b, stkReply, key) {
  SCRIPT.stk.push(stkReply);
  const r = await call('posCommissionPayNow', b.owner, { businessId: b.biz, method: 'INTASEND_STK', phone: '254700000001', idempotencyKey: key });
  return r.ok ? r.out.payId : null;
}

(async () => {
  process.stdout.write(`\nM0-4a — abandoned commission attempts converge through ONE confirm authority   (tree: ${ROOT})\n\n`);
  /* X-0 — runs on BOTH trees, through the Confirm callable alone: two Confirms read the attempt as OPEN; one gets a
     proven COMPLETE at once, the other a COMPLETE for the wrong amount 500 ms later, so its review lands AFTER the
     PAID commit. Pre-M0-4a, review was a plain update and could turn a settled attempt back into NEEDS_REVIEW. */
  { const b = await business('X0'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-X0' } } }, 'm4a-key-x0');
    SCRIPT.status['INV-X0'] = [COMPLETE(id, 50, 'INV-X0'), Object.assign(COMPLETE(id, 49, 'INV-X0'), { delayMs: 500 })];
    await Promise.all([call('posCommissionPayNowConfirm', b.owner, { payId: id }), call('posCommissionPayNowConfirm', b.owner, { payId: id })]);
    const p = await pay(id), d = await debt(b.debtId);
    ok(p.status === 'PAID' && d.status === 'SETTLED', 'X-0',
      `a late review can NOT overwrite a PAID attempt whose debt is SETTLED (attempt ${p.status}, debt ${d.status})`); }
  if (!HAS) {
    for (const id of ['Y-1', 'S-1', 'S-2', 'S-3', 'S-4', 'S-5', 'S-6', 'E-1', 'E-2', 'E-3', 'R-1', 'R-2', 'X-1', 'X-2', 'X-3', 'B-1', 'B-2', 'B-3', 'B-4']) {
      ok(false, id, 'no confirm authority / sweep in this tree (confirmAttempt or sweepOpenAttempts absent)');
    }
    ok(RAIL.GATE_ENFORCED === false, 'B-5', 'the till gate is still OFF: GATE_ENFORCED=' + RAIL.GATE_ENFORCED);
    process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`); clearTimeout(WATCHDOG); process.exit(fail ? 1 : 0);
  }
  ok(PS.SWEEP_MIN_AGE_MS === 10 * MIN && PS.SWEEP_PENDING_CAP_MS === 30 * MIN, 'C-0',
    `thresholds are the approved values: eligible after ${PS.SWEEP_MIN_AGE_MS / MIN} min, pending cap ${PS.SWEEP_PENDING_CAP_MS / MIN} min after eligibility`);

  process.stdout.write('\n[Y] the interactive window\n');
  { const b = await business('Y'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-Y1' } } }, 'm4a-key-y1');
    SCRIPT.status['INV-Y1'] = [COMPLETE(id, 50, 'INV-Y1')];
    const c0 = readsOf('INV-Y1'); await sweepAt((await pay(id)).createdAtMs + 9 * MIN + 59 * 1000);
    const p = await pay(id);
    ok(!!id && p.status === 'OPEN' && readsOf('INV-Y1') === c0 && (await debt(b.debtId)).status === 'OUTSTANDING', 'Y-1',
      `an attempt 9m59s old is not touched — not even read at the provider (status ${p.status}, status reads +${readsOf('INV-Y1') - c0})`);
    await sweepAt(p.createdAtMs + 10 * MIN);
    ok((await pay(id)).status === 'PAID', 'Y-2', `…and at exactly 10 minutes it is processed (status ${(await pay(id)).status})`); }

  process.stdout.write('\n[S] attempts WITH a provider reference\n');
  { const b = await business('S'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-S1' } } }, 'm4a-key-s1');
    SCRIPT.status['INV-S1'] = [COMPLETE(id, 50, 'INV-S1')];
    await sweepAt((await pay(id)).createdAtMs + 11 * MIN);
    const p = await pay(id), d = await debt(b.debtId), cl = await claimsOf(id);
    ok(p.status === 'PAID' && d.status === 'SETTLED' && d.settlementRef === id && cl.length === 1 && cl[0].status === 'SETTLED', 'S-1',
      `proven COMPLETE → PAID; the debt SETTLED once (ref = the attempt); its claim kept as SETTLED, not released (claims ${cl.map((c) => c.status)})`); }
  { const b = await business('S'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-S2' } } }, 'm4a-key-s2');
    SCRIPT.status['INV-S2'] = [STATE(id, 'FAILED', 'INV-S2')];
    await sweepAt((await pay(id)).createdAtMs + 11 * MIN);
    ok((await pay(id)).status === 'FAILED' && (await claimsOf(id)).length === 0 && (await debt(b.debtId)).status === 'OUTSTANDING', 'S-2',
      'provider FAILED → FAILED; claims released; the debt stays OUTSTANDING'); }
  { const b = await business('S'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-S3' } } }, 'm4a-key-s3');
    SCRIPT.status['INV-S3'] = [COMPLETE(id, 49, 'INV-S3')];
    await sweepAt((await pay(id)).createdAtMs + 11 * MIN);
    const p = await pay(id);
    ok(p.status === 'NEEDS_REVIEW' && (await debt(b.debtId)).status === 'OUTSTANDING' && (await claimsOf(id)).every((c) => c.status === 'HELD'), 'S-3',
      `COMPLETE for a different amount (49 ≠ 50) → NEEDS_REVIEW, not guessed; the debt OUTSTANDING, its claim still HELD (${p.reviewReason})`); }
  { const b = await business('S'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-S4' } } }, 'm4a-key-s4');
    SCRIPT.status['INV-S4'] = [STATE(id, 'PENDING', 'INV-S4')];
    const t0 = (await pay(id)).createdAtMs;
    await sweepAt(t0 + 11 * MIN); const a = (await pay(id)).status;
    await sweepAt(t0 + 10 * MIN + 30 * MIN - 1); const b2 = (await pay(id)).status;
    ok(a === 'OPEN' && b2 === 'OPEN' && (await debt(b.debtId)).status === 'OUTSTANDING', 'S-4',
      `provider PENDING stays OPEN — at +11m (${a}) and 1 ms before the cap at +40m (${b2}); a pending provider is never treated as failed`);
    await sweepAt(t0 + 40 * MIN); const p = await pay(id);
    ok(p.status === 'NEEDS_REVIEW' && /pending/.test(p.reviewReason || '') && (await claimsOf(id)).every((c) => c.status === 'HELD'), 'S-5',
      `…at the cap (createdAt + 10m + 30m) it becomes NEEDS_REVIEW, claims still HELD (${p.reviewReason})`); }
  { const b = await business('S'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-S6' } } }, 'm4a-key-s6');
    SCRIPT.status['INV-S6'] = [{ throw: 'ECONNRESET' }];
    const t0 = (await pay(id)).createdAtMs;
    await sweepAt(t0 + 11 * MIN); const a = (await pay(id)).status;
    await sweepAt(t0 + 40 * MIN); const p = await pay(id);
    ok(a === 'OPEN' && p.status === 'NEEDS_REVIEW' && /did not answer/.test(p.reviewReason || ''), 'S-6',
      `a provider that does not answer: OPEN before the cap (${a}), NEEDS_REVIEW after it (${p.status})`); }

  process.stdout.write('\n[E] attempts with NO provider reference\n');
  { const b = await business('E');
    const o = await PS.openAttempt({ scope: { kind: 'BUSINESS', businessId: b.biz, merchantUid: null, key: 'biz:' + b.biz }, method: 'INTASEND_STK', idempotencyKey: 'm4a-key-e1', requestedBy: b.owner });
    const id = o.payment.payId; const c0 = readsOf(null) + readsOf(undefined);
    await sweepAt(o.payment.createdAtMs + 11 * MIN);
    ok((await pay(id)).status === 'FAILED' && (await claimsOf(id)).length === 0 && (await debt(b.debtId)).status === 'OUTSTANDING' && readsOf(null) + readsOf(undefined) === c0, 'E-1',
      'the provider was never called (a crash between opening and the call) → expired: FAILED, claims released, debt OUTSTANDING, no provider read'); }
  { const b = await business('E'); const id = await openViaPayNow(b, { throw: 'socket hang up' }, 'm4a-key-e2');
    const p0 = await pay(id);
    await sweepAt(p0.createdAtMs + 11 * MIN); const p = await pay(id);
    ok(p0.gatewayOutcome === 'OUTCOME_UNKNOWN' && p.status === 'NEEDS_REVIEW' && (await claimsOf(id)).every((c) => c.status === 'HELD') && (await debt(b.debtId)).status === 'OUTSTANDING', 'E-2',
      `outcome unknown with no reference → NEEDS_REVIEW, NOT expired: a prompt may have reached the phone (claims HELD, debt OUTSTANDING)`); }
  { const b = await business('E'); const id = await openViaPayNow(b, { status: 200, body: {} }, 'm4a-key-e3');
    const p0 = await pay(id);
    await sweepAt(p0.createdAtMs + 11 * MIN); const p = await pay(id);
    ok(p0.gatewayOutcome === 'GATEWAY_ACCEPTED' && !p0.providerRef && p.status === 'NEEDS_REVIEW', 'E-3',
      'accepted by the gateway but no reference returned → NEEDS_REVIEW, never guessed'); }

  process.stdout.write('\n[R] review is transactional, and review is M0-5\n');
  { const b = await business('R'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-R1' } } }, 'm4a-key-r1');
    SCRIPT.status['INV-R1'] = [COMPLETE(id, 50, 'INV-R1')];
    await sweepAt((await pay(id)).createdAtMs + 11 * MIN);
    const r = await PS.markNeedsReview(id, 'late disagreement', null, 'test');
    const p = await pay(id);
    ok(p.status === 'PAID' && r.replay === true && !(p.history || []).some((h) => h.event === 'NEEDS_REVIEW'), 'R-1',
      `a review transition can NOT overwrite PAID (it replays; status ${p.status}, no NEEDS_REVIEW in history)`); }
  { const b = await business('R'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-R2' } } }, 'm4a-key-r2');
    SCRIPT.status['INV-R2'] = [COMPLETE(id, 49, 'INV-R2')];
    await sweepAt((await pay(id)).createdAtMs + 11 * MIN);                     /* → NEEDS_REVIEW */
    SCRIPT.status['INV-R2'] = [COMPLETE(id, 50, 'INV-R2')];
    const c0 = readsOf('INV-R2');
    const r = await call('posCommissionPayNowConfirm', b.owner, { payId: id });
    await sweepAt((await pay(id)).createdAtMs + 60 * MIN);
    const p = await pay(id);
    ok(p.status === 'NEEDS_REVIEW' && (await debt(b.debtId)).status === 'OUTSTANDING' && readsOf('INV-R2') === c0 && r.ok, 'R-2',
      `an attempt in review is left to M0-5: neither Confirm nor the sweep moves it or even reads the provider (status ${p.status}, reads +${readsOf('INV-R2') - c0})`); }

  process.stdout.write('\n[X] Confirm and the sweep racing on ONE attempt (both provider reads forced to overlap)\n');
  { const b = await business('X'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-X1' } } }, 'm4a-key-x1');
    SCRIPT.status['INV-X1'] = [COMPLETE(id, 50, 'INV-X1')];
    const t0 = (await pay(id)).createdAtMs;
    armBarrier(2);
    const [cf] = await Promise.all([call('posCommissionPayNowConfirm', b.owner, { payId: id }), sweepAt(t0 + 11 * MIN)]);
    const met = BARRIER.arrived >= 2; disarmBarrier();
    const p = await pay(id), d = await debt(b.debtId);
    const paidEvents = (p.history || []).filter((h) => h.event === 'PAID').length;
    ok(met && cf.ok && p.status === 'PAID' && d.status === 'SETTLED' && paidEvents === 1 && (await claimsOf(id)).every((c) => c.status === 'SETTLED'), 'X-1',
      `both saw COMPLETE (overlap forced: ${met}) → ONE PAID transition, the debt settled once, claims SETTLED (PAID events: ${paidEvents})`); }
  { const b = await business('X'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-X2' } } }, 'm4a-key-x2');
    /* the two overlapping reads get DIFFERENT answers: one "COMPLETE, wrong amount" (review), one proven COMPLETE */
    SCRIPT.status['INV-X2'] = [COMPLETE(id, 49, 'INV-X2'), COMPLETE(id, 50, 'INV-X2')];
    const t0 = (await pay(id)).createdAtMs;
    armBarrier(2);
    await Promise.all([call('posCommissionPayNowConfirm', b.owner, { payId: id }), sweepAt(t0 + 11 * MIN)]);
    const met = BARRIER.arrived >= 2; disarmBarrier();
    const p = await pay(id), d = await debt(b.debtId);
    const ev = (p.history || []).map((h) => h.event).filter((e) => e === 'PAID' || e === 'NEEDS_REVIEW');
    const consistent = (p.status === 'PAID' && d.status === 'SETTLED') || (p.status === 'NEEDS_REVIEW' && d.status === 'OUTSTANDING');
    ok(met && consistent && ev.length === 1, 'X-2',
      `conflicting answers under a forced overlap → exactly ONE transition wins (${ev.join(',')}; status ${p.status}, debt ${d.status}); the loser never overwrites it`); }
  { const b = await business('X'); const id = await openViaPayNow(b, { status: 200, body: { invoice: { invoice_id: 'INV-X3' } } }, 'm4a-key-x3');
    SCRIPT.status['INV-X3'] = [STATE(id, 'FAILED', 'INV-X3')];
    const t0 = (await pay(id)).createdAtMs;
    await sweepAt(t0 + 11 * MIN);
    SCRIPT.status['INV-X3'] = [STATE(id, 'PENDING', 'INV-X3')];
    await call('posCommissionPayNowConfirm', b.owner, { payId: id });
    await sweepAt(t0 + 60 * MIN);
    ok((await pay(id)).status === 'FAILED' && (await claimsOf(id)).length === 0 && (await debt(b.debtId)).status === 'OUTSTANDING', 'X-3',
      'failure wins → FAILED; a later PENDING read (Confirm) and later sweeps never reopen it (the sweep scans OPEN only)'); }

  process.stdout.write('\n[B] boundaries\n');
  { const b = await business('B');
    const r = await call('posCommissionCashRecord', b.owner, { businessId: b.biz, idempotencyKey: 'm4a-key-cash1', note: 'handed over' });
    const id = r.ok ? r.out.payId : null;
    await sweepAt((await pay(id)).createdAtMs + 5 * 60 * MIN);
    ok(!!id && (await pay(id)).status === 'OPEN' && (await claimsOf(id)).every((c) => c.status === 'HELD'), 'B-1',
      'a CASH attempt, however old, is not touched — only SOKONI confirms cash'); }
  { const wallets = async () => ({ bw: (await db.collection('businessWallets').get()).size, bwe: (await db.collection('businessWalletEntries').get()).size, w: (await db.collection('wallets').get()).size });
    const w0 = await wallets(); const stk0 = stkCalls(); const c0 = CALLS.length;
    const t1 = await sweepAt(Date.now() + 24 * 60 * MIN);
    const t2 = await sweepAt(Date.now() + 24 * 60 * MIN);
    const w1 = await wallets();
    ok(JSON.stringify(w0) === JSON.stringify(w1) && w1.bw + w1.bwe + w1.w === 0, 'B-2', `no wallet of any kind was written (business ${w1.bw}, entries ${w1.bwe}, personal ${w1.w})`);
    ok(stkCalls() === stk0 && CALLS.slice(c0).every((c) => c.path === '/api/v1/payment/status/'), 'B-3',
      'the sweep never opens a payment and never sends an STK — its only provider calls are status READS');
    const moved = (t) => t ? Object.values(t.confirmed).reduce((s, n) => s + n, 0) + t.expired + t.review : -1;
    ok(t1 && t2 && moved(t2) === 0, 'B-4', `a repeated run changes nothing (second run: ${JSON.stringify(t2)})`); }
  ok(RAIL.GATE_ENFORCED === false, 'B-5', 'the till gate is still OFF (P0): GATE_ENFORCED=' + RAIL.GATE_ENFORCED);
  ok(UNSCRIPTED === 0, 'B-6', 'no unscripted outbound call: ' + UNSCRIPTED);

  clearTimeout(WATCHDOG);
  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
