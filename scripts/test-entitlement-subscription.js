/* Phase 2A — subscription adapter on the canonical entitlement engine.
 *
 * Asserts the invariant rather than describing it. Every scenario in the
 * migration brief (duplicate webhook, late webhook, browser close, retry
 * storm, refund, chargeback, reconciliation replay) must converge to
 * EXACTLY ONE entitlement and ONE subscription write.
 *
 * Firestore is stubbed, so this runs anywhere with no credentials and never
 * touches production. Run: node scripts/test-entitlement-subscription.js
 */
const Path = require('path');

/* ── Firestore stub (installed before the engine is required) ───────────── */
const store = { paymentIntents: {}, payments: {}, entitlements: {},
                entitlementAuditLog: {}, subscriptions: {} };
let seq = 0;
const TS = {
  fromMillis: (m) => ({ toMillis: () => m }),
  fromDate:   (d) => ({ toMillis: () => d.getTime(), _d: d }),
};
const snapOf = (c, id) => ({ exists: !!store[c][id], data: () => store[c][id], id });
const coll = (name) => ({
  doc: (id) => ({ _c: name, _id: id, get: async () => snapOf(name, id) }),
  add: async (v) => { store[name]['a' + (++seq)] = v; return { id: 'a' + seq }; },
  where() { return this; }, orderBy() { return this; }, limit() { return this; },
  get: async () => ({ docs: [] }),
});
const fakeDb = {
  collection: coll,
  runTransaction: async (cb) => cb({
    get:    async (r) => snapOf(r._c, r._id),
    create: (r, v) => { if (store[r._c][r._id]) throw new Error('ALREADY_EXISTS'); store[r._c][r._id] = v; },
    set:    (r, v, o) => { store[r._c][r._id] = (o && o.merge) ? Object.assign({}, store[r._c][r._id], v) : v; },
    update: (r, v) => { Object.assign(store[r._c][r._id], v); },
    delete: (r) => { delete store[r._c][r._id]; },
  }),
};
require.cache[require.resolve('firebase-admin/firestore', { paths: [Path.resolve('functions')] })] = {
  id: 'x', filename: 'x', loaded: true,
  exports: { getFirestore: () => fakeDb, FieldValue: { serverTimestamp: () => 'TS' }, Timestamp: TS },
};

const engine   = require(Path.resolve('functions/entitlement-engine.js'));
const adapters = require(Path.resolve('functions/entitlement-adapters.js'));

let pass = 0, fail = 0;
/* A Promise is always truthy, so an accidental `async () => …` assertion would
   pass unconditionally. Reject thenables outright rather than silently
   counting a tautology as evidence. */
const t = (n, c) => {
  let v, ok = false;
  try { v = c(); } catch (e) { console.log('        ' + e.message); }
  if (v && typeof v.then === 'function') {
    fail++; console.log('  FAIL  ' + n + '  (async assertion — await it outside t())'); return;
  }
  ok = !!v;
  ok ? (pass++, console.log('  PASS  ' + n)) : (fail++, console.log('  FAIL  ' + n));
};

const reset = () => { for (const k of Object.keys(store)) store[k] = {}; };
const seed = (ref, over = {}) => {
  store.paymentIntents[ref] = Object.assign({
    purpose: 'subscription', planId: 'starter', ownerUid: 'u1',
    amountCents: 49900, currency: 'KES', status: 'created',
  }, over.intent || {});
  store.payments[ref] = Object.assign({
    status: 'COMPLETE', uid: 'u1', amountCents: 49900, currency: 'KES',
  }, over.payment || {});
};
const ents = () => Object.keys(store.entitlements).length;

(async () => {
  console.log('\n=== registration ===');
  t('subscription purpose registered', () => !!engine.getPurpose('subscription'));
  t('adapter exposes the 4-method contract', () => {
    const a = adapters.subscription;
    return ['validate', 'activate', 'revoke', 'status'].every((m) => typeof a[m] === 'function');
  });

  console.log('\n=== canonical shape (must equal activateSubscription exactly) ===');
  reset(); seed('R1');
  await engine.activate('R1', { source: 'webhook' });
  const CANON = ['uid', 'plan', 'status', 'paymentRef', 'activatedAt', 'expiresAt', 'updatedAt'].sort();
  t('subscriptions/u1 written', () => !!store.subscriptions.u1);
  t('exactly the 7 canonical fields', () =>
    JSON.stringify(Object.keys(store.subscriptions.u1).sort()) === JSON.stringify(CANON));
  t('plan = starter, status = active', () =>
    store.subscriptions.u1.plan === 'starter' && store.subscriptions.u1.status === 'active');
  t('no provenance leaked onto subscription', () =>
    !('source' in store.subscriptions.u1) && !('note' in store.subscriptions.u1));
  t('provenance recorded on the ledger', () => store.entitlements.R1.source === 'webhook');

  console.log('\n=== runtime scenario matrix — all converge to ONE ===');
  reset(); seed('R2');
  await engine.activate('R2', { source: 'webhook' });
  const after1 = JSON.stringify(store.subscriptions.u1);
  const dup = await engine.activate('R2', { source: 'webhook' });      /* duplicate webhook */
  t('duplicate webhook -> alreadyActive', () => dup.alreadyActive === true);
  t('duplicate webhook -> still ONE entitlement', () => ents() === 1);
  t('duplicate webhook -> subscription untouched', () => JSON.stringify(store.subscriptions.u1) === after1);

  const late = await engine.activate('R2', { source: 'reconciler' });  /* late webhook / replay */
  t('late webhook -> alreadyActive', () => late.alreadyActive === true);
  t('reconciliation replay -> still ONE', () => ents() === 1);

  const storm = await Promise.all([1, 2, 3, 4, 5].map(() => engine.activate('R2', { source: 'retry' })));
  t('retry storm x5 -> zero new activations', () => storm.every((r) => r.alreadyActive === true));
  t('retry storm -> still ONE entitlement', () => ents() === 1);

  /* Browser close: client never calls; reconciler activates later. Same entry
     point, so the result must be identical to the webhook path. */
  reset(); seed('R3');
  const healed = await engine.activate('R3', { source: 'reconciler' });
  t('browser close -> reconciler activates', () => healed.activated === true);
  t('reconciler result identical to webhook path', () =>
    JSON.stringify(Object.keys(store.subscriptions.u1).sort()) === JSON.stringify(CANON));

  console.log('\n=== money-back paths ===');
  const rv = await engine.revoke('R3', 'refund', { source: 'admin' });
  t('refund revokes', () => rv.revoked === true);
  t('subscription downgraded, not deleted', () =>
    store.subscriptions.u1 && store.subscriptions.u1.status === 'cancelled');
  t('paymentRef preserved for audit', () => store.subscriptions.u1.paymentRef === 'R3');
  const subAfterRevoke = JSON.stringify(store.subscriptions.u1);
  const rv2 = await engine.revoke('R3', 'chargeback', { source: 'admin' });
  t('chargeback after refund -> alreadyRevoked', () => rv2.alreadyRevoked === true);
  t('second revoke leaves the record untouched', () =>
    JSON.stringify(store.subscriptions.u1) === subAfterRevoke);
  const reAct = await engine.activate('R3', { source: 'webhook' });
  t('revoked entitlement cannot be re-activated', () =>
    reAct.alreadyActive === true && store.subscriptions.u1.status === 'cancelled');

  console.log('\n=== unauthorized entitlement must be impossible ===');
  reset(); seed('R4', { payment: { status: 'COMPLETE', uid: 'attacker', amountCents: 49900, currency: 'KES' } });
  let blocked = false;
  try { await engine.activate('R4', { source: 'webhook' }); } catch (e) { blocked = e.code === 'ownership_mismatch'; }
  t('foreign payment rejected', () => blocked);
  t('no subscription written', () => !store.subscriptions.u1);
  t('no entitlement written', () => ents() === 0);

  reset(); seed('R5', { payment: { status: 'PENDING', uid: 'u1', amountCents: 49900, currency: 'KES' } });
  let blocked2 = false;
  try { await engine.activate('R5', { source: 'webhook' }); } catch (e) { blocked2 = e.code === 'payment_not_terminal'; }
  t('unpaid intent rejected', () => blocked2);
  t('no entitlement from unpaid', () => ents() === 0);

  reset(); seed('R6', { intent: { purpose: 'subscription', planId: 'enterprise', ownerUid: 'u1', amountCents: 1, currency: 'KES' },
                        payment: { status: 'COMPLETE', uid: 'u1', amountCents: 1, currency: 'KES' } });
  let blocked3 = false;
  try { await engine.activate('R6', { source: 'webhook' }); } catch (e) { blocked3 = e.code === 'plan_invalid'; }
  t('unknown plan rejected by adapter.validate', () => blocked3);
  t('no entitlement from unknown plan', () => ents() === 0);

  console.log('\n' + (fail ? fail + ' FAILED of ' + (pass + fail) : 'ALL ' + pass + ' PASSED'));
  process.exit(fail ? 1 : 0);
})();
