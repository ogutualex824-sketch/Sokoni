# Legal Enforcement — Controlled Rollout Runbook

**Current state:** ⏳ **DARK-LAUNCHED (OFF)** — verified against production, not assumed.
**Do not start this runbook** until Android + iPhone + Tablet OAT all PASS
(`LEGAL_DEVICE_OAT.md`).

---

## Verified current state (production Firestore, 2026-07-13)

```
legalConfig/enforcement  : DOES NOT EXIST
  -> assertLegalCompliance() reads {} -> every role returns
     { enforced: false, compliant: true }
  -> ENFORCEMENT IS OFF FOR ALL ROLES
```

## Blast radius — measured, not estimated

| | Count |
|---|---|
| `users` total | **3** (1 admin, 2 buyers) |
| merchant · provider · driver · seller | **0** |
| `sellers` · `providers` · `drivers` | **0 · 0 · 0** |
| `legalAcceptances` · `legalCertificates` | **0 · 0** |

**No professional users exist. Turning enforcement on today blocks nobody.**

This is the *safest* moment this will ever be. Every professional who onboards before
enforcement is switched on is one more account that will need to sign retroactively.
**The cost of waiting is monotonic.**

**No backfill is needed.** There is nothing to backfill.

---

## How enforcement actually behaves

`assertLegalCompliance(uid, role)` is the guard other modules call before sensitive ops
(payouts, publishing, going online).

- Flag **off** for a role → returns `{enforced: false, compliant: true}`. Nothing is
  checked, nothing is blocked.
- Flag **on** → the user's acceptances are compared against the current catalogue. If any
  required agreement is missing or is at an older version, it throws
  `failed-precondition` **naming the missing agreements**.
- **No account is ever deactivated.** Only the guarded action is refused; the user is sent
  to sign and then proceeds.
- A new agreement *version* re-triggers this. History is never deleted.

Cache: enforcement flags are cached **60 s** per instance. Expect up to a minute before a
change takes effect, in both directions — including the kill switch.

---

## Rollout order

Merchant → Provider → Driver → Property → Restaurant → Healthcare → Employer

One role at a time. **Monitor between each.** Do not batch.

### Per-role procedure

**1. Pre-flight** — how many users does this role have, and how many have signed?

```
legalGetStats            -> byRole, versionAdoption, latestVersionAdoption
legalSearchAcceptances   -> { role: '<role>' }
```

If the role has users but **near-zero acceptances**, stop and think: enabling now sends
all of them to the signing flow at once. That is *correct* behaviour, but it should be a
decision, not a surprise.

**2. Enable** (via `/legal-admin` or the callable):

```
legalSetEnforcement({ role: 'merchant', enabled: true })
```

**3. Watch for 24 h** before the next role:

| Signal | Where | What is bad |
|---|---|---|
| `failed-precondition` rate on guarded ops | Cloud Logging (`legalDispatch`, and the guarded modules) | A sustained rate, or errors from users who *have* signed |
| Signing completions | `legalGetStats` → adoption climbing | Flat adoption = users are hitting the gate and **not** completing it — the flow is broken, not the users |
| `legalAccept` errors | Cloud Logging | Signature rejections, catalogue mismatches |
| Support contacts | Inbox | "I can't publish / go online / get paid" |

**Healthy** = a spike of `failed-precondition`, followed by adoption climbing, followed by
the spike subsiding. **Unhealthy** = the spike persists and adoption stays flat.

**4. Kill switch** — immediately, on any unexpected failure:

```
legalSetEnforcement({ role: '<role>', enabled: false })
```

Takes effect within the 60 s cache TTL. No data is lost: acceptances already recorded stay
recorded, and re-enabling later picks up exactly where it left off.

---

## Stop conditions — disable immediately

- A user **who has signed** is still blocked → the compliance check is wrong, not the user.
- Adoption stays flat while `failed-precondition` climbs → the signing flow is broken on
  some real device. Go back to `LEGAL_DEVICE_OAT.md`.
- Any error in `legalAccept` that is not a signature validation rejection.
- Anything blocking a **payment or payout** path.

---

## Do not

- Do not enable `all` — it bypasses the staged order and the blast radius becomes every
  role at once.
- Do not enable more than one role at a time.
- Do not enable before device OAT passes. The gate exists because **drawing a signature
  with a finger is the least-verified part of this feature**, and enforcement is what makes
  failing to sign consequential.
