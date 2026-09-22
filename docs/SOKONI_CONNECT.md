# SOKONI Connect

**Status:** C1, C2, **C3-A, C3-B and C3-C COMPLETE**. No call has been demonstrated end to end, and no relay infrastructure exists.
**No media transport is provisioned. No call has ever been placed.** Nothing here is deployed.
See [[#The evidence ladder]] before quoting a test count.
**Date:** 2026-09-22
**Suites:** `scripts/test-connect-authority.js` (674 pass) · `scripts/test-connect-rules.js`
(37 pass, counter-proof holds — 9 checks fail without the rules)

Business communication that stays inside the business. Related: [[Marketplace]] ·
[[Authentication]] · [[Orders]] · [[Payments]] · [[MESSAGES_PARTICIPANT_ANCHORING]] ·
[[B931_GATE_MESSAGES_PARTICIPANT_AUTHORITY]]

---

## What this is

A buyer taps **Call seller**. SOKONI already knows the buyer, the seller, the order and the
shop, so it opens a session between two *uids* — never between two telephone numbers. Neither
party sees the other's number, and the record of the call is attached to the order it was
about.

That is the whole idea, and everything below exists to make the two obvious failure modes
impossible:

| Failure | Consequence |
|---|---|
| too narrow | a buyer cannot reach the seller about an order they paid for, the conversation moves to WhatsApp, and SOKONI loses the record it exists to keep |
| too wide | a stranger's telephone rings, or a camera switches on |

---

## Why it is not part of the messaging layer

The deployed `createConversation` takes `participantUids` from `req.data` and guards only with
`participantUids.includes(uid)`. Naming yourself is not entitlement, so **in production a
caller can record an arbitrary uid as a conversation participant.** The repair exists on the
release line; it is not on this one.

A calling layer built on top of that would inherit the defect and make it worse. A wrong chat
participant puts a message in the wrong inbox. A wrong **call** participant makes a stranger's
telephone ring.

So Connect never asks the conversation layer who the parties are. **There is no `calleeUid`
parameter anywhere in `functions/connect-calls.js`** — a caller names an *anchor* and the
server reads that document to discover who the parties are. The suite asserts the absence.

---

## The layers

```
        client
          │  connectDispatch({op, anchorType, anchorId, channel, purpose})
          ▼
   connect-calls.js          ← Firestore. Resolves the anchor → the parties.
          │                    Reads capability. Writes the session.
          ▼
   shared/connect-authority.js   ← PURE. No Firestore, no clock, no env, no require.
          │                        Decides: may they? which channel? which transport?
          ▼
   connectSessions/{id}      ← server-owned. allow write: if false.
```

`connect-authority.js` depends on **nothing** — the suite asserts it contains no `require(` at
all. It cannot behave one way in a test and another in production, and `buildSessionRecord`
takes `now` as an argument for exactly that reason.

---

## Who may talk to whom

Roles are **positions in a relationship**, not account types. The same account is `seller` to
its buyer and `buyer` to its supplier.

| Relationship | Pairs | Ceiling |
|---|---|---|
| `order` | buyer ↔ seller | voice |
| `inquiry` | buyer ↔ seller | **chat only** |
| `booking` | buyer ↔ provider | voice |
| `delivery` | rider ↔ buyer, rider ↔ seller | voice |
| `supply` | seller ↔ supplier | voice |
| `support` | admin ↔ buyer/seller/provider/rider/supplier | voice |

The matrix is a **whitelist**. A pair that is not written down is denied, so a new relationship
kind grants nothing until someone states its pairs.

Pairs are unordered: a relationship that lets a buyer call the seller lets the seller call
back. One-directional calling would mean a buyer could raise a problem and the seller could not
answer it.

### An enquiry never buys a telephone

`inquiry` is capped at chat. Anyone may open an enquiry against any public listing — it is
self-asserted — so granting it voice would make every seller's phone reachable by every
visitor. An order upgrades the *same pair* to voice. The suite proves both halves.

### State

| State | Permits |
|---|---|
| `active` | chat, voice (video still needs its own authority) |
| `closed` | chat only |
| `cancelled` | chat only |
| `blocked` | nothing |
| anything else | **nothing** |

A closed order keeps its history and loses its telephone: a buyer must be able to re-read what
was agreed, and must not be able to ring the seller about it a year later.

An **unrecognised** lifecycle word resolves to `unknown`, which the authority refuses. A new
status spelling therefore closes the call button rather than opening it.

---

## Video

Video is **never** granted by the relationship matrix. `mayCommunicate(..., 'video')` returns
`video_requires_separate_authority` for every pair and every state, so the restriction cannot be
reached by relaxing a voice rule.

Two authorities, resolved on **separate branches** that never fall through to each other:

```
                    VIDEO ACCESS
                         │
            ┌────────────┴────────────┐
            │                         │
      PLATFORM MODE             ENTERPRISE MODE
      isPlatformAdmin           capabilities.videoCalling === true
      + a named procedure       + orgGrant === true
                                + a named business purpose
                                + a live business relationship
      consumes: NOTHING         consumes: the Enterprise entitlement
```

### Platform verification

A platform admin may open video for: `identity_verification`, `business_verification`,
`merchant_verification`, `rider_verification`, `supplier_verification`, `support_escalation`.

A purpose outside that list is refused **even for an admin** — admin is the authority to conduct
a named business procedure, not a general licence to switch on someone's camera.

It does **not** consume an Enterprise entitlement. A merchant's plan must not be billed for
SOKONI verifying that merchant.

The session is a record that a procedure took place. **It is not itself proof of identity** —
the admin records the outcome against the applicable verification procedure. See
[[#The verification procedure]].

### Enterprise video

`capabilities.videoCalling` is declared in `functions/capability-authority.js`, resolves to
`ent.plan === 'ENTERPRISE'`, and the unsubscribed floor is `false`. Expiry is already handled
upstream: `subscription-catalog.entitlementFor` drops an expired or cancelled Enterprise
subscription to FREE before video is ever asked about, so video lapses with the plan without
anything in Connect knowing about dates.

**The subscription is necessary and not sufficient.** Buying Enterprise must not hand a camera
to every employee, so the organisation's own grant is a second, independent condition:
`connectVideoGrants/{ownerUid}__{memberUid}`, written only by `connectSetVideoGrant`, which
first proves the *granting* account's package includes video. The subscriber holds their own
grant implicitly; a self-grant is refused as a second authority for the same fact.

`videoCalling !== true` is the test, not `!videoCalling`. A missing key, the string `"true"`,
the number `1` and a truthy object are all denied; the suite exercises all of them against a
positive control.

### `videoVerification` is deliberately NOT a capability key

The moment verification authority is declared as a capability, some future branch resolves it
from a subscription and Enterprise buys the right to verify people. It arrives as
`isPlatformAdmin` — a decided custom claim that no capability set can reach.

---

## The session state machine

Built **before** the calling client, deliberately. A UI that decides its own state becomes a
second authority, and the first thing it gets wrong is the one that matters: a client that can
move a session straight to `connected` has invented a call nobody answered.

```
authorized ──► ringing ──► accepted ──► connecting ──► connected ──► ended
     │           │            │             │              │
     │           ├─► declined │             │              │
     ├───────────┴────────────┴─────────────┴──────────────┴──► cancelled / failed
     └─► expired ◄── ringing
```

| From | May go to | Taken by |
|---|---|---|
| `authorized` | ringing · cancelled · expired · failed | callee · caller · **server** · either |
| `ringing` | accepted · declined · cancelled · expired · failed | callee · callee · caller · **server** · either |
| `accepted` | connecting · cancelled · failed | either |
| `connecting` | connected · cancelled · failed | either |
| `connected` | **ended · failed only** | either |

Terminal: `ended`, `declined`, `cancelled`, `expired`, `failed`.

The table is a **whitelist**. `authorized → connected` is not missing, it is refused. Every
shortcut across the machine is asserted refused, each paired with a control proving the same
from-state still has a legal edge.

### Two departures from the proposed list

**`requested` does not exist**, and its absence is a property worth having. Authorization
happens *before* the document is created — `connectRequestSession` resolves the anchor, checks
the matrix or the video authority, and only then writes. There is no moment at which a session
exists and is not authorized. A separate `requested` state would be occupied by nothing, and a
state no session is ever in is a dead entry that reads as a guarantee. `authorized` **is** the
initial state.

**`abandoned` and `inconclusive` are not session states.** They are *verification outcomes*, and
they answer a different question: not "what happened to the call" but "what did the admin
observe". Making one word mean both is exactly how an evidence record starts being read as a
decision — the same reason the stored field is `sessionOutcome` and not `verificationStatus`. A
verification whose call was cancelled has session state `cancelled` **and** outcome `abandoned`;
those are two separate facts. The suite asserts the two vocabularies are disjoint.

### Who may take which edge

The **actor is derived from the session document**, never from the request — the same principle
as the participant list. A participant cannot claim to be the other one.

- Only the **callee** may accept or decline.
- Only the **caller** may cancel a ringing call.
- A **connected** call *ends*; it is never cancelled. Cancelling something that already happened
  would erase that the two parties spoke.
- The **server** may expire a pre-media session — and may **not** accept, decline, cancel or
  connect on anyone's behalf. A sweep must never answer a call for someone.
- `authorized → ringing` is taken by the **callee**: it means "the recipient's device is showing
  this call", an observation only that device can make truthfully. A server marking it would be
  asserting a delivery it cannot see. It grants nothing — `accepted` still needs consent.

### Consent lives inside the machine

`canTransition` refuses `→ accepted` for a video session without consent, rather than the answer
callsite checking it. A future path that reaches `accepted` some other way cannot forget it.

### `expired` has a real writer

`connectExpireStaleSessions` (scheduled, every 15 minutes) expires sessions left in `authorized`
or `ringing` for over 30 minutes. `accepted`, `connecting` and `connected` are deliberately
excluded: a call that reached any of them *did happen*, and recording it as "expired" would
erase that. The sweep obeys the **same table** every client does — it is not privileged to skip
it, so if the machine ever stops permitting the edge, the sweep stops taking it.

### The client observes; the authority decides

A WebRTC client must never be able to write `connected` because it constructed an
`RTCPeerConnection`. Documenting that would not hold it, so **the ops that named those states no
longer exist.** `connectBeginConnecting`, `connectMarkConnected` and `connectFailSession` are
gone. There is exactly one way into `connecting`, `connected` or `failed`: report what the media
stack *observed*, and let the authority decide what it means.

```
WebRTC                        Connect authority
──────                        ─────────────────
negotiation started   ──►     intends `connecting`
ICE connected         ──►     intends nothing — recorded only
media flowing         ──►     intends `connected`
ICE disconnected      ──►     intends nothing — recorded only
connection failed     ──►     intends `failed`
                                     │
                                     ▼
                              canTransition() still decides
```

**Two layers, both fail closed.** An event maps to an *intended* destination; the state table
then rules on whether that move is legal from where the session actually is. A client reporting
`media_flowing` while the session is still `accepted` does **not** skip `connecting` — the table
refuses it, with reason `transition_not_permitted`, exactly as it refuses every other shortcut.

| Event | Intends | Note |
|---|---|---|
| `negotiation_started` | `connecting` | |
| `ice_connected` | — | **An ICE pair is a route, not a conversation.** Recorded as `iceConnectedAt` |
| `media_flowing` | `connected` | media is actually being received |
| `ice_disconnected` | — | not a failure; a transient drop on mobile data must not hang up on someone |
| `connection_failed` | `failed` | |

**`ignored` is not an error.** Media events race and repeat. A duplicate `media_flowing` on an
already-connected session, or a `connection_failed` arriving after both parties hung up, returns
`effect: 'ignored'` — failing a client into a retry loop over a duplicate would be a defect, not
a control. A genuine *skip* is different and is refused; the distinction is `from === intends`
(idempotent) versus the table saying no.

### Intentions are not observations

`accept`, `decline`, `cancel`, `end` and `ringing` remain destination ops, because they are
things a **person** did. Pressing Decline is an intention; ICE failing is an observation.
Conflating them would make "the connection dropped" indistinguishable from "they hung up on me".

**Nothing maps to `ended`**, on purpose. A call ends because somebody hung up. Media merely
stopping is `failed` — and the difference between those two records is the whole reason for
keeping both.

The suite asserts every state is an intention state *or* a media-driven state, never both.

### The UI renders the machine, it does not decide it

`connectGetSessionState` returns `status`, `terminal`, `offerable` and `reportableEvents`.

`offerable` is the next states this *actor* may take, filtered through the same `canTransition`
the server enforces **and** restricted to intention states — `connecting`, `connected` and
`failed` are excluded, because offering a destination with no op behind it would tell the UI to
draw a button the server cannot honour. A button that lies teaches the operator that the console
lies.

`reportableEvents` tells the media layer which events are worth sending from here, so a client
fires those rather than every `RTCPeerConnection` callback — and never decides what they mean.
A terminal session has nothing worth reporting.

### Table soundness

The suite proves every edge points at a declared state, names a declared actor, that every state
is reachable from `authorized` (no dead entries), that every terminal state is actually reached,
and that the table is frozen.

---

## The authority is a frozen contract

As of **2026-09-22**, `functions/shared/connect-authority.js` is a protected contract. Downstream
work — the notification dispatcher, the client state renderer, the WebRTC adapter, TURN/STUN,
the call UI — **consumes** it. It is not redesigned to suit a consumer.

`API_CONTRACT` declares the surface (32 names) and the suite asserts it both ways: every
declared name is exported, **and** every export is declared. Adding a name is expected;
removing or renaming one fails a gate rather than being discovered by whichever consumer called
it first.

One defect was fixed on the way in, because it belonged inside the freeze rather than after it:
`ACTORS` held both the three parties who can act *and* the set-names a table edge may use, so
`actor: 'either'` passed the unknown-actor check and was refused only by luck of branch order.
Those are now `ACTOR_NAMES` (caller, callee, server) and `ACTOR_SPECS` (those three plus
`either`, `callee_or_server`). An edge spec is no longer a valid actor.

---

## Gate C1 — the notification dispatcher

`functions/connect-notify.js`, triggered on `connectSessions/{id}` creation. It is the only
server-side producer of `authorized → ringing`.

### It is not an authority

```
Identity → Authority → Session → Notification → Client → Media
```

By the time a session document exists, "may these two speak" is already answered and the
parties are already derived from the anchor. The dispatcher reads `calleeUid` off the session
the server wrote, never resolves a recipient of its own, never calls `mayCommunicate` or
`resolveVideoAccess`, and never writes a status directly — it asks `canTransition` like
everybody else, and asks again **inside the transaction**, because the callee may have answered
from another device between the send and the write.

### It does not send push either

`notify.js` is the platform's one notification engine and owns the token source, channel
routing, preferences, quiet hours, dedupe and the audit log. Three different ideas about where a
push token lives already cost this codebase a silent production failure. Connect names an
**intent** — `connect_incoming_call`, registered in that engine — and never a channel, provider
or token. The send is idempotent on `connect_ring:{sessionId}`, so a re-fired trigger does not
ring someone twice.

`connect_incoming_call` is `commerce`, not `critical`: critical ignores preferences *and* quiet
hours, and a buyer must not be able to ring a merchant at 3am about an order. SMS is null — an
SMS arriving after the caller hung up is noise.

### Undelivered is not ringing

If nothing was delivered — no token, preferences off, quiet hours — the session **stays
`authorized`** and the sweep expires it. It is never marked `ringing` on the strength of having
tried, because a caller must be able to tell *their phone never rang* from *they did not
answer*, and those become the same record the moment a dispatcher claims success on dispatch.
The attempt is still written (`notifyAttemptedAt`, `notifyOutcome`), so a silent phone is
diagnosable. A delivery failure is a result, not a throw — throwing would retry the trigger and
leave the record unwritten.

### Which evidence moved the state

`authorized → ringing` is `callee_or_server`, and the pair is the point:

| `ringingBy` | Means | Strength |
|---|---|---|
| `dispatch` | a push transport accepted the call | the platform did all it can |
| `device` | the recipient's app is actually alerting | stronger |

Server-only would overclaim — a push accepted by FCM is not a phone ringing. Callee-only would
strand every session whose app is asleep, with the caller unable to distinguish undelivered from
unanswered. The session records which one moved it, so they are never confused.

### Certified

| | |
|---|---|
| authorized → ringing | **PASS** (voice and video) |
| self-call / no callee / no caller | **DENY** |
| expired session | **DENY** — reason is the state, not the channel |
| already ringing | **DENY**, which is what makes a re-fired trigger idempotent |
| cancelled, and every other terminal state | **DENY** |
| accepted / connecting / connected | **DENY** |
| chat | **DENY** — nothing to ring |
| no transport plan | **DENY** — a call that cannot connect wastes their time |

`shouldDispatchRing` is pure and tested directly, with a positive control proving the decider
does grant.

---

## Gate C2 — the client projection layer

`sokoni-connect-client.js`, mounted by `connect.html` (the page the ring deep-links to).

A **projection**. Not an authority. It holds no state machine, no transition table, no actor
logic and no authorization.

```
server authority
      ↓
client projection      ← C2
      ↓
user / media action
      ↓
server-authorized request
```

and never `client state → client decides → backend accepts`.

### Actions come from `offerable` alone

`actionsFor(projection)` never reads `state`. Two cases prove it, and the second is the one
that matters:

| Input | Renders |
|---|---|
| `{ state:'ringing', offerable:[] }` | **nothing** |
| `{ state:'ended', offerable:['accepted'] }` | **Accept** |

A client with its own state logic passes the first and fails the second, because it would
"know" that an ended call cannot be accepted and would helpfully suppress the button — becoming
a second authority that can disagree with the first. This module renders what the server said.
If the server is wrong, that is a server bug and it should be visible.

### The action map is routing, not authority

`ACTIONS` is keyed by **destination**, never by state. It answers *which callable implements
this destination and what do we call the button* — a transport and labelling concern. An entry
is used only when the server has already placed that destination in `offerable`.

The suite asserts every routed destination is an **intention state**, and that
`connecting`, `connected` and `failed` have **no route at all** — a button could never produce
them. It also asserts every routed op actually exists on the server, so a rename breaks here
rather than in someone's hand.

A destination the server offers that this build cannot route is **surfaced**
(`unroutable`) rather than silently missing, so version skew is visible.

### Media is observed, never decided

`eventsFor` passes `reportableEvents` through verbatim — the client neither extends nor filters
the list. `reportObservation` is the only route to the backend and calls
`connectReportMediaEvent`. The suite asserts the client holds **no media vocabulary of its
own**: not one media event name is hard-coded in the file.

### What the suite proves about the client

- no `canTransition`, `SESSION_STATES` or `TERMINAL_STATES` anywhere
- no `actor`, from-state, or participant list is ever sent
- no capability or subscription logic
- no `state ===` / `status ===` comparison — state is displayed, never interpreted
- **no session-state literal it does not route**
- no op that names a media-driven state

### Consent is collected where the person agrees

Accepting a **video** session asks first and refuses to send without a true acknowledgement.
Voice and chat are not asked — a dialog shown always is a dialog dismissed always. The server
refuses regardless; this is the prompt, not the gate.

### `connect.html`

The deep link `/connect.html?session=…` now resolves. It loads the projection layer, routes
through `connectDispatch`, self-updates via `sw-register.js`, and reports a missing module as a
missing module.

**It carries no media.** There is no `RTCPeerConnection` and no `getUserMedia` on the page, and
it says so in the visible body rather than only in a comment. A session can be answered and
ended; nothing is transmitted.

### Certification boundary

**Proven by C2:** authority projection · state rendering · `offerable` action projection ·
actor projection · reportable-event projection · absence of duplicate client authority ·
the C1 contract intact (re-asserted after the C2 work, in the same run).

**Not proven:** physical-device push delivery · a real incoming-call notification · real WebRTC
media connectivity · TURN/STUN traversal · cross-network call establishment · mobile network
resilience.

---

## Gate C3-A — session creation and the consent contract

Two new pure modules and one client module. **No frozen contract was touched** — the suite
re-asserts `API_CONTRACT`, `SokoniConnectClient.CONTRACT`, the actor vocabulary, the session
states, the media events and the capability keys after the C3-A work, in the same run.

### A button is not a permission

`functions/shared/connect-call-surface.js` answers one question — *does this business surface
expose a Call action?* — and never *is this call authorized?*

| Anchor | Caller → target | Call button |
|---|---|---|
| `order` | buyer → seller, seller → buyer | yes |
| `delivery` | buyer → rider, rider → buyer, seller → rider | yes |
| `supply` | seller → supplier | yes |
| `support` | buyer → admin, admin → buyer | yes |
| `inquiry`, `booking` | — | **no** |

It is **deliberately narrower** than the authority. `rider → seller` is the worked example: the
authority permits it, and no screen offers it. Widening that later is a product change needing
no security review, because the authority already said yes.

The containment property is asserted the other way too: **every surfaced pair is authorized**.
A surfaced pair the authority would refuse is a button that is always refused — worse than a
missing one, because it teaches people the product is broken. That is also why `inquiry` has no
surface: the authority caps it at chat.

`show: true` carries `authorizes: false` in the answer itself, so a consumer cannot read one as
the other. The server decides on every request and would refuse one this policy happened to
offer. **UI visibility is not security** — the callable is reachable directly.

### Lifecycle is not restated

There is no order or delivery status word anywhere in the surface policy, and the suite asserts
their absence. The chain is:

```
business lifecycle → relationship state → surface eligibility → authorization
```

Only `active` carries a button. `closed`, `cancelled`, `blocked` and `unknown` do not — and the
authority refuses voice on all of them anyway, so the UI is not the control.

### The Call button sends an anchor, never a person

`sokoni-connect-call.js`. `requestPayload` is a named pure function precisely so the suite can
inspect what leaves the browser. Given a call that also passes `calleeUid`, `participantUids`,
`actor` and `fromState`, the payload contains **exactly four keys**: `anchorType`, `anchorId`,
`targetRole`, `channel`. A `targetRole` is a role the server validates against the anchor —
never a uid.

The client surface map is asserted to match the server policy **exactly**, in both directions
and on worked cases, so a divergence fails a gate rather than producing a button the server
never expected.

### An unreachable callee is told

`evaluateReachability` (pure) answers *can this be made to ring at all* from the transport plan
and whether the callee has anywhere a push could land. `connectRequestSession` returns
`reachable` / `reachableReason`.

**`reachable: true` is a pre-check, not a delivery receipt.** The copy says *"Reaching them…"*,
never *"Ringing"* — the suite asserts the word `ring` does not appear in the success message.
Preferences and quiet hours stay with `notify.js` at dispatch time; a second copy of that
policy is how two answers to one question begin.

**No new session state was introduced.** The session is still created as `authorized` and
follows the existing expiry path; `unreachable` is a *result of the request*, not a state.

### The evidence distinction survives

`connectGetSessionState` now surfaces `notifyOutcome` and `ringingBy`, so a caller can tell
*their phone never rang* from *they did not answer*. Null is written as null — it is not
"delivered". Nothing in the Call button manufactures `ringing`; the only writer of
`ringingBy: 'dispatch'` is still the dispatcher.

### The consent contract

`functions/shared/connect-consent.js`. Six mandatory fields:

| Field | Value today |
|---|---|
| purpose | the named procedure, e.g. *Merchant verification* |
| camera | required |
| microphone | required |
| recording | **OFF** |
| retention | `not_applicable_no_recording` |
| access | `no_recording_exists` |

Retention and access are the two fields a no-recording design is tempted to leave blank, and
blank is what rots: *"N/A"* written today reads, the day recording is switched on, as a field
somebody already thought about — and nobody re-opens it.

So they are **specific statements about why they do not apply**, and that moment is guarded.
`buildConsentDisclosure` **refuses** to build a contract with recording `ON` unless retention
and access are supplied explicitly, and **refuses the no-recording sentinels in that case**
because they would be false. A placeholder cannot survive the transition, because the function
will not build it.

### Consent is not verification

The module has no writer and no side effect. The suite asserts it never names `verified`,
`official`, `faceVerified`, `documentsVerified`, `providerVerification` or
`setCustomUserClaims`. The disclosure states `establishesIdentity: false` on its own face.

`acceptsConsent` is `=== true` and nothing else — `false`, `undefined`, `null`, `'yes'`,
`'true'`, `'TRUE'`, `1`, `0`, `{}` and `[]` are all rejected, and the authority is asserted to
give the same answers, so two modules cannot drift to one question.

### The disclosure reaches the person through the server

Built server-side and returned by `connectGetSessionState` for video sessions only. The C2
client renders it and **holds no second copy of the promise** — a second copy is a second
promise, and the two drift the first time one is edited. A video session with **no** disclosure
is **refused** rather than falling back to a vague sentence, because inventing a promise on the
platform's behalf is worse than not connecting.

What was accepted is snapshotted onto the session (`consentDisclosure`), so if the contract
changes later the record still says what *this* person was shown.

### Certification boundary

**Proven by C3-A:** call-surface eligibility · anchor-based session creation · server-side
participant resolution · authorization · `authorized` session creation · failed-dispatch
handling · C1 integration · the consent contract · C1 and C2 contracts still frozen.

**Not proven:** physical-device push delivery · a real incoming-call notification · WebRTC
media · TURN/STUN · cross-network connectivity · mobile network resilience · an end-to-end
voice call · an end-to-end video call.

A successful automated dispatch test is not a phone ringing.

---

## Gate C3-B — the incoming-call surface

C3-A gave a business surface a Call button and the server a way to create an authorized
session. C1 dispatches a ring. C2 renders a session once you are looking at one. None of them
answered the question this gate exists for:

**how does the called person find out?**

Until C3-B the only route to a session was the deep link inside a push notification. That made
the entire incoming path depend on a transport which is **undeployed**, and which on a real
handset is **unproven** — and it left anyone who swiped the notification away with no way back
to a call that was still ringing.

### `connectListIncoming` — a read, not an authority

One new dispatchable op, the thirteenth. It creates nothing, authorizes nothing and rings
nobody: it reports the sessions on which this user is the callee and has not yet answered.

Participation is re-checked against `participants` rather than inferred from `calleeUid`. The
two are written together and should agree; if they ever did not, this read must not be the
place that hands a session to somebody the participant list excludes.

### Which sessions count as "incoming" is DERIVED

There is no `['authorized', 'ringing']` written anywhere in the op. A hand-written list would
be a second state vocabulary, and it would stop agreeing with the table the moment somebody
added an edge. Instead a session is incoming when **the callee may still take one of the
answering destinations from where it is**:

```js
const ANSWERING_DESTINATIONS = ['ringing', 'accepted', 'declined'];
```

That yields `authorized` and `ringing` today. It excludes `accepted` — a call already answered
is *in progress*, not incoming — because the only destinations a callee has from there are
`connecting`, `cancelled` and `failed`. The suite recomputes the derivation from
`connect-authority` and compares, so replacing it with a literal passes today and **fails the
day the table changes**, which is the point.

An empty derivation is a **refusal**, not an empty list. "You have no calls" and "the query
cannot match anything" must never be the same answer.

### One projection, built in one place

`connectGetSessionState` and `connectListIncoming` return the **same shape**, because both call
`_project`. A client that learned a different vocabulary depending on which read it happened to
make would be a second projection, and the two would disagree the first time one of them gained
a field. The suite asserts that the projection's defining fields are constructed exactly once.

`connectRequestSession`'s response is deliberately **not** that shape. It is a creation result —
`counterpartyRole`, `transportPlan`, `fallbackAvailable`, `reachable` — answering a different
question, and it always was. The first draft of the "built exactly once" assertion keyed on
`counterpartyHandle`, which both carry, and reported two sites; it was correct that there were
two, and wrong about what that meant. A signature field has to be one only the projection has.

### One ring vocabulary

The banner's label is not written in the banner. `_project` returns `ring`, built by the **same
helper that writes the push** — `connect-notify`'s `ringPayload` — and the suite proves it by
equality, not by reading both and judging them similar. "Order #SK-99420" is the only thing that
makes an unknown caller answerable, and two copies of that sentence would drift.

A session whose label cannot be built yields `ring: null`, and the banner renders `—`. An
invented sentence on the platform's behalf is worse than no sentence.

### Answer is a NAVIGATION, not a call

`sokoni-connect-incoming.js` never calls `connectAnswerSession`. Accepting requires consent for
video, and the consent contract lives inside `SokoniConnectClient.mount`, where the **server's**
six-field disclosure is rendered. A banner that accepted for itself would need its own copy of
that dialog — **a second consent contract**, which is exactly what the C3 entry gates forbid.

So Answer navigates to `/connect.html?session=…` and C2 accepts, precisely as it does for a
push. Decline needs no consent, so it is routed from the banner — through **C2's** action map,
by destination, and only when the server put `declined` in `offerable`.

The suite proves this by driving the mounted surface and clicking: Answer navigates, and
`connectAnswerSession` is never called.

### No second action map

Loaded into a sandbox **without** C2, the banner can route nothing at all — `mayOpen` is false,
`declineAction` is null, `shouldMarkRinging` is false, and it renders a warning rather than an
empty box. That is only true of a module with no table of its own, and it is paired with the
positive control that the same inputs *do* route once C2 is present.

### The device takes the `ringing` edge at last

The authority has always defined `authorized → ringing` as `callee_or_server`, and says the
device's own evidence is the stronger of the two. **Nothing had ever taken the callee side of
it.** When the banner actually paints a session it reports once, through `connectMarkRinging`,
and only when the server put `ringing` in `offerable`.

It is **evidence, not a control**. A failure is swallowed, and the report is marked as attempted
before the result is known, so a slow or failing call cannot produce a second attempt on the
next poll. A banner that stopped working because a ring could not be recorded would turn
bookkeeping into a missed call.

### The page

`connect.html` with no `?session=` used to be a dead end reading *"No session was named in this
link."* It now mounts the incoming surface. The deep-linked path is untouched.

### Certification boundary

**Proven by C3-B:** the derivation of incoming states from the authority · one projection shape
across both reads · one ring vocabulary shared with the push · the absence of a second action
map · the absence of a second consent contract · that Answer navigates rather than accepts ·
that the device-alert report happens exactly once · escaping of every rendered value · the
composite index the query needs is declared.

**NOT proven by C3-B, and not claimed:** that a physical device ever alerted · that a push was
delivered · that any of this is deployed · that a call connects. This gate makes a ringing
session *reachable without a push*. It does not make a phone ring.

---

## Gate C3-C — the WebRTC adapter

Three things existed and had never met:

| | |
|---|---|
| `connectSignal` | relayed offers, answers and candidates into `connectSessions/{id}/signals` — and **nothing ever read them**. A relay with no reader is half a path. |
| `reportableEvents` | was projected to a client that had **no media stack** to produce a single one of them. |
| `transportPlan: ['webrtc']` | was authorized on every session and **never attempted**. |

`sokoni-connect-media.js` closes all three. It is an observer and a transport. It is not an
authority, and the distinction is enforced by what it **cannot say**.

### It cannot name a state

There is no path from the adapter to `connecting`, `connected` or `failed`. It emits only the
authority's **media event** names, through C2's `reportObservation`, and the server decides
what an observation means — through two layers, the event table and the state table.

The suite proves the boundary at the level of the whole mapping rather than case by case: it
enumerates **every event the adapter is capable of emitting** and asserts the range is exactly
the authority's six, and that none of them is a session state name. A typo becomes a failure
instead of an event the server silently refuses.

### An ICE pair is a route, not a conversation

```
iceConnectionState: connected   →  ice_connected     (the authority maps this to NOTHING)
connectionState:    connected   →  nothing at all
inbound track unmuted           →  media_flowing     (the ONLY route to `connected`)
```

This is the mistake the whole layer was built to avoid, so it is asserted four ways: ICE
connected reports `ice_connected`, **not** `media_flowing`, **not** `connected`, and the
aggregate connection state going connected reports nothing whatsoever. The suite also
confirms from the authority's side that `media_flowing` is the *only* media event that argues
for `connected`.

A drop is likewise not a failure: `ice_disconnected` may recover, and the authority records it
without moving the session. Hanging up on somebody crossing a cell boundary would be a defect.

Unknown inputs produce **silence**, never a guess — `new`, `checking`, `closed`, empty, null
and an unrecognised string all map to nothing.

### No transport is invented

**SOKONI operates no TURN and no STUN server.** There is no `stun:` or `turn:` URL in the
adapter or in the page, and there is **no default**. `describeIce([])` returns
`configured: false` with a reason and a sentence the UI can show:

> Host candidates only. Two devices on the same network may connect; anything across a router
> or a mobile network will not.

Quietly falling back to a public STUN would manufacture a transport the platform does not
operate — and it would make "the call connected" evidence of somebody else's infrastructure.
Even when servers *are* supplied, `describeIce` still refuses to promise connectivity.

### The signalling reader was already authorized

C3-C adds **no server op**. The peer reads the signals addressed to it straight from
Firestore, because `firestore.rules` has allowed exactly that since C2:

```
match /signals/{signalId} {
  allow read: if isAuthed() && request.auth.uid == resource.data.to;
  allow write: if false;
}
```

A callable would have been a second read path for something already authorized and already
certified (C14–C17, unchanged at 37/0). The page acts on **added** changes only, so a
re-delivered snapshot cannot replay an offer, and a refused or unindexed listener is **shown**
— a silently dead signalling channel presents as a call that simply never connects, which is
the hardest possible thing to diagnose.

### The page attaches on the server's say-so

Media attaches once, and only when the projection says the session is `accepted` **and** its
authorized `transportPlan` carries `webrtc`. The page holds no signalling logic: it constructs
the peer connection as the adapter's injected factory and supplies `getUserMedia`, and every
offer, answer and candidate is the adapter's. A terminal session takes its media down.

A refused microphone is reported as `connection_failed` — the observation it is — not
swallowed, and not turned into a state.

### A defect this gate found: the C2 / server field seam

C2's `renderHtml` asked for `p.state`. The server has always sent `status` — the document
field, and the authority's own word. **The session state on `connect.html` rendered as a dash
from the day C2 shipped.**

The C2 suite never caught it because it drives `renderHtml` with synthetic projections it
writes itself. A fixture agrees with whatever you wrote in it; it is not a contract. The C3-B
banner masked it further by reading `state` first and falling back to `status`, so the banner
looked right while the session page did not.

Fixed by making C2 read what the server sends, and by removing the banner's tolerant fallback.
The durable guard is a **seam assertion**: every field C2 reads is compared against the real
`_project` output, with a positive control proving the check catches an orphan.

This was a one-field change to a frozen file, and it is recorded here rather than folded in
quietly.

### Certification boundary

**Proven by C3-C:** the emittable range equals the authority's media vocabulary and contains
no state name · an ICE pair is never read as arrival · unknown inputs are silent · no `stun:`
or `turn:` URL and no default anywhere in the client · `describeIce` fails closed and promises
nothing even when configured · the adapter has no route to the backend except C2's handle ·
the signalling kinds it sends are exactly the kinds the server accepts · offer/answer/candidate
handling, glare avoidance, duplicate-media suppression and close, all driven against a fake
peer connection · the page attaches only on the server's say-so and runs no signalling of its
own · the C2/server field seam.

**NOT proven by C3-C, and not claimed:**

| | |
|---|---|
| WebRTC actually connecting | no two browsers have ever paired |
| TURN / STUN | none exists to test |
| NAT traversal, cross-network | impossible without a relay |
| Physical push, handset incoming call | no device |
| Mobile resilience | not tested |
| Any of this deployed | nothing is deployed |

The suite drives a **fake** `RTCPeerConnection`. That is a claim about this code's decisions,
not about a network. A green C3-C means the adapter cannot lie to the authority; it does not
mean a call works.

---

## The evidence ladder

What each layer's evidence actually establishes. Read this before quoting a test count.

| Layer | Status | What the evidence proves |
|---|---|---|
| Connect authority | **certified** | authorization and transitions |
| Firestore rules | **certified** | security enforcement, emulator-backed, counter-proof holds |
| C1 notification decision | **certified** | the `authorized → ringing` contract |
| C2 client projection | **certified** | the client follows the server projection |
| C3-A session creation + consent | **certified** | surface eligibility, anchor-based creation, the consent contract |
| C3-B incoming discovery + UX | **certified** | the derived state list, one projection, one ring vocabulary, no second action map, no second consent |
| C3-C WebRTC adapter | **certified** | the emittable range, that no state can be named, that no transport is invented — driven against a FAKE peer connection |
| Real push delivery | *not tested* | — no physical device |
| WebRTC actually connecting | *not tested* | — no two browsers have paired |
| TURN / STUN | *not provisioned* | — none exists to test |
| Cross-network calling | *not tested* | — |
| Mobile resilience | *not tested* | — |
| End-to-end call | *not yet possible* | — |

**856/0 is a certification result, not a calling result.** It proves the contract, the decision
machinery and the projection. It is not evidence that a phone rang or that media flowed — those
are a different class of evidence and need a device. That distinction stays in the release
evidence.

---

## C2 and C3-A are COMPLETE and FROZEN

Frozen 2026-09-22, the same way C1 is: `SokoniConnectClient.CONTRACT` declares the surface and
the suite asserts it **both ways** — every declared name exported, every export declared. C3
consumes this module; it does not reopen it.

### Two C3 entry gates

Both were found during C2 and are carried forward as **prerequisites**, not fixed
opportunistically. They are recorded in `sokoni-connect-client.js` itself, because a
prerequisite that lives only in a changelog is a prerequisite nobody reads.

**1 — The consent contract.** The current dialog is a `confirm()` naming camera, microphone and
recording status. Before real video it must also state **retention**, **who may access any
recording**, and the **purpose of the session**. Do not quietly widen the existing dialog;
define the contract first. This matters more here than in most products because the
verification model deliberately keeps `sessionOutcome` apart from `verificationStatus` — the
consent and evidence model must stay equally explicit.

**2 — There is no session-creation path.** Today:

```
existing session → connect.html → C2 projection → answer / render
```

but not:

```
business anchor → Call → create authorized session → C1 dispatch → ringing
```

That is the larger functional gap, and it is why C3 does **not** begin by putting an
`RTCPeerConnection` into `connect.html`.

### C3 order

| | |
|---|---|
| ~~C3-A~~ | **DONE** — call initiation, surface policy, consent contract |
| ~~C3-B~~ | **DONE** — incoming-call discovery and UX, accept / decline through C2 |
| ~~C3-C~~ | **DONE** — the WebRTC adapter. Observations only; no relay, nothing demonstrated |

### The anchor principle survives into initiation

The Call button must never become `call(calleeUid)`. It takes an **anchor**:

```
Order    → Call Seller
Delivery → Call Rider
Shop     → Call Supplier
Support  → Call Admin
```

The caller identifies the **business relationship**, not the person to ring. That is the rule
the whole layer is built on, and a convenience parameter is exactly how it would quietly end.

---

## Consent

A video session **does not connect** until the called party has been told what will happen and
has accepted:

> **SOKONI Video Verification** — this session is being conducted for business verification.
> Your camera and microphone will be used. **Recording: OFF.**  `[Cancel] [Join]`

Consent is a **server gate**, not a dialog. `connectAnswerSession` refuses a video session
without `consentAcknowledged === true`, so hiding the dialog cannot skip the consent. The
acceptance is then recorded on the session — `consentAcceptedAt`, `consentAcceptedBy`,
`consentRecordingDisclosed: 'OFF'` — because *the disclosure a person accepted is part of what
they accepted*. If recording is ever built, a record showing `OFF` is evidence of what this
person was actually told.

`acknowledged !== true` is the test. A string, a number, an array and an object are all refused;
the suite exercises each.

---

## The verification procedure

`connectRequestVerification` (admin only) opens the session and creates its record in **one
batch** — a verification with no session, or a session with no verification, is a dangling half
of a procedure. An admin cannot verify themselves. It goes through the *same*
`resolveVideoAccess` gate as every other video session, not around it.

The record carries: verification id, session id, subject uid, business id, application id, admin
uid, reason, documents referenced, notes, consent, started, ended.

`connectRecordVerificationOutcome` (admin only) records one of four outcomes:

| Outcome | Means |
|---|---|
| `verified` | the admin observed what the procedure required |
| `not_verified` | the admin observed that it was not met |
| `inconclusive` | the session proved nothing |
| `abandoned` | it did not take place |

`inconclusive` and `abandoned` exist so a session that proved nothing is *recorded* as having
proved nothing. Without them the only way to close a session is to claim a result, and "no
answer" quietly becomes "not verified".

An outcome is recorded **once**. Re-deciding in place would erase what the first reviewer
observed, which is the part a later audit needs most.

### A session is evidence, never a verdict

`providerVerification` is the canonical authority for whether an account is verified, and the
platform rule is that an official identity requires a passed identity check, a passed face
check **and** a completed human review — an approval alone is never sufficient. A third
verification schema is explicitly not wanted.

So `connectRecordVerificationOutcome` writes `sessionOutcome` **and nothing else**. It does not
touch `providerVerification` or `driverVerification`, does not set `official`, `verified`,
`faceVerified`, `documentsVerified`, `identityVerificationPassed`, `faceVerificationPassed` or
`humanReviewCompleted`, and never calls `setCustomUserClaims`. The suite asserts the absence of
every one of those writes.

The field is `sessionOutcome`, **not** `verificationStatus`. Borrowing the authority's
vocabulary is how an evidence record starts being read as a decision. Every record and every
response also carries `isProofOfIdentity: false` and `authority: 'providerVerification'`, stated
on the document itself so a reader months later does not have to know the policy.

---

## Transport

The application asks for a **session**; it never asks for a transport.

```
  both online ──► webrtc                     internet first
  callee offline ──► pstn                    voice only, if provisioned
  video + callee offline ──► NO ROUTE        never degrades to audio
  nothing provisioned ──► NO ROUTE + notConfigured[]
```

**A video call never falls back to the telephone network.** PSTN carries no video; offering it
would turn a video verification into an audio call while still recording the session as video,
and the verification would then rest on a camera that was never switched on.

**Presence absent reads as OFFLINE**, never as online. An optimistic assumption produces a
WebRTC plan for a peer that will never answer and tells the caller a route exists that does not.

### What is provisioned

| Transport | State |
|---|---|
| `webrtc` | signalling relayed by `connectSignal`. **No TURN/STUN server is configured**, so a call behind symmetric NAT will not connect. |
| `pstn` | **NOT_CONFIGURED.** No telephony provider is contracted, configured or field-proven. |

`PROVIDERS.pstn === false` in `connect-calls.js`, and the suite asserts it. **Flipping that
constant is not the integration.** Until a provider exists, an offline callee has no fallback
and the caller is told so.

Nothing in this document should be read as evidence that a call can currently be placed
end-to-end.

---

## No telephone number leaves the platform

A session carries **handles** — `ep_<uid>` — not numbers. Where a number is ever needed it is
resolved inside the telephony adapter and never travels through a session record, a client
payload, a log line or a notification.

Partial masking was considered and rejected: the last four digits of a Kenyan mobile are enough
to confirm a number someone already suspects, and the platform has no reason to publish any of
it.

`buildSessionRecord` scans everything it is about to persist and **refuses** on a match rather
than redacting. Silently stripping a number would hide the code path that produced it.
`connectSignal` runs the same check over relayed SDP/ICE payloads.

---

## Recording

There is none. Sessions are metadata only — no audio, no video, no transcript.

Every record asserts `recording: 'DISABLED'` as a literal rather than omitting the field, so a
record that does **not** say DISABLED is detectable; an absent field would be indistinguishable
from an old record written before recording existed. The AdminOS console displays the column
rather than hiding it.

If recording is ever built it is a separate feature with its own consent, disclosure, retention
and access controls — and this literal is what a reader checks.

---

## Seller identity on the money path

`order.sellerUid` is written by the **browser**. `firestore.rules` checks `uid` on the order and
never constrains `sellerUid`, so it is **advisory** and is never used to decide who may be
called. The authoritative chain is:

```
order ──► items[].productId ──► products/{id}.sellerUid
```

because `products` create requires `sellerUid == request.auth.uid` and update forbids changing
it.

The resolver **REFUSES** on: no items, no resolvable productId, no product, no seller on the
product, and **more than one distinct seller**. A multi-seller order has no single counterparty;
picking one would ring somebody who was never party to the line the caller means. The advisory
field is read only to be recorded in `advisory.claimedSellerUid` as agreeing or disagreeing.

Fan-out is capped at 25 products — an unbounded read on a callable anyone may reach is a
denial-of-service surface.

---

## Rules

`connectSessions` is **server-owned**: `allow write: if false` for everyone, including admins.
`participants` is the only record of who is on a call, and it is derived, never supplied.

| Path | Read | Write |
|---|---|---|
| `connectSessions/{id}` | admin, or a participant | nobody |
| `connectSessions/{id}/signals/{id}` | the peer it is **addressed to** (not the sender) | nobody |
| `connectVerifications/{id}` | admin, or **the subject** | nobody |
| `connectVideoGrants/{id}` | admin, owner, member | nobody |

The subject can read their own verification because a person is entitled to see that they were
asked to appear on camera and what was recorded about it. They cannot write it, and neither can
an admin — the once-only rule lives in the callable, where a transaction can enforce it.

Thirty-seven assertions in `scripts/test-connect-rules.js`, emulator-backed against
`firestore.rules.build` — the artifact a release actually carries, not the source.

> **`emulators:exec` alone proves nothing here.** Run from the repository root the emulator
> reports *"Did not find a Cloud Firestore rules file specified in a firebase.json config
> file"* — because `firebase.json` declares `firestore` as an **array** for two databases — and
> defaults to **allowing all reads and writes**. A deliberately corrupted ruleset passed that
> way during this work. The suite therefore loads the rules text itself through
> `initializeTestEnvironment` and treats a compile failure as a result.

`COUNTERPROOF=1 RULES_FILE=<HEAD's artifact>` makes 9 grant-side checks fail, which is what
makes the 37 passes mean something.

---

## Admin surface

Both platform consoles, **one module, two mount points**:

| Console | Where | Claim |
|---|---|---|
| `admin-os.html` | Communications → **Connect** tab | `claims.admin` |
| `super-admin.html` | **Connect** section | `claims.superAdmin` |

A tab in AdminOS rather than a 28th nav item: calling is communication, and a sibling of
Push/Email/SMS belongs beside them. A full section in Super Admin, matching how that console is
organised.

SOKONI is flat multi-page HTML with no router and no build step. Two consoles rendering the
same sessions from two hand-written copies is how surfaces drift — the merchant estate already
paid that bill. `admin.html` is deliberately not a consumer of either file, and the suite
asserts it.

### Read and write are separate files

| File | Contains |
|---|---|
| `sokoni-connect-console.js` | the read surface. **Certified to contain no write path** — no `set`, `add`, `update`, `delete` or `httpsCallable` |
| `sokoni-connect-verify.js` | the one write surface: open a verification, record an outcome |

Exactly as `sokoni-gcp-admin.js` is kept apart from `sokoni-integrations.js`. That guarantee is
worth more than one fewer script tag.

The console reads `connectSessions` and `connectVerifications` directly, so it needs no dispatch
op and no function deploy. The two reads are **independent**: an admin whose verification rule
is deployed and whose session rule is not sees one table and one honest refusal, not a blank
page.

The write surface routes through `connectDispatch` and **reports success only from what the
server returned**. A toast on click would tell an operator a verification exists when the write
may have failed — and here that means believing a person was asked to appear on camera when
nobody was. Buttons disable in flight, so a double-click cannot open two verifications. While
`connectDispatch` is undeployed both actions say exactly that, rather than appearing broken.

Hiding the video button is **not** an authorization control — the callable can be reached
directly, which is why every gate is server-side.

**Unknown is not zero.** A read that fails renders an em dash and names the reason. A read that
succeeds and returns nothing renders a real canonical zero *and says it is one*. Counts are
always labelled "of the last N sessions" — a count without its denominator is how "3 active
calls" becomes a number nobody can reproduce.

Until the `connectSessions` rule is deployed, an admin read returns `permission-denied` and the
console renders the unavailable state with that reason. **That is correct behaviour, not a bug
to route around.**

---

## Deployment

**NOTHING HERE IS DEPLOYED.**

| Artifact | State |
|---|---|
| `connectDispatch` (13 ops, 1 Cloud Run service) | registered in `functions/index.js`, **not deployed** |
| `connectSessions` composite index (`calleeUid`, `status`) | declared in `firestore.indexes.json`, **not deployed** |
| `connectExpireStaleSessions` (scheduled) | exported by name, **not deployed** |
| `connectOnSessionCreated` (Firestore trigger) | exported by name, **not deployed** |
| `firestore.rules` Connect blocks | in source and in `firestore.rules.build`, **not released** |
| `admin-os.html`, `super-admin.html`, `sokoni-connect-console.js`, `sokoni-connect-verify.js` | in the tree, **not deployed** |
| `connect.html` + `sokoni-connect-client.js` (C2) | in the tree, **not deployed** |
| `sokoni-connect-incoming.js` (C3-B) | in the tree, **not deployed** |
| `sokoni-connect-media.js` (C3-C) | in the tree, **not deployed** |
| `signals` composite index (`to`, `createdAt`) | declared in `firestore.indexes.json`, **not deployed** |

A functions deploy from this branch is **blocked** by the merchant-identity provenance gap
(`docs/PROVENANCE_GAP_MERCHANT_IDENTITY.md`) — two live callables are unregistered here, and a
deploy would ship the directory, not the commit. That gate is unrelated to this work and this
work does not lift it.

`firestore.rules.build` was regenerated (167,055 bytes, 63.7% of the 256 KiB ceiling). A rules
release is a separate, deliberate act: `--only firestore:rules` is **discarded** by
firebase-tools 15.26 and fails open to both databases — use the Rules REST API.

---

## Not built

Stated so nothing here reads as more complete than it is.


- **No TURN/STUN. Unchanged by C3-C, and deliberately so.** The client supplies an EMPTY
  `iceServers` list and says so; there is no `stun:` or `turn:` URL anywhere in it and no
  default. Host candidates only: two devices on one network may pair, anything across a
  router or a mobile network will not. Borrowing a public STUN would manufacture a transport
  SOKONI does not operate.
- **No telephony provider**, so no cellular fallback.
- **The ring is dispatched but UNPROVEN end to end.** Gate C1 exists and is certified at the
  decision level — `shouldDispatchRing` is pure and exhaustively tested — but no session has
  ever been dispatched against a real device, because nothing is deployed. C3-B removes the
  *dependence* on that push for discovery; it does not make the push proven. A push that `notify.js` reports as delivered is a push FCM
  accepted, which is not the same as a phone that rang. Treat C1 as built, not as proven.
- **Media is wired but has never flowed.** `connect.html` attaches the C3-C adapter once the
  server says a session is accepted on a webrtc transport plan. No two browsers have ever
  paired, and the suite drives a FAKE peer connection — that is a claim about the adapter's
  decisions, not about a network.
- **No OUTBOUND calling entry point.** `sokoni-connect-call.js` exists and is certified, but no
  order, delivery or merchant surface mounts it yet, so nothing in the product creates a call.
  The INCOMING side is no longer in this position: C3-B's surface is mounted on
  `connect.html`, and a ringing session is now reachable **without** a push.
- **No blocking or abuse queue** beyond the `blocked` relationship state the authority already
  understands.
- **No link from a verification to `providerVerification`.** Deliberate: generalising that
  authority is its own piece of work, and this record is evidence a reviewer reads, not an
  input a machine consumes.
- **The consent dialog is a `confirm()`.** It collects a real acknowledgement and the server
  refuses without one, but it is not a designed disclosure screen. It states the camera, the
  microphone and the recording status; it does not yet state retention, or who will see the
  session record.

---

## Running the suites

```bash
node scripts/test-connect-authority.js
firebase emulators:exec --only firestore "node scripts/test-connect-rules.js"

# and the gates this change touches
node scripts/verify-capability-consumers.js
node scripts/test-subscription-consistency.js
```
