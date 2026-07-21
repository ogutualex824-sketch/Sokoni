/* Digital-download adapter tests.
 *
 * digitalPurchases is created 'completed' for free products and
 * 'pending_payment' for paid ones (digital-hub.js:218), and nothing anywhere
 * wrote 'completed' for a paid purchase — so every paid digital purchase was
 * permanently undeliverable. These tests assert the engine now performs that
 * transition, preserves the fields activation must not touch, and refuses the
 * forgery routes.
 *
 * Firestore is stubbed; runs with no credentials.
 *   node scripts/test-entitlement-digital.js
 */
'use strict';
const Path = require('path');

const store = { paymentIntents: {}, payments: {}, entitlements: {},
                entitlementAuditLog: {}, digitalPurchases: {}, subscriptions: {} };
let seq = 0;
const TS = { fromMillis: (m) => ({ toMillis: () => m }), fromDate: (d) => ({ toMillis: () => d.getTime() }) };
const ensure = (n) => (store[n] = store[n] || {});
const snapOf = (c, id) => ({ exists: !!ensure(c)[id], data: () => ensure(c)[id], id });
const coll = (n) => (ensure(n), {
  doc: (id) => ({ _c: n, _id: id, path: n + '/' + id, get: async () => snapOf(n, id) }),
  add: async (v) => { ensure(n)['a' + (++seq)] = v; return { id: 'a' + seq }; },
  where() { return this; }, orderBy() { return this; }, limit() { return this; },
  get: async () => ({ docs: [] }),
});
const fakeDb = {
  collection: coll,
  runTransaction: async (cb) => cb({
    get:    async (r) => snapOf(r._c, r._id),
    create: (r, v) => { if (ensure(r._c)[r._id]) throw new Error('EXISTS'); ensure(r._c)[r._id] = v; },
    set:    (r, v, o) => { ensure(r._c)[r._id] = (o && o.merge) ? Object.assign({}, ensure(r._c)[r._id], v) : v; },
    update: (r, v) => Object.assign(ensure(r._c)[r._id], v),
  }),
};
require.cache[require.resolve('firebase-admin/firestore', { paths: [Path.resolve('functions')] })] = {
  id: 'x', filename: 'x', loaded: true,
  exports: { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => 'TS' }, Timestamp: TS },
};

const engine = require(Path.resolve('functions/entitlement-engine.js'));
require(Path.resolve('functions/entitlement-adapters.js'));

let pass = 0, fail = 0;
const t = (n, v) => { v ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n)); };

(async () => {
  store.digitalPurchases.pur1 = {
    purchaseId: 'pur1', buyerUid: 'u1', status: 'pending_payment',
    licenseKey: 'ABC-123', allowedDownloads: 3, downloadsUsed: 0, sellerAmount: 800,
  };
  store.paymentIntents.D1 = { purpose: 'digital_download', resourceId: 'pur1', ownerUid: 'u1', amountCents: 1000, currency: 'KES' };
  store.payments.D1       = { status: 'COMPLETE', uid: 'u1', amountCents: 1000, currency: 'KES' };

  console.log('\n=== the transition that never existed ===');
  t('purpose registered', !!engine.getPurpose('digital_download'));
  const r = await engine.activate('D1', { source: 'webhook' });
  t('activated', r.activated === true);
  t('pending_payment -> completed', store.digitalPurchases.pur1.status === 'completed');
  t('paymentRef recorded', store.digitalPurchases.pur1.paymentRef === 'D1');

  console.log('\n=== activation must not overwrite purchase data ===');
  t('licenceKey preserved',      store.digitalPurchases.pur1.licenseKey === 'ABC-123');
  t('allowedDownloads preserved', store.digitalPurchases.pur1.allowedDownloads === 3);
  t('sellerAmount preserved',     store.digitalPurchases.pur1.sellerAmount === 800);

  console.log('\n=== idempotency ===');
  const dup = await engine.activate('D1', { source: 'webhook' });
  t('duplicate webhook -> alreadyActive', dup.alreadyActive === true);
  t('exactly one ledger entry', Object.keys(store.entitlements).length === 1);

  console.log('\n=== refund revokes, download history survives ===');
  store.digitalPurchases.pur1.downloadsUsed = 2;
  const rv = await engine.revoke('D1', 'refund', { source: 'admin' });
  t('revoked', rv.revoked === true);
  t('status -> revoked', store.digitalPurchases.pur1.status === 'revoked');
  t('downloadsUsed preserved (2)', store.digitalPurchases.pur1.downloadsUsed === 2);

  console.log('\n=== forgery rejected ===');
  store.paymentIntents.D2 = { purpose: 'digital_download', resourceId: 'pur2', ownerUid: 'u1', amountCents: 1000, currency: 'KES' };
  store.payments.D2       = { status: 'COMPLETE', uid: 'attacker', amountCents: 1000, currency: 'KES' };
  let code = null;
  try { await engine.activate('D2', { source: 'webhook' }); } catch (e) { code = e.code; }
  t('foreign payment rejected', code === 'ownership_mismatch');
  t('no purchase completed', !store.digitalPurchases.pur2);

  store.paymentIntents.D3 = { purpose: 'digital_download', resourceId: 'pur3', ownerUid: 'u1', amountCents: 1000, currency: 'KES' };
  store.payments.D3       = { status: 'PENDING', uid: 'u1', amountCents: 1000, currency: 'KES' };
  code = null;
  try { await engine.activate('D3', { source: 'webhook' }); } catch (e) { code = e.code; }
  t('unpaid rejected', code === 'payment_not_terminal');

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
  process.exitCode = fail ? 1 : 0;
})();
