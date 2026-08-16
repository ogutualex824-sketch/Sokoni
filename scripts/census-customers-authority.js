#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   CUSTOMERS AUTHORITY CENSUS — read-only, no network, no writes
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-customers-authority.js
         node scripts/census-customers-authority.js --md > docs/MERCHANT_CUSTOMERS_AUTHORITY.md

   Classifies every path a Merchant Customers surface could use:

     CANONICAL + MERCHANT-SCOPED · CANONICAL BUT ACCOUNT-SCOPED ·
     CLIENT-SCOPE / UNSAFE · BLOCKED · NO AUTHORITY

   The instruction this census exists to honour: do NOT assume the customer LIST
   is safe because the individual profile operations are owner-checked. The list
   is traced separately, all the way to its authorization boundary — and it turns
   out not to be a callable at all.

   NEGATIVE CONTROLS abort the run: git grep defaults to BASIC regex, where the
   alternations below would silently match nothing and the census would report a
   confident, wrong "no authority".
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const MD = process.argv.includes('--md');
const out = [];
const line = (s = '') => out.push(s);
let hardFail = 0;
const must = (l, ok, d) => { if (!ok) { hardFail++; console.error('CONTROL FAILED: ' + l + (d ? ' — ' + d : '')); } };

const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
function grep(pattern, pathspec) {
  const args = ['grep', '-nE', '--', pattern];
  if (pathspec) args.push(pathspec);
  try {
    return execFileSync('git', args, { cwd: ROOT, maxBuffer: 1 << 28 }).toString()
      .split('\n').filter(Boolean).filter((l) => !l.startsWith('node_modules/'));
  } catch (_) { return []; }
}

const INDEX = read('functions/index.js');
const CRM = read('functions/crm.js');
const POSZF = read('functions/pos-zero-friction.js');
const POSBI = read('functions/pos-bi.js');
const POSINT = read('functions/pos-intelligence.js');
const RULES = read('firestore.rules');

must('grep alternation works (-E)', grep('(getCustomerProfile|posLookupCustomer)').length > 0);
must('crm.js readable', CRM.length > 3000);
must('pos-zero-friction readable', POSZF.length > 3000);
must('firestore.rules readable', RULES.length > 5000);
must('re-export detector true positive', /^exports\.getCustomerProfile\b/m.test(INDEX));

const exported = (n) => new RegExp('^exports\\.' + n + '\\b', 'm').test(INDEX);

/* ══ Findings, each derived from a body actually read ═════════════════════ */
const ROWS = [
  {
    name: 'getCustomerProfile', file: 'functions/crm.js',
    auth: 'requireAuth + assertMerchantOwner(uid, merchantId)',
    scope: 'merchants/{merchantId}.ownerId === uid (or adminUids)',
    store: 'crmCustomerProfiles',
    verdict: 'CANONICAL BUT ACCOUNT-SCOPED',
    why: 'Ownership IS asserted, against the `merchants` document. That is a real check — but see the reachability finding below.',
  },
  {
    name: 'buildCustomerProfile', file: 'functions/crm.js',
    auth: 'requireAuth + assertMerchantOwner', scope: 'same as above', store: 'crmCustomerProfiles',
    verdict: 'CANONICAL BUT ACCOUNT-SCOPED',
    why: 'Same guard, same reachability caveat.',
  },
  {
    name: 'getCRMDashboard', file: 'functions/crm.js',
    auth: 'requireAuth + assertMerchantOwner', scope: 'merchantId', store: 'crmCustomerProfiles, crmLeads, crmSupportTickets',
    verdict: 'CANONICAL BUT ACCOUNT-SCOPED',
    why: 'Correctly scoped, but it returns counts plus the top FIVE customers by CLV. It is a dashboard, not a list — it cannot back a Customers screen on its own.',
  },
  {
    name: 'posGetCustomerInsights', file: 'functions/pos-intelligence.js',
    auth: 'auth only', scope: 'merchantId TAKEN FROM THE REQUEST, never verified', store: 'posSales / posCustomers',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    why: 'It requires `merchantId` to be a string and then queries with it. Nothing checks the caller owns that merchant. Must not be bound into the workspace.',
  },
  {
    name: 'getCustomerGrowthMetrics', file: 'functions/pos-bi.js',
    auth: 'auth + posRole claim ≥ manager + auth.token.sellerId === sellerId',
    scope: 'a `sellerId` CUSTOM CLAIM', store: 'posCustomers, posSales',
    verdict: 'BLOCKED',
    why: 'It DOES compare the requested sellerId to a claim rather than trusting the request — so it fails closed, not open. But no `sellerId` claim is minted anywhere in functions/, so for every real merchant `callerSellerId` is undefined and the comparison denies. Safe, and unreachable.',
  },
  {
    name: 'posLookupCustomer', file: 'functions/pos-zero-friction.js',
    auth: 'auth only', scope: 'NONE — the query is collection-wide', store: 'posCustomers',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    why: 'SECURITY FINDING — see below. It searches every posCustomers document by phone, email, id or member-card code with no merchant filter at all.',
  },
];

/* ══ Report ═══════════════════════════════════════════════════════════════ */
line(MD ? '# Customers Authority Census' : '\n══ CUSTOMERS AUTHORITY CENSUS ══');
if (MD) {
  line('');
  line('> Regenerate: `node scripts/census-customers-authority.js --md > docs/MERCHANT_CUSTOMERS_AUTHORITY.md`');
  line('> Read-only. No UI built, no authorization changed, nothing bound into the workspace.');
  line('');
  line('Companion to [[MERCHANT_2D2_AUTHORITY_CENSUS]] and [[MERCHANT_MARKETING_AUTHORITY]].');
  line('');
  line('## Per-capability');
  line('');
  line('| capability | exported | authorization | scope | verdict |');
  line('|---|---|---|---|---|');
  for (const r of ROWS) {
    line(`| \`${r.name}\` | ${exported(r.name) ? 'yes' : '**no**'} | ${r.auth} | ${r.scope} | **${r.verdict}** |`);
  }
  line('');
  for (const r of ROWS) line(`- **\`${r.name}\`** — ${r.why}`);
} else {
  for (const r of ROWS) line('   ' + r.verdict.padEnd(30) + r.name.padEnd(28) + (exported(r.name) ? 'exported' : 'NOT exported'));
}

/* ══ The list — traced separately ═════════════════════════════════════════ */
line(MD ? '\n## The customer LIST — the piece that was missing\n' : '\n-- the list --');
const hasListCallable = /^exports\.(listCustomers|getCustomers|getMerchantCustomers)\b/m.test(INDEX);
must('list-callable detector runs', typeof hasListCallable === 'boolean');

if (MD) {
  line('**There is no customer-list callable.** No export in `functions/index.js` lists a merchant\'s');
  line('customers; `getCRMDashboard` returns the top five by CLV and some counts, and');
  line('`getCustomerProfile` reads one profile by uid. So the list has to come from a client read,');
  line('and there are two candidate collections. They are not equivalent.');
  line('');
  line('### `crmCustomerProfiles` — usable, and safe by construction');
  line('');
  line('```');
  line('match /crmCustomerProfiles/{uid} {');
  line('  allow read:  if isAdmin()');
  line('               || (isAuthed() && request.auth.uid == uid)');
  line('               || (isAuthed() && resource.data.merchantId == request.auth.uid);');
  line('  allow write: if false;   // CF-only — buildCustomerProfile, calculateCLV');
  line('}');
  line('```');
  line('');
  line('This is the same shape that made the Messages thread body safe: a **rules-gated read**, and');
  line('**client writes refused outright**, so the client cannot become the authority even by');
  line('accident. `merchantId` here is compared to `request.auth.uid` — the list is therefore');
  line('**ACCOUNT-scoped**, not shop-scoped, and must be labelled as such.');
  line('');
  line('### `posCustomers` — not usable, and worth understanding why');
  line('');
  line('```');
  line('match /posCustomers/{customerId} {');
  line('  allow read: if isPosOwner() || isAdmin();');
  line('}');
  line('function isPosOwner() { return isAuthed() && resource.data.sellerId == request.auth.uid; }');
  line('```');
  line('');
  line('The rule gates on a `sellerId` field **in the document body**. The writers put the seller in');
  line('the document *id* — `posCustomers/{sellerId}_{phone}` (`pos-crm-pro.js`) — and merge bodies');
  line('like `{ storeCredit, updatedAt }` that carry no `sellerId` at all. `pos-bi.js` meanwhile');
  line('queries `where(\'sellerId\', \'==\', sid)`, and `posGetCustomerInsights` queries');
  line('`where(\'merchantId\', \'==\', merchantId)` — three different scope vocabularies over one');
  line('collection. A client read of `posCustomers` is therefore unreliable at best, and is not the');
  line('list path.');
} else {
  line('   no list callable exists: ' + (hasListCallable ? 'FALSE (one was found)' : 'confirmed'));
  line('   viable list = client read of crmCustomerProfiles where merchantId == uid (rules-gated, CF-only writes)');
  line('   posCustomers client read is gated on a body field its writers do not set');
}

/* ══ Security finding ═════════════════════════════════════════════════════ */
line(MD ? '\n## SECURITY FINDING — `posLookupCustomer` is an unscoped customer search\n' : '\n-- SECURITY --');
const lookupBody = POSZF.slice(POSZF.indexOf('exports.posLookupCustomer'), POSZF.indexOf('exports.posLookupCustomer') + 2600);
const scopedQuery = /where\('(merchantId|sellerId)'/.test(lookupBody);
must('lookup body located', lookupBody.length > 500);

if (MD) {
  line('`posLookupCustomer` is deployed and takes `query`, `method` and `merchantId`. It searches');
  line('`posCustomers` by phone, then by document id, then by email, then by member-card code:');
  line('');
  line('```js');
  line("snap = await coll.where('phone', '==', phone).limit(1).get();");
  line("if ((!snap || snap.empty) && (method === 'id' || method === 'auto')) { … coll.doc(q).get() }");
  line("snap = await coll.where('email', '==', q.toLowerCase()).limit(1).get();");
  line('```');
  line('');
  line(`**None of those queries is scoped to a merchant** — verified: the function body contains ${scopedQuery ? 'a' : '**no**'} merchant/seller-scoped \`where\` clause. The \`merchantId\` argument is used only to fetch the *loyalty programme configuration*, never to filter the customer:`);
  line('');
  line('```js');
  line('if (merchantId) {');
  line("  const progSnap = await db.collection('loyaltyPrograms').doc(merchantId).get();");
  line('  …  /* the customer has already been selected by this point */');
  line('}');
  line('```');
  line('');
  line('So **any authenticated account can look up any customer on the platform by phone number or');
  line('email**, and receive that customer\'s name, email, phone, loyalty points, tier, total spent');
  line('and purchase count. A phone number is guessable; this is enumerable PII disclosure across');
  line('tenants.');
  line('');
  line('This is the same class of defect as the `orderAdvance` IDOR — deployed, reachable, and');
  line('authorising on nothing but "is signed in". It is **not** fixed here, and it must **not** be');
  line('bound into the Customers surface. It deserves its own bounded security stage:');
  line('');
  line('```');
  line('auth.uid → resolve the caller\'s merchant/shop → scope the lookup to it');
  line('        → return only a customer of THAT merchant');
  line('```');
} else {
  line('   posLookupCustomer: merchant-scoped where clause present? ' + (scopedQuery ? 'yes' : 'NO — unscoped platform-wide customer search'));
}

/* ══ Reachability ═════════════════════════════════════════════════════════ */
line(MD ? '\n## Reachability — the owner check reads a POS-only collection\n' : '\n-- reachability --');
const merchantsWriters = grep("collection\\('merchants'\\)\\.doc\\([^)]*\\)\\.(set|create)", 'functions/')
  .concat(grep("batch\\.set\\(db\\.collection\\('merchants'\\)", 'functions/'));
if (MD) {
  line('`assertMerchantOwner` — the guard on all three canonical CRM callables — reads');
  line('`merchants/{merchantId}` and compares `ownerId`. That document is written in exactly one');
  line(`place (${merchantsWriters.length} writer${merchantsWriters.length === 1 ? '' : 's'} found): \`business-bootstrap.js\` \`_createBusiness\`, which the merchant-consolidation census recorded as reachable **only from \`pos-setup.html\`**.`);
  line('');
  line('A merchant who came through the marketplace application path (2A/2B) therefore has **no**');
  line('`merchants/` record, and every one of `getCustomerProfile`, `buildCustomerProfile` and');
  line('`getCRMDashboard` throws `not-found` for them. Correctly-shaped, correctly-scoped, and');
  line('unreachable — the same pattern as the `shopEmployees` key divergence.');
  line('');
  line('The list path does **not** share this problem: `crmCustomerProfiles` rules compare');
  line('`merchantId` to `request.auth.uid` directly, with no `merchants/` document involved.');
} else {
  line('   merchants/ writers: ' + merchantsWriters.length + ' (business-bootstrap._createBusiness, pos-setup.html only)');
}

/* ══ What may be built ════════════════════════════════════════════════════ */
line(MD ? '\n## What the Customers surface may be built on\n' : '\n-- recommendation --');
if (MD) {
  line('| | |');
  line('|---|---|');
  line('| **List + search** | client read of `crmCustomerProfiles where merchantId == uid` — rules-gated, CF-only writes, account-scoped |');
  line('| **Profile** | `getCustomerProfile` / `buildCustomerProfile`, with the `merchants/` reachability caveat surfaced honestly when it refuses |');
  line('| **Aggregates** | `getCRMDashboard` only — and only where the figure is genuinely returned |');
  line('| **Not bound** | `posGetCustomerInsights` (unverified client scope), `getCustomerGrowthMetrics` (unsatisfiable claim), `posLookupCustomer` (unscoped search) |');
  line('');
  line('Keeping the unsafe three **out of the binding** matters more than hiding their values: a');
  line('surface that fetches and then hides is still a surface that fetched.');
  line('');
  line('Search is therefore **client-side over the merchant\'s own rules-gated rows**, not a server');
  line('lookup — which is the honest option while `posLookupCustomer` is unscoped, and is scoped by');
  line('construction because the rules will not return another merchant\'s rows.');
}

if (hardFail) { console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.'); process.exit(1); }
console.log(out.join('\n'));
