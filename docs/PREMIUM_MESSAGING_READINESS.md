# Premium messaging — provenance and r1-readiness assessment

**Status:** 📋 READ-ONLY ASSESSMENT. Not added to the r1 release stack. No merge, cherry-pick, or
commit performed on any branch.
**Date:** 2026-09-03 · **Commit assessed:** `9fe09e2` (evidence branch only)

---

## Correction to the prior manifest entry

`docs/R1_RELEASE_STACK_MATRIX.md` described this as "Functions: Firestore-direct (no new CF found
in a quick pass)." That was wrong — a deeper pass found real backend involvement. Corrected here.

## What `9fe09e2` actually touches

```
chat.html                             128 lines changed
functions/messages.js                 271 lines added (existing, deployed file — not new)
messages.html                          87 lines changed
scripts/test-chat-history-boundary.js  79 lines, new
sokoni-chat-composer.js               485 lines, new file
sokoni-chat-engine.js                  28 lines changed
```

`functions/messages.js` is **not** a new module — it already exists, deployed, on both production
(`d592d8f`) and r1 (`8fc3673`), with 19 existing exports (`createConversation`, `sendMessage`,
`searchConversations`, `editMessage`, moderation/scheduling triggers, etc.) that predate the branch
split and are already live. `9fe09e2` adds **three new exports** to that existing file:
`reactToMessage`, `addRiderToConversation`, `expireOldChatMessages` (plus a `_historyFloorFor`
helper). Confirmed absent from both `d592d8f` and `8fc3673` — genuinely new capability.

## Provenance — is this a clean addition, or does it collide with r1's own drift?

Checked each touched file's **pre-premium-messaging base state** (the evidence branch's parent
commit `a8f5bc8`) against r1's tip (`8fc3673`), since both descend from the same Aug 13 ancestor and
may have independently drifted:

| file | base-state match vs r1 tip | risk |
|---|---|---|
| `chat.html` | **byte-identical** (0 diff lines) | none |
| `sokoni-chat-engine.js` | **byte-identical** (0 diff lines) | none |
| `messages.html` | 10 diff lines | low — small divergence, needs a look before applying |
| `functions/messages.js` | 216 diff lines, but **no overlapping exports** — r1 independently added `_PARTY_FIELDS`, `_partiesOf`, `_syncParticipants`, `onPackageRequestChanged`; `9fe09e2` adds `reactToMessage`, `addRiderToConversation`, `expireOldChatMessages`, `_historyFloorFor`. Different functions, not competing edits to the same ones. | moderate to check, likely low to actually resolve — the two change sets don't appear to touch the same code |

**Dependency check:** the new `functions/messages.js` additions in `9fe09e2` only `require()`
standard Firebase SDK modules (`firebase-functions/v2/*`, `firebase-admin`) — nothing from this
repo's own modules, so no risk of depending on evidence-branch-only infrastructure the way the 18a/
ADR-017 work depended on `gate-authority-resurrection.js`.

**"Premium" is a UI/theme descriptor, not a paid entitlement** — confirmed earlier: the only
"premium" reference in `messages.html` is `/* Premium dark by default */`. No entitlement/plan gate
exists on any of this. Every signed-in user gets it.

## Classification

**Not yet a release-stack candidate**, but for a narrower, better-characterized reason than
"unknown provenance": this is a **real, self-contained, low-collision-risk addition to an
already-shared, already-deployed file**, sitting only on the evidence branch. The concrete blockers
before it could join the r1 stack:

1. **No certification found beyond `scripts/test-chat-history-boundary.js`** (79 lines, one narrow
   test) — the three new exports (`reactToMessage`, `addRiderToConversation`,
   `expireOldChatMessages`) don't appear to have their own dedicated certification the way every r1
   authority item does. Not run in this pass — existence not confirmed as sufficient by itself.
2. **`messages.html`'s 10-line and `functions/messages.js`'s 216-line base divergence** need an
   actual look, not just a line count, before claiming the addition applies cleanly.
3. No live-production check was performed (unlike KASS AI) — whether the currently-deployed
   `functions/messages.js` behaves correctly today is out of scope for this assessment, which is
   about the *new* commit's readiness, not the base file's health.

## What this assessment does NOT do

- Does not run `scripts/test-chat-history-boundary.js` or write a new certification.
- Does not merge, cherry-pick, or touch `functions/messages.js` on any branch.
- Does not add premium messaging to `docs/R1_RELEASE_CANDIDATE_MANIFEST.md`'s stack-ready set.
- Does not touch `C:/temp/sok-r1`.

## Related

`docs/R1_RELEASE_CANDIDATE_MANIFEST.md` (item 15, to be corrected with a reference to this doc) ·
`docs/R1_RELEASE_STACK_MATRIX.md` (Part 4, superseded by this doc's deeper pass)
