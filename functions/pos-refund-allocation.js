/* ══════════════════════════════════════════════════════════════════════════════════════
   REFUND ALLOCATION — which tender gets what, decided by the sale, not by the request.
   ══════════════════════════════════════════════════════════════════════════════════════
   A sale settled by several tenders can be refunded in part, and something has to decide
   which tender the money comes back on:

       KES 2,000 sale     1,200 Card + 500 M-PESA + 300 Points
       refund KES 800     ->  ?

   THE REQUEST DOES NOT GET TO CHOOSE. If a refund could nominate its own tender, the
   cheapest thing to return is always the customer's points — the shop keeps the cash and
   hands back loyalty it issued itself — and the monetary and loyalty ledgers drift apart
   one refund at a time, each one individually defensible. Allocation is therefore derived
   from the ORIGINAL TENDER SPLIT and recorded, so the same refund on the same sale always
   produces the same components.

   PRO-RATA, because it is the only split that is both deterministic and neutral: every
   tender bears the refund in the proportion it funded the sale. A waterfall would need a
   priority order, and any order advantages someone.

       800 / 2,000 = 40%   ->   Card 480   M-PESA 200   Points 120

   ── ROUNDING IS A MONEY QUESTION, NOT A COSMETIC ONE ─────────────────────────────────
   Pro-rata produces fractions, and rounding each share independently does not sum back to
   the refund: 1/3 of KES 10 three ways is 3.33 + 3.33 + 3.33 = 9.99, and the missing cent
   is real. Largest-remainder is used instead — floor every share, then hand the leftover
   units one at a time to the largest remainders — so the components ALWAYS sum to exactly
   the amount refunded. Ties break by original tender order, so the result is reproducible
   rather than merely correct.

   ── POINTS ARE A TENDER, AND ARE NOT MONEY ───────────────────────────────────────────
   The points component is allocated in KES like any other, then converted BACK to points
   at the rate the sale recorded, because pos-loyalty-reversal reverses a point count, not
   a cash figure. This module performs that conversion and nothing else with it: it moves
   no money, credits no balance and writes nothing.

   ── PURE ─────────────────────────────────────────────────────────────────────────────
   No reads, no writes, no clock. It runs inside the refund transaction the way the
   redemption authority runs inside the sale.
   ══════════════════════════════════════════════════════════════════════════════════════ */
'use strict';

/* Tender classes. CASH is separate not because it is unimportant but because SOKONI cannot
   electronically return physical money — a cash component is an INSTRUCTION to the till,
   settled by a person opening a drawer, and it must never be reported as provider-settled. */
const KIND = {
  CARD:   'CARD',
  MPESA:  'MPESA',
  BANK:   'BANK',
  CASH:   'CASH',
  POINTS: 'POINTS',
};

/* Which tenders are returned through a payment provider and therefore have a PENDING state
   between request and confirmation. The others complete without a provider round trip. */
const PROVIDER_KINDS = [KIND.CARD, KIND.MPESA, KIND.BANK];

const REASON = {
  NO_TENDERS:      'the-original-sale-records-no-tenders',
  NOT_POSITIVE:    'refund-amount-must-be-positive',
  EXCEEDS_SALE:    'refund-would-exceed-what-this-sale-collected',
  EXCEEDS_REMAINING:'refund-would-exceed-what-is-left-refundable-on-this-sale',
};

function _cents(kes) { return Math.round((Number(kes) || 0) * 100); }
function _kes(cents)  { return Math.round(Number(cents) || 0) / 100; }

function isProviderKind(kind) { return PROVIDER_KINDS.indexOf(String(kind || '').toUpperCase()) !== -1; }

/**
 * Split a refund across the tenders that funded the sale.
 *
 * @param tenders       [{ kind, amountKES, points? }] as RECORDED ON THE SALE
 * @param refundKES     how much is being refunded
 * @param priorRefunds  [{ components: [{ kind, amountKES }] }] already refunded on this sale
 * @param pointValueKES the rate the sale recorded, for converting the points share back
 *
 * @returns { ok, components:[{kind, amountKES, points?, viaProvider}], totalKES,
 *            alreadyRefundedKES, remainingKES, reason }
 *
 * Works ENTIRELY IN CENTS internally. Allocating in floating-point shillings and rounding
 * at the end is how a refund comes to be off by a cent from the sum of its own parts.
 */
function allocate({ tenders, refundKES, priorRefunds, pointValueKES }) {
  const none = (reason, extra) => Object.assign({
    ok: false, components: [], totalKES: 0,
    alreadyRefundedKES: 0, remainingKES: 0, reason,
  }, extra || {});

  const list = (tenders || []).filter((t) => t && _cents(t.amountKES) > 0);
  if (!list.length) return none(REASON.NO_TENDERS);

  const wantC = _cents(refundKES);
  if (!(wantC > 0)) return none(REASON.NOT_POSITIVE);

  const saleC = list.reduce((s, t) => s + _cents(t.amountKES), 0);

  /* What has already gone back, summed from the refund RECORDS rather than a counter on
     the sale — the same reasoning as the points ledger: a total derived from events cannot
     drift out of step with them. */
  const priorC = (priorRefunds || []).reduce((s, r) => {
    const comps = (r && r.components) || [];
    return s + comps.reduce((cs, c) => cs + _cents(c && c.amountKES), 0);
  }, 0);

  const remainingC = saleC - priorC;
  if (wantC > saleC) return none(REASON.EXCEEDS_SALE, { alreadyRefundedKES: _kes(priorC), remainingKES: _kes(remainingC) });
  if (wantC > remainingC) return none(REASON.EXCEEDS_REMAINING, { alreadyRefundedKES: _kes(priorC), remainingKES: _kes(remainingC) });

  /* Per-tender ceilings: a tender cannot give back more than it put in, less whatever it
     has already returned. Without this, pro-rata over a partially-refunded sale can ask a
     tender for more than it ever contributed. */
  const refundedByKind = {};
  (priorRefunds || []).forEach((r) => {
    ((r && r.components) || []).forEach((c) => {
      const k = String((c && c.kind) || '').toUpperCase();
      refundedByKind[k] = (refundedByKind[k] || 0) + _cents(c && c.amountKES);
    });
  });

  /* ── LARGEST REMAINDER ──────────────────────────────────────────────────────
     Floor each share, then distribute the leftover cents to the largest fractional
     remainders. Guarantees the parts sum to the whole. */
  const raw = list.map((t, i) => {
    const contribC = _cents(t.amountKES);
    const exact = (contribC * wantC) / saleC;
    const floorC = Math.floor(exact);
    return { i, kind: String(t.kind || '').toUpperCase(), contribC, exact, alloc: floorC,
             rem: exact - floorC, tender: t };
  });

  let leftover = wantC - raw.reduce((s, r) => s + r.alloc, 0);
  const order = raw.slice().sort((a, b) => (b.rem - a.rem) || (a.i - b.i));
  for (let k = 0; k < order.length && leftover > 0; k++) { order[k].alloc += 1; leftover -= 1; }

  /* Apply the ceilings, then re-home anything that had to be trimmed. A trimmed cent must
     land somewhere or the components stop summing to the refund. */
  let spill = 0;
  raw.forEach((r) => {
    const cap = r.contribC - (refundedByKind[r.kind] || 0);
    if (r.alloc > cap) { spill += r.alloc - cap; r.alloc = Math.max(0, cap); }
  });
  /* Re-home the trimmed amount in BULK, not a cent at a time. An earlier version added one
     cent per tender per pass and bounded the passes by the tender count, so it could place
     at most a handful of cents — re-homing a whole exhausted tender's share (KES 105 on a
     700 refund) left the components short by almost all of it, and the refund silently did
     not sum to itself. Each tender takes as much of the spill as its remaining headroom
     allows, in the same largest-remainder order, so the result stays deterministic. */
  for (let k = 0; k < order.length && spill > 0; k++) {
    const r = order[k];
    const cap = r.contribC - (refundedByKind[r.kind] || 0);
    const room = cap - r.alloc;
    if (room > 0) { const take = Math.min(room, spill); r.alloc += take; spill -= take; }
  }

  const rate = Number(pointValueKES);
  const components = raw.filter((r) => r.alloc > 0).map((r) => {
    const c = {
      kind: r.kind,
      amountKES: _kes(r.alloc),
      /* A provider component is REQUESTED here and confirmed elsewhere; cash and points
         complete without a provider round trip. Marked so no caller has to infer it. */
      viaProvider: isProviderKind(r.kind),
    };
    if (r.kind === KIND.POINTS) {
      /* Back to a point COUNT, at the sale's own rate — pos-loyalty-reversal reverses
         points, not shillings. Floored: returning a fraction of a point is not a thing,
         and rounding up would return more than the sale consumed. */
      c.points = (Number.isFinite(rate) && rate > 0) ? Math.floor(r.alloc / 100 / rate) : null;
    }
    return c;
  });

  return {
    ok: true,
    components,
    totalKES: _kes(components.reduce((s, c) => s + _cents(c.amountKES), 0)),
    alreadyRefundedKES: _kes(priorC),
    remainingKES: _kes(remainingC - wantC),
    reason: null,
  };
}

module.exports = { KIND, PROVIDER_KINDS, REASON, allocate, isProviderKind };
