#!/usr/bin/env node
'use strict';
/* ============================================================================
   WhatsApp consent (2026-10-03) — functions/whatsapp-consent.js + the webhook STOP path.
     K1–K8  setConsent: own account only, number read server-side, tied to that number, audited, idempotent
     S1–S6  inbound STOP → opt-out of every account on that number; body never stored; retry-safe
   In-memory Firestore stand-in (transactions, where/limit). No network, no emulator.
   NODE_PATH=<functions/node_modules> node scripts/test-whatsapp-consent.js
   ============================================================================ */
const path = require('path'), crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const C = require(path.join(ROOT, 'functions/whatsapp-consent.js'));
const WH = require(path.join(ROOT, 'functions/whatsapp-webhook.js'));
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 240) : '')); } };

function fakeFs (seed) {
  const cols = {}; let auto = 0;
  const col = (n) => (cols[n] = cols[n] || {});
  Object.entries(seed || {}).forEach(([k, v]) => { const [c, id] = k.split('/'); col(c)[id] = JSON.parse(JSON.stringify(v)); });
  const docRef = (c, id) => ({ c, id: id || ('auto' + (++auto)) });
  const api = {
    cols,
    collection (c) {
      return {
        doc: (id) => docRef(c, id),
        where (f, op, v) { return { limit: () => ({ get: async () => { const hits = Object.entries(col(c)).filter(([, d]) => d[f] === v); return { forEach: (fn) => hits.forEach(([id]) => fn({ id })) }; } }) }; },
      };
    },
    async runTransaction (fn) {
      const writes = [];
      const tx = {
        get: async (r) => { const d = col(r.c)[r.id]; return { exists: !!d, data: () => (d ? JSON.parse(JSON.stringify(d)) : undefined) }; },
        update: (r, p) => writes.push(() => { Object.assign(col(r.c)[r.id], p); }),
        set: (r, p) => writes.push(() => { col(r.c)[r.id] = p; }),
      };
      const out = await fn(tx);
      writes.forEach((w) => w());   /* all-or-nothing, after the reads */
      return out;
    },
  };
  return api;
}
const deps = (f) => ({ firestore: f, serverTimestamp: () => 'SERVER_TS' });
const events = (f) => Object.values(f.cols[C.EVENTS] || {});

(async () => {
  console.log('\n── K: setConsent ──');
  let f = fakeFs({ 'users/a': { phoneNumber: '0712345678' }, 'users/b': { phoneNumber: '' } });
  let r = await C.setConsent({ uid: 'a', optIn: true, source: 'profile' }, deps(f));
  const ua = f.cols.users.a;
  ck('K1 opt-in records flag + the number (normalised from the ACCOUNT, not the browser) + version + server time',
    r.changed && ua.whatsappOptIn === true && ua.whatsappOptInPhone === '254712345678' && ua.whatsappConsentVersion === C.CONSENT_VERSION && ua.whatsappConsentAt === 'SERVER_TS', ua);
  const ev = events(f);
  ck('K2 one audit row: uid, optIn, source, version, MASKED number (never the full number)', ev.length === 1 && ev[0].uid === 'a' && ev[0].optIn === true && ev[0].phoneMasked === '25471*****78' && !JSON.stringify(ev[0]).includes('254712345678'), ev);
  r = await C.setConsent({ uid: 'a', optIn: true, source: 'profile' }, deps(f));
  ck('K3 a second tap changes nothing and writes no audit row', r.changed === false && events(f).length === 1);
  let err = null; try { await C.setConsent({ uid: 'b', optIn: true, source: 'profile' }, deps(f)); } catch (e) { err = e; }
  ck('K4 no phone on the account → refused (NO_PHONE), nothing written', err && err.message === 'NO_PHONE' && f.cols.users.b.whatsappOptIn === undefined && events(f).length === 1);
  r = await C.setConsent({ uid: 'a', optIn: false, source: 'profile' }, deps(f));
  ck('K5 opt-out clears flag and number, audited', r.changed && f.cols.users.a.whatsappOptIn === false && f.cols.users.a.whatsappOptInPhone === null && events(f).length === 2 && events(f)[1].optIn === false);
  err = null; try { await C.setConsent({ uid: 'a', optIn: 'yes', source: 'profile' }, deps(f)); } catch (e) { err = e; }
  let err2 = null; try { await C.setConsent({ uid: 'a', optIn: true, source: 'browser' }, deps(f)); } catch (e) { err2 = e; }
  ck('K6 non-boolean optIn and unknown source are refused', err && err.code === 'invalid-argument' && err2 && err2.code === 'invalid-argument');
  ck('K7 view(): consent for an OLD number reads as NOT opted in and phoneChanged', (() => { const v = C.view({ phoneNumber: '+254799000111', whatsappOptIn: true, whatsappOptInPhone: '254712345678' }); return v.optIn === false && v.phoneChanged === true && v.phoneMasked === '25479*****11'; })());
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-consent.js'), 'utf8');
  ck('K8 the callable takes NO uid parameter: it always acts on request.auth.uid', /setConsent\(\{ uid, optIn: data\.optIn, source: 'profile' \}/.test(src) && !/data\.uid/.test(src));

  console.log('\n── S: STOP from WhatsApp ──');
  ck('S1 STOP words recognised (stop / STOP. / acha / sitisha / unsubscribe); ordinary text is not', ['stop', 'STOP.', ' Acha ', 'sitisha', 'unsubscribe'].every(C.isStopText) && !['stop sending me promos please now ok', 'stopped', 'hello', '', null].some(C.isStopText));
  f = fakeFs({ 'users/x': { phoneNumber: '+254712345678', whatsappOptIn: true, whatsappOptInPhone: '254712345678' },
    'users/y': { phoneNumber: '0712345678', whatsappOptIn: true, whatsappOptInPhone: '254712345678' },
    'users/z': { phoneNumber: '+254700000001', whatsappOptIn: true, whatsappOptInPhone: '254700000001' } });
  r = await C.optOutByPhone('254712345678', deps(f));
  ck('S2 every account on that number (stored as +254… or 07…) is opted out; another number untouched', r.matched === 2 && r.changed === 2 && f.cols.users.x.whatsappOptIn === false && f.cols.users.y.whatsappOptIn === false && f.cols.users.z.whatsappOptIn === true, r);
  r = await C.optOutByPhone('254712345678', deps(f));
  ck('S3 a retried STOP changes nothing (idempotent)', r.changed === 0 && events(f).length === 2);

  const SECRET = 'app_secret_TEST';
  const body = { object: 'whatsapp_business_account', entry: [{ id: 'W1', changes: [{ value: { metadata: { phone_number_id: 'P1' },
    messages: [{ id: 'wamid.STOP1', from: '254700000001', type: 'text', timestamp: '1', text: { body: 'STOP' } },
               { id: 'wamid.HI', from: '254700000001', type: 'text', timestamp: '2', text: { body: 'hello there' } }] } }] }] };
  const raw = Buffer.from(JSON.stringify(body));
  const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
  const store = WH.memoryStore(); const calls = [];
  const out = await WH.handleRequest({ method: 'POST', rawBody: raw, headers: { 'x-hub-signature-256': sig } },
    { appSecret: SECRET, store, optOut: async (from) => { calls.push(from); return C.optOutByPhone(from, deps(f)); } });
  ck('S4 signed STOP → opt-out called once (only for the STOP message), account opted out', out.status === 200 && calls.length === 1 && calls[0] === '254700000001' && f.cols.users.z.whatsappOptIn === false && out.optedOut.changed === 1, { out, calls });
  const rows = JSON.stringify(store._docs);
  ck('S5 the message words are NOT stored — only the optOut boolean', !rows.includes('STOP"') && !rows.includes('hello there') && store._docs['msg_wamid.STOP1'].optOut === true && store._docs['msg_wamid.HI'].optOut === false);
  const calls2 = [];
  const bad = await WH.handleRequest({ method: 'POST', rawBody: raw, headers: { 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) } },
    { appSecret: SECRET, store: WH.memoryStore(), optOut: async (fr) => { calls2.push(fr); return { matched: 0, changed: 0 }; } });
  ck('S6 an UNSIGNED/forged STOP opts nobody out (403 before any consent change)', bad.status === 403 && calls2.length === 0);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
