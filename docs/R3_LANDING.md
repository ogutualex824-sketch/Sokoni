# R3 — landing packet: three providers classified from their approval evidence

**Date:** 2026-09-29 · **Production project** `sokoni-aeb26` · **Applied 19:04Z** under the owner's authorization of the PRIMARY digest only (`cb87e8cac1931c70b7cc423cdb4de62c76256a83ef77bce98637b562defb98e3`). The disagreement digest (`9f8a96e8…8952`, DG Wine / Latomi) is **deferred** and was not part of the transaction.
Contract: `scripts/r3-classification-manifest.js` (`--apply <digest>`; suites `test-r3-classification-manifest.js` 21/0, `test-r3-classification-apply.js` 22/0). Packet JSON: `docs/release-gates/r3-landing.json`. Follows [[R3_CLASSIFICATION_MANIFEST]].

## 1 · Results — exactly three identities

| uid | name | stamp written (`providers/{uid}.business`) | audit | post-R2 resolver on production |
|---|---|---|---|---|
| `FqmCT4t4KehQD6EJR4m3dLVbHBo1` | Julian's Closet | `{ category: service_business, lane: {provider/null}, source: application, applicationId: 8XwvCN8P…, setAt: 19:04:47Z }` | `VrhGoDE16dK3M8MRwT06` | **provider-dashboard.html · AVAILABLE** · lane services · capability SERVICES |
| `H7p6ktBHogM5GcBy6mz8negKVbG2` | Langa'ta mamafua | `{ cleaning, … applicationId: e0cOABIk…, setAt: 19:04:50Z }` | `92JzdKA9irn4VhhEFuXH` | provider-dashboard.html · AVAILABLE |
| `X7KZGTy3ouYmGESePPxKVlC3j613` | Hometown Movers kenya | `{ trades, … applicationId: hZN2s7YC…, setAt: 19:04:51Z }` | `XMiPAmNU61c48YSqcIPn` | provider-dashboard.html · AVAILABLE |

All three resolve exactly as the owner expected: category stamped + provider lane + SERVICES capability → provider dashboard, AVAILABLE. None resolved differently; nothing was repaired.

## 2 · Preservation and exclusions (read-only landing proof, 19:06Z, 24 / 0)

- every other field on each of the three provider records is **byte-identical** to the pre-apply snapshot; each **application is byte-identical**; no `businesses` or `sellers` record appeared; **no capability was written**.
- exactly one new audit per identity (`category_backfill_r3`, naming the application, the approver and the C1 reason); each uid's audit count is pre + 1.
- the whole `providers` collection: exactly the three gained a stamp, every other row unchanged.
- collection counts unchanged for providers, businesses, shops, sellers, products, merchants, applications; `adminAudit` +3.
- capability-stamped businesses are still exactly DG Wine and Latomi.
- DG Wine and Latomi: no category stamp, capability SERVICES / STAMPED, resolver **PENDING_CLASSIFICATION, no route** (unchanged).
- KASS (`D5Ql2EYr…`) has no providers record and was in no set.
- Full identity census re-run (26 identities): distribution unchanged (0 / 7 / 12 / 7); the only rows differing from the C3 baseline are DG Wine and Latomi (their C4/C5 stamps) — the category stamps do not change the capability read model, as designed; **cleanup manifest digest unchanged** (`028299e7…13e2`).

## 3 · Digest and idempotency

`--apply` recomputes the primary set from a fresh production snapshot and refuses unless its digest equals the authorized one; each identity is then one transaction that re-reads the provider and its application, recomputes the row, and aborts on any difference. First run: 3 applied, 0 skipped, digest equal. **Second run with the same digest: `digest_mismatch`, `primaryCount: 0`, `alreadyStampedProviders: 3`, nothing written** — the live primary set is empty once applied (proven on the fake store: wrong digest → nothing; drift on one identity → the whole set refused; second and third runs no-ops).

## 4 · Boundary

The workspace route now exists for these three because BOTH authorities agree. Nothing here deploys: the c4 line's resolver, C1, R1 rules and these stamps take effect in production only when this lineage ships — the served production code still runs the pre-C1 legacy provider dashboard for them. Next, each separately: the deferred disagreement digest (owner decision on DG Wine / Latomi), the six unresolved identities (AdminOS by hand), then storefront / cards / resolver surfaces.
