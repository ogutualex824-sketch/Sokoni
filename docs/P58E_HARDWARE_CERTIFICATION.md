# SOKONI SmartPOS — P58E Hardware Certification

**Printer:** Goojprt P58E 58mm Bluetooth ESC/POS Thermal Printer  
**Certified:** 2026-07-13  
**Certified by:** Alex Ogutu (SOKONI Engineering)  
**Environment:** Windows 11 Pro, Chrome (latest), BLE 5.0

---

## Certification Status: CERTIFIED — Production Ready

The P58E printer is **officially certified** as the primary supported hardware for SOKONI SmartPOS Phase 0.

---

## Physical Hardware Test Results

| Test | Result | Notes |
|---|---|---|
| Windows Bluetooth pairing | **PASS** | PIN 0000, automatic |
| BLE service discovery | **PASS** | Service `0000ff00`, char `0000ff02` |
| GATT connection via Web Bluetooth | **PASS** | Chrome 85+ required |
| ESC/POS initialization (`ESC @`) | **PASS** | Printer acknowledges init |
| Paper feed command | **PASS** | Paper advances on LF |
| Short receipt print (32B) | **PASS** | Phase A verified |
| Medium receipt print (~200B) | **PASS** | Phase B verified |
| Full production receipt (~994B) | **PASS** | Phase C verified after MTU fix |
| QR code print | **PASS** | GS ( k sequence, size 4 |
| Code128 barcode print | **PASS** | Type 73, height 48, width 2 |
| Consecutive receipt printing | **PASS** | 5 receipts without disconnect |
| Auto-reconnect after browser authorize | **PASS** | `getDevices()` — no picker required |

---

## Root Causes Identified and Resolved

### Issue 1: GATT write failure on full receipt (~994 bytes)

**Error:** `GATT operation failed for unknown reason`  
**Root cause:** `writeValueWithoutResponse()` called with a 512-byte chunk, exceeding the P58E's negotiated ATT MTU.  
**Fix:** MTU probe runs automatically after GATT connection. P58E accepted max 128 bytes per write. `sokoni-universal-printer.js` BLE write loop now uses 128-byte chunks with 40ms inter-packet delay and per-packet 3-retry.

### Issue 2: "User cancelled the requestDevice() chooser" loop

**Root cause:** Chrome's picker shows "Paired" badge (Windows OS pairing status) and users close the dialog thinking the job is done. Each close produces a "User cancelled" error, not a Bluetooth failure.  
**Fix:** `getDevices()` path — after first authorization, page reconnects silently with no picker. Added explicit step-by-step instructions in the test page UI.

---

## BLE Transport Configuration (Verified)

| Parameter | Value | Source |
|---|---|---|
| BLE Service UUID | `0000ff00-0000-1000-8000-00805f9b34fb` | P58E / Goojprt primary |
| Write Characteristic UUID | `0000ff02-0000-1000-8000-00805f9b34fb` | P58E write |
| Write method | `writeValueWithoutResponse` | Faster; no ACK required |
| Max chunk size (MTU probe result) | **128 bytes** | Physically verified |
| Inter-packet delay | **40ms** | Required for P58E BLE buffer |
| Per-packet retry | 3 attempts, 150ms/300ms backoff | Hardened post-certification |
| Connection timeout | 12 seconds | Prevents indefinite hang |
| Health monitor interval | 5 seconds | Catches stale connections |

---

## Receipt Format (58mm / 32 chars)

| Element | Status | Notes |
|---|---|---|
| Store name (double height) | **PASS** | `sz('tall')` renders correctly |
| Left-aligned text | **PASS** | 32-char width |
| Column layout (item / qty / amount) | **PASS** | `padEnd` + `padStart` |
| Separator lines | **PASS** | 32× `-` or `=` |
| Bold total line | **PASS** | `bold(true).sz('tall')` |
| VAT line (16%) | **PASS** | Displayed and calculated correctly |
| M-Pesa reference | **PASS** | Free-text field |
| QR code (receipt URL) | **PASS** | Scan-for-digital-receipt |
| Code128 barcode | **PASS** | Receipt number |
| Auto-cut | **PASS** | `GS V 0` command |
| Footer / thank you | **PASS** | 3 LF before cut |

---

## Default Merchant Profile

After certification, the following defaults are persisted in `localStorage`:

```json
{
  "autoConnect":   true,
  "drawerEnabled": true,
  "paperWidth":    "58mm",
  "mtuBytes":      128,
  "chunkDelay":    40,
  "template":      "standard",
  "registerName":  "Register 01",
  "certifiedAt":   "2026-07-13T...",
  "printCount":    0
}
```

A cashier configures the printer once. Every subsequent POS session auto-connects via `getDevices()` with no user interaction required (browser security model: Chrome 85+, same Chrome profile, same file path).

---

## Browser Requirements

| Browser | Supported | Notes |
|---|---|---|
| Chrome 85+ (Windows/Mac/Linux) | **Yes — Required** | Web Bluetooth + getDevices() |
| Edge 85+ | Limited | Web Bluetooth available; getDevices() may vary |
| Firefox | **No** | Web Bluetooth not implemented |
| Safari | **No** | Web Bluetooth not implemented |
| Chrome for Android | Limited | Web Bluetooth available; file:// path varies |

---

## Recommended for Phase 0

| Printer | Certified | Notes |
|---|---|---|
| **P58E (Goojprt)** | **YES** | Primary — physically verified 2026-07-13 |
| P58E-A / P58E-B variants | Expected | Same BLE profile; unverified |
| HOIN HOP-E58 | Expected | Same service UUID |
| Generic Chinese 58mm BLE | Likely | Try `0000ff00` service; may need chip size reduction |

---

## Known Limitations

1. **No printer status feedback** — ESC/POS status commands over BLE are not reliable on P58E. Out-of-paper and cover-open states cannot be detected programmatically.
2. **Bitmap logo** — Raster image printing requires Canvas API and image load from a secure origin. Not tested in Phase 0 (using text logo `[ S O K O N I ]`).
3. **Cash drawer** — Printer must support `ESC p` signal output on RJ11 port. Not verified (no drawer available at time of testing).
4. **getDevices() scope** — Authorization is tied to Chrome profile + file path origin. If the HTML file is moved or renamed, re-pairing via the picker is required once.

---

## Unverified Items (Phase 1 Targets)

- [ ] Cash drawer kick (`ESC p` via RJ11)
- [ ] Out-of-paper detection
- [ ] Bitmap logo printing
- [ ] Android Chrome connection
- [ ] Printer via USB-C (Web USB transport)
- [ ] Multi-printer support (two printers, one for kitchen, one for receipts)
- [ ] Print via Web Serial (USB cable fallback)

---

## Related Files

| File | Purpose |
|---|---|
| `sokoni-bluetooth-printer.js` | P58E connection manager, health monitor, profiles |
| `sokoni-universal-printer.js` | ESC/POS encoder, BLE write transport (MTU-aware) |
| `pos-printer-hardware-test.html` | Physical hardware test tool (10-step protocol) |
| `pos-printer.js` | Foundation ESC/POS module |

---

*SOKONI SmartPOS — P58E Hardware Certification v1.0 — 2026-07-13*
