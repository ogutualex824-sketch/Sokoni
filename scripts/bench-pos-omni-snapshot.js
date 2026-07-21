/* Startup-memory benchmark for the pos-omni product-subscription pipeline.
 *
 * Models the OLD and NEW execution strategies exactly as written in
 * pos-omni.js and measures the four metrics the hotfix claims to improve:
 * IndexedDB reads, peak concurrent promises, peak concurrent transactions,
 * and peak heap.
 *
 * This models the strategy rather than executing the module (_applySnapshot is
 * closure-scoped and not exported). The two runners below are transcriptions of
 * the real control flow — the OLD one reproduces forEach(async …) fan-out with
 * a per-change getAll(); the NEW one reproduces one read, a Map index, and
 * sequential application.
 *
 *   node --expose-gc scripts/bench-pos-omni-snapshot.js [P] [M]
 */
'use strict';

const P = Number(process.argv[2]) || 500;   // local POS products
const M = Number(process.argv[3]) || 500;   // docChanges in the snapshot (fs.limit(500))

function mkProduct(i) {
  return {
    id: 'p_' + i, marketplaceId: 'mkt_' + i,
    name: 'Product Name ' + i + ' 500ml Variant',
    price: 100 + i, cost: 60 + i, stock: 25,
    sku: 'SKU-' + i, barcode: '61900000' + i, category: 'Beverages',
    image: 'https://firebasestorage.googleapis.com/v0/b/sokoni-aeb26.appspot.com/o/product-images%2Fabcdef1234567890%2Fimg_' + i + '.jpg?alt=media&token=0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0',
    taxRate: 16, unit: 'pc', active: true,
    updatedAt: Date.now(), createdAt: Date.now(),
    supplierId: 'sup_1', reorderLevel: 5,
    description: 'Chilled beverage, 500ml bottle, case of 24',
  };
}

/* Instrumented stand-in for PosDB.products. getAll() returns a FRESH array of
   fresh objects, which is what a real IndexedDB getAll() does — that is the
   allocation the benchmark is about. */
function makeDB(rows) {
  const m = { reads: 0, saves: 0, live: 0, peakLive: 0 };
  return {
    metrics: m,
    async getAll() {
      m.reads++; m.live++; m.peakLive = Math.max(m.peakLive, m.live);
      const out = rows.map((r) => ({ ...r }));
      await new Promise((r) => setImmediate(r));   // model async IDB latency
      m.live--;
      return out;
    },
    async save() { m.saves++; },
  };
}

const changes = Array.from({ length: M }, (_, i) => ({ id: 'mkt_' + i, name: 'Updated ' + i, price: 999 + i }));

/* ── OLD: per-change getAll() + forEach(async) fan-out ──────────────── */
async function runOld(db) {
  let inflight = 0, peakInflight = 0;
  const held = [];
  changes.forEach(async (c) => {                  // ignores the promise → fan-out
    inflight++; peakInflight = Math.max(peakInflight, inflight);
    const all = await db.getAll();                // FULL read, per change
    held.push(all);                               // model residency during the burst
    const local = all.find((p) => p.marketplaceId === c.id);   // O(P)
    if (local && local.price !== c.price) { local.price = c.price; await db.save(local); }
    inflight--;
  });
  /* Drain: the real code has no completion signal either — that is the defect. */
  while (inflight > 0 || db.metrics.reads < M) await new Promise((r) => setTimeout(r, 0));
  const peakHeap = process.memoryUsage().heapUsed;
  held.length = 0;
  return { peakInflight, peakHeap };
}

/* ── NEW: one getAll(), Map index, sequential ───────────────────────── */
async function runNew(db) {
  let inflight = 0, peakInflight = 0;
  inflight++; peakInflight = Math.max(peakInflight, inflight);
  const all = await db.getAll();                  // ONE read per snapshot
  inflight--;
  const byMkt = new Map();
  for (const p of all) if (p.marketplaceId && !byMkt.has(p.marketplaceId)) byMkt.set(p.marketplaceId, p);
  for (const c of changes) {                      // sequential
    const local = byMkt.get(c.id);                // O(1)
    if (local && local.price !== c.price) { local.price = c.price; await db.save(local); }
  }
  const peakHeap = process.memoryUsage().heapUsed;
  return { peakInflight, peakHeap };
}

(async () => {
  const rows = Array.from({ length: P }, (_, i) => mkProduct(i));
  const gc = () => { if (global.gc) global.gc(); };
  const MB = (b) => (b / 1048576).toFixed(1);

  gc(); const base1 = process.memoryUsage().heapUsed;
  const dbOld = makeDB(rows); const oldR = await runOld(dbOld);
  gc(); const base2 = process.memoryUsage().heapUsed;
  const dbNew = makeDB(rows); const newR = await runNew(dbNew);

  const row = (k, a, b) => console.log('  ' + String(k).padEnd(30) + String(a).padEnd(16) + String(b));
  console.log('\nPOS-OMNI SNAPSHOT BENCHMARK   local products P=' + P + '   snapshot changes M=' + M);
  console.log('='.repeat(68));
  row('metric', 'OLD', 'NEW');
  console.log('  ' + '-'.repeat(64));
  row('IndexedDB getAll() calls', dbOld.metrics.reads, dbNew.metrics.reads);
  row('peak concurrent promises', oldR.peakInflight, newR.peakInflight);
  row('peak concurrent IDB reads', dbOld.metrics.peakLive, dbNew.metrics.peakLive);
  row('objects materialised', (dbOld.metrics.reads * P).toLocaleString(), (dbNew.metrics.reads * P).toLocaleString());
  row('lookup complexity', 'O(P) x M', 'O(1) x M');
  row('peak heap (MB)', MB(oldR.peakHeap - base1), MB(newR.peakHeap - base2));
  row('saves issued (behaviour)', dbOld.metrics.saves, dbNew.metrics.saves);

  const sameBehaviour = dbOld.metrics.saves === dbNew.metrics.saves;
  console.log('\n  identical write behaviour: ' + (sameBehaviour ? 'YES' : 'NO — INVESTIGATE'));
  console.log('  getAll() reduction       : ' + dbOld.metrics.reads + ' -> ' + dbNew.metrics.reads);
  console.log('');
  process.exitCode = sameBehaviour ? 0 : 1;
})();
