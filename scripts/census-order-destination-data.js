/* ══════════════════════════════════════════════════════════════════════════════
   ORDER DESTINATION — PRODUCTION DATA CENSUS
   ══════════════════════════════════════════════════════════════════════════════
   READ-ONLY. No writes, no rule changes, no test documents. It opens no order it
   does not already own, and it prints NO buyer PII — only which FIELDS are
   populated, never their values.

   WHY THIS EXISTS. docs/DELIVERY_DESTINATION_BLOCKER.md censused the CODE and
   found competing destination spellings. A code census cannot say which of them
   production actually contains, and a canonical decision made without that is a
   preference dressed up as an architecture. This measures the data.

   It answers exactly one question per field: on this seller's real orders, how
   often is it present, and is it ever the ONLY destination available?

   Requires the same headed browser and real approved seller as the certification,
   because App Check gates Firestore and a headless browser cannot attest.

     SOKONI_CERT_MERCHANT_EMAIL / _PASSWORD     a real approved seller
     (no App Check debug token — attestation is native on the live origin)

   Run: node scripts/census-order-destination-data.js
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const { chromium } = require('playwright');

const ORIGIN = process.env.SOKONI_ORIGIN || 'https://mysokoni.co.ke';
const EMAIL = process.env.SOKONI_CERT_MERCHANT_EMAIL || '';
const PASS = process.env.SOKONI_CERT_MERCHANT_PASSWORD || '';

if (!EMAIL || !PASS) {
  console.error('\n  FAIL CLOSED — a real approved seller is required.');
  console.error('    SOKONI_CERT_MERCHANT_EMAIL      ' + (EMAIL ? 'set' : 'MISSING'));
  console.error('    SOKONI_CERT_MERCHANT_PASSWORD   ' + (PASS ? 'set' : 'MISSING'));
  console.error('  Firestore is App Check gated; without a session this measures nothing.\n');
  process.exit(2);
}

/* Every spelling found in the CODE census, address and geometry alike. The point is
   to discover which are real, so absent ones must be asked for too — omitting them
   would beg the question. */
const TEXT = ['deliveryAddress', 'dropoffAddress', 'address', 'deliveryLocation', 'destination'];
const GEO = ['deliveryCoords', 'dropoffCoords', 'dropoff',
             'dropoffLat', 'dropoffLng', 'dropLat', 'dropLng', 'deliveryLat', 'deliveryLng'];

(async () => {
  console.log('\nORDER DESTINATION — PRODUCTION DATA CENSUS  (read-only)');
  console.log('='.repeat(76));

  const b = await chromium.launch({ headless: false });
  const page = await (await b.newContext()).newPage();
  await page.goto(ORIGIN + '/', { waitUntil: 'commit', timeout: 60000 }).catch(() => {});
  await page.waitForFunction(() => typeof window.__sokoniAppCheckState === 'string', null, { timeout: 25000 }).catch(() => {});

  const auth = await page.evaluate(async ({ email, password }) => {
    try {
      const [{ getApps, getApp }, { getAuth, signInWithEmailAndPassword, onAuthStateChanged }] = await Promise.all([
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js'),
        import('https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js'),
      ]);
      if (!getApps().length) return { ok: false, why: 'no Firebase app' };
      const a = getAuth(getApp());
      if (!a.currentUser) await signInWithEmailAndPassword(a, email, password);
      const uid = a.currentUser ? a.currentUser.uid : await new Promise((r) => {
        const t = setTimeout(() => r(null), 15000);
        onAuthStateChanged(a, (u) => { if (u) { clearTimeout(t); r(u.uid); } });
      });
      return { ok: !!uid, uid };
    } catch (e) { return { ok: false, why: (e && e.code) || e.message }; }
  }, { email: EMAIL, password: PASS });

  if (!auth.ok) { console.error('\n  Sign-in failed: ' + auth.why + '\n'); await b.close(); process.exit(1); }
  console.log('\n  seller uid: ' + auth.uid);

  /* ATTESTATION PRE-FLIGHT. App Check gates Firestore BEFORE rules are evaluated, so a
     failed attestation returns permission-denied on the orders query — which reads
     exactly like "this seller has no orders" or "the rules are wrong". Both are the
     wrong conclusion, and diagnosing that mistake once already cost a full cycle.
     `shops` is world-readable (allow read: if true), so a refusal there cannot be a
     rule and can only be attestation. fromCache:false is the assertion — a cached
     answer would mean the backend was never reached. */
  const attest = await page.evaluate(async () => {
    try {
      const { getApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
      const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
      const s = await m.getDocs(m.query(m.collection(m.getFirestore(getApp()), 'shops'), m.limit(1)));
      return { size: s.size, fromCache: s.metadata.fromCache };
    } catch (e) { return 'ERR ' + ((e && e.code) || e.message); }
  }).catch((e) => 'ERR ' + e.message);

  if (!(attest && typeof attest === 'object' && attest.fromCache === false)) {
    console.error('\n  STOPPING — App Check did not attest: ' + JSON.stringify(attest));
    console.error('  A world-readable collection was refused, which no rule can do, so every');
    console.error('  count below would be zero for a reason unrelated to your data.');
    console.error('  This run is headed; if it still fails, report the error rather than');
    console.error('  adding a debug token.\n');
    await b.close(); process.exit(1);
  }
  console.log('  App Check: attested (backend answered a world-readable read)');

  const out = await page.evaluate(async ({ uid, TEXT, GEO }) => {
    const { getApp } = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js');
    const m = await import('https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js');
    const db = m.getFirestore(getApp());
    const res = { orders: 0, err: null, counts: {}, delivery: 0, pickup: 0, unknownFulfil: 0,
                  deliveryWithNoGeo: 0, deliveryWithNoText: 0, soleSource: {}, fulfilKeys: {} };
    [...TEXT, ...GEO].forEach((k) => { res.counts[k] = 0; res.soleSource[k] = 0; });
    try {
      const snap = await m.getDocs(m.query(m.collection(db, 'orders'), m.where('sellerUid', '==', uid), m.limit(200)));
      snap.forEach((d) => {
        const o = d.data() || {};
        res.orders++;
        /* Fulfilment vocabulary is itself part of the contract question. */
        ['fulfillmentType', 'fulfilmentType', 'deliveryMethod', 'fulfilment', 'fulfillment'].forEach((k) => {
          if (o[k] !== undefined) res.fulfilKeys[k] = (res.fulfilKeys[k] || 0) + 1;
        });
        const ft = String(o.fulfillmentType || o.fulfilmentType || o.deliveryMethod || '').toLowerCase();
        if (/pickup/.test(ft)) res.pickup++; else if (ft) res.delivery++; else res.unknownFulfil++;

        const present = [];
        [...TEXT, ...GEO].forEach((k) => {
          const v = o[k];
          const has = v !== undefined && v !== null && v !== '' &&
                      !(typeof v === 'object' && Object.keys(v).length === 0);
          if (has) { res.counts[k]++; present.push(k); }
        });
        if (present.length === 1) res.soleSource[present[0]]++;

        if (!/pickup/.test(ft)) {
          const anyText = TEXT.some((k) => o[k]);
          const anyGeo = GEO.some((k) => o[k] !== undefined && o[k] !== null && o[k] !== '');
          if (!anyGeo) res.deliveryWithNoGeo++;
          if (!anyText) res.deliveryWithNoText++;
        }
      });
    } catch (e) { res.err = 'ERR ' + (e.code || e.message); }
    return res;
  }, { uid: auth.uid, TEXT, GEO });

  await b.close();

  if (out.err) { console.error('\n  ' + out.err + '\n'); process.exit(1); }
  if (!out.orders) {
    console.log('\n  UNPROVEN — this seller has 0 readable orders. The census measured nothing.');
    console.log('  A canonical decision must not be made from an empty sample.\n');
    process.exit(3);
  }

  const pct = (n) => (out.orders ? (100 * n / out.orders).toFixed(0).padStart(3) + '%' : '  —');
  console.log('  orders sampled: ' + out.orders + '   (delivery ' + out.delivery +
              ' · pickup ' + out.pickup + ' · fulfilment unstated ' + out.unknownFulfil + ')');

  console.log('\n  ADDRESS FIELDS                 present    sole source');
  TEXT.forEach((k) => console.log('    ' + k.padEnd(28) + pct(out.counts[k]) + '      ' + out.soleSource[k]));
  console.log('\n  GEOMETRY FIELDS                present    sole source');
  GEO.forEach((k) => console.log('    ' + k.padEnd(28) + pct(out.counts[k]) + '      ' + out.soleSource[k]));

  console.log('\n  FULFILMENT KEYS SEEN');
  const fk = Object.keys(out.fulfilKeys);
  if (fk.length) fk.forEach((k) => console.log('    ' + k.padEnd(28) + out.fulfilKeys[k]));
  else console.log('    (none — no order states its fulfilment type)');

  console.log('\n  GAPS ON DELIVERY ORDERS');
  console.log('    delivery orders with NO geometry at all : ' + out.deliveryWithNoGeo);
  console.log('    delivery orders with NO address text    : ' + out.deliveryWithNoText);

  console.log('\n  "sole source" = orders where that field was the ONLY destination present.');
  console.log('  A field with a non-zero sole-source count CANNOT be dropped without data loss.');
  console.log('\n' + '='.repeat(76) + '\n');
})().catch((e) => { console.error('CENSUS ERROR:', e && e.message); process.exit(1); });
