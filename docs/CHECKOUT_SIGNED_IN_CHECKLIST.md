# Signed-in checkout checklist — before the first real payment

**Why this exists:** four properties cannot be certified from deployed markup.
They need a signed-in merchant session with a live App Check token. Asserting
them from the HTML would be claiming to have observed something that was never
measured — the exact failure mode that let a broken checkout ship green.

**Account:** the designated **test merchant**. **NOT KASS.**
KASS stays outside this test entirely; its paid record is repaired only after
the payment path is proven independently.

**Page:** `https://mysokoni.co.ke/plans` → Seller Basic

---

## 1. Wallet

- [ ] the **actual balance** renders (a real figure, not `—`, not `0` standing in for unknown)
- [ ] if the balance is **below KES 999**, the Wallet option is **disabled**, with the reason shown
- [ ] a disabled Wallet **cannot be selected** — no fake payment path

> A wallet that looks payable but isn't is worse than one that says it isn't.

## 2. Trial eligibility

- [ ] the merchant's **actual** eligibility is reflected
- [ ] if the promotional trial is already consumed, **no free-trial button is offered at all**
- [ ] **"Subscribe — KES 999/mo" is offered regardless** — this is the defect that started this work

> Buying a plan is not asking for a free trial. An exhausted trial must never
> block a purchase.

## 3. M-PESA

- [ ] M-PESA is selectable
- [ ] a phone field appears
- [ ] **Confirm & Pay stays disabled** until a valid `2547XXXXXXXX` / `2541XXXXXXXX` number is entered
- [ ] an invalid number keeps it disabled

## 4. Airtel Money

- [ ] visible
- [ ] explicitly **unavailable**, with the reason shown
- [ ] **cannot become the selected rail**, by click or by keyboard

---

## Then, and only then — ONE attempt

```
Seller Basic -> Monthly or Annual -> M-PESA -> valid 254 number -> Confirm & Pay
```

Expected within seconds:

```
payment intent created  ->  STK prompt on the handset
```

### If NO STK prompt appears

**STOP. Do not retry. Do not press it again.**

Capture and report:

1. the `CHK-XXXXXXXX` reference from the screen
2. the console line: `[checkout] CHK-XXXXXXXX failed at <stage>: <message>`

The stage name is the diagnosis — it says which boundary failed. A second
attempt destroys that evidence and risks a second charge.

### If the prompt appears

Enter the PIN and let it run:

```
STK_SENT -> PROCESSING -> IntaSend webhook -> intent PAID
         -> reconcilePaidIntent -> subscription ACTIVE
         -> STARTER entitlement -> maxProducts 100
```

Then immediately, before anything else:

```
node scripts/capture-purchase-record.js <testMerchantUid>
```

which must prove **one payment → one intent → one subscription → one
activation**, with no wallet debit on the M-PESA rail and no second period
extension on replay.

---

## What this single transaction converts

| | before | after |
| --- | --- | --- |
| real M-PESA STK | 🔴 unproven | evidence |
| genuine IntaSend webhook | 🔴 unproven | evidence |

Everything else in the chain is already production-verified (40/0).
