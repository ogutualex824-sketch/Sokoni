#!/usr/bin/env node
/* test-product-conversations.js — product conversations T2a (2026-09-29): "Chat seller" / "Ask a question" open ONE real
 * SOKONI conversation with the product's seller, answered in merchant-v2 › Messages; public Q&A is real and anonymous.
 *
 *   node scripts/test-product-conversations.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-product-conversations.js  # @ 2a30c78 — failures ARE the defects
 *
 * REAL functions/product-enquiries.js + functions/messages.js (ensureAnchoredConversation · sendMessage ·
 * createConversation) + messages-dispatch routing, on the transactional fake Firestore; page wiring on the sources.
 *
 * PROVES
 *   PC1 signed-out, own product, hidden / archived / missing product → refused
 *   PC2 a question opens product_enquiry_{product}__{buyer}: parties = buyer + the product's SELLER (from the product —
 *       not the client), inbox rows for both, the buyer's words as the buyer's message, a record with product context
 *   PC3 asking again reuses the same conversation; a burst (cooldown) and the same text twice are refused
 *   PC4 a PUBLIC question becomes a productQA row WITHOUT the asker's identity, and the seller gets a system note in the
 *       thread naming it
 *   PC5 only the product's seller can publish the answer (buyer / stranger refused); the answer is public, the thread
 *       is told
 *   PC6 a client cannot create a product_enquiry conversation itself (server-anchored)
 *   PC7 the seller's reply (sendMessage) lands in the same thread for the buyer
 *   PC8 messagesDispatch serves productEnquirySend and productQuestionAnswer (no new Cloud Function)
 *   PC9 the page no longer writes Q&A / comments / offers to localStorage or contactRequests; Chat seller, Ask and Offer
 *       all go to the server; the Q&A list reads productQA; merchant-v2 Messages can publish the answer
 */
'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process'), Module = require('module');
const ROOT = path.resolve(__dirname, '..'), FN = path.join(ROOT, 'functions');
const CPM = !!process.env.COUNTERPROOF, BASE = '2a30c78';
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const say = console.log; console.log = console.info = console.warn = console.debug = () => {};
const ck = (n, ok, d) => { if (ok) { pass++; say('  PASS  ' + n); } else { fail++; say('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 260) : '')); } };
let tmp = null;
const show = (rel) => { try { return cp.execFileSync('git', ['show', BASE + ':' + rel], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6, stdio: ['ignore', 'pipe', 'ignore'] }); } catch (_) { return null; } };
function load(rel) {
  if (!CPM) { try { return require(path.join(FN, rel)); } catch (e) { return null; } }
  const txt = show('functions/' + rel); if (txt == null) return null;
  tmp = tmp || fs.mkdtempSync(path.join(os.tmpdir(), 'prodconv-'));
  const out = path.join(tmp, rel.replace(/\//g, '__')); fs.writeFileSync(out, txt);
  try { return require(out); } catch (_) { return null; }
}
const src = (rel) => (CPM ? (show(rel) || '') : fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const F = makeFakeFirestore({ clock: () => Date.now() });
const db = F.db;
class HttpsError extends Error { constructor(c, m, d) { super(m); this.code = c; this.details = d; } }
const ADMIN = { apps: [{}], initializeApp: () => ({}), firestore: Object.assign(() => db, { FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath }), auth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }), messaging: () => ({ send: async () => ({}) }) };
const origReq = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === 'firebase-admin/firestore') return { getFirestore: () => db, FieldValue: F.FieldValue, Timestamp: F.Timestamp, FieldPath: F.FieldPath };
  if (id === 'firebase-admin') return ADMIN;
  if (id === 'firebase-functions/logger') return { info() {}, warn() {}, debug() {}, error() {}, log() {} };
  if (id === 'firebase-functions/v2/https') return { onCall: (_o, h) => (h || _o), onRequest: (_o, h) => (h || _o), HttpsError };
  if (id === 'firebase-functions/v2/firestore') return { onDocumentWritten: (_o, h) => h, onDocumentCreated: (_o, h) => h, onDocumentUpdated: (_o, h) => h };
  if (id === 'firebase-functions/v2/scheduler') return { onSchedule: (_o, h) => h };
  if (tmp && this.filename && this.filename.startsWith(tmp) && id.startsWith('./')) return origReq.call(this, path.join(FN, id));
  return origReq.apply(this, arguments);
};
const codeOf = async (p) => { try { await p; return null; } catch (e) { return (e.details && e.details.code) || e.code || e.message; } };
const tryv = async (p) => { try { return await p; } catch (e) { return { error: (e.details && e.details.code) || e.code || e.message }; } };
const get = async (p) => { const s = await db.doc(p).get(); return s.exists ? s.data() : null; };
const as = (uid, data) => ({ auth: uid ? { uid, token: {} } : null, data });
const msgsOf = async (cid) => (await db.collection('conversations').doc(cid).collection('messages').get()).docs.map((d) => d.data());

(async () => {
  say('\nSOURCE: ' + (CPM ? `@ ${BASE} — failures below ARE the defects` : 'working tree (fix)'));
  const PE = load('product-enquiries.js');
  const MSG = load('messages.js');
  const send = (uid, data) => (PE ? PE._h.productEnquirySend(as(uid, data)) : Promise.reject(new Error('no productEnquirySend')));
  const S = 'sellerQ', B = 'buyerQ', X = 'strangerQ';
  for (const u of [S, B, X]) await db.doc('users/' + u).set({ name: u === S ? 'Duka la Mama' : u === B ? 'Wanjiku' : 'Otieno' });
  await db.doc('products/pq').set({ name: 'Kitenge Dress', price: 2500, sellerUid: S, status: 'active', isVisible: true });
  await db.doc('products/pHidden').set({ name: 'Hidden', sellerUid: S, isVisible: false, status: 'active' });
  await db.doc('products/pArch').set({ name: 'Old', sellerUid: S, status: 'archived' });

  say('\n── asking ──');
  const pc1 = [await codeOf(send(null, { productId: 'pq', text: 'Is this genuine?' })), await codeOf(send(S, { productId: 'pq', text: 'Asking myself?' })),
    await codeOf(send(B, { productId: 'pHidden', text: 'Hello there' })), await codeOf(send(B, { productId: 'pArch', text: 'Hello there' })), await codeOf(send(B, { productId: 'nope', text: 'Hello there' }))];
  ck('PC1 signed-out, own product, hidden / archived / missing product are refused', pc1[0] === 'unauthenticated' && pc1[1] === 'failed-precondition' && pc1[2] === 'failed-precondition' && pc1[3] === 'failed-precondition' && pc1[4] === 'not-found', pc1);
  const r1 = await tryv(send(B, { productId: 'pq', text: 'Does this come in blue?', sellerUid: X }));
  const cid = 'product_enquiry_pq__' + B;
  const conv = await get('conversations/' + cid);
  const m1 = conv ? await msgsOf(cid) : [];
  const rec = await get('productEnquiries/pq__' + B);
  ck('PC2 a question opens product_enquiry_{product}__{buyer} with the product\'s SELLER, inbox rows for both, the buyer\'s message and the context',
    r1 && r1.conversationId === cid && conv && conv.participants.slice().sort().join() === [B, S].sort().join() && !conv.participants.includes(X)
    && !!(await get(`userConversations/${S}/items/${cid}`)) && !!(await get(`userConversations/${B}/items/${cid}`))
    && m1.some((m) => m.senderId === B && m.text === 'Does this come in blue?') && rec && rec.productId === 'pq' && rec.sellerUid === S && conv.metadata && conv.metadata.productId === 'pq',
    { r1, parts: conv && conv.participants, msgs: m1.length });
  const cool = await codeOf(send(B, { productId: 'pq', text: 'Another quick one?' }));
  await db.doc('productEnquiries/pq__' + B).set({ lastAt: Date.now() - 60000 }, { merge: true });
  const dupe = await codeOf(send(B, { productId: 'pq', text: 'Does this come in blue?' }));
  await db.doc('productEnquiries/pq__' + B).set({ lastAt: Date.now() - 10 * 60000 }, { merge: true });
  const r3 = await tryv(send(B, { productId: 'pq', text: 'Can you deliver to Langata?', publicQuestion: true }));
  ck('PC3 the same conversation is reused; a burst and the same text twice are refused', cool === 'COOLDOWN' && dupe === 'DUPLICATE' && r3 && r3.conversationId === cid, { cool, dupe, r3 });
  const qa = r3 && r3.qaId ? await get('productQA/' + r3.qaId) : null;
  const sys = (await msgsOf(cid)).find((m) => m.type === 'system' && m.event && m.event.qaId === (r3 && r3.qaId));
  ck('PC4 a public question → productQA without the asker\'s identity; a system note names it in the thread', !!qa && qa.question === 'Can you deliver to Langata?' && qa.status === 'open'
    && !('buyerUid' in qa) && !('askedBy' in qa) && !JSON.stringify(qa).includes(B) && !!sys && sys.event.kind === 'public_question', { qa, sys: !!sys });

  say('\n── answering ──');
  const ans = (uid, a) => (PE ? PE._h.productQuestionAnswer(as(uid, { qaId: r3 && r3.qaId, answer: a })) : Promise.reject(new Error('none')));
  const pc5 = [await codeOf(ans(B, 'Yes we do')), await codeOf(ans(X, 'Yes we do'))];
  const a5 = await tryv(ans(S, 'Yes — Langata delivery is same day.'));
  const qa5 = r3 && r3.qaId ? await get('productQA/' + r3.qaId) : null;
  const sys5 = (await msgsOf(cid)).find((m) => m.event && m.event.kind === 'public_answer');
  ck('PC5 only the product\'s seller publishes the answer; it is public and the thread is told', pc5.every((c) => c === 'NOT_SELLER') && a5 && a5.ok && qa5 && qa5.status === 'answered' && /same day/.test(qa5.answer) && !!sys5, { pc5, a5 });
  const cc = MSG && MSG._h && MSG._h.createConversation ? await codeOf(MSG._h.createConversation(as(B, { transactionType: 'product_enquiry', transactionId: 'pq__' + B }))) : 'no createConversation';
  ck('PC6 a client cannot create a product_enquiry conversation itself', !!cc && cc !== null, cc);
  const reply = MSG && MSG._h && MSG._h.sendMessage ? await tryv(MSG._h.sendMessage(as(S, { conversationId: cid, type: 'text', text: 'Yes, blue in size M and L.' }))) : { error: 'none' };
  ck('PC7 the seller\'s reply lands in the same thread for the buyer', !reply.error && (await msgsOf(cid)).some((m) => m.senderId === S && /blue in size/.test(m.text)), reply);
  const disp = src('functions/messages-dispatch.js');
  ck('PC8 messagesDispatch serves the product ops (no new Cloud Function)', /require\('\.\/product-enquiries'\)/.test(disp) && /const handler = HANDLERS\[op\]/.test(disp));

  say('\n── the page ──');
  const pj = src('product.js'), mmu = src('sokoni-merchant-messages-ui.js'), mm = src('sokoni-merchant-messages.js');
  ck('PC9 no localStorage Q&A / comments / offers or contactRequests; Chat / Ask / Offer go to the server; Q&A reads productQA; merchant-v2 publishes answers',
    !/localStorage\.setItem\("sokoniQA"/.test(pj) && !/localStorage\.setItem\("sokoniComments"/.test(pj) && !/localStorage\.setItem\("sokoniOffers"/.test(pj)
    && !/collection\(db,\s*'contactRequests'\)/.test(pj) && /op: "productEnquirySend"/.test(pj) && /FS\.collection\(db, "productQA"\)/.test(pj)
    && /openAskSeller\(\{ publicQuestion: false \}\)/.test(pj) && /_sendToSeller\(text, false\)/.test(pj)
    && /data-act="publish-qa"/.test(mmu) && /answer: 'productQuestionAnswer'/.test(mm));

  say(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { say('CRASH ' + (e && e.stack || e)); process.exit(2); });
