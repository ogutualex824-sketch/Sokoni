# SOKONI Legal Engine v2 — Digital Agreements & Signatures

**Commits:** `d3d3bb2` (backend) · `cb962c4` (UI) · **Deployed:** legalDispatch + hosting
**Status:** built and verified in a real browser · **not yet enforced** (see Rollout)

---

## What this is

The engine **already existed** and its spine was right: role-scoped catalogue,
server-captured IP + timestamp, append-only audit, deterministic (idempotent) ids,
dark-launched enforcement. It was **extended, not rebuilt**. 13 ops → **21**.

What was genuinely missing: **a signature**. `acceptanceMethod` was hard-coded
`'checkbox'`.

---

## Digital signature

Three lawful forms — **drawn**, **typed** legal name, **business stamp**. Each is an
electronic signature under Kenya's Business Laws (Amendment) Act / ETA *provided
intent and attribution are recorded*, which the audit record now does.

We store a **SHA-256 hash** of the drawn/stamped image, **never the raw image**: it is
biometric-adjacent personal data, and the hash is sufficient to prove the artefact
presented at signing has not been altered since.

Server rejects (all 7 tested): no signature · unknown type · name < 2 chars ·
unconfirmed checkbox · empty image · image > 400 KB.

The **typed** option is deliberately retained: a draw-only signature would exclude
keyboard and screen-reader users.

## Professional Declaration

A **separate** attestation, not a second checkbox — truthfulness, authority to bind the
business, compliance with Kenyan law, consent to electronic records. Folding it into
"I have read the terms" would weaken both statements.

**Required for all 9 professional roles. Not required for buyers.** Verified both ways.
Versioned independently (`DECLARATION_VERSION`), so it can be restated without
republishing every policy.

## Digital Acceptance Certificate

One immutable document per signing event: acceptance id, user, business, role,
agreements + versions, signature type + hash, IP, country, User-Agent, device, **server
timestamp**. Deterministic id = the acceptance id, so a retry regenerates the **same**
certificate rather than minting a second one for one signing event.

`legalGetCertificate` enforces ownership. Without that check it is an **IDOR** leaking
names, IPs and signature hashes.

## Read evidence — recorded, and honestly labelled

`opened` / `dwellMs` / `scrolledToEnd` per agreement, stored verbatim and tagged
`source: 'client-reported'`.

**It authorises nothing.** A dwell timer is trivially faked; gating acceptance on it
would be security theatre. What authorises acceptance is the **signature + declaration**,
both validated server-side. Recording it honestly is what makes it useful in a dispute.

## Country — from the edge, not the client

`x-appengine-country` / `cf-ipcountry`, falling back to the client hint **only for
display**, with `countrySource` recorded. Tested: a client claiming `US` from behind a
`KE` edge is recorded as **KE**.

## Scheduled versions · rollback · preview

- **Schedule**: activates itself once `effectiveFrom` passes — on the **server** clock.
  No deploy needed.
- **Rollback**: republishes an **existing** version from append-only history and
  **refuses to invent one that never shipped**. Cancels any pending schedule. History is
  never deleted.
- **Preview**: shows what a role will see at a future instant, without publishing.

## Module registry — the engine as a platform service

A new module registers its role's agreements (`legalRegisterAgreements`) and inherits
presentation, acceptance, signatures, auditing, versioning, certificates and enforcement
with **no change to the engine**.

`CORE` is always prepended and **can never be overridden away** — a module must not be
able to opt its users out of the Privacy Policy.

---

## Cost

**Zero new Cloud Functions.** `legalDispatch` lazily pulls `_h`, so all 8 new ops route
through the existing service. That matters at **1,410 / ~1,500** Cloud Run capacity.

---

## Verified

**Backend** (stubbed Firestore, real ops):
7/7 signature rejections · idempotency (same signature twice → **one** record, not two
signing events) · drawn ≠ typed hash · raw image **not** stored · declaration enforced
for professional roles and not for buyers · scheduled version activates on server clock ·
rollback refuses unpublished versions · non-admin blocked from schedule/preview.

**UI** (real Chrome, iPhone-sized viewport):
Rail `Review → Accept → Sign → Declare → Activate` · reading time on cards · modal with
summary + key points + ESC · card flips to "Reviewed" · **Draw / Type / Stamp** tabs ·
drawn signature enables Continue · 6 declaration statements · `Activate my business` ·
trust badge + certificate + PDF link · **0 JS errors** · consent box never pre-ticked ·
**no client clock sent**.

---

## Rollout — NOT yet enforced

Enforcement remains **dark-launched per role** (`legalConfig/enforcement`). Nothing is
being blocked yet. Existing acceptances stand; only new **versions** require
re-acceptance; no account is ever deactivated.

To go live for a role: `legalSetEnforcement({ role: 'merchant', enabled: true })`.

## Not done

- **Legal Centre** still lacks the signature/certificate history UI (backend ops
  `legalMyCertificates` / `legalGetCertificate` exist and are deployed; the page is not
  yet wired to them).
- **PDF generation** is a link to the Legal Centre, not a rendered PDF.
- **Admin UI** for schedule/rollback/preview is not built — the ops are deployed and
  callable, but there is no panel yet.
- Not tested on a physical device.
