# Proposed catalogue delta — operational dependencies, and five evidenced integrations

**Date:** 2026-09-29 · **Branch:** `feat/integrations-control-center` · **Proposal only. No entry
added, no taxonomy implemented, no test rebaselined, no deploy.**

Steps 1–6 of the owner's locked order. **Stops at step 7 — review of the exact delta — by
instruction.** Nothing here changes the count.

---

## 1 · The 47 baseline, frozen

```
count               47
sha256(sorted ids)  ac1b9ea3204f70756903762c0b95047f5f72e3bc0a00d26580f9fab1cbb82638
```

<details><summary>the 47</summary>

```
africastalking      age-verification    algolia             anthropic
api-gateway         app-check           artifact-registry   cloud-functions
cloud-monitoring    cloud-run           cloud-scheduler     cloud-storage
cloudflare          email-dmarc         email-password-auth erp-connectors
etims               facebook-login      fcm                 firebase-auth
firebase-hosting    firestore           firestore-indexes   firestore-sokoni-ops
google-signin       hostpinnacle-dns    hostpinnacle-mail   intasend-collections
intasend-payouts    intasend-webhook    inventory-webhooks  memorystore-redis
odpc                osm-nominatim       osm-tiles           phone-auth
platform-registry   pos-card-terminal   pos-external-api    pos-webhooks
recaptcha           secret-manager      sendgrid            smtp-fallback
sokoni-wallet       typesense           vertex-gemini
```
</details>

The digest is the anchor: any later claim that "nothing else changed" can be checked against it
rather than believed.

**Already covered, and named in the ask:** every GCP/Firebase service raised — `cloud-run`,
`cloud-functions`, `firestore`, `firestore-indexes`, `firestore-sokoni-ops`, `secret-manager`,
`cloud-monitoring`, `artifact-registry`, `memorystore-redis`, `firebase-hosting`, `cloud-storage`,
`app-check`, `cloud-scheduler`, `cloudflare` — plus **HostPinnacle, twice**: `hostpinnacle-dns` and
`hostpinnacle-mail`.

> If Cloud Run and Firestore read blank in the console, that is **not a missing entry**. It is the
> Step B / Step E wiring sitting committed and undeployed. Firestore and Cloud Storage are two of
> the only three rails whose probe actually runs today.

## 2 · The taxonomy

```
CODE INTEGRATION                    OPERATIONAL DEPENDENCY
SOKONI code talks to the provider   SOKONI's BUSINESS relies on the provider
      ↓                                   ↓
a probe path may exist              no SOKONI code path exists
      ↓                                   ↓
evidence model applies              NOT PROBEABLE BY DESIGN
```

**An operational dependency must never render as `unknown`, NOT VERIFIED, or REFUSED BY DESIGN.**
Those three belong to the evidence model and each means something specific:

| status | means |
|---|---|
| `unknown` / NOT VERIFIED | measurable here, not yet established |
| REFUSED BY DESIGN | a probe **exists** and deliberately will not run |
| **NOT PROBEABLE** *(new)* | **there is no SOKONI probe path at all** |

The difference matters because the first two are *states of our measurement*, and the third is a
*property of the relationship*. Collapsing them would put "we haven't got round to it" and "there is
nothing here to measure, ever" in the same grey bucket — which is the failure the whole absence
partition exists to prevent.

An operational dependency therefore carries **no** `requiredSecrets`, **no** stage model, **no**
`probeAvailability`, and **no** evidence record. It is inventory, not measurement.

### What it does NOT change

Operational dependencies are a **separate list**, not new members of the 47. The console shows two
sections:

```
INTEGRATIONS                        OPERATIONAL DEPENDENCIES
──────────────────────────          ──────────────────────────
47 technical integrations           Google Workspace   NOT PROBEABLE
                                    Google Admin       NOT PROBEABLE
```

with the chip text saying **"No SOKONI probe path"** rather than reusing an evidence-model state.

## 3 · Candidate classification

| candidate | evidence | treatment |
|---|---|---|
| **Google Maps** | CSP allowlists `maps.googleapis.com` + `maps.gstatic.com`; `service-worker.js:382`; `rider-nav.html:449` launches it for rider navigation | **ADD** — code integration |
| **GA4 / Tag Manager** | 38 code files; CSP allows `googletagmanager.com`, `google-analytics.com` | **ADD** — code integration ¹ |
| **Firebase Remote Config** | `functions/feature-flags.js`, `sokoni-flags.js` | **ADD** — code integration |
| **Cloud Logging** | `functions/gcp-evidence.js` | **ADD** — code integration |
| **Eventarc** | 6 files | **ADD** — code integration |
| Firebase Performance | 1 file (`seller-success.html`) | **HOLD** — weak |
| Cloud Build | 1 file, and it is AR-forensics tooling | **HOLD** — weak |
| **Google Workspace** | **none** | operational-dependency candidate |
| **Google Admin** | **none** | operational-dependency candidate |
| cPanel | **none** — the hit was the regex matching the variable `discPanel` | **DO NOT ADD** |
| Twilio | SendGrid's vendor name, already catalogued | **DO NOT ADD** |
| Stripe · Flutterwave · Mailgun · Visa · Mastercard · Apple Pay · Google Pay · Airtel · Sendy · Fargo · **MPESA** | declared in `sokoni-webhook-engine.js` | **DO NOT ADD** — see §4 |

¹ **One caveat on GA4:** no `G-XXXXXXXX` measurement id is committed anywhere. The loader and the
CSP allowance are present; the id is not. So "GA4 is wired" is evidenced and "GA4 is *configured*"
is not. It should be added with that distinction intact, not as a working analytics rail.

Nothing with zero evidence is proposed: not BigQuery, Pub/Sub, Cloud Tasks, Cloud KMS, Cloud DNS,
OpenAI, Sentry, Cloudinary, OneSignal, Mixpanel, Hotjar, Pesapal, WhatsApp Business API, reCAPTCHA
Enterprise, Dynamic Links or Crashlytics (whose only hit was `skills-lock.json`).

## 4 · `sokoni-webhook-engine.js` — investigated, and it is not what it says

**It is reachable and it does execute.** `index.html:4151-4166` lazily injects it after the load
event, on idle, in a ten-script `LAZY` array. Every homepage visitor runs it. `vision-2030.html`
lists it separately as a roadmap item marked *done*.

**It makes no network calls of any kind.** No `fetch`, no `XMLHttpRequest`, no `axios`, no
`httpsCallable`, no `.post(`. 485 lines.

Its own header claims:

> *"Client-side webhook delivery manager and server-side relay coordinator. Every external payment
> provider, courier, and integration partner sends events through a single hardened pipeline."*

There is no pipeline. The file declares **17 providers** — `intasend`, `mpesa`, `stripe`,
`flutterwave`, `airtel_money`, `visa`, `mastercard`, `apple_pay`, `google_pay`, `smartpos`, `sendy`,
`fargo`, `africastalking`, `mailgun`, `twilio`, `firebase`, `custom` — each with a webhook path, and
cannot contact any of them.

**So these are declarations, not integrations** — the Daraja warning, and stronger: Daraja at least
had code that once ran. Three consequences worth separating:

1. **None belongs in the catalogue as an integration.** The registry's existing Daraja lane is the
   right model: named as explicitly excluded, with the reason.
2. **`mpesa` is declared here although Daraja is retired**, and `stripe`, `visa`, `mastercard`,
   `apple_pay`, `google_pay`, `airtel_money` are declared although **IntaSend is the sole payment
   provider and merchant of record**. This contradicts a standing policy decision.
3. **It is a claim surface, not just dead weight.** It ships to every homepage visitor, so anyone
   reading the delivered JavaScript sees SOKONI declaring support for Stripe, Visa, Mastercard and
   Apple Pay. That is a representation about the business, made in production, that the platform
   cannot honour.

**Recommended as its own lane, not part of this delta:** decide whether the file is retired, reduced
to IntaSend, or kept as a client-side stub — and do it deliberately, the way `intasendWebhook`
retirement was gated. This proposal does not touch it.

## 5 · The proposed delta, exactly

**Code integrations — five added, 47 → 52.** None is payments; none affects the IntaSend-only
policy.

| id | category | vendor | healthKind | probe |
|---|---|---|---|---|
| `google-maps` | infra | Google | `measurable` | none — hand-off + tiles; no executor proposed |
| `ga4-analytics` | infra | Google | `elsewhere` | none — authoritative in the GA4 console |
| `firebase-remote-config` | infra | Google | `measurable` | none proposed yet |
| `cloud-logging` | infra | Google | `elsewhere` | none — authoritative in Cloud Logging |
| `eventarc` | infra | Google | `measurable` | none proposed yet |

**Operational dependencies — a new, separate list of two.** Not part of the 47 and not part of any
count the existing suites pin.

| id | what it is | why it is not an integration |
|---|---|---|
| `google-workspace` | company email / identity | no SOKONI code path; zero code evidence |
| `google-admin` | Workspace administration | no SOKONI code path; zero code evidence |

`cpanel` is **excluded** pending independent verification — current evidence is a false positive.
**HostPinnacle as an operational account** is deliberately **not** proposed here: `hostpinnacle-dns`
and `hostpinnacle-mail` already exist as code integrations, and adding a third HostPinnacle row
before the two lists are visibly distinct in the UI would read as duplication rather than as a
different kind of fact. It is worth adding **after** §2's two-section console exists.

### What this delta would break, deliberately

| guard | today | after |
|---|---|---|
| `test-integration-registry-parity.js` | 26/0 across 47 | fails until both files carry the five |
| absence partition, pinned counts | 3 · 4 · 9 · 15 · 5 · 11 = 47 | fails until rebaselined |
| baseline digest | `ac1b9ea3…` | changes |

**That is the guard working, not an obstacle.** These suites exist so a catalogue change cannot
happen quietly. Rebaselining them is **step 8** and is not authorized by this proposal.

## 6 · Not done — stops here by instruction

- **No entry added.** No change to `sokoni-integration-catalogue.js` or
  `functions/integration-registry.js`. The count is still 47 and the digest still matches.
- **No taxonomy implemented.** `OPERATIONAL_DEPENDENCY` and NOT PROBEABLE are specified here, not
  coded.
- **No test rebaselined**, no console change, no deploy.
- **`sokoni-webhook-engine.js` untouched** — investigated only.
- **UNPROVEN:** whether the *deployed* production bundle matches this source; whether GA4 has a
  measurement id configured outside the repository; whether cPanel is used operationally at all.
