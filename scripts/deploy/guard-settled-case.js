#!/usr/bin/env node
'use strict';
/**
 * PREDEPLOY GATE — the double-credit guard must be present AND connected.
 * scripts/deploy/guard-settled-case.js
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────
 * The IntaSend webhook credits the seller and marks the order `settlementStatus: "settled"`
 * (lowercase). settleOrder and the auto-confirm sweep used to skip only 'SETTLED', so completing
 * a webhook-paid order credited the seller a second time. The fix — `isAlreadySettled()` —
 * went live 2026-09-26 (onorderstatuschange-00064-rat). Production functions are a union of
 * lineages, so ANY deploy from a tree that lacks the guard silently reinstates the double credit.
 * See docs/MARKETPLACE_DOUBLE_CREDIT_MEASUREMENT.md.
 *
 * ── WHAT A PASS MEANS ───────────────────────────────────────────────────────────────────
 * Not "the word isAlreadySettled appears in a file". A guard left defined but bypassed is the
 * failure this gate exists to catch, so it proves three things independently:
 *
 *   STRUCTURE   (AST, @babel/parser) the predicate is defined and exported; settleOrder returns
 *               'already-settled' on it; the sweep `continue`s on it; and neither function keeps
 *               a SECOND raw comparison against SETTLED that could decide differently.
 *   BEHAVIOUR   the real module is loaded and settleOrder / autoConfirmDeliveredOrders are driven
 *               against an in-memory database: every settled spelling produces NO write.
 *   CONTROL     an unsettled order IS credited and an unsettled delivered order IS auto-completed
 *               — proof the harness can see a credit, so "no write" is an observation.
 *
 * ── FAILS CLOSED ────────────────────────────────────────────────────────────────────────
 * Missing file, missing parser, a crash while loading or driving the module: all exit 1. A gate
 * that passes when it cannot look is not a gate.
 *
 * No CLI arguments (the Windows firebase predeploy spawner mangles trailing args — see
 * predeploy-payout-gate.js). Optional env, for certification only:
 *   SETTLED_GUARD_TARGET       the order-settlement.js to check (default: ../../functions/…)
 *   SETTLED_GUARD_SOURCE_FILE  read the source text from here instead, while resolving its
 *                              requires as if it lived at SETTLED_GUARD_TARGET (mutation tests)
 *
 * Usable as a module: `runGate({ filename, sourceText }) -> { ok, checks: [{ok, id, msg}] }`.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const DEFAULT_TARGET = path.resolve(__dirname, '..', '..', 'functions', 'order-settlement.js');
const SETTLED_SPELLINGS = ['settled', 'SETTLED', 'Settled', ' SETTLED', ' settled ', '\tSETTLED\n'];
const NOT_SETTLED = [undefined, null, '', 'UNSETTLED', 'SETTLING', 'HELD', 'queued',
  'ELIGIBLE_FOR_SETTLEMENT', 'REFUNDED', 'REVERSED', ['SETTLED'], {}];

/* ── Parser: resolved from the functions tree, fail closed if absent ─────────────────── */
function loadParser(filename) {
  try {
    const p = require.resolve('@babel/parser', { paths: [path.dirname(filename), __dirname] });
    return require(p);
  } catch (_) {
    try { return require('@babel/parser'); } catch (__) { return null; }   /* honours NODE_PATH */
  }
}

/* Minimal AST walk (no @babel/traverse dependency). */
function walk(node, fn, parents) {
  if (!node || typeof node.type !== 'string') return;
  fn(node, parents || []);
  const next = (parents || []).concat([node]);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra' || /Comments$/.test(k)) continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walk(c, fn, next));
    else if (v && typeof v.type === 'string') walk(v, fn, next);
  }
}
const isCallTo = (n, name) => n && n.type === 'CallExpression' && n.callee && n.callee.type === 'Identifier' && n.callee.name === name;
const contains = (n, pred) => { let hit = false; walk(n, (x) => { if (pred(x)) hit = true; }); return hit; };

function topLevelFunction(ast, name) {
  for (const s of ast.program.body) {
    if (s.type === 'FunctionDeclaration' && s.id && s.id.name === name) return s;
  }
  return null;
}

/* A comparison that decides "is this ORDER settled" WITHOUT the predicate:
   `o.settlementStatus === STATES.SETTLED`, `st !== 'SETTLED'`, `x.settlementStatus == 'settled'`,
   where `st` is a local assigned from `.settlementStatus`. It must be a SETTLEMENT STATUS on the
   other side: `res.outcome === 'settled'` compares a function's return value and is not a
   settlement decision. Assignments (settlementStatus: STATES.SETTLED) are not comparisons. */
function statusAliases(fnNode) {
  const names = new Set();
  walk(fnNode, (n) => {
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.init &&
        n.init.type === 'MemberExpression' && !n.init.computed && n.init.property.name === 'settlementStatus') names.add(n.id.name);
  });
  return names;
}
function rawSettledComparisonIn(fnNode) {
  const aliases = statusAliases(fnNode);
  const settledSide = (x) => x && (
    (x.type === 'StringLiteral' && /^\s*settled\s*$/i.test(x.value)) ||
    (x.type === 'MemberExpression' && !x.computed && x.property && x.property.name === 'SETTLED'));
  const statusSide = (x) => x && (
    (x.type === 'MemberExpression' && !x.computed && x.property && x.property.name === 'settlementStatus') ||
    (x.type === 'Identifier' && aliases.has(x.name)));
  return contains(fnNode, (n) => n.type === 'BinaryExpression' && ['===', '!==', '==', '!='].includes(n.operator) &&
    ((settledSide(n.left) && statusSide(n.right)) || (settledSide(n.right) && statusSide(n.left))));
}

function structuralChecks(src, filename, parser, add) {
  let ast;
  try {
    ast = parser.parse(src, { sourceType: 'script', allowReturnOutsideFunction: true, errorRecovery: false });
  } catch (e) { add(false, 'S0', `source parses (${e.message})`); return; }
  add(true, 'S0', 'source parses');

  const def = topLevelFunction(ast, 'isAlreadySettled');
  add(!!def, 'S1', 'isAlreadySettled is a top-level function declaration');

  let exported = false;
  walk(ast.program, (n) => {
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' &&
        n.left.object && n.left.object.name === 'module' && n.left.property && n.left.property.name === 'exports' &&
        n.right.type === 'ObjectExpression') {
      if (n.right.properties.some((p) => p.key && (p.key.name === 'isAlreadySettled' || p.key.value === 'isAlreadySettled'))) exported = true;
    }
  });
  add(exported, 'S2', 'isAlreadySettled is exported from module.exports');

  const settle = topLevelFunction(ast, 'settleOrder');
  const sweep = topLevelFunction(ast, 'autoConfirmDeliveredOrders');
  add(!!settle, 'S3', 'settleOrder is present');
  add(!!sweep, 'S4', 'autoConfirmDeliveredOrders is present');

  if (settle) {
    let gated = false;
    walk(settle, (n) => {
      if (n.type !== 'IfStatement' || !isCallTo(n.test, 'isAlreadySettled')) return;
      const ret = n.consequent.type === 'ReturnStatement' ? n.consequent
        : (n.consequent.type === 'BlockStatement' && n.consequent.body.find((s) => s.type === 'ReturnStatement'));
      const arg = ret && ret.argument;
      if (arg && arg.type === 'ObjectExpression' && arg.properties.some((p) =>
        p.key && p.key.name === 'outcome' && p.value.type === 'StringLiteral' && p.value.value === 'already-settled')) gated = true;
    });
    add(gated, 'S5', "settleOrder returns { outcome: 'already-settled' } on `if (isAlreadySettled(...))`");
    add(!rawSettledComparisonIn(settle), 'S6', 'settleOrder has NO second raw comparison against SETTLED (bypass)');
  }
  if (sweep) {
    let gated = false;
    walk(sweep, (n) => {
      if (n.type !== 'IfStatement' || !contains(n.test, (x) => isCallTo(x, 'isAlreadySettled'))) return;
      const c = n.consequent;
      if (c.type === 'ContinueStatement' || (c.type === 'BlockStatement' && c.body.some((s) => s.type === 'ContinueStatement'))) gated = true;
    });
    add(gated, 'S7', 'autoConfirmDeliveredOrders `continue`s on isAlreadySettled(...)');
    add(!rawSettledComparisonIn(sweep), 'S8', 'autoConfirmDeliveredOrders has NO second raw comparison against SETTLED (bypass)');
  }
}

/* ── In-memory Firestore, enough of the Admin API for these two functions ─────────────
   Records every write. Reads of anything not seeded return a non-existent snapshot, which
   is what a fresh project looks like — the settlement engine falls back to its defaults. */
function memoryDb(seed) {
  const docs = Object.assign({}, seed);
  const writes = [];
  const rec = (op, p, d) => { writes.push({ op, path: p }); if (op !== 'delete') docs[p] = Object.assign({}, docs[p] || {}, d || {}); };
  const snap = (p) => ({ exists: Object.prototype.hasOwnProperty.call(docs, p), id: p.split('/').pop(),
    data: () => (docs[p] ? Object.assign({}, docs[p]) : undefined), ref: docRef(p) });
  function docRef(p) {
    return { path: p, id: p.split('/').pop(),
      get: async () => snap(p),
      set: async (d) => rec('set', p, d), update: async (d) => rec('update', p, d),
      create: async (d) => rec('create', p, d), delete: async () => rec('delete', p),
      collection: (c) => coll(p + '/' + c) };
  }
  function query(cp, filters) {
    const run = () => {
      const depth = cp.split('/').length + 1;
      const ds = Object.keys(docs).filter((p) => p.startsWith(cp + '/') && p.split('/').length === depth)
        .filter((p) => filters.every(([f, op, v]) => op !== '==' || (docs[p] || {})[f] === v)).map(snap);
      return { empty: ds.length === 0, size: ds.length, docs: ds, forEach: (fn) => ds.forEach(fn) };
    };
    const q = {
      where: (f, op, v) => query(cp, filters.concat([[f, op, v]])),
      orderBy: () => q, limit: () => q, limitToLast: () => q, offset: () => q, select: () => q,
      startAfter: () => q, startAt: () => q, endBefore: () => q, endAt: () => q,
      get: async () => run(),
      count: () => ({ get: async () => ({ data: () => ({ count: run().size }) }) }),
    };
    return q;
  }
  function coll(cp) {
    let auto = 0;
    return Object.assign(query(cp, []), {
      doc: (id) => docRef(cp + '/' + (id || ('__auto_' + (++auto)))),
      add: async (d) => { const r = docRef(cp + '/__auto_' + (++auto)); rec('create', r.path, d); return r; },
    });
  }
  const tx = {
    get: async (r) => r.get(),
    set: (r, d) => { rec('set', r.path, d); return tx; }, update: (r, d) => { rec('update', r.path, d); return tx; },
    create: (r, d) => { rec('create', r.path, d); return tx; }, delete: (r) => { rec('delete', r.path); return tx; },
  };
  const db = {
    collection: coll, doc: (p) => docRef(p),
    runTransaction: async (fn) => fn(tx),
    getAll: async (...refs) => Promise.all(refs.map((r) => r.get())),
    batch: () => { const b = { set: (r, d) => (rec('set', r.path, d), b), update: (r, d) => (rec('update', r.path, d), b),
      delete: (r) => (rec('delete', r.path), b), create: (r, d) => (rec('create', r.path, d), b), commit: async () => [] }; return b; },
  };
  return { db, writes, docs };
}
const FAKE_ADMIN = { firestore: { FieldValue: {
  serverTimestamp: () => ({ __sentinel: 'serverTimestamp' }),
  increment: (n) => ({ __sentinel: 'increment', n }),
  arrayUnion: (...a) => ({ __sentinel: 'arrayUnion', a }), arrayRemove: (...a) => ({ __sentinel: 'arrayRemove', a }),
  delete: () => ({ __sentinel: 'delete' }),
}, Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms) => ({ toMillis: () => ms }) } } };

function loadModule(sourceText, filename) {
  const m = new Module(filename, module);
  m.filename = filename;
  m.paths = Module._nodeModulePaths(path.dirname(filename));
  m._compile(sourceText, filename);
  return m.exports;
}

const SELLER = 'gate_seller';
const pickupOrder = (id, st, status) => {
  const o = { id, sellerUid: SELLER, uid: 'gate_buyer', buyerUid: 'gate_buyer', total: 97, orderTotal: 97,
    deliveryFee: 0, fulfillmentType: 'pickup', status: status || 'completed', paymentStatus: 'paid',
    paymentVerified: true, channel: 'online' };
  if (st !== undefined) o.settlementStatus = st;
  return o;
};
const moneyWrites = (writes) => writes.filter((w) => /^(wallets|walletTransactions|settlements|ledger)\//.test(w.path));

async function behaviouralChecks(OS, add) {
  add(typeof OS.isAlreadySettled === 'function', 'B0', 'module exports a callable isAlreadySettled');
  if (typeof OS.isAlreadySettled === 'function') {
    /* A throw is a wrong answer, not a crash to be forgiven. */
    const safe = (v) => { try { return OS.isAlreadySettled(v); } catch (_) { return '__threw__'; } };
    const badYes = SETTLED_SPELLINGS.filter((v) => safe(v) !== true);
    const badNo = NOT_SETTLED.filter((v) => safe(v) !== false);
    add(!badYes.length, 'B1', `recognises every settled spelling ${JSON.stringify(SETTLED_SPELLINGS)}` + (badYes.length ? ` — MISSED ${JSON.stringify(badYes)}` : ''));
    add(!badNo.length, 'B2', 'rejects every non-settled value' + (badNo.length ? ` — WRONGLY ACCEPTED ${JSON.stringify(badNo)}` : ''));
  }

  /* settleOrder: every settled spelling -> no money write at all. */
  const leaked = [];
  for (const st of SETTLED_SPELLINGS) {
    const { db, writes } = memoryDb({ ['orders/o1']: pickupOrder('o1', st, 'completed'), ['wallets/' + SELLER]: { balance: 1000 } });
    let r;
    try { r = await OS.settleOrder(db, FAKE_ADMIN, 'o1'); } catch (e) { r = { outcome: 'threw: ' + e.message }; }
    if (!r || r.outcome !== 'already-settled' || moneyWrites(writes).length) leaked.push(`${JSON.stringify(st)}->${r && r.outcome}/${moneyWrites(writes).length} writes`);
  }
  add(!leaked.length, 'B3', 'settleOrder writes NO money for any settled spelling' + (leaked.length ? ` — LEAKED ${leaked.join(', ')}` : ''));

  /* CONTROL: an unsettled order IS credited — the harness can see a credit. */
  {
    const { db, writes } = memoryDb({ ['orders/o2']: pickupOrder('o2', undefined, 'completed'), ['wallets/' + SELLER]: { balance: 1000 } });
    let r;
    try { r = await OS.settleOrder(db, FAKE_ADMIN, 'o2'); } catch (e) { r = { outcome: 'threw: ' + e.message }; }
    const credited = writes.some((w) => w.path === 'wallets/' + SELLER);
    add(r && r.outcome === 'settled' && credited, 'C1', `CONTROL: an unsettled order IS credited (outcome ${r && r.outcome}, wallet written: ${credited})`);
  }

  /* Sweep: settled delivered orders are never auto-completed; the unsettled control is. */
  {
    const old = Date.now() - 30 * 86400000;
    const seed = {};
    SETTLED_SPELLINGS.forEach((st, i) => { seed['orders/s' + i] = Object.assign(pickupOrder('s' + i, st, 'delivered'), { deliveredAt: old }); });
    seed['orders/ctl'] = Object.assign(pickupOrder('ctl', undefined, 'delivered'), { deliveredAt: old });
    const { db, writes } = memoryDb(seed);
    let threw = null;
    try { await OS.autoConfirmDeliveredOrders(db, FAKE_ADMIN); } catch (e) { threw = e.message; }
    add(!threw, 'B5', 'auto-confirm sweep runs without throwing' + (threw ? ` (threw: ${threw})` : ''));
    const touched = writes.filter((w) => /^orders\/s\d+$/.test(w.path)).map((w) => w.path);
    const ctl = writes.some((w) => w.path === 'orders/ctl');
    add(!touched.length, 'B4', 'auto-confirm sweep completes NO settled order' + (touched.length ? ` — COMPLETED ${touched.join(',')}` : ''));
    add(ctl, 'C2', 'CONTROL: the sweep DOES auto-complete an unsettled delivered order');
  }
}

async function runGate(opts) {
  const o = opts || {};
  const filename = path.resolve(o.filename || DEFAULT_TARGET);
  const checks = [];
  const add = (ok, id, msg) => checks.push({ ok: !!ok, id, msg });
  let src;
  try { src = o.sourceText != null ? String(o.sourceText) : fs.readFileSync(filename, 'utf8'); }
  catch (e) { add(false, 'F0', `order-settlement.js readable at ${filename} (${e.code || e.message})`); return { ok: false, checks }; }
  add(true, 'F0', `order-settlement.js readable (${filename})`);

  const parser = loadParser(filename);
  if (!parser) add(false, 'P0', '@babel/parser resolvable from the functions tree (install functions deps; the gate refuses to pass blind)');
  else structuralChecks(src, filename, parser, add);

  let OS = null;
  try { OS = loadModule(src, filename); add(true, 'L0', 'module loads'); }
  catch (e) { add(false, 'L0', `module loads (${e.message})`); }
  if (OS) {
    try { await behaviouralChecks(OS, add); }
    catch (e) { add(false, 'X0', `behavioural checks ran to completion (crash: ${e.message})`); }
  }
  return { ok: checks.length > 0 && checks.every((c) => c.ok), checks };
}

module.exports = { runGate, memoryDb, SETTLED_SPELLINGS };

if (require.main === module) {
  const filename = process.env.SETTLED_GUARD_TARGET || DEFAULT_TARGET;
  const sourceFile = process.env.SETTLED_GUARD_SOURCE_FILE;
  /* The settlement modules log freely while being driven; keep the gate's own verdict legible. */
  const quiet = { log: console.log, warn: console.warn, info: console.info };
  console.log = console.warn = console.info = () => {};
  runGate({ filename, sourceText: sourceFile ? fs.readFileSync(sourceFile, 'utf8') : null })
    .then((r) => {
      Object.assign(console, quiet);
      r.checks.forEach((c) => console.log(`${c.ok ? 'PASS' : 'FAIL'} [${c.id}] ${c.msg}`));
      console.log(r.ok ? '[settled-guard] PASS — double-credit guard present and connected'
                       : '[settled-guard] FAIL — deploy blocked: the double-credit guard is missing or disconnected. See docs/MARKETPLACE_DOUBLE_CREDIT_MEASUREMENT.md');
      process.exit(r.ok ? 0 : 1);
    })
    .catch((e) => { Object.assign(console, quiet); console.error('[settled-guard] FAIL — gate crashed (fails closed):', e && e.stack || e); process.exit(1); });
}
