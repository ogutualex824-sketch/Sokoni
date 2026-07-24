'use strict';
/**
 * scripts/audit-provider-onboarding.js
 *
 * READ-ONLY. Writes nothing, ever. There is no --apply flag by design.
 *
 * WHY THIS EXISTS
 * Before any provider-onboarding backfill can be trusted we have to know what
 * is actually in production, not what the page code implies. This script
 * answers three questions with evidence:
 *
 *   1. Does a user with phone +254748346783 exist in Firebase Auth, and does a
 *      matching users/ document exist?  (so we never create a duplicate)
 *   2. What does the `providers` collection actually contain — how many docs,
 *      what statuses, which are orphaned (uid pointing at no Auth user)?
 *   3. Which `users` documents carry a service-category signal but have no
 *      corresponding provider document?  (the bulk-onboarding candidate set)
 *
 * CREDENTIALS
 * Firestore REST + Identity Toolkit REST with the gcloud CLI access token —
 * the same pattern as scripts/seed-health-provider.js, because the Admin SDK's
 * ADC is unusable on this machine (invalid_client). The token is captured to a
 * pipe and never printed; see scripts/_secret.js for why that matters.
 *
 *   node scripts/audit-provider-onboarding.js
 *   node scripts/audit-provider-onboarding.js --json > audit.json
 */

const https = require('https');
const { execSync } = require('child_process');

const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const AS_JSON = process.argv.includes('--json');
const FS_HOST = 'firestore.googleapis.com';
const BASE    = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

const TARGET_PHONE = '+254748346783';

/* gcloud on this machine needs CLOUDSDK_PYTHON pointed at its bundled python
   or it fails with the Microsoft Store "Python was not found" shim. */
const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _tok = null;
function authToken() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  /* stdio pipe, never inherit — the token must not reach a transcript. */
  _tok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _tok;
}

function req(method, host, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign(
      /* identitytoolkit refuses bare ADC without a billing/quota project; the
         header is harmless on the Firestore host so it is set unconditionally. */
      { Authorization: 'Bearer ' + authToken(), 'x-goog-user-project': PROJECT },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    );
    const r = https.request({ host, path, method, headers }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) {
          return reject(new Error(res.statusCode + ' ' + path.split('?')[0] + ' :: ' + out.slice(0, 300)));
        }
        resolve(out ? JSON.parse(out) : {});
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* ── Firestore typed-value decoding ───────────────────────────────── */
function plain(v) {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue'    in v) return v.stringValue;
  if ('integerValue'   in v) return Number(v.integerValue);
  if ('doubleValue'    in v) return v.doubleValue;
  if ('booleanValue'   in v) return v.booleanValue;
  if ('timestampValue' in v) return v.timestampValue;
  if ('nullValue'      in v) return null;
  if ('arrayValue'     in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue'       in v) return decode(v.mapValue.fields || {});
  return null;
}
function decode(fields) {
  const o = {};
  for (const k of Object.keys(fields || {})) o[k] = plain(fields[k]);
  return o;
}
const docId = name => String(name || '').split('/').pop();

/* ── Paged collection scan (runQuery, no filter → needs no index) ──── */
async function scanCollection(col, pageSize) {
  const out = [];
  let pageToken = null;
  const size = pageSize || 300;
  do {
    let path = BASE + '/' + col + '?pageSize=' + size;
    if (pageToken) path += '&pageToken=' + encodeURIComponent(pageToken);
    let page;
    try {
      page = await req('GET', FS_HOST, path);
    } catch (e) {
      return { error: e.message, docs: out };
    }
    (page.documents || []).forEach(d => out.push({ id: docId(d.name), data: decode(d.fields) }));
    pageToken = page.nextPageToken || null;
  } while (pageToken);
  return { docs: out };
}

/* ── Firebase Auth lookup by phone (Identity Toolkit v1) ───────────── */
async function authUserByPhone(phone) {
  try {
    const res = await req('POST', 'identitytoolkit.googleapis.com',
      '/v1/projects/' + PROJECT + '/accounts:lookup', { phoneNumber: [phone] });
    return (res.users && res.users[0]) || null;
  } catch (e) {
    return { _error: e.message };
  }
}

/* Signals that a users/ doc has declared itself a service provider. Kept
   deliberately broad — the audit's job is to surface candidates, not to
   decide. Every hit is reported with the field that triggered it so the
   classification is reviewable rather than trusted. */
const CATEGORY_FIELDS = [
  'serviceCategory', 'providerCategory', 'category', 'professionalType',
  'businessCategory', 'hub', 'serviceType', 'profession',
];

function categorySignal(u) {
  for (const f of CATEGORY_FIELDS) {
    const v = u[f];
    if (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'none') {
      return { field: f, value: v.trim() };
    }
  }
  const reg = u.registeredAs;
  if (reg && typeof reg === 'object') {
    for (const k of Object.keys(reg)) {
      if (reg[k] === true && k !== 'buyer' && k !== 'customer') {
        return { field: 'registeredAs.' + k, value: k };
      }
    }
  }
  if (u.providerProfileId) return { field: 'providerProfileId', value: String(u.providerProfileId) };
  return null;
}

(async () => {
  const report = { project: PROJECT, generatedAt: new Date().toISOString() };

  /* ── 1. The named account ───────────────────────────────────────── */
  const authUser = await authUserByPhone(TARGET_PHONE);
  report.target = { phone: TARGET_PHONE, authUser: null, usersDoc: null, providerDocs: [] };
  if (authUser && !authUser._error) {
    report.target.authUser = {
      uid: authUser.localId,
      phoneNumber: authUser.phoneNumber || null,
      email: authUser.email || null,
      displayName: authUser.displayName || null,
      disabled: !!authUser.disabled,
      createdAt: authUser.createdAt || null,
      lastLoginAt: authUser.lastLoginAt || null,
      providers: (authUser.providerUserInfo || []).map(p => p.providerId),
    };
  } else if (authUser && authUser._error) {
    report.target.authLookupError = authUser._error;
  }

  /* ── 2. providers collection ────────────────────────────────────── */
  const provScan = await scanCollection('providers');
  report.providers = { error: provScan.error || null, total: provScan.docs.length };
  const byStatus = {};
  const provByUid = new Map();
  provScan.docs.forEach(({ id, data }) => {
    const st = data.status == null ? '(unset)' : String(data.status);
    byStatus[st] = (byStatus[st] || 0) + 1;
    if (data.uid) {
      if (!provByUid.has(data.uid)) provByUid.set(data.uid, []);
      provByUid.get(data.uid).push(id);
    }
  });
  report.providers.byStatus = byStatus;
  report.providers.withoutUid = provScan.docs.filter(d => !d.data.uid).map(d => d.id);
  report.providers.duplicateUids = [...provByUid.entries()]
    .filter(([, ids]) => ids.length > 1)
    .map(([uid, ids]) => ({ uid, docIds: ids }));
  report.providers.sampleShape = provScan.docs.slice(0, 5).map(d => ({
    id: d.id, keys: Object.keys(d.data).sort(),
  }));

  /* Any provider doc already tied to the target account */
  if (report.target.authUser) {
    const uid = report.target.authUser.uid;
    report.target.providerDocs = provScan.docs
      .filter(d => d.data.uid === uid)
      .map(d => ({ id: d.id, status: d.data.status, category: d.data.cat || d.data.category }));
  }
  /* Also match on phone, to catch a doc created before the uid was linked */
  const digits = s => String(s || '').replace(/\D/g, '').replace(/^254/, '0');
  const targetDigits = digits(TARGET_PHONE);
  report.target.providerDocsByPhone = provScan.docs
    .filter(d => digits(d.data.phone) === targetDigits)
    .map(d => ({ id: d.id, status: d.data.status, uid: d.data.uid || null }));

  /* ── 3. users collection → onboarding candidates ─────────────────── */
  const userScan = await scanCollection('users');
  report.users = { error: userScan.error || null, total: userScan.docs.length };

  const candidates = [];
  userScan.docs.forEach(({ id, data }) => {
    const sig = categorySignal(data);
    if (!sig) return;
    candidates.push({
      uid: id,
      signal: sig,
      name: data.name || data.displayName || data.fullName || null,
      phone: data.phone || data.phoneNumber || null,
      hasProviderDoc: provByUid.has(id),
      providerDocIds: provByUid.get(id) || [],
    });
  });
  report.candidates = {
    total: candidates.length,
    alreadyHaveProviderDoc: candidates.filter(c => c.hasProviderDoc).length,
    missingProviderDoc: candidates.filter(c => !c.hasProviderDoc).length,
    bySignalField: candidates.reduce((a, c) => {
      a[c.signal.field] = (a[c.signal.field] || 0) + 1; return a;
    }, {}),
    list: candidates,
  };

  /* Provider docs whose uid matches no users/ document — broken references */
  const userIds = new Set(userScan.docs.map(d => d.id));
  report.providers.orphanedUidRefs = [...provByUid.entries()]
    .filter(([uid]) => !userIds.has(uid))
    .map(([uid, ids]) => ({ uid, docIds: ids }));

  if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); return; }

  /* ── Human summary ──────────────────────────────────────────────── */
  const L = console.log;
  L('\n  PROVIDER ONBOARDING AUDIT — READ ONLY   project ' + PROJECT);
  L('  ' + report.generatedAt + '\n');

  L('  1. TARGET ACCOUNT  ' + TARGET_PHONE);
  if (report.target.authLookupError) {
    L('     Auth lookup FAILED: ' + report.target.authLookupError);
  } else if (report.target.authUser) {
    const a = report.target.authUser;
    L('     Auth user FOUND   uid=' + a.uid);
    L('       displayName : ' + (a.displayName || '(none)'));
    L('       disabled    : ' + a.disabled);
    L('       signIn      : ' + a.providers.join(', '));
    L('       lastLogin   : ' + (a.lastLoginAt || '(never)'));
    L('     provider docs by uid   : ' + (report.target.providerDocs.length
        ? JSON.stringify(report.target.providerDocs) : 'NONE'));
    L('     provider docs by phone : ' + (report.target.providerDocsByPhone.length
        ? JSON.stringify(report.target.providerDocsByPhone) : 'NONE'));
  } else {
    L('     Auth user NOT FOUND for this phone number.');
  }

  L('\n  2. providers COLLECTION');
  if (report.providers.error) {
    L('     READ FAILED: ' + report.providers.error);
  } else {
    L('     total docs      : ' + report.providers.total);
    L('     by status       : ' + JSON.stringify(report.providers.byStatus));
    L('     missing uid     : ' + report.providers.withoutUid.length);
    L('     duplicate uids  : ' + report.providers.duplicateUids.length);
    L('     orphaned uids   : ' + report.providers.orphanedUidRefs.length);
    report.providers.sampleShape.forEach(s =>
      L('       ' + s.id + ' → ' + s.keys.join(',')));
  }

  L('\n  3. users COLLECTION → onboarding candidates');
  if (report.users.error) {
    L('     READ FAILED: ' + report.users.error);
  } else {
    L('     total users            : ' + report.users.total);
    L('     with a category signal : ' + report.candidates.total);
    L('       already have provider doc : ' + report.candidates.alreadyHaveProviderDoc);
    L('       missing provider doc      : ' + report.candidates.missingProviderDoc);
    L('     signal breakdown       : ' + JSON.stringify(report.candidates.bySignalField));
  }
  L('\n  Nothing was written. Re-run with --json for the full record.\n');
})().catch(e => {
  console.error('\n  audit failed: ' + e.message);
  console.error('  If this is a credentials error, run:  gcloud auth login\n');
  process.exit(1);
});
