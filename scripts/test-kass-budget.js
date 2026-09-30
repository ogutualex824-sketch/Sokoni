'use strict';
/* KASS auth + budget (owner, 2026-10-01): 30 messages per user per day, a USD 5 per day global ceiling that fails
   CLOSED, a per-user (not spoofable per-IP) rate key, and an invalid token never reaching the model.
   Part A runs functions/kass-budget.js against an in-memory Firestore with transactions and increments.
   Part B loads the REAL sokoniChat handler from functions/index.js (Anthropic stubbed, counting calls).
     node scripts/test-kass-budget.js                 (this tree)
     WH=<other tree> node scripts/test-kass-budget.js (baseline: the live e521e03 must FAIL the B rows) */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(process.env.WH || path.join(__dirname, '..'));
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };

/* ── a small Firestore fake: docs, subcollections, transactions, increment / serverTimestamp, failure injection ── */
function makeDb() {
  const store = new Map(); let failReads = false;
  const INC = Symbol('inc'), TS = Symbol('ts');
  const apply = (cur, patch, merge) => { const out = merge ? { ...(cur || {}) } : {}; for (const [k, v] of Object.entries(patch)) { if (v && v[INC] !== undefined) out[k] = Number(out[k] || 0) + v[INC]; else if (v === TS) out[k] = Date.now(); else out[k] = v; } return out; };
  const ref = (p) => ({ path: p, id: p.split('/').pop(),
    collection: (c) => col(p + '/' + c),
    get: async () => { if (failReads) throw new Error('UNAVAILABLE'); return snap(p); },
    set: async (d, o) => { store.set(p, apply(store.get(p), d, o && o.merge)); } });
  const snap = (p) => ({ exists: store.has(p), data: () => store.get(p), id: p.split('/').pop() });
  const col = (c) => ({ doc: (id) => ref(c + '/' + id) });
  const db = { collection: col, _store: store, failReads: (v) => { failReads = v; },
    runTransaction: async (fn) => { if (failReads) throw new Error('UNAVAILABLE'); const writes = []; const tx = { get: async (r) => snap(r.path), set: (r, d, o) => writes.push([r.path, d, o]) }; const out = await fn(tx); for (const [p, d, o] of writes) store.set(p, apply(store.get(p), d, o && o.merge)); return out; } };
  const admin = { firestore: { FieldValue: { increment: (n) => ({ [INC]: n }), serverTimestamp: () => TS } } };
  return { db, admin };
}

(async () => {
  console.log('\nKASS budget   ROOT=' + ROOT + '\n');
  let B = null; try { B = require(path.join(ROOT, 'functions', 'kass-budget.js')); } catch (_) { B = null; }
  if (!B) { ck('A-0', false, 'functions/kass-budget.js exists'); }
  else {
    const T0 = Date.UTC(2026, 9, 1, 8, 0, 0);
    let { db, admin } = makeDb();
    let ok = 0; for (let i = 0; i < 30; i++) if ((await B.admit(db, admin, 'u1', T0)).ok) ok++;
    const r31 = await B.admit(db, admin, 'u1', T0);
    ck('A-1', ok === 30 && !r31.ok && r31.reason === 'user_quota', 'a user gets exactly 30 messages per day, the 31st is refused', { ok, r31 });
    ck('A-2', (await B.admit(db, admin, 'u2', T0)).ok, 'another user is unaffected by u1\'s quota');
    ck('A-3', (await B.admit(db, admin, 'u1', T0 + 24 * 3600e3)).ok, 'the quota resets on the next Nairobi day');
    ({ db, admin } = makeDb());
    const day = B.nairobiDay(T0);
    await B.admit(db, admin, 'u1', T0);
    /* USD 5 = e.g. 1,000,000 output tokens at USD 5 / MTok */
    await B.meter(db, admin, day, 'u1', { input_tokens: 0, output_tokens: 1000000 });
    const g = await B.admit(db, admin, 'u3', T0);
    ck('A-4', !g.ok && g.reason === 'global_cap', 'once the day\'s spend reaches USD 5, EVERY user is refused', g);
    ck('A-5', (await B.canContinue(db, day)) === false, 'the tool loop stops at the ceiling (canContinue false)');
    const d = db._store.get('aiUsage/' + day) || {};
    ck('A-6', d.date === day && d.totalTokens === 1000000 && Math.abs(d.costUsd - 5) < 1e-9, 'metering writes date / totalTokens / costUsd (what AdminOS adminGetAiStats reads)', d);
    ({ db, admin } = makeDb()); db.failReads(true);
    const fc = await B.admit(db, admin, 'u1', T0);
    ck('A-7', !fc.ok && fc.reason === 'budget_unavailable', 'an unreadable budget FAILS CLOSED', fc);
    ck('A-8', (await B.canContinue(db, day)) === false, 'canContinue also fails closed');
    ({ db, admin } = makeDb());
    await db.collection('config').doc('kassBudget').set({ perUserDaily: 2, globalDailyUsd: 1 });
    let n = 0; for (let i = 0; i < 5; i++) if ((await B.admit(db, admin, 'u9', T0)).ok) n++;
    ck('A-9', n === 2, 'config/kassBudget overrides the defaults (perUserDaily 2)', n);
    ck('A-10', B.DEFAULTS.perUserDaily === 30 && B.DEFAULTS.globalDailyUsd === 5, 'the defaults are the owner\'s decisions: 30/day and USD 5/day');
    ck('A-11', B.nairobiDay(Date.UTC(2026, 9, 1, 21, 30)) === '2026-10-02', 'the day is the Africa/Nairobi day (UTC+3)');
  }

  /* ── Part B: the REAL sokoniChat handler ── */
  const { db, admin } = makeDb();
  let modelCalls = 0, verifyCalls = 0; const rlKeys = [];
  const fakeAdmin = { initializeApp() {}, apps: [{}], app: () => ({}), firestore: Object.assign(() => db, { FieldValue: admin.firestore.FieldValue, Timestamp: { fromMillis: (m) => ({ toMillis: () => m }) } }),
    auth: () => ({ verifyIdToken: async (t) => { verifyCalls++; if (t === 'good') return { uid: 'buyer1' }; const e = new Error('bad'); e.code = 'auth/argument-error'; throw e; } }),
    storage: () => ({ bucket: () => ({}) }), messaging: () => ({}), credential: {} };
  const origLoad = Module._load;
  Module._load = function (req, parent, isMain) {
    if (req === 'firebase-admin' || req.startsWith('firebase-admin/')) return Object.assign({}, fakeAdmin, { default: fakeAdmin, getApps: () => [{}], getApp: () => ({}), getFirestore: () => db, getAuth: () => fakeAdmin.auth(), getStorage: () => fakeAdmin.storage(), getMessaging: () => ({}), FieldValue: admin.firestore.FieldValue, Timestamp: fakeAdmin.firestore.Timestamp, FieldPath: { documentId: () => '__name__' } });
    if (req === '@anthropic-ai/sdk') { const C = function () { return { messages: { create: async () => { modelCalls++; return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 20 } }; } } }; }; C.default = C; C.Anthropic = C; return C; }
    return origLoad.apply(this, arguments);
  };
  let idx = null;
  try { const q = console.log; console.log = () => {}; try { idx = require(path.join(ROOT, 'functions', 'index.js')); } finally { console.log = q; } } catch (e) { ck('B-0', false, 'functions/index.js loads under the harness', String(e.message).slice(0, 120)); }
  Module._load = origLoad;
  const handler = idx && idx.sokoniChat && (idx.sokoniChat.__endpoint ? idx.sokoniChat : idx.sokoniChat);
  const call = (body, headers) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, on() { return this; }, once() { return this; }, removeListener() { return this; }, emit() {}, vary() { return this; }, getHeaders() { return {}; }, removeHeader() {}, status(c) { this.statusCode = c; return this; }, set() { return this; }, setHeader() {}, getHeader() {}, json(b) { resolve({ code: this.statusCode, body: b }); return this; }, send(b) { resolve({ code: this.statusCode, body: b }); return this; }, end(b) { resolve({ code: this.statusCode, body: b }); return this; } };
    const req = { on() { return this; }, once() { return this; }, method: 'POST', url: '/api/chat', headers: Object.assign({ origin: 'https://mysokoni.co.ke' }, headers || {}), body, ip: '9.9.9.9', get(h) { return this.headers[h.toLowerCase()]; }, header(h) { return this.headers[h.toLowerCase()]; } };
    Promise.resolve(handler(req, res)).catch((e) => resolve({ code: 'THREW', body: String(e && e.message) }));
    setTimeout(() => resolve({ code: 'TIMEOUT' }), 20000);
  });
  if (handler) {
    const msgs = [{ role: 'user', content: 'hello' }];
    let r = await call({ messages: msgs, auth_token: 'x' });
    ck('B-1', r.code === 401 && modelCalls === 0, 'an INVALID token ("x") is refused 401 and never reaches the model (the live bypass)', { code: r.code, modelCalls });
    r = await call({ messages: msgs });
    ck('B-2', r.code === 401 && modelCalls === 0, 'a missing token is refused 401', r.code);
    const before = modelCalls;
    r = await call({ messages: msgs, auth_token: 'good' }, { 'x-forwarded-for': '1.2.3.4' });
    ck('B-3', r.code === 200 && modelCalls === before + 1, 'a verified user gets an answer (one model call)', { code: r.code, modelCalls });
    const rl = [...db._store.keys()].filter((k) => k.startsWith('rateLimits/'));
    ck('B-4', rl.some((k) => /chat_uid_buyer1/.test(k)) && !rl.some((k) => /chat_1\.2\.3\.4/.test(k)), 'the rate key is the verified uid, not the spoofable X-Forwarded-For', rl);
    const day = require(path.join(ROOT, 'functions', 'kass-budget.js')).nairobiDay();
    const u = db._store.get('aiUsage/' + day) || {};
    ck('B-5', u.totalTokens === 120 && u.kassCalls === 1, 'the handler meters real usage into aiUsage/{day}', u);
    await db.collection('aiUsage').doc(day).set({ costUsd: 5 }, { merge: true });
    const b2 = modelCalls;
    r = await call({ messages: msgs, auth_token: 'good' });
    ck('B-6', r.code === 429 && modelCalls === b2 && /resting for today/.test(JSON.stringify(r.body)), 'at the USD 5 ceiling the handler refuses BEFORE calling the model', { code: r.code, body: r.body });
  } else if (idx) ck('B-0', false, 'sokoniChat is exported');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack || e)); process.exit(2); });
