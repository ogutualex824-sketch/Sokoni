# The print chain enforces App Check on one half and not the other

**Status:** OPEN · **Found:** 2026-08-26, during post-deploy verification · **No code changed**

Related: [[PRINT_BRIDGE_E2E_CHECKLIST]] · [[PWA_PRINTER_HOST_PLAN]] · [[PRINT_INTENT_LIFECYCLE]]

---

The six deployed functions do **not** agree about App Check:

| function | module | `enforceAppCheck` |
|---|---|---|
| `registerPrinterHost` | `device-manager.js` | **true** |
| `getPrinterHostStatus` | `device-manager.js` | **true** |
| `createPrintIntent` | `print-intents.js` | *absent* |
| `claimPrintJob` | `print-intents.js` | *absent* |
| `advancePrintJob` | `print-intents.js` | *absent* |

`print-intents.js` declares `const OPT = { region, memory, timeoutSeconds }` and inherited no App
Check setting, because it is a new module rather than an addition to `device-manager.js`. That was
not a decision — it is the default that arrived by omission, which is exactly the kind of thing
worth naming rather than leaving implicit.

## How it was found

Probing the deployed endpoints unauthenticated returned two different messages:

```
registerPrinterHost   401  {"error":{"message":"Unauthenticated",...}}
createPrintIntent     401  {"error":{"message":"Sign in first.",...}}
```

`"Sign in first."` is `print-intents.js`'s own string, so that request **reached the handler**.
`"Unauthenticated"` is the SDK rejecting **before** the handler — `device-manager.js`'s own message
is `"Authentication required."`, and it never appeared. The difference in error text is the
fingerprint of the difference in enforcement.

## What it does and does not mean

**Not an open door.** All five still require a signed-in caller, and the print callables
additionally verify shop access (`assertShopAccess`) or derive the shop from a stored `posDevices`
record. App Check attests *the app*, not the user; its absence does not grant anyone access to
another shop's print jobs.

**It is an inconsistency with a real edge.** Without App Check, `createPrintIntent`, `claimPrintJob`
and `advancePrintJob` can be called by any authenticated user from outside the SOKONI app — a
script with a valid ID token. What such a caller can actually do is bounded by the same checks the
UI faces: they must already be able to act for the shop, and claiming still requires a device that
is `printerHost: true` for that shop. The realistic abuse is a shop insider replaying transitions,
which the fencing token and the FSM already constrain.

## Deliberately NOT fixed here

The implementation is frozen at `1d9017d` pending the physical E2E run. Adding `enforceAppCheck`
now would change deployed behaviour of three functions on the eve of that run, and if App Check is
not correctly initialised in whatever context the desktop listener ends up running, the symptom
would be the listener silently failing to claim — during the one test designed to establish that
claiming works.

**Recommendation, for after the five-ones test passes:** align `print-intents.js` on
`enforceAppCheck: true`, since the surrounding device functions already require it and the desktop
PWA demonstrably satisfies it (`registerDevice` and `bootstrapDevice` carry the same flag and work
in production today). Do it as its own slice, redeploy the three, and re-run the attack matrix —
not as a quiet edit.

**Do not "fix" it by removing enforcement from `device-manager.js`.** Converging downward would
weaken `registerDevice`, `lockDevice`, `remoteLogout` and the rest of the fleet-control surface,
which are considerably more sensitive than a print job.
