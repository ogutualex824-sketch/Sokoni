'use strict';
/**
 * SOKONI Connect — the caller-facing communication layer.
 * ============================================================================================
 * Fourteen callables behind one dispatcher service (connect-dispatch.js), plus one scheduled
 * sweep that cannot be dispatched.
 *
 *   connectRequestSession              open a chat/voice/video session against a business anchor
 *   connectGetSessionState             what the client may render, and offer, right now
 *   connectMarkRinging                 the recipient's device is showing the call
 *   connectAnswerSession               the callee accepts  (-> accepted, NOT connected)
 *   connectDeclineSession              the callee refuses
 *   connectCancelSession               the caller withdraws before any media
 *   connectReportMediaEvent            what the media stack OBSERVED — the only route to
 *                                      connecting / connected / failed
 *   connectEndSession                  the call finishes
 *   connectSignal                      WebRTC SDP/ICE relay, participants only
 *   connectSetVideoGrant               an Enterprise account owner grants a member video
 *   connectRequestVerification         a platform admin opens a video verification
 *   connectRecordVerificationOutcome   what the admin observed
 *   connectExpireStaleSessions         (scheduled) the writer for `expired`
 *
 * ── THE STATE MACHINE IS THE AUTHORITY ─────────────────────────────────────────────────────
 * Every state change goes through `_advance`, which asks connect-authority's table. There are
 * no per-callsite `allowedFrom` lists — six lists drift, one table does not — and a client
 * names a DESTINATION, never a from-state. `authorized -> connected` is refused, so a call
 * nobody answered can never be recorded as one that connected.
 *
 * The ACTOR is derived from the session document, never from the request: a participant
 * cannot claim to be the other one.
 *
 * ── INTENTIONS VS OBSERVATIONS ─────────────────────────────────────────────────────────────
 * `accept`, `decline`, `cancel`, `end` and `ringing` are destination ops, because they are
 * things a PERSON did. `connecting`, `connected` and `failed` have NO op at all — they are
 * reached only by reporting a media EVENT, which the authority interprets. Pressing Decline is
 * an intention; ICE failing is an observation, and conflating them would make "the connection
 * dropped" indistinguishable from "they hung up on me".
 *
 * ── THE ONE RULE ───────────────────────────────────────────────────────────────────────────
 * THE CLIENT NEVER NAMES THE OTHER PARTY. There is no `calleeUid` parameter anywhere in this
 * file. A caller names an ANCHOR — an order, a booking, a delivery, a supplier relationship,
 * a support case — and the server reads that document to discover who the parties are.
 *
 * This is not stylistic. The deployed `createConversation` accepts `participantUids` from
 * `req.data` and guards only with `participantUids.includes(uid)`, so in production a caller
 * can record an arbitrary uid as a conversation participant. A wrong chat participant puts a
 * message in the wrong inbox. A wrong CALL participant makes a stranger's telephone ring.
 *
 * ── SELLER IDENTITY ────────────────────────────────────────────────────────────────────────
 * `order.sellerUid` is written by the BROWSER. `firestore.rules` checks `uid` on the order and
 * never constrains `sellerUid`, so it is ADVISORY and is never used to decide who may be
 * called. The authoritative chain is:
 *
 *     order -> items[].productId -> products/{id}.sellerUid
 *
 * because `products` create requires `sellerUid == request.auth.uid` and update forbids
 * changing it. The resolver REFUSES on: no items, no resolvable productId, no product, no
 * seller on the product, or MORE THAN ONE distinct seller. The advisory field is read only to
 * be recorded as agreeing or disagreeing — never to authorise.
 *
 * ── WHAT THIS DOES NOT DO ──────────────────────────────────────────────────────────────────
 * It does not carry media. WebRTC signalling is relayed between participants; no TURN/STUN
 * service, no SIP trunk and no telephony account is provisioned by this repository. PSTN
 * fallback is therefore reported as NOT_CONFIGURED and never enters a transport plan. Nothing
 * in this file should be read as evidence that a call can currently be placed.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

const CA = require('./shared/connect-authority');
const deliveryAuthority = require('./delivery-authority');

const REGION = 'us-central1';

exports._h = {}; /* handler registry for connectDispatch */

function _db() { return admin.firestore(); }
function _now() { return admin.firestore.FieldValue.serverTimestamp(); }

/* ── Transport provisioning ───────────────────────────────────────────────────────────────
 * Declared, not guessed. A transport is `true` only when a provider is actually provisioned;
 * until then the plan must say so rather than offer a route that silently drops.
 *
 * webrtc is TRUE because peer-to-peer signalling is relayed by connectSignal below and needs
 * no third-party account for two peers that can reach each other directly. It will still fail
 * behind symmetric NAT without TURN — which is a media-quality limitation recorded in
 * docs/SOKONI_CONNECT.md, not a claim that every call connects.
 *
 * pstn is FALSE and stays FALSE until a telephony provider is contracted, configured and
 * field-proven. Flipping this constant is not the integration. */
const PROVIDERS = Object.freeze({
  webrtc: true,
  pstn: false,
});

function _uid(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Login required');
  return req.auth.uid;
}

function _isPlatformAdmin(req) {
  const t = req.auth && req.auth.token;
  return !!(t && (t.admin === true || t.superAdmin === true));
}

function _str(v, max) {
  return String(v == null ? '' : v).trim().slice(0, max || 128);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   ANCHOR RESOLUTION — who are the parties, and is the relationship live?
   Every resolver returns { kind, state, parties: { role: uid }, anchorType, anchorId,
   advisory } or throws. It NEVER returns a partial answer: an anchor it cannot fully resolve
   is a refusal, because a half-resolved relationship authorises a guess.
══════════════════════════════════════════════════════════════════════════════════════════ */

/** Order/booking/delivery lifecycle words → the three states the authority understands. */
const LIVE_ORDER_STATES = ['pending', 'confirmed', 'processing', 'paid', 'paid_held',
  'shipped', 'out_for_delivery', 'in_transit', 'ready', 'accepted', 'assigned', 'active'];
const CLOSED_ORDER_STATES = ['delivered', 'completed', 'fulfilled', 'closed', 'settled'];
const CANCELLED_STATES = ['cancelled', 'canceled', 'refunded', 'failed', 'expired', 'rejected'];

function _stateOf(raw) {
  const s = String(raw || '').toLowerCase();
  if (LIVE_ORDER_STATES.includes(s)) return 'active';
  if (CLOSED_ORDER_STATES.includes(s)) return 'closed';
  if (CANCELLED_STATES.includes(s)) return 'cancelled';
  /* UNKNOWN IS NOT ACTIVE. An unrecognised lifecycle word resolves to a state the authority
     refuses, so a new status spelling closes the call button rather than opening it. */
  return 'unknown';
}

const BUYER_FIELDS = ['uid', 'userId', 'buyerId', 'buyerUid', 'customerUid'];
function _buyerOf(doc) {
  for (const f of BUYER_FIELDS) if (doc && doc[f]) return String(doc[f]);
  return null;
}

/**
 * _sellerOfOrder(db, order) -> { sellerUid, advisory }
 *
 * The fail-closed chain described in this file's header. Throws rather than guessing.
 */
async function _sellerOfOrder(db, order) {
  const items = Array.isArray(order.items) ? order.items
    : Array.isArray(order.products) ? order.products
      : Array.isArray(order.lineItems) ? order.lineItems : [];
  const productIds = [...new Set(items
    .map((it) => it && (it.productId || it.id || it.pid))
    .filter(Boolean)
    .map(String))];

  if (!productIds.length) {
    throw new HttpsError('failed-precondition',
      'This order does not name any product, so its seller cannot be established.');
  }
  /* Capped: an order with hundreds of lines is not a calling relationship, and an unbounded
     fan-out here is a denial-of-service surface on a callable anyone may reach. */
  if (productIds.length > 25) {
    throw new HttpsError('failed-precondition', 'Order has too many distinct products to resolve a single seller.');
  }

  const snaps = await db.getAll(...productIds.map((id) => db.collection('products').doc(id)));
  const sellers = new Set();
  let missing = 0;
  snaps.forEach((s) => {
    if (!s.exists) { missing++; return; }
    const su = s.data() && s.data().sellerUid;
    if (su) sellers.add(String(su)); else missing++;
  });

  if (!sellers.size) {
    throw new HttpsError('failed-precondition',
      'No product on this order carries an authoritative seller.');
  }
  if (sellers.size > 1) {
    /* A multi-seller order has no single counterparty. Picking one would be a coin toss that
       rings somebody who was never party to the line the caller means. */
    throw new HttpsError('failed-precondition',
      'This order has products from more than one seller — open the call from a single line.');
  }

  const sellerUid = [...sellers][0];
  /* Advisory only. Recorded so a disagreement is visible in the session record; it decides
     nothing. */
  const claimed = order.sellerUid ? String(order.sellerUid) : null;
  return {
    sellerUid,
    advisory: {
      claimedSellerUid: claimed,
      agrees: claimed ? claimed === sellerUid : null,
      productsMissingSeller: missing,
    },
  };
}

async function _anchorOrder(db, anchorId) {
  const snap = await db.collection('orders').doc(anchorId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Order not found');
  const order = snap.data() || {};
  const buyer = _buyerOf(order);
  if (!buyer) throw new HttpsError('failed-precondition', 'Order has no resolvable buyer');
  const { sellerUid, advisory } = await _sellerOfOrder(db, order);
  return {
    kind: 'order',
    state: _stateOf(order.status || order.orderStatus),
    parties: { buyer, seller: sellerUid },
    anchorType: 'orders',
    anchorId,
    advisory,
  };
}

async function _anchorInquiry(db, anchorId) {
  /* The anchor IS the listing. An enquiry is self-asserted — which is exactly why the
     `inquiry` relationship carries a chat-only ceiling in the authority. */
  const snap = await db.collection('products').doc(anchorId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Listing not found');
  const p = snap.data() || {};
  if (!p.sellerUid) throw new HttpsError('failed-precondition', 'Listing has no seller');
  const published = p.status ? !CANCELLED_STATES.includes(String(p.status).toLowerCase()) : true;
  return {
    kind: 'inquiry',
    state: published ? 'active' : 'closed',
    parties: { seller: String(p.sellerUid) },
    anchorType: 'products',
    anchorId,
    advisory: null,
    /* The buyer side of an enquiry is whoever is asking — filled in by the caller resolver. */
    openBuyerSide: true,
  };
}

async function _anchorBooking(db, anchorId) {
  const snap = await db.collection('bookings').doc(anchorId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Booking not found');
  const b = snap.data() || {};
  if (!b.customerUid || !b.providerId) {
    throw new HttpsError('failed-precondition', 'Booking has no resolvable parties');
  }
  return {
    kind: 'booking',
    state: _stateOf(b.status),
    /* Both fields are SERVER-AUTHORITATIVE on this collection: booking-service sets
       customerUid from req.auth and providerId is validated against providers/{id}. */
    parties: { buyer: String(b.customerUid), provider: String(b.providerId) },
    anchorType: 'bookings',
    anchorId,
    advisory: null,
  };
}

async function _anchorDelivery(db, anchorId, callerUid) {
  const snap = await db.collection('deliveries').doc(anchorId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Delivery not found');
  const d = snap.data() || {};
  let order = null;
  if (d.orderId) {
    const os = await db.collection('orders').doc(String(d.orderId)).get().catch(() => null);
    if (os && os.exists) order = os.data();
  }
  /* Reuses the canonical delivery actor resolver rather than becoming a third one. It returns
     null when there is NO relationship, which callers must treat as a refusal. */
  const actor = deliveryAuthority.resolveActor(callerUid, d, order);
  if (!actor) throw new HttpsError('permission-denied', 'You are not party to this delivery');

  const rider = CA.ROLES.includes('rider')
    ? (deliveryAuthority.RIDER_FIELDS.map((f) => d[f]).find(Boolean) || null) : null;
  if (!rider) throw new HttpsError('failed-precondition', 'Delivery has no assigned rider yet');

  const parties = { rider: String(rider) };
  const buyer = order ? _buyerOf(order) : _buyerOf(d);
  if (buyer) parties.buyer = String(buyer);
  /* The SELLER of a delivery is resolved from the order's products, never from the delivery
     document's own sellerUid — same authority rule as the order anchor. */
  if (order) {
    try {
      const { sellerUid } = await _sellerOfOrder(db, order);
      parties.seller = sellerUid;
    } catch (_) { /* seller unresolvable — the rider↔buyer pair still stands */ }
  }

  return {
    kind: 'delivery',
    state: _stateOf(d.status),
    parties,
    anchorType: 'deliveries',
    anchorId,
    advisory: null,
  };
}

async function _anchorSupport(db, anchorId) {
  const snap = await db.collection('supportTickets').doc(anchorId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Support ticket not found');
  const t = snap.data() || {};
  const subject = _buyerOf(t);
  if (!subject) throw new HttpsError('failed-precondition', 'Ticket has no resolvable subject');
  return {
    kind: 'support',
    state: _stateOf(t.status),
    /* The subject's ROLE on a support case is whatever they are to the platform; `buyer` is
       the position every account holds, so the matrix pair is admin:buyer. A ticket about a
       merchant is still a case between the platform and an account. */
    parties: { buyer: String(subject) },
    anchorType: 'supportTickets',
    anchorId,
    advisory: null,
    adminSide: true,
  };
}

async function _anchorSupply(db, anchorId, callerUid) {
  const snap = await db.collection('suppliers').doc(anchorId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Supplier relationship not found');
  const s = snap.data() || {};
  const merchant = s.ownerUid || s.sellerUid || s.shopOwnerUid || null;
  const supplier = s.supplierUid || s.contactUid || null;
  if (!merchant || !supplier) {
    /* A supplier record that names no SOKONI account on one side describes a business
       contact, not a callable relationship. Refused rather than resolved to a phone number —
       resolving it to a number is exactly the disclosure this module prevents. */
    throw new HttpsError('failed-precondition',
      'This supplier is not a SOKONI account, so no in-platform call can be placed.');
  }
  if (String(merchant) !== String(callerUid) && String(supplier) !== String(callerUid)) {
    throw new HttpsError('permission-denied', 'You are not party to this supplier relationship');
  }
  return {
    kind: 'supply',
    state: _stateOf(s.status || 'active'),
    parties: { seller: String(merchant), supplier: String(supplier) },
    anchorType: 'suppliers',
    anchorId,
    advisory: null,
  };
}

const ANCHORS = Object.freeze({
  order: _anchorOrder,
  inquiry: _anchorInquiry,
  booking: _anchorBooking,
  delivery: _anchorDelivery,
  support: _anchorSupport,
  supply: _anchorSupply,
});

/**
 * _resolveRelationship(db, { anchorType, anchorId, callerUid, isAdmin })
 *   -> { kind, state, from, to, callerUid, calleeUid, anchorType, anchorId, advisory }
 *
 * Establishes the caller's ROLE from the anchor and picks the counterparty. A caller who holds
 * no role on the anchor is refused here, before any channel question is asked.
 */
async function _resolveRelationship(db, opts) {
  const resolver = ANCHORS[opts.anchorType];
  if (!resolver) throw new HttpsError('invalid-argument', `Unknown anchor type: ${opts.anchorType}`);
  const anchor = await resolver(db, opts.anchorId, opts.callerUid);

  const parties = { ...anchor.parties };

  /* An enquiry's buyer is whoever is asking; every other anchor names both sides. */
  if (anchor.openBuyerSide && !parties.buyer) parties.buyer = opts.callerUid;
  /* Only a platform admin may occupy the admin seat on a support case. */
  if (anchor.adminSide && opts.isAdmin) parties.admin = opts.callerUid;

  const roles = Object.keys(parties);
  const myRole = roles.find((r) => String(parties[r]) === String(opts.callerUid));
  if (!myRole) throw new HttpsError('permission-denied', 'You are not party to this relationship');

  /* Counterparty: the other named role. When the anchor names more than two (a delivery names
     rider, buyer and seller), the caller says which ROLE they want — a role, never a uid. */
  const others = roles.filter((r) => r !== myRole);
  let targetRole = opts.targetRole ? String(opts.targetRole) : null;
  if (targetRole && !others.includes(targetRole)) {
    throw new HttpsError('failed-precondition', `This relationship has no ${targetRole} to call`);
  }
  if (!targetRole) {
    if (others.length !== 1) {
      throw new HttpsError('invalid-argument',
        `This relationship has several parties — name targetRole (one of: ${others.join(', ')})`);
    }
    targetRole = others[0];
  }

  return {
    kind: anchor.kind,
    state: anchor.state,
    from: myRole,
    to: targetRole,
    callerUid: String(opts.callerUid),
    calleeUid: String(parties[targetRole]),
    anchorType: anchor.anchorType,
    anchorId: anchor.anchorId,
    advisory: anchor.advisory || null,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   VIDEO ENTITLEMENT
══════════════════════════════════════════════════════════════════════════════════════════ */

/** Composite key for a grant. `__` because a uid may contain no separator-safe character that
 *  a single underscore would keep unambiguous. */
function _grantId(ownerUid, memberUid) { return `${ownerUid}__${memberUid}`; }

/**
 * _videoContextFor(db, uid) -> { capabilities, orgGrant }
 *
 * `capabilities.videoCalling` comes from capability-authority, which resolves the LIVE
 * merchant subscription through subscription-core. An unreadable subscription yields the
 * unsubscribed floor — it never yields a tier nobody has been shown to hold.
 *
 * `orgGrant` is the organisation's own permission for this member. An account that holds the
 * subscription itself always holds its own grant: the subscriber is not a member it must
 * grant permission to.
 */
async function _videoContextFor(db, uid) {
  const capAuthority = require('./capability-authority');
  let capabilities = { videoCalling: false };
  try {
    const r = await capAuthority.capabilitiesFor(uid, { hub: 'merchant' });
    capabilities = r.capabilities || capabilities;
  } catch (e) {
    logger.warn('[connect] capability resolution failed — failing closed', { uid, err: e.message });
    return { capabilities: { videoCalling: false }, orgGrant: false, selfSubscriber: false };
  }

  if (capabilities.videoCalling === true) {
    /* The subscriber themselves. */
    return { capabilities, orgGrant: true, selfSubscriber: true };
  }

  /* A member of an Enterprise organisation: the grant document names both the owner who holds
     the subscription and the member. The OWNER's capability is what counts — the member need
     not hold a subscription of their own. */
  const grants = await db.collection('connectVideoGrants')
    .where('memberUid', '==', uid).where('active', '==', true).limit(5).get()
    .catch(() => null);
  if (!grants || grants.empty) return { capabilities, orgGrant: false, selfSubscriber: false };

  for (const g of grants.docs) {
    const ownerUid = g.data() && g.data().ownerUid;
    if (!ownerUid) continue;
    try {
      const r = await capAuthority.capabilitiesFor(String(ownerUid), { hub: 'merchant' });
      if (r.capabilities && r.capabilities.videoCalling === true) {
        return { capabilities: r.capabilities, orgGrant: true, selfSubscriber: false };
      }
    } catch (_) { /* fail closed on this grant, try the next */ }
  }
  return { capabilities, orgGrant: false, selfSubscriber: false };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   1. connectRequestSession
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectRequestSession = onCall({ region: REGION, timeoutSeconds: 30 },
  exports._h.connectRequestSession = async (req) => {
    const uid = _uid(req);
    const isAdmin = _isPlatformAdmin(req);
    const d = req.data || {};
    const channel = _str(d.channel, 16);
    const anchorType = _str(d.anchorType, 32);
    const anchorId = _str(d.anchorId, 200);
    const purpose = _str(d.purpose, 64);
    const targetRole = d.targetRole ? _str(d.targetRole, 16) : null;

    if (!CA.CHANNELS.includes(channel)) {
      throw new HttpsError('invalid-argument', `channel must be one of: ${CA.CHANNELS.join(', ')}`);
    }
    if (!anchorType || !anchorId) {
      throw new HttpsError('invalid-argument', 'anchorType and anchorId are required');
    }

    const db = _db();
    const rel = await _resolveRelationship(db, { anchorType, anchorId, callerUid: uid, isAdmin, targetRole });

    let mode = null;
    let consumes = false;

    if (channel === 'video') {
      const ctx = isAdmin ? null : await _videoContextFor(db, uid);
      const v = CA.resolveVideoAccess({
        isPlatformAdmin: isAdmin,
        capabilities: ctx ? ctx.capabilities : null,
        orgGrant: ctx ? ctx.orgGrant : false,
        purpose,
        relationship: { from: rel.from, to: rel.to, kind: rel.kind, state: rel.state },
      });
      if (!v.allowed) {
        /* The reason is a stable code, not an internal detail: a client renders it, and an
           auditor can tell "plan does not include video" from "organisation has not granted
           it" — two refusals with completely different remedies. */
        throw new HttpsError('permission-denied', `Video not permitted: ${v.reason}`);
      }
      mode = v.mode;
      consumes = v.consumesEnterpriseEntitlement;
    } else {
      const ok = CA.mayCommunicate({
        from: rel.from, to: rel.to, relationship: rel.kind, state: rel.state, channel,
      });
      if (!ok.allowed) throw new HttpsError('permission-denied', `Not permitted: ${ok.reason}`);
    }

    /* Presence. Absent presence reads as OFFLINE, never as online: an optimistic assumption
       here produces a WebRTC plan for a peer that will never answer, and the caller is told a
       route exists that does not. */
    const presence = await Promise.all([uid, rel.calleeUid].map((u) =>
      db.collection('presence').doc(u).get().catch(() => null)));
    const online = presence.map((s) => !!(s && s.exists && s.data() && s.data().online === true));

    const transport = CA.selectTransport({
      channel,
      callerOnline: online[0],
      calleeOnline: online[1],
      providers: PROVIDERS,
    });
    if (channel !== 'chat' && !transport.plan.length) {
      throw new HttpsError('unavailable',
        transport.notConfigured.includes('pstn') && !online[1]
          ? 'The other party is offline and no cellular fallback is configured.'
          : 'No route is available for this call right now.');
    }

    const sessionRef = db.collection('connectSessions').doc();
    const record = CA.buildSessionRecord({
      now: _now(),
      sessionId: sessionRef.id,
      channel,
      mode,
      callerUid: uid,
      calleeUid: rel.calleeUid,
      relationship: rel.kind,
      anchorType: rel.anchorType,
      anchorId: rel.anchorId,
      purpose,
      transportPlan: transport.plan,
      status: CA.INITIAL_STATE,
      consumesEnterpriseEntitlement: consumes,
    });
    /* Participants as a queryable array — this is the ONLY list of who is on the call, and it
       was derived, never supplied. */
    record.participants = [uid, rel.calleeUid];
    record.roles = { [rel.from]: uid, [rel.to]: rel.calleeUid };
    record.advisory = rel.advisory;

    await sessionRef.create(record);

    logger.info('[connect] session requested', {
      sessionId: sessionRef.id, channel, mode, relationship: rel.kind,
      from: rel.from, to: rel.to, transport: transport.plan.join(','),
    });

    /* ── TELL THE CALLER THE TRUTH ────────────────────────────────────────────────────────
       A caller who presses Call and is shown "Calling…" while nothing was ever dispatched
       watches a silent session expire and concludes the other party ignored them. So a
       chat/voice/video request reports whether a ring is even possible.

       `reachable: true` is NOT "ringing". It means a route exists and the callee has
       somewhere a push could land — a pre-check, never a delivery receipt. What actually
       happened is written by the dispatcher as `notifyOutcome` / `ringingBy`, and
       connectGetSessionState surfaces it. */
    let reachability = { reachable: true, reason: 'not_a_call_channel' };
    if (channel !== 'chat') {
      const notifier = require('./connect-notify');
      reachability = notifier.evaluateReachability({
        transportPlan: transport.plan,
        hasPushTarget: await notifier.hasPushTarget(rel.calleeUid),
      });
      if (!reachability.reachable) {
        logger.info('[connect] session created but the callee cannot be rung', {
          sessionId: sessionRef.id, reason: reachability.reason,
        });
      }
    }

    /* The response carries HANDLES, not numbers. */
    return {
      sessionId: sessionRef.id,
      channel,
      mode,
      relationship: rel.kind,
      counterpartyRole: rel.to,
      counterpartyHandle: CA.endpointHandleFor(rel.calleeUid),
      transportPlan: transport.plan,
      fallbackAvailable: transport.fallbackAvailable,
      notConfigured: transport.notConfigured,
      status: CA.INITIAL_STATE,
      /* No new session state — the machine is untouched. This is a RESULT of the request,
         and the session follows the existing expiry path either way. */
      reachable: reachability.reachable,
      reachableReason: reachability.reason,
    };
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   2–4. answer / decline / end
══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * _disclosureFor(session) -> the six-field consent contract, or null.
 *
 * Built from the session rather than stored on it, so a disclosure can never drift from the
 * session it describes. Recording is `OFF` everywhere today; the consent module REFUSES to
 * build a contract with recording ON unless retention and access are stated explicitly, so
 * the day recording arrives this call fails loudly rather than shipping a placeholder.
 */
function _disclosureFor(session) {
  const s = session || {};
  if (String(s.channel) !== 'video') return null;
  const consent = require('./shared/connect-consent');
  const purpose = (s.context && s.context.purpose) ? String(s.context.purpose)
    : (s.mode === 'PLATFORM' ? 'identity_verification' : 'business_meeting');
  try {
    return consent.buildConsentDisclosure({ purpose, recording: 'OFF' });
  } catch (e) {
    /* A disclosure that cannot be built must never be replaced by a vague one. The client
       falls back to refusing the session rather than showing an invented promise. */
    logger.warn('[connect] could not build a consent disclosure', { err: e.message });
    return null;
  }
}

/**
 * _advance(req, to, { actor }) — the ONE path a session changes state by.
 *
 * There is no other. Every named op below is a thin wrapper, and the legality of the move is
 * decided by connect-authority's table rather than by an `allowedFrom` list written out at
 * each call site — six lists drift, one table does not. A client names a DESTINATION; it
 * never names a from-state, and it cannot invent an edge.
 *
 * `actor` is derived from the session document, never from the request: the caller is
 * whoever `callerUid` says, and a participant cannot claim to be the other one.
 */
async function _advance(req, to) {
  const uid = _uid(req);
  const sessionId = _str((req.data || {}).sessionId, 200);
  if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');

  const db = _db();
  const ref = db.collection('connectSessions').doc(sessionId);

  return db.runTransaction(async (t) => {
    const snap = await t.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found');
    const s = snap.data();
    if (!Array.isArray(s.participants) || !s.participants.includes(uid)) {
      throw new HttpsError('permission-denied', 'You are not on this call');
    }

    /* DERIVED, not supplied. The same principle as the participant list. */
    const actor = String(s.callerUid) === String(uid) ? 'caller' : 'callee';

    const move = CA.canTransition({
      from: String(s.status),
      to,
      actor,
      channel: s.channel,
      consentAcknowledged: (req.data || {}).consentAcknowledged,
    });
    if (!move.ok) {
      /* A stable code, not an internal detail: a client renders it, and an auditor can tell
         "you are not the called party" from "that call already ended". */
      throw new HttpsError('failed-precondition', `${s.status} -> ${to}: ${move.reason}`);
    }

    const patch = { status: to, updatedAt: _now() };

    if (to === 'ringing') {
      /* The STRONGER evidence: the recipient's device says it is actually alerting, as
         opposed to a push transport having accepted the call. Recorded distinctly so the two
         are never confused — see connect-notify.js. If the dispatcher already moved it, this
         op is refused as a no-op and the device instead confirms via `deviceAlertedAt` on the
         next state read; the distinction is deliberate, not a gap. */
      patch.ringingBy = 'device';
      patch.deviceAlertedAt = _now();
    }
    if (to === 'accepted') {
      patch.acceptedAt = _now();
      /* CONSENT IS A SERVER GATE, NOT A DIALOG. canTransition already refused an
         unacknowledged video accept; this records WHAT WAS ACCEPTED, on the session rather
         than in the browser that showed the dialog. */
      if (CA.consentRequiredFor(s.channel)) {
        patch.consentAcceptedAt = _now();
        patch.consentAcceptedBy = uid;
        patch.consentRecordingDisclosed = 'OFF';
        /* THE DISCLOSURE THAT WAS ACCEPTED, snapshotted onto the session. What a person
           agreed to is part of the agreement: if the contract changes later, this record
           still says what THIS person was shown. */
        const disclosure = _disclosureFor(s);
        if (disclosure) patch.consentDisclosure = disclosure;
      }
    }
    if (to === 'connected') {
      patch.connectedAt = _now();
      /* The transport actually used is reported by the client that connected. Recorded as an
         OBSERVATION and never allowed to widen the plan the server authorized. */
      const used = _str((req.data || {}).transportUsed, 16);
      if (used && Array.isArray(s.transportPlan) && s.transportPlan.includes(used)) {
        patch.transportUsed = used;
      }
    }
    if (to === 'failed') {
      /* Why it failed is useful and is NOT trusted: it is a free-text note from a client,
         capped, and it decides nothing. */
      patch.failureNote = _str((req.data || {}).note, 300) || null;
    }
    if (CA.isTerminalState(to)) patch.endedAt = _now();

    t.update(ref, patch);
    return { sessionId, status: to, nextStates: CA.nextStates(to) };
  });
}

/* The named ops. Each one is a DESTINATION; who may take it, and from where, is the table's
   business. `connectAnswerSession` now lands on `accepted`, NOT `connected` — a call is not
   connected because somebody pressed Answer, it is connected when media flows, and collapsing
   the two is how a session that never negotiated gets recorded as a conversation. */
exports.connectAnswerSession = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectAnswerSession = (req) => _advance(req, 'accepted'));

exports.connectMarkRinging = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectMarkRinging = (req) => _advance(req, 'ringing'));

exports.connectDeclineSession = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectDeclineSession = (req) => _advance(req, 'declined'));

exports.connectCancelSession = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectCancelSession = (req) => _advance(req, 'cancelled'));

/**
 * connectReportMediaEvent — the ONLY way a session reaches `connecting`, `connected` or
 * `failed`.
 *
 * THERE IS NO OP THAT NAMES THOSE STATES. A WebRTC client cannot write `connected` because it
 * constructed an RTCPeerConnection; it reports what its media stack OBSERVED, and the
 * authority decides what that observation means. Two layers rule on it — the event table maps
 * the observation to an intended destination, and the state table decides whether that move is
 * legal from where the session actually is — so a client reporting `media_flowing` while the
 * session is still `accepted` does not skip `connecting`.
 *
 * An event that is already satisfied, or that arrives after the call ended, is IGNORED rather
 * than refused. Media events race and repeat; failing a client into a retry loop over a
 * duplicate `media_flowing` would be a defect, not a control.
 */
exports.connectReportMediaEvent = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectReportMediaEvent = async (req) => {
    const uid = _uid(req);
    const d = req.data || {};
    const sessionId = _str(d.sessionId, 200);
    const event = _str(d.event, 40);
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');
    if (!CA.MEDIA_EVENT_NAMES.includes(event)) {
      throw new HttpsError('invalid-argument',
        `event must be one of: ${CA.MEDIA_EVENT_NAMES.join(', ')}`);
    }

    const db = _db();
    const ref = db.collection('connectSessions').doc(sessionId);

    return db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Session not found');
      const s = snap.data();
      if (!Array.isArray(s.participants) || !s.participants.includes(uid)) {
        throw new HttpsError('permission-denied', 'You are not on this call');
      }

      /* Derived, never supplied — the same rule as every other transition. */
      const actor = String(s.callerUid) === String(uid) ? 'caller' : 'callee';
      const verdict = CA.interpretMediaEvent({ from: String(s.status), event, actor });

      if (verdict.effect === 'refused') {
        throw new HttpsError('failed-precondition',
          `${s.status} + ${event}: ${verdict.reason}`);
      }

      const patch = { updatedAt: _now(), lastMediaEvent: event, lastMediaEventAt: _now() };
      /* Observational timestamps, useful when diagnosing a call that found a route and still
         carried nothing. They change no state. */
      if (verdict.records) patch[verdict.records] = _now();

      if (verdict.effect === 'transition') {
        patch.status = verdict.intends;
        if (verdict.intends === 'connected') {
          patch.connectedAt = _now();
          const used = _str(d.transportUsed, 16);
          if (used && Array.isArray(s.transportPlan) && s.transportPlan.includes(used)) {
            patch.transportUsed = used;
          }
        }
        if (verdict.intends === 'failed') {
          patch.failureNote = _str(d.note, 300) || null;
        }
        if (CA.isTerminalState(verdict.intends)) patch.endedAt = _now();
      }

      t.update(ref, patch);
      const status = verdict.effect === 'transition' ? verdict.intends : String(s.status);
      return {
        sessionId,
        event,
        effect: verdict.effect,          /* transition | ignored | recorded_only */
        status,
        nextStates: CA.nextStates(status),
      };
    });
  });

exports.connectEndSession = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectEndSession = (req) => _advance(req, 'ended'));

/* ══════════════════════════════════════════════════════════════════════════════════════════
   connectAvailableActions — which communication actions does this anchor offer ME?

   THE QUESTION A BUSINESS SURFACE HAS TO ASK BEFORE IT DRAWS A BUTTON.

   Without this op a client can only decide by mapping an order's lifecycle word onto a
   relationship state itself — and `shared/connect-call-surface.js` forbids exactly that:
   "Do not invent a second set of order/delivery lifecycle states inside Connect." Two tables
   of what `delivered` means is how one screen offers a call the server refuses.

   So the mapping stays in ONE place. The client names an anchor; the server resolves it,
   derives the caller's role from the document, maps the lifecycle word with the same
   `_stateOf` every other Connect path uses, and returns the actions — each already checked
   against BOTH the product surface policy and the communication authority.

   A BUTTON IS STILL NOT A PERMISSION. This op is a rendering aid: every returned action is
   re-authorized when `connectRequestSession` is actually called, and an action absent here
   blocks nothing — the callable is reachable directly and would refuse on its own.

   IT NAMES NO PERSON. The response carries ROLES and labels, never a uid, a telephone number
   or an email address. The recipient stays derived from the anchor, which is the rule the
   whole layer is built on.
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectAvailableActions = onCall({ region: REGION, timeoutSeconds: 20 },
  exports._h.connectAvailableActions = async (req) => {
    const uid = _uid(req);
    const isAdmin = _isPlatformAdmin(req);
    const d = req.data || {};
    const anchorType = _str(d.anchorType, 32);
    const anchorId = _str(d.anchorId, 200);
    if (!anchorType || !anchorId) {
      throw new HttpsError('invalid-argument', 'anchorType and anchorId are required');
    }

    const surface = require('./shared/connect-call-surface');
    const db = _db();

    const resolver = ANCHORS[anchorType];
    if (!resolver) throw new HttpsError('invalid-argument', `Unknown anchor type: ${anchorType}`);

    /* A caller who is not party to the anchor gets NOTHING — and gets it as an empty list
       with a reason, not as an error. A surface asking "what can I do here" about something
       it turns out not to be party to is a normal page load, not a fault. */
    let anchor;
    try {
      anchor = await resolver(db, anchorId, uid);
    } catch (e) {
      return { anchorType, anchorId, actions: [], reason: 'anchor_unavailable', authorizes: false };
    }

    const parties = { ...anchor.parties };
    if (anchor.openBuyerSide && !parties.buyer) parties.buyer = uid;
    if (anchor.adminSide && isAdmin) parties.admin = uid;

    const roles = Object.keys(parties);
    const myRole = roles.find((r) => String(parties[r]) === String(uid));
    if (!myRole) {
      return { anchorType, anchorId, actions: [], reason: 'not_party_to_this', authorizes: false };
    }

    const actions = [];
    roles.filter((r) => r !== myRole).forEach((targetRole) => {
      /* 1. Does this PRODUCT SURFACE offer the action at all? */
      const shown = surface.callSurfaceFor({
        anchorType: anchor.kind,
        callerRole: myRole,
        targetRole,
        relationshipState: anchor.state,
      });
      if (!shown.show) return;

      /* 2. Does the AUTHORITY permit it, per channel? The surface is deliberately narrower
         than the authority, so this can only ever remove channels, never add one. */
      const channels = ['chat', 'voice'].filter((ch) => CA.mayCommunicate({
        from: myRole, to: targetRole, relationship: anchor.kind, state: anchor.state, channel: ch,
      }).allowed);
      if (!channels.length) return;

      actions.push({
        targetRole,
        channels,
        /* A label, not an identity. */
        label: targetRole.charAt(0).toUpperCase() + targetRole.slice(1),
      });
    });

    return {
      anchorType,
      anchorId,
      relationship: anchor.kind,
      relationshipState: anchor.state,
      callerRole: myRole,
      actions,
      reason: actions.length ? 'actions_available' : 'no_action_offered',
      /* Said in the response so a client cannot read a rendered button as permission. */
      authorizes: false,
    };
  });

/**
 * connectGetSessionState — what the client may render, and what it may offer next.
 *
 * Exists so the UI is a REPRESENTATION of an already-authorized machine rather than a second
 * authority. A button the server would refuse is never drawn, because the list of next states
 * comes from the same table the server enforces.
 */
/* ── THE PROJECTION, BUILT IN ONE PLACE ────────────────────────────────────────────────────
 * `connectGetSessionState` answers for one named session; `connectListIncoming` answers for
 * the sessions waiting on a callee. They must not be two shapes. A client that learns a
 * different vocabulary depending on which read it happened to make is a SECOND PROJECTION,
 * and the two would disagree the first time one of them gained a field. So both call this.
 *
 * PURE with respect to the platform: given the document data it reads no Firestore and no
 * clock. Authorization is NOT here and must not move here — "may I read this session" is a
 * question about the reader, and a projection that answered it would be deciding something.
 * Each call site checks participation before it projects.
 */
function _project(sessionId, s, uid) {
  const actor = String(s.callerUid) === String(uid) ? 'caller' : 'callee';
    /* Filtered by ACTOR, not merely by state: the caller is not shown Decline. And filtered to
       INTENTION states only — `connecting`, `connected` and `failed` have no op behind them,
       so offering them would tell the UI to draw a button the server cannot honour. */
    const offerable = CA.nextStates(s.status)
      .filter((n) => CA.isIntentionState(n))
      .filter((n) =>
        CA.canTransition({ from: s.status, to: n, actor, channel: s.channel,
          /* Consent is asked for at the moment of accepting; it must not remove Accept from
             the list, or the UI could never present the dialog that produces it. */
          consentAcknowledged: n === 'accepted' ? true : undefined }).ok);
    return {
      sessionId,
      status: s.status,
      channel: s.channel,
      mode: s.mode || null,
      actor,
      terminal: CA.isTerminalState(s.status),
      offerable,
      /* What the media stack should bother reporting from here. The client fires these rather
         than deciding what they mean — it observes and requests, the server authorizes and
         records. */
      reportableEvents: CA.reportableEvents(s.status),
      transportPlan: Array.isArray(s.transportPlan) ? s.transportPlan : [],
      recording: s.recording || 'DISABLED',
      /* The dispatcher's own record of what happened, surfaced so a caller can tell
         "their phone never rang" from "they did not answer". Null until the dispatcher has
         run — and null is NOT "delivered". */
      notifyOutcome: s.notifyOutcome || null,
      ringingBy: s.ringingBy || null,
      /* The SIX-FIELD disclosure, built server-side so the client holds no second copy of
         what a person is being asked to agree to. Null for voice and chat — asking for camera
         consent where no camera is used trains people to dismiss the dialog that matters. */
      consentDisclosure: _disclosureFor(s),
      counterpartyHandle: CA.endpointHandleFor(
        actor === 'caller' ? s.calleeUid : s.callerUid),
      /* WHAT THIS CALL IS ABOUT, in the SAME words the push uses. Reused from the dispatcher
         rather than re-derived: "Order #SK-99420" is the only thing that makes an unknown
         caller answerable, and two copies of that sentence would drift. The banner holds no
         copy of it either — it renders what the server said. */
      ring: _ringPayload(s),
    };
}

/* One ring vocabulary, two consumers: the push notification and the in-app incoming banner.
   Required lazily, the same way the consent disclosure is, so the dispatcher's trigger
   definitions are not pulled into every cold start of this module. Never throws: a banner
   without a label renders a neutral dash, which is better than an invented one. */
function _ringPayload(s) {
  try {
    return require('./connect-notify')._internals.ringPayload(s) || null;
  } catch (e) {
    logger.warn('[connect] could not build a ring payload', { err: e.message });
    return null;
  }
}

exports.connectGetSessionState = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectGetSessionState = async (req) => {
    const uid = _uid(req);
    const sessionId = _str((req.data || {}).sessionId, 200);
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');
    const snap = await _db().collection('connectSessions').doc(sessionId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found');
    const s = snap.data();
    if (!Array.isArray(s.participants) || !s.participants.includes(uid)) {
      throw new HttpsError('permission-denied', 'You are not on this call');
    }
    return _project(sessionId, s, uid);
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   4b. connectListIncoming — GATE C3-B: how a callee learns there is a call at all
   ─────────────────────────────────────────────────────────────────────────────────────────
   Until this op existed, the ONLY route to a session was the deep link inside a push
   notification. That made the whole incoming path depend on a transport that is undeployed
   and, on a real handset, unproven — and it left a person who dismissed the notification
   with no way back to a call that is still ringing.

   This is a READ. It creates nothing, authorizes nothing and rings nobody: it reports the
   sessions on which this user is the callee and has not yet answered, each projected through
   exactly the same `_project` the single-session read uses.

   WHICH STATES COUNT AS "INCOMING" IS DERIVED, NOT LISTED. A hand-written
   `['authorized','ringing']` here would be a second state vocabulary that stops agreeing
   with the table the moment somebody adds an edge. Instead: a session is incoming when the
   CALLEE may still take one of the answering destinations from where it is. That yields
   `authorized` and `ringing` today, and excludes `accepted` — a call already answered is in
   progress, not incoming — because the only destinations a callee has from there are
   `cancelled` and `failed`.
══════════════════════════════════════════════════════════════════════════════════════════ */

/** The destinations that mean "the callee is still dealing with an unanswered call". */
const ANSWERING_DESTINATIONS = Object.freeze(['ringing', 'accepted', 'declined']);

/** Derived from the authority's table. Never written out by hand. */
const INCOMING_STATES = Object.freeze(
  Object.keys(CA.SESSION_STATES)
    .filter((s) => !CA.isTerminalState(s))
    .filter((s) => ANSWERING_DESTINATIONS.some((to) =>
      CA.nextStates(s).includes(to) &&
      CA.canTransition({ from: s, to, actor: 'callee', consentAcknowledged: true }).ok)));

/** Firestore caps an `in` filter at 30 values. The derivation is far below that; the cap is
 *  applied rather than assumed, so a future edge cannot turn a query into a runtime error. */
const INCOMING_QUERY_LIMIT = 20;

exports.connectListIncoming = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectListIncoming = async (req) => {
    const uid = _uid(req);
    if (!INCOMING_STATES.length) {
      /* The derivation produced nothing, which would silently read as "you have no calls" for
         everybody, forever. An empty result that means "the detector cannot match" must not
         be served as an observation. */
      throw new HttpsError('internal', 'No incoming states are derivable from the session table');
    }
    const snap = await _db().collection('connectSessions')
      .where('calleeUid', '==', uid)
      .where('status', 'in', INCOMING_STATES.slice(0, 30))
      .limit(INCOMING_QUERY_LIMIT)
      .get();

    const incoming = snap.docs
      /* Participation is re-checked rather than inferred from `calleeUid`. The two are
         written together and should agree; if they ever did not, this read must not be the
         place that hands a session to someone the participant list excludes. */
      .filter((d) => {
        const s = d.data();
        return Array.isArray(s.participants) && s.participants.includes(uid);
      })
      .map((d) => _project(d.id, d.data(), uid));

    return { incoming, count: incoming.length };
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   5. connectSignal — WebRTC SDP / ICE relay
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectSignal = onCall({ region: REGION, timeoutSeconds: 15 },
  exports._h.connectSignal = async (req) => {
    const uid = _uid(req);
    const d = req.data || {};
    const sessionId = _str(d.sessionId, 200);
    const kind = _str(d.kind, 16);
    if (!sessionId) throw new HttpsError('invalid-argument', 'sessionId required');
    if (!['offer', 'answer', 'candidate'].includes(kind)) {
      throw new HttpsError('invalid-argument', 'kind must be offer, answer or candidate');
    }
    /* Size-capped. An SDP is a few kilobytes; anything larger is not signalling. */
    const payload = typeof d.payload === 'string' ? d.payload : JSON.stringify(d.payload || null);
    if (!payload || payload.length > 16384) {
      throw new HttpsError('invalid-argument', 'payload missing or too large');
    }

    const db = _db();
    const ref = db.collection('connectSessions').doc(sessionId);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found');
    const s = snap.data();
    if (!Array.isArray(s.participants) || !s.participants.includes(uid)) {
      throw new HttpsError('permission-denied', 'You are not on this call');
    }
    if (CA.isTerminalState(String(s.status))) {
      throw new HttpsError('failed-precondition', 'This session is not open');
    }
    if (!Array.isArray(s.transportPlan) || !s.transportPlan.includes('webrtc')) {
      throw new HttpsError('failed-precondition', 'This session is not carried over WebRTC');
    }

    /* An ICE candidate can carry a host address but never a telephone number. The check is
       cheap and it is the one place a resolver could leak one into a relayed payload. */
    if (CA.findPhoneNumbers(payload).length) {
      throw new HttpsError('invalid-argument', 'Signalling payload must not contain a telephone number');
    }

    await ref.collection('signals').add({
      from: uid,
      to: s.participants.find((p) => p !== uid) || null,
      kind,
      payload,
      createdAt: _now(),
    });
    return { ok: true };
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   6. connectSetVideoGrant — the organisation's own permission
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectSetVideoGrant = onCall({ region: REGION, timeoutSeconds: 20 },
  exports._h.connectSetVideoGrant = async (req) => {
    const owner = _uid(req);
    const d = req.data || {};
    const memberUid = _str(d.memberUid, 128);
    const active = d.active === true;
    if (!memberUid) throw new HttpsError('invalid-argument', 'memberUid required');
    if (memberUid === owner) {
      throw new HttpsError('failed-precondition',
        'The subscriber already holds video — a self-grant would be a second authority for the same fact.');
    }

    /* Only an account whose OWN plan includes video may delegate it. A grant written by an
       account without the capability would sit in the collection looking authoritative and
       resolve to nothing — which is worse than a refusal, because it reads as a permission. */
    const capAuthority = require('./capability-authority');
    const r = await capAuthority.capabilitiesFor(owner, { hub: 'merchant' }).catch(() => null);
    if (!r || r.capabilities.videoCalling !== true) {
      throw new HttpsError('permission-denied', 'Your package does not include video calling');
    }

    const db = _db();
    await db.collection('connectVideoGrants').doc(_grantId(owner, memberUid)).set({
      ownerUid: owner,
      memberUid,
      active,
      updatedAt: _now(),
      updatedBy: owner,
    }, { merge: true });

    logger.info('[connect] video grant', { owner, memberUid, active });
    return { ok: true, memberUid, active };
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   7. connectRequestVerification — a platform admin opens a video verification
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectRequestVerification = onCall({ region: REGION, timeoutSeconds: 30 },
  exports._h.connectRequestVerification = async (req) => {
    const adminUid = _uid(req);
    if (!_isPlatformAdmin(req)) throw new HttpsError('permission-denied', 'Platform admin only');

    const d = req.data || {};
    const subjectUid = _str(d.subjectUid, 128);
    const reason = _str(d.reason, 64);
    const businessId = d.businessId ? _str(d.businessId, 128) : null;
    const applicationId = d.applicationId ? _str(d.applicationId, 128) : null;
    const notes = _str(d.notes, 2000);

    if (!subjectUid) throw new HttpsError('invalid-argument', 'subjectUid required');
    if (subjectUid === adminUid) {
      throw new HttpsError('failed-precondition', 'An admin cannot verify themselves');
    }

    /* The SAME authority every video session goes through. A verification is not a bypass —
       it is the PLATFORM branch of the one gate, and it still refuses a purpose that is not a
       named verification procedure. */
    const v = CA.resolveVideoAccess({ isPlatformAdmin: true, purpose: reason });
    if (!v.allowed) throw new HttpsError('permission-denied', `Video not permitted: ${v.reason}`);

    const db = _db();
    const subject = await db.collection('users').doc(subjectUid).get().catch(() => null);
    if (!subject || !subject.exists) throw new HttpsError('not-found', 'That account does not exist');

    /* Presence decides nothing here — an admin may open a verification against an account
       that is offline, and the transport plan simply says there is no route yet. The session
       is a request; the subject joins when they can. */
    const presence = await db.collection('presence').doc(subjectUid).get().catch(() => null);
    const online = !!(presence && presence.exists && presence.data() && presence.data().online === true);
    const transport = CA.selectTransport({
      channel: 'video', callerOnline: true, calleeOnline: online, providers: PROVIDERS,
    });

    const sessionRef = db.collection('connectSessions').doc();
    const verifyRef = db.collection('connectVerifications').doc();

    const session = CA.buildSessionRecord({
      now: _now(),
      sessionId: sessionRef.id,
      channel: 'video',
      mode: v.mode,                                   /* PLATFORM */
      callerUid: adminUid,
      calleeUid: subjectUid,
      relationship: 'support',
      anchorType: 'connectVerifications',
      anchorId: verifyRef.id,
      purpose: reason,
      transportPlan: transport.plan,
      status: CA.INITIAL_STATE,
      consumesEnterpriseEntitlement: v.consumesEnterpriseEntitlement,   /* false */
    });
    session.participants = [adminUid, subjectUid];
    session.roles = { admin: adminUid, buyer: subjectUid };
    session.verificationId = verifyRef.id;

    const verification = CA.buildVerificationRecord({
      now: _now(),
      verificationId: verifyRef.id,
      sessionId: sessionRef.id,
      subjectUid, businessId, applicationId,
      adminUid, reason, notes,
    });

    /* One batch: a verification record with no session, or a session with no verification,
       is a dangling half of a procedure. */
    const batch = db.batch();
    batch.create(sessionRef, session);
    batch.create(verifyRef, verification);
    await batch.commit();

    logger.info('[connect] verification opened', {
      verificationId: verifyRef.id, sessionId: sessionRef.id, reason, adminUid,
    });

    return {
      verificationId: verifyRef.id,
      sessionId: sessionRef.id,
      reason,
      subjectHandle: CA.endpointHandleFor(subjectUid),
      transportPlan: transport.plan,
      notConfigured: transport.notConfigured,
      /* Said in the response, not only in the docs: the caller is an admin console and this
         is what it must show the operator. */
      consentRequired: true,
      recording: 'DISABLED',
      isProofOfIdentity: false,
    };
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   8. connectRecordVerificationOutcome — what the admin OBSERVED
══════════════════════════════════════════════════════════════════════════════════════════ */
exports.connectRecordVerificationOutcome = onCall({ region: REGION, timeoutSeconds: 20 },
  exports._h.connectRecordVerificationOutcome = async (req) => {
    const adminUid = _uid(req);
    if (!_isPlatformAdmin(req)) throw new HttpsError('permission-denied', 'Platform admin only');

    const d = req.data || {};
    const verificationId = _str(d.verificationId, 200);
    const result = _str(d.result, 32);
    const notes = _str(d.notes, 2000);
    const docs = Array.isArray(d.documentsReferenced)
      ? d.documentsReferenced.slice(0, 20).map((x) => _str(x, 200)).filter(Boolean) : [];

    if (!verificationId) throw new HttpsError('invalid-argument', 'verificationId required');
    if (!CA.VERIFICATION_RESULTS.includes(result)) {
      throw new HttpsError('invalid-argument',
        `result must be one of: ${CA.VERIFICATION_RESULTS.join(', ')}`);
    }

    const db = _db();
    const ref = db.collection('connectVerifications').doc(verificationId);

    return db.runTransaction(async (t) => {
      const snap = await t.get(ref);
      if (!snap.exists) throw new HttpsError('not-found', 'Verification not found');
      const v = snap.data();
      if (v.sessionOutcome) {
        /* An outcome is recorded ONCE. Re-deciding in place would erase what the first
           reviewer observed, which is the part a later audit needs most. */
        throw new HttpsError('failed-precondition',
          'An outcome is already recorded for this verification');
      }

      /* ── THE BOUNDARY THIS FUNCTION EXISTS TO HOLD ────────────────────────────────────────
         It writes the SESSION OUTCOME and nothing else. It does not touch
         providerVerification, does not set `official`, `verified`, `faceVerified` or
         `documentsVerified`, and does not grant a role. A video call is evidence a human
         reviewer weighs; the platform rule is that an official identity needs a passed
         identity check, a passed face check AND a completed human review, and `approved`
         alone is never sufficient. Making this function grant anything would collapse all
         four into "an admin was on a video call", which is exactly the shortcut the rule
         forbids. The certification suite asserts the absence of every such write. */
      t.update(ref, {
        sessionOutcome: result,
        notes: notes || v.notes || '',
        documentsReferenced: docs.length ? docs : (v.documentsReferenced || []),
        decidedBy: adminUid,
        decidedAt: _now(),
        endedAt: _now(),
        updatedAt: _now(),
      });

      logger.info('[connect] verification outcome recorded', { verificationId, result, adminUid });
      return {
        verificationId,
        sessionOutcome: result,
        /* Restated on every response so a console cannot render this as a grant. */
        isProofOfIdentity: false,
        authority: 'providerVerification',
      };
    });
  });

/* ══════════════════════════════════════════════════════════════════════════════════════════
   9. connectExpireStaleSessions — the writer for `expired`

   A state with no writer is a dead entry that reads as a guarantee. `expired` is the only
   transition the table gives to `server`, and this is the server: a session nobody answered
   must not sit in `authorized` or `ringing` for ever, because a client reading it later would
   render a live call that ended in silence hours ago.

   NOT dispatchable — onSchedule is event-triggered and is exported by name from index.js.
══════════════════════════════════════════════════════════════════════════════════════════ */
const { onSchedule } = require('firebase-functions/v2/scheduler');

/* Generous, and deliberately so: a rider putting a phone in a pocket for ten minutes is a
   normal missed call, not a stale record. This window is about records that will never be
   acted on, not about how long a phone should ring. */
const STALE_MINUTES = 30;

exports.connectExpireStaleSessions = onSchedule(
  { region: REGION, schedule: 'every 15 minutes', timeoutSeconds: 120 },
  async () => {
    const db = _db();
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - STALE_MINUTES * 60000);

    /* Only the two pre-media states can expire. `accepted`, `connecting` and `connected` are
       deliberately excluded: a call that reached any of them did happen, and recording it as
       "expired" would erase that. Those end via `ended` or `failed`. */
    const expirable = ['authorized', 'ringing'];
    let swept = 0, refused = 0;

    for (const from of expirable) {
      const snap = await db.collection('connectSessions')
        .where('status', '==', from)
        .where('createdAt', '<', cutoff)
        .limit(200)
        .get()
        .catch(() => null);
      if (!snap || snap.empty) continue;

      for (const doc of snap.docs) {
        /* The sweep obeys the SAME table every client does. It is not privileged to skip it —
           if the machine ever stops permitting this edge, the sweep stops taking it. */
        const move = CA.canTransition({ from, to: 'expired', actor: 'server' });
        if (!move.ok) { refused++; continue; }
        await doc.ref.update({
          status: 'expired',
          endedAt: _now(),
          updatedAt: _now(),
          expiredBy: 'connectExpireStaleSessions',
        }).catch(() => { refused++; });
        swept++;
      }
    }

    logger.info('[connect] stale session sweep', { swept, refused, staleMinutes: STALE_MINUTES });
    return null;
  });

/* Exported for the certification suite and for callers that need the same vocabulary. */
exports._internals = {
  PROVIDERS, ANCHORS, _stateOf, _sellerOfOrder, _resolveRelationship, _grantId,
  LIVE_ORDER_STATES, CLOSED_ORDER_STATES, CANCELLED_STATES,
  /* C3-B. `_project` is exported so the suite can DRIVE it with a session document rather
     than grep for its fields, and `INCOMING_STATES` so the derivation itself is testable
     against the authority instead of being taken on trust. */
  _project, INCOMING_STATES, ANSWERING_DESTINATIONS, INCOMING_QUERY_LIMIT,
};
