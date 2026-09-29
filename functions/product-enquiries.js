'use strict';
/**
 * SOKONI — Product enquiries & public Q&A  (2026-09-29, product conversations T2a)
 * ============================================================================================
 * "Chat seller" / "Ask a question" on a product page now open a REAL SOKONI conversation with the product's seller,
 * which the seller answers in merchant-v2 › Messages (the existing inbox — userConversations/{uid}). There is no
 * second chat inbox.
 *
 * Before: the premium path navigated to messages.html?with=<seller>, which nothing reads (the buyer landed on an
 * empty inbox); the fallback wrote `contactRequests` without buyerUid (rules deny every write) and nothing read it;
 * Q&A, offers and "live comments" lived in the buyer's own localStorage and reached nobody.
 *
 * PATTERN: ent-enquiries.js — a SERVER-ANCHORED conversation (messages.SERVER_ANCHORED): the client can neither create
 * it nor choose its parties; the server derives the seller from products/{id}. One conversation per (product, buyer):
 *   conversations/product_enquiry_{productId}__{buyerUid}   + productEnquiries/{productId}__{buyerUid} (the record)
 * The buyer's text is posted as the buyer's own message through messages.sendMessage (its caps, moderation and
 * unread counts apply). A question marked PUBLIC also becomes a productQA entry — shown on the product page WITHOUT
 * the asker's identity — which the seller answers from the thread (productQuestionAnswer).
 *
 * LIMITS: 30 enquiries / buyer / day, 8 s between sends to the same product, the same text within 5 min refused.
 * Private seller data is never exposed: the conversation carries names only (as every SOKONI conversation does).
 *
 * Ops (routed by messages-dispatch.js):  productEnquirySend · productQuestionAnswer
 */
const { HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

const _db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };
const _san = (s, n) => String(s == null ? '' : s).replace(/<[^>]*>/g, '').replace(/\s+\n/g, '\n').trim().slice(0, n);
const LIMITS = { perBuyerPerDay: 30, pairCooldownMs: 8000, dedupWindowMs: 5 * 60 * 1000 };
const HIDDEN_STATES = ['archived', 'deleted', 'draft', 'suspended', 'hidden'];

function _hash(s) { let h = 0; for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0; return (h >>> 0).toString(36); }

const _h = {};

/** Buyer → the product's seller. { productId, text, publicQuestion? } → { conversationId, qaId } */
_h.productEnquirySend = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in to message the seller.');
  if (req.auth.token && req.auth.token.deactivated === true) fail('permission-denied', 'Your account is deactivated.');
  const d = req.data || {};
  const productId = _san(d.productId, 128);
  if (!productId || /[/]/.test(productId)) fail('invalid-argument', 'productId is required.');
  const text = _san(d.text, 1500);
  if (text.length < 3) fail('invalid-argument', 'Write your question first.');
  const db = _db();
  const pSnap = await db.collection('products').doc(productId).get();
  if (!pSnap.exists) fail('not-found', 'That product is no longer available.');
  const p = pSnap.data() || {};
  const sellerUid = p.sellerUid || p.sellerId || null;
  if (!sellerUid) fail('failed-precondition', 'This product has no seller to message.');
  if (p.isVisible === false || HIDDEN_STATES.includes(String(p.status || '').toLowerCase())) fail('failed-precondition', 'That product is not available.');
  if (sellerUid === uid) fail('failed-precondition', 'This is your own product.');

  const now = Date.now(); const day = new Date(now + 3 * 3600000).toISOString().slice(0, 10);
  const pair = `${productId}__${uid}`;
  const limRef = db.collection('productEnquiryLimits').doc('b_' + uid);
  const recRef = db.collection('productEnquiries').doc(pair);
  const hash = _hash(text.toLowerCase().replace(/\s+/g, ' '));
  await db.runTransaction(async (t) => {
    const [l, r] = [await t.get(limRef), await t.get(recRef)];
    const ld = l.exists ? l.data() : {}; const rd = r.exists ? r.data() : {};
    const count = ld.day === day ? Number(ld.count) || 0 : 0;
    if (count >= LIMITS.perBuyerPerDay) fail('resource-exhausted', 'You have sent the maximum number of product messages for today.', { code: 'RATE_LIMITED' });
    if (now - (Number(rd.lastAt) || 0) < LIMITS.pairCooldownMs) fail('resource-exhausted', 'Please wait a moment before sending another message.', { code: 'COOLDOWN' });
    if (rd.lastHash === hash && now - (Number(rd.lastAt) || 0) < LIMITS.dedupWindowMs) fail('already-exists', 'You already sent this — the seller will reply in the conversation.', { code: 'DUPLICATE' });
    t.set(limRef, { day, count: count + 1, updatedAt: now });
    t.set(recRef, Object.assign({ productId, productName: _san(p.name || p.title, 120), shopId: p.shopId || sellerUid, sellerUid, buyerUid: uid,
      conversationId: `product_enquiry_${pair}`, lastAt: now, lastHash: hash, count: (Number(rd.count) || 0) + 1, updatedAt: _ts() },
      r.exists ? {} : { createdAt: _ts() }), { merge: true });
  });

  const MSG = require('./messages');
  const title = `Question · ${_san(p.name || p.title || 'your product', 80)}`;
  const { conversationId } = await MSG.ensureAnchoredConversation(db, { transactionType: 'product_enquiry', transactionId: pair, title,
    participants: [uid, sellerUid],
    metadata: { productId, productName: _san(p.name || p.title, 120), shopId: p.shopId || sellerUid, price: typeof p.price === 'number' ? p.price : null } });
  /* the buyer's own words, as the buyer's message (sendMessage's caps / moderation / unread counts apply) */
  await MSG._h.sendMessage({ auth: req.auth, data: { conversationId, type: 'text', text } });

  let qaId = null;
  if (d.publicQuestion === true) {
    const qaRef = db.collection('productQA').doc();
    qaId = qaRef.id;
    /* PUBLIC row — no asker identity. The conversation id embeds the asker's uid, so it lives in a SERVER-ONLY record
       (productQAPrivate — no client rule), never on the public row. */
    await qaRef.set({ productId, sellerUid, question: text, answer: null, status: 'open', createdAt: _ts(), answeredAt: null });
    await db.collection('productQAPrivate').doc(qaId).set({ conversationId, askerUid: uid, productId, createdAt: _ts() });
    await MSG.postSystemMessage(db, conversationId, 'qa_' + qaId, 'The buyer also asked this publicly. Publish an answer from this conversation so other buyers see it.',
      { qaId, kind: 'public_question' });
  }
  return { ok: true, conversationId, qaId };
};

/** Seller → publish the public answer to a productQA question. { qaId, answer } */
_h.productQuestionAnswer = async (req) => {
  const uid = req.auth && req.auth.uid;
  if (!uid) fail('unauthenticated', 'Sign in required.');
  const d = req.data || {};
  const qaId = _san(d.qaId, 128);
  const answer = _san(d.answer, 1000);
  if (!qaId || /[/]/.test(qaId)) fail('invalid-argument', 'qaId is required.');
  if (answer.length < 2) fail('invalid-argument', 'Write the answer first.');
  const db = _db();
  const ref = db.collection('productQA').doc(qaId);
  const s = await ref.get();
  if (!s.exists) fail('not-found', 'That question no longer exists.');
  const q = s.data() || {};
  /* the product's seller answers (staff answering on the shop's behalf is T2b, through merchant-identity) */
  if (q.sellerUid !== uid) fail('permission-denied', 'Only the seller of this product can answer publicly.', { code: 'NOT_SELLER' });
  await ref.set({ answer, status: 'answered', answeredAt: _ts() }, { merge: true });
  const priv = await db.collection('productQAPrivate').doc(qaId).get();
  const convId = priv.exists ? (priv.data() || {}).conversationId : null;
  if (convId) {
    await require('./messages').postSystemMessage(db, convId, 'qa_answered_' + qaId, 'The seller published a public answer on the product page.', { qaId, kind: 'public_answer' });
  }
  return { ok: true, qaId };
};

module.exports = { _h, LIMITS };
