'use strict';
/**
 * scripts/verify-kasshop-live.js
 *
 * Proves — against LIVE production — that a seller's KassShop actually persists,
 * that the SAME shop comes back after a reload, that buyer surfaces can find it,
 * and that flipping availability writes to the canonical shop and nowhere else.
 *
 *   node scripts/verify-kasshop-live.js
 *
 * WHY THIS EXISTS
 * `test-kasshop-boundary.js` runs the callables against the Firestore EMULATOR and
 * `test-shop-setup-hydration.js` runs the browser half against a MOCKED callable.
 * Both pass. Neither one proves that the deployed function, the deployed rules and
 * the real database agree — which is the only claim that matters after a deploy.
 *
 * WHAT "SAVED" HAS TO MEAN
 * Not "the call returned success". A field is only saved if it comes BACK on a
 * fresh read, from the canonical document, under the same shop id. So every
 * assertion below re-reads through `getShopProfile` rather than trusting the
 * write's own response.
 *
 * THE FIELD SET IS THE FORM'S, NOT THE FUNCTION'S — READ BEFORE EDITING
 * It is trivially easy to make this file green: send exactly the fields the
 * server whitelists and assert those come back. That tests nothing a unit test
 * doesn't. So the probe sends every field Shop Details COLLECTS from the seller
 * and reports each one's round-trip individually. Fields the seller fills in and
 * the canonical boundary drops are a real defect in the seller's eyes, and they
 * are recorded as failures here, not quietly excluded from the sample.
 *
 * PRODUCTION SAFETY
 * `saveShopProfile` creates shops with status:'active' + isVisible:true, so the
 * probe shop IS buyer-visible while it exists. It is named so no human mistakes
 * it for real, it holds no products, it lives for seconds, and it is deleted on
 * every exit path — including failure — with deletion CONFIRMED, not assumed.
 *
 * ASSERTIONS
 *   0. control — a brand-new uid reports exists:false      (callable reachable)
 *   1. first save creates the shop
 *   2. the shop id is the owner's uid, and sellerUid is the owner
 *   3. every field the form collects survives a fresh read
 *   4. the reloaded shop id is the SAME id
 *   5. a second save UPDATES — it does not mint a second shop
 *   6. buyer surfaces can find it (shops/{sellerUid} — the path product.js uses)
 *   7. availability writes to the canonical shop
 *   8. …and to NOTHING else (no phantom sellers/businesses/provider docs)
 *   9. the effective state a buyer sees reflects the flip
 *  10. Preview Store resolves to THIS shop
 */

const https = require('https');
const { execSync } = require('child_process');
const { Gate } = require('./lib/gate-result');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
/* Public client key and app id — both shipped in firebase.js. Not secrets. */
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const APP_ID  = process.env.FIREBASE_APP_ID  || '1:24799054989:web:e1cf6ca8c281bf1abf26c4';
const FS_HOST = 'firestore.googleapis.com';
const AC_HOST = 'firebaseappcheck.googleapis.com';
const IT_HOST = 'identitytoolkit.googleapis.com';
const FN_HOST = 'us-central1-' + PROJECT + '.cloudfunctions.net';
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

const admin = () => ({ Authorization: 'Bearer ' + adminToken(), 'x-goog-user-project': PROJECT });

/** Call a deployed onCall function the way the browser SDK does. */
async function callable(name, payload, userHeaders) {
  const r = await req('POST', FN_HOST, '/' + name, { data: payload || {} }, userHeaders);
  let parsed = null;
  try { parsed = JSON.parse(r.body); } catch (_) { /* non-JSON body kept as text below */ }
  return {
    status: r.status,
    result: parsed && parsed.result,
    error: (parsed && parsed.error) || (r.status >= 400 ? { message: r.body.slice(0, 200) } : null),
  };
}

/* The exact values Shop Details collects. Distinct, greppable strings so a value
   that comes back from the wrong field is visible rather than coincidentally equal. */
function probeProfile(nonce) {
  return {
    name:          'ZZ Probe Shop ' + nonce,
    tagline:       'tagline-' + nonce,
    about:         'about-' + nonce,
    category:      'electronics',
    shopType:      'online',
    city:          'nairobi',
    address:       'address-' + nonce,
    mapsLink:      'https://maps.example.com/' + nonce,
    phone:         '+254700000000',
    email:         'probe-' + nonce + '@sokoni-probe.invalid',
    website:       'https://probe-' + nonce + '.invalid',
    instagram:     'ig-' + nonce,
    tiktok:        'tt-' + nonce,
    facebook:      'fb-' + nonce,
    twitter:       'tw-' + nonce,
    youtube:       'yt-' + nonce,
    linkedin:      'li-' + nonce,
    themeColor:    '#71ff00',
    delMethod:     'rider',
    delTime:       '1-2 days',
    returnPolicy:  '7-day',
    returnText:    'returns-' + nonce,
    packagingNote: 'packaging-' + nonce,
    freeDelivery:  'over-2000',
    /* Collected by the form's compliance step. Sent here deliberately: if the
       canonical boundary drops them, the seller loses data they typed. */
    kraPin:        'A' + nonce + 'Z',
    sbpNumber:     'sbp-' + nonce,
    brsNumber:     'brs-' + nonce,
  };
}

(async () => {
  const nonce = process.env.PROBE_NONCE || String(Date.now()).slice(-8);
  const email = 'kasshop-probe-' + nonce + '@sokoni-probe.invalid';
  const pass  = 'Pr0be-' + nonce + '-Kz91';
  const DEBUG_TOKEN = '33333333-4444-4555-8666-777777777777';

  let uid = null, dbgName = null, shopId = null;
  const gate = new Gate({
    name: 'kasshop-persistence-live',
    evidence: 'production-probe',
    environment: 'production',
  });
  const check = (label, ok, detail) => (ok ? gate.pass(label, detail) : gate.fail(label, detail));

  try {
    console.log('\n  KASSSHOP PERSISTENCE — live check   project ' + PROJECT + '\n');

    /* ── App Check token ─────────────────────────────────────────────────── */
    const created = await req('POST', AC_HOST,
      '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) + '/debugTokens',
      { displayName: 'tmp-kasshop-verify', token: DEBUG_TOKEN }, admin());
    if (created.status >= 400) {
      gate.blocked('persistence could not be observed',
        'App Check debug token could not be created: HTTP ' + created.status);
      throw new Error('__setup__');
    }
    dbgName = JSON.parse(created.body).name;
    const ex = await req('POST', AC_HOST,
      '/v1/projects/' + PROJECT + '/apps/' + encodeURIComponent(APP_ID) +
      ':exchangeDebugToken?key=' + API_KEY, { debugToken: DEBUG_TOKEN });
    if (ex.status >= 400) {
      gate.blocked('persistence could not be observed', 'exchangeDebugToken failed: HTTP ' + ex.status);
      throw new Error('__setup__');
    }
    const appCheckToken = JSON.parse(ex.body).token;

    /* ── Throwaway signed-in seller ──────────────────────────────────────── */
    let up = await req('POST', IT_HOST, '/v1/accounts:signUp?key=' + API_KEY,
      { email, password: pass, returnSecureToken: true });
    if (up.status >= 400) {
      up = await req('POST', IT_HOST, '/v1/accounts:signInWithPassword?key=' + API_KEY,
        { email, password: pass, returnSecureToken: true });
    }
    if (up.status >= 400) {
      gate.blocked('persistence could not be observed', 'no signed-in probe account: HTTP ' + up.status);
      throw new Error('__setup__');
    }
    const acct = JSON.parse(up.body);
    uid = acct.localId;
    const asUser = { Authorization: 'Bearer ' + acct.idToken, 'X-Firebase-AppCheck': appCheckToken };
    console.log('  probe uid ' + uid + '   (App Check token attached)\n');

    /* ── 0. CONTROL — the callable is reachable and this uid has no shop ──── */
    const c0 = await callable('getShopProfile', {}, asUser);
    if (c0.status >= 400) {
      /* Without a reachable callable every later assertion would fail for a
         reason that has nothing to do with persistence. Say so instead. */
      gate.blocked('control: a new uid reports exists:false',
        'getShopProfile HTTP ' + c0.status + ' — ' + JSON.stringify(c0.error).slice(0, 160));
      throw new Error('__setup__');
    }
    check('control: a new uid reports exists:false', c0.result && c0.result.exists === false,
      'exists=' + JSON.stringify(c0.result && c0.result.exists));

    /* ── 1. First save creates the shop ──────────────────────────────────── */
    const sent = probeProfile(nonce);
    /* Sent exactly the way seller.html sends it: storefront copy in `profile`,
       regulatory identifiers in `compliance`. */
    const COMPLIANCE_KEYS = ['kraPin', 'sbpNumber', 'brsNumber'];
    const sentCompliance = {};
    const sentProfile = {};
    for (const k of Object.keys(sent)) {
      (COMPLIANCE_KEYS.includes(k) ? sentCompliance : sentProfile)[k] = sent[k];
    }
    const s1 = await callable('saveShopProfile',
      { profile: sentProfile, compliance: sentCompliance }, asUser);
    const savedOk = s1.status < 400 && s1.result && s1.result.success === true && !!s1.result.shopId;
    check('Shop Details saves', savedOk,
      savedOk ? 'created=' + s1.result.created + ' shopId=' + s1.result.shopId
              : 'HTTP ' + s1.status + ' ' + JSON.stringify(s1.error).slice(0, 160));
    if (!savedOk) throw new Error('__setup__');
    shopId = s1.result.shopId;

    /* ── 2. Canonical id + ownership ─────────────────────────────────────── */
    check('the shop id is the owner uid (buyer surfaces key on it)', shopId === uid,
      'shopId=' + shopId + ' uid=' + uid);
    const raw = await req('GET', FS_HOST, BASE + '/shops/' + shopId, null, admin());
    const rawFields = raw.status < 400 ? (JSON.parse(raw.body).fields || {}) : {};
    check('sellerUid on the document is the owner',
      rawFields.sellerUid && rawFields.sellerUid.stringValue === uid,
      'sellerUid=' + (rawFields.sellerUid && rawFields.sellerUid.stringValue));

    /* ── 3 & 4. Reload — the same shop, with every field intact ──────────── */
    const c1 = await callable('getShopProfile', {}, asUser);
    const back = (c1.result && c1.result.profile) || {};
    check('reload returns the SAME shopId', c1.result && c1.result.shopId === shopId,
      'reloaded=' + (c1.result && c1.result.shopId));

    const backComp = (c1.result && c1.result.compliance) || {};
    const kept = [], lost = [];
    for (const key of Object.keys(sent)) {
      const got = COMPLIANCE_KEYS.includes(key) ? backComp[key] : back[key];
      (got === sent[key] ? kept : lost).push(key);
    }
    check('reload preserves every field Shop Details collects', lost.length === 0,
      lost.length ? lost.length + ' of ' + Object.keys(sent).length + ' lost: ' + lost.join(', ')
                  : 'all ' + kept.length + ' fields round-tripped');
    if (lost.length) {
      gate.note('Dropped: ' + lost.join(', ') + '. Collected by Shop Details but not returned ' +
        'by getShopProfile — the seller types them and they do not survive a reload.');
    }

    /* Regulatory identifiers must round-trip WITHOUT becoming public. `shops/{id}` is
       `allow read: if true`, so a passing round-trip that put them there would be a leak
       dressed up as a fix. Both halves are asserted. */
    const leaked = COMPLIANCE_KEYS.filter(k => rawFields[k] !== undefined);
    check('regulatory identifiers are not on the public shop document', leaked.length === 0,
      leaked.length ? 'PUBLICLY READABLE: ' + leaked.join(', ') : 'kraPin/sbpNumber/brsNumber absent');

    /* Where they DID land. Read with the admin token: the point of this assertion is that
       the bytes are on the private subdocument, which is independent of who may read it. */
    const priv = await req('GET', FS_HOST,
      BASE + '/shops/' + shopId + '/private/compliance', null, admin());
    const opf = priv.status < 400 ? (JSON.parse(priv.body).fields || {}) : {};
    check('compliance is stored on the private subdocument',
      COMPLIANCE_KEYS.every(k => opf[k] && opf[k].stringValue === sentCompliance[k]),
      COMPLIANCE_KEYS.map(k => k + '=' + (opf[k] && opf[k].stringValue)).join(' '));

    /* Who may reach it. `shops/{uid}/private/{doc}` currently has NO rule released, so it
       falls through to default-deny — which is stricter than the intended owner-read grant,
       not weaker. The grant is in firestore.rules and lands on the next rules release; until
       then nothing is exposed and nothing is broken, because only the Admin SDK reads it. */
    const ownerPriv = await req('GET', FS_HOST,
      BASE + '/shops/' + shopId + '/private/compliance', null, asUser);
    check('compliance is unreachable by any client (no rule released yet)',
      ownerPriv.status === 403, 'owner direct read HTTP ' + ownerPriv.status);
    if (ownerPriv.status === 403) {
      gate.note('shops/{uid}/private/{doc} is default-denied in the LIVE ruleset: the owner-read ' +
        'grant in firestore.rules has not been released (the rules deploy 409s). Safe — strictly ' +
        'tighter than intended, and getShopProfile serves the data via the Admin SDK regardless.');
    }

    const pubSeller = await req('GET', FS_HOST, BASE + '/sellers/' + uid, null, admin());
    const psf = pubSeller.status < 400 ? (JSON.parse(pubSeller.body).fields || {}) : {};
    const sellerLeak = COMPLIANCE_KEYS.concat(['sbpNum', 'brsNum']).filter(k => psf[k] !== undefined);
    check('regulatory identifiers are not on the public sellers document', sellerLeak.length === 0,
      sellerLeak.length ? 'PUBLICLY READABLE in sellers/' + uid + ': ' + sellerLeak.join(', ')
                        : 'absent (doc ' + (pubSeller.status === 404 ? 'not written by this probe' : 'clean') + ')');

    /* ── 5. A second save updates rather than minting a second shop ──────── */
    const s2 = await callable('saveShopProfile',
      { profile: { about: 'about-edited-' + nonce } }, asUser);
    check('a second save UPDATES the same shop',
      s2.status < 400 && s2.result && s2.result.created === false && s2.result.shopId === shopId,
      'created=' + (s2.result && s2.result.created) + ' shopId=' + (s2.result && s2.result.shopId));

    const dupeQ = await req('POST', FS_HOST, BASE + ':runQuery', {
      structuredQuery: {
        from: [{ collectionId: 'shops' }],
        where: { fieldFilter: { field: { fieldPath: 'sellerUid' }, op: 'EQUAL', value: { stringValue: uid } } },
      },
    }, admin());
    const shopCount = (dupeQ.body.match(/"name"\s*:\s*"projects\//g) || []).length;
    check('exactly one shop exists for this seller', shopCount === 1, 'count=' + shopCount);

    const c2 = await callable('getShopProfile', {}, asUser);
    check('the edit is what comes back on reload',
      c2.result && c2.result.profile && c2.result.profile.about === 'about-edited-' + nonce,
      'about=' + (c2.result && c2.result.profile && c2.result.profile.about));

    /* ── 6. The buyer path — product.js reads shops/{sellerUid} by id ─────── */
    const buyer = await req('GET', FS_HOST, BASE + '/shops/' + uid, null, asUser);
    const bf = buyer.status < 400 ? (JSON.parse(buyer.body).fields || {}) : {};
    check('the public shop can be found at shops/{sellerUid}', buyer.status < 400,
      'HTTP ' + buyer.status);
    check('the found shop is active and visible',
      bf.status && bf.status.stringValue === 'active' &&
      bf.isVisible && bf.isVisible.booleanValue === true,
      'status=' + (bf.status && bf.status.stringValue) +
      ' isVisible=' + (bf.isVisible && bf.isVisible.booleanValue));

    /* ── 7 & 8. Availability lands on the shop, and nowhere else ─────────── */
    const elsewhere = ['sellers/' + uid, 'businesses/' + uid, 'providerAvailability/' + uid,
                       'minishopConfig/' + uid, 'minishopConfig/' + shopId];
    const before = {};
    for (const p of elsewhere) {
      const r = await req('GET', FS_HOST, BASE + '/' + p, null, admin());
      before[p] = r.status;
    }

    const av = await callable('setShopAvailability',
      { availability: { acceptingOrders: false, online: false, delivery: true, pickup: false } }, asUser);
    check('availability writes through the canonical boundary',
      av.status < 400 && av.result && av.result.shopId === shopId,
      av.status < 400 ? 'shopId=' + av.result.shopId
                      : 'HTTP ' + av.status + ' ' + JSON.stringify(av.error).slice(0, 160));

    const afterShop = await req('GET', FS_HOST, BASE + '/shops/' + shopId, null, admin());
    const af = afterShop.status < 400 ? (JSON.parse(afterShop.body).fields || {}) : {};
    check('availability landed on the canonical shop document',
      af.acceptingOrders && af.acceptingOrders.booleanValue === false &&
      af.online && af.online.booleanValue === false &&
      af.delivery && af.delivery.booleanValue === true,
      'acceptingOrders=' + (af.acceptingOrders && af.acceptingOrders.booleanValue) +
      ' online=' + (af.online && af.online.booleanValue) +
      ' delivery=' + (af.delivery && af.delivery.booleanValue));

    const strays = [];
    for (const p of elsewhere) {
      const r = await req('GET', FS_HOST, BASE + '/' + p, null, admin());
      if (before[p] === 404 && r.status < 400) strays.push(p);
    }
    check('availability did not write anywhere else', strays.length === 0,
      strays.length ? 'phantom documents created: ' + strays.join(', ') : 'no stray documents');

    /* ── 9. What the buyer actually sees ─────────────────────────────────── */
    const eff = await callable('getShopAvailability', { shopId }, asUser);
    check('the buyer-visible state reflects the flip',
      eff.status < 400 && eff.result && eff.result.open === false && eff.result.reason === 'offline',
      eff.status < 400 ? 'open=' + eff.result.open + ' reason=' + eff.result.reason
                       : 'HTTP ' + eff.status);

    /* ── 10. Preview Store — does it open THIS shop? ──────────────────────── */
    const mini = await callable('getMyMinishop', {}, asUser);
    const handle = (mini.result && mini.result.handle) || (c2.result && c2.result.handle) || null;
    if (!handle) {
      /* Not a failure: with no handle, goToMyStore() deliberately routes to setup
         rather than guessing a storefront. Recorded so the gap is visible. */
      gate.note('Preview Store: this shop has no minishop handle, so goToMyStore() routes to ' +
        'Shop Setup rather than a storefront. Nothing points at the wrong shop — but a brand-new ' +
        'KassShop has no public URL until a handle is claimed.');
      gate.pass('Preview Store does not open the wrong shop', 'no handle: routes to setup');
    } else {
      const cfg = await req('GET', FS_HOST, BASE + '/minishopConfig/' + shopId, null, admin());
      const cf = cfg.status < 400 ? (JSON.parse(cfg.body).fields || {}) : {};
      check('Preview Store resolves to THIS shop',
        cf.handle && cf.handle.stringValue === handle,
        'handle=' + handle + ' minishopConfig/' + shopId + '.handle=' +
        (cf.handle && cf.handle.stringValue));
    }
  } catch (e) {
    if (e.message !== '__setup__') gate.blocked('probe completed without error', e.message);
  } finally {
    /* Cleanup runs on every path. The probe shop is buyer-visible while it lives,
       so its removal is confirmed by re-reading, never assumed from a 200. */
    console.log('');
    const a = admin();
    if (shopId) {
      /* Deleting a document does NOT delete its subcollections, so the compliance
         subdoc would outlive the probe shop and be missed by the "gone" check. */
      await req('DELETE', FS_HOST, BASE + '/shops/' + shopId + '/private/compliance', null, a);
      await req('DELETE', FS_HOST, BASE + '/shops/' + shopId, null, a);
      await req('DELETE', FS_HOST, BASE + '/minishopConfig/' + shopId, null, a);
    }
    if (uid) {
      for (const p of ['shops/' + uid, 'sellers/' + uid, 'businesses/' + uid,
                       'providerAvailability/' + uid, 'minishopConfig/' + uid, 'users/' + uid]) {
        await req('DELETE', FS_HOST, BASE + '/' + p, null, a);
      }
      const authDel = await req('POST', IT_HOST,
        '/v1/projects/' + PROJECT + '/accounts:delete', { localId: uid }, a);
      const gone = await req('GET', FS_HOST, BASE + '/shops/' + (shopId || uid), null, a);
      console.log('  cleanup: probe shop ' + (gone.status === 404 ? 'gone' : '** STILL PRESENT — DELETE IT MANUALLY **') +
                  ' · auth user HTTP ' + authDel.status);
    }
    if (dbgName) {
      const d = await req('DELETE', AC_HOST, '/v1/' + dbgName, null, admin());
      console.log('  cleanup: App Check debug token ' +
                  (d.status < 400 ? 'deleted' : '** NOT DELETED (HTTP ' + d.status + ') — REVOKE IT MANUALLY **'));
    }
  }

  /* Exit code distinguishes the three outcomes: 0 PASS, 1 FAIL, 2 BLOCKED. */
  process.exit(gate.finish());
})();
