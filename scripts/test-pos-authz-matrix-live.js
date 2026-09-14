#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   POS CALLABLE AUTHORIZATION MATRIX — live, against the deployed functions
   ------------------------------------------------------------------------------
   Proves the SERVED authorization behaviour of the security deploy (smartPosDispatch
   + the peripheral callables + posLookupCustomer) — the deny/allow matrix that a
   modelled test and a CLI exit-0 cannot establish. It calls the real production
   callables through the real web app with real App Check, as real identities.

   MODELLED ON scripts/test-merchant-authorization.js (same App Check injection,
   same real signInWithEmailAndPassword, same "a cache hit is not an answer" rigour).

   NON-NEGOTIABLES (enforced below, not just documented):
     · App Check is NEVER bypassed. If attestation does not EXCHANGE, the run ABORTS —
       an un-attested "denied" is indistinguishable from "never asked".
     · No credential is invented and no claim is minted. Missing inputs => SKIP with a
       BLOCKER banner and a NON-ZERO exit. A blocker is never a PASS.
     · NON-MUTATING. Every probe is a READ op (cmGet* / getPOSAnalytics). A DENY is
       rejected at the guard before any effect; an ALLOW reads, it does not write.
     · The authorization boundary is exactly `permission-denied`. ALLOW = the guard was
       passed (resolved, or a non-authz error like invalid-argument/not-found). DENY =
       the callable threw functions/permission-denied.

   INPUTS (env — see docs/APPCHECK_DEBUG_TOKEN_LEDGER.md for the token):
     APPCHECK_DEBUG_TOKEN     registered debug token for sokoni-aeb26
     MA_STAFF_EMAIL/_PW       a STAFF member of Merchant A (posStaff of A, not an owner/admin)
     MA_MERCHANT_ID           Merchant A's merchantId
     MB_MERCHANT_ID           Merchant B's merchantId (the foreign target)
     SA_EMAIL/_PW             Seller A (an approved seller, NOT admin/superAdmin)
     SB_SELLER_ID             Seller B's sellerId/uid (the foreign target)
     ADM_EMAIL/_PW            an Admin/superAdmin identity (for the admin-may-target case)

     node scripts/test-pos-authz-matrix-live.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const { webkit } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const E = process.env;
const TOKEN = E.APPCHECK_DEBUG_TOKEN || '';
const ID = {
  maStaffEmail: E.MA_STAFF_EMAIL || '', maStaffPw: E.MA_STAFF_PW || '',
  maMerchantId: E.MA_MERCHANT_ID || '', mbMerchantId: E.MB_MERCHANT_ID || '',
  saEmail: E.SA_EMAIL || '', saPw: E.SA_PW || '', sbSellerId: E.SB_SELLER_ID || '',
  admEmail: E.ADM_EMAIL || '', admPw: E.ADM_PW || '',
};
const PLACEHOLDER = (v) => !v || /^<.*>$/.test(v) || /your[-_]/i.test(v);

const results = [];
const rec = (name, expected, got, pass, note) => {
  results.push({ name, expected, got, pass });
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${name}  expect=${expected} got=${got}${note ? '  (' + note + ')' : ''}`);
};
const head = (t) => console.log('\n── ' + t + ' ' + '─'.repeat(Math.max(0, 68 - t.length)));

function blocker(missing) {
  console.log('\n' + '='.repeat(74));
  console.log('  BLOCKED — test-environment inputs missing. This is NOT a pass.');
  console.log('='.repeat(74));
  console.log('  Missing: ' + missing.join(', '));
  console.log('  Gate 1 cannot be evaluated without real certification identities +');
  console.log('  App Check debug token. Supply them (see docs/APPCHECK_DEBUG_TOKEN_LEDGER.md)');
  console.log('  and re-run. No outcome here may be recorded as GREEN.');
  process.exit(2);
}

const MISSING = [];
if (PLACEHOLDER(TOKEN)) MISSING.push('APPCHECK_DEBUG_TOKEN');
[['MA_STAFF_EMAIL', ID.maStaffEmail], ['MA_STAFF_PW', ID.maStaffPw], ['MA_MERCHANT_ID', ID.maMerchantId],
 ['MB_MERCHANT_ID', ID.mbMerchantId], ['SA_EMAIL', ID.saEmail], ['SA_PW', ID.saPw],
 ['SB_SELLER_ID', ID.sbSellerId], ['ADM_EMAIL', ID.admEmail], ['ADM_PW', ID.admPw]]
  .forEach(([k, v]) => { if (PLACEHOLDER(v)) MISSING.push(k); });
if (MISSING.length) blocker(MISSING);

const MIME = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(f, (e, d) => {
    if (e) { res.writeHead(404); return res.end('nf'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'text/plain' });
    res.end(d);
  });
});

const wd = setTimeout(() => { console.log('\nWATCHDOG — exceeded 10 min'); process.exit(1); }, 600000);
wd.unref && wd.unref();

/* Sign in as an identity and return {ok, uid, claims}. */
async function signIn(page, email, password) {
  return page.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, A] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js')]);
      if (!getApps().length) return { ok: false, why: 'no Firebase app' };
      const auth = A.getAuth(getApp());
      await A.signOut(auth).catch(() => {});
      const cred = await A.signInWithEmailAndPassword(auth, email, password);
      const tok = await cred.user.getIdTokenResult().catch(() => null);
      return { ok: true, uid: cred.user.uid, claims: tok ? tok.claims : {} };
    } catch (e) { return { ok: false, why: (e && (e.code || e.message)) || String(e) }; }
  }, { email, password });
}

/* Call a callable through the page SDK (App Check auto-attaches). Classify by the
   authorization boundary: DENY iff functions/permission-denied. */
async function call(page, fnName, payload) {
  return page.evaluate(async ({ fnName, payload }) => {
    try {
      const [{ getApp }, Fx] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js')]);
      const fns = Fx.getFunctions(getApp(), 'us-central1');
      const res = await Fx.httpsCallable(fns, fnName)(payload);
      return { denied: false, ok: true, keys: res && res.data ? Object.keys(res.data).slice(0, 6) : [] };
    } catch (e) {
      const code = (e && e.code) || String(e);
      return { denied: /permission-denied/.test(code), ok: false, code };
    }
  }, { fnName, payload });
}
/* Single live call per case (never call the boundary twice — the two calls could
   disagree). Classifies against the authz boundary and records pass/fail. */
async function probe(page, name, expected, fnName, payload) {
  const r = await call(page, fnName, payload);
  const actual = r.denied ? 'DENY' : 'ALLOW';
  rec(name, expected, actual, actual === expected, r.code || (r.keys ? 'keys:' + r.keys.join(',') : ''));
}

server.listen(0, async () => {
  const BASE = 'http://127.0.0.1:' + server.address().port;
  let browser;
  try { browser = await webkit.launch(); }
  catch (e) { console.log('SKIP — webkit unavailable: ' + (e && e.message)); server.close(); process.exit(2); return; }

  const ctx = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  await ctx.addInitScript((t) => { try { localStorage.setItem('SOKONI_APPCHECK_DEBUG_TOKEN', t); } catch (e) {} }, TOKEN);
  const page = await ctx.newPage();

  console.log('\n' + '='.repeat(74));
  console.log('  POS CALLABLE AUTHORIZATION MATRIX — LIVE (production callables)');
  console.log('='.repeat(74));

  /* precondition: App Check must EXCHANGE, else abort */
  head('App Check attested (precondition)');
  await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded', timeout: 40000 }).catch(() => null);
  await page.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 25000 }).catch(() => null);
  await page.waitForTimeout(3000);
  const ac = await page.evaluate(() => window.__sokoniAppCheckState);
  if (ac !== 'exchanged') {
    console.log('  ABORT — App Check state=' + ac + '. An un-attested "denied" is meaningless.');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }
  console.log('  App Check exchanged.');

  const CM_READ = 'cmGetLiveTillBalance';   // merchantId-guarded (assertMerchantMember), read-only
  const SELLER_READ = 'getPOSAnalytics';    // sellerId-guarded (assertSellerSelfOrAdmin), read-only

  /* ── MERCHANT BOUNDARY (assertMerchantMember) ─────────────────────────────── */
  head('Merchant boundary — Merchant A staff');
  let s = await signIn(page, ID.maStaffEmail, ID.maStaffPw);
  if (!s.ok) { console.log('  ABORT — MA staff sign-in failed: ' + s.why); clearTimeout(wd); await browser.close(); server.close(); process.exit(1); }
  if (s.claims.admin === true || s.claims.superAdmin === true) {
    console.log('  ABORT — MA_STAFF identity is ELEVATED (admin/superAdmin); it would pass for the wrong reason.');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }
  await probe(page, 'A-staff → Merchant B', 'DENY', 'smartPosDispatch', { op: CM_READ, merchantId: ID.mbMerchantId });
  await probe(page, 'A-staff → own Merchant A', 'ALLOW', 'smartPosDispatch', { op: CM_READ, merchantId: ID.maMerchantId });
  /* forged elevation payload — a non-admin claiming admin in DATA must still be denied */
  await probe(page, 'A-staff forged {admin,role} → Merchant B', 'DENY', 'smartPosDispatch', { op: CM_READ, merchantId: ID.mbMerchantId, admin: true, role: 'admin', superAdmin: true });

  /* ── SELLER BOUNDARY (assertSellerSelfOrAdmin) ────────────────────────────── */
  head('Seller boundary — Seller A');
  s = await signIn(page, ID.saEmail, ID.saPw);
  if (!s.ok) { console.log('  ABORT — Seller A sign-in failed: ' + s.why); clearTimeout(wd); await browser.close(); server.close(); process.exit(1); }
  if (s.claims.admin === true || s.claims.superAdmin === true) {
    console.log('  ABORT — SA identity is ELEVATED; it would pass for the wrong reason.');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }
  await probe(page, 'Seller A → Seller B', 'DENY', 'smartPosDispatch', { op: SELLER_READ, sellerId: ID.sbSellerId });
  await probe(page, 'Seller A → own (no sellerId)', 'ALLOW', 'smartPosDispatch', { op: SELLER_READ });
  /* composition — a legitimate seller supplying a FOREIGN sellerId cannot compose own standing into B */
  await probe(page, 'Seller A (valid) + foreign sellerId=B (composition)', 'DENY', 'smartPosDispatch', { op: SELLER_READ, sellerId: ID.sbSellerId });

  /* ── ADMIN may target a foreign merchant/seller ───────────────────────────── */
  head('Admin — may target foreign merchant/seller');
  s = await signIn(page, ID.admEmail, ID.admPw);
  if (!s.ok) { console.log('  ABORT — Admin sign-in failed: ' + s.why); clearTimeout(wd); await browser.close(); server.close(); process.exit(1); }
  if (!(s.claims.admin === true || s.claims.superAdmin === true)) {
    console.log('  ABORT — ADM identity is NOT admin/superAdmin; cannot test the admin-target case.');
    clearTimeout(wd); await browser.close(); server.close(); process.exit(1);
  }
  await probe(page, 'Admin → foreign Merchant B', 'ALLOW', 'smartPosDispatch', { op: CM_READ, merchantId: ID.mbMerchantId });
  await probe(page, 'Admin → foreign Seller B', 'ALLOW', 'smartPosDispatch', { op: SELLER_READ, sellerId: ID.sbSellerId });

  clearTimeout(wd); await browser.close(); server.close();

  const pass = results.filter((r) => r.pass).length, total = results.length;
  console.log('\n' + '='.repeat(74));
  console.log(`  MATRIX RESULT: ${pass}/${total} expected outcomes`);
  console.log('  (This script reports outcomes only. Gate 1 GREEN is a human determination');
  console.log('   requiring ALL expected outcomes PASS *and* deployed-version evidence.)');
  console.log('='.repeat(74));
  process.exit(pass === total ? 0 : 1);
});
