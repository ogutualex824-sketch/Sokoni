# Slice 1 — semantic review: `functions/delivery-authority.js`

**From:** `3ec8be4` · **Read-only.** The file was **not** modified; the candidate was applied
temporarily for a test comparison and reverted, verified against HEAD.

```
production baseline   3583202:functions/delivery-authority.js   blob ea9eda7d   115 lines
candidate             c6a1e68:functions/delivery-authority.js   blob 7e97e158   123 lines
```

---

## A · Production baseline

A small pure-logic authority module — no Firestore, no callables, no triggers. It answers one
question: *may this actor perform this operation on this delivery?*

```js
const OPERATION_ACTORS = {
  dispatch: ['seller', 'admin'],
  fail:     ['rider', 'seller', 'admin'],
  route:    ['rider', 'admin'],
};

function mayPerform (operation, actor) {
  const allowed = OPERATION_ACTORS[operation];
  if (!allowed) return false;          /* unknown operation fails closed */
  return !!actor && allowed.indexOf(actor) !== -1;
}
```

Exports `BUYER_FIELDS`, `OPERATION_ACTORS`, `isAdminToken`. Consumed by `functions/dispatch.js`
and `functions/fulfilment-scan.js` — a library, not a deployed function.

## B · Candidate

The **entire** diff is three hunks: a comment block, one new key
`authorizeHandover: ['seller', 'admin']`, and an error-message branch naming it. `mayPerform`,
`BUYER_FIELDS`, `isAdminToken` and all three existing actor lists are untouched.

---

## C · Semantic difference table

| # | difference | classification |
|---|---|---|
| 1 | comment block documenting `authorizeHandover` | **PRESERVES** — prose |
| 2 | `OPERATION_ACTORS.authorizeHandover = ['seller','admin']` | **ADDITIVE** (see caveat) |
| 3 | error message names "authorize handover for" | **PRESERVES** — message text only, same `permission-denied` code |

Everything else is byte-identical. No export added or removed, no signature changed, no
Firestore read or write, no transaction, no callable or trigger, no App Check surface, no rate
limiting, no audit logging, no environment dependency, no client-reachable surface — the module
has none of these on either side.

## D · Security invariants

| invariant | proven | candidate | |
|---|---|---|---|
| `dispatch` actors | `seller, admin` | `seller, admin` | 🟢 unchanged |
| `fail` actors | `rider, seller, admin` | identical | 🟢 unchanged |
| `route` actors | `rider, admin` | identical | 🟢 unchanged |
| unknown operation | fails closed | fails closed | 🟢 unchanged |
| operations removed | — | none | 🟢 |
| operations added | — | exactly one | ⚠️ see caveat |
| `authorizeHandover` excludes rider | n/a | **yes** | 🟢 rider cannot authorize own pickup |
| `authorizeHandover` excludes buyer | n/a | **yes** | 🟢 |
| new key vs tightest existing set | n/a | **equal to `dispatch`** | 🟢 no broader |
| `BUYER_FIELDS` | — | identical | 🟢 |
| `isAdminToken` | — | identical on admin and non-admin | 🟢 |

### The one honest caveat

`mayPerform` **fails closed on unknown operations**, so in the proven version
`authorizeHandover` is denied to *everyone*. The candidate moves it from *denied to all* to
*allowed for seller/admin*. **That is technically a broadening**, and calling it purely additive
without saying so would be sloppy.

It is nonetheless inert in production, and that is verifiable rather than assumed:

* `dispatch.js` and `fulfilment-scan.js` — the only proven consumers — contain **0** references to `authorizeHandover`;
* its sole consumer is `functions/seller-handover.js`, which exists **only in the candidate**;
* `sellerAuthorizeHandover` is **not deployed** — absent from all 1002 services.

So adopting **this file alone** leaves the key unreachable: no caller passes it, and the
function that would is neither present nor deployed.

## E · Tests

| suite | baseline | with candidate |
|---|---|---|
| `test-delivery-dispatch-authority` | 45 / 0 | 45 / 0 |
| `test-delivery-authorization` | 36 / 0 | 36 / 0 |
| `test-fulfilment-scan` | 69 / 0 | 69 / 0 |
| `test-fulfilment-contract` | exit 0 | exit 0 |

**Identical results are weak evidence and are not treated as the finding.** No existing suite
passes `authorizeHandover`, so they are structurally blind to the delta; what they establish is
only that *nothing else moved*.

A targeted probe asserts the delta itself — **13 passed, 0 failed**: all three existing actor
lists byte-identical, the proven version confirmed to deny the new key, the new key equal to
`dispatch` and excluding rider and buyer, exactly one operation added and none removed, and
`BUYER_FIELDS` / `isAdminToken` unchanged on both admin and non-admin input.

---

## F · Verdict

# 🟢 SAFE_TO_RESOLVE — scoped to this file only

Every delta qualifies:

1. **Comment** — prose.
2. **Error message** — text only; same `permission-denied` code and shape.
3. **New operation key** — strictly additive to a fail-closed table. No existing contract is
   weakened, the new entry is no broader than the tightest existing operation, it excludes rider
   and buyer by design, and it is unreachable without a consumer that is neither in this lineage
   nor deployed.

### The condition that comes with it

**This verdict does not extend to `functions/seller-handover.js` or the
`sellerAuthorizeHandover` callable.** Those are a **new client-reachable surface** and have had
no review. Adopting them on the strength of this verdict would be exactly the mistake this
process exists to prevent — the safety here rests *precisely* on the key being unreachable.

If `seller-handover.js` is later proposed, it needs its own semantic review covering the things
`delivery-authority.js` does not have: authentication, App Check, Firestore writes, custody
state transitions, PIN interaction, idempotency and replay.

```
production deployed   NO
production mutated    NO
worktree status       clean  (candidate applied temporarily, reverted, verified against HEAD)
files changed         NONE
```
