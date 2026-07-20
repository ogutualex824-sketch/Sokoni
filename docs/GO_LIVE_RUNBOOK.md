# SOKONI Go-Live Runbook — Payment Integrity Release

**Commits in this release:** `a4964b1`, `7ed9a6c`, `f7825bc`, `1bbfb72`, `b7c76f1`
**Status:** implemented and unit-verified · **not deployed** · **not runtime-verified**

---

## The one thing that can break checkout

Deploy order is not cosmetic here. Production hosting currently serves a
checkout that writes `status: "paid"` and `paymentVerified` onto new orders.
The new Firestore rules **reject exactly those fields**.

> **Deploying rules before hosting rejects every live customer checkout.**

The window is the gap between the two deploys. Hosting must land first.

| Order | Result |
|---|---|
| rules → hosting | ❌ every checkout rejected until hosting lands |
| **hosting → rules** | ✅ safe — new client writes `pending_payment`, which old rules already allow |
| functions → hosting | ⚠️ safe but pointless — callback sets fields nothing yet reads |

`clientOrderInit()` is strictly narrower than the old rule, so the **new client
is valid under the old rules**. That asymmetry is what makes hosting-first safe
and rules-first unsafe.

---

## Sequence

### 0. Authenticate and confirm the target

```bash
gcloud auth login
gcloud config set project sokoni-aeb26
firebase use sokoni-aeb26
```

### 1. Resolve the auth outage first

Sign-in is down; nothing below can be verified end to end until it is fixed.

```bash
node scripts/auth-cert/index.js --layers 2
```

Read `gcp.identity.blocking-functions-resolve`. If it FAILS with an orphaned
registration, that is the root cause of `auth/internal-error`: unregister the
trigger in Console → Authentication → Settings → Blocking functions. **Do not
redeploy the deleted function.** If it PASSES, the hypothesis is rejected —
discard it and resume tracing from the next candidate.

Re-verify:

```bash
node scripts/auth-cert/index.js --layers 3
```

`smoke.google` must move from `auth/internal-error` to
`auth/popup-closed-by-user`. That change is the proof the pipeline reaches
Google.

### 2. Pre-deploy gate

```bash
node scripts/auth-cert/index.js --layers 1,2 --gate
node scripts/test-payment-authority.js     # expect 22 passed
```

Both must exit 0.

### 3. Hosting — FIRST

```bash
firebase deploy --only hosting
```

Verify the new client is live before continuing:

```bash
curl -s https://mysokoni.co.ke/checkout | grep -c 'pending_payment'   # expect >= 1
curl -s https://mysokoni.co.ke/checkout | grep -c '_ckOrderId'        # expect >= 1
```

### 4. Functions

```bash
firebase deploy --only functions:darajaSTKPush,functions:darajaSTKCallback
```

Deploy only these two. A full functions deploy risks the Cloud Run CPU quota
that has already blocked releases.

### 5. Rules — LAST

```bash
firebase deploy --only firestore:rules
```

### 6. Admin claims

```bash
node functions/scripts/set-admin-claim.js --email ochisaac@gmail.com        --role admin
node functions/scripts/set-admin-claim.js --email alexochieng3030@gmail.com --role superAdmin
```

`ochisaac@gmail.com` gets **operational administration only** — merchant and
product approval, moderation, support, disputes, reports, analytics, feature
flags. **Not** Super Administrator. Verify the claim payload after writing it;
`admin: true` and `superAdmin: true` are separate claims and granting both to
an operational admin is the failure mode to watch for.

Claims apply on next token refresh. Have each account sign out and back in.

---

## Verification — First Sale

Cannot be automated: needs a real handset, a real M-Pesa PIN, and real money.

1. Sign in (Google, then phone OTP)
2. Open a KASS VAPES product
3. Wishlist → Add to Cart → cart badge increments
4. Checkout → **confirm the STK amount on the handset matches the cart**
5. Pay
6. Order shows `status: "paid"`, `paymentVerified: true`, `inventoryApplied: true`
7. Product stock decremented by exactly the quantity ordered
8. Seller notified; order visible in both dashboards
9. Receipt generated
10. **Retry test:** press Pay twice — expect one order, one payment, one stock movement

Step 10 is the one most likely to fail. `_ckOrderId()` makes the order id
stable, but `darajaSTKPush`'s dedup window is 3 minutes; a retry after that
window can still produce a second STK push. Watch for it.

---

## Rollback

| Component | Rollback | Risk |
|---|---|---|
| Rules | `firebase deploy --only firestore:rules` from previous commit | **Reopens the paid-order hole.** Roll back only if legitimate checkouts are being rejected. |
| Functions | `gcloud run services update-traffic <svc> --to-revisions=PREVIOUS=100` | Reopens client-priced payments |
| Hosting | `firebase hosting:rollback` | Client resumes writing `paid`; harmless under new rules (rejected), breaks orders under old rules |

**Rolling back hosting while keeping the new rules rejects every checkout.**
Roll back rules and hosting together, or neither.

---

## First 24 hours

Watch these Firestore collections — all are written by this release and all
mean something is wrong:

- `orphanPayments` — payment confirmed, order document absent. **Money taken, nothing to ship.** Investigate every one.
- `auditLogs` where `type == "order_finalisation_failed"` — payment succeeded, order/stock transaction failed. Critical.
- `auditLogs` where `type == "payment_amount_mismatch"` and `severity == "high"` — client claimed less than catalogue price. A few are stale carts; a pattern from one uid is an attack.
- `oversoldAlerts` — stock went negative.

Also confirm within the first hour: `posPayments` docs carry
`pricingSource: "server_recomputed"` for marketplace sales and
`"client_operator_entered"` for POS tills. If marketplace sales show
operator-entered, line items are not reaching the function and **pricing is
still client-controlled**.

---

## Known gaps at go-live

- IntaSend and Daraja converge on the same order lifecycle; **cash and wallet paths are not audited**.
- Cart badge does not update after add ([shared-header.js](../shared-header.js) `skNavRefresh` is never called from the add path).
- Cart persistence depends on a hidden `<ul>` at [index.html:2207](../index.html).
- Category page renders no add-to-cart button; handlers exist but are unreachable.
- Quick View is dead code — no call site.
