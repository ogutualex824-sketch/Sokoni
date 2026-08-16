#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   STORE AUTHORITY CENSUS — Stage 1, read-only
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-store-authority.js
         node scripts/census-store-authority.js --md > docs/MERCHANT_STORE_AUTHORITY.md

   No UI changes. No repairs. No backfill. No deployment.

   Order: authority → ownership → scope → provenance → classification.

   The question every row answers is not "does it check something" but "does the
   server decide, or does the browser?" A shopId supplied by a browser is not
   authoritative until a shop document says so.

   NEGATIVE CONTROLS abort the run.
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

const MS = read('functions/minishop.js');
const SCHEMA = read('functions/minishop-config-schema.js');
const INDEX = read('functions/index.js');
const RULES = read('firestore.rules');

must('minishop.js readable', MS.length > 5000);
must('config schema readable', SCHEMA.length > 1000);
must('rules readable', RULES.length > 5000);
must('grep alternation works (-E)', grep('(claimMinishopHandle|followShop)').length > 0);
must('re-export detector true positive', /^exports\.followShop\b/m.test(INDEX));

const exported = (n) => new RegExp('^exports\\.' + n + '\\b', 'm').test(INDEX);

/* Each row was read from its body, not inferred. */
const ROWS = [
  { name: 'claimMinishopHandle',
    auth: '_requireAuth',
    merchantId: 'RESOLVED server-side: shops where sellerUid == uid, limit 1',
    clientShopId: 'not accepted at all',
    corroborates: 'yes — the shop query IS the ownership proof',
    verdict: 'SAFE',
    why: 'Takes only a handle. It never accepts a shopId, and it never creates a shop: if no shop names this uid the claim is refused with not-found. The reservation is a transaction, so two concurrent claims cannot both succeed, and a handle already held by another uid is already-exists. A handle held by this seller but pointing at a different shop is failed-precondition rather than silently repointed.' },

  { name: 'saveMinishopConfig',
    auth: '_requireAuth',
    merchantId: 'client-supplied shopId, then VERIFIED',
    clientShopId: 'verified by _assertShopOwner(shopId, uid)',
    corroborates: 'yes — shops/{shopId}.sellerUid must equal uid',
    verdict: 'SAFE',
    why: 'A client-supplied shopId that is verified against the shop document is not a trusted client scope — it is a lookup key. It also refuses PROTECTED_FIELDS, so config can never write ownership, financial identity, platform standing or server-maintained counters.' },

  { name: 'getMinishopAnalytics',
    auth: '_requireAuth',
    merchantId: 'client-supplied shopId, then VERIFIED',
    clientShopId: 'verified by _assertShopOwner',
    corroborates: 'yes',
    verdict: 'SAFE',
    why: 'Owner-asserted read. See the rules finding below: the client-SDK path to the same collection is dead, so this callable is the only way in — which is fine, but is a fact the surface must rely on rather than a fallback.' },

  { name: 'generateMinishopShareCard',
    auth: '_requireAuth',
    merchantId: 'client-supplied shopId, then VERIFIED',
    clientShopId: 'verified by _assertShopOwner',
    corroborates: 'yes',
    verdict: 'SAFE',
    why: 'Same pattern.' },

  { name: 'getMyMinishop',
    auth: '_requireAuth',
    merchantId: 'RESOLVED server-side: shops where sellerUid == uid',
    clientShopId: 'not accepted',
    corroborates: 'yes',
    verdict: 'SAFE',
    why: 'Self-scoped by construction; returns shopId: null for an account with no shop rather than guessing one.' },

  { name: 'followShop',
    auth: '_requireAuth',
    merchantId: 'n/a — a follow is a BUYER action',
    clientShopId: 'accepted, and verified to EXIST (not owned) inside the transaction',
    corroborates: 'the SHOP must exist (checked in-transaction); ownership is correctly not required',
    verdict: 'SAFE',
    why: 'Allowing non-owners is INTENTIONAL and right: following is what a shopper does, and the follow record is keyed shopFollowers/{shopId}_{uid} with uid from auth, so a caller can only ever create or remove their own. HARDENED in Stage 1B — the shop is now proved to exist inside the transaction before anything is written, and shopFollowers is CF-only in firestore.rules so the relationship cannot be changed outside this function. See below for what the two defects were.' },
];

/* ══ Report ═══════════════════════════════════════════════════════════════ */
line(MD ? '# Store Authority Census — Stage 1' : '\n══ STORE AUTHORITY CENSUS (Stage 1) ══');
if (MD) {
  line('');
  line('> Regenerate: `node scripts/census-store-authority.js --md > docs/MERCHANT_STORE_AUTHORITY.md`');
  line('> Read-only. No UI, no repairs, no backfill, no deployment.');
  line('');
  line('Handoff: [[MERCHANT_2D2_QUEUE]]. Companions: [[MERCHANT_2D2_AUTHORITY_CENSUS]] · [[MERCHANT_MARKETING_AUTHORITY]] · [[MERCHANT_CUSTOMERS_AUTHORITY]]');
  line('');
  line('## Per-capability');
  line('');
  line('| capability | exported | authenticates | merchant identity | client shopId | shop doc corroborates | verdict |');
  line('|---|---|---|---|---|---|---|');
  for (const r of ROWS) {
    line(`| \`${r.name}\` | ${exported(r.name) ? 'yes' : '**no**'} | ${r.auth} | ${r.merchantId} | ${r.clientShopId} | ${r.corroborates} | **${r.verdict}** |`);
  }
  line('');
  for (const r of ROWS) line(`- **\`${r.name}\`** — ${r.why}`);
} else {
  for (const r of ROWS) line('   ' + r.verdict.padEnd(22) + r.name.padEnd(28) + (exported(r.name) ? 'exported' : 'NOT exported'));
}

/* ══ The canonical identity question ══════════════════════════════════════ */
line(MD ? '\n## Is a browser-supplied `shopId` trusted anywhere?\n' : '\n-- client shopId --');
const assertOwner = MS.slice(MS.indexOf('async function _assertShopOwner'), MS.indexOf('async function _assertShopOwner') + 460);
must('_assertShopOwner located', assertOwner.length > 100);
const ownerField = /snap\.data\(\)\.sellerUid !== uid/.test(assertOwner) ? 'sellerUid' : 'unresolved';
if (MD) {
  line('**No.** Two shapes appear, and only one of them involves a client at all:');
  line('');
  line('1. **Resolved** — `claimMinishopHandle` and `getMyMinishop` never accept a `shopId`. They query');
  line('   `shops where sellerUid == uid` and use the document\'s own id. An account with no shop gets');
  line('   `not-found` / `shopId: null`, never a guess.');
  line('2. **Supplied then verified** — `saveMinishopConfig`, `getMinishopAnalytics` and');
  line('   `generateMinishopShareCard` accept a `shopId` and immediately call `_assertShopOwner`:');
  line('');
  line('```js');
  line('const snap = await _db().collection(\'shops\').doc(shopId).get();');
  line('if (!snap.exists) throw new HttpsError(\'not-found\', \'Shop not found.\');');
  line(`if (snap.data().${ownerField} !== uid) throw new HttpsError('permission-denied', 'You do not own this shop.');`);
  line('```');
  line('');
  line('A supplied id that must be proved against the shop document before use is a **lookup key**,');
  line('not a trusted scope. This is the pattern the Marketing and Customers censuses found missing');
  line('elsewhere, and here it is present.');
  line('');
  line('| scenario | outcome |');
  line('|---|---|');
  line('| SELLER_A → SHOP_B (theirs) | allowed |');
  line('| SELLER_A → SHOP_C (another seller\'s) | `permission-denied` |');
  line('| SELLER_A → a shopId that does not exist | `not-found` |');
  line('| an account with no shop, resolved path | `not-found` / `shopId: null` — no shop is created |');
} else {
  line('   resolved paths: claimMinishopHandle, getMyMinishop (query shops by sellerUid)');
  line('   verified paths: saveMinishopConfig, getMinishopAnalytics, generateMinishopShareCard (_assertShopOwner)');
  line('   ownership field used by _assertShopOwner: ' + ownerField);
}

/* ══ Ownership spellings — conflict or representation? ════════════════════ */
line(MD ? '\n## The three ownership spellings — asked, not assumed\n' : '\n-- ownership spellings --');
const spellings = {
  sellerUid: grep("sellerUid", 'functions/minishop.js').length,
  ownerId: grep("\\.ownerId", 'functions/').length,
  ownerUid: grep("ownerUid", 'functions/').length,
};
if (MD) {
  line('The instruction was not to "fix" these because they are ugly, but to establish whether each is');
  line('a legitimate writer-specific representation or a genuine authority conflict. Within the Store');
  line('domain the answer is clear, and it is **both**:');
  line('');
  line('### `sellerUid` — the Store domain\'s single, consistent authority');
  line('');
  line('Every Store path uses it: `_assertShopOwner`, `claimMinishopHandle`\'s resolve query,');
  line('`getMyMinishop`, `minishop-v3`\'s promotions. There is **no conflict inside Store** — it is one');
  line('field, used one way. Nothing needs changing here.');
  line('');
  line('### `ownerId` — a different domain\'s spelling, and a real functional consequence');
  line('');
  line('`analytics-engine`, `merchant-inventory`, `logistics-plus` and `finance-os` read `ownerId`.');
  line('That is not merely inconsistent naming: a shop document written by one of those subsystems');
  line('with `ownerId` and no `sellerUid` is **invisible to `claimMinishopHandle`**, whose resolve');
  line('query filters on `sellerUid` alone. The merchant is told *"No shop found for your account.');
  line('Please register as a seller first"* while owning a shop.');
  line('');
  line('So this one **is** an authority conflict, but it belongs to shop *provisioning*, not to Store.');
  line('Store is the place it becomes visible, not the place to fix it. Recorded for the shop-identity');
  line('convergence rather than patched here.');
  line('');
  line('### `ownerUid` — write-only in Store, and a dead rule elsewhere');
  line('');
  line('`claimMinishopHandle` writes `ownerUid` into `minishopConfig`, and nothing in Store reads it');
  line('back. Separately, `firestore.rules` gates `minishopAnalytics` reads on');
  line('`resource.data.ownerUid` — and a repo-wide search finds **no writer of that field on');
  line('`minishopAnalytics`**. The client-SDK read path is therefore dead; `getMinishopAnalytics`');
  line('works only because it uses the Admin SDK with `_assertShopOwner`.');
  line('');
  line('This is now the **fourth** instance of a rule gating on a field nothing writes —');
  line('`shopEmployees.sellerUid` (fixed), `disputes.sellerUid`, `posCustomers.sellerId` (fixed), and');
  line('now `minishopAnalytics.ownerUid`. Worth treating as a pattern rather than four coincidences.');
} else {
  line('   sellerUid: consistent within Store — no conflict');
  line('   ownerId:   other domains; a shop written with ownerId only is INVISIBLE to claimMinishopHandle');
  line('   ownerUid:  written into minishopConfig, read by nothing; minishopAnalytics rules gate on it and nothing writes it');
}

/* ══ followShop — the two problems beside the intended behaviour ══════════ */
line(MD ? '\n## `followShop` — what is intended, and what is not\n' : '\n-- followShop --');
const followBody = MS.slice(MS.indexOf('exports.followShop'), MS.indexOf('exports.followShop') + 2000);
const noExistCheck = !/collection\('shops'\)\.doc\(shopId\)/.test(followBody) && !/_assertShop/.test(followBody);
const rulesDelete = /match \/shopFollowers\/\{docId\}[\s\S]{0,240}allow delete: if isAuthed\(\) && resource\.data\.uid == request\.auth\.uid/.test(RULES);
const protectsCounter = /'totalProducts', 'followerCount'/.test(SCHEMA);
must('followShop body located', followBody.length > 500);

if (MD) {
  line('> **Status: hardened in Stage 1B.** Both problems below are closed — the shop is proved to');
  line('> exist inside the transaction, and `shopFollowers` is CF-only in the rules. Kept here because');
  line('> the reasoning is what makes the fix reviewable.');
  line('');
  line('**Intended, and correct:** a non-owner may follow. Following is a shopper\'s action, and the');
  line('record is keyed `shopFollowers/{shopId}_{uid}` with `uid` taken from auth — so a caller can');
  line('only ever create or remove their own follow. That part needs no change.');
  line('');
  line('**Problem 1 — the shop is never proved to exist.** `followShop` accepts any `shopId` string');
  line(`and writes \`minishopConfig/{shopId}\` with \`{ merge: true }\`${noExistCheck ? ' — and the body contains no shop existence check' : ''}. A merge write to a missing document *creates* it, so any authenticated caller can`);
  line('create arbitrary publicly-readable `minishopConfig` documents carrying a `followerCount`.');
  line('');
  line('**Problem 2 — the counter can be desynchronised, and inflated without limit.** These two facts');
  line('sit in different files and are harmless apart:');
  line('');
  line(`- \`followShop\` decides idempotency by reading the follow document: \`const alreadyFollowing = followerSnap.exists\`, and only increments when it is absent.`);
  line(`- \`firestore.rules\` lets the client delete that same document directly: ${rulesDelete ? '`allow delete: if isAuthed() && resource.data.uid == request.auth.uid;`' : '(delete rule not matched — re-check)'}`);
  line('');
  line('Together they form a loop a single account can run repeatedly:');
  line('');
  line('```');
  line('followShop({shopId, follow:true})   → followerCount + 1, follow doc created');
  line('client deleteDoc(shopFollowers/…)   → follow doc gone, counter NOT decremented');
  line('followShop({shopId, follow:true})   → "not already following" → followerCount + 1 again');
  line('```');
  line('');
  line('`followerCount` is displayed as a business figure, so this is a fabricated-metric path as well');
  line('as a data-integrity one — and it works against **any** shop, not only the caller\'s own.');
  line('');
  line(`Worth noting what is already right: \`followerCount\` **is** protected from the config writer${protectsCounter ? ' — `PROTECTED_FIELDS` lists it as a server-maintained counter, so `saveMinishopConfig` cannot set it' : ''}. The counter is guarded against the owner and left open to the follower path.`);
} else {
  line('   non-owner follow: INTENDED (buyer action), record keyed {shopId}_{uid} from auth');
  line('   no shop existence check: ' + (noExistCheck ? 'CONFIRMED — merge write can create minishopConfig/{anything}' : 'a check appears present — re-read'));
  line('   client may delete the follow doc directly: ' + (rulesDelete ? 'YES — counter desync / unbounded inflation loop' : 'rule not matched'));
  line('   followerCount protected from saveMinishopConfig: ' + (protectsCounter ? 'yes' : 'NO'));
}

/* ══ Provenance of the state claimMinishopHandle writes ═══════════════════ */
line(MD ? '\n## What `claimMinishopHandle` writes, and who can change it after\n' : '\n-- provenance --');
if (MD) {
  line('| document | written | read | client write |');
  line('|---|---|---|---|');
  line('| `shopHandles/{handle}` | `{shopId, uid, handle, createdAt}` | `allow read: if true` (public — storefront resolution) | **none** — no rule permits it |');
  line('| `minishopConfig/{shopId}` | `{handle, shopId, ownerUid, updatedAt}` merged | `allow read: if true` (public storefront) | **none** directly; `saveMinishopConfig` writes it under `_assertShopOwner` and cannot touch `PROTECTED_FIELDS` |');
  line('');
  line('Both are CF-only for writes, which is the right shape. The one caveat is the one above:');
  line('`followShop` also merges into `minishopConfig`, and it is the only path that writes there');
  line('without proving anything about the shop.');
} else {
  line('   shopHandles/{handle}   CF-only write, public read');
  line('   minishopConfig/{shopId} CF-only write, public read; followShop also merges into it');
}

/* ══ Classification ══════════════════════════════════════════════════════ */
line(MD ? '\n## Classification\n' : '\n-- classification --');
const byVerdict = {};
for (const r of ROWS) (byVerdict[r.verdict] = byVerdict[r.verdict] || []).push(r.name);
if (MD) {
  line('| classification | capabilities |');
  line('|---|---|');
  for (const v of ['SAFE', 'SAFE AFTER HARDENING', 'CLIENT-SCOPE / UNSAFE', 'BLOCKED', 'NEW AUTHORITY REQUIRED']) {
    line(`| **${v}** | ${(byVerdict[v] || []).map((n) => '`' + n + '`').join(', ') || '—'} |`);
  }
  line('');
  line('### What Stage 2 may build on');
  line('');
  line('Storefront identity (`getMyMinishop`, `claimMinishopHandle`), configuration');
  line('(`saveMinishopConfig`), analytics (`getMinishopAnalytics`) and the share card — all five are');
  line('server-decided and need nothing first. That is a coherent Store surface on its own.');
  line('');
  line('### What must not go in yet');
  line('');
  line('- **A follower count**, until the desync loop is closed. Showing a figure a single account can');
  line('  inflate without limit is the fabricated-metric rule, not a cosmetic concern.');
  line('- **Anything that assumes a shop exists because `minishopConfig/{shopId}` does** — that');
  line('  document can be created by `followShop` for a shopId nobody owns.');
  line('');
  line('### Recorded for other stages, not fixed here');
  line('');
  line('- `ownerId`-only shop documents are invisible to `claimMinishopHandle` → shop-identity');
  line('  convergence, not Store.');
  line('- `minishopAnalytics` rules gate on `ownerUid`, which nothing writes → the fourth instance of');
  line('  that pattern.');
} else {
  for (const v of Object.keys(byVerdict)) line('   ' + v + ': ' + byVerdict[v].join(', '));
}

if (hardFail) { console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.'); process.exit(1); }
console.log(out.join('\n'));
