#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   2D-2 AUTHORITY CENSUS — read-only, no network, no writes
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-merchant-2d2-authority.js
         node scripts/census-merchant-2d2-authority.js --md > docs/MERCHANT_2D2_AUTHORITY_CENSUS.md

   WHY THIS EXISTS
   2D-1C found that Inventory's apparent capability and its authoritative write
   path were different things: the POS inventory tab reached canonical
   `products.stock` through `sokoni-db.updateProductStock()`, which also
   increments `sold` — so a correction was recorded as a SALE. That discovery
   arrived halfway through the build. This census front-loads the same question
   for all eleven remaining 2D-2 screens.

   WHAT IT ESTABLISHES PER SCREEN
     canonical data source → read authority → write authority → authorization
     → merchant/shop scope → legacy seller.html dependency → verdict

   THREE RULES IT OBEYS
   1. A callable is NOT authoritative because its name looks right. Every
      candidate is opened and its guard read. `createPromotion` sounds like a
      merchant authority and is `_assertAdmin`-only; `orgCreateTeam` sounds like
      shop staff and is organisational teams.
   2. Defined ≠ deployed. `functions/index.js` must re-export by name (CLAUDE.md).
      A module full of perfect callables that index.js never names is not an
      authority a screen can be built on.
   3. Unresolved stays UNKNOWN. It is never rounded up to SAFE.

   METHOD, AND ITS ONE JUDGEMENT INPUT
   The screen → candidate-authority map below is REVIEWED, not derived — deriving
   it by name is precisely the trap rule 1 names. Everything applied TO that map
   is mechanical: existence, re-export, guard shape, ownership assertion, scope
   field, rules coverage, doc-key format. Re-running after a code change
   re-derives every verdict.

   NEGATIVE CONTROLS: `git grep` defaults to BASIC regex, where `(`, `|` and `?`
   are literals — without -E every alternation silently matches nothing and the
   census reports a confident, wrong "no authority". Controls fail the run loudly.
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
const must = (label, ok, detail) => {
  if (!ok) { hardFail++; console.error('CENSUS CONTROL FAILED: ' + label + (detail ? ' — ' + detail : '')); }
};

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
const RULES = read('firestore.rules');
const SELLER_JS = read('seller.js');

/* ── Controls ─────────────────────────────────────────────────────────────── */
must('grep literal match works', grep("collection\\('products'\\)").length > 0, 'products collection not found');
must('grep alternation works (-E, not BRE)', grep('(posCompleteCheckout|merchantAdjustStock)').length > 0, 'alternation matched nothing');
must('functions/index.js is readable', INDEX.length > 10000, 'index.js empty/short');
must('firestore.rules is readable', RULES.length > 5000, 'rules empty/short');
must('seller.js is readable', SELLER_JS.length > 100000, 'seller.js empty/short');
/* A known-deployed and a known-undeployed callable, so the re-export detector is
   proven in BOTH directions rather than trusted. */
must('re-export detector: true positive', /^exports\.posCompleteCheckout\b/m.test(INDEX), 'posCompleteCheckout not seen as re-exported');
must('re-export detector: true negative', !/^exports\.createFlashSale\b/m.test(INDEX), 'createFlashSale unexpectedly re-exported');

/* ══════════════════════════════════════════════════════════════════════════
   THE MAP — reviewed, not name-derived. `why` records why each candidate was
   considered, so a future reader can challenge the selection itself.
   ══════════════════════════════════════════════════════════════════════════ */
const SCREENS = [
  {
    screen: 'Orders',
    sections: ['buyer-orders-section', 'returns-section', 'offers-section'],
    legacyKeys: ['sokoniOrders', 'sokoniReturns', 'sokoniOffers'],
    canonical: 'orders',
    readAuthority: 'client SDK on `orders` + SokoniOrderService; merchant.html already renders this natively (renderOrders)',
    candidates: [
      { name: 'orderAdvance', why: 'the only order-status/timeline write authority' },
      { name: 'onOrderStatusChange', why: 'trigger, not callable — reacts, cannot be driven by a screen', merchantUsable: false, kind: 'TRIGGER' },
    ],
    mobile: 'status advance + returns/offers triage; one-thumb list, no horizontal scroll',
    divergence: 'orderAdvance is deployed and is the ONLY status authority, but it verifies only that the caller is signed in — never that they own the order. It also flips status to confirmed, which triggers rider auto-assignment. A merchant Orders screen cannot be built on it until it asserts ownership.',
  },
  {
    screen: 'Receipts',
    sections: ['receipts-section'],
    legacyKeys: [],
    canonical: 'posReceipts',
    readAuthority: 'posReceipts written by posCompleteCheckout + payment-trust; no merchant-scoped LIST callable found',
    candidates: [
      { name: 'verifyTrustReceipt', why: 'reads a single receipt by number' },
      { name: 'generateTrustReceipt', why: 'creates a trust receipt' },
      { name: 'voidTrustReceipt', why: 'the void/correction path' },
      { name: 'sendPOSReceipt', why: 'delivery of an existing receipt' },
    ],
    mobile: 'search by receipt no, reprint, share, void-with-reason',
  },
  {
    screen: 'Team / Staff',
    sections: ['employees-section', 'verify-section', 'restock-section', 'danger-section'],
    legacyKeys: ['sokoniEmployees', 'sokoniEmployeeSession', 'sokoniSellerVerification', 'sokoniStockAlerts'],
    canonical: 'shopEmployees',
    readAuthority: 'client SDK on shopEmployees (seller.js:2633 deletes directly)',
    candidates: [
      { name: 'inviteShopEmployee', why: 'the invite authority seller.js already calls' },
      { name: 'acceptShopInvite', why: 'the only WRITER of shopEmployees' },
      { name: 'orgCreateTeam', why: 'NAME TRAP — organisational teams, a different entity from shop staff', merchantUsable: false },
      { name: 'getStaffRoster', why: 'NAME TRAP — provider/roster domain, not shop employees', merchantUsable: false },
    ],
    mobile: 'invite by email, role picker, revoke; PIN/QR handover is POS-side',
  },
  {
    screen: 'Messages',
    sections: ['seller-dms', 'qa-section'],
    legacyKeys: ['sokoniMessages', 'sokoniQA'],
    canonical: 'conversations',
    readAuthority: 'messages.js — participant-scoped',
    candidates: [
      { name: 'createConversation', why: 'opens a thread' },
      { name: 'updateConversationStatus', why: 'thread lifecycle' },
      { name: 'markRead', why: 'read state' },
      { name: 'searchConversations', why: 'inbox search' },
      { name: 'messagesDispatch', why: 'op-router front door — delegates auth to the handler it routes to', merchantUsable: false, kind: 'ROUTER' },
    ],
    mobile: 'sticky composer over the keyboard; the known enhancement deferred at 2C',
  },
  {
    screen: 'Marketing',
    sections: ['marketing-section', 'flash-section', 'ads-section'],
    legacyKeys: ['sokoniCampaigns', 'sokoniPromoCodes', 'sokoniAds'],
    canonical: 'minishopCampaigns / minishopPromotions / mktCampaigns',
    readAuthority: 'getMinishopCampaigns (shop-owner asserted)',
    candidates: [
      { name: 'createMinishopCampaign', why: 'shop-scoped campaign create' },
      { name: 'getMinishopCampaigns', why: 'shop-scoped campaign read' },
      { name: 'deleteMinishopCampaign', why: 'shop-scoped campaign delete' },
      { name: 'miniShopCreatePromotion', why: 'shop-scoped promotion create' },
      { name: 'createAdCampaign', why: 'seller-scoped ad campaign' },
      { name: 'createMarketingCampaign', why: 'marketing-engine campaign create' },
      { name: 'createPromotion', why: 'NAME TRAP — finos, _assertAdmin only', merchantUsable: false, adminOnly: true },
    ],
    mobile: 'create/schedule/stop a campaign; budget entry needs numeric keypad',
  },
  {
    screen: 'Flash Sales',
    sections: ['flash-section'],
    legacyKeys: ['sokoniFlashSales'],
    canonical: 'mktFlashSales (engine) vs minishopPromotions type=flash_sale (minishop) — TWO counters',
    readAuthority: 'getFlashSalePrice (engine) / miniShopGetPromotions (minishop)',
    candidates: [
      { name: 'createFlashSale', why: 'the engine authority the scheduled concluder implies' },
      { name: 'getFlashSalePrice', why: 'price resolution at sale time' },
      { name: 'recordFlashSalePurchase', why: 'stock-limit decrement' },
      { name: 'concludeExpiredFlashSales', why: 'scheduled job — expires them; cannot be driven by a screen', merchantUsable: false, kind: 'SCHEDULED' },
      { name: 'miniShopCreatePromotion', why: 'accepts type flash_sale — the OTHER counter' },
    ],
    mobile: 'pick product, set % and window, live countdown',
    divergence: 'TWO stores for one number: mktFlashSales (marketing-engine, whose whole module is un-re-exported) and minishopPromotions type=flash_sale (minishop-v3, deployed and shop-scoped). The deployed scheduled concluder reads mktFlashSales — a collection no deployed callable can write. Building a screen before these converge repeats the Inventory defect exactly.',
  },
  {
    screen: 'Tax',
    sections: ['tax-section', 'wallet-section', 'expense-section', 'mpesa-insights-section'],
    legacyKeys: ['kraPinSaved', 'sokoniExpenses', 'sokoniWallet'],
    canonical: 'etimsInvoices / etimsProfile',
    readAuthority: 'etimsGetProfile / etimsGetSellerStats',
    candidates: [
      { name: 'etimsGetProfile', why: 'seller eTIMS profile' },
      { name: 'etimsGetSellerStats', why: 'seller-scoped stats' },
      { name: 'etimsGenerateInvoice', why: 'the invoice authority' },
      { name: 'etimsBulkGenerate', why: 'bulk invoice authority' },
      { name: 'calculateTaxBreakdown', why: 'computation only' },
      { name: 'hubUpdateTaxConfig', why: 'NAME TRAP — hub-level config, not per-merchant', merchantUsable: false, adminOnly: true },
    ],
    mobile: 'KRA PIN entry, invoice list, download; wallet is the FROZEN engine — read only',
  },
  {
    screen: 'Stories',
    sections: ['stories-section'],
    legacyKeys: ['sokoniStories'],
    canonical: 'NONE FOUND',
    readAuthority: 'none — localStorage only, and demo-seed.js writes the same key',
    candidates: [],
    mobile: 'camera/upload, 24h expiry, viewer counts',
  },
  {
    screen: 'Disputes',
    sections: ['disputes-section'],
    legacyKeys: ['sokoniDisputes'],
    canonical: 'disputes',
    readAuthority: 'disputes rules — party-scoped',
    candidates: [
      { name: 'addDisputeEvidence', why: 'seller is an explicit party' },
      { name: 'createDispute', why: 'BUYER-side only — the handler rejects a non-buyer, so a merchant screen cannot use it', merchantUsable: false },
      { name: 'cancelDispute', why: 'party-side cancel' },
      { name: 'adminResolveDispute', why: 'admin-only resolution, correctly so', merchantUsable: false, adminOnly: true },
      { name: 'adminGetAllDisputes', why: 'NAME TRAP — admin console, platform-wide', merchantUsable: false, adminOnly: true },
    ],
    mobile: 'evidence upload from camera roll; read-only timeline',
  },
  {
    screen: 'Customers',
    sections: ['customers-section'],
    legacyKeys: ['sokoniOrders'],
    canonical: 'posCustomers',
    readAuthority: 'crm.js / pos-crm-pro.js',
    candidates: [
      { name: 'getCustomerProfile', why: 'merchant-owner asserted profile read' },
      { name: 'buildCustomerProfile', why: 'profile construction' },
      { name: 'posGetCustomerInsights', why: 'merchant-scoped insights' },
      { name: 'getCustomerGrowthMetrics', why: 'aggregate metrics' },
    ],
    mobile: 'search, profile, purchase history, loyalty balance',
  },
  {
    screen: 'Store',
    sections: ['ministore-section', 'premium-section', 'danger-section'],
    legacyKeys: ['sokoniMiniStore', 'sokoniPremiumPlan', 'sokoniStoreFollowers'],
    canonical: 'shops / minishopConfig / shopHandles',
    readAuthority: 'getMinishopAnalytics (shop-owner asserted)',
    candidates: [
      { name: 'claimMinishopHandle', why: 'handle claim, ownership-gated' },
      { name: 'getMinishopAnalytics', why: 'shop-owner asserted analytics' },
      { name: 'updateMinishopConfig', why: 'storefront configuration' },
      { name: 'generateMinishopShareCard', why: 'share asset' },
      { name: 'followShop', why: 'follower relationship' },
    ],
    mobile: 'storefront preview, handle, theme, danger zone',
  },
];

/* ══ Mechanical evaluation of one candidate ═══════════════════════════════ */

/* Guards are evaluated ALL-AT-ONCE and then ranked, never first-match. A handler
   that checks `participants.includes(uid)` AND has an admin-only branch for system
   messages is participant-scoped with an admin escape hatch — reporting it as
   "admin only" (which first-match ordering did) inverts its meaning entirely. */
const GUARDS = [
  { key: 'shop-owner assert', rank: 1, re: /_assertShopOwner|assertShopOwner|assertMerchantOwner|_assertShop\b|assertShopAccess|sellerUid\s*!==\s*(uid|request\.auth\.uid)|ownerId\s*===\s*uid|shopOwnerId["']\s*,\s*["']==["']\s*,\s*request\.auth\.uid/ },
  /* `isBuyer` on its own was too loose: it matched the FIELD name inside
     verifyTrustReceipt's public response body and promoted a no-auth QR endpoint
     to "party-scoped". A guard has to look like a guard — a negated test that
     throws, or an explicit inequality. */
  { key: 'party/participant', rank: 2, re: /participants\.includes|buyerId\s*!==\s*uid|sellerId\s*!==\s*uid|if\s*\(\s*!isBuyer|sellerUid:\s*uid\b|sellerUid:\s*request\.auth\.uid/ },
  { key: 'numeric-role gate', rank: 3, re: /_requireMerchant\(|token\?\.\s*role\s*\?\?\s*0|\brole\s*<\s*2\b/ },
  { key: 'admin-only',        rank: 4, re: /_assertAdmin\(|assertAdmin\(|requireAdmin\(/ },
  { key: 'auth-only',         rank: 5, re: /unauthenticated|_requireAuth\(|requireAuth\(|if \(!req(uest)?\.auth\)/ },
];

/* Any client-supplied identifier the handler then reads or mutates. Restricting
   this to merchantId/shopId missed `orderAdvance`, which takes an `orderId` and
   updates that order — the same IDOR shape with a different noun. */
const CLIENT_SCOPE_IDS = /\b(merchantId|shopId|sellerId|orderId|disputeId|conversationId|receiptNo|customerId|productId)\b/;

/* Does the handler establish WHO is calling, at all? */
const REQUIRES_AUTH = /unauthenticated|_requireAuth\(|requireAuth\(|_requireMerchant\(|_assertAdmin\(|assertAdmin\(|requireAdmin\(|if \(!req(uest)?\.auth\)|req(uest)?\.auth\.uid/;

/* Extract the ACTUAL function body by matching delimiters from the definition,
   rather than slicing a fixed number of characters. The fixed window read past the
   end of short handlers into whatever was declared next, which is how
   `createAdCampaign` (auth + self-scoped) was reported as admin-only: the window
   had run on into a neighbouring admin function. */
function bodyAt(src, lineNo) {
  const lines = src.split('\n');
  const start = lines.slice(0, lineNo - 1).join('\n').length;
  let i = src.indexOf('(', start);
  if (i < 0) return src.slice(start, start + 1200);
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return src.slice(start, j + 1); }
  }
  return src.slice(start, start + 4000);
}

function locate(name) {
  const direct = grep(`^exports\\.${name}\\s*=\\s*onCall|^const ${name} = onCall|^exports\\.${name}\\s*=\\s*onRequest|^exports\\.${name}\\s*=\\s*onSchedule`, 'functions/');
  if (direct.length) { const [file, ln] = direct[0].split(':'); return { file, line: Number(ln) }; }
  return null;
}

/* Ops reachable through a deployed dispatcher are DEPLOYED, even though index.js
   never names them. messages.js exports 12 callables that index.js does not
   re-export — but `messagesDispatch` is re-exported and routes straight into
   `messages._h[op]`, the same handlers. Calling that "not deployed" would have
   sent Messages to the back of the build queue for no reason. */
const DISPATCHERS = [
  { fn: 'messagesDispatch', module: 'functions/messages.js', table: '_h' },
  { fn: 'commerceDispatch', module: 'functions/commerce-dispatch.js', table: '_h' },
  { fn: 'bookingDispatch', module: 'functions/booking-dispatch.js', table: '_h' },
  { fn: 'adminOsDispatch', module: 'functions/admin-os-dispatch.js', table: '_h' },
];
function dispatcherFor(name, file) {
  for (const d of DISPATCHERS) {
    if (file !== d.module) continue;
    if (!new RegExp('^exports\\.' + d.fn + '\\b', 'm').test(INDEX)) continue;
    const src = read(d.module);
    if (new RegExp('_h\\.' + name + '\\s*=').test(src)) return d.fn;
  }
  return null;
}

function evaluate(name, meta) {
  const def = locate(name);
  const reExported = new RegExp('^exports\\.' + name + '\\b', 'm').test(INDEX);
  if (!def && !reExported) return { name, status: 'ABSENT', guard: '—', notes: 'no definition and no re-export' };

  let guard = 'NONE DETECTED', clientScope = false, file = def ? def.file : null, via = null, hasAuth = false;
  if (def) {
    const body = bodyAt(read(def.file), def.line);
    const hit = GUARDS.filter((g) => g.re.test(body)).sort((a, b) => a.rank - b.rank)[0];
    guard = hit ? hit.key : 'NONE DETECTED';
    clientScope = CLIENT_SCOPE_IDS.test(body);
    via = reExported ? null : dispatcherFor(name, def.file);
    hasAuth = REQUIRES_AUTH.test(body);
  }

  const deployed = reExported || !!via;
  /* A handler that never establishes who is calling cannot be scoped to them,
     whatever else its body contains. verifyTrustReceipt forced this rule: it is a
     deliberately PUBLIC QR-verification endpoint returning a thin view, and a
     census that called it an ownership authority would have sent Receipts to the
     front of the build queue on a false premise. */
  const scoped = hasAuth && (guard === 'shop-owner assert' || guard === 'party/participant');

  let status;
  /* The declared "this actor cannot use it" judgement is applied BEFORE any
     heuristic. A trigger or a scheduled job has no auth check by construction, and
     labelling it "PUBLIC / NO AUTH" would read as a security finding when it is
     simply not a callable a screen could ever drive. */
  if (!deployed)                            status = 'NOT DEPLOYED';
  else if (meta && meta.merchantUsable === false) status = meta.adminOnly ? 'ADMIN ONLY' : (meta.kind || 'NOT MERCHANT-USABLE');
  else if (!hasAuth)                        status = 'PUBLIC / NO AUTH';
  else if (guard === 'numeric-role gate')   status = 'UNSATISFIABLE GATE';
  else if (guard === 'admin-only')          status = 'ADMIN ONLY';
  else if (scoped)                          status = 'AUTHORITATIVE';
  else if (clientScope)                     status = 'AUTH ONLY + CLIENT SCOPE';
  else if (guard === 'auth-only')           status = 'AUTH ONLY';
  else                                      status = 'UNKNOWN';

  return { name, status, guard, file, clientScope, reExported, via };
}

/* ══ Verdict ═════════════════════════════════════════════════════════════
   Ordered most-blocking-first, and deliberately pessimistic: anything that cannot
   be established is UNKNOWN, never rounded up to SAFE. A screen whose canonical
   store DIVERGES (two counters for one number) can never be SAFE regardless of how
   good one of its authorities looks — that is the 2D-1C Inventory lesson encoded. */
function verdict(rows, sc) {
  if (sc.divergence) return ['BLOCKED — DIVERGENT STORE', sc.divergence];
  if (!rows.length) return ['NEEDS NEW AUTHORITY', 'no server authority of any kind exists for this capability'];
  const s = (k) => rows.filter((r) => r.status === k);
  const authoritative = s('AUTHORITATIVE');

  if (authoritative.length) {
    const weak = rows.filter((r) => r.status === 'AUTH ONLY + CLIENT SCOPE');
    if (weak.length) return ['SAFE TO REBUILD (partial)',
      'a shop-scoped authority exists, but ' + weak.length + ' sibling(s) accept a client-supplied scope id unchecked — build ONLY on the asserted ones: ' +
      authoritative.map((r) => r.name).join(', ')];
    return ['SAFE TO REBUILD', 'deployed, ownership-asserting authority: ' + authoritative.map((r) => r.name).join(', ')];
  }
  if (s('UNSATISFIABLE GATE').length) return ['BLOCKED — UNSATISFIABLE GATE', 'the guard requires a claim shape nothing in the codebase mints'];
  if (s('AUTH ONLY + CLIENT SCOPE').length) return ['NEEDS AUTHORIZATION HARDENING', 'deployed, but the authority trusts a client-supplied scope id without verifying ownership'];
  if (s('NOT DEPLOYED').length && !s('AUTH ONLY').length) return ['BLOCKED — NOT DEPLOYED', 'written but never re-exported in functions/index.js and not reachable via a dispatcher'];
  /* AUTH ONLY is checked BEFORE ADMIN ONLY: a screen with merchant-callable but
     un-scoped authorities is UNKNOWN, not "admin only". Checking admin first
     mislabelled Tax, whose eTIMS callables are all merchant-callable. */
  if (s('AUTH ONLY').length) return ['UNKNOWN', 'deployed and authenticated, but merchant/shop scope enforcement could not be established mechanically — must be read by hand before scheduling'];
  if (s('ADMIN ONLY').length || s('NOT MERCHANT-USABLE').length) return ['BLOCKED — NO MERCHANT AUTHORITY', 'every candidate is admin-only or belongs to another actor'];
  return ['UNKNOWN', 'could not be resolved — must not be treated as safe'];
}

/* ══ Report ══════════════════════════════════════════════════════════════ */
line(MD ? '# 2D-2 Authority Census' : '\n══ 2D-2 AUTHORITY CENSUS ══');
if (MD) {
  line('');
  line('> Regenerate: `node scripts/census-merchant-2d2-authority.js --md > docs/MERCHANT_2D2_AUTHORITY_CENSUS.md`');
  line('> Read-only: no network, no writes, no implementation change.');
  line('');
  line('Companion to [[MERCHANT_CAPABILITY_MAP]] and [[MERCHANT_CONSOLIDATION_CENSUS]].');
  line('');
}

/* Legacy dependency — the thing every screen has in common. */
const lsKeys = [...new Set([...SELLER_JS.matchAll(/localStorage\.(?:get|set|remove)Item\(\s*["']([^"']+)["']/g)].map((m) => m[1]))].sort();
line(MD ? '\n## Legacy baseline\n' : '\n-- legacy baseline --');
line(`seller.js carries **${lsKeys.length}** device-local keys and only **${(SELLER_JS.match(/httpsCallable\(/g) || []).length}** callable invocations.`);
line('');
line('That ratio is the whole finding: for these eleven screens seller.js is not a data layer to port, it is a **device-local cache with no server behind it**. Every verdict below is therefore about the authority that must exist *elsewhere*, not about seller.js.');

if (MD) {
  /* Counted, not asserted — so these headlines cannot drift from the evidence. */
  const mkt = read('functions/marketing-engine.js');
  const mktExports = (mkt.match(/^\s{2}[a-zA-Z][A-Za-z0-9_]*,$/gm) || []).map((x) => x.trim().replace(',', ''));
  const mktDead = mktExports.filter((n) => !new RegExp('^exports\\.' + n + '\\b', 'm').test(INDEX));
  /* Count MINTERS precisely, by reading each setCustomUserClaims payload — not by
     grepping `role:\s*\d` repo-wide, which matched a counter initialiser in a probe
     script and produced a misleading "1". A census headline has to be countable. */
  const claimSites = grep('setCustomUserClaims\\(', 'functions/');
  let numericRoleMinted = 0;
  for (const h of claimSites) {
    const [f, l] = h.split(':');
    const body = bodyAt(read(f), Number(l));
    if (/\brole\s*:\s*[0-9]/.test(body)) numericRoleMinted++;
  }
  const numericRoleGates = grep('token\\??\\.?\\s*role\\s*(\\?\\?|\\|\\|)\\s*0', 'functions/');
  const gateFiles = [...new Set(numericRoleGates.map((h) => h.split(':')[0]))];

  line('');
  line('## Headline findings');
  line('');
  line(`1. **An entire authority module is written but not deployed.** \`functions/marketing-engine.js\` exports ${mktExports.length} callables covering Flash Sales, Bundles, Campaigns, A/B tests and Coupons. **${mktDead.length}** of them are never re-exported in \`functions/index.js\`, so they do not exist at runtime. The one that IS re-exported is \`concludeExpiredFlashSales\` — a scheduled job that expires rows in \`mktFlashSales\`, a collection **no deployed callable can write**. This is the \`sellerApplications\` shape from the previous census: a live trigger over a starved collection.`);
  line('');
  line(`2. **That module's auth gate is unsatisfiable, and it is not alone.** \`_requireMerchant\` reads \`req.auth.token.role ?? 0\` and rejects anything below \`2\` — a *numeric* role claim. Every one of the **${claimSites.length}** \`setCustomUserClaims\` call sites in \`functions/\` was opened and checked for a numeric \`role\`: **${numericRoleMinted}** mint one. The canonical shapes are boolean custom claims and a \`roles\` ARRAY on \`users/{uid}\`, so \`?? 0\` always wins and every caller is refused. The same gate appears in **${gateFiles.length}** files (${gateFiles.map((f) => '`' + f.replace('functions/', '') + '`').join(', ')}) — a **fourth** role representation alongside claims-boolean, \`roles\`-array, and the \`.role\` string analytics reads.`);
  line('');
  line('3. **`orderAdvance` has no ownership check.** It is the only order-status authority, it is deployed, and it verifies only that the caller is signed in. It accepts any `orderId`, advances that order\'s timeline, and on the `accepted` stage sets `status: \'confirmed\'` — which is what triggers rider auto-assignment. This is a live IDOR independent of 2D-2, not merely a blocker for the Orders screen.');
  line('');
  /* Derived from the same rows the cross-cutting section renders, so this headline
     cannot go on describing a defect after it has been fixed. */
  const empServer = grep('shopEmployees').filter((h) => /\.doc\(/.test(h) && h.startsWith('functions/'));
  const empForms = [...new Set(empServer.map((h) => (/employeeDocId\(/.test(h) ? 'canonical' : /request\.auth\.uid\)|\.doc\(uid\)/.test(h) ? 'legacy' : 'other')))];
  const empFixed = empForms.length === 1 && empForms[0] === 'canonical';
  line(empFixed
    ? '4. **`shopEmployees` key divergence — FIXED (2D-2 step 1).** The writer and both readers are now on the canonical `shopEmployees/{shopId}_{uid}`, and the readers corroborate each record against the shop document rather than trusting that it exists. That second part closed a cross-tenant escalation: `firestore.rules` lets a client create a `shopEmployees` document at any id naming itself owner, and both readers previously granted access on existence alone. Legacy `{uid}` records are refused, not migrated. See the cross-cutting section.'
    : '4. **`shopEmployees` writer and readers disagree on the document key** — see the cross-cutting section. This one reaches backwards into the Inventory surface shipped in 2D-1C.');
  line('');
  line('5. **Stories has no server authority of any kind** — and `demo-seed.js` writes the same `sokoniStories` key the screen reads, which is a demo/seed path touching a production surface.');
  line('');
  line('## Constraints this census observed');
  line('');
  line('- No implementation was modified. No Merchant button, route or surface was removed, hidden or retargeted.');
  line('- POS, and the native Sell/Inventory surfaces from 2D-1C, are untouched.');
  line('- seller.js\'s localStorage model is recorded as a **dependency to retire**, never as a model to port.');
  line('- A callable is judged by its opened body, never by its name. Name traps are listed explicitly in each table.');
  line('- Anything unresolved is **UNKNOWN**. No screen is called safe on a guess.');
  line('- Scope is judged against the canonical pair `sellerUid` (account) and `shopId` (shop). An authority that conflates them, or that accepts either from the client without verifying it, is flagged rather than accepted.');
  line('');
  line('> **Scope note.** The eleven screens censused are the ones named for 2D-2. `Products` is *not* among them but is still a `kind:\'seller\'` iframe route in the contract — it needs the same treatment and is not covered here.');
}

const results = [];
for (const sc of SCREENS) {
  const rows = sc.candidates.map((c) => Object.assign(evaluate(c.name, c), { why: c.why }));
  const [v, reason] = verdict(rows, sc);
  results.push({ sc, rows, v, reason });

  line(MD ? `\n## ${sc.screen}\n` : `\n── ${sc.screen} ──`);
  if (MD) {
    line(`| | |`);
    line(`|---|---|`);
    line(`| canonical source | ${sc.canonical} |`);
    line(`| read authority | ${sc.readAuthority} |`);
    line(`| legacy seller.html dependency | ${sc.legacyKeys.length ? '`' + sc.legacyKeys.join('`, `') + '`' : 'none'} |`);
    line(`| sections | ${sc.sections.join(', ')} |`);
    line(`| mobile requirements | ${sc.mobile} |`);
    line('');
    if (rows.length) {
      line('| candidate | status | guard | client scope | considered because |');
      line('|---|---|---|---|---|');
      for (const r of rows) {
        line(`| \`${r.name}\` | **${r.status}** | ${r.guard || '—'} | ${r.clientScope ? '⚠ yes' : 'no'} | ${r.why} |`);
      }
      line('');
    }
    line(`**VERDICT: ${v}** — ${reason}`);
  } else {
    for (const r of rows) line(`   ${r.status.padEnd(26)} ${r.name}   (${r.guard || '-'}${r.clientScope ? ', client scope' : ''})`);
    line(`   => ${v} — ${reason}`);
  }
}

/* ══ Cross-cutting: doc-key divergence ═══════════════════════════════════ */
line(MD ? '\n## Cross-cutting defects\n' : '\n-- cross-cutting --');
/* A collection whose WRITER and READERS disagree on the document key is a silent
   permanent miss: every lookup returns "not found" and every caller takes its
   not-found branch, which here reads as "you do not have access". */
const empKeys = grep('shopEmployees').filter((h) => /\.doc\(|,\s*"shopEmployees"|, 'shopEmployees'/.test(h));
/* `employeeDocId(...)` is checked FIRST. After the 2D-2 step-1 convergence the
   writer builds its key through that helper, and a detector that only looked for
   the literal `${shopId}_${uid}` template read the converged call as legacy
   `{uid}` — because the arguments still mention `request.auth.uid`. A census that
   reports a fixed defect as still-broken is as useless as one that misses it. */
const keyForm = (code) => /employeeDocId\(/.test(code) ? '{shopId}_{uid} (via employeeDocId)'
  : /\$\{shopId\}_\$\{uid\}|shopId \+ ['"]_['"] \+ uid/.test(code) ? '{shopId}_{uid}'
  : /request\.auth\.uid\)|\.doc\(uid\)|\.doc\(String\(uid\)\)/.test(code) ? '{uid}'
  : /,\s*id\)/.test(code) ? '{id} (client-supplied)' : 'unresolved';
const CANONICAL_KEY = /^\{shopId\}_\{uid\}/;
const roleOf = (code) => /\.set\(|\.create\(/.test(code) ? 'WRITER' : /deleteDoc|\.delete\(/.test(code) ? 'deleter' : 'reader';

const empRows = empKeys.map((h) => {
  const p = h.split(':');
  const code = p.slice(2).join(':').trim();
  return { at: p[0] + ':' + p[1], form: keyForm(code), role: roleOf(code) };
}).filter((r) => r.form !== 'unresolved');

/* Client-SDK sites are reported separately: a legacy client path that still
   reaches the collection directly is a migration item, not a key divergence
   between server authorities. */
const serverRows = empRows.filter((r) => r.at.startsWith('functions/'));
const clientRows = empRows.filter((r) => !r.at.startsWith('functions/'));
const forms = [...new Set(serverRows.map((r) => r.form))];
const converged = forms.length === 1 && CANONICAL_KEY.test(forms[0]);

line(MD ? '### `shopEmployees` document key\n' : ' shopEmployees server key forms: ' + (forms.join(' vs ') || 'none'));
if (converged) {
  if (MD) {
    line('**CONVERGED.** Every server site uses the canonical `shopEmployees/{shopId}_{uid}`.');
    line('');
    line('| site | key form | role |');
    line('|---|---|---|');
    for (const r of serverRows) line(`| \`${r.at}\` | \`${r.form}\` | ${r.role} |`);
    line('');
    line('Both readers now delegate to `functions/shop-employees.js`, which additionally **corroborates** the record against the shop document — an employee is believed only when its `shopOwnerId` matches the owner `shops/{shopId}` names. Legacy `shopEmployees/{uid}` records are never honoured and are not migrated.');
    if (clientRows.length) {
      line('');
      line('Remaining **client-SDK** sites (migration items, not authority divergence):');
      line('');
      for (const r of clientRows) line(`- \`${r.at}\` — ${r.role}, key \`${r.form}\``);
    }
  } else {
    for (const r of serverRows) line('   ' + r.at.padEnd(42) + r.form.padEnd(34) + r.role);
    line('   => CONVERGED on the canonical key; readers corroborate against the shop document.');
    for (const r of clientRows) line('   client-SDK site remaining: ' + r.at + ' (' + r.role + ')');
  }
} else if (forms.length > 1) {
  if (MD) {
    line('| site | key form | role |');
    line('|---|---|---|');
    for (const r of empRows) line(`| \`${r.at}\` | \`${r.form}\` | ${r.role} |`);
    line('');
    line('**Consequence.** The only thing that CREATES a `shopEmployees` record writes one key; every reader looks up another. An employee who accepts an invite is therefore invisible to `merchantAdjustStock` and to `analytics-engine`, and both fall through to their permission-denied branch. The `{uid}` form also means an employee can belong to exactly one shop platform-wide.');
    line('');
    line('This is not a 2D-2 finding only — it reaches back into the Inventory surface shipped in 2D-1C, whose employee-access path cannot match a real record until the key converges.');
  } else {
    for (const r of empRows) line('   ' + r.at.padEnd(42) + r.form.padEnd(22) + r.role);
    line('   => WRITER and READERS disagree: an invited employee is invisible to every reader.');
  }
} else {
  line(MD ? 'No divergence detected — all sites agree on the key form.' : '   no divergence detected');
}
line('');

/* ══ Order ═══════════════════════════════════════════════════════════════ */
const RANK = {
  'SAFE TO REBUILD': 1, 'SAFE TO REBUILD (partial)': 2, 'NEEDS AUTHORIZATION HARDENING': 3,
  'BLOCKED — NOT DEPLOYED': 4, 'BLOCKED — UNSATISFIABLE GATE': 5, 'BLOCKED — ADMIN ONLY': 6,
  'UNKNOWN': 7, 'NEEDS NEW AUTHORITY': 8,
};
const ordered = [...results].sort((a, b) => (RANK[a.v] || 9) - (RANK[b.v] || 9));
line(MD ? '\n## Implementation order (evidence-derived)\n' : '\n-- implementation order --');
if (MD) { line('| # | screen | verdict | what must happen first |'); line('|---|---|---|---|'); }
ordered.forEach((r, i) => {
  const pre = r.v.startsWith('SAFE') ? 'nothing — build on the asserted authority'
    : r.v === 'NEEDS AUTHORIZATION HARDENING' ? 'add an ownership assert to the authority'
    : r.v === 'BLOCKED — NOT DEPLOYED' ? 're-export in functions/index.js + Functions deploy'
    : r.v === 'BLOCKED — UNSATISFIABLE GATE' ? 'replace the numeric-role gate with the canonical claim check'
    : r.v === 'BLOCKED — ADMIN ONLY' ? 'a merchant-callable authority must be created'
    : r.v === 'NEEDS NEW AUTHORITY' ? 'design and build a server authority'
    : 'resolve the unknown before scheduling';
  line(MD ? `| ${i + 1} | ${r.sc.screen} | **${r.v}** | ${pre} |` : `   ${i + 1}. ${r.sc.screen.padEnd(14)} ${r.v}`);
});

if (hardFail) { console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.'); process.exit(1); }
console.log(out.join('\n'));
