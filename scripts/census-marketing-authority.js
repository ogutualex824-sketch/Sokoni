#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   MARKETING AUTHORITY CENSUS — read-only, no network, no writes
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-marketing-authority.js
         node scripts/census-marketing-authority.js --md > docs/MERCHANT_MARKETING_AUTHORITY.md

   Answers the three questions the 2D-2 census left open for Marketing, from the
   FUNCTION BODIES rather than from names or from the behaviour of siblings:

     1. the four Minishop functions — auth → owner → shop scope → mutation → data
     2. createAdCampaign — is its sellerUid scope intentional or now a defect?
     3. the eleven un-re-exported marketing-engine callables — can any be exposed?

   Nothing is exported, no authorization is changed, and no UI is built. The
   output is a classification per capability:

     SAFE · SAFE AFTER AUTH HARDENING · SHOP-SCOPE DECISION REQUIRED ·
     BLOCKED · NO SERVER AUTHORITY

   METHOD
   Each callable is located, its body bounded by delimiter matching (a fixed
   character window runs into the next function and mislabels it), and the guard
   read from that body. The screen→candidate mapping is reviewed; every fact
   applied to it is mechanical, so re-running after a code change re-derives it.

   NEGATIVE CONTROLS: `git grep` defaults to BASIC regex, where `(`, `|` and `?`
   are literals. Without -E every alternation silently matches nothing and the
   census reports a confident, wrong "no authority". Controls abort the run.
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
const MKT = read('functions/marketing-engine.js');
const MSC = read('functions/minishop-campaigns.js');

must('grep alternation works (-E)', grep('(createFlashSale|createAdCampaign)').length > 0, 'matched nothing');
must('index.js readable', INDEX.length > 10000);
must('marketing-engine readable', MKT.length > 5000);
must('minishop-campaigns readable', MSC.length > 1000);
must('re-export detector true positive', /^exports\.createAdCampaign\b/m.test(INDEX));
must('re-export detector true negative', !/^exports\.createFlashSale\b/m.test(INDEX));

/* Bound the body by matching delimiters from the definition. */
function bodyAt(src, lineNo) {
  const lines = src.split('\n');
  const start = lines.slice(0, lineNo - 1).join('\n').length;
  let i = src.indexOf('(', start);
  if (i < 0) return src.slice(start, start + 1500);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '(') depth++;
    else if (src[j] === ')') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return src.slice(start, start + 5000);
}

function locate(name) {
  const hits = grep(`^exports\\.${name} = onCall|^const ${name} = onCall|^const ${name} = onSchedule|^exports\\.${name} = onRequest`, 'functions/');
  if (!hits.length) return null;
  const [file, ln] = hits[0].split(':');
  return { file, line: Number(ln) };
}

/* TWO different ownership rules live in this code, and collapsing them into one
   "ownership: yes" is exactly the inference this census exists to avoid.

     SHOP ownership     the shops/{shopId} document decides
     CREATOR ownership  the target document's own `uid` field decides

   For a single-owner shop they coincide, which is why the difference survives
   unnoticed. They separate the moment a shop changes hands. */
const SHOP_OWNERSHIP = /_assertShopOwner|assertShopOwner|assertMerchantOwner|assertShopAccess|sellerUid !== uid|sellerUid\s*!==\s*request\.auth\.uid|shopSnap\.data\(\)\.sellerUid/;
const CREATOR_OWNERSHIP = /docSnap\.data\(\)\.uid !== uid|\.data\(\)\.uid\s*!==\s*uid/;
const AUTH = /_requireAuth|_requireMerchant|unauthenticated|if \(!request\.auth\)|if \(!req\.auth\)/;
const NUMERIC_GATE = /_requireMerchant\(/;
const CLIENT_MERCHANT_ID = /\bmerchantId\b|\bshopId\b/;

function facts(name) {
  const def = locate(name);
  const exported = new RegExp('^exports\\.' + name + '\\b', 'm').test(INDEX);
  if (!def) return { name, exported, found: false };
  const body = bodyAt(read(def.file), def.line);
  const colls = [...new Set((body.match(/collection\(['"][a-zA-Z]+['"]\)/g) || [])
    .map((c) => c.replace(/collection\(['"]/, '').replace(/['"]\)/, '')))];
  return {
    name, exported, found: true, file: def.file, line: def.line,
    auth: AUTH.test(body),
    shopOwnership: SHOP_OWNERSHIP.test(body),
    creatorOwnership: CREATOR_OWNERSHIP.test(body),
    numericGate: NUMERIC_GATE.test(body),
    clientScope: CLIENT_MERCHANT_ID.test(body),
    hardDelete: /\.delete\(\)/.test(body),
    httpsError: /HttpsError/.test(body),
    collections: colls,
  };
}

/* ══ The capabilities under review ═══════════════════════════════════════ */
/* `publicRead` marks a deliberately unauthenticated read — a storefront surface a
   shopper must be able to see. DECLARED, not inferred: without it the classifier
   reports a designed public endpoint as missing authentication, which is how
   verifyTrustReceipt was briefly promoted to an ownership authority in the 2D-2
   census. */
const MINISHOP = [
  { name: 'createMinishopCampaign' },
  { name: 'getMinishopCampaigns' },
  { name: 'deleteMinishopCampaign' },
  { name: 'pauseMinishopCampaign' },
  { name: 'miniShopCreatePromotion' },
  { name: 'miniShopGetPromotions', publicRead: true,
    note: 'storefront read — active, unexpired promotions only, App Check enforced' },
  { name: 'miniShopUpdatePromotion' },
];
const ENGINE = ['createBundleDeal', 'getActiveBundleDeals', 'createFlashSale', 'getFlashSalePrice',
  'recordFlashSalePurchase', 'getCrossSellRecommendations', 'getUpsellRecommendations',
  'createMarketingCampaign', 'runABTest', 'recordABTestImpression', 'applyCouponCode']
  .map(function (name) { return { name: name }; });

function classify(f, meta) {
  meta = meta || {};
  if (!f.found) return ['NO SERVER AUTHORITY', 'no definition found'];
  if (!f.exported) {
    if (f.numericGate) return ['BLOCKED', 'not re-exported AND gated on the numeric role claim'];
    return ['BLOCKED', 'not re-exported in functions/index.js — unreachable at runtime'];
  }
  if (f.numericGate) return ['BLOCKED', 'gated on the numeric role claim, which inverts for string claims'];
  if (meta.publicRead) return ['SAFE', 'deliberately public storefront read — ' + (meta.note || 'no auth by design')];
  if (!f.auth) return ['SAFE AFTER AUTH HARDENING', 'no authentication check in the body'];
  /* SHOP ownership is the merchant model. CREATOR ownership answers a different
     question — "did you make this?" — in place of "is this yours?". It is not a
     weaker version of the same check, and treating it as one is precisely the
     inference this census exists to prevent. */
  if (f.shopOwnership) return ['SAFE', 'authenticated and SHOP-ownership asserted'];
  if (f.creatorOwnership) return ['SAFE AFTER AUTH HARDENING',
    'authorises against the document CREATOR (uid), not the shop — a transferred shop leaves its own campaigns unmanageable' +
    (f.hardDelete ? ', and it hard-deletes the record together with its analytics history' : '')];
  if (f.clientScope) return ['SAFE AFTER AUTH HARDENING', 'accepts a client-supplied scope id without asserting ownership'];
  return ['SHOP-SCOPE DECISION REQUIRED', 'authenticated and self-scoped, but not scoped to a shop'];
}

/* ══ Report ═══════════════════════════════════════════════════════════════ */
line(MD ? '# Marketing Authority Census' : '\n══ MARKETING AUTHORITY CENSUS ══');
if (MD) {
  line('');
  line('> Regenerate: `node scripts/census-marketing-authority.js --md > docs/MERCHANT_MARKETING_AUTHORITY.md`');
  line('> Read-only. No exports added, no authorization changed, no UI built.');
  line('');
  line('Companion to [[MERCHANT_2D2_AUTHORITY_CENSUS]]. Resolves the three questions that census left open for Marketing.');
}

function section(title, names, extra) {
  line(MD ? `\n## ${title}\n` : `\n── ${title} ──`);
  if (MD) {
    line('| callable | exported | auth | ownership | client scope | collections | verdict |');
    line('|---|---|---|---|---|---|---|');
  }
  const rows = [];
  for (const item of names) {
    const meta = (typeof item === 'string') ? { name: item } : item;
    const n = meta.name;
    const f = facts(n);
    const [v, why] = classify(f, meta);
    rows.push({ f, v, why, meta });
    const own = !f.found ? '—' : f.shopOwnership ? 'shop' : f.creatorOwnership ? '**creator**' : '**none**';
    const authCell = !f.found ? '—' : (f.auth ? 'yes' : (meta.publicRead ? 'public (by design)' : '**no**'));
    if (MD) {
      line(`| \`${n}\` | ${f.exported ? 'yes' : '**no**'} | ${authCell} | ${own} | ` +
        `${f.found ? (f.clientScope ? 'yes' : 'no') : '—'} | ` +
        `${f.collections ? f.collections.map((c) => '`' + c + '`').join(' ') : '—'} | **${v}** |`);
    } else {
      line(`   ${v.padEnd(30)} ${n.padEnd(28)} exp:${f.exported ? 'y' : 'N'} auth:${f.auth ? 'y' : (meta.publicRead ? 'pub' : 'N')} own:${f.shopOwnership ? 'shop' : f.creatorOwnership ? 'CREATOR' : 'none'}`);
    }
  }
  if (MD && extra) { line(''); extra(rows); }
  return rows;
}

const msRows = section('1 — The four Minishop functions', MINISHOP, () => {
  line('### The divergence inside one module');
  line('');
  line('`createMinishopCampaign` and `getMinishopCampaigns` authorise against the **shop**:');
  line('`shops/{shopId}.sellerUid !== uid` → denied. `deleteMinishopCampaign` and');
  line('`pauseMinishopCampaign` authorise against the **campaign document\'s creator**:');
  line('`minishopCampaigns/{id}.uid !== uid` → denied. They are not the same rule.');
  line('');
  line('For a single-owner shop the two coincide, which is why the difference is invisible in');
  line('normal use. They separate when ownership moves: a shop transferred to a new owner leaves');
  line('every existing campaign undeletable and unpausable by the person who now owns the shop —');
  line('their shop, their campaigns, permanently locked. Nothing repairs this, because no path');
  line('rewrites `campaign.uid`.');
  line('');
  line('**`deleteMinishopCampaign` is also a hard delete** (`.delete()`), destroying the campaign\'s');
  line('click, view, order and revenue history with it. `pauseMinishopCampaign` already provides the');
  line('reversible action, so the destructive one is the odd path, not the necessary one.');
  line('');
  line('**The correct pattern already exists one module away.** `miniShopUpdatePromotion` handles the');
  line('same shape — mutate a document reached by its own id — by reading the document first and then');
  line('asserting on the shop it names:');
  line('');
  line('```js');
  line('const promoData = promoSnap.data();');
  line('await _assertShopOwner(promoData.shopId, uid);   // the SHOP decides');
  line('```');
  line('');
  line('`deleteMinishopCampaign` and `pauseMinishopCampaign` reach the same point and then ask a');
  line('different question (`docSnap.data().uid !== uid`). Hardening them is not new design work; it');
  line('is applying the rule their sibling already uses.');
  line('');
  line('### The metric integrity problem behind the whole screen');
  line('');
  line('`trackCampaignClick` is an **`onRequest` with no authentication at all**. It takes');
  line('`campaignId`, `shopId` and `event` from the request body and increments');
  line('`clicks` / `views` / **`orders`** on the campaign, rate-limited to 10 per IP per campaign');
  line('per hour. `getMinishopCampaigns` then returns those counters and derives `roi` from');
  line('`orders / clicks`.');
  line('');
  line('So every number a Marketing screen would show for a campaign — including orders and ROI —');
  line('originates from an endpoint any anonymous caller can drive. Under the standing rule that no');
  line('UI component may fabricate a business metric, these cannot be presented as order counts or');
  line('return on investment. They are traffic counters with a spam floor.');
  line('');
  line('### Error shape');
  line('');
  line('`minishop-campaigns.js` throws bare `Error`, not `HttpsError` — so every refusal reaches the');
  line('client as `internal` with the message attached, and a caller cannot distinguish');
  line('"not your shop" from a genuine server fault by code. `minishop-v3.js` uses `HttpsError`');
  line('correctly. A Marketing UI must therefore read messages, not codes, for the campaign half.');
});

section('2 — createAdCampaign scope', [{ name: 'createAdCampaign' }], () => {
  line('The canonical merchant model established across 2D-1 and 2D-2 is:');
  line('');
  line('```');
  line('auth.uid → sellerUid → activeShopId → shops/{shopId}');
  line('```');
  line('');
  line('`createAdCampaign` writes `sokoAds` with `sellerUid: uid` and **no `shopId` at all**. Every');
  line('reader agrees: `functions/index.js:4806` and `sokoni-featured.js:54` both query `sokoAds`');
  line('by `status == "active"` only. A repo-wide search finds **no shop scoping on `sokoAds`');
  line('anywhere** — not in the writer, not in either reader.');
  line('');
  line('So the account-level scope is **consistent**, not an oversight in one place. What has changed');
  line('is the surrounding model: a merchant may now own more than one shop, and an ad created in the');
  line('Marketing screen of Shop B would be indistinguishable from one created for Shop C.');
  line('');
  line('**This is recorded as a decision, not silently broadened.** Adding `shopId` to the write');
  line('without changing the readers would produce a field nothing honours — the appearance of shop');
  line('scoping with none of the behaviour, which is worse than the honest account-level scope that');
  line('exists now. The options are:');
  line('');
  line('- **A. Keep account scope.** Marketing → Ads is a seller-level surface, labelled as such, and');
  line('  shown identically from every shop the account owns. No code changes.');
  line('- **B. Introduce shop scope properly.** Writer records `shopId`, both readers filter by it,');
  line('  and existing `sokoAds` rows need a backfill decision. A real piece of work, not a field.');
  line('');
  line('Until that is decided, Marketing must not present Ads as belonging to the active shop.');
  line('');
  line('Two smaller findings in the same body: `budgetKES` is accepted with only a truthiness check —');
  line('no minimum, no maximum, and `Number(budgetKES)` will happily store a negative. It is written');
  line('`status: "pending_review"` with `spentKES: 0`, so no money moves at creation and an admin gate');
  line('stands between it and spend; the validation gap is real but not a payment hole.');
});

const engRows = section('3 — The eleven marketing-engine callables', ENGINE, () => {
  line('### None of them verifies the merchant it is told about');
  line('');
  line('Every one of these takes `merchantId` **from the request** and uses it to read or write.');
  line('A search of the whole module for an ownership assertion — the `shops` collection,');
  line('`assertShopOwner`, `ownerId`, `sellerUid`, or any comparison of `merchantId` to the caller —');
  line('returns **nothing**. `_requireMerchant` establishes that the caller has *a* merchant role;');
  line('it never establishes that they are *this* merchant.');
  line('');
  line('So re-exporting them as they stand would publish eleven cross-tenant write paths.');
  line('');
  line('### The gate does not merely fail closed — it inverts');
  line('');
  line('```js');
  line('const role = req.auth.token?.role ?? 0;');
  line('if (role < 2) _err(\'Seller / merchant role required.\', \'permission-denied\');');
  line('```');
  line('');
  line('| claim value | `role < 2` | outcome |');
  line('|---|---|---|');
  line('| absent (the production norm) | `0 < 2` → true | **refused** |');
  line('| `true` (boolean claims, as minted) | `true < 2` → true | **refused** |');
  line('| `"seller"` | `NaN < 2` → false | **allowed** |');
  line('| `"buyer"` | `NaN < 2` → false | **allowed** |');
  line('| `"anything at all"` | `NaN < 2` → false | **allowed** |');
  line('');
  line('A string comparison against a number is `NaN`, and every comparison with `NaN` is false — so');
  line('the guard passes. It refuses the accounts that legitimately have no numeric claim, and admits');
  line('any account carrying a *string* `role` claim regardless of its value. Several modules in this');
  line('codebase read `claims.role === \'admin\'`, so a string `role` claim is a shape this system');
  line('already expects to exist.');
  line('');
  line('That is the decisive reason not to add the exports first. "Unsatisfiable" would be safe to');
  line('ship and useless; **inverted** is neither.');
  line('');
  line('### Two of them read a collection the platform moved off');
  line('');
  line('`getCrossSellRecommendations` and `getUpsellRecommendations` read `posProducts`. The canonical');
  line('product collection is `products` — `posCompleteCheckout` was converged onto it precisely');
  line('because `posProducts` was empty for most merchants. Recommendations built on it would be');
  line('empty for the same merchants, and would not see the catalogue Sell and Inventory operate on.');
});

/* ══ Summary ═════════════════════════════════════════════════════════════ */
line(MD ? '\n## What may be built on, today\n' : '\n-- summary --');
const all = [...msRows, ...engRows, { f: facts('createAdCampaign'), v: classify(facts('createAdCampaign'), {})[0] }];
const safe = all.filter((r) => r.v === 'SAFE').map((r) => r.f.name);
const hard = all.filter((r) => r.v === 'SAFE AFTER AUTH HARDENING').map((r) => r.f.name);
const blocked = all.filter((r) => r.v === 'BLOCKED').map((r) => r.f.name);
const decision = all.filter((r) => r.v === 'SHOP-SCOPE DECISION REQUIRED').map((r) => r.f.name);

if (MD) {
  line('| classification | capabilities |');
  line('|---|---|');
  line(`| **SAFE** | ${safe.length ? safe.map((n) => '`' + n + '`').join(', ') : '—'} |`);
  line(`| **SAFE AFTER AUTH HARDENING** | ${hard.length ? hard.map((n) => '`' + n + '`').join(', ') : '—'} |`);
  line(`| **SHOP-SCOPE DECISION REQUIRED** | ${decision.length ? decision.map((n) => '`' + n + '`').join(', ') : '—'} |`);
  line(`| **BLOCKED** | ${blocked.length ? blocked.map((n) => '`' + n + '`').join(', ') : '—'} |`);
  line('');
  line('### Recommended Marketing scope');
  line('');
  line('Build the first Marketing surface on the **SAFE** set only — shop-scoped campaign create and');
  line('read, and the shop-scoped promotions path. That is a coherent screen on its own.');
  line('');
  line('Leave out, deliberately and visibly:');
  line('');
  line('- **Ads**, until the account-vs-shop scope decision is made.');
  line('- **Campaign delete**, until it authorises against the shop rather than the creator; `pause`');
  line('  is the reversible action and has the same defect, so both wait together.');
  line('- **Order and ROI figures**, until a campaign\'s conversion counters come from somewhere an');
  line('  anonymous caller cannot increment. Clicks and views may be shown, labelled as traffic.');
  line('- **Everything in marketing-engine**, until ownership assertion and the role gate are fixed.');
  line('  Re-exporting is the last step of that work, not the first.');
} else {
  line('   SAFE: ' + (safe.join(', ') || '—'));
  line('   SAFE AFTER AUTH HARDENING: ' + (hard.join(', ') || '—'));
  line('   SHOP-SCOPE DECISION REQUIRED: ' + (decision.join(', ') || '—'));
  line('   BLOCKED: ' + (blocked.join(', ') || '—'));
}

if (hardFail) { console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.'); process.exit(1); }
console.log(out.join('\n'));
