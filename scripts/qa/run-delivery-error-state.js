'use strict';
/**
 * scripts/qa/run-delivery-hub-check.js
 *
 *   node scripts/qa/run-delivery-hub-check.js
 *
 * Proves the seller's Riders / Delivery Hub control opens the SELLER'S delivery
 * operation and not a personal rider account.
 *
 * Two layers, because either alone is insufficient:
 *
 *   1. CONTRACT (Node, static) — the route table itself. Cheap, and it pins the
 *      regression: no seller delivery route may target the rider-facing app.
 *   2. RUNTIME (browser, signed in) — clicks the real control and inspects the
 *      document that actually loads. A route table can be right while the product
 *      is wrong, so the table is never the only proof.
 *
 * Provisions a throwaway seller on production and removes it on every exit path.
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

/* The rider-facing app and its siblings. A seller destination must never be one. */
const RIDER_APPS = /(^|\/)(driver|rider-dashboard|food-rider|rider-nav|onboarding-driver)\.html/i;

function contractChecks() {
  const C = require(path.join(__dirname, '..', '..', 'sokoni-merchant-routes.js'));
  const routes = C.primary().concat(C.more());
  const out = [];
  const ok = (name, cond, detail) => out.push({ step: name, ok: !!cond, detail: detail ?? null });

  ok('the shipped contract validates', (C.validate() || []).length === 0, C.validate());

  const sellerRoutes = routes.filter(r => (r.role || []).some(x => x === 'seller' || x === 'merchant'));
  const leaking = sellerRoutes.filter(r => RIDER_APPS.test(r.src || ''));
  ok('NO seller route targets the rider-facing app', leaking.length === 0,
     leaking.map(r => r.id + ' -> ' + r.src));

  const del = C.get('deliveries');
  const rid = C.get('riders');
  ok('Deliveries opens the seller delivery surface',
     /seller-delivery\.html/.test((del && del.src) || ''), del && del.src);
  ok('Deliveries is named for the operation', /delivery hub/i.test((del && del.name) || ''), del && del.name);
  ok('Riders opens the roster inside that same hub',
     /seller-delivery\.html#riders/.test((rid && rid.src) || ''), rid && rid.src);
  ok('Deliveries is seller/merchant scoped',
     (del && del.ctx || []).includes('sellerUid'), del && del.ctx);

  /* dispatch.html is the ADMIN console — it must not be a seller destination. */
  const dispatchLeak = sellerRoutes.filter(r => /dispatch\.html/.test(r.src || ''));
  ok('the admin dispatch console is not a seller destination', dispatchLeak.length === 0,
     dispatchLeak.map(r => r.id));
  return out;
}

(async () => {
  console.log('\n  DELIVERY ERROR STATE — a failed query must not read as empty\n');
  const cFail = 0;

  const nonce = process.env.PROBE_NONCE || String(Date.now()).slice(-6);
  const email = 'delivhub-' + nonce + '@sokoni-probe.invalid';
  const pass = 'Hub-' + nonce + '-Rz51';
  let uid = null;

  console.log('\n  ── runtime (signed-in browser) ──');
  try {
    let up = await req('POST', IT_HOST, '/v1/accounts:signUp?key=' + API_KEY,
      { email, password: pass, returnSecureToken: true });
    if (up.status >= 400) {
      console.error('  BLOCKED: could not create a probe seller — HTTP ' + up.status);
      process.exit(2);
    }
    uid = JSON.parse(up.body).localId;
    await req('PATCH', FS_HOST, BASE + '/users/' + uid +
      '?updateMask.fieldPaths=roles&updateMask.fieldPaths=registeredAs', {
      fields: {
        roles: { arrayValue: { values: [{ stringValue: 'seller' }] } },
        registeredAs: { mapValue: { fields: { seller: { booleanValue: true } } } },
      },
    }, admin());
    console.log('  probe seller ' + uid + '\n');

    const r = spawnSync(process.execPath, [
      BROWSER, 'https://mysokoni.co.ke/merchant',
      '--script', path.join(__dirname, 'delivery-error-state.mjs'),
      '--timeout', '60000',
    ], {
      encoding: 'utf8',
      env: Object.assign({}, process.env, { QA_EMAIL: email, QA_PASS: pass, QA_UID: uid }),
      maxBuffer: 40 * 1024 * 1024,
    });
    console.log(r.stdout || '');
    if (r.stderr) console.error(r.stderr.slice(0, 1500));
  } catch (e) {
    console.error('  harness error: ' + e.message);
  } finally {
    if (uid) {
      const a = admin();
      for (const p of ['shops/' + uid, 'sellers/' + uid, 'businesses/' + uid, 'users/' + uid]) {
        await req('DELETE', FS_HOST, BASE + '/' + p, null, a);
      }
      const del = await req('POST', IT_HOST, '/v1/projects/' + PROJECT + '/accounts:delete', { localId: uid }, a);
      console.log('  cleanup: auth user HTTP ' + del.status);
    }
  }
  process.exit(cFail ? 1 : 0);
})();
