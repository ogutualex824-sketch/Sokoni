/* ══════════════════════════════════════════════════════════════════════════════
   SHARED PRODUCT WRITER — 2b-0, certified BEFORE any UI consumes it
   ══════════════════════════════════════════════════════════════════════════════
   Products was about to gain a second write path: seller.js writes product
   documents by importing the Firestore SDK inline, and a native module doing
   the same would leave two writers for one collection.

   The property that matters most is negative, and it is the one a careless
   implementation gets wrong:

       a REFUSED canPublishProduct must perform ZERO mutation —
       not a write followed by an error.

   So the adapter here RECORDS every write it is asked to perform, and the
   refusal tests assert that record stayed empty. An adapter that merely
   returned an error would prove nothing about what was written first.

   Run: node scripts/test-merchant-product-writer.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const M = require(path.join(ROOT, 'sokoni-merchant-data.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

console.log('\nSHARED PRODUCT WRITER (2b-0)');
console.log('='.repeat(76));

const SCOPE = { ok: true, shopId: 'shop_A', sellerUid: 'uid_A' };
const OTHER = { ok: true, shopId: 'shop_B', sellerUid: 'uid_B' };

/* Records everything. The point is to observe what WAS written, not to simulate
   Firestore. */
function adapter(seed) {
  const store = Object.assign({}, seed || {});
  const log = [];
  return {
    log,
    store,
    writeProduct: async ({ id, data, mode }) => {
      log.push({ op: mode || 'write', id });
      if (mode === 'create' && store[id]) return { replayed: true };
      store[id] = Object.assign({}, store[id] || {}, data);
      return { replayed: false };
    },
    deleteProduct: async ({ id }) => { log.push({ op: 'delete', id }); delete store[id]; },
    getProduct: async (id) => store[id] || null,
    queryProducts: async () => Object.values(store),
  };
}
const allow = async () => ({ data: { allowed: true } });
const refuse = async () => ({ data: { allowed: false, upgrade: { message: 'Upgrade to add more products.' } } });

(async () => {
  head('1 - the allowed create path');
  let db = adapter();
  const r1 = await M.createProduct({
    scope: SCOPE, db, draftToken: 't1', canPublish: allow,
    product: { name: 'Sukuma Wiki', price: 40, stock: 12, sku: 'SW-1' },
  });
  ck('it created a product', !!r1.id, r1.id);
  ck('exactly one write was performed', db.log.length === 1, JSON.stringify(db.log));
  ck('ownership comes from the SCOPE', db.store[r1.id].shopId === 'shop_A' &&
     db.store[r1.id].sellerUid === 'uid_A');
  ck('the fields were stored', db.store[r1.id].name === 'Sukuma Wiki' && db.store[r1.id].price === 40);
  ck('status defaults to active', db.store[r1.id].status === 'active');

  head('2 - a REFUSED publish performs ZERO mutation');
  db = adapter();
  let refused = null;
  try {
    await M.createProduct({
      scope: SCOPE, db, draftToken: 't2', canPublish: refuse,
      product: { name: 'Blocked', price: 10 },
    });
  } catch (e) { refused = e; }
  ck('the create threw', !!refused, refused && refused.code);
  ck('it carries the server upgrade message', /Upgrade to add more products/.test(refused.message));
  ck('NOTHING was written — the adapter log is EMPTY', db.log.length === 0,
     JSON.stringify(db.log));
  ck('the store is empty', Object.keys(db.store).length === 0);
  ck('the error states it wrote nothing', refused.wrote === false);

  head('3 - the gate is consulted BEFORE the write, not after');
  /* Order matters: a gate asked after the write turns a refusal into a rollback,
     and a rollback that fails leaves a product the merchant may not have. */
  db = adapter();
  const order = [];
  try {
    await M.createProduct({
      scope: SCOPE, db, draftToken: 't3',
      canPublish: async () => { order.push('gate'); return { data: { allowed: false } }; },
      product: { name: 'X', price: 1 },
    });
  } catch (_) {}
  db.log.forEach(() => order.push('write'));
  ck('the gate ran and no write followed', order.join(',') === 'gate', order.join(',') || 'nothing ran');

  head('4 - IDEMPOTENCY: a replayed create makes no second product');
  db = adapter();
  const a = await M.createProduct({ scope: SCOPE, db, draftToken: 'same', canPublish: allow,
    product: { name: 'Once', price: 5 } });
  const b = await M.createProduct({ scope: SCOPE, db, draftToken: 'same', canPublish: allow,
    product: { name: 'Once', price: 5 } });
  ck('the same draftToken yields the same id', a.id === b.id, a.id);
  ck('only ONE product exists', Object.keys(db.store).length === 1,
     Object.keys(db.store).length + ' product(s)');
  ck('the replay is reported as such', b.replayed === true);
  const c = await M.createProduct({ scope: SCOPE, db, draftToken: 'different', canPublish: allow,
    product: { name: 'Twice', price: 5 } });
  ck('a DIFFERENT token yields a different product', c.id !== a.id &&
     Object.keys(db.store).length === 2, Object.keys(db.store).length + ' product(s)');

  head('5 - SCOPE isolation');
  db = adapter({ p_other: { shopId: 'shop_B', name: 'Theirs', price: 9 } });
  let scopeErr = null;
  try { await M.updateProduct({ scope: SCOPE, db, id: 'p_other', patch: { price: 1 } }); }
  catch (e) { scopeErr = e; }
  ck('editing ANOTHER shop\'s product is refused', !!scopeErr, scopeErr && scopeErr.message.slice(0, 60));
  ck('...and nothing was written', db.log.length === 0, JSON.stringify(db.log));
  scopeErr = null;
  try { await M.deleteProduct({ scope: SCOPE, db, id: 'p_other' }); } catch (e) { scopeErr = e; }
  ck('deleting ANOTHER shop\'s product is refused', !!scopeErr);
  ck('...and nothing was deleted', !!db.store.p_other && db.log.length === 0);
  ck('a product cannot be MOVED between shops by an edit', await (async () => {
    const d2 = adapter({ mine: { shopId: 'shop_A', name: 'Mine', price: 5 } });
    await M.updateProduct({ scope: SCOPE, db: d2, id: 'mine', patch: { shopId: 'shop_B', price: 6 } });
    return d2.store.mine.shopId === 'shop_A';
  })(), 'shopId is not patchable');

  head('6 - EDIT does not consume publication capacity');
  db = adapter({ mine: { shopId: 'shop_A', name: 'Mine', price: 5 } });
  let gateAsked = false;
  await M.updateProduct({ scope: SCOPE, db, id: 'mine', patch: { price: 7 },
    canPublish: async () => { gateAsked = true; return { data: { allowed: false } }; } });
  ck('updating does NOT ask canPublishProduct', gateAsked === false,
     'a merchant AT their limit must still be able to fix a typo');
  ck('the edit was applied', db.store.mine.price === 7);

  head('7 - it does NOT do 2c or repair counters');
  const src = require('fs').readFileSync(path.join(ROOT, 'sokoni-merchant-data.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
  ck('no Storage upload in the writer', !/uploadBytes|getDownloadURL|putString/.test(code));
  ck('no productCounters write', code.indexOf('productCounters') === -1);
  ck('no subscription rule reimplemented',
     code.indexOf('listingLimit') === -1 && code.indexOf('uploadLimit') === -1);
  ck('no inline Firestore SDK import', !/firebasejs[^'"]*firebase-firestore/.test(code));
  ck('NC the stripper left the code intact', code.indexOf('function createProduct') > -1);

  head('8 - a product with NO media is valid');
  db = adapter();
  const noMedia = await M.createProduct({ scope: SCOPE, db, draftToken: 'nm', canPublish: allow,
    product: { name: 'No pictures', price: 30 } });
  ck('it was created', !!noMedia.id);
  ck('no image field was invented',
     db.store[noMedia.id].image === undefined && db.store[noMedia.id].images === undefined,
     'media attaches in 2c; the record is valid without it');

  head('9 - a read-only adapter FAILS LOUDLY');
  let roErr = null;
  try {
    await M.createProduct({ scope: SCOPE, db: { queryProducts: async () => [] },
      draftToken: 'ro', canPublish: allow, product: { name: 'X', price: 1 } });
  } catch (e) { roErr = e; }
  ck('it refuses an adapter that cannot write', !!roErr && /cannot write products/.test(roErr.message),
     roErr && roErr.message);

  head('10 - validation refuses nonsense BEFORE writing');
  for (const [label, product] of [
    ['a nameless product', { price: 5 }],
    ['a priceless product', { name: 'X' }],
    ['a zero price', { name: 'X', price: 0 }],
    ['a negative price', { name: 'X', price: -1 }],
    ['negative stock', { name: 'X', price: 5, stock: -3 }],
  ]) {
    const d3 = adapter();
    let ve = null;
    try { await M.createProduct({ scope: SCOPE, db: d3, draftToken: 'v', canPublish: allow, product }); }
    catch (e) { ve = e; }
    ck('  ' + label + ' is refused, and nothing written',
       !!ve && d3.log.length === 0, ve ? ve.message.slice(0, 40) : 'accepted!');
  }

  head('11 - NEGATIVE CONTROLS: the adapter really observes writes');
  const d4 = adapter();
  await M.createProduct({ scope: SCOPE, db: d4, draftToken: 'nc', canPublish: allow,
    product: { name: 'Observed', price: 2 } });
  ck('an ALLOWED create DOES appear in the log', d4.log.length === 1,
     'so the empty logs in sections 2/5/10 are real, not a blind adapter');
  ck('no scope at all is refused', await (async () => {
    try { await M.createProduct({ scope: { ok: false }, db: adapter(), draftToken: 'x',
      product: { name: 'X', price: 1 } }); return false; } catch (_) { return true; }
  })());

  head('what this does NOT prove');
  un('Firestore rules enforcement', 'the adapter is in-memory; rules are proven by the rules suite');
  un('the 2b UI', 'not built yet — the writer is certified first, deliberately');

  console.log('\n' + '='.repeat(76));
  console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
  console.log('='.repeat(76) + '\n');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('\n  aborted: ' + (e && e.stack) + '\n'); process.exit(1); });
