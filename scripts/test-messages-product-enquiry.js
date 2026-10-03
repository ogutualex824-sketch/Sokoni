#!/usr/bin/env node
/* PRODUCT ENQUIRY conversations (sokoni-f3 contract, Construction + every hub). Executes the REAL messages.js
 * createConversation + sendMessage in-process. The anchor is contactRequests/{id} — the ONE enquiry = lead record that the
 * product page's "Contact seller" writes (df1a4cb): parties = buyerUid + sellerUid, and the enquiry's seller must STILL
 * be products/{productId}.sellerUid on every open and every send. Each protection has a deliberate break that must turn
 * its NAMED row red.
 *   node scripts/test-messages-product-enquiry.js        BASE=<ref> (pre-contract must FAIL) */
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), cp = require('child_process');
const ROOT = path.join(__dirname, '..');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';

if (process.argv[2] === '--child') {
  const FN = process.argv[3];
  const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });
  const { call } = require('./lib/inmem-firestore');
  const { DOCS } = H;
  const M = require(path.join(FN, 'messages.js'))._h;
  ['buyA', 'buyB', 'sellS', 'sellT', 'stranger'].forEach((u) => DOCS.set('users/' + u, { displayName: u }));
  DOCS.set('products/p1', { sellerUid: 'sellS', name: 'Cement 50kg' });
  DOCS.set('products/p2', { sellerUid: 'sellS', name: 'Roofing sheets' });
  DOCS.set('products/p3', { sellerUid: 'sellS', name: 'Steel bars' });
  const enq = (id, buyer, seller, pid) => DOCS.set('contactRequests/' + id, { buyerUid: buyer, sellerUid: seller, productId: pid, message: 'Price for 100?', status: 'pending', createdAt: Date.now() });
  enq('e1', 'buyA', 'sellS', 'p1'); enq('e2', 'buyB', 'sellS', 'p1'); enq('e3', 'buyA', 'sellS', 'p2'); enq('e4', 'buyA', 'sellS', 'p3'); enq('e5', 'buyA', 'sellS', 'p2');
  const open = (uid, txId, extra) => call(M.createConversation, uid, Object.assign({ transactionType: 'product_enquiry', transactionId: txId }, extra || {}));
  const send = (uid, txId, text) => call(M.sendMessage, uid, { conversationId: 'product_enquiry_' + txId, type: 'text', text: text || 'hello' });
  const conv = (txId) => DOCS.get('conversations/product_enquiry_' + txId) || null;
  (async () => {
    const out = {};
    /* positive control */
    const p0 = await open('buyA', 'e1');
    const p1 = await send('buyA', 'e1'), p2 = await send('sellS', 'e1');
    out.P = { open: p0.ok ? 'ok' : p0.code, b: p1.ok ? 'ok' : p1.code, s: p2.ok ? 'ok' : p2.code, parts: (conv('e1') || {}).participants || null };
    /* wrong party: buyer A tries buyer B's enquiry before B opens it; then B opens; A tries to send */
    const w1 = await open('buyA', 'e2'); const created = !!conv('e2');
    await open('buyB', 'e2'); const w2 = await send('buyA', 'e2');
    out.W = { open: w1.code || 'ok', created, send: w2.code || 'ok' };
    /* third party (another seller) */
    const t1 = await open('sellT', 'e3'); const t1c = !!conv('e3');
    await open('buyA', 'e3'); const t2 = await send('stranger', 'e3');
    out.T = { open: t1.code || 'ok', created: t1c, send: t2.code || 'ok' };
    /* request-supplied parties ignored */
    const r1 = await open('buyA', 'e5', { participantUids: ['buyA', 'sellT'], sellerUid: 'sellT' });
    out.R = { ok: !!r1.ok, parts: (conv('e5') || {}).participants || null };
    /* forged stored participant list: stranger appended → send still refused (re-derived from the enquiry) */
    const c = conv('e1'); DOCS.set('conversations/product_enquiry_e1', Object.assign({}, c, { participants: c.participants.concat(['stranger']) }));
    const f1 = await send('stranger', 'e1');
    out.F = { code: f1.code || 'ok' };
    /* changed seller: product p2 transferred to sellT AFTER e3's conversation was opened → neither side can send;
       a fresh open on the stale enquiry is refused too */
    DOCS.set('products/p2', { sellerUid: 'sellT', name: 'Roofing sheets' });
    const c1 = await send('sellS', 'e3'), c2 = await send('buyA', 'e3');
    DOCS.delete('conversations/product_enquiry_e5');
    const c3 = await open('buyA', 'e5');
    out.C = { oldSeller: c1.code || 'ok', oldDet: c1.det && c1.det.code, buyer: c2.code || 'ok', reopen: c3.code || 'ok', reopenDet: c3.det && c3.det.code, history: !!conv('e3') };
    /* deleted product */
    await open('buyA', 'e4'); DOCS.delete('products/p3');
    const d1 = await send('buyA', 'e4');
    out.D = { code: d1.code || 'ok', det: d1.det && d1.det.code };
    console.log('RESULT_JSON ' + JSON.stringify(out));
  })().catch((e) => { console.error(e && e.stack || e); process.exit(2); });
  return;
}

const evaluate = (FN) => { const o = cp.spawnSync(process.execPath, [__filename, '--child', FN], { env: Object.assign({}, process.env, { NODE_PATH: NM }), encoding: 'utf8' });
  const line = (o.stdout || '').split('\n').find((l) => l.startsWith('RESULT_JSON ')); return line ? JSON.parse(line.slice(12)) : { crash: (o.stderr || o.stdout || '').slice(-600) }; };
const same = (a, b) => JSON.stringify((a || []).slice().sort()) === JSON.stringify((b || []).slice().sort());
const rows = (x) => ({
  'E0 positive control: the buyer opens, the buyer and the product\'s seller can message': !!x.P && x.P.open === 'ok' && x.P.b === 'ok' && x.P.s === 'ok' && same(x.P.parts, ['buyA', 'sellS']),
  'E1 wrong party: buyer A can neither open nor write to buyer B\'s enquiry': !!x.W && x.W.open === 'permission-denied' && !x.W.created && x.W.send === 'permission-denied',
  'E2 third party: another seller cannot open; a stranger cannot send': !!x.T && x.T.open === 'permission-denied' && !x.T.created && x.T.send === 'permission-denied',
  'E3 a sellerUid / participant list in the request is ignored — parties come from the enquiry doc': !!x.R && x.R.ok && same(x.R.parts, ['buyA', 'sellS']),
  'E4 a forged stored participant list does not let a stranger send (send re-derives from the enquiry)': !!x.F && x.F.code === 'permission-denied',
  'E5 changed seller (product transferred): no new messages from either side; stale enquiry cannot be opened; history kept': !!x.C && x.C.oldSeller === 'failed-precondition' && x.C.oldDet === 'PRODUCT_ENQUIRY_SELLER_CHANGED' && x.C.buyer === 'failed-precondition' && x.C.reopen === 'failed-precondition' && x.C.reopenDet === 'PRODUCT_ENQUIRY_SELLER_CHANGED' && x.C.history,
  'E6 deleted product closes the thread for new messages': !!x.D && x.D.code === 'failed-precondition' && x.D.det === 'PRODUCT_ENQUIRY_PRODUCT_GONE',
});
let pass = 0, fail = 0;
const ck = (id, ok, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + (ok ? '' : '   [got ' + JSON.stringify(got).slice(0, 300) + ']')); ok ? pass++ : fail++; };
console.log('\nProduct enquiry conversations (contactRequests)   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
let FN = path.join(ROOT, 'functions');
if (process.env.BASE) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pe-')); cp.execSync('git archive ' + process.env.BASE + ' functions | tar -x -C "' + d.split(path.sep).join('/') + '"', { cwd: ROOT, shell: 'bash' }); FN = path.join(d, 'functions'); }
const x = evaluate(FN);
if (x.crash) { console.log('CRASH (fail closed): ' + x.crash); process.exit(2); }
const R = rows(x);
for (const [k, v] of Object.entries(R)) ck(k, v, x);
if (Object.values(R).every(Boolean)) {
  console.log('\n  [mutations]');
  const MUT = [
    ['create party check removed', "  if (participantUids.indexOf(uid) === -1) {\n    throw new HttpsError('permission-denied', 'Not a party to this transaction');\n  }", '', ['E1', 'E2']],
    ['participants taken from the request', '  const participantUids = _partiesOf(transactionType, txSnap.data());', '  const participantUids = Array.isArray(req.data.participantUids) ? req.data.participantUids : _partiesOf(transactionType, txSnap.data());', ['E3']],
    ['send-time party re-derivation removed', "      if (enq.buyerUid !== req.auth.uid && enq.sellerUid !== req.auth.uid) throw new HttpsError('permission-denied', 'Not a party to this enquiry');", '', ['E4']],
    ['send-time product-seller check removed', "      const why = await _productEnquiryRefusal(db, enq);\n      if (why) throw", "      const why = null;\n      if (why) throw", ['E5', 'E6']],
    ['create-time product-seller check removed', "    const why = await _productEnquiryRefusal(db, txSnap.data());", '    const why = null;', ['E5']],
    ['seller comparison removed', "  if ((p.data() || {}).sellerUid !== enq.sellerUid) return 'PRODUCT_ENQUIRY_SELLER_CHANGED';", '', ['E5']],
  ];
  for (const [name, a, b, rws] of MUT) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'pem-'));
    fs.mkdirSync(path.join(d, 'functions'));
    for (const f of fs.readdirSync(FN)) { const p = path.join(FN, f); if (fs.statSync(p).isFile()) fs.copyFileSync(p, path.join(d, 'functions', f)); }
    if (fs.existsSync(path.join(FN, 'shared'))) cp.execSync('cp -r "' + path.join(FN, 'shared').split(path.sep).join('/') + '" "' + d.split(path.sep).join('/') + '/functions/shared"', { shell: 'bash' });
    const f = path.join(d, 'functions', 'messages.js'); const s = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (s.split(a).length !== 2) { console.log('  MISSED  ' + name + ' (anchor ' + (s.split(a).length - 1) + 'x — UNPROVEN)'); fail++; continue; }
    fs.writeFileSync(f, s.replace(a, () => b));
    const y = evaluate(path.join(d, 'functions'));
    const yr = y.crash ? {} : rows(y);
    rws.forEach((rid) => { const k = Object.keys(R).find((z) => z.startsWith(rid + ' ')); const red = !y.crash && yr[k] === false;
      console.log('  ' + (red ? 'CAUGHT' : 'MISSED') + '  ' + name + ' → ' + rid); if (!red) fail++; });
    fs.rmSync(d, { recursive: true, force: true });
  }
} else console.log('\n  [mutations] skipped — the gate does not hold on this tree.');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
