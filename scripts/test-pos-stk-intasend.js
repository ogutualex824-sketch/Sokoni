#!/usr/bin/env node
'use strict';
/* ============================================================================
   Till / POS M-PESA → IntaSend POS rail — the pages, the adapter, and the LIVE server chain
   ----------------------------------------------------------------------------
     A  static: till.html + merchant-v2.html wire SokoniPosStk (loaded before the sell engine);
        pos-checkout.html calls posInitiateIntasendPayment; no darajaSTKPush / posSendMpesa /
        SokoniPay.platformBook remain (the phantom functions that produced "internal")
     B  the adapter's request keys are exactly what the LIVE posInitiateIntasendPayment destructures
     C  emulator chain with the LIVE functions code (FN_DIR, default the containment tree 68811e1):
        adapter.callStk → initiate() (IntaSend adapter stubbed at the network boundary) → postill_ ref
        → posCheckPaymentStatus reads pending → webhook finalizeFromWebhook(COMPLETE) → reads completed;
        a FAILED callback reads failed; a resend is a new attempt (new ref)
   firebase emulators:exec --config firebase.emu.json --only firestore --project sokoni-e2e "node scripts/test-pos-stk-intasend.js"
   ============================================================================ */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const FN_DIR = process.env.FN_DIR || 'C:/temp/sok-recovery/functions';
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

(async () => {
  console.log('Till / POS M-PESA on the IntaSend POS rail\n');
  console.log('A. the pages');
  const till = read('till.html'), mv2 = read('merchant-v2.html'), pc = read('pos-checkout.html');
  ck('A1 till.html wires callStk/callVerify through SokoniPosStk; no darajaSTKPush / verifyPaymentStatus', /SokoniPosStk\.callStk\(window\.sokoniCallable\)/.test(till) && /SokoniPosStk\.callVerify\(window\.sokoniCallable\)/.test(till) && !/'darajaSTKPush'/.test(till) && !/'verifyPaymentStatus'/.test(till));
  ck('A2b till.html self-updates (sw-register.js) so cashier devices pick up the fix after the deploy', till.includes('<script src="/sw-register.js" defer></script>'));
  ck('A2 till.html loads sokoni-pos-stk.js BEFORE sokoni-merchant-sell.js', till.indexOf('sokoni-pos-stk.js') > 0 && till.indexOf('sokoni-pos-stk.js') < till.indexOf('sokoni-merchant-sell.js'));
  ck('A3 merchant-v2.html (Sell tab) wires the same adapter; no darajaSTKPush', /SokoniPosStk\.callStk\(_callable\)/.test(mv2) && !/'darajaSTKPush'/.test(mv2) && mv2.indexOf('sokoni-pos-stk.js') < mv2.indexOf('<script src="sokoni-merchant-sell.js"'));
  ck('A4 pos-checkout.html calls posInitiateIntasendPayment with merchantId / idempotencyKey / phone / amountKES', /httpsCallable\('posInitiateIntasendPayment'\)/.test(pc) && /merchantId: _s\.merchantId, idempotencyKey: _s\.mpesaAttemptKey, phone/.test(pc) && /amountKES: totals\.total/.test(pc));
  ck('A5 pos-checkout.html: no posSendMpesa, no SokoniPay.platformBook booking of a till sale', !/httpsCallable\(\s*['"]posSendMpesa['"]/.test(pc) && !/SokoniPay\.platformBook\s*\(/.test(pc));   /* calls, not the comment that explains why they were removed */
  ck('A6 pos-checkout finalises with the confirmed postill_ reference only after posCheckPaymentStatus reports completed', /res\.data\?\.status === 'completed'[\s\S]{0,600}_finalize\('mpesa', \[\{ method:'mpesa', amount: totals\.total, ref, phone \}\]/.test(pc));

  console.log('\nB. adapter ↔ live contract');
  const live = fs.readFileSync(path.join(FN_DIR, 'pos-intasend-initiation.js'), 'utf8');
  const m = live.match(/const \{ ([^}]+) \} = request\.data \|\| \{\};/);
  const liveKeys = m ? m[1].split(',').map((x) => x.trim()) : [];
  global.window = global.window || {}; window.crypto = require('crypto').webcrypto;
  require(path.join(ROOT, 'sokoni-pos-stk.js'));
  const S = window.SokoniPosStk;
  let seen = null;
  const fakeFactory = (name) => async (req) => { seen = { name, req }; return { data: name === 'posInitiateIntasendPayment' ? { ref: 'postill_x', state: 'pending' } : { status: 'completed', transactionRef: 'postill_x' } }; };
  await S.callStk(fakeFactory)({ sellerUid: 'SHOP1', phone: '254712345678', amount: 150, description: 'KASS SHOP sale' });
  ck('B1 callStk sends exactly the live keys (' + liveKeys.join(', ') + ')', seen.name === 'posInitiateIntasendPayment' && JSON.stringify(Object.keys(seen.req).sort()) === JSON.stringify([...liveKeys].sort()) && seen.req.merchantId === 'SHOP1' && seen.req.amountKES === 150, seen);
  const v = await S.callVerify(fakeFactory)({ checkoutId: 'postill_x' });
  ck('B2 callVerify calls posCheckPaymentStatus with ref + the shop that raised it; returns status completed', seen.name === 'posCheckPaymentStatus' && seen.req.ref === 'postill_x' && seen.req.merchantId === 'SHOP1' && v.data.status === 'completed', { seen, v });
  const failing = (name) => async () => ({ data: { ref: 'postill_y', state: 'failed', error: 'Invalid phone' } });
  let err = null; try { await S.callStk(failing)({ sellerUid: 'S', phone: '254700000000', amount: 10 }); } catch (e) { err = e; }
  ck('B3 a provider-refused request surfaces its reason to the cashier (not "internal")', err && /Invalid phone/.test(err.message), err && err.message);
  ck('B4 every send is a new attempt key', S._attemptKey('S') !== S._attemptKey('S'));

  console.log('\nC. the LIVE server chain on the emulator');
  if (!process.env.FIRESTORE_EMULATOR_HOST) { console.log('  (skipped — run under firebase emulators:exec)'); }
  else {
    process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-e2e';
    const admin = require(path.join(FN_DIR, 'node_modules', 'firebase-admin'));
    if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT });
    const db = admin.firestore();
    const PI = require(path.join(FN_DIR, 'pos-intasend-initiation.js'));
    /* the IntaSend adapter, stubbed at the network boundary with the live call shape: initiatePayment({phone, amountKES, ref, narrative}) → {success} */
    const stubAdapter = { initiatePayment: async (p) => ({ success: true, invoiceId: 'inv_' + p.ref, raw: {} }) };
    const SHOP = 'shop_' + Date.now();
    const liveFactory = (name) => {
      if (name === 'posInitiateIntasendPayment') return async (req) => ({ data: await PI.initiate(db, { ...req, adapter: stubAdapter }) });
      if (name === 'posCheckPaymentStatus') return async (req) => {
        const s = await db.collection('posPaymentStatus').doc(String(req.ref)).get();
        if (s.exists && s.data().status === 'completed') return { data: { status: 'completed', transactionRef: s.data().transactionRef || req.ref } };
        if (s.exists && s.data().status === 'failed') return { data: { status: 'failed', reason: s.data().failureReason || 'Payment was not completed' } };
        return { data: { status: 'pending' } };
      };
      return null;
    };
    const initFn = PI.initiate || (PI._internal && PI._internal.initiate);
    ck('C0 the live module exposes its initiator for a direct drive', typeof initFn === 'function', Object.keys(PI));
    if (typeof initFn === 'function') {
      const r1 = await S.callStk(liveFactory)({ sellerUid: SHOP, phone: '254712345678', amount: 150, description: 'Till sale' });
      ck('C1 live initiate() returns a postill_ reference, state pending', /^postill_/.test(r1.data.ref) && r1.data.state === 'pending', r1);
      const v1 = await S.callVerify(liveFactory)({ checkoutId: r1.data.ref });
      ck('C2 before the webhook: status pending (a request is not a payment)', v1.data.status === 'pending', v1);
      const handled = await PI.finalizeFromWebhook(db, r1.data.ref, 'COMPLETE', 150);
      const v2 = await S.callVerify(liveFactory)({ checkoutId: r1.data.ref });
      ck('C3 the webhook\'s POS finaliser confirms it → status completed', !!handled && v2.data.status === 'completed', { handled, v2 });
      const r2 = await S.callStk(liveFactory)({ sellerUid: SHOP, phone: '254712345678', amount: 150, description: 'Till sale' });
      ck('C4 a resend is a NEW attempt with a new reference', r2.data.ref !== r1.data.ref, { r1: r1.data.ref, r2: r2.data.ref });
      await PI.finalizeFromWebhook(db, r2.data.ref, 'FAILED', 150);
      const v3 = await S.callVerify(liveFactory)({ checkoutId: r2.data.ref });
      ck('C5 a FAILED callback reads failed (the cashier is told, the sale is not completed)', v3.data.status === 'failed', v3);
    }
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
