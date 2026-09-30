/* ══════════════════════════════════════════════════════════════════════════════
   SOKONI — WARRANTY PINNING
   functions/warranty-pin.js

   Freezes each product's warranty policy onto the order at the moment of purchase, and
   answers "what protection did I buy?" from that frozen copy for the rest of the order's
   life.

   ── WHY THE SERVER PINS IT, AND NOT THE CHECKOUT PAGE ─────────────────────────
   A policy copied by the browser is a policy the browser chose. A buyer who could write
   their own snapshot would grant themselves ninety days and a full refund on everything;
   a seller who could write it after the fact would take it away. So the snapshot is taken
   by onNewOrderCreated, from the product documents the order names, using the policy that
   existed at that instant — the one moment nobody can be editing it to suit themselves.

   ── WHY IT IS FROZEN AT ALL ───────────────────────────────────────────────────
   A seller who narrows their returns policy on Tuesday must not narrow what they promised
   on Monday. Nothing keeps a product's edit history, so the promise cannot be
   reconstructed later — it has to be captured when it is made, or it is gone.

   ── WHAT A MISSING POLICY MEANS ───────────────────────────────────────────────
   Absent, never assumed. A product with no configured warranty pins as NO_POLICY and the
   buyer's order says so plainly; it does not silently inherit a platform default, because
   a protection nobody promised is one nobody will honour when it is claimed.

   Impure by necessity — it reads products and writes the order. Every DECISION it makes is
   delegated to warranty-policy.js, which is pure and certified separately.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const WP = require('./warranty-policy');

const C_ORDERS = 'orders';
const C_PRODUCTS = 'products';

/** How many distinct products one order may pin. A cart is not a catalogue. */
const MAX_LINES = 60;

/**
 * Pin every line's policy onto the order.
 *
 * Idempotent: an order that already carries `warrantyPinnedAt` is left exactly as it is.
 * Re-pinning would replace a purchase-time promise with today's configuration, which is
 * the precise failure this module exists to prevent — so a retry, a re-fired trigger or a
 * manual replay must all be no-ops.
 */
async function pinPoliciesForOrder(db, orderId, order, opts) {
  const o = opts || {};
  const id = String(orderId || '').trim();
  if (!id) return { ok: false, reason: 'NO_ORDER_ID' };
  if (!order) return { ok: false, reason: 'NO_ORDER' };

  if (order.warrantyPinnedAt && o.force !== true) {
    return { ok: true, pinned: false, reason: 'ALREADY_PINNED', at: order.warrantyPinnedAt };
  }

  const items = Array.isArray(order.items) ? order.items.slice(0, MAX_LINES) : [];
  if (!items.length) return { ok: false, reason: 'ORDER_HAS_NO_ITEMS' };

  /* Read each distinct product once. A cart with the same item twice must not cost two
     reads, and both lines must pin the SAME policy — two lines of one product disagreeing
     about its warranty would be unanswerable. */
  const ids = [];
  items.forEach((it) => {
    const pid = String((it && (it.productId || it.id)) || '').trim();
    if (pid && ids.indexOf(pid) === -1) ids.push(pid);
  });

  const snaps = await Promise.all(ids.map((pid) =>
    db.collection(C_PRODUCTS).doc(pid).get().catch(() => null)));

  const byProduct = {};
  ids.forEach((pid, i) => {
    const snap = snaps[i];
    const data = (snap && snap.exists) ? (snap.data() || {}) : null;
    if (!data) { byProduct[pid] = { ok: false, reason: 'PRODUCT_NOT_FOUND' }; return; }

    /* The seller's configured policy, validated by the authority rather than trusted as
       stored. A product carrying a remedy this platform cannot deliver would otherwise pin
       a promise nothing will honour. */
    const pinned = WP.pinPolicy(data.warranty, o.at);
    byProduct[pid] = pinned.ok
      ? { ok: true, policy: pinned.pinned, productName: data.name || data.title || null }
      : { ok: false, reason: pinned.reason, detail: pinned.detail || null,
          productName: data.name || data.title || null };
  });

  const lines = items.map((it, n) => {
    const pid = String((it && (it.productId || it.id)) || '').trim();
    const r = byProduct[pid] || { ok: false, reason: 'NO_PRODUCT_ON_LINE' };
    return {
      line: n,
      productId: pid || null,
      /* PRODUCT IDENTITY travels with the pin, because "which item is this warranty for?"
         must be answerable from the order alone once a product has been renamed or
         removed. */
      productName: r.productName || (it && (it.name || it.title)) || null,
      qty: Number((it && (it.qty || it.quantity)) || 1),
      policy: r.ok ? r.policy : null,
      /* A NAMED ABSENCE, so a buyer is told "this seller offers no returns on this item"
         rather than being shown an empty panel they have to interpret. */
      noPolicyReason: r.ok ? null : r.reason,
    };
  });

  const patch = {
    warrantyPinnedAt: o.at || new Date().toISOString(),
    warrantyPinVersion: 'sokoni-warranty-v1',
    warrantyLines: lines,
    /* The whole order is protected only if every line is. Stated once so a surface does
       not have to re-derive it and reach a different answer. */
    warrantyAnyProtected: lines.some((l) => !!l.policy),
    warrantyAllProtected: lines.every((l) => !!l.policy),
  };

  await db.collection(C_ORDERS).doc(id).set(patch, { merge: true });
  return { ok: true, pinned: true, lines: lines.length, protected: patch.warrantyAnyProtected };
}

/* ── READING IT BACK ────────────────────────────────────────────────────────── */

/**
 * What protection this order actually carries, and how much of it is left.
 *
 * ALWAYS from the pinned copy. Reaching back to the product would answer with today's
 * configuration, which is the one thing this must never do.
 *
 * The clock is anchored to DELIVERY, per the pinned policy's own `startsAt`: seven days
 * measured from an order date gives the buyer of a slow parcel two days of protection, and
 * gives a seller with slow dispatch a shorter liability than one who ships the same
 * afternoon.
 */
function warrantyView(order, opts) {
  const o = opts || {};
  if (!order) return { ok: false, reason: 'NO_ORDER' };
  if (!order.warrantyPinnedAt) {
    /* Not "no warranty" — nothing has been recorded yet. A surface that showed an expired
       shield here would be telling the buyer something false about their own purchase. */
    return { ok: true, pinned: false, reason: 'NOT_PINNED', lines: [] };
  }

  const deliveredAt = o.deliveredAt || order.deliveredAt || null;
  const purchasedAt = o.purchasedAt || order.createdAt || order.warrantyPinnedAt || null;
  const now = o.now || Date.now();

  const hasArrived = deliveredAt != null ||
    /^(DELIVERED|COMPLETED|FULFILLED)$/.test(String(order.deliveryState || order.status || '').toUpperCase());

  const lines = (order.warrantyLines || []).map((l) => {
    if (!l.policy) {
      return { line: l.line, productId: l.productId, productName: l.productName,
               protected: false, reason: l.noPolicyReason || 'NO_POLICY' };
    }
    const win = WP.windowFor({ pinned: l.policy, deliveredAt, purchasedAt, now });
    return {
      line: l.line,
      productId: l.productId,
      productName: l.productName,
      protected: true,
      policyVersion: l.policy.policyVersion,
      durationDays: l.policy.durationDays,
      startsAt: l.policy.startsAt,
      remedies: l.policy.remedies.slice(),
      reasons: WP.optionsFor(l.policy).reasons,
      window: win,
      /* What a buyer may actually open right now — the whole point of the panel. */
      /* ACTIVE *and actually delivered*. Written as `A && B ? true : A` this reduced
         to plain `A`, so the delivery test could never change the answer and a
         purchase-anchored policy was claimable before the goods arrived. */
      canRequest: win.state === 'ACTIVE' && hasArrived,
    };
  });

  return {
    ok: true,
    pinned: true,
    pinnedAt: order.warrantyPinnedAt,
    anyProtected: lines.some((l) => l.protected),
    lines,
  };
}

module.exports = { pinPoliciesForOrder, warrantyView, MAX_LINES, C_ORDERS, C_PRODUCTS };
