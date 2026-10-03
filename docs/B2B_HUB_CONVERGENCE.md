# B2B Hub Convergence

Related: [[Marketplace]] · [[Payments]] · [[SmartPOS]] · [[Orders]] · [[Merchant Operations Convergence]] ·
`docs/VAT_POLICY_2026-09-30.md` · `docs/COMMERCIAL_CONVERGENCE_2026-09-30.md` · `docs/RULES_COMBINED_CANDIDATE.md`

**Status (2026-10-03): BUILT IN PART, NOT DEPLOYED, NOT READY FOR USERS.** Do not certify B2B until held payment,
the VAT correction, monthly lead invoicing and eTIMS retry, settlement deduction, the Messages integration,
the merchant-v2 screens, AdminOS, and emulator/browser proof have all passed.

## Owner decisions (2026-10-03, asked directly — binding)

| Topic | Decision |
|---|---|
| Earning | **Lead fee, KES 200 + 16% VAT per RFQ a supplier RECEIVES**, invoiced monthly. VAT comes from the tax engine and is never hard-coded. |
| Wholesale orders | **0% commission, permanently** (`b2b_order` lane, fixed and floor-exempt). |
| Payment | The accepted quote is paid **through SOKONI (IntaSend), held until delivery**, then settled to the supplier's business wallet. |
| Lead invoice recovery | **Deducted from the supplier's settlement** of a buyer-paid B2B order at release. The buyer's amount is never reduced. |
| Unpaid lead invoice | **More than 2 days unpaid → that supplier's till/POS closes** behind a collection gate (like the commission gate, with its own distinct design). |
| Old pages | `b2b*.html` **retire into merchant-v2**. |
| Messaging | In-app Messages only; no WhatsApp hand-offs. |
| Stock | Owner, Manager and Inventory roles may adjust stock; Cashier may not. An **approved** POS refund/void restores stock exactly once; a request alone restores nothing. Sale `mkHDKSm1oeIC1E4uXGXc` stays untouched. |

Worked example (owner): wholesale order KES 500,000 · commission 0 · outstanding lead invoice KES 696 →
**supplier settlement KES 499,304**. The buyer still pays KES 500,000.

## The chain and who owns each link

```
RFQ ─▶ paid lead ─▶ quote (versioned) ─▶ buyer accepts ─▶ purchase order ─▶ IntaSend payment ─▶ HELD
   ─▶ delivery/receipt ─▶ lead-fee deduction ─▶ supplier business wallet ─▶ settlement
```

| Link | Authority | Owner | State |
|---|---|---|---|
| Supplier consent (`supply.acceptsLeads`, `acceptsLeadsAt`) | `procurement.setSupplyParticipation` | sokoni-e3 `99b36c4` | built |
| RFQ, delivery, lead row, quote, accept | `functions/rfq.js` `rfqDispatch` | sokoni-f3, this branch | built, 40/0 unit |
| Lead price, monthly invoice, statement | `functions/b2b-leads.js` | sokoni-2f `df1b281` | built |
| 0% `b2b_order` lane | `commission-config.js` | sokoni-2f `92ae79c` | built |
| PO VAT from the quote (`vatBasis`) | `procurement.createPurchaseOrder` | sokoni-e3 | **in progress** |
| RFQ chat (`rfqRecipients` party fields) | messages server | sokoni-b2 `ed7cde0` / hosting `318d41a` | built |
| Held `b2b_order` payment purpose | IntaSend webhook purposes | sokoni-5b / 2f | **not started** |
| Settlement + lead deduction | commercial settlement authority | sokoni-2f (proposed) | **contract below** |
| Lead-invoice collection gate | POS gate rail (`evaluateMerchantGate`) | POS lineage owner (proposed) | **contract below** |
| merchant-v2 RFQs & Quotes | `sokoni-merchant-rfq.js` | sokoni-f3 hosting `36f0108` | built, static 22/0 |
| Rules | combined rules candidate | sokoni-f3 `02a1034` | built, EMULATOR PENDING |

## Contract: lead-fee deduction at settlement

1. **Where.** It runs in the single settlement authority, when held B2B funds are released after delivery
   confirmation. There is no second settlement path.
2. **What.** `deduction = min(outstandingLeadInvoicesKES, settlementKES)`, taken oldest invoice first. A partly
   covered invoice stays open for the remainder. Deduction ≤ settlement, always.
3. **Ledger.** The deduction is its **own ledger transaction**, keyed `leaddeduct_<settlementId>_<invoiceId>` and
   claimed with `create()`, never `get()+set()`. Retries, partial settlement, repeated delivery callbacks and
   refund/void replays therefore cannot deduct twice.
4. **Buyer side untouched.** The buyer's invoice, payment amount and receipt never change.
5. **Visibility.** The supplier's settlement statement shows gross, the lead-fee deduction (invoice ids) and net.
   AdminOS shows lead → invoice → deduction → settlement as one chain.
6. **Refund/void after deduction.** The invoice was a real debt, so it stays paid. A reversal would come only from an
   explicit owner policy, never implicitly.
7. **No settlement.** The invoice stays payable and carries forward.

## Contract: lead-invoice collection gate (> 2 days unpaid)

1. **ONE gate.** It becomes a second *reason* inside `evaluateMerchantGate` / `assertGateOpen`, keyed by the same
   merchant uid (the lead invoice's `billToUid` / `supplierOwnerUid`). Never a second lock.
2. **Condition.** Any issued lead invoice where `now > issuedAt + 2 days` and the balance is > 0.
3. **Result.** The gate keeps `POS_GATE_CLOSED`, with `reasons[]` such as `{kind:'b2b_lead_invoice', overdueKES,
   invoiceIds, since}`. The POS/merchant-v2 screen renders a distinct lead-invoice card with Pay Now, separate from
   the commission card.
4. **Exit path first.** As with the P0 commission gate decision, the lead gate may **block only when a certified
   Pay Now path exists** (IntaSend purpose for the lead invoice; settlement deduction counts as payment). Until
   then, it is evaluated and displayed but does not block. A lock with no way out is a defect.
5. **Where applicable.** Beyond the till, the same reason may pause *receiving new RFQs* (`acceptsLeads`
   delivery). That is an owner extension, not assumed.

## Security notes

- Every write is server-side. Clients reach RFQs only through `rfqDispatch`. Suppliers read leads only through
  `b2bLeadStatement`. The lead price has one writer (`adminSetB2bLeadPrice`).
- Consent is re-read inside the delivery transaction: a supplier who withdraws is never billed.
- The supplier view of an RFQ never exposes buyer contact details. `findSuppliers` returns an allowlist (no
  phone/email).

## Assembly

Run `node scripts/check-b2b-functions-assembly.js <functionsDir>` on any combined functions tree carrying
`rfqDispatch`. It fails closed if `b2b-leads.js`, its exports, or the `b2b_order` lane is missing.

## Known gaps (tracked)

merchant-v2 product writer drops `wholesalePrice` / `minWholesaleQty`; Bulk Order / Enquire wiring; supplier
storefront; `b2b*.html` redirects; AdminOS B2B area; staff roles (extend the one guard); KEBS/KRA fields;
browser + emulator proof.
