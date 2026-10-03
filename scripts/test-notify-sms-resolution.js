#!/usr/bin/env node
'use strict';
/* Notifications E2E — step 1: the ENGINE resolves the SMS recipient and ALWAYS records the outcome (owner 2026-10-03).
   Runs the REAL notify() (functions/notify.js) with firebase-admin / sms-service / email stubbed in memory.
   Supersedes scripts/test-notify-sms-recipient.js, whose case 1 ("an explicit caller phone is used verbatim") is now
   FORBIDDEN by the owner rule "do not trust a phone number supplied by the event caller" — inverted here as R-1. */
const path = require('path'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 220) + ']')); ok ? pass++ : fail++; };

/* ── in-memory world ── */
let D = {}, AUTH = {}, ENQ = [], ENQ_MODE = 'ok', PUSH_OK = false, seq = 0;
const ref = (p) => ({ _p: p, id: p.split('/').pop(),
  get: async () => ({ exists: p in D, data: () => (p in D ? JSON.parse(JSON.stringify(D[p])) : undefined) }),
  set: async (v, o) => { D[p] = Object.assign({}, o && o.merge ? D[p] : {}, v); },
  update: async (v) => { D[p] = Object.assign({}, D[p], v); },
  create: async (v) => { if (p in D) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } D[p] = v; } });
const col = (c) => ({ doc: (id) => ref(c + '/' + (id || 'auto' + (++seq))), add: async (v) => { const r = ref(c + '/auto' + (++seq)); D[r._p] = v; return r; },
  where: () => col(c), orderBy: () => col(c), limit: () => col(c), get: async () => ({ docs: [], empty: true, size: 0 }) });
const db = { collection: col, doc: ref };
const FieldValue = { serverTimestamp: () => 'TS', increment: (n) => n, arrayUnion: (...v) => v, arrayRemove: () => [], delete: () => undefined };
const adminStub = { apps: [1], initializeApp() {}, firestore: Object.assign(() => db, { FieldValue, Timestamp: { now: () => ({ toMillis: () => Date.now() }) } }),
  auth: () => ({ getUser: async (u) => { if (!(u in AUTH)) { const e = new Error('no user'); e.code = 'auth/user-not-found'; throw e; } return AUTH[u]; } }),
  messaging: () => ({ sendEachForMulticast: async (m) => ({ successCount: PUSH_OK ? m.tokens.length : 0, failureCount: PUSH_OK ? 0 : m.tokens.length, responses: m.tokens.map(() => ({ success: PUSH_OK, error: PUSH_OK ? null : { code: 'messaging/registration-token-not-registered' } })) }) }) };
const smsStub = { enqueue: async (o) => { ENQ.push(o); if (ENQ_MODE === 'throw') throw new Error('AT 500'); if (ENQ_MODE === 'rate') return { ok: false, reason: 'rate_limited' }; if (ENQ_MODE === 'suppressed') return { ok: true, suppressed: true }; return { ok: true, queued: true }; } };
const stubs = { 'firebase-admin': adminStub, 'firebase-functions/logger': { info() {}, warn() {}, error() {}, debug() {} },
  'firebase-functions/v2/https': { onCall: (_o, h) => h, onRequest: (_o, h) => h, HttpsError: class extends Error {} },
  'firebase-functions/v2/scheduler': { onSchedule: (_o, h) => h }, 'firebase-functions/params': { defineSecret: () => ({ value: () => '' }), defineString: () => ({ value: () => '' }) } };
const local = { 'sms-service': smsStub, 'sokoni-at': {}, 'email-service': { queueEmail: async () => ({ ok: true }), enqueue: async () => ({ ok: true }) }, 'email-templates': new Proxy({}, { get: () => () => ({ subject: 's', html: 'h' }) }),
  'order-advance-authority': {}, 'shop-employees': {} };
const _load = Module._load;
Module._load = function (r, p, m) { if (stubs[r]) return stubs[r]; const b = r.replace(/^\.\//, '').replace(/\.js$/, ''); if (r.startsWith('./') && local[b]) return local[b]; return _load.call(this, r, p, m); };
const N = require(path.join(FN, 'notify.js'));
const RC = require(path.join(FN, 'shared', 'notify-recipient.js'));
Module._load = _load;
const reset = () => { D = {}; AUTH = {}; ENQ = []; ENQ_MODE = 'ok'; PUSH_OK = false; seq = 0; };
const send = async (o) => N.notify(Object.assign({ uid: 'u1', type: 'order_placed', title: 'Order placed', body: 'Your order is in', dedupeKey: 'k' + (++seq) }, o || {}));

(async () => {
  console.log('\nA. normalizeKenyan');
  const nk = (x) => RC.normalizeKenyan(x);
  ck('N-1', nk('0712345678').e164 === '+254712345678' && nk('+254 712 345 678').e164 === '+254712345678' && nk('254112345678').e164 === '+254112345678' && nk('712345678').e164 === '+254712345678', 'Kenyan forms normalise to E.164');
  ck('N-2', nk('+447700900123').reason === 'unsupported_destination' && nk('0612345678').reason === 'invalid_phone' && nk('abc').reason === 'invalid_phone' && nk('+25471234').reason === 'invalid_phone', 'foreign → unsupported_destination; malformed → invalid_phone');

  console.log('\nB. the real notify()');
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' };
  let r = await send({ phone: '+254799999999' });
  ck('R-1', ENQ.length === 1 && ENQ[0].to === '+254712345678' && r.channels.sms === 'queued' && r.delivery.sms.status === 'attempted', 'a phone SUPPLIED BY THE CALLER is ignored — the engine resolves the profile phone (old case 1 inverted, owner rule)', { ENQ, ch: r.channels });
  reset(); D['users/u1'] = {}; AUTH.u1 = { uid: 'u1', phoneNumber: '+254722000111' }; r = await send();
  ck('R-2', ENQ.length === 1 && ENQ[0].to === '+254722000111', 'no profile phone → the verified LOGIN phone (Firebase Auth) is used', ENQ);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; AUTH.u1 = { uid: 'u1', phoneNumber: '+254722000111' }; r = await send();
  ck('R-3', ENQ[0] && ENQ[0].to === '+254712345678', 'precedence: the verified PROFILE phone wins over the login phone', ENQ);
  reset(); D['users/u1'] = { phone: '0712345678' }; r = await send();
  ck('R-4', ENQ.length === 0 && r.channels.sms === 'skipped:no_phone' && r.delivery.sms.status === 'skipped' && r.delivery.sms.reason === 'no_phone', 'nothing usable → skipped:no_phone, recorded (legacy `phone` field still NOT read — old case 4)', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678', phoneVerified: false }; r = await send();
  ck('R-5', ENQ.length === 0 && r.channels.sms === 'skipped:unverified_phone', 'an explicitly UNVERIFIED profile phone is not used', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+447700900123' }; r = await send();
  ck('R-6', ENQ.length === 0 && r.channels.sms === 'skipped:unsupported_destination', 'a non-Kenyan number → skipped:unsupported_destination', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '07123' }; r = await send();
  ck('R-7', ENQ.length === 0 && r.channels.sms === 'skipped:invalid_phone', 'a malformed number → skipped:invalid_phone', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; ENQ_MODE = 'throw'; r = await send();
  ck('R-8', r.channels.sms === 'failed:provider_error' && r.delivery.sms.status === 'failed', 'the queue/provider throws → failed:provider_error (distinct from skipped)', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; ENQ_MODE = 'rate'; r = await send();
  ck('R-9', r.channels.sms === 'failed:rate_limited', 'rate limited → failed:rate_limited', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; ENQ_MODE = 'suppressed'; r = await send();
  ck('R-10', r.channels.sms === 'skipped:sms_disabled', "the user's SMS preference suppresses it → skipped:sms_disabled", r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678', fcmToken: 'T1' }; PUSH_OK = true; r = await send();
  ck('R-11', ENQ.length === 0 && r.channels.sms === 'skipped:push_delivered', 'push landed → SMS NOT sent (fallback only), recorded as skipped:push_delivered', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; r = await send({ type: 'order_preparing' });
  ck('R-12', ENQ.length === 0 && /^skipped:/.test(r.channels.sms), 'a type with no SMS template is NOT SMS-eligible even when push fails — no SMS bill for informational messages', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; r = await send({ type: 'payment_success' });
  ck('R-13', ENQ.length === 1 && r.channels.push && /no_token/.test(r.channels.push) && r.channels.sms === 'queued', 'payment_success with no push token → SMS FALLBACK queued to the resolved phone', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; D['notifyPrefs/u1'] = { orders: { sms: false } }; r = await send();
  ck('R-15', ENQ.length === 0 && r.channels.sms === 'skipped:sms_disabled', 'a user who switched order SMS off → skipped:sms_disabled', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; D['notifyPrefs/u1'] = { quietHours: { enabled: true, from: 0, to: 24 } }; r = await send();
  ck('R-16', ENQ.length === 0 && r.channels.sms === 'skipped:quiet_hours', 'quiet hours → skipped:quiet_hours (in-app still lands)', r.channels);
  reset(); D['users/u1'] = { phoneNumber: '+254712345678' }; r = await send({ type: 'order_placed' });
  ck('R-17', ENQ.length === 1 && r.channels.sms === 'queued', 'ORDER events are SMS-eligible by default (owner policy) — order_placed falls back to SMS when push cannot land', r.channels);
  ck('R-14',!/[^\w]phone\s*\)\s*\{|let to = phone|to:\s*phone\b/.test(require('fs').readFileSync(path.join(FN, 'notify.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')), 'no code path in notify.js sends to the caller-supplied `phone`');
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
