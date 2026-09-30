# Messages page census — 2026-09-30

**Status:** CENSUS then REPAIR on branch `hosting/messages-premium-on-0271709` (descends from live hosting `2bcdae2`). **Certified, NOT deployed.**

Owner ask (verbatim): *"fix or deploy the fixed premium message page. the one we have is in a mess right now: the message categories are not even all of them and they are not well displayed, and nothing loads. the messages, invoice etc, all that should be there in the categories, fix everything there"*.

Related: [[Messaging]] · [[MESSAGES_PLATFORM_CENSUS]] · [[MESSAGES_PARTICIPANT_ANCHORING]] · [[COMMUNICATION_ENGINE]] · [[Orders]] · [[Payments]]

---

## 1. What the page is (as found — identical to live `2bcdae2`)

| surface | file | role |
|---|---|---|
| Inbox | `messages.html` (214 lines) | list of the caller's conversations, 13 filter chips, search |
| Thread | `chat.html` (1,639 lines) | one conversation: messages, composer, attachments, voice, context banner |
| Engine | `sokoni-chat-engine.js` (643 lines) | `window.SokoniChat` — CONTEXTS registry (17 types), listeners, callable wrappers through `messagesDispatch` |
| Hub glue | `sokoni-inbox.js` (158 lines) | `SokoniInbox.openChat()` — navigates to `messages.html?with=…`; `HUB_TYPES` (8 hyphenated names); `createOrOpen()` writes `conversations/{a_b}` **from the client** |
| Merchant | `sokoni-merchant-messages.js` / `-ui.js` | merchant-v2 Messages tab; same dispatcher, reads `conversations/{id}/messages` as a participant |
| Admin | `messages-admin.html` | calls `searchConversations` etc. **directly by name** — those callables are not exported; only `messagesDispatch` is (`functions/index.js:11347`) |
| B2B | `b2b-chat.html` | localStorage only — not a conversation surface (see memory: do not route) |

### Load path (auth → query → render)

```
security.js → sokoni-cart.js → shared-header.js (injects sw-register.js)
compat SDK 9.6.1 → firebase.js (module, deferred) → sokoni-appcheck.js (_ensureApp(): creates the compat [DEFAULT] app synchronously)
→ sokoni-chat-engine.js → inline: firebase.auth().onAuthStateChanged
   !user → location = login.html?redirect=messages.html
   user  → SokoniChat.onConversationsChanged
            = userConversations/{uid}/items orderBy lastMessageAt desc limit 50 (onSnapshot)
            err → "Could not load messages — check your connection"
            ok  → _render(): filter by c.transactionType === chip, search, rows link to chat.html?id=
```

* Rules (`firestore.rules:3825`, identical in `.build`): `userConversations/{uid}` and `/items/*` readable by the owner only. Single-field `orderBy` needs no composite index. **The read itself is sound.**
* Server writers of the projection: `createConversation` (transaction), `onMessageCreated` (preview + `unreadCount`), `markRead`, `_syncParticipants` (join/leave). Preview text lives **only** here, never on the shared conversation doc (join-time scoping).

## 2. Why "nothing loads" — six defects, traced

| # | defect | evidence | effect |
|---|---|---|---|
| 1 | **No conversation is ever created from the UI on this line.** `SokoniChat.createConversation` has zero callers outside the engine. | `grep createConversation(` — only `sokoni-chat-engine.js:482` | A user whose orders/bookings never triggered a server-side create has an inbox of **zero** items. The page then says "No conversations", which is true but reads as broken. |
| 2 | **Every hub "Message" button lands on a page that ignores it.** 13 callers (`services`, `providers`, `healthcare`, `legal-hub`, `entertainment`, `marketing-hub`, `property-listing`, `seller-public`, `seller-delivery`, `provider-profile`, `business`, `sokoni-merchant-supply`) call `SokoniInbox.openChat` → `messages.html?with=<uid>&type=customer-provider…`. `messages.html` never reads `with/name/type/ctx`. Several pass synthetic ids (`en_${p.id}`, `hc_${p.id}`, `legal_${l.id}`, a slugged seller name). | `sokoni-inbox.js:64-75`; callers listed above | The most common entry path shows the (empty) inbox with no acknowledgement. The `HUB_TYPES` vocabulary (`buyer-seller`, `customer-provider`, …) is unknown to the server (`TX_COLLECTIONS`/`PARTY_FIELDS`) and to the engine's CONTEXTS. |
| 3 | **Categories incomplete.** Engine has 17 CONTEXTS; the page renders 12 of them + All. Missing: `pharmacy_order`, `freelancer_engagement`, `event_booking`, `financial_request`, `insurance_request`. No cross-cutting Unread view. Chips are 30px tall (below 44px), one flat scrolling strip of 13. | `messages.html:100-114` vs `sokoni-chat-engine.js:13-158` | Conversations of the five missing types are reachable only via All. |
| 4 | **Unreadable renders as a connection problem.** Any listener error (permission-denied, failed-precondition, unavailable) → "Check your connection". | `messages.html:182-185` | A rules denial is indistinguishable from offline. Memory rule: an unreadable state must render as *unavailable*, never as *no messages* or *offline*. |
| 5 | **Thread page hangs on a denied read.** `chat.html:817-819`: `if (err) { console.error; return; }` — the `loading-state` spinner is never hidden. | `chat.html:817` | "Nothing loads" on the thread for a non-participant or a scoped rider. |
| 6 | **Header unread badge can never render.** `shared-header.js:2774-2778` queries `conversations where participants array-contains uid AND unread > 0`. The server writes `unreadCounts.{uid}`, never `unread`; the only composite index is `participants + lastAt` (`firestore.indexes.json:814`). Error is swallowed. | as cited | Badge silently absent. **Out of this slice** (header is its own lineage, `2bcdae2` header asks); recorded for the owner. |

Also observed, not in scope: `messages-admin.html` calls unexported callables by name (every admin op there fails); `sokoni-inbox.js createOrOpen` writes `participants` from the client (the rules' `allow create` still permits a 2-party self-seated create on this line — see §5).

## 3. Type vocabulary — what a category may be backed by

| layer | vocabulary |
|---|---|
| Engine `CONTEXTS` (17) | order, service_booking, food_order, pharmacy_order, property_inquiry, vehicle_inquiry, job_application, freelancer_engagement, event_booking, hotel_reservation, financial_request, healthcare_appointment, legal_consultation, insurance_request, logistics_request, support_ticket, rfq |
| Server `TX_COLLECTIONS` (17) | same 17 → the transaction collection each anchors to |
| Server `PARTY_FIELDS` (8, derivable) | order, service_booking, food_order, property_inquiry, job_application, legal_consultation, logistics_request, support_ticket — **only these can be created** today; the other nine are refused `failed-precondition` ("parties cannot be derived") |
| `SokoniInbox.HUB_TYPES` (8) | buyer-seller, customer-provider, rider-passenger, tenant-landlord, patient-doctor, client-lawyer, marketing, general — **known to no server code and no rule** |
| Conversation-carried tags | none on this line. (`entTags: ['payment'|'refund']` exists only on the entertainment lineage `0799e1e`, not an ancestor of live.) |

**There is no `invoice` or `payment` conversation type.** "Invoice" exists in the engine as an *action* (`view_invoice`) on four contexts: order, service_booking, pharmacy_order, logistics_request (measured by `scripts/test-messages-premium.js` R3). The repaired page therefore offers **Invoices** as a derived view = "conversations whose context carries a `view_invoice` action" — derived from the engine registry, not invented. A **Payments/Refunds** category has **no backing on this line** and is not rendered (owner decision, §6).

## 4. Search for a newer / "premium" inbox across all branches

`git log --all --since=2026-09-15 -i --grep="messag|inbox|chat"` and per-file history of `messages.html`, `sokoni-inbox.js`, `sokoni-chat-engine.js`:

| commit | branch(es) | what it holds for the inbox | descends from live `2bcdae2`? | taken? |
|---|---|---|---|---|
| `f890075` 09-28 server-derived participants | convergence/commercial-fn-on-ef1e992, feat/creator-hub, slice/c4-* | server `createConversation` derives parties (already present on this branch in the same form); retires `sokoni-inbox.createOrOpen`; rules close client create | **no** | **`createOrOpen` retirement ported** (identical hunk). Rules/functions not ported — functions deploy gated (provenance gap), rules lineage is separate |
| `0799e1e` 09-27 entertainment | same lineage | adds Enquiries/Bookings/Refunds/Payments chips backed by `entTags` written by `ent-enquiries.js` — **absent here** | no | not taken (no backing data) |
| `86b4e43` / `9fe09e2` 08-26/09-03 "premium composer, list filters" | not ancestors of HEAD | Unread / Delivery / Favourites chips, pins (localStorage), delivery badge from `deliveryId/dispatchId/riderId` on the item — fields the server projection never writes | no | Unread view re-implemented from real `unreadCount`; pins/favourites not taken (local view-state, not asked for) |
| `c2ad1f3` 09-29 T2a product enquiries | not an ancestor | `product_enquiry` type + `functions/product-enquiries.js` | no | not taken — would be a new server type; separate slice |

**Conclusion: no branch holds a standalone premium Messages page that descends from compatible code. Repair in place.**

## 5. Authority boundaries respected by the repair

* Participants are server-derived (`_partiesOf`); the client never writes a conversation. `sokoni-inbox.createOrOpen` now returns `null` and writes nothing (ported from `f890075`). The engine's `createConversation` wrapper no longer sends `participantUids` (the server already ignores it).
* Messages are read as a participant from `conversations/{id}/messages`; the only writer is `sendMessage` through `messagesDispatch`. The inbox's thread pane uses the **same engine calls** as `chat.html` (`getConversation`, `onMessagesChanged`, `sendMessage`, `markRead`) — no second chat authority.
* Attachments are deliberately not offered in the inbox pane (no upload authority in this slice); "Open full chat" hands off to `chat.html`.
* An unreadable projection or thread renders **Unavailable** with a retry; never "No messages". Empty is shown only for a real empty snapshot.
* Unread counts come only from `unreadCount` on the projection (server-written).

## 6. Owner decisions needed

1. **Payments / Refunds category** — no conversation carries a payment marker on this line. Options: (a) leave absent (current); (b) port the entertainment `entTags` writer (server slice, separate gate).
2. **Direct "Message this provider"** — 13 hub buttons ask for a person-to-person chat; the server creates conversations only from a transaction of one of eight derivable types. The repaired page now says so honestly when it arrives with `?with=`. Either those buttons move to a transaction (enquiry/booking) entry, or a server-anchored enquiry type is added (as `c2ad1f3` did for products on another lineage).
3. **Header unread badge** (`shared-header.js`) queries a field the server never writes — fix belongs to the header lineage.
4. **`messages-admin.html`** calls unexported callables — separate repair.
5. Nine of the 17 types are accepted but refused at create (`PARTY_FIELDS` has no rules basis for them). Chips for them still render because legacy conversations may carry those types; new ones cannot be created until rules name their parties.
