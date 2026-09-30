# POS Setup — one page, set up once, edit anytime

**Status:** built on the live hosting line (`be7c676`) 2026-09-29. **Not deployed.**
**Related:** [[RECEIPT_CONTRACT]] · [[SMARTPOS_ONBOARDING_2.0_ARCHITECTURE]] · [[POS_SINGLE_WINDOW_SHELL_DESIGN]] · [[Payments]]

## What the merchant sees

**First run:** welcome, then a network check, then sign-in. After that `pos-setup.html` is **one scrolling page**
with a sticky chip bar:

`Business · Branch · Device · Payments · Receipt · Hardware · Diagnostics · Commission`

Tapping a chip scrolls to its section. Signed-in merchants whose setup is unfinished land directly on the page.
`?edit=1` keeps a set-up merchant on the page instead of sending them to the POS.

| Section | What it does | Authority |
|---|---|---|
| **Business** | a **dropdown** of the merchant's own businesses, each showing its business type; "Create a new business" keeps the business-type selector | `getMyBusinesses`. A **failed** lookup is shown as an error, never as "create your business". |
| **Branch** | branches as chips; one branch is auto-selected; several need a choice ("Use this branch"); change at any time | `getBusinessConfig` |
| **Device** | this phone / tablet / laptop, registered **once**; rename it or move it to another branch at any time | `bootstrapDevice` + `registerDevice`; `getDeviceList` confirms the device |
| **Payments** | **IntaSend** is the payment provider. SOKONI Till and SOKONI QR are shown as **"Activates with your business wallet"**, with no QR drawn and nothing collected. | display only, until FC-1 (business wallet) and 6c |
| **Receipt** | the **premium receipt** (`SokoniReceiptDoc`) as a SAMPLE; paper size **58mm or 80mm** (the till's own setting); **Test print** | see below |
| **Hardware** | the existing hardware wizard, **embedded** | `pos-hardware-wizard.html?embed=setup` |
| **Diagnostics** | the existing printer / device console, **embedded**, opening straight into its FULL advanced view: all 12 tabs (Discover, P58E Setup, Hardware Tests, Capabilities, Test Documents, Configuration, Queue, History, Print Log, Auto-Print, Printer Info, Diagnostics) | `pos-printer-setup.html?embed=setup` |
| **Commission** | **5%** of every POS / Till sale; **15%** of online sales on every package; collected daily at **07:00** once the business wallet is live; outstanding shows **"—"** | display only (see below) |

## Chips are green only from the server

A chip is **green** only from a server answer held in memory:
- the server's business and branch lists;
- `getSetupStatus` (business, branch, taxes → Receipt, hardware);
- `getDeviceList` / `registerDevice` for this device.

**Amber** means the server answered and something is missing. **Grey** means not confirmed. Payments, Diagnostics
and Commission are informational and are never green. `localStorage` (for example `sokoni_setup_complete`) can
never turn a chip green.

## Device registration fix

The page used to send `navigator.platform` (`Win32`, `Linux armv8l`, `Android`) to `registerDevice`. The server
accepts only `web | android | ios | windows | linux`, so **every registration from this page was refused**, and
the refusal was labelled "registration pending".

The page now maps the platform onto the server's list and also sends `deviceType` and `deviceName`. A refusal
stays "not registered" and the chip is never green.

## Receipt

- **The preview** is the one receipt contract, `SokoniReceiptDoc`, marked SAMPLE. It uses the merchant's real
  identity where the server provided it (business, branch, phone, KRA PIN), and every line is absent when its data
  is absent.
- **The two codes** sit **side by side and equal**: mysokoni.co.ke on the left, KRA eTIMS on the right. The KRA
  code shows "eTIMS pending" unless KRA really issued one. See [[RECEIPT_CONTRACT]].
- **Paper size:** 58mm or 80mm. This is the till's `paperWidth` in `PosPrintService`, the setting the printer uses.
  The preview is drawn at the true width (32 or 48 columns).
- **Test print:**
  - **printer connected:** the SAMPLE premium document is sent through `PosPrintService.printReceipt(…, { useDoc: true, doc })`,
    and "sent to your printer" appears only on a real success. A queued or skipped job is not a print;
  - **no printer:** the device's print dialog opens on the sample, with the page sized to the paper width.

## Commission

**UI policy display ≠ deployed commission authority.** The page states the owner's rules as one constant (`COMMISSION_POLICY`): 5% POS/Till, 15% online on every package,
07:00 daily collection once the business wallet is live.

**The rate table deployed on this line** (`sokoni-commission-rates.js`, generated from `commission-config.js`) still
carries earlier figures (marketplace 3%, POS aliased to it). **Production charges follow that table until the
commission rules ship.**

No deployed endpoint on this line returns the merchant's outstanding balance, so none is shown. The 07:00 collector
(M0-4b) is **not** part of this work.

## Embedding

`pos-hardware-wizard.html` and `pos-printer-setup.html` detect `?embed=setup` inside a same-origin `/pos-setup`
frame. In that case they hide their site chrome and back links.
- The printer console's **"Back to POS" is removed**. A caller that sends a merchant there with `?return=` still
  gets a "Back" to *that* caller when the page is not embedded.
- When embedded, the console's own commission card is hidden, so the page carries one commission statement.

## Removed

The **Daraja** "M-PESA payment destination" card (own Till/PayBill, verified only by the retired Daraja STK
callback) and its code. It could never verify again, and SOKONI payments are IntaSend only.

## Certification

`scripts/test-pos-setup-page.js`: WebKit (iPhone 13) and Chromium (1280). Every server call is stubbed through the
page's own `CF`/`SPOS`. **44 passed, 0 failed** (stable across 3 runs), plus one UNPROVEN item: the embedded consoles' signed-in content,
which needs a real merchant session.

**Boundary tripwire:** `scripts/test-pos-manual-till-payment.js` checks that a live sale receipt, and its manual-Till
code, never goes through `SokoniReceiptDoc`. Only the explicitly requested setup sample may (`context.useDoc`).
