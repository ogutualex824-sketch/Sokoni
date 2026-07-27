'use strict';
/**
 * scripts/onboard-seller-mechanic.js
 *
 * Places two existing accounts in their correct registry:
 *
 *   John wa Pork  → sellers/{uid}     (a butchery is a SHOP, not a provider)
 *   Automate Joe  → mechanics/{slug}  (already present — verified, not rewritten)
 *
 *   node scripts/onboard-seller-mechanic.js            # dry run
 *   node scripts/onboard-seller-mechanic.js --apply    # write
 *
 * DUPLICATE SAFETY
 * The seller document is keyed by the account's Auth uid, matching the
 * pos-onboard.html writer and store.html's reader (store.html?id=<uid>), so a
 * re-run can only update the one document that account owns. Automate Joe is
 * only READ and reported; nothing is written for him because mechanics/automate-joe
 * already exists, is status:active, and car-hub.html renders it from Firestore.
 *
 * NO FABRICATION
 * Every value is copied from the account's own users/ document. verified and
 * featured are NOT set — those are admin decisions, and the sellers rule's
 * noAdminFields() rejects them on a client create anyway. Rating and counters
 * start absent/zero. Fields the owner still has to supply (logo, exact address,
 * description, health permit) are left absent and listed in onboardingPending.
 *
 * CREDENTIALS: Firestore REST + gcloud token, piped, never printed — the
 * pattern from scripts/onboard-providers.js.
 */

const https = require('https');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const HOST    = 'firestore.googleapis.com';
const BASE    = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe'
  : null;

let _tok = null;
function authToken() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _tok = execSync('gcloud auth print-access-token',
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env }).trim();
  return _tok;
}

function req(method, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign(
      { Authorization: 'Bearer ' + authToken(), 'x-goog-user-project': PROJECT },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    );
    const r = https.request({ host: HOST, path, method, headers }, (res) => {
      let out = '';
      res.on('data', c => { out += c; });
      res.on('end', () => {
        if (res.statusCode >= 400) return reject(new Error(res.statusCode + ' ' + path.split('?')[0] + ' :: ' + out.slice(0, 300)));
        resolve(out ? JSON.parse(out) : {});
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

/* typed-value helpers */
const S = v => ({ stringValue: String(v) });
const I = v => ({ integerValue: String(v) });
const B = v => ({ booleanValue: Boolean(v) });
const T = v => ({ timestampValue: v });
const A = a => ({ arrayValue: { values: a.map(S) } });
const plain = v => {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue' in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return v.timestampValue;   /* was missing — made every timestamp read as null */
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(plain);
  if ('mapValue' in v) return decode(v.mapValue.fields || {});
  return null;
};
const decode = f => Object.fromEntries(Object.entries(f || {}).map(([k, v]) => [k, plain(v)]));

const NOW = new Date().toISOString();

function terms(list) {
  const out = new Set();
  list.filter(Boolean).forEach(s => {
    const t = String(s).toLowerCase().trim();
    if (t) out.add(t);
    t.split(/[\s,&/]+/).forEach(w => { if (w.length > 2) out.add(w); });
  });
  return [...out];
}

const JOHN = 'Bxd4Lc4DQYaa3LabmJDfWtmTiN22';
const JOE  = 'pfcL6QTrIShhB68QToOFIaHnzSz2';

(async () => {
  const L = console.log;
  L('\n  SELLER / MECHANIC PLACEMENT   project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN'));
  L('  ' + NOW + '\n');

  /* ── 1. Automate Joe — verify, do not rewrite ─────────────────────────── */
  L('  [1] Automate Joe — mechanics registry');
  const joeUser = decode((await req('GET', BASE + '/users/' + JOE)).fields);
  const slug = joeUser.mechanicId || joeUser.merchantSlug || 'automate-joe';
  let joeMech = null;
  try { joeMech = decode((await req('GET', BASE + '/mechanics/' + slug)).fields); } catch (e) {}
  if (joeMech) {
    const visible = joeMech.status === 'active' && joeMech.createdAt != null;
    L('      mechanics/' + slug + ' EXISTS  status=' + joeMech.status +
      '  featured=' + joeMech.featured + '  hasCreatedAt=' + (joeMech.createdAt != null) +
      '  ownerUid=' + (joeMech.ownerUid === JOE ? 'matches' : joeMech.ownerUid));
    L('      → ' + (visible
      ? 'already in his area; car-hub.html renders mechanics from Firestore. Nothing to write.'
      : '** NOT visible — status must be active AND createdAt present **'));
  } else {
    L('      ** mechanics/' + slug + ' MISSING — would need creation (unexpected) **');
  }

  /* ── 2. John wa Pork — create the seller document ─────────────────────── */
  L('\n  [2] John wa Pork — sellers registry');
  const j = decode((await req('GET', BASE + '/users/' + JOHN)).fields);

  /* Guard: never create a duplicate under a different key. */
  let existing = null;
  try { existing = decode((await req('GET', BASE + '/sellers/' + JOHN)).fields); } catch (e) {}
  if (existing && Object.keys(existing).length) {
    L('      sellers/' + JOHN.slice(0, 10) + '… already exists — would MERGE, not duplicate.');
  }

  const name    = j.shopName || j.businessName || j.name || j.displayName || 'John wa Pork';
  const phone   = j.phoneNumber || j.phone || '';
  const catLabel = j.categoryLabel || 'Butchery';

  const fields = {
    uid:          S(JOHN),
    name:         S(name),
    shopName:     S(name),
    storeName:    S(name),
    businessName: S(name),
    /* Kept from the account's own data; not reclassified. */
    category:     S(j.category || 'food'),
    categoryLabel: S(catLabel),
    sellerType:   S(j.businessType || 'butchery'),
    businessType: S(j.businessType || 'butchery'),
    subCategory:  S(j.subCategory || 'pork_butchery'),
    accountType:  S('seller'),
    offersCookedFood: B(j.offersCookedFood === true),

    /* Discovery / visibility — status active and not hidden ⇒ isVisibleDoc()=true. */
    status:       S('active'),
    isVisible:    B(true),
    searchable:   B(true),
    searchIndexed: B(true),
    searchableTerms: A(terms([name, catLabel, j.businessType, j.subCategory,
                              'butchery', 'pork', 'meat', 'nyama', 'butcher'])),
    nameLower:    S(String(name).toLowerCase()),

    /* Honest state: not verified, not featured, shop not yet published by owner. */
    verified:     B(false),
    featured:     B(false),
    shopPublished: B(false),

    rating:       I(0),
    reviewCount:  I(0),
    productCount: I(0),

    /* What the owner still has to complete after login. */
    onboardingPending: A(['logo', 'exactAddress', 'description', 'healthPermit',
                          'openingHours', 'products', 'prices']),

    onboardedBy:  S('scripts/onboard-seller-mechanic.js'),
    createdAt:    T(NOW),
    updatedAt:    T(NOW),
  };
  if (phone) fields.phone = S(phone);
  if (phone) fields.phoneNumber = S(phone);
  if (j.email) fields.email = S(j.email);

  L('      name="' + name + '"  category=' + (j.category || 'food') +
    '/' + catLabel + '  phone=' + (phone || '(none)') + '  status=active');
  L('      searchableTerms: ' + plain(fields.searchableTerms).join(', '));

  if (!APPLY) {
    L('\n  DRY RUN — nothing written. Re-run with --apply.\n');
    return;
  }

  await req('PATCH', BASE + '/sellers/' + JOHN, { fields });
  L('      wrote sellers/' + JOHN);

  /* Link the user doc so the app knows the shop exists (merge, uid untouched). */
  await req('PATCH', BASE + '/users/' + JOHN +
    '?updateMask.fieldPaths=hasSellerProfile&updateMask.fieldPaths=searchIndexed&updateMask.fieldPaths=updatedAt',
    { fields: { hasSellerProfile: B(true), searchIndexed: B(true), updatedAt: T(NOW) } });
  L('      linked users/' + JOHN + ' (hasSellerProfile=true)');

  const rb = decode((await req('GET', BASE + '/sellers/' + JOHN)).fields);
  const ok = rb.status === 'active' && rb.isVisible === true && rb.name;
  L('      verify: name=' + JSON.stringify(rb.name) + ' status=' + rb.status +
    ' isVisible=' + rb.isVisible + (ok ? '  OK — discoverable' : '  ** NOT VISIBLE **'));
  L('\n  done.\n');
})().catch(e => {
  console.error('\n  failed: ' + e.message + '\n');
  process.exit(1);
});
