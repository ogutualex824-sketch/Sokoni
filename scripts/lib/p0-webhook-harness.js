'use strict';
/* Harness for LAYER B of scripts/test-p0-payment-integrity.js — the REAL webhookIntasend handler in-process.
   firebase-admin is replaced by an in-memory Firestore; IntaSend's status API by a controllable fetch stub. Nothing
   leaves the process. REFUSES to load below 512 MB free (owner's memory floor): loading functions/index.js is heavy,
   and a refused harness is reported UNPROVEN by the caller — never a pass. */
const path = require('path'), os = require('os');
const FLOOR_MB = 512;

module.exports = function harness(WH, NM) {
  const freeMB = Math.round(os.freemem() / 1048576);
  if (freeMB < FLOOR_MB) return { ready: false, error: 'free memory ' + freeMB + ' MB < ' + FLOOR_MB + ' MB floor — not loaded' };

  /* ── in-memory Firestore ── */
  const DOCS = new Map(); let AUTO = 0;
  const SENT = { serverTimestamp: { __ts: 1 } };
  const apply = (prev, d, merge) => {
    const out = Object.assign({}, merge ? (prev || {}) : {});
    for (const [k, v] of Object.entries(d || {})) {
      if (v && v.__op === 'delete') { delete out[k]; continue; }
      if (v && v.__op === 'inc') { out[k] = Number((prev || {})[k] || 0) + v.n; continue; }
      if (v && v.__op === 'union') { out[k] = [...new Set([...(((prev || {})[k]) || []), ...v.a])]; continue; }
      out[k] = v;
    }
    return out;
  };
  const snap = (p, id) => ({ exists: DOCS.has(p), id, data: () => (DOCS.has(p) ? JSON.parse(JSON.stringify(DOCS.get(p))) : undefined), get: (f) => (DOCS.get(p) || {})[f], ref: ref(p.split('/').slice(0, -1).join('/'), id) });
  function ref(c, id) {
    const p = c + '/' + id;
    return { id, path: p, parent: { id: c },
      get: async () => snap(p, id),
      set: async (d, o) => { DOCS.set(p, apply(DOCS.get(p), d, o && o.merge)); },
      update: async (d) => { if (!DOCS.has(p)) throw Object.assign(new Error('NOT_FOUND ' + p), { code: 5 }); DOCS.set(p, apply(DOCS.get(p), d, true)); },
      create: async (d) => { if (DOCS.has(p)) throw Object.assign(new Error('ALREADY_EXISTS ' + p), { code: 6 }); DOCS.set(p, apply(null, d, false)); },
      delete: async () => { DOCS.delete(p); },
      collection: (sub) => coll(p + '/' + sub) };
  }
  function query(c, filters, lim) {
    return { where: (f, op, v) => query(c, filters.concat([[f, op, v]]), lim), orderBy: () => query(c, filters, lim), limit: (n) => query(c, filters, n),
      startAfter: () => query(c, filters, lim), select: () => query(c, filters, lim),
      get: async () => { const docs = [...DOCS.keys()].filter((k) => k.startsWith(c + '/') && k.split('/').length === c.split('/').length + 1)
        .filter((k) => filters.every(([f, op, v]) => { const x = (DOCS.get(k) || {})[f]; return op === '==' ? x === v : op === 'in' ? (v || []).includes(x) : op === '>=' ? x >= v : op === '<=' ? x <= v : true; }))
        .slice(0, lim || 1e9).map((k) => snap(k, k.split('/').pop()));
        return { empty: !docs.length, size: docs.length, docs, forEach: (fn) => docs.forEach(fn) }; },
      count: () => ({ get: async () => ({ data: () => ({ count: 0 }) }) }) };
  }
  function coll(c) { return Object.assign(query(c, [], 0), { id: c.split('/').pop(), doc: (id) => ref(c, id || ('auto' + (++AUTO))), add: async (d) => { const id = 'a' + (++AUTO); DOCS.set(c + '/' + id, apply(null, d)); return ref(c, id); } }); }
  const db = { collection: coll, doc: (p) => { const s = p.split('/'); return ref(s.slice(0, -1).join('/'), s.pop()); },
    collectionGroup: () => query('__none__', [], 0), listCollections: async () => [], getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    runTransaction: async (fn) => { const w = []; const t = { get: (r) => (r.get ? r.get() : r), set: (r, d, o) => { w.push(() => r.set(d, o)); return t; },
      update: (r, d) => { w.push(() => r.update(d)); return t; }, create: (r, d) => { w.push(() => r.create(d)); return t; }, delete: (r) => { w.push(() => r.delete()); return t; } };
      const out = await fn(t); for (const f of w) await f(); return out; },
    batch: () => { const w = []; const b = { set: (r, d, o) => { w.push(() => r.set(d, o)); return b; }, update: (r, d) => { w.push(() => r.update(d)); return b; },
      create: (r, d) => { w.push(() => r.create(d)); return b; }, delete: (r) => { w.push(() => r.delete()); return b; }, commit: async () => { for (const f of w) await f(); } }; return b; },
    settings: () => {} };
  const FieldValue = { serverTimestamp: () => SENT.serverTimestamp, increment: (n) => ({ __op: 'inc', n }), arrayUnion: (...a) => ({ __op: 'union', a }),
    arrayRemove: () => ({ __op: 'noop' }), delete: () => ({ __op: 'delete' }) };
  const Timestamp = { now: () => ({ toMillis: () => Date.now(), toDate: () => new Date() }), fromDate: (d) => ({ toMillis: () => +d, toDate: () => d }), fromMillis: (m) => ({ toMillis: () => m, toDate: () => new Date(m) }) };

  /* ── permissive stub for everything else firebase-admin exposes ── */
  const anyStub = () => new Proxy(function () {}, { get: (t, k) => (k === 'then' ? undefined : anyStub()), apply: () => anyStub() });
  const firestoreFn = Object.assign(() => db, { FieldValue, Timestamp, FieldPath: { documentId: () => '__id__' } });
  const adminStub = new Proxy({ apps: [{}], initializeApp: () => ({}), app: () => ({}), firestore: firestoreFn, credential: anyStub() }, {
    get: (t, k) => (k in t ? t[k] : anyStub()) });
  for (const id of ['firebase-admin']) {
    const p = require.resolve(id, { paths: [WH, NM] });
    require.cache[p] = { id: p, filename: p, loaded: true, exports: adminStub };
  }
  const fsMod = (() => { try { return require.resolve('firebase-admin/firestore', { paths: [WH, NM] }); } catch (_) { return null; } })();
  if (fsMod) require.cache[fsMod] = { id: fsMod, filename: fsMod, loaded: true, exports: { getFirestore: () => db, FieldValue, Timestamp } };

  /* ── IntaSend status stub (the ONLY outbound call the gate makes) ── */
  let STATUS = null; const CALLS = [];
  global.fetch = async (url) => { CALLS.push(String(url)); const body = typeof STATUS === 'function' ? STATUS(String(url)) : STATUS;
    if (body === 'NETWORK') throw new Error('network');
    return { ok: true, status: 200, json: async () => body }; };

  const CHALLENGE = 'p0-harness-challenge';
  process.env.INTASEND_WEBHOOK_CHALLENGE = CHALLENGE; process.env.INTASEND_PRIVATE_KEY = 'p0-harness-key';
  process.env.FUNCTIONS_EMULATOR = 'true'; process.env.GCLOUD_PROJECT = process.env.GCLOUD_PROJECT || 'demo-p0';
  const quiet = () => { const o = {}; ['log', 'info', 'warn', 'error', 'debug'].forEach((k) => { o[k] = console[k]; console[k] = () => {}; }); const w = process.stdout.write; process.stdout.write = () => true; return () => { Object.assign(console, o); process.stdout.write = w; }; };
  let mod, err = null; const restore = quiet();
  try { mod = require(path.join(WH, 'index.js')); } catch (e) { err = e; } finally { restore(); }
  if (err || !mod || typeof mod.webhookIntasend !== 'function') return { ready: false, error: 'index.js did not load: ' + (err ? err.message : 'no webhookIntasend') };

  const invoke = async (body) => {
    const res = { code: null, body: null, status(c) { this.code = c; return this; }, send(b) { this.body = b; return this; }, json(b) { this.body = b; return this; }, set() { return this; }, end() { return this; } };
    const req = { method: 'POST', body, headers: {}, get: () => undefined, rawBody: Buffer.from(JSON.stringify(body || {})) };
    const r2 = quiet(); let threw = null;
    try { await mod.webhookIntasend(req, res); } catch (e) { threw = e; } finally { r2(); }
    return { code: res.code, body: res.body, threw: threw ? String(threw.message || threw) : null };
  };
  return { ready: true, DOCS, db, CHALLENGE, invoke, setStatus: (s) => { STATUS = s; }, CALLS,
    get: (c, id) => (DOCS.has(c + '/' + id) ? DOCS.get(c + '/' + id) : null),
    count: (c) => [...DOCS.keys()].filter((k) => k.startsWith(c + '/')).length };
};
