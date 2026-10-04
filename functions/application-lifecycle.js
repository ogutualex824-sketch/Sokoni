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
/* Marketing Hub MK2 — the ONE marketing taxonomy; approval activates only admin-approved categories. */
const MKT = require('./shared/marketing-taxonomy');
/* Roles (users.roles[] + the Auth claim) have ONE writer. */
const { grantAccountRole } = require('./role-authority');
/* The 14-day seller_free trial has ONE implementation, shared with POS onboarding. */
const { startSellerFreeTrial } = require('./seller-trial');
const DECISIONS = 'applicationDecisions';
const { defineSecret } = require('firebase-functions/params');
const QR_SIGNING_SECRET = defineSecret('QR_SIGNING_SECRET');

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
/* ── FOOD HUB GATE 1 (2026-10-03): a goods/food business is a SELLER ──────────────────────────────────────────
   hub-register.js declares `requestedRole: 'provider'` for every category it does not map (its _ROLE_BY_HUB names
   only delivery / healthcare / legal / shopping), so a restaurant, café, bakery or butcher was approved as a SERVICE
   provider — and the workspace authority (business-workspace.laneOf: these categories route to merchant-v2, the
   products lane) then refused it with CATEGORY_CAPABILITY_DISAGREEMENT. Nothing reached a menu, a shop or a till.

   The category the applicant picked (an exact business id, through business-category — never free text) decides the
   lane: when the role resolved to `provider` and that category is a merchant-v2 category (the seller categories +
   restaurant), the role is `seller`. Only `provider` is ever re-filed; every other declared role stands. Recorded as
   `<by>+category:<cat>` so a reviewer sees that the category, not the declaration, decided it. */
/* ══ EDUCATION E1 (owner decisions 2026-10-03) — four applicant types through the ONE application framework ═════════
   The type is decided HERE from the intake category id, never from a client-sent field:
     · teacher      — an individual tutor / private teacher ('tutor');
     · institution  — a school, college, training centre or e-learning business ('school', 'online-course');
     · enterprise   — a COMPANY BUYING TRAINING for its staff ('education-enterprise'). It is a verified BUYER: it gets
                      an educationEnterprises/{uid} record and NO provider listing, NO account role, NO claim;
     · learner      — NOT an application: an instant self-service profile (owner decision), never routed here.
   Teacher and institution approvals provision a provider exactly as before (education dashboards are E2) and stamp
   the type on the application and the provider record. An approval is REFUSED until the documents the type requires
   are declared (AdminOS verifies them): applicationDecide refuses up front, and applyDecision refuses again for any
   other path, provisioning nothing either way. "Request info" is the change-request path. */
const EDUCATION_TYPES = Object.freeze({
  tutor: 'teacher', school: 'institution', 'online-course': 'institution', 'education-enterprise': 'enterprise',
});
const EDUCATION_REQUIRED = Object.freeze({
  teacher:     [['subjects', 'Subjects you teach']],
  institution: [['registrationNo', 'Registration / accreditation number']],
  enterprise:  [['companyRegNo', 'Company registration number'], ['kraPin', 'KRA PIN']],
});
const KRA_PIN = /^[AP]\d{9}[A-Z]$/;
function educationTypeOf(app) {
  const id = String((app && app.category) || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(EDUCATION_TYPES, id) ? EDUCATION_TYPES[id] : null;
}
/* → the labels of what an approval still needs (empty = complete). Reads applications/{id}.details only. */
function educationMissing(app, type) {
  const d = app && app.details && typeof app.details === 'object' ? app.details : {};
  const miss = [];
  for (const [k, label] of EDUCATION_REQUIRED[type] || []) if (!String(d[k] || '').trim()) miss.push(label);
  if (type === 'enterprise' && String(d.kraPin || '').trim() && !KRA_PIN.test(String(d.kraPin).trim().toUpperCase())) {
    miss.push('A valid KRA PIN (11 characters, e.g. P051234567X)');
  }
  return miss;
}
/* The verified enterprise BUYER. Server-only collection; idempotent (re-approval converges on one document). */
async function projectEducationEnterprise(db, app, uid, approved) {
  const ref = db.collection('educationEnterprises').doc(uid);
  if (!approved) {
    await ref.set({ ownerUid: uid, status: 'inactive', approved: false, updatedAt: _ts() }, { merge: true });
    return { collection: 'educationEnterprises', id: uid, action: 'retracted' };
  }
  const d = app.details && typeof app.details === 'object' ? app.details : {};
  const snap = await ref.get();
  await ref.set({
    ownerUid: uid,
    companyName: _san(app.name || app.businessName || '', 140),
    companyRegNo: _san(d.companyRegNo || '', 40),
    kraPin: _san(String(d.kraPin || '').trim().toUpperCase(), 11),
    staffSeats: Number.isFinite(Number(d.staffSeats)) ? Math.max(0, Math.floor(Number(d.staffSeats))) : null,
    trainingNeeds: _sanText(d.trainingNeeds || '', 300),
    phone: app.phoneNumber || app.phone || null,
    location: _san(app.location || '', 120),
    status: 'active', approved: true, approvedAt: _ts(),
    sourceCollection: 'applications', sourceId: app.applicationId || null,
    _noIndex: true,
    updatedAt: _ts(),
    ...(snap.exists ? {} : { createdAt: _ts() }),
  }, { merge: true });
  return { collection: 'educationEnterprises', id: uid, action: snap.exists ? 'updated' : 'created' };
}

const MERCHANT_CATEGORIES = Object.freeze(['restaurant']);
function _merchantCategoryOf(app) {
  const BCAT = require('./business-category');
  const c = BCAT.categoryFromApplication(app, 'provider').category;
  if (!c) return null;
  if (BCAT.SELLER_CATEGORIES.includes(c) || MERCHANT_CATEGORIES.includes(c)) return c;
  /* r2 (C1): a category whose workspace is merchant-v2 runs on a shop, so only the seller projection fits it */
  try { return require('./business-workspace').ROUTE_OF[c] === 'merchant-v2.html' ? c : null; } catch (_) { return null; }
}
/* ── H1 (owner 2026-10-03, E2E gate) — THE CATEGORY IS DECIDED AT APPROVAL ─────────────────────────────────────────
   An approval that lands an account in the providers registry must carry a CATEGORY from business-category.js. It is
   resolved by EXACT match on the application (categoryFromApplication), refused when nothing matches, frozen on the
   server decision record (applicationDecisions.businessCategory), and stamped onto providers/{uid}.business IN THE
   SAME WRITE that makes the provider active (projectProvider). So there is never an approved-but-uncategorized active
   provider, and the client can never supply or change it: the decision record is client-unwritable, the rules lock
   providers.business. An existing ADMIN stamp is never silently re-categorised. */
function _decidedRoleOf(app) {
  const _r = resolveRole(app);
  const AT = applicantTypeOf(app);
  const typedRole = AT ? AT.T.role(AT.m) : null;
  /* the same precedence applyDecision uses */
  return typedRole
    || (_r.by === 'explicit' || _r.by === 'explicit-alias' || /\+category(:|$)/.test(_r.by) ? _r.role : (app.role || _r.role));
}
function _projectsToProviders(app, role) {
  if (applicantTypeOf(app)) return false;                     /* typed applicants (education, marketing …) own their projection */
  if (role == null) return false;                             /* quarantined: nothing is provisioned */
  if (role === 'driver' || role === 'rider' || role === 'legal' || role === 'seller') return false;
  if (ROLE_PROFILES[role] || DELEGATED_ROLES[role]) return false;   /* health → healthProviders, mechanic/landlord/tenant profiles */
  return true;                                                /* applyDecision's final branch: projectProvider */
}

function resolveRole(app) {
  const r = _resolveDeclaredRole(app);
  if (r.role === 'provider' && r.by !== 'declared') {   /* a stated intake type is never overridden (r2) */
    const cat = _merchantCategoryOf(app);
    if (cat) return Object.assign({}, r, { role: 'seller', by: r.by + '+category:' + cat, category: cat });
  }
  return r;
}
function _resolveDeclaredRole(app) {
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
    return { role: DECLARED_TYPES[declared], by: 'declared' };   /* a stated intake `type` (r2): honoured before keyword guessing, never overridden by category */
  }


  const hay = [
    app.role, app.type, app.applicationType, app.category, app.categoryLabel,
    app.hub, app.professionalType, app.businessType, app.serviceType,
  ].filter(Boolean).join(' ').toLowerCase();

  const test = (re) => re.test(hay);

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
async function projectProvider(db, app, uid, approved, popts) {
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
  /* H1 (owner 2026-10-03): the category this APPROVAL decided — frozen on the server decision record — wins over the
     application-derived one above; the lane (r2) is kept. An administrator's stamp is never re-categorised. */
  let bizNote = null;
  if (popts && popts.appId) {
    const BCAT = require('./business-category');
    const dSnap = await db.collection('applicationDecisions').doc(String(popts.appId)).get();
    const dRec = dSnap.exists ? (dSnap.data() || {}) : {};
    if (BCAT.isCategory(dRec.businessCategory)) {
      const eb = existing.business || null;
      if (eb && eb.source === 'admin' && BCAT.isCategory(eb.category) && eb.category !== dRec.businessCategory) bizNote = 'admin_category_kept';
      else doc.business = Object.assign({}, doc.business || {}, { category: dRec.businessCategory, source: 'application', setBy: dRec.decidedBy || null, setAt: _ts(), applicationId: String(popts.appId) });
    } else bizNote = 'no_decided_category';
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
  return { collection: 'providers', id: uid, action: snap.exists ? 'updated' : 'created', providerId, ...(doc.business ? { businessCategory: doc.business.category } : {}), ...(bizNote ? { businessNote: bizNote } : {}) };
}

/**
 * Marketing Hub MK2 — a marketing application (hub 'marketing', written ONLY by marketing-hub.js marketingApply) projects
 * onto the SAME providers/{uid} record as every other service provider, plus its own marketing block:
 *   marketingType        individual | agency | specialist (the applicant's declared type, server-validated at intake)
 *   marketingCategories  ONLY the admin-approved subset of requestedCategories (applicationDecide approvedCategories) —
 *                        a requested-but-unapproved category is never listed, never bookable
 *   marketingStatus      the decision ('active' | 'rejected' | 'suspended')
 * A NON-approval retracts ONLY the marketing block: an existing cleaning company that also applied as a marketer keeps its
 * cleaning listing when the marketing application is rejected (projectProvider's retraction would suspend all of it).
 */
async function projectMarketing(db, app, uid, approved, status) {
  const ref = db.collection('providers').doc(uid);
  const snap = await ref.get();
  const requested = MKT.normalizeCategories(app.requestedCategories, 30);
  const approvedCats = MKT.normalizeCategories(app.marketingApprovedCategories, 30).filter((c) => requested.indexOf(c) >= 0);
  if (!approved) {
    if (!snap.exists) return { collection: 'providers', id: uid, action: 'marketing_noop_absent' };
    await ref.set({ marketingStatus: status === 'rejected' ? 'rejected' : 'suspended', marketingCategories: [], marketingGroups: [],
      marketingListed: false, marketingUpdatedAt: _ts(), updatedAt: _ts() }, { merge: true });
    return { collection: 'providers', id: uid, action: 'marketing_retracted' };
  }
  if (!approvedCats.length) throw new Error('marketing approval has no approved categories');
  let base = null;
  if (!snap.exists) base = await projectProvider(db, app, uid, true);
  await ref.set({
    marketingType: MKT.APPLICATION_TYPES[app.marketingType] ? app.marketingType : 'individual',
    marketingCategories: approvedCats,
    marketingGroups: MKT.groupsOf(approvedCats),
    marketingStatus: 'active',
    marketingListed: true,
    marketingApplicationId: app.applicationId || null,
    marketingApprovedAt: _ts(),
    marketingUpdatedAt: _ts(),
    updatedAt: _ts(),
  }, { merge: true });
  return { collection: 'providers', id: uid, action: base ? 'marketing_created' : 'marketing_activated', categories: approvedCats };
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

/* LEGAL: ONE authority — functions/legal-verification.js (SOKONI admin decision + LSK practising evidence →
   eligibility()); it owns legalProviders and the public lawyers card. Ruling b2 2026-10-04: no second legal writer here. */


/* Roles the platform already owns elsewhere. Projecting them from here would
   duplicate an existing pipeline (sellers has its own onboarding + ade trigger;
   healthProviders has its own registry), so the role is recorded, the account is
   granted its role, and the projection is reported as delegated instead of being
   silently skipped.

   `legal` GRADUATED out of this map in Roles Phase 2: "delegated" meant nobody
   wrote the document, so approving an advocate produced no profile and no search
   presence. It now runs projectLegal above. */
/* ADR-014 SHIPS (owner, direct, 2026-10-04): a health approval projects into providers/{uid} (projectProvider stamps
   providers.healthcare) — the ONE healthcare activation path; healthcare-hub approveHealthProvider stays retired. */
const DELEGATED_ROLES = { event_organizer: 'events' };

/* ── SELLER PROVISIONING (Food Hub Gate 1, 2026-10-03) ──────────────────────────────────────────────────────────
   `seller` GRADUATED out of DELEGATED_ROLES. "Delegated to its own onboarding" meant nobody wrote anything: the only
   seller trigger (ade.adeOnSellerApplied) reacts to a `sellers` doc going `pending` and never approves, so an
   approved seller — every approved food business among them — had no shop, no seller record and no category, and
   the workspace authority had nothing to route. This is the C4 projectSeller design (convergence line, owner-reviewed
   2026-09-28 stages 1–2), ported onto the live lifecycle with three deliberate differences:

   1. APPROVED ≠ DISCOVERABLE (owner, 2026-09-28). Approval provisions the business; it does not publish it. A record
      this approval CREATES is written `_noIndex: true` (the search sync's existing skip guard) with
      `discovery: 'HELD'`; existing records keep exactly the visibility they had. Publication belongs to the one shop
      discovery gate (business-category.shopEligibility), not to a side effect of approval.
   2. APPROVAL EVIDENCE. sellers/{uid} carries `approvedAt` + `approvedBy` (noAdminFields() withholds both from every
      client), which is what business-scope recognises as a LIVE seller. Without it the record reads as
      `status_live_no_approval_evidence` — a CONFLICT, no workspace.
   3. ONE POS BUSINESS. businesses/{uid} carries the category stamp (the served rules let no client write `business`
      there: create is false and the owner's update allow-list excludes it) but NOT `ownerId` — the POS bootstrap
      (_ensureBusinessForOwner) finds its business by `ownerId == uid`, and a second owned business would make it
      report `already-provisioned` against a record with no branch and no till.

   Runs BEFORE the role is granted: if provisioning fails, applyDecision records projectionStatus 'failed' and no
   seller role or claim is handed out. Idempotent: deterministic ids + merge; createdAt only on first write. */
const PLACEHOLDER_SHOP_IDS = ['main', 'default', 'branch', 'null', 'undefined', ''];
const isPlaceholderShopId = (id) => PLACEHOLDER_SHOP_IDS.indexOf(String(id == null ? '' : id).trim().toLowerCase()) !== -1;
const _SUSPENSION_HIDES = ['searchable', 'isPublic'];

async function projectSeller(db, app, uid, approved, opts = {}) {
  const BCAT = require('./business-category');
  /* The application's shopId is APPLICANT-WRITABLE. It may name only a shop that is absent or already this account's;
     a shop id that does not look like a document id is refused rather than sanitised into a different one. */
  const rawShop = app.shopId == null ? '' : String(app.shopId).trim();
  if (rawShop && !isPlaceholderShopId(rawShop) && !/^[A-Za-z0-9_-]{1,128}$/.test(rawShop)) {
    const err = new Error('Application names an invalid shop id.');
    err.code = 'SHOP_ID_INVALID';
    throw err;
  }
  const declared = rawShop && !isPlaceholderShopId(rawShop) ? rawShop : null;
  const shopId = declared || String(uid);
  const shopRef = db.collection('shops').doc(shopId);
  const sellerRef = db.collection('sellers').doc(String(uid));
  const bizRef = db.collection('businesses').doc(String(uid));
  const userRef = db.collection('users').doc(String(uid));

  /* All reads before any write. */
  const [shopSnap, sellerSnap, bizSnap, userSnap] = await Promise.all([shopRef.get(), sellerRef.get(), bizRef.get(), userRef.get()]);
  const shop0 = shopSnap.exists ? (shopSnap.data() || {}) : null;
  const seller0 = sellerSnap.exists ? (sellerSnap.data() || {}) : null;
  const biz0 = bizSnap.exists ? (bizSnap.data() || {}) : null;

  /* OWNERSHIP IS NEVER TRANSFERRED BY AN APPLICATION. */
  if (shop0) {
    const owner = shop0.sellerUid || shop0.ownerId || shop0.ownerUid || null;
    if (owner && String(owner) !== String(uid)) {
      const err = new Error(`Application names shop ${shopId}, which belongs to another account.`);
      err.code = 'SHOP_OWNED_BY_ANOTHER_ACCOUNT';
      throw err;
    }
  }

  if (!approved) {
    /* Rejection of a never-provisioned seller: nothing to retract. Suspension: deactivate, never delete; remember
       what visibility the suspension removed so a reinstatement restores exactly that and nothing more. */
    const touched = [];
    const hide = (coll, ref, d, extra) => {
      if (!d) return;
      const prior = {};
      _SUSPENSION_HIDES.forEach((k) => { if (k in d) prior[k] = d[k]; });
      const keep = d.suspendedBy === 'application_lifecycle' && d.preSuspension ? d.preSuspension : prior;
      /* a shop under the discovery hold is RE-HELD (the release evaluator, not preSuspension, decides its visibility) */
      const rehold = (d.discovery === 'HELD' || d.discovery === 'ELIGIBLE') ? { discovery: 'HELD', _noIndex: true, discoveryHeldReasons: ['SUSPENDED'] } : {};
      batch.set(ref, Object.assign({ status: 'suspended', searchable: false, isPublic: false, suspendedAt: _ts(),
        suspendedBy: 'application_lifecycle', preSuspension: keep, updatedAt: _ts() }, rehold, extra || {}), { merge: true });
      touched.push(coll);
    };
    const batch = db.batch();
    hide('shops', shopRef, shop0);
    hide('sellers', sellerRef, seller0, { active: false });
    hide('businesses', bizRef, biz0);
    if (!touched.length) return { collection: 'shops+sellers+businesses', id: shopId, action: 'none' };
    await batch.commit();
    return { collection: 'shops+sellers+businesses', id: shopId, action: 'suspended', touched };
  }

  /* ── C1 CATEGORY, stamped by the SERVER at approval ──────────────────────────────────────────────────────────
     From the application through business-category (exact business ids only; a seller with no match is
     retail_store). An AdminOS classification already on the shop or the business is never overwritten, and a valid
     prior category is never replaced by a failed derivation. */
  const priorB = [shop0 && shop0.business, biz0 && biz0.business].find((b) => b && BCAT.isCategory(b.category)) || null;
  const adminSet = !!(priorB && priorB.source === 'admin');
  const serverCat = BCAT.isCategory(app.__serverCategory) ? app.__serverCategory : null;   /* r2: providerRequestShop passes its C1 category */
  let category = adminSet ? priorB.category : (serverCat || BCAT.categoryFromApplication(app, 'seller').category);
  if (!adminSet && !BCAT.isCategory(category) && priorB) category = priorB.category;
  const business = {
    category: BCAT.isCategory(category) ? category : null,
    source: adminSet ? 'admin' : 'application',
    applicationId: app.applicationId || null,
    setAt: _ts(),
  };
  if (adminSet && priorB.classifiedBy) business.classifiedBy = priorB.classifiedBy;

  const name = _sanText(app.name || app.businessName || app.storeName, 160) || 'My Shop';
  const decidedBy = opts.decidedBy ? String(opts.decidedBy) : null;
  /* Reinstatement: restore exactly what a lifecycle suspension hid, and nothing it did not. */
  const restore = (d) => {
    if (!d || d.suspendedBy !== 'application_lifecycle') return {};
    const out = { suspendedBy: FieldValue.delete(), preSuspension: FieldValue.delete(), suspendedAt: FieldValue.delete() };
    const prev = d.preSuspension || {};
    if (d.discovery === 'HELD' || d.discovery === 'ELIGIBLE') return out;   /* visibility = the release evaluator's call */
    _SUSPENSION_HIDES.forEach((k) => { out[k] = k in prev ? prev[k] : FieldValue.delete(); });
    return out;
  };
  const held = (d) => (d ? {} : { _noIndex: true, discovery: 'HELD', createdAt: _ts() });

  const batch = db.batch();
  batch.set(shopRef, Object.assign({
    shopId, ownerId: String(uid), sellerUid: String(uid),
    status: 'active', activatedAt: _ts(), updatedAt: _ts(),
    source: 'application_approval', applicationId: app.applicationId || null,
    approvedAt: _ts(), ...(decidedBy ? { approvedBy: decidedBy } : {}),
    business,
  }, shop0 ? {} : { name, nameLower: name.toLowerCase(),   /* r2 display fields — on CREATION only, never over an existing shop */
      ...(app.category ? { category: _sanText(app.category, 80) } : {}), ...(app.phoneNumber ? { phoneNumber: app.phoneNumber } : {}),
      ...(app.location ? { location: _sanText(app.location, 160) } : {}) }, held(shop0), restore(shop0)), { merge: true });

  batch.set(sellerRef, Object.assign({
    uid: String(uid),
    status: 'active', active: true,
    approvedAt: _ts(), ...(decidedBy ? { approvedBy: decidedBy } : {}),
    business,
    updatedAt: _ts(),
  }, seller0 && seller0.shopId ? {} : { shopId },
     seller0 && seller0.name ? {} : { name, nameLower: name.toLowerCase() },
     held(seller0), restore(seller0)), { merge: true });

  batch.set(bizRef, Object.assign({
    uid: String(uid), shopId,
    status: 'active',
    approvedAt: _ts(), ...(decidedBy ? { approvedBy: decidedBy } : {}),
    business,
    updatedAt: _ts(),
  }, biz0 ? {} : { name, businessName: name, nameLower: name.toLowerCase(), source: 'application_approval',
      ...(app.description ? { description: _sanText(app.description, 1000) } : {}), ...(app.phoneNumber || app.phone ? { phone: app.phoneNumber || app.phone } : {}),
      ...(app.email ? { email: app.email } : {}), ...(app.location || app.city ? { city: _sanText(app.location || app.city, 160) } : {}) },
     held(biz0), restore(biz0)), { merge: true });

  /* The account's active shop — set only when it has none; an existing choice is the merchant's. */
  if (!(userSnap.exists && (userSnap.data() || {}).activeShopId)) {
    batch.set(userRef, { activeShopId: shopId, updatedAt: _ts() }, { merge: true });
  }
  await batch.commit();

  /* SHOP DISCOVERY (owner 2026-10-04 — the gate decides): the projection never publishes; the ONE gate's server
     evaluator releases the hold now if every check passes (decision record, active, C1 category, owner + business). */
  const disc = await require('./shop-discovery-release').evaluateShopDiscovery(db, shopId, {
    FieldValue, getUser: (u) => getAuth().getUser(u),
  });

  return {
    collection: 'shops+sellers+businesses', id: shopId,
    action: shop0 ? 'reactivated' : 'created',
    shopId, sellerUid: String(uid), category: business.category, categorySource: business.source,
    discovery: disc.action === 'released' ? 'ELIGIBLE' : (shop0 && !shop0.discovery ? 'unchanged' : 'HELD'),
    discoveryEvaluation: { action: disc.action, reasons: disc.reasons },
    shopIdSource: declared ? 'application.shopId' : 'account_shop',
  };
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
/* grantAccountRole lives in ./role-authority (the ONE writer of users.roles + the Auth claim); the Phase-2 role map moved there. */


/* ══ THE ONE APPLICANT-TYPE AUTHORITY (owner 2026-10-03: "one server-owned application capability — Application →
   applicant type/category → requirements → verification → approval → capabilities"; Education and Marketing are TYPES
   of it, never two competing copies). Each entry answers, from SERVER-read application fields only:
     match(app)            → the applicant type, or null (not this hub)
     role(m)               → the role this type provisions, or null = keep the resolved role
     missing(app, m)       → the declared requirements still absent (approval is refused until empty)
     decide(app, data)     → extra fields applicationDecide records with an APPROVE (e.g. the categories approved), or throws
     project               → the type's own projection, or null = the normal role dispatch
     grantsRole(m, ok)     → whether the account role / claim is granted or revoked by this decision
     after(db, receipt, m) → what the type stamps once projected
     stamp(m)              → fields recorded on the application
     incompleteCode        → the refusal code applicationDecide returns
   applyDecision and applicationDecide consult ONLY this list; a new hub adds an entry, not a branch. */
const APPLICANT_TYPES = Object.freeze([
  Object.freeze({
    key: 'education',
    match: (app) => { const t = educationTypeOf(app); return t ? { type: t } : null; },
    role: (m) => (m.type === 'enterprise' ? 'education_enterprise' : 'provider'),
    missing: (app, m) => educationMissing(app, m.type),
    decide: () => ({}),
    project: (m) => (m.type === 'enterprise' ? (db, app, uid, approved) => projectEducationEnterprise(db, app, uid, approved) : null),
    grantsRole: (m) => m.type !== 'enterprise',
    after: async (db, receipt, m) => {
      if (m.type === 'enterprise') return;
      for (const w of receipt.writes) {
        if (w && w.collection === 'providers' && w.id) {
          await db.collection('providers').doc(String(w.id)).set({ education: { type: m.type, setAt: _ts() } }, { merge: true });
        }
      }
    },
    stamp: (m) => ({ educationType: m.type }),
    incompleteCode: 'EDUCATION_APPLICATION_INCOMPLETE',
  }),
  Object.freeze({
    key: 'marketing',
    match: (app) => (app && app.hub === 'marketing' && app.applicationType === 'marketing' ? { type: app.marketingType || 'individual' } : null),
    role: () => null,
    missing: () => [],
    /* Marketing Hub MK2 — approval activates ONLY the categories the reviewer approved (a subset of the request). */
    decide: (app, data) => {
      const requested = MKT.normalizeCategories(app.requestedCategories, 30);
      const asked = (data || {}).approvedCategories;
      const chosen = MKT.normalizeCategories(asked === undefined ? app.marketingApprovedCategories : asked, 30);
      const outside = chosen.filter((c) => requested.indexOf(c) < 0);
      if (outside.length) throw new HttpsError('invalid-argument', 'approvedCategories must be a subset of the requested categories.', { code: 'MKT_CATEGORY_NOT_REQUESTED', outside });
      if (!chosen.length) throw new HttpsError('invalid-argument', 'Choose at least one category to approve.', { code: 'MKT_NO_CATEGORY' });
      return { marketingApprovedCategories: chosen, marketingDeclinedCategories: requested.filter((c) => chosen.indexOf(c) < 0) };
    },
    project: () => (db, app, uid, approved, status) => projectMarketing(db, app, uid, approved, status),
    /* A REJECTED/SUSPENDED marketing application never strips the provider claim — the same account may be an
       approved provider for other services; only the marketing block was retracted. */
    grantsRole: (m, approved) => approved,
    after: async () => {},
    stamp: () => ({}),
    incompleteCode: 'MARKETING_APPLICATION_INCOMPLETE',
  }),
]);
function applicantTypeOf(app) {
  for (const T of APPLICANT_TYPES) { const m = T.match(app || {}); if (m) return { T, m }; }
  return null;
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
  /* A category-decided seller (Gate 1) also outranks a stored `app.role`: applications already in the queue were
     stamped `provider` at intake, before this rule existed, and must be decided by it. */
  /* THE applicant-type authority: a typed application's role comes from its TYPE (e.g. Education teacher / institution
     → provider, enterprise → a buyer record with no account role); a declared requestedRole cannot move it elsewhere. */
  const AT = applicantTypeOf(app);
  const eduType = AT && AT.T.key === 'education' ? AT.m.type : null;
  const typedRole = AT ? AT.T.role(AT.m) : null;
  const role = typedRole
    || (_resolved.by === 'explicit' || _resolved.by === 'explicit-alias' || /\+category(:|$)/.test(_resolved.by)
      ? _resolved.role
      : (app.role || _resolved.role));
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

  if (AT && approved) {
    const missing = AT.T.missing(app, AT.m);
    if (missing.length) {
      await db.collection('applications').doc(appId).set({
        ...AT.T.stamp(AT.m),
        applicantType: AT.T.key + ':' + AT.m.type,
        projectionStatus: 'blocked_incomplete',
        projectionError: 'Approval needs: ' + missing.join('; ') + '. Nothing was provisioned — request the information instead.',
        missing,
        decisionAppliedFor: status,
        decisionAppliedAt: _ts(),
      }, { merge: true });
      logger.warn('[appLifecycle] approval incomplete — nothing provisioned', { appId, applicantType: AT.T.key, type: AT.m.type, missing });
      return { ok: false, reason: 'incomplete', appId, applicantType: AT.T.key, ...(eduType ? { educationType: eduType } : {}), missing };
    }
  }

  const receipt = { appId, uid, role, status, writes: [] };

  try {
    const typedProject = AT ? AT.T.project(AT.m) : null;
    if (typedProject) {
      receipt.writes.push(await typedProject(db, app, uid, approved, status));
    } else if (role === 'driver' || role === 'rider') {
      /* Both spellings reach the same projection: `rider` is the Phase 1
         declaration, `driver` the legacy application's word. */
      receipt.writes.push(await projectDriver(db, app, uid, approved));
    } else if (role === 'legal') {
      /* legalProviders (authority) + lawyers (search projection), one commit.
         Returns TWO receipt entries, so push them individually. */
      /* SOKONI administrative verification only — LSK verification is the second, independent gate (legal-verification). */
      receipt.writes.push(await require('./legal-verification').applyAdminDecision(db, {
        uid, app, appId, status, decidedBy: opts.decidedBy || app.decidedBy || null,
      }));
    } else if (ROLE_PROFILES[role]) {
      /* mechanic / landlord / tenant — a uid-keyed profile this approval owns.
         Before Phase 2 these fell through to projectProvider and were filed in
         the service directory, which is exactly how a landlord ended up listed
         as a cleaning company. */
      receipt.writes.push(await projectRoleProfile(db, app, uid, role, approved));
    } else if (role === 'seller') {
      /* Before the role is granted — see projectSeller. A merchant is never authorised to sell before they have
         somewhere to sell from. */
      receipt.writes.push(await projectSeller(db, app, uid, approved, { decidedBy: opts.decidedBy }));
    } else if (DELEGATED_ROLES[role]) {
      receipt.writes.push({ collection: DELEGATED_ROLES[role], id: uid, action: 'delegated' });
    } else {
      receipt.writes.push(await projectProvider(db, app, uid, approved, { appId }));
    }

    /* the type stamps what it owns once projected (e.g. a teacher / institution provider record carries its type) */
    if (AT) await AT.T.after(db, receipt, AT.m);

    /* A pending application must not grant anything; only a decision does. An enterprise BUYER gets no account role. */
    /* A REJECTED/SUSPENDED marketing application never strips the provider claim — the same account may be an
       approved provider for other services; only the marketing block was retracted above. */
    const typeGrantsRole = AT ? AT.T.grantsRole(AT.m, approved) : true;
    let claimPending = false;
    if (typeGrantsRole && (status === 'approved' || status === 'rejected' || status === 'suspended')) {
      const grant = await grantAccountRole(db, uid, role, approved, {
        source: 'applicationLifecycle', entityId: appId, selectActive: true,   /* approval selects the workspace (Phase 2) */
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

    await db.collection('applications').doc(appId).set({
      statusCanonical: status,
      decisionAppliedFor: status,
      decisionAppliedAt: _ts(),
      projectionStatus: claimPending ? 'applied_claim_pending' : 'applied',
      projectionError: claimPending
        ? `Role "${receipt.roleKey}" granted in Firestore but the Auth claim did not mint — see roleClaimReconcile/${receipt.claimReconcileId}.`
        : FieldValue.delete(),
      projectionReceipt: receipt.writes,
      /* The role this decision APPLIED, stamped on the application: the workspace authority judges the approval by
         `app.role` (approval-remediation.decisionValidity), so an application filed `provider` at intake and decided
         as a seller (Gate 1) must say so, or its own approval reads as approving another role. */
      ...(role && app.role !== role ? { role, roleResolvedBy: eduType ? 'education:' + eduType : _resolved.by } : {}),
      ...(AT ? Object.assign({ applicantType: AT.T.key + ':' + AT.m.type, missing: FieldValue.delete() }, AT.T.stamp(AT.m)) : {}),
      ...(opts.decidedBy ? { decidedBy: opts.decidedBy } : {}),
    }, { merge: true });

    /* Stage (c) union: r2's entitlements above (seller_free trial, Till, business wallet — keyed by SHOP) AND the
       live POS bootstrap below (ed1c16b, 2026-08-24 — the till reads `businesses where ownerId == uid`). They write
       different documents; projectSeller deliberately leaves businesses/{uid} without ownerId so the two never collide. */
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
        await db.collection('applications').doc(appId).set({
          posProvisioning: { ok: true, created: prov.created === true,
                             reason: prov.reason || null,
                             merchantId: prov.merchantId || null, at: _ts() },
        }, { merge: true });
        logger.info('[appLifecycle] pos provisioning', { appId, uid, ...prov });
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
        const _dash = 'workspace.html';   /* r2 C2c: ONE resolver for where an approved account belongs */
        const approvedBody = role === 'education_enterprise'
          ? `${app.name || 'Your organisation'} is verified on SOKONI Education. You can now arrange training for your staff.`
          : eduType
            ? `${app.name || 'Your application'} is approved on SOKONI Education. Your workspace is ready — set it up before learners can find you.`
            : role === 'driver'
              ? 'Your rider application is approved. Open the SOKONI driver app and go online to start receiving deliveries.'
              : role === 'event_organizer'
                ? 'You are approved as an event organizer. Open Event Manager to create your first event and start selling tickets.'
                : role === 'legal'
                  ? 'SOKONI has approved your advocate application. You will appear to clients once your Law Society of Kenya practising status has been verified.'
                  : (role === 'seller' || role === 'merchant')
                    ? `${app.name || 'Your business'} is approved on SOKONI. Your business workspace is ready — set it up before customers can find you.`
                    : `${app.name || 'Your business'} is now live on SOKONI and customers can find you in search.`;
        await notify({
          uid,
          type: role === 'driver' ? 'rider_approved' : role === 'event_organizer' ? 'organizer_approved' : 'merchant_approved',
          title: claimPending ? 'Approved — finishing setup' : 'You are approved on SOKONI',
          body: claimPending
            ? 'Your application is approved. We are finishing the last step of your account setup — you will be able to sign in to your new dashboard shortly.'
            : approvedBody,
          /* no caller phone: the notification engine resolves the recipient itself (owner, Notifications E2E) */
          dedupeKey: claimPending ? `app_approved_pending:${appId}` : `app_approved:${appId}`,
          data: { applicationId: appId, role, claimPending, dashboard: _dash, link: _dash },
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
/* K13-B — naming an administrator is NOT a decision. Production evidence (2026-09-28): this check trusted
   `decidedBy` alone, and `decidedBy` + `status` are applicant-writable on the served rules — so an applicant who
   wrote any admin's uid into their own application was projected (K13). A decision is authoritative only when:
     1. the decider is not the applicant (separation of duties);
     2. the decider holds an admin / superAdmin claim;
     3. the server decision record applicationDecisions/{appId} — written by applicationDecide BEFORE it touches the
        application, and client-unwritable (no rule matches it) — records exactly this status AND this decider.
   Already-applied decisions never reach this (the decisionAppliedFor guard returns first), so legacy projections are
   not re-evaluated. */
async function decisionAuthority(after, appId) {
  const by = typeof after.decidedBy === 'string' ? after.decidedBy.trim() : '';
  if (!by) {
    return { ok: false, reason: 'no decidedBy — a decision is only made through applicationDecide' };
  }
  if (after.uid && by === after.uid) {
    return { ok: false, reason: 'decidedBy is the applicant — an administrator cannot decide their own application' };
  }
  try {
    const user = await getAuth().getUser(by);
    const claims = user.customClaims || {};
    if (!(claims.admin === true || claims.superAdmin === true)) return { ok: false, reason: `decidedBy "${by}" holds no admin claim` };
  } catch (e) {
    return { ok: false, reason: `decidedBy "${by}" is not a resolvable account (${e.message})` };
  }
  try {
    const rec = await _db().collection('applicationDecisions').doc(String(appId)).get();
    if (!rec.exists) return { ok: false, reason: 'no server decision record — only applicationDecide records a decision' };
    const r = rec.data() || {};
    if (r.status !== canonStatus(after.status) || r.decidedBy !== by) {
      return { ok: false, reason: 'the application does not match its server decision record' };
    }
    return { ok: true, by };
  } catch (e) {
    return { ok: false, reason: `the server decision record could not be read (${e.message})` };
  }
}

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

    const authority = await decisionAuthority(after, appId);
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


/* ══ ADMIT AN EXISTING PROVIDER (owner 2026-10-03, direct: "Build admin approve op") ═════════════════════════════════
   Some live providers / sellers were made active DIRECTLY (onboarding scripts) — no application, no decision record — so
   the ONE approval authority (shared/approval-authority.isAuthoritativelyApproved) rightly treats them as unapproved.
   This is the audited, one-time way an ADMINISTRATOR approves such an existing record:
     • admin / superAdmin with a satisfied second factor (same rule as index.js assertMFA); never the record's owner;
     • the record must already exist and be live (providers or sellers status active/approved) with NO application;
     • ONE transaction: create applications/ADM_<uid> (source 'admin_existing_provider', status approved) + its
       applicationDecisions record (the same fields applicationDecide writes) + an immutable adminAudit row;
     • idempotent: a second call finds the record and changes nothing; an existing application/decision is never touched;
     • provider only: providerProfiles/{uid} is provisioned from the server's providers record when ABSENT (so
       provider-dashboard loads), never overwritten when present;
     • status, discoverability and the commercial lane are NOT changed. The category is RECORDED on the application;
       stamping business.category stays with AdminOS bizAdminClassify (the one category writer). */
const ADMIT_ROLES = Object.freeze({ provider: 'providers', seller: 'sellers' });
function _mfaSatisfied(token) {
  if (process.env.MFA_REQUIRED === 'false') return true;   /* dev only, same switch as index.js */
  return !!(token && token.firebase && (token.firebase.sign_in_second_factor || (token.firebase.sign_in_attributes && token.firebase.sign_in_attributes.second_factor)));
}

exports.applicationAdmitExistingProvider = onCall(
  { region: REGION, maxInstances: 5, enforceAppCheck: true },
  async (req) => {
    _requireAdmin(req);
    if (!_mfaSatisfied(req.auth.token)) throw new HttpsError('unauthenticated', 'Administrator two-factor sign-in is required for this action.', { reason: 'MFA_REQUIRED' });
    const d = req.data || {};
    const uid = typeof d.uid === 'string' ? d.uid.trim() : '';
    const role = typeof d.role === 'string' ? d.role : 'provider';
    const category = _sanText(d.category, 60).toLowerCase();
    const reason = _sanText(d.reason, 500);
    if (!/^[A-Za-z0-9_-]{6,128}$/.test(uid)) throw new HttpsError('invalid-argument', '"uid" is required.');
    if (!ADMIT_ROLES[role]) throw new HttpsError('invalid-argument', 'role must be provider | seller.');
    if (!category || !/^[a-z0-9_-]{2,60}$/.test(category)) throw new HttpsError('invalid-argument', 'A category is required.', { reason: 'CATEGORY_REQUIRED' });
    if (reason.length < 5) throw new HttpsError('invalid-argument', 'Give a reason for this approval.', { reason: 'REASON_REQUIRED' });
    if (uid === req.auth.uid) throw new HttpsError('permission-denied', 'An administrator cannot approve their own business.', { code: 'SELF_DECISION' });
    /* H1 — the category must be a SOKONI category, fit the role, and not belong to a specialised authority */
    const BCAT = require('./business-category');
    if (!BCAT.isCategory(category)) throw new HttpsError('invalid-argument', 'That is not a SOKONI business category.', { reason: 'CATEGORY_UNKNOWN' });
    const sellerCat = BCAT.SELLER_CATEGORIES.includes(category) || MERCHANT_CATEGORIES.includes(category);
    if ((role === 'seller') !== sellerCat) throw new HttpsError('invalid-argument', 'That category does not fit a ' + role + '.', { reason: 'CATEGORY_ROLE_MISMATCH' });
    if (BCAT.HEALTHCARE.includes(category) || category === 'lawyer') throw new HttpsError('failed-precondition', 'Healthcare and legal providers are approved through their own verification, not this action.', { reason: 'SPECIALISED_AUTHORITY' });

    const db = _db();
    const appId = 'ADM_' + uid;
    const appRef = db.collection('applications').doc(appId);
    const decRef = db.collection('applicationDecisions').doc(appId);
    const recRef = db.collection(ADMIT_ROLES[role]).doc(uid);
    const profRef = db.collection('providerProfiles').doc(uid);
    const out = await db.runTransaction(async (t) => {
      /* ALL READS FIRST */
      const [appSnap, decSnap, recSnap, profSnap, others] = await Promise.all([
        t.get(appRef), t.get(decRef), t.get(recRef), role === 'provider' ? t.get(profRef) : Promise.resolve(null),
        t.get(db.collection('applications').where('uid', '==', uid).limit(5)),
      ]);
      if (appSnap.exists || decSnap.exists) return { ok: true, applicationId: appId, replay: true };
      if (!recSnap.exists) throw new HttpsError('not-found', 'No ' + role + ' record exists for this account.', { reason: 'NO_RECORD' });
      const rec = recSnap.data() || {};
      if (!['active', 'approved'].includes(String(rec.status || ''))) {
        throw new HttpsError('failed-precondition', 'Only a live ' + role + ' can be admitted this way (status is ' + (rec.status || 'missing') + ').', { reason: 'NOT_LIVE' });
      }
      if (others.docs.some((x) => x.id !== appId)) {
        throw new HttpsError('failed-precondition', 'This account already has an application — decide it in Applications instead.', { reason: 'HAS_APPLICATION' });
      }
      /* H1 — never silently re-categorise an ADMIN decision */
      const eb = rec.business || null;
      if (eb && eb.source === 'admin' && BCAT.isCategory(eb.category) && eb.category !== category) {
        throw new HttpsError('failed-precondition', 'This business is already classified by an administrator as ' + eb.category + '. Reclassification is a separate, audited action.', { reason: 'CATEGORY_CONFLICT' });
      }
      const at = _ts();
      t.create(appRef, {
        applicationId: appId, uid, role, hub: role === 'provider' ? 'services' : 'marketplace', category,
        source: 'admin_existing_provider', status: 'approved', statusCanonical: 'approved',
        decidedBy: req.auth.uid, decidedAt: at, reviewReason: reason, createdAt: at, updatedAt: at,
        projectionStatus: 'not_required', note: 'Admitted by an administrator: the business was already live with no application.',
      });
      t.create(decRef, { applicationId: appId, status: 'approved', decision: 'approve', decidedBy: req.auth.uid, applicantUid: uid,
        reason, category, businessCategory: category, approvedCategories: [category], source: 'admin_existing_provider', decidedAt: at });
      /* H1 — the category is stamped in THIS transaction (the record is already live) */
      const stamp = { category, source: 'admin', setBy: req.auth.uid, setAt: at, applicationId: appId };
      /* … and the CAPABILITY is activated in it: business-scope reads protected approval evidence (approvedAt), which a live-by-
         status record without it lacks (CAPABILITY_CONFLICT). An existing approvedAt is history and is kept. */
      t.update(recRef, Object.assign({ business: stamp, sourceApplicationId: appId, updatedAt: at }, rec.approvedAt ? {} : { approvedAt: at }));
      let provisioned = false;
      if (role === 'provider' && profSnap && !profSnap.exists) {
        t.create(profRef, { uid, providerId: rec.providerId || null, status: 'active', name: _sanText(rec.name || rec.businessName || '', 120),
          category: _sanText(rec.category || category, 100), bio: _sanText(rec.bio || '', 2000), rating: Number(rec.rating) || 0,
          reviewCount: Number(rec.reviewCount) || 0, bookingCount: Number(rec.bookingCount) || 0,
          provisionedBy: 'admin_existing_provider', provisionedAt: at, updatedAt: at });
        provisioned = true;
      }
      t.create(db.collection('adminAudit').doc(), { action: 'application_admit_existing', applicationId: appId, targetUid: uid, role, category,
        performedBy: req.auth.uid, reason, before: { application: null, decision: null, business: eb ? { category: eb.category || null, source: eb.source || null } : null, providerProfile: role === 'provider' ? (profSnap && profSnap.exists ? 'present' : 'absent') : 'n/a' },
        after: { application: 'approved', decision: 'approved', business: { category, source: 'admin' }, providerProfile: provisioned ? 'provisioned' : (role === 'provider' ? 'unchanged' : 'n/a') }, createdAt: at });
      return { ok: true, applicationId: appId, replay: false, providerProfileProvisioned: provisioned, category };
    });
    return out;
  }
);

exports.applicationDecide = onCall(
  { region: REGION, maxInstances: 10, enforceAppCheck: true, secrets: [QR_SIGNING_SECRET] },
  async (req) => {
    _requireAdmin(req);
    const { applicationId, decision, reason } = req.data || {};
    if (!applicationId) throw new HttpsError('invalid-argument', '"applicationId" is required.');
    if (!['approve', 'reject', 'suspend', 'request_info', 'mark_under_review', 'mark_verified', 'revoke'].includes(decision)) {
      throw new HttpsError('invalid-argument', 'decision must be approve | reject | suspend | request_info | mark_under_review | mark_verified | revoke.');
    }

    const db = _db();
    const ref = db.collection('applications').doc(String(applicationId));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Application not found.');

    /* EDUCATION E1: approving an education application that lacks the documents its type requires is refused before
       anything is written — the reviewer uses "request info" instead. */
    const AT0 = applicantTypeOf(snap.data());
    if (decision === 'approve' && AT0) {
      const missing = AT0.T.missing(snap.data(), AT0.m);
      if (missing.length) {
        throw new HttpsError('failed-precondition', 'This application cannot be approved yet. Missing: ' + missing.join('; ') + '.',
          Object.assign({ reason: AT0.T.incompleteCode, applicantType: AT0.T.key, missing }, AT0.T.key === 'education' ? { educationType: AT0.m.type } : {}));
      }
    }

    /* ══ REVIEW STAGES (owner briefs 2026-10-03; generic for every applicant type) ══════════════════════════════════
       `status` stays canonical (pending / info_requested / approved / rejected / suspended) — a literal 'verified'
       status would canonicalise to APPROVED and project, so the review sub-states live in `reviewStage`:
         submitted → under_review → verified    (admin-only marks; NO projection, audited, like request_info)
         revoke = suspend + reviewStage 'revoked' — TERMINAL: nothing further can be decided on that application.
       "Active" is the applied projection (projectionStatus 'applied'), not a status. */
    /* K13-A — SEPARATION OF DUTIES. An administrator never decides their OWN application: the approval authority
       exists to be exercised over someone else's request. (Production evidence, 2026-09-28: an admin decided their
       own driver applications.) Checked BEFORE the review-stage marks too: "verified" is shown to the applicant and to
       AdminOS as a review fact, so staging one's own application is the same breach (b2, 2026-10-03). */
    const applicantUid = snap.data().uid || null;
    if (applicantUid && applicantUid === req.auth.uid) {
      throw new HttpsError('permission-denied', 'An administrator cannot decide their own application.', { code: 'SELF_DECISION' });
    }

    const cur = snap.data() || {};
    if (cur.reviewStage === 'revoked') {
      throw new HttpsError('failed-precondition', 'This application was revoked. A new application is required.', { reason: 'REVOKED_TERMINAL' });
    }
    if (decision === 'mark_under_review' || decision === 'mark_verified') {
      const open = ['pending', 'info_requested'].includes(String(cur.status || 'pending'));
      if (!open) throw new HttpsError('failed-precondition', 'Only an undecided application can change review stage.', { reason: 'ALREADY_DECIDED' });
      if (decision === 'mark_verified' && AT0) {
        const missing = AT0.T.missing(cur, AT0.m);
        if (missing.length) throw new HttpsError('failed-precondition', 'Cannot mark verified. Missing: ' + missing.join('; ') + '.', { reason: AT0.T.incompleteCode, missing });
      }
      const stage = decision === 'mark_verified' ? 'verified' : 'under_review';
      await ref.set({ reviewStage: stage, reviewStageAt: _ts(), reviewStageBy: req.auth.uid, updatedAt: _ts() }, { merge: true });
      await db.collection('adminAudit').add({ action: 'application_' + decision, applicationId: String(applicationId), targetUid: cur.uid || null,
        performedBy: req.auth.uid, reason: _sanText(reason, 500) || null, createdAt: _ts() }).catch(() => {});
      return { ok: true, applicationId, reviewStage: stage, projected: false };
    }
    if (decision === 'revoke' && _sanText(reason, 500).length < 5) {
      throw new HttpsError('invalid-argument', 'Give a reason for revoking.', { reason: 'REASON_REQUIRED' });
    }

    const STATUS = { approve: 'approved', reject: 'rejected', suspend: 'suspended', request_info: 'info_requested', revoke: 'suspended' };
    const STAGE = { approve: 'approved', reject: 'rejected', suspend: 'suspended', request_info: 'info_requested', revoke: 'revoked' };
    const status = STATUS[decision];
    const actor = req.auth.uid;


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
      const _AT = applicantTypeOf(_a);
      /* Typed applicants (Education, Marketing) are SERVICE PROVIDERS taking paid work through SOKONI — the same rule
         r2 applies to advocates: their commission acceptance is the canonical provider catalogue, never a Seller
         Agreement tick. An education ENTERPRISE buys training: it gets no provider role and owes no commission. */
      if (_AT && _AT.T.key === 'education' && _AT.m.type === 'enterprise') {
        /* education ENTERPRISE: a company buying training — no provider role, no commission → no seller/provider agreement */
      } else if (_AT || _role === 'health' || _role === 'event_organizer' || _role === 'legal') {
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
          comp = await require('./legal-agreements').complianceFor(uidForLegal, (_AT || _role === 'legal') ? 'provider' : _role);
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
            `This ${_AT ? _AT.T.key + ' service-provider' : _role === 'health' ? 'healthcare' : _role === 'legal' ? 'advocate' : 'event organizer'} application cannot be approved: the applicant has not accepted the ` +
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

    /* the type's own decision fields (e.g. Marketing: only the categories the reviewer approved) */
    const _mkt = decision === 'approve' && AT0 ? AT0.T.decide(snap.data() || {}, req.data || {}) : {};

    /* H1 — the business category is decided HERE, server-side, from the application by exact match; never from the
       request. An approval that would land an UNCATEGORIZED provider is refused (request the category instead). */
    let _bizCat = null;
    if (decision === 'approve') {
      const _role = _decidedRoleOf(cur);
      /* ADR-014 (owner 2026-10-04): health is categorised by its OWN authority — projectProvider stamps
         providers.healthcare from healthcare-category, and an unmapped clinic lands UNCLASSIFIED for AdminOS
         healthAdminClassify (the certified healthcare model). H1's refusal therefore applies to the business lane only. */
      if (_role !== 'health' && _projectsToProviders(cur, _role)) {
        const BCAT = require('./business-category');
        _bizCat = BCAT.categoryFromApplication(cur, _role).category;
        if (!BCAT.isCategory(_bizCat)) {
          throw new HttpsError('failed-precondition', 'This application cannot be approved yet: its business category does not match a SOKONI category. Request information so the applicant chooses one.', { reason: 'CATEGORY_UNRESOLVED' });
        }
      }
    }

    /* K13-A — THE SERVER DECISION RECORD, written BEFORE the application is touched. `applicationDecisions/{appId}`
       has no client rule (default deny), so it is the one record of a decision that a browser cannot author; the
       application's own `status` / `decidedBy` are applicant-writable on the served rules and are therefore never
       sufficient on their own (see _authoritativeDecision — record-only). One document per application = the CURRENT decision;
       the full history stays in adminAudit. */
    await db.collection(DECISIONS).doc(String(applicationId)).set({
      applicationId: String(applicationId), appId: String(applicationId), decidedAtMs: Date.now(),
      status: canonStatus(status),
      decision,
      decidedBy: actor,
      applicantUid,
      reason: _sanText(reason, 500) || null,
      decidedAt: _ts(),
      /* Marketing (b2, 2026-10-03): the APPROVED category subset lives on the server record too — the application's
         marketingApprovedCategories is applicant-writable. Record = the CURRENT decision: anything but approve → []. */
      ...(AT0 && AT0.T.key === 'marketing' ? { approvedCategories: decision === 'approve' ? (_mkt.marketingApprovedCategories || []) : [] } : {}),
      /* H1: the category this approval decided — the ONLY source projectProvider stamps from */
      ...(_bizCat ? { businessCategory: _bizCat, approvedCategories: [_bizCat] } : {}),
    });

    await ref.set({
      status,
      ..._mkt,   /* only the type's own decision fields (e.g. marketing categories) — never status */
      statusCanonical: canonStatus(status),
      reviewStage: STAGE[decision], reviewStageAt: _ts(),
      reviewReason: _sanText(reason, 500) || null,
      decidedBy: actor,
      decidedAt: _ts(),
      /* r2: SERVER-stamped proof the acknowledgement was verified at approval (agreementAcceptedAt is a client clock) */
      ...(decision === 'approve' ? { agreementVerifiedAt: _ts(), agreementVerifiedVersion: (snap.data() || {}).agreementVersion || null } : {}),
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

/* ── K13-A — what makes a stored status AUTHORITATIVE ─────────────────────────────────────
   The served rules let an applicant write their own application's `status` (and `decidedBy`). The reconcile path
   used to project whatever status it found, attributed to the admin who ran it — so an applicant who set
   status:'approved' was approved by the next "reconcile all" sweep (K13b). A stored status is authoritative only when
   an ADMINISTRATOR who is NOT the applicant decided exactly that status, evidenced by:
     the server decision record applicationDecisions/{appId} (written by applicationDecide, client-unwritable).
   RECORD-ONLY (owner: ONE approval authority, NO legacy fallback; ruling b2 2026-10-04). The adminAudit fallback that
   used to accept a pre-record decision is GONE — P0-H migrated the 5 legacy approvals into decision records (2026-10-03),
   exactly as P0-C removed the same fallback from the workspace. Nothing else — not the application's own fields, not an
   audit row, not an operator label — makes a decision reconcilable. */
async function _isAdminUid(uid, cache) {
  if (!uid || typeof uid !== 'string') return false;
  if (cache && Object.prototype.hasOwnProperty.call(cache, uid)) return cache[uid];
  let ok = false;
  try { const c = (await getAuth().getUser(uid)).customClaims || {}; ok = c.admin === true || c.superAdmin === true; }
  catch (_) { ok = false; }                                /* an operator label is not an account */
  if (cache) cache[uid] = ok;
  return ok;
}
async function _authoritativeDecision(db, appId, app, cache) {
  const status = canonStatus(app.status);
  const applicant = app.uid || null;
  const acceptable = async (by) => !!by && by !== applicant && await _isAdminUid(by, cache);

  const rec = await db.collection('applicationDecisions').doc(String(appId)).get();
  if (rec.exists) {
    const r = rec.data() || {};
    /* A record exists: it IS the current decision. A stored status that disagrees with it is not authoritative. */
    return (r.status === status && await acceptable(r.decidedBy)) ? { ok: true, by: r.decidedBy, evidence: 'decision_record' } : { ok: false };
  }
  return { ok: false, reason: 'NO_DECISION_RECORD' };   /* no record → not a decision (record-only) */
}

/* Re-run the projection for an application whose registry record is missing or
   stale — the repair path for anything approved before this engine existed.
   K13-A: only an AUTHORITATIVE decision is re-projected (_authoritativeDecision), attributed to its real decider. */
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
      const auth1 = await _authoritativeDecision(db, snap.id, app, {});
      if (!auth1.ok) {
        logger.warn('[appReconcile] refused: no authoritative decision', { appId: snap.id, status: app.status });
        return { ok: true, results: [{ ok: false, appId: snap.id, refused: 'NO_AUTHORITATIVE_DECISION' }] };
      }
      return { ok: true, results: [await applyDecision(snap.id, app, { decidedBy: auth1.by })] };
    }

    if (!all) throw new HttpsError('invalid-argument', 'Pass "applicationId" or all:true.');

    /* Bounded sweep of decided applications. */
    const snap = await db.collection('applications').where('status', 'in', ['approved', 'active', 'verified']).limit(300).get();
    const results = [];
    const adminCache = {};
    for (const d of snap.docs) {
      const app = d.data();
      try {
        const norm = await buildIntakePatch(app, d.id);
        if (norm) { await d.ref.set(norm.patch, { merge: true }); Object.assign(app, norm.patch); }
        const authz = await _authoritativeDecision(db, d.id, app, adminCache);
        if (!authz.ok) {
          logger.warn('[appReconcile] refused: no authoritative decision', { appId: d.id, status: app.status });
          results.push({ ok: false, appId: d.id, refused: 'NO_AUTHORITATIVE_DECISION' });
          continue;
        }
        results.push(await applyDecision(d.id, app, { decidedBy: authz.by }));
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
        /* Marketing Hub MK2 — the reviewer sees the declared type and exactly which categories were asked for / approved. */
        hub: a.hub || null,
        applicationType: a.applicationType || null,
        marketingType: a.marketingType || null,
        requestedCategories: Array.isArray(a.requestedCategories) ? a.requestedCategories : [],
        marketingApprovedCategories: Array.isArray(a.marketingApprovedCategories) ? a.marketingApprovedCategories : [],
        portfolio: Array.isArray(a.portfolio) ? a.portfolio : [],
        /* Projection health — the difference between "approved" and "live". */
        projectionStatus: a.projectionStatus || (st === 'pending' ? 'n/a' : 'not_applied'),
        projectionError: a.projectionError || null,
        decisionAppliedFor: a.decisionAppliedFor || null,
        contactGap: a.contactGap || null,
        locationGap: a.locationGap || null,
        receivedAt: a.receivedAt ? (a.receivedAt.toMillis ? a.receivedAt.toMillis() : a.receivedAt) : null,
        submittedAtRaw: a.submittedAt || null,
        createdAt: a.createdAt ? (a.createdAt.toMillis ? a.createdAt.toMillis() : a.createdAt) : null,
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
  buildIntakePatch, applyDecision, projectProvider, projectDriver, projectMarketing,
  projectRoleProfile, ROLE_PROFILES, DELEGATED_ROLES, projectSeller, MERCHANT_CATEGORIES,
  INTAKE_VERSION, KE_COUNTIES,
  EDUCATION_TYPES, EDUCATION_REQUIRED, educationTypeOf, educationMissing, projectEducationEnterprise, APPLICANT_TYPES, applicantTypeOf,
};
