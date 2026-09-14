# M-PESA Narrative — Real-Handset Verification Procedure

**Prepared:** 2026-09-14
**Subject commit:** `76571a1` (prompt construction), `de78918` (shop identity)
**Repository certification:** `scripts/certify-stk-narrative.js` — 70/70
**Handset state:** 🔴 **PROVEN NEGATIVE — the narrative is not forwarded** (2026-09-14, see §5)
**Deployment:** `initiateSTKPush` only, from `12fc4e7`, 2026-09-14 — authorised as Door A for this test. No other function deployed.
**Related:** [[project_stk_narrative_names_the_shop]] · [[project_merchant_first_identity]]

---

## 1. What this test is for, and what it can never settle

The repository can prove the first link and only the first link:

```
SOKONI  ──►  IntaSend        PROVEN — the payload is read off the wire in certification
IntaSend ──► Safaricom       UNPROVEN — outside our code
Safaricom ──► handset        UNPROVEN — outside our code
```

**The question is narrow: does the `narrative` string reach the buyer's screen at all?** Everything
about *what* it says is already settled and tested. This test answers only whether the field is
carried, truncated, or discarded.

**It is a property of the provider's configuration, not of our code.** A pass means the field was
carried *for this IntaSend account, in this environment, on this date*. It can regress with no
commit of ours — a changed collection account, a provider-side field-mapping change, a migration
between sandbox and production. That is why every result below is recorded **dated and account-
scoped**, and why §6 lists the events that void it.

---

## 2. Preconditions — Door A was opened and used on 2026-09-14

**Door A was authorised, `initiateSTKPush` was deployed from `12fc4e7`, and one KES 1 push was sent.
The result is in §5 and it is a FAIL.** This section is kept as written because a re-run — after any
of the §6 voiding events — has to clear the same bar again.

Nothing in this repository sends a prompt by default. One of these must be explicitly authorised,
and whoever authorises it must supply the **test MSISDN** and an **amount ceiling**.

| | Door A — Production | Door B — Sandbox |
|---|---|---|
| Requires | deploy of `initiateSTKPush` | IntaSend sandbox credentials |
| Switch | default | `INTASEND_SANDBOX=true` — `functions/index.js:6967` |
| Reaches a real phone | yes | yes |
| Moves real money | **yes — keep the ceiling at KES 1** | no |
| Proves production behaviour | yes | only if sandbox shares the field mapping — record which |
| Status | 🔴 NOT AUTHORIZED | 🔴 NOT AUTHORIZED |

> Door B is cheaper but weaker evidence: if sandbox and production differ in how `narrative` is
> mapped, a sandbox pass does not transfer. Record which door was used on every observation.

---

## 3. The expected string — generate it, never transcribe it

Run this. It is offline, reads only the pure string module, and cannot send anything:

```bash
node scripts/print-expected-stk-narrative.js
node scripts/print-expected-stk-narrative.js --shop "REAL SHOP NAME" --amount 1 --channel online
```

It prints the exact expectation from `functions/shared/merchant-identity.js` itself. **Do not copy
the expected string into this document.** A transcription drifts from the code the first time the
ladder is tuned, and the verification then checks against a figure nobody maintains.

At the time of writing, the primary case produces a 90-character line of the shape:

```
✔ <SHOP> · Please approve a payment of KES <amount> · Powered by SOKONI, a product of Bravilex
```

### Which case to push

**Push the PRIMARY case only**, unless more than one push is authorised.

| Case | Establishes |
|---|---|
| **primary** — real shop, KES 1, online | does `narrative` reach the handset **at all** — the only question that matters first |
| KES 4,566 | the amount in the sentence tracks the real charge |
| long shop name | **where the gateway truncates** — the only way to learn the real character budget |
| unresolved shop | the fail-closed string is legible and names nobody it cannot prove |
| till / POS | not testable on this branch — **no Till/SPOS STK sender exists here** (see §7) |

Use the **real shop's real name**. A specially-crafted test string would prove nothing about the
string production actually sends.

---

## 4. Evidence to capture

Capture all six. Items 1 and 2 are the finding; 3–6 are what make it interpretable later.

1. **Photograph of the SIM-toolkit dialog**, full screen, unedited, before entering any PIN.
   Do not crop — the surrounding lines are what tell us whether the field was placed, replaced or
   dropped.
2. **The M-PESA confirmation SMS**, in full. The narrative sometimes surfaces here rather than in
   the dialog; an absence in the dialog plus a presence in the SMS is a **different result** from an
   absence in both, and changes what we do next.
3. **Timestamp** — device clock visible in the photograph, or noted to the minute with timezone.
4. **The server-side payload that was actually sent** — the `narrative` and `api_ref` from the
   function log for that invocation. This is what pins the observation to a known string.
5. **IntaSend environment and account** — sandbox or production, and the account identifier.
6. **The collection account name as registered with Safaricom** (the paybill/till name). This is
   what the dialog shows at the top and is **not** something our code sets; recording it prevents a
   later reader mistaking it for our narrative.

**Do not record the full test MSISDN in this repository.** Last three digits are enough to
distinguish handsets across runs.

---

## 5. Observation record

Append one row per push. Never edit a previous row — a superseded result is evidence too.

| Date (UTC+3) | Door | IntaSend acct | Handset (last 3) | Amount | Case | Dialog? | SMS? | Verdict | Evidence ref |
|---|---|---|---|---|---|---|---|---|---|
| 2026-09-14 04:14 | A — production | production (Co-operative Bank of Kenya, account `085BS`) | …803 | KES 1 | primary, online, KASS SHOP | **no** | **no** | **FAIL** | M-PESA `UIE6Q64WQP`; `ref=SKN-HSV-MU0JIVMQ`; `checkoutId cfe12504-fbfe-4977-8178-3ac91d4c572c` |

### What the buyer actually saw

Dialog: *"do you want to pay coop bank"*

Confirmation SMS, verbatim:

```
UIE6Q64WQP Confirmed. Ksh1.00 sent to Co-operative Bank of Kenya.
for account 085BS on 14/9/26 at 4:14 AM New M-PESA
```

Absent from both: the shop name, `SOKONI`, `Bravilex`, the courteous ask, and the `✔` mark. **The
`narrative` field is not forwarded to anything the buyer reads.**

Two further observations that were not anticipated:

* **`api_ref` is not shown either.** We sent `SKN-HSV-MU0JIVMQ`; the buyer's record says
  `account 085BS` — IntaSend's own account identifier on the shared paybill. So neither of the two
  strings we control appears anywhere in the buyer's M-PESA record.
* **The payee is a third party.** The buyer's permanent M-PESA statement records money *sent to
  Co-operative Bank of Kenya*. Nothing in it identifies SOKONI, the shop, or the order. A buyer
  reconciling their statement, or disputing a charge, has no way to connect that line to a purchase
  on SOKONI.

### Verdicts, and what each one means for the code

| Verdict | Definition | Consequence |
|---|---|---|
| **PASS** | the narrative, or a recognisable leading portion, appears in the dialog or the SMS | mark the handset state GREEN **for that account and date**; no code change |
| **PARTIAL** | appears but cut short | record **exactly** where it cut. That character count is the real budget — retune `MAX_NARRATIVE` and the ladder to it, then re-certify. This is a valuable result, not a failure |
| **FAIL** | appears in neither the dialog nor the SMS | `narrative` is not forwarded. The only remaining lever on that screen is the **registered collection-account name**, which is a provider configuration task, not a code change |
| **BLOCKED** | the push did not complete (auth, config, network) | not a result. Re-run; do not record a verdict |

**A FAIL does not mean the work was wasted and must not be reverted on that basis.** The same string
is carried in `api_ref`-adjacent provider records and may surface on statements, receipts and
reconciliation views; and the moment the collection account changes, the field may begin to appear.
Removing it would cost the same effort again.

---

## 5b. What this FAIL means, and what it does not

**The lever we built is real but invisible on this rail.** `narrativeFor` produces the right string,
the server resolves the shop from the ownership authority, and the payload carries it — all of that
is certified and none of it is in question. IntaSend simply does not surface it to the payer.

**Do not revert the work on the strength of this result** (§5, stated before the test ran, and it
still holds). The string costs nothing to keep, it is the correct thing to send, and it becomes
visible the moment the collection arrangement changes. Reverting would mean paying for it twice.

**But it does not achieve what it was asked to achieve.** The goal was that a buyer paying through
SOKONI sees SOKONI and the shop. Today they see *Co-operative Bank of Kenya*. No code change can
alter that, because the payee name and account reference on both the dialog and the SMS come from
the **registered collection account**, not from the request.

That makes the remaining work commercial, and there are three questions to put to IntaSend — in
this order, because they differ enormously in cost:

1. **Does their API expose a per-transaction business name / account reference that Safaricom
   renders?** Some aggregators support a sub-merchant or "account number" field that replaces
   `085BS`. If so this is a payload change and the existing module already produces the string.
2. **Can the collection account be registered under a SOKONI-branded name?** Then the dialog and
   SMS read SOKONI rather than the bank, for every merchant at once.
3. **Failing both — does SOKONI need its own paybill/till with Safaricom?** That is the only route
   that puts SOKONI on the buyer's statement independently of any aggregator, and it is an
   onboarding and compliance project, not an engineering one.

Until one of those lands, the honest position is: **SOKONI has no brand presence in the M-PESA
payment experience, and a buyer's statement cannot be reconciled to a SOKONI order.** That is worth
knowing plainly rather than being softened by the fact that the code is correct.

---

## 6. What voids a PASS

Re-run the primary case whenever any of these happen — the result is scoped to a configuration, not
to a commit:

- the IntaSend collection account changes, or the paybill/till registration is altered
- a move between sandbox and production, in either direction
- IntaSend changes its STK payload contract or field mapping
- `MAX_NARRATIVE`, the ladder, or `sanitiseForHandset` in
  `functions/shared/merchant-identity.js` is modified
- more than 6 months have passed since the last recorded PASS

---

## 7. Not covered by this procedure

* **The Till/SPOS prompt.** No Till/SPOS STK *sender* exists on this branch — `stk-gateway.js` and
  the `pos-qr.js` wiring are on `slice/realtime-control-plane`. The till **wording** is built and
  certified here and will be used the moment a sender lands, but there is nothing on this branch
  that can push a till prompt, so there is nothing to photograph.
* **The dialog's layout, branding or top line.** Safaricom renders that screen. It cannot be styled
  and the business name on it comes from the registered collection account.
* **The in-app panel.** That is a browser surface, already certified in
  `scripts/certify-stk-narrative.js` §9, and needs no handset.

---

## 8. Repository-side state at preparation time

Verified while preparing this document, so a later reader knows the subject did not move underneath
it:

| Check | Result |
|---|---|
| `functions/shared/merchant-identity.js` vs `HEAD` | unchanged |
| `scripts/certify-stk-narrative.js` vs `HEAD` | unchanged |
| uncommitted `narrativeFor` changes in `functions/index.js` | none |
| `scripts/certify-stk-narrative.js` | 70 passed, 0 failed, 0 blocked |
| production deployment | none |
