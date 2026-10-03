# Rate Card Editor — the ONE generic provider rate-card editor

**Status:** built, tested, **NOT deployed** (hosting only). 2026-10-03.
**Module:** `sokoni-merchant-ratecard.js` → `window.SokoniMerchantRateCard`
**Tests:** `scripts/test-merchant-ratecard.js` (VM; the REAL live server handlers; no browser)
**Related:** [[MERCHANT_V2_TARGET_ARCHITECTURE]] (session model, `S.editable`), [[Payments]], [[Marketplace]]

---

## 1. What it is

One editor for a service provider's own rate cards (`providerServices/{id}`), mountable anywhere:

| Mount | Owner | ctx.filter |
|---|---|---|
| merchant-v2 `#rates` (route `rates`, group **Services**) | this branch (`hosting/provider-session-on-e81d80a`) | `{}` (all of the provider's services) |
| merchant-v2 `mkt-rates` | **sokoni-b2** (Marketing services module) | `{ categories: <answer.marketingCategories> }` |

`ent-rate-cards.js` (sokoni-2f) is a **separate entertainment system** with its own storage. This editor
does **not** read or write it, and it must not be pointed at it.

## 2. Server contract (census — byte-identical in the LIVE providerDispatch archive)

Verified against `C:/temp/pd-live/src/provider-ops.js` (sha256 `4cc1c0ae880b9cdd…`), byte-identical to
this tree's `functions/provider-ops.js`; `service-pricing.js` likewise (`86643cc5…`). All ops go through
the ONE callable `providerDispatch({ op, ...data })`, every op is in its live `ROUTES`, every op requires
auth, and every write is **owner-only** (`providerServices.providerId === auth.uid`, checked server-side).

| op | input | output | semantics |
|---|---|---|---|
| `providerListServices` | `{}` | `{ services: [{id, ...doc}] }` | `where providerId == uid`, limit 100 |
| `providerAddService` | `{name, category, subcategory?, description?, priceType?, price, fee?, deposit?, images?, durationMins}` | `{success, serviceId, remaining}` | enforces plan `limits.listings` (refusal text verbatim) |
| `providerUpdateService` | `{serviceId, name?, category?, subcategory?, description?, priceType?, price?, fee?, deposit?, images?, durationMins?, active?}` | `{success}` | patches ONLY the fields sent |
| `providerToggleService` | `{serviceId, active?}` | `{success, active}` | refuses a deleted (`removedAt`) service |
| `providerUpdateServicePricing` | `{serviceId, pricing}` | `{success, pricing: <sanitised>}` | **REPLACES** the whole `pricing` field (not a merge) |
| `bookingPreviewPrice` | `{pricing}` (draft) or `{serviceId}` (saved), `selection`, `ctx` | `computePrice` result | the SAME engine as checkout |

### 2.1 `pricing` (all money integer **cents**) — `_sanitizePricing`

| field | shape | server rule |
|---|---|---|
| `currency` | string | `_san(…, 8) \|\| 'KES'` |
| `basePrice`, `extraHourRate` | cents | `_cents` (≥0, rounded) |
| `durationMins` | int | ≥0, rounded |
| `holidays` | `['YYYY-MM-DD']` | ≤60, each `_san(…,10)` |
| `weekendRate`, `holidayRate`, `peakRate`, `offPeakDiscount` | `{type:'pct'\|'flat', value, hours?:[HH:MM,HH:MM]}` | dropped unless type valid and `value > 0`; flat → cents; pct unbounded ≥0 |
| `deposit` | `{mode:'fixed'\|'pct'\|'full', value?, balanceDue?:'before'\|'completion'}` | fixed → cents; pct clamped 0–100; full has no value |
| `travel` | `{fee, perKm, freeRadiusKm, maxKm?}` | dropped when fee, perKm and freeRadiusKm are all 0; fee/perKm cents |
| `packages` | ≤40 `{id, name, price, durationMins, description, deposit?, includes?[≤30], extras?[≤30 add-on ids]}` | nameless dropped; missing id → `pkg_<index>` |
| `addOns` | ≤60 `{id, name, price, qtyMax, available, description}` | nameless dropped; missing id → `addon_<index>` |

`_san` strips `<` and `>`; text caps: package name 120 / description 500, add-on name 120 / description 300.

## 3. Editor rules

1. **Full-object replace.** The save payload is `pricingPayload(draft)`: a clone of the COMPLETE object
   that was loaded, plus the edits. Never a diff. (The only scaffolding removed: rate `hours` left blank
   on both ends.) On success the server's returned, sanitised `pricing` becomes the new baseline.
2. **Cents.** The provider types KES; `kesToCents` converts by string arithmetic (no float multiply) and
   refuses fractions of a cent (`1500.505`), negatives and junk. Inputs show `centsToKesInput`.
3. **No browser price math.** The preview calls `bookingPreviewPrice` with the draft; the UI only formats
   the server's cents (`fmtKes`). It shows the engine's total and deposit and when the balance is due.
4. **Server is the authority.** Client checks mirror `_sanitizePricing` as UX pre-checks only (and block
   cases the server would *silently* drop: a rate with value 0, a nameless package/add-on, a deposit
   percentage above 100). Any server refusal is shown **verbatim** (escaped).
5. **Bookings are never touched.** Prices are snapshotted on the booking at creation (server side). The
   editor says: *"Changes apply to new bookings only; existing bookings keep their price."*
6. **Read-only rule (P0-F).** Editable only when `ctx.editable === true` **and** `ctx.readOnly !== true`.
   Anything else — missing, `false`, `'true'`, `1` — is read-only: every edit control is disabled, the
   reason is shown, and every write path re-checks the rule (a re-enabled control still cannot send).
   Previews are reads and stay available.
7. **Basic fields** (name, description, price, fee, deposit, duration) save through `providerUpdateService`
   with only the changed fields; Pause/Resume through `providerToggleService`; Add through
   `providerAddService` (category = the filter's single category, or chosen from the filter's list).

## 4. ctx

```js
SokoniMerchantRateCard.mount(el, {
  callable,   // REQUIRED. (name) => (payload) => Promise<{data}|result> — the shell's _callable
  uid,        // REQUIRED. signed-in uid; absent → "Sign in" state, no calls
  session,    // informational ('provider')
  filter: {
    categories,   // optional [ids]; matches service.category OR subcategory. Declared [] → shows NOTHING (fail closed)
    serviceKind,  // optional; matches service.serviceKind. The live writer stores NO such field, so a
                  // declared serviceKind shows only services that carry it (fail closed)
  },
  editable,   // only === true edits
  readOnly,   // true forces read-only
  reason,     // optional plain-language read-only reason (e.g. S.editable.reason)
  onToast,    // optional (msg) => void
}) // → { refresh(), destroy() }
```

Deleted services (`removedAt` set) are never listed.

### 4.1 The exact ctx for b2's `mkt-rates`

```js
'mkt-rates': { global: 'SokoniMerchantRateCard', ctx: function () {
  var E = S.editable, ok = S.session === 'provider' && !!E && E.editable === true;
  return {
    callable: _callable, uid: S.uid, session: S.session,
    filter: { categories: (S.workspace && Array.isArray(S.workspace.marketingCategories))
                            ? S.workspace.marketingCategories.slice() : [] },
    editable: ok, readOnly: !ok, reason: ok ? null : ((E && E.reason) || null),
    onToast: toast }; } },
```

Load `<script src="sokoni-merchant-ratecard.js"></script>` once (merchant-v2 already does on this branch).

## 5. Shell route

`rates` — `tier:'more'`, `kind:'native'`, `sessions:['provider']` only, in MORE_GROUP **`services`**
(`label:'Services'`, `requires:'module:services'`). `module:services` is granted by
`sokoni-merchant-session.js` when the businessWorkspace answer is routed, approval is `VALID_APPROVAL`,
and `modules.services.state === 'AVAILABLE'` (`services` is a CORE module in `functions/business-workspace.js`
on the live archive and on `feat/tech-taxonomy-on-13f74f3`). C2's rule holds: the **ungated** provider
routes remain exactly `home`, `messages`, `signout` (test C2); `rates` is the only gated provider route
(C2b) and the only provider-only route (C5b) — a merchant session never mounts it.

## 6. Tests

`node scripts/test-merchant-ratecard.js` — 39/0, including three negative controls:

| control | sabotage | row that goes red |
|---|---|---|
| X-a | payload = `{basePrice}` only (partial) | R2 full-object replace |
| X-b | `kesToCents` returns the KES float | R3 cents integrity |
| X-c | edit rule `editable !== false` (fails open) | R7 read-only matrix |

The fake `providerDispatch` runs the live archive's real handlers over an in-memory Firestore (field-level
replace on `update`, like Firestore), so every payload is validated by the real `_sanitizePricing`, owner
check and plan cap; previews run the real `computePrice`.

## 7. Known limitations

* `providerListServices` returns at most 100 services (server limit).
* `images`, `priceType` and `subcategory` are not edited here (their writers are unchanged).
* No `serviceKind` field exists on live `providerServices`; the filter is forward-compatible only.
* Browser certification (real DOM, focus restore, mobile layout) is QUEUED — RAM floor; the VM suite
  asserts markup, disabled state, escaping and behaviour.
