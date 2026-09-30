# Printer — one setup across merchant-v2 (2026-10-01)

**Owner ask:** "make sure the printer works across the whole merchant-v2 ecosystem — test print in POS setup, barcode and price tag buttons in the uploader page, till/POS should print, chips should show and be synced to diagnostics and be saved, and one setup is enough."
**Surfaces:** `merchant-v2.html` (shell device layer), `pos-setup.html`, `sokoni-merchant-products.js`.
**Suite:** `scripts/test-printer-one-setup.js` (49 / 0, sabotage 6 / 6).
**Related:** [[PRINT_ENGINE_ARCHITECTURE]] · [[ADR]] (ADR-0001) · [[POS_SETUP_PAGE]] · [[RECEIPT_CONTRACT]] · [[SmartPOS]]

## 1. Why one setup did not carry

A census found at least five separate "saved printer" records, and nothing copied one into another.

| Surface | Where it saved / read the printer |
|---|---|
| POS setup (Connect printer) | engine `spp_profile.lastDevice` only |
| merchant-v2 shell (reconnect, chips) | `sk_devices_<uid>` only; it returned early when that key was empty |
| pos.js wizard | `PosDB` (IndexedDB) |
| label pages | `sokoni_print_settings_v3` + IndexedDB `sokoni_pos_print_v2` |
| paper width | `spp_config` (80mm default) vs `pps_till_config` (58mm default), plus three more |

So a printer paired in POS setup was unknown to merchant-v2, and the merchant paired again.

## 2. The one record

`sokoni-till-registry.js` (`sk_devices_<uid>`, one entry per type and id, newest wins) is the canonical record. It already existed; its `save` had no callers.

- **POS setup** saves the engine's device record into the registry after a successful connect or a silent reconnect during the test print. When setup finishes it marks completion in the registry (`sk_pos_setup_<uid>`).
- **The shell** reads the registry, and the newest printer record wins. When a signed-in merchant has none, it adopts the engine's own pairing (`spp_profile.lastDevice`), so a printer paired on any page counts. A signed-out shell never adopts, so the next merchant does not inherit a pairing. On connect it saves the engine device **id**, not the display name.
- **The POS route** treats `posSetupComplete`, `sokoni_setup_complete` or the registry record as "set up". Before this, a merchant who finished POS setup was sent through the hardware wizard again.
- **Paper size** set in POS setup now sets both the till config and the engine config.

A live Bluetooth connection cannot survive a full page change in a browser. "Set up once" therefore means one saved pairing plus the engine's silent reconnect on each page, or one tap where the browser cannot reconnect on its own. The chip says which.

## 3. Printing paths

- **Receipts (Sell, Receipts):** one shell function, `_shellPrintReceipt`.
  - Sell's composed `SokoniReceiptDoc` now reaches `printReceipt` (`useDoc`), so a sale prints the same premium layout the POS setup test print shows. It used to be dropped.
  - Receipts' `{order, copies}` prints the order once per copy and stops at the first failure.
  - Every result is normalised by `_printOutcome`. A queued job is **not** printed, even if it also says `success: true`.
  - Receipts used to show every successful print as "did not print", because it checked an `ok` field `printReceipt` never returned. The shell now returns one.
- **Labels (Products):** Print price tag and Print barcode label, from each product's ⋮ menu and under the Barcode field in the add/edit form.
  - They use the engine's existing `label` document (name, price, SKU, barcode) on the shell's connection. There is no second label engine.
  - A label prints now or not at all. A product with no barcode, a saved-but-disconnected printer and an unpaired till each get their own clear message. A blank price is omitted, never printed as KES 0.
- **POS setup test print:** unchanged path (`PosPrintService.printReceipt` with the premium document). It now records the pairing it used.

## 4. Chips and diagnostics

- **merchant-v2 chip:**
  - connected → green, with the printer's name
  - connecting → amber
  - **needs-tap → amber "Tap to reconnect printer"**
  - **reconnect-failed → red "Printer offline"**
  - saved → "Printer saved"
  - nothing paired → neutral "Printer"
  - The three bold states used to look identical to "never set up".
- **POS setup Diagnostics chip:** now the real printer, from the same registry and transport the shell chip reads. Connected → confirmed, paired but not answering → needs attention, never paired → not confirmed. The receipt section states the printer's current condition on load.
- The Hardware chip stays server-derived (`getSetupStatus.checklist.hardwareConnected`). A local printer is not a server fact.

## 5. Not in this slice

- `till.html` never prints (`onPrint` is a no-op and it loads no printer stack). sokoni-4d's till/STK slice changes that file, so this lands after their deploy, built on the served file.
- pos.js's own wizard still saves into `PosDB` through `PosPrinter`, and legacy label pages (`pos-inventory.html`, `inv-product.html`) keep their broken handlers. merchant-v2 is the merchant surface.
- `SokoniReceiptEngine`, `SokoniPrinterDrivers` and `SokoniHardware` are each assigned by two files. This is pre-existing and recorded, not changed.
- Network or LAN printers cannot be reached from any page. CSP `connect-src` and `upgrade-insecure-requests` block `http://ip:9100`, and changing that is a security decision.
- The iframe `allow` list in the shell probably does not stop same-origin frames from opening a competing Bluetooth link. This needs a real-device check.

## 6. Manual checklist (real device)

1. In POS setup › Receipt, tap Connect printer and pair. The status reads "Printer connected — <name> and saved for this till", and the Diagnostics chip turns confirmed.
2. Tap Test print. The premium sample prints.
3. Open merchant-v2 (no re-pair). The chip shows "Printer saved" then connects silently on Chrome, or asks "Tap to reconnect printer" once.
4. Open Products › ⋮ › Print price tag. A label with name, price and barcode prints. Print barcode label on a product with no barcode → "Add one in Edit › Barcode".
5. Make a Sell sale and print. The premium receipt prints.
6. In Receipts, print 2 copies. Two receipts print and the message says so. With the printer off, the message says it did not print.
