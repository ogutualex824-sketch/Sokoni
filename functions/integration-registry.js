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
    name: "Cloud Firestore",
    status: "live", direction: "internal",
    healthKind: "measurable",
    requiredSecrets: [], optionalEnv: [] },
  { id: "cloud-functions", category: "infra", vendor: "Google Cloud",
    name: "Cloud Functions & Cloud Run",
    status: "frozen", direction: "internal",
    healthKind: "measurable",
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
  { id: "cloudflare", category: "infra", vendor: "Cloudflare",
    name: "Cloudflare — DNS & Edge",
    status: "live", direction: "internal",
    healthKind: "elsewhere",
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
];

const _byId = Object.create(null);
INTEGRATIONS.forEach(function (i) { _byId[i.id] = i; });
function byId (id) { return _byId[id] || null; }

module.exports = { VERSION, CATEGORIES, INTEGRATIONS, byId };
