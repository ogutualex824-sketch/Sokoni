# Availability v463 — Device Certification (Acceptance Gate)

**Build under test:** v463 (`/merchant` → Availability; enforcement in `createCheckoutSession`).
**Run on:** the real production device, signed in as the merchant (KASS shop), with a second
buyer session (or incognito) to attempt checkouts.
**Rule:** Availability is NOT certified — and the convergence pass does not continue — until every
box passes on the device. A Firestore field flip is not proof; the **server must reject the order**.

> ✅ pass · ❌ fail (note what happened). A single ❌ blocks certification.

---

## 1. Shop closed → new orders blocked (the core test)
- [ ] Availability → **Close Shop**.
- [ ] As a buyer, attempt a **brand-new checkout** for that shop → **server rejects it** (not just a UI message).
- [ ] **Open Shop** → attempt again → checkout **succeeds**.

## 2. Delivery channel
- [ ] **Delivery OFF** → attempt **delivery** checkout → rejected/unavailable.
- [ ] Switch to **pickup** (with Pickup ON) → **works**.

## 3. Pickup channel
- [ ] **Pickup OFF** → attempt **pickup** checkout → rejected/unavailable.
- [ ] Switch to **delivery** (with Delivery ON) → **works**.

## 4. Product availability
- [ ] **Pause** one product (Live → Paused) → attempt to purchase it → unavailable/rejected.
- [ ] **Un-pause** it → purchasable again.

## 5. Isolation & reversibility (no collateral damage)
- [ ] The paused product's `stock` was **not** changed.
- [ ] Closing/reopening the shop did **not** change any product's `status`/`isVisible`/`stock`.
- [ ] **Other** products were unaffected.
- [ ] Reopening the shop restores the intended sell state (nothing stuck closed).

## 6. Creation-only boundary (the transactional rule)
- [ ] Create an order while the shop is **open**, then **Close Shop** → the already-created order
      continues its normal lifecycle (accept/prepare/deliver) — it is **not** frozen or rejected.

---

## Sign-off
- Result: ☐ PASS (all ✅) ☐ FAIL (list ❌ below)
- Notes:
- Signed / date:

**On PASS →** continue the convergence pass: Layer 3 module reactions → Mini Shop→Shop →
Products↔Inventory↔POS↔Shop → Orders↔Delivery↔Pickup → AnalyticsEngine expansion → parity →
mobile/nav audit → v456 merchant cert → legacy retirement → Cart→Wishlist→Checkout→Buyer Orders →
final performance/freeze → `/merchant` default. **On FAIL →** report the ❌ item; it's fixed before proceeding.
