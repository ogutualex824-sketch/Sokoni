# Legal Compliance — Physical Device OAT

**Status:** ⏳ **NOT EXECUTED** · **Owner:** Operator (human, with real hardware)
**Gate:** Legal Compliance stays `ENGINEERING COMPLETE — PENDING PHYSICAL DEVICE VALIDATION`
until Android **and** iPhone **and** Tablet all PASS.

> Evidence-first. A test with no screenshot did not happen. Record the actual result,
> including failures — a fabricated PASS is worse than a missing one.

---

## Why this cannot be signed off from a desk

I ran every one of these checks in headless engines (Chromium + WebKit) and they passed
with zero JS errors. **That is not the same as a device, and I am not claiming it is.**

The gap that matters most: **drawing a signature with a finger.** Every automated pass so
far used a synthetic mouse. Real touch has pressure, palm rejection, coalesced pointer
events and `touch-action` interactions that a synthetic event does not reproduce. The
signature pad is the core of this feature and it is the least-verified part of it.

Also unverified without hardware: iOS keyboard resizing the viewport under the canvas ·
Safari's real download behaviour for a Blob PDF · rotation · pinch-zoom · notch
safe-areas · a real screen reader.

---

## Where to test

| Surface | URL |
|---|---|
| Signing flow | Any onboarding page (`onboarding.html`, `provider-onboarding.html`, `onboarding-driver.html`, `pos-setup.html`) |
| Legal Centre | `/legal-centre` — certificates, history, PDF download |
| Admin portal | `/legal-admin` — admin claim required |

Enforcement is **OFF**, so nothing is blocked. Sign as a test account, not a real one.

---

## ANDROID (Chrome) — real handset

| # | Test | Expected | Result | Evidence |
|---|---|---|---|---|
| A1 | **Draw signature** with a finger | Stroke follows the finger with no lag, no gaps, no page-scroll while drawing | ☐ | screenshot |
| A2 | Signature **accuracy** | The drawn line matches the path traced — not offset, not scaled | ☐ | screenshot |
| A3 | **Typed signature** | Name renders in the signature face; Continue enables | ☐ | screenshot |
| A4 | **Company stamp** upload | Image previews; >2 MB is rejected with a clear message | ☐ | screenshot |
| A5 | **Declaration** | 6 statements; "Activate my business" disabled until ticked | ☐ | screenshot |
| A6 | **PDF download** | File saves; opens in the Android PDF viewer | ☐ | screenshot |
| A7 | **QR readability** | Scan the QR in the PDF with the phone camera → resolves to the verify URL | ☐ | photo |
| A8 | **Rotation** | Rotate mid-signature: no crash, canvas is not blanked, layout reflows | ☐ | screenshot |
| A9 | **Keyboard** | Focus the name field: keyboard does not cover the input or the CTA | ☐ | screenshot |
| A10 | **Offline recovery** | Turn on airplane mode → download the certificate → valid PDF (QR may be absent) | ☐ | screenshot |
| A11 | **Scroll / pinch-zoom** | Page scrolls normally; drawing does NOT scroll the page; pinch-zoom works outside the canvas | ☐ | note |
| A12 | **No JS errors** | `chrome://inspect` → Console clean through the whole flow | ☐ | console screenshot |

## iPHONE (Safari) — real handset

| # | Test | Expected | Result | Evidence |
|---|---|---|---|---|
| I1 | **Finger signature** | Stroke tracks the finger; page does not rubber-band while drawing | ☐ | screenshot |
| I2 | Signature **accuracy** | Line matches the traced path | ☐ | screenshot |
| I3 | **Keyboard resize** | iOS keyboard opens: the pad/CTA are still reachable; the visual viewport shift does not break layout | ☐ | screenshot |
| I4 | **Safari download** of a Blob PDF | Safari accepts the `Blob` + `createObjectURL` download and saves/opens it | ☐ | screenshot |
| I5 | **Blob PDF opens** | Renders in Safari / Files with logo, QR and all fields | ☐ | screenshot |
| I6 | **QR verification** | Camera scan resolves to the verify URL | ☐ | photo |
| I7 | **Rotation** | Rotate mid-flow: no crash, canvas retained, safe-areas respected | ☐ | screenshot |
| I8 | **Offline recovery** | Airplane mode → download → valid PDF | ☐ | screenshot |
| I9 | **No JS errors** | Safari Web Inspector console clean | ☐ | console screenshot |

**I4 is the highest-risk item.** Safari has historically been the strictest browser about
programmatic `Blob` downloads. If it fails, capture the exact behaviour — do not work
around it locally; report it.

## TABLET — real device

| # | Test | Expected | Result | Evidence |
|---|---|---|---|---|
| T1 | **Portrait** | Layout correct, no horizontal scroll | ☐ | screenshot |
| T2 | **Landscape** | Layout correct; the signature pad is still usable | ☐ | screenshot |
| T3 | **Stylus signature** | Apple Pencil / S-Pen draws cleanly; no offset from the tip | ☐ | screenshot |
| T4 | **Finger signature** | As above, with a finger | ☐ | screenshot |
| T5 | **PDF rendering** | Certificate renders correctly at tablet size | ☐ | screenshot |
| T6 | **QR verification** | Scan resolves | ☐ | photo |
| T7 | **No JS errors** | Console clean | ☐ | console screenshot |

## ACCESSIBILITY — on a device, not an emulator

| # | Test | Expected | Result | Evidence |
|---|---|---|---|---|
| X1 | **Screen reader** (TalkBack / VoiceOver) | Every step is announced; the agreement modal is announced as a dialog; the typed-name field is reachable | ☐ | recording/notes |
| X2 | **Typed fallback reachable** | A user who cannot draw can complete signing by typing — end to end | ☐ | screenshot |
| X3 | **Large text** (200% / largest OS setting) | Nothing clips, nothing overlaps, CTAs stay tappable | ☐ | screenshot |
| X4 | **Touch targets** | Every control ≥ 44 px in practice, not just in CSS | ☐ | note |

---

## Recording the result

For each device: **PASS** only if every row passes. One failure ⇒ that device is **FAIL**,
and Legal Compliance stays `PENDING PHYSICAL DEVICE VALIDATION`.

```
Device: ................  OS/browser: ................  Date: ........
Tester: ................
Result: PASS / FAIL
Failures (id + what actually happened + screenshot):
```

Report failures verbatim. **Do not fix anything on the device, and do not adjust the
expected result to match the observed one.**
