'use strict';
/**
 * SOKONI Application Lifecycle — the ONE convergence point between an
 * application/request and the canonical registries that make an approved
 * applicant discoverable, dispatchable and contactable.
 *
 * ── Why this module exists ──────────────────────────────────────────────────
 * Approval used to be a dead end. Every intake surface wrote a document into
 * `applications` and every dashboard then flipped `status` to 'approved' from
 * the browser — and that was all that happened. Nothing projected the approved
 * applicant onto the registry that customers actually read, so:
 *
 *   • a cleaning company approved in the admin dashboard never appeared in the
 *     service directory or in global search (no `providers/{uid}` document);
 *   • an approved rider was never dispatchable (`drivers` / `rideDrivers` were
 *     empty, so `dispatch.js` ranked zero riders and reported 'exhausted');
 *   • re-approving, suspending or reversing a decision changed nothing.
 *
 * Observed in production on 2026-07-30: `applications` held 3 documents, one of
 * them ('Langa'ta mamafua', uid H7p6ktBH…) already `approved` — yet its business
 * name never reached `providers/{uid}`. It appeared in the directory only because
 * the same person had separately self-registered under a different name.
 *
 * ── The contract ────────────────────────────────────────────────────────────
 * `applications` is the REQUEST. The registries are the TRUTH:
 *
 *   provider / business / professional →  providers/{uid}
 *   driver / rider                    →  drivers/{uid} + rideDrivers/{uid}
 *
 * Approval projects request → registry. Rejection / suspension retracts it.
 * The projection is the ONLY writer of that transition, it is server-side, and
 * it is idempotent — so a retried trigger, a double-click in the dashboard or a
 * later reconcile run all converge on the same document.
 *
 * ── Indexing is part of the projection, not a follow-up ─────────────────────
 * `sokoni-providers.js` reads `providers` with `orderBy('updatedAt','desc')` and
 * global search reads `searchableTerms`/`nameLower`. A projection that omits
 * `updatedAt` silently self-invisibles the provider it just approved — which is
 * exactly the bug in `moderation.html`'s old approve path. So every projection
 * here stamps `updatedAt` and builds terms through the SHARED generator
 * (`./search-terms`), the same one `indexProviderCreate`/`indexProviderUpdate`
 * use. Identical output means those triggers' idempotency guards no-op instead
 * of thrashing against this write. Indexing is therefore automatic on approval
 * with no second hop required.
 *
 * ── Data protection ─────────────────────────────────────────────────────────
 * `rideDrivers` is readable by ANY signed-in user (firestore.rules), and
 * `providers` is world-readable when active. Identity documents therefore never
 * enter either. National ID / licence numbers are projected into
 * `driverVerification/{uid}`, which is CF-write / admin-read only, consistent
 * with `providerVerification` and the ODPC evaluation of high-sensitivity
 * identifiers. Only operational fields (name, phone, plate, vehicle) reach the
 * dispatch record — the phone because dispatch and the customer's tracking view
 * require it.
 *
 * Exports (all re-exported by name from functions/index.js):
 *   applicationLifecycle   Firestore trigger  applications/{appId}
 *   applicationDecide      onCall  (admin)    server-authoritative decision
 *   applicationReconcile   onCall  (admin)    re-run projection / repair drift
 *   applicationList        onCall  (admin)    ONE canonical read for dashboards
 */

const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const logger = require('firebase-functions/logger');

const REGION = 'us-central1';
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();

/* Intake normalizer version. Bump when the normalizer learns a new field so
   existing documents are re-normalized exactly once on their next write. */
const INTAKE_VERSION = 1;

/* ─────────────────────────────────────────────────────────────────────────────
   Sanitisation helpers
   ────────────────────────────────────────────────────────────────────────── */
const _san = (v, n = 200) => String(v == null ? '' : v).slice(0, n).replace(/[<>"']/g, '').trim();

/* ── Human-readable text: strip markup characters, KEEP the apostrophe ────────
   The platform-wide `_san` deletes `'` along with `<>"`. For structural fields
   that is harmless, but for a name or a place it silently corrupts real data:
   "Langa'ta canivor, Nairobi" was being stored as "Langata canivor" and
   "Murang'a" becomes "Muranga" — a different, wrong word. Apostrophes are
   ordinary in Kenyan place and personal names (Murang'a, Langa'ta, Ng'ang'a),
   which is why KE_COUNTIES below has to carry both spellings.

   An apostrophe is not an injection vector on its own: `<`, `>` and `"` are
   removed here, and every dashboard renders these fields through its HTML
   escaper (`h()` / `esc()`). The rule is escape-on-output, not mutilate-on-input
   — mutilating the input loses the applicant's actual name and still leaves the
   output path responsible for escaping. Used for name / location / city / area /
   description; `_san` stays for ids, slugs, plates and phone numbers. */
const _sanText = (v, n = 200) => String(v == null ? '' : v).slice(0, n).replace(/[<>"]/g, '').trim();

/* ── Kenyan phone → E.164 ────────────────────────────────────────────────────
   The platform stores contact numbers in TWO shapes and they are not
   interchangeable: `phone` as the operator typed it (0726043059) and
   `phoneNumber` in E.164 (+254726043059). `_findUserByPhone` and every SMS
   path key on the E.164 form, so an application that carries only the local
   form cannot be messaged. Both are derived here, once, on intake.

   Accepts: 0726043059 · 726043059 · 254726043059 · +254726043059 · spaced /
   dashed variants. Returns null when the input cannot be a Kenyan mobile —
   null is honest; a malformed number that looks valid is worse than none. */
function toE164KE(raw) {
  const d = String(raw == null ? '' : raw).replace(/\D/g, '');
  if (!d) return null;
  let local = null;
  if (/^0[17]\d{8}$/.test(d)) local = d.slice(1);          // 07XXXXXXXX / 01XXXXXXXX
  else if (/^[17]\d{8}$/.test(d)) local = d;               // 7XXXXXXXX  / 1XXXXXXXX
  else if (/^254[17]\d{8}$/.test(d)) local = d.slice(3);   // 254…
  else if (/^2540[17]\d{8}$/.test(d)) local = d.slice(4);  // 2540… (double-prefixed)
  if (!local) return null;
  return '+254' + local;
}

/* Local 0-prefixed form, for the WhatsApp/tel links the dashboards render. */
function toLocalKE(raw) {
  const e = toE164KE(raw);
  return e ? '0' + e.slice(4) : null;
}

/* ── Location → { location, city, area } ─────────────────────────────────────
   Applications carry ONE free-text location ("Nairobi/Kilimani",
   "Langa'ta canivor, Nairobi", "Roysambu Trm"). The directory filters and the
   search-term generator both want a `city`, so the county is extracted rather
   than guessed: the string is matched against the 47 gazetted counties in any
   position, and whatever remains becomes the area. When no county is present
   the whole string stays as `location` and `city` is left empty — an empty city
   is a truthful "not stated", whereas defaulting to Nairobi would invent a
   fact the applicant never supplied. */
const KE_COUNTIES = [
  'Mombasa', 'Kwale', 'Kilifi', 'Tana River', 'Lamu', 'Taita Taveta', 'Garissa',
  'Wajir', 'Mandera', 'Marsabit', 'Isiolo', 'Meru', 'Tharaka Nithi', 'Embu',
  'Kitui', 'Machakos', 'Makueni', 'Nyandarua', 'Nyeri', 'Kirinyaga', 'Muranga',
  "Murang'a", 'Kiambu', 'Turkana', 'West Pokot', 'Samburu', 'Trans Nzoia',
  'Uasin Gishu', 'Elgeyo Marakwet', 'Nandi', 'Baringo', 'Laikipia', 'Nakuru',
  'Narok', 'Kajiado', 'Kericho', 'Bomet', 'Kakamega', 'Vihiga', 'Bungoma',
  'Busia', 'Siaya', 'Kisumu', 'Homa Bay', 'Migori', 'Kisii', 'Nyamira',
  'Nairobi',
];

function splitLocation(raw) {
  const location = _sanText(raw, 200);
  if (!location) return { location: '', city: '', area: '' };
  const lower = location.toLowerCase();
  let city = '';
  for (const c of KE_COUNTIES) {
    const cl = c.toLowerCase();
    /* Word-boundary match so "Kisii" does not match inside another word. */
    if (new RegExp('(^|[^a-z])' + cl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(lower)) {
      city = c;
      break;
    }
  }
  let area = location;
  if (city) {
    area = location
      .replace(new RegExp(city.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), '')
      .replace(/^[\s,/|·-]+|[\s,/|·-]+$/g, '')
      .trim();
  }
  return { location, city, area };
}

/* ── Role router ─────────────────────────────────────────────────────────────
   Real intake documents do NOT agree on a vocabulary. Production holds
   type:'business' + category:'cleaning' from one surface and
   type:'Cleaning Company / Housekeeper' + category:'Service Provider' +
   hub:'service' from another. Routing on `type` alone therefore drops whole
   surfaces on the floor. Every descriptive field is pooled and matched on
   keywords instead, most specific class first.

   `by` records HOW the role was decided. A role decided by 'default' is still
   applied (a stalled application helps nobody) but it is reported, so an
   unrecognised intake vocabulary surfaces as an admin alert rather than as a
   silently mis-filed applicant. */
function resolveRole(app) {
  const hay = [
    app.role, app.type, app.applicationType, app.category, app.categoryLabel,
    app.hub, app.professionalType, app.businessType, app.serviceType,
  ].filter(Boolean).join(' ').toLowerCase();

  const test = (re) => re.test(hay);

  if (test(/\b(driver|rider|boda|bodaboda|courier|dispatch|delivery\s*(guy|partner|person))\b/)) {
    return { role: 'driver', by: 'keyword' };
  }
  if (test(/\b(law|legal|advocate|lawyer|attorney|notary)\b/)) return { role: 'legal', by: 'keyword' };
  if (test(/\b(health|healthcare|clinic|doctor|hospital|pharmac|dentist|nurse)\b/)) {
    return { role: 'health', by: 'keyword' };
  }
  if (test(/\b(seller|merchant|vendor|shop|store|retail|stockist|wholesal)\b/)) {
    return { role: 'seller', by: 'keyword' };
  }
  if (test(/\b(provider|professional|service|business|company|cleaning|housekeep|laundry|mama\s*fua|moving|relocat|salon|barber|dj|mc|plumb|electric|carpent|paint|tutor|photograph|caterer|mechanic)\b/)) {
    return { role: 'provider', by: 'keyword' };
  }
  /* Unrecognised vocabulary. `provider` is the platform's broadest listing
     class and the safest landing place, but the caller is told it was a guess. */
  return { role: 'provider', by: 'default' };
}

/* Dispatch capacity keys (sokoni-dispatch.js VEHICLE_CAPACITY). The driver
   wizard emits 'boda', which is NOT a capacity key — it fell through to the
   `moto` default for capacity but scored only 0.7 on vehicleMatch against a
   delivery's default 'moto', quietly de-ranking every boda rider. Mapped here
   so the dispatch engine sees a key it actually knows. */
const VEHICLE_MAP = {
  boda: 'moto', bodaboda: 'moto', motorbike: 'moto', motorcycle: 'moto', moto: 'moto',
  bicycle: 'bicycle', bike: 'bicycle', ebike: 'ebike',
  tuktuk: 'tuktuk', 'tuk-tuk': 'tuktuk',
  car: 'car', van: 'van', truck: 'truck', pickup: 'van', lorry: 'truck',
};
const normVehicle = (v) => VEHICLE_MAP[String(v || '').toLowerCase().replace(/\s+/g, '')] || 'moto';

/* Canonical decision states. Intake surfaces emit 'pending',
   'pending_verification', 'pending_review', 'submitted', 'info_requested'. */
function canonStatus(s) {
  const v = String(s || 'pending').toLowerCase();
  if (['approved', 'active', 'accepted', 'verified'].includes(v)) return 'approved';
  if (['rejected', 'declined', 'denied'].includes(v)) return 'rejected';
  if (['suspended', 'revoked', 'banned', 'disabled'].includes(v)) return 'suspended';
  return 'pending';
}

/* ─────────────────────────────────────────────────────────────────────────────
   PHASE 1 — Intake normalisation
   Returns a merge patch, or null when the document already satisfies the
   current INTAKE_VERSION. Returning null is what terminates the trigger loop.
   ────────────────────────────────────────────────────────────────────────── */
async function buildIntakePatch(app, appId) {
  if (app.intakeVersion === INTAKE_VERSION) return null;

  const patch = { intakeVersion: INTAKE_VERSION, normalizedAt: _ts() };

  /* ── Contact number ───────────────────────────────────────────────────────
     The driver wizard collected an M-Pesa number and never wrote `phone`, so
     the admin card rendered "—" and its WhatsApp / approve buttons built a
     number from an empty string and refused with "No valid phone number". Any
     field that is in practice a reachable number is accepted, in preference
     order, and both canonical shapes are derived. */
  const rawPhone = app.phone || app.phoneNumber || app.mpesa || app.mpesaNumber
                || app.contactPhone || app.tel || null;
  let e164 = toE164KE(rawPhone);

  /* Fall back to the account's own verified number. An application with no
     reachable number cannot be identity-checked by a phone call, which is the
     whole point of collecting it. */
  if (!e164 && app.uid) {
    const uSnap = await _db().collection('users').doc(app.uid).get().catch(() => null);
    const u = uSnap && uSnap.exists ? uSnap.data() : null;
    if (u) {
      e164 = toE164KE(u.phoneNumber || u.phone);
      if (e164) patch.phoneSource = 'account';
    }
  }
  if (e164) {
    patch.phoneNumber = e164;                       // +254…  (canonical / SMS)
    patch.phone = toLocalKE(e164);                  // 07…    (display / WhatsApp)
    patch.phoneVerifiable = true;
  } else {
    patch.phoneVerifiable = false;
    patch.contactGap = 'no_reachable_phone';
  }

  /* ── Location ─────────────────────────────────────────────────────────────
     A reviewer has to be able to place the applicant. Free text is kept
     verbatim and a county/area split is derived alongside it. */
  const rawLoc = app.location || app.locationText || app.area || app.county
              || app.city || app.address || '';
  const loc = splitLocation(rawLoc);
  patch.location = loc.location;
  patch.city = loc.city;
  patch.area = loc.area;

  /* GPS, when the surface captured it (the driver wizard does). Kept as a
     nested `geo` block so it travels with the projection and a reviewer can
     open a map pin. Only real coordinates are stored — never a placeholder. */
  const lat = Number(app.lat != null ? app.lat : (app.geo && app.geo.lat));
  const lng = Number(app.lng != null ? app.lng : (app.geo && app.geo.lng));
  if (Number.isFinite(lat) && Number.isFinite(lng) && (lat !== 0 || lng !== 0)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
    patch.geo = { lat, lng };
    patch.hasGeo = true;
  } else {
    patch.hasGeo = false;
  }
  if (!patch.location && !patch.hasGeo) patch.locationGap = 'no_location';

  /* ── Applicant name ─────────────────────────────────────────────────────── */
  const name = _sanText(app.name || app.businessName || app.fullName || app.displayName, 160);
  if (name) patch.name = name;
  patch.nameLower = name.toLowerCase();

  /* ── Role + ordering ──────────────────────────────────────────────────────
     `submittedAt` arrived as an ISO string from one surface and as "30/07/2026"
     from another. A dashboard that orders on it gets nonsense, so a single
     server-stamped `receivedAt` becomes the ordering key and the original value
     is preserved untouched for the audit trail. */
  const r = resolveRole(app);
  patch.role = r.role;
  patch.roleResolvedBy = r.by;
  patch.statusCanonical = canonStatus(app.status);
  if (!app.receivedAt) patch.receivedAt = _ts();
  if (!app.applicationId) patch.applicationId = appId;

  return { patch, roleResolvedBy: r.by, role: r.role };
}

/* ─────────────────────────────────────────────────────────────────────────────
   PHASE 2 — Projections
   Each projector is idempotent and NEVER clobbers values the registry owns
   (ratings, review counts, admin flags) — those are read first and only
   seeded when the document does not yet exist.
   ────────────────────────────────────────────────────────────────────────── */

function buildProviderTerms(p) {
  return require('./search-terms').buildSearchTerms(p);
}

const PRV_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
async function genProviderId(db) {
  for (let i = 0; i < 5; i++) {
    const id = 'PRV-' + Array.from({ length: 8 }, () => PRV_CHARS[Math.floor(Math.random() * PRV_CHARS.length)]).join('');
    const snap = await db.collection('providers').where('providerId', '==', id).limit(1).get();
    if (snap.empty) return id;
  }
  throw new HttpsError('internal', 'Could not generate a unique provider ID.');
}

/**
 * providers/{uid} — the canonical discovery registry. This document is what
 * global search, providers.html, services.html, every hub page and the homepage
 * strip read. Written to make an approved applicant visible AND findable in one
 * commit: status + searchable + updatedAt (the directory's orderBy) + the
 * search index, all together.
 */
async function projectProvider(db, app, uid, approved) {
  const ref = db.collection('providers').doc(uid);
  const snap = await ref.get();
  const existing = snap.exists ? snap.data() : {};

  if (!approved) {
    /* Retraction, not deletion. The record and its history survive so the same
       applicant can be reinstated without re-entering anything. */
    if (!snap.exists) return { collection: 'providers', id: uid, action: 'noop_absent' };
    await ref.set({
      status: 'suspended', searchable: false, isPublic: false,
      available: false, acceptsBookings: false,
      suspendedAt: _ts(), updatedAt: _ts(),
    }, { merge: true });
    return { collection: 'providers', id: uid, action: 'retracted' };
  }

  const providerId = existing.providerId
    || (/^PRV/i.test(String(app.applicationId || app.id || '')) ? String(app.applicationId || app.id) : null)
    || await genProviderId(db);

  const name = _sanText(app.name || app.businessName || app.fullName, 160);
  const description = _sanText(app.description || app.bio || app.services || app.about, 2000);
  const categoryLabel = _sanText(app.categoryLabel || app.type, 120);
  /* Both the machine slug and the human label are indexed, because they carry
     different words and customers type the words. `categories` is one of the
     fields buildSearchTerms reads; `categoryLabel` is NOT — so the label has to
     be a member of this array or it never reaches the index.

     This must use the RESOLVED `categoryLabel` above, not `app.categoryLabel`.
     Kasindi's application carried category:'Service Provider' with the useful
     words in `type` ('Cleaning Company / Housekeeper') and no `categoryLabel`
     field at all; reading the raw field indexed only "Service Provider", so a
     search for "cleaning" did not find a cleaning company. Verified against the
     live document. */
  const categories = [app.category, categoryLabel, app.subcategory, app.professionalType]
    .map(c => _sanText(c, 120)).filter(Boolean)
    .filter((c, i, a) => a.findIndex(x => x.toLowerCase() === c.toLowerCase()) === i);

  const doc = {
    uid, providerId,
    name,
    category: categories[0] || '',
    categories,
    categoryLabel,
    description,
    location: _sanText(app.location, 200),
    city: _sanText(app.city, 100),
    area: _sanText(app.area, 120),
    /* Contact — both shapes, so the directory card, the tel: link and the SMS
       path all read a field that is actually populated. */
    phone: _san(app.phone, 24),
    phoneNumber: _san(app.phoneNumber, 24),
    email: _san(app.email, 200),
    /* Visibility. `updatedAt` is NOT decoration: sokoni-providers.js orders by
       it and drops documents that lack it, so omitting it here would approve a
       provider into invisibility. */
    status: 'active',
    searchable: true,
    isPublic: true,
    available: true,
    acceptsBookings: true,
    /* Automatic indexing, in the same commit as the visibility flip. Built from
       the merged view through the SHARED generator so indexProviderUpdate's
       idempotency guard no-ops instead of racing this write. */
    nameLower: name.toLowerCase(),
    approvedAt: _ts(),
    updatedAt: _ts(),
    sourceApplicationId: app.applicationId || null,
  };
  if (app.geo) doc.geo = app.geo;
  doc.searchableTerms = buildProviderTerms({ ...existing, ...doc });

  /* Seed counters only on first creation — never reset a live provider's
     rating or completed-job history by re-approving them. */
  if (!snap.exists) {
    doc.rating = 0; doc.reviewCount = 0; doc.jobsCompleted = 0;
    doc.featured = false;
    doc.publishedAt = _ts();
    doc.createdAt = _ts();
  }

  await ref.set(doc, { merge: true });
  return { collection: 'providers', id: uid, action: snap.exists ? 'updated' : 'created', providerId };
}

/**
 * drivers/{uid} + rideDrivers/{uid} — the dispatch records.
 *
 * TWO documents because two engines read two collections: `dispatch.js` ranks
 * `rideDrivers` (where isOnline == true) while `navigation.js` and
 * `admin-os.js` read `drivers`. Writing only one leaves the rider dispatchable
 * by one engine and invisible to the other.
 *
 * The rider is created OFFLINE (isOnline / available false). Approval grants the
 * right to work; it does not put a rider on the road who has not opened the app
 * and shared live GPS. Rating and acceptanceRate are deliberately NOT written —
 * sokoni-dispatch.js applies its own neutral defaults, and inventing a 4.0 for
 * someone who has completed no deliveries would be fabricated performance data.
 */
async function projectDriver(db, app, uid, approved) {
  const rideRef = db.collection('rideDrivers').doc(uid);
  const drvRef = db.collection('drivers').doc(uid);
  const [rideSnap, drvSnap] = await Promise.all([rideRef.get(), drvRef.get()]);

  if (!approved) {
    const batch = db.batch();
    if (rideSnap.exists) {
      batch.set(rideRef, {
        status: 'suspended', isOnline: false, online: false,
        suspendedAt: _ts(), updatedAt: _ts(),
      }, { merge: true });
    }
    if (drvSnap.exists) {
      batch.set(drvRef, {
        status: 'suspended', available: false, onlineStatus: 'offline',
        suspendedAt: _ts(), updatedAt: _ts(),
      }, { merge: true });
    }
    await batch.commit();
    return { collection: 'drivers+rideDrivers', id: uid, action: rideSnap.exists || drvSnap.exists ? 'retracted' : 'noop_absent' };
  }

  const name = _sanText(app.name || app.fullName, 160);
  const vehicleType = normVehicle(app.vehicleType);
  const plate = _san(app.plate || app.plateNumber, 20).toUpperCase();

  /* Operational fields only. `rideDrivers` is readable by every signed-in user
     (firestore.rules), so National ID and licence numbers must not appear here
     — they go to driverVerification/{uid} below. */
  const rideDoc = {
    uid,
    name,
    phone: _san(app.phone, 24),
    phoneNumber: _san(app.phoneNumber, 24),
    vehicleType,
    vehicleLabel: _sanText(app.vehicleType, 40),
    plate,
    model: _sanText(app.model, 80),
    status: 'active',
    isOnline: false,
    online: false,
    activeDeliveries: 0,
    approvedAt: _ts(),
    updatedAt: _ts(),
    sourceApplicationId: app.applicationId || null,
  };
  /* Only real, validated coordinates — scoreRider rejects a rider without
     lat/lng, and a placeholder would put them at 0°,0°. */
  if (app.geo) { rideDoc.lat = app.geo.lat; rideDoc.lng = app.geo.lng; }
  if (!rideSnap.exists) { rideDoc.createdAt = _ts(); rideDoc.completedDeliveries = 0; }

  const drvDoc = {
    uid,
    name,
    phone: _san(app.phone, 24),
    phoneNumber: _san(app.phoneNumber, 24),
    vehicleType,
    plate,
    status: 'active',
    available: false,
    onlineStatus: 'offline',
    payoutFrequency: ['daily', 'weekly'].includes(app.payoutFrequency) ? app.payoutFrequency : 'daily',
    city: _sanText(app.city, 100),
    location: _sanText(app.location, 200),
    approvedAt: _ts(),
    updatedAt: _ts(),
    sourceApplicationId: app.applicationId || null,
  };
  if (!drvSnap.exists) { drvDoc.createdAt = _ts(); drvDoc.completedDeliveries = 0; }

  const batch = db.batch();
  batch.set(rideRef, rideDoc, { merge: true });
  batch.set(drvRef, drvDoc, { merge: true });

  /* Restricted verification record. Documents the rider supplied are held here
     — CF-write / admin-read — and flagged when absent so a reviewer knows what
     still has to be collected rather than assuming it was checked. */
  const missing = [];
  if (!app.nationalId) missing.push('nationalId');
  if (!app.dlNumber) missing.push('dlNumber');
  if (!plate) missing.push('plate');
  if (!app.vehicleType) missing.push('vehicleType');
  batch.set(db.collection('driverVerification').doc(uid), {
    uid,
    nationalId: _san(app.nationalId, 40) || null,
    dlNumber: _san(app.dlNumber, 60) || null,
    dlExpiry: _san(app.dlExpiry, 20) || null,
    plate: plate || null,
    documentsMissing: missing,
    documentsComplete: missing.length === 0,
    status: missing.length === 0 ? 'verified_on_file' : 'incomplete',
    sourceApplicationId: app.applicationId || null,
    updatedAt: _ts(),
  }, { merge: true });

  await batch.commit();
  return {
    collection: 'drivers+rideDrivers', id: uid,
    action: rideSnap.exists ? 'updated' : 'created',
    documentsMissing: missing,
  };
}

/* Roles the platform already owns elsewhere. Projecting them from here would
   duplicate an existing pipeline (sellers has its own onboarding + ade trigger;
   healthProviders and legalProviders have their own registries), so the role is
   recorded, the account is granted its role, and the projection is reported as
   delegated instead of being silently skipped. */
const DELEGATED_ROLES = { seller: 'sellers', health: 'healthProviders', legal: 'legalProviders' };

/* Account roles. `roles` must be written as an ARRAY — a provider whose account
   carries only `isProvider: true` lands in the app as a buyer, and the analytics
   gate reads `roles` (array), not a `role` string. Both the array and the
   legacy booleans are maintained so no existing reader breaks. */
async function grantAccountRole(db, uid, role, approved) {
  const ROLE_KEY = { provider: 'provider', driver: 'rider', seller: 'seller', health: 'provider', legal: 'provider' };
  const key = ROLE_KEY[role] || 'provider';
  const ref = db.collection('users').doc(uid);
  const patch = { updatedAt: _ts() };

  if (approved) {
    patch.roles = FieldValue.arrayUnion(key);
    patch[`registeredAs.${key}`] = true;
    patch.approved = true;
    patch.approvedAt = _ts();
    if (role === 'provider') patch.isProvider = true;
    if (role === 'driver') { patch.isDriver = true; patch.isRider = true; }
  } else {
    /* The role is removed but the account is untouched otherwise — a rejected
       provider is still a customer. */
    patch.roles = FieldValue.arrayRemove(key);
    patch[`registeredAs.${key}`] = false;
    if (role === 'provider') patch.isProvider = false;
    if (role === 'driver') { patch.isDriver = false; patch.isRider = false; }
  }
  await ref.set(patch, { merge: true });

  /* Auth custom claims mirror the grant so security rules and the client gate
     agree without a Firestore read. Best-effort: a claim failure must not
     abort a projection that already succeeded. */
  try {
    const auth = getAuth();
    const user = await auth.getUser(uid);
    const claims = { ...(user.customClaims || {}) };
    if (role === 'provider' || role === 'health' || role === 'legal') claims.provider = !!approved;
    if (role === 'driver') { claims.driver = !!approved; claims.rider = !!approved; }
    if (role === 'seller') claims.seller = !!approved;
    await auth.setCustomUserClaims(uid, claims);
  } catch (e) {
    logger.warn('[appLifecycle] claim update skipped', { uid, role, error: e.message });
  }
  return key;
}

/**
 * Apply a decision. Returns a receipt describing exactly what was written —
 * the dashboards show it, and `applicationReconcile` returns it so a repair run
 * produces evidence rather than a bare "ok".
 */
async function applyDecision(appId, app, opts = {}) {
  const db = _db();
  const status = canonStatus(app.status);
  const approved = status === 'approved';
  const role = app.role || resolveRole(app).role;
  const uid = app.uid;

  if (!uid) {
    /* Anonymous application. Nothing can be granted to nobody — this is
       reported, not swallowed, because it is the one failure a reviewer can
       actually fix (by asking the applicant to sign in and re-submit). */
    await db.collection('applications').doc(appId).set({
      projectionStatus: 'blocked_no_uid',
      projectionError: 'Application has no uid — cannot grant a role or create a registry record.',
      decisionAppliedFor: status,
      decisionAppliedAt: _ts(),
    }, { merge: true });
    logger.warn('[appLifecycle] application has no uid', { appId });
    return { ok: false, reason: 'no_uid', appId };
  }

  const receipt = { appId, uid, role, status, writes: [] };

  try {
    if (role === 'driver') {
      receipt.writes.push(await projectDriver(db, app, uid, approved));
    } else if (DELEGATED_ROLES[role]) {
      receipt.writes.push({ collection: DELEGATED_ROLES[role], id: uid, action: 'delegated' });
    } else {
      receipt.writes.push(await projectProvider(db, app, uid, approved));
    }

    /* A pending application must not grant anything; only a decision does. */
    if (status === 'approved' || status === 'rejected' || status === 'suspended') {
      receipt.roleKey = await grantAccountRole(db, uid, role, approved);
    }

    await db.collection('applications').doc(appId).set({
      statusCanonical: status,
      decisionAppliedFor: status,
      decisionAppliedAt: _ts(),
      projectionStatus: 'applied',
      projectionError: FieldValue.delete(),
      projectionReceipt: receipt.writes,
      ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}),
    }, { merge: true });

    /* Tell the applicant. notify.js is the single entry point (it owns channel
       selection, quiet hours and dedupe) so this is one call, not a bespoke
       SMS. dedupeKey makes a retried trigger silent rather than spammy. */
    if (status === 'approved') {
      try {
        const { notify } = require('./notify');
        await notify({
          uid,
          type: role === 'driver' ? 'rider_approved' : 'merchant_approved',
          title: 'You are approved on SOKONI',
          body: role === 'driver'
            ? 'Your rider application is approved. Open the SOKONI driver app and go online to start receiving deliveries.'
            : `${app.name || 'Your business'} is now live on SOKONI and customers can find you in search.`,
          phone: app.phoneNumber || undefined,
          dedupeKey: `app_approved:${appId}`,
          data: { applicationId: appId, role },
        });
      } catch (e) {
        logger.warn('[appLifecycle] notify failed', { appId, error: e.message });
      }
    }

    /* Non-silent routing gap: an application whose role was guessed is applied
       AND raised, so an unknown intake vocabulary gets fixed rather than
       accumulating mis-filed applicants. */
    if (app.roleResolvedBy === 'default') {
      await db.collection('adminAlerts').add({
        kind: 'application_role_unresolved',
        severity: 'low',
        message: `Application ${appId} had no recognisable role vocabulary; routed to "${role}" by default.`,
        appId, uid, appliedRole: role,
        raw: { type: app.type || null, category: app.category || null, hub: app.hub || null },
        createdAt: _ts(),
      }).catch(() => {});
    }

    logger.info('[appLifecycle] decision applied', { appId, uid, role, status, writes: receipt.writes });
    return { ok: true, ...receipt };
  } catch (e) {
    /* A failed projection is recorded ON the application so the dashboard can
       show "approved but not published" instead of a green tick over a
       half-applied decision. */
    await db.collection('applications').doc(appId).set({
      projectionStatus: 'failed',
      projectionError: String(e.message || e).slice(0, 500),
      decisionAppliedFor: FieldValue.delete(),
      decisionAppliedAt: _ts(),
    }, { merge: true }).catch(() => {});
    logger.error('[appLifecycle] projection failed', { appId, uid, role, status, error: e.message });
    throw e;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   TRIGGER — applications/{appId}
   Settles in at most two extra hops: normalise (1), project (1), then every
   guard short-circuits.
   ────────────────────────────────────────────────────────────────────────── */
exports.applicationLifecycle = onDocumentWritten(
  { document: 'applications/{appId}', region: REGION, timeoutSeconds: 120, memory: '256MiB' },
  async (event) => {
    const after = event.data?.after?.exists ? event.data.after.data() : null;
    if (!after) return;                                  // deleted
    const appId = event.params.appId;

    /* Phase 1 — normalise. One write, then this branch is never taken again. */
    const norm = await buildIntakePatch(after, appId);
    if (norm) {
      await event.data.after.ref.set(norm.patch, { merge: true });
      logger.info('[appLifecycle] intake normalised', {
        appId, role: norm.role, by: norm.roleResolvedBy,
        phone: !!norm.patch.phoneNumber, location: !!norm.patch.location,
      });
      return;                                            // re-fires with the patch applied
    }

    /* Phase 2 — project the decision, once per distinct decision. */
    const status = canonStatus(after.status);
    if (after.decisionAppliedFor === status && after.projectionStatus === 'applied') return;
    if (status === 'pending') return;                     // nothing to grant yet

    await applyDecision(appId, after, {});
  }
);

/* ─────────────────────────────────────────────────────────────────────────────
   onCall — server-authoritative decision
   The dashboards call THIS instead of writing three documents from a browser.
   A client-side approval could only ever be partial (and silently so, since
   every one of those writes was wrapped in an empty catch).
   ────────────────────────────────────────────────────────────────────────── */
function _requireAdmin(req) {
  if (!req.auth?.token?.admin && !req.auth?.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Administrator access required.');
  }
}

exports.applicationDecide = onCall(
  { region: REGION, maxInstances: 10, enforceAppCheck: true },
  async (req) => {
    _requireAdmin(req);
    const { applicationId, decision, reason } = req.data || {};
    if (!applicationId) throw new HttpsError('invalid-argument', '"applicationId" is required.');
    if (!['approve', 'reject', 'suspend', 'request_info'].includes(decision)) {
      throw new HttpsError('invalid-argument', 'decision must be approve | reject | suspend | request_info.');
    }

    const db = _db();
    const ref = db.collection('applications').doc(String(applicationId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Application not found.');

    const STATUS = { approve: 'approved', reject: 'rejected', suspend: 'suspended', request_info: 'info_requested' };
    const status = STATUS[decision];
    const actor = req.auth.uid;

    await ref.set({
      status,
      statusCanonical: canonStatus(status),
      reviewReason: _sanText(reason, 500) || null,
      decidedBy: actor,
      decidedAt: _ts(),
      /* Force re-projection even when the status is unchanged (a repair). */
      decisionAppliedFor: FieldValue.delete(),
      updatedAt: _ts(),
    }, { merge: true });

    /* Immutable admin audit trail. */
    await db.collection('adminAudit').add({
      action: `application_${decision}`,
      applicationId: String(applicationId),
      targetUid: snap.data().uid || null,
      performedBy: actor,
      reason: _sanText(reason, 500) || null,
      createdAt: _ts(),
    }).catch(() => {});

    if (status === 'info_requested') {
      return { ok: true, applicationId, status, projected: false };
    }

    /* Project synchronously so the caller gets a real receipt and the dashboard
       can report what actually happened — rather than optimistically painting a
       green tick and leaving the trigger to maybe catch up. */
    const fresh = { ...snap.data(), ...(await ref.get()).data() };
    const receipt = await applyDecision(String(applicationId), fresh, { decidedBy: actor });
    return { ok: true, applicationId, status, projected: true, receipt };
  }
);

/* Re-run the projection for an application whose registry record is missing or
   stale — the repair path for anything approved before this engine existed. */
exports.applicationReconcile = onCall(
  { region: REGION, maxInstances: 5, enforceAppCheck: true, timeoutSeconds: 300 },
  async (req) => {
    _requireAdmin(req);
    const { applicationId, all } = req.data || {};
    const db = _db();

    if (applicationId) {
      const snap = await db.collection('applications').doc(String(applicationId)).get();
      if (!snap.exists) throw new HttpsError('not-found', 'Application not found.');
      const app = snap.data();
      const norm = await buildIntakePatch(app, snap.id);
      if (norm) {
        await snap.ref.set(norm.patch, { merge: true });
        Object.assign(app, norm.patch);
      }
      return { ok: true, results: [await applyDecision(snap.id, app, { decidedBy: req.auth.uid })] };
    }

    if (!all) throw new HttpsError('invalid-argument', 'Pass "applicationId" or all:true.');

    /* Bounded sweep of decided applications. */
    const snap = await db.collection('applications').where('status', 'in', ['approved', 'active', 'verified']).limit(300).get();
    const results = [];
    for (const d of snap.docs) {
      const app = d.data();
      try {
        const norm = await buildIntakePatch(app, d.id);
        if (norm) { await d.ref.set(norm.patch, { merge: true }); Object.assign(app, norm.patch); }
        results.push(await applyDecision(d.id, app, { decidedBy: req.auth.uid }));
      } catch (e) {
        results.push({ ok: false, appId: d.id, error: e.message });
      }
    }
    return { ok: true, scanned: snap.size, results };
  }
);

/* ─────────────────────────────────────────────────────────────────────────────
   onCall — ONE canonical application read for every admin surface
   admin.html, super-admin.html and moderation.html each queried `applications`
   differently and two of the three were broken (one ordered on a field with no
   composite index and swallowed the failed-precondition into "No pending
   verifications"; another merged seeded localStorage demo rows into the live
   list). One server-side read, one shape, every dashboard.
   ────────────────────────────────────────────────────────────────────────── */
exports.applicationList = onCall(
  { region: REGION, maxInstances: 10, enforceAppCheck: true },
  async (req) => {
    _requireAdmin(req);
    const { status, role, limit = 200 } = req.data || {};
    const db = _db();

    /* Read unfiltered and filter in memory. The collection is administratively
       small (hundreds), and this needs no composite index — which is precisely
       what broke the moderation view. */
    const snap = await db.collection('applications').limit(Math.min(Number(limit) || 200, 500)).get();

    let items = snap.docs.map((d) => {
      const a = d.data();
      const st = canonStatus(a.status);
      return {
        id: d.id,
        applicationId: a.applicationId || d.id,
        uid: a.uid || null,
        name: a.name || a.businessName || a.fullName || '',
        role: a.role || resolveRole(a).role,
        rawType: a.type || '',
        category: a.category || '',
        categoryLabel: a.categoryLabel || '',
        status: st,
        statusRaw: a.status || 'pending',
        /* Identification block — what a reviewer needs in order to phone the
           applicant and confirm who they are. */
        phone: a.phone || '',
        phoneNumber: a.phoneNumber || '',
        phoneVerifiable: a.phoneVerifiable !== false,
        email: a.email || '',
        location: a.location || '',
        city: a.city || '',
        area: a.area || '',
        geo: a.geo || null,
        /* Vehicle / business detail for the review decision. */
        vehicleType: a.vehicleType || '',
        plate: a.plate || '',
        model: a.model || '',
        description: a.description || a.bio || '',
        /* Projection health — the difference between "approved" and "live". */
        projectionStatus: a.projectionStatus || (st === 'pending' ? 'n/a' : 'not_applied'),
        projectionError: a.projectionError || null,
        decisionAppliedFor: a.decisionAppliedFor || null,
        contactGap: a.contactGap || null,
        locationGap: a.locationGap || null,
        receivedAt: a.receivedAt ? (a.receivedAt.toMillis ? a.receivedAt.toMillis() : a.receivedAt) : null,
        submittedAtRaw: a.submittedAt || null,
        createdAt: a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : a.createdAt) : null,
      };
    });

    if (status) items = items.filter((i) => i.status === canonStatus(status));
    if (role) items = items.filter((i) => i.role === role);
    /* Newest first, on the server-stamped key with the legacy fields as
       fallbacks — never on `submittedAt`, whose format differs per surface. */
    items.sort((a, b) => (b.receivedAt || b.createdAt || 0) - (a.receivedAt || a.createdAt || 0));

    const counts = items.reduce((acc, i) => { acc[i.status] = (acc[i.status] || 0) + 1; return acc; }, {});
    const unpublished = items.filter(
      (i) => i.status === 'approved' && i.projectionStatus !== 'applied'
    ).length;

    return { ok: true, items, counts, unpublished, total: items.length };
  }
);

/* Internals exported for unit tests and for the reconcile script. */
exports._internal = {
  toE164KE, toLocalKE, splitLocation, resolveRole, canonStatus, normVehicle, _san, _sanText,
  buildIntakePatch, applyDecision, projectProvider, projectDriver,
  INTAKE_VERSION, KE_COUNTIES,
};
