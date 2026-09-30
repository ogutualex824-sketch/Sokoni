# Wi-Fi / LAN printing — the SOKONI Print Bridge (2026-10-01)

**Owner order:** "SOKONI — END-TO-END NETWORK PRINTER + TILL PRINTING REPAIR" (implement, test, commit, deploy).
**Branch:** `hosting/lan-print-bridge-on-34fc938`. **Suite:** `scripts/test-lan-print-bridge.js` (61 / 0, sabotage 10 / 10).
**Related:** [[PRINTER_ONE_SETUP]] · [[PRINT_ENGINE_ARCHITECTURE]] · [[ADR]] (ADR-0001) · [[POS_SETUP_PAGE]] · [[SmartPOS]]

## 1. What was actually there

The order's premise was that "the existing printer stack already contains a local desktop bridge at localhost:9101". Measured:

- **The bridge program did not exist.** Four client files called a "SOKONI Desktop bridge" on `localhost:9101` (`sokoni-pos-print.js`, `sokoni-printer-providers.js`, `sokoni-connection-manager.js`, `sokoni-printer-discovery.js`). No server for those calls existed anywhere in the repository.
- **The callers disagreed on the contract.** Two sent raw bytes with `X-Target-Host` / `X-Target-Port` headers. Two sent JSON `{host, port, data: base64}`.
- **Four callers fell back to the cloud `posPrint` function.**
  - `pos-printer.js` used it for every network job.
  - `sokoni-connection-manager.js` fell back to it on a bridge **timeout**, which could print a receipt twice.
- **`posPrint` (live) is a signed-in open relay.** Any signed-in user chooses host and port, and `127.*` and `.local` are allowed. It can never reach a shop's Wi-Fi from Google's cloud. It is now unused by every client. Retiring it is a separate Functions decision and is **not** done here.
- **The canonical engine's `NetworkAdapter`** spoke only HTTP or WebSocket directly to the printer. An ordinary ESC/POS printer speaks raw TCP on 9100, which no browser can open.

## 2. The route

```
SOKONI page (https://mysokoni.co.ke)
  → canonical engine (SokoniPrinter NetworkAdapter, endpoint bridge://host:port) or another printer module
  → window.SokoniPrintBridge  (sokoni-print-bridge.js — the ONE client)
  → SOKONI Print Bridge on this computer  http://127.0.0.1:9101  (tools/sokoni-print-bridge/bridge.js)
  → raw TCP to the printer on the shop LAN (ESC/POS, 9100–9109)
```

**Contract** (kept from the existing callers, now enforced):

| Endpoint | Behaviour |
|---|---|
| `GET /ping`, `GET /health` | Liveness only. |
| `GET /probe?host=&port=` | Reachability of one validated printer. Nothing is printed. |
| `POST /print` | Raw bytes with `X-Target-Host`, `X-Target-Port`, `X-Job-Id` and `Authorization`. Answers `SENT` / `REJECTED` / `FAILED` + `retryable`. |
| `GET /scan-printers` | `501`. Sweeping the LAN from a web request is not offered. |

**What counts as printed.** A job is `SENT` only when every byte is flushed to the printer's socket. A 200 that says `ACCEPTED` or queued is **not** sent; the client checks `state === 'SENT'`. The physical receipt is the final proof (§6).

## 3. Security

**Bridge side** (every rule applies before any socket opens):

- **Where it listens:** 127.0.0.1 only.
- **Host header:** must be `127.0.0.1:<port>` or `localhost:<port>`. This defeats DNS rebinding onto the bridge.
- **Origin:** an exact allow-list (mysokoni.co.ke, sokoni-aeb26.web.app, sokoni-aeb26.firebaseapp.com). The Local/Private Network Access preflight is answered only for those origins.
- **Authentication:** a Firebase ID token for `sokoni-aeb26`, verified by the bridge (RS256 against Google's published certificates; aud, iss, exp, iat, sub, kid). There is **no shared secret in any page**. `SOKONI_BRIDGE_ALLOWED_UIDS` can limit a till to its own staff.
- **Destination:**
  - Allowed: an IPv4 literal in 10/8, 172.16/12 or 192.168/16, or a hostname whose every answer is in those ranges.
  - The connection goes to the validated IP and is never re-resolved.
  - Refused: loopback, link-local (169.254.169.254 metadata), CGNAT, multicast, public addresses, IPv6 and URLs.
- **Port:** 9100–9109.
- **Idempotency:**
  - `X-Job-Id` is required.
  - A job already `SENT` within 15 minutes is answered from memory and not printed again.
  - The same id while in flight gets `409`.
  - A failed job may be retried with the same id.
- **Limits:** 64 KB per job, 4 concurrent jobs, 120 per minute.

**Page side (headers).**
- `Permissions-Policy` gains `local-network=(self), loopback-network=(self)`. Every existing grant is kept.
- CSP `connect-src` gains exactly `http://127.0.0.1:9101`, with no private-range wildcard and no `ws://`.
- No `Connection-Allowlist` header exists in the deployment config, so there is nothing to extend.
- Chrome's Local Network Access permission prompt is a browser decision, separate from CSP. The client reads its state and says when it is denied.

**Client.** A page can move the client only to another `http://127.0.0.1:<port>` (for tests). Any other value is ignored.

## 4. Conditions the merchant sees

The one client maps every outcome to a message:

- bridge reachable
- **permission denied** (open site settings, allow local network access)
- **not running** (not installed on this computer, or stopped)
- sign-in rejected
- **not a shop-network printer address** (refused before any network)
- **printer unreachable** (off, wrong address or other Wi-Fi; retryable)
- printer answered
- sent

A browser cannot tell "bridge not installed" from "bridge stopped". Both show one message that names both.

## 5. What changed

| File | Change |
|---|---|
| `tools/sokoni-print-bridge/bridge.js` + `start-bridge.cmd` | **New.** The bridge (Node 18+, no packages) and a Windows starter. |
| `sokoni-print-bridge.js` | **New.** The one browser client. |
| `sokoni-universal-printer.js` | `NetworkAdapter` bridge route (`bridge://host:port`). `saveNetworkPrinter` accepts both call shapes (host+port, or endpoint). `networkPrinters()`. Removed duplicate API keys that silently overrode the new ones. |
| `sokoni-pos-print.js`, `sokoni-printer-providers.js`, `sokoni-connection-manager.js`, `sokoni-printer-discovery.js`, `pos-printer.js` | Network send → `SokoniPrintBridge`. Cloud fallback removed. `pos-printer.js connectNetwork` now proves the route instead of just storing host/port. The invented default `192.168.1.100` is removed. |
| 13 printer pages | Load `sokoni-print-bridge.js` before their printer scripts. |
| `pos-printer-setup.html` | Wi-Fi / LAN form: IP, port 9100, name; **Test connection** (real probe), **Test print** (real minimal ESC/POS through the canonical encoder), **Save** (tests first and shows the result), **Retry last job** (same job id, never a second copy). The existing list gives Connect/Reconnect and Remove. Bridge status line. |
| `firebase.json` | The two header additions in §3. |

**Not a new print engine** (ADR-0001). The bridge relays bytes, the client moves bytes, and ESC/POS is still built only by the existing engines. Bluetooth, USB, serial, P58E and browser fallback are untouched. The 22 existing printer, receipt and POS suites are unchanged and green.

## 6. Not proven here — needs the real shop

- **Physical receipt.** This machine has no LAN printer. The suite proves every step up to the printer's socket with a fake printer that records bytes. On-site steps:
  1. Install Node 18+ and run `start-bridge.cmd`.
  2. Open `/pos-printer-setup`, then enter the printer IP.
  3. Test connection → Test print → **confirm paper**.
  4. Switch the printer off → Test print shows "printer did not answer".
  5. Switch it on → Retry prints **once**.
  6. Repeat from `/pos`, `/pos-checkout` and `/seller-fulfilment`.
- **Real Chrome with Local Network Access** has not been run yet. The machine is under the 512 MB memory floor, which gates browser runs.
- **Open question:** whether CSP `upgrade-insecure-requests` rewrites the `http://127.0.0.1` fetch in current Chrome. Loopback is "potentially trustworthy" and should not be upgraded; the browser run decides.
- **Packaging.** The bridge needs Node. A signed Windows installer or tray app with auto-start is future work.
- **`till.html`** is untouched until sokoni-4d's till fix is live (order Phase 7).
- **`posPrint` retirement** is its own Functions decision. It is unused by clients after this slice.

## 7. Evidence

See `docs/release-gates/lan-print-bridge.md`.
