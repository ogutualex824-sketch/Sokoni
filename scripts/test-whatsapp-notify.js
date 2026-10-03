#!/usr/bin/env node
/* test-whatsapp-notify.js — WhatsApp inside the ONE notification sender (functions/notify.js), executed.
 *   M  map: every notify type → an APPROVED template with EXACTLY its parameter keys; only types that already
 *      have an SMS are mapped (WhatsApp replaces an SMS, never adds a channel); amounts are never reinterpreted
 *   C  _whatsappChannel gates, each proven with no Graph call: unmapped → null, NOT_CONFIGURED, NO_CONSENT,
 *      NO_PHONE, BAD_PARAM; recipient = the account's OWN phoneNumber; record carries ref + channel, no params
 *   N  notify() end to end (fake Firestore / FCM / Graph, sms-service stubbed — NOTHING is sent):
 *      accepted → SMS not sent (the PIN is never sent twice); not configured / refused → SMS exactly once;
 *      notifySend (browser) never reaches WhatsApp; a PIN appears nowhere but the Graph request
 *   Z  negative controls
 * Run: node scripts/test-whatsapp-notify.js   (needs functions/node_modules, or NODE_PATH to one)
 */
'use strict';
const path = require('path'), Module = require('module');
const FN = path.join(__dirname, '..', 'functions');
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };
const PIN = '583014';

/* ── fake firebase-admin (in memory) ─────────────────────────────────────── */
const DB = {};
const col = (n) => (DB[n] = DB[n] || {});
let autoId = 0;
function docRef (n, id) {
  return {
    id,
    async get () { const d = col(n)[id]; return { exists: !!d, data: () => d, id }; },
    async create (v) { if (col(n)[id]) throw Object.assign(new Error('already exists'), { code: 6 }); col(n)[id] = { ...v }; },
    async set (v, o) { col(n)[id] = o && o.merge ? { ...(col(n)[id] || {}), ...v } : { ...v }; },
    async update (v) { if (!col(n)[id]) throw new Error('no doc'); Object.assign(col(n)[id], v); },
  };
}
const fakeFs = {
  collection: (n) => ({ doc: (id) => docRef(n, id), add: async (v) => { const id = 'auto' + (++autoId); col(n)[id] = { ...v }; return { id }; } }),
  runTransaction: async (fn) => fn({ get: (r) => r.get(), update: (r, v) => { Object.assign(col(r._n)[r.id], v); } }),
};
const fsFn = () => fakeFs;
fsFn.FieldValue = { serverTimestamp: () => 'TS', arrayRemove: (...a) => ({ arrayRemove: a }), increment: (n) => ({ inc: n }) };
let pushReply = { successCount: 0, failureCount: 1, responses: [{ success: false, error: { code: 'messaging/unknown' } }] };
const fakeAdmin = {
  apps: [{}], initializeApp () {}, firestore: fsFn,
  messaging: () => ({ sendEachForMulticast: async () => pushReply }),
  auth: () => ({ getUser: async () => ({ email: null }) }),
};
const smsCalls = [];
let smsTotal = 0;
const fakeSms = { enqueue: async (m) => { smsTotal++; smsCalls.push(m); return { queued: true }; }, TEMPLATES: {} };
const fakeEmail = { FROM: { payments: 'p', notifications: 'n', marketplace: 'm' }, queue: async () => ({}) };
const origLoad = Module._load;
Module._load = function (req, parent, isMain) {
  if (req === 'firebase-admin') return fakeAdmin;
  if (/[\\/]sms-service$/.test(req) || req === './sms-service') return fakeSms;
  if (req === './email-service') return fakeEmail;
  return origLoad.apply(this, arguments);
};

const T = require(path.join(FN, 'shared', 'whatsapp-templates.js'));
const MAPM = require(path.join(FN, 'shared', 'whatsapp-notify-map.js'));
const N = require(path.join(FN, 'notify.js'));
const W = require(path.join(FN, 'whatsapp-sender.js'));

function fakeGraph (reply) {
  const calls = [];
  const f = async (url, opt) => { calls.push({ url, body: JSON.parse(opt.body), auth: opt.headers.Authorization }); return reply(calls.length); };
  f.calls = calls; return f;
}
const okReply = (n) => ({ ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.N' + n }] }) });
const metaRefuses = () => ({ ok: false, status: 400, json: async () => ({ error: { code: 131030, message: 'Recipient not in allowed list' } }) });
const CFG = { accessToken: 'tok_TEST', phoneNumberId: '1234567890' };
/* 2026-10-03: consent is the record whatsapp-consent.js writes — the flag AND the number it was given for. */
const USER = { displayName: 'Akinyi Otieno', phoneNumber: '+254712345678', whatsappOptIn: true, whatsappOptInPhone: '254712345678' };

(async () => {
  const logs = []; const orig = { warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  ['warn', 'error', 'info', 'debug'].forEach((k) => { console[k] = (...a) => { logs.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')); }; });
  const ow = process.stdout.write.bind(process.stdout), oe = process.stderr.write.bind(process.stderr);
  /* firebase-functions/logger writes straight to stdout/stderr, not via console — capture both streams too */
  process.stdout.write = (c, ...a) => { logs.push(String(c)); return ow(c, ...a); };
  process.stderr.write = (c, ...a) => { logs.push(String(c)); return oe(c, ...a); };
  let smsEver = 0;

  console.log('\n── M: map ──');
  const types = Object.keys(MAPM.MAP);
  const exact = types.every((ty) => { const p = MAPM.resolve(ty, {}, 'x'); const d = T.get(p.template); return d && Object.keys(p.params).sort().join() === d.params.slice().sort().join(); });
  ck('M1 every mapped type → an approved template with EXACTLY its parameter keys', exact, types);
  ck('M2 only types that already carry an SMS are mapped (WhatsApp replaces an SMS, never adds a channel)', types.every((ty) => N.TYPES[ty] && N.TYPES[ty].smsTemplate), types.filter((ty) => !(N.TYPES[ty] && N.TYPES[ty].smsTemplate)));
  ck('M3 secret types map ONLY to authentication templates', ['otp', 'phone_verification', 'payment_verification'].every((ty) => T.get(MAPM.MAP[ty].template).secret === true));
  ck('M4 amounts: KES 1,200 / 1200 / "1200" → 1,200; a non-KES figure is left undefined (never reinterpreted)',
    MAPM.kes('KES 1,200') === '1,200' && MAPM.kes(1200) === '1,200' && MAPM.kes('1200') === '1,200' && MAPM.kes('USD 12') === undefined && MAPM.kes('about 500') === undefined && MAPM.kes(-5) === undefined,
    [MAPM.kes('KES 1,200'), MAPM.kes(1200), MAPM.kes('USD 12')]);
  ck('M5 unmapped type → null (password_reset, wallet_debit, promotion keep today\'s behaviour)', ['password_reset', 'wallet_debit', 'promotion', 'booking_new'].every((ty) => MAPM.resolve(ty, {}, 'x') === null));
  ck('M6 the greeting name is one plain line (no newline/tab reaches Meta)', MAPM.displayName({ displayName: 'A\nB\tC' }) === 'A B C' && MAPM.displayName({}) === undefined);

  console.log('\n── C: _whatsappChannel gates ──');
  let g = fakeGraph(okReply), store = W.memorySends(), reads = 0;
  const readUser = async () => { reads++; return USER; };
  ck('C1 a type that never goes by WhatsApp → null, no Graph call', (await N._whatsappChannel({ uid: 'u1', type: 'wallet_debit', vars: {}, key: 'k' }, { config: CFG, fetch: g, store, readUser })) === null && g.calls.length === 0);
  let r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k' }, { config: { accessToken: '', phoneNumberId: '' }, fetch: g, store, readUser });
  ck('C2 secrets not deployed → NOT_CONFIGURED, no Graph call, user not even read', r.error === 'NOT_CONFIGURED' && g.calls.length === 0 && reads === 0, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k' }, { config: CFG, fetch: g, store, readUser: async () => ({ ...USER, whatsappOptIn: undefined }) });
  ck('C3 no consent (whatsappOptIn !== true) → NO_CONSENT, no Graph call', r.error === 'NO_CONSENT' && g.calls.length === 0, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k' }, { config: CFG, fetch: g, store, readUser: async () => ({ ...USER, whatsappOptInPhone: undefined }) });
  ck('C3b flag set WITHOUT the consent record (e.g. a self-written whatsappOptIn) → NO_CONSENT, no Graph call', r.error === 'NO_CONSENT' && g.calls.length === 0, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k' }, { config: CFG, fetch: g, store, readUser: async () => ({ ...USER, phoneNumber: '+254799000111' }) });
  ck('C3c phone changed since consent → NO_CONSENT (the new number agreed to nothing), no Graph call', r.error === 'NO_CONSENT' && g.calls.length === 0, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k' }, { config: CFG, fetch: g, store, readUser: async () => ({ ...USER, phoneNumber: '' }) });
  ck('C4 no verified phone → NO_PHONE, no Graph call', r.error === 'NO_PHONE' && g.calls.length === 0, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'payment_success', vars: { amount: 'USD 12', ref: 'R1' }, key: 'k' }, { config: CFG, fetch: g, store, readUser });
  ck('C5 a parameter that does not fit the template → BAD_PARAM before Meta (fail closed, no substitute)', r.error === 'BAD_PARAM' && g.calls.length === 0, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'order_placed', vars: { orderId: 'SO-1', total: 'KES 2,400', phone: '0799000111' }, key: 'order_placed:u1:x' }, { config: CFG, fetch: g, store, readUser });
  const c1 = g.calls[0];
  ck('C6 recipient = the account\'s OWN phoneNumber (a vars/caller phone is ignored)', c1 && c1.body.to === '254712345678', c1 && c1.body.to);
  ck('C7 order_placed → order_confirmation [name, orderRef, amountKES] in order', c1 && c1.body.template.name === 'order_confirmation' && c1.body.template.components[0].parameters.map((p) => p.text).join('|') === 'Akinyi Otieno|SO-1|2,400', c1 && c1.body.template);
  const rec = store._docs[r.messageId];
  ck('C8 accepted → record ref = notifyLog key, channel WHATSAPP, masked number, no params', r.ok && rec && rec.ref === 'order_placed:u1:x' && rec.channel === 'WHATSAPP' && rec.toMasked === '25471*****78' && !('params' in rec), rec);
  g = fakeGraph(metaRefuses);
  r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k2' }, { config: CFG, fetch: g, store, readUser });
  ck('C9 Meta refuses → ok:false META_<code>, no record, never delivered', r.ok === false && r.error === 'META_131030' && Object.keys(store._docs).length === 1, r);
  r = await N._whatsappChannel({ uid: 'u1', type: 'otp', vars: { code: PIN }, key: 'k3' }, { config: CFG, fetch: g, store, readUser: async () => { throw new Error('boom ' + PIN); } });
  ck('C10 an internal error → INTERNAL, never thrown into notify(), error text (could echo a PIN) not logged', r.error === 'INTERNAL' && !logs.join('\n').includes(PIN), r);

  console.log('\n── N: notify() end to end ──');
  const graph = fakeGraph(okReply); globalThis.fetch = graph;
  const setEnv = (on) => { if (on) { process.env.WHATSAPP_ACCESS_TOKEN = 'tok_TEST'; process.env.WHATSAPP_PHONE_NUMBER_ID = '1234567890'; } else { delete process.env.WHATSAPP_ACCESS_TOKEN; delete process.env.WHATSAPP_PHONE_NUMBER_ID; } };
  col('users').u1 = { ...USER };

  setEnv(true); smsCalls.length = 0;
  let res = await N.notify({ uid: 'u1', type: 'otp', title: 'Code', body: 'Your code', vars: { code: PIN }, dedupeKey: 'otp:u1:1' });
  ck('N1 configured + consent: OTP → WhatsApp accepted, channels.whatsapp=accepted, the wamid returned', res.channels.whatsapp === 'accepted' && /^wamid\./.test(res.whatsappMessageId), res);
  ck('N2 … and the SMS is NOT sent — the PIN is never delivered twice', smsCalls.length === 0 && res.channels.sms === 'not_needed_whatsapp_accepted', { sms: smsCalls.length, ch: res.channels });
  const sendDoc = DB.whatsappSends && DB.whatsappSends[res.whatsappMessageId];
  ck('N3 whatsappSends/{wamid} correlates to notifyLog/{key}; status accepted; no PIN in it', sendDoc && sendDoc.ref === 'otp:u1:1' && sendDoc.status === 'accepted' && !JSON.stringify(sendDoc).includes(PIN), sendDoc);
  ck('N4 notifyLog/{key} records the channel result and never the PIN', DB.notifyLog['otp:u1:1'].channels.whatsapp === 'accepted' && !JSON.stringify(DB.notifyLog['otp:u1:1']).includes(PIN), DB.notifyLog['otp:u1:1']);

  setEnv(false); smsCalls.length = 0; const before = graph.calls.length;
  res = await N.notify({ uid: 'u1', type: 'otp', title: 'Code', body: 'Your code', vars: { code: PIN }, dedupeKey: 'otp:u1:2' });
  ck('N5 secrets absent → whatsapp failed:NOT_CONFIGURED, no Graph call, SMS queued EXACTLY once (today\'s path)', res.channels.whatsapp === 'failed:NOT_CONFIGURED' && graph.calls.length === before && smsCalls.length === 1 && res.channels.sms === 'queued', { ch: res.channels, sms: smsCalls.length });

  setEnv(true); smsCalls.length = 0; globalThis.fetch = fakeGraph(metaRefuses);
  res = await N.notify({ uid: 'u1', type: 'otp', title: 'Code', body: 'Your code', vars: { code: PIN }, dedupeKey: 'otp:u1:3' });
  ck('N6 Meta refuses → whatsapp failed:META_131030, SMS fallback queued exactly once, no fake success', res.channels.whatsapp === 'failed:META_131030' && smsCalls.length === 1 && !res.whatsappMessageId, { ch: res.channels, sms: smsCalls.length });

  globalThis.fetch = graph; smsCalls.length = 0; const b2 = graph.calls.length;
  res = await N.notify({ uid: 'u1', type: 'otp', title: 'Code', body: 'x', vars: { code: PIN }, dedupeKey: 'otp:u1:4', whatsapp: false });
  ck('N7 whatsapp:false (the notifySend path) → no Graph call, SMS as today', graph.calls.length === b2 && smsCalls.length === 1 && !('whatsapp' in res.channels), res.channels);

  smsCalls.length = 0; const b3 = graph.calls.length;
  res = await N.notify({ uid: 'u1', type: 'wallet_debit', title: 'Debit', body: 'x', vars: { amount: 'KES 10' }, dedupeKey: 'wd:u1:1' });
  ck('N8 an unmapped type is untouched: no Graph call, no whatsapp channel row, SMS as today', graph.calls.length === b3 && !('whatsapp' in res.channels) && smsCalls.length === 1, res.channels);

  col('users').u1.fcmToken = 'tokA'; pushReply = { successCount: 1, failureCount: 0, responses: [{ success: true }] };
  smsCalls.length = 0; const b4 = graph.calls.length;
  res = await N.notify({ uid: 'u1', type: 'order_delivered', title: 'Delivered', body: 'x', vars: { orderId: 'SO-2' }, dedupeKey: 'od:u1:1' });
  ck('N9 commerce message whose push landed → neither SMS nor WhatsApp (WhatsApp only where an SMS would go)', graph.calls.length === b4 && smsCalls.length === 0 && !('whatsapp' in res.channels), res.channels);
  delete col('users').u1.fcmToken;

  /* the browser boundary: run the real notifySend handler with a forged whatsapp:true */
  const nsSrc = require('fs').readFileSync(path.join(FN, 'notify.js'), 'utf8');
  const handler = N.notifySend && (N.notifySend.run || N.notifySend.__trigger && null);
  smsCalls.length = 0; const b5 = graph.calls.length;
  if (typeof handler === 'function') {
    await handler({ auth: { uid: 'u1' }, data: { type: 'otp', title: 'x', body: 'x', vars: { code: PIN }, whatsapp: true, dedupeKey: 'ns:1' } });
    ck('N10 notifySend with a forged whatsapp:true → NO Graph call (browser can never reach WhatsApp)', graph.calls.length === b5, graph.calls.length - b5);
  } else {
    ck('N10 notifySend forces whatsapp:false AFTER the spread (handler not runnable here — source check)', /\.\.\.request\.data,[^)]*whatsapp:\s*false\s*\}\)/.test(nsSrc));
  }

  const allLogs = logs.join('\n');
  ck('N11 no PIN in ANY log line across the whole run', !allLogs.includes(PIN), allLogs.slice(0, 300));
  ck('N12 no PIN in notifyLog, notifications or whatsappSends', ['notifyLog', 'notifications', 'whatsappSends'].every((n) => !JSON.stringify(DB[n] || {}).includes(PIN)));

  console.log('\n── Z: negative controls ──');
  ck('Z1 the fake Graph DID receive the PIN (proves N11/N12 are not vacuous)', graph.calls.some((c) => JSON.stringify(c.body).includes(PIN)));
  ck('Z2 the SMS stub DID receive calls in this run (proves "exactly once" counts are live)', smsTotal >= 4, smsTotal);
  ck('Z4 the log capture is live: the C10 logger line WAS captured (proves N11 is not vacuous)', logs.some((l) => l.includes('whatsapp channel error')));
  ck('Z3 a mapped type with a resolvable payload DOES reach Graph (gates are not all-refusing)', graph.calls.length > 0);

  Object.assign(console, orig); Module._load = origLoad; process.stdout.write = ow; process.stderr.write = oe;
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH ' + (e && e.stack)); process.exit(2); });
