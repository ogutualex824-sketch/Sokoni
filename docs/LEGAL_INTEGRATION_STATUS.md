# Legal Compliance — Integration Status

**Date:** 2026-07-13 · **Commits:** `55b9aeb` (Legal Centre + PDF) · `d5b0a2f` (Admin panel)
**Deployed:** `legal-centre` · `legal-admin` · `sokoni-legal-certificate.js` — all HTTP 200

# 🟡 STATUS: **NOT COMPLETE**

You said: *"Mark Legal Compliance COMPLETE only after the UI integration and device
verification have passed."*

**UI integration: passed. Device verification: NOT DONE.**
Therefore this is **not** marked complete. See "The one thing blocking COMPLETE" below.

---

## Priority 1 — Legal Centre wired ✅

Uses **only deployed ops**. No backend API added or changed; `functions/` untouched.

| Requirement | Op used |
|---|---|
| View certificates | `legalMyCertificates` |
| Download certificates | `legalGetCertificate` → PDF |
| Agreement history | `legalGetMyAcceptances` |
| Declaration history | `legalGetCertificate` (`declarationAccepted` + text) |
| Signature history | `legalMyCertificates` (each row = one signing event) |
| Current agreement versions | `legalGetAgreements` |

The detail view fetches via `legalGetCertificate`, so the user sees exactly what the
**server** holds — not a client-side reconstruction of it.

## Priority 2 — Real PDF certificate ✅

`sokoni-legal-certificate.js` writes a genuine PDF 1.4: catalog/pages/page, xref table,
Helvetica + Helvetica-Bold **text objects** (selectable, searchable — not a screenshot),
two JPEG XObjects (logo + QR). **Opened and rendered in Chrome's PDF viewer.**

All 14 required fields present: SOKONI logo · title · user name · business name ·
merchant/provider ID · agreement versions · signature type · signature hash ·
acceptance ID · declaration ID · country · server timestamp · verification QR ·
certificate number.

**Two bugs found by rendering it, not by reading it:**

1. Drawing `assets/sokoni-icon.svg` onto a canvas **taints** it → `toDataURL()` threw
   `SecurityError` → the entire PDF failed to generate. The SOKONI mark is now drawn
   with canvas primitives: no asset fetch, no taint, and it works with no network.
2. The QR block was pinned at a fixed `y` and rendered **on top of** the declaration
   text. It now flows below the content, floored so it always clears the footer.

The QR is a **convenience, not evidence** — it encodes a verification URL, and
verification is the server confirming the certificate id. The certificate says so.

## Priority 3 — Admin panel ✅

`legal-admin.html`. **9 ops, all pre-existing, zero new APIs.**

Preview (incl. at a future time) · Publish now · Schedule · Roll back · Version history ·
Search acceptances · Adoption + compliance report · Export audit log (JSON + CSV).

Destructive actions confirm first and spell out the consequence. Buttons disable in
flight — a double-click must not publish twice. The page hides itself from non-admins,
but that is a **courtesy, not the control**: every op re-checks admin server-side
(`_assertAdmin`), so forcing the page open achieves nothing.

## Priority 4 — OAT ⚠️ PARTIAL

Ran across 4 targets. **Everything passed** — but on **engines, not devices**.

| Check | Android¹ | iPhone¹ | Tablet¹ | Desktop Chrome |
|---|---|---|---|---|
| Draw signature | PASS | PASS | PASS | PASS |
| Typed signature | PASS | PASS | PASS | PASS |
| Company stamp | PASS | PASS | PASS | PASS |
| Professional declaration | PASS | PASS | PASS | PASS |
| Certificate generation | PASS | PASS | PASS | PASS |
| Download (PDF) | PASS | PASS | PASS | PASS |
| QR verification | PASS | PASS | PASS | PASS |
| Accessibility² | PASS | PASS | PASS | PASS |
| Offline recovery³ | PASS | PASS | PASS | PASS |
| **No JavaScript errors** | **NONE** | **NONE** | **NONE** | **NONE** |

¹ **Engine only — NOT a physical device.** WebKit is Safari's rendering engine;
Chromium at 412×915 is not an Android handset.
² `role="dialog"` + `aria-modal`, ESC closes, all tap targets ≥ 44px, consent box never
pre-ticked.
³ Offline: a valid PDF still downloads with the logo intact (canvas-drawn, no network);
the QR degrades gracefully because it needs the CDN. Verified on **both** engines by
capturing the actual download.

**A false FAIL I chased down:** the first OAT run reported offline recovery failing on
WebKit. The cause was my **test** calling `blob.text()`, which WebKit rejects on
`file://` (`"The I/O read operation failed."`). The product never calls it — the download
path uses `URL.createObjectURL`. Re-verified by capturing the real download: it passes.

---

## The one thing blocking COMPLETE

**No physical-device testing.** I have no iPhone, Android handset or tablet. Not covered
and **not claimed**: real touch input (drawing a signature with a finger vs. a synthetic
mouse), iOS notch safe-areas, the iOS keyboard resizing the viewport under the signature
pad, Safari's real download behaviour for a Blob PDF, and Home-screen PWA mode.

**Drawing a signature with a finger is the single thing most likely to behave differently
on real hardware, and it is the core of this feature.**

To close: run the flow on a real Android phone, a real iPhone and a real tablet — draw,
type, stamp, declare, download, scan the QR. Then this can be marked **COMPLETE**.

## Also still open

- **Enforcement is dark-launched.** Nothing is blocked yet. Flip per role with
  `legalSetEnforcement({ role, enabled: true })` when you're ready.
