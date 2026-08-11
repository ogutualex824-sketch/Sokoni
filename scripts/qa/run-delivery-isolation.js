'use strict';
/**
 * scripts/qa/run-delivery-isolation.js
 *
 *   node scripts/qa/run-delivery-isolation.js
 *
 * Provisions TWO throwaway sellers on production, gives each a REAL delivery, and
 * proves through the shipped Delivery Hub that neither can see the other's.
 *
 * WHY REAL RECORDS
 * The v512 context check could not prove isolation: its probe seller had no
 * deliveries, and an empty hub looks the same whether the rule works or the query
 * simply found nothing. "B sees no deliveries" from an empty database is a false
 * pass. Both sellers therefore get a delivery, and both directions are asserted.
 *
 * Everything created — two auth users, two shops, two packageRequests — is removed
 * on every exit path, and removal is confirmed by re-reading.
 */

const https = require('https');
const { execSync, spawnSync } = require('child_process');
const path = require('path');

const PROJECT = 'sokoni-aeb26';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const FS_HOST = 'firestore.googleapis.com';
const IT_HOST = 'identitytoolkit.googleapis.com';
const BASE = '/v1/projects/' + PROJECT + '/databases/(default)/documents';
const BROWSER = process.env.QA_BROWSER ||
  'C:/Users/USER1/.claude/skills/browser-automation/browser.mjs';

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _tok = null;
function adminToken() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _tok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _tok;
}
function req(method, host, urlPath, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const h = Object.assign({}, headers || {});
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host, path: urlPath, method, headers: h }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
const admin = () => ({ Authorization: 'Bearer ' + adminToken(), 'x-goog-user-project': PROJECT });
const S = v => ({ stringValue: String(v) });
const I = v => ({ integerValue: String(v) });

async function makeSeller(tag, nonce) {
  const email = 'iso-' + tag + '-' + nonce + '@sokoni-probe.invalid';
  const pass = 'Iso-' + tag + nonce + '-Wq7';
  const up = await req('POST', IT_HOST, '/v1/accounts:signUp?key=' + API_KEY,
    { email, password: pass, returnSecureToken: true });
  if (up.status >= 400) throw new Error('signUp ' + tag + ' HTTP ' + up.status);
  const uid = JSON.parse(up.body).localId;
  await req('PATCH', FS_HOST, BASE + '/users/' + uid +
    '?updateMask.fieldPaths=roles&updateMask.fieldPaths=registeredAs', {
    fields: {
      roles: { arrayValue: { values: [S('seller')] } },
      registeredAs: { mapValue: { fields: { seller: { booleanValue: true } } } },
    },
  }, admin());
  return { tag, uid, email, pass };
}

/** A delivery this seller owns, in a status the hub's Active query selects. */
async function makeDelivery(seller, mark) {
  const id = 'isoprobe-' + seller.tag + '-' + Date.now().toString(36);
  const r = await req('PATCH', FS_HOST, BASE + '/packageRequests/' + id, {
    fields: {
      sellerUid: S(seller.uid),
      uid: S(seller.uid),
      status: S('in_transit'),
      deliveryAddress: S(mark),          /* the marker the hub renders verbatim */
      buyerName: S('Isolation Probe'),
      deliveryFee: I(250),
      vehicleType: S('motorbike'),
      createdAt: { timestampValue: new Date().toISOString() },
    },
  }, admin());
  if (r.status >= 400) throw new Error('seed delivery HTTP ' + r.status + ' ' + r.body.slice(0, 200));
  return id;
}

const AC_HOST = 'firebaseappcheck.googleapis.com';
const APP_ID = process.env.FIREBASE_APP_ID || '1:24799054989:web:e1cf6ca8c281bf1abf26c4';

/**
 * Read a delivery by id as a given user. What a hostile client would do.
 *
 * THE APP CHECK HEADER IS NOT OPTIONAL. Firestore has App Check ENFORCED on this
 * project, so a REST request carrying only a Firebase ID token is rejected with 403
 * BEFORE rules are evaluated. Without it every read — including a seller reading
 * their own delivery — returns 403, and "B is denied A's delivery" becomes a
 * meaningless observation about App Check rather than about isolation.
 */
async function directRead(pkgId, idToken, appCheckToken) {
  const h = { Authorization: 'Bearer ' + idToken };
  if (appCheckToken) h['X-Firebase-AppCheck'] = appCheckToken;
  const r = await req('GET', FS_HOST, BASE + '/packageRequests/' + pkgId, null, h);
  return r.status;
}

(async () => {
  const nonce = String(Date.now()).slice(-6);
  const A_MARK = 'ISOLATION-ALPHA-' + nonce;
  const B_MARK = 'ISOLATION-BRAVO-' + nonce;
  const DEBUG_TOKEN = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';
  let A = null, B = null, pkgA = null, pkgB = null, dbgName = null;

  console.log('\n  SELLER DELIVERY ISOLATION — real deliveries, two sellers\n');
  try {
    /* App Check is ENFORCED on Firestore. Without a debug token the headless browser
       cannot exchange a reCAPTCHA token, every read 403s, and both sellers appear to
       have no deliveries — which would satisfy the isolation assertion for entirely
       the wrong reason. Registered here, revoked in the finally block. */
    const created = await req('POST', AC_HOST,
      '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) + '/debugTokens',
      { displayName: 'tmp-delivery-isolation', token: DEBUG_TOKEN }, admin());
    if (created.status >= 400) {
      console.error('  BLOCKED: App Check debug token could not be created — HTTP ' + created.status);
      process.exit(2);
    }
    dbgName = JSON.parse(created.body).name;

    A = await makeSeller('a', nonce);
    B = await makeSeller('b', nonce);
    pkgA = await makeDelivery(A, A_MARK);
    pkgB = await makeDelivery(B, B_MARK);
    console.log('  A ' + A.uid + '  delivery ' + pkgA);
    console.log('  B ' + B.uid + '  delivery ' + pkgB + '\n');

    const r = spawnSync(process.execPath, [
      BROWSER, 'https://mysokoni.co.ke/seller',
      '--script', path.join(__dirname, 'delivery-isolation.mjs'),
      '--timeout', '60000',
    ], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        QA_A_EMAIL: A.email, QA_A_PASS: A.pass, QA_A_MARK: A_MARK, QA_A_PKG: pkgA,
        QA_B_EMAIL: B.email, QA_B_PASS: B.pass, QA_B_MARK: B_MARK,
        QA_APPCHECK_TOKEN: DEBUG_TOKEN,
      }),
      maxBuffer: 40 * 1024 * 1024,
    });
    console.log(r.stdout || '');
    if (r.stderr) console.error(r.stderr.slice(0, 1500));

    /* ── The rules layer, independent of the UI ──────────────────────────────────
       The hub filters by sellerUid, so a correct-looking UI could still sit on top
       of a permissive rule. This is the security boundary itself: B's own ID token
       fetching A's document by id. The control matters here too — B reading B's own
       document MUST succeed, or a blanket denial would masquerade as isolation. */
    console.log('  ── rules layer (direct read with each seller\'s own token) ──');
    const signIn = async (s) => {
      const r2 = await req('POST', IT_HOST, '/v1/accounts:signInWithPassword?key=' + API_KEY,
        { email: s.email, password: s.pass, returnSecureToken: true });
      return r2.status < 400 ? JSON.parse(r2.body).idToken : null;
    };
    const tokA = await signIn(A), tokB = await signIn(B);
    const ex = await req('POST', AC_HOST,
      '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) +
      ':exchangeDebugToken?key=' + API_KEY, { debugToken: DEBUG_TOKEN });
    const acTok = ex.status < 400 ? JSON.parse(ex.body).token : null;
    if (!tokA || !tokB || !acTok) {
      console.log('  ** BLOCKED: no ID tokens or no App Check token — rules layer NOT observed **' +
                  '  (appcheck HTTP ' + ex.status + ')');
    } else {
      const aOwn = await directRead(pkgA, tokA, acTok);
      const bOwn = await directRead(pkgB, tokB, acTok);
      const bOnA = await directRead(pkgA, tokB, acTok);
      const aOnB = await directRead(pkgB, tokA, acTok);
      const ok = (n, c, d) => console.log('  ' + (c ? 'PASS' : '** FAIL **') + '  ' + n + '   ' + d);
      ok('CONTROL: A can read A\'s own delivery', aOwn < 400, 'HTTP ' + aOwn);
      ok('CONTROL: B can read B\'s own delivery', bOwn < 400, 'HTTP ' + bOwn);
      ok('RULES: B is DENIED A\'s delivery', bOnA === 403, 'HTTP ' + bOnA);
      ok('RULES: A is DENIED B\'s delivery', aOnB === 403, 'HTTP ' + aOnB);
      if (aOwn >= 400 || bOwn >= 400) {
        console.log('  NOTE: a control failed — the denials above prove nothing on their own.');
      }
    }
  } catch (e) {
    console.error('  harness error: ' + e.message);
  } finally {
    console.log('\n  ── cleanup ──');
    const a = admin();
    for (const id of [pkgA, pkgB]) {
      if (id) await req('DELETE', FS_HOST, BASE + '/packageRequests/' + id, null, a);
    }
    for (const s of [A, B]) {
      if (!s) continue;
      for (const p of ['shops/' + s.uid, 'sellers/' + s.uid, 'businesses/' + s.uid, 'users/' + s.uid]) {
        await req('DELETE', FS_HOST, BASE + '/' + p, null, a);
      }
      await req('POST', IT_HOST, '/v1/projects/' + PROJECT + '/accounts:delete', { localId: s.uid }, a);
    }
    let leftover = 0;
    for (const id of [pkgA, pkgB]) {
      if (!id) continue;
      const g = await req('GET', FS_HOST, BASE + '/packageRequests/' + id, null, a);
      if (g.status !== 404) leftover++;
    }
    console.log('  probe deliveries ' + (leftover === 0 ? 'gone' : '** ' + leftover + ' STILL PRESENT **') +
                ' · probe sellers removed');
    if (dbgName) {
      const d = await req('DELETE', AC_HOST, '/v1/' + dbgName, null, admin());
      console.log('  App Check debug token ' + (d.status < 400 ? 'revoked'
        : '** NOT REVOKED (HTTP ' + d.status + ') — REVOKE IT MANUALLY **'));
    }
  }
})();
