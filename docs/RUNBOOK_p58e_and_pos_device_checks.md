# Runbook — the two device checks that no harness can replace

**Run by:** a human, on real hardware. Neither is substitutable by Playwright.
**Blocks:** the `MERCHANT_URL` cutover.

Related: [[UNDEPLOYED_RC_COMBINED_REVIEW]] · [[MERCHANT_SHELL_CAPABILITY]] · [[RUNBOOK_verify-merchant-adjust-production]]

---

## Why these cannot be automated

The P58E check depends on a **Bluetooth GATT connection to a physical printer**, which a headless
browser has no access to. The iOS check depends on the **visual viewport shifting under a real
software keyboard** — simulators do not reproduce it, and that shift *is* the thing being tested.

Everything provable without hardware is already automated and green:
`scripts/smoke-merchant-v2-production.js` **15/0** against the live origin.

---

## ① P58E printer — the architectural claim

**The assertion is `Connected`, not `Saved`.** A saved printer is a stored preference; a connected
printer is a live GATT link. The claim under test is that the link **survives navigation between
native surfaces**, which is precisely what the multi-page architecture historically broke.

Perform on the actual phone + P58E, signed in as an approved merchant, at `/merchant-v2`:

| # | step | pass condition |
|---|---|---|
| 1 | Open `/merchant-v2` → **Devices** | the printer is listed |
| 2 | Pair / connect the P58E | status reads **Connected** — not merely *Saved* |
| 3 | Navigate to **POS** | status still **Connected** |
| 4 | **Print a receipt** | paper comes out, and the layout is the 58 mm composer |
| 5 | Navigate to **Orders** | still **Connected** |
| 6 | → **Analytics** | still **Connected** |
| 7 | → **Revenue** | still **Connected** |
| 8 | Back to **POS** | still **Connected** |
| 9 | **Print again — without re-pairing** | paper comes out |

**Step 9 is the whole test.** If it needs a re-pair, the GATT link did not survive the walk and the
single-window claim is false for this hardware.

Record for each step whether the status read **Connected**, **Saved**, or **Disconnected** — those
three are different answers and "it printed" does not distinguish them.

> Known constraint from the v2 module manifest: POS is **framed** by v2 rather than native, and an
> iframe cannot share a GATT handle without a native rebuild. If steps 3–9 fail, that is the
> expected cause — and it is a **v2 architecture finding**, not a printer fault. Bring the step
> numbers back rather than a verdict.

---

## ② POS iOS keyboard — `13515cb`

On a **real iPhone** (repeat on an SE-class 375×667 device, where the keyboard takes the largest
share of the viewport):

| # | step | pass condition |
|---|---|---|
| 1 | Open `/pos`, signed in as a merchant | POS loads, till visible |
| 2 | Add any item to the cart | cart total shows |
| 3 | Start checkout → choose **M-PESA** | payment panel opens |
| 4 | Tap the **amount** field | keyboard opens; amount stays visible |
| 5 | Tap **phone number**, type a number | **the STK-push button stays visible and tappable** |
| 6 | Tap STK-push **without dismissing the keyboard** | the push initiates |
| 7 | Dismiss the keyboard | layout returns, no gap or overlap left behind |
| 8 | Rotate to landscape, repeat 5–6 | button still reachable |

**Steps 5–6 are the defect being fixed.** Before this change the payment prompt had no keyboard
handling at all: typing the customer's number raised the keyboard over the button that sends the
push, so a merchant could enter the number and then not reach the control that charges it.

**If 5 or 6 fails:** `13515cb` does not ride along with the v2 cutover and returns to the POS
workstream. Nothing in Merchant v2 depends on it.
**If it passes:** it is accepted as a **fix**, not as POS certification. POS remains uncertified.

---

## What is still owed after these

**Production v2 seller certification** — blocked on credentials, not on capability. The existing
harness (`scripts/test-merchant-v2-certification.js`, in the main worktree) serves `localhost:8841`
and needs `SOKONI_CERT_MERCHANT_EMAIL` / `_PASSWORD` plus an App Check debug token. Now that v2 is
live, the stronger run targets the production origin directly, where App Check attests natively in
a real browser and no debug token is needed.

It must still prove what no unauthenticated smoke can: **active shop resolution, the 12-route walk,
Orders ownership, Payments ownership, session persistence across refresh, no child navigation.**

Only when all three are green does `MERCHANT_URL` flip — and then the 18/18 entry-point matrix runs,
including the check that the old `seller.html` workspace is **no longer reachable** through any
approved merchant entry path.
