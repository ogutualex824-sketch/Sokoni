# Release evidence — LAN print bridge (2026-10-01)

| | |
|---|---|
| Base commit | 34fc938e9bbd66e6495a5ebb94fb638d632af9d3 (hosting/uploadedat-on-2bcdae2 tip) |
| Branch | hosting/lan-print-bridge-on-34fc938 |
| Resulting commit | the commit that adds this file |
| Deployment target | Hosting only (pages, client, headers). No Functions, no rules. |
| Deployed | NO — see "Not yet observed" |

## Files changed
commissioning.html firebase.json merchant-v2.html merchant.html pos-checkout.html pos-hardware-setup.html pos-hardware-wizard.html pos-marketplace.html pos-printer-setup.html pos-printer.js pos-setup.html pos-v2.html pos.html print-station.html seller-fulfilment.html sokoni-connection-manager.js sokoni-pos-print.js sokoni-printer-discovery.js sokoni-printer-providers.js sokoni-universal-printer.js docs/LAN_PRINTING.md scripts/test-lan-print-bridge.js sokoni-print-bridge.js tools/ 

## Hygiene (Phase 8)
- git diff --check: only CRLF line terminators flagged, on pos.html and sokoni-universal-printer.js. Both files are CRLF in the index and the worktree (git ls-files --eol: i/crlf w/crlf); the added lines match. No other whitespace issue.
- No change under functions/, firestore.rules*, storage.rules*, or any payment, wallet, inventory or admin file.
- The worktree holds only this slice (a separate worktree C:/temp/sok-lanprint, created for it).

## Tests run (exact counts)
| Suite | Result |
|---|---|
| scripts/test-lan-print-bridge.js (A–I, engine, callers, headers) | 61 passed, 0 failed |
| sabotage (10 mutations: host header, public destination, signature, audience, idempotency, origin, port, client 200≠sent, cloud relay, header) | 10/10 caught |
| existing non-browser printer, receipt and POS suites (22: autoreconnect, first-pair, globals, host-registration, host-ui, one-setup, shell-bridge, stack-dependencies, pos-print-delegation, print-intent-lifecycle, print-sale-bridge, receipt-adapter/centring/contract/documents, receipts-mount/vault, merchant-receipts-native, merchant-v2-panels, pos-barcode-path, decoder-matrix) | all 0 failed (J/K/L: Bluetooth, USB, serial and browser fallback unchanged) |
| perf-guard | PASS (pre-existing WARN posStartupScripts above baseline) |
| inline-script syntax check (gate rule) on 13 pages | 27 blocks, 0 failures |
| Flake note | one run in about 10 failed "58mm byte-for-byte" under machine load. Fixed sleeps were replaced with polling, and diagnostics were added to that check. Six further runs were clean. |

## Not yet observed (required before calling it fixed)
- Browser run in real Chrome with Local Network Access (blocked by the 512 MB memory floor on this machine): permission prompt, bridge discovery, and whether upgrade-insecure-requests leaves http://127.0.0.1 alone.
- Physical receipt from a real LAN printer: requires the shop (docs/LAN_PRINTING.md §6).
- till.html: untouched until sokoni-4d's till deploy is live (order Phase 7).
- Live header verification: after the hosting deploy.
