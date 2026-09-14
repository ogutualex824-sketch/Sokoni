# D1 — Driver Identity, Licence & Vehicle Verification

**Status: DESIGN. Nothing implemented. No deployment.**
Supersedes the assumption that SOKONI stores driver documents — [[DELIVERY_D0_CENSUS]] proved it
does not, and that is the defect.

Related: [[project_delivery_rider_selfmint_live]] (DL-01/DL-02),
[[project_application_lifecycle]], [[project_store_identity_gate]].

---

## 1. What is actually broken

    driver.html:887-912
      ID photo + DL photo  ->  FileReader.readAsDataURL  ->  base64
                           ->  localStorage['sokoniDrivers']      stays on the applicant's device
                           X   never sent to any server

    Firestore application payload:
      { name, phone, category, location, type, hub, vehicle, plate, status, date }

Verified against production: **all 10 application documents carry no `nationalId`, no `dlNumber`,
no `dlExpiry`.** `projectDriver` reads exactly those fields to build `driverVerification`, so
`documentsComplete` is false for structural reasons — there has never been anything on the server
to verify. The single production driver being `approved:true` with
`driverVerification.status:'incomplete'` is not a reviewer lapse; it is the only outcome this
intake can produce.

**Consequence for DL-02:** the eligibility gate correctly refuses that driver. Deploying it before
D1 would impose a control with no legitimate path to satisfy it. Ordering is therefore:

    D1 intake -> D1 verification -> existing drivers legitimately verified
      -> DL-02 eligibility gate -> DL-01 rules -> combined certification

**The migration is one person.** Production holds 1 `drivers` row and 2 approved driver
applications. Re-verifying that population is a manual afternoon, which is why this design has
**no grandfathering clause**: an exemption flag would outlive the handful of records it was
written for, and a permanent bypass of a verification gate is worth more than the effort it saves.

---

## 2. Target chain

    APPLICATION -> capture -> secure upload -> verification -> extract identifiers
      -> driverVerification.documentsComplete = true -> ADMIN APPROVAL
      -> drivers (operationally eligible) -> DELIVERY HUB

The document images are **temporary verification material**, never SOKONI identity records. What
persists is the extracted, verified identifiers plus the provenance of who verified them.

---

## 3. RULINGS — decided by the owner 2026-09-13

| # | Decision | Ruling |
|---|---|---|
| **V-1** | vehicles ownership | **Converge, reuse `shopId` only** — every vehicle is shop-owned; an owner-operator gets a shop record. No `ownerType` discriminator. |
| **V-2** | canonical vocabulary | **Implemented.** `bike` = motorcycle; `pickup` is its OWN class; unknown is not dispatchable. |
| **P-1** | image retention | **~30 days after the verification decision**, then disposed by the sweep job. |
| **P-2** | extraction method | **Automated extraction + mandatory human review** before `documentsComplete` is set. |

### V-1 carries a consequence that is not yet designed

"Reuse `shopId` only" means **every approved rider must have a Business record**, because that is
what owns their vehicle. That is a real dependency, not a detail:

- it intersects the standing **Business ≠ Buyer** rule and the `businessWallets/{merchantId}`
  model — a rider is now both a person and a one-person business;
- it needs a **driver → business provisioning step** that does not exist today (`projectDriver`
  writes `drivers`, `rideDrivers` and `driverVerification`, and no business);
- the open **`businesses/{uid}` directory-row collision** ([[project_store_identity_gate]]) is on
  the same collection, so rider provisioning must not create more uid-keyed rows.

Nothing here contradicts the ruling — it is implementable — but the provisioning step is
unspecified work that D1 implementation now depends on, and it should be sized before it starts.

### P-1 / P-2 as implemented obligations

P-1 is a **configured** TTL, never a literal in code, so a later policy change is a config edit
and not a redeploy. P-2's automated extractor is a **proposer, not an authority**: it may populate
candidate values, and `documentsComplete` is set only after a human confirms. That keeps the
verification provenance a person, which is what an audit will ask for.

---

## 4. Identity and licence records

`driverVerification/{uid}` — **server-write only, admin+self read** (already the served rule).

    identity
      nationalIdNumber          required
      idSerialNumber            required
      verifiedNames             as they appear on the document
      identityStatus            unsubmitted | pending | verified | rejected
      identityVerifiedAt, identityVerifiedBy, identityReference

    licence
      licenceNumber             required
      licenceSerialNumber       required
      licenceCategory           required — see §5, it is an eligibility input
      licenceExpiry             required
      licenceStatus             unsubmitted | pending | verified | rejected | expired
      licenceVerifiedAt, licenceVerifiedBy, licenceReference

    documentsComplete           derived, NEVER client-supplied
    provenance                  sourceApplicationId, intakeVersion, decidedBy, decidedAt

`documentsComplete` is **derived** from identityStatus and licenceStatus both being `verified`
and the licence not expired. It must not be writable as an independent field — a derived flag that
can also be set directly is two authorities disagreeing, which is the defect class this track keeps
finding (three occurrences: HC-01, phoneVerified, DL-01).

**Licence expiry is an eligibility input, not a record.** `evaluate()` in
`functions/rider-eligibility.js` must refuse an expired licence at dispatch time, or a driver
verified once stays eligible forever.

---

## 5. Vehicle model — PERSON separated from VEHICLE

Today: `drivers.vehicleType` + `drivers.plate` — one vehicle, welded to the identity record.

### 5.0 A `vehicles` collection ALREADY EXISTS — and it is not driver-owned

`functions/logistics-plus.js:96-107` implements `vehicles/{vehicleId}` owned by **`shopId`**, a
merchant FLEET model, with `assignedDriverId` as a field. **Zero production rows** — it is built
but unreleased.

So the obvious design — "create `vehicles/{vehicleId}` keyed on `driverId`" — would put **two
different ownership authorities on one collection name**. That is the defect pattern this track
keeps finding (`businesses/{uid}` directory row, three `wallets` blocks, two Stories models), and
it is far cheaper to avoid now than to reconcile later, while the row count is zero.

**DECISION REQUIRED — V-1, owner call:**

| option | shape | cost |
|---|---|---|
| **Converge** | one `vehicles` collection, explicit `ownerType: 'shop' \| 'driver'` + `ownerId`; `assignedDriverId` keeps meaning "who operates it" in both cases | one model to secure; rules must branch on ownerType |
| **Separate** | leave fleet `vehicles` alone; driver vehicles live elsewhere | two models, two rule sets, and the same question returns when a SACCO owns the bike its rider drives |

Convergence looks right — an owner-operator is a fleet of one, and `assignedDriverId` already
expresses the operating relationship — but it changes a collection another track owns, so it is
not an engineering-gate decision.

### 5.1 Target record

`vehicles/{vehicleId}`, one driver may operate several, each verified on its own merits:

    vehicleId, driverId
    vehicleType, vehicleCategory
    registrationNumber, chassisOrVin
    make, model, year, colour
    capacityKg, payloadCapacityKg
    vehicleStatus          active | inactive | impounded | retired
    verificationStatus     unsubmitted | pending | verified | rejected
    insurance { provider, policyNumber, expiry, status }
    inspection { reference, expiry, status }
    verifiedAt, verifiedBy

Dispatch then selects **(eligible driver x verified vehicle)**, not a driver alone. A driver with
no verified vehicle is not dispatchable — which also means retiring a vehicle removes capability
without touching the person's identity record.

### 5.2 THREE vehicle vocabularies exist, and they collide

    application-lifecycle VEHICLE_MAP ->  moto  bicycle ebike tuktuk  car van truck
    sokoni-dispatch VEHICLE_CAPACITY  ->  moto  bicycle ebike tuktuk  car van truck
    logistics-plus _VEHICLE_TYPES     ->  bike  bicycle  --   tuk_tuk car van truck

Two are aligned; the third is not. The spelling drift (`tuktuk` vs `tuk_tuk`, missing `ebike`) is
ordinary. **The `bike` token is not:**

    VEHICLE_MAP.bike   = 'bicycle'    ->  8 kg capacity
    logistics-plus     'bike'          ->  the motorbike class

The same string means *bicycle* on one side and *motorbike* on the other. They never meet today
because dispatch reads `vehicleType` off `drivers`, not off `vehicles` — but §5.0 convergence is
exactly what would make them meet, and a class mismatch here decides what payload a rider is
offered.

**Prerequisite to any convergence: one canonical vehicle vocabulary, defined once and imported.**
Not three tables that agree by inspection — the commission engine went through this and the rule
that came out of it was a single source with a guard against a second table appearing.

### 5.3 Classification MUST fail closed

Current behaviour, and why it is a production defect:

    normVehicle('suv')      -> 'moto'      (unmapped -> default)
    normVehicle('tractor')  -> 'moto'
    normVehicle('trailer')  -> 'moto'
    'pickup'                -> 'van'       (collapsed alias)
    'lorry'                 -> 'truck'     (collapsed alias)

An unmapped vehicle silently becomes a motorcycle. It is conservative for payload — `moto` caps at
15 kg — so the immediate risk is misassignment rather than overload. That is luck, not design: the
default is a fixed class, so it is only safe while `moto` happens to be small. It is the same
silent-downgrade shape as the subscription alias fallback.

**Required:**

    KNOWN canonical classes   -> explicit capability, licence requirement, pricing band
    KNOWN aliases             -> canonicalised EXPLICITLY (pickup and lorry may map, but the
                                 mapping must be a decision, not a fallthrough)
    UNKNOWN                   -> NOT dispatch eligible; refused with an explicit reason

Whether `pickup` remains an alias of `van` or becomes its own class is a **commercial** call —
it matters only if capacity, licence category or pricing differ. Engineering should surface the
question, not answer it by leaving the alias in place.

Classes to model: motorcycle, e-bike, bicycle, tuk-tuk, car, SUV, van, pickup, truck, lorry,
trailer combination, tractor. Adding a class must not require touching dispatch.

---

## 6. Geography

`city` / `area` / `zone` are free strings today, invented per module. Retain for compatibility;
add a canonical hierarchy:

    Country -> County -> City/Town -> Hub -> Service Area

Live GPS stays an **operational signal**, never identity — a rider's coordinates say where they
are, not who they are or what they may do. This is the same separation DL-01 established between
presence and authority, applied to place.

---

## 7. Memberships (SACCO and equivalents)

    memberships[] { organization, membershipNumber, status, verifiedAt, verifiedBy }

Structured attributes, not image storage. **Only fields a legal or operational requirement
establishes as necessary** — a membership number retained without a purpose is a liability, and
this record is already sensitive-by-default.

---

## 8. Image handling — the part that must be built to be disposed

Because nothing reaches the server today, the upload path is new work and disposal must be
designed in from the first commit rather than retrofitted.

    client -> compress/optimise -> Firebase Storage under a RESTRICTED verification prefix
           -> server-side verification (human or automated, per P-2)
           -> identifiers extracted to driverVerification
           -> image DISPOSED per P-1

`storage.rules` exists (12 KB, wired in `firebase.json`) but the driver intake does not use it.
Requirements:

- The verification prefix is **never client-readable**; an applicant may write their own upload
  and nothing more.
- Disposal is a **server job with an audit record** — an image deleted with no evidence it was
  deleted is indistinguishable from one that was missed.
- **The profile photograph is a separate object with a separate lifetime.** It is operational
  (riders are identified at handover), not verification material, and must not be swept by the
  identity-document TTL. It needs its own retention purpose stated.

---

## 9. Certification statement this design supports

> SOKONI temporarily processes submitted verification documents, extracts and verifies the
> required identity, licence, vehicle and operational information, records the verification result
> and provenance, and disposes of the original identity-document images according to the defined
> retention policy.

**Not claimable today in either direction**: SOKONI neither stores the documents nor extracts the
identifiers. The claim becomes provable when §4, §5 and §8 are implemented and the disposal job is
evidenced by its own audit record.

---

## 10. Open, tracked elsewhere

DL-03 projection convergence (2 approved applications, 1 projected identity) ·
`deliveryFees` admin-client write · `wallets` three UNIONing blocks · `orders` vs
`packageRequests` two-rail split · `navigation.js` selecting from `riderLocations`, a collection
absent from production.
