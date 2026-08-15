'use strict';
/* ─────────────────────────────────────────────────────────────────────────────
   Regression — the POS terminal has exactly ONE canonical inventory writer.

   Step 1B retired PosOmni.pushStock (an ABSOLUTE local stock level written straight
   onto canonical products/{id}) in favour of the single transactional delta writer
   window._posSyncCanonicalStock. This suite proves both halves:

     PART A  the retired writer is gone and cannot come back unnoticed
     PART B  the surviving writer satisfies the Step 1B regression matrix

   Method follows scripts/test-admin-bulk-payout.js: the function under test is lifted
   VERBATIM from pos.js by brace matching and executed against a mock Firestore, so the
   assertions run the shipped source rather than a re-implementation of it.

   ONE declared substitution is made to the lifted source — the `await import(<gstatic
   firebase-firestore URL>)` is redirected to the mock, because Node cannot import an
   https: specifier. The substitution is asserted to occur exactly once, so a change to
   that import line fails this suite instead of silently voiding it.
   ───────────────────────────────────────────────────────────────────────────── */
const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const posJs      = fs.readFileSync(path.join(ROOT, 'pos.js'), 'utf8');
const posOmniJs  = fs.readFileSync(path.join(ROOT, 'pos-omni.js'), 'utf8');
const posModsJs  = fs.readFileSync(path.join(ROOT, 'pos-modules.js'), 'utf8');
const posDbJs    = fs.readFileSync(path.join(ROOT, 'pos-db.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else      { fail++; console.log('  ✗ ' + name + (detail ? '  — ' + detail : '')); }
}

/* Extract `<prefix> ... { ... }` verbatim via brace matching from the marker onward. */
function extractBlock(src, marker) {
  const start = src.indexOf(marker);
  if (start < 0) throw new Error('marker not found: ' + marker);
  const open = src.indexOf('{', start);
  let depth = 0, i = open, inS = null, inC = null;
  for (; i < src.length; i++) {
    const c = src[i], n = src[i + 1], p = src[i - 1];
    if (inC) { if (inC === '//' && c === '\n') inC = null; else if (inC === '/*' && c === '*' && n === '/') { inC = null; i++; } continue; }
    if (inS) { if (c === '\\') { i++; continue; } if (c === inS) inS = null; continue; }
    if (c === '/' && n === '/') { inC = '//'; i++; continue; }
    if (c === '/' && n === '*') { inC = '/*'; i++; continue; }
    if (c === '"' || c === "'" || c === '`') { inS = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    void p;
  }
  throw new Error('unbalanced braces after: ' + marker);
}

/* ═══════════════════════════════════════════════════════════════════════════
   PART A — the retired absolute writer is gone
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART A — retired writer removed');

/* Comments legitimately name pushStock (they explain why it must not return). Only a
   real declaration or call site counts as a live reference. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}
const liveOmni = stripComments(posOmniJs);
const liveMods = stripComments(posModsJs);
const livePos  = stripComments(posJs);

ok('pos-omni.js declares no pushStock',        !/function\s+pushStock/.test(liveOmni));
ok('pos-modules.js declares no pushStock',     !/function\s+pushStock/.test(liveMods));
ok('pos-omni.js exports no pushStock',         !/\bpushStock\s*,/.test(liveOmni));
ok('pos-modules.js returns no pushStock',      !/return\s*\{[^}]*pushStock/.test(liveMods));
ok('the absolute offline push queue is gone',  !/_pendingPushIds|_queuePush|_flushPendingPushes/.test(liveOmni));
ok('pos.js calls no PosOmni.pushStock',        !/PosOmni\s*\.\s*pushStock/.test(livePos));
ok('no absolute stock write survives in pos-omni.js',
   !/updateDoc\s*\([^)]*\)\s*,\s*\{[^}]*stock\s*:/.test(liveOmni) && !/stock\s*:\s*product\.stock/.test(liveOmni));
ok('no absolute stock write survives in pos-modules.js',
   !/stock\s*:\s*product\.stock/.test(liveMods));

/* The single-writer claim is only true if adjustStock is still the funnel. */
ok('adjustStock still routes to _posSyncCanonicalStock',
   /window\._posSyncCanonicalStock\s*\(\s*id\s*,\s*delta\s*,\s*reason\s*\)/.test(posDbJs));

/* NEGATIVE CONTROL — a grep that matches nothing proves nothing. Replay the retired code
   verbatim through the same predicates: every one of them must FIRE. Without this, the
   assertions above would still be green if pushStock came back under another shape. */
const RETIRED_OMNI = `
  async function pushStock(posProductId) {
    const product = await PosDB.products.getById(posProductId);
    if (!product?.marketplaceId) return;
    await fs.updateDoc(fs.doc(db, 'products', product.marketplaceId), {
      stock: product.stock ?? 0, updatedAt: fs.serverTimestamp(),
    });
  }
  const _pendingPushIds = new Set();
  function _queuePush(id) { _pendingPushIds.add(id); }
  async function _flushPendingPushes() { for (const id of _pendingPushIds) await pushStock(id); }
  window.PosOmni = { startSync, stopSync, pushStock, pullOrders, getStatus };
`;
const RETIRED_MODS = `
  async function pushStock(productId) {
    const product = await PosDB.products.get(productId);
    await updateDoc(doc(db, 'products', product.marketplaceId), { stock: product.stock });
  }
  return { startSync, stopSync, pushStock };
`;
const RETIRED_POS = `
      if (window.PosOmni) {
        for (const item of txn.items) {
          if (item.marketplaceId) PosOmni.pushStock(item.id).catch(() => {});
        }
      }
`;
ok('NC: declaration detector fires on the retired pos-omni source',   /function\s+pushStock/.test(RETIRED_OMNI));
ok('NC: declaration detector fires on the retired pos-modules source', /function\s+pushStock/.test(RETIRED_MODS));
ok('NC: export detector fires on the retired export list',             /\bpushStock\s*,/.test(RETIRED_OMNI));
ok('NC: return detector fires on the retired return',                  /return\s*\{[^}]*pushStock/.test(RETIRED_MODS));
ok('NC: queue detector fires on the retired offline queue',
   /_pendingPushIds|_queuePush|_flushPendingPushes/.test(RETIRED_OMNI));
ok('NC: call-site detector fires on the retired pos.js loop',          /PosOmni\s*\.\s*pushStock/.test(RETIRED_POS));
ok('NC: absolute-write detector fires on the retired pos-modules write',
   /stock\s*:\s*product\.stock/.test(RETIRED_MODS));

/* ═══════════════════════════════════════════════════════════════════════════
   PART B — the surviving writer, lifted verbatim and executed
   ═══════════════════════════════════════════════════════════════════════════ */
console.log('\nPART B — _posSyncCanonicalStock regression matrix');

const outcomeSrc = extractBlock(posJs, 'function _posCanonicalOutcome');
const writerSrc  = extractBlock(posJs, 'window._posSyncCanonicalStock = async function');

const IMPORT_RE = /await import\('https:\/\/www\.gstatic\.com\/firebasejs\/[\d.]+\/firebase-firestore\.js'\)/g;
const importHits = (writerSrc.match(IMPORT_RE) || []).length;
ok('lifted source contains exactly one gstatic firestore import (substitution is valid)', importHits === 1,
   'found ' + importHits);
const runnableSrc = writerSrc.replace(IMPORT_RE, 'await __mockFirestore()');

/* ── Mock Firestore ─────────────────────────────────────────────────────── */
const INCREMENT = Symbol('increment');
const SERVER_TS = Symbol('serverTimestamp');

function makeFirestore(store, opts = {}) {
  return {
    doc: (_db, _col, id) => ({ id: String(id) }),
    increment: (n) => ({ [INCREMENT]: n }),
    serverTimestamp: () => ({ [SERVER_TS]: true }),
    runTransaction: async (_db, fn) => {
      const writes = [];
      const tx = {
        get: async (ref) => {
          if (opts.failOnRead === ref.id) throw new Error('backend unavailable');
          const d = store[ref.id];
          return { exists: () => !!d, data: () => (d ? { ...d } : undefined) };
        },
        update: (ref, patch) => {
          if (opts.denyOnWrite === ref.id) {
            const e = new Error('Missing or insufficient permissions.'); e.code = 'permission-denied'; throw e;
          }
          /* Same denial, but surfaced only in the message — some SDK paths carry no code. */
          if (opts.denyOnWriteNoCode === ref.id) throw new Error('Missing or insufficient permissions.');
          writes.push([ref, patch]);
        },
      };
      const out = await fn(tx);
      /* Commit — resolve sentinels against the CURRENT value, as the server would. */
      for (const [ref, patch] of writes) {
        const cur = store[ref.id] || {};
        for (const [k, v] of Object.entries(patch)) {
          if (v && typeof v === 'object' && INCREMENT in v)      cur[k] = Number(cur[k] || 0) + v[INCREMENT];
          else if (v && typeof v === 'object' && SERVER_TS in v) cur[k] = 'SERVER_TS';
          else                                                   cur[k] = v;
        }
        store[ref.id] = cur;
        opts.onCommit && opts.onCommit(ref.id, cur);
      }
      return out;
    },
  };
}

/* ── Harness ────────────────────────────────────────────────────────────── */
function buildWriter({ store, local = {}, online = true, fsOpts = {}, dbPresent = true }) {
  const events = [], errors = [], metrics = [], toasts = [], logs = [];
  const win = {
    firebaseDB: dbPresent ? {} : null,
    PosHealth: {
      recordError:  (t, m, c) => errors.push({ type: t, message: m, ctx: c }),
      recordMetric: (n, v)    => metrics.push({ name: n, value: v }),
    },
    dispatchEvent: (e) => events.push(e.detail),
  };
  const sandbox = {
    window: win,
    /* In the browser `window.PosHealth` is also reachable as the bare global `PosHealth`,
       which is how the shipped source refers to it. Bind the same object, not a copy. */
    PosHealth: win.PosHealth,
    navigator: { onLine: online },
    PosDB: { products: { get: async (id) => local[id] || null } },
    toast: (msg, type) => toasts.push({ msg, type }),
    console: { error: (...a) => logs.push(a.join(' ')) },
    CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init && init.detail; } },
    Date,
    Number, Math, String, Object, Boolean,
    __mockFirestore: async () => makeFirestore(store, fsOpts),
  };
  const keys = Object.keys(sandbox);
  // eslint-disable-next-line no-new-func
  new Function(...keys, `'use strict'; let _canonDenyToastAt = 0;\n${outcomeSrc}\n${runnableSrc}`)
    (...keys.map(k => sandbox[k]));
  return { call: win._posSyncCanonicalStock, events, errors, metrics, toasts, logs, win };
}

const P = 'prod_1';
async function scenario(name, { start, ops, expect, local, online, fsOpts, dbPresent }) {
  const store = start === null ? {} : { [P]: { ...start } };
  const h = buildWriter({ store, local: local || {}, online, fsOpts, dbPresent });
  const statuses = [];
  for (const [delta, reason] of ops) statuses.push(await h.call(P, delta, reason));
  const doc = store[P];
  const got = { stock: doc ? doc.stock : undefined, sold: doc ? doc.sold : undefined,
                inventoryVersion: doc ? doc.inventoryVersion : undefined, status: statuses };
  const problems = [];
  for (const [k, v] of Object.entries(expect)) {
    const actual = k === 'status' ? got.status.join(',') : got[k];
    const want   = k === 'status' ? [].concat(v).join(',') : v;
    if (String(actual) !== String(want)) problems.push(`${k}: expected ${want}, got ${actual}`);
  }
  ok(name, problems.length === 0, problems.join(' | '));
  return h;
}

(async () => {
  /* — the matrix — */
  await scenario('sale qty 1 → stock −1, sold +1',
    { start: { stock: 10, sold: 4 }, ops: [[-1, 'sale:t1']],
      expect: { stock: 9, sold: 5, inventoryVersion: 1, status: 'synced' } });

  await scenario('sale qty 3 → stock −3, sold +3 in ONE transaction',
    { start: { stock: 10, sold: 0 }, ops: [[-3, 'sale:t2']],
      expect: { stock: 7, sold: 3, inventoryVersion: 1, status: 'synced' } });

  await scenario('multi-line on one product → exact aggregate delta',
    { start: { stock: 10, sold: 0 }, ops: [[-2, 'sale:t3'], [-4, 'sale:t3']],
      expect: { stock: 4, sold: 6, inventoryVersion: 2, status: 'synced,synced' } });

  await scenario('refund → stock +qty, sold reversed',
    { start: { stock: 7, sold: 3 }, ops: [[3, 'refund:t2']],
      expect: { stock: 10, sold: 0, status: 'synced' } });

  await scenario('void → stock +qty, sold reversed',
    { start: { stock: 7, sold: 3 }, ops: [[3, 'void:t2']],
      expect: { stock: 10, sold: 0, status: 'synced' } });

  await scenario('receive (purchase_order) → stock +qty, sold UNCHANGED',
    { start: { stock: 2, sold: 9 }, ops: [[5, 'purchase_order:po1']],
      expect: { stock: 7, sold: 9, status: 'synced' } });

  await scenario('rollback → original delta reversed',
    { start: { stock: 10, sold: 0 }, ops: [[-3, 'sale:t4'], [3, 'rollback:t4']],
      expect: { stock: 10, sold: 0, status: 'synced,synced' } });

  await scenario('stock 0 stays 0',
    { start: { stock: 0, sold: 0 }, ops: [[-1, 'sale:t5']],
      expect: { stock: 0, sold: 1, status: 'synced' } });

  await scenario('stock 2, sale qty 5 → floors at 0 (oversell contract preserved)',
    { start: { stock: 2, sold: 0 }, ops: [[-5, 'sale:t6']],
      expect: { stock: 0, sold: 5, status: 'synced' } });

  await scenario('sold never goes negative',
    { start: { stock: 0, sold: 1 }, ops: [[5, 'refund:t7']],
      expect: { stock: 5, sold: 0, status: 'synced' } });

  /* Concurrency: the whole point of Step 1B. A marketplace sale lands between the POS
     read and the POS write; a DELTA writer must preserve it, an ABSOLUTE one erased it. */
  {
    const store = { [P]: { stock: 10, sold: 0 } };
    const h = buildWriter({ store });
    store[P].stock = 7; store[P].sold = 3;           // marketplace deducted 3 first
    await h.call(P, -1, 'sale:t8');                  // POS then sells 1
    ok('concurrent marketplace sale is NOT erased (stock 6, sold 4)',
       store[P].stock === 6 && store[P].sold === 4,
       `stock=${store[P].stock} sold=${store[P].sold}`);
  }

  /* No replay path exists, so a "retry" cannot double-count: the writer never re-sends. */
  ok('no replay queue can re-send a delta',
     !/_pendingPushIds|_flushPendingPushes|setTimeout\([^)]*flush/i.test(liveOmni) &&
     !/catch[\s\S]{0,200}?_posSyncCanonicalStock\s*\(/.test(livePos));

  /* — permission denial is observable, never a false success — */
  {
    const store = { [P]: { stock: 10, sold: 0 } };
    const h = buildWriter({ store, fsOpts: { denyOnWrite: P } });
    const status = await h.call(P, -3, 'sale:t9');
    ok('permission deny → status "denied", never "synced"', status === 'denied', 'got ' + status);
    ok('permission deny → canonical doc unchanged', store[P].stock === 10 && store[P].sold === 0);
    ok('permission deny → PosHealth.recordError called',
       h.errors.length === 1 && h.errors[0].type === 'canonical_stock_denied',
       JSON.stringify(h.errors));
    ok('permission deny → cashier is told', h.toasts.length === 1 && h.toasts[0].type === 'error',
       JSON.stringify(h.toasts));
    ok('permission deny → no success metric recorded', h.metrics.length === 0);
    ok('permission deny → outcome event emitted', h.events.some(e => e.status === 'denied'));
  }

  /* A five-line sale on an unauthorised till informs once, it does not spam. */
  {
    const store = { [P]: { stock: 10, sold: 0 } };
    const h = buildWriter({ store, fsOpts: { denyOnWrite: P } });
    for (let i = 0; i < 5; i++) await h.call(P, -1, 'sale:t10');
    ok('5 denied lines → 1 toast, but 5 recorded errors',
       h.toasts.length === 1 && h.errors.length === 5,
       `toasts=${h.toasts.length} errors=${h.errors.length}`);
  }

  /* — a denial that carries no `code`, only a message, must still be classified — */
  {
    const store = { [P]: { stock: 10, sold: 0 } };
    const h = buildWriter({ store, fsOpts: { denyOnWriteNoCode: P } });
    const status = await h.call(P, -1, 'sale:t11');
    ok('code-less denial (message only) → still "denied", cashier still told',
       status === 'denied' && h.toasts.length === 1, 'got ' + status);
  }

  /* — non-denial failures are still observable — */
  {
    const store = { [P]: { stock: 10, sold: 0 } };
    const h = buildWriter({ store, fsOpts: { failOnRead: P } });
    const status = await h.call(P, -1, 'sale:t12');
    ok('generic failure → status "failed", never "synced"', status === 'failed', 'got ' + status);
    ok('generic failure → recorded to PosHealth as canonical_stock_failed',
       h.errors.length === 1 && h.errors[0].type === 'canonical_stock_failed');
    ok('generic failure → no toast (only denials are actionable by the cashier)', h.toasts.length === 0);
  }

  /* — states that are NOT failures must not be reported as success either — */
  await scenario('offline → "deferred", nothing written',
    { start: { stock: 10, sold: 0 }, online: false, ops: [[-1, 'sale:t12']],
      expect: { stock: 10, sold: 0, status: 'deferred' } });

  await scenario('no firebaseDB → "unavailable"',
    { start: { stock: 10, sold: 0 }, dbPresent: false, ops: [[-1, 'sale:t13']],
      expect: { stock: 10, sold: 0, status: 'unavailable' } });

  await scenario('zero delta → "skipped"',
    { start: { stock: 10, sold: 0 }, ops: [[0, 'sale:t14']],
      expect: { stock: 10, sold: 0, status: 'skipped' } });

  {
    const store = {};                                   // doc does not exist
    const h = buildWriter({ store });
    const status = await h.call(P, -1, 'sale:t15');
    ok('local-only product → "not-canonical", no write', status === 'not-canonical' && !store[P], status);
  }

  /* — marketplaceId linkage: the capability pushStock provided must survive — */
  {
    const store = { mkt_9: { stock: 10, sold: 0 } };
    const h = buildWriter({ store, local: { pos_local_1: { id: 'pos_local_1', marketplaceId: 'mkt_9' } } });
    const status = await h.call('pos_local_1', -2, 'sale:t16');
    ok('marketplace-linked product resolves via marketplaceId',
       status === 'synced' && store.mkt_9.stock === 8 && store.mkt_9.sold === 2,
       `status=${status} ` + JSON.stringify(store.mkt_9));
  }

  /* ═════════════════════════════════════════════════════════════════════
     PART C — mutation proofs: each guard must be the reason a test passes
     ═════════════════════════════════════════════════════════════════════ */
  console.log('\nPART C — mutation proofs (a broken guard must FAIL these)');

  function mutate(find, replace) {
    const mutated = runnableSrc.replace(find, replace);
    if (mutated === runnableSrc) return null;             // mutation did not apply
    return mutated;
  }
  async function runMutant(mutantSrc, { start, id = P, delta, reason, local = {}, fsOpts = {} }) {
    const store = { [P]: { ...start } };
    const events = [], errors = [], toasts = [];
    const win = { firebaseDB: {}, PosHealth: { recordError: (t, m, c) => errors.push({ t, m, c }), recordMetric: () => {} },
                  dispatchEvent: (e) => events.push(e.detail) };
    const sandbox = {
      window: win, PosHealth: win.PosHealth, navigator: { onLine: true },
      PosDB: { products: { get: async (i) => local[i] || null } },
      toast: (m, t) => toasts.push({ m, t }), console: { error: () => {} },
      CustomEvent: class { constructor(type, init) { this.detail = init && init.detail; } },
      Date, Number, Math, String, Object, Boolean,
      __mockFirestore: async () => makeFirestore(store, fsOpts),
    };
    const keys = Object.keys(sandbox);
    // eslint-disable-next-line no-new-func
    new Function(...keys, `'use strict'; let _canonDenyToastAt = 0;\n${outcomeSrc}\n${mutantSrc}`)(...keys.map(k => sandbox[k]));
    const status = await win._posSyncCanonicalStock(id, delta, reason);
    return { status, store, errors, toasts };
  }

  /* M1 — remove the zero floor: stock 2 minus 5 must then go negative. */
  {
    const m = mutate('Math.max(0, Number(d.stock || 0) + delta)', 'Number(d.stock || 0) + delta');
    ok('M1 mutation applies (floor guard is present to remove)', !!m);
    if (m) {
      const r = await runMutant(m, { start: { stock: 2, sold: 0 }, delta: -5, reason: 'sale:m1' });
      ok('M1 unfloored stock goes negative — the floor is what makes the matrix pass', r.store[P].stock === -3,
         'got ' + r.store[P].stock);
    }
  }

  /* M2 — restore the ABSOLUTE write pushStock used to do: the concurrency test must break. */
  {
    const m = mutate('stock:            Math.max(0, Number(d.stock || 0) + delta),',
                     'stock:            9,   /* mutant: absolute local level, as pushStock wrote */');
    ok('M2 mutation applies (delta write is present to replace)', !!m);
    if (m) {
      /* canonical is 7 after a marketplace sale of 3; an absolute push of 9 erases it */
      const r = await runMutant(m, { start: { stock: 7, sold: 3 }, delta: -1, reason: 'sale:m2' });
      ok('M2 absolute write ERASES the marketplace sale (7 → 9) — exactly the retired defect',
         r.store[P].stock === 9, 'got ' + r.store[P].stock);
    }
  }

  /* M3 — swallow the denial: the false-success defect must be detectable. */
  {
    const m = mutate(/return _posCanonicalOutcome\(denied \? 'denied' : 'failed'[\s\S]*?\);/,
                     "return _posCanonicalOutcome('synced', { id, canonicalId, delta, reason: r });");
    ok('M3 mutation applies (denial outcome is present to swallow)', !!m);
    if (m) {
      const r = await runMutant(m, { start: { stock: 10, sold: 0 }, delta: -3, reason: 'sale:m3',
                                     fsOpts: { denyOnWrite: P } });
      ok('M3 swallowed denial reports "synced" while nothing was written — the defect this guard prevents',
         r.status === 'synced' && r.store[P].stock === 10, `status=${r.status} stock=${r.store[P].stock}`);
    }
  }

  /* M4 — count every adjustment as a sale: receiving stock must then inflate `sold`. */
  {
    const m = mutate(/const soldDelta = [\s\S]*?: 0;/, 'const soldDelta = -delta;');
    ok('M4 mutation applies (sold classification is present to break)', !!m);
    if (m) {
      const r = await runMutant(m, { start: { stock: 2, sold: 9 }, delta: 5, reason: 'purchase_order:m4' });
      ok('M4 unclassified soldDelta corrupts `sold` on a receive (9 → 4) — the classifier is load-bearing',
         r.store[P].sold === 4, 'got ' + r.store[P].sold);
    }
  }

  /* M5 — drop the marketplaceId resolution: linked products must then miss canonical. */
  {
    const m = mutate('if (local && local.marketplaceId) canonicalId = String(local.marketplaceId);', '');
    ok('M5 mutation applies (marketplaceId resolution is present to remove)', !!m);
    if (m) {
      const store = { mkt_9: { stock: 10, sold: 0 } };
      const events = [];
      const win = { firebaseDB: {}, PosHealth: { recordError: () => {}, recordMetric: () => {} },
                    dispatchEvent: (e) => events.push(e.detail) };
      const sandbox = {
        window: win, PosHealth: win.PosHealth, navigator: { onLine: true },
        PosDB: { products: { get: async () => ({ id: 'pos_local_1', marketplaceId: 'mkt_9' }) } },
        toast: () => {}, console: { error: () => {} },
        CustomEvent: class { constructor(t, i) { this.detail = i && i.detail; } },
        Date, Number, Math, String, Object, Boolean,
        __mockFirestore: async () => makeFirestore(store, {}),
      };
      const keys = Object.keys(sandbox);
      // eslint-disable-next-line no-new-func
      new Function(...keys, `'use strict'; let _canonDenyToastAt = 0;\n${outcomeSrc}\n${m}`)(...keys.map(k => sandbox[k]));
      const status = await win._posSyncCanonicalStock('pos_local_1', -2, 'sale:m5');
      ok('M5 without marketplaceId resolution the linked sale never reaches canonical — capability would be LOST',
         status === 'not-canonical' && store.mkt_9.stock === 10, 'status=' + status);
    }
  }

  console.log(`\nPASS ${pass} / FAIL ${fail}\n`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(1); });
