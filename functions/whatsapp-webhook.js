/* ============================================================================
   SOKONI WhatsApp Cloud API — inbound receiver    functions/whatsapp-webhook.js
   ============================================================================
   The FIRST slice of the WhatsApp rail, and deliberately INBOUND ONLY. Nothing
   here sends. Outbound goes through the existing notify.js sender when its own
   slice lands — one sender, not a second.

   WHY THE RECEIVER IS BUILT FIRST
   --------------------------------
   `webhookSmartpos` shipped public and unsigned, and anything that reached it
   could inject. That defect is on this platform's record, and the order here
   exists so it cannot repeat: the door is built and proven before anything is
   bolted to it. A send path added first would have had nothing to verify what
   came back.

   WHAT META ACTUALLY SENDS
   -------------------------
   Two different requests arrive at one URL, and conflating them is the usual
   mistake:

     GET   the one-time verification handshake. Meta sends hub.mode,
           hub.verify_token and hub.challenge, and expects the CHALLENGE echoed
           back as the raw body. It is NOT signed — there is no payload to sign
           — so the verify token is the only credential, and it is compared in
           constant time.

     POST  every subsequent event: inbound messages, and status callbacks for
           messages we sent (sent / delivered / read / failed). Signed with
           HMAC-SHA256 over the RAW body using the Meta app secret, in the
           X-Hub-Signature-256 header as `sha256=<hex>`.

   IT FAILS CLOSED, IN EVERY DIRECTION
   ------------------------------------
   No signature header, a malformed one, a mismatch, or a MISSING APP SECRET all
   refuse. The last matters most: a receiver that accepts everything when its
   secret is absent is worse than one that is switched off, because it looks
   like it is working. An unconfigured rail must be inert, never permissive.

   THE RAW BODY IS THE ONLY THING THAT CAN BE VERIFIED
   -----------------------------------------------------
   The signature covers the bytes Meta sent. `JSON.stringify(req.body)` is a
   re-serialisation — key order, whitespace and unicode escaping may all differ
   — so verifying against it would fail on valid requests and, worse, could be
   "fixed" by relaxing the check. Firebase exposes `req.rawBody`; if it is
   absent the request is REFUSED rather than verified against a reconstruction.

   WHAT IT DOES WITH AN EVENT
   ---------------------------
   Records it under `whatsappInbound/{id}` and stops. No auto-reply, no order
   creation, no payment. Those belong to slices that have not been authorised,
   and a receiver that quietly did them would be a second communications engine.

   Written by the Admin SDK and never read by a client, so it needs no
   firestore.rules entry: an unlisted path is default-deny for every client.
   ============================================================================ */
'use strict';

const crypto = require('crypto');

/* Cloud API events carry no SOKONI credential, so these are the only secrets:
   one to answer the handshake, one to verify every payload after it. */
const SECRET_NAMES = {
  verifyToken: 'WHATSAPP_VERIFY_TOKEN',
  appSecret:   'WHATSAPP_APP_SECRET',
};

const COLLECTION = 'whatsappInbound';

/* ── VERIFICATION HANDSHAKE (GET) ──────────────────────────────────────────
   Returns { ok, challenge, reason }. Never throws: a handshake failure is a
   reportable condition, and a thrown error would surface as a 500 that tells
   Meta to retry something that will never succeed. */
function verifyChallenge (query, expectedToken) {
  const q = query || {};
  const mode = q['hub.mode'];
  const token = q['hub.verify_token'];
  const challenge = q['hub.challenge'];

  /* FAIL CLOSED on an absent secret. Without this, an unconfigured deployment
     would verify ANY subscription request, handing control of the endpoint to
     whoever asked first. */
  if (!expectedToken) return { ok: false, reason: 'verify_token_not_configured' };
  if (mode !== 'subscribe') return { ok: false, reason: 'bad_mode' };
  if (typeof token !== 'string' || !token) return { ok: false, reason: 'missing_token' };
  if (typeof challenge !== 'string' || !challenge) return { ok: false, reason: 'missing_challenge' };

  /* Constant time. A byte-by-byte compare on a shared secret leaks its prefix
     to anyone who can time the response. Lengths are compared first because
     timingSafeEqual throws on a length mismatch — and the length of a token is
     not the secret. */
  const a = Buffer.from(String(token), 'utf8');
  const b = Buffer.from(String(expectedToken), 'utf8');
  if (a.length !== b.length) return { ok: false, reason: 'token_mismatch' };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'token_mismatch' };

  return { ok: true, challenge };
}

/* ── PAYLOAD SIGNATURE (POST) ──────────────────────────────────────────────
   `sha256=<hex>` over the RAW body with the Meta app secret. */
function verifySignature (rawBody, header, appSecret) {
  if (!appSecret) return { ok: false, reason: 'app_secret_not_configured' };
  if (!rawBody || !rawBody.length) return { ok: false, reason: 'no_raw_body' };
  if (typeof header !== 'string' || !header) return { ok: false, reason: 'no_signature_header' };

  const m = /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  if (!m) return { ok: false, reason: 'malformed_signature' };

  const given = Buffer.from(m[1].toLowerCase(), 'hex');
  const expected = crypto.createHmac('sha256', appSecret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8'))
    .digest();

  if (given.length !== expected.length) return { ok: false, reason: 'signature_mismatch' };
  if (!crypto.timingSafeEqual(given, expected)) return { ok: false, reason: 'signature_mismatch' };
  return { ok: true };
}

/* ── EVENT NORMALISATION ───────────────────────────────────────────────────
   Meta nests events: entry[] -> changes[] -> value -> messages[] | statuses[].
   Flattened into records with a STABLE id, because Cloud API retries on any
   non-200 and a retry must not create a second row.

   MESSAGE BODIES ARE NOT STORED. An inbound message is a customer's words; this
   slice records that one arrived, from whom, of what type and when. Content
   belongs in the conversation store, behind the communications engine, under
   whatever retention that slice decides — not dropped into a diagnostic
   collection by the receiver. */
function normalise (payload) {
  const out = [];
  const body = payload || {};
  if (body.object !== 'whatsapp_business_account') {
    return { events: [], rejected: 'unexpected_object:' + String(body.object).slice(0, 40) };
  }
  (body.entry || []).forEach((entry) => {
    (entry.changes || []).forEach((change) => {
      const v = (change && change.value) || {};
      const meta = v.metadata || {};
      (v.messages || []).forEach((msg) => {
        out.push({
          id: 'msg_' + String(msg.id || '').slice(0, 120),
          kind: 'message',
          wamid: msg.id || null,
          from: msg.from || null,               /* the sender's number, an identifier */
          type: msg.type || null,               /* text | image | interactive | … */
          timestamp: msg.timestamp || null,
          phoneNumberId: meta.phone_number_id || null,
          wabaId: entry.id || null,
          /* deliberately NO message body — see the note above */
        });
      });
      (v.statuses || []).forEach((st) => {
        out.push({
          id: 'st_' + String(st.id || '').slice(0, 100) + '_' + String(st.status || ''),
          kind: 'status',
          wamid: st.id || null,
          status: st.status || null,            /* sent | delivered | read | failed */
          recipient: st.recipient_id || null,
          timestamp: st.timestamp || null,
          phoneNumberId: meta.phone_number_id || null,
          wabaId: entry.id || null,
          errorCode: (st.errors && st.errors[0] && st.errors[0].code) || null,
        });
      });
    });
  });
  return { events: out, rejected: null };
}

/* ── RECORDING ─────────────────────────────────────────────────────────────
   create(), not set(). Cloud API retries aggressively, and set() would let a
   replayed delivery overwrite a later read status with an earlier one. An
   already-present id is a DUPLICATE, which is a success — Meta must get its
   200 or it will retry for ever. */
async function recordEvents (events, store) {
  const out = { written: 0, duplicate: 0, failed: 0 };
  for (const ev of events) {
    try {
      const fresh = await store.create(ev.id, Object.assign({ receivedAt: new Date().toISOString() }, ev));
      if (fresh) out.written++; else out.duplicate++;
    } catch (_) { out.failed++; }
  }
  return out;
}

/* ── THE HANDLER ───────────────────────────────────────────────────────────
   Injectable end to end so the suite exercises THIS function rather than a
   paraphrase of it. Returns { status, body } instead of touching a response
   object, so the decision and the transport stay separable. */
async function handleRequest (req, deps) {
  const d = deps || {};
  const method = String((req && req.method) || 'GET').toUpperCase();

  if (method === 'GET') {
    const v = verifyChallenge(req.query, d.verifyToken);
    if (!v.ok) return { status: 403, body: 'Forbidden', reason: v.reason };
    /* The challenge is echoed as a RAW body. Wrapping it in JSON fails the
       handshake with no useful error from Meta. */
    return { status: 200, body: v.challenge, reason: 'verified' };
  }

  if (method !== 'POST') return { status: 405, body: 'Method Not Allowed', reason: 'bad_method' };

  const sig = verifySignature(req.rawBody, _header(req, 'x-hub-signature-256'), d.appSecret);
  if (!sig.ok) {
    /* 403, never 401: 401 invites a retry with credentials, and there are none
       to offer. The reason is logged, not returned — telling an unauthenticated
       caller WHY their signature failed is a probing oracle. */
    return { status: 403, body: 'Forbidden', reason: sig.reason };
  }

  let payload;
  try { payload = JSON.parse((req.rawBody || '').toString('utf8')); }
  catch (_) { return { status: 400, body: 'Bad Request', reason: 'unparseable_json' }; }

  const n = normalise(payload);
  if (n.rejected) return { status: 200, body: 'EVENT_RECEIVED', reason: n.rejected };

  let recorded = { written: 0, duplicate: 0, failed: 0 };
  if (n.events.length && d.store) recorded = await recordEvents(n.events, d.store);

  /* Delivery state for messages SOKONI sent (whatsapp-sender.js → whatsappSends/{wamid}): advance the ONE
     send record — sent → delivered → read, or failed — never backwards (Meta retries and reorders). A status
     for a message that is not ours is ignored. No message content is involved at any point. */
  const advanced = { updated: 0, ignored: 0, failed: 0 };
  if (d.sends) {
    for (const ev of n.events) {
      if (ev.kind !== 'status' || !ev.wamid || !ev.status) continue;
      try {
        const r = await d.sends.advance(ev.wamid, ev.status, ev.errorCode ? { errorCode: ev.errorCode } : null);
        if (r && r.updated) advanced.updated++; else advanced.ignored++;
      } catch (_) { advanced.failed++; }
    }
  }

  /* 200 EVENT_RECEIVED even with nothing to record. A non-200 makes Cloud API
     retry the same batch, and a batch we understood but had no rows for is not
     a failure. A storage failure is reported in the result and logged; it is
     deliberately NOT a non-200, because retrying will not fix a validation
     problem and would loop for ever. */
  return { status: 200, body: 'EVENT_RECEIVED', reason: 'ok', events: n.events.length, recorded, advanced };
}

function _header (req, name) {
  if (!req) return null;
  if (typeof req.get === 'function') return req.get(name);
  const h = req.headers || {};
  return h[name] || h[name.toLowerCase()] || null;
}

/* An in-memory store for the suite, with create() semantics that match
   Firestore's: a second create for the same id does not overwrite. */
function memoryStore (seed) {
  const docs = Object.assign({}, seed || {});
  return {
    kind: 'memory',
    async create (id, rec) { if (docs[id]) return false; docs[id] = rec; return true; },
    async get (id) { return docs[id] || null; },
    _docs: docs,
  };
}

function firestoreStore () {
  const admin = require('firebase-admin');
  return {
    kind: 'firestore',
    async create (id, rec) {
      try {
        await admin.firestore().collection(COLLECTION).doc(id).create(rec);
        return true;
      } catch (e) {
        /* ALREADY_EXISTS is the idempotency guard doing its job, not an error. */
        if (e && (e.code === 6 || e.code === 'already-exists')) return false;
        throw e;
      }
    },
    async get (id) {
      const s = await admin.firestore().collection(COLLECTION).doc(id).get();
      return s.exists ? s.data() : null;
    },
  };
}

/* ── THE DEPLOYABLE FUNCTION ───────────────────────────────────────────────
   Thin on purpose: it binds the secrets, hands the request to handleRequest(),
   and turns the result into a response. Every decision above is testable
   without it, which is why the certification exercises handleRequest directly
   rather than a paraphrase.

   NOT EXPORTED FROM functions/index.js, AND THAT IS DELIBERATE.
   `defineSecret` binds a secret at deploy time, and neither WHATSAPP_VERIFY_TOKEN
   nor WHATSAPP_APP_SECRET exists in Secret Manager yet. Wiring this into
   index.js today would make the NEXT functions deploy fail — for every agent
   working this repository, on a lane that has nothing to do with WhatsApp.
   Because index.js does not require this module, nothing here executes and
   nothing is bound; shipping it is two lines in index.js once the secrets are
   provisioned. */
let _onRequest, _defineSecret;
function _fnDeps () {
  if (!_onRequest) {
    _onRequest    = require('firebase-functions/v2/https').onRequest;
    _defineSecret = require('firebase-functions/params').defineSecret;
  }
  return { onRequest: _onRequest, defineSecret: _defineSecret };
}

/** Called from functions/index.js ONCE the two secrets exist. */
function buildFunction () {
  const { onRequest, defineSecret } = _fnDeps();
  /* STRING LITERALS, not SECRET_NAMES.verifyToken — deliberately, and the
     duplication is the point.

     Every secret-inventory tool in this repository finds bound secrets by
     grepping for defineSecret('NAME'). Passing a variable makes this function's
     two secrets INVISIBLE to all of them: they would not appear in a
     provisioning audit, and a preflight gate would report the deploy as ready
     while these were missing. Greppability is a property worth a duplicated
     string.

     A test asserts the literals and SECRET_NAMES agree, so the duplication
     cannot drift. */
  const VERIFY = defineSecret('WHATSAPP_VERIFY_TOKEN');
  const APPSEC = defineSecret('WHATSAPP_APP_SECRET');

  const logger = require('firebase-functions/logger');

  return onRequest(
    { region: 'us-central1', timeoutSeconds: 30, maxInstances: 10,
      secrets: [VERIFY, APPSEC],

      /* invoker: "public" IS REQUIRED, and its absence is a silent failure.
         Without it Cloud Run demands an IAM identity and rejects the request
         with 403 BEFORE any code here runs — so the signature check, the
         handshake and every test in the suite would be irrelevant, and Meta
         would report the callback as unreachable with nothing in our logs to
         explain it. webhookIntasend, webhookMpesa and webhookStripe all set it
         for the same reason. */
      invoker: 'public',

      /* NO enforceAppCheck: Meta is not a SOKONI client and cannot present a
         token. The SIGNATURE is the authentication, which is why it is verified
         before anything else happens.

         NO minInstances: webhookIntasend pins one warm instance because a
         payment callback that arrives late costs money. Meta retries failed
         deliveries with backoff, so a cold start is recovered automatically and
         a warm instance would be paid for around the clock to avoid a problem
         the provider already solves. */
      cors: false },

    async (req, res) => {
      let out;
      try {
        out = await handleRequest(req, {
          verifyToken: VERIFY.value(),
          appSecret:   APPSEC.value(),
          store:       firestoreStore(),
          sends:       require('./whatsapp-sender').firestoreSends(),
        });
      } catch (e) {
        /* A crash must not read as an accepted event. 500 makes Cloud API
           retry, which is right for an unexpected fault — unlike a validation
           failure, a transient fault may well succeed next time. */
        logger.error('[webhookWhatsapp] unhandled', { message: e && e.message });
        res.status(500).send('Internal Error');
        return;
      }
      /* COUNTS and a reason, never content. An inbound message is a customer's
         words and must not reach the logs; the verify token and app secret
         never appear here either, and `reason` is our own vocabulary rather
         than anything echoed from the request. */
      logger.info('[webhookWhatsapp]', {
        method: req.method, status: out.status, reason: out.reason,
        events: out.events || 0, recorded: out.recorded || null,
      });
      res.status(out.status).send(out.body);
    }
  );
}

module.exports = {
  SECRET_NAMES, COLLECTION,
  verifyChallenge, verifySignature, normalise, recordEvents, handleRequest,
  memoryStore, firestoreStore, buildFunction,
};
