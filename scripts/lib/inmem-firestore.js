'use strict';
/* In-memory Firestore + firebase-admin/auth stubs for executing REAL Cloud Functions handlers in-process (no network).
 * Shared by the Tech Hub server suites (test-tech-service-profile, test-messages-service-booking, test-service-leads).
 *   const H = require('./lib/inmem-firestore').install({ admins: ['admin1'] });   // BEFORE requiring any functions module
 *   H.DOCS (Map path → data), H.db, H.reset()
 * Transactions BUFFER their writes and commit them only when the callback resolves — a throw inside a transaction leaves
 * nothing behind, as in Firestore (needed to prove "a refused conversion writes no booking"). */
const Module = require('module');

function install(opts) {
  const o = opts || {};
  const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
  process.env.NODE_PATH = NM; Module._initPaths();
  const DOCS = new Map();
  const ADMINS = new Set(o.admins || ['admin1']);
  let autoId = 0;
  const DEL = { __delete: true };
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const strip = (v) => JSON.parse(JSON.stringify(v, (key, x) => (x && x.__ts ? x.__ts : x)));
  /* FieldValue sentinels resolved against the current value (top-level fields — enough for these handlers) */
  const resolve = (cur, f, x) => {
    if (x && x.__delete) { delete cur[f]; return; }
    if (x && x.__arrayUnion) { const a = Array.isArray(cur[f]) ? cur[f].slice() : []; x.__arrayUnion.forEach((e) => { if (!a.some((y) => JSON.stringify(y) === JSON.stringify(e))) a.push(e); }); cur[f] = a; return; }
    if (x && x.__arrayRemove) { const a = Array.isArray(cur[f]) ? cur[f] : []; cur[f] = a.filter((y) => !x.__arrayRemove.some((e) => JSON.stringify(e) === JSON.stringify(y))); return; }
    if (x && typeof x.__increment === 'number') { cur[f] = (Number(cur[f]) || 0) + x.__increment; return; }
    cur[f] = x;
  };
  const applyUpdate = (k, v) => {
    if (!DOCS.has(k)) throw new Error('NOT_FOUND ' + k);
    const cur = Object.assign({}, DOCS.get(k));
    for (const [f, x] of Object.entries(v)) resolve(cur, f, x);
    DOCS.set(k, strip(cur));
  };
  const applySet = (k, v, so) => {
    const cur = so && so.merge ? Object.assign({}, DOCS.get(k) || {}) : {};
    for (const [f, x] of Object.entries(v || {})) resolve(cur, f, x);
    DOCS.set(k, strip(cur));
  };
  const snap = (k, id) => ({ exists: DOCS.has(k), id, ref: docRef(k), data: () => (DOCS.has(k) ? clone(DOCS.get(k)) : undefined) });
  function docRef(k) {
    const id = k.split('/').pop();
    return {
      id, path: k,
      get: async () => snap(k, id),
      set: async (v, so) => applySet(k, v, so),
      update: async (v) => applyUpdate(k, v),
      delete: async () => { DOCS.delete(k); },
      collection: (c) => coll(k + '/' + c),
    };
  }
  function coll(c, filters, lim) {
    return {
      doc: (id) => docRef(c + '/' + (id || ('auto' + (++autoId)))),
      add: async (v) => { const r = docRef(c + '/auto' + (++autoId)); applySet(r.path, v); return r; },
      where: (f, op, v) => coll(c, (filters || []).concat([[f, op, v]]), lim),
      orderBy: () => coll(c, filters, lim), limit: (n) => coll(c, filters, n), startAfter: () => coll(c, filters, lim),
      get: async () => {
        const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1)
          .filter((k) => (filters || []).every(([f, op, v]) => { const x = (DOCS.get(k) || {})[f]; return op === 'in' ? v.includes(x) : op === 'array-contains' ? (Array.isArray(x) && x.includes(v)) : x === v; }))
          .slice(0, lim || 1e9).map((k) => snap(k, k.split('/').pop()));
        return { docs, empty: !docs.length, size: docs.length, forEach: (fn) => docs.forEach(fn) };
      },
    };
  }
  const db = {
    collection: (c) => coll(c, [], 0), doc: (p) => docRef(p),
    runTransaction: async (fn) => {
      const ops = [];
      const t = {
        get: (r) => (r && typeof r.get === 'function' ? r.get() : r),
        set: (r, v, so) => { ops.push(() => applySet(r.path, v, so)); return t; },
        update: (r, v) => { ops.push(() => applyUpdate(r.path, v)); return t; },
        create: (r, v) => { ops.push(() => { if (DOCS.has(r.path)) throw new Error('ALREADY_EXISTS ' + r.path); applySet(r.path, v); }); return t; },
        delete: (r) => { ops.push(() => DOCS.delete(r.path)); return t; },
      };
      const out = await fn(t);          /* a throw here discards every buffered write */
      for (const op of ops) op();
      return out;
    },
    batch: () => { const ops = []; return { set: (r, v, so) => ops.push(() => applySet(r.path, v, so)), update: (r, v) => ops.push(() => applyUpdate(r.path, v)), commit: async () => { for (const op of ops) op(); } }; },
  };
  const fsStub = {
    getFirestore: () => db,
    FieldValue: { delete: () => DEL, serverTimestamp: () => ({ __ts: 'TS' }), increment: (n) => ({ __increment: Number(n) || 0 }), arrayUnion: (...a) => ({ __arrayUnion: a }), arrayRemove: (...a) => ({ __arrayRemove: a }) },
    Timestamp: { now: () => ({ __ts: Date.now(), toMillis: () => Date.now() }), fromMillis: (ms) => ({ __ts: ms, toMillis: () => ms }), fromDate: (d) => ({ __ts: +d }) },
  };
  const CLAIMS = new Map();
  const authStub = { getAuth: () => ({
    getUser: async (u) => ({ uid: u, customClaims: Object.assign({}, ADMINS.has(u) ? { admin: true } : {}, CLAIMS.get(u) || {}) }),
    setCustomUserClaims: async (u, c) => { CLAIMS.set(u, Object.assign({}, c || {})); },
  }) };
  const origLoad = Module._load;
  Module._load = function (req) {
    if (req === 'firebase-admin/firestore') return fsStub;
    if (req === 'firebase-admin/auth') return authStub;
    if (req === 'firebase-admin') {
      const real = origLoad.apply(this, arguments);
      const fsNs = Object.assign(() => db, fsStub);
      return new Proxy(real, { get: (t, k) => (k === 'firestore' ? fsNs : k === 'auth' ? authStub.getAuth : t[k]) });
    }
    return origLoad.apply(this, arguments);
  };
  return { DOCS, db, ADMINS, CLAIMS, reset: () => { DOCS.clear(); CLAIMS.clear(); } };
}

/** Run a callable handler as `uid`; returns { ok } or { code, msg, det }. */
async function call(fn, uid, data, token) {
  try { return { ok: await fn({ auth: uid ? { uid, token: token || {} } : null, data }) }; }
  catch (e) { return { code: e.code, msg: e.message, det: e.details }; }
}

module.exports = { install, call };
