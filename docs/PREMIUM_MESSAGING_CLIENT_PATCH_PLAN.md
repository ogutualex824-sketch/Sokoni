# Premium messaging — client-side patch plan (chat.html / composer / engine)

**Status:** 📋 PLAN + FINDINGS. Evidence-branch work only — `C:/temp/sok-r1` untouched.
**Date:** 2026-09-03 · **Source:** `9fe09e2` · **Companion to:** the server-side transplant
(`96c3244`, anchored, not on r1) — this closes item 15a from the manifest.

---

## 1. Provenance and diff purity

| file | change | purity |
|---|---|---|
| `sokoni-chat-composer.js` | new file, 485 lines | pure addition |
| `sokoni-chat-engine.js` | +28 lines | pure addition (0 removed) — extends the existing `SokoniChat` client object with a `reactToMessage` wrapper calling `_cfMsg('reactToMessage', ...)`, the correct dispatcher pattern |
| `chat.html` | +128/-1 | **one real modification**: `_buildMsgEl`'s system-message branch, replacing a plain pill render with a richer delivery/rider-offer card, **falling back to the original pill when no recognised status is present** (confirmed by reading the full hunk, not just the diff stat) |

Base-state re-confirmed unchanged since the earlier session-turn check: `chat.html` and
`sokoni-chat-engine.js` are still byte-identical between the evidence branch's pre-messaging state
(`a8f5bc8`) and r1's tip (`8fc3673`). `sokoni-chat-composer.js` is still absent from r1.

## 2. Dependency check — every global `sokoni-chat-composer.js` expects

| global | where it's actually defined |
|---|---|
| `SK_CONV_ROLE`, `SokoniMsgMarks`, `SokoniReactions`, `SokoniStickers`, `skDeliveryCardHtml`, `skRiderOfferCardHtml` | self-contained — all defined within `sokoni-chat-composer.js` itself |
| `SokoniChat` | `sokoni-chat-engine.js` — transplanted alongside |
| `showToast` | `script.js` (`window.showToast = function(msg,type){...}`) |

**Finding, not introduced by this transplant — present already in the source commit on the
evidence branch:** `chat.html` does not include `script.js`, so `window.showToast` is undefined on
this page as things stand. The one call site (`sokoni-chat-composer.js:373`, a failed-reaction
error toast) is **guarded** (`if (window.showToast) ...`) — so this degrades silently (no error
toast shown on a rare failure path) rather than throwing. Not a blocker; noted for whoever owns
this page next, not fixed here (out of scope — not something this transplant introduced or was
asked to fix).

## 3. Insertion plan

- `sokoni-chat-composer.js`: new file, direct copy — no insertion point needed.
- `sokoni-chat-engine.js`: append the `reactToMessage` function + registry entry, same pattern as
  the existing `_cfMsg`-based wrappers (`markRead`, etc.) already in the file.
- `chat.html`: two changes — (a) additive UI (emoji panel container, emoji toggle button, quick-say
  strip, `<script src="sokoni-chat-composer.js" defer>` at the end) — pure insertion; (b) the
  `_buildMsgEl` system-message branch — a real, small, anchored modification with a safe fallback.

## 4. Verification approach

Client-side logic here is DOM/browser-shaped, not a pure-function unit-test target the way the
server functions were. The original commit's own verification method was component-level browser
loading with seeded data — matching that, this pass uses a real headless-browser load of the
transplanted `chat.html` (static-served) to check: page loads without console errors, the new UI
elements render, and no reference errors occur (e.g., a missing global at parse/init time) — rather
than a full authenticated Firestore-backed conversation flow, which needs real seed data the way
the original commit's own testing did.
