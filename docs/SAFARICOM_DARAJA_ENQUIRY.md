# Safaricom / Daraja — Authorization Enquiry (draft)

**Status:** DRAFT — not sent. Fill the contact block before sending.
**Purpose:** obtain Safaricom's authoritative position on whether the merchant-owned,
multi-shop STK Push architecture is **permitted**, before any configuration or deployment.
**Related:** [[MERCHANT_OWNED_PAYMENTS]]

Suggested recipients: `apisupport@safaricom.co.ke` — copy your Safaricom account or
partnerships contact if KASS Shop has one. Questions 1–2 are commercial, not technical.

---

**Subject:** Authorization enquiry — multi-merchant STK Push with funds settling directly to
independent merchants (SOKONI platform; Till 3588275)

---

Dear Safaricom API Support team,

We are requesting an authoritative answer on whether the merchant-owned, multi-shop STK Push
architecture described below is **permitted and supported** by Safaricom.

**Nothing is deployed to production.** SOKONI currently uses a separate payment service
provider (IntaSend) for its normal payment rail. We are evaluating Daraja only for a
separate, merchant-owned payment option, and we are seeking your confirmation before
proceeding.

## Our architecture

SOKONI is an e-commerce platform with multiple independent merchants/shops. For checkout:

```
Customer buys from Shop A
        ↓
SOKONI backend identifies Shop A
        ↓
SOKONI uses Shop A's own Daraja credentials
        ↓
SOKONI initiates STK Push to the customer's phone
        ↓
Customer enters M-PESA PIN
        ↓
Funds go directly to Shop A's M-PESA account
        ↓
SOKONI receives the transaction result
        ↓
SOKONI records the order/payment and later charges
its separately defined platform commission
```

**SOKONI would not collect or hold the customer's payment funds at any point.**

Each merchant would have its own M-PESA destination and, where required, its own Daraja
credentials. Credentials would be stored server-side and never exposed to the customer's
browser.

## Questions

**1. Is this multi-merchant architecture permitted by Safaricom?**
Specifically: may an e-commerce platform's backend initiate STK Push requests on behalf of
multiple independent merchants, using each merchant's own Daraja credentials, with funds
settling directly to that merchant?

**2. Does this require separate Safaricom approval?**
For example, an aggregator, platform, or partner agreement, or explicit authorization for
SOKONI to perform these merchant-initiated transactions.

**3. Can a Buy Goods Till support Lipa Na M-PESA Online / STK Push in production?**
Specifically, can **Till 3588275** be enabled for this product, or is a PayBill or dedicated
shortcode required?

**4. For Buy Goods STK Push, what are the correct `BusinessShortCode` and `PartyB` values?**
If the Till number and the Store / Head Office number differ, which number is used for each
field?

**5. What shortcode is the STK PassKey cryptographically bound to?**
We specifically need to know which value must be used when constructing:

```
Base64(BusinessShortCode + PassKey + Timestamp)
```

**6. What production callback requirements apply to a multi-merchant implementation?**
Please provide the authoritative Safaricom callback IP ranges/allowlist, and confirm whether
a **single HTTPS callback endpoint may serve multiple merchants**.

**7. Is there an official STK Push query / reconciliation mechanism?**
If a callback is lost or rejected, which Safaricom-supported API should a platform use to
independently determine the final STK Push result using the `CheckoutRequestID`?

**8. Does the same answer apply to C2B?**
Some merchants will take payment by customers paying the Till directly, rather than by STK
Push. For that flow:
* Can C2B validation/confirmation callbacks be registered for a merchant's Till while the
  endpoint is operated by SOKONI as the platform?
* Does a Buy Goods Till carry any account/reference field on a C2B confirmation that would
  let us match a payment to a specific order? Our understanding is that it does not, and
  that only a Paybill carries `BillRefNumber` — please confirm.

**9. Merchant of Record.** In the arrangement described, the **merchant remains the Merchant
of Record** — the customer's funds settle directly to that merchant's own M-PESA account and
SOKONI never takes possession of them. SOKONI's role is to initiate the request and record
the transaction. Please confirm this is the correct characterisation for Safaricom's
purposes, and tell us if Safaricom instead requires the platform to be the Merchant of
Record for this kind of integration — that would be a materially different commercial
structure and we would need to know before building toward it.

## Critical distinction

We are **not** asking whether the standard Daraja API can technically make an HTTP STK Push
request. We already understand that it can.

We need **Safaricom's authoritative position on whether SOKONI may operate that API as a
multi-merchant platform on behalf of independent merchants, with the payment going directly
to each merchant.**

If this architecture is not permitted, please tell us which Safaricom-supported architecture
or product should be used instead to achieve:

```
customer → STK Push → merchant's M-PESA account
```

without SOKONI becoming the recipient of customer funds.

Thank you for your assistance. We are happy to provide further detail or to discuss this
with the appropriate commercial or integration team if that is more suitable.

Kind regards,

```
[Name]
[Role]
SOKONI
[Registered business name, if different]
[Phone]
[Email]
https://mysokoni.co.ke
```

**Merchant referenced in this enquiry:** KASS Shop — M-PESA Till **3588275**

---

## Notes before sending

* **No secrets in this email, and none should be added.** No Consumer Key, Consumer Secret,
  PassKey, Security Credential, or initiator password — not in the body, an attachment, or a
  screenshot. Till 3588275 is a public payment number and is safe to cite.
* **A generic Daraja Bot / chatbot answer is not approval.** What we need is a reply from
  Safaricom API support or the relevant commercial/integration team that **explicitly
  addresses the multi-merchant arrangement**. An answer that only demonstrates that STK Push
  exists does not answer question 1.
* **Questions 1–2 are commercial.** First-line API support may only answer 3–7. Silence on
  1–2 is not consent — escalate to a Safaricom account or partnerships contact.
  See [[MERCHANT_OWNED_PAYMENTS]] §2: a "yes" on Till eligibility alone is not enough.
* **Question 5 is the one that unblocks engineering.** Which shortcode the PassKey is bound
  to determines whether `darajaStoreNumber` is required across our STK call sites.
* **Question 6 resolves a known divergence.** Our codebase carries two conflicting Safaricom
  callback IP allowlists sharing only four entries. An authoritative range settles it
  without inferring from a live transaction.
* **Retain the reply verbatim.** It becomes the authorization record referenced by
  [[MERCHANT_OWNED_PAYMENTS]], and determines whether `productionAuthorized` may ever open.
