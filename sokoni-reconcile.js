/* ════════════════════════════════════════════════════════════════════════
   SokoniReconcile — commerce data-convergence status + idempotent reconciliation.

   The canonical records are unchanged and remain the source of truth:
     products/{id}                          ← ONE product source
     tenants/{uid}/inventory_products/{id}  ← inventory mirror (linked by sourceProductId)
     posProducts/{id}                       ← POS mirror (same id)
     orders/{id} + PosDB.transactions + deliveries → OrderService.UnifiedOrderView

   This module does NOT introduce a new source. It (1) MEASURES drift between the
   canonical products and their caches, and between order sources and the unified
   view, and (2) offers an IDEMPOTENT reconcile that rebuilds a stale/missing cache
   FROM the canonical — never the other way round. Running reconcile twice changes
   nothing the second time.

   The comparison logic is pure (no I/O) so it is unit-tested deterministically; the
   live reads/writes wrap it.
   ════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  function _num (n) { return Number(n || 0); }
  /* Fields whose divergence between canonical and a cache counts as a mismatch. */
  function _prodKey (p) { return (p.name || '') + '|' + _num(p.price != null ? p.price : p.sellingPrice) + '|' + _num(p.stock != null ? p.stock : p.stockLevel); }

  /* ── PURE: product convergence ────────────────────────────────────────────
     canonical: [{id,name,price,stock,...}]  (products/{id})
     posMirror: [{id,...}]                    (posProducts/{id}, same id)
     invMirror: [{sourceProductId|id,...}]    (inventory_products, linked)
     Returns counts + the ids that are missing/mismatched per cache. */
  function productConvergence (canonical, posMirror, invMirror) {
    canonical = canonical || []; posMirror = posMirror || []; invMirror = invMirror || [];
    var posById = {}; posMirror.forEach(function (p) { posById[p.id] = p; });
    var invById = {}; invMirror.forEach(function (p) { invById[p.sourceProductId || p.id] = p; });
    var missing = [], mismatched = [];
    canonical.forEach(function (c) {
      var pos = posById[c.id], inv = invById[c.id];
      if (!pos) missing.push({ id: c.id, cache: 'pos' });
      else if (_prodKey(pos) !== _prodKey(c)) mismatched.push({ id: c.id, cache: 'pos' });
      if (!inv) missing.push({ id: c.id, cache: 'inventory' });
      else if (_prodKey(inv) !== _prodKey(c)) mismatched.push({ id: c.id, cache: 'inventory' });
    });
    /* Orphan cache rows (present in a mirror but not canonical) are surfaced too. */
    var canonIds = {}; canonical.forEach(function (c) { canonIds[c.id] = 1; });
    var orphans = [];
    posMirror.forEach(function (p) { if (!canonIds[p.id]) orphans.push({ id: p.id, cache: 'pos' }); });
    invMirror.forEach(function (p) { var k = p.sourceProductId || p.id; if (!canonIds[k]) orphans.push({ id: k, cache: 'inventory' }); });
    return {
      canonical: canonical.length, posCache: posMirror.length, inventory: invMirror.length,
      missing: missing.length, mismatched: mismatched.length, orphans: orphans.length,
      ok: missing.length === 0 && mismatched.length === 0 && orphans.length === 0,
      _missing: missing, _mismatched: mismatched, _orphans: orphans
    };
  }

  /* ── PURE: order convergence ──────────────────────────────────────────────
     Reconciles order sources into ONE identity. marketplace/pos are order-bearing;
     deliveries attach to an order by orderId. Duplicates = same identity twice;
     orphans = a delivery whose order is unknown. */
  function orderConvergence (marketplace, pos, deliveries) {
    marketplace = marketplace || []; pos = pos || []; deliveries = deliveries || [];
    var identity = {}; var dupes = 0;
    function add (o, src) {
      var id = String(o.id || o.orderId || o.canonicalId || '');
      if (!id) return;
      var key = src + ':' + id;             /* an order is one identity per source */
      if (identity[key]) dupes++; else identity[key] = 1;
    }
    marketplace.forEach(function (o) { add(o, 'online'); });
    pos.forEach(function (o) { add(o, 'pos'); });
    var orderIds = {};
    marketplace.forEach(function (o) { orderIds[String(o.id || o.orderId || '')] = 1; });
    pos.forEach(function (o) { orderIds[String(o.id || o.orderId || '')] = 1; });
    var orphans = 0;
    deliveries.forEach(function (d) { var oid = String(d.orderId || d.order || ''); if (oid && !orderIds[oid]) orphans++; });
    return {
      marketplace: marketplace.length, pos: pos.length, deliveries: deliveries.length,
      unified: Object.keys(identity).length, duplicates: dupes, orphans: orphans,
      ok: dupes === 0 && orphans === 0
    };
  }

  /* ── Live reads (auth-gated; wrap the pure logic) ── */
  function _uid () { try { return (root.firebaseAuth && root.firebaseAuth.currentUser && root.firebaseAuth.currentUser.uid) || null; } catch (_) { return null; } }
  async function _fs () { return await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js'); }

  async function status () {
    var uid = _uid();
    var out = { products: null, orders: null, at: null };
    if (!uid || !root.firebaseDB) return out;
    try {
      var m = await _fs();
      var db = root.firebaseDB;
      var canon = (await m.getDocs(m.query(m.collection(db, 'products'), m.where('sellerUid', '==', uid), m.limit(1000)))).docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
      var pos = [];
      try { pos = (await m.getDocs(m.query(m.collection(db, 'posProducts'), m.where('sellerUid', '==', uid), m.limit(1000)))).docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); } catch (_) { pos = []; }
      var inv = [];
      try { inv = (await m.getDocs(m.query(m.collection(db, 'tenants', uid, 'inventory_products'), m.limit(1000)))).docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); } catch (_) { inv = []; }
      out.products = productConvergence(canon, pos, inv);
      /* Orders: reuse OrderService's unified view; report source counts + dupes/orphans. */
      if (root.SokoniOrderService && root.SokoniOrderService.query) {
        var rows = await root.SokoniOrderService.query({ range: 'all', tab: 'all' });
        var mk = rows.filter(function (r) { return r.source !== 'pos'; });
        var pz = rows.filter(function (r) { return r.source === 'pos'; });
        out.orders = orderConvergence(mk, pz, []);
      }
      out.at = null;   /* stamped by caller */
    } catch (_) {}
    return out;
  }

  /* ── Idempotent reconciliation ────────────────────────────────────────────
     Rebuild the POS/inventory CACHES from the canonical products/{id}. Direction is
     one-way (canonical → cache), MERGE-writes only the compared fields, and only for
     rows that are missing or mismatched — so a second run writes nothing. NEVER touches
     products/{id} or any order. Returns {written, alreadyOk}. Auth + Firestore required. */
  async function reconcile () {
    var uid = _uid();
    if (!uid || !root.firebaseDB) throw new Error('Not signed in');
    var m = await _fs();
    var db = root.firebaseDB;
    var canon = (await m.getDocs(m.query(m.collection(db, 'products'), m.where('sellerUid', '==', uid), m.limit(1000)))).docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); });
    var pos = [], inv = [];
    try { pos = (await m.getDocs(m.query(m.collection(db, 'posProducts'), m.where('sellerUid', '==', uid), m.limit(1000)))).docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); } catch (_) {}
    try { inv = (await m.getDocs(m.query(m.collection(db, 'tenants', uid, 'inventory_products'), m.limit(1000)))).docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); }); } catch (_) {}
    var conv = productConvergence(canon, pos, inv);
    var canonById = {}; canon.forEach(function (c) { canonById[c.id] = c; });
    var toFix = {};
    conv._missing.concat(conv._mismatched).forEach(function (x) { toFix[x.id + ':' + x.cache] = x; });
    var written = 0;
    for (var k in toFix) {
      var x = toFix[k], c = canonById[x.id]; if (!c) continue;
      try {
        if (x.cache === 'pos') {
          await m.setDoc(m.doc(db, 'posProducts', c.id),
            { name: c.name, price: _num(c.price), stock: _num(c.stock), sellerUid: uid, sourceProductId: c.id, updatedAt: m.serverTimestamp() }, { merge: true });
        } else {
          await m.setDoc(m.doc(db, 'tenants', uid, 'inventory_products', c.id),
            { name: c.name, sellingPrice: _num(c.price), stockLevel: _num(c.stock), sourceProductId: c.id, tenantId: uid, updatedAt: m.serverTimestamp() }, { merge: true });
        }
        written++;
      } catch (_) {}
    }
    /* Announce so live modules re-read (idempotent recompute). */
    try { if (root.SokoniSync) root.SokoniSync.productChanged({ type: 'RECONCILED', source: 'Reconcile', sellerUid: uid, metadata: { written: written }, timestamp: Date.now() }); } catch (_) {}
    return { written: written, alreadyOk: (conv.missing + conv.mismatched) === 0 };
  }

  /* ── PURE: branch isolation check ─────────────────────────────────────────
     Given records (products / transactions / orders — anything with a branchId) and the
     ACTIVE branch, report how many belong to the active branch, to OTHER branches (=
     leakage if any surface shows them while scoped), and how many are untagged (legacy,
     pending backfill). leakage=true means Shop A would see Shop B's data → a failure. */
  function branchIsolation (records, activeBranch) {
    records = records || [];
    var active = 0, other = 0, untagged = 0, byBranch = {};
    records.forEach(function (r) {
      var b = r.branchId != null ? r.branchId : null;
      if (b == null) { untagged++; return; }
      byBranch[b] = (byBranch[b] || 0) + 1;
      if (activeBranch && b === activeBranch) active++;
      else if (activeBranch) other++;
    });
    return {
      total: records.length, active: active, other: other, untagged: untagged,
      branches: Object.keys(byBranch).length, byBranch: byBranch,
      leakage: activeBranch ? other > 0 : false,
      ok: activeBranch ? other === 0 : true
    };
  }

  root.SokoniReconcile = {
    productConvergence: productConvergence,
    orderConvergence: orderConvergence,
    branchIsolation: branchIsolation,
    status: status,
    reconcile: reconcile
  };
})(typeof window !== 'undefined' ? window : this);
