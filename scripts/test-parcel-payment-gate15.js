#!/usr/bin/env node
/* test-parcel-payment-gate15.js — IntaSend convergence Gate 12 + Gate 15 for the PARCEL rail.
 *
 * EXECUTES the real functions/parcel-requests.js (payParcelRequest → confirmParcelPayment) against
 * an in-memory Firestore double (optimistic transactions, create() that refuses an existing doc)
 * and a scripted fake IntaSend transport. No emulator, no network, no firebase-admin: the module
 * requires only `crypto`, and every dependency is injected through makeParcelRequests(deps).
 *
 * For every Gate 15 row it records: test id, expected, observed, pass/fail, the mutation/attack,
 * and the database / money / order / ledger effect — measured by diffing the whole store before
 * and after, never asserted from the return value alone.
 *   money effect  = parcelRequests.payment.state → 'paid' and the amount recorded
 *   order effect  = parcelRequests.status / packageRequests status (the job a rider can claim)
 *   ledger effect = parcelPayments (the rail's invoice-claim register). The parcel rail posts NO
 *                   double-entry ledger (rider payout is pending_manual); that is stated, not faked.
 *
 * Then FAILURE INJECTION on temp copies of the module (os.tmpdir): revert method to pay.method,
 * drop the currency check, drop the create() claim — each must FAIL a named row, or the suite fails.
 *
 *   node scripts/test-parcel-payment-gate15.js            (exit 0 only if every row passes AND
 *                                                         every injection is caught)
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MODULE = path.join(ROOT, 'functions', 'parcel-requests.js');

/* ── Gate 12 mapping provenance: 5aa7711 functions/index.js:2792-2796 ─────────────────────── */
const MAPPING_SHA256 = '4d9f44ca19fe542f94a174f9f17287d0fe1298be99c16affcbcb38eba8f29d78';
const mappingHash = (src) => {
  const lines = src.split(/\r?\n/);
  const i = lines.findIndex((l) => l.includes('const _providerRaw = String(payment.provider'));
  if (i < 0) return null;
  return crypto.createHash('sha256').update(lines.slice(i, i + 5).map((l) => l.trim()).join('\n')).digest('hex');
};

/* ══ Firestore double ════════════════════════════════════════════════════════════════════════ */
const TS = { __ts: true };
const FieldValue = {
  serverTimestamp: () => TS,
  arrayUnion: (...items) => ({ __union: items }),
  increment: (n) => ({ __inc: n }),
};
function makeDb() {
  const store = new Map();          // path -> { data, v }
  let commits = 0;
  const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const resolve = (prev, val) => {
    if (val && val.__union) return (Array.isArray(prev) ? prev : []).concat(val.__union);
    if (val && val.__inc != null) return (Number(prev) || 0) + val.__inc;
    return val;
  };
  const applySet = (p, data, merge) => {
    const cur = store.get(p);
    const base = merge && cur ? clone(cur.data) : {};
    for (const [k, v] of Object.entries(data)) base[k] = resolve(base[k], v);
    store.set(p, { data: base, v: (cur ? cur.v : 0) + 1 });
  };
  const applyUpdate = (p, patch) => {
    const cur = store.get(p);
    if (!cur) { const e = new Error('NOT_FOUND: ' + p); e.code = 5; throw e; }
    const d = clone(cur.data);
    for (const [k, v] of Object.entries(patch)) {
      const parts = k.split('.'); let o = d;
      for (let i = 0; i < parts.length - 1; i++) { if (typeof o[parts[i]] !== 'object' || o[parts[i]] === null) o[parts[i]] = {}; o = o[parts[i]]; }
      o[parts[parts.length - 1]] = resolve(o[parts[parts.length - 1]], v);
    }
    store.set(p, { data: d, v: cur.v + 1 });
  };
  const applyCreate = (p, data) => {
    if (store.has(p)) { const e = new Error('ALREADY_EXISTS: ' + p); e.code = 6; throw e; }
    applySet(p, data, false);
  };
  const snap = (p) => { const c = store.get(p); return { exists: !!c, id: p.split('/').pop(), data: () => (c ? clone(c.data) : undefined) }; };
  const ref = (col, id) => ({
    id, path: col + '/' + id,
    async get() { await null; return snap(col + '/' + id); },
    async set(d, o) { await null; commits++; applySet(col + '/' + id, d, !!(o && o.merge)); },
    async update(d) { await null; commits++; applyUpdate(col + '/' + id, d); },
    async create(d) { await null; commits++; applyCreate(col + '/' + id, d); },
  });
  const db = {
    collection: (col) => ({ doc: (id) => ref(col, id) }),
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const reads = new Map(); const writes = [];
        const t = {
          async get(r) { await null; const c = store.get(r.path); reads.set(r.path, c ? c.v : 0); return snap(r.path); },
          create(r, d) { writes.push(['create', r.path, d]); return t; },
          set(r, d, o) { writes.push(['set', r.path, d, o]); return t; },
          update(r, d) { writes.push(['update', r.path, d]); return t; },
        };
        const out = await fn(t);
        await null;
        const stale = [...reads].some(([p, v]) => { const c = store.get(p); return (c ? c.v : 0) !== v; });
        if (stale) continue;                                   // optimistic retry, as Firestore does
        const before = new Map(store);
        try {
          for (const [op, p, d, o] of writes) {
            if (op === 'create') applyCreate(p, d); else if (op === 'set') applySet(p, d, !!(o && o.merge)); else applyUpdate(p, d);
          }
        } catch (e) { store.clear(); before.forEach((v, k) => store.set(k, v)); throw e; }   // atomic
        if (writes.length) commits++;
        return out;
      }
      const e = new Error('ABORTED: too much contention'); e.code = 10; throw e;
    },
  };
  return { db, store, commitsOf: () => commits, dump: () => { const o = {}; store.forEach((v, k) => { o[k] = clone(v.data); }); return o; } };
}

/* ══ firebase-functions doubles ══════════════════════════════════════════════════════════════ */
class HttpsError extends Error { constructor(code, message) { super(message); this.code = code; } }
const onCall = (_opts, handler) => ({ run: (req) => handler(req) });
const admin = { firestore: { FieldValue, Timestamp: { fromMillis: (ms) => ({ ms }), now: () => ({ ms: Date.now() }) } } };

/* ══ one isolated world per row ══════════════════════════════════════════════════════════════ */
const FEE = 615;
function world(mod) {
  const W = makeDb();
  const calls = [];
  let collection = () => ({ status: 200, data: { results: [] } });
  const transport = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (p.startsWith('/api/v1/payment/mpesa-stk-push/')) return { status: 200, data: { id: 'CK-STK', invoice: { invoice_id: 'INV-STK-' + body.api_ref } } };
    if (p.startsWith('/api/v1/checkout/')) return { status: 200, data: { id: 'co_' + body.api_ref, url: 'https://sandbox.intasend.com/checkout/co_' + body.api_ref } };
    if (p.startsWith('/api/v1/payment/collection/')) return collection(p);
    return { status: 404, data: null };
  };
  process.env.INTASEND_PRIVATE_KEY = 'test-key';
  const P = mod.makeParcelRequests({ onCall, HttpsError, admin, db: W.db, INTASEND_PRIVATE_KEY: null, transport, now: () => Date.now() });
  const seed = async (parcelId, uid) => {
    await W.db.collection('parcelRequests').doc(parcelId).set({
      parcelId, uid, jobId: 'PRC' + parcelId, status: 'pending_payment', deliveryFee: FEE, currency: 'KES', catalogueVersion: 'parcel-2026-09-30',
      breakdown: { total: FEE }, payment: { state: 'unpaid', method: null, invoiceId: null, checkoutId: null, trackingId: null, paidAmount: null, paidAt: null },
    });
    await W.db.collection('packageRequests').doc('PRC' + parcelId).set({ kind: 'parcel', parcelId, uid, status: 'pending_payment', paymentState: 'unpaid' });
  };
  const call = (fn, uid, data) => fn.run({ auth: uid ? { uid, token: {} } : null, data: data || {} });
  const outcome = async (p) => { try { return { ok: true, r: await p }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
  return { W, P, calls, seed, call, outcome, setCollection: (f) => { collection = f; } };
}
const rec = (over) => Object.assign({ invoice_id: 'INV1', api_ref: 'A', currency: 'KES', state: 'COMPLETE', value: FEE + '.00', provider: 'M-PESA', mpesa_reference: 'QX1ABC' }, over);
const results = (...recs) => () => ({ status: 200, data: { results: recs } });

/* effects from a before/after store diff */
function effects(before, after) {
  const changed = Object.keys(Object.assign({}, before, after)).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k])).sort();
  const pr = Object.keys(after).filter((k) => k.startsWith('parcelRequests/'));
  const paidNow = pr.filter((k) => (after[k].payment || {}).state === 'paid' && ((before[k] || {}).payment || {}).state !== 'paid');
  const claims = Object.keys(after).filter((k) => k.startsWith('parcelPayments/'));
  const newClaims = claims.filter((k) => !before[k]);
  const rewrittenClaims = claims.filter((k) => before[k] && JSON.stringify(before[k]) !== JSON.stringify(after[k]));
  const orderMoves = pr.filter((k) => (before[k] || {}).status !== after[k].status).map((k) => k.split('/')[1] + ':' + (before[k] || {}).status + '→' + after[k].status);
  return {
    db: changed.length ? 'changed ' + changed.join(', ') : 'none',
    money: paidNow.length ? paidNow.map((k) => k.split('/')[1] + ' PAID KES ' + after[k].payment.paidAmount).join('; ') : 'none',
    order: orderMoves.length ? orderMoves.join('; ') : 'none',
    ledger: (newClaims.length ? 'claim created ' + newClaims.map((k) => k.split('/')[1] + '→' + after[k].parcelId).join(', ') : 'no claim')
          + (rewrittenClaims.length ? '; claim REWRITTEN ' + rewrittenClaims.map((k) => k.split('/')[1] + '→' + after[k].parcelId).join(', ') : '')
          + ' (no double-entry ledger on this rail)',
    paidNow, newClaims, rewrittenClaims, changed,
  };
}

/* ══ the matrix ══════════════════════════════════════════════════════════════════════════════ */
async function matrix(mod) {
  const rows = [];
  const row = async (id, attack, expected, setup, act, judge) => {
    const w = world(mod);
    await setup(w);
    const before = w.W.dump();
    let observed, pass, eff;
    try {
      const o = await act(w);
      eff = effects(before, w.W.dump());
      const j = judge(o, eff, w);
      observed = j.observed; pass = !!j.pass;
    } catch (e) { eff = effects(before, w.W.dump()); observed = 'harness error: ' + e.message; pass = false; }
    rows.push({ id, expected, observed, pass, attack, db: eff.db, money: eff.money, order: eff.order, ledger: eff.ledger });
  };
  const show = (o) => (o.ok ? JSON.stringify(Object.assign({}, o.r, o.r && o.r.receipt ? { receipt: { method: o.r.receipt.method, channel: o.r.receipt.channel } } : {})) : 'refused ' + o.code);
  const payCheckout = (w, id, uid) => w.call(w.P.payParcelRequest, uid || 'sender', { parcelId: id, method: 'checkout', email: 's@example.com' });
  const nothing = (eff) => eff.changed.length === 0;

  await row('VALID_PAYMENT', 'none — honest checkout paid via M-PESA, KES, full amount', 'paid; one claim; job awaiting_rider; method mpesa, channel checkout',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec())); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff, w) => {
      const d = w.W.dump(); const pay = d['parcelRequests/A'].payment, claim = d['parcelPayments/INV1'], job = d['packageRequests/PRCA'];
      const ok = o.ok && o.r.state === 'paid' && eff.paidNow.length === 1 && eff.newClaims.length === 1 && claim.parcelId === 'A' && claim.amount === FEE
        && job.status === 'awaiting_rider' && job.paymentState === 'paid' && pay.method === 'mpesa' && pay.channel === 'checkout' && claim.currency === 'KES';
      return { pass: ok, observed: show(o) + ' · payment.method=' + pay.method + ' channel=' + pay.channel + ' · job=' + job.status };
    });

  await row('INVALID_AMOUNT', 'IntaSend record value is not a number ("abc")', 'refused failed-precondition; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ value: 'abc' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff) => ({ pass: !o.ok && o.code === 'failed-precondition' && nothing(eff), observed: show(o) }));

  await row('PARTIAL_PAYMENT', 'COMPLETE record for KES 100 against a KES 615 fee', 'refused failed-precondition; parcel still pending; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ value: '100.00' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff) => ({ pass: !o.ok && o.code === 'failed-precondition' && nothing(eff), observed: show(o) }));

  await row('WRONG_ORDER', "a COMPLETE KES 615 payment whose api_ref is ANOTHER parcel (B) offered to confirm A", 'not_found for A; neither parcel paid; nothing written',
    async (w) => { await w.seed('A', 'sender'); await w.seed('B', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ api_ref: 'B' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A', trackingId: 'INV1' })),
    (o, eff) => ({ pass: o.ok && o.r.ok === false && o.r.state === 'not_found' && nothing(eff), observed: show(o) }));

  await row('WRONG_BUYER', "a different signed-in user confirms the sender's parcel", 'refused permission-denied before the gateway is asked; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec())); },
    async (w) => { const n = w.calls.length; const o = await w.outcome(w.call(w.P.confirmParcelPayment, 'stranger', { parcelId: 'A' })); o.gatewayCalls = w.calls.length - n; return o; },
    (o, eff) => ({ pass: !o.ok && o.code === 'permission-denied' && o.gatewayCalls === 0 && nothing(eff), observed: show(o) + ' · gateway calls ' + o.gatewayCalls }));

  await row('MISSING_PAYMENT', 'confirm a parcel for which IntaSend holds no payment at all', 'not_found; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results()); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff) => ({ pass: o.ok && o.r.ok === false && o.r.state === 'not_found' && nothing(eff), observed: show(o) }));

  await row('UNVERIFIED_PAYMENT', 'IntaSend record state PROCESSING (not COMPLETE), full KES amount', 'pending; nothing written; not paid',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ state: 'PROCESSING' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff) => ({ pass: o.ok && o.r.ok === false && o.r.state === 'pending' && nothing(eff), observed: show(o) }));

  await row('UNVERIFIED_PAYMENT/FAILED', 'IntaSend record state FAILED', "not paid; only payment.state → 'failed' recorded; no claim, no job move",
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ state: 'FAILED' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff, w) => ({ pass: o.ok && o.r.state === 'failed' && eff.paidNow.length === 0 && eff.newClaims.length === 0 && eff.changed.join() === 'parcelRequests/A'
      && w.W.dump()['parcelRequests/A'].payment.state === 'failed' && w.W.dump()['parcelRequests/A'].status === 'pending_payment', observed: show(o) }));

  await row('DUPLICATE_CALLBACK', 'the same confirmation delivered 3× — twice CONCURRENTLY, then once more', 'one claim, one paid transition; the repeats are no-ops',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec())); },
    async (w) => {
      const c = () => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' }));
      const [a, b] = await Promise.all([c(), c()]); const d = await c();
      return { ok: true, r: { first: a.ok && a.r.state, second: b.ok && b.r.state, third: d.ok && (d.r.alreadyPaid ? 'alreadyPaid' : d.r.state) } };
    },
    (o, eff, w) => {
      const claims = Object.keys(w.W.dump()).filter((k) => k.startsWith('parcelPayments/'));
      return { pass: o.r.first === 'paid' && o.r.second === 'paid' && o.r.third === 'alreadyPaid' && claims.length === 1 && eff.paidNow.length === 1,
        observed: JSON.stringify(o.r) + ' · claims ' + claims.length + ' · timeline ' + (w.W.dump()['packageRequests/PRCA'].timeline || []).length };
    });

  await row('REPLAY_CALLBACK', 'INV1 already paid parcel A; the same invoice replayed with api_ref B to pay parcel B', 'refused failed-precondition; B unpaid; A\'s claim unchanged',
    async (w) => {
      await w.seed('A', 'sender'); await w.seed('B', 'sender'); await payCheckout(w, 'A'); await payCheckout(w, 'B');
      w.setCollection(results(rec())); await w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' });
      w.setCollection(results(rec({ api_ref: 'B', value: '9999.00' })));
    },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'B', trackingId: 'INV1' })),
    (o, eff, w) => ({ pass: !o.ok && o.code === 'failed-precondition' && nothing(eff) && w.W.dump()['parcelPayments/INV1'].parcelId === 'A'
      && w.W.dump()['parcelRequests/B'].payment.state !== 'paid', observed: show(o) + ' · INV1→' + w.W.dump()['parcelPayments/INV1'].parcelId }));

  await row('FAKE_REFERENCE', 'client supplies an invented trackingId "INV-FORGED-777" IntaSend has never issued', 'not_found; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A');
      w.setCollection((p) => (/invoice_id=INV-FORGED-777/.test(p) ? { status: 200, data: { results: [] } } : results(rec())())); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A', trackingId: 'INV-FORGED-777' })),
    (o, eff) => ({ pass: o.ok && o.r.ok === false && o.r.state === 'not_found' && nothing(eff), observed: show(o) }));

  await row('BROWSER_SUCCESS_WITHOUT_PROVIDER', 'client posts {paid:true,state:"COMPLETE",amount:615,method:"card",payment:{state:"paid"}}; IntaSend says PENDING', 'pending; nothing paid; client fields ignored',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ state: 'PENDING' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A', paid: true, state: 'COMPLETE', amount: FEE, method: 'card', payment: { state: 'paid' } })),
    (o, eff) => ({ pass: o.ok && o.r.ok === false && o.r.state === 'pending' && nothing(eff), observed: show(o) }));

  await row('WRONG_CURRENCY', 'COMPLETE record, value 615, currency USD', 'refused failed-precondition; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); w.setCollection(results(rec({ currency: 'USD' }))); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff) => ({ pass: !o.ok && o.code === 'failed-precondition' && nothing(eff), observed: show(o) }));

  await row('WRONG_CURRENCY/MISSING', 'COMPLETE record, value 615, currency field absent', 'refused failed-precondition; nothing written',
    async (w) => { await w.seed('A', 'sender'); await payCheckout(w, 'A'); const r = rec(); delete r.currency; w.setCollection(results(r)); },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff) => ({ pass: !o.ok && o.code === 'failed-precondition' && nothing(eff), observed: show(o) }));

  const methodRow = (id, attack, provider, expMethod, route) => row(id, attack, 'paid; method ' + expMethod + ' on payment, claim, receipt and response; channel ' + (route === 'mpesa' ? 'stk' : 'checkout'),
    async (w) => {
      await w.seed('A', 'sender');
      if (route === 'mpesa') await w.call(w.P.payParcelRequest, 'sender', { parcelId: 'A', method: 'mpesa', phone: '0722000000' });
      else await payCheckout(w, 'A');
      const r = rec({ invoice_id: route === 'mpesa' ? 'INV-STK-A' : 'INV1' }); if (provider === undefined) delete r.provider; else r.provider = provider; w.setCollection(results(r));
    },
    (w) => w.outcome(w.call(w.P.confirmParcelPayment, 'sender', { parcelId: 'A' })),
    (o, eff, w) => {
      const d = w.W.dump(); const inv = route === 'mpesa' ? 'INV-STK-A' : 'INV1';
      const pay = d['parcelRequests/A'].payment, claim = d['parcelPayments/' + inv] || {}, rc = (d['packageRequests/PRCA'] || {}).receipt || {};
      const ch = route === 'mpesa' ? 'stk' : 'checkout';
      const ok = o.ok && o.r.state === 'paid' && [pay.method, claim.method, rc.method, o.r.receipt.method].every((m) => m === expMethod)
        && [pay.channel, claim.channel, rc.channel, o.r.receipt.channel].every((c) => c === ch);
      return { pass: ok, observed: 'payment ' + pay.method + '/' + pay.channel + ' · claim ' + claim.method + '/' + claim.channel + ' · receipt ' + rc.method + '/' + rc.channel + ' · response ' + o.r.receipt.method + '/' + o.r.receipt.channel };
    });
  await methodRow('METHOD_CARD', 'hosted checkout paid by card (IntaSend provider "CARD-PAYMENT")', 'CARD-PAYMENT', 'card', 'checkout');
  await methodRow('METHOD_ABSENT', 'COMPLETE record with NO provider field', undefined, 'unknown', 'checkout');
  await methodRow('METHOD_MPESA_STK', 'STK push route, provider "M-PESA"', 'M-PESA', 'mpesa', 'mpesa');
  return rows;
}

/* ══ run ══════════════════════════════════════════════════════════════════════════════════════ */
(async () => {
  let fail = 0;
  console.log('\nCERT — Parcel rail: IntaSend Gate 12 (method from provider) + Gate 15 (attack matrix)\n');

  console.log('── Gate 12 mapping provenance ──');
  const here = mappingHash(fs.readFileSync(MODULE, 'utf8'));
  let there = null;
  try { there = mappingHash(execFileSync('git', ['show', '5aa7711:functions/index.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 })); } catch (e) { there = null; }
  const prov = [
    ['M1  parcel-requests.js mapping lines hash to the pinned value', here === MAPPING_SHA256, here],
    ['M2  5aa7711 functions/index.js mapping lines hash to the same pinned value (git object read; BLOCKED counts as FAIL)', there === MAPPING_SHA256, there],
  ];
  const mod = require(MODULE);
  const m = mod._internal._methodFromProvider;
  [['M-PESA', 'mpesa'], ['MPESA', 'mpesa'], ['m-pesa', 'mpesa'], ['CARD-PAYMENT', 'card'], ['CARD', 'card'], ['card', 'card'], ['', 'unknown'], [undefined, 'unknown'], ['BANK-ACH', 'bank-ach'], ['%%%', 'unknown']]
    .forEach(([p, exp]) => prov.push(['M3  provider ' + JSON.stringify(p) + ' → ' + exp, m({ provider: p }).method === exp, m({ provider: p }).method]));
  prov.push(['M4  the UI route on the PARCEL record is never consulted (pay.method "checkout" absent from the mapping input)', m({}).method === 'unknown', m({}).method]);
  prov.forEach(([l, ok, got]) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); if (!ok) fail++; });

  const rows = await matrix(mod);
  console.log('\n── Gate 15 matrix (executed; effects measured by store diff) ──\n');
  console.log('| test id | expected | observed | pass/fail | mutation/attack | database effect | money effect | order effect | ledger effect |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  rows.forEach((r) => { console.log('| ' + [r.id, r.expected, r.observed, r.pass ? 'PASS' : 'FAIL', r.attack, r.db, r.money, r.order, r.ledger].map((x) => String(x).replace(/\|/g, '/')).join(' | ') + ' |'); if (!r.pass) fail++; });
  const REQUIRED = ['VALID_PAYMENT', 'INVALID_AMOUNT', 'PARTIAL_PAYMENT', 'WRONG_ORDER', 'WRONG_BUYER', 'MISSING_PAYMENT', 'UNVERIFIED_PAYMENT', 'DUPLICATE_CALLBACK', 'REPLAY_CALLBACK', 'FAKE_REFERENCE', 'BROWSER_SUCCESS_WITHOUT_PROVIDER', 'WRONG_CURRENCY', 'METHOD_CARD', 'METHOD_ABSENT'];
  const missing = REQUIRED.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) { console.log('\n  FAIL  required rows missing: ' + missing.join(', ')); fail++; }
  const rowPass = rows.filter((r) => r.pass).length;

  /* ── failure injection: temp copies; each must be caught by a NAMED row ── */
  console.log('\n── failure injection (temp copies in ' + os.tmpdir() + ') ──');
  const SRC = fs.readFileSync(MODULE, 'utf8');
  const INJ = [
    { name: 'I1 revert method to pay.method (the UI route)', must: ['METHOD_CARD', 'METHOD_ABSENT'],
      from: 'const { method } = _methodFromProvider(rec);', to: 'const method = pay.method || rec.provider || null;' },
    { name: 'I2 drop the currency check', must: ['WRONG_CURRENCY', 'WRONG_CURRENCY/MISSING'],
      from: "if (currency !== 'KES') {", to: 'if (false) {' },
    { name: 'I3 drop the create() claim (claim becomes an unconditional set(), cross-parcel refusal removed)', must: ['REPLAY_CALLBACK'],
      from: "if (cs.exists && (cs.data() || {}).parcelId !== parcelId) throw new HttpsError('failed-precondition', 'That payment already paid for a different parcel.');\n      if (!cs.exists) t.create(claimRef,",
      to: 't.set(claimRef,' },
  ];
  let injOk = 0;
  for (const inj of INJ) {
    if (SRC.split(inj.from).length !== 2) { console.log('  FAIL  ' + inj.name + ' — anchor not found exactly once (injection could not be applied)'); fail++; continue; }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'parcel-g15-'));
    const f = path.join(dir, 'parcel-requests.js');
    fs.writeFileSync(f, SRC.replace(inj.from, () => inj.to));
    let failed = [];
    try { failed = (await matrix(require(f))).filter((r) => !r.pass).map((r) => r.id); }
    finally { delete require.cache[require.resolve(f)]; fs.rmSync(dir, { recursive: true, force: true }); }
    const caught = inj.must.every((id) => failed.includes(id));
    console.log('  ' + (caught ? 'PASS  ' : 'FAIL  ') + inj.name + ' → failing rows: ' + (failed.join(', ') || 'NONE') + ' (must include ' + inj.must.join(', ') + ')');
    if (caught) injOk++; else fail++;
  }

  console.log('\n  rows ' + rowPass + '/' + rows.length + ' PASS · provenance ' + prov.filter((p) => p[1]).length + '/' + prov.length + ' · injections caught ' + injOk + '/' + INJ.length);
  console.log('  ' + (fail ? 'FAIL (' + fail + ')' : 'PASS') + ' — exit code alone is not the evidence; the table above is.');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('SUITE CRASH', e); process.exit(2); });
