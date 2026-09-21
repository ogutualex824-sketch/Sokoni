# Integrations Control Center

One integrations surface, mounted by both platform-admin consoles.

- **[[AdminOS]]** — `admin-os.html`, sidebar → Platform → **Integrations** (`claims.admin`)
- **[[Super Admin]]** — `super-admin.html`, sidebar → Operations → **Integrations** (`claims.superAdmin`)

`admin.html` is deliberately **not** a consumer (owner ruling, 2026-09-19).

Related: [[Payments]] · [[SmartPOS]] · [[Authentication]] · [[Platform Registry]] · [[Security]]

---

## Why one module, two mounts

SOKONI is flat multi-page HTML with no router and no build step. Two consoles
rendering the same registry from two hand-written copies is how surfaces diverge.
`sokoni-integrations.js` is mounted verbatim by both pages; a change to how an
integration is judged healthy lands in both consoles at once, or in neither.

Neither console was redesigned. Each gained one sidebar button inside an existing
group and one panel. The module adopts whichever colour tokens the host page
defines (`--aos-*` in AdminOS, `--surface`/`--border`/`--accent` in Super Admin)
through a local token layer with fallbacks, so no page restyles it.

## Files

| File | Role |
| --- | --- |
| `sokoni-integrations.js` | The console. Renders, reads canonical Firestore, owns all status derivation. |
| `sokoni-integration-catalogue.js` | The declared inventory of every system SOKONI integrates with. Identity and wiring only. |
| `tests/certify-integrations-console.js` | Certification. Runs the real module against a scripted Firestore and asserts on rendered output. |
| `tests/sabotage-integrations-console.js` | Pre-flight sabotage. Plants real defects and proves the suite catches each one. |

## What it shows

Six tabs:

1. **Catalogue** — every integration SOKONI has, grouped by category, with a live
   signal overlaid where one exists.
2. **Registered** — `platformServices`, with health derived from `platformHealth`.
3. **Capabilities** — which services declare which platform capability, and which
   declared capabilities are not in the well-known list.
4. **Dependencies** — `platformDependencies` edges, flagging targets that are not
   in the registry.
5. **Webhooks** — `posWebhooks`: merchant endpoints, failure counts, last delivery.
6. **Credentials** — every secret **name** the catalogue declares and which rails
   depend on it.

## Data authority

Every figure comes from a canonical Firestore collection and nothing else.

| Collection | Read by | Rule |
| --- | --- | --- |
| `platformServices` | Registered, Capabilities | `allow read: if isAdmin()` |
| `platformHealth` | status derivation | `allow read: if isAdmin()` |
| `platformDependencies` | Dependencies | `allow read: if isAdmin()` |
| `posWebhooks` | Webhooks | `sellerId == uid \|\| isAdmin()` |

No Cloud Function and no rules change is required, which matters while the
Artifact Registry forensics freeze stands.

### Unknown is not zero

A read that **fails** renders an em dash and names the unavailable source. A read
that **succeeds** and returns nothing renders a real, canonical `0` and says so.
Those two states look different on purpose. A service with no `platformHealth`
document is `No heartbeat` — never `Healthy`.

Certification enforces this on both code paths: the KPI tiles **and** the tab
pill counts. Pre-flight sabotage found the pills uncovered on the first pass; the
gap is now closed and proven.

## Relationship census — the Step 1 gate

```
node scripts/integration-relationship-census.js          # human-readable
node scripts/integration-relationship-census.js --json   # artifact
```

Every catalogue entry must have an established relationship to each layer
beneath it — or an explicit statement that it has none. This is a **gate**: any
entry it cannot fully answer exits non-zero. Run it before committing work on
this surface.

```
catalogue -> registry -> AdminOS reachability -> probe definition -> executor
          -> backend authority -> collections -> provider -> evidence source
```

Every column is **derived** from the modules themselves. A hand-maintained
census is a transcription surface — that is how the obsolete "23 of 35" probe
figure survived past the catalogue reaching 47.

**Reachability is proven by rendering.** The census mounts the real console,
renders the catalogue tab, and collects the detail targets the markup actually
emits. It renders with no Firestore and no Functions, so every read fails and a
card must still render — if a failed read hid the grid, that is the finding.

Checked in both directions: nothing may exist in the registry, the executor
table, or as a rendered target without a catalogue entry behind it.

### Current state — passing

```
catalogue 47 · registry 47 · reachable 47 · backend authority 47
```

### The real probe gap

```
probeable lifecycles     43 of 47   (4 quarantined or frozen)
with an executor         12
  refuse by design        9         no safe probe, or needs a secret binding
  RUNNABLE TODAY          3         firestore · memorystore-redis · cloud-storage
NO executor at all       31
```

Only three probes can run. Seven more need a secret binding, which is a
**deployment** change. Two refuse by design — initiating a payment or a payout to
test a rail is not a probe.

> The census establishes relationships **in this repository**, not in production.
> "Backend authority: 47" means the resolver answers for all 47 in source; the
> deployed dispatcher would still return `not-found`.

## The estate, as catalogued

47 entries. Identity and wiring only — no figure lives here.

| Category | n | Notable |
| --- | --- | --- |
| Payments | 5 | IntaSend only. No Daraja, no Stripe, no PayPal — see below. |
| Messaging | 6 | SendGrid **sends**; HostPinnacle/MailBaby **receives**. |
| Search | 2 | Algolia, Typesense |
| Compliance | 2 | KRA eTIMS, ODPC |
| Identity | 7 | Google, Facebook, phone OTP, email/password, reCAPTCHA, Auth, age |
| AI | 2 | Anthropic, Vertex Gemini |
| Infrastructure | 17 | Two Firestore databases, Cloud Run split from Functions, OSM, HostPinnacle |
| Outbound APIs | 6 | SmartPOS external API, webhooks, ERP, gateway, registry |

### HostPinnacle is the DNS provider, not Cloudflare

`docs/DNS-RECORDS.md` is authoritative and names **HostPinnacle**. Cloudflare
appears nowhere in it. Every Cloudflare reference in this repository is
`cdnjs.cloudflare.com` — a **public asset CDN** serving Font Awesome. SOKONI has
no Cloudflare account, no zone and no control plane there.

The catalogue previously credited Cloudflare with *"DNS for the production domain
and the edge in front of it."* That was wrong, and it mattered: an operator
chasing a resolution or mail fault would have gone to a panel SOKONI does not
own. `D9` now fails if Cloudflare is re-credited with DNS.

HostPinnacle appears twice, deliberately — `hostpinnacle-dns` for the domain and
`hostpinnacle-mail` for the mailboxes. They fail independently.

### Maps are a free public dependency on a delivery-critical path

`osm-tiles` and `osm-nominatim`. 11 pages load Leaflet, 8 fetch tiles from
`tile.openstreetmap.org`; geocoding goes to `nominatim.openstreetmap.org`. Both
are CSP allow-listed, and a CSP change that drops them blanks every map on the
platform.

The library is **self-hosted**; only tiles and geocoding are third-party. Neither
has a contract or an SLA, and both publish rate-limit policies. **It is not
Google Maps** — nothing calls `maps.googleapis.com`.

### Sign-in OTP is sent by Google, not Africa's Talking

`phone-auth` uses Firebase Phone Auth. The Africa's Talking rail carries platform
SMS and does **not** carry sign-in codes; the two bill and fail independently.
Diagnosing a login-OTP failure on the Africa's Talking rail is looking at the
wrong vendor.

`recaptcha` is the App Check provider **and** the phone-OTP verifier, so one
outage degrades both at once.

### Deliberately absent

| | Why |
| --- | --- |
| Stripe | A commented-out `registerAdapter` line. Not an integration. |
| PayPal | Checkout UI and a string in a payout allow-list. No rail. |
| Daraja | Certification fails if it reappears, with a positive control. |

> ⚠️ **Open defect.** `checkout.html` offers PayPal as a payment method with no
> backend behind it. Either remove the option or build the rail — a method a
> customer can select and that cannot complete is a defect. Tracked here because
> the census found it; fixing it is a checkout change, not a catalogue one.

## Two Firestore databases

`firebase.json` declares **two** Firestore databases, with separate rules and
separate indexes. The catalogue carries one entry for each, and they must stay
distinct — a single "Cloud Firestore" row tells an operator the platform has one
database, and hides that a deploy naming one does not carry the other.

| Entry | Database | Rules | Indexes *declared* | Status |
| --- | --- | --- | --- | --- |
| `firestore` | `(default)` | `firestore.rules` | 414 | `live` |
| `firestore-sokoni-ops` | `sokoni-ops` | `firestore.rules.sokoni-ops` | 54 | `configured` |

Those counts are **declarations in this repository**, not deployed state. How
many are actually BUILT, how many are `READY`, how many collections exist, which
region each database is in and whether its rules are the deployed ones are all
Firestore **Admin API** facts. Nothing deployed exposes them, and no client can
obtain them — so the console shows an em dash rather than a number it did not
measure. A deployed-index figure quoted anywhere did not come from here.

`sokoni-ops` is **`configured`, not `live`**, deliberately. No runtime module
opens a Firestore client bound to that database id — its rules and indexes are
declared and deployable, but nothing is known to read or write it in production.
**Do not promote it on the strength of the declaration.** Promote it when a
reader exists and has been observed.

Certification case `D6` locks all of this, including a positive control proving
a genuinely live rail still reports `live`.

## Observed activity

Most rails expose no health endpoint, so the catalogue refuses to guess. That
leaves a real question: *is anything actually happening on this rail?*

Each entry declares the collections it writes. Those are canonical Firestore
collections an admin can read, so for the integration an operator **opens**, the
console measures per declared collection: how many documents a bounded read
returned, and when the most recent one was written.

### It is not a health verdict

A collection has many writers — `orders` is written by checkout, by POS and by
admin tooling. Activity is evidence **about the collection**, not proof the rail
produced it, and never a health verdict for the rail. The panel says so in the
rendered output, and `D7` fails if that wording is removed.

### The bound is disclosed

Reads are capped at **50 documents per collection** and at **6 collections per
integration**. A collection at the cap renders as **"at least 50"**, never a bare
`50` — the true total is not known and must not be read as if it were. Opening a
card therefore has a known ceiling instead of an open-ended cost.

### It runs on demand

Nothing is measured at load. Measurement starts when a card is selected, so cost
is proportional to what is being looked at, not to the size of the catalogue.

### Database probe

An entry carrying a `database` block is probed for reachability. The compat layer
this console runs on is bound to the default database, so a named database is
reached through the modular SDK; the handle is injectable at mount for tests.

| Outcome | Means |
| --- | --- |
| `Reachable` | A bounded read **returned**. An empty result is a *successful* read. Not the same as in use, and **not** proof the database is empty. |
| `Permission denied` | The database answered and refused. A rules outcome, not an outage. |
| `Unreachable` | The read did not complete. The state is **UNKNOWN** — not a finding that anything is wrong. |
| `Not attempted` | No read was made. Nothing is known. |

`D8` proves the three observed outcomes render differently; a probe reporting one
state for all three would otherwise pass every individual check.

## Navigation reality

AdminOS has **no router**. `SokoniAOS.navigate()` shows and hides panels, and the
only URL handling is a **boot-only, one-way** hash deep link validated by
`/^[a-z]+$/` — letters only. The hash is never written on navigation, and there
is no `hashchange` or `popstate` listener.

So `admin-os.html#integrations` opens this panel on first load, and that is the
full extent of it. **Sub-routes such as `#integrations/database/default` do not
work** — they fail the validator and fall back to the dashboard silently. Drill
-down is in-panel, through the detail aside, which is why it is built that way
rather than as a route. Adding nested URLs means building a router for all 26
sections, with its own certification.

### Staleness

`STALE_MS = 300000` mirrors the threshold in `platformGetHealth`
(`functions/platform-registry.js`). **If the server's threshold moves, move this
one in the same commit**, or the console and the API will disagree about the same
service.

## Security

- **Read-only by construction.** No `set`, `update`, `delete`, `add` or
  `httpsCallable` anywhere in the module; certification asserts this on stripped
  source against a positive control. Deregistering a service or rotating a
  webhook secret belongs behind an audited callable with a confirm gate.
- **Secrets never reach the DOM.** `posWebhooks` documents carry a signing
  `secret` an admin *can* read. The console renders an allow-list of fields that
  deliberately excludes it, so a field added to that collection later cannot leak
  by default. The Credentials tab lists secret **names** only.
- **Every rendered field is escaped.** A hostile registry document cannot inject
  markup; certification plants one and checks the output.

## Payment rails

Collections run through **IntaSend only**. Direct Daraja and direct M-Pesa rails
are not catalogued, and certification fails if one reappears — paired with a
positive control asserting the IntaSend rails *are* present, so "no Daraja" is a
real finding rather than an empty catalogue.

> ⚠️ This is the **catalogue's** position. Daraja and C2B receiver code still
> exists and is still deployed in `functions/`. Removing it is a separate,
> money-critical change that is blocked by the deploy freeze and needs an
> explicit owner decision — see [[Payments]].

## Certification

```
node tests/certify-integrations-console.js        # 796 assertions, 0 failures
node tests/sabotage-integrations-console.js       # 8 mutations, 8 caught, 0 inert
node scripts/test-integration-registry-parity.js  # 26 passed
node scripts/test-integration-status.js           # 45 passed
node scripts/test-integration-probes.js           # 85 passed
node scripts/test-integrations-console.js         # 67 passed
node scripts/validate-admin-nav.js                # all checks passed
node scripts/integration-relationship-census.js   # 47 rows, gate passes
```

The suite runs the real module against a minimal DOM and a scripted Firestore,
then asserts on what it actually rendered — nothing is asserted by grepping
source, because such a check can pass on a comment describing the behaviour.

Every absence assertion is paired with a positive control in the same render. A
control that fails turns its partner into a FAIL, not a pass. The harness fails
closed: a throw is a failure, a case registering zero assertions is a failure,
and a run shorter than `MIN_ASSERTIONS` is a failure.

## Extending the catalogue

Add an entry to `INTEGRATIONS` with `evidence` filled in, and add its id to the
`D4` list in the certification suite. `status` must come from the closed
vocabulary: `live`, `inbound-only`, `sandbox`, `configured`, `quarantined`,
`retired`, `frozen`.

**Mirror it in `functions/integration-registry.js` in the same commit.**
`scripts/test-integration-registry-parity.js` requires the catalogue and the
server registry to agree on id, category, status, vendor and required secrets. A
catalogue-only addition fails parity, which is the contract working.

**Never add a number to a catalogue entry.** `D3` fails the build if you do —
and never pin a suite to a literal entry count. Derive it from the registry, or
the next legitimate addition breaks a test that was not testing anything.

### Deployment state

**This console is not in production.** Live hosting `d592d8f` carries no
integrations panel and no catalogue script, and `adminGetIntegrationStatus`
exists only on `feat/integrations-control-center` — the deployed
`adminOsDispatch` answers `not-found`, so every card would render **Unreadable**.

The Firestore-backed parts (registry, health, dependencies, webhooks, observed
activity, database probe) need no Cloud Function and would work as soon as the
page ships. The *status* row — credential state, provider health, stage proof —
needs a functions deploy against the `multishop-checkout-certified` lineage,
which is a separate, gated decision.
