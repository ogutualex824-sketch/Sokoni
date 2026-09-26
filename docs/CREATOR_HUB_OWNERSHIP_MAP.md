# Creator Hub — Forensic Audit & Ownership Map

**Date:** 2026-09-26 · **Base:** `a38b31a` · **Branch:** `feat/creator-hub` · **Status:** AUDIT (pre-implementation) — implementation: [[CREATOR_HUB]]

Related: [[Marketplace]] · [[Payments]] · [[PAYMENT_ARCHITECTURE_UNIFICATION]] · [[WITHDRAWAL_ENGINE_CHANGE_PLAN]] · [[WALLET_FREEZE_ACCEPTANCE]] · [[AdminOS]]

---

## 1. Verdict

There is **no Creator / film product** in the repository. There are four unconnected fragments,
each with a defect that makes it unsafe to build on as-is. Every one of the money primitives a
Creator Hub needs **does exist** — the work is adoption and wiring, not new infrastructure — but
two of those primitives sit behind the wallet freeze.

## 2. Existing fragments (what they are, why none is the answer yet)

| Fragment | Files | What it is | Defect |
|---|---|---|---|
| Film PPV backend | `functions/entertainment-hub.js` (9 callables, exported `index.js:12093-12102`) | `entertainmentListings` + `entertainmentPurchases`; categories `movie, series, documentary, short_film, music_video…`; `ppv` 15% | **Zero frontend callers.** `streamingUrl` is an external URL; `firestore.rules:4799-4803` makes active listings **publicly readable**, so the server-side strip at `entertainment-hub.js:105-112` protects nothing. Purchases stay `pending_payment` forever (no purpose/adapter). Float shillings. get-then-set idempotency. |
| Entertainment booking hub | `entertainment.html`, `entertainment-hub.js` (root), `ent-organizer.html` | DJ / artist / venue / ticket booking, client-side `ent*` collections | Not film. `entContent` "digital content" section has no callers. Story upload path omits `{uid}` → denied by storage rules. |
| Digital products (×2 backends) | `functions/digital-hub.js`, `functions/marketplace-extensions.js:493-650`, `digital-esoko*.html`, `digital-store.html` | Downloadable goods | Two backends, conflicting schemas (`fileStoragePath` vs `storagePath`). Digital Esoko front end writes client-side into CF-only collections (all denied), uploads to paths with no storage rule (denied), and hands out a public `fileURL`. |
| AI Creative Studio | `creative-studio.html`, `sokoni-creative.js`, `sokoni-media.js`, `functions/media-engine.js` | Canvas image tools + upload engine | "Watermark" is a brand-kit text field, never applied to video. No transcoding / streaming. Hidden, not navigable. |

Education (`functions/education.js`) embeds YouTube/Vimeo — not hosted media. `franchise-engine.js`
"royalty" is franchise fees (float, `.add()`) — **not** a model for rights royalties.

## 3. Ownership map — the canonical primitive for each Creator Hub need

| Need | Canonical owner | File | Reuse verdict |
|---|---|---|---|
| Category (browse) | `categoryMeta` | `category.js:20-62` | **EXTEND** — add `creator`. There is no category collection. |
| Hub registry | `HUBS` | `functions/platform-core.js:110-131` | `entertainment` hub exists → Creator lives **inside Entertainment** (no new hub — standing strategy) |
| Film catalogue | `entertainmentListings` | `functions/entertainment-hub.js` | **ADOPT + REPAIR** (fix public read of media URL; add review states; private media) |
| Payable purpose | `PURPOSES` pricer registry | `functions/payment-purposes.js` | **EXTEND** — one `film_access` pricer (server price, deliberately NO `sellerUid`: royalty money is not seller proceeds) |
| Payment intent | `createPaymentIntent` → `paymentIntents/{ref}` (`.create()`) | `functions/payment-intents.js:60` | **REUSE unchanged** |
| Collection rail | `initiateSTKPush` (M-PESA, live) | `functions/index.js:6071` | **REUSE**. Multi-method hosted checkout = `functions/shared/intasend-checkout.js` — **untracked, another agent's, unverified against the live account** |
| Settlement authority | `webhookIntasend` → `payments/{ref}` COMPLETE | `functions/index.js:7497` | **REUSE — but see §4 B1** |
| Entitlement | `entitlement-engine` → `entitlements/{paymentRef}` (`txn.create`) | `functions/entitlement-engine.js`, `entitlement-adapters.js` | **EXTEND** — register a `film_access` adapter (template: `digital_download`) |
| Activation trigger | `payments/{id}` onWrite → `engine.activate` | `functions/healthcare-subscription-activation.js` | **CLONE the pattern** (one trigger per purpose today) |
| Commission rate | `commission-config.js` `RATES.ppv` = 15% | `functions/commission-config.js:67` | **REUSE** — never a second rate table (`verify-commission-single-source.js`) |
| Money arithmetic | `money-authority.js` (integer cents, half-up) | `functions/money-authority.js` | **REUSE** (pure, certified, not integrated) |
| Withdrawable balance | `wallets/{uid}.balance` (whole KES) | `functions/wallet.js` | **REUSE — FROZEN** (`wallet-backend-v1.0-frozen`) |
| Credit ledger template | `walletMoneyLedger` via `wallet-money-adapter.apply()` | `functions/wallet-money-adapter.js` | Template only — not integrated, not exported |
| Payout rail | `requestSellerPayout` → `payoutRequests` → IntaSend B2C; paid only on webhook | `functions/wallet.js:863-1019, 1580-1649` | **REUSE unchanged** — no new payout provider |
| Refund | `fosSubmitRefund` / `fosApproveRefund` (`fosRefundQueue`) | `functions/financial-os.js:427-689` | **REUSE**; add an `engine.revoke` hook. **Never** `refundRequests` (auto-credits a wallet) |
| Admin surface | `admin-os.html` + `adminOsDispatch` (`functions/admin-os.js._h`) | — | **EXTEND** — no new admin page |
| Admin auth | `admin-claim.js` `isAdmin`/`isSuperAdmin` | `functions/admin-claim.js` | **REUSE** |
| Media upload | `sokoni-media.js` / storage rules | `storage.rules` | **NEW PATH** `creator-masters/{uid}/**` — creator-write, **no client read**; playback by short-lived server-signed URL (pattern: `digital-hub.js:266`) |
| Test style | `scripts/test-*.js` tally + sabotage mutate/run/restore | `scripts/test-business-scope.js`, `scripts/sabotage-aos-products.js` | **REUSE** (`scripts/run-sabotage.js` does not exist) |

## 4. Blockers the audit found (these decide what "live" can mean)

**B1 — The settlement webhook would misroute film money.** On `COMPLETE`, `webhookIntasend`
credits `attribution.sellerUid || merchantUid || payData.uid` (`index.js:7805-7806`) — the full net
immediately. For a film sale that either (a) pays the creator 100% of net *now*, bypassing the
royalty split and the quarterly hold, or (b) with no `sellerUid`, **credits the buyer**. A film
purpose needs an explicit webhook branch that *skips* the seller credit (the way subscriptions do at
`:7810`) so the royalty ledger is the only accrual. That is a change to `webhookIntasend` — the
frozen settlement path.

**B2 — Payments are KES-only end to end.** STK payload (`index.js:6347`), `payments` docs
(`:6447`), `assertPaymentHonourable` currency check, orchestrator. Multi-currency is **not** a Creator
feature toggle; it is a payment-core change. Until then the honest statement is: *priced and settled
in KES; international cards may pay in KES where the account allows.*

**B3 — Multi-method checkout is not committed or verified.** No committed code creates a working
hosted IntaSend checkout. `shared/intasend-checkout.js` (leaves `method` unset → all enabled
methods) is another agent's untracked file, unverified live. "Payment methods available at
checkout" can only be claimed after `probe-intasend-capability.js` runs against the live account.

**B4 — Releasing royalties into a wallet touches the freeze.** The only withdrawable balance is
`wallets.balance`; making a closed quarter withdrawable means crediting it. `requestSellerPayout`
then works unchanged. The credit itself is a wallet mutation under `wallet-backend-v1.0-frozen`.

**B5 — Commercial policy is unset.** The royalty basis (is the IntaSend fee deducted before the
pool? is the SOKONI cut the existing `ppv` 15%?) is a business authorization, not an engineering
default. The code must refuse to accrue until a policy is recorded.

**B6 — Deployment is blocked independently** (Artifact Registry notice, merchant-identity provenance
gap, rules source at 105.7% of the size limit). Nothing here can go live in this slice regardless.

## 5. Security findings to repair while adopting

- `entertainmentListings` public read exposes `streamingUrl` (**media URL leak**).
- `digitalProducts`/Digital Esoko: public `fileURL`, client writes into CF-only collections.
- `purchaseEntertainment`: get-then-set claim outside a transaction; float money.
- `admin-os.js` `_requireAdmin` throws plain `Error` (client sees `internal`).

## 6. Owner decisions taken on this map (2026-09-26)

- Frozen money paths (B1 webhook, B4 wallet release): **change and commit, do not deploy.**
- Royalty pool: **gross − IntaSend fee − the existing `ppv` commission** (B5).
- Catalogue: **adopt `entertainmentListings`**; Creator lives inside the Entertainment hub.
- Scope: full vertical, staged.
