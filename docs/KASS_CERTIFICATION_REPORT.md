# KASS Widget — Production Hardening & Cross-Browser Certification Report

**Date:** 2026-07-14  
**Widget Version:** v3.1  
**Prepared by:** SOKONI Engineering  
**Scope:** kass-widget.js, sokoni-validate.js (fetch wrapper)

---

## 1. Executive Summary

This report documents the root-cause investigation, bug fixes, hardening changes, and regression coverage for the KASS AI Concierge Widget following the P0 production incident on 2026-07-14. Two P0 bugs were found and fixed; nine additional hardening improvements were applied; 32 automated regression tests now cover the critical paths.

**Production status:** READY — pending physical device validation on iPhone Safari and Installed iOS PWA.

---

## 2. Root Causes (P0 Incident)

### P0-1: Send Button Shows "NaN" — `+ _SEND_SVG +` Unary-Plus Bug

**File:** `kass-widget.js`, line 564 (pre-fix)  
**Root cause:** In a JavaScript array literal, placing `+ string +` between two string elements does not concatenate — it applies the unary `+` operator to the string (type-coercing it to `NaN`), then the binary `+` to the NaN. The send button received `NaN  ` as its innerHTML.

**Fix:** Changed `+ _SEND_SVG +` to `, _SEND_SVG,` — a properly comma-separated array element.

**Evidence status:** Code reviewed. Test T1 + T2 verify the SVG and the old bug path.

---

### P0-2: Raw WebKit DOMException Shown in Widget — "The string did not match the expected pattern."

**File:** `kass-widget.js` `_callKass()` function  
**Root cause (layer 1):** Safari and WebKit iOS can throw `fetch()` **synchronously** (before returning a Promise) with `DOMException SYNTAX_ERR`. This is a WebKit-specific behaviour — Chrome and Firefox always return a rejected Promise.

**Root cause (layer 2):** `sokoni-validate.js` wraps `global.fetch` by chaining `.then()/.catch()` onto the return value of `of.apply()`. This only intercepts Promise rejections. If `of.apply()` throws synchronously, the throw escapes the wrapper entirely and propagates directly to the caller.

**Root cause (layer 3):** `_callKass()` had no try/catch around the `fetch()` call, so the raw WebKit DOMException message surfaced in `_addErr()` unchanged.

**Fix path:**
1. Added `try { fetchPromise = fetch(…) } catch (syncErr) { … }` in `_callKass()` to catch the sync throw at its source.
2. Added `_friendlyMsg()` to map known raw error strings to user-readable messages.
3. Updated `_addErr()` to route all messages through `_friendlyMsg()`.
4. Added a comment in `sokoni-validate.js` documenting the sync-throw gap so future callers know to apply the same pattern.

**Evidence status:** Code reviewed. Tests T11–T20 cover `_friendlyMsg()` mappings; T22 tests the sync-throw path end-to-end.

---

## 3. Hardening Changes Applied (v3.1)

### H1: URL Sanitisation — `javascript:` Protocol Injection
**Severity:** Security — P1  
**Added:** `_safeUrl()` helper. `_esc()` escapes HTML entities but does NOT block `javascript:`, `data:`, or `vbscript:` protocol prefixes. URLs from KASS server responses are now passed through `_safeUrl()` before being embedded in `onclick` attributes and `href` values.  
**Tests:** T5–T10

### H2: Accessibility — Close Button Hidden from Screen Readers
**Severity:** Accessibility — P1  
**Issue:** `#kassHead` had `aria-hidden="true"` on the container div, which suppressed the entire header including the Close button from all assistive technologies. The Close button could not be activated by keyboard or announced by screen readers.  
**Fix:** Removed `aria-hidden` from `#kassHead`. Added `aria-hidden="true"` only to the decorative avatar and name/status text (which duplicate the modal's `aria-label`). The Close button is now fully accessible.

### H3: Accessibility — FAB Missing `aria-expanded`
**Severity:** Accessibility — P2  
**Fix:** Added `aria-expanded="false"` to the FAB on creation. Updated to `"true"` in `_open()` and back to `"false"` in `_doClose()`. Screen readers now correctly announce when the dialog is open.

### H4: UX — Chips Invisible When Auth Settles While Panel is Open
**Severity:** UX — P2  
**Issue:** If a user opened the KASS panel before Firebase auth settled (possible within the first 8 seconds), chips were hidden (pending auth → hide chips in `_open()`). When auth then settled to `authed`, `_syncAuthUI()` did not restore chips. The user never saw suggestion chips in that session.  
**Fix:** Added `_chipsSent` state variable. `_onAuthChange()` now restores chip visibility when transitioning to `authed` while the panel is open and no message has been sent.

### H5: Robustness — Offline Pre-Check in `_send()`
**Severity:** UX/Robustness — P2  
**Fix:** `_send()` now checks `navigator.onLine === false` before dispatching the request and shows an immediate friendly error. Prevents a 35-second wait (timeout) when the device is demonstrably offline.

### H6: Diagnostics — Request Timing + Environment Info
**Severity:** Ops — P3  
**Added:** When `kassDebug=1` is active, `_callKass()` logs:
- Request URL, auth state (boolean, not token), message count, online status, AbortController availability
- Response HTTP status, status text, and round-trip milliseconds
- On sync throw: error name, message, origin, endpoint, elapsed ms  
`_initAuth()` now logs UA, origin, endpoint, AbortController availability, visualViewport presence.

### H7: Error Messages — Broader Platform Coverage in `_friendlyMsg()`
**Severity:** UX — P3  
**Added patterns:**
- iOS hostname resolution failure: `A server with the specified hostname could not be found.`
- iOS offline: `The Internet connection appears to be offline.`
- WebKit internal: `XHRErrorDomain`, `could not connect to the server`
- Chrome: `net::ERR_*` prefix
- Cross-browser: `network error`
- Abort (Firefox/Chrome text): `The user aborted a request.`
- Unsupported browser features: `is not supported`, `not implemented`

### H8: Chips Open-State Consistency
**Severity:** UX — P3  
**Fix:** `_open()` now explicitly sets `_chips.style.display = ''` when authed and no send has occurred (the else branch was previously missing — CSS default was relied upon, which could be overridden by a previous pending→hide cycle without a reload).

### H9: `sokoni-validate.js` — Sync-Throw Gap Documented
**Severity:** Developer Safety — P3  
**Added:** Comment block at the fetch wrapper explaining the synchronous-throw limitation and linking to `_callKass()` as the canonical pattern.

---

## 4. Cross-Browser Validation Matrix

| Environment | Widget Loads | SVG Send Button | Chips Work | Typing Works | Send Succeeds | Responses Render | Loading State | Friendly Errors |
|---|---|---|---|---|---|---|---|---|
| Desktop Chrome (Windows) | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Tested |
| Desktop Edge (Windows) | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Tested |
| Desktop Firefox (Windows) | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Tested |
| Android Chrome | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Code Reviewed | ✅ Tested |
| iPhone Safari | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device |
| iPad Safari | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device |
| Android PWA (Installed) | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device |
| iOS PWA (Installed) | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device | ⏳ Physical Device |

**Legend:**
- ✅ Code Reviewed — logic verified by code inspection and automated tests; no browser-specific risks identified
- ✅ Tested — automated regression test covers this path (32 tests, 32 pass)
- ⏳ Physical Device — requires physical device to confirm the P0-2 fix works on a real Safari/WebKit engine

> **iPhone / iOS PWA are the highest-risk environments** — they are the exact platforms where the P0-2 bug manifested. Physical device validation is mandatory before declaring those rows VERIFIED.

---

## 5. Regression Test Coverage

**Test file:** `scripts/test-kass-widget.js`  
**Run:** `node scripts/test-kass-widget.js`  
**Result (2026-07-14):** 32 passed / 0 failed

| # | Test | Covers |
|---|---|---|
| T1 | SVG array join produces valid SVG, not NaN | P0-1 fix |
| T2 | Unary-plus on SVG string produces NaN (old bug path verified) | P0-1 root cause |
| T3 | `_esc()` escapes `<`, `>`, `&`, `"` | XSS baseline |
| T4 | `_esc()` does not escape single quotes (known limitation) | Caller contract |
| T5 | `_safeUrl()` blocks `javascript:` | H1 security |
| T6 | `_safeUrl()` blocks `data:` | H1 security |
| T7 | `_safeUrl()` blocks `vbscript:` | H1 security |
| T8 | `_safeUrl()` allows safe URLs | H1 — no false positives |
| T9 | `_safeUrl()` HTML-escapes output | H1 + XSS |
| T10 | `_safeUrl()` fallback for empty/null | H1 — edge cases |
| T11 | `_friendlyMsg()` null/undefined → generic | P0-2 fix |
| T12 | `_friendlyMsg()` Safari iOS SYNTAX_ERR | P0-2 root cause |
| T13 | `_friendlyMsg()` iOS hostname-not-found | H7 |
| T14 | `_friendlyMsg()` iOS offline | H7 |
| T15 | `_friendlyMsg()` Chrome/Firefox "Failed to fetch" | H7 |
| T16 | `_friendlyMsg()` Firefox NetworkError | H7 |
| T17 | `_friendlyMsg()` Chrome `net::ERR_` | H7 |
| T18 | `_friendlyMsg()` AbortError / timeout | P0-2, H7 |
| T19 | `_friendlyMsg()` "cancelled" (Safari) | H7 |
| T20 | `_friendlyMsg()` unsupported browser feature | H7 |
| T21 | `_friendlyMsg()` passes through server messages | Regression guard |
| T22 | Sync `fetch()` throw → rejected Promise with friendly message | P0-2 core fix |
| T23 | Network `fetch()` rejection → propagated error | Error path |
| T24 | AbortError rolls back history | State integrity |
| T25 | Successful response adds to history | Happy path |
| T26 | AbortController guard with missing AbortController | iOS < 12.1 compat |
| T27 | Empty text blocked before send | Input validation |
| T28 | History slice limits to 20 messages | API safety |
| T29 | `auth_token` never appears in debug log | Security |
| T30 | `_md()` escapes XSS before markdown transforms | XSS |
| T31 | `_md()` renders bold and italic | Markdown rendering |
| T32 | Suggestion chips have non-empty `data-q` | Chip send flow |

---

## 6. Known Limitations

| Limitation | Impact | Mitigation |
|---|---|---|
| Physical device testing pending for Safari/iOS | High — P0-2 root cause is Safari-specific | Test on iPhone before GA; activate `?kassdebug=1` to capture diagnostics if issues recur |
| `_esc()` does not escape single quotes | Low — URLs are wrapped in double quotes in `href`; inline `onclick` uses single-quote delimiter with `_safeUrl()` checked for protocol injection | Documented in T4; callers must not use single-quote as HTML attribute delimiter for `_esc()` output |
| `sokoni-validate.js` sync-throw gap is documented but unfixed | Medium — only KASS widget has the try/catch guard; other pages calling fetch() directly could still surface raw WebKit errors | Document pattern in `sokoni-validate.js` (done); apply same pattern in any new fetch() call site |
| AbortController unavailable on iOS < 12.1 | Low — no timeout on those devices (35s implicit timeout instead) | Guarded: `ctrl = null`, `cSig = undefined` — fetch() proceeds without AbortSignal |

---

## 7. Evidence Key

| Status | Meaning |
|---|---|
| **Code Reviewed** | Logic verified by reading the source; no browser-specific risk identified |
| **Automated Test** | Covered by a named test in `scripts/test-kass-widget.js` (32 pass) |
| **Manually Verified** | Tested interactively in the development environment |
| **Physically Tested** | Tested on a physical device of that type |
| **PENDING** | Not yet verified — blocks VERIFIED status for that environment |

---

## 8. Production Readiness

| Dimension | Status | Notes |
|---|---|---|
| P0 bugs fixed | ✅ Code Reviewed + Automated Tests | Both root causes addressed |
| Security (URL injection) | ✅ Code Reviewed + Automated Tests | `_safeUrl()` guards all server-sourced URLs |
| Accessibility (close button) | ✅ Code Reviewed | `aria-hidden` removed from header; FAB `aria-expanded` added |
| Regression suite | ✅ 32/32 passing | `node scripts/test-kass-widget.js` |
| Desktop browsers | ✅ Code Reviewed | No browser-specific risks identified |
| iPhone Safari / iOS PWA | ⏳ Pending physical device | Highest risk — P0-2 was Safari-specific |

**Overall:** Ready to deploy. iPhone Safari and iOS PWA rows require physical validation to be fully VERIFIED. Use `?kassdebug=1` during device testing to capture diagnostic output.

---

## 9. Deployment Notes

- Service worker bumped to v72 (this session) and subsequently v74 (another process) — users will receive the new widget on next visit after SW update
- No Firestore schema changes
- No Cloud Function changes
- No Firebase index changes
- No secrets required
- Backward compatible — all changes are within `kass-widget.js`
