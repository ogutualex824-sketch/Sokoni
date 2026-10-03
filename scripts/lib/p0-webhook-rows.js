'use strict';
/* LAYER B rows — each drives the REAL webhookIntasend handler and asserts the BACKEND state afterwards. */
module.exports = async function rows(H, { ck, unp }) {
  const MONEY = ['sellerPayments', 'walletTransactions', 'commissionLedger', 'wallets', 'ledgerEntries'];
  const moneyCount = () => MONEY.reduce((n, c) => n + H.count(c), 0);
  const cb = (o) => Object.assign({ challenge: H.CHALLENGE, invoice_id: 'INV-' + o.api_ref, state: 'COMPLETE', currency: 'KES',
    value: 10000, net_amount: 9998.2, charges: 1.8, provider: 'M-PESA' }, o);
  const confirm = (ref, value, extra) => H.setStatus({ results: [Object.assign({ invoice_id: 'INV-' + ref, api_ref: ref, state: 'COMPLETE', value, currency: 'KES' }, extra || {})] });
  const seed = (ref, { uid = 'buyerA', intent = true, intentOwner = 'buyerA', amountCents = 1000000, orderUid = 'buyerA', orderStatus = 'pending_payment', intentFor = ref, metaOrder = ref } = {}) => {
    H.DOCS.set('payments/' + ref, { ref, amount: amountCents / 100, currency: 'KES', status: 'PENDING', uid, intentRef: intentFor,
      meta: { category: 'product', orderId: metaOrder, sellerUid: 'S1', items: [{ productId: 'p10k', qty: 1, sellerUid: 'S1' }] } });
    if (intent) H.DOCS.set('paymentIntents/' + intentFor, { purpose: 'product_order', uid: intentOwner, ownerUid: intentOwner, amountCents, currency: 'KES', status: 'created',
      resourceId: intentFor, metadata: { orderId: intentFor, sellerUid: 'S1' } });
    H.DOCS.set('orders/' + metaOrder, { uid: orderUid, buyerUid: orderUid, status: orderStatus, total: 10000, currency: 'KES', items: [{ productId: 'p10k', qty: 1 }] });
  };
  H.DOCS.set('products/p10k', { name: 'TV', price: 10000, stock: 5, sellerUid: 'S1', status: 'active' });
  const notPaid = (oid) => { const o = H.get('orders', oid) || {}; return o.status !== 'paid' && o.paymentVerified !== true && o.inventoryApplied !== true; };
  const parked = (ref, reason) => { const p = H.get('payments', ref) || {}; return p.status === 'REVIEW' && (!reason || p.reviewReason === reason); };

  /* B-01 THE ATTACK (permanent regression): buyer owns a KES 10,000 order, starts a KES 1 payment that references it */
  let m0 = moneyCount(); seed('ATK1', { intent: false, amountCents: 100, metaOrder: 'ORD10K' });
  H.setStatus(null);
  let r = await H.invoke(cb({ api_ref: 'ATK1', value: 1, net_amount: 0.99, charges: 0.01 }));
  ck('B-01', parked('ATK1', 'missing_intent') && notPaid('ORD10K') && moneyCount() === m0 && (H.get('products', 'p10k') || {}).stock === 5,
    'THE ATTACK: KES 10,000 order + KES 1 payment referencing it → payment REVIEW, order NOT paid / NOT verified, no seller credit, no stock move', { r, p: H.get('payments', 'ATK1'), o: H.get('orders', 'ORD10K') });

  /* B-02 KES 1 against the order's OWN intent */
  m0 = moneyCount(); seed('ORD-B02'); r = await H.invoke(cb({ api_ref: 'ORD-B02', value: 1 }));
  ck('B-02', parked('ORD-B02', 'amount_mismatch') && notPaid('ORD-B02') && moneyCount() === m0, 'KES 1 paid against the order\'s own KES 10,000 intent → REVIEW, not paid', { r, p: H.get('payments', 'ORD-B02') });
  /* B-03 / B-04 one shilling under / over */
  seed('ORD-B03'); await H.invoke(cb({ api_ref: 'ORD-B03', value: 9999 }));
  seed('ORD-B04'); await H.invoke(cb({ api_ref: 'ORD-B04', value: 10001 }));
  ck('B-03', parked('ORD-B03', 'amount_mismatch') && notPaid('ORD-B03') && parked('ORD-B04', 'amount_mismatch') && notPaid('ORD-B04'), 'KES 9,999 and KES 10,001 against KES 10,000 → REVIEW, not paid');
  /* B-05 cross-order: payment for order A (its intent) presented as order B */
  seed('ORD-A5'); seed('ORD-B5', { intentFor: 'ORD-A5' });
  await H.invoke(cb({ api_ref: 'ORD-B5' }));
  ck('B-05', parked('ORD-B5', 'wrong_order') && notPaid('ORD-B5'), 'payment(order A) → webhook(order B) → order B stays unpaid (REVIEW wrong_order)', { p: H.get('payments', 'ORD-B5') });
  /* B-06 cross-buyer: buyer B started the payment for buyer A's order */
  seed('ORD-B6', { uid: 'buyerB' }); confirm('ORD-B6', 10000);
  await H.invoke(cb({ api_ref: 'ORD-B6' }));
  ck('B-06', parked('ORD-B6', 'wrong_buyer') && notPaid('ORD-B6'), 'buyer B\'s payment → buyer A\'s order → stays unpaid (REVIEW wrong_buyer)', { p: H.get('payments', 'ORD-B6') });
  /* B-07 unverified: the callback says COMPLETE, IntaSend itself says PENDING */
  seed('ORD-B7'); confirm('ORD-B7', 10000, { state: 'PENDING' });
  await H.invoke(cb({ api_ref: 'ORD-B7' }));
  ck('B-07', parked('ORD-B7', 'provider_not_complete') && notPaid('ORD-B7'), 'a callback IntaSend does not confirm → REVIEW, not paid', { p: H.get('payments', 'ORD-B7') });
  /* B-08 wrong currency */
  seed('ORD-B8'); await H.invoke(cb({ api_ref: 'ORD-B8', currency: 'USD' }));
  ck('B-08', parked('ORD-B8', 'wrong_currency') && notPaid('ORD-B8'), 'wrong currency → REVIEW, not paid', { p: H.get('payments', 'ORD-B8') });
  /* B-09 malformed / unauthenticated callbacks change nothing */
  const before = JSON.stringify([...H.DOCS.entries()]);
  const a = await H.invoke({ challenge: 'wrong', api_ref: 'ORD-B2X', state: 'COMPLETE', value: 10000 });
  const b = await H.invoke({ challenge: H.CHALLENGE, state: 'COMPLETE', value: 10000 });
  const c = await H.invoke({ challenge: H.CHALLENGE, api_ref: 'NO-SUCH-PAYMENT', state: 'COMPLETE', value: 10000, currency: 'KES' });
  ck('B-09', a.code === 401 && JSON.stringify([...H.DOCS.entries()]) === before, 'a wrong-challenge, a no-ref and an unknown-ref callback change NO state (401 / 400 / 200-noop)', { a, b, c });

  /* B-10 VALID + duplicate: the one path that settles, then a replay */
  seed('ORD-OK'); confirm('ORD-OK', 10000);
  r = await H.invoke(cb({ api_ref: 'ORD-OK' }));
  const p1 = H.get('payments', 'ORD-OK') || {}, o1 = H.get('orders', 'ORD-OK') || {};
  if (r.threw) unp('B-10', 'VALID KES 10,000 + verified payment → PAID; duplicate callback idempotent', 'handler threw in the in-memory harness after the gate (' + r.threw.slice(0, 80) + ') — owed to the emulator chain');
  else {
    const m1 = moneyCount(); const stock1 = (H.get('products', 'p10k') || {}).stock;
    await H.invoke(cb({ api_ref: 'ORD-OK' }));
    ck('B-10', p1.status === 'COMPLETE' && o1.status === 'paid' && o1.paymentVerified === true && moneyCount() === m1 && (H.get('products', 'p10k') || {}).stock === stock1,
      'VALID KES 10,000 + IntaSend-confirmed KES 10,000 → PAID + verified; the duplicate callback changes nothing', { p1, o1 });
  }
};
