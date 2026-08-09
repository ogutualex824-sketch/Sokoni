# Firestore Rules Release Blocker — `releases/cloud.firestore` returns 400

> **Status:** NARROWED to a 22-line block · Returns authorization is now LIVE
> **Opened:** 2026-08-09 · **Updated:** 2026-08-10
> **Impact:** analytics RBAC + eTIMS audit rules cannot reach the `(default)` database.
> **Production risk:** none introduced. Every experiment released content that was either
> byte-identical to live or purely additive, and production was verified after each.
> Related: [[MERCHANT_ROUTE_MATRIX]], `firestore.rules`, `scripts/test-returns-rules.js`

## What changed since the first draft

**The size hypothesis is DISPROVED.** The first version of this document led with the ruleset
being at 98.7% of the documented 256 KiB limit. That correlation was real and wrong.

A ruleset padded with **comments only** — zero semantic effect — to **exactly 258,746 bytes**,
the failing size, released **200 OK**. Size is not the constraint. Had we trusted the
correlation we would have spent days consolidating 730 `match` blocks in production security
rules for nothing.

**Returns authorization is live.** Bisecting proved the returns rule was never implicated:
live + the returns block alone released 200 OK and is now in production, verified by
re-downloading the released ruleset.

## The actual finding

The 400 is caused by the **content of one 22-line block**, not by size, not by the returns rule,
and not by anything about the release mechanism.

| Ruleset under test | bytes | `PATCH releases/cloud.firestore` |
|---|---|---|
| live, unchanged (re-release) | 253,367 | **200** |
| live + comment padding to the failing size | 258,746 | **200** |
| live + returns block only | 254,990 | **200** |
| live + hunk #1 (`users/{uid}/analytics`) | 255,335 | **200** |
| live + hunks #1–#2 | 256,407 | **400** |
| live + hunks #1–#3 | 256,552 | **400** |
| live + hunks #1–#6 | 258,773 | **400** |

**Hunk #2 flips it.** It adds three things at once:

```
  /* nested under shops/{uid} */
  match /analytics/{doc} {
    allow read:  if isAdmin() || (isAuthed() && request.auth.uid == uid);
    allow write: if false;
  }

  /* NEW top-level path */
  match /analytics/{doc} {
    allow read:  if isAdmin();
    allow write: if false;
  }

  match /productAnalytics/{productId}   { allow read: if isAdmin(); allow write: if false; }
  match /categoryAnalytics/{categoryId} { allow read: if isAdmin(); allow write: if false; }
  match /analyticsParityLog/{entryId}   { allow read: if isAdmin(); allow write: if false; }
```

Splitting those three apart requires further production releases and has not been done yet.
Note that `match /analytics/{doc}` then exists at **three levels** — under `shops/{uid}`, under
`branches/{branchId}`, and newly at the top level — while hunk #1's
`users/{uid}/analytics/{doc}` released fine on its own.

## Second finding — the upload round-trip corrupts UTF-8

Downloading the ruleset we had just uploaded shows **replacement characters (U+FFFD) where the
uploaded file had clean box-drawing characters**:

```
uploaded : /* ── Landlord properties ───────────────────────────────────────────────────
returned : /* ── Landlord properties ──────────────────────────────�────────────────────
```

Three comment lines differed this way, a 9-byte delta, on content we had just written. The
originally-captured live ruleset carries the same kind of mojibake, so this has happened before.

In these instances the corruption landed in comments and is harmless. **It is a plausible
mechanism for the 400 itself**: if the same mangling hits a rule line rather than a comment, the
service would be validating content it corrupted, and `INVALID_ARGUMENT` with no field violation
is exactly what that would look like. This is a question for Firebase, not something we can
determine from outside.

## Reproduction

```bash
export CLOUDSDK_PYTHON=bundled
npx firebase deploy --only firestore:rules --project sokoni-aeb26 --debug 2>&1 \
  | grep -E "releases/cloud.firestore|INVALID_ARGUMENT"
```

```jsonc
// REQUEST
PATCH https://firebaserules.googleapis.com/v1/projects/sokoni-aeb26/releases/cloud.firestore
{ "release": { "name": "projects/sokoni-aeb26/releases/cloud.firestore",
               "rulesetName": "projects/sokoni-aeb26/rulesets/<id>" } }

// RESPONSE
{ "error": { "code": 400, "message": "Request contains an invalid argument.",
             "status": "INVALID_ARGUMENT" } }
```

The CLI then falls back to `POST /releases`, which returns **409 ALREADY_EXISTS** because the
release exists. **The 409 is a red herring** — the actionable error is the 400.

### Control case — identical shape, succeeds

`PATCH .../releases/cloud.firestore/sokoni-ops` returns **200** in the same command, same
second, same credentials.

## Ruled out, each with evidence

| Hypothesis | Verdict |
|---|---|
| Ruleset size | **DISPROVED** — comment-padded to the identical failing size released 200 |
| Compilation error | Ruled out — CLI reports success and the ruleset resource is created |
| The returns rule | **DISPROVED** — live + returns alone released 200; it is in production |
| Multi-database config | Ruled out — reproduced with a temporary single-database `firebase.json` |
| Rate limiting | Ruled out — reproducible across many attempts over hours |
| IAM / permissions | Ruled out — same credentials PATCH `sokoni-ops` successfully |
| Database state | Ruled out — both databases are `STANDARD` / `FIRESTORE_NATIVE` |
| Tooling version | Ruled out — firebase-tools 15.26.0, current |
| The release being un-updatable | Ruled out — the live ruleset re-releases 200 whenever content permits |

## Questions for support

1. What in the hunk #2 content makes `releases.patch` return `INVALID_ARGUMENT`, when the same
   file plus 5 KB of comments releases fine? Can the actual constraint be surfaced — the error
   carries no `field_violations`.
2. Is there a limit on `match` paths that repeat at multiple nesting levels, or on total
   top-level match statements, enforced only at release?
3. **Why does the stored ruleset differ from the uploaded bytes?** We can reproducibly upload
   clean UTF-8 and download U+FFFD replacement characters in its place.

## Position while this is open

Authorization is not being weakened or reshaped to force a deploy, and **no rules are being
consolidated to chase a size limit that has been proven not to exist**.

- `returns` — **LIVE**, scoped to `buyerId` / `sellerId` / admin, emulator-proven 20/20.
- `users/{uid}/analytics` — **LIVE** (released cleanly during the bisect).
- Remaining analytics RBAC + eTIMS audit rules — **still blocked**. Those collections stay
  default-denied, which is closed rather than open, so the failure mode is a feature not
  working rather than data being exposed.

## Next steps

1. Split hunk #2 into its three additions and identify which single block flips the release.
   Each attempt is one production release, so this is deliberate and paced.
2. File with Firebase support using this document — question 3 in particular is evidence they
   can act on without any access to our project.
3. **Do not** trim or consolidate the ruleset on the assumption that size matters.

## CI requirement (permanent)

`scripts/ci-gates.sh` runs the returns authorization suite and **fails** when Java is missing or
older than 21 — never a silent skip, because an unexecuted security suite reads exactly like a
passing one. JDK 21 belongs in the CI image (`actions/setup-java` with `java-version: 21`).
