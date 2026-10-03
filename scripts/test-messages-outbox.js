#!/usr/bin/env node
/* MESSAGES — idempotent send (port of sokoni-2f 26697e5, offline outbox server change). Executes the REAL messages.js
 * sendMessage in-process. A retried send with the SAME clientMessageId lands ONCE (one doc, unread +1 once) and returns
 * duplicate:true; an invalid key is refused; the key is namespaced by sender (no squatting); no key = old behaviour.
 *   node scripts/test-messages-outbox.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
if (process.env.SABOTAGE) {
  const M = [
    ['O1', 'messages.js', "    if (idempotent) batch.create(msgRef, msgData); else batch.set(msgRef, msgData);", '    batch.set(msgRef, msgData);'],
    ['O2', 'messages.js', "    if (idempotent && !MSGID.isValidClientMessageId(clientMessageId)) {", '    if (false) {'],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mob-')); const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out); console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught'); process.exit(caught === M.length ? 0 : 1);
}
const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
console.log('\nMessages — idempotent send (outbox)\n');
(async () => {
  const M = require(path.join(FN, 'messages.js'))._h;
  H.reset();
  ['cust', 'prov'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('providerBookings/B1', { customerUid: 'cust', providerId: 'prov', status: 'confirmed' });
  await call(M.createConversation, 'cust', { transactionType: 'service_booking', transactionId: 'B1' });
  const msgs = () => [...DOCS.keys()].filter((k) => k.startsWith('conversations/service_booking_B1/messages/'));
  const send = (uid, key) => call(M.sendMessage, uid, Object.assign({ conversationId: 'service_booking_B1', type: 'text', text: 'Is 10am ok?' }, key === undefined ? {} : { clientMessageId: key }));
  const a = await send('cust', 'out-1234-abcd');
  const b = await send('cust', 'out-1234-abcd');
  const conv = DOCS.get('conversations/service_booking_B1');
  ck('O1', a.ok && a.ok.duplicate === false && b.ok && b.ok.duplicate === true && b.ok.messageId === a.ok.messageId && msgs().length === 1 && conv.unread === 1,
    'a retried send with the SAME clientMessageId lands ONCE: one message, unread +1 once, the retry answers duplicate:true', { a: a.ok, b: b.ok, n: msgs().length, unread: conv.unread });
  const bad = await send('cust', 'x');
  ck('O2', bad.code === 'invalid-argument' && msgs().length === 1, 'an invalid clientMessageId (too short) is refused and writes nothing', bad);
  const p = await send('prov', 'out-1234-abcd');
  ck('O3', p.ok && p.ok.duplicate === false && p.ok.messageId !== a.ok.messageId && msgs().length === 2, 'the key is namespaced by SENDER: another party using the same key gets its own message (no squatting)', p);
  const n1 = await send('cust'), n2 = await send('cust');
  ck('O4', n1.ok && n2.ok && n1.ok.messageId !== n2.ok.messageId && msgs().length === 4, 'no key = the previous behaviour (two sends, two messages)', { n1: n1.ok, n2: n2.ok });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
