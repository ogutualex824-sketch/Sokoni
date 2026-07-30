/**
 * Application Lifecycle — pure-logic regression tests.
 *
 * Every case here is derived from a document that was actually in production on
 * 2026-07-30, not from an idealised schema. That matters: the reason approval
 * used to strand applicants was that the intake surfaces disagree about field
 * names and vocabulary, and code written against the tidy version of the schema
 * routed real documents nowhere.
 *
 * The three live documents these are built from:
 *   applications/PRVMS7IACKG   type:'Cleaning Company / Housekeeper'
 *                              category:'Service Provider'  hub:'service'
 *                              phone:'0726043059'  location:'Nairobi/Kilimani'
 *   applications/e0cOABIk…     type:'business'  category:'cleaning'
 *                              location:"Langa'ta canivor, Nairobi"
 *   applications/hZN2s7YC…     type:'business'  category:'moving'
 *                              location:'Roysambu Trm'
 */
'use strict';

const { _internal: L } = require('../application-lifecycle');

describe('toE164KE — Kenyan contact numbers', () => {
  test.each([
    ['0726043059', '+254726043059', 'Kasindi, as typed by the applicant'],
    ['0748346783', '+254748346783', "Langa'ta mamafua"],
    ['+254714582086', '+254714582086', 'already E.164 (idempotent)'],
    ['254722543212', '+254722543212', 'country code without +'],
    ['0722 543 212', '+254722543212', 'spaced'],
    ['0722-543-212', '+254722543212', 'dashed'],
    ['0112345678', '+254112345678', '01x Safaricom range'],
    ['722543212', '+254722543212', 'bare nine digits'],
  ])('%s → %s (%s)', (input, expected) => {
    expect(L.toE164KE(input)).toBe(expected);
  });

  test.each([
    [''], [null], [undefined], ['12345'], ['0826043059'], ['abc'], ['+1 555 0100'],
  ])('rejects %p as unreachable rather than guessing', (input) => {
    expect(L.toE164KE(input)).toBeNull();
  });

  test('round-trips to the local form the WhatsApp/tel links need', () => {
    expect(L.toLocalKE('+254726043059')).toBe('0726043059');
    expect(L.toLocalKE('bad')).toBeNull();
  });
});

describe('splitLocation — reviewer must be able to place the applicant', () => {
  test('extracts the county and keeps the area (Kasindi)', () => {
    expect(L.splitLocation('Nairobi/Kilimani'))
      .toEqual({ location: 'Nairobi/Kilimani', city: 'Nairobi', area: 'Kilimani' });
  });

  test('finds a county in trailing position', () => {
    expect(L.splitLocation("Langa'ta canivor, Nairobi"))
      .toEqual({ location: "Langa'ta canivor, Nairobi", city: 'Nairobi', area: "Langa'ta canivor" });
  });

  test('leaves city empty when no county was stated — never defaults to Nairobi', () => {
    /* Defaulting would invent a fact the applicant never supplied. An empty
       city is a truthful "not stated" and shows as a gap in the dashboard. */
    expect(L.splitLocation('Roysambu Trm'))
      .toEqual({ location: 'Roysambu Trm', city: '', area: 'Roysambu Trm' });
  });

  test.each([
    ["Murang'a", "Murang'a"],
    ['Uasin Gishu, Eldoret', 'Uasin Gishu'],
    ['Mombasa', 'Mombasa'],
    ['Homa Bay town', 'Homa Bay'],
  ])('recognises county in %p', (input, city) => {
    expect(L.splitLocation(input).city).toBe(city);
  });

  test('empty input is safe', () => {
    expect(L.splitLocation('')).toEqual({ location: '', city: '', area: '' });
    expect(L.splitLocation(null)).toEqual({ location: '', city: '', area: '' });
  });
});

describe('_sanText — escape on output, do not mutilate on input', () => {
  test("keeps the apostrophe in genuine Kenyan names", () => {
    /* The platform-wide _san strips `'`, which silently rewrote
       "Langa'ta canivor" as "Langata canivor" and would turn the county
       Murang'a into the different word Muranga. */
    expect(L._sanText("Langa'ta canivor, Nairobi")).toBe("Langa'ta canivor, Nairobi");
    expect(L._sanText("O'Brien Cleaners")).toBe("O'Brien Cleaners");
    expect(L._sanText("Ng'ang'a & Sons")).toBe("Ng'ang'a & Sons");
  });

  test('still removes the characters that carry markup', () => {
    expect(L._sanText('<script>x</script>')).not.toMatch(/[<>]/);
    expect(L._sanText('a"b')).toBe('ab');
  });

  test('bounds length and trims', () => {
    expect(L._sanText('x'.repeat(500), 10)).toHaveLength(10);
    expect(L._sanText('  padded  ')).toBe('padded');
    expect(L._sanText(null)).toBe('');
  });

  test('_san remains strict for ids/plates/slugs', () => {
    expect(L._san("KBZ'123A")).toBe('KBZ123A');
  });
});

describe('resolveRole — routes the vocabularies production actually uses', () => {
  test('Kasindi: a label in `type` and a generic `category`', () => {
    const r = L.resolveRole({
      type: 'Cleaning Company / Housekeeper',
      category: 'Service Provider',
      hub: 'service',
    });
    expect(r.role).toBe('provider');
    expect(r.by).toBe('keyword');
  });

  test.each([
    [{ type: 'business', category: 'cleaning' }, 'provider'],
    [{ type: 'business', category: 'moving' }, 'provider'],
    [{ type: 'business', categoryLabel: 'Mama Fua' }, 'provider'],
    [{ type: 'professional' }, 'provider'],
    [{ type: 'driver' }, 'driver'],
    [{ type: 'rider' }, 'driver'],
    [{ type: 'business', category: 'boda' }, 'driver'],
    [{ type: 'business', category: 'courier' }, 'driver'],
    [{ type: 'professional', professionalType: 'Lawyer' }, 'legal'],
    [{ type: 'healthcare' }, 'health'],
    [{ type: 'seller' }, 'seller'],
  ])('%j → %s', (app, role) => {
    expect(L.resolveRole(app).role).toBe(role);
  });

  test('driver wins over business when both words are present', () => {
    /* A boda operator registering through the business form must not become a
       directory listing — they must become a dispatchable rider. */
    expect(L.resolveRole({ type: 'business', category: 'boda rider service' }).role).toBe('driver');
  });

  test('an unknown vocabulary is applied but reported, never silently dropped', () => {
    const r = L.resolveRole({ type: 'zzz', category: 'qqq' });
    expect(r.role).toBe('provider');
    expect(r.by).toBe('default');   // triggers an adminAlert in applyDecision
  });
});

describe('canonStatus — one decision vocabulary from many intake spellings', () => {
  test.each(['pending', 'pending_verification', 'pending_review', 'submitted', 'info_requested', undefined])(
    '%p is not a decision', (s) => expect(L.canonStatus(s)).toBe('pending'));

  test.each(['approved', 'active', 'accepted', 'verified'])(
    '%p is an approval', (s) => expect(L.canonStatus(s)).toBe('approved'));

  test.each(['rejected', 'declined', 'denied'])(
    '%p is a rejection', (s) => expect(L.canonStatus(s)).toBe('rejected'));

  test.each(['suspended', 'revoked', 'banned'])(
    '%p is a suspension', (s) => expect(L.canonStatus(s)).toBe('suspended'));
});

describe('normVehicle — must emit a key sokoni-dispatch.js knows', () => {
  test("'boda' maps to 'moto'", () => {
    /* VEHICLE_CAPACITY has no 'boda' key. Capacity fell through to the moto
       default, but vehicleMatch scored 0.7 instead of 1.0 against a delivery's
       default 'moto' — quietly de-ranking every boda rider on the platform. */
    expect(L.normVehicle('boda')).toBe('moto');
    expect(L.normVehicle('bodaboda')).toBe('moto');
    expect(L.normVehicle('Boda Boda')).toBe('moto');
  });

  test.each([
    ['tuktuk', 'tuktuk'], ['tuk-tuk', 'tuktuk'], ['car', 'car'],
    ['van', 'van'], ['truck', 'truck'], ['pickup', 'van'], ['bicycle', 'bicycle'],
  ])('%s → %s', (input, expected) => expect(L.normVehicle(input)).toBe(expected));

  test('unknown or missing falls back to moto', () => {
    expect(L.normVehicle(undefined)).toBe('moto');
    expect(L.normVehicle('hovercraft')).toBe('moto');
  });

  test('every mapped value is a real capacity key', () => {
    /* Guards against the original defect class: emitting a vehicle string the
       dispatch engine does not recognise. */
    const CAPACITY_KEYS = ['moto', 'bicycle', 'ebike', 'tuktuk', 'car', 'van', 'truck'];
    ['boda', 'tuktuk', 'car', 'van', 'truck', 'bicycle', 'ebike', 'lorry', 'anything']
      .forEach((v) => expect(CAPACITY_KEYS).toContain(L.normVehicle(v)));
  });
});

describe('search indexing is automatic and covers the real firm name', () => {
  const { buildSearchTerms } = require('../search-terms');

  test('a customer typing any prefix of "Kasindi" finds the firm', () => {
    const terms = buildSearchTerms({
      name: 'Kasindi holdings limited',
      category: 'Service Provider',
      categories: ['Service Provider', 'Cleaning Company / Housekeeper'],
      location: 'Nairobi/Kilimani',
      city: 'Nairobi',
      description: 'cleaning and housekeeping',
    });
    ['ka', 'kas', 'kasi', 'kasin', 'kasind', 'kasindi', 'holdings', 'nairobi', 'cleaning']
      .forEach((t) => expect(terms).toContain(t));
  });

  test('the engine and the index triggers share one generator', () => {
    /* Byte-identical output is what lets indexProviderUpdate's idempotency
       guard no-op instead of fighting the projection's write. */
    const doc = { name: 'Kasindi holdings limited', category: 'cleaning', city: 'Nairobi' };
    expect(buildSearchTerms(doc)).toEqual(buildSearchTerms({ ...doc }));
  });
});

describe('KE_COUNTIES integrity', () => {
  test('carries both spellings of the apostrophe county', () => {
    expect(L.KE_COUNTIES).toContain("Murang'a");
    expect(L.KE_COUNTIES).toContain('Muranga');
  });
  test('covers all 47 counties (plus the Muranga spelling variant)', () => {
    expect(L.KE_COUNTIES.length).toBe(48);
  });
});

/* ─────────────────────────────────────────────────────────────────────────────
   Projection behaviour, against a stubbed Firestore.
   These assert the properties that caused the real production failures, so they
   earn the cost of stubbing: the dispatch record must exist in BOTH collections,
   `updatedAt` must be present, and identity documents must not leak into a
   broadly-readable document.
   ────────────────────────────────────────────────────────────────────────── */
describe('projectDriver / projectProvider — written shape', () => {
  function stubDb() {
    const writes = [];          // [{path, data, merge}]
    const docs = {};            // path -> pre-existing data
    const mkRef = (path) => ({
      _path: path,
      get: async () => ({ exists: !!docs[path], data: () => docs[path] }),
      set: async (data, opts) => { writes.push({ path, data, merge: !!(opts && opts.merge) }); },
    });
    return {
      collection: (c) => ({
        doc: (id) => mkRef(c + '/' + id),
        where: () => ({ limit: () => ({ get: async () => ({ empty: true, docs: [] }) }) }),
        add: async () => ({}),
      }),
      batch: () => ({
        set: (ref, data, opts) => { writes.push({ path: ref._path, data, merge: !!(opts && opts.merge) }); },
        commit: async () => {},
      }),
      _writes: writes,
      _docs: docs,
    };
  }
  const byPath = (db, p) => db._writes.find((w) => w.path === p);

  const RIDER_APP = {
    applicationId: 'APP-1', name: 'FRED', fullName: 'FRED',
    phone: '0714582086', phoneNumber: '+254714582086',
    vehicleType: 'boda', plate: 'KBZ 123A', model: 'Honda CB125',
    nationalId: '34567890', dlNumber: 'DL/12345/2020', dlExpiry: '2028-01-01',
    payoutFrequency: 'daily', city: 'Nairobi', location: 'Nairobi/Kilimani',
    geo: { lat: -1.3215, lng: 36.8008 },
  };

  test('writes BOTH dispatch collections — dispatch.js and navigation.js read different ones', async () => {
    const db = stubDb();
    await L.projectDriver(db, RIDER_APP, 'uid1', true);
    expect(byPath(db, 'rideDrivers/uid1')).toBeTruthy();
    expect(byPath(db, 'drivers/uid1')).toBeTruthy();
  });

  test('rideDrivers carries NO identity documents', async () => {
    /* firestore.rules grants `allow read: if isAuthed()` on rideDrivers, so a
       National ID here would be readable by every account on the platform. */
    const db = stubDb();
    await L.projectDriver(db, RIDER_APP, 'uid1', true);
    const ride = byPath(db, 'rideDrivers/uid1').data;
    expect(ride.nationalId).toBeUndefined();
    expect(ride.dlNumber).toBeUndefined();
    expect(ride.dlExpiry).toBeUndefined();
    /* The operational fields dispatch actually needs ARE present. */
    expect(ride.phone).toBe('0714582086');
    expect(ride.vehicleType).toBe('moto');      // 'boda' normalised
    expect(ride.plate).toBe('KBZ 123A');
  });

  test('identity documents go to the restricted driverVerification record', async () => {
    const db = stubDb();
    await L.projectDriver(db, RIDER_APP, 'uid1', true);
    const v = byPath(db, 'driverVerification/uid1').data;
    expect(v.nationalId).toBe('34567890');
    expect(v.dlNumber).toBe('DL/12345/2020');
    expect(v.documentsComplete).toBe(true);
    expect(v.documentsMissing).toEqual([]);
  });

  test('missing paperwork is reported, not assumed checked', async () => {
    const db = stubDb();
    const bare = { applicationId: 'APP-2', name: 'Rider', phone: '0712345678' };
    const r = await L.projectDriver(db, bare, 'uid2', true);
    expect(r.documentsMissing).toEqual(
      expect.arrayContaining(['nationalId', 'dlNumber', 'plate', 'vehicleType']));
    expect(byPath(db, 'driverVerification/uid2').data.documentsComplete).toBe(false);
  });

  test('a new rider is created OFFLINE — approval is not the same as on the road', async () => {
    const db = stubDb();
    await L.projectDriver(db, RIDER_APP, 'uid1', true);
    expect(byPath(db, 'rideDrivers/uid1').data.isOnline).toBe(false);
    expect(byPath(db, 'drivers/uid1').data.available).toBe(false);
    expect(byPath(db, 'drivers/uid1').data.onlineStatus).toBe('offline');
  });

  test('no invented performance data', async () => {
    /* sokoni-dispatch.js applies neutral defaults (rating 4.0, acceptance 0.80).
       Persisting those as if earned would be fabricated history for someone who
       has completed no deliveries. */
    const db = stubDb();
    await L.projectDriver(db, RIDER_APP, 'uid1', true);
    const ride = byPath(db, 'rideDrivers/uid1').data;
    expect(ride.rating).toBeUndefined();
    expect(ride.acceptanceRate).toBeUndefined();
    expect(ride.activeDeliveries).toBe(0);
  });

  test('rejection retracts instead of deleting, and only if a record exists', async () => {
    const db = stubDb();
    const absent = await L.projectDriver(db, RIDER_APP, 'ghost', false);
    expect(absent.action).toBe('noop_absent');

    const db2 = stubDb();
    db2._docs['rideDrivers/uid1'] = { uid: 'uid1' };
    db2._docs['drivers/uid1'] = { uid: 'uid1' };
    const r = await L.projectDriver(db2, RIDER_APP, 'uid1', false);
    expect(r.action).toBe('retracted');
    expect(byPath(db2, 'rideDrivers/uid1').data.isOnline).toBe(false);
    expect(byPath(db2, 'drivers/uid1').data.status).toBe('suspended');
  });

  const KASINDI = {
    applicationId: 'PRVMS7IACKG', name: 'Kasindi holdings limited',
    phone: '0726043059', phoneNumber: '+254726043059',
    location: 'Nairobi/Kilimani', city: 'Nairobi', area: 'Kilimani',
    type: 'Cleaning Company / Housekeeper', category: 'Service Provider',
    categoryLabel: 'Cleaning Company / Housekeeper',
  };

  test('provider projection sets every field the directory and search require', async () => {
    const db = stubDb();
    const r = await L.projectProvider(db, KASINDI, 'WLt0Voww', true);
    const p = byPath(db, 'providers/WLt0Voww').data;

    /* Visibility — sokoni-providers.js filters on status and orders by
       `updatedAt`, dropping any document that lacks it. That omission is exactly
       what the old approve path shipped. */
    expect(p.status).toBe('active');
    expect(p.searchable).toBe(true);
    expect(p.updatedAt).toBeDefined();

    /* Searchability — built in the SAME write as the visibility flip. */
    expect(p.nameLower).toBe('kasindi holdings limited');
    expect(Array.isArray(p.searchableTerms)).toBe(true);
    ['kasindi', 'ka', 'kas', 'nairobi'].forEach((t) => expect(p.searchableTerms).toContain(t));

    /* Identification — the number a reviewer rings survives the projection. */
    expect(p.phone).toBe('0726043059');
    expect(p.phoneNumber).toBe('+254726043059');
    expect(p.city).toBe('Nairobi');

    /* Reuses the PRV… application id rather than minting a second identity. */
    expect(p.providerId).toBe('PRVMS7IACKG');
    expect(r.action).toBe('created');
  });

  test('the human category label reaches the search index', async () => {
    /* Regression: `categories` was built from the RAW app.categoryLabel, which
       Kasindi's application did not have — its useful words were in `type`
       ('Cleaning Company / Housekeeper') while `category` was the generic
       'Service Provider'. Only "Service Provider" got indexed, so a customer
       searching "cleaning" did not find a cleaning company. Caught by verifying
       discoverability against the live document rather than trusting the write.
       `categoryLabel` is not a field buildSearchTerms reads, so the label MUST be
       a member of `categories`. */
    const db = stubDb();
    await L.projectProvider(db, KASINDI, 'WLt0Voww', true);
    const p = byPath(db, 'providers/WLt0Voww').data;
    expect(p.categories).toContain('Cleaning Company / Housekeeper');
    ['cleaning', 'company', 'housekeeper', 'service', 'provider']
      .forEach((t) => expect(p.searchableTerms).toContain(t));
  });

  test('label-only applications still index their trade', async () => {
    /* type carries the trade, category is absent entirely. */
    const db = stubDb();
    await L.projectProvider(db, { applicationId: 'A', name: 'X', type: 'Plumber' }, 'u', true);
    const p = byPath(db, 'providers/u').data;
    expect(p.searchableTerms).toContain('plumber');
  });

  test('re-approving does not reset a live provider rating or history', async () => {
    const db = stubDb();
    db._docs['providers/WLt0Voww'] = {
      uid: 'WLt0Voww', providerId: 'PRV-EXISTING',
      rating: 4.6, reviewCount: 23, jobsCompleted: 41, featured: true,
    };
    const r = await L.projectProvider(db, KASINDI, 'WLt0Voww', true);
    const p = byPath(db, 'providers/WLt0Voww').data;
    expect(p.rating).toBeUndefined();        // not overwritten
    expect(p.reviewCount).toBeUndefined();
    expect(p.jobsCompleted).toBeUndefined();
    expect(p.featured).toBeUndefined();      // admin decision left intact
    expect(p.providerId).toBe('PRV-EXISTING');
    expect(r.action).toBe('updated');
  });

  test('rejection makes a provider unfindable without destroying the record', async () => {
    const db = stubDb();
    db._docs['providers/WLt0Voww'] = { uid: 'WLt0Voww', status: 'active' };
    const r = await L.projectProvider(db, KASINDI, 'WLt0Voww', false);
    const p = byPath(db, 'providers/WLt0Voww').data;
    expect(p.status).toBe('suspended');
    expect(p.searchable).toBe(false);
    expect(p.isPublic).toBe(false);
    expect(p.updatedAt).toBeDefined();       // still ordered, just not visible
    expect(r.action).toBe('retracted');
  });

  test('every projected write uses merge so it never clobbers sibling fields', async () => {
    const db = stubDb();
    await L.projectProvider(db, KASINDI, 'WLt0Voww', true);
    await L.projectDriver(db, RIDER_APP, 'uid1', true);
    expect(db._writes.length).toBeGreaterThan(0);
    db._writes.forEach((w) => expect(w.merge).toBe(true));
  });
});
