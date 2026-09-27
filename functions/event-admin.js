'use strict';
/**
 * SOKONI — AdminOS › Events: investigation and financial trace (eventAdmin* ops).
 * ============================================================================================
 * Merged into adminOsDispatch through `_adminH` (functions/admin-os-dispatch.js). Every handler
 * re-checks the admin claim itself; nothing here is reachable from a non-admin caller.
 *
 * READ ops (no writes, except an audit row for a PIN identity lookup):
 *   eventAdminInvestigate   find tickets / orders / sales by event · ticket · ticket number · order ·
 *                           sale · buyer · cashier · card reference · PIN identity
 *   eventAdminTrace         Event → Ticket → Sale → Payment → Commission → Organizer proceeds →
 *                           Refund → Payout for ONE order, sale or ticket, each stage labelled
 *                           observed / empty / n/a (never a guessed value)
 *   eventAdminStaff         an event's temporary staff and invitations
 *   eventAdminAdmissions    an event's admissions and PIN lockout counters
 *   eventAdminRefundRequests  wizard refund requests (eventRefundRequests)
 *   eventAdminReceivables   door-sale commission receivables
 *   eventAdminFiscal        KRA eTIMS reconciliation queue: failed / pending / not-registered sales
 *                           and refunds owing a credit note (event-fiscal views, never invented)
 *   (investigate also searches by payment reference, admission / refund status within an event,
 *    and fiscal status; ticket rows show the PIN only as ••••)
 * WRITE op:
 *   eventAdminRevokeStaff   end a staff member's access at once (reason required, audited)
 *   eventAdminFiscalRetry   re-submit a sale's fiscal record, or re-queue its failed eTIMS invoice
 *                           (etims.requeueInvoice) — the SAME eTIMS paths; audited
 *
 * PIN HANDLING. A PIN is a bearer credential. An admin may ask "which ticket does PIN X of event E
 * belong to?" — the server hashes it with the event-bound HMAC and reads the index. The raw PIN is
 * never returned, never stored in the audit row, and every lookup is audited (hit or miss). No op
 * here reads eventTicketSecrets. Ticket rows are stripped of pinHash / token / qrData before they
 * leave the server; phone numbers and emails are masked.
 *
 * Money figures are copied from their owning records (settlements, commission ledger, wallet
 * transactions, refund queue). Nothing here computes or infers an amount.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const AC = require('./admin-claim');
const OPS = require('./event-ops');
const FISCAL = require('./event-fiscal');

const _db = () => getFirestore();
const fail = (code, msg) => { throw new HttpsError(code, msg); };
const LIMIT = 100;

const COL = Object.freeze({
  INVOICES: 'etimsInvoices',
  EVENTS: 'events', TICKETS: 'eventTickets', ORDERS: 'eventOrders', SALES: 'eventSales',
  SETTLEMENTS: 'eventSettlements', RECEIVABLES: 'eventCommissionReceivables', COMMISSION: 'commissionLedger',
  REFUND_REQUESTS: 'eventRefundRequests', FISCAL: 'eventFiscal', REFUNDS: 'fosRefundQueue', PAYMENTS: 'payments',
  WALLET_TX: 'walletTransactions', STAFF: 'eventStaff', INVITES: 'eventStaffInvites',
  ADMISSIONS: 'eventAdmissions', ATTEMPTS: 'eventPinAttempts', ADMIN_AUDIT: 'adminAudit',
});

/* Credentials never leave the server, whoever asks. */
const NEVER = new Set(['pin', 'pinHash', 'token', 'qrData', 'qrCode', 'secret', 'idempotencyKey']);

function _admin(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  if (!AC.isAdmin(req)) fail('permission-denied', 'Admin only.');
  return req.auth.uid;
}
function _id(v, what) { const s = String(v == null ? '' : v); if (!/^[A-Za-z0-9_-]{1,128}$/.test(s)) fail('invalid-argument', `${what} is invalid.`); return s; }

function maskPhone(v) { const s = String(v || '').replace(/\s/g, ''); return s.length < 6 ? '***' : s.slice(0, 4) + '***' + s.slice(-3); }
function maskEmail(v) { const s = String(v || ''); const at = s.indexOf('@'); return at < 1 ? '***' : s[0] + '***' + s.slice(at); }

/** A Firestore row safe to hand to AdminOS: credentials dropped, PII masked, Timestamps → ms. */
function clean(id, x) {
  if (!x) return null;
  const out = { id };
  /* A ticket's PIN is never returned — only that one exists. */
  if (x.pinHash) out.pinDisplay = '••••';
  for (const [k, v] of Object.entries(x)) {
    if (NEVER.has(k)) continue;
    if (/phone|msisdn/i.test(k) && typeof v === 'string') out[k] = maskPhone(v);
    else if (/email/i.test(k) && typeof v === 'string') out[k] = maskEmail(v);
    else out[k] = (v && typeof v.toMillis === 'function') ? v.toMillis() : v;
  }
  return out;
}
const _rows = (snap) => snap.docs.map((d) => clean(d.id, d.data()));
const _doc = async (col, id) => { if (!id) return null; const s = await _db().collection(col).doc(String(id)).get(); return s.exists ? clean(s.id, s.data()) : null; };
const _where = (col, f, v, n = LIMIT) => _db().collection(col).where(f, '==', v).limit(n).get().then(_rows);

async function _audit(action, actorUid, target, detail) {
  await _db().collection(COL.ADMIN_AUDIT).add({
    action, performedBy: actorUid, module: 'event-admin', target, after: detail || null, createdAt: FieldValue.serverTimestamp(),
  }).catch((e) => logger.error('[eventAdmin] audit write failed', { action, err: e.message }));
}

/* ═══ INVESTIGATE ═══════════════════════════════════════════════════════════════════════ */
const SEARCH_BY = Object.freeze(['event', 'ticket', 'ticketNumber', 'order', 'sale', 'paymentRef', 'buyer', 'cashier', 'cardRef', 'pin',
  'admissionStatus', 'refundStatus', 'fiscalStatus']);
const ADMISSION_STATES = Object.freeze(['ADMITTED', 'NOT_ADMITTED']);
const REFUND_STATES = Object.freeze(['NONE', 'REQUESTED', 'APPROVED', 'REFUNDED']);

/* Every search result carries the FISCAL state of its sale, derived from the eTIMS invoice. */
async function _decorate(out) {
  const keys = out.tickets.map(FISCAL.keyOfTicket).concat(out.sales.map((x) => x.paymentRef || x.id), out.orders.map((o) => o.paymentRef));
  const views = await FISCAL.viewsFor(keys.filter(Boolean).slice(0, 150));
  const fx = (k) => (k && views[k]) || null;
  out.tickets = out.tickets.map((t) => ({ ...t, fiscal: fx(FISCAL.keyOfTicket(t)) }));
  out.sales = out.sales.map((x) => ({ ...x, fiscal: fx(x.paymentRef || x.id) }));
  out.orders = out.orders.map((o) => ({ ...o, fiscal: fx(o.paymentRef) }));
  return out;
}

async function investigate(req) {
  const actor = _admin(req);
  const d = req.data || {};
  const by = String(d.by || '');
  if (!SEARCH_BY.includes(by)) fail('invalid-argument', `Search by one of: ${SEARCH_BY.join(', ')}.`);
  const raw = String(d.value == null ? '' : d.value).trim();
  const out = { by, tickets: [], orders: [], sales: [], fiscal: [] };

  if (by === 'pin') {
    /* PIN identity: resolved through the event-bound HMAC index. The PIN itself is not echoed,
       not stored, and the lookup is audited either way. */
    const eventId = _id(d.eventId, 'eventId');
    if (!OPS.normalizePin(raw)) fail('invalid-argument', 'A PIN is 4 digits.');
    const hit = await OPS.lookupPin(eventId, raw);
    await _audit('event_admin_pin_lookup', actor, { eventId }, { found: !!hit, ticketId: hit ? hit.ticketId : null });
    if (hit) { const t = await _doc(COL.TICKETS, hit.ticketId); if (t) out.tickets.push(t); }
    return _decorate(out);
  }
  if (by === 'ticketNumber') {
    const n = raw.toUpperCase();
    if (!OPS.TICKET_NUMBER_RE.test(n)) fail('invalid-argument', 'A ticket number looks like SK-EVT-2026-000184.');
    out.tickets = await _where(COL.TICKETS, 'ticketNumber', n, 10);
    return _decorate(out);
  }
  if (by === 'cardRef') {
    const ref = raw.toUpperCase().replace(/[^A-Z0-9_-]/g, '');
    if (ref.length < 4 || ref.length > 64) fail('invalid-argument', 'Enter the card terminal reference.');
    out.sales = await _where(COL.SALES, 'card.reference', ref, 20);
    return _decorate(out);
  }
  if (by === 'admissionStatus' || by === 'refundStatus') {
    /* Status searches are scoped to ONE event (an unscoped one would read the whole platform). */
    const eventId = _id(d.eventId, 'eventId');
    const val = raw.toUpperCase();
    if (!(by === 'admissionStatus' ? ADMISSION_STATES : REFUND_STATES).includes(val)) fail('invalid-argument', `Unknown ${by}.`);
    const snap = await _db().collection(COL.TICKETS).where('eventId', '==', eventId).where(by, '==', val).limit(LIMIT).get();
    out.tickets = _rows(snap);
    out.truncated = out.tickets.length >= LIMIT;
    return _decorate(out);
  }
  if (by === 'fiscalStatus') {
    const val = raw.toUpperCase();
    if (!FISCAL_STATES.includes(val)) fail('invalid-argument', 'Unknown fiscal status.');
    const { rows, truncated } = await _fiscalRows(d.eventId);
    out.fiscal = rows.filter((r) => _matchesState(r.view, val));
    out.truncated = truncated;
    return out;
  }

  const v = _id(raw, by);
  if (by === 'event') {
    [out.tickets, out.orders, out.sales] = await Promise.all([
      _where(COL.TICKETS, 'eventId', v), _where(COL.ORDERS, 'eventId', v), _where(COL.SALES, 'eventId', v)]);
  } else if (by === 'ticket') {
    const t = await _doc(COL.TICKETS, v); if (t) out.tickets.push(t);
  } else if (by === 'order') {
    const o = await _doc(COL.ORDERS, v); if (o) out.orders.push(o);
    out.tickets = await _where(COL.TICKETS, 'orderId', v);
  } else if (by === 'sale') {
    const s = await _doc(COL.SALES, v); if (s) out.sales.push(s);
    out.tickets = await _where(COL.TICKETS, 'saleId', v);
  } else if (by === 'paymentRef') {
    [out.orders, out.tickets, out.sales] = await Promise.all([_where(COL.ORDERS, 'paymentRef', v), _where(COL.TICKETS, 'paymentRef', v), _where(COL.SALES, 'paymentRef', v)]);
  } else if (by === 'buyer') {
    [out.orders, out.tickets] = await Promise.all([_where(COL.ORDERS, 'buyerUid', v), _where(COL.TICKETS, 'buyerUid', v)]);
  } else if (by === 'cashier') {
    [out.sales, out.tickets] = await Promise.all([_where(COL.SALES, 'cashierUid', v), _where(COL.TICKETS, 'soldBy', v)]);
  }
  out.truncated = [out.tickets, out.orders, out.sales].some((a) => a.length >= LIMIT);
  return _decorate(out);
}

/* ═══ FINANCIAL TRACE ═══════════════════════════════════════════════════════════════════ */
/* Evidence vocabulary: observed · empty (expected, absent) · n/a (does not apply to this channel). */
const stage = (name, state, record, note) => ({ stage: name, state, record: record || null, note: note || null });

async function trace(req) {
  _admin(req);
  const d = req.data || {};
  let orderId = d.orderId ? _id(d.orderId, 'orderId') : null;
  let saleId = d.saleId ? _id(d.saleId, 'saleId') : null;
  let ticket = null;
  if (d.ticketId) {
    ticket = await _doc(COL.TICKETS, _id(d.ticketId, 'ticketId'));
    if (!ticket) fail('not-found', 'Ticket not found.');
    orderId = orderId || ticket.orderId || null;
    saleId = saleId || ticket.saleId || null;
  }
  if (!orderId && !saleId) fail('invalid-argument', 'Give an orderId, saleId or ticketId.');

  let order = orderId ? await _doc(COL.ORDERS, orderId) : null;
  let sale = saleId ? await _doc(COL.SALES, saleId) : null;
  /* A cashier IntaSend sale IS an order with the sale's id; an order may name its sale. */
  if (!sale && order && order.saleId) sale = await _doc(COL.SALES, order.saleId);
  if (!order && sale && sale.orderId) order = await _doc(COL.ORDERS, sale.orderId);
  if (!order && !sale) fail('not-found', 'No order or sale with that reference.');

  const eventId = (order && order.eventId) || (sale && sale.eventId) || (ticket && ticket.eventId);
  const paymentRef = (order && order.paymentRef) || null;
  const doorSale = !!(sale && (sale.tender === 'cash' || sale.tender === 'card_external'));
  const settleKey = paymentRef || (doorSale ? sale.id : null);

  const [event, tickets, payment, settlement, commission, receivable, refundReq, fosRefund] = await Promise.all([
    _doc(COL.EVENTS, eventId),
    order ? _where(COL.TICKETS, 'orderId', order.id) : _where(COL.TICKETS, 'saleId', sale.id),
    paymentRef ? _doc(COL.PAYMENTS, paymentRef) : null,
    settleKey ? _doc(COL.SETTLEMENTS, settleKey) : null,
    settleKey ? _doc(COL.COMMISSION, `evt_${settleKey}`) : null,
    doorSale ? _doc(COL.RECEIVABLES, sale.id) : null,
    order ? _doc(COL.REFUND_REQUESTS, order.id) : null,
    paymentRef ? _doc(COL.REFUNDS, `ref_${paymentRef}`) : null,
  ]);
  const admissions = await Promise.all(tickets.map((t) => _doc(COL.ADMISSIONS, t.id)));
  const walletTx = settlement && settlement.walletTxId ? await _doc(COL.WALLET_TX, settlement.walletTxId) : null;
  /* KRA eTIMS: the fiscal record of this sale and its invoice — observed, never invented. */
  const fiscal = settleKey ? ((await FISCAL.viewsFor([settleKey]))[settleKey] || null) : null;
  const integ = event && event.organizerUid ? await (async () => { const st = await require('./entertainment-integrations').statusFor(event.organizerUid, {});
    const k = st.cards.find((c) => c.id === 'kra_etims').status; const pay = st.cards.find((c) => c.id === 'intasend').status;
    return { organizerUid: event.organizerUid, kraRegistration: k.registration, fiscalState: k.state, invoiceCapability: k.invoiceCapability.state,
      creditNoteCapability: k.creditNoteCapability.state, paymentState: pay.state }; })() : null;

  const ev = event ? { id: event.id, title: event.title, status: event.status, organizerUid: event.organizerUid,
    startDate: event.startDate || null, endDate: event.endDate || null, refundPolicy: event.refundPolicy || null } : null;
  const stages = [
    stage('event', ev ? 'observed' : 'empty', ev),
    /* integration → provider → capability → organizer: the organizer's eTIMS registration (PIN masked, no
       secret) and the payment / fiscal capability states — read from the canonical authorities */
    stage('integration', integ ? 'observed' : 'empty', integ, 'Status only — configuration lives in AdminOS › Integrations and on the organizer\'s eTIMS page.'),
    stage('tickets', tickets.length ? 'observed' : 'empty', tickets.map((t, i) => ({ ...t, admission: admissions[i] }))),
    stage('sale', sale ? 'observed' : 'n/a', sale, sale ? null : 'Online purchase — no cashier sale.'),
    doorSale ? stage('payment', 'n/a', null, sale.tender === 'cash' ? 'Cash collected at the door by the organizer.' : 'Card on the organizer\'s own terminal (reference on the sale).')
             : stage('payment', payment ? 'observed' : 'empty', payment, paymentRef ? null : 'The order has no payment reference.'),
    stage('fiscal', !settleKey ? 'n/a' : (fiscal && fiscal.reason !== 'NO_FISCAL_RECORD' ? 'observed' : 'empty'), fiscal ? { ...fiscal, creditNotes: undefined } : null,
      !settleKey ? 'Nothing was sold (free ticket).' : !fiscal ? 'No fiscal record for this sale.'
        : fiscal.fiscalStatus === 'FISCAL_ACCEPTED' ? 'KRA accepted the invoice; the receipt and QR shown are exactly as KRA returned them.'
        : fiscal.reason === 'ORGANIZER_NOT_REGISTERED' ? 'The organizer is not registered for eTIMS — no fiscal receipt exists (SOKONI does not invoice on their behalf).'
        : fiscal.reason === 'NO_FISCAL_RECORD' ? 'No fiscal record for this sale.'
        : fiscal.fiscalStatus === 'FISCAL_FAILED' ? 'Fiscal submission failed — reconcile in the Fiscal tab.' : 'Pending fiscal confirmation.'),
    stage('commission', commission ? 'observed' : (settleKey ? 'empty' : 'n/a'), commission,
      doorSale ? 'Door sale: SOKONI\'s commission is a receivable netted from the organizer\'s next online release.' : null),
    stage('receivable', doorSale ? (receivable ? 'observed' : 'empty') : 'n/a', receivable),
    stage('organizer_proceeds', settlement ? 'observed' : (settleKey ? 'empty' : 'n/a'), settlement),
    stage('fiscal_reversal', fiscal && fiscal.creditNotes && fiscal.creditNotes.length ? 'observed' : 'n/a', fiscal ? fiscal.creditNotes || [] : [],
      fiscal && fiscal.creditNotes && fiscal.creditNotes.length ? 'Credit note(s) linked to the ORIGINAL fiscal record, which is never changed. A reference exists only when KRA returned one.' : 'No credit note (no refund, or fiscalisation did not apply).'),
    stage('refund', (refundReq || fosRefund) ? 'observed' : (doorSale ? 'n/a' : 'empty'), { request: refundReq, refund: fosRefund },
      doorSale ? 'Door-sale refunds are settled offline by the organizer; SOKONI has no rail for them.' : (refundReq || fosRefund ? null : 'No refund requested.')),
    stage('payout', walletTx ? 'observed' : (settlement && settlement.status === 'RELEASED' ? 'empty' : 'n/a'), walletTx,
      settlement && settlement.status === 'RELEASED' && !walletTx ? 'Released with nothing credited (net absorbed by door-sale commission, or under KES 1).' : (walletTx ? 'Credited to the organizer wallet; withdrawal follows the wallet payout rail.' : 'Not released yet.')),
  ];
  return { orderId: order ? order.id : null, saleId: sale ? sale.id : null, paymentRef, channel: doorSale ? sale.tender : (sale ? 'cashier_intasend' : 'online'), stages };
}

/* ═══ STAFF / ADMISSIONS / REFUNDS / RECEIVABLES ═════════════════════════════════════════ */
async function staff(req) {
  _admin(req);
  const eventId = _id((req.data || {}).eventId, 'eventId');
  const [st, inv] = await Promise.all([_where(COL.STAFF, 'eventId', eventId, 200), _where(COL.INVITES, 'eventId', eventId, 200)]);
  const now = Date.now();
  return { staff: st.map((s) => ({ ...s, activeNow: OPS.staffActive(s, now).ok })), invites: inv };
}

async function admissions(req) {
  _admin(req);
  const eventId = _id((req.data || {}).eventId, 'eventId');
  const [rows, attempts] = await Promise.all([_where(COL.ADMISSIONS, 'eventId', eventId, 200), _where(COL.ATTEMPTS, 'eventId', eventId, 200)]);
  return { admissions: rows, attempts, truncated: rows.length >= 200 };
}

const REFUND_REQUEST_STATES = Object.freeze(['SUBMITTING', 'PENDING_REVIEW', 'DUPLICATE', 'REJECTED', 'REFUNDED']);
/* ═══ FISCAL RECONCILIATION (KRA eTIMS) ════════════════════════════════════════════════ */
const FISCAL_STATES = Object.freeze([...Object.values(FISCAL.FS), ...Object.values(FISCAL.CN)]);
/* one filter for the queue AND the search: a sale matches a fiscal status, or any of its credit notes does */
const _matchesState = (v, want) => v && (v.fiscalStatus === want || (v.creditNotes || []).some((c) => c.status === want));
const _needsAttention = (v) => v && ((v.fiscalStatus !== 'FISCAL_ACCEPTED' && v.reason !== 'FREE_TICKET')
  || (v.creditNotes || []).some((c) => c.status !== 'CREDIT_NOTE_ACCEPTED'));
async function _fiscalRows(eventId) {
  let q = _db().collection(COL.FISCAL);
  if (eventId) q = q.where('eventId', '==', _id(eventId, 'eventId'));
  const recs = _rows(await q.limit(300).get());
  const views = await FISCAL.viewsFor(recs.map((r) => r.saleKey || r.id));
  return { rows: recs.map((r) => ({ ...r, view: views[r.saleKey || r.id] || null })), truncated: recs.length >= 300 };
}
/** The reconciliation queue: sale fiscal states AND credit notes, in the ONE vocabulary. */
async function fiscalQueue(req) {
  _admin(req);
  const d = req.data || {};
  const want = d.view ? String(d.view) : null;
  if (want && !FISCAL_STATES.includes(want)) fail('invalid-argument', 'Unknown fiscal state.');
  const { rows, truncated } = await _fiscalRows(d.eventId);
  return { fiscal: rows.filter((r) => (want ? _matchesState(r.view, want) : _needsAttention(r.view))), truncated };
}

/** Retry one sale's fiscalisation through the SAME paths: re-submit the record, or re-queue its failed
 *  eTIMS invoice (etims.requeueInvoice). Accepted invoices are never touched. Audited. */
async function fiscalRetry(req) {
  const actor = _admin(req);
  const saleKey = _id((req.data || {}).saleKey, 'saleKey');
  const ref = _db().collection(COL.FISCAL).doc(saleKey);
  const snap = await ref.get();
  if (!snap.exists) fail('not-found', 'No fiscal record for that sale.');
  const f = snap.data();
  const v = (await FISCAL.viewsFor([saleKey]))[saleKey];
  let result;
  if (v.fiscalStatus === 'FISCAL_ACCEPTED' || v.reason === 'FREE_TICKET') fail('failed-precondition', `Nothing to retry: ${v.fiscalStatus}${v.reason ? ' (' + v.reason + ')' : ''}.`);
  if (f.invoiceId) {
    /* only a DEFINITIVELY failed invoice is re-queued: a queued one could otherwise transmit twice */
    const inv = await _doc(COL.INVOICES, f.invoiceId);
    if (!inv || inv.status !== 'failed') fail('failed-precondition', 'The invoice is still queued with eTIMS — nothing to retry yet.');
    result = await require('./etims').requeueInvoice(f.invoiceId);
  } else {
    await ref.update({ claimedAt: null, updatedAt: FieldValue.serverTimestamp() });
    result = await FISCAL.submit(saleKey);
  }
  await _audit('event_fiscal_retry', actor, { saleKey }, { before: v.status, invoiceId: f.invoiceId || null, result });
  return { ok: true, result };
}

/** Retry a credit note (FAILED → same credit note re-queued; REQUIRED → execute). An outcome-unknown
 *  credit note is refused until resolved with evidence. Only ids are read from the request — there is
 *  no field through which a receipt, reference or "accepted" state could be supplied. Audited. */
async function creditNoteRetry(req) {
  const actor = _admin(req);
  const executionId = _id((req.data || {}).executionId, 'executionId');
  const r = await FISCAL.retryCreditNote(executionId, actor);
  if (r.error === 'missing') fail('not-found', 'No such credit note.');
  if (r.error === 'outcome_unknown_needs_evidence') fail('failed-precondition', 'The provider outcome is unknown — resolve it with evidence first (super admin).');
  if (r.error) fail('failed-precondition', `Nothing to retry (${r.error.replace('nothing_to_retry_', '')}).`);
  await _audit('event_credit_note_retry', actor, { executionId }, { result: r });
  return { ok: true, result: r };
}

/** SUPER ADMIN: resolve an ambiguous SALE-invoice outcome (etims.resolveUnknownInvoice) — only as "KRA did
 *  not record it", with evidence; it may then be retried through the same queue. Acceptance (a receipt)
 *  can only come from KRA; nothing in the request can supply one. */
async function fiscalResolve(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  if (!AC.isSuperAdmin(req)) fail('permission-denied', 'Super admin only.');
  const d = req.data || {};
  const saleKey = _id(d.saleKey, 'saleKey');
  const f = await _doc(COL.FISCAL, saleKey);
  if (!f || !f.invoiceId) fail('not-found', 'No eTIMS invoice for that sale.');
  const ev = String(d.evidence || '').trim();
  if (ev.length < 10) fail('invalid-argument', 'Evidence (e.g. a KRA support reference) is required.');
  await require('./etims').resolveUnknownInvoice(f.invoiceId, { evidence: ev }, req.auth.uid);
  await _audit('event_fiscal_resolved', req.auth.uid, { saleKey, invoiceId: f.invoiceId }, { resolution: 'NOT_ACCEPTED', evidence: ev.slice(0, 300) });
  return { ok: true };
}

/** SUPER ADMIN: resolve an ambiguous credit-note outcome — ONLY as "the provider did not accept it",
 *  with evidence. Acceptance can never be asserted here; it arrives from the provider alone. */
async function creditNoteResolve(req) {
  if (!req.auth || !req.auth.uid) fail('unauthenticated', 'Sign in required.');
  if (!AC.isSuperAdmin(req)) fail('permission-denied', 'Super admin only.');
  const d = req.data || {};
  const executionId = _id(d.executionId, 'executionId');
  const r = await FISCAL.resolveUnknownCreditNote(executionId, { resolution: String(d.resolution || ''), evidence: d.evidence }, req.auth.uid);
  if (r.error === 'only_not_accepted') fail('invalid-argument', 'An unknown outcome can only be resolved as NOT_ACCEPTED here; acceptance comes from KRA alone.');
  if (r.error === 'evidence_required') fail('invalid-argument', 'Evidence (e.g. a KRA support reference) is required.');
  if (r.error === 'missing') fail('not-found', 'No such credit note.');
  if (r.error) fail('failed-precondition', r.error);
  await _audit('event_credit_note_resolved', req.auth.uid, { executionId }, { resolution: 'NOT_ACCEPTED', evidence: String(d.evidence || '').slice(0, 300) });
  return { ok: true };
}

async function refundRequests(req) {
  _admin(req);
  const st = (req.data || {}).status ? String(req.data.status) : null;
  if (st && !REFUND_REQUEST_STATES.includes(st)) fail('invalid-argument', 'Unknown status.');
  const q = st ? _db().collection(COL.REFUND_REQUESTS).where('status', '==', st) : _db().collection(COL.REFUND_REQUESTS);
  return { requests: _rows(await q.limit(200).get()) };
}

async function receivables(req) {
  _admin(req);
  const st = (req.data || {}).status ? String(req.data.status) : null;
  if (st && !['OUTSTANDING', 'COLLECTED'].includes(st)) fail('invalid-argument', 'Unknown status.');
  const q = st ? _db().collection(COL.RECEIVABLES).where('status', '==', st) : _db().collection(COL.RECEIVABLES);
  return { receivables: _rows(await q.limit(200).get()) };
}

async function revokeStaff(req) {
  const actor = _admin(req);
  const d = req.data || {};
  const eventId = _id(d.eventId, 'eventId');
  const uid = _id(d.uid, 'uid');
  const reason = String(d.reason || '').trim().slice(0, 300);
  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const ref = _db().collection(COL.STAFF).doc(`${eventId}_${uid}`);
  const before = await _db().runTransaction(async (txn) => {
    const s = await txn.get(ref);
    if (!s.exists) fail('not-found', 'No such staff member on this event.');
    txn.update(ref, { active: false, status: 'revoked', revokedAt: FieldValue.serverTimestamp(), revokedBy: actor, revokedByAdmin: true, revokeReason: reason });
    return s.data().status || null;
  });
  await _audit('event_staff_revoked_by_admin', actor, { eventId, uid }, { before, after: 'revoked', reason });
  return { ok: true };
}

const _adminH = {
  eventAdminInvestigate: investigate, eventAdminTrace: trace, eventAdminStaff: staff, eventAdminAdmissions: admissions,
  eventAdminRefundRequests: refundRequests, eventAdminReceivables: receivables, eventAdminRevokeStaff: revokeStaff,
  eventAdminFiscal: fiscalQueue, eventAdminFiscalRetry: fiscalRetry,
  eventAdminCreditNoteRetry: creditNoteRetry, eventAdminCreditNoteResolve: creditNoteResolve,
  eventAdminFiscalResolve: fiscalResolve,
};

module.exports = { _adminH, SEARCH_BY, clean, maskPhone, maskEmail };
