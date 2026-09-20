/* ══════════════════════════════════════════════════════════════════════════════
   SUBSCRIPTION EXPIRY WRITERS — the census, as a gate
   scripts/test-subscription-expiry-writers.js        (A4-F3B — proof surface only)

   WHY THIS EXISTS
   A4 certified that subscription entitlement follows the purchased billing cycle,
   and its suite asserted — as part of that — that `webhookIntasend` writes no
   subscription expiry. The assertion was:

       const wh = indexJs.slice(indexJs.indexOf('exports.webhookIntasend ='), +40000);
       ok('webhookIntasend writes no subscription expiry', !/expiresAt/.test(wh));

   The write is 41,072 characters into that handler. The detector could not reach
   the code, and a negative-only assertion cannot tell "absent" from "unreachable",
   so it passed and the writer shipped unnoticed. That historical result is NOT
   rewritten — it stands as recorded evidence, and this file is its replacement.

   WHAT THIS ASSERTS
   Not "function X does not write expiry" — that is a statement about one name and
   rots the moment code moves. It asserts the CENSUS: every writer of
   subscriptions/{uid}.expiresAt in the tree is known and classified. A fifth
   writer appearing anywhere fails this suite.

   Six facts are tracked separately, because they are different things:
     EXISTS        a write site is present in the source
     REACHABLE     something outside the module can invoke it
     AUTHORITATIVE it establishes the document rather than deferring to an existing one
     DERIVED       the period comes from the billing cycle, not a hardcoded span
     SUPERSEDED    it yields to a document another writer already created
     LATENT        present but gated off the live payment path

   HOW IT DETECTS
   AST via babel, not regex, and no fixed windows. Two write forms, because the
   first draft of this census saw 1 of 3 known writers by handling only the first:
     direct       db.collection('subscriptions').doc(uid).set({ expiresAt })
     transaction  txn.set(subRef, { expiresAt })   — collection is in ARG 0

   THE POSITIVE CONTROL IS THE POINT. Section 1 builds a fixture whose expiry write
   sits deliberately beyond the old 40,000-character boundary, proves THIS detector
   finds it, and proves the OLD slice-based detector does not. Without that pair,
   this file would be one more negative assertion that cannot fail honestly.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const NM = path.join(ROOT, 'functions/node_modules');
const parser = require(path.join(NM, '@babel/parser'));
const traverse = require(path.join(NM, '@babel/traverse')).default;

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);

/* ── THE DETECTOR ─────────────────────────────────────────────────────────── */
const WRITE_OPS = new Set(['set', 'update', 'create', 'add']);

/* Resolve an expression chain to the Firestore collection it addresses. */
function collectionOf (node, vars) {
  let n = node, found = null;
  while (n) {
    if (n.type === 'CallExpression') {
      const c = n.callee;
      if (c && c.type === 'MemberExpression' && c.property.name === 'collection' &&
          n.arguments[0] && n.arguments[0].type === 'StringLiteral') found = n.arguments[0].value;
      n = (c && c.type === 'MemberExpression') ? c.object : null;
    } else if (n.type === 'MemberExpression') n = n.object;
    else if (n.type === 'Identifier') { if (!found && vars.has(n.name)) return vars.get(n.name); n = null; }
    else n = null;
  }
  return found;
}

/* Nearest enclosing name a human would recognise: exports.x, a declared function,
   a const, or an object method such as the adapter's `activate`. */
/* Returns BOTH the name and the node it came from. The range matters as much as
   the name: the innermost function around a write is often a transaction callback
   — `txn.set(...)` inside `runTransaction(async (txn) => {...})` — and the period
   is computed in the NAMED function outside it. Scoping to the innermost arrow
   made W1 and W3 read as "unknown" when both are in fact derived. */
function enclosingUnit (p) {
  let q = p;
  while (q) {
    const n = q.node;
    if (n.type === 'AssignmentExpression' && n.left.type === 'MemberExpression' &&
        n.left.object.name === 'exports') return { name: 'exports.' + (n.left.property.name || '?'), node: n };
    if (n.type === 'FunctionDeclaration' && n.id) return { name: n.id.name, node: n };
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' &&
        n.init && /Function/.test(n.init.type)) return { name: n.id.name, node: n };
    if (n.type === 'ObjectMethod' && n.key) return { name: (n.key.name || n.key.value) + '()', node: n };
    if (n.type === 'ObjectProperty' && n.value && /Function/.test(n.value.type)) {
      return { name: (n.key.name || n.key.value) + '()', node: n };
    }
    q = q.parentPath;
  }
  return { name: '(top level)', node: null };
}

/* Census one source string. `label` is only for reporting. */
function census (src, label) {
  const out = [];
  let ast;
  try {
    ast = parser.parse(src, {
      sourceType: 'unambiguous',
      plugins: ['optionalChaining', 'nullishCoalescingOperator', 'classProperties'],
    });
  } catch (e) { return { error: e.message, rows: out }; }

  const vars = new Map();
  traverse(ast, {
    VariableDeclarator (p) {
      if (p.node.id.type !== 'Identifier' || !p.node.init) return;
      const c = collectionOf(p.node.init, vars);
      if (c) vars.set(p.node.id.name, c);
    },
  });

  traverse(ast, {
    CallExpression (p) {
      const c = p.node.callee;
      if (!c || c.type !== 'MemberExpression' || !c.property || !WRITE_OPS.has(c.property.name)) return;

      /* DIRECT form — collection is in the callee chain. */
      let coll = collectionOf(c.object, vars) ||
                 (c.object.type === 'Identifier' ? vars.get(c.object.name) : null);
      let payload = p.node.arguments[0];

      /* TRANSACTION / BATCH form — txn.set(ref, obj) puts it in ARG 0 instead.
         Omitting this is exactly why a first draft of this census reported one
         writer when three were known. */
      if (!coll && p.node.arguments.length >= 2) {
        const a0 = p.node.arguments[0];
        const viaArg = collectionOf(a0, vars) || (a0.type === 'Identifier' ? vars.get(a0.name) : null);
        if (viaArg) { coll = viaArg; payload = p.node.arguments[1]; }
      }
      if (coll !== 'subscriptions') return;
      if (!payload || payload.type !== 'ObjectExpression') return;

      const keys = payload.properties
        .filter(x => x.type === 'ObjectProperty' && x.key)
        .map(x => x.key.name || x.key.value);
      if (!keys.indexOf) return;
      if (keys.indexOf('expiresAt') === -1) return;

      out.push({
        file: label,
        line: p.node.loc.start.line,
        offset: p.node.start,
        fn: enclosingUnit(p).name,
        /* Source of that SAME named unit, so DERIVED is decided by reading the
           code rather than trusted from a table that drifts. */
        fnSrc: (function () {
          const u = enclosingUnit(p);
          return u.node ? src.slice(u.node.start, u.node.end) : src;
        })(),
        op: c.property.name,
        fields: keys,
      });
    },
  });
  return { error: null, rows: out };
}

/* The old, unsound detector — kept ONLY to prove it fails the control below. */
function oldSliceDetector (src, handlerMarker) {
  const i = src.indexOf(handlerMarker);
  if (i === -1) return false;
  const win = src.slice(i, i + 40000);
  return /collection\("subscriptions"\)/.test(win) && /expiresAt/.test(win);
}

/* ── THE KNOWN WRITERS ────────────────────────────────────────────────────── */
/* Classification is recorded here so a change in the tree shows up as a DIFF
   against a stated position, not as a silent drift. Facts established by the
   A4-F3 investigation; see CHANGELOG entry 88 and its follow-ups. */
const KNOWN = [
  { id: 'W1', file: 'functions/index.js', fn: 'exports.activateSubscription',
    reachable: true, authoritative: false, derived: true, superseded: true, latent: false,
    note: 'Returns without writing when the existing doc carries the same paymentRef.' },
  { id: 'W2', file: 'functions/index.js', fn: 'exports.webhookIntasend',
    reachable: true, authoritative: true, derived: true, superseded: false, latent: false,
    note: 'Live receiver and the writer that decides. REPAIRED by A4-F3D: derives the ' +
          'period from intent.billingCycle, skips fail-closed when it is unknown.' },
  { id: 'W3', file: 'functions/payment-reconciliation.js', fn: 'healSubscriptionEntitlement',
    reachable: true, authoritative: false, derived: true, superseded: true, latent: false,
    note: 'Declines whenever a document already exists, whatever its expiry.' },
  { id: 'W4', file: 'functions/entitlement-adapters.js', fn: 'activate()',
    reachable: true, authoritative: true, derived: false, superseded: false, latent: true,
    note: 'PLAN_DAYS=30. Gated by _systemConfig/entitlementEngine; the webhook invokes only ' +
          'shadowCompareSubscription, not activate(). Latent until a reachable caller is proven.' },
];

/* ══════════════════════════════════════════════════════════════════════════ */
console.log('══════════════════════════════════════════════════════════════════');
console.log('  SUBSCRIPTION EXPIRY WRITERS — census gate (A4-F3B)');
console.log('══════════════════════════════════════════════════════════════════');

/* ── 1. THE DETECTOR IS TRUSTWORTHY BEFORE IT IS USED ─────────────────────── */
head('1 - controls: prove the instrument before believing its output');
{
  /* POSITIVE CONTROL. A known expiry writer placed deliberately past the old
     40,000-character boundary. This is the exact shape the old proof missed. */
  /* Unique names per line — a repeated `const _x` is a duplicate declaration and
     the fixture would fail to PARSE, which is not the same as not being FOUND. */
  let filler = '';
  for (let i = 0; i < 1400; i++) filler += '\n  /* padding */ const _x' + i + ' = 1;';
  const fixture =
    'exports.fixtureHandler = onRequest(async (req, res) => {\n' +
    filler + '\n' +
    '  const subRef = db.collection("subscriptions").doc(uid);\n' +
    '  await subRef.set({ uid, status: "active", expiresAt: someDate, updatedAt: now });\n' +
    '});\n';

  const off = fixture.indexOf('await subRef.set');
  ok('control fixture places the write beyond the old boundary',
     off > 40000, 'write at char ' + off);

  const r = census(fixture, 'fixture.js');
  ok('POSITIVE CONTROL — this detector finds it', !r.error && r.rows.length === 1,
     r.error || (r.rows.length + ' found'));
  ok('and names the enclosing handler',
     r.rows.length === 1 && r.rows[0].fn === 'exports.fixtureHandler',
     r.rows.length ? r.rows[0].fn : '-');

  /* The inverting half: the OLD detector must MISS the same fixture. Without
     this, "the new one finds it" says nothing about what was wrong before. */
  ok('INVERTING CONTROL — the old 40,000-char detector misses it',
     oldSliceDetector(fixture, 'exports.fixtureHandler') === false);

  /* NEGATIVE CONTROL — the detector must be capable of saying no. */
  const clean = 'exports.h = onCall(async (r) => {\n' +
    '  await db.collection("subscriptions").doc(u).set({ status: "cancelled", updatedAt: n });\n' +
    '  await db.collection("orders").doc(o).set({ expiresAt: d });\n});\n';
  const rc = census(clean, 'clean.js');
  ok('NEGATIVE CONTROL — a subscriptions write without expiresAt is not counted',
     rc.rows.length === 0, rc.rows.length + ' found');

  /* TRANSACTION-FORM CONTROL — the blind spot that hid two of four writers. */
  const txnFix = 'async function h(){ const subRef = db.collection("subscriptions").doc(uid);\n' +
    '  await db.runTransaction(async (txn) => { txn.set(subRef, { uid, expiresAt: e }); });\n}\n';
  const rt = census(txnFix, 'txn.js');
  ok('TRANSACTION CONTROL — txn.set(ref, obj) is detected', rt.rows.length === 1,
     rt.rows.length + ' found');
}

/* ── 2. THE CENSUS ────────────────────────────────────────────────────────── */
head('2 - every writer of subscriptions/{uid}.expiresAt in functions/');
const found = [];
{
  /* Recursive: 52 modules live in functions/ subdirectories, and a census that
     cannot see them is not a census. node_modules is excluded deliberately. */
  const files = [];
  (function walk (dir, rel) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
      if (e.name === 'node_modules') return;
      const abs = path.join(dir, e.name), r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.name.endsWith('.js')) files.push(r);
    });
  })(path.join(ROOT, 'functions'), '');
  let parseFails = 0;
  files.forEach(f => {
    const r = census(fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8'), 'functions/' + f);
    if (r.error) { parseFails++; return; }
    r.rows.forEach(x => found.push(x));
  });
  /* A file the parser cannot read is a hole in the census, not a clean scan. */
  ok('every module parsed — no silent holes in the scan', parseFails === 0,
     parseFails + ' parse failures');
  ok('control — the scan actually read the tree', files.length > 20, files.length + ' modules');

  found.sort((a, b) => (a.file + a.line).localeCompare(b.file + b.line));
  found.forEach(w => console.log('        ' + w.file + ':' + w.line + '  ' + w.fn +
    '  .' + w.op + '()  [' + w.fields.length + ' fields]'));

  ok('exactly ' + KNOWN.length + ' writers — a fifth would fail here',
     found.length === KNOWN.length, found.length + ' found');

  /* PROVE that claim rather than asserting it. A synthetic fifth writer is
     censused alongside the real tree; the count must move. Without this, "a
     fifth would fail here" is a promise the suite has never kept. */
  const fifth = census(
    'exports.sneakyRenewal = onCall(async (r) => {\n' +
    '  await db.collection("subscriptions").doc(r.auth.uid)\n' +
    '    .set({ uid: r.auth.uid, expiresAt: whenever, updatedAt: now }, { merge: true });\n' +
    '});\n', 'functions/_synthetic-fifth.js').rows;
  ok('CONTROL — a synthetic fifth writer IS detected', fifth.length === 1,
     fifth.length ? fifth[0].fn : 'MISSED — the count assertion above is vacuous');
  ok('and would break the census count', found.length + fifth.length !== KNOWN.length,
     (found.length + fifth.length) + ' vs expected ' + KNOWN.length);
}

/* ── 3. EACH KNOWN WRITER IS STILL WHERE IT WAS CLASSIFIED ────────────────── */
head('3 - the classified writers are all present');
{
  KNOWN.forEach(k => {
    const hit = found.find(w => w.file === k.file && w.fn === k.fn);
    ok(k.id + '  ' + k.file.replace('functions/', '') + ' :: ' + k.fn,
       !!hit, hit ? 'line ' + hit.line : 'NOT FOUND — classification is stale');
  });
  const unknown = found.filter(w => !KNOWN.some(k => k.file === w.file && k.fn === w.fn));
  ok('no unclassified writer present', unknown.length === 0,
     unknown.map(u => u.file + ':' + u.line + ' ' + u.fn).join(' · ') || 'none');
}

/* ── 4. THE INVARIANT, STATED AS SUCH ─────────────────────────────────────── */
head('4 - the invariant this gate exists to protect');
{
  console.log('        No reachable subscription writer may produce an entitlement');
  console.log('        duration inconsistent with the authoritative billingCycle.\n');

  /* DERIVED is DETECTED, not trusted. A table saying "W2 is fixed" would go on
     saying it after someone reintroduced day arithmetic; reading the enclosing
     function cannot. Derived = calls a named period function AND contains no
     raw N * 86400000 span. Judged on STRIPPED source, because the comments in
     these functions quote the very arithmetic they removed. */
  const stripc = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const classify = (w) => {
    const c = stripc(w.fnSrc || '');
    return {
      callsPeriodFn: /_(sub)?[Pp]eriodEnd\s*\(/.test(c),
      daySpan: /\d+\s*\*\s*86400000/.test(c) || /PLAN_DAYS\s*\*/.test(c),
    };
  };
  found.forEach(w => {
    const k = KNOWN.find(x => x.file === w.file && x.fn === w.fn) || { id: '??', latent: false };
    const c = classify(w);
    const verdict = c.daySpan ? 'FLAT SPAN' : (c.callsPeriodFn ? 'derived' : 'unknown');
    console.log('        ' + (k.id + '   ').slice(0, 4) + (k.latent ? 'LATENT  ' : 'live    ') +
      (verdict + '        ').slice(0, 10) + w.fn);
  });
  console.log();

  const live = found.filter(w => {
    const k = KNOWN.find(x => x.file === w.file && x.fn === w.fn);
    return k && k.reachable && !k.latent;
  });
  ok('control — there are live writers to judge', live.length === 3, live.length + ' live');

  const violating = live.filter(w => { const c = classify(w); return c.daySpan || !c.callsPeriodFn; });
  ok('THE INVARIANT — every live writer derives its period from the cycle',
     violating.length === 0,
     violating.map(w => w.fn).join(' · ') || 'W1, W2, W3 all derived');

  /* INVERTING CONTROL. "No violators" is worthless unless the check can find
     one — and W4, deliberately untouched, is exactly that specimen. */
  const w4 = found.find(w => w.file === 'functions/entitlement-adapters.js');
  ok('INVERTING CONTROL — the check still flags the untouched W4',
     !!w4 && classify(w4).daySpan === true, 'PLAN_DAYS span detected');
  ok('W4 remains classified LATENT, not reachable-and-live',
     KNOWN.filter(k => k.latent).map(k => k.id).join(',') === 'W4');

  /* Superseded writers are why the defect was not self-correcting: the two
     corrected writers both yield to whatever W2 wrote first. */
  const yielding = KNOWN.filter(k => k.superseded).map(k => k.id).sort().join(',');
  ok('W1 and W3 still yield to an existing document', yielding === 'W1,W3', yielding);
  ok('W2 is still the one that establishes it',
     KNOWN.filter(k => !k.superseded && !k.latent).map(k => k.id).join(',') === 'W2');
}

console.log('\n  what this gate does NOT prove');
console.log('  SCOPE     detection is static. A writer built by string eval, or in a module');
console.log('            outside functions/, would not be seen.');
console.log('  HISTORY   A4\'s own suite still contains the unsound 40,000-char assertion.');
console.log('            It is left as recorded evidence and superseded by this file,');
console.log('            not edited to look as though it had been right.');
console.log('  OPEN      W4 is knowingly non-derived. It is LATENT, not live, and stays');
console.log('            outside the repair until its callers are established (A4-F3E).');

console.log('\n══════════════════════════════════════════════════════════════════');
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log('══════════════════════════════════════════════════════════════════');
process.exit(fail ? 1 : 0);
