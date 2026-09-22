/* SOKONI Communication Engine — one envelope, one router, one provider policy.

   WHAT THESE PROVE

   SOKONI already sends on seven channels. It does not connect them, and the reason is one
   missing field: `notifyLog` records no business anchor, so every push, SMS and email the
   platform has ever sent cannot be joined to the order it was about.

   So the suite proves three things and refuses to imply a fourth:

     1. the ENVELOPE gives every channel one shape, with the anchor that makes them joinable
     2. the ROUTER never turns an ordinary message into a metered SMS
     3. the PROVIDER policy never fails over on a failure that would repeat or do harm

   and the TIMELINE reports its own incompleteness rather than reading as silence.

   POSITIVE CONTROLS. Every refusal below is paired with the nearest input that MUST be
   granted, because a router that plans nothing refuses everything and would pass a suite made
   only of refusals.
*/
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const ENV = require(path.join(ROOT, 'functions', 'shared', 'communication-envelope'));
const ROUTER = require(path.join(ROOT, 'functions', 'shared', 'communication-router'));
const PROV = require(path.join(ROOT, 'functions', 'shared', 'communication-providers'));

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + String(d).slice(0, 78) + ']' : ''));
  ok ? pass++ : fail++;
};
const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The envelope: one shape for seven channels ──');
{
  ck('every channel SOKONI sends on is named',
    ENV.CHANNELS.slice().sort().join(',') === 'chat,email,in_app,push,sms,video,voice',
    ENV.CHANNELS.join(','));
  ck('chat, voice and video are the real-time ones',
    ENV.REALTIME_CHANNELS.slice().sort().join(',') === 'chat,video,voice');
  ck('priorities mirror notify.js rather than inventing a second vocabulary',
    ENV.PRIORITIES.slice().sort().join(',') === 'commerce,critical,marketing');
  ck('anchor types mirror the Connect vocabulary, so a call and a chat can join',
    ENV.ANCHOR_TYPES.slice().sort().join(',') === 'booking,delivery,inquiry,order,supply,support');

  const e = ENV.buildEnvelope({
    at: 'T', communicationId: 'c1', channel: 'chat', senderUid: 'buyer1',
    anchorType: 'order', anchorId: 'SK-99420', subject: 'Order #SK-99420',
    preview: 'When will it arrive?', source: 'conversations', sourceId: 'x',
  });
  ck('it carries the anchor', e.anchor.anchorType === 'order' && e.anchor.anchorId === 'SK-99420');
  ck('…and states that it is anchored', e.anchored === true);
  ck('…names the system that owns the record', e.source === 'conversations');
  ck('…marks chat as real-time', e.realtime === true);
  ck('…defaults to queued, not delivered', e.status === 'queued');
  ck('the clock is an argument, not a global', e.at === 'T');
  ck('…and a record without one is refused', throws(() => ENV.buildEnvelope({ channel: 'chat' })));

  console.log('\n   sent is not delivered, and delivered is not read');
  ck('all six delivery states exist',
    ENV.DELIVERY_STATES.slice().sort().join(',') === 'delivered,failed,queued,read,sent,suppressed');
  ck('`sent` is NOT terminal — the provider may still report', !ENV.TERMINAL_DELIVERY.includes('sent'));
  ck('…nor is `queued`', !ENV.TERMINAL_DELIVERY.includes('queued'));
  ck('delivered, read, failed and suppressed are terminal',
    ENV.TERMINAL_DELIVERY.slice().sort().join(',') === 'delivered,failed,read,suppressed');
  ck('`suppressed` is its own state — not a failure',
    ENV.DELIVERY_STATES.includes('suppressed') &&
    ENV.DELIVERY_STATES.includes('failed') && 'suppressed' !== 'failed');

  console.log('\n   an unanchored communication is RECORDED as unanchored, not refused');
  const u = ENV.buildEnvelope({
    at: 'T', channel: 'push', source: 'notifyLog', sourceId: 'k',
  });
  ck('it builds', !!u);
  ck('…and says it cannot join', u.anchored === false);
  ck('isAnchored agrees', !ENV.isAnchored(u));
  ck('…and agrees the other way', ENV.isAnchored(e));
  ck('a half anchor does not count',
    !ENV.isAnchored({ anchor: { anchorType: 'order', anchorId: '' } }));

  console.log('\n   every unknown is refused');
  ck('unknown channel', throws(() => ENV.buildEnvelope({ at: 'T', channel: 'telepathy' })));
  ck('unknown priority', throws(() => ENV.buildEnvelope({ at: 'T', channel: 'chat', priority: 'urgent' })));
  ck('unknown delivery state', throws(() => ENV.buildEnvelope({ at: 'T', channel: 'chat', status: 'maybe' })));
  ck('unknown anchor type', throws(() => ENV.buildEnvelope({ at: 'T', channel: 'chat', anchorType: 'friendship' })));
  ck('…positive control: the valid form builds',
    ENV.buildEnvelope({ at: 'T', channel: 'chat', priority: 'critical', status: 'sent' }).status === 'sent');

  console.log('\n   no telephone number enters an envelope');
  ck('a number in the preview is REFUSED',
    throws(() => ENV.buildEnvelope({ at: 'T', channel: 'sms', preview: 'call +254712345678' })));
  ck('…in the subject too',
    throws(() => ENV.buildEnvelope({ at: 'T', channel: 'sms', subject: '0712345678' })));
  ck('…positive control: clean text builds',
    !!ENV.buildEnvelope({ at: 'T', channel: 'sms', preview: 'Your order is ready' }));
  ck('the envelope carries a PREVIEW, not a body', e.preview.length <= 280);

  console.log('\n   the timeline sorts without guessing');
  const rows = [
    { id: 'c', atMillis: 300 }, { id: 'a', atMillis: 100 },
    { id: 'x', atMillis: null }, { id: 'b', atMillis: 200 },
  ];
  ck('chronological', ENV.sortTimeline(rows).slice(0, 3).map((r) => r.id).join('') === 'abc');
  ck('…an uncomparable time sorts LAST and is KEPT, never dropped',
    ENV.sortTimeline(rows).length === 4 && ENV.sortTimeline(rows)[3].id === 'x');
  ck('equal times keep their input order',
    ENV.sortTimeline([{ id: '1', atMillis: 5 }, { id: '2', atMillis: 5 }])
      .map((r) => r.id).join('') === '12');
  ck('no argument does not throw', ENV.sortTimeline().length === 0);
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The router: an ordinary message must never become an SMS ──');
{
  const R = (o) => ROUTER.routeFor(o);
  const ALL = { present: true, hasPushTarget: true, hasEmail: true, hasPhone: true };

  console.log('\n   the rule with a bill attached');
  const commerce = R({ ...ALL, priority: 'commerce' });
  ck('a commerce message with a phone number does NOT plan SMS',
    !commerce.plan.includes('sms'), commerce.plan.join(','));
  ck('…and says why', commerce.considered.sms === 'priority_not_sms_eligible');
  const marketing = R({ ...ALL, priority: 'marketing' });
  ck('marketing never plans SMS either', !marketing.plan.includes('sms'));
  /* Inverting control: the SAME reachability at critical DOES. */
  const critical = R({ ...ALL, priority: 'critical' });
  ck('…while a CRITICAL message does plan it', critical.plan.includes('sms'));
  ck('…which is the whole distinction: consequence, not volume',
    ROUTER.SMS_ELIGIBLE_PRIORITIES.join(',') === 'critical');

  console.log('\n   cheapest and most immediate first');
  ck('the plan is ordered in_app → push → email → sms',
    critical.plan.join(',') === 'in_app,push,email,sms', critical.plan.join(','));
  ck('the preference order is the policy',
    ROUTER.CHANNEL_PREFERENCE.join(',') === 'in_app,push,email,sms');
  ck('someone present gets in-app first', R({ ...ALL, priority: 'commerce' }).plan[0] === 'in_app');
  ck('someone absent does not',
    !R({ ...ALL, present: false, priority: 'commerce' }).plan.includes('in_app'));
  ck('…and the reason is recorded',
    R({ ...ALL, present: false, priority: 'commerce' }).considered.in_app === 'recipient_not_present');
  ck('a message to a screen nobody is looking at is not called delivered',
    R({ present: false, hasPushTarget: false, hasEmail: false, hasPhone: false,
      priority: 'commerce' }).reason === 'unreachable');

  console.log('\n   every omission is explained, because someone asks about a bill');
  const none = R({ priority: 'critical' });
  ck('no push target is named', none.considered.push === 'no_push_target');
  ck('no email address is named', none.considered.email === 'no_email_address');
  ck('no phone number is named', none.considered.sms === 'no_phone_number');
  ck('…and explain() renders them', ROUTER.explain(none).length >= 3);
  ck('…positive control: a full plan explains its planned channels',
    ROUTER.explain(critical).filter((l) => /planned/.test(l)).length === 4);

  console.log('\n   a required record that cannot be made is a REFUSAL');
  const noRecord = R({ present: true, hasPushTarget: true, hasEmail: false, hasPhone: true,
    priority: 'critical', requiresRecord: true });
  ck('no plan at all', noRecord.plan.length === 0);
  ck('…with the reason stated', noRecord.reason === 'record_required_but_no_email');
  ck('…rather than a best-effort that cannot be evidenced later',
    !noRecord.plan.includes('push') && !noRecord.plan.includes('sms'));
  ck('…positive control: WITH an email it plans normally',
    R({ ...ALL, priority: 'critical', requiresRecord: true }).plan.includes('email'));

  console.log('\n   fails closed');
  ck('an unknown priority plans nothing', R({ ...ALL, priority: 'whenever' }).plan.length === 0);
  ck('…and says so', R({ ...ALL, priority: 'whenever' }).reason === 'unknown_priority');
  ck('a missing priority plans nothing', R(ALL).plan.length === 0);
  ck('no argument does not throw', R().plan.length === 0);
  ck('null does not throw', ROUTER.routeFor(null).plan.length === 0);
  [undefined, null, 'yes', 1, {}].forEach((v) => {
    ck('…a non-true reachability (' + JSON.stringify(v) + ') plans no push',
      !R({ priority: 'critical', hasPushTarget: v }).plan.includes('push'));
  });
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Providers: not every failure deserves a second attempt ──');
{
  console.log('\n   what fails over, and what must not');
  ck('a transport failure fails over', PROV.mayFailOver('transport').failover);
  ck('a quota failure fails over', PROV.mayFailOver('quota').failover);
  ck('an AUTH failure does NOT — it would hide a misconfiguration',
    !PROV.mayFailOver('auth').failover);
  ck('an INVALID RECIPIENT does NOT — it would fail again and hurt a second reputation',
    !PROV.mayFailOver('recipient').failover);
  ck('a SUPPRESSED recipient does NOT — failing over would defeat the suppression',
    !PROV.mayFailOver('suppressed').failover);
  ck('a CONTENT rejection does NOT', !PROV.mayFailOver('content').failover);
  ck('an UNCLASSIFIED failure does NOT — fail closed',
    !PROV.mayFailOver('mystery').failover);
  ck('…and says why', PROV.mayFailOver('mystery').reason === 'unclassified_failure');
  ck('no argument does not throw', PROV.mayFailOver().failover === false);

  console.log('\n   a human mailbox is not a transactional fallback');
  ck('google_workspace is a mailbox', PROV.PROVIDERS.google_workspace.role === 'mailbox');
  ck('sendgrid is transactional', PROV.PROVIDERS.sendgrid.role === 'transactional');
  ck('…and workspace is NOT in the email failover chain',
    !PROV.CHAINS.email.includes('google_workspace'), PROV.CHAINS.email.join(','));
  ck('…because a bounced receipt must not damage the address support replies from',
    PROV.CHAINS.email.join(',') === 'sendgrid,smtp');
  ck('every provider in a chain shares the chain\'s channel',
    Object.keys(PROV.CHAINS).every((ch) =>
      PROV.CHAINS[ch].every((p) => PROV.PROVIDERS[p] && PROV.PROVIDERS[p].channel === ch)),
    'chains are channel-consistent');

  console.log('\n   an unconfigured provider is NAMED, never assumed');
  const all = { sendgrid: true, smtp: true };
  ck('a configured chain is returned',
    PROV.chainFor({ channel: 'email', configured: all }).chain.join(',') === 'sendgrid,smtp');
  const partial = PROV.chainFor({ channel: 'email', configured: { sendgrid: true } });
  ck('an unconfigured provider is skipped', partial.chain.join(',') === 'sendgrid');
  ck('…and named', partial.skipped.join(',') === 'smtp');
  const nothing = PROV.chainFor({ channel: 'email', configured: {} });
  ck('a wholly unconfigured channel returns an empty chain', nothing.chain.length === 0);
  ck('…with a reason a caller must surface', nothing.reason === 'no_provider_configured');
  ck('an unknown channel returns nothing',
    PROV.chainFor({ channel: 'smoke', configured: all }).reason === 'unknown_channel');
  ck('no argument does not throw', PROV.chainFor().chain.length === 0);

  console.log('\n   the failover decision, end to end');
  const N = (o) => PROV.nextProvider(o);
  ck('transport failure on sendgrid moves to smtp',
    N({ channel: 'email', configured: all, current: 'sendgrid', failureClass: 'transport' })
      .provider === 'smtp');
  ck('…and the end of the chain stops',
    N({ channel: 'email', configured: all, current: 'smtp', failureClass: 'transport' })
      .reason === 'chain_exhausted');
  ck('a suppressed recipient never moves on',
    N({ channel: 'email', configured: all, current: 'sendgrid', failureClass: 'suppressed' })
      .provider === null);
  ck('…nor an auth failure',
    N({ channel: 'email', configured: all, current: 'sendgrid', failureClass: 'auth' })
      .provider === null);
  ck('an unknown current provider is refused, not restarted — restarting would re-send',
    N({ channel: 'email', configured: all, current: 'mailchimp', failureClass: 'transport' })
      .reason === 'current_provider_not_in_chain');
  ck('no argument does not throw', N().provider === null);

  console.log('\n   health reports PROVISIONING, never liveness');
  const rows = PROV.healthRowsFor({ sendgrid: true, fcm: true });
  ck('a configured provider reads configured',
    rows.find((r) => r.provider === 'sendgrid').state === 'configured');
  ck('an unconfigured one reads not_configured',
    rows.find((r) => r.provider === 'turn').state === 'not_configured');
  ck('…and NOTHING reads "operational" — this module cannot observe liveness',
    rows.every((r) => r.state === 'configured' || r.state === 'not_configured'),
    [...new Set(rows.map((r) => r.state))].join(','));
  ck('every provider is reported', rows.length === Object.keys(PROV.PROVIDERS).length);
  ck('no argument does not throw', PROV.healthRowsFor().length > 0);
  ck('…and with nothing configured, nothing claims to be',
    PROV.healthRowsFor({}).every((r) => r.state === 'not_configured'));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Purity: the engine behaves the same everywhere ──');
{
  ['communication-envelope', 'communication-router', 'communication-providers'].forEach((m) => {
    const src = fs.readFileSync(path.join(ROOT, 'functions', 'shared', m + '.js'), 'utf8');
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ck(m + ': no firestore', !/firestore|admin\./i.test(code));
    ck(m + ': no clock', !/Date\.now|new Date\(/.test(code));
    ck(m + ': no environment', !/process\.env|defineSecret/.test(code));
    ck(m + ': no require — it depends on nothing', !/\brequire\s*\(/.test(code));
    ck(m + ': …and the stripped source still has real code', code.length > 500, code.length + ' chars');
  });
}

console.log('\n── The engine SENDS nothing — notify.js stays the one sender ──');
{
  ['communication-envelope', 'communication-router', 'communication-providers'].forEach((m) => {
    const code = fs.readFileSync(path.join(ROOT, 'functions', 'shared', m + '.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    /* The provider REGISTRY legitimately names providers — that is what a registry is. What
       it must not do is reach for one: no SDK package specifier, no client construction. */
    ck(m + ': pulls in no provider SDK',
      !/@sendgrid|require\(['"]nodemailer|require\(['"]africastalking|sgMail|admin\.messaging/i.test(code));
    ck(m + ': sends nothing', !/\.send\(|sendPush|sendEmail\(|sendSms/i.test(code));
  });
  const tl = fs.readFileSync(path.join(ROOT, 'functions', 'communication-timeline.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the timeline writes nothing', !/\.(set|add|update|delete)\(/.test(tl));
  ck('…and creates no second message store', !/collection\('communications'\)/.test(tl));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The timeline is INCOMPLETE, and says so ──');
{
  const TL = require(path.join(ROOT, 'functions', 'communication-timeline.js'));
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'communication-timeline.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* Superseded by the anchor work in the same slice: `notifyLog` was declared unjoinable and
     now joins. The detailed assertions live in "The anchor" section below; what stays here is
     the invariant that only ANCHORED sources are ever consulted. */
  ck('only anchored sources are joined',
    TL._internals.JOINABLE_SOURCES.every((s) =>
      ['conversations', 'connectSessions', 'notifyLog', 'notifications',
        'supportTickets'].includes(s)),
    TL._internals.JOINABLE_SOURCES.join(','));
  ck('…and every declared unjoinable source states why it cannot join',
    TL._internals.UNJOINABLE_SOURCES.every((s) => !!s.why));
  ck('the response declares itself incomplete', /complete: false/.test(code));
  ck('…and says why', /completeReason/.test(code));
  ck('an unreadable source is reported, never rendered as empty',
    /sourcesUnreadable/.test(code) && /unreadable\.push/.test(code));

  console.log('\n   the vocabulary mismatch is handled, not stumbled into');
  /* Connect stores the COLLECTION in context.anchorType ('orders') and the business kind in
     context.relationship ('order'). Joining on the collection would return nothing for every
     anchor, and an empty timeline reads as "nothing happened". */
  ck('sessions join on `relationship`, never on the collection name',
    /String\(c\.relationship \|\| ''\) === anchorType/.test(code));
  ck('…and the envelope vocabulary is the business kind',
    ENV.ANCHOR_TYPES.includes('order') && !ENV.ANCHOR_TYPES.includes('orders'));

  console.log('\n   a call is not reported as read because it was placed');
  const M = TL._internals.SESSION_STATUS_TO_DELIVERY;
  ck('an authorized session is only queued', M.authorized === 'queued');
  ck('a ringing session is sent, not delivered', M.ringing === 'sent');
  ck('an expired session FAILED — it never reached anyone', M.expired === 'failed');
  ck('…and so did a cancelled one', M.cancelled === 'failed');
  ck('a declined call DID reach them', M.declined === 'delivered');
  ck('a connected call is the strongest evidence there is', M.connected === 'read');
  ck('every session state maps to a real delivery state',
    Object.values(M).every((v) => ENV.DELIVERY_STATES.includes(v)),
    [...new Set(Object.values(M))].join(','));
  const CA = require(path.join(ROOT, 'functions', 'shared', 'connect-authority'));
  ck('…and every Connect state is mapped — none falls through to a guess',
    Object.keys(CA.SESSION_STATES).every((s) => !!M[s]),
    Object.keys(CA.SESSION_STATES).filter((s) => !M[s]).join(',') || 'all mapped');

  console.log('\n   authorization');
  ck('an admin reads the timeline, anyone else must be a participant',
    /if \(!isAdmin\)/.test(code) && /participants\.includes\(uid\)/.test(code));
  ck('…and a non-participant is refused rather than shown an empty timeline',
    /permission-denied/.test(code));
  ck('participants are an authorization INPUT, not output',
    /delete out\.participants/.test(code));
  ck('the callable is registered in index.js',
    /exports\.communicationTimeline = _commsTimeline\.communicationTimeline/
      .test(fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8')));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The anchor: notifyLog can now join ──');
{
  const nsrc = fs.readFileSync(path.join(ROOT, 'functions', 'notify.js'), 'utf8');
  const ncode = nsrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ck('notify() accepts an anchor', /anchorType, anchorId \}\)/.test(ncode));
  ck('…and records it on the log row',
    /anchorType: _anchor\.anchorType/.test(ncode) && /anchorId: _anchor\.anchorId/.test(ncode));
  ck('…with an explicit anchored flag, so a reader never has to infer it',
    /anchored: _anchor\.anchored/.test(ncode));
  ck('…validated against the SHARED vocabulary, not accepted as free text',
    /_envelope\.ANCHOR_TYPES\.includes\(t\)/.test(ncode));
  ck('…imported rather than restated — two anchor lists is how `orders` joins nothing',
    /require\('\.\/shared\/communication-envelope'\)/.test(ncode));

  /* The validator is the part that decides whether a row can ever join, so it is exercised
     rather than read. It is not exported, so it is evaluated from source. */
  const validAnchor = new Function('ANCHOR_TYPES', `
    const _envelope = { ANCHOR_TYPES };
    ${/function _validAnchor[\s\S]*?\n\}/.exec(nsrc)[0]}
    return _validAnchor;`)(ENV.ANCHOR_TYPES);

  ck('a good anchor is accepted', validAnchor('order', 'SK-99420').anchored === true);
  ck('…and normalised', validAnchor('  order ', ' SK-99420 ').anchorId === 'SK-99420');
  ck('a MISSPELLED type is refused — it would look joined and match nothing',
    validAnchor('orders', 'SK-99420').anchored === false);
  ck('…and is dropped rather than stored half-right',
    validAnchor('orders', 'SK-99420').anchorType === null);
  ck('a type with no id is refused', validAnchor('order', '').anchored === false);
  ck('an id with no type is refused', validAnchor('', 'SK-99420').anchored === false);
  ck('nothing at all is refused, not thrown', validAnchor().anchored === false);
  ck('…and an unanchored row records anchored:false explicitly',
    validAnchor().anchorType === null && validAnchor().anchored === false);

  console.log('\n   it is OPTIONAL, so no existing caller breaks');
  ck('the parameter has no default and no throw',
    !/anchorType is required|throw.*anchorType/.test(ncode));
  ck('…an unanchored notification still builds a log row',
    validAnchor(undefined, undefined).anchored === false);

  console.log('\n   Connect is the first caller wired, end to end');
  const cn = fs.readFileSync(path.join(ROOT, 'functions', 'connect-notify.js'), 'utf8');
  ck('it passes the business kind, not the collection',
    /anchorType: \(session\.context && session\.context\.relationship\)/.test(cn));
  ck('…and the anchor id', /anchorId: \(session\.context && session\.context\.anchorId\)/.test(cn));
  /* The chain only closes if the value Connect stores is one the envelope accepts. */
  const CA2 = require(path.join(ROOT, 'functions', 'shared', 'connect-authority'));
  const relationships = Object.keys(CA2.RELATIONSHIPS);
  const unjoinable = relationships.filter((r) => !ENV.ANCHOR_TYPES.includes(r));
  ck('every Connect relationship IS a valid anchor type — the chain closes',
    unjoinable.length === 0, unjoinable.join(',') || 'all join');
  ck('…and the check is not vacuous', relationships.length >= 6, relationships.length + ' kinds');
}

console.log('\n── The timeline joins all three stores, and still says it is partial ──');
{
  const TL = require(path.join(ROOT, 'functions', 'communication-timeline.js'));
  const code = fs.readFileSync(path.join(ROOT, 'functions', 'communication-timeline.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* Grew from three to five in the same slice that added the in-app feed and support cases.
     Asserted by SET rather than by a frozen string, so a source ADDED does not fail while a
     source silently DISAPPEARING still does. */
  ck('the previously-unjoinable stores all join now',
    ['conversations', 'connectSessions', 'notifyLog'].every((x) =>
      TL._internals.JOINABLE_SOURCES.includes(x)),
    TL._internals.JOINABLE_SOURCES.join(','));
  ck('…and nothing is left declared unjoinable',
    TL._internals.UNJOINABLE_SOURCES.length === 0);
  ck('…but the list survives for the NEXT unanchored transport',
    Array.isArray(TL._internals.UNJOINABLE_SOURCES));
  ck('notifications are read by anchor', /\.where\('anchorType', '==', anchorType\)/.test(code));
  ck('…and joined into the same envelope', /_notifyEnvelopes/.test(code));

  /* THE HONESTY PROPERTY. Joining is not the same as covering. */
  ck('coverage is declared, not implied', !!TL._internals.ANCHOR_COVERAGE.wiredCallers);
  ck('…naming which callers are wired',
    TL._internals.ANCHOR_COVERAGE.wiredCallers.length >= 1,
    TL._internals.ANCHOR_COVERAGE.wiredCallers.length + ' wired');
  ck('…and saying older rows can never appear',
    /can never appear in any timeline/.test(TL._internals.ANCHOR_COVERAGE.note));
  ck('the response STILL declares itself incomplete', /complete: false/.test(code));
  ck('…with a reason that names the real cause now',
    /written before the anchor shipped/.test(code));

  console.log('\n   a suppressed notification is not a failed one');
  const M = TL._internals.NOTIFY_STATUS_TO_DELIVERY;
  ck('processing maps to queued — SOKONI has it, no provider does', M.processing === 'queued');
  ck('suppressed stays suppressed, NOT failed', M.suppressed === 'suppressed');
  ck('…and quiet hours are a suppression, not a failure', M.quiet === 'suppressed');
  ck('failed stays failed', M.failed === 'failed');
  ck('every mapping is a real delivery state',
    Object.values(M).every((v) => ENV.DELIVERY_STATES.includes(v)));
  ck('…and none of them invents `read` for a push nobody opened',
    !Object.values(M).includes('read'));
  ck('a notification carries no preview — the body is not on the log row',
    /preview: ''/.test(code));
}

console.log('\n── The console: one module, two mount points ──');
{
  const cPath = path.join(ROOT, 'sokoni-comms-console.js');
  ck('the communications console exists', fs.existsSync(cPath));
  const src = fs.readFileSync(cPath, 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  const aos = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');

  ck('admin-os.html loads it', /sokoni-comms-console\.js/.test(aos));
  ck('…as an Inbox tab on the existing Communications panel',
    /SokoniAOS\.commsTab\('inbox'\)/.test(aos));
  ck('…and the tab has a renderer', /tab === "inbox"/.test(aosJs));
  ck('…which reports a missing module as missing',
    /sokoni-comms-console\.js is served/.test(aosJs));

  ck('super-admin.html loads the SAME module', /sokoni-comms-console\.js/.test(sa));
  ck('…has a nav item', /data-section="comms"/.test(sa));
  ck('…a panel', /id="panel-comms"/.test(sa));
  ck('…a mount point', /id="commsRoot"/.test(sa));
  ck('…a loader', /loadComms\(\)/.test(sa));
  ck('…and nav() dispatches to it', /section==='comms'\)this\.loadComms\(\)/.test(sa));
  ck('…reporting a missing module as missing too',
    /sokoni-comms-console\.js is served on this page/.test(sa));

  const legacy = fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8');
  ck('the legacy admin.html does NOT carry it', !/sokoni-comms-console/.test(legacy));

  console.log('\n   it reads, and it fabricates nothing');
  ck('no write path', !/\.(set|add|update|delete)\(/.test(code));
  ck('…and the only callable it reaches is the read-only timeline',
    /httpsCallable\('communicationTimeline'\)/.test(code) &&
    (code.match(/httpsCallable\(/g) || []).length === 1);
  ck('no localStorage', !/localStorage/.test(code));
  /* Either spelling of the em dash — the literal character or its escape — because an editor
     may normalise one into the other, and the assertion is about the NEUTRAL STATE existing. */
  ck('unknown renders a dash', /DASH = '(—|\\u2014)'/.test(code));
  ck('a canonical zero says it is one', /canonical zero/.test(code));
  ck('counts carry their window', /of the last/.test(code));
  ck('a failed read is reported, not rendered as empty',
    /rows are missing, not absent/.test(code));

  console.log('\n   the write surface is a SEPARATE file');
  const sendPath = path.join(ROOT, 'sokoni-comms-send.js');
  ck('it exists', fs.existsSync(sendPath));
  const scode = fs.readFileSync(sendPath, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('…and the read console still contains no write path',
    !/\.(set|add|update|delete)\(/.test(code));
  ck('…and reaches only the read-only timeline callable',
    (code.match(/httpsCallable\('([a-zA-Z]+)'\)/g) || []).join(',') ===
      "httpsCallable('communicationTimeline')");
  ck('a missing send module is reported, not rendered as "no actions"',
    /sokoni-comms-send\.js is served/.test(code));
  ck('both consoles load it',
    /sokoni-comms-send\.js/.test(aos) && /sokoni-comms-send\.js/.test(sa));

  console.log('\n   plan before send, and no optimism');
  ck('Plan calls the plan op', /communicationPlan/.test(scode));
  ck('…Send calls the send op', /communicationSend/.test(scode));
  ck('…and the plan surface says nothing has been sent',
    /Nothing has been sent/.test(fs.readFileSync(sendPath, 'utf8')));
  ck('success is reported only from what the SERVER returned',
    /r\.plan/.test(scode) && /r\.anchored/.test(scode));
  ck('…a dedupe is shown, not smoothed away', /r\.deduped \?/.test(scode));
  ck('…and an unanchored send is told it will never appear in a timeline',
    /NOT anchored/.test(fs.readFileSync(sendPath, 'utf8')));
  ck('buttons disable in flight', /btn\.disabled = true/.test(scode));
  ck('an undeployed backend is named as such',
    /not deployed yet, so nothing was sent/.test(fs.readFileSync(sendPath, 'utf8')));
  ck('the client renders NO copy of its own — the server owns the library',
    !/Hi \{name\}|refusing to send/.test(scode));

  console.log('\n   it never claims a provider is healthy');
  ck('no provider row reads "operational"', !/operational/i.test(code));
  /* The surface SAYS a green light would be the dashboard lying — that sentence is the point.
     What it must not do is RENDER one: no provider row may carry an active status badge. */
  ck('…and renders no green badge for a provider',
    !/PROVIDER_ROWS[\s\S]{0,1500}st-active/.test(code));
  ck('…the state column is a dash', /'<td class="aos-muted">' \+ DASH/.test(code));
  ck('…and the surface says why in the visible body',
    /liveness is not shown anywhere/.test(src));
  ck('the mailbox-is-not-a-fallback rule is restated where an operator reads it',
    /not a transactional[\s\S]{0,40}fallback/.test(src));

  console.log('\n   the partiality warning travels with the data');
  ck('the timeline block prints `complete: false`', /res\.complete === false/.test(code));
  ck('…and names the wired callers', /wiredCallers/.test(code));
  ck('…and an unreadable source is called out separately',
    /sourcesUnreadable/.test(code) && /missing, not absent/.test(code));
  ck('evidence is explained, not collapsed',
    /suppressed<\/code> means/.test(src));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Templates: approved copy, and the blanks it refuses to send ──');
{
  const TPL = require(path.join(ROOT, 'functions', 'shared', 'communication-templates'));

  ck('all five groups exist',
    TPL.GROUPS.slice().sort().join(',') === 'account,delivery,order,payment,support');
  ck('every group has templates',
    TPL.GROUPS.every((g) => TPL.templatesIn(g).length > 0),
    TPL.GROUPS.map((g) => g + ':' + TPL.templatesIn(g).length).join(' '));
  ck('every template declares a group, channels, a priority and copy',
    TPL.TEMPLATE_IDS.every((id) => {
      const t = TPL.TEMPLATES[id];
      return TPL.GROUPS.includes(t.group) && Array.isArray(t.channels) && t.channels.length
        && ENV.PRIORITIES.includes(t.priority) && !!t.subject && !!t.body;
    }));
  ck('…and every declared channel is a real channel',
    TPL.TEMPLATE_IDS.every((id) => TPL.TEMPLATES[id].channels.every((c) => ENV.CHANNELS.includes(c))));
  ck('the library is frozen', Object.isFrozen(TPL.TEMPLATES));

  console.log('\n   a missing variable is a REFUSAL, not a blank');
  const full = { name: 'John', orderRef: 'SK-99420', shop: 'Kass' };
  ck('a complete render works',
    TPL.render({ templateId: 'order_confirmed', channel: 'sms', vars: full })
      .body === 'Hi John, Kass has confirmed order SK-99420.');
  ck('…a missing variable throws',
    throws(() => TPL.render({ templateId: 'order_confirmed', channel: 'sms',
      vars: { name: 'John', orderRef: 'SK-99420' } })));
  ck('…an EMPTY STRING counts as missing — "Hi ," is the failure this prevents',
    throws(() => TPL.render({ templateId: 'order_confirmed', channel: 'sms',
      vars: { name: '', orderRef: 'SK-99420', shop: 'Kass' } })));
  ck('…and so does whitespace',
    throws(() => TPL.render({ templateId: 'order_confirmed', channel: 'sms',
      vars: { name: '   ', orderRef: 'SK-99420', shop: 'Kass' } })));
  ck('…and null', throws(() => TPL.render({ templateId: 'order_confirmed', channel: 'sms',
    vars: { name: null, orderRef: 'SK-99420', shop: 'Kass' } })));
  ck('no rendered output can contain an unfilled placeholder',
    TPL.TEMPLATE_IDS.every((id) => {
      const t = TPL.TEMPLATES[id];
      const vars = {};
      TPL.requiredVariables(id).forEach((v) => { vars[v] = 'X'; });
      const r = TPL.render({ templateId: id, channel: t.channels[0], vars });
      return !/\{[a-zA-Z]/.test(r.subject + r.body);
    }));

  console.log('\n   a template is only valid on the channels it declares');
  ck('account_restricted is email and in-app only — a restriction needs explaining',
    TPL.TEMPLATES.account_restricted.channels.slice().sort().join(',') === 'email,in_app');
  ck('…so SMS is refused',
    throws(() => TPL.render({ templateId: 'account_restricted', channel: 'sms',
      vars: { name: 'J', reason: 'r' } })));
  ck('…and push is refused too',
    throws(() => TPL.render({ templateId: 'account_restricted', channel: 'push',
      vars: { name: 'J', reason: 'r' } })));
  ck('…positive control: email renders',
    !!TPL.render({ templateId: 'account_restricted', channel: 'email',
      vars: { name: 'J', reason: 'r' } }).body);
  ck('an unknown template is refused',
    throws(() => TPL.render({ templateId: 'nope', channel: 'email', vars: {} })));
  ck('no arguments does not silently produce copy', throws(() => TPL.render()));

  console.log('\n   money templates are critical, and browsing copy is not');
  ['payment_received', 'payment_failed', 'refund_processed'].forEach((id) => {
    ck('…' + id + ' is critical', TPL.TEMPLATES[id].priority === 'critical');
  });
  ck('order_received is commerce, not critical',
    TPL.TEMPLATES.order_received.priority === 'commerce');
  ck('…so it can never route to SMS',
    !ROUTER.routeFor({ priority: TPL.TEMPLATES.order_received.priority,
      hasPhone: true, hasPushTarget: true, hasEmail: true, present: true }).plan.includes('sms'));

  console.log('\n   a custom message is allowed, and marked as custom');
  const c = TPL.describeCustom('Hello', 'A one-off note');
  ck('it renders', c.body === 'A one-off note');
  ck('…and is NOT dressed up as a template', c.templateId === null && c.source === 'custom');
  ck('…while a template says it is one',
    TPL.render({ templateId: 'order_received', channel: 'email',
      vars: { name: 'J', orderRef: 'X' } }).source === 'template');
  ck('an empty custom message is refused', throws(() => TPL.describeCustom('s', '')));

  console.log('\n   purity');
  const tcode = fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'communication-templates.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no firestore, clock, env or require',
    !/firestore|admin\.|Date\.now|process\.env|\brequire\s*\(/.test(tcode));
  ck('…and it sends nothing', !/\.send\(|notify\(/.test(tcode));
  ck('the placeholder syntax has no logic — a copy library must not be a program',
    !/\{\{|\{#|\{%|eval\(/.test(tcode));
}

console.log('\n── The router has a PRODUCTION CALLER at last ──');
{
  const SEND = require(path.join(ROOT, 'functions', 'communication-send.js'));
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'communication-send.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  /* The defect this closes: a policy module nothing consulted is a table with no reader. */
  ck('communicationPlan routes through the router', /ROUTER\.routeFor\(\{/.test(code));
  ck('…and so does communicationSend',
    (code.match(/ROUTER\.routeFor\(\{/g) || []).length >= 2,
    (code.match(/ROUTER\.routeFor\(\{/g) || []).length + ' call sites');
  ck('…so a commerce message still cannot become an SMS',
    !ROUTER.routeFor({ priority: 'commerce', present: true, hasPushTarget: true,
      hasEmail: true, hasPhone: true }).plan.includes('sms'));
  ck('the plan callable SENDS NOTHING', /sent: false/.test(code));
  ck('…and returns why each channel was ruled out', /considered: route\.considered/.test(code));
  ck('…rendered for the operator', /ROUTER\.explain\(route\)/.test(code));

  console.log('\n   it resolves, it does not send');
  ck('notify.js does the sending', /notify\.notify\(\{/.test(code));
  ck('…and no provider SDK is reached',
    !/@sendgrid|nodemailer|africastalking|admin\.messaging/.test(code));
  ck('a send failure is reported, never smoothed into success',
    /Nothing was sent/.test(code));
  ck('…and a dedupe is reported as a dedupe', /deduped: !!\(result && result\.deduped\)/.test(code));

  console.log('\n   reachability is READ, and every absence reads as false');
  ck('presence comes from the same document Connect uses',
    /collection\('presence'\)/.test(code));
  ck('tokens come from the ONE notification engine, not a second field',
    /notify\.collectTokens/.test(code) && !/fcmToken/.test(code));
  ck('…and a failed lookup is treated as unreachable',
    /treating as unreachable/.test(src));
  ck('an address is NEVER returned — only whether a channel exists',
    /hasEmail: !!\(u\.email/.test(code) && !/email: u\.email/.test(code));

  console.log('\n   the anchor is validated, not trusted');
  ck('a half anchor is refused', /an anchor needs both anchorType and anchorId/.test(src));
  ck('…and an unknown type is refused', /ENV\.ANCHOR_TYPES\.includes\(anchorType\)/.test(code));
  ck('…because a message recorded unanchored vanishes from the timeline an operator searches',
    /anchorType: anchorType \|\| undefined/.test(code));
  ck('an admin cannot message themselves', /recipientUid === adminUid/.test(code));

  console.log('\n   provider health reports PROVISIONING, and leaks nothing');
  ck('it says what it measures', /measures: 'provisioning and observed liveness'/.test(code));
  ck('…and what it does not', /doesNotMeasure/.test(code));
  ck('…naming liveness explicitly', /a provider with no recorded attempt reads unobserved/.test(src) &&
      /which is not healthy and not down/.test(src));
  const conf = SEND._internals._configuredFromEnv();
  ck('every provider is reported', Object.keys(conf).length === Object.keys(PROV.PROVIDERS).length,
    Object.keys(conf).join(','));
  ck('…as a BOOLEAN — no secret value, no length, no prefix',
    Object.values(conf).every((v) => typeof v === 'boolean'));
  ck('…and the source never returns a secret',
    !/env\[k\]\s*\}|value\(\)/.test(code.split('_configuredFromEnv')[1] || ''));
  ck('TURN is unprovisioned and says so', conf.turn === false);
  ck('…and Google Workspace too — "we have no human mailbox transport" must be visible',
    conf.google_workspace === false);
  ck('FCM needs no key, so it is not reported as missing', conf.fcm === true);
  ck('the failover policy travels with the health read', /failoverPolicy/.test(code));

  console.log('\n   admin only, on the server');
  /* Invocations only — the declaration `function _requireAdmin(req)` matches the same text
     and would make three call sites read as four. */
  const adminCalls = (code.match(/(?<!function )_requireAdmin\(req\)/g) || []).length;
  ck('all three callables require a platform admin', adminCalls === 3, adminCalls + ' call sites');
  ck('…and the check is a claim, not a field',
    /t\.admin !== true && t\.superAdmin !== true/.test(code));
  ck('all three are registered in index.js',
    ['communicationPlan', 'communicationSend', 'communicationHealth'].every((n) =>
      new RegExp('exports\\.' + n + '\\s*=').test(
        fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8'))));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Anchor coverage is MEASURED, and the detector is controlled ──');
{
  const { execFileSync } = require('child_process');
  let audit = null;
  try {
    audit = JSON.parse(execFileSync(process.execPath,
      [path.join(ROOT, 'scripts', 'audit-communication-anchors.js'), '--json'],
      { encoding: 'utf8' }));
  } catch (e) {
    ck('the audit runs', false, (e && e.message || '').slice(0, 70));
  }
  ck('the audit runs and reports JSON', !!audit);

  if (audit) {
    /* THE CONTROL. The first draft of the local-notifier detector looked for `notify` when
       the helpers are named `_notify`, found nothing, and reported five bypassing modules as
       compliant. A detector that cannot match is indistinguishable from an absence — which is
       the most dangerous result an audit can produce, because it reads as good news. */
    ['automation-engine.js', 'financial-os.js', 'franchise-engine.js', 'installments.js',
      'loyalty.js'].forEach((f) => {
      ck('…the control finds ' + f,
        audit.localNotifiers.some((m) => m.file === f));
    });
    ck('…and the audit EXITS NON-ZERO if the control fails', /DETECTOR CONTROL FAILED/.test(
      fs.readFileSync(path.join(ROOT, 'scripts', 'audit-communication-anchors.js'), 'utf8')));

    console.log('\n   what it found');
    ck('several modules BYPASS the one engine with their own notifier',
      audit.localNotifiers.length >= 5, audit.localNotifiers.length + ' modules');
    ck('…and the size of the bypass is counted, not described as "some"',
      audit.localNotifiers.every((m) => typeof m.uses === 'number' && m.uses > 0),
      audit.localNotifiers.reduce((n, m) => n + m.uses, 0) + ' calls');
    ck('the engine callers are enumerated', audit.engineCallers.length >= 10);
    ck('…and split into anchored and not',
      audit.anchored.length + audit.unwired.length === audit.engineCallers.length);
    ck('connect-notify is anchored', audit.anchored.includes('connect-notify.js'));
    ck('…and so is the admin send path', audit.anchored.includes('communication-send.js'));
    ck('…and booking payments now are too',
      audit.anchored.includes('booking-payment-sweep.js'), audit.anchored.join(','));

    console.log('\n   it refuses to flatter itself');
    ck('context-free types are DECLARED, so the exclusion can be argued with',
      audit.contextFreeTypes.length >= 8, audit.contextFreeTypes.join(',').slice(0, 60));
    ck('…and an OTP is among them — there is no business object at login',
      audit.contextFreeTypes.includes('otp'));
    ck('…as is a welcome message', audit.contextFreeTypes.includes('welcome'));
    const src = fs.readFileSync(path.join(ROOT, 'scripts', 'audit-communication-anchors.js'), 'utf8');
    ck('it says coverage over engine callers is NOT coverage over SOKONI',
      /not coverage over SOKONI/.test(src));
    ck('…and warns against inventing anchors to raise a number',
      /never anchor these to raise a number|inventing one to raise a percentage/.test(src));
    ck('it is read-only', !/\.(set|add|update|delete|writeFileSync)\(/.test(
      src.replace(/\/\*[\s\S]*?\*\//g, '')));
  }
}

console.log('\n── Booking notifications now carry their anchor ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'booking-payment-sweep.js'), 'utf8');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sites = (code.match(/anchorType: 'booking'/g) || []).length;
  ck('every booking notification passes one', sites === 3, sites + ' sites');
  ck('…using the canonical id, not the payment ref',
    !/anchorId: apiRef/.test(code) && /anchorId: bookingId/.test(code));
  ck('…and `booking` is an approved anchor type', ENV.ANCHOR_TYPES.includes('booking'));
  /* A real canonical object, not a manufactured one. */
  ck('…which refers to a real collection', /collection\('providerBookings'\)/.test(code));
  ck('an absent id degrades to unanchored rather than to a wrong anchor',
    /anchorId: bookingId \|\| undefined/.test(code));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── One anchor resolver, and it refuses to guess ──');
{
  ck('an orderId anchors to order',
    JSON.stringify(ENV.anchorFrom({ orderId: 'SK-1' })) ===
      JSON.stringify({ anchorType: 'order', anchorId: 'SK-1' }));
  ck('a bookingId anchors to booking', ENV.anchorFrom({ bookingId: 'B1' }).anchorType === 'booking');
  ck('a deliveryId anchors to delivery', ENV.anchorFrom({ deliveryId: 'D1' }).anchorType === 'delivery');
  ck('a ticketId anchors to support', ENV.anchorFrom({ ticketId: 'C1' }).anchorType === 'support');

  /* A payment reference identifies a transaction with a PROVIDER, not a SOKONI relationship.
     Anchoring to it would create a timeline nobody can look up. */
  ck('a payment ref is NOT an anchor', ENV.anchorFrom({ payRef: 'ISL_123' }) === null);
  ck('…nor a transaction id', ENV.anchorFrom({ fosTransactionId: 'T1' }) === null);
  ck('…nor a dispute id — a dispute is not an approved relationship',
    ENV.anchorFrom({ disputeId: 'D9' }) === null);
  ck('nothing matching returns NULL rather than a guess', ENV.anchorFrom({ foo: 1 }) === null);
  ck('an empty value is not an anchor', ENV.anchorFrom({ orderId: '   ' }) === null);
  ck('no argument does not throw', ENV.anchorFrom() === null);
  ck('order wins over delivery when both are present — the leg belongs to the order',
    ENV.anchorFrom({ deliveryId: 'D1', orderId: 'SK-1' }).anchorType === 'order');
  ck('every resolved type is an approved anchor type',
    ENV.ANCHOR_ID_FIELDS.every(([, t]) => ENV.ANCHOR_TYPES.includes(t)));

  console.log('\n   the local in-app writers now record it');
  ['financial-os.js', 'automation-engine.js'].forEach((f) => {
    const code = fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    ck('…' + f + ' uses the ONE resolver', /_ENV\.anchorFrom\(/.test(code));
    ck('…' + f + ' records anchored explicitly', /anchored: !!a/.test(code));
    ck('…' + f + ' still writes the same collection — send behaviour unchanged',
      /collection\('notifications'\)/.test(code));
    ck('…' + f + ' did NOT gain a send path',
      !/notify\.notify\(|admin\.messaging|sendPush/.test(code));
  });
}

console.log('\n── The in-app feed and support cases join ──');
{
  const TL = require(path.join(ROOT, 'functions', 'communication-timeline.js'));
  const code = fs.readFileSync(path.join(ROOT, 'functions', 'communication-timeline.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  ck('five sources are joinable now',
    TL._internals.JOINABLE_SOURCES.join(',') ===
      'conversations,connectSessions,notifyLog,notifications,supportTickets');
  ck('the in-app feed is read by anchor', /_inAppEnvelopes/.test(code));
  /* `notifications` spells the recipient TWO ways. Reading one would silently drop half the
     platform, and an empty timeline reads as "nothing happened". */
  ck('…and BOTH recipient spellings are read', /n\.uid \|\| n\.userId/.test(code));
  ck('…an unread in-app row is delivered, a read one is read',
    /n\.read === true \? 'read' : 'delivered'/.test(code));

  ck('support cases join on their own id', /_supportEnvelopes/.test(code));
  ck('…only for the support anchor', /anchorType !== 'support'\) return \[\]/.test(code));
  ck('…the opening message is projected', /communicationId: 'case:' \+ anchorId/.test(code));
  ck('…and the RESOLUTION is a second communication, not a field on the first',
    /case:' \+ anchorId \+ ':resolution'/.test(code));
  ck('…which is right: it happened later, by somebody else',
    /t\.resolvedBy/.test(code));
  ck('NO second message store is created',
    !/collection\('communications'\)/.test(code) && !/\.(set|add|update)\(/.test(code));

  console.log('\n   coverage is still reported honestly');
  ck('five call sites are named as wired',
    TL._internals.ANCHOR_COVERAGE.wiredCallers.length === 5,
    TL._internals.ANCHOR_COVERAGE.wiredCallers.length + '');
  ck('…and the note says the rest are not',
    /the rest are not/.test(TL._internals.ANCHOR_COVERAGE.note));
  ck('…and that some events are genuinely context-free',
    /context-free/.test(TL._internals.ANCHOR_COVERAGE.note));
  ck('the response STILL declares itself incomplete', /complete: false/.test(code));
  ck('every new source is failure-isolated',
    /source: 'notifications', reason/.test(code) && /source: 'supportTickets', reason/.test(code));
}

console.log('\n── Kass AI: informative, never authoritative ──');
{
  const K = require(path.join(ROOT, 'functions', 'shared', 'kass-knowledge'));

  console.log('\n   it cannot change anything');
  const cannot = ['authorize_payment', 'release_funds', 'issue_refund', 'modify_order',
    'modify_financial_record', 'set_verification', 'declare_verified', 'modify_permissions',
    'set_custom_claims', 'alter_connect_state', 'place_call', 'choose_recipient',
    'send_communication'];
  cannot.forEach((a) => {
    const r = K.mayPerform(a);
    ck('…' + a + ' is refused', !r.allowed, r.reason.slice(0, 44));
  });
  ck('…and each refusal states WHY, not "unknown action"',
    cannot.every((a) => K.mayPerform(a).reason !== 'not_a_permitted_assistant_action'));

  console.log('\n   it fails CLOSED on anything nobody considered');
  ['reboot_platform', 'grant_enterprise', 'delete_user', ''].forEach((a) => {
    ck('…' + (a || '(empty)') + ' is refused', !K.mayPerform(a).allowed);
  });
  ck('no argument is refused', !K.mayPerform().allowed);
  /* Positive control: it does permit the informational actions, so the refusals above are
     about authority and not a guard that denies everything. */
  ck('…positive control: explaining the platform IS permitted',
    K.mayPerform('explain_platform').allowed);
  ck('…and summarising a communication history is too',
    K.mayPerform('summarise_communication_history').allowed);
  ck('the two lists are disjoint — nothing is both permitted and forbidden',
    !K.PERMITTED_ACTIONS.some((a) => K.isForbidden(a)));

  console.log('\n   it cannot choose who to contact');
  /* The defect Connect exists to prevent, reintroduced through an assistant is still the
     defect. */
  ['calleeUid', 'recipientUid', 'participantUids', 'phone', 'email'].forEach((k) => {
    const req = { anchorType: 'order', anchorId: 'SK-99420' };
    req[k] = 'someone';
    const r = K.recipientFromAnchorOnly(req);
    ck('…naming ' + k + ' is refused', !r.allowed, r.reason.slice(0, 48));
  });
  ck('…an anchor alone IS allowed',
    K.recipientFromAnchorOnly({ anchorType: 'order', anchorId: 'SK-99420' }).allowed);
  ck('…and no anchor at all is refused',
    !K.recipientFromAnchorOnly({}).allowed);
  ck('…for the stated reason',
    K.recipientFromAnchorOnly({}).reason === 'no_business_anchor');
  ck('no argument does not throw', K.recipientFromAnchorOnly().allowed === false);

  console.log('\n   a plan is never presented as a capability');
  ck('current is assertable', K.capabilityClaimAllowed('current'));
  ck('…and recent', K.capabilityClaimAllowed('recent'));
  ck('planned is NOT — "SOKONI supports X" is false when X is planned',
    !K.capabilityClaimAllowed('planned'));
  ck('forecast is NOT', !K.capabilityClaimAllowed('forecast'));
  ck('historical is NOT a capability claim either',
    !K.capabilityClaimAllowed('historical'));
  ck('an unknown status is not assertable', !K.capabilityClaimAllowed('probably'));

  console.log('\n   unclassified knowledge defaults to PLANNED, not current');
  /* The dangerous default. This repo's docs describe frozen contracts, gates and roadmaps;
     reading an unlabelled one as current is exactly how "SOKONI places calls" gets said. */
  ck('an unlabelled source is planned', K.classify({}) === 'planned');
  ck('…and so is a garbage label', K.classify({ status: 'probably' }) === 'planned');
  ck('no argument is planned', K.classify() === 'planned');
  ck('a declared status is kept', K.classify({ status: 'current' }) === 'current');
  ck('…but an EXPIRED "current" is historical — the document is not the authority on that',
    K.classify({ status: 'current', expired: true }) === 'historical');
  ck('…and an expired historical stays historical',
    K.classify({ status: 'historical', expired: true }) === 'historical');

  console.log('\n   every answer carries what it may be read as');
  const f = K.describeAnswer({ status: 'forecast', text: 'WebRTC is the next dependency' });
  ck('a forecast is labelled', f.label === 'Forecast');
  ck('…is not assertable', f.assertable === false);
  ck('…and carries an explicit disclaimer', /analysis/.test(f.disclaimer || ''));
  ck('…which says it is not a date', /not a commitment or a date/.test(f.disclaimer || ''));
  const p = K.describeAnswer({ status: 'planned', text: 'C3-B is next' });
  ck('a planned answer says it is not built', /not something SOKONI does today/.test(p.disclaimer || ''));
  const h = K.describeAnswer({ status: 'historical', text: 'Connect used other states' });
  ck('a historical answer says it is not current', /used to work/.test(h.disclaimer || ''));
  const c = K.describeAnswer({ status: 'current', text: 'C1 and C2 are frozen' });
  ck('a current answer needs no disclaimer', c.disclaimer === null && c.assertable === true);
  ck('an unlabelled answer is treated as planned',
    K.describeAnswer({ text: 'x' }).status === 'planned');
  ck('…and the text is never rewritten — only labelled',
    K.describeAnswer({ status: 'current', text: 'exact' }).text === 'exact');

  console.log('\n   purity');
  const kcode = fs.readFileSync(path.join(ROOT, 'functions', 'shared', 'kass-knowledge.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('no firestore, clock, env or require',
    !/firestore|admin\.|Date\.now|process\.env|\brequire\s*\(/.test(kcode));
  ck('…and it calls no model', !/anthropic|openai|messages\.create/i.test(kcode));
  ck('…and writes nothing', !/\.(set|add|update|delete)\(/.test(kcode));
  ck('the status table is frozen', Object.isFrozen(K.KNOWLEDGE_STATUS));
  ck('…and so are the action lists',
    Object.isFrozen(K.PERMITTED_ACTIONS) && Object.isFrozen(K.FORBIDDEN_ACTIONS));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── The Communication Engine contracts are FROZEN ──');
{
  /* Frozen 2026-09-22, the same way C1 and C2 are: declared surface, asserted both ways, so a
     removal or rename fails a gate instead of being found by the next consumer. */
  const missing = ENV.CONTRACT.filter((k) => ENV[k] === undefined);
  ck('every declared envelope name is exported', missing.length === 0, missing.join(',') || 'none');
  const undeclared = Object.keys(ENV).filter((k) => k !== 'CONTRACT' && !ENV.CONTRACT.includes(k));
  ck('…and every export is declared — no accidental surface',
    undeclared.length === 0, undeclared.join(',') || 'none');
  ck('the contract is frozen', Object.isFrozen(ENV.CONTRACT));

  console.log('\n   the anchor resolver contract, pinned');
  /* These four are the behaviour, not the shape. Loosening any of them files a real
     communication under a relationship that does not exist. */
  ck('1. canonical ids only — nothing inferred beyond the table',
    ENV.anchorFrom({ someOtherId: 'X' }) === null);
  ck('2. a payment reference is NEVER an anchor',
    ENV.anchorFrom({ payRef: 'ISL_1' }) === null &&
    ENV.anchorFrom({ paymentRef: 'ISL_1' }) === null &&
    ENV.anchorFrom({ apiRef: 'ISL_1' }) === null);
  ck('3. no guessing — unmatched input returns NULL, not a best effort',
    ENV.anchorFrom({ id: 'X', ref: 'Y', uid: 'Z' }) === null);
  ck('4. an empty or whitespace id is not an anchor',
    ENV.anchorFrom({ orderId: '' }) === null && ENV.anchorFrom({ orderId: '\t ' }) === null);
  ck('…positive control: a canonical id still resolves',
    ENV.anchorFrom({ orderId: 'SK-1' }).anchorType === 'order');
  ck('the id table is frozen', Object.isFrozen(ENV.ANCHOR_ID_FIELDS));

  console.log('\n   the notification-schema compatibility, pinned');
  const tlCode = fs.readFileSync(path.join(ROOT, 'functions', 'communication-timeline.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* `notifications` spells the recipient two ways. Reading one silently drops the other
     population, and an empty timeline reads as "nothing happened". */
  ck('both recipient spellings are read', /n\.uid \|\| n\.userId/.test(tlCode));
  ck('…and the local writers still use their own spelling, untouched',
    /userId: uid/.test(fs.readFileSync(path.join(ROOT, 'functions', 'automation-engine.js'), 'utf8')) &&
    /\buid, type,/.test(fs.readFileSync(path.join(ROOT, 'functions', 'financial-os.js'), 'utf8')));

  console.log('\n   the support projection, pinned');
  ck('a case projects its opening message', /communicationId: 'case:' \+ anchorId,/.test(tlCode));
  ck('…and its resolution as a SEPARATE communication',
    /':resolution'/.test(tlCode));
  ck('…from the canonical document, with no second store',
    /collection\('supportTickets'\)/.test(tlCode) &&
    !/collection\('communications'\)/.test(tlCode));
  ck('…and the timeline writes nothing at all', !/\.(set|add|update|delete)\(/.test(tlCode));
}

console.log('\n── The C2/C3 boundary is explicit ──');
{
  /* C3-C is being built in parallel. C2 owns projection and action presentation; C3 owns media
     transport. The guard that matters is not "there is no media" — that boundary has moved —
     but that the PROJECTION layer never becomes a second media authority. */
  const c2 = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the C2 projection creates no peer connection',
    !/RTCPeerConnection|getUserMedia|createOffer|createAnswer/.test(c2));
  ck('…configures no ICE servers', !/iceServers|turn:|stun:/.test(c2));
  ck('…interprets no media event — it forwards them',
    !/media_flowing|ice_connected|connection_failed/.test(c2));
  ck('…and invents no media-driven transition',
    !/'connecting'|'connected'|'failed'/.test(c2));
  ck('the only media route is the report op', /connectReportMediaEvent/.test(c2));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PHASE 2 — support reaches SOKONI
══════════════════════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════════════════════
   PHASE 1 — contextual communication actions
══════════════════════════════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════════════════════════════
   PHASE 1 — the two surfaces that CANNOT be mounted, and why
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── Delivery RESOLVED by evidence; supplier still BLOCKED ──');
{
  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');

  /* DELIVERY — RETARGETED, not deleted. These assertions recorded the BLOCKER:
     the anchor read `deliveries` while both surfaces read `packageRequests`.
     The trace in docs/DELIVERY_ANCHOR_AUTHORITY.md resolved it — they are two
     different products, and `packageRequests` is the marketplace relationship
     the frozen authority describes. So each assertion now states the RESOLUTION
     rather than the defect, and the full regression lives in
     scripts/test-delivery-anchor-authority.js. */
  ck('the delivery anchor now reads `packageRequests`',
    /collection\('packageRequests'\)\.doc\(anchorId\)/.test(calls));
  ck('…and no longer reads the hub collection by document id',
    !/collection\('deliveries'\)\.doc\(anchorId\)/.test(calls));
  const dt = fs.readFileSync(path.join(ROOT, 'delivery-tracking.html'), 'utf8');
  const sd = fs.readFileSync(path.join(ROOT, 'seller-delivery.html'), 'utf8');
  ck('…which is what delivery-tracking.html reads',
    /collection\('packageRequests'\)/.test(dt));
  ck('…and what seller-delivery.html reads too',
    /collection\('packageRequests'\)/.test(sd));
  /* The anchor is correct now; MOUNTING is a separate step, and claiming a
     mounted surface that does not exist would be the fabrication this suite
     exists to prevent. */
  /* RETARGETED again: delivery-tracking.html IS now mounted, and
     scripts/test-delivery-mount.js owns that surface's assertions.
     seller-delivery.html is NOT, and saying so keeps the claimed surface
     honest rather than letting one mount imply two. */
  ck('delivery-tracking.html is mounted on the resolved anchor',
    /sokoni-connect-call\.js/.test(dt));
  /* RETARGETED a third time, and this is the last move it should need: both
     Marketplace delivery surfaces are now mounted on the canonical anchor, so
     the delivery capability has no ambiguous half. scripts/test-delivery-mount.js
     and scripts/test-seller-delivery-mount.js own their surfaces' assertions;
     what belongs HERE is only that neither one drifted back to the hub. */
  ck('seller-delivery.html is mounted on the same canonical anchor',
    /sokoni-connect-call\.js/.test(sd));
  ck('…and neither delivery surface reads the Delivery Hub collection',
    !/collection\(['"]deliveries['"]\)/.test(sd));

  /* SUPPLIER. `collection('suppliers')` has no writer anywhere in functions/ except the
     resolver that reads it, and no client surface reads it at all. */
  const supplierWriters = fs.readdirSync(path.join(ROOT, 'functions'))
    .filter((f) => f.endsWith('.js'))
    .filter((f) => f !== 'connect-calls.js')
    .filter((f) => /collection\('suppliers'\)/.test(
      fs.readFileSync(path.join(ROOT, 'functions', f), 'utf8')));
  ck('the `suppliers` collection has no writer besides the resolver that reads it',
    supplierWriters.length === 0, supplierWriters.join(',') || 'none');
  ck('…and the supply anchor refuses when the record names no SOKONI account',
    /not a SOKONI account, so no in-platform call/.test(calls));
  /* Positive control: the two surfaces that COULD be mounted, were. */
  ck('…positive control: order IS mounted',
    /sokoni-connect-call\.js/.test(fs.readFileSync(path.join(ROOT, 'my-orders.html'), 'utf8')));
  ck('…and support IS wired',
    /SokoniSupportContact/.test(fs.readFileSync(path.join(ROOT, 'support.html'), 'utf8')));
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   PHASES 3 & 4 — the operational workspace
══════════════════════════════════════════════════════════════════════════════════════════ */
console.log('\n── One workspace, one engine, one fetch ──');
{
  const src = fs.readFileSync(path.join(ROOT, 'sokoni-comms-console.js'), 'utf8');
  const sb = { SokoniCommsConsole: null, firebase: null, document: null, SokoniCommsSend: null };
  new Function('window', src)(sb);
  const C = sb.SokoniCommsConsole;

  ck('the console declares its views', Array.isArray(C.VIEWS) && C.VIEWS.length >= 6,
    C.VIEWS.map((v) => v.id).join(','));
  ['inbox', 'conversations', 'support', 'calls', 'send', 'providers'].forEach((v) => {
    ck('…' + v, C.VIEWS.some((x) => x.id === v));
  });

  console.log('\n   every view declares an authority band');
  ck('each view has one', C.VIEWS.every((v) => ['READ', 'SEND'].includes(v.authority)));
  ck('…and exactly one is above READ',
    C.VIEWS.filter((v) => v.authority !== 'READ').length === 1,
    C.VIEWS.filter((v) => v.authority !== 'READ').map((v) => v.id).join(','));
  /* THE PROPERTY: a read-only component must not gain a hidden write capability because a
     tab was added next to it. The write view is DELEGATED to the separate module. */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('this file still contains NO write path',
    !/\.(set|add|update|delete)\(/.test(code));
  ck('…and still reaches exactly one callable — the read-only timeline',
    (code.match(/httpsCallable\('([a-zA-Z]+)'\)/g) || []).join(',') ===
      "httpsCallable('communicationTimeline')");
  ck('…the SEND view is delegated to the separate module',
    /SokoniCommsSend\.mount\(/.test(code));
  ck('…and a missing write module is reported, not silently read-only',
    /sokoni-comms-send\.js is served/.test(code));

  console.log('\n   a view is a FILTER on the one fetch, never a second query');
  const rows = [{ kind: 'chat' }, { kind: 'voice' }, { kind: 'support' }, { kind: 'video' }];
  ck('inbox shows everything', C.rowsForView('inbox', rows).length === 4);
  ck('conversations shows chat only',
    C.rowsForView('conversations', rows).map((r) => r.kind).join(',') === 'chat');
  ck('support shows support only',
    C.rowsForView('support', rows).map((r) => r.kind).join(',') === 'support');
  ck('calls shows voice AND video',
    C.rowsForView('calls', rows).map((r) => r.kind).join(',') === 'voice,video');
  ck('an unknown view falls back to everything rather than to silence',
    C.rowsForView('nope', rows).length === 4);
  ck('no argument does not throw', C.rowsForView().length === 0);
  /* The single-fetch rule: only ONE place queries, and switching a view re-paints. */
  ck('only one fetch exists — switching a view re-filters, it does not re-query',
    (code.match(/\.limit\(PAGE\)/g) || []).length === 2 && /_paint\(root\)/.test(code),
    'two collections, one fetch each');

  console.log('\n   both consoles mount the SAME module');
  const aos = fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8');
  const sa = fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8');
  ck('AdminOS loads it', /sokoni-comms-console\.js/.test(aos));
  ck('Super Admin loads it', /sokoni-comms-console\.js/.test(sa));
  ck('…and neither re-implements the views',
    !/rowsForView/.test(aos) && !/rowsForView/.test(sa));
  /* AdminOS mounts from sokoni-aos.js (its panel renderer), Super Admin from its own inline
     loader. Different mount POINTS, one module — which is the property that matters. */
  const aosJs = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8');
  ck('…so both produce equivalent views over the same records',
    /SokoniCommsConsole\.mount/.test(aosJs) && /SokoniCommsConsole\.mount/.test(sa));
  ck('…and neither mount point re-implements the filter',
    !/rowsForView/.test(aosJs) && !/rowsForView/.test(sa));
}

console.log('\n── The server decides which actions a surface may draw ──');
{
  const calls = fs.readFileSync(path.join(ROOT, 'functions', 'connect-calls.js'), 'utf8');
  const code = calls.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const mod = require(path.join(ROOT, 'functions', 'connect-calls.js'));

  ck('connectAvailableActions exists', Object.keys(mod._h).includes('connectAvailableActions'));
  ck('…it resolves the anchor server-side', /const resolver = ANCHORS\[anchorType\]/.test(code));
  ck('…derives the caller role from the document, never the request',
    /roles\.find\(\(r\) => String\(parties\[r\]\) === String\(uid\)\)/.test(code));
  ck('…maps the lifecycle with the SAME resolver every Connect path uses',
    /relationshipState: anchor\.state/.test(code));
  ck('…consults the PRODUCT surface policy', /surface\.callSurfaceFor\(\{/.test(code));
  ck('…and then the AUTHORITY, per channel', /CA\.mayCommunicate\(\{/.test(code));
  ck('…so the surface can only ever REMOVE channels, never add one',
    /\['chat', 'voice'\]\.filter/.test(code));

  console.log('\n   it names no person');
  ck('the response carries roles and labels only',
    /targetRole,\s*\n\s*channels,/.test(code) && !/calleeUid:/.test(code.split('connectAvailableActions')[1] || ''));
  ck('…and says it authorizes nothing',
    /authorizes: false/.test(code));
  ck('a non-party gets an empty list with a reason, not an error',
    /reason: 'not_party_to_this'/.test(code));
  ck('…and an unreadable anchor likewise', /reason: 'anchor_unavailable'/.test(code));

  console.log('\n   the client asks rather than maps');
  const clientSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-call.js'), 'utf8');
  const clientCode = clientSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const sb = { SokoniConnectCall: null, document: null };
  new Function('window', clientSrc)(sb);
  const CC = sb.SokoniConnectCall;
  ck('mountForAnchor exists', typeof CC.mountForAnchor === 'function');
  ck('…and is in the declared contract', CC.CONTRACT.includes('mountForAnchor'));
  ck('…it calls the server op', /connectAvailableActions/.test(clientCode));
  ck('…renders NOTHING when nothing is offered — no dead button',
    /if \(!actions\.length\) \{ root\.innerHTML = ''; return null; \}/.test(clientCode));
  ck('…and nothing when the ask itself fails',
    /\.catch\(function \(\) \{[\s\S]{0,120}root\.innerHTML = ''/.test(clientCode));
  ck('…it still sends an anchor and a ROLE, never a person',
    /requestPayload\(\{[\s\S]{0,200}targetRole: btn\.getAttribute\('data-target-role'\)/.test(clientCode));

  console.log('\n   mounted on a real business surface');
  const orders = fs.readFileSync(path.join(ROOT, 'my-orders.html'), 'utf8');
  const ordersCode = orders.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('my-orders.html loads the Call module', /sokoni-connect-call\.js/.test(orders));
  ck('…mounts per order', /mountForAnchor\(/.test(ordersCode));
  ck('…with the order as the anchor', /anchorType: 'order'/.test(ordersCode));
  /* THE PROPERTY THAT MATTERS: the page must not map a lifecycle word itself. */
  ck('…and maps NO order status to a relationship state',
    !/relationshipState/.test(ordersCode),
    'no client-side lifecycle map');
  ck('…nor calls the pure shouldShow, which would need one',
    !/shouldShow\(/.test(ordersCode));
  ck('…and names no participant', !/calleeUid|recipientUid|participantUids/.test(ordersCode));
  ck('an empty actions row collapses rather than showing a placeholder',
    /\.mo-actions:empty\{display:none/.test(orders));
}

console.log('\n── Support tickets now reach SOKONI ──');
{
  const p = path.join(ROOT, 'sokoni-support-contact.js');
  ck('the support contact module exists', fs.existsSync(p));
  const src = fs.readFileSync(p, 'utf8');
  const sb = { SokoniSupportContact: null, localStorage: { setItem() {}, getItem() { return null; } },
    firebase: null };
  new Function('window', src)(sb);
  const S = sb.SokoniSupportContact;
  ck('…and loads', !!S && typeof S.submit === 'function');

  console.log('\n   the defect it replaces');
  /* support.html called SokoniLaunch.submitTicket, which wrote localStorage, invented a
     `TKT…` id, and the page then said "We've received your issue" unconditionally. Nobody
     had received anything. */
  const page = fs.readFileSync(path.join(ROOT, 'support.html'), 'utf8');
  /* Strip BOTH comment syntaxes. The page's own JS comment names
     `SokoniLaunch.submitTicket` to record what was replaced, and an HTML-only strip left it
     in — the assertion then failed on the documentation of the fix. */
  const pageCode = page
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  ck('support.html no longer calls the localStorage submitter',
    !/SokoniLaunch\.submitTicket/.test(pageCode));
  ck('…and no longer invents a client-side ticket id',
    !/'TKT' \+ Date\.now\(\)/.test(pageCode));
  ck('…it submits through the canonical module', /SokoniSupportContact\.submit/.test(pageCode));
  ck('…and shows success ONLY inside the resolve handler',
    /\.then\(function \(res\) \{[\s\S]{0,400}spTicketSuccess/.test(pageCode));
  ck('…rendering the id the SERVER returned', /res\.ticketId/.test(pageCode));
  ck('…and a failure re-enables the form and says it was NOT sent',
    /describeFailure/.test(pageCode) && /btn\.disabled = false/.test(pageCode));

  console.log('\n   the payload carries no recipient');
  const payload = S.payloadFor({
    category: 'order', subject: 's', message: 'm', priority: 'high',
    /* smuggling attempts */
    recipientUid: 'someone', calleeUid: 'x', phone: '+254712345678', email: 'a@b.c',
  });
  ck('exactly the five permitted keys',
    Object.keys(payload).sort().join(',') === 'category,message,op,priority,subject',
    Object.keys(payload).join(','));
  ['recipientUid', 'calleeUid', 'phone', 'email'].forEach((k) => {
    ck('…no ' + k, !Object.prototype.hasOwnProperty.call(payload, k));
  });
  ck('…and it routes to the canonical op', payload.op === 'adminCreateSupportTicket');

  console.log('\n   validation refuses rather than guessing');
  ck('no subject is refused', S.validate({ message: 'm' }).reason === 'subject_required');
  ck('no message is refused', S.validate({ subject: 's' }).reason === 'message_required');
  ck('an unknown category is refused',
    S.validate({ subject: 's', message: 'm', category: 'nope' }).reason === 'unknown_category');
  ck('an unknown priority is refused',
    S.validate({ subject: 's', message: 'm', priority: 'urgent' }).reason === 'unknown_priority');
  ck('an over-long message is refused rather than silently truncated',
    S.validate({ subject: 's', message: 'x'.repeat(2001) }).reason === 'message_too_long');
  ck('…positive control: a complete form validates',
    S.validate({ subject: 's', message: 'm', category: 'order', priority: 'high' }).ok);
  ck('no argument does not throw', S.validate().ok === false);

  console.log('\n   the ticket id IS the support anchor');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  ck('the resolved value carries the anchor',
    /anchorType: 'support', anchorId: data\.ticketId/.test(code));
  ck('…which is an approved anchor type', ENV.ANCHOR_TYPES.includes('support'));
  ck('…so the case joins the timeline with no second store',
    !/collection\(/.test(code));
  ck('a missing server id is a FAILURE, never a success',
    /if \(!data\.ticketId\) throw/.test(code));

  console.log('\n   localStorage is a cache of a real id, never the record');
  ck('the cached entry is flagged as server-issued', /server: true/.test(code));
  ck('…and a blocked localStorage cannot fail a submitted ticket',
    /catch \(e\) \{ \/\* a blocked localStorage/.test(src));
  ck('the last-ticket panel ignores legacy client-minted ids',
    /last\.server === true/.test(pageCode));
  ck('…and no longer asserts a constant status',
    !/Status: <span style="color:#f59e0b;font-weight:800;">Under Review/.test(pageCode));

  console.log('\n   tracking reads the real ticket');
  ck('it queries supportTickets', /collection\('supportTickets'\)\.doc\(id\)/.test(pageCode));
  ck('…absent is stated as absent, not as "under review"',
    /No ticket with that ID on this account/.test(pageCode));
  ck('…and a failed read is not rendered as not-found',
    /It has not been lost/.test(pageCode));

  console.log('\n   all three surfaces offer the in-platform path — and there is no fourth page');
  ['contact.html', 'help.html'].forEach((f) => {
    const h = fs.readFileSync(path.join(ROOT, f), 'utf8');
    ck('…' + f + ' links to the support case flow', /support\.html#ticket/.test(h));
  });
  ck('no new support page was created',
    !fs.existsSync(path.join(ROOT, 'contact-support.html')) &&
    !fs.existsSync(path.join(ROOT, 'message-support.html')));
}

console.log('\n── The frozen Connect contracts are untouched ──');
{
  const CA = require(path.join(ROOT, 'functions', 'shared', 'connect-authority'));
  const missing = CA.API_CONTRACT.filter((k) => CA[k] === undefined);
  ck('C1 API_CONTRACT still resolves', missing.length === 0, missing.join(',') || 'none');
  ck('…and gained no export',
    Object.keys(CA).filter((k) => k !== 'API_CONTRACT' && !CA.API_CONTRACT.includes(k)).length === 0);
  ck('…no new session state', Object.keys(CA.SESSION_STATES).length === 10);
  ck('…no new actor', CA.ACTOR_NAMES.length === 3);
  const clientSrc = fs.readFileSync(path.join(ROOT, 'sokoni-connect-client.js'), 'utf8');
  const sandbox = { SokoniConnectClient: null, document: null, confirm: () => false,
    setInterval: () => 0, clearInterval: () => {} };
  new Function('window', clientSrc)(sandbox);
  ck('C2 CONTRACT unchanged at 7 names', sandbox.SokoniConnectClient.CONTRACT.length === 7);
}


console.log('\n── Phase 5: provider liveness is a SECOND axis, never merged with provisioning ──');
{
  const T0 = 1758500000000;

  /* Provisioning and liveness are separate FIELDS because they are separate
     facts. Every combination below is legitimate and must be representable. */
  const rows = PROV.healthRowsFor({
    configured: { sendgrid: true, africas_talking: true, fcm: true },
    observations: {
      sendgrid: PROV.recordObservation(null, { outcome: 'success', at: T0 }),
      africas_talking: PROV.recordObservation(null, { outcome: 'failure', at: T0, failureClass: 'quota' }),
    },
    now: T0 + 1000,
  });
  const by = {};
  rows.forEach((r) => { by[r.provider] = r; });

  ck('configured + last attempt OK  -> configured / reachable',
    by.sendgrid.provisioning === 'configured' && by.sendgrid.liveness === 'reachable');
  ck('configured + last attempt bad -> configured / unreachable',
    by.africas_talking.provisioning === 'configured' && by.africas_talking.liveness === 'unreachable');

  /* THE ONE THAT MATTERS. A configured provider nobody has tried is not green
     and not red. Rendering it green is the dashboard lying. */
  ck('configured + NEVER ATTEMPTED -> configured / UNOBSERVED (not reachable)',
    by.fcm.provisioning === 'configured' && by.fcm.liveness === 'unobserved',
    by.fcm.provisioning + ' / ' + by.fcm.liveness);
  ck('…and it says why', by.fcm.livenessReason === 'never_attempted');
  ck('unconfigured is also unobserved, not unreachable',
    by.turn.provisioning === 'not_configured' && by.turn.liveness === 'unobserved');

  /* A success from last week is not evidence about now. */
  const old = PROV.healthRowsFor({
    configured: { sendgrid: true },
    observations: { sendgrid: PROV.recordObservation(null, { outcome: 'success', at: T0 }) },
    now: T0 + PROV.DEFAULT_STALE_AFTER_MS + 1,
  }).find((r) => r.provider === 'sendgrid');
  ck('an old success goes STALE, it does not stay reachable', old.liveness === 'stale', old.liveness);

  /* Without a clock we cannot know whether an observation is current, and the
     safe answer is to admit it rather than assume freshness. */
  const noClock = PROV.healthRowsFor({
    configured: { sendgrid: true },
    observations: { sendgrid: PROV.recordObservation(null, { outcome: 'success', at: T0 }) },
  }).find((r) => r.provider === 'sendgrid');
  ck('no clock supplied -> unobserved, never assumed fresh',
    noClock.liveness === 'unobserved' && noClock.livenessReason === 'no_clock_supplied');

  /* CONTROL for every "is not reachable" assertion above: the projection CAN
     produce reachable. Otherwise they all pass vacuously. */
  ck('CONTROL: the projection can produce reachable at all',
    rows.filter((r) => r.liveness === 'reachable').length === 1);
  ck('CONTROL: …and unreachable', rows.filter((r) => r.liveness === 'unreachable').length === 1);
  ck('every liveness value is in the declared vocabulary',
    rows.every((r) => PROV.LIVENESS_STATES.indexOf(r.liveness) !== -1));

  /* The reducer keeps outcomes and times; a run of failures is countable. */
  let obs = null;
  obs = PROV.recordObservation(obs, { outcome: 'success', at: T0 });
  obs = PROV.recordObservation(obs, { outcome: 'failure', at: T0 + 10, failureClass: 'transport' });
  obs = PROV.recordObservation(obs, { outcome: 'failure', at: T0 + 20, failureClass: 'transport' });
  ck('consecutive failures are counted', obs.consecutiveFailures === 2);
  ck('the last SUCCESS is still remembered through a failure run', obs.lastSuccessAt === T0);
  ck('the last FAILURE is remembered', obs.lastFailureAt === T0 + 20);
  obs = PROV.recordObservation(obs, { outcome: 'success', at: T0 + 30 });
  ck('a success resets the failure run', obs.consecutiveFailures === 0);
  ck('…and the last failure time is still kept', obs.lastFailureAt === T0 + 20);
  ck('an unknown failure class falls back to transport, not to the raw string',
    PROV.recordObservation(null, { outcome: 'failure', at: T0, failureClass: 'DROP TABLE' })
      .lastFailureClass === 'transport');
  let threw = false;
  try { PROV.recordObservation(null, { outcome: 'maybe', at: T0 }); } catch (e) { threw = true; }
  ck('an outcome outside the vocabulary is refused', threw);
  threw = false;
  try { PROV.recordObservation(null, { outcome: 'success' }); } catch (e) { threw = true; }
  ck('an observation without a timestamp is refused', threw);
}

console.log('\n── Phase 5: no credential can reach an operator screen ──');
{
  const T0 = 1758500000000;
  /* An observation carrying every credential shape an adapter might leak. The
     row is built by WHITELIST, so none of it can survive. */
  const poisoned = Object.assign(
    PROV.recordObservation(null, { outcome: 'failure', at: T0, failureClass: 'auth' }),
    {
      apiKey: 'SG.xxxxxxxxxxxxxxxxxxxxxx',
      authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.super.secret',
      secret: 'AT_live_9f3c2b',
      keyPrefix: 'SG.',
      keyLength: 69,
      responseBody: 'password=hunter2',
    });
  const row = PROV.healthRowsFor({
    configured: { sendgrid: true },
    observations: { sendgrid: poisoned },
    now: T0 + 1,
  }).find((r) => r.provider === 'sendgrid');

  const blob = JSON.stringify(row);
  const NEEDLES = ['SG.', 'Bearer', 'eyJ', 'AT_live', 'hunter2', 'password', 'secret',
    'apiKey', 'authorization', 'keyPrefix', 'keyLength', 'responseBody'];
  NEEDLES.forEach((n) => {
    ck('no credential reaches the row: ' + n, blob.indexOf(n) === -1, blob.slice(0, 120));
  });
  /* A LENGTH or a PREFIX is still a disclosure, so the two fields that only
     hint at a secret are asserted separately and by name above. */

  /* INVERTING CONTROL. The same detector is run over a row that DOES carry the
     secret. If it cannot see one, every assertion above proves nothing. */
  const leaky = Object.assign({}, row, { apiKey: 'SG.xxxxxxxxxxxxxxxxxxxxxx' });
  const leakyBlob = JSON.stringify(leaky);
  ck('CONTROL: the leak detector CATCHES a planted credential',
    leakyBlob.indexOf('SG.') !== -1 && NEEDLES.some((n) => leakyBlob.indexOf(n) !== -1));

  ck('the row still reports the failure CLASS (a closed vocabulary, not free text)',
    row.lastFailureClass === 'auth');
  ck('the row carries timestamps, which are not secrets', row.lastFailureAt === T0);
  ck('every field on the row is on the whitelist',
    Object.keys(row).every((k) => PROV.SAFE_ROW_FIELDS.indexOf(k) !== -1 || k === 'state'),
    Object.keys(row).join(','));
}

console.log('\n── Phase 5: liveness is OBSERVATIONAL, never authority ──');
{
  const T0 = 1758500000000;
  /* The brief is explicit that provider health is observational. So an
     observation must not silently change what the router will do — otherwise a
     transient blip becomes a routing decision nobody authorized. */
  const configured = { sendgrid: true, smtp: true };
  const clean = PROV.chainFor({ channel: 'email', configured: configured });
  const down = PROV.recordObservation(null, { outcome: 'failure', at: T0, failureClass: 'transport' });
  const withObs = PROV.chainFor({
    channel: 'email', configured: configured, observations: { sendgrid: down }, now: T0 + 1,
  });
  ck('the chain is IDENTICAL with and without observations',
    JSON.stringify(clean.chain) === JSON.stringify(withObs.chain),
    JSON.stringify(clean.chain) + ' vs ' + JSON.stringify(withObs.chain));
  ck('CONTROL: the chain is non-empty, so the comparison is not two empty lists',
    clean.chain.length === 2);

  /* Provisioning IS authority, and an unprovisioned channel is honestly
     unavailable rather than quietly successful. */
  const none = PROV.chainFor({ channel: 'sms', configured: {} });
  ck('an unconfigured channel returns an empty chain', none.chain.length === 0);
  ck('…and says why, so a caller cannot read it as sent',
    none.reason === 'no_provider_configured');
}


console.log('\n── Phase 5: an outcome is attributed only when attribution is unambiguous ──');
{
  const SEND = require(path.join(ROOT, 'functions', 'communication-send.js'));
  const A = SEND._internals._attributableProviders;

  ck('one configured provider on the channel -> attributed',
    JSON.stringify(A(['sms'], { africas_talking: true })) === JSON.stringify(['africas_talking']));

  /* THE POINT. Two configured providers means notify.js could have used either,
     and a guess would put a green light next to a provider never attempted. */
  ck('TWO configured providers -> attributed to NEITHER',
    JSON.stringify(A(['email'], { sendgrid: true, smtp: true })) === '[]');
  ck('…but one of the two alone IS attributable',
    JSON.stringify(A(['email'], { sendgrid: true })) === JSON.stringify(['sendgrid']));
  ck('no configured provider -> nothing to attribute',
    JSON.stringify(A(['email'], {})) === '[]');
  ck('two channels are attributed independently',
    JSON.stringify(A(['push', 'sms'], { fcm: true, africas_talking: true }))
      === JSON.stringify(['fcm', 'africas_talking']));
  ck('a provider serving two planned channels is observed ONCE',
    A(['sms', 'sms'], { africas_talking: true }).length === 1);
  ck('an in_app channel has no provider chain and attributes nothing',
    JSON.stringify(A(['in_app'], { fcm: true })) === '[]');

  /* The record must be written on BOTH outcomes. A failure that is not recorded
     leaves the board showing the last success, which is worse than nothing. */
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'communication-send.js'), 'utf8')
    .split('/*').map(function (part, idx) {
      return idx === 0 ? part : part.slice(part.indexOf('*/') + 2);
    }).join('');
  ck('CONTROL: the stripped source is readable', src.indexOf('communicationHealth') !== -1);
  ck('a SUCCESS is recorded', src.indexOf("_recordObservation(_db(), prov, 'success')") !== -1);
  ck('a FAILURE is recorded too', src.indexOf("_recordObservation(_db(), prov, 'failure'") !== -1);
  ck('the failure is recorded BEFORE the throw',
    src.indexOf("'failure'") < src.indexOf('Nothing was sent'));
  ck('health reads recorded observations rather than assuming',
    src.indexOf('_loadObservations(_db())') !== -1);
  ck('an unreadable observation store yields NO observations, not healthy ones',
    src.indexOf('if (!snap) return out;') !== -1);
  ck('telemetry failure cannot fail a delivered send',
    src.indexOf('observation not recorded') !== -1);
  ck('the response still refuses to be read as uptime',
    src.indexOf('doesNotMeasure') !== -1);
}
console.log('\n  ' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
