/**
 * Unit tests — wallet top-up finalization via the IntaSend webhook.
 *
 * Guards the most important financial invariant on the wallet path:
 * EXACTLY-ONCE crediting. IntaSend retries webhooks on timeout/5xx, and the
 * poll (confirmWalletTopUp) and sweep (sweepStaleWalletTopUps) can race the
 * webhook — all three converge on one Firestore transactional claim, so a
 * replay must be a no-op, never a second credit.
 *
 * Following the convention of webhook.test.js (which inlines the payload
 * parsers), this test drives a faithful PORT of `_finalizeWalletTopUp` from
 * functions/index.js against an in-memory Firestore double, so it needs no
 * emulator and no Firebase credentials. If you change the helper in index.js,
 * mirror the change in `finalizeWalletTopUp` below — the scenarios here are the
 * regression guard for that logic.
 */

"use strict";

/* ── In-memory Firestore double with runTransaction read/commit semantics ── */
function makeFakeDb(seed = {}) {
  const store = new Map(Object.entries(seed)); // "collection/id" -> data | undefined

  const snap = (key) => {
    const exists = store.has(key) && store.get(key) !== undefined;
    return { exists, data: () => store.get(key) };
  };
  const ref = (col, id) => ({
    _key: `${col}/${id}`,
    get: async () => snap(`${col}/${id}`),
  });

  return {
    _store: store,
    get: (key) => store.get(key),
    collection: (col) => ({ doc: (id) => ref(col, id) }),
    async runTransaction(fn) {
      const writes = [];
      const t = {
        get: async (r) => snap(r._key),
        set: (r, data) => writes.push(["set", r._key, data]),
        update: (r, data) => writes.push(["update", r._key, data]),
      };
      await fn(t);
      for (const [op, key, data] of writes) {
        if (op === "set") store.set(key, { ...data });
        else store.set(key, { ...(store.get(key) || {}), ...data });
      }
    },
  };
}

/* admin.firestore.Timestamp.now() double — a stable sentinel is enough here */
const TS = { _fakeTimestamp: true };
const fakeAdmin = { firestore: { Timestamp: { now: () => TS } } };

/* ── Faithful port of _finalizeWalletTopUp (functions/index.js) ──
   Keep in lockstep with the production helper. */
async function finalizeWalletTopUp(db, admin, logger, apiRef, state, amount, tag) {
  if (!apiRef || !apiRef.startsWith("wtop_")) return false;

  const txRef = db.collection("walletTransactions").doc(apiRef);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return true;
  const tx = txSnap.data();

  const paid = state === "COMPLETE";
  const failed = ["FAILED", "CANCELLED", "EXPIRED"].includes(state);

  if (paid && amount && Math.round(amount) !== Math.round(tx.amount)) {
    logger.warn(`[${tag}] wallet top-up amount mismatch`, { ref: apiRef, requested: tx.amount, webhook: amount });
  }

  if (paid) {
    await db.runTransaction(async (t) => {
      const walletRef = db.collection("wallets").doc(tx.uid);
      const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(txRef)]);
      if (txCheck.exists && txCheck.data().status === "completed") return;

      const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
      if (!walletSnap.exists) {
        t.set(walletRef, {
          uid: tx.uid, balance: current + tx.amount, currency: "KES",
          lastTopUp: admin.firestore.Timestamp.now(), pendingTopUp: null,
          createdAt: admin.firestore.Timestamp.now(),
        });
      } else {
        const update = { balance: current + tx.amount, lastTopUp: admin.firestore.Timestamp.now() };
        if (walletSnap.data().pendingTopUp === apiRef) update.pendingTopUp = null;
        t.update(walletRef, update);
      }
      t.update(txRef, { status: "completed", updatedAt: admin.firestore.Timestamp.now(), resolvedBy: tag });
    });
  } else if (failed) {
    await db.runTransaction(async (t) => {
      const walletRef = db.collection("wallets").doc(tx.uid);
      const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(txRef)]);
      if (txCheck.exists && txCheck.data().status !== "pending") return;
      t.update(txRef, { status: "failed", updatedAt: admin.firestore.Timestamp.now(), resolvedBy: tag });
      if (walletSnap.exists && walletSnap.data().pendingTopUp === apiRef) {
        t.update(walletRef, { pendingTopUp: null });
      }
    });
  }
  return true;
}

/* ── Helpers ── */
const REF = "wtop_abc_123";
const UID = "user_1";
function seedPending({ balance = 500, amount = 200, pendingTopUp = REF, walletExists = true } = {}) {
  const seed = { [`walletTransactions/${REF}`]: { uid: UID, amount, status: "pending" } };
  if (walletExists) seed[`wallets/${UID}`] = { uid: UID, balance, pendingTopUp, currency: "KES" };
  return makeFakeDb(seed);
}
function makeLogger() {
  const warns = [];
  return { logger: { warn: (...a) => warns.push(a) }, warns };
}

/* ─────────────────────────────────────────────────────────────
   Routing / discrimination
───────────────────────────────────────────────────────────── */
describe("wallet webhook — routing", () => {
  test("ignores non-wallet refs (no wtop_ prefix) and returns false", async () => {
    const db = makeFakeDb({});
    const { logger } = makeLogger();
    const handled = await finalizeWalletTopUp(db, fakeAdmin, logger, "SKNTJKAS8", "COMPLETE", 499, "test");
    expect(handled).toBe(false);
    expect(db._store.size).toBe(0);
  });

  test("acks an unknown wtop_ ref with no writes and returns true", async () => {
    const db = makeFakeDb({});
    const { logger } = makeLogger();
    const handled = await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test");
    expect(handled).toBe(true);
    expect(db._store.size).toBe(0);
  });
});

/* ─────────────────────────────────────────────────────────────
   Exactly-once crediting — the core invariant
───────────────────────────────────────────────────────────── */
describe("wallet webhook — exactly-once crediting", () => {
  test("credits tx.amount once on first COMPLETE", async () => {
    const db = seedPending({ balance: 500, amount: 200 });
    const { logger } = makeLogger();
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test");

    expect(db.get(`wallets/${UID}`).balance).toBe(700);
    expect(db.get(`walletTransactions/${REF}`).status).toBe("completed");
    expect(db.get(`walletTransactions/${REF}`).resolvedBy).toBe("test");
    expect(db.get(`wallets/${UID}`).pendingTopUp).toBeNull();
  });

  test("a replayed webhook does NOT credit a second time", async () => {
    const db = seedPending({ balance: 500, amount: 200 });
    const { logger } = makeLogger();

    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test"); // first
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test"); // retry
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test"); // retry

    expect(db.get(`wallets/${UID}`).balance).toBe(700); // +200 exactly once
  });

  test("no credit when a concurrent path already marked the tx completed", async () => {
    const db = seedPending({ balance: 500, amount: 200 });
    // Simulate confirmWalletTopUp / sweep having already won the claim
    db._store.set(`walletTransactions/${REF}`, { uid: UID, amount: 200, status: "completed" });
    const { logger } = makeLogger();

    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test");
    expect(db.get(`wallets/${UID}`).balance).toBe(500); // untouched
  });

  test("creates the wallet doc when it does not exist yet", async () => {
    const db = seedPending({ amount: 300, walletExists: false });
    const { logger } = makeLogger();
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 300, "test");

    const w = db.get(`wallets/${UID}`);
    expect(w.balance).toBe(300);
    expect(w.currency).toBe("KES");
    expect(w.pendingTopUp).toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────
   Amount integrity — always credit the server-recorded figure
───────────────────────────────────────────────────────────── */
describe("wallet webhook — amount integrity", () => {
  test("credits tx.amount, not the webhook amount, and logs the mismatch", async () => {
    const db = seedPending({ balance: 0, amount: 200 });
    const { logger, warns } = makeLogger();
    // Webhook claims 190 (e.g. net after a fee); we must still credit 200
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 190, "test");

    expect(db.get(`wallets/${UID}`).balance).toBe(200);
    expect(warns).toHaveLength(1);
    expect(warns[0][1]).toEqual({ ref: REF, requested: 200, webhook: 190 });
  });

  test("no mismatch warning when amounts agree", async () => {
    const db = seedPending({ balance: 0, amount: 200 });
    const { logger, warns } = makeLogger();
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test");
    expect(warns).toHaveLength(0);
  });
});

/* ─────────────────────────────────────────────────────────────
   pendingTopUp race — only clear the flag if it still points here
───────────────────────────────────────────────────────────── */
describe("wallet webhook — pendingTopUp race", () => {
  test("does NOT clear a newer pending top-up the user just started", async () => {
    const db = seedPending({ balance: 500, amount: 200, pendingTopUp: "wtop_newer_999" });
    const { logger } = makeLogger();
    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "COMPLETE", 200, "test");

    expect(db.get(`wallets/${UID}`).balance).toBe(700);      // still credited
    expect(db.get(`wallets/${UID}`).pendingTopUp).toBe("wtop_newer_999"); // preserved
  });
});

/* ─────────────────────────────────────────────────────────────
   Failure states
───────────────────────────────────────────────────────────── */
describe("wallet webhook — failure states", () => {
  test.each(["FAILED", "CANCELLED", "EXPIRED"])(
    "marks tx failed and leaves balance unchanged on %s",
    async (state) => {
      const db = seedPending({ balance: 500, amount: 200 });
      const { logger } = makeLogger();
      await finalizeWalletTopUp(db, fakeAdmin, logger, REF, state, 0, "test");

      expect(db.get(`walletTransactions/${REF}`).status).toBe("failed");
      expect(db.get(`wallets/${UID}`).balance).toBe(500);         // unchanged
      expect(db.get(`wallets/${UID}`).pendingTopUp).toBeNull();   // cleared
    }
  );

  test("does not overwrite an already-completed tx with failed", async () => {
    const db = seedPending({ balance: 700, amount: 200 });
    db._store.set(`walletTransactions/${REF}`, { uid: UID, amount: 200, status: "completed" });
    const { logger } = makeLogger();

    await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "FAILED", 0, "test");
    expect(db.get(`walletTransactions/${REF}`).status).toBe("completed"); // preserved
    expect(db.get(`wallets/${UID}`).balance).toBe(700);
  });

  test("PENDING state leaves everything untouched (poll/sweep will finalize)", async () => {
    const db = seedPending({ balance: 500, amount: 200 });
    const { logger } = makeLogger();
    const handled = await finalizeWalletTopUp(db, fakeAdmin, logger, REF, "PENDING", 200, "test");

    expect(handled).toBe(true);
    expect(db.get(`walletTransactions/${REF}`).status).toBe("pending");
    expect(db.get(`wallets/${UID}`).balance).toBe(500);
  });
});
