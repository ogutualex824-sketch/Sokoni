#!/usr/bin/env node
/* Merchant consolidation census — READ ONLY, no network, no credentials.
 *
 *   node scripts/census-merchant-consolidation.js
 *
 * Answers three questions with evidence, before any code moves:
 *
 *   1. CAPABILITY   what does merchant.html own natively, and what does it still
 *                   borrow from seller.html at runtime?
 *   2. REFERENCE    who else in the tree still points at seller.html, and in
 *                   what capacity (workspace nav, deep link, test, backend)?
 *   3. LIFECYCLE    do the five merchant state transitions — application,
 *                   approval, role authority, shop activation, subscription
 *                   entitlement — actually have a writer on the marketplace
 *                   path, or only on the POS path?
 *
 * It asserts nothing about what SHOULD be true; it prints what IS true and
 * fails only if the census itself cannot be computed (a missing file, an
 * unparseable contract). Re-run it after each consolidation commit — the
 * numbers are the progress bar.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const EXISTS = (f) => fs.existsSync(path.join(ROOT, f));

const line = (s = '') => console.log(s);
const rule = (c = '─') => line('  ' + c.repeat(74));

let problems = 0;
const must = (label, ok, detail) => {
  if (!ok) { problems++; line('  !! ' + label + (detail ? '  [' + detail + ']' : '')); }
  return ok;
};

/* ═══════════════════════════════════════════════════════════════════════════
   1. CAPABILITY CENSUS
   ═══════════════════════════════════════════════════════════════════════════ */
line('\n══ 1. CAPABILITY CENSUS — merchant.html vs seller.html ══\n');

const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
must('merchant route contract validates', C.validate().length === 0, C.validate().join(' | '));

const byKind = {};
for (const r of C.ROUTES) (byKind[r.kind] = byKind[r.kind] || []).push(r);

const KIND_MEANING = {
  native: 'owned by merchant.html — no seller.html involved',
  seller: 'BORROWED — mounts seller.html in an iframe (merchant.html:568)',
  pos: 'mounts a pos.html tab',
  page: 'mounts a standalone page file',
  exit: 'leaves the shell',
};

for (const kind of ['native', 'seller', 'pos', 'page', 'exit']) {
  const rs = byKind[kind] || [];
  line(`  ${kind.toUpperCase().padEnd(8)} ${String(rs.length).padStart(2)}  ${KIND_MEANING[kind] || ''}`);
  line('           ' + rs.map(r => r.id + (r.sec ? `(${r.sec})` : '')).join(', '));
}
rule();

const borrowed = byKind.seller || [];
const total = C.ROUTES.length;
line(`  ${borrowed.length} of ${total} routes still require seller.html at runtime.`);
line(`  Consolidation target = those ${borrowed.length}: ` + borrowed.map(r => r.sec).join(', '));

/* Sizes are a blunt but honest measure of how much page is involved. */
const kb = (f) => (fs.statSync(path.join(ROOT, f)).size / 1024).toFixed(0) + 'KB';
line(`\n  merchant.html ${kb('merchant.html')}   seller.html ${kb('seller.html')}   seller.js ${kb('seller.js')}`);

/* seller.js DASH_PAGES — the sections the borrowed routes address. */
const sellerJs = R('seller.js');
const dashStart = sellerJs.indexOf('const DASH_PAGES = {');
must('seller.js DASH_PAGES located', dashStart > -1);
const dashBlock = sellerJs.slice(dashStart, sellerJs.indexOf('\n};', dashStart));
const secs = [...dashBlock.matchAll(/^\s{2}([a-zA-Z_][\w]*)\s*:/gm)].map(m => m[1]);
const addressed = new Set(borrowed.map(r => r.sec));
line(`  seller.js exposes ${secs.length} sections; merchant.html addresses ${addressed.size}.`);
line(`  NOT addressed by any merchant route: ` + secs.filter(s => !addressed.has(s)).join(', '));

/* ═══════════════════════════════════════════════════════════════════════════
   2. REFERENCE CENSUS
   ═══════════════════════════════════════════════════════════════════════════ */
line('\n══ 2. REFERENCE CENSUS — who still points at seller.html ══\n');

/* -E: git grep defaults to BASIC regex, where `(`, `|` and `?` are literals.
   Without it every alternation below silently matches nothing and the census
   reports a confident, wrong "0 writers". */
function grepFiles(pattern) {
  try {
    const out = execFileSync('git', ['grep', '-nE', '--', pattern], { cwd: ROOT, maxBuffer: 1 << 28 }).toString();
    return out.split('\n').filter(Boolean);
  } catch (_) { return []; }
}

/* Negative control: a pattern that MUST match, so a silently broken grep fails
   the census instead of producing an empty, reassuring report. */
function assertGrepWorks() {
  /* Two controls, both known-present, one exercising the alternation that BRE
     would silently swallow. A census that greps for nothing must fail loudly
     rather than report a reassuring zero. */
  const exact = grepFiles("collection\\('applications'\\)");
  must('grep control — literal match', exact.length > 0, "collection('applications') not found");
  const alt = grepFiles("(sellerApplications|role-authority)");
  must('grep control — alternation works (-E)', alt.length > 0, 'alternation matched nothing');
}

const hits = grepFiles('seller\\.html').filter(h => !h.startsWith('node_modules/'));
const byFile = {};
for (const h of hits) {
  const f = h.split(':')[0];
  byFile[f] = (byFile[f] || 0) + 1;
}

/* Classify the consumer, because "291 references" is not actionable and the
   classes have completely different migration costs. */
const classify = (f) => {
  if (f.startsWith('scripts/') || f.startsWith('tests/')) return 'test/harness';
  if (f.startsWith('functions/')) return 'backend (emails, links, admin)';
  if (f.startsWith('docs/') || f.endsWith('.md') || f.endsWith('.json')) return 'docs/manifest';
  if (['sokoni-nav-engine.js', 'shared-header.js', 'sokoni-permissions.js', 'splash.js', 'sokoni-merchant-routes.js'].includes(f)) return 'platform nav/auth';
  if (f === 'merchant.html' || f === 'seller.html' || f === 'seller.js') return 'the two systems themselves';
  return 'page/feature link';
};

const byClass = {};
for (const [f, n] of Object.entries(byFile)) {
  const c = classify(f);
  byClass[c] = byClass[c] || { files: 0, refs: 0, top: [] };
  byClass[c].files++; byClass[c].refs += n;
  byClass[c].top.push([f, n]);
}
line(`  ${hits.length} references across ${Object.keys(byFile).length} files\n`);
for (const [c, v] of Object.entries(byClass).sort((a, b) => b[1].refs - a[1].refs)) {
  line(`  ${String(v.refs).padStart(4)} refs / ${String(v.files).padStart(3)} files   ${c}`);
  line('       ' + v.top.sort((a, b) => b[1] - a[1]).slice(0, 4).map(([f, n]) => `${f}(${n})`).join('  '));
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. LIFECYCLE CENSUS — does each transition have a writer?
   ═══════════════════════════════════════════════════════════════════════════ */
line('\n══ 3. LIFECYCLE CENSUS — five transitions, marketplace path ══\n');

assertGrepWorks();

/* A "writer" is a line that both names the collection AND performs a write.
   Both the modular client SDK (setDoc(doc(db,'x',id))) and the Admin SDK
   (db.collection('x').doc(id).set) put the two on one line in this codebase;
   lines that only read are excluded, and tests/harnesses are reported apart
   from production so a harness cannot look like a production writer. */
/* Match both the bare collection name and the trigger-path form
   ('sellerApplications/{appId}') — a collection that exists ONLY as a trigger
   path is precisely the interesting case, and matching only the bare name
   reports it as absent. */
const nameOrPath = (c) => `['"]${c}(/[^'"]*)?['"]`;

const writers = (collection) =>
  grepFiles(nameOrPath(collection))
    .filter(h => !h.startsWith('node_modules/'))
    .filter(h => /addDoc|setDoc|updateDoc|\.set\(|\.add\(|\.update\(|tx\.set|batch\.set/.test(h))
    .filter(h => !/^(CHANGELOG|docs\/)/.test(h));

const readOnlyRefs = (collection) =>
  grepFiles(nameOrPath(collection)).filter(h => !h.startsWith('node_modules/')).length;

const isTest = (h) => /^(scripts|tests)\//.test(h);
const stage = (name, collection, note) => {
  const all = writers(collection);
  const w = all.filter(h => !isTest(h));
  const clientW = w.filter(h => !h.startsWith('functions/'));
  const serverW = w.filter(h => h.startsWith('functions/'));
  line(`  ${name}`);
  line(`     collection      ${collection}   (${readOnlyRefs(collection)} refs total)`);
  line(`     PROD writers    ${w.length}   client:${clientW.length}  server:${serverW.length}` +
       (all.length - w.length ? `   (+${all.length - w.length} in tests/harnesses)` : ''));
  for (const h of w.slice(0, 5)) line('       ' + h.split(':').slice(0, 2).join(':'));
  if (note) line(`     → ${note}`);
  line('');
  return { collection, writers: w.length, clientW: clientW.length, serverW: serverW.length };
};

const L = {};
L.sellerApplications = stage('A. APPLICATION (automation trigger source)', 'sellerApplications',
  'autoOnSellerApplication listens here');
L.applications = stage('B. APPLICATION (canonical registry)', 'applications',
  'applications = REQUEST, registries = TRUTH');
L.shops = stage('C. SHOP ACTIVATION', 'shops', 'the doc that makes a shop live');
L.sellers = stage('D. SELLER REGISTRY', 'sellers', 'what the storefront reads');
L.subscriptions = stage('E. SUBSCRIPTION / TRIAL', 'subscriptions', 'entitlement');

/* Which of the applications writers name a seller/merchant role at all? */
const appWriters = writers('applications').map(h => h.split(':')[0]);
const sellerAppWriter = [...new Set(appWriters)].filter(f => {
  const src = R(f);
  return /role\s*:\s*['"]seller|type\s*:\s*['"]seller|['"]merchant['"]/.test(src);
});
line('  Application writers that mention a seller/merchant role:');
line('     ' + (sellerAppWriter.length ? sellerAppWriter.join(', ') : 'NONE'));

/* The question that matters is narrower: can a MERCHANT submit one? The admin
   console and the server-side lifecycle both write `applications`, and neither
   is a merchant filing a request. */
const merchantSubmitters = sellerAppWriter.filter(f =>
  !f.startsWith('functions/') && !/^(admin|moderation|superadmin)\.html$/.test(f));
line(`  ...of which a MERCHANT can submit from: ${merchantSubmitters.length ? merchantSubmitters.join(', ') : 'NONE'}`);

/* Role authority: whose job is the claim (Stage 2 primitive). */
const roleAuth = EXISTS('functions/role-authority.js');
line(`\n  Role authority module present: ${roleAuth ? 'yes — functions/role-authority.js' : 'NO'}`);
const delegated = /DELEGATED_ROLES\s*=\s*\{[^}]*seller/.test(R('functions/application-lifecycle.js'));
line(`  Approval projects a seller registry doc: ${delegated ? 'NO — seller is DELEGATED (records, projects nothing)' : 'yes'}`);

/* Trial authority. */
const bb = R('functions/business-bootstrap.js');
const trialInCreate = /batch\.set\(db\.collection\('subscriptions'\)/.test(bb);
line(`  Trial writer: ${trialInCreate ? "business-bootstrap.js _createBusiness (dispatched as 'createBusiness')" : 'not found'}`);
const posOnly = grepFiles("createBusiness")
  .filter(h => !h.startsWith('functions/') && !h.startsWith('node_modules/'))
  .filter(h => !/^(CHANGELOG|docs\/)/.test(h) && !h.endsWith('.md'));
line(`  Reachable from: ${posOnly.map(h => h.split(':')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ') || 'no client caller found'}`);

/* ═══════════════════════════════════════════════════════════════════════════ */
line('\n══ SUMMARY ══\n');
line(`  merchant.html native capabilities      ${(byKind.native || []).length}`);
line(`  capabilities still borrowed from seller ${borrowed.length}`);
line(`  seller.html references in tree          ${hits.length}`);
line(`  marketplace application writers         ${sellerAppWriter.length}`);
line(`  sellerApplications writers              ${L.sellerApplications.writers}`);
line('');

if (problems) { line(`  census incomplete — ${problems} problem(s) above\n`); process.exit(1); }
process.exit(0);
