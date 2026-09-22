'use strict';
/**
 * SOKONI Connect — the communication authority.
 * ============================================================================================
 * ONE pure module answering three questions that must never be answered in a UI:
 *
 *     1. may these two parties communicate at all, and on which channel?
 *     2. may this caller open a VIDEO session, and under whose authority?
 *     3. which transport should carry the session — and which must never be offered?
 *
 * ── WHY THIS IS NOT PART OF messages.js ────────────────────────────────────────────────────
 * The deployed `createConversation` takes `participantUids` from `req.data` and guards only
 * with `participantUids.includes(uid)` — naming yourself is not entitlement, so a caller can
 * record an arbitrary uid as a participant (docs/B931_GATE_MESSAGES_PARTICIPANT_AUTHORITY.md).
 * That defect is repaired on the release line and LIVE in production on this one.
 *
 * A calling layer built on top of that would inherit it and make it worse: a wrong chat
 * participant is a message in the wrong inbox; a wrong CALL participant is a stranger's phone
 * ringing. So Connect never asks the conversation layer who the parties are. The caller-facing
 * functions resolve parties from the ANCHOR DOCUMENT (the order, booking, delivery or supply
 * relationship) and hand this module a relationship it has already established. A
 * client-supplied party list is not merely also-checked here — there is no parameter for one.
 *
 * ── PURITY ─────────────────────────────────────────────────────────────────────────────────
 * No Firestore, no clock, no network, no environment. Every input is an argument and every
 * output is a value, so the whole authority is testable without an emulator and cannot behave
 * one way in a test and another in production. `buildSessionRecord` takes `now` as an
 * argument for exactly this reason.
 *
 * ── CAPABILITY IS NOT AUTHORITY ────────────────────────────────────────────────────────────
 * `capabilities.videoCalling` says what a PLAN permits. It never says who someone is.
 * Platform-admin verification authority is NOT purchasable and is not a capability key — it
 * arrives as `isPlatformAdmin`, decided by a custom claim, and an Enterprise subscription can
 * never produce it. The two are resolved on separate branches below and a failure of one must
 * never fall through to the other.
 */

/* ── Vocabulary ────────────────────────────────────────────────────────────────────────────
 * Roles are POSITIONS IN A RELATIONSHIP, not account types. The same account is `seller` to
 * its buyer and `buyer` to its supplier; encoding that as an account attribute is how a
 * permission matrix ends up granting a merchant the right to call anyone who ever sold
 * anything. */
const ROLES = Object.freeze(['buyer', 'seller', 'provider', 'rider', 'supplier', 'admin']);

/** Channels, weakest to strongest. Strength is not decorative — `video` is gated on a
 *  separate authority entirely and must never be reachable by relaxing a `voice` rule. */
const CHANNELS = Object.freeze(['chat', 'voice', 'video']);

/* ── Relationship kinds ───────────────────────────────────────────────────────────────────
 * Each names the pairs it authorises. A pair absent from `pairs` is DENIED — the matrix is a
 * whitelist, so a new relationship kind grants nothing until someone writes its pairs down.
 *
 * `pairs` are UNORDERED: `buyer:seller` authorises the seller to call the buyer too. Calling
 * is symmetric in a business relationship; one-directional calling would mean a buyer could
 * raise a problem and the seller could not answer it. */
const RELATIONSHIPS = Object.freeze({
  order: Object.freeze({
    describe: 'A paid or pending order binds its buyer and the seller of its line items',
    pairs: Object.freeze(['buyer:seller']),
  }),
  inquiry: Object.freeze({
    describe: 'A pre-purchase enquiry against a published listing',
    /* Voice is DELIBERATELY withheld. An enquiry is self-asserted — anyone may open one
       against any public listing — so granting voice would make every seller's phone
       reachable by every visitor, which is the outcome this module exists to prevent.
       An order or booking upgrades the same pair to voice. */
    pairs: Object.freeze(['buyer:seller']),
    channelCeiling: 'chat',
  }),
  booking: Object.freeze({
    describe: 'A service booking binds its customer and the provider',
    pairs: Object.freeze(['buyer:provider']),
  }),
  delivery: Object.freeze({
    describe: 'An assigned delivery binds the rider to both ends of the job',
    pairs: Object.freeze(['rider:buyer', 'rider:seller']),
  }),
  supply: Object.freeze({
    describe: 'A supplier relationship binds a merchant to its supplier',
    pairs: Object.freeze(['seller:supplier']),
  }),
  support: Object.freeze({
    describe: 'An open support case binds a platform admin to the account it concerns',
    pairs: Object.freeze([
      'admin:buyer', 'admin:seller', 'admin:provider', 'admin:rider', 'admin:supplier',
    ]),
  }),
});

/* ── Relationship states ──────────────────────────────────────────────────────────────────
 * A relationship that has ended keeps its history but loses its telephone.
 *
 * `closed` permitting chat and refusing voice is a decision, not an oversight: a buyer must be
 * able to re-read what was agreed on a finished order, and must not be able to ring the seller
 * about it a year later. Anything not listed here is DENIED — an unrecognised state is not a
 * live relationship, and failing open on a state nobody has defined is how a cancelled order
 * keeps its call button. */
const STATES = Object.freeze({
  active:    Object.freeze({ ceiling: 'video' }),   /* video still needs its own authority */
  closed:    Object.freeze({ ceiling: 'chat'  }),
  cancelled: Object.freeze({ ceiling: 'chat'  }),
  blocked:   Object.freeze({ ceiling: null    }),   /* nothing, including chat */
});

/** Verification purposes a platform admin may open a video session for. A purpose outside this
 *  list is refused even for an admin — "admin" is an authority to conduct a named business
 *  procedure, not a general licence to switch on someone's camera. */
const VERIFICATION_PURPOSES = Object.freeze([
  'identity_verification',
  'business_verification',
  'merchant_verification',
  'rider_verification',
  'supplier_verification',
  'support_escalation',
]);

/** Purposes an Enterprise subscriber may open a video session for. */
const ENTERPRISE_VIDEO_PURPOSES = Object.freeze([
  'business_meeting',
  'supplier_meeting',
  'enterprise_support',
  'operational_coordination',
  'remote_assistance',
]);

/* Pairs are compared in a canonical (alphabetical) order so `rider:buyer` and `buyer:rider`
   are the same fact. NORMALISED RATHER THAN DECLARED SORTED on purpose: the declarations are
   written to be read — `rider:buyer` says "the rider calls the buyer" — and requiring authors
   to alphabetise them is a rule that will be forgotten exactly once, silently dropping a pair
   from the matrix. It was: the first draft declared `rider:buyer` and the delivery pair simply
   did not resolve, which the suite's positive control caught. */
const _pairKey = (a, b) => [a, b].sort().join(':');
const _hasPair = (rel, a, b) => rel.pairs.some((p) => p.split(':').sort().join(':') === _pairKey(a, b));
const _rank = (ch) => CHANNELS.indexOf(ch);

/**
 * mayCommunicate({ from, to, relationship, state, channel }) -> { allowed, reason }
 *
 * The relationship is an ESTABLISHED FACT supplied by the caller-facing function, which read
 * it from an anchor document. This function decides what that fact permits. It never decides
 * whether the fact is true — that is a Firestore question and this module has no Firestore.
 *
 * FAILS CLOSED on every unknown: unknown role, unknown relationship, unknown state, unknown
 * channel, missing argument, self-call.
 */
function mayCommunicate(input) {
  const i = input || {};
  const from = String(i.from || '');
  const to = String(i.to || '');
  const kind = String(i.relationship || '');
  const state = String(i.state || '');
  const channel = String(i.channel || '');

  if (!ROLES.includes(from)) return _deny('unknown_from_role');
  if (!ROLES.includes(to)) return _deny('unknown_to_role');
  if (from === to) return _deny('self_pair');
  if (!CHANNELS.includes(channel)) return _deny('unknown_channel');

  const rel = Object.hasOwn(RELATIONSHIPS, kind) ? RELATIONSHIPS[kind] : null;
  if (!rel) return _deny('unknown_relationship');

  const st = Object.hasOwn(STATES, state) ? STATES[state] : null;
  if (!st) return _deny('unknown_state');
  if (!st.ceiling) return _deny('relationship_blocked');

  if (!_hasPair(rel, from, to)) return _deny('pair_not_in_relationship');

  /* VIDEO IS NEVER GRANTED HERE. The matrix can only ever say that the pair and the state do
     not RULE OUT video; resolveVideoAccess decides whether it is permitted. Returning
     `allowed` for video from this function alone would make the whole restriction a matter of
     which function a future caller happened to reach for. */
  if (channel === 'video') {
    return { allowed: false, reason: 'video_requires_separate_authority' };
  }

  if (_rank(channel) > _rank(st.ceiling)) return _deny('channel_above_state_ceiling');
  if (rel.channelCeiling && _rank(channel) > _rank(rel.channelCeiling)) {
    return _deny('channel_above_relationship_ceiling');
  }

  return { allowed: true, reason: 'relationship_permits' };
}

function _deny(reason) { return { allowed: false, reason }; }

/**
 * resolveVideoAccess({ isPlatformAdmin, capabilities, orgGrant, purpose, relationship })
 *   -> { allowed, mode, consumesEnterpriseEntitlement, reason }
 *
 * Two authorities, resolved on separate branches:
 *
 *   PLATFORM    a platform admin conducting a named verification procedure. Not purchasable,
 *               not an Enterprise feature, and it does NOT consume an Enterprise entitlement —
 *               a merchant's plan must not be billed for SOKONI verifying that merchant.
 *
 *   ENTERPRISE  an account on the Enterprise package whose ORGANISATION has granted this
 *               member the video permission. The subscription is necessary and not sufficient:
 *               buying Enterprise must not hand a camera to every employee, so the org
 *               administrator's grant is a second, independent condition.
 *
 * A caller who fails the Enterprise branch is NOT re-tried against the platform branch, and a
 * non-admin never reaches it. `isPlatformAdmin` is a decided claim, never a plan attribute.
 */
function resolveVideoAccess(input) {
  const i = input || {};
  const purpose = String(i.purpose || '');
  const isPlatformAdmin = i.isPlatformAdmin === true;

  /* ── Platform verification ─────────────────────────────────────────────────────────────
     Checked first because it is the narrower authority and cannot be reached by accident: it
     requires a claim no subscription can produce. */
  if (isPlatformAdmin) {
    if (!VERIFICATION_PURPOSES.includes(purpose)) {
      return _videoDeny('purpose_not_a_verification_procedure');
    }
    return {
      allowed: true,
      mode: 'PLATFORM',
      consumesEnterpriseEntitlement: false,
      reason: 'platform_verification',
    };
  }

  /* ── Enterprise business video ─────────────────────────────────────────────────────────
     `capabilities.videoCalling` is resolved by capability-authority from the live
     subscription. `=== true` is deliberate: a missing key, a string, or an unreadable
     subscription (which returns the unsubscribed floor) must all read as NO. */
  const caps = i.capabilities || {};
  if (caps.videoCalling !== true) return _videoDeny('plan_does_not_include_video');
  if (i.orgGrant !== true) return _videoDeny('organisation_has_not_granted_video');
  if (!ENTERPRISE_VIDEO_PURPOSES.includes(purpose)) return _videoDeny('purpose_not_permitted');

  /* An Enterprise plan still does not create a right to call a stranger. The pair must stand
     in a business relationship, exactly as voice does. */
  const rel = i.relationship || {};
  const pairOk = mayCommunicate({
    from: rel.from, to: rel.to, relationship: rel.kind, state: rel.state, channel: 'voice',
  });
  if (!pairOk.allowed) return _videoDeny('no_business_relationship:' + pairOk.reason);

  return {
    allowed: true,
    mode: 'ENTERPRISE',
    consumesEnterpriseEntitlement: true,
    reason: 'enterprise_video',
  };
}

function _videoDeny(reason) {
  return { allowed: false, mode: null, consumesEnterpriseEntitlement: false, reason };
}

/* ── Transport selection ──────────────────────────────────────────────────────────────────
 * The application asks for a SESSION; it never asks for a transport. The adapter decides.
 *
 * NOTHING HERE MAKES A CALL WORK. This function returns a PLAN — an ordered list of transports
 * that are configured and applicable. A transport that has no provisioned provider is reported
 * as NOT_CONFIGURED and is never placed in the plan, because a plan naming a route that cannot
 * carry traffic is indistinguishable, to every caller, from one that can. */
const TRANSPORTS = Object.freeze(['webrtc', 'pstn']);

/**
 * selectTransport({ channel, callerOnline, calleeOnline, providers })
 *   -> { plan: string[], fallbackAvailable, notConfigured: string[], reason }
 *
 * `providers` declares what is actually provisioned, e.g. `{ webrtc: true, pstn: false }`.
 * It is supplied by the caller-facing function from configuration; this module never reads an
 * environment variable, so a test cannot accidentally certify a route against a real provider.
 */
function selectTransport(input) {
  const i = input || {};
  const channel = String(i.channel || '');
  const providers = i.providers || {};
  const configured = TRANSPORTS.filter((t) => providers[t] === true);
  const notConfigured = TRANSPORTS.filter((t) => providers[t] !== true);

  if (!CHANNELS.includes(channel) || channel === 'chat') {
    return { plan: [], fallbackAvailable: false, notConfigured, reason: 'not_a_call_channel' };
  }

  const plan = [];
  /* Internet first: it is cheaper, it carries video, and it keeps the session inside the
     platform where its business context lives. */
  if (configured.includes('webrtc') && i.callerOnline === true && i.calleeOnline === true) {
    plan.push('webrtc');
  }

  /* PSTN CANNOT CARRY VIDEO. Offering it as a video fallback would degrade a video
     verification into an audio call while still reporting the session as video — the
     verification would then rest on a camera that was never switched on. */
  if (channel === 'voice' && configured.includes('pstn')) {
    plan.push('pstn');
  }

  return {
    plan,
    fallbackAvailable: plan.includes('pstn'),
    notConfigured,
    reason: plan.length ? 'route_available' : 'no_route',
  };
}

/* ── Endpoint privacy ─────────────────────────────────────────────────────────────────────
 * A SOKONI call is placed between two uids. The telephone number, where one is needed at all,
 * is resolved inside the telephony adapter and never travels through a session record, a
 * client payload, a log line or a notification.
 *
 * Partial masking was considered and rejected: the last four digits of a Kenyan mobile are
 * enough to confirm a number someone already suspects, and the platform has no reason to
 * publish any of it. */
const _E164 = /\+?\d[\d\s().-]{7,}\d/g;

/** An opaque, stable handle for a party. Derived from the uid alone: it carries no number, and
 *  it is not a secret — knowing it grants nothing without a live session. */
function endpointHandleFor(uid) {
  const u = String(uid || '').trim();
  if (!u) return null;
  return 'ep_' + u;
}

/**
 * findPhoneNumbers(value) -> string[]
 *
 * Runtime defence, not only a test helper: the session writer runs this over anything it is
 * about to persist. A leak found here is a refusal, never a redaction — silently stripping a
 * number would hide the code path that produced it.
 */
function findPhoneNumbers(value) {
  const found = [];
  const walk = (v) => {
    if (v === null || v === undefined) return;
    if (typeof v === 'string') {
      const m = v.match(_E164);
      if (m) found.push(...m.map((s) => s.trim()));
      return;
    }
    if (typeof v !== 'object') return;
    if (Array.isArray(v)) { v.forEach(walk); return; }
    Object.keys(v).forEach((k) => { walk(k); walk(v[k]); });
  };
  walk(value);
  return found;
}

/* ── The session record ───────────────────────────────────────────────────────────────────
 * METADATA ONLY. No audio, no video, no transcript.
 *
 * `recording: 'DISABLED'` is written as a literal on every record rather than omitted, so a
 * record that does NOT say DISABLED is detectable. An absent field would be indistinguishable
 * from an old record written before recording existed. If recording is ever built, it becomes
 * a separate, consented, retention-governed feature and this literal is what a reader checks. */
function buildSessionRecord(input) {
  const i = input || {};
  const now = i.now;
  if (!now) throw new Error('connect-authority: buildSessionRecord requires an explicit `now`');

  const record = {
    sessionId: String(i.sessionId || ''),
    channel: String(i.channel || ''),
    mode: i.mode || null,                       /* PLATFORM | ENTERPRISE | null for voice/chat */
    callerUid: String(i.callerUid || ''),
    calleeUid: String(i.calleeUid || ''),
    callerHandle: endpointHandleFor(i.callerUid),
    calleeHandle: endpointHandleFor(i.calleeUid),
    /* Business context is the point of the whole module: a SOKONI call is always ABOUT
       something, and the record says what. */
    context: {
      relationship: String(i.relationship || ''),
      anchorType: String(i.anchorType || ''),
      anchorId: String(i.anchorId || ''),
      purpose: String(i.purpose || ''),
    },
    transportPlan: Array.isArray(i.transportPlan) ? i.transportPlan.slice() : [],
    transportUsed: i.transportUsed || null,
    status: String(i.status || 'requested'),
    recording: 'DISABLED',
    consumesEnterpriseEntitlement: i.consumesEnterpriseEntitlement === true,
    createdAt: now,
    updatedAt: now,
  };

  /* REFUSE, do not redact. A number reaching this point means some resolver put one in a
     context field, and that path must be fixed rather than papered over. */
  const leaked = findPhoneNumbers(record);
  if (leaked.length) {
    throw new Error('connect-authority: refusing to build a session record containing a telephone number');
  }
  return record;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE SESSION STATE MACHINE

   Built BEFORE the calling client, deliberately. A UI that decides its own state becomes a
   second authority, and the first thing it will get wrong is the one that matters: a client
   that can move a session straight to `connected` has invented a call that no one answered.

   So the server owns every transition, and this table is the only place they are written
   down. The client renders a state it was GIVEN; it never chooses one.

       authorized ──► ringing ──► accepted ──► connecting ──► connected ──► ended
            │            │            │             │              │
            │            ├─► declined │             │              │
            ├────────────┴────────────┴─────────────┴──────────────┴──► cancelled / failed
            └─► expired  ◄── ringing

   TWO DEPARTURES FROM THE PROPOSED LIST, both deliberate:

   1. `requested` DOES NOT EXIST, and its absence is a property worth having. Authorization
      happens BEFORE the document is created — connectRequestSession resolves the anchor,
      checks the matrix or the video authority, and only then writes. There is therefore no
      moment at which a session exists and is not authorized. A separate `requested` state
      would be occupied by nothing, and a state no session is ever in is a dead entry that
      reads as a guarantee. `authorized` IS the initial state.

   2. `abandoned` and `inconclusive` are NOT session states. They are VERIFICATION OUTCOMES
      (VERIFICATION_RESULTS below) and they answer a different question: not "what happened to
      the call" but "what did the admin observe". Making one word mean both is precisely how
      an evidence record starts being read as a decision — the same reason the stored field is
      `sessionOutcome` and not `verificationStatus`. A verification whose call was cancelled
      has session state `cancelled` and outcome `abandoned`, and those are two separate facts.
══════════════════════════════════════════════════════════════════════════════════════════ */

/* Who may perform a transition. `server` means no client may — it is a scheduled sweep or a
   server-side decision, and naming it here stops a future callable from quietly offering it. */
/* Two vocabularies that were conflated in the first draft, and the conflation was a latent
   defect: `ACTORS` held both the three parties who can ACT and the set-names an edge may be
   declared with, so `actor: 'either'` passed the unknown-actor check and was only refused
   further down by luck of the branch order. They are separate concepts and are now separate
   lists — an incoming actor is validated against ACTOR_NAMES, a table edge against
   ACTOR_SPECS. */
const ACTOR_NAMES = Object.freeze(['caller', 'callee', 'server']);
const ACTOR_SPECS = Object.freeze(['caller', 'callee', 'server', 'either', 'callee_or_server']);

const INITIAL_STATE = 'authorized';

const SESSION_STATES = Object.freeze({
  authorized: Object.freeze({
    describe: 'The server authorized the call and created the session. Nobody has been rung yet.',
    /* `ringing` is taken by the CALLEE **or** the server, and the pair is the point.
       The server takes it when the notification dispatcher has successfully handed the call
       to a push transport — that is the moment the platform has done everything it can to
       make a phone ring, and the caller deserves to see it. The callee's device takes it when
       it is actually alerting, which is the stronger evidence.
       Neither alone is sufficient: server-only would overclaim (a push accepted by FCM is not
       a phone ringing), and callee-only would strand every session whose app is asleep, with
       the caller unable to tell "not delivered" from "not answered". The session records
       WHICH evidence moved it, so the two are never confused.
       It grants nothing either way: `accepted` still needs the callee, and still needs
       consent. */
    to: Object.freeze({
      ringing: 'callee_or_server', cancelled: 'caller', expired: 'server', failed: 'either',
    }),
  }),
  ringing: Object.freeze({
    describe: 'The called party has been notified.',
    to: Object.freeze({
      accepted: 'callee', declined: 'callee', cancelled: 'caller',
      expired: 'server', failed: 'either',
    }),
  }),
  accepted: Object.freeze({
    describe: 'The called party agreed — and, for video, gave consent.',
    to: Object.freeze({ connecting: 'either', cancelled: 'either', failed: 'either' }),
  }),
  connecting: Object.freeze({
    describe: 'Transport negotiation is in flight. No media yet.',
    to: Object.freeze({ connected: 'either', cancelled: 'either', failed: 'either' }),
  }),
  connected: Object.freeze({
    describe: 'Media is flowing.',
    /* NOT to `cancelled`: a call that connected and then stopped ENDED. Cancelling something
       that already happened would erase the fact that the two parties spoke. */
    to: Object.freeze({ ended: 'either', failed: 'either' }),
  }),
  /* ── Terminal ─────────────────────────────────────────────────────────────────────────── */
  ended: Object.freeze({ describe: 'The call took place and finished.', to: Object.freeze({}) }),
  declined: Object.freeze({ describe: 'The called party refused.', to: Object.freeze({}) }),
  cancelled: Object.freeze({ describe: 'Withdrawn before any media.', to: Object.freeze({}) }),
  expired: Object.freeze({ describe: 'Nobody acted within the window.', to: Object.freeze({}) }),
  failed: Object.freeze({ describe: 'Transport or negotiation failed.', to: Object.freeze({}) }),
});

const TERMINAL_STATES = Object.freeze(
  Object.keys(SESSION_STATES).filter((s) => Object.keys(SESSION_STATES[s].to).length === 0));

function isTerminalState(state) {
  return TERMINAL_STATES.includes(String(state || ''));
}

/** What a client may legitimately offer from here. Given to the UI so it renders the machine
 *  rather than guessing at it — and so a button that cannot possibly work is never drawn. */
function nextStates(from) {
  const s = SESSION_STATES[String(from || '')];
  return s ? Object.keys(s.to) : [];
}

/**
 * canTransition({ from, to, actor, channel, consentAcknowledged }) -> { ok, reason }
 *
 * FAILS CLOSED on every unknown, and on every edge the table does not contain. The table is a
 * whitelist: `authorized -> connected` is not "missing", it is refused, because a call that
 * nobody answered must never be recorded as one that connected.
 */
function canTransition(input) {
  const i = input || {};
  const from = String(i.from || '');
  const to = String(i.to || '');
  const actor = String(i.actor || '');

  if (!Object.hasOwn(SESSION_STATES, from)) return _denyTransition('unknown_from_state');
  if (!Object.hasOwn(SESSION_STATES, to)) return _denyTransition('unknown_to_state');
  if (!ACTOR_NAMES.includes(actor)) return _denyTransition('unknown_actor');
  if (from === to) return _denyTransition('no_op_transition');
  if (isTerminalState(from)) return _denyTransition('session_already_terminal');

  const allowedActor = SESSION_STATES[from].to[to];
  if (!allowedActor) return _denyTransition('transition_not_permitted');

  /* `either` admits caller and callee but NEVER `server` — a sweep must not be able to answer
     a call on someone's behalf. A `server` edge admits only `server`. */
  if (allowedActor === 'server') {
    if (actor !== 'server') return _denyTransition('server_only_transition');
  } else if (allowedActor === 'either') {
    /* Participants only — NEVER the server. A sweep must not answer a call for someone. */
    if (actor !== 'caller' && actor !== 'callee') return _denyTransition('participants_only_transition');
  } else if (allowedActor === 'callee_or_server') {
    if (actor !== 'callee' && actor !== 'server') return _denyTransition('callee_or_server_only');
  } else if (actor !== allowedActor) {
    return _denyTransition(`only_the_${allowedActor}_may_do_that`);
  }

  /* Consent is checked HERE rather than at the call site, so it cannot be forgotten by a new
     path that reaches `accepted` some other way. */
  if (to === 'accepted') {
    const consent = evaluateConsent({ channel: i.channel, acknowledged: i.consentAcknowledged });
    if (!consent.ok) return _denyTransition(consent.reason);
  }

  return { ok: true, reason: 'permitted' };
}

/* Shared shape with mayCommunicate's denials would be misleading — that one answers "may they
   talk", this one "may this transition happen". Kept separate so a caller cannot read one as
   the other. */
function _denyTransition(reason) { return { ok: false, reason }; }

/* ══════════════════════════════════════════════════════════════════════════════════════════
   MEDIA EVENTS — the client OBSERVES, the authority DECIDES

   The rule this section exists to make unbreakable:

       a WebRTC client must never be able to write `connected` because it happened to
       construct an RTCPeerConnection.

   Documenting that would not hold it. So the client-facing surface simply has no way to name
   `connecting`, `connected` or `failed` as a destination — those ops do not exist. What the
   client can do is REPORT WHAT ITS MEDIA STACK OBSERVED, and this table decides what, if
   anything, that observation means for the session.

       WebRTC                          Connect authority
       ──────                          ─────────────────
       negotiation started   ────►     intends `connecting`
       ICE connected         ────►     intends nothing — recorded only
       media flowing         ────►     intends `connected`
       ICE disconnected      ────►     intends nothing — recorded only
       connection failed     ────►     intends `failed`
                                              │
                                              ▼
                                       canTransition() still decides

   TWO LAYERS, BOTH FAIL CLOSED. An event maps to an INTENDED destination; the state table
   then rules on whether that move is legal from where the session actually is. So a client
   reporting `media_flowing` while the session is still `accepted` does not skip `connecting`
   — the table refuses it, exactly as it refuses every other shortcut.

   ── USER INTENTIONS ARE NOT MEDIA EVENTS ───────────────────────────────────────────────────
   `accept`, `decline`, `cancel`, `end` and `ringing` remain destination ops, because they are
   things a PERSON did, not things a media stack saw. Pressing Decline is an intention; ICE
   failing is an observation. Conflating them is how "the connection dropped" would become
   indistinguishable from "they hung up on me".

   Nothing maps to `ended` on purpose. A call ends because somebody hung up — that is an
   intention, reported through connectEndSession. Media merely stopping is `failed`, and the
   difference is the whole point of keeping both.
══════════════════════════════════════════════════════════════════════════════════════════ */

const MEDIA_EVENTS = Object.freeze({
  negotiation_started: Object.freeze({
    describe: 'The peer connection is being negotiated (offer/answer exchange has begun)',
    intends: 'connecting',
  }),
  ice_connected: Object.freeze({
    describe: 'ICE reached a connected pair — a route exists, but no media has been seen yet',
    /* DELIBERATELY NOT `connected`. An ICE pair is a route, not a conversation; treating it as
       arrival is precisely the mistake of calling a session connected because an
       RTCPeerConnection was constructed. Recorded, because it is useful when diagnosing a call
       that found a route and still carried nothing. */
    intends: null,
    records: 'iceConnectedAt',
  }),
  media_flowing: Object.freeze({
    describe: 'Media is actually being received',
    intends: 'connected',
  }),
  ice_disconnected: Object.freeze({
    describe: 'The ICE route dropped — it may recover',
    /* Not a failure yet. A transient ICE drop that recovers is normal on mobile data, and
       ending a call on it would hang up on people crossing a cell boundary. */
    intends: null,
    records: 'iceDisconnectedAt',
  }),
  media_stopped: Object.freeze({
    describe: 'Media was flowing and stopped',
    /* NOT `ended`, and not `failed`. Media stopping is ambiguous by nature — a muted track, a
       backgrounded tab, a tunnel — and the two things it might mean are already covered by an
       intention (`ended`, somebody hung up) and by an explicit observation
       (`connection_failed`). Guessing between them here would put a reason on a call that
       nobody actually gave. Recorded, so a call that went silent before either party acted is
       visible afterwards. */
    intends: null,
    records: 'mediaStoppedAt',
  }),
  connection_failed: Object.freeze({
    describe: 'Negotiation or transport failed and will not recover',
    intends: 'failed',
  }),
});

const MEDIA_EVENT_NAMES = Object.freeze(Object.keys(MEDIA_EVENTS));

/* Which states a PERSON may ask for, and which are reached only by observing media. The split
   is not cosmetic: it is what `connectGetSessionState` filters on, so a UI is never told to
   offer a destination that has no op behind it. A button the server cannot honour is worse
   than a missing one — it teaches the operator that the console lies. */
const MEDIA_DRIVEN_STATES = Object.freeze(
  [...new Set(MEDIA_EVENT_NAMES.map((e) => MEDIA_EVENTS[e].intends).filter(Boolean))]);
const INTENTION_STATES = Object.freeze(
  Object.keys(SESSION_STATES).filter((s) => !MEDIA_DRIVEN_STATES.includes(s)));

/** Is this a state a client may name as a destination? */
function isIntentionState(state) {
  return INTENTION_STATES.includes(String(state || ''));
}

/** The media events worth reporting from here — so a client knows what the server will act on
 *  rather than firing every RTCPeerConnection callback at it. */
function reportableEvents(from) {
  return MEDIA_EVENT_NAMES.filter((e) => {
    const v = interpretMediaEvent({ from, event: e, actor: 'caller' });
    return v.effect === 'transition' || v.effect === 'recorded_only';
  });
}

/**
 * interpretMediaEvent({ event, from, actor }) -> {
 *   recognised, intends, effect, transition, records, reason
 * }
 *
 * `effect` is one of:
 *   'recorded_only'  an observation with no state meaning (ICE progress)
 *   'ignored'        the session is already there, or is already terminal
 *   'transition'     the table permits the move
 *   'refused'        the table refuses it
 *
 * IGNORED IS NOT AN ERROR. Media events race and repeat: a duplicate `media_flowing` on an
 * already-connected session, or a `connection_failed` arriving after both parties hung up, are
 * normal and must not fail a client into a retry loop. A genuine SKIP is different and is
 * refused — the distinction is `from === intends` (idempotent) versus the table saying no.
 */
function interpretMediaEvent(input) {
  const i = input || {};
  const event = String(i.event || '');
  const from = String(i.from || '');
  const actor = String(i.actor || '');

  const spec = Object.hasOwn(MEDIA_EVENTS, event) ? MEDIA_EVENTS[event] : null;
  if (!spec) {
    return { recognised: false, intends: null, effect: 'refused', transition: null,
      records: null, reason: 'unknown_media_event' };
  }
  if (!Object.hasOwn(SESSION_STATES, from)) {
    return { recognised: true, intends: spec.intends, effect: 'refused', transition: null,
      records: null, reason: 'unknown_from_state' };
  }

  const base = { recognised: true, intends: spec.intends, records: spec.records || null };

  /* A terminal session absorbs late media events without complaint and without change. */
  if (isTerminalState(from)) {
    return { ...base, effect: 'ignored', transition: null, reason: 'session_already_terminal' };
  }
  if (!spec.intends) {
    return { ...base, effect: 'recorded_only', transition: null, reason: 'observation_only' };
  }
  if (from === spec.intends) {
    return { ...base, effect: 'ignored', transition: null, reason: 'already_in_that_state' };
  }

  const transition = canTransition({ from, to: spec.intends, actor });
  return {
    ...base,
    effect: transition.ok ? 'transition' : 'refused',
    transition,
    reason: transition.reason,
  };
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   VIDEO VERIFICATION — consent, and the outcome of a session
══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * A video session must not connect until the called party has been told what will happen and
 * has accepted. Consent is a RECORDED EVENT, not a checkbox the UI remembers: the server
 * refuses to connect without it, so hiding the dialog cannot skip it.
 *
 * `recordingDisclosed` is asserted alongside the acceptance because the disclosure a person
 * accepted is part of what they accepted. If recording is ever built, a record showing
 * `recordingDisclosed: 'OFF'` is evidence of what this person was actually told.
 */
function consentRequiredFor(channel) {
  return String(channel || '') === 'video';
}

/**
 * evaluateConsent({ channel, acknowledged }) -> { ok, reason }
 *
 * Voice and chat need no camera consent and are unaffected. Anything truthy-but-not-`true`
 * is refused, for the same reason the capability test is `=== true`: a string, a number or an
 * object arriving from a client is not an informed acceptance.
 */
function evaluateConsent(input) {
  const i = input || {};
  if (!consentRequiredFor(i.channel)) return { ok: true, reason: 'not_required' };
  if (i.acknowledged !== true) return { ok: false, reason: 'camera_consent_not_given' };
  return { ok: true, reason: 'consent_recorded' };
}

/* The outcomes an admin may record. `inconclusive` and `abandoned` exist so that a session
   which proved nothing is recorded as having proved nothing — without them the only way to
   close a session is to claim a result, and "no answer" quietly becomes "not verified". */
const VERIFICATION_RESULTS = Object.freeze([
  'verified',
  'not_verified',
  'inconclusive',
  'abandoned',
]);

/**
 * buildVerificationRecord({ now, ... }) -> a session EVIDENCE record.
 *
 * ── THIS IS NOT A VERIFICATION AUTHORITY ───────────────────────────────────────────────────
 * `providerVerification` is the canonical authority for whether an account is verified, and
 * the platform rule is that an official identity requires a passed identity check, a passed
 * face check AND a completed human review — an approval alone is never sufficient. A third
 * verification schema is explicitly not wanted.
 *
 * So this record says only: a video session happened, for this stated reason, and the admin
 * who conducted it observed this. **A camera that switched on is not proof of identity.**
 * Nothing here grants a role, sets `official`, or writes any verified flag anywhere — the
 * suite asserts that the caller-facing function writes no such field.
 *
 * `result` is therefore `sessionOutcome` on the stored document, not `verificationStatus`:
 * borrowing the authority's vocabulary is how an evidence record starts being read as a
 * decision.
 */
function buildVerificationRecord(input) {
  const i = input || {};
  if (!i.now) throw new Error('connect-authority: buildVerificationRecord requires an explicit `now`');
  const reason = String(i.reason || '');
  if (!VERIFICATION_PURPOSES.includes(reason)) {
    throw new Error('connect-authority: reason must be a named verification procedure');
  }

  const record = {
    verificationId: String(i.verificationId || ''),
    sessionId: String(i.sessionId || ''),
    subjectUid: String(i.subjectUid || ''),
    businessId: i.businessId ? String(i.businessId) : null,
    applicationId: i.applicationId ? String(i.applicationId) : null,
    adminUid: String(i.adminUid || ''),
    reason,
    /* Deliberately NOT called verificationStatus. See above. */
    sessionOutcome: null,
    documentsReferenced: Array.isArray(i.documentsReferenced)
      ? i.documentsReferenced.slice(0, 20).map(String) : [],
    notes: String(i.notes || '').slice(0, 2000),
    consent: {
      recordingDisclosed: 'OFF',
      cameraAndMicrophone: 'REQUIRED',
      acceptedAt: null,
    },
    /* Stated on the record itself so a reader months later does not have to know the policy. */
    isProofOfIdentity: false,
    authority: 'providerVerification',
    startedAt: i.now,
    endedAt: null,
    createdAt: i.now,
    updatedAt: i.now,
  };

  const leaked = findPhoneNumbers(record);
  if (leaked.length) {
    throw new Error('connect-authority: refusing to build a verification record containing a telephone number');
  }
  return record;
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE FROZEN CONTRACT

   This module is a PROTECTED CONTRACT as of 2026-09-22. Everything downstream — the
   notification dispatcher, the client state renderer, the WebRTC adapter, the call UI —
   CONSUMES it. Future work extends the implementation behind these names; it does not
   redesign them, and it does not quietly drop one.

   Declared here rather than left implicit so the certification suite can assert the surface.
   Removing or renaming an export is then a visible, deliberate act that fails a gate, instead
   of a silent break discovered by whichever consumer happened to call it first.

   ADDING a name is allowed and expected. REMOVING one is a contract change. */
const API_CONTRACT = Object.freeze([
  /* vocabulary */
  'ROLES', 'CHANNELS', 'RELATIONSHIPS', 'STATES', 'TRANSPORTS',
  'VERIFICATION_PURPOSES', 'ENTERPRISE_VIDEO_PURPOSES', 'VERIFICATION_RESULTS',
  /* the three original questions */
  'mayCommunicate', 'resolveVideoAccess', 'selectTransport',
  /* the state machine */
  'ACTOR_NAMES', 'ACTOR_SPECS', 'INITIAL_STATE', 'SESSION_STATES', 'TERMINAL_STATES',
  'INTENTION_STATES', 'isTerminalState', 'isIntentionState', 'nextStates', 'canTransition',
  /* media observation */
  'MEDIA_EVENTS', 'MEDIA_EVENT_NAMES', 'MEDIA_DRIVEN_STATES', 'reportableEvents',
  'interpretMediaEvent',
  /* consent and verification */
  'consentRequiredFor', 'evaluateConsent', 'buildVerificationRecord',
  /* records and privacy */
  'buildSessionRecord', 'endpointHandleFor', 'findPhoneNumbers',
]);

module.exports = {
  API_CONTRACT,
  ROLES,
  CHANNELS,
  ACTOR_NAMES,
  ACTOR_SPECS,
  INITIAL_STATE,
  SESSION_STATES,
  TERMINAL_STATES,
  isTerminalState,
  nextStates,
  canTransition,
  MEDIA_EVENTS,
  MEDIA_EVENT_NAMES,
  MEDIA_DRIVEN_STATES,
  INTENTION_STATES,
  isIntentionState,
  reportableEvents,
  interpretMediaEvent,
  VERIFICATION_RESULTS,
  consentRequiredFor,
  evaluateConsent,
  buildVerificationRecord,
  RELATIONSHIPS,
  STATES,
  TRANSPORTS,
  VERIFICATION_PURPOSES,
  ENTERPRISE_VIDEO_PURPOSES,
  mayCommunicate,
  resolveVideoAccess,
  selectTransport,
  endpointHandleFor,
  findPhoneNumbers,
  buildSessionRecord,
};
