# Packages and bundles — one shelf, no second stock

**Status:** implemented on `slice/c4-category-matrix` on 2026-09-29 (universal catalogue U5). **Not deployed.**

Related: [[CATALOGUE_CAPABILITY_MATRIX]], [[UNIVERSAL_CATALOGUE_CENSUS]], [[PRODUCT_OFFERS]]

## The rule

A **package** (meal deal, spa package, service bundle) or **bundle** (phone + case) is a listing whose **components**
are real products of the **same shop**:

```
Pizza Meal Deal  (KES 850)
 ├── Pizza × 1
 └── Soda  × 2
```

Selling one takes its components off the shelf. That is the canonical `products/{id}.stock` which the till, the
storefront, inventory and checkout all read. **The package has no stock of its own** (`trackInventory: false`). Its
availability is *derived*: the number of complete sets its components make (`availableUnits`).

## One helper, every path

`functions/shared/package-stock.js`, with a byte-identical browser copy `/sokoni-package-stock.js` kept in step by
`scripts/build-package-stock.js --check`:

| Function | Purpose |
|---|---|
| `sanitizeComponents` | Whole quantities 1–99, merged per product, at most 20 |
| `componentsForLine(prod)` | The components a **server** pricer attaches to an order line, from the package's own document |
| `expandLines(lines)` | A package line becomes its components; entries for the same product are merged |
| `availableUnits(pkg, byId)` | The fewest complete sets. Unmetered components never limit it; an archived component makes it 0 |

| Path | What it does with a package |
|---|---|
| `payment-purposes.validateOrderLines` (M-Pesa `product_order` and the multi-shop quote) | Attaches the server's components to the line, then checks the whole cart against the shelf **once** (two deals plus a loose soda need five sodas). Refuses a foreign, nested, archived or out-of-stock component (`PACKAGE_*` codes). |
| `index.js createCheckoutSession` (card) | Package availability comes from its components, and the quantity is clamped to the complete sets. The session line carries the server's components. |
| `index.js verifyIntasendPayment` | Expands **only a server session**. In the no-session fallback the items are the client's, and their components are ignored. |
| `index.js _finalizeMarketplacePayment` | Deducts the components inside the order transaction. The receipt lists the package at its charged price. A component that is not the package's shop is **flagged** (`oversoldAlerts`, `package_component_foreign`), never deducted. |
| `pos-zero-friction.posCompleteCheckout` (till) | Refuses a foreign or nested component **before anything is charged**, checks the combined need in the transaction's read phase, and deducts the components. A loose item of the same product is folded into its single write. |

**On every path, a package document is never itself deducted.** Its stock is absent, meaning *unmetered*, and
`increment(-n)` on an absent field would write a negative stock and take the package off sale.

## Merchant-v2

Choosing **Package** or **Bundle** in the Listing Studio shows **"What's in it"**:
- It offers only this shop's own live, non-package products.
- Quantities are set with steppers.
- It shows "Sets available now" (from the same helper) and the price of the items bought separately.

The writer re-checks every item against the **stored** record before writing. It refuses:
- another shop's item (`PACKAGE_COMPONENT_FOREIGN`);
- a package inside a package (`PACKAGE_NESTED`);
- the package itself (`PACKAGE_SELF`);
- an empty package (`PACKAGE_EMPTY`);
- an opening stock (`PACKAGE_NO_STOCK`).

The writer sets `trackInventory: false`.

## Why not the tenant BOM

`inventory-v2.inventorySaveBOM` already stores bills of materials, but in the **tenant inventory** store
(`tenants/{t}/inventory_bom`). Owner rule ADR-016 forbids inventing a bridge between the tenant store and the shop's
canonical products. The package's components therefore live on the package listing, next to the stock they move.

## Known limits

- **Substitutions** ("swap the soda for a juice") are a declared field on the listing, not yet choosable at checkout.
- **Several different packages sharing one component** in the same card-session cart are clamped per package; the
  finaliser floors and flags any shortfall.
- **The storefront and product page** do not yet show "N sets available" for a package; the checkout already enforces
  it.
- **A package's own sales counters:** the till updates `sold`, `lastSoldAt` and `totalRevenue`; online finalize updates
  `sold` only.
- **The `darajaSTKCallback` loop** (a retired rail) is not package-aware.
- **Not deployed.**
