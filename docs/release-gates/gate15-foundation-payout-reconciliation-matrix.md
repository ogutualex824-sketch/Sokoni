# Gate 15 — Test matrix: Foundation payouts + reconciliation (owner sokoni-2f)

> Part of [[INTASEND_CONVERGENCE_BRIEF]] (Gate 14/15). Branch `feat/foundation-on-3a38f35` @ f72aa3d. **Code-level evidence only**:
> real handlers executed against an in-memory Firestore, with IntaSend stubbed at the HTTP/module boundary. **No live or
> sandbox IntaSend call was made.** PesaLink, B2B and validate/status are UNPROVEN against the account. A suite's exit
> code is not the evidence: each row names the assertion, and for every protected case a mutation run made that assertion fail.
> Donation **collection** (intent → webhook → verified record) rows belong to sokoni-5b (`foundation-donation-settle.js`).

Suites:
- **D** = `scripts/test-foundation-disbursements.js` (29/0)
- **R** = `scripts/test-foundation-reconciliation.js` (14/0)

| Test id | Case | Expected | Observed (assertion) | Mutation / attack | DB effect | Money / ledger effect |
|---|---|---|---|---|---|---|
| VALID_PAYMENT | M-PESA payout; IntaSend reports Completed | completed once; ledger debited once | D3 pass | debit-on-initiate (original code) → **G1 counterproof**: the old code marks completed on initiate | disbursement completed; reservation released | 1 `disbursement` debit; verifiedBalance −amount (R E1) |
| VALID_PAYMENT (bank) | PesaLink to a listed bank, beneficiary validated | one PESALINK transfer; processing until Completed | D I5, I6, I10 pass | bank not in the provider list accepted → **I4 failed** | rail intasend_pesalink; validation stored | debit only at I10 completion |
| VALID_PAYMENT (PayBill / Till) | MPESA-B2B, PayBill + account_reference | one B2B transfer | D I8 pass | review acknowledgement bypassed → **I8 failed** | requiresReview honoured | debit only on completion |
| INVALID_AMOUNT | payout above verified available; refund above the donation's gross | refused | D A1, H1; R A1, E1 pass | spending recorded (unverified) money → **A1 + E1 failed** | none | none |
| PARTIAL_PAYMENT | reconciliation reference shows a different amount (KES 300 vs 3,000) | refused | R P1 pass | amount check removed → **P1 failed** | no proposal | none |
| WRONG_ORDER | refund of a non-completed donation; payout above the grant headroom | refused | D H1, A1 pass | — | none | none |
| WRONG_BUYER | another user reads or uses a pledge / withdraws a testimonial | not-found | impact-foundation-guards B1; content E3 pass | — | none | none |
| MISSING_PAYMENT | IntaSend has no such reference; status still Processing | refused / stays processing | R P1 ("no payment"); D D2 pass | — | none | none |
| UNVERIFIED_PAYMENT | balance recorded but not verified; reconciliation not provider-confirmed | payout refused; confirm needs an explicit acknowledgement | R A1, P2 pass | recorded balance used → **A1 failed** | — | — |
| DUPLICATE_CALLBACK | status refresh after completion; double confirm | no second effect | D D3, E3; R C1 pass | — | — | exactly 1 debit / 1 verifiedBalance credit |
| REPLAY_CALLBACK | second authorize of the same payout | refused (already processing) | D C1 pass (1 gateway call) | — | — | ONE transfer |
| FAKE_REFERENCE | propose verified without a reference / with an unknown reference | refused | R C1 (c0), P1 pass | — | — | — |
| BROWSER_SUCCESS_WITHOUT_PROVIDER | IntaSend *accepted* the request ≠ paid; public page shows unverified money | processing, not completed; public shows verified only | D D1; R D1 pass | public "available" from recorded money → **D1 failed** | — | no debit until Completed |
| WRONG_CURRENCY | reference shows USD | refused | R P0 pass | — | — | — |
| SAME_ADMIN | the proposer confirms their own reconciliation; the recorder confirms a manual payout | refused | R C1; D E2 pass | same-admin allowed → **C1 failed** | — | — |

**Not covered here (UNPROVEN):**
- the real IntaSend sandbox/live responses for PESALINK, MPESA-B2B, validate-account, bank-codes and send-money status
- Firestore emulator semantics (the fake is not the emulator)
- production revision proof (Gate 16): not deployed

## Gate 13 items routed to this lane (classified 2026-10-03)

| Item | What it does | Classification | Money effect | Disposition |
|---|---|---|---|---|
| `sokoni-banking-pro.js` markInvoicePaid / "wallet" | Moves a browser-local localStorage "balance". The live banking.html (72dca56) loads it and presents it as a wallet. | **BROWSER-FABRICATED MONEY STATE: DISPLAY ONLY.** No server write, no IntaSend, no ledger. It still misleads users. | none on any ledger (misleading UI) | **Closed in code:** `hosting/banking-foundation-on-f13a912` stops loading it; banking-hub.js replaces the panes; test-foundation-page B1 asserts it is not loaded. **Live until that hosting deploys.** The file is still listed in service-worker.js precache (inert once no page loads it). Delete the file in a later cleanup; service-worker caching is not to be hand-edited. |
| `financial-os.html:808` `_approveBankPayoutDirect` | Admin browser writes `payouts/{id}` `{status:'completed', bankRef}` directly through the client SDK. | **BROWSER-AUTHORED MONEY STATE: REAL RECORD.** One admin's click marks a wallet payout completed. The server does not verify it, no second admin is involved, and no provider evidence is required. | marks a seller/wallet payout completed (FinOS / wallet lane, `payouts` collection). **Not Foundation money.** | **OUT OF THIS LANE** (wallet / FinOS payouts; adminProcessPayout guard 45a837d is live by traffic pin; Wallet FROZEN). Recommended repair, owner to assign: route it through the existing server payout authority (adminProcessPayout or the manual-rail pattern: record reference → a different admin confirms), and add a rules denial on client `payouts.status` writes in the rules unit. Status: **OPEN, unassigned.** |
