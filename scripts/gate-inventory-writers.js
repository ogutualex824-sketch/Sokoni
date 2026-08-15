#!/usr/bin/env node
/* ────────────────────────────────────────────────────────────────────────────
   gate-inventory-writers.js — ANTI-DRIFT gate for canonical inventory authority.

   WHY
   Two client-side inventory writers have already been retired:
     0e13db2  seller-wiring.js  — quantity-blind increment, fired before payment
     6daec0b  PosOmni.pushStock — ABSOLUTE local level, erased concurrent sales
   Nothing stops a third from appearing. This gate is the ratchet that makes a
   resurrection fail the build instead of reaching production.

   WHAT IT IS — AND IS NOT
   This is a RESURRECTION DETECTOR, not a writer inventory. It proves:

       no write to canonical products/{id} touching stock authority fields
       exists outside the allow-list, IN THE FORMS IT CAN RESOLVE

   It does NOT prove "the platform has exactly one inventory writer". That
   sentence needs the repo-wide writer inventory, which is a separate exercise —
   see BLIND SPOTS below and docs/LAUNCH_TODO.md. A gate that cannot see a
   construct cannot certify its absence, so unresolvable writes are reported as
   REVIEW and fail the gate rather than passing quietly.

   HOW IT AVOIDS THE FIRST ATTEMPT'S FAILURE
   A first pass grepped bare `stock:` keys and flagged 14 files, nearly all false
   positives — `functions/inventory-engine.js` matched on an ERROR MESSAGE. This
   gate is structural: it locates a write CALL, resolves its TARGET to a
   collection, resolves its PAYLOAD, and only then asks whether an authority
   field is being written. A string that merely contains the word cannot match.

   BLIND SPOTS (declared, not discovered later)
     1. Target/payload resolution is textual plus ONE level of local variable
        indirection. A collection name assembled at runtime
        (`db.collection(x)`) is UNRESOLVED, never silently allowed.
     2. A write reaching Firestore through a helper wrapper is attributed to the
        wrapper, not the caller. The wrapper still has to be allow-listed.
     3. It reads source, not behaviour. It cannot tell a reachable writer from
        dead code — that is what the reachability measurement in 0e13db2 was for.
     4. Cloud Functions are in scope, but a server writer is canonical BY
        ARCHITECTURE. Allow-listing one records that it exists; it does not
        assert it is correct.

   EXIT 0 = no violations, no unresolved authority writes.
   ──────────────────────────────────────────────────────────────────────────── */
'use strict';
const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

/* Fields that constitute canonical inventory AUTHORITY. Writing any of these to
   products/{id} is claiming to be an inventory writer. */
const AUTHORITY_FIELDS = ['stock', 'sold', 'inventoryVersion', 'stockQty'];

/* ── REGISTER ──────────────────────────────────────────────────────────────
   Derived by running this gate over the tree and classifying EVERY hit — not
   assumed. The first draft of this file guessed "three legitimate server
   writers" from an earlier `sold:` grep; the real number is nine files. The
   guess is why the register is derived, and why `--derive` exists.

   Keyed on FILE + SITE COUNT, deliberately, not on function name. Attribution
   by nearest-name was wrong on eight of fifteen sites (writes sit inside
   anonymous runTransaction callbacks), and a key that breaks under refactoring
   makes the gate fail for the wrong reason. A count is stable and still traps a
   NEW writer: adding one changes the count.

   THREE TIERS, kept apart on purpose:

     SERVER    canonical by architecture. The server IS the inventory authority;
               listing one records that it exists, it does not audit it.
     CLIENT    the single sanctioned client writer.
     QUARANTINE  client-side writers that are KNOWN DEFECTS and not yet fixed.
               Listing one is not permission. This count may only FALL. */

const SERVER = [
  { file: 'functions/index.js',                sites: 3,
    why: '_finalizeMarketplacePayment and the daraja path — THE canonical checkout deduction. ' +
         'Transactional, floored at zero, bumps inventoryVersion, records oversoldAlerts.' },
  { file: 'functions/pos-marketplace-sync.js', sites: 2,
    why: 'Click-and-collect reserve + cancel restore. TOCTOU-safe re-read inside the txn.' },
  { file: 'functions/pos-zero-friction.js',    sites: 2,
    why: 'POS sale deduction and its symmetric refund restore.' },
  { file: 'functions/pos-retail.js',           sites: 1,
    why: 'posSyncToMarketplace — batch FieldValue.increment so concurrent branch syncs merge.' },
  { file: 'functions/pos-retail-engine.js',    sites: 2,
    why: 'POS sale deduction and voidPOSSale restore, both FieldValue.increment inside a ' +
         'transaction after an insufficient-stock precheck. NOTE: mirrors to `soldCount`, ' +
         'not `sold` — see the field-divergence note in docs/LAUNCH_TODO.md.' },
  { file: 'functions/pos-completeness.js',     sites: 1,
    why: 'Cycle-count completion writes an ABSOLUTE stock: item.countedQty. Absolute is ' +
         'correct here — a physical count supersedes the running total rather than adjusting ' +
         'it — but it bumps no inventoryVersion, so listeners see no version change.' },
  { file: 'functions/b2b-wholesale.js',        sites: 1,
    why: 'Wholesale order approval deducts with FieldValue.increment inside a transaction, ' +
         'after rejecting the order outright when currentStock < quantity.' },
  { file: 'functions/wap.js',                  sites: 2,
    why: '_svcInventoryReserve / _svcInventoryRelease — the SERVER implementation of the ' +
         'inventory.reserve/release workflow steps. See QUARANTINE: the client duplicates these.' },
];

const CLIENT = [
  { file: 'pos.js', sites: 1,
    why: 'The POS terminal\'s only canonical writer (_posSyncCanonicalStock). Signed delta in a ' +
         'transaction, floored at zero, bumps inventoryVersion, classifies `sold` by reason, and ' +
         'reports a denied write instead of swallowing it. Replaced PosOmni.pushStock in 6daec0b.' },
];

const QUARANTINE = [
  { file: 'sokoni-wap-definitions.js', sites: 2,
    why: 'wap.register(\'inventory.reserve\'/\'inventory.release\') writes canonical products/{id}.stock ' +
         'FROM THE BROWSER, duplicating _svcInventoryReserve/_svcInventoryRelease in functions/wap.js. ' +
         'Same duplicate-authority class as pushStock. Transactional and guarded against going ' +
         'negative, so it is not the pushStock overwrite bug — but it bumps NO inventoryVersion, so ' +
         'every listener and the indexProductUpdate movement trail miss the change. ' +
         'Reachable: loaded by wap.html and precached by service-worker.js.' },
  { file: 'warehouse-scanner.html', sites: 2,
    why: 'Cycle-count and adjustment write an ABSOLUTE stockQty to products/{id} via ' +
         'db.doc(`products/${id}`) — computed client-side, no inventoryVersion. This is the ' +
         'path-form write the segment-only matcher originally could not see.' },
  { file: 'pos-boss.js', sites: 1,
    why: 'marketplace.pushProducts publishes POS rows to products/pos_{biz}_{id} with an absolute ' +
         'stockQty from local POS state. A publish path rather than a sale path, and it owns the ' +
         'documents it writes — but it is still a client writing absolute canonical stock.' },
];

const REGISTER = [...SERVER, ...CLIENT, ...QUARANTINE];
const TIER = new Map([...SERVER.map((e) => [e.file, 'SERVER']),
                      ...CLIENT.map((e) => [e.file, 'CLIENT']),
                      ...QUARANTINE.map((e) => [e.file, 'QUARANTINE'])]);

/* ── SCOPE ────────────────────────────────────────────────────────────────
   `scripts` is excluded for the same reason audit-base64-writes.js excludes it:
   tooling legitimately NAMES the pattern it hunts. This file spells out the
   retired write, and scripts/test-pos-canonical-stock.js RECONSTRUCTS it as
   mutation proof M2. Both would otherwise report themselves.

   That exclusion is only safe because nothing under scripts/ is executable in a
   browser. Firebase Hosting publishes the repo root (public: "."), so those
   files are SERVED — but a served file that no page loads cannot run. The gate
   asserts exactly that below rather than trusting it. */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'scripts', 'docs', 'tests']);

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue;
      walk(path.join(dir, e.name), out);
    } else if (/\.(js|html|mjs)$/i.test(e.name) && !/\.min\./i.test(e.name)) {
      out.push(path.join(dir, e.name));
    }
  }
  return out;
}

/* ── Source hygiene ───────────────────────────────────────────────────────
   Blank out comments and string bodies so a write "mentioned" in prose or an
   error message cannot match, while byte offsets and line numbers survive. */
function blankNonCode(src) {
  const out = src.split('');
  let i = 0, mode = null, quote = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (mode === null) {
      if (c === '/' && n === '/')      { mode = 'line';  out[i] = out[i + 1] = ' '; i += 2; continue; }
      if (c === '/' && n === '*')      { mode = 'block'; out[i] = out[i + 1] = ' '; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; i++; continue; }
      i++; continue;
    }
    if (mode === 'line')  { if (c === '\n') mode = null; else out[i] = ' '; i++; continue; }
    if (mode === 'block') {
      if (c === '*' && n === '/') { out[i] = out[i + 1] = ' '; mode = null; i += 2; continue; }
      if (c !== '\n') out[i] = ' ';
      i++; continue;
    }
    if (mode === 'str') {
      if (c === '\\') { out[i] = ' '; if (src[i + 1] !== '\n') out[i + 1] = ' '; i += 2; continue; }
      if (c === quote) { mode = null; quote = null; i++; continue; }
      /* Keep the quote characters themselves but blank the body, EXCEPT we must
         still be able to read short collection-name literals like 'products'.
         Preserve short alphanumeric bodies; blank anything long enough to be prose. */
      i++; continue;
    }
  }
  /* Second pass: blank only LONG string bodies (prose / error messages), keeping
     short identifiers-as-strings such as 'products' resolvable. */
  return out.join('').replace(/(['"`])([^'"`\n]{25,})\1/g, (m, q) => q + ' '.repeat(m.length - 2) + q);
}

/* Extract the balanced argument text starting at the '(' index. */
function argsAt(src, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(openIdx + 1, i); }
  }
  return null;
}

/* Split argument text on TOP-LEVEL commas only. */
function splitArgs(text) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) { parts.push(text.slice(start, i)); start = i + 1; }
  }
  parts.push(text.slice(start));
  return parts.map((s) => s.trim()).filter((s) => s.length);
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

/* Nearest preceding declaration of IDENT, so `const ref = doc(db,'products',id)`
   and `const patch = { stock: ... }` both resolve. One level only, by design. */
function resolveIdent(code, ident, beforeIdx) {
  if (!/^[A-Za-z_$][\w$]*$/.test(ident)) return null;
  const re = new RegExp('(?:const|let|var)\\s+' + ident.replace(/\$/g, '\\$') + '\\s*=', 'g');
  let m, best = null;
  while ((m = re.exec(code)) && m.index < beforeIdx) best = m.index + m[0].length;
  if (best === null) return null;
  /* Take the rest of the statement, balanced. */
  let depth = 0;
  for (let i = best; i < code.length; i++) {
    const c = code[i];
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if ((c === ';' || c === '\n') && depth <= 0) return code.slice(best, i);
  }
  return code.slice(best, best + 400);
}

/* Canonical target in either notation:
     collection('products').doc(id)   — segment form
     db.doc(`products/${id}`)         — PATH form, incl. template literals
   The path form was a real blind spot: warehouse-scanner.html:818 writes canonical
   stock through db.doc(`products/${product.id}`) and the segment-only matcher could
   not see it. A detector that cannot see a form cannot certify its absence. */
const looksLikeProducts = (t) => !!t && (/['"`]products['"`]/.test(t) || /['"`]products\//.test(t));

/* True when the target names a collection that is NOT `products`. Guarded so
   `posProducts` / `sellerProducts` / `inventory_variants` cannot be mistaken for it.
   `col(` is included because functions/inventory-v2.js reaches Firestore through a
   tenant-scoped helper of that name. */
function namesOtherCollection(t) {
  if (!t) return false;
  if (looksLikeProducts(t)) return false;
  return /(?:collection|doc|col)\s*\(\s*[^)]*['"`]([A-Za-z_][\w]*)['"`]/.test(t)
      || /['"`]([A-Za-z_][\w]*)\//.test(t);
}

/* Does this payload text write an authority field as a top-level key? */
function authorityFieldsIn(payloadText) {
  if (!payloadText) return [];
  const body = payloadText.trim();
  if (!body.startsWith('{')) return [];
  const inner = body.slice(1, body.lastIndexOf('}'));
  const found = [];
  for (const part of splitArgs(inner)) {
    const key = part.match(/^\s*(?:\[?\s*['"`]?)([A-Za-z_$][\w$]*)/);
    if (key && AUTHORITY_FIELDS.includes(key[1])) found.push(key[1]);
  }
  return found;
}

/* Enclosing function, found by BRACE DEPTH rather than "nearest preceding name".
   The naive version attributed functions/index.js:2996 to `_num` — a helper declared
   far earlier in the file — which would have made every allow-list entry keyed to a
   name that is not the writer. Walk outward through unmatched `{`, and take the first
   enclosing block whose header names something. */
function enclosingFn(code, idx) {
  const HEADER = [
    /(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/,          /* function foo() {   */
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>)?\s*$/,
    /(?:exports|module\.exports)\.([A-Za-z_$][\w$]*)\s*=[^{]*$/,
    /window\.([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?function\s*\([^)]*\)\s*$/,
    /\b([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function\s*)?\([^)]*\)\s*(?:=>)?\s*$/,  /* foo: () => { */
    /\b([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*$/,                                 /* method shorthand   */
    /register\s*\(\s*['"`]([^'"`]+)['"`][^{]*$/,                            /* wap.register('x',  */
  ];
  /* `for (…) {` and `if (…) {` match the method-shorthand shape. A block keyword is
     not a function name — keep walking outward instead of reporting fn=for. */
  const KEYWORDS = new Set(['for', 'if', 'while', 'switch', 'catch', 'try', 'else',
                            'do', 'function', 'return', 'await', 'forEach', 'then']);
  let depth = 0;
  for (let i = idx; i >= 0; i--) {
    const c = code[i];
    if (c === '}') depth++;
    else if (c === '{') {
      if (depth === 0) {
        const header = code.slice(Math.max(0, i - 200), i).replace(/\s+$/, '');
        for (const re of HEADER) {
          const m = header.match(re);
          if (m && !KEYWORDS.has(m[1])) return m[1];
        }
        /* unnamed or keyword block — continue outward */
      } else depth--;
    }
  }
  return null;
}

/* ── Scan ─────────────────────────────────────────────────────────────────── */
const WRITE_CALLS = [
  /* modular v9: updateDoc(ref, payload) / setDoc(ref, payload) */
  { re: /\b(updateDoc|setDoc)\s*\(/g,                       refArg: 0, payloadArg: 1 },
  /* transaction / batch: t.update(ref, payload) */
  { re: /\b(?:tx|t|txn|transaction|batch|bat)\s*\.\s*(update|set)\s*\(/g, refArg: 0, payloadArg: 1 },
  /* admin SDK: someRef.update(payload) / someRef.set(payload) */
  { re: /([A-Za-z_$][\w$.\[\]()'"` ]*?)\s*\.\s*(update|set)\s*\(/g,       refSelf: true, payloadArg: 0 },
];

/* Pure scanner over ONE source. Exported so the gate's own tests can feed it
   reconstructed known-bad writers without mutating the repository tree — a test
   that writes a decoy file into the repo root is a test that can leave debris,
   and another process writes this repo. */
function scanSource(rel, raw) {
  const hits = [], review = [];
  const code = blankNonCode(raw);

  for (const form of WRITE_CALLS) {
    form.re.lastIndex = 0;
    let m;
    while ((m = form.re.exec(code))) {
      const open = code.indexOf('(', m.index + m[0].length - 1);
      const argText = argsAt(code, open);
      if (argText === null) continue;
      const args = splitArgs(argText);

      let refText, payloadText;
      if (form.refSelf) {
        refText = m[1];
        payloadText = args[form.payloadArg];
      } else {
        refText = args[form.refArg];
        payloadText = args[form.payloadArg];
      }
      if (!payloadText) continue;

      /* Resolve payload through one level of indirection. */
      let payloadResolved = payloadText;
      if (/^[A-Za-z_$][\w$]*$/.test(payloadText.trim())) {
        payloadResolved = resolveIdent(code, payloadText.trim(), m.index) || payloadText;
      }
      const fields = authorityFieldsIn(payloadResolved);
      if (!fields.length) continue;                 /* not an inventory write at all */

      /* Resolve target to a collection. A target naming SOME OTHER collection is
         resolved-and-irrelevant, not "unknown" — `inventoryMovements` and
         `posProducts` are different documents and must not clog REVIEW. */
      let targetText = (refText || '').trim().replace(/^await\s+/, '');
      let resolved = looksLikeProducts(targetText);
      if (!resolved) {
        if (namesOtherCollection(targetText)) continue;
        const bare = targetText.replace(/\[[^\]]*\]$/, '');          /* refs[i] -> refs */
        const ident = /^[A-Za-z_$][\w$]*$/.test(bare) ? bare
                    : (bare.match(/^([A-Za-z_$][\w$]*)\./) || [])[1];   /* pItem.ref -> pItem */
        const decl = ident ? resolveIdent(code, ident, m.index) : null;
        if (looksLikeProducts(decl)) resolved = true;
        else if (namesOtherCollection(decl)) continue;
        else {
          review.push({ rel, line: lineOf(code, m.index), fn: enclosingFn(code, m.index),
                        fields, target: targetText.slice(0, 60),
                        reason: decl ? 'target resolves to no collection literal' : 'target not statically resolvable' });
          continue;
        }
      }

      hits.push({ rel, line: lineOf(code, m.index), fn: enclosingFn(code, m.index), fields, resolved: true });
    }
  }
  return { hits, review };
}

module.exports = { scanSource, SERVER, CLIENT, QUARANTINE, REGISTER, AUTHORITY_FIELDS };

/* Everything below is the CLI. Requiring this file must not scan or exit. */
if (require.main !== module) return;

const hits = [], review = [];
for (const file of walk(ROOT, [])) {
  const rel = path.relative(ROOT, file).replace(/\\/g, '/');
  const r = scanSource(rel, fs.readFileSync(file, 'utf8'));
  hits.push(...r.hits);
  review.push(...r.review);
}

/* ── Assertion that justifies the scripts/ exclusion ──────────────────────── */
const htmlLoadsScripts = walk(ROOT, [])
  .filter((f) => /\.html$/i.test(f))
  .filter((f) => /src=["'][^"']*\/?scripts\//i.test(fs.readFileSync(f, 'utf8')))
  .map((f) => path.relative(ROOT, f));

/* ── Tally per file ───────────────────────────────────────────────────────
   An UNRESOLVED write still counts against its file's budget. It is a write we
   can see but cannot fully attribute — absorbing it silently is the one thing a
   gate must never do. */
const all = [...hits, ...review.map((r) => ({ ...r, resolved: false }))];
const byFile = new Map();
for (const h of all) {
  if (!byFile.has(h.rel)) byFile.set(h.rel, []);
  byFile.get(h.rel).push(h);
}

const unregistered = [], drifted = [], reduced = [];
for (const [file, list] of byFile) {
  const entry = REGISTER.find((e) => e.file === file);
  if (!entry) { unregistered.push({ file, list }); continue; }
  if (list.length > entry.sites) drifted.push({ file, expected: entry.sites, actual: list.length, list });
  else if (list.length < entry.sites) reduced.push({ file, expected: entry.sites, actual: list.length });
}

/* ── Report ───────────────────────────────────────────────────────────────── */
const DERIVE = process.argv.includes('--derive');
console.log('\ngate-inventory-writers — canonical products/{id} authority writes\n');

if (DERIVE) {
  console.log('DERIVE MODE — every authority write found, for register construction:\n');
  for (const h of all.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line))
    console.log(`  ${(TIER.get(h.rel) || 'UNREGISTERED').padEnd(12)} ${h.rel}:${h.line}  fn=${h.fn || '?'}  ` +
                `fields=[${h.fields.join(',')}]${h.resolved ? '' : '  (unresolved target)'}`);
  console.log(`\n  ${all.length} authority write sites across ${byFile.size} files\n`);
}

const count = (tier) => all.filter((h) => TIER.get(h.rel) === tier).length;
console.log(`  SERVER   (canonical by architecture) : ${count('SERVER')} sites / ${SERVER.length} files`);
console.log(`  CLIENT   (the single writer)         : ${count('CLIENT')} site(s)`);
console.log(`  QUARANTINE (known client defects)    : ${count('QUARANTINE')} sites / ${QUARANTINE.length} files`);
console.log(`  unregistered                         : ${unregistered.length} file(s)`);
console.log(`  count drift                          : ${drifted.length} file(s)`);
console.log(`  html loading scripts/                : ${htmlLoadsScripts.length}`);

if (unregistered.length) {
  console.log('\nVIOLATION — inventory authority write in an unregistered file:');
  for (const u of unregistered)
    for (const h of u.list) console.log(`  ${h.rel}:${h.line}  fn=${h.fn || '?'}  writes [${h.fields.join(', ')}]`);
  console.log('\n  A write to canonical products/{id} touching stock authority must go through the');
  console.log('  single writer. If this genuinely IS a new authority, that is an architectural');
  console.log('  decision: add it to the register with a reason. Do not weaken the detector.');
}

if (drifted.length) {
  console.log('\nVIOLATION — a registered file grew new authority write sites:');
  for (const d of drifted) {
    console.log(`  ${d.file}: expected ${d.expected}, found ${d.actual}`);
    for (const h of d.list) console.log(`      :${h.line}  fn=${h.fn || '?'}  [${h.fields.join(', ')}]`);
  }
}

if (reduced.length) {
  console.log('\nRATCHET — a registered file has FEWER writes than recorded. This is good news;');
  console.log('  lower the count (and for QUARANTINE, delete the entry once it reaches zero):');
  for (const r of reduced) console.log(`  ${r.file}: recorded ${r.expected}, found ${r.actual}`);
}

if (htmlLoadsScripts.length) {
  console.log('\nVIOLATION — an HTML page loads from scripts/, which this gate does not scan:');
  for (const f of htmlLoadsScripts) console.log('  ' + f);
}

if (count('QUARANTINE')) {
  console.log('\nQUARANTINE is not a pass. These client-side writers are recorded defects, open in');
  console.log('  docs/LAUNCH_TODO.md. The gate stops them GROWING; it does not bless them.');
}

const failed = unregistered.length + drifted.length + reduced.length + htmlLoadsScripts.length;
console.log(failed ? '\nGATE FAILED\n' : '\nGATE PASSED\n');
process.exit(failed ? 1 : 0);
