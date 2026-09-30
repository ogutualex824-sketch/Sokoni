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
/* Canonical role vocabulary (Roles Phase 1). The single definition of what an
   application may declare; see functions/role-vocabulary.js. */
const VOCAB = require('./role-vocabulary');
/* The ONE seller-trial authority. This module builds no trial payload of its own —
   two copies of a commercial entitlement drift, which is why seller-trial.js exists. */
const { startSellerFreeTrial } = require('./seller-trial');

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
  /* ── EXPLICIT FIRST (Roles Phase 1) ───────────────────────────────────────
     A surface that knows which role it is submitting says so. When it does, the
     keyword pattern below is not consulted at all — inference exists to read
     documents written before this field, not to second-guess a declaration.

     An unrecognised declaration is NOT resolved. It returns role:null, and the
     caller quarantines the application for a reviewer. That is the whole point
     of the change: the old code answered `provider` to every question it did not
     understand, so a landlord, a mechanic and a typo were indistinguishable
     once they reached the registry. A stalled application is visible and
     fixable; a silently mis-filed one is neither. */
  if (app.requestedRole !== undefined && app.requestedRole !== null && app.requestedRole !== '') {
    const canon = VOCAB.normalizeRole(app.requestedRole);
    if (canon) {
      return {
        role: canon,
        by: VOCAB.isCanonicalRole(app.requestedRole) ? 'explicit' : 'explicit-alias',
        requested: String(app.requestedRole),
      };
    }
    return { role: null, by: 'invalid-requested-role', requested: String(app.requestedRole) };
  }

  const hay = [
    app.role, app.type, app.applicationType, app.category, app.categoryLabel,
    app.hub, app.professionalType, app.businessType, app.serviceType,
  ].filter(Boolean).join(' ').toLowerCase();

  const test = (re) => re.test(hay);

  /* ── An EXPLICIT declaration beats keyword guessing ──────────────────────
     The keyword pool below matches on EVERY descriptive field, including the
     merchant's own product `category`. That is right for intakes whose `type` is
     prose ("Cleaning Company / Housekeeper"), and wrong for the ones that declare a
     canonical role — because `legal` and `health` are tested BEFORE `seller`, so a
     shop selling health or legal PRODUCTS was routed to a provider registry and never
     given a shop, a till or a storefront:

         { type:'seller', hub:'marketplace', category:'healthcare' }  ->  health
         { type:'seller', hub:'marketplace', category:'legal'      }  ->  legal

     Both are merchants. sokoni-merchant-application.js writes `type: 'seller'`
     deliberately as the intake vocabulary, and a stated intake must not be overridden
     by a guess about what the applicant sells.

     Matched EXACTLY, never as a substring, so prose types (hub-register.js writes
     `type: 'business'`) still fall through to the keyword pool and resolve as before. */
  const DECLARED_TYPES = {
    seller: 'seller', merchant: 'seller', vendor: 'seller',
    driver: 'driver', rider: 'driver',
    provider: 'provider', professional: 'provider',
    legal: 'legal', health: 'health',
  };
  const declared = String(app.type == null ? '' : app.type).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DECLARED_TYPES, declared)) {
    return { role: DECLARED_TYPES[declared], by: 'declared' };
  }

  /* LEGACY PATH ONLY. Everything below reads documents written before
     `requestedRole` existed. `by` is stamped 'legacy-*' so a reviewer can tell a
     derived role from a declared one at a glance, and so the migration's progress
     is measurable: when no application resolves by a legacy path any more, the
     inference can be deleted. Behaviour is deliberately UNCHANGED — an existing
     pending application must decide exactly as it would have yesterday. */
  if (test(/\b(driver|rider|boda|bodaboda|courier|dispatch|delivery\s*(guy|partner|person))\b/)) {
    return { role: 'driver', by: 'legacy-keyword' };
  }
  if (test(/\b(law|legal|advocate|lawyer|attorney|notary)\b/)) return { role: 'legal', by: 'legacy-keyword' };
  if (test(/\b(health|healthcare|clinic|doctor|hospital|pharmac|dentist|nurse)\b/)) {
    return { role: 'health', by: 'legacy-keyword' };
  }
  if (test(/\b(seller|merchant|vendor|shop|store|retail|stockist|wholesal)\b/)) {
    return { role: 'seller', by: 'legacy-keyword' };
  }
  if (test(/\b(provider|professional|service|business|company|cleaning|housekeep|laundry|mama\s*fua|moving|relocat|salon|barber|dj|mc|plumb|electric|carpent|paint|tutor|photograph|caterer|mechanic)\b/)) {
    return { role: 'provider', by: 'legacy-keyword' };
  }
  /* Unrecognised LEGACY vocabulary. `provider` remains the landing place for a
     document written before `requestedRole` existed — changing that would
     re-file applicants who are already in the registry under it. New
     applications never reach here: an unrecognised declaration is quarantined
     above rather than defaulted. */
  return { role: 'provider', by: 'legacy-default' };
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
  /* A role is only stamped when one was actually resolved. An unrecognised
     declaration leaves `role` untouched and records WHAT was asked for, so the
     admin card shows the applicant's own word instead of a null — and so nothing
     downstream reads a null as "no role yet" and re-derives it. */
  if (r.role) patch.role = r.role;
  patch.roleResolvedBy = r.by;
  if (r.by === 'invalid-requested-role') patch.requestedRoleInvalid = _san(r.requested || '', 60);
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

  /* ── Business identity is public; the owner's personal name is internal ──────
     A registry document can already carry a PERSON's name from a self-registration
     ("Ann") while the approved application carries the TRADING name
     ("Langa'ta mamafua"). Overwriting silently loses the owner, and not
     overwriting leaves customers searching for a business they cannot find.

     Marketplace convention, and the founder's decision 2026-08-01: the trading
     name is what customers see, the personal name is retained as `ownerName` for
     support and verification. Only captured when the two genuinely differ and no
     owner is recorded yet, so re-approval never churns the field. */
  const priorName = _sanText(existing.name || '', 160);
  const ownerName = (priorName && priorName.toLowerCase() !== name.toLowerCase() && !existing.ownerName)
    ? priorName
    : (existing.ownerName || null);

  const doc = {
    uid, providerId,
    name,
    ...(ownerName ? { ownerName } : {}),
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
    /* THE BUSINESS IS DELIBERATELY UNTOUCHED. It holds earnings the rider has already
       made; suspending the right to work is not confiscation of money already earned,
       and a retracted business would strand settled funds nobody could reach. */
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

  /* ── THE RIDER'S BUSINESS ────────────────────────────────────────────────────
     Delivery earnings are trading proceeds, and the certified settlement pays them to
     businessWallets/{businessId} while refusing a personal wallet outright. A rider
     without a business therefore cannot be paid — their money is held on the job with
     `deliverySettlementHold` and stays there.

     Merchants are provisioned at approval by this same primitive. Riders went through
     the same approval and got dispatch records but no business, so every one of them
     met that hold. Provisioning here closes it at the moment the right to work is
     granted, using the mechanism that already exists rather than a second one.

     BEST-EFFORT ON PURPOSE. A rider whose business could not be created is still an
     approved rider: refusing the whole approval because a wallet destination is
     missing would keep somebody off the road over money they have not yet earned. The
     outcome is returned so the caller can see it, and settlement keeps holding until
     it exists — which is the behaviour that was already correct. */
  let riderBusiness = { created: false, reason: 'not-attempted', merchantId: null };
  /* EXPLICITLY GUARDED AT THE CALL SITE. The function already returns early when
     !approved, so this condition is always true here — it is kept because the guard
     that matters is ninety lines above, and a reader (or a checker) at this line cannot
     see it. A provisioning call that can only be shown safe by scrolling is one that a
     later edit can silently unguard. */
  if (approved) try {
    const bb = require('./business-bootstrap');
    riderBusiness = await bb._ensureBusinessForOwner({
      uid: String(uid),
      /* The rider's own name, because this business IS the rider trading. A generic
         label would make every rider's wallet indistinguishable in an audit. */
      businessName: name || 'Rider',
      category: 'Delivery',
      phone: _san(app.phone, 24) || _san(app.phoneNumber, 24) || '',
      county: _sanText(app.county, 100) || '',
      city: _sanText(app.city, 100) || '',
    });
  } catch (e) {
    riderBusiness = { created: false, reason: 'provisioning-failed',
                      detail: (e && e.message) || String(e), merchantId: null };
  }

  return {
    collection: 'drivers+rideDrivers', id: uid,
    action: rideSnap.exists ? 'updated' : 'created',
    documentsMissing: missing,
    /* NAMED IN THE RESULT so an approval that could not give a rider a wallet
       destination is visible, rather than discovered later as an unpaid delivery. */
    riderBusiness: {
      provisioned: riderBusiness.created === true ||
                   riderBusiness.reason === 'already-provisioned',
      businessId: riderBusiness.merchantId || null,
      reason: riderBusiness.reason,
    },
  };
}

/* ── LEGAL (Roles Phase 2) ───────────────────────────────────────────────────
   ONE lifecycle, two documents, both keyed by uid:

     legalProviders/{uid}  authority / profile — what legal-hub.html and the
                           getLegalProviders CF read.
     lawyers/{uid}         SEARCH PROJECTION — what sokoni-firestore-search.js,
                           sokoni-search-pro.js and the existing Algolia +
                           Typesense `lawyers` triggers read.

   This is not a new architecture; it is the one the platform already uses.
   scripts/onboard-batch2.js writes BOTH documents for the same uid in the same
   pass, commented "legalProviders (shown on legal-hub) and lawyers (global
   search)". Approval was the only entry point that did not: `legal` sat in
   DELEGATED_ROLES and wrote nothing at all, so an approved advocate got an
   account role and no profile and no search presence.

   legalProviders is deliberately NOT registered with Algolia or Typesense.
   Indexing it would create a SECOND searchable record of the same firm — the
   duplicate this design exists to prevent. `lawyers` stays the single search
   surface and its pipeline is untouched.

   Registry-owned values are never clobbered. licenceNumber, specializations,
   consultationFee, rating and the consultation history belong to the legal
   registry (registerLegalProvider / approveLegalProvider / the operator script);
   an application does not carry them, so an approval must not blank them.
   ────────────────────────────────────────────────────────────────────────── */

/* Kept in sync with LEGAL_SPECIALIZATIONS in functions/legal-hub.js — the
   getLegalProviders `array-contains` filter only matches these values, so a
   free-text speciality from an application is recorded but never invented into
   the filterable field. */
const LEGAL_SPECS = ['family_law', 'property_law', 'employment_law', 'corporate_law', 'criminal_law',
  'immigration', 'intellectual_property', 'tax_law', 'conveyancing', 'debt_recovery',
  'drafting', 'notary', 'mediation', 'litigation', 'other'];

async function projectLegal(db, app, uid, approved) {
  const provRef = db.collection('legalProviders').doc(uid);
  const lawRef  = db.collection('lawyers').doc(uid);
  const [provSnap, lawSnap] = await Promise.all([provRef.get(), lawRef.get()]);
  const prov = provSnap.exists ? provSnap.data() : {};
  const law  = lawSnap.exists  ? lawSnap.data()  : {};

  if (!approved) {
    /* Retraction, not deletion — the same shape projectProvider uses. The firm
       disappears from the directory AND from search (searchable:false makes the
       existing update trigger delete it from the index), and every field the
       registry owns survives for reinstatement. */
    const w = [];
    if (provSnap.exists) {
      await provRef.set({ status: 'suspended', isOnline: false, suspendedAt: _ts(), updatedAt: _ts() }, { merge: true });
      w.push({ collection: 'legalProviders', id: uid, action: 'retracted' });
    } else w.push({ collection: 'legalProviders', id: uid, action: 'noop_absent' });
    if (lawSnap.exists) {
      await lawRef.set({ status: 'suspended', searchable: false, searchIndexed: false, updatedAt: _ts() }, { merge: true });
      w.push({ collection: 'lawyers', id: uid, action: 'retracted' });
    } else w.push({ collection: 'lawyers', id: uid, action: 'noop_absent' });
    return w;
  }

  const name = _sanText(app.name || app.businessName || app.firmName || app.fullName, 160);
  const firmName = _sanText(app.firmName || app.businessName || name, 160);
  const bio = _sanText(app.description || app.bio || app.about, 2000);
  /* An application's free-text speciality is kept for display, but only a value
     from the registry's own vocabulary may reach the filterable array. */
  const declaredSpec = _san(app.specialization || app.practiceArea || '', 60).toLowerCase().replace(/[\s-]+/g, '_');
  const specs = Array.isArray(prov.specializations) && prov.specializations.length
    ? prov.specializations
    : (LEGAL_SPECS.indexOf(declaredSpec) > -1 ? [declaredSpec] : ['other']);

  /* ── 1 · AUTHORITY ── */
  const provDoc = {
    providerId: prov.providerId || uid,
    uid,
    name,
    firmName,
    specializations: specs,
    bio: bio || prov.bio || '',
    location: _sanText(app.location || app.city || app.county, 200) || prov.location || '',
    county: _sanText(app.county || app.city, 100) || prov.county || '',
    country: prov.country || 'Kenya',
    phone: _san(app.phoneNumber || app.phone, 24) || prov.phone || '',
    email: _san(app.email, 200) || prov.email || '',
    status: 'active',
    approved: true,
    approvedAt: _ts(),
    sourceApplicationId: app.applicationId || null,
    updatedAt: _ts(),
  };
  /* Seed ONLY on first creation. `rating` is not decoration: getLegalProviders
     runs .orderBy('rating','desc'), and Firestore omits documents that lack the
     ordered field — approving a firm without it would file it into an invisible
     directory. Re-approval must never reset a live firm's history. */
  if (!provSnap.exists) {
    provDoc.rating = 0; provDoc.ratingCount = 0; provDoc.totalConsultations = 0;
    provDoc.consultationFee = 0; provDoc.currency = 'KES';
    provDoc.languages = ['English', 'Swahili'];
    provDoc.isOnline = false;
    provDoc.yearsOfExperience = 0;
    /* NEVER fabricated. A practising certificate number is supplied by the firm;
       an empty string here is honest, an invented one is a compliance problem. */
    provDoc.licenseNumber = '';
    provDoc.verified = false;
    provDoc.profilePending = ['licenseNumber', 'specializations', 'bio', 'phone', 'consultationFee'];
    provDoc.createdAt = _ts();
  }
  await provRef.set(provDoc, { merge: true });

  /* ── 2 · SEARCH PROJECTION ──
     Built through the SHARED generator (functions/search-terms.js) — the same
     one projectProvider uses — so no second transformation exists to drift.
     buildSearchTerms reads name/category/categories/description/location/city/
     county/tags, so the legal vocabulary is carried in `categories` and `tags`;
     `specialty`, `practice` and `firm` are display fields the search clients
     read directly and are NOT term sources on their own. */
  const specialty = _sanText(app.specialization || app.practiceArea || law.specialty, 120) || 'Legal Services';
  const categories = ['legal', specialty, ...specs.map((s) => String(s).replace(/_/g, ' '))]
    .map((c) => _sanText(c, 120)).filter(Boolean)
    .filter((c, i, a) => a.findIndex((x) => x.toLowerCase() === c.toLowerCase()) === i);

  const lawDoc = {
    id: uid, uid, sellerUid: uid,
    name,
    firm: firmName,
    specialty,
    practice: _sanText(law.practice || specialty, 120),
    category: 'legal',
    categories,
    description: bio || law.description || '',
    location: provDoc.location,
    city: _sanText(app.city || app.county, 100) || law.city || '',
    email: provDoc.email,
    status: 'active',
    verified: prov.verified === true || law.verified === true,
    searchable: true,
    searchIndexed: true,
    nameLower: name.toLowerCase(),
    updatedAt: _ts(),
    sourceApplicationId: app.applicationId || null,
  };
  /* Swahili and the words a client actually types. `wakili` is how most Kenyan
     clients search for an advocate and appears in no structured field. */
  lawDoc.tags = ['lawyer', 'advocate', 'wakili', 'legal', 'law firm'];
  lawDoc.searchableTerms = buildProviderTerms({ ...law, ...lawDoc });
  if (!lawSnap.exists) lawDoc.createdAt = _ts();

  await lawRef.set(lawDoc, { merge: true });

  return [
    { collection: 'legalProviders', id: uid, action: provSnap.exists ? 'updated' : 'created' },
    { collection: 'lawyers',        id: uid, action: lawSnap.exists  ? 'updated' : 'created' },
  ];
}

/* Roles the platform already owns elsewhere. Projecting them from here would
   duplicate an existing pipeline (sellers has its own onboarding + ade trigger;
   healthProviders has its own registry), so the role is recorded, the account is
   granted its role, and the projection is reported as delegated instead of being
   silently skipped.

   `legal` GRADUATED out of this map in Roles Phase 2: "delegated" meant nobody
   wrote the document, so approving an advocate produced no profile and no search
   presence. It now runs projectLegal above. */
/* `seller` USED to be in here — the projection recorded `action: 'delegated'` and
   wrote nothing, on the assumption that sellers have their own onboarding. That
   assumption is false: the only writers of `sellers/{uid}` are client-side forms,
   and nothing server-side creates `shops/{shopId}` at all. An approved merchant
   therefore got a role and a claim and NO SHOP — authorised to sell, with nowhere
   to sell from, and `mintSokoniTillCore` refusing with "Shop not found" because a
   Till is keyed on a shop that was never created. Seller is projected properly by
   projectSeller below; health still genuinely has its own registry. */
const DELEGATED_ROLES = { health: 'healthProviders' };

/* The placeholder-shop-id guard that used to live here is REMOVED, not disabled.
   It existed to sanitise a client-declared `app.shopId` — rejecting 'main',
   'default' and friends so every merchant did not land on a shared `shops/main`.
   Under the ratified contract the declared value is ignored outright, so there is
   no path for a placeholder to reach the store id and the guard could only give a
   false impression that one is still being filtered. Keeping dead validation for a
   field nobody reads is how a future reader concludes the field is still honoured. */

/**
 * Approval → a LIVE shop, created BEFORE the role is granted.
 *
 * The ordering is deliberate and load-bearing. If the shop cannot be established,
 * applyDecision's catch records the failure and rethrows, so no seller role and no
 * claim are handed out. The state this removes is "approved merchant with no shop".
 *
 * The shop id comes from the application when it named a real one, otherwise the
 * account's own marketplace shop `shops/{uid}`. An account id and a shop id are
 * different concepts even when they share a value.
 *
 * IDEMPOTENT rather than transactional, and only across documents it owns:
 * deterministic ids + merge, so re-approving converges instead of forking a second
 * shop, and `createdAt` is written only when the shop is new. It is NOT atomic
 * across shops/sellers/users — see the provisioning note in applyDecision.
 */
async function projectSeller(db, app, uid, approved, chain) {
  /* THE CANONICAL STORE ID IS THE OWNER'S UID — ratified 2026-09-06. It is never
     taken from the application.

     `app.shopId` is CLIENT-WRITABLE: applications permit an owner update and
     `noAdminFields()` withholds thirteen fields, none of them shopId. Honouring it
     let an applicant choose where their store was created, and three things break
     when that value is not the uid:

       1. firestore.rules is `match /shops/{uid}` with
          `allow update: if ... request.auth.uid == uid`, and `ownerId` is not in the
          update allowlist — the merchant could not edit their own store.
       2. merchant-identity's resolveActor proves ownership as `uid === shopId`
          ("there is no ownerId field to forge"), so the owner fell through to the
          employee branch and was refused `not-employed-here`: no POS sale, and no
          servedBy on the receipt.
       3. Worst: an applicant could declare ANOTHER user's uid and have approval
          create `shops/{victimUid}` carrying their own trading name, after which the
          victim could never be provisioned at their own canonical id.

     The declared value is IGNORED rather than validated. There is no legitimate case
     for a merchant naming their own store's document id, and a validator would only
     narrow the same hole. Multi-store merchants are a separate slice with an explicit
     authority model — not a writable field on an application. */
  /* ── THE STORE ID IS THE STORE'S OWN, NOT THE OWNER'S ────────────────────────────────
     This used to be `String(uid)`, and the three reasons recorded above for that choice
     were all real. None of them required the store to BE the owner; they required that the
     owner could not CHOOSE the id, that ownership was provable, and that rules could
     express the check. A server-minted id satisfies all three and keeps the identities
     distinct:

       1. rules  — `shops/{storeId}` now authorises on `resource.data.ownerId`, so the
                   owner can still edit their store without the id being their uid
       2. proof  — merchant-identity resolves ownership from the STORE DOCUMENT rather than
                   by comparing two strings that were only ever equal by construction
       3. hijack — `app.shopId` is still ignored completely. The id is minted server-side,
                   so a declared value has nothing to attach to

     A merchant provisioned before this change keeps their uid-keyed store: store-identity
     resolves by `ownerId`, so both keyspaces answer to one lookup and no row is rewritten.
     `chain` is resolved by the caller precisely so that this projection cannot invent an
     identity of its own — if the chain could not be established, approval does not reach
     here. */
  const shopId = String((chain && chain.storeId) || uid);
  const businessId = (chain && chain.businessId) || null;
  const shopRef = db.collection('shops').doc(shopId);
  const sellerRef = db.collection('sellers').doc(String(uid));
  const userRef = db.collection('users').doc(String(uid));
  /* The business DIRECTORY record, written at the CANONICAL business id.

     This was `businesses/{uid}`, and that was a serious defect rather than a cosmetic one.
     `businesses` is the GENERATED-MERCHANT keyspace: tenant-identity states that its
     document id "can never equal an auth uid", and every POS authority relies on that to
     tell a person from a shop. Writing a uid-keyed row into it broke the invariant, and
     then broke provisioning outright — `_ensureBusinessForOwner` looks for
     `where ownerId == uid` FIRST, found this row, and returned `already-provisioned` with
     `merchantId = uid`. So the real business was never created: no branch, no owner staff,
     no payment methods, no setup checklist, and merchantId collapsed onto the uid.

     The row is still written — the directory gap it was added to close is real — but onto
     the business the canonical provisioner created, as a merge. One record, one keyspace. */
  const bizRef = businessId
    ? db.collection('businesses').doc(String(businessId))
    : null;

  const name = _sanText(app.name || app.businessName || app.storeName, 160) || 'My Shop';
  /* Both reads before any write — the directory row's createdAt must be preserved, and
     that cannot be decided after the batch has started. */
  const [existing, bizExisting] = await Promise.all([
    shopRef.get(),
    bizRef ? bizRef.get().catch(() => null) : Promise.resolve(null),
  ]);

  if (!approved) {
    /* A rejection has nothing to retract. A suspension DEACTIVATES the shop but
       never deletes it — products, orders and history stay intact for reinstatement. */
    if (existing.exists) {
      await shopRef.set({ status: 'suspended', suspendedAt: _ts(), updatedAt: _ts() }, { merge: true });
      await sellerRef.set({ status: 'suspended', active: false, updatedAt: _ts() }, { merge: true }).catch(() => {});
      /* Retract the listing too. A suspended merchant that stays discoverable is the same
         defect as an approved one that never appears — the registries must move together
         or they disagree about who is live. */
      if (bizRef) await bizRef.set({ status: 'suspended', updatedAt: _ts() }, { merge: true }).catch(() => {});
      return { collection: 'shops', id: shopId, action: 'suspended' };
    }
    return { collection: 'shops', id: shopId, action: 'none' };
  }

  const batch = db.batch();

  /* The canonical shop. `ownerId` is what every server-side ownership check reads;
     `sellerUid` states the same fact in the merchant vocabulary. */
  batch.set(shopRef, {
    shopId,
    storeId: shopId,
    /* UPWARD LINK. Without it a store can only be traced to its owner, and the business it
       trades as has to be re-derived from the uid at every call site — which is how the
       two tenant spaces drifted apart in the first place. */
    businessId,
    ownerId: String(uid),
    sellerUid: String(uid),
    name,
    nameLower: name.toLowerCase(),
    status: 'active',
    activatedAt: _ts(),
    updatedAt: _ts(),
    ...(existing.exists ? {} : { createdAt: _ts() }),
  }, { merge: true });

  /* The business directory listing. `createdAt` is preserved on re-approval so the
     directory's orderBy('createdAt') cannot silently drop a reinstated merchant.

     `verified` is deliberately NOT written. The homepage counts `businesses where
     verified == true` and the field drives a trust badge, so setting it would be a trust
     claim made as a side effect of an approval — a commercial decision, not a projection. */
  if (bizRef) batch.set(bizRef, {
    uid: String(uid),
    ownerId: String(uid),
    /* The chain, PERSISTED — so "which store belongs to this business?" is a field to read
       rather than a join to guess at. */
    shopId,
    storeId: shopId,
    name,
    businessName: name,
    nameLower: name.toLowerCase(),
    status: 'active',
    source: 'application_approval',
    applicationId: app.applicationId || null,
    updatedAt: _ts(),
    ...(bizExisting && bizExisting.exists ? {} : { createdAt: _ts() }),
    ...(app.category ? { category: _sanText(app.category, 80) } : {}),
    ...(app.description ? { description: _sanText(app.description, 1000) } : {}),
    ...(app.phoneNumber || app.phone ? { phone: app.phoneNumber || app.phone } : {}),
    ...(app.email ? { email: app.email } : {}),
    ...(app.location || app.city ? { city: _sanText(app.location || app.city, 160) } : {}),
  }, { merge: true });

  /* The registry row discovery reads. `updatedAt` is required — a row without it
     is invisible to the freshness-ordered listings. */
  batch.set(sellerRef, {
    uid: String(uid), shopId, storeId: shopId, businessId, name, status: 'active', active: true,
    updatedAt: _ts(), ...(existing.exists ? {} : { createdAt: _ts() }),
  }, { merge: true });

  /* Which shop this account is operating. The merchant workspace resolves the
     shop from here, so without it the shell has no shop to open. */
  /* The account's pointers into the chain. `activeShopId` is what the merchant shell opens;
     `businessId` is what the POS authorities resolve against. Both are recorded so neither
     has to be inferred from the uid. */
  batch.set(userRef, {
    activeShopId: shopId,
    activeStoreId: shopId,
    ...(businessId ? { businessId } : {}),
    updatedAt: _ts(),
  }, { merge: true });

  await batch.commit();

  /* ── STORE AVAILABILITY ─────────────────────────────────────────────────
     The canonical chain already exists and is NOT re-invented here:

        shops/{shopId} -> ownerUid -> providerAvailability/{ownerUid}
                       -> kasshop.effectiveForShop -> getMinishopPublic

     `shops.openingHours` is a DENORMALISED copy — effectiveForShop's own comment
     says "the seller-managed timetable wins over the copy denormalised on the
     shop" — so the timetable is written where the resolver reads it, in the exact
     shape merchant-v2's editor writes: `hours` keyed sun..sat, `overrides` as a
     MAP (the overrides SUBCOLLECTION is invisible to the resolver).

     WRITTEN ONCE, NEVER OVERWRITTEN. A re-approval must not reset hours the
     merchant has since edited, so this is skipped whenever a document already
     exists — which is also what makes the whole provisioning workflow safe to
     retry.

     BEHAVIOUR NOTE, deliberate: with no document at all,
     computeEffectiveAvailability returns `{ open: true, reason: 'no_schedule' }`
     — a merchant with no timetable is treated as always open. Provisioning real
     hours therefore CHANGES when a new merchant shows as open. That is the point
     of provisioning a store "ready for operation", but it is a real change, so
     `hoursSource` records that these are defaults rather than a decision the
     merchant made — the readiness layer can then ask them to confirm. */
  try {
    const availRef = db.collection('providerAvailability').doc(String(uid));
    const availSnap = await availRef.get();
    if (!availSnap.exists) {
      const period = [{ open: '08:00', close: '18:00' }];
      const hours = {
        sun: { closed: true, periods: [] },
        mon: { closed: false, periods: period },
        tue: { closed: false, periods: period },
        wed: { closed: false, periods: period },
        thu: { closed: false, periods: period },
        fri: { closed: false, periods: period },
        sat: { closed: false, periods: period },
      };
      await availRef.set({
        uid: String(uid),
        hours,
        overrides: {},
        hoursSource: 'provisioned_default',
        provisionedAt: _ts(),
        updatedAt: _ts(),
      }, { merge: true });
    }
  } catch (e) {
    /* Non-fatal, like the POS defaults: a store that exists with no timetable is
       open, not broken. Reported so it is visible rather than silent. */
    logger.warn('[appLifecycle] availability provisioning failed', { uid, error: e.message });
  }

  return { collection: 'shops', id: shopId, action: existing.exists ? 'reactivated' : 'created' };
}

/* ── CANONICAL ROLE PROFILES (Roles Phase 2) ────────────────────────────────
   One uid-keyed profile per canonical role that had none. These are the account's
   record of "you are approved as X", separate from the listing registries that
   already exist (providers, sellers, drivers …).

   mechanic  mechanics/{uid}. The collection ALREADY EXISTS and is written
             client-side by provider-wiring.js as mechanics/{arbitraryId} for
             self-registered garages. That path is untouched: this adds a
             uid-keyed document ALONGSIDE it so approval has a record it owns,
             and no legacy document is read, rewritten or deleted.
   landlord  landlordProfiles/{uid}. New. `landlordData/{uid}` is a write-only
             localStorage mirror with no reader and is deliberately NOT reused.
   tenant    tenantProfiles/{uid}. New, and PRIVATE — a rental tenant is personal
             data, so it is never registered with any search engine. The name
             avoids `tenants/`, which is inventory multi-tenancy (isTenantMember /
             sellerId claim) and completely unrelated.

   `indexable` is stamped so the indexing generators need no per-role special
   case: the pipeline's existing skip guard already honours documents that say
   they must not be indexed. */
const ROLE_PROFILES = {
  mechanic: { collection: 'mechanics',        indexable: true  },
  landlord: { collection: 'landlordProfiles', indexable: true  },
  tenant:   { collection: 'tenantProfiles',   indexable: false },
};

/* Write the uid-keyed role profile. Idempotent: a re-approval or a retried
   trigger converges on the same document rather than creating a second one. */
async function projectRoleProfile(db, app, uid, role, approved) {
  const spec = ROLE_PROFILES[role];
  if (!spec) return null;
  const ref = db.collection(spec.collection).doc(uid);

  if (!approved) {
    /* Withdrawn, not deleted. The profile stops being discoverable and stops
       claiming the role, but the record of the decision survives — the same
       retraction shape projectProvider uses. */
    await ref.set({
      role, ownerUid: uid, status: 'inactive', visibility: 'private',
      approved: false, updatedAt: _ts(),
    }, { merge: true });
    return { collection: spec.collection, id: uid, action: 'retracted' };
  }

  const patch = {
    /* Canonical index fields, stamped on every role profile so the search
       document builder needs no per-role knowledge. */
    entityType: role,
    role,
    ownerUid: uid,
    name: _san(app.name || app.businessName || app.fullName || '', 140),
    description: _sanText(app.description || app.bio || app.about || '', 600),
    category: _san(app.category || '', 80),
    hub: _san(app.hub || '', 40),
    location: _san(app.location || app.city || app.county || '', 120),
    phone: app.phoneNumber || app.phone || null,
    status: 'active',
    visibility: spec.indexable ? 'public' : 'private',
    approved: true,
    approvedAt: _ts(),
    sourceCollection: 'applications',
    sourceId: app.applicationId || null,
    updatedAt: _ts(),
  };
  /* A tenant profile carries NO discoverable content and says so explicitly, so
     an indexer that ever sees it skips it on the document's own terms rather
     than on a rule someone has to remember. */
  if (!spec.indexable) patch._noIndex = true;

  const snap = await ref.get();
  if (!snap.exists) patch.createdAt = _ts();

  await ref.set(patch, { merge: true });
  return { collection: spec.collection, id: uid, action: snap.exists ? 'updated' : 'created' };
}

/* Account roles. `roles` must be written as an ARRAY — a provider whose account
   carries only `isProvider: true` lands in the app as a buyer, and the analytics
   gate reads `roles` (array), not a `role` string. Both the array and the
   legacy booleans are maintained so no existing reader breaks. */
async function grantAccountRole(db, uid, role, approved) {
  /* ── CANONICAL ROLE KEYS (Roles Phase 2) ──────────────────────────────────
     This map used to read
       { provider:'provider', driver:'rider', seller:'seller',
         health:'provider', legal:'provider' }
     with `|| 'provider'` behind it, and that fallback was the whole problem: a
     mechanic, a landlord and a rental tenant all became `provider` on the
     account, and health and legal were mapped there deliberately. Phase 1 taught
     the intake to DECLARE a role; without this, the declaration was recorded on
     the application and then discarded at the account.
     Every canonical role now keeps its own key, and there is NO fallback — an
     unmapped role throws rather than quietly becoming a provider. `driver` is
     retained as the legacy spelling of `rider` because existing applications and
     `registeredAs.rider` already use both. */
  const ROLE_KEY = {
    buyer:    'buyer',
    seller:   'seller',
    provider: 'provider',
    mechanic: 'mechanic',
    driver:   'rider',      /* legacy spelling → canonical key */
    rider:    'rider',
    health:   'health',
    legal:    'legal',
    landlord: 'landlord',
    tenant:   'tenant',
    admin:    'admin',
    staff:    'staff',
  };
  const key = ROLE_KEY[role];
  if (!key) {
    /* Fail loudly. Silently defaulting is what this phase exists to remove, and
       a role that reaches here unmapped is a bug in the caller, not an applicant
       problem to be smoothed over. */
    throw new Error('grantAccountRole: unmapped role "' + role + '". '
      + 'Canonical roles: ' + Object.keys(ROLE_KEY).join(', ') + '.');
  }
  const ref = db.collection('users').doc(uid);
  const patch = { updatedAt: _ts() };

  if (approved) {
    patch.roles = FieldValue.arrayUnion(key);
    patch[`registeredAs.${key}`] = true;
    patch.approved = true;
    patch.approvedAt = _ts();
    if (role === 'provider') patch.isProvider = true;
    /* Both spellings set the legacy flags: `role` is now `rider` for a Phase 1
       declaration and still `driver` for a legacy application, and driver.html,
       dispatch and profile.html all read isDriver/isRider. */
    if (key === 'rider') { patch.isDriver = true; patch.isRider = true; }
    /* ── activeRole is SERVER-SET (Roles Phase 2) ───────────────────────────
       Until now nothing on the server ever wrote it: profile.html:4339 persisted
       whatever the client held, so the workspace a merchant landed in was decided
       by the browser. Approval is the event that grants a capability, so approval
       is what selects it — the applicant lands in the workspace they were just
       approved for instead of having to find it.
       This does not yet PREVENT a client writing something else; that is Phase 3,
       where the rules stop trusting the field. What it establishes now is that
       the server is the authority that sets it. */
    patch.activeRole = key;
    patch.activeRoleSetBy = 'approval';
    patch.activeRoleSetAt = _ts();
  } else {
    /* The role is removed but the account is untouched otherwise — a rejected
       provider is still a customer. */
    patch.roles = FieldValue.arrayRemove(key);
    patch[`registeredAs.${key}`] = false;
    if (role === 'provider') patch.isProvider = false;
    if (key === 'rider') { patch.isDriver = false; patch.isRider = false; }
    /* A revoked role must not remain the active workspace. Reading the account
       first would be a race against the same write, so the demotion is applied
       only when the stored activeRole is the role being revoked. */
    try {
      const snap = await ref.get();
      if (snap.exists && snap.data() && snap.data().activeRole === key) {
        patch.activeRole = 'buyer';
        patch.activeRoleSetBy = 'revocation';
        patch.activeRoleSetAt = _ts();
      }
    } catch (e) {
      logger.warn('[appLifecycle] activeRole demotion skipped', { uid, key, error: e.message });
    }
  }
  await ref.set(patch, { merge: true });

  /* Auth custom claims mirror the grant so security rules and the client gate
     agree without a Firestore read. Best-effort: a claim failure must not
     abort a projection that already succeeded. */
  try {
    const auth = getAuth();
    const user = await auth.getUser(uid);
    const claims = { ...(user.customClaims || {}) };
    /* One claim per canonical role, keyed the same way as users.roles.
       Previously health and legal set `claims.provider`, so a claim could not
       tell a clinic from a cleaning company — the same collapse this phase
       removes from the account. The legacy `provider` claim is still set for
       provider/health/legal because live rules and client gates read it; the
       canonical claim is added ALONGSIDE it, never instead of it, so nothing
       that reads the old shape breaks. */
    claims[key] = !!approved;
    if (role === 'provider' || role === 'health' || role === 'legal') claims.provider = !!approved;
    if (key === 'rider') { claims.driver = !!approved; claims.rider = !!approved; }
    if (key === 'seller') claims.seller = !!approved;
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
  /* An EXPLICIT declaration outranks every legacy field. `app.role` keeps its old
     precedence for legacy documents so an application already in the queue decides
     exactly as it would have before Phase 1. */
  const _resolved = resolveRole(app);
  const role = _resolved.by === 'explicit' || _resolved.by === 'explicit-alias'
    ? _resolved.role
    : (app.role || _resolved.role);
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

  /* ── QUARANTINE, NEVER GUESS (Roles Phase 1) ──────────────────────────────
     The application declared a role this platform does not recognise. Nothing is
     provisioned: no registry record, no account role, no claim. Before Phase 1
     this could not happen, because every unrecognised vocabulary resolved to
     `provider` — which is exactly how a landlord ended up in the service
     directory with nothing reporting it.
     Reported the same way as the no-uid case above, so a reviewer finds it on the
     application rather than in a log they were never going to read. */
  if (role === null) {
    const bad = _san(_resolved.requested || '', 60);
    await db.collection('applications').doc(appId).set({
      projectionStatus: 'blocked_unknown_role',
      projectionError: 'requestedRole "' + bad + '" is not a canonical role. '
        + 'Valid roles: ' + VOCAB.CANONICAL_ROLES.join(', ') + '.',
      decisionAppliedFor: status,
      decisionAppliedAt: _ts(),
    }, { merge: true });
    await db.collection('adminAlerts').add({
      kind: 'application_role_invalid',
      severity: 'medium',
      message: 'Application ' + appId + ' declared requestedRole "' + bad
             + '", which is not canonical. It was NOT provisioned and needs a reviewer.',
      appId, uid, requestedRole: bad,
      validRoles: VOCAB.CANONICAL_ROLES,
      createdAt: _ts(),
    }).catch(() => {});
    logger.warn('[appLifecycle] unknown requestedRole — quarantined', { appId, requested: bad });
    return { ok: false, reason: 'unknown_role', appId, requestedRole: bad };
  }

  const receipt = { appId, uid, role, status, writes: [] };

  try {
    if (role === 'driver' || role === 'rider') {
      /* Both spellings reach the same projection: `rider` is the Phase 1
         declaration, `driver` the legacy application's word. */
      receipt.writes.push(await projectDriver(db, app, uid, approved));
    } else if (role === 'legal') {
      /* legalProviders (authority) + lawyers (search projection), one commit.
         Returns TWO receipt entries, so push them individually. */
      (await projectLegal(db, app, uid, approved)).forEach((w) => receipt.writes.push(w));
    } else if (ROLE_PROFILES[role]) {
      /* mechanic / landlord / tenant — a uid-keyed profile this approval owns.
         Before Phase 2 these fell through to projectProvider and were filed in
         the service directory, which is exactly how a landlord ended up listed
         as a cleaning company. */
      receipt.writes.push(await projectRoleProfile(db, app, uid, role, approved));
    } else if (role === 'seller' || role === 'merchant') {
      /* ── THE CANONICAL CHAIN, ESTABLISHED BEFORE ANYTHING IS PROJECTED ──────────────
         uid -> businessId -> storeId -> storefront.

         ORDER IS THE WHOLE POINT. The business used to be provisioned AFTER the store, so
         the store had no business to belong to and took the only id available — the uid.
         Establishing the business first gives the store something to be a store OF.

         Both steps are idempotent by their own guards (an ownerId query plus a
         transactional provisioning claim), so a re-approval, a retry, or two admins
         clicking at once resolve the SAME business and the SAME store rather than minting
         a second of either.

         NON-FATAL, like the POS provisioning below it, and for the same reason: approval is
         the merchant's status change. If the chain cannot be established the merchant is
         still approved, the store is still projected at the legacy id so nothing is lost,
         and the failure is recorded on the application where a reviewer will see it. */
      let chain = null;
      if (approved) {
        try {
          const bb = require('./business-bootstrap');
          const si = require('./store-identity');
          const prov = await bb._ensureBusinessForOwner({
            uid,
            businessName: app.businessName || app.name || '',
            category: app.category || app.businessType || '',
            phone: app.phoneNumber || '',
            county: app.county || '', city: app.city || '',
          });
          if (prov && prov.merchantId) {
            /* The business id must not BE the uid. If it is, an older row collapsed the
               keyspace and binding a new store to it would propagate the collapse rather
               than end it — so the chain is refused and the legacy path is used. */
            si.assertNotUidShaped(prov.merchantId, uid);
            const st = await si.ensureStoreForBusiness({
              uid, businessId: prov.merchantId,
            });
            if (st && st.storeId) {
              chain = { businessId: prov.merchantId, storeId: st.storeId, legacy: !!st.legacy };
            }
          }
        } catch (e) {
          chain = null;
          receipt.notes = (receipt.notes || []).concat(['chain_unresolved: ' + e.message]);
        }
      }

      /* BEFORE grantAccountRole below, deliberately: a shop that cannot be
         established must not leave a claim behind. */
      receipt.writes.push(await projectSeller(db, app, uid, approved, chain));

      /* ── THE BUSINESS WALLET ────────────────────────────────────────────────────────
         Provisioned with the business, not on first sale. A merchant whose wallet appears
         only when money arrives has no balance to show, no statement to reconcile, and no
         account for a commission obligation to be recorded against — and the first sale is
         the worst possible moment to discover that.

         Keyed on the businessId, never the uid: the personal wallet at `wallets/{uid}` is
         a different account, in a different unit, and is left untouched. */
      if (approved && chain && chain.businessId) {
        try {
          const bw = require('./business-wallet');
          const w = await bw.ensureWallet(chain.businessId, uid, { storeId: chain.storeId });
          receipt.writes.push({ collection: 'businessWallets', id: chain.businessId,
                                action: w.created ? 'created' : 'existing' });
        } catch (e) {
          receipt.notes = (receipt.notes || []).concat(['business_wallet_failed: ' + e.message]);
        }
      }
    } else if (DELEGATED_ROLES[role]) {
      receipt.writes.push({ collection: DELEGATED_ROLES[role], id: uid, action: 'delegated' });
    } else {
      receipt.writes.push(await projectProvider(db, app, uid, approved));
    }

    /* THE TRIAL IS AN ENTITLEMENT OF APPROVAL, not of POS onboarding alone.
       functions/seller-trial.js names this path as one of its TWO legitimate callers —
       "business-bootstrap._createBusiness … / … application approval (projectSeller)" — and
       it was never wired. An approved marketplace seller got a shop, a role and a till and NO
       subscription: nothing for the expiry sweep to find, and no entitlement to check.

       Guarded on the DECISION, not on the projection: only an approval, and only for a
       seller. A rejection, a suspension or any other role must not start a trial. It sits
       after projectSeller because the shop must exist first, and the shop id it keys on is
       the canonical one that projection established.

       startSellerFreeTrial is idempotent — an existing subscription for the shop is left
       untouched, so a re-approval can neither mint a second nor restart the clock — and it
       REPORTS rather than throws, which is what makes it safe on a path that has already
       created the shop and granted the role. Its own header states that trade: failing the
       whole decision because the subscription write failed would be worse than reporting it. */
    if (approved && role === 'seller') {
      const _trial = await startSellerFreeTrial({
        db, uid: String(uid), shopId: String(uid),
        planName: 'SOKONI Seller', source: 'application_approval',
      });
      if (!_trial.created && _trial.reason === 'error') {
        logger.warn('[appLifecycle] seller trial not started', { uid, error: _trial.error });
      }
      receipt.writes.push({ collection: 'subscriptions', id: String(uid),
                            action: _trial.created ? 'trial_started' : ('trial_' + _trial.reason) });
    }

    /* ── LEGAL ENGINE IS THE AUTHORITY (application-legal-convergence) ─────────
       An approval must NOT grant a capability unless the role's required agreements
       are signed in legalAcceptances. assertLegalCompliance() is the engine's guard;
       it is DARK-LAUNCHED per role via legalConfig/enforcement — so this call is a
       no-op (returns compliant) until enforcement is deliberately enabled for the
       role, at which point a missing/outdated agreement FAILS CLOSED: it throws
       failed-precondition, applyDecision throws, and NO grant is applied. The
       applications.agreementAccepted boolean does NOT satisfy this — the signed,
       versioned legalAcceptances record is the only proof.

       Role mapping: the application's resolved role → the engine's agreement-role
       vocabulary (ROLE_AGREEMENTS keys). Only gates the APPROVE case — a rejection
       or suspension must not be blocked on missing agreements. */
    if (approved) {
      var _AGR_ROLE = { seller: 'merchant', merchant: 'merchant', provider: 'provider',
                        legal: 'provider', health: 'healthcare', driver: 'driver', rider: 'driver' };
      await require('./legal-agreements').assertLegalCompliance(uid, _AGR_ROLE[role] || role);
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

    /* ── POS/BUSINESS PROVISIONING ────────────────────────────────────────
       An approved merchant had a `sellers` record and NO `businesses` record,
       because the only writer of one was the pos-setup wizard. The till asks
       `businesses where ownerId == uid` and got nothing, so it told an
       approved merchant "No shop on this account" — a provisioning failure
       reported as a fact about their account.

       Reuses _ensureBusinessForOwner rather than writing a second provisioning
       implementation: two of them would drift, and this one already mints the
       full identity set, the default branch and the setup checklist.

       NON-FATAL BY DESIGN. Approval is the merchant's status change and must
       not be rolled back because a POS default failed to write. The outcome is
       recorded on the application so a reviewer can see it rather than
       discovering it when a till says the wrong thing. */
    if (status === 'approved' && (role === 'seller' || role === 'merchant')) {
      try {
        const bb = require('./business-bootstrap');
        const prov = await bb._ensureBusinessForOwner({
          uid,
          businessName: app.businessName || app.name || '',
          category: app.category || app.businessType || '',
          phone: app.phoneNumber || '',
          county: app.county || '', city: app.city || '',
        });
        /* ── SOKONI TILL + QR ──────────────────────────────────────────────
           The merchant's POS identity and their payment QR, provisioned
           automatically so approval alone is enough to start selling.

           REUSES the already-certified mintSokoniTillCore (81/0) rather than
           minting a second identity: it allocates the Till in a transaction
           against a per-shop counter, and `onExisting: 'return'` makes a retry
           return the existing Till instead of forking one. The QR is NOT a
           separate artifact — the Till's own HMAC-signed token IS the QR payload,
           so there is one identity and one signature, and no second QR format.

           `source: 'approval'` distinguishes this from the merchant's own
           self-service mint, which keeps `onExisting: 'throw'`.

           Keyed on the canonical shop projectSeller created above — which is why
           that runs first, and why this cannot be reordered ahead of it. */
        let till = null;
        try {
          /* The SAME canonical store projectSeller used — resolved, never the
             client-writable app.shopId. A Till minted against a declared shop id would bind
             the merchant's payment destination to a store document they neither own nor can
             edit.

             RESOLVED RATHER THAN RE-DERIVED. This read `String(uid)`, which was the store id
             only while the store WAS the owner. Re-deriving it here would mint the Till
             against a document that no longer exists for a merchant provisioned on the
             canonical chain — a till bound to nothing, discovered at the first sale.

             The legacy uid is the fallback and stays correct for merchants provisioned
             before the chain existed, because their store genuinely is keyed on it. */
          let tillShopId = String(uid);
          try {
            const si = require('./store-identity');
            const st0 = await si.resolveStoreForOwner(uid);
            if (st0.ok) tillShopId = st0.storeId;
          } catch (_) { /* fall back to the legacy id */ }
          const st = require('./sokoni-till');
          till = await st._internal.mintSokoniTillCore({
            shopId: tillShopId, actorUid: uid, source: 'approval', onExisting: 'return',
          });
        } catch (e) {
          logger.error('[appLifecycle] till provisioning FAILED', { appId, uid, error: e.message });
          till = { error: String((e && e.message) || e).slice(0, 200) };
        }

        await db.collection('applications').doc(appId).set({
          posProvisioning: { ok: true, created: prov.created === true,
                             reason: prov.reason || null,
                             merchantId: prov.merchantId || null, at: _ts() },
          tillProvisioning: (till && till.sokoniTillId)
            ? { ok: true, sokoniTillId: till.sokoniTillId, shopId: till.shopId,
                branchId: till.branchId || null, created: till.created === true, at: _ts() }
            : { ok: false, error: (till && till.error) || 'no till returned', at: _ts() },
        }, { merge: true });
        logger.info('[appLifecycle] pos provisioning', { appId, uid, ...prov,
          sokoniTillId: (till && till.sokoniTillId) || null });
      } catch (e) {
        await db.collection('applications').doc(appId).set({
          posProvisioning: { ok: false, error: String(e && e.message || e).slice(0, 300), at: _ts() },
        }, { merge: true }).catch(() => {});
        logger.error('[appLifecycle] pos provisioning FAILED', { appId, uid, error: e.message });
      }
    }

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
/* ─────────────────────────────────────────────────────────────────────────────
   DECISION AUTHORITY — restored 2026-09-06.

   Originally shipped as `bc9bf4c` ("an application could approve itself — verify
   the decider, not the document"). The reconciliation onto the live baseline
   preserved LIVE's copy of this file, which never carried the fix, so the hole
   was silently reopened. `test-application-decision-authority` — which executes
   the real handler rather than reading source — caught it: A1 reported 1 minted
   claim on a self-approval.

   THE HOLE. `firestore.rules` lets an applicant update their own application:

       allow update: if isAdmin() || (isOwner() && claimsOwner() && noAdminFields())

   `noAdminFields()` withholds isAdmin/suspended/banned/adminApproved/featured/
   verified/flagged/adminNote/role/approved/approvedAt/approvedBy/commissionRate —
   but NOT `status`, the one field the projection consults. So any signed-in user
   could write `status: 'approved'` (or 'active'/'accepted'/'verified' — canonStatus
   maps all four) onto their OWN request and be granted the role and the Auth claim
   by this trigger. The rule's own comment says self-approval is impossible; it
   guards a field the decision engine never looks at.

   Every legitimate decision goes through `applicationDecide`, which is admin-only
   and stamps `decidedBy`. But `decidedBy` is itself client-writable, so trusting
   its presence would only move the forgery one field along. Custom claims are the
   one thing a client cannot write, so authorisation is decided by reading the
   claims of the account named in `decidedBy`.

   Returns { ok } — never throws: an unresolvable decider is a refusal, not a
   crash that leaves the application in limbo.
   ────────────────────────────────────────────────────────────────────────── */
async function decisionAuthority(after) {
  const by = typeof after.decidedBy === 'string' ? after.decidedBy.trim() : '';
  if (!by) {
    return { ok: false, reason: 'no decidedBy — a decision is only made through applicationDecide' };
  }
  try {
    const user = await getAuth().getUser(by);
    const claims = user.customClaims || {};
    if (claims.admin === true || claims.superAdmin === true) return { ok: true, by };
    return { ok: false, reason: `decidedBy "${by}" holds no admin claim` };
  } catch (e) {
    return { ok: false, reason: `decidedBy "${by}" is not a resolvable account (${e.message})` };
  }
}

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

    const authority = await decisionAuthority(after);
    if (!authority.ok) {
      /* Already recorded for this exact status: return WITHOUT writing. The block
         below is itself a write to this document, so re-writing it would re-fire
         this trigger forever. */
      if (after.projectionStatus === 'blocked_unauthorised_decision' && after.blockedFor === status) return;

      /* The status is left as the client wrote it — deliberately. Rewriting it would
         silently downgrade a legitimately-decided legacy application that predates
         `decidedBy`; blocking the PROJECTION grants nothing either way, and an admin
         re-deciding through applicationDecide clears it. */
      await event.data.after.ref.set({
        projectionStatus: 'blocked_unauthorised_decision',
        blockedFor: status,
        projectionError: `Refusing to apply "${status}": ${authority.reason}. No role or claim was granted.`,
        decisionAppliedFor: FieldValue.delete(),
        updatedAt: _ts(),
      }, { merge: true });

      await _db().collection('adminAlerts').doc(`application_unauthorised_decision__${appId}`).set({
        kind: 'application_unauthorised_decision',
        severity: 'high',
        message: `Application ${appId} carries status "${after.status}" that no administrator made. Nothing was granted. If this is a real decision, re-decide it through the admin console.`,
        appId,
        uid: after.uid || null,
        claimedStatus: String(after.status || ''),
        decidedBy: after.decidedBy || null,
        reason: authority.reason,
        createdAt: _ts(),
      }, { merge: true }).catch(() => {});

      logger.error('[appLifecycle] REFUSED unauthorised decision', {
        appId, uid: after.uid || null, status, reason: authority.reason,
      });
      return;
    }

    await applyDecision(appId, after, { decidedBy: authority.by });
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
        /* null when the application declared a role we do not recognise — the list
           shows it as unresolved rather than inventing one. */
        role: a.role || resolveRole(a).role || null,
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
  projectLegal, projectRoleProfile, LEGAL_SPECS, ROLE_PROFILES, DELEGATED_ROLES,
  INTAKE_VERSION, KE_COUNTIES,
};
