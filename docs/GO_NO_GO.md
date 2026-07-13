# SOKONI — Go / No-Go Report

**Standard:** RVS v1.0 · **Release:** v1.0.0-candidate · **Updated:** 2026-07-13
**Generated from** `release-gates.json` — the single source of truth. Do not edit by hand.

---

## Verdict

> # 🔴 NO-GO
>
> 0 of 10 critical gates VERIFIED. 9 are ENGINEERING COMPLETE (built, tested, unproven). 1 are NOT EXERCISED. Engineering Complete is not Production Proven.

---

## Gates

| | Gate | State | Notes |
| --- | --- | --- | --- |
| 🟡 | **Authentication** | ENGINEERING COMPLETE | App Check enforced; auth CFs live; validation mode traces init → getRedirectResult → claims → Firestore profile. Never executed on a real device. |
| 🟡 | **Identity** | ENGINEERING COMPLETE | CompanyIdentity canonical across 893 files; drift guard green. Client-side identity (claims, roles) never exercised per-role on a device. |
| 🟡 | **Legal** | ENGINEERING COMPLETE | Legal engine: 45 regression checks green, mandatory digital signature enforced, three lawful forms. No agreement has ever been signed by a real user. |
| ⚪ | **Payments (money path)** | NOT EXERCISED | ZERO orders have ever existed in production. The money path has never taken a shilling. 17 CI checks green and it fails closed — but that is engineering, not evidence. The next payment is SOKONI's first. |
| 🟡 | **Wallet** | ENGINEERING COMPLETE | Top-up confirms via provider callback and toasts on credit. Never credited a real user with real money. |
| 🟡 | **Notifications** | ENGINEERING COMPLETE | HIGHEST RISK. The fcmToken/fcmTokens defect is fixed and the engine is the one entry point. But push has NEVER been confirmed on a real device — and sendEachForMulticast() with zero tokens returns SUCCESS, which is exactly how a months-long outage hid behind a green dashboard. Queued is not Delivered. |
| 🟡 | **Email** | ENGINEERING COMPLETE | SendGrid key is real. The PO email now carries a PDF attachment. But 202 Accepted is not Delivered — no receipt and no PO has ever landed in a real inbox. |
| 🟡 | **Search** <br><sub>non-critical</sub> | ENGINEERING COMPLETE | 10 of 12 capabilities real (voice, barcode, QR, typo, autocomplete, trending, nearby, personalised). Image search is a stub. Never exercised on a device. |
| 🟡 | **Marketplace** | ENGINEERING COMPLETE | Browse/cart/checkout paths built; payment fails closed. Never driven end-to-end by a real buyer. |
| ⚪ | **SmartPOS** <br><sub>non-critical</sub> | NOT EXERCISED | Extensive engineering. No till has ever been opened on real hardware in production. |
| 🟡 | **Organizations / Procurement** | ENGINEERING COMPLETE | PO chain wired end to end; PDF validated by parsing its xref table. procSuppliers is EMPTY — no supplier exists, so no PO has ever been sent to anyone. |
| 🟡 | **Profile** <br><sub>non-critical</sub> | ENGINEERING COMPLETE | Built. Not exercised per-role on a device. |
| 🟡 | **Analytics** <br><sub>non-critical</sub> | ENGINEERING COMPLETE | 13 of 15 metrics real with drill-down. Every revenue figure is currently ZERO because no order has ever existed — any non-zero number on a dashboard today is seed or mock data. |
| 🟡 | **PWA / Service Worker** | ENGINEERING COMPLETE | Live SW matches repo. Validation mode flags a WAITING worker (the session would be running stale code). Offline, install, update, recovery and multi-device never exercised. |

---

## Money path — every step needs its own evidence

| Step | State |
| --- | --- |
| customer paid | ⚪ NOT EXERCISED |
| provider confirms | ⚪ NOT EXERCISED |
| order created | ⚪ NOT EXERCISED |
| inventory updated | ⚪ NOT EXERCISED |
| ledger updated | ⚪ NOT EXERCISED |
| commission correct | ⚪ NOT EXERCISED |
| settlement correct | ⚪ NOT EXERCISED |
| customer notified | ⚪ NOT EXERCISED |
| merchant notified | ⚪ NOT EXERCISED |
| refund path | ⚪ NOT EXERCISED |
| dispute path | ⚪ NOT EXERCISED |

> A single green tick over eleven unproven steps is not evidence.

---

## The rule that produced this verdict

> **Engineering Complete ≠ Production Proven.**
>
> A gate may not move from ⚪ NOT EXERCISED to 🟢 VERIFIED without execution.
> A gate may not be marked VERIFIED without evidence.
>
> **Queued is not Delivered. Accepted is not Completed. HTTP 200 is not Business Success.**

Enforced by `scripts/test-rvs.js` — it fails the build if a gate claims VERIFIED without
evidence, or if the verdict says GO while a critical gate is unproven. Both were tested by
deliberately faking them; both failed the build.

---

## What is NOT true today

- **Zero orders have ever existed.** The money path has never taken a shilling.
- **Push has never been confirmed on a device.** It reported "sent successfully" to zero devices for months.
- **No email or PO has ever landed in a real inbox.** `procSuppliers` is empty.
- Every revenue figure is **zero**. Any non-zero number on a dashboard is seed or mock data.

---

## Next

One real-device session (see `docs/RELEASE_VALIDATION_STANDARD.md`) moves gates from 🟡 to 🟢 —
or to 🔴 with a root cause and a regression test. **Nothing moves without evidence.**
