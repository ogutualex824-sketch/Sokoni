#!/usr/bin/env node
/* ============================================================================
   scripts/test-whatsapp-webhook.js
   ============================================================================
   Certifies the WhatsApp inbound receiver. Inbound only — nothing here sends,
   because nothing in the slice can.

   THE ONE THING THIS SUITE EXISTS TO PREVENT
   -------------------------------------------
   `webhookSmartpos` shipped public and unsigned. Every refusal below therefore
   has an INVERTING CONTROL: a valid request of the same shape must be ACCEPTED.
   A receiver that rejects everything is as broken as one that accepts
   everything, and only the pair distinguishes them.

   No network, no Firestore, no credentials. The secrets are injected, so the
   suite proves the logic that will run — not a paraphrase of it.
   ============================================================================ */
'use strict';

const path = require('path');
const crypto = require('crypto');
const ROOT = path.resolve(__dirname, '..');
const wa = require(path.join(ROOT, 'functions/whatsapp-webhook.js'));

let pass = 0, fail = 0;
const T = async (name, fn) => {
  try { await fn(); pass++; console.log('  PASS  ' + name); }
  catch (e) { fail++; console.log('  FAIL  ' + name + '\n        ' + (e && e.message)); }
};
const eq = (a, b, m) => { if (a !== b) throw new Error((m || '') + 'expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); };
const ok = (c, m) => { if (!c) throw new Error(m || 'expected truthy'); };
const sec = (s) => console.log('\n' + s + '\n' + '-'.repeat(s.length));

const VERIFY_TOKEN = 'a-verify-token-value';
const APP_SECRET   = 'an-app-secret-value';

const sign = (raw, secret) =>
  'sha256=' + crypto.createHmac('sha256', secret || APP_SECRET).update(raw).digest('hex');

function post (payloadObj, opts) {
  const o = opts || {};
  const raw = Buffer.from(o.rawOverride !== undefined ? o.rawOverride : JSON.stringify(payloadObj), 'utf8');
  return {
    method: 'POST',
    rawBody: o.dropRawBody ? undefined : raw,
    body: payloadObj,
    /* `!== undefined`, not `||`. With `||`, an EMPTY-STRING override is falsy
       and silently replaced by a VALID signature — so the empty-signature case
       never reached the module and the test passed by accepting a good request.
       A harness that quietly substitutes a valid credential for the invalid one
       under test is worse than no test. */
    headers: o.noSig ? {}
      : { 'x-hub-signature-256': o.sigOverride !== undefined ? o.sigOverride : sign(raw, o.secret) },
  };
}
const get = (q) => ({ method: 'GET', query: q, headers: {} });

/* A realistic Cloud API payload: one inbound message and one status callback. */
function metaPayload () {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_ID_1',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '254700000000', phone_number_id: 'PNID_1' },
          contacts: [{ profile: { name: 'A Customer' }, wa_id: '254711111111' }],
          messages: [{
            from: '254711111111', id: 'wamid.AAA', timestamp: '1759100000',
            type: 'text', text: { body: 'Is the Axio still available?' },
          }],
          statuses: [{
            id: 'wamid.BBB', status: 'delivered', timestamp: '1759100001',
            recipient_id: '254722222222',
          }],
        },
      }],
    }],
  };
}

(async function main () {

sec('1 · THE VERIFICATION HANDSHAKE (GET)');

await T('a correct handshake returns the challenge as a RAW body', async () => {
  const r = await wa.handleRequest(
    get({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN, 'hub.challenge': '1158201444' }),
    { verifyToken: VERIFY_TOKEN });
  eq(r.status, 200, '');
  eq(r.body, '1158201444', 'the challenge must be echoed verbatim, not wrapped in JSON: ');
});

await T('REFUSES a wrong verify token', async () => {
  const r = await wa.handleRequest(
    get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'wrong-token-value', 'hub.challenge': 'x' }),
    { verifyToken: VERIFY_TOKEN });
  eq(r.status, 403, '');
  eq(r.reason, 'token_mismatch', '');
});

await T('REFUSES when the verify token is NOT CONFIGURED — inert, not permissive', async () => {
  /* The failure that matters most. An unconfigured receiver that verified any
     subscription would hand the endpoint to whoever asked first. */
  const r = await wa.handleRequest(
    get({ 'hub.mode': 'subscribe', 'hub.verify_token': 'anything', 'hub.challenge': 'x' }), {});
  eq(r.status, 403, '');
  eq(r.reason, 'verify_token_not_configured', '');
});

await T('REFUSES a wrong mode, and a missing challenge', async () => {
  eq((await wa.handleRequest(get({ 'hub.mode': 'unsubscribe', 'hub.verify_token': VERIFY_TOKEN,
      'hub.challenge': 'x' }), { verifyToken: VERIFY_TOKEN })).reason, 'bad_mode', '');
  eq((await wa.handleRequest(get({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY_TOKEN }),
      { verifyToken: VERIFY_TOKEN })).reason, 'missing_challenge', '');
});

await T('the token compare is CONSTANT TIME and length-safe', () => {
  /* timingSafeEqual throws on a length mismatch, so a shorter guess must be
     refused rather than crash the handler — and the length of a token is not
     the secret being protected. */
  eq(wa.verifyChallenge({ 'hub.mode': 'subscribe', 'hub.verify_token': 'short',
    'hub.challenge': 'c' }, VERIFY_TOKEN).reason, 'token_mismatch', '');
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  ok(/timingSafeEqual/.test(src), 'the compare must be constant time');
  ok(!/token\s*===\s*expectedToken/.test(src), 'a plain === on the secret leaks its prefix by timing');
});

sec('2 · THE PAYLOAD SIGNATURE (POST) — every refusal with its control');

await T('CONTROL — a correctly signed payload is ACCEPTED', async () => {
  const r = await wa.handleRequest(post(metaPayload()),
    { appSecret: APP_SECRET, store: wa.memoryStore() });
  eq(r.status, 200, '');
  eq(r.body, 'EVENT_RECEIVED', '');
  eq(r.events, 2, 'one message and one status: ');
});

await T('REFUSES an absent signature header', async () => {
  const r = await wa.handleRequest(post(metaPayload(), { noSig: true }), { appSecret: APP_SECRET });
  eq(r.status, 403, '');
  eq(r.reason, 'no_signature_header', '');
});

await T('REFUSES a signature computed with the WRONG secret', async () => {
  const r = await wa.handleRequest(post(metaPayload(), { secret: 'not-the-app-secret' }),
    { appSecret: APP_SECRET });
  eq(r.status, 403, '');
  eq(r.reason, 'signature_mismatch', '');
});

await T('REFUSES a malformed signature — wrong prefix, wrong length, not hex', async () => {
  const p = metaPayload();
  const cases = ['sha1=' + 'a'.repeat(40), 'sha256=' + 'a'.repeat(63), 'sha256=zz' + 'a'.repeat(62),
                 'deadbeef', ''];
  for (const s of cases) {
    const r = await wa.handleRequest(post(p, { sigOverride: s }), { appSecret: APP_SECRET });
    eq(r.status, 403, JSON.stringify(s) + ': ');
  }
});

await T('REFUSES a TAMPERED body whose signature was valid for the original', async () => {
  /* The attack the signature exists to stop: a real signature, a changed
     payload. */
  const original = JSON.stringify(metaPayload());
  const tampered = original.replace('254711111111', '254799999999');
  ok(original !== tampered, 'control: the tamper must actually change the bytes');
  const r = await wa.handleRequest({
    method: 'POST',
    rawBody: Buffer.from(tampered, 'utf8'),
    headers: { 'x-hub-signature-256': sign(Buffer.from(original, 'utf8')) },
  }, { appSecret: APP_SECRET });
  eq(r.status, 403, '');
  eq(r.reason, 'signature_mismatch', '');
});

await T('REFUSES when the APP SECRET is not configured — inert, not open', async () => {
  const r = await wa.handleRequest(post(metaPayload()), { store: wa.memoryStore() });
  eq(r.status, 403, '');
  eq(r.reason, 'app_secret_not_configured',
    'an unconfigured receiver must be INERT; accepting everything would look like it works: ');
});

await T('REFUSES when the RAW BODY is unavailable rather than re-serialising', async () => {
  /* JSON.stringify(req.body) is a different byte sequence from what Meta
     signed. Verifying against it would fail valid requests — and the tempting
     "fix" is to weaken the check. */
  const r = await wa.handleRequest(post(metaPayload(), { dropRawBody: true }), { appSecret: APP_SECRET });
  eq(r.status, 403, '');
  eq(r.reason, 'no_raw_body', '');
  /* Asserted on STRIPPED source. The module's own comment explains why
     JSON.stringify(req.body) must not be used — so the assertion was matching
     the prose warning against the practice, and would have failed however
     correct the code was. The same defect the B10 check had. */
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  ok(bare.length < src.length, 'control: the comment stripper is not a no-op');
  ok(!/JSON\.stringify\(req\.body\)/.test(bare),
     'the signature must never be checked against a re-serialisation');
});

await T('a non-GET, non-POST method is refused', async () => {
  eq((await wa.handleRequest({ method: 'DELETE', headers: {} }, { appSecret: APP_SECRET })).status, 405, '');
});

await T('the refusal reason is NOT returned to the caller', async () => {
  /* Telling an unauthenticated caller why their signature failed is a probing
     oracle. The reason is for our logs. */
  const r = await wa.handleRequest(post(metaPayload(), { secret: 'wrong' }), { appSecret: APP_SECRET });
  eq(r.body, 'Forbidden', 'the BODY must not carry the reason: ');
  ok(r.reason, 'though it is still available internally for logging');
});

sec('3 · NORMALISATION — and what is deliberately NOT stored');

await T('messages and statuses are both flattened, with stable ids', () => {
  const n = wa.normalise(metaPayload());
  eq(n.events.length, 2, '');
  const msg = n.events.find((e) => e.kind === 'message');
  const st  = n.events.find((e) => e.kind === 'status');
  eq(msg.wamid, 'wamid.AAA', '');
  eq(msg.from, '254711111111', '');
  eq(msg.type, 'text', '');
  eq(msg.phoneNumberId, 'PNID_1', '');
  eq(st.status, 'delivered', '');
  eq(st.recipient, '254722222222', '');
});

await T('the MESSAGE BODY is not stored — that belongs to the conversation store', () => {
  const n = wa.normalise(metaPayload());
  const flat = JSON.stringify(n.events);
  ok(flat.indexOf('Is the Axio still available?') === -1,
    'a customer’s words must not land in a diagnostic collection');
  ok(flat.indexOf('A Customer') === -1, 'nor their profile name');
  /* CONTROL — the text really was present in the input, so the absence means
     something. */
  ok(JSON.stringify(metaPayload()).indexOf('Is the Axio still available?') > -1,
    'control: the fixture must actually contain the body');
});

await T('an unexpected object type is acknowledged but recorded as rejected', async () => {
  const p = { object: 'page', entry: [] };
  const r = await wa.handleRequest(post(p), { appSecret: APP_SECRET, store: wa.memoryStore() });
  eq(r.status, 200, 'a 200 stops Cloud API retrying something it will never fix: ');
  ok(/unexpected_object/.test(r.reason), r.reason);
});

await T('unparseable JSON behind a VALID signature is a 400, not a crash', async () => {
  const raw = '{not json';
  const r = await wa.handleRequest({
    method: 'POST', rawBody: Buffer.from(raw, 'utf8'),
    headers: { 'x-hub-signature-256': sign(Buffer.from(raw, 'utf8')) },
  }, { appSecret: APP_SECRET });
  eq(r.status, 400, '');
  eq(r.reason, 'unparseable_json', '');
});

sec('4 · IDEMPOTENCY — Cloud API retries, and a retry must not duplicate');

await T('the same batch delivered twice writes once', async () => {
  const store = wa.memoryStore();
  const first  = await wa.handleRequest(post(metaPayload()), { appSecret: APP_SECRET, store });
  const second = await wa.handleRequest(post(metaPayload()), { appSecret: APP_SECRET, store });
  eq(first.recorded.written, 2, 'first delivery: ');
  eq(second.recorded.written, 0, 'second delivery must write nothing: ');
  eq(second.recorded.duplicate, 2, 'and must count them as duplicates: ');
  eq(Object.keys(store._docs).length, 2, 'two documents, not four: ');
  eq(second.status, 200, 'a duplicate is a SUCCESS — a non-200 makes Meta retry for ever: ');
});

await T('create(), not set() — a replay cannot overwrite a later status', async () => {
  const store = wa.memoryStore();
  await wa.handleRequest(post(metaPayload()), { appSecret: APP_SECRET, store });
  const before = JSON.stringify(store._docs);
  await wa.handleRequest(post(metaPayload()), { appSecret: APP_SECRET, store });
  eq(JSON.stringify(store._docs), before, 'the stored records must be untouched by the replay: ');
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  ok(!/collection\(COLLECTION\)\.doc\(id\)\.set\(/.test(src), 'the Firestore store must not use set()');
});

await T('distinct statuses for the same message are distinct records', async () => {
  const store = wa.memoryStore();
  const mk = (status) => {
    const p = metaPayload();
    p.entry[0].changes[0].value.messages = [];
    p.entry[0].changes[0].value.statuses = [{ id: 'wamid.BBB', status, timestamp: '1', recipient_id: 'r' }];
    return p;
  };
  await wa.handleRequest(post(mk('sent')),      { appSecret: APP_SECRET, store });
  await wa.handleRequest(post(mk('delivered')), { appSecret: APP_SECRET, store });
  await wa.handleRequest(post(mk('read')),      { appSecret: APP_SECRET, store });
  eq(Object.keys(store._docs).length, 3, 'sent/delivered/read are three facts, not one overwritten: ');
});

sec('5 · THE SLICE BOUNDARY — it receives, and does nothing else');

await T('the module cannot SEND — no Graph call exists in it', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  ok(bare.length < src.length, 'control: the comment stripper is not a no-op');
  ok(!/graph\.facebook\.com/.test(bare), 'inbound only: no send path may exist yet');
  ok(!/fetch\(|axios|https?\.request/.test(bare), 'and no outbound HTTP of any kind');
});

await T('it creates no order, no payment and no auto-reply', () => {
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  ['orders', 'payments', 'intasend', 'checkout', 'notify'].forEach((w) => {
    ok(bare.toLowerCase().indexOf(w) === -1, 'the receiver must not touch ' + w + ' in this slice');
  });
});

await T('it writes to ONE collection, and names it', () => {
  eq(wa.COLLECTION, 'whatsappInbound', '');
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  const bare = src.replace(/\/\*[\s\S]*?\*\//g, '');
  const cols = (bare.match(/\.collection\((?:'([^']+)'|COLLECTION)\)/g) || []);
  ok(cols.every((c) => /COLLECTION/.test(c)), 'a second collection appeared: ' + cols.join(', '));
});

await T('the secrets are NAMED, not embedded', () => {
  eq(wa.SECRET_NAMES.verifyToken, 'WHATSAPP_VERIFY_TOKEN', '');
  eq(wa.SECRET_NAMES.appSecret, 'WHATSAPP_APP_SECRET', '');
  const src = require('fs').readFileSync(path.join(ROOT, 'functions/whatsapp-webhook.js'), 'utf8');
  ok(!/EAA[A-Za-z0-9]{20,}/.test(src), 'no Meta access token may appear in source');
  ok(src.indexOf(VERIFY_TOKEN) === -1 && src.indexOf(APP_SECRET) === -1,
    'no test credential may have leaked into the module');
});

console.log('\n' + '='.repeat(66));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('='.repeat(66));
console.log('\n  PROVEN    the handshake, HMAC-SHA256 over the RAW body, constant-time');
console.log('            compares, and that the receiver is INERT when either secret is');
console.log('            absent rather than permissive. Tamper, wrong-secret, malformed,');
console.log('            missing-header and missing-raw-body all refuse, each with a');
console.log('            control proving a valid request of the same shape is accepted.');
console.log('            Idempotent under Cloud API retries; message BODIES are not stored.');
console.log('  SCOPE     INBOUND ONLY. The module contains no send path, touches no order,');
console.log('            payment or checkout, and writes one collection.');
console.log('  UNPROVEN  a real Meta delivery. No WABA, phone-number-id or credential');
console.log('            exists yet, so nothing has been received from Meta — only');
console.log('            payloads shaped like Meta’s. Not registered, not deployed, and');
console.log('            not exported from functions/index.js.\n');
process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  SUITE CRASHED — a crash is not a pass\n', e); process.exit(1); });
