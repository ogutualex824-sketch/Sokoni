# Enterprise Print Engine — Architecture

**Status:** CORRECTED 2026-07-22 — see §0-A. The original convergence thesis is superseded.
**Date:** 2026-07-21
**Related:** [[SmartPOS]] · [[Payments]] · [[Platform Constitution]] · [[Universal Printer Engine v3.0]]

---

## 0-A. CORRECTION — 2026-07-22: the subsystem is layered, not duplicated

**Everything below section 0-A was written from a static count and is wrong in
its central claim.** It counted modules that contain ESC/POS bytes and concluded
the platform had "eleven print engines" that must converge to one. A per-module
behavioural audit — complete public API, unique methods, external call sites,
and output protocol for each — found **zero true duplicates**. Acting on the
original thesis would have caused a production outage.

The subsystem is a **layered architecture**. Each module occupies exactly one
layer and every one of them is load-bearing.

### Layer diagram

```
  ┌──────────────────────────────────────────────────────────────┐
  │ L6  RECEIPT UI          pos-receipt-engine.js                │
  │                         (show/generate/downloadPDF/WhatsApp) │
  ├──────────────────────────────────────────────────────────────┤
  │ L5  BUSINESS DOCUMENTS  sokoni-print-engine.js  (6 A4 docs,  │
  │                           Firestore branding, retry queue)   │
  │                         sokoni-pos-print-service.js  (~15    │
  │                           POS doc types, audit, reprint)     │
  ├──────────────────────────────────────────────────────────────┤
  │ L4  FLEET MANAGER       sokoni-pos-print.js  (IndexedDB      │
  │                           printer registry, role routing)    │
  ├──────────────────────────────────────────────────────────────┤
  │ L3  ADAPTER / PROFILE   sokoni-printer-manager.js (.p58e     │
  │                           proxy, PRINTER_PROFILES, platform) │
  │                         sokoni-bluetooth-printer.js (P58E)   │
  ├──────────────────────────────────────────────────────────────┤
  │ L2  PROTOCOL LIBRARY    sokoni-printer-drivers.js  (stateless│
  │                           ESC/POS · TSPL · ZPL · CPCL)       │
  │                         sokoni-receipt-engine.js  (thermal   │
  │                           receipt bytes + buildShippingLabel)│
  ├──────────────────────────────────────────────────────────────┤
  │ L1  TRANSPORT           sokoni-universal-printer.js  ← canon │
  │                           (Bt/Usb/Serial/Network/Browser)    │
  │                         pos-printer.js  (pos.html's own      │
  │                           transport + the only sendRaw sink) │
  └──────────────────────────────────────────────────────────────┘
```

### Module table

| Module | Layer | Unique capability | External callers | Merge? |
|---|---|---|---|---|
| `sokoni-universal-printer.js` | L1 transport | 5 adapters + queue + encoder | 2 pages | **NO** — canonical |
| `pos-printer.js` | L1 transport | `sendRaw` (only byte sink on pos.html), `printBrowser`, `buildQR` | **9 files** | **NO** |
| `sokoni-printer-drivers.js` | L2 protocol | raster `logoBytes`, 7 barcode symbologies, eTIMS/KRA block | 3 | **NO** |
| `sokoni-receipt-engine.js` | L2 protocol | thermal primitives, `buildShippingLabel()` | label engine | **NO** |
| `sokoni-bluetooth-printer.js` | L3 adapter | P58E profile | 3 | **NO** — already an adapter |
| `sokoni-printer-manager.js` | L3 adapter | `.p58e` proxy, `PRINTER_PROFILES`, `detectPlatform`/`getConnectionPriority` | 2 (~70 sites) | **NO** |
| `sokoni-pos-print.js` | L4 fleet | IndexedDB registry, `printFulfilment` routing, Serial, Android bridge | 3 | **NO** |
| `sokoni-print-engine.js` | L5 documents | Firestore branding, 6 A4 templates | 4 | **NO** |
| `sokoni-pos-print-service.js` | L5 documents | ~15 doc types, audit trail, reprint, CSV | 2 | **NO** |
| `pos-receipt-engine.js` | L6 UI | on-screen receipt, PDF, WhatsApp share | pos.html | **NO** |

**No module may merge.** Each has ≥4 methods with no equivalent elsewhere and
≥2 external consumer files.

### Why the count misled — twice

Four modules expose a method named `print`; three expose `printLabel`. The
signatures and protocols are mutually incompatible:

- `PosPrinter.printLabel(products)` → renders **HTML** for `window.print()`
- `SokoniPosprint.printLabel(job)` → emits **TSPL/ZPL bytes**

Same name, opposite protocol. The same error was made independently about the
two receipt engines (see ADR-0002). **A shared method name is not shared
behaviour; an ESC/POS table is not a duplicate engine.**

### 5. Safe cleanup — no deletions

| # | Item | Action |
|---|---|---|
| 1 | `pos.html:1449-1450` loads `printer-manager` + `pos-print-service` **without** their dependency `sokoni-universal-printer.js` | **Missing dependency injection.** Add the canonical engine, or drop the two inert tags. Verify the `pos.html:279` health chip first. |
| 2 | `sokoni-printer-driver.js:468` assigns `SokoniPrinterDrivers` with a **different shape** than `sokoni-printer-drivers.js:5` | **Global conflict — rename the singular.** Latent only because no page loads both; co-loading breaks `sokoni-receipt-engine.js:88`. |
| 3 | `pos-hardware-setup.html:945` calls `HardwareManager.confirmAndSave()` **unguarded**; no page loads its definition | **Missing dependency.** Latent because the page is 404. |
| 4 | `sokoni-printer-providers.js` | **Dead code** — zero references repo-wide. Only true deletion candidate found. |
| 5 | `sokoni-pos-ios-print.js` self-describes as called by `PosPrintService` on iOS; no such call site found | **UNCERTAIN** — needs its own pass before any action. |

### Governing rule

Do not delete a printing module on the basis of a name, a global, or an encoder
count. Only a behavioural audit proving identical API **and** identical protocol
**and** zero unique capability **and** zero external consumers may justify
removal. Otherwise **rename, layer, document, or fix the dependency.**

---

## 0. The finding that shapes this design *(SUPERSEDED — see 0-A)*

The brief asks for a Universal Print Engine to be designed from scratch. **It already exists**, and
building a second one would be the most damaging thing this document could recommend.

Audit of the repository, 2026-07-21:

| | Count | Evidence |
|---|---|---|
| Client printing modules | **11** | `sokoni-universal-printer.js` (81 KB), `sokoni-pos-print-service.js` (54 KB), `sokoni-printer-manager.js` (47 KB), `sokoni-bluetooth-printer.js` (40 KB), `sokoni-print-engine.js` (39 KB), `sokoni-pos-print.js` (33 KB), `sokoni-pos-ios-print.js` (31 KB), `pos-printer.js` (22 KB), `sokoni-printer-drivers.js` (20 KB), `sokoni-printer-discovery.js` (16 KB), `pos-receipt-engine.js` |
| Files encoding ESC/POS bytes | **12+** | incl. `functions/index.js`, `pos-mobile.js`, `sokoni-cash-drawer.js`, `sokoni-label-engine.js` |
| Pages loading the canonical engine | **2** | `pos-checkout.html`, `pos-printer-setup.html` |

`sokoni-universal-printer.js` already implements most of what the brief specifies:

- **Adapter architecture** — `BtAdapter` (:891), `UsbAdapter` (:1082), `SerialAdapter` (:1126),
  `NetworkAdapter` (:1205), `BrowserAdapter` (:1263), registered in `this._adapters` (:1284)
- **Persistent queue** — `spp_queue` in localStorage (:801), states `pending → processing → done |
  failed | cancelled`, with `priority` (:817), `attempts` (:819) and retry (:849)
- **ESC/POS command table** (:60) including the real-time status probe `DLE 0x04 0x01` for
  paper / cover / drawer
- **P58E support already present** — :899 matches the Chinese BLE printer service UUID
  `0000ff00-…` by name prefix (`MTP`, `Rongta`, `Xprinter`, Goojprt)

**Therefore this document specifies a DELTA and a CONVERGENCE, not a rewrite.** A twelfth engine
would add a twelfth ESC/POS encoder to a codebase whose actual defect is that it has eleven.

---

## 1. Architecture

```
Receipt Builder            (pos-receipt-engine.js — unchanged)
      ↓  document object, never bytes
ESC/POS Formatter          (sokoni-universal-printer.js CMD table — canonical)
      ↓  PrintJob { bytes, encoding, paperWidth, … }
Print Queue                (spp_queue — persistent, exists)
      ↓
Transport Selector         ← NEW (§4): scores adapters, picks highest viable
      ↓
Transport Adapter          ← 5 exist, 4 to add (§3)
      ↓
Printer
      ↓
Telemetry                  ← NEW (§7)
```

**The invariant:** the Receipt Builder emits a *document*, never bytes, and never names a transport.
Everything below the formatter is replaceable without touching it. This is what makes the native
bridge a drop-in later.

---

## 2. Transport adapter interface

Existing adapters already expose `discover/connect/print/status`. The interface is formalised to the
brief's eight methods; the four existing gaps are additive and default-implementable in a base class,
so **no existing adapter has to be rewritten**.

```js
class TransportAdapter {
  static id;                       // 'bluetooth' | 'gateway' | 'native' | …
  static score;                    // §4
  async initialize(ctx)            // idempotent; safe to call repeatedly
  async discover(opts)             // → [{ id, name, meta }]
  async connect(deviceInfo)        // → connection handle
  async print(job)                 // → { ok, bytesSent, ms }
  async test()                     // → { ok, detail } — never throws
  async disconnect()
  async status()                   // → { online, paper, cover, drawer }
  capabilities()                   // → { escpos, maxBytes, needsGesture, offline }
}
```

`initialize()` and `capabilities()` are the two that matter for the future bridge: a host that cannot
support an adapter reports it through `capabilities()` rather than by throwing on first use — the
same principle already applied in `pos-hardware-wizard.js`, where a browser that lacks an API says so
instead of failing a scan.

---

## 3. Adapters — existing and to add

| Adapter | Status | File |
|---|---|---|
| `BtAdapter` | **exists** :891 | `sokoni-universal-printer.js` |
| `UsbAdapter` | **exists** :1082 | ” |
| `SerialAdapter` | **exists** :1126 | ” |
| `NetworkAdapter` | **exists** :1205 | ” |
| `BrowserAdapter` | **exists** :1263 | ” |
| `GatewayAdapter` | **ADD** | §5 — the fix for the LAN limitation |
| `NativeBridgeAdapter` | **ADD** | §6 — postMessage contract |
| `CloudRelayAdapter` | **ADD** | wraps `posPrint`, only for reachable hosts |
| `MockAdapter` | **ADD** | deterministic tests without hardware |

---

## 4. Transport selection — the main functional gap

No scoring exists today; selection is by explicit type. Add a selector that asks each registered
adapter for `capabilities()` and picks the highest scoring **viable** one.

| Transport | Score | Rationale |
|---|---|---|
| Native bridge | 100 | OS-level access, no browser limits |
| Gateway (LAN) | 95 | reaches the printer; survives browser restarts |
| Android bridge | 90 | native, platform-restricted |
| Desktop bridge | 85 | native, platform-restricted |
| Bluetooth (Web) | 80 | direct, but desktop/Android only |
| USB (Web) | 78 | direct, requires gesture |
| AirPrint | 75 | works on iOS; no ESC/POS, no drawer |
| Browser print | 60 | universal, no cash drawer, user-visible dialog |
| Cloud relay | 40 | only for publicly reachable printers |
| Mock | 10 | tests only; never selected when any real transport is viable |

**Score is static; viability is dynamic.** A transport is viable only if `capabilities()` reports it
usable on this host *and* the job's needs are met — a job that must kick a cash drawer cannot select
AirPrint or Browser at any score.

---

## 5. Network Gateway — the fix for the current dead end

**Today network printing cannot work on any platform.** `posPrint` (`functions/index.js:5069`)
validates that the host is a private/LAN address — correct anti-SSRF practice — but runs in Google
Cloud, which cannot route to `192.168.x.x` on a merchant's LAN. The only accepted hosts are precisely
the unreachable ones.

```
Browser ──HTTPS──▶ Gateway (on the LAN) ──TCP:9100──▶ Printer
```

The gateway is a small local process (Android service, desktop tray app, or Pi). The browser never
opens a raw socket, so no browser limitation applies, and the gateway owns discovery, connection,
status and printing.

**Contract:** `POST /print` (job), `GET /status`, `GET /discover`. Authenticated with a merchant-scoped
token, origin-pinned to `mysokoni.co.ke`. Because the gateway is on the LAN it is reachable from the
browser over the local network — which the Cloud Function fundamentally is not.

This is also why `TRANSPORT_HOSTS.network` is `false` for every in-browser host in
`pos-hardware-wizard.js` today: it becomes `true` the day a gateway exists, and that is a one-line
change.

---

## 6. Native bridge — designed now, added later

```js
// Browser → bridge
window.postMessage({ ns: 'sokoni.print', v: 1, id, cmd: 'print', payload: { jobId, bytesB64, printerId } }, origin)
// bridge → browser
{ ns: 'sokoni.print', v: 1, id, ok: true, result: { bytesSent, ms } }
```

**Rules that keep the browser unchanged when the bridge arrives:** every message carries `ns` and `v`;
the browser validates `event.origin` and `ns` before reading any field; unknown `cmd` is rejected, not
ignored; and the bridge is discovered by feature detection (`window.SokoniBridge?.version`), never by
user agent. Adding it means registering `NativeBridgeAdapter` — no UI, queue, registry or receipt
change.

---

## 7. Print job, queue and state machine

```
queued → preparing → printing → completed
              ↓          ↓
           failed ←──────┘
              ↓
          retrying → printing
              ↓
          cancelled
```

Job record (extends the existing `spp_queue` entry rather than replacing it):

`jobId · createdAt · merchantId · storeId · printerId · transport · copies · bytes · encoding ·
paperWidth · priority · attempts · checksum · status · lastError`

**`checksum` is load-bearing:** the queue is persisted in localStorage, which a merchant can edit and
a corrupt write can truncate. A job whose bytes fail their checksum is quarantined rather than sent —
malformed ESC/POS can leave a thermal printer in an undefined state requiring a power cycle.

**Retry:** exponential backoff 1s → 2s → 4s → 8s, max 5 attempts, then `failed` with a retained
reason. Non-retryable failures (permission denied, unknown printer, checksum mismatch) skip retry —
retrying them only delays the operator learning the truth.

---

## 8. Security model

| Surface | Control |
|---|---|
| Printer / gateway address | allowlist charset `[A-Za-z0-9.\-]`, length ≤ 253, validated **on write** — the pattern already applied in `pos-hardware-wizard.js` `_validHost()` |
| Gateway URL | scheme must be `https:` or a private-LAN `http:`; never user-rendered unescaped |
| Bridge messages | `event.origin` pinned; `ns` + `v` required; unknown `cmd` rejected |
| Receipt data | escaped before render; ESC/POS built from the CMD table only, never string concatenation of raw bytes |
| Replay | `jobId` is a UUID; the gateway rejects a `jobId` seen within 24 h |
| Unauthorised printing | job carries `merchantId`; gateway token is merchant-scoped |

**Command injection is the specific ESC/POS risk:** a receipt field containing `0x1B` could terminate
the current command and inject another. Text fields must be byte-filtered before encoding — control
bytes below `0x20` stripped except the intended `LF`.

---

## 9. Performance

The queue is per-device, not global, so "10,000 queued jobs" is a per-terminal figure. localStorage
caps at ~5 MB; at ~4 KB per receipt that is ~1,200 jobs before eviction, so **the queue must migrate
to IndexedDB** (already a dependency) with localStorage kept only as a crash-recovery pointer.

100 concurrent merchants and 1 M users impose no shared bottleneck **because printing is
device-local** — this is the one subsystem that does not scale through the backend. The only shared
component is `CloudRelayAdapter`, which is why it scores 40 and is not the default path.

---

## 10. Migration plan

| Phase | Action | Risk |
|---|---|---|
| 1 | Formalise `TransportAdapter` base class; existing 5 adapters extend it | none — additive |
| 2 | Add `MockAdapter` + selector with scoring; keep explicit selection as override | low |
| 3 | Move queue to IndexedDB, retain localStorage recovery pointer | medium — needs migration of in-flight jobs |
| 4 | Add `GatewayAdapter`; flip `TRANSPORT_HOSTS.network` when a gateway is present | low — new path, old untouched |
| 5 | Add `NativeBridgeAdapter` | low |
| 6 | **Converge the other 10 modules** — route each to the canonical engine, delete duplicate ESC/POS encoders | **highest value, highest effort** |

**Phase 6 is the real work.** Phases 1–5 add capability; phase 6 removes the eleven-engine problem
that made this brief necessary. It should be done one module at a time, each with its own
verification, in the manner of the entitlement-adapter migration.

### Files to create
- `sokoni-print-transport.js` — base class, selector, scoring registry
- `sokoni-print-gateway.js` — `GatewayAdapter`
- `sokoni-print-bridge.js` — `NativeBridgeAdapter` + postMessage contract
- `scripts/test-print-engine.js` — `MockAdapter`-driven state-machine tests

### Files to modify
- `sokoni-universal-printer.js` — adapters extend the base; queue → IndexedDB
- `pos-hardware-wizard.js` — `TRANSPORT_HOSTS.network` true when a gateway is detected
- `functions/index.js` — `posPrint` restricted to genuinely reachable hosts, or retired in favour of the gateway

### Files to retire (phase 6, one at a time)
`sokoni-print-engine.js` · `sokoni-pos-print.js` · `sokoni-pos-print-service.js` ·
`sokoni-printer-manager.js` · `sokoni-printer-drivers.js` · `sokoni-printer-discovery.js` ·
`sokoni-bluetooth-printer.js` · `sokoni-pos-ios-print.js`

---

## 10a. Dependency graph — measured, not assumed

Script-tag consumers per module (2026-07-21):

| Module | KB | Pages loading it | Global | Verdict |
|---|---|---|---|---|
| `sokoni-universal-printer.js` | 79 | 2 — checkout, printer-setup | `SokoniPrinter` | **CANONICAL** |
| `sokoni-bluetooth-printer.js` | 39 | 3 | `P58EPrinter` | **KEEP — layer** |
| `pos-receipt-engine.js` | 40 | 1 | `SokoniReceiptEngine` | **KEEP — builder** |
| `sokoni-pos-print-service.js` | 53 | 3 | `PosPrintService` | duplicate → migrate |
| `sokoni-printer-manager.js` | 46 | 3 | `PrinterManager` | duplicate → migrate |
| `sokoni-print-engine.js` | 38 | 2 | `SokoniPrint` | duplicate → migrate |
| `pos-printer.js` | 21 | 4 | `PosPrinter` | duplicate → migrate |
| `sokoni-pos-print.js` | 32 | 1 | `SokoniPosprint` | duplicate → migrate |
| `sokoni-pos-ios-print.js` | 30 | 1 | `—` | duplicate → migrate |
| `sokoni-printer-drivers.js` | 20 | 1 | `SokoniPrinterDrivers` | duplicate → migrate |
| `sokoni-printer-discovery.js` | 16 | 1 | `SokoniPrinterDiscovery` | duplicate → migrate |

**`pos.html` loads nine printing modules simultaneously — roughly 285 KB of overlapping code on the
till page.** `pos-checkout.html` loads five. That, not a missing engine, is the production cost.

### Correction to §0

`sokoni-bluetooth-printer.js` is **not** a duplicate. Its header states *"Depends on:
sokoni-universal-printer.js (must load first)"*, and it implements a P58E **profile** — BLE service
`0000ff00` for Goojprt / Jepod / HOIN clones, 58 mm / 32 columns, plus `requestAndPair`,
`autoConnect`, `printTestReceipt`, `forget`. Engine + device-profile is already the correct two-tier
shape and must be preserved, not collapsed.

This also corrects a claim made while auditing the hardware wizard: the platform is **not** ignorant
of the P58E. The wizard's registry was, and now is not; the printing subsystem has had a dedicated
P58E driver all along.

### Migration order — fewest consumers first

Risk rises with consumer count, so the order is ascending:

1. `sokoni-printer-discovery.js` · `sokoni-printer-drivers.js` · `sokoni-pos-print.js` ·
   `sokoni-pos-ios-print.js` — 1 page each
2. `sokoni-print-engine.js` — 2 pages
3. `sokoni-printer-manager.js` · `sokoni-pos-print-service.js` — 3 pages
4. `pos-printer.js` — 4 pages, **last**

Each step: route the module's global to the canonical engine as a thin compatibility shim, verify the
page, then delete the shim once no caller remains. Never two modules in one release.

**Expected reduction:** ~285 KB → ~120 KB on `pos.html` (engine + P58E profile + receipt builder).

## 11. Recommendation

**Do not build a new engine.** Adopt `sokoni-universal-printer.js` as canonical, add the selector,
gateway and bridge adapters, and spend the remaining effort on convergence.

The merchant blocked today — P58E on an iPhone — is unblocked by **phase 4 alone**: a LAN gateway
makes the printer reachable from a browser that has no Bluetooth API. That is the shortest path from
this design to a working till.
