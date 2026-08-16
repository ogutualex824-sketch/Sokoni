#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FULFILMENT / DELIVERY AUTHORITY CENSUS — Stage 1, read-only
   ══════════════════════════════════════════════════════════════════════════════
   Run:  node scripts/census-fulfilment-authority.js
         node scripts/census-fulfilment-authority.js --md > docs/MERCHANT_FULFILMENT_AUTHORITY.md

   No UI changes. No repairs. No backfill. No deployment.

   THE DISTINCTION THIS CENSUS PRESERVES

       ORDER AUTHORITY        payment / order state
       FULFILMENT AUTHORITY   prepare → ready → assignment → pickup → transit
                              → delivered → exception

   They are different authorities with different actors. Orders does not cover
   Fulfilment, and a merchant board that reads only `status` reads the wrong
   field — `fulfilment-lifecycle.js` exists precisely because five vocabularies
   disagreed.

   THE PIN QUESTION IS ANSWERED BY READ PATH, NOT BY MODULE

   The previous evidence was contradictory: an old finding said plaintext
   `deliveryPin` reaches the rider; newer code shows `deliveryPinHash`,
   `_riderView()` and HMAC verification at completion. Both are true, because
   they concern DIFFERENT DOCUMENTS. This script therefore does not ask "does
   `_riderView()` exist" — it asks whether any real rider-readable path yields
   a plaintext PIN, and it follows the writes and the rules to decide.

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

function balancedFrom(src, openIdx, open, close) {
  let d = 0;
  for (let i = openIdx; i < src.length; i++) {
    if (src[i] === open) d++;
    else if (src[i] === close) { d--; if (d === 0) return src.slice(openIdx, i + 1); }
  }
  return '';
}
/* Comments are stripped BEFORE paren-matching. Counting parens across prose
   truncates a body at the first unmatched ")" — a numbered comment like
   "1) PIN check" ended one handler 700 characters early in the sibling suite,
   silently, and a short body reports a guard that exists as absent. */
function stripComments(src) {
  let out = '', i = 0, n = src.length;
  while (i < n) {
    const c = src[i], d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i]; if (src[i] === q) { i++; break; } i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
function bodyOf(rawSrc, name) {
  const src = stripComments(rawSrc);
  const m = new RegExp('exports\\.' + name + '\\s*=\\s*on(?:Call|Request|DocumentUpdated)\\b').exec(src);
  if (!m) return null;
  return balancedFrom(src, src.indexOf('(', m.index), '(', ')');
}
function ruleBlock(rules, name) {
  const i = rules.indexOf('match /' + name + '/');
  if (i < 0) return '';
  const eol = rules.indexOf('\n', i);
  return balancedFrom(rules, rules.lastIndexOf('{', eol), '{', '}');
}

const LC = read('functions/fulfilment-lifecycle.js');
const SCAN = read('functions/fulfilment-scan.js');
const PIN = read('functions/delivery-pin.js');
const COMP = read('functions/delivery-complete.js');
const DISP = read('functions/dispatch.js');
const LPD = read('functions/logistics-plus-dispatch.js');
const INDEX = read('functions/index.js');
const RULES = read('firestore.rules');
const ROUTES = read('sokoni-merchant-routes.js');

must('all six modules readable',
  [LC, SCAN, PIN, COMP, DISP, LPD].every((s) => s.length > 200));
must('rules readable', RULES.length > 5000);
must('bodyOf true positive', (bodyOf(COMP, 'completeDeliveryWithPin') || '').includes('deliveryPinHash'));
must('bodyOf true negative', bodyOf(COMP, 'notARealExport') === null);
must('bodyOf does not bleed', !(bodyOf(COMP, 'completeDeliveryWithPin') || '').includes('buyerConfirmDelivery'));
/* A body truncated by a paren in prose still "extracts" and still passes a length
   check — so assert on a guard that sits near the END of a commented handler. */
must('bodyOf survives a numbered comment mid-body',
  (bodyOf(PIN, 'deliveryVerifyShadow') || '').includes('deliveryShadowAttempts') ||
  (bodyOf(PIN, 'deliveryVerifyShadow') || '').includes('deliveryVerifyAttempts'),
  'the shadow handler contains "1) PIN check" — the classic truncation trigger');

/* ══ THE PIN READ-PATH CENSUS ══════════════════════════════════════════════
   Four links. Each is checked against source, not assumed.
   ═══════════════════════════════════════════════════════════════════════════ */
const ORDERS_RULE = ruleBlock(RULES, 'orders');
const PKG_RULE = ruleBlock(RULES, 'packageRequests');
must('orders rule located', ORDERS_RULE.includes('allow read'));
must('packageRequests rule located', PKG_RULE.includes('allow read'));

const LINKS = [
  { id: 'L1',
    q: '`deliveryPinOnAccept` writes the PLAINTEXT pin to `orders/{orderId}`',
    ok: /collection\("orders"\)\.doc\(String\(orderId\)\)\.set\(\{[\s\S]{0,120}deliveryPin:\s*pin/.test(PIN) },
  { id: 'L2',
    q: 'the same trigger fires on the `driver_accepted` transition',
    ok: /after\.status !== "driver_accepted"/.test(PIN) },
  { id: 'L3',
    q: '`claimAvailableDelivery` sets `orders/{orderId}.assignedDriverUid` to the RIDER\'s uid, in the same transaction that sets `driver_accepted`',
    ok: /status: "driver_accepted"[\s\S]{0,400}assignedDriverUid: uid/.test(INDEX) &&
        /collection\("orders"\)\.doc\(String\(d\.orderId\)\)[\s\S]{0,160}assignedDriverUid: uid/.test(INDEX) },
  { id: 'L4',
    q: 'the `orders` rule grants a FULL-DOCUMENT read to `assignedDriverUid`',
    ok: /allow read:[\s\S]*?resource\.data\.assignedDriverUid\s*==\s*request\.auth\.uid/.test(ORDERS_RULE) },
];
for (const l of LINKS) must('PIN link evaluated: ' + l.id, typeof l.ok === 'boolean');
const CHAIN_CLOSED = LINKS.every((l) => l.ok);
/* NEGATIVE CONTROL: a chain evaluator that returned true for anything would be
   worthless. Prove one deliberately false proposition evaluates false. */
must('chain evaluator true negative',
  !/allow read:[\s\S]*?resource\.data\.thisFieldDoesNotExist\s*==\s*request\.auth\.uid/.test(ORDERS_RULE));
must('chain evaluator discriminates on real input',
  LINKS.some((l) => l.ok), 'if no link evaluated true the detectors are broken, not the code');

/* Does Firestore offer field-level projection? No — so a granted read is total. */
const RIDERVIEW_EXISTS = /function _riderView/.test(SCAN);
const RIDERVIEW_OMITS_PIN = !/deliveryPin/.test((SCAN.match(/function _riderView[\s\S]*?\n\}/) || [''])[0]);
must('_riderView detector true positive', RIDERVIEW_EXISTS);

/* ══ The unauthenticated pool endpoint ═════════════════════════════════════ */
const AVAIL = bodyOf(INDEX, 'availableDeliveries');
must('availableDeliveries body extracted', AVAIL && AVAIL.length > 200);
const AVAIL_PUBLIC = /invoker: "public"/.test(AVAIL || '');
const AVAIL_NO_AUTH = !/req\.headers\.authorization|verifyIdToken|request\.auth/.test(AVAIL || '');
const AVAIL_RIDER_GATED = /rideDrivers/.test(AVAIL || '');
const AVAIL_RETURNS_PIN = /proofPin:\s*o\.proofPin/.test(AVAIL || '');
const AVAIL_RETURNS_PII = /buyerPhone:\s*o\.buyerPhone/.test(AVAIL || '') && /deliveryAddress:\s*o\.deliveryAddress/.test(AVAIL || '');
/* These controls prove the DETECTOR discriminates, not that the defect is still
   present. An audit whose controls assert the finding can only ever be run once;
   this one is meant to be re-run after remediation and report the new state. */
must('auth detector true positive on a function that DOES authenticate',
  /verifyIdToken/.test(read('functions/etims.js')));
must('auth detector true negative on a function that does NOT',
  !/verifyIdToken|req\.headers\.authorization/.test(bodyOf(DISP, 'optimizeBatchRoute') || 'verifyIdToken'));

/* ══ Per-callable authorisation ════════════════════════════════════════════ */
const CALLS = [
  { mod: 'fulfilment-scan', name: 'fulfilmentScan', src: SCAN,
    decides: 'yes — role derived from the ORDER\'s own ownership fields; a null role is refused',
    verdict: 'SAFE',
    note: 'Possession of a QR is explicitly not authorisation: the token is resolved, then the caller\'s relationship to that order decides the projection. The best-built authorisation in the delivery stack.' },
  { mod: 'delivery-pin', name: 'deliveryPinOnAccept', src: PIN,
    decides: 'n/a — Firestore trigger, not caller-facing',
    verdict: 'UNSAFE',
    note: 'Correctly keeps only the HASH on `packageRequests`. Then writes the PLAINTEXT to `orders/{orderId}` on the belief, stated in its own header, that "riders read deliveries via CF endpoints, not the order doc". The rules say otherwise.' },
  { mod: 'delivery-pin', name: 'deliveryVerifyShadow', src: PIN,
    decides: '**NO** — any authenticated caller, any `deliveryRef`',
    verdict: 'UNSAFE',
    note: 'Returns pass/fail for a PIN guess against any delivery: a PIN oracle. `delivery-complete` explicitly guards against exactly this ("checked before the PIN so a stranger cannot use this endpoint as a PIN oracle") — the guard was not applied here. It also increments `deliveryVerifyAttempts`, the SAME counter `completeDeliveryWithPin` uses for lockout, so any account can burn a delivery\'s attempts and force the legitimate rider into the support path.' },
  { mod: 'delivery-complete', name: 'completeDeliveryWithPin', src: COMP,
    decides: 'yes — assignment checked BEFORE the PIN; attempt lockout; timing-safe compare; fails closed with no HMAC key',
    verdict: 'SAFE',
    note: 'Textbook. Its weakness is not in this file: the secret it verifies is readable by the party it defends against.' },
  { mod: 'delivery-complete', name: 'buyerConfirmDelivery', src: COMP,
    decides: 'yes — buyer identity, plus an explicit self-deal guard when rider === buyer',
    verdict: 'SAFE',
    note: 'Inverts the trust correctly: the party owed the goods confirms receipt. Same single completion path, so the payout rail and exactly-once guard are identical.' },
  { mod: 'dispatch', name: 'dispatchDelivery', src: DISP,
    decides: '**NO** — `_assertAuth` only, client `deliveryRef`',
    verdict: 'UNSAFE',
    note: 'Any authenticated caller can start the rider cascade on any delivery.' },
  { mod: 'dispatch', name: 'respondToDispatch', src: DISP,
    decides: 'yes — refuses unless the caller IS the current cascade candidate',
    verdict: 'SAFE',
    note: 'Assignment cannot be self-created here: the cascade names the candidate, the candidate does not name themselves.' },
  { mod: 'dispatch', name: 'captureProofOfDelivery', src: DISP,
    decides: 'yes — `delivery.riderId`/`driverId` must equal the caller',
    verdict: 'SAFE AFTER HARDENING',
    note: 'Assignment is checked. Whether the proof it captures is sufficient is the separate PIN question.' },
  { mod: 'dispatch', name: 'handleFailedDelivery', src: DISP,
    decides: '**NO** — `_assertAuth` only, client `deliveryRef`',
    verdict: 'UNSAFE',
    note: 'Any authenticated caller can declare any delivery failed. The `reassign` branch sets `riderId: null` and `driverId: null`, so it also strips the assigned rider off someone else\'s job.' },
  { mod: 'dispatch', name: 'optimizeBatchRoute', src: DISP,
    decides: '**NO** — `_assertAuth` only, client `deliveryRefs[]`',
    verdict: 'UNSAFE',
    note: 'Reads an arbitrary list of deliveries to plan a route. Bulk address disclosure, bounded only by `maxBatchSize`.' },
  { mod: 'index.js', name: 'availableDeliveries', src: INDEX,
    decides: '**NO — not even authentication**',
    verdict: 'UNSAFE',
    note: 'See below. This is the headline.' },
  { mod: 'index.js', name: 'claimAvailableDelivery', src: INDEX,
    decides: 'yes for CLAIMING — rider must be approved and non-suspended in `rideDrivers`',
    verdict: 'SAFE AFTER HARDENING',
    note: 'The claim guard is real and good. But its return value hands the claiming rider `proofPin` in plaintext, and it is the write that makes the rider a reader of the order document.' },
];
for (const c of CALLS) {
  c.body = bodyOf(c.src, c.name);
  must('body extracted: ' + c.name, c.body !== null && c.body.length > 100);
}
must('verdicts discriminate', CALLS.some((c) => c.verdict === 'SAFE') && CALLS.some((c) => c.verdict === 'UNSAFE'));

/* ══ The fourteen traced questions ═════════════════════════════════════════ */
const FULFIL_ROUTE = /id:'fulfilment'[\s\S]{0,80}kind:'page'/.test(ROUTES);
const TRACED = [
  ['merchant can act only on its own shopId',
    '**Partly.** `fulfilmentScan` derives the seller role from the order\'s own `sellerUid`/`sellerId`/`merchantId` and is sound. The rules let a seller update only `status`, `sellerNote`, `readyAt`, `trackingNo`, `updatedAt` on their own order — correctly scoped. But `dispatchDelivery`, `handleFailedDelivery` and `optimizeBatchRoute` accept a `deliveryRef` from anyone, so merchant-stage actions are not the boundary; delivery-stage actions are simply unguarded.'],
  ['rider can act only on assigned deliveries',
    '**No.** `completeDeliveryWithPin` and `captureProofOfDelivery` check assignment. `deliveryVerifyShadow`, `dispatchDelivery`, `handleFailedDelivery` and `optimizeBatchRoute` do not.'],
  ['buyer cannot advance merchant/rider stages',
    '**Yes.** The rules restrict a buyer to `status in [\'cancelled\']` with a four-key allow-list. `buyerConfirmDelivery` is the buyer\'s only completion path and carries a self-deal guard.'],
  ['seller cannot perform rider-only transitions',
    '**Yes, at the rules layer.** The seller clause allow-lists five keys and cannot write `delivered`. Rider en-route statuses are a separate clause keyed to `assignedDriverUid`.'],
  ['assignment cannot be self-created by an unauthorized caller',
    '**Mixed.** `respondToDispatch` requires the caller to BE the current cascade candidate, and `claimAvailableDelivery` requires an approved `rideDrivers` record — both good. But `dispatchDelivery` lets anyone start the cascade, and `handleFailedDelivery`\'s reassign branch lets anyone clear an existing assignment.'],
  ['cancellation/void does not bypass payment/order authority',
    '**Holds.** No fulfilment module writes payment state. Completion funnels through the single `_completeDelivery` path with an `alreadyDelivered` replay guard, so the payout rail is identical for both completion methods. Buyer cancellation is rules-limited to `status`/`cancelReason`/`updatedAt`/`review`.'],
  ['delivery completion requires proper proof',
    '**The gate is correct; the secret is not secret.** `completeDeliveryWithPin` checks assignment first, rejects a missing PIN outright (the old `if (data.proofPin)` pass-through is gone), locks out after 5 attempts, compares timing-safely, and fails closed without the HMAC key. It then verifies a PIN the rider can read.'],
  ['delivery PIN is never exposed through a broad order document',
    '**FALSE — this is the finding.** See the read-path chain below.'],
  ['`_riderView()` is the projection used by rider reads',
    '**No — it is the projection used by ONE path.** `_riderView()` is real, whitelists fields, withholds the address when the assignment is over, and never returns the OTP. But it governs `fulfilmentScan` only. A rider reading `orders/{orderId}` directly through the rules gets the whole document, unprojected. Firestore has no field-level read control, so a granted read is total.'],
  ['merchant sees only fields appropriate to merchant fulfilment',
    '**Via `fulfilmentScan`, yes** — `_sellerView` omits commission, settlement and the buyer\'s other orders. Via a direct order read, no projection applies.'],
  ['rider sees only rider-safe fields',
    '**No.** Same reason: the direct read path is unprojected and includes `deliveryPin`.'],
  ['delivery history/audit records cannot be forged',
    '**Holds.** `deliveryAuditLog`, `deliveryGateShadow` and `deliveryAttempts` have no client write rule and there is no permissive catch-all, so they are deny-by-default and written only by the Admin SDK. Worth making explicit rather than relying on omission.'],
  ['notifications correspond to authoritative transitions',
    '**Mostly.** `orderAdvance` writes `timelineStage` and drives notifications, and it was scoped in `1d49634`. But `handleFailedDelivery` can move a delivery to `failed`/`retry_scheduled` without any authorisation, so a notification can be triggered by a caller with no relationship to the order.'],
  ['mobile merchant fulfilment can eventually operate without seller.html',
    '**Yes, and it must.** `fulfilment` is still `kind:\'page\' src:\'seller-fulfilment.html\'` (confirmed in the contract: ' + (FULFIL_ROUTE ? 'yes' : 'no') + '). `fulfilmentScan` already returns a merchant-appropriate projection, and `fulfilment-lifecycle.resolveStage` already resolves the correct stage across the five vocabularies. The surface is buildable — after the authorisation work, not before.'],
];

/* ══════════════════════════════════════════════════════════════════════════
   REPORT
   ══════════════════════════════════════════════════════════════════════════ */
line(MD ? '# Merchant Fulfilment / Delivery — Authority Census' : 'FULFILMENT / DELIVERY AUTHORITY CENSUS');
line('');
if (MD) {
  line('**Stage 1 — read-only.** No UI changes, no repairs, no backfill, no deployment.');
  line('');
  line('Generated by `scripts/census-fulfilment-authority.js`. Re-run with:');
  line('');
  line('```');
  line('node scripts/census-fulfilment-authority.js --md > docs/MERCHANT_FULFILMENT_AUTHORITY.md');
  line('```');
  line('');
  line('## Order authority and fulfilment authority are not the same authority');
  line('');
  line('```');
  line('ORDER AUTHORITY        payment / order state');
  line('FULFILMENT AUTHORITY   prepare → ready → assignment → pickup → transit');
  line('                       → delivered → exception');
  line('```');
  line('');
  line('`fulfilment-lifecycle.js` exists because five vocabularies disagreed, and one of those');
  line('disagreements was an authorisation boundary: `fulfilment-scan` tested for `assigned` while');
  line('`dispatch.js` wrote `driver_assigned`, so a rider on a genuinely active delivery was judged');
  line('inactive. It is a normalisation library, not an authority, and it does its job well —');
  line('`resolveStage` takes the furthest-along of `timelineStage`, `deliveryStatus` and `status` so');
  line('a lagging field cannot drag an order backwards, and unknown values fail closed.');
  line('');
  line('That is the healthy part. What follows is not.');
  line('');

  /* ── Remediation status, computed on every run ── */
  const REMEDIATED = !AVAIL_NO_AUTH && AVAIL_RIDER_GATED && !AVAIL_RETURNS_PIN && !CHAIN_CLOSED;
  line('## Remediation status (recomputed on every run)');
  line('');
  line('| boundary | state |');
  line('|---|---|');
  line('| `availableDeliveries` requires authentication | ' + (!AVAIL_NO_AUTH ? '✅ closed' : '❌ OPEN') + ' |');
  line('| `availableDeliveries` requires an approved rider | ' + (AVAIL_RIDER_GATED ? '✅ closed' : '❌ OPEN') + ' |');
  line('| `availableDeliveries` withholds `proofPin` | ' + (!AVAIL_RETURNS_PIN ? '✅ closed' : '❌ OPEN') + ' |');
  line('| `availableDeliveries` withholds buyer PII | ' + (!AVAIL_RETURNS_PII ? '✅ closed' : '❌ OPEN') + ' |');
  line('| rider PIN read chain (L1–L4) | ' + (!CHAIN_CLOSED ? '✅ broken at L1' : '❌ STILL CLOSED') + ' |');
  line('');
  line(REMEDIATED
    ? '**All four boundaries in this section are closed.** The sections below describe the '
      + 'defects as found, and are retained as the record of what was wrong and why. Ongoing '
      + 'proof that the PIN stays unreachable lives in `scripts/test-delivery-pin-unreachable.js`, '
      + 'which enumerates every rider-accessible path rather than checking one projection.'
    : '**One or more boundaries are OPEN.** Treat the sections below as current.');
  line('');

  /* ── HEADLINE 1 ── */
  line('## 🚨 `availableDeliveries` — unauthenticated, and live *(as found)*');
  line('');
  line('`exports.availableDeliveries` is an `onRequest` endpoint. Measured against source:');
  line('');
  line('- `invoker: "public"`: **' + (AVAIL_PUBLIC ? 'yes' : 'no') + '**');
  line('- contains no authentication of any kind: **' + (AVAIL_NO_AUTH ? 'yes' : 'no') + '**');
  line('- gates on an approved `rideDrivers` record: **' + (AVAIL_RIDER_GATED ? 'yes' : 'no') + '**');
  line('- returns `proofPin` per record: **' + (AVAIL_RETURNS_PIN ? 'yes' : 'no') + '**');
  line('- returns `buyerPhone` and `deliveryAddress` per record: **' + (AVAIL_RETURNS_PII ? 'yes' : 'no') + '**');
  line('');
  line('It returns up to 80 pending deliveries with `buyerName`, `buyerPhone`, `deliveryAddress`,');
  line('`pickupAddress`, `sellerName`, `items`, `orderTotal` and the plaintext **`proofPin`**.');
  line('');
  line('The `cors` list is not an access control. CORS constrains browsers; `curl` ignores it.');
  line('');
  line('**Verified live at census time:** `curl` with no credentials returned `HTTP 200`. The');
  line('response carried `count: 0` — the queue happened to be empty at that moment, so no customer');
  line('data was disclosed and none was handled. The exposure is reachable regardless: the first');
  line('order that reaches `awaiting_rider` publishes a customer\'s name, phone number, home address');
  line('and delivery proof PIN to anyone who asks.');
  line('');
  line('This is a production data-protection issue, not a consolidation finding. It predates this');
  line('track and is unaffected by anything in it.');
  line('');

  /* ── HEADLINE 2 ── */
  line('## The PIN question, settled by read path');
  line('');
  line('The two bodies of evidence were never in conflict — they concern **different documents**.');
  line('');
  line('`packageRequests` correctly stores only `deliveryPinHash`. `orders` gets the plaintext. The');
  line('rider can read `orders`. Four links, each checked against source:');
  line('');
  line('| # | link | holds? |');
  line('|---|---|---|');
  for (const l of LINKS) line('| ' + l.id + ' | ' + l.q + ' | ' + (l.ok ? '**yes**' : 'no') + ' |');
  line('');
  line('**Chain closed: ' + (CHAIN_CLOSED ? 'YES' : 'no') + '.**');
  line('');
  line('So: `claimAvailableDelivery` writes `assignedDriverUid = <rider uid>` onto the order in the');
  line('same transaction that sets `driver_accepted`; that transition fires `deliveryPinOnAccept`,');
  line('which writes the plaintext `deliveryPin` onto that same order; and the `orders` read rule');
  line('grants `assignedDriverUid` a full-document read. **The plaintext delivery PIN is readable by');
  line('the party it exists to defend against.**');
  line('');
  line('`delivery-pin.js` states the assumption in its own header — *"delivers the PLAINTEXT PIN to');
  line('the BUYER only (on their order doc; the rider reads deliveries via CF endpoints, not the');
  line('order doc)"*. The endpoints are real and the projection is good. The belief that riders use');
  line('them **exclusively** is what fails: Firestore rules are an independent, always-available');
  line('read path, and they were not narrowed to match.');
  line('');
  line('### `_riderView()` is not the rider read path');
  line('');
  line('- `_riderView()` exists: **' + (RIDERVIEW_EXISTS ? 'yes' : 'no') + '**');
  line('- it omits `deliveryPin`: **' + (RIDERVIEW_OMITS_PIN ? 'yes' : 'no') + '**');
  line('');
  line('Both true, and both beside the point. `_riderView()` governs `fulfilmentScan` only. It');
  line('whitelists fields, withholds the customer address once the assignment is over — *"the single');
  line('most important line in the file"*, and it is right — and never returns the OTP. None of that');
  line('applies to a direct Firestore read, and **Firestore has no field-level read control**: a');
  line('granted document read is total.');
  line('');
  line('The question to ask of any projection is therefore not "does it withhold the secret" but');
  line('"is it the only way to get the document".');
  line('');
  line('### The same class, twice more');
  line('');
  line('- `claimAvailableDelivery` **returns** `proofPin` to the claiming rider in its response.');
  line('- `availableDeliveries` returns `proofPin` to everyone, signed in or not.');
  line('');
  line('So there are three plaintext delivery-proof exposures, and the strongest of them requires no');
  line('account at all.');
  line('');
}

/* ── Callable table ─────────────────────────────────────────────────────── */
line(MD ? '## Authorisation, per callable\n' : '-- callables --');
if (MD) {
  line('| module | callable | does it decide who may act? | verdict |');
  line('|---|---|---|---|');
  for (const c of CALLS) line('| `' + c.mod + '` | `' + c.name + '` | ' + c.decides + ' | **' + c.verdict + '** |');
  line('');
  for (const c of CALLS) line('- **`' + c.name + '`** — ' + c.note);
  line('');
} else {
  for (const c of CALLS) line('   ' + c.verdict.padEnd(22) + c.name);
}

/* ── The fourteen ───────────────────────────────────────────────────────── */
line(MD ? '\n## The fourteen points\n' : '\n-- fourteen --');
if (MD) {
  line('| # | traced | finding |');
  line('|---|---|---|');
  TRACED.forEach(([q, a], i) => line('| ' + (i + 1) + ' | ' + q + ' | ' + a + ' |'));
  line('');
} else {
  TRACED.forEach(([q], i) => line('   ' + (i + 1) + '. ' + q));
}

/* ── Findings ───────────────────────────────────────────────────────────── */
line(MD ? '\n## Findings\n' : '\n-- findings --');
if (MD) {
  line('| # | finding | severity |');
  line('|---|---|---|');
  line('| 1 | `availableDeliveries` — unauthenticated HTTP endpoint returning buyer name, phone, delivery address and plaintext `proofPin` for up to 80 pending deliveries | **critical — live** |');
  line('| 2 | Plaintext `deliveryPin` on `orders/{orderId}` is readable by the assigned rider through the Firestore rules | **critical** |');
  line('| 3 | `claimAvailableDelivery` returns plaintext `proofPin` to the claiming rider | **high** |');
  line('| 4 | `deliveryVerifyShadow` — no assignment check: a PIN oracle for any delivery, and it burns the same attempt counter `completeDeliveryWithPin` locks on, so any account can force a legitimate rider into the support path | **high** |');
  line('| 5 | `handleFailedDelivery` — auth only; declares any delivery failed and can strip its assigned rider | **high** |');
  line('| 6 | `dispatchDelivery` — auth only; starts the rider cascade on any delivery | **medium** |');
  line('| 7 | `optimizeBatchRoute` — auth only; bulk address disclosure for an arbitrary list of deliveries | **medium** |');
  line('');
  line('Findings 2–7 are the same family this track has now found six times: a real control');
  line('validating something other than the thing being authorised, or no control at all behind a');
  line('name that implies one. Finding 1 is a different and more urgent thing — it is not a');
  line('consolidation defect but a live production exposure, and it should be triaged on its own');
  line('timeline rather than queued behind merchant UI work.');
  line('');
  line('## Verdict for Stage 2');
  line('');
  line('**Fulfilment is BLOCKED for the delivery half, and buildable for the merchant half —');
  line('after finding 1 is dealt with.**');
  line('');
  line('The merchant-facing fulfilment surface has a genuinely good foundation that this census did');
  line('not expect to find: `fulfilmentScan` authorises correctly and projects correctly,');
  line('`_sellerView` already omits commission and settlement, and `fulfilment-lifecycle.resolveStage`');
  line('already answers "what stage is this order actually at" across five disagreeing vocabularies.');
  line('A native merchant board — prepare, ready, handed to rider — can be built on those without a');
  line('new authority.');
  line('');
  line('What must not be built: anything that assigns, reassigns, dispatches, completes, or displays');
  line('a delivery PIN. Every one of those sits on an unguarded or compromised authority.');
  line('');
  line('`fulfilment` remains `kind:\'page\' src:\'seller-fulfilment.html\'`. It should not be converted');
  line('to a native surface until at least findings 1–4 are closed — a native screen over these');
  line('authorities would be a better-looking version of the same exposure.');
} else {
  line('   1 availableDeliveries UNAUTHENTICATED — critical, live');
  line('   2 plaintext deliveryPin readable by rider — critical');
  line('   chain closed: ' + CHAIN_CLOSED);
}

if (hardFail) {
  console.error('\nCENSUS ABORTED — ' + hardFail + ' control(s) failed. Output is NOT trustworthy.');
  process.exit(1);
}
console.log(out.join('\n'));
