'use strict';
/**
 * scripts/verify-provider-selfpublish-rule.js
 *
 * Proves — against LIVE production — that a signed-in user cannot publish
 * themselves as an active provider.
 *
 *   node scripts/verify-provider-selfpublish-rule.js
 *
 * WHY THIS EXISTS
 * `firebase deploy` exiting 0 means the rules were accepted, not that they
 * enforce what was intended. Readiness is an observed operational state, not a
 * successful deploy command.
 *
 * WHY IT NEEDS AN APP CHECK TOKEN — READ BEFORE EDITING
 * Firestore has App Check set to ENFORCED on this project. A REST request
 * carrying only a Firebase ID token is rejected with
 * 403 PERMISSION_DENIED *before security rules are evaluated at all*.
 *
 * The first version of this script did exactly that, and reported
 *
 *     create status:"active"  → HTTP 403  DENIED (correct)
 *
 * which was a FALSE PASS: the write was blocked by App Check, not by the rule
 * under test. The giveaway was the very next assertion — a `pending` create,
 * which the rule permits, was denied too, and so was a bare `{uid}` document.
 * When every case fails identically, nothing has been tested.
 *
 * So this mints a real App Check token first (via a temporary debug token,
 * deleted afterwards — a lingering debug token is itself an App Check bypass)
 * and sends X-Firebase-AppCheck alongside the user's ID token. Only then does
 * a 403 mean "the rule rejected this".
 *
 * ASSERTIONS
 *   0. a bare {uid} create is ALLOWED        → control: rules are being reached
 *   1. create with status:'active'  DENIED
 *   2. create with status:'pending' ALLOWED
 *   3. update own record to 'active' DENIED
 *   4. the pending record is absent from the public active listing
 *
 * Assertion 0 is what makes the rest meaningful. Without a control that must
 * succeed, a blanket denial reads as a pass.
 *
 * CLEANUP
 * Firestore document, Auth user and App Check debug token are removed on every
 * exit path, including failure, and removal is confirmed rather than assumed.
 */

const https = require('https');
const { execSync } = require('child_process');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
/* Public client key and app id — both shipped in firebase.js. Not secrets. */
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const APP_ID  = process.env.FIREBASE_APP_ID  || '1:24799054989:web:e1cf6ca8c281bf1abf26c4';
const FS_HOST = 'firestore.googleapis.com';
const AC_HOST = 'firebaseappcheck.googleapis.com';
const IT_HOST = 'identitytoolkit.googleapis.com';
const BASE    = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _adminTok = null;
function adminToken() {
  if (_adminTok) return _adminTok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_adminTok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _adminTok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _adminTok;
}

function req(method, host, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host, path, method, headers: h }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const S = v => ({ stringValue: String(v) });
const admin = () => ({ Authorization: 'Bearer ' + adminToken(), 'x-goog-user-project': PROJECT });

(async () => {
  const nonce = process.env.PROBE_NONCE || 'a1b2c3d4';
  const email = 'rule-probe-' + nonce + '@sokoni-probe.invalid';
  const pass  = 'Pr0be-' + nonce + '-Xq77';
  const DEBUG_TOKEN = '11111111-2222-4333-8444-555555555555';

  let uid = null, dbgName = null;
  const results = [];
  const check = (label, ok, detail) => {
    results.push({ label, ok });
    console.log('  ' + (ok ? 'PASS' : '** FAIL **').padEnd(11) + label + '   ' + (detail || ''));
  };

  try {
    console.log('\n  PROVIDER SELF-PUBLISH RULE — live check   project ' + PROJECT + '\n');

    /* ── App Check token (Firestore enforcement is ON) ───────────────────── */
    const created = await req('POST', AC_HOST,
      '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) + '/debugTokens',
      { displayName: 'tmp-selfpublish-verify', token: DEBUG_TOKEN }, admin());
    if (created.status >= 400) {
      console.error('  Could not create an App Check debug token: HTTP ' + created.status +
                    ' ' + created.body.slice(0, 200));
      console.error('  Without one, every write is denied by App Check and nothing is tested.\n');
      process.exit(2);
    }
    dbgName = JSON.parse(created.body).name;
    const ex = await req('POST', AC_HOST,
      '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) +
      ':exchangeDebugToken?key=' + API_KEY, { debugToken: DEBUG_TOKEN });
    if (ex.status >= 400) {
      console.error('  exchangeDebugToken failed: HTTP ' + ex.status + ' ' + ex.body.slice(0, 200) + '\n');
      process.exit(2);
    }
    const appCheckToken = JSON.parse(ex.body).token;

    /* ── Throwaway signed-in user ────────────────────────────────────────── */
    let up = await req('POST', IT_HOST, '/v1/accounts:signUp?key=' + API_KEY,
      { email, password: pass, returnSecureToken: true });
    if (up.status >= 400) {
      up = await req('POST', IT_HOST, '/v1/accounts:signInWithPassword?key=' + API_KEY,
        { email, password: pass, returnSecureToken: true });
    }
    if (up.status >= 400) {
      console.error('  Could not obtain a probe account: ' + up.status + ' ' + up.body.slice(0, 200) + '\n');
      process.exit(2);
    }
    const acct = JSON.parse(up.body);
    uid = acct.localId;
    const asUser = { Authorization: 'Bearer ' + acct.idToken, 'X-Firebase-AppCheck': appCheckToken };
    console.log('  probe uid ' + uid + '   (App Check token attached)\n');

    const docPath   = BASE + '/providers/' + uid;
    const createUrl = BASE + '/providers?documentId=' + uid;
    /* Deletes go through the ADMIN token: `allow delete: if isAdmin()` means a
       provider cannot remove their own record, so a user-token delete silently
       leaves the document behind and the next create returns 409 ALREADY_EXISTS
       — which is not a permission verdict and would be misread as one. */
    const rm = () => req('DELETE', FS_HOST, docPath, null, admin());

    /* ── 0. CONTROL — rules must actually be reachable ───────────────────── */
    const r0 = await req('POST', FS_HOST, createUrl, { fields: { uid: S(uid) } }, asUser);
    const ctrlOk = r0.status < 400;
    check('control: bare {uid} create is allowed', ctrlOk, 'HTTP ' + r0.status);
    if (!ctrlOk) {
      console.error('\n  Rules are not being reached — every write is being rejected upstream.');
      console.error('  Nothing below would be meaningful, so the run stops here.');
      console.error('  ' + r0.body.replace(/\s+/g, ' ').slice(0, 200) + '\n');
      results.push({ label: 'run aborted: control failed', ok: false });
    } else {
      await rm();

      /* ── 1. status:'active' on create must be denied ───────────────────── */
      const r1 = await req('POST', FS_HOST, createUrl,
        { fields: { uid: S(uid), name: S('Rule Probe'), category: S('cleaning'), status: S('active') } }, asUser);
      check('create status:"active" is DENIED', r1.status === 403, 'HTTP ' + r1.status);
      if (r1.status < 400) await rm();

      /* ── 2. status:'pending' must still work ───────────────────────────── */
      const r2 = await req('POST', FS_HOST, createUrl,
        { fields: { uid: S(uid), name: S('Rule Probe'), category: S('cleaning'), status: S('pending') } }, asUser);
      check('create status:"pending" is ALLOWED', r2.status < 400, 'HTTP ' + r2.status);

      if (r2.status < 400) {
        /* ── 3. self-promotion by update must be denied ──────────────────── */
        const r3 = await req('PATCH', FS_HOST, docPath + '?updateMask.fieldPaths=status',
          { fields: { status: S('active') } }, asUser);
        check('update own record to "active" is DENIED', r3.status === 403, 'HTTP ' + r3.status);

        /* ── 4. pending must not leak into the public active listing ─────── */
        const r4 = await req('POST', FS_HOST, BASE + ':runQuery', {
          structuredQuery: {
            from: [{ collectionId: 'providers' }],
            where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL',
                                    value: { stringValue: 'active' } } },
          },
        }, asUser);
        const leaking = r4.status < 400 && r4.body.indexOf(uid) !== -1;
        check('pending record absent from the active listing', !leaking, 'HTTP ' + r4.status);
      }
    }
  } catch (e) {
    console.error('\n  probe error: ' + e.message);
    results.push({ label: 'probe threw', ok: false });
  } finally {
    console.log('');
    if (uid) {
      const a = admin();
      await req('DELETE', FS_HOST, BASE + '/providers/' + uid, null, a);
      const authDel = await req('POST', IT_HOST,
        '/v1/projects/' + PROJECT + '/accounts:delete', { localId: uid }, a);
      const gone = await req('GET', FS_HOST, BASE + '/providers/' + uid, null, a);
      console.log('  cleanup: provider doc ' + (gone.status === 404 ? 'gone' : '** STILL PRESENT **') +
                  ' · auth user HTTP ' + authDel.status);
    }
    if (dbgName) {
      const d = await req('DELETE', AC_HOST, '/v1/' + dbgName, null, admin());
      console.log('  cleanup: App Check debug token ' +
                  (d.status < 400 ? 'deleted' : '** NOT DELETED (HTTP ' + d.status + ') — REVOKE IT MANUALLY **'));
    }
  }

  const failed = results.filter(r => !r.ok);
  console.log('\n  ' + (failed.length
    ? failed.length + ' of ' + results.length + ' assertions FAILED'
    : results.length + '/' + results.length + ' assertions passed — self-publish is blocked in production') + '\n');
  process.exit(failed.length ? 1 : 0);
})();
