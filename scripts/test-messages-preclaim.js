#!/usr/bin/env node
/* MESSAGES — pre-claimed / legacy conversation docs (security 2026-10-03). Executes the REAL messages.js createConversation
 * + sendMessage in-process. The served rules let a client CREATE conversations/<deterministic id> until sokoni-f3's lock
 * ships, so a non-party could pre-claim service_booking_<id> and lock the real parties out. The server must treat any doc
 * not stamped serverCreated as UNTRUSTED: re-derive from the transaction and repair it for a real party; never refuse one.
 *   node scripts/test-messages-preclaim.js            SABOTAGE=1 → every mutation must turn its named row FAIL */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');

if (process.env.SABOTAGE) {
  const M = [
    ['P1', 'messages.js', "  if (existingSnap.exists) {\n    const repaired = await db.runTransaction(", "  if (existingSnap.exists) {\n    throw new HttpsError('permission-denied', 'Not a party to this transaction');\n    const repaired = await db.runTransaction("],
    ['P5', 'messages.js', "    if (cur.serverCreated === true && Array.isArray(cur.participants) && cur.participants.indexOf(uid) !== -1) {", "    if (Array.isArray(cur.participants) && cur.participants.indexOf(uid) !== -1) {"],
    ['P2', 'messages.js', "      for (const p of before) if (participantUids.indexOf(p) === -1) t.delete(", "      for (const p of []) if (participantUids.indexOf(p) === -1) t.delete("],
  ];
  let caught = 0;
  for (const [row, file, a, b] of M) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mpc-'));
    const FN = path.join(d, 'functions'); fs.mkdirSync(path.join(FN, 'shared'), { recursive: true });
    for (const f of fs.readdirSync(path.join(ROOT, 'functions'))) { const p = path.join(ROOT, 'functions', f); if (f !== 'node_modules' && fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, f)); }
    for (const f of fs.readdirSync(path.join(ROOT, 'functions', 'shared'))) { const p = path.join(ROOT, 'functions', 'shared', f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(FN, 'shared', f)); }
    const t = path.join(FN, file), s = fs.readFileSync(t, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  BROKEN ' + row + ' anchor'); continue; }
    fs.writeFileSync(t, s.replace(a, () => b));
    let out = ''; try { out = cp.execFileSync(process.execPath, [__filename], { env: Object.assign({}, process.env, { SABOTAGE: '', FN_DIR: FN }), encoding: 'utf8' }); } catch (e) { out = String(e.stdout || ''); }
    const hit = new RegExp('FAIL ' + row + ' ').test(out);
    console.log('  ' + (hit ? 'CAUGHT' : 'MISSED') + ' ' + row); if (hit) caught++;
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log('\nSABOTAGE: ' + caught + '/' + M.length + ' caught');
  process.exit(caught === M.length ? 0 : 1);
}

const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
const { call } = require('./lib/inmem-firestore');
const FN = process.env.FN_DIR || path.join(ROOT, 'functions');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
const { DOCS } = H;
console.log('\nMessages — pre-claimed / legacy conversations are repaired, never trusted\n');
(async () => {
  const M = require(path.join(FN, 'messages.js'))._h;
  H.reset();
  ['cust', 'prov', 'att', 'x'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('providerBookings/B1', { customerUid: 'cust', providerId: 'prov', status: 'confirmed' });
  DOCS.set('providerBookings/B2', { customerUid: 'cust', providerId: 'prov', status: 'confirmed' });
  DOCS.set('providerBookings/B3', { customerUid: 'cust', providerId: 'prov', status: 'confirmed' });
  /* the attacker pre-claimed B1's deterministic conversation (what the served rules allowed) */
  DOCS.set('conversations/service_booking_B1', { participants: ['att', 'x'], transactionType: 'service_booking', transactionId: 'B1' });
  DOCS.set('userConversations/att/items/service_booking_B1', { conversationId: 'service_booking_B1' });
  const C = () => DOCS.get('conversations/service_booking_B1') || {};

  const a = await call(M.createConversation, 'att', { transactionType: 'service_booking', transactionId: 'B1' });
  const c1 = await call(M.createConversation, 'cust', { transactionType: 'service_booking', transactionId: 'B1' });
  const parts = (C().participants || []).slice().sort();
  ck('P1', a.code === 'permission-denied' && c1.ok && c1.ok.repaired === true && JSON.stringify(parts) === '["cust","prov"]' && C().serverCreated === true && JSON.stringify(C().participantsReplacedFrom) === '["att","x"]',
    'a PRE-CLAIMED doc: the attacker still cannot open it; the real customer\'s open REPAIRS it from the booking (participants = customer + provider, stamped, old list kept for audit)', { a, c1, conv: C() });
  const s1 = await call(M.sendMessage, 'att', { conversationId: 'service_booking_B1', type: 'text', text: 'hi' });
  const s2 = await call(M.sendMessage, 'prov', { conversationId: 'service_booking_B1', type: 'text', text: 'Hello' });
  ck('P2', s1.code === 'permission-denied' && s2.ok && !DOCS.get('userConversations/att/items/service_booking_B1') && !!DOCS.get('userConversations/prov/items/service_booking_B1'),
    'after the repair the attacker cannot send and loses the index entry; the provider can message', { s1, s2 });

  /* P5: the attacker pre-claimed WITH the real customer inside ([att, cust]) — the customer's open must still repair it, or the
     attacker would stay in (and read) the conversation */
  DOCS.set('providerBookings/B4', { customerUid: 'cust', providerId: 'prov', status: 'confirmed' });
  DOCS.set('conversations/service_booking_B4', { participants: ['att', 'cust'], transactionType: 'service_booking', transactionId: 'B4' });
  const p5 = await call(M.createConversation, 'cust', { transactionType: 'service_booking', transactionId: 'B4' });
  const p5s = await call(M.sendMessage, 'att', { conversationId: 'service_booking_B4', type: 'text', text: 'still here?' });
  ck('P5', p5.ok && p5.ok.repaired === true && JSON.stringify((DOCS.get('conversations/service_booking_B4').participants || []).slice().sort()) === '["cust","prov"]' && p5s.code === 'permission-denied',
    'pre-claimed WITH the real customer inside: the customer open still repairs it — the attacker is removed and cannot send (a stamp-less doc is never trusted, even when the caller is in it)', { p5, p5s });

  /* a LEGACY doc (correct parties, no stamp): stamped silently, not flagged as repaired */
  DOCS.set('conversations/service_booking_B2', { participants: ['cust', 'prov'], transactionType: 'service_booking', transactionId: 'B2', unreadCounts: { cust: 3 } });
  const l1 = await call(M.createConversation, 'prov', { transactionType: 'service_booking', transactionId: 'B2' });
  const L = DOCS.get('conversations/service_booking_B2');
  ck('P4', l1.ok && l1.ok.repaired === false && L.serverCreated === true && !L.participantsReplacedFrom && L.unreadCounts.cust === 3, 'a legacy doc with the right parties is stamped silently (unread kept, not reported as a repair)', { l1, L });

  /* a doc created by the server and stamped → fast path; a non-party still cannot learn it exists */
  const n1 = await call(M.createConversation, 'cust', { transactionType: 'service_booking', transactionId: 'B3' });
  const n2 = await call(M.createConversation, 'cust', { transactionType: 'service_booking', transactionId: 'B3' });
  const n3 = await call(M.createConversation, 'att', { transactionType: 'service_booking', transactionId: 'B3' });
  ck('P3', n1.ok && n1.ok.existing === false && DOCS.get('conversations/service_booking_B3').serverCreated === true && n2.ok && n2.ok.existing === true && !n2.ok.repaired && n3.code === 'permission-denied',
    'a server-created conversation is stamped; re-opening takes the fast path; a non-party is refused with no existence oracle', { n1, n2, n3 });
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); console.log('\nRESULT: ' + pass + ' passed, ' + (fail + 1) + ' failed'); process.exit(1); });
