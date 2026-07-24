# Release Gate — Live Catalogue

**Status:** Active
**Runner:** `node scripts/gate-live-catalogue.js [--hours 24] [--json]`
**Verdicts:** `PASS` / `FAIL` / `BLOCKED` — never conflated.
**Related:** [[RELEASE_ACCEPTANCE]] · [[KNOWN_LIMITATIONS]] · [[PERFORMANCE_BUDGET]]

---

## The question this gate answers

> Do legitimate clients receive the live catalogue?

One binary runtime fact, answered from production telemetry rather than inference.

## Why it does not drive a browser

Every browser this project can drive — headless *or* headed Playwright — is classified as
automation by reCAPTCHA v3 and denied by App Check. Two conclusions in this repo were
withdrawn after being built on that probe effect:

| Withdrawn claim | What was actually true |
|---|---|
| "Deployed Firestore rules deny anonymous product reads" | Reads succeed in a real browser; `permission-denied` was an App Check/headless artifact |
| "App Check attestation fails, blocking Firestore platform-wide" | 36,922 VALID attestations in 7 days. The automation was the failing client |

In both cases **the tool was the failing client, not the platform**. A gate that reproduces
that probe effect would fail forever while real users were fine — or, worse, pass while they
were not. So this gate reads what real users already produced.

## Evidence sources

**App Check verification counts, split by target service.** This is the load-bearing signal.
App Check is evaluated **only for client-SDK traffic** — Cloud Functions use the Admin SDK and
bypass it entirely. A `VALID/ALLOW` against `firestore.googleapis.com` is therefore positive
proof that a real browser completed attestation *and was authorised to reach Firestore*. No
automation participates in this measurement.

**Firestore document read volume.** Confirms the data path is actually moving documents, not
merely authorised to.

**The catalogue itself, via the Admin SDK.** Confirms there is inventory to serve, and that no
demo-shaped documents have been written into production.

## Checks

| # | Check | Passes when |
|---|---|---|
| 1 | App Check accepted for a real client (Firestore) | ≥1 `VALID/ALLOW` against `firestore.googleapis.com` |
| 2 | Client denial rate within tolerance | ≤50% of client Firestore traffic denied |
| 3 | Firestore document reads observed | ≥1 read in the window |
| 4 | Catalogue has active products | ≥1 product with `status: active` |
| 5 | No demo products in the live catalogue | 0 documents with `F<n>` / `G<n>` ids |

`BLOCKED` means the gate could not obtain evidence — missing credentials, an API disabled, no
traffic in the window. **BLOCKED is not a pass.** It means the question is unanswered.

## Interpreting a failure

- **Check 1 fails** → no real client is getting through to Firestore. Investigate App Check
  registration, the reCAPTCHA v3 site key, allowed domains, and enforcement — in that order.
- **Check 2 fails** → the path works but is degraded for a large minority. Break the denials
  down by `security` label: `MISSING_OUTDATED_CLIENT` points at stale cached builds,
  `MISSING_UNKNOWN_ORIGIN` at an origin App Check does not recognise.
- **Check 3 fails with check 1 passing** → clients are authorised but not reading. Look at the
  listener attachment and the query, not at App Check.
- **Check 5 fails** → demo data has been written into production. Shoppers can find and attempt
  to buy listings that do not exist.

## First run — 2026-07-24

```
PASS    App Check accepted for a real client (Firestore)  — VALID/ALLOW=6711 DENY=3838 over 24h
PASS    Client denial rate within tolerance               — 36.4% denied (limit 50%)
PASS    Firestore document reads observed                 — 44793 reads over 24h
PASS    Catalogue has active products                     — 130 active of 130 total
FAIL    No demo products in the live catalogue            — 12 demo-shaped ids

GATE: FAIL
```

The gate found on its first run what browser probing had missed: **12 seeded demo products in
production Firestore** — `F8`–`F13` and `G20`–`G25`, all with Unsplash stock imagery and
invented sellers ("Style Point", "KenShop", "Green Farm Kenya"). These are distinct from
`script.js`'s `FALLBACK_PRODUCTS`; removing demo data from the client did not remove its
counterpart from the database.

The first four checks confirm the catalogue path itself is healthy for real users, which is the
question that had been open.

## Known limitation

This gate proves that real clients are authorised for Firestore and that documents are being
read. It does **not** isolate reads of the `products` collection specifically, nor prove that a
given page rendered them. It is a data-path gate, not a rendering gate — pair it with the
buyer-journey checks in [[RELEASE_ACCEPTANCE]].
