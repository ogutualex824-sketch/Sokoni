# Ride Hub — product module roadmap

**Date:** 2026-08-02 · **Status:** **Deferred — feature not implemented (not a regression)**
**This is a planned product module, not technical debt.**

Related: [[Admin Console Integrity]] · [[Logistics & Dispatch v1.1]] · [[Navigation & Dispatch]]

---

## Why this is not a bug

The admin Rides pane has two tables that have never rendered anything. That reads like a defect until
you check the other end: **there is nothing to render, and never has been.** No renderer was removed,
no pipeline regressed, no data was lost. The markup was built ahead of the product.

Recording it as technical debt would be wrong twice — it would imply something broke, and it would
invite someone to "fix" it by wiring placeholder renderers to empty collections, which produces a pane
that *looks* finished and reports zero forever.

## Measured state, 2026-08-02

### Existing assets

| collection | documents | what it is |
|---|---|---|
| `driverLocations` | present | live GPS positions |
| `deliveryLocations` | present | live GPS positions |

Both are **tracking** collections. They record where something is, not what was requested, by whom,
for how much, or whether it was completed.

### Collections that do not exist

`rides` · `rideRequests` · `rideDrivers` · `drivers` · `driverApplications` · `deliveries` ·
`deliveryRequests` · `couriers` — **all 0 documents**.

### Admin placeholders, measured per container

| sub-tab | container | state |
|---|---|---|
| Rides | `#ridesBody` | **unfed** — no renderer exists |
| Drivers | `#driversBody` | **unfed** — no renderer exists |
| Delivery | `#deliveryStats` | fed by `renderDelivery()` |
| Delivery | `#deliveriesBody`, `#couriersBody` | **unfed orphans** |
| Payouts | `#payoutsStats`, `#payoutsBody`, `#payoutsDoneBody` | **fed by `renderPayouts()` — this sub-tab works** |
| — | `#ride-payout-cnt` | unfed badge |

So the pane is **not uniformly empty**: Payouts is implemented, Delivery is half-wired, and Rides and
Drivers are markup only. An earlier note in this programme said "no renderer" of the pane as a whole;
that was true of the *rides and drivers tables* and is corrected here.

**The Delivery sub-tab duplicates a working feature.** A separate, reachable `adm-pane-delivery` is fed
by the live `_renderAdmDeliveries` Firestore listener writing `#deliveryBody` and `#couriersGrid`. Two
UIs for the same data, one real. **That is a de-duplication task, not a Ride Hub task**, and should be
resolved independently of whether the Ride Hub is ever built.

---

## Missing domains

Everything a ride product needs, none of which exists:

| domain | what is missing |
|---|---|
| **Ride requests** | trip model: origin, destination, requested time, status lifecycle, cancellation |
| **Drivers** | driver record distinct from a user; availability, rating, suspension |
| **Vehicles** | vehicle record, plate, capacity, class, inspection/insurance expiry |
| **Driver onboarding** | application, document verification, approval — the `applications` lifecycle already exists and should be extended, not duplicated |
| **Dispatch** | matching a request to a driver; the 8-factor scoring in Logistics & Dispatch v1.1 is the obvious starting point |
| **Pricing** | fare model, surge, minimum fare, cancellation fee, commission — must go through the existing commission engine, not a second one |
| **Payments** | fare capture, driver payout — must reuse the settlement engine and wallet, not a parallel path |
| **ETA / routing** | the OSRM rider-nav work already exists and should be extended |
| **Admin moderation** | approve/suspend a driver; reuse `_decideProp`-style Firestore + audit, not a new system |
| **Customer history** | a rider's past trips, receipts, disputes |

## Recommended phasing, if approved

Each phase must be independently shippable and verifiable; none should begin before the one above it
has real data flowing.

1. **Driver onboarding** — extend the existing `applications` lifecycle with a `driver` role. Produces
   the first real records and the first thing the admin pane can genuinely list.
2. **Driver + vehicle records** — the registry the approval projects into, following the
   application → registry convergence already used for providers.
3. **Ride request model** — trip documents with a status lifecycle. The admin Rides table becomes
   implementable at this point and not before.
4. **Dispatch** — extend Logistics & Dispatch v1.1 rather than starting a matcher.
5. **Pricing + payments** — through the commission engine and settlement engine that already exist.
6. **ETA/routing** — extend the existing OSRM navigation work.
7. **Admin moderation + customer history** — last, because they are views over the six layers above.

## Decision required before any implementation

**Is the Ride Hub a product SOKONI is building?** Until that is answered, the correct state is exactly
where it is now: markup present, no renderers wired to empty collections, no placeholder data, and this
document explaining why.

**Two things should happen regardless of that decision**, because they are not Ride Hub work:

- resolve the **duplicate Delivery UI** (the sub-tab vs the working `adm-pane-delivery`)
- decide whether the unfed containers should be **removed from the markup** until the product exists,
  which would take the orphan-container count down and stop the pane advertising features that are not
  there
