# Durable print intents — one sale, one receipt

**Status:** BUILT, not deployed · **Proof:** 83/0 executed + 11/11 sabotages caught · **Date:** 2026-08-26

Related: [[PWA_PRINTER_HOST_PLAN]] · [[POSDEVICES_SELLERID_DEAD_DISJUNCT]] ·
[[project_receipt_contract]] · [[reference_printer_reconnect_architecture]]

```
PENDING ──claim──► CLAIMED ──begin──► PRINTING ──ok──► PRINTED
                      │                   │
                      └───────fail────────┴──► FAILED ──retry──► PENDING
```

The property is not "the state machine works". It is **one sale never becomes two physical
receipts** — across a reload, a duplicate realtime event, a focus event, a reconnect, a stale
claim, a retry, or two desktops racing.

---

## The collision this had to avoid

`posPrintJobs` **already holds something else.** `functions/index.js:6190` writes an audit record
there for the LAN/TCP printer relay — `{uid, shopId, host, port, bytes, status:'pending'}` — and it
writes it *after* the bytes are already on their way to the printer.

A desktop naively listening for "pending jobs" in that collection would reprint **every LAN relay
record in production**. That is the one-sale-two-receipts failure arriving through the back door,
and it would have looked like a working feature.

Two **independent** discriminators keep them apart; either alone is sufficient:

| | intents | legacy relay log |
|---|---|---|
| `kind` | `'printIntent'` | *absent* — a Firestore equality filter excludes documents missing the field |
| `status` | `PENDING` (uppercase) | `pending` (lowercase) |
| doc id | `{shopId}__{receiptId}`, deterministic | random `.add()` |

Belt and braces deliberately: one shared discriminator is a single refactor away from silently
matching legacy rows. Legacy records stay readable and are never migrated or rewritten.

## Why it reuses the collection at all

The compiled ruleset has **~510 bytes free** of 256,000. A new collection needs a new `match`
block. `posPrintJobs`'s existing rule is already exactly right —

```
allow read:  isAdmin() || resource.data.uid == auth.uid || ownsBiz(resource.data.shopId)
allow create, update, delete: if false;
```

— CF-only writes, shop-scoped reads. Reuse costs **zero rules bytes and zero rules risk**.
`firestore.rules` is asserted byte-identical to HEAD by the suite itself.

## The claim

Server transaction, never a client write. Atomically verifies: the job is `PENDING` (or its lease
expired) · the device **exists** and is `printerHost: true` · that device's `merchantId` **equals**
the job's `shopId` · the caller may act for that shop. Only then records
`claimedBy / claimedAt / claimToken / leaseExpiresAt`.

`claimToken` is a **fencing token**. Every later transition must present it, and a takeover mints a
new one — permanently fencing out a host that wakes from a long pause.

## The lease is a recovery mechanism, not a guarantee — stated plainly

If a host claims and dies, the job must not be stuck forever, so the lease (90 s) expires and
another host may take it. **A host that is merely slow can therefore be taken over and print
twice.** That risk is bounded three ways: the lease is far above a real P58E print (seconds);
takeover of a `PRINTING` job never re-prints silently, it needs an explicit `FAILED` then an
explicit retry; and `mayPrint` — the only signal the desktop acts on — is **false** for a job
already `PRINTING`, even to its own claimant, because after a crash mid-print we cannot know
whether paper came out.

What *is* guaranteed: at most one claimant at a time, and a fenced-out claimant can never report
`PRINTED`.

## The focus → drain path

`drainQueue()` is reachable from window focus, pointerdown, visibilitychange, `online`, a printer
reconnect, and a backoff timer. **Every one of those fires on an ordinary reload**, and none is a
decision to print. For a locally-enqueued job that is fine. For durable work it is not — the queue
lives in one browser's localStorage and cannot see a second desktop.

`_gateLocalDrain()` blocks any job carrying `intentId` without a server-granted claim. It is
**blocked, not failed**: the job keeps its attempts and stays pending. No such job exists yet —
which is exactly why the gate goes in before anything can rely on the gap.

## No payload in Firestore

The intent references `posReceipts/{receiptId}`; it carries no ESC/POS bytes. The desktop renders
through `SokoniReceiptDoc` like every other surface. Embedding bytes would create a second receipt
source that could disagree with the canonical one, and put a 64 KB blob in a document written
several times per sale.

## Converged, and what was not

`shop-access.js` is now the single answer to "who runs this shop", used by `registerPrinterHost`
and both intent paths. `registerPrinterHost`'s 39/0 suite still passes unchanged against the shared
helper, which is the equivalence proof.

**`registerDevice` still carries its own inline copy.** It is live and this is an RC; converging it
belongs in its own slice with its own proof rather than riding along here. Recorded, not done
quietly.

## Not built yet

The realtime bridge. Nothing currently *creates* an intent from a phone sale, and nothing listens.
`createPrintIntent` is callable but unwired by design — the lifecycle is proven before anything
depends on it.

## Deployment

Three new callables (`createPrintIntent`, `claimPrintJob`, `advancePrintJob`), re-exported by name
in `functions/index.js`. **A composite index is required before the desktop listener ships** —
`posPrintJobs` on `kind ASC, shopId ASC, status ASC`. There is currently **no** index on that
collection (401 indexes exist, none for `posPrintJobs`). Not added here: the query has no caller
yet, and an index for a query nothing runs is debt.
