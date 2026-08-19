# Runbook — verify `merchantAdjustStock` in production

**Run by:** the operator (founder). Credentials stay in your shell; they are never handed to an
agent or written into a transcript.
**Prerequisite:** `merchantAdjustStock` is deployed — done 2026-08-19, confirmed
`v2 · callable · us-central1 · 256MiB · nodejs22`, answering `HTTP 401 UNAUTHENTICATED` to an
unauthenticated probe.

Related: [[UNDEPLOYED_RC_COMBINED_REVIEW]] · [[APPCHECK_DEBUG_TOKEN_LEDGER]] ·
[[MERCHANT_SHELL_CAPABILITY]]

---

## ⚠ Read first

This **writes to production**. It moves a real product's stock **+1 then −1** through the same
server authority and fails loudly if the final stock does not equal the starting stock.

Two things it cannot undo, both correct behaviour rather than damage:

- **two `stockMovements` documents remain** — that is the audit trail; a correction that left no
  record would defeat the point of the function
- **`inventoryVersion` advances twice and does not come back down**

Nothing runs without `--confirm`.

---

## 1. Mint an ephemeral App Check debug token

App Check is enforced on this callable. Without a registered debug token every call is refused
before it reaches the function, so the harness fails closed rather than reporting a false green.

```bash
firebase appcheck:debugtokens:create \
  --app 1:24799054989:web:e1cf6ca8c281bf1abf26c4 \
  --display-name "adjust-stock-verify-2026-08-19-ephemeral" \
  --project sokoni-aeb26
```

It prints the token value **once**. Copy it — the API cannot read it back, only display names.

**Record it in `docs/APPCHECK_DEBUG_TOKEN_LEDGER.md` now**, not after: purpose, owner, and
"revoke immediately after this run".

## 2. Run the verification

From the worktree `C:/temp/sok-compat` (branch `fix/merchant-shell-capability`):

```bash
SOKONI_APPCHECK_DEBUG_TOKEN='<the uuid from step 1>' \
SOKONI_SELLER_EMAIL='<a REAL APPROVED seller>' \
SOKONI_SELLER_PASSWORD='<their password>' \
node scripts/verify-merchant-adjust-production.js --confirm
```

Optional — pin the product instead of letting it discover one:

```bash
SOKONI_TEST_PRODUCT_ID='<a product that seller owns, with a numeric stock>'
```

PowerShell equivalent:

```powershell
$env:SOKONI_APPCHECK_DEBUG_TOKEN='<uuid>'
$env:SOKONI_SELLER_EMAIL='<email>'
$env:SOKONI_SELLER_PASSWORD='<password>'
node scripts/verify-merchant-adjust-production.js --confirm
```

## 3. Revoke the token immediately

```bash
firebase appcheck:debugtokens:list --app 1:24799054989:web:e1cf6ca8c281bf1abf26c4 --project sokoni-aeb26
firebase appcheck:debugtokens:delete <debugTokenId> \
  --app 1:24799054989:web:e1cf6ca8c281bf1abf26c4 --project sokoni-aeb26 --force
```

Then re-list and **confirm it is absent**, and update the ledger row to
"REVOKED same session, verified absent" — the discipline the existing entries already follow.

## 4. Paste the output back

The full transcript, pass or fail. A failure here is more informative than a pass.

---

## What a green run proves

```
real approved seller
  -> merchantAdjustStock (DEPLOYED)      callable accepted the request
  -> App Check accepted                  no attestation refusal
  -> sellerUid ownership accepted        no permission-denied
  -> transaction succeeds
  -> stock changes                       exactly +1
  -> inventoryVersion changes            exactly +1
  -> updatedAt changes                   new server timestamp
  -> sold UNCHANGED                      a correction is not a sale
```

and the refusals:

| case | expected |
|---|---|
| duplicate `adjustmentId` | `idempotent: true`, **stock moved once** |
| missing `adjustmentId` | `invalid-argument` |
| another seller's product | `permission-denied` |
| reversal | **final stock == starting stock** |

## What it deliberately does NOT prove

**Employee self-claim.** Proving that refusal at runtime would mean creating a `shopEmployees`
document in production — which *is* the escalation artefact, and precisely what the callable
refuses to trust. `firestore.rules` lets any authenticated client create one naming itself, so
manufacturing that record to test the block would leave a real privilege-escalation artefact
behind. The block stays asserted statically in `scripts/test-merchant-adjust-stock.js` (39/0), and
the callable reads `shopEmployees` nowhere at all — which is the stronger guarantee.

---

## Housekeeping noticed while checking

`firebase appcheck:debugtokens:list` currently shows **two tokens named `-ephemeral` that are still
live**:

- `merchant-gate-2026-08-18-ephemeral` — the ledger's own row says *"Revoke immediately after the
  authenticated gate run. Ephemeral by design — named so."*
- `seller-cert-2026-08-18-ephemeral` — not recorded in the ledger's active table at all

Not revoked here: another worktree may have a run in progress, and revoking someone else's active
token would break it. Per the ledger's stated exposure model the risk is bounded — a leaked token
lets a request *look like* it came from the genuine web app but is still fully subject to security
rules — so this is hygiene, not an incident. Worth clearing when convenient.
