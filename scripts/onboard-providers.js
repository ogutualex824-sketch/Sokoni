'use strict';
/**
 * scripts/onboard-providers.js
 *
 * Completes provider onboarding for EXISTING accounts. Never creates an Auth
 * user, never creates a second provider record for an account.
 *
 *   node scripts/onboard-providers.js            # dry run — prints every write
 *   node scripts/onboard-providers.js --apply    # write
 *   node scripts/onboard-providers.js --apply --only=H7p6ktBHogM5GcBy6mz8negKVbG2
 *
 * ─── DUPLICATE SAFETY ────────────────────────────────────────────────────────
 * Every provider document is keyed by the account's Auth uid. Re-running can
 * therefore only ever update the same document — there is no code path that
 * mints a new id, so a double run cannot produce a second listing. Each write
 * carries an explicit updateMask, so fields this script does not name are left
 * exactly as they are.
 *
 * ─── WHAT IS NEVER WRITTEN ───────────────────────────────────────────────────
 * Profile photo, national ID / KYC, exact address or GPS, bio, pricing,
 * working hours and service radius are the account holder's to supply. They
 * are listed in `profilePending` on the document so the dashboard can prompt
 * for them, and are never invented here. Nothing in this script fabricates a
 * rating, a review count or a completed-job count either — those start at 0.
 *
 * ─── SOURCE OF TRUTH FOR FIELD VALUES ────────────────────────────────────────
 * Names, phones, locations and descriptions are copied from what the account
 * holder already submitted (their Auth record, their users/ document, their
 * applications/ document). No value in TARGETS below was authored by this
 * script; each carries a `_src` note recording where it came from.
 *
 * CREDENTIALS: Firestore REST + gcloud access token, matching
 * scripts/seed-health-provider.js. The token is piped, never printed.
 */

const https = require('https');
const { execSync } = require('child_process');

const APPLY   = process.argv.includes('--apply');
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const HOST    = 'firestore.googleapis.com';
const BASE    = '/v1/projects/' + PROJECT + '/databases/(default)/documents';
const ONLY    = (process.argv.find(a => a.startsWith('--only=')) || '').slice(7) || null;

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

function req(method, host, path, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = Object.assign(
      { Authorization: 'Bearer ' + authToken(), 'x-goog-user-project': PROJECT },
      data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}
    );
    const r = https.request({ host, path, method, headers }, (res) => {
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

/* ── Firestore typed values ──────────────────────────────────────────── */
const S = v => ({ stringValue: String(v) });
const I = v => ({ integerValue: String(v) });
const B = v => ({ booleanValue: Boolean(v) });
const T = v => ({ timestampValue: v });
const A = a => ({ arrayValue: { values: a.map(S) } });
const M = o => ({ mapValue: { fields: o } });

const plain = v => {
  if (!v || typeof v !== 'object') return v;
  if ('stringValue'  in v) return v.stringValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('arrayValue'   in v) return (v.arrayValue.values || []).map(plain);
  return null;
};

const NOW = new Date().toISOString();

/* Keyword list → the lowercase token array used for matching. */
function terms(list) {
  const out = new Set();
  list.filter(Boolean).forEach(s => {
    const t = String(s).toLowerCase().trim();
    if (t) out.add(t);
    t.split(/[\s,&/]+/).forEach(w => { if (w.length > 2) out.add(w); });
  });
  return [...out];
}

/* ═══ TARGETS ════════════════════════════════════════════════════════════════
   One entry per existing account. `action` is either 'onboard' (write the
   provider records) or 'hold' (write nothing, report why).

   The holds are not omissions — each is an account whose own data says it does
   not belong in the `providers` professionals directory, or that is gated on a
   verification this script has no authority to grant. Publishing them anyway
   would file them under the wrong category and contradict the requirement that
   every account appear under the correct one.
═══════════════════════════════════════════════════════════════════════════ */
const TARGETS = [
  {
    uid: 'H7p6ktBHogM5GcBy6mz8negKVbG2',
    action: 'onboard',
    label: 'Ann — Mama Fua',
    /* _src: Auth.displayName='Ann'; applications/e0cOABIkbtu2Vb1suG5y supplied
       businessName, phone, location, description, category. */
    applicationId: 'e0cOABIkbtu2Vb1suG5y',
    fields: {
      name:          'Ann',
      businessName:  "Langa'ta mamafua",
      category:      'laundry',
      categories:    ['laundry', 'cleaning'],
      categoryLabel: 'Mama Fua',
      serviceType:   'Laundry & Cleaning',
      hub:           'services',
      description:   'Cleaning services,houses, carpets,',
      location:      "Langa'ta canivor, Nairobi",
      city:          'Nairobi',
      county:        'Nairobi',
      phone:         '0748346783',
      email:         'momanyi07@gmail.com',
      skills:        ['Mama Fua', 'Laundry', 'Cleaning', 'Washing', 'House Cleaning'],
      keywords:      ['Ann', 'Mama Fua', 'Laundry', 'Cleaning', 'Washing', 'House Cleaning'],
      verified:      true,   /* explicitly authorised as admin-verified */
      featured:      true,
    },
  },
  {
    uid: 'aOdQxmUGLCO4hOYsdHMhWuwYV9D2',
    action: 'onboard',
    label: 'King Bruce — Artist / MC',
    /* _src: users/aOdQ… supplied stageName, legalName, profession, category. */
    fields: {
      name:          'King Bruce',
      businessName:  'King Bruce',
      category:      'mc',
      categories:    ['mc', 'entertainment'],
      categoryLabel: 'Entertainment',
      serviceType:   'Artist / MC',
      hub:           'services',
      email:         'ategobruce@gmail.com',
      skills:        ['MC', 'Artist', 'Live Performance', 'Events'],
      keywords:      ['King Bruce', 'MC', 'Artist', 'Entertainment', 'Events'],
      verified:      false,  /* never self-certified — no verification on file */
      featured:      false,
    },
  },

  /* ── HELD ────────────────────────────────────────────────────────────── */
  {
    uid: 'Bxd4Lc4DQYaa3LabmJDfWtmTiN22',
    action: 'hold',
    label: 'John wa Pork — butchery',
    reason: 'accountType=seller, isSeller=true, businessType=butchery. This is a '
          + 'shop, not a bookable service provider. Its correct home is the '
          + '`sellers` registry (search tab "businesses"); adding it to '
          + '`providers` would file a butchery under "professionals". '
          + 'verificationStatus=pending and upload_health_permit is unticked — '
          + 'a food business needs its health permit before it is published.',
  },
  {
    uid: 'WEbAS5cVDwTdyWhuCcNXsNTYeIW2',
    action: 'hold',
    label: 'FRED — delivery rider',
    reason: 'accountType=rider, driverStatus=pending_verification, availability='
          + 'offline. Onboarding checklist still requires driving licence, good '
          + 'conduct certificate, insurance and national ID — all unticked. '
          + 'Publishing an unverified rider as bookable would bypass driver '
          + 'verification, which is a passenger/goods safety control, not a '
          + 'profile-completeness nicety.',
  },
  {
    uid: 'ZrG4N8SETmS7NMEg0src1NYjBw23',
    action: 'hold',
    label: 'T.M.M & Partners Advocates — law firm',
    reason: 'accountStatus=invited (invitation never completed), '
          + 'verificationStatus=pending, businessType=law_firm. Advocates are '
          + 'regulated: publishing a firm as an active provider without an LSK '
          + 'practising number on file is a regulatory exposure, and the '
          + 'dedicated `lawyers` registry — not `providers` — is where the '
          + 'search adapter looks for legal professionals.',
  },
  {
    uid: 'pfcL6QTrIShhB68QToOFIaHnzSz2',
    action: 'hold',
    label: 'Joseph / Automate Joe — mechanic',
    reason: 'Already carries mechanicId=automate-joe, merchantSlug=automate-joe, '
          + 'featured=true and searchIndexed=true. The search adapter reads '
          + 'mechanics from the dedicated `mechanics` collection. Writing a '
          + 'second record into `providers` would list the same business twice '
          + 'under two categories — the duplicate this task exists to prevent.',
  },
];

/* ── Document builders ───────────────────────────────────────────────────── */

function providerDoc(t) {
  const f = t.fields;
  const providerId = 'PRV-' + t.uid.slice(0, 8).toUpperCase();
  const d = {
    uid:            S(t.uid),
    providerId:     S(providerId),
    name:           S(f.name),
    businessName:   S(f.businessName),
    category:       S(f.category),
    categories:     A(f.categories),
    categoryLabel:  S(f.categoryLabel),
    serviceType:    S(f.serviceType),
    hub:            S(f.hub),
    skills:         A(f.skills),
    searchableTerms: A(terms([...f.keywords, f.name, f.businessName, f.categoryLabel, f.serviceType])),
    nameLower:      S(String(f.name).toLowerCase()),

    /* Discovery + lifecycle flags */
    status:         S('active'),
    isActive:       B(true),
    isPublic:       B(true),
    searchable:     B(true),
    searchIndexed:  B(true),
    featured:       B(f.featured),
    acceptsBookings: B(true),
    available:      B(true),
    isOnline:       B(true),
    verified:       B(f.verified),

    /* Capability switches */
    chatEnabled:      B(true),
    reviewsEnabled:   B(true),
    ratingsEnabled:   B(true),
    analyticsEnabled: B(true),
    notificationsEnabled: B(true),
    payoutsEnabled:   B(true),

    /* Counters start at zero — never seeded with flattering numbers */
    rating:         I(0),
    reviewCount:    I(0),
    ratingCount:    I(0),
    bookingCount:   I(0),
    jobsCompleted:  I(0),

    onboardedBy:    S('scripts/onboard-providers.js'),
    onboardedAt:    T(NOW),
    createdAt:      T(NOW),
    updatedAt:      T(NOW),

    /* Fields deliberately left for the account holder to complete at login. */
    profilePending: A(['photo', 'kycDocuments', 'exactLocation', 'bio',
                       'pricing', 'workingHours', 'serviceRadius']),
    profileComplete: B(false),
  };
  if (f.verified) {
    d.verifiedBy = S('admin');
    d.verifiedAt = T(NOW);
  }
  /* Only set contact/location keys the account holder actually supplied. */
  if (f.description) d.description = S(f.description);
  if (f.location)    d.location    = S(f.location);
  if (f.city)        d.city        = S(f.city);
  if (f.county)      d.county      = S(f.county);
  if (f.phone)       d.phone       = S(f.phone);
  if (f.email)       d.email       = S(f.email);
  return d;
}

const settingsDoc = t => ({
  uid: S(t.uid),
  acceptsBookings:   B(true),
  instantBooking:    B(false),
  autoAcceptBookings: B(false),
  chatEnabled:       B(true),
  reviewsEnabled:    B(true),
  publicProfile:     B(true),
  searchable:        B(true),
  currency:          S('KES'),
  updatedAt:         T(NOW),
});

const notificationsDoc = t => ({
  uid: S(t.uid), sms: B(true), email: B(true), push: B(true),
  bookingAlerts: B(true), messageAlerts: B(true), reviewAlerts: B(true),
  payoutAlerts: B(true), updatedAt: T(NOW),
});

const analyticsDoc = t => ({
  uid: S(t.uid),
  profileViews: I(0), searchImpressions: I(0), bookingRequests: I(0),
  bookingsCompleted: I(0), totalEarnings: I(0), currency: S('KES'),
  initialisedAt: T(NOW), updatedAt: T(NOW),
});

/* free_trial mirrors PLANS.free_trial in functions/provider-onboarding.js.
   If that catalogue changes, change this too. */
const subscriptionDoc = t => ({
  uid: S(t.uid),
  subscriptionId: S('SUB-' + t.uid.slice(0, 8).toUpperCase()),
  plan: S('free_trial'), billingCycle: S('monthly'), status: S('trialing'),
  price: I(0), trialStatus: S('active'),
  trialDays: I(14),
  renewalDate: S(new Date(Date.now() + 14 * 86400000).toISOString()),
  commissionRate: { doubleValue: 0.20 },
  limits: M({ listings: I(1), leadsPerMonth: I(5), staff: I(0) }),
  features: M({
    bookings: B(true), messaging: B(true), calendar: B(false), portfolio: B(false),
    ai: B(false), analytics: B(false), invoices: B(false), verification: B(false),
    featured: B(false), priorityRanking: B(false), api: B(false), whiteLabel: B(false),
  }),
  createdAt: T(NOW), updatedAt: T(NOW),
});

/* Wallet is created at zero. No opening balance, no credit. */
const walletDoc = t => ({
  uid: S(t.uid), balance: I(0), escrow: I(0), totalIn: I(0), totalOut: I(0),
  currency: S('KES'), frozen: B(false),
  createdAt: T(NOW), updatedAt: T(NOW),
});

const notifPrefsDoc = t => ({
  uid: S(t.uid), sms: B(true), email: B(true), push: B(true), inApp: B(true),
  dnd: B(false), updatedAt: T(NOW),
});

/* users/ link — updateMask keeps every other field on the doc untouched. */
const userLinkDoc = t => ({
  providerProfileId: S('PRV-' + t.uid.slice(0, 8).toUpperCase()),
  registeredAs:      M({ provider: B(true) }),
  isProvider:        B(true),
  providerCategory:  S(t.fields.category),
  searchIndexed:     B(true),
  updatedAt:         T(NOW),
});

async function patch(col, id, fields) {
  const mask = Object.keys(fields).map(k => 'updateMask.fieldPaths=' + encodeURIComponent(k)).join('&');
  return req('PATCH', HOST, BASE + '/' + col + '/' + encodeURIComponent(id) + '?' + mask, { fields });
}

/* ── Run ─────────────────────────────────────────────────────────────────── */
(async () => {
  const L = console.log;
  L('\n  PROVIDER ONBOARDING   project ' + PROJECT + '   mode ' + (APPLY ? 'APPLY' : 'DRY RUN'));
  L('  ' + NOW + '\n');

  const list = ONLY ? TARGETS.filter(t => t.uid === ONLY) : TARGETS;
  const done = [], held = [], failed = [];

  for (const t of list) {
    if (t.action === 'hold') {
      held.push(t);
      L('  HOLD    ' + t.label + '  (' + t.uid.slice(0, 10) + '…)');
      L('          ' + t.reason.replace(/(.{72}) /g, '$1\n          ') + '\n');
      continue;
    }

    L('  ONBOARD ' + t.label + '  (' + t.uid + ')');

    /* Guard: the Auth account must exist and be enabled. Onboarding a provider
       nobody can sign in as would produce a listing that can never be served. */
    let user = null;
    try {
      const r = await req('POST', 'identitytoolkit.googleapis.com',
        '/v1/projects/' + PROJECT + '/accounts:lookup', { localId: [t.uid] });
      user = (r.users || [])[0] || null;
    } catch (e) {
      failed.push({ t, why: 'auth lookup failed: ' + e.message });
      L('          FAILED — auth lookup: ' + e.message + '\n');
      continue;
    }
    if (!user)          { failed.push({ t, why: 'no Auth user' });        L('          FAILED — no Auth account\n'); continue; }
    if (user.disabled)  { failed.push({ t, why: 'Auth user disabled' });  L('          FAILED — Auth account is disabled\n'); continue; }

    /* Guard: refuse to create a second listing for an account that already has
       one under a different document id. */
    const scan = await req('GET', HOST, BASE + '/providers?pageSize=300').catch(() => ({}));
    const dupes = (scan.documents || [])
      .filter(d => plain((d.fields || {}).uid) === t.uid)
      .map(d => d.name.split('/').pop())
      .filter(id => id !== t.uid);
    if (dupes.length) {
      failed.push({ t, why: 'existing provider doc(s) under a different id: ' + dupes.join(', ') });
      L('          FAILED — account already has provider doc(s): ' + dupes.join(', ') + '\n');
      continue;
    }

    const writes = [
      ['providers',             t.uid, providerDoc(t)],
      ['providerSettings',      t.uid, settingsDoc(t)],
      ['providerNotifications', t.uid, notificationsDoc(t)],
      ['providerAnalytics',     t.uid, analyticsDoc(t)],
      ['providerSubscriptions', t.uid, subscriptionDoc(t)],
      ['wallets',               t.uid, walletDoc(t)],
      ['notificationPrefs',     t.uid, notifPrefsDoc(t)],
      ['users',                 t.uid, userLinkDoc(t)],
    ];
    if (t.applicationId) {
      writes.push(['applications', t.applicationId, {
        status: S('approved'), reviewedBy: S('admin'), reviewedAt: T(NOW),
        providerUid: S(t.uid), updatedAt: T(NOW),
      }]);
    }

    if (!APPLY) {
      writes.forEach(([c, id, f]) =>
        L('          would PATCH ' + c + '/' + id + '  [' + Object.keys(f).length + ' fields]'));
      L('          keywords: ' + plain(providerDoc(t).searchableTerms).join(', ') + '\n');
      done.push(t);
      continue;
    }

    try {
      for (const [c, id, f] of writes) {
        await patch(c, id, f);
        L('          wrote ' + c + '/' + id);
      }
      /* Read back the one document discovery actually depends on. */
      const rb = await req('GET', HOST, BASE + '/providers/' + t.uid);
      const g  = rb.fields || {};
      const ok = plain(g.status) === 'active' && plain(g.searchable) === true;
      L('          verify: status=' + plain(g.status) +
        ' searchable=' + plain(g.searchable) +
        ' verified=' + plain(g.verified) +
        ' category=' + plain(g.category) + (ok ? '  OK' : '  ** NOT DISCOVERABLE **'));
      (ok ? done : failed).push(ok ? t : { t, why: 'read-back did not confirm active+searchable' });
      L('');
    } catch (e) {
      failed.push({ t, why: e.message });
      L('          FAILED — ' + e.message + '\n');
    }
  }

  L('  ' + '─'.repeat(66));
  L('  audited  ' + TARGETS.length + '   onboarded ' + done.length +
    '   held ' + held.length + '   failed ' + failed.length);
  if (failed.length) failed.forEach(f => L('    FAILED  ' + (f.t ? f.t.label : '?') + ' — ' + f.why));
  if (!APPLY) L('\n  DRY RUN — nothing was written. Re-run with --apply.');
  L('');
})().catch(e => {
  console.error('\n  onboarding failed: ' + e.message + '\n');
  process.exit(1);
});
