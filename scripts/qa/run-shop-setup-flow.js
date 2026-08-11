'use strict';
/**
 * scripts/qa/run-shop-setup-flow.js
 *
 *   node scripts/qa/run-shop-setup-flow.js
 *
 * Provisions a throwaway seller on PRODUCTION, drives the real Shop Setup →
 * Preview Store flow in a real browser, and removes everything it created.
 *
 * WHY A DEVICE FLOW AND NOT ANOTHER EMULATOR TEST
 * The server path is already proven against production by verify-kasshop-live.js,
 * and the device still misbehaves. Emulator and mocked-callable suites cannot see
 * that gap by construction — they replace the very layer under suspicion. So the
 * acceptance test is a browser, signed in, walking the same steps a seller does.
 *
 * It reports WHICH stage loses the value rather than a pass/fail, because save,
 * hydration and preview each need a different fix.
 *
 * CLEANUP is unconditional: shop, private subdoc, handle reservation, seller
 * mirror docs and the auth user, with removal confirmed by re-reading.
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

(async () => {
  const nonce = process.env.PROBE_NONCE || String(Date.now()).slice(-6);
  const email = 'shopflow-' + nonce + '@sokoni-probe.invalid';
  const pass  = 'Fl0w-' + nonce + '-Qz84';
  const SHOP_NAME = 'KASS TEST 8472';
  const SHOP_DESC = 'PREMIUM TEST 8472';

  let uid = null;
  console.log('\n  SHOP SETUP → PREVIEW STORE — device flow on production\n');

  try {
    let up = await req('POST', IT_HOST, '/v1/accounts:signUp?key=' + API_KEY,
      { email, password: pass, returnSecureToken: true });
    if (up.status >= 400) {
      up = await req('POST', IT_HOST, '/v1/accounts:signInWithPassword?key=' + API_KEY,
        { email, password: pass, returnSecureToken: true });
    }
    if (up.status >= 400) {
      console.error('  BLOCKED: could not create a probe seller — HTTP ' + up.status);
      process.exit(2);
    }
    const acct = JSON.parse(up.body);
    uid = acct.localId;
    console.log('  probe seller ' + uid + '  (' + email + ')\n');

    /* The seller must look like a seller to the dashboard, or Shop Setup may not
       be the surface that renders. This mirrors what onboarding writes. */
    await req('PATCH', FS_HOST, BASE + '/users/' + uid +
      '?updateMask.fieldPaths=roles&updateMask.fieldPaths=registeredAs', {
      fields: {
        roles: { arrayValue: { values: [{ stringValue: 'seller' }] } },
        registeredAs: { mapValue: { fields: { seller: { booleanValue: true } } } },
      },
    }, admin());

    const r = spawnSync(process.execPath, [
      BROWSER, 'https://mysokoni.co.ke/seller',
      '--script', path.join(__dirname, 'shop-setup-preview-flow.mjs'),
      '--timeout', '60000',
    ], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, {
        QA_EMAIL: email, QA_PASS: pass, QA_UID: uid,
        QA_SHOP_NAME: SHOP_NAME, QA_SHOP_DESC: SHOP_DESC,
      }),
      maxBuffer: 40 * 1024 * 1024,
    });
    console.log(r.stdout || '');
    if (r.stderr) console.error(r.stderr.slice(0, 2000));
  } catch (e) {
    console.error('  harness error: ' + e.message);
  } finally {
    console.log('\n  ── cleanup ──');
    const a = admin();
    if (uid) {
      /* The shop id is the uid by construction, but resolve by ownership too so a
         differently-keyed shop is not orphaned on production. */
      const owned = await req('POST', FS_HOST, BASE + ':runQuery', {
        structuredQuery: {
          from: [{ collectionId: 'shops' }],
          where: { fieldFilter: { field: { fieldPath: 'sellerUid' }, op: 'EQUAL', value: { stringValue: uid } } },
        },
      }, a);
      const ids = [...new Set(
        (owned.body.match(/"name"\s*:\s*"[^"]*\/shops\/([^"/]+)"/g) || [])
          .map(s => s.replace(/.*\/shops\//, '').replace(/"$/, ''))
          .concat([uid])
      )];
      for (const id of ids) {
        await req('DELETE', FS_HOST, BASE + '/shops/' + id + '/private/compliance', null, a);
        await req('DELETE', FS_HOST, BASE + '/shops/' + id, null, a);
        await req('DELETE', FS_HOST, BASE + '/minishopConfig/' + id, null, a);
      }
      /* Handle reservations are keyed by handle, not uid — find any that point here. */
      const handles = await req('POST', FS_HOST, BASE + ':runQuery', {
        structuredQuery: {
          from: [{ collectionId: 'shopHandles' }],
          where: { fieldFilter: { field: { fieldPath: 'uid' }, op: 'EQUAL', value: { stringValue: uid } } },
        },
      }, a);
      for (const m of (handles.body.match(/"name"\s*:\s*"[^"]*\/shopHandles\/([^"/]+)"/g) || [])) {
        const h = m.replace(/.*\/shopHandles\//, '').replace(/"$/, '');
        await req('DELETE', FS_HOST, BASE + '/shopHandles/' + h, null, a);
      }
      for (const p of ['sellers/' + uid, 'businesses/' + uid, 'providerAvailability/' + uid, 'users/' + uid]) {
        await req('DELETE', FS_HOST, BASE + '/' + p, null, a);
      }
      const del = await req('POST', IT_HOST, '/v1/projects/' + PROJECT + '/accounts:delete', { localId: uid }, a);
      const gone = await req('GET', FS_HOST, BASE + '/shops/' + uid, null, a);
      console.log('  probe shop ' + (gone.status === 404 ? 'gone' : '** STILL PRESENT — REMOVE MANUALLY **') +
                  ' · auth user HTTP ' + del.status);
    }
  }
})();
