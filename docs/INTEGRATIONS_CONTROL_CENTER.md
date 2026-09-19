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
node tests/certify-integrations-console.js      # 560 assertions, 0 failures
node tests/sabotage-integrations-console.js     # 8 mutations, 8 caught, 0 inert
node scripts/validate-admin-nav.js              # all checks passed
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

**Never add a number to a catalogue entry.** `D3` fails the build if you do.
