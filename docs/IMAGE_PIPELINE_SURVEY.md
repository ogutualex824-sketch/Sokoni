# Image pipeline survey

**Date:** 2026-08-02 · **Status:** survey complete. **No implementation.**
**Finding: the READ path is converged. The WRITE path is not. The helper is absorbing a defect, not fixing one.**

Related: [[SOKONI_IMAGE_API]] · [[Publication Contract v1]] · [[ADR-009]] · [[Canonical Data Model]]

---

## Measured, not assumed

| measurement | count |
|---|---|
| files using the shared helper (`SokoniImage` / `renderProductImage`) | **5** |
| files doing `readAsDataURL` directly | **19** |
| files uploading to Firebase Storage | **6** |
| distinct image field names written across the codebase | **10+** |

Field frequency: `image:` 383 · `images:` 87 · `photoURL:` 29 · `thumbnail:` 26 · `photos:` 22 ·
`imageUrl:` 22 · `thumb:` 18 · `logoUrl:` 13 · `coverImage:` 8

## The actual shape of the problem

`sokoni-image.js` `pick()` reads **nine field names in priority order**, prefers a real URL, and falls
back to base64 only when no URL exists. That function is well built and it works.

**But it exists because the write path produces nine different field names.** `pick()` is a read-side
absorber for a write-side inconsistency — the precise inversion the Publication Contract warns about:

> *fix the WRITE path, not the read path*

Every new surface that invents a tenth field name is invisible until something fails to render, at
which point the fix is "add it to `pick()`" — which makes the divergence permanent and cheap to
extend. The helper's tolerance is what removes the pressure to converge.

## The more serious finding: base64 into Firestore

**19 files call `readAsDataURL`; only 6 upload to Storage.** A data URL stored on a Firestore document
carries costs that do not show up until scale:

- Firestore's hard **1 MiB document limit** — a single photo can approach it, and the write fails at
  the moment a merchant adds their best product image.
- The image is re-read on **every** document read, including list queries that display a thumbnail.
  A 200-product feed pays for 200 full-size images.
- It cannot be resized, cached at a CDN, or served in a modern format.
- It cannot be deleted independently of the record.

This is the same class of defect as the homepage OOM already fixed by capping the product feed: the
cost is invisible in development with three products and severe in production with thousands.

## What must NOT be done about it

**Do not migrate images as a background sweep.** Rewriting live merchant records to move base64 into
Storage touches customer-visible product data with no rollback if a URL is wrong — and this survey has
not established which of the 19 writers produce records that are still read.

## Recommended sequence, when implementation resumes

1. **Freeze the vocabulary.** One canonical write field (`images: [{url, width, height}]`) in the
   canonical data model. `pick()` stays as the compatibility reader — permanently, for old records.
2. **Guard the write path.** A ratchet counting `readAsDataURL` sites (currently **19**) that may fall
   and never rise, mirroring `audit-admin-localstorage.js`.
3. **One shared uploader.** `sokoni-upload.js` already exists; route the 19 through it rather than
   writing a new one.
4. **Only then** consider migrating existing records, per-merchant, with verification.

**Not scheduled. Verification of the financial, inventory and merchant flows takes precedence** — this
survey exists so the decision is informed when that work completes, not to start it now.

---

## Finding — driver verification photos have no persistence path (`driver.html:883`)

**Measured 2026-08-02. Not a Firestore base64 defect — worse.**

The registration flow reads the national ID photo and driving licence photo as data URLs, then:

```js
drivers.push(driver);                                    // includes idPhoto, dlPhoto
localStorage.setItem("sokoniDrivers", JSON.stringify(drivers));
/* Submit to admin applications queue in Firestore (no photos — too large) */
window.SokoniDB.saveApplication({ /* …no photos… */ });
```

The comment is honest and the omission is deliberate. The consequence is not:

1. **The application is unreviewable.** `localStorage` is per-origin *and per-device*. An admin opening
   the driver application on any other device sees an application with **no verification photos at
   all** — the two documents the review exists to check.
2. **It silently fails at ~5–10 MB.** Two base64 photos per driver exhausts the quota after a handful
   of registrations, and `setItem` then throws where nothing catches it.
3. **PII at rest in the browser.** National ID and licence images sit unencrypted in `localStorage`
   with no expiry and no deletion path — an ODPC concern, not merely an engineering one.

**This is not a conversion.** Routing these two reads through `sokoni-upload.js` is necessary but not
sufficient: the application record needs `idPhotoUrl` / `dlPhotoUrl` fields, Storage rules restricting
reads to the applicant and admins, and a decision about retention after approval or rejection.

**Recommended sequence** (not started — needs a design decision):
1. Upload both photos to Storage under `driver-applications/{applicationId}/`.
2. Store the two URLs on the Firestore application; never the bytes.
3. Storage rules: write by the applicant, read by the applicant and admin claims only.
4. Delete on rejection; retain per policy on approval.
5. Remove `idPhoto`/`dlPhoto` from the `localStorage` object — that also lowers the base64 ratchet.

Relates to the 45-key business-localStorage backlog: this is the same defect class, but carrying
identity documents rather than preferences.
