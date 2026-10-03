#!/usr/bin/env node
/* test-whatsapp-sender.js — the ONE outbound WhatsApp channel (owner 2026-10-01), executed against a fake Graph API.
 *   P  payload: exact Graph shape, Bearer auth, template + language, body params IN ORDER, copy-code button for
 *      authentication templates, Kenyan numbers normalised (never "fixed" into another number)
 *   R  refusals before any network: NOT_CONFIGURED, UNKNOWN_TEMPLATE, PARAMS_MISMATCH, BAD_PARAM, BAD_RECIPIENT
 *   S  TRUE state: ok only with Meta's wamid; Meta error → META_<code>; network error → NETWORK; never "sent" early
 *   X  secrecy: a PIN is passed to Meta and appears NOWHERE ELSE — not in the send record, not in any console line
 *   W  webhook: a signed status callback advances whatsappSends/{wamid} sent→delivered→read; never backwards; failed
 *      never overrides delivered/read; a status for a message that is not ours is ignored
 *   I  the completion-PIN interface sender(phoneOrUid, template, params) resolves a uid SERVER-SIDE
 *   N  negative controls
 * Run: node scripts/test-whatsapp-sender.js
 */
'use strict';
const path = require('path'), crypto = require('crypto');
const W = require(path.join(__dirname, '..', 'functions', 'whatsapp-sender.js'));
const H = require(path.join(__dirname, '..', 'functions', 'whatsapp-webhook.js'));
let pass = 0, fail = 0;
const ck = (l, ok, g) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + JSON.stringify(g) + ']')); ok ? pass++ : fail++; };

function fakeGraph (reply) {
  const calls = [];
  const f = async (url, opt) => { calls.push({ url, opt, body: JSON.parse(opt.body) }); return reply(calls.length); };
  f.calls = calls; return f;
}
const okReply = (n) => ({ ok: true, status: 200, json: async () => ({ messaging_product: 'whatsapp', messages: [{ id: 'wamid.TEST' + n }] }) });
const CFG = { accessToken: 'tok_TEST', phoneNumberId: '1234567890' };
const PIN = '483920';

(async () => {
  /* console capture — nothing secret may reach a log line */
  const logs = []; const orig = { log: console.log, warn: console.warn, error: console.error };
  ['warn', 'error'].forEach((k) => { console[k] = (...a) => { logs.push(a.map(String).join(' ')); }; });

  console.log('\n── P: payload ──');
  let g = fakeGraph(okReply), store = W.memorySends();
  let r = await W.sendTemplate({ to: '0712 345 678', template: 'order_confirmation', params: { name: 'Akinyi', orderRef: 'SO-1048', amountKES: '1,850' }, uid: 'u1' }, Object.assign({ fetch: g, store }, CFG));
  const c = g.calls[0];
  ck('P1 POST to graph.facebook.com/<ver>/<phoneNumberId>/messages with Bearer token', c && /^https:\/\/graph\.facebook\.com\/v\d+\.\d+\/1234567890\/messages$/.test(c.url) && c.opt.headers.Authorization === 'Bearer tok_TEST', c && c.url);
  ck('P2 template name + language + body params IN DECLARED ORDER', c && c.body.type === 'template' && c.body.template.name === 'order_confirmation' && c.body.template.language.code === 'en'
    && JSON.stringify(c.body.template.components[0].parameters.map((x) => x.text)) === JSON.stringify(['Akinyi', 'SO-1048', '1,850']), c && c.body);
  ck('P3 recipient normalised to 2547XXXXXXXX', c && c.body.to === '254712345678', c && c.body.to);
  g = fakeGraph(okReply);
  await W.sendTemplate({ to: '+254712345678', template: 'completion_pin', params: { code: PIN } }, Object.assign({ fetch: g }, CFG));
  const pc = g.calls[0].body.template.components;
  ck('P4 authentication template carries the code as the copy-code URL button param too', pc.length === 2 && pc[1].type === 'button' && pc[1].sub_type === 'url' && pc[1].parameters[0].text === PIN, pc);
  ck('P5 a non-Kenyan or malformed number is refused, not "fixed"', W.normalisePhone('0812345678') === null && W.normalisePhone('+1 415 555 0123') === null && W.normalisePhone('07123456789') === null);

  console.log('\n── R: refusals before any network ──');
  g = fakeGraph(okReply);
  const R = async (m, cfg) => W.sendTemplate(m, Object.assign({ fetch: g }, cfg === undefined ? CFG : cfg));
  ck('R1 no secrets → NOT_CONFIGURED', (await R({ to: '0712345678', template: 'otp_code', params: { code: '1' } }, {})).error === 'NOT_CONFIGURED');
  ck('R2 a template not in the registry → UNKNOWN_TEMPLATE', (await R({ to: '0712345678', template: 'free_text', params: {} })).error === 'UNKNOWN_TEMPLATE');
  ck('R3 missing / extra params → PARAMS_MISMATCH', (await R({ to: '0712345678', template: 'order_ready', params: { name: 'A' } })).error === 'PARAMS_MISMATCH'
    && (await R({ to: '0712345678', template: 'order_ready', params: { name: 'A', orderRef: 'B', x: 'C' } })).error === 'PARAMS_MISMATCH');
  ck('R4 a param with a newline / tab / 5 spaces / empty → BAD_PARAM', (await R({ to: '0712345678', template: 'order_ready', params: { name: 'A\nB', orderRef: 'X' } })).error === 'BAD_PARAM'
    && (await R({ to: '0712345678', template: 'order_ready', params: { name: 'A     B', orderRef: 'X' } })).error === 'BAD_PARAM'
    && (await R({ to: '0712345678', template: 'order_ready', params: { name: '', orderRef: 'X' } })).error === 'BAD_PARAM');
  ck('R5 a bad recipient → BAD_RECIPIENT', (await R({ to: '12345', template: 'order_ready', params: { name: 'A', orderRef: 'X' } })).error === 'BAD_RECIPIENT');
  ck('R6 none of the refusals reached the network', g.calls.length === 0, g.calls.length);

  console.log('\n── S: true state ──');
  ck('S1 accepted → { ok:true, messageId: wamid, error:null }', r.ok === true && r.messageId === 'wamid.TEST1' && r.error === null, r);
  const bad = await W.sendTemplate({ to: '0712345678', template: 'order_ready', params: { name: 'A', orderRef: 'X' } }, Object.assign({ fetch: async () => ({ ok: false, status: 400, json: async () => ({ error: { code: 132001, message: 'Template name does not exist' } }) }) }, CFG));
  ck('S2 Meta refuses → { ok:false, messageId:null, error:"META_132001" } and nothing recorded', bad.ok === false && bad.messageId === null && bad.error === 'META_132001', bad);
  const net = await W.sendTemplate({ to: '0712345678', template: 'order_ready', params: { name: 'A', orderRef: 'X' } }, Object.assign({ fetch: async () => { throw new Error('ECONNRESET'); } }, CFG));
  ck('S3 network failure → NETWORK, never "sent"', net.ok === false && net.error === 'NETWORK', net);
  const noId = await W.sendTemplate({ to: '0712345678', template: 'order_ready', params: { name: 'A', orderRef: 'X' } }, Object.assign({ fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }) }, CFG));
  ck('S4 a 200 WITHOUT a message id is NOT success', noId.ok === false, noId);
  ck('S5 the accepted send is recorded as status "accepted" (not "sent") — metadata only', store._docs['wamid.TEST1'] && store._docs['wamid.TEST1'].status === 'accepted' && store._docs['wamid.TEST1'].toMasked === '25471*****78' && store._docs['wamid.TEST1'].uid === 'u1', store._docs);

  console.log('\n── X: secrecy ──');
  const sstore = W.memorySends(); g = fakeGraph(okReply);
  const sr = await W.sendTemplate({ to: '0712345678', template: 'completion_pin', params: { code: PIN }, uid: 'buyer1' }, Object.assign({ fetch: g, store: sstore }, CFG));
  const rec = sstore._docs[sr.messageId];
  ck('X1 the PIN went to Meta (body + button)', JSON.stringify(g.calls[0].body).split(PIN).length - 1 === 2);
  ck('X2 the PIN is NOT in the send record (metadata only: template, category, secret, masked number, uid, notification ref, channel, status, time)', rec && JSON.stringify(rec).indexOf(PIN) === -1
    && Object.keys(rec).sort().join(',') === 'acceptedAt,category,channel,ref,secret,status,template,toMasked,uid' && rec.secret === true && rec.channel === 'WHATSAPP', rec);
  ck('X3 the PIN is in NO console line', logs.every((l) => l.indexOf(PIN) === -1), logs.length);
  ck('X4 the full number is in no record', JSON.stringify(sstore._docs).indexOf('254712345678') === -1);

  console.log('\n── W: status webhook advances the ONE send record ──');
  const SECRET = 'app_secret_test';
  const wstore = W.memorySends(); await wstore.createSend('wamid.A', { status: 'accepted' });
  const post = async (statuses) => {
    const raw = Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'WABA', changes: [{ value: { metadata: { phone_number_id: '1234567890' }, statuses } }] }] }));
    const sig = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw).digest('hex');
    return H.handleRequest({ method: 'POST', rawBody: raw, headers: { 'x-hub-signature-256': sig } }, { appSecret: SECRET, store: H.memoryStore(), sends: wstore });
  };
  await post([{ id: 'wamid.A', status: 'sent', timestamp: '1' }]);
  ck('W1 sent → the record is "sent"', wstore._docs['wamid.A'].status === 'sent', wstore._docs['wamid.A']);
  await post([{ id: 'wamid.A', status: 'read', timestamp: '3' }, { id: 'wamid.A', status: 'delivered', timestamp: '2' }]);
  ck('W2 read then a late "delivered" → stays "read" (never backwards)', wstore._docs['wamid.A'].status === 'read', wstore._docs['wamid.A']);
  await post([{ id: 'wamid.A', status: 'failed', timestamp: '4', errors: [{ code: 131026 }] }]);
  ck('W3 "failed" after "read" does not override a delivered/read message', wstore._docs['wamid.A'].status === 'read');
  await wstore.createSend('wamid.B', { status: 'accepted' });
  await post([{ id: 'wamid.B', status: 'failed', timestamp: '1', errors: [{ code: 131026 }] }]);
  ck('W4 "failed" before delivery → "failed" with Meta\'s error code', wstore._docs['wamid.B'].status === 'failed' && wstore._docs['wamid.B'].errorCode === 131026, wstore._docs['wamid.B']);
  const foreign = await post([{ id: 'wamid.NOT_OURS', status: 'delivered', timestamp: '1' }]);
  ck('W5 a status for a message that is not ours is ignored (no record created)', !wstore._docs['wamid.NOT_OURS'] && foreign.advanced && foreign.advanced.ignored === 1, foreign.advanced);
  const unsigned = await H.handleRequest({ method: 'POST', rawBody: Buffer.from('{}'), headers: {} }, { appSecret: SECRET, store: H.memoryStore(), sends: wstore });
  ck('W6 an unsigned callback is refused (403) and advances nothing', unsigned.status === 403);

  console.log('\n── I: completion-PIN interface ──');
  g = fakeGraph(okReply);
  const send = W.makeSender(Object.assign({ fetch: g, resolvePhone: async (uid) => (uid === 'buyer1' ? '0722000111' : null) }, CFG));
  const i1 = await send('buyer1', 'completion_pin', { code: PIN });
  ck('I1 a uid is resolved SERVER-SIDE to the account phone, then sent', i1.ok && g.calls[0].body.to === '254722000111', { i1, to: g.calls[0] && g.calls[0].body.to });
  const i2 = await send('ghost', 'completion_pin', { code: PIN });
  ck('I2 no phone for the uid → { ok:false, error:"NO_PHONE" } (the engine falls back to SMS)', i2.ok === false && i2.error === 'NO_PHONE', i2);
  const i3 = await W.makeSender({})('0712345678', 'completion_pin', { code: PIN });
  ck('I3 unconfigured → NOT_CONFIGURED (the engine falls back to SMS)', i3.error === 'NOT_CONFIGURED', i3);

  console.log('\n── N: negative controls ──');
  ck('N1 nextStatus is not vacuous: delivered→sent stays delivered; accepted→sent advances', W.nextStatus('delivered', 'sent') === 'delivered' && W.nextStatus('accepted', 'sent') === 'sent');
  const leaky = { ...rec, code: PIN };
  ck('N2 the X2 detector fires on a record that DID store the PIN', JSON.stringify(leaky).indexOf(PIN) !== -1);

  Object.assign(console, orig);
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack || e); process.exit(2); });
