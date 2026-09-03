# Premium messaging — exact patch plan for r1

**Status:** 📋 PLAN ONLY. No code written on r1. `C:/temp/sok-r1` not touched (still dirty).
**Date:** 2026-09-03 · **Target:** `release/r1-pos-printer-fn` @ `8fc3673`
**Source:** `9fe09e2` (evidence branch), plus one supporting line from `fa5082b`

---

## 1. Exact source provenance

Three server functions, all added **purely additively** to `functions/messages.js` by `9fe09e2`
(confirmed: 272 lines added, 1 line removed — and that one `-` is the diff header itself, not
code). Zero existing exports or behavior touched.

| function | type | new in | self-contained? |
|---|---|---|---|
| `expireOldChatMessages` | `onSchedule`, daily | `9fe09e2` | yes — own `CHAT_RETENTION_DAYS`, `_EVIDENCE_FIELDS`, `_DELIVERY_FIELDS`, `_isPreserved()` |
| `addRiderToConversation` | `onCall` (reached only via `messagesDispatch` dispatcher, see §3) | `9fe09e2` | yes |
| `reactToMessage` | `onCall` (dispatcher only) | `9fe09e2` | yes — own `_ALLOWED_REACTIONS` |

The `expireOldChatMessages` **re-export in `functions/index.js`** (`exports.expireOldChatMessages
= _messagesMod.expireOldChatMessages;`) is a *separate* one-line addition that landed later, on the
evidence branch, via `fa5082b` — **not** part of `9fe09e2` itself (the commit message says so
explicitly: excluded because `index.js` "carried concurrent work by another process"). Confirmed:
our HEAD has it; r1 does not.

## 2. Exact diff against r1's `messages.js`

r1's `functions/messages.js` has drifted independently from the evidence branch's pre-messaging
base by 216 lines (`_PARTY_FIELDS`, `_partiesOf`, `_syncParticipants`, `onPackageRequestChanged`) —
**none of which overlap the three functions above**, confirmed by export-name diff (§ prior session
turn). The patch is a pure insertion; no r1 lines need to move or change.

**Exact insertion points**, located by the nearest unchanged anchor line so they survive r1's drift
(verified those anchors exist verbatim in `8fc3673`):

1. `expireOldChatMessages` block inserts immediately **before**
   `exports.getConversationContext = onCall(...)` (present, unmodified, in r1's file).
2. `reactToMessage` + `addRiderToConversation` + `_historyFloorFor` block inserts immediately
   **before** the comment `/* ── Allowlist for updateConversationStatus ... */` (present,
   unmodified, in r1's file).

## 3. Hidden dependencies — checked, not assumed

- `functions/messages.js`'s new code `require()`s nothing beyond what the file already imports
  (`firebase-functions/v2/https`, `/scheduler`, `firebase-admin`, `logger`) — no dependency on any
  evidence-branch-only module (unlike 18a/ADR-017, which needed
  `scripts/gate-authority-resurrection.js`).
- **Reachability is automatic for the two `onCall` functions.** Neither `reactToMessage` nor
  `addRiderToConversation` is exported standalone from `index.js` on *either* branch — they're
  reached exclusively through `messagesDispatch` (`functions/messages-dispatch.js`), which does
  `const messages = require('./messages'); ... messages._h[op]` — a **dynamic runtime lookup**, not
  a hardcoded op list. Confirmed `messages-dispatch.js` is byte-identical on both branches, and
  `messagesDispatch` is already exported and deployed on both. **No dispatcher change needed at
  all** — dropping the two functions into `messages.js` (which self-registers `exports._h.X` inline)
  makes them reachable immediately.
- `expireOldChatMessages` (an `onSchedule`, not part of the dispatcher pattern) needs its own
  `index.js` re-export — the one line from `fa5082b`, not yet on r1.

## 4. Existing exports/behavior — untouched

Confirmed via full diff: 272 additions, 0 modifications to any pre-existing line. The 19 exports
already live in production are not touched by this patch.

## 5. Indexes / rules / secrets / config / client routes

| requirement | needed? | detail |
|---|---|---|
| Firestore composite index | **no** | `expireOldChatMessages` queries `collectionGroup('messages').where('timestamp','<=',cutoff)` — a single inequality filter with no other clauses. Firestore's automatic single-field index (collection-group scope) covers this; confirmed zero `fieldOverrides` on `timestamp` for the `messages` collection group that would disable it. |
| Firestore rules change | **not required for function correctness** — both `onCall`s write via the Admin SDK (`admin.firestore()`), which bypasses security rules entirely. **Optional, explicitly deferred by the original author**: a "history boundary" rules clause so a rider cannot directly read pre-join messages via their own client query. `addRiderToConversation` already ships honestly reporting `enforcedBy: 'NOT_YET_ENFORCED'` when this clause is absent — this is a stated, deliberate scope limit already accepted once, not a hidden defect. The clause **does exist**, already, on the evidence branch's `firestore.rules.build` (landed with the same later commit as the index.js wiring) — not part of `9fe09e2` itself, and not required to stack `9fe09e2`'s code. |
| Secrets | none | no `secrets:` array entries, no new env dependency |
| Config | none | |
| Client routes | already correct on the evidence branch, and portable | `sokoni-chat-engine.js`'s `_cfMsg(op, data)` calls `httpsCallable('messagesDispatch')({op, ...data})` — the correct dispatcher pattern (contrast: KASS AI's role pages, which call `httpsCallable('sokoniChat')` directly against a non-callable `onRequest` function — a real bug found earlier this session). `chat.html` and `sokoni-chat-engine.js` are **byte-identical** to r1's base already — no transplant needed for those two files at all. |

## 6. Certification coverage — the real gap

`scripts/test-chat-history-boundary.js` is the **only** existing test touching this area, and it
does not certify any of the three new functions' own logic — it certifies the (separate, optional)
rules clause in §5, via a Firestore emulator. **Attempted to run it this session: failed
(`fetch failed`, no emulator reachable in this environment)** — could not be completed, disclosed
rather than assumed passing.

**There is no existing dedicated test for `reactToMessage`'s allowlist/participant-scoping,
`addRiderToConversation`'s authorization/cap logic, or `expireOldChatMessages`'s retention
carve-outs, on either branch.** This is the genuine certification gap this slice needs to close
before stacking — addressed next, in isolation, per the instruction not to touch r1 yet.

## 7. `chat.html` / `sokoni-chat-engine.js` — no corresponding change needed

Both are byte-identical between the evidence branch's pre-messaging base and r1's tip. The
premium-messaging diffs to these files (128 and 28 lines respectively) are real, but apply against
a base that r1 already has unmodified — so transplanting the composer/engine-side changes is a
direct, low-risk port once the server-side functions exist. Not attempted in this pass — the
server-side slice is the one requested first.

---

## What this plan does NOT do

Writes no code to any branch. Does not touch `C:/temp/sok-r1`. Does not run the actual r1
certification suite yet — that's the next step, after isolated certification of the three
functions closes the gap in §6.
