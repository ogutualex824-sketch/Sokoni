#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   21F-2b-MESSAGES-PARTICIPANT-AUTHORITY — the concurrency half
   scripts/test-messages-participant-concurrency.js
   ══════════════════════════════════════════════════════════════════════════════
   scripts/test-messages-participant-authority.js already proves the AUTHORITY half on
   an in-memory double: parties derive from the transaction, a stranger is refused, and
   a client-supplied list is ignored. What it cannot prove is what happens when two
   parties press the button at the same instant, because an in-memory double has no
   contention to reproduce.

   So this half runs on a REAL FIRESTORE ENGINE and answers one question:

     does the participant-authority repair create DUPLICATE conversations, or admit a
     participant set that differs between concurrent callers?

   WHY THIS IS NOT JUST DEFENSIVE. The repair changed WHERE participants come from —
   from the caller's array to a read of the transaction document. That moved a read
   INSIDE the create path, and a read that decides what gets written is exactly the
   shape that goes wrong under concurrency. Both parties to a booking opening the
   thread at the same moment is the normal case, not an edge case.

   THE PATTERN UNDER TEST. `createConversation` reads convRef INSIDE a transaction and
   writes only if absent. A transactional read joins the conflict set, so a concurrent
   writer forces an abort and retry — which is why this is safe where a check-then-act
   OUTSIDE a transaction would not be. The sabotage below reproduces that wrong shape
   on the same engine so the difference is measured rather than asserted.

   FAILS CLOSED: refuses to report a result without FIRESTORE_EMULATOR_HOST.
   Run through:  npm run test:messages:concurrency
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const path = require('path');
const ROOT = path.resolve(__dirname, '..');

let pass = 0, failed = 0;
const ck = (name, ok, detail) => {
  (ok ? pass++ : failed++);
  console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '   [' + detail + ']' : ''));
};
const head = (t) => console.log('\n-- ' + t + ' --');

console.log('\n══ MESSAGES PARTICIPANT AUTHORITY — CONCURRENCY ══');

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  console.log('\n-- ENGINE REQUIRED --');
  console.error('  REFUSING to report a concurrency result without a real engine.');
  console.error('  An in-memory double serialises everything and would pass trivially.');
  console.error('  Run through: npm run test:messages:concurrency\n');
  process.exit(1);
}

const admin = require(path.join(ROOT, 'functions', 'node_modules', 'firebase-admin'));
if (!admin.apps.length) admin.initializeApp({ projectId: process.env.GCLOUD_PROJECT || 'sokoni-msg-conc' });
const db = admin.firestore();
const msgs = require(path.join(ROOT, 'functions', 'messages.js'));
const createConversation = msgs._h.createConversation;

const BUYER = 'u_buyer_c', SELLER = 'u_seller_c', RIDER = 'u_rider_c', STRANGER = 'u_stranger_c';
const ORDER = 'o_conc_1';
const CONV = 'order_' + ORDER;

async function wipe() {
  for (const c of ['conversations', 'orders', 'users', 'userConversations']) {
    const s = await db.collection(c).get();
    await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
  /* userConversations items live in a subcollection */
  for (const u of [BUYER, SELLER, RIDER, STRANGER]) {
    const s = await db.collection('userConversations').doc(u).collection('items').get();
    await Promise.all(s.docs.map((d) => d.ref.delete()));
  }
}

async function seed() {
  await db.collection('orders').doc(ORDER).set({
    buyerUid: BUYER, sellerUid: SELLER, assignedDriverUid: RIDER, total: 1000,
  });
  for (const [u, n] of [[BUYER, 'Buyer'], [SELLER, 'Seller'], [RIDER, 'Rider'], [STRANGER, 'Nobody']]) {
    await db.collection('users').doc(u).set({ displayName: n });
  }
}

const call = (uid) => createConversation({
  auth: { uid }, data: { transactionType: 'order', transactionId: ORDER, metadata: {} },
});
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

(async () => {
  console.log('\n  engine: ' + process.env.FIRESTORE_EMULATOR_HOST);

  /* ── 0 ───────────────────────────────────────────────────────────────────── */
  head('0 - control: the engine is live and the handler is the real one');
  await wipe(); await seed();
  {
    const o = await db.collection('orders').doc(ORDER).get();
    ck('the engine round-trips a write', o.exists && o.data().buyerUid === BUYER, 'orders/' + ORDER);
    ck('the handler under test is the exported one', typeof createConversation === 'function',
      'functions/messages.js _h.createConversation');
    /* POSITIVE CONTROL: the parties really do derive from this document, so a later
       "exactly one conversation" result is about concurrency and not about nothing
       being created at all. */
    const parties = msgs._partiesOf('order', { buyerUid: BUYER, sellerUid: SELLER, assignedDriverUid: RIDER });
    ck('POSITIVE CONTROL: parties derive from the order', parties.length === 3,
      parties.join(','));
  }

  /* ── 1 ───────────────────────────────────────────────────────────────────── */
  head('1 - EIGHT concurrent opens by both parties yield ONE conversation');
  await wipe(); await seed();
  {
    const callers = [BUYER, SELLER, BUYER, SELLER, RIDER, BUYER, SELLER, RIDER];
    const res = await Promise.all(callers.map((u) => settle(call(u))));
    const okd = res.filter((r) => r.ok);
    ck('every legitimate party succeeded', okd.length === 8, okd.length + '/8');

    const snap = await db.collection('conversations').get();
    ck('EXACTLY ONE conversation document exists', snap.size === 1, snap.size + ' doc(s)');
    ck('...and it is the deterministic id', snap.size === 1 && snap.docs[0].id === CONV,
      snap.size === 1 ? snap.docs[0].id : 'n/a');

    const ids = new Set(okd.map((r) => r.v && r.v.conversationId));
    ck('every caller was given the SAME conversationId', ids.size === 1,
      Array.from(ids).join(', '));

    const created = okd.filter((r) => r.v && !r.v.existing).length;
    ck('exactly one caller created it; the rest saw it existing', created === 1,
      created + ' created, ' + (okd.length - created) + ' existing');
  }

  /* ── 2 ───────────────────────────────────────────────────────────────────── */
  head('2 - the participant set is authoritative and identical for every caller');
  {
    const d = (await db.collection('conversations').doc(CONV).get()).data() || {};
    const p = (d.participants || []).slice().sort();
    ck('participants are the transaction parties', p.join(',') === [BUYER, SELLER, RIDER].sort().join(','),
      p.join(','));
    ck('...and the stranger is not among them', p.indexOf(STRANGER) === -1, 'no stranger');
    ck('unreadCounts cover exactly the participants',
      Object.keys(d.unreadCounts || {}).sort().join(',') === p.join(','),
      Object.keys(d.unreadCounts || {}).join(','));
  }

  /* ── 3 ───────────────────────────────────────────────────────────────────── */
  head('3 - the per-user index is written once, not once per concurrent call');
  {
    for (const u of [BUYER, SELLER, RIDER]) {
      const s = await db.collection('userConversations').doc(u).collection('items').get();
      ck(u + ' has exactly one inbox item', s.size === 1, s.size + ' item(s)');
    }
    const s = await db.collection('userConversations').doc(STRANGER).collection('items').get();
    ck('the stranger has no inbox item', s.size === 0, s.size + ' item(s)');
  }

  /* ── 4 ───────────────────────────────────────────────────────────────────── */
  head('4 - a stranger racing the parties is refused and leaves nothing behind');
  await wipe(); await seed();
  {
    const res = await Promise.all([
      settle(call(BUYER)), settle(call(STRANGER)), settle(call(SELLER)),
      settle(call(STRANGER)), settle(call(STRANGER)),
    ]);
    const strangers = [res[1], res[3], res[4]];
    ck('every stranger call was REFUSED', strangers.every((r) => !r.ok),
      strangers.map((r) => (r.ok ? 'ok' : (r.e && r.e.code) || 'err')).join(', '));
    ck('...with permission-denied, not a generic failure',
      strangers.every((r) => !r.ok && /permission-denied/.test(String((r.e && r.e.code) || r.e))),
      'not-a-party');
    ck('the parties still got their conversation', res[0].ok && res[2].ok, 'buyer + seller ok');

    const d = (await db.collection('conversations').doc(CONV).get()).data() || {};
    ck('the stranger is NOT in the participant list',
      (d.participants || []).indexOf(STRANGER) === -1, (d.participants || []).join(','));
    const s = await db.collection('userConversations').doc(STRANGER).collection('items').get();
    ck('...and got no inbox entry from the race', s.size === 0, s.size + ' item(s)');
  }

  /* ── 5 ───────────────────────────────────────────────────────────────────── */
  head('5 - a forged participant list changes nothing (it is not read at all)');
  await wipe(); await seed();
  {
    /* The old contract took participantUids from the caller. Passing it now must be
       inert — not merely "also checked", but ignored. */
    const r = await settle(createConversation({
      auth: { uid: BUYER },
      data: {
        transactionType: 'order', transactionId: ORDER,
        participantUids: [BUYER, STRANGER],      /* the forgery */
        metadata: {},
      },
    }));
    ck('the call succeeds for a real party', r.ok, r.ok ? 'created' : String(r.e));
    const d = (await db.collection('conversations').doc(CONV).get()).data() || {};
    ck('the forged uid did NOT become a participant',
      (d.participants || []).indexOf(STRANGER) === -1, (d.participants || []).join(','));
    ck('the derived parties were used instead',
      (d.participants || []).length === 3, (d.participants || []).length + ' parties');
  }

  /* ── 6 ───────────────────────────────────────────────────────────────────── */
  head('6 - SABOTAGE: check-then-act OUTSIDE a transaction, same engine, same load');
  await wipe(); await seed();
  {
    /* The wrong shape, reproduced rather than asserted: read the doc, then write it,
       with no transaction around the pair. Under identical concurrency this is the
       failure the real implementation must not have. */
    const naive = async (uid) => {
      const ref = db.collection('conversations').doc('naive_' + ORDER + '_' + Math.random().toString(36).slice(2, 8));
      const marker = db.collection('conversations').doc('naive_marker');
      const snap = await marker.get();                    /* check ... */
      await new Promise((r) => setTimeout(r, 5));         /* ... a real gap ... */
      if (!snap.exists) {                                  /* ... then act */
        await marker.set({ by: uid });
        await ref.set({ transactionId: ORDER, participants: [uid], naive: true });
      }
    };
    await Promise.all([BUYER, SELLER, RIDER, BUYER, SELLER, RIDER, BUYER, SELLER].map(naive));
    const naiveDocs = (await db.collection('conversations').get()).docs
      .filter((d) => (d.data() || {}).naive === true);
    ck('SABOTAGE: check-then-act yields MORE THAN ONE conversation', naiveDocs.length > 1,
      naiveDocs.length + ' docs from 8 concurrent calls');

    /* and the real implementation, same load, same engine */
    const res = await Promise.all([BUYER, SELLER, RIDER, BUYER, SELLER, RIDER, BUYER, SELLER]
      .map((u) => settle(call(u))));
    const real = (await db.collection('conversations').doc(CONV).get()).exists ? 1 : 0;
    ck('...while the transactional implementation yields exactly ONE', real === 1,
      naiveDocs.length + ' vs 1, identical load');
    ck('...and every caller still succeeded', res.every((r) => r.ok),
      res.filter((r) => r.ok).length + '/8');
  }

  console.log('\n  ' + pass + ' passed, ' + failed + ' failed\n');
  if (failed) {
    console.log('  The participant-authority repair is NOT concurrency-safe: concurrent\n' +
      '  opens produced duplicate conversations, divergent participant sets, or\n' +
      '  admitted a caller who is not a party.\n');
  } else {
    console.log('  On a real Firestore engine: eight concurrent opens by three parties yield\n' +
      '  exactly one conversation with one authoritative participant set and one inbox\n' +
      '  entry each. A stranger racing them is refused and leaves nothing behind, and a\n' +
      '  forged participant list is inert. Check-then-act, same load, forks.\n');
  }
  process.exitCode = failed ? 1 : 0;
  await wipe();
})().catch((e) => {
  console.error('\n  HARNESS FAILURE (not a pass): ' + (e && e.stack || e) + '\n');
  process.exitCode = 1;
});
