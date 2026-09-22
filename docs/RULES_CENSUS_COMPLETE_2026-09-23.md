# Rules Census — complete: the 13, the 23, and what each actually grants

**Date:** 2026-09-23 · **Tree:** `05c1f4e` · **Read-only. No ruleset deployed, no rules file edited.**
Completes [[RULES_ADOPTION_QUEUE_2026-09-23]] (`274cab5`).
Reference side is **this branch**; served is `6c67a34d` (see that document, §2b).

---

## 1 · A correction to my own method

The earlier writer census searched client code and concluded "no writer found" for 12 of the 13.
Reading the actual rule text shows why that was the wrong instrument:

**Eleven of the thirteen are READ-ONLY grants.** They carry `allow write: if false` or no write
clause at all. The data they govern is written by **Cloud Functions, which bypass rules
entirely** — so a client-side writer census was always going to find nothing, by design.

That does not change the dispositions, because the functions tree was searched too and also
contains no writer. But it changes what the absence *means*: these blocks exist to let clients
**read** server-produced data, not to authorise client writes.

**Consequence:** dropping any of the eleven cannot open a security hole. It can only remove
read access — a broken screen, never a leak.

## 2 · What the 13 actually grant

| path | grant | scope |
|---|---|---|
| `userLocations/{uid}/places/{placeId}` | **read + create/update/delete** | owner only, with `label is string`, `lat`/`lng` numeric validation |
| `storeProvisioning/{uid}` | **read + write** | admin only |
| `courierQuotes/{quoteId}` | read | admin, or `resource.data.uid == auth.uid` |
| `deliveryJobs/{deliveryId}` | read (`write:false`) | admin, `merchantUid`, or `assignedRiderUid` |
| `deliveryDispatchMessages/{messageId}` | read (`write:false`) | admin, or `auth.uid in participants` |
| `riderRatings/{ratingId}` | read (`write:false`) | admin, `riderUid`, or `raterUid` |
| `landlordProfiles/{uid}` | read | admin or self |
| `tenantProfiles/{uid}` | read | admin or self |
| `settlementHolds/{orderId}` | read | **admin only** |
| `storyAllocations/{allocationId}` | read | **admin only** |
| `resolutions/{resolutionId}` | read (`write:false`) | **admin only** |
| `productReportSummaries/{productId}` | read (`write:false`) | **admin only** |
| `merchantStories/{storyId}` | read | **any authenticated user** |

**One security observation.** `merchantStories` is the broadest grant of the thirteen —
`allow read: if isAuthed()` makes every story readable by any signed-in account. The collection
is empty today, so nothing is exposed; but if it is adopted, that breadth is the thing to
review, not the fact of the block existing.

## 3 · The 23 source-only blocks — no functional impact

Present locally, never served, so governed by default-deny in production. Four hold data:

| collection | production | accessed by | client reader? |
|---|---|---|---|
| `analytics` | HAS DATA | `functions/async-job-handlers.js:557` (write) | **none** |
| `productAnalytics` | HAS DATA | `functions/analytics-rollup.js:125` (read) | **none** |
| `categoryAnalytics` | HAS DATA | `functions/analytics-rollup.js:126` (read) | **none** |
| `shopTillCounters` | HAS DATA | `functions/sokoni-till.js:106` | **none** |

All four are touched **only** by the Admin SDK inside Cloud Functions, which bypasses rules.
The `super-admin.html` hits are `platformConfig/analytics` — a different path.

**So their absence from the served ruleset changes nothing.** The remaining 19 are empty and
have no client accessor either.

**The 23 are not a defect and need no deployment.** They are rules written for collections that
no client touches.

### 3.1 · A latent defect found while reading them

`firestore.rules:1556`:

```
match /analytics/{doc} {
  allow read:  if isAdmin() || (isAuthed() && request.auth.uid == uid);
```

The wildcard binds **`doc`**, not `uid`. `uid` is undefined in that scope, so the second clause
errors and evaluates false — the rule reads as "admin or owner" and behaves as "admin only".

Exactly the failure the standing rule describes: *a broken expression reads as a working guard.*
It is currently harmless — the block is not served and no client reads the collection — but it
must not be adopted in this state.

## 4 · `storeProvisioning` — classified as far as the evidence allows

| | |
|---|---|
| rule | `allow read, write: if isAdmin()` — admin only, no client path |
| documents | 2 — `SELLER_A`, `SELLER_A_uid_7f3` |
| created | 2026-09-07, ~70 min apart, **never updated since** |
| ids | not Firebase uids (28 chars); `SELLER_A` is a literal placeholder |
| writer | none in this repo — not in client code, not in `functions/`, not in `scripts/` |
| reader | none in this repo |

Every indicator points to test fixtures. **It still cannot be called one**, because the rule is
admin-only and admin writes bypass rules — meaning the creator could be a console action, a
one-off script, or a function from another lineage, none of which this repository records.

**DEFER — needs owner.** The question for whoever owns provisioning is narrow: *did you create
`SELLER_A` on 7 September, and does anything still read it?*

## 5 · Final disposition

### Served-only (13)

| disposition | count | which |
|---|---|---|
| **ADOPT** | 1 | `userLocations` — active shipped writer, zero documents |
| **DEFER — needs owner** | 12 | 11 read-only grants + `storeProvisioning` |
| **RETIRE** | 0 | — |

### Source-only (23)

| disposition | count | basis |
|---|---|---|
| **NO ACTION** | 23 | no client accessor; Admin SDK bypasses rules, so absence from served has no effect |
| *flagged* | 1 | `analytics` carries the undefined-`uid` defect — fix before any adoption |

## 6 · What this means for the deployment wiring

The wiring problem (`firebase.json` → the 105.7% source, never the build) is **still not worth
fixing yet**, and this census strengthens that: the 23 source-only blocks turn out to need no
deployment at all, so the pressure to make the source deployable is lower than it appeared.

The only block with a demonstrated need is `userLocations`, and that is one adoption — not a
reason to re-plumb the deploy path.

## 7 · Not done

- The 12 DEFER blocks have been **read and classified**, but their owners are not identified.
- `storeProvisioning`'s creator is **unknown**.
- No emulator authorization matrix was run against any proposed change.
- No rules file edited; no ruleset deployed.
