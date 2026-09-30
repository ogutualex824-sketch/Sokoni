#!/usr/bin/env node
/* test-b2-inapp-e2e.js — B2 closure: My Orders' two in-app actions, END TO END against the
 * REAL server handlers on the Firestore emulator (nothing touches production).
 *
 *   C  Message seller: the exact link My Orders renders (orderActions, executed) is parsed the
 *      way chat.html parses it; the REAL messages.js createConversation handler (this tree's
 *      functions/messages.js — byte-identical to the live messagesDispatch archive) derives the
 *      parties from orders/{id}: buyer + seller get one deterministic thread; a stranger is
 *      refused and learns nothing; an unknown order is not-found.
 *   R  Request refund: the exact support.html?topic=payment&ref=<order> link is turned into the
 *      exact payload support.html submits (SokoniSupportContact.payloadFor, executed), and the
 *      REAL adminOsDispatch (FUNCTIONS_DIR, default the deployed F1-R lineage C:/temp/sok-f1)
 *      writes supportTickets/{id} for the caller with the order reference + reason in it,
 *      category payment. NO money moves: refundRequests, walletTransactions and wallets stay
 *      untouched and the buyer's wallet balance is unchanged.
 *
 * Run: firebase emulators:exec --only firestore --project demo-b2e2e "node scripts/test-b2-inapp-e2e.js"
 */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (label, ok, got) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + label + (ok ? '' : '   [got ' + JSON.stringify(got) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !/^demo-/.test(process.env.GCLOUD_PROJECT || '')) {
    ck('E0  emulator present (run under emulators:exec with a demo-* project)', false, process.env.GCLOUD_PROJECT); process.exit(1);
  }
  process.env.FUNCTIONS_EMULATOR = 'true';
  const FN = path.resolve(process.env.FUNCTIONS_DIR || 'C:/temp/sok-f1/functions');
  const admin = require(require.resolve('firebase-admin', { paths: [path.join(ROOT, 'functions')] }));
  if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
  const db = admin.firestore();

  /* the link My Orders renders — executed from the page */
  const mo = read('my-orders.html');
  const oa = vm.runInNewContext(mo.slice(mo.indexOf('var NO_CHAT'), mo.indexOf('function orderDate(o){')) + '; orderActions;', { encodeURIComponent });
  const ORDER = 'ordE2E1';
  const html = oa({ _fsId: ORDER, status: 'delivered' });
  const hrefs = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
  const chatHref = hrefs.find((h) => h.startsWith('chat.html?'));
  const supHref = hrefs.find((h) => h.startsWith('support.html?'));

  /* seed: a checkout-shaped order (uid + buyerUid, sellerUid), buyer wallet */
  await db.collection('orders').doc(ORDER).set({ uid: 'buyer1', buyerUid: 'buyer1', sellerUid: 'seller1', status: 'delivered', total: 1500 });
  await db.collection('users').doc('buyer1').set({ email: 'b1@example.com', displayName: 'Buyer One', walletBalance: 200 });
  const countOf = async (c) => (await db.collection(c).get()).size;
  const before = { rr: await countOf('refundRequests'), wt: await countOf('walletTransactions'), w: await countOf('wallets') };

  console.log('\n── C: Message seller → the REAL createConversation ──');
  const q = new URLSearchParams(chatHref.split('?')[1]);
  ck('C0  My Orders renders chat.html?tx=order&txId=<order>', q.get('tx') === 'order' && q.get('txId') === ORDER, chatHref);
  const msgs = require(path.join(ROOT, 'functions', 'messages.js'));
  const create = msgs._h.createConversation;
  const r1 = await create({ auth: { uid: 'buyer1', token: {} }, data: { transactionType: q.get('tx'), transactionId: q.get('txId') } });
  const conv = (await db.collection('conversations').doc(r1.conversationId).get()).data() || {};
  ck('C1  the buyer opens ONE deterministic thread order_<id>', r1.conversationId === 'order_' + ORDER, r1);
  ck('C2  participants are DERIVED from the order: exactly buyer + seller', JSON.stringify((conv.participants || []).slice().sort()) === JSON.stringify(['buyer1', 'seller1']), conv.participants);
  const r2 = await create({ auth: { uid: 'seller1', token: {} }, data: { transactionType: 'order', transactionId: ORDER } });
  ck('C3  the seller reaches the same thread (existing)', r2.conversationId === r1.conversationId && r2.existing === true, r2);
  let e3 = null; try { await create({ auth: { uid: 'mallory', token: {} }, data: { transactionType: 'order', transactionId: ORDER } }); } catch (e) { e3 = e.code || e.message; }
  ck('C4  a stranger is REFUSED (permission-denied) — no existence oracle', /permission-denied/.test(String(e3)), e3);
  let e4 = null; try { await create({ auth: { uid: 'buyer1', token: {} }, data: { transactionType: 'order', transactionId: 'nope404' } }); } catch (e) { e4 = e.code || e.message; }
  ck('C5  an unknown order → not-found, no thread written', /not-found/.test(String(e4)) && !(await db.collection('conversations').doc('order_nope404').get()).exists, e4);
  let e5 = null; try { await create({ auth: null, data: { transactionType: 'order', transactionId: ORDER } }); } catch (e) { e5 = e.code || e.message; }
  ck('C6  signed out → unauthenticated', /unauthenticated|Login required/.test(String(e5)), e5);

  console.log('\n── R: Request refund → a support ticket, never money ──');
  const sq = new URLSearchParams(supHref.split('?')[1]);
  ck('R0  My Orders renders support.html?topic=payment&ref=<order>&desc=Refund request…', sq.get('topic') === 'payment' && sq.get('ref') === ORDER && /Refund request for order/.test(sq.get('desc') || ''), supHref);
  /* support.html's submit, reproduced from the page: message = desc + reason + the reference line */
  const ctx = vm.createContext({ localStorage: { setItem() {}, getItem() { return null; } }, console });
  ctx.window = ctx; vm.runInContext(read('sokoni-support-contact.js'), ctx);
  const reason = 'Item arrived broken — photo sent to seller';
  const message = (sq.get('desc') + reason) + '\n\nOrder / transaction reference given by the user: ' + sq.get('ref') + '\n\nContact name: Buyer One\nContact phone: 0712345678';
  const payload = ctx.SokoniSupportContact.payloadFor({ category: 'payment', subject: 'Refund request', message, priority: 'medium' });
  ck('R1  support.html builds the AdminOS ticket op (not a refund/money op)', payload.op === 'adminCreateSupportTicket' && !/refund(Payment|ToWallet|Request)/i.test(payload.op), payload.op);
  if (!fs.existsSync(path.join(FN, 'admin-os-dispatch.js'))) { ck('R2  FUNCTIONS_DIR has admin-os-dispatch.js', false, FN); }
  else {
    const disp = require(path.join(FN, 'admin-os-dispatch.js'));
    const res = await disp.adminOsDispatch.run({ auth: { uid: 'buyer1', token: {} }, data: payload });
    const t = res && res.ticketId ? (await db.collection('supportTickets').doc(res.ticketId).get()).data() : null;
    ck('R2  the REAL handler writes supportTickets/{server id} for the caller, open, category payment', !!t && t.uid === 'buyer1' && t.status === 'open' && t.category === 'payment', t);
    ck('R3  the ticket carries the order reference AND the reason (the evidence a reviewer needs)', !!t && t.message.indexOf(ORDER) > -1 && t.message.indexOf(reason) > -1, t && t.message);
  }
  const after = { rr: await countOf('refundRequests'), wt: await countOf('walletTransactions'), w: await countOf('wallets') };
  const bal = ((await db.collection('users').doc('buyer1').get()).data() || {}).walletBalance;
  ck('R4  NO money moved: refundRequests / walletTransactions / wallets unchanged; wallet balance still 200', JSON.stringify(before) === JSON.stringify(after) && bal === 200, { before, after, bal });

  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('CRASH', e && e.stack || e); process.exit(2); });
