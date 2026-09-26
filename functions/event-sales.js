'use strict';
/**
 * SOKONI — Event-day cashier sales (Quick Sale): cash, external card, cashier-assisted IntaSend.
 * ============================================================================================
 * THE RULE: no ticket sale exists outside SOKONI. A cashier cannot take KES 2,000 and hand over a
 * ticket off the books — every door sale is created HERE, by a named, event-scoped staff member,
 * priced by the server, and produces the same canonical ticket (number + PIN) as an online sale.
 *
 *   tender 'cash'           cashier confirms cash received ≥ total → sale COMPLETED → tickets
 *                           issued → SOKONI 3 % recorded as a RECEIVABLE (the organizer holds the
 *                           cash) → netted from the organizer's next online settlement release.
 *   tender 'card_external'  a card taken on the ORGANIZER'S OWN terminal. Never "CARD → PAID":
 *                           it needs the terminal provider + transaction reference + an amount equal
 *                           to the server total. The reference is claimed once per organizer
 *                           (create()) — a replayed / reused reference is refused. Recorded as
 *                           operator-attested (paymentVerified:false), commission receivable as for
 *                           cash. No reference yet → PENDING_EXTERNAL: seats held, NO tickets, until
 *                           the reference is recorded (or the sale is cancelled / expires).
 *   tender 'intasend'       cashier-assisted M-PESA / hosted checkout: this creates an event ORDER
 *                           and the cashier completes it through the canonical createPaymentIntent
 *                           ('event_ticket') → STK → webhook → activation. Tickets and PINs come from
 *                           the SAME activation as online sales; there is no second payment rail.
 *
 * Idempotency: eventSaleClaims/{eventId}_{key}.create() in the sale transaction, bound to the actor
 * — a double-tapped Complete Sale returns the first sale; another actor cannot reuse the key.
 * Inventory is decremented in that same transaction; it can never go negative or oversell.
 * Commission comes from shared/commercial-policy `event_ticket` (3 %) — never from the client.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const OPS = require('./event-ops');
const POLICY = require('./shared/commercial-policy');

const _db = () => getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
let _now = () => Date.now();

const COL = Object.freeze({
  SALES: 'eventSales', CLAIMS: 'eventSaleClaims', CARD_REFS: 'eventCardRefClaims', TIERS: 'eventTicketTiers',
  TICKETS: 'eventTickets', EVENTS: 'events', ORDERS: 'eventOrders', SETTLEMENTS: 'eventSettlements',
  RECEIVABLES: 'eventCommissionReceivables', COMMISSION: 'commissionLedger', SECRETS: 'eventTicketSecrets',
});
const TENDERS = Object.freeze(['cash', 'card_external', 'intasend']);
const CARD_PROVIDERS = Object.freeze(['pesapal', 'kcb', 'equity', 'coop', 'absa', 'ncba', 'stanbic', 'dtb', 'ipay', 'flutterwave', 'other']);
const PENDING_TTL_MS = 30 * 60 * 1000;

const _cents = (kes) => Math.round(Number(kes) * 100);
const _ref = (r) => String(r == null ? '' : r).trim().toUpperCase().replace(/[^A-Z0-9_-]/g, '');

function _saleCommission(grossCents) {
  /* Door sales carry no provider fee (cash / organizer-held terminal): 3 % of the ticket value. */
  const c = POLICY.commissionCents('event_ticket', { grossCents, providerFeeCents: 0 });
  return { commissionCents: c.commission, commissionBps: c.bps, policy: c.policy, rateSource: c.source, basis: c.basis };
}

/** Read + validate the requested lines against the event's tiers (inside a transaction). */
async function _priceLines(txn, eventId, items) {
  if (!Array.isArray(items) || !items.length || items.length > 10) fail('invalid-argument', 'Add 1-10 ticket lines.');
  const nowMs = _now();
  const lines = [];
  for (const it of items) {
    const tierId = String((it && it.tierId) || '');
    const qty = Math.floor(Number(it && it.qty));
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(tierId)) fail('invalid-argument', 'Invalid ticket type.');
    if (!(qty >= 1 && qty <= 50)) fail('invalid-argument', 'Quantity must be 1-50 per line.');
    const ref = _db().collection(COL.TIERS).doc(tierId);
    const snap = await txn.get(ref); // eslint-disable-line no-await-in-loop
    if (!snap.exists || snap.data().eventId !== eventId) fail('not-found', 'Ticket type not found for this event.');
    const t = snap.data();
    if (t.isActive === false) fail('failed-precondition', `${t.name} is not on sale.`);
    if (t.saleEndsAt && Date.parse(t.saleEndsAt) < nowMs) fail('failed-precondition', `${t.name} sales have ended.`);
    if (t.saleStartsAt && Date.parse(t.saleStartsAt) > nowMs) fail('failed-precondition', `${t.name} sales have not started.`);
    const already = lines.find((l) => l.tierId === tierId);
    const want = qty + (already ? already.qty : 0);
    if ((Number(t.quantity) || 0) - (Number(t.sold) || 0) < want) fail('resource-exhausted', `Only ${Math.max(0, (Number(t.quantity) || 0) - (Number(t.sold) || 0))} ${t.name} left.`);
    if (already) { already.qty += qty; already.subtotalCents = already.unitCents * already.qty; continue; }
    const unitCents = _cents(t.price);
    lines.push({ tierId, tierName: t.name, qty, unitCents, subtotalCents: unitCents * qty, ref });
  }
  return lines;
}

function _issueTickets(txn, { sale, lines, event, soldBy, attendeeName }) {
  const out = [];
  for (const l of lines) {
    for (let i = 0; i < l.qty; i++) {
      const tRef = _db().collection(COL.TICKETS).doc();
      const cred = OPS.issueCredentials(txn, { eventId: event.id, ticketId: tRef.id, buyerUid: null, soldBy });
      txn.set(tRef, {
        ticketId: tRef.id, saleId: sale.id, orderId: null, eventId: event.id, tierId: l.tierId, tierName: l.tierName,
        buyerUid: null, walkIn: true, soldBy, channel: 'cashier', tender: sale.tender,
        attendeeName: attendeeName || null, status: 'valid', checkedIn: false,
        createdAt: FieldValue.serverTimestamp(), ...cred,
      });
      out.push(tRef.id);
    }
  }
  return out;
}

/* Post the money side of a COMPLETED door sale: settlement row (organizer-collected) + commission
   receivable + commission ledger row. All inside the sale transaction. */
function _postDoorSale(txn, { sale, event, grossCents }) {
  const c = _saleCommission(grossCents);
  txn.create(_db().collection(COL.SETTLEMENTS).doc(sale.id), {
    paymentRef: null, saleId: sale.id, orderId: null, eventId: event.id, organizerUid: event.organizerUid,
    channel: sale.tender === 'cash' ? 'CASH' : 'CARD_EXTERNAL', grossCents, providerFeeCents: 0, netCents: grossCents,
    commissionCents: c.commissionCents, organizerNetCents: grossCents - c.commissionCents, commissionBps: c.commissionBps,
    policy: c.policy, rateSource: c.rateSource, basis: c.basis, currency: 'KES',
    status: 'ORGANIZER_COLLECTED', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  txn.create(_db().collection(COL.RECEIVABLES).doc(sale.id), {
    saleId: sale.id, eventId: event.id, organizerUid: event.organizerUid, source: sale.tender,
    amountCents: c.commissionCents, collectedCents: 0, status: 'OUTSTANDING',
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  txn.create(_db().collection(COL.COMMISSION).doc(`evt_${sale.id}`), {
    ref: sale.id, source: 'event_ticket_door', category: 'event_tickets', eventId: event.id, uid: event.organizerUid,
    tender: sale.tender, policy: c.policy, basis: c.basis, rateSource: c.rateSource, commissionPct: c.commissionBps / 100,
    commissionCents: c.commissionCents, sokoniCut: c.commissionCents / 100, serviceTotal: grossCents / 100,
    status: 'receivable', createdAt: FieldValue.serverTimestamp(),
  });
  return c;
}

/* ═══ QUICK SALE ═══════════════════════════════════════════════════════════════════════════ */
async function quickSale(req) {
  const d = req.data || {};
  const actor = await OPS.resolveEventActor(req, d.eventId, OPS.CAPS.SELL);
  const event = actor.event;
  if (event.status !== 'live') fail('failed-precondition', 'This event is not selling tickets.');
  const tender = String(d.tender || '');
  if (!TENDERS.includes(tender)) fail('invalid-argument', `Payment must be one of: ${TENDERS.join(', ')}.`);
  const key = String(d.idempotencyKey || '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(key)) fail('invalid-argument', 'A sale key is required.');
  const attendeeName = String(d.attendeeName || '').trim().slice(0, 120) || null;
  const deviceSession = String(d.deviceSession || '').slice(0, 80) || null;

  const db = _db();
  const claimRef = db.collection(COL.CLAIMS).doc(`${event.id}_${key}`);
  const saleRef = db.collection(COL.SALES).doc();
  const evRef = db.collection(COL.EVENTS).doc(event.id);
  const card = d.card || null;

  const result = await db.runTransaction(async (txn) => {
    /* ── reads ── */
    const claim = await txn.get(claimRef);
    if (claim.exists) {
      const c = claim.data();
      if (c.actorUid !== actor.uid) fail('permission-denied', 'That sale key belongs to another cashier.');
      return { replay: true, saleId: c.saleId };
    }
    const evNow = await txn.get(evRef);
    const lines = await _priceLines(txn, event.id, d.items);
    const qtyTotal = lines.reduce((a, l) => a + l.qty, 0);
    const cap = evNow.data().capacity;
    if (cap && (Number(evNow.data().totalTicketsSold) || 0) + qtyTotal > cap) fail('resource-exhausted', 'This event is at capacity.');
    const grossCents = lines.reduce((a, l) => a + l.subtotalCents, 0);
    if (!(grossCents > 0)) fail('failed-precondition', 'Free tickets are issued through Event Hub, not the till.');

    let cardRefKey = null; let cardRef = null;
    if (tender === 'card_external' && card && card.reference) {
      const provider = String(card.provider || '').toLowerCase();
      if (!CARD_PROVIDERS.includes(provider)) fail('invalid-argument', 'Choose the card terminal provider.');
      cardRef = _ref(card.reference);
      if (cardRef.length < 6 || cardRef.length > 64) fail('invalid-argument', 'Enter the terminal transaction reference (6-64 characters).');
      if (_cents(card.amountKes) !== grossCents) fail('invalid-argument', `The card amount must equal the sale total (KES ${(grossCents / 100).toLocaleString()}).`);
      cardRefKey = db.collection(COL.CARD_REFS).doc(`${event.organizerUid}__${provider}__${cardRef}`);
      const used = await txn.get(cardRefKey);
      if (used.exists) fail('already-exists', 'That card reference has already been recorded for a sale.');
    }
    if (tender === 'cash') {
      const received = _cents(d.cashReceivedKes);
      if (!(received >= grossCents)) fail('invalid-argument', `Cash received must be at least KES ${(grossCents / 100).toLocaleString()}.`);
    }

    /* ── writes ── */
    for (const l of lines) txn.update(l.ref, { sold: FieldValue.increment(l.qty), updatedAt: FieldValue.serverTimestamp() });
    txn.update(evRef, { totalTicketsSold: FieldValue.increment(qtyTotal), updatedAt: FieldValue.serverTimestamp() });
    txn.create(claimRef, { saleId: saleRef.id, actorUid: actor.uid, eventId: event.id, createdAt: FieldValue.serverTimestamp() });

    const base = {
      saleId: saleRef.id, eventId: event.id, organizerUid: event.organizerUid, channel: 'cashier', tender,
      cashierUid: actor.uid, cashierRole: actor.role, deviceSession, idempotencyKey: key, attendeeName,
      lines: lines.map(({ ref, ...l }) => l), quantity: qtyTotal, grossCents, currency: 'KES',
      createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    };
    const sale = { id: saleRef.id, tender };

    if (tender === 'cash') {
      const received = _cents(d.cashReceivedKes);
      const c = _postDoorSale(txn, { sale, event, grossCents });
      const tickets = _issueTickets(txn, { sale, lines, event, soldBy: actor.uid, attendeeName });
      txn.create(saleRef, { ...base, status: 'COMPLETED', cashReceivedCents: received, changeCents: received - grossCents,
        commissionCents: c.commissionCents, ticketIds: tickets, completedAt: FieldValue.serverTimestamp() });
      return { saleId: saleRef.id, status: 'COMPLETED', tickets: tickets.length, changeCents: received - grossCents };
    }
    if (tender === 'card_external' && cardRefKey) {
      const c = _postDoorSale(txn, { sale, event, grossCents });
      const tickets = _issueTickets(txn, { sale, lines, event, soldBy: actor.uid, attendeeName });
      txn.create(cardRefKey, { saleId: saleRef.id, eventId: event.id, organizerUid: event.organizerUid, recordedBy: actor.uid, createdAt: FieldValue.serverTimestamp() });
      txn.create(saleRef, { ...base, status: 'COMPLETED', card: { provider: String(card.provider).toLowerCase(), reference: cardRef },
        paymentVerified: false, attestation: { by: actor.uid, role: actor.role, method: 'external_terminal_reference' },
        commissionCents: c.commissionCents, ticketIds: tickets, completedAt: FieldValue.serverTimestamp() });
      return { saleId: saleRef.id, status: 'COMPLETED', tickets: tickets.length };
    }
    if (tender === 'card_external') {
      txn.create(saleRef, { ...base, status: 'PENDING_EXTERNAL', expiresAt: Timestamp.fromMillis(_now() + PENDING_TTL_MS) });
      return { saleId: saleRef.id, status: 'PENDING_EXTERNAL' };
    }
    /* intasend — an order the cashier pays through the canonical intent → STK → activation path */
    const orderRef = db.collection(COL.ORDERS).doc(saleRef.id);
    if (lines.length !== 1) fail('invalid-argument', 'M-PESA / online payment at the till is one ticket type per sale.');
    const l = lines[0];
    txn.set(orderRef, {
      orderId: saleRef.id, buyerUid: actor.uid, channel: 'cashier', soldBy: actor.uid, saleId: saleRef.id,
      eventId: event.id, tierId: l.tierId, tierName: l.tierName, quantity: l.qty, unitPrice: l.unitCents / 100,
      subtotal: grossCents / 100, discountAmount: 0, totalAmount: grossCents / 100, currency: 'KES',
      attendeeName, status: 'pending_payment', createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    for (let i = 0; i < l.qty; i++) {
      const tRef = db.collection(COL.TICKETS).doc();
      txn.set(tRef, { ticketId: tRef.id, orderId: saleRef.id, saleId: saleRef.id, eventId: event.id, tierId: l.tierId, tierName: l.tierName,
        buyerUid: null, walkIn: true, soldBy: actor.uid, channel: 'cashier', tender, attendeeName, status: 'awaiting_payment',
        checkedIn: false, createdAt: FieldValue.serverTimestamp() });
    }
    txn.create(saleRef, { ...base, status: 'AWAITING_PAYMENT', orderId: saleRef.id });
    return { saleId: saleRef.id, status: 'AWAITING_PAYMENT', payment: { purpose: 'event_ticket', orderId: saleRef.id } };
  });

  if (result.replay) {
    const s = (await db.collection(COL.SALES).doc(result.saleId).get()).data() || {};
    return { saleId: result.saleId, status: s.status, replay: true };
  }
  logger.info('[eventSales] sale', { saleId: result.saleId, eventId: event.id, tender, status: result.status, by: actor.uid });
  return result;
}

/** Complete a PENDING_EXTERNAL card sale with its terminal reference (same cashier, or organizer/manager). */
async function confirmExternalCard(req) {
  const d = req.data || {};
  const actor = await OPS.resolveEventActor(req, d.eventId, OPS.CAPS.SELL);
  const event = actor.event;
  const saleRef = _db().collection(COL.SALES).doc(String(d.saleId || '_'));
  const provider = String(d.provider || '').toLowerCase();
  if (!CARD_PROVIDERS.includes(provider)) fail('invalid-argument', 'Choose the card terminal provider.');
  const cardRef = _ref(d.reference);
  if (cardRef.length < 6 || cardRef.length > 64) fail('invalid-argument', 'Enter the terminal transaction reference (6-64 characters).');
  const refKey = _db().collection(COL.CARD_REFS).doc(`${event.organizerUid}__${provider}__${cardRef}`);
  return _db().runTransaction(async (txn) => {
    const [ss, used] = await Promise.all([txn.get(saleRef), txn.get(refKey)]);
    if (!ss.exists || ss.data().eventId !== event.id) fail('not-found', 'Sale not found.');
    const s = ss.data();
    if (s.status !== 'PENDING_EXTERNAL') fail('failed-precondition', `Sale is ${s.status}.`);
    if (s.cashierUid !== actor.uid && !actor.caps.includes(OPS.CAPS.VIEW_SALES)) fail('permission-denied', 'Only the cashier who started this sale can complete it.');
    if (_ms(s.expiresAt) <= _now()) fail('failed-precondition', 'This pending sale has expired. Start a new sale.');
    if (_cents(d.amountKes) !== s.grossCents) fail('invalid-argument', `The card amount must equal the sale total (KES ${(s.grossCents / 100).toLocaleString()}).`);
    if (used.exists) fail('already-exists', 'That card reference has already been recorded for a sale.');
    const lines = s.lines;
    const sale = { id: saleRef.id, tender: 'card_external' };
    const c = _postDoorSale(txn, { sale, event, grossCents: s.grossCents });
    const tickets = _issueTickets(txn, { sale, lines, event, soldBy: s.cashierUid, attendeeName: s.attendeeName });
    txn.create(refKey, { saleId: saleRef.id, eventId: event.id, organizerUid: event.organizerUid, recordedBy: actor.uid, createdAt: FieldValue.serverTimestamp() });
    txn.update(saleRef, { status: 'COMPLETED', card: { provider, reference: cardRef }, paymentVerified: false,
      attestation: { by: actor.uid, role: actor.role, method: 'external_terminal_reference' },
      commissionCents: c.commissionCents, ticketIds: tickets, completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    return { saleId: saleRef.id, status: 'COMPLETED', tickets: tickets.length };
  });
}

/** Cancel a PENDING_EXTERNAL sale (or let the sweep expire it): seats are released, nothing issued. */
async function _releasePending(saleId, why, actorUid) {
  const db = _db();
  const saleRef = db.collection(COL.SALES).doc(String(saleId));
  return db.runTransaction(async (txn) => {
    const ss = await txn.get(saleRef);
    if (!ss.exists) fail('not-found', 'Sale not found.');
    const s = ss.data();
    if (s.status !== 'PENDING_EXTERNAL') return { skipped: `status_${s.status}` };
    for (const l of s.lines) txn.update(db.collection(COL.TIERS).doc(l.tierId), { sold: FieldValue.increment(-l.qty), updatedAt: FieldValue.serverTimestamp() });
    txn.update(db.collection(COL.EVENTS).doc(s.eventId), { totalTicketsSold: FieldValue.increment(-s.quantity), updatedAt: FieldValue.serverTimestamp() });
    txn.update(saleRef, { status: why === 'expired' ? 'EXPIRED' : 'CANCELLED', closedBy: actorUid || 'sweep', updatedAt: FieldValue.serverTimestamp() });
    return { released: s.quantity };
  });
}
async function cancelPending(req) {
  const d = req.data || {};
  const actor = await OPS.resolveEventActor(req, d.eventId, OPS.CAPS.SELL);
  const s = (await _db().collection(COL.SALES).doc(String(d.saleId || '_')).get()).data();
  if (!s || s.eventId !== actor.event.id) fail('not-found', 'Sale not found.');
  if (s.cashierUid !== actor.uid && !actor.caps.includes(OPS.CAPS.VIEW_SALES)) fail('permission-denied', 'Only the cashier who started this sale can cancel it.');
  return _releasePending(s.saleId, 'cancelled', actor.uid);
}
async function expirePendingSales(nowMs = _now()) {
  const snap = await _db().collection(COL.SALES).where('status', '==', 'PENDING_EXTERNAL').where('expiresAt', '<=', Timestamp.fromMillis(nowMs)).limit(200).get();
  let n = 0;
  for (const d of snap.docs) { try { const r = await _releasePending(d.id, 'expired', null); if (r.released) n++; } catch (e) { logger.error('[eventSales] expire failed', { saleId: d.id, err: e.message }); } } // eslint-disable-line no-await-in-loop
  return n;
}

/** Ticket numbers + PINs for a WALK-IN sale — to the cashier who made it, or organizer/manager. */
async function saleTickets(req) {
  const d = req.data || {};
  const actor = await OPS.resolveEventActor(req, d.eventId, OPS.CAPS.SELL);
  const saleId = String(d.saleId || '');
  const s = (await _db().collection(COL.SALES).doc(saleId || '_').get()).data();
  if (!s || s.eventId !== actor.event.id) fail('not-found', 'Sale not found.');
  if (s.cashierUid !== actor.uid && !actor.caps.includes(OPS.CAPS.VIEW_SALES)) fail('permission-denied', 'Only the cashier who made this sale can see its PINs.');
  const tix = await _db().collection(COL.TICKETS).where('saleId', '==', saleId).limit(100).get();
  const secrets = await Promise.all(tix.docs.map((t) => _db().collection(COL.SECRETS).doc(t.id).get()));
  return {
    saleId, status: s.status, tender: s.tender, grossCents: s.grossCents,
    tickets: tix.docs.map((t, i) => {
      const x = t.data(); const sec = secrets[i].exists ? secrets[i].data() : null;
      /* A PIN is released only for an issued, walk-in ticket this sale owns. */
      const pin = x.status === 'valid' && x.walkIn && sec && sec.soldBy === s.cashierUid ? sec.pin : null;
      return { ticketId: t.id, ticketNumber: x.ticketNumber || null, tierName: x.tierName, status: x.status, pin };
    }),
  };
}

/** Sales for the event: a cashier sees ONLY their own; organizer/manager see all, by channel. */
async function listSales(req) {
  const d = req.data || {};
  const actor = await OPS.resolveEventActor(req, d.eventId, OPS.CAPS.SELL);
  let q = _db().collection(COL.SALES).where('eventId', '==', actor.event.id);
  const all = actor.caps.includes(OPS.CAPS.VIEW_SALES);
  if (!all) q = q.where('cashierUid', '==', actor.uid);
  const snap = await q.limit(500).get();
  const rows = snap.docs.map((x) => { const s = x.data(); return { saleId: x.id, tender: s.tender, status: s.status, grossCents: s.grossCents, quantity: s.quantity, cashierUid: s.cashierUid, commissionCents: s.commissionCents == null ? null : s.commissionCents, createdAt: _ms(s.createdAt) }; });
  const byTender = {};
  rows.filter((r) => r.status === 'COMPLETED').forEach((r) => { const b = (byTender[r.tender] = byTender[r.tender] || { count: 0, grossCents: 0, tickets: 0 }); b.count++; b.grossCents += r.grossCents; b.tickets += r.quantity; });
  return { scope: all ? 'event' : 'mine', capped: snap.size >= 500, sales: rows, byTender };
}

const _ms = (v) => { if (!v) return null; if (typeof v.toMillis === 'function') return v.toMillis(); const t = new Date(v).getTime(); return Number.isFinite(t) ? t : null; };

const _h = {
  eventQuickSale: quickSale, eventConfirmExternalCard: confirmExternalCard, eventCancelPendingSale: cancelPending,
  eventSaleTickets: saleTickets, eventListSales: listSales,
};

module.exports = { COL, TENDERS, CARD_PROVIDERS, PENDING_TTL_MS, _h, expirePendingSales, _setClock: (fn) => { _now = fn || (() => Date.now()); } };
