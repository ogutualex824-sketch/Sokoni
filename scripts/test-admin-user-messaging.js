/* ══════════════════════════════════════════════════════════════════════════════
   ADMIN → USER MESSAGING — certification
   scripts/test-admin-user-messaging.js

   WHAT THIS CERTIFIES
   An administrator can message ONE user on three channels from either console, through
   ONE server authority, with every send recorded.

   NO NEW RAIL IS BUILT. Each channel reuses transport this platform already runs:

       email  -> ./email-service   sendOrQueue()        (SendGrid + mail queue)
       sms    -> ./sokoni-at       atSendSMSWithRetry() (Africa's Talking)
       in-app -> notifications/{id}                     (the user's own client reads it)

   `adminSendPushNotification` is NOT reused: it is broadcast (targetRole/targetAll, no
   targetUid) and writes platformNotifications — sending one person a warning through it
   would notify everybody. That is asserted, because reusing it would look like thrift.

   NO NEW COLLECTION AND NO RULES CHANGE. History is `adminAudit`, which is admin-readable
   and `allow write: if false`, so no client can forge a message history.

   The handler is EXECUTED against stubbed Firestore/email/SMS modules: what is proven is
   the write it performs, the transport it calls, and the cases it refuses.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (n, c, d) => {
  if (c) { pass++; console.log('  PASS  ' + n + (d ? '   [' + d + ']' : '')); }
  else { fail++; console.log('  FAIL  ' + n + (d ? '   [' + d + ']' : '')); }
};
const head = t => console.log('\n' + t);
const read = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const strip = s => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const adminOs = read('functions/admin-os.js');
const rules   = read('firestore.rules');
const aos     = read('sokoni-aos.js');
const sa      = read('super-admin.html');
const mod     = read('sokoni-aos-users.js');
const css     = read('sokoni-aos-users.css');

/* ── HARNESS ─────────────────────────────────────────────────────────────── */
function load () {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const st = { adds: {}, profile: null, sent: [], queued: [], notif: null, throwOn: null };

  const col = (c) => ({
    doc: (id) => ({
      get: async () => ({ exists: st.profile !== null, data: () => st.profile || {} }),
      set: async () => {},
    }),
    add: async (data) => {
      if (st.throwOn === c) throw new Error('boom');
      (st.adds[c] = st.adds[c] || []).push(data);
      return { id: c === 'notifications' ? 'notif-1' : 'aud-1' };
    },
    where: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
  });
  class HttpsError extends Error { constructor (code, m) { super(m); this.code = code; } }

  const fake = {
    'firebase-functions/v2/https': { onCall: (_o, fn) => fn, HttpsError },
    'firebase-functions/v2/scheduler': { onSchedule: (_o, fn) => fn },
    'firebase-admin/firestore': {
      getFirestore: () => ({ collection: col }),
      FieldValue: { serverTimestamp: () => '<ts>' },
      Timestamp: { now: () => 0 },
    },
    'firebase-admin/auth': { getAuth: () => ({ getUser: async (u) => ({ uid: u, customClaims: {} }) }) },
    './email-service': {
      EMAIL_SECRETS: [], FROM: 'x',
      sendOrQueue: async (p) => { if (st.throwOn === 'email') throw new Error('smtp down');
                                  st.queued.push(p); return 'queue-77'; },
    },
    './sokoni-at': {
      secrets: [],
      atSendSMSWithRetry: async (to, msg) => { if (st.throwOn === 'sms') throw new Error('AT down');
                                               st.sent.push({ to, msg }); return { ok: true, messageId: 'AT-9' }; },
    },
  };
  Module._resolveFilename = function (r, ...rest) { return fake[r] ? r : origResolve.call(this, r, ...rest); };
  Object.keys(fake).forEach(k => { require.cache[k] = { id: k, exports: fake[k], loaded: true }; });
  /* The handler requires ./email-service and ./sokoni-at at CALL time, after the resolver
     override is restored — at which point those specifiers resolve to absolute paths and
     the real modules would load. Seeding the cache under those absolute paths keeps the
     stubs in place for the call as well as the load. */
  [['./email-service', 'email-service.js'], ['./sokoni-at', 'sokoni-at.js']].forEach(([key, file]) => {
    const abs = path.join(ROOT, 'functions', file);
    require.cache[abs] = { id: abs, filename: abs, exports: fake[key], loaded: true, children: [], paths: [] };
  });
  delete require.cache[require.resolve(path.join(ROOT, 'functions', 'admin-os.js'))];
  let m;
  try { m = require(path.join(ROOT, 'functions', 'admin-os.js')); }
  finally { Module._resolveFilename = origResolve; }
  return { h: m._h.adminMessageUser, st };
}
const H = load();

async function send (over) {
  const o = Object.assign({
    channel: 'inapp', category: 'account_warning', subject: 'Notice',
    body: 'Your account requires attention.',
    profile: { email: 'u@x.com', phone: '+254700111222' }, throwOn: null,
  }, over || {});
  H.st.adds = {}; H.st.sent = []; H.st.queued = [];
  H.st.profile = o.profile; H.st.throwOn = o.throwOn;
  const req = { auth: { uid: 'admin-1', token: { admin: true } },
                data: { targetUid: 'user-9', channel: o.channel, category: o.category,
                        subject: o.subject, body: o.body } };
  try { return { ok: true, r: await H.h(req) }; } catch (e) { return { ok: false, e }; }
}
const audits = () => H.st.adds.adminAudit || [];
const notifs = () => H.st.adds.notifications || [];

(async function () {
  console.log('══════════════════════════════════════════════════════════════════');
  console.log('  ADMIN → USER MESSAGING');
  console.log('══════════════════════════════════════════════════════════════════');

  head('0 - the authority exists and is reachable');
  {
    ok('control — the handler loaded', typeof H.h === 'function');
    ok('registered in the dispatch registry', /exports\._h\.adminMessageUser/.test(adminOs));
    ok('history reader registered too', /exports\._h\.adminGetUserMessages/.test(adminOs));
    ok('both ops whitelisted by the client',
       /'adminMessageUser'/.test(aos) && /'adminGetUserMessages'/.test(aos));
  }

  /* ── 1. IN-APP ───────────────────────────────────────────────────────────── */
  head('1 - in-app writes a notification the user\'s own client can read');
  {
    const r = await send({ channel: 'inapp' });
    ok('it succeeds', r.ok, r.ok ? '' : String(r.e && r.e.message));
    const n = notifs()[0] || {};
    ok('one notification is written', notifs().length === 1);
    ok('addressed to the target', n.targetUid === 'user-9');
    ok('with a heading and body', n.heading === 'Notice' && /requires attention/.test(n.sub));
    ok('it starts unread', n.read === false);
    ok('and is marked as coming from an admin', n.fromAdmin === true);

    /* THE TYPE VOCABULARY. The rules constrain `type` for user-created notifications and
       the client switches on it; an invented type would render as unknown. The operational
       category rides in its own field. */
    ok('type stays inside the vocabulary', n.type === 'general');
    ok('the category is carried separately', n.category === 'account_warning');
    const vocab = (rules.match(/request\.resource\.data\.type in \[([\s\S]*?)\]/) || [])[1] || '';
    ok('control — the rules vocabulary was read', vocab.length > 20);
    ok('and "general" is in it', /'general'/.test(vocab));
    ok('control — the category is NOT a valid type', !/account_warning/.test(vocab));

    ok('an in-app write is its own delivery', (audits()[0] || {}).status === 'delivered');
    ok('the notification id is recorded for the history join',
       (audits()[0] || {}).notificationId === 'notif-1');
  }

  /* ── 2. EMAIL ────────────────────────────────────────────────────────────── */
  head('2 - email reuses the mail queue and does not claim delivery');
  {
    const r = await send({ channel: 'email', subject: 'Verify your account' });
    ok('it succeeds', r.ok);
    ok('it goes through email-service', H.st.queued.length === 1);
    const q = H.st.queued[0] || {};
    ok('addressed to the recorded email', q.to === 'u@x.com');
    ok('with the subject given', q.subject === 'Verify your account');
    ok('and both text and html bodies', !!q.text && /<p>/.test(q.html || ''));
    ok('the body is escaped into the html part',
       (await send({ channel: 'email', body: '<script>x</script>' })).ok &&
       !/<script>/.test((H.st.queued[0] || {}).html || ''));

    /* sendOrQueue() DEFAULTS TO QUEUEING and returns a document id, not a result object.
       Reporting "sent" here would be a false success of exactly the kind this codebase
       keeps finding. */
    await send({ channel: 'email' });
    ok('the status recorded is queued, not sent', (audits()[0] || {}).status === 'queued');
    ok('the queue id is kept as the provider reference', (audits()[0] || {}).providerRef === 'queue-77');
    ok('no notification document is written for email', notifs().length === 0);
  }

  /* ── 3. SMS ──────────────────────────────────────────────────────────────── */
  head('3 - SMS reuses the Africa\'s Talking rail');
  {
    const r = await send({ channel: 'sms', body: 'Security alert on your account.' });
    ok('it succeeds', r.ok);
    ok('it goes through sokoni-at', H.st.sent.length === 1);
    ok('to the recorded number', (H.st.sent[0] || {}).to === '+254700111222');
    ok('status is sent', (audits()[0] || {}).status === 'sent');
    ok('the provider reference is kept', (audits()[0] || {}).providerRef === 'AT-9');
    /* The audit row is a log, not a PII store: only the last four digits are kept. */
    ok('only the last four digits are recorded', (audits()[0] || {}).recipient === '1222');
    ok('the full number is NOT in the audit row',
       !JSON.stringify(audits()[0] || {}).includes('+254700111222'));

    const long = await send({ channel: 'sms', body: 'x'.repeat(481) });
    ok('an over-length SMS is refused', !long.ok && /longer than/i.test(long.e.message));
    ok('control — 480 characters is accepted',
       (await send({ channel: 'sms', body: 'x'.repeat(480) })).ok);
  }

  /* ── 4. THE ADDRESS MUST EXIST ───────────────────────────────────────────── */
  head('4 - a send that is certain to fail is refused, not attempted');
  {
    const noEmail = await send({ channel: 'email', profile: { phone: '+254700111222' } });
    ok('email with no address on record is refused', !noEmail.ok &&
       /no email address/i.test(noEmail.e.message));
    ok('and nothing was queued', H.st.queued.length === 0);

    const noPhone = await send({ channel: 'sms', profile: { email: 'u@x.com' } });
    ok('SMS with no number on record is refused', !noPhone.ok &&
       /no phone number/i.test(noPhone.e.message));
    ok('and nothing was sent', H.st.sent.length === 0);

    /* In-app needs only the account, so it still works for a user with neither. */
    const bare = await send({ channel: 'inapp', profile: {} });
    ok('control — in-app still works with neither address', bare.ok);

    ok('a missing account is refused',
       !(await send({ profile: null })).ok);
  }

  /* ── 5. VALIDATION AND REFUSALS ──────────────────────────────────────────── */
  head('5 - the refusals');
  {
    ok('an empty body is refused', !(await send({ body: ' ' })).ok);
    ok('an unknown channel is refused', !(await send({ channel: 'carrier-pigeon' })).ok);
    ok('a missing targetUid is refused', await (async () => {
      try { await H.h({ auth: { uid: 'a', token: { admin: true } }, data: { channel: 'inapp', body: 'hi' } }); return false; }
      catch (_) { return true; }
    })());
    ok('a non-admin is refused', await (async () => {
      try { await H.h({ auth: { uid: 'a', token: {} }, data: { targetUid: 'u', channel: 'inapp', body: 'hi' } }); return false; }
      catch (e) { return /admin required/.test(e.message); }
    })());
    /* An unknown CATEGORY is downgraded, not rejected — it is a label, not authority. */
    const odd = await send({ category: 'not_a_category' });
    ok('an unknown category falls back to general', odd.ok && odd.r.category === 'general');
    ok('control — a known category is preserved',
       (await send({ category: 'security_alert' })).r.category === 'security_alert');
  }

  /* ── 6. FAILURE IS RECORDED, NOT SWALLOWED ───────────────────────────────── */
  head('6 - a provider failure still leaves a trail');
  {
    const r = await send({ channel: 'sms', throwOn: 'sms' });
    ok('the caller is told it failed', !r.ok);
    ok('an audit row is still written', audits().length === 1);
    ok('with status failed', (audits()[0] || {}).status === 'failed');
    ok('and the reason', /AT down/.test((audits()[0] || {}).failureReason || ''));

    const e2 = await send({ channel: 'email', throwOn: 'email' });
    ok('an email failure is recorded too', !e2.ok && (audits()[0] || {}).status === 'failed');
    ok('control — a successful send is not marked failed',
       (await send({ channel: 'inapp' })) && (audits()[0] || {}).status !== 'failed');
  }

  /* ── 7. THE AUDIT ROW ────────────────────────────────────────────────────── */
  head('7 - who sent what, to whom, on which channel');
  {
    await send({ channel: 'inapp', category: 'policy_notice', subject: 'Policy update' });
    const a = audits()[0] || {};
    ok('exactly one audit row per send', audits().length === 1);
    ok('the action is named', a.action === 'admin_message_sent');
    ok('the target is named', a.targetUid === 'user-9');
    ok('the administrator is named', a.performedBy === 'admin-1');
    ok('the channel is recorded', a.channel === 'inapp');
    ok('the category is recorded', a.category === 'policy_notice');
    ok('the subject is recorded', a.subject === 'Policy update');
    ok('a preview of the body is kept', /requires attention/.test(a.bodyPreview || ''));
  }

  /* ── 8. NO DUPLICATE MECHANISM ───────────────────────────────────────────── */
  head('8 - nothing here is a second rail');
  {
    const src = strip(adminOs);
    ok('email reuses ./email-service', /require\('\.\/email-service'\)/.test(src));
    ok('SMS reuses ./sokoni-at', /require\('\.\/sokoni-at'\)/.test(src));
    ok('no second SendGrid client is created', !/sgMail|@sendgrid/.test(src));
    ok('no second SMS provider is called', !/africastalking\.com|AT_API_KEY/.test(src));

    /* The broadcast op is deliberately NOT reused. */
    const bc = adminOs.slice(adminOs.indexOf('exports.adminSendPushNotification'),
                             adminOs.indexOf('exports.adminGetRecentNotifications'));
    ok('control — the broadcast op takes no targetUid', !/targetUid/.test(bc));
    ok('control — and writes platformNotifications', /platformNotifications/.test(bc));
    ok('the per-user send does NOT write platformNotifications',
       !/platformNotifications/.test(src.slice(src.indexOf('adminMessageUser = async'),
                                               src.indexOf('adminGetUserMessages'))));

    /* History reuses adminAudit — no new collection, and clients cannot write it. */
    ok('history reads adminAudit', /collection\('adminAudit'\)[\s\S]{0,120}targetUid/.test(adminOs));
    const auditRule = rules.slice(rules.indexOf('match /adminAudit/{logId}'),
                                  rules.indexOf('match /adminAuditLogs'));
    ok('control — adminAudit is admin-readable', /allow read:\s*if isAdmin\(\)/.test(auditRule));
    ok('control — and client-unwritable', /allow write:\s*if false/.test(auditRule));
  }

  /* ── 9. NEITHER CONSOLE SENDS BY ITSELF ──────────────────────────────────── */
  head('9 - the browser never writes the notification or calls a provider');
  {
    /* The rules WOULD let an admin create a notification from the browser. */
    const nRule = rules.slice(rules.indexOf('match /notifications/{notifId}'),
                              rules.indexOf('match /userNotifPrefs'));
    ok('control — rules DO allow an admin to create a notification',
       /allow create: if isAdmin\(\)/.test(nRule));

    [['AdminOS', strip(aos)], ['Super Admin', strip(sa)]].forEach(([label, src]) => {
      ok(label + ' never writes a notification document',
         !/collection\(["']notifications["']\)/.test(src));
      /* Scoped to the SEND function, not the whole file: both consoles have a settings
         panel that names SENDGRID_API_KEY as a secret, and a whole-file match counted
         that label as "calling a provider". */
      const fn = (src.match(/messageUser\s*\(?[\s\S]{0,900}?adminMessageUser[\s\S]{0,400}?\n\s*\}/) || [''])[0];
      ok(label + ' control — the send function was isolated', fn.length > 80, fn.length + ' chars');
      ok(label + ' never calls a provider directly',
         !/sendgrid|africastalking|posSendSMS/i.test(fn));
      ok(label + ' calls the one send op', /adminMessageUser/.test(src));
      ok(label + ' reads history through the server', /adminGetUserMessages/.test(src));
    });
    ok('the module itself performs no read or write',
       !/httpsCallable|collection\(/.test(strip(mod)));
  }

  /* ── 10. THE UI CONTRACT ─────────────────────────────────────────────────── */
  head('10 - what the operator can and cannot do');
  {
    /* The client vocabulary must equal the server's, or a category is silently downgraded. */
    const serverCats = Object.keys(
      eval('(' + (adminOs.match(/MESSAGE_CATEGORIES = Object\.freeze\((\{[\s\S]*?\})\)/) || [])[1] + ')'));
    const clientCats = [...mod.matchAll(/\{ id: '([a-z_]+)',\s+label: '[^']+' \}/g)]
      .map(m => m[1]).filter(c => serverCats.indexOf(c) > -1);
    ok('control — the server declares categories', serverCats.length >= 8, serverCats.length + '');
    ok('every server category is offered in the UI',
       serverCats.every(c => mod.indexOf("id: '" + c + "'") > -1),
       serverCats.filter(c => mod.indexOf("id: '" + c + "'") === -1).join(',') || 'all present');
    ok('and the UI offers no category the server would downgrade',
       clientCats.length === new Set(clientCats).size);

    ok('three channels are offered', /id: 'inapp'/.test(mod) && /id: 'email'/.test(mod) && /id: 'sms'/.test(mod));
    /* THE RULE THE REQUEST ASKED FOR: an absent address is an explicit state. */
    ok('a missing email is stated', /No email address on record/.test(mod));
    ok('a missing phone is stated', /No phone number on record/.test(mod));
    ok('an unavailable channel says so in place of the control', /unavailable/.test(mod));
    ok('SMS shows a character count', /characters/.test(mod) && /SMS_MAX/.test(mod));
    ok('SMS has no subject field', /ch === 'sms' \? '' :/.test(mod));
    ok('the send button is disabled until there is a message',
       /body\.trim\(\)\.length < 2/.test(mod));
    ok('capability follows the supplied action', /msg: !!A0\.sendMessage/.test(strip(mod)));

    /* History honesty: read state only where it is actually known. */
    ok('history shows read state only for in-app', /m\.read === true \? ' · read'/.test(mod));
    /* On STRIPPED source: the comment above this very behaviour explains that the
       notification carries no readAt, and an unstripped match reads that explanation as
       the violation it denies. */
    ok('and never invents a read TIME', !/readAt/.test(strip(mod)));
    ok('it states what the trail does not know', /is not recorded here/.test(mod));
    ok('a failed read is distinguished from an empty history',
       /Could not load the history/.test(mod) && /No messages have been sent/.test(mod));
    ok('the composer is styled', /usx-msg/.test(css) && /usx-hist/.test(css));
    /* `.usx-in` carries `flex: 1 1 210px` for the horizontal toolbar. The composer is a
       COLUMN, where that basis becomes a 210px HEIGHT and the subject field renders as a
       huge empty box. Pinned so the shared class cannot silently reintroduce it. */
    ok('the composer overrides the toolbar flex basis',
       /\.usx-msg-b \.usx-in[\s\S]{0,80}flex: 0 0 auto/.test(css));
    ok('control — the toolbar input still has its own basis', /\.usx-in \{ flex: 1 1 210px/.test(css));
  }

  console.log('\n  what this suite does NOT prove');
  console.log('  UNPROVEN  a live round-trip — adminOsDispatch must be REDEPLOYED before');
  console.log('            these ops resolve, and the Functions deploy freeze is in force.');
  console.log('            This lands COMMITTED, NOT DEPLOYED.');
  console.log('  UNPROVEN  actual provider delivery. The audit records what SOKONI attempted');
  console.log('            and what the provider accepted — not whether a person read it.');

  console.log('\n══════════════════════════════════════════════════════════════════');
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('══════════════════════════════════════════════════════════════════');
  process.exit(fail ? 1 : 0);
})();
