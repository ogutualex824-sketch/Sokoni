# Provider Registry

The architecture of service-provider discovery on SOKONI.

Related: [[Marketplace]] · [[Authentication]] · [[Orders]] · [[PLATFORM_CONSTITUTION]] · [[RELEASE_ACCEPTANCE]]

---

## The one rule

**`providers` is the canonical service-provider registry.** One document per
account, keyed by Firebase Auth uid. Every provider-facing surface reads it, and
reads it through `sokoni-providers.js`.

If you are adding a page that lists or shows providers, you do not write a
Firestore query. You call `SokoniProviders`.

```js
const { providers, error } = await SokoniProviders.list({ category: 'laundry' });
const { provider, error }  = await SokoniProviders.get(uid);
```

---

## Why uid keying is not negotiable

Duplicate listings were the defining failure of the old directory. Three
separate writers minted their own ids:

- `SokoniDB.saveProvider` keyed by **phone digits** — change your number, get a
  second listing
- `provider-wiring.js` keyed by **`hub_uid_nameOrPhone`** on a 500ms timer
- `provider.html` keyed by **`PRV<timestamp>`**

An account could hold four listings simultaneously, each with different data,
each looking equally real to a customer.

Keying by uid makes every write idempotent. A re-registration updates the one
record that account owns; it cannot create a second. `firestore.rules` enforces
the other half — `request.resource.data.uid == request.auth.uid` on create — so
a client cannot write into someone else's document.

---

## Reading

### The status guard is a rules requirement, not an optimisation

```js
where('status', 'in', ['active', 'approved'])
```

`firestore.rules` gates provider reads on `status`. Firestore **denies** a list
query it cannot prove is safe — it does not return a filtered subset. Drop this
clause and the read fails outright. Keep it in sync with:

- `firestore.rules` → `match /providers/{providerId}`
- `sokoni-firestore-search.js` → `SPECS` entry for `providers`
- `sokoni-providers.js` → `VISIBLE_STATUS`

### A failed read is not an empty registry

`list()` returns `{ providers, error }` rather than throwing, because callers
must render these two differently:

| | Message |
|---|---|
| `error` set | "Could not load providers — connection problem, retry" |
| `error` null, empty | "No providers in this category yet" |

Use `SokoniProviders.emptyStateHtml(error, categoryLabel)` and this is handled.

**This is not a theoretical distinction.** Firestore's `getDocs` does not reject
when the backend is unreachable — it serves the local persistence cache and
resolves normally. On a cold page that cache is empty, so a blocked read arrives
as a successful snapshot of zero documents. Rendered naively it becomes *"No
providers yet"*: an outage disguised as an empty marketplace. The module
separates them with `snap.metadata.fromCache && snap.size === 0`.

Reads also carry an **8-second ceiling**. `getDoc` can hang indefinitely while
the SDK retries a backend it will never reach, which leaves a page on its
loading skeleton forever — worse than an error, because the visitor cannot tell
whether to wait or reload.

### There is no demo fallback

If the read fails, `list()` returns zero providers and an error. It never
substitutes invented listings. Restoring a fallback would reintroduce the defect
this module was built to remove.

---

## Writing

Three sanctioned paths. Nothing else writes `providers`.

| Path | Writes | Status |
|---|---|---|
| `scripts/onboard-providers.js` | admin backfill of existing accounts | `active` |
| `providerPublish` (CF) | the subscription-gated onboarding flow | `active` |
| `SokoniDB.saveProvider` | client self-registration | `pending` |

A client may only create a record in the **pending** state. `noAdminFields()`
covers `verified`, `featured` and `approved` but **not** `status`, so the create
rule carries its own clause — without it any signed-in user could self-publish
as `active` and appear in global search, bypassing application review.

`provider-wiring.js` no longer writes this collection. Its `_writeProvider` now
only feeds the hub-specific `lawyers` and `mechanics` registries.

### Never invent

Absent fields stay absent. In particular:

- **No rating on an unrated provider.** Cards render "New on SOKONI". Writing
  `rating: 5.0` on a new account (as `registerProvider` did) is a fabricated
  endorsement; rendering `p.rating || 5` (as `services.html` did) fabricates one
  at display time.
- **No invented counters.** `jobsCompleted`, `reviewCount` start at 0 and are
  server-owned.
- **No user-owned data.** Photo, KYC, exact address, GPS, bio, pricing, working
  hours, service radius belong to the provider. Onboarding lists them in
  `profilePending` so the UI can prompt; it does not fill them in.

---

## `providers` vs `providerProfiles`

They are not rival registries and neither is redundant:

- **`providerProfiles/{uid}`** — the private working record. Draft state, plan,
  subscription, coverage, pricing config, QR. Read by the provider's own
  dashboard.
- **`providers/{uid}`** — the public listing. What customers see.

`providerPublish` is the one place that projects the first onto the second.
Until 2026-07-24 it wrote only `providerProfiles`, so a provider who completed
the entire flow — subscription, legal agreement, custom auth claim — was
invisible to every customer-facing surface.

---

## Surfaces

| Surface | Reads via | Notes |
|---|---|---|
| `index.html` | `SokoniProviders.list({ featuredOnly, limit })` | hides itself when empty or on error |
| `providers.html` | `SokoniProviders.list()` | broad buckets → slugs via `BUCKETS` |
| `services.html` | `SokoniProviders.list()` | category tabs |
| `cleaning.html` | `SokoniProviders.list({ category:'cleaning' })` | chips match skills, not a hand-kept `type` array |
| `provider-profile.html` | `SokoniProviders.get(uid)` | the public profile |
| `search.html` | `sokoni-firestore-search.js` | own adapter, same guard |

### Category buckets

Pages ask for a bucket; the registry stores fine-grained slugs. `cleaning`
expands to `cleaning + laundry + housekeeping`, so a mamafua filed under
`laundry` reaches the Cleaning hub **without a duplicate record**. Aliases live
in `CATEGORY_ALIASES` in `sokoni-providers.js`.

Anything unmapped still reaches the "all" view — a provider in a new category is
never invisible, only unfiltered.

### The public profile is `provider-profile.html?uid=`

Not `provider.html`. `provider.html` is the provider's **own dashboard**; it
reads `?tab=` and `?cat=` and ignores any id. Linking a search result there
opens the setup wizard.

There is no `/provider/**` hosting rewrite. `firebase.json` rewrites `/shop`,
`/@`, `/card` and `/pay` only — a link to `/provider/{id}` is a 404.

---

## Onboarded accounts

Real providers listed by uid-keyed script (never fabricated; `verified:false`
until KYC; ratings/counters start at 0). Each is idempotent — re-running updates
the one record, never duplicates.

| Provider | Owner | Category | Sign-in | Script |
| --- | --- | --- | --- | --- |
| Shave 'n' Trims | Pacifique | hair-beauty (Barber Shop) | phone OTP `+254742544979` | `onboard-barber.js` |

Search is verified over REST after each apply — `searchableTerms array-contains`
each expected term (e.g. shave / trims / barber / owner name) must return the
record with `status:'active'` and `searchable:true`.

## Verification

```bash
node scripts/audit-provider-onboarding.js      # read-only; no --apply exists
node scripts/onboard-providers.js              # dry run
node scripts/onboard-providers.js --apply
node scripts/probe-provider-directory.js       # real Chromium, both passes
node scripts/check-inline-js.js                # inline <script> syntax gate
```

**App Check refuses browser reads from `localhost`.** The probe therefore runs
two passes: a live pass that can only prove no demo data survives and that a
blocked read is reported honestly, and an injected pass that supplies real
records client-side to exercise the render path. Read-path correctness is
evidenced separately over REST by the audit script.

A green probe is **not** evidence of production correctness. That needs a page
loaded against a reachable Firestore from an App Check-registered origin.

---

## Known limitations

- **Client-side category filtering.** One bounded query (200 docs) is fetched
  and filtered in the browser. Fine at current volume; past a few hundred
  providers this needs `array-contains` on `categories` plus an index.
- **`nearby providers` is unimplemented.** No provider record carries
  coordinates, and nothing writes them. Requires a geohash field and query.
- **The rules fix is not deployed.** Edited in `firestore.rules`; run
  `firebase deploy --only firestore:rules`.
