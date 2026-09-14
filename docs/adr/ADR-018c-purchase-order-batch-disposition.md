# ADR-018c — Disposition: `posPurchaseOrders` (ERP writer) and `posBatches` (BI/intelligence readers)

**Status:** ✅ **ACCEPTED** (2026-09-03) — dispositions decided below. **Implementation NOT
authorized.** No file under `functions/` was changed to produce this record; no deploy was run.
**Date raised:** 2026-09-03 · **Raised by:** the 18c discovery pass (`docs/POS_18C_DISCOVERY.md`)
plus the live-rule verification gate opened in this session.

---

## Part 1 — the live-rule verification gate

**The exact question:** does the SERVED Firestore ruleset deny `pos-suppliers.js`'s direct,
unmediated browser write to `posPurchaseOrders`?

### Method — no substitution

Fetched the ruleset the *release* `cloud.firestore` actually points at, via the same two read-only
Firebase Rules API calls `scripts/verify-rules-release-parity.js` uses
(`GET /v1/projects/sokoni-aeb26/releases/cloud.firestore` → `GET .../rulesets/{id}`), using a
freshly generated `gcloud auth print-access-token` (approved this session; token written only to
the session scratchpad, not the repo). The repo's `firestore.rules` was **not** read for this
verdict — `verify-rules-release-parity.js` confirms it still diverges from the served ruleset (542
lines would be added / 214 removed on a hypothetical deploy), consistent with standing project
memory that the repo file is a proposal artifact, not proof of what's live.

```
ruleset id  : 1cf1f3f2-8669-4f60-8ccf-70dd24b8c57b
createTime  : 2026-09-02T13:11:19.332143Z
bytes       : 246,602
rules_version: '2'
```

### SERVED RULES — exact match block

```
2597	    match /posPurchaseOrders/{poId} {
2598	      allow read:  if isAuthed() && (resource.data.sellerId == request.auth.uid || isAdmin());
2599	    }
```

That is the **entire** block — verbatim, line numbers from the fetched source. No
`allow create`, `allow update`, `allow write`, or `allow delete` clause exists for this path.
(Contrast the repo's proposal, which has the same read line plus an explicit
`allow write: if false;` — the served version doesn't even carry the explicit deny; it simply
never grants one.)

Confirmed exhaustively, not by spot-check:
- `posPurchaseOrders` appears **exactly once** in the 5,364-line served source (line 2597).
- Exactly **one** `service cloud.firestore { match /databases/{database}/documents { ... } }`
  block exists in the whole file — there is no second ruleset section that could apply.
- **Zero** recursive wildcard match blocks (`match /{document=**}` or similar) exist anywhere in
  the served source — so no catch-all rule could be granting write access to this path from
  outside its own block.

### WRITE DECISION — authenticated ordinary merchant/client write → DENY

Firestore rules (`rules_version = '2'`) are closed-world: an operation succeeds **only if** some
`allow` rule matching that path and method evaluates true; there is no implicit-allow fallback.
Given the block above is the only rule touching this path, grants read only, and no catch-all rule
exists anywhere in the file, an ordinary authenticated merchant/client **create, update, or delete**
on `posPurchaseOrders/{poId}` is denied — as a direct, mechanical consequence of the rules
language's own semantics applied to the exhaustively-confirmed rule set, not an inference from
absence of evidence.

**This was not additionally confirmed by an executed rules simulation.** I attempted the Firebase
Rules API's `:test` (`TestRuleset`) endpoint — which evaluates a ruleset against a simulated
request without touching real documents — to get an executed ALLOW/DENY verdict rather than a
static one. Two request-shape attempts both returned `400 INVALID_ARGUMENT` (the second attempt's
error, `Unknown name "expression"`, shows the `TestCase` schema for this API differs from what I
constructed, and I could not determine the correct request-based shape from what's available to me
this session). **This is a distinct, disclosed gap from the token-generation blocker** — the token
worked; the simulation request schema is what's unresolved. I did not substitute the static proof
for this and I'm not presenting it as equivalent — the static method above is sound on its own
terms (it is literally how the rules language is defined), but a from-first-principles reader who
wants an *executed* confirmation should treat that as still open.

### POSITIVE CONTROL — a known allowed operation, same method, same fetched bytes

`users/{userId}`, lines 283-289 of the same served source:

```
283	    match /users/{userId} {
284	      allow read:   if isAdmin() || (isAuthed() && request.auth.uid == userId);
285	      allow create: if isAuthed()
286	                    && request.auth.uid == userId
287	                    && noAdminFields()
288	                    && noPrivilegeEscalation()
289	                    && noProviderForgery();
```

An authenticated user creating their own `users/{uid}` document — the account-signup path,
exercised continuously in production — **is** granted here. This confirms the fetch/read method
finds real grants where they exist (the ruleset isn't somehow empty or mis-fetched); the absence of
any such clause for `posPurchaseOrders` is a real, specific gap in that block, not an artifact of
how the ruleset was retrieved.

### Verdict

**The browser write is denied in production.** `pos-suppliers.js`'s `_sync('posPurchaseOrders', ...)`
call (`.set(..., {merge:true})`, errors swallowed by `.catch(() => {})`) has been failing silently
on every attempt under this ruleset (live since 2026-09-02T13:11:19Z). This resolves the security
question — the client write is not a live integrity exposure — but opens a **different, real
defect**: the supplier/PO UI believes its data syncs to the cloud and it has not been. That is a
UX/data-integrity bug in `pos-suppliers.html`/`pos-suppliers.js`, independent of this ADR's scope,
and is not fixed or touched here.

---

## Part 2 — disposition: `posPurchaseOrders` (ERP writer + server engine)

| surface | disposition | confidence | why |
|---|---|---|---|
| `pos-inventory-pro.js` `createPurchaseOrder` | **RETIRE** | highest | already provably unreachable — not in `index.js`, not in the `smartPosDispatch` `_h` registry. Zero risk: nothing can call it today. |
| `pos-inventory-pro.js` `receivePurchaseOrder`, `updatePurchaseOrderStatus`, `getPurchaseOrders`, `upsertSupplier`, `getSuppliers`, `deleteSupplier`, `createAutoReorderPO`, `getReorderQueue`, `dismissReorderItem` | **RETIRE candidate** | high | dispatcher-reachable but zero found frontend callers (repo-wide `git grep` on every op string). The only client that could plausibly reach them (`pos-suppliers.html`) is now confirmed to run an entirely separate, disconnected implementation, and its cloud-sync side is rules-denied anyway (Part 1). Re-run the caller grep immediately before executing — this repo changes across parallel worktrees daily (`CLAUDE.md` operational guardrails), and a stale zero-caller finding is not a safe basis for deletion by itself. |
| `posReceiveErpUpdate` (HTTP webhook) | **COMPATIBILITY SURFACE — hold, do not retire yet** | — | zero invocation-log entries in the 30-day window, and no self-serve UI exists to provision a write-capable API key (`posRegisterApiKey` has no frontend caller either) — but a key *could* have been provisioned manually (e.g. via the Firestore console or an admin script) and I could not check the `posApiKeys` collection directly this session: that read was outside the scope this approval covered (rules verification only) and was blocked by the permission classifier when attempted. **This is the one remaining check that should gate a retire decision on this specific surface** — an external-facing HTTP endpoint carries a materially different risk profile from an internal onCall with no caller, because a real ERP partner might call it monthly or quarterly rather than daily, which a 30-day window would miss entirely. |
| `pos-suppliers.js` / `pos-suppliers.html` | **not a retirement candidate — it's the live product surface** | — | flagged instead: its Firestore sync silently no-ops in production (Part 1). Separate defect, own ticket, out of this ADR's scope. |
| `functions/procurement.js` | **untouched** | — | per instruction; remains the confirmed-live canonical PO lifecycle from 18b/ADR-018. |

---

## Part 3 — disposition: `posBatches` (4 BI/intelligence readers)

Real schema (from `receivePurchaseOrder`, the only reachable writer):
`{sellerId, productId, lotNumber, batchNumber, quantity, remaining, unitCost, totalCost,
expiryDate:Timestamp, supplierId, warehouseId, purchaseOrderId, poNumber, status:'active',
expiryAlert, expired, createdBy, createdAt, updatedAt}`.

| reader | classification | disposition | why |
|---|---|---|---|
| `getExecutiveDashboard` | **structurally dead** (sub-query only — rest of the function is live and fine) | **decision/design work needed, not deletion** | queries `expiresAt`/`consumed`, fields that don't exist on any real document; the inventory-health sub-object silently returns `{score:null→100-baseline, expiringCount:0}` regardless of real batch data. Page (`pos-bi.html`) **is** linked from live nav (`pos.html`, `sokoni-nav-engine.js`), so a manager could be looking at this widget today, always empty, never told why. Someone with product context should choose: retire the `posBatches` sub-feature (cheapest, matches zero real dependency) or redirect it to a populated source. Not decided here — touches `functions/`. |
| `getInventoryHealthScore` | **structurally dead** (same sub-query) | same as above | same field mismatch; own code comment (`pos-bi.js:687`, *"posBatches may not exist yet — gracefully degrade"*) already concedes the uncertainty this ADR confirms. |
| `getPOSInventoryIntelligence` | **deployed but unexercised — genuinely unproven, not "broken"** | **compatibility surface — hold; do not repair opportunistically** | field names are correct (matches the real writer schema, unlike the two above). One real invocation (2026-08-15) failed with `500`; the missing composite-index hypothesis (`firestore.indexes.json` covers `status`+`expiryDate` but not `sellerId`, which this query also filters on) is **plausible, not proven** — per instruction, this is not to be patched on the strength of a hypothesis. If this path is retained, it needs its own focused investigation (reproduce, confirm the actual Firestore error, decide index vs. code fix) before being trusted. Separately: the page (`pos-inventory-intelligence.html`) is **not linked from anywhere** in the repo — an orphan; whether it's meant to be reachable at all is its own product question. |
| `posGetInventoryAlerts` | **zero code callers; one external probe** | **RETIRE candidate**, same caveat as Part 2's dispatcher ops | no frontend caller found anywhere in the repo. Its one real hit (`401`, 2026-08-24) is an unauthenticated external call, not a merchant session. Also carries a field mismatch (`merchantId`, which no real `posBatches` doc has — the writer uses `sellerId`), so even an authenticated caller's query would always come back empty. Closest of the four to the 18b zero/zero bar — re-confirm zero callers immediately before executing, same caution as above. |

---

## What this ADR does NOT do

- **Does not touch `functions/procurement.js`** or any file under `functions/`. No source changed.
- **Does not authorize a deploy.** `functions/index.js` export count is unchanged at **1508**.
- **Does not retire anything.** "RETIRE candidate" above is a recommendation with stated
  confidence and stated preconditions (a caller-grep refresh at execution time), not an execution.
- **Does not repair `getPOSInventoryIntelligence`'s `500`** on the strength of the missing-index
  hypothesis. That needs its own investigation if the path is kept.
- **Does not resolve** whether a manually-provisioned `posApiKeys` write key exists for
  `posReceiveErpUpdate` — the one check left to close before that specific surface can move past
  "hold."
- **Does not claim an executed rules-simulation verdict** — the static proof in Part 1 stands on
  its own; the `:test` API attempt is disclosed as incomplete, not silently dropped.

## Related

[[ADR-018-legacy-retirement-graph]] (18b) · `docs/POS_18C_DISCOVERY.md` (18c discovery) ·
`docs/cf-invocation-census.json` · `scripts/verify-rules-release-parity.js`

**Evidence pinning this ADR:** served ruleset `1cf1f3f2-8669-4f60-8ccf-70dd24b8c57b`
(`createTime` 2026-09-02T13:11:19Z). If a rules release happens after this date, the `posPurchaseOrders`
verdict in Part 1 must be re-fetched and re-verified before being relied on — it is not evergreen.
