# Properties — data source investigation

**Date:** 2026-08-01 · **Verdict:** **B — Properties requires a Firestore migration**
**Status:** investigation only. Nothing was implemented.

Related: [[Admin Console Integrity]] · [[Publication Contract]] · [[Registry Projection Traps]]

---

## Verdict in one line

The canonical Firestore collections **already exist, already have security rules, and are already
written and read by three other pages**. The admin Properties pane is the only consumer still reading
`localStorage`, so it can never see anything a real host or guest creates.

This is *not* the Users situation. There is no missing data source to design — there is a working one
the admin console was never connected to.

---

## 1. Who writes each collection, and when?

### `bnbListings` — canonical, wired, **empty in production**

| writer | file | trigger |
|---|---|---|
| host creates a listing | `bnb-hub.html:831` | `setDoc(doc(db,'bnbListings',…), {createdAt: serverTimestamp()})` |
| host edits a listing | `bnb-manage.html:543` | `setDoc(…, {hostUid, updatedAt})` |
| host deletes | `bnb-manage.html:549` | `deleteDoc(…)` |

| reader | file |
|---|---|
| public BnB page, **realtime** | `bnb.html:413` — `onSnapshot(query(collection(db,'bnbListings'), orderBy('createdAt','desc')))` |
| host's own listings | `bnb-manage.html:570` — `where('hostUid','==',uid)` |
| search index | `functions/algolia-sync.js:145` — `_makeTriggers('bnbListings')` |
| backfill | `functions/scripts/algolia-backfill.js:64` → index `sokoni_properties` |

Rules: `firestore.rules:1153`.

### `bnbBookings` — canonical, written on every real booking

`bnb.html:421` → `window._saveBnBBookingFS()` → `addDoc(collection(db,'bnbBookings'), {…, uid, createdAt: serverTimestamp()})`,
called from the booking `_finalise()` at `bnb.html:251`. Rules: `firestore.rules:1165`.

**Note the swallowed error:** the `addDoc` is wrapped in `try { … } catch(e) {}` with an empty body. A
rules rejection or a network failure loses the booking silently while `localStorage` still shows it as
`confirmed`. Worth fixing on its own merits, separately.

### `landlordData` — canonical, per-user document

`landlord.html:873` → `setDoc(doc(db,'landlordData',uid), {uid, properties:[…], updatedAt}, {merge:true})`.
Rules: `firestore.rules:1493`. Note the shape: **one document per landlord holding an array**, not a
collection of property documents.

---

## 2. What the admin console actually reads

**All 18 references in `admin.html` are to the local `D.*` arrays. There is not one Firestore read for
properties.**

```
admin.html:2887   D.bnbListings  = ls('sokoniBnBListings')
admin.html:2888   D.bnbBookings  = ls('sokoniBnBBookings')
admin.html:2889   D.landlordProps= ls('sokoniLandlordProperties')
```

`localStorage` is per-origin **and per-device**. A guest booking on their phone writes to *their*
browser. The administrator's browser never receives it. The only thing that reliably populates
`sokoniBnBListings` on an admin's machine is `demo-seed.js:1202` — **demo data**.

### The write path is worse than the read path

```js
function approveProp(i){ D.bnbListings[i].status='active';
  localStorage.setItem('sokoniBnBListings', …); }
function rejectProp(i){  D.bnbListings[i].status='rejected';
  localStorage.setItem('sokoniBnBListings', …); }
```

**Approving or rejecting a BnB listing writes only to the administrator's own browser.** No host, no
guest and no other admin ever sees the decision. This is the same defect class as the Orders
`flagDispute` lost-write closed earlier today, and it is still live.

---

## 3. Data flow — actual vs intended

```
ACTUAL (today)

  host (bnb-hub / bnb-manage) ──setDoc──▶ Firestore bnbListings ──▶ bnb.html (realtime)
                                                  │                └▶ Algolia sokoni_properties
                                                  ✗ nothing reads this into admin

  guest (bnb.html) ──addDoc──▶ Firestore bnbBookings   [errors swallowed]
                    └─setItem─▶ localStorage (that device only)

  landlord.html ──setDoc──▶ Firestore landlordData/{uid}
                 └─setItem─▶ localStorage (that device only)

  admin.html ──reads──▶ localStorage sokoniBnB* ──▶ Properties pane
                            ▲
                            └── populated in practice only by demo-seed.js
  admin approve/reject ──writes──▶ localStorage (that admin's browser, nowhere else)


INTENDED

  host / guest / landlord ──▶ Firestore ──▶ admin.html (realtime listener)
                                     └────▶ bnb.html, Algolia
  admin decision ──▶ Firestore ──▶ everyone
```

---

## 4. Answers to the eight questions

| # | question | `bnbListings` | `bnbBookings` | `landlordProps` |
|---|---|---|---|---|
| 1 | Who writes it? | bnb-hub, bnb-manage (FS); admin approve/reject (localStorage only) | bnb.html (both) | landlord.html (both) |
| 2 | When? | host creates/edits | guest completes a booking | landlord saves |
| 3 | Realtime? | **yes** — `bnb.html` has `onSnapshot`; **admin does not** | no listener anywhere | no listener anywhere |
| 4 | localStorage authoritative? | **for the admin pane, yes** — and it must not be | same | same |
| 5 | Firestore authoritative? | yes, everywhere except admin | yes | yes |
| 6 | Dead code? | no | no | no |
| 7 | Stale cache? | **worse — a private cache**, per-device, never reconciled | same | same |
| 8 | Does production populate it? | Firestore: **0 docs**. localStorage: demo seed only | Firestore: **0 docs** | Firestore: **0 docs** |

**All three Firestore collections are empty in production** — nobody has listed or booked a BnB yet.
So the admin pane is not currently *hiding* real data. It would hide the first real listing the moment
one is created, and it already applies decisions that go nowhere.

`sokoni-sync.js` — a localStorage→Firestore bridge that lists exactly these keys — is **loaded by zero
pages**. The intended sync was written and never wired in. That is the historical explanation for the
split.

---

## 5. Canonical source

| data | canonical collection | shape |
|---|---|---|
| BnB listings | **`bnbListings`** | one document per listing, `hostUid`, `createdAt` |
| BnB bookings | **`bnbBookings`** | one document per booking, `uid`, `listingId`, `createdAt` |
| Landlord properties | **`landlordData/{uid}`** | one doc per landlord, `properties` array |

No new collection is needed. No model change is required for listings or bookings.

`landlordData` is the one shape that does not fit an admin list cleanly — it is per-landlord documents
containing arrays, so an admin view must flatten across documents. **That is a model question**, and
per the rules it is documented here rather than solved in a renderer.

---

## 6. Dead paths to remove

1. `D.bnbListings` / `D.bnbBookings` / `D.landlordProps` boot reads from `localStorage`.
2. `approveProp` / `rejectProp` localStorage writes — replace with a Firestore status write.
3. `deleteItem(D.bnbBookings, …, 'sokoniBnBBookings')` row action — local-only, same class.
4. `sokoni-sync.js` — loaded by no page. Either wire it deliberately or delete it; leaving a dead
   sync layer implies a guarantee that does not exist.

---

## 7. Safe migration plan (not implemented)

One commit per step, each independently verifiable.

**Step 1 — read.** Add `SokoniDB.listenBnbListings()` and `listenBnbBookings()` following
`listenUsers()`: no server-side `orderBy` unless `createdAt` coverage is verified first, an `onError`
callback, and loading / empty / error / retry states. Point the Properties renderer at them. No write
path changes. *Verifiable: the pane shows Firestore content and states resolve.*

**Step 2 — write.** `approveProp` / `rejectProp` update `bnbListings/{id}.status` in Firestore. Ideally
behind a callable so the decision is authorised and audited like `applicationDecide`. *Verifiable: a
decision survives a reload and is visible to the host.*

**Step 3 — landlord.** Decide the model first: flatten `landlordData/{uid}.properties` for the admin
view, or promote properties to their own collection. **Needs approval — this is a model change.**

**Step 4 — cleanup.** Remove the localStorage reads/writes and resolve `sokoni-sync.js`.

**Separately, on its own merits:** `bnb.html:421` swallows its `addDoc` error. A booking can fail to
persist while the guest is told it is confirmed.

### Risks

- Steps 1–2 are low risk: the collections are empty, so there is no data to lose and nothing to
  reconcile. **This is the cheapest possible moment to do it.**
- Any device holding demo `sokoniBnB*` data will see the pane change from demo listings to empty. That
  is correct, and worth stating so it is not reported as a regression.
- Step 3 must not be started before the model decision.

---

## 8. Conclusion

**Properties is NOT complete.** The pane is now singular and correctly wired *internally* — every
container resolves, the header matches the renderer — but it reads a private per-device cache and
writes decisions nowhere.

Because the canonical collections already exist and are used everywhere else, this is a **connection**
job, not a design job. Steps 1 and 2 close it. Step 3 needs a decision.
