# SOKONI — Security, Privacy, Compliance & Operations Gap Census (2026-10-01)

**Type:** read-only census. Nothing in production was changed to produce it. An internal engineering
assessment, **not** a regulatory certification.
**Brief:** owner's "Final Security, Privacy, Access, Compliance, Observability, Accessibility and
Release Certification" programme, 2026-10-01.
**Related:** [[ODPC_COMPLIANCE_CERTIFICATION]] · [[SECURITY_CERTIFICATION]] · [[ROLLBACK_MANIFEST]] ·
[[EARN_WITH_SOKONI]] · [[REDIS_SECURITY]] · [[FIRESTORE_INDEX_AUDIT]] · [[Authentication]]

**Evidence labels:**
- **OBSERVED** — seen in code or config.
- **PROVEN** — confirmed against production or the serving artefact.
- **UNPROVEN** — not yet settled, with what would settle it.
- **LATENT** — a real defect that no production data exercises today.

---

## 1. Current baseline

| Surface | Live state | How established |
|---|---|---|
| Hosting | `72dca56`, v649, built 2026-09-30T17:48Z | `version.json` |
| Firestore rules | ruleset `b87c94e4`, released 2026-09-29T20:43Z | Rules API; **differs from every `firestore.rules*` in the tree** (~9.8k diff lines) |
| Storage rules | ruleset `182624f3` (2026-08-11) | byte-equivalent to `storage.rules` |
| Functions | 1,723 gen2 services, ingress ALLOW_ALL | `gcloud functions list --v2` |
| Composite indexes | 416 live, all READY; repo has 408, **8 live-only** | Firestore Admin API |
| Alerting | 22 policies, 2 email channels, 2 logs-based metrics | Monitoring API |
| Backups | 30 of 30 nightly exports succeeded; PITR 7 days; delete protection **off** | Firestore Admin API |
| Hosting history | 1,564 releases, unlimited retention, no preview channels | Hosting API |

Production Functions are a **union of lineages**. The hosting tree's `functions/` is not proof of
what serves. Findings marked PROVEN against functions were checked against the live source archive of
the named revision.

## 2. Ownership (peer sessions, 2026-10-01)

| Area | Owner | Constraint for this programme |
|---|---|---|
| Application decision chain (K13), rider wording, rider agreement enforcement, rider revocation | sokoni-27 | findings handed over; not built here |
| `sokoniChat` auth bypass, AI cost caps | sokoni-70 | owner decided 30/user/day + USD 5/day fail-closed; not built here |
| Reviews rules R0 (uncommitted), reviews moderation, footer (e78b940) | sokoni-70 | any rules release carries or coordinates R0 |
| AdminOS / Super Admin layout (54b72cc) | sokoni-aa | AdminOS failure views build on 54b72cc |
| landlord.html SDK + XSS, admin.html notices, `saveShopProfile` URL | sokoni-32 | not built here |
| LAN print bridge, `firebase.json` headers (bcadaa8) | sokoni-27 | header changes coordinate |
| providerPublish self-publish, `posPrint` relay, everything else below | this programme | — |

## 3. Known gaps, ranked

### P0 — live, user-visible or exploitable now

1. **Fabricated trust signals on live pages (PROVEN).**
   - The home page stats block shows fixed numbers (`index.html:2409-2451`).
   - Real counts are raised to a floor (`script.js:2062/2066/~4783`).
   - Six invented reviews appear whenever there are fewer than three real ones (`script.js:3195-3211`).
   - Real hospitals and pharmacies are shown as "VERIFIED" with invented ratings (`index.html:1462-1510`). Invented doctors are listed at real hospitals (`healthcare.html:856-880`).
   - Hardcoded "verified" sellers, seeded testimonials on eight hub pages, a random "live activity" feed (`marketing.html:519-534`), and random trust and chart numbers.
2. **Self-forged verification badge (PROVEN live, 0 documents).** `verifications/{uid}` can be created with `facets.*.state='approved'` (served rules 1553-1558). The live `profileGetPublicProfile` then shows the badges.
3. **Erasure never completes (PROVEN live, LATENT: backlog 0).** The nightly `finaliseExpiredDeletions` job fails with FAILED_PRECONDITION on every run: 59 errors in 35 days, the latest 2026-09-29T23:00Z. The `users(status, deletionScheduledAt)` index is missing. Positive control: 85 users readable, 0 in `pending_deletion`.
4. **The canonical sign-up records no consent (PROVEN).** `onboarding.html?mode=signup` is live since 72dca56. It shows no notice, has no terms/privacy acceptance, no age check and no `consentRecords` write. Google and phone sign-in also write no consent.
5. **Unsubscribe is broken and marketing suppression fails open (PROVEN code).**
   - The template link points to a missing section.
   - `_checkPreferences` returns true when there are no preferences or on error (`email-service.js:345-356`).
   - `sendBroadcastEmail` skips preferences entirely.
   - The `List-Unsubscribe` header is non-conformant.
6. **Fake contact details (PROVEN live).** `support.html:127` dials `+254700000000`, and the driver onboarding page gives the same placeholder number. `invoice.html` uses `@sokoni.co.ke`, an unrelated domain.
7. **Fake upload success in onboarding (PROVEN).** The ID, selfie and licence steps show "Uploaded ✓" without uploading anything (`onboarding.html:598-602,684`).

### P1 — access control and money-adjacent

8. **Orders (served rules).** The buyer writes `sellerUid`, and the seller branch may set `paid`, `refunded` and `confirmed` (362-365, 381-385). Moving to `confirmed` fires a cross-tenant inventory deduction (LATENT: inventory empty).
9. **Users.** Self-writable `payoutVerified`, `sellerVerified`, `emailVerified`, `accountStatus` and similar fields feed `_assessPayoutRisk` (LATENT: autoB2C off).
10. **providerPublish self-publishes** status active, searchable, bookable and `provider:true` with no admin decision (live providerDispatch lineage). The booking gate is circular. A fix exists as 2f4fc20 on the convergence line and needs a port.
11. **Rider onboarding data.** It is stored raw in `accountProfiles`, which has public read (LATENT: 0 docs). Rider national ID numbers sit in plaintext in `accountDrafts`.
12. **POS.** `posLookupCustomer` is cross-merchant. `posCompleteCheckout` has no product-ownership check. `posReceiveErpUpdate` writes documents across tenants.
13. **Other rules defects.**
    - Anyone, including unauthenticated callers, can create jobs under any uid: an operator-precedence bug at served rules 1809-1822.
    - Conversation squatting (640-643).
    - `deliveryRiders` location readable by any signed-in user.
    - A `deliveries` sender can set `status` or `assignedRiderId`.
14. **Rate limiting.**
    - Both Firestore limiters fail **open** on transaction error.
    - The Redis limiter always falls back, and its pos, wallet_lookup, default and search actions go unenforced.
    - There is no TTL on the limiter collections.
    - Roughly 42 of 1,678 callables reference any limiter.
    - IP keys and allowlists read the leftmost `X-Forwarded-For` value, including `webhookMpesa`'s only check.
15. **Password reset.** Firebase's fixed 1-hour oobCode is used. The only rate limit is client-side sessionStorage. There is no 25-minute gate.
16. **`posPrint` is a signed-in open relay** to client-chosen host and port, including 127.* and .local (reported by sokoni-27; to verify).

### P2 — operations, compliance hygiene, accessibility

17. **Alerts.**
    - The P95 latency alert threshold is 10 µs, a nanosecond unit error: 959 open events in 37 hours.
    - Five policies can never fire.
    - Delivery of alert emails is UNPROVEN.
18. **Missing indexes fail every run:**
    - self-heal: ~460 errors/day, 92% of all ERROR lines
    - fraud sweep
    - deletion
    - workspace invitations
    - `products`/`listings` `__name__ DESC`: the home listener and recommendations fail
    - `payouts(status, requestedAt)` is **withheld by owner decision** and is not proposed.
19. **The ops error view reads an empty collection and defaults to green.** The real `errorLog` has 315 reports, stores email, has no TTL and no admin view. AdminOS has no failure views. `revokeAllSessions` shows a false success.
20. **The rollback script is dangerous.** It stashes, then deploys all functions with `--force` from an old tag. `backup.yml` has failed 40 of 40 runs, although the GCP exports succeed. There are no Hosting preview channels.
21. **Two divergent privacy notices.** The footer, sign-up and banner link to the older `legal.html`. Cookie consent is stored in localStorage only, and the cookie policy claims Do Not Track support that does not exist.
22. **Data rights.**
    - The purge spec misses wallets, preferences, drafts, messages, reviews, addresses and five Storage prefixes.
    - Self-service cancellation of a deletion is unreachable.
    - `submitDataRightsRequest` has no auth, no App Check and no rate limit.
23. **Accessibility.**
    - 969 of 985 click handlers are on non-controls.
    - Login and checkout fields have no labels.
    - 26 pages block zoom.
    - Tertiary and placeholder text fail contrast.
    - 25 images have no alt text.
24. **Third parties and licensing.**
    - Nine Firebase SDK versions are loaded.
    - 16 CDN scripts have no SRI, including the payment SDK.
    - Checkout offers PayPal, Chipper, MTN and EcoCash, which have no working rail.
    - There is no licence inventory.
25. **Identity.** The main phone number `+254 800 SOKONI` is a placeholder. Two different DPO phone numbers are published. There is no generic error, 500 or 429 page.

## 4. Proven strengths

- **Firestore access.** `users` reads are owner-only, and authorization is claims-based. Wallets, payments, withdrawals, support, notifications, `consentRecords`, audit logs and sessions are owner-scoped or server-only.
- **Public profiles** use allowlist projections and answer private and missing users identically.
- **Storage** writes are uid-scoped with default deny, and SVG/HTML uploads are blocked.
- **Webhooks and endpoints.** Webhooks use HMAC with `timingSafeEqual` (IntaSend, FinOS, POS terminal, email). `mpesaC2B` has a URL token. HTTP endpoints call `verifyIdToken`. `kass` requires admin plus MFA.
- **Callables.** All 31 callables that read a client uid or role bind it to the caller.
- **Analytics.** GA4 is consent-gated, ad signals are denied, and there are no ad pixels.
- **Consent and data rights.** The signup.html path writes immutable `consentRecords`. There is a single signed-URL data export. The data-rights enum is aligned and deployed.
- **Backups.** 30 of 30 exports succeeded, and PITR covers 7 days.
- **Rollback.** Named-revision rollback has been exercised (`adminprocesspayout` 00024-mih, `webhookintasend` 00068-del).
- **Logging.** Logs are flowing, and 490 of 500 sampled lines are JSON.
- **ODPC registration.** The owner-supplied certificate (630-8669-F056, serial 24670, **Data Processor**, valid 28 Jul 2026 – 28 Jul 2028) matches `functions/company-identity.js`. It is displayed on legal.html (83363cd text + 3aa9f58 image).

## 5. Decisions only the owner can make

1. **Controller registration.** Privacy notices call Bravilex the **Data Controller**, but the certificate registers it as a **Data Processor**. Does a controller registration exist?
2. **Named DPO.** Who should be named as the DPO, rather than a role mailbox?
3. **Age.** Is 18 the threshold? Is there a guardian policy, or a strict block?
4. **KYC.** How long are KYC documents retained after verification?
5. **Main phone.** What is the real main phone number, replacing `+254 800 SOKONI`?
6. **Marketing consent.** Should marketing consent be captured at sign-up, as a separate unticked box?
7. **Index deploy.** Adding the erasure index needs explicit approval, given the earlier rejection of an index deploy for another slice. The recommended form creates **one** index and touches no other.
8. **Alert delivery test.** One test notification to the alert channel needs consent.
9. **Checkout payment cards.** Should the PayPal, Chipper, MTN and EcoCash cards be hidden until a server rail exists?

## 6. Deployment surfaces (per repair family)

| Family | Surface | Gate |
|---|---|---|
| Fabrication removal, contacts, a11y, notice links, legal display | Hosting | descends from live; one hosting deploy at a time; rides with or after the queued union |
| Verification forge, orders, users denylist, jobs, conversations, deliveryRiders | Firestore rules | port onto served lineage `f20be7d`; 3,638 B compiled headroom; carry sokoni-70 R0 |
| Erasure, self-heal, fraud, invitations, `__name__ DESC` | Firestore indexes | owner OK; create named indexes only; repo file gains the 8 live-only indexes before any file-wide deploy |
| providerPublish | `functions:providerDispatch` | port 2f4fc20 onto `candidate/providerdispatch-shell-gate`; live-archive diff |
| Password reset 25 min | 2 new functions + hosting page + TTL policy + rules deny | new functions; no live lineage conflict |
| Unsubscribe / suppression | email functions (lineage TBD) + hosting | live-archive diff |
| POS cross-tenant | `posLookupCustomer`, `posCompleteCheckout`, `posReceiveErpUpdate` | live-archive diff per function |
| P95 alert threshold | Monitoring policy patch | reversible config; record before and after |
| Error view, AdminOS failure views | `getErrorLog` + hosting on 54b72cc | coordinate sokoni-aa |
| Rollback | scripts and docs only; exercise on a preview channel | no production traffic change |

Full-functions deploys (`--only functions`) are **prohibited**. Every function change is a named, scoped
deploy after a live-archive content diff.
