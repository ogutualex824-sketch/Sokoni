'use strict';
/**
 * SOKONI POS Customer Scope — who a `posCustomers` record belongs to.
 *
 * ── The defect this closes ──────────────────────────────────────────────────
 * `posLookupCustomer` and `getPOSCustomer` searched `posCustomers` by phone,
 * email, document id or member-card code with NO merchant filter of any kind,
 * and returned the customer's name, email, phone, loyalty points, tier, total
 * spent and purchase count. Any authenticated account could look up any customer
 * on the platform by phone number. A phone number is guessable, so this was
 * enumerable cross-tenant PII disclosure.
 *
 * `upsertPOSCustomer` had the write-side twin: it looked up an existing customer
 * by phone collection-wide, so a second merchant upserting the same phone number
 * UPDATED the first merchant's customer document — one record shared between two
 * businesses, with the later name and email overwriting the earlier.
 *
 * ── Why this is a data-model fix, not a query fix ───────────────────────────
 * The writers recorded no owner at all. Traced end to end:
 *
 *   pos-customers.js (client)   writes {id, name, phone, …} — no sellerId,
 *                               no merchantId. `firestore.rules` requires
 *                               `request.resource.data.sellerId == auth.uid` on
 *                               create, so those writes were silently REJECTED
 *                               (the caller does `.catch(() => {})`).
 *   upsertPOSCustomer (server)  Admin SDK, bypasses rules — writes {phone, name,
 *                               email, loyaltyPoints, …}, again with no owner.
 *   pos-crm-pro.js              encodes the owner in the DOCUMENT ID
 *                               (`{sellerId}_{phone}`) but merges bodies that
 *                               carry no owner field.
 *
 * Meanwhile `pos-bi.js` queries `where('sellerId','==',sid)` and
 * `posGetCustomerInsights` queries `where('merchantId','==',merchantId)` — two
 * filters over a collection whose documents carry neither. They match nothing.
 *
 * So there was no field to filter on. Adding one to the QUERY alone would have
 * returned nothing for every real customer and broken the till; picking the
 * composite document id would have covered only the subset pos-crm-pro created.
 * The owner has to be WRITTEN before it can be filtered, which is what this
 * module makes every path do.
 *
 * ── The owner, and where it comes from ──────────────────────────────────────
 * `sellerId` — the authenticated uid, resolved from `auth` and NEVER from the
 * request. That is the identifier `pos-crm-pro`'s composite document id already
 * encodes, and it is the only one available without trusting the caller.
 *
 * It is deliberately NOT read from `req.data.sellerId`. `_resolveSellerId` in
 * pos-crm-pro.js does exactly that when no `sellerId` claim is present — and no
 * `sellerId` claim is minted anywhere in the codebase — so any caller can name
 * any seller there. That is a separate open finding; this module does not
 * inherit it.
 *
 * ── Legacy records ──────────────────────────────────────────────────────────
 * A document with no owner belongs to nobody and is returned to nobody. It is
 * NOT migrated here and NOT guessed at: handing an unattributable customer
 * record to a caller is precisely the disclosure being closed. The next upsert
 * for that phone creates a correctly-owned record, so the path self-heals
 * forward without a backfill script — at the cost of the old record's history,
 * which is a data decision to be made separately rather than assumed here.
 */

const { HttpsError } = require('firebase-functions/v2/https');

const COLLECTION = 'posCustomers';
const OWNER_FIELD = 'sellerId';

/**
 * The caller's merchant identity, from AUTH ONLY.
 *
 * An admin may act for another seller, but must say so explicitly — and that is
 * the one case where a request-supplied seller is honoured, because the claim
 * has already established the caller may.
 */
function resolveOwner(auth, requestedSellerId) {
  if (!auth || !auth.uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const claims = auth.token || {};
  const isAdmin = claims.admin === true || claims.superAdmin === true ||
                  claims.role === 'admin' || claims.role === 'super_admin';
  if (isAdmin && requestedSellerId) return String(requestedSellerId);
  return auth.uid;
}

/**
 * Does this document belong to `ownerUid`?
 *
 * Two accepted shapes, both PROVEN in the existing data rather than assumed:
 *   · the body field `sellerId` — what every path writes from now on
 *   · the composite document id `{sellerId}_{phone}` — what pos-crm-pro created
 *
 * Anything else — including a document with no owner at all — belongs to nobody.
 */
function ownsCustomer(docId, data, ownerUid) {
  if (!ownerUid) return false;
  const d = data || {};
  if (d[OWNER_FIELD] && String(d[OWNER_FIELD]) === String(ownerUid)) return true;
  /* Composite id, matched from the LEFT so a uid containing an underscore
     cannot be spoofed by a crafted phone segment. */
  if (docId && String(docId).indexOf(String(ownerUid) + '_') === 0) return true;
  return false;
}

/**
 * The stamp every create must carry. Written from the resolved owner, so a
 * record can never be created without one again.
 */
function ownerStamp(ownerUid) {
  if (!ownerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const patch = {};
  patch[OWNER_FIELD] = String(ownerUid);
  return patch;
}

/**
 * Find one customer of THIS owner by a field, without ever reading another
 * merchant's row into memory. The owner filter is part of the query, not a
 * post-filter — a post-filter still fetches the document it then discards.
 */
async function findOwned(db, ownerUid, field, value, limit) {
  if (!ownerUid) throw new HttpsError('unauthenticated', 'Sign in required.');
  if (!value) return null;
  const snap = await db.collection(COLLECTION)
    .where(OWNER_FIELD, '==', String(ownerUid))
    .where(field, '==', value)
    .limit(limit || 1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

/**
 * Fetch one customer by document id, but only if it belongs to the caller.
 * Returns null otherwise — never throws a distinguishable "exists but not
 * yours", because that is itself an existence disclosure.
 */
async function getOwned(db, ownerUid, customerId) {
  if (!ownerUid || !customerId) return null;
  const snap = await db.collection(COLLECTION).doc(String(customerId)).get();
  if (!snap.exists) return null;
  return ownsCustomer(snap.id, snap.data(), ownerUid) ? snap : null;
}

/* ══ SMART CUSTOMER SEARCH (2026-09-30) ══════════════════════════════════════════════════════════════════════════
 * ONE customer authority for the till, Sell, pos-checkout and receipts: posCustomers, owned by the SHOP (sellerId), the
 * same scope the sale itself enforces. Type → recognise → suggest → select → save if new → attach to the sale.
 *   · every Kenyan phone form (0722…, 722…, +254…, 254…, spaces) is one canonical key: 2547XXXXXXXX
 *   · searchKeys holds the prefixes a cashier types (the national number from 3 digits on, name words from 2 letters,
 *     the customer code), so a suggestion is ONE indexed query: sellerId == shop AND searchKeys array-contains term
 *   · never a silent pick: only ONE exact full-number match is "suggested"; anything else is a list of choices
 *   · the shop sees its OWN customers; phones leave the server masked
 */
function phoneKey(raw) {
  /* the ONE normaliser (wallet-engine, via loyalty-points); a bare national number (722376801) gains its leading 0 */
  const c = String(raw || '').replace(/[\s\-().+]/g, '');
  return require('./loyalty-points').normalize(/^[17]\d{8}$/.test(c) ? '0' + c : c) || null;
}
function customerDocId(shopId, key) {
  return String(shopId) + '_c' + require('crypto').createHash('sha256').update('posCustomer|' + shopId + '|' + key).digest('hex').slice(0, 24);
}
function nationalOf(key) { return key ? key.slice(3) : ''; }                   /* 722376801 */
function maskKePhone(key) { const n = nationalOf(key); return n ? '0' + n.slice(0, 3) + ' ••• •' + n.slice(-3) : '••••'; }
function searchKeysFor({ phone, name, code }) {
  const keys = new Set();
  const n = nationalOf(phoneKey(phone));
  for (let i = 3; i <= n.length; i++) keys.add('p:' + n.slice(0, i));
  String(name || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).slice(0, 4).forEach((w) => {
    for (let i = 2; i <= Math.min(w.length, 12); i++) keys.add('n:' + w.slice(0, i));
  });
  if (code) keys.add('c:' + String(code).toUpperCase());
  return [...keys].slice(0, 60);
}
/** What the cashier typed, as ONE search term (or null). */
function termFor(q) {
  const s = String(q || '').trim();
  if (!s) return null;
  if (/^[A-Z]{2,4}-\d{3,}$/i.test(s)) return { term: 'c:' + s.toUpperCase(), by: 'code' };
  const digits = s.replace(/[\s\-().+]/g, '');
  if (/^\d+$/.test(digits)) {
    let n = digits;
    if (n.startsWith('254')) n = n.slice(3); else if (n.startsWith('0')) n = n.slice(1);
    if (n.length < 3) return null;
    return { term: 'p:' + n.slice(0, 9), by: 'phone', full: n.length >= 9 };
  }
  const w = s.toLowerCase().split(/\s+/)[0].replace(/[^a-z0-9]/g, '').slice(0, 12);
  return w.length >= 2 ? { term: 'n:' + w, by: 'name' } : null;
}
function cardOf(doc) {
  const d = doc.data() || {};
  const key = d.phoneKey || phoneKey(d.phone);
  const ms = d.lastPurchaseAt && typeof d.lastPurchaseAt.toMillis === 'function' ? d.lastPurchaseAt.toMillis() : (typeof d.lastPurchaseAt === 'number' ? d.lastPurchaseAt : null);
  return { id: doc.id, name: String(d.name || 'Customer').slice(0, 80), maskedPhone: maskKePhone(key), code: d.memberCardCode || null,
    purchaseCount: Number(d.purchaseCount) || 0, totalSpent: Math.round((Number(d.totalSpent) || 0) * 100) / 100, lastPurchaseAt: ms };
}
/** Suggestions for THIS shop. Exact full-number match → suggested (the only case that is). */
async function searchOwned(db, shopId, q) {
  const t = termFor(q);
  if (!t) return { term: null, results: [], suggested: null };
  const snap = await db.collection(COLLECTION).where(OWNER_FIELD, '==', String(shopId)).where('searchKeys', 'array-contains', t.term).limit(8).get();
  let docs = snap.docs.filter((d) => ownsCustomer(d.id, d.data(), shopId));
  /* a customer saved before search keys existed: still found by the full number (every stored form), then indexed */
  if (!docs.length && t.by === 'phone' && t.full) {
    const key = '254' + t.term.slice(2);
    for (const form of [key, '+' + key, '0' + key.slice(3)]) {
      const hit = await findOwned(db, String(shopId), 'phone', form);
      if (hit) { docs = [hit]; await hit.ref.set({ phoneKey: key, searchKeys: searchKeysFor({ phone: key, name: hit.data().name, code: hit.data().memberCardCode }) }, { merge: true }); break; }
    }
  }
  const results = docs.map((d) => Object.assign(cardOf(d), { matchedBy: t.by }));
  const exact = t.by === 'phone' && t.full ? results.filter((r) => docs.find((d) => d.id === r.id && (d.data().phoneKey || phoneKey(d.data().phone)) === '254' + t.term.slice(2))) : [];
  return { term: t.by, results, suggested: exact.length === 1 ? exact[0].id : null };
}
/** Save (or find) this shop's customer by phone — one per (shop, number); an existing one is never overwritten. */
async function saveOwned(db, shopId, { phone, name, by }) {
  const key = phoneKey(phone);
  if (!key) throw new HttpsError('invalid-argument', 'Enter a valid Kenyan phone number.');
  const clean = String(name || '').replace(/[<>]/g, '').trim().slice(0, 80);
  if (clean.length < 2) throw new HttpsError('invalid-argument', 'Enter the customer\u2019s name.');
  /* an existing record in ANY stored form is the customer — found, indexed, never duplicated or renamed */
  for (const form of [key, '+' + key, '0' + key.slice(3)]) {
    const hit = await findOwned(db, String(shopId), 'phone', form);
    if (hit) {
      await hit.ref.set({ phoneKey: key, searchKeys: searchKeysFor({ phone: key, name: hit.data().name, code: hit.data().memberCardCode }) }, { merge: true });
      return Object.assign(cardOf(await hit.ref.get()), { created: false });
    }
  }
  /* deterministic (one per shop+number, so concurrent saves collide on ONE doc) but OPAQUE: the id reaches the till,
     and an id spelled from the number would un-mask it */
  const ref = db.collection(COLLECTION).doc(customerDocId(shopId, key));
  let created = false;
  await db.runTransaction(async (t) => {
    created = false;                       /* a retried attempt must not keep an earlier attempt's answer */
    const s = await t.get(ref);
    if (s.exists) return;
    created = true;
    t.set(ref, { [OWNER_FIELD]: String(shopId), name: clean, phone: key, phoneKey: key, searchKeys: searchKeysFor({ phone: key, name: clean }),
      purchaseCount: 0, totalSpent: 0, loyaltyPoints: 0, createdVia: 'till', createdBy: String(by || ''), createdAt: new Date() });
  });
  return Object.assign(cardOf(await ref.get()), { created });
}

module.exports = {
  COLLECTION,
  OWNER_FIELD,
  resolveOwner,
  ownsCustomer,
  ownerStamp,
  findOwned,
  getOwned,
  phoneKey, customerDocId, maskKePhone, searchKeysFor, termFor, cardOf, searchOwned, saveOwned,
};
