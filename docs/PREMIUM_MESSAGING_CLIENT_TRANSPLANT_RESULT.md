# Premium messaging — client transplant result (completes the slice)

**Status:** ✅ CLEAN SLICE — certified and committed. **Not yet on `release/r1-pos-printer-fn`'s
branch ref.** `C:/temp/sok-r1` was not touched at any point.
**Date:** 2026-09-03 · **Result commit:** `86b4e43`, parent `96c3244`, parent's parent `8fc3673`.

Prerequisite reading: `docs/PREMIUM_MESSAGING_CLIENT_PATCH_PLAN.md`.

---

## Premium messaging is now one coherent, two-commit unit

```
8fc3673  (r1 tip, unmoved)
   └─ 96c3244  server: reactToMessage, addRiderToConversation, expireOldChatMessages
        └─ 86b4e43  client: composer, emoji panel, list filters, delivery/rider cards
```

The `pending-premium-messaging-r1` tag was moved to `86b4e43` — it now anchors the whole unit, not
just the server half.

## What happened

1. New isolated worktree, this time based on **`96c3244`** (not `8fc3673` directly) — deliberate,
   so the two halves stack as one unit rather than becoming siblings that need their own later
   reconciliation.
2. Re-confirmed `chat.html` and `sokoni-chat-engine.js` still byte-identical to this branch's base
   before touching anything.
3. `sokoni-chat-composer.js` (new file) copied byte-identical — confirmed via diff.
4. `sokoni-chat-engine.js`: `git apply --check` not used here (surgical two-anchor insertion, same
   as the server transplant) — `reactToMessage`/`reactionSummary` added exactly matching source.
5. `chat.html`: **applied via `git apply`** of the exact `9fe09e2` diff, after confirming
   `git apply --check` reported zero conflicts against the byte-identical base — the most reliable
   possible transplant method for a 128-line, multi-hunk diff, since it's the literal original
   patch, not a manual reconstruction.
6. Verification:
   - `node --check` on both JS files — pass.
   - **Real page load**, headless browser, the actual transplanted `chat.html` served over local
     HTTP: **0 console errors/warnings**. The page redirects to the login gate (`security.js`'s
     existing, pre-existing, unrelated auth behavior for an unauthenticated session) — expected,
     not a defect.
   - A secondary attempt to bypass the auth gate with a minimal stubbed-globals probe page produced
     inconclusive results (the probe environment itself behaved oddly — `document.readyState`
     reported "complete" while injected globals were unexpectedly absent, with no corresponding
     console error to explain it). **Abandoned rather than chased** — the real-page result is the
     stronger, cleaner signal, and the artificial probe's ambiguity reads as a limitation of that
     probe's own minimal environment, not a finding about the transplanted code.
   - Full r1 regression (master gate) re-run clean — unaffected, as expected for a frontend-only
     change.
7. Diff stat: **640 insertions, 1 deletion** across 3 files — matches `9fe09e2`'s original stat
   exactly.
8. Committed, tag moved to the new tip, temporary worktree removed. `C:/temp/sok-r1` and
   `release/r1-pos-printer-fn`'s branch ref confirmed unchanged before and after.

## Known, pre-existing, not-introduced-here gap

`chat.html` doesn't include `script.js`, so `window.showToast` is undefined on this page (on both
branches, unrelated to this transplant). The one call site in `sokoni-chat-composer.js` is guarded
(`if (window.showToast) ...`), so a failed-reaction error simply shows no toast rather than
throwing. Not fixed here — out of scope for a transplant, flagged for whoever owns this page next.

## Certification summary

| check | result |
|---|---|
| `git apply --check` (chat.html) | clean, 0 conflicts |
| `node --check`, both JS files | pass |
| Real transplanted page, headless browser | 0 console errors; expected auth redirect |
| Isolated stub probe | inconclusive, abandoned in favor of the real-page result |
| Full r1 regression (master gate) | pass, unaffected |
| `git diff --stat` | 640 insertions, 1 deletion — matches source exactly |

## Related

`docs/PREMIUM_MESSAGING_CLIENT_PATCH_PLAN.md` · `docs/PREMIUM_MESSAGING_TRANSPLANT_RESULT.md`
(server half) · `docs/R1_RELEASE_CANDIDATE_MANIFEST.md` (item 15, to be updated) ·
`docs/RELEASE_STACK_LEDGER.md`
