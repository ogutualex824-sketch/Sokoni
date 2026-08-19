# Messages — platform census before any rebuild

**Status:** CENSUS. **Nothing built, nothing changed, nothing deployed.**
Step **H** of the build order.

**Headline: the architecture in the brief already exists, server-enforced.** The gap is the
mobile UI, not the model. Building a new conversation system would replace a mature one with a
younger one.

---

## 1. What already exists

### The model — exactly the shape proposed

```
conversations/{convId}                 convId = `${transactionType}_${transactionId}`
  participants[]                       ← the authority for read/write
  lastMessage, lastMessageAt, lastSenderId, unread
  └── messages/{msgId}
```

Deterministic ids mean a conversation for an order **cannot be duplicated** — the same order
always resolves to the same room.

### The authority — `functions/messages.js`

| export | role |
|---|---|
| `createConversation` | the only way a room is created |
| `sendMessage` | the only way a message is written |
| `markRead` | unread counts |
| `getConversationContext` | **server-resolved order/transaction context** |
| `reportConversation`, `adminGetReports`, `adminReviewReport` | reporting + review |
| `adminUpdateChatPolicy`, `adminGetChatStats` | policy + stats |
| `onMessageCreated`, `moderateMessage` | triggers: fan-out and moderation |
| `archiveCompletedConversations`, `cleanupChatStorage` | scheduled lifecycle |

### The rule you asked for is already enforced

> *"The Messages page itself should not decide who is allowed to see a conversation. The
> server/security authority should."*

`firestore.rules:937-968` already does exactly this:

```
conversations/{convId}
  isParticipant() = request.auth.uid in resource.data.participants
  read    : isParticipant()
  update  : isParticipant() AND only lastMessage/lastMessageAt/lastSenderId/unread
  create  : authed AND caller ∈ participants AND participants.size() <= 2
  messages/{msgId}
    read  : participant (resolved via get() on the parent)
    create: FALSE  ← all sends go through sendMessage; direct creates are blocked
                     specifically to prevent senderId/senderName spoofing
    update: sender only, and only deleted/deletedAt/text/edited/editedAt/storageRef
```

`sendMessage` re-verifies participation server-side (`'Not a participant in this conversation'`),
validates message type, caps text at 4000 chars, and requires an uploaded `storageRef` to be
**owned by the caller**. The UI cannot grant itself anything.

### Not an unrestricted directory — also already true

> *"That keeps the messaging system useful without turning it into an unrestricted directory of
> users."*

`createConversation` is **transaction-anchored**: it requires `transactionType` + `transactionId`,
refuses an unknown type, refuses a caller not in `participantUids`, and **verifies the transaction
document actually exists** before creating anything. You cannot open a conversation with a stranger;
you can only open one about a real shared transaction.

**17 anchors exist**, covering the whole marketplace — and, importantly for the target:

```
order · service_booking · food_order · pharmacy_order · property_inquiry
vehicle_inquiry · job_application · freelancer_engagement · event_booking
hotel_reservation · financial_request · healthcare_appointment
legal_consultation · insurance_request · logistics_request · support_ticket · rfq
```

**`logistics_request → packageRequests`** means **rider/delivery conversations are already
modelled** — the buyer↔rider case you described has an anchor today.

### Surfaces that already exist

`messages.html`, `chat.html`, `sokoni-chat-engine.js`, `sokoni-merchant-messages.js`.
**Messages is already not merchant-gated** — there are buyer-facing pages.

---

## 2. The real gaps

Everything above means the work is smaller and better-targeted than the brief assumes.

| # | gap | severity |
|---|---|---|
| 1 | **The premium mobile UI** — inbox, filter chips, conversation view, composer, order card | the actual ask |
| 2 | **`participants.size() <= 2`** caps *client-created* rooms at pairwise | see below |
| 3 | **No `deliveryId` on the conversation** — context comes from `transactionId`, so a room anchored to an order cannot also point at its delivery | design question |
| 4 | Merchant v2 has **zero `onSnapshot`** — the shell is cache-and-render, so realtime is not wired *there* | blocks "genuinely realtime" in v2 |

### On gap 2 — a nuance worth stating precisely

The `<= 2` cap applies to **direct client creates**. `createConversation` runs on the Admin SDK,
which **bypasses rules entirely**, so the CF can already create a 3-party room (buyer + merchant +
rider) if asked. The rule is a floor on the fallback path, not a ceiling on the system.

So the pairwise-vs-group decision is a **product** decision, not a rules blocker:

- **pairwise chain** (buyer↔merchant, merchant↔rider, buyer↔rider) — works today, matches your
  diagram, keeps each party's visibility minimal
- **one order room** with all three — needs the rule relaxed *and* a deliberate answer about the
  buyer seeing merchant↔rider traffic

I have not chosen; it changes who can read what.

---

## 3. What I recommend

**Do not rebuild the model.** Build the UI against the existing authority:

1. Use `createConversation` / `sendMessage` / `markRead` / `getConversationContext` as-is.
2. Add realtime by attaching an `onSnapshot` **in the messages surface**, not a new cache — and in
   Merchant v2 specifically, note that no listener exists yet, so that is genuinely new wiring and
   is where a competing cache could accidentally be born.
3. Order context comes from `getConversationContext` — **server-resolved**, so the UI never decides
   what context it is entitled to show.
4. Treat the buyer surface as first-class: `messages.html` already exists and is not merchant-gated.

**Non-vacuity, as with the live dashboard:** if the test account has no conversations, the harness
must report **UNPROVEN**, never PASS. An empty inbox rendering correctly proves nothing about
realtime.

---

## 4. Not verified here

Stated so nothing above is over-read:

- **Whether `firestore.rules` in this repo is the LIVE ruleset.** The file is 256,582 bytes against
  a 256,000 compiled ceiling and the release record names live as `e66d77a4`. Rule quotes should be
  confirmed against live before any change.
- **Whether the existing surfaces work well on a phone** — not measured; that is the next step.
- **Whether `onMessageCreated` already drives notifications end-to-end** — the trigger exists; its
  delivery path was not traced.
- **Nothing was run against production.** This is a code census.
