'use strict';
/**
 * SOKONI — WhatsApp Cloud API sender (owner 2026-10-01)
 * ====================================================
 * ONE outbound WhatsApp channel. Called from the server only (notify.js channel, the completion-PIN engine).
 * It sends ONE approved template (functions/shared/whatsapp-templates.js) to ONE server-resolved recipient.
 *
 * TRUE STATE — the return value is what Meta answered, never an optimistic "sent":
 *   { ok: true,  messageId: 'wamid…', error: null }            Meta accepted the message
 *   { ok: false, messageId: null,     error: '<CODE>' }         refused here, or by Meta
 * Delivery (sent / delivered / read / failed) arrives later on the status webhook (whatsapp-webhook.js),
 * which advances the same whatsappSends/{messageId} record.
 *
 * NOTHING SECRET IS STORED. Template parameters are passed to Meta and nowhere else: not to Firestore, not
 * to logs, not to a queue. The send record holds the template name, the category, a MASKED number, the
 * caller-supplied uid (if any), the Meta message id, the status and timestamps. This holds for every
 * template, and is REQUIRED for secret ones (OTP / completion PIN).
 *
 * NOT CONFIGURED until the owner provisions the production WABA and stores the secrets
 * (WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID) in Secret Manager; until then every send returns
 * { ok:false, error:'NOT_CONFIGURED' } and the caller falls back (the PIN engine falls back to SMS).
 */
const T = require('./shared/whatsapp-templates');

const SECRET_NAMES = Object.freeze({ accessToken: 'WHATSAPP_ACCESS_TOKEN', phoneNumberId: 'WHATSAPP_PHONE_NUMBER_ID' });
const API_VERSION = 'v21.0';
const SENDS = 'whatsappSends';

/** Kenyan mobile → '2547XXXXXXXX' / '2541XXXXXXXX', or null. Never "fixed" into a different number. */
function normalisePhone (raw) {
  let d = String(raw == null ? '' : raw).replace(/[^\d]/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
  else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
  return /^254[17]\d{8}$/.test(d) ? d : null;
}
function maskPhone (e164) { return e164 ? e164.slice(0, 5) + '*****' + e164.slice(-2) : null; }

/* Meta refuses parameters with newlines, tabs or more than 4 consecutive spaces, and caps their length.
   Refuse rather than silently rewrite what the customer will read. */
function _paramOk (v) {
  if (typeof v !== 'string' && typeof v !== 'number') return false;
  const s = String(v);
  return s.length > 0 && s.length <= 300 && !/[\n\r\t]/.test(s) && !/ {5,}/.test(s);
}

function buildPayload (to, name, def, params) {
  const values = def.params.map((k) => String(params[k]));
  const components = [{ type: 'body', parameters: values.map((text) => ({ type: 'text', text })) }];
  if (def.button === 'copy_code') {
    /* Authentication templates repeat the code as the URL button's parameter (Meta's copy-code button). */
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: values[0] }] });
  }
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to,
    type: 'template', template: { name, language: { code: def.lang }, components } };
}

/**
 * sendTemplate({ to, template, params, uid }, deps) → { ok, messageId, error }
 * deps: { fetch, accessToken, phoneNumberId, store?, now? }   (injectable: the suite exercises THIS function)
 */
async function sendTemplate (msg, deps) {
  const m = msg || {}, d = deps || {};
  if (!d.accessToken || !d.phoneNumberId) return { ok: false, messageId: null, error: 'NOT_CONFIGURED' };
  const def = T.get(m.template);
  if (!def) return { ok: false, messageId: null, error: 'UNKNOWN_TEMPLATE' };
  const p = m.params || {};
  const keys = Object.keys(p).sort().join(','), want = def.params.slice().sort().join(',');
  if (keys !== want) return { ok: false, messageId: null, error: 'PARAMS_MISMATCH' };
  if (!def.params.every((k) => _paramOk(p[k]))) return { ok: false, messageId: null, error: 'BAD_PARAM' };
  const to = normalisePhone(m.to);
  if (!to) return { ok: false, messageId: null, error: 'BAD_RECIPIENT' };

  const fetchFn = d.fetch || globalThis.fetch;
  let res, body;
  try {
    res = await fetchFn('https://graph.facebook.com/' + API_VERSION + '/' + encodeURIComponent(d.phoneNumberId) + '/messages', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + d.accessToken, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload(to, m.template, def, p)),
    });
    body = await res.json().catch(() => ({}));
  } catch (_) {
    return { ok: false, messageId: null, error: 'NETWORK' };
  }
  const wamid = body && body.messages && body.messages[0] && body.messages[0].id;
  if (!res.ok || !wamid) {
    const code = body && body.error && (body.error.code || body.error.type);
    return { ok: false, messageId: null, error: 'META_' + String(code || res.status || 'UNKNOWN') };
  }
  /* Record the ACCEPTED send — metadata only, never the parameters. */
  if (d.store) {
    try {
      await d.store.createSend(wamid, {
        template: m.template, category: def.category, secret: !!def.secret,
        toMasked: maskPhone(to), uid: m.uid ? String(m.uid).slice(0, 128) : null,
        status: 'accepted', acceptedAt: (d.now ? d.now() : new Date()).toISOString(),
      });
    } catch (_) { /* the message WAS accepted by Meta — a bookkeeping failure must not report it as failed */ }
  }
  return { ok: true, messageId: wamid, error: null };
}

/* Status order for the webhook: never move backwards (Meta retries and reorders callbacks). 'failed' can
   follow 'accepted' or 'sent' but never overrides a delivered/read message. */
const RANK = { accepted: 0, sent: 1, delivered: 2, read: 3 };
function nextStatus (current, incoming) {
  if (incoming === 'failed') return (current === 'delivered' || current === 'read') ? current : 'failed';
  if (current === 'failed') return 'failed';
  if (!(incoming in RANK)) return current;
  return RANK[incoming] > (RANK[current] == null ? -1 : RANK[current]) ? incoming : current;
}

/** Firestore store: whatsappSends/{wamid}. Admin SDK only (rules: no client match → deny). */
function firestoreSends () {
  const admin = require('firebase-admin');
  const col = () => admin.firestore().collection(SENDS);
  return {
    async createSend (id, rec) { await col().doc(id).create(rec); },
    async advance (id, incoming, extra) {
      const ref = col().doc(id);
      return admin.firestore().runTransaction(async (tx) => {
        const s = await tx.get(ref);
        if (!s.exists) return { updated: false, reason: 'unknown_message' };   /* not one of ours */
        const cur = s.data().status;
        const nxt = nextStatus(cur, incoming);
        if (nxt === cur) return { updated: false, reason: 'not_newer' };
        tx.update(ref, Object.assign({ status: nxt, [nxt + 'At']: new Date().toISOString() }, extra || {}));
        return { updated: true, status: nxt };
      });
    },
  };
}

/** In-memory store for the suite (same semantics). */
function memorySends () {
  const docs = {};
  return {
    async createSend (id, rec) { if (docs[id]) throw Object.assign(new Error('exists'), { code: 6 }); docs[id] = rec; },
    async advance (id, incoming, extra) {
      const cur = docs[id]; if (!cur) return { updated: false, reason: 'unknown_message' };
      const nxt = nextStatus(cur.status, incoming);
      if (nxt === cur.status) return { updated: false, reason: 'not_newer' };
      Object.assign(cur, { status: nxt, [nxt + 'At']: 'ts' }, extra || {});
      return { updated: true, status: nxt };
    },
    _docs: docs,
  };
}

/** Secrets as exposed to a function that declared them (defineSecret → process.env at runtime). */
function configFromEnv (env) {
  const e = env || process.env;
  return { accessToken: e[SECRET_NAMES.accessToken] || '', phoneNumberId: e[SECRET_NAMES.phoneNumberId] || '' };
}

/**
 * The completion-PIN engine's interface (sokoni-70, shared/completion-pin.js deliverPin):
 *   sender(phoneOrUid, templateName, params) → { ok, messageId|null, error|null }
 * A uid is resolved SERVER-SIDE to the account's phone (users/{uid}); a phone is used as given (the engine
 * already resolved it from the order). Secret params are never stored or logged.
 */
function makeSender (deps) {
  const d = deps || {};
  return async function sender (phoneOrUid, templateName, params) {
    let phone = phoneOrUid, uid = null;
    if (!normalisePhone(phoneOrUid) && typeof d.resolvePhone === 'function') {
      uid = phoneOrUid;
      try { phone = await d.resolvePhone(uid); } catch (_) { phone = null; }
      if (!phone) return { ok: false, messageId: null, error: 'NO_PHONE' };
    }
    return sendTemplate({ to: phone, template: templateName, params, uid }, d);
  };
}

module.exports = { SECRET_NAMES, API_VERSION, SENDS, normalisePhone, maskPhone, buildPayload, sendTemplate,
  nextStatus, firestoreSends, memorySends, configFromEnv, makeSender };
