# Customers Authority Census

> Regenerate: `node scripts/census-customers-authority.js --md > docs/MERCHANT_CUSTOMERS_AUTHORITY.md`
> Read-only. No UI built, no authorization changed, nothing bound into the workspace.

Companion to [[MERCHANT_2D2_AUTHORITY_CENSUS]] and [[MERCHANT_MARKETING_AUTHORITY]].

## Per-capability

| capability | exported | authorization | scope | verdict |
|---|---|---|---|---|
| `getCustomerProfile` | yes | requireAuth + assertMerchantOwner(uid, merchantId) | merchants/{merchantId}.ownerId === uid (or adminUids) | **CANONICAL BUT ACCOUNT-SCOPED** |
| `buildCustomerProfile` | yes | requireAuth + assertMerchantOwner | same as above | **CANONICAL BUT ACCOUNT-SCOPED** |
| `getCRMDashboard` | yes | requireAuth + assertMerchantOwner | merchantId | **CANONICAL BUT ACCOUNT-SCOPED** |
| `posGetCustomerInsights` | yes | auth only | merchantId TAKEN FROM THE REQUEST, never verified | **CLIENT-SCOPE / UNSAFE** |
| `getCustomerGrowthMetrics` | yes | auth + posRole claim ≥ manager + auth.token.sellerId === sellerId | a `sellerId` CUSTOM CLAIM | **BLOCKED** |
| `posLookupCustomer` | yes | auth only | NONE — the query is collection-wide | **CLIENT-SCOPE / UNSAFE** |

- **`getCustomerProfile`** — Ownership IS asserted, against the `merchants` document. That is a real check — but see the reachability finding below.
- **`buildCustomerProfile`** — Same guard, same reachability caveat.
- **`getCRMDashboard`** — Correctly scoped, but it returns counts plus the top FIVE customers by CLV. It is a dashboard, not a list — it cannot back a Customers screen on its own.
- **`posGetCustomerInsights`** — It requires `merchantId` to be a string and then queries with it. Nothing checks the caller owns that merchant. Must not be bound into the workspace.
- **`getCustomerGrowthMetrics`** — It DOES compare the requested sellerId to a claim rather than trusting the request — so it fails closed, not open. But no `sellerId` claim is minted anywhere in functions/, so for every real merchant `callerSellerId` is undefined and the comparison denies. Safe, and unreachable.
- **`posLookupCustomer`** — SECURITY FINDING — see below. It searches every posCustomers document by phone, email, id or member-card code with no merchant filter at all.

## The customer LIST — the piece that was missing

**There is no customer-list callable.** No export in `functions/index.js` lists a merchant's
customers; `getCRMDashboard` returns the top five by CLV and some counts, and
`getCustomerProfile` reads one profile by uid. So the list has to come from a client read,
and there are two candidate collections. They are not equivalent.

### `crmCustomerProfiles` — usable, and safe by construction

```
match /crmCustomerProfiles/{uid} {
  allow read:  if isAdmin()
               || (isAuthed() && request.auth.uid == uid)
               || (isAuthed() && resource.data.merchantId == request.auth.uid);
  allow write: if false;   // CF-only — buildCustomerProfile, calculateCLV
}
```

This is the same shape that made the Messages thread body safe: a **rules-gated read**, and
**client writes refused outright**, so the client cannot become the authority even by
accident. `merchantId` here is compared to `request.auth.uid` — the list is therefore
**ACCOUNT-scoped**, not shop-scoped, and must be labelled as such.

### `posCustomers` — not usable, and worth understanding why

```
match /posCustomers/{customerId} {
  allow read: if isPosOwner() || isAdmin();
}
function isPosOwner() { return isAuthed() && resource.data.sellerId == request.auth.uid; }
```

The rule gates on a `sellerId` field **in the document body**. The writers put the seller in
the document *id* — `posCustomers/{sellerId}_{phone}` (`pos-crm-pro.js`) — and merge bodies
like `{ storeCredit, updatedAt }` that carry no `sellerId` at all. `pos-bi.js` meanwhile
queries `where('sellerId', '==', sid)`, and `posGetCustomerInsights` queries
`where('merchantId', '==', merchantId)` — three different scope vocabularies over one
collection. A client read of `posCustomers` is therefore unreliable at best, and is not the
list path.

## SECURITY FINDING — `posLookupCustomer` is an unscoped customer search

`posLookupCustomer` is deployed and takes `query`, `method` and `merchantId`. It searches
`posCustomers` by phone, then by document id, then by email, then by member-card code:

```js
snap = await coll.where('phone', '==', phone).limit(1).get();
if ((!snap || snap.empty) && (method === 'id' || method === 'auto')) { … coll.doc(q).get() }
snap = await coll.where('email', '==', q.toLowerCase()).limit(1).get();
```

**None of those queries is scoped to a merchant** — verified: the function body contains **no** merchant/seller-scoped `where` clause. The `merchantId` argument is used only to fetch the *loyalty programme configuration*, never to filter the customer:

```js
if (merchantId) {
  const progSnap = await db.collection('loyaltyPrograms').doc(merchantId).get();
  …  /* the customer has already been selected by this point */
}
```

So **any authenticated account can look up any customer on the platform by phone number or
email**, and receive that customer's name, email, phone, loyalty points, tier, total spent
and purchase count. A phone number is guessable; this is enumerable PII disclosure across
tenants.

This is the same class of defect as the `orderAdvance` IDOR — deployed, reachable, and
authorising on nothing but "is signed in". It is **not** fixed here, and it must **not** be
bound into the Customers surface. It deserves its own bounded security stage:

```
auth.uid → resolve the caller's merchant/shop → scope the lookup to it
        → return only a customer of THAT merchant
```

## Reachability — the owner check reads a POS-only collection

`assertMerchantOwner` — the guard on all three canonical CRM callables — reads
`merchants/{merchantId}` and compares `ownerId`. That document is written in exactly one
place (1 writer found): `business-bootstrap.js` `_createBusiness`, which the merchant-consolidation census recorded as reachable **only from `pos-setup.html`**.

A merchant who came through the marketplace application path (2A/2B) therefore has **no**
`merchants/` record, and every one of `getCustomerProfile`, `buildCustomerProfile` and
`getCRMDashboard` throws `not-found` for them. Correctly-shaped, correctly-scoped, and
unreachable — the same pattern as the `shopEmployees` key divergence.

The list path does **not** share this problem: `crmCustomerProfiles` rules compare
`merchantId` to `request.auth.uid` directly, with no `merchants/` document involved.

## What the Customers surface may be built on

| | |
|---|---|
| **List + search** | client read of `crmCustomerProfiles where merchantId == uid` — rules-gated, CF-only writes, account-scoped |
| **Profile** | `getCustomerProfile` / `buildCustomerProfile`, with the `merchants/` reachability caveat surfaced honestly when it refuses |
| **Aggregates** | `getCRMDashboard` only — and only where the figure is genuinely returned |
| **Not bound** | `posGetCustomerInsights` (unverified client scope), `getCustomerGrowthMetrics` (unsatisfiable claim), `posLookupCustomer` (unscoped search) |

Keeping the unsafe three **out of the binding** matters more than hiding their values: a
surface that fetches and then hides is still a surface that fetched.

Search is therefore **client-side over the merchant's own rules-gated rows**, not a server
lookup — which is the honest option while `posLookupCustomer` is unscoped, and is scoped by
construction because the rules will not return another merchant's rows.
