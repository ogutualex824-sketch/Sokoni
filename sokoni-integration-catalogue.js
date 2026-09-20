/* ============================================================================
   SOKONI Integration Catalogue — sokoni-integration-catalogue.js   v1.0.0
   ============================================================================
   The declared inventory of EVERY system SOKONI integrates with: payment rails,
   messaging providers, search engines, tax authorities, infrastructure, AI, the
   identity providers we accept, and the APIs SOKONI itself exposes outward.

   WHAT THIS FILE IS
   -----------------
   A catalogue of IDENTITY and WIRING, not of activity. Each entry answers:

     • what the integration is, and who the counterparty is
     • which direction traffic flows
     • which modules implement it, which secrets it needs, which collections it
       writes, which HTTP endpoints it exposes
     • whether it is live, inbound-only, sandboxed, quarantined or retired
     • where — if anywhere — a LIVE health signal for it can be read

   WHAT THIS FILE IS NOT
   ---------------------
   It is not a metrics source, and nothing here is a business figure. It carries
   no transaction counts, no revenue, no uptime percentage and no event volume.
   Those come from canonical runtime sources or they are shown as an em dash.
   Never add a number to this file to make a console look complete.

   `status` IS A REVIEWED CLAIM ABOUT THE CODEBASE
   -----------------------------------------------
   It records what the repository and the deployment record show, and it carries
   an `evidence` block so any reader can check it. It is deliberately NOT derived
   at runtime, because most of these rails expose no health endpoint SOKONI can
   poll, and guessing "healthy" from silence is exactly the defect this platform
   has been bitten by before. Where a live signal DOES exist, `health.source`
   names it and the console overlays it on top of this entry.

   When a rail's real state changes — a provider goes live, a lane is closed, a
   key is rotated out — update the entry IN THE SAME COMMIT as the code change.
   A catalogue that lags the code is worse than no catalogue.

   STATUS VOCABULARY (exactly these; do not invent a seventh)
   ----------------------------------------------------------
     live          serving production traffic in both intended directions
     inbound-only  SOKONI receives from it; SOKONI no longer calls out to it
     sandbox       wired and credentialled, but pointed at a test environment
     configured    credentials and code present; production serving not proven
     quarantined   deliberately closed off; do not reopen without a decision
     retired       removed from the production path; kept for history
     frozen        under an active investigation; changes are prohibited

   SECRETS
   -------
   `evidence.secrets` holds secret NAMES only — the identifiers passed to
   defineSecret(). No value, no fragment of a value, ever. The console renders
   these names so an operator can see what a rail depends on and confirm it is
   provisioned; it never reads or displays a secret's contents.
   ========================================================================== */
(function () {
  'use strict';

  /* ── Categories, in the order they are presented ─────────────────────── */
  var CATEGORIES = [
    { id: 'payments',    label: 'Payments & Settlement', icon: '💳' },
    { id: 'messaging',   label: 'Messaging & Delivery',  icon: '📢' },
    { id: 'search',      label: 'Search & Discovery',    icon: '🔍' },
    { id: 'compliance',  label: 'Tax & Compliance',      icon: '🧾' },
    { id: 'identity',    label: 'Identity Providers',    icon: '🔐' },
    { id: 'ai',          label: 'AI',                    icon: '🤖' },
    { id: 'infra',       label: 'Infrastructure',        icon: '🏗️' },
    { id: 'outbound',    label: 'APIs SOKONI Exposes',   icon: '🔌' },
  ];

  /* ── The catalogue ───────────────────────────────────────────────────── */
  var INTEGRATIONS = [

    /* ══ PAYMENTS & SETTLEMENT ══════════════════════════════════════════ */
    {
      id: 'intasend-collections', name: 'IntaSend — Collections (M-Pesa STK)',
      vendor: 'IntaSend', category: 'payments', icon: '💸',
      status: 'live', direction: 'bidirectional',
      summary: 'The production collection rail. SOKONI initiates an STK push through IntaSend; ' +
               'the customer approves it on their handset in Safaricom’s own dialog.',
      evidence: {
        modules:     ['functions/shared/stk-gateway.js', 'functions/shared/intasend-verify.js',
                      'functions/payment-adapters.js', 'functions/payment-attribution.js'],
        secrets:     ['INTASEND_API_KEY', 'INTASEND_PRIVATE_KEY'],
        collections: ['payments', 'orders', 'posPayments'],
      },
      health: { source: null, kind: 'measurable', note: 'IntaSend exposes no health endpoint SOKONI polls. Judge this rail by payment outcomes, not by this row.' },
      notes:  'The STK prompt names the SHOP, not a reference code. The dialog is Safaricom’s — it cannot be branded, and the PIN a buyer enters is Safaricom’s PIN, never SOKONI’s.',
    },
    {
      id: 'intasend-webhook', name: 'IntaSend — Payment Webhook',
      vendor: 'IntaSend', category: 'payments', icon: '📥',
      status: 'live', direction: 'inbound',
      summary: 'The sole receiver for IntaSend payment state. Challenge-verified on every POST.',
      evidence: {
        endpoints:   ['webhookIntasend'],
        modules:     ['functions/index.js'],
        secrets:     ['INTASEND_WEBHOOK_CHALLENGE'],
        collections: ['payments'],
      },
      health: { source: null, kind: 'measurable', note: 'Delivery is observable only through the payment documents it writes.' },
      notes:  'A second receiver, intasendWebhook, was retired — IntaSend never called it. Its Cloud Function is still deployed and must NOT be deleted while the Artifact Registry investigation stands.',
    },
    {
      id: 'intasend-payouts', name: 'IntaSend — B2C Payouts',
      vendor: 'IntaSend', category: 'payments', icon: '🏧',
      status: 'live', direction: 'outbound',
      summary: 'Wallet withdrawals and refund disbursement to an M-Pesa number, Till or PayBill.',
      evidence: {
        modules:     ['functions/wallet-engine.js', 'functions/wallet.js', 'functions/finos.js'],
        secrets:     ['INTASEND_PRIVATE_KEY', 'SETTLEMENT_ACCOUNT_NUMBER'],
        collections: ['payouts', 'refundRequests', 'walletTransactions'],
      },
      health: { source: null, kind: 'measurable', note: 'Payout outcome is per-transaction; read the transaction record, not an aggregate.' },
      notes:  'Field-proven. A payout below the B2C minimum fails and strands the chargeback in PROCESSING — the create event is not a completion.',
    },
    {
      id: 'pos-card-terminal', name: 'POS Card Terminal Rail',
      vendor: 'Card acquirer (unsigned)', category: 'payments', icon: '💳',
      status: 'quarantined', direction: 'bidirectional',
      summary: 'Card acceptance at the SmartPOS till. Four surfaces are deliberately closed.',
      evidence: { modules: ['functions/pos-terminal-live.js'], collections: ['posPayments'] },
      health: { source: null, kind: 'measurable', note: 'Quarantined — no traffic is expected.' },
      notes:  'No acquirer has signed. Do not open a surface here to make a demo work.',
    },
    {
      id: 'sokoni-wallet', name: 'SOKONI Wallet & Settlement Engine',
      vendor: 'SOKONI (first-party)', category: 'payments', icon: '👛',
      status: 'frozen', direction: 'internal',
      summary: 'The internal ledger, commission engine and settlement rail every other ' +
               'payment integration ultimately writes into.',
      evidence: {
        modules:     ['functions/finos.js', 'functions/settlement-engine.js', 'functions/commission-engine.js'],
        secrets:     ['PAYMENT_HMAC_SECRET', 'WALLET_QR_SECRET'],
        collections: ['wallets', 'walletTransactions', 'settlements', 'commissionRecords'],
      },
      health: { source: null, kind: 'not-applicable', kindNote: 'An internal ledger. Correctness is proven by the ledger, not a status light.', note: 'Internal. Correctness is proven by the ledger, not by a status light.' },
      notes:  'The wallet backend is under a release freeze. Treat any change here as a money change.',
    },

    /* ══ MESSAGING & DELIVERY ═══════════════════════════════════════════ */
    {
      id: 'africastalking', name: "Africa's Talking — SMS",
      vendor: "Africa's Talking", category: 'messaging', icon: '💬',
      status: 'live', direction: 'bidirectional',
      summary: 'Transactional SMS: OTPs, order updates, rider dispatch and receipts.',
      evidence: {
        modules: ['functions/sms-service.js'],
        secrets: ['AFRICASTALKING_API_KEY', 'AFRICASTALKING_USERNAME', 'SMS_WEBHOOK_TOKEN'],
        env:     ['AT_ENV', 'AT_SENDER_ID'],
      },
      health: { source: null, kind: 'measurable', note: 'Delivery reports arrive by webhook; there is no status feed to poll.' },
      notes:  'AT_SENDER_ID stays EMPTY until the operator approves the "SOKONI" sender ID. An empty value is the correct state, not a misconfiguration.',
    },
    {
      id: 'sendgrid', name: 'SendGrid — Transactional Email',
      vendor: 'Twilio SendGrid', category: 'messaging', icon: '📧',
      status: 'live', direction: 'bidirectional',
      summary: 'Primary email transport, with inbound event webhooks for bounces and opens.',
      evidence: {
        modules: ['functions/email-service.js', 'functions/email-triggers.js', 'functions/email-templates.js'],
        secrets: ['SENDGRID_API_KEY', 'SENDGRID_WEBHOOK_KEY'],
      },
      health: { source: null, kind: 'measurable', note: 'Judge by bounce and delivery events, not by this row.' },
    },
    {
      id: 'smtp-fallback', name: 'SMTP — Direct Mail Transport',
      vendor: 'SMTP host', category: 'messaging', icon: '✉️',
      status: 'configured', direction: 'outbound',
      summary: 'A direct SMTP transport configured alongside SendGrid.',
      evidence: { modules: ['functions/email-service.js'], secrets: ['MAIL_HOST', 'MAIL_USER', 'MAIL_PASS'] },
      health: { source: null, kind: 'measurable', note: 'No health signal.' },
    },
    {
      id: 'email-dmarc', name: 'Email Authentication (SPF / DKIM / DMARC)',
      vendor: 'DNS + mail providers', category: 'messaging', icon: '🛡️',
      status: 'configured', direction: 'outbound',
      summary: 'Domain authentication policy that decides whether SOKONI mail is trusted.',
      evidence: { modules: ['functions/email-dmarc.js'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'DNS records, outside this console.', note: 'Verified against DNS, outside this console.' },
    },
    {
      id: 'fcm', name: 'Firebase Cloud Messaging — Push',
      vendor: 'Google Firebase', category: 'messaging', icon: '🔔',
      status: 'live', direction: 'outbound',
      summary: 'Web and device push for orders, dispatch, chat and platform notices.',
      evidence: { modules: ['functions/notify.js', 'functions/messages.js'], collections: ['notifications', 'fcmTokens'] },
      health: { source: null, kind: 'measurable', note: 'Token invalidation is the practical signal; there is no feed to poll.' },
    },

    /* ══ SEARCH & DISCOVERY ═════════════════════════════════════════════ */
    {
      id: 'algolia', name: 'Algolia — Search Index',
      vendor: 'Algolia', category: 'search', icon: '🔎',
      status: 'live', direction: 'outbound',
      summary: 'The production search index: catalogue sync, personalisation, recommendations, ' +
               'query suggestions and search analytics.',
      evidence: {
        modules: ['functions/algolia-sync.js', 'functions/algolia-indexer.js', 'functions/algolia-queue.js',
                  'functions/algolia-reconcile.js', 'functions/algolia-monitor.js',
                  'functions/algolia-secured-keys.js', 'functions/algolia-personalization.js'],
        secrets: ['ALGOLIA_ADMIN_KEY', 'ALGOLIA_SEARCH_KEY'],
        env:     ['ALGOLIA_APP_ID'],
      },
      health: { source: null, kind: 'measurable', note: 'Index drift is measured by the reconcile job, not by a status light.' },
      notes:  'Browser-side search uses a SECURED key scoped per user — the admin key never reaches a client.',
    },
    {
      id: 'typesense', name: 'Typesense — Search Nodes',
      vendor: 'Typesense', category: 'search', icon: '🔢',
      status: 'configured', direction: 'outbound',
      summary: 'A second search backend, credentialled and wired alongside Algolia.',
      evidence: {
        modules: ['functions/typesense-admin.js', 'functions/search-service.js'],
        secrets: ['TYPESENSE_ADMIN_KEY', 'TYPESENSE_SEARCH_KEY'],
        env:     ['TYPESENSE_NODES'],
      },
      health: { source: null, kind: 'measurable', note: 'Node reachability is not polled from this console.' },
      notes:  'Which engine serves a given query is decided by the search service, not by this catalogue.',
    },

    /* ══ TAX & COMPLIANCE ═══════════════════════════════════════════════ */
    {
      id: 'etims', name: 'KRA eTIMS — Tax Invoicing',
      vendor: 'Kenya Revenue Authority', category: 'compliance', icon: '🇰🇪',
      status: 'live', direction: 'bidirectional',
      summary: 'Fiscal invoice transmission to KRA, with the tax engine and audit trail behind it.',
      evidence: {
        modules: ['functions/etims-kra-adapter.js', 'functions/etims-tax-engine.js',
                  'functions/etims-lifecycle.js', 'functions/etims-audit.js', 'functions/hub-etims.js'],
        secrets: ['ETIMS_MASTER_KEY', 'ETIMS_PLATFORM_PIN', 'ETIMS_PLATFORM_SECRET'],
        env:     ['ETIMS_ENV'],
        collections: ['etimsInvoices', 'etimsAudit'],
      },
      health: { source: null, kind: 'measurable', note: 'Transmission outcome is per-invoice; read the invoice record.' },
      notes:  'ETIMS_ENV must be "production" or "sandbox" — a missing value throws at boot rather than defaulting.',
    },
    {
      id: 'odpc', name: 'ODPC — Data Protection Compliance',
      vendor: 'Office of the Data Protection Commissioner', category: 'compliance', icon: '📜',
      status: 'configured', direction: 'internal',
      summary: 'Consent records, data-subject requests and account purge obligations.',
      evidence: { modules: ['functions/account-purge-spec.js'], collections: ['consentRecords'] },
      health: { source: null, kind: 'not-applicable', kindNote: 'A legal obligation, not a service with a status.', note: 'A legal obligation, not a polled service.' },
    },

    /* ══ IDENTITY PROVIDERS ═════════════════════════════════════════════ */
    {
      id: 'firebase-auth', name: 'Firebase Authentication',
      vendor: 'Google Firebase', category: 'identity', icon: '🔑',
      status: 'live', direction: 'bidirectional',
      summary: 'The identity authority for every SOKONI surface, including the custom claims ' +
               'that gate this console.',
      evidence: { modules: ['functions/auth-dispatch.js', 'functions/universal-onboarding.js'], collections: ['users'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'A failure presents as sign-in failure, not as a row here.', note: 'A failure here presents as sign-in failure, not as a row on this screen.' },
    },
    {
      id: 'google-signin', name: 'Google Sign-In',
      vendor: 'Google', category: 'identity', icon: '🅶',
      status: 'live', direction: 'inbound',
      summary: 'Federated sign-in accepted through Firebase Auth.',
      evidence: { modules: ['functions/auth-dispatch.js'] },
      health: { source: null, kind: 'measurable', note: 'No health signal.' },
    },
    {
      id: 'facebook-login', name: 'Facebook Login & Data Deletion',
      vendor: 'Meta', category: 'identity', icon: '📘',
      status: 'live', direction: 'bidirectional',
      summary: 'Federated sign-in, plus the data-deletion callback Meta requires of every app.',
      evidence: { modules: ['functions/facebook-data-deletion.js'], secrets: ['FACEBOOK_APP_SECRET'] },
      health: { source: null, kind: 'measurable', note: 'No health signal.' },
      notes:  'The deletion callback is a platform requirement. Removing it puts the app registration at risk.',
    },
    {
      id: 'age-verification', name: 'Age & Identity Verification',
      vendor: 'SOKONI (first-party)', category: 'identity', icon: '🪪',
      status: 'configured', direction: 'internal',
      summary: 'Document and age checks feeding the verification queue.',
      evidence: { modules: ['functions/age-verification.js'], secrets: ['AGE_ID_SALT'], collections: ['verificationRequests'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'Queue depth in the verification console.', note: 'Queue depth is the signal; it lives in the verification console.' },
      notes:  'Approval alone is not verification — an official badge requires liveness, a match and human review.',
    },

    /* ══ AI ═════════════════════════════════════════════════════════════ */
    {
      id: 'anthropic', name: 'Anthropic Claude',
      vendor: 'Anthropic', category: 'ai', icon: '🧠',
      status: 'live', direction: 'outbound',
      summary: 'The model behind the SOKONI assistant, the SmartPOS assistant and AI credits.',
      evidence: {
        modules: ['functions/ai-subscriptions.js', 'functions/pos-ai-assistant.js'],
        secrets: ['ANTHROPIC_API_KEY'],
        collections: ['aiCredits', 'aiUsage'],
      },
      health: { source: null, kind: 'measurable', note: 'Metered by AI credit consumption, which is a billing figure — read it from the billing console.' },
    },
    {
      id: 'vertex-gemini', name: 'Vertex AI — Gemini Pro Vision',
      vendor: 'Google Cloud', category: 'ai', icon: '👁️',
      status: 'live', direction: 'outbound',
      summary: 'Vision model that reads an uploaded product image and proposes catalogue ' +
               'metadata for it.',
      evidence: { modules: ['functions/media-engine.js'] },
      health: { source: null, kind: 'measurable', note: 'Vision calls fall back rather than fail the upload; a silent fallback is not visible here.' },
      notes:  'Authenticated by the function’s own service account, so it appears in no secret list.',
    },

    /* ══ INFRASTRUCTURE ═════════════════════════════════════════════════ */
    {
      id: 'firestore', name: 'Cloud Firestore',
      vendor: 'Google Firebase', category: 'infra', icon: '🗄️',
      status: 'live', direction: 'internal',
      summary: 'The system of record. Every canonical figure on every SOKONI console originates here.',
      evidence: { modules: ['firestore.rules', 'firestore.indexes.json'] },
      health: { source: null, kind: 'measurable', note: 'If this were down, this console could not have rendered.' },
    },
    {
      id: 'cloud-functions', name: 'Cloud Functions & Cloud Run',
      vendor: 'Google Cloud', category: 'infra', icon: '⚙️',
      status: 'frozen', direction: 'internal',
      summary: 'Every server-side rail SOKONI runs. Currently under an artifact investigation ' +
               'that prohibits deploying, deleting or reconfiguring a function.',
      evidence: { modules: ['functions/index.js'] },
      health: { source: null, kind: 'measurable', note: 'Revisions still serve. Creating a NEW revision from an existing spec does not work.' },
      notes:  'Function deletion is the leading suspect in the Artifact Registry purge. Do not deploy or delete anything here while the freeze stands.',
    },
    {
      id: 'artifact-registry', name: 'Google Artifact Registry',
      vendor: 'Google Cloud', category: 'infra', icon: '📦',
      status: 'frozen', direction: 'internal',
      summary: 'The container registry backing Cloud Functions. Both gcf-artifacts repositories ' +
               'lost every function image; a controlled canary is instrumenting the cause.',
      evidence: { modules: ['scripts/infra/ar-forensics.js'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'scripts/infra/ar-forensics.js is the read-only instrument.', note: 'Read state with scripts/infra/ar-forensics.js — it is read-only and self-classifying.' },
      notes:  'Do not push, delete or tidy anything in Artifact Registry, and do not delete the forensics canary.',
    },
    {
      id: 'memorystore-redis', name: 'Memorystore Redis',
      vendor: 'Google Cloud', category: 'infra', icon: '⚡',
      status: 'live', direction: 'internal',
      summary: 'Cache, rate limiting, presence and the async job queue, reached over a ' +
               'Serverless VPC connector.',
      evidence: {
        modules: ['functions/redis-service.js', 'functions/redis-layer.js', 'functions/redis-jobs.js',
                  'functions/redis-rate-limiter.js', 'functions/redis-integrations.js'],
        secrets: ['REDIS_URL'],
      },
      health: { source: null, kind: 'measurable', note: 'The Redis Monitor console reads live key and connection state.' },
      notes:  'Firestore stays authoritative. Every Redis handler is wrapped so a cache failure never fails the write.',
    },
    {
      id: 'firebase-hosting', name: 'Firebase Hosting',
      vendor: 'Google Firebase', category: 'infra', icon: '🌐',
      status: 'live', direction: 'internal',
      summary: 'Serves mysokoni.co.ke, including the service worker that keeps pages fresh.',
      evidence: { modules: ['firebase.json', 'service-worker.js', 'version.json'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'version.json stamps the deployed hosting commit.', note: 'version.json stamps the deployed hosting commit — and only hosting.' },
      notes:  'sokoni.co.ke is an unrelated site. Never judge production state from it.',
    },
    {
      id: 'cloud-storage', name: 'Cloud Storage',
      vendor: 'Google Firebase', category: 'infra', icon: '🖼️',
      status: 'live', direction: 'internal',
      summary: 'Product media, documents and verification uploads.',
      evidence: { modules: ['storage.rules'] },
      health: { source: null, kind: 'measurable', note: 'No polled signal.' },
    },
    {
      id: 'app-check', name: 'Firebase App Check',
      vendor: 'Google Firebase', category: 'infra', icon: '🛡️',
      status: 'live', direction: 'internal',
      summary: 'Attestation that a callable request came from a genuine SOKONI client. ' +
               'Enforced across the large majority of callable functions.',
      evidence: { modules: ['functions/index.js'] },
      health: { source: null, kind: 'not-applicable', kindNote: 'Enforcement is a code fact, not a runtime signal.', note: 'Enforcement is per-function; a count of enforcing modules is a code fact, not a runtime signal.' },
      notes:  'A function without enforcement is not automatically a vulnerability — several are public or webhook endpoints by design. Audit the endpoint, not the count.',
    },
    {
      id: 'cloud-scheduler', name: 'Cloud Scheduler',
      vendor: 'Google Cloud', category: 'infra', icon: '⏰',
      status: 'live', direction: 'internal',
      summary: 'Drives every recurring job: settlement sweeps, index reconciliation, health ' +
               'sweeps, billing runs and digest mail.',
      evidence: { modules: ['functions/index.js'] },
      health: { source: null, kind: 'measurable', note: 'A job that stops firing is silent by nature. Judge each job by what it last wrote.' },
    },
    {
      id: 'cloudflare', name: 'Cloudflare — DNS & Edge',
      vendor: 'Cloudflare', category: 'infra', icon: '☁️',
      status: 'live', direction: 'internal',
      summary: 'DNS for the production domain and the edge in front of it.',
      evidence: { modules: ['firebase.json'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'Edge state is read at Cloudflare.', note: 'Edge state is read at Cloudflare, not here.' },
      notes:  'The Cloudflare analytics beacon is blocked by the Content Security Policy. That is the CSP working, not a fault to route around.',
    },

    /* ══ APIS SOKONI EXPOSES ════════════════════════════════════════════ */
    {
      id: 'pos-external-api', name: 'SmartPOS External API',
      vendor: 'Third-party consumers', category: 'outbound', icon: '🔑',
      status: 'live', direction: 'inbound',
      summary: 'Key-authenticated, seller-scoped feeds: sales, inventory, ledger and eTIMS-ready ' +
               'invoice data, plus an OpenAPI schema for integrators.',
      evidence: {
        modules:     ['functions/pos-integrations-api.js', 'functions/pos-integrations.js'],
        endpoints:   ['posGetSalesExport', 'posGetInventoryExport', 'posGetLedgerExport',
                      'posGetEtimsExport', 'posReceiveErpUpdate', 'posGetApiDocs'],
        collections: ['posAPIKeys'],
      },
      health: { source: 'posAPIKeys', kind: 'not-applicable', kindNote: 'SOKONI is the provider here; there is no counterparty to contact.', note: 'Issued keys are listed in this console’s Credentials tab.' },
      notes:  'Every key is scoped to one seller and one permission set. A key is never rendered after issue.',
    },
    {
      id: 'pos-webhooks', name: 'SmartPOS Outbound Webhooks',
      vendor: 'Merchant endpoints', category: 'outbound', icon: '🔗',
      status: 'live', direction: 'outbound',
      summary: 'Signed event delivery to merchant-registered endpoints — including Zapier, Make ' +
               'and bespoke receivers.',
      evidence: {
        modules:     ['functions/pos-integrations-api.js'],
        secrets:     ['POS_WEBHOOK_SECRET'],
        collections: ['posWebhooks'],
      },
      health: { source: 'posWebhooks', kind: 'measurable', note: 'Live: this console reads every endpoint’s failure count and last delivery status.' },
      notes:  'Each endpoint has its own signing secret. This console never renders one.',
    },
    {
      id: 'erp-connectors', name: 'ERP & Accounting Connectors',
      vendor: 'SAP, Sage, Odoo, Dynamics, QuickBooks, Xero, Zoho', category: 'outbound', icon: '📒',
      status: 'configured', direction: 'inbound',
      summary: 'A generic ingest endpoint documented for ERP and accounting systems to push ' +
               'fulfilment and purchase-order updates into SmartPOS.',
      evidence: { modules: ['functions/pos-integrations-api.js'], endpoints: ['posReceiveErpUpdate'] },
      health: { source: null, kind: 'measurable', note: 'No vendor-specific adapter is implemented — the endpoint is generic.' },
      notes:  'The named vendors are the documented TARGETS of this endpoint. None has a bespoke adapter; do not present one as connected.',
    },
    {
      id: 'inventory-webhooks', name: 'Inventory Webhooks',
      vendor: 'Merchant endpoints', category: 'outbound', icon: '📦',
      status: 'live', direction: 'outbound',
      summary: 'Stock-level and movement events pushed to subscribed endpoints.',
      evidence: { modules: ['functions/inventory-webhooks.js'], collections: ['inventoryMovements'] },
      health: { source: null, kind: 'measurable', note: 'Delivery outcome is recorded per event.' },
    },
    {
      id: 'api-gateway', name: 'SOKONI API Gateway',
      vendor: 'SOKONI (first-party)', category: 'outbound', icon: '🚪',
      status: 'live', direction: 'inbound',
      summary: 'The authenticated front door for platform API traffic, with request signing.',
      evidence: { modules: ['functions/api-gateway.js'], secrets: ['SOKONI_HMAC_KEY'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'Gateway rejections surface in logs.', note: 'Gateway rejections surface in logs, not here.' },
    },
    {
      id: 'platform-registry', name: 'Platform Service Registry',
      vendor: 'SOKONI (first-party)', category: 'outbound', icon: '📋',
      status: 'live', direction: 'internal',
      summary: 'Self-registration for every SOKONI service, with heartbeats, declared ' +
               'capabilities and a dependency graph. It is what the Registered tab reads.',
      evidence: {
        modules:     ['functions/platform-registry.js'],
        collections: ['platformServices', 'platformHealth', 'platformDependencies'],
      },
      health: { source: 'platformServices', kind: 'not-applicable', kindNote: 'This console IS the registry; it cannot poll itself.', note: 'Live: the Registered, Capabilities and Dependencies tabs are this registry.' },
      notes:  'A service appears here only if it calls platformRegisterService on boot. An empty registry means nothing registered — not that nothing is running.',
    },
  ];

  /* ── Indexes ─────────────────────────────────────────────────────────── */
  var byId = {};
  INTEGRATIONS.forEach(function (i) { byId[i.id] = i; });

  /** Every distinct secret name the catalogue declares, with its dependants.
      Names only — this function cannot expose a value because it never has one. */
  function secrets() {
    var map = {};
    INTEGRATIONS.forEach(function (i) {
      ((i.evidence || {}).secrets || []).forEach(function (s) {
        (map[s] = map[s] || []).push(i);
      });
    });
    return Object.keys(map).sort().map(function (s) {
      return { name: s, usedBy: map[s] };
    });
  }

  function byCategory(id) {
    return INTEGRATIONS.filter(function (i) { return i.category === id; });
  }

  window.SokoniIntegrationCatalogue = {
    version:      '1.0.0',
    categories:   CATEGORIES,
    integrations: INTEGRATIONS,
    lookup:       function (id) { return byId[id] || null; },
    byCategory:   byCategory,
    secrets:      secrets,
  };
})();
