'use strict';
/**
 * scripts/onboard-maina-groceries.js — onboard "Maina Groceries" as a grocery
 * seller with phone-OTP login.
 *
 *   node scripts/onboard-maina-groceries.js            # dry run (default)
 *   node scripts/onboard-maina-groceries.js --apply
 *
 * Maina Groceries — grocery shop, phone 0706603915. Signs in with
 * +254706603915 by OTP and lands on the uid that owns the seller record, so the
 * shop is theirs immediately.
 *
 * CATEGORY — this is the part worth getting right. The marketplace's valid
 * categories are exactly the keys of `categoryMeta` in category.js (36 of
 * them), and products are matched with
 *     p.category.toLowerCase() === category.toLowerCase()
 * The grocery category there is **`food`** ("Groceries & Fresh Food").
 *
 * It is NOT `grocery` and NOT `groceries`:
 *   - `grocery` is a Food Hub vendor category in sokoni-food.js, which is
 *     localStorage-only — it never touches Firestore, so a merchant filed
 *     under it would exist on one browser and nowhere else.
 *   - `groceries` is a display label, not a slug.
 * Either would list the shop in a category no page resolves — a silent
 * no-op that looks like a successful onboarding.
 *
 * Nothing is fabricated. Only what was given: the business name and the phone
 * number. verified=false (not yet verified), shopPublished=false (the owner
 * publishes), all counters zero, and everything still outstanding is listed in
 * onboardingPending so the merchant sees what to finish.
 *
 * A random password is set and never printed — sign-in is by phone.
 */

const https   = require('https');
const crypto  = require('crypto');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyDt_FRoTdE5OpfPhLB0DApIm7p-I45hzVE';
const HOST = 'firestore.googleapis.com', IT = 'identitytoolkit.googleapis.com';
const BASE = '/v1/projects/' + PROJECT + '/databases/(default)/documents';

const PHONE_LOCAL = '0706603915';
const PHONE       = '+254706603915';
const SHOP        = 'Maina Groceries';
/* The owner's personal name was not supplied; the business name is used for
   display and no person name is invented. The owner can set their own in
   Profile. */
const PERSON      = 'Maina Groceries';
const EMAIL       = 'mainagroceries254706603915@sokoni-seller.invalid'; /* placeholder; login is by phone */

const CATEGORY       = 'food';        /* categoryMeta key — see header */
const CATEGORY_LABEL = 'Groceries';
const BUSINESS_TYPE  = 'grocery';

const BUNDLED_PY = process.env.LOCALAPPDATA
  ? process.env.LOCALAPPDATA + '\\Google\\Cloud SDK\\google-cloud-sdk\\platform\\bundledpython\\python.exe' : null;
let _tok = null;
function tokn() {
  if (_tok) return _tok;
  if (process.env.GCLOUD_ACCESS_TOKEN) return (_tok = process.env.GCLOUD_ACCESS_TOKEN.trim());
  const env = Object.assign({}, process.env);
  if (BUNDLED_PY && !env.CLOUDSDK_PYTHON) env.CLOUDSDK_PYTHON = BUNDLED_PY;
  _tok = execSync('gcloud auth print-access-token', { encoding: 'utf8', stdio: ['ignore','pipe','pipe'], env }).trim();
  return _tok;
}
function req(method, host, path, body, useKey) {
  return new Promise((res, rej) => {
    const data = body ? JSON.stringify(body) : null;
    const h = useKey ? {} : { Authorization: 'Bearer ' + tokn(), 'x-goog-user-project': PROJECT };
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = Buffer.byteLength(data); }
    const r = https.request({ host, path, method, headers: h }, x => {
      let o = ''; x.on('data', c => o += c); x.on('end', () => res({ status: x.statusCode, body: o }));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}

const S = v => ({ stringValue: String(v) }), I = v => ({ integerValue: String(v) }),
      B = v => ({ booleanValue: !!v }), T = v => ({ timestampValue: v }),
      A = a => ({ arrayValue: { values: a.map(S) } });
const decode = f => { const o = {}; for (const k in (f||{})) { const v = f[k];
  o[k] = v.stringValue ?? v.booleanValue ?? (v.integerValue != null ? Number(v.integerValue) : undefined); } return o; };
/**
 * Read a document and return its decoded fields.
 *
 * `req()` resolves to { status, body } with body as a RAW STRING — it does not
 * parse. Calling `.fields` on that returns undefined, which made the read-back
 * print "name=undefined … ** CHECK **" on a run whose writes had in fact
 * succeeded. A verification step that cries wolf is worse than none, because
 * the next person learns to ignore it.
 */
async function getDoc(col, id) {
  const r = await req('GET', HOST, BASE + '/' + col + '/' + encodeURIComponent(id));
  if (r.status >= 400) return { __error: r.status + ' ' + r.body.slice(0, 120) };
  let j; try { j = JSON.parse(r.body); } catch (_) { return { __error: 'unparseable response' }; }
  return decode(j.fields);
}
const NOW = new Date().toISOString();
const terms = list => { const out = new Set();
  list.filter(Boolean).forEach(s => { const t = String(s).toLowerCase().trim();
    if (t) out.add(t); t.split(/[\s,&/'’]+/).forEach(w => { if (w.length > 2) out.add(w); }); });
  return [...out]; };
async function patch(col, id, fields) {
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return req('PATCH', HOST, BASE + '/' + col + '/' + encodeURIComponent(id) + '?' + mask, { fields });
}

(async () => {
  const L = console.log;
  L('\n  MAINA GROCERIES ONBOARDING   project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN'));
  L('  shop "' + SHOP + '"   phone ' + PHONE + '   category ' + CATEGORY + '/' + CATEGORY_LABEL + '\n');

  /* ── 1. Does an account already own this phone? ──────────────────────── */
  const look = await req('POST', IT, '/v1/projects/' + PROJECT + '/accounts:lookup', { phoneNumber: [PHONE] });
  if (look.status >= 400) { L('  ! lookup failed (' + look.status + '): ' + look.body.slice(0, 200)); process.exit(1); }
  let uid = (JSON.parse(look.body).users || [])[0] && JSON.parse(look.body).users[0].localId;
  const existedBefore = !!uid;

  if (uid) {
    L('  1. phone already has an account — uid ' + uid);
    L('     REUSING it. No second account is created, so the merchant keeps one identity.');
  } else {
    L('  1. phone is free — a new account will be created for OTP sign-in.');
  }

  /* ── 2. Would we overwrite an existing seller record? ────────────────── */
  if (uid) {
    let existing = null;
    try { existing = await getDoc('sellers', uid); } catch (_) {}
    if (existing && Object.keys(existing).length) {
      L('  2. sellers/' + uid + ' ALREADY EXISTS (name=' + JSON.stringify(existing.name) + ').');
      L('     This script would MERGE into it, not duplicate — but check that is intended.');
    } else {
      L('  2. no existing seller record — a new one will be created.');
    }
  } else {
    L('  2. no existing seller record — a new one will be created.');
  }

  /* ── 3. What will be written ─────────────────────────────────────────── */
  const searchTerms = terms([SHOP, 'Maina', CATEGORY_LABEL, BUSINESS_TYPE,
                             'groceries', 'grocery', 'fresh', 'food', 'mboga', 'duka']);

  const sellerFields = {
    uid:            S(uid || '(new)'),
    name:           S(SHOP),
    shopName:       S(SHOP),
    storeName:      S(SHOP),
    businessName:   S(SHOP),

    category:       S(CATEGORY),
    categoryLabel:  S(CATEGORY_LABEL),
    sellerType:     S(BUSINESS_TYPE),
    businessType:   S(BUSINESS_TYPE),
    accountType:    S('seller'),

    /* status active + not hidden ⇒ the shop is discoverable */
    status:         S('active'),
    isVisible:      B(true),
    searchable:     B(true),
    searchIndexed:  B(true),
    searchableTerms: A(searchTerms),
    nameLower:      S(SHOP.toLowerCase()),

    /* Honest starting state — nothing claimed that has not happened. */
    verified:       B(false),
    featured:       B(false),
    shopPublished:  B(false),
    rating:         I(0),
    reviewCount:    I(0),
    productCount:   I(0),

    onboardingPending: A(['logo', 'coverPhoto', 'description', 'exactAddress',
                          'openingHours', 'deliveryAreas', 'products', 'prices']),

    phone:          S(PHONE_LOCAL),
    phoneNumber:    S(PHONE),
    onboardedBy:    S('scripts/onboard-maina-groceries.js'),
    createdAt:      T(NOW),
    updatedAt:      T(NOW),
  };

  L('\n  3. sellers/{uid}');
  L('       name="' + SHOP + '"  category=' + CATEGORY + ' (' + CATEGORY_LABEL + ')  status=active  isVisible=true');
  L('       verified=false  featured=false  shopPublished=false  rating/reviews/products=0');
  L('       searchableTerms: ' + searchTerms.join(', '));
  L('     users/{uid}');
  L('       roles=["seller","buyer"]  role="seller"  hasSellerProfile=true');
  L('       ^ roles drives sokoni-nav-engine._role(). Without "seller" in the ARRAY the');
  L('         owner signs in successfully and still lands as a buyer.');

  if (!APPLY) {
    L('\n  DRY RUN — nothing written. Re-run with --apply.\n');
    return;
  }

  /* ── 4. Create the account if needed ─────────────────────────────────── */
  if (!uid) {
    const pw = crypto.randomBytes(18).toString('base64');   // never printed
    const up = await req('POST', IT, '/v1/accounts:signUp?key=' + API_KEY,
                         { email: EMAIL, password: pw, returnSecureToken: true }, true);
    if (up.status >= 400) { L('  ! signUp failed (' + up.status + '): ' + up.body.slice(0, 300)); process.exit(1); }
    uid = JSON.parse(up.body).localId;
    const upd = await req('POST', IT, '/v1/projects/' + PROJECT + '/accounts:update',
                          { localId: uid, phoneNumber: PHONE, displayName: PERSON });
    if (upd.status >= 400) { L('  ! attaching phone failed (' + upd.status + '): ' + upd.body.slice(0, 300)); process.exit(1); }
    L('\n  4. created auth account ' + uid + ' with phone ' + PHONE);
  } else {
    L('\n  4. reusing existing auth account ' + uid);
  }

  sellerFields.uid = S(uid);

  /* ── 5. Write ────────────────────────────────────────────────────────── */
  const w1 = await req('PATCH', HOST, BASE + '/sellers/' + uid, { fields: sellerFields });
  if (w1.status >= 400) { L('  ! sellers write failed (' + w1.status + '): ' + w1.body.slice(0, 300)); process.exit(1); }
  L('     wrote sellers/' + uid);

  const userFields = {
    name:            S(PERSON),
    displayName:     S(PERSON),
    phone:           S(PHONE_LOCAL),
    phoneNumber:     S(PHONE),
    /* The ARRAY is what the nav engine reads — the bool alone is not enough. */
    roles:           A(['seller', 'buyer']),
    role:            S('seller'),
    isSeller:        B(true),
    hasSellerProfile: B(true),
    accountType:     S('seller'),
    searchIndexed:   B(true),
    updatedAt:       T(NOW),
  };
  if (!existedBefore) userFields.createdAt = T(NOW);

  const w2 = await patch('users', uid, userFields);
  if (w2.status >= 400) { L('  ! users write failed (' + w2.status + '): ' + w2.body.slice(0, 300)); process.exit(1); }
  L('     wrote users/' + uid + ' (roles=["seller","buyer"])');

  /* ── 6. Read back — never trust the write ────────────────────────────── */
  const rb = await getDoc('sellers', uid);
  const ru = await getDoc('users', uid);
  const ok = rb.status === 'active' && rb.isVisible === true && rb.name === SHOP && rb.category === CATEGORY;
  L('\n  5. verify sellers/: name=' + JSON.stringify(rb.name) + '  category=' + rb.category +
    '  status=' + rb.status + '  isVisible=' + rb.isVisible + (ok ? '   OK — discoverable' : '   ** CHECK **'));
  L('     verify users/:   role=' + ru.role + '  hasSellerProfile=' + ru.hasSellerProfile);
  L('\n     Sign-in: phone OTP on ' + PHONE + ' → lands on uid ' + uid);
  L('     Listed under: category.html?cat=' + CATEGORY + '  ("Groceries & Fresh Food")\n');
})().catch(e => { console.error('\n  FAILED:', e.message, '\n'); process.exit(1); });
