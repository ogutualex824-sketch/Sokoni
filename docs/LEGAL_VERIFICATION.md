# Legal Verification Authority

> CHANGELOG 220 · 2026-09-27 · branch `feat/creator-hub` · **not deployed**
> Related: [[Legal Hub]] · [[AdminOS]] · [[Authentication]] · [[Payments]] · [[ADR-014-healthcare-provider-identity-convergence]] · [[ADR-015-healthcare-payment-convergence]]

This document describes how SOKONI decides whether an advocate may be listed or requested and, later, whether they can be booked and paid.

## The rule

An advocate is **bookable only when two independent authorities agree**:

| Layer | Authority | Recorded by | Meaning |
|---|---|---|---|
| 1. SOKONI administrative verification | the AdminOS application decision (`applicationDecide`) | an administrator holding the canonical `admin` / `superAdmin` claim | SOKONI reviewed the identity and application |
| 2. LSK professional verification | the Law Society of Kenya practising status, from the **official LSK source** | Mode A: an authorized LSK integration (**not available**). Mode B: an administrator checking the official LSK advocate search | the advocate holds a current practising status of **Active** |

- **Admin approval alone is not "LSK verified".**
- **LSK evidence alone is not a SOKONI approval.**
- **Nobody can set "bookable" by hand.** It is always derived.

```
Application submitted ─► AdminOS review ─► SOKONI decision ─┐
                                                              ├─► eligibility() ─► listed / requestable
P.105 + official LSK source ─► LSK verification ────────────┘                 └─► canonical booking gate
```

## The one predicate — `functions/legal-verification.js` `eligibility(lp, now)`

The predicate is bookable only if **all** of these hold:

- `verification.admin.status == 'approved'`;
- `verification.lsk.status == 'verified'` **and** `practiceStatus == 'Active'`;
- `verification.lsk.source` is one of the two known sources, so no client value can pass;
- `validUntilMs > now`, meaning the verification is still current; it is evaluated at **read** time;
- `verification.providerLink.status == 'linked'`, meaning one canonical `providers/{uid}` identity;
- the record is not quarantined.

Any other state returns a private code, for example `ADMIN_PENDING`, `LSK_PENDING`, `LSK_SUSPENDED`, `LSK_STALE` or `PROVIDER_NOT_LINKED`.

**Who calls the predicate:**

| Surface | Behaviour |
|---|---|
| `getLegalProviders` | lists eligible advocates only, as a public projection |
| `getLegalProvider` | returns the public projection only |
| `bookLegalConsultation` | accepts a request only for an eligible advocate |
| `ent-availability.loadCalendar` → `bookingGate()` | the canonical availability authority asks the Legal authority about any provider that has a Legal record, claims a legal category, or carries `legalProviderId` |

The browser only hides; the server enforces.

## Practising status

LSK reports six practising statuses. Only **Active** passes.

| LSK practising status | `lsk.status` | Bookable |
|---|---|---|
| Active | verified | ✔ (while current) |
| Inactive | failed | ✘ |
| Struck Off | failed | ✘ |
| Deceased | failed | ✘ |
| Suspended | suspended | ✘ |
| Unknown | unknown | ✘ |

**Identity binding:**
- The P.105 number must equal the advocate's registered number (`P105_MISMATCH` otherwise).
- The name LSK returns must match the registered advocate. A mismatch is **recorded as a failed verification** as evidence; it is never passed.

## Expiry and re-verification

LSK practising certificates run **January to December**. An Active result is current only until **31 December, 23:59:59 Africa/Nairobi** of the year it was checked in.

- A check dated in a previous practising year is recorded as `expired`.
- An optional **shorter** maximum age can be set in `platformConfig/legalVerificationPolicy.maxEvidenceAgeDays`. It is unset by default; no interval is invented.
- AdminOS **Request re-verification** sets LSK back to `pending`, so the advocate is not bookable until a new check is recorded. The previous result is retained in `legalVerifications.lskPrevious` and in the event history.

## LSK integration: Mode A and Mode B

**LSK automated integration: NOT AVAILABLE / NOT AUTHORIZED.** No LSK endpoint, credential, contract or configuration exists in the repository. Accordingly:

- `functions/lsk-adapter.js` is the seam for a future authorized integration. Its contract is `available()` and `lookup(p105) → { p105Number, name, practiceStatus, checkedAtMs, reference }`.
- Today `available()` is `false`, and the AdminOS button says so and writes nothing.
- It does **not** scrape the public LSK search, automate a login or invent an endpoint.

**LSK verification today uses the official-source evidence workflow (Mode B).** An administrator checks the official LSK advocate search and records:

- the P.105 number;
- the name returned;
- the practising status;
- the date checked;
- an evidence reference;
- notes.

The server stamps the reviewer and the source `lsk_official_source_manual`. It is labelled everywhere as *"Official LSK source — checked and recorded by a SOKONI administrator (manual)"*. A future Mode A result is labelled *"Authorized LSK integration (automated)"*. The source is set by the calling path, never by the client.

## Data

All of this data is server-written. In `firestore.rules` every collection below has `write: if false`.

| Collection | Contents | Read |
|---|---|---|
| `legalProviders/{uid}` | profile + `verification` summary (admin, lsk, providerLink, eligibility) + derived `status` | the advocate, admins |
| `legalVerifications/{uid}` | private current detail: reviewer, reason, P.105, name returned, evidence ref, notes, `lskPrevious` | admins |
| `legalVerificationEvents/{id}` | append-only history: actor · action · target · previous · next · reason · time | admins |
| `legalProviderQuarantine/{uid}` | removed legacy identities with the verbatim legacy data | admins |
| `lawyers/{uid}` | the public directory card, projected only while eligible (`projectedBy: 'legal-verification'`) | public; clients can no longer create or edit |

The public surfaces never carry the licence number, phone, reviewer, evidence or audit references.

## Provisioning into the canonical engine

When the SOKONI decision is **approve**:

- **Create or link one `providers/{uid}`** (`provisionedBy: 'legal-verification'`, `legalProviderId: uid`).
  - A self-created *pending* provider doc is adopted.
  - An **active provider of another kind is never merged**. The link is recorded as `conflict`, and the advocate is not bookable until an administrator resolves it.
- **Create an inactive consultation service** at `providerServices/legal_consult_{uid}`, priced from the Legal record.

In this slice the provider stays `searchable: false`, `acceptsBookings: false`. The canonical gate returns `LEGAL_BOOKING_NOT_ENABLED` even for an eligible advocate.

## AdminOS › Legal Verification

`admin-os.html#legal` → `sokoni-aos-legal.js`, served by `adminOsDispatch` ops `legalAdmin*`. For each advocate it shows:

- identity;
- the canonical provider link;
- the application and its SOKONI decision (Approve / Reject / Suspend call the existing `applicationDecide`);
- the LSK section (status, practising status, source label, checked date, current-until date, STALE flag, evidence);
- the server-derived **BOOKABLE / NOT BOOKABLE** result;
- the full audit history.

There is no bookable toggle. `legal-admin.html` no longer approves advocates; it points here. `approveLegalProvider` is retired and refuses: it required a numeric role claim that nothing mints.

## T.M.M & Partners Advocates

The legacy record (`legalProviders/ZrG4N8SETmS7NMEg0src1NYjBw23`) was written `active` by `scripts/onboard-batch2.js` with a blank LSK number and `verified: false`.

**Code-level protection (this commit, once deployed):** the predicate refuses it everywhere. It has no SOKONI decision and no LSK verification, so it is not listed, not requestable, not bookable, and not in site search.

**Removal is a separate, owner-authorized data step.** Owner decision 2026-09-27: `scripts/migrate-legal-quarantine.js`.

- The dry run is the default.
- `--apply --operator=<admin uid>` moves the record into `legalProviderQuarantine/{uid}`: legacy data, action, reason, time, script version, operator, `lskVerificationFabricated: false`.
- It then deletes the registry record and the directory card, clears `users.hasLegalProfile`, and appends a `quarantine` event.
- A quarantined uid cannot register again or be re-approved until it is deliberately released.
- `onboard-batch2.js` no longer writes it.
- **The migration has not been run.**

## What is NOT in this slice

**Legal payment.** The next slice will:
- map the `legal` commission lane in `provider-hub` (`commission-config` `legal: 5%`);
- activate the consultation service;
- flip `LEGAL_BOOKING_ENABLED`;
- use the canonical `service_booking` → IntaSend held payment → settlement / refund.

There will be no Legal payment engine.

**Known limitations:**
- The public directory and chat still address an advocate by account uid, which is platform-wide practice (`messages.html?with=`).
- `legalCommissions` (a dead client write on `legal-hub.html`) is still to be retired with the payment slice.
