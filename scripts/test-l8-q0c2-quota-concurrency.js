'use strict';
/**
 * CERTIFICATION — L-8: concurrent posSendSMS requests cannot exceed a merchant's daily SMS quota.
 *
 * WHY THIS EXISTS. Q0c-2's own concurrency check (Q-2) fires two requests with Promise.all and hopes they reach the
 * quota read together. They usually do, sometimes they do not — a corrected non-transactional mutant was caught in
 * 4 of 5 runs. "The quota is read inside a transaction" is a statement about the code; it is not a proof that
 * contention cannot exceed the quota. This suite FORCES the race and then proves the invariant:
 *
 *   concurrent sends cannot cause the merchant's quota to be exceeded.
 *
 * HOW THE RACE IS FORCED. Every read of a `smsMerchantQuota/*` document — through a Transaction or a plain
 * DocumentReference — passes a one-shot BARRIER: the first N readers are each held, after their read returns and
 * before they can write, until all N have read (or a timeout). A read-then-write that is NOT transactional therefore
 * always has every request read the same stale count.
 *
 * HOW THE HARNESS PROVES IT FORCED IT (it must fail closed, not pass for the wrong reason):
 *   C-1  POSITIVE CONTROL — a deliberately non-transactional read-then-write of a quota document, run twice under the
 *        same barrier, MUST exceed the quota (and the barrier must report both readers arrived). If this control does
 *        not go over, the barrier is not producing a race and every T-result below is meaningless.
 *   C-2  the barrier is really in the handler's path: the handler's quota read is seen by the barrier.
 * THE PROPERTY, against the REAL handler (functions/pos-merchant-sms.js `_h.posSendSMS`):
 *   T-1  two concurrent requests of 30 at 450/500 → exactly one served, one refused (resource-exhausted); the day ends
 *        at 480, never 510; exactly 30 sends reach the (stubbed) provider.
 *   T-2  three concurrent requests of 20 at 460/500 → exactly two served, one refused; the day ends at exactly 500;
 *        exactly 40 sends.
 * Neither T-case asserts HOW the handler serialises (the emulator serialises transactions with locks, production
 * aborts and retries) — only that the quota is never exceeded and sends match the reservation.
 *
 * NOTHING IS SENT. Africa's Talking is replaced in-process before the handler loads; the suite refuses to run otherwise.
 *
 *   REPAIR_ROOT  tree under test (default: this repo). Refuses without FIRESTORE_EMULATOR_HOST.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

if (!process.env.FIRESTORE_EMULATOR_HOST) { console.error('REFUSED: FIRESTORE_EMULATOR_HOST is not set.'); process.exit(2); }
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');
process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-l8-quota';
const WATCHDOG = setTimeout(() => { process.stdout.write('\n  ✖ WATCHDOG — suite exceeded 200s\n'); process.exit(3); }, 200000);

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

/* ── the sender stub — installed before the handler is loaded ── */
const SENT = [];
const AT = require(path.join(FN, 'sokoni-at.js'));
const stubSend = async (to, message) => { SENT.push({ to: String(to), message: String(message) }); return { ok: true, results: [{ messageId: 'stub' }] }; };
AT.atSendSMS = stubSend;
AT.atSendSMSWithRetry = stubSend;
AT.resolveAtCredentials = () => ({ username: 'stub', apiKey: 'stub' });
if (require(path.join(FN, 'sokoni-at.js')).atSendSMS !== stubSend) { process.stdout.write('  ✖ SETUP — the sender stub is not installed; refusing to run\n'); process.exit(2); }

/* ── the barrier: one-shot, on every read of a smsMerchantQuota document ── */
const BAR = { active: false, n: 0, arrived: 0, seen: 0, release: null, gate: null, timer: null, met: false };
function armBarrier(n, timeoutMs) {
  Object.assign(BAR, { active: true, n, arrived: 0, seen: 0, met: false });
  BAR.gate = new Promise((r) => { BAR.release = r; });
  BAR.timer = setTimeout(() => { BAR.active = false; BAR.release(); }, timeoutMs);
}
function disarmBarrier() { BAR.active = false; clearTimeout(BAR.timer); if (BAR.release) BAR.release(); }
async function atBarrier(p) {
  if (!String(p || '').startsWith('smsMerchantQuota/')) return;
  BAR.seen++;
  if (!BAR.active || BAR.arrived >= BAR.n) return;         /* one-shot: only the first n readers are held */
  BAR.arrived++;
  if (BAR.arrived >= BAR.n) { BAR.met = true; clearTimeout(BAR.timer); BAR.release(); }
  await BAR.gate;
}
{
  const refProto = Object.getPrototypeOf(db.doc('x/y'));
  const _rGet = refProto.get;
  refProto.get = async function (...a) { const s = await _rGet.apply(this, a); await atBarrier(this.path); return s; };
  const tProto = require(require.resolve('@google-cloud/firestore', { paths: [FN] })).Transaction.prototype;
  const _tGet = tProto.get;
  tProto.get = async function (ref, ...a) { const s = await _tGet.call(this, ref, ...a); await atBarrier(ref && ref.path); return s; };
}

/* ── the handler under test ── */
if (!fs.existsSync(path.join(FN, 'pos-merchant-sms.js'))) { process.stdout.write('  ✖ SETUP — functions/pos-merchant-sms.js not found in this tree\n'); process.exit(2); }
const H = require(path.join(FN, 'pos-merchant-sms.js'))._h.posSendSMS;

const res = (p) => p.then((out) => ({ ok: true, out }), (e) => ({ ok: false, code: e.code, msg: String(e.message || '') }));
const send = (uid, data) => res(quiet(() => H({ data, auth: { uid, token: { uid } } })));
const keyOf = (owners) => crypto.createHash('sha256').update([...owners].sort().join('|')).digest('hex').slice(0, 32);
const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
const MAX = 500;

(async () => {
  process.stdout.write(`\nL-8 — posSendSMS daily quota under FORCED concurrency   (tree: ${ROOT})\n\n`);
  const Q = 'l8q-shop';
  await db.doc(`users/${Q}`).set({ name: 'Quota Shop Owner' });
  await db.doc(`shops/${Q}`).set({ ownerId: Q, storeName: 'Quota Shop' });
  for (let i = 0; i < 60; i++) await db.doc(`posCustomers/L8Q${i}`).set({ sellerId: Q, phone: '2547230' + String(100 + i).padStart(5, '0'), name: 'C' + i });
  const quotaPath = `smsMerchantQuota/${keyOf(new Set([Q]))}_${day}`;
  const count = async (p) => { const s = await db.doc(p).get(); return s.exists ? Number(s.data().count) : 0; };

  process.stdout.write('[C] the harness forces the race — and proves it\n');
  { /* a deliberately NON-transactional read-then-write, the shape the barrier must break */
    const ctl = 'smsMerchantQuota/l8-control-not-a-merchant';
    await db.doc(ctl).set({ count: 450 });
    const naive = async (n) => { const s = await db.doc(ctl).get(); const used = Number(s.data().count);
      if (used + n > MAX) return false; await db.doc(ctl).set({ count: used + n }, { merge: true }); return true; };
    armBarrier(2, 5000);
    const r = await Promise.all([naive(30), naive(30)]);
    const met = BAR.met; disarmBarrier();
    const after = await count(ctl);
    ok(met && r.every(Boolean), 'C-1', `POSITIVE CONTROL — under the barrier a non-transactional read-then-write lets BOTH requests pass the check (barrier met=${met}, both passed=${r.every(Boolean)}; last write ${after}, the lost update the transaction must prevent)`);
  }
  { await db.doc(quotaPath).set({ count: 0, merchantKey: keyOf(new Set([Q])), day });
    armBarrier(1, 3000);
    const r = await send(Q, { merchantId: Q, customerIds: ['L8Q0'], message: 'x' });
    const seen = BAR.seen; disarmBarrier();
    ok(r.ok && seen >= 1, 'C-2', `the barrier sits in the handler's path: its quota read was intercepted ${seen}x (${r.ok ? 'served' : 'refused ' + r.code})`);
  }

  process.stdout.write('\n[T] concurrent requests cannot exceed the daily quota\n');
  { await db.doc(quotaPath).set({ count: 450, merchantKey: keyOf(new Set([Q])), day });
    const n0 = SENT.length;
    armBarrier(2, 5000);
    const rs = await Promise.all([
      send(Q, { merchantId: Q, customerIds: Array.from({ length: 30 }, (_, i) => 'L8Q' + i), message: 'x' }),
      send(Q, { merchantId: Q, customerIds: Array.from({ length: 30 }, (_, i) => 'L8Q' + (30 + i)), message: 'x' }),
    ]);
    const met = BAR.met; disarmBarrier();
    const served = rs.filter((r) => r.ok).length, refused = rs.filter((r) => !r.ok && r.code === 'resource-exhausted').length;
    const final = await count(quotaPath), sent = SENT.length - n0;
    ok(served === 1 && refused === 1 && final === 480 && final <= MAX && sent === 30, 'T-1',
      `two concurrent requests of 30 at 450/${MAX}: served=${served} refused=${refused} day=${final} (never 510) sends=${sent} (barrier met=${met})`);
  }
  { await db.doc(quotaPath).set({ count: 460, merchantKey: keyOf(new Set([Q])), day });
    const n0 = SENT.length;
    armBarrier(3, 5000);
    const rs = await Promise.all([0, 20, 40].map((o) =>
      send(Q, { merchantId: Q, customerIds: Array.from({ length: 20 }, (_, i) => 'L8Q' + (o + i)), message: 'x' })));
    const met = BAR.met; disarmBarrier();
    const served = rs.filter((r) => r.ok).length, refused = rs.filter((r) => !r.ok && r.code === 'resource-exhausted').length;
    const final = await count(quotaPath), sent = SENT.length - n0;
    ok(served === 2 && refused === 1 && final === MAX && sent === 40, 'T-2',
      `three concurrent requests of 20 at 460/${MAX}: served=${served} refused=${refused} day=${final} (never above ${MAX}) sends=${sent} (barrier met=${met})`);
  }

  clearTimeout(WATCHDOG);
  process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { process.stdout.write('  ✖ CRASH — ' + (e && e.stack || e) + '\n'); process.exit(4); });
