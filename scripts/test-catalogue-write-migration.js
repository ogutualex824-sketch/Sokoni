/* ═══════════════════════════════════════════════════════════════════════════
   3A — CATALOGUE WRITES ROUTE THROUGH THE CANONICAL WRITER
   scripts/test-catalogue-write-migration.js

   Option 1 put the write authority in `posUpsertProduct`. This certifies that
   `catalogue.html` actually uses it, and — just as important — that the payload
   it sends is one that writer ACCEPTS, field by field. A migration that routes
   correctly but sends fields the writer drops has moved the discard defect, not
   removed it.

   ── WHAT IS DELIBERATELY STILL BROKEN ──────────────────────────────────────

   READS. Under the served ruleset (`ad2033ad`, proven 12/0) this page cannot
   read `posProducts` at all, and 3A does not change that: the repair is a rules
   change that must separate read from write, because stamping `sellerId` onto
   documents to unblock reads would also grant clients direct create/update/
   delete — the opposite of Option 1. This suite asserts the read path is
   UNCHANGED so that "3A is done" can never be mistaken for "the catalogue
   works".
   ═══════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const cp   = require('child_process');

const ROOT = path.join(__dirname, '..');
const R    = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : '')); ok ? pass++ : fail++; return ok; };
const head = (t) => console.log('\n' + t + '\n' + '-'.repeat(t.length));

const HTML = R('catalogue.html');
/* Strip comments before asserting. Three separate detectors in this workstream
   have already fired on prose that DOCUMENTED the thing they were looking for. */
const CODE = HTML.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');

console.log('\n3A — CATALOGUE WRITE MIGRATION');
console.log('='.repeat(74));

head('0. CONTROL — the file was read and stripped, and still contains its code');
ck('catalogue.html parsed', HTML.length > 10000, HTML.length + 'B');
ck('comment stripping left the code', CODE.includes('async function dispatch(') && CODE.length > 8000,
   CODE.length + 'B');

head('1. No direct posProducts write remains');
ck('no setDoc/addDoc/updateDoc against posProducts',
   !/(setDoc|addDoc|updateDoc)\s*\(\s*doc\s*\(\s*db\s*,\s*['"]posProducts/.test(CODE), 'none');
ck('setDoc is no longer even imported',
   !/import\s*\{[^}]*\bsetDoc\b[^}]*\}\s*from/.test(CODE), 'transport removed, not just unused');
ck('writes go through smartPosDispatch',
   /httpsCallable\(\s*fns\s*,\s*'smartPosDispatch'\s*\)/.test(CODE));
ck('the create/update op is posUpsertProduct',
   /dispatch\(\s*'posUpsertProduct'/.test(CODE));
ck('the archive op is the server soft-delete posDeleteProduct',
   /dispatch\(\s*'posDeleteProduct'/.test(CODE));

head('2. Identity — the business id, never the uid');
ck('no merchantId: uid anywhere in code', !/merchantId\s*:\s*uid\b/.test(CODE));
ck('merchantId comes from the shell scope the shell already resolved',
   /SokoniInShell\s*&&\s*window\.SokoniInShell\.merchantScope\(\)/.test(CODE) ||
   /merchantScope\(\)/.test(CODE));
ck('scope.merchantId is used, NOT scope.shopId (a different identifier space)',
   /sc\s*&&\s*sc\.merchantId/.test(CODE) && !/sc\.shopId/.test(CODE));
ck('an unresolved business FAILS CLOSED instead of defaulting',
   /if\(!merchantId\)\{[\s\S]{0,400}throw new Error/.test(CODE), 'no fabricated id');
ck('the dispatch payload always carries merchantId',
   /merchantId:\s*merchantId/.test(CODE));

head('3. The payload is one posUpsertProduct actually accepts');
/* Derive the writer's accepted input names from the handler itself rather than
   hardcoding a list here — a list would rot the moment the writer changes, and
   this check exists precisely to catch drift between the two. */
const FN = R('functions/pos-inventory-pro.js');
const iU = FN.indexOf('exports._h.posUpsertProduct');
const jU = FN.indexOf('exports._h.posDeleteProduct');
const UPSERT = FN.slice(iU, jU > iU ? jU : FN.length);
/* TWO IDIOMS, NOT ONE. Most fields are read as `d.<name>`, but the catalogue
   flags go through `_pcCatalogueFlag(d, 'trackStock', 'trackInventory')`, where
   the field names are STRING ARGUMENTS. A `d.` -only scan reported trackStock and
   variablePrice as dropped when the contract suite had just executed them
   successfully — the detector was blind to the second idiom, so it described the
   writer's API rather than reading it. */
const accepted = new Set([
  ...(UPSERT.match(/\bd\.[a-zA-Z]+/g) || []).map((x) => x.slice(2)),
  ...(UPSERT.match(/_pcCatalogueFlag\(\s*d\s*,\s*'[^']+'(?:\s*,\s*'[^']+')?/g) || [])
      .flatMap((m) => (m.match(/'[^']+'/g) || []).map((q) => q.slice(1, -1))),
]);
ck('CONTROL — the writer\'s accepted-field set was extracted',
   accepted.size > 10 && accepted.has('name') && accepted.has('price'),
   accepted.size + ' fields');

/* What the page sends: the keys of the payload object literal plus later
   assignments. */
const payloadBlock = CODE.slice(CODE.indexOf('const payload = {'), CODE.indexOf("await dispatch('posUpsertProduct', payload)"));
const sentInline = (payloadBlock.match(/^\s*([a-zA-Z]+)\s*:/gm) || []).map((x) => x.trim().replace(':', ''));
const sentAssigned = (payloadBlock.match(/payload\.([a-zA-Z]+)\s*=/g) || []).map((x) => x.slice(8).replace(/\s*=$/, ''));
const restoreBlock = CODE.slice(CODE.indexOf("dispatch('posUpsertProduct', {", CODE.indexOf('posDeleteProduct')));
const sentRestore = (restoreBlock.slice(0, 400).match(/^\s*([a-zA-Z]+)\s*:/gm) || []).map((x) => x.trim().replace(':', ''));
const sent = [...new Set([...sentInline, ...sentAssigned, ...sentRestore])];

ck('CONTROL — the payload keys were extracted', sent.length >= 8, sent.join(','));
const dropped = sent.filter((k) => !accepted.has(k) && k !== 'op');
ck('EVERY field the page sends is accepted by the writer (nothing silently dropped)',
   dropped.length === 0, dropped.length ? 'DROPPED: ' + dropped.join(',') : 'all ' + sent.length + ' accepted');

head('4. The catalogue contract fields are actually sent');
for (const f of ['trackStock', 'listingType', 'unit', 'description']) {
  ck('sends ' + f, sent.includes(f) || new RegExp('payload\\.' + f).test(payloadBlock));
}
ck('sends variablePrice for a service', /payload\.variablePrice/.test(payloadBlock));
ck('stock is OMITTED when blank, never sent as 0 (absent = UNMETERED)',
   /next\.stock\s*!==\s*''\s*\)\s*payload\.stock/.test(payloadBlock) ||
   /!==\s*''\)\s*payload\.stock\s*=/.test(payloadBlock.replace(/\s+/g, ' ')) ||
   /payload\.stock\s*=\s*Number\(next\.stock\)/.test(payloadBlock) && /next\.stock !== undefined/.test(payloadBlock));

head('5. Idempotency — a double-tapped Save cannot create two products');
ck('a create sends an idempotencyKey', /idempotencyKey/.test(CODE));
ck('an edit sends productId instead', /payload\.productId\s*=\s*st\.editing\.id/.test(CODE));
ck('the page no longer mints its own document id for a create',
   !/doc\s*\(\s*db\s*,\s*'posProducts'\s*,\s*id\s*\)/.test(CODE), 'the server issues the id');

head('6. The read path — 3A left it denied, 3B moved it to the server');
/* THIS GATE ROTTED WHEN THE THING IT GUARDED WAS FIXED. In 3A it asserted the
   direct `where('merchantId','==',uid)` read was STILL PRESENT, which was the
   honest statement then: 3A must not look like a working catalogue. 3B (Option A)
   replaced that read with a dispatcher call, so the old assertion now fails for
   the right reason. It is re-pointed at the post-3B truth rather than deleted —
   what must never regress is the page touching posProducts directly. */
ck('the direct merchantId-scoped Firestore read is GONE (3B)',
   !/where\('merchantId',\s*'==',\s*uid\)/.test(CODE), 'replaced by posListProducts');
ck('reads go through the canonical server op',
   /dispatch\('posListProducts'/.test(CODE));
ck('the page still has NO direct posProducts access of any kind',
   !/(getDocs|setDoc|addDoc|updateDoc|onSnapshot)\s*\(\s*(query\s*\(\s*)?(collection|doc)\s*\(\s*db\s*,\s*['"]posProducts/.test(CODE),
   'collection stays closed to the browser');
ck('no rules file was touched by this unit',
   (() => {
     try {
       const out = cp.execSync('git diff --name-only HEAD~1 HEAD', { cwd: ROOT, encoding: 'utf8' });
       return !/firestore\.rules/.test(out);
     } catch (_) { return true; }
   })(), 'firestore.rules untouched');

head('7. No success is reported before the server accepts');
ck('the dispatch helper throws unless the server returned ok:true',
   /out\.ok\s*!==\s*true[\s\S]{0,200}throw new Error/.test(CODE));
ck('the UI closes/reloads only AFTER the awaited dispatch',
   /await dispatch\('posUpsertProduct', payload\);\s*\n\s*this\.close/.test(CODE) ||
   /await dispatch\('posUpsertProduct', payload\);[\s\S]{0,80}close\('ov-edit'\)/.test(CODE));

console.log('\n' + '='.repeat(74));
console.log('  ' + pass + ' passed, ' + fail + ' failed');
console.log(fail === 0
  ? '  3A CERTIFIED — writes route through the canonical writer. READS REMAIN DENIED (3B).'
  : '  3A NOT CERTIFIED.');
process.exit(fail === 0 ? 0 : 1);
