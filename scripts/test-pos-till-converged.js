#!/usr/bin/env node
'use strict';
/* ============================================================================
   POS TILL CONVERGENCE (owner 2026-10-03: "Yes, build it now")
     T1  pos.js completes a sale through the REAL posCompleteCheckout (not dryRun), via SokoniSaleSubmit
     T2  nothing local is written unless the server returned a saleId; refusal / in-flight say so honestly
     T3  a converged sale is NOT queued to the legacy posTransactions mirror (no double sale record)
     T4  pos-db adjustStock never pushes 'sale:' / 'rollback:' to canonical stock (server owns it); refund/void still do
     T5  an M-PESA sale settles under the PAID prompt's key: SokoniPosStk returns its key, pos.js passes it,
         and merchant-v2's buildSale uses a tender's settleKey (the gate refuses a different key — wrong_sale)
     T6  card and manual Till are refused BEFORE any money moves (server cannot confirm them)
     T7  offline: no sale (the server is the authority) — said plainly
     T8  stock-in and purchase-order receive go through the server stock tool (merchantAdjustStock, 'restock')
   node scripts/test-pos-till-converged.js
   ============================================================================ */
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = process.env.SOK_FILES_ROOT || path.resolve(__dirname, '..');
const rd = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + String(typeof d === 'string' ? d : JSON.stringify(d)).slice(0, 220) : '')); } };
const P = rd('pos.js'), DB = rd('pos-db.js'), STK = rd('sokoni-pos-stk.js'), MD = rd('sokoni-merchant-data.js'), MS = rd('sokoni-merchant-sell.js'), H = rd('pos.html');

(async () => {
  /* T1–T3, T7 (static over the shipping pos.js) */
  const cm = P.slice(P.indexOf('async complete(payInfo)'), P.indexOf('cancelCard()'));
  ck('T1 the sale calls posCompleteCheckout for real (no dryRun) through SokoniSaleSubmit.submit', /httpsCallable\(fnMod\.getFunctions\(window\.firebaseApp\), 'posCompleteCheckout'\)/.test(cm) && /SokoniSaleSubmit\.submit\(_call, _payload\)/.test(cm) && !/dryRun:\s*true/.test(cm));
  ck('T2 local records are written only after a server saleId; refusal says "Sale NOT completed … Nothing was recorded"',
    cm.indexOf("if (!_server.saleId) throw") > -1 && cm.indexOf("if (!_server.saleId) throw") < cm.indexOf('await PosDB.transactions.save(txn)') && /Sale NOT completed: /.test(cm) && /Nothing was recorded/.test(cm));
  ck('T2b in-flight is NOT reported as failure: "Do NOT ring it up again"', /res\.inFlight[\s\S]{0,120}Do NOT ring it up again/.test(cm));
  ck('T3 no syncQueue "transaction" for a converged sale (the server sale record is the one analytics read)', !/syncQueue\.add\('transaction'/.test(cm) && /txn\.synced\s+= true/.test(cm));
  ck('T7 offline → no sale, said plainly', /needs a connection to complete a sale — nothing was recorded/.test(cm));
  ck('T1b pos.html loads sokoni-sale-submit.js before pos.js', H.indexOf('sokoni-sale-submit.js') > -1 && H.indexOf('sokoni-sale-submit.js') < H.indexOf('src="pos.js"'));

  /* T4 — execute pos-db adjustStock's canonical-sync decision */
  const ad = DB.slice(DB.indexOf('adjustStock: async (id, delta, reason, cashierId, opts) => {'), DB.indexOf('await stock_movements.save', DB.indexOf('adjustStock: async (id, delta, reason, cashierId, opts)')));
  const runAdjust = async (reason, opts) => {
    const calls = [];
    const ctx = { window: { _posSyncCanonicalStock: (...a) => calls.push(a) }, products: { _invalidateIndex () {} }, _get: async () => ({ id: 'p1', stock: 10, name: 'X' }), _put: async () => {} };
    vm.createContext(ctx);
    vm.runInContext('this.f = async function ' + ad.replace(/^adjustStock: async/, '').replace(/=>\s*\{/, '{') + ' return calls; }', Object.assign(ctx, { calls }));
    await ctx.f('p1', -1, reason, 'c1', opts);
    return calls.length;
  };
  let n;
  if (DB.indexOf('adjustStock: async (id, delta, reason, cashierId, opts) => {') < 0) n = { error: 'adjustStock has no opts parameter (pre-convergence code)' };
  else { try { n = { sale: await runAdjust('sale:t1'), rollback: await runAdjust('rollback:t1'), local: await runAdjust('restock_x', { localOnly: true }), refund: await runAdjust('refund:t1'), voided: await runAdjust('void:t1') }; } catch (e) { n = { error: e.message }; } }
  ck('T4 adjustStock: sale / rollback / localOnly → NO canonical push; refund / void → still pushed (until the server restock exists)',
    n.sale === 0 && n.rollback === 0 && n.local === 0 && n.refund === 1 && n.voided === 1, n);

  /* T5 — execute SokoniPosStk key passthrough + buildSale settleKey */
  const g = { crypto: { getRandomValues: (a) => { a[0] = 1; a[1] = 2; return a; } } };
  vm.createContext(g); vm.runInContext(STK, g);
  const seen = [];
  const factory = () => async (req) => { seen.push(req); return { data: { ref: 'postill_shop_' + req.idempotencyKey, state: 'pending' } }; };
  const r1 = await g.SokoniPosStk.callStk(factory)({ sellerUid: 'shop1', phone: '254700000001', amount: 100 });
  const r2 = await g.SokoniPosStk.callStk(factory)({ sellerUid: 'shop1', phone: '254700000001', amount: 100, idempotencyKey: 'sale_KEY_1' });
  ck('T5a SokoniPosStk returns the key that raised the prompt; a caller-supplied key is used as-is',
    r1.data.idempotencyKey === seen[0].idempotencyKey && /^till_shop1_/.test(r1.data.idempotencyKey) && r2.data.idempotencyKey === 'sale_KEY_1' && seen[1].idempotencyKey === 'sale_KEY_1', { r1: r1.data, r2: r2.data });
  ck('T5b pos.js passes the PAID prompt key into the sale and uses it as the checkout idempotencyKey',
    /payKey = r && r\.data && r\.data\.idempotencyKey/.test(P) && /paymentKey: payKey/.test(P) && /const _idemKey = payInfo\.paymentKey/.test(cm));
  const mdCtx = {}; vm.createContext(mdCtx);
  vm.runInContext(MD.replace(/\}\)\(typeof window !== 'undefined' \? window : (globalThis|this)\);?\s*$/, '})(this);'), mdCtx);
  const M = mdCtx.SokoniMerchantData || mdCtx.window && mdCtx.window.SokoniMerchantData;
  if (M && typeof M.buildSale === 'function') {
    const scope = { ok: true, shopId: 'shop1', sellerUid: 'u1' };
    const cart = [{ productId: 'p1', qty: 1, price: 100 }];
    const a = M.buildSale({ scope, cart, saleToken: 'tok', payments: [{ method: 'cash', amount: 100 }] });
    const b = M.buildSale({ scope, cart, saleToken: 'tok', payments: [{ method: 'mpesa', amount: 100, ref: 'postill_x', settleKey: 'till_shop1_abc' }] });
    ck('T5c merchant-v2 buildSale: an M-PESA tender with settleKey makes THAT the sale key; cash keeps the cart key; settleKey is not sent as a payment field',
      /^pos_shop1_tok_/.test(a.idempotencyKey) && b.idempotencyKey === 'till_shop1_abc' && !('settleKey' in b.payments[0]), { a: a.idempotencyKey, b: b.idempotencyKey });
  } else {
    ck('T5c merchant-v2 buildSale settleKey (static: module export not reachable in vm)', /settleKeys\.length \? String\(settleKeys\[0\]\)/.test(MD));
  }
  ck('T5d merchant-sell records the prompt key and carries it to buildSale', /settleKey: d\.idempotencyKey \|\| null/.test(MS) && /settleKey: \(S\.stk && S\.stk\.settleKey\) \|\| null/.test(MS) && /if \(t\.settleKey\) o\.settleKey = t\.settleKey/.test(MS));

  /* T6 */
  const pr = P.slice(P.indexOf('async process()'), P.indexOf('async complete(payInfo)'));
  ck('T6 card and manual Till are refused BEFORE any terminal / modal is opened ("Nothing was charged")',
    pr.indexOf("method === 'mpesa_till' || method === 'mpesa_till_manual'") < pr.indexOf("modal.open('mpesa-till-modal')") &&
    pr.indexOf('Card payments at this till are not confirmed by SOKONI yet') > -1 &&
    pr.indexOf('Card payments at this till are not confirmed by SOKONI yet') < pr.indexOf('PosTerminals.payment.initiate'));

  /* T8 */
  ck('T8 stock-in → PosDB.products.correctStock(…, "restock", stable adjustmentId); PO receive → correctStock per line, PO marked received after',
    /PosDB\.products\.correctStock\(productId, qty, 'restock'/.test(P) && /state\._stockInPending/.test(P) &&
    /products\.correctStock\(item\.productId, Number\(item\.qty\), 'restock'/.test(DB) && DB.indexOf("adjustmentId: 'po_' + id + '_' + item.productId") < DB.indexOf("po.status = 'received'"));

  /* T9 — refund / void are SERVER operations (owner 2026-10-03, decision (b)) */
  const rfB = P.slice(P.indexOf('async _processRefund(originalTxn)'), P.indexOf('async requestRefundApproval('));
  const vdB = P.slice(P.indexOf('async _processVoid(txn)'), P.indexOf('const settings = {'));
  const browserStock = (b) => (b.match(/adjustStock\([^;]*\);/g) || []).filter((c) => !/localOnly: true/.test(c));
  ck('T9a refund: the server refunds first (posProcessRefund on serverSaleId); the device mirrors ONLY server-restored lines, localOnly; no serverSaleId → refused',
    browserStock(rfB).length === 0 && rfB.indexOf("_serverOp('posProcessRefund'") > -1
    && rfB.indexOf("_serverOp('posProcessRefund'") < rfB.indexOf('adjustStock(') && rfB.indexOf('if (!originalTxn.serverSaleId)') < rfB.indexOf("_serverOp('posProcessRefund'")
    && /_restored\.has\(String\(item\.id\)\)/.test(rfB), browserStock(rfB));
  ck('T9b void: needs the APPROVED request this session raised, then posVoidSale; no approval → refused before any call; mirror localOnly, skipped on replay',
    browserStock(vdB).length === 0 && vdB.indexOf("approvalIdFor('void'") < vdB.indexOf("_serverOp('posVoidSale'")
    && vdB.indexOf('if (!_approvalId)') < vdB.indexOf("_serverOp('posVoidSale'") && /if \(!_vd\.data\.idempotent\)/.test(vdB));
  ck('T9c approval requests bind the SERVER sale id (the id the server checks), never the local txn id',
    /PosApprovalRequest\.request\('refund',\s*\{ saleId: String\(t\.serverSaleId\)/.test(P) && /PosApprovalRequest\.request\('void', \{ saleId: String\(t\.serverSaleId\) \}/.test(P)
    && !/PosApprovalRequest\.request\('(refund|void)',\s*\{ saleId: String\(txnId\)/.test(P));
  ck('T9d offline = no refund / no void (the shared server call refuses before calling)', /async _serverOp\(name, payload\) \{\s*if \(\(typeof navigator !== 'undefined' && navigator\.onLine === false\) \|\| !window\.firebaseApp\)/.test(P));
  {
    const AR = require(path.join(ROOT, 'sokoni-pos-approval-request.js'));
    AR._internal.reset();
    AR._internal.pending()['void|' + JSON.stringify({ saleId: 'S1' })] = 'AP1';
    ck('T9e approvalIdFor returns the id raised for the EXACT operation only (other sale / other type → null)',
      AR.approvalIdFor('void', { saleId: 'S1' }) === 'AP1' && AR.approvalIdFor('void', { saleId: 'S2' }) === null && AR.approvalIdFor('refund', { saleId: 'S1' }) === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH', e && e.stack); process.exit(1); });
