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

Seven tabs:

1. **Catalogue** — every integration SOKONI has, grouped by category, with a live
   signal overlaid where one exists.
2. **Google Cloud** — the composed infrastructure control plane. See below.
3. **Registered** — `platformServices`, with health derived from `platformHealth`.
4. **Capabilities** — which services declare which platform capability, and which
   declared capabilities are not in the well-known list.
5. **Dependencies** — `platformDependencies` edges, flagging targets that are not
   in the registry.
6. **Webhooks** — `posWebhooks`: merchant endpoints, failure counts, last delivery.
7. **Credentials** — every secret **name** the catalogue declares and which rails
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

### The observed-state chip

Beside each catalogue entry's DECLARED lifecycle sits what the evidence actually
shows. Derived at render time — **no persisted field, no second evidence-state
system**. Precedence is first-match and the order is the control:

```
 1 EVIDENCE UNREADABLE   2 FAILED    3 DEGRADED   4 STALE      5 LIVE
 6 GATED                 7 NOT CONFIGURED         8 REFUSED BY DESIGN
 9 ACTIVE               10 NOT PROBED
```

**STALE ranks above LIVE** so an aged observation cannot keep a green chip.
**GATED ranks below the measured states** because a failure on a frozen rail is
still the more urgent fact. Each chip carries *why* it was derived as its title.

The four distinctions that justify the chip — and that `F2` proves on real
cards, not in a lookup table:

| Not the same as | Because |
| --- | --- |
| NOT PROBED ≠ ACTIVE | one has an evidence source, the other has none |
| REFUSED BY DESIGN ≠ NOT PROBED | refusing is correct behaviour, not a gap |
| NOT CONFIGURED ≠ FAILED | nothing was attempted; it is a config fact |
| STALE ≠ LIVE | an old success is not a current one |

> **REFUSED BY DESIGN cannot fire in production yet.** `notRunReason` is set on
> a probe result and is not carried on the status record, so a rail that refuses
> by design is indistinguishable from one with no executor. The branch is
> implemented and certified; those rails render NOT PROBED until the status
> resolver carries that field. Deriving it from `capabilities` would be a guess —
> the absence of `test` conflates four separate reasons.

**No owner field, and no entry-level "last known good".** Ownership is a
governance decision the census cannot infer; freshness stays per-observation
rather than being manufactured at entry level.

### Unknown is not zero

A read that **fails** renders an em dash and names the unavailable source. A read
that **succeeds** and returns nothing renders a real, canonical `0` and says so.
Those two states look different on purpose. A service with no `platformHealth`
document is `No heartbeat` — never `Healthy`.

Certification enforces this on both code paths: the KPI tiles **and** the tab
pill counts. Pre-flight sabotage found the pills uncovered on the first pass; the
gap is now closed and proven.

## The Google Cloud control plane

A tab that composes the GCP entries the catalogue already addresses
individually, so the infrastructure reads as one estate without the individual
rows losing their identity. Each figure links **into** the entry that owns it.

Fed by `functions/gcp-evidence.js` through the read-only op
`adminGetGcpEvidence` on the existing dispatcher. **No new collection** — this
is a read, and nothing persists a health record.

### Every field is an observation

```
{ value, state, source, observedAt, reason }
```

| State | Means | Renders |
| --- | --- | --- |
| `observed` | read succeeded, value is real | the value |
| `empty` | read succeeded, found nothing | a **measured** `0` |
| `unreadable` | read failed | `—` + the error |
| `not-attempted` | nothing looked | `—` + why |
| `not-applicable` | question does not apply | `—` |
| `stale` | observed, past the freshness window | the value, badged stale |

`STALE_MS` mirrors the console threshold. If one moves, move both.

### The measured zero

`sokoni-ops` genuinely has no root collections. A **server** can establish that
via `documents:listCollectionIds`; a client cannot enumerate collections at all.
So the panel renders a real `0`, badges it *Measured zero*, and says in the
output that the server enumerated and found none.

This supersedes the earlier position that the figure could not be shown — that
was correct for a browser and is wrong for a server. A measured zero and an
unmeasured one must remain visibly different; `D11` fails if they stop being.

### Read-only, and it binds no secret

Application Default Credentials, scoped `cloud-platform.read-only`, so the
credential cannot mutate anything even if a code path tried. The live
composite-index quota is read from the quota API and **never hardcoded** — a
hardcoded `200` was wrong here for months and drove index deletions that were
never needed.

### Four sections, thirteen control planes

```
COMPUTE        Cloud Functions · Cloud Run · Artifact Registry · image provenance
DATA           Firestore, both databases · indexes · quota · Cloud Storage
OBSERVABILITY  Monitoring · telemetry · Billing · budgets
SECURITY       IAM · admins · service accounts · App Check · Audit · Secrets
```

Each domain observes **independently** — a dead API degrades its own fields and
leaves its neighbours intact. When one is out the header says *"Part of this
cockpit is dark"*, because a dark instrument must never read as a healthy one.

**Region coverage is derived from what was observed running**, not from a
configured list. A region nothing runs in is not coverage.

Three panels exist to surface failures this platform has actually hit:

| Signal | Why it matters |
| --- | --- |
| Created revision ≠ ready revision | A revision failed to come up; the old one keeps serving, so it is silent. |
| Repositories enforcing a cleanup policy | A policy is enforcing unless its dry-run flag is set — and that flag **disables deletion**, it does not preview it. |
| Audit log types enabled | An **absent** audit config means Admin Activity only, not "everything". |

No risk score is computed anywhere. A score is an opinion wearing the authority
of a measurement.

### Drill-downs

Six evidence tables, opened in-panel (there is no router — see Navigation
reality). Each figure in the summary links to the catalogue entry that owns it;
each **Open** chip opens the table.

| Table | Shows |
| --- | --- |
| Functions inventory | function → Cloud Run service → revision, runtime, memory, timeout, min/max, service account |
| Cloud Run services | revision parity, scaling, concurrency, CPU, memory, **image digest**, service account, traffic |
| Artifacts & provenance | every cleanup policy with its **action and condition**; repositories with DELETE and no KEEP; the revision → digest → registry join |
| Administrators | who can change the project, as real IAM bindings; humans separated from service accounts |
| Audit logging | per-service coverage + a recent Admin Activity timeline |
| Storage · Enabled APIs | bucket posture; which APIs are on |
| Monitoring & telemetry | real metric series over a **stated 24h window** — Run requests/5xx/peak instances, function executions/errors, Firestore reads/writes/deletes |
| Billing & cost control | budgets, and the **conditions** that drive spend: pinned minimums, unbounded maximums, very high ceilings |
| Service accounts | a JOIN — who **holds roles** vs what **runs as** them |
| App Check | enforcement mode per service |
| Scaling contract | source vs **serving** min/max, the GCF layer's disagreement carried alongside, and the owner verdict |
| Secret Manager | names, rotation, expiry — and which API is used, and why it cannot return a value |
| Databases | both databases, indexes, READY, root collections, drift, live quota |

### Entity cards

A row in the Functions or Service-accounts table opens that entity's own card.

**Function card** — source contract, serving state, and the checks between them.
An unset limit renders as `— unset`, never `0`. A function with no supplied
contract shows that **nothing was checked** — it does not get a tick, because
"not checked" and "passed" are different claims. The 30-day peak is an em dash:
borrowing the estate-wide figure would put another function's number under this
one's name.

**Service-account card** — roles held, and what actually runs as the identity.
Three distinct states: runs these workloads · runs **nothing** (known) · usage
**unknown** (a workload inventory failed — not the same as nothing).

Table cells are escaped without exception. The entity links use a narrow opt-in:
a column may return `{ html }`, an object **shape** rather than a flag, so a
hostile string from a read can never satisfy it.

Plus two panels on the cockpit itself:

**The relationship graph.** An inline SVG whose every node carries the figure
actually read. A node whose reading failed is **dimmed with an em dash, not
removed** — an absent box would say "no such thing" when the truth is "not
measured". Selecting a node opens its evidence.

**Recent activity.** Admin Activity events with outcome, and a count of those
that *failed*. Data Access entries are not read: they can carry request
payloads, and a timeline is not worth leaking a request body for.

### Telemetry carries its window

A number with no window attached is not a measurement, so the 24h window travels
with the reading and appears in its `source`. A series with no points is a
**measured zero over that window** — genuinely quiet — which is badged
differently from a failed read. **Open incidents is `not-attempted`**, because
the incidents API is not on the REST surface this reader uses.

### Cost shows conditions, never verdicts

A pinned minimum bills while idle; an unbounded maximum has no ceiling. Whether
either is *correct* depends on the service, and this reader does not know which.
It names the services and stops. No score is computed.

### Source contract vs serving state

What a function **declares** against what is **actually serving**. The source
side cannot be read from a deployed function — `firebase deploy --only
functions` uploads `functions/` and nothing else — so the handler supplies it
from the recorded adjudication, with the same `try/catch` as the declared index
counts. Absent in production means **not-attempted**.

**Parity is computed against the SERVING revision, deliberately.** The GCF layer
reports `minInstanceCount=undefined` for functions whose source *and* serving
revision both say 1 — it is the representation that agrees with neither. That is
an observability discrepancy, not evidence, so the GCF value is carried
**alongside** rather than quietly resolved, and the disagreement is counted.

> **Silence is not parity.** A function with no supplied contract is not "in
> parity" — nothing was compared for it. Those are counted separately, never
> folded into the agreeing ones. A blank min or max is **unset**, not zero.

### Declared vs provisioned secrets

The Credentials tab knows what each rail **declares**. Secret Manager knows what
**exists**. The join answers what neither can alone: a declared secret that does
not exist is a rail that will **fail when it runs**, and it is named rather than
counted.

The other direction is reported separately and is **not a fault** — a
provisioned secret nobody declares may belong to a system outside this registry,
so it is listed for deliberate reconciliation, never flagged for deletion.

Declared names are de-duplicated. Without a declared list the figure is
`not-attempted`, never "0 missing" — a zero there would read as "everything is
provisioned".

### Service-account ownership

An identity holding roles that nothing runs as is **access with no owner** — a
condition, not a score, and the reader admits it may be used by something outside
Cloud Run and Functions. Where a workload inventory could not be read the column
is an em dash, **never "no"**: "nothing runs as this" would then be a claim about
a failed read.

**The provenance join.** A serving image whose digest is not in the registry is
the condition that leaves a service unable to create a new revision from its
existing spec — the old revision keeps serving, so nothing looks wrong until a
deploy is attempted. Affected services are **named**, not counted.

**The source contract is not shown, on purpose.** What a function declares in
the repository and what it is serving are different things, and only the serving
side is an API fact. The column is null rather than absent so the gap is visible.

**No risk score anywhere.** A score is an opinion wearing the authority of a
measurement. Bindings, policies and conditions are shown; the operator draws the
conclusion. `D14d` asserts this **both ways** — the position must be stated, and
no score may appear anywhere — because a sabotage that *adds* a score beside the
refusal passes a check that only looks for the refusal's wording.

**Inventories are capped at 250 and say so**, with the real total beside them. A
truncated list must never read as a complete one.

### Access management — the one write surface

Grant a SOKONI role and a Google Cloud role from the page, instead of opening
the Google Cloud console.

It lives in **`sokoni-gcp-admin.js`, a separate file**. `sokoni-integrations.js`
is certified to contain no write path (`E4`, proven by `S8`), and that guarantee
is worth more than one fewer script tag. The console only emits a mount point.

**The SOKONI half reuses `setUserRole`**, the existing canonical role authority —
already superAdmin-gated, rate-limited and audited. There is deliberately **no
second way to mint an admin**; `A9` fails if this module stops using it.

**The GCP half** goes through `functions/gcp-iam-grant.js`, the only module in
the repository that writes IAM.

| Refusal | Why |
| --- | --- |
| Deny by default | A role must be on the allowlist. Unknown is refused, not passed through. |
| Owner / Editor / IAM-admin forbidden **twice** | Their holder could grant themselves anything else. Checked against a separate list, so a careless edit to the allowlist still cannot escalate. |
| No self-grant | An operator who can widen their own access has no ceiling. The actor's email comes from the **verified token**, never the request body. |
| Etag mandatory | `setIamPolicy` without it can overwrite a concurrent change — in the worst case removing every other binding. |
| Audit configs carried through | `setIamPolicy` replaces the **whole** policy; dropping them would disable audit logging as a side effect of adding a viewer. |
| Revocation exists | A grant path with no revoke path is a trap. Revoking an admin role is still refused — it can lock everyone out. |

`allUsers` fails the member pattern and can never be written.

**In the browser:** a typed confirmation naming the member, re-checked at commit
rather than only disabling a button. Editing the member discards a staged
confirmation, so one cannot be carried onto a different person. A non-superAdmin
gets no form — and is told the server would refuse regardless, because hiding a
button has never stopped anybody.

> **The two systems are separate.** Removing someone as a SOKONI admin does
> **not** remove their Google Cloud IAM binding. They still have the
> infrastructure. Every confirmation says which one it is changing.

Neither callable is deployed. The grant path also needs a service account with
`resourcemanager.projects.setIamPolicy`, which the read-only evidence identity
deliberately does not have.

### What it does NOT cover

`cost-breakdown · budget-alerts · per-function-telemetry · open-incidents ·
data-access-log-entries · cloudflare`. Named in `notCovered` and shown in the
panel, so their absence is visible rather than mistaken for health. There is no
infrastructure relationship graph.

Data Access log entries are excluded **deliberately**: those entries can carry
request payloads, and a timeline is not worth leaking a request body for.

### Until it is deployed

Writing the reader is authorized; deploying it is a separate decision. Until
then the panel renders *"No infrastructure figure is shown, because none was
obtained"* — no counts, no `Observed` badge, no `Measured zero` badge. `D12`
fails if any appear. Every GCP service stays individually addressable.

## Running the sabotage suites safely

A sabotage suite **edits real source in place** and restores it. That makes it
destructive if mishandled, and on 2026-09-21 it was: two runs started
concurrently, their restores interleaved, and **four defects were left live** in
`sokoni-integrations.js` — including `_count()` returning a fabricated `0`.

```
NEVER run two sabotage suites at once
NEVER run one in a polling loop
NEVER kill one mid-flight — the mutation is stranded and the next run adopts it
ALWAYS run scripts/check-stranded-mutations.js before trusting a result
```

`check-stranded-mutations.js` reads every manifest and asserts each original
anchor is present. An absent original means a stranded defect **or** a drifted
anchor whose vector has silently gone inert.

**It is not sufficient on its own.** It checks the anchor exists *somewhere* in
the file, not in the right place — a restoration applied to the wrong panel
passed the scan and was caught only by certification. Run both.

A **degraded** vector (`~`) is one whose named guard did not fire. It proves
nothing about that guard and now fails the run; until 2026-09-21 it was counted
as a clean catch and never reported.

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
node tests/certify-integrations-console.js        # 1031 assertions, 0 failures
node scripts/check-stranded-mutations.js          # 65 vectors, 0 problems — RUN FIRST
node tests/sabotage-integrations-console.js       # 41 caught, 0 inert, 0 degraded
node scripts/test-gcp-evidence.js                 # 202 passed
node tests/sabotage-gcp-evidence.js               # 5 mutations, 5 caught, 0 inert
node scripts/test-integration-registry-parity.js  # 26 passed
node scripts/test-integration-status.js           # 45 passed
node scripts/test-integration-probes.js           # 85 passed
node scripts/test-integrations-console.js         # 67 passed
node scripts/validate-admin-nav.js                # all checks passed
node scripts/integration-relationship-census.js   # 47 rows, gate passes
node scripts/test-gcp-iam-grant.js                # 71 passed
node tests/sabotage-gcp-iam-grant.js              # 10 mutations, 10 caught, 0 inert
node tests/certify-gcp-admin-console.js           # 49 passed
node tests/sabotage-gcp-admin-console.js          # 9 mutations, 9 caught, 0 inert
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
