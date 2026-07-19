# Smart Receipt & Delivery Document Engine

Context-aware document generation for [[SmartPOS]], [[Orders]] and [[Delivery]].
Implemented in `sokoni-receipt-engine.js`. Regression gate: `scripts/test-receipt-documents.js`.

## The principle

**Checkout does not decide which documents to print.** It describes the order and asks for a
plan; the engine resolves it. Adding a document type or changing a fulfilment rule therefore
never touches checkout code.

```js
const plan = SokoniReceiptEngine.planDocuments(order);
// [{ type:'receipt', printer:'receipt' }, { type:'packing', printer:'packing' }]

for (const doc of plan) {
  const html   = SokoniReceiptEngine.buildHTML({ type: doc.type, data: order }, settings);
  const device = SokoniReceiptEngine.resolvePrinter(doc.printer, merchantPrinterConfig);
  // send html to device — or queue if device is null
}
```

## Fulfilment → documents

| Fulfilment | Documents printed |
|---|---|
| Walk-in | Customer Receipt |
| Delivery | Customer Receipt + Packing Slip |
| Pickup | Customer Receipt + Collection Slip |
| Restaurant (delivery) | Customer Receipt + Packing Slip + Kitchen Ticket |
| Restaurant (pickup) | Customer Receipt + Collection Slip + Kitchen Ticket |
| `merchantCopy: true` | adds Merchant Copy |

Food is **orthogonal** to fulfilment — a restaurant delivery needs both a packing slip and a
kitchen ticket, so the rules compose rather than exclude.

## The privacy contract

Each registered type declares what it is allowed to carry:

- `money` — line prices and totals
- `pii` — recipient name, phone, address
- `internal` — commission, settlement, margin

The dangerous combination is **`pii` + `internal` on a document that travels with a parcel**.

| Document | money | pii | internal | Travels with parcel |
|---|:---:|:---:|:---:|:---:|
| Customer Receipt | ✅ | — | ❌ | no |
| Packing Slip | ❌ | ✅ | ❌ | **yes** |
| Collection Slip | ❌ | ✅ | ❌ | no |
| Kitchen Ticket | ❌ | ❌ | ❌ | no |
| Merchant Copy | ✅ | — | ✅ | **never** |
| Courier Manifest | COD only | ✅ | ❌ | with rider |

**Why this is enforced by test, not convention:** an internal figure printed on a package is
read by everyone who handles it — including the buyer, who then sees the merchant's margin.
`scripts/test-receipt-documents.js` asserts the packing slip omits commission, settlement,
gateway fee and totals, and the assertions are falsifiable: injecting a leak fails the suite.

The kitchen ticket carries **no prices and no customer contact** — kitchen staff need what to
cook, and a customer's phone number in a food-prep area is a needless exposure.

## Printer routing

Roles: `receipt`, `packing`, `kitchen`, `label`, `warehouse`.

`resolvePrinter(role, config)` falls back `role → receipt → default → null`. A merchant with one
printer receives every document sequentially rather than silently losing some. `null` means the
caller should queue, not crash.

## Adding a document type

No engine edit and no checkout change:

```js
SokoniReceiptEngine.registerDocument('creditnote', {
  build:   (job, settings) => '<html>…</html>',
  printer: 'receipt',
  carries: ['money'],
});
```

Duplicate registration throws rather than silently replacing a template.

## Blanks by design

The packing slip prints **labelled blanks** for rider name, rider phone, dispatch time, delivery
time and recipient signature — completed by hand at handover. The courier manifest does the same
for dispatch and cash reconciliation. These are not missing data; they are the paper trail.

## Status

**Repository Verified** — 49 assertions pass, falsifiability confirmed.
**Requires Validation** — no document has been sent to a physical thermal printer. Widths (58 mm
/ 80 mm) are set via `@page`; real output on a P58E is unverified.

Samples: `docs/receipt-samples/` (each type at both widths).

Related: [[SmartPOS]] · [[Delivery]] · [[Orders]] · [[Payments]]

## Paperless fulfilment

`SokoniPosprint.printFulfilment(order)` is the single call that produces every document an
order needs. It lives on the canonical print module, so `pos-checkout`, `pos.html` and the
seller dashboard all gain fulfilment printing without any of them learning which documents a
delivery order requires.

```js
const { printed, skipped } = await SokoniPosprint.printFulfilment(order);
```

**Separation of concerns:** the receipt engine decides *which* documents (a platform rule);
the print module decides *where* they print and *whether* they print (a merchant preference).

### Merchant settings

| Setting | Effect |
|---|---|
| `paperless: true` | suppresses **all** printing |
| `docPrint: { packing:false }` | disables one document; absent means print |
| `printerRoles: { kitchen:'KP-01' }` | routes a role to a device |

Routing falls back **role → default printer**, so a merchant with one printer receives every
document sequentially rather than silently losing some.

**Suppressing a print never suppresses the document.** Receipt and dispatch records are written
server-side regardless; a paperless merchant still has every document and reads it on screen or
via the order QR. Suppressed documents are returned as `skipped` so the caller can display them.

### Failure behaviour

Offline printing is already handled — `print()` enqueues and the queue drains on reconnect, so a
fulfilment printed with the printer unplugged is queued, not lost.

A single failed document does not abort the rest: a packing slip that fails to print must not
also lose the customer receipt. Failures appear in `skipped` with a reason.

If the receipt engine is unavailable the call degrades to a plain receipt (`degraded: true`)
rather than failing the sale.
