# Firestore Rules Release Blocker — `releases/cloud.firestore` returns 400

> **Status:** OPEN · escalated to Firebase support
> **Opened:** 2026-08-09
> **Impact:** No security-rules change can reach the `(default)` database. This blocks *every*
> future rules deploy, not one feature.
> **Production risk:** none introduced — existing rules remain live and untouched.
> Related: [[MERCHANT_ROUTE_MATRIX]], `firestore.rules`, `scripts/test-returns-rules.js`

## Summary for support

Project **`sokoni-aeb26`** has two Firestore databases. Deploying security rules updates the
named database successfully but **fails on the `(default)` database** with
`400 INVALID_ARGUMENT`, using the same credentials, in the same command, seconds apart.

The ruleset **compiles and is created successfully**. Only the *release update* is rejected.

```
PATCH .../v1/projects/sokoni-aeb26/releases/cloud.firestore/sokoni-ops  → 200 OK
PATCH .../v1/projects/sokoni-aeb26/releases/cloud.firestore             → 400 INVALID_ARGUMENT
POST  .../v1/projects/sokoni-aeb26/releases   (CLI create fallback)     → 409 ALREADY_EXISTS
```

The 409 is a red herring: firebase-tools falls back to *create* after the update fails, and the
release already exists. **The actionable error is the 400.**

### Exact request and response

```jsonc
// REQUEST
PATCH https://firebaserules.googleapis.com/v1/projects/sokoni-aeb26/releases/cloud.firestore
{
  "release": {
    "name": "projects/sokoni-aeb26/releases/cloud.firestore",
    "rulesetName": "projects/sokoni-aeb26/rulesets/e4f487a8-4b71-4ef6-a45c-13f42a5df036"
  }
}

// RESPONSE
{ "error": { "code": 400, "message": "Request contains an invalid argument.", "status": "INVALID_ARGUMENT" } }
```

The response carries no field violation, so there is nothing in the payload to correct.

### The control case — identical shape, succeeds

```jsonc
PATCH .../releases/cloud.firestore/sokoni-ops
{ "release": { "name": "projects/sokoni-aeb26/releases/cloud.firestore/sokoni-ops",
               "rulesetName": "projects/sokoni-aeb26/rulesets/c76c080c-5073-4b3d-94bc-53d6d8254516" } }
→ 200 OK
```

Same command, same credentials, same second. The **only** material difference is which ruleset
is being released.

### Ruleset characteristics

| | `firestore.rules` → `(default)` | `firestore.rules.sokoni-ops` → `sokoni-ops` |
|---|---|---|
| Source size | **258,746 bytes** (98.7% of the documented 256 KiB limit) | 674 bytes |
| `match` blocks | 730 | 2 |
| `allow` statements | 1,702 | 3 |
| Compiles | ✅ | ✅ |
| Ruleset **created** | ✅ | ✅ |
| Release **updated** | ❌ 400 | ✅ 200 |

Both are **under** the documented 256 KiB source limit. Our hypothesis is a *release-time*
size or complexity limit that the compile and create steps do not enforce, but the error
message gives no confirmation.

### What we ruled out (with evidence)

| Hypothesis | Result |
|---|---|
| Compilation error | Ruled out — CLI reports "compiled successfully"; ruleset resource is created |
| Multi-database config confusion | Ruled out — reproduced with a temporary single-database `firestore` config in `firebase.json` (reverted) |
| Rate limiting | Ruled out — reproducible across 4 attempts spanning ~15 minutes |
| IAM / permissions | Ruled out — the same credentials PATCH `sokoni-ops` successfully in the same request batch |
| Database state | Ruled out — both databases report `STANDARD` / `FIRESTORE_NATIVE` |
| Outdated tooling | Ruled out — firebase-tools **15.26.0**, current at time of filing |
| Recent size increase | **Not** a proven cause — the file was 257,123 bytes before our 1,623-byte addition; both figures are under the limit, and we have no evidence a rules deploy succeeded before this change |

### Questions for support

1. Is there a **release-time** limit on ruleset size, `match` count, or total conditions that is
   lower than the documented 256 KiB source limit, and is it enforced only at
   `releases.patch`?
2. Why does `INVALID_ARGUMENT` carry no `field_violations` detail? Can the actual constraint be
   surfaced?
3. Is the `(default)` release in a state that rejects updates, given the named database on the
   same project accepts them?

### Reproduce

```bash
export CLOUDSDK_PYTHON=bundled
npx firebase deploy --only firestore:rules --project sokoni-aeb26 --debug 2>&1 \
  | grep -E "releases/cloud.firestore|INVALID_ARGUMENT"
```

---

## Our position while this is open

**We are not weakening or reshaping authorization to force a deploy.** The `returns` rule stays
narrowly scoped to `buyerId` / `sellerId` / admin.

Consequences, accepted deliberately:

- The `returns` collection remains **default-denied** in production, so Returns cannot load data.
- The application ships with an honest terminal state — *"You don't have access to returns for
  this shop"* plus a working Retry — rather than pretending data is unavailable for some other
  reason, and rather than the previous generic "Failed to load returns".
- The two `returns` composite indexes **are deployed and verified live**. They are additive,
  carry no authorization meaning, and are inert until the rule lands.

Batch 1 is therefore released as **PASS WITH RETURNS DATA-LAYER BLOCKER**, never as fully green.

## Next engineering task (separate track)

**Firestore Rules Release Recovery — reduce/reshape the default ruleset without changing
authorization semantics.** Not a blind size cut. Required order:

1. Snapshot current production rules before touching anything.
2. Run the complete existing rules suite to establish a green baseline.
3. Identify duplicate / redundant `match` and `allow` structures.
4. Consolidate **only** where semantics are provably identical.
5. Keep `returns` authorization narrowly scoped to `buyerId` / `sellerId` / admin.
6. Re-run the JDK 21 emulator suite.
7. Verify the compiled and released ruleset.
8. Only then deploy the reduced ruleset.

**Do not delete a legacy rule because it looks unused — prove its callers and collections
first.** An unused-looking `match` block is often the only thing standing between a forgotten
collection and the open internet.

## CI requirement (permanent)

`scripts/ci-gates.sh` runs the returns authorization suite and **fails** when Java is missing or
older than 21 — it must never degrade to a silent skip, because an unexecuted security suite
reads exactly like a passing one. JDK 21 belongs in the CI image
(`actions/setup-java` with `java-version: 21`), not as a local workaround.
