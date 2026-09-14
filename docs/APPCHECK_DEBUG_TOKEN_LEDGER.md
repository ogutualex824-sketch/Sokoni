# App Check Debug Token Ledger

**Project:** `sokoni-aeb26` (PRODUCTION — the only Firebase project; there is no test project)
**App:** `1:24799054989:web:e1cf6ca8c281bf1abf26c4` ("Sokoni website", WEB)

---

## What a debug token is, precisely

An App Check debug token bypasses **attestation** — the claim "this request comes from my
genuine app". It does **not** bypass **authorization**. Firestore security rules still apply
in full.

Measured proof of exactly that, taken at registration time of the entry below:

| Read (anonymous, token injected) | Result |
|---|---|
| `products` limit 1 | `size=1 fromCache=false` — backend answered |
| `shops` limit 1 | `size=1 fromCache=false` — backend answered |
| `users` limit 1 | **`permission-denied`** — backend answered, rules denied |

So the exposure of a leaked token is: an attacker can make requests that *look like they came
from the genuine SOKONI web app*, still subject to rules. That matters most for
public-read collections (scraping), not for protected data.

## Why this ledger exists

Token values cannot be read back from the API — `appcheck:debugtokens:list` returns display
names and resource names only. A token whose purpose was never written down therefore cannot
be assessed later; it can only be deleted blind or left in place. Every registration must be
recorded here at the time it is made.

---

## Active tokens

| Display name | Registered | Purpose | Owner | Revoke when |
|---|---|---|---|---|
| `merchant-gate-2026-08-18-ephemeral` | 2026-08-18 | Restore backend reads for the authenticated 31-route Merchant containment gate. Without attestation every Firestore read returns an empty **cache** result, so every data-dependent assertion would be UNPROVEN. | Merchant OS gate work | **REVOKED 2026-08-19, verified absent from the list.** It outlived its run by a day; revoked on the founder's instruction during the `merchantAdjustStock` release work. |

| `merchant-cert-2026-08-18-ephemeral` | 2026-08-18 | Prove the App Check debug path restores backend reads for Authenticated Merchant Runtime Certification. | Merchant auth-boundary work | **REVOKED same session** — mechanism proven, recreate at run time. |

| `merchant-cert-run-2026-08-18-ephemeral` | 2026-08-18 | Authenticated Merchant Certification run (CI auth path). | Merchant auth-boundary work | **REVOKED same session, verified absent from the list.** |
| `authpage-defects-2026-08-18-ephemeral` | 2026-08-18 | Auth-page defect gate + merchant CI re-verification (Firebase Auth cannot complete without attestation, so the token is required even for a suite that asserts nothing about Firestore). | Production auth-path work | **REVOKED same session, verified absent.** |
| `merchant-walk-2026-08-18-ephemeral` | 2026-08-18 | 9-transition walk + rules-derived ownership assertions. | Merchant certification work | **REVOKED same session, verified absent.** |
### Measured at registration (localhost, token pinned via localStorage)

| Read | Result |
|---|---|
| App Check state | `exchanged` — "App Check OK — token exchanged" |
| `products` limit 1 | `size=1 fromCache=false` — backend answered |
| `users` limit 1 | **`permission-denied`** — backend answered, rules denied |

Reproduces the boundary exactly: the token bypasses **attestation**, never **authorization**.

### Correction — the resource name is NOT the token value

The revoke command below base64-decodes to a UUID, which invites the assumption that it IS the
secret. **It is not.** Measured: the token registered this session has resource id
`MWRmMjgyNmMt…` (decodes to `1df2826c-ae5e-41c9-a041-49fad30c22eb`) while its actual token value
is a completely different UUID. Sending the decoded resource id yields
`exchangeDebugToken -> HTTP 403` and every read comes back `size=0 fromCache=true` — the
unattested signature. A token value genuinely cannot be recovered; mint a new one.

### Housekeeping finding

`merchant-gate-2026-08-18-ephemeral` — **RESOLVED 2026-08-19: revoked, verified absent from the
list.** Its own row said "revoke immediately after the authenticated gate run"; it outlived that run
by a day. Revoked on the founder's instruction during the `merchantAdjustStock` release work, after
the gate it served was recorded complete.

`seller-cert-2026-08-18-ephemeral` — **STILL REGISTERED, and absent from this ledger entirely.**
Its purpose was never recorded, which is precisely the situation this file exists to prevent: it can
now only be deleted blind or left in place. **NOT revoked here** — with no record, there is no way to
establish that no worktree is mid-run against it, and revoking a token another run depends on would
break that run. **Its owner should either record it or revoke it.**

**Revoke:**

```
firebase appcheck:debugtokens:delete MGQ2ZTIwMGItYjMyNy00NDZlLWFjZTUtODRlODJkNWRmODBm \
  --app 1:24799054989:web:e1cf6ca8c281bf1abf26c4 --project sokoni-aeb26
```

## Pre-existing tokens — provenance UNKNOWN

Found on the production app when this ledger was created. None has a recorded purpose, owner,
or expiry. Each is a long-lived production attestation bypass. **Recommend audit and prune.**

| Display name | Registered | Purpose | Owner |
|---|---|---|---|
| `SOKONI Local Development (Alex HP)` | 2026-07-12 | unrecorded | implied: a specific dev machine |
| `sokoni-qa-localhost` | 2026-07-14 | unrecorded | unrecorded |
| `SOKONI` | 2026-08-15 | unrecorded | unrecorded |
| `alex` | 2026-08-17 | unrecorded | unrecorded |

Two of those names (`SOKONI`, `alex`) say nothing about scope, machine, or lifetime. A token
that cannot be attributed cannot be safely retired, which is the argument for this file.

## Handling rules

1. **The value never enters git.** Not in scripts, not in CHANGELOG, not in a committed
   config. `.gitignore` covers `.env`, `.env.*`, `*.env`.
2. **Gates read `APPCHECK_DEBUG_TOKEN` from the environment**, set per-run by a human. No
   script stores a default, and a gate with the variable unset SKIPS loudly rather than
   silently running unattested — an unattested run produces empty cache reads that look
   like real zeroes.
3. **Ephemeral tokens are revoked on the same day they are issued.**
4. **Never reuse a token across purposes.** One purpose, one token, one ledger row.

## Related

- The empty-cache hazard this token works around is a defect class in its own right: a
  blocked Firestore read resolves as `size=0, fromCache=true` rather than throwing, so any
  caller that does not check `snapshot.metadata.fromCache` renders `0` as if canonical.
  That contradicts the no-fabricated-metrics rule in `CLAUDE.md` and is tracked separately.
