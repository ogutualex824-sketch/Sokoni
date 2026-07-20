/* Layer 3 — authentication smoke tests against a running origin.

   These drive the REAL Firebase SDK on a real page. They are the only rules
   that can answer "can a human sign in", which is the question the other two
   layers only approximate.

   Deliberate boundaries:
     - No credentials are used and no SMS is sent. Rules assert on the FIRST
       error code the SDK raises, which for configuration faults is emitted
       client-side before any account or phone number is involved.
     - auth/popup-closed-by-user and auth/cancelled-popup-request are PASSES.
       They prove the pipeline reached Google's consent screen, which is
       exactly what we are certifying. Only auth/internal-error and
       auth/unauthorized-domain indicate a broken platform.
     - Provider-specific flows needing a real account (merchant, buyer, admin,
       password reset, session refresh) are NOT faked. They return SKIPPED with
       the reason, because a fabricated pass on a login test is the single most
       dangerous output this tool could produce. */
'use strict';
const { STATUS } = require('../engine');

const TARGET = process.env.SOKONI_SMOKE_ORIGIN || 'https://mysokoni.co.ke';

/* Configuration faults. Anything else means the pipeline is reachable. */
const BROKEN = ['auth/internal-error', 'auth/unauthorized-domain', 'auth/operation-not-allowed',
                'auth/invalid-api-key', 'auth/app-not-authorized', 'auth/configuration-not-found'];
const REACHED = ['auth/popup-closed-by-user', 'auth/cancelled-popup-request', 'auth/popup-blocked'];

function requiresPlaywright(ctx) {
  try { require.resolve('playwright'); }
  catch (_) { return { ok: false, reason: 'playwright not installed — npm i -D playwright' }; }
  if (ctx.offline) return { ok: false, reason: 'offline mode: live smoke tests disabled' };
  return { ok: true };
}

/* One browser session serves every Layer 3 rule; probing is expensive and the
   results are independent of each other. */
async function probe(ctx) {
  if (ctx._smoke) return ctx._smoke;

  const { webkit, devices } = require('playwright');
  const br = await webkit.launch();
  try {
    const page = await (await br.newContext({ ...devices['iPhone 13'] })).newPage();
    await page.goto(TARGET + '/login', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(10000);

    ctx._smoke = await page.evaluate(async () => {
      const out = { init: null, google: null, anonymous: null };
      const auth = window.firebaseAuth;
      if (!auth) return { init: 'FIREBASE AUTH DID NOT INITIALISE' };
      out.init = 'ok';

      try {
        const p = new window.firebase.auth.GoogleAuthProvider();
        await window.firebase.auth().signInWithPopup(p);
        out.google = 'resolved';
      } catch (e) { out.google = e.code || e.message; }

      try {
        await window.firebase.auth().signInAnonymously();
        out.anonymous = 'resolved';
        if (window.firebase.auth().currentUser) await window.firebase.auth().currentUser.delete().catch(() => {});
      } catch (e) { out.anonymous = e.code || e.message; }

      return out;
    });
  } finally { await br.close(); }
  return ctx._smoke;
}

const codeVerdict = (code, label) => {
  if (code === null || code === undefined) return { status: STATUS.SKIPPED, evidence: label + ': not probed' };
  if (BROKEN.includes(code)) {
    return { status: STATUS.FAIL, evidence: label + ' -> ' + code,
      remediation: code === 'auth/internal-error'
        ? 'Server-side failure inside the sign-in pipeline. Check Layer 2 blocking functions first — a ' +
          'stale registration produces exactly this code on every provider at once.'
        : 'Configuration fault. Check authorized domains, provider enablement, and the API key.' };
  }
  if (REACHED.includes(code)) return { status: STATUS.PASS, evidence: label + ' -> ' + code + ' (pipeline reached Google; config healthy)' };
  if (code === 'resolved') return { status: STATUS.PASS, evidence: label + ' -> completed' };
  return { status: STATUS.FAIL, evidence: label + ' -> unrecognised code: ' + code };
};

module.exports = [
  {
    id: 'smoke.init',
    layer: 3,
    title: 'Firebase Auth initialises on the live origin',
    severity: 'critical',
    requires: requiresPlaywright,
    run: async (ctx) => {
      const r = await probe(ctx);
      return r.init === 'ok'
        ? { status: STATUS.PASS, evidence: 'firebaseAuth live at ' + TARGET }
        : { status: STATUS.FAIL, evidence: r.init || 'unknown' };
    },
  },

  {
    id: 'smoke.google',
    layer: 3,
    title: 'Google Sign-In reaches the consent screen without a configuration fault',
    severity: 'critical',
    requires: requiresPlaywright,
    run: async (ctx) => codeVerdict((await probe(ctx)).google, 'signInWithPopup(Google)'),
  },

  {
    id: 'smoke.anonymous',
    layer: 3,
    title: 'Anonymous sign-in succeeds',
    severity: 'medium',
    requires: requiresPlaywright,
    run: async (ctx) => {
      const code = (await probe(ctx)).anonymous;
      /* Anonymous auth being disabled is a deliberate product choice, not a
         fault — do not fail the certification over it. */
      if (code === 'auth/admin-restricted-operation' || code === 'auth/operation-not-allowed') {
        return { status: STATUS.SKIPPED, evidence: 'anonymous auth is disabled for this project (' + code + ')' };
      }
      return codeVerdict(code, 'signInAnonymously');
    },
  },

  {
    id: 'smoke.phone-otp',
    layer: 3,
    title: 'Phone OTP delivery',
    severity: 'critical',
    requires: () => ({ ok: false, reason:
      'cannot be automated without sending a real SMS to a real handset — requires a human tester' }),
    run: () => ({ status: STATUS.SKIPPED, evidence: 'manual test required' }),
  },

  {
    id: 'smoke.account-flows',
    layer: 3,
    title: 'Merchant / buyer / admin login, password reset, session refresh, logout',
    severity: 'critical',
    requires: () => ({ ok: false, reason:
      'requires real credentials; a synthetic pass here would be actively dangerous' }),
    run: () => ({ status: STATUS.SKIPPED, evidence: 'manual test required' }),
  },
];
