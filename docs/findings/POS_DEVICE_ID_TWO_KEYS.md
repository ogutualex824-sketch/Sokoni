# Two client-side "device id" keys, and only one names a real document

**Status:** OPEN (recorded, deliberately not merged) · **Found:** 2026-08-26 by the print-bridge slice

Related: [[PWA_PRINTER_HOST_PLAN]] · [[PRINT_INTENT_LIFECYCLE]] · [[POSDEVICES_SELLERID_DEAD_DISJUNCT]]

---

A browser that wants to claim print work must name its `posDevices` document. Two localStorage
keys look like they would do that. **Only one does.**

| key | written by | value | reaches the server? |
|---|---|---|---|
| **`sokoni_device_id`** | `pos-setup.html:2929` | `crypto.randomUUID()` | **yes** — passed to `bootstrapDevice`, which writes `posDevices/{deviceId}`. **This is the document id.** |
| `pos_device_id` | `pos-sync.js:303` | `dev_<ts>_<rand>` | **no** — read by `pos-health.js` and `pos-idempotency.js` only. It names nothing on the server. |

## Why this is worth writing down

Picking `pos_device_id` for the print host would have produced `not-found` on **every** claim.
The merchant-visible symptom is "my printer stopped working" — not "wrong identifier" — and the
server logs would show a device id that simply does not exist, with no hint that a second,
correct one was sitting in the same localStorage.

`SokoniPrintHost.resolveDeviceId()` reads `sokoni_device_id` **only**, and returns `null` rather
than generating one: a browser that has never registered a device has no business claiming print
work, and minting an id there would create a *third* vocabulary for the same thing.

It also explains the earlier `registerPrinterHost` finding that device ids must be **taken as
found**: `registerDevice` demands a UUID v4, `bootstrapDevice` accepts any sanitised string, and
production holds both shapes.

## Deliberately NOT fixed

Do not converge the two keys inside a print slice. `pos_device_id` feeds POS idempotency and
health reporting; changing what it holds would touch the idempotency key space, which is
financial-integrity territory. This is a naming collision to resolve on purpose, with its own
proof — not a rename to slip into unrelated work.

The options, for whoever takes it:

1. **Leave both, document the roles.** Zero risk. The trap stays for the next reader, which is
   what this file is for.
2. **Rename `pos_device_id` to `pos_local_instance_id`.** Says what it is — a per-browser tag for
   local idempotency and health — and makes it obvious it is not a server identity. Needs a
   migration read of the old key, because existing installs hold it.

Either is a deliberate decision. Neither belongs in the print bridge.
