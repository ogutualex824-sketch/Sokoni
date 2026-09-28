# POS Q0b-1 — customer scope: `posLookupCustomer`, `getPOSCustomer`, `upsertPOSCustomer` (main line)

**Branch:** `pos-safety/q0b-customer-scope` (from main Q0a `dd9dc2a`) · **not deployed** · served lineage NOT changed
**Owner authorization (2026-09-27):** Q0b-1 exactly as designed.
1. The till lookup capability is `customers`.
2. The till merchant proof is a separate helper; the checkout proof is untouched.
3. There is one strict customer-scope authority in `pos-customer-scope.js`, which Q0a consumes and is re-certified
   against.

**Out of scope:** the other 13 `posCustomers` paths, `_resolveSellerId`, the CRM client lookup bug, and the checkout
workforce gaps.

**Related:** [[POS-Q0a-loyalty-redemption]] · [[POS-0b-checkout-integrity]] · `functions/pos-customer-scope.js`

## Lineage: why this is a repair, not a restore

- **`9360cbd` (2026-08-16)** added `pos-customer-scope.js` and scoped all three handlers.
- **`2f4fc20` (2026-09-15)** reverted the handler changes by accident. It was a bulk commit of 296 files left
  uncommitted in the main checkout, some of them copies from before `9360cbd`. The module survived; nothing called it.

`9360cbd` was **not** restorable as it stood:

| `9360cbd` behaviour | Consequence |
|---|---|
| owner = `auth.uid` everywhere | A cashier found none of the shop's customers, and customers a cashier created were stamped with the cashier's own uid. |
| `upsertPOSCustomer`: a caller-supplied `customerId` goes to `doc(customerId).set(...)` | **Another merchant's customer document was replaced**, and `9360cbd` stamped the caller as its new owner. Main at `dd9dc2a` does the same `set()`. |
| phone lookups query only the `sellerId` field | Composite-id `{sellerId}_{phone}` customers are never found by phone. |

Main at `dd9dc2a` also rejected **every new customer created without an email**: its `set()` carried
`FieldValue.delete()`.

## The repair

**One authority: `pos-customer-scope.js`.**
- `classifyCustomer(id, data, owners)` returns `owned`, `foreign`, `malformed` or `unowned`:
  - a present `sellerId` must be a well-formed string and must be in the proven owner set;
  - otherwise `ownsCustomer` applies: a `sellerId` field, or a composite id matched from the left.
- `isCustomerDocId` accepts only a single path segment.
- `canonicalPhone` gives the `254…` key used in composite ids.
- `findOwnedIn`, `getOwnedIn` and `findOwnedByPhone`:
  - every query carries `sellerId in [owners]`;
  - the only direct reads are of ids carrying one of our own prefixes, and those are still classified.
- Q0a's `_assertCustomerOwned` now turns `classifyCustomer`'s verdict into its refusals. The codes and messages are
  unchanged.

**`posLookupCustomer` (the till).**
- `merchantId` is now required, and it is only a claim.
- `_proveCustomerMerchant` proves it through `resolveActor` (the shop owner or shop staff), or through business
  membership with **`customers`**.
- The accepted owners are `_merchantOwnerSet`'s, the same set Q0a's checkout check uses.
- A miss and a foreign customer both return `{found:false}`.
- The checkout's own inline proof is untouched.

**`getPOSCustomer` and `upsertPOSCustomer` (owner CRM).**
- The owner comes from this file's existing `_boundSellerId`: the caller, or a seller an **admin** names. That is the
  only admin authority, and it already existed.
- A non-admin naming another seller is refused. Staff get nothing here, as that convention states.

**Upsert.** One transaction reads, classifies and writes.
- **New customer:** `create()` at `{owner}_{254…}`, with a matching `sellerId`.
- **Existing customer:** an owned record found by the deterministic id, or by an owner-scoped phone query, is updated,
  and its owner is stamped on it.
- **Caller-supplied `customerId`:** used only if it is the caller's own existing customer. A foreign id and a missing id
  get the **same** `permission-denied` message.
- **Our deterministic id with a foreign or malformed body:** refused; nothing is written through it.
- **`ALREADY_EXISTS`** (a concurrent first create) is retried once, and the retry updates the winner's record.

## Additional defects fixed in these handlers (found while repairing them; owner-confirmed as in scope)

1. **`upsertPOSCustomer` rejected every new customer created without an email.**
   - The create path wrote `email: FieldValue.delete()` inside `set()`, which Firestore rejects as an invalid document.
   - On `dd9dc2a` the old-tree U-12 case fails with "not a valid Firestore document".
   - A new customer is now created with `email: null`. That is U-12, green on the new tree.
2. **A customer created by upsert could not be found at the till by phone.**
   - Upsert stores the phone as `254…`. The till's field lookup tries only `+254…` and the raw input, so on `dd9dc2a`
     the till could never find such a customer.
   - The lookup now also reads the composite key `{owner}_{254…}` (`canonicalPhone`). This is L-3, and F-1's till step.
   - The field-format mismatch itself is unchanged for records written by other paths; see the open findings below.

## Evidence — `scripts/test-q0b-customer-scope.js` (real handlers, Firestore emulator, clean database per run)

| tree | result |
|---|---|
| new | **40 / 0** |
| old (`dd9dc2a`) | **5 / 35 FAIL** |

**Old-tree failures:**
- B's customer is returned to A by phone, id, email, member card, B's composite id and a conflicting prefix record.
- A legacy ownerless record is returned.
- A forged `merchantId`, a stranger, a member without `customers`, A's cashier claiming B, and an admin who is not the
  shop are all answered.
- A read spy shows B's documents being **loaded**.
- Upsert:
  - it creates random ids with no owner;
  - it updates B's record through B's phone;
  - it **replaces** B's document through `customerId` (and `B1R` through a foreign id);
  - it creates a nested document through a path id;
  - it accepts a forged `sellerId`;
  - it writes through our-prefixed conflict records;
  - it rejects a customer without an email.
- The till flow fails: an upserted customer cannot be found, then sold to, with points awarded.

**New tree:**

| Area | Result |
|---|---|
| till, authorized | owner, the shop's cashier (resolveActor) and a member with `customers` find their own customers, including a composite-only one |
| till, refused | every cross-tenant case is `{found:false}` or a `permission-denied` proof refusal; **X-13** proves A's lookups never load a B document |
| upsert, creation | deterministic create; same phone in another format → one record; two concurrent first upserts → **one** record; a forced `ALREADY_EXISTS` is retried to one record; a composite-only customer is updated in place; creating without an email works |
| upsert, protection | every attempted foreign write leaves the victim **byte-unchanged** (data and `updateTime`) |
| owner switch | A read a customer; its owner became B; upsert by phone and by id are both refused, both reads return `{found:false}`, and the record is byte-unchanged |
| `getPOSCustomer` | owner reads its own; forged `sellerId` refused; admin-named seller allowed; staff get nothing |
| **F-1**, the real flow | owner upserts → the shop's cashier finds the customer at the till → `posCompleteCheckout` sells to it → the customer earns 1 point on KES 100 |

**Mutation check** (one safeguard at a time, in scratch copies):

| Reverted | Red |
|---|---|
| foreign verdict | X-6, X-6b, U-11, S-1 |
| malformed verdict | X-14 |
| path-id check | U-9 |
| owner filter dropped from the field query | X-13 |
| owner filter dropped from the id query | X-13 |
| prefix read unclassified | X-14, X-6b, S-1 |
| composite read unclassified | X-6, X-14, S-1 |
| till proof skipped | L-5, X-8–X-12 |
| till capability changed to `pos` | X-10 |
| `getPOSCustomer` unbound | G-3 |
| `upsertPOSCustomer` unbound | U-10 |
| `customerId` unchecked | U-7, U-8, S-1, G-2, G-4 |
| composite conflict unchecked | X-14, U-11, S-1 |
| random id instead of the deterministic id | 11 red |
| `ALREADY_EXISTS` retry removed | U-13 |
| `set()` instead of `create()` | U-13 (see note) |
| unowned verdict | **none in this suite** — see note |

- **Unowned verdict.** Every Q0b read carries the owner filter or our prefix, so an unowned record never reaches the
  classifier here. The checkout does reach it: the Q0a re-certification turns O-b and O-c red.
- **`set()` vs `create()`.** U-13 goes red only because its injection hooks `create()`. The transaction's read of the
  deterministic id already stops an overwrite. The emulator serialises transactions, so a real race cannot be
  reproduced there.

**Q0a re-certification** on this tree, with the Q0a suite run in its own emulator project:
- 26/0, with the original mutant profile.
- in-transaction check → O-f; all checks → O-a–g; verdict ignored → O-a–g; shared malformed → O-d;
  shared foreign → O-a, O-e, O-f, O-g; shared unowned → O-b, O-c; figure → L-a–i; positive redemption → L-j, L-k;
  customer id → O-h, O-i; pre-transaction check → none (defence in depth, as certified).

**Regression floor** (40 main suites vs `dd9dc2a`): 37 identical, 3 differ, and none is a behaviour regression.
1. `test-catalogue-canonical-migration` 46/1: the working-tree guard, which clears on commit.
2. **`test-pos-customer-scope` (the `9360cbd` tripwire, not edited).**
   - Before (`dd9dc2a`): 23 pass / 18 fail.
   - Now: parts A–C, which test the module, **pass**, including "the owner is part of the query". Part D then crashes:
     it calls `posLookupCustomer` without a `merchantId`, under `9360cbd`'s `auth.uid` model, which this repair
     deliberately replaced with a proven merchant claim. The throw ("merchantId required") is not caught by the suite.
3. **`test-pos-retail-tenant-binding` 32/1 (not edited).**
   - The assertion "admin is the only exception, declared once" counts the literal string `_boundSellerId` and expects
     8. It is now 11: two new call sites and one mention in the Q0b-1 comment.
   - No admin logic was added; both handlers call the one existing helper.

The 0b checkout emulator suite is 31/0 on both trees. **Gates:** `predeploy-syntax-gate` exit 0.

## Boundaries and open findings (NOT fixed here)

- **The other 13 `posCustomers` paths:**
  - 11 in `pos-crm-pro`, including a scheduled job;
  - `pos-bi` (2 callables and a scheduled job);
  - `recordPOSSale`.
- **`_resolveSellerId`** trusts a `sellerId` from the request.
- **The CRM client lookup bug:** `pos-crm-pro.html` sends `getPOSCustomer({query})`, which the handler does not read.
- **Phone formats:** the till's field lookup still tries `+254…` and the raw input. Customers created with upsert
  (`254…`) are reached through the composite key.
- **The checkout workforce gaps:**
  - the `sales` permission is granted by no default role;
  - `_assertBusinessPermission` ignores `employmentStatus`.
- **Not done here:** the served adaptation, which follows once main Q0b-1 is certified and committed.

## L-6 port onto the POS lineage (2026-09-28)

Q0b-1 was certified on the main line (64d68b1, parent dd9dc2a). This section records its port onto the POS lineage
descended from the live build, as reconciliation unit **L-6**, on base `304c971` (L-5, the Q0a port). See
[[POS-Q0a-loyalty-redemption]], [[POS-0b-checkout-integrity]] and [[FINANCIAL_CORE_ARCHITECTURE]].

- **How it was ported.** Q0b-1's parent is Q0a, which L-5 put on this lineage.
  - Its changes to `pos-customer-scope.js`, `pos-retail-engine.js` and `pos-zero-friction.js` apply **cleanly** and
    are **line-for-line the source patch**.
  - In `pos-retail-engine.js`, every hunk ends before `recordPOSSale`, so M0-2's idempotent sale path is untouched.
  - `_boundSellerId` is byte-identical on both lines, and `pos-customer-scope.js` now matches the main line
    byte for byte.
- **Scope:** `posLookupCustomer`, `getPOSCustomer` and `upsertPOSCustomer`, plus Q0a's checkout check moved
  onto the shared `classifyCustomer` (Q0a re-certified at 26/0).
  - **Not carried:** Q0b-2a (`recordPOSSale`'s customer, unit L-7), Q0b-2b (insights), and Q0c.
  - The two handler defects Q0b-1 fixes in passing ship with it, because they are in its source patch: the
    FieldValue.delete() rejection of email-less customers, and phone lookup of upserted customers (U-12, L-3, F-1).
- **The two tripwires are carried with it.** d2a6f3c (`test-pos-customer-scope`) and 287bf37
  (`test-pos-retail-tenant-binding`) are byte-identical to the main line, and the base pre-images were identical too.
  - On the Q0b-1 code alone they fail exactly as the floor note above records: Part D crashes on
    "merchantId required", and the literal count finds 9 call sites against the expected 7.
  - Repaired: **51/0 and 33/0 on new; 25/26 and 32/1 on the old code**. They are discriminating, not decorative.
- **Boundaries above, updated for this lineage:**
  - `_resolveSellerId` and the CRM client lookup bug are **already closed** here by L-2 (Q0b-2c/2d).
  - `recordPOSSale` is L-7.
  - The `posWallets/{customer.id}` gap from Q0a is still open, as a separate unit.
- **Evidence:**
  - 40/0 on the port vs 5/35 on `304c971`, the same profile as the main line.
  - 17 Q0b-1 mutants: 16 caught. The survivor is `unowned-allowed`, documented above (the owner filter sits in the query); the
    Q0a suite catches the same mutation at O-b and O-c.
  - 11 Q0a re-certification mutants: 10 caught. The survivor is the pre-transaction check (defence in depth).
  - Floor and earlier units: see CHANGELOG 164.
- **Not deployed.**
