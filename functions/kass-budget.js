'use strict';
/**
 * KASS AI budget guard (owner, 2026-10-01): "make sure AI does not over-cost, SOKONI must be well capped".
 *
 * Owner decisions:
 *   - per user: 30 KASS messages per day, then "limit reached, try tomorrow";
 *   - global:   USD 5 per day across everyone; when reached, KASS pauses until the next day.
 *
 * Before this, sokoniChat had NO spend control: a per-IP limiter keyed on the client-controlled leftmost
 * X-Forwarded-For, no per-user quota, no global ceiling, and nothing recorded usage (AdminOS read
 * aiUsage.totalTokens, which nothing wrote, so its AI-cost figure was always 0).
 *
 * Design:
 *   - admit(uid): ONE transaction reads aiUsage/{day} (the global spend) and aiUsage/{day}/kassUsers/{uid}. It
 *     refuses when the day's cost has reached the cap or the user has used their messages, else it counts the
 *     message. FAILS CLOSED: an unreadable budget is a refusal, never free spend.
 *   - meter(usage): after EVERY model call, adds the real response.usage tokens and cost with increments
 *     (no read), so concurrent requests cannot lose spend.
 *   - canContinue(): the tool loop re-checks the ceiling before each further model call, so one message cannot
 *     run far past the cap.
 *   - day = the Africa/Nairobi calendar day (the owner's day), as YYYY-MM-DD.
 *   - Limits: config/kassBudget {perUserDaily, globalDailyUsd} overrides the owner defaults; the per-token prices
 *     are code constants (Claude Haiku 4.5: USD 1 / MTok input, USD 5 / MTok output).
 *
 * aiUsage/{YYYY-MM-DD} carries `date` and `totalTokens`, which is exactly what adminGetAiStats reads. It has no
 * `period` field, so the AI-subscriptions monthly archive (which selects by `period`) never touches it.
 */
const DEFAULTS = Object.freeze({ perUserDaily: 30, globalDailyUsd: 5 });
const PRICE = Object.freeze({ inputPerTok: 1 / 1e6, outputPerTok: 5 / 1e6 });   /* claude-haiku-4-5 */

function nairobiDay(now) {
  /* Africa/Nairobi is UTC+3 all year (no DST). */
  const d = new Date((now || Date.now()) + 3 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}

function costOf(usage) {
  const u = usage || {};
  const inTok = Number(u.input_tokens || 0) + Number(u.cache_creation_input_tokens || 0) + Number(u.cache_read_input_tokens || 0) * 0.1;
  const outTok = Number(u.output_tokens || 0);
  return { inTok: Math.round(inTok), outTok, usd: inTok * PRICE.inputPerTok + outTok * PRICE.outputPerTok };
}

async function limits(db) {
  const snap = await db.collection('config').doc('kassBudget').get();   /* a read error propagates → fail closed */
  const c = snap.exists ? (snap.data() || {}) : {};
  const per = Number.isFinite(Number(c.perUserDaily)) && Number(c.perUserDaily) >= 0 ? Number(c.perUserDaily) : DEFAULTS.perUserDaily;
  const glob = Number.isFinite(Number(c.globalDailyUsd)) && Number(c.globalDailyUsd) >= 0 ? Number(c.globalDailyUsd) : DEFAULTS.globalDailyUsd;
  return { perUserDaily: per, globalDailyUsd: glob };
}

/** @returns {Promise<{ok:true, day:string} | {ok:false, reason:'user_quota'|'global_cap'|'budget_unavailable'}>} */
async function admit(db, admin, uid, now) {
  const day = nairobiDay(now);
  try {
    const lim = await limits(db);
    const dayRef = db.collection('aiUsage').doc(day);
    const userRef = dayRef.collection('kassUsers').doc(String(uid));
    return await db.runTransaction(async (tx) => {
      const [daySnap, userSnap] = await Promise.all([tx.get(dayRef), tx.get(userRef)]);
      const spent = Number((daySnap.exists && daySnap.data().costUsd) || 0);
      if (spent >= lim.globalDailyUsd) return { ok: false, reason: 'global_cap' };
      const used = Number((userSnap.exists && userSnap.data().messages) || 0);
      if (used >= lim.perUserDaily) return { ok: false, reason: 'user_quota' };
      const inc = admin.firestore.FieldValue.increment;
      tx.set(userRef, { messages: inc(1), uid: String(uid), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.set(dayRef, { date: day, kassMessages: inc(1), updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return { ok: true, day };
    });
  } catch (e) {
    return { ok: false, reason: 'budget_unavailable' };   /* FAIL CLOSED */
  }
}

/** Record one model call's real usage. Never throws (the spend already happened; losing the record is logged). */
async function meter(db, admin, day, uid, usage) {
  const c = costOf(usage);
  const inc = admin.firestore.FieldValue.increment;
  const dayRef = db.collection('aiUsage').doc(day);
  try {
    await Promise.all([
      dayRef.set({ date: day, totalTokens: inc(c.inTok + c.outTok), inputTokens: inc(c.inTok), outputTokens: inc(c.outTok),
        costUsd: inc(c.usd), kassCalls: inc(1) }, { merge: true }),
      dayRef.collection('kassUsers').doc(String(uid)).set({ tokens: inc(c.inTok + c.outTok), costUsd: inc(c.usd) }, { merge: true }),
    ]);
  } catch (e) {
    console.error('[kass-budget] meter failed', { day, err: String(e && e.message || e) });
  }
  return c;
}

/** Before another model call in the same message: stop once the day's ceiling is reached. Fails closed. */
async function canContinue(db, day) {
  try {
    const [lim, snap] = await Promise.all([limits(db), db.collection('aiUsage').doc(day).get()]);
    return Number((snap.exists && snap.data().costUsd) || 0) < lim.globalDailyUsd;
  } catch (e) { return false; }
}

const MESSAGES = Object.freeze({
  user_quota: "You've reached today's KASS limit. Please try again tomorrow — everything else on SOKONI works as usual.",
  global_cap: "KASS is resting for today and will be back tomorrow. Everything else on SOKONI works as usual.",
  budget_unavailable: "KASS is temporarily unavailable. Please try again in a moment.",
});

module.exports = { DEFAULTS, PRICE, nairobiDay, costOf, limits, admit, meter, canContinue, MESSAGES };
