#!/usr/bin/env node
'use strict';
/* ============================================================================
   getErrorLog reads the REAL failure stream (errorLog), minimised for operators
   ----------------------------------------------------------------------------
   Census 2026-10-01: getErrorLog read `platformErrors` (0 docs, never written) so the
   Operations Center always said "No errors" while 315 real reports sat in `errorLog`.
     A  reads errorLog newest-first within the window; platformErrors is not the source
     B  email masked, URL query/hash stripped (no tokens), context capped; doc id = reference
     C  bounds: hours 1–168, limit 1–200; severity filter; counts by severity; truncated flag
     D  admin-only (non-admin refused)
   node scripts/test-error-log-reader.js
   ============================================================================ */
const path = require('path'), Module = require('module');
const ROOT = path.resolve(__dirname, '..');
const FN = path.join(ROOT, 'functions');
const { makeFakeFirestore } = require('./lib/fake-firestore-txn');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + l); } else { fail++; console.log('  FAIL  ' + l + (d !== undefined ? '  -> ' + JSON.stringify(d).slice(0, 300) : '')); } };

const F = makeFakeFirestore();
const firestoreFn = () => F.db; firestoreFn.FieldValue = F.FieldValue; firestoreFn.Timestamp = F.Timestamp;
const resolveFrom = (r) => Module._resolveFilename(r, { id: path.join(FN, 'x.js'), filename: path.join(FN, 'x.js'), paths: Module._nodeModulePaths(FN) });
const f = resolveFrom('firebase-admin'); require.cache[f] = { id: f, filename: f, loaded: true, exports: { apps: [1], initializeApp() {}, firestore: firestoreFn } };
const OC = require(path.join(FN, 'operations-center.js'));
const X = OC._errorLogInternal;

(async () => {
  console.log('getErrorLog → errorLog\n');
  const now = Date.now();
  const at = (minsAgo) => F.Timestamp.fromMillis(now - minsAgo * 60000);
  await F.db.collection('platformErrors').doc('decoy').set({ recordedAt: at(1), message: 'should never be read' });
  await F.db.collection('errorLog').doc('e1').set({ timestamp: at(5), severity: 'critical', surface: 'auth-android', code: 'crash', message: 'boom', email: 'alice@example.com', uid: 'uA', url: 'https://mysokoni.co.ke/reset-password?t=SECRETTOKEN#x', context: 'x'.repeat(900) });
  await F.db.collection('errorLog').doc('e2').set({ timestamp: at(30), severity: 'error', surface: 'checkout', message: 'pay failed', anonymous: true });
  await F.db.collection('errorLog').doc('e3').set({ timestamp: at(60 * 30), severity: 'warning', surface: 'old', message: 'outside 24h' });

  const r = await X._readErrorLog(F.db, {});
  ck('A1 reads errorLog (default 24h) newest first; platformErrors decoy absent', r.source === 'errorLog' && r.count === 2 && r.errors[0].id === 'e1' && r.errors[1].id === 'e2' && !JSON.stringify(r).includes('should never be read'), r.errors.map((e) => e.id));
  const e1 = r.errors[0];
  ck('B1 email masked (al***@example.com), not plaintext', e1.email === 'al***@example.com' && !JSON.stringify(r).includes('alice@example.com'), e1.email);
  ck('B2 URL query and hash stripped — a reset token never reaches the operator view', e1.url === 'https://mysokoni.co.ke/reset-password' && !JSON.stringify(r).includes('SECRETTOKEN'), e1.url);
  ck('B3 context capped at 500 chars; doc id returned as the reference id', e1.context.length === 500 && e1.id === 'e1');
  ck('C1 counts by severity', r.bySeverity.critical === 1 && r.bySeverity.error === 1, r.bySeverity);
  const r7 = await X._readErrorLog(F.db, { hours: 9999 });
  ck('C2 hours capped at 168 (7 days) — the 30h-old row appears, nothing unbounded', r7.count === 3, r7.count);
  const rl = await X._readErrorLog(F.db, { hours: 168, limit: 1 });
  ck('C3 limit respected and truncation reported', rl.count === 1 && rl.truncated === true, { count: rl.count, truncated: rl.truncated });
  const rs = await X._readErrorLog(F.db, { hours: 168, severity: 'critical' });
  ck('C4 severity filter', rs.count === 1 && rs.errors[0].severity === 'critical');
  const rbad = await X._readErrorLog(F.db, { hours: 'abc', limit: -5, severity: '<script>' });
  ck('C5 junk parameters fall back to safe defaults', rbad.count === 2, rbad.count);
  let denied = null; try { X._adminRequired({ auth: { uid: 'u', token: {} } }); } catch (e) { denied = e.code; }
  let anon = null; try { X._adminRequired({ auth: null }); } catch (e) { anon = e.code; }
  let ok = true; try { X._adminRequired({ auth: { uid: 'a', token: { admin: true } } }); } catch (e) { ok = false; }
  ck('D1 non-admin and anonymous refused; admin allowed', denied === 'permission-denied' && anon === 'permission-denied' && ok, { denied, anon, ok });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('  CRASH', e); process.exit(2); });
