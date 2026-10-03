'use strict';
/**
 * SOKONI Admin OS — WhatsApp delivery trace (read-only)
 * =====================================================
 * Lets AdminOS see what actually happened to each WhatsApp message SOKONI sent:
 *   business event → notifyLog/{ref} → whatsappSends/{wamid} → Meta status webhook
 *
 * Registered into the ONE adminOsDispatch registry (admin-os-dispatch.js), exactly like
 * admin-commission-trace.js — not a second admin surface.
 *
 * READ-ONLY. Writes nothing, triggers nothing. Admin/superAdmin claim required (same guard and
 * error shape as admin-os.js).
 *
 * WHAT IS RETURNED IS A WHITELIST. whatsappSends never holds template parameters (whatsapp-sender.js:
 * metadata only), and this reader would not return them if it did: only the named fields below
 * leave the server. An OTP / completion PIN therefore cannot reach a dashboard through here.
 *
 * Status vocabulary is Meta's, unaltered: accepted (Meta took the request) → sent → delivered → read,
 * or failed. "accepted" is NOT delivery and is never shown as such.
 */
const { getFirestore } = require('firebase-admin/firestore');

const SENDS = 'whatsappSends';
const STATUSES = Object.freeze(['accepted', 'sent', 'delivered', 'read', 'failed']);
const FIELDS = Object.freeze(['channel', 'template', 'category', 'secret', 'toMasked', 'status', 'ref',
  'acceptedAt', 'sentAt', 'deliveredAt', 'readAt', 'failedAt', 'errorCode']);

function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) throw new Error('admin required');
}
const _cap = (n) => Math.min(Math.max(1, Number(n) || 50), 200);
const _str = (v, n) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, n) : null);

function _row(id, d) {
  const out = { messageId: id, channel: 'WHATSAPP' };
  for (const k of FIELDS) if (d[k] !== undefined) out[k] = typeof d[k] === 'string' ? d[k].slice(0, 200) : d[k];
  out.channel = 'WHATSAPP';
  return out;
}

exports._h = {};

/**
 * adminListWhatsappSends({ messageId?, ref?, status?, limit? })
 *   messageId → that one message (or found:false)
 *   ref       → the message(s) a given notifyLog key produced
 *   status    → filter by Meta status
 *   newest first by acceptedAt; limit 1..200 (default 50)
 */
exports._h.adminListWhatsappSends = async (req, deps) => {
  _requireAdmin(req);
  const db = (deps && deps.db) || getFirestore();
  const d = req.data || {};
  const messageId = _str(d.messageId, 200);
  if (messageId) {
    const s = await db.collection(SENDS).doc(messageId).get();
    return s.exists ? { found: true, sends: [_row(s.id, s.data() || {})] } : { found: false, sends: [] };
  }
  const status = _str(d.status, 20);
  if (status && !STATUSES.includes(status)) throw new Error('status must be one of ' + STATUSES.join(', '));
  const ref = _str(d.ref, 200);
  let q = db.collection(SENDS);
  if (ref) q = q.where('ref', '==', ref);
  else if (status) q = q.where('status', '==', status);
  else q = q.orderBy('acceptedAt', 'desc');
  const snap = await q.limit(_cap(d.limit)).get();
  let rows = snap.docs.map((x) => _row(x.id, x.data() || {}));
  if (ref && status) rows = rows.filter((r) => r.status === status);
  rows.sort((a, b) => String(b.acceptedAt || '').localeCompare(String(a.acceptedAt || '')));
  return { count: rows.length, sends: rows, filters: { ref, status } };
};

module.exports.STATUSES = STATUSES;
module.exports.FIELDS = FIELDS;
