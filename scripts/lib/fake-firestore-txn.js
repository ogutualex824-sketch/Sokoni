/* fake-firestore-txn.js — an in-memory Firestore for money-path suites.
 *
 * Why not the one-line stub the older suites use: those apply a transaction's
 * writes AS THEY HAPPEN and never retry, so two concurrent "read-missing →
 * create" transactions both succeed and a double-credit looks impossible when
 * it is not. This fake models the property that matters:
 *
 *   - writes inside runTransaction are BUFFERED and applied atomically at commit
 *   - create() fails at commit if the doc exists → the WHOLE transaction aborts
 *     (error code 6 / ALREADY_EXISTS), none of its writes land
 *   - a doc read in the transaction that changed before commit → the callback
 *     is RE-RUN (optimistic retry, up to 5), as the real client retries
 *   - FieldValue.serverTimestamp / increment / arrayUnion, dotted update paths
 *   - queries: where(==, in, array-contains) · orderBy · limit · startAfter
 *
 * It is still a fake. It proves the CODE's claim discipline; it does not prove
 * Firestore's (docs/CREATOR_HUB.md "UNPROVEN").
 */
'use strict';

function makeFakeFirestore(opts = {}) {
  let clock = opts.clock || (() => Date.now());
  const store = new Map();        // path -> { data, v }
  let seq = 0;

  const SENT = { TS: Symbol('ts'), INC: Symbol('inc'), UNION: Symbol('union'), DEL: Symbol('del') };
  const Timestamp = {
    fromMillis: (m) => ({ _ms: m, toMillis() { return this._ms; }, toDate() { return new Date(this._ms); } }),
    fromDate: (d) => Timestamp.fromMillis(d.getTime()),
    now: () => Timestamp.fromMillis(clock()),
  };
  const FieldValue = {
    serverTimestamp: () => ({ [SENT.TS]: true }),
    increment: (n) => ({ [SENT.INC]: n }),
    arrayUnion: (...v) => ({ [SENT.UNION]: v }),
    delete: () => ({ [SENT.DEL]: true }),
  };

  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, (k, x) => (x && x._ms !== undefined ? { __ts: x._ms } : x))));
  const revive = (v) => {
    if (Array.isArray(v)) return v.map(revive);
    if (v && typeof v === 'object') {
      if (v.__ts !== undefined) return Timestamp.fromMillis(v.__ts);
      const o = {}; for (const k of Object.keys(v)) o[k] = revive(v[k]); return o;
    }
    return v;
  };
  function resolve(prev, val) {
    if (val && typeof val === 'object' && !Array.isArray(val)) {
      if (val[SENT.TS]) return Timestamp.fromMillis(clock());
      if (val[SENT.INC] !== undefined) return (Number(prev) || 0) + val[SENT.INC];
      if (val[SENT.UNION]) return [...(Array.isArray(prev) ? prev : []), ...val[SENT.UNION]];
      if (val._ms !== undefined) return val;
      const o = {}; for (const k of Object.keys(val)) o[k] = resolve(prev && prev[k], val[k]); return o;
    }
    return val;
  }
  function mergeDeep(base, patch) {
    const out = { ...(base || {}) };
    for (const k of Object.keys(patch)) {
      const pv = patch[k];
      if (pv && typeof pv === 'object' && pv[SENT.DEL]) { delete out[k]; continue; }
      if (pv && typeof pv === 'object' && !Array.isArray(pv) && !pv[SENT.TS] && pv[SENT.INC] === undefined && !pv[SENT.UNION] && pv._ms === undefined) {
        out[k] = mergeDeep(out[k], pv);
      } else out[k] = resolve(out[k], pv);
    }
    return out;
  }
  function applyUpdate(base, patch) {
    const out = JSON.parse(JSON.stringify(base || {}));
    const live = revive(out);
    for (const key of Object.keys(patch)) {
      const parts = key.split('.');
      let o = live;
      for (let i = 0; i < parts.length - 1; i++) { o[parts[i]] = o[parts[i]] && typeof o[parts[i]] === 'object' ? o[parts[i]] : {}; o = o[parts[i]]; }
      const last = parts[parts.length - 1];
      const pv = patch[key];
      if (pv && typeof pv === 'object' && pv[SENT.DEL]) delete o[last];
      else o[last] = resolve(o[last], pv);
    }
    return live;
  }

  const get = (path) => store.get(path);
  const put = (path, data) => { const cur = store.get(path); store.set(path, { data: clone(data), v: (cur ? cur.v : 0) + 1 }); };
  const snap = (path) => {
    const e = store.get(path);
    const id = path.split('/').pop();
    return { id, exists: !!e, ref: docRef(path), data: () => (e ? revive(clone(e.data)) : undefined), get: (f) => (e ? revive(clone(e.data))[f] : undefined), _v: e ? e.v : 0, _path: path };
  };
  function err(code, msg) { const e = new Error(msg); e.code = code; return e; }

  function write(op, path, data, o) {
    const cur = get(path);
    if (op === 'create') { if (cur) throw err(6, `ALREADY_EXISTS: ${path}`); put(path, resolve(undefined, data)); }
    else if (op === 'set') put(path, o && o.merge ? mergeDeep(cur ? revive(clone(cur.data)) : {}, data) : mergeDeep({}, data));
    else if (op === 'update') { if (!cur) throw err(5, `NOT_FOUND: ${path}`); put(path, applyUpdate(cur.data, data)); }
    else if (op === 'delete') store.delete(path);
  }

  function docRef(path) {
    return {
      id: path.split('/').pop(), path, _path: path,
      collection: (c) => collRef(path + '/' + c),
      get: async () => snap(path),
      set: async (d, o) => write('set', path, d, o),
      update: async (d) => write('update', path, d),
      create: async (d) => write('create', path, d),
      delete: async () => write('delete', path),
    };
  }

  function collRef(cpath, q = { where: [], order: [], limit: null, after: null }) {
    const depth = cpath.split('/').length + 1;
    const api = {
      _q: true, path: cpath,
      doc: (id) => docRef(cpath + '/' + (id || ('auto' + (++seq) + Math.random().toString(36).slice(2, 8)))),
      add: async (d) => { const r = api.doc(); await r.set(d); return r; },
      where: (f, op, v) => collRef(cpath, { ...q, where: [...q.where, [f, op, v]] }),
      orderBy: (f, dir = 'asc') => collRef(cpath, { ...q, order: [...q.order, [f, dir]] }),
      limit: (n) => collRef(cpath, { ...q, limit: n }),
      startAfter: (s) => collRef(cpath, { ...q, after: s }),
      get: async () => runQuery(cpath, depth, q),
    };
    return api;
  }
  const val = (d, f) => f.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
  const cmpv = (a, b) => { const A = a && a._ms !== undefined ? a._ms : a; const B = b && b._ms !== undefined ? b._ms : b; return A < B ? -1 : A > B ? 1 : 0; };
  function runQuery(cpath, depth, q) {
    let rows = [...store.keys()].filter((p) => p.startsWith(cpath + '/') && p.split('/').length === depth).map(snap);
    for (const [f, op, v] of q.where) {
      rows = rows.filter((s) => {
        const x = val(s.data(), f);
        if (op === '==') return JSON.stringify(x) === JSON.stringify(v);
        if (op === 'in') return v.some((y) => JSON.stringify(y) === JSON.stringify(x));
        if (op === 'array-contains') return Array.isArray(x) && x.includes(v);
        throw new Error('fake: unsupported op ' + op);
      });
    }
    for (const [f, dir] of [...q.order].reverse()) rows.sort((a, b) => (dir === 'desc' ? -1 : 1) * cmpv(val(a.data(), f), val(b.data(), f)));
    if (q.after) { const i = rows.findIndex((r) => r._path === q.after._path); rows = rows.slice(i + 1); }
    if (q.limit != null) rows = rows.slice(0, q.limit);
    return { docs: rows, empty: rows.length === 0, size: rows.length, forEach: (fn) => rows.forEach(fn) };
  }

  async function runTransaction(fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const reads = new Map(); const writes = [];
      const txn = {
        get: async (r) => {
          if (r._q) { const res = await r.get(); res.docs.forEach((d) => reads.set(d._path, d._v)); return res; }
          const s = snap(r._path); reads.set(r._path, s._v); return s;
        },
        getAll: async (...rs) => Promise.all(rs.map((r) => txn.get(r))),
        create: (r, d) => { writes.push(['create', r._path, d]); return txn; },
        set: (r, d, o) => { writes.push(['set', r._path, d, o]); return txn; },
        update: (r, d) => { writes.push(['update', r._path, d]); return txn; },
        delete: (r) => { writes.push(['delete', r._path]); return txn; },
      };
      const out = await fn(txn);
      /* yield so concurrent transactions genuinely interleave before commit */
      await new Promise((res) => setImmediate(res));
      const conflict = [...reads].some(([p, v]) => { const e = store.get(p); return (e ? e.v : 0) !== v; });
      if (conflict) continue;
      /* atomic commit: validate every create first, then apply */
      for (const [op, p] of writes) if (op === 'create' && store.has(p)) throw err(6, `ALREADY_EXISTS: ${p}`);
      const backup = new Map(store);
      try { for (const [op, p, d, o] of writes) write(op, p, d, o); }
      catch (e) { store.clear(); for (const [k, v] of backup) store.set(k, v); throw e; }
      return out;
    }
    throw err(10, 'ABORTED: too much contention');
  }

  function batch() {
    const ops = [];
    return {
      set: (r, d, o) => ops.push(['set', r._path, d, o]),
      update: (r, d) => ops.push(['update', r._path, d]),
      create: (r, d) => ops.push(['create', r._path, d]),
      delete: (r) => ops.push(['delete', r._path]),
      commit: async () => { for (const [op, p, d, o] of ops) write(op, p, d, o); },
    };
  }

  const db = { collection: (c) => collRef(c), doc: (p) => docRef(p), runTransaction, batch, _store: store,
    _dump: (prefix) => [...store.keys()].filter((k) => k.startsWith(prefix)).map((k) => ({ path: k, ...revive(clone(store.get(k).data)) })),
    _setClock: (fn) => { clock = fn; } };
  return { db, FieldValue, Timestamp, FieldPath: { documentId: () => '__name__' } };
}

module.exports = { makeFakeFirestore };
