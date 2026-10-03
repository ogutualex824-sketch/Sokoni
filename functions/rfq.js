'use strict';
/**
 * SOKONI — B2B RFQ authority (Request for Quotation)  ·  sokoni-f3, 2026-10-03
 * ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════
 * The ONE server authority for B2B RFQs. Before this there was none: sokoni-b2b.js kept RFQs, quotes, orders and
 * invoice numbers in browser localStorage (with 15 invented suppliers), and messages.js listed an `rfqs` collection
 * nothing ever wrote.
 *
 * OWNER DECISIONS (2026-10-03, asked directly):
 *   · SOKONI earns a LEAD FEE per RFQ a supplier RECEIVES (owner: KES 200 default, admin-configurable; VAT added per
 *     owner decision, rate from the tax engine — both owned by b2b-leads.js), invoiced monthly; NO % on orders.
 *     This module records one lead per (rfq, supplier) in b2bLeads (idempotent). It does not price or invoice it:
 *     the rate and the monthly SOKONI → supplier invoice belong to the commercial authority (sokoni-2f).
 *   · An accepted quotation becomes an order paid THROUGH SOKONI, held until delivery, settled to the supplier's
 *     business wallet. Here the accepted quote becomes a canonical purchase order (procPurchaseOrders, the
 *     procurement authority's own document) so approval, goods receipt (stock) and the supplier's inbound view
 *     work unchanged. The held payment is a separate purpose (sokoni-5b webhook) — not created here.
 *
 * TRUST CONTRACT
 *   · Buyer and supplier are BUSINESSES (businesses/{id}); every caller is authorized through procurement's
 *     _assertMerchantAuthority (owner, admins, or an employee holding the capability) and must act for an ACTIVE
 *     business (_assertActiveBusinessAudience). The payload never names who the caller is.
 *   · A supplier receives an RFQ only if it has consented: supply.enabled === true AND supply.acceptsLeads === true
 *     (a lead costs money — being discoverable is not consent to be charged). Never to oneself.
 *   · Prices come only from the supplier's quote; totals are computed here; VAT is the supplier's explicit
 *     declaration on the quote (0 or 16) — never inferred (docs/VAT_POLICY_2026-09-30.md).
 *   · The buyer's contact details are never exposed to suppliers; conversation is SOKONI messaging.
 *
 * Collections (Cloud-Function-only; no client rule — default deny):
 *   rfqs/{rfqId}                         the request (buyer side)
 *   rfqRecipients/{rfqId}__{supplierId}  one per supplier: status received → viewed → quoted | declined → accepted |
 *                                        rejected | closed
 *   rfqQuotes/{rfqId}__{supplierId}      the supplier's current quotation (re-quote = new version, negotiation)
 *   b2bLeads/{rfqId}__{supplierId}       the lead ledger the monthly lead invoice reads
 * One callable: rfqDispatch {op, ...}.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const REGION = 'us-central1';
const OPT = { region: REGION, enforceAppCheck: true, memory: '256MiB', timeoutSeconds: 60 };
const db = () => admin.firestore();
const F = admin.firestore.FieldValue;

const MAX_ITEMS = 50;
const MAX_DIRECT_SUPPLIERS = 10;     /* a buyer may name up to 10 suppliers in one RFQ */
const MAX_OPEN_SUPPLIERS = 5;        /* an open RFQ reaches at most 5 consenting suppliers (each is a paid lead) */
const MAX_RFQS_PER_DAY = 20;         /* per buyer business — protects suppliers from lead spam */
const VALID_DAYS_MIN = 1, VALID_DAYS_MAX = 30;
const RFQ_TTL_DAYS = 30;
const VAT_RATES = [0, 16];           /* declared by the supplier on the quote */

function err(message, code) { throw new HttpsError(code || 'invalid-argument', message); }
function san(s, max) { return s == null ? '' : String(s).replace(/<[^>]*>/g, '').trim().slice(0, max || 300); }
/* The lead month is Africa/Nairobi (EAT, UTC+3, no DST) — the monthly lead invoice (sokoni-2f b2b-leads.js) bills by
   EAT month, so a lead at 01:30 EAT on the 1st belongs to the NEW month even though it is still the old month in UTC.
   b2b-leads.monthOf is the authority when that module is in the tree; this fallback computes the identical value. */
function leadsMod() { try { return require('./b2b-leads'); } catch (e) { return null; } }
function ym(d) {
  const L = leadsMod();
  if (L && typeof L.monthOf === 'function') return L.monthOf(d || new Date());
  const t = new Date((d ? d.getTime() : Date.now()) + 3 * 3600000);
  return t.getUTCFullYear() + '-' + String(t.getUTCMonth() + 1).padStart(2, '0');
}
function isId(v) { return typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v); }
const rid = (rfqId, supplierId) => rfqId + '__' + supplierId;

/* procurement's authority helpers — ONE implementation, imported, never re-written here. Required lazily so a test
   can substitute the module. */
function proc() { return require('./procurement'); }
function notifySvc() { return require('./notify'); }

async function actingBusiness(request, requested, audienceMsg) {
  const P = proc();
  const businessId = await P._assertMerchantAuthority(request, requested);
  const biz = await P._assertActiveBusinessAudience(businessId,
    audienceMsg || 'B2B is for SOKONI businesses — register your business first.',
    'Your business is not active yet.');
  return { businessId: String(businessId), biz: biz || {} };
}

/* BUYER TYPE (owner 2026-10-03): ONE RFQ system for individuals and businesses — eligibility is decided here, never by
   a second RFQ collection. An INDIVIDUAL needs no business account but must have a SERVER-verified phone (suppliers pay
   for every RFQ they receive, so anonymous throwaway accounts must not be able to spray paid leads). The payload never
   names who the caller is: the uid comes from auth, the business from procurement's authority. */
const INDIVIDUAL_MAX_DIRECT = 5, INDIVIDUAL_MAX_OPEN = 3, INDIVIDUAL_MAX_PER_DAY = 5;
async function actingBuyer(request, d) {
  if (d && d.buyerType === 'individual') {
    const uid = request.auth.uid;
    const tokenPhone = request.auth.token && request.auth.token.phone_number;
    let verified = !!tokenPhone, name = '';
    const u = await db().collection('users').doc(uid).get();
    if (u.exists) { const ud = u.data() || {}; verified = verified || ud.phoneVerified === true; name = san(ud.displayName || ud.name || ud.fullName, 150); }
    if (!verified) err('Verify your phone number on SOKONI before requesting quotes (suppliers receive every request).', 'failed-precondition');
    return { buyerType: 'individual', businessId: null, buyerKey: 'u_' + uid, buyerName: name || 'SOKONI customer' };
  }
  const { businessId, biz } = await actingBusiness(request, d && d.merchantId);
  return { buyerType: 'business', businessId, buyerKey: 'b_' + businessId, buyerName: san(biz.name, 150) || 'SOKONI business' };
}
function ownsRfq(rfq, buyer, uid) {
  return buyer.buyerType === 'individual' ? (rfq.buyerType === 'individual' && rfq.createdBy === uid) : (rfq.buyerBusinessId === buyer.businessId);
}
/* Which commercial hub a lead belongs to — derived on the server from the RFQ / supplier categories (owner: one lead,
   one commercial event; the price per hub is the commercial authority's). */
const CONSTRUCTION_CATS = ['cement','steel','timber','roofing','bricks','tiles','paint','plumbing-materials','electrical-materials','windows-doors',
  'construction-tools','sand-gravel','safety-ppe','building-materials','hardware','construction','contractor','construction-company','welding-fabrication',
  'equipment-rental','construction-services','construction-transport','construction-architect'];
function hubFor(category, supplierCats) {
  const cats = [String(category || '').toLowerCase()].concat((supplierCats || []).map(function (c) { return String(c).toLowerCase(); }));
  return cats.some(function (c) { return CONSTRUCTION_CATS.indexOf(c) !== -1; }) ? 'construction' : 'b2b';
}

/* Commission category for an individual's accepted quote (sokoni-2f rfq_quote purpose: stamped HERE, server-side, never
   inferred by the payment purpose). Materials → marketplace 15%; contractor / service work → construction_service 0%
   (owner: subscription + lead fee); equipment → the rental row. From the RFQ category, else the supplier's own
   categories. Nothing recognisable → null and the acceptance is refused (fail closed, never a default). */
const SERVICE_CATS = ['contractor', 'construction', 'construction-company', 'welding-fabrication', 'construction-services', 'construction-transport', 'construction-architect'];
const MATERIAL_CATS = ['cement','steel','timber','roofing','bricks','tiles','paint','plumbing-materials','electrical-materials','windows-doors',
  'construction-tools','sand-gravel','safety-ppe','building-materials','hardware'];
function commissionCategoryFor(rfqCategory, supplierCats) {
  const pick = function (c) { c = String(c || '').toLowerCase();
    if (c === 'equipment-rental') return 'equipment-rental';
    if (SERVICE_CATS.indexOf(c) !== -1) return 'construction_service';
    if (MATERIAL_CATS.indexOf(c) !== -1) return 'building-materials';
    return null; };
  const fromRfq = pick(rfqCategory); if (fromRfq) return fromRfq;
  const found = (supplierCats || []).map(pick).filter(Boolean);
  if (found.indexOf('building-materials') !== -1) return 'building-materials';
  return found[0] || null;
}

function cleanItems(items) {
  if (!Array.isArray(items) || !items.length) err('Add at least one item to your RFQ.');
  if (items.length > MAX_ITEMS) err('An RFQ can list at most ' + MAX_ITEMS + ' items.');
  return items.map(function (it, i) {
    const name = san(it && it.name, 200);
    const qty = Math.floor(Number(it && it.qty));
    if (!name) err('Item ' + (i + 1) + ': a name is required.');
    if (!(qty >= 1) || qty > 10000000) err('Item ' + (i + 1) + ': quantity must be a whole number of at least 1.');
    const tp = it && it.targetPriceKES != null && it.targetPriceKES !== '' ? Number(it.targetPriceKES) : null;
    if (tp !== null && !(tp > 0)) err('Item ' + (i + 1) + ': target price must be positive (or left empty).');
    return { name, qty, unit: san(it && it.unit, 30) || 'unit', targetPriceKES: tp, notes: san(it && it.notes, 300) };
  });
}

/* A supplier that has CONSENTED to receive (paid) RFQ leads, as an active business. Returns its public projection. */
async function consentingSupplier(id) {
  if (!isId(id)) err('A valid supplier business id is required.');
  const snap = await db().collection('businesses').doc(id).get();
  if (!snap.exists) err('Supplier business not found.', 'not-found');
  const d = snap.data() || {};
  if (d.status !== 'active') err('That supplier is not active on SOKONI.', 'failed-precondition');
  const sup = d.supply || {};
  if (sup.enabled !== true) err('That business has not enabled supply on SOKONI.', 'failed-precondition');
  if (sup.acceptsLeads !== true) err('That supplier is not accepting RFQs on SOKONI yet.', 'failed-precondition');
  return { id, name: san(sup.displayName || d.name, 150) || 'Supplier', ownerUid: d.ownerId || null, categories: sup.categories || [], county: d.county || null };
}

/* ── ops ──────────────────────────────────────────────────────────────────────────────────────────────────── */
const H = {};

/* create {merchantId?, title, items[], supplierBusinessIds[] | open:{category, county?}, deliveryLocation, neededBy?, notes} */
H.create = async function (request) {
  const d = request.data || {};
  const buyer = await actingBuyer(request, d);
  const buyerId = buyer.businessId;                        /* null for an individual */
  const isInd = buyer.buyerType === 'individual';
  const items = cleanItems(d.items);
  const title = san(d.title, 150) || items[0].name;
  const deliveryLocation = san(d.deliveryLocation, 200);
  if (!deliveryLocation) err('Where should the goods be delivered?');
  const neededBy = d.neededBy && /^\d{4}-\d{2}-\d{2}$/.test(String(d.neededBy)) ? String(d.neededBy) : null;

  /* rate limit per buyer business (each recipient is a paid lead for a supplier) */
  const since = Date.now() - 86400000;
  const recent = await db().collection('rfqs').where('buyerKey', '==', buyer.buyerKey).limit(200).get();
  if (recent.docs.filter(function (x) { const t = x.data().createdAtMs || 0; return t > since; }).length >= (isInd ? INDIVIDUAL_MAX_PER_DAY : MAX_RFQS_PER_DAY)) {
    err('You have sent the maximum number of RFQs for today. Try again tomorrow.', 'resource-exhausted');
  }

  /* recipients */
  let suppliers = [], mode;
  if (Array.isArray(d.supplierBusinessIds) && d.supplierBusinessIds.length) {
    mode = 'direct';
    const capD = isInd ? INDIVIDUAL_MAX_DIRECT : MAX_DIRECT_SUPPLIERS;
    const ids = Array.from(new Set(d.supplierBusinessIds.map(String))).slice(0, capD + 1);
    if (ids.length > capD) err('Send an RFQ to at most ' + capD + ' suppliers at a time.');
    for (const id of ids) { if (id === buyerId) err('You cannot send an RFQ to your own business.'); suppliers.push(await consentingSupplier(id)); }
  } else if (d.open && typeof d.open === 'object') {
    mode = 'open';
    const category = san(d.open.category, 60).toLowerCase();
    if (!category) err('Choose a category for an open RFQ.');
    const county = san(d.open.county, 80).toLowerCase();
    const snap = await db().collection('businesses').where('supply.acceptsLeads', '==', true).limit(300).get();
    suppliers = snap.docs.map(function (x) { return { id: x.id, d: x.data() || {} }; })
      .filter(function (x) { const s = x.d.supply || {}; return x.id !== buyerId && x.d.status === 'active' && s.enabled === true && s.discoverable === true
        && (s.categories || []).map(function (c) { return String(c).toLowerCase(); }).indexOf(category) !== -1
        && (!county || String(x.d.county || '').toLowerCase() === county); })
      .slice(0, isInd ? INDIVIDUAL_MAX_OPEN : MAX_OPEN_SUPPLIERS)
      .map(function (x) { const s = x.d.supply || {}; return { id: x.id, name: san(s.displayName || x.d.name, 150) || 'Supplier', ownerUid: x.d.ownerId || null, categories: s.categories || [] }; });
    if (!suppliers.length) err('No supplier on SOKONI is accepting RFQs in that category yet. Try another category or send it to a specific supplier.', 'failed-precondition');
  } else err('Choose at least one supplier, or send an open RFQ by category.');

  /* An RFQ that grows out of a product-page enquiry (contactRequests) reuses that enquiry's commercial event for the
     supplier it was sent to, so the lead can never be billed twice. Verified on the server: the enquiry is the caller's
     and its seller owns one of the RFQ's suppliers. */
  let cqEvent = null;
  if (d.fromContactRequestId != null) {
    if (!isId(String(d.fromContactRequestId))) err('fromContactRequestId is not valid.');
    const cq = await db().collection('contactRequests').doc(String(d.fromContactRequestId)).get();
    const cqd = cq.exists ? (cq.data() || {}) : null;
    if (!cqd || cqd.buyerUid !== request.auth.uid) err('That enquiry was not found.', 'not-found');
    const match = suppliers.find(function (x) { return x.ownerUid && x.ownerUid === cqd.sellerUid; });
    if (!match) err('That enquiry was sent to a different seller than this RFQ.', 'failed-precondition');
    cqEvent = { supplierId: match.id, id: 'cq_' + String(d.fromContactRequestId) };
  }
  const ref = db().collection('rfqs').doc();
  const rfqId = ref.id, now = Date.now(), month = ym();
  const rfqCategory = mode === 'open' ? san(d.open.category, 60).toLowerCase() : null;
  /* Price SNAPSHOT for each lead ({priceKES, priceSource}) from the commercial authority, read BEFORE the delivery
     transaction (sokoni-2f): a mid-month price change then applies only to later leads. Absent module → {} and the
     invoice prices the row at billing time (flagged unsnapshotted) — still billed, never invented here. */
  /* HUB-AWARE LEAD LEDGER (sokoni-2f §23): one price snapshot per hub, read BEFORE the transaction. A hub with no price
     makes the commercial authority throw failed-precondition — the RFQ is refused rather than leads written unpriced.
     Business RFQs are hub 'b2b'; an individual's are 'construction' when its category / the supplier is construction. */
  const L = leadsMod();
  const hubOf = function (x) { return isInd ? hubFor(rfqCategory, x.categories) : 'b2b'; };
  const priceByHub = {};
  if (L && typeof L.leadFields === 'function') {
    for (const h of Array.from(new Set(suppliers.map(hubOf)))) {
      try { priceByHub[h] = (await L.leadFields(db(), { hub: h, tier: 'standard' })) || {}; }
      catch (e) {
        if (e && (e.code === 'failed-precondition' || /failed-precondition/.test(String(e.code || e.message)))) err('Quote requests in this category are not open on SOKONI yet.', 'failed-precondition');
        priceByHub[h] = {};   /* any other read failure: the invoice prices the row at billing time (flagged unsnapshotted) */
      }
    }
  }
  /* DELIVERY IS ONE TRANSACTION (sokoni-e3, 2026-10-03): each supplier's consent is RE-READ inside it, so a supplier
     who withdrew acceptsLeads between selection and delivery is never billed. The lead row records acceptsLeadsAt —
     the evidence of consent the monthly invoice relies on. A supplier whose consent vanished is dropped; if none remain
     the whole RFQ is refused (nothing written, nobody billed). */
  const delivered = await db().runTransaction(async function (t) {
    const snaps = await Promise.all(suppliers.map(function (s) { return t.get(db().collection('businesses').doc(s.id)); }));
    const ok = [];
    snaps.forEach(function (snap, i) {
      const bd = snap.exists ? (snap.data() || {}) : {};
      const sup = bd.supply || {};
      if (bd.status === 'active' && sup.enabled === true && sup.acceptsLeads === true) ok.push(Object.assign({}, suppliers[i], { ownerUid: bd.ownerId || null, acceptsLeadsAt: sup.acceptsLeadsAt || null, categories: sup.categories || [] }));
    });
    if (!ok.length) err('The supplier is no longer accepting RFQs on SOKONI.', 'failed-precondition');
    if (mode === 'direct' && ok.length !== suppliers.length) err('One of the suppliers you chose has stopped accepting RFQs. Remove it and try again.', 'failed-precondition');
    t.set(ref, { rfqId, buyerType: buyer.buyerType, buyerKey: buyer.buyerKey, buyerBusinessId: buyerId, buyerName: buyer.buyerName, createdBy: request.auth.uid, category: rfqCategory,
      title, items, deliveryLocation, neededBy, notes: san(d.notes, 1000), mode,
      recipientIds: ok.map(function (x) { return x.id; }), status: 'submitted',
      createdAt: F.serverTimestamp(), createdAtMs: now, expiresAtMs: now + RFQ_TTL_DAYS * 86400000 });
    for (const x of ok) {
      t.set(db().collection('rfqRecipients').doc(rid(rfqId, x.id)), { rfqId, supplierBusinessId: x.id, supplierName: x.name, supplierOwnerUid: x.ownerUid,
        buyerBusinessId: buyerId, buyerUid: request.auth.uid, title, status: 'received', receivedAt: F.serverTimestamp(), receivedAtMs: now });
      /* ONE lead per (rfq, supplier) — the monthly lead invoice (commercial authority) reads this; no price here. */
      /* ONE commercial event per (rfq, supplier) — the doc id IS the commercialEventId, and create() refuses a second
         one, so the same lead can never be billed twice. hub picks the price row (commercial authority); every lead is
         'standard' until the owner defines explicit qualified-lead rules. The b2b price snapshot applies to b2b leads only. */
      /* business buyers keep the decided B2B lead rule; the construction hub applies to individual RFQs (owner 10-03) */
      const hub = hubOf(x);
      const leadId = rid(rfqId, x.id);
      /* one event per (rfq, supplier): a fan-out RFQ is N events — except the supplier an earlier enquiry reached, which
         keeps that enquiry's event ('cq_<id>') */
      const commercialEventId = cqEvent && cqEvent.supplierId === x.id ? cqEvent.id : 'rfq_' + leadId;
      t.create(db().collection('b2bLeads').doc(leadId), { supplierBusinessId: x.id, supplierOwnerUid: x.ownerUid, rfqId,
        buyerBusinessId: buyerId, buyerType: buyer.buyerType, hub, tier: 'standard', commercialEventId,
        month, source: 'rfq', consentAcceptsLeadsAt: x.acceptsLeadsAt, ...(priceByHub[hub] || {}), createdAt: F.serverTimestamp() });
      /* the bill-once claim (leadClaims/{commercialEventId}, create()) — a second fee for the same event aborts the txn */
      if (L && typeof L.leadClaimWrite === 'function') L.leadClaimWrite(t, db(), { commercialEventId, hub, leadId, supplierBusinessId: x.id });
    }
    return ok;
  });
  suppliers = delivered;

  /* notify each supplier's owner — best effort; never blocks the RFQ */
  for (const s of suppliers) {
    if (!s.ownerUid) continue;
    try {
      await notifySvc().notify({ uid: s.ownerUid, type: 'rfq_received', title: 'New RFQ on SOKONI',
        body: (isInd ? 'A SOKONI customer' : (san(buyer.buyerName, 80) || 'A SOKONI business')) + ' sent you a request for quotation: ' + title.slice(0, 80),
        deepLink: '/merchant-v2.html#rfqs', dedupeKey: 'rfq:' + rfqId + ':' + s.id + ':received', data: { rfqId } });
    } catch (e) { /* notification failure is not an RFQ failure */ }
  }
  return { rfqId, mode, buyerType: buyer.buyerType, recipients: suppliers.map(function (s) { return { supplierBusinessId: s.id, name: s.name }; }) };
};

/* listMine {merchantId?} — the buyer's RFQs with each recipient's status and quote total */
H.listMine = async function (request) {
  const d = request.data || {};
  const buyer = await actingBuyer(request, d);
  const snap = await db().collection('rfqs').where('buyerKey', '==', buyer.buyerKey).limit(100).get();
  const rfqs = snap.docs.map(function (x) { return x.data(); }).sort(function (a, b) { return (b.createdAtMs || 0) - (a.createdAtMs || 0); }).slice(0, 50);
  const out = [];
  for (const r of rfqs) {
    const rs = await db().collection('rfqRecipients').where('rfqId', '==', r.rfqId).limit(MAX_DIRECT_SUPPLIERS).get();
    const recips = [];
    for (const x of rs.docs) {
      const v = x.data();
      let quote = null;
      if (v.status === 'quoted' || v.status === 'accepted' || v.status === 'rejected') {
        const q = await db().collection('rfqQuotes').doc(rid(r.rfqId, v.supplierBusinessId)).get();
        if (q.exists) { const qd = q.data(); quote = { lines: qd.lines, subtotalKES: qd.subtotalKES, vatRate: qd.vatRate, vatKES: qd.vatKES, deliveryFeeKES: qd.deliveryFeeKES, totalKES: qd.totalKES, validUntilMs: qd.validUntilMs, notes: qd.notes, version: qd.version, status: qd.status }; }
      }
      recips.push({ supplierBusinessId: v.supplierBusinessId, supplierName: v.supplierName, status: v.status, quote, poId: v.poId || null });
    }
    out.push({ rfqId: r.rfqId, title: r.title, items: r.items, status: r.status, mode: r.mode, deliveryLocation: r.deliveryLocation, neededBy: r.neededBy, createdAtMs: r.createdAtMs, expiresAtMs: r.expiresAtMs, recipients: recips });
  }
  return { rfqs: out };
};

/* listReceived {merchantId?} — the supplier's inbox */
H.listReceived = async function (request) {
  const d = request.data || {};
  const { businessId } = await actingBusiness(request, d.merchantId);
  const snap = await db().collection('rfqRecipients').where('supplierBusinessId', '==', businessId).limit(200).get();
  const rows = snap.docs.map(function (x) { return x.data(); }).sort(function (a, b) { return (b.receivedAtMs || 0) - (a.receivedAtMs || 0); }).slice(0, 100);
  return { rfqs: rows.map(function (v) { return { rfqId: v.rfqId, title: v.title, status: v.status, receivedAtMs: v.receivedAtMs, buyerBusinessId: v.buyerBusinessId }; }) };
};

/* get {rfqId, merchantId?} — buyer or a recipient supplier; a supplier opening it marks it viewed */
H.get = async function (request) {
  const d = request.data || {};
  if (!isId(d.rfqId)) err('rfqId is required.');
  if (d.buyerType === 'individual') {
    const ib = await actingBuyer(request, d);
    const ir = await db().collection('rfqs').doc(d.rfqId).get();
    if (!ir.exists || !ownsRfq(ir.data(), ib, request.auth.uid)) err('RFQ not found.', 'not-found');
    const v = ir.data();
    return { role: 'buyer', rfq: { rfqId: v.rfqId, title: v.title, items: v.items, deliveryLocation: v.deliveryLocation, neededBy: v.neededBy, notes: v.notes, status: v.status, mode: v.mode, createdAtMs: v.createdAtMs, expiresAtMs: v.expiresAtMs } };
  }
  const { businessId } = await actingBusiness(request, d.merchantId);
  const r = await db().collection('rfqs').doc(d.rfqId).get();
  if (!r.exists) err('RFQ not found.', 'not-found');
  const rfq = r.data();
  if (rfq.buyerType !== 'individual' && rfq.buyerBusinessId === businessId) return { role: 'buyer', rfq: { rfqId: rfq.rfqId, title: rfq.title, items: rfq.items, deliveryLocation: rfq.deliveryLocation, neededBy: rfq.neededBy, notes: rfq.notes, status: rfq.status, mode: rfq.mode, createdAtMs: rfq.createdAtMs, expiresAtMs: rfq.expiresAtMs } };
  const recRef = db().collection('rfqRecipients').doc(rid(d.rfqId, businessId));
  const rec = await recRef.get();
  if (!rec.exists) err('RFQ not found.', 'not-found');   /* not a recipient — same answer as missing */
  if (rec.data().status === 'received') await recRef.update({ status: 'viewed', viewedAt: F.serverTimestamp() });
  const q = await db().collection('rfqQuotes').doc(rid(d.rfqId, businessId)).get();
  return { role: 'supplier', status: rec.data().status === 'received' ? 'viewed' : rec.data().status,
    rfq: { rfqId: rfq.rfqId, title: rfq.title, items: rfq.items, deliveryLocation: rfq.deliveryLocation, neededBy: rfq.neededBy, notes: rfq.notes, buyerName: rfq.buyerName, status: rfq.status, createdAtMs: rfq.createdAtMs, expiresAtMs: rfq.expiresAtMs },
    myQuote: q.exists ? q.data() : null };
};

async function supplierRecipient(request, d) {
  if (!isId(d.rfqId)) err('rfqId is required.');
  const { businessId } = await actingBusiness(request, d.merchantId);
  const recRef = db().collection('rfqRecipients').doc(rid(d.rfqId, businessId));
  const rec = await recRef.get();
  if (!rec.exists) err('RFQ not found.', 'not-found');
  const r = await db().collection('rfqs').doc(d.rfqId).get();
  if (!r.exists) err('RFQ not found.', 'not-found');
  return { businessId, recRef, rec: rec.data(), rfq: r.data() };
}

/* decline {rfqId, reason?} — supplier */
H.decline = async function (request) {
  const d = request.data || {};
  const { recRef, rec } = await supplierRecipient(request, d);
  if (['accepted', 'closed'].indexOf(rec.status) !== -1) err('This RFQ is already closed.', 'failed-precondition');
  await recRef.update({ status: 'declined', declineReason: san(d.reason, 300) || null, declinedAt: F.serverTimestamp() });
  return { ok: true, status: 'declined' };
};

/* quote {rfqId, lines:[{name, qty, unitPriceKES}], vatRate (0|16), deliveryFeeKES?, validDays, notes?} — supplier; re-quote = new version */
H.quote = async function (request) {
  const d = request.data || {};
  const { businessId, recRef, rec, rfq } = await supplierRecipient(request, d);
  if (rfq.status !== 'submitted') err('This RFQ is no longer open.', 'failed-precondition');
  if (Date.now() > (rfq.expiresAtMs || 0)) err('This RFQ has expired.', 'failed-precondition');
  if (['accepted', 'closed', 'declined'].indexOf(rec.status) !== -1) err('You can no longer quote on this RFQ.', 'failed-precondition');
  if (!Array.isArray(d.lines) || !d.lines.length || d.lines.length > MAX_ITEMS) err('Quote at least one line.');
  const lines = d.lines.map(function (l, i) {
    const name = san(l && l.name, 200), qty = Math.floor(Number(l && l.qty)), unit = Number(l && l.unitPriceKES);
    if (!name) err('Line ' + (i + 1) + ': name is required.');
    if (!(qty >= 1)) err('Line ' + (i + 1) + ': quantity must be at least 1.');
    if (!(unit > 0) || unit > 1e9) err('Line ' + (i + 1) + ': unit price must be a positive amount.');
    return { name, qty, unitPriceKES: Math.round(unit * 100) / 100, lineTotalKES: Math.round(qty * unit * 100) / 100 };
  });
  const vatRate = Number(d.vatRate);
  if (VAT_RATES.indexOf(vatRate) === -1) err('State the VAT on your quote: 0 or 16 (%). SOKONI never assumes it.');
  const deliveryFeeKES = d.deliveryFeeKES == null || d.deliveryFeeKES === '' ? 0 : Number(d.deliveryFeeKES);
  if (!(deliveryFeeKES >= 0) || deliveryFeeKES > 1e9) err('Delivery fee cannot be negative.');
  const validDays = Math.floor(Number(d.validDays));
  if (!(validDays >= VALID_DAYS_MIN && validDays <= VALID_DAYS_MAX)) err('A quote is valid for 1 to 30 days.');
  const subtotalKES = Math.round(lines.reduce(function (s, l) { return s + l.lineTotalKES; }, 0) * 100) / 100;
  const vatKES = Math.round(subtotalKES * vatRate) / 100;
  const totalKES = Math.round((subtotalKES + vatKES + deliveryFeeKES) * 100) / 100;
  const qRef = db().collection('rfqQuotes').doc(rid(d.rfqId, businessId));
  const prev = await qRef.get();
  const version = prev.exists ? (Number(prev.data().version) || 1) + 1 : 1;
  await qRef.set({ rfqId: d.rfqId, supplierBusinessId: businessId, supplierName: rec.supplierName, buyerBusinessId: rfq.buyerBusinessId,
    lines, subtotalKES, vatRate, vatKES, deliveryFeeKES, totalKES, currency: 'KES', validUntilMs: Date.now() + validDays * 86400000,
    notes: san(d.notes, 1000), status: 'quoted', version, quotedBy: request.auth.uid, updatedAt: F.serverTimestamp() });
  await recRef.update({ status: 'quoted', quotedAt: F.serverTimestamp(), quoteVersion: version });
  if (rfq.createdBy) {
    try {
      await notifySvc().notify({ uid: rfq.createdBy, type: 'rfq_quoted', title: 'New quotation on your RFQ',
        body: (rec.supplierName || 'A supplier') + ' quoted KES ' + totalKES.toLocaleString('en-KE') + ' on "' + String(rfq.title).slice(0, 60) + '"',
        deepLink: '/merchant-v2.html#rfqs', dedupeKey: 'rfq:' + d.rfqId + ':' + businessId + ':quoted:v' + version, data: { rfqId: d.rfqId } });
    } catch (e) {}
  }
  return { ok: true, totalKES, version };
};

/* respond {rfqId, supplierBusinessId, action:'accept'|'reject', expectedVersion} — buyer. Accept → a canonical purchase
   order (procPurchaseOrders) priced from the quote; the RFQ closes; other recipients are closed. */
H.respond = async function (request) {
  const d = request.data || {};
  if (!isId(d.rfqId) || !isId(d.supplierBusinessId)) err('rfqId and supplierBusinessId are required.');
  if (['accept', 'reject'].indexOf(d.action) === -1) err('action must be accept or reject.');
  const buyer = await actingBuyer(request, d);
  const buyerId = buyer.businessId;
  const rfqRef = db().collection('rfqs').doc(d.rfqId);
  const recRef = db().collection('rfqRecipients').doc(rid(d.rfqId, d.supplierBusinessId));
  const qRef = db().collection('rfqQuotes').doc(rid(d.rfqId, d.supplierBusinessId));

  if (d.action === 'reject') {
    const [r, q] = await Promise.all([rfqRef.get(), qRef.get()]);
    if (!r.exists || !ownsRfq(r.data(), buyer, request.auth.uid)) err('RFQ not found.', 'not-found');
    if (!q.exists || q.data().status !== 'quoted') err('There is no open quotation to reject.', 'failed-precondition');
    await qRef.update({ status: 'rejected', rejectedAt: F.serverTimestamp() });
    await recRef.update({ status: 'rejected' });
    return { ok: true, status: 'rejected' };
  }

  /* accept — all checks and writes in one transaction (no double acceptance, no stale quote) */
  const out = await db().runTransaction(async function (t) {
    const [r, rec, q] = await Promise.all([t.get(rfqRef), t.get(recRef), t.get(qRef)]);
    if (!r.exists || !ownsRfq(r.data(), buyer, request.auth.uid)) err('RFQ not found.', 'not-found');
    const rfq = r.data();
    if (rfq.status !== 'submitted') err('This RFQ is already closed.', 'failed-precondition');
    if (!rec.exists || !q.exists) err('No quotation from that supplier.', 'failed-precondition');
    const quote = q.data();
    if (quote.status !== 'quoted') err('That quotation is no longer open.', 'failed-precondition');
    if (Date.now() > (quote.validUntilMs || 0)) err('That quotation has expired — ask the supplier to re-quote.', 'failed-precondition');
    if (d.expectedVersion != null && Number(d.expectedVersion) !== Number(quote.version)) err('The supplier updated this quotation — review the new version first.', 'aborted');

    if (buyer.buyerType === 'individual') {
      const supSnap = await t.get(db().collection('businesses').doc(d.supplierBusinessId));
      const commissionCategory = commissionCategoryFor(rfq.category, ((supSnap.exists ? supSnap.data() : {}).supply || {}).categories);
      if (!commissionCategory) err('This supplier\'s category is not configured for SOKONI checkout yet — message the supplier or contact SOKONI support.', 'failed-precondition');
      /* INDIVIDUAL (owner 2026-10-03): an accepted quote becomes a NORMAL SOKONI order (canonical checkout → IntaSend →
         Shop Riders → 15% materials commission → supplier wallet → receipt). Until checkout accepts a quote reference,
         the acceptance is recorded with an immutable price snapshot and the buyer is told checkout is next — no
         purchase order (that is the business procurement path), no fake payment. */
      const snap = { lines: quote.lines, subtotalKES: quote.subtotalKES, vatRate: quote.vatRate, vatKES: quote.vatKES, deliveryFeeKES: quote.deliveryFeeKES,
        totalKES: quote.totalKES, version: quote.version, supplierBusinessId: d.supplierBusinessId, supplierName: quote.supplierName || 'Supplier' };
      t.update(qRef, { status: 'accepted', acceptedAt: F.serverTimestamp(), checkout: 'pending' });
      t.update(recRef, { status: 'accepted' });
      t.update(rfqRef, { status: 'accepted', acceptedSupplierBusinessId: d.supplierBusinessId, acceptedQuote: snap, checkout: 'pending', commissionCategory, acceptedAt: F.serverTimestamp() });
      return { poId: null, checkout: 'pending', supplierOwnerUid: rec.data().supplierOwnerUid, recipientIds: rfq.recipientIds || [], title: rfq.title, totalKES: quote.totalKES };
    }
    /* the buyer's link to this supplier in the procurement authority (procSuppliers) — reuse, or create once */
    const linkQ = await t.get(db().collection('procSuppliers').where('merchantId', '==', buyerId).where('supplierBusinessId', '==', d.supplierBusinessId).limit(1));
    let supplierId;
    if (!linkQ.empty) supplierId = linkQ.docs[0].id;
    else {
      const lr = db().collection('procSuppliers').doc('sup_' + buyerId.slice(0, 20) + '_' + d.supplierBusinessId.slice(0, 20));
      supplierId = lr.id;
      t.set(lr, { supplierId, merchantId: buyerId, supplierBusinessId: d.supplierBusinessId, name: quote.supplierName || 'Supplier', status: 'active',
        createdVia: 'rfq', createdBy: request.auth.uid, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() }, { merge: true });
    }
    const poId = 'po_rfq_' + d.rfqId.slice(0, 40) + '_' + d.supplierBusinessId.slice(0, 40);
    t.set(db().collection('procPurchaseOrders').doc(poId), {
      poId, poNumber: 'RFQ-' + d.rfqId.slice(0, 8).toUpperCase(), merchantId: buyerId, supplierId, supplierName: quote.supplierName || 'Supplier',
      buyerBusinessId: buyerId, supplierBusinessId: d.supplierBusinessId,
      items: quote.lines.map(function (l, i) { return { productId: 'rfq_line_' + (i + 1), sku: '', name: l.name, qty: l.qty, unitCost: l.unitPriceKES, totalCost: l.lineTotalKES }; }),
      subtotal: quote.subtotalKES, vatAmount: quote.vatKES, vatRate: quote.vatRate, vatBasis: 'declared_on_quote', commissionCategory: 'b2b_order',   /* 2f 92ae79c: fixed 0% lane, floor-exempt */ deliveryFee: quote.deliveryFeeKES, total: quote.totalKES,
      source: { kind: 'rfq', rfqId: d.rfqId, quoteVersion: quote.version },
      status: 'draft', paymentStatus: 'unpaid',   /* held payment through SOKONI = separate purpose (sokoni-5b) */
      notes: 'From RFQ "' + san(rfq.title, 100) + '"', createdBy: request.auth.uid, createdAt: F.serverTimestamp(), updatedAt: F.serverTimestamp() });
    t.update(qRef, { status: 'accepted', acceptedAt: F.serverTimestamp(), poId });
    t.update(recRef, { status: 'accepted', poId });
    t.update(rfqRef, { status: 'converted', acceptedSupplierBusinessId: d.supplierBusinessId, poId, closedAt: F.serverTimestamp() });
    return { poId, supplierOwnerUid: rec.data().supplierOwnerUid, recipientIds: rfq.recipientIds || [], title: rfq.title, totalKES: quote.totalKES };
  });

  /* close the other recipients (outside the txn — informational) */
  for (const sid of out.recipientIds) {
    if (sid === d.supplierBusinessId) continue;
    try { await db().collection('rfqRecipients').doc(rid(d.rfqId, sid)).update({ status: 'closed', closedAt: F.serverTimestamp() }); } catch (e) {}
  }
  if (out.supplierOwnerUid) {
    try {
      await notifySvc().notify({ uid: out.supplierOwnerUid, type: 'rfq_accepted', title: 'Your quotation was accepted',
        body: 'Your quote on "' + String(out.title).slice(0, 60) + '" was accepted (KES ' + Number(out.totalKES).toLocaleString('en-KE') + ').',
        deepLink: '/merchant-v2.html#rfqs', dedupeKey: 'rfq:' + d.rfqId + ':accepted', data: { rfqId: d.rfqId, poId: out.poId } });
    } catch (e) {}
  }
  return out.checkout === 'pending' ? { ok: true, status: 'accepted', poId: null, next: 'checkout' } : { ok: true, status: 'accepted', poId: out.poId };
};

/* cancel {rfqId} — buyer, while still open */
H.cancel = async function (request) {
  const d = request.data || {};
  if (!isId(d.rfqId)) err('rfqId is required.');
  const buyer = await actingBuyer(request, d);
  const ref = db().collection('rfqs').doc(d.rfqId);
  const r = await ref.get();
  if (!r.exists || !ownsRfq(r.data(), buyer, request.auth.uid)) err('RFQ not found.', 'not-found');
  if (r.data().status !== 'submitted') err('Only an open RFQ can be cancelled.', 'failed-precondition');
  await ref.update({ status: 'cancelled', closedAt: F.serverTimestamp() });
  for (const sid of r.data().recipientIds || []) { try { await db().collection('rfqRecipients').doc(rid(d.rfqId, sid)).update({ status: 'closed' }); } catch (e) {} }
  return { ok: true, status: 'cancelled' };
};

exports.rfqDispatch = onCall(OPT, async function (request) {
  if (!request.auth || !request.auth.uid) err('Sign in required.', 'unauthenticated');
  const op = String((request.data || {}).op || '');
  if (!Object.prototype.hasOwnProperty.call(H, op)) err('Unknown op "' + op + '".');
  return H[op](request);
});
exports._h = H;
exports._ym = ym;   /* certification: the EAT lead month */
