/* In-memory Firestore for certification suites. Interprets the REAL firebase-admin FieldValue sentinels
 * (serverTimestamp → '<ts>', delete, increment, arrayUnion/Remove), supports doc get/set(merge)/create/update/delete,
 * where('==')/limit/get, batch, runTransaction (sequential), and records every write for "nothing was written"
 * assertions. Not a model of Firestore's concurrency — emulator suites prove that. */
'use strict';
function fakeDb(seed) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  const kind = (v) => (v && typeof v === 'object' && v.constructor && /Transform|FieldValue/.test(v.constructor.name)) ? String(v.methodName || v._methodName || v.constructor.name) : null;
  const apply = (cur, patch, merge) => {
    const out = merge && cur ? Object.assign({}, cur) : {};
    for (const [k, v] of Object.entries(patch)) {
      const m = kind(v);
      if (m && /delete/i.test(m)) { delete out[k]; continue; }
      if (m && /serverTimestamp/i.test(m)) { out[k] = '<ts>'; continue; }
      if (m && /increment/i.test(m)) { const n = Number(v.operand != null ? v.operand : v._operand); out[k] = (typeof out[k] === 'number' ? out[k] : 0) + n; continue; }
      if (m && /arrayUnion/i.test(m)) { const el = v.elements || v._elements || []; out[k] = [...new Set([...(Array.isArray(out[k]) ? out[k] : []), ...el])]; continue; }
      if (m && /arrayRemove/i.test(m)) { const el = v.elements || v._elements || []; out[k] = (Array.isArray(out[k]) ? out[k] : []).filter((x) => !el.includes(x)); continue; }
      /* set(merge:true) deep-merges nested maps, as Firestore does; a plain set replaces them. */
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const prev = merge && out[k] && typeof out[k] === 'object' && !Array.isArray(out[k]) ? out[k] : null;
        out[k] = apply(prev, v, !!prev); continue;
      }
      out[k] = v;
    }
    return out;
  };
  const clone = (d) => JSON.parse(JSON.stringify(d));
  const docRef = (col, id) => ({
    id, parent: { id: col }, path: col + '/' + id,
    get: async () => { const d = store[col] && store[col][id]; return { id, exists: !!d, ref: docRef(col, id), data: () => (d ? clone(d) : undefined) }; },
    set: async (patch, o) => { store[col] = store[col] || {}; store[col][id] = apply(store[col][id], patch, o && o.merge); writes.push({ op: 'set', col, id }); },
    create: async (patch) => { store[col] = store[col] || {}; if (store[col][id]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store[col][id] = apply(null, patch, false); writes.push({ op: 'create', col, id }); },
    update: async (patch) => { if (!(store[col] && store[col][id])) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; } store[col][id] = apply(store[col][id], patch, true); writes.push({ op: 'update', col, id }); },
    delete: async () => { if (store[col]) delete store[col][id]; writes.push({ op: 'delete', col, id }); },
  });
  const query = (col, filters, lim) => ({
    where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim),
    limit: (n) => query(col, filters, n),
    orderBy: () => query(col, filters, lim),
    get: async () => {
      const rows = Object.entries(store[col] || {}).filter(([, d]) => filters.every(([f, , v]) => d[f] === v)).slice(0, lim || 1e9);
      const docs = rows.map(([id, d]) => ({ id, exists: true, ref: docRef(col, id), data: () => clone(d) }));
      return { empty: !docs.length, size: docs.length, docs };
    },
  });
  let auto = 0;
  return {
    _store: store, _writes: writes,
    collection: (col) => Object.assign(query(col, [], 0), { doc: (id) => docRef(col, id || ('auto' + (++auto))), add: async (d) => { const r = docRef(col, 'auto' + (++auto)); await r.set(d); return r; } }),
    batch: () => { const ops = []; return { set: (ref, p, o) => ops.push(() => ref.set(p, o)), update: (ref, p) => ops.push(() => ref.update(p)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, p, o) => r.set(p, o), update: (r, p) => r.update(p), create: (r, p) => r.create(p) }),
  };
}
module.exports = { fakeDb };
