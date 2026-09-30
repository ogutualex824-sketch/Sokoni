/* ============================================================================
   SOKONI Integration Registry (server side) — functions/integration-registry.js
   ============================================================================
   The identity and wiring of every system SOKONI integrates with, in the form the
   BACKEND needs: which integrations exist, and which credential names each one
   requires. It carries no secret values and no health opinion.

   WHY THIS FILE EXISTS RATHER THAN A require() OF THE CLIENT CATALOGUE
   --------------------------------------------------------------------
   `firebase deploy --only functions` uploads the functions/ directory and nothing
   else. A require('../sokoni-integration-catalogue.js') resolves perfectly on a
   developer's machine and then throws MODULE_NOT_FOUND in production — the same
   trap already documented in auth-policy.js and shop-offers.js. So the inventory
   exists twice, deliberately, and the duplication is held together by a contract
   rather than by hope:

     scripts/test-integration-registry-parity.js
        asserts, entry for entry, that this file and
        sokoni-integration-catalogue.js declare the SAME integrations with the
        SAME categories, the SAME lifecycle status and the SAME required secrets.

   A drift between the two would make the console describe one estate while the
   backend reports another, which is precisely the failure this repair exists to
   end. The parity suite fails on any divergence, in either direction, including
   an entry added to one side only.

   GENERATED, NOT TRANSCRIBED
   --------------------------
   The rows below were extracted mechanically from the catalogue. A hand-copied
   35-entry table is a transcription-error surface, and the first extractor draft
   silently dropped an entry whose name used double quotes — so the generator
   carries a positive control asserting it finds every id the catalogue declares.
   Regenerate rather than hand-edit, and let the parity suite confirm it.

   WHAT `requiredSecrets` MEANS
   ----------------------------
   The Secret Manager NAMES an integration needs in order to be usable. Presence
   of a name is a CONFIGURATION fact and nothing more. It does not mean the
   provider is reachable, that credentials are valid, or that anything was ever
   delivered. Judging health is a separate concern with a separate source, and
   inferring "healthy" from "a key exists" is the exact defect this platform has
   been bitten by before.

   An empty requiredSecrets is not a gap: Firestore, FCM, Cloud Storage and the
   rest authenticate as the service account and legitimately need no named
   secret. Those resolve to `not-applicable`, never to `missing`.

   WHAT IS DELIBERATELY ABSENT
   ---------------------------
   M-Pesa / Daraja. Its credentials still exist in Secret Manager, but it is not a
   SOKONI payment integration: IntaSend is the sole active payment provider and
   the merchant of record. Daraja must not appear here, must not be reported as a
   missing payment credential, and must not be health-checked. Historical Daraja
   code remains only where isolated compatibility requires it.
   ============================================================================ */
'use strict';

const VERSION = '1.0.0';

const CATEGORIES = [
  { id: 'payments',   label: 'Payments' },
  { id: 'messaging',  label: 'Messaging' },
  { id: 'search',     label: 'Search' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'identity',   label: 'Identity' },
  { id: 'ai',         label: 'AI' },
  { id: 'infra',      label: 'Infrastructure' },
  { id: 'outbound',   label: 'Outbound APIs' },
];

const INTEGRATIONS = [
  { id: "intasend-collections", category: "payments", vendor: "IntaSend",
    name: "IntaSend — Collections (M-Pesa STK)",
    status: "live", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: ["INTASEND_API_KEY","INTASEND_PRIVATE_KEY"], optionalEnv: [] },
  { id: "intasend-webhook", category: "payments", vendor: "IntaSend",
    name: "IntaSend — Payment Webhook",
    status: "live", direction: "inbound",
    healthKind: "measurable",
    requiredSecrets: ["INTASEND_WEBHOOK_CHALLENGE"], optionalEnv: [] },
  { id: "intasend-payouts", category: "payments", vendor: "IntaSend",
    name: "IntaSend — B2C Payouts",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: ["INTASEND_PRIVATE_KEY","SETTLEMENT_ACCOUNT_NUMBER"], optionalEnv: [] },
  { id: "pos-card-terminal", category: "payments", vendor: "Card acquirer (unsigned)",
    name: "POS Card Terminal Rail",
    status: "quarantined", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "sokoni-wallet", category: "payments", vendor: "SOKONI (first-party)",
    name: "SOKONI Wallet & Settlement Engine",
    status: "frozen", direction: "internal",
    healthKind: "not-applicable",
    requiredSecrets: ["PAYMENT_HMAC_SECRET","WALLET_QR_SECRET"], optionalEnv: [] },
  { id: "africastalking", category: "messaging", vendor: "Africa's Talking",
    name: "Africa's Talking — SMS",
    status: "live", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: ["AFRICASTALKING_API_KEY","AFRICASTALKING_USERNAME","SMS_WEBHOOK_TOKEN"], optionalEnv: ["AT_ENV","AT_SENDER_ID"] },
  { id: "sendgrid", category: "messaging", vendor: "Twilio SendGrid",
    name: "SendGrid — Transactional Email",
    status: "live", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: ["SENDGRID_API_KEY","SENDGRID_WEBHOOK_KEY"], optionalEnv: [] },
  /* C3: the DMARC-only inbound lane, catalogued apart from outbound so that "inbound
     mail" can never be read off the sendgrid row. No executor, no stage support —
     it resolves UNKNOWN, not refused. */
  { id: "sendgrid-inbound-parse", category: "messaging", vendor: "Twilio SendGrid",
    name: "SendGrid Inbound Parse — DMARC reports only",
    status: "inbound-only", direction: "inbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "smtp-fallback", category: "messaging", vendor: "SMTP host",
    name: "SMTP — Direct Mail Transport",
    status: "configured", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: ["MAIL_HOST","MAIL_USER","MAIL_PASS"], optionalEnv: [] },
  { id: "email-dmarc", category: "messaging", vendor: "DNS + mail providers",
    name: "Email Authentication (SPF / DKIM / DMARC)",
    status: "configured", direction: "outbound",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "hostpinnacle-mail", category: "messaging", vendor: "HostPinnacle",
    name: "HostPinnacle / MailBaby — Mailboxes",
    status: "live", direction: "bidirectional",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "fcm", category: "messaging", vendor: "Google Firebase",
    name: "Firebase Cloud Messaging — Push",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "algolia", category: "search", vendor: "Algolia",
    name: "Algolia — Search Index",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: ["ALGOLIA_ADMIN_KEY","ALGOLIA_SEARCH_KEY"], optionalEnv: ["ALGOLIA_APP_ID"] },
  { id: "typesense", category: "search", vendor: "Typesense",
    name: "Typesense — Search Nodes",
    status: "configured", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: ["TYPESENSE_ADMIN_KEY","TYPESENSE_SEARCH_KEY"], optionalEnv: ["TYPESENSE_NODES"] },
  { id: "etims", category: "compliance", vendor: "Kenya Revenue Authority",
    name: "KRA eTIMS — Tax Invoicing",
    status: "live", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: ["ETIMS_MASTER_KEY","ETIMS_PLATFORM_PIN","ETIMS_PLATFORM_SECRET"], optionalEnv: ["ETIMS_ENV"] },
  { id: "odpc", category: "compliance", vendor: "Office of the Data Protection Commissioner",
    name: "ODPC — Data Protection Compliance",
    status: "configured", direction: "internal",
    healthKind: "not-applicable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "firebase-auth", category: "identity", vendor: "Google Firebase",
    name: "Firebase Authentication",
    status: "live", direction: "bidirectional",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "google-signin", category: "identity", vendor: "Google",
    name: "Google Sign-In",
    status: "live", direction: "inbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "phone-auth", category: "identity", vendor: "Google Firebase",
    name: "Firebase Phone Auth — SMS OTP",
    status: "live", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "email-password-auth", category: "identity", vendor: "Google Firebase",
    name: "Email & Password Sign-In",
    status: "live", direction: "inbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "recaptcha", category: "identity", vendor: "Google",
    name: "Google reCAPTCHA",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "facebook-login", category: "identity", vendor: "Meta",
    name: "Facebook Login & Data Deletion",
    status: "live", direction: "bidirectional",
    healthKind: "measurable",
    requiredSecrets: ["FACEBOOK_APP_SECRET"], optionalEnv: [] },
  { id: "age-verification", category: "identity", vendor: "SOKONI (first-party)",
    name: "Age & Identity Verification",
    status: "configured", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: ["AGE_ID_SALT"], optionalEnv: [] },
  { id: "anthropic", category: "ai", vendor: "Anthropic",
    name: "Anthropic Claude",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: ["ANTHROPIC_API_KEY"], optionalEnv: [] },
  { id: "vertex-gemini", category: "ai", vendor: "Google Cloud",
    name: "Vertex AI — Gemini Pro Vision",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "firestore", category: "infra", vendor: "Google Firebase",
    name: "Cloud Firestore — (default)",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  /* The SECOND Firestore database. It is declared in firebase.json with its own
     rules and its own indexes, and it is NOT the default one. "configured"
     rather than "live" is deliberate: no runtime module opens a client bound to
     this database id, so production serving is not proven. Promote it only when
     a reader exists and has been observed. */
  { id: "firestore-sokoni-ops", category: "infra", vendor: "Google Firebase",
    name: "Cloud Firestore — sokoni-ops",
    status: "configured", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  /* Cloud Run is the serving layer Cloud Functions run ON. They are separate
     control planes — revisions, traffic and scaling limits are Cloud Run
     concepts — so they are catalogued separately. */
  { id: "cloud-run", category: "infra", vendor: "Google Cloud",
    name: "Google Cloud Run",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "cloud-functions", category: "infra", vendor: "Google Cloud",
    name: "Cloud Functions",
    status: "frozen", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "firestore-indexes", category: "infra", vendor: "Google Firebase",
    name: "Cloud Firestore — Index Management",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "secret-manager", category: "infra", vendor: "Google Cloud",
    name: "Google Secret Manager",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "cloud-monitoring", category: "infra", vendor: "Google Cloud",
    name: "Google Cloud Monitoring",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "osm-tiles", category: "infra", vendor: "OpenStreetMap Foundation",
    name: "OpenStreetMap — Map Tiles",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "osm-nominatim", category: "infra", vendor: "OpenStreetMap Foundation",
    name: "OpenStreetMap Nominatim — Geocoding",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  /* The vendor that actually answers for mysokoni.co.ke. It was uncatalogued
     while Cloudflare was wrongly credited with DNS. */
  { id: "hostpinnacle-dns", category: "infra", vendor: "HostPinnacle",
    name: "HostPinnacle — DNS & Domain",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "artifact-registry", category: "infra", vendor: "Google Cloud",
    name: "Google Artifact Registry",
    status: "frozen", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "memorystore-redis", category: "infra", vendor: "Google Cloud",
    name: "Memorystore Redis",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: ["REDIS_URL"], optionalEnv: [] },
  { id: "firebase-hosting", category: "infra", vendor: "Google Firebase",
    name: "Firebase Hosting",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "cloud-storage", category: "infra", vendor: "Google Firebase",
    name: "Cloud Storage",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "app-check", category: "infra", vendor: "Google Firebase",
    name: "Firebase App Check",
    status: "live", direction: "internal",
    healthKind: "not-applicable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "cloud-scheduler", category: "infra", vendor: "Google Cloud",
    name: "Cloud Scheduler",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  /* CORRECTED: Cloudflare provides a third-party ASSET CDN here, not DNS.
     HostPinnacle is the DNS provider. */
  { id: "cloudflare", category: "infra", vendor: "Cloudflare",
    name: "Cloudflare cdnjs — Third-party Asset CDN",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "pos-external-api", category: "outbound", vendor: "Third-party consumers",
    name: "SmartPOS External API",
    status: "live", direction: "inbound",
    healthKind: "not-applicable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "pos-webhooks", category: "outbound", vendor: "Merchant endpoints",
    name: "SmartPOS Outbound Webhooks",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: ["POS_WEBHOOK_SECRET"], optionalEnv: [] },
  { id: "erp-connectors", category: "outbound", vendor: "SAP, Sage, Odoo, Dynamics, QuickBooks, Xero, Zoho",
    name: "ERP & Accounting Connectors",
    status: "configured", direction: "inbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "inventory-webhooks", category: "outbound", vendor: "Merchant endpoints",
    name: "Inventory Webhooks",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "api-gateway", category: "outbound", vendor: "SOKONI (first-party)",
    name: "SOKONI API Gateway",
    status: "live", direction: "inbound",
    healthKind: "elsewhere",
    requiredSecrets: ["SOKONI_HMAC_KEY"], optionalEnv: [] },
  { id: "platform-registry", category: "outbound", vendor: "SOKONI (first-party)",
    name: "Platform Service Registry",
    status: "live", direction: "internal",
    healthKind: "not-applicable",
    requiredSecrets: [], optionalEnv: [] },

  /* ── Added by the Step 8 rebaseline, 2026-09-29. 47 -> 52. ───────────────
     Five services the platform demonstrably talks to and the inventory did not
     name. Each was added on CODE evidence, not on a vendor name: the census that
     produced them also rejected cPanel (the search matched the variable
     `discPanel`) and Twilio (SendGrid's vendor name, already catalogued here),
     and HELD Firebase Performance and Cloud Build on one weak file each.
     None is a payment rail; IntaSend remains the sole payment provider. */
  { id: "google-maps", category: "infra", vendor: "Google",
    name: "Google Maps Platform",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "ga4-analytics", category: "infra", vendor: "Google",
    name: "Google Analytics 4 / Tag Manager",
    /* WIRED is evidenced; CONFIGURED is not. The loader ships and the CSP
       allows the hosts, but no G-XXXXXXXX measurement id exists anywhere in
       this repository. Those are two different facts and the catalogue entry
       states both — collapsing them would report an analytics rail as working
       on the strength of a script tag. */
    status: "live", direction: "outbound",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "firebase-remote-config", category: "infra", vendor: "Google",
    name: "Firebase Remote Config",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "cloud-logging", category: "infra", vendor: "Google Cloud",
    name: "Google Cloud Logging",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
    requiredSecrets: [], optionalEnv: [] },
  { id: "eventarc", category: "infra", vendor: "Google Cloud",
    name: "Eventarc",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },

  /* ── Added 2026-09-29 by the CSP completeness pass ──────────────────────
     Found by diffing the Content-Security-Policy against the catalogue: the
     CSP enumerates every external host the browser may contact, and it is
     maintained because breaking it breaks the site — which makes it a better
     completeness source than a keyword census.

     Each of these is CALLED BY CODE, verified file by file; a CSP allowance
     alone was not treated as evidence. `*.ggpht.com` was allowed by the CSP and
     called by nothing, so it is a stale allowance and is deliberately NOT here.

     None takes a credential. They are catalogued for the same reason osm-tiles
     already is: a third-party the platform depends on at runtime belongs in the
     inventory whether or not it needs a key. */
  { id: "osrm-routing", category: "infra", vendor: "Project OSRM",
    name: "OSRM — Route Planning",
    /* The DELIVERY ROUTING PATH. router.project-osrm.org is the project's PUBLIC
       DEMO SERVER: no SLA, no support, and explicitly not intended for
       production traffic. That is a standing availability risk on a customer
       journey, and it belongs on the record rather than in a CSP line. */
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "qr-image-service", category: "infra", vendor: "QRServer (goqr.me)",
    name: "QR Code Image API",
    /* In the RECEIPT path — pos-receipt-engine and pos-retail-engine. A printed
       receipt that silently loses its QR is a customer-visible failure. */
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "google-charts-image", category: "infra", vendor: "Google",
    name: "Google Charts Image API (deprecated by vendor)",
    /* DEPRECATED BY GOOGLE and still served on a best-effort basis. It renders
       in POS and minishop admin surfaces. Catalogued so the dependency is
       visible before the turndown, not after. */
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "arcgis-basemaps", category: "infra", vendor: "Esri",
    name: "ArcGIS Online — Basemap Tiles",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "carto-basemaps", category: "infra", vendor: "CARTO",
    name: "CARTO — Basemap Tiles",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "opentopomap", category: "infra", vendor: "OpenTopoMap",
    name: "OpenTopoMap — Terrain Tiles",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "unsplash-images", category: "infra", vendor: "Unsplash",
    name: "Unsplash — Stock Imagery",
    status: "live", direction: "outbound",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },

  /* ── WhatsApp Cloud API, added 2026-09-30 ───────────────────────────────
     Held out of this catalogue until it was real, on the grounds that a row
     without a capability behind it is the sokoni-webhook-engine.js defect. It
     now clears the bar on every count: a code path
     (functions/whatsapp-webhook.js), a DEPLOYED function (webhookWhatsapp,
     ACTIVE, GEN_2), two bound secrets, and a production smoke test in which a
     correctly signed POST was accepted and persisted while an unsigned one,
     a wrong verify token and a tampered body were each refused.

     INBOUND ONLY, and catalogued as such. There is no send path yet, so this
     row must not be read as "SOKONI can message customers on WhatsApp". */
  { id: "whatsapp-cloud-api", category: "messaging", vendor: "Meta",
    name: "WhatsApp Cloud API — Inbound Webhook",
    status: "live", direction: "inbound",
    healthKind: "measurable",
    requiredSecrets: ["WHATSAPP_VERIFY_TOKEN", "WHATSAPP_APP_SECRET"],
    optionalEnv: [] },
];

/* ── OPERATIONAL DEPENDENCIES ───────────────────────────────────────────────
   A SEPARATE COLLECTION, and the separation is the point.

   An operational dependency is a provider SOKONI's BUSINESS relies on and which
   SOKONI's CODE does not talk to. There is no client, no credential in Secret
   Manager, no request, and therefore NO PROBE PATH — not a probe that refuses,
   and not a probe nobody has written. Nothing to measure, ever.

       CODE INTEGRATION            OPERATIONAL DEPENDENCY
       code talks to it            the business relies on it
       a probe path may exist      no code path exists at all
       the evidence model applies  NOT PROBEABLE BY DESIGN

   WHY THEY ARE NOT MEMBERS OF INTEGRATIONS
   -----------------------------------------
   Every field of the evidence model assumes a code path: requiredSecrets, the
   five-stage support table, probeAvailability, the health vocabulary. An
   operational dependency has none of them, so putting one in INTEGRATIONS would
   add a record that every downstream consumer must special-case — and the first
   one to forget would render it as `unknown`, which reads to an operator as
   "we have not checked" rather than "there is nothing here to check".

   They are deliberately ABSENT from _byId, so registry.byId() returns null for
   them. That is not an oversight: it is what makes the boundary enforceable
   rather than merely documented. integration-evidence.validate() refuses any
   record whose integrationId is not a known registry entry, so an evidence
   record for an operational dependency CANNOT be written even by mistake.

   Added on the owner's Step 8 authorization. cPanel is excluded pending
   independent verification — the census hit was a false positive. HostPinnacle
   is deliberately NOT given a third row here: hostpinnacle-dns and
   hostpinnacle-mail already exist as code integrations, and a third row before
   the console visibly separates the two lists would read as duplication rather
   than as a different kind of fact. */
const OPERATIONAL_DEPENDENCIES = [
  { id: "google-workspace", name: "Google Workspace", vendor: "Google",
    kind: "operational-dependency", probePath: "none",
    summary: "Company email and identity for the operating business. No SOKONI " +
             "code path: the census found zero references in any source file.",
    authority: "Google Workspace Admin console" },
  { id: "google-admin", name: "Google Admin", vendor: "Google",
    kind: "operational-dependency", probePath: "none",
    summary: "Administration of the Workspace tenant — users, domains, groups. " +
             "No SOKONI code path; the Admin SDK is not used anywhere.",
    authority: "Google Admin console" },
];

/* An id may not be in both collections. Asserted here rather than left to the
   suite, because a duplicate would make the same provider both probeable and
   not probeable, and that contradiction should not survive module load. */
(function _assertDisjoint () {
  const tech = new Set(INTEGRATIONS.map(function (i) { return i.id; }));
  OPERATIONAL_DEPENDENCIES.forEach(function (d) {
    if (tech.has(d.id)) {
      throw new Error('integration-registry: "' + d.id + '" is declared as BOTH a ' +
        'technical integration and an operational dependency');
    }
  });
}());

const _byId = Object.create(null);
INTEGRATIONS.forEach(function (i) { _byId[i.id] = i; });
function byId (id) { return _byId[id] || null; }

module.exports = { VERSION, CATEGORIES, INTEGRATIONS, byId,
  /* Exported separately and never merged into INTEGRATIONS. A consumer that
     wants both must ask for both, which is what keeps the boundary visible. */
  OPERATIONAL_DEPENDENCIES };
