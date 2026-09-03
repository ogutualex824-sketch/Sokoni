# KASS Shop Till backfill (Part 8)

**Status:** 🟢 **TRACED · DESIGNED · IMPLEMENTED · VERIFIED READ-ONLY AGAINST REAL PRODUCTION
DATA (zero writes). COMMITTED · STACKED. NOT ON R1 · NOT DEPLOYED — the actual `--execute`
provisioning run is a separate, later, explicitly-authorized production-data action, not part of
this commit.** Part 8 of "Till Approval Automation + Unified Dashboard Profile." Production
remains `d592d8f`/v632, untouched — this slice performed **reads only** against production
Firestore (see §2), no write of any kind.
**Date:** 2026-09-04

---

## 1. Why this is a backfill, not onboarding

Till Approval Automation (Part 1) auto-issues a Till on a **new** merchant approval, hooked into
`applyDecision`. KASS Shop was approved long before that hook existed — it will never pass
through it. This is explicitly a one-time **backfill** for an already-active, real shop, not a
fake/test merchant and not a new onboarding flow. KASS Shop's canonical identity was confirmed
earlier this session (`docs/MERCHANT_V2_CERTIFICATION.md`): `shopId
D5Ql2EYr95bt79IpcGTmOMTK0P83`.

## 2. What was actually done — read-only, evidenced, not assumed

`scripts/backfill-kass-shop-till-dryrun.js` (new) — dry-run by default, matching this codebase's
own established convention (`scripts/backfill-onboarding-availability-dryrun.js`'s "DRY-RUN, ZERO
WRITES" pattern, reused not reinvented). **Run in dry-run mode against real production Firestore
this session** (Application Default Credentials were available; read-only, no write path was
exercised):

```
SOKONI Till backfill — KASS Shop
mode: DRY RUN (zero writes)

ok: true
action: dry-run-would-create
shopId: D5Ql2EYr95bt79IpcGTmOMTK0P83
branchId: D5Ql2EYr95bt79IpcGTmOMTK0P83-main
previewSokoniTillId: SK-KASSSH0P83-0001
note: Re-run with --execute to actually provision (requires Functions deployed / QR_SIGNING_SECRET set).
```

This **confirms, against real data, not assumed**:
- `shops/D5Ql2EYr95bt79IpcGTmOMTK0P83` exists and is not suspended (the script fails loudly and
  exits non-zero for either condition — neither fired).
- **No `sokoniTills` document exists yet for this shop** — confirmed by direct query, not
  inferred from "Till Approval Automation only runs on new approvals." The backfill is genuinely
  needed, not redundant.
- The exact, deterministic Till id the eventual provisioning run will produce:
  `SK-KASSSH0P83-0001` — computed via `deriveShopCode`/`formatTillId` (Q5's already-certified
  pure functions, `functions/sokoni-qr-authority.js`, 81/81), not a new derivation invented for
  this script.

## 3. Design — reuses Part 1's own provisioning function, not a second implementation

`--execute` calls `mintSokoniTillCore` (`functions/sokoni-till.js`'s `_internal` export, the exact
function Part 1's approval hook and the self-service `mintSokoniTill` onCall both already use)
with `onExisting:'return'` — idempotent by the same certified guarantee Part 1 already proved
(`decideTillAllocation`, 81/81 including a dedicated sabotage control): a second `--execute` run
after a successful first converges on the identical Till, never mints a second one. `source:
'backfill'` is recorded on the Till document, distinguishing it in the audit trail from
`'application_approval'` (Part 1) or `'self_service'` (the original onCall) — visibility, not a
different code path.

**Deliberately does not hardcode KASS Shop as an unconditional target.** `--shop-id`/`--branch-id`
override the default; KASS Shop's id is only the *default*, and every run — dry or executed —
re-verifies the shop is real and active before doing anything, so a copy-paste of this script for
a different shop cannot silently target the wrong one, and running it again for KASS Shop cannot
silently skip that same verification.

## 4. Release-record correction, per explicit instruction

**Running this script with `--execute` is a production-data change, not a deploy.** It writes
exactly one `sokoniTills` document via the Admin SDK; it does not touch Cloud Functions code,
Hosting, or any deployment artifact. It also **cannot succeed before the stacked release is
deployed** — `mintSokoniTillCore` calls `QR_SIGNING_SECRET.value()`, which only resolves once
Cloud Functions carrying that secret binding are live (or when explicitly set in the environment
for a controlled one-off) — so this is not merely a policy choice, it is also a real, load-bearing
technical dependency. The code is stacked and certified **now**, on this branch. The `--execute`
run itself, and the resulting real KASS Shop payment test, are **both** deferred to after the
final stacked release is deployed — a post-stack production gate, not part of this commit's
effect.

## 5. Certification

- **Read-only production verification** (§2, above) — the strongest form of "certify the
  read/display path" available before deployment: real data, not a synthetic fixture, zero writes.
- **`deriveShopCode`/`formatTillId`** — already certified, Q5, 81/81 (unmodified, reused
  verbatim, not re-derived for this script).
- **`decideTillAllocation`/`mintSokoniTillCore`'s idempotency** — already certified, Part 1, 81/81
  including a dedicated sabotage control (proven: a repeat provisioning attempt cannot mint a
  second Till). Nothing about calling it from this script changes that guarantee — same function,
  same code path, a different caller.
- **Full end-to-end display of KASS Shop's own Till** (via `getMySokoniTill`/the Till & QR page,
  Part 2) cannot be certified against KASS Shop's *real* Till document until one exists — which
  requires `--execute`, which requires deployment. This is the honest boundary of what can be
  proven before the stack deploys, stated plainly rather than glossed over. What Part 2's own
  certification already proves (81/81 + a live browser check) is that the display path is correct
  for *any* Till matching this shape — generic, not KASS-specific, and unaffected by which real
  shopId eventually owns the document.

## What this slice does NOT do

Does not run `--execute` — no Firestore write of any kind was performed this session, confirmed
by the script's own dry-run guarantee and by inspection of its output above. Does not perform the
real KASS Shop payment test — explicitly deferred to the post-stack production gate. Does not
touch `mintSokoniTillCore`, `decideTillAllocation`, or any other Part 1-4 code — reused,
unmodified. Not deployed. Does not touch `C:/temp/sok-r1`.

## Related

`docs/TILL_APPROVAL_AUTOMATION.md` (Part 1, `mintSokoniTillCore`/`decideTillAllocation` — reused
unmodified) · `docs/TILL_MERCHANT_V2_SURFACE.md` (Part 2, the display path this backfill feeds) ·
`docs/MERCHANT_V2_CERTIFICATION.md` (KASS Shop's confirmed canonical identity) ·
`scripts/backfill-onboarding-availability-dryrun.js` (the dry-run-by-default convention this
script follows) · `scripts/backfill-kass-shop-till-dryrun.js` (new)
