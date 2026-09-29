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
      evidence: { modules: ['functions/email-dmarc.js', 'monitoring/dmarc-verify.js', 'docs/DMARC.md'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'DNS records, outside this console.', note: 'Verified against DNS, outside this console.' },
      notes:  'Two signing identities exist: HostPinnacle/MailBaby on selector "default", and ' +
              'SendGrid on s1/s2. A change to either one is a DNS change at HostPinnacle.',
    },
    {
      id: 'hostpinnacle-mail', name: 'HostPinnacle / MailBaby — Mailboxes',
      vendor: 'HostPinnacle', category: 'messaging', icon: '📬',
      status: 'live', direction: 'bidirectional',
      summary: 'The mail host for @mysokoni.co.ke. It holds the real mailboxes — including the ' +
               'addresses DMARC aggregate and forensic reports are delivered to — and signs ' +
               'outbound mail with its own DKIM key.',
      evidence: {
        modules: ['docs/DMARC.md', 'docs/DNS-RECORDS.md', 'monitoring/dmarc-verify.js'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Mailbox state is seen over IMAP at the provider, not from this console.', note: 'Nothing in SOKONI polls these mailboxes, so no signal reaches this console. Judge it by whether reports are arriving.' },
      notes:  'Distinct from SendGrid. SendGrid SENDS transactional mail; this host RECEIVES, and ' +
              'holds the inboxes. DMARC reports arriving nowhere is a silent failure — the reports ' +
              'land in an IMAP mailbox here, not in the platform.',
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
      evidence: { modules: ['functions/auth-dispatch.js', 'firebase.js'] },
      health: { source: null, kind: 'measurable', note: 'No health signal.' },
    },
    {
      id: 'phone-auth', name: 'Firebase Phone Auth — SMS OTP',
      vendor: 'Google Firebase', category: 'identity', icon: '📱',
      status: 'live', direction: 'bidirectional',
      summary: 'Sign-in by phone number. Firebase sends a one-time code by SMS and verifies it; ' +
               'the flow is gated by a reCAPTCHA verifier before a message is sent.',
      evidence: { modules: ['firebase.js', 'auth.js'] },
      health: { source: null, kind: 'measurable', note: 'Delivery is per-attempt and is not aggregated anywhere this console can read.' },
      notes:  'The OTP is sent by GOOGLE, not by Africa’s Talking. SOKONI’s Africa’s Talking ' +
              'rail carries platform SMS; it does not carry sign-in codes, and the two bill and ' +
              'fail independently. Do not diagnose a login-OTP failure by looking at the ' +
              'Africa’s Talking rail.',
    },
    {
      id: 'email-password-auth', name: 'Email & Password Sign-In',
      vendor: 'Google Firebase', category: 'identity', icon: '✉️',
      status: 'live', direction: 'inbound',
      summary: 'First-party account creation and sign-in with an email address and password, ' +
               'accepted through Firebase Auth.',
      evidence: { modules: ['firebase.js', 'auth.js'] },
      health: { source: null, kind: 'measurable', note: 'No aggregate signal. Individual outcomes are visible in the authentication logs, not here.' },
      notes:  'A federated provider asserts the address; this one does not. That distinction is ' +
              'what the email-verification gate exists to close, so the gate is not optional for ' +
              'accounts created this way.',
    },
    {
      id: 'recaptcha', name: 'Google reCAPTCHA',
      vendor: 'Google', category: 'identity', icon: '🤖',
      status: 'live', direction: 'outbound',
      summary: 'Bot attestation used in two distinct places: as the App Check provider for ' +
               'callable requests, and as the verifier that must pass before a phone OTP is sent.',
      evidence: { modules: ['firebase.js'] },
      health: { source: null, kind: 'measurable', note: 'A browser-to-Google exchange. No server-side signal reaches this console.' },
      notes:  'The site key is public by design — it is delivered to every browser and is NOT a ' +
              'secret. The paired SECRET key never appears in client code and must never be added ' +
              'to it. A reCAPTCHA outage degrades both App Check and phone sign-in at once, which ' +
              'is why the two are catalogued as depending on the same provider.',
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
      id: 'firestore', name: 'Cloud Firestore — (default)',
      vendor: 'Google Firebase', category: 'infra', icon: '🗄️',
      status: 'live', direction: 'internal',
      summary: 'The system of record. Every canonical figure on every SOKONI console originates ' +
               'in this database. SOKONI runs two Firestore databases; this is the one the ' +
               'application actually reads and writes.',
      evidence: { modules: ['firestore.rules', 'firestore.indexes.json'] },
      /* A database this console can actually address. `probe` names a collection
         the console attempts a bounded, read-only query against so reachability is
         OBSERVED rather than assumed. An empty result is a successful read. */
      database: { id: '(default)', rules: 'firestore.rules', probe: 'platformServices' },
      health: { source: null, kind: 'measurable', note: 'If this were down, this console could not have rendered. That is a liveness inference about this database only — it says nothing about the sokoni-ops database.' },
      notes:  'Rules and indexes for this database are deployed separately from sokoni-ops. A deploy filter that names one does not carry the other.',
    },
    {
      id: 'firestore-sokoni-ops', name: 'Cloud Firestore — sokoni-ops',
      vendor: 'Google Firebase', category: 'infra', icon: '🗄️',
      status: 'configured', direction: 'internal',
      summary: 'A second, separately-ruled Firestore database declared for admin and operations ' +
               'data. Its rules and indexes are declared and deployable, but no runtime module ' +
               'opens a connection to it, so nothing is known to read or write it in production.',
      evidence: {
        modules: ['firestore.rules.sokoni-ops', 'firestore.indexes.sokoni-ops.json'],
        env: ['firebase.json'],
      },
      database: { id: 'sokoni-ops', rules: 'firestore.rules.sokoni-ops', probe: 'healthSnapshots' },
      health: { source: null, kind: 'measurable', note: 'Nothing in the application reads this database. The console can probe it for reachability, but a reachable database is not a used one — and an empty probe is not proof it is empty.' },
      notes:  'Status is "configured", not "live", on purpose: a grep for a Firestore client bound to this database id finds nothing. Its rules are admin-read, Cloud-Functions-write-only. Do not promote this entry to "live" on the strength of the declaration alone — promote it when a runtime reader exists and has been observed. ' +
              'OBSERVED 2026-09-22 (read-only, scripts/probe-supply-ops-db.js): every collection probed in this database returned empty, while the same probe against (default) returned data — so the two handles address genuinely different databases and this one is measurably unused, consistent with the declaration above. Note for anyone repeating it: admin.firestore(app, name) does NOT select a named database and silently returns (default); use getFirestore(app, databaseId), and prove the routing with a control that must differ between the two.',
    },
    {
      id: 'cloud-run', name: 'Google Cloud Run',
      vendor: 'Google Cloud', category: 'infra', icon: '🏃',
      status: 'live', direction: 'internal',
      summary: 'The serving layer every Cloud Function actually runs on. Revisions, traffic and ' +
               'scaling limits are Cloud Run concepts, and the services that survived the ' +
               'Artifact Registry purge are serving from Cloud Run’s internal image copies.',
      evidence: {
        modules:   ['scripts/infra/ar-forensics.js', 'scripts/audit-callable-invokers.js',
                    'scripts/infra/product-trigger-volume.js'],
        endpoints: ['https://run.googleapis.com'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Revision and traffic state is read through the Cloud Run Admin API by script.', note: 'Existing revisions serve normally. Revision counts, traffic split and scaling state require the Admin API, which no deployed function exposes — so this console shows an em dash rather than a number it did not obtain.' },
      notes:  'Do NOT run "gcloud run services update". It fails for the services whose images were ' +
              'purged, and it leaves behind a failed revision that cannot be deleted while it is ' +
              'latestCreatedRevisionName.',
    },
    {
      id: 'cloud-functions', name: 'Cloud Functions',
      vendor: 'Google Cloud', category: 'infra', icon: '⚙️',
      status: 'frozen', direction: 'internal',
      summary: 'Every server-side rail SOKONI runs. Existing revisions serve normally; the ' +
               'services whose images were purged cannot create a NEW revision from their ' +
               'existing spec until they are rebuilt.',
      evidence: { modules: ['functions/index.js'], env: ['scripts/infra/recovery-manifest-20260921.json'] },
      health: { source: null, kind: 'measurable', note: 'Revisions still serve, and redeploy, cold start and rollback all work — the source zips are intact. Creating a NEW revision from an existing spec does not.' },
      notes:  'Function deletion was the leading suspect in the Artifact Registry purge and is now REFUTED — the cause was a cleanup policy (see the Artifact Registry entry). The revision blocker is a separate consequence of the purge and is independent of the cause. Rebuilds are permitted only where the owner has authorized them individually; there is no blanket deploy.',
    },
    {
      id: 'artifact-registry', name: 'Google Artifact Registry',
      vendor: 'Google Cloud', category: 'infra', icon: '📦',
      status: 'frozen', direction: 'internal',
      summary: 'The container registry backing Cloud Functions. Both gcf-artifacts repositories ' +
               'lost every function image. The cause is PROVEN: a reference-blind, age-based ' +
               'cleanup policy that deleted images live Cloud Run revisions still depended on.',
      evidence: { modules: ['scripts/infra/ar-forensics.js'] },
      health: { source: null, kind: 'elsewhere', kindNote: 'scripts/infra/ar-forensics.js is the read-only instrument.', note: 'Read state with scripts/infra/ar-forensics.js — it is read-only and self-classifying. Use a window wide enough to span a deletion age of over a day.' },
      notes:  'Cause proven: the firebase-functions-cleanup policy (DELETE, olderThan 86400s, tagState ANY), installed by the Firebase CLI and executed by the Artifact Registry service agent. Self-inflicted, not a Google-side defect. A KEEP policy has been added alongside it and is enforcing. The original canary was consumed by the mechanism it was built to detect; a live specimen now serves as the test and must not be disturbed. OBSERVED 2026-09-22, read-only: the specimen profile_get_public_profile is ALIVE past the age that consumed the canary — its digest resolves in Artifact Registry, a control image resolves through the same query path, and its Cloud Run revision is Ready and pinned BY DIGEST. Both repositories still carry BOTH policies with cleanupPolicyDryRun unset, i.e. enforcing. That is strong corroboration, NOT formal proof: a listing shows images alive, it cannot show that a sweep executed in the window. Also note the package names are snake_cased with a project prefix (sokoni--aeb26__us--central1__…) — a query written against the function name matches nothing, and that empty result is a broken detector, not a deletion. Do not push, delete or tidy anything here, and change the cleanup policy only deliberately — any policy file must carry BOTH rules.',
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
      id: 'cloudflare', name: 'Cloudflare cdnjs — Third-party Asset CDN',
      vendor: 'Cloudflare', category: 'infra', icon: '☁️',
      status: 'live', direction: 'outbound',
      summary: 'A public CDN that serves third-party front-end assets (Font Awesome) to the ' +
               'browser. This is the ONLY role Cloudflare plays for SOKONI.',
      evidence: {
        modules:   ['index.html', 'service-worker.js'],
        endpoints: ['https://cdnjs.cloudflare.com'],
      },
      health: { source: null, kind: 'measurable', note: 'A browser-to-CDN fetch. SOKONI has no account, no zone and no control plane here — an outage is visible as unstyled icons, not through any signal this console can read.' },
      notes:  'CORRECTED 2026-09-21. This entry previously claimed Cloudflare provided DNS and the ' +
              'edge for the production domain. It does not. The authoritative DNS reference names ' +
              'HostPinnacle, and Cloudflare appears nowhere in it — every Cloudflare reference in ' +
              'this repository is cdnjs.cloudflare.com, a public asset CDN. See the HostPinnacle ' +
              'entry for the vendor that actually answers for this domain. Do not re-credit ' +
              'Cloudflare with DNS without evidence from the DNS panel itself.',
    },

    {
      id: 'osm-tiles', name: 'OpenStreetMap — Map Tiles',
      vendor: 'OpenStreetMap Foundation', category: 'infra', icon: '🗺️',
      status: 'live', direction: 'outbound',
      summary: 'Every map SOKONI renders. The tile images behind delivery tracking, dispatch, ' +
               'rider navigation, fleet monitoring and the vehicle hub are fetched by the ' +
               'browser from OpenStreetMap’s public tile servers.',
      evidence: {
        modules:   ['leaflet.min.js', 'leaflet.min.css', 'delivery-tracking.html', 'dispatch.html',
                    'rider-nav.html', 'fleet-monitor.html', 'car-hub.html'],
        endpoints: ['https://{s}.tile.openstreetmap.org'],
      },
      health: { source: null, kind: 'measurable', note: 'Tiles are fetched browser-to-provider, so no server-side signal exists. A tile outage shows as a blank map on the delivery surfaces, not as a failed request anything here records.' },
      notes:  'This is a FREE public service used on a delivery-critical path, with no contract, ' +
              'no SLA and a published tile usage policy. The mapping library itself is ' +
              'self-hosted, so only the tiles are third-party. Allow-listed in the Content ' +
              'Security Policy; a CSP change that drops it blanks every map on the platform.',
    },
    {
      id: 'osm-nominatim', name: 'OpenStreetMap Nominatim — Geocoding',
      vendor: 'OpenStreetMap Foundation', category: 'infra', icon: '📍',
      status: 'live', direction: 'outbound',
      summary: 'Address lookup and reverse geocoding, reached directly from the browser and ' +
               'allow-listed in the Content Security Policy.',
      evidence: { endpoints: ['https://nominatim.openstreetmap.org'] },
      health: { source: null, kind: 'measurable', note: 'A browser-to-provider call. Nothing server-side observes it, so there is no signal to report here.' },
      notes:  'Separate from the tile service and separately rate-limited. Its usage policy caps ' +
              'request rates and requires identification; bulk or automated geocoding against the ' +
              'public endpoint is not permitted.',
    },
    {
      id: 'hostpinnacle-dns', name: 'HostPinnacle — DNS & Domain',
      vendor: 'HostPinnacle', category: 'infra', icon: '🌍',
      status: 'live', direction: 'internal',
      summary: 'The authoritative DNS provider for mysokoni.co.ke. Every record that resolves ' +
               'the production domain — the Firebase Hosting A records, MX, SPF, DKIM and DMARC — ' +
               'is served from the HostPinnacle DNS panel.',
      evidence: {
        modules: ['docs/DNS-RECORDS.md', 'docs/DMARC.md', 'monitoring/dmarc-verify.js'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Records are changed in the HostPinnacle DNS panel, and resolution is verified against public DNS.', note: 'No API is wired to this provider, so the console cannot observe it. DNS is judged by resolving the records, not by a row here.' },
      notes:  'This vendor is a single point of failure for the domain and it was previously ' +
              'UNCATALOGUED, while Cloudflare was wrongly credited with DNS. The Firebase Hosting ' +
              'records here must never be modified. Mail records are a separate concern — see the ' +
              'HostPinnacle mail entry.',
    },
    {
      id: 'secret-manager', name: 'Google Secret Manager',
      vendor: 'Google Cloud', category: 'infra', icon: '🔑',
      status: 'live', direction: 'internal',
      summary: 'Holds every production credential the backend binds. It is also the authority ' +
               'behind this console’s own credential column: the status resolver lists secret ' +
               'NAMES to answer whether a rail is provisioned.',
      evidence: {
        modules:   ['functions/integration-status.js', 'functions/index.js'],
        endpoints: ['https://secretmanager.googleapis.com'],
      },
      health: { source: null, kind: 'measurable', note: 'Readability of the secret inventory is reported per-integration as the credential state. An inventory that cannot be read renders as UNKNOWN, never as missing.' },
      notes:  'The status resolver calls secrets.LIST, which returns names and metadata and cannot ' +
              'return a payload. It never calls secrets.versions.access, binds no secret, and must ' +
              'not be changed to do either.',
    },
    {
      id: 'cloud-monitoring', name: 'Google Cloud Monitoring',
      vendor: 'Google Cloud', category: 'infra', icon: '📈',
      status: 'live', direction: 'internal',
      summary: 'Time-series metrics for Cloud Run and Cloud Functions. The instrument behind the ' +
               'trigger-volume and scaling measurements this platform relies on when deciding ' +
               'whether a change actually reduced load.',
      evidence: {
        modules:   ['scripts/infra/product-trigger-volume.js', 'scripts/gate-live-catalogue.js'],
        endpoints: ['https://monitoring.googleapis.com'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Queried by script, not by any deployed function.', note: 'Nothing deployed queries this API — it is reached from operator scripts, so there is no runtime signal to show.' },
      notes:  'Measure before claiming a reduction. A change that should lower write volume is not ' +
              'proven to have lowered it until this API says so.',
    },
    {
      id: 'firestore-indexes', name: 'Cloud Firestore — Index Management',
      vendor: 'Google Firebase', category: 'infra', icon: '🧭',
      status: 'live', direction: 'internal',
      summary: 'The composite indexes both Firestore databases depend on, and the tooling that ' +
               'reconciles what is declared against what is actually built.',
      evidence: {
        modules:   ['firestore.indexes.json', 'firestore.indexes.sokoni-ops.json',
                    'scripts/index-capacity-report.js', 'scripts/reconcile-indexes.js',
                    'scripts/firestore-index-diff.js'],
        endpoints: ['https://firestore.googleapis.com'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Built-index state is read through the Firestore Admin API by script; no deployed function reports it.', note: 'A DECLARED index is not a BUILT index. Nothing in the browser can tell you which are READY — that requires the Admin API, so this console shows an em dash rather than a count it did not obtain.' },
      notes:  'An index that is declared but not built makes a query fail at runtime while the ' +
              'repository looks correct. Reconcile before trusting either side.',
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

    /* ── Added by the Step 8 rebaseline, 2026-09-29. 47 → 52. ──────────────
       Five services the platform demonstrably talks to and that the inventory
       did not name. Each was added on CODE evidence, never on a vendor name.
       The same census REJECTED cPanel (the search matched the variable
       `discPanel`) and Twilio (SendGrid's vendor name, already here), and HELD
       Firebase Performance and Cloud Build on one weak file each. */
    {
      id: 'google-maps', name: 'Google Maps Platform',
      vendor: 'Google', category: 'infra', icon: '🗺️',
      status: 'live', direction: 'outbound',
      summary: 'Used alongside OpenStreetMap, not instead of it. OSM draws the tiles and ' +
               'geocodes; Google Maps is the hand-off target when a rider taps navigate, and ' +
               'its hosts are allowed by the Content-Security-Policy.',
      evidence: {
        modules:   ['rider-nav.html', 'service-worker.js'],
        endpoints: ['https://maps.googleapis.com', 'https://maps.gstatic.com'],
      },
      health: { source: null, kind: 'measurable', kindNote: 'No probe is written for it yet.', note: 'A hand-off to an external app leaves no signal here; a tile or Places request would.' },
      notes:  'Found by a census of what the platform actually contacts. It was absent from the ' +
              'inventory while being allowed by the CSP, cached by the service worker and ' +
              'launched from rider-nav.html — an integration nobody had written down.',
    },
    {
      id: 'ga4-analytics', name: 'Google Analytics 4 / Tag Manager',
      vendor: 'Google', category: 'infra', icon: '📊',
      status: 'live', direction: 'outbound',
      summary: 'The analytics loader ships in the delivered pages and the CSP allows ' +
               'googletagmanager.com and google-analytics.com.',
      evidence: {
        modules:   ['analytics.js', 'admin.html', 'beta-dashboard.html'],
        endpoints: ['https://www.googletagmanager.com', 'https://www.google-analytics.com'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Authoritative in the GA4 property, not here.', note: 'Whether events arrive is visible in GA4 and nowhere in this console.' },
      /* ── WIRED IS NOT CONFIGURED, AND THIS ENTRY MUST NOT COLLAPSE THEM ──
         The loader is present and the CSP permits the hosts: that is evidence
         the integration is WIRED. No G-XXXXXXXX measurement id exists anywhere
         in this repository: that means it is NOT PROVEN CONFIGURED. Reporting
         a working analytics rail on the strength of a script tag is exactly
         the inference this catalogue exists to refuse. */
      notes:  'WIRED, NOT PROVEN CONFIGURED. No G-XXXXXXXX measurement id is committed in this ' +
              'repository, so whether these pages report to any GA4 property is unestablished. ' +
              'The id may be injected at deploy time; that has not been verified. Do not read ' +
              'this entry as "analytics works".',
    },
    {
      id: 'firebase-remote-config', name: 'Firebase Remote Config',
      vendor: 'Google', category: 'infra', icon: '🎛️',
      status: 'live', direction: 'internal',
      summary: 'Backs the feature-flag layer, so it decides which behaviour a given ' +
               'build actually exhibits.',
      evidence: {
        modules: ['functions/feature-flags.js', 'sokoni-flags.js'],
      },
      health: { source: null, kind: 'measurable', kindNote: 'No probe is written for it yet.', note: 'A fetch of the active template would be a real probe; none is written.' },
      notes:  'A flag surface is worth naming in the inventory precisely because it changes ' +
              'behaviour without a deploy — so "what is running" is not answered by the commit alone.',
    },
    {
      id: 'cloud-logging', name: 'Google Cloud Logging',
      vendor: 'Google Cloud', category: 'infra', icon: '🧾',
      status: 'live', direction: 'internal',
      summary: 'The log sink behind the GCP evidence reader. It is where the deployment and ' +
               'Artifact Registry forensics in this repository actually read their facts.',
      evidence: {
        modules:   ['functions/gcp-evidence.js'],
        endpoints: ['https://logging.googleapis.com'],
      },
      health: { source: null, kind: 'elsewhere', kindNote: 'Authoritative in Cloud Logging.', note: 'Queried by the evidence reader; there is no runtime signal to show here.' },
      notes:  'Named because several safety investigations in this repository depend on it — an ' +
              'unreadable log sink turns an empty result into a false all-clear.',
    },
    {
      id: 'eventarc', name: 'Eventarc',
      vendor: 'Google Cloud', category: 'infra', icon: '🔀',
      status: 'live', direction: 'internal',
      summary: 'Routes the platform events that second-generation Cloud Functions triggers are ' +
               'delivered through.',
      evidence: {
        modules: ['scripts/audit-callable-invokers.js', 'scripts/deployment-integrity.js'],
      },
      health: { source: null, kind: 'measurable', kindNote: 'No probe is written for it yet.', note: 'Trigger delivery is measurable in principle; nothing measures it today.' },
      notes:  'Appears in the deployment-integrity and invoker audits, so it is part of how ' +
              'functions actually receive events — not an optional extra.',
    },
  ];

  /* ── OPERATIONAL DEPENDENCIES — a SEPARATE collection ───────────────────
     Providers the BUSINESS relies on and the CODE does not talk to. No client,
     no credential, no request — and therefore NO PROBE PATH. Not a probe that
     refuses, and not a probe nobody has written: nothing to measure, ever.

     They are kept out of INTEGRATIONS deliberately. Every field of the evidence
     model assumes a code path, so a member of this list placed in that one
     would have to be special-cased by every consumer — and the first to forget
     would render it `unknown`, which an operator reads as "not checked yet"
     rather than "there is nothing here to check".

     The console must render these as NOT PROBEABLE with the words "No SOKONI
     probe path", never reusing an evidence-model state.

     cPanel is excluded pending independent verification — the census hit was the
     variable `discPanel`. HostPinnacle gets no third row here: hostpinnacle-dns
     and hostpinnacle-mail already exist as code integrations. */
  var OPERATIONAL_DEPENDENCIES = [
    { id: 'google-workspace', name: 'Google Workspace', vendor: 'Google', icon: '🏢',
      kind: 'operational-dependency', probePath: 'none',
      summary: 'Company email and identity for the operating business.',
      whyNotAnIntegration: 'No SOKONI code path — the census found zero references in any source file.',
      authority: 'Google Workspace Admin console' },
    { id: 'google-admin', name: 'Google Admin', vendor: 'Google', icon: '👤',
      kind: 'operational-dependency', probePath: 'none',
      summary: 'Administration of the Workspace tenant — users, domains, groups.',
      whyNotAnIntegration: 'No SOKONI code path; the Admin SDK is not used anywhere.',
      authority: 'Google Admin console' },
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
    /* Exposed SEPARATELY and never merged into integrations. A consumer that
       wants both must ask for both — which is what keeps the boundary visible
       in the console instead of only in this comment. */
    operationalDependencies: OPERATIONAL_DEPENDENCIES,
  };
})();
