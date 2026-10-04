/* In-memory Firestore for certification suites. Interprets the REAL firebase-admin FieldValue sentinels
 * (serverTimestamp → '<ts>', delete, increment, arrayUnion/Remove), supports doc get/set(merge)/create/update/delete,
 * where('==')/limit/get, batch, runTransaction (sequential), and records every write for "nothing was written"
 * assertions. Not a model of Firestore's concurrency — emulator suites prove that.
 *
 * 2026-10-04 additions (backward compatible — the original surface behaves exactly as before):
 *   where ops  == != < <= > >= in   (missing field never matches; == null matches only a stored null)
 *   orderBy(field|documentId, 'asc'|'desc')  — docs WITHOUT the field are excluded, as in Firestore
 *   startAfter(docSnapshot)  — cursor over the orderBy fields (+ document id)
 *   count().get() / aggregate({ k: AggregateField.count()|sum(f)|average(f) }).get()
 *   opts.fail(desc) → falsy | gRPC code (number)  — failure injection per query; desc = { col, filters, orders, kind }
 *   Timestamps: seed a field as { __ts: <millis> }; data() returns it with toDate()/toMillis().
 *   FAKE_FIELD_VALUE / FAKE_AGGREGATE_FIELD / FAKE_FIELD_PATH — stand-ins when the real SDK is not loadable. */
'use strict';
const DOC_ID = { __docId: true };
class FakeFieldValueTransform { constructor(methodName, extra) { this.methodName = methodName; Object.assign(this, extra || {}); } }
const FAKE_FIELD_VALUE = {
  serverTimestamp: () => new FakeFieldValueTransform('FieldValue.serverTimestamp'),
  delete: () => new FakeFieldValueTransform('FieldValue.delete'),
  increment: (n) => new FakeFieldValueTransform('FieldValue.increment', { operand: n }),
  arrayUnion: (...el) => new FakeFieldValueTransform('FieldValue.arrayUnion', { elements: el }),
  arrayRemove: (...el) => new FakeFieldValueTransform('FieldValue.arrayRemove', { elements: el }),
};
const FAKE_AGGREGATE_FIELD = { count: () => ({ t: 'count' }), sum: (f) => ({ t: 'sum', f }), average: (f) => ({ t: 'avg', f }) };
const FAKE_FIELD_PATH = { documentId: () => DOC_ID };

function fakeDb(seed, opts) {
  const store = JSON.parse(JSON.stringify(seed || {}));
  const writes = [];
  const reads = [];
  const fail = (opts && opts.fail) || (() => 0);
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
  const revive = (v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.__ts === 'number') { const ms = v.__ts; return { __ts: ms, toDate: () => new Date(ms), toMillis: () => ms }; }
      const o = {}; for (const [k, x] of Object.entries(v)) o[k] = revive(x); return o;
    }
    return Array.isArray(v) ? v.map(revive) : v;
  };
  const clone = (d) => revive(JSON.parse(JSON.stringify(d)));
  const docRef = (col, id) => ({
    id, parent: { id: col }, path: col + '/' + id,
    get: async () => { reads.push({ op: 'doc', col, id }); const d = store[col] && store[col][id]; return { id, exists: !!d, ref: docRef(col, id), _raw: d, data: () => (d ? clone(d) : undefined) }; },
    set: async (patch, o) => { store[col] = store[col] || {}; store[col][id] = apply(store[col][id], patch, o && o.merge); writes.push({ op: 'set', col, id }); },
    create: async (patch) => { store[col] = store[col] || {}; if (store[col][id]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } store[col][id] = apply(null, patch, false); writes.push({ op: 'create', col, id }); },
    update: async (patch) => { if (!(store[col] && store[col][id])) { const e = new Error('NOT_FOUND'); e.code = 5; throw e; } store[col][id] = apply(store[col][id], patch, true); writes.push({ op: 'update', col, id }); },
    delete: async () => { if (store[col]) delete store[col][id]; writes.push({ op: 'delete', col, id }); },
  });
  /* Firestore cross-type ordering: null < boolean < number < timestamp < string < other */
  const rank = (v) => v === null ? 0 : typeof v === 'boolean' ? 1 : typeof v === 'number' ? 2 : (v && typeof v === 'object' && typeof v.__ts === 'number') ? 3 : typeof v === 'string' ? 4 : 5;
  const cmp = (a, b) => {
    const ra = rank(a), rb = rank(b);
    if (ra !== rb) return ra - rb;
    const va = ra === 3 ? a.__ts : a, vb = rb === 3 ? b.__ts : b;
    return va < vb ? -1 : va > vb ? 1 : 0;
  };
  const eq = (a, b) => rank(a) === rank(b) && cmp(a, b) === 0;
  const fieldOf = (id, d, f) => (f === DOC_ID ? id : d[f]);
  const test = (id, d, [f, op, v]) => {
    const x = fieldOf(id, d, f);
    if (x === undefined) return false;
    switch (op) {
      case '==': return eq(x, v);
      case '!=': return x !== null && !eq(x, v);
      case 'in': return Array.isArray(v) && v.some((y) => eq(x, y));
      case '<': return rank(x) === rank(v) && cmp(x, v) < 0;
      case '<=': return rank(x) === rank(v) && cmp(x, v) <= 0;
      case '>': return rank(x) === rank(v) && cmp(x, v) > 0;
      case '>=': return rank(x) === rank(v) && cmp(x, v) >= 0;
      default: throw new Error('fake-firestore: unsupported op ' + op);
    }
  };
  const maybeFail = (desc) => {
    const code = fail(desc);
    if (code) { const e = new Error('injected failure (' + code + ')'); e.code = code; throw e; }
  };
  const query = (col, filters, lim, orders, after) => {
    orders = orders || []; after = after || null;
    const desc = (k) => ({ col, filters, orders: orders.map(([f, dir]) => [f === DOC_ID ? '__name__' : f, dir]), kind: k });
    const rows = () => {
      let r = Object.entries(store[col] || {}).filter(([id, d]) => filters.every((flt) => test(id, d, flt)));
      for (const [f, op] of filters) if (op !== '==' && op !== 'in' && f !== DOC_ID && !orders.some(([o]) => o === f)) r = r.filter(([id, d]) => fieldOf(id, d, f) !== undefined);
      r = r.filter(([id, d]) => orders.every(([f]) => fieldOf(id, d, f) !== undefined));
      if (orders.length) {
        const full = orders.some(([f]) => f === DOC_ID) ? orders : orders.concat([[DOC_ID, orders[orders.length - 1][1]]]);
        const sortCmp = (a, b) => { for (const [f, dir] of full) { const c = cmp(fieldOf(a[0], a[1], f), fieldOf(b[0], b[1], f)); if (c) return dir === 'desc' ? -c : c; } return 0; };
        r.sort(sortCmp);
        if (after) {
          const key = [after.id, after._raw];
          r = r.filter((row) => sortCmp(row, key) > 0);
        }
      } else r.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      return r;
    };
    return {
      where: (f, op, v) => query(col, filters.concat([[f, op, v]]), lim, orders, after),
      limit: (n) => query(col, filters, n, orders, after),
      orderBy: (f, dir) => query(col, filters, lim, orders.concat([[f, dir === 'desc' ? 'desc' : 'asc']]), after),
      startAfter: (snap) => {
        if (!snap || !snap._raw) throw new Error('fake-firestore: startAfter needs an existing document snapshot');
        for (const [f] of orders) if (fieldOf(snap.id, snap._raw, f) === undefined) throw new Error('fake-firestore: cursor document lacks ' + String(f));
        return query(col, filters, lim, orders, snap);
      },
      get: async () => {
        maybeFail(desc('get'));
        reads.push({ op: 'query', col, filters, orders });
        const r = rows().slice(0, lim || 1e9);
        const docs = r.map(([id, d]) => ({ id, exists: true, ref: docRef(col, id), _raw: d, data: () => clone(d) }));
        return { empty: !docs.length, size: docs.length, docs };
      },
      count: () => ({ get: async () => { maybeFail(desc('count')); reads.push({ op: 'count', col, filters }); const n = rows().slice(0, lim || 1e9).length; return { data: () => ({ count: n }) }; } }),
      aggregate: (spec) => ({ get: async () => {
        maybeFail(desc('aggregate'));
        reads.push({ op: 'aggregate', col, filters });
        const r = rows().slice(0, lim || 1e9);
        const out = {};
        for (const [k, a] of Object.entries(spec)) {
          if (a.t === 'count') { out[k] = r.length; continue; }
          const nums = r.map(([, d]) => d[a.f]).filter((x) => typeof x === 'number' && Number.isFinite(x));
          const s = nums.reduce((p, x) => p + x, 0);
          out[k] = a.t === 'sum' ? s : (nums.length ? s / nums.length : null);
        }
        return { data: () => out };
      } }),
    };
  };
  let auto = 0;
  return {
    _store: store, _writes: writes, _reads: reads,
    collection: (col) => Object.assign(query(col, [], 0), { doc: (id) => docRef(col, id || ('auto' + (++auto))), add: async (d) => { const r = docRef(col, 'auto' + (++auto)); await r.set(d); return r; } }),
    batch: () => { const ops = []; return { set: (ref, p, o) => ops.push(() => ref.set(p, o)), update: (ref, p) => ops.push(() => ref.update(p)), commit: async () => { for (const op of ops) await op(); } }; },
    runTransaction: async (fn) => fn({ get: (r) => r.get(), set: (r, p, o) => r.set(p, o), update: (r, p) => r.update(p), create: (r, p) => r.create(p) }),
  };
}
module.exports = { fakeDb, FAKE_FIELD_VALUE, FAKE_AGGREGATE_FIELD, FAKE_FIELD_PATH, FakeFieldValueTransform };
