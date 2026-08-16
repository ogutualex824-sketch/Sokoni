#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   RECEIPTS / TAX AUTHORITY CENSUS — Stage 1, read-only
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-receipts-tax-authority.js
         node scripts/census-receipts-tax-authority.js --md \
              > docs/MERCHANT_RECEIPTS_TAX_AUTHORITY.md

   No UI changes. No repairs. No backfill. No deployment.

   Every row below was produced by opening the function body. Names and generic
   patterns were not sufficient in the previous four censuses and are not
   sufficient here: `verifyTrustReceipt` handles receipts and is public by
   design; `emailTrustReceipt` handles receipts and checks nothing.

   The decisive question for the receipt LIST is mechanical, not editorial:
   the `posReceipts` rule gates client reads on `resource.data.sellerId`, so
   this script extracts the literal field set each writer emits and reports
   which writers can ever satisfy that gate. That result is computed, not
   asserted in prose.

   NEGATIVE CONTROLS abort the run.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const MD = process.argv.includes('--md');
const out = [];
const line = (s = '') => out.push(s);
let hardFail = 0;
const must = (l, ok, d) => { if (!ok) { hardFail++; console.error('CONTROL FAILED: ' + l + (d ? ' — ' + d : '')); } };

const read = (f) => { try { return fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };

/* Brace-matched extraction. A fixed-line window bled into neighbouring
   functions in the 2D-2 census; delimiters are the only honest boundary. */
function balanced(src, startIdx, open, close) {
  let d = 0;
  for (let i = startIdx; i < src.length; i++) {
    const c = src[i];
    if (c === open) d++;
    else if (c === close) { d--; if (d === 0) return src.slice(startIdx, i + 1); }
  }
  return '';
}
function objectAt(src, anchorRe) {
  const m = anchorRe.exec(src);
  if (!m) return '';
  return balanced(src, src.indexOf('{', m.index), '{', '}');
}
function bodyOf(src, name) {
  const re = new RegExp('(?:^const |^exports\\.)' + name + '\\s*=\\s*on(?:Call|Request)\\b', 'm');
  const m = re.exec(src);
  if (!m) return '';
  return balanced(src, src.indexOf('(', m.index), '(', ')');
}
/* Top-level keys of an object literal, ignoring nested objects/arrays. */
function topKeys(objSrc) {
  const keys = [];
  let d = 0, inStr = null;
  for (let i = 0; i < objSrc.length; i++) {
    const c = objSrc[i];
    if (inStr) { if (c === inStr && objSrc[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{' || c === '[' || c === '(') { d++; continue; }
    if (c === '}' || c === ']' || c === ')') { d--; continue; }
    if (d === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(objSrc.slice(i));
      if (m && !/[\w$]/.test(objSrc[i - 1] || '')) { keys.push(m[1]); i += m[0].length - 1; }
      /* shorthand `merchantId,` */
      const s = /^([A-Za-z_$][\w$]*)\s*[,}]/.exec(objSrc.slice(i));
      /* advance past the identifier only — never past the closing brace, or
         the depth counter would lose a level */
      if (!m && s && !/[\w$.]/.test(objSrc[i - 1] || '')) { keys.push(s[1]); i += s[1].length - 1; }
    }
  }
  return keys;
}

const PT = read('functions/payment-trust.js');
const PZF = read('functions/pos-zero-friction.js');
const PRETAIL = read('functions/pos-retail.js');
const ETIMS = read('functions/etims.js');
const AJH = read('functions/async-job-handlers.js');
const INDEX = read('functions/index.js');
const FINOSR = read('functions/finos-router.js');
const PIA = read('functions/pos-integrations-api.js');
const HUBE = read('functions/hub-etims.js');
const RULES = read('firestore.rules');

/* ══ NEGATIVE CONTROLS ═══════════════════════════════════════════════════════
   Each proves a detector can distinguish, not merely that it returns something.
   ═══════════════════════════════════════════════════════════════════════════ */
must('payment-trust.js readable', PT.length > 5000);
must('etims.js readable', ETIMS.length > 20000);
must('rules readable', RULES.length > 5000);

must('bodyOf true positive', bodyOf(PT, 'emailTrustReceipt').includes('receiptNo'));
must('bodyOf true negative', bodyOf(PT, 'thisFunctionDoesNotExist') === '');
must('bodyOf does not bleed into the next function',
  !bodyOf(PT, 'voidTrustReceipt').includes('emailTrustReceipt'));

const _probe = objectAt('const x = { a: 1, b: { c: 2 }, d };', /const x =/);
must('topKeys finds shorthand and skips nesting',
  JSON.stringify(topKeys(_probe)) === JSON.stringify(['a', 'b', 'd']),
  'got ' + JSON.stringify(topKeys(_probe)));

must('ownership detector true negative (emailTrustReceipt really has no owner check)',
  !/auth\.uid\s*!==|permission-denied|_assertAdmin/.test(bodyOf(PT, 'emailTrustReceipt')));
must('ownership detector true positive (etimsGenerateInvoice really has one)',
  /order\.sellerUid\s*!==\s*sellerUid/.test(bodyOf(ETIMS, 'etimsGenerateInvoice')));

/* ══ The decisive computation: posReceipts writers vs the read rule ══════════ */
const WRITERS = [
  { site: 'functions/pos-zero-friction.js:360', via: 'posCompleteCheckout (POS sale)',
    obj: objectAt(PZF, /const receipt = \{/) },
  { site: 'functions/payment-trust.js:85', via: 'generateTrustReceipt (SOKONI Pay)',
    obj: objectAt(PT, /const receiptDoc = \{/) },
  { site: 'functions/index.js:7978', via: 'M-Pesa checkout callback',
    obj: objectAt(INDEX, /collection\("posReceipts"\)\.doc\(apiRef\)\.create\(/) },
  { site: 'functions/async-job-handlers.js:130', via: 'RECEIPT async job',
    obj: objectAt(AJH, /collection\('posReceipts'\)\.doc\(receiptId\)\.set\(/) },
];
for (const w of WRITERS) {
  must('writer object extracted: ' + w.site, w.obj.length > 40);
  w.keys = topKeys(w.obj);
  w.hasSellerId = w.keys.includes('sellerId');
  w.hasMerchantId = w.keys.includes('merchantId');
}
must('writer field detector discriminates',
  WRITERS.some((w) => w.hasSellerId) && WRITERS.some((w) => !w.hasSellerId),
  'a detector that answered the same for every writer would prove nothing');

const RULE_BLOCK = (() => {
  const i = RULES.indexOf('match /posReceipts/');
  if (i < 0) return '';
  /* The first `{` after `match` is the path wildcard `{receiptId}`, not the
     block. Take the brace that opens the body — the last one on the match line. */
  const eol = RULES.indexOf('\n', i);
  return balanced(RULES, RULES.lastIndexOf('{', eol), '{', '}');
})();
must('posReceipts rule block located', RULE_BLOCK.includes('allow read'));
const RULE_GATES_SELLERID = /resource\.data\.sellerId\s*==\s*request\.auth\.uid/.test(RULE_BLOCK);
must('rule gate detector true positive', RULE_GATES_SELLERID);

const satisfying = WRITERS.filter((w) => w.hasSellerId);

/* ══ Rows — each read from its body ═════════════════════════════════════════ */
const ROWS = [
  /* ── Receipts ───────────────────────────────────────────────────────────── */
  { group: 'Receipts', name: 'generateTrustReceipt', file: 'payment-trust.js',
    auth: '_assertAuth',
    scope: 'client `merchantId`, CORROBORATED: sellers/{merchantId}.uid === auth.uid, else admin claim',
    identity: 'sellers/{merchantId}.uid — a THIRD ownership vocabulary',
    verdict: 'SAFE',
    note: 'The server decides. Recorded only because the ownership spelling is a third variant (`sellers/{id}.uid`) alongside `sellerUid` and `ownerId`.' },

  { group: 'Receipts', name: 'emailTrustReceipt', file: 'payment-trust.js',
    auth: '_assertAuth — and nothing else',
    scope: 'client `receiptNo` + client `email`; the receipt is fetched and mailed with NO ownership check',
    identity: 'none',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    note: 'Any signed-in account can have any receipt emailed to any address it chooses. The mail body carries merchant name, line items, totals and customer name.' },

  { group: 'Receipts', name: 'voidTrustReceipt', file: 'payment-trust.js',
    auth: '_assertAdmin', scope: 'admin only', identity: 'n/a',
    verdict: 'BLOCKED', note: 'Admin-only by design. Not a merchant authority.' },

  { group: 'Receipts', name: 'verifyTrustReceipt', file: 'payment-trust.js',
    auth: 'none', scope: 'public receipt-number lookup', identity: 'n/a',
    verdict: 'PUBLIC BY DESIGN',
    note: 'This is the point of a trust receipt — a buyer verifies it without an account. It is NOT merchant authority and must not be used as one.' },

  { group: 'Receipts', name: 'sendPOSReceipt', file: 'pos-retail.js',
    auth: 'request.auth only',
    scope: 'the ENTIRE receipt (`sale`) is client-composed; recipient phone/email client-supplied; no Firestore read of the sale',
    identity: 'client `customerId`, written to posReceiptLog unvalidated',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    note: 'No disclosure (nothing is read back), but any signed-in account can send SOKONI-branded receipt email/SMS with arbitrary contents to arbitrary recipients. Outbound-messaging abuse, not IDOR.' },

  { group: 'Receipts', name: 'posLogReprint', file: 'pos-zero-friction.js',
    auth: '_assertAuth',
    scope: 'client `orderId` (no ownership check) and client `merchantId` (stamped into the audit record)',
    identity: 'client-supplied merchantId, uncorroborated',
    verdict: 'CLIENT-SCOPE / UNSAFE',
    note: 'Audit integrity: reprint events can be attributed to a merchant the caller has nothing to do with, and any order\'s reprint counter can be incremented by anyone.' },

  { group: 'Receipts', name: 'finosGenerateReceipt', file: 'finos-router.js',
    auth: '_assertAuth',
    scope: 'SELF-scoped — receipt is written with buyerUid/generatedBy = auth.uid and emailed to the caller',
    identity: 'auth.uid',
    verdict: 'SAFE AFTER HARDENING',
    note: 'No cross-tenant exposure: a caller can only mint a receipt attributed to itself. But amounts/commission come from request.data with no transaction corroboration, so `receipts/` is not a trustworthy financial record. Not a merchant-list authority.' },

  { group: 'Receipts', name: 'posReceipts (client read)', file: 'firestore.rules',
    auth: 'isAuthed()',
    scope: 'resource.data.sellerId == request.auth.uid || isAdmin(); writes CF-only',
    identity: 'sellerId',
    verdict: 'NEW AUTHORITY REQUIRED',
    note: 'See the writer table — the field the gate reads is not written by the paths that actually create merchant receipts.' },

  /* ── Tax / eTIMS ────────────────────────────────────────────────────────── */
  { group: 'Tax / eTIMS', name: 'etimsGetProfile', file: 'etims.js',
    auth: 'req.auth', scope: 'etimsProfiles/{req.auth.uid} — the uid IS the doc id',
    identity: 'auth.uid (ACCOUNT-scoped)', verdict: 'SAFE',
    note: 'No client identity accepted. Nothing to harden.' },

  { group: 'Tax / eTIMS', name: 'etimsUpdateProfile', file: 'etims.js',
    auth: 'req.auth', scope: 'etimsProfiles/{req.auth.uid}; field allow-list',
    identity: 'auth.uid (ACCOUNT-scoped)', verdict: 'SAFE',
    note: 'Allow-list excludes credentials. Self-scoped.' },

  { group: 'Tax / eTIMS', name: 'etimsRegisterSeller', file: 'etims.js',
    auth: 'req.auth', scope: 'etimsProfiles/{req.auth.uid}; KRA PIN format + live KRA check in prod',
    identity: 'auth.uid (ACCOUNT-scoped)', verdict: 'SAFE',
    note: 'Refuses to overwrite an existing active profile.' },

  { group: 'Tax / eTIMS', name: 'etimsValidatePin', file: 'etims.js',
    auth: 'none (pure format check)', scope: 'no data access at all', identity: 'n/a',
    verdict: 'SAFE', note: 'Regex only; touches nothing.' },

  { group: 'Tax / eTIMS', name: 'etimsGetSellerStats', file: 'etims.js',
    auth: 'req.auth', scope: 'etimsInvoices where sellerUid == auth.uid',
    identity: 'auth.uid', verdict: 'SAFE',
    note: 'Query is BY the uid; no client filter is accepted.' },

  { group: 'Tax / eTIMS', name: 'etimsGenerateInvoice', file: 'etims.js',
    auth: 'req.auth', scope: 'orders/{orderId}; rejects unless order.sellerUid === auth.uid',
    identity: 'auth.uid', verdict: 'SAFE AFTER HARDENING',
    note: 'Ownership is correct. One input-integrity note: `req.data.buyerKraPin` is placed on a KRA submission unvalidated — the merchant is the legal submitter, so this is an input-validation item, not an access-control one.' },

  { group: 'Tax / eTIMS', name: 'etimsBulkGenerate', file: 'etims.js',
    auth: 'req.auth', scope: 'orders where sellerUid == auth.uid; requires own active profile; idempotency key derived from uid',
    identity: 'auth.uid', verdict: 'SAFE', note: 'Self-scoped end to end.' },

  { group: 'Tax / eTIMS', name: 'etimsResubmitInvoice', file: 'etims.js',
    auth: 'req.auth', scope: 'etimsInvoices/{id}; rejects unless inv.sellerUid === auth.uid or admin',
    identity: 'auth.uid', verdict: 'SAFE', note: 'Read-then-check-then-write, correct order.' },

  { group: 'Tax / eTIMS', name: 'etimsGetBuyerReceipts', file: 'etims.js',
    auth: 'req.auth', scope: 'orders where buyerUid == auth.uid, then invoices for those orderIds',
    identity: 'auth.uid (BUYER)', verdict: 'SAFE',
    note: 'A buyer authority, not a merchant one. Correct, but it does not belong on a Merchant surface.' },

  { group: 'Tax / eTIMS', name: 'etimsDownloadReceipt', file: 'etims.js (onRequest)',
    auth: 'Bearer ID token, verifyIdToken',
    scope: 'seller (inv.sellerUid) | buyer (inv.buyerUid or order.buyerUid) | admin; else 403',
    identity: 'decoded.uid', verdict: 'SAFE',
    note: 'An HTTP endpoint that authorises properly. Worth citing as the pattern the receipt list should follow.' },

  { group: 'Tax / eTIMS', name: 'posGetEtimsExport', file: 'pos-integrations-api.js (onRequest)',
    auth: 'API key + read permission',
    scope: 'client `sellerId` CORROBORATED against keyDoc.sellerId, else 403',
    identity: 'keyDoc.sellerId', verdict: 'SAFE',
    note: 'The correct shape for a client-supplied scope id: accepted, then proven against a server-held record.' },

  { group: 'Tax / eTIMS', name: 'etimsGetAdminStats', file: 'etims.js',
    auth: '_ac.isAdmin', scope: 'platform-wide', identity: 'n/a',
    verdict: 'BLOCKED', note: 'Admin-only. Not a merchant authority.' },

  { group: 'Tax / eTIMS', name: 'etimsPlatformInvoice', file: 'etims.js',
    auth: '_ac.isAdmin', scope: 'platform KRA credentials', identity: 'n/a',
    verdict: 'BLOCKED', note: 'Admin-only. Uses platform PIN, not the merchant\'s.' },

  { group: 'Tax / eTIMS', name: 'hubUpdateTaxConfig', file: 'hub-etims.js',
    auth: 'requireAdmin', scope: 'hubs/{hubId}', identity: 'n/a',
    verdict: 'BLOCKED', note: 'Hub tax config is an admin surface; a merchant cannot reach it.' },

  { group: 'Tax / eTIMS', name: 'hubRegisterEtims', file: 'hub-etims.js',
    auth: 'requireAdmin', scope: 'hubs/{hubId}', identity: 'n/a',
    verdict: 'BLOCKED', note: 'Admin-only hub-level eTIMS registration.' },

  { group: 'Tax / eTIMS', name: 'calculateTaxBreakdown', file: 'finos.js',
    auth: '_assertAuth', scope: 'pure calculation over request.data; sellerId explicitly passed as null',
    identity: 'none', verdict: 'SAFE',
    note: 'Stateless calculator, reads no merchant data. Safe to bind, but it computes a quote — it is not a record of tax actually charged.' },
];

/* ══ Report ═════════════════════════════════════════════════════════════════ */
line(MD ? '# Merchant Receipts / Tax — Authority Census' : 'RECEIPTS / TAX AUTHORITY CENSUS');
line('');
if (MD) {
  line('**Stage 1 — read-only.** No UI changes, no repairs, no backfill, no deployment.');
  line('');
  line('Generated by `scripts/census-receipts-tax-authority.js`. Every row was produced by');
  line('opening the function body. Re-run with:');
  line('');
  line('```');
  line('node scripts/census-receipts-tax-authority.js --md > docs/MERCHANT_RECEIPTS_TAX_AUTHORITY.md');
  line('```');
  line('');
}

line(MD ? '## The receipt list: what the rule reads vs what the writers write' : '-- posReceipts writers --');
line('');
if (MD) {
  line('The `posReceipts` read rule is:');
  line('');
  line('```');
  RULE_BLOCK.split('\n').forEach((l) => line(l.trim() ? '  ' + l.trim() : ''));
  line('```');
  line('');
  line('| writer | path | writes `sellerId`? | writes `merchantId`? |');
  line('|---|---|---|---|');
  for (const w of WRITERS) {
    line(`| \`${w.via}\` | ${w.site} | ${w.hasSellerId ? '**yes**' : 'no'} | ${w.hasMerchantId ? 'yes' : 'no'} |`);
  }
  line('');
  line(`Writers that can ever satisfy the gate: **${satisfying.length} of ${WRITERS.length}** — ` +
    satisfying.map((w) => '`' + w.via + '`').join(', ') + '.');
  line('');
  line('The three paths that actually produce merchant receipts — the POS sale, the SOKONI Pay');
  line('trust receipt, and the M-Pesa marketplace checkout — all write `merchantId` and no');
  line('`sellerId`. A merchant querying its own receipts from the browser is denied on every one');
  line('of them.');
  line('');
  line('This is the **fifth** instance of *rules gating on a field nothing writes*, after');
  line('`shopEmployees.sellerUid`, `disputes.sellerUid`, `posCustomers.sellerId` and');
  line('`minishopAnalytics.ownerUid`. It differs from the other four in one way that makes it');
  line('worse rather than better: one writer *does* emit `sellerId`, so the rule is not visibly');
  line('dead. It returns a partial, silently incomplete list instead of an error.');
  line('');
  line('So the honest classification for a merchant receipt list is **NEW AUTHORITY REQUIRED**,');
  line('not *SAFE (rules-scoped)*. The Firestore read is genuinely protected — it is just');
  line('protected against the merchant as well.');
  line('');
} else {
  for (const w of WRITERS) line(`   ${w.hasSellerId ? 'sellerId ' : 'NO sellerId'}  ${w.via}  (${w.site})`);
  line(`   satisfy the rule: ${satisfying.length}/${WRITERS.length}`);
}

for (const g of ['Receipts', 'Tax / eTIMS']) {
  line(MD ? `\n## ${g}\n` : `\n-- ${g} --`);
  if (MD) {
    line('| capability | auth | scope decided by | classification |');
    line('|---|---|---|---|');
    for (const r of ROWS.filter((x) => x.group === g)) {
      line(`| \`${r.name}\`<br><sub>${r.file}</sub> | ${r.auth} | ${r.scope} | **${r.verdict}** |`);
    }
    line('');
    for (const r of ROWS.filter((x) => x.group === g)) line(`- **\`${r.name}\`** — ${r.note}`);
  } else {
    for (const r of ROWS.filter((x) => x.group === g)) line(`   ${r.verdict.padEnd(24)} ${r.name}`);
  }
}

/* ══ Identity question ══════════════════════════════════════════════════════ */
line(MD ? '\n## Is the tax authority account-scoped or shop-scoped?\n' : '\n-- tax identity --');
if (MD) {
  line('**Account-scoped, and it introduces no new merchant identity.**');
  line('');
  line('`etimsProfiles/{auth.uid}` uses the Firebase uid *directly as the document id*. It does not');
  line('resolve through `sellers/{id}`, `merchants/{id}`, `shops/{shopId}` or a claim. Every');
  line('merchant-facing eTIMS callable then derives `sellerUid` from `req.auth.uid` and queries');
  line('`etimsInvoices where sellerUid == uid` or checks `order.sellerUid === uid`.');
  line('');
  line('That is the cleanest identity handling found in any census in this track: there is nothing');
  line('to converge and no legacy `merchants/{merchantId}` model to resurrect. The eTIMS path does');
  line('not need one and must not be given one.');
  line('');
  line('The consequence to record — a limitation, not a defect — is that tax identity has **no shop');
  line('dimension**. A seller operating two shops has one KRA PIN, one invoice prefix and one');
  line('invoice sequence across both. That is very likely correct in Kenyan tax law (the PIN belongs');
  line('to the taxpayer, not the outlet), but it means a Merchant Tax surface must be labelled as an');
  line('**account-level** setting, not a per-shop one, or it will read as a bug the first time a');
  line('two-shop seller opens it.');
  line('');
  line('By contrast the receipt side carries **three** merchant spellings — `merchantId` (POS and');
  line('M-Pesa receipts), `sellerId` (async job receipts and the rule), and `sellers/{id}.uid`');
  line('(`generateTrustReceipt`\'s ownership proof). These are not yet established as an authority');
  line('conflict versus writer-specific representations; that determination belongs to the receipt');
  line('authority work, not to this census.');
  line('');
}

/* ══ Classification ═════════════════════════════════════════════════════════ */
line(MD ? '\n## Classification\n' : '\n-- classification --');
const byVerdict = {};
for (const r of ROWS) (byVerdict[r.verdict] = byVerdict[r.verdict] || []).push(r.name);
const ORDER = ['SAFE', 'SAFE AFTER HARDENING', 'CLIENT-SCOPE / UNSAFE', 'BLOCKED',
  'NEW AUTHORITY REQUIRED', 'PUBLIC BY DESIGN'];
if (MD) {
  line('| classification | capabilities |');
  line('|---|---|');
  for (const v of ORDER) {
    line(`| **${v}** | ${(byVerdict[v] || []).map((n) => '`' + n + '`').join(', ') || '—'} |`);
  }
  line('');
  line('### What a Receipts/Tax stage could build on today');
  line('');
  line('The entire **Tax** surface is available and server-decided: profile read/update/register,');
  line('PIN format check, seller stats, manual and bulk invoice generation, resubmission, and the');
  line('authorised HTML receipt download. That is a complete, coherent merchant Tax screen with');
  line('nothing to fix first — provided it is labelled account-level.');
  line('');
  line('`generateTrustReceipt` is safe to call for issuing a receipt.');
  line('');
  line('### What must not be built yet');
  line('');
  line('- **A merchant receipt list.** There is no authority for it. Reading `posReceipts` from the');
  line('  client returns a silently partial list; adding a callable that accepts a `merchantId` would');
  line('  repeat the `posLookupCustomer` defect exactly.');
  line('- **Anything calling `emailTrustReceipt`, `sendPOSReceipt` or `posLogReprint`** until they are');
  line('  scoped. Binding them into Merchant would put a supported button on top of three open holes.');
  line('- **Receipt reprint counts or `receipts/` financial figures as displayed metrics** — both are');
  line('  writable by any caller, so showing them would violate the no-fabricated-metrics rule.');
  line('');
  line('### Findings recorded for separate security stages, not fixed here');
  line('');
  line('| # | finding | severity |');
  line('|---|---|---|');
  line('| 1 | `emailTrustReceipt` mails any receipt to any address for any signed-in caller | **high** — PII disclosure, IDOR on a guessable receipt number |');
  line('| 2 | `sendPOSReceipt` delivers arbitrary client-composed SOKONI-branded receipts to arbitrary recipients | **high** — brand spoofing + outbound-messaging abuse |');
  line('| 3 | `posLogReprint` accepts an uncorroborated `merchantId` and mutates any order\'s reprint counter | **medium** — audit integrity |');
  line('| 4 | `posGetQueueMetrics` (adjacent, same file) queries `posCheckoutMetrics` by a client-supplied `merchantId` with no ownership check | **medium** — cross-tenant read |');
  line('| 5 | `finosGenerateReceipt` mints a `receipts/` document with client-supplied amounts | **low** — self-scoped, but the collection is not a trustworthy record |');
  line('| 6 | `posReceipts` rule gates on `sellerId`; 3 of 4 writers emit `merchantId` | **medium** — silently partial reads |');
  line('');
  line('Findings 1 and 2 are the same class as the already-fixed `posLookupCustomer` defect');
  line('(`9360cbd`) and the already-fixed `orderAdvance` defect (`1d49634`): authenticated was');
  line('treated as authorised. They are listed here and deliberately not fixed in a census stage.');
  line('');
  line('### Queue impact');
  line('');
  line('Receipts and Tax are not one screen and should not be sequenced as one. **Tax is ready');
  line('now**; **Receipts is blocked** behind a new authority plus three security fixes. Fulfilment /');
  line('Delivery remains ahead of both, per `docs/MERCHANT_2D2_QUEUE.md`.');
} else {
  for (const v of ORDER) if (byVerdict[v]) line('   ' + v + ': ' + byVerdict[v].join(', '));
}

if (hardFail) {
  console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.');
  process.exit(1);
}
console.log(out.join('\n'));
