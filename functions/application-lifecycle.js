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
const { defineSecret } = require('firebase-functions/params');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const logger = require('firebase-functions/logger');
/* Roles (users.roles[] + the Auth claim) have ONE writer. */
const { grantAccountRole } = require('./role-authority');
/* The 14-day seller_free trial has ONE implementation, shared with POS onboarding. */
const { startSellerFreeTrial } = require('./seller-trial');

const REGION = 'us-central1';
const _db = () => getFirestore();
const _ts = () => FieldValue.serverTimestamp();

/* Till Approval Automation — same secret name functions/sokoni-till.js
   already declares (defineSecret is safe to declare more than once for the
   same secret name; this codebase already does this for ALGOLIA_ADMIN_KEY
   across a dozen files). Must be listed in every entry point below that can
   reach applyDecision's seller branch, or mintSokoniTillCore's
   QR_SIGNING_SECRET.value() call throws at runtime. */
const QR_SIGNING_SECRET = defineSecret('QR_SIGNING_SECRET');

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

  /* ── An EXPLICIT declaration beats keyword guessing ──────────────────────
     The keyword pool below matches on EVERY descriptive field, including the
     merchant's own product `category`. That is right for the intakes whose
     `type` is prose ("Cleaning Company / Housekeeper"), and wrong for the ones
     that declare a canonical role — because `legal` and `health` are tested
     BEFORE `seller`, so a shop selling health or legal products was routed to a
     provider registry and never given a shop, a till or a storefront:

         { type:'seller', hub:'marketplace', category:'healthcare' }  ->  health
         { type:'seller', hub:'marketplace', category:'legal'      }  ->  legal

     Both are merchants. `sokoni-merchant-application.js` writes `type: 'seller'`
     deliberately as the intake vocabulary, and a stated intake must not be
     overridden by a guess about what the applicant sells.

     Matched EXACTLY, never as a substring, so prose types (hub-register.js
     writes `type: 'business'`) still fall through to the keyword pool below and
     resolve exactly as they did before. */
  const DECLARED_TYPES = {
    seller: 'seller', merchant: 'seller', vendor: 'seller',
    driver: 'driver', rider: 'driver',
    provider: 'provider', professional: 'provider',
    legal: 'legal', health: 'health',
    /* Entertainment › Events: an organizer who sells tickets (event-manager.html intake). Declared
       only — "event planner" prose still resolves to provider (a bookable service), which is a
       different product. */
    event_organizer: 'event_organizer', organizer: 'event_organizer',
  };
  const declared = String(app.type == null ? '' : app.type).trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(DECLARED_TYPES, declared)) {
    return { role: DECLARED_TYPES[declared], by: 'declared' };
  }

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
  /* ── The CATEGORY decides when the words do not (owner, 2026-09-28) ─────────
     A business the category authority (C1) places EXACTLY in a category whose workspace is merchant-v2 is a
     MERCHANT: merchant-v2 runs on a shop, and only the seller projection provisions one. Without this, a
     "Supermarket / Minimart", a "Hardware" store, a butchery, a farm, a manufacturer or a restaurant — none of whose
     words say "shop" — fell through to `provider`, was approved into a provider record, and was routed to a
     merchant-v2 dashboard with no shop behind it. Declared types never reach this line (they returned above), so
     an applicant's stated intake is never overridden. */
  {
    const BCAT = require('./business-category');
    const cat = BCAT.categoryFromApplication(app, 'provider').category;
    if (cat && require('./business-workspace').ROUTE_OF[cat] === 'merchant-v2.html') return { role: 'seller', by: 'category:' + cat };
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
    /* OB-5 — MIRROR THE RETRACTION ONTO THE ONBOARDING PROJECTION.
       `providerProfiles/{uid}` is a second surface a customer can reach: the ONLY
       providerProfiles-based discovery query is providerSearchProviders, which asks
       for `status == 'active' AND searchable == true`. Suspending the canonical
       record left that projection untouched, so a suspended provider stayed listed
       there — the canonical state said suspended and the projection said findable.

       Only `searchable` is written. `providerProfiles.status` is the ONBOARDING
       state ("the draft is published"), not an approval, and overwriting it here
       would corrupt a different state machine to solve a discovery problem.
       Clearing one flag is sufficient to delist and destroys no profile content;
       the draft, pricing, coverage and portfolio all survive, so a reinstated
       provider has nothing to re-enter. providerProfiles does NOT become an
       authority — it is told what the canonical record decided. */
    /* update(), never set/merge: a provider who never onboarded has no profile to delist, and a merge would CREATE an
       empty providerProfiles doc — which the search sync indexes into the SAME object as the provider (objectID =
       uid), able to overwrite the real record with a blank one. update() on a missing doc fails; the catch keeps it
       a no-op. */
    await db.collection('providerProfiles').doc(uid)
      .update({ searchable: false, suspendedAt: _ts(), updatedAt: _ts() })
      .catch(() => {});
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
  /* HEALTHCARE CATEGORY (CHANGELOG 227) — what kind of health provider this is, recorded by the
     SERVER at approval (functions/healthcare-category.js): an exact match on what the applicant
     chose, or null (UNCLASSIFIED → AdminOS). An administrator's classification is never
     overwritten by a later re-approval; the provider can never write this field (rules). */
  if ((app.role || resolveRole(app).role) === 'health') {
    const HCAT = require('./healthcare-category');
    const prior = existing.healthcare || null;
    if (!(prior && prior.source === 'admin' && HCAT.isCategory(prior.category))) {
      doc.healthcare = { category: HCAT.categoryFromApplication(app), source: 'application',
        applicationId: app.applicationId || app.id || null, setAt: _ts() };
    }
  }
  /* BUSINESS CATEGORY + COMMERCIAL LANE (CHANGELOG 236, convergence C1) — the ONE canonical category
     (functions/business-category.js), stamped by the SERVER here, at approval: an exact match on what the
     applicant chose, or null (UNCLASSIFIED → AdminOS). The lane is what the EXISTING classifier
     (provider-hub.classifyDecidedApplication) decides from this decided application — stamped once so an approved
     provider can no longer re-file into a cheaper lane by editing the application afterwards. An administrator's
     category is never overwritten by a re-approval. For a health provider the category IS the healthcare one
     written above (the two are one decision, written together). */
  {
    const BCAT = require('./business-category');
    const role = app.role || resolveRole(app).role;
    const priorB = existing.business || null;
    const adminSet = !!(priorB && priorB.source === 'admin' && BCAT.isCategory(priorB.category));
    let category = adminSet ? priorB.category : BCAT.categoryFromApplication(app, role).category;
    if (role === 'health') category = (doc.healthcare ? doc.healthcare.category : (existing.healthcare || {}).category) || null;
    doc.business = {
      category: BCAT.isCategory(category) ? category : null,
      lane: require('./provider-hub').classifyDecidedApplication(Object.assign({}, app, { role })),
      source: adminSet ? 'admin' : 'application',
      applicationId: app.applicationId || app.id || null,
      setAt: _ts(),
    };
    if (adminSet && priorB.classifiedBy) doc.business.classifiedBy = priorB.classifiedBy;
  }
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
  /* OB-5 — the same mirror in the other direction. Reinstating a provider must
     restore their discoverability on the projection too, or a reversed suspension
     leaves them approved-but-unfindable: the canonical record says active while
     providerSearchProviders still filters them out. Symmetry here is what makes the
     mirror a mirror rather than a one-way delist. */
  /* update(), never set/merge — mirror onto an EXISTING profile only (see the retraction above): approving a provider
     who never onboarded must not create an empty providerProfiles doc that the search sync would index over the
     provider's own record. */
  await db.collection('providerProfiles').doc(uid)
    .update({ searchable: true, suspendedAt: FieldValue.delete(), updatedAt: _ts() })
    .catch(() => {});
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
/* `opts.ensureBusiness` is injectable for one honest reason: `_ensureBusinessForOwner` closes
   over business-bootstrap's OWN Firestore handle, not the `db` passed here. In production they
   are the same database so it makes no difference, but it means this function's `db` parameter no
   longer covers all of its writes — and that parameter exists precisely so the projection can be
   driven with a stub. Rather than leave that dependency hidden (it silently hung the unit suite),
   it is declared. Production never passes it. */
async function projectDriver(db, app, uid, approved, opts) {
  const ensureBusiness = (opts && opts.ensureBusiness)
    || ((o) => require('./business-bootstrap')._ensureBusinessForOwner(o));
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
    /* `approved` is written EXPLICITLY, not implied by `status`.
       rider-eligibility requires `approved === true` and treats an absent flag as NOT approved —
       absence must never read as permission. This projection previously wrote `approvedAt` and
       `status:'active'` but NO `approved` field, so every freshly approved driver would have been
       refused by the dispatch gate as `not_approved`. Unit fixtures hid it by setting the flag by
       hand; only driving the real projection surfaced it. The one live production `drivers` row
       already carries `approved: true`, so new records now match the shape already in place. */
    approved: true,
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
  /* REINSTATEMENT MUST CLEAR THE SUSPENSION FLAG — the same symmetry OB-5 established for
     providers a few functions above (`providerProfiles.set({ suspendedAt: FieldValue.delete() })`),
     which this path never received.

     The retraction branch sets `suspendedAt`; this branch wrote `status:'active'`,
     `approved:true` and a fresh `approvedAt` and left the flag in place. Measured in production:
     one driver suspended 2026-08-04 and re-approved 2026-08-05 still carried suspendedAt, so
     `rider-eligibility` — the ONLY authoritative reader of this field — refused them as suspended
     with the approval a day newer than the suspension.

     `FieldValue.delete()` rather than `null` or a second `unsuspendedAt` field: three unsuspend
     conventions already exist in this codebase and adding a fourth is how the next reader gets it
     wrong. OB-5 is the closest architectural precedent, so this matches it exactly.

     Deleting rather than nulling matters for the reader: `rider-eligibility` treats a TRUTHY
     suspendedAt as suspension, so null would also work today — but a field that is absent cannot
     be misread by a future consumer that checks for presence instead. */
  const _unsuspend = { suspendedAt: FieldValue.delete() };
  batch.set(rideRef, { ...rideDoc, ..._unsuspend }, { merge: true });
  batch.set(drvRef, { ...drvDoc, ..._unsuspend }, { merge: true });

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
    /* D1 — converge onto the shared verification contract. The provider record already carried
       the governed review workflow and the driver record the structured identifiers; this is
       their union, not a third schema. `verified_on_file` is kept verbatim because renaming a
       live status token would silently reclassify every record already carrying it.

       `humanDecision` is NOT set here. Documents being ON FILE is a statement about paperwork;
       it is not a person's approval, and `isOfficial()` requires both. Writing one from the
       other is exactly the collapse the contract forbids. */
    verificationRoute: null,
    humanDecision: null,
    reviewer1: null,
    reviewer2: null,
    sourceApplicationId: app.applicationId || null,
    updatedAt: _ts(),
  }, { merge: true });

  await batch.commit();

  /* D1-A — the business that will OWN this driver's vehicles.
   *
   * `vehicles` is authorised through `businesses/{businessId}.ownerId` (V-1), so a driver with no
   * business cannot hold a vehicle at all. Provisioning reuses the canonical primitive rather
   * than writing a business here: `_ensureBusinessForOwner` already allocates a `SOK-XXXXXX` id
   * (never `businesses/{uid}`, which is the open directory-row collision), holds a transactional
   * claim so a repeated approval cannot create a second business, and releases that claim on
   * failure so a dead run cannot leave a driver permanently unprovisionable.
   *
   * DELIBERATELY AFTER THE COMMIT. The driver records are the approval's own effect and must not
   * be held hostage to a dependent step. If provisioning throws, applyDecision's catch records
   * `projectionStatus: 'failed'`, the operator sees an incomplete approval, and a retry re-runs
   * everything — safely, because every write in this function is idempotent.
   *
   * THIS IS NOT AN APPROVAL PATH. Having a business confers no dispatch eligibility:
   * `rider-eligibility` reads `drivers` + `driverVerification` and never consults `businesses`.
   * Provisioning gives an approved driver somewhere to put a vehicle; it cannot make an
   * unapproved one operational. */
  let business = null;
  const res = await ensureBusiness({
    uid,
    businessName: name || 'Delivery Rider',
    category: 'delivery',
    /* Skips the seller subscription `_createBusiness` writes by default — a rider is not
       selling marketplace goods, and a trial that downgrades to `seller_free` would enrol them
       in the merchant commission population. */
    businessKind: 'delivery',
    phone: _san(app.phone, 24),
    county: _san(app.county || app.area, 120),
    city: _san(app.city, 120),
  });
  /* `claim-held` is a RACE, not a failure: a concurrent run owns the claim and will finish it.
     Recorded as deferred so it is visible, rather than thrown as an error that would mark a
     perfectly good approval failed. */
  business = {
    merchantId: res.merchantId || null,
    action: res.created ? 'provisioned' : (res.merchantId ? 'already-provisioned' : 'deferred'),
    reason: res.reason,
  };

  return {
    collection: 'drivers+rideDrivers', id: uid,
    action: rideSnap.exists ? 'updated' : 'created',
    documentsMissing: missing,
    business,
  };
}

/* Roles whose registry is still owned by another pipeline. `seller` USED to be
   in here — the projection recorded `action: 'delegated'` and wrote nothing, on
   the assumption that "sellers has its own onboarding". The capability census
   showed that assumption was false: the only writers of `sellers/{uid}` are
   client-side forms, and `shops/{uid}` had exactly one production writer, inside
   a trigger nothing reaches. So an approved merchant got a role and a claim and
   NO shop — and merchant.html then had no canonical shop to resolve. Seller is
   projected properly below.

   `health` LEFT for the same reason, 2026-09-13 (HC-23). The claim that it
   "genuinely still has its own registry" was false in exactly the seller way.
   The ONLY writer of `healthProviders/{uid}` is `registerHealthProvider`
   (functions/healthcare-hub.js), which has no client invoker anywhere in the
   repo; the production census on 2026-09-12 found zero real providers (one
   synthetic fixture, since deleted) and zero applications carrying role
   'health'. So an approved healthcare applicant received `claims.provider` and
   landed in NO registry at all — this branch pushed a receipt object and
   performed no write, and because it MATCHED it also skipped projectProvider().
   Approved, claimed, invisible.

   ADR-014 makes `providers/{uid}` the canonical healthcare provider identity
   and retires healthProviders, so `health` now falls through to
   projectProvider() like every other provider. Nothing else is needed: roleKeyFor
   already maps health → 'provider', so the role field and the claim were always
   correct — only the registry write was missing.

   `legal` is no longer delegated (CHANGELOG 220). Delegation meant an approved
   legal application wrote NOTHING to legalProviders — it only granted the
   `provider` claim — while the registry's own approval (approveLegalProvider)
   required a numeric role claim nothing mints. A `legal` decision now goes to
   the Legal Verification Authority (functions/legal-verification.js), which
   records the SOKONI administrative verification on the Legal record and links
   the canonical providers/{uid} identity. It does NOT make the advocate
   bookable: that also needs a current LSK verification (two authorities, one
   predicate). The legal identity stays ONE record — legalProviders/{uid}. */
/* Roles whose capability lives outside the provider registry. event_organizer: no provider profile
   is projected — the organizer's capability is users.roles (read by event-hub requireOrganizer)
   and the events they create through the server. */
const DELEGATED_ROLES = { event_organizer: 'events' };

/* Shop ids that are not shop ids — the same placeholders the client rejects
   (SokoniBranch synthesises {id:'main'} on an empty device). An application
   that carries one must not activate a shop called "main". */
const PLACEHOLDER_SHOP_IDS = ['main', 'default', 'branch', 'null', 'undefined', ''];
const isPlaceholderShopId = (id) =>
  PLACEHOLDER_SHOP_IDS.indexOf(String(id == null ? '' : id).trim().toLowerCase()) !== -1;

/**
 * Approval → a LIVE shop.
 *
 * Runs BEFORE the role is granted, deliberately: if the shop cannot be
 * established, applyDecision's catch records `projectionStatus: 'failed'` and
 * rethrows, so no seller role and no claim are handed out. The dangerous state
 * this removes is "approved merchant with no shop" — an account that is
 * authorised to sell and has nowhere to sell from.
 *
 * The shop id comes from the application when it named one (2A records
 * `shopId` with its provenance), otherwise the account's own marketplace shop
 * `shops/{uid}`. A merchant's account id and their shop id are NOT the same
 * concept even when they share a value.
 *
 * Idempotent: deterministic ids + merge, so re-approving converges instead of
 * forking a second shop. `createdAt` is written only when the shop is new.
 */
async function projectSeller(db, app, uid, approved) {
  const declared = app.shopId && !isPlaceholderShopId(app.shopId) ? String(app.shopId) : null;
  const shopId = declared || String(uid);
  const shopRef = db.collection('shops').doc(shopId);
  const sellerRef = db.collection('sellers').doc(String(uid));
  const userRef = db.collection('users').doc(String(uid));
  /* The business DIRECTORY record. Until now its only writer was the shop
     wizard inside seller.html — a client-side write on the very path approval
     replaces — so a merchant who became live through APPROVAL existed in the
     storefront (`shops` + `sellers`, which store.html reads) and was absent from
     the directory. Same document id and same shape the wizard used, so the two
     paths converge on one record instead of forking. */
  const bizRef = db.collection('businesses').doc(String(uid));

  const name = _sanText(app.name || app.businessName || app.storeName, 160) || 'My Shop';
  /* Both reads before any write — the directory record's createdAt must be
     preserved, and that cannot be decided after the batch has started. */
  const [existing, bizExisting] = await Promise.all([
    shopRef.get(),
    bizRef.get().catch(() => null),
  ]);

  if (!approved) {
    /* A rejection has nothing to retract (no shop was ever created). A
       suspension deactivates the shop but never deletes it — the merchant's
       products, orders and history stay intact for reinstatement. */
    if (existing.exists) {
      await shopRef.set({ status: 'suspended', suspendedAt: _ts(), updatedAt: _ts() }, { merge: true });
      await sellerRef.set({ status: 'suspended', active: false, updatedAt: _ts() }, { merge: true }).catch(() => {});
      /* Retract the directory listing too. A suspended merchant that stays
         discoverable is the same defect as an approved one that never appears —
         the registries must move together or they disagree about who is live. */
      await bizRef.set({ status: 'suspended', updatedAt: _ts() }, { merge: true }).catch(() => {});
      return { collection: 'shops', id: shopId, action: 'suspended' };
    }
    return { collection: 'shops', id: shopId, action: 'none' };
  }

  const batch = db.batch();

  /* The canonical shop. `ownerId` is what every server-side ownership check
     reads (analytics-engine, merchantAdjustStock); `sellerUid` states the same
     fact in the merchant vocabulary. */
  batch.set(shopRef, {
    shopId,
    ownerId: String(uid),
    sellerUid: String(uid),
    name,
    nameLower: name.toLowerCase(),
    status: 'active',
    activatedAt: _ts(),
    updatedAt: _ts(),
    source: 'application_approval',
    applicationId: app.applicationId || null,
    ...(existing.exists ? {} : { createdAt: _ts() }),
    ...(app.category ? { category: _sanText(app.category, 80) } : {}),
    ...(app.phoneNumber ? { phoneNumber: app.phoneNumber } : {}),
    ...(app.location ? { location: _sanText(app.location, 160) } : {}),
  }, { merge: true });

  /* The seller registry the storefront reads. Keyed by the ACCOUNT (that is how
     every existing reader addresses it) and carrying the shop it belongs to. */
  batch.set(sellerRef, {
    uid: String(uid),
    shopId,
    name,
    nameLower: name.toLowerCase(),
    status: 'active',
    active: true,
    /* `updatedAt` is load-bearing: the discovery queries order by it, so a
       registry row without one is invisible to the very listing it just
       joined. */
    updatedAt: _ts(),
    ...(existing.exists ? {} : { createdAt: _ts() }),
  }, { merge: true });

  /* The business directory listing. `createdAt` is preserved on re-approval so
     the directory's orderBy('createdAt') cannot silently drop a reinstated
     merchant.

     `verified` is deliberately NOT written here. The homepage counts
     `businesses where verified == true` as its seller total and the field drives
     a trust badge, so setting it would be a trust claim made as a side effect of
     an approval — a commercial decision, not a projection. It stays an explicit
     admin action. */
  batch.set(bizRef, {
    uid: String(uid),
    ownerId: String(uid),
    shopId,
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

  /* The account's active shop — what the Seller Hub resolves first. Without
     this, an approved merchant with a shop still lands in a workspace that
     cannot tell which shop is theirs. */
  batch.set(userRef, { activeShopId: shopId, updatedAt: _ts() }, { merge: true });

  await batch.commit();

  return {
    collection: 'shops+sellers+businesses', id: shopId,
    action: existing.exists ? 'reactivated' : 'created',
    shopId, sellerUid: String(uid), activeShopId: shopId,
    businessId: String(uid),
    shopIdSource: declared ? 'application.shopId' : 'account_shop',
  };
}

/* Account roles now live in ONE primitive — ./role-authority. Both halves of a
   role (users.roles[] and the Auth custom claim) are written there, and a claim
   that fails after the Firestore commit is recorded as an observable
   divergence instead of a warn. This module used to own that logic; two other
   paths granted roles without it and produced accounts whose `roles` said
   "seller" while their token did not. See role-authority.js for the contract. */

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
    } else if (role === 'seller') {
      /* Before the role is granted — see projectSeller. A merchant is never
         authorised to sell before they have somewhere to sell from. */
      receipt.writes.push(await projectSeller(db, app, uid, approved));
    } else if (role === 'legal') {
      /* SOKONI administrative verification only — LSK verification is the second, independent gate. */
      receipt.writes.push(await require('./legal-verification').applyAdminDecision(db, {
        uid, app, appId, status, decidedBy: opts.decidedBy || app.decidedBy || null,
      }));
    } else if (DELEGATED_ROLES[role]) {
      receipt.writes.push({ collection: DELEGATED_ROLES[role], id: uid, action: 'delegated' });
    } else {
      receipt.writes.push(await projectProvider(db, app, uid, approved));
    }

    /* A pending application must not grant anything; only a decision does. */
    let claimPending = false;
    if (status === 'approved' || status === 'rejected' || status === 'suspended') {
      const grant = await grantAccountRole(db, uid, role, approved, {
        source: 'applicationLifecycle', entityId: appId,
      });
      receipt.roleKey = grant.key;
      receipt.claim = grant.claim;
      claimPending = !grant.ok;
      if (claimPending) receipt.claimReconcileId = grant.reconcileId;
    }

    /* Entitlement — LAST, and only for an approved seller whose shop exists.
       The trial is the same 14-day `seller_free` the POS path starts, through
       the same authority (./seller-trial); marketplace approval does NOT create
       the POS-only `merchants/` or `branches/` records to get it. Idempotent:
       an existing subscription is left alone, so a repeat approval cannot
       restart a trial or overwrite a paid plan. A trial is an entitlement, not
       a gate — a failure here is reported, never a reason to undo an approval
       that already granted the role and activated the shop. */
    if (approved && role === 'seller') {
      const shopWrite = receipt.writes.find((w) => w && w.shopId);
      if (shopWrite && shopWrite.shopId) {
        const trial = await startSellerFreeTrial({
          db, uid, shopId: shopWrite.shopId, source: 'application_approval',
        });
        receipt.trial = trial;
      }
    }

    /* SOKONI Till — Till Approval Automation. Same reasoning as the trial
       above: an entitlement, not a gate, and LAST for the identical reason
       (only after the shop genuinely exists). Every approved seller with a
       real shop gets exactly one ACTIVE Till for their main branch,
       automatically — nobody has to find a settings page and press
       "Generate." Reuses mintSokoniTillCore — functions/sokoni-till.js's
       OWN identity-allocation transaction, unmodified logic, called
       server-side rather than duplicated here. shopId/branchId are
       resolved GENERICALLY from projectSeller's own receipt — the exact
       same path any shop takes, KASS Shop included; nothing here names a
       specific merchant. onExisting:'return' is what makes this
       idempotent: applicationLifecycle (the Firestore trigger below) can
       legitimately re-fire for the same approval, and a repeat must
       converge on the same Till, never mint a second one. A failure here
       is reported, never a reason to undo an approval that already
       granted the role and activated the shop — matches every other
       entitlement in this function. */
    if (approved && role === 'seller') {
      const shopWrite = receipt.writes.find((w) => w && w.shopId);
      if (shopWrite && shopWrite.shopId) {
        try {
          const { mintSokoniTillCore } = require('./sokoni-till')._internal;
          const till = await mintSokoniTillCore({
            shopId: shopWrite.shopId,
            branchId: `${shopWrite.shopId}-main`,
            actorUid: uid,
            onExisting: 'return',
            source: 'application_approval',
          });
          receipt.till = { sokoniTillId: till.sokoniTillId, created: till.created };

          /* The BUSINESS wallet, provisioned in the same breath as the Till and for the
             same reason: the merchant should not have to find a settings page before the
             platform works. POS/Till commission is settled from this wallet and NEVER from
             the merchant's personal `wallets/{uid}` — they are different collections so the
             two can never be confused. Opens at zero; a wallet that could be created with
             money in it could be credited without a ledger entry.

             Keyed by SHOP, like the Till, because one owner may run several businesses.
             Idempotent, and it never re-owns an existing wallet. */
          try {
            const { ensureBusinessWallet } = require('./business-wallet');
            const bw = await ensureBusinessWallet(db, {
              shopId: shopWrite.shopId, ownerUid: uid, currency: 'KES',
            });
            receipt.businessWallet = { shopId: shopWrite.shopId, action: bw.action };
          } catch (bwErr) {
            /* An entitlement, not a gate — same as the Till and the trial. A merchant is
               approved and selling before they owe anything; the wallet is provisioned on
               first use if this failed. Reported, never a reason to undo an approval. */
            logger.error('[appLifecycle] business wallet provisioning failed (recoverable)', {
              appId, uid, shopId: shopWrite.shopId, error: bwErr.message,
            });
            receipt.businessWallet = { error: String(bwErr.message || bwErr).slice(0, 300) };
          }
        } catch (tillErr) {
          logger.error('[appLifecycle] Till issuance failed (recoverable)', {
            appId, uid, shopId: shopWrite.shopId, error: tillErr.message,
          });
          receipt.till = { error: String(tillErr.message || tillErr).slice(0, 300) };
        }
      }
    }

    /* The projection is only 'applied' when BOTH halves of the role landed. A
       granted role whose Auth claim never minted leaves the applicant behaving
       as a buyer, so it is reported as pending — `applicationList` already
       surfaces anything that is approved but not 'applied', and the trigger's
       idempotency guard (projectionStatus === 'applied') lets a later write
       re-run the projection and re-attempt the mint. */
    await db.collection('applications').doc(appId).set({
      statusCanonical: status,
      decisionAppliedFor: status,
      decisionAppliedAt: _ts(),
      projectionStatus: claimPending ? 'applied_claim_pending' : 'applied',
      projectionError: claimPending
        ? `Role "${receipt.roleKey}" granted in Firestore but the Auth claim did not mint — see roleClaimReconcile/${receipt.claimReconcileId}.`
        : FieldValue.delete(),
      projectionReceipt: receipt.writes,
      ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}),
    }, { merge: true });

    /* Tell the applicant. notify.js is the single entry point (it owns channel
       selection, quiet hours and dedupe) so this is one call, not a bespoke
       SMS. dedupeKey makes a retried trigger silent rather than spammy. */
    if (status === 'approved') {
      try {
        const { notify } = require('./notify');
        /* Do not promise an account the applicant cannot yet use. Until the
           claim mints their token still reads as a buyer, so a "you are live"
           message would be a success notice over a half-applied decision. */
        /* Approval routes to ONE deterministic dashboard (shared/entertainment-registry.js
           role → dashboard); roles the registry does not cover keep their message unchanged. */
        /* CHANGELOG 240 (C2c): the approval link is the ONE resolver — workspace.html asks the server where this account
           belongs now that it is approved (business-workspace.homeFor), instead of a second role → page table. */
        const _dash = 'workspace.html';
        const approvedBody = role === 'driver'
          ? 'Your rider application is approved. Open the SOKONI driver app and go online to start receiving deliveries.'
          : role === 'event_organizer'
            ? 'You are approved as an event organizer. Open Event Manager to create your first event and start selling tickets.'
            : role === 'legal'
              /* Never "live": an advocate is bookable only once LSK verification is also current. */
              ? 'SOKONI has approved your advocate application. You will appear to clients once your Law Society of Kenya practising status has been verified.'
              : `${app.name || 'Your business'} is now live on SOKONI and customers can find you in search.`;
        await notify({
          uid,
          type: role === 'driver' ? 'rider_approved' : role === 'event_organizer' ? 'organizer_approved' : 'merchant_approved',
          title: claimPending ? 'Approved — finishing setup' : 'You are approved on SOKONI',
          body: claimPending
            ? 'Your application is approved. We are finishing the last step of your account setup — you will be able to sign in to your new dashboard shortly.'
            : approvedBody,
          phone: app.phoneNumber || undefined,
          /* Distinct key per variant: a re-run that finally mints the claim must
             still be able to send the real "you are live" message. */
          dedupeKey: claimPending ? `app_approved_pending:${appId}` : `app_approved:${appId}`,
          data: { applicationId: appId, role, claimPending, ...(_dash ? { dashboard: _dash, link: _dash } : {}) },
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
   A decision is an ADMIN act — so verify the DECIDER, not the document.

   `firestore.rules` lets an applicant update their own application:

       allow update: if isAdmin() || (isOwner() && claimsOwner() && noAdminFields())

   and `noAdminFields()` withholds `approved`, `role`, `verified`, `approvedBy` —
   none of which this engine reads. It does NOT withhold `status`, which is the
   only field the projection consults. So any signed-in user could write
   `status: 'approved'` (or 'active' / 'accepted' / 'verified' — canonStatus maps
   all four) onto their OWN request and be granted the role and the Auth claim by
   this trigger. The rule's own comment says self-approval is impossible; it
   guards a field the decision engine never looks at.

   Every legitimate decision goes through `applicationDecide`, which is admin-only
   and stamps `decidedBy`. But `decidedBy` is itself client-writable, so trusting
   its presence would only move the forgery one field along. Custom claims are the
   one thing a client cannot write, so authorisation is decided by reading the
   claims of the account named in `decidedBy`.

   Returns { ok } — never throws: an unresolvable decider is a refusal, not a
   crash that leaves the application in limbo.
   ────────────────────────────────────────────────────────────────────────── */
/* 2026-09-27 (Entertainment readiness sweep): the claims check alone was FORGEABLE. Admin uids are
   readable in public documents (moderatedBy / reviewedBy), so an applicant could write
   status:'approved' + decidedBy:<a real admin uid> onto their own request and pass. A decision is
   now honoured only when applicationDecide's SERVER-ONLY record (applicationDecisions/{appId},
   rules write:false) names the same status and the same decider. The claims check stays as the
   second layer. */
const DECISIONS = 'applicationDecisions';
async function decisionAuthority(after, appId) {
  const by = typeof after.decidedBy === 'string' ? after.decidedBy.trim() : '';
  if (!by) {
    return { ok: false, reason: 'no decidedBy — a decision is only made through applicationDecide' };
  }
  let rec = null;
  try {
    const s = appId ? await _db().collection(DECISIONS).doc(String(appId)).get() : null;
    rec = s && s.exists ? s.data() : null;
  } catch (e) {
    return { ok: false, reason: `the server decision record could not be read (${e.message})` };
  }
  if (!rec) return { ok: false, reason: 'no server decision record — a decision is only made through applicationDecide' };
  if (rec.status !== canonStatus(after.status) || rec.decidedBy !== by) {
    return { ok: false, reason: `the application claims "${canonStatus(after.status)}" by "${by}", but the server decision record says "${rec.status}" by "${rec.decidedBy}"` };
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

/* ─────────────────────────────────────────────────────────────────────────────
   TRIGGER — applications/{appId}
   Settles in at most two extra hops: normalise (1), project (1), then every
   guard short-circuits.
   ────────────────────────────────────────────────────────────────────────── */
exports.applicationLifecycle = onDocumentWritten(
  { document: 'applications/{appId}', region: REGION, timeoutSeconds: 120, memory: '256MiB',
    secrets: [QR_SIGNING_SECRET] },
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

    /* Phase 2a — authorise the decision before acting on it. A submitted
       application is a REQUEST; only an admin turns it into a grant. */
    const authority = await decisionAuthority(after, appId);
    if (!authority.ok) {
      /* Already recorded for this exact status: return WITHOUT writing. The
         block below is itself a write to this document, so re-writing it would
         re-fire this trigger forever. */
      if (after.projectionStatus === 'blocked_unauthorised_decision' && after.blockedFor === status) return;

      /* The status is left as the client wrote it — deliberately. Rewriting it
         would silently downgrade a legitimately-decided legacy application that
         predates `decidedBy`; blocking the PROJECTION grants nothing either way,
         and an admin re-deciding through applicationDecide clears it. */
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
  { region: REGION, maxInstances: 10, enforceAppCheck: true, secrets: [QR_SIGNING_SECRET] },
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

    /* ── Seller Agreement gate ────────────────────────────────────────────
       A business may not be APPROVED until it has acknowledged the commercial
       terms it will be bound by — the marketplace plan ladder (Free 15 / Basic 10 / Pro 5 /
       Enterprise 0), the flat 5% on POS/till sales, and the KES 10 minimum
       and the fact that SOKONI does not deduct it from the customer's payment.

       Enforced here rather than only in the browser: the submit button is a
       hint, and an application can reach this collection by any client that can
       satisfy firestore.rules. Approval is the moment the obligation attaches,
       so approval is where the check belongs.

       Only `approve` is gated. Reject, suspend and request_info must keep
       working on an application that never acknowledged anything — otherwise a
       reviewer could not clear the very applications this rule holds back.

       Applications created BEFORE this gate existed have no acknowledgement and
       will be refused. That is deliberate: the alternative is approving a
       merchant onto commercial terms they were never shown. Use request_info to
       send them back for acknowledgement. */
    if (decision === 'approve') {
      const _a = snap.data() || {};
      const _role = _a.role || resolveRole(_a).role;

      /* Roles whose approval requires the CANONICAL versioned acceptances (legalAcceptances via
         legalAccept), never the client-written boolean: healthcare, and Entertainment › Events
         organizers (their instruments: organizer agreement, ticketing & refund obligations, staff &
         cash handling, commission, settlement — legal-agreements.js ROLE_AGREEMENTS.event_organizer). */
      /* Advocates (CHANGELOG 220): the declaration on the Legal Hub form accepts the Terms of Service,
         not the Seller Agreement's commission rates — mapping it to that boolean would fabricate a
         commercial acceptance. An advocate taking bookings through SOKONI is a SERVICE PROVIDER, so the
         canonical versioned acceptances are checked against the provider catalogue. */
      if (_role === 'health' || _role === 'event_organizer' || _role === 'legal') {
        /* ── HEALTHCARE ACCEPTS A DIFFERENT INSTRUMENT ─────────────────────────
           The boolean below is the *Seller* Agreement acknowledgement — the
           marketplace listing ladder and the POS commission rate
           (hub-register.js AGREEMENT_VERSION '…-lanes-mkt-ladder-pos-5pct',
           text served from /seller-terms). A clinician, a hospital or a pharmacy
           is not a marketplace seller, and ticking that box must never be
           accepted as their professional undertaking.

           So healthcare is gated on the CANONICAL record instead: the versioned,
           immutable `legalAcceptances` written by legalAccept, checked server-side
           against the catalogue for role 'health' (aliased to 'healthcare' —
           ROLE_AGREEMENTS is keyed by the latter). `legalAcceptances` remains the
           one acceptance database; nothing is duplicated here, and the boolean on
           the application is deliberately NOT consulted for this role, so an
           application carrying a Seller Agreement tick still cannot be approved.

           Until legal publishes `healthcare-provider-agreement` and
           `medical-compliance-declaration`, no healthcare application can satisfy
           this — which is the intended state. `reject` and `request_info` are
           untouched, so the queue can still be worked. */
        const uidForLegal = _a.uid || null;
        if (!uidForLegal) {
          throw new HttpsError('failed-precondition',
            'This healthcare application cannot be approved: it carries no account to check ' +
            'agreement acceptance against.');
        }
        let comp;
        try {
          comp = await require('./legal-agreements').complianceFor(uidForLegal, _role === 'legal' ? 'provider' : _role);
        } catch (e) {
          /* FAIL CLOSED. If the compliance record cannot be read we do not know
             whether the applicant accepted anything, and "unknown" must not
             approve a clinician. */
          logger.error('[appLifecycle] healthcare compliance check failed', { applicationId, error: e.message });
          throw new HttpsError('failed-precondition',
            'This healthcare application cannot be approved: the agreement record could not be ' +
            'verified. Try again, and escalate if it persists.');
        }
        if (!comp.compliant) {
          const names = comp.missing.map((m) => `${m.name} (${m.reason})`).join(', ');
          throw new HttpsError('failed-precondition',
            `This ${_role === 'health' ? 'healthcare' : _role === 'legal' ? 'advocate' : 'event organizer'} application cannot be approved: the applicant has not accepted the ` +
            'required agreements. Outstanding: ' + (names || 'unknown') +
            '. Use "request_info" to ask them to complete the acceptance. Accepting the Seller ' +
            'Agreement does not satisfy this.');
        }
      } else if (_a.agreementAccepted !== true) {
        throw new HttpsError(
          'failed-precondition',
          'This application cannot be approved: the applicant has not accepted the SOKONI ' +
          'Seller Agreement and its commission rates. Use "request_info" to ask them ' +
          'to complete the acknowledgement.'
        );
      }
    }

    const STATUS = { approve: 'approved', reject: 'rejected', suspend: 'suspended', request_info: 'info_requested' };
    const status = STATUS[decision];
    const actor = req.auth.uid;

    /* The SERVER-ONLY decision record the trigger and the reconcile path require (decisionAuthority).
       Written FIRST: the application write below re-fires the trigger, which must find it. */
    await db.collection(DECISIONS).doc(String(applicationId)).set({
      appId: String(applicationId), decision, status: canonStatus(status), decidedBy: actor, decidedAtMs: Date.now(),
      reason: _sanText(reason, 500) || null,
    });

    await ref.set({
      status,
      statusCanonical: canonStatus(status),
      reviewReason: _sanText(reason, 500) || null,
      decidedBy: actor,
      decidedAt: _ts(),
      /* SERVER-stamped proof that the acknowledgement was present and verified
         at the moment of approval. `agreementAcceptedAt` on the application is a
         CLIENT clock (the browser wrote that document), so it is evidence of
         intent but not of time. This field is the one to rely on. */
      ...(decision === 'approve' ? {
        agreementVerifiedAt:      _ts(),
        agreementVerifiedVersion: (snap.data() || {}).agreementVersion || null,
      } : {}),
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
  { region: REGION, maxInstances: 5, enforceAppCheck: true, timeoutSeconds: 300, secrets: [QR_SIGNING_SECRET] },
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
      /* A repair re-applies a decision; it never MAKES one. A status with no matching server decision
         record (e.g. one the applicant wrote) is refused — re-decide it through applicationDecide. */
      const auth1 = await decisionAuthority(app, snap.id);
      if (!auth1.ok) return { ok: true, results: [{ ok: false, appId: snap.id, refused: true, reason: auth1.reason }] };
      return { ok: true, results: [await applyDecision(snap.id, app, { decidedBy: auth1.by })] };
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
        const authN = await decisionAuthority(app, d.id);
        if (!authN.ok) { results.push({ ok: false, appId: d.id, refused: true, reason: authN.reason }); continue; }
        results.push(await applyDecision(d.id, app, { decidedBy: authN.by }));
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
        /* ── Agreement evidence ────────────────────────────────────────────────
           A reviewer approving someone should be able to see WHAT they accepted
           and at which version, not merely discover on failure that they did not.
           These are the application's own fields, so they cost no extra read.
           `agreementVerifiedAt` / `agreementVerifiedVersion` are the SERVER-stamped
           pair written at approval — the ones to rely on; `agreementAcceptedAt` is
           a browser clock on a client-written document. */
        agreementAccepted: a.agreementAccepted === true,
        agreementVersion: a.agreementVersion || null,
        agreementAcceptedAt: a.agreementAcceptedAt || null,
        agreementVerifiedAt: a.agreementVerifiedAt
          ? (a.agreementVerifiedAt.toMillis ? a.agreementVerifiedAt.toMillis() : a.agreementVerifiedAt) : null,
        agreementVerifiedVersion: a.agreementVerifiedVersion || null,
        /* Filled below for healthcare only — see the canonical-evidence pass. */
        legalCompliance: null,
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

    /* ── Canonical agreement evidence, healthcare only ─────────────────────────
       Healthcare approval is gated on `legalAcceptances`, not on the application's
       boolean, so a reviewer needs to see the canonical record — which instrument,
       which version, which content hash — before deciding. That costs one query per
       applicant, so it runs ONLY for role 'health' and is capped: a reviewer works a
       page at a time, and an unbounded fan-out here is how an admin list becomes the
       most expensive read on the platform. Beyond the cap the field stays null rather
       than half-true, and the failure of one lookup never fails the listing. */
    const HEALTH_EVIDENCE_CAP = 25;
    const healthItems = items.filter((i) => i.role === 'health').slice(0, HEALTH_EVIDENCE_CAP);
    if (healthItems.length) {
      const legal = require('./legal-agreements');
      await Promise.all(healthItems.map(async (i) => {
        if (!i.uid) { i.legalCompliance = { error: 'no-account' }; return; }
        try {
          const c = await legal.complianceFor(i.uid, 'health');
          i.legalCompliance = {
            compliant: c.compliant,
            requiredCount: c.requiredCount,
            required: c.required,
            missing: c.missing,
            accepted: Object.values(c.accepted || {}),
          };
        } catch (e) {
          /* Say the lookup failed. A null here would read as "nothing accepted". */
          i.legalCompliance = { error: e.message || 'lookup-failed' };
        }
      }));
    }

    return { ok: true, items, counts, unpublished, total: items.length };
  }
);

/* Internals exported for unit tests and for the reconcile script. */
exports._internal = {
  toE164KE, toLocalKE, splitLocation, resolveRole, canonStatus, normVehicle, _san, _sanText,
  /* projectSeller is exported so provider-shop.js can provision a healthcare provider's
     merchant identity through THIS function rather than a healthcare-specific copy. One
     projection, one shop shape, whether the shop came from merchant approval or from a
     clinic asking for one. */
  buildIntakePatch, applyDecision, projectProvider, projectDriver, projectSeller,
  INTAKE_VERSION, KE_COUNTIES,
};
