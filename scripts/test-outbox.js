#!/usr/bin/env node
/* ============================================================================
   SOKONI — offline outbox gate                    scripts/test-outbox.js
   ============================================================================
   Phase 7. The brief said not to implement this casually, so the gate is built
   around the two properties that actually matter and are actually hard:

     1. A message survives an offline compose and a reload.
     2. It is delivered ONCE, across every retry path that exists — including
        the timeout that the server had already accepted.

   Property 2 cannot be proved by asserting "we sent once" against an
   implementation that only sends once by accident. So the duplicate detector is
   INVERTED: the same assertion is run against a deliberately broken outbox that
   regenerates the id on retry, and the suite FAILS if the detector does not
   catch it. An assertion that cannot fail is not evidence.

   Everything is injected — storage, clock, transport — so nothing here touches
   a browser, a network or a wall clock.
   ========================================================================= */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'sokoni-outbox.js');

let pass = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { pass++; return true; }
  failures.push(name + (detail ? '  — ' + detail : ''));
  return false;
}
function eq(name, actual, expected) {
  return ok(name, actual === expected, 'expected ' + JSON.stringify(expected) +
    ', got ' + JSON.stringify(actual));
}

/* --- load the module in a bare global, exactly as a page would ----------- */
const g = {};
new Function('window', fs.readFileSync(SRC, 'utf8') + '\n;return window;')(g);
const OB = g.SokoniOutbox;

if (!OB) {
  console.error('FATAL: sokoni-outbox.js did not publish SokoniOutbox');
  process.exit(1);
}

/* --- test doubles -------------------------------------------------------- */

/** Storage that survives being handed to a NEW outbox — i.e. a reload. */
function memStorage(seed) {
  let blob = JSON.stringify(seed || []);
  return {
    read: () => JSON.parse(blob),
    write: (v) => { blob = JSON.stringify(v); },
    _raw: () => JSON.parse(blob),
  };
}

/** Transport that records every clientMessageId it is ever handed. */
function recordingTransport(behaviour) {
  const seen = [];
  const fn = (payload) => {
    seen.push(payload.clientMessageId);
    return behaviour(payload, seen.length);
  };
  fn.seen = seen;
  return fn;
}

const accept = () => Promise.resolve({ accepted: true, messageId: 'srv_1' });
const timeout = () => Promise.reject(Object.assign(new Error('deadline'), { code: 'deadline-exceeded' }));

let clock = 1000;
const now = () => ++clock;

/* Comments describe the very APIs these files avoid or use, so asserting on
   raw text would assert against my own prose. Strip first, every time. */
function stripComments(src) {
  let out = '', i = 0, mode = 'code', quote = '';
  while (i < src.length) {
    const c = src[i], d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '*') { mode = 'block'; i += 2; continue; }
      if (c === '/' && d === '/') { mode = 'line'; i += 2; continue; }
      if (c === '"' || c === "'" || c === '`') { mode = 'str'; quote = c; out += c; i++; continue; }
      out += c; i++; continue;
    }
    if (mode === 'block') { if (c === '*' && d === '/') { mode = 'code'; i += 2; } else i++; continue; }
    if (mode === 'line') { if (c === '\n') { mode = 'code'; out += '\n'; } i++; continue; }
    if (mode === 'str') {
      if (c === '\\') { out += c + (d || ''); i += 2; continue; }
      if (c === quote) mode = 'code';
      out += c; i++; continue;
    }
  }
  return out;
}

/* ========================================================================== */
/* 1. CONTRACT — asserted BOTH ways                                           */
/* ========================================================================== */
{
  const declared = OB.CONTRACT.slice().sort();
  const exported = Object.keys(OB).filter((k) => k !== 'CONTRACT').sort();
  ok('contract: every declared name is exported',
    declared.every((n) => exported.indexOf(n) !== -1),
    'missing: ' + declared.filter((n) => exported.indexOf(n) === -1).join(','));
  ok('contract: every export is declared',
    exported.every((n) => declared.indexOf(n) !== -1),
    'undeclared: ' + exported.filter((n) => declared.indexOf(n) === -1).join(','));
}

/* ========================================================================== */
/* 2. STATE MACHINE — exhaustive over ALL ordered pairs                       */
/* ========================================================================== */
{
  const S = OB.STATES;
  eq('states: six', S.length, 6);

  let permitted = 0, refused = 0;
  S.forEach((from) => S.forEach((to) => {
    const declared = (OB.TRANSITIONS[from] || []).indexOf(to) !== -1;
    const r = OB.canTransition(from, to);
    if (declared) { permitted++; ok('transition permitted ' + from + '->' + to, r.ok === true, r.reason); }
    else { refused++; ok('transition refused ' + from + '->' + to, r.ok === false, 'was allowed'); }
  }));
  ok('state machine: every ordered pair was exercised', permitted + refused === 36,
    String(permitted + refused));
  /* Positive control on the exhaustive sweep: it must have found BOTH kinds. */
  ok('state machine control: some pairs are permitted', permitted > 0, String(permitted));
  ok('state machine control: most pairs are refused', refused > permitted, String(refused));

  eq('unknown from-state is refused', OB.canTransition('teleported', 'sent').reason, 'unknown_from_state');
  eq('unknown to-state is refused', OB.canTransition('queued', 'vanished').reason, 'unknown_to_state');
  eq('self-transition is a no-op, not an error', OB.canTransition('queued', 'queued').reason, 'no_op');

  /* THE duplicate-message guard, asserted by name so nobody re-adds it. */
  ok('sending -> queued is ABSENT (re-queuing an in-flight send duplicates it)',
    (OB.TRANSITIONS.sending || []).indexOf('queued') === -1);
  ok('read is terminal', (OB.TRANSITIONS.read || []).length === 0);
  eq('TERMINAL names read', OB.TERMINAL.join(','), 'read');
  ok('failed can only go to sending',
    OB.TRANSITIONS.failed.length === 1 && OB.TRANSITIONS.failed[0] === 'sending');
}

/* ========================================================================== */
/* 3. ENTRY VALIDATION                                                        */
/* ========================================================================== */
{
  const threw = (fn) => { try { fn(); return false; } catch (e) { return true; } };
  ok('empty body is refused', threw(() => OB.newEntry({ conversationId: 'c1', body: '   ' })));
  ok('missing conversation is refused', threw(() => OB.newEntry({ body: 'hi' })));
  ok('half an anchor is refused',
    threw(() => OB.newEntry({ conversationId: 'c1', body: 'hi', anchorType: 'order' })));
  ok('a whole anchor is accepted',
    !threw(() => OB.newEntry({ conversationId: 'c1', body: 'hi', anchorType: 'order', anchorId: 'o1' })));
  ok('no anchor at all is accepted (the conversation carries the context)',
    !threw(() => OB.newEntry({ conversationId: 'c1', body: 'hi' })));

  const e = OB.newEntry({ conversationId: 'c1', body: 'hi', at: 5, nonce: '0.abcdefgh' });
  eq('a new entry starts queued', e.state, 'queued');
  eq('a new entry has made no attempts', e.attempts, 0);
  ok('a body is bounded', OB.newEntry({ conversationId: 'c1', body: 'x'.repeat(5000) }).body.length === 2000);
}

/* ========================================================================== */
/* 4. THE HAPPY PATH, AND THE LADDER                                          */
/* ========================================================================== */
const async1 = (async () => {
  const st = memStorage();
  const tx = recordingTransport(accept);
  const box = OB.createOutbox({ storage: st, transport: tx, now });

  const e = box.enqueue({ conversationId: 'c1', body: 'is my order ready?', anchorType: 'order', anchorId: 'o1' });
  eq('enqueue: one pending', box.pending().length, 1);

  const r = await box.drain({ online: true });
  eq('drain attempted one', r.attempted, 1);
  eq('after ack the entry is sent', box.list()[0].state, 'sent');
  eq('the server id is kept', box.list()[0].serverMessageId, 'srv_1');
  eq('nothing is pending after a successful drain', box.pending().length, 0);

  box.markDelivered(e.clientMessageId);
  eq('delivered', box.list()[0].state, 'delivered');
  box.markRead(e.clientMessageId);
  eq('read', box.list()[0].state, 'read');

  /* The ladder must not skip: sent -> read directly is refused. */
  const st2 = memStorage();
  const box2 = OB.createOutbox({ storage: st2, transport: recordingTransport(accept), now });
  const e2 = box2.enqueue({ conversationId: 'c1', body: 'hello' });
  await box2.drain({ online: true });
  eq('the ladder cannot skip delivered', box2.markRead(e2.clientMessageId).ok, false);
})();

/* ========================================================================== */
/* 5. NO SUCCESS BEFORE ACKNOWLEDGEMENT                                       */
/* ========================================================================== */
const async2 = (async () => {
  /* A promise that RESOLVES but does not say `accepted` is not an ack. */
  const cases = [
    ['resolves with nothing', () => Promise.resolve()],
    ['resolves with an empty object', () => Promise.resolve({})],
    ['resolves with accepted:"true" (a string)', () => Promise.resolve({ accepted: 'true' })],
    ['resolves with accepted:1', () => Promise.resolve({ accepted: 1 })],
    ['resolves with ok:true but no accepted', () => Promise.resolve({ ok: true })],
  ];
  for (const [label, behaviour] of cases) {
    const box = OB.createOutbox({ storage: memStorage(), transport: recordingTransport(behaviour), now });
    box.enqueue({ conversationId: 'c1', body: 'hi' });
    await box.drain({ online: true });
    eq('not sent when the transport ' + label, box.list()[0].state, 'failed');
    eq('  ...and the reason says so', box.list()[0].lastError, 'no_acknowledgement');
  }
  /* Positive control: the detector CAN see a real acknowledgement. */
  const good = OB.createOutbox({ storage: memStorage(), transport: recordingTransport(accept), now });
  good.enqueue({ conversationId: 'c1', body: 'hi' });
  await good.drain({ online: true });
  eq('control: a real acknowledgement does reach sent', good.list()[0].state, 'sent');
})();

/* ========================================================================== */
/* 6. OFFLINE, RELOAD, AND THE DRAIN GUARDS                                   */
/* ========================================================================== */
const async3 = (async () => {
  const st = memStorage();
  const tx = recordingTransport(accept);
  const box = OB.createOutbox({ storage: st, transport: tx, now });
  box.enqueue({ conversationId: 'c1', body: 'composed on a train' });

  const off = await box.drain({ online: false });
  eq('offline: nothing is attempted', off.attempted, 0);
  eq('offline: the reason is stated', off.reason, 'offline');
  eq('offline: the message is still owed', off.skipped, 1);
  eq('offline: the transport was never called', tx.seen.length, 0);

  /* THE RELOAD. A brand-new outbox over the same storage — the entry survives
     with the SAME id, which is what makes exactly-once possible at all. */
  const idBefore = st._raw()[0].clientMessageId;
  const revived = OB.createOutbox({ storage: st, transport: tx, now });
  eq('reload: the message survived', revived.pending().length, 1);
  eq('reload: the id survived unchanged', revived.pending()[0].clientMessageId, idBefore);

  await revived.drain({ online: true });
  eq('reload: it sends once the connection returns', revived.list()[0].state, 'sent');
  eq('reload: under the original id', tx.seen[0], idBefore);

  /* A reconnect that fires two events must not send twice. Both drains are
     started before either is awaited. */
  const st2 = memStorage();
  const tx2 = recordingTransport(accept);
  const box2 = OB.createOutbox({ storage: st2, transport: tx2, now });
  box2.enqueue({ conversationId: 'c1', body: 'double reconnect' });
  const [a, b] = await Promise.all([box2.drain({ online: true }), box2.drain({ online: true })]);
  eq('two concurrent drains attempt one send in total', a.attempted + b.attempted, 1);
  eq('  ...and the transport saw exactly one call', tx2.seen.length, 1);
  ok('  ...the second drain says why it did nothing',
    a.reason === 'already_draining' || b.reason === 'already_draining',
    a.reason + ' / ' + b.reason);

  /* A failed entry must NOT be picked up by an automatic drain, or it resends
     on every reconnect for ever. */
  const st3 = memStorage();
  const tx3 = recordingTransport(timeout);
  const box3 = OB.createOutbox({ storage: st3, transport: tx3, now });
  box3.enqueue({ conversationId: 'c1', body: 'will fail' });
  await box3.drain({ online: true });
  eq('a timeout lands in failed', box3.list()[0].state, 'failed');
  const after = await box3.drain({ online: true });
  eq('a later drain does NOT resend a failed message', after.attempted, 0);
  eq('  ...the transport was called once, not twice', tx3.seen.length, 1);
})();

/* ========================================================================== */
/* 7. EXACTLY-ONCE — the property, and an INVERTING CONTROL                   */
/* ========================================================================== */
const async4 = (async () => {
  /* The detector: across a timeout and N explicit retries, the transport must
     see ONE distinct clientMessageId. */
  function detectDuplicateIdentity(seen) {
    const distinct = Array.from(new Set(seen));
    return { calls: seen.length, distinct: distinct.length };
  }

  const st = memStorage();
  /* First attempt times out (the server may well have accepted it); the
     retries succeed. */
  const tx = recordingTransport((p, n) => (n === 1 ? timeout() : accept()));
  const box = OB.createOutbox({ storage: st, transport: tx, now });
  const e = box.enqueue({ conversationId: 'c1', body: 'did you get this?' });

  await box.drain({ online: true });
  eq('attempt 1 timed out', box.list()[0].state, 'failed');
  eq('the failure reason is recorded', box.list()[0].lastError, 'deadline-exceeded');

  const r1 = await box.retry(e.clientMessageId);
  eq('an explicit retry succeeds', r1.ok, true);
  eq('the message is sent', box.list()[0].state, 'sent');
  eq('two attempts were counted', box.list()[0].attempts, 2);

  const d = detectDuplicateIdentity(tx.seen);
  eq('the transport was called twice', d.calls, 2);
  eq('...under ONE logical message identity', d.distinct, 1);

  /* ---- INVERTING CONTROL -------------------------------------------------
     The same detector is run against an outbox whose retry mints a NEW id.
     If the assertion above cannot fail, it is not evidence. */
  const brokenSrc = fs.readFileSync(SRC, 'utf8')
    .replace('        clientMessageId: entry.clientMessageId,',
      '        clientMessageId: entry.clientMessageId + (entry.attempts ? "_dup" : ""),');
  ok('control: the sabotage actually changed the source',
    brokenSrc !== fs.readFileSync(SRC, 'utf8'));

  const bg = {};
  new Function('window', brokenSrc + '\n;return window;')(bg);
  const bst = memStorage();
  const btx = recordingTransport((p, n) => (n === 1 ? timeout() : accept()));
  const bbox = bg.SokoniOutbox.createOutbox({ storage: bst, transport: btx, now });
  const be = bbox.enqueue({ conversationId: 'c1', body: 'did you get this?' });
  await bbox.drain({ online: true });
  await bbox.retry(be.clientMessageId);

  const bd = detectDuplicateIdentity(btx.seen);
  eq('control: the broken outbox also called the transport twice', bd.calls, 2);
  ok('CONTROL: the detector CATCHES a regenerated id (2 identities, not 1)',
    bd.distinct === 2, 'the duplicate detector is blind — it would pass anything');

  /* Enqueue is idempotent on the id: a double-tapped send button is one
     message, not two. */
  const st5 = memStorage();
  const box5 = OB.createOutbox({ storage: st5, transport: recordingTransport(accept), now });
  const first = box5.enqueue({ conversationId: 'c1', body: 'tap', clientMessageId: 'cm_fixed' });
  const second = box5.enqueue({ conversationId: 'c1', body: 'tap', clientMessageId: 'cm_fixed' });
  eq('a double tap enqueues one message', box5.list().length, 1);
  eq('  ...and returns the same entry', second.clientMessageId, first.clientMessageId);
})();

/* ========================================================================== */
/* 8. RETRY AND FORGET ARE BOTH GUARDED                                       */
/* ========================================================================== */
const async5 = (async () => {
  const box = OB.createOutbox({ storage: memStorage(), transport: recordingTransport(accept), now });
  const e = box.enqueue({ conversationId: 'c1', body: 'hi' });

  const early = await box.retry(e.clientMessageId);
  eq('a queued message cannot be "retried"', early.reason, 'only_failed_can_retry');
  eq('an unknown id cannot be retried', (await box.retry('nope')).reason, 'not_found');

  eq('forget refuses a message the server has not taken',
    box.forget(e.clientMessageId).reason, 'not_acknowledged_yet');
  eq('  ...and the message is still there', box.list().length, 1);

  await box.drain({ online: true });
  eq('forget releases an acknowledged message', box.forget(e.clientMessageId).ok, true);
  eq('  ...leaving no local copy to become a second message store', box.list().length, 0);
})();

/* ========================================================================== */
/* 9. THE MODULE IS PURE — asserted on source with COMMENTS STRIPPED          */
/* ========================================================================== */
{
  const code = stripComments(fs.readFileSync(SRC, 'utf8'));

  /* Positive control: the stripper must have removed something, and must NOT
     have eaten the code. */
  ok('control: stripping removed the prose', code.length < fs.readFileSync(SRC, 'utf8').length * 0.75);
  ok('control: stripping kept the implementation', code.indexOf('createOutbox') !== -1);
  ok('control: the stripper leaves string contents alone', code.indexOf('already_draining') !== -1);

  [['localStorage', 'storage is injected'], ['indexedDB', 'storage is injected'],
   ['navigator', 'online-ness is injected'], ['fetch(', 'the transport is injected'],
   ['firebase', 'the transport is injected'], ['Date.now', 'the clock is injected'],
   ['setTimeout', 'nothing retries by itself'], ['setInterval', 'nothing retries by itself'],
  ].forEach(([needle, why]) => {
    ok('pure: no ' + needle + ' (' + why + ')', code.indexOf(needle) === -1);
  });

  /* CONTROL for the absence sweep: a needle that MUST be present. If the
     stripped source were empty, every absence above would pass vacuously. */
  ok('CONTROL: the absence sweep can see text that IS present',
    code.indexOf('clientMessageId') !== -1,
    'the sweep is blind — every absence above proves nothing');

  ok('the outbox never speaks of history/messages as a store',
    code.indexOf("collection(") === -1 && code.indexOf('conversations') === -1);
}

/* ========================================================================== */
/* 10. THE SERVER HALF — deterministic identity                               */
/* ========================================================================== */
{
  const MSGID = require(path.join(ROOT, 'functions', 'shared', 'message-identity.js'));

  const declared = MSGID.API_CONTRACT.slice().sort();
  const exported = Object.keys(MSGID).sort();
  ok('identity contract: declared === exported',
    declared.join(',') === exported.join(','), declared.join(',') + ' vs ' + exported.join(','));

  const KEY = 'cm_1000_abcdefgh';
  const id1 = MSGID.messageDocIdFor('uidA', 'c1', KEY);
  eq('identity is deterministic', MSGID.messageDocIdFor('uidA', 'c1', KEY), id1);

  /* THE SQUATTING DEFENCE. If the key alone were the document id, uidB could
     occupy uidA's document and block an honest message — a denial of service
     available to anyone who can guess a string. */
  ok('a different SENDER gets a different id', MSGID.messageDocIdFor('uidB', 'c1', KEY) !== id1);
  ok('a different CONVERSATION gets a different id', MSGID.messageDocIdFor('uidA', 'c2', KEY) !== id1);
  ok('a different KEY gets a different id', MSGID.messageDocIdFor('uidA', 'c1', 'cm_1000_abcdefgi') !== id1);

  ok('the id is a legal Firestore document id',
    /^m_[0-9a-f]{32}$/.test(id1) && id1.indexOf('/') === -1, id1);
  ok('the id avoids the reserved form', !/^__.*__$/.test(id1));

  const seen = new Set();
  for (let u = 0; u < 40; u++) for (let c = 0; c < 20; c++) for (let k = 0; k < 20; k++) {
    seen.add(MSGID.messageDocIdFor('uid' + u, 'conv' + c, 'cm_key_' + k));
  }
  eq('16000 distinct triples give 16000 distinct ids', seen.size, 16000);

  [['', 'empty'], ['short', 'too short'], ['x'.repeat(129), 'too long'],
   ['has space here', 'a space'], ['bad/slash/key', 'a slash'],
   [null, 'null'], [12345678, 'a number'], [{}, 'an object'],
  ].forEach(function (pair) {
    const bad = pair[0], why = pair[1];
    ok('a key is refused when it is ' + why, MSGID.isValidClientMessageId(bad) === false);
    let threw = false;
    try { MSGID.messageDocIdFor('uidA', 'c1', bad); } catch (e) { threw = true; }
    ok('  ...and deriving an id from it THROWS rather than falling back', threw);
  });

  /* CONTROL: the validator accepts what the outbox actually mints. A charset
     the client cannot satisfy would refuse every real message. */
  const minted = OB.newEntry({ conversationId: 'c1', body: 'hi', at: 1758400000000, nonce: '0.abcdefgh' });
  ok('CONTROL: the server accepts the key the OUTBOX mints',
    MSGID.isValidClientMessageId(minted.clientMessageId), minted.clientMessageId);

  const handler = stripComments(
    fs.readFileSync(path.join(ROOT, 'functions', 'messages.js'), 'utf8'));
  ok('CONTROL: the stripped handler is still readable',
    handler.indexOf('exports.sendMessage') !== -1);
  ok('sendMessage uses batch.create for an idempotent send',
    handler.indexOf('batch.create(msgRef, msgData)') !== -1);
  ok('sendMessage still uses batch.set when no key is supplied (nothing existing changes)',
    handler.indexOf('batch.set(msgRef, msgData)') !== -1);
  ok('sendMessage derives the id from the VERIFIED uid, never the request body',
    handler.indexOf('MSGID.messageDocIdFor(req.auth.uid') !== -1);
  ok('sendMessage returns an explicit acknowledgement',
    handler.indexOf('accepted: true') !== -1);
  ok('a malformed key is refused rather than coerced',
    handler.indexOf('MSGID.isValidClientMessageId(clientMessageId)') !== -1);
}

/* ========================================================================== */
/* 11. ROUND TRIP — the outbox against a store with create() semantics        */
/* ========================================================================== */
const async6 = (async () => {
  const MSGID = require(path.join(ROOT, 'functions', 'shared', 'message-identity.js'));

  /* A message store modelled on the real write: a document map PLUS the unread
     counter the real batch increments beside it. 'mode' selects create() (the
     repaired handler) or set() (what it did before). */
  function fakeStore(mode) {
    const docs = new Map();
    let unread = 0;
    return {
      docs: docs,
      unread: function () { return unread; },
      send: function (uid, payload) {
        /* The OLD handler ignored the key entirely and always minted a random
           id, so 'set' mode must do the same — deriving an id there would model
           a server that half-deduplicates, which never existed. */
        const id = (mode === 'create' && payload.clientMessageId)
          ? MSGID.messageDocIdFor(uid, payload.conversationId, payload.clientMessageId)
          : 'rand_' + Math.random().toString(36).slice(2);
        /* create() rejects the WHOLE batch, so the counter is not touched. */
        if (mode === 'create' && docs.has(id)) {
          return { messageId: id, accepted: true, duplicate: true };
        }
        docs.set(id, payload.body);
        unread += 1;
        return { messageId: id, accepted: true, duplicate: false };
      },
    };
  }

  /* The genuinely hard case: the FIRST call reaches the store and is accepted,
     then times out on the way back. The server has it; the client never heard. */
  function lyingTransport(store, uid) {
    let n = 0;
    return function (payload) {
      n += 1;
      const res = store.send(uid, payload);
      if (n === 1) {
        return Promise.reject(Object.assign(new Error('deadline'), { code: 'deadline-exceeded' }));
      }
      return Promise.resolve(res);
    };
  }

  const good = fakeStore('create');
  const box = OB.createOutbox({ storage: memStorage(), transport: lyingTransport(good, 'uidA'), now });
  const e = box.enqueue({ conversationId: 'c1', body: 'did you get this?' });
  await box.drain({ online: true });
  eq('round trip: the client saw a failure', box.list()[0].state, 'failed');
  const r = await box.retry(e.clientMessageId);
  eq('round trip: the retry is acknowledged', box.list()[0].state, 'sent');
  eq('round trip: the server reported a duplicate, not an error', r.ok, true);
  eq('ROUND TRIP: the conversation holds ONE message', good.docs.size, 1);
  eq('ROUND TRIP: the unread badge counted ONE', good.unread(), 1);

  /* --- INVERTING CONTROL: the server as it behaved BEFORE this change. -----
     Same client, same timeout, same retry. If these assertions cannot tell a
     deduping server from a non-deduping one, they are not evidence. */
  const old = fakeStore('set');
  const box2 = OB.createOutbox({ storage: memStorage(), transport: lyingTransport(old, 'uidA'), now });
  const e2 = box2.enqueue({ conversationId: 'c1', body: 'did you get this?' });
  await box2.drain({ online: true });
  await box2.retry(e2.clientMessageId);
  eq('CONTROL: the old server stored the message TWICE', old.docs.size, 2);
  eq('CONTROL: ...and double-counted the unread badge', old.unread(), 2);

  /* The client behaved identically in both runs — which is precisely why the
     fix had to live on the server. A client cannot make a server idempotent. */
  eq('the client did the same thing both times (the fix is server-side)',
    box.list()[0].attempts, box2.list()[0].attempts);
})();

/* ========================================================================== */
/* 12. THE SEAM — the chat engine CARRIES the key, and does not mint one      */
/* ========================================================================== */
{
  const eng = stripComments(fs.readFileSync(path.join(ROOT, 'sokoni-chat-engine.js'), 'utf8'));
  ok('CONTROL: the stripped engine is readable', eng.indexOf('function sendMessage') !== -1);
  ok('the engine passes a supplied key through to the CF',
    eng.indexOf('callData.clientMessageId = String(payload.clientMessageId)') !== -1);
  ok('the engine MINTS no key of its own (a fresh key per call is a random id)',
    eng.indexOf('clientMessageId = ') === eng.lastIndexOf('clientMessageId = '));
  ok('the key is only added when supplied, so existing callers are unchanged',
    eng.indexOf('if (payload.clientMessageId)') !== -1);
  ok('the engine does not generate ids for messages',
    eng.indexOf('Math.random') === -1 || eng.indexOf('placeholderId') !== -1);
}

/* ========================================================================== */
Promise.all([async1, async2, async3, async4, async5, async6]).then(() => {
  console.log('');
  console.log('  SOKONI offline outbox — Phase 7');
  console.log('  ' + '-'.repeat(60));
  failures.forEach((f) => console.log('  FAIL  ' + f));
  console.log('  ' + pass + ' passed, ' + failures.length + ' failed');
  console.log('');
  process.exit(failures.length ? 1 : 0);
}).catch((e) => {
  /* A crash is not a refusal and is not a pass. */
  console.error('  SUITE CRASHED — this is a FAILURE, not a skip');
  console.error(e && e.stack);
  process.exit(1);
});
