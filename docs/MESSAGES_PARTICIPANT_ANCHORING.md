# How conversations are anchored today — and the gap to close before extending

**Status:** INSPECTION. **Nothing changed.** This is the answer to "determine exactly how
buyer ↔ merchant ↔ rider conversations are currently anchored" — asked before touching
participant semantics.

Related: [[MESSAGES_PLATFORM_CENSUS]]

---

## The answer

**Participants are whatever the client says they are.**

`createConversation` (`functions/messages.js:95-191`) validates four things:

| # | check | verdict |
|---|---|---|
| 1 | caller is authenticated | ✅ |
| 2 | caller ∈ `participantUids` | ⚠️ **self-attestation** — the caller supplies the array |
| 3 | `transactionType` is one of the 17 known types | ✅ |
| 4 | the transaction **document exists** | ✅ |

Then it creates the conversation with the supplied `participantUids` verbatim.

**What it never does: read the transaction's own parties.** It fetches
`TX_COLLECTIONS[transactionType]/{transactionId}` purely to confirm existence — `txSnap.exists` —
and never looks at `buyerUid`, `sellerUid`, `assignedRiderId` or any equivalent.

Measured: `grep -E "buyerUid|sellerUid|assignedRiderId|riderId|isParty|parties" functions/messages.js`
returns **nothing**. There is no cross-check anywhere in the messaging authority.

So the relationship graph you drew —

```
BUYER ──── MERCHANT ──── RIDER
```

— is **not currently derived from the transaction at all.** It is asserted by the caller and
recorded. The buyer↔rider link is not authorised *because they share a delivery*; it exists because
someone said it does.

## Why this blocks extending the model

`firestore.rules` gates every read and write on `request.auth.uid in resource.data.participants`.
That rule is sound — but it trusts a field that `createConversation` populates from client input.
**The security guarantee is downstream of an unverified write.**

Extending participant semantics (pairwise → one room, or adding rider slots) without fixing this
would extend the unverified surface, not just the feature.

## Severity — stated precisely, not inflated

**What an attacker gains:** a messaging channel to any uid they can name, that uid's `displayName`
and `photoURL` copied into the conversation, and an entry written into their
`userConversations/{victim}/items` inbox.

**What they do NOT gain:** the order's contents. `orders` rules are independent and still require
buyer/seller/rider identity, so `getConversationContext` and any direct read stay protected. This
is a **contact/spam vector and self-granted channel**, not an order-data breach.

**Two things materially limit it:**

1. **The fast path protects existing conversations.** If `order_<id>` already exists,
   `createConversation` returns `{ existing: true }` *without touching participants*. A legitimate
   conversation cannot be hijacked or joined — the gap exists only on **first creation** for a
   transaction that has no conversation yet.
2. It requires a **real, existing transaction id**. How guessable those are is **unmeasured** and
   is the main open severity question — if order ids are timestamp-like or sequential, enumeration
   is cheap; if they are random, much less so.

**Also relevant:** there are **no tests for the messaging authority at all** — no
`scripts/*message*`, `*chat*` or `*conversation*` suite exists. Nothing would catch a regression
here today.

## The minimal fix — proposed, NOT implemented

Derive participants server-side instead of accepting them:

```
createConversation(transactionType, transactionId)      ← participantUids no longer trusted
  ↓
read TX_COLLECTIONS[transactionType]/{transactionId}
  ↓
extract that transaction's OWN parties
  ↓
require the caller to be one of them            ← the check that is missing today
  ↓
participants = the transaction's parties
```

Two properties worth keeping:

- **Per-type party extraction.** Each transaction type names its parties differently
  (`orders` → `buyerUid`/`sellerUid`; `packageRequests` → `buyerUid`/`sellerUid`/`assignedRiderId`).
  That mapping is the same class of problem as the destination census, so it should be **measured
  per collection**, not assumed.
- **The rider slot is dynamic.** A rider is assigned *after* the delivery is created, so
  participants must be able to grow when `assignedRiderId` is set — which is precisely the
  pairwise-vs-one-room decision, and it should be made **after** this fix, not before.

## What I did not do

- **Not implemented.** You asked to inspect first, and this is security-sensitive enough that the
  fix wants its own review and its own tests.
- **Not measured:** transaction-id guessability, and whether any client path already passes
  incorrect uids in practice.
- **Not verified against live rules.** This repo's `firestore.rules` is 256,582 bytes against a
  256,000 compiled ceiling and live is recorded as `e66d77a4`.
- **No production data was read.** Code inspection only.
