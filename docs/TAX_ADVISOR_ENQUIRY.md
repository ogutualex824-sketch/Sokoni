# Tax Advisor — Commission VAT Enquiry (draft)

**Status:** DRAFT — not sent. Fill the contact block before sending.
**Purpose:** obtain a formal decision on the VAT treatment of SOKONI's platform commission.
**Blocks:** [[COMMISSION_INVOICE_SPEC]] §5b — no commission invoice can be issued until
questions 1–3 are answered.

---

**Subject:** VAT treatment of SOKONI's 5% platform commission — decision required before
invoicing begins

---

Dear [Name],

We need a formal decision on how VAT applies to the platform commission SOKONI charges its
merchants. We have built the invoicing mechanism but deliberately **cannot issue any invoice**
until this is answered, because the answer changes what merchants owe and what SOKONI
recognises as revenue.

## Background

SOKONI is a Kenyan multi-merchant e-commerce and POS platform. It is **VAT-registered**, and
charges merchants a **platform commission of 5% of the gross sale value, subject to a minimum
of KES 10 per sale**.

Under our payment model the customer's money goes **directly to the merchant** — SOKONI does
not collect or hold it. The commission is therefore a **receivable**: an amount the merchant
owes SOKONI for the service, invoiced separately and settled separately. It is not deducted
from a customer payment we hold.

Commission invoices would be issued to merchants through **KRA eTIMS** under SOKONI's own PIN.

## The question, concretely

On a **KES 10,000** sale at 5%, the two possible treatments give different answers:

| Treatment | Merchant is invoiced | VAT element | SOKONI's net revenue |
|---|---|---|---|
| Commission is **VAT-inclusive** | KES 500.00 | KES 68.97 | KES 431.03 |
| Commission is **VAT-exclusive** | KES 580.00 | KES 80.00 | KES 500.00 |

Our published terms are unfortunately not consistent on this point, which is part of why we
are asking rather than assuming:

* Our **Terms** state: *"VAT-registered sellers: SOKONI deducts and remits 16% VAT on
  platform fees."* — which reads as VAT-**inclusive**.
* Our **Legal Hub** states: *"VAT (if applicable) shall be charged at the prevailing rate."*
  — which reads as VAT-**exclusive**.
* The **seller agreement** merchants formally acknowledge records only "5% per-sale
  commission (minimum KES 10)" and does not mention VAT at all.

Both pages are live, and merchants have been onboarded under this wording.

## What we need decided

**1. Is the advertised 5% commission VAT-inclusive or VAT-exclusive?**

**2. What exact amounts should appear on the eTIMS tax invoice** — the taxable amount, the
VAT amount, and the total payable by the merchant — for a KES 10,000 sale at 5%? We would
like a worked example we can test our calculation against.

**3. Does the treatment apply to merchants already approved** under the current seller
agreement, or only to merchants onboarded after we correct the wording? If it applies
retrospectively, is any adjustment required for commissions already recorded?

**4. Invoicing frequency.** Commission becomes due per completed sale, payable within 48
hours. Should we issue **a fiscal invoice per sale**, or **aggregate into a periodic
(e.g. monthly) invoice**? At marketplace volume the per-sale option is a substantial
fiscalisation load, so we would like your view on what is required rather than merely
possible.

**5. Merchants without a KRA PIN.** Some merchants have not provided one. May we issue a
commission invoice to a merchant whose KRA PIN we do not hold, and if so how should the buyer
be recorded on the eTIMS invoice?

## What happens with your answer

Questions 1–3 determine a single configuration value in our system, applied consistently to
every commission invoice and to the corrected public wording. Questions 4–5 determine when
invoices are generated and for whom.

Until we have your answer, **no commission invoice can be issued** — the system refuses by
design rather than defaulting to an assumption.

We are happy to provide sample transactions, our current invoice format, or anything else
useful.

Kind regards,

```
[Name]
[Role]
SOKONI
[Registered business name]
[KRA PIN — if you wish to include it; not required for the question]
[Phone]
[Email]
https://mysokoni.co.ke
```

---

## Notes before sending

* **Question 2 is the one to insist on.** A directional answer ("it's inclusive") still leaves
  rounding and presentation open. A worked example we can test against removes the ambiguity
  entirely.
* **Question 3 has a cost attached.** If the treatment applies retrospectively and differs
  from what has been recorded, historical commission may need adjusting. Better raised now
  than discovered at an audit.
* **Do not let the answer arrive only verbally.** The reply becomes the record behind a
  configuration that decides real money, and `revenueConfig/commission_vat` requires an
  attributable `decidedBy` for exactly that reason.
* **This is independent of Safaricom.** The commission question is about SOKONI's own supply
  to its merchants, and does not depend on the merchant-owned payment authorization we are
  separately pursuing ([[SAFARICOM_DARAJA_ENQUIRY]]).
* Once answered, arming is a single config write:
  `revenueConfig/commission_vat { enabled: true, inclusive: <true|false>, decidedBy: '<name>',
  reference: '<advice ref>' }` — plus corrected wording in the Terms, Legal Hub and seller
  agreement so all three agree.
