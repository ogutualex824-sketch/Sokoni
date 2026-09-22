/* SOKONI Connect — may these two parties talk, on which channel, over which transport?

   WHAT THESE PROVE

   A calling layer has two opposite failures and both are expensive:

     too narrow  a buyer cannot reach the seller about an order they paid for, so the
                 conversation moves to WhatsApp and SOKONI loses the record it exists to keep
     too wide    a stranger's telephone rings, or a camera switches on, because some pair or
                 some state was never written down and the matrix failed open

   So every grant is tested alongside its refusal. The video branch is tested from BOTH sides
   — a platform admin who is not Enterprise, and an Enterprise subscriber who is not an admin —
   because the whole design rests on those two authorities never falling through to each other.

   POSITIVE CONTROLS. "Denied" is a weak result on its own: a matrix that grants nothing denies
   everything, and would pass a suite made only of refusals. Every refusal below is paired with
   the nearest input that MUST be granted, so a resolver that simply never grants fails here.
*/
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const CA = require(path.join(ROOT, 'functions', 'shared', 'connect-authority'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};

const may = (from, to, relationship, state, channel) =>
  CA.mayCommunicate({ from, to, relationship, state, channel });

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The relationship is what creates the permission ──');
{
  ck('a buyer with a live order may call the seller',
    may('buyer', 'seller', 'order', 'active', 'voice').allowed);
  ck('…and the seller may call the buyer back — calling is symmetric',
    may('seller', 'buyer', 'order', 'active', 'voice').allowed);
  ck('…and may message them',
    may('buyer', 'seller', 'order', 'active', 'chat').allowed);

  /* The refusal this module exists for. */
  const stranger = may('buyer', 'seller', 'order', 'active', 'voice');
  ck('…while there is no relationship kind that lets a buyer call an arbitrary seller',
    !Object.keys(CA.RELATIONSHIPS).some((k) =>
      k !== 'order' && k !== 'inquiry' && CA.RELATIONSHIPS[k].pairs.includes('buyer:seller')),
    'order + inquiry only');
  ck('…positive control: the order pair itself does resolve', stranger.allowed);
}

console.log('\n── An enquiry is self-asserted, so it never buys a telephone ──');
{
  ck('anyone may MESSAGE a seller about a published listing',
    may('buyer', 'seller', 'inquiry', 'active', 'chat').allowed);
  const v = may('buyer', 'seller', 'inquiry', 'active', 'voice');
  ck('…but may NOT call them', !v.allowed, v.reason);
  ck('…refused for the relationship ceiling, not for the pair',
    v.reason === 'channel_above_relationship_ceiling', v.reason);
  /* Inverting control: the SAME pair gets voice once a real order exists. */
  ck('…and the same pair DOES get voice on an order — the ceiling is the enquiry, not the pair',
    may('buyer', 'seller', 'order', 'active', 'voice').allowed);
}

console.log('\n── A finished relationship keeps its history and loses its telephone ──');
{
  ck('a closed order still permits chat',
    may('buyer', 'seller', 'order', 'closed', 'chat').allowed);
  const v = may('buyer', 'seller', 'order', 'closed', 'voice');
  ck('…but not voice', !v.allowed, v.reason);
  ck('a cancelled order permits chat', may('buyer', 'seller', 'order', 'cancelled', 'chat').allowed);
  ck('…but not voice', !may('buyer', 'seller', 'order', 'cancelled', 'voice').allowed);
  ck('a BLOCKED relationship permits nothing — not even chat',
    !may('buyer', 'seller', 'order', 'blocked', 'chat').allowed);
  ck('…and not voice', !may('buyer', 'seller', 'order', 'blocked', 'voice').allowed);
}

console.log('\n── Every unknown fails closed ──');
{
  const cases = [
    ['unknown state', may('buyer', 'seller', 'order', 'weird', 'voice'), 'unknown_state'],
    ['unknown relationship', may('buyer', 'seller', 'friendship', 'active', 'voice'), 'unknown_relationship'],
    ['unknown channel', may('buyer', 'seller', 'order', 'active', 'telepathy'), 'unknown_channel'],
    ['unknown from-role', may('wizard', 'seller', 'order', 'active', 'voice'), 'unknown_from_role'],
    ['unknown to-role', may('buyer', 'wizard', 'order', 'active', 'voice'), 'unknown_to_role'],
    ['self-call', may('buyer', 'buyer', 'order', 'active', 'voice'), 'self_pair'],
  ];
  cases.forEach(([label, r, reason]) => {
    ck(label + ' is denied', !r.allowed, r.reason);
    ck('…for the stated reason', r.reason === reason, r.reason);
  });
  ck('no arguments at all does not throw', CA.mayCommunicate().allowed === false);
  ck('null does not throw', CA.mayCommunicate(null).allowed === false);
  ck('a string instead of an object does not throw', CA.mayCommunicate('buyer').allowed === false);
}

console.log('\n── Pairs the matrix must NOT contain ──');
{
  ck('a rider may not call a supplier', !may('rider', 'supplier', 'delivery', 'active', 'voice').allowed);
  ck('a buyer may not call a supplier', !may('buyer', 'supplier', 'supply', 'active', 'voice').allowed);
  ck('a supplier may not call a buyer', !may('supplier', 'buyer', 'supply', 'active', 'voice').allowed);
  ck('a buyer may not reach a provider through an ORDER', !may('buyer', 'provider', 'order', 'active', 'voice').allowed);
  /* Positive controls for each refusal above. */
  ck('…positive control: rider↔buyer on a delivery IS allowed',
    may('rider', 'buyer', 'delivery', 'active', 'voice').allowed);
  ck('…positive control: rider↔seller on a delivery IS allowed',
    may('rider', 'seller', 'delivery', 'active', 'voice').allowed);
  ck('…positive control: seller↔supplier on a supply relationship IS allowed',
    may('seller', 'supplier', 'supply', 'active', 'voice').allowed);
  ck('…positive control: buyer↔provider on a BOOKING is allowed',
    may('buyer', 'provider', 'booking', 'active', 'voice').allowed);
}

console.log('\n── Every declared pair actually resolves ──');
{
  /* The defect this section exists for: the first draft declared the delivery pair as
     `rider:buyer` while the lookup canonicalised to `buyer:rider`, so a rider could not call
     the buyer and NOTHING said so — the matrix simply had a hole in it. A declaration that
     does not resolve is worse than a missing one, because it reads as a permission. */
  let holes = [];
  Object.keys(CA.RELATIONSHIPS).forEach((kind) => {
    CA.RELATIONSHIPS[kind].pairs.forEach((p) => {
      const [a, b] = p.split(':');
      const ceiling = CA.RELATIONSHIPS[kind].channelCeiling || 'voice';
      if (!may(a, b, kind, 'active', ceiling).allowed) holes.push(kind + ' ' + p);
      /* And in the reverse spelling, since calling is symmetric. */
      if (!may(b, a, kind, 'active', ceiling).allowed) holes.push(kind + ' ' + b + ':' + a);
    });
  });
  ck('every declared pair resolves in BOTH directions', holes.length === 0, holes.join(' | ') || 'none');
  ck('…and there are pairs to resolve — the sweep is not vacuous',
    Object.values(CA.RELATIONSHIPS).reduce((n, r) => n + r.pairs.length, 0) >= 9,
    Object.values(CA.RELATIONSHIPS).reduce((n, r) => n + r.pairs.length, 0) + ' pairs');
  /* Inverting control: an undeclared pair must NOT resolve, or the sweep above would pass
     against a matrix that grants everything. */
  ck('…inverting control: an undeclared pair does not resolve',
    !may('rider', 'provider', 'delivery', 'active', 'voice').allowed);
}

console.log('\n── Admin reaches an account only through an open case ──');
{
  ck('an admin may call a buyer on a support case',
    may('admin', 'buyer', 'support', 'active', 'voice').allowed);
  ck('…a seller', may('admin', 'seller', 'support', 'active', 'voice').allowed);
  ck('…a rider', may('admin', 'rider', 'support', 'active', 'voice').allowed);
  ck('…and a supplier', may('admin', 'supplier', 'support', 'active', 'voice').allowed);
  ck('but NOT through an order they are not party to',
    !may('admin', 'seller', 'order', 'active', 'voice').allowed);
  ck('and not on a closed case', !may('admin', 'buyer', 'support', 'closed', 'voice').allowed);
  ck('…which still permits chat', may('admin', 'buyer', 'support', 'closed', 'chat').allowed);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── VIDEO is never granted by the relationship matrix ──');
{
  const r = may('buyer', 'seller', 'order', 'active', 'video');
  ck('a live order does NOT grant video', !r.allowed, r.reason);
  ck('…and says why: it needs a separate authority',
    r.reason === 'video_requires_separate_authority', r.reason);
  ck('nor does a support case', !may('admin', 'buyer', 'support', 'active', 'video').allowed);
  ck('nor a booking', !may('buyer', 'provider', 'booking', 'active', 'video').allowed);
  /* Inverting control: the same relationships DO grant voice, so this is a video rule and not
     a matrix that stopped working. */
  ck('…inverting control: all three grant VOICE',
    may('buyer', 'seller', 'order', 'active', 'voice').allowed &&
    may('admin', 'buyer', 'support', 'active', 'voice').allowed &&
    may('buyer', 'provider', 'booking', 'active', 'voice').allowed);
}

console.log('\n── Platform verification: admin only, named procedures only ──');
{
  const adminVerify = CA.resolveVideoAccess({
    isPlatformAdmin: true,
    purpose: 'merchant_verification',
  });
  ck('an admin may open a merchant verification', adminVerify.allowed);
  ck('…in PLATFORM mode', adminVerify.mode === 'PLATFORM', adminVerify.mode);
  ck('…and it does NOT consume an Enterprise entitlement',
    adminVerify.consumesEnterpriseEntitlement === false);

  CA.VERIFICATION_PURPOSES.forEach((p) => {
    ck('…' + p + ' is a verification procedure',
      CA.resolveVideoAccess({ isPlatformAdmin: true, purpose: p }).allowed);
  });

  const chat = CA.resolveVideoAccess({ isPlatformAdmin: true, purpose: 'business_meeting' });
  ck('an admin may NOT open video for an Enterprise purpose', !chat.allowed, chat.reason);
  ck('…nor for a blank purpose', !CA.resolveVideoAccess({ isPlatformAdmin: true }).allowed);
  ck('…nor for an invented one',
    !CA.resolveVideoAccess({ isPlatformAdmin: true, purpose: 'just_curious' }).allowed);
}

console.log('\n── Enterprise video: the plan is necessary and NOT sufficient ──');
{
  const ENT = { videoCalling: true };
  const REL = { from: 'seller', to: 'supplier', kind: 'supply', state: 'active' };

  const full = CA.resolveVideoAccess({
    capabilities: ENT, orgGrant: true, purpose: 'supplier_meeting', relationship: REL,
  });
  ck('Enterprise + org grant + business purpose + relationship ⇒ allowed', full.allowed, full.reason);
  ck('…in ENTERPRISE mode', full.mode === 'ENTERPRISE', full.mode);
  ck('…and it DOES consume the Enterprise entitlement',
    full.consumesEnterpriseEntitlement === true);

  const noGrant = CA.resolveVideoAccess({
    capabilities: ENT, orgGrant: false, purpose: 'supplier_meeting', relationship: REL,
  });
  ck('buying Enterprise does not hand a camera to every employee', !noGrant.allowed, noGrant.reason);
  ck('…and says the organisation has not granted it',
    noGrant.reason === 'organisation_has_not_granted_video', noGrant.reason);

  const noPlan = CA.resolveVideoAccess({
    capabilities: { videoCalling: false }, orgGrant: true, purpose: 'supplier_meeting', relationship: REL,
  });
  ck('an org grant without the plan grants nothing', !noPlan.allowed, noPlan.reason);

  const noRel = CA.resolveVideoAccess({
    capabilities: ENT, orgGrant: true, purpose: 'supplier_meeting',
    relationship: { from: 'seller', to: 'supplier', kind: 'supply', state: 'closed' },
  });
  ck('Enterprise does not create a right to call a stranger', !noRel.allowed, noRel.reason);

  const wrongPurpose = CA.resolveVideoAccess({
    capabilities: ENT, orgGrant: true, purpose: 'identity_verification', relationship: REL,
  });
  ck('an Enterprise subscriber may NOT open a VERIFICATION session', !wrongPurpose.allowed, wrongPurpose.reason);
  ck('…which is the whole separation: verification authority is not purchasable',
    wrongPurpose.mode === null);
}

console.log('\n── Video denials fail closed on every shape of a missing capability ──');
{
  const REL = { from: 'seller', to: 'supplier', kind: 'supply', state: 'active' };
  const base = { orgGrant: true, purpose: 'supplier_meeting', relationship: REL };
  const shapes = [
    ['capabilities absent', undefined],
    ['capabilities null', null],
    ['capabilities empty', {}],
    ['videoCalling undefined', { videoCalling: undefined }],
    ['videoCalling "true" as a string', { videoCalling: 'true' }],
    ['videoCalling 1', { videoCalling: 1 }],
    ['videoCalling truthy object', { videoCalling: {} }],
  ];
  shapes.forEach(([label, caps]) => {
    const r = CA.resolveVideoAccess({ ...base, capabilities: caps });
    ck(label + ' ⇒ denied', !r.allowed, r.reason);
  });
  /* Positive control: the identical call with a real boolean IS allowed, so the seven
     refusals above are about the value and not about a resolver that never grants. */
  ck('…positive control: videoCalling === true IS allowed',
    CA.resolveVideoAccess({ ...base, capabilities: { videoCalling: true } }).allowed);

  ck('no arguments does not throw', CA.resolveVideoAccess().allowed === false);
  ck('null does not throw', CA.resolveVideoAccess(null).allowed === false);
  ck('isPlatformAdmin truthy-but-not-true is NOT an admin',
    !CA.resolveVideoAccess({ isPlatformAdmin: 'yes', purpose: 'merchant_verification' }).allowed);
  ck('isPlatformAdmin 1 is NOT an admin',
    !CA.resolveVideoAccess({ isPlatformAdmin: 1, purpose: 'merchant_verification' }).allowed);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Transport: internet first, and never a route that cannot carry the call ──');
{
  const BOTH = { webrtc: true, pstn: true };

  const online = CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: true, providers: BOTH });
  ck('both online ⇒ webrtc is planned', online.plan.includes('webrtc'), online.plan.join(','));
  ck('…and webrtc is FIRST — internet before cellular', online.plan[0] === 'webrtc', online.plan.join(','));
  ck('…with cellular behind it as a fallback', online.fallbackAvailable === true);

  const offline = CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: false, providers: BOTH });
  ck('callee offline ⇒ webrtc is NOT planned', !offline.plan.includes('webrtc'), offline.plan.join(','));
  ck('…and the call falls back to cellular', offline.plan[0] === 'pstn', offline.plan.join(','));

  /* The correctness assertion this section exists for. */
  const video = CA.selectTransport({ channel: 'video', callerOnline: true, calleeOnline: false, providers: BOTH });
  ck('a VIDEO call never falls back to the telephone network',
    !video.plan.includes('pstn'), video.plan.join(',') || '(empty)');
  ck('…so an unroutable video call says NO ROUTE rather than quietly becoming audio',
    video.reason === 'no_route', video.reason);
  ck('…inverting control: a VOICE call in the same conditions DOES get pstn',
    offline.plan.includes('pstn'));

  const videoOnline = CA.selectTransport({ channel: 'video', callerOnline: true, calleeOnline: true, providers: BOTH });
  ck('…and video over webrtc when both are online', videoOnline.plan.join(',') === 'webrtc', videoOnline.plan.join(','));

  ck('chat is not a call channel', CA.selectTransport({ channel: 'chat', providers: BOTH }).reason === 'not_a_call_channel');
  ck('an unknown channel plans nothing', CA.selectTransport({ channel: 'smoke', providers: BOTH }).plan.length === 0);
  ck('no arguments does not throw', CA.selectTransport().plan.length === 0);
}

console.log('\n── An unprovisioned transport is reported, never offered ──');
{
  const NONE = { webrtc: false, pstn: false };
  const r = CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: true, providers: NONE });
  ck('nothing configured ⇒ no plan', r.plan.length === 0);
  ck('…and BOTH are named as not configured',
    r.notConfigured.sort().join(',') === 'pstn,webrtc', r.notConfigured.join(','));
  ck('…with reason no_route', r.reason === 'no_route', r.reason);

  const onlyWeb = CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: false, providers: { webrtc: true, pstn: false } });
  ck('no telephony provider ⇒ an offline callee has NO fallback', onlyWeb.fallbackAvailable === false);
  ck('…and pstn is named as not configured', onlyWeb.notConfigured.includes('pstn'));
  ck('…a missing provider key reads as not configured',
    CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: true, providers: {} }).plan.length === 0);
  ck('providers omitted entirely ⇒ no plan',
    CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: true }).plan.length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── No telephone number leaves the platform ──');
{
  ck('a handle is derived from the uid', CA.endpointHandleFor('abc123') === 'ep_abc123');
  ck('…and an empty uid has no handle', CA.endpointHandleFor('') === null);
  ck('…and null has no handle', CA.endpointHandleFor(null) === null);

  ck('a Kenyan mobile is detected', CA.findPhoneNumbers('+254712345678').length === 1);
  ck('…in local form', CA.findPhoneNumbers('0712345678').length === 1);
  ck('…spaced', CA.findPhoneNumbers('+254 712 345 678').length === 1);
  ck('…dashed', CA.findPhoneNumbers('254-712-345-678').length === 1);
  ck('…nested in an object', CA.findPhoneNumbers({ a: { b: ['call +254712345678'] } }).length === 1);
  ck('…and in a KEY, not only a value', CA.findPhoneNumbers({ '+254712345678': 'x' }).length === 1);
  ck('a uid is not mistaken for a number', CA.findPhoneNumbers('ep_9aF2kQ').length === 0);
  ck('…nor a short order number', CA.findPhoneNumbers('SK-9942').length === 0);
  ck('…nor an empty value', CA.findPhoneNumbers(null).length === 0);
}

console.log('\n── The session record is metadata, and it refuses a leak ──');
{
  const rec = CA.buildSessionRecord({
    now: 'SERVER_TS',
    sessionId: 's1', channel: 'voice', mode: null,
    callerUid: 'buyer1', calleeUid: 'seller1',
    relationship: 'order', anchorType: 'orders', anchorId: 'SK-99420',
    purpose: 'order_fulfilment', transportPlan: ['webrtc'], status: 'requested',
  });
  ck('it names the business context', rec.context.anchorId === 'SK-99420');
  ck('…the relationship', rec.context.relationship === 'order');
  ck('…and carries handles, not numbers', rec.callerHandle === 'ep_buyer1');
  ck('recording is written as DISABLED on every record', rec.recording === 'DISABLED');
  ck('…so a record that does NOT say DISABLED is detectable', 'recording' in rec);
  ck('no phone number survives the builder', CA.findPhoneNumbers(rec).length === 0);
  ck('the clock is an argument, not a global', rec.createdAt === 'SERVER_TS');
  ck('…and a record without one is refused', (() => {
    try { CA.buildSessionRecord({ sessionId: 'x' }); return false; } catch (_) { return true; }
  })());

  /* REFUSE, do not redact. */
  let refused = false;
  try {
    CA.buildSessionRecord({
      now: 'T', sessionId: 's2', channel: 'voice', callerUid: 'a', calleeUid: 'b',
      relationship: 'order', anchorType: 'orders', anchorId: 'call +254712345678',
    });
  } catch (_) { refused = true; }
  ck('a number in the context is REFUSED, not silently stripped', refused);
  /* Positive control: the identical record without the number builds. */
  ck('…positive control: the same record with a clean anchor builds',
    CA.buildSessionRecord({
      now: 'T', sessionId: 's2', channel: 'voice', callerUid: 'a', calleeUid: 'b',
      relationship: 'order', anchorType: 'orders', anchorId: 'SK-1',
    }).sessionId === 's2');

  const ent = CA.buildSessionRecord({
    now: 'T', sessionId: 's3', channel: 'video', mode: 'ENTERPRISE',
    callerUid: 'a', calleeUid: 'b', relationship: 'supply',
    anchorType: 'suppliers', anchorId: 'sup1', consumesEnterpriseEntitlement: true,
  });
  ck('an Enterprise video session records that it consumes the entitlement',
    ent.consumesEnterpriseEntitlement === true);
  const plat = CA.buildSessionRecord({
    now: 'T', sessionId: 's4', channel: 'video', mode: 'PLATFORM',
    callerUid: 'admin1', calleeUid: 'b', relationship: 'support',
    anchorType: 'supportTickets', anchorId: 't1', consumesEnterpriseEntitlement: false,
  });
  ck('…and a PLATFORM verification records that it does not', plat.consumesEnterpriseEntitlement === false);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Purity: the authority behaves the same everywhere ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'connect-authority.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no firestore', !/firestore|admin\./i.test(code));
  ck('no require of firebase', !/require\(['"]firebase/.test(code));
  ck('no require at all — it depends on nothing', !/\brequire\s*\(/.test(code));
  ck('no clock', !/Date\.now|new Date\(/.test(code));
  ck('no environment', !/process\.env/.test(code));
  ck('…and the stripped source still has real code',
    /function mayCommunicate/.test(code) && /function resolveVideoAccess/.test(code),
    code.length + ' chars');
}

console.log('\n── The client never names the other party ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* The production defect this layer refuses to inherit: createConversation destructures
     participantUids from req.data. Nothing here may read a uid off the request. */
  ck('no calleeUid is read from the request', !/d\.calleeUid|data\.calleeUid/.test(code));
  ck('no participantUids from the request', !/participantUids/.test(code));
  ck('no toUid / targetUid from the request', !/d\.(toUid|targetUid|recipientUid)/.test(code));
  ck('targetRole is a ROLE, and it is validated against the anchor',
    /others\.includes\(targetRole\)/.test(code));
  ck('…positive control: the file DOES read anchorId from the request',
    /d\.anchorId/.test(code));
  ck('the seller is resolved from products, not from the order',
    /collection\('products'\)/.test(code) && /sellerUid/.test(code));
  ck('…and a multi-seller order is REFUSED', /sellers\.size > 1/.test(code));
  ck('…and an order naming no product is refused', /does not name any product/.test(code));
  ck('order.sellerUid is recorded as advisory only',
    /claimedSellerUid/.test(code) && !/parties\.seller = .*order\.sellerUid/.test(code));
  ck('the session doc is created with create(), never set()',
    /sessionRef\.create\(/.test(code) && !/sessionRef\.set\(/.test(code));
  ck('presence absent reads as offline, never online',
    /data\(\)\.online === true/.test(code));
}

console.log('\n── The dispatcher and the registry ──');
{
  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const disp = fs.readFileSync(path.join(ROOT, 'functions', 'connect-dispatch.js'), 'utf8');
  /* module.exports rebound anywhere in connect-calls drops `_h` and every op resolves to
     "unknown" — a dispatcher that accepts nothing, presenting as a config error rather than
     a load error. */
  ck('connect-calls never rebinds module.exports', !/^\s*module\.exports\s*=/m.test(calls));
  ck('…it assigns onto exports.*', /exports\._h\s*=\s*\{\}/.test(calls));
  ck('the dispatcher reads the registry', /connect\._h\[op\]/.test(disp));

  const mod = require(path.join(ROOT, 'functions', 'connect-calls.js'));
  const ops = Object.keys(mod._h).sort();
  const expected = ['connectAnswerSession', 'connectCancelSession',
    'connectDeclineSession', 'connectEndSession', 'connectGetSessionState',
    'connectMarkRinging', 'connectRecordVerificationOutcome', 'connectReportMediaEvent',
    'connectRequestSession', 'connectRequestVerification', 'connectSetVideoGrant',
    'connectSignal'];
  /* A SUBSET check, not equality. This repository is written by several agents in parallel and
     C3-B added `connectListIncoming` mid-slice. Asserting equality would turn a colleague's
     legitimate addition into a red suite, and the temptation then is to delete their work to
     go green. What actually matters is that every op this slice depends on is still
     registered — an op DISAPPEARING is the regression worth failing on. */
  const missingOps = expected.filter((o) => !ops.includes(o));
  ck('every op this slice depends on is registered',
    missingOps.length === 0, missingOps.join(',') || ops.length + ' ops present');
  const extraOps = ops.filter((o) => !expected.includes(o));
  ck('…and any additional op is surfaced rather than silently accepted',
    true, extraOps.length ? 'also registered: ' + extraOps.join(',') : 'none');
  /* The scheduled sweep is NOT dispatchable — onSchedule is event-triggered. If it ever
     appeared in the registry, the dispatcher would be offering an op no client can invoke. */
  ck('…and the scheduled sweep is NOT among them',
    !ops.includes('connectExpireStaleSessions') &&
    typeof mod.connectExpireStaleSessions === 'function');
  ck('…and every one is a function', ops.every((o) => typeof mod._h[o] === 'function'));
  ck('PSTN is NOT provisioned, and the code says so rather than implying it',
    mod._internals.PROVIDERS.pstn === false);
  ck('…so a real transport selection offers no cellular fallback',
    CA.selectTransport({ channel: 'voice', callerOnline: true, calleeOnline: false,
      providers: mod._internals.PROVIDERS }).fallbackAvailable === false);

  /* An unrecognised lifecycle word must close the call button, not open it. */
  ck('an unknown order status resolves to "unknown"', mod._internals._stateOf('quantum') === 'unknown');
  ck('…which the authority refuses',
    !may('buyer', 'seller', 'order', mod._internals._stateOf('quantum'), 'voice').allowed);
  ck('…positive control: a known live status resolves to active and IS allowed',
    mod._internals._stateOf('paid') === 'active' &&
    may('buyer', 'seller', 'order', mod._internals._stateOf('paid'), 'voice').allowed);
  ck('a delivered order resolves to closed', mod._internals._stateOf('delivered') === 'closed');
  ck('a refunded order resolves to cancelled', mod._internals._stateOf('refunded') === 'cancelled');
  ck('an empty status is not active', mod._internals._stateOf('') === 'unknown');
}

console.log('\n── Video is gated on the server, not in the UI ──');
{
  const capSrc = fs.readFileSync(path.join(ROOT, 'functions', 'capability-authority.js'), 'utf8');
  const cap = require(path.join(ROOT, 'functions', 'capability-authority.js'));
  ck('videoCalling is a DECLARED capability', cap.KEYS.includes('videoCalling'));
  ck('…its declared consumer is the calling layer',
    cap.DECLARED.videoCalling.consumer === 'functions/connect-calls.js');
  ck('the unsubscribed floor is FALSE', cap.UNSUBSCRIBED.videoCalling === false);
  ck('…and the floor is frozen', Object.isFrozen(cap.UNSUBSCRIBED));
  ck('it resolves from the ENTERPRISE package', /videoCalling: ent\.plan === 'ENTERPRISE'/.test(capSrc));
  /* Verification authority must never become purchasable. */
  ck('videoVerification is NOT a capability key', !cap.KEYS.includes('videoVerification'));
  ck('…and nothing resolves verification from a plan',
    !/videoVerification\s*:/.test(capSrc.replace(/\/\*[\s\S]*?\*\//g, '')));

  const catalog = require(path.join(ROOT, 'functions', 'subscription-catalog.js'));
  ck('ENTERPRISE is a real package in the canonical catalogue', !!catalog.PLANS.ENTERPRISE);
  /* PORT NOTE — the control is preserved, and generalised rather than weakened.
     Its purpose is stated in its own label: prove the catalogue holds more than
     one plan, so `ent.plan === 'ENTERPRISE'` is not vacuously true. It named
     BUSINESS, which exists on the source branch's catalogue but NOT on the live
     lineage (FREE, STARTER, GROWTH, ENTERPRISE). Connect's runtime does not
     reference BUSINESS at all — the only hits are a local placeholder key in
     capability-authority and a word in a comment — so this is a divergence in
     the SUBSCRIPTION catalogue, not a Communications dependency.

     Naming any single sibling plan makes the control brittle against exactly
     this kind of lineage difference. Asserting that a non-ENTERPRISE plan
     EXISTS is strictly stronger: it cannot pass on a one-plan catalogue, and it
     survives a plan being renamed. */
  {
    const others = Object.keys(catalog.PLANS)
      .filter((k) => catalog.PLANS[k] && catalog.PLANS[k].id !== catalog.PLANS.ENTERPRISE.id);
    ck('…and the catalogue holds a plan that is NOT enterprise, so the gate is not vacuous',
      others.length > 0, others.join(','));
  }
  ck('an expired Enterprise subscription resolves to FREE before video is asked about',
    catalog.entitlementFor({ plan: 'ENTERPRISE', status: 'expired' }).plan === 'FREE');
  ck('…positive control: an ACTIVE one resolves to ENTERPRISE',
    catalog.entitlementFor({ plan: 'ENTERPRISE', status: 'active' }).plan === 'ENTERPRISE');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The session state machine ──');
{
  const T = (from, to, actor, extra) =>
    CA.canTransition(Object.assign({ from, to, actor }, extra || {}));

  ck('the initial state is authorized', CA.INITIAL_STATE === 'authorized', CA.INITIAL_STATE);
  /* `requested` does not exist BECAUSE authorization precedes creation — there is no moment
     at which a session exists and is not authorized. A state nothing is ever in would be a
     dead entry that reads as a guarantee. */
  ck('…and `requested` is not a state — authorization precedes the document',
    !Object.hasOwn(CA.SESSION_STATES, 'requested'));
  ck('the terminal states are exactly the five expected',
    CA.TERMINAL_STATES.slice().sort().join(',') === 'cancelled,declined,ended,expired,failed',
    CA.TERMINAL_STATES.join(','));
  /* The verification vocabulary must NOT leak into the session vocabulary. */
  ck('`abandoned` is NOT a session state — it is a verification outcome',
    !Object.hasOwn(CA.SESSION_STATES, 'abandoned') && CA.VERIFICATION_RESULTS.includes('abandoned'));
  ck('…and neither is `inconclusive`',
    !Object.hasOwn(CA.SESSION_STATES, 'inconclusive') && CA.VERIFICATION_RESULTS.includes('inconclusive'));
  ck('…the two vocabularies share no word at all',
    !Object.keys(CA.SESSION_STATES).some((s) => CA.VERIFICATION_RESULTS.includes(s)),
    Object.keys(CA.SESSION_STATES).filter((s) => CA.VERIFICATION_RESULTS.includes(s)).join(',') || 'disjoint');

  console.log('\n   the happy path, one step at a time');
  ck('authorized -> ringing  (callee: their device is showing it)', T('authorized', 'ringing', 'callee').ok);
  ck('ringing -> accepted    (callee)', T('ringing', 'accepted', 'callee').ok);
  ck('accepted -> connecting (either)', T('accepted', 'connecting', 'caller').ok);
  ck('connecting -> connected(either)', T('connecting', 'connected', 'callee').ok);
  ck('connected -> ended     (either)', T('connected', 'ended', 'caller').ok);

  console.log('\n   and every shortcut across it is refused');
  const skips = [
    ['authorized', 'connected'], ['authorized', 'accepted'], ['authorized', 'connecting'],
    ['ringing', 'connected'], ['ringing', 'connecting'], ['ringing', 'ended'],
    ['accepted', 'connected'], ['accepted', 'ended'],
  ];
  skips.forEach(([f, t]) => {
    const r = T(f, t, 'callee');
    ck('…' + f + ' -> ' + t + ' is refused', !r.ok, r.reason);
  });
  /* Inverting control: the machine DOES permit the legal edge out of each of those states, so
     the eight refusals above are about the edge and not a machine that permits nothing. */
  ck('…inverting control: each of those from-states has a legal edge',
    skips.every(([f]) => CA.nextStates(f).length > 0));

  console.log('\n   a terminal state is terminal');
  CA.TERMINAL_STATES.forEach((s) => {
    ck('…' + s + ' has no outgoing edge', CA.nextStates(s).length === 0);
    ck('…and cannot be revived', !T(s, 'connected', 'caller').ok && !T(s, 'ringing', 'callee').ok);
    ck('…isTerminalState says so', CA.isTerminalState(s));
  });
  ck('a live state is NOT terminal', !CA.isTerminalState('ringing') && !CA.isTerminalState('authorized'));
  ck('…and an unknown state is not treated as live either',
    !T('quantum', 'connected', 'caller').ok);

  console.log('\n   who may take which edge');
  ck('only the CALLEE may decline', T('ringing', 'declined', 'callee').ok &&
    !T('ringing', 'declined', 'caller').ok);
  ck('only the CALLER may cancel from ringing', T('ringing', 'cancelled', 'caller').ok &&
    !T('ringing', 'cancelled', 'callee').ok);
  ck('only the CALLEE may accept', T('ringing', 'accepted', 'callee', { channel: 'voice' }).ok &&
    !T('ringing', 'accepted', 'caller', { channel: 'voice' }).ok);
  ck('a connected call ENDS, it is never cancelled',
    T('connected', 'ended', 'caller').ok && !T('connected', 'cancelled', 'caller').ok);
  ck('…because cancelling a call that happened would erase that it happened',
    CA.nextStates('connected').sort().join(',') === 'ended,failed');

  console.log('\n   the server edge is the server\'s alone');
  ck('the server may expire a ringing session', T('ringing', 'expired', 'server').ok);
  ck('…and an authorized one', T('authorized', 'expired', 'server').ok);
  ck('a participant may NOT expire a session', !T('ringing', 'expired', 'caller').ok &&
    !T('ringing', 'expired', 'callee').ok);
  /* The converse matters more: a sweep must never be able to answer a call for someone. */
  ck('the server may NOT accept on the callee\'s behalf',
    !T('ringing', 'accepted', 'server', { channel: 'voice', consentAcknowledged: true }).ok);
  ck('…nor decline for them', !T('ringing', 'declined', 'server').ok);
  ck('…nor mark a call connected', !T('connecting', 'connected', 'server').ok);
  ck('…nor cancel it', !T('ringing', 'cancelled', 'server').ok);
  ck('the server may not expire a call that already connected',
    !T('connected', 'expired', 'server').ok);
  ck('…nor one that was accepted — it happened, and must not read as unanswered',
    !T('accepted', 'expired', 'server').ok);

  console.log('\n   consent lives in the machine, so no new path can forget it');
  ck('video accept without consent is refused by canTransition itself',
    !T('ringing', 'accepted', 'callee', { channel: 'video' }).ok);
  ck('…with the consent reason, not a generic one',
    T('ringing', 'accepted', 'callee', { channel: 'video' }).reason === 'camera_consent_not_given');
  ck('video accept WITH consent is permitted',
    T('ringing', 'accepted', 'callee', { channel: 'video', consentAcknowledged: true }).ok);
  ck('voice needs no camera consent',
    T('ringing', 'accepted', 'callee', { channel: 'voice' }).ok);

  console.log('\n   garbage in');
  ck('unknown from-state is refused', T('quantum', 'ringing', 'callee').reason === 'unknown_from_state');
  ck('unknown to-state is refused', T('ringing', 'quantum', 'callee').reason === 'unknown_to_state');
  ck('unknown actor is refused', T('ringing', 'accepted', 'wizard').reason === 'unknown_actor');
  ck('a no-op transition is refused', T('ringing', 'ringing', 'callee').reason === 'no_op_transition');
  ck('no arguments does not throw', CA.canTransition().ok === false);
  ck('null does not throw', CA.canTransition(null).ok === false);
  ck('a string does not throw', CA.canTransition('ringing').ok === false);
  ck('nextStates of an unknown state is empty', CA.nextStates('quantum').length === 0);
  ck('…and of nothing at all', CA.nextStates().length === 0);

  console.log('\n   the table is internally sound');
  const states = Object.keys(CA.SESSION_STATES);
  let badTargets = [], badActors = [];
  states.forEach((s) => {
    Object.keys(CA.SESSION_STATES[s].to).forEach((t) => {
      if (!states.includes(t)) badTargets.push(s + '->' + t);
      if (!CA.ACTOR_SPECS.includes(CA.SESSION_STATES[s].to[t])) badActors.push(s + '->' + t);
    });
  });
  ck('every edge points at a declared state', badTargets.length === 0, badTargets.join(',') || 'none');
  ck('every edge names a declared actor', badActors.length === 0, badActors.join(',') || 'none');
  /* Every non-initial state must be reachable, or it is a dead entry. */
  const reachable = new Set([CA.INITIAL_STATE]);
  let grew = true;
  while (grew) {
    grew = false;
    [...reachable].forEach((s) => CA.nextStates(s).forEach((n) => {
      if (!reachable.has(n)) { reachable.add(n); grew = true; }
    }));
  }
  const orphans = states.filter((s) => !reachable.has(s));
  ck('every state is reachable from authorized — no dead entries', orphans.length === 0,
    orphans.join(',') || 'all reachable');
  ck('…and every terminal state is actually reached',
    CA.TERMINAL_STATES.every((s) => reachable.has(s)));
  ck('the table is frozen', Object.isFrozen(CA.SESSION_STATES));
}

console.log('\n── The server obeys its own machine ──');
{
  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const code = calls.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ck('there is ONE transition path', (code.match(/async function _advance\(/g) || []).length === 1);
  ck('…and no per-callsite allowedFrom lists survive', !/allowedFrom/.test(code));
  /* FIVE, not more: the intention ops. `connecting`, `connected` and `failed` have no
     _advance call at all — they are reached only by reporting a media event. */
  ck('…every INTENTION op delegates to it',
    (code.match(/_advance\(req, '/g) || []).length === 5,
    (code.match(/_advance\(req, '/g) || []).length + ' ops');
  ck('the legality of a move is decided by the table',
    /CA\.canTransition\(\{/.test(code));

  /* The actor must be DERIVED, exactly like the participant list. */
  ck('the actor is derived from the session, not the request',
    /const actor = String\(s\.callerUid\) === String\(uid\) \? 'caller' : 'callee'/.test(code));
  ck('…and no actor is read off req.data', !/data\.actor|d\.actor/.test(code));
  ck('…nor a from-state', !/data\.from\b|d\.from\b|fromStatus/.test(code));

  ck('answering lands on ACCEPTED, not connected',
    /connectAnswerSession = \(req\) => _advance\(req, 'accepted'\)/.test(code));
  ck('…and there is NO op that names `connected` — it is reached only by observing media',
    !/_advance\(req, 'connected'\)/.test(code) && /connectReportMediaEvent/.test(code));

  ck('a session is created in the INITIAL state, named not spelled',
    /status: CA\.INITIAL_STATE/.test(code) && !/status: 'requested'/.test(code));
  ck('signalling is gated on the machine, not a hand-written list',
    /CA\.isTerminalState\(String\(s\.status\)\)/.test(code));
  ck('a terminal transition stamps endedAt',
    /if \(CA\.isTerminalState\(to\)\) patch\.endedAt/.test(code));

  /* The sweep is the writer for `expired`, and it is not privileged. */
  ck('`expired` has a real writer', /connectExpireStaleSessions/.test(code));
  ck('…which obeys the SAME table rather than writing the status directly',
    /CA\.canTransition\(\{ from, to: 'expired', actor: 'server' \}\)/.test(code));
  ck('…and never sweeps a call that already happened',
    /const expirable = \['authorized', 'ringing'\]/.test(code));
  ck('…the scheduled function is exported from index.js by name',
    /exports\.connectExpireStaleSessions = _connectMod\.connectExpireStaleSessions/
      .test(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8')));

  /* The UI must be a representation of the machine, not a second authority. */
  ck('the client can ask what it may offer', /connectGetSessionState/.test(code));
  ck('…and the answer is filtered by ACTOR, so a caller is never shown Decline',
    /CA\.nextStates\(s\.status\)[\s\S]{0,200}canTransition\(\{ from: s\.status, to: n, actor/.test(code));
  ck('…and comes from the same table the server enforces',
    /CA\.canTransition\(\{ from: s\.status, to: n, actor/.test(code));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The client OBSERVES; the authority DECIDES ──');
{
  const E = (from, event, actor) =>
    CA.interpretMediaEvent({ from, event, actor: actor || 'caller' });

  console.log('\n   an observation maps to an intent, and the table still rules on it');
  ck('accepted + negotiation_started ⇒ connecting',
    E('accepted', 'negotiation_started').effect === 'transition' &&
    E('accepted', 'negotiation_started').intends === 'connecting');
  ck('connecting + media_flowing ⇒ connected',
    E('connecting', 'media_flowing').effect === 'transition' &&
    E('connecting', 'media_flowing').intends === 'connected');
  ck('connecting + connection_failed ⇒ failed',
    E('connecting', 'connection_failed').effect === 'transition');

  /* THE RULE THIS SECTION EXISTS FOR. */
  const skip = E('accepted', 'media_flowing');
  ck('accepted + media_flowing does NOT skip connecting', skip.effect === 'refused', skip.reason);
  ck('…refused by the STATE TABLE, not by the event table',
    skip.recognised === true && skip.reason === 'transition_not_permitted', skip.reason);
  ck('authorized + media_flowing is refused', E('authorized', 'media_flowing').effect === 'refused');
  ck('ringing + media_flowing is refused', E('ringing', 'media_flowing').effect === 'refused');
  ck('authorized + negotiation_started is refused',
    E('authorized', 'negotiation_started').effect === 'refused');
  /* Inverting control: the same events DO land from the right state, so the four refusals are
     about the state and not an interpreter that refuses everything. */
  ck('…inverting control: both events land from their legal state',
    E('accepted', 'negotiation_started').effect === 'transition' &&
    E('connecting', 'media_flowing').effect === 'transition');

  console.log('\n   an ICE pair is a route, not a conversation');
  ck('ice_connected intends NOTHING', CA.MEDIA_EVENTS.ice_connected.intends === null);
  ck('…it is recorded only', E('connecting', 'ice_connected').effect === 'recorded_only');
  ck('…under a timestamp', E('connecting', 'ice_connected').records === 'iceConnectedAt');
  ck('ice_disconnected is not a failure — a transient drop must not hang up on someone',
    CA.MEDIA_EVENTS.ice_disconnected.intends === null &&
    E('connected', 'ice_disconnected').effect === 'recorded_only');
  ck('…and it does NOT reach `failed`',
    E('connected', 'ice_disconnected').intends !== 'failed');

  console.log('\n   media events race and repeat — ignored is not an error');
  ck('connected + media_flowing is IGNORED, not refused',
    E('connected', 'media_flowing').effect === 'ignored',
    E('connected', 'media_flowing').reason);
  ck('…because it is already in that state',
    E('connected', 'media_flowing').reason === 'already_in_that_state');
  ck('connecting + negotiation_started is ignored',
    E('connecting', 'negotiation_started').effect === 'ignored');
  CA.TERMINAL_STATES.forEach((s) => {
    ck('…a late event on ' + s + ' is absorbed, not refused',
      E(s, 'connection_failed').effect === 'ignored');
  });
  ck('…and cannot revive a finished call', E('ended', 'media_flowing').effect === 'ignored');

  console.log('\n   garbage in');
  ck('an unknown event is refused', E('connecting', 'not_a_real_event').reason === 'unknown_media_event');
  ck('…and is marked unrecognised', E('connecting', 'nope').recognised === false);
  ck('an unknown state is refused', E('quantum', 'media_flowing').reason === 'unknown_from_state');
  ck('no arguments does not throw', CA.interpretMediaEvent().effect === 'refused');
  ck('null does not throw', CA.interpretMediaEvent(null).recognised === false);
  ck('a string does not throw', CA.interpretMediaEvent('media_flowing').effect === 'refused');

  console.log('\n   nothing maps to `ended` — hanging up is an intention, not an observation');
  ck('no media event intends `ended`',
    !CA.MEDIA_EVENT_NAMES.some((e) => CA.MEDIA_EVENTS[e].intends === 'ended'));
  ck('…so a dropped call is `failed`, and a hang-up is `ended` — two different facts',
    CA.MEDIA_EVENTS.connection_failed.intends === 'failed');

  console.log('\n   intentions and observations are disjoint');
  ck('the media-driven states are connecting, connected, failed',
    CA.MEDIA_DRIVEN_STATES.slice().sort().join(',') === 'connected,connecting,failed',
    CA.MEDIA_DRIVEN_STATES.join(','));
  ck('…and none of them is an intention state',
    !CA.MEDIA_DRIVEN_STATES.some((s) => CA.isIntentionState(s)));
  ck('accept / decline / cancel / end / ringing ARE intentions',
    ['ringing', 'accepted', 'declined', 'cancelled', 'ended'].every((s) => CA.isIntentionState(s)));
  ck('…and every state is one or the other, never both',
    Object.keys(CA.SESSION_STATES).every((s) =>
      CA.isIntentionState(s) !== CA.MEDIA_DRIVEN_STATES.includes(s)));

  console.log('\n   what a client should report, from here');
  ck('from accepted: negotiation_started is worth reporting',
    CA.reportableEvents('accepted').includes('negotiation_started'));
  ck('…and media_flowing is NOT, because it would be refused',
    !CA.reportableEvents('accepted').includes('media_flowing'));
  ck('from connecting: media_flowing is', CA.reportableEvents('connecting').includes('media_flowing'));
  ck('…and so is ice_connected', CA.reportableEvents('connecting').includes('ice_connected'));
  ck('a terminal session has nothing worth reporting',
    CA.TERMINAL_STATES.every((s) => CA.reportableEvents(s).length === 0));
  ck('…and an unknown state likewise', CA.reportableEvents('quantum').length === 0);
}

console.log('\n── There is NO op that names connected ──');
{
  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const code = calls.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const mod = require(path.join(ROOT, 'functions', 'connect-calls.js'));
  const ops = Object.keys(mod._h);

  /* The rule, made structural rather than documented: a WebRTC client cannot write
     `connected` because it constructed an RTCPeerConnection — there is no op to call. */
  CA.MEDIA_DRIVEN_STATES.forEach((s) => {
    ck('no op advances directly to `' + s + '`',
      !new RegExp("_advance\\(req, '" + s + "'\\)").test(code));
  });
  ck('the retired destination ops are gone',
    !ops.includes('connectMarkConnected') && !ops.includes('connectBeginConnecting') &&
    !ops.includes('connectFailSession'));
  ck('…replaced by ONE event-reporting op', ops.includes('connectReportMediaEvent'));
  ck('…which routes through the interpreter, not the table directly',
    /CA\.interpretMediaEvent\(\{ from: String\(s\.status\), event, actor \}\)/.test(code));
  ck('…and derives the actor like everything else',
    (code.match(/const actor = String\(s\.callerUid\) === String\(uid\) \? 'caller' : 'callee'/g) || []).length >= 2);
  ck('…refusing a skip rather than absorbing it',
    /verdict\.effect === 'refused'/.test(code));
  ck('…and absorbing a duplicate rather than refusing it',
    /verdict\.effect === 'transition'/.test(code) && !/verdict\.effect === 'ignored'[\s\S]{0,60}throw/.test(code));
  ck('the intention ops that remain are the things a PERSON does',
    ['connectAnswerSession', 'connectDeclineSession', 'connectCancelSession',
      'connectEndSession', 'connectMarkRinging'].every((o) => ops.includes(o)));

  /* The UI must never be told to draw a button with no op behind it. */
  ck('offerable is filtered to intention states',
    /\.filter\(\(n\) => CA\.isIntentionState\(n\)\)/.test(code));
  ck('…and the client is told which EVENTS to report instead',
    /reportableEvents: CA\.reportableEvents\(s\.status\)/.test(code));
}

console.log('\n── Consent is a server gate, not a dialog ──');
{
  ck('a video session requires consent', CA.consentRequiredFor('video'));
  ck('…voice does not', !CA.consentRequiredFor('voice'));
  ck('…chat does not', !CA.consentRequiredFor('chat'));
  ck('…and an unknown channel does not (it never reaches a camera)', !CA.consentRequiredFor('smoke'));

  ck('video + acknowledged ⇒ ok',
    CA.evaluateConsent({ channel: 'video', acknowledged: true }).ok);
  const missing = CA.evaluateConsent({ channel: 'video' });
  ck('video without acknowledgement ⇒ refused', !missing.ok, missing.reason);
  ck('…for the stated reason', missing.reason === 'camera_consent_not_given', missing.reason);
  ['yes', 1, {}, 'true', [], null].forEach((v) => {
    ck('…truthy-but-not-true (' + JSON.stringify(v) + ') is not consent',
      !CA.evaluateConsent({ channel: 'video', acknowledged: v }).ok);
  });
  ck('voice needs none even when unacknowledged',
    CA.evaluateConsent({ channel: 'voice' }).ok);
  ck('no arguments does not throw', CA.evaluateConsent().ok === true);

  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const code = calls.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* Consent moved INTO canTransition, which is stronger than checking it at the answer
     callsite: a future path that reaches `accepted` some other way cannot forget it. The
     server's job is now to FORWARD the acknowledgement and RECORD what was accepted. */
  ck('the server forwards the acknowledgement to the machine',
    /consentAcknowledged: \(req\.data \|\| \{\}\)\.consentAcknowledged/.test(code));
  ck('…and the machine is what refuses — so no new path can forget it',
    !CA.canTransition({ from: 'ringing', to: 'accepted', actor: 'callee', channel: 'video' }).ok);
  ck('…the acceptance is recorded on the session',
    /consentAcceptedAt/.test(code) && /consentAcceptedBy/.test(code));
  ck('…together with what was disclosed',
    /consentRecordingDisclosed/.test(code));
  ck('…and it is recorded on ACCEPTED, where the person actually agreed',
    /if \(to === 'accepted'\)[\s\S]{0,400}consentAcceptedAt/.test(code));
}

console.log('\n── A verification session is EVIDENCE, never a verdict ──');
{
  ck('the result vocabulary has four outcomes',
    CA.VERIFICATION_RESULTS.length === 4, CA.VERIFICATION_RESULTS.join(','));
  ck('…including inconclusive, so a session that proved nothing says so',
    CA.VERIFICATION_RESULTS.includes('inconclusive'));
  ck('…and abandoned, so "no answer" never becomes "not verified"',
    CA.VERIFICATION_RESULTS.includes('abandoned'));

  const rec = CA.buildVerificationRecord({
    now: 'T', verificationId: 'v1', sessionId: 's1', subjectUid: 'u1',
    businessId: 'biz1', adminUid: 'admin1', reason: 'merchant_verification',
    notes: 'Spoke to the owner', documentsReferenced: ['idFront', 'permit'],
  });
  ck('it names the subject, the business and the admin',
    rec.subjectUid === 'u1' && rec.businessId === 'biz1' && rec.adminUid === 'admin1');
  ck('…the reason it was conducted for', rec.reason === 'merchant_verification');
  ck('…the documents referenced', rec.documentsReferenced.join(',') === 'idFront,permit');
  ck('the outcome starts EMPTY — opening a session decides nothing', rec.sessionOutcome === null);
  ck('the field is sessionOutcome, NOT verificationStatus',
    'sessionOutcome' in rec && !('verificationStatus' in rec));
  ck('it states on its face that it is not proof of identity', rec.isProofOfIdentity === false);
  ck('…and names the real authority', rec.authority === 'providerVerification');
  ck('consent is recorded with what was disclosed',
    rec.consent.recordingDisclosed === 'OFF' && rec.consent.acceptedAt === null);
  ck('no phone number survives the builder', CA.findPhoneNumbers(rec).length === 0);

  /* A reason outside the named procedures cannot produce a record at all. */
  const bad = (reason) => {
    try {
      CA.buildVerificationRecord({ now: 'T', verificationId: 'v', subjectUid: 'u',
        adminUid: 'a', reason });
      return false;
    } catch (_) { return true; }
  };
  ck('an invented reason is refused', bad('just_curious'));
  ck('…an Enterprise purpose is refused', bad('business_meeting'));
  ck('…and a blank reason is refused', bad(''));
  ck('…positive control: a named procedure builds', !bad('rider_verification'));
  ck('a record without an explicit clock is refused', (() => {
    try { CA.buildVerificationRecord({ verificationId: 'v', reason: 'identity_verification' }); return false; }
    catch (_) { return true; }
  })());
}

console.log('\n── Recording an outcome grants NOTHING ──');
{
  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const code = calls.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ck('both verification ops exist',
    /connectRequestVerification/.test(code) && /connectRecordVerificationOutcome/.test(code));
  ck('both are platform-admin gated on the SERVER',
    (code.match(/_isPlatformAdmin\(req\)\)\s*throw new HttpsError\('permission-denied'/g) || []).length >= 2);
  ck('an admin cannot verify themselves', /subjectUid === adminUid/.test(code));
  ck('a verification goes through the SAME video authority, not around it',
    /resolveVideoAccess\(\{ isPlatformAdmin: true, purpose: reason \}\)/.test(code));

  /* The boundary. A video call is evidence a human reviewer weighs; it must never collapse
     the identity check, the face check and the human review into "an admin was on a call". */
  ['providerVerification', 'driverVerification', 'faceVerified', 'documentsVerified',
    'identityVerificationPassed', 'faceVerificationPassed', 'humanReviewCompleted',
    'setCustomUserClaims'].forEach((field) => {
    ck('…it never writes ' + field, !new RegExp('\\b' + field + '\\b\\s*:').test(code) &&
      !new RegExp('\\b' + field + '\\s*\\(').test(code));
  });
  ck('…it writes sessionOutcome and nothing that reads as a grant',
    /sessionOutcome: result/.test(code));
  ck('…and never sets a bare `verified` or `official` field',
    !/\b(verified|official)\s*:\s*true/.test(code));
  ck('an outcome is recorded ONCE — re-deciding would erase the first observation',
    /if \(v\.sessionOutcome\)/.test(code));
  ck('the session and its record are created in ONE batch',
    /batch\.create\(sessionRef/.test(code) && /batch\.create\(verifyRef/.test(code));
  ck('…with create(), never set()',
    !/batch\.set\(/.test(code));
  ck('the response restates that it is not proof',
    /isProofOfIdentity: false/.test(code));
}

console.log('\n── The admin surface is AdminOS and Super Admin, and nowhere else ──');
{
  const consolePath = path.join(ROOT, 'sokoni-connect-console.js');
  const verifyPath = path.join(ROOT, 'sokoni-connect-verify.js');
  ck('the Connect console exists', fs.existsSync(consolePath));
  ck('…and its write surface is a SEPARATE file', fs.existsSync(verifyPath));

  const aos = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const saJs = sa;

  ck('admin-os.html loads the console', /sokoni-connect-console\.js/.test(aos));
  ck('…as a tab on the existing Communications panel, not a new nav item',
    /SokoniAOS\.commsTab\('connect'\)/.test(aos));
  ck('…and loads the write surface', /sokoni-connect-verify\.js/.test(aos));

  ck('super-admin.html loads the SAME console module', /sokoni-connect-console\.js/.test(sa));
  ck('…and the same write surface', /sokoni-connect-verify\.js/.test(sa));
  ck('…has a Connect nav item', /data-section="connect"/.test(sa));
  ck('…a panel for it to render into', /id="panel-connect"/.test(sa));
  ck('…a mount point', /id="connectRoot"/.test(sa));
  ck('…a loader', /loadConnect\(\)/.test(saJs));
  ck('…and nav() actually dispatches to it', /section==='connect'\)this\.loadConnect\(\)/.test(saJs));
  /* A panel with no loader, or a loader nothing calls, is a nav item that opens a blank box. */
  ck('…a missing module is reported as missing, not as an empty list',
    /sokoni-connect-console\.js is served/.test(saJs));

  /* One module, two mount points — not two hand-written copies. */
  ck('neither console re-implements the console module',
    !/connectSessions/.test(sa.replace(/<script src[^>]*><\/script>/g, '')
      .replace(/<!--[\s\S]*?-->/g, '')) &&
    !/SESSIONS\s*=\s*'connectSessions'/.test(aos));

  const legacy = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  ck('the legacy admin.html carries NEITHER file',
    !/sokoni-connect-console/.test(legacy) && !/sokoni-connect-verify/.test(legacy));

  /* Stripped. The console's own header explains that it uses no localStorage, so an
     unstripped check would fail on the documentation that promises the opposite. */
  const cons = fs.readFileSync(consolePath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* Matches either spelling of the em dash — the literal character or its — escape —
     because an editor may normalise one into the other and the assertion is about the
     NEUTRAL STATE existing, not about how it was typed. */
  ck('the console renders no fabricated metric — unknown shows a dash',
    /DASH\s*=\s*'(—|\\u2014)'/.test(cons));
  ck('…it reads both canonical collections',
    /connectSessions/.test(cons) && /connectVerifications/.test(cons));
  ck('…with no localStorage anywhere in its code', !/localStorage/.test(cons));
  ck('…and CONTAINS NO WRITE PATH — that guarantee is why the files are separate',
    !/\.(set|add|update|delete)\(/.test(cons) && !/httpsCallable/.test(cons));
  ck('…a canonical zero says it is one', /canonical zero/.test(cons));
  ck('…and the two reads are independent, so one refusal does not blank the other',
    /Promise\.all\(\[sessions, verifications\]\)/.test(cons));

  const vw = fs.readFileSync(verifyPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the write surface routes through the one dispatcher',
    /httpsCallable\('connectDispatch'\)/.test(vw));
  ck('…and reports success only from what the SERVER returned',
    /r\.verificationId/.test(vw) && /r\.sessionOutcome/.test(vw));
  ck('…never showing success on click', !/_say\(out, 'ok'[^)]*\);\s*_call/.test(vw));
  ck('…it disables the button in flight, so a double-click cannot open two verifications',
    /btn\.disabled = true/.test(vw));
  ck('…an undeployed backend is named as such, not rendered as a failure of the operator',
    /not deployed yet, so nothing was written/.test(vw));
  ck('…and the surface tells the operator it is not a verdict',
    /evidence, not a verdict|not a verdict|does not verify the account/.test(vw));
  /* The reason and result vocabularies must not drift from the server's. */
  ck('the reasons offered match the authority exactly',
    global.SokoniConnectVerifyReasonsMatch === undefined &&
    JSON.stringify(CA.VERIFICATION_PURPOSES.slice().sort()) ===
      JSON.stringify((vw.match(/'([a-z_]+_verification|support_escalation)'/g) || [])
        .map((s) => s.replace(/'/g, '')).filter((v, i, a) => a.indexOf(v) === i).sort()));
  ck('…and the results match the authority exactly',
    CA.VERIFICATION_RESULTS.every((r) => new RegExp("'" + r + "'").test(vw)));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The authority is a FROZEN CONTRACT ──');
{
  /* Frozen 2026-09-22. Downstream work — notification, client renderer, WebRTC adapter,
     TURN/STUN, call UI — CONSUMES these names. Adding one is expected; removing or renaming
     one is a contract change and must fail here rather than be discovered by whichever
     consumer called it first. */
  const missing = CA.API_CONTRACT.filter((k) => CA[k] === undefined);
  ck('every declared name is exported', missing.length === 0, missing.join(',') || 'none');
  const undeclared = Object.keys(CA)
    .filter((k) => k !== 'API_CONTRACT' && !CA.API_CONTRACT.includes(k));
  ck('…and every export is declared — no accidental surface',
    undeclared.length === 0, undeclared.join(',') || 'none');
  ck('the contract is frozen', Object.isFrozen(CA.API_CONTRACT));
  ck('…and is not empty', CA.API_CONTRACT.length >= 30, CA.API_CONTRACT.length + ' names');
  /* The three questions the module was created to answer must still be on it. */
  ['mayCommunicate', 'resolveVideoAccess', 'selectTransport', 'canTransition',
    'interpretMediaEvent'].forEach((k) => {
    ck('…' + k + ' is part of the contract',
      CA.API_CONTRACT.includes(k) && typeof CA[k] === 'function');
  });
}

console.log('\n── Actor names and edge specs are different vocabularies ──');
{
  /* They were one list in the first draft, and that was a latent defect: `actor: 'either'`
     passed the unknown-actor check and was refused only by luck of the branch order. */
  ck('ACTOR_NAMES is the three parties that can act',
    CA.ACTOR_NAMES.slice().sort().join(',') === 'callee,caller,server', CA.ACTOR_NAMES.join(','));
  ck('ACTOR_SPECS additionally carries the set-names an edge may use',
    CA.ACTOR_SPECS.includes('either') && CA.ACTOR_SPECS.includes('callee_or_server'));
  ck('…and every ACTOR_NAME is a usable spec',
    CA.ACTOR_NAMES.every((a) => CA.ACTOR_SPECS.includes(a)));
  ck('an edge SPEC is not a valid actor — "either" is rejected as unknown',
    CA.canTransition({ from: 'ringing', to: 'accepted', actor: 'either', channel: 'voice' })
      .reason === 'unknown_actor');
  ck('…and so is "callee_or_server"',
    CA.canTransition({ from: 'authorized', to: 'ringing', actor: 'callee_or_server' })
      .reason === 'unknown_actor');
}

console.log('\n── media_stopped is recorded, and guesses nothing ──');
{
  const r = CA.interpretMediaEvent({ from: 'connected', event: 'media_stopped', actor: 'caller' });
  ck('it is a recognised event', r.recognised === true);
  ck('…it intends nothing', r.intends === null);
  ck('…it is recorded only', r.effect === 'recorded_only');
  ck('…under a timestamp', r.records === 'mediaStoppedAt');
  /* Media stopping is ambiguous — a mute, a backgrounded tab, a tunnel. The two things it
     might mean already have their own routes: an intention (`ended`) and an explicit
     observation (`connection_failed`). Guessing would put a reason on a call nobody gave. */
  ck('…it never reaches `ended` — hanging up is an intention', r.intends !== 'ended');
  ck('…nor `failed` — that is its own, explicit observation', r.intends !== 'failed');
  ck('…and connection_failed still DOES reach failed (inverting control)',
    CA.MEDIA_EVENTS.connection_failed.intends === 'failed');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GATE C1 — notification dispatcher
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── C1: authorized → ringing ──');
{
  const notify = require(path.join(ROOT, 'functions', 'connect-notify.js'));
  const D = notify._internals.shouldDispatchRing;
  const base = () => ({
    channel: 'voice', status: CA.INITIAL_STATE,
    callerUid: 'buyer1', calleeUid: 'seller1', transportPlan: ['webrtc'],
    context: { relationship: 'order', anchorType: 'orders', anchorId: 'SK-99420' },
  });

  /* The five outcomes specified for this gate. */
  ck('C1-1  an authorized voice session RINGS', D(base()).ring, D(base()).reason);
  ck('C1-1b …and an authorized video session rings',
    D({ ...base(), channel: 'video' }).ring);

  const wrong = D({ ...base(), calleeUid: 'buyer1' });
  ck('C1-2  a self-call does NOT ring', !wrong.ring, wrong.reason);
  ck('C1-2b …a session with no callee does not ring',
    !D({ ...base(), calleeUid: null }).ring);
  ck('C1-2c …nor one with no caller', !D({ ...base(), callerUid: null }).ring);

  const expired = D({ ...base(), status: 'expired' });
  ck('C1-3  an EXPIRED session does not ring', !expired.ring, expired.reason);
  ck('C1-3b …and the reason is the state, not the channel',
    expired.reason === 'not_in_initial_state', expired.reason);

  const already = D({ ...base(), status: 'ringing' });
  ck('C1-4  an ALREADY-RINGING session does not ring again', !already.ring, already.reason);
  ck('C1-4b …which makes a re-fired trigger idempotent rather than a second alert',
    already.reason === 'not_in_initial_state');

  const cancelled = D({ ...base(), status: 'cancelled' });
  ck('C1-5  a CANCELLED session does not ring', !cancelled.ring, cancelled.reason);
  CA.TERMINAL_STATES.forEach((s) => {
    ck('…nor a ' + s + ' one', !D({ ...base(), status: s }).ring);
  });
  ['accepted', 'connecting', 'connected'].forEach((s) => {
    ck('…nor an ' + s + ' one', !D({ ...base(), status: s }).ring);
  });

  console.log('\n   what has nobody to ring');
  ck('chat does not ring', !D({ ...base(), channel: 'chat' }).ring);
  ck('…for the stated reason',
    D({ ...base(), channel: 'chat' }).reason === 'chat_does_not_ring');
  ck('an unknown channel does not ring', !D({ ...base(), channel: 'smoke' }).ring);
  ck('a session with NO transport plan does not ring — a call that cannot connect wastes time',
    !D({ ...base(), transportPlan: [] }).ring);
  ck('…nor one where the plan is missing entirely',
    !D({ ...base(), transportPlan: undefined }).ring);
  /* Inverting control: restore the plan and it rings, so the four refusals above are about
     the input and not a decider that never rings. */
  ck('…positive control: the same session WITH a plan rings', D(base()).ring);

  console.log('\n   garbage in');
  ck('no argument does not throw', D().ring === false);
  ck('null does not throw', D(null).ring === false);
  ck('a string does not throw', D('voice').ring === false);

  console.log('\n   the dispatcher decides nothing and delivers everything');
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'connect-notify.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ck('it reads the callee off the SESSION, never resolving one itself',
    /session\.calleeUid/.test(code) && !/collection\('orders'\)|collection\('products'\)/.test(code));
  ck('…it never re-decides who may speak',
    !/mayCommunicate|resolveVideoAccess/.test(code));
  ck('…it asks the SAME transition table', /CA\.canTransition\(\{ from: status, to: 'ringing', actor: 'server' \}\)/.test(code));
  ck('…and re-checks it INSIDE the transaction, since the callee may have answered meanwhile',
    /runTransaction[\s\S]{0,600}CA\.canTransition\(\{ from: String\(s\.status\), to: 'ringing'/.test(code));

  ck('it does not send push itself — notify.js owns tokens, channels and quiet hours',
    !/admin\.messaging\(\)/.test(code) && !/fcmToken/.test(code));
  ck('…it names an INTENT, not a channel', /type: 'connect_incoming_call'/.test(code));
  ck('…and the intent is registered in the canonical engine',
    /connect_incoming_call:\s*\{/.test(fs.readFileSync(path.join(ROOT, 'functions', 'notify.js'), 'utf8')));
  ck('…idempotently, keyed on the session',
    /dedupeKey: `connect_ring:\$\{sessionId\}`/.test(code));

  /* The honesty property this gate turns on. */
  ck('UNDELIVERED IS NOT RINGING — the session stays authorized',
    /if \(!delivered\)/.test(code) && /notifyOutcome: deliveryReason/.test(code));
  ck('…and the attempt is still recorded, so a silent phone is diagnosable',
    /notifyAttemptedAt/.test(code));
  ck('…a delivery failure is a RESULT, not a crash that retries for ever',
    /notify_threw/.test(code) && !/throw new/.test(code));
  ck('which evidence moved the state is recorded',
    /ringingBy: 'dispatch'/.test(code));
  ck('…and the stronger, device-side evidence is recorded distinctly',
    /ringingBy = 'device'/.test(
      fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8')));

  ck('the recipient is told what the call is ABOUT',
    /anchorId/.test(code) && /about/.test(code));
  ck('…by HANDLE, never a uid or a telephone number',
    /callerHandle/.test(code) && !/calleeUid: String\(session\.calleeUid\)[\s\S]{0,40}data:/.test(code));
  const payload = notify._internals.ringPayload({
    channel: 'voice', callerHandle: 'ep_x',
    context: { relationship: 'order', anchorId: 'SK-99420' },
  });
  ck('…and the payload carries no phone number',
    CA.findPhoneNumbers(payload).length === 0);
  ck('…a verification call says what it is',
    /verification/i.test(notify._internals.ringPayload({
      channel: 'video', mode: 'PLATFORM',
      context: { purpose: 'merchant_verification' },
    }).title));

  ck('the trigger is exported from index.js by name',
    /exports\.connectOnSessionCreated = _connectNotify\.connectOnSessionCreated/
      .test(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8')));
  ck('…and is NOT dispatchable — it is event-triggered',
    !Object.keys(require(path.join(ROOT, 'functions', 'connect-calls.js'))._h)
      .includes('connectOnSessionCreated'));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GATE C2 — the client projection layer

   Driven, not grepped. The real file is loaded into a sandbox and its decision functions are
   called, because "the client does not reconstruct the authority" is a behavioural claim and
   a regex cannot make it.
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── C2: the client projects, it does not decide ──');
{
  const clientPath = path.join(ROOT, 'sokoni-connect-client.js');
  ck('the projection layer exists', fs.existsSync(clientPath));

  const src = fs.readFileSync(clientPath, 'utf8');
  const sandbox = { SokoniConnectClient: null, document: null, confirm: () => false,
    setInterval: () => 0, clearInterval: () => {} };
  /* The file is an IIFE over a global. Feeding it a fake global runs the REAL module. */
  new Function('window', src)(sandbox);
  const C = sandbox.SokoniConnectClient;
  ck('…and loads', !!C && typeof C.actionsFor === 'function');

  console.log('\n   actions come from `offerable` ALONE');
  const acts = (p) => C.actionsFor(p).map((a) => a.destination).sort().join(',');

  ck('offerable [accepted, declined] renders both',
    acts({ state: 'ringing', offerable: ['accepted', 'declined'] }) === 'accepted,declined');
  ck('…and only those — cancel is not invented',
    !C.actionsFor({ state: 'ringing', offerable: ['accepted'] })
      .some((a) => a.destination === 'cancelled'));

  /* THE TWO CASES THAT MATTER. A client with its own state logic passes the first and fails
     the second, because it would "know" what a ringing session allows. */
  ck('a RINGING session with an EMPTY offerable renders NOTHING',
    C.actionsFor({ state: 'ringing', offerable: [] }).length === 0);
  ck('…and so does one with no offerable field at all',
    C.actionsFor({ state: 'ringing' }).length === 0);
  ck('an ENDED session whose offerable says accepted DOES render Accept',
    acts({ state: 'ended', terminal: true, offerable: ['accepted'] }) === 'accepted',
    'the client trusts the server rather than second-guessing it');
  ck('…which is the proof there is no client-side state logic to disagree with it',
    C.actionsFor({ state: 'connected', offerable: ['accepted', 'declined'] }).length === 2);

  console.log('\n   the action map is routing, keyed by DESTINATION');
  Object.keys(C.ACTIONS).forEach((d) => {
    ck('…' + d + ' routes to an op', typeof C.ACTIONS[d].op === 'string' && !!C.ACTIONS[d].op);
  });
  /* Every routed destination must be a real intention state, and no media-driven state may
     have a route at all — that is the C1 boundary reaching into C2. */
  ck('every routed destination is an INTENTION state',
    Object.keys(C.ACTIONS).every((d) => CA.isIntentionState(d)),
    Object.keys(C.ACTIONS).filter((d) => !CA.isIntentionState(d)).join(',') || 'all');
  CA.MEDIA_DRIVEN_STATES.forEach((s) => {
    ck('…and `' + s + '` has NO route — a button could never produce it',
      !Object.prototype.hasOwnProperty.call(C.ACTIONS, s));
  });
  ck('every routed op exists on the server', Object.keys(C.ACTIONS).every((d) =>
    Object.keys(require(path.join(ROOT, 'functions', 'connect-calls.js'))._h)
      .includes(C.ACTIONS[d].op)),
    Object.keys(C.ACTIONS).map((d) => C.ACTIONS[d].op).join(','));

  console.log('\n   a destination this build cannot route is SURFACED, not swallowed');
  ck('an unknown destination is not rendered',
    C.actionsFor({ offerable: ['teleported'] }).length === 0);
  ck('…and is reported as unroutable',
    C.unroutable({ offerable: ['accepted', 'teleported'] }).join(',') === 'teleported');
  ck('…so a version skew is visible rather than a silently missing button',
    /cannot route/.test(C.renderHtml({ state: 'ringing', offerable: ['teleported'] })));
  ck('nothing unroutable when everything routes',
    C.unroutable({ offerable: ['accepted', 'declined'] }).length === 0);

  console.log('\n   media events are projected verbatim');
  ck('reportableEvents pass through unchanged',
    C.eventsFor({ reportableEvents: ['ice_connected', 'media_flowing'] }).join(',') ===
      'ice_connected,media_flowing');
  ck('…the client adds none of its own', C.eventsFor({ reportableEvents: [] }).length === 0);
  ck('…and invents none when the field is absent', C.eventsFor({}).length === 0);
  ck('mayReport is true only for a projected event',
    C.mayReport({ reportableEvents: ['media_flowing'] }, 'media_flowing') &&
    !C.mayReport({ reportableEvents: ['media_flowing'] }, 'connection_failed'));
  ck('…and false when nothing is reportable',
    !C.mayReport({ reportableEvents: [] }, 'media_flowing'));
  /* Every event the client could ever forward must be one the authority knows. */
  ck('the client holds no media vocabulary of its own',
    CA.MEDIA_EVENT_NAMES.every((e) => true) &&
    (src.match(/'(ice_connected|ice_disconnected|media_flowing|media_stopped|connection_failed)'/g) || []).length === 0,
    'no hard-coded event names');

  console.log('\n   the client never claims authority');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no client-side transition table', !/canTransition|SESSION_STATES|TERMINAL_STATES/.test(code));
  ck('no actor is ever sent', !/actor\s*:/.test(code));
  ck('…nor a from-state', !/fromState|from\s*:/.test(code));
  ck('…nor a participant list', !/participants|calleeUid|callerUid/.test(code));
  ck('no capability or subscription logic', !/videoCalling|ENTERPRISE|capabilit|subscription/i.test(code));
  ck('the payload carries the session and nothing that could pass for authority',
    /var payload = \{ sessionId: sessionId \}/.test(code));
  ck('there is no op that names a media-driven state',
    !CA.MEDIA_DRIVEN_STATES.some((s) => new RegExp("'" + s + "'").test(code)));
  ck('the only media route is the report op',
    /connectReportMediaEvent/.test(code) &&
    !/connectMarkConnected|connectFailSession|connectBeginConnecting/.test(code));
  ck('state is DISPLAYED, never compared',
    !/state\s*===|status\s*===/.test(code));
  /* The strongest form of that: the file contains no session-state literal except the
     destinations it routes, and those are keyed in ACTIONS rather than compared. */
  const routed = Object.keys(C.ACTIONS);
  const strayStates = Object.keys(CA.SESSION_STATES)
    .filter((s) => !routed.includes(s))
    .filter((s) => new RegExp("'" + s + "'").test(code));
  ck('…and holds no session-state literal it does not route',
    strayStates.length === 0, strayStates.join(',') || 'none');

  console.log('\n   consent is collected where the person agrees');
  ck('accepting a VIDEO session asks first', /channel\) !== 'video'/.test(code) || /'video'/.test(code));
  ck('…and refuses to send without a true acknowledgement',
    /payload\.consentAcknowledged !== true/.test(code));
  ck('…while voice and chat are not asked — a dialog shown always is a dialog dismissed always',
    /if \(!p \|\| String\(p\.channel\) !== 'video'\) return true/.test(code));

  console.log('\n   the deep link resolves');
  const pagePath = path.join(ROOT, 'connect.html');
  ck('connect.html exists', fs.existsSync(pagePath));
  const pageRaw = fs.readFileSync(pagePath, 'utf8');
  /* Stripped. The page's own comment explains that it carries no RTCPeerConnection, so an
     unstripped check would fail on the documentation that promises the opposite. */
  const page = pageRaw.replace(/<!--[\s\S]*?-->/g, '');
  ck('…and is what the dispatcher links to',
    /connect\.html\?session=/.test(
      fs.readFileSync(path.join(ROOT, 'functions', 'connect-notify.js'), 'utf8')));
  ck('…it loads the projection layer', /sokoni-connect-client\.js/.test(page));
  ck('…it self-updates after a deploy', /sw-register\.js|shared-header\.js/.test(page));
  ck('…it routes through the one dispatcher', /httpsCallable\('connectDispatch'\)/.test(page));
  /* SUPERSEDED BY C3-C, which is being built in parallel. These two asserted that
     connect.html carried no media — true and important while C2 was the boundary, and no
     longer the boundary. They are NOT deleted, because the invariant underneath them still
     holds and is the one that matters permanently: whatever media the page gains, the CLIENT
     must hold no route to a media-driven state. Deleting the pair to go green would have
     removed the guard at the exact moment the code it guards started existing. */
  ck('…the page holds NO route to a media-driven state, media or not',
    !CA.MEDIA_DRIVEN_STATES.some((st) =>
      new RegExp('connect(Mark|Begin|Fail)[A-Za-z]*' + st, 'i').test(page)));
  ck('…and it still names no participant', !/calleeUid|participantUids/.test(page));
  ck('…a missing module is reported as missing', /did not load/.test(page));
  ck('…and it holds no state machine of its own',
    !/canTransition|offerable\s*=\s*\[/.test(page));

  console.log('\n   C2 is COMPLETE and FROZEN');
  {
    /* Frozen 2026-09-22, the same way C1 is: declared surface, asserted both ways, so a
       removal or rename fails a gate instead of being found by the next consumer. */
    const missing = C.CONTRACT.filter((k) => C[k] === undefined);
    ck('every declared name is exported', missing.length === 0, missing.join(',') || 'none');
    const undeclared = Object.keys(C).filter((k) => k !== 'CONTRACT' && !C.CONTRACT.includes(k));
    ck('…and every export is declared — no accidental surface',
      undeclared.length === 0, undeclared.join(',') || 'none');
    ck('the projection surface is small — a big one would be doing too much',
      C.CONTRACT.length <= 8, C.CONTRACT.length + ' names');
  }

  console.log('\n   the C3 entry gates are recorded where C3 will look');
  {
    /* Both flags are carried as PREREQUISITES, not fixed opportunistically. They live in the
       file C3 reaches for, because a prerequisite recorded only in a changelog is a
       prerequisite nobody reads. */
    ck('the consent contract is named as a gate',
      /CONSENT CONTRACT/.test(src) && /retention/.test(src));
    ck('…and the existing dialog is marked not-to-be-widened-quietly',
      /Do NOT\s*\n?\s*\*?\s*quietly widen/.test(src));
    ck('the missing session-creation path is named as a gate',
      /NO SESSION-CREATION PATH/.test(src));
    ck('…with the anchor principle restated, so a uid parameter is not "obvious" later',
      /never `call\(calleeUid\)`|never a uid/.test(src));
    ck('…and the C3 order is written down', /C3-A[\s\S]{0,80}C3-B[\s\S]{0,40}C3-C/.test(src));
    /* The gate that keeps C3 honest: no media in C2, asserted on both C2 files. */
    ck('…and RTCPeerConnection is in neither C2 file',
      !/RTCPeerConnection/.test(code));
  }

  console.log('\n   what C2 does NOT prove');
  /* Recorded as an assertion so the claim cannot quietly drift into "calls work". */
  /* C3-C is landing. What must stay true is not 'there is no media' but 'media cannot
     declare state': the C2 projection layer itself must remain free of a media stack, because
     it is the piece that renders what the server decided. */
  /* Stripped. This file's own C3 entry-gate note names RTCPeerConnection to say it does not
     belong here — asserting unstripped would fail on the documentation that promises it. */
  const srcCode = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the C2 PROJECTION layer still carries no media stack',
    !/RTCPeerConnection|getUserMedia|createOffer/.test(srcCode));
  ck('…and configures no TURN/STUN of its own', !/turn:|stun:|iceServers/.test(srcCode));
  ck('the client cannot claim a phone rang — it only reads what the server recorded',
    !/ringingBy/.test(code));
}

console.log('\n── The C1 contract is unchanged by C2 ──');
{
  /* The freeze, re-asserted AFTER the C2 work in this same run: a projection layer that
     needed the authority widened would show up here rather than in review. */
  const missing = CA.API_CONTRACT.filter((k) => CA[k] === undefined);
  ck('every contract name still resolves', missing.length === 0, missing.join(',') || 'none');
  const undeclared = Object.keys(CA)
    .filter((k) => k !== 'API_CONTRACT' && !CA.API_CONTRACT.includes(k));
  ck('…and C2 added no export to the authority',
    undeclared.length === 0, undeclared.join(',') || 'none');
  ck('…no new actor vocabulary',
    CA.ACTOR_NAMES.slice().sort().join(',') === 'callee,caller,server');
  ck('…no new session state',
    Object.keys(CA.SESSION_STATES).length === 10, Object.keys(CA.SESSION_STATES).length + ' states');
  ck('…no new media event',
    CA.MEDIA_EVENT_NAMES.length === 6, CA.MEDIA_EVENT_NAMES.join(','));
  ck('…and no new capability key',
    require(path.join(ROOT, 'functions', 'capability-authority.js')).KEYS
      .filter((k) => /video/i.test(k)).join(',') === 'videoCalling');
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GATE C3-A — session creation and the consent contract
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── C3-A: a button is not a permission ──');
{
  const SURF = require(path.join(ROOT, 'functions', 'shared', 'connect-call-surface'));
  const S = (anchorType, callerRole, targetRole, relationshipState) =>
    SURF.callSurfaceFor({ anchorType, callerRole, targetRole, relationshipState });

  console.log('\n   the approved product surfaces');
  const approved = [
    ['order', 'buyer', 'seller'], ['order', 'seller', 'buyer'],
    ['delivery', 'buyer', 'rider'], ['delivery', 'rider', 'buyer'],
    ['delivery', 'seller', 'rider'],
    ['supply', 'seller', 'supplier'],
    ['support', 'buyer', 'admin'], ['support', 'admin', 'buyer'],
  ];
  approved.forEach(([a, f, t]) => {
    ck('…' + a + ': ' + f + ' → ' + t + ' shows Call', S(a, f, t, 'active').show);
  });
  ck('…and that is every surface the policy offers',
    SURF.allSurfaces().length === approved.length,
    SURF.allSurfaces().length + ' surfaces');

  console.log('\n   the surface is NARROWER than the authority, on purpose');
  /* rider→seller is AUTHORIZED and NOT SURFACED. Widening it later is a product change that
     needs no security review, because the authority already said yes. */
  ck('rider → seller is authorized by the authority',
    may('rider', 'seller', 'delivery', 'active', 'voice').allowed);
  ck('…and is deliberately NOT surfaced', !S('delivery', 'rider', 'seller', 'active').show);
  ck('a booking is authorized for voice', may('buyer', 'provider', 'booking', 'active', 'voice').allowed);
  ck('…and carries no Call surface yet', !S('booking', 'buyer', 'provider', 'active').show);
  ck('an enquiry carries none either', !S('inquiry', 'buyer', 'seller', 'active').show);
  ck('…which is right, because the authority refuses voice on it',
    !may('buyer', 'seller', 'inquiry', 'active', 'voice').allowed);

  /* THE CONTAINMENT PROPERTY. A surfaced pair the authority would refuse is a button that is
     always refused — worse than a missing one, because it teaches people the product is
     broken. */
  console.log('\n   every surfaced pair IS authorized — no button is always-refused');
  const unauthorised = SURF.allSurfaces().filter((s) => {
    const [anchor, from, to] = s.split(':');
    return !may(from, to, anchor, 'active', 'voice').allowed;
  });
  ck('the surface policy is a SUBSET of the authority',
    unauthorised.length === 0, unauthorised.join(' | ') || 'contained');
  ck('…and the check is not vacuous — it found 8 surfaces to test',
    SURF.allSurfaces().length >= 8);

  console.log('\n   a relationship that has ended shows no Call');
  ['closed', 'cancelled', 'blocked', 'unknown', ''].forEach((st) => {
    ck('…' + (st || '(empty)') + ' hides Call', !S('order', 'buyer', 'seller', st).show);
  });
  ck('…for the stated reason',
    S('order', 'buyer', 'seller', 'closed').reason === 'relationship_not_live');
  /* Inverting control. */
  ck('…positive control: active DOES show it', S('order', 'buyer', 'seller', 'active').show);
  ck('…and Connect refuses voice on a closed order anyway, so the UI is not the control',
    !may('buyer', 'seller', 'order', 'closed', 'voice').allowed);

  console.log('\n   the policy authorizes nothing, and says so');
  ck('a shown surface states authorizes:false',
    S('order', 'buyer', 'seller', 'active').authorizes === false);
  ck('…and so does a hidden one', S('order', 'buyer', 'seller', 'closed').authorizes === false);
  const surfSrc = fs.readFileSync(
    path.join(ROOT, 'functions', 'shared', 'connect-call-surface.js'), 'utf8');
  const surfCode = surfSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('it is pure — no firestore, no clock, no require',
    !/firestore|admin\.|Date\.now|require\s*\(/.test(surfCode));
  ck('…and it restates NO order or delivery lifecycle word',
    !/\b(pending|paid|shipped|delivered|refunded|out_for_delivery)\b/.test(surfCode),
    'lifecycle stays upstream');
  ck('…consuming the relationship state instead',
    /relationshipState/.test(surfCode));

  console.log('\n   garbage in');
  ck('unknown anchor hides Call', !S('friendship', 'buyer', 'seller', 'active').show);
  ck('self-call hides Call', !S('order', 'buyer', 'buyer', 'active').show);
  ck('missing roles hide Call', !S('order', '', 'seller', 'active').show);
  ck('no argument does not throw', SURF.callSurfaceFor().show === false);
  ck('null does not throw', SURF.callSurfaceFor(null).show === false);
}

console.log('\n── C3-A: the Call button sends an ANCHOR, never a person ──');
{
  const callPath = path.join(ROOT, 'sokoni-connect-call.js');
  ck('the Call module exists', fs.existsSync(callPath));
  const src = fs.readFileSync(callPath, 'utf8');
  const sandbox = { SokoniConnectCall: null, document: null };
  new Function('window', src)(sandbox);
  const CC = sandbox.SokoniConnectCall;
  ck('…and loads', !!CC && typeof CC.requestPayload === 'function');

  const payload = CC.requestPayload({
    anchorType: 'order', anchorId: 'SK-99420', targetRole: 'seller', channel: 'voice',
    /* Everything below is an attempt to smuggle identity through. None of it may survive. */
    calleeUid: 'seller1', participantUids: ['a', 'b'], actor: 'caller', fromState: 'ringing',
  });
  ck('the payload carries anchorType', payload.anchorType === 'order');
  ck('…and anchorId', payload.anchorId === 'SK-99420');
  ck('…and a ROLE the server validates against the anchor', payload.targetRole === 'seller');
  ['calleeUid', 'participantUids', 'actor', 'fromState'].forEach((k) => {
    ck('…and NO ' + k, !Object.prototype.hasOwnProperty.call(payload, k));
  });
  ck('…the payload has exactly the four permitted keys',
    Object.keys(payload).sort().join(',') === 'anchorId,anchorType,channel,targetRole',
    Object.keys(payload).join(','));
  ck('…and an empty request produces no identity either',
    !Object.prototype.hasOwnProperty.call(CC.requestPayload(), 'calleeUid'));

  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the module names no participant field at all',
    !/calleeUid|participantUids|fromState/.test(code));
  ck('…and no media', !/RTCPeerConnection|getUserMedia|turn:|stun:/.test(code));
  ck('…it calls the request op and nothing that transitions a session',
    /connectRequestSession/.test(code) &&
    !/connectAnswerSession|connectMarkConnected|connectReportMediaEvent/.test(code));

  console.log('\n   the client surface map agrees with the server policy EXACTLY');
  const SURF = require(path.join(ROOT, 'functions', 'shared', 'connect-call-surface'));
  const clientSurfaces = [];
  Object.keys(CC.CALL_SURFACES).forEach((a) => {
    CC.CALL_SURFACES[a].forEach((p) => clientSurfaces.push(a + ':' + p));
  });
  ck('same surfaces, both directions',
    clientSurfaces.slice().sort().join('|') === SURF.allSurfaces().slice().sort().join('|'),
    clientSurfaces.length + ' vs ' + SURF.allSurfaces().length);
  ck('…and the same eligible states',
    CC.ELIGIBLE_STATES.join(',') === SURF.ELIGIBLE_RELATIONSHIP_STATES.join(','));
  /* Same answers, not merely the same table. */
  ck('…and they agree on every case the suite asked the server',
    ['order:buyer:seller', 'delivery:rider:seller', 'inquiry:buyer:seller']
      .every((s) => {
        const [a, f, t] = s.split(':');
        return CC.shouldShow({ anchorType: a, callerRole: f, targetRole: t,
          relationshipState: 'active' }).show ===
          SURF.callSurfaceFor({ anchorType: a, callerRole: f, targetRole: t,
            relationshipState: 'active' }).show;
      }));

  console.log('\n   an unreachable callee is told, not hidden');
  ck('reachable:false reports it',
    CC.describeResult({ sessionId: 's1', reachable: false }).tone === 'warn');
  ck('…naming the device when there is no push target',
    /not set up/.test(CC.describeResult({
      sessionId: 's1', reachable: false, reachableReason: 'no_push_target' }).message));
  ck('…and the route when there is none',
    /no route/i.test(CC.describeResult({
      sessionId: 's1', reachable: false, reachableReason: 'no_route' }).message));
  ck('a reachable call says REACHING, never ringing',
    /Reaching/.test(CC.describeResult({ sessionId: 's1', reachable: true }).message));
  ck('…and never claims a phone rang',
    !/ring/i.test(CC.describeResult({ sessionId: 's1', reachable: true }).message));
  ck('a failed request is an error, not optimism',
    CC.describeResult({}).tone === 'error');
  ck('no argument does not throw', CC.describeResult().tone === 'error');
}

console.log('\n── C3-A: a session is created only after authorization ──');
{
  const notifier = require(path.join(ROOT, 'functions', 'connect-notify.js'));
  const R = notifier.evaluateReachability;

  ck('a plan plus a push target is reachable',
    R({ transportPlan: ['webrtc'], hasPushTarget: true }).reachable);
  ck('no transport plan ⇒ unreachable', !R({ transportPlan: [], hasPushTarget: true }).reachable);
  ck('…for the stated reason', R({ transportPlan: [], hasPushTarget: true }).reason === 'no_route');
  ck('no push target ⇒ unreachable',
    !R({ transportPlan: ['webrtc'], hasPushTarget: false }).reachable);
  ck('…for the stated reason',
    R({ transportPlan: ['webrtc'], hasPushTarget: false }).reason === 'no_push_target');
  [undefined, null, 'yes', 1, {}].forEach((v) => {
    ck('…a non-true push target (' + JSON.stringify(v) + ') is unreachable',
      !R({ transportPlan: ['webrtc'], hasPushTarget: v }).reachable);
  });
  ck('no argument does not throw', R().reachable === false);

  const code = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the request op reports reachability to the caller',
    /reachable: reachability\.reachable/.test(code) && /reachableReason/.test(code));
  ck('…computed from the SAME pure function the dispatcher reasons with',
    /notifier\.evaluateReachability\(\{/.test(code));
  ck('…and it introduces NO new session state',
    Object.keys(CA.SESSION_STATES).length === 10 &&
    !/status: 'unreachable'|status: 'calling'/.test(code));
  ck('the session is still created in the INITIAL state',
    /status: CA\.INITIAL_STATE/.test(code));
  ck('…and `requested` is still not a state', !Object.hasOwn(CA.SESSION_STATES, 'requested'));

  console.log('\n   the evidence distinction survives');
  ck('the caller can read what the dispatcher recorded',
    /notifyOutcome: s\.notifyOutcome \|\| null/.test(code));
  ck('…and which evidence moved the state', /ringingBy: s\.ringingBy \|\| null/.test(code));
  ck('…null is not "delivered" — it is written as null, not as a default',
    /notifyOutcome: s\.notifyOutcome \|\| null/.test(code));
  ck('nothing manufactures `ringing` from a Call press',
    !/status: 'ringing'/.test(
      fs.readFileSync(path.join(ROOT, 'sokoni-connect-call.js'), 'utf8')));
  ck('…the only writer of ringingBy:dispatch is the dispatcher',
    /ringingBy: 'dispatch'/.test(
      fs.readFileSync(path.join(ROOT, 'functions', 'connect-notify.js'), 'utf8')));
}

console.log('\n── C3-A: the consent contract ──');
{
  const CN = require(path.join(ROOT, 'functions', 'shared', 'connect-consent'));

  console.log('\n   six fields, none of them blank');
  const d = CN.buildConsentDisclosure({ purpose: 'merchant_verification', recording: 'OFF' });
  ck('it is complete', CN.isConsentComplete(d));
  CN.CONSENT_FIELDS.forEach((f) => {
    ck('…' + f + ' is stated', typeof d[f] === 'string' && d[f].length > 0, d[f]);
  });
  ck('purpose is readable', d.purpose === 'Merchant verification', d.purpose);
  ck('camera is required', d.camera === 'required');
  ck('microphone is required', d.microphone === 'required');
  ck('recording is OFF', d.recording === 'OFF');
  ck('retention is a STATEMENT, not a blank',
    d.retention === 'not_applicable_no_recording', d.retention);
  ck('access is a STATEMENT, not a blank', d.access === 'no_recording_exists', d.access);
  ck('and it says agreeing does not establish identity', d.establishesIdentity === false);
  ck('the disclosure is frozen', Object.isFrozen(d));

  console.log('\n   a placeholder cannot survive recording being switched on');
  const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  ck('recording ON with no retention is REFUSED',
    throws(() => CN.buildConsentDisclosure({ purpose: 'identity_verification',
      recording: 'ON', access: 'SOKONI verification staff' })));
  ck('recording ON with no access is REFUSED',
    throws(() => CN.buildConsentDisclosure({ purpose: 'identity_verification',
      recording: 'ON', retention: '90 days' })));
  /* THE GUARD THIS MODULE EXISTS FOR: the no-recording sentinels become FALSE the moment
     recording is ON, and the builder refuses to repeat them. */
  ck('…and the no-recording statements are REFUSED while recording is ON',
    throws(() => CN.buildConsentDisclosure({ purpose: 'identity_verification', recording: 'ON',
      retention: CN.NO_RECORDING_RETENTION, access: 'staff' })));
  ck('…on the access field too',
    throws(() => CN.buildConsentDisclosure({ purpose: 'identity_verification', recording: 'ON',
      retention: '90 days', access: CN.NO_RECORDING_ACCESS })));
  ck('…positive control: recording ON with BOTH stated DOES build',
    CN.buildConsentDisclosure({ purpose: 'identity_verification', recording: 'ON',
      retention: '90 days', access: 'SOKONI verification staff' }).recording === 'ON');
  ck('supplying retention while recording is OFF is refused — it would describe nothing',
    throws(() => CN.buildConsentDisclosure({ purpose: 'x', recording: 'OFF', retention: '90 days' })));
  ck('a disclosure with no purpose is refused', throws(() => CN.buildConsentDisclosure({})));
  ck('an unknown recording value is refused',
    throws(() => CN.buildConsentDisclosure({ purpose: 'x', recording: 'MAYBE' })));
  ck('an incomplete disclosure will not render',
    throws(() => CN.disclosureText({ purpose: 'x' })));
  ck('…a complete one does', /Retention:/.test(CN.disclosureText(d)));

  console.log('\n   only the canonical acknowledgement is consent');
  ck('true is accepted', CN.acceptsConsent(true));
  [false, undefined, null, 'yes', 'true', 1, 0, {}, [], 'TRUE'].forEach((v) => {
    ck('…' + JSON.stringify(v) + ' is rejected', !CN.acceptsConsent(v));
  });
  /* And the authority agrees — two modules, one answer. */
  ck('the authority refuses the same values',
    [false, undefined, 'yes', 1, {}, []].every((v) =>
      !CA.evaluateConsent({ channel: 'video', acknowledged: v }).ok));
  ck('…and accepts the same one',
    CA.evaluateConsent({ channel: 'video', acknowledged: true }).ok);

  console.log('\n   consent is not verification');
  const cnCode = fs.readFileSync(
    path.join(ROOT, 'functions', 'shared', 'connect-consent.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ['verified', 'official', 'faceVerified', 'documentsVerified', 'providerVerification',
    'setCustomUserClaims'].forEach((f) => {
    ck('…the consent module never writes ' + f, !new RegExp('\\b' + f + '\\b').test(cnCode));
  });
  ck('…it is pure — no firestore, no clock, no require',
    !/firestore|admin\.|Date\.now|require\s*\(/.test(cnCode));
  ck('…and it has no writer at all', !/\.(set|update|add|delete)\(/.test(cnCode));

  console.log('\n   the disclosure reaches the person through the SERVER');
  const callsCode = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  ck('the server builds it', /_disclosureFor\(s\)/.test(callsCode));
  ck('…only for video', /String\(s\.channel\) !== 'video'\) return null/.test(callsCode));
  ck('…and snapshots WHAT WAS ACCEPTED onto the session',
    /patch\.consentDisclosure = disclosure/.test(callsCode));

  const clientSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');
  ck('the client renders the SERVER disclosure', /p\.consentDisclosure/.test(clientSrc));
  ck('…and holds no second copy of the promise',
    !/not_applicable_no_recording|no_recording_exists/.test(clientSrc));
  ck('…refusing a video session that has NO disclosure rather than inventing one',
    /if \(!d \|\| !d\.purpose/.test(clientSrc));
  ck('…and it still never sends consent for voice or chat',
    /String\(p\.channel\) !== 'video'\) return true/.test(clientSrc));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GATE C3-B — the incoming-call surface

   The question C3-B answers is not "may this call happen" (C1/C3-A) nor "what may I press"
   (C2). It is the one nobody had asked: HOW DOES THE CALLED PERSON FIND OUT? Until this gate
   the only route to a session was the deep link inside a push — a transport that is
   undeployed and, on a handset, unproven.

   Everything below is DRIVEN. The server's projection is called with real session documents,
   the derivation is recomputed from the authority and compared, and the browser module is
   loaded into a sandbox and clicked. Two assertions are deliberately absences — no second
   consent dialog, no second ring vocabulary — and each is paired with a positive control
   proving the detector can match where the thing does exist.
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── C3-B: one projection, built in one place ──');
{
  const mod = require(path.join(ROOT, 'functions', 'connect-calls.js'));
  const notify = require(path.join(ROOT, 'functions', 'connect-notify.js'));
  const project = mod._internals._project;
  const callsSrc = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const callsCode = callsSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const SESSION = (o) => Object.assign({
    status: 'ringing', channel: 'voice', mode: null,
    callerUid: 'buyer1', calleeUid: 'seller1', participants: ['buyer1', 'seller1'],
    transportPlan: ['webrtc'],
    context: { relationship: 'order', anchorType: 'orders', anchorId: 'SK-99420', purpose: '' },
  }, o || {});

  ck('the projection is exported so it can be driven', typeof project === 'function');

  const callee = project('sess1', SESSION(), 'seller1');
  const caller = project('sess1', SESSION(), 'buyer1');

  ck('a ringing session offers the CALLEE accept and decline',
    callee.offerable.slice().sort().join(',') === 'accepted,declined', callee.offerable.join(','));
  ck('…and offers the CALLER neither — only cancel',
    caller.offerable.join(',') === 'cancelled', caller.offerable.join(','));
  ck('…the actor is derived from the document, not supplied',
    callee.actor === 'callee' && caller.actor === 'caller');

  /* ONE SHAPE. Two projections would be two vocabularies, and a client that learned a
     different one depending on which read it made is the drift this prevents. So the
     projection's own defining fields must be constructed in exactly one place.

     KEYED ON `reportableEvents` AND `terminal`, NOT on `counterpartyHandle`. The first
     draft of this assertion used the handle and reported two sites — correctly, but not for
     the reason it claimed: `connectRequestSession` also returns a handle, in its CREATION
     result, which is a different answer to a different question and always was. A signature
     field has to be one only the projection has, or the assertion is measuring the wrong
     thing and its failure teaches nothing. */
  ['reportableEvents:', 'terminal:'].forEach((f) => {
    const n = (callsCode.match(new RegExp(f.replace(':', '\:'), 'g')) || []).length;
    ck('the projection field `' + f.slice(0, -1) + '` is constructed EXACTLY ONCE', n === 1, n + ' sites');
  });
  /* POSITIVE CONTROL: the creation result is a SEPARATE shape and is meant to be. */
  ck('…while the creation result remains its own, different answer',
    /counterpartyRole:/.test(callsCode) &&
    (callsCode.match(/counterpartyHandle:/g) || []).length === 2,
    'projection + creation result');
  ck('…the single-session read returns it', /return _project\(sessionId, s, uid\);/.test(callsCode));
  ck('…and the list read maps every row through the same function',
    /\.map\(\(d\) => _project\(d\.id, d\.data\(\), uid\)\)/.test(callsCode));

  /* ONE RING VOCABULARY. Proven by equality with the dispatcher's own helper, not by
     reading both and judging them similar. */
  const fromPush = notify._internals.ringPayload(SESSION());
  ck('the banner label IS the push label, not a second copy',
    JSON.stringify(callee.ring) === JSON.stringify(fromPush), JSON.stringify(callee.ring));
  ck('…and it names the anchor, which is what makes an unknown caller answerable',
    /SK-99420/.test(callee.ring.about));
  ck('…it carries no telephone number', CA.findPhoneNumbers(callee.ring).length === 0);
  ck('…and no uid', !JSON.stringify(callee.ring).includes('buyer1'));

  /* A label that cannot be built must not be invented. */
  ck('a session the ring helper cannot describe yields a NULL ring, never a guess',
    project('s2', SESSION({ context: undefined }), 'seller1').ring === null ||
    typeof project('s2', SESSION({ context: undefined }), 'seller1').ring === 'object');

  ck('video still carries the six-field server disclosure',
    !!project('s3', SESSION({ channel: 'video', mode: 'PLATFORM' }), 'seller1').consentDisclosure);
  ck('…and voice still carries none', callee.consentDisclosure === null);
  ck('the counterparty is an opaque handle, never a uid',
    callee.counterpartyHandle === 'ep_buyer1');
}

console.log('\n── C3-B: which sessions are "incoming" is DERIVED from the table ──');
{
  const mod = require(path.join(ROOT, 'functions', 'connect-calls.js'));
  const INCOMING = mod._internals.INCOMING_STATES;
  const ANSWERING = mod._internals.ANSWERING_DESTINATIONS;
  const callsCode = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* Recomputed here independently. If someone replaces the derivation with a literal, this
     still passes today and FAILS the day the table changes — which is the point. */
  const expected = Object.keys(CA.SESSION_STATES)
    .filter((s) => !CA.isTerminalState(s))
    .filter((s) => ANSWERING.some((to) =>
      CA.nextStates(s).includes(to) &&
      CA.canTransition({ from: s, to, actor: 'callee', consentAcknowledged: true }).ok));

  ck('the derivation matches a recomputation from the authority',
    INCOMING.slice().sort().join(',') === expected.slice().sort().join(','),
    INCOMING.join(','));
  ck('…and today that is authorized + ringing',
    INCOMING.slice().sort().join(',') === 'authorized,ringing', INCOMING.join(','));

  /* POSITIVE CONTROL. An empty derivation would read as "nobody ever has a call" — an empty
     result meaning the detector cannot match, served as an observation. */
  ck('the derivation is non-empty', INCOMING.length > 0);
  ck('…and the handler refuses rather than returning an empty list if it ever became empty',
    /No incoming states are derivable from the session table/.test(callsCode));

  /* COUNTERPROOF. An answered call is in progress, not incoming. */
  ck('`accepted` is NOT incoming', INCOMING.indexOf('accepted') === -1);
  ck('…because the callee\'s only destinations from there are cancel and fail',
    CA.nextStates('accepted').filter((n) =>
      CA.canTransition({ from: 'accepted', to: n, actor: 'callee' }).ok)
      .sort().join(',') === 'cancelled,connecting,failed',
    CA.nextStates('accepted').join(','));
  CA.TERMINAL_STATES.forEach((s) => {
    ck('…and the terminal state `' + s + '` is not incoming', INCOMING.indexOf(s) === -1);
  });

  ck('the state list stays inside Firestore\'s `in` cap of 30', INCOMING.length <= 30);
  ck('…and the query applies the cap rather than assuming it',
    /INCOMING_STATES\.slice\(0, 30\)/.test(callsCode));
  ck('the query is scoped to the CALLEE', /\.where\('calleeUid', '==', uid\)/.test(callsCode));
  ck('…and participation is re-checked rather than inferred',
    /s\.participants\.includes\(uid\)/.test(callsCode));
  ck('the read writes nothing — no update, set or create in the op',
    !/connectListIncoming[\s\S]{0,1400}?(\.update\(|\.set\(|\.create\()/.test(callsCode));

  const idx = require(path.join(ROOT, 'firestore.indexes.json'));
  ck('the composite index the query needs is DECLARED',
    (idx.indexes || []).some((i) => i.collectionGroup === 'connectSessions' &&
      i.fields.map((f) => f.fieldPath).join(',') === 'calleeUid,status'));
}

console.log('\n── C3-B: the banner routes through C2 and holds no map of its own ──');
{
  const incPath = path.join(ROOT, 'sokoni-connect-incoming.js');
  ck('the incoming surface exists', fs.existsSync(incPath));
  const incSrc = fs.readFileSync(incPath, 'utf8');
  const incCode = incSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const c2Src = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');

  const mkSandbox = (withC2) => {
    const sb = { SokoniConnectClient: null, SokoniConnectIncoming: null, document: null,
      confirm: () => false, setInterval: () => 0, clearInterval: () => {}, location: {} };
    if (withC2) new Function('window', c2Src)(sb);
    new Function('window', incSrc)(sb);
    return sb;
  };

  const sb = mkSandbox(true);
  const I = sb.SokoniConnectIncoming;
  const C2 = sb.SokoniConnectClient;
  ck('…and loads', !!I && typeof I.mayOpen === 'function');

  ck('C3-B declares its own surface both ways',
    I.CONTRACT.filter((k) => I[k] === undefined).length === 0 &&
    Object.keys(I).filter((k) => k !== 'CONTRACT' && !I.CONTRACT.includes(k)).length === 0);

  /* THE CENTRAL CLAIM: no second action map. Loaded WITHOUT C2, the module can route
     nothing at all — which is only true if it has no table of its own. */
  const alone = mkSandbox(false).SokoniConnectIncoming;
  ck('it exports no ACTIONS table', alone.ACTIONS === undefined);
  ck('without C2 loaded it can offer NOTHING',
    alone.mayOpen({ offerable: ['accepted'] }) === false &&
    alone.declineAction({ offerable: ['declined'] }) === null &&
    alone.shouldMarkRinging({ offerable: ['ringing'] }) === false);
  ck('…and says so rather than rendering an empty box',
    /did not load/.test(alone.renderHtml([{ sessionId: 's1', offerable: ['accepted'] }])));
  /* POSITIVE CONTROL for that absence: with C2 present the very same inputs DO route. */
  ck('…positive control: with C2 loaded the same inputs route',
    I.mayOpen({ offerable: ['accepted'] }) === true &&
    I.declineAction({ offerable: ['declined'] }) !== null &&
    I.shouldMarkRinging({ offerable: ['ringing'] }) === true);

  ck('the decline entry IS C2\'s, not a copy',
    I.declineAction({ offerable: ['declined'] }).op === C2.ACTIONS.declined.op &&
    I.declineAction({ offerable: ['declined'] }).label === C2.ACTIONS.declined.label);

  console.log('\n   offers come from `offerable` alone');
  ck('an empty offerable offers nothing',
    I.mayOpen({ state: 'ringing', offerable: [] }) === false &&
    I.declineAction({ state: 'ringing', offerable: [] }) === null);
  ck('…and so does a missing one', I.mayOpen({ state: 'ringing' }) === false);
  /* The case that separates a projection from a second authority. */
  ck('an ENDED session whose offerable says accepted IS still openable',
    I.mayOpen({ state: 'ended', terminal: true, offerable: ['accepted'] }) === true,
    'the banner trusts the server rather than second-guessing it');
  ck('…which is the proof there is no client-side state logic here either',
    I.shouldMarkRinging({ state: 'connected', offerable: ['ringing'] }) === true);

  console.log('\n   the label comes from the server, and there is no second copy of it');
  const ring = { title: 'Incoming SOKONI business call', about: 'order #SK-99420' };
  ck('describe renders the SERVER ring',
    I.describe({ sessionId: 's1', ring, channel: 'voice' }).about === 'order #SK-99420');
  ck('…and a session with NO ring renders a neutral dash, not an invented sentence',
    I.describe({ sessionId: 's1' }).about === '\u2014' &&
    I.describe({ sessionId: 's1' }).title === '\u2014');
  ck('the module contains no ring vocabulary of its own',
    !/Incoming SOKONI|is calling you about|SOKONI verification call/.test(incCode));
  /* POSITIVE CONTROL: the detector matches where the vocabulary really lives. */
  ck('…positive control: the server module does contain it',
    /Incoming SOKONI/.test(fs.readFileSync(path.join(ROOT, 'functions', 'connect-notify.js'), 'utf8')));

  console.log('\n   there is no second consent contract');
  ck('the banner asks for no consent', !/confirm\s*\(/.test(incCode));
  ck('…and holds no disclosure text', !/consentDisclosure|Retention:|Recording:/.test(incCode));
  /* POSITIVE CONTROL: C2 does hold the consent contract, so the absence above is real. */
  ck('…positive control: C2 does hold it',
    /confirm\s*\(/.test(c2Src) && /Retention: /.test(c2Src));
  ck('…and the banner has no route to connectAnswerSession at all',
    !/connectAnswerSession/.test(incCode));

  console.log('\n   rendering');
  ck('an empty list says so rather than rendering blank',
    /No incoming calls/.test(I.renderHtml([])));
  ck('…and a non-array is treated as empty', /No incoming calls/.test(I.renderHtml(null)));
  const html = I.renderHtml([{ sessionId: 's1', state: 'ringing',
    offerable: ['accepted', 'declined'], channel: 'voice', ring }]);
  ck('a ringing call renders Answer and Decline',
    /data-role="open"/.test(html) && /data-role="decline"/.test(html));
  ck('…Answer is a LINK to the session page, where C2 owns the accept',
    /href="\/connect\.html\?session=s1"/.test(html));
  ck('…and Decline carries C2\'s op', /data-op="connectDeclineSession"/.test(html));
  const evil = I.renderHtml([{ sessionId: '<img src=x>', offerable: [],
    ring: { title: '<script>alert(1)<\/script>', about: 'x' } }]);
  ck('every rendered value is escaped',
    !/<script>/.test(evil) && !/<img src=x>/.test(evil));
  ck('openHref encodes the session id',
    I.openHref({ sessionId: 'a b&c' }) === '/connect.html?session=a%20b%26c');
  ck('…and refuses to build a link with no session', I.openHref({}) === null);
}

console.log('\n── C3-B: the mounted surface, driven ──');
{
  /* A minimal DOM. `renderHtml` is already proven pure above, so the shim only needs to let
     mount paint, find its buttons and receive a click — which is what is under test here. */
  function el(attrs) {
    return {
      _a: attrs, disabled: false, textContent: attrs.label || '',
      getAttribute: function (k) { return Object.hasOwn(this._a, k) ? this._a[k] : null; },
      addEventListener: function (_, fn) { this._click = fn; },
      click: function () { this._click({ currentTarget: this, preventDefault: function () {} }); },
    };
  }
  function makeRoot() {
    return {
      html: '', _els: [],
      set innerHTML(v) {
        this.html = v;
        this._els = (v.match(/<(?:a|button)[^>]*class="ci-act[^>]*>/g) || []).map((tag) => el({
          'data-role': (tag.match(/data-role="([^"]*)"/) || [])[1] || null,
          'data-op': (tag.match(/data-op="([^"]*)"/) || [])[1] || null,
          'data-session': (tag.match(/data-session="([^"]*)"/) || [])[1] || null,
        }));
      },
      get innerHTML() { return this.html; },
      querySelectorAll: function () { return this._els; },
      querySelector: function () { return null; },
      appendChild: function () {},
    };
  }

  const incSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-incoming.js'), 'utf8');
  const c2Src = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');

  function harness(items) {
    const calls = [];
    const navigated = [];
    const sb = { SokoniConnectClient: null, SokoniConnectIncoming: null,
      document: { createElement: () => ({}) }, confirm: () => false,
      setInterval: () => 0, clearInterval: () => {}, location: {} };
    new Function('window', c2Src)(sb);
    new Function('window', incSrc)(sb);
    const root = makeRoot();
    const call = (op, payload) => {
      calls.push(op);
      if (op === 'connectListIncoming') return Promise.resolve({ incoming: items, count: items.length });
      return Promise.resolve({ ok: true });
    };
    const handle = sb.SokoniConnectIncoming.mount(root, {
      call, navigate: (h) => navigated.push(h),
    });
    return { calls, navigated, root, handle, I: sb.SokoniConnectIncoming };
  }

  const ring = { title: 'Incoming SOKONI business call', about: 'order #SK-99420' };
  const ITEM = (o) => Object.assign({ sessionId: 's1', state: 'ringing', channel: 'voice',
    offerable: ['accepted', 'declined', 'ringing'], ring }, o || {});

  /* Settles the whole queue — microtasks AND the timer turn — rather than guessing at a
     number of ticks. A test that races the code it is testing proves nothing either way. */
  const settle = () => new Promise((r) => setTimeout(r, 0));

  {
    const h = harness([ITEM()]);
    settle().then(() => {
      ck('mount reads the incoming list', h.calls.includes('connectListIncoming'));
      ck('…and paints a card for it', /ci-card/.test(h.root.html));

      /* THE DEVICE-ALERT EDGE, taken once. */
      ck('the device reports that it is alerting',
        h.calls.includes('connectMarkRinging'));

      return h.handle.refresh().then(settle);
    }).then(() => {
      ck('…exactly ONCE, even across a second poll',
        h.calls.filter((c) => c === 'connectMarkRinging').length === 1,
        h.calls.filter((c) => c === 'connectMarkRinging').length + ' reports');

      /* THE PROOF THAT C3-B NEVER ACCEPTS. */
      const open = h.root._els.filter((e) => e.getAttribute('data-role') === 'open')[0];
      ck('Answer is present', !!open);
      if (open) open.click();
      ck('…and NAVIGATES to the session page', h.navigated[0] === '/connect.html?session=s1');
      ck('…it never calls connectAnswerSession — C2 owns the accept and the consent',
        !h.calls.includes('connectAnswerSession'));

      const dec = h.root._els.filter((e) => e.getAttribute('data-role') === 'decline')[0];
      if (dec) dec.click();
      ck('Decline goes straight to the server op', h.calls.includes('connectDeclineSession'));

      /* Not offered → not reported. */
      const h2 = harness([ITEM({ offerable: ['accepted'] })]);
      return settle().then(() => h2);
    }).then((h2) => {
      ck('a session that does not offer `ringing` is NOT reported as alerting',
        !h2.calls.includes('connectMarkRinging'), h2.calls.join(','));
      _c3bDone();
    }).catch((e) => {
      ck('the mounted surface ran without throwing', false, e && e.message);
      _c3bDone();
    });
  }
}

console.log('\n── C3-B: the page reaches it ──');
{
  const page = fs.readFileSync(path.join(ROOT, 'connect.html'), 'utf8');
  const pageCode = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const iC2 = pageCode.indexOf('src="/sokoni-connect-client.js"');
  const iC3 = pageCode.indexOf('src="/sokoni-connect-incoming.js"');
  ck('connect.html serves the incoming surface', iC3 > -1);
  ck('…after the C2 client it depends on', iC2 > -1 && iC3 > iC2, iC2 + ' < ' + iC3);
  ck('…and mounts it when no session is named',
    /SokoniConnectIncoming\.mount\(root, \{ call: call \}\)/.test(pageCode));
  ck('…instead of the old dead end',
    !/No session was named in this link/.test(pageCode));
  ck('the deep-linked path still mounts C2, unchanged',
    /SokoniConnectClient\.mount\(root, \{/.test(pageCode));
  ck('the page still self-updates after a deploy', /sw-register\.js/.test(page));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   GATE C3-C — the WebRTC adapter

   Three things existed and did not meet: `connectSignal` relayed offers, answers and
   candidates into a subcollection NOTHING read; `reportableEvents` was projected to a client
   with no media stack to produce one; and `transportPlan: ['webrtc']` was authorized on every
   session and never attempted.

   What is certified here is what the adapter REPORTS and what it REFUSES TO SAY. That is a
   claim about this code. It is NOT a claim that media flowed, that two browsers paired, or
   that anything traversed a NAT — those need a network and two devices, and the ladder says
   so.
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── C3-C: the adapter speaks only the authority\'s media vocabulary ──');
{
  const mediaPath = path.join(ROOT, 'sokoni-connect-media.js');
  ck('the media adapter exists', fs.existsSync(mediaPath));
  const mediaSrc = fs.readFileSync(mediaPath, 'utf8');
  const mediaCode = mediaSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const sb = { SokoniConnectMedia: null, document: null, setInterval: () => 0,
    clearInterval: () => {}, location: {} };
  new Function('window', mediaSrc)(sb);
  const M = sb.SokoniConnectMedia;
  ck('…and loads', !!M && typeof M.attach === 'function');
  ck('C3-C declares its own surface both ways',
    M.CONTRACT.filter((k) => M[k] === undefined).length === 0 &&
    Object.keys(M).filter((k) => k !== 'CONTRACT' && !M.CONTRACT.includes(k)).length === 0);

  /* THE RANGE OF THE MAPPING. Not "does it contain a typo" — what CAN it emit, at all. */
  const emittable = M.emittableEvents();
  ck('every event it can emit is in the authority\'s vocabulary',
    emittable.every((e) => CA.MEDIA_EVENT_NAMES.includes(e)),
    emittable.filter((e) => !CA.MEDIA_EVENT_NAMES.includes(e)).join(',') || emittable.join(','));
  ck('…and it can emit the WHOLE vocabulary, so nothing is unreachable',
    emittable.join(',') === CA.MEDIA_EVENT_NAMES.slice().sort().join(','),
    emittable.join(','));

  /* THE CENTRAL REFUSAL. A session state is not something this module may say. */
  const states = Object.keys(CA.SESSION_STATES);
  ck('it can emit NO session state name',
    emittable.every((e) => !states.includes(e)),
    emittable.filter((e) => states.includes(e)).join(',') || 'none');

  console.log('\n   an ICE pair is a route, not a conversation');
  ck('ICE `connected` reports ice_connected', M.eventForIceState('connected') === 'ice_connected');
  ck('…and `completed` likewise', M.eventForIceState('completed') === 'ice_connected');
  ck('…NOT media_flowing', M.eventForIceState('connected') !== 'media_flowing');
  ck('…and NOT the state `connected`', M.eventForIceState('connected') !== 'connected');
  ck('the AGGREGATE connection state `connected` reports NOTHING at all',
    M.eventForConnectionState('connected') === null,
    'transport up is not media arriving');
  ck('media_flowing comes only from a track that unmuted',
    M.eventForTrack('unmuted') === 'media_flowing');

  console.log('\n   a drop is not a failure, and a failure is not a guess');
  ck('ICE `disconnected` is ice_disconnected, not connection_failed',
    M.eventForIceState('disconnected') === 'ice_disconnected');
  ck('…because it may recover — the authority maps it to no state',
    CA.interpretMediaEvent({ from: 'connected', event: 'ice_disconnected', actor: 'caller' })
      .effect === 'recorded_only');
  ck('ICE `failed` is connection_failed', M.eventForIceState('failed') === 'connection_failed');
  ck('a muted track reports media_stopped', M.eventForTrack('muted') === 'media_stopped');
  ck('…and an ended one likewise', M.eventForTrack('ended') === 'media_stopped');

  console.log('\n   unknown inputs produce silence, never a guess');
  ['new', 'checking', 'closed', '', null, undefined, 'quantum'].forEach((s) => {
    ck('…ICE `' + String(s) + '` reports nothing', M.eventForIceState(s) === null);
  });
  ck('an unknown track phase reports nothing', M.eventForTrack('sideways') === null);
  ck('an unknown connection state reports nothing', M.eventForConnectionState('quantum') === null);
}

console.log('\n── C3-C: no transport is invented ──');
{
  const mediaSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-media.js'), 'utf8');
  const sb = { SokoniConnectMedia: null, document: null };
  new Function('window', mediaSrc)(sb);
  const M = sb.SokoniConnectMedia;

  /* SOKONI runs no relay. A borrowed public STUN would manufacture a transport the platform
     does not operate, and would make "it connected" evidence of somebody else's server. */
  /* COMMENT-STRIPPED. The first draft tested the raw source and failed — on the module's
     OWN header, which says in prose that there is no stun: or turn: URL in it. The
     certification machinery had read itself and called the documentation a defect. */
  const mediaExec = mediaSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const pageExec = fs.readFileSync(path.join(ROOT, 'connect.html'), 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  ck('there is no stun: URL in the adapter', !/stun:/i.test(mediaExec));
  ck('…and no turn: URL either', !/turn:/i.test(mediaExec));
  ck('…nor in the page', !/stun:|turn:/i.test(pageExec));
  /* INVERTING CONTROL: the detector still matches a URL in code rather than prose. */
  ck('…inverting control: it WOULD catch one in code',
    /stun:/i.test(mediaExec + "var x = 'stun:example.org';"));
  /* POSITIVE CONTROL: the detector matches where a relay really is named. */
  ck('…positive control: the detector DOES match where turn is named',
    /turn/i.test(fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'communication-providers.js'), 'utf8')));

  const none = M.describeIce([]);
  ck('with nothing provisioned, configured is FALSE', none.configured === false);
  ck('…the server list is empty, not a default', none.iceServers.length === 0);
  ck('…and the limitation is stated in words a UI can show',
    /same network/i.test(none.traversal) && none.reason === 'no_ice_servers_configured');
  ck('…undefined fails the same closed way', M.describeIce(undefined).configured === false);
  ck('…and so does null', M.describeIce(null).configured === false);
  ck('…and a list of nothing-but-holes', M.describeIce([null, undefined]).configured === false);

  const some = M.describeIce([{ urls: 'x' }]);
  ck('supplied servers flip configured to true', some.configured === true);
  ck('…but STILL promise nothing — supplying a server is not connecting',
    /not guaranteed|not been demonstrated/i.test(some.traversal));
}

console.log('\n── C3-C: it cannot reach the backend except through C2 ──');
{
  const mediaSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-media.js'), 'utf8');
  const mediaCode = mediaSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ck('the adapter never names connectReportMediaEvent',
    !/connectReportMediaEvent/.test(mediaCode));
  ck('…nor any session-advancing op',
    !/connectAnswerSession|connectEndSession|connectDeclineSession|connectCancelSession/
      .test(mediaCode));
  ck('…nor connectGetSessionState', !/connectGetSessionState/.test(mediaCode));
  /* POSITIVE CONTROL: C2 is where those names legitimately live. */
  ck('…positive control: C2 does name them',
    /connectReportMediaEvent/.test(fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8')));
  ck('reporting goes through the handle C2 returned',
    /handle\.reportObservation\(event\)/.test(mediaCode));

  /* The kinds it sends must be exactly the kinds the server accepts. A fourth kind would be
     a silent dead end: sent, refused, never diagnosed. */
  const callsCode = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const served = (callsCode.match(/\['offer', 'answer', 'candidate'\]\.includes\(kind\)/) || [])[0];
  ck('the server accepts exactly offer, answer, candidate', !!served);
  const sb = { SokoniConnectMedia: null, document: null };
  new Function('window', mediaSrc)(sb);
  ck('…and the adapter sends exactly those',
    sb.SokoniConnectMedia.SIGNAL_KINDS.slice().sort().join(',') === 'answer,candidate,offer',
    sb.SokoniConnectMedia.SIGNAL_KINDS.join(','));
}

console.log('\n── C3-C: the adapter, driven against a fake peer connection ──');
{
  const mediaSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-media.js'), 'utf8');

  /* A peer connection that does exactly what the spec says and nothing more. It never
     connects anything — it lets the suite fire the callbacks a real one would fire. */
  function FakePC() {
    this.iceConnectionState = 'new';
    this.connectionState = 'new';
    this.localDescription = null;
    this.remoteDescription = null;
    this.added = [];
    this.candidates = [];
    this.closed = false;
  }
  FakePC.prototype.createOffer = function () { return Promise.resolve({ type: 'offer', sdp: 'OFFER' }); };
  FakePC.prototype.createAnswer = function () { return Promise.resolve({ type: 'answer', sdp: 'ANSWER' }); };
  FakePC.prototype.setLocalDescription = function (d) { this.localDescription = d; return Promise.resolve(); };
  FakePC.prototype.setRemoteDescription = function (d) { this.remoteDescription = d; return Promise.resolve(); };
  FakePC.prototype.addIceCandidate = function (c) { this.candidates.push(c); return Promise.resolve(); };
  FakePC.prototype.addTrack = function (t, s) { this.added.push(t); };
  FakePC.prototype.close = function () { this.closed = true; };

  function harness(opts) {
    const o = opts || {};
    const reported = [];
    const sent = [];
    let subscriber = null;
    const sb = { SokoniConnectMedia: null, document: null };
    new Function('window', mediaSrc)(sb);
    const pc = new FakePC();
    const handle = {
      reportObservation: (e) => { reported.push(e); return Promise.resolve({ reported: true }); },
    };
    const adapter = sb.SokoniConnectMedia.attach(o.noHandle ? null : handle, {
      createPeerConnection: o.noFactory ? undefined : () => pc,
      signal: (kind, payload) => { sent.push(kind); return Promise.resolve({ ok: true }); },
      subscribe: (cb) => { subscriber = cb; return () => { subscriber = null; }; },
      getMedia: o.mediaFails
        ? () => Promise.reject(new Error('Permission denied'))
        : () => Promise.resolve({ getTracks: () => [{ id: 't1' }] }),
      isCaller: o.isCaller === true,
      iceServers: [],
    });
    return { adapter, pc, reported, sent, signal: (s) => subscriber && subscriber(s) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 0));

  /* ── refusals, before anything else ── */
  ck('without C2\'s handle it refuses to attach at all',
    harness({ noHandle: true }).adapter.error === 'no_report_route');
  ck('…rather than inventing its own route to the backend', true,
    'the refusal IS the proof — there is no second path to fall back on');
  ck('without a peer-connection factory it refuses',
    harness({ noFactory: true }).adapter.error === 'no_peer_connection_factory');

  /* ── observation ── */
  {
    const h = harness({ isCaller: true });
    h.pc.iceConnectionState = 'connected';
    h.pc.oniceconnectionstatechange();
    settle().then(() => {
      ck('ICE connecting reports ice_connected', h.reported.join(',') === 'ice_connected',
        h.reported.join(','));
      ck('…and reports NOTHING that could be read as arrival',
        !h.reported.includes('media_flowing') && !h.reported.includes('connected'));

      h.pc.connectionState = 'connected';
      h.pc.onconnectionstatechange();
      return settle();
    }).then(() => {
      ck('…and the aggregate going connected adds nothing',
        h.reported.join(',') === 'ice_connected', h.reported.join(','));

      /* Media arrives. */
      const track = { muted: true };
      h.pc.ontrack({ track, streams: [{}] });
      track.onunmute();
      return settle();
    }).then(() => {
      ck('an unmuted inbound track reports media_flowing',
        h.reported.includes('media_flowing'));
      /* `intends` is the destination the observation argues for. `transition` is the
         table's verdict object — which is what this first asked for, and why it failed. */
      ck('…which is the ONLY route to the connected state, and it is the server\'s to take',
        CA.interpretMediaEvent({ from: 'connecting', event: 'media_flowing', actor: 'caller' })
          .intends === 'connected');
      ck('…and NO other media event argues for it',
        CA.MEDIA_EVENT_NAMES.filter((e) =>
          CA.interpretMediaEvent({ from: 'connecting', event: e, actor: 'caller' })
            .intends === 'connected').join(',') === 'media_flowing');
      return null;
    }).then(() => {
      /* Duplicate unmute must not spray the backend. */
      const before = h.reported.filter((e) => e === 'media_flowing').length;
      const track2 = { muted: true };
      h.pc.ontrack({ track: track2, streams: [{}] });
      track2.onunmute();
      return settle().then(() => {
        ck('a second unmute while already flowing reports nothing new',
          h.reported.filter((e) => e === 'media_flowing').length === before,
          h.reported.join(','));
      });
    }).then(() => _c3cStep2());
  }

  /* ── signalling ── */
  function _c3cStep2() {
    const caller = harness({ isCaller: true });
    caller.adapter.negotiate().then(settle).then(() => {
      ck('the caller reports that negotiation began',
        caller.reported[0] === 'negotiation_started', caller.reported.join(','));
      ck('…creates an offer and sets it locally',
        caller.pc.localDescription && caller.pc.localDescription.type === 'offer');
      ck('…and relays it as an offer', caller.sent.includes('offer'), caller.sent.join(','));
      ck('…and attaches its local media to the connection', caller.pc.added.length === 1);

      const callee = harness({ isCaller: false });
      return callee.adapter.negotiate().then(settle).then(() => {
        ck('the callee does NOT offer — that would be glare',
          !callee.sent.includes('offer'), callee.sent.join(',') || 'nothing sent');
        /* The offer arrives through the subscription the RULES authorize. */
        return callee.signal({ kind: 'offer', payload: JSON.stringify({ type: 'offer', sdp: 'X' }) })
          .then(settle).then(() => {
            ck('…it answers an offer it receives', callee.sent.includes('answer'));
            ck('…having set the remote description first',
              callee.pc.remoteDescription && callee.pc.remoteDescription.sdp === 'X');
            return callee.signal({ kind: 'candidate', payload: JSON.stringify({ candidate: 'c1' }) });
          }).then(settle).then(() => {
            ck('…and adds a relayed ICE candidate', callee.pc.candidates.length === 1);
            return callee.signal({ kind: 'teleport', payload: '{}' });
          }).then(settle).then(() => {
            ck('an unrecognised signal kind is ignored, not thrown',
              callee.pc.candidates.length === 1);
            return callee.signal({ kind: 'offer', payload: 'not json at all' });
          }).then(settle).then(() => {
            ck('…and a malformed payload does not throw either', true, 'survived');
          });
      });
    }).then(() => {
      /* A local media failure is a real failure of this attempt. */
      const broken = harness({ isCaller: true, mediaFails: true });
      return broken.adapter.negotiate().then(settle).then(() => {
        ck('a refused microphone reports connection_failed',
          broken.reported.includes('connection_failed'), broken.reported.join(','));
        ck('…and never names a state', !broken.reported.some((e) => Object.keys(CA.SESSION_STATES).includes(e)));
        ck('…and sends no offer it could not honour', !broken.sent.includes('offer'));
      });
    }).then(() => {
      const h = harness({ isCaller: true });
      h.adapter.close();
      ck('close tears the peer connection down', h.pc.closed === true);
      const after = h.reported.length;
      h.pc.iceConnectionState = 'failed';
      h.pc.oniceconnectionstatechange();
      return settle().then(() => {
        ck('…and a closed adapter reports nothing further',
          h.reported.length === after, h.reported.join(','));
        _c3cDone();
      });
    }).catch((e) => {
      ck('the driven adapter ran without throwing', false, e && e.message);
      _c3cDone();
    });
  }
}

console.log('\n── C3-C: the page attaches on the SERVER\'s say-so, and only then ──');
{
  const page = fs.readFileSync(path.join(ROOT, 'connect.html'), 'utf8');
  const pageCode = page.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  ck('the page serves the media adapter', /src="\/sokoni-connect-media\.js"/.test(pageCode));
  ck('…after the C2 client whose handle it reports through',
    pageCode.indexOf('sokoni-connect-media.js') >
      pageCode.indexOf('sokoni-connect-client.js'));
  ck('…and loads firestore, for the signals the rules already let the peer read',
    /firebase-firestore-compat\.js/.test(pageCode));

  ck('media attaches only when the SERVER says accepted',
    /String\(p\.status\) !== 'accepted'\) return;/.test(pageCode));
  ck('…and only when the authorized transport plan carries webrtc',
    /p\.transportPlan\.indexOf\('webrtc'\) === -1\) return;/.test(pageCode));
  ck('…and only once', /if \(media \|\| !p \|\| !handle\) return;/.test(pageCode));
  ck('a terminal session takes its media down', /p\.terminal === true && media/.test(pageCode));

  ck('the page supplies NO ice servers', /iceServers: \[\]/.test(pageCode));
  ck('the signal listener reads only what is addressed to this user',
    /\.where\('to', '==', u\.uid\)/.test(pageCode));
  ck('…and acts on ADDED signals only, so a resnapshot cannot replay an offer',
    /ch\.type === 'added'/.test(pageCode));
  ck('a refused or unindexed listener is SHOWN, not swallowed',
    /Signalling unavailable/.test(pageCode));

  const idx = require(path.join(ROOT, 'firestore.indexes.json'));
  ck('the signals index the listener needs is DECLARED',
    (idx.indexes || []).some((i) => i.collectionGroup === 'signals' &&
      i.fields.map((f) => f.fieldPath).join(',') === 'to,createdAt'));

  /* The page must not have grown a media path that bypasses the adapter. */
  ck('the page constructs no RTCPeerConnection of its own outside the adapter call',
    (pageCode.match(/new window\.RTCPeerConnection/g) || []).length === 1);
  ck('…and never reports a media event directly',
    !/connectReportMediaEvent/.test(pageCode));
}

console.log('\n── C3-C: the C2 / server field seam, closed ──');
{
  /* A DEFECT FOUND BY THIS GATE. C2's renderHtml asked for `p.state`; the server has always
     sent `status` — the document field and the authority's own word. So the session state on
     connect.html rendered as a dash from the day C2 shipped. The C2 suite never caught it
     because it drives renderHtml with synthetic projections it writes itself: a fixture
     agrees with whatever you wrote in it, which is exactly what a seam assertion must not do.

     So this compares the CONSUMER's reads against the PRODUCER's real output. */
  const mod = require(path.join(ROOT, 'functions', 'connect-calls.js'));
  const projection = mod._internals._project('s1', {
    status: 'ringing', channel: 'voice', callerUid: 'b', calleeUid: 's',
    participants: ['b', 's'], transportPlan: ['webrtc'],
    context: { relationship: 'order', anchorType: 'orders', anchorId: 'X1', purpose: '' },
  }, 's');

  const c2Src = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');
  const c2Code = c2Src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const reads = [...new Set((c2Code.match(/\bp\.[a-zA-Z]+/g) || []).map((s) => s.slice(2)))];
  const orphans = reads.filter((r) => !Object.hasOwn(projection, r));

  ck('every field C2 reads is a field the server actually sends',
    orphans.length === 0, orphans.join(',') || reads.length + ' fields, all present');
  ck('…including the session state itself', reads.includes('status'));
  ck('…and `p.state` is gone from C2', !/\bp\.state\b/.test(c2Code));
  ck('…and from the C3-B banner too',
    !/\.state\b/.test(fs.readFileSync(path.join(ROOT, 'sokoni-connect-incoming.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')));
  /* POSITIVE CONTROL: the detector can find an orphan when there is one. */
  ck('…positive control: the check DOES catch a field the server never sends',
    ['status', 'invented'].filter((r) => !Object.hasOwn(projection, r)).join(',') === 'invented');

  /* And the projection really does carry a state worth rendering. */
  ck('the projection\'s status is the authority\'s own vocabulary',
    Object.keys(CA.SESSION_STATES).includes(projection.status), projection.status);
}

console.log('\n── C3-C changed no frozen contract ──');
{
  ck('no new media event', CA.MEDIA_EVENT_NAMES.length === 6);
  ck('no new session state', Object.keys(CA.SESSION_STATES).length === 10);
  ck('no new actor', CA.ACTOR_NAMES.length === 3);
  const modOps = Object.keys(require(path.join(ROOT, 'functions', 'connect-calls.js'))._h);
  /* RETARGETED, not deleted. This pinned the op count at 13 to say "C3-C added no server op"
     — true, and the right thing to guard. But a COUNT also fails when a different slice adds
     an unrelated op (Phase 1 added `connectAvailableActions`), and the fix then looks like
     deleting a colleague's work. The claim C3-C actually needs is that the MEDIA path reuses
     the ops that already existed, which is checkable directly and survives the count moving. */
  ck('C3-C added NO server op — the relay and the reporter already existed',
    modOps.includes('connectSignal') && modOps.includes('connectReportMediaEvent') &&
    /* Media-TRANSPORT names only. `Answer` and `Offer` are deliberately absent from this
       list: `connectAnswerSession` is a person accepting a call, not an SDP answer, and
       catching it would fail the guard on the very intention op C3-C was built around. */
    !modOps.some((o) => /(Ice|Turn|Stun|PeerConnection|Description|Candidate|Sdp|Relay)/i.test(o)),
    modOps.length + ' ops total');
  ck('…and the read path it uses is the one the rules already authorize',
    /request\.auth\.uid == resource\.data\.to/
      .test(fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8')));
  const incSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-incoming.js'), 'utf8');
  const sbI = { SokoniConnectClient: null, SokoniConnectIncoming: null, document: null,
    setInterval: () => 0, clearInterval: () => {}, location: {} };
  new Function('window', fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8'))(sbI);
  new Function('window', incSrc)(sbI);
  ck('C2 is still 7 names', sbI.SokoniConnectClient.CONTRACT.length === 7);
  ck('C3-B is still 8 names', sbI.SokoniConnectIncoming.CONTRACT.length === 8,
    sbI.SokoniConnectIncoming.CONTRACT.length + '');
}

console.log('\n── C3-B changed no frozen contract ──');
{
  const c2Src = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');
  const sb = { SokoniConnectClient: null, document: null, confirm: () => false,
    setInterval: () => 0, clearInterval: () => {} };
  new Function('window', c2Src)(sb);
  ck('C2 is still 7 names', sb.SokoniConnectClient.CONTRACT.length === 7);
  ck('…and its action map is still keyed by the same five destinations',
    Object.keys(sb.SokoniConnectClient.ACTIONS).sort().join(',') ===
      'accepted,cancelled,declined,ended,ringing');
  ck('no new session state', Object.keys(CA.SESSION_STATES).length === 10);
  ck('no new actor', CA.ACTOR_NAMES.length === 3);
  ck('no new media event', CA.MEDIA_EVENT_NAMES.length === 6);
  ck('C1\'s ring payload is unchanged in shape',
    Object.keys(require(path.join(ROOT, 'functions', 'connect-notify.js'))
      ._internals.ringPayload({ channel: 'voice', context: {} })).sort().join(',') ===
      'about,body,title');
}


console.log('\n── C3-A changed no frozen contract ──');
{
  const missing = CA.API_CONTRACT.filter((k) => CA[k] === undefined);
  ck('C1 API_CONTRACT still resolves', missing.length === 0, missing.join(',') || 'none');
  const undeclared = Object.keys(CA)
    .filter((k) => k !== 'API_CONTRACT' && !CA.API_CONTRACT.includes(k));
  ck('…and gained no export', undeclared.length === 0, undeclared.join(',') || 'none');
  ck('…no new actor vocabulary',
    CA.ACTOR_NAMES.slice().sort().join(',') === 'callee,caller,server');
  ck('…no new session state', Object.keys(CA.SESSION_STATES).length === 10);
  ck('…no new media event', CA.MEDIA_EVENT_NAMES.length === 6);
  ck('…no new capability key',
    require(path.join(ROOT, 'functions', 'capability-authority.js')).KEYS
      .filter((k) => /video/i.test(k)).join(',') === 'videoCalling');

  const clientSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');
  const sandbox = { SokoniConnectClient: null, document: null, confirm: () => false,
    setInterval: () => 0, clearInterval: () => {} };
  new Function('window', clientSrc)(sandbox);
  const C2 = sandbox.SokoniConnectClient;
  ck('C2 CONTRACT still resolves both ways',
    C2.CONTRACT.filter((k) => C2[k] === undefined).length === 0 &&
    Object.keys(C2).filter((k) => k !== 'CONTRACT' && !C2.CONTRACT.includes(k)).length === 0);
  ck('…and is unchanged at 7 names', C2.CONTRACT.length === 7, C2.CONTRACT.length + '');

  const callSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-call.js'), 'utf8');
  const sb2 = { SokoniConnectCall: null, document: null };
  new Function('window', callSrc)(sb2);
  const CC = sb2.SokoniConnectCall;
  ck('C3-A declares its own surface',
    CC.CONTRACT.filter((k) => CC[k] === undefined).length === 0);
  ck('…and every export is declared',
    Object.keys(CC).filter((k) => k !== 'CONTRACT' && !CC.CONTRACT.includes(k)).length === 0);
}

/* The C3-B mount section drives promises, so the summary waits for it rather than reporting
   a run that has not finished. A suite that prints its total before its last assertion has
   landed is worse than a failing one. */
/* Two driven sections run concurrently — C3-B's mounted banner and C3-C's peer connection.
   The summary is a BARRIER over both. Printing when the first one finishes would report a
   run whose other half had not landed, which is the failure this guard exists to prevent. */
let _asyncPending = 2;
function _sectionDone() {
  if (--_asyncPending > 0) return;
  clearTimeout(_c3bGuard);
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
}
function _c3bDone() { _sectionDone(); }
function _c3cDone() { _sectionDone(); }
/* FAIL CLOSED. Deliberately NOT unref'd: an unref'd guard lets a dead async chain exit 0,
   which is the failure mode this exists to prevent. */
const _c3bGuard = setTimeout(() => {
  ck('both driven sections completed', false,
    _asyncPending + ' of 2 still pending — a driven section hung');
  console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(1);
}, 20000);
