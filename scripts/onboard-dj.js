'use strict';
/**
 * scripts/onboard-dj.js — create a NEW account for a DJ and list them.
 *
 * Unlike scripts/onboard-providers.js (which only ever touched EXISTING
 * accounts), this creates a brand-new Firebase Auth user, on explicit request,
 * because no account for the given email existed. Two honesty constraints:
 *
 *   - A random password is set; the account cannot be signed into until the
 *     owner runs a password reset. It is never printed.
 *   - No real name is invented. The display name is derived from the email
 *     local part, and name/stageName are listed in profilePending for the
 *     owner to correct. verified/featured are false — nothing is fabricated.
 *
 *   node scripts/onboard-dj.js                 # dry run
 *   node scripts/onboard-dj.js --apply
 *   node scripts/onboard-dj.js --apply --email=someone@gmail.com
 */

const https = require('https');
const crypto = require('crypto');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const HOST    = 'firestore.googleapis.com';
const IT_HOST = 'identitytoolkit.googleapis.com';
const BASE    = '/v1/projects/' + PROJECT + '/databases/(default)/documents';
const EMAIL   = (process.argv.find(a => a.startsWith('--email=')) || '').slice(8) || 'Djbvmbxno@gmail.com';

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _tok = null;
function authToken() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _tok = execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _tok;
}

function req(method, host, path, body, useKey) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = useKey
      ? {}
      : { Authorization: 'Bearer ' + authToken(), 'x-goog-user-project': PROJECT };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host, path, method, headers }, (res) => {
      let out = ''; res.on('data', c => out += c);
      res.on('end', () => resolve({ status: res.statusCode, body: out }));
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

const S = v => ({ stringValue: String(v) });
const I = v => ({ integerValue: String(v) });
const B = v => ({ booleanValue: Boolean(v) });
const T = v => ({ timestampValue: v });
const A = a => ({ arrayValue: { values: a.map(S) } });
const M = o => ({ mapValue: { fields: o } });
const plain = v => v && (v.stringValue ?? v.booleanValue ?? (v.integerValue != null ? Number(v.integerValue) : null));

const NOW = new Date().toISOString();
const terms = list => {
  const out = new Set();
  list.filter(Boolean).forEach(s => { const t = String(s).toLowerCase().trim();
    if (t) out.add(t); t.split(/[\s,&/]+/).forEach(w => { if (w.length > 2) out.add(w); }); });
  return [...out];
};

/* Name derived from the email local part — provisional, owner-editable. */
const localPart = EMAIL.split('@')[0];
const displayName = 'DJ ' + localPart.replace(/^dj/i, '').replace(/[._-]+/g, ' ').trim()
  .replace(/\b\w/g, c => c.toUpperCase()) || 'DJ';

async function patch(col, id, fields) {
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return req('PATCH', HOST, BASE + '/' + col + '/' + encodeURIComponent(id) + '?' + mask, { fields });
}

(async () => {
  const L = console.log;
  L('\n  DJ ONBOARDING (new account)   project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN'));
  L('  email ' + EMAIL + '   name "' + displayName + '"\n');

  /* ── Does an account already exist? (never create a duplicate) ─────────── */
  const look = await req('POST', IT_HOST, '/v1/projects/' + PROJECT + '/accounts:lookup',
    { email: [EMAIL] });
  let uid = null;
  const existing = (JSON.parse(look.body).users || [])[0];
  if (existing) { uid = existing.localId; L('  Auth account already exists: uid=' + uid + ' — will reuse, not duplicate.'); }

  if (!APPLY) {
    L('  would ' + (uid ? 'reuse' : 'CREATE') + ' Auth account for ' + EMAIL);
    L('  would write providers/{uid} category=dj, status=active, searchable=true');
    L('  searchableTerms: ' + terms([displayName, 'DJ', 'Disc Jockey', 'Deejay', 'entertainment', 'music', 'events']).join(', '));
    L('\n  DRY RUN — nothing written. Re-run with --apply.\n');
    return;
  }

  /* ── Create the Auth account with a random, unprinted password ─────────── */
  if (!uid) {
    const password = crypto.randomBytes(18).toString('base64') + 'Aa1!';
    const up = await req('POST', IT_HOST, '/v1/accounts:signUp?key=' + API_KEY,
      { email: EMAIL, password, returnSecureToken: true }, true);
    if (up.status >= 400) {
      console.error('  FAILED to create account: HTTP ' + up.status + ' ' + up.body.slice(0, 200));
      process.exit(1);
    }
    uid = JSON.parse(up.body).localId;
    /* set a display name via admin update */
    await req('POST', IT_HOST, '/v1/projects/' + PROJECT + '/accounts:update',
      { localId: uid, displayName });
    L('  created Auth account  uid=' + uid + '  (random password — owner must reset to sign in)');
  }

  const providerId = 'PRV-' + uid.slice(0, 8).toUpperCase();
  const dj = {
    uid: S(uid), providerId: S(providerId),
    name: S(displayName), businessName: S(displayName),
    category: S('dj'), categories: A(['dj', 'entertainment']),
    categoryLabel: S('DJ / Disc Jockey'), serviceType: S('DJ / Disc Jockey'),
    hub: S('services'),
    skills: A(['DJ', 'Disc Jockey', 'Events', 'Parties', 'Music']),
    searchableTerms: A(terms([displayName, 'DJ', 'Disc Jockey', 'Deejay',
                              'entertainment', 'music', 'events', 'parties', 'wedding'])),
    nameLower: S(displayName.toLowerCase()),
    email: S(EMAIL),

    status: S('active'), isActive: B(true), isPublic: B(true),
    searchable: B(true), searchIndexed: B(true), featured: B(false),
    acceptsBookings: B(true), available: B(true), isOnline: B(true),
    verified: B(false),
    chatEnabled: B(true), reviewsEnabled: B(true), ratingsEnabled: B(true),
    analyticsEnabled: B(true), notificationsEnabled: B(true), payoutsEnabled: B(true),

    rating: I(0), reviewCount: I(0), ratingCount: I(0), bookingCount: I(0), jobsCompleted: I(0),

    onboardedBy: S('scripts/onboard-dj.js'), onboardedAt: T(NOW),
    createdAt: T(NOW), updatedAt: T(NOW),
    /* Provisional identity + everything the owner supplies later. */
    profilePending: A(['name', 'stageName', 'photo', 'kycDocuments', 'exactLocation',
                       'bio', 'pricing', 'workingHours', 'genres']),
    profileComplete: B(false), provisionalName: B(true),
  };

  await patch('providers', uid, dj);
  await patch('providerSettings', uid, { uid: S(uid), acceptsBookings: B(true), chatEnabled: B(true),
    reviewsEnabled: B(true), publicProfile: B(true), searchable: B(true), currency: S('KES'), updatedAt: T(NOW) });
  await patch('providerNotifications', uid, { uid: S(uid), sms: B(true), email: B(true), push: B(true), updatedAt: T(NOW) });
  await patch('providerAnalytics', uid, { uid: S(uid), profileViews: I(0), bookingRequests: I(0),
    totalEarnings: I(0), currency: S('KES'), initialisedAt: T(NOW) });
  await patch('wallets', uid, { uid: S(uid), balance: I(0), escrow: I(0), totalIn: I(0), totalOut: I(0),
    currency: S('KES'), frozen: B(false), createdAt: T(NOW), updatedAt: T(NOW) });
  await patch('notificationPrefs', uid, { uid: S(uid), sms: B(true), email: B(true), push: B(true), inApp: B(true), updatedAt: T(NOW) });
  await patch('users', uid, { name: S(displayName), displayName: S(displayName), email: S(EMAIL),
    category: S('dj'), accountType: S('provider'), registeredAs: M({ provider: B(true) }),
    isProvider: B(true), providerProfileId: S(providerId), searchIndexed: B(true),
    status: S('active'), createdAt: T(NOW), updatedAt: T(NOW) });
  L('  wrote providers + settings/notifications/analytics/wallet/prefs + users link');

  const rb = JSON.parse((await req('GET', HOST, BASE + '/providers/' + uid)).body).fields || {};
  const ok = plain(rb.status) === 'active' && plain(rb.searchable) === true;
  L('  verify: name=' + JSON.stringify(plain(rb.name)) + ' category=' + plain(rb.category) +
    ' status=' + plain(rb.status) + ' searchable=' + plain(rb.searchable) +
    (ok ? '  OK — discoverable' : '  ** NOT DISCOVERABLE **'));
  L('  uid=' + uid + '\n  Owner must run a password reset for ' + EMAIL + ' to sign in.\n');
})().catch(e => { console.error('\n  failed: ' + e.message + '\n'); process.exit(1); });
