#!/usr/bin/env node
/* Merchant capability map — READ ONLY, no network, no credentials.
 *
 *   node scripts/census-merchant-capability-map.js
 *
 * Stage-1 census answered "how many routes borrow seller.html". This answers the
 * question that decides HOW to consolidate: for each capability, what is the
 * implementation actually made of, and where does its data come from?
 *
 * The verdict per capability is one of:
 *   EXTRACT    real logic over a canonical source — lift into a shared module
 *   REBUILD    the UI is real but its data source is device-local — porting it
 *              verbatim would import the defect, so the capability is rebuilt
 *              against the canonical source
 *   NATIVE     merchant.html already owns it
 *
 * It also records a FROZEN-AUTHORITY baseline: the client-side patterns that
 * must not grow while the UI is rebuilt. Baseline counts are printed, not
 * judged — except where a pattern writes, which is called out.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const R = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const line = (s = '') => console.log(s);

let problems = 0;
const must = (label, ok, detail) => { if (!ok) { problems++; line('  !! ' + label + (detail ? '  [' + detail + ']' : '')); } };

function grep(pattern, files) {
  try {
    return execFileSync('git', ['grep', '-nE', '--', pattern, ...(files || [])], { cwd: ROOT, maxBuffer: 1 << 28 })
      .toString().split('\n').filter(Boolean).filter(h => !h.startsWith('node_modules/'));
  } catch (_) { return []; }
}

/* Negative control — a broken matcher must fail the census, not report zeros. */
must('grep control', grep("localStorage", ['seller.js']).length > 0, 'no localStorage in seller.js?!');

const sellerJs = R('seller.js');
const sellerHtml = R('seller.html');
const merchantHtml = R('merchant.html');
const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));

/* ── 1. Data source per capability ──────────────────────────────────────── */
line('\n══ 1. WHAT THE BORROWED CAPABILITIES ARE MADE OF ══\n');

const keyCount = (src, key) =>
  (src.match(new RegExp(`localStorage\\.(get|set)Item\\(\\s*["']${key}\\b`, 'g')) || []).length;

/* Each borrowed route -> the device-local keys its section is built on. */
const CAP = {
  products:  ['sellerProducts', 'sokoniStockAlerts'],
  receipts:  ['sokoniOrders'],
  team:      ['sokoniEmployees', 'sokoniEmployeeSession'],
  messages:  ['sokoniMessages', 'sokoniQA'],
  marketing: ['sokoniCampaigns', 'sokoniAds', 'sokoniPromoCodes', 'sokoniOffers'],
  flash:     ['sokoniFlashSales'],
  tax:       ['kraPinSaved', 'sokoniExpenses'],
  stories:   ['sokoniStories'],
  disputes:  ['sokoniDisputes', 'sokoniReturns'],
  customers: ['sokoniStoreFollowers', 'sokoniFollowNotifications'],
  store:     ['sokoniMiniStore', 'sokoniSellerVerification'],
};

const borrowed = C.ROUTES.filter(r => r.kind === 'seller');
line('  route        section     device-local keys (read+write in seller.js)        verdict');
line('  ' + '─'.repeat(88));
const verdicts = {};
for (const r of borrowed) {
  const keys = CAP[r.sec] || [];
  const counts = keys.map(k => `${k}:${keyCount(sellerJs, k)}`);
  const total = keys.reduce((n, k) => n + keyCount(sellerJs, k), 0);
  const verdict = total > 0 ? 'REBUILD' : 'EXTRACT';
  verdicts[r.sec] = { verdict, total, keys: counts };
  line('  ' + r.id.padEnd(12) + r.sec.padEnd(12) + (counts.join(' ') || '—').padEnd(50) + verdict);
}
line('');
const rebuild = Object.values(verdicts).filter(v => v.verdict === 'REBUILD').length;
line(`  ${rebuild} of ${borrowed.length} borrowed capabilities read their state from localStorage.`);

/* ── 2. The whole data surface, both sides ──────────────────────────────── */
line('\n══ 2. DATA SURFACE ══\n');

const lsKeys = (src) => {
  /* [^\S\n]* — spaces but never a newline, or the match runs past the call and
     yields a key like "localStorage.getItem(\nsellerProducts". */
  const m = src.match(/localStorage\.(getItem|setItem)\([^\S\n]*["'][a-zA-Z0-9_]+/g) || [];
  return [...new Set(m.map(x => x.replace(/.*["']/, '')))];
};
const fsColls = (src) => {
  const m = src.match(/(collection|doc)\([^,)]{0,40},\s*["'][a-zA-Z_]+["']/g) || [];
  return [...new Set(m.map(x => x.replace(/.*["']([a-zA-Z_]+)["']/, '$1')))];
};
const callables = (src) => {
  const m = src.match(/(sokoniCallable|httpsCallable)\([^)]{0,60}["'][a-zA-Z]+["']/g) || [];
  return [...new Set(m.map(x => x.replace(/.*["']([a-zA-Z]+)["']/, '$1')))];
};

for (const [name, src] of [['seller.js', sellerJs], ['seller.html', sellerHtml], ['merchant.html', merchantHtml]]) {
  const ls = lsKeys(src), coll = fsColls(src), cb = callables(src);
  line(`  ${name}`);
  line(`     localStorage keys ${String(ls.length).padStart(3)}   ${ls.slice(0, 8).join(', ')}${ls.length > 8 ? ' …' : ''}`);
  line(`     firestore colls   ${String(coll.length).padStart(3)}   ${coll.slice(0, 8).join(', ')}${coll.length > 8 ? ' …' : ''}`);
  line(`     callables         ${String(cb.length).padStart(3)}   ${cb.join(', ') || '—'}`);
  line('');
}

/* ── 3. Frozen authorities — baseline, and any client WRITER ────────────── */
line('══ 3. FROZEN AUTHORITY BASELINE (client-side) ══\n');

const CLIENT = [':!functions/*', ':!scripts/*', ':!docs/*', ':!CHANGELOG.md', ':!tests/*'];
const WRITE = /updateDoc|setDoc|addDoc|increment\(|\.set\(|\.update\(/;

/* Two kinds of pattern, and conflating them is how a census reassures wrongly:
   a NAME hit (`_decrementStock`) tells you the concept is present; only a
   WRITE-SHAPED hit (`stock: increment(...)`) tells you a client mutates the
   canonical field. A name hit reporting "0 of them WRITE" would read as "no
   writer exists" when the write is simply on the next line. */
const FROZEN_NAMES = [
  ['_decrementStock', 'client-side stock mutation (by name)'],
  ['totalUnitsSold', 'seller-keyed sales aggregate (by name)'],
  ['totalRevenue', 'revenue aggregate (by name)'],
];
const FROZEN_WRITES = [
  ['stock:\\s*[a-zA-Z_.]*increment', 'CLIENT WRITES products.stock'],
  ['sold:\\s*[a-zA-Z_.]*increment', 'CLIENT WRITES products.sold'],
  ['totalRevenue:\\s*[a-zA-Z_.]*increment', 'CLIENT WRITES totalRevenue'],
];

for (const [pat, what] of FROZEN_NAMES) {
  const hits = grep(pat, CLIENT);
  line(`  ${what}: ${hits.length} client reference(s)`);
  for (const h of hits.slice(0, 3)) line('       ' + h.split(':').slice(0, 2).join(':'));
}
line('');
for (const [pat, what] of FROZEN_WRITES) {
  const hits = grep(pat, CLIENT);
  line(`  ${what}: ${hits.length}`);
  for (const h of hits.slice(0, 4)) line('       WRITER → ' + h.split(':').slice(0, 2).join(':') + '   ' + h.split(':').slice(2).join(':').trim().slice(0, 70));
}
line('');
void WRITE;

/* ── 4. Deep links into seller.html ─────────────────────────────────────── */
line('══ 4. DEEP LINKS THAT MUST KEEP WORKING ══\n');
const deep = grep("seller\\.html[#?][a-zA-Z]", CLIENT.concat([':!seller.html', ':!seller.js']));
const targets = {};
for (const h of deep) {
  const m = h.match(/seller\.html([#?][a-zA-Z0-9=_&#-]*)/);
  if (m) targets[m[1]] = (targets[m[1]] || 0) + 1;
}
line(`  ${deep.length} deep link(s) across ${new Set(deep.map(h => h.split(':')[0])).size} file(s)`);
line('  ' + Object.entries(targets).sort((a, b) => b[1] - a[1]).slice(0, 12)
  .map(([t, n]) => `${t}(${n})`).join('  '));

/* ── 5. Mobile signals ──────────────────────────────────────────────────── */
line('\n══ 5. MOBILE SIGNALS (static) ══\n');
const mob = (name, src) => {
  const tables = (src.match(/<table/g) || []).length;
  const iframes = (src.match(/<iframe|createElement\('iframe'\)/g) || []).length;
  const viewport = /name="viewport"[^>]*width=device-width/.test(src);
  const bottomNav = /position:\s*fixed[^;]*;[^}]*bottom:\s*0|mbnav|bottom-nav/.test(src);
  const media = (src.match(/@media[^{]*max-width/g) || []).length;
  line(`  ${name.padEnd(16)} viewport:${viewport ? 'yes' : 'NO '}  tables:${String(tables).padStart(3)}  iframes:${String(iframes).padStart(2)}  bottom-nav:${bottomNav ? 'yes' : 'no '}  max-width queries:${media}`);
};
mob('merchant.html', merchantHtml);
mob('seller.html', sellerHtml);
mob('pos.html', R('pos.html'));
mob('checkout.html', R('checkout.html'));

line('');
if (problems) { line(`  census incomplete — ${problems} problem(s)\n`); process.exit(1); }
process.exit(0);
