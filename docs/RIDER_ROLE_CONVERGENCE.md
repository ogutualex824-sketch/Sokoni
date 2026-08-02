# Rider role convergence — one identity, many workspaces

**Date:** 2026-08-02 · **Status:** specification. **Not implemented.**
**Founder directive. Do not start before the P0 landlord security work is green.**

Related: [[Platform Hub Engine]] · [[Provider Lifecycle Contract]] · [[Application Lifecycle]] ·
[[Image Pipeline Survey]] · [[Access Control Matrix]]

---

## The problem

`driver.html` (Delivery Hub) renders rider profile information inside the live operations screen. That
makes the Delivery Hub read as a **second identity** rather than a workspace on the one account.

## Rule 1 — One identity

One account. **Buyer, Seller, Service Provider and Rider are roles, not identities.** No second
profile is created or displayed inside Delivery Hub.

## Rule 2 — Delivery Hub is an operations dashboard

`/driver` shows operational information **only**:

| | |
|---|---|
| Online / Offline | Current zone |
| Current vehicle (switcher) | Shift status |
| Today's earnings | Today's deliveries |
| Claimable deliveries | Active deliveries |
| Navigation · Messages · Support | |

**No profile editing on this page.** The rider profile header is removed.

## Rule 3 — Profile is the only place rider data is edited

```
Profile
 ├── Buyer
 ├── Seller
 ├── Service Provider
 └── Rider
       ├── photo · National ID / KYC status · driving licence
       ├── insurance · emergency contact
       ├── preferred zones · availability preferences · payout details
       └── My Vehicles
```

### Not a rider yet

```
🚚 Become a Rider
Earn money delivering orders on SOKONI.
[ Apply to Become a Rider ]
```

Application status: `Draft → Submitted → Under Review → Approved → Rejected`.

### Approved

```
🚚 Rider     Status ✓ Approved
[ Open Rider Dashboard ]
```

## Rule 4 — My Vehicles

Multiple approved vehicles per rider; the active one is chosen **before going online**, from the
dashboard's switcher. The list itself is managed under Profile, not on the operations screen.

```
Motorbike   ✓ Active
Van           Approved
Pickup        Pending Inspection
+ Add Vehicle
```

Vehicle vocabulary already exists in `delivery-hub.js` (`VEHICLES`: boda, bicycle, car, pickup, van,
truck, ref, flatbed) — **reuse it, do not define a second list.**

## Rule 5 — The buyer session is never disturbed

Entering or leaving Delivery Hub must not re-authenticate. Cart, wallet, notifications and messages
survive the switch.

## Rule 6 — Shared spine

Workspaces (Marketplace · Services · Delivery Hub · Orders · Wallet · Analytics) each own their data
and **share** Auth, Wallet, Notifications, Messages and Identity.

## Acceptance criteria

1. "Apply to Become a Rider" appears only for non-riders.
2. Approved riders see "Open Rider Dashboard" instead.
3. Rider profile editing exists **only** under Profile → Rider.
4. Delivery Hub contains operational tools only.
5. All four roles coexist on one account with one wallet, notifications and identity.
6. Switching Buyer ↔ Rider requires no sign-in and loses no session state.
7. Nearby fleet counts are shown (riders online, vans/cars/bikes available).

---

## Before writing code — three things to verify, not assume

ADR-008. This session had the expected answer inverted repeatedly (Applications had data, Rides was
never built, landlord used buildings not listings, driver photos were in localStorage not Firestore).

**1. `profile.html` already contains 36 rider/driver references.** If a Rider section already exists,
Rule 3 is largely a **removal** job — delete the header from `driver.html` and point at what is built
— not a new feature. Survey first; the Platform Constitution says extend, do not rebuild.

**2. `driver.html` has 4 hits on session-mutating patterns** (`signOut`, `currentUser`, direct
`sokoniUser` writes). Whether entering Delivery Hub *already* disturbs the buyer session is
measurable. That answer decides whether Rule 5 is a fix or a confirmation.

**3. Rule 3's photo / licence / insurance fields collide with an open defect.** Those are exactly the
fields written to `localStorage` today (`driver.html:883`) — per-device, so an admin on another device
reviews an application with **no verification photos**. See [[Image Pipeline Survey]]. Building the
Rider Profile UI on that storage extends the defect.

**BLOCKED on a founder decision:** identity-document retention — delete on rejection, retain how long
on approval? Required before the Rider Profile can be built correctly under ODPC.

## Sequencing

Do **not** start before the landlord suite reaches 26/26. Three authorization defects are open, and a
new role surface touching wallet and identity should not be built while the authorization model has
proven holes.
