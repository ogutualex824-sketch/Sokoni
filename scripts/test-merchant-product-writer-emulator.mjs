/* ══════════════════════════════════════════════════════════════════════════════
   SHARED PRODUCT WRITER vs REAL FIRESTORE + THE DEPLOYED RULESET  (2b-0)
   ══════════════════════════════════════════════════════════════════════════════
     npx firebase emulators:exec --only firestore \
       "node scripts/test-merchant-product-writer-emulator.mjs"

   test-merchant-product-writer.js proves the writer's DECISIONS against an
   in-memory adapter that records what it was asked to do. That adapter is my
   model of a datastore, so it cannot prove the writer's decisions survive
   contact with Firestore, and it cannot prove anything at all about rules.

   This suite closes both gaps:

     · every refusal is verified by QUERYING FIRESTORE afterwards, not by
       inspecting a log. "Nothing was written" means the collection is empty on
       the server.
     · the ruleset loaded is the one Firebase is SERVING, fetched live by
       scripts/fetch-deployed-rules.js. Not firestore.rules.live: that file was
       believed to be the live copy and is 145 diff lines behind it. A writer
       certified against rules nobody is running is certified against nothing.

   Products are written CLIENT-DIRECT (there is no product callable — verified:
   functions/index.js exports none), so rules are the entire server-side defence.
   That makes rules part of this writer's contract rather than someone else's
   problem.
   ══════════════════════════════════════════════════════════════════════════════ */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import {
  doc, setDoc, getDoc, deleteDoc, collection, getDocs, query, where, runTransaction,
} from 'firebase/firestore';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { createRequire } = await import('node:module');
const M = createRequire(import.meta.url)(path.join(ROOT, 'sokoni-merchant-data.js'));

let pass = 0, fail = 0, unproven = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; };
const un = (l, d) => { console.log('  UNPROVEN  ' + l + (d ? '   [' + d + ']' : '')); unproven++; };
const head = (t) => console.log('\n' + t);

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('\n  ENV — FIRESTORE_EMULATOR_HOST is unset. Run through:');
  console.log('    npx firebase emulators:exec --only firestore "node scripts/test-merchant-product-writer-emulator.mjs"\n');
  process.exit(2);                       /* ENV, not PASS and not FAIL */
}

/* The ruleset Firebase is ACTUALLY SERVING, fetched by scripts/fetch-deployed-rules.js.
   NOT firestore.rules.live: that file was believed to be the live copy and is 145
   diff lines behind — it lacks isSeller(), lacks the safe token.get('deactivated',
   false) form, and lacks the rider completion hardening. Certifying against it
   certified against a ruleset nobody is running. */
const RULES_FILE = path.join(ROOT, 'firestore.rules.deployed');
if (!fs.existsSync(RULES_FILE)) {
  console.log('\n  ENV — no firestore.rules.deployed. Run: node scripts/fetch-deployed-rules.js\n');
  process.exit(2);
}
const [host, port] = process.env.FIRESTORE_EMULATOR_HOST.split(':');

console.log('\nSHARED PRODUCT WRITER vs DEPLOYED RULES (2b-0)');
console.log('='.repeat(78));
console.log('  ruleset: firestore.rules.deployed — what Firebase serves (' + fs.statSync(RULES_FILE).size + ' bytes)');
console.log('  emulator: ' + process.env.FIRESTORE_EMULATOR_HOST);

const env = await initializeTestEnvironment({
  projectId: 'sokoni-writer-2b0',
  firestore: { rules: fs.readFileSync(RULES_FILE, 'utf8'), host, port: Number(port) },
});

const UID_A = 'sellerA', UID_B = 'sellerB';

/* An ORDINARY APPROVED SELLER's token, and nothing more: the `seller` claim that
   admin approval grants, no `deactivated` key, no admin. This is the shape the
   deployed rule actually has to admit, so it is the shape the writer is certified
   against. Section 0 proves both halves of it. */
const ACTIVE_CLAIMS = { seller: true };

const SCOPE_A = { ok: true, shopId: UID_A, sellerUid: UID_A };
const SCOPE_B = { ok: true, shopId: UID_B, sellerUid: UID_B };

/* The REAL adapter — the shape merchant-v2's shell will have to provide. Create
   uses a transaction rather than get()-then-set() so a replay cannot interleave
   into a second document. */
function fsAdapter(db) {
  return {
    writeProduct: async ({ id, data, mode }) => {
      const ref = doc(db, 'products', id);
      if (mode === 'create') {
        return runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (snap.exists()) return { replayed: true };
          tx.set(ref, data);
          return { replayed: false };
        });
      }
      await setDoc(ref, data, { merge: true });
      return { replayed: false };
    },
    deleteProduct: async ({ id }) => deleteDoc(doc(db, 'products', id)),
    getProduct: async (id) => {
      const s = await getDoc(doc(db, 'products', id));
      return s.exists() ? s.data() : null;
    },
    queryProducts: async (spec) => {
      const parts = (spec.where || []).map((w) => where(w[0], w[1], w[2]));
      const snap = await getDocs(query(collection(db, spec.collection), ...parts));
      return snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
    },
    writeMirror: async ({ path: p, data, merge }) => setDoc(doc(db, ...p), data, { merge: !!merge }),
  };
}

const allow  = async () => ({ data: { allowed: true } });
const refuse = async () => ({ data: { allowed: false, upgrade: { message: 'Upgrade to add more products.' } } });

/* Server-side truth. Always read through a rules-BYPASSING context, so a query
   that is merely DENIED can never be mistaken for an empty collection — that
   confusion would turn every negative test into a false pass. */
async function serverProducts() {
  let rows = [];
  await env.withSecurityRulesDisabled(async (c) => {
    const snap = await getDocs(collection(c.firestore(), 'products'));
    rows = snap.docs.map((d) => Object.assign({ id: d.id }, d.data()));
  });
  return rows;
}
async function serverDoc(...p) {
  let out = null;
  await env.withSecurityRulesDisabled(async (c) => {
    const s = await getDoc(doc(c.firestore(), ...p));
    out = s.exists() ? s.data() : null;
  });
  return out;
}
async function seed(fn) { await env.withSecurityRulesDisabled(async (c) => fn(c.firestore())); }

const dbA = () => fsAdapter(env.authenticatedContext(UID_A, ACTIVE_CLAIMS).firestore());
const dbB = () => fsAdapter(env.authenticatedContext(UID_B, ACTIVE_CLAIMS).firestore());

try {
  /* ───────────────────────────────────────────────────────────────────────── */
  head('0 - who the DEPLOYED products rule admits');
  /* Two separate gates, and it matters which is which. isActive() is about
     deactivation; isSeller() is about approval. An earlier reading of the STALE
     firestore.rules.live suggested isActive() refuses any token lacking a
     `deactivated` key — true of that file, false of what is deployed, which uses
     token.get('deactivated', false). Measured here rather than argued. */
  await env.clearFirestore();
  const mkProduct = (d, id) => setDoc(doc(d, 'products', id),
    { name: 'X', price: 5, sellerUid: UID_A, shopId: UID_A });
  const tryAs = async (claims, id) =>
    mkProduct(env.authenticatedContext(UID_A, claims).firestore(), id)
      .then(() => 'ALLOWED', () => 'DENIED');

  const asSeller      = await tryAs({ seller: true }, 'w_seller');
  const asSellerDeact = await tryAs({ seller: true, deactivated: true }, 'w_deact');
  const asNobody      = await tryAs({}, 'w_nobody');
  const asBuyer       = await tryAs({ buyer: true }, 'w_buyer');

  ck('an approved seller with NO `deactivated` key may create',
     asSeller === 'ALLOWED',
     'the deployed isActive() uses token.get(\'deactivated\', false) — a missing key is NOT an error');
  ck('a DEACTIVATED seller may not', asSellerDeact === 'DENIED');
  ck('a signed-in user with no seller claim may not', asNobody === 'DENIED',
     'isSeller() — approval is the claim, not sellers/{uid}');
  ck('nor a buyer', asBuyer === 'DENIED');
  console.log('  note   product creation needs BOTH: not deactivated (isActive) AND');
  console.log('         approved (isSeller). Ordinary approved merchants are NOT blocked.');

  head('1 - the allowed create reaches Firestore and satisfies the deployed rules');
  await env.clearFirestore();
  const r1 = await M.createProduct({
    scope: SCOPE_A, db: dbA(), draftToken: 'tok-1', canPublish: allow,
    product: { name: 'Sukuma Wiki', price: 40, costPrice: 25, stock: 12, sku: 'SW-1' },
  });
  let rows = await serverProducts();
  ck('exactly one product exists ON THE SERVER', rows.length === 1, rows.length + ' row(s)');
  ck('the deployed ruleset ACCEPTED it', rows[0] && rows[0].id === r1.id, r1.id);
  ck('sellerUid matches the authenticated uid', rows[0].sellerUid === UID_A,
     'the rule requires request.resource.data.sellerUid == request.auth.uid');

  head('2 - a REFUSED canPublishProduct leaves Firestore UNTOUCHED');
  await env.clearFirestore();
  let refused = null;
  try {
    await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'tok-2', canPublish: refuse,
      product: { name: 'Blocked', price: 10 } });
  } catch (e) { refused = e; }
  rows = await serverProducts();
  ck('the create threw', !!refused, refused && refused.code);
  ck('the products collection is EMPTY on the server', rows.length === 0,
     rows.length + ' row(s) — read with rules DISABLED, so this is real absence');
  ck('no POS mirror was left behind', (await serverDoc('posProducts',
     M.productDraftId({ scope: SCOPE_A, draftToken: 'tok-2' }))) === null);
  ck('no Inventory mirror was left behind', (await serverDoc('tenants', UID_A,
     'inventory_products', M.productDraftId({ scope: SCOPE_A, draftToken: 'tok-2' }))) === null);

  head('3 - DEFENCE IN DEPTH: rules refuse even if the client gate is bypassed');
  /* withinProductLimit() reads productCounters/{uid}. Seeding it here is the test
     rig establishing a precondition — the writer still never writes that document,
     which section 7 proves. */
  await env.clearFirestore();
  await seed((db) => setDoc(doc(db, 'productCounters', UID_A), { count: 5, maxProducts: 5 }));
  let ruleErr = null;
  try {
    /* canPublish deliberately OMITTED — this is the bypass being modelled. */
    await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'tok-3',
      product: { name: 'Over the limit', price: 10 } });
  } catch (e) { ruleErr = e; }
  rows = await serverProducts();
  ck('Firestore itself refused the write', !!ruleErr,
     ruleErr && String(ruleErr.code || ruleErr.message).slice(0, 40));
  ck('nothing was created', rows.length === 0, rows.length + ' row(s)');
  ck('NC below the limit the SAME call succeeds', await (async () => {
    await seed((db) => setDoc(doc(db, 'productCounters', UID_A), { count: 1, maxProducts: 5 }));
    await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'tok-3b',
      product: { name: 'Within limit', price: 10 } });
    return (await serverProducts()).length === 1;
  })(), 'so the refusal above was the LIMIT, not a broken call');

  head('4 - IDEMPOTENCY against the real transaction engine');
  await env.clearFirestore();
  const i1 = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'dup', canPublish: allow,
    product: { name: 'Once', price: 5 } });
  const i2 = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'dup', canPublish: allow,
    product: { name: 'Once', price: 5 } });
  rows = await serverProducts();
  ck('the replay claimed the same id', i1.id === i2.id, i1.id);
  ck('exactly ONE product exists on the server', rows.length === 1, rows.length + ' row(s)');
  ck('the replay reported itself as a replay', i2.replayed === true);

  head('4b - CONCURRENT replays: a double tap cannot make two products');
  await env.clearFirestore();
  const burst = await Promise.allSettled(Array.from({ length: 5 }, () =>
    M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'race', canPublish: allow,
      product: { name: 'Raced', price: 7 } })));
  rows = await serverProducts();
  ck('5 simultaneous creates produced ONE product', rows.length === 1,
     rows.length + ' row(s); settled=' + burst.map((b) => b.status[0]).join(''));

  head('5 - SCOPE isolation, enforced by rules and not only by the writer');
  await env.clearFirestore();
  const owned = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'own', canPublish: allow,
    product: { name: 'A’s product', price: 20 } });
  let xErr = null;
  try { await M.updateProduct({ scope: SCOPE_B, db: dbB(), id: owned.id, patch: { price: 1 } }); }
  catch (e) { xErr = e; }
  ck('seller B cannot edit seller A\'s product', !!xErr, xErr && String(xErr.code || xErr.message).slice(0, 40));
  ck('the price is unchanged on the server', (await serverDoc('products', owned.id)).price === 20);
  xErr = null;
  try { await M.deleteProduct({ scope: SCOPE_B, db: dbB(), id: owned.id }); } catch (e) { xErr = e; }
  ck('seller B cannot delete it either', !!xErr);
  ck('it still exists', (await serverDoc('products', owned.id)) !== null);
  ck('B cannot forge A\'s sellerUid directly', await (async () => {
    const b = env.authenticatedContext(UID_B, ACTIVE_CLAIMS).firestore();
    return assertFails(setDoc(doc(b, 'products', 'forged'),
      { name: 'Forged', price: 5, sellerUid: UID_A, shopId: UID_A })).then(() => true, () => false);
  })(), 'the rule pins sellerUid to request.auth.uid');

  head('6 - the writer\'s price floor MATCHES the rule (not merely stricter-looking)');
  await env.clearFirestore();
  let zeroErr = null;
  try {
    await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'zero', canPublish: allow,
      product: { name: 'Free thing', price: 0 } });
  } catch (e) { zeroErr = e; }
  ck('the writer refuses price 0', !!zeroErr, zeroErr && zeroErr.message);
  ck('NC Firestore would ALSO have refused price 0', await (async () => {
    const a = env.authenticatedContext(UID_A, ACTIVE_CLAIMS).firestore();
    return assertFails(setDoc(doc(a, 'products', 'zerop'),
      { name: 'Free thing', price: 0, sellerUid: UID_A, shopId: UID_A })).then(() => true, () => false);
  })(), 'validPrice requires > 0 — so accepting 0 client-side WOULD have been a false success');

  head('7 - productCounters is READ ONLY, and the rules agree');
  await env.clearFirestore();
  await seed((db) => setDoc(doc(db, 'productCounters', UID_A), { count: 1, maxProducts: 50 }));
  const before = JSON.stringify(await serverDoc('productCounters', UID_A));
  await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'ctr', canPublish: allow,
    product: { name: 'Counted', price: 15 } });
  const after = JSON.stringify(await serverDoc('productCounters', UID_A));
  ck('the counter is byte-identical after a create', before === after, before + ' -> ' + after);
  ck('the counter is not repaired to match reality', JSON.parse(after).count === 1,
     'one product now exists but count stays 1 — drift is NOT this writer\'s to fix');
  ck('NC rules forbid writing it at all', await assertFails(
     setDoc(doc(env.authenticatedContext(UID_A, ACTIVE_CLAIMS).firestore(), 'productCounters', UID_A), { count: 99 })
     ).then(() => true, () => false), 'allow write: if false');

  head('8 - the MIRRORS actually land (POS + Inventory), verified server-side');
  await env.clearFirestore();
  const mir = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'mir', canPublish: allow,
    product: { name: 'Mirrored', price: 250, costPrice: 100, stock: 8, category: 'Groceries' } });
  const pos = await serverDoc('posProducts', mir.id);
  const inv = await serverDoc('tenants', UID_A, 'inventory_products', mir.id);
  ck('the product is at the POS till', !!pos, pos && pos.name);
  ck('POS carries the selling price', pos && pos.price === 250);
  ck('POS ownership is the seller', pos && pos.sellerId === UID_A);
  ck('the product is in Inventory Manager', !!inv, inv && inv.name);
  ck('Inventory maps price -> sellingPrice', inv && inv.sellingPrice === 250);
  ck('Inventory maps costPrice -> buyingPrice', inv && inv.buyingPrice === 100,
     'a lossy mapping here would report a 100% margin on every product');
  ck('Inventory maps stock -> stockLevel', inv && inv.stockLevel === 8);
  ck('Inventory links back to the storefront product', inv && inv.sourceProductId === mir.id);
  ck('the create REPORTS both mirrors landed', mir.complete === true, JSON.stringify(mir.mirrors));

  head('9 - a FAILED mirror is reported, never silently swallowed');
  /* The behaviour being replaced is `.catch(function(){})` — a denial there is
     indistinguishable from success, so a merchant is told the product is live
     when it never reached the till. */
  await env.clearFirestore();
  const crippled = dbA();
  crippled.writeMirror = async ({ path: p }) => {
    if (p[0] === 'posProducts') throw new Error('permission-denied');
    return setDoc(doc(env.authenticatedContext(UID_A, ACTIVE_CLAIMS).firestore(), ...p), {}, { merge: true });
  };
  const partial = await M.createProduct({ scope: SCOPE_A, db: crippled, draftToken: 'part',
    canPublish: allow, product: { name: 'Partial', price: 11 } });
  rows = await serverProducts();
  ck('the canonical product still exists', rows.length === 1,
     'a mirror failure must never cost the merchant their listing');
  ck('the failure is REPORTED', partial.mirrors.pos.state === 'failed', JSON.stringify(partial.mirrors.pos));
  ck('the result is NOT marked complete', partial.complete === false,
     'so the UI can say "created, not yet at the till" instead of an unqualified success');

  head('10 - a replay REPAIRS a mirror that failed the first time');
  const repaired = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'part',
    canPublish: allow, product: { name: 'Partial', price: 11 } });
  ck('the retry wrote no second product', (await serverProducts()).length === 1);
  ck('the POS mirror now exists', (await serverDoc('posProducts', repaired.id)) !== null);
  ck('and the result is now complete', repaired.complete === true);

  head('11 - update and delete on the owner\'s own product');
  await env.clearFirestore();
  const own2 = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'ud', canPublish: allow,
    product: { name: 'Editable', price: 30 } });
  await M.updateProduct({ scope: SCOPE_A, db: dbA(), id: own2.id, patch: { price: 45 } });
  ck('the owner can edit the price', (await serverDoc('products', own2.id)).price === 45);
  await M.updateProduct({ scope: SCOPE_A, db: dbA(), id: own2.id, patch: { sellerUid: UID_B, price: 46 } });
  ck('sellerUid survives an attempt to patch it', (await serverDoc('products', own2.id)).sellerUid === UID_A,
     'the writer strips it AND the rule forbids changing it');
  await M.deleteProduct({ scope: SCOPE_A, db: dbA(), id: own2.id });
  ck('the owner can delete it', (await serverDoc('products', own2.id)) === null);

  head('12 - the base64 image incident cannot recur through this writer');
  await env.clearFirestore();
  const b64 = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'b64', canPublish: allow,
    product: { name: 'Sneaky', price: 60, image: 'data:image/png;base64,AAAA', imageUrl: 'data:image/png;base64,BBBB' } });
  const stored = await serverDoc('products', b64.id);
  ck('the writer DROPPED both image fields', stored.image === undefined && stored.imageUrl === undefined,
     'media is 2c\'s job; the whitelist does not carry it');
  ck('NC the rule would have rejected a data: URI', await assertFails(
     setDoc(doc(env.authenticatedContext(UID_A, ACTIVE_CLAIMS).firestore(), 'products', 'b64direct'),
       { name: 'X', price: 5, sellerUid: UID_A, shopId: UID_A, image: 'data:image/png;base64,AAAA' })
     ).then(() => true, () => false), 'noBase64Image — the PEACH MANGO ICE backstop');

  head('13 - a product with no media is a VALID product');
  await env.clearFirestore();
  const nm = await M.createProduct({ scope: SCOPE_A, db: dbA(), draftToken: 'nomedia', canPublish: allow,
    product: { name: 'No pictures', price: 30 } });
  ck('it was accepted by the deployed rules', (await serverDoc('products', nm.id)) !== null);
  ck('and it reached the till', (await serverDoc('posProducts', nm.id)) !== null,
     'a merchant can sell it before ever adding a photo');

  head('what this suite does NOT prove');
  un('App Check enforcement', 'the emulator does not enforce it; production does');
  un('shopId isolation server-side', 'the deployed rule pins sellerUid ONLY — a seller with two shops ' +
     'is separated by the WRITER, not by rules. Recorded as a known limit, not closed here.');
  un('the 2b UI', 'not built; the writer is certified first, deliberately');

} finally {
  await env.cleanup();
}

console.log('\n' + '='.repeat(78));
console.log('  ' + pass + ' passed, ' + fail + ' failed, ' + unproven + ' unproven');
console.log('  ruleset under test: the one Firebase is serving (' +
            fs.statSync(RULES_FILE).size + ' bytes), NOT firestore.rules.live.');
console.log('='.repeat(78) + '\n');
process.exit(fail ? 1 : 0);
