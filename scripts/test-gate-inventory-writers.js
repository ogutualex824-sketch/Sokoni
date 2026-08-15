'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Tests for the P0-2 anti-drift gate.

   A detector nobody has tried to evade is a detector nobody has tested. This
   suite answers the only question that makes the gate worth running:

       can a retired client-side inventory writer reappear without the gate
       noticing, while legitimate writers stay quiet?

   PART A  RESURRECTION — every historically-retired writer, reconstructed, must
           be detected. These are the actual shapes that shipped, not inventions.
   PART B  FALSE POSITIVES — the constructs that sank the FIRST attempt at this
           gate (it grepped bare `stock:` and flagged 14 files, nearly all wrong)
           must stay silent. A gate that cries wolf gets switched off.
   PART C  EVASION — near-misses and alternative notations. This is where a real
           regression would hide.
   PART D  REGISTER INTEGRITY — the register must describe the tree it guards.

   The gate is required as a MODULE and fed synthetic sources. Nothing is written
   into the repository: another process writes this repo, and a test that drops a
   decoy file into the root is a test that can leave debris behind.
   ───────────────────────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const gate = require('./gate-inventory-writers.js');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else      { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}

/* Detected = a resolved authority write. Unresolved counts as detected-but-unattributed,
   which the gate also refuses to pass, so both are "the gate noticed". */
function detect(src) {
  const { hits, review } = gate.scanSource('fixture.js', src);
  return { seen: hits.length + review.length, hits, review };
}
const detected = (src) => detect(src).seen > 0;

/* ═══════════════════════════════════════════════════════════════════════════
   PART A — resurrection of retired writers
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART A — a retired writer must not come back unnoticed');

/* The pos-modules.js form: the one that ACTUALLY ran in production, because
   pos-modules.js loaded after pos-omni.js and overwrote window.PosOmni. */
ok('pushStock, bare updateDoc form (the version that really ran)', detected(`
  async function pushStock(productId) {
    const product = await PosDB.products.get(productId);
    if (!product?.marketplaceId) return;
    const db = getFirestore(window.firebaseApp);
    await updateDoc(doc(db, 'products', product.marketplaceId), { stock: product.stock });
  }
`));

/* The pos-omni.js form: absolute level plus serverTimestamp and a sync marker. */
ok('pushStock, full form with serverTimestamp + posLastSync', detected(`
  async function pushStock(posProductId) {
    const product = await PosDB.products.getById(posProductId);
    const ref = fs.doc(db, 'products', product.marketplaceId);
    await fs.updateDoc(ref, {
      stock:       product.stock ?? 0,
      updatedAt:   fs.serverTimestamp(),
      posLastSync: new Date().toISOString(),
    });
  }
`));

/* The seller-wiring.js form retired in 0e13db2: quantity-blind, fire-and-forget. */
ok('seller-wiring increment form (retired in 0e13db2)', detected(`
  updateDoc(doc(db, 'products', item.id), {
    stock: increment(-1),
    sold:  increment(1),
  }).catch(() => {});
`));

/* SokoniDB.updateProductStock(), the second writer that sweep found. */
ok('SokoniDB.updateProductStock form', detected(`
  async function updateProductStock(id, qty) {
    const ref = doc(db, 'products', id);
    await updateDoc(ref, { stock: increment(-qty), sold: increment(qty) });
  }
`));

/* A replay queue is only dangerous because it eventually WRITES. The write is
   what the detector catches, so a renamed queue is caught at its write site. */
ok('a renamed offline replay queue is caught at its write site', detected(`
  const _deferred = new Set();
  async function _drain() {
    for (const id of _deferred) {
      const p = await PosDB.products.get(id);
      await updateDoc(doc(db, 'products', p.marketplaceId), { stock: p.stock });
    }
  }
`));

/* ═══════════════════════════════════════════════════════════════════════════
   PART B — the false positives that sank the first attempt
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART B — legitimate constructs must stay silent');

ok('an error MESSAGE naming stock is not a write (the inventory-engine case)', !detected(`
  if (newAvailable < 0) {
    throw new HttpsError('failed-precondition',
      \`Insufficient stock: \${prevAvailable} available, \${Math.abs(qty)} requested\`);
  }
`));

ok('a comment describing the retired write is not a write', !detected(`
  /* pushStock used to do: updateDoc(doc(db,'products',id), { stock: product.stock })
     which erased concurrent sales. Do not reintroduce it. */
  return null;
`));

ok('a product create payload with no authority field is not an inventory write', !detected(`
  await setDoc(doc(db, 'products', id), {
    name: p.name, price: p.price, category: p.category, images: p.images,
  });
`));

ok('writing stock to a DIFFERENT collection is not a products write', !detected(`
  await updateDoc(doc(db, 'inventory', branchId + '__' + productId), {
    qty: increment(delta), updatedAt: new Date().toISOString(),
  });
`));

ok('posProducts is not products', !detected(`
  await m.setDoc(m.doc(db, 'posProducts', c.id), { stock: c.stock }, { merge: true });
`));

ok('a tenant-scoped helper for another collection is not products', !detected(`
  const ref = col(tenantId, 'inventory_variants').doc(id);
  await ref.set({ stock: d.stock, active: true }, { merge: true });
`));

ok('reading stock does not count as writing it', !detected(`
  const snap = await getDoc(doc(db, 'products', id));
  const stock = snap.data().stock ?? 0;
  if (stock < qty) throw new Error('insufficient');
`));

/* ═══════════════════════════════════════════════════════════════════════════
   PART C — evasion / alternative notations
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART C — alternative notations a regression could hide in');

/* This one was a REAL blind spot: warehouse-scanner.html writes canonical stock
   through a template-literal path and the segment-only matcher could not see it. */
ok('path form db.doc(`products/${id}`) is detected', detected(`
  const productRef = db.doc(\`products/\${product.id}\`);
  tx.update(productRef, { stockQty: computedNew });
`));

ok('string-concatenated path form is detected', detected(`
  const ref = db.doc('products/' + id);
  await ref.update({ stock: 5 });
`));

ok('batch.update form is detected', detected(`
  const prodRef = db.collection('products').doc(productId);
  batch.update(prodRef, { stock: FieldValue.increment(-qty) });
`));

ok('admin SDK ref.update(payload) form is detected', detected(`
  const prodRef = db.collection('products').doc(productId);
  await prodRef.update({ stock: 0, inventoryVersion: FieldValue.increment(1) });
`));

ok('payload behind one level of indirection is detected', detected(`
  const ref   = doc(db, 'products', id);
  const patch = { stock: next, inventoryVersion: increment(1) };
  tx.update(ref, patch);
`));

ok('stockQty counts as an authority field', detected(`
  await updateDoc(doc(db, 'products', id), { stockQty: 12 });
`));

/* A dynamically-built collection name is a DECLARED blind spot. The gate must
   report it for review rather than pass it — that is the whole contract. */
{
  const r = detect(`
    const ref = db.collection(collName).doc(id);
    await ref.update({ stock: 3 });
  `);
  ok('a dynamic collection name is REVIEWED, never silently passed',
     r.review.length === 1 && r.hits.length === 0,
     `hits=${r.hits.length} review=${r.review.length}`);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART D — register integrity
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART D — the register must describe the tree it guards');

for (const e of gate.REGISTER) {
  ok(`registered file exists: ${e.file}`, fs.existsSync(path.join(ROOT, e.file)));
}
ok('every register entry carries a reason', gate.REGISTER.every((e) => e.why && e.why.length > 40));
ok('every register entry declares a site count', gate.REGISTER.every((e) => Number.isInteger(e.sites) && e.sites > 0));
ok('no file is registered in two tiers at once',
   new Set(gate.REGISTER.map((e) => e.file)).size === gate.REGISTER.length);

/* The single-writer claim: exactly one SANCTIONED client writer. Quarantine is
   explicitly NOT sanctioned, so it must not be counted toward this. */
ok('exactly one sanctioned client writer', gate.CLIENT.length === 1 && gate.CLIENT[0].file === 'pos.js');
ok('the sanctioned client writer allows exactly one site', gate.CLIENT[0].sites === 1);
ok('quarantine is non-empty and therefore NOT a clean bill of health',
   gate.QUARANTINE.length > 0);

/* The gate itself must currently pass — otherwise the register is stale. */
{
  let code = 0, out = '';
  try { out = execFileSync('node', [path.join(__dirname, 'gate-inventory-writers.js')], { encoding: 'utf8' }); }
  catch (e) { code = e.status; out = String(e.stdout || ''); }
  ok('the gate passes against the current tree', code === 0, 'exit ' + code);
  ok('the gate reports quarantine as not-a-pass', /QUARANTINE is not a pass/.test(out));
}

console.log(`\nPASS ${pass} / FAIL ${fail}\n`);
process.exit(fail === 0 ? 0 : 1);
