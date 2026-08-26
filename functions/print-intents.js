/* ═══════════════════════════════════════════════════════════════════════════════
   print-intents — one sale, one durable print intent, at most one printer
   ═══════════════════════════════════════════════════════════════════════════════
       PENDING ──claim──► CLAIMED ──begin──► PRINTING ──ok──► PRINTED
                             │                   │
                             └───────fail────────┴──► FAILED ──retry──► PENDING

   THE PROPERTY THIS EXISTS FOR: a reload, a duplicate realtime event, a focus event or a
   reconnect must never turn one sale into two physical receipts. Everything below is in
   service of that and nothing else.

   ── WHY THIS LIVES IN posPrintJobs ──────────────────────────────────────────────
   The collection already exists, and its rule is already exactly right: CF-only writes
   (`allow create, update, delete: if false`) with shop-scoped reads via ownsBiz(shopId). A new
   collection would need a new match block, and the compiled ruleset has ~510 bytes free. Reuse
   costs zero rules bytes and zero rules risk.

   But posPrintJobs ALREADY HOLDS SOMETHING ELSE. functions/index.js writes an audit record
   there for the LAN/TCP relay — {uid, shopId, host, port, bytes, status:'pending'} — logged
   AFTER the bytes are already on their way to the printer. A desktop naively listening for
   "pending" jobs would reprint every one of those. That is precisely the one-sale-two-receipts
   failure, arriving through the back door.

   Two INDEPENDENT discriminators keep the two apart, and either one alone is sufficient:
     1. kind: 'printIntent'. Legacy records have no `kind` at all, and a Firestore equality
        filter excludes documents missing the field — they cannot appear in the query.
     2. Intent statuses are UPPERCASE. The legacy relay writes lowercase 'pending'.
   Belt and braces on purpose: a single shared discriminator is one refactor away from
   silently matching legacy rows.

   Legacy records stay readable and untouched. Nothing here migrates or rewrites them.

   ── IDENTITY ────────────────────────────────────────────────────────────────────
   The document id is derived from the receipt: {shopId}__{receiptId}. It is not random.
   A duplicate phone event, a retried callable, or a realtime echo all resolve to the SAME
   document, so a second intent for one sale cannot exist. The browser's localStorage
   PrintQueue also dedupes on receiptId, but that is a convenience in one browser profile — it
   cannot see a second desktop, and it is wiped by clearing site data. Firestore is the
   authority; the queue is a cache.

   ── CLAIM ───────────────────────────────────────────────────────────────────────
   A claim is a server transaction, never a client write. It verifies, atomically:
       the job is PENDING (or its lease has expired)
       the claiming device EXISTS and is printerHost: true
       that device's merchantId EQUALS the job's shopId
       the caller may act for that shop
   and only then records claimedBy / claimedAt / claimToken / leaseExpiresAt.

   claimToken is a FENCING token. Every later transition must present it. When a stale lease is
   taken over, the new claimant gets a NEW token, which permanently fences the old one out — a
   host that wakes up from a long pause cannot mark a job PRINTED that someone else has since
   taken.

   ── THE LEASE IS A RECOVERY MECHANISM, NOT A GUARANTEE ──────────────────────────
   If a host claims a job and dies, the job must not be stuck forever, so the lease expires and
   another host may take it. That is an honest trade: a host that is merely SLOW — paused
   mid-print for longer than the lease — can have its job taken over and printed twice. The
   lease is therefore set far above any real print (a P58E receipt is seconds), and takeover of
   a PRINTING job never re-prints silently: it requires an explicit FAILED, then an explicit
   retry. What IS guaranteed is that at most one claimant holds a job at a time, and that a
   fenced-out claimant can never report PRINTED.

   mayPrint is the only signal the desktop should act on, and it is true ONLY for a fresh
   CLAIMED. A job already PRINTING returns mayPrint:false even to its own claimant — after a
   crash mid-print we cannot know whether paper already came out, and re-sending on ambiguity
   is the one thing that produces a duplicate receipt.

   ── NO PAYLOAD IS STORED ────────────────────────────────────────────────────────
   The intent references posReceipts/{receiptId}; it does not carry ESC/POS bytes. The desktop
   renders through SokoniReceiptDoc like every other surface. Embedding bytes would create a
   second receipt source that could disagree with the canonical one, and would put a 64KB blob
   in a document that is written several times per sale.
   ═══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const crypto = require('crypto');

const db = admin.firestore();
const F  = admin.firestore.FieldValue;

const { assertShopAccess } = require('./shop-access');

const OPT = { region: 'us-central1', memory: '256MiB', timeoutSeconds: 30 };

const COL  = 'posPrintJobs';
const KIND = 'printIntent';

/* Far above any real receipt print, which is seconds. See the lease note above. */
const LEASE_MS = 90 * 1000;
const MAX_ATTEMPTS = 5;

const STATUS = {
  PENDING:  'PENDING',
  CLAIMED:  'CLAIMED',
  PRINTING: 'PRINTING',
  PRINTED:  'PRINTED',
  FAILED:   'FAILED',
};

/* The FSM, declared once. A transition absent from this table cannot happen. */
const TRANSITIONS = {
  [STATUS.CLAIMED]:  [STATUS.PRINTING, STATUS.FAILED],
  [STATUS.PRINTING]: [STATUS.PRINTED,  STATUS.FAILED],
  [STATUS.FAILED]:   [STATUS.PENDING],
  [STATUS.PENDING]:  [],   /* leaves PENDING only through claimPrintJob */
  [STATUS.PRINTED]:  [],   /* terminal */
};

function _san (v, max = 200) { return String(v == null ? '' : v).slice(0, max).trim(); }
function _requireAuth (req) {
  if (!req || !req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in first.');
  return req.auth.uid;
}
function _isAdmin (req) { return !!(req && req.auth && req.auth.token && req.auth.token.admin); }

/* Deterministic, shop-scoped, and safe as a Firestore document id (no '/'). */
function intentDocId (shopId, receiptId) {
  const safe = (s) => _san(s, 120).replace(/[^A-Za-z0-9_.:-]/g, '-');
  return safe(shopId) + '__' + safe(receiptId);
}

function _leaseLive (job, nowMs) {
  const exp = job && job.leaseExpiresAt;
  if (!exp) return false;
  const ms = typeof exp.toMillis === 'function' ? exp.toMillis() : Number(exp);
  return Number.isFinite(ms) && ms > nowMs;
}

/* ═══════════════════════════════════════════════════════════════════════════════
   createPrintIntent — the phone/POS records durable work
   ───────────────────────────────────────────────────────────────────────────────
   shopId is SUPPLIED here, because a sale has no device record to derive it from — but it is
   VERIFIED, never trusted: the caller must actually be able to act for that shop. That is a
   different thing from registerPrinterHost, where a stored record already fixes the answer.

   Creating twice is not an error. It returns the existing intent, because "the phone sent the
   event twice" and "the network retried the callable" are indistinguishable and both mean one
   receipt.
   ═══════════════════════════════════════════════════════════════════════════════ */
exports.createPrintIntent = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);
  const d = req.data || {};

  const shopId    = _san(d.shopId, 120);
  const receiptId = _san(d.receiptId, 120);
  if (!shopId)    throw new HttpsError('invalid-argument', 'shopId is required.');
  if (!receiptId) throw new HttpsError('invalid-argument', 'receiptId is required.');

  await assertShopAccess({
    db, uid, shopId, branchId: _san(d.branchId, 120) || null,
    isAdmin: _isAdmin(req), HttpsError,
    message: 'You do not have permission to queue printing for this shop.',
  });

  const id  = intentDocId(shopId, receiptId);
  const ref = db.collection(COL).doc(id);

  const out = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);

    if (snap.exists) {
      const j = snap.data() || {};
      /* A legacy relay record can never collide: its id is random and it has no kind. If a
         document with this deterministic id somehow is not an intent, refuse rather than
         overwrite somebody else's record. */
      if (j.kind !== KIND) {
        throw new HttpsError('already-exists',
          'A different record already occupies that print id.');
      }
      return { jobId: id, status: j.status, created: false };
    }

    txn.set(ref, {
      kind:        KIND,
      shopId,
      receiptId,
      /* uid feeds the EXISTING posPrintJobs read rule (resource.data.uid == auth.uid), so the
         cashier who made the sale can watch their own job without a rules change. */
      uid,
      createdBy:   uid,
      branchId:    _san(d.branchId, 120) || null,
      deviceIdHint: _san(d.deviceId, 200) || null,
      copies:      Math.max(1, Math.min(5, Number(d.copies) || 1)),
      status:      STATUS.PENDING,
      attempts:    0,
      claimedBy:   null,
      claimedAt:   null,
      claimToken:  null,
      leaseExpiresAt: null,
      createdAt:   F.serverTimestamp(),
      updatedAt:   F.serverTimestamp(),
    });
    return { jobId: id, status: STATUS.PENDING, created: true };
  });

  return { ok: true, ...out, shopId, receiptId };
});

/* ═══════════════════════════════════════════════════════════════════════════════
   claimPrintJob — at most one host, decided by the server
   ═══════════════════════════════════════════════════════════════════════════════ */
exports.claimPrintJob = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const jobId    = _san(d.jobId, 250);
  const deviceId = _san(d.deviceId, 200);
  if (!jobId)    throw new HttpsError('invalid-argument', 'jobId is required.');
  if (!deviceId) throw new HttpsError('invalid-argument', 'deviceId is required.');

  /* The device record fixes which shop this desktop belongs to. As with registerPrinterHost,
     the caller never establishes that by naming it. */
  const devSnap = await db.collection('posDevices').doc(deviceId).get();
  if (!devSnap.exists) throw new HttpsError('not-found', 'That device is not registered.');
  const device = devSnap.data() || {};

  if (device.printerHost !== true) {
    throw new HttpsError('failed-precondition',
      'That device is not the registered printer host for its shop.');
  }
  if (!device.merchantId) {
    throw new HttpsError('failed-precondition', 'That device has no shop on its record.');
  }

  await assertShopAccess({
    db, uid, shopId: device.merchantId, branchId: device.branchId || null,
    isAdmin: _isAdmin(req), HttpsError,
    message: 'You do not have permission to print for this shop.',
  });

  const ref = db.collection(COL).doc(jobId);
  const nowMs = Date.now();

  const out = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such print job.');
    const j = snap.data() || {};

    if (j.kind !== KIND) {
      throw new HttpsError('failed-precondition',
        'That record is not a print intent. Legacy relay logs are not claimable.');
    }
    /* THE SHOP BOUNDARY. The device's shop, from its record, must equal the job's shop. */
    if (j.shopId !== device.merchantId) {
      throw new HttpsError('permission-denied', 'That print job belongs to another shop.');
    }
    if (j.status === STATUS.PRINTED) {
      throw new HttpsError('failed-precondition', 'That receipt has already printed.');
    }
    if (j.status === STATUS.FAILED) {
      throw new HttpsError('failed-precondition',
        'That job failed. Retry it before claiming.');
    }

    const held = (j.status === STATUS.CLAIMED || j.status === STATUS.PRINTING);
    const mine = held && j.claimedBy === deviceId;
    const live = _leaseLive(j, nowMs);

    if (held && live && !mine) {
      /* Another host holds a live lease. This is the race, and it resolves here. */
      throw new HttpsError('aborted', 'Another printer host is already handling that receipt.');
    }

    if (held && mine && live) {
      /* A reload, a duplicate event, or a reconnect. NOT a new claim: same token, same
         claimedAt, no state change. mayPrint is false once PRINTING has begun, because we
         cannot know whether paper already came out. */
      return {
        jobId, status: j.status, claimToken: j.claimToken,
        alreadyMine: true, tookOverStale: false,
        mayPrint: j.status === STATUS.CLAIMED,
      };
    }

    /* Either PENDING, or a lease that has expired and may be taken over. */
    const tookOverStale = held && !live;
    const token = crypto.randomBytes(16).toString('hex');

    txn.update(ref, {
      status:         STATUS.CLAIMED,
      claimedBy:      deviceId,
      claimedAt:      F.serverTimestamp(),
      claimToken:     token,
      leaseExpiresAt: admin.firestore.Timestamp.fromMillis(nowMs + LEASE_MS),
      claimedByUid:   uid,
      updatedAt:      F.serverTimestamp(),
      ...(tookOverStale ? { takeovers: F.increment(1), lastTakeoverFrom: j.claimedBy || null } : {}),
    });

    return {
      jobId, status: STATUS.CLAIMED, claimToken: token,
      alreadyMine: false, tookOverStale, mayPrint: true,
    };
  });

  return { ok: true, ...out, shopId: device.merchantId, leaseMs: LEASE_MS };
});

/* ═══════════════════════════════════════════════════════════════════════════════
   advancePrintJob — every other transition, fenced by claimToken
   ═══════════════════════════════════════════════════════════════════════════════
   FAILED → PENDING is the retry. It reuses the SAME document: a retry must never create a
   second job, or the receipt count stops matching the sale count.
   ═══════════════════════════════════════════════════════════════════════════════ */
exports.advancePrintJob = onCall(OPT, async (req) => {
  const uid = _requireAuth(req);
  const d = req.data || {};
  const jobId = _san(d.jobId, 250);
  const to    = _san(d.to, 20).toUpperCase();
  const token = _san(d.claimToken, 100);
  if (!jobId) throw new HttpsError('invalid-argument', 'jobId is required.');
  if (!STATUS[to]) throw new HttpsError('invalid-argument', 'Unknown target status.');

  const ref = db.collection(COL).doc(jobId);

  const out = await db.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'No such print job.');
    const j = snap.data() || {};
    if (j.kind !== KIND) {
      throw new HttpsError('failed-precondition', 'That record is not a print intent.');
    }

    const allowed = TRANSITIONS[j.status] || [];
    if (!allowed.includes(to)) {
      throw new HttpsError('failed-precondition',
        'Cannot move a ' + j.status + ' job to ' + to + '.');
    }

    /* Retry is an operator action, not a claimant action: the claim is already gone, so it is
       authorised by shop access rather than by a token. */
    if (j.status === STATUS.FAILED) {
      await assertShopAccess({
        db, uid, shopId: j.shopId, branchId: j.branchId || null,
        isAdmin: _isAdmin(req), HttpsError,
        message: 'You do not have permission to retry printing for this shop.',
      });
      if ((j.attempts || 0) >= MAX_ATTEMPTS) {
        throw new HttpsError('resource-exhausted',
          'That receipt has failed too many times. Print it manually.');
      }
      txn.update(ref, {
        status: STATUS.PENDING,
        claimedBy: null, claimedAt: null, claimToken: null, leaseExpiresAt: null,
        retriedBy: uid, retriedAt: F.serverTimestamp(), updatedAt: F.serverTimestamp(),
      });
      return { jobId, status: STATUS.PENDING, retried: true };
    }

    /* THE FENCE. A host whose lease was taken over still holds its old token; presenting it
       must not move the job. */
    if (!token || !j.claimToken || token !== j.claimToken) {
      throw new HttpsError('permission-denied',
        'That claim is no longer valid. Another host has taken this job.');
    }

    const patch = { status: to, updatedAt: F.serverTimestamp() };
    if (to === STATUS.PRINTING) {
      patch.printingAt = F.serverTimestamp();
      /* Extend the lease at the moment real work starts, so a slow printer is not taken over
         because the claim happened to be made a while before the bytes went out. */
      patch.leaseExpiresAt = admin.firestore.Timestamp.fromMillis(Date.now() + LEASE_MS);
    }
    if (to === STATUS.PRINTED) {
      patch.printedAt = F.serverTimestamp();
      patch.printedBy = j.claimedBy || null;
      /* Terminal: drop the lease and the token so nothing can act on it again. */
      patch.claimToken = null;
      patch.leaseExpiresAt = null;
    }
    if (to === STATUS.FAILED) {
      patch.failedAt = F.serverTimestamp();
      patch.lastError = _san(d.error, 300) || 'unknown';
      patch.attempts = F.increment(1);
      patch.claimToken = null;
      patch.leaseExpiresAt = null;
    }
    txn.update(ref, patch);
    return { jobId, status: to, retried: false };
  });

  return { ok: true, ...out };
});

module.exports.intentDocId = intentDocId;
module.exports.STATUS = STATUS;
module.exports.TRANSITIONS = TRANSITIONS;
module.exports.LEASE_MS = LEASE_MS;
