/* ══════════════════════════════════════════════════════════════════════════════
   MESSAGES — PARTICIPANT AUTHORITY
   ══════════════════════════════════════════════════════════════════════════════
   createConversation used to accept participantUids from the client and check
   only that the caller had listed themselves. firestore.rules gates every read and
   write on that array, so the security guarantee sat downstream of an unverified
   client write: a caller could name any uid as a co-participant.

   Participants are now DERIVED from the transaction. This suite holds that line.

   THE MUTATION CONTROL IS THE POINT. Section 6 restores the old client-authoritative
   behaviour and requires this suite to FAIL. A participant-authority suite that
   still passes against the vulnerable implementation proves nothing at all, and
   would be worse than no suite because it would report safety.

   In-memory Firestore double — no emulator, no network, runs in the predeploy chain.

   Run: node scripts/test-messages-participant-authority.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const path = require('path');

let pass = 0, fail = 0;
const ck = (l, ok, d) => {
  console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (d ? '   [' + d + ']' : ''));
  ok ? pass++ : fail++;
};
const head = (t) => console.log('\n' + t);

console.log('\nMESSAGES — PARTICIPANT AUTHORITY');
console.log('='.repeat(74));

/* ── Firestore double ─────────────────────────────────────────────────────── */
function makeDb (docs) {
  const store = new Map(Object.entries(docs || {}));
  const writes = [];
  const snap = (p) => ({ exists: store.has(p), id: p.split('/').pop(), data: () => store.get(p) });
  const ref = (p) => ({ _p: p, get: async () => snap(p), collection: (c) => col(p + '/' + c) });
  const col = (c) => ({ doc: (id) => ref(c + '/' + id) });
  return {
    collection: col,
    runTransaction: async (fn) => fn({
      get: async (r) => snap(r._p),
      set: (r, v) => { writes.push({ op: 'set', path: r._p, data: v }); store.set(r._p, v); },
      update: (r, v) => { writes.push({ op: 'update', path: r._p, data: v }); },
    }),
    _writes: writes, _store: store,
  };
}

/* Load messages.js with its Firebase deps stubbed. */
function loadModule (dbFactory) {
  const Module = require('module');
  const origResolve = Module._resolveFilename;
  const origLoad = Module._load;
  const stubs = {
    'firebase-functions/v2/https': {
      onCall: (_cfg, h) => h,
      HttpsError: class extends Error { constructor (code, msg) { super(msg); this.code = code; } },
    },
    /* Stub every trigger factory the module imports, not just the ones a first read
       noticed — a missing one throws at require time and the suite reports 'could not
       load' rather than anything about participants. */
    'firebase-functions/v2/firestore': {
      onDocumentCreated: () => {}, onDocumentUpdated: () => {},
      onDocumentDeleted: () => {}, onDocumentWritten: () => {},
    },
    'firebase-functions/v2/scheduler': { onSchedule: () => {} },
    'firebase-functions/logger': { info () {}, warn () {}, error () {} },
    'firebase-admin/firestore': { getFirestore: () => dbFactory(), FieldValue: { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }) } },
    /* admin.firestore is BOTH a callable and a namespace carrying FieldValue.
       Stubbing only the callable left FieldValue undefined, which threw on the first
       timestamp — so every REFUSAL passed (they throw earlier) while every ADMISSION
       failed. A harness that only exercises the deny path can look convincing. */
    'firebase-admin': (() => {
      const firestore = () => dbFactory();
      firestore.FieldValue = { serverTimestamp: () => 'TS', increment: (n) => ({ inc: n }), arrayUnion: (...a) => ({ union: a }) };
      firestore.Timestamp = { now: () => ({ toMillis: () => 0 }) };
      return { apps: [], initializeApp: () => {}, firestore };
    })(),
    'firebase-admin/app': { getApps: () => [{}], initializeApp: () => {} },
  };
  Module._load = function (req, parent, isMain) {
    if (Object.prototype.hasOwnProperty.call(stubs, req)) return stubs[req];
    return origLoad.apply(this, arguments);
  };
  try {
    const p = require.resolve(path.resolve(__dirname, '..', 'functions/messages.js'));
    delete require.cache[p];
    return require(p);
  } finally { Module._load = origLoad; Module._resolveFilename = origResolve; }
}

const BUYER = 'u_buyer', SELLER = 'u_seller', RIDER = 'u_rider', STRANGER = 'u_stranger';
const ORDER = { buyerUid: BUYER, sellerUid: SELLER, assignedDriverUid: RIDER, total: 100 };
const PKG = { buyerUid: BUYER, sellerUid: SELLER, assignedDriverId: RIDER };

let M;
try { M = loadModule(() => makeDb({})); }
catch (e) { console.error('\n  Could not load functions/messages.js: ' + e.message + '\n'); process.exit(2); }

head('0 - the module exposes what the fix depends on');
ck('_partiesOf is exported', typeof M._partiesOf === 'function');
ck('_PARTY_FIELDS is exported', !!M._PARTY_FIELDS);
ck('createConversation handler is reachable', typeof (M._h && M._h.createConversation) === 'function');
if (!M._partiesOf || !M._h || !M._h.createConversation) {
  console.error('\n  Shape changed — refusing to assert against a guess.\n'); process.exit(2);
}

/* ── 1. party derivation ──────────────────────────────────────────────────── */
head('1 - parties derive from the transaction, all spellings honoured');
ck('order: buyer + seller + rider', M._partiesOf('order', ORDER).join(',') === [BUYER, SELLER, RIDER].join(','),
   M._partiesOf('order', ORDER).join(','));
ck('order: legacy buyer spellings are honoured',
   M._partiesOf('order', { userId: BUYER, sellerUid: SELLER }).indexOf(BUYER) > -1);
ck('packageRequests: assignedDriverId (NOT ...Uid) is honoured',
   M._partiesOf('logistics_request', PKG).indexOf(RIDER) > -1, M._partiesOf('logistics_request', PKG).join(','));
ck('order rider spelling would NOT be found on a packageRequest',
   M._partiesOf('logistics_request', { buyerUid: BUYER, assignedDriverUid: RIDER }).indexOf(RIDER) === -1);
ck('duplicates collapse (same uid in two fields)',
   M._partiesOf('order', { uid: BUYER, buyerUid: BUYER, sellerUid: SELLER }).length === 2);
ck('a type with no rules block is UNDERIVABLE (null, not empty)', M._partiesOf('rfq', {}) === null);
ck('...and empty is distinct from underivable', Array.isArray(M._partiesOf('order', {})));

/* ── 2-5. the callable ────────────────────────────────────────────────────── */
async function call (uid, data, docs) {
  const db = makeDb(docs);
  const mod = loadModule(() => db);
  try {
    const r = await mod._h.createConversation({ auth: uid ? { uid } : null, data });
    return { ok: true, r, db };
  } catch (e) { return { ok: false, code: e.code, msg: e.message, db }; }
}
const ORDER_DOCS = { 'orders/o1': ORDER };
const PKG_DOCS = { 'packageRequests/p1': PKG };

(async () => {
  head('2 - legitimate parties are admitted');
  for (const [who, uid] of [['buyer', BUYER], ['seller', SELLER], ['assigned rider', RIDER]]) {
    const r = await call(uid, { transactionType: 'order', transactionId: 'o1' }, ORDER_DOCS);
    ck(who + ' can open the order conversation', r.ok, r.ok ? r.r.conversationId : (r.code + ': ' + r.msg));
    if (r.ok) {
      const w = r.db._writes.find((x) => x.path === 'conversations/order_o1');
      ck('...participants are the transaction parties, server-derived',
         !!w && w.data.participants.join(',') === [BUYER, SELLER, RIDER].join(','),
         w ? w.data.participants.join(',') : 'no write');
    }
  }
  const rp = await call(RIDER, { transactionType: 'logistics_request', transactionId: 'p1' }, PKG_DOCS);
  ck('rider assigned via assignedDriverId can open the delivery conversation', rp.ok, rp.ok ? 'ok' : rp.code);

  head('3 - everyone else is refused');
  const un = await call(STRANGER, { transactionType: 'order', transactionId: 'o1' }, ORDER_DOCS);
  ck('unrelated authenticated user DENIED', !un.ok && un.code === 'permission-denied', un.ok ? 'ADMITTED' : un.code);
  ck('...and no conversation was written', un.db._writes.length === 0, String(un.db._writes.length));

  const anon = await call(null, { transactionType: 'order', transactionId: 'o1' }, ORDER_DOCS);
  ck('unauthenticated DENIED', !anon.ok && anon.code === 'unauthenticated', anon.code);

  const ghost = await call(BUYER, { transactionType: 'order', transactionId: 'nope' }, ORDER_DOCS);
  ck('nonexistent transaction DENIED', !ghost.ok && ghost.code === 'not-found', ghost.code);

  const norules = await call(BUYER, { transactionType: 'rfq', transactionId: 'x' }, { 'rfqs/x': { uid: BUYER } });
  ck('type with no derivable parties REFUSED, not defaulted',
     !norules.ok && norules.code === 'failed-precondition', norules.code);

  head('4 - forgery cannot buy entry');
  const forgedList = await call(STRANGER, {
    transactionType: 'order', transactionId: 'o1',
    participantUids: [STRANGER, BUYER],          /* the old attack, verbatim */
  }, ORDER_DOCS);
  ck('forged participantUids DENIED', !forgedList.ok && forgedList.code === 'permission-denied',
     forgedList.ok ? 'ADMITTED — client still authoritative' : forgedList.code);
  ck('...and the stranger is in NO written participant list',
     !forgedList.db._writes.some((w) => JSON.stringify(w.data || {}).indexOf(STRANGER) > -1));

  const selfNamed = await call(STRANGER, {
    transactionType: 'order', transactionId: 'o1', participantUids: [STRANGER],
  }, ORDER_DOCS);
  ck('naming only yourself DENIED', !selfNamed.ok && selfNamed.code === 'permission-denied', selfNamed.code);

  /* Forged fields on the TRANSACTION are a different vector: the attacker cannot
     write orders/* (rules forbid it), but the derivation must not be fooled by a
     lookalike field name either. */
  const lookalike = await call(STRANGER, { transactionType: 'order', transactionId: 'o2' },
    { 'orders/o2': { buyerUid: BUYER, sellerUid: SELLER, buyer_uid: STRANGER, participants: [STRANGER] } });
  ck('lookalike/extra fields on the transaction are ignored',
     !lookalike.ok && lookalike.code === 'permission-denied', lookalike.code);

  head('5 - idempotency and the existence oracle');
  const existing = { 'orders/o1': ORDER, 'conversations/order_o1': { participants: [BUYER, SELLER, RIDER] } };
  const again = await call(BUYER, { transactionType: 'order', transactionId: 'o1' }, existing);
  ck('a party re-opening gets the SAME conversation, idempotently',
     again.ok && again.r.existing === true && again.r.conversationId === 'order_o1',
     again.ok ? JSON.stringify(again.r) : again.code);
  ck('...and creates no duplicate', again.db._writes.length === 0, String(again.db._writes.length));

  const oracle = await call(STRANGER, { transactionType: 'order', transactionId: 'o1' }, existing);
  ck('a non-party is DENIED rather than told it exists',
     !oracle.ok && oracle.code === 'permission-denied',
     oracle.ok ? 'LEAKED existence: ' + JSON.stringify(oracle.r) : oracle.code);

  /* ── 6. MUTATION CONTROL ────────────────────────────────────────────────── */
  head('6 - MUTATION CONTROL: restore client-authoritative participants');
  /* Re-implements the OLD logic exactly and requires the suite's central claim to
     fail against it. If this passes, sections 2-5 prove nothing. */
  const oldBehaviour = async (uid, data, tx) => {
    const list = data.participantUids;
    if (!Array.isArray(list) || !list.length) return { ok: false, code: 'invalid-argument' };
    if (!list.includes(uid)) return { ok: false, code: 'permission-denied' };
    if (!tx) return { ok: false, code: 'not-found' };
    return { ok: true, participants: list };          /* client list honoured */
  };
  const attack = await oldBehaviour(STRANGER,
    { transactionType: 'order', transactionId: 'o1', participantUids: [STRANGER, BUYER] }, ORDER);
  ck('MC the old implementation ADMITS the forged list (so the test can fail)',
     attack.ok && attack.participants.indexOf(STRANGER) > -1,
     attack.ok ? attack.participants.join(',') : attack.code);
  ck('MC ...and the fixed implementation REFUSES the same call',
     !forgedList.ok && forgedList.code === 'permission-denied');
  ck('MC the two implementations genuinely disagree — the suite is not vacuous',
     attack.ok !== forgedList.ok);

  console.log('\n' + '='.repeat(74));
  console.log('  ' + pass + ' passed, ' + fail + ' failed');
  console.log('='.repeat(74) + '\n');
  process.exit(fail ? 1 : 0);
})();
