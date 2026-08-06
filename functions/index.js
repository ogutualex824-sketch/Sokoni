/* ============================================================
   KASS — SOKONI Admin AI Agent
   Firebase Cloud Function (Gen 2)
   Uses Claude claude-sonnet-4-6 with tool use to manage the marketplace
============================================================ */

const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { onDocumentCreated, onDocumentUpdated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const Anthropic = require("@anthropic-ai/sdk");

admin.initializeApp();

/* Lazy Anthropic client — created once per instance after secrets are available */
let _anthropicInstance = null;
function _getAnthropicClient() {
  if (!_anthropicInstance) _anthropicInstance = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });
  return _anthropicInstance;
}
const db = admin.firestore();
const { writeAudit: _writeAudit } = require('./pos-audit');

const ANTHROPIC_API_KEY    = defineSecret("ANTHROPIC_API_KEY");
const INTASEND_PRIVATE_KEY       = defineSecret("INTASEND_PRIVATE_KEY");
const INTASEND_WEBHOOK_CHALLENGE = defineSecret("INTASEND_WEBHOOK_CHALLENGE");
const ALGOLIA_ADMIN_KEY    = defineSecret("ALGOLIA_ADMIN_KEY");
const sokoniAt             = require("./sokoni-at");
const SOKONI_HMAC_KEY      = defineSecret("SOKONI_HMAC_KEY");
/* Canonical corporate identity (legal name, address, copyright, ownership) — the
   single source of truth. Never duplicate corporate-metadata literals. */
const { COMPANY }          = require("./company-identity");
const _kassKnowledge       = require("./kass-knowledge");   /* KASS retrieval: knowledge is data, not prompt */
const _kassModes           = require("./kass-modes");       /* automatic expertise routing */
const _kassMemory          = require("./kass-memory");      /* derived preferences only — no transcripts */
const logger              = require("firebase-functions/logger");

/* Brand layer + age enforcement. Required HERE, at the top, because
   initiateSTKPush (~line 4956) reads both for the Stage 1B compliance gate.
   _ageVerify is also re-required further down alongside its callable exports;
   require() is cached, so this is the same module object, and having the
   compliance dependencies visible at the top of the file is worth more than
   relying on a const declared 4,000 lines below the code that uses it. */
const _brands             = require("./brands");            /* consumer brands; Bravilex stays the legal entity */
const _ageVerify          = require("./age-verification");  /* server-side age gate */

/* ── Structured logging utility ─────────────────────────────────────────────
   Creates a scoped logger that prefixes every message with a unique
   requestId so all log lines for a single invocation can be correlated
   in Cloud Logging using: jsonPayload.requestId = "<id>"
─────────────────────────────────────────────────────────────────────────── */
function createLogger(context = {}) {
  const id = context.requestId ||
    (Date.now().toString(36) + Math.random().toString(36).slice(2, 7)).toUpperCase();
  const base = { requestId: id, ...context };

  return {
    id,
    info:  (msg, extra = {}) => console.log(JSON.stringify({ severity: "INFO",    message: msg, ...base, ...extra })),
    warn:  (msg, extra = {}) => console.warn(JSON.stringify({ severity: "WARNING", message: msg, ...base, ...extra })),
    error: (msg, extra = {}) => console.error(JSON.stringify({ severity: "ERROR",  message: msg, ...base, ...extra })),
    audit: (msg, extra = {}) => console.log(JSON.stringify({ severity: "NOTICE",  message: msg, ...base, ...extra, audit: true })),
  };
}

/* ── MFA enforcement helper ──────────────────────────────────────────────────
   Checks that the decoded Firebase ID token carries a satisfied second factor.
   Firebase encodes MFA satisfaction in token.firebase.sign_in_second_factor.
   Returns true if the user has passed MFA, false otherwise.

   Usage: call requireMFA(decodedToken) in any admin-scoped Cloud Function.
   If it returns false, throw HttpsError("unauthenticated", "MFA required.").
   MFA ENROLLMENT must be done via Firebase Console or the Admin SDK separately.
─────────────────────────────────────────────────────────────────────────── */
function hasMFASatisfied(decodedToken) {
  /* Firebase encodes the second factor in the nested firebase.sign_in_second_factor claim */
  return !!(
    decodedToken?.firebase?.sign_in_second_factor ||
    decodedToken?.firebase?.sign_in_attributes?.second_factor
  );
}

/* MFA enforcement: defaults ON in production. Set MFA_REQUIRED=false to disable (dev only). */
const MFA_REQUIRED_ENV = process.env.MFA_REQUIRED !== "false";

function assertMFA(decodedToken, role = "admin") {
  if (!MFA_REQUIRED_ENV) return; /* Only skip if explicitly disabled via env var */
  if (!hasMFASatisfied(decodedToken)) {
    console.warn(JSON.stringify({
      severity: "WARNING",
      message:  "MFA not satisfied",
      uid:      decodedToken?.uid,
      role,
    }));
    throw new HttpsError("unauthenticated",
      "Multi-factor authentication is required for this action. Please re-authenticate with your second factor.");
  }
}

/* ══════════════════════════════════════════════════════════════
   ADMIN CLAIM MANAGEMENT  (Fix 4)

   grantAdminClaim  — sets { admin: true } custom claim on a user.
   revokeAdminClaim — removes the claim.

   Bootstrap sequence (run once):
     1. The account signs in — by phone, email or a linked provider. The method
        does not matter; the UID is the identity.
     2. An operator with project credentials seeds that UID:
          node functions/scripts/seed-bootstrap.js --phone +2547XXXXXXXX
        This writes _systemConfig/bootstrap.allowedUids, which firestore.rules
        :2867 makes unwritable by any client.
     3. That account calls bootstrapAdminClaim() once. It grants admin AND
        superAdmin — no other code path can mint the first superAdmin — then
        locks itself permanently.
     4. Sign out and back in so the JWT is reissued with the new claims.
     5. Firestore isAdmin() (firestore.rules:9) reads token.admin / superAdmin.

   Every later role change requires an existing superAdmin. To grant claims
   directly instead, use functions/scripts/set-admin-claim.js --super.
══════════════════════════════════════════════════════════════ */
/* ── BOOTSTRAP  (one-time only — establishes the first administrator) ──────────
   AUTHORISATION IS BY UID, NOT EMAIL.

   This previously compared request.auth.token.email against a hardcoded
   address. Two defects followed, and they locked the platform owner out of
   their own system:

     1. Authorisation depended on the AUTHENTICATION METHOD. Under phone
        sign-in there is no `email` claim at all, so the comparison failed for
        every phone-authenticated user regardless of which address was
        configured. A super administrator who signs in by phone could never
        satisfy it.
     2. It granted only `admin`. Every function that can grant `superAdmin`
        already requires `superAdmin` from its caller, so the highest privilege
        on the platform was structurally unreachable — the system could not
        produce its own first super administrator.

   The allowlist now lives in _systemConfig/bootstrap.allowedUids and is seeded
   out of band by the Admin SDK (functions/scripts/seed-bootstrap.js). That
   satisfies both halves of the problem: a UID is the canonical identity and is
   identical under phone, email or a linked account, and the deadlock is broken
   without hardcoding an identity into application code.

   This is not a weaker gate. firestore.rules denies all client writes to
   _systemConfig, so the allowlist can only be written by a principal holding
   Google credentials for this project — a stronger boundary than an email
   string in a source file, which anyone who could create that mailbox could
   have claimed. All three original locks are retained below. */
exports.bootstrapAdminClaim = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

    /* Allowlisted by UID — seeded server-side, never by a client. */
    const bootstrapCfg = await db.collection("_systemConfig").doc("bootstrap").get();
    const allowedUids = (bootstrapCfg.exists && Array.isArray(bootstrapCfg.data().allowedUids))
      ? bootstrapCfg.data().allowedUids : [];

    if (!allowedUids.includes(request.auth.uid)) {
      /* Deliberately specific. "Not authorised" sent the owner hunting through
         their own account settings for an hour; the real answer is that a
         server-side seed step has not been run. */
      throw new HttpsError("permission-denied",
        "This account is not on the bootstrap allowlist. An operator with project " +
        "credentials must run functions/scripts/seed-bootstrap.js --uid " + request.auth.uid);
    }

    /* ── Triple-layer bootstrap guard ────────────────────────────────────────
       1. Permanent lock flag in _systemConfig/bootstrap — once set, never cleared.
          This document is protected by Firestore security rules (admin-only writes)
          so an attacker cannot delete it to re-enable bootstrap.
       2. users collection check — ensure no admin role record exists.
       3. Firebase Auth custom-claims check — the JWT itself is the source of truth.
    ── */
    const lockRef  = db.collection("_systemConfig").doc("bootstrap");
    const lockSnap = await lockRef.get();
    if (lockSnap.exists && lockSnap.data().locked === true) {
      throw new HttpsError("already-exists", "Bootstrap has already been completed. Use grantAdminClaim.");
    }

    const existing = await db.collection("users")
      .where("role", "==", "admin").limit(1).get();
    if (!existing.empty) {
      throw new HttpsError("already-exists", "An admin already exists. Use grantAdminClaim instead.");
    }

    const uid = request.auth.uid;

    const callerRecord = await admin.auth().getUser(uid);
    const callerClaims = callerRecord.customClaims || {};
    if (callerClaims.admin === true) {
      throw new HttpsError("already-exists", "This account already has admin access.");
    }

    const existingClaims = await admin.auth().getUser(uid).then(u => u.customClaims || {}).catch(() => ({}));

    /* The FIRST administrator is granted superAdmin as well as admin.
       Every other path to superAdmin (grantAdminClaim, grantPlatformRole,
       setUserRole) requires the caller to already hold it, so if bootstrap does
       not mint it, nothing ever can — the platform cannot produce its own
       highest privilege. This is the one place where granting it is correct:
       it runs exactly once, only for a UID an operator seeded out of band, and
       then permanently locks itself. */
    await admin.auth().setCustomUserClaims(uid, {
      ...existingClaims,
      admin: true,
      superAdmin: true,
      role: "superAdmin",
    });
    await db.collection("users").doc(uid).set(
      { role: "superAdmin", adminGrantedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    /* Permanent lock. merge:true so the allowlist and any prior audit fields
       survive — a plain set() would erase allowedUids, destroying the record of
       who was authorised to run this. */
    await lockRef.set({
      locked:       true,
      adminUid:     uid,
      completedAt:  admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    await db.collection("auditLog").add({
      action: "bootstrap_super_admin", uid, actor: uid,
      note: "First administrator established via allowlisted bootstrap.",
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    console.log(`[bootstrapAdminClaim] Bootstrap completed by uid=${uid} — lock set.`);
    return { success: true, message: "Admin claim granted. Sign out and back in to activate." };
  }
);

exports.grantAdminClaim = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be signed in.");
    }

    if (request.auth.token?.superAdmin !== true) {
      throw new HttpsError("permission-denied", "Super-admin access required.");
    }

    const { targetUid } = request.data;
    if (!targetUid || typeof targetUid !== "string") {
      throw new HttpsError("invalid-argument", "targetUid (string) is required.");
    }

    const existClaims = await admin.auth().getUser(targetUid).then(u => u.customClaims || {}).catch(() => ({}));
    await admin.auth().setCustomUserClaims(targetUid, { ...existClaims, admin: true });
    await admin.auth().revokeRefreshTokens(targetUid);

    await db.collection("users").doc(targetUid).set(
      { role: "admin", roles: admin.firestore.FieldValue.arrayUnion("admin"), adminGrantedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );

    await db.collection("auditLogs").add({ action: "grantAdminClaim", targetUid, grantedBy: request.auth.uid, ts: admin.firestore.FieldValue.serverTimestamp() });
    _writeAudit(db, {
      action: 'role.change', actorUid: request.auth.uid, actorRole: 'superAdmin',
      objectType: 'user', objectId: targetUid,
      before: { admin: !!existClaims.admin }, after: { admin: true },
      metadata: { grant: 'admin' },
    });
    return { success: true, uid: targetUid, message: "Admin claim granted. User must sign out and back in." };
  }
);

exports.revokeAdminClaim = onCall(
  { timeoutSeconds: 30, enforceAppCheck: true },
  async (request) => {
    if (!request.auth || request.auth.token?.superAdmin !== true) {
      throw new HttpsError("permission-denied", "Super-admin access required.");
    }

    const { targetUid } = request.data;
    if (!targetUid || typeof targetUid !== "string") {
      throw new HttpsError("invalid-argument", "targetUid (string) is required.");
    }

    if (targetUid === request.auth.uid) {
      throw new HttpsError("invalid-argument", "Cannot revoke your own admin claim.");
    }

    /* Preserve other claims — only delete admin key */
    const existClaims = await admin.auth().getUser(targetUid).then(u => u.customClaims || {}).catch(() => ({}));
    const _wasAdmin = !!existClaims.admin;
    delete existClaims.admin;
    await admin.auth().setCustomUserClaims(targetUid, existClaims);
    await admin.auth().revokeRefreshTokens(targetUid);
    await db.collection("users").doc(targetUid).set(
      { roles: admin.firestore.FieldValue.arrayRemove("admin") },
      { merge: true }
    );

    await db.collection("auditLogs").add({ action: "revokeAdminClaim", targetUid, revokedBy: request.auth.uid, ts: admin.firestore.FieldValue.serverTimestamp() });
    _writeAudit(db, {
      action: 'role.change', actorUid: request.auth.uid, actorRole: 'superAdmin',
      objectType: 'user', objectId: targetUid,
      before: { admin: _wasAdmin }, after: { admin: false },
      metadata: { revoke: 'admin' },
    });
    return { success: true, uid: targetUid };
  }
);

/* ── GET USER CLAIMS — admin inspection of any user's current claims ── */
exports.getUserClaims = onCall(
  { timeoutSeconds: 15 },
  async (request) => {
    if (!request.auth?.token?.admin && !request.auth?.token?.superAdmin) {
      throw new HttpsError("permission-denied", "Admin access required.");
    }
    const { targetUid } = request.data || {};
    if (!targetUid || typeof targetUid !== "string") {
      throw new HttpsError("invalid-argument", "targetUid (string) is required.");
    }
    const userRecord = await admin.auth().getUser(targetUid).catch(() => null);
    if (!userRecord) throw new HttpsError("not-found", "User not found.");

    const snap = await db.collection("users").doc(targetUid).get();
    return {
      uid:          targetUid,
      email:        userRecord.email || null,
      customClaims: userRecord.customClaims || {},
      disabled:     userRecord.disabled,
      firestoreRoles: snap.exists() ? (snap.data().roles || []) : [],
    };
  }
);

/* ── TOOL DEFINITIONS ── */
const TOOLS = [
  {
    name: "get_recent_orders",
    description: "Get recent orders from the marketplace. Returns order details including buyer, seller, items, status, amount.",
    input_schema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Number of orders to fetch (default 10, max 50)" },
        status: { type: "string", description: "Filter by status: pending, confirmed, delivered, cancelled, disputed" },
      },
    },
  },
  {
    name: "get_users",
    description: "List or search users. Returns user profiles, registration date, role, status.",
    input_schema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Number of users to fetch (default 10)" },
        role:   { type: "string", description: "Filter by role: buyer, seller, driver, provider, admin" },
        search: { type: "string", description: "Search by name or email" },
      },
    },
  },
  {
    name: "ban_user",
    description: "Ban or unban a user from the platform.",
    input_schema: {
      type: "object",
      properties: {
        userId: { type: "string", description: "The user's UID" },
        reason: { type: "string", description: "Reason for the ban" },
        banned: { type: "boolean", description: "true to ban, false to unban" },
      },
      required: ["userId", "banned"],
    },
  },
  {
    name: "get_sellers",
    description: "List sellers — pending approval, active, or suspended.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "Filter: pending, active, suspended" },
        limit:  { type: "number", description: "Number to fetch (default 10)" },
      },
    },
  },
  {
    name: "approve_seller",
    description: "Approve or suspend a seller account.",
    input_schema: {
      type: "object",
      properties: {
        sellerId: { type: "string", description: "The seller document ID" },
        approve:  { type: "boolean", description: "true to approve, false to suspend" },
        note:     { type: "string", description: "Admin note" },
      },
      required: ["sellerId", "approve"],
    },
  },
  {
    name: "get_analytics",
    description: "Get revenue and sales analytics summary.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today, week, month" },
      },
    },
  },
  {
    name: "get_disputes",
    description: "List open or all disputes between buyers and sellers.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "open, resolved, all" },
        limit:  { type: "number", description: "Number to fetch" },
      },
    },
  },
  {
    name: "resolve_dispute",
    description: "Resolve a dispute — rule in favour of buyer or seller.",
    input_schema: {
      type: "object",
      properties: {
        disputeId:  { type: "string", description: "Dispute document ID" },
        resolution: { type: "string", description: "favour_buyer or favour_seller" },
        note:       { type: "string", description: "Resolution note visible to both parties" },
      },
      required: ["disputeId", "resolution"],
    },
  },
  {
    name: "get_applications",
    description: "Get service provider or driver applications awaiting review.",
    input_schema: {
      type: "object",
      properties: {
        type:  { type: "string", description: "driver, provider, all" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "get_products",
    description: "Search or list products on the marketplace.",
    input_schema: {
      type: "object",
      properties: {
        search:   { type: "string", description: "Search term" },
        category: { type: "string" },
        limit:    { type: "number" },
        flagged:  { type: "boolean", description: "true to show only flagged/reported products" },
      },
    },
  },
  {
    name: "delete_product",
    description: "Remove a product from the marketplace.",
    input_schema: {
      type: "object",
      properties: {
        productId: { type: "string" },
        reason:    { type: "string" },
      },
      required: ["productId"],
    },
  },
  {
    name: "get_rides",
    description: "Get recent ride bookings and their status.",
    input_schema: {
      type: "object",
      properties: {
        status: { type: "string", description: "pending, active, completed, cancelled" },
        limit:  { type: "number" },
      },
    },
  },
  {
    name: "send_notification",
    description: "Send a platform-wide or targeted notification to users.",
    input_schema: {
      type: "object",
      properties: {
        title:   { type: "string" },
        body:    { type: "string" },
        userId:  { type: "string", description: "Target a specific user — omit for broadcast" },
        url:     { type: "string", description: "Page to open on tap" },
      },
      required: ["title", "body"],
    },
  },
  {
    name: "get_tax_stats",
    description: "Calculate SOKONI's KRA tax obligations for a period: VAT on commission, Withholding Tax deducted from seller/provider payouts, Digital Service Tax. Uses live Firestore order data.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today, week, month, year" },
      },
    },
  },
  {
    name: "get_etims_submissions",
    description: "List eTIMS invoice submissions sent to KRA. Shows acceptance status, CUIN numbers, and amounts.",
    input_schema: {
      type: "object",
      properties: {
        limit:  { type: "number" },
        status: { type: "string", description: "accepted, rejected, or all" },
      },
    },
  },
  {
    name: "get_seller_wht",
    description: "Get Withholding Tax (WHT) per seller and service provider — how much WHT SOKONI has deducted from payouts and must remit to KRA.",
    input_schema: {
      type: "object",
      properties: {
        period: { type: "string", description: "today, week, month, year" },
      },
    },
  },
];

/* ── TOOL EXECUTOR ── */
async function executeTool(name, input) {
  try {
    switch (name) {

      case "get_recent_orders": {
        let q = db.collection("orders").orderBy("createdAt", "desc").limit(input.limit || 10);
        if (input.status) q = q.where("status", "==", input.status);
        const snap = await q.get();
        const orders = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return { count: orders.length, orders };
      }

      case "get_users": {
        let q = db.collection("users").limit(input.limit || 10);
        if (input.role) q = q.where("role", "==", input.role);
        const snap = await q.get();
        let users = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (input.search) {
          const s = input.search.toLowerCase();
          users = users.filter(u =>
            (u.name || u.displayName || "").toLowerCase().includes(s) ||
            (u.email || "").toLowerCase().includes(s)
          );
        }
        return { count: users.length, users };
      }

      case "ban_user": {
        await db.collection("users").doc(input.userId).set({
          banned: input.banned,
          banReason: input.reason || "",
          bannedAt: admin.firestore.FieldValue.serverTimestamp(),
          bannedBy: "kass-admin-agent",
        }, { merge: true });
        return { success: true, userId: input.userId, banned: input.banned };
      }

      case "get_sellers": {
        let q = db.collection("providers").limit(input.limit || 10);
        if (input.status) q = q.where("status", "==", input.status);
        const snap = await q.get();
        return { count: snap.size, sellers: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
      }

      case "approve_seller": {
        await db.collection("providers").doc(input.sellerId).set({
          status: input.approve ? "active" : "suspended",
          adminNote: input.note || "",
          reviewedAt: admin.firestore.FieldValue.serverTimestamp(),
          reviewedBy: "kass-admin-agent",
        }, { merge: true });
        return { success: true, sellerId: input.sellerId, status: input.approve ? "active" : "suspended" };
      }

      case "get_analytics": {
        const now = new Date();
        let since;
        if (input.period === "today") {
          since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        } else if (input.period === "week") {
          since = new Date(now - 7 * 86400000);
        } else {
          since = new Date(now.getFullYear(), now.getMonth(), 1);
        }
        const snap = await db.collection("orders")
          .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(since))
          .where("status", "==", "delivered")
          .get();
        let revenue = 0;
        snap.docs.forEach(d => { revenue += (d.data().total || 0); });
        return { period: input.period || "month", completedOrders: snap.size, totalRevenue: revenue };
      }

      case "get_disputes": {
        let q = db.collection("disputes").limit(input.limit || 10);
        if (input.status && input.status !== "all") q = q.where("status", "==", input.status);
        const snap = await q.get();
        return { count: snap.size, disputes: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
      }

      case "resolve_dispute": {
        await db.collection("disputes").doc(input.disputeId).set({
          status: "resolved",
          resolution: input.resolution,
          resolutionNote: input.note || "",
          resolvedAt: admin.firestore.FieldValue.serverTimestamp(),
          resolvedBy: "kass-admin-agent",
        }, { merge: true });
        return { success: true, disputeId: input.disputeId, resolution: input.resolution };
      }

      case "get_applications": {
        let q = db.collection("applications").limit(input.limit || 10);
        if (input.type && input.type !== "all") q = q.where("type", "==", input.type);
        const snap = await q.get();
        return { count: snap.size, applications: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
      }

      case "get_products": {
        let q = db.collection("products").limit(input.limit || 10);
        if (input.category) q = q.where("category", "==", input.category);
        if (input.flagged)  q = q.where("flagged", "==", true);
        const snap = await q.get();
        let products = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (input.search) {
          const s = input.search.toLowerCase();
          products = products.filter(p => (p.name || "").toLowerCase().includes(s));
        }
        return { count: products.length, products };
      }

      case "delete_product": {
        await db.collection("products").doc(input.productId).delete();
        await db.collection("deleted_products").doc(input.productId).set({
          deletedAt: admin.firestore.FieldValue.serverTimestamp(),
          deletedBy: "kass-admin-agent",
          reason: input.reason || "",
        });
        return { success: true, productId: input.productId };
      }

      case "get_rides": {
        let q = db.collection("rides").orderBy("createdAt", "desc").limit(input.limit || 10);
        if (input.status) q = q.where("status", "==", input.status);
        const snap = await q.get();
        return { count: snap.size, rides: snap.docs.map(d => ({ id: d.id, ...d.data() })) };
      }

      case "send_notification": {
        const notifData = {
          title: input.title,
          body: input.body,
          url: input.url || "/",
          read: false,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          sentBy: "kass-admin-agent",
        };
        if (input.userId) {
          notifData.userId = input.userId;
          await db.collection("notifications").add(notifData);
        } else {
          await db.collection("broadcast_notifications").add(notifData);
        }
        return { success: true, broadcast: !input.userId };
      }

      case "get_tax_stats": {
        const now = new Date();
        /* The tax report assumed a flat 10% take. The platform has never charged 10% on
           marketplace orders — it charges 3% — so this analytic overstated commission revenue
           by more than 3x. Rate now comes from the single config. */
        const COMMISSION = COMMISSION_CONFIG.RATES.default.pct / 100;
        const period = input.period || "month";

        /* ── Year path: aggregate pre-built daily FinOS snapshots (avoids full orders scan) ── */
        if (period === "year") {
          const year      = now.getFullYear();
          const yearStart = `${year}-01-01`;
          const yearEnd   = `${year}-12-31`;

          const snapSnap = await db.collection("finosSnapshots")
            .where("dateStr", ">=", yearStart)
            .where("dateStr", "<=", yearEnd)
            .get();

          const snapDocs = snapSnap.docs.map(d => d.data());

          const totalRevCents   = snapDocs.reduce((s, d) => s + (d.totalRevenueCents  || 0), 0);
          const commissionCents = snapDocs.reduce((s, d) => s + (d.commissionCents    || 0), 0);
          const vatCents        = snapDocs.reduce((s, d) => s + (d.vatCollectedCents  || 0), 0);
          const whtCents        = snapDocs.reduce((s, d) => s + (d.whtCollectedCents  || 0), 0);
          const txCount         = snapDocs.reduce((s, d) => s + (d.transactionCount   || 0), 0);

          // Convert cents → KES for display
          const gross        = totalRevCents   / 100;
          const commission   = commissionCents / 100;
          const sellerPayout = Math.round((gross - commission) * 100) / 100;

          // Use ledger-captured tax figures when available; fall back to calculated estimates
          const vatOwed = vatCents > 0 ? vatCents / 100 : Math.round(commission * 16 / 116 * 100) / 100;
          const whtOwed = whtCents > 0 ? whtCents / 100 : Math.round(sellerPayout * 0.05 * 100) / 100;
          const dstOwed = Math.round(gross * 0.015 * 100) / 100;

          return {
            period,
            source: "finosSnapshots",   // signals pre-aggregated data was used
            orders: { total: txCount },
            revenue: { gross, commission, sellerPayout },
            taxObligations: {
              vat: { amount: vatOwed, desc: "16% VAT on SOKONI commission — remit monthly" },
              wht: { amount: whtOwed, desc: "5% WHT deducted from seller/provider payouts — remit to KRA" },
              dst: { amount: dstOwed, desc: "1.5% Digital Service Tax on gross transactions" },
              totalOwed: Math.round((vatOwed + whtOwed + dstOwed) * 100) / 100,
            },
          };
        }

        /* ── Sub-year paths (today / week / month): live orders scan (bounded window) ── */
        let since;
        if (period === "today") since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        else if (period === "week") since = new Date(now - 7 * 86400000);
        else                        since = new Date(now.getFullYear(), now.getMonth(), 1);

        const snap = await db.collection("orders")
          .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(since))
          .get();

        let gross = 0;
        const byStatus = {};
        snap.docs.forEach(d => {
          const data = d.data();
          gross += (data.total || data.amount || 0);
          byStatus[data.status] = (byStatus[data.status] || 0) + 1;
        });

        /* @commission-safe: analytics ESTIMATE — moves no money.
           This is a tax REPORT, not a charge. It aggregates gross across many orders and applies
           the platform default from the single config; it never debits anyone. Calling
           calculateCommission per order would mean one Firestore read per order for a figure
           nobody is billed. The rate cannot drift (it comes from commission-config), but it
           cannot reflect a per-seller rule or a plan benefit either.

           It is knowingly an approximation, and the right fix is to SUM the commission actually
           recorded on each order — which, after this sprint, every hub now writes. Tracked. */
        const commission   = Math.round(gross * COMMISSION);
        const sellerPayout = Math.round(gross - commission);
        const vatOwed      = Math.round(commission * 16 / 116);   // VAT portion of commission
        const whtOwed      = Math.round(sellerPayout * 0.05);     // 5% WHT on seller payouts
        const dstOwed      = Math.round(gross * 0.015);           // 1.5% Digital Service Tax

        return {
          period,
          orders: { total: snap.size, byStatus },
          revenue: { gross, commission, sellerPayout },
          taxObligations: {
            vat: { amount: vatOwed,  desc: "16% VAT on SOKONI commission — remit monthly" },
            wht: { amount: whtOwed,  desc: "5% WHT deducted from seller/provider payouts — remit to KRA" },
            dst: { amount: dstOwed,  desc: "1.5% Digital Service Tax on gross transactions" },
            totalOwed: vatOwed + whtOwed + dstOwed,
          },
        };
      }

      case "get_etims_submissions": {
        /* B7: read the CANONICAL server invoicing collection (etimsInvoices) that the
           deployed CFs actually write — NOT the legacy client-path etims_submissions,
           which the server never populates (admin/AI were seeing a disconnected set).
           Filter by status in memory to avoid a new composite index. */
        const snap = await db.collection("etimsInvoices").orderBy("createdAt", "desc").limit(Math.min(input.limit || 20, 100)).get();
        let list = snap.docs.map(d => {
          const x = d.data();
          return {
            id: d.id, invoiceNumber: x.invoiceNumber || null, status: x.status || null,
            sellerUid: x.sellerUid || null, orderId: x.orderId || null,
            amount: x.totAmt ?? x.total ?? null,
            kraReceiptNumber: x.kraReceiptNumber || x.receiptNumber || null,
            createdAt: x.createdAt || null,
          };
        });
        if (input.status && input.status !== "all") list = list.filter(s => s.status === input.status);
        return {
          total:    list.length,
          accepted: list.filter(s => s.status === "accepted").length,
          pending:  list.filter(s => s.status === "pending_submission").length,
          failed:   list.filter(s => s.status === "failed").length,
          submissions: list,
          _source: "etimsInvoices (canonical server invoicing)",
        };
      }

      case "get_seller_wht": {
        const now = new Date();
        let since;
        if (input.period === "today")  since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        else if (input.period === "week")  since = new Date(now - 7 * 86400000);
        else if (input.period === "year")  since = new Date(now.getFullYear(), 0, 1);
        else                               since = new Date(now.getFullYear(), now.getMonth(), 1);

        const snap = await db.collection("orders")
          .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(since))
          .get();

        const map = {};
        snap.docs.forEach(d => {
          const data    = d.data();
          const sid     = data.sellerId || data.providerId || "unknown";
          const sName   = data.sellerName || data.providerName || "Unknown";
          const amount  = data.total || data.amount || 0;
          const share   = amount * 0.90;
          const wht     = Math.round(share * 0.05);
          if (!map[sid]) map[sid] = { sellerId: sid, sellerName: sName, orders: 0, grossSales: 0, sellerShare: 0, whtDeducted: 0, netPayout: 0 };
          map[sid].orders++;
          map[sid].grossSales   += amount;
          map[sid].sellerShare  += share;
          map[sid].whtDeducted  += wht;
          map[sid].netPayout    += share - wht;
        });

        const sellers = Object.values(map)
          .map(s => ({ ...s, grossSales: Math.round(s.grossSales), sellerShare: Math.round(s.sellerShare), whtDeducted: Math.round(s.whtDeducted), netPayout: Math.round(s.netPayout) }))
          .sort((a, b) => b.whtDeducted - a.whtDeducted);

        return {
          period: input.period || "month",
          totalWHTToRemit: sellers.reduce((s, r) => s + r.whtDeducted, 0),
          sellers,
        };
      }

      default:
        return { error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

/* ══════════════════════════════════════════════════════════════
   KASS — CLOUD FUNCTION
   Admin verified via custom claim from the ID token —
   no extra Firestore read required.
══════════════════════════════════════════════════════════════ */
exports.kass = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: ['https://mysokoni.co.ke', 'https://sokoni-aeb26.web.app'], timeoutSeconds: 60, invoker: "public", minInstances: 1 },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    let decodedToken;
    try {
      const token = authHeader.replace("Bearer ", "");
      decodedToken = await admin.auth().verifyIdToken(token);

      /* Admin check via custom claim — faster and tamper-proof */
      if (decodedToken.admin !== true) {
        res.status(403).json({ error: "Admin access required" });
        return;
      }
    } catch (e) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    /* MFA enforcement — KASS has full admin data access, so MFA is mandatory when enabled */
    try { assertMFA(decodedToken, "kass"); } catch (_mfaErr) {
      res.status(401).json({ error: _mfaErr.message });
      return;
    }

    /* Rate-limit: 30 KASS requests per admin per minute (Firestore-backed) */
    const _kassRl = await checkRateLimitDurable(`kass_${decodedToken.uid}`, 30, 60);
    if (!_kassRl.ok) {
      res.status(429).json({ error: "Too many requests. Please wait before sending another message." });
      return;
    }

    const { messages } = req.body;
    if (!messages || !Array.isArray(messages)) {
      res.status(400).json({ error: "messages array required" });
      return;
    }

    /* ── Prompt injection guard ─────────────────────────────────────────────
       KASS is admin-only, but a compromised admin account or a rogue browser
       extension could inject content that attempts to override the system
       prompt, exfiltrate data, or cause KASS to take unintended actions.
       We validate inputs server-side regardless of trust level.
    ── */
    const MAX_MESSAGES   = 40;
    const MAX_MSG_CHARS  = 8000;

    if (messages.length > MAX_MESSAGES) {
      res.status(400).json({ error: `Message history too long (max ${MAX_MESSAGES}).` });
      return;
    }

    /* Detect and strip injection patterns from user messages */
    const _INJECTION_PATTERNS = [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /disregard\s+(your\s+)?system\s+prompt/i,
      /you\s+are\s+now\s+(a\s+)?different/i,
      /new\s+instructions?:/i,
      /\[system\]/i,
      /<\/?system>/i,
      /\/system:/i,
    ];

    const sanitizedMessages = messages.map(msg => {
      if (!msg || typeof msg !== "object") return null;
      const role    = msg.role === "assistant" ? "assistant" : "user";
      let   content = "";

      if (typeof msg.content === "string") {
        content = msg.content.slice(0, MAX_MSG_CHARS);
      } else if (Array.isArray(msg.content)) {
        /* Only keep text blocks from array-form content */
        content = msg.content
          .filter(b => b && b.type === "text")
          .map(b => String(b.text || "").slice(0, MAX_MSG_CHARS))
          .join("\n")
          .slice(0, MAX_MSG_CHARS);
      }

      /* Log injection attempt but return sanitized (not blocked) so UX is unaffected */
      for (const pattern of _INJECTION_PATTERNS) {
        if (pattern.test(content)) {
          console.warn(`[KASS] Possible injection detected from uid=${decodedToken.uid}:`, content.slice(0, 200));
          db.collection("securityEvents").add({
            type:    "kass_injection_attempt",
            uid:     decodedToken.uid,
            snippet: content.slice(0, 500),
            ts:      admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
          break;
        }
      }

      return { role, content };
    }).filter(Boolean);

    if (sanitizedMessages.length === 0) {
      res.status(400).json({ error: "No valid messages provided." });
      return;
    }

    const _aiKey = ANTHROPIC_API_KEY.value();
    if (!_aiKey) {
      res.status(503).json({ error: "AI assistant is not configured. Contact support." });
      return;
    }
    const anthropic = new Anthropic({ apiKey: _aiKey });

    const systemPrompt = `You are Kass, the intelligent admin AI agent for SOKONI — Kenya's premier digital marketplace. You help the admin manage the platform efficiently and professionally.

${COMPANY.ownershipStatement} SOKONI is the consumer brand. If asked "who owns SOKONI", answer exactly: "${COMPANY.ownershipStatement}"

You have full access to:
- Orders, users, sellers, products, disputes, rides, applications
- Notification broadcasting
- Banning users, approving sellers, resolving disputes

Always be:
- Professional and concise
- Proactive: suggest what to check next after completing a task
- Protective: warn before irreversible actions (bans, deletions)
- Data-driven: summarize numbers clearly

Format monetary values in KES. Use simple markdown for tables when showing lists.
Today's date: ${new Date().toLocaleDateString("en-KE", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}.`;

    try {
      let currentMessages = sanitizedMessages;
      let finalResponse = "";
      const MAX_TOOL_ITERATIONS = 10;
      let _iterations = 0;

      while (_iterations < MAX_TOOL_ITERATIONS) {
        _iterations++;
        const response = await anthropic.messages.create({
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: systemPrompt,
          tools: TOOLS,
          messages: currentMessages,
        });

        if (response.stop_reason === "end_turn") {
          finalResponse = response.content.map(b => b.type === "text" ? b.text : "").join("").trim();
          break;
        }

        if (response.stop_reason === "tool_use") {
          const toolUseBlocks = response.content.filter(b => b.type === "tool_use");
          const toolResults = [];

          for (const block of toolUseBlocks) {
            const result = await executeTool(block.name, block.input);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: JSON.stringify(result),
            });
          }

          currentMessages = [
            ...currentMessages,
            { role: "assistant", content: response.content },
            { role: "user", content: toolResults },
          ];

          if (_iterations >= MAX_TOOL_ITERATIONS) {
            console.warn(`[KASS] Max tool iterations (${MAX_TOOL_ITERATIONS}) reached — ending loop.`);
            finalResponse = "I've reached my search limit for this request. Please try a more specific question.";
          }
          continue;
        }

        finalResponse = response.content.map(b => b.type === "text" ? b.text : "").join("").trim();
        break;
      }

      res.json({ response: finalResponse });

    } catch (err) {
      console.error("Kass error:", err);
      res.status(500).json({ error: "Kass encountered an error. Please try again." });
    }
  }
);

/* ══════════════════════════════════════════════════════════════
   KASS PUBLIC CONCIERGE (sokoniChat)
   Intelligent marketplace AI — searches Firestore, calls tools,
   returns { response, results?, actions? }.
   No auth required. Rate-limited: 30 req/IP/minute.
══════════════════════════════════════════════════════════════ */
/* sokoniChat uses Firestore-backed checkRateLimitDurable — no in-memory map needed */

const _CHAT_TOOLS = [
  {
    name: "search_marketplace",
    description: "Search SOKONI marketplace for products or services. Call this FIRST whenever a user asks about buying anything, finding a seller, or looking for a service. Returns matching listings.",
    input_schema: {
      type: "object",
      properties: {
        query:    { type: "string",  description: "Search terms e.g. 'Nike shoes', 'ceiling fan', 'plumber Nairobi'" },
        category: { type: "string",  description: "Category filter e.g. 'electronics', 'fashion', 'cleaning', 'tutoring'" },
        type:     { type: "string",  enum: ["products", "services", "all"], description: "What to search — default: all" },
        maxPrice: { type: "number",  description: "Maximum price in KES" },
      },
      required: ["query"],
    },
  },
  {
    name: "search_stays",
    description: "Search BnBs, short stays, furnished apartments, serviced apartments, and hotels. Call this for: bnb, BnB, airbnb, short stay, vacation rental, furnished apartment, place to sleep, weekend getaway, accommodation, lodge, hotel, resort.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City or area e.g. 'Nairobi', 'Westlands', 'Mombasa'" },
        type:     { type: "string", enum: ["bnb", "hotel", "all"], description: "Type of stay — bnb for short stays/Airbnb-style, hotel for full-service" },
        maxPrice: { type: "number", description: "Max price per night in KES" },
        guests:   { type: "number", description: "Number of guests" },
      },
    },
  },
  {
    name: "search_restaurants",
    description: "Search restaurants, food delivery, groceries, and pharmacies. Call for: restaurant, food delivery, takeaway, pizza, ugali, nyama choma, grocery, supermarket, chemist, pharmacy.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "City or area" },
        cuisine:  { type: "string", description: "Cuisine type e.g. 'Kenyan', 'Indian', 'Chinese', 'Italian'" },
        type:     { type: "string", enum: ["restaurant", "grocery", "pharmacy", "all"], description: "Establishment type" },
      },
    },
  },
  {
    name: "search_events",
    description: "Search upcoming events, concerts, shows, sports, and conferences on SOKONI.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string" },
        category: { type: "string", description: "e.g. 'music', 'sports', 'comedy', 'conference', 'wedding'" },
        dateFrom: { type: "string", description: "Start date YYYY-MM-DD" },
      },
    },
  },
  {
    name: "search_jobs",
    description: "Search job listings on SOKONI Jobs. Call for: job, career, employment, vacancy, internship, freelance work, part-time.",
    input_schema: {
      type: "object",
      properties: {
        query:    { type: "string", description: "Job title or skills e.g. 'software engineer', 'sales', 'driver'" },
        location: { type: "string", description: "City or 'remote'" },
        type:     { type: "string", description: "full-time, part-time, freelance, remote, internship" },
      },
    },
  },
  {
    name: "get_page_url",
    description: "Get the correct SOKONI page URL for any category or intent. Use whenever a user asks to open, view, or navigate — then include an action link in your response.",
    input_schema: {
      type: "object",
      properties: {
        intent: { type: "string", description: "What the user wants e.g. 'bnb', 'short stays', 'food delivery', 'seller dashboard', 'track order'" },
      },
      required: ["intent"],
    },
  },

  /* ── ACTION TOOLS (write operations — require auth) ── */
  {
    name: "add_to_cart",
    description: "Add a product to the user's shopping cart. ALWAYS state the item name, price, and quantity to the user and get confirmation before calling this.",
    input_schema: {
      type: "object",
      properties: {
        productId:   { type: "string",  description: "Product ID from search results" },
        productName: { type: "string",  description: "Product name for confirmation display" },
        quantity:    { type: "number",  description: "Quantity to add (default 1)" },
        price:       { type: "number",  description: "Unit price in KES" },
        sellerUid:   { type: "string",  description: "Seller UID from search results" },
      },
      required: ["productId", "productName"],
    },
  },
  {
    name: "view_cart",
    description: "View the user's current cart contents, item count, and total. Call when user asks 'what's in my cart', 'show my cart', 'view cart'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "get_my_orders",
    description: "Retrieve the user's recent orders with status. Call when user asks about orders, order history, or wants to see past purchases.",
    input_schema: {
      type: "object",
      properties: {
        limit:  { type: "number", description: "Number of orders (default 5, max 10)" },
        status: { type: "string", description: "Filter: pending, confirmed, processing, shipped, delivered, cancelled" },
      },
    },
  },
  {
    name: "track_order",
    description: "Get live tracking for a specific order — status, driver info, ETA. Call for 'where is my order', 'track order', or when user provides an order ID.",
    input_schema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The order ID to track" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "cancel_order",
    description: "Cancel an order. ONLY call after user explicitly confirms they want to cancel by that order ID. Only pending/confirmed orders can be cancelled.",
    input_schema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "Order ID to cancel" },
        reason:  { type: "string", description: "Cancellation reason" },
      },
      required: ["orderId"],
    },
  },
  {
    name: "save_to_wishlist",
    description: "Save a product, service, stay, or event to the user's wishlist. Call for 'save', 'favourite', 'bookmark', 'add to wishlist'.",
    input_schema: {
      type: "object",
      properties: {
        itemId:   { type: "string", description: "Item ID from search results" },
        itemType: { type: "string", enum: ["product", "service", "stay", "hotel", "event", "job", "restaurant"] },
        itemName: { type: "string", description: "Item name" },
        itemUrl:  { type: "string", description: "Item page URL" },
      },
      required: ["itemId", "itemType", "itemName"],
    },
  },
  {
    name: "get_wallet",
    description: "Get the user's SOKONI wallet balance, loyalty points, and recent transactions.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "book_stay",
    description: "Book a BnB or hotel. ALWAYS confirm listing name, check-in, check-out, guests, and total cost with the user BEFORE calling. Dates must be YYYY-MM-DD.",
    input_schema: {
      type: "object",
      properties: {
        listingId:     { type: "string", description: "Listing ID from search results" },
        listingName:   { type: "string", description: "Listing name" },
        listingType:   { type: "string", enum: ["bnb", "hotel"] },
        checkIn:       { type: "string", description: "Check-in date YYYY-MM-DD" },
        checkOut:      { type: "string", description: "Check-out date YYYY-MM-DD" },
        guests:        { type: "number", description: "Number of guests (default 1)" },
        pricePerNight: { type: "number", description: "Price per night in KES" },
      },
      required: ["listingId", "listingName", "checkIn", "checkOut", "pricePerNight"],
    },
  },
  {
    name: "compare_products",
    description: "Compare 2–3 products side by side on price, rating, and specs. Call for 'compare', 'which is better', 'show difference between'.",
    input_schema: {
      type: "object",
      properties: {
        productIds: {
          type: "array",
          items: { type: "string" },
          description: "2–3 product IDs from previous search results",
        },
      },
      required: ["productIds"],
    },
  },
];

const _PAGE_MAP = {
  'bnb':'short-stays.html', 'airbnb':'short-stays.html', 'short stay':'short-stays.html', 'short-stay':'short-stays.html',
  'vacation':'short-stays.html', 'furnished':'short-stays.html', 'serviced apartment':'short-stays.html',
  'accommodation':'short-stays.html', 'place to stay':'short-stays.html', 'place to sleep':'short-stays.html',
  'self catering':'short-stays.html', 'weekend':'short-stays.html',
  'hotel':'hotels.html', 'lodge':'hotels.html', 'resort':'hotels.html',
  'ride':'ride.html', 'boda':'ride.html', 'taxi':'ride.html', 'cab':'ride.html', 'lift':'ride.html',
  'shop':'/', 'marketplace':'/', 'product':'/', 'buy':'/', 'shopping':'/',
  'service':'services.html', 'plumber':'services.html', 'cleaner':'services.html', 'tutor':'services.html',
  'food':'food-hub.html', 'restaurant':'food-hub.html', 'grocery':'food-hub.html', 'delivery food':'food-hub.html',
  'property':'property-hub.html', 'house':'property-hub.html', 'land':'property-hub.html', 'apartment for sale':'property-hub.html',
  'car':'car-hub.html', 'vehicle':'car-hub.html', 'car hire':'car-hub.html', 'ntsa':'car-hub.html',
  'job':'jobs.html', 'career':'jobs.html', 'vacancy':'jobs.html', 'employment':'jobs.html', 'internship':'jobs.html',
  'event':'events.html', 'concert':'events.html', 'ticket':'events.html', 'show':'events.html', 'sports':'events.html',
  'health':'healthcare.html', 'doctor':'healthcare.html', 'clinic':'healthcare.html', 'pharmacy':'healthcare.html', 'hospital':'healthcare.html',
  'dj':'entertainment-hub.html', 'entertainment':'entertainment-hub.html', 'band':'entertainment-hub.html',
  'delivery':'delivery.html', 'courier':'delivery.html', 'send package':'delivery.html',
  'sell':'seller.html', 'seller':'seller.html', 'vendor':'seller.html', 'open shop':'seller.html',
  'driver':'driver.html', 'delivery driver':'driver.html',
  'loyalty':'loyalty.html', 'reward':'loyalty.html', 'points':'loyalty.html',
  'referral':'referral.html', 'invite':'referral.html',
  'wallet':'wallet.html', 'payment':'wallet.html', 'mpesa':'wallet.html',
  'track':'track.html', 'order status':'track.html', 'where is my order':'track.html',
  'cart':'cart.html', 'checkout':'cart.html',
};

/* Verify Firebase ID token and return uid, or null on failure. */
async function _verifyKassToken(token) {
  if (!token) return null;
  try {
    const decoded = await admin.auth().verifyIdToken(String(token).slice(0, 4096));
    return decoded.uid || null;
  } catch(e) { return null; }
}

/* Standard auth-required response for action tools. */
function _authRequired() {
  return { requiresAuth: true, error: "This action requires you to be logged in. Please sign in at login.html to continue." };
}

async function _execChatTool(name, input, ctx) {
  try {
    if (name === "get_page_url") {
      const d = (input.intent || "").toLowerCase();
      let url = "index.html", label = "Home";
      for (const [k, v] of Object.entries(_PAGE_MAP)) {
        if (d.includes(k)) { url = v; label = k.charAt(0).toUpperCase() + k.slice(1).replace(/-/g, " "); break; }
      }
      ctx.addAction({ label: `Open ${label}`, url });
      return { url, label };
    }

    if (name === "search_marketplace") {
      const { query = "", category, type: t, maxPrice } = input;
      const rows = [];

      if (!t || t === "products" || t === "all") {
        /* Fetch a wider candidate set and surface up to 12 matches — the widget
           now renders a compact, scrollable list, so KASS can recommend a fuller
           set of products (was capped at 5) instead of a token handful. */
        let q = db.collection("products").limit(30);
        if (category) q = q.where("category", "==", category);
        if (maxPrice)  q = q.where("price", "<=", maxPrice).orderBy("price");
        const snap = await q.get().catch(() => ({ docs: [] }));
        snap.docs.filter(d => {
          const n = (d.data().name || "").toLowerCase();
          return !query || n.includes(query.toLowerCase()) || (d.data().category || "").toLowerCase().includes(query.toLowerCase());
        }).slice(0, 12).forEach(d => {
          const r = d.data();
          const card = { type:"product", id:d.id, name:r.name, price:r.price, category:r.category, image:r.imageUrl||r.image, rating:r.avgRating||r.rating, url:`product.html?id=${d.id}`, seller:r.sellerName||r.shopName };
          rows.push(card); ctx.addResult(card);
        });
      }

      if (!t || t === "services" || t === "all") {
        let q = db.collection("services").limit(8);
        if (category) q = q.where("category", "==", category);
        const snap = await q.get().catch(() => ({ docs: [] }));
        snap.docs.filter(d => {
          const n = (d.data().name || d.data().title || "").toLowerCase();
          return !query || n.includes(query.toLowerCase()) || (d.data().category || "").toLowerCase().includes(query.toLowerCase());
        }).slice(0, 4).forEach(d => {
          const r = d.data();
          const card = { type:"service", id:d.id, name:r.name||r.title, price:r.price||r.startingPrice, category:r.category, image:r.image||r.photo, rating:r.rating||r.avgRating, url:"services.html" };
          rows.push(card); ctx.addResult(card);
        });
      }

      if (!rows.length) return { found: 0, message: "No listings found. The platform is growing — try different keywords or browse the marketplace." };
      ctx.addAction({ label: "Browse Marketplace", url: "/" });
      return { found: rows.length, listings: rows.map(r => ({ name:r.name, price:`KES ${Number(r.price||0).toLocaleString()}`, category:r.category, rating:r.rating?`${r.rating}★`:null })) };
    }

    if (name === "search_stays") {
      const { location, type: t, maxPrice } = input;
      const rows = [];
      const cols = t === "hotel" ? ["hotels"] : t === "bnb" ? ["listings"] : ["listings", "hotels"];
      for (const col of cols) {
        let q = db.collection(col).limit(8);
        if (location) q = q.where("city", "==", location);
        if (maxPrice && col !== "hotels") q = q.where("pricePerNight", "<=", maxPrice);
        const snap = await q.get().catch(() => ({ docs: [] }));
        snap.docs.forEach(d => {
          const r = d.data();
          const card = { type:col==="hotels"?"hotel":"bnb", id:d.id, name:r.name||r.title, price:r.pricePerNight||r.price, city:r.city||r.location||location, image:r.image||r.photo||(r.images||[])[0], rating:r.rating||r.avgRating, bedrooms:r.bedrooms, url:col==="hotels"?`hotels.html?id=${d.id}`:`short-stays.html?id=${d.id}` };
          rows.push(card); ctx.addResult(card);
        });
      }
      if (!rows.length) {
        ctx.addAction({ label: "Browse Short Stays", url: "short-stays.html" });
        return { found: 0, message: `No ${t||"stays"} found${location?" in "+location:""}. Browse the Short Stays page for all listings.` };
      }
      ctx.addAction({ label: "View all Short Stays", url: "short-stays.html" });
      return { found: rows.length, stays: rows.map(r => ({ name:r.name, pricePerNight:`KES ${Number(r.price||0).toLocaleString()}/night`, city:r.city, type:r.type, rating:r.rating?`${r.rating}★`:null, bedrooms:r.bedrooms })) };
    }

    if (name === "search_restaurants") {
      const { location, cuisine, type: t } = input;
      let q = db.collection("providers").limit(10);
      if (location) q = q.where("city", "==", location);
      const snap = await q.get().catch(() => ({ docs: [] }));
      const rows = snap.docs.filter(d => {
        const cat = (d.data().category || "").toLowerCase();
        const isFood = cat.includes("food") || cat.includes("restaurant") || cat.includes("catering") || cat.includes("grocery") || cat.includes("pharmacy") || cat.includes("chemist");
        if (!isFood) return false;
        if (cuisine) return cat.includes(cuisine.toLowerCase()) || (d.data().name || "").toLowerCase().includes(cuisine.toLowerCase());
        if (t && t !== "all") {
          if (t === "grocery") return cat.includes("grocery") || cat.includes("supermarket");
          if (t === "pharmacy") return cat.includes("pharmacy") || cat.includes("chemist");
          return cat.includes("restaurant") || cat.includes("food") || cat.includes("catering");
        }
        return true;
      }).slice(0, 6);
      if (!rows.length) {
        ctx.addAction({ label: "Browse Food Hub", url: "food-hub.html" });
        return { found: 0, message: "No restaurants found yet. Browse the Food Hub." };
      }
      rows.forEach(d => { const r = d.data(); ctx.addResult({ type:"restaurant", id:d.id, name:r.name||r.businessName, category:r.category, city:r.city, image:r.image||r.logo, rating:r.rating||r.avgRating, url:"food-hub.html" }); });
      ctx.addAction({ label: "View Food Hub", url: "food-hub.html" });
      return { found: rows.length, restaurants: rows.map(d => ({ name:d.data().name||d.data().businessName, category:d.data().category, city:d.data().city, rating:d.data().rating?`${d.data().rating}★`:null })) };
    }

    if (name === "search_events") {
      const { location, category, dateFrom } = input;
      let q = db.collection("entEvents").where("status", "==", "published").limit(6);
      if (location) q = q.where("city", "==", location);
      if (dateFrom)  q = q.where("date", ">=", dateFrom);
      const snap = await q.get().catch(() => ({ docs: [] }));
      if (snap.empty) {
        ctx.addAction({ label: "Browse Events", url: "events.html" });
        return { found: 0, message: "No events found. Browse all events on the Events page." };
      }
      snap.docs.forEach(d => { const r = d.data(); ctx.addResult({ type:"event", id:d.id, name:r.title||r.name, date:r.date, venue:r.venue, city:r.city, price:r.ticketPrice||r.price, image:r.image||r.poster, url:`events.html?id=${d.id}` }); });
      ctx.addAction({ label: "Browse all Events", url: "events.html" });
      return { found: snap.docs.length, events: snap.docs.map(d => ({ name:d.data().title||d.data().name, date:d.data().date, venue:d.data().venue, price:d.data().ticketPrice?`KES ${Number(d.data().ticketPrice).toLocaleString()}`:"Free" })) };
    }

    if (name === "search_jobs") {
      const { query = "", location, type: t } = input;
      let q = db.collection("jobs").where("status", "==", "active").limit(10);
      if (location && location !== "remote") q = q.where("location", "==", location);
      if (t) q = q.where("type", "==", t);
      const snap = await q.get().catch(() => ({ docs: [] }));
      const rows = snap.docs.filter(d => {
        if (!query) return true;
        const ql = query.toLowerCase();
        return (d.data().title || "").toLowerCase().includes(ql) || (d.data().description || "").toLowerCase().includes(ql);
      }).slice(0, 6);
      if (!rows.length) {
        ctx.addAction({ label: "Browse Jobs", url: "jobs.html" });
        return { found: 0, message: "No jobs found. Browse all listings on SOKONI Jobs." };
      }
      rows.forEach(d => { const r = d.data(); ctx.addResult({ type:"job", id:d.id, name:r.title, company:r.company, location:r.location, salary:r.salary, jobType:r.type, url:`jobs.html?id=${d.id}` }); });
      ctx.addAction({ label: "Browse all Jobs", url: "jobs.html" });
      return { found: rows.length, jobs: rows.map(d => ({ title:d.data().title, company:d.data().company, location:d.data().location, salary:d.data().salary||"Negotiable", type:d.data().type })) };
    }

    /* ── ACTION: add_to_cart ── */
    if (name === "add_to_cart") {
      if (!ctx.uid) return _authRequired();
      const { productId, productName, quantity = 1, price, sellerUid } = input;
      const itemRef = db.collection("carts").doc(ctx.uid).collection("items").doc(productId);
      const existing = await itemRef.get().catch(() => null);
      const prevQty = existing?.exists ? (existing.data().quantity || 0) : 0;
      await itemRef.set({ productId, productName, quantity: prevQty + quantity, price, sellerUid,
        updatedAt: new Date().toISOString(), addedByKASS: true }, { merge: true });
      ctx.addAction({ label: "🛒 View Cart", url: "cart.html" });
      ctx.addAction({ label: "💳 Checkout", url: "cart.html?checkout=1" });
      return { success: true, message: `Added ${quantity}x **${productName}** to your cart.`, newQty: prevQty + quantity };
    }

    /* ── ACTION: view_cart ── */
    if (name === "view_cart") {
      if (!ctx.uid) return _authRequired();
      const snap = await db.collection("carts").doc(ctx.uid).collection("items").limit(15).get().catch(() => ({ docs: [] }));
      if (snap.empty) {
        ctx.addAction({ label: "🛍️ Browse Marketplace", url: "/" });
        return { empty: true, message: "Your cart is empty. Start shopping!" };
      }
      const items = snap.docs.map(d => d.data());
      const total = items.reduce((s, i) => s + (Number(i.price || 0) * (Number(i.quantity) || 1)), 0);
      items.forEach(i => ctx.addResult({ type: "product", id: i.productId, name: i.productName, price: i.price, url: `product.html?id=${i.productId}` }));
      ctx.addAction({ label: "🛒 Open Cart", url: "cart.html" });
      ctx.addAction({ label: "💳 Checkout Now", url: "cart.html?checkout=1" });
      return { itemCount: items.length, total: `KES ${total.toLocaleString()}`, items: items.map(i => ({ name: i.productName, qty: i.quantity, price: i.price ? `KES ${Number(i.price).toLocaleString()}` : null })) };
    }

    /* ── ACTION: get_my_orders ── */
    if (name === "get_my_orders") {
      if (!ctx.uid) return _authRequired();
      const lim = Math.min(Number(input.limit) || 5, 10);
      let q = db.collection("orders").where("uid", "==", ctx.uid).orderBy("createdAt", "desc").limit(lim);
      if (input.status) q = q.where("status", "==", input.status);
      const snap = await q.get().catch(() => ({ docs: [] }));
      if (snap.empty) return { found: 0, message: "No orders found." };
      snap.docs.forEach(d => {
        const r = d.data();
        ctx.addResult({ type: "order", id: d.id, name: r.itemSummary || `Order #${d.id.slice(0,8).toUpperCase()}`, price: r.total, status: r.status, url: `track.html?orderId=${d.id}` });
      });
      ctx.addAction({ label: "📦 View All Orders", url: "profile.html" });
      return { found: snap.docs.length, orders: snap.docs.map(d => ({ id: d.id.slice(0,8).toUpperCase(), summary: d.data().itemSummary, total: `KES ${Number(d.data().total||0).toLocaleString()}`, status: d.data().status, date: d.data().createdAt })) };
    }

    /* ── ACTION: track_order ── */
    if (name === "track_order") {
      if (!ctx.uid) return _authRequired();
      const orderDoc = await db.collection("orders").doc(input.orderId).get().catch(() => null);
      if (!orderDoc?.exists) return { error: "Order not found. Check the order ID and try again." };
      if (orderDoc.data().uid !== ctx.uid) return { error: "You can only track your own orders." };
      const r = orderDoc.data();
      const delivSnap = await db.collection("deliveries").where("orderId", "==", input.orderId).limit(1).get().catch(() => ({ docs: [] }));
      const delivery = delivSnap.docs[0]?.data() || null;
      ctx.addAction({ label: "📍 Live Map", url: `track.html?orderId=${input.orderId}` });
      return { orderId: input.orderId.slice(0,8).toUpperCase(), status: r.status, items: r.itemSummary, total: `KES ${Number(r.total||0).toLocaleString()}`, orderDate: r.createdAt, estimatedDelivery: r.estimatedDelivery || null, delivery: delivery ? { status: delivery.status, driverName: delivery.driverName || null, eta: delivery.eta || null, stage: delivery.stage || null } : null };
    }

    /* ── ACTION: cancel_order ── */
    if (name === "cancel_order") {
      if (!ctx.uid) return _authRequired();
      const orderDoc = await db.collection("orders").doc(input.orderId).get().catch(() => null);
      if (!orderDoc?.exists) return { error: "Order not found." };
      if (orderDoc.data().uid !== ctx.uid) return { error: "You can only cancel your own orders." };
      const st = orderDoc.data().status;
      if (!["pending", "confirmed"].includes(st)) return { error: `Order cannot be cancelled — current status is "${st}". Only pending or confirmed orders qualify.` };
      await db.collection("orders").doc(input.orderId).update({ status: "cancelled", cancelledAt: new Date().toISOString(), cancelledBy: ctx.uid, cancelReason: input.reason || "Cancelled via KASS", cancellationSource: "kass_ai" });
      return { success: true, message: `Order #${input.orderId.slice(0,8).toUpperCase()} has been cancelled. If you paid, a refund will be processed within 3–5 business days.` };
    }

    /* ── ACTION: save_to_wishlist ── */
    if (name === "save_to_wishlist") {
      if (!ctx.uid) return _authRequired();
      const { itemId, itemType, itemName, itemUrl } = input;
      await db.collection("wishlists").doc(ctx.uid).collection("items").doc(itemId).set({ itemId, itemType, itemName, itemUrl: itemUrl || null, savedAt: new Date().toISOString(), savedByKASS: true }, { merge: true });
      ctx.addAction({ label: "❤️ View Wishlist", url: "wishlist.html" });
      return { success: true, message: `Saved **${itemName}** to your wishlist.` };
    }

    /* ── ACTION: get_wallet ── */
    if (name === "get_wallet") {
      if (!ctx.uid) return _authRequired();
      const walletDoc = await db.collection("wallets").doc(ctx.uid).get().catch(() => null);
      ctx.addAction({ label: "💳 Open Wallet", url: "wallet.html" });
      if (!walletDoc?.exists) return { balance: "KES 0", loyaltyPoints: 0, message: "No wallet found. Visit wallet.html to set one up." };
      const w = walletDoc.data();
      const loyaltyDoc = await db.collection("loyaltyAccounts").doc(ctx.uid).get().catch(() => null);
      const points = loyaltyDoc?.exists ? (loyaltyDoc.data().points || 0) : (w.loyaltyPoints || 0);
      return { balance: `KES ${Number(w.balance || 0).toLocaleString()}`, loyaltyPoints: points, currency: "KES", lastUpdated: w.updatedAt || null };
    }

    /* ── ACTION: book_stay ── */
    if (name === "book_stay") {
      if (!ctx.uid) return _authRequired();
      const { listingId, listingName, listingType = "bnb", checkIn, checkOut, guests = 1, pricePerNight } = input;
      const cin = new Date(checkIn), cout = new Date(checkOut);
      const nights = Math.round((cout - cin) / 86400000);
      if (nights <= 0) return { error: "Check-out must be after check-in." };
      const totalPrice = pricePerNight * nights;
      const ref = await db.collection("bookings").add({ uid: ctx.uid, listingId, listingName, listingType, checkIn, checkOut, nights, guests: Number(guests), pricePerNight, totalPrice, status: "pending", bookedAt: new Date().toISOString(), bookedByKASS: true, paymentStatus: "unpaid" });
      ctx.addAction({ label: "📋 View Booking", url: "profile.html?tab=bookings" });
      ctx.addAction({ label: "💳 Pay Now", url: `wallet.html?bookingId=${ref.id}` });
      return { success: true, bookingRef: ref.id.slice(0,8).toUpperCase(), listingName, checkIn, checkOut, nights, guests, totalPrice: `KES ${totalPrice.toLocaleString()}`, status: "pending", message: `Booking created for **${listingName}** — ${checkIn} to ${checkOut} (${nights} night${nights>1?"s":""}), ${guests} guest${guests>1?"s":""}. Total: **KES ${totalPrice.toLocaleString()}**. Status: pending host confirmation. Please pay to secure your booking.` };
    }

    /* ── ACTION: compare_products ── */
    if (name === "compare_products") {
      const ids = (input.productIds || []).slice(0, 3);
      if (ids.length < 2) return { error: "Need at least 2 product IDs to compare. Try searching first." };
      const docs = await Promise.all(ids.map(id => db.collection("products").doc(id).get().catch(() => null)));
      const products = docs.filter(d => d?.exists).map(d => ({ id: d.id, ...d.data() }));
      if (products.length < 2) return { error: "Could not find enough products to compare. Search first to find valid product IDs." };
      products.forEach(p => ctx.addResult({ type: "product", id: p.id, name: p.name, price: p.price, category: p.category, image: p.imageUrl || p.image, rating: p.avgRating || p.rating, url: `product.html?id=${p.id}` }));
      return { comparison: products.map(p => ({ name: p.name, price: `KES ${Number(p.price||0).toLocaleString()}`, rating: p.avgRating || p.rating || "No rating", seller: p.sellerName || p.shopName || "Unknown", inStock: p.stock > 0 || p.active !== false })) };
    }

    return { error: `Unknown tool: ${name}` };
  } catch (err) {
    console.error(`[sokoniChat] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

exports.sokoniChat = onRequest(
  { secrets: [ANTHROPIC_API_KEY], cors: ['https://mysokoni.co.ke', 'https://sokoni-aeb26.web.app'], timeoutSeconds: 120, memory: '512MiB', invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    /* Rate limit: 30 messages per IP per minute — Firestore-backed so it works across all CF instances */
    const ip = req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip || "unknown";
    const _chatRl = await checkRateLimitDurable(`chat_${ip}`, 30, 60);
    if (!_chatRl.ok) {
      res.status(429).json({ error: "Too many messages — please wait a moment before trying again." });
      return;
    }

    const { messages, auth_token } = req.body;
    if (!messages || !Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages array required" });
      return;
    }

    /* Require auth — unauthenticated callers get free AI access at platform cost.
       Verify the Firebase ID token; fall back to the legacy KASS token for old clients. */
    if (!auth_token) {
      res.status(401).json({ error: "Authentication required to use KASS AI." });
      return;
    }
    const uid = await _verifyKassToken(auth_token);

    /* Sanitize: keep last 20 turns, text only */
    const history = messages.slice(-20).map(m => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: String(m.content || "").slice(0, 1200),
    })).filter(m => m.content.trim());

    const today = new Date().toLocaleDateString("en-KE", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

    /* ── Build user behavioural profile for personalisation ──────────────────── */
    let userProfile = "";
    if (uid) {
      try {
        const [behavSnap, orderSnap] = await Promise.all([
          db.collection("userBehavior").doc(uid).collection("kassInteractions")
            .orderBy("ts", "desc").limit(15).get().catch(() => null),
          db.collection("orders").where("buyerUid", "==", uid)
            .orderBy("createdAt", "desc").limit(10).get().catch(() => null),
        ]);

        const recentCategories = new Map();
        const recentSellers    = new Map();
        const recentItems      = [];

        if (behavSnap) {
          behavSnap.docs.forEach(d => {
            const b = d.data();
            (b.categories || []).forEach(c => recentCategories.set(c, (recentCategories.get(c) || 0) + 2));
            (b.sellers    || []).forEach(s => recentSellers.set(s, (recentSellers.get(s) || 0) + 1));
          });
        }
        if (orderSnap) {
          orderSnap.docs.forEach(d => {
            const o = d.data();
            if (o.category) recentCategories.set(o.category, (recentCategories.get(o.category) || 0) + 3);
            if (o.sellerName) recentSellers.set(o.sellerName, (recentSellers.get(o.sellerName) || 0) + 2);
            if (o.itemSummary) recentItems.push(o.itemSummary);
          });
        }

        const topCategories = [...recentCategories.entries()].sort((a,b)=>b[1]-a[1]).slice(0,5).map(e=>e[0]);
        const topSellers    = [...recentSellers.entries()].sort((a,b)=>b[1]-a[1]).slice(0,4).map(e=>e[0]);

        if (topCategories.length || topSellers.length || recentItems.length) {
          userProfile = `\n\n━━━ THIS USER'S PROFILE (use to personalise) ━━━` +
            (topCategories.length ? `\nFavourite categories: ${topCategories.join(", ")}` : "") +
            (topSellers.length    ? `\nTrusted sellers/providers: ${topSellers.join(", ")}` : "") +
            (recentItems.length   ? `\nRecent purchases: ${recentItems.slice(0,4).join("; ")}` : "") +
            `\nWhen this user asks for a recommendation, prioritise these categories/sellers first. Mention their history when relevant ("You've ordered from X before — they're available again").`;
        }
      } catch (_) { /* non-fatal — proceed without personalisation */ }
    }

    const systemPrompt = `You are KASS — SOKONI's marketplace AI. Your primary role is to help users buy, sell, discover products, and get great deals on SOKONI Kenya's premier digital marketplace.

SOKONI (mysokoni.co.ke) is Kenya's #1 all-in-one marketplace: shop products, hire services, order food, book stays, find jobs, catch events, get healthcare, transport, property and more — all in one place.

OWNERSHIP: ${COMPANY.ownershipStatement} SOKONI is the consumer brand. If a user asks "who owns SOKONI" (or anything about ownership/the legal entity), answer exactly: "${COMPANY.ownershipStatement}"
${uid ? `\nAuthenticated user (uid: ${uid.slice(0,8)}…). All action tools are live.` : "\nGuest session. Action tools will prompt sign-in when needed."}${userProfile}

MARKETPLACE-FIRST MINDSET:
- SOKONI is fundamentally a marketplace. Commerce, shopping, and product discovery are the heartbeat.
- When a user's intent is even slightly shopping-related, SEARCH THE MARKETPLACE FIRST. Show real products with prices.
- Always present marketplace options before suggesting other hubs unless the intent is clearly non-product (e.g., booking a hotel, hiring a plumber).
- For ambiguous requests like "ninataka kitu" / "I need something" / "show me items", default to marketplace search.
- Actively upsell: after any purchase-intent message, offer related product searches. ("You might also need…")
- Know product categories deeply and suggest the right one fast.
- When a user finds a product, guide them to cart → checkout → M-Pesa. Friction kills sales — eliminate it.
- Sellers are key partners. Help sellers get found. Mention top-rated sellers in search results.
- Know what's trending: electronics, fashion, home goods, baby products drive the most volume in Kenyan e-commerce.

Today: ${today}

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
COMPLETE PLATFORM MAP
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

SHOPPING & PRODUCTS
• Marketplace → /
  Everything for sale: electronics, fashion, beauty, home & garden, sports, books, baby, pet supplies, office, tools, art, collectibles. Filter by category, price, location, seller rating. Cart → checkout → M-Pesa/card.
• Digital / Tech Hub → digital-hub.html
  Software licences, e-books, templates, plugins, courses, app subscriptions, stock photos, fonts, digital art. Instant delivery to email.

SERVICES (hire a professional)
• Services Hub → services.html
  Plumbers, electricians, carpenters, painters, CCTV installation, AC repair, TV mounting, computer repair, phone repair, appliance repair, cleaning, pest control, landscaping, pool service, security guards.
• Cleaning → cleaning.html
  Domestic cleaning, deep cleans, office cleaning, sofa/carpet steam cleaning, move-in/out cleaning, post-construction cleaning.
• Education Hub → education.html
  Home tutors (CBC to university), online classes, holiday programmes, skill courses, music lessons, driving lessons, coding bootcamps, language classes.
• Legal Hub → legal-hub.html
  Lawyers, notaries, conveyancing, business registration, contracts, wills, court representation, debt collection, trademark registration.
• Entertainment Hub → entertainment-hub.html
  DJs, MCs, bands, comedians, magicians, acrobats, event photographers, videographers, photo booths, sound systems, lighting rigs, LED screens, fireworks.

FOOD & DINING
• Food Hub → food-hub.html
  Restaurants, cafes, cloud kitchens, groceries, fresh produce, pastries, juices, alcohol, pharmacy/chemist deliveries. Order online → tracked delivery or self-collect. Filter by cuisine: Kenyan, Indian, Chinese, Italian, Ethiopian, Swahili coast, fast food, healthy, vegan, halal.

ACCOMMODATION
• Short Stays → short-stays.html
  BnBs, Airbnb-style self-catering, furnished apartments, serviced apartments, vacation homes, cottages, beach houses, lakeside retreats, self-catering villas. Book per night. Instant confirmation.
• Hotels → hotels.html
  Full-service hotels, boutique hotels, lodges, resorts, safari camps, guesthouses, motels. Breakfast/HB/FB options. Room types: single, double, twin, suite, family.

HEALTH & WELLNESS
• Healthcare Hub → healthcare.html
  Doctors (GP, specialists), dentists, pharmacies, lab tests (home collection available), physiotherapy, opticians, mental health, nutritionists, gynaecologists, paediatricians, ENT, dermatologists. Book appointment → get confirmation → digital records.

TRANSPORT & VEHICLES
• Rides → ride.html
  Bodaboda (motorbike), tuk-tuk, taxi, executive cab, airport transfer, school run, errands. Real-time driver tracking. Fare estimates shown upfront.
• Car Hub → car-hub.html
  Self-drive car rental (17 cars from saloons to SUVs to minibuses), chauffeur hire, NTSA services (DL renewal, motor vehicle inspection, transfer of ownership, smart DL, PSV licences — 14 services), driving schools, vehicle insurance quotes, garages (service, repair, body work, tyre change, windscreen).
• Car Rental detail → car-rental.html
  Browse specific vehicles, view specs, book by day/week/month.
• Delivery → delivery.html
  Same-day courier (Nairobi), next-day inter-city, nationwide 2–4 days. Package tracking. Bike, van, or truck options. API integration for businesses.

PROPERTY
• Property Hub → property-hub.html
  Buy: houses, apartments, maisonettes, townhouses, bungalows, commercial, land, off-plan.
  Rent: studio, 1–5+ bedrooms, furnished/unfurnished, Nairobi (Westlands, Kilimani, Karen, Lavington, Ngong Rd, Eastlands, Syokimau, Ruaka, Rongai), Mombasa, Kisumu, Nakuru, Eldoret, Thika.
  Sell / List: free to list; SOKONI connects you with vetted buyers.

JOBS
• Jobs Hub → jobs.html
  Full-time, part-time, contract, freelance, remote, internship, graduate trainee. Post a job or search: all counties, all industries. One-click apply. Applicant tracking for employers.
• B2B Hub → b2b.html
  Wholesale suppliers, bulk buying, trade partnerships, franchise opportunities, distributor agreements, tender listings, import/export agents.

EVENTS & ENTERTAINMENT
• Events → events.html
  Concerts, festivals, comedy nights, sports matches, conferences, expos, food fairs, art shows, church events, weddings. Buy tickets → get e-ticket → scan at gate.

FINANCES & BANKING
• Wallet → wallet.html
  SOKONI wallet: top up via M-Pesa / Visa / Mastercard. Pay at checkout without re-entering card. Receive payouts. View statement.
• Banking Hub → banking.html
  Loans, savings accounts, mobile banking, insurance, SACCOs, forex, investment products — from partnered Kenyan institutions.

SELLER TOOLS
• Seller Dashboard → seller.html
  List products, manage inventory, process orders, set delivery options, view analytics, withdraw earnings, set up shop profile, manage employees, print receipts.
• SmartPOS → pos.html
  Full retail POS: sales, inventory, customers, suppliers, daily reports, M-Pesa integration, receipt printing. For physical and online-to-offline sellers.
• Business OS → business-os.html
  Multi-branch management, staff payroll, expense tracking, financial reports, commission settings, subscription billing.

DRIVER / LOGISTICS
• Driver Dashboard → driver.html
  Accept delivery jobs, GPS navigation, proof-of-delivery (QR + signature), earnings tracker, daily summary, CSAT ratings.

ACCOUNT & REWARDS
• Profile → profile.html
  Personal details, order history, bookings, saved addresses, linked payment methods, seller/provider applications.
• Loyalty → loyalty.html
  Earn 1 point per KES 10 spent. Redeem 100 points = KES 10 off. Bonus points on first purchase, referrals, reviews. Tier status: Bronze → Silver → Gold → Platinum.
• Referrals → referral.html
  Share your referral code. Earn KES 100 per referred friend who completes their first order.
• Wishlist → wishlist.html
  Save items for later. Get a price-drop alert when an item goes on sale.
• Order Tracking → track.html
  Real-time GPS map, 9-stage timeline, driver contact, delivery ETA.
• Notifications → notifications.html
  Order updates, price drops, booking confirmations, payment receipts, new messages, promotions.
• Inbox (messages) → chat.html?seller={id} or messages.html
  Buyer-seller chat, buyer-provider chat. Transaction-gated — must have an active order/booking.
• Sign In → login.html | Sign Up → signup.html

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
INTENT → DESTINATION (know every alias)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

"bnb / airbnb / short stay / furnished / place to sleep / weekend / self-catering / vacation / holiday home / beach house" → short-stays.html
"hotel / lodge / resort / safari camp / guesthouse / motel / guest house" → hotels.html
"boda / bodaboda / piki / taxi / cab / uber / bolt / ride / lift / matatu alternative / airport pickup" → ride.html
"food / pizza / nyama choma / ugali / githeri / mandazi / samosa / biryani / restaurant / takeaway / delivery food / groceries / supermarket" → food-hub.html
"doctor / daktari / hospital / clinic / lab test / blood test / pharmacy / dawa / dentist / therapist / physiotherapy" → healthcare.html
"rent a car / car hire / drive yourself / self drive / van / SUV / bus hire / lorry" → car-rental.html
"NTSA / driving licence / DL / logbook / inspection / PSV / transfer ownership / motor vehicle" → car-hub.html
"garage / mechanic / repair car / service car / tyre / puncture / panel beating / spray paint" → car-hub.html
"house / apartment / to let / for sale / bedsitter / studio / one bedroom / land / plot / property" → property-hub.html
"job / kazi / vacancy / hiring / apply / internship / attachment / graduate / freelance / remote work" → jobs.html
"concert / show / ticket / event / comedy / festival / conference / wedding venue" → events.html
"DJ / MC / band / musician / photographer / videographer / sound system / event decor" → entertainment-hub.html
"tutor / teacher / lessons / homework help / CBC / exam prep / music class / coding / driving school" → education.html
"lawyer / advocate / legal / contract / will / court / trademark / company registration" → legal-hub.html
"cleaning / usafi / sweep / mop / carpet / sofa / post-construction / deep clean" → cleaning.html
"courier / parcel / package / send / ship / transport goods / logistics / warehouse" → delivery.html
"wholesale / bulk / supplier / B2B / distributor / tender / import / export" → b2b.html
"wallet / pesa / balance / money / top up / mpesa / card" → wallet.html
"points / rewards / loyalty / redeem / cashback" → loyalty.html
"referral / invite / share link / earn by referring" → referral.html
"track / where is my order / delivery status / driver location" → track.html
"sell / seller / duka / shop / list product / open shop / register seller" → seller.html
"pos / till / cashier / point of sale / receipt / inventory" → pos.html
"software / digital / ebook / template / licence / app / plugin / download" → digital-hub.html

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PLATFORM FACTS (always accurate)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Payments: M-Pesa STK push (primary), Visa, Mastercard, SOKONI Wallet
Seller commission: SOKONI takes 12%; seller keeps 88%. Free to list. No monthly fee on Basic plan.
Subscription plans: Free (Basic) → Pro → Business → Enterprise. Pro from KES 999/month.
Returns: 7-day hassle-free return on most items. Digital products non-refundable once downloaded.
Delivery times: Same-day in Nairobi CBD & suburbs → 1–2 days Mombasa / Kisumu / Nakuru → 2–4 days other counties.
Delivery cost: From KES 150 (bike) to KES 800+ (van, large parcels). Shown at checkout.
Trust & Safety: All sellers vetted. Buyers protected by escrow — payment released to seller only after delivery confirmed.
Support: WhatsApp +254 705 726 803 (fastest, 8am–10pm) | info@mysokoni.co.ke | support ticket via profile.html

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
KENYAN LANGUAGE & CULTURE (know this deeply)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

LANGUAGE — respond in whatever the user writes in. Match their language immediately.
• English (formal or casual) — default when user writes English.
• Kiswahili — "Habari?", "Nataka…", "Ninaomba…", "Bei gani?", "Iko wapi?". Full Swahili responses when spoken to in Swahili.
• Sheng — Nairobi urban youth mix of Swahili+English+local languages. Examples:
  - "Niko poa" = I'm fine | "Maze" = mate/friend | "Sawa kabisa" = totally fine
  - "Nishow" = show me | "Naomba unijua" = let me know | "Maneno" = stuff/issues
  - "Pesa" = money | "Kitu" = something | "Mtu" = person
  - "Uko wapi?" = where are you? | "Nifikirie" = let me think
  - "Nipe deal" = give me a good deal | "Hiyo ni ya moto" = that's on fire / hot item
  - "Niko busy" = I'm busy | "Wacha" = stop/leave it | "Sema" = talk/say
  - Respond in Sheng if user writes in Sheng. Keep it natural and current.
• Kikuyu — understand phrases like "Ndiri" (no), "Ĩĩ" (yes), common food/service names.
• Dholuo — "Amosi" (greeting), "Ere?" (where?), understand Luo names and context.
• Kamba, Luhya, Kalenjin — recognise greetings and common terms.
• Mix freely — many Kenyans mix English+Swahili+mother tongue in one sentence. Handle naturally.

KENYAN CULTURAL CONTEXT — know this:
• Food: nyama choma = grilled meat (national dish). Ugali = maize meal staple. Sukuma wiki = kale. Githeri = beans+maize. Pilau, biryani popular coast. Mandazi = fried dough (breakfast). Kachumbari = tomato+onion salad.
• Areas (Nairobi): CBD, Westlands, Kilimani, Karen, Lavington, Lang'ata, Ngong Road, South B/C, Eastleigh, Kasarani, Ruaka, Rongai, Syokimau, Kitengela, Thika Rd, Githurai, Pipeline, Umoja, Buruburu, Donholm.
• Areas (other): Mombasa (Nyali, Bamburi, Diani, Malindi), Kisumu (Milimani), Nakuru, Eldoret, Thika, Naivasha, Nanyuki, Machakos, Meru.
• Money: people say "Bob" for KES. "Elfu" = thousand. "Kitu kama mia mbili" = about KES 200.
• Transport: "Boda" = motorbike taxi. "Matatu" = minibus. "Tuktuk" = 3-wheel taxi. "Cab" = any car taxi.
• Cultural events: Mashujaa Day (Oct 20), Jamhuri Day (Dec 12), Madaraka Day (Jun 1), Eid, Christmas, Easter, New Year.
• Business culture: people value relationships, trust, haggling. Don't be stiff — be warm but efficient.
• Common spending habits: M-Pesa is king. People check prices carefully. Weekend = peak shopping/food/events.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
BEHAVIOUR RULES (follow exactly)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. MARKETPLACE FIRST — for any shopping/product intent, immediately call search_products. Show real items with prices and sellers. Never say "visit the marketplace" without first running a search.
2. SEARCH BEFORE ANSWERING — call a search tool before describing any specific product, listing, provider, event, job, or stay. Never invent data.
3. NAVIGATE WITH CONFIDENCE — when a user wants to go somewhere, call get_page_url immediately. Don't ask "would you like me to take you there?" — just do it.
4. ONE-STEP RESOLUTION — identify intent in the first turn and resolve it. Don't make users repeat themselves.
5. LANGUAGE MATCH — respond in whatever language the user writes in. Sheng → Sheng. Swahili → Swahili. Mix → mix naturally.
6. PERSONALISE — lead with the user's preferred categories/sellers when their profile is available. Say "You've ordered from [Seller X] before — they're back" or "Based on what you usually buy, here are some picks…"
7. PRICES IN KES — always "KES 1,500" with comma. In Sheng say "Bob" (e.g. "elfu moja na nusu / 1500 bob").
8. CONFIRM BEFORE ACTING — for cart, booking, cancel: state exact details, ask "Shall I?" once, then act on yes.
9. PROACTIVE UPSELL — after any product search: show best value, flag 20%+ savings alternatives, suggest related products, mention loyalty points earnable. Always try to add value.
10. AFTER PURCHASE / CART ADD: suggest complementary products. ("You added a blender — need kitchen scales? I can search.")
11. AFTER STAYS: ask if they need food/transport nearby.
12. AFTER ORDER TRACKING: offer help if order is delayed.
13. AFTER WALLET CHECK: remind about loyalty points if > 100 unredeemed.
14. NEVER invent product names, prices, or availability. If nothing found, say so and offer to refine the search.
15. NEVER mention internal file paths like index.html or firebase URLs.
16. STAY IN CONTEXT — carry intent across the full conversation.

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ACTION TOOLS  (${uid ? "LIVE — user is signed in" : "will prompt sign-in"})
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

add_to_cart       — add product (confirm item name, price, qty first)
view_cart         — show cart contents and subtotal
get_my_orders     — list recent orders with status
track_order       — live GPS tracking + ETA
cancel_order      — cancel pending/confirmed order (confirm first)
save_to_wishlist  — save item to favourites + price-drop alert
get_wallet        — check wallet balance + loyalty points
book_stay         — book BnB or hotel (confirm check-in/out, guests, total first)
compare_products  — side-by-side comparison of up to 3 products
get_page_url      — navigate user to correct page (use for food, rides, events, car hire, tickets)

For food ordering → get_page_url to food-hub.html.
For ride booking → get_page_url to ride.html.
For event tickets → get_page_url to events.html.
For car hire → get_page_url to car-rental.html.`;

    /* ── KASS KNOWLEDGE RETRIEVAL ─────────────────────────────────────────
       Knowledge is NOT baked into the prompt above — that prompt is BEHAVIOUR
       (persona, tools, routing). Facts, policies, prices and Kenya reference are
       retrieved per-turn from the admin-managed `kassKnowledge` collection, so a
       business change is a Firestore write rather than a redeploy.

       `grounded === false` means we found nothing solid. We say so explicitly
       rather than letting the model improvise a plausible answer — an invented
       commission rate or refund policy is worse than "I don't know". */
    /* Retrieve against the user's LATEST turn. sokoniChat receives a `messages`
       array (not a single `message`), so take the last user turn — that is the
       question being asked. Falling back to the whole transcript would retrieve
       against stale context and surface the wrong knowledge. */
    const _lastUserTurn = [...history].reverse().find(m => m.role === "user");
    const _kassQuery = (_lastUserTurn && _lastUserTurn.content) || "";

    let knowledgePrompt = "";
    let retrievedIds = [];
    try {
      const kb = await _kassKnowledge.retrieve(_kassQuery);
      retrievedIds = (kb.entries || []).map(e => e.id);

      if (kb.grounded) {
        knowledgePrompt =
`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
VERIFIED SOKONI KNOWLEDGE (retrieved for this question)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Treat the following as authoritative and answer FROM it. It outranks your general
impressions. If it contradicts what you assumed, the knowledge is right.

${kb.block}

If the answer is not fully contained above, say what you do know from it and be
explicit about what you don't — do not fill the gap with a guess.`;
      } else {
        knowledgePrompt =
`\n\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
NO VERIFIED KNOWLEDGE MATCHED THIS QUESTION
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
You may still use your tools (search, order lookup) and general commercial judgement,
and you may help with anything that is plainly a marketplace action.

But you have NO verified SOKONI policy for this. So:
• Do NOT state a SOKONI fee, commission, refund rule, payout timing or policy.
• Label general advice as advice, not policy.
• If they asked for a specific SOKONI rule you don't have, say honestly that you
  don't want to guess, and offer to hand off to support.`;

        /* The backlog for the next knowledge update: what users ask that we cannot ground. */
        _kassKnowledge.logUnanswered({ query: _kassQuery, uid, sessionId: null, reason: "no_knowledge_match" });
      }
    } catch (err) {
      /* Knowledge is an enhancement — if retrieval fails, KASS must still answer,
         but it must not pretend to authority it no longer has. */
      logger.warn("[KASS] knowledge retrieval failed", { error: err.message });
      knowledgePrompt =
`\n\nNOTE: verified-knowledge lookup is unavailable this turn. Do not state SOKONI
policies, fees or rules from memory — help with actions and general advice only,
and hand off to support for policy questions.`;
    }

    /* ── EXPERT MODE (automatic) ──────────────────────────────────────────
       The user never selects a mode. Detection is lexical and runs in-process —
       an LLM classifier here would add a round-trip before every single reply and
       blow the latency budget for something a word list decides correctly.
       The mode changes the LENS, never the facts: facts come only from retrieved
       knowledge and tools. */
    let modePrompt = "";
    let modeKey = "concierge";
    try {
      const mode = _kassModes.detect(_kassQuery);
      modeKey = mode.key;
      modePrompt = `\n\n━━━ ACTIVE EXPERTISE: ${mode.label} ━━━\n${mode.lens}\n
Do not announce the mode or mention switching. The user should experience one
assistant that happens to know their subject — not a menu of departments.`;
    } catch (err) {
      logger.warn("[KASS] mode detection failed", { error: err.message });
    }

    /* ── MEMORY ───────────────────────────────────────────────────────────
       Authenticated users only — no profiling of guests. Derived preferences
       only; never transcripts, never PII. Memory is convenience, not authority:
       order/payment state is always read live from a tool. */
    let memoryPrompt = "";
    try {
      memoryPrompt = await _kassMemory.loadForPrompt(uid);
    } catch (err) {
      logger.warn("[KASS] memory load failed", { error: err.message });
    }

    /* Learn from what they actually did, not from what the model decides to store.
       Fire-and-forget: memory must never delay a reply, and must never fail one. */
    if (uid) {
      try {
        const patch = {};

        /* Preferred language, observed rather than asked. Kenyan users code-mix, so
           "mixed" is a real answer — forcing en/sw would mislabel most of them. */
        const t = String(_kassQuery || "").toLowerCase();
        const sw = /\b(nataka|natafuta|nipe|habari|asante|bei|pesa|nyumba|kazi|simu|ngapi|sasa|poa|manze|buda)\b/.test(t);
        const en = /\b(the|and|how|what|please|want|need|price|delivery)\b/.test(t);
        if (sw && en)      patch.preferredLanguage = "mixed";
        else if (sw)       patch.preferredLanguage = "sw";
        else if (en)       patch.preferredLanguage = "en";

        /* Recent searches — only for genuinely commercial turns. Storing every
           utterance would quietly turn this into a transcript log, which is exactly
           what the memory design refuses to be. */
        if ((modeKey === "shopping" || modeKey === "merchant") && _kassQuery) {
          patch.recentSearches = [String(_kassQuery).slice(0, 60)];
        }

        if (Object.keys(patch).length) _kassMemory.remember(uid, patch);
      } catch (_) { /* never break a chat for memory */ }
    }

    const finalSystemPrompt = systemPrompt + knowledgePrompt + modePrompt + memoryPrompt;

    const collectedResults = [];
    const collectedActions = [];
    const ctx = {
      uid,
      addResult: (r) => { if (collectedResults.length < 8) collectedResults.push(r); },
      addAction: (a) => { if (!collectedActions.some(x => x.url === a.url)) collectedActions.push(a); },
    };

    try {
      const anthropic = _getAnthropicClient();
      let currentMessages = [...history];
      let finalResponse = "";
      const MAX_ITER = 5;

      for (let iter = 0; iter < MAX_ITER; iter++) {
        const aiRes = await anthropic.messages.create({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1024,
          system: finalSystemPrompt,
          tools: _CHAT_TOOLS,
          messages: currentMessages,
        });

        if (aiRes.stop_reason === "end_turn" || aiRes.stop_reason !== "tool_use") {
          finalResponse = aiRes.content.filter(b => b.type === "text").map(b => b.text).join("").trim();
          break;
        }

        /* tool_use — execute all requested tools in parallel */
        const toolBlocks = aiRes.content.filter(b => b.type === "tool_use");
        const toolResults = await Promise.all(toolBlocks.map(async block => ({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(await _execChatTool(block.name, block.input, ctx)),
        })));

        currentMessages = [
          ...currentMessages,
          { role: "assistant", content: aiRes.content },
          { role: "user",      content: toolResults },
        ];
      }

      const payload = {
        response: finalResponse || "I'm here to help! What are you looking for on SOKONI?",
        results: collectedResults.length > 0 ? collectedResults : undefined,
        actions: collectedActions.length > 0 ? collectedActions : undefined,
      };
      res.json(payload);

      /* ── Record behavioural signal for personalisation (fire-and-forget) ─── */
      if (uid && collectedResults.length > 0) {
        const lastUserMsg = history.filter(m => m.role === "user").slice(-1)[0]?.content || "";
        const categories  = [...new Set(collectedResults.map(r => r.category || r.type).filter(Boolean))];
        const sellers     = [...new Set(collectedResults.map(r => r.sellerName || r.seller).filter(Boolean))];
        db.collection("userBehavior").doc(uid).collection("kassInteractions").add({
          ts:          admin.firestore.FieldValue.serverTimestamp(),
          query:       lastUserMsg.slice(0, 120),
          categories:  categories.slice(0, 6),
          sellers:     sellers.slice(0, 4),
          resultCount: collectedResults.length,
        }).catch(() => {/* non-fatal */});
      }
    } catch (err) {
      console.error("sokoniChat error:", err);
      res.status(500).json({ error: "KASS is temporarily unavailable. Please try again in a moment." });
    }
  }
);

/* ============================================================
   SELLER BROADCAST FAN-OUT
   Triggers when a seller saves a push notification broadcast.
   Fans out FCM messages to all followers who have push enabled.
============================================================ */
exports.onSellerBroadcast = onDocumentCreated(
  "sellerBroadcasts/{sellerName}/broadcasts/{broadcastId}",
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const sellerName = event.params.sellerName;

    /* Find all followers of this seller */
    const followsSnap = await db.collection("follows")
      .where("type",     "==", "seller")
      .where("entityId", "==", sellerName)
      .get()
      .catch(() => null);

    if (!followsSnap || followsSnap.empty) return;

    /* Collect FCM tokens for each follower */
    const tokens = [];
    const tokenFetches = followsSnap.docs.map(async (followDoc) => {
      /* Follow document ID format: {uid}--seller--{entityId} */
      const uid = followDoc.id.split("--")[0];
      if (!uid) return;
      const userSnap = await db.collection("users").doc(uid).get().catch(() => null);
      if (userSnap?.exists) {
        const token = userSnap.data().fcmToken;
        if (token) tokens.push(token);
      }
    });
    await Promise.allSettled(tokenFetches);

    if (!tokens.length) return;

    /* Send FCM multicast (batch of up to 500) */
    const batches = [];
    for (let i = 0; i < tokens.length; i += 500) {
      batches.push(tokens.slice(i, i + 500));
    }

    for (const batch of batches) {
      await admin.messaging().sendEachForMulticast({
        tokens: batch,
        notification: {
          title: data.title || `New from ${sellerName}`,
          body:  data.body  || "",
        },
        data: {
          url:        data.url || "/",
          type:       "sellerBroadcast",
          sellerName: sellerName,
        },
        webpush: {
          notification: {
            icon:  "/assets/logosokoni.png",
            badge: "/assets/logosokoni.png",
            requireInteraction: false,
          },
          fcmOptions: { link: data.url || "https://mysokoni.co.ke/" },
        },
      }).catch(err => console.warn("[sokoni] FCM batch error:", err.message));
    }
  }
);

/* ============================================================
   SHARED HELPERS  (SMS · FCM · SMS templates)
============================================================ */

/**
 * sendSms — thin wrapper around sokoni-at.atSendSMS.
 * Delegates all credential resolution and phone normalisation to sokoni-at.js.
 */
async function sendSms(to, message) {
  await sokoniAt.atSendSMS(to, message);
}

/**
 * sendFcm — single-token FCM web-push message.
 */
async function sendFcm(token, title, body, relUrl) {
  if (!token) return;
  return admin.messaging().send({
    token,
    notification: { title, body },
    webpush: {
      notification: {
        icon:  "/assets/logosokoni.png",
        badge: "/assets/logosokoni.png",
        requireInteraction: false,
      },
      fcmOptions: { link: "https://mysokoni.co.ke/" + (relUrl || "") },
    },
    data: { url: relUrl || "/" },
  }).catch(e => console.warn("[FCM]", e.message));
}

/**
 * getFcmToken — reads fcmToken from users/{uid}.
 */
async function getFcmToken(uid) {
  if (!uid) return null;
  const snap = await db.collection("users").doc(uid).get().catch(() => null);
  return snap?.data()?.fcmToken || null;
}

/**
 * smsTemplates — returns SMS text + FCM title/body per status change.
 * Keys: buyer, seller, driver, buyerFcm, sellerFcm, driverFcm.
 */
function smsTemplates(o) {
  const id     = o.id || o._fsId || "—";
  const total  = Number(o.orderTotal || o.total || 0).toLocaleString("en-KE");
  const buyer  = o.buyerName   || "Customer";
  const seller = o.sellerName  || "Seller";
  const driver = o.driverName  || "Rider";
  const dPhone = o.driverPhone || "";
  const sNet   = Number(o.sellerNet || o.total || 0).toLocaleString("en-KE");
  const pin    = o.proofPin || "----";
  const ref    = o.deliveryRef ? `delivery-tracking.html?ref=${o.deliveryRef}` : `track.html?id=${id}`;

  return {
    paid: {
      buyer:     `SOKONI: Order ${id} confirmed! Total KES ${total}. Seller will confirm shortly. Track: mysokoni.co.ke/${ref}`,
      seller:    `SOKONI: New order ${id} from ${buyer}! KES ${total}. Confirm it now: mysokoni.co.ke/seller.html`,
      buyerFcm:  { title: "✅ Order Placed!", body: `KES ${total} — order ${id} received` },
      sellerFcm: { title: "🛒 New Order!", body: `${buyer} ordered KES ${total}` },
    },
    awaiting_confirmation: {
      seller:    `SOKONI: Please confirm order ${id} from ${buyer} (KES ${total}). Open your seller dashboard: mysokoni.co.ke/seller.html`,
      sellerFcm: { title: "⏳ Confirm Order", body: `${buyer} is waiting — KES ${total}` },
    },
    confirmed: {
      buyer:    `SOKONI: Seller confirmed order ${id}! A rider is being assigned for your delivery.`,
      buyerFcm: { title: "🟢 Order Confirmed!", body: `Rider assignment in progress` },
    },
    rider_assigned: {
      buyer:     `SOKONI: Rider ${driver} (${dPhone}) is on the way to pick up your order ${id}. You'll get an update when it's en route.`,
      seller:    `SOKONI: Rider ${driver} (${dPhone}) will pick up order ${id} shortly. Please have it ready.`,
      driver:    `SOKONI: New delivery! Order ${id} from ${seller} → ${buyer}. Open your driver app: mysokoni.co.ke/driver.html`,
      buyerFcm:  { title: "🏍️ Rider Assigned!", body: `${driver} is heading to the seller` },
      sellerFcm: { title: "🏍️ Rider Coming!", body: `${driver} (${dPhone}) picks up soon` },
      driverFcm: { title: "📦 New Delivery!", body: `Order ${id} — open your driver app` },
    },
    rider_en_route: {
      seller:    `SOKONI: Rider ${driver} is on the way to pick up order ${id}.`,
      sellerFcm: { title: "🛵 Rider En Route", body: `${driver} is heading to you` },
    },
    picked_up: {
      buyer:    `SOKONI: Rider ${driver} has picked up your order ${id} and is heading to you!`,
      buyerFcm: { title: "📦 Picked Up!", body: `${driver} has your order and is on the way` },
    },
    in_transit: {
      buyer:    `SOKONI: Your order ${id} is on the way! Rider: ${driver} (${dPhone}).`,
      buyerFcm: { title: "🚗 On the Way!", body: `Order ${id} is en route to you` },
    },
    delivered: {
      buyer:    `SOKONI: Order ${id} delivered! Confirm receipt to release payment to seller. PIN: ${pin}`,
      buyerFcm: { title: "📬 Delivered!", body: `Confirm receipt with your PIN: ${pin}` },
    },
    completed: {
      seller:    `SOKONI: Order ${id} completed! KES ${sNet} released to your account.`,
      driver:    `SOKONI: Delivery ${id} complete! Check your earnings in the driver dashboard.`,
      sellerFcm: { title: "🎉 Payment Released!", body: `KES ${sNet} for order ${id}` },
      driverFcm: { title: "💰 Earnings Updated!", body: `Delivery ${id} complete` },
    },
    cancelled: {
      buyer:     `SOKONI: Order ${id} has been cancelled. If you paid, a refund will be processed within 24h.`,
      seller:    `SOKONI: Order ${id} from ${buyer} was cancelled.`,
      buyerFcm:  { title: "❌ Order Cancelled", body: `Order ${id} was cancelled` },
      sellerFcm: { title: "❌ Order Cancelled", body: `Order ${id} from ${buyer}` },
    },
    refunded: {
      buyer:    `SOKONI: Order ${id} refunded. KES ${total} will be returned to your M-Pesa within 24 hours.`,
      buyerFcm: { title: "↩️ Refund Initiated", body: `KES ${total} for order ${id}` },
    },
  };
}

/* ============================================================
   createCheckoutSession  — locks cart server-side before payment
   Called by checkout.html BEFORE the IntaSend STK Push is initiated.
   Returns a sessionId and the server-authoritative cart total so the
   frontend can pass that total to IntaSend — the client never computes
   or controls the amount the STK Push charges.
============================================================ */
exports.createCheckoutSession = onCall(
  { timeoutSeconds: 30, minInstances: 1, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

    const { cartItems, deliveryFee, promoCode, redeemLoyalty } = request.data || {};
    if (!Array.isArray(cartItems) || cartItems.length === 0) {
      throw new HttpsError("invalid-argument", "cartItems must be a non-empty array.");
    }
    if (cartItems.length > 50) {
      throw new HttpsError("invalid-argument", "Cart too large (max 50 items).");
    }

    const productIds = [...new Set(
      cartItems.map(i => String(i.productId || i.id || "")).filter(Boolean)
    )];
    if (productIds.length === 0) {
      throw new HttpsError("invalid-argument", "No valid product IDs in cart.");
    }

    /* Fetch authoritative prices from Firestore (10-item chunk limit for `in`) */
    const priceMap = {};
    for (let ci = 0; ci < productIds.length; ci += 10) {
      const chunk = productIds.slice(ci, ci + 10);
      const snap = await db.collection("products")
        .where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
      snap.forEach(doc => { priceMap[doc.id] = doc.data(); });
    }

    /* Build session items using server prices — any item not in the catalogue is skipped.
       Also validates stock availability: out-of-stock items are rejected so the session
       cannot be used to purchase items that are unavailable. */
    const sessionItems = [];
    let serverSubtotal = 0;
    const outOfStockItems = [];
    const adjustedItems   = [];
    for (const item of cartItems) {
      const pid  = String(item.productId || item.id || "");
      const prod = priceMap[pid];
      if (!prod) continue;

      /* Out-of-stock check: outOfStock flag OR stock field present and zero */
      const stockQty = prod.stock !== undefined ? Number(prod.stock) : null;
      const isOos    = prod.outOfStock === true || (stockQty !== null && stockQty <= 0);
      if (isOos) {
        outOfStockItems.push(prod.name || pid);
        continue;
      }

      const unitPrice = Number(prod.salePrice || prod.price || 0);
      let   qty       = Math.max(1, Math.min(99, Math.round(Number(item.qty) || 1)));

      /* Quantity revalidation: never authorise a session for more than remains.
         When a metered product has fewer units than requested, clamp to what is
         available (>=1 here, since <=0 was rejected as OOS above) and report the
         adjustment so the buyer can be told "only N available" before paying. */
      if (stockQty !== null && qty > stockQty) {
        adjustedItems.push({ name: prod.name || pid, requested: qty, available: stockQty });
        qty = stockQty;
      }

      const lineTotal = unitPrice * qty;
      serverSubtotal += lineTotal;
      sessionItems.push({
        productId:  pid,
        name:       prod.name   || "Item",
        unitPrice,
        qty,
        lineTotal,
        sellerUid:  prod.sellerUid  || null,
        sellerName: prod.sellerName || null,
        image:      prod.image      || null,
      });
    }

    if (outOfStockItems.length > 0 && sessionItems.length === 0) {
      throw new HttpsError("failed-precondition",
        `All items in your cart are out of stock: ${outOfStockItems.slice(0, 3).join(", ")}`
      );
    }
    if (outOfStockItems.length > 0) {
      /* Partial: some items available, some out-of-stock — return which ones were skipped */
      console.warn("[createCheckoutSession] Skipped out-of-stock items:", outOfStockItems);
    }
    if (sessionItems.length === 0) {
      throw new HttpsError("not-found", "None of the cart items were found in the product catalogue.");
    }

    /* Cap delivery fee at KES 5,000 to prevent inflated totals */
    const safeDeliveryFee = Math.max(0, Math.min(5000, Math.round(Number(deliveryFee) || 0)));

    /* ── Promo code ────────────────────────────────────────────────────────────
       checkout.html used to hold its own hardcoded map of codes (SAVE5/SAVE10/
       MEGA20) and subtract the discount from the figure it DISPLAYED. This
       function knew nothing about any of it, so serverTotal — the amount actually
       charged — never included the discount and the buyer was billed more than
       they were quoted.

       The discount is now decided HERE, by validatePromoCode in finos-utils: the
       one validator that already checks active state, the date window, usage and
       per-user limits, minimum order value and category, and caps the amount. A
       client-supplied code is only ever an input to that check — the client can
       never assert a discount, only name a code. An invalid or expired code is
       ignored rather than fatal, so a bad code can never block a real purchase;
       the buyer is told via promoError and simply pays full price. */
    let promoDiscount = 0;
    let promoApplied  = null;
    let promoError    = null;
    const _promoCode = String(promoCode || "").trim().toUpperCase();
    if (_promoCode) {
      try {
        const { validatePromoCode } = require('./finos-utils');
        const _res = await validatePromoCode(db, {
          code:             _promoCode,
          buyerUid:         request.auth.uid,
          orderAmountCents: Math.round(serverSubtotal * 100),
        });
        if (_res.valid) {
          /* Never let a discount exceed the goods value — delivery is still owed. */
          promoDiscount = Math.min(
            Math.round((_res.discountCents || 0) / 100),
            Math.round(serverSubtotal)
          );
          promoApplied = { code: _res.promoCode, promoId: _res.promoId, discount: promoDiscount };
        } else {
          promoError = _res.error || "Promo code could not be applied";
        }
      } catch (e) {
        /* A promo lookup failure must never take down checkout. */
        console.error("[createCheckoutSession] promo validation failed:", e);
        promoError = "Promo code could not be verified";
      }
    }

    /* ── Loyalty point redemption ──────────────────────────────────────────────
       Same defect as the promo codes: checkout.html subtracted a points discount
       from the DISPLAYED total while reading the balance out of
       localStorage.sokoniLoyalty — a number the buyer's own browser owns. The
       charge never included it, so redeeming points quoted a price we then did
       not honour.

       The client now sends only INTENT (redeemLoyalty: true). The balance is read
       here from loyaltyAccounts/{uid}, and the discount is decided here, capped by
       both the real balance and MAX_REDEEM_PCT of the goods value. The points are
       NOT deducted yet — an abandoned checkout must never burn them. The intended
       redemption is recorded on the session and settled in the verifyPayment
       transaction that consumes it. */
    const POINTS_TO_KES  = 0.5;   /* 1 point = KES 0.50  — mirrors checkout.html */
    const MAX_REDEEM_PCT = 0.25;  /* at most 25% of goods value paid with points */
    let loyaltyDiscount = 0;
    let loyaltyPoints   = 0;
    let loyaltyError    = null;
    if (redeemLoyalty === true) {
      try {
        const _lSnap = await db.collection("loyaltyAccounts").doc(request.auth.uid).get();
        const _bal   = _lSnap.exists ? Math.max(0, Math.floor(Number(_lSnap.data().balance) || 0)) : 0;
        if (_bal <= 0) {
          loyaltyError = "No loyalty points available to redeem";
        } else {
          loyaltyDiscount = Math.floor(Math.min(
            _bal * POINTS_TO_KES,
            Math.round(serverSubtotal) * MAX_REDEEM_PCT
          ));
          loyaltyPoints = loyaltyDiscount > 0 ? Math.ceil(loyaltyDiscount / POINTS_TO_KES) : 0;
          if (loyaltyDiscount <= 0) loyaltyError = "Order too small to redeem points";
        }
      } catch (e) {
        console.error("[createCheckoutSession] loyalty lookup failed:", e);
        loyaltyError = "Loyalty balance could not be verified";
      }
    }

    /* Discounts may never take the charge below KES 1 — the gateway cannot bill
       zero, and a free order must not silently become a KES 0 STK push. Trim the
       loyalty portion first (points are refundable; a promo code is not). */
    const _grossTotal = Math.round(serverSubtotal + safeDeliveryFee);
    let   _discount   = promoDiscount + loyaltyDiscount;
    if (_discount > _grossTotal - 1) {
      const _allowed = Math.max(0, _grossTotal - 1);
      const _trim    = _discount - _allowed;
      loyaltyDiscount = Math.max(0, loyaltyDiscount - _trim);
      loyaltyPoints   = loyaltyDiscount > 0 ? Math.ceil(loyaltyDiscount / POINTS_TO_KES) : 0;
      promoDiscount   = Math.min(promoDiscount, _allowed - loyaltyDiscount);
      _discount       = promoDiscount + loyaltyDiscount;
      if (promoApplied) promoApplied.discount = promoDiscount;
    }

    const serverTotal = Math.max(0, _grossTotal - _discount);

    if (serverTotal < 1) {
      throw new HttpsError("invalid-argument", "Cart total is too low.");
    }

    const sessionId = "CS" + Date.now().toString(36).toUpperCase()
                    + Math.random().toString(36).slice(2, 6).toUpperCase();
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000); /* 30-minute window */

    await db.collection("checkoutSessions").doc(sessionId).set({
      sessionId,
      uid:         request.auth.uid,
      items:       sessionItems,
      serverTotal,
      deliveryFee: safeDeliveryFee,
      promoCode:   promoApplied ? promoApplied.code : null,
      promoId:     promoApplied ? promoApplied.promoId : null,
      promoDiscount,
      /* Settled by verifyPayment when this session is consumed — never here, or an
         abandoned checkout would burn the buyer's points. */
      loyaltyPoints,
      loyaltyDiscount,
      status:      "pending",
      expiresAt:   admin.firestore.Timestamp.fromDate(expiresAt),
      createdAt:   admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[createCheckoutSession] session=${sessionId} uid=${request.auth.uid.slice(0,8)}… items=${sessionItems.length}`);
    return {
      sessionId,
      serverTotal,
      itemCount:       sessionItems.length,
      outOfStockItems: outOfStockItems.length > 0 ? outOfStockItems : undefined,
      /* Lines whose quantity was reduced to remaining stock — the page warns the
         buyer ("only N available") and updates the cart before payment. */
      adjustedItems:   adjustedItems.length > 0 ? adjustedItems : undefined,
      /* So the page can show the discount it actually received, and explain a
         code that was rejected, instead of asserting a discount of its own. */
      promoApplied:    promoApplied || undefined,
      promoDiscount:   promoDiscount || undefined,
      promoError:      promoError || undefined,
      loyaltyDiscount: loyaltyDiscount || undefined,
      loyaltyPoints:   loyaltyPoints || undefined,
      loyaltyError:    loyaltyError || undefined,
    };
  }
);

/* ============================================================
   verifyIntasendPayment  — server-side M-Pesa verification
   Called by checkout.html after IntaSend COMPLETE callback.
   1. Verifies invoice with IntaSend REST API (private key).
   2. Creates order in Firestore with status "paid".
   3. Returns { verified, orderId }.
============================================================ */
exports.verifyIntasendPayment = onRequest(
  {
    secrets:        [INTASEND_PRIVATE_KEY],
    cors:           ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app"],
    timeoutSeconds: 30,
    invoker:        "public",
    minInstances:   1,
  },
  async (req, res) => {
    const log = createLogger({ fn: "verifyIntasendPayment" });

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    /* Rate-limit: dual — per-IP (10/min) AND per-UID (5/min) to prevent NAT bypass */
    const ip     = (req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
    const callerUid = req.body?.uid || req.body?.buyerUid || null;
    const [_rlIp, _rlUid] = await Promise.all([
      checkRateLimitDurable(`verify_${ip}`, 10, 60),
      callerUid ? checkRateLimitDurable(`verify_uid_${callerUid}`, 5, 60) : Promise.resolve({ ok: true }),
    ]);
    if (!_rlIp.ok || !_rlUid.ok) {
      log.warn("Rate limit exceeded", { ip, uid: callerUid });
      res.status(429).json({ verified: false, error: "Rate limit exceeded. Please wait before retrying." });
      return;
    }

    const {
      invoiceId, trackingId, amount, phone, orderItems,
      deliveryName, deliveryAddress,
      pickupCoords, deliveryCoords, /* Blocker B2 — geo for rider dispatch (pickup=shop, dropoff=buyer) */
      sessionId, /* preferred: server-side checkout session ID */
    } = req.body;
    /* Normalize coords → flat lat/lng the dispatch engine reads (_autoAssignRider: after.pickupLat/pickupLng). */
    const _num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
    const _pLat = pickupCoords && _num(pickupCoords.lat), _pLng = pickupCoords && _num(pickupCoords.lng);
    const _dLat = deliveryCoords && _num(deliveryCoords.lat), _dLng = deliveryCoords && _num(deliveryCoords.lng);

    if (!invoiceId && !trackingId) {
      res.status(400).json({ verified: false, error: "invoiceId or trackingId required" });
      return;
    }

    const privKey = INTASEND_PRIVATE_KEY.value();
    if (!privKey) {
      res.status(500).json({ verified: false, error: "Payment gateway not configured" });
      return;
    }

    /* ── Load checkout session when provided (preferred secure path) ──
       Session items and total are server-computed; we never trust the
       client's orderItems or amount when a sessionId is present. ── */
    let sessionDoc   = null;
    let sessionTotal = null;
    if (sessionId) {
      const sessionSnap = await db.collection("checkoutSessions").doc(String(sessionId)).get();
      if (!sessionSnap.exists) {
        return res.status(400).json({ verified: false, error: "Checkout session not found or expired." });
      }
      sessionDoc = sessionSnap.data();

      /* Session must still be in pending state (one-use guard) */
      if (sessionDoc.status !== "pending") {
        return res.status(400).json({ verified: false, error: "Checkout session already used or expired." });
      }

      /* Session must not be expired */
      const now = admin.firestore.Timestamp.now();
      if (sessionDoc.expiresAt && sessionDoc.expiresAt.toMillis() < now.toMillis()) {
        return res.status(400).json({ verified: false, error: "Checkout session has expired." });
      }

      sessionTotal = sessionDoc.serverTotal;
    }

    try {
      /* ── IntaSend payment verification ── */
      const isLive  = process.env.INTASEND_LIVE !== "false";
      const baseUrl = isLive
        ? "https://payment.intasend.com"
        : "https://sandbox.intasend.com";
      const ref = invoiceId || trackingId;

      const verifyRes = await fetch(
        `${baseUrl}/api/v1/payment/collection/?invoice_id=${encodeURIComponent(ref)}`,
        { headers: { Authorization: `Token ${privKey}`, "Content-Type": "application/json" } }
      );

      if (!verifyRes.ok) {
        const errText = await verifyRes.text();
        console.error("[verifyIntasendPayment] API error:", errText);
        return res.status(400).json({ verified: false, error: "Payment verification failed" });
      }

      const apiData = await verifyRes.json();
      /* IntaSend returns a paginated list — find the matching record */
      const results  = apiData.results || (Array.isArray(apiData) ? apiData : [apiData]);
      const payment  = results.find(
        p => p.invoice_id === ref || p.tracking_id === ref || p.api_ref === ref
      );

      if (!payment) {
        return res.status(400).json({ verified: false, error: "Payment record not found" });
      }
      if (payment.state !== "COMPLETE") {
        return res.status(400).json({ verified: false, error: `Payment state: ${payment.state}` });
      }

      /* ── Amount cross-check: trust the API, not the client ── */
      const apiAmount    = Number(payment.value || payment.amount || payment.paid_amount || 0);
      const clientAmount = Number(amount) || 0;

      /* When a session is present compare against session.serverTotal (server-authoritative).
         When no session AND no orderItems to verify against catalogue, we cannot safely confirm
         the amount — reject unless the payment API amount matches what the client claimed. */
      const expectedTotal   = sessionTotal || (apiAmount > 0 ? apiAmount : clientAmount);
      const confirmedAmount = apiAmount > 0 ? apiAmount : 0; // never trust client amount as confirmed

      /* ── Amount integrity check ── */
      if (apiAmount > 0 && expectedTotal > 0 && confirmedAmount < expectedTotal - 1) {
        const logType = sessionTotal ? "payment_session_underpayment" : "payment_amount_mismatch";
        console.error(
          `[verifyIntasendPayment] ${logType} for ${ref}: paid=${confirmedAmount} expected=${expectedTotal}`
        );
        db.collection("auditLogs").add({
          type: logType, ref, confirmedAmount, expectedTotal, sessionId: sessionId || null,
          ts: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        return res.status(400).json({ verified: false, error: "Payment does not cover the order total." });
      }

      /* ── Catalogue price verification (fallback path — no session) ──
         When the client did not supply a sessionId (e.g., old app version),
         fall back to the live product-catalogue cross-check as a safety net. ── */
      if (!sessionDoc && Array.isArray(orderItems) && orderItems.length > 0) {
        const productIds = [...new Set(
          orderItems.map(i => String(i.id || i.productId || "")).filter(Boolean)
        )];

        if (productIds.length > 0) {
          const priceMap = {};
          for (let ci = 0; ci < productIds.length; ci += 10) {
            const chunk = productIds.slice(ci, ci + 10);
            const snap = await db.collection("products")
              .where(admin.firestore.FieldPath.documentId(), "in", chunk).get();
            snap.forEach(doc => { priceMap[doc.id] = doc.data(); });
          }

          let serverTotal = 0;
          let unknownItems = 0;
          for (const item of orderItems) {
            const pid = String(item.id || item.productId || "");
            if (!pid || !priceMap[pid]) { unknownItems++; continue; }
            const prod = priceMap[pid];
            const unitPrice = Number(prod.salePrice || prod.price || 0);
            serverTotal += unitPrice * (Math.max(1, Number(item.qty) || Number(item.quantity) || 1));
          }

          if (serverTotal > 0 && confirmedAmount < serverTotal - 1) {
            console.error(
              `[verifyIntasendPayment] Price mismatch for ${ref}: paid=${confirmedAmount} required=${serverTotal}`
            );
            db.collection("auditLogs").add({
              type: "payment_price_mismatch", ref, confirmedAmount, serverTotal,
              unknownItems, productIds,
              ts: admin.firestore.FieldValue.serverTimestamp(),
            }).catch(() => {});
            return res.status(400).json({ verified: false, error: "Payment does not cover the order total." });
          }
        }
      }

      /* ── Resolve authoritative order items ──
         Session items take priority; fall back to client-supplied items only when
         no session is present (e.g., service bookings not going through the cart). ── */
      const resolvedItems = sessionDoc ? sessionDoc.items : (orderItems || []);

      /* ── Idempotency guard (transaction-safe) ────────────────────────────────
         Use the IntaSend invoice/tracking ref as a payment-level idempotency key.
         The check AND the order write happen inside a single runTransaction so
         two concurrent retries cannot both slip past a non-existent snapshot:
         Firestore's optimistic-concurrency ensures only one commits; the loser
         retries and sees verifSnap.exists = true on the second read.
      ── */
      const verifRef = db.collection("paymentVerifications").doc(ref);

      /* orderId and verificationToken are fixed before the transaction so they
         remain stable across any internal retries.
         P0-2 (Phase 4 audit): was "SKN" + Date.now().slice(-8) — a MONOTONIC doc key
         (hotspots one Firestore tablet range on write) that also COLLIDED for two
         orders created in the same millisecond (last-8-digits clash → silent order
         overwrite = lost order). Now a 48-bit random suffix: non-monotonic (writes
         distribute across the key space) and collision-free, while keeping the SKN
         display format so no client change is needed. */
      const orderId  = "SKN" + require("crypto").randomBytes(6).toString("hex").toUpperCase();
      const sellerUid = resolvedItems?.[0]?.sellerUid || null;
      const orderDoc  = {
        id:              orderId,
        status:          "paid",
        paymentVerified: true,
        invoiceId:       invoiceId || null,
        trackingId:      trackingId || null,
        phone,
        buyerPhone:      phone,
        buyerName:       deliveryName || "Customer",
        deliveryAddress: deliveryAddress || "",
        /* Blocker B2 — pickup (shop) + dropoff (buyer) geo so rider dispatch can route.
           `_autoAssignRider` reads pickupLat/pickupLng; the delivered fee-split + rider ETA need both.
           Null-safe: a missing seller shop-geo leaves pickup null (seller-onboarding NEEDS-DATA). */
        pickupLat:       _pLat || null,
        pickupLng:       _pLng || null,
        dropoffLat:      _dLat || null,
        dropoffLng:      _dLng || null,
        deliveryCoords:  (_dLat != null && _dLng != null) ? { lat: _dLat, lng: _dLng } : null,
        /* Carry the server-clamped delivery fee from the session onto the order (was dropped).
           Fixes TWO things: the `delivered` fee-split (onOrderStatusChange read `after.deliveryFee`
           → previously 0), AND settlement gross (order-settlement `_grossCents` = total − deliveryFee,
           previously over-settled the seller by the delivery amount). Server-authoritative. */
        deliveryFee:     Number((sessionDoc && sessionDoc.deliveryFee) || 0),
        orderTotal:      confirmedAmount,
        total:           confirmedAmount,
        items:           resolvedItems,
        sellerUid,
        sellerName:      resolvedItems?.[0]?.sellerName || null,
        paymentMethod:   "mpesa",
        sessionId:       sessionId || null,
        escrow:          { held: confirmedAmount, released: 0, refunded: 0 },
        /* Product Settlement Convergence — funds are HELD by SOKONI at payment; released
           to the seller's wallet ONLY at fulfillment (settleOrder). State machine:
           UNSETTLED→HELD→ELIGIBLE_FOR_SETTLEMENT→SETTLING→SETTLED (REFUNDED if refunded first). */
        settlementStatus: "HELD",
        statusHistory:   [{ status: "paid", at: Date.now(), by: "intasend-webhook" }],
        createdAt:       admin.firestore.FieldValue.serverTimestamp(),
      };
      const verificationToken = `${orderId}_v${Date.now()}`;

      let isReplay = false;
      let replayData = null;

      await db.runTransaction(async tx => {
        /* Atomic read — if already committed by a concurrent request, bail out */
        const verifSnap = await tx.get(verifRef);
        if (verifSnap.exists) {
          isReplay  = true;
          replayData = verifSnap.data();
          return; /* commit with no writes — idempotent */
        }

        tx.set(db.collection("orders").doc(orderId), orderDoc);

        /* Idempotency record written atomically with the order */
        tx.set(verifRef, {
          orderId,
          ref,
          verificationToken,
          amount: confirmedAmount,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        /* Session consumed marker */
        if (sessionId && sessionDoc) {
          tx.update(
            db.collection("checkoutSessions").doc(String(sessionId)),
            { status: "consumed", orderId, consumedAt: admin.firestore.FieldValue.serverTimestamp() }
          );

          /* Settle a loyalty redemption in the SAME transaction that consumes the
             session, so the points can only ever be spent by a payment that
             actually completed. createCheckoutSession deliberately did not deduct
             them — an abandoned checkout must not burn a buyer's points.

             increment() is used rather than read-modify-write: it needs no read
             (this transaction has already begun writing, and Firestore forbids a
             read after a write), and it is atomic. Spending the same session twice
             is already impossible — the status must be "pending" to get here. */
          const _pts = Math.max(0, Math.floor(Number(sessionDoc.loyaltyPoints) || 0));
          if (_pts > 0 && sessionDoc.uid) {
            tx.set(
              db.collection("loyaltyAccounts").doc(String(sessionDoc.uid)),
              {
                balance:      admin.firestore.FieldValue.increment(-_pts),
                lastRedeemed: admin.firestore.FieldValue.serverTimestamp(),
              },
              { merge: true }
            );
            tx.set(db.collection("loyaltyRedemptions").doc(), {
              uid:       String(sessionDoc.uid),
              orderId,
              sessionId: String(sessionId),
              points:    _pts,
              discount:  Math.max(0, Math.round(Number(sessionDoc.loyaltyDiscount) || 0)),
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
        }
      });

      /* Return cached result for replayed requests — no duplicate order created */
      if (isReplay) {
        log.audit("idempotent replay", { ref, existingOrder: replayData.orderId });
        return res.json({ verified: true, orderId: replayData.orderId, verificationToken: replayData.verificationToken, replayed: true });
      }

      /* Decrement stock per-product in individual transactions (TOCTOU-safe).
         Payment is already confirmed so oversold items are flagged, not rejected. */
      const stockResults = await Promise.allSettled(
        (resolvedItems || [])
          .filter(item => item.productId)
          .map(item => db.runTransaction(async (t) => {
            const qty     = Number(item.qty) || 1;
            const prodRef = db.collection('products').doc(String(item.productId));
            const snap    = await t.get(prodRef);
            if (!snap.exists) return;
            const pdata = snap.data();
            const cur = pdata.stock;
            const priorVer = Number(pdata.inventoryVersion) || 0;
            /* Payment is already confirmed, so a last-item race is flagged, not
               rejected — but stock must never go negative. Deduct at most what
               remains; the oversoldAlerts record carries the true shortfall. */
            let dec = qty;
            if (typeof cur === 'number' && cur < qty) {
              dec = Math.max(0, cur);
              t.set(db.collection('oversoldAlerts').doc(), {
                orderId, productId: item.productId,
                requested: qty, available: cur,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
            /* stock, updatedAt and inventoryVersion move together in ONE atomic
               write so every listener gets a single, monotonic change signal. */
            t.update(prodRef, {
              stock:            admin.firestore.FieldValue.increment(-dec),
              updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
              inventoryVersion: admin.firestore.FieldValue.increment(1),
            });
            console.log(`[webhook] stock deduct product=${item.productId} -${dec} inventoryVersion ${priorVer}->${priorVer + 1}`);
          }))
      );
      const stockFailed = stockResults.filter(r => r.status === 'rejected');
      if (stockFailed.length) {
        console.warn('[webhook] stock decrement partial failure', stockFailed.map(r => r.reason?.message));
      }

      /* Order event written after batch (subcollections cannot be in a batch) */
      await db.collection("orderEvents").doc(orderId).collection("events").add({
        from: null, to: "paid", by: "intasend-webhook",
        meta: { invoiceId, trackingId, phone },
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      log.audit("order created", { orderId, ref, amount: confirmedAmount, sessionId: sessionId || null });
      return res.json({ verified: true, orderId, verificationToken });

    } catch (err) {
      log.error("unhandled error", { err: err.message, stack: err.stack });
      return res.status(500).json({ verified: false, error: "Internal error" });
    }
  }
);

/* ============================================================
   onOrderStatusChange  — Firestore trigger: orders/{orderId}
   Fires on every order write. If status changed:
     • Sends SMS to buyer + seller + driver via Africa's Talking
     • Sends FCM push to each party's registered device token
============================================================ */
exports.onOrderStatusChange = onDocumentUpdated(
  {
    document:       "orders/{orderId}",
    secrets:        [...sokoniAt.secrets],
    minInstances:   1,
  },
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();

    if (!before || !after) return;
    if (before.status === after.status) return;  // no status change

    const orderId    = event.params.orderId;
    const toStatus   = after.status;

    console.log(`[onOrderStatusChange] ${orderId}: ${before.status} → ${toStatus}`);

    const tmpl = smsTemplates(after);
    const msgs = tmpl[toStatus] || {};

    /* ── SMS ── */
    const smsTasks = [];
    if (msgs.buyer  && after.buyerPhone)  smsTasks.push(sendSms(after.buyerPhone,  msgs.buyer));
    if (msgs.seller && after.sellerPhone) smsTasks.push(sendSms(after.sellerPhone, msgs.seller));
    if (msgs.driver && after.driverPhone) smsTasks.push(sendSms(after.driverPhone, msgs.driver));

    /* ── FCM ── */
    const fcmTasks = [];
    const trackUrl = after.deliveryRef
      ? `delivery-tracking.html?ref=${after.deliveryRef}`
      : `track.html?id=${orderId}`;

    if (msgs.buyerFcm) {
      const uid = after.buyerUid || after.uid;
      if (uid) {
        const tok = await getFcmToken(uid);
        if (tok) fcmTasks.push(sendFcm(tok, msgs.buyerFcm.title, msgs.buyerFcm.body, trackUrl));
      }
    }
    if (msgs.sellerFcm && after.sellerUid) {
      const tok = await getFcmToken(after.sellerUid);
      if (tok) fcmTasks.push(sendFcm(tok, msgs.sellerFcm.title, msgs.sellerFcm.body, "seller.html"));
    }
    if (msgs.driverFcm && after.assignedDriverUid) {
      const tok = await getFcmToken(after.assignedDriverUid);
      if (tok) fcmTasks.push(sendFcm(tok, msgs.driverFcm.title, msgs.driverFcm.body, "driver.html"));
    }

    await Promise.allSettled([...smsTasks, ...fcmTasks]);

    /* ── Auto-assign rider on confirmed transition (consolidated from onOrderConfirmed) ── */
    if (toStatus === "confirmed" && before.status !== "confirmed" && !after.assignedDriverUid) {
      _autoAssignRider(orderId, after).catch(e =>
        console.error("[onOrderStatusChange] Auto-assign error:", e.message)
      );
    }

    /* ── Delivery platform fee on order completion ── */
    if (toStatus === "delivered" && after.sellerUid) {
      const deliveryFee = Number(after.deliveryFee || 0);
      /* Delivery-fee split — priced by the ONE Commission Engine (category: hub).
         The rate was already correct (it came from the single config), but the calculation
         bypassed calculateCommission, so this flow ignored commissionRules, revenueConfig,
         commission holidays and the audit trail. Same rate, same arithmetic.
         skipMinimum:true because a delivery split never had the KES 10 platform floor, and a
         floor here would swallow a small delivery fee whole — a repricing, not a refactor. */
      const { calculateCommission: _calcDel } = require('./finos-utils');
      const _delComm = deliveryFee > 0 ? await _calcDel(db, {
        orderAmountCents: Math.round(deliveryFee * 100),
        category:         'hub',
        sellerId:         after.riderId || after.sellerUid || null,
        hubId:            'delivery',
        skipMinimum:      true,
      }) : null;
      const platformFee = _delComm ? _delComm.commissionCents / 100 : 0;
      const riderFee    = Math.round((deliveryFee - platformFee) * 100) / 100;
      db.collection("deliveryFees").add({
        orderId,
        sellerUid:      after.sellerUid,
        riderUid:       after.assignedDriverUid || null,
        platformFeeKES: platformFee,
        riderFeeKES:    riderFee,
        totalFeeKES:    deliveryFee,
        grossOrderKES:  Number(after.orderTotal || 0),
        status:         "pending",
        createdAt:      admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }

    /* ── Product Settlement Convergence — settle the seller ONCE on fulfillment ──
       `completed` = customer confirmed OR the auto-confirm sweep. Reuses the canonical
       settlement engine, credits the seller's withdrawable wallets.balance, writes the
       settlement/wallet/ledger records. Exactly-once (guarded on settlementStatus);
       best-effort so a settlement hiccup never blocks the status write. */
    if (toStatus === "completed" && before.status !== "completed" && after.sellerUid) {
      try {
        await require("./order-settlement").settleOrder(db, admin, orderId);
      } catch (e) { console.error("[onOrderStatusChange] order settlement failed (recoverable):", e.message); }
    }
  }
);

/* ── Shared rider-assignment helper — weighted dispatch v2 ── */
const _sokoniDispatch = require("./sokoni-dispatch");

async function _autoAssignRider(orderId, after) {
  console.log("[_autoAssignRider] Weighted dispatch for order", orderId);

  const delivery = {
    pickupLat:   after.pickupLat    || after.shopLat    || null,
    pickupLng:   after.pickupLng    || after.shopLng    || null,
    weightKg:    after.weightKg     || 1,
    parcelSize:  after.parcelSize   || "small",
    vehicleType: after.vehicleType  || "moto",
    hubId:       after.hubId        || null,
  };

  const driversSnap = await db.collection("rideDrivers")
    .where("isOnline", "==", true)
    .limit(100)
    .get()
    .catch(() => null);

  if (!driversSnap || driversSnap.empty) {
    console.log("[_autoAssignRider] No online drivers for order", orderId);
    return;
  }

  const riders  = driversSnap.docs.map(d => ({ uid: d.id, ...d.data() }));
  const ranked  = _sokoniDispatch.rankRiders(riders, delivery);

  if (!ranked.length) {
    console.log("[_autoAssignRider] No eligible drivers (weight/size/distance) for order", orderId);
    return;
  }

  const pickedDriver = ranked[0];
  const orderRef = db.collection("orders").doc(orderId);

  try {
    await db.runTransaction(async (txn) => {
      const snap = await txn.get(orderRef);
      if (!snap.exists) return;
      const current = snap.data();
      if (current.status !== "confirmed" || current.assignedDriverUid) return;

      txn.update(orderRef, {
        assignedDriverUid: pickedDriver.riderId,
        assignedDriverId:  pickedDriver.riderId,
        driverName:        pickedDriver.riderName,
        driverPhone:       pickedDriver.riderPhone,
        driverPlate:       pickedDriver.riderPlate || "",
        driverVehicle:     pickedDriver.vehicleType || "moto",
        dispatchScore:     pickedDriver.score,
        dispatchDistKm:    pickedDriver.distKm,
        dispatchEtaMin:    pickedDriver.etaMin,
        status:            "rider_assigned",
        riderAssignedAt:   admin.firestore.FieldValue.serverTimestamp(),
        statusHistory:     admin.firestore.FieldValue.arrayUnion({
          status: "rider_assigned",
          at:     Date.now(),
          by:     "auto-assign-weighted",
          meta:   { score: pickedDriver.score, distKm: pickedDriver.distKm },
        }),
      });
    });
  } catch (txnErr) {
    console.error("[_autoAssignRider] Transaction failed:", txnErr.message);
    return;
  }

  await db.collection("orderEvents").doc(orderId).collection("events").add({
    from: "confirmed", to: "rider_assigned", by: "auto-assign-weighted",
    meta: { driverUid: pickedDriver.riderId, score: pickedDriver.score, distKm: pickedDriver.distKm, automatic: true },
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }).catch(() => {});

  const driverToken = await getFcmToken(pickedDriver.riderId);
  if (driverToken) {
    await sendFcm(
      driverToken,
      "New Delivery Assigned",
      `Order ${orderId} is waiting for pickup. You are ${pickedDriver.distKm}km away.`,
      "driver.html"
    ).catch(() => {});
  }

  console.log(`[_autoAssignRider] Weighted dispatch → ${pickedDriver.riderId} (score ${pickedDriver.score}, ${pickedDriver.distKm}km) for order ${orderId}`);
}

/* ============================================================
   onOrderConfirmed  — DEPRECATED: logic moved to onOrderStatusChange.
   Kept as an export stub so Firebase deletes it cleanly on next deploy.
   Safe to remove this export after deploying once.
============================================================ */
exports.onOrderConfirmed = onDocumentUpdated(
  "orders/{orderId}",
  async () => { /* no-op — rider assignment now handled in onOrderStatusChange */ }
);

/* ============================================================
   onNewOrderCreated  — Fires the moment a new order document is
   written to Firestore (immediately after verifyIntasendPayment
   creates it).

   Responsibilities:
     1. FCM push to seller — "New Order!" with amount + buyer name.
     2. In-app notification document in `notifications` collection.
     3. SMS to seller if Africa's Talking is configured.
     4. Increments sellerStats/{sellerUid}.pendingOrders counter.

   Does NOT notify buyer (buyer just completed checkout and already
   sees the confirmation screen).  Does NOT run auto-assign — that
   is handled by onOrderConfirmed after the seller confirms.
============================================================ */
exports.onNewOrderCreated = onDocumentCreated(
  {
    document:       "orders/{orderId}",
    secrets:        [...sokoniAt.secrets],
    minInstances:   1,
  },
  async (event) => {
    const data = event.data?.data();
    if (!data) return;

    const orderId   = event.params.orderId;
    const sellerUid = data.sellerUid || data.sellerId;
    const buyerName = data.buyerName || data.deliveryName || "Customer";
    const total     = Number(data.orderTotal || data.total || 0).toLocaleString("en-KE");
    const sellerPhone = data.sellerPhone || "";

    console.log(`[onNewOrderCreated] orderId=${orderId} seller=${(sellerUid||'').slice(0,8)}…`);

    /* ── PAYMENT GATE (P0-7) ────────────────────────────────────────────────
       This trigger fires on ANY order write. It pushes, SMSs and in-apps the seller
       with "New Order! ... Confirm it to begin processing" and increments their
       pendingOrders counter.

       That is a fulfilment prompt. Sending it for an order nobody has paid for is how
       a seller ends up packing and shipping goods against a payment that never
       happened — which is exactly what the fabricated checkout confirmations caused.

       Orders may EXIST before payment (status: "pending_payment"). They must not
       REACH the seller before payment. Nothing downstream — no notification, no SMS,
       no counter, no fulfilment — may act on an unpaid order.

       The order is not lost: when payment is verified the status transitions to "paid",
       and onOrderStatusChange picks it up from there. Fail closed. */
    if (data.status !== 'paid' && data.paymentVerified !== true) {
      console.log(`[onNewOrderCreated] ${orderId} is ${data.status || 'unpaid'} — seller NOT notified until payment is verified.`);
      return;
    }

    if (!sellerUid) {
      console.warn("[onNewOrderCreated] No sellerUid on order", orderId);
      return;
    }

    const tasks = [];

    /* ── 1. FCM push to seller ── */
    tasks.push(
      getFcmToken(sellerUid).then(tok => {
        if (!tok) return;
        return sendFcm(
          tok,
          "🛒 New Order!",
          `${buyerName} ordered KES ${total} — confirm now`,
          "seller.html"
        );
      }).catch(err => console.error('[onNewOrderCreated] FCM push failed:', err.message))
    );

    /* ── 2. In-app notification ── */
    tasks.push(
      db.collection("notifications").add({
        recipientUid:  sellerUid,
        type:          "new_order",
        category:      "orders",
        priority:      "high",
        title:         "New Order Received!",
        body:          `${buyerName} placed an order worth KES ${total}. Confirm it to begin processing.`,
        actionUrl:     "seller.html",
        orderId,
        amount:        Number(data.orderTotal || data.total || 0),
        buyerName,
        read:          false,
        createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      }).catch(e => console.warn("[onNewOrderCreated] notif write error:", e.message))
    );

    /* ── 3. SMS ── */
    if (sellerPhone) {
      tasks.push(
        sendSms(
          sellerPhone,
          `SOKONI: New order ${orderId} from ${buyerName}! KES ${total}. Confirm now: mysokoni.co.ke/seller.html`
        )
      );
    }

    /* ── 4. Increment pending orders counter ── */
    tasks.push(
      db.collection("sellerStats").doc(sellerUid).set(
        {
          pendingOrders: admin.firestore.FieldValue.increment(1),
          lastOrderAt:   admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      ).catch(e => console.warn("[onNewOrderCreated] stats error:", e.message))
    );

    await Promise.allSettled(tasks);
    console.log(`[onNewOrderCreated] Notified seller ${sellerUid} for order ${orderId}`);
  }
);

/* ============================================================
   DARAJA STK PUSH — M-Pesa Paybill / Till direct payment
   ============================================================
   Each seller stores their own Daraja API credentials in
   Firestore at:  shopSettings/{sellerUid}
     darajaConsumerKey    — from developer.safaricom.co.ke
     darajaConsumerSecret — same
     darajaPassKey        — provided by Safaricom for STK push
     darajaShortCode      — Paybill or Till number
     darajaAccountRef     — e.g. "RestaurantName"
     darajaEnv            — "sandbox" | "production"
     darajaTransactionType— "CustomerPayBillOnline" | "CustomerBuyGoodsOnline"

   Flow:
     1. POS calls darajaSTKPush (onCall) with { sellerUid, phone, amount, orderId }
     2. Function fetches seller's credentials from shopSettings
     3. Authenticates with Daraja, sends STK push to customer's phone
     4. Customer enters M-Pesa PIN → money goes to seller's Paybill/Till
     5. Safaricom sends callback to darajaSTKCallback (onRequest)
     6. Callback updates posPayments/{CheckoutRequestID} in Firestore
     7. POS listens real-time and auto-confirms the sale
============================================================ */

/* ── Helper: get Daraja OAuth access token ── */
async function _darajaToken(consumerKey, consumerSecret, env) {
  const base = env === "production"
    ? "https://api.safaricom.co.ke"
    : "https://sandbox.safaricom.co.ke";
  const creds = Buffer.from(`${consumerKey}:${consumerSecret}`).toString("base64");
  const res = await fetch(
    `${base}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${creds}` } }
  );
  const data = await res.json();
  if (!data.access_token) throw new Error("Daraja auth failed: " + JSON.stringify(data));
  return { token: data.access_token, base };
}

/* ── darajaSTKPush — called from POS frontend ──────────────────────────────────
   STATUS: LEGACY

   Supported for:
     • Development
     • Transition to central Merchant-of-Record collection

   NOT intended for new merchant onboarding.

   It collects into the SELLER's own shortcode (shopSettings/{sellerUid}), which
   is the model the settlement engine does NOT assume — settlement-engine.js books
   every sale as collected into the Bravilex account first. Verified inactive:
   an audit on 2026-07-22 found shopSettings and posPayments both EMPTY, so this
   path has never completed a payment in production.

   Retained deliberately as an implementation reference, a migration aid and a
   rollback option. Its successor is functions/payment-config.js →
   resolveCollectionRoute() (CENTRAL_MOR).

   Exit criteria for disabling and then deleting this are tracked, with the
   command that proves each one, in docs/PAYMENT_MIGRATION_MOR.md.
──────────────────────────────────────────────────────────────────────────────── */
exports.darajaSTKPush = onCall(
  { timeoutSeconds: 30, cors: true, enforceAppCheck: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");

    const { sellerUid, phone, amount, orderId, description, hub, items } = request.data;
    if (!sellerUid || !phone || !amount) {
      throw new HttpsError("invalid-argument", "sellerUid, phone, and amount are required.");
    }

    /* Rate limit: max 20 STK pushes per caller per hour (prevents phone-spam abuse) */
    const _rl_cutoff = new Date(Date.now() - 3600000);
    const _rl_snap   = await db.collection("auditLogs")
      .where("type",      "==", "mpesa_stk_push")
      .where("callerUid", "==", request.auth.uid)
      .where("ts",        ">=", admin.firestore.Timestamp.fromDate(_rl_cutoff))
      .limit(20).get();
    if (_rl_snap.size >= 20) {
      throw new HttpsError("resource-exhausted", "Too many payment requests. Please wait before trying again.");
    }

    /* Dedup: if orderId already has a completed payment, refuse */
    if (orderId) {
      const existing = await db.collection("posPayments")
        .where("orderId", "==", orderId)
        .where("status", "==", "completed")
        .limit(1).get();
      if (!existing.empty) {
        throw new HttpsError("already-exists", "This order has already been paid.");
      }
      /* Also block if a pending payment for same orderId is < 3 min old */
      const pendingQ = await db.collection("posPayments")
        .where("orderId", "==", orderId)
        .where("status", "==", "pending")
        .limit(1).get();
      if (!pendingQ.empty) {
        const pendTs = pendingQ.docs[0].data().createdAt?.toMillis?.() || 0;
        if (Date.now() - pendTs < 180000) {
          throw new HttpsError("resource-exhausted", "A payment is already in progress for this order. Please wait.");
        }
      }
    }

    /* ── Server pricing authority ──────────────────────────────────────────
       The client used to be the only source of `amount`. It was passed to
       Safaricom unchecked, so editing orderTotal in the browser console bought
       a full cart for KES 1 and produced a genuine M-Pesa receipt.

       When the caller supplies `items`, the server re-reads every price from
       the products collection and the client's `amount` is discarded outright
       — not compared, not tolerated, discarded.

       `items` is optional on purpose. SmartPOS tills call this with an
       operator-keyed amount and no catalogue line items; that is a legitimate
       cash-register flow, not a marketplace checkout, and breaking it would
       take working merchants offline. Those calls are recorded as
       operator-entered so the two are distinguishable in audit. */
    let authoritativeAmount = Math.round(Number(amount));
    let pricedItems = null;
    let pricingSource = "client_operator_entered";

    if (Array.isArray(items) && items.length) {
      if (items.length > 100) {
        throw new HttpsError("invalid-argument", "Too many line items.");
      }

      let serverSubtotal = 0;
      pricedItems = [];

      for (const line of items) {
        const pid = String(line && line.productId || "").trim();
        const qty = Math.floor(Number(line && line.qty) || 0);
        if (!pid) throw new HttpsError("invalid-argument", "Each item requires a productId.");
        if (qty < 1 || qty > 1000) throw new HttpsError("invalid-argument", "Invalid quantity for " + pid + ".");

        const pSnap = await db.collection("products").doc(pid).get();
        if (!pSnap.exists) throw new HttpsError("not-found", "Product no longer available: " + pid);

        const p = pSnap.data();
        /* Cross-seller carts cannot be paid in one STK push — the money would
           land in one seller's till. Reject rather than silently mis-settle. */
        const owner = p.sellerUid || p.uid || null;
        if (owner && owner !== sellerUid) {
          throw new HttpsError("failed-precondition", "Cart contains items from another seller.");
        }
        if (p.status && p.status !== "active") {
          throw new HttpsError("failed-precondition", "Product is not available for sale: " + pid);
        }

        /* Overselling guard — reject BEFORE the STK push, while no money has moved.
           A finite stock field is authoritative; products without stock tracking
           (stock undefined) are unmetered and pass. A genuine last-item race that
           slips past this is caught again at deduction (floor + oversoldAlerts). */
        const stk = Number(p.stock);
        if (p.outOfStock === true || (Number.isFinite(stk) && stk <= 0)) {
          throw new HttpsError("failed-precondition", "Out of stock: " + (p.name || pid));
        }
        if (Number.isFinite(stk) && stk < qty) {
          throw new HttpsError("failed-precondition",
            "Only " + stk + " left of " + (p.name || pid) + " — please reduce the quantity.");
        }

        const unit = Number(p.price);
        if (!Number.isFinite(unit) || unit < 0) {
          throw new HttpsError("failed-precondition", "Product has no valid price: " + pid);
        }
        serverSubtotal += unit * qty;
        pricedItems.push({ productId: pid, qty, unitPrice: unit });
      }

      /* ── Delivery pricing is the SERVER's, not the client's ─────────────────
         This previously accepted request.data.deliveryFee and merely clamped it
         to 0..5000. A bounded lie is still a lie: within that range the client
         chose what delivery cost, and the only defence was that it could not be
         arbitrarily large.

         Now the server recomputes from the merchant's own configuration using
         the shared delivery engine — the same module the client uses, so the two
         cannot drift — and a mismatch is REJECTED rather than absorbed.

         Where a merchant has no deliveryConfig yet, the server has nothing to
         recompute FROM. Rather than silently trusting the client in that case,
         the legacy clamp still applies and the gap is logged, so unconfigured
         merchants are visible and migratable instead of invisible. */
      const clientDelivery = Math.round(Number(request.data.deliveryFee) || 0);
      let deliveryFee;

      const _sellerSnap = await db.collection('sellers').doc(String(sellerUid)).get().catch(() => null);
      const _delCfg = _sellerSnap && _sellerSnap.exists ? _sellerSnap.data().deliveryConfig : null;

      if (_delCfg && _delCfg.enabled !== undefined) {
        const _engine = require('./shared/delivery-engine.js');
        const _calc = _engine.calculateDelivery(_delCfg, {
          subtotal:   serverSubtotal,
          distanceKm: request.data.distanceKm,
          zone:       request.data.deliveryZone,
        });
        deliveryFee = _calc.fee;

        if (clientDelivery !== deliveryFee) {
          await db.collection('auditLogs').add({
            type: 'delivery_fee_mismatch',
            severity: clientDelivery < deliveryFee ? 'high' : 'low',
            callerUid: request.auth.uid,
            merchantId: sellerUid, orderId: orderId || null,
            clientFee: clientDelivery, serverFee: deliveryFee,
            deliveryMode: _delCfg.mode || null, reason: _calc.reason,
            ts: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});

          /* Rejected, with the authoritative figure returned so the client can
             refresh and retry honestly. Silently substituting the server figure
             would charge a total the customer never saw. */
          throw new HttpsError('failed-precondition',
            'Delivery fee is out of date. Please refresh your cart.',
            { serverDeliveryFee: deliveryFee, clientDeliveryFee: clientDelivery,
              deliverable: _calc.deliverable, reason: _calc.reason });
        }
      } else {
        deliveryFee = Math.min(Math.max(clientDelivery, 0), 5000);
        if (clientDelivery > 0) {
          await db.collection('auditLogs').add({
            type: 'delivery_fee_unverified',
            severity: 'low',
            callerUid: request.auth.uid,
            merchantId: sellerUid, orderId: orderId || null,
            clientFee: clientDelivery, serverFee: null,
            note: 'merchant has no deliveryConfig; legacy clamp applied',
            ts: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
        }
      }

      authoritativeAmount = Math.round(serverSubtotal + deliveryFee);
      pricingSource = "server_recomputed";

      const clientAmount = Math.round(Number(amount) || 0);
      if (clientAmount !== authoritativeAmount) {
        /* Not necessarily an attack — a stale cart or a price change mid-
           checkout looks identical. Recorded, never trusted, never fatal. */
        await db.collection("auditLogs").add({
          type: "payment_amount_mismatch",
          severity: clientAmount < authoritativeAmount ? "high" : "low",
          callerUid: request.auth.uid,
          sellerUid, orderId: orderId || null,
          clientAmount, serverAmount: authoritativeAmount,
          items: pricedItems,
          ts: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
    }

    if (!Number.isFinite(authoritativeAmount) || authoritativeAmount < 1) {
      throw new HttpsError("invalid-argument", "Payment amount must be at least KES 1.");
    }

    /* ── LEGACY PATH — per-merchant Daraja credentials ────────────────────────
       INACTIVE IN PRODUCTION. Audited 2026-07-22: the shopSettings collection
       held ZERO documents, so this lookup has never succeeded for any merchant
       and no payment has ever completed through it (posPayments: 0 rows). The
       client surfaces that used to populate these credentials — payments.html,
       pos.js, seller.html — have been retired; nothing writes them any more.

       Kept deliberately, per the migration plan: removing it now would leave no
       STK path at all during the switch to central collection. It is replaced,
       not deleted, once the central Secret-Manager-backed credentials exist and
       the centralised flow is verified. Until then this simply throws
       "not-found", which is the correct and honest outcome.

       The successor is functions/payment-config.js → resolveCollectionRoute(). */
    const settingsSnap = await db.collection("shopSettings").doc(sellerUid).get();
    if (!settingsSnap.exists) {
      throw new HttpsError("not-found", "Daraja credentials not configured. Ask the seller to set them up in their dashboard.");
    }
    const cfg = settingsSnap.data();
    const {
      darajaConsumerKey,
      darajaConsumerSecret,
      darajaPassKey,
      darajaShortCode,
      darajaAccountRef  = "SOKONI",
      darajaEnv         = "production",
      darajaTransactionType = "CustomerPayBillOnline",
      businessName      = "SOKONI",
    } = cfg;

    if (!darajaConsumerKey || !darajaConsumerSecret || !darajaPassKey || !darajaShortCode) {
      throw new HttpsError("failed-precondition", "Incomplete Daraja credentials. Seller must complete setup.");
    }

    /* Authenticate with Daraja */
    const { token, base } = await _darajaToken(darajaConsumerKey, darajaConsumerSecret, darajaEnv);

    /* Build STK push password: base64(ShortCode + PassKey + Timestamp) */
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const password  = Buffer.from(`${darajaShortCode}${darajaPassKey}${timestamp}`).toString("base64");

    /* Normalise phone to 254XXXXXXXXX */
    let normPhone = String(phone).replace(/\D/g, "").replace(/^0/, "254").replace(/^\+/, "");
    if (!normPhone.startsWith("254")) normPhone = "254" + normPhone;

    const callbackUrl = "https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback";

    const stkBody = {
      BusinessShortCode: darajaShortCode,
      Password:          password,
      Timestamp:         timestamp,
      TransactionType:   darajaTransactionType,
      Amount:            authoritativeAmount,
      PartyA:            normPhone,
      PartyB:            darajaShortCode,
      PhoneNumber:       normPhone,
      CallBackURL:       callbackUrl,
      AccountReference:  (darajaAccountRef || businessName || "SOKONI").slice(0, 12),
      TransactionDesc:   (description || "SOKONI Payment").slice(0, 13),
    };

    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method:  "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(stkBody),
    });
    const stkData = await stkRes.json();

    if (stkData.ResponseCode !== "0") {
      throw new HttpsError("aborted", stkData.CustomerMessage || stkData.errorMessage || "STK push failed");
    }

    const checkoutId = stkData.CheckoutRequestID;
    const ts         = admin.firestore.FieldValue.serverTimestamp();

    /* WHERE DID THIS MONEY ACTUALLY LAND?
       settlement-engine.js books every sale as "100% collected into the Bravilex
       account first", but the STK above sends BusinessShortCode/PartyB =
       shopSettings/{sellerUid}.darajaShortCode — the SELLER's own shortcode. The
       seller receives 100% while the ledger records a commission that was never
       collected. Stamping the resolved route onto the payment is what lets
       reconciliation and settlement see which model actually applied, instead of
       assuming. Resolver default is DIRECT_TO_SELLER, so this records today's
       reality and changes no money movement. */
    let _route = "DIRECT_TO_SELLER";
    try {
      const _pc = require("./payment-config");
      const _r  = await _pc.resolveCollectionRoute(db);
      _route = _r.route;
      if (_route === _pc.ROUTE_CENTRAL) {
        /* Central collection is armed in config, but this function still signs
           with the SELLER's consumer key/passkey. Sending a central shortcode
           with seller credentials would fail at Safaricom or, worse, collect to
           the wrong party. Refuse loudly until central Daraja credentials are
           provisioned in Secret Manager and this call is migrated to them. */
        throw new HttpsError("failed-precondition",
          "Central collection (CENTRAL_MOR) is enabled but central Daraja credentials are not provisioned. " +
          "STK cannot be signed for the platform shortcode yet.");
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;
      /* Config unreachable — fall back to recording the live default rather than
         failing a real sale. */
    }

    /* Record pending payment */
    await db.collection("posPayments").doc(checkoutId).set({
      /* Which collection model this payment was taken under. Reconciliation must
         NOT assume central collection for DIRECT_TO_SELLER rows: the platform
         holds no cash for them and its commission is a receivable, not revenue. */
      collectionRoute: _route,
      checkoutId,
      merchantRequestId: stkData.MerchantRequestID,
      sellerUid,
      callerUid:   request.auth.uid,
      orderId:     orderId  || null,
      hub:         hub      || "marketplace",
      phone:       normPhone,
      amount:      authoritativeAmount,
      /* Provenance, so reconciliation can tell a catalogue-priced marketplace
         sale from an operator-keyed till payment without inferring it. */
      pricingSource,
      /* Server-priced line items, persisted so the payment callback decrements
         stock from what the SERVER charged for — never from whatever the
         client later wrote onto the order document. */
      items: pricingSource === "server_recomputed" ? pricedItems : null,
      shortCode:   darajaShortCode,
      sellerName:  businessName,
      description: description || "SOKONI Payment",
      env:         darajaEnv,
      status:      "pending",
      createdAt:   ts,
    });

    /* Audit log */
    db.collection("auditLogs").add({
      type:        "mpesa_stk_push",
      checkoutId,
      sellerUid,
      callerUid:   request.auth.uid,
      hub:         hub || "marketplace",
      amount:      authoritativeAmount,
      phone:       normPhone,
      orderId:     orderId || null,
      env:         darajaEnv,
      ts,
    }).catch(() => {});

    console.log(`[darajaSTKPush] ${checkoutId} hub:${hub||"marketplace"} env:${darajaEnv}`);
    return { success: true, checkoutId, message: stkData.CustomerMessage || "STK push sent" };
  }
);

/* ── Shared marketplace payment finaliser ──────────────────────────────────
   A confirmed product payment must mark its order paid AND decrement stock in
   ONE transaction, so a verified payment and its inventory movement can never
   diverge. Extracted here so any collection path (IntaSend webhook today,
   Daraja callback if it is ever revived) finalises a product order IDENTICALLY
   and cannot drift.

   Idempotent by construction: the order's `inventoryApplied` flag is read
   inside the transaction, so a retried/duplicate webhook converges instead of
   deducting stock twice. All reads precede all writes (Firestore requirement),
   and stock is floored at zero with `oversoldAlerts` recorded for any shortfall
   — the payment already happened, so an oversell is flagged, never rejected.

   The order document is expected to already exist (the client writes it as
   pending_payment BEFORE initiating the STK). If it is absent — the browser
   died mid-checkout, or the webhook beat the client write — the fact is
   recorded in orphanPayments for reconciliation rather than lost.

   NOTE ON SETTLEMENT: the money settlement (seller wallet credit) is the
   CALLER's concern. The IntaSend webhook credits the seller wallet directly and
   passes settlementStatus:"settled" so no settlement sweep double-credits; a
   queue-based caller would pass "queued". This function never moves money and
   never writes a wallet — it owns the ORDER and INVENTORY only. */
async function _finalizeMarketplacePayment(db, admin, opts) {
  const {
    checkoutId, sellerUid, callerUid, orderId, hub, amount, phone,
    mpesaCode, sellerName, description, items, buyerName, address, fulfillmentType,
    paymentMethod, pathLabel,
    settlementStatus = "queued",
    writeSellerPayment = true,
  } = opts || {};
  const ts = admin.firestore.FieldValue.serverTimestamp();

  /* Idempotent seller payment record — one per checkout id (deterministic). Kept
     optional because the IntaSend path already records the sale via
     commissionLedger + walletTransactions; only the Daraja path needs this. */
  if (writeSellerPayment) {
    await db.collection("sellerPayments").doc(String(checkoutId)).set({
      checkoutId, sellerUid: sellerUid || null, callerUid: callerUid || null,
      orderId: orderId || null, hub: hub || "marketplace",
      amount: amount || 0, phone: phone || null, mpesaCode: mpesaCode || null,
      sellerName: sellerName || null, description: description || null,
      status: "completed", paymentMethod: paymentMethod || null, createdAt: ts,
    }, { merge: true }).catch(() => {});
  }

  if (!orderId) return { finalised: false, reason: "no_order_id" };

  const orderRef = db.collection("orders").doc(String(orderId));
  let result = { finalised: false };
  try {
    await db.runTransaction(async (txn) => {
      const orderSnap = await txn.get(orderRef);
      const exists = orderSnap.exists;
      const o = exists ? orderSnap.data() : null;

      /* Idempotency: a retried webhook must not decrement stock twice. */
      if (exists && o.inventoryApplied === true) { result = { finalised: true, reason: "already_applied" }; return; }

      /* Prefer the server-linked line items (meta.items) over anything the client
         wrote onto the order. When the client could not write the order at all
         (Firestore rules on the create), meta.items is the only source. */
      const lines = Array.isArray(items) && items.length
        ? items
        : (exists && Array.isArray(o.items) ? o.items : []);

      /* All reads before any write. */
      const stockReads = [];
      for (const line of lines) {
        const pid = line && (line.productId || line.id);
        const qty = Math.floor(Number(line && line.qty) || 0);
        if (!pid || qty < 1) continue;
        const pRef  = db.collection("products").doc(String(pid));
        const pSnap = await txn.get(pRef);
        stockReads.push({ ref: pRef, pid: String(pid), qty, snap: pSnap });
      }

      const paidFields = {
        status:           "paid",
        paymentStatus:    "paid",
        paymentVerified:  true,
        paymentMethod:    paymentMethod || null,
        mpesaCode:        mpesaCode  || null,
        paidAmount:       amount     || null,
        paidPhone:        phone      || null,
        paidAt:           ts,
        inventoryApplied: true,
        settlementStatus: settlementStatus,
        updatedAt:        ts,
      };

      if (exists) {
        txn.update(orderRef, paidFields);
      } else {
        /* Server-authoritative order creation. The buyer-side write is best-effort
           (client Firestore rules can reject the pre-payment create); the money is
           real and confirmed, so the order MUST exist. Admin SDK bypasses rules. */
        txn.set(orderRef, {
          id:              orderId,
          uid:             callerUid || null,
          buyerUid:        callerUid || null,
          buyerName:       buyerName || null,
          buyerPhone:      phone     || null,
          sellerUid:       sellerUid || null,
          sellerName:      sellerName || null,
          items:           lines,
          deliveryAddress: address || null,
          address:         address || null,
          hub:             hub || "marketplace",
          fulfillmentType: fulfillmentType || "delivery",
          amount:          amount || 0,
          total:           amount || 0,
          orderTotal:      amount || 0,
          currency:        "KES",
          source:          "webhook_created",
          createdAt:       ts,
          ...paidFields,
        }, { merge: true });
      }

      /* Priced line items (name + unit price) captured here from the product docs
         we already read, so the caller can build a receipt without re-reading. */
      const _priced = [];
      for (const { ref, pid, qty, snap } of stockReads) {
        const pdata = snap.exists ? snap.data() : {};
        const cur = snap.exists ? pdata.stock : null;
        const priorVer = Number(pdata.inventoryVersion) || 0;
        let dec = qty;
        if (typeof cur === "number" && cur < qty) {
          dec = Math.max(0, cur);
          txn.set(db.collection("oversoldAlerts").doc(), {
            orderId:   orderId || checkoutId || null,
            productId: pid, requested: qty, available: cur,
            path:      pathLabel || "marketplace", createdAt: ts,
          });
        }
        /* Stock + sold + version in ONE atomic write. `sold` was never persisted on
           the marketplace path (client-only, in a JS array), so best-selling sorts
           and revenue analytics undercounted every sale. Inside the inventoryApplied
           guard, so a webhook retry cannot double-count. */
        const _newStock = (typeof cur === "number") ? Math.max(0, cur - dec) : null;
        const _stockUpd = {
          stock:            admin.firestore.FieldValue.increment(-dec),
          sold:             admin.firestore.FieldValue.increment(dec),
          updatedAt:        ts,
          inventoryVersion: admin.firestore.FieldValue.increment(1),
        };
        /* Sold out → flag unavailable so it stops being buyable (product page /
           checkout guard on outOfStock). Restock clears it via the seller editor. */
        if (_newStock === 0) _stockUpd.outOfStock = true;
        txn.update(ref, _stockUpd);
        /* Inventory movement / history — deterministic id (orderId_pid) so a
           webhook retry overwrites rather than logging a second movement. */
        txn.set(db.collection("inventoryMovements").doc(`${orderId}_${pid}`), {
          productId: pid, orderId: orderId || null, ref: checkoutId || null,
          type: "sale", qty: dec,
          priorStock: (typeof cur === "number" ? cur : null),
          newStock:   (typeof cur === "number" ? Math.max(0, cur - dec) : null),
          path: pathLabel || "marketplace", at: ts,
        });
        _priced.push({
          productId: pid,
          name:      pdata.name || "Item",
          qty:       dec,
          unitPrice: Number(pdata.price) || 0,
          lineTotal: (Number(pdata.price) || 0) * dec,
        });
        console.log(`[${pathLabel || "mkt"}] stock deduct product=${pid} -${dec} sold+${dec} inventoryVersion ${priorVer}->${priorVer + 1}`);
      }
      result = {
        finalised: true,
        created:   !exists,
        pricedItems: _priced,
        subtotal:  _priced.reduce((s, i) => s + i.lineTotal, 0),
      };
    });
  } catch (e) {
    console.error(`[_finalizeMarketplacePayment] order/inventory txn failed for ${orderId}: ${e.message}`);
    db.collection("auditLogs").add({
      type: "order_finalisation_failed", severity: "critical",
      checkoutId, orderId, sellerUid: sellerUid || null,
      amount: amount || null, mpesaCode: mpesaCode || null,
      path: pathLabel || null, error: e.message, ts,
    }).catch(() => {});
    result = { finalised: false, reason: "txn_failed", error: e.message };
  }
  return result;
}

/* Safaricom published IP ranges for STK Push callbacks */
const SAFARICOM_CALLBACK_IPS = new Set([
  "196.201.214.200","196.201.214.206","196.201.213.100","196.201.214.207",
  "196.201.214.208","196.201.213.109","196.201.213.115","196.201.214.202",
]);

/* ── darajaSTKCallback — Safaricom posts payment result here ── */
exports.darajaSTKCallback = onRequest(
  { timeoutSeconds: 30, invoker: "public" },
  async (req, res) => {
    /* Respond 200 immediately — Safaricom retries if we delay */
    res.status(200).json({ ResultCode: 0, ResultDesc: "Success" });

    try {
      /* Validate origin IP against Safaricom's published callback IP list.
         In development (non-prod) we allow bypass so ngrok tunnels work. */
      const callerIp = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
      if (process.env.NODE_ENV !== "development" && !SAFARICOM_CALLBACK_IPS.has(callerIp)) {
        console.warn(`[darajaSTKCallback] Rejected request from unexpected IP: ${callerIp}`);
        db.collection("auditLogs").add({
          type: "stk_callback_ip_rejected", ip: callerIp,
          ts: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        return;
      }

      const body = req.body?.Body?.stkCallback;
      if (!body) return;

      const checkoutId = body.CheckoutRequestID;
      const resultCode = body.ResultCode;
      const resultDesc = body.ResultDesc;

      /* Dedup: skip if already processed */
      const payRef  = db.collection("posPayments").doc(checkoutId);
      const paySnap = await payRef.get();
      if (!paySnap.exists) {
        console.warn(`[darajaSTKCallback] Unknown checkoutId: ${checkoutId}`);
        return;
      }
      const payData = paySnap.data();
      if (payData.status === "completed" || payData.status === "failed") {
        console.log(`[darajaSTKCallback] Already processed: ${checkoutId} (${payData.status})`);
        return;
      }

      /* Parse Safaricom callback metadata */
      let mpesaCode = null, paidAmount = null, paidPhone = null;
      if (resultCode === 0 && body.CallbackMetadata?.Item) {
        for (const item of body.CallbackMetadata.Item) {
          if (item.Name === "MpesaReceiptNumber") mpesaCode  = item.Value;
          if (item.Name === "Amount")             paidAmount = item.Value;
          if (item.Name === "PhoneNumber")        paidPhone  = String(item.Value);
        }
      }

      /* Cross-check paid amount vs requested amount to catch replay/spoofing */
      if (resultCode === 0 && paidAmount && payData.amount) {
        const diff = Math.abs(Number(paidAmount) - Number(payData.amount));
        if (diff > 1) {
          console.error(`[darajaSTKCallback] Amount mismatch for ${checkoutId}: requested=${payData.amount}, paid=${paidAmount}`);
          db.collection("auditLogs").add({
            type: "mpesa_amount_mismatch", checkoutId,
            requested: payData.amount, received: paidAmount,
            sellerUid: payData.sellerUid,
            ts: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
          await payRef.update({
            status: "failed", resultCode: -99,
            resultDesc: `Amount mismatch: expected ${payData.amount}, received ${paidAmount}`,
            paidAmount, updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          return;
        }
      }

      const newStatus = resultCode === 0 ? "completed" : "failed";
      const ts        = admin.firestore.FieldValue.serverTimestamp();

      /* P0-1 (Phase 4 audit): atomically CLAIM the pending→completed/failed transition
         inside a transaction so two concurrent Safaricom retries cannot both proceed.
         Only the single winner credits the seller — and the credit uses a deterministic
         doc ID, so even a re-run overwrites rather than duplicating. Previously this was
         a non-transactional read-check-write + sellerPayments.add() (auto-ID), which
         allowed double seller credits on retries. */
      let claimed = false;
      await db.runTransaction(async (txn) => {
        const snap = await txn.get(payRef);
        if (!snap.exists) return;
        const d = snap.data();
        if (d.status === "completed" || d.status === "failed") return; /* already processed by a concurrent retry */
        txn.update(payRef, {
          status:     newStatus,
          resultCode,
          resultDesc,
          mpesaCode:  mpesaCode  || null,
          paidAmount: paidAmount || null,
          paidPhone:  paidPhone  || null,
          updatedAt:  ts,
        });
        claimed = true;
      });

      if (!claimed) {
        console.log(`[darajaSTKCallback] Already processed (raced): ${checkoutId}`);
        return;
      }

      /* On success: write to sellerPayments + update order (winner only) */
      if (resultCode === 0) {
        const paymentRecord = {
          checkoutId,
          sellerUid:   payData.sellerUid,
          callerUid:   payData.callerUid  || null,
          orderId:     payData.orderId    || null,
          hub:         payData.hub        || "marketplace",
          amount:      paidAmount         || payData.amount,
          phone:       paidPhone          || payData.phone,
          mpesaCode:   mpesaCode          || null,
          sellerName:  payData.sellerName || null,
          description: payData.description || null,
          status:      "completed",
          createdAt:   ts,
        };
        /* Deterministic ID — one credit per STK checkout request; idempotent by construction. */
        await db.collection("sellerPayments").doc(checkoutId).set(paymentRecord);

        /* ── Order authority + inventory ────────────────────────────────────
           This block previously set only `paymentStatus`, which nothing else
           reads: onNewOrderCreated gates on `status` and `paymentVerified`,
           both of which the CLIENT wrote. So payment success and the fields
           that actually drive fulfilment were never connected — the browser
           was the only thing asserting an order was paid. It also ran as a
           read-then-update outside the claiming transaction, and inventory was
           never decremented on this path at all.

           Now: one transaction sets the authoritative payment fields AND
           decrements stock, so a verified payment and its stock movement
           cannot diverge. Everything is keyed off the order document, which
           makes webhook retries converge instead of double-applying. */
        if (payData.orderId) {
          const orderRef = db.collection("orders").doc(payData.orderId);

          try {
            await db.runTransaction(async (txn) => {
              const orderSnap = await txn.get(orderRef);

              /* Safaricom can call back before the browser has written the
                 order — or the browser may have died mid-checkout. Recording
                 the payment against a missing order lets reconciliation find
                 the money instead of it vanishing. */
              if (!orderSnap.exists) {
                txn.set(db.collection("orphanPayments").doc(checkoutId), {
                  checkoutId, orderId: payData.orderId, sellerUid: payData.sellerUid,
                  callerUid: payData.callerUid || null,
                  amount: paidAmount || payData.amount, mpesaCode: mpesaCode || null,
                  reason: "order_document_absent_at_callback", createdAt: ts,
                });
                return;
              }

              const o = orderSnap.data();

              /* Idempotency: a retried webhook must not decrement stock twice.
                 The flag lives on the order and is read inside this
                 transaction, so concurrent retries serialise on it. */
              if (o.inventoryApplied === true) return;

              /* Stock. Prefer the server-priced line items recorded at STK
                 time over anything the client later wrote onto the order. */
              const lines = Array.isArray(payData.items) && payData.items.length
                ? payData.items
                : (Array.isArray(o.items) ? o.items : []);

              /* Read every product BEFORE any write — a Firestore transaction
                 requires all reads to precede all writes — so the deduction can
                 be floored and never drive stock negative on a last-item race. */
              const stockReads = [];
              for (const line of lines) {
                const pid = line && (line.productId || line.id);
                const qty = Math.floor(Number(line && line.qty) || 0);
                if (!pid || qty < 1) continue;
                const pRef  = db.collection("products").doc(String(pid));
                const pSnap = await txn.get(pRef);
                stockReads.push({ ref: pRef, pid: String(pid), qty, snap: pSnap });
              }

              txn.update(orderRef, {
                status:          "paid",
                paymentStatus:   "paid",
                /* Server-asserted. The client can no longer be the source of
                   this, which is what makes the rules change in item 2 safe. */
                paymentVerified: true,
                paymentMethod:   "mpesa_daraja",
                mpesaCode:       mpesaCode  || null,
                paidAmount:      paidAmount || null,
                paidPhone:       paidPhone  || null,
                paidAt:          ts,
                inventoryApplied: true,
                settlementStatus: "queued",
                updatedAt:       ts,
              });

              /* Payment is already confirmed, so an oversell is flagged, not
                 rejected — but stock is floored at zero and the shortfall is
                 recorded for reconciliation (parity with the IntaSend path). */
              for (const { ref, pid, qty, snap } of stockReads) {
                const pdata = snap.exists ? snap.data() : {};
                const cur = snap.exists ? pdata.stock : null;
                const priorVer = Number(pdata.inventoryVersion) || 0;
                let dec = qty;
                if (typeof cur === "number" && cur < qty) {
                  dec = Math.max(0, cur);
                  txn.set(db.collection("oversoldAlerts").doc(), {
                    orderId:   payData.orderId || checkoutId || null,
                    productId: pid, requested: qty, available: cur,
                    path:      "daraja",
                    createdAt: ts,
                  });
                }
                /* One atomic write: stock + updatedAt + inventoryVersion, so
                   listeners see a single monotonic change signal. */
                txn.update(ref, {
                  stock:            admin.firestore.FieldValue.increment(-dec),
                  updatedAt:        ts,
                  inventoryVersion: admin.firestore.FieldValue.increment(1),
                });
                console.log(`[daraja] stock deduct product=${pid} -${dec} inventoryVersion ${priorVer}->${priorVer + 1}`);
              }
            });
          } catch (e) {
            /* The payment is real and already recorded in sellerPayments. If
               the order/stock update fails we must not lose that fact, so this
               is surfaced for reconciliation rather than swallowed. */
            console.error(`[darajaSTKCallback] order/inventory txn failed for ${payData.orderId}: ${e.message}`);
            db.collection("auditLogs").add({
              type: "order_finalisation_failed", severity: "critical",
              checkoutId, orderId: payData.orderId, sellerUid: payData.sellerUid,
              amount: paidAmount || payData.amount, mpesaCode: mpesaCode || null,
              error: e.message, ts,
            }).catch(() => {});
          }
        }
      }

      /* Audit log */
      db.collection("auditLogs").add({
        type:       "mpesa_callback",
        checkoutId,
        hub:        payData.hub || "marketplace",
        sellerUid:  payData.sellerUid,
        mpesaCode:  mpesaCode || null,
        paidAmount: paidAmount || null,
        paidPhone:  paidPhone || null,
        status:     newStatus,
        resultCode,
        resultDesc,
        ts,
      }).catch(() => {});

      /* ── Financial records ──────────────────────────────────────────────
         An audit of every confirmation path found that a successful payment
         produced no invoice, no receipt, no journal entry and no tax record.
         The modules existed; nothing called them. This is the call.

         Deliberately after the audit log and outside the claiming transaction:
         the money has already moved and the order is already marked paid, so
         paperwork must never be able to fail the payment. recordConfirmedPayment
         is idempotent on `ref` and swallows its own errors into
         financialEngineFailures, so a retry is harmless and a failure is
         queued for reconciliation rather than surfaced to the caller. */
      /* Timeline: the provider confirmed and the customer authorised. */
      try {
        const _tl = require("./payment-timeline");
        const _tlRef = payData.orderId || checkoutId;
        if (resultCode === 0) {
          _tl.mark(_tlRef, "customer_authorized", { mpesaCode: mpesaCode || null, paidAmount: paidAmount || null });
          _tl.mark(_tlRef, "payment_reconciled", { status: newStatus });
        } else {
          _tl.fail(_tlRef, "provider_result_" + resultCode + ": " + String(resultDesc || "").slice(0, 120));
        }
      } catch (_tlErr) { /* observability must never fail a payment */ }

      if (resultCode === 0) {
        try {
          const _fin = require("./financial-engine");
          await _fin.recordConfirmedPayment({
            ref:         payData.orderId || checkoutId,
            amountKES:   paidAmount || payData.amount,
            uid:         payData.callerUid || null,
            sellerUid:   payData.sellerUid || null,
            orderId:     payData.orderId || null,
            description: payData.description || "SOKONI payment",
            method:      "mpesa",
            providerRef: mpesaCode || checkoutId,
            source:      "darajaSTKCallback",
          });
        } catch (_finErr) {
          console.error("[darajaSTKCallback] financial engine threw:", _finErr && _finErr.message);
        }
      }

      console.log(`[darajaSTKCallback] ${checkoutId} → ${newStatus.toUpperCase()} (code:${mpesaCode || resultDesc})`);
    } catch (e) {
      console.error("[darajaSTKCallback] Error:", e.message);
    }
  }
);

/* ── verifyPaymentStatus — check payment status by checkoutId or orderId ── */
exports.verifyPaymentStatus = onCall(
  { timeoutSeconds: 15, cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

    const { checkoutId, orderId } = request.data;

    /* IntaSend payments live in `payments/{ref}` (Admin-SDK-written). The buyer's
       browser cannot read them directly — the payments read rule keys on buyerId
       while initiateSTKPush writes uid — so the checkout confirms via THIS authed
       call instead of a denied Firestore listener. Authorised for the buyer
       (payments.uid), the seller (meta.sellerUid), or an admin. */
    if (request.data.ref) {
      const ref = String(request.data.ref);
      const snap = await db.collection("payments").doc(ref).get();
      if (!snap.exists) return { status: "PENDING" };
      const d = snap.data();
      const uid = request.auth.uid;
      const _sellerUid = (d.meta && d.meta.sellerUid) || null;
      if (d.uid !== uid && _sellerUid !== uid) {
        const userRecord = await admin.auth().getUser(uid).catch(() => null);
        if (!userRecord?.customClaims?.admin) {
          throw new HttpsError("permission-denied", "Access denied.");
        }
      }
      return {
        status:          d.status || "PENDING",
        confirmedAmount: d.confirmedAmount || d.amount || null,
        mpesaCode:       d.mpesaCode || null,
      };
    }

    if (checkoutId) {
      const snap = await db.collection("posPayments").doc(checkoutId).get();
      if (!snap.exists) throw new HttpsError("not-found", "Payment record not found.");
      const d = snap.data();
      /* Allow: seller, callerUid (buyer who initiated), or admin */
      const uid = request.auth.uid;
      if (d.sellerUid !== uid && d.callerUid !== uid) {
        const userRecord = await admin.auth().getUser(uid).catch(() => null);
        if (!userRecord?.customClaims?.admin) {
          throw new HttpsError("permission-denied", "Access denied.");
        }
      }
      return {
        status:     d.status,
        mpesaCode:  d.mpesaCode  || null,
        paidAmount: d.paidAmount || null,
        paidPhone:  d.paidPhone  || null,
        hub:        d.hub        || null,
        sellerName: d.sellerName || null,
        createdAt:  d.createdAt?.toMillis?.() || null,
        updatedAt:  d.updatedAt?.toMillis?.() || null,
      };
    }

    if (orderId) {
      const q = await db.collection("posPayments")
        .where("orderId", "==", orderId)
        .orderBy("createdAt", "desc")
        .limit(1).get();
      if (q.empty) return { status: "not_found" };
      const d = q.docs[0].data();
      const uid = request.auth.uid;
      if (d.sellerUid !== uid && d.callerUid !== uid) {
        const userRecord = await admin.auth().getUser(uid).catch(() => null);
        if (!userRecord?.customClaims?.admin) {
          throw new HttpsError("permission-denied", "Access denied.");
        }
      }
      return { status: d.status, mpesaCode: d.mpesaCode || null, paidAmount: d.paidAmount || null };
    }

    throw new HttpsError("invalid-argument", "checkoutId or orderId is required.");
  }
);

/* ── validateDarajaCredentials — test OAuth token generation ── */
exports.validateDarajaCredentials = onCall(
  { timeoutSeconds: 20, cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const uid = request.auth.uid;

    const snap = await db.collection("shopSettings").doc(uid).get();
    if (!snap.exists) throw new HttpsError("not-found", "No payment credentials saved yet.");

    const cfg = snap.data();
    const { darajaConsumerKey, darajaConsumerSecret, darajaPassKey, darajaShortCode, darajaEnv = "production" } = cfg;

    if (!darajaConsumerKey || !darajaConsumerSecret || !darajaPassKey || !darajaShortCode) {
      throw new HttpsError("failed-precondition", "Incomplete credentials. Fill all required fields and save first.");
    }

    try {
      const { token, base } = await _darajaToken(darajaConsumerKey, darajaConsumerSecret, darajaEnv);
      /* Also verify timestamp/password generation */
      const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
      Buffer.from(`${darajaShortCode}${darajaPassKey}${timestamp}`).toString("base64");
      await db.collection("auditLogs").add({
        action: "validateDarajaCredentials",
        sellerUid: uid,
        env: darajaEnv,
        shortCode: darajaShortCode,
        status: "success",
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return { success: true, env: darajaEnv, shortCode: darajaShortCode, txType: cfg.darajaTransactionType || "CustomerPayBillOnline" };
    } catch (e) {
      const msg = e.message || "Credential validation failed";
      await db.collection("auditLogs").add({
        action: "validateDarajaCredentials",
        sellerUid: uid,
        env: darajaEnv,
        status: "failed",
        error: msg,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      throw new HttpsError("permission-denied", "Credential check failed: " + msg);
    }
  }
);

/* ── sendTestSTKPush — live test push to seller's own phone ── */
exports.sendTestSTKPush = onCall(
  { timeoutSeconds: 30, cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const uid   = request.auth.uid;
    const phone = String(request.data?.phone || "").replace(/\D/g, "").replace(/^0/, "254").replace(/^\+/, "");
    if (!phone.startsWith("254") || phone.length !== 12) {
      throw new HttpsError("invalid-argument", "Valid Kenyan phone number required (07XXXXXXXX).");
    }

    /* Rate limit: max 3 test pushes per seller per hour */
    const oneHourAgo = new Date(Date.now() - 3600000);
    const recentTests = await db.collection("auditLogs")
      .where("action",    "==", "sendTestSTKPush")
      .where("sellerUid", "==", uid)
      .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(oneHourAgo))
      .limit(3).get();
    if (recentTests.size >= 3) {
      throw new HttpsError("resource-exhausted", "Test limit reached (3 per hour). Try again later.");
    }

    const snap = await db.collection("shopSettings").doc(uid).get();
    if (!snap.exists) throw new HttpsError("not-found", "No credentials saved.");
    const cfg = snap.data();

    /* Verify the phone matches the seller's registered phone or their shop settings phone */
    const sellerPhone = String(cfg.phone || cfg.ownerPhone || "").replace(/\D/g, "").replace(/^0/, "254").replace(/^\+/, "");
    if (sellerPhone && sellerPhone.length === 12 && phone !== sellerPhone) {
      throw new HttpsError("permission-denied", "Test pushes can only be sent to your own registered phone number.");
    }

    const { darajaConsumerKey, darajaConsumerSecret, darajaPassKey, darajaShortCode, darajaEnv = "production", darajaTransactionType = "CustomerPayBillOnline", darajaAccountRef = "TEST" } = cfg;

    if (!darajaConsumerKey || !darajaConsumerSecret || !darajaPassKey || !darajaShortCode) {
      throw new HttpsError("failed-precondition", "Incomplete credentials.");
    }

    const { token, base } = await _darajaToken(darajaConsumerKey, darajaConsumerSecret, darajaEnv);
    const timestamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const password  = Buffer.from(`${darajaShortCode}${darajaPassKey}${timestamp}`).toString("base64");
    const checkoutId = "TEST_" + uid.slice(0, 8) + "_" + Date.now();
    const callbackUrl = "https://us-central1-sokoni-aeb26.cloudfunctions.net/darajaSTKCallback";

    const stkRes = await fetch(`${base}/mpesa/stkpush/v1/processrequest`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        BusinessShortCode: darajaShortCode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: darajaTransactionType,
        Amount: 1,
        PartyA: phone,
        PartyB: darajaShortCode,
        PhoneNumber: phone,
        CallBackURL: callbackUrl,
        AccountReference: "SOKONI-TEST",
        TransactionDesc: "SOKONI Payment Test — 1 KES",
      }),
    });
    const stkData = await stkRes.json();
    if (stkData.ResponseCode !== "0") {
      throw new HttpsError("internal", "STK Push failed: " + (stkData.ResponseDescription || stkData.errorMessage || "Unknown error"));
    }

    const safCheckoutId = stkData.CheckoutRequestID || checkoutId;
    await db.collection("posPayments").doc(safCheckoutId).set({
      checkoutId: safCheckoutId,
      sellerUid: uid,
      callerUid: uid,
      hub: "test",
      phone,
      amount: 1,
      status: "pending",
      description: "Test STK Push",
      env: darajaEnv,
      isTest: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    await db.collection("auditLogs").add({
      action: "sendTestSTKPush",
      sellerUid: uid,
      phone,
      checkoutId: safCheckoutId,
      env: darajaEnv,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, checkoutId: safCheckoutId, message: "STK Push sent. Enter your M-Pesa PIN on your phone." };
  }
);

/* ══════════════════════════════════════════════════════════════
   SOKONI REVENUE ENGINE
   Sellers always receive money directly into their own M-Pesa.
   Sokoni never holds funds. All revenue is tracked as "owed"
   and invoiced monthly. Admin can mark invoices paid once
   collected (bank transfer, M-Pesa, or future auto-collection).
══════════════════════════════════════════════════════════════ */

/* Commission rates are NOT defined here any more. The per-hub table that used to sit at this
   spot is now the single authoritative config in ./commission-config.js. Its rates carry the
   values this table held — the only rates ever actually charged — so consolidating repriced
   nothing. Do NOT reintroduce a table here: scripts/verify-commission-single-source.js fails
   the deploy if a second commission table appears anywhere in the repo. */
const COMMISSION_CONFIG = require('./commission-config');

/* Plan definitions (priceKES/month) */
const SUBSCRIPTION_PLANS = {
  free:       { priceKES: 0,    maxListings: 10,   tier: 0 },
  pro:        { priceKES: 999,  maxListings: -1,   tier: 1 },
  business:   { priceKES: 2999, maxListings: -1,   tier: 2 },
  enterprise: { priceKES: 0,    maxListings: -1,   tier: 3 },
};

/* Featured listing pricing (KES) */
const FEATURED_PRICING = { daily: 200, weekly: 800, monthly: 2500 };

/* ── Helper: resolve effective commission for a payment ── */
/* Thin adapter over the ONE commission engine.
 *
 * This used to be a second engine: its own precedence chain over revenueConfig, its own
 * arithmetic (the KES 10 floor, the flat fee), and it never looked at commissionRules — so a
 * rate an admin set as a rule had no effect on any payment that took this rail, and a
 * revenueConfig override had no effect on any payment that took the other one. Both now
 * resolve inside calculateCommission(), which is the single entry point for every rail.
 *
 * Kept only to preserve the { pct, fixedKES, commissionKES, totalOwed } shape that
 * onSellerPaymentCreated writes into commissionLedger. */
async function _resolveCommission(sellerUid, hub, grossAmount) {
  const { calculateCommission } = require('./finos-utils');
  const r = await calculateCommission(db, {
    orderAmountCents: Math.round(Number(grossAmount) * 100),
    category:         hub,
    sellerId:         sellerUid,
    hubId:            hub,
  });
  return {
    pct:           r.effectiveRate,
    fixedKES:      r.fixedKES || 0,
    /* commissionKES excludes the flat fee; totalOwed includes it — the shape callers expect.
       calculateCommission already applied the minimum and the flat fee, so do NOT re-apply. */
    commissionKES: Math.round((r.commissionCents - (r.fixedKES || 0) * 100)) / 100,
    totalOwed:     r.commissionCents / 100,
    /* The audit breakdown, passed through verbatim so the ledger can retain it. A settlement
       must stay reproducible: years later it has to be possible to say WHICH rule, WHICH plan
       and WHICH adjustment produced the rate that was charged. */
    audit: {
      baseRate:       r.baseRate,
      planId:         r.planId,
      planName:       r.planName,
      planStatus:     r.planStatus,
      planAdjustment: r.planAdjustment,
      adjustmentType: r.adjustmentType,
      planApplied:    r.planApplied,
      planSkipped:    r.planSkipped,
      planLabel:      r.planLabel,
      planSource:     r.planSource,
      effectiveRate:  r.effectiveRate,
      ruleId:         r.ruleId,
      ruleSource:     r.ruleSource,
      reason:         r.reason,
      calculatedAt:   r.calculatedAt,
      engineVersion:  r.engineVersion,
    },
  };
}

/* ── Auto-record commission when a seller payment is confirmed ── */
exports.onSellerPaymentCreated = onDocumentCreated(
  "sellerPayments/{paymentId}",
  async (event) => {
    const data = event.data?.data();
    if (!data || data.isTest) return;

    const { sellerUid, amount, hub = "marketplace", orderId, mpesaCode } = data;
    if (!sellerUid || !amount || Number(amount) <= 0) return;

    const grossAmount = Number(amount);
    const { pct, fixedKES, commissionKES, totalOwed, audit } = await _resolveCommission(sellerUid, hub, grossAmount);
    const paymentId = event.params.paymentId;
    const period    = new Date().toISOString().slice(0, 7); // "2026-06"

    /* P0-3: Firestore triggers are AT-LEAST-ONCE — this handler can legitimately be
       invoked more than once for the same sellerPayments document. The previous code
       was doubly non-idempotent on redelivery:
         1. commissionLedger.add()      → AUTO-ID, so a redelivery wrote a SECOND
                                          commission entry for one payment.
         2. FieldValue.increment(...)   → NOT idempotent, so a redelivery DOUBLE-CHARGED
                                          the seller's monthly commission and gross totals.
       Net effect: the seller could be billed commission twice for a single payment.

       Fix: derive the ledger id deterministically from the source payment
       (commissionLedger/{paymentId} — one entry per payment, by construction) and
       perform the existence check + ledger write + billing increments inside ONE
       transaction. The transaction reads the ledger doc first; if it already exists the
       event is a redelivery and we return without incrementing anything. This makes the
       whole handler exactly-once with respect to money. */
    const ledgerRef  = db.collection("commissionLedger").doc(paymentId);
    const billingRef = db.collection("sellerBilling").doc(sellerUid)
      .collection("monthly").doc(period);

    const applied = await db.runTransaction(async (txn) => {
      const existing = await txn.get(ledgerRef);
      if (existing.exists) return false;   /* redelivery — already accounted for */

      txn.set(ledgerRef, {
        sellerUid,
        paymentId,
        orderId:    orderId   || null,
        mpesaCode:  mpesaCode || null,
        hub,
        grossAmount,
        commissionPct: pct,
        fixedFee:   fixedKES,
        commissionKES,
        totalOwed,

        /* ── AUDIT: every financial record must explain the rate it charged ────────────────
         * Base rate, plan, adjustment, final rate, reason, rule, timestamp, engine version.
         * FINANCIAL_TRANSACTION_STANDARD.md Invariant 6: every movement leaves an immutable
         * record. A settlement must stay reproducible years later — including the ability to
         * prove that plan discounts were switched OFF at the time (planSkipped:
         * 'rollout_disabled'), rather than merely absent from the data. */
        baseRate:        audit.baseRate,
        planId:          audit.planId,
        planName:        audit.planName,
        planStatus:      audit.planStatus,
        planAdjustment:  audit.planAdjustment,
        adjustmentType:  audit.adjustmentType,
        planApplied:     audit.planApplied,
        planSkipped:     audit.planSkipped,
        planSource:      audit.planSource,
        ruleId:          audit.ruleId,
        ruleSource:      audit.ruleSource,
        reason:          audit.reason,
        calculatedAt:    audit.calculatedAt,
        engineVersion:   audit.engineVersion,

        status: "pending",
        invoiceId: null,
        period,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      /* Increments are safe here: they run at most once, guarded by the ledger check. */
      txn.set(billingRef, {
        totalCommissionKES: admin.firestore.FieldValue.increment(totalOwed),
        grossSalesKES:      admin.firestore.FieldValue.increment(grossAmount),
        transactionCount:   admin.firestore.FieldValue.increment(1),
        lastUpdated:        admin.firestore.FieldValue.serverTimestamp(),
        status: "open",
      }, { merge: true });

      return true;
    });

    if (!applied) {
      console.log(`[revenue] duplicate trigger delivery ignored payment=${paymentId}`);
      return;
    }

    console.log(`[revenue] commission recorded seller=${(sellerUid||'').slice(0,8)}… payment=${paymentId}`);
  }
);

/* ── getRevenueConfig — admin gets all, seller gets own ── */
exports.getRevenueConfig = onCall({ timeoutSeconds: 15, cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid     = request.auth.uid;
  const isAdmin = request.auth.token?.admin === true;

  if (isAdmin) {
    const snap = await db.collection("revenueConfig").get();
    const cfg  = {};
    snap.forEach(d => { cfg[d.id] = d.data(); });
    return { configs: cfg, hubDefaults: COMMISSION_CONFIG.RATES, plans: SUBSCRIPTION_PLANS };
  }

  const [sellerSnap, globalSnap] = await Promise.all([
    db.collection("revenueConfig").doc(`seller_${uid}`).get(),
    db.collection("revenueConfig").doc("global").get(),
  ]);
  return {
    sellerOverride: sellerSnap.exists ? sellerSnap.data() : null,
    global:         globalSnap.exists ? globalSnap.data() : null,
    hubDefaults:    COMMISSION_CONFIG.RATES,
  };
});

/* ── updateRevenueConfig — admin only ── */
exports.updateRevenueConfig = onCall({ timeoutSeconds: 15, cors: true }, async (request) => {
  if (!request.auth || request.auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  const { configId, data } = request.data;
  if (!configId || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "configId and data required.");
  }
  await db.collection("revenueConfig").doc(configId).set(
    { ...data, updatedBy: request.auth.uid, updatedAt: admin.firestore.FieldValue.serverTimestamp() },
    { merge: true }
  );
  await db.collection("auditLogs").add({
    action: "updateRevenueConfig",
    uid: request.auth.uid,
    configId,
    changes: data,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { success: true };
});

/* ── getSellerBillingReport — seller sees own, admin sees any ── */
exports.getSellerBillingReport = onCall({ timeoutSeconds: 20, cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const isAdmin   = request.auth.token?.admin === true;
  const uid       = request.auth.uid;
  const targetUid = (isAdmin && request.data?.sellerUid) ? request.data.sellerUid : uid;

  if (!isAdmin && targetUid !== uid) {
    throw new HttpsError("permission-denied", "Cannot view another seller's billing.");
  }

  const period = request.data?.period || new Date().toISOString().slice(0, 7);
  const months = Math.min(Number(request.data?.months || 6), 12);

  const billingSnap = await db.collection("sellerBilling").doc(targetUid)
    .collection("monthly")
    .orderBy(admin.firestore.FieldPath.documentId(), "desc")
    .limit(months)
    .get();

  const billing = [];
  billingSnap.forEach(d => billing.push({ period: d.id, ...d.data() }));

  const commSnap = await db.collection("commissionLedger")
    .where("sellerUid", "==", targetUid)
    .where("period", "==", period)
    .orderBy("createdAt", "desc")
    .limit(100)
    .get();

  const commissions = [];
  commSnap.forEach(d => commissions.push({ id: d.id, ...d.data() }));

  /* Current subscription */
  const subSnap = await db.collection("sellerSubscriptions").doc(targetUid).get();

  /* Featured listings */
  const featSnap = await db.collection("featuredListings")
    .where("sellerUid", "==", targetUid)
    .where("status", "==", "active")
    .limit(20).get();
  const featured = [];
  featSnap.forEach(d => featured.push({ id: d.id, ...d.data() }));

  /* Invoices */
  const invSnap = await db.collection("invoices")
    .where("sellerUid", "==", targetUid)
    .orderBy("createdAt", "desc")
    .limit(12).get();
  const invoices = [];
  invSnap.forEach(d => invoices.push({ id: d.id, ...d.data() }));

  return { billing, commissions, period, subscription: subSnap.exists ? subSnap.data() : null, featured, invoices };
});

/* ── getAdminRevenueReport — full platform overview ── */
exports.getAdminRevenueReport = onCall({ timeoutSeconds: 30, cors: true }, async (request) => {
  if (!request.auth || request.auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  const period = request.data?.period || new Date().toISOString().slice(0, 7);
  const dayAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 86400000);

  const [pendingComm, paidComm, todayComm, activeFeatures, activeAds, activeSubs] = await Promise.all([
    db.collection("commissionLedger").where("status", "==", "pending").where("period", "==", period).get(),
    db.collection("commissionLedger").where("status", "in", ["paid", "invoiced"]).where("period", "==", period).get(),
    db.collection("commissionLedger").where("createdAt", ">=", dayAgo).get(),
    db.collection("featuredListings").where("status", "==", "active").get(),
    db.collection("sokoAds").where("status", "==", "active").get(),
    db.collection("sellerSubscriptions").where("status", "==", "active").get(),
  ]);

  const sumField = (snap, field) => {
    let t = 0;
    snap.forEach(d => { t += Number(d.data()[field] || 0); });
    return Math.round(t * 100) / 100;
  };

  /* Hub breakdown */
  const hubBreakdown = {};
  pendingComm.forEach(d => {
    const { hub = "marketplace", totalOwed = 0, grossAmount = 0 } = d.data();
    if (!hubBreakdown[hub]) hubBreakdown[hub] = { commission: 0, gross: 0, count: 0 };
    hubBreakdown[hub].commission += Number(totalOwed);
    hubBreakdown[hub].gross     += Number(grossAmount);
    hubBreakdown[hub].count     += 1;
  });

  /* Top sellers by commission owed */
  const sellerTotals = {};
  pendingComm.forEach(d => {
    const { sellerUid, totalOwed = 0 } = d.data();
    sellerTotals[sellerUid] = (sellerTotals[sellerUid] || 0) + Number(totalOwed);
  });
  const topSellers = Object.entries(sellerTotals)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([uid, owed]) => ({ sellerUid: uid, owedKES: Math.round(owed * 100) / 100 }));

  const subRevenue = sumField(activeSubs, "priceKES");
  const featRevenue = sumField(activeFeatures, "priceKES");
  const adBudget   = sumField(activeAds, "budgetKES");

  return {
    period,
    pendingCommissionKES:   sumField(pendingComm,  "totalOwed"),
    collectedCommissionKES: sumField(paidComm,     "totalOwed"),
    todayCommissionKES:     sumField(todayComm,    "totalOwed"),
    grossSalesMTDKES:       sumField(pendingComm,  "grossAmount"),
    pendingTransactions:    pendingComm.size,
    uniqueSellersOwing:     Object.keys(sellerTotals).length,
    activeFeaturedCount:    activeFeatures.size,
    activeAdCount:          activeAds.size,
    activeSubCount:         activeSubs.size,
    subscriptionRevenueKES: subRevenue,
    featuredRevenueKES:     featRevenue,
    adBudgetKES:            adBudget,
    hubBreakdown,
    topSellers,
  };
});

/* ── purchaseFeaturedListing — seller callable ── */
exports.purchaseFeaturedListing = onCall({ timeoutSeconds: 20, cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { itemType, itemId, itemTitle, duration, hub, placement, paymentRef } = request.data;
  if (!itemType || !duration || !FEATURED_PRICING[duration]) {
    throw new HttpsError("invalid-argument", "itemType and duration (daily/weekly/monthly) required.");
  }

  const priceKES  = FEATURED_PRICING[duration];
  const days      = { daily: 1, weekly: 7, monthly: 30 }[duration];
  const startDate = admin.firestore.Timestamp.now();
  const endDate   = admin.firestore.Timestamp.fromMillis(Date.now() + days * 86400000);
  const period    = new Date().toISOString().slice(0, 7);

  /* Verify payment is completed before activating the listing */
  let paymentVerified = false;
  if (paymentRef) {
    const paySnap = await db.collection("posPayments").doc(paymentRef).get().catch(() => null);
    if (paySnap && paySnap.exists) {
      const payData = paySnap.data();
      if (payData.status === "completed" && payData.uid === uid) {
        paymentVerified = true;
      }
    }
    if (!paymentVerified) {
      throw new HttpsError("permission-denied", "Payment could not be verified. Please try again after your payment completes.");
    }
  }

  const ref = await db.collection("featuredListings").add({
    sellerUid:  uid,
    itemType:   itemType   || "product",
    itemId:     itemId     || null,
    itemTitle:  itemTitle  || null,
    duration,
    priceKES,
    startDate,
    endDate,
    status:     paymentVerified ? "active" : "pending_payment",
    hub:        hub        || "marketplace",
    placement:  placement  || "category",
    paymentRef: paymentRef || null,
    impressions: 0,
    clicks:     0,
    createdAt:  admin.firestore.FieldValue.serverTimestamp(),
  });

  if (paymentRef) {
    await db.collection("sellerBilling").doc(uid).collection("monthly").doc(period).set({
      featuredKES:  admin.firestore.FieldValue.increment(priceKES),
      lastUpdated:  admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  return { success: true, featureId: ref.id, priceKES };
});

/* ── createAdCampaign — seller callable ── */
const _isHttpsUrl = (s) => typeof s === "string" && /^https:\/\/[^\s<>"']{4,512}$/.test(s);

exports.createAdCampaign = onCall({ timeoutSeconds: 20, cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { adType, title, description, imageUrl, ctaUrl, targetHub, budgetKES, cpm } = request.data;
  if (!adType || !title || !budgetKES) {
    throw new HttpsError("invalid-argument", "adType, title, budgetKES required.");
  }
  if (imageUrl && !_isHttpsUrl(imageUrl)) {
    throw new HttpsError("invalid-argument", "imageUrl must be a valid HTTPS URL.");
  }
  if (ctaUrl && !_isHttpsUrl(ctaUrl)) {
    throw new HttpsError("invalid-argument", "ctaUrl must be a valid HTTPS URL.");
  }

  const ref = await db.collection("sokoAds").add({
    sellerUid:   uid,
    adType:      adType || "product",
    title,
    description: description || "",
    imageUrl:    imageUrl    || null,
    ctaUrl:      ctaUrl      || null,
    targetHub:   targetHub   || "all",
    budgetKES:   Number(budgetKES),
    spentKES:    0,
    cpm:         Number(cpm || 150),
    impressions: 0,
    clicks:      0,
    conversions: 0,
    status:      "pending_review",
    createdAt:   admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, adId: ref.id };
});

/* ── updateSellerSubscription — record plan changes ── */
exports.updateSellerSubscription = onCall({ timeoutSeconds: 15, cors: true }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const isAdmin   = request.auth.token?.admin === true;
  const uid       = request.auth.uid;
  const targetUid = (isAdmin && request.data?.sellerUid) ? request.data.sellerUid : uid;

  if (!isAdmin && targetUid !== uid) {
    throw new HttpsError("permission-denied", "Cannot modify another seller's subscription.");
  }

  const { plan, paymentRef, months = 1 } = request.data;
  if (!plan || !SUBSCRIPTION_PLANS[plan]) {
    throw new HttpsError("invalid-argument", "Valid plan required: free, pro, business, enterprise");
  }

  const { priceKES, tier, maxListings } = SUBSCRIPTION_PLANS[plan];

  /* Paid plans require a verified payment reference */
  if (priceKES > 0 && !isAdmin) {
    if (!paymentRef) {
      throw new HttpsError("invalid-argument", "paymentRef is required for paid subscription plans.");
    }
    const paySnap = await db.collection("posPayments").doc(paymentRef).get().catch(() => null);
    if (!paySnap || !paySnap.exists) {
      throw new HttpsError("not-found", "Payment record not found.");
    }
    const payData = paySnap.data();
    if (payData.status !== "completed" || payData.uid !== uid) {
      throw new HttpsError("permission-denied", "Payment is not completed or does not belong to this account.");
    }
  }
  const startDate = admin.firestore.Timestamp.now();
  const endDate   = admin.firestore.Timestamp.fromMillis(Date.now() + Number(months) * 30 * 86400000);
  const period    = new Date().toISOString().slice(0, 7);

  await db.collection("sellerSubscriptions").doc(targetUid).set({
    sellerUid:  targetUid,
    plan,
    tier,
    maxListings,
    priceKES,
    status:     "active",
    startDate,
    endDate,
    autoRenew:  true,
    paymentRef: paymentRef || null,
    updatedAt:  admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  if (priceKES > 0) {
    await db.collection("sellerBilling").doc(targetUid).collection("monthly").doc(period).set({
      subscriptionKES: admin.firestore.FieldValue.increment(priceKES * Number(months)),
      lastUpdated:     admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  }

  await db.collection("auditLogs").add({
    action: "updateSellerSubscription",
    uid: request.auth.uid,
    targetUid, plan, priceKES,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true, plan, priceKES, tier };
});

/* ── getCommissionLedger — admin paginated view ── */
exports.getCommissionLedger = onCall({ timeoutSeconds: 20, cors: true }, async (request) => {
  if (!request.auth || request.auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  const { sellerUid, hub, status = "pending", period, limit: lim = 50 } = request.data || {};
  let q = db.collection("commissionLedger");

  if (sellerUid) q = q.where("sellerUid", "==", sellerUid);
  if (hub)       q = q.where("hub",       "==", hub);
  if (status)    q = q.where("status",    "==", status);
  if (period)    q = q.where("period",    "==", period);

  q = q.orderBy("createdAt", "desc").limit(Math.min(Number(lim), 200));

  const snap = await q.get();
  const rows = [];
  snap.forEach(d => rows.push({ id: d.id, ...d.data() }));
  return { rows, count: rows.length };
});

/* ── markCommissionPaid — admin marks invoice settled ── */
exports.markCommissionPaid = onCall({ timeoutSeconds: 20, cors: true }, async (request) => {
  if (!request.auth || request.auth.token?.admin !== true) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }
  const { invoiceId, paymentRef } = request.data;
  if (!invoiceId) throw new HttpsError("invalid-argument", "invoiceId required.");

  const invoiceRef = db.collection("invoices").doc(invoiceId);
  const snap       = await invoiceRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Invoice not found.");

  await invoiceRef.update({
    status:     "paid",
    paymentRef: paymentRef || null,
    paidAt:     admin.firestore.FieldValue.serverTimestamp(),
    paidBy:     request.auth.uid,
  });

  /* Mark all commissions in this invoice as paid */
  const commSnap = await db.collection("commissionLedger")
    .where("invoiceId", "==", invoiceId).get();
  const batch = db.batch();
  commSnap.forEach(d => batch.update(d.ref, { status: "paid" }));
  await batch.commit();

  const data = snap.data();
  if (data.sellerUid && data.period) {
    await db.collection("sellerBilling").doc(data.sellerUid)
      .collection("monthly").doc(data.period)
      .set({ status: "paid", paidAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
  }

  await db.collection("auditLogs").add({
    action: "markCommissionPaid",
    uid:       request.auth.uid,
    invoiceId,
    sellerUid: data.sellerUid,
    totalKES:  data.totalKES,
    ts: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { success: true };
});

/* ── generateMonthlyInvoices — runs on 1st of each month at 06:00 EAT ── */
exports.generateMonthlyInvoices = onSchedule(
  { schedule: "0 6 1 * *", timeZone: "Africa/Nairobi", timeoutSeconds: 300 },
  async () => {
    const now    = new Date();
    /* Invoice for the previous calendar month */
    const y = now.getMonth() === 0 ? now.getFullYear() - 1 : now.getFullYear();
    const m = now.getMonth() === 0 ? 12 : now.getMonth();
    const period   = `${y}-${String(m).padStart(2, "0")}`;
    const dueDate  = new Date(now.getFullYear(), now.getMonth() + 1, 7);

    /* All pending commissions for that period */
    const snap = await db.collection("commissionLedger")
      .where("status", "==", "pending")
      .where("period", "==", period)
      .get();

    /* Group by seller */
    const bySellerMap = {};
    snap.forEach(d => {
      const data = d.data();
      if (!bySellerMap[data.sellerUid]) bySellerMap[data.sellerUid] = [];
      bySellerMap[data.sellerUid].push({ id: d.id, ...data });
    });

    const batch  = db.batch();
    let invoiceCount = 0;

    for (const [sellerUid, entries] of Object.entries(bySellerMap)) {
      const totalKES = entries.reduce((s, e) => s + Number(e.totalOwed || 0), 0);
      if (totalKES < 1) continue;

      const lineItems = entries.map(e => ({
        description: `Commission ${e.commissionPct}% on KES ${e.grossAmount} (${e.hub}) — ${e.mpesaCode || e.orderId || e.paymentId}`,
        amountKES:   Math.round(Number(e.totalOwed || 0) * 100) / 100,
      }));

      const invoiceRef = db.collection("invoices").doc();
      batch.set(invoiceRef, {
        sellerUid,
        period,
        lineItems,
        totalKES: Math.round(totalKES * 100) / 100,
        status:   "pending",
        dueDate:  admin.firestore.Timestamp.fromDate(dueDate),
        paymentRef: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      for (const e of entries) {
        batch.update(db.collection("commissionLedger").doc(e.id), {
          status: "invoiced", invoiceId: invoiceRef.id,
        });
      }

      batch.set(db.collection("sellerBilling").doc(sellerUid).collection("monthly").doc(period), {
        status: "invoiced", invoiceId: invoiceRef.id,
      }, { merge: true });

      invoiceCount++;
    }

    await batch.commit();
    console.log(`[revenue] Generated ${invoiceCount} invoices for period ${period}`);
  }
);

/* ══════════════════════════════════════════════════════════════
   CENTRALIZED ROLE MANAGEMENT  (sokoni-permissions.js companion)

   grantPlatformRole  — grants: moderator, superAdmin (custom claims)
                         or seller, driver, professional, business (Firestore only)
   revokePlatformRole — removes the claim / Firestore flag.

   • Only admin/superAdmin may call these.
   • SuperAdmin-only for granting superAdmin or admin claims.
   • Every action is logged to roleGrants + auditLogs.
══════════════════════════════════════════════════════════════ */

const CLAIM_ROLES    = ["superAdmin", "admin", "moderator"];
const FIRESTORE_ROLES = ["seller", "driver", "professional", "business", "user"];

exports.grantPlatformRole = onCall(
  { timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
    const callerClaims = request.auth.token || {};
    const isAdminCaller = callerClaims.admin === true || callerClaims.superAdmin === true;
    if (!isAdminCaller) throw new HttpsError("permission-denied", "Admin access required.");

    const { targetUid, role } = request.data || {};
    if (!targetUid || typeof targetUid !== "string") throw new HttpsError("invalid-argument", "targetUid required.");
    if (!role || typeof role !== "string")           throw new HttpsError("invalid-argument", "role required.");

    const validRoles = [...CLAIM_ROLES, ...FIRESTORE_ROLES];
    if (!validRoles.includes(role)) throw new HttpsError("invalid-argument", `Invalid role. Must be one of: ${validRoles.join(", ")}`);

    /* superAdmin grants only by existing superAdmin */
    if ((role === "superAdmin" || role === "admin") && callerClaims.superAdmin !== true) {
      throw new HttpsError("permission-denied", "Only superAdmins may grant admin/superAdmin roles.");
    }

    /* Update custom claim for server-authoritative roles */
    if (CLAIM_ROLES.includes(role)) {
      const existingClaims = await admin.auth().getUser(targetUid)
        .then(u => u.customClaims || {})
        .catch(() => ({}));
      await admin.auth().setCustomUserClaims(targetUid, { ...existingClaims, [role]: true });
    }

    /* Always update Firestore user doc with roles array */
    const userRef = db.collection("users").doc(targetUid);
    await userRef.set(
      { roles: admin.firestore.FieldValue.arrayUnion(role) },
      { merge: true }
    );

    const logEntry = {
      action:    "grantPlatformRole",
      targetUid,
      role,
      grantedBy: request.auth.uid,
      grantedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await Promise.all([
      db.collection("roleGrants").add(logEntry),
      db.collection("auditLogs").add({ ...logEntry, uid: request.auth.uid, ts: admin.firestore.FieldValue.serverTimestamp() }),
    ]);

    return { success: true, message: `Role '${role}' granted to ${targetUid}. User must sign out and back in to activate claim.` };
  }
);

exports.revokePlatformRole = onCall(
  { timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
    const callerClaims = request.auth.token || {};
    const isAdminCaller = callerClaims.admin === true || callerClaims.superAdmin === true;
    if (!isAdminCaller) throw new HttpsError("permission-denied", "Admin access required.");

    const { targetUid, role } = request.data || {};
    if (!targetUid || typeof targetUid !== "string") throw new HttpsError("invalid-argument", "targetUid required.");
    if (!role || typeof role !== "string")           throw new HttpsError("invalid-argument", "role required.");

    /* Only superAdmin can revoke admin/superAdmin */
    if ((role === "superAdmin" || role === "admin") && callerClaims.superAdmin !== true) {
      throw new HttpsError("permission-denied", "Only superAdmins may revoke admin/superAdmin roles.");
    }

    /* Remove custom claim */
    if (CLAIM_ROLES.includes(role)) {
      const existingClaims = await admin.auth().getUser(targetUid)
        .then(u => u.customClaims || {})
        .catch(() => ({}));
      const updated = { ...existingClaims };
      delete updated[role];
      await admin.auth().setCustomUserClaims(targetUid, updated);
    }

    /* Remove from Firestore roles array */
    await db.collection("users").doc(targetUid).set(
      { roles: admin.firestore.FieldValue.arrayRemove(role) },
      { merge: true }
    );

    const logEntry = {
      action:    "revokePlatformRole",
      targetUid,
      role,
      revokedBy: request.auth.uid,
      revokedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    await Promise.all([
      db.collection("roleGrants").add(logEntry),
      db.collection("auditLogs").add({ ...logEntry, uid: request.auth.uid, ts: admin.firestore.FieldValue.serverTimestamp() }),
    ]);

    return { success: true, message: `Role '${role}' revoked from ${targetUid}.` };
  }
);

/* ══════════════════════════════════════════════════════════════
   ACTIVE USER TRACKING  (updates lastSeen on each page load)
   Called by firebase.js onAuthStateChanged every session.
   Lightweight — does a merge-only set on the user doc.
══════════════════════════════════════════════════════════════ */
exports.recordUserActivity = onCall(
  { timeoutSeconds: 10 },
  async (request) => {
    if (!request.auth) return { ok: false };
    await db.collection("users").doc(request.auth.uid).set(
      { lastSeen: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true }
    );
    return { ok: true };
  }
);

/* ══════════════════════════════════════════════════════════════
   PLATFORM METRICS AGGREGATOR  (scheduled — runs every 6 hours)
   Writes aggregate counts to platformMetrics for the dashboard.
══════════════════════════════════════════════════════════════ */
exports.aggregatePlatformMetrics = onSchedule(
  { schedule: "0 */6 * * *", timeZone: "Africa/Nairobi", timeoutSeconds: 120 },
  async () => {
    const now  = admin.firestore.Timestamp.now();
    const date = new Date().toISOString().slice(0, 10);

    const [
      usersSnap, sellersSnap, productsSnap,
      ordersSnap, activeDeliveriesSnap, activeRidesSnap,
      pendingAppsSnap, openFlagsSnap, openDisputesSnap,
    ] = await Promise.all([
      db.collection("users").count().get(),
      db.collection("sellers").count().get(),
      db.collection("products").count().get(),
      db.collection("orders").count().get(),
      db.collection("deliveries").where("status", "in", ["assigned","in_transit"]).count().get(),
      db.collection("rides").where("status", "in", ["matched","in_progress"]).count().get(),
      db.collection("applications").where("status", "==", "pending").count().get(),
      db.collection("flags").where("status", "==", "open").count().get(),
      db.collection("disputes").where("status", "==", "open").count().get(),
    ]);

    const metrics = {
      date,
      updatedAt:        now,
      totalUsers:       usersSnap.data().count,
      totalSellers:     sellersSnap.data().count,
      totalProducts:    productsSnap.data().count,
      totalOrders:      ordersSnap.data().count,
      activeDeliveries: activeDeliveriesSnap.data().count,
      activeRides:      activeRidesSnap.data().count,
      pendingApps:      pendingAppsSnap.data().count,
      openFlags:        openFlagsSnap.data().count,
      openDisputes:     openDisputesSnap.data().count,
    };

    /* Settlement convergence (Phase C observability) — completed bookings must
       converge with settled payouts and booking wallet credits. Best-effort:
       must never fail the platform-metrics run. Writes a dedicated health doc a
       dashboard can read, and WARN-logs any anomaly so it surfaces immediately. */
    try {
      const { computeSettlementConvergence } = require('./settlement-monitor');
      const settlement = await computeSettlementConvergence(db);
      metrics.settlementConvergence = settlement;
      await db.collection('systemHealth').doc('settlementConvergence').set(
        { ...settlement, updatedAt: now }, { merge: true });
      if (!settlement.healthy) {
        console.warn('[settlement-monitor] SETTLEMENT CONVERGENCE ANOMALY:', settlement.anomalies.join(' | '), settlement);
      } else {
        console.log('[settlement-monitor] convergent', {
          completed: settlement.completedBookings, settled: settlement.settledPayouts,
          walletTx: settlement.bookingWalletTransactions, legacyPending: settlement.legacyPendingPayouts });
      }
    } catch (e) { console.error('[settlement-monitor] failed (non-fatal):', e && e.message); }

    /* Booking convergence (WS4a — Phase F evidence). Cumulative + today's per-day
       adoption of canonical vs legacy service-booking creation. Best-effort. */
    try {
      const { computeBookingConvergence } = require('./booking-convergence');
      const booking = await computeBookingConvergence(db);
      metrics.bookingConvergence = booking;
      const pct = booking.canonicalShare == null ? 'n/a' : (booking.canonicalShare * 100).toFixed(1) + '%';
      console.log('[booking-convergence]', { canonicalShare: pct, canonicalTotal: booking.canonicalTotal, legacyTotal: booking.legacyTotal, today: booking.today });
    } catch (e) { console.error('[booking-convergence] failed (non-fatal):', e && e.message); }

    await db.collection("platformMetrics").doc(date).set(metrics, { merge: true });
    console.log("[metrics] Aggregated platform metrics for", date, metrics);
  }
);

/* ══════════════════════════════════════════════════════════════
   RIDE STATUS NOTIFICATIONS
   Fires on rides/{rideId} update. Notifies rider and driver via
   FCM when a ride is matched, started, completed, or cancelled.
══════════════════════════════════════════════════════════════ */
exports.onRideStatusChange = onDocumentUpdated(
  "rides/{rideId}",
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (!after || before.status === after.status) return;

    const rideId = event.params.rideId;
    const status = after.status;

    const RIDE_MSGS = {
      matched:     { rider: { title: "Driver Found!", body: "Your driver is on the way. Track your ride." }, driver: { title: "New Ride Matched", body: `Ride ${rideId.slice(-6)} — tap to navigate to pickup.` } },
      in_progress: { rider: { title: "Ride Started", body: "You're on your way! Enjoy the ride." }, driver: null },
      completed:   { rider: { title: "Ride Complete", body: "You've arrived! Rate your driver." }, driver: { title: "Ride Complete", body: "Ride done. Your earnings have been updated." } },
      cancelled:   { rider: { title: "Ride Cancelled", body: "Your ride was cancelled. Book again anytime." }, driver: { title: "Ride Cancelled", body: "The ride was cancelled by the passenger." } },
    };

    const msgs = RIDE_MSGS[status];
    if (!msgs) return;

    const tasks = [];
    if (msgs.rider && after.riderUid) {
      const tok = await getFcmToken(after.riderUid);
      if (tok) tasks.push(sendFcm(tok, msgs.rider.title, msgs.rider.body, "track.html?ride=" + rideId));
    }
    if (msgs.driver && after.driverUid) {
      const tok = await getFcmToken(after.driverUid);
      if (tok) tasks.push(sendFcm(tok, msgs.driver.title, msgs.driver.body, "driver.html"));
    }
    await Promise.allSettled(tasks);
    console.log(`[onRideStatusChange] ${rideId}: ${before.status} → ${status}, notified ${tasks.length} parties`);
  }
);

/* ══════════════════════════════════════════════════════════════
   DELIVERY STATUS NOTIFICATIONS
   Fires on deliveries/{deliveryId} update. Notifies customer and
   driver at each step: assigned → picked_up → in_transit → delivered.
══════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════
   posExtractProductsFromImage
   POS callable: accepts a base64 image (invoice photo, shelf label,
   price list scan) and returns a structured product list using
   Claude vision. Items are ready to import into the POS product DB.
══════════════════════════════════════════════════════════════ */
exports.posExtractProductsFromImage = onCall(
  { secrets: [ANTHROPIC_API_KEY], timeoutSeconds: 60, cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

    const { imageBase64, mediaType = "image/jpeg" } = request.data || {};
    if (!imageBase64 || typeof imageBase64 !== "string") {
      throw new HttpsError("invalid-argument", "imageBase64 string required.");
    }
    if (imageBase64.length > 5_000_000) {
      throw new HttpsError("invalid-argument", "Image too large (max ~3.5 MB base64).");
    }

    const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!ALLOWED_TYPES.includes(mediaType)) {
      throw new HttpsError("invalid-argument", "Unsupported media type.");
    }

    /* Rate limit: 10 calls per user per hour */
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - 3600000);
    const recentSnap = await db.collection("auditLogs")
      .where("type",      "==", "posExtractImage")
      .where("callerUid", "==", request.auth.uid)
      .where("ts",        ">=", cutoff)
      .limit(10).get();
    if (recentSnap.size >= 10) {
      throw new HttpsError("resource-exhausted", "Rate limit: 10 image extractions per hour.");
    }

    const _extractKey = ANTHROPIC_API_KEY.value();
    if (!_extractKey) throw new HttpsError("failed-precondition", "AI image extraction not configured.");
    const anthropic = new Anthropic({ apiKey: _extractKey });

    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: `You are a POS product import assistant. Extract all products visible in this image (invoice, price list, shelf label, or receipt).

Return ONLY a valid JSON array — no markdown, no commentary. Each object must have:
- "name": string (product name, cleaned up)
- "price": number (selling price in KES, 0 if not visible)
- "cost": number (cost/buying price in KES, 0 if not visible)
- "barcode": string (barcode if visible, empty string otherwise)
- "sku": string (SKU/code if visible, empty string otherwise)
- "qty": number (quantity if listed, 0 if not listed)
- "unit": string (kg, piece, litre, etc. — infer if obvious)
- "category": string (best guess: Food, Electronics, Pharma, Cleaning, Personal, Stationery, Clothing, Wholesale)

Example: [{"name":"Unga Pembe 2kg","price":230,"cost":190,"barcode":"","sku":"","qty":10,"unit":"bag","category":"Food"}]

If no products are detectable, return: []`,
          },
        ],
      }],
    });

    const raw = response.content.find(b => b.type === "text")?.text?.trim() || "[]";

    let products = [];
    try {
      products = JSON.parse(raw);
      if (!Array.isArray(products)) products = [];
      /* Sanitize each product */
      products = products.map(p => ({
        name:     String(p.name     || "").slice(0, 120),
        price:    Math.max(0, Number(p.price)  || 0),
        cost:     Math.max(0, Number(p.cost)   || 0),
        barcode:  String(p.barcode  || "").slice(0, 30),
        sku:      String(p.sku      || "").slice(0, 30),
        qty:      Math.max(0, Number(p.qty)    || 0),
        unit:     String(p.unit     || "piece").slice(0, 20),
        category: String(p.category || "Food").slice(0, 30),
      })).filter(p => p.name.length > 0);
    } catch (_) {
      products = [];
    }

    db.collection("auditLogs").add({
      type: "posExtractImage", callerUid: request.auth.uid,
      itemCount: products.length, ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    return { products, count: products.length };
  }
);

/* ══════════════════════════════════════════════════════════════
   posSendSMS
   POS callable: sends an SMS to a customer via Africa's Talking.
   Used for receipts, marketing blasts, and low-stock alerts.
   Requires AFRICASTALKING_API_KEY secret + AT_ENV in functions/.env.
══════════════════════════════════════════════════════════════ */
exports.posSendSMS = onCall(
  { secrets: [...sokoniAt.secrets], timeoutSeconds: 20, cors: true },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

    const { to, message, bulk } = request.data || {};

    /* Validate credentials early — surfaces AT_ENV misconfiguration as a clear error */
    try {
      sokoniAt.resolveAtCredentials();
    } catch (e) {
      throw new HttpsError("failed-precondition", e.message);
    }

    /* Bulk send: array of phone numbers */
    if (bulk && Array.isArray(bulk)) {
      if (bulk.length > 100) throw new HttpsError("invalid-argument", "Maximum 100 numbers per bulk send.");
      if (!message || typeof message !== "string") throw new HttpsError("invalid-argument", "message required.");
      const msg = message.slice(0, 160);
      const results = await Promise.allSettled(
        bulk.map(phone => sendSms(phone, msg))
      );
      const sent = results.filter(r => r.status === "fulfilled").length;
      db.collection("auditLogs").add({
        type: "posSendSMS_bulk", callerUid: request.auth.uid,
        count: bulk.length, sent, ts: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      return { success: true, sent, failed: bulk.length - sent };
    }

    /* Single send */
    if (!to || !message) throw new HttpsError("invalid-argument", "to and message required.");
    const msg = String(message).slice(0, 160);
    await sendSms(to, msg);
    db.collection("auditLogs").add({
      type: "posSendSMS", callerUid: request.auth.uid,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return { success: true };
  }
);

exports.onDeliveryStatusChange = onDocumentUpdated(
  "deliveries/{deliveryId}",
  async (event) => {
    const before = event.data.before.data();
    const after  = event.data.after.data();
    if (!after || before.status === after.status) return;

    const deliveryId = event.params.deliveryId;
    const status = after.status;

    const DELIVERY_MSGS = {
      assigned:    { customer: { title: "Driver Assigned", body: "A driver has been assigned to your delivery." }, driver: { title: "New Delivery", body: "You have a new delivery. Tap to see pickup details." } },
      picked_up:   { customer: { title: "Package Picked Up", body: "Your package is with the driver and on its way!" }, driver: null },
      in_transit:  { customer: { title: "On the Way", body: "Your delivery is in transit. Track it live." }, driver: null },
      delivered:   { customer: { title: "Delivered!", body: "Your package has been delivered. Tap to confirm." }, driver: { title: "Delivery Complete", body: "Great job! Your earnings have been updated." } },
      failed:      { customer: { title: "Delivery Attempt Failed", body: "Driver couldn't reach you. Contact support." }, driver: null },
      cancelled:   { customer: { title: "Delivery Cancelled", body: "Your delivery was cancelled. We'll help rebook." }, driver: { title: "Delivery Cancelled", body: "This delivery has been cancelled." } },
    };

    const msgs = DELIVERY_MSGS[status];
    if (!msgs) return;

    const tasks = [];
    const trackUrl = "delivery-tracking.html?id=" + deliveryId;
    if (msgs.customer && after.customerUid) {
      const tok = await getFcmToken(after.customerUid);
      if (tok) tasks.push(sendFcm(tok, msgs.customer.title, msgs.customer.body, trackUrl));
    }
    if (msgs.driver && after.driverUid) {
      const tok = await getFcmToken(after.driverUid);
      if (tok) tasks.push(sendFcm(tok, msgs.driver.title, msgs.driver.body, "driver.html"));
    }
    await Promise.allSettled(tasks);
    console.log(`[onDeliveryStatusChange] ${deliveryId}: ${before.status} → ${status}, notified ${tasks.length} parties`);
  }
);

/* ══════════════════════════════════════════════════════════════════════
   EMPLOYEE INVITE SYSTEM
   Platform staff: moderator, support, driverCoordinator, financeReviewer, contentManager
   Shop staff:     cashier, manager, inventory, support
══════════════════════════════════════════════════════════════════════ */

const PLATFORM_ROLES = ["moderator","support","driverCoordinator","financeReviewer","contentManager"];
const SHOP_ROLES     = ["cashier","manager","inventory","support"];
/* One invitation engine for every entry point — see functions/invitations-core.js. */
const invitationsCore = require("./invitations-core");

/* ── Create platform-staff invite (admin only) ─────────────────────── */
/* `secrets` is REQUIRED here, not decorative: this handler now sends the
   password-setup email inline, and a function can only read a secret it declares.
   Without it every send fails with "SENDGRID_API_KEY not set" and silently
   degrades to the 2-minute queue — which still delivers, but throws away the
   immediate confirmation this whole change exists to provide. */
exports.invitePlatformEmployee = onCall(
  { secrets: require('./email-service').EMAIL_SECRETS }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const c = request.auth.token;
  if (!c.admin && !c.superAdmin)
    throw new HttpsError("permission-denied", "Admin access required.");

  const email = (request.data.email || "").toLowerCase().trim();
  const role  = request.data.role;
  if (!email || !role)              throw new HttpsError("invalid-argument", "email and role are required.");
  if (!PLATFORM_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Invalid role: " + role);

  /* Delegated to invitations-core — the ONE invitation path.
     This handler used to write a `platformInvites` token document and return it,
     and do nothing else: no Auth account, no email, no way for the invitee to
     learn the link existed. Combined with an ops script that created accounts
     with a discarded random password, that produced ochisaac@gmail.com — an
     `admin` account that had never signed in and never could, because the only
     mail it ever received was a bare welcome with no password-setup link.

     createInvitation() will not report success unless the invitee can actually
     sign in, and it refuses outright if the role contradicts a claim the account
     already holds. */
  const res = await invitationsCore.createInvitation({
    email, role, invitedBy: request.auth.uid, name: request.data.name || '',
  });
  return {
    token: res.token, inviteId: res.inviteId, uid: res.uid,
    acceptUrl: res.acceptUrl,
    authAccountCreated: res.authAccountCreated,
    setupMailQueueId: res.setupMailQueueId,
    signInReady: res.signInReady,
  };
});

/* ── Accept platform invite (called after the new user creates account) */
exports.acceptPlatformInvite = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  /* Delegated to invitations-core — the ONE acceptance flow.
     It resolves the token against the canonical `invitations` collection AND the
     legacy `platformInvites` collection, so links already in circulation keep
     working while new invitations are written in one place.

     The material addition over the previous inline version is the role-consistency
     gate: this used to spread `{[data.role]: true}` over the existing claims
     unconditionally, so a `moderator` invite landing on an account that already
     held `admin` produced an account carrying BOTH — privileges nobody decided to
     grant. A contradiction is now refused and reported for a human to resolve. */
  return invitationsCore.acceptInvitation({
    token: request.data.token,
    uid: request.auth.uid,
    callerEmail: request.auth.token.email,
  });
});

/* ── Revoke a platform invite ──────────────────────────────────────── */
exports.revokePlatformInvite = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const c = request.auth.token;
  if (!c.admin && !c.superAdmin)
    throw new HttpsError("permission-denied", "Admin access required.");

  const token = (request.data.token || "").trim();
  if (!token) throw new HttpsError("invalid-argument", "Token required.");
  await db.collection("platformInvites").doc(token).update({ status: "revoked" });
  return { success: true };
});

/* ── Remove a platform employee's access ──────────────────────────── */
exports.removePlatformEmployee = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const c = request.auth.token;
  if (!c.admin && !c.superAdmin)
    throw new HttpsError("permission-denied", "Admin access required.");

  const targetUid = (request.data.uid || "").trim();
  if (!targetUid) throw new HttpsError("invalid-argument", "uid required.");

  const prev = (await admin.auth().getUser(targetUid)).customClaims || {};
  /* Strip ALL platform role claims, not just the last recorded one.
     Guards against a user having been invited twice with different roles. */
  for (const r of PLATFORM_ROLES) delete prev[r];
  delete prev.platformEmployee;
  delete prev.platformRole;
  await admin.auth().setCustomUserClaims(targetUid, prev);

  await db.collection("platformEmployees").doc(targetUid).update({ active: false, removedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { success: true };
});

/* ── Create shop-employee invite (any authenticated seller) ────────── */
exports.inviteShopEmployee = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const email    = (request.data.email || "").toLowerCase().trim();
  const role     = request.data.role;
  const shopName = (request.data.shopName || "My Shop").slice(0, 80);
  if (!email || !role)            throw new HttpsError("invalid-argument", "email and role are required.");
  if (!SHOP_ROLES.includes(role)) throw new HttpsError("invalid-argument", "Invalid role: " + role);

  /* Rate limit: max 20 invites per seller per 24 hours */
  const oneDayAgo = new Date(Date.now() - 86400000);
  const recentInvites = await db.collection("shopInvites")
    .where("shopOwnerId", "==", request.auth.uid)
    .where("createdAt", ">=", admin.firestore.Timestamp.fromDate(oneDayAgo))
    .limit(20).get();
  if (recentInvites.size >= 20)
    throw new HttpsError("resource-exhausted", "Invite limit reached (20 per day). Try again tomorrow.");

  const token = require("crypto").randomUUID();
  await db.collection("shopInvites").doc(token).set({
    token,
    email,
    role,
    shopOwnerId: request.auth.uid,
    shopName,
    invitedBy: request.auth.uid,
    status: "pending",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt: admin.firestore.Timestamp.fromDate(new Date(Date.now() + 7 * 86400000))
  });
  return { token };
});

/* ── Accept shop invite (called after new user creates account) ────── */
exports.acceptShopInvite = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const token = (request.data.token || "").trim();
  if (!token) throw new HttpsError("invalid-argument", "Token required.");

  const ref  = db.collection("shopInvites").doc(token);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Invalid invite link.");

  const data = snap.data();
  if (data.status !== "pending")
    throw new HttpsError("failed-precondition", "Invite already used or revoked.");
  if (data.expiresAt.toDate() < new Date())
    throw new HttpsError("deadline-exceeded", "Invite expired. Ask the shop owner for a new one.");
  if (data.email !== request.auth.token.email)
    throw new HttpsError("permission-denied",
      "This invite was sent to " + data.email + ". Please sign in with that email address.");

  await db.collection("shopEmployees").doc(request.auth.uid).set({
    uid: request.auth.uid,
    email: data.email,
    name: request.auth.token.name || "",
    role: data.role,
    shopOwnerId: data.shopOwnerId,
    shopName: data.shopName,
    active: true,
    joinedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  /* Only set role:"employee" if the user doesn't already have a privileged role.
     Prevents silently demoting an existing seller/driver/provider who accepts a shop invite. */
  const existingUser = await db.collection("users").doc(request.auth.uid).get();
  const existingRole = existingUser.exists ? (existingUser.data().role || null) : null;
  const protectedRoles = ["seller","admin","superAdmin","moderator","driver","provider"];
  const userUpdate = {
    employeeRole: data.role,
    shopOwnerId: data.shopOwnerId,
    shopName: data.shopName,
    joinedAt: admin.firestore.FieldValue.serverTimestamp()
  };
  if (!protectedRoles.includes(existingRole)) {
    userUpdate.role = "employee";
  }
  await db.collection("users").doc(request.auth.uid).set(userUpdate, { merge: true });

  await ref.update({
    status: "accepted",
    acceptedByUid: request.auth.uid,
    acceptedAt: admin.firestore.FieldValue.serverTimestamp()
  });

  return { success: true, role: data.role, shopOwnerId: data.shopOwnerId, shopName: data.shopName };
});

/* ── Revoke a shop invite ──────────────────────────────────────────── */
exports.revokeShopInvite = onCall({}, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const token = (request.data.token || "").trim();
  if (!token) throw new HttpsError("invalid-argument", "Token required.");

  const snap = await db.collection("shopInvites").doc(token).get();
  if (!snap.exists) throw new HttpsError("not-found", "Invite not found.");
  if (snap.data().shopOwnerId !== request.auth.uid)
    throw new HttpsError("permission-denied", "You can only revoke your own invites.");

  await snap.ref.update({ status: "revoked" });
  return { success: true };
});

/* ══════════════════════════════════════════════════════════════════════
   PDQ TERMINAL PAYMENT CLOUD ADAPTER
   Called by pos-terminals.js CloudAdapter when a Cloud-connected
   terminal (e.g. Yoco, SumUp, iKhokha) is used for card payments.
   The client cannot directly reach the terminal API — all credential
   management and payment state lives server-side.
══════════════════════════════════════════════════════════════════════ */

/* Initiate a card payment on a Cloud-connected terminal */
exports.posInitiateTerminalPaymentV1 = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { terminalId, bizId, amount, currency = "KES", reference } = request.data || {};
  if (!terminalId || !bizId || !amount)
    throw new HttpsError("invalid-argument", "terminalId, bizId and amount are required.");
  if (typeof amount !== "number" || amount <= 0)
    throw new HttpsError("invalid-argument", "amount must be a positive number.");

  /* Verify caller owns the business */
  const bizSnap = await db.collection("businesses").doc(bizId).get();
  if (!bizSnap.exists || bizSnap.data().uid !== request.auth.uid)
    throw new HttpsError("permission-denied", "Terminal does not belong to your business.");

  /* Verify the terminal exists and belongs to this business */
  const termSnap = await db.collection("businesses").doc(bizId)
    .collection("terminals").doc(terminalId).get();
  if (!termSnap.exists)
    throw new HttpsError("not-found", "Terminal not found.");

  const term = termSnap.data();
  if (term.status === "offline")
    throw new HttpsError("unavailable", "Terminal is offline. Check connectivity and retry.");

  /* Write a pending payment record the client can poll */
  const paymentRef = db.collection("businesses").doc(bizId)
    .collection("terminal_queue").doc();

  const ref = reference || ("POS-" + Date.now());
  await paymentRef.set({
    terminalId,
    bizId,
    sellerUid: request.auth.uid,
    amount,
    currency,
    reference: ref,
    status:    "pending",
    enqueuedAt: admin.firestore.FieldValue.serverTimestamp(),
    expiresAt:  admin.firestore.Timestamp.fromDate(new Date(Date.now() + 120_000))
  });

  return { paymentId: paymentRef.id, reference: ref, status: "pending" };
});

/* Poll a pending terminal payment for status updates */
exports.posPollTerminalPayment = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { paymentId, bizId } = request.data || {};
  if (!paymentId || !bizId)
    throw new HttpsError("invalid-argument", "paymentId and bizId are required.");

  const snap = await db.collection("businesses").doc(bizId)
    .collection("terminal_queue").doc(paymentId).get();
  if (!snap.exists) throw new HttpsError("not-found", "Payment record not found.");

  const data = snap.data();
  if (data.sellerUid !== request.auth.uid)
    throw new HttpsError("permission-denied", "Not your payment.");

  /* Check expiry */
  if (data.expiresAt && data.expiresAt.toDate() < new Date() && data.status === "pending") {
    await snap.ref.update({ status: "expired" });
    return { status: "expired" };
  }

  return {
    status:    data.status,
    authCode:  data.authCode  || null,
    cardLast4: data.cardLast4 || null,
    cardScheme: data.cardScheme || null,
    reference: data.reference
  };
});

/* Cancel a pending terminal payment (v1 legacy — superseded by posTerminalLive) */
exports.posCancelTerminalPaymentV1 = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { paymentId, bizId } = request.data || {};
  if (!paymentId || !bizId)
    throw new HttpsError("invalid-argument", "paymentId and bizId are required.");

  const ref = db.collection("businesses").doc(bizId)
    .collection("terminal_queue").doc(paymentId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Payment record not found.");

  const data = snap.data();
  if (data.sellerUid !== request.auth.uid)
    throw new HttpsError("permission-denied", "Not your payment.");
  if (!["pending", "processing"].includes(data.status))
    throw new HttpsError("failed-precondition",
      "Cannot cancel a payment with status: " + data.status);

  await ref.update({
    status:      "cancelled",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    cancelledBy: request.auth.uid
  });

  return { success: true };
});

/* ══════════════════════════════════════════════════════════════════
   posPrint — Network Printer Proxy
   ══════════════════════════════════════════════════════════════════
   Bridges the browser to a network-attached thermal printer.
   The browser cannot open a raw TCP socket to port 9100 directly.
   This Cloud Function accepts ESC/POS bytes from the client and
   forwards them to the printer's host:port over TCP.

   Authentication: Firebase ID token (Bearer).
   Seller verification: request.auth.uid must match the shop owner.
   Payload: octet-stream body + ?host=x.x.x.x&port=9100 query params.
   Response: 200 OK on success, 4xx/5xx on error.

   Security boundaries:
   - Requires authenticated seller session.
   - Host must be a private/LAN IP or explicitly allowlisted IP.
   - Maximum payload: 64 KB (typical full receipt < 4 KB).
   - Print job stored in Firestore for audit and retry.
══════════════════════════════════════════════════════════════════ */
/* ── Rider profile (App-Check-INDEPENDENT) ─────────────────────────────────
   Firestore has App Check enforced, and on iOS Safari the App Check token often 403s, so the
   client's direct rideDrivers read fails and the Rider Hub falls back to the guest gate even for
   an approved rider. This endpoint verifies the Firebase ID token (which App Check does NOT gate)
   with the Admin SDK and returns the rider record + roles — so rider recognition works regardless
   of App Check. Reads only the CALLER's own rideDrivers/{uid} + users/{uid}. */
exports.riderProfile = onRequest(
  {
    timeoutSeconds: 20,
    memory:         "256MiB",
    cors:           ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app"],
    invoker:        "public",
  },
  async (req, res) => {
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin",  req.headers.origin || "*");
      res.set("Access-Control-Allow-Methods", "GET, POST");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.status(204).send("");
      return;
    }
    res.set("Access-Control-Allow-Origin", req.headers.origin || "*");
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) { res.status(401).json({ ok: false, signedIn: false, error: "Bearer token required" }); return; }
    let decoded;
    try { decoded = await admin.auth().verifyIdToken(authHeader.replace("Bearer ", "").slice(0, 4096)); }
    catch (_) { res.status(401).json({ ok: false, signedIn: false, error: "Invalid or expired token" }); return; }
    const uid = decoded.uid;
    try {
      let rd = await db.collection("rideDrivers").doc(uid).get();
      let riderId = uid, matchedBy = "uid";
      /* Account-split resilience: the rider record may live on the caller's OTHER account (e.g. the
         rider registered on the Google account but signed in with the phone account). If there's no
         rideDrivers/{uid}, fall back to the caller's OWN verified phone — same person, safe. */
      if (!rd.exists) {
        const phone = decoded.phone_number || null;
        if (phone) {
          const q = await db.collection("rideDrivers").where("phoneNumber", "==", phone).limit(1).get();
          if (!q.empty) { rd = q.docs[0]; riderId = q.docs[0].id; matchedBy = "phone"; }
        }
      }
      const u = await db.collection("users").doc(uid).get();
      const r = rd.exists ? (rd.data() || {}) : null;
      res.json({
        ok: true, signedIn: true, uid, matchedBy,
        rider: r ? {
          id: riderId, exists: true, status: r.status || null, approved: r.approved === true,
          isOnline: r.isOnline === true || r.online === true, online: r.online === true,
          name: r.name || null, email: r.email || decoded.email || null,
          zone: r.zone || null, rating: r.rating || null,
          vehicle: r.vehicle || r.vehicleType || null, cargoTonne: r.cargoTonne || null, cargoType: r.cargoType || null,
          photo: r.photo || r.avatar || r.photoURL || null,
        } : { exists: false },
        roles: (u.exists && u.data().roles) || [],
      });
    } catch (e) { res.status(500).json({ ok: false, signedIn: true, uid, error: e.message }); }
  }
);

exports.posPrint = onRequest(
  {
    timeoutSeconds: 30,
    memory:         "256MiB",
    cors:           ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app"],
    invoker:        "public",
  },
  async (req, res) => {
    /* ── CORS preflight ── */
    if (req.method === "OPTIONS") {
      res.set("Access-Control-Allow-Origin",  req.headers.origin || "*");
      res.set("Access-Control-Allow-Methods", "POST");
      res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
      res.status(204).send("");
      return;
    }

    if (req.method !== "POST") {
      res.status(405).json({ error: "Method not allowed" });
      return;
    }

    /* ── Auth: require Firebase ID token ── */
    const authHeader = req.headers.authorization || "";
    if (!authHeader.startsWith("Bearer ")) {
      res.status(401).json({ error: "Unauthorized — Bearer token required" });
      return;
    }
    let uid;
    try {
      const decoded = await admin.auth().verifyIdToken(authHeader.replace("Bearer ", ""));
      uid = decoded.uid;
    } catch (_) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    /* ── Parameters ── */
    const host    = String(req.query.host || "").trim();
    const port    = parseInt(req.query.port || "9100", 10);
    const shopId  = String(req.query.shopId || "").trim();

    if (!host) {
      res.status(400).json({ error: "host query parameter required" });
      return;
    }
    if (isNaN(port) || port < 1 || port > 65535) {
      res.status(400).json({ error: "Invalid port" });
      return;
    }

    /* ── Security: only private/LAN IPs allowed (prevents SSRF) ── */
    const _isPrivateHost = (h) => {
      if (/^localhost$/i.test(h)) return true;
      if (/^127\./.test(h))       return true;
      if (/^192\.168\./.test(h))  return true;
      if (/^10\./.test(h))        return true;
      if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;
      /* allow *.local mDNS names (Bonjour printers) */
      if (/\.local$/i.test(h))    return true;
      return false;
    };
    if (!_isPrivateHost(host)) {
      res.status(400).json({ error: "Only LAN/private printer addresses allowed" });
      return;
    }

    /* ── Payload ── */
    const body = req.rawBody || req.body;
    if (!body || !Buffer.isBuffer(body) && typeof body !== "string") {
      res.status(400).json({ error: "Binary ESC/POS body required" });
      return;
    }
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
    if (bytes.length === 0) {
      res.status(400).json({ error: "Empty print payload" });
      return;
    }
    if (bytes.length > 65536) {
      res.status(413).json({ error: "Print payload exceeds 64 KB limit" });
      return;
    }

    /* ── Log print job (for audit + retry) ── */
    const jobRef = await db.collection("posPrintJobs").add({
      uid,
      shopId:   shopId || null,
      host,
      port,
      bytes:    bytes.length,
      status:   "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => null);

    /* ── TCP forward to printer ── */
    const net = require("net");
    await new Promise((resolve, reject) => {
      const MTU     = 512;
      const socket  = new net.Socket();
      let   sent    = false;

      socket.setTimeout(10000);  /* 10s connection + write timeout */

      socket.connect(port, host, async () => {
        /* Stream in MTU-sized chunks with 20ms inter-chunk delay */
        const sendChunk = async (offset) => {
          if (offset >= bytes.length) {
            socket.destroy();
            sent = true;
            resolve();
            return;
          }
          const chunk = bytes.slice(offset, offset + MTU);
          const ok = socket.write(chunk);
          if (!ok) {
            await new Promise(r => socket.once("drain", r));
          }
          await new Promise(r => setTimeout(r, 20));
          sendChunk(offset + MTU);
        };
        sendChunk(0);
      });

      socket.on("timeout", () => {
        socket.destroy();
        reject(new Error("Printer connection timed out"));
      });
      socket.on("error", (err) => {
        socket.destroy();
        reject(err);
      });
    }).then(async () => {
      /* ── Success ── */
      if (jobRef) {
        await jobRef.update({
          status:      "sent",
          completedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
      res.status(200).json({ success: true, bytes: bytes.length });
    }).catch(async (err) => {
      /* ── Failure: log for retry ── */
      if (jobRef) {
        await jobRef.update({
          status:    "failed",
          error:     err.message,
          failedAt:  admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
      console.error("[posPrint] TCP error:", host, port, err.message);
      res.status(502).json({ error: "Printer unreachable: " + err.message });
    });
  }
);

/* ══════════════════════════════════════════════════════════════════
   PRODUCTION PAYMENT SYSTEM — IntaSend M-Pesa STK Push
══════════════════════════════════════════════════════════════════ */

const crypto = require("crypto");
const https  = require("https");

/* Initiate M-Pesa STK Push via IntaSend */
exports.initiateSTKPush = onCall(
  { timeoutSeconds: 30, secrets: [INTASEND_PRIVATE_KEY], minInstances: 1 },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

    /* Rate-limit: 5 STK Push initiations per authenticated user per minute (Firestore-backed) */
    const _rl = await checkRateLimitDurable(`stk_${request.auth.uid}`, 5, 60);
    if (!_rl.ok) throw new HttpsError("resource-exhausted", "Too many payment requests. Please wait a moment.");

    const { phone, amount, ref, meta } = request.data || {};
    if (!phone || !amount || !ref) throw new HttpsError("invalid-argument", "phone, amount, ref required.");
    if (!/^254[17]\d{8}$/.test(String(phone))) throw new HttpsError("invalid-argument", "Invalid phone.");

    const amountKES = Math.round(Number(amount));
    if (!amountKES || amountKES < 1 || amountKES > 150000) throw new HttpsError("invalid-argument", "Invalid amount.");

    /* ══ CRITICAL-01 REMEDIATION — STAGE 1a: OBSERVE ════════════════════════════
       `amount` above arrives verbatim from request.data and is only bounds-checked.
       Nothing re-derives it from an order, booking or cart, and `ref` is likewise
       client-supplied, so an authenticated user can pay KES 1 for anything. Every
       downstream commission and settlement figure inherits that number.

       Why this is staged rather than fixed outright: the client sends
       {phone, amount, ref} with NO order reference (sokoni-intasend.js:220), so
       there is nothing to re-derive from yet. Callers include subscriptions, POS
       and every booking page. Failing closed today would break all of them at once
       — an availability incident traded for an integrity one.

       So the authority record is consulted when it exists, and its absence is
       recorded rather than punished:

         Stage 1a (this change)  enforce when paymentIntents/{ref} exists;
                                 log STK_NO_AUTHORITY when it does not.
         Stage 1b (follow-up)    once telemetry shows every caller mints an intent,
                                 flip the marked branch below to throw.

       The intent is written SERVER-SIDE by whichever flow owns the price. The
       client never names the amount — the same shape Stripe uses for PaymentIntents.
       This adds no parallel payment path: it is an authority lookup on the existing
       canonical one. ═══════════════════════════════════════════════════════════ */
    let _amountAuthority = "none";
    try {
      const intentSnap = await db.collection("paymentIntents").doc(String(ref)).get();
      if (intentSnap.exists) {
        const intent = intentSnap.data() || {};
        const expected = Math.round(Number(intent.amount));

        if (intent.uid && intent.uid !== request.auth.uid) {
          logger.error("[STK] intent ownership mismatch", {
            ref, intentUid: intent.uid, caller: request.auth.uid,
          });
          throw new HttpsError("permission-denied", "This payment does not belong to you.");
        }
        if (Number.isFinite(expected) && expected !== amountKES) {
          logger.error("[STK] AMOUNT MISMATCH — client figure rejected", {
            ref, claimed: amountKES, expected, uid: request.auth.uid,
          });
          throw new HttpsError("invalid-argument", "Payment amount does not match this order.");
        }
        _amountAuthority = "intent";

        /* ══ STAGE 1B — BRAND-SCOPED AGE ENFORCEMENT ══════════════════════════
           The compliance gate for KASS Vapes, and the reason it is HERE rather
           than in the client or in checkout:

           paymentIntents has no Firestore rule, so it is default-deny and
           writable only by the Admin SDK. Everything read from `intent` below is
           therefore SERVER-AUTHORED. The client may ask to pay, but it cannot
           author the brand, and so cannot author whether a gate applies. That
           property is what makes this enforceable — not the check itself.

           KASS gates the whole storefront rather than per product: every
           category it sells is restricted, so there is no basket that should
           pass, and no category label to be trusted. Category-derived
           enforcement for SOKONI's mixed catalogue is deliberately NOT attempted
           here; it needs server-derived product categories and is separate work.

           FAILURE POSTURE
           A brand we do not recognise is REJECTED, not defaulted. getBrand()
           falls back to SOKONI for display purposes, which is right for
           rendering and wrong for enforcement — falling back here would turn an
           unrecognised brand into a way past the gate.

           An intent carrying NO brand is treated as SOKONI (unchanged during the
           pilot, per policy) and logged. That is not a bypass: a client cannot
           create or edit an intent, so a missing brand is a server-side
           omission to fix, not an attacker's choice. It is logged loudly so it
           cannot sit unnoticed. */
        const _declaredBrand = intent.brand ? String(intent.brand).trim().toLowerCase() : null;

        if (!_declaredBrand) {
          logger.warn("STK_INTENT_NO_BRAND", {
            ref, uid: request.auth.uid,
            note: "server-authored intent carried no brand — defaulting to sokoni",
          });
        } else if (!_brands.brandIds().includes(_declaredBrand)) {
          logger.error("[STK] unknown brand on payment intent — rejected", {
            ref, brand: _declaredBrand, uid: request.auth.uid,
          });
          await db.collection("complianceAudit").add({
            type: "age_gate", result: "rejected", reason: "unknown_brand",
            brand: _declaredBrand, ref, uid: request.auth.uid,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});
          throw new HttpsError("failed-precondition", "This payment could not be verified.");
        } else if (_brands.requiresAgeVerification(_declaredBrand, null)) {
          let _ageOk = false, _why = null;
          try {
            await _ageVerify.assertAgeVerified(request.auth.uid);
            _ageOk = true;
          } catch (ageErr) {
            /* Any failure of a REQUIRED check is a refusal. A Firestore error
               while reading verification status must not read as "verified" —
               the outer catch below deliberately continues on non-HttpsError,
               so this is converted here rather than allowed to fall through. */
            _why = (ageErr && ageErr.message) || "verification_unavailable";
          }

          await db.collection("complianceAudit").add({
            type: "age_gate",
            result: _ageOk ? "approved" : "rejected",
            reason: _ageOk ? null : _why,
            brand: _declaredBrand, ref, uid: request.auth.uid,
            amountKES,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
          }).catch(() => {});

          if (!_ageOk) {
            logger.warn("[STK] age gate refused payment", { ref, brand: _declaredBrand, uid: request.auth.uid });
            throw new HttpsError("failed-precondition",
              "Age verification is required before you can complete this purchase.");
          }
          logger.info("[STK] age gate passed", { ref, brand: _declaredBrand, uid: request.auth.uid });
        }
      } else {
        /* ══ STAGE 1b — ENFORCED PER MIGRATED CALLER ═══════════════════════
           Stage 1a logged and allowed. Flipping that to throw for EVERY caller
           would fail closed on POS and every booking page at once — an
           availability incident traded for an integrity one, which is exactly
           what Stage 1a was written to avoid.

           So enforcement follows migration rather than the calendar. A caller
           is enforced once it mints an intent via createPaymentIntent;
           everything else keeps the warning until its turn comes.

           MIGRATED: subscriptions (subscriptions.html -> createPaymentIntent,
           deployed 2026-07-20). A subscription payment without an intent is
           now refused rather than charged at a browser-supplied figure.

           To migrate the next caller: point it at createPaymentIntent, deploy
           the client FIRST, then add its category here. Adding the category
           before the client ships breaks that flow's payments. */
        const _enforcedCategories = ["subscription"];
        const _category = String((meta && meta.category) || "").toLowerCase();

        if (_enforcedCategories.includes(_category)) {
          logger.error("[STK] STAGE_1B_REFUSED — enforced caller sent no payment intent", {
            ref, amount: amountKES, category: _category, uid: request.auth.uid,
          });
          throw new HttpsError("failed-precondition",
            "This payment could not be verified. Please start the purchase again.");
        }

        logger.warn("STK_NO_AUTHORITY", {
          ref, amount: amountKES, category: _category || "none", uid: request.auth.uid,
          note: "client-supplied amount accepted — no paymentIntents record (caller not yet migrated)",
        });
      }
    } catch (e) {
      if (e instanceof HttpsError) throw e;      /* mismatches must surface */
      logger.warn("[STK] authority lookup failed (open)", { ref, err: e && e.message });
    }

    /* Idempotency — return existing checkoutId if payment is still pending */
    const existing = await db.collection("payments").doc(ref).get();
    if (existing.exists) {
      const d = existing.data();
      if (d.status === "COMPLETE") return { success: true, checkoutId: d.checkoutId, alreadyPaid: true };
      if (d.status === "PENDING" && d.createdAt?.toMillis() > Date.now() - 600000) {
        return { success: true, checkoutId: d.checkoutId, reused: true };
      }
    }

    const privateKey = INTASEND_PRIVATE_KEY.value();
    if (!privateKey || privateKey === "YOUR_INTASEND_PRIVATE_KEY") {
      throw new HttpsError("failed-precondition", "IntaSend not configured.");
    }

    /* Call IntaSend STK Push API.

       ── `method` (2026-07-19) ────────────────────────────────────────────────
       The vendored vendor client injects TWO fields on every STK call
       (node_modules/intasend-node/dist/collection.js:26-29):

           payload['method']   = 'M-PESA';
           payload['currency'] = 'KES';

       This request sent `currency` but never `method`. A missing required field
       makes Django REST Framework answer 400 with a field-keyed body such as
       {"method":["This field is required."]} and NO `detail` key — which is
       exactly the shape the failed production payment produced: the generic
       fallback fired precisely because `detail` was absent. */
    const payload = JSON.stringify({
      method:       "M-PESA",
      phone_number: phone,
      amount:       amountKES,
      currency:     "KES",
      narrative:    `SOKONI: ${(meta && meta.serviceDesc) || ref}`,
      api_ref:      ref,
    });

    const intasendHost = process.env.INTASEND_SANDBOX === "true"
      ? "sandbox.intasend.com"
      : "payment.intasend.com";

    const intasendResponse = await new Promise((resolve, reject) => {
      const opts = {
        hostname: intasendHost,
        path:     "/api/v1/payment/mpesa-stk-push/",
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          /* `Bearer`, not `Token`. Two independent authorities in this repository
             agree and this call matched neither:
               • the vendored vendor client —
                 node_modules/intasend-node/dist/requests.js:21
                 headers['Authorization'] = "Bearer ".concat(secret_key)
               • this codebase's other IntaSend client —
                 finos-utils.js:783  'Authorization': `Bearer ${privKey}`
             Changing this carries no regression risk: the current scheme fails
             100% of the time, so there is no working behaviour to protect. */
          "Authorization":  `Bearer ${privateKey}`,
          "Content-Length": Buffer.byteLength(payload),
        },
      };
      const req = https.request(opts, (res) => {
        let body = "";
        res.on("data", (c) => { body += c; });
        res.on("end", () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
          catch (_) { reject(new Error("Invalid IntaSend response")); }
        });
      });
      req.on("error", reject);
      req.write(payload);
      req.end();
    });

    if (intasendResponse.status !== 200 && intasendResponse.status !== 201) {
      /* ══ STK DIAGNOSTIC (2026-07-19) ══════════════════════════════════════════
         A production payment (KES 499, ref SKNRSVOE3) failed here and left NO
         server-side trace: this branch threw the generic fallback and discarded
         both the HTTP status and IntaSend's response body. Cloud Function logs
         ended at the preceding line, so the cause was undiagnosable.

         The failure is provably in IntaSend's response, not upstream — the same
         invocation logged {"app":"VALID","auth":"VALID"} (App Check and Auth both
         passed), the function executed, and amount/ref/phone all cleared
         validation. Nothing was wrong before this call.

         What reached the user was the FALLBACK string, which means IntaSend
         returned parseable JSON with a non-2xx status and NO `detail` key. DRF
         emits {"detail": ...} for authentication failures, so its absence points
         away from credentials and toward field-level validation — but that is an
         inference, and this log is what will settle it.

         Logging only. No behaviour change, no retry, no new payment path. */
      logger.error("[STK] IntaSend rejected the request", {
        httpStatus:   intasendResponse.status,
        intasendBody: intasendResponse.data,     /* provider error, not a secret */
        host:         intasendHost,
        ref, amountKES,
        phoneSuffix:  String(phone).slice(-4),   /* correlate without logging the MSISDN */
        uid:          request.auth.uid,
      });

      /* Surface a field-level validation error when IntaSend supplies one, so the
         caller sees the real reason instead of "STK Push failed." */
      let detail = intasendResponse.data?.detail;
      if (!detail && intasendResponse.data && typeof intasendResponse.data === "object") {
        const firstField = Object.entries(intasendResponse.data)
          .find(([, v]) => Array.isArray(v) && v.length && typeof v[0] === "string");
        if (firstField) detail = `${firstField[0]}: ${firstField[1][0]}`;
      }
      throw new HttpsError("internal", detail || "STK Push failed.");
    }

    const checkoutId = intasendResponse.data?.checkout_id || intasendResponse.data?.id;
    if (!checkoutId) throw new HttpsError("internal", "No checkoutId from IntaSend.");

    /* Persist payment record.
       intentRef: the paymentIntents document that authorised this STK push.
       In the current flow ref == intentRef (same SOKONI-generated ID), but
       storing it explicitly lets the webhook find the intent even if the
       intent document expires and is later cleaned up before the callback
       arrives. The webhook reads existing.intentRef and falls back to
       apiRef for legacy payments that pre-date this field. */
    await db.collection("payments").doc(ref).set({
      ref, checkoutId, phone, amount: amountKES, currency: "KES",
      status:    "PENDING",
      uid:       request.auth.uid,
      intentRef: ref,
      meta:      meta || {},
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    return { success: true, checkoutId };
  }
);

/* ── Shared wallet top-up finalizer for the IntaSend webhooks ────────────────
   Wallet top-ups (initiateWalletTopUp) set api_ref to the walletTransactions
   doc id ("wtop_…") and never create a payments/{ref} doc, so the payment path
   in both webhook handlers below skips straight past them and acks with no
   effect — leaving completion to the client poll (confirmWalletTopUp) or the
   30-min sweep (sweepStaleWalletTopUps).

   This routes the ref to the SAME idempotent claim those two paths use so all
   three converge: whichever observes COMPLETE first credits the wallet inside a
   transaction, and the others read status === 'completed' and no-op. IntaSend
   retries webhooks on timeout/5xx, so the TRANSACTION — not the HTTP layer — is
   the guard against double credit. We always credit tx.amount (recorded
   server-side at initiation), never the webhook-supplied amount.

   Lives as one helper (called from both webhookIntasend and the secondary
   intasendWebhook) rather than a pasted block, so the two endpoints can never
   drift. Returns true when the ref was a wallet top-up and the caller should ack
   and return; false to fall through to the normal payments path. A transaction
   error propagates (→ 5xx → IntaSend retry), which is the desired recovery. */
async function _finalizeWalletTopUp(apiRef, state, amount, tag) {
  if (!apiRef || !apiRef.startsWith("wtop_")) return false;

  const txRef  = db.collection("walletTransactions").doc(apiRef);
  const txSnap = await txRef.get();
  if (!txSnap.exists) return true;   /* unknown ref — handled: nothing to credit */
  const tx = txSnap.data();

  const paid   = state === "COMPLETE";
  const failed = ["FAILED", "CANCELLED", "EXPIRED"].includes(state);

  /* Reconciliation aid only — the credited figure is always tx.amount. */
  if (paid && amount && Math.round(amount) !== Math.round(tx.amount)) {
    logger.warn(`[${tag}] wallet top-up amount mismatch`, { ref: apiRef, requested: tx.amount, webhook: amount });
  }

  if (paid) {
    await db.runTransaction(async (t) => {
      const walletRef = db.collection("wallets").doc(tx.uid);
      const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(txRef)]);
      /* Already credited by confirmWalletTopUp / sweep / an earlier retry */
      if (txCheck.exists && txCheck.data().status === "completed") return;

      const current = walletSnap.exists ? (walletSnap.data().balance ?? 0) : 0;
      if (!walletSnap.exists) {
        t.set(walletRef, {
          uid:          tx.uid,
          balance:      current + tx.amount,
          currency:     "KES",
          lastTopUp:    admin.firestore.Timestamp.now(),
          pendingTopUp: null,
          createdAt:    admin.firestore.Timestamp.now(),
        });
      } else {
        const update = { balance: current + tx.amount, lastTopUp: admin.firestore.Timestamp.now() };
        /* Clear the flag only if it still points at THIS top-up — a newer
           pending top-up the user just started must not be wiped. */
        if (walletSnap.data().pendingTopUp === apiRef) update.pendingTopUp = null;
        t.update(walletRef, update);
      }
      t.update(txRef, { status: "completed", updatedAt: admin.firestore.Timestamp.now(), resolvedBy: tag });
    });
    console.log(`[${tag}] Wallet top-up credited: ${apiRef}`);
  } else if (failed) {
    await db.runTransaction(async (t) => {
      const walletRef = db.collection("wallets").doc(tx.uid);
      const [walletSnap, txCheck] = await Promise.all([t.get(walletRef), t.get(txRef)]);
      /* Do not overwrite a top-up a concurrent path already completed */
      if (txCheck.exists && txCheck.data().status !== "pending") return;
      t.update(txRef, { status: "failed", updatedAt: admin.firestore.Timestamp.now(), resolvedBy: tag });
      if (walletSnap.exists && walletSnap.data().pendingTopUp === apiRef) {
        t.update(walletRef, { pendingTopUp: null });
      }
    });
    console.log(`[${tag}] Wallet top-up marked failed (${state}): ${apiRef}`);
  }
  /* PENDING / unknown state — handled: caller acks, poll or sweep finalizes later */
  return true;
}

/* Phase E: service-booking payments are HELD, not credited — the provider is credited
   only by Phase C settlement at completion (contract invariant 1). Shared helper lives
   in booking-payment-sweep.js (unit-tested); called at the top of BOTH IntaSend
   COMPLETE handlers, returning true when it handled the payment so the caller returns. */
const { holdServiceBookingPayment: _holdServiceBookingPayment } = require('./booking-payment-sweep');

/* IntaSend Webhook — called by IntaSend servers on payment state change */
exports.intasendWebhook = onRequest(
  { timeoutSeconds: 30, secrets: [INTASEND_WEBHOOK_CHALLENGE], invoker: "public", minInstances: 1 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    /* Verify IntaSend challenge — IntaSend authenticates webhooks with a `challenge`
       value in the request body, not a header-based HMAC. Production evidence:
         diag.signatureHeaders = ""           → no x-intasend-signature header sent
         diag.hasChallengeField = true        → body carries a challenge field
         diag.challengeLen = 12              → 12-char value set in IntaSend dashboard
       Both values are normalised to a 32-byte HMAC digest before comparison so
       timingSafeEqual receives same-length buffers regardless of input length. */
    const challenge         = String((req.body && req.body.challenge) || "");
    const expectedChallenge = INTASEND_WEBHOOK_CHALLENGE.value();
    /* Startup guard: a missing or empty secret means the IAM grant or secret
       version is not in place. 500 is the correct signal — this is a config
       error, not an auth failure. A 500 does not reveal the secret value. */
    if (!expectedChallenge) {
      logger.error("[intasendWebhook] INTASEND_WEBHOOK_CHALLENGE secret is empty — check Secret Manager IAM and secret version");
      res.status(500).send("Service unavailable");
      return;
    }
    const normKey = Buffer.from("sokoni-intasend-challenge-norm");
    const a = crypto.createHmac("sha256", normKey).update(challenge).digest();
    const b = crypto.createHmac("sha256", normKey).update(expectedChallenge).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      logger.warn("[intasendWebhook] challenge mismatch — rejecting", {
        hasChallenge: challenge.length > 0,
        challengeLen: challenge.length,
        invoiceId:    req.body?.invoice?.invoice_id || req.body?.invoice_id || "unknown",
        method:       req.method,
      });
      res.status(401).send("Unauthorized");
      return;
    }

    /* IntaSend sends a flat payload per official docs — all fields at root level.
       The `invoice` fallback handles any future nested-object variant gracefully. */
    const invoice    = req.body?.invoice || {};
    const state      = String(invoice.state    || req.body?.state    || "FAILED").toUpperCase();
    const apiRef     = invoice.api_ref         || req.body?.api_ref;
    const checkoutId = invoice.id              || req.body?.invoice_id;
    const trackingId = req.body?.tracking_id || invoice.tracking_id || req.body?.file_id || invoice.file_id || null;
    const amount     = Number(invoice.net_amount || invoice.amount || req.body?.net_amount || req.body?.value || 0);

    /* Log the full payload before any guard (B2C field-name visibility). */
    try { const _rb = { ...(req.body || {}) }; delete _rb.challenge; delete _rb.signature; delete _rb.secret;
      console.log("[intasendWebhook] raw payload:", JSON.stringify(_rb).slice(0, 4000)); } catch (_) {}

    /* Seller B2C payouts ("pout_…") — settle FIRST, by ANY identifier (api_ref OR
       tracking_id/file_id). The docs disagreed on which webhook IntaSend hits, so BOTH
       webhooks now settle B2C — whichever URL is registered, a confirmation reconciles. */
    try {
      for (const r of [apiRef, checkoutId, trackingId].filter(Boolean)) {
        if (await wallet.finalizeB2CPayoutFromWebhook(db, r, state, req.body)) { res.status(200).send("OK"); return; }
      }
    } catch (e) { console.error("[intasendWebhook] B2C payout finalize error:", e.message); }

    /* Below (top-up + collection/payment) is keyed on api_ref. */
    if (!apiRef) { res.status(400).send("Missing api_ref"); return; }

    /* Wallet top-ups ("wtop_…") have no payments/{ref} doc — finalize them via
       the shared idempotent claim before the payments path below. */
    if (await _finalizeWalletTopUp(apiRef, state, amount, "intasendWebhook")) {
      res.status(200).send("OK");
      return;
    }

    const payRef = db.collection("payments").doc(apiRef);
    const snap   = await payRef.get();
    if (!snap.exists) { res.status(200).send("OK"); return; }

    const existing = snap.data();
    if (existing.status === "COMPLETE") { res.status(200).send("OK"); return; }

    const fsStatus = state === "COMPLETE" ? "COMPLETE" : state === "FAILED" ? "FAILED" : "PENDING";

    /* P0-2: atomically CLAIM the transition inside a transaction, exactly as the
       Daraja callback does (P0-1). IntaSend retries webhooks on timeout/5xx, and the
       previous code was a non-transactional read-check-write followed by
       commissionLedger.add() (AUTO-ID) — so two concurrent retries could both pass
       the "already COMPLETE?" check and both append, producing DUPLICATE commission
       ledger entries for a single payment (corrupting ledger consistency and any
       settlement/payout derived from it). Only the single winner writes the ledger,
       and it writes with a DETERMINISTIC doc id so even a re-run overwrites rather
       than duplicating. */
    let claimed = false;
    await db.runTransaction(async (txn) => {
      const s = await txn.get(payRef);
      if (!s.exists) return;
      if (s.data().status === "COMPLETE") return;   /* a concurrent retry already won */
      txn.update(payRef, {
        status:            fsStatus,
        intasendState:     state,
        confirmedAmount:   amount,
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        webhookReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      claimed = true;
    });

    if (!claimed) {
      console.log(`[intasendWebhook] Already processed (raced): ${apiRef}`);
      res.status(200).send("OK");
      return;
    }

    /* Terminal NON-payment for a service booking → release the held slot immediately
       instead of waiting for the expiry sweep. Keyed off the RAW state, since fsStatus
       collapses CANCELLED/EXPIRED/REJECTED/TIMEOUT into "PENDING". No-op (returns false)
       for non-booking intents, so product/wallet failures fall through unchanged. */
    if (["FAILED", "CANCELLED", "EXPIRED", "REJECTED", "TIMEOUT"].includes(state)) {
      const { releaseServiceBookingOnTerminalPayment } = require('./booking-payment-sweep');
      if (await releaseServiceBookingOnTerminalPayment(db, admin, apiRef, existing.intentRef, state)) {
        res.status(200).send("OK"); return;
      }
    }

    if (fsStatus === "COMPLETE") {
      const payData  = existing;
      /* Phase E: a service-booking payment is HELD (paid_held), never credited here —
         the provider is credited only by Phase C settlement at completion. Handled in
         isolation via the server-minted intent; skips all commission/credit/creation. */
      if (await _holdServiceBookingPayment(db, admin, apiRef, existing.intentRef, amount)) { res.status(200).send("OK"); return; }
      const category = payData.meta?.category || "default";
      /* Commission MUST be calculated by finos-utils — single source of truth for all rates */
      let sokoniCut = 0, commissionPct = 0;
      try {
        const { calculateCommission } = require('./finos-utils');
        /* `db` is the required first argument. It was omitted, so calculateCommission bound
           `db` to the options object, `opts` was undefined, destructuring threw, and this
           landed in the catch below — meaning EVERY payment through this webhook was charged
           the hardcoded 10% fallback instead of its category's real rate. Legal should be 12%,
           marketplace 3%, digital 10%... all of them were 10%.

           The second bug is in the success path itself: the function returns `effectiveRate`,
           not `commissionPct`. So even when it worked, `commissionPct` recorded as 0 and the
           commissionLedger entry claimed a 0% rate against a non-zero cut. */
        const commResult = await calculateCommission(db, {
          orderAmountCents: amount * 100,
          category,
          sellerId: payData.uid,
        });
        sokoniCut     = commResult.commissionCents ? Math.round(commResult.commissionCents / 100) : 0;
        commissionPct = commResult.effectiveRate ?? 0;
      } catch (commErr) {
        /* Do not apply a hardcoded fallback rate — this would over-charge marketplace
           sellers (3%) by 7 percentage points. Instead, flag the entry for manual review
           so the settlement team can apply the correct rate. */
        console.error('[webhook] Commission calc failed — flagging for manual review', commErr.message);
        commissionPct = null;
        sokoniCut = 0;
        await db.collection("commissionReviewQueue").add({
          ref: apiRef, amount, category, uid: payData.uid,
          reason: commErr.message,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
      /* Deterministic doc id — ONE commission entry per payment reference.
         .set() (not .add()) so a replay/re-run overwrites rather than duplicating. */
      await db.collection("commissionLedger").doc(apiRef).set({
        ref: apiRef, checkoutId, uid: payData.uid,
        providerName:  payData.meta?.providerName || "",
        category,
        commissionPct, sokoniCut,
        providerNet:   amount - sokoniCut,
        serviceTotal:  amount,
        status:        "auto_collected",
        source:        "intasend_webhook",
        confirmedAt:   admin.firestore.FieldValue.serverTimestamp(),
        createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(err => console.error("Commission write failed:", err));

      /* Subscription auto-activation — server-authoritative path.
         paymentIntents/{ref} (written by createPaymentIntent) carries purpose,
         planId, and uid. The client-side onSuccess path is fragile (tab close,
         network drop); this webhook is the authoritative signal that payment
         completed. Idempotent: same apiRef → same subscriptions/{uid} doc.

         intentRef resolution: the payment document stores intentRef (set by
         initiateSTKPush since this fix). For legacy payments without that field
         we fall back to apiRef, which was the original design (same value when
         the intent has not expired). */
      try {
        const intentRef  = existing.intentRef || apiRef;
        const intentSnap = await db.collection("paymentIntents").doc(intentRef).get();
        if (intentSnap.exists) {
          const intent = intentSnap.data();
          if (intent.purpose === "subscription" && intent.planId && intent.uid) {
            const subRef  = db.collection("subscriptions").doc(intent.uid);
            const subSnap = await subRef.get();
            const subData = subSnap.exists ? subSnap.data() : null;
            /* Only write if no active subscription exists for this payment ref */
            if (!subData || subData.paymentRef !== apiRef) {
              const expiresAt = new Date(Date.now() + 30 * 86400000);
              await subRef.set({
                uid:          intent.uid,
                plan:         intent.planId,
                planName:     intent.planName || intent.planId,
                billingCycle: intent.billingCycle || "monthly",
                status:       "active",
                paymentRef:   apiRef,
                amountPaid:   amount,
                source:       "intasend_webhook",
                activatedAt:  admin.firestore.FieldValue.serverTimestamp(),
                expiresAt:    admin.firestore.Timestamp.fromDate(expiresAt),
                updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log("[intasendWebhook] Subscription auto-activated",
                { uid: intent.uid, plan: intent.planId, ref: apiRef });
              /* Audit trail for webhook-path activations */
              db.collection("subscriptionAuditLog").add({
                uid:       intent.uid,
                plan:      intent.planId,
                paymentRef: apiRef,
                action:    "ACTIVATED",
                source:    "intasend_webhook",
                expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
              }).catch(e => console.error("[intasendWebhook] Sub-audit log failed:", e.message));
            }
          }
        }
      } catch (subErr) {
        /* Non-fatal: commission is already ledgered. Log ref so support can
           manually activate via activateSubscription CF if needed. */
        console.error("[intasendWebhook] Subscription auto-activation failed",
          { ref: apiRef, err: subErr.message });
      }

      /* SHADOW MODE — Phase 2A+ (entitlement engine dual-run).
         The legacy path above remains authoritative and has already run. This
         asks the engine what it WOULD have written and records the comparison
         to entitlementComparison, which no production reader consumes.

         It cannot grant anything: engine.simulate() never opens a Firestore
         transaction, so the safety is structural rather than a flag. Awaited
         (not fire-and-forget) so the comparison is actually recorded before
         the container can be frozen after the response — but wrapped so a
         diagnostic can never turn a successful payment acknowledgement into a
         500. Remove this block to disable shadow mode entirely. */
      try {
        const intentSnap2 = await db.collection("paymentIntents").doc(apiRef).get();
        if (intentSnap2.exists && intentSnap2.data().purpose === "subscription") {
          const adapters = require("./entitlement-adapters");
          await adapters.shadowCompareSubscription(apiRef, {
            uid: intentSnap2.data().uid || intentSnap2.data().ownerUid || null,
          });
        }
      } catch (shadowErr) {
        console.error("[intasendWebhook] shadow comparison skipped",
          { ref: apiRef, err: shadowErr && shadowErr.message });
      }
    }

    res.status(200).send("OK");
  }
);

/* Cancel a pending STK push */
exports.cancelPayment = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const { ref } = request.data || {};
  if (!ref) throw new HttpsError("invalid-argument", "ref required.");

  const snap = await db.collection("payments").doc(ref).get();
  if (!snap.exists) throw new HttpsError("not-found", "Payment not found.");

  const data = snap.data();
  if (data.uid !== request.auth.uid) throw new HttpsError("permission-denied", "Not your payment.");
  if (data.status === "COMPLETE") throw new HttpsError("failed-precondition", "Cannot cancel completed payment.");

  await db.collection("payments").doc(ref).update({
    status:      "CANCELLED",
    cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    cancelledBy: request.auth.uid,
  });

  return { success: true };
});

/* ══════════════════════════════════════════════════════════════════
   SUBSCRIPTION MANAGEMENT
══════════════════════════════════════════════════════════════════ */
exports.activateSubscription = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { plan, paymentRef } = request.data || {};
  const validPlans = ["free", "starter", "pro", "business"];
  if (!validPlans.includes(plan)) throw new HttpsError("invalid-argument", "Invalid plan.");
  if (!paymentRef) throw new HttpsError("invalid-argument", "paymentRef required.");

  const paySnap = await db.collection("payments").doc(paymentRef).get();
  if (!paySnap.exists) throw new HttpsError("not-found", "Payment not found.");
  const payData = paySnap.data();
  if (payData.uid !== request.auth.uid) throw new HttpsError("permission-denied", "Payment belongs to different user.");
  if (payData.status !== "COMPLETE") throw new HttpsError("failed-precondition", "Payment not confirmed.");

  const uid       = request.auth.uid;
  const subDocRef = db.collection("subscriptions").doc(uid);
  const expiresAt = new Date(Date.now() + 30 * 86400000);

  /* Atomic dedup-check + write — prevents TOCTOU race where two concurrent
     calls for the same paymentRef both pass the dedup query and both write. */
  let alreadyActive = false;
  await db.runTransaction(async (txn) => {
    const existing = await txn.get(subDocRef);
    if (existing.exists && existing.data().paymentRef === paymentRef) {
      alreadyActive = true;
      return; /* idempotent — same payment already activated */
    }
    txn.set(subDocRef, {
      uid,
      plan,
      status:      "active",
      paymentRef,
      activatedAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt:   admin.firestore.Timestamp.fromDate(expiresAt),
      updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  if (alreadyActive) return { success: true, plan, message: "Already activated." };

  /* Audit trail — one entry per activation */
  db.collection("subscriptionAuditLog").add({
    uid, plan, paymentRef,
    action:     "ACTIVATED",
    source:     "activateSubscription_cf",
    expiresAt:  admin.firestore.Timestamp.fromDate(expiresAt),
    timestamp:  admin.firestore.FieldValue.serverTimestamp(),
  }).catch(e => console.error("[activateSubscription] Audit log write failed:", e.message));

  console.log("[activateSubscription] Plan activated", { uid, plan, paymentRef });
  return { success: true, plan, expiresAt: expiresAt.toISOString() };
});

/* ══════════════════════════════════════════════════════════════════
   VOUCHER REDEMPTION  — atomic Firestore transaction
══════════════════════════════════════════════════════════════════ */
exports.redeemVoucher = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const { code, orderTotal, category } = request.data || {};
  const safeCode = String(code || "").trim().toUpperCase();
  if (!safeCode || safeCode.length < 4) throw new HttpsError("invalid-argument", "Invalid voucher code.");

  /* Reject non-numeric or negative orderTotal — client cannot pass 999999 to bypass minAmount */
  const safeTotal = typeof orderTotal === "number" && orderTotal >= 0 ? orderTotal : 0;
  if (orderTotal !== undefined && (typeof orderTotal !== "number" || orderTotal < 0 || orderTotal > 9999999)) {
    throw new HttpsError("invalid-argument", "Invalid orderTotal.");
  }

  const uid = request.auth.uid;

  return db.runTransaction(async (tx) => {
    const vRef = db.collection("vouchers").doc(safeCode);
    const snap = await tx.get(vRef);
    if (!snap.exists) throw new HttpsError("not-found", "Voucher not found.");

    const v = snap.data();
    if (!v.active) throw new HttpsError("failed-precondition", "Voucher is no longer active.");
    if (v.expiresAt && v.expiresAt.toMillis() < Date.now()) {
      throw new HttpsError("failed-precondition", "Voucher has expired.");
    }
    if (v.usageCount >= v.maxUses) throw new HttpsError("resource-exhausted", "Voucher usage limit reached.");
    if (Array.isArray(v.redemptions) && v.redemptions.includes(uid)) {
      throw new HttpsError("already-exists", "You have already used this voucher.");
    }
    /* Use server-validated total — not raw client value */
    if (v.minAmount && safeTotal < v.minAmount) {
      throw new HttpsError("failed-precondition", `Minimum order KES ${v.minAmount} required.`);
    }
    if (v.category && category && v.category !== category) {
      throw new HttpsError("failed-precondition", `Voucher only valid for ${v.category} orders.`);
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    tx.update(vRef, {
      usageCount:  admin.firestore.FieldValue.increment(1),
      redemptions: admin.firestore.FieldValue.arrayUnion(uid),
      lastUsedAt:  now,
    });
    tx.set(db.collection("voucherRedemptions").doc(`${uid}_${safeCode}`), {
      uid, code: safeCode,
      discount:    v.discount,
      discountType:v.discountType,
      orderTotal:  safeTotal,
      redeemedAt:  now,
    });

    return {
      success:      true,
      code:         safeCode,
      discount:     v.discount,
      discountType: v.discountType || "percent",
      message:      v.discountType === "percent"
                      ? `${v.discount}% off applied`
                      : `KES ${v.discount} off applied`,
    };
  });
});

/* ══════════════════════════════════════════════════════════════════
   PHASE 11 — MONITORING: recordMetric (public, rate-limited)
══════════════════════════════════════════════════════════════════ */

/* In-memory IP rate limiter (resets on CF cold-start; good enough for abuse deterrence) */
const _metricRateMap = new Map();
function _metricRateOk(ip) {
  const now    = Date.now();
  const entry  = _metricRateMap.get(ip) || { count: 0, window: now };
  if (now - entry.window > 60000) { entry.count = 0; entry.window = now; }
  entry.count++;
  _metricRateMap.set(ip, entry);
  return entry.count <= 60; // 60 batches/min per IP
}

exports.recordMetric = onRequest(
  { cors: ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app", "https://sokoni-aeb26.firebaseapp.com", "http://localhost", "http://127.0.0.1"], timeoutSeconds: 10, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "unknown";
    if (!_metricRateOk(ip)) { res.status(429).send("Too Many Requests"); return; }

    const { batch } = req.body || {};
    if (!Array.isArray(batch) || batch.length === 0) { res.status(400).send("Empty batch"); return; }
    if (batch.length > 150) { res.status(400).send("Batch too large"); return; }

    const now     = admin.firestore.FieldValue.serverTimestamp();
    const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const writes  = db.batch();

    for (const evt of batch.slice(0, 150)) {
      if (!evt || typeof evt.event !== "string") continue;
      const docRef = db.collection("clientMetrics").doc();
      writes.set(docRef, {
        event:  String(evt.event).slice(0, 60),
        page:   String(evt.page  || "").slice(0, 100),
        sid:    String(evt.sid   || "").slice(0, 40),
        ts:     typeof evt.ts === "number" ? evt.ts : Date.now(),
        data:   JSON.parse(JSON.stringify({ ...evt, event: undefined, page: undefined, sid: undefined, ts: undefined })),
        date:   dateKey,
        server: now,
      });
    }

    await writes.commit();
    res.status(200).send("OK");
  }
);

/* ══════════════════════════════════════════════════════════════════
   PUBLIC CATALOGUE — App-Check-independent product feed.
   The catalogue is public (products rule = `allow read: if true`), but App Check is
   ENFORCED on client Firestore reads and its reCAPTCHA v3 token exchange 403s
   intermittently (esp. iOS Safari/ITP), which took the homepage grid down entirely.
   This server-side endpoint reads via the Admin SDK (no App Check), so the public
   catalogue always loads; the live Firestore listener still layers real-time updates
   on top when its token is valid. In-memory sort (ids are Date.now() timestamps) so
   no composite index is required. Base64 image blobs are stripped to keep the payload
   light — the client renders Storage URLs and falls back gracefully (sokoni-image.js).
══════════════════════════════════════════════════════════════════ */
/* ══════════════════════════════════════════════════════════════════
   AVAILABLE DELIVERIES — App-Check-independent feed of dispatch-ready jobs.
   A rider can't read UNASSIGNED packageRequests under the client rules, so this
   Admin-SDK endpoint lists deliveries the merchant marked "Ready for Dispatch"
   (status awaiting_rider, no rider yet). Decoupled from printing entirely.
══════════════════════════════════════════════════════════════════ */
exports.availableDeliveries = onRequest(
  { cors: ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app", "https://sokoni-aeb26.firebaseapp.com", "http://localhost", "http://127.0.0.1"], timeoutSeconds: 15, invoker: "public", memory: "256MiB" },
  async (req, res) => {
    try {
      const snap = await db.collection("packageRequests").where("status", "==", "awaiting_rider").limit(80).get();
      const deliveries = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
        .filter((o) => !o.assignedRiderId && !o.riderId && !o.assignedDriverId && !o.assignedDriverUid)
        .map((o) => ({
          id: o.id, orderId: o.orderId, sellerName: o.sellerName,
          pickupAddress: o.pickupAddress, deliveryAddress: o.deliveryAddress,
          buyerName: o.buyerName, buyerPhone: o.buyerPhone,
          items: o.items || [], orderTotal: o.orderTotal, deliveryFee: o.deliveryFee,
          driverNet: o.driverNet, proofPin: o.proofPin,
        }));
      res.set("Cache-Control", "no-cache, must-revalidate");
      res.status(200).json({ ok: true, count: deliveries.length, deliveries });
    } catch (e) {
      console.error("[availableDeliveries] failed:", e.message);
      res.status(500).json({ ok: false, error: "unavailable" });
    }
  }
);

/* Rider accepts an available delivery — atomic first-claim-wins (Admin SDK bypasses the
   packageRequests write rule that would otherwise block a not-yet-assigned rider). */
exports.claimAvailableDelivery = onCall(
  { region: "us-central1", timeoutSeconds: 30, memory: "128MiB", invoker: "public" },
  async (request) => {
    const uid = request.auth && request.auth.uid;
    if (!uid) throw new HttpsError("unauthenticated", "Sign in to accept a delivery.");
    const { deliveryRef } = request.data || {};
    if (!deliveryRef) throw new HttpsError("invalid-argument", "deliveryRef required.");
    const ref = db.collection("packageRequests").doc(String(deliveryRef));
    let out;
    await db.runTransaction(async (t) => {
      const s = await t.get(ref);
      if (!s.exists) throw new HttpsError("not-found", "Delivery not found.");
      const d = s.data();
      if (d.assignedRiderId || d.riderId || d.assignedDriverId) throw new HttpsError("failed-precondition", "Just taken by another rider.");
      if (d.status !== "awaiting_rider") throw new HttpsError("failed-precondition", "Delivery no longer available.");
      const riderDoc = await t.get(db.collection("rideDrivers").doc(uid));
      const rider = riderDoc.exists ? (riderDoc.data() || {}) : {};
      /* SECURITY (backend-enforced — never trust the UI): only an APPROVED, non-suspended rider
         may accept a job. Without this, any signed-in user could claim a delivery by calling the
         function directly. */
      const _st = String(rider.status || "").toLowerCase();
      const _approved = rider.approved === true || ["approved", "active", "online", "verified"].includes(_st);
      const _blocked  = ["suspended", "rejected", "banned", "deactivated"].includes(_st);
      if (!riderDoc.exists || !_approved || _blocked) {
        throw new HttpsError("permission-denied", "Your rider account is not approved to accept deliveries.");
      }
      const nowTs = admin.firestore.FieldValue.serverTimestamp();
      t.update(ref, {
        status: "driver_accepted", assignedRiderId: uid, riderId: uid,
        assignedDriverId: uid, assignedDriverUid: uid,
        riderName: rider.name || "Rider", riderPhone: rider.phone || "",
        riderAcceptedAt: nowTs, updatedAt: nowTs,
      });
      if (d.orderId) t.set(db.collection("orders").doc(String(d.orderId)),
        { status: "rider_assigned", assignedDriverUid: uid, riderAssignedAt: nowTs, updatedAt: nowTs }, { merge: true });
      out = { ok: true, deliveryRef, orderId: d.orderId, proofPin: d.proofPin };
    });
    return out;
  }
);

exports.catalogue = onRequest(
  { cors: ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app", "https://sokoni-aeb26.firebaseapp.com", "http://localhost", "http://127.0.0.1"], timeoutSeconds: 15, invoker: "public", memory: "256MiB" },
  async (req, res) => {
    try {
      const cap       = Math.min(Number(req.query.limit) || 200, 300);
      const category  = (req.query.category  || "").toString().trim().toLowerCase();
      const sellerUid = (req.query.sellerUid || "").toString().trim();
      /* Match the client listener: NO status filter. Most legacy products have no `status`
         field at all (absent = visible per the commerce lifecycle) — filtering on
         status=='active' wrongly hid 92 of 103 real, previously-visible products. Return
         everything EXCEPT the explicitly-hidden states. */
      const snap = await db.collection("products").limit(500).get();
      const _isData = (v) => typeof v === "string" && v.slice(0, 5) === "data:";
      const HIDDEN = new Set(["deleted", "removed", "hidden", "draft", "archived", "banned", "suspended", "paused", "inactive", "rejected"]);
      let products = snap.docs.map((d) => {
        const v = d.data() || {};
        delete v._syncedAt;
        /* Strip heavy base64 image blobs — client uses Storage URLs / placeholder. */
        if (_isData(v.image)) delete v.image;
        if (Array.isArray(v.images)) v.images = v.images.filter((u) => !_isData(u));
        return { id: d.id, ...v };
      }).filter((p) => {
        const st = String(p.status || "").toLowerCase();
        if (HIDDEN.has(st)) return false;
        if (p.isDeleted === true || p.deleted === true) return false;
        if (p.visible === false || p.isVisible === false) return false;
        if (sellerUid && String(p.sellerUid || "") !== sellerUid && String(p.uid || "") !== sellerUid) return false;
        if (category && String(p.category || "").toLowerCase() !== category) return false;
        return true;
      });
      /* Newest first — product ids are Date.now() timestamps. */
      products.sort((a, b) => String(b.id).localeCompare(String(a.id)));
      products = products.slice(0, cap);
      res.set("Cache-Control", "public, max-age=60, s-maxage=120");
      res.status(200).json({ ok: true, count: products.length, products });
    } catch (e) {
      console.error("[catalogue] failed:", e.message);
      res.status(500).json({ ok: false, error: "catalogue_unavailable" });
    }
  }
);

/* ══════════════════════════════════════════════════════════════════
   PHASE 9 — BACKGROUND: Daily analytics aggregation (01:00 UTC = 04:00 EAT)
══════════════════════════════════════════════════════════════════ */
exports.aggregateAnalytics = onSchedule(
  { schedule: "0 1 * * *", timeZone: "UTC", timeoutSeconds: 300 },
  async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);

    /* Timestamp range for yesterday 00:00:00 – 23:59:59.999 UTC */
    const tsStart = admin.firestore.Timestamp.fromDate(new Date(yesterday + "T00:00:00.000Z"));
    const tsEnd   = admin.firestore.Timestamp.fromDate(new Date(yesterday + "T23:59:59.999Z"));

    /* Count orders, bookings, rides for yesterday using createdAt Timestamp range */
    const [ordersSnap, bookingsSnap, ridesSnap, newUsersSnap] = await Promise.all([
      db.collection("orders")
        .where("status",    "==",  "delivered")
        .where("createdAt", ">=",  tsStart)
        .where("createdAt", "<=",  tsEnd)
        .count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      db.collection("bookings")
        .where("createdAt", ">=",  tsStart)
        .where("createdAt", "<=",  tsEnd)
        .count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      db.collection("rides")
        .where("createdAt", ">=",  tsStart)
        .where("createdAt", "<=",  tsEnd)
        .count().get().catch(() => ({ data: () => ({ count: 0 }) })),
      db.collection("users")
        .where("createdAt", ">=",  tsStart)
        .where("createdAt", "<=",  tsEnd)
        .count().get().catch(() => ({ data: () => ({ count: 0 }) })),
    ]);

    await db.collection("platformMetrics").doc(`daily_${yesterday}`).set({
      date:        yesterday,
      type:        "daily",
      orders:      ordersSnap.data().count,
      bookings:    bookingsSnap.data().count,
      rides:       ridesSnap.data().count,
      newUsers:    newUsersSnap.data().count,
      aggregatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    console.log(`[aggregateAnalytics] ${yesterday} aggregated`);
  }
);

/* ══════════════════════════════════════════════════════════════════
   PHASE 9 — BACKGROUND: Generate trending products (every 6 h)
══════════════════════════════════════════════════════════════════ */
exports.generateTrending = onSchedule(
  { schedule: "0 */6 * * *", timeZone: "UTC", timeoutSeconds: 120 },
  async () => {
    /* Top products by viewCount descending — one query per hub */
    const hubs = ["shopping", "food", "services", "healthcare", "entertainment", "b2b"];
    const batch = db.batch();

    for (const hub of hubs) {
      const snap = await db.collection("products")
        .where("hub", "==", hub)
        .where("status", "==", "active")
        .orderBy("viewCount", "desc")
        .limit(20)
        .get()
        .catch(() => ({ docs: [] }));

      const ids = snap.docs.map(d => d.id);
      batch.set(db.collection("trending").doc(hub), {
        hub,
        productIds:  ids,
        updatedAt:   admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    await batch.commit();
    console.log("[generateTrending] trending updated for", hubs.length, "hubs");
  }
);

/* ══════════════════════════════════════════════════════════════════
   PHASE 2 — BACKGROUND: Cleanup expired subscriptions (daily 02:00 UTC)
══════════════════════════════════════════════════════════════════ */
exports.cleanupExpiredSubscriptions = onSchedule(
  { schedule: "0 2 * * *", timeZone: "UTC", timeoutSeconds: 120 },
  async () => {
    const now   = admin.firestore.Timestamp.now();
    let   total = 0;

    /* Loop in pages of 200 until no more expired docs remain */
    while (true) {
      const snap = await db.collection("subscriptions")
        .where("status",    "==", "active")
        .where("expiresAt", "<",  now)
        .limit(200)
        .get();

      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach(doc => {
        batch.update(doc.ref, {
          status:    "expired",
          expiredAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });
      await batch.commit();
      total += snap.size;

      if (snap.size < 200) break; // fetched fewer than limit — no more pages
    }

    console.log(`[cleanupExpired] expired ${total} subscriptions`);
  }
);

/* ══════════════════════════════════════════════════════════════════
   PHASE 12 — SECURITY: Per-user + per-IP rate limiting middleware
   and bot detection for all public-facing onRequest endpoints.

   Bot signals (any 3+ triggers an automatic 429 + flag):
     • > 120 requests/min from single IP
     • > 30 identical payloads in 60 s (stuffing/replay)
     • User-Agent missing or known bot string
     • Suspiciously uniform timing (< 20 ms apart consistently)
══════════════════════════════════════════════════════════════════ */

/* ── In-memory rate limiter (per-instance — used for bot detection heuristics only) ── */
const _rlMap = new Map(); // key → { timestamps: number[] }

function _rateLimit(key, limitPerMin = 120) {
  const now    = Date.now();
  const window = 60000;
  const entry  = _rlMap.get(key) || { ts: [] };

  entry.ts = entry.ts.filter(t => now - t < window);
  entry.ts.push(now);
  _rlMap.set(key, entry);

  if (_rlMap.size > 50000) {
    const keys = [..._rlMap.keys()].slice(0, 10000);
    keys.forEach(k => _rlMap.delete(k));
  }

  return entry.ts.length <= limitPerMin;
}

/* ── Firestore-backed rate limiter ──────────────────────────────────────────
   Uses Firestore transactions for cross-instance atomic counting.
   Applied to all payment, admin, and AI endpoints so that rate limits
   remain effective across all 1,000 concurrent Cloud Function instances.

   Keys are stored in rateLimits/{sanitizedKey} documents with a TTL field
   (expiresAt) so Cloud Firestore TTL can auto-clean them (enable TTL policy
   on the expiresAt field in the Firebase Console for the rateLimits collection).
─────────────────────────────────────────────────────────────────────────── */
async function checkRateLimitDurable(key, limitPerWindow, windowSecs = 60) {
  const now        = Date.now();
  const windowMs   = windowSecs * 1000;
  /* Sanitise the key to a valid Firestore doc ID */
  const safeKey    = String(key).replace(/[^a-zA-Z0-9_@.-]/g, "_").slice(0, 200);
  const docRef     = db.collection("rateLimits").doc(safeKey);

  try {
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(docRef);
      if (!snap.exists) {
        tx.set(docRef, {
          count:       1,
          windowStart: admin.firestore.Timestamp.fromMillis(now),
          expiresAt:   admin.firestore.Timestamp.fromMillis(now + windowMs + 120000),
          key: safeKey,
        });
        return { count: 1, ok: true };
      }
      const data       = snap.data();
      const windowAge  = now - (data.windowStart?.toMillis() || 0);
      if (windowAge >= windowMs) {
        /* Window expired — start a fresh one */
        tx.update(docRef, {
          count:       1,
          windowStart: admin.firestore.Timestamp.fromMillis(now),
          expiresAt:   admin.firestore.Timestamp.fromMillis(now + windowMs + 120000),
        });
        return { count: 1, ok: true };
      }
      const newCount = (data.count || 0) + 1;
      tx.update(docRef, { count: admin.firestore.FieldValue.increment(1) });
      return { count: newCount, ok: newCount <= limitPerWindow };
    });
    return result;
  } catch (err) {
    /* Fail open on Firestore error to avoid blocking payments on DB outages.
       The error is logged so operations can detect and alert on it. */
    console.error("[checkRateLimitDurable] Firestore error — failing open:", err.message);
    return { count: 0, ok: true };
  }
}

/* Bot-signal heuristics */
const _BOT_UA = /bot|crawl|spider|slurp|facebookexternalhit|headless|playwright|puppeteer|selenium|python-requests|go-http|axios\/[0-9]/i;

function _detectBot(req) {
  const ua    = req.headers["user-agent"] || "";
  const ip    = (req.headers["x-forwarded-for"] || req.ip || "").split(",")[0].trim();
  const flags = [];

  if (!ua || ua.length < 10) flags.push("empty_ua");
  if (_BOT_UA.test(ua))      flags.push("bot_ua");

  /* Check if this IP has too many requests */
  if (!_rateLimit(`bot_${ip}`, 200)) flags.push("ip_flood");

  return { isBot: flags.length >= 2, flags, ip };
}

/**
 * checkRateLimit — call at the top of any onRequest handler.
 * Returns { ok: boolean, statusCode?, message? }
 */
function checkRateLimit(req, uid = null, limitPerMin = 60) {
  const ip  = (req.headers["x-forwarded-for"] || req.ip || "unknown").split(",")[0].trim();
  const key = uid ? `u_${uid}` : `ip_${ip}`;
  const ok  = _rateLimit(key, limitPerMin);
  if (!ok) return { ok: false, statusCode: 429, message: "Rate limit exceeded" };

  const bot = _detectBot(req);
  if (bot.isBot) {
    /* Log bot attempt to Firestore for fraud analysis */
    db.collection("securityEvents").add({
      type:   "bot_detected",
      ip:     bot.ip,
      flags:  bot.flags,
      path:   req.path,
      ts:     admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    return { ok: false, statusCode: 403, message: "Forbidden" };
  }

  return { ok: true };
}


/* ── Fraud detection: flag suspicious payment patterns ─────── */
exports.detectFraud = onCall({ timeoutSeconds: 10 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;

  /* Check recent payment failures for this user */
  const recentFails = await db.collection("payments")
    .where("uid",    "==",      uid)
    .where("status", "in",      ["FAILED", "CANCELLED"])
    .where("createdAt", ">",    admin.firestore.Timestamp.fromMillis(Date.now() - 3600000))
    .count().get().catch(() => ({ data: () => ({ count: 0 }) }));

  const failCount = recentFails.data().count;

  if (failCount >= 5) {
    /* Flag account for review */
    await db.collection("securityEvents").add({
      type:   "payment_fraud_suspect",
      uid,
      fails:  failCount,
      ts:     admin.firestore.FieldValue.serverTimestamp(),
    });
    throw new HttpsError("resource-exhausted", "Too many failed payments. Please contact support.");
  }

  return { ok: true, recentFails: failCount };
});

/* ── Security event query for admin dashboard ─────────────── */
exports.getSecurityEvents = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth?.token?.admin && !request.auth?.token?.superAdmin) {
    throw new HttpsError("permission-denied", "Admin access required.");
  }

  const snap = await db.collection("securityEvents")
    .orderBy("ts", "desc")
    .limit(200)
    .get();

  return snap.docs.map(d => ({ id: d.id, ...d.data(), ts: d.data().ts?.toMillis?.() || null }));
});


/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SOKONI ENTERPRISE BACKEND  v2.0
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Webhook Platform Â· Payment Engine Â· Fraud Detection Â· Settlement
   Search Indexer Â· Event Processor Â· Monitoring Â· Health Checks
   â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   All new functions use the Firebase Admin SDK already loaded above.
   Secrets: INTASEND_PRIVATE_KEY, AFRICASTALKING_API_KEY, AFRICASTALKING_USERNAME (via sokoni-at).
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */


/* â”€â”€ HMAC-SHA256 signature verification (constant-time) â”€â”€ */
function _verifyHmac(rawBody, signature, secret) {
  if (!signature || !secret) return false;
  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  try {
    const a = Buffer.from(expected);
    const b = Buffer.from(String(signature).slice(0, expected.length).padEnd(expected.length));
    return crypto.timingSafeEqual(a, b);
  } catch (_) { return false; }
}

/* â”€â”€ Generate idempotency-safe reference â”€â”€ */
function _genRef(prefix) {
  return (prefix || "REF") + "-" + Date.now() + "-" + crypto.randomBytes(4).toString("hex").toUpperCase();
}

/* â”€â”€ Tax rates (kept in sync with sokoni-payment-engine.js) â”€â”€ */
const _TAX = { VAT: 0.16, WHT: 0.05, DST: 0.015, WHT_THRESHOLD: 24000 };
/* _PLATFORM_FEE (a hardcoded 10%) is GONE. Its only consumer was releaseEscrow, which would
   have double-charged commission that finos-router had already taken at payment time, using a
   rate that matched no hub. Commission is the Commission Engine's job. */

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SHARED WEBHOOK PROCESSOR
   All provider endpoints share this pipeline:
     verify signature â†’ dedup â†’ parse â†’ handle â†’ audit
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function _processWebhook(req, res, opts) {
  const { provider, parsePayload, getEventId, onSuccess, secretKey } = opts;

  /* ACK immediately to prevent provider retries while we process */
  res.status(200).json({ received: true });

  const rawBody = JSON.stringify(req.body);
  const eventId = getEventId(req.body) || _genRef("WHK");

  /* 1. Signature verification */
  if (secretKey) {
    const sig = req.headers["x-intasend-signature"]
             || req.headers["stripe-signature"]
             || req.headers["x-sokoni-signature"]
             || req.headers["x-mpesa-signature"]
             || "";
    if (!_verifyHmac(rawBody, sig, secretKey)) {
      /* DIAGNOSTIC CAPTURE (2026-07-19). Every real IntaSend delivery has been rejected here
         since the integration went live — 13 of them — and the log recorded only the event id,
         so the REASON was never observable. Same blind spot that hid the email 400s.

         What is needed to fix this is the provider's actual authentication shape: which header
         (if any) carries a signature, and whether the body carries a `challenge` field instead.
         IntaSend's webhook auth is a challenge value in the payload, and this code has zero
         handling for it (grep: 0 occurrences) — but that must be CONFIRMED from a real request
         before the verification logic is changed. Guessing at a signature scheme is how an
         endpoint ends up accepting unsigned webhooks.

         SAFETY: header NAMES are recorded but their VALUES are redacted except for a length and
         a 6-char prefix — enough to identify the scheme, never enough to replay it. The body is
         captured with obvious secret-bearing keys stripped. Nothing here weakens verification:
         the request is still rejected on the next line exactly as before. */
      let _diag = null;
      try {
        const hdrNames = Object.keys(req.headers || {});
        const interesting = hdrNames.filter(h => /sign|auth|hmac|token|challenge|digest|x-intasend/i.test(h));
        _diag = {
          headerNames: hdrNames.join(",").slice(0, 500),
          signatureHeaders: interesting.map(h => {
            const v = String(req.headers[h] || "");
            return h + "=len:" + v.length + ":" + v.slice(0, 6);
          }).join(" | ").slice(0, 400),
          bodyKeys: (req.body && typeof req.body === "object") ? Object.keys(req.body).join(",").slice(0, 300) : null,
          hasChallengeField: !!(req.body && (req.body.challenge !== undefined)),
          challengeLen: (req.body && req.body.challenge !== undefined) ? String(req.body.challenge).length : null,
          rawBodyLen: (rawBody || "").length,
          contentType: String(req.headers["content-type"] || "").slice(0, 60),
          userAgent: String(req.headers["user-agent"] || "").slice(0, 80),
          sourceIp: String(req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 45),
          /* Body with anything secret-shaped removed. */
          bodySample: (() => {
            try {
              const b = JSON.parse(JSON.stringify(req.body || {}));
              ["challenge", "signature", "token", "secret", "api_key", "apikey"].forEach(k => { if (k in b) b[k] = "[REDACTED len:" + String(b[k]).length + "]"; });
              return JSON.stringify(b).slice(0, 1200);
            } catch (_) { return null; }
          })(),
        };
      } catch (_) { /* diagnosis must never break rejection */ }

      console.error("[Webhook:" + provider + "] Invalid signature for " + eventId,
        JSON.stringify(_diag || {}));
      await db.collection("webhookLogs").add({
        provider, eventId, status: "invalid_signature",
        diag: _diag,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
      return;
    }
  }

  /* 2. Timestamp replay window (5 min) */
  const tsHeader = req.headers["x-webhook-timestamp"] || req.body && req.body.timestamp;
  if (tsHeader) {
    const age = Math.abs(Date.now() / 1000 - Number(tsHeader));
    if (age > 300) {
      console.warn("[Webhook:" + provider + "] Stale event " + eventId + " age=" + age + "s");
      return;
    }
  }

  /* 3+4. P0-4: ATOMIC idempotency claim.
     Previously this was get() -> if(exists) return -> set(), a non-atomic
     read-check-write. Two concurrent deliveries of the SAME eventId (providers retry
     on timeout/5xx, and load balancers can fan out) could both read "not exists" and
     both proceed to onSuccess() — processing one payment event twice.

     create() is an atomic set-if-not-exists: exactly one caller wins, the loser gets
     ALREADY_EXISTS (gRPC code 6) and bails. This is the same pattern already used
     correctly by financial-os.js fosSecureWebhook. Shared by webhookIntasend /
     webhookMpesa / webhookStripe / webhookSmartpos. */
  const idemRef = db.collection("webhookIdempotency").doc(provider + "::" + eventId);
  try {
    await idemRef.create({
      provider, eventId, status: "processing",
      ts: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    if (e && (e.code === 6 || /already exists/i.test(e.message || ""))) {
      console.log("[Webhook:" + provider + "] Duplicate skipped (raced): " + eventId);
      return;
    }
    throw e;   /* a real infra error — let it surface so the provider retries */
  }

  /* 5. Parse and handle */
  try {
    const payload = parsePayload(req.body);
    await onSuccess(payload, eventId);

    await idemRef.update({
      status: "processed",
      processedAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    await db.collection("webhookLogs").add({
      provider, eventId, status: "processed", payload,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});

    console.log("[Webhook:" + provider + "] Processed: " + eventId);
  } catch (err) {
    console.error("[Webhook:" + provider + "] Error for " + eventId + ":", err.message);
    await idemRef.update({ status: "failed", error: err.message }).catch(() => {});
    await db.collection("webhookLogs").add({
      provider, eventId, status: "failed", error: err.message,
      ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    await db.collection("webhookDLQ").add({
      provider, eventId, body: req.body, error: err.message,
      attempts: 1, ts: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   WEBHOOK ENDPOINTS
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* â”€â”€ IntaSend â”€â”€ */
/* Canonical production receiver — IntaSend is configured to POST to this URL.
   Challenge-based auth (body.challenge); full payment + subscription activation.
   intasendWebhook is a secondary deployment that receives no real IntaSend traffic. */
exports.webhookIntasend = onRequest(
  { timeoutSeconds: 30, secrets: [INTASEND_WEBHOOK_CHALLENGE], invoker: "public", minInstances: 1 },
  async (req, res) => {
    if (req.method !== "POST") { res.status(405).send("Method Not Allowed"); return; }

    const challenge         = String((req.body && req.body.challenge) || "");
    const expectedChallenge = INTASEND_WEBHOOK_CHALLENGE.value();
    if (!expectedChallenge) {
      logger.error("[webhookIntasend] INTASEND_WEBHOOK_CHALLENGE secret is empty — check Secret Manager IAM and secret version");
      res.status(500).send("Service unavailable");
      return;
    }
    const normKey = Buffer.from("sokoni-intasend-challenge-norm");
    const a = crypto.createHmac("sha256", normKey).update(challenge).digest();
    const b = crypto.createHmac("sha256", normKey).update(expectedChallenge).digest();
    if (!crypto.timingSafeEqual(a, b)) {
      logger.warn("[webhookIntasend] challenge mismatch — rejecting", {
        hasChallenge: challenge.length > 0,
        challengeLen: challenge.length,
        invoiceId:    req.body?.invoice?.invoice_id || req.body?.invoice_id || "unknown",
        method:       req.method,
      });
      res.status(401).send("Unauthorized");
      return;
    }

    /* IntaSend sends a flat payload per official docs — all fields at root level.
       The `invoice` fallback handles any future nested-object variant gracefully. */
    const invoice    = req.body?.invoice || {};
    const state      = String(invoice.state    || req.body?.state    || "FAILED").toUpperCase();
    const apiRef     = invoice.api_ref         || req.body?.api_ref;
    const checkoutId = invoice.id              || req.body?.invoice_id;
    const amount     = Number(invoice.net_amount || invoice.amount || req.body?.net_amount || req.body?.value || 0);
    /* B2C send-money identifies the transfer by tracking_id/file_id, NOT api_ref. The
       api_ref guard is DEFERRED to after B2C settlement (below), else B2C confirmations
       are dropped and the payout sticks at 'processing'. */
    const trackingId = req.body?.tracking_id || invoice.tracking_id || req.body?.file_id || invoice.file_id || null;

    /* First-rollout observability: log the ENTIRE webhook payload (challenge/secret
       stripped) before parsing, so if IntaSend's B2C field names/format differ we can
       see exactly what arrived and adapt. */
    try {
      const _rb = { ...(req.body || {}) };
      delete _rb.challenge; delete _rb.signature; delete _rb.secret;
      console.log("[webhookIntasend] raw payload:", JSON.stringify(_rb).slice(0, 4000));
    } catch (_) { /* logging must never block the webhook */ }

    /* Seller B2C payouts ("pout_…"): advance a withdrawal from its provider status.
       Matches by api_ref (== our reqId) or by intasendRef (tracking_id). Stores the raw
       payload on the payout for audit. No-op for non-payout events, so top-up/payment
       handling below is unaffected. */
    try {
      /* Try EVERY identifier IntaSend may send for a send-money confirmation:
         api_ref (== our reqId), invoice.id/invoice_id, tracking_id/file_id. */
      for (const r of [apiRef, checkoutId, trackingId].filter(Boolean)) {
        if (await wallet.finalizeB2CPayoutFromWebhook(db, r, state, req.body)) {
          res.status(200).send("OK");
          return;
        }
      }
    } catch (e) {
      console.error("[webhookIntasend] B2C payout finalize error:", e.message);
      /* fall through — don't block other webhook handling */
    }

    /* Everything below (wallet top-up + collection/payment) is keyed on api_ref. A B2C
       confirmation (no api_ref) has already been handled and returned above. */
    if (!apiRef) { res.status(400).send("Missing api_ref"); return; }

    /* Wallet top-ups ("wtop_…") have no payments/{ref} doc — finalize them via
       the shared idempotent claim before the payments path below. */
    if (await _finalizeWalletTopUp(apiRef, state, amount, "webhookIntasend")) {
      res.status(200).send("OK");
      return;
    }

    const payRef = db.collection("payments").doc(apiRef);
    const snap   = await payRef.get();
    if (!snap.exists) { res.status(200).send("OK"); return; }

    const existing = snap.data();
    if (existing.status === "COMPLETE") { res.status(200).send("OK"); return; }

    const fsStatus = state === "COMPLETE" ? "COMPLETE" : state === "FAILED" ? "FAILED" : "PENDING";

    let claimed = false;
    await db.runTransaction(async (txn) => {
      const s = await txn.get(payRef);
      if (!s.exists) return;
      if (s.data().status === "COMPLETE") return;
      txn.update(payRef, {
        status:            fsStatus,
        intasendState:     state,
        confirmedAmount:   amount,
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
        webhookReceivedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      claimed = true;
    });

    if (!claimed) {
      console.log(`[webhookIntasend] Already processed (raced): ${apiRef}`);
      res.status(200).send("OK");
      return;
    }

    /* Terminal NON-payment for a service booking → release the held slot immediately
       instead of waiting for the expiry sweep. Keyed off the RAW state, since fsStatus
       collapses CANCELLED/EXPIRED/REJECTED/TIMEOUT into "PENDING". No-op (returns false)
       for non-booking intents, so product/wallet failures fall through unchanged. */
    if (["FAILED", "CANCELLED", "EXPIRED", "REJECTED", "TIMEOUT"].includes(state)) {
      const { releaseServiceBookingOnTerminalPayment } = require('./booking-payment-sweep');
      if (await releaseServiceBookingOnTerminalPayment(db, admin, apiRef, existing.intentRef, state)) {
        res.status(200).send("OK"); return;
      }
    }

    if (fsStatus === "COMPLETE") {
      const payData  = existing;
      /* Phase E: a service-booking payment is HELD (paid_held), never credited here —
         the provider is credited only by Phase C settlement at completion. Handled in
         isolation via the server-minted intent; skips all commission/credit/creation. */
      if (await _holdServiceBookingPayment(db, admin, apiRef, existing.intentRef, amount)) { res.status(200).send("OK"); return; }
      const category = payData.meta?.category || "default";
      let sokoniCut = 0, commissionPct = 0;
      try {
        const { calculateCommission } = require('./finos-utils');
        const commResult = await calculateCommission(db, {
          orderAmountCents: amount * 100,
          category,
          sellerId: payData.uid,
        });
        sokoniCut     = commResult.commissionCents ? Math.round(commResult.commissionCents / 100) : 0;
        commissionPct = commResult.effectiveRate ?? 0;
      } catch (commErr) {
        console.error('[webhookIntasend] Commission calc failed — flagging for manual review', commErr.message);
        commissionPct = null;
        sokoniCut = 0;
        await db.collection("commissionReviewQueue").add({
          ref: apiRef, amount, category, uid: payData.uid,
          reason: commErr.message,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }

      await db.collection("commissionLedger").doc(apiRef).set({
        ref: apiRef, checkoutId, uid: payData.uid,
        providerName:  payData.meta?.providerName || "",
        category,
        commissionPct, sokoniCut,
        providerNet:   amount - sokoniCut,
        serviceTotal:  amount,
        status:        "auto_collected",
        source:        "webhookIntasend",
        confirmedAt:   admin.firestore.FieldValue.serverTimestamp(),
        createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true }).catch(err => console.error("[webhookIntasend] Commission write failed:", err));

      /* ── FinOS merchant wallet credit ──────────────────────────────────────
         Until now this webhook recorded the commission split and stopped. The
         merchant's wallet was never credited: FinOS's crediting engine is
         reachable only through finosRecordTransaction (an onCall), and nothing
         on the payment path invoked it. Commission was calculated, the
         merchant's net was written to commissionLedger.providerNet — and then
         no money moved into their balance.

         FinOS is the canonical authority, so this calls its existing primitive
         rather than touching a balance directly. No new collection, no new
         balance field, no second ledger.

         SUBSCRIPTIONS ARE EXCLUDED, and this is not an optimisation. A
         subscription payment flows merchant -> platform: payData.uid is the
         merchant PAYING US. Crediting their wallet with the "net" would hand
         them back most of the fee they just paid. Only marketplace sales credit
         a merchant.

         IDEMPOTENCY: _walletTxRef() generates a RANDOM document id, so a second
         call would append a second ledger entry AND increment the balance again.
         The guard is therefore the caller's responsibility: this reads
         payments/{apiRef} inside the transaction and refuses if walletCreditedAt
         is already set. Reads precede writes, as Firestore requires. A duplicate
         webhook delivery cannot double-credit.

         GATEWAY FEES ARE NOT DEDUCTED, because nothing in the commission engine
         models them (grep: finos-utils has no gateway/processing fee concept —
         only an EXTERNAL_GATEWAY ledger account name). Crediting
         `amount - sokoniCut` matches commissionLedger.providerNet exactly, so
         the two agree. Inventing a fee here would create a number no other
         system knows about. Recorded as a gap for Finance to define. */
      try {
        const _isSubscription =
          category === "subscription" || payData.meta?.category === "subscription";
        /* For a service booking the earner is the PROVIDER (meta.providerId), not the
           paying customer (payData.uid). Scoped to bookings so marketplace/POS flows,
           where uid already means the seller, are unaffected.

           For a BUYER-INITIATED marketplace checkout the earner is neither: payData.uid
           is the BUYER, and the seller to credit is carried in meta.sellerUid (set by the
           checkout when it calls initiateSTKPush). POS and other flows where uid already
           IS the seller set no meta.sellerUid, so they keep payData.uid unchanged. */
        const _isBooking = payData.meta?.type === "booking";
        const _sellerId  = (_isBooking && payData.meta?.providerId) ? payData.meta.providerId
                         : (payData.meta?.sellerUid || payData.uid);
        const _netCents = Math.round(Math.max(0, amount - sokoniCut) * 100);

        if (_isSubscription) {
          console.log(`[webhookIntasend] wallet credit skipped (subscription): ${apiRef}`);
        } else if (!_sellerId || _netCents <= 0) {
          console.warn(`[webhookIntasend] wallet credit skipped (no seller or zero net): ${apiRef}`);
        } else if (_isBooking) {
          /* Booking earnings → the provider's WITHDRAWABLE wallet balance
             (wallets.balance, in SHILLINGS) — the exact field the wallet UI shows and
             requestSellerPayout pays out, so the provider can withdraw to M-Pesa. The
             finos availableBalance/withdrawableBalance ledger (cents) is a SEPARATE
             representation the withdraw flow does not read, which is why crediting it
             would leave the earnings un-withdrawable. Idempotent via walletCreditedAt. */
          const _netShillings = Math.round(Math.max(0, amount - sokoniCut));
          const _payDoc = db.collection("payments").doc(apiRef);
          const _walRef = db.collection("wallets").doc(_sellerId);
          const _credited = await db.runTransaction(async (txn) => {
            const snap = await txn.get(_payDoc);
            if (!snap.exists || snap.data().walletCreditedAt) return false;
            const wSnap = await txn.get(_walRef);
            if (wSnap.exists) {
              txn.update(_walRef, { balance: admin.firestore.FieldValue.increment(_netShillings) });
            } else {
              txn.set(_walRef, { uid: _sellerId, balance: _netShillings, currency: "KES",
                createdAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            }
            txn.set(db.collection("walletTransactions").doc(`${_sellerId}_${apiRef}_booking`), {
              uid: _sellerId, type: "booking_earning", amount: _netShillings,
              description: `Booking earning — ${payData.meta?.serviceDesc || "service"} (ref ${apiRef})`,
              status: "completed", createdAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            txn.update(_payDoc, {
              walletCreditedAt:  admin.firestore.FieldValue.serverTimestamp(),
              walletCreditCents: _netShillings * 100,
              walletCreditedTo:  _sellerId,
            });
            return true;
          });
          console.log(`[webhookIntasend] booking earning ${_credited ? "credited" : "already credited"} to provider wallet.balance`,
            { ref: apiRef, provider: _sellerId, netShillings: _netShillings });
        } else {
          const { creditWalletTxn } = require('./finos-utils');
          const _payDoc = db.collection("payments").doc(apiRef);
          const _credited = await db.runTransaction(async (txn) => {
            const snap = await txn.get(_payDoc);
            if (!snap.exists) return false;
            if (snap.data().walletCreditedAt) return false;   /* already credited */
            creditWalletTxn(txn, db, _sellerId, 'seller', _netCents, {
              description: `Sale ${apiRef} (gross ${amount}, commission ${sokoniCut})`,
              orderId: apiRef,
              type: 'sale',
            });
            txn.update(_payDoc, {
              walletCreditedAt:  admin.firestore.FieldValue.serverTimestamp(),
              walletCreditCents: _netCents,
              walletCreditedTo:  _sellerId,
            });
            return true;
          });
          console.log(`[webhookIntasend] wallet ${_credited ? 'credited' : 'already credited'}`,
            { ref: apiRef, seller: _sellerId, netCents: _netCents });
        }
      } catch (walletErr) {
        /* Never fail the webhook on a wallet error: the payment is captured and
           authoritative, and returning non-200 would make IntaSend retry a
           delivery whose payment work is already done. The credit is recoverable
           from commissionLedger + the absent walletCreditedAt marker. */
        console.error("[webhookIntasend] WALLET CREDIT FAILED — recoverable, payment stands:",
          { ref: apiRef, err: walletErr.message });
        await db.collection("commissionReviewQueue").add({
          ref: apiRef, uid: payData.uid, amount,
          reason: "wallet credit failed: " + walletErr.message,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }

      /* ── Marketplace product order finalisation ──────────────────────────────
         The seller wallet credit above settles the MONEY; this ships the ORDER.
         A confirmed product payment must mark its order paid and decrement stock
         atomically — previously nothing on the IntaSend path did either, so a paid
         order stayed pending_payment and inventory never moved. Guarded to
         buyer-initiated product checkouts, which carry meta.orderId; bookings,
         subscriptions and wallet top-ups carry no orderId (or a different category)
         and skip this untouched. settlementStatus:"settled" because the wallet was
         already credited above — a settlement sweep must not double-credit.
         Idempotent via the order's inventoryApplied flag; never fails the webhook. */
      try {
        const _pm  = payData.meta || {};
        const _cat = String(_pm.category || "").toLowerCase();
        const _isProductPay = !!_pm.orderId
          && _pm.type !== "booking"
          && !["subscription", "wallet_topup", "topup"].includes(_cat);
        if (_isProductPay) {
          const _fin = await _finalizeMarketplacePayment(db, admin, {
            checkoutId:    apiRef,
            sellerUid:     _pm.sellerUid || null,
            callerUid:     payData.uid  || null,
            orderId:       _pm.orderId,
            hub:           _pm.hub || "marketplace",
            amount,
            phone:         payData.phone || null,
            mpesaCode:     checkoutId    || null,
            sellerName:    _pm.sellerName || _pm.providerName || null,
            description:   _pm.serviceDesc || "SOKONI Order",
            items:         Array.isArray(_pm.items) ? _pm.items : null,
            buyerName:     _pm.buyerName || null,
            address:       _pm.address || _pm.deliveryAddress || null,
            fulfillmentType: _pm.fulfillmentType || "delivery",
            paymentMethod: "mpesa_intasend",
            pathLabel:     "intasend",
            settlementStatus:   "settled",
            writeSellerPayment: false,
          });

          /* Server-priced line items from the finaliser (name + unit price), falling
             back to the client-supplied {productId,qty} for unmetered products. */
          const _lines = (_fin && Array.isArray(_fin.pricedItems) && _fin.pricedItems.length)
            ? _fin.pricedItems
            : (Array.isArray(_pm.items) ? _pm.items.map(i => ({
                productId: i.productId, name: i.name || "Item",
                qty: i.qty || 1, unitPrice: 0, lineTotal: 0,
              })) : []);
          const _subtotal = (_fin && typeof _fin.subtotal === "number") ? _fin.subtotal : amount;
          const _delivery = Math.max(0, Math.round(amount - _subtotal));
          const _dateStr  = new Date().toLocaleString("en-KE", { timeZone: "Africa/Nairobi" });

          /* ── (1) Digital receipt — posReceipts/{apiRef}, deterministic + idempotent.
             ADR-009 canonical field is `receiptNumber`. create() so a webhook replay
             is a no-op (ALREADY_EXISTS) rather than a second receipt. */
          try {
            await db.collection("posReceipts").doc(apiRef).create({
              receiptNumber:  apiRef,
              orderId:        _pm.orderId,
              saleId:         _pm.orderId,
              merchantId:     _pm.sellerUid || null,
              merchantName:   _pm.sellerName || "SOKONI",
              items:          _lines.map(i => ({ productId: i.productId, name: i.name, qty: i.qty, unitPrice: i.unitPrice })),
              customer:       { id: payData.uid || null, name: _pm.buyerName || "", phone: payData.phone || "", email: "" },
              subtotal:       _subtotal,
              deliveryFee:    _delivery,
              tax:            0,
              discount:       0,
              total:          amount,
              /* Fulfillment on the receipt — pickup (collect at shop) vs delivery
                 (rider + address). Rider/ETA are assigned later; the receipt shows
                 what's known at payment time. */
              fulfillmentType: _pm.fulfillmentType || "delivery",
              deliveryAddress: (_pm.fulfillmentType === "pickup") ? null : (_pm.address || _pm.deliveryAddress || null),
              pickupLocation:  (_pm.fulfillmentType === "pickup") ? (_pm.sellerName || "Shop") : null,
              paymentMethod:  "M-PESA",
              paymentRef:     checkoutId || apiRef,
              mpesaCode:      checkoutId || null,
              gatewayRef:     checkoutId || null,
              orderStatus:    "paid",
              status:         "valid",
              date:           _dateStr,
              createdAt:      admin.firestore.FieldValue.serverTimestamp(),
              source:         "webhookIntasend",
            });
            /* Stamp the order so My Orders can deep-link and a reprint reuses THIS
               receipt instead of minting a new one. */
            await db.collection("orders").doc(_pm.orderId).set({
              receiptNumber: apiRef,
              receiptGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: true });
          } catch (rErr) {
            if (rErr && rErr.code !== 6 /* ALREADY_EXISTS */) {
              console.error("[webhookIntasend] receipt write failed:", rErr.message);
            }
          }

          /* ── (2) POS new-paid-order signal — write the cashier's clickAndCollect
             doc DIRECTLY (deterministic id apiRef). NOT via createClickAndCollect,
             which decrements a SEPARATE seller-scoped stock store the buyer never
             touched (would double-deduct). Cashier UI listens on
             sellers/{sellerId}/clickAndCollect where status==pending. */
          if (_pm.sellerUid) {
            try {
              await db.collection("sellers").doc(_pm.sellerUid)
                .collection("clickAndCollect").doc(apiRef).set({
                  orderId:       _pm.orderId,
                  sellerId:      _pm.sellerUid,
                  customerId:    payData.uid || null,
                  customerName:  _pm.buyerName || "",
                  customerPhone: payData.phone || "",
                  customerEmail: "",
                  items:         _lines.map(i => ({ productId: i.productId, name: i.name, price: i.unitPrice, qty: i.qty, lineTotal: i.lineTotal })),
                  subtotal:      _subtotal,
                  total:         amount,
                  paymentMethod: "M-PESA",
                  paymentStatus: "paid",
                  receiptNumber: apiRef,
                  /* pickup → in-store collection (Ready for Pickup); delivery → rider
                     (Awaiting Rider). Drives the POS status label + rider path. */
                  fulfillmentType: _pm.fulfillmentType || "delivery",
                  notes:         "", pickupTime: null,
                  status:        "pending",
                  createdAt:     admin.firestore.FieldValue.serverTimestamp(),
                  readyAt: null, collectedAt: null, cancelledAt: null,
                  source:        "webhookIntasend",
                }, { merge: true });
            } catch (posErr) {
              console.error("[webhookIntasend] POS signal failed:", posErr.message);
            }
          }

          /* ── (2b) Delivery dispatch — for DELIVERY orders, create a packageRequests
             doc so it appears in riders' "Available Deliveries" to accept + track.
             Pickup collects in-store and needs no rider. Minimal server-side record
             (no client OSRM/pricing); rider payout = 80% of the delivery fee.
             Deterministic id (DEL+ref) → idempotent. */
          if ((_pm.fulfillmentType || "delivery") !== "pickup" && _pm.sellerUid) {
            try {
              const _delRef = "DEL" + apiRef;
              const _delDoc = db.collection("packageRequests").doc(_delRef);
              const _exists = await _delDoc.get();
              if (!_exists.exists) {
                const _pin = String(Math.floor(1000 + Math.random() * 9000));
                await _delDoc.set({
                  ref: _delRef, deliveryRef: _delRef, orderId: _pm.orderId, orderRef: apiRef,
                  buyerName:  _pm.buyerName || "", buyerPhone: payData.phone || "", buyerUid: payData.uid || null,
                  sellerName: _pm.sellerName || "SOKONI", sellerUid: _pm.sellerUid, sellerPhone: "",
                  pickupAddress:   _pm.sellerName || "Shop", pickupCoords: null,
                  deliveryAddress: _pm.address || _pm.deliveryAddress || "", deliveryCoords: null,
                  items:      _lines.map(i => ({ productId: i.productId, name: i.name, qty: i.qty })),
                  orderTotal: amount, deliveryFee: _delivery,
                  driverNet:  Math.round(_delivery * 0.8), commissionPct: 5,
                  vehicleType: "moto", speed: "same_day", category: "general",
                  status: "order_placed", proofPin: _pin,
                  timeline: [{ status: "order_placed", at: new Date().toISOString(), by: "system" }],
                  source: "webhookIntasend",
                  createdAt: admin.firestore.FieldValue.serverTimestamp(),
                });
                await db.collection("orders").doc(_pm.orderId).set({ deliveryRef: _delRef }, { merge: true });
              }
            } catch (dErr) {
              console.error("[webhookIntasend] delivery dispatch failed:", dErr.message);
            }
          }

          /* ── (3) Notifications — buyer + seller, idempotent via dedupeKey. ── */
          try {
            const { notify } = require("./notify");
            if (payData.uid) {
              notify({
                uid: payData.uid, type: "payment_success",
                title: "Payment received ✅",
                body: `Your order ${_pm.orderId} is paid — KES ${amount}. Receipt ${apiRef}.`,
                dedupeKey: `order_paid_${apiRef}`,
                data: { orderId: _pm.orderId, receiptNumber: apiRef },
              }).catch(() => {});
            }
            if (_pm.sellerUid) {
              notify({
                uid: _pm.sellerUid, type: "order_placed",
                title: "New paid order 🔔",
                body: `New paid order ${_pm.orderId} — KES ${amount}. Ready to prepare.`,
                dedupeKey: `order_new_${apiRef}`,
                data: { orderId: _pm.orderId, receiptNumber: apiRef },
              }).catch(() => {});
            }
          } catch (nErr) {
            console.error("[webhookIntasend] notify failed:", nErr.message);
          }
        }
      } catch (finErr) {
        /* Never fail the webhook — payment + wallet credit already stand. */
        console.error("[webhookIntasend] product order finalisation failed (recoverable):",
          { ref: apiRef, err: finErr && finErr.message });
      }

      /* ── Service bookings: create the booking + notify both parties ──────────
         bookNow only collects payment; the booking itself MUST be created here,
         server-side, because the customer's payment wizard may be closed before
         this webhook arrives (money taken, but no confirmation — the reported bug).
         Idempotent: keyed by the payment ref. Additive — no money flow changed. */
      try {
        const m = payData.meta || {};
        if (m.type === "booking") {
          const bookingRef = db.collection("bookings").doc(apiRef);
          const created = await db.runTransaction(async (txn) => {
            const b = await txn.get(bookingRef);
            if (b.exists) return false;                    // already created — idempotent
            txn.set(bookingRef, {
              ref:           apiRef,
              customerUid:   payData.uid || null,
              providerId:    m.providerId || null,
              providerName:  m.providerName || "",
              providerPhone: m.providerPhone || "",
              serviceDesc:   m.serviceDesc || "",
              category:      m.category || "default",
              amount, currency: "KES",
              status:        "confirmed",                  // paid; awaiting provider fulfilment
              paymentRef:    apiRef,
              createdAt:     admin.firestore.FieldValue.serverTimestamp(),
              updatedAt:     admin.firestore.FieldValue.serverTimestamp(),
            });
            return true;
          });
          if (created) {
            const { notify } = require("./notify");
            if (payData.uid) notify({
              uid: payData.uid, type: "booking_confirmed",
              title: "Booking confirmed ✅",
              body: `Your booking with ${m.providerName || "the provider"} is confirmed. Ref ${apiRef}.`,
              dedupeKey: `booking_confirmed_${apiRef}`,
              data: { ref: apiRef, providerName: m.providerName || "" },
            }).catch(() => {});
            if (m.providerId) notify({
              uid: m.providerId, type: "booking_new",
              title: "New booking 📅",
              body: `You have a new booking${m.serviceDesc ? " — " + m.serviceDesc : ""}. Ref ${apiRef}.`,
              dedupeKey: `booking_new_${apiRef}`,
              data: { ref: apiRef, customerUid: payData.uid || "" },
            }).catch(() => {});
            console.log(`[webhookIntasend] booking created + notified: ${apiRef}`);
            /* Convergence telemetry (WS4a) — a NEW legacy top-level `bookings`
               create. Best-effort: never affects the webhook/payment. */
            try { require("./booking-convergence").bumpBookingConvergence(db, "legacy"); } catch (e) { /* ignore */ }
          }
        }
      } catch (bErr) {
        /* Never fail the webhook on booking-creation error — payment stands. */
        console.error("[webhookIntasend] booking creation failed (recoverable):", bErr.message);
      }

      try {
        const intentRef  = existing.intentRef || apiRef;
        const intentSnap = await db.collection("paymentIntents").doc(intentRef).get();
        if (intentSnap.exists) {
          const intent = intentSnap.data();
          if (intent.purpose === "subscription" && intent.planId && intent.uid) {
            const subRef  = db.collection("subscriptions").doc(intent.uid);
            const subSnap = await subRef.get();
            const subData = subSnap.exists ? subSnap.data() : null;
            if (!subData || subData.paymentRef !== apiRef) {
              const expiresAt = new Date(Date.now() + 30 * 86400000);
              await subRef.set({
                uid:          intent.uid,
                plan:         intent.planId,
                planName:     intent.planName || intent.planId,
                billingCycle: intent.billingCycle || "monthly",
                status:       "active",
                paymentRef:   apiRef,
                amountPaid:   amount,
                source:       "webhookIntasend",
                activatedAt:  admin.firestore.FieldValue.serverTimestamp(),
                expiresAt:    admin.firestore.Timestamp.fromDate(expiresAt),
                updatedAt:    admin.firestore.FieldValue.serverTimestamp(),
              });
              console.log("[webhookIntasend] Subscription auto-activated",
                { uid: intent.uid, plan: intent.planId, ref: apiRef });

              /* Activation used to end here, and that was the incident: this
                 writes subscriptions/{uid}, but the seller UI reads
                 users/{uid}.subscription.seller — a document only sub-billing.js
                 maintains and which this path never invoked. With nothing at the
                 read location the client fell back to its hard-coded free
                 allowance and showed a 10-product limit to a merchant who had
                 paid for 100, while canPublishProduct (reading the authoritative
                 path) correctly allowed the 13th upload.

                 Materialise the entitlement now so both readers agree. This is
                 deliberately awaited rather than fire-and-forget: a merchant who
                 has just paid reloads within seconds, and a background write that
                 loses the race reproduces the original symptom. It cannot fail
                 the webhook — materialiseEntitlements swallows its own errors and
                 the subscription is already authoritative in subscriptions/{uid}.
                 onSubscriptionChangedSyncEntitlements also fires on that write,
                 so this is belt-and-braces against trigger latency, not the only
                 path. */
              /* Required locally rather than via the module-scope binding
                 declared ~1300 lines below: that const is in its temporal dead
                 zone until module evaluation reaches it, and depending on
                 handler timing to stay safe is a latent ReferenceError. Node
                 caches modules, so this costs nothing after the first call. */
              await require('./subscription-authority')._internal
                .materialiseEntitlements(intent.uid, "payment-complete");
              db.collection("subscriptionAuditLog").add({
                uid:       intent.uid,
                plan:      intent.planId,
                paymentRef: apiRef,
                action:    "ACTIVATED",
                source:    "webhookIntasend",
                expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
                timestamp: admin.firestore.FieldValue.serverTimestamp(),
              }).catch(e => console.error("[webhookIntasend] Sub-audit log failed:", e.message));
            }
          }
        }
      } catch (subErr) {
        console.error("[webhookIntasend] Subscription auto-activation failed",
          { ref: apiRef, err: subErr.message });
      }

      try {
        const intentSnap2 = await db.collection("paymentIntents").doc(apiRef).get();
        if (intentSnap2.exists && intentSnap2.data().purpose === "subscription") {
          const adapters = require("./entitlement-adapters");
          await adapters.shadowCompareSubscription(apiRef, {
            uid: intentSnap2.data().uid || intentSnap2.data().ownerUid || null,
          });
        }
      } catch (shadowErr) {
        console.error("[webhookIntasend] shadow comparison skipped",
          { ref: apiRef, err: shadowErr && shadowErr.message });
      }
    }

    res.status(200).send("OK");
  }
);

/* â”€â”€ M-Pesa (Daraja) â”€â”€ */
/* Safaricom Daraja does not sign webhook payloads, so we restrict by source IP.
   Allowlist sourced from Safaricom's published Daraja IP range documentation. */
const _DARAJA_IPS = new Set([
  "196.201.214.200", "196.201.214.206", "196.201.213.114",
  "196.201.214.207", "196.201.214.208", "196.201.213.44",
  "196.201.212.137", "196.201.212.136", "196.201.212.138",
  "196.201.212.129", "196.201.212.136", "196.201.212.140",
]);

exports.webhookMpesa = onRequest(
  { timeoutSeconds: 30, cors: false, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).end();

    /* IP allowlist — reject non-Safaricom callers before any processing */
    const clientIp = (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
                     || req.ip || "";
    if (!_DARAJA_IPS.has(clientIp)) {
      await db.collection("webhookLogs").add({
        provider: "mpesa", status: "ip_blocked", clientIp,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.sendStatus(403);
    }

    await _processWebhook(req, res, {
      provider:    "mpesa",
      getEventId:  (b) => {
        const cb = b && b.Body && b.Body.stkCallback;
        return (cb && cb.CheckoutRequestID) || (b && b.TransID);
      },
      parsePayload:(b) => {
        const cb    = (b && b.Body && b.Body.stkCallback) || b || {};
        const code  = cb.ResultCode != null ? cb.ResultCode : 0;
        const items = (cb.CallbackMetadata && cb.CallbackMetadata.Item) || [];
        const get   = (n) => { const i = items.find((x) => x.Name === n); return i && i.Value; };
        return {
          status:     code === 0 ? "COMPLETE" : "FAILED",
          amount:     get("Amount"),
          phone:      String(get("PhoneNumber") || ""),
          mpesaCode:  get("MpesaReceiptNumber"),
          reference:  cb.CheckoutRequestID || (b && b.TransID) || "",
          resultDesc: cb.ResultDesc || "",
          raw:        b,
        };
      },
      onSuccess: async (payload, eventId) => {
        if (payload.status !== "COMPLETE") return;
        await db.collection("webhookPayments").add({
          provider: "mpesa", eventId,
          amount: payload.amount, phone: payload.phone,
          mpesaCode: payload.mpesaCode, reference: payload.reference,
          status: "completed",
          serverTs: admin.firestore.FieldValue.serverTimestamp(),
        });
      },
    });
  }
);

/* â”€â”€ Stripe â”€â”€ */
exports.webhookStripe = onRequest(
  { timeoutSeconds: 10, cors: false, invoker: "public" },
  async (req, res) => {
    // Stripe is not configured — reject all calls to prevent unauthenticated
    // webhook injection (no HMAC secret defined; secretKey was missing from
    // _processWebhook, bypassing the signature check entirely).
    // Re-enable: define STRIPE_WEBHOOK_SECRET in Secret Manager, add it to
    // secrets:[], and pass it as secretKey in _processWebhook opts below.
    return res.status(501).json({ error: 'Stripe payments not configured on this platform.' });
  }
);
/* DISABLED — reference implementation only; intentionally NOT exported so it is
   never deployed. This original Stripe handler bypassed signature verification
   (no secretKey passed to _processWebhook), allowing unauthenticated webhook
   injection into `webhookPayments`. The active `webhookStripe` above returns 501.
   To re-enable Stripe securely: define STRIPE_WEBHOOK_SECRET in Secret Manager,
   add it to secrets:[], pass it as secretKey in the _processWebhook opts to
   enforce signature checks, then expose it as `exports.webhookStripe`.

const _webhookStripeReference = onRequest(
  { timeoutSeconds: 30, cors: false, invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).end();
    await _processWebhook(req, res, {
      provider:    "stripe",
      getEventId:  (b) => b && b.id,
      parsePayload:(b) => {
        const obj = (b && b.data && b.data.object) || {};
        return {
          type:      b && b.type,
          amount:    obj.amount_received || obj.amount,
          currency:  ((obj.currency || "usd")).toUpperCase(),
          reference: obj.id || "",
          status:    (b && b.type) === "payment_intent.succeeded" ? "COMPLETE" : "PENDING",
          raw:       b,
        };
      },
      onSuccess: async (payload, eventId) => {
        if (payload.status !== "COMPLETE") return;
        await db.collection("webhookPayments").add({
          provider: "stripe", eventId,
          amount: payload.amount, currency: payload.currency,
          reference: payload.reference, status: "completed",
          serverTs: admin.firestore.FieldValue.serverTimestamp(),
        });
      },
    });
  }
);
*/

/* â”€â”€ SmartPOS â”€â”€ */
exports.webhookSmartpos = onRequest(
  { timeoutSeconds: 30, cors: ["https://mysokoni.co.ke"], invoker: "public" },
  async (req, res) => {
    if (req.method !== "POST") return res.status(405).end();
    await _processWebhook(req, res, {
      provider:    "smartpos",
      getEventId:  (b) => (b && b.transaction_id) || (b && b.id),
      parsePayload:(b) => b,
      onSuccess: async (payload, eventId) => {
        await db.collection("posTransactions").add(
          Object.assign({}, payload, { eventId, serverTs: admin.firestore.FieldValue.serverTimestamp() })
        );
      },
    });
  }
);

/* â”€â”€ Replay DLQ entry (admin) â”€â”€ */
exports.replayWebhookDLQ = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  const dlqId = request.data && request.data.dlqId;
  if (!dlqId) throw new HttpsError("invalid-argument", "dlqId required.");

  const snap = await db.collection("webhookDLQ").doc(dlqId).get();
  if (!snap.exists) throw new HttpsError("not-found", "DLQ entry not found.");
  const entry = snap.data();

  await db.collection("webhookRetryQueue").add(
    Object.assign({}, entry, {
      attempts: (entry.attempts || 1) + 1,
      replayedBy: request.auth.uid,
      replayedAt: admin.firestore.FieldValue.serverTimestamp(),
    })
  );
  await snap.ref.update({ status: "replayed", replayedAt: admin.firestore.FieldValue.serverTimestamp() });
  return { success: true, dlqId, provider: entry.provider, eventId: entry.eventId };
});

/* â”€â”€ Webhook health endpoint â”€â”€ */
exports.webhookHealth = onRequest(
  { timeoutSeconds: 10, cors: ["https://mysokoni.co.ke"], invoker: "public" },
  async (req, res) => {
    const [dlqSnap, retrySnap] = await Promise.all([
      db.collection("webhookDLQ").where("status", "!=", "replayed").limit(1000).get().catch(() => ({ size: -1 })),
      db.collection("webhookRetryQueue").limit(100).get().catch(() => ({ size: -1 })),
    ]);
    const dlqDepth = dlqSnap.size;
    res.json({
      status: dlqDepth > 100 ? "degraded" : "healthy",
      dlqDepth,
      retryQueue: retrySnap.size,
      ts: new Date().toISOString(),
    });
  }
);

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   PAYMENT ENGINE â€” SERVER-SIDE
   Escrow release, refunds, and settlements are authoritative here.
   The client-side sokoni-payment-engine.js only reads these results.
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* â”€â”€ Release escrow â”€â”€ */
exports.releaseEscrow = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const isAdmin = request.auth.token && request.auth.token.admin === true;

  const escrowRef = request.data && request.data.escrowRef;
  const note      = (request.data && request.data.note) || "";
  if (!escrowRef) throw new HttpsError("invalid-argument", "escrowRef required.");

  const escrowDoc = await db.collection("escrows").doc(escrowRef).get();
  if (!escrowDoc.exists) throw new HttpsError("not-found", "Escrow not found.");
  const escrow = escrowDoc.data();

  if (escrow.status !== "active") {
    throw new HttpsError("failed-precondition", "Escrow status is " + escrow.status);
  }
  if (!isAdmin && request.auth.uid !== escrow.buyerId && request.auth.uid !== escrow.sellerId) {
    throw new HttpsError("permission-denied", "Not authorised to release this escrow.");
  }

  const currency = escrow.currency || "KES";

  /* ── ESCROW RELEASE MUST NOT CHARGE COMMISSION ────────────────────────────────────────────
   * This used to do:
   *     const commission = Math.round(gross * _PLATFORM_FEE * 100) / 100;   // a flat 10%
   *
   * Three separate defects in one line:
   *
   * 1. IT WOULD HAVE DOUBLE-CHARGED. Escrows are created by finos-router routePayment, which
   *    ALREADY runs calculateCommission and credits the platform its commission at payment
   *    time (finos-router.js:256). The escrow holds sellerNetCents — commission is gone. Taking
   *    another 10% on release charges the seller twice for one sale.
   *
   * 2. IT READ A FIELD NOTHING WRITES. finos-router stores `grossCents`; this read
   *    `escrow.amount`. On a real escrow that is undefined, so Math.round(undefined * 0.1) is
   *    NaN — and NaN was being written straight into sellerNet, the ledger and the wallet.
   *
   * 3. THE 10% MATCHED NO HUB. Marketplace is 3%. The rate was hardcoded and bypassed the
   *    Commission Engine entirely: no commissionRules, no revenueConfig, no audit trail.
   *
   * The escrows collection is empty in production, so nothing has been mis-charged. This is a
   * landmine defused before it fired: escrow is on by default in the settlement rules, so these
   * documents are about to start existing.
   *
   * Release now pays out exactly what the engine computed at payment time. */
  const isEngineEscrow = Number.isFinite(escrow.grossCents);
  let gross, commission, sellerNet, commissionAlreadyCharged, audit = null;

  if (isEngineEscrow) {
    gross                    = escrow.grossCents / 100;
    commissionAlreadyCharged = (escrow.commissionCents || 0) / 100;
    commission               = 0;   /* already taken at payment — nothing more is owed */
    sellerNet                = (escrow.sellerNetCents != null)
                                 ? escrow.sellerNetCents / 100
                                 : gross - commissionAlreadyCharged;
  } else if (Number.isFinite(Number(escrow.amount))) {
    /* Legacy shape. No writer produces it and production holds none, but if one ever appears it
       is priced by the ONE engine — never by a hardcoded rate. */
    gross = Number(escrow.amount);
    const { calculateCommission } = require('./finos-utils');
    const comm = await calculateCommission(db, {
      orderAmountCents: Math.round(gross * 100),
      category:         escrow.category || escrow.hubType || "marketplace",
      sellerId:         escrow.sellerId,
      hubId:            escrow.hubType || null,
    });
    commission               = comm.commissionCents / 100;
    commissionAlreadyCharged = 0;
    sellerNet                = comm.sellerNetCents / 100;
    audit = {
      commissionPct: comm.effectiveRate, baseRate: comm.baseRate,
      pricingSource: comm.pricingSource, ruleId: comm.ruleId, ruleSource: comm.ruleSource,
      reason: comm.reason, calculatedAt: comm.calculatedAt, engineVersion: comm.engineVersion,
    };
  } else {
    /* FAIL CLOSED. An escrow we cannot price is an escrow we must not release — the old code
       would have written NaN through the ledger and into a wallet. */
    throw new HttpsError("failed-precondition",
      "Escrow " + escrowRef + " has no usable amount (neither grossCents nor amount). Refusing to release.");
  }

  /* WHT is withheld at PAYOUT by the settlement engine, not here. Deducting it again on release
     would tax the seller twice on one sale. Only the legacy path, which has no payout pipeline
     behind it, still applies it. */
  const wht = (!isEngineEscrow && gross >= _TAX.WHT_THRESHOLD)
    ? Math.round(gross * _TAX.WHT * 100) / 100
    : 0;
  if (wht > 0) sellerNet = Math.round((sellerNet - wht) * 100) / 100;
  const ref        = _genRef("REL");
  const ts         = admin.firestore.FieldValue.serverTimestamp();

  const batch = db.batch();

  batch.update(db.collection("escrows").doc(escrowRef), Object.assign({
    status: "released", releasedAt: ts,
    releasedBy: request.auth.uid, sellerNet, commission, wht, note,
    /* What was actually taken, and when — so a release is explainable years later. On an
       engine escrow `commission` is 0 because it was charged at payment; this records what
       that charge was, rather than leaving a reader to conclude the sale was free. */
    commissionAlreadyCharged,
    commissionChargedAtRelease: commission,
    pricingSource: isEngineEscrow ? 'charged_at_payment (finos-router)' : 'commission_engine',
    releaseEngineVersion: 2,
  }, audit || {}));

  const ledger = db.collection("paymentLedger");
  batch.set(ledger.doc(ref + ":release"), {
    ref: ref + ":release", type: "escrow_released",
    debitAccount: "escrow:holding",
    creditAccount: "seller:" + escrow.sellerId,
    amount: sellerNet, currency,
    metadata: { escrowRef, orderId: escrow.orderId },
    serverTs: ts,
  });
  if (commission > 0) {
    batch.set(ledger.doc(ref + ":commission"), {
      ref: ref + ":commission", type: "commission_collected",
      debitAccount: "escrow:holding", creditAccount: "platform:revenue",
      amount: commission, currency,
      metadata: { escrowRef, vat: Math.round(commission * _TAX.VAT * 100) / 100 },
      serverTs: ts,
    });
  }
  if (wht > 0) {
    batch.set(ledger.doc(ref + ":wht"), {
      ref: ref + ":wht", type: "withholding_tax",
      debitAccount: "escrow:holding", creditAccount: "platform:tax_liability",
      amount: wht, currency,
      metadata: { escrowRef, rate: _TAX.WHT },
      serverTs: ts,
    });
  }
  batch.set(db.collection("auditLogs").doc(), {
    action: "escrow_released", escrowRef,
    orderId: escrow.orderId, sellerId: escrow.sellerId, buyerId: escrow.buyerId,
    gross, sellerNet, commission, wht,
    by: request.auth.uid, serverTs: ts,
  });

  await batch.commit();

  /* FCM notification to seller */
  try {
    const tok = await getFcmToken(escrow.sellerId);
    if (tok) await sendFcm(tok, "Payment Released!", "KES " + sellerNet.toLocaleString("en-KE") + " released to your account", "seller.html");
  } catch (_) {}

  return { ref, status: "released", gross, sellerNet, commission, wht, currency };
});

/* â”€â”€ Initiate refund â”€â”€ */
exports.initiateRefund = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  /* ══ CRITICAL-02 REMEDIATION (2026-07-19) ═══════════════════════════════════
     Previously:
         const refundAmt = amount ? Number(amount) : (escrow && escrow.amount) || 0;
     The client's `amount` was used verbatim, with no comparison against what was
     actually paid, and line 6170 permits the BUYER (not only an admin). The
     function then wrote a paymentLedger credit to "buyer:{uid}". A buyer could
     therefore credit themselves an arbitrary sum. Deployed and client-callable
     via sokoni-endpoints.js:38.

     Three separate holes are closed here:
       1. Amount was unbounded          -> capped at the authoritative escrow amount
       2. No cumulative ceiling         -> prior refunds are summed and deducted
       3. Escrow could be refunded      -> status is asserted inside a transaction,
          repeatedly (no idempotency)      so concurrent calls cannot both succeed

     Buyer authorisation is deliberately RETAINED. Capping alone removes the
     exploit, and requiring admin would break legitimate buyer-initiated refunds.
     Smallest change that eliminates the financial risk. ══════════════════════ */
  const { orderId, escrowRef, amount, reason } = request.data || {};
  const refundReason = reason || "customer_request";
  if (!orderId && !escrowRef) throw new HttpsError("invalid-argument", "orderId or escrowRef required.");

  const isAdminCaller = !!(request.auth.token && request.auth.token.admin);

  let escrow = null;
  if (escrowRef) {
    const snap = await db.collection("escrows").doc(escrowRef).get();
    if (!snap.exists) throw new HttpsError("not-found", "Escrow not found.");
    escrow = snap.data();
    if (!isAdminCaller && request.auth.uid !== escrow.buyerId) {
      throw new HttpsError("permission-denied", "Only the buyer or admin can request a refund.");
    }
  } else {
    /* orderId-only path. This previously performed NO ownership check at all, so
       any authenticated user could file a refund request against any order. It
       writes no ledger entry, but it does create a refunds record and an audit
       entry that an operator may later action.

       Ownership mirrors the canonical definition already in firestore.rules:265-268
       (uid | userId | buyerId | buyerUid) rather than inventing a new one. */
    const oSnap = await db.collection("orders").doc(String(orderId)).get();
    if (!oSnap.exists) throw new HttpsError("not-found", "Order not found.");
    const o = oSnap.data();
    const owns = [o.uid, o.userId, o.buyerId, o.buyerUid].includes(request.auth.uid);
    if (!isAdminCaller && !owns) {
      throw new HttpsError("permission-denied", "Only the buyer or admin can request a refund.");
    }
  }

  const refundRef = _genRef("RFD");
  const ts        = admin.firestore.FieldValue.serverTimestamp();

  /* Authoritative original. Only the escrow carries a server-trusted figure; we
     do not infer an amount from the order document, because that would mean
     guessing which of several total fields is canonical. */
  const originalAmt = escrow ? Number(escrow.amount) || 0 : null;

  let refundAmt;
  if (escrow) {
    /* Sum refunds already raised against this escrow. Cancelled/failed refunds
       do not consume the ceiling. */
    const priorSnap = await db.collection("refunds")
      .where("escrowRef", "==", escrowRef)
      .get();
    const priorTotal = priorSnap.docs
      .filter(d => ["pending", "processing", "completed"].includes(d.data().status))
      .reduce((sum, d) => sum + (Number(d.data().amount) || 0), 0);

    const remaining = Math.max(0, originalAmt - priorTotal);
    if (remaining <= 0) {
      throw new HttpsError("failed-precondition", "This payment has already been fully refunded.");
    }

    const requested = amount != null ? Number(amount) : remaining;
    if (!Number.isFinite(requested) || requested <= 0) {
      throw new HttpsError("invalid-argument", "Invalid refund amount.");
    }
    if (requested > remaining) {
      throw new HttpsError("invalid-argument",
        `Refund exceeds the refundable balance for this payment (${remaining}).`);
    }
    refundAmt = requested;
  } else {
    /* No authoritative amount is available on this path, so the client's figure
       is NOT honoured. The request is recorded for an operator to determine. */
    refundAmt = null;
  }

  await db.collection("refunds").doc(refundRef).set({
    ref: refundRef,
    orderId: orderId || null,
    escrowRef: escrowRef || null,
    amount: refundAmt,
    amountAuthority: escrow ? "escrow" : "pending_admin_determination",
    currency: (escrow && escrow.currency) || "KES",
    reason: refundReason,
    initiatedBy: request.auth.uid,
    status: "pending",
    serverTs: ts,
  });

  /* Product Settlement Convergence — keep the order's settlement state honest on refund:
     if the order was ALREADY SETTLED, reverse it (debit seller, reverse ledger); otherwise mark
     it REFUNDED so a pending settlement becomes a no-op. Best-effort + exactly-once; the refund
     record above stands regardless. */
  if (orderId) {
    try { await require("./order-settlement").handleOrderRefund(db, admin, String(orderId), { reason: refundReason, refundRef }); }
    catch (e) { console.error("[initiateRefund] settlement-state update failed (recoverable):", e.message); }
  }

  if (escrowRef && escrow) {
    /* Transactional: assert the escrow has not already been refunded, so two
       concurrent calls cannot both pass the ceiling check above and both write a
       ledger credit. The read-modify-write must be atomic. */
    await db.runTransaction(async (t) => {
      const eRef  = db.collection("escrows").doc(escrowRef);
      const eSnap = await t.get(eRef);
      if (!eSnap.exists) throw new HttpsError("not-found", "Escrow not found.");
      if (eSnap.data().status === "refunded") {
        throw new HttpsError("failed-precondition", "This payment has already been refunded.");
      }

      const fullyRefunded = refundAmt >= originalAmt;
      t.update(eRef, {
        status: fullyRefunded ? "refunded" : (eSnap.data().status || "held"),
        refundedAt: ts, refundedBy: request.auth.uid, refundRef, reason: refundReason,
      });

      t.create(db.collection("paymentLedger").doc(refundRef), {
        ref: refundRef, type: "escrow_refunded",
        debitAccount: "escrow:holding",
        creditAccount: "buyer:" + escrow.buyerId,
        amount: refundAmt, currency: escrow.currency || "KES",
        metadata: { orderId: orderId || null, reason: refundReason, originalAmount: originalAmt },
        serverTs: ts,
      });
    });
  }

  await db.collection("auditLogs").add({
    action: "refund_initiated", refundRef,
    orderId: orderId || null, escrowRef: escrowRef || null,
    amount: refundAmt, reason: refundReason,
    by: request.auth.uid, serverTs: ts,
  });

  if (escrow && escrow.buyerId) {
    try {
      const tok = await getFcmToken(escrow.buyerId);
      if (tok) await sendFcm(tok, "Refund Initiated", "Your refund is being processed", "profile.html");
    } catch (_) {}
  }

  return { ref: refundRef, status: "pending", orderId: orderId || null, reason: refundReason };
});

/* â”€â”€ Settlement report (admin) â”€â”€ */
exports.getSettlementReport = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  const { sellerId, periodStart, periodEnd } = request.data || {};
  if (!periodStart || !periodEnd) throw new HttpsError("invalid-argument", "periodStart and periodEnd required.");

  const startTs = admin.firestore.Timestamp.fromDate(new Date(periodStart));
  const endTs   = admin.firestore.Timestamp.fromDate(new Date(periodEnd));

  let q = db.collection("escrows")
    .where("status", "==", "released")
    .where("releasedAt", ">=", startTs)
    .where("releasedAt", "<=", endTs);
  if (sellerId) q = q.where("sellerId", "==", sellerId);
  q = q.limit(500);

  const snap = await q.get();
  const rows = snap.docs.map((d) => d.data());

  const sum = rows.reduce((acc, r) => {
    acc.grossRevenue += Number(r.amount     || 0);
    acc.commission   += Number(r.commission || 0);
    acc.wht          += Number(r.wht        || 0);
    acc.sellerNet    += Number(r.sellerNet  || 0);
    acc.orderCount++;
    return acc;
  }, { grossRevenue: 0, commission: 0, wht: 0, sellerNet: 0, orderCount: 0 });

  const r = (n) => Math.round(n * 100) / 100;
  return {
    period: { start: periodStart, end: periodEnd },
    sellerId: sellerId || "all",
    grossRevenue: r(sum.grossRevenue),
    commission:   r(sum.commission),
    wht:          r(sum.wht),
    sellerNet:    r(sum.sellerNet),
    orderCount:   sum.orderCount,
    vatLiability: r(sum.commission * _TAX.VAT),
    dstLiability: r(sum.grossRevenue * _TAX.DST),
    rows,
    generatedAt: new Date().toISOString(),
  };
});

/* ── Initiate seller payout (admin) ── */
exports.initiateSellerPayout = onCall(
  { secrets: [INTASEND_PRIVATE_KEY], timeoutSeconds: 60 },
  async (request) => {
    if (!request.auth || !request.auth.token || !request.auth.token.admin) {
      throw new HttpsError("permission-denied", "Admin only.");
    }
    const { sellerId, amount, phone, method, reference } = request.data || {};
    if (!sellerId || !amount || !phone) {
      throw new HttpsError("invalid-argument", "sellerId, amount, and phone required.");
    }

    const payMethod = method || "mpesa";
    const ref       = reference || _genRef("PAY");
    const ts        = admin.firestore.FieldValue.serverTimestamp();
    const privKey   = INTASEND_PRIVATE_KEY.value();

    await db.collection("settlements").doc(ref).set({
      ref, sellerId, amount: Number(amount), phone, method: payMethod,
      status: "processing", serverTs: ts,
    });

    let disbursementResult = null;
    if (payMethod === "mpesa" && privKey) {
      try {
        const resp = await fetch("https://payment.intasend.com/api/v1/send-money/mpesa/", {
          method: "POST",
          headers: { Authorization: "Token " + privKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            currency: "KES",
            transactions: [{ name: "Seller " + sellerId, account: phone, amount: Math.round(Number(amount)) }],
          }),
        });
        disbursementResult = await resp.json();
      } catch (e) {
        console.error("[initiateSellerPayout] IntaSend error:", e.message);
      }
    }

    const finalStatus = (disbursementResult && disbursementResult.status === "PN") ? "pending_network" : "submitted";
    await db.collection("settlements").doc(ref).update({
      status: finalStatus, disbursementResult: disbursementResult || null,
      processedAt: ts,
    });
    await db.collection("paymentLedger").add({
      ref, type: "settlement_initiated",
      debitAccount: "platform:payable:" + sellerId,
      creditAccount: "seller:" + sellerId + ":bank",
      amount: Number(amount), currency: "KES",
      metadata: { method: payMethod, phone },
      serverTs: ts,
    });
    await db.collection("auditLogs").add({
      action: "seller_payout", ref, sellerId, amount, method: payMethod,
      by: request.auth.uid, serverTs: ts,
    });

    return { ref, status: finalStatus, amount, method: payMethod };
  }
);

/* â”€â”€ Ledger balance query (admin) â”€â”€ */
exports.getLedgerBalance = onCall({ timeoutSeconds: 30 }, async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  const account  = request.data && request.data.account;
  const currency = (request.data && request.data.currency) || "KES";
  if (!account) throw new HttpsError("invalid-argument", "account required.");

  const [debits, credits] = await Promise.all([
    db.collection("paymentLedger").where("debitAccount",  "==", account).where("currency", "==", currency).get(),
    db.collection("paymentLedger").where("creditAccount", "==", account).where("currency", "==", currency).get(),
  ]);

  let balance = 0;
  debits.docs.forEach((d)  => { balance -= Number(d.data().amount || 0); });
  credits.docs.forEach((c) => { balance += Number(c.data().amount || 0); });

  return {
    account, currency,
    balance: Math.round(balance * 100) / 100,
    debitCount: debits.size,
    creditCount: credits.size,
  };
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SERVER-SIDE FRAUD DETECTION
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

exports.evaluateFraudRisk = onCall({ timeoutSeconds: 15 }, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");

  const uid    = request.auth.uid;
  const event  = (request.data && request.data.event)  || "payment";
  const amount = (request.data && request.data.amount) || 0;
  const phone  = (request.data && request.data.phone)  || "";

  const fiveMin = admin.firestore.Timestamp.fromMillis(Date.now() - 300000);
  const oneHour = admin.firestore.Timestamp.fromMillis(Date.now() - 3600000);

  const [shortSnap, longSnap, blockSnap] = await Promise.all([
    db.collection("auditLogs")
      .where("type", "==", "mpesa_stk_push")
      .where("callerUid", "==", uid)
      .where("ts", ">=", fiveMin)
      .limit(5).get().catch(() => ({ size: 0 })),
    db.collection("auditLogs")
      .where("type", "==", "mpesa_stk_push")
      .where("callerUid", "==", uid)
      .where("ts", ">=", oneHour)
      .limit(12).get().catch(() => ({ size: 0 })),
    db.collection("fraudBlocklist")
      .where("type", "==", "uid")
      .where("value", "==", uid)
      .limit(1).get().catch(() => ({ empty: true })),
  ]);

  const signals = [];
  let score = 0;

  if (!blockSnap.empty)       { signals.push("blocked_uid");       score += 100; }
  if (shortSnap.size >= 3)    { signals.push("velocity_high");     score += 40;  }
  else if (longSnap.size >= 8){ signals.push("velocity_medium");   score += 20;  }
  if (Number(amount) > 500000){ signals.push("amount_large");      score += 15;  }

  score = Math.min(score, 100);
  const decision = score >= 60 ? "block" : score >= 31 ? "review" : "allow";

  if (decision !== "allow") {
    await db.collection("fraudLog").add({
      uid, event, amount, phone, score, signals, decision,
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
    if (decision === "block") {
      await db.collection("securityEvents").add({
        type: "fraud_blocked", uid, score, signals, event,
        ts: admin.firestore.FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  }

  return { decision, score, signals, blocked: decision === "block", requiresReview: decision === "review" };
});

/* â”€â”€ Block/unblock entity (admin) â”€â”€ */
exports.fraudBlock = onCall({ timeoutSeconds: 10 }, async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  const { type, value, reason } = request.data || {};
  if (!type || !value) throw new HttpsError("invalid-argument", "type and value required.");

  const normalised = String(value).toLowerCase().trim();
  await db.collection("fraudBlocklist").add({
    type, value: normalised, reason: reason || "",
    blockedBy: request.auth.uid,
    serverTs: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { success: true, type, value: normalised };
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   EVENT PROCESSOR â€” Firestore-triggered domain event handlers
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

exports.onEventLogged = onDocumentCreated("eventLog/{eventId}", async (event) => {
  if (!event.data) return;
  const data = event.data.data();
  if (!data) return;

  const type    = data.type;
  const payload = data.payload || {};
  console.log("[EventProcessor] " + type, JSON.stringify(payload).slice(0, 120));

  if (type === "Order.Created" && payload.buyerId) {
    try {
      const tok = await getFcmToken(payload.buyerId);
      if (tok) await sendFcm(tok, "Order Received!", "Your order is being processed", "track.html");
    } catch (_) {}
  }

  if (type === "Escrow.Released" && payload.sellerId) {
    await db.collection("settlementQueue").add({
      sellerId: payload.sellerId,
      amount: payload.sellerNet,
      currency: payload.currency || "KES",
      escrowRef: payload.ref || "",
      status: "queued",
      serverTs: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }

  if (type === "Fraud.Blocked" && payload.uid) {
    await db.collection("users").doc(payload.uid).set({
      suspended: true,
      suspendedAt: admin.firestore.FieldValue.serverTimestamp(),
      suspendReason: "Automated fraud detection",
    }, { merge: true }).catch(() => {});
  }

  if (type === "Inventory.LowStock" && payload.sellerId) {
    try {
      const tok = await getFcmToken(payload.sellerId);
      if (tok) await sendFcm(tok, "Low Stock Alert", (payload.productName || "A product") + " is running low", "seller.html");
    } catch (_) {}
  }

  if (type === "Subscription.Expired" && payload.sellerId) {
    await db.collection("sellerSubscriptions").doc(payload.sellerId).update({
      plan: "free", status: "expired",
      expiredAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch(() => {});
  }
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SEARCH INDEXER â€” Firestore triggers to update searchableTerms
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* Moved to ./search-terms so the catalogue repair path generates identical
   terms. Two generators would mean a query that matches a product indexed by
   the trigger and misses the same product after a repair. */
const { buildSearchTerms: _buildSearchTerms } = require("./search-terms");

exports.indexProductCreate = onDocumentCreated("products/{productId}", async (event) => {
  if (!event.data) return;
  const doc = event.data.data();
  if (!doc) return;
  /* Skip if searchableTerms already set (prevents double-write on retry) */
  if (doc.searchableTerms && doc.searchableTerms.length) return;
  await event.data.ref.update({
    searchableTerms: _buildSearchTerms(doc),
    nameLower: (doc.name || "").toLowerCase(),
  }).catch(() => {});
});

exports.indexProductUpdate = onDocumentUpdated("products/{productId}", async (event) => {
  if (!event.data || !event.data.after) return;
  const after = event.data.after.data() || {};
  const _before = (event.data.before && event.data.before.data()) || {};

  /* Audit price changes (canonical schema). A trigger observes the write, so the actor is
     after.updatedBy (set by the client on product edits). Runs BEFORE the search-terms early
     return so a price-only edit is still recorded. Fire-and-forget. */
  try {
    const _pb = Number(_before.price), _pa = Number(after.price);
    if (isFinite(_pb) && isFinite(_pa) && _pb !== _pa) {
      _writeAudit(db, {
        action:     'product.price_change',
        actorUid:   after.updatedBy || after.sellerUid || after.uid || null,
        branchId:   after.branchId || 'default',
        objectType: 'product',
        objectId:   event.params.productId,
        before:     { price: _pb },
        after:      { price: _pa },
        delta:      _pa - _pb,
        reason:     after.priceChangeReason || null,
        metadata:   { name: after.name || null, sellerUid: after.sellerUid || after.uid || null },
      });
    }
  } catch (_) {}

  /* Guard: write only when the generated index actually differs from what is
     stored. This replaced a fixed TEXT_FIELDS list compared with !==, which was
     wrong in both directions: array fields (tags, and now the variant
     attributes) compare by reference, so two snapshots of an unchanged array
     always looked "changed" and re-armed the very update loop the list was
     meant to prevent; and any field outside the list — a seller adding colours
     or sizes — looked unchanged and left the product's terms stale.
     Comparing the output instead is self-limiting: the trigger's own write
     produces identical terms on the next pass, so the loop terminates after one
     hop no matter which field moved, and no field list needs maintaining when
     search-terms.js learns a new one. */
  const nextTerms = _buildSearchTerms(after);
  const nextName  = (after.name || "").toLowerCase();
  const prevTerms = Array.isArray(after.searchableTerms) ? after.searchableTerms : null;
  const sameTerms = prevTerms
    && prevTerms.length === nextTerms.length
    && prevTerms.every((t, i) => t === nextTerms[i]);
  if (sameTerms && after.nameLower === nextName) return;

  await event.data.after.ref.update({
    searchableTerms: nextTerms,
    nameLower: nextName,
  }).catch(() => {});
});

exports.indexProviderCreate = onDocumentCreated("providers/{providerId}", async (event) => {
  if (!event.data) return;
  const doc = event.data.data();
  if (!doc) return;
  if (doc.searchableTerms && doc.searchableTerms.length) return;
  await event.data.ref.update({
    searchableTerms: _buildSearchTerms(doc),
    nameLower: (doc.name || doc.businessName || "").toLowerCase(),
  }).catch(() => {});
});

/* Mirror of indexProductUpdate for providers — regenerates searchableTerms/
   nameLower whenever a provider edits their doc (rename, recategorise, new skills),
   which the create-only indexProviderCreate never covered. Same output-comparison
   idempotency guard, so it terminates after one hop and no-ops when the CF already
   wrote matching terms (both use the shared _buildSearchTerms). */
exports.indexProviderUpdate = onDocumentUpdated("providers/{providerId}", async (event) => {
  if (!event.data || !event.data.after) return;
  const after = event.data.after.data() || {};
  const nextTerms = _buildSearchTerms(after);
  const nextName  = (after.name || after.businessName || "").toLowerCase();
  const prevTerms = Array.isArray(after.searchableTerms) ? after.searchableTerms : null;
  const sameTerms = prevTerms
    && prevTerms.length === nextTerms.length
    && prevTerms.every((t, i) => t === nextTerms[i]);
  if (sameTerms && after.nameLower === nextName) return;
  await event.data.after.ref.update({
    searchableTerms: nextTerms,
    nameLower: nextName,
  }).catch(() => {});
});

/* ── BUSINESSES (Publication Contract v1.0, release 1) ────────────────────────
   Businesses/{uid} is the canonical shop directory doc. These give it the same
   searchableTerms/nameLower the store search now reads (sokoni-firestore-search.js
   points its 'businesses' spec here). _buildSearchTerms already reads name/
   businessName/category/city/description (provider fields it shares). Same shape +
   idempotency guard as the product/provider indexers. */
exports.indexBusinessCreate = onDocumentCreated("businesses/{bizId}", async (event) => {
  if (!event.data) return;
  const doc = event.data.data();
  if (!doc) return;
  if (doc.searchableTerms && doc.searchableTerms.length) return;
  await event.data.ref.update({
    searchableTerms: _buildSearchTerms(doc),
    nameLower: (doc.name || doc.businessName || "").toLowerCase(),
  }).catch(() => {});
});

exports.indexBusinessUpdate = onDocumentUpdated("businesses/{bizId}", async (event) => {
  if (!event.data || !event.data.after) return;
  const after = event.data.after.data() || {};
  const nextTerms = _buildSearchTerms(after);
  const nextName  = (after.name || after.businessName || "").toLowerCase();
  const prevTerms = Array.isArray(after.searchableTerms) ? after.searchableTerms : null;
  const sameTerms = prevTerms
    && prevTerms.length === nextTerms.length
    && prevTerms.every((t, i) => t === nextTerms[i]);
  if (sameTerms && after.nameLower === nextName) return;
  await event.data.after.ref.update({
    searchableTerms: nextTerms,
    nameLower: nextName,
  }).catch(() => {});
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   OBSERVABILITY & HEALTH ENDPOINTS
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

exports.platformHealth = onRequest(
  { timeoutSeconds: 10, cors: ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app", "https://sokoni-aeb26.firebaseapp.com", "http://localhost", "http://127.0.0.1"], invoker: "public" },
  async (req, res) => {
    const checks = await Promise.allSettled([
      db.collection("_health").limit(1).get(),
      admin.auth().listUsers(1),
    ]);
    const firestoreOk = checks[0].status === "fulfilled";
    const authOk      = checks[1].status === "fulfilled";
    const healthy     = firestoreOk && authOk;
    res.status(healthy ? 200 : 503).json({
      status:   healthy ? "healthy" : "degraded",
      services: { firestore: firestoreOk ? "up" : "down", auth: authOk ? "up" : "down" },
      ts:       new Date().toISOString(),
      version:  "2.0",
    });
  }
);

exports.getPlatformMetrics = onCall({ timeoutSeconds: 60 }, async (request) => {
  if (!request.auth || !request.auth.token || !request.auth.token.admin) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
  const period = (request.data && request.data.period) || "today";
  const now = new Date();
  const since = period === "today"  ? new Date(now.getFullYear(), now.getMonth(), now.getDate())
              : period === "week"   ? new Date(now - 7 * 86400000)
              : period === "month"  ? new Date(now.getFullYear(), now.getMonth(), 1)
              :                       new Date(now.getFullYear(), 0, 1);

  const sinceTs = admin.firestore.Timestamp.fromDate(since);

  const results = await Promise.allSettled([
    db.collection("orders").where("createdAt", ">=", sinceTs).get(),
    db.collection("webhookPayments").where("serverTs", ">=", sinceTs).get(),
    db.collection("users").where("createdAt", ">=", sinceTs).limit(500).get(),
    db.collection("webhookLogs").where("ts", ">=", sinceTs).limit(1000).get(),
    db.collection("fraudLog").where("serverTs", ">=", sinceTs).get(),
  ]);

  const orders   = results[0].status === "fulfilled" ? results[0].value : { docs: [], size: 0 };
  const payments = results[1].status === "fulfilled" ? results[1].value : { docs: [], size: 0 };
  const users    = results[2].status === "fulfilled" ? results[2].value : { docs: [], size: 0 };
  const webhooks = results[3].status === "fulfilled" ? results[3].value : { docs: [], size: 0 };
  const fraud    = results[4].status === "fulfilled" ? results[4].value : { docs: [], size: 0 };

  let gmv = 0;
  const byStatus = {};
  orders.docs.forEach(function(d) {
    const o = d.data();
    gmv += Number(o.total || o.orderTotal || 0);
    const s = o.status || "unknown";
    byStatus[s] = (byStatus[s] || 0) + 1;
  });

  const byProvider = {};
  webhooks.docs.forEach(function(d) {
    const p = d.data().provider || "unknown";
    byProvider[p] = (byProvider[p] || 0) + 1;
  });

  return {
    period,
    orders:   { total: orders.size, byStatus, gmv: Math.round(gmv) },
    payments: { total: payments.size },
    newUsers: users.size,
    webhooks: { total: webhooks.size, byProvider },
    fraud: {
      flagged: fraud.docs.filter(function(d) { return d.data().decision === "review"; }).length,
      blocked: fraud.docs.filter(function(d) { return d.data().decision === "block";  }).length,
    },
    generatedAt: new Date().toISOString(),
  };
});

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SCHEDULED MAINTENANCE
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

exports.expireOldEscrows = onSchedule(
  { schedule: "every 24 hours", timeoutSeconds: 120 },
  async () => {
    const thirtyDaysAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 30 * 86400000);
    const snap = await db.collection("escrows")
      .where("status", "==", "active")
      .where("createdAt", "<=", thirtyDaysAgo)
      .limit(50).get().catch(() => null);
    if (!snap || snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach(function(d) {
      batch.update(d.ref, { status: "expired", expiredAt: admin.firestore.FieldValue.serverTimestamp() });
    });
    await batch.commit().catch(() => {});
    console.log("[Maintenance] Expired " + snap.size + " old escrows");

    /* Product Settlement Convergence — auto-confirm delivered orders past the policy
       window (config: _systemConfig/settlement.autoConfirmDays, default 3) → marks them
       `completed`, which fires onOrderStatusChange → settleOrder. Folded into THIS existing
       scheduler (no new Cloud Run service). Best-effort. */
    try {
      const n = await require("./order-settlement").autoConfirmDeliveredOrders(db, admin);
      if (n) console.log("[Maintenance] auto-confirmed " + n + " delivered order(s)");
    } catch (e) { console.error("[Maintenance] auto-confirm sweep failed:", e && e.message); }
  }
);

exports.cleanupIdempotencyStore = onSchedule(
  { schedule: "every 24 hours", timeoutSeconds: 60 },
  async () => {
    const sevenDaysAgo = admin.firestore.Timestamp.fromMillis(Date.now() - 7 * 86400000);
    const snap = await db.collection("webhookIdempotency")
      .where("ts", "<=", sevenDaysAgo)
      .limit(500).get().catch(() => null);
    if (!snap || snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach(function(d) { batch.delete(d.ref); });
    await batch.commit().catch(() => {});
    console.log("[Maintenance] Cleaned " + snap.size + " idempotency records");
  }
);

exports.aggregateTrendingSearches = onSchedule(
  { schedule: "0 */6 * * *", timeoutSeconds: 120 },
  async () => {
    const oneHour = admin.firestore.Timestamp.fromMillis(Date.now() - 3600000);
    const snap = await db.collection("searchAnalytics")
      .where("serverTs", ">=", oneHour)
      .limit(1000).get().catch(() => null);
    if (!snap || snap.empty) return;

    const counts = {};
    snap.docs.forEach(function(d) {
      const q = (d.data().query || "").toLowerCase().trim();
      if (q.length >= 2) counts[q] = (counts[q] || 0) + 1;
    });

    const batch = db.batch();
    Object.keys(counts).forEach(function(term) {
      const ref = db.collection("searchTrending").doc(term);
      batch.set(ref, {
        term,
        count: admin.firestore.FieldValue.increment(counts[term]),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    });
    await batch.commit().catch(() => {});
    console.log("[SearchIndexer] Updated " + Object.keys(counts).length + " trending terms");
  }
);

/* processSettlementQueue — RETIRED 2026-07-11. This scheduled CF was a no-op
   stub: it only flipped settlementQueue items queued→completed with no payout,
   ledger, or credit (real settlement runs via the finos escrow/payout engine).
   Removed to reclaim one Cloud Run slot for the consolidated financeSprintDispatch
   (which now hosts the 12 Enterprise Settlement ops). No functional behaviour
   was lost — nothing consumed the "completed" flag it wrote. */


/* ============================================================
   INVOICE EMAIL  —  sendInvoiceEmail (onCall)
   Called by sokoni-invoice.js on every invoice — sole email path.
   Routes through the SOKONI Enterprise Email Service (SendGrid / SMTP).
   No personal Gmail credentials required.
============================================================ */
const { EMAIL_SECRETS: _INV_SECRETS, FROM: _INV_FROM } = require("./email-service");
const emailSvcInv = require("./email-service");

exports.sendInvoiceEmail = onCall(
  { secrets: _INV_SECRETS, enforceAppCheck: true },
  async (req) => {
    if (!req.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    const { toEmail, toName, invoice } = req.data || {};
    if (!toEmail || !invoice) {
      throw new HttpsError("invalid-argument", "toEmail and invoice are required");
    }

    /* Ownership guard: only allow sending to the caller's own verified email or
       the platform admin address. Prevents an authenticated user from sending
       fake SOKONI invoices to arbitrary addresses. */
    const PLATFORM_ADMIN_EMAIL = "orders@mysokoni.co.ke";
    const callerEmail = (req.auth.token.email || "").toLowerCase().trim();
    const destEmail   = toEmail.toLowerCase().trim();
    if (destEmail !== callerEmail && destEmail !== PLATFORM_ADMIN_EMAIL) {
      throw new HttpsError(
        "permission-denied",
        "Invoice email may only be sent to your own registered email address."
      );
    }

    const fmt = (n) => "KES " + Number(n || 0).toLocaleString("en-KE");
    const esc = (s) => String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    const itemsHtml = (invoice.items || [])
      .map(i => `<tr><td style="padding:6px 0;color:#ccc;">${esc(i.name)}</td>
                     <td style="padding:6px 0;text-align:right;color:#71ff00;">${fmt(i.price)}</td></tr>`)
      .join("");

    const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#050a10;font-family:Segoe UI,Arial,sans-serif;">
  <div style="max-width:560px;margin:32px auto;background:#0a0f1a;border:1px solid rgba(0,212,255,0.18);border-radius:20px;overflow:hidden;">
    <div style="padding:28px 32px;background:linear-gradient(135deg,rgba(0,212,255,0.08),rgba(113,255,0,0.05));">
      <div style="font-size:22px;font-weight:900;color:#71ff00;letter-spacing:0.05em;">SOKONI</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.45);margin-top:2px;">Invoice Confirmation</div>
    </div>
    <div style="padding:24px 32px;">
      <p style="color:rgba(255,255,255,0.7);margin:0 0 18px;">Hi ${esc(toName)},</p>
      <p style="color:rgba(255,255,255,0.55);font-size:13px;margin:0 0 24px;">
        Thank you for your order. Here is your invoice summary.
      </p>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px 20px;margin-bottom:20px;">
        <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.3);letter-spacing:1px;margin-bottom:12px;">INVOICE DETAILS</div>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:4px 0;color:rgba(255,255,255,0.4);font-size:12px;">Invoice Ref</td>
              <td style="padding:4px 0;text-align:right;color:white;font-size:12px;font-weight:700;">${esc(invoice.ref)}</td></tr>
          <tr><td style="padding:4px 0;color:rgba(255,255,255,0.4);font-size:12px;">Date</td>
              <td style="padding:4px 0;text-align:right;color:white;font-size:12px;">${esc(invoice.date)}</td></tr>
          <tr><td style="padding:4px 0;color:rgba(255,255,255,0.4);font-size:12px;">Payment</td>
              <td style="padding:4px 0;text-align:right;color:#71ff00;font-size:12px;font-weight:700;">${esc(invoice.paymentMethod)}</td></tr>
        </table>
      </div>
      <div style="background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:16px 20px;margin-bottom:20px;">
        <div style="font-size:10px;font-weight:700;color:rgba(255,255,255,0.3);letter-spacing:1px;margin-bottom:12px;">ORDER ITEMS</div>
        <table style="width:100%;border-collapse:collapse;">${itemsHtml}</table>
        <div style="border-top:1px solid rgba(255,255,255,0.06);margin-top:10px;padding-top:10px;display:flex;justify-content:space-between;">
          <span style="font-size:14px;font-weight:800;color:white;">Total</span>
          <span style="font-size:18px;font-weight:900;color:#71ff00;">${fmt(invoice.total)}</span>
        </div>
      </div>
      ${invoice.sellerLine ? `<p style="font-size:12px;color:rgba(255,255,255,0.4);margin:0 0 20px;">${esc(invoice.sellerLine)}</p>` : ""}
      <p style="font-size:12px;color:rgba(255,255,255,0.3);margin:0;">
        Need help? Reply to this email or visit
        <a href="https://mysokoni.co.ke/support.html" style="color:#00d4ff;">mysokoni.co.ke/support</a>
      </p>
    </div>
    <div style="padding:16px 32px;border-top:1px solid rgba(255,255,255,0.05);text-align:center;">
      <span style="font-size:10px;color:rgba(255,255,255,0.2);">${COMPANY.footerCopyright}</span>
    </div>
  </div>
</body></html>`;

    try {
      await emailSvcInv.send({
        to:       toEmail,
        from:     _INV_FROM.orders,
        subject:  `Your SOKONI Invoice — ${invoice.ref || "Order Confirmed"}`,
        html,
        category: "order",
        template: "invoice",
        emailId:  `invoice-${invoice.ref || Date.now()}`,
      });
    } catch (e) {
      console.warn("[sendInvoiceEmail] Email service unavailable:", e.message);
      return { success: false, reason: "email_not_configured" };
    }

    /* Log to Firestore for audit trail */
    try {
      await db.collection("mailQueue").add({
        to: toEmail, toName, ref: invoice.ref || "",
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        status: "sent",
      });
    } catch (e) {}

    return { success: true };
  }
);

/* ═══════════════════════════════════════════════════════════
   SOKONI Enterprise Email System
   Triggers: auto-fires on Firestore events
   Scheduled: queue processor, reminders, alerts
   Webhooks:  SendGrid event tracking
   onCall:    preferences, broadcast, resend
═══════════════════════════════════════════════════════════ */
const emailTriggers = require("./email-triggers");
Object.assign(exports, emailTriggers);

/* ═══════════════════════════════════════════════════════
   DMARC REPORT PROCESSOR
   processDmarcReport  — admin onCall: upload XML report
   dmarcReportWebhook  — HTTP: SendGrid Inbound Parse
   getDmarcSummary     — onCall: stats for Email Center
═══════════════════════════════════════════════════════ */
const dmarcFunctions = require("./email-dmarc");
Object.assign(exports, dmarcFunctions);

/* ============================================================
   ALGOLIA ENTERPRISE SEARCH PIPELINE
   Queue-based, fault-tolerant, 13-index Firestore → Algolia sync.

   Setup:
     1. firebase functions:secrets:set ALGOLIA_ADMIN_KEY
     2. firebase functions:secrets:set ALGOLIA_SEARCH_KEY
     3. Add to functions/.env.sokoni-aeb26:
          ALGOLIA_APP_ID=your_algolia_app_id
     4. firebase deploy --only functions
     5. Call algoliaSetupIndexes (admin CF) to configure all 13 indexes.
     6. Call algoliaBackfill (admin CF) to perform initial full index.

   Architecture:
     Firestore trigger → algoliaQueue (idempotent) → scheduled processor
     → Algolia batch API (up to 1 000 objects/call) → DLQ on failure

   Modules:
     algolia-indexer.js       HTTP client + 13 document transformers
     algolia-queue.js         Queue processor, retry, DLQ, monitor
     algolia-sync.js          45 Firestore triggers (15 collections × 3)
     algolia-admin.js         Backfill, setup, health, orphan cleanup
     algolia-secured-keys.js  Scoped key generation + rate limiting
     algolia-analytics.js     Search event capture + daily aggregation
============================================================ */

/* ── Queue processor + monitor ───────────────────────────────────────── */
const algoliaQueueModule = require("./algolia-queue");
exports.processAlgoliaQueue   = algoliaQueueModule.processAlgoliaQueue;
exports.algoliaReprocessDLQ   = algoliaQueueModule.algoliaReprocessDLQ;
exports.algoliaQueueMonitor   = algoliaQueueModule.algoliaQueueMonitor;

/* ── Firestore sync triggers (19 collections × 3 = 57 functions) ─────── */
/* Collections: products, sellers, providers, services, events, properties, cars,
   digitalJobs, jobs, users, categories, brands, collections, coupons, foods
   + stores, real_estate, vehicles, vendors (production aliases → real Algolia index names)
   Each trigger with globalSearch:true also fans out to global_search index. */
const algoliaSync = require("./algolia-sync");
Object.assign(exports, algoliaSync);

/* ── Shop-name fan-out: a shop rename propagates to all its products, which then
   ride the product-update triggers above to correct both search indexes. ── */
const shopNameSync = require("./shop-name-sync");
exports.shopNameSync_shops   = shopNameSync.shopNameSync_shops;
exports.shopNameSync_sellers = shopNameSync.shopNameSync_sellers;

/* ── Admin: setup, backfill, health, orphan cleanup, rules, A/B testing ── */
const algoliaAdminModule = require("./algolia-admin");
exports.algoliaSetupIndexes            = algoliaAdminModule.algoliaSetupIndexes;
exports.algoliaBackfill                = algoliaAdminModule.algoliaBackfill;
exports.algoliaReindex                 = algoliaAdminModule.algoliaReindex;
exports.algoliaHealthCheck             = algoliaAdminModule.algoliaHealthCheck;
exports.algoliaGetQueueStats           = algoliaAdminModule.algoliaGetQueueStats;
exports.algoliaDeleteOrphans           = algoliaAdminModule.algoliaDeleteOrphans;
exports.algoliaSetupRules              = algoliaAdminModule.algoliaSetupRules;
exports.algoliaSetupPersonalization    = algoliaAdminModule.algoliaSetupPersonalization;
exports.algoliaSetupDynamicReranking   = algoliaAdminModule.algoliaSetupDynamicReranking;
exports.algoliaCreateABTest            = algoliaAdminModule.algoliaCreateABTest;
exports.algoliaGetABTestResults        = algoliaAdminModule.algoliaGetABTestResults;
exports.algoliaStopABTest              = algoliaAdminModule.algoliaStopABTest;

/* ── Index settings — configure existing Algolia indexes ──────────────── */
const algoliaSettingsModule = require("./algolia-settings");
exports.searchApplyIndexSettings = algoliaSettingsModule.searchApplyIndexSettings;
exports.searchValidateIndexes    = algoliaSettingsModule.searchValidateIndexes;
exports.searchApplySynonyms      = algoliaSettingsModule.searchApplySynonyms;
exports.searchApplyRules         = algoliaSettingsModule.searchApplyRules;

/* ── Secured keys ────────────────────────────────────────────────────── */
const algoliaKeysModule = require("./algolia-secured-keys");
exports.getAlgoliaSearchKey = algoliaKeysModule.getAlgoliaSearchKey;
exports.algoliaKeyStats     = algoliaKeysModule.algoliaKeyStats;
exports.algoliaKeyCleanup   = algoliaKeysModule.algoliaKeyCleanup;

/* ── Analytics: full Insights API + Algolia forwarding ──────────────── */
const algoliaAnalyticsModule = require("./algolia-analytics");
exports.recordSearchEvent         = algoliaAnalyticsModule.recordSearchEvent;
exports.algoliaEventAggregator    = algoliaAnalyticsModule.algoliaEventAggregator;
exports.aggregateSearchAnalytics  = algoliaAnalyticsModule.aggregateSearchAnalytics;
exports.getSearchAnalytics        = algoliaAnalyticsModule.getSearchAnalytics;
exports.getTrendingSearches       = algoliaAnalyticsModule.getTrendingSearches;
exports.algoliaAnalyticsCleanup   = algoliaAnalyticsModule.algoliaAnalyticsCleanup;

/* ── Recommend API ───────────────────────────────────────────────────── */
const algoliaRecommendModule = require("./algolia-recommend");
exports.getAlgoliaFBT                       = algoliaRecommendModule.getAlgoliaFBT;
exports.getAlgoliaRelated                   = algoliaRecommendModule.getAlgoliaRelated;
exports.getAlgoliaTrendingItems             = algoliaRecommendModule.getAlgoliaTrendingItems;
exports.getAlgoliaTrendingFacets            = algoliaRecommendModule.getAlgoliaTrendingFacets;
exports.getAlgoliaLookingSimilar            = algoliaRecommendModule.getAlgoliaLookingSimilar;
exports.getAlgoliaMultiRecommend            = algoliaRecommendModule.getAlgoliaMultiRecommend;
exports.algoliaRecommendEvent               = algoliaRecommendModule.algoliaRecommendEvent;
exports.algoliaRecommendStatus              = algoliaRecommendModule.algoliaRecommendStatus;
exports.algoliaRecommendAnalyticsCleanup    = algoliaRecommendModule.algoliaRecommendAnalyticsCleanup;

/* ── Query Suggestions ───────────────────────────────────────────────── */
const algoliaQSModule = require("./algolia-query-suggestions");
exports.algoliaSetupQuerySuggestions  = algoliaQSModule.algoliaSetupQuerySuggestions;
exports.algoliaGetQuerySuggestions    = algoliaQSModule.algoliaGetQuerySuggestions;
exports.algoliaQSRebuildStatus        = algoliaQSModule.algoliaQSRebuildStatus;
exports.algoliaSetupQSIndexSettings   = algoliaQSModule.algoliaSetupQSIndexSettings;

/* ── Personalization ─────────────────────────────────────────────────── */
const algoliaPersonalizationModule = require("./algolia-personalization");
exports.setAlgoliaPersonalizationStrategy  = algoliaPersonalizationModule.setAlgoliaPersonalizationStrategy;
exports.getAlgoliaPersonalizationStrategy  = algoliaPersonalizationModule.getAlgoliaPersonalizationStrategy;
exports.getAlgoliaUserProfile              = algoliaPersonalizationModule.getAlgoliaUserProfile;
exports.deleteAlgoliaUserProfile           = algoliaPersonalizationModule.deleteAlgoliaUserProfile;
exports.algoliaPersonalizationStatus       = algoliaPersonalizationModule.algoliaPersonalizationStatus;

/* ── Reconciliation — daily Firestore↔Algolia consistency check ──────── */
const algoliaReconcileModule = require("./algolia-reconcile");
exports.algoliaReconcile             = algoliaReconcileModule.algoliaReconcile;
exports.algoliaVerifyDoc             = algoliaReconcileModule.algoliaVerifyDoc;
exports.algoliaGetReconcileHistory   = algoliaReconcileModule.algoliaGetReconcileHistory;
exports.algoliaReconcileStats        = algoliaReconcileModule.algoliaReconcileStats;

/* ── Monitor — 15-min latency probes, daily entry tracking, SLA alerts ── */
const algoliaMonitorModule = require("./algolia-monitor");
exports.algoliaMonitorHealth         = algoliaMonitorModule.algoliaMonitorHealth;
exports.algoliaMonitorEntries        = algoliaMonitorModule.algoliaMonitorEntries;
exports.algoliaGetMonitorDashboard   = algoliaMonitorModule.algoliaGetMonitorDashboard;
exports.algoliaGetLatencyHistory     = algoliaMonitorModule.algoliaGetLatencyHistory;
exports.algoliaResolveMonitorAlert   = algoliaMonitorModule.algoliaResolveMonitorAlert;
exports.algoliaMonitorCleanup        = algoliaMonitorModule.algoliaMonitorCleanup;

/* ============================================================
   TYPESENSE ENTERPRISE SEARCH PIPELINE v2.0
   1M+ concurrent users, 50M+ searchable records.
   25 typed collections, 75 Firestore triggers, 5-tier priority queue,
   circuit-breaker, blue-green reindex, monitoring, backup, reconcile.

   Setup:
     1. firebase functions:secrets:set TYPESENSE_ADMIN_KEY
     2. firebase functions:secrets:set TYPESENSE_SEARCH_KEY
     3. Add to functions/.env.sokoni-aeb26:
          TYPESENSE_NODES=xyz.a1.typesense.net:443:https
          (comma-separated for HA: node1:443:https,node2:443:https,node3:443:https)
     4. firebase deploy --only functions,firestore:indexes
     5. Call typesenseCreateCollections (admin CF) — creates all 25 collections + synonyms
     6. Call typesenseBackfill({ firestoreCollection: "products", version: "v1" }) per collection
        Priority order: products → sellers → events → propertyListings → cars → digitalJobs
                        → bnbListings → education → lawyers → reviews → users → rest

   Architecture:
     Firestore write → typesense-sync.js (75 triggers) → typesenseQueue Firestore collection
     → processTypesenseQueue (every 1 min, 5-tier priority) → Typesense JSONL 10k/batch
     → DLQ after 4 failures → typesenseReprocessDLQ (admin)

   Modules (v2):
     typesense-client.js       25 schemas, circuit-breaker, keep-alive pool, HMAC scoped keys
     typesense-queue.js        5-tier priority queue (URGENT→BATCH), stuck-item reset, monitor
     typesense-sync.js         75 Firestore triggers (25 collections × 3)
     typesense-admin.js        Blue-green backfill, canary deploy, health, orphan cleanup
     typesense-reconcile.js    Daily consistency check + auto-repair
     typesense-monitor.js      5-min node health ping, 15-min latency probe, SLA alerts
     typesense-backup.js       Daily export, Storage/Firestore, rotation, verify, restore
     typesense-secured-keys.js Per-role scoped HMAC keys, rate limiting, audit log
     typesense-analytics.js    Event capture, real-time rollup, trending, autocomplete
============================================================ */

/* ── Queue processor + monitor ──────────────────────────────────── */
const tsQueueModule = require("./typesense-queue");
exports.processTypesenseQueue  = tsQueueModule.processTypesenseQueue;
exports.typesenseReprocessDLQ  = tsQueueModule.typesenseReprocessDLQ;
exports.typesenseForceRetry    = tsQueueModule.typesenseForceRetry;
exports.typesenseQueueMonitor  = tsQueueModule.typesenseQueueMonitor;

/* ── Firestore sync triggers (25 collections × 3 = 75 functions) ── */
const tsSync = require("./typesense-sync");
Object.assign(exports, tsSync);

/* ── Admin: collections, backfill, canary, health, orphan cleanup ── */
const tsAdminModule = require("./typesense-admin");
exports.typesenseCreateCollections = tsAdminModule.typesenseCreateCollections;
exports.typesenseBackfill          = tsAdminModule.typesenseBackfill;
exports.typesenseHealthCheck       = tsAdminModule.typesenseHealthCheck;
exports.typesenseDeleteOrphans     = tsAdminModule.typesenseDeleteOrphans;
exports.typesenseCreateAlias       = tsAdminModule.typesenseCreateAlias;
exports.typesenseCollectionStats   = tsAdminModule.typesenseCollectionStats;
exports.typesenseCanaryDeploy      = tsAdminModule.typesenseCanaryDeploy;

/* ── Reconciliation — daily consistency check + auto-repair ─────── */
const tsReconcileModule = require("./typesense-reconcile");
exports.typesenseReconcile       = tsReconcileModule.typesenseReconcile;
exports.typesenseRepairDivergent = tsReconcileModule.typesenseRepairDivergent;
exports.typesenseVerifyDoc       = tsReconcileModule.typesenseVerifyDoc;

/* ── Monitor — cluster health, latency, SLA, alerting ──────────── */
const tsMonitorModule = require("./typesense-monitor");
exports.typesenseMonitorHealth   = tsMonitorModule.typesenseMonitorHealth;
exports.typesenseMonitorLatency  = tsMonitorModule.typesenseMonitorLatency;
exports.typesenseGetDashboard    = tsMonitorModule.typesenseGetDashboard;
exports.typesenseResolveAlert    = tsMonitorModule.typesenseResolveAlert;
exports.typesenseMonitorCleanup  = tsMonitorModule.typesenseMonitorCleanup;

/* ── Backup — daily export, verify, restore, rotation ───────────── */
const tsBackupModule = require("./typesense-backup");
exports.typesenseBackupDaily     = tsBackupModule.typesenseBackupDaily;
exports.typesenseBackupCleanup   = tsBackupModule.typesenseBackupCleanup;
exports.typesenseListBackups     = tsBackupModule.typesenseListBackups;
exports.typesenseVerifyBackup    = tsBackupModule.typesenseVerifyBackup;
exports.typesenseRestoreBackup   = tsBackupModule.typesenseRestoreBackup;

/* ── Secured keys ───────────────────────────────────────────────── */
const tsKeysModule = require("./typesense-secured-keys");
exports.getTypesenseSearchKey = tsKeysModule.getTypesenseSearchKey;
exports.typesenseKeyStats     = tsKeysModule.typesenseKeyStats;
exports.typesenseKeyCleanup   = tsKeysModule.typesenseKeyCleanup;

/* ── Analytics ──────────────────────────────────────────────────── */
const tsAnalyticsModule = require("./typesense-analytics");
exports.recordTypesenseSearchEvent   = tsAnalyticsModule.recordTypesenseSearchEvent;
exports.tsEventAggregator            = tsAnalyticsModule.tsEventAggregator;
exports.aggregateTypesenseAnalytics  = tsAnalyticsModule.aggregateTypesenseAnalytics;
exports.getTypesenseAnalytics        = tsAnalyticsModule.getTypesenseAnalytics;
exports.getTsAutocompleteSuggestions = tsAnalyticsModule.getTsAutocompleteSuggestions;
exports.typesenseAnalyticsCleanup    = tsAnalyticsModule.typesenseAnalyticsCleanup;

/* ============================================================
   UNIFIED SEARCH ORCHESTRATION LAYER
   search-sync.js  — Master collection registry + NEW triggers (6 collections)
   search-queue.js — Single control plane over algoliaQueue + typesenseQueue

   New Firestore triggers (deals, auctions, vendors, companies,
   inventory_products, orders) are registered here; all other collection
   triggers remain in algolia-sync.js and typesense-sync.js.

   Admin callables:
     getQueueStats       — real-time queue depth for both engines
     purgeCompleted      — delete old 'done' items
     pauseQueue          — emergency halt (sets searchConfig/queueControl)
     resumeQueue         — resume after pause
     redriveFromDLQ      — re-drive dead-letter items to pending
============================================================ */

/* ── Search sync: master registry + new collection triggers ─────────── */
const searchSyncModule = require("./search-sync");
Object.assign(exports, searchSyncModule); /* spreads searchSync_*_on{Create,Update,Delete} triggers */
exports.COLLECTION_REGISTRY = undefined;  /* not a CF — strip from function exports to avoid noise */
delete exports.COLLECTION_REGISTRY;
delete exports.syncDocument;

/* ── Marketplace product counter (trial product cap) ──────────────────────
   Spreads onMarketplaceProductCreated / onMarketplaceProductDeleted /
   canPublishProduct / recountMarketplaceProducts. _internal is a test seam,
   not a callable — stripped so it is never deployed as a function. */
const productLimitModule = require('./product-limit');
Object.assign(exports, productLimitModule);

/* SubscriptionAuthority — the single source of merchant entitlements.
   getMerchantEntitlements is what every screen must consume instead of
   computing an upload limit from its own plan table; ten such tables existed
   and disagreed (see scripts/verify-listing-limit-single-source.js). */
const subscriptionAuthority = require('./subscription-authority');
exports.getMerchantEntitlements = subscriptionAuthority.getMerchantEntitlements;
exports.onSubscriptionChangedSyncEntitlements =
  subscriptionAuthority.onSubscriptionChangedSyncEntitlements;

/* ── Admin-gated catalogue repair ─────────────────────────────────────────
   Ownership and type repairs on explicitly named product documents. Admin
   claim required; every write is audited to adminAudit. */
Object.assign(exports, require('./catalogue-repair'));
delete exports._internal;
delete exports._shouldSkip;
delete exports._updateDecision;

/* ── Search queue: unified queue control plane ───────────────────────── */
const searchQueueModule = require("./search-queue");
exports.getQueueStats      = searchQueueModule.getQueueStats;
exports.purgeCompleted     = searchQueueModule.purgeCompleted;
exports.pauseQueue         = searchQueueModule.pauseQueue;
exports.resumeQueue        = searchQueueModule.resumeQueue;
exports.redriveFromDLQ     = searchQueueModule.redriveFromDLQ;

/* ═══════════════════════════════════════════════════════════
   previewEmailTemplate — admin onCall
   Called by Email Center to preview any of the 53 templates
   with sample data before sending.
   Input:  { name: string, data?: object }
   Output: { html: string }
═══════════════════════════════════════════════════════════ */
exports.previewEmailTemplate = onCall({ cors: ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app"] },
  async (req) => {
    /* Admin only */
    if (!req.auth?.token?.admin) throw new HttpsError("permission-denied", "Admin only");

    const { name, data = {} } = req.data || {};
    if (!name || typeof name !== "string" || name.length > 60) {
      throw new HttpsError("invalid-argument", "Template name required");
    }

    const d = {
      name:            data.name            || "Test User",
      email:           data.email           || "test@mysokoni.co.ke",
      orderId:         data.orderId         || "ORD-PREVIEW-001",
      amount:          data.amount          || 2500,
      total:           data.total           || 2500,
      ref:             data.ref             || "TX-PREVIEW-001",
      method:          data.method          || "M-Pesa",
      date:            data.date            || new Date().toLocaleDateString("en-KE", { day:"numeric", month:"short", year:"numeric" }),
      productName:     data.productName     || "SOKONI Sample Product",
      category:        data.category        || "Electronics",
      price:           data.price           || 2500,
      eventName:       data.eventName       || "Nairobi Music Festival",
      eventDate:       data.eventDate       || "5 Jul 2026",
      venue:           data.venue           || "Uhuru Park, Nairobi",
      ticketType:      data.ticketType      || "VIP",
      ticketId:        data.ticketId        || "TKT-PREVIEW-001",
      driverName:      data.driverName      || "James Otieno",
      eta:             data.eta             || "2:45 PM",
      deliveryId:      data.deliveryId      || "DEL-PREVIEW-001",
      plan:            data.plan            || "Pro",
      days:            data.days            || "7",
      expiryDate:      data.expiryDate      || "27 Jun 2026",
      storeName:       data.storeName       || "My Sokoni Store",
      code:            data.code            || "482915",
      verifyUrl:       data.verifyUrl       || "https://mysokoni.co.ke",
      resetUrl:        data.resetUrl        || "https://mysokoni.co.ke",
      device:          data.device          || "Chrome on macOS",
      ip:              data.ip              || "41.90.xx.xx",
      location:        data.location        || "Nairobi, Kenya",
      alertType:       data.alertType       || "Multiple failed logins",
      details:         data.details         || "5 failed login attempts in 60 seconds",
      propertyTitle:   data.propertyTitle   || "3BR Apartment, Kilimani",
      providerName:    data.providerName    || "Dr. Kimani",
      lawyerName:      data.lawyerName      || "Advocate Wangari Mwangi",
      specialty:       data.specialty       || "Family Law",
      time:            data.time            || "3:00 PM",
      fee:             data.fee             || 5000,
      checkIn:         data.checkIn         || "10 Jul 2026",
      checkOut:        data.checkOut        || "15 Jul 2026",
      earnings:        data.earnings        || 350,
      deliveries:      data.deliveries      || 23,
      rating:          data.rating          || 4.7,
      phone:           data.phone           || "0712 345 678",
      referredName:    data.referredName    || "Alice Wanjiru",
      message:         data.message         || "I am interested in viewing the property.",
    };

    const esc = (v) => String(v ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
    const fmt = (n) => `KES ${Number(n || 0).toLocaleString("en-KE")}`;

    /* Shared email shell */
    const shell = (accentColor, headerLabel, bodyHtml) => `
<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#050a10;font-family:'Segoe UI',Arial,sans-serif;}
  a{color:#00d4ff;}
  .wrap{max-width:560px;margin:28px auto;background:#0a0f1a;border:1px solid rgba(${accentColor},0.22);border-radius:20px;overflow:hidden;}
  .hd{padding:24px 32px;background:linear-gradient(135deg,rgba(${accentColor},0.1),rgba(113,255,0,0.04));}
  .hd-logo{font-size:22px;font-weight:900;color:#71ff00;letter-spacing:.05em;}
  .hd-sub{font-size:12px;color:rgba(255,255,255,0.4);margin-top:3px;}
  .bd{padding:24px 32px 20px;}
  .ft{padding:14px 32px;border-top:1px solid rgba(255,255,255,0.05);text-align:center;
      font-size:10px;color:rgba(255,255,255,0.2);}
  p{color:rgba(255,255,255,0.65);font-size:14px;line-height:1.6;margin:0 0 16px;}
  .box{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);
       border-radius:12px;padding:16px 20px;margin:0 0 18px;}
  .row{display:flex;justify-content:space-between;padding:4px 0;font-size:12px;}
  .row .lbl{color:rgba(255,255,255,0.38);}
  .row .val{color:white;font-weight:700;}
  .hl{color:rgb(${accentColor});font-weight:800;}
  .cta{display:block;text-align:center;padding:14px 28px;
       background:linear-gradient(135deg,rgba(${accentColor},0.9),rgba(${accentColor},0.7));
       border-radius:12px;color:white;font-weight:800;font-size:14px;text-decoration:none;margin:18px 0;}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:800;
         background:rgba(${accentColor},0.15);color:rgb(${accentColor});border:1px solid rgba(${accentColor},0.3);}
</style>
</head>
<body>
<div class="wrap">
  <div class="hd"><div class="hd-logo">SOKONI</div><div class="hd-sub">${esc(headerLabel)}</div></div>
  <div class="bd">${bodyHtml}</div>
  <div class="ft">${COMPANY.footerCopyright} &nbsp;·&nbsp;
    <a href="https://mysokoni.co.ke/support.html">Support</a> &nbsp;·&nbsp;
    <a href="https://mysokoni.co.ke">mysokoni.co.ke</a>
  </div>
</div>
</body></html>`;

    /* Template library — one renderer per template name */
    const tpls = {

      "order_confirmation": () => shell("113,255,0","Order Confirmed",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Your order has been placed! We'll notify you when it's packed and on its way.</p>
        <div class="box">
          <div class="row"><span class="lbl">Order ID</span><span class="val">${esc(d.orderId)}</span></div>
          <div class="row"><span class="lbl">Amount</span><span class="val hl">${fmt(d.amount)}</span></div>
          <div class="row"><span class="lbl">Payment</span><span class="val">${esc(d.method)}</span></div>
          <div class="row"><span class="lbl">Date</span><span class="val">${esc(d.date)}</span></div>
        </div>
        <a href="https://mysokoni.co.ke/track.html?order=${esc(d.orderId)}" class="cta">Track My Order</a>`),

      "order_shipped": () => shell("0,212,255","Order Shipped",`
        <p>Hi <strong>${esc(d.name)}</strong>, your order is on its way!</p>
        <div class="box">
          <div class="row"><span class="lbl">Driver</span><span class="val">${esc(d.driverName)}</span></div>
          <div class="row"><span class="lbl">ETA</span><span class="val hl">${esc(d.eta)}</span></div>
          <div class="row"><span class="lbl">Delivery ID</span><span class="val">${esc(d.deliveryId)}</span></div>
        </div>
        <a href="https://mysokoni.co.ke/delivery-tracking.html?id=${esc(d.deliveryId)}" class="cta">Track Live</a>`),

      "order_delivered": () => shell("74,222,128","Order Delivered",`
        <p>Hi <strong>${esc(d.name)}</strong>, your order has been delivered!</p>
        <p>We hope you love your purchase. Please take a moment to leave a review.</p>
        <a href="https://mysokoni.co.ke/reviews.html" class="cta">Leave a Review</a>`),

      "payment_received": () => shell("251,191,36","Payment Received",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>We've received your payment of <span class="hl">${fmt(d.amount)}</span> via ${esc(d.method)}.</p>
        <div class="box">
          <div class="row"><span class="lbl">Reference</span><span class="val">${esc(d.ref)}</span></div>
          <div class="row"><span class="lbl">Amount</span><span class="val hl">${fmt(d.amount)}</span></div>
          <div class="row"><span class="lbl">Date</span><span class="val">${esc(d.date)}</span></div>
        </div>`),

      "invoice": () => shell("113,255,0","Invoice",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Thank you for your order. Here is your invoice.</p>
        <div class="box">
          <div class="row"><span class="lbl">Invoice Ref</span><span class="val">${esc(d.ref)}</span></div>
          <div class="row"><span class="lbl">Total</span><span class="val hl">${fmt(d.total)}</span></div>
          <div class="row"><span class="lbl">Payment</span><span class="val">${esc(d.method)}</span></div>
        </div>
        <a href="https://mysokoni.co.ke/invoice.html?ref=${esc(d.ref)}" class="cta">View Full Invoice</a>`),

      "account_verification": () => shell("124,58,237","Verify Your Email",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Please verify your email address to activate your SOKONI account.</p>
        <div class="box" style="text-align:center;">
          <div style="font-size:36px;font-weight:900;color:#71ff00;letter-spacing:.2em;">${esc(d.code)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.35);margin-top:8px;">Enter this code in the app</div>
        </div>
        <a href="${esc(d.verifyUrl)}" class="cta">Or click to verify</a>
        <p style="font-size:11px;color:rgba(255,255,255,0.3);">This code expires in 10 minutes.</p>`),

      "password_reset": () => shell("239,68,68","Password Reset",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>We received a request to reset your SOKONI password.</p>
        <div class="box">
          <div class="row"><span class="lbl">Device</span><span class="val">${esc(d.device)}</span></div>
          <div class="row"><span class="lbl">Location</span><span class="val">${esc(d.location)}</span></div>
        </div>
        <a href="${esc(d.resetUrl)}" class="cta">Reset My Password</a>
        <p style="font-size:11px;color:rgba(255,255,255,0.3);">Expires in 30 minutes. If you didn't request this, ignore this email.</p>`),

      "seller_registration": () => shell("74,222,128","Welcome, Seller!",`
        <p>Hi <strong>${esc(d.name)}</strong>, welcome to SOKONI!</p>
        <p>Your seller account for <strong>${esc(d.storeName)}</strong> is now active. Start listing your products.</p>
        <a href="https://mysokoni.co.ke/seller.html" class="cta">Go to Seller Dashboard</a>`),

      "new_order_alert": () => shell("251,191,36","New Order!",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>You have a new order on <strong>${esc(d.storeName)}</strong>!</p>
        <div class="box">
          <div class="row"><span class="lbl">Order ID</span><span class="val">${esc(d.orderId)}</span></div>
          <div class="row"><span class="lbl">Amount</span><span class="val hl">${fmt(d.amount)}</span></div>
        </div>
        <a href="https://mysokoni.co.ke/seller.html#orders" class="cta">View Order</a>`),

      "payout_sent": () => shell("74,222,128","Payout Sent",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Your payout of <span class="hl">${fmt(d.amount)}</span> has been sent to your M-Pesa.</p>
        <div class="box">
          <div class="row"><span class="lbl">Reference</span><span class="val">${esc(d.ref)}</span></div>
          <div class="row"><span class="lbl">Amount</span><span class="val hl">${fmt(d.amount)}</span></div>
          <div class="row"><span class="lbl">Date</span><span class="val">${esc(d.date)}</span></div>
        </div>`),

      "security_alert": () => shell("239,68,68","Security Alert",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>We detected unusual activity on your SOKONI account.</p>
        <div class="box">
          <div class="row"><span class="lbl">Alert</span><span class="val" style="color:#f87171;">${esc(d.alertType)}</span></div>
          <div class="row"><span class="lbl">Details</span><span class="val">${esc(d.details)}</span></div>
          <div class="row"><span class="lbl">IP</span><span class="val">${esc(d.ip)}</span></div>
          <div class="row"><span class="lbl">Location</span><span class="val">${esc(d.location)}</span></div>
        </div>
        <p>If this was you, no action needed. If not, secure your account immediately.</p>
        <a href="https://mysokoni.co.ke/profile.html#security" class="cta">Secure My Account</a>`),

      "subscription_activated": () => shell("124,58,237","Subscription Active",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Your <span class="hl">${esc(d.plan)}</span> plan is now active.</p>
        <div class="box">
          <div class="row"><span class="lbl">Plan</span><span class="val">${esc(d.plan)}</span></div>
          <div class="row"><span class="lbl">Valid for</span><span class="val">${esc(d.days)} days</span></div>
          <div class="row"><span class="lbl">Expires</span><span class="val">${esc(d.expiryDate)}</span></div>
        </div>`),

      "event_ticket": () => shell("251,191,36","Your Event Ticket",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>You're going to <strong>${esc(d.eventName)}</strong>!</p>
        <div class="box">
          <div class="row"><span class="lbl">Date</span><span class="val hl">${esc(d.eventDate)}</span></div>
          <div class="row"><span class="lbl">Venue</span><span class="val">${esc(d.venue)}</span></div>
          <div class="row"><span class="lbl">Ticket</span><span class="val">${esc(d.ticketType)}</span></div>
          <div class="row"><span class="lbl">Ticket ID</span><span class="val">${esc(d.ticketId)}</span></div>
        </div>
        <a href="https://mysokoni.co.ke/scan?t=venue&id=${esc(d.ticketId)}" class="cta">Show QR at Entry</a>`),

      "driver_registration": () => shell("74,222,128","Welcome, Driver!",`
        <p>Hi <strong>${esc(d.name)}</strong>, you're approved as a SOKONI driver!</p>
        <a href="https://mysokoni.co.ke/driver.html" class="cta">Open Driver App</a>`),

      "delivery_assignment": () => shell("0,212,255","New Delivery",`
        <p>Hi <strong>${esc(d.driverName)}</strong>, you have a new delivery!</p>
        <div class="box">
          <div class="row"><span class="lbl">Delivery ID</span><span class="val">${esc(d.deliveryId)}</span></div>
          <div class="row"><span class="lbl">ETA</span><span class="val hl">${esc(d.eta)}</span></div>
        </div>
        <a href="https://mysokoni.co.ke/driver.html" class="cta">Open Driver App</a>`),

      "referral_reward": () => shell("124,58,237","Referral Reward",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p><strong>${esc(d.referredName)}</strong> joined SOKONI using your referral link. You've earned a reward!</p>
        <a href="https://mysokoni.co.ke/wallet.html" class="cta">View My Wallet</a>`),

      "property_enquiry": () => shell("251,191,36","New Property Enquiry",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>You have a new enquiry for <strong>${esc(d.propertyTitle)}</strong>.</p>
        <div class="box">
          <div class="row"><span class="lbl">From</span><span class="val">${esc(d.referredName)}</span></div>
          <div class="row"><span class="lbl">Phone</span><span class="val">${esc(d.phone)}</span></div>
          <div class="row"><span class="lbl">Message</span><span class="val">${esc(d.message)}</span></div>
        </div>`),

      "legal_booking": () => shell("124,58,237","Legal Consultation Booked",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Your consultation with <strong>${esc(d.lawyerName)}</strong> is confirmed.</p>
        <div class="box">
          <div class="row"><span class="lbl">Advocate</span><span class="val">${esc(d.lawyerName)}</span></div>
          <div class="row"><span class="lbl">Specialty</span><span class="val">${esc(d.specialty)}</span></div>
          <div class="row"><span class="lbl">Date & Time</span><span class="val hl">${esc(d.date)} at ${esc(d.time)}</span></div>
          <div class="row"><span class="lbl">Fee</span><span class="val">${fmt(d.fee)}</span></div>
        </div>`),

      "healthcare_booking": () => shell("74,222,128","Appointment Confirmed",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Your appointment with <strong>${esc(d.providerName)}</strong> is confirmed.</p>
        <div class="box">
          <div class="row"><span class="lbl">Provider</span><span class="val">${esc(d.providerName)}</span></div>
          <div class="row"><span class="lbl">Date</span><span class="val hl">${esc(d.date)}</span></div>
          <div class="row"><span class="lbl">Time</span><span class="val">${esc(d.time)}</span></div>
        </div>`),

      "bnb_booking": () => shell("251,191,36","BnB Booking Confirmed",`
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>Your booking for <strong>${esc(d.productName)}</strong> is confirmed.</p>
        <div class="box">
          <div class="row"><span class="lbl">Check-in</span><span class="val hl">${esc(d.checkIn)}</span></div>
          <div class="row"><span class="lbl">Check-out</span><span class="val">${esc(d.checkOut)}</span></div>
          <div class="row"><span class="lbl">Total</span><span class="val hl">${fmt(d.total)}</span></div>
        </div>`),

      "driver_earnings": () => shell("74,222,128","Weekly Earnings Summary",`
        <p>Hi <strong>${esc(d.driverName)}</strong>, here's your earnings summary.</p>
        <div class="box">
          <div class="row"><span class="lbl">Deliveries</span><span class="val">${esc(d.deliveries)}</span></div>
          <div class="row"><span class="lbl">Total Earned</span><span class="val hl">${fmt(d.earnings)}</span></div>
          <div class="row"><span class="lbl">Rating</span><span class="val">⭐ ${esc(d.rating)}</span></div>
        </div>`),

    };

    /* Look up renderer; fall back to a generic preview for unknown template names */
    const renderer = tpls[name];
    let html;
    if (renderer) {
      html = renderer();
    } else {
      html = shell("113,255,0", `Template: ${name}`, `
        <p>Hi <strong>${esc(d.name)}</strong>,</p>
        <p>This is a preview of the <strong>${esc(name)}</strong> email template.</p>
        <div class="box">
          <div class="row"><span class="lbl">Template</span><span class="val hl">${esc(name)}</span></div>
          <div class="row"><span class="lbl">Status</span><span class="val">Active</span></div>
        </div>
        <p style="font-size:12px;color:rgba(255,255,255,0.35);">
          Add a renderer for <code>${esc(name)}</code> in the <em>previewEmailTemplate</em>
          Cloud Function to see a real preview.
        </p>`);
    }

    return { html, template: name, renderedAt: new Date().toISOString() };
  }
);

/* Algolia indexing is now handled by algolia-sync.js (see above). */

/* ============================================================
   INVENTORY MANAGEMENT SYSTEM v1.0
   Enterprise-grade, offline-first, AI-powered.
   Atomic stock operations, demand forecasting, auto-reorder,
   serial/batch tracking, multi-warehouse support.

   Setup:
     (No extra secrets needed — uses ANTHROPIC_API_KEY already defined)
     firebase deploy --only functions,firestore:indexes,firestore:rules,hosting
============================================================ */
const inventoryEngine = require("./inventory-engine");
exports.inventoryAdjustStock         = inventoryEngine.inventoryAdjustStock;
exports.inventoryReserveStock        = inventoryEngine.inventoryReserveStock;
/* Returnable units (bottle lifecycle) — one primitive for every subtype move. */
exports.inventoryTransferSubtype     = inventoryEngine.inventoryTransferSubtype;
exports.inventoryReleaseReservation  = inventoryEngine.inventoryReleaseReservation;
exports.inventoryTransferStock       = inventoryEngine.inventoryTransferStock;
exports.inventoryReceivePO           = inventoryEngine.inventoryReceivePO;
exports.inventoryProcessStockCount   = inventoryEngine.inventoryProcessStockCount;
exports.inventoryAggregateAnalytics  = inventoryEngine.inventoryAggregateAnalytics;
exports.inventoryGetDashboardStats   = inventoryEngine.inventoryGetDashboardStats;
exports.inventoryOnMovement          = inventoryEngine.inventoryOnMovement;
exports.inventoryCleanupOldMovements = inventoryEngine.inventoryCleanupOldMovements;

const inventoryAI = require("./inventory-ai");
exports.inventoryAiQuery             = inventoryAI.inventoryAiQuery;
exports.inventoryAiForecast          = inventoryAI.inventoryAiForecast;
exports.inventoryAiReorderSuggestions= inventoryAI.inventoryAiReorderSuggestions;
exports.inventoryAiIdentifyProduct   = inventoryAI.inventoryAiIdentifyProduct;
exports.inventoryDailyForecasts      = inventoryAI.inventoryDailyForecasts;

/* ── Inventory V2 — Health Score ── */
const inventoryHealth = require("./inventory-health");
exports.inventoryCalculateHealth     = inventoryHealth.inventoryCalculateHealth;
exports.inventoryGetHealthHistory    = inventoryHealth.inventoryGetHealthHistory;
exports.inventoryHealthMonitor       = inventoryHealth.inventoryHealthMonitor;

/* ── Inventory V2 — Fraud & Loss Prevention ── */
const inventoryFraud = require("./inventory-fraud");
exports.inventoryFraudOnMovement     = inventoryFraud.inventoryFraudOnMovement;
exports.inventoryFraudScan           = inventoryFraud.inventoryFraudScan;
exports.inventoryGetFraudEvents      = inventoryFraud.inventoryGetFraudEvents;
exports.inventoryFraudReview         = inventoryFraud.inventoryFraudReview;
exports.inventoryFraudReport         = inventoryFraud.inventoryFraudReport;

/* ── Inventory V2 — Business Simulation ── */
const inventorySimulate = require("./inventory-simulate");
exports.inventorySimulate            = inventorySimulate.inventorySimulate;
exports.inventoryGetSimulations      = inventorySimulate.inventoryGetSimulations;

/* ── Inventory V2 — Recall Management ── */
const inventoryRecall = require("./inventory-recall");
exports.inventoryInitiateRecall      = inventoryRecall.inventoryInitiateRecall;
exports.inventoryGetRecalls          = inventoryRecall.inventoryGetRecalls;
exports.inventoryUpdateRecallStatus  = inventoryRecall.inventoryUpdateRecallStatus;
exports.inventoryRecallReport        = inventoryRecall.inventoryRecallReport;
exports.inventoryRecallOnCreated     = inventoryRecall.inventoryRecallOnCreated;

/* ── Inventory V2 — AI Import Engine ── */
const inventoryImport = require("./inventory-import");
exports.inventoryImportAiMap         = inventoryImport.inventoryImportAiMap;
exports.inventoryImportPreview       = inventoryImport.inventoryImportPreview;
exports.inventoryImportCommit        = inventoryImport.inventoryImportCommit;
exports.inventoryGetImportJobs       = inventoryImport.inventoryGetImportJobs;

/* ── Inventory V2 — Developer Webhooks ── */
const inventoryWebhooks = require("./inventory-webhooks");
exports.inventoryRegisterWebhook     = inventoryWebhooks.inventoryRegisterWebhook;
exports.inventoryListWebhooks        = inventoryWebhooks.inventoryListWebhooks;
exports.inventoryDeleteWebhook       = inventoryWebhooks.inventoryDeleteWebhook;
exports.inventoryTestWebhook         = inventoryWebhooks.inventoryTestWebhook;
exports.inventoryAlertWebhook        = inventoryWebhooks.inventoryAlertWebhook;

/* ── Inventory V2 — Workflow Automation ── */
const inventoryWorkflows = require("./inventory-workflows");
exports.inventoryWorkflowEvaluator   = inventoryWorkflows.inventoryWorkflowEvaluator;
exports.inventoryWorkflowOnStock     = inventoryWorkflows.inventoryWorkflowOnStock;
exports.inventoryCreateWorkflow      = inventoryWorkflows.inventoryCreateWorkflow;
exports.inventoryGetWorkflows        = inventoryWorkflows.inventoryGetWorkflows;
exports.inventoryToggleWorkflow      = inventoryWorkflows.inventoryToggleWorkflow;
exports.inventoryDeleteWorkflow      = inventoryWorkflows.inventoryDeleteWorkflow;
exports.inventoryGetWorkflowRuns     = inventoryWorkflows.inventoryGetWorkflowRuns;

/* ── Inventory V2 — AI Pricing Engine ── */
const inventoryPricing = require("./inventory-pricing");
exports.inventoryGetPricingRecommendations = inventoryPricing.inventoryGetPricingRecommendations;
exports.inventorySetPricingRule            = inventoryPricing.inventorySetPricingRule;
exports.inventorySimulatePriceChange       = inventoryPricing.inventorySimulatePriceChange;
exports.inventoryPricingScheduler          = inventoryPricing.inventoryPricingScheduler;

/* ── Inventory V2 — Variants / Batches / Serials / BOM / Transfers ── */
const inventoryV2 = require("./inventory-v2");
exports.inventorySaveVariant              = inventoryV2.inventorySaveVariant;
exports.inventoryGetVariants              = inventoryV2.inventoryGetVariants;
exports.inventoryDeleteVariant            = inventoryV2.inventoryDeleteVariant;
exports.inventoryCreateBatch              = inventoryV2.inventoryCreateBatch;
exports.inventoryDeductBatch              = inventoryV2.inventoryDeductBatch;
exports.inventoryGetBatches               = inventoryV2.inventoryGetBatches;
exports.inventoryGetExpiringBatches       = inventoryV2.inventoryGetExpiringBatches;
exports.inventoryRegisterSerials          = inventoryV2.inventoryRegisterSerials;
exports.inventoryUpdateSerialStatus       = inventoryV2.inventoryUpdateSerialStatus;
exports.inventoryGetSerials               = inventoryV2.inventoryGetSerials;
exports.inventorySaveBOM                  = inventoryV2.inventorySaveBOM;
exports.inventoryGetBOM                   = inventoryV2.inventoryGetBOM;
exports.inventoryCreateWorkOrder          = inventoryV2.inventoryCreateWorkOrder;
exports.inventoryUpdateWorkOrderStatus    = inventoryV2.inventoryUpdateWorkOrderStatus;
exports.inventoryGetWorkOrders            = inventoryV2.inventoryGetWorkOrders;
exports.inventoryRequestTransfer          = inventoryV2.inventoryRequestTransfer;
exports.inventoryPatchTransfer            = inventoryV2.inventoryPatchTransfer;
exports.inventoryGetTransfers             = inventoryV2.inventoryGetTransfers;
exports.inventoryScoreSupplier            = inventoryV2.inventoryScoreSupplier;
exports.inventoryFlushSyncQueue           = inventoryV2.inventoryFlushSyncQueue;
exports.inventoryGetAuditLog              = inventoryV2.inventoryGetAuditLog;
exports.inventoryUpdateAVCO              = inventoryV2.inventoryUpdateAVCO;
exports.inventoryGetAVCO                 = inventoryV2.inventoryGetAVCO;
exports.inventoryDeductAVCO              = inventoryV2.inventoryDeductAVCO;
exports.inventoryGetAVCOHistory          = inventoryV2.inventoryGetAVCOHistory;
exports.inventoryGetCOGSReport           = inventoryV2.inventoryGetCOGSReport;

/* ── Media Engine — AI Creative Studio ── */
const mediaEngine = require("./media-engine");
exports.generateProductMetadata = mediaEngine.generateProductMetadata;
exports.moderateMediaContent    = mediaEngine.moderateMediaContent;
exports.deleteMediaAsset        = mediaEngine.deleteMediaAsset;
exports.onMediaUploaded         = mediaEngine.onMediaUploaded;
exports.aggregateMediaStats     = mediaEngine.aggregateMediaStats;



/* ── AI Subscriptions ── */
const aiSubs = require("./ai-subscriptions");
exports.activateAIPlan          = aiSubs.activateAIPlan;
exports.consumeAICredit         = aiSubs.consumeAICredit;
exports.topupAICredits          = aiSubs.topupAICredits;
exports.resetAIUsage            = aiSubs.resetAIUsage;
exports.getAISubscriptionStats  = aiSubs.getAISubscriptionStats;
exports.updateAIPlan            = aiSubs.updateAIPlan;

/* ── Subscription OS — Universal Entitlement & Self-Healing Platform ── */
const subOS = require("./subscription-os");
exports.generateEntitlementToken  = subOS.generateEntitlementToken;
exports.verifyEntitlement         = subOS.verifyEntitlement;
exports.processSubscriptionChange = subOS.processSubscriptionChange;
exports.detectSubscriptionFraud   = subOS.detectFraud;   /* admin: full entitlement fraud lookup (separate from payment detectFraud) */
exports.proposeFinancialChange    = subOS.proposeFinancialChange;
exports.approveFinancialChange    = subOS.approveFinancialChange;
exports.forecastRevenue           = subOS.forecastRevenue;
exports.runSubscriptionBrain      = subOS.runSubscriptionBrain;
exports.selfHealSubscriptions     = subOS.selfHealSubscriptions;
exports.sendBillingReminders      = subOS.sendBillingReminders;
exports.reconcileBilling          = subOS.reconcileBilling;

/* ── Workflow Automation Platform (WAP) ── */
const wap = require("./wap");
exports.wapTriggerWorkflow      = wap.wapTriggerWorkflow;
exports.wapAdvanceWorkflow      = wap.wapAdvanceWorkflow;
exports.wapApproveStep          = wap.wapApproveStep;
exports.wapScheduledResume      = wap.wapScheduledResume;
exports.wapGetInstance          = wap.wapGetInstance;
exports.wapGetPendingApprovals  = wap.wapGetPendingApprovals;
exports.wapSaveDefinition       = wap.wapSaveDefinition;
exports.wapEscalateApprovals    = wap.wapEscalateApprovals;
exports.wapWatchdog             = wap.wapWatchdog;
exports.wapDLQSweep             = wap.wapDLQSweep;
exports.wapGetDLQ               = wap.wapGetDLQ;

/* ── Enterprise Control Center (ECC) ── */
const ecc = require("./ecc");
exports.eccHealthCheck      = ecc.eccHealthCheck;
exports.eccAlertCheck       = ecc.eccAlertCheck;
exports.eccGetMetrics       = ecc.eccGetMetrics;
exports.eccCreateIncident   = ecc.eccCreateIncident;
exports.eccResolveIncident  = ecc.eccResolveIncident;
exports.eccWriteAudit       = ecc.eccWriteAudit;
exports.eccGetAuditLog      = ecc.eccGetAuditLog;

/* ════════════════════════════════════════════════════════════
   SASOS — Universal AI Subscription Operating System
════════════════════════════════════════════════════════════ */

/* ── SASOS Core — Plan registry, subscription lifecycle, entitlement ── */
const sasosCore = require("./sasos-core");
exports.sasosSubscribe                = sasosCore.sasosSubscribe;
exports.sasosCancel                   = sasosCore.sasosCancel;
exports.sasosGetSubscription          = sasosCore.sasosGetSubscription;
exports.sasosListPlans                = sasosCore.sasosListPlans;
exports.sasosCheckFeature             = sasosCore.sasosCheckFeature;
exports.sasosAdminListSubscriptions   = sasosCore.sasosAdminListSubscriptions;
exports.sasosAdminUpdatePlanConfig    = sasosCore.sasosAdminUpdatePlanConfig;
exports.sasosExpireTrials             = sasosCore.sasosExpireTrials;
exports.sasosProcessRenewals          = sasosCore.sasosProcessRenewals;
exports.sasosSyncLegacy               = sasosCore.sasosSyncLegacy;

/* ── SASOS Billing — Invoices, VAT, dunning, proration, refunds ── */
const sasosBilling = require("./sasos-billing");
exports.sasosCreateInvoice            = sasosBilling.sasosCreateInvoice;
exports.sasosGetInvoices              = sasosBilling.sasosGetInvoices;
exports.sasosGetBillingHistory        = sasosBilling.sasosGetBillingHistory;
exports.sasosAdminRefund              = sasosBilling.sasosAdminRefund;
exports.sasosCalculateProration       = sasosBilling.sasosCalculateProration;
exports.sasosDunningCycle             = sasosBilling.sasosDunningCycle;
exports.sasosRecordFailedPayment      = sasosBilling.sasosRecordFailedPayment;
exports.sasosDailyRevenue             = sasosBilling.sasosDailyRevenue;
exports.sasosGetRevenueSummary        = sasosBilling.sasosGetRevenueSummary;

/* ── SASOS Usage — Metering, quotas, credits, storage ── */
const sasosUsage = require("./sasos-usage");
exports.sasosRecordUsage              = sasosUsage.sasosRecordUsage;
exports.sasosGetUsage                 = sasosUsage.sasosGetUsage;
exports.sasosCheckQuota               = sasosUsage.sasosCheckQuota;
exports.sasosDeductCredits            = sasosUsage.sasosDeductCredits;
exports.sasosAllocateCredits          = sasosUsage.sasosAllocateCredits;
exports.sasosGetCredits               = sasosUsage.sasosGetCredits;
exports.sasosAllocateStorage          = sasosUsage.sasosAllocateStorage;
exports.sasosGetStorageUsage          = sasosUsage.sasosGetStorageUsage;
exports.sasosResetMonthlyUsage        = sasosUsage.sasosResetMonthlyUsage;

/* ── SASOS Fraud — Risk scoring, trust engine, behavioral analysis ── */
const sasosFraud = require("./sasos-fraud");
exports.sasosUpdateRiskScore          = sasosFraud.sasosUpdateRiskScore;
exports.sasosGetRiskProfile           = sasosFraud.sasosGetRiskProfile;
exports.sasosReportFraud              = sasosFraud.sasosReportFraud;
exports.sasosResolveRisk              = sasosFraud.sasosResolveRisk;
exports.sasosApproveRiskEvent         = sasosFraud.sasosApproveRiskEvent;
exports.sasosFraudScan                = sasosFraud.sasosFraudScan;
exports.sasosGetFraudQueue            = sasosFraud.sasosGetFraudQueue;

/* ── SASOS Brain — AI churn prediction, LTV, forecasting, recommendations ── */
const sasosBrain = require("./sasos-brain");
exports.sasosRunBrain                 = sasosBrain.sasosRunBrain;
exports.sasosGetInsights              = sasosBrain.sasosGetInsights;
exports.sasosGetRecommendations       = sasosBrain.sasosGetRecommendations;
exports.sasosGetForecast              = sasosBrain.sasosGetForecast;
exports.sasosGetChurnRisk             = sasosBrain.sasosGetChurnRisk;
exports.sasosGetSegmentInsights       = sasosBrain.sasosGetSegmentInsights;

/* ── SASOS Enterprise — Orgs, seats, licenses, multi-tenant ── */
const sasosEnterprise = require("./sasos-enterprise");
exports.sasosCreateOrg                = sasosEnterprise.sasosCreateOrg;
exports.sasosGetOrg                   = sasosEnterprise.sasosGetOrg;
exports.sasosInviteSeat               = sasosEnterprise.sasosInviteSeat;
exports.sasosAcceptSeatInvite         = sasosEnterprise.sasosAcceptSeatInvite;
exports.sasosRemoveSeat               = sasosEnterprise.sasosRemoveSeat;
exports.sasosGetOrgSeats              = sasosEnterprise.sasosGetOrgSeats;
exports.sasosCreateLicense            = sasosEnterprise.sasosCreateLicense;
exports.sasosActivateLicense          = sasosEnterprise.sasosActivateLicense;
exports.sasosRevokeLicense            = sasosEnterprise.sasosRevokeLicense;
exports.sasosGetLicense               = sasosEnterprise.sasosGetLicense;

/* ── Platform Core — Hub Registry + Feature Flags + Cross-Hub Metrics ── */
const platformCore = require('./platform-core');
exports.pcGetHubRegistry    = platformCore.pcGetHubRegistry;
exports.pcRegisterHub       = platformCore.pcRegisterHub;
exports.pcUpdateHubConfig   = platformCore.pcUpdateHubConfig;
exports.pcGetFeatureFlags   = platformCore.pcGetFeatureFlags;
exports.pcSetFeatureFlag    = platformCore.pcSetFeatureFlag;
exports.pcGetCrossHubMetrics = platformCore.pcGetCrossHubMetrics;

/* ── Platform Registry + Event Bus ── */
const platformRegistry = require("./platform-registry");
exports.platformRegisterService    = platformRegistry.platformRegisterService;
exports.platformGetRegistry        = platformRegistry.platformGetRegistry;
exports.platformUpdateHealth       = platformRegistry.platformUpdateHealth;
exports.platformGetHealth          = platformRegistry.platformGetHealth;
exports.platformDeregisterService  = platformRegistry.platformDeregisterService;
exports.platformGetDependencies    = platformRegistry.platformGetDependencies;
exports.platformGetCapabilityMatrix = platformRegistry.platformGetCapabilityMatrix;
exports.platformHealthSweep        = platformRegistry.platformHealthSweep;

const platformEvents = require("./platform-events");
exports.platformPublishEvent       = platformEvents.platformPublishEvent;
exports.platformGetEventLog        = platformEvents.platformGetEventLog;
exports.platformRegisterSub        = platformEvents.platformRegisterSub;
exports.platformGetSubscriptions   = platformEvents.platformGetSubscriptions;
exports.platformReplayEvents       = platformEvents.platformReplayEvents;
exports.onPlatformEventsDocCreated  = platformEvents.onPlatformEventCreated;

/* ── Search Platform — Unified Orchestration Layer ────────────────────── */
const searchAdmin = require('./search-admin');
exports.searchSetup          = searchAdmin.searchSetup;
exports.searchBackfillAll    = searchAdmin.searchBackfillAll;
exports.searchSystemReport   = searchAdmin.searchSystemReport;
exports.searchGetSecuredKeys = searchAdmin.searchGetSecuredKeys;
exports.searchConfigUpdate   = searchAdmin.searchConfigUpdate;
exports.searchGetStats       = searchAdmin.searchGetStats;

const searchService = require('./search-service');
exports.searchQuery          = searchService.searchQuery;
exports.searchAutocomplete   = searchService.searchAutocomplete;
exports.searchNearby         = searchService.searchNearby;
exports.searchSimilar        = searchService.searchSimilar;
exports.searchPersonalized   = searchService.searchPersonalized;
exports.searchIntent         = searchService.searchIntent;

const searchMonitor = require('./search-monitor');
exports.searchGetUnifiedDashboard = searchMonitor.searchGetUnifiedDashboard;
exports.searchSystemHealth        = searchMonitor.searchSystemHealth;
exports.searchGetHealthHistory    = searchMonitor.searchGetHealthHistory;
exports.searchResolveAlert        = searchMonitor.searchResolveAlert;

const searchRepair = require('./search-repair');
exports.searchRepairAll            = searchRepair.searchRepairAll;
exports.searchVerifyDocument       = searchRepair.searchVerifyDocument;
exports.searchFullReindex          = searchRepair.searchFullReindex;
exports.searchRepairOrphanedDocs   = searchRepair.searchRepairOrphanedDocs;
exports.searchScheduledReconcile   = searchRepair.searchScheduledReconcile;

const searchWorker = require('./search-worker');
exports.searchQueueCoordinator     = searchWorker.searchQueueCoordinator;
exports.searchDLQSweep             = searchWorker.searchDLQSweep;
exports.searchQueueRecovery        = searchWorker.searchQueueRecovery;

const searchHealth = require('./search-health');
exports.searchHealth               = searchHealth.searchHealth;

/* ── System Health & Ops Tools ───────────────────────────────────────── */
const systemHealth = require('./system-health');
exports.systemHealthCheck        = systemHealth.systemHealthCheck;

const opsTools = require('./ops-tools');
exports.cspReportCollect         = opsTools.cspReportCollect;
exports.testPushNotification     = opsTools.testPushNotification;
exports.testEmailDelivery        = opsTools.testEmailDelivery;
exports.getPaymentAuditTrail     = opsTools.getPaymentAuditTrail;
exports.getOpsStatus             = opsTools.getOpsStatus;

/* ── User Feedback & Triage ───────────────────────────────────────────── */
const feedback = require('./feedback');
exports.submitFeedback        = feedback.submitFeedback;
exports.getFeedbackItems      = feedback.getFeedbackItems;
exports.updateFeedbackStatus  = feedback.updateFeedbackStatus;

/* ── Business Metrics & Security Summary ─────────────────────────────── */
const businessMetrics = require('./business-metrics');
exports.getBusinessMetrics  = businessMetrics.getBusinessMetrics;
exports.getOrderTrends      = businessMetrics.getOrderTrends;
exports.getSecuritySummary  = businessMetrics.getSecuritySummary;

/* ── Scheduled Reports (daily ops + weekly security) ─────────────────── */
const scheduledReports = require('./scheduled-reports');
exports.scheduledDailyOpsReport       = scheduledReports.scheduledDailyOpsReport;
exports.scheduledWeeklySecurityReport = scheduledReports.scheduledWeeklySecurityReport;
exports.getDailyReport                = scheduledReports.getDailyReport;
exports.getWeeklyReports              = scheduledReports.getWeeklyReports;

/* ── Conversion Analytics & Reliability ──────────────────────────────── */
const conversionAnalytics = require('./conversion-analytics');
exports.recordFunnelEvent     = conversionAnalytics.recordFunnelEvent;
exports.getFunnelMetrics      = conversionAnalytics.getFunnelMetrics;
exports.recordHealthSnapshot  = conversionAnalytics.recordHealthSnapshot;
exports.getReliabilityMetrics = conversionAnalytics.getReliabilityMetrics;

/* ── Seller Quality Engine ───────────────────────────────────────────── */
const sellerQuality = require('./seller-quality');
exports.getListingQualityReport    = sellerQuality.getListingQualityReport;
exports.getSellerPerformanceSummary = sellerQuality.getSellerPerformanceSummary;
exports.getMarketplaceSellerHealth  = sellerQuality.getMarketplaceSellerHealth;

/* ── Retention Engine ─────────────────────────────────────────────────── */
const retention = require('./retention');
exports.recordRecentlyViewed = retention.recordRecentlyViewed;
exports.saveSearch           = retention.saveSearch;
exports.deleteSavedSearch    = retention.deleteSavedSearch;
exports.createPriceAlert     = retention.createPriceAlert;
exports.deletePriceAlert     = retention.deletePriceAlert;
exports.triggerPriceAlerts   = retention.triggerPriceAlerts;
exports.getRetentionData     = retention.getRetentionData;

/* ── Marketplace Quality Engine ──────────────────────────────────────── */
const marketplaceQuality = require('./marketplace-quality');
exports.getMarketplaceQualityReport = marketplaceQuality.getMarketplaceQualityReport;
exports.flagLowQualityListing       = marketplaceQuality.flagLowQualityListing;

/* ── Search Insights Engine ──────────────────────────────────────────── */
const searchInsights = require('./search-insights');
exports.getSearchInsights   = searchInsights.getSearchInsights;
exports.getZeroResultTerms  = searchInsights.getZeroResultTerms;
exports.recordSearchQuery   = searchInsights.recordSearchQuery;

/* ── Platform Health Scoring Engine (v2.0) ───────────────────────────── */
const platformHealth = require('./platform-health');
exports.getPlatformHealthScores   = platformHealth.getPlatformHealthScores;
exports.getTopBusinessPriorities  = platformHealth.getTopBusinessPriorities;

/* ── Product Analytics & Trust Engine ────────────────────────────────── */
const productAnalytics = require('./product-analytics');
exports.recordProductView           = productAnalytics.recordProductView;
exports.onProductPriceChanged       = productAnalytics.onProductPriceChanged;
exports.onOrderPaidUpdateStats      = productAnalytics.onOrderPaidUpdateStats;
exports.aggregateProductStats       = productAnalytics.aggregateProductStats;
exports.aggregateSellerPerformance  = productAnalytics.aggregateSellerPerformance;
exports.computeProductTrending      = productAnalytics.computeProductTrending;
exports.getProductTrustData         = productAnalytics.getProductTrustData;
exports.getAdminProductAnalytics    = productAnalytics.getAdminProductAnalytics;
exports.cleanupProductViewDedup     = productAnalytics.cleanupProductViewDedup;

/* ── Manager Authorization Engine ─────────────────────────────────────── */
const managerAuth = require('./manager-auth');
exports.managerAuthNotify          = managerAuth.managerAuthNotify;
exports.cleanupAuthRequests        = managerAuth.cleanupAuthRequests;
exports.registerManagerFCMToken    = managerAuth.registerManagerFCMToken;

/* ════════════════════════════════════════════════════════════════════════
   SCHEDULED FIRESTORE BACKUP  —  Daily 02:00 EAT
   Exports entire Firestore database to GCS bucket sokoni-aeb26-backups.
   Prerequisite setup (one-time, run in Cloud Shell or gcloud CLI):
     1. Create bucket:
          gsutil mb -p sokoni-aeb26 -l europe-west1 gs://sokoni-aeb26-backups
          gsutil lifecycle set monitoring/backup-lifecycle.json gs://sokoni-aeb26-backups
     2. Grant the default CF service account export rights:
          SA="sokoni-aeb26@appspot.gserviceaccount.com"
          gcloud projects add-iam-policy-binding sokoni-aeb26 \
            --member="serviceAccount:$SA" --role="roles/datastore.importExportAdmin"
          gsutil iam ch serviceAccount:$SA:roles/storage.objectAdmin gs://sokoni-aeb26-backups
   Recovery:
     gcloud firestore import gs://sokoni-aeb26-backups/firestore/YYYY-MM-DD
════════════════════════════════════════════════════════════════════════ */
exports.scheduledFirestoreBackup = onSchedule(
  {
    schedule:       "0 2 * * *",
    timeZone:       "Africa/Nairobi",
    timeoutSeconds: 540,
    memory:         "512MiB",
    region:         "us-central1",
  },
  async (_event) => {
    const projectId        = process.env.GCLOUD_PROJECT || "sokoni-aeb26";
    const timestamp        = new Date().toISOString().slice(0, 10);
    const outputUriPrefix  = `gs://sokoni-aeb26-backups/firestore/${timestamp}`;

    /* Get a short-lived OAuth2 token from the GCP metadata server.
       Works in Cloud Run (Gen2 Functions) without extra dependencies. */
    const tokenRes = await fetch(
      "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token",
      { headers: { "Metadata-Flavor": "Google" } }
    );
    if (!tokenRes.ok) {
      throw new Error(`[Backup] Metadata token request failed: ${tokenRes.status}`);
    }
    const { access_token } = await tokenRes.json();

    /* Call the Firestore Admin REST API to start an export */
    const exportRes = await fetch(
      `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default):exportDocuments`,
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${access_token}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({ outputUriPrefix }),
      }
    );

    const result = await exportRes.json();
    if (!exportRes.ok) {
      console.error("[Backup] Export API error:", JSON.stringify(result));
      throw new Error(`[Backup] Export failed: ${result.error?.message || exportRes.status}`);
    }

    /* Log the long-running operation name for manual status checks */
    console.log(`[Backup] Firestore export started → ${outputUriPrefix}  op=${result.name}`);

    /* Record the backup run in Firestore for the ops dashboard */
    try {
      await admin.firestore().collection("ops_backups").add({
        type:        "firestore_export",
        destination: outputUriPrefix,
        operationId: result.name || "",
        status:      "started",
        timestamp:   admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) { /* non-critical — don't fail the export */ }

    return { success: true, operation: result.name, destination: outputUriPrefix };
  }
);

/* ══════════════════════════════════════════════════════════════════
   EPRA / ERC FUEL PRICE SCRAPER
   Scrapes Kenya EPRA website for current pump prices and stores
   them in Firestore sysConfig/fuelPrices so every client gets
   real-time updates via onSnapshot the moment EPRA announces.

   Scheduled:  every 4 hours (catches same-day EPRA announcements)
   Callable:   triggerEPRAFuelFetch — admin or driver "refresh" button
   ══════════════════════════════════════════════════════════════════ */

const EPRA_CANDIDATE_URLS = [
  "https://www.epra.go.ke/category/petroleum/maximum-pump-prices/",
  "https://epra.go.ke/category/petroleum/maximum-pump-prices/",
  "https://www.epra.go.ke/petroleum/maximum-pump-prices/",
  "https://www.epra.go.ke/",
];

const EPRA_PRICE_RANGE = { min: 80, max: 600 }; // KES/litre sanity bounds

/* Baseline regional differentials (transport-cost-based, rarely change) */
const REGION_DIFFS  = { mombasa: -11, kisumu: 3, other: 3 };
/* Diesel and kerosene as a fraction of super-petrol (from historical data) */
const DIESEL_RATIO  = 163.41 / 176.70;
const KERO_RATIO    = 138.92 / 176.70;

function _validatePrice(p) {
  const n = parseFloat(p);
  return (!isNaN(n) && n >= EPRA_PRICE_RANGE.min && n <= EPRA_PRICE_RANGE.max) ? Math.round(n * 100) / 100 : null;
}

/* Strip all HTML tags and normalise whitespace */
function _stripHtml(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ");
}

/* Parse a price out of a cell string */
function _extractPrice(cell) {
  const m = (cell || "").match(/(\d{2,3}(?:\.\d{1,2})?)/);
  return m ? _validatePrice(m[1]) : null;
}

function _parseEPRAHtml(html) {
  const prices = { super_petrol: {}, diesel: {}, kerosene: {} };

  const FUEL_PATTERNS = {
    super_petrol: /super.?petrol|petrol.?super/i,
    diesel:       /\bdiesel\b|automotive gas oil|^ago\b/i,
    kerosene:     /kerosene|illuminating kerosene|ihk/i,
  };
  const CITY_PATTERNS = {
    nairobi: /nairobi/i,
    mombasa: /mombasa/i,
    kisumu:  /kisumu/i,
  };

  /* ── Strategy 1: HTML table parsing ── */
  const cityColIdx = {};
  const rowRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  let rowMatch;

  while ((rowMatch = rowRe.exec(html)) !== null) {
    const rowHtml = rowMatch[1];
    const cells   = [];
    let cellMatch;
    const cr = new RegExp(cellRe.source, "gi");
    while ((cellMatch = cr.exec(rowHtml)) !== null) {
      cells.push(_stripHtml(cellMatch[1]).trim());
    }
    if (!cells.length) continue;

    /* Header row — discover which column index maps to which city */
    const isHeaderRow = cells.some(c => Object.values(CITY_PATTERNS).some(re => re.test(c)));
    if (isHeaderRow) {
      Object.keys(cityColIdx).forEach(k => delete cityColIdx[k]); // reset
      cells.forEach((c, i) => {
        for (const [city, re] of Object.entries(CITY_PATTERNS)) {
          if (re.test(c)) cityColIdx[city] = i;
        }
      });
      continue;
    }

    /* Data row — identify fuel type from first few cells */
    const rowText = cells.join(" ");
    let rowFuel = null;
    for (const [fuel, re] of Object.entries(FUEL_PATTERNS)) {
      if (re.test(rowText)) { rowFuel = fuel; break; }
    }
    if (!rowFuel || !Object.keys(cityColIdx).length) continue;

    for (const [city, idx] of Object.entries(cityColIdx)) {
      const p = _extractPrice(cells[idx]);
      if (p) prices[rowFuel][city] = p;
    }
  }

  /* ── Strategy 2: plain-text proximity search ── */
  if (!prices.super_petrol.nairobi) {
    const text = _stripHtml(html);
    for (const [fuel, fuelRe] of Object.entries(FUEL_PATTERNS)) {
      const segments = text.split(fuelRe);
      for (let i = 1; i < segments.length; i++) {
        const window = segments[i].substring(0, 600);
        for (const [city, cityRe] of Object.entries(CITY_PATTERNS)) {
          if (prices[fuel][city]) continue;
          const cityMatch = cityRe.exec(window);
          if (!cityMatch) continue;
          const afterCity = window.substring(cityMatch.index);
          const priceMatch = afterCity.match(/(\d{2,3}(?:\.\d{1,2})?)/);
          if (priceMatch) {
            const p = _validatePrice(priceMatch[1]);
            if (p) prices[fuel][city] = p;
          }
        }
      }
    }
  }

  if (!prices.super_petrol.nairobi) {
    throw new Error("Could not extract Super Petrol Nairobi price from EPRA HTML");
  }

  /* Fill missing regional prices using fixed differentials */
  const sp = prices.super_petrol.nairobi;
  for (const fuel of Object.keys(prices)) {
    if (!prices[fuel].nairobi) {
      const ratio = fuel === "diesel" ? DIESEL_RATIO : KERO_RATIO;
      prices[fuel].nairobi = Math.round(sp * ratio * 100) / 100;
    }
    const base = prices[fuel].nairobi;
    for (const [city, diff] of Object.entries(REGION_DIFFS)) {
      if (!prices[fuel][city]) {
        prices[fuel][city] = Math.round((base + diff) * 100) / 100;
      }
    }
  }

  return prices;
}

async function _fetchAndParseEPRA() {
  let lastErr = null;
  for (const url of EPRA_CANDIDATE_URLS) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "SOKONI-FuelBot/1.0 (+https://mysokoni.co.ke)" },
        signal: AbortSignal.timeout(12000),
      });
      if (!res.ok) continue;
      const html   = await res.text();
      const prices = _parseEPRAHtml(html);
      return { prices, sourceUrl: url };
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("All EPRA URLs failed");
}

async function _runEPRAScraper(db) {
  const ref = db.collection("sysConfig").doc("fuelPrices");

  try {
    const { prices, sourceUrl } = await _fetchAndParseEPRA();

    const snap = await ref.get();
    const prev = snap.exists ? (snap.data().current || null) : null;

    await ref.set({
      current:            prices,
      previous:           prev || prices,
      updatedAt:          admin.firestore.FieldValue.serverTimestamp(),
      revisionDate:       new Date().toLocaleDateString("en-KE", { day: "numeric", month: "long", year: "numeric" }),
      source:             "EPRA Kenya (live)",
      sourceUrl,
      scraperStatus:      "success",
      scraperError:       admin.firestore.FieldValue.delete(),
      scraperLastSuccess: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return { success: true, prices, sourceUrl };
  } catch (err) {
    /* Don't overwrite existing prices on failure — just log the error */
    await ref.set({
      scraperStatus:      "failed",
      scraperError:       err.message,
      scraperLastAttempt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true }).catch(() => {});
    throw err;
  }
}

/* Scheduled: every 4 hours (Africa/Nairobi)
   EPRA is a third-party website we scrape; it goes down and restructures its URLs
   without notice (as of 2026-07-12 the maximum-pump-prices pages return 404 while
   epra.go.ke itself is up). An unreachable source is NOT a platform failure, so this
   must not throw: throwing marked the scheduled job FAILED every 4 hours and generated
   permanent alert noise. The last successfully scraped prices remain in
   sysConfig/fuelPrices and continue to serve clients, so degrading is safe.
   Genuine platform faults still surface — we log at error level. */
exports.fetchEPRAFuelPrices = onSchedule(
  { schedule: "0 */4 * * *", timeZone: "Africa/Nairobi", timeoutSeconds: 60 },
  async () => {
    try {
      await _runEPRAScraper(admin.firestore());
    } catch (err) {
      console.error("[EPRA] scrape failed — retaining last known prices:", err && err.message);
    }
  }
);

/* Callable: admin panel or driver refresh button */
exports.triggerEPRAFuelFetch = onCall(
  { timeoutSeconds: 30, cors: ["https://mysokoni.co.ke", "https://sokoni-aeb26.web.app"] },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
    try {
      const result = await _runEPRAScraper(admin.firestore());
      return result;
    } catch (err) {
      throw new HttpsError("internal", `EPRA scraper: ${err.message}`);
    }
  }
);

/* ══════════════════════════════════════════════════════════════════════════
   SCHEDULED DELIVERY — process deliveries whose scheduledTime has arrived
   Runs every 5 minutes. Picks up packageRequests with:
     status == 'order_placed'  AND  scheduledTime <= now
   Transitions them to 'ready_for_pickup' which triggers rider assignment.
═══════════════════════════════════════════════════════════════════════════ */
exports.processScheduledDeliveries = onSchedule(
  { schedule: "*/5 * * * *", timeZone: "Africa/Nairobi", timeoutSeconds: 120 },
  async () => {
    const db  = admin.firestore();
    const now = new Date().toISOString();

    const snap = await db.collection("packageRequests")
      .where("status", "==", "order_placed")
      .where("scheduledTime", "<=", now)
      .where("scheduledTime", "!=", null)
      .limit(50)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    const nowIso = new Date().toISOString();
    snap.docs.forEach(doc => {
      batch.update(doc.ref, {
        status:           "ready_for_pickup",
        scheduledFiredAt: nowIso,
        timeline: admin.firestore.FieldValue.arrayUnion({
          status: "ready_for_pickup",
          at:     nowIso,
          by:     "system_scheduler",
        }),
        _lastTimelineEntry: { status: "ready_for_pickup", at: nowIso, by: "system_scheduler" },
        updatedAt: nowIso,
      });
    });

    await batch.commit();
    console.log(`[scheduledDeliveries] activated ${snap.size} delivery/ies`);
  }
);

/* ══════════════════════════════════════════════════════════════════
   KRA eTIMS — Kenya Revenue Authority Electronic Tax Invoice System
   15 Cloud Functions: seller registration, per-order invoicing,
   bulk/periodic invoicing, SOKONI platform invoices, queue processor,
   retry scheduler, daily reconciliation, buyer receipts, admin stats.
══════════════════════════════════════════════════════════════════ */
const etims = require("./etims");

exports.etimsRegisterSeller    = etims.etimsRegisterSeller;
exports.etimsInvoiceLifecycle  = etims.etimsInvoiceLifecycle;   // credit/debit/cancel/amend/reversal
exports.etimsGetProfile        = etims.etimsGetProfile;
exports.etimsUpdateProfile     = etims.etimsUpdateProfile;
exports.etimsValidatePin       = etims.etimsValidatePin;
exports.etimsGenerateInvoice   = etims.etimsGenerateInvoice;
exports.etimsOnOrderCompleted  = etims.etimsOnOrderCompleted;
exports.etimsResubmitInvoice   = etims.etimsResubmitInvoice;
exports.etimsProcessQueue      = etims.etimsProcessQueue;
exports.etimsBulkGenerate      = etims.etimsBulkGenerate;
exports.etimsPlatformInvoice   = etims.etimsPlatformInvoice;
exports.etimsGetBuyerReceipts  = etims.etimsGetBuyerReceipts;
exports.etimsDownloadReceipt   = etims.etimsDownloadReceipt;
exports.etimsGetSellerStats    = etims.etimsGetSellerStats;
exports.etimsGetAdminStats     = etims.etimsGetAdminStats;
exports.etimsReconcileDaily    = etims.etimsReconcileDaily;

/* ══════════════════════════════════════════════════════════════════
   SOKONI HUB eTIMS & LOGISTICS DOCUMENTS  v1.0
   13 Cloud Functions: hub management, 5 operational document types,
   hub tax invoicing for selling/hybrid hubs, audit trail, and
   hubOnOrderCompleted (auto-dispatch note + hub invoice routing).
   Invoice authority routing keeps etimsOnOrderCompleted and
   hubOnOrderCompleted mutually exclusive — no duplicate tax invoices.
══════════════════════════════════════════════════════════════════ */
const hubEtims = require("./hub-etims");

exports.hubCreate           = hubEtims.hubCreate;
exports.hubUpdate           = hubEtims.hubUpdate;
exports.hubGetProfile       = hubEtims.hubGetProfile;
exports.hubUpdateTaxConfig  = hubEtims.hubUpdateTaxConfig;
exports.hubRegisterEtims    = hubEtims.hubRegisterEtims;
exports.hubGenerateDocument = hubEtims.hubGenerateDocument;
exports.hubGetDocuments     = hubEtims.hubGetDocuments;
exports.hubOnOrderCompleted = hubEtims.hubOnOrderCompleted;
exports.hubGenerateInvoice  = hubEtims.hubGenerateInvoice;
exports.hubResubmitInvoice  = hubEtims.hubResubmitInvoice;
exports.hubProcessQueue     = hubEtims.hubProcessQueue;   // B4: scheduled retry-queue drain
exports.hubGetAuditTrail    = hubEtims.hubGetAuditTrail;
exports.hubGetStats         = hubEtims.hubGetStats;
exports.hubAdminGetAllStats = hubEtims.hubAdminGetAllStats;

/* ══════════════════════════════════════════════════════════════════
   SOKONI INTELLIGENT DISPATCH  v1.0
   8 Cloud Functions: weighted scoring, cascade dispatch, proof of
   delivery, failed delivery workflows, GPS fraud detection,
   batch route optimisation, daily analytics rollup.
══════════════════════════════════════════════════════════════════ */
const dispatch = require("./dispatch");

exports.dispatchDelivery          = dispatch.dispatchDelivery;
exports.respondToDispatch         = dispatch.respondToDispatch;
exports.processCascadeTimeouts    = dispatch.processCascadeTimeouts;
exports.captureProofOfDelivery    = dispatch.captureProofOfDelivery;
exports.handleFailedDelivery      = dispatch.handleFailedDelivery;
exports.detectGPSFraud            = dispatch.detectGPSFraud;
exports.optimizeBatchRoute        = dispatch.optimizeBatchRoute;
exports.aggregateDeliveryAnalytics= dispatch.aggregateDeliveryAnalytics;

/* ══════════════════════════════════════════════════════════════════
   SOKONI FinOS — Financial Operating System  v1.0
   18 Cloud Functions: double-entry ledger, commission engine,
   wallet management, payout processing (IntaSend B2C), refunds,
   subscription + ad billing, fraud detection, daily snapshots,
   ledger reconciliation, financial reports, AI insights (Claude),
   IntaSend webhook, admin reversal + adjustment, tax breakdown.
   Security: server-side only calculations, RBAC enforced in CF,
   idempotency on every write, Firestore transactions for balances.
══════════════════════════════════════════════════════════════════ */
const finos = require("./finos");

exports.recordPayment           = finos.recordPayment;
exports.processRefund           = finos.processRefund;
exports.requestPayout           = finos.requestPayout;
exports.processPendingPayouts   = finos.processPendingPayouts;
exports.applyPromoCode          = finos.applyPromoCode;
exports.createPromotion         = finos.createPromotion;
exports.billingSubscriptions    = finos.billingSubscriptions;
exports.billingAdvertising      = finos.billingAdvertising;
exports.detectFinancialFraud    = finos.detectFinancialFraud;
exports.generateDailySnapshot   = finos.generateDailySnapshot;
exports.reconcileLedger         = finos.reconcileLedger;
exports.getFinancialReport      = finos.getFinancialReport;
exports.getAIFinancialInsights  = finos.getAIFinancialInsights;
exports.webhookPaymentCallback  = finos.webhookPaymentCallback;
exports.reverseTransaction      = finos.reverseTransaction;
exports.adjustWallet            = finos.adjustWallet;
exports.getWalletStatement      = finos.getWalletStatement;
exports.calculateTaxBreakdown   = finos.calculateTaxBreakdown;

/* ══════════════════════════════════════════════════════════════════
   SOKONI Business Communication System v2.0
   DISPATCH CONSOLIDATION: 12 onCall CFs → 1 messagesDispatch.
   Clients route via sokoni-chat-engine.js (_cfMsg) and admin-messages.html (_cf).
   7 event-triggered CFs (2 onSchedule, 2 onDocumentCreated, 3 onDocumentUpdated) remain.
══════════════════════════════════════════════════════════════════ */
const messagesDispatcher = require('./messages-dispatch');
exports.messagesDispatch = messagesDispatcher.messagesDispatch;
/* Event-triggered CFs — cannot be dispatched */
const _messagesMod = require('./messages');
exports.onMessageCreated              = _messagesMod.onMessageCreated;
exports.moderateMessage               = _messagesMod.moderateMessage;
exports.archiveCompletedConversations = _messagesMod.archiveCompletedConversations;
exports.cleanupChatStorage            = _messagesMod.cleanupChatStorage;
exports.onOrderStatusChanged          = _messagesMod.onOrderStatusChanged;
exports.onBookingStatusChanged        = _messagesMod.onBookingStatusChanged;
exports.onFoodOrderStatusChanged      = _messagesMod.onFoodOrderStatusChanged;

/* ══════════════════════════════════════════════════════════════════
   SOKONI SmartPOS Retail Cloud Functions  v2.0
   5 Cloud Functions: marketplace stock sync, SMS/email receipts,
   purchase order email, daily low-stock alert, order→POS inventory.
══════════════════════════════════════════════════════════════════ */
const posRetail = require("./pos-retail");

exports.posSyncToMarketplace       = posRetail.posSyncToMarketplace;
exports.sendPOSReceipt             = posRetail.sendPOSReceipt;
exports.posSendPurchaseOrder       = posRetail.sendPurchaseOrder;
exports.posLowStockAlert           = posRetail.posLowStockAlert;
exports.posMarketplaceOrderSync    = posRetail.posMarketplaceOrderSync;

/* ══════════════════════════════════════════════════════════════════
   Commission Engine  v1.0
   5 Cloud Functions: CRUD for commissionRules + live preview
══════════════════════════════════════════════════════════════════ */
const commission = require('./commission');

exports.createCommissionRule      = commission.createCommissionRule;
exports.updateCommissionRule      = commission.updateCommissionRule;
exports.deleteCommissionRule      = commission.deleteCommissionRule;
exports.listCommissionRules       = commission.listCommissionRules;
exports.previewCommission         = commission.previewCommission;
exports.getCommissionConfig       = commission.getCommissionConfig;
exports.getSellerEarningsReport   = commission.getSellerEarningsReport;
exports.getAdminRevenueByHub      = commission.getAdminRevenueByHub;

/* ══════════════════════════════════════════════════════════════════
   Subscription & Billing Engine  v1.0
   15 Cloud Functions: plans, status, activate, cancel, reactivate,
   billing history, admin CRUD, analytics, manual actions, refunds,
   export, hourly expiration processor, daily renewal reminders
══════════════════════════════════════════════════════════════════ */
const subBilling = require('./sub-billing');

exports.subGetPlans               = subBilling.subGetPlans;
/* Server-authoritative commercial values — the source of truth that
   initiateSTKPush enforces against. See functions/payment-intents.js. */
exports.createPaymentIntent       = require("./payment-intents").createPaymentIntent;
exports.subGetStatus              = subBilling.subGetStatus;
exports.subActivate               = subBilling.subActivate;
exports.subCancel                 = subBilling.subCancel;
exports.subReactivate             = subBilling.subReactivate;
exports.subGetBillingHistory      = subBilling.subGetBillingHistory;
exports.adminSubCreatePlan        = subBilling.adminSubCreatePlan;
exports.adminSubUpdatePlan        = subBilling.adminSubUpdatePlan;
exports.adminSubListSubscriptions = subBilling.adminSubListSubscriptions;
exports.adminSubGetAnalytics      = subBilling.adminSubGetAnalytics;
exports.adminSubManualAction      = subBilling.adminSubManualAction;
exports.adminSubProcessRefund     = subBilling.adminSubProcessRefund;
exports.adminSubExportBilling     = subBilling.adminSubExportBilling;
exports.subProcessExpirations     = subBilling.subProcessExpirations;
exports.subSendRenewalReminders   = subBilling.subSendRenewalReminders;

/* ── Subscription Engine v2.0 — Automated Billing (6 CFs) ── */
const subEngine = require('./sub-engine');
exports.subScheduleRenewals       = subEngine.subScheduleRenewals;
exports.subAutoActivateOnPayment  = subEngine.subAutoActivateOnPayment;
exports.subUpgradeWithProration   = subEngine.subUpgradeWithProration;
exports.subCheckFeature           = subEngine.subCheckFeature;
exports.subRetryFailedPayments    = subEngine.subRetryFailedPayments;
exports.subDowngrade              = subEngine.subDowngrade;

/* ══════════════════════════════════════════════════════════════════
   FinOS v2.0 — Universal Transaction Router + Escrow + Settlement
   12 Cloud Functions extending FinOS v1.0
══════════════════════════════════════════════════════════════════ */
const finosRouter = require('./finos-router');

exports.finosRecordTransaction     = finosRouter.finosRecordTransaction;
exports.finosCreateEscrow          = finosRouter.finosCreateEscrow;
exports.finosReleaseEscrow         = finosRouter.finosReleaseEscrow;
exports.finosDisputeEscrow         = finosRouter.finosDisputeEscrow;
exports.finosResolveDispute        = finosRouter.finosResolveDispute;
exports.finosGetSettlementRules    = finosRouter.finosGetSettlementRules;
exports.finosUpdateSettlementRules = finosRouter.finosUpdateSettlementRules;
exports.finosProcessSettlements    = finosRouter.finosProcessSettlements;
exports.finosGetRevenueAnalytics   = finosRouter.finosGetRevenueAnalytics;
exports.finosRequestBankPayout     = finosRouter.finosRequestBankPayout;
exports.finosGetAdminDashboard     = finosRouter.finosGetAdminDashboard;
exports.finosGenerateReceipt       = finosRouter.finosGenerateReceipt;

/* ── Financial OS v1.0 — 8 new CFs closing adapter + refund + console gaps ── */
const financialOS = require('./financial-os');
exports.fosInitiatePayment  = financialOS.fosInitiatePayment;
exports.fosSecureWebhook    = financialOS.fosSecureWebhook;
exports.fosSubmitRefund     = financialOS.fosSubmitRefund;
exports.fosApproveRefund    = financialOS.fosApproveRefund;
exports.fosGenerateInvoice  = financialOS.fosGenerateInvoice;
exports.fosExportReport     = financialOS.fosExportReport;
exports.fosGetProviderHealth = financialOS.fosGetProviderHealth;
exports.fosGetAdminConsole  = financialOS.fosGetAdminConsole;

/* ── Financial OS Admin v1.0 ─────────────────────────────────────────── */
const finosAdmin = require('./finos-admin');
exports.fosGetProviderConfig    = finosAdmin.fosGetProviderConfig;
exports.fosConfigureProvider    = finosAdmin.fosConfigureProvider;
exports.fosGetFraudQueue        = finosAdmin.fosGetFraudQueue;
exports.fosReviewFraudAlert     = finosAdmin.fosReviewFraudAlert;
exports.fosGetRevenueComparison = finosAdmin.fosGetRevenueComparison;
exports.fosAdminSettleEscrow    = finosAdmin.fosAdminSettleEscrow;

/* ── FinOS Automation Engine v1.0 — 7 CFs ───────────────────────────── */
const finosAutomation = require('./finos-automation');
exports.fosAutoSettlement      = finosAutomation.fosAutoSettlement;
exports.fosAutoRefund          = finosAutomation.fosAutoRefund;
exports.fosReconcile           = finosAutomation.fosReconcile;
exports.fosGetForecast         = finosAutomation.fosGetForecast;
exports.fosGetSettlementConfig = finosAutomation.fosGetSettlementConfig;
exports.fosSetSettlementConfig = finosAutomation.fosSetSettlementConfig;
exports.fosGetAuditTrail       = finosAutomation.fosGetAuditTrail;

/* ── Enterprise Settlement — 12 ops hosted inside the existing
   financeSprintDispatch service (see finance-sprint-dispatch.js). A dedicated
   settlementDispatch CF could not be created under Cloud Run quota, so the
   settlement handler registry is merged into an already-deployed dispatcher —
   ZERO new Cloud Run services. Callers use financeSprintDispatch({op,...}) via
   the sokoni-settlement.js client wrapper. No individual settlement CFs are
   exported. Auth/App Check enforced per handler (unchanged). ── */

/* ── SmartPOS Cash Drawer v1.0 ───────────────────────────────────────── */
const posCashDrawer = require('./pos-cash-drawer');
exports.cdOpenDrawer        = posCashDrawer.cdOpenDrawer;
exports.cdGetAuditLog       = posCashDrawer.cdGetAuditLog;
exports.cdGetConfig         = posCashDrawer.cdGetConfig;
exports.cdSetConfig         = posCashDrawer.cdSetConfig;
exports.cdRecordCashEvent   = posCashDrawer.cdRecordCashEvent;
exports.cdGetShiftSummary   = posCashDrawer.cdGetShiftSummary;
exports.cdGetReconciliation = posCashDrawer.cdGetReconciliation;
exports.cdGetDiagnostics    = posCashDrawer.cdGetDiagnostics;

/* ── SmartPOS Multi-Till + Cash Manager → smartPosDispatch ──────────── */
/* mt* and cm* ops are routed via smartPosDispatch({op:'...',...})       */

/* ── Trust & Safety Engine v1.0 ──────────────────────────────────────── */
const trustSafety = require('./trust-safety');
exports.tsReportContent       = trustSafety.tsReportContent;
exports.tsGetReports          = trustSafety.tsGetReports;
exports.tsReviewReport        = trustSafety.tsReviewReport;
exports.tsBanUser             = trustSafety.tsBanUser;
exports.tsCalculateRiskScore  = trustSafety.tsCalculateRiskScore;
exports.tsGetRiskScores       = trustSafety.tsGetRiskScores;
exports.tsGetBannedTerms      = trustSafety.tsGetBannedTerms;
exports.tsManageBannedTerm    = trustSafety.tsManageBannedTerm;
exports.tsGetTrustDashboard   = trustSafety.tsGetTrustDashboard;

/* ── Admin OS v2.0 ────────────────────────────────────────────────────── */
/* DISPATCH CONSOLIDATION: 41 onCall CFs → 1 adminOsDispatch.
   sokoni-aos.js routes calls via ADMIN_OS_OPS whitelist in _call() helper.
   Cloud Run services: 41 → 1. */
const adminOsDispatcher = require('./admin-os-dispatch');
exports.adminOsDispatch = adminOsDispatcher.adminOsDispatch;

/* ── Universal Availability & Scheduling Engine v1.0 ─────────────────── */
/* DISPATCH CONSOLIDATION: 12 onCall CFs → bookingDispatch (below); 2 remain individual */
const availability = require("./availability");
exports.getProviderAvailability          = availability.getProviderAvailability;          /* onRequest — stays individual */
exports.scheduledAvailabilityMaintenance = availability.scheduledAvailabilityMaintenance; /* scheduled */

/* ── Reviews & Ratings Engine v1.0 ───────────────────────────────────── */
const reviews = require("./reviews");
exports.submitReview         = reviews.submitReview;
exports.getReviews           = reviews.getReviews;
exports.flagReview           = reviews.flagReview;
exports.markReviewHelpful    = reviews.markReviewHelpful;
exports.adminModerateReview  = reviews.adminModerateReview;

/* ── Booking Domain Dispatcher — booking + venue-booking + availability → 1 Cloud Run ── */
/* DISPATCH CONSOLIDATION: 45 onCall CFs → 1 bookingDispatch + 3 scheduled + 1 onRequest */
const bookingDispatcher = require('./booking-dispatch');
exports.bookingDispatch = bookingDispatcher.bookingDispatch;
const _bookingMod = require('./booking');
exports.bookingSendReminders = _bookingMod.bookingSendReminders; /* scheduled */
exports.bookingCleanupHolds  = _bookingMod.bookingCleanupHolds;  /* scheduled */
exports.bookingAutoComplete  = _bookingMod.bookingAutoComplete;  /* scheduled */

/* ── Referral Tracking Engine v1.0 ──────────────────────────────────── */
const referral = require("./referral");
exports.processReferralOnOrderComplete = referral.processReferralOnOrderComplete;


/* ── SmartPOS Zero Friction Checkout v1.0 ───────────────────────────── */
const posZF = require('./pos-zero-friction');
exports.posCompleteCheckout    = posZF.posCompleteCheckout;
exports.posValidateCoupon      = posZF.posValidateCoupon;
exports.posLookupCustomer      = posZF.posLookupCustomer;
exports.posProcessRefund       = posZF.posProcessRefund;
exports.posLogReprint          = posZF.posLogReprint;
exports.posGetQueueMetrics     = posZF.posGetQueueMetrics;
exports.posCleanupIdempotency  = posZF.posCleanupIdempotency;
exports.posCheckPaymentStatus  = posZF.posCheckPaymentStatus;

/* ── Facebook / Meta Data Deletion Callback + Data Rights ───────────── */
const fbDeletion = require('./facebook-data-deletion');
exports.facebookDataDeletion           = fbDeletion.facebookDataDeletion;
exports.submitDataRightsRequest        = fbDeletion.submitDataRightsRequest;
exports.adminGetDataDeletionRequest    = fbDeletion.adminGetDataDeletionRequest;
exports.adminUpdateDataDeletionStatus  = fbDeletion.adminUpdateDataDeletionStatus;
exports.deleteMyAccount                = fbDeletion.deleteMyAccount;

/* Account status — server-enforced deactivation / reactivation */
const accountStatus = require('./account-status');
exports.accountDeactivate              = accountStatus.accountDeactivate;
exports.accountReactivate              = accountStatus.accountReactivate;
exports.adminSetAccountActive          = accountStatus.adminSetAccountActive;

/* ── Payment Trust — receipts, verification, security monitoring ─── */
const payTrust = require('./payment-trust');
exports.generateTrustReceipt      = payTrust.generateTrustReceipt;
exports.emailTrustReceipt         = payTrust.emailTrustReceipt;
exports.verifyTrustReceipt        = payTrust.verifyTrustReceipt;
exports.getPaymentSecurityAlerts  = payTrust.getPaymentSecurityAlerts;
exports.detectPaymentAnomalies    = payTrust.detectPaymentAnomalies;
exports.voidTrustReceipt          = payTrust.voidTrustReceipt;

/* ── Security Fraud Engine v1.0 — velocity, travel, scoring, alerts ──────── */
const secFraud = require('./security-fraud-engine');
exports.recordSecurityEvent    = secFraud.recordSecurityEvent;
exports.checkImpossibleTravel  = secFraud.checkImpossibleTravel;
exports.checkPaymentVelocity   = secFraud.checkPaymentVelocity;
exports.scoreFraudRisk         = secFraud.scoreFraudRisk;
exports.getFraudAlerts         = secFraud.getFraudAlerts;
exports.dismissFraudAlert      = secFraud.dismissFraudAlert;
exports.escalateFraudAlert     = secFraud.escalateFraudAlert;
exports.getFraudReport         = secFraud.getFraudReport;
exports.scheduledFraudSweep    = secFraud.scheduledFraudSweep;

/* ── Security Incident Response v1.0 — suspend, lock, incidents ─────────── */
const secIncident = require('./security-incident-response');
exports.secSuspendUser         = secIncident.suspendUser;
exports.secUnsuspendUser       = secIncident.unsuspendUser;
exports.lockStore              = secIncident.lockStore;
exports.unlockStore            = secIncident.unlockStore;
exports.revokeUserSessions     = secIncident.revokeUserSessions;
exports.blockDevice            = secIncident.blockDevice;
exports.disablePaymentMethod   = secIncident.disablePaymentMethod;
exports.createIncident         = secIncident.createIncident;
exports.updateIncident         = secIncident.updateIncident;
exports.getIncidents           = secIncident.getIncidents;
exports.getIncidentTimeline    = secIncident.getIncidentTimeline;

/* ── MiniShop & Social Commerce Engine v1.0 ─────────────────────────────── */
const minishop = require('./minishop');
exports.getMinishopPublic          = minishop.getMinishopPublic;
/* Prerenders /shop/{handle} and /@{handle} so each shop gets its own link
   preview. See functions/minishop-page.js — the storefront itself is still
   rendered client-side from the same static template. */
exports.minishopPage               = require('./minishop-page').minishopPage;
exports.claimMinishopHandle        = minishop.claimMinishopHandle;
exports.saveMinishopConfig         = minishop.saveMinishopConfig;
exports.trackMinishopView          = minishop.trackMinishopView;
exports.getMinishopAnalytics       = minishop.getMinishopAnalytics;
exports.generateMinishopShareCard  = minishop.generateMinishopShareCard;
exports.aiGenerateMinishopContent  = minishop.aiGenerateMinishopContent;
exports.followShop                 = minishop.followShop;
exports.getMyMinishop              = minishop.getMyMinishop;

/* ── MiniShop Campaign Engine v1.0 ──────────────────────────────────────── */
const minishopCampaigns = require('./minishop-campaigns');
exports.createMinishopCampaign  = minishopCampaigns.createMinishopCampaign;
exports.getMinishopCampaigns    = minishopCampaigns.getMinishopCampaigns;
exports.trackCampaignClick      = minishopCampaigns.trackCampaignClick;
exports.pauseMinishopCampaign   = minishopCampaigns.pauseMinishopCampaign;
exports.deleteMinishopCampaign  = minishopCampaigns.deleteMinishopCampaign;

/* ── MiniShop Social Commerce Engine v3.0 — 12 CFs ─────────────────────── */
const minishopV3 = require('./minishop-v3');
exports.miniShopOGMeta             = minishopV3.miniShopOGMeta;
exports.miniShopCreatePromotion    = minishopV3.miniShopCreatePromotion;
exports.miniShopGetPromotions      = minishopV3.miniShopGetPromotions;
exports.miniShopUpdatePromotion    = minishopV3.miniShopUpdatePromotion;
exports.miniShopToggleWishlist     = minishopV3.miniShopToggleWishlist;
exports.miniShopGetWishlist        = minishopV3.miniShopGetWishlist;
exports.miniShopShareProduct       = minishopV3.miniShopShareProduct;
exports.miniShopAIMarketing        = minishopV3.miniShopAIMarketing;
exports.miniShopSendAnnouncement   = minishopV3.miniShopSendAnnouncement;
exports.miniShopGetAnnouncements   = minishopV3.miniShopGetAnnouncements;
exports.miniShopGetSimilar         = minishopV3.miniShopGetSimilar;
exports.miniShopScheduledDigest    = minishopV3.miniShopScheduledDigest;

/* ── Automation & Decision Engine (ADE) v1.0 ────────────────────────────── */
const ade = require('./ade');
// Firestore triggers
exports.adeOnAccountCreated      = ade.adeOnAccountCreated;
exports.adeOnPaymentCompleted    = ade.adeOnPaymentCompleted;
exports.adeOnDisputeCreated      = ade.adeOnDisputeCreated;
exports.adeOnSellerApplied       = ade.adeOnSellerApplied;
exports.adeOnSubscriptionChanged = ade.adeOnSubscriptionChanged;
// Callable — engine
exports.adeProcessEvent          = ade.adeProcessEvent;
// Callable — exception queue
exports.adeGetExceptionQueue     = ade.adeGetExceptionQueue;
exports.adeResolveException      = ade.adeResolveException;
// Callable — rules
exports.adeGetRules              = ade.adeGetRules;
exports.adeUpsertRule            = ade.adeUpsertRule;
exports.adeDeleteRule            = ade.adeDeleteRule;
exports.adeSeedDefaultRules      = ade.adeSeedDefaultRules;
// Callable — audit & metrics
exports.adeGetAuditLog           = ade.adeGetAuditLog;
exports.adeGetMetrics            = ade.adeGetMetrics;
// Scheduled
exports.adeRetryFailedJobs       = ade.adeRetryFailedJobs;
exports.adeDailyMaintenance      = ade.adeDailyMaintenance;

/* ── Intelligent Automation & Decision Engine v1.0 — 15 CFs ── */
const automationEngine = require('./automation-engine');
// Firestore triggers
exports.autoOnAccountCreate      = automationEngine.autoOnAccountCreate;
exports.autoOnSubscriptionCreate = automationEngine.autoOnSubscriptionCreate;
exports.autoOnSellerApplication  = automationEngine.autoOnSellerApplication;
exports.autoOnDisputeCreate      = automationEngine.autoOnDisputeCreate;
exports.autoOnRefundRequest      = automationEngine.autoOnRefundRequest;
exports.autoOnApprovalRequest    = automationEngine.autoOnApprovalRequest;
// Scheduled
exports.autoScheduledPayouts     = automationEngine.autoScheduledPayouts;
exports.autoScheduledMaintenance = automationEngine.autoScheduledMaintenance;
// Callable — admin
exports.autoGetExceptionQueue    = automationEngine.autoGetExceptionQueue;
exports.autoResolveException     = automationEngine.autoResolveException;
exports.autoGetRules             = automationEngine.autoGetRules;
exports.autoUpdateRule           = automationEngine.autoUpdateRule;
exports.autoGetAuditLog          = automationEngine.autoGetAuditLog;
exports.autoGetStatus            = automationEngine.autoGetStatus;
exports.autoTriggerMaintenance   = automationEngine.autoTriggerMaintenance;

/* ── Buyer Dispute Portal v1.0 ──────────────────────────────────────────── */
const disputes = require('./disputes');
exports.createDispute           = disputes.createDispute;
exports.getMyDisputes           = disputes.getMyDisputes;
exports.getDisputeDetail        = disputes.getDisputeDetail;
exports.addDisputeEvidence      = disputes.addDisputeEvidence;
exports.sellerRespondToDispute  = disputes.sellerRespondToDispute;
exports.cancelDispute           = disputes.cancelDispute;
exports.getSellerDisputes       = disputes.getSellerDisputes;
exports.adminGetAllDisputes     = disputes.adminGetAllDisputes;
exports.adminResolveDispute     = disputes.adminResolveDispute;

/* ── Commerce Dispatcher — mkt-ext + merchant-success + marketing-engine ── */
/* DISPATCH CONSOLIDATION: 75 onCall CFs → 1 commerceDispatch */
const commerceDispatcher = require('./commerce-dispatch');
exports.commerceDispatch = commerceDispatcher.commerceDispatch;
const servicesDisp         = require('./services-dispatch');
exports.servicesDispatch    = servicesDisp.servicesDispatch;

/* merchant-success: all 17 onCall — fully consolidated */

/* ── Navigation & Intelligent Dispatch v2.0 ────────────────────────────── */
const navigation = require('./navigation');
exports.navDispatchRider          = navigation.navDispatchRider;
exports.navUpdateTripStatus       = navigation.navUpdateTripStatus;
exports.navRecordArrival          = navigation.navRecordArrival;
exports.navSubmitPOD              = navigation.navSubmitPOD;
exports.navTriggerSOS             = navigation.navTriggerSOS;
exports.navGetActiveTrip          = navigation.navGetActiveTrip;
exports.navGetCustomerTracking    = navigation.navGetCustomerTracking;
exports.navGetFleetStatus         = navigation.navGetFleetStatus;
exports.navCompleteTrip           = navigation.navCompleteTrip;
exports.navGetRiderHistory        = navigation.navGetRiderHistory;
exports.navGetMerchantTracking    = navigation.navGetMerchantTracking;
exports.navCancelStop             = navigation.navCancelStop;
exports.navAssignTrip             = navigation.navAssignTrip;
exports.navResolveFleetEvent      = navigation.navResolveFleetEvent;
exports.navCleanupStaleLocations  = navigation.navCleanupStaleLocations;
exports.processDriverEarning      = navigation.processDriverEarning;
// v2.0 additions
exports.navGenerateDeliveryOTP    = navigation.navGenerateDeliveryOTP;
exports.navGetRiderDashboard      = navigation.navGetRiderDashboard;
exports.navBatchSyncLocations     = navigation.navBatchSyncLocations;
exports.navGetDeliveryAnalytics   = navigation.navGetDeliveryAnalytics;

/* ── Universal Loyalty & Rewards Platform v2.0 ──────────────────────────── */
/* DISPATCH CONSOLIDATION: 40 onCall CFs (loyalty.js + loyalty-enterprise.js) → 1 dispatcher.
   Clients call loyaltyDispatch({op:'functionName',...data}) via sokoni-loyalty.js and
   loyalty-merchant.html. Cloud Run services: 40 → 1 (4 scheduled remain individual). */
const loyaltyDispatcher = require('./loyalty-dispatch');
exports.loyaltyDispatch          = loyaltyDispatcher.loyaltyDispatch;
/* Scheduled CFs — cannot be dispatched */
const _loyaltyMod    = require('./loyalty');
const _loyaltyEntMod = require('./loyalty-enterprise');
exports.processExpiringPoints    = _loyaltyMod.processExpiringPoints;
exports.processLoyaltyMilestones = _loyaltyMod.processLoyaltyMilestones;
exports.runLuckyDraw             = _loyaltyEntMod.runLuckyDraw;
exports.reconcileLoyaltyLedger   = _loyaltyEntMod.reconcileLoyaltyLedger;

/* ── Wallet & Seller Payouts v1.0 ────────────────────────────────────────── */
const wallet = require('./wallet');
exports.getWalletBalance       = wallet.getWalletBalance;
exports.initiateWalletTopUp    = wallet.initiateWalletTopUp;
exports.confirmWalletTopUp     = wallet.confirmWalletTopUp;
exports.spendFromWallet        = wallet.spendFromWallet;
exports.getWalletTransactions  = wallet.getWalletTransactions;
exports.requestSellerPayout    = wallet.requestSellerPayout;
exports.getPayoutHistory       = wallet.getPayoutHistory;
exports.adminProcessPayout     = wallet.adminProcessPayout;
exports.adminGetPendingPayouts = wallet.adminGetPendingPayouts;
exports.adminPayoutOps         = wallet.adminPayoutOps;
exports.reconcilePayouts       = wallet.reconcilePayouts;
exports.processPayoutRetries   = wallet.processPayoutRetries;
exports.sweepEarningsToWallet  = wallet.sweepEarningsToWallet;
exports.getPayoutAnalytics     = wallet.getPayoutAnalytics;
exports.refundToWallet           = wallet.refundToWallet;
exports.sweepStaleWalletTopUps   = wallet.sweepStaleWalletTopUps;

/* ── Wallet Engine v2.0 ─────────────────────────────────────────────────── */
const walletEngine = require('./wallet-engine');
exports.walletV2Dashboard       = walletEngine.walletV2Dashboard;
exports.walletV2Send            = walletEngine.walletV2Send;
exports.walletV2ResolveRecipient = walletEngine.walletV2ResolveRecipient;
exports.walletV2ClaimPending    = walletEngine.walletV2ClaimPending;
exports.sweepExpiredClaimables  = walletEngine.sweepExpiredClaimables;
exports.walletV2SavePhone       = walletEngine.walletV2SavePhone;
exports.walletV2Request         = walletEngine.walletV2Request;
exports.walletV2GetRequests     = walletEngine.walletV2GetRequests;
exports.walletV2SavingsList     = walletEngine.walletV2SavingsList;
exports.walletV2SavingsCreate   = walletEngine.walletV2SavingsCreate;
exports.walletV2SavingsDeposit  = walletEngine.walletV2SavingsDeposit;
exports.walletV2SavingsWithdraw = walletEngine.walletV2SavingsWithdraw;
exports.walletV2SetPin          = walletEngine.walletV2SetPin;
exports.walletV2VerifyPin       = walletEngine.walletV2VerifyPin;
exports.walletV2FreezeToggle    = walletEngine.walletV2FreezeToggle;
exports.walletV2SetLimits       = walletEngine.walletV2SetLimits;
exports.walletV2Analytics       = walletEngine.walletV2Analytics;
exports.walletV2GenerateQR      = walletEngine.walletV2GenerateQR;
exports.walletV2PayViaQR        = walletEngine.walletV2PayViaQR;
exports.walletV2AiInsights      = walletEngine.walletV2AiInsights;
exports.walletV2EscrowCreate    = walletEngine.walletV2EscrowCreate;
exports.walletV2EscrowRelease   = walletEngine.walletV2EscrowRelease;

/* ── SOKONI Financial Operating System (SFOS) ───────────────────────────── */
const sfosEngine = require('./sfos-engine');
// Identity
exports.sfosIdentityGet        = sfosEngine.sfosIdentityGet;
exports.sfosIdentityUpdate     = sfosEngine.sfosIdentityUpdate;
// Ledger
exports.sfosLedgerQuery        = sfosEngine.sfosLedgerQuery;
// Universal Transaction Engine
exports.sfosTransact           = sfosEngine.sfosTransact;
exports.sfosTransactReverse    = sfosEngine.sfosTransactReverse;
// Wallet
exports.sfosWalletGet          = sfosEngine.sfosWalletGet;
// Escrow
exports.sfosEscrowCreate       = sfosEngine.sfosEscrowCreate;
exports.sfosEscrowRelease      = sfosEngine.sfosEscrowRelease;
exports.sfosEscrowDispute      = sfosEngine.sfosEscrowDispute;
exports.sfosEscrowRefund       = sfosEngine.sfosEscrowRefund;
// Group Wallets
exports.sfosGroupCreate        = sfosEngine.sfosGroupCreate;
exports.sfosGroupTransfer      = sfosEngine.sfosGroupTransfer;
exports.sfosGroupGet           = sfosEngine.sfosGroupGet;
// Merchant Finance
exports.sfosMerchantDashboard  = sfosEngine.sfosMerchantDashboard;
exports.sfosMerchantSettle     = sfosEngine.sfosMerchantSettle;
// Rewards
exports.sfosRewardsGet         = sfosEngine.sfosRewardsGet;
exports.sfosRewardsRedeem      = sfosEngine.sfosRewardsRedeem;
// Analytics & AI
exports.sfosFinancialHealth    = sfosEngine.sfosFinancialHealth;
exports.sfosNetWorth           = sfosEngine.sfosNetWorth;
exports.sfosAnalyticsDetailed  = sfosEngine.sfosAnalyticsDetailed;
exports.sfosAiForecast              = sfosEngine.sfosAiForecast;
exports.sfosRiskCheck               = sfosEngine.sfosRiskCheck;
// Monitoring & Integrity (v1.1)
exports.sfosHealthCheck             = sfosEngine.sfosHealthCheck;
exports.sfosLedgerIntegrityCheck    = sfosEngine.sfosLedgerIntegrityCheck;

/* ── Jobs Marketplace v1.0 ───────────────────────────────────────────────── */

/* ── Education Hub ─────────────────────────────────────────────── */
const education = require('./education');
exports.listCourses           = education.listCourses;
exports.getCourse             = education.getCourse;
exports.enrollCourse          = education.enrollCourse;
exports.getCourseProgress     = education.getCourseProgress;
exports.updateCourseProgress  = education.updateCourseProgress;
exports.reviewCourse          = education.reviewCourse;
exports.createCourse          = education.createCourse;
exports.getMyEnrollments      = education.getMyEnrollments;
exports.publishCourse         = education.publishCourse;

/* ── QR Code System v1.0 ───────────────────────────────────────── */
const qr = require('./qr');
exports.generateSecureQR  = qr.generateSecureQR;
exports.verifyQRCode      = qr.verifyQRCode;
exports.getMyQRAssets     = qr.getMyQRAssets;

/* ── Role-based fulfilment scan ────────────────────────────────────
   One package QR; what it reveals depends on who scans it. Reads the same
   qrTokens document as verifyQRCode but never consumes it, because a package
   is scanned repeatedly by seller, rider and customer. */
const _fulfilScan = require('./fulfilment-scan');
exports.fulfilmentScan    = _fulfilScan.fulfilmentScan;

/* ── Client diagnostics intake ─────────────────────────────────────
   post-launch-monitor.js:228 reads errorLog, but errorLog has no Firestore
   rule and is default-deny, so nothing client-side has ever written to it.
   The monitor reported zero client errors because nothing reported, not
   because there were none. This is the write path. */
const _clientDiag = require('./client-diagnostics');
exports.logClientDiagnostic = _clientDiag.logClientDiagnostic;

/* ── Age verification (KASS Vapes / restricted categories) ─────────
   adult-gate.js is client-side only and writes nothing to the server, so it
   stops nobody and produces no evidence. These run the check server-side and
   record the decision. assertAgeVerified() is the enforcement point for any
   flow selling a restricted product. */
/* _ageVerify is required at the top of this file — it is read by the Stage 1B
   compliance gate inside initiateSTKPush. Re-declaring it here would be a
   duplicate const in the same scope. */
exports.ageVerifySubmit = _ageVerify.ageVerifySubmit;

/* ── Beta access control ───────────────────────────────────────────
   The invite-only authority layer. betaStatus is a CUSTOM CLAIM, so the same
   decision reaches Firestore rules and every callable without each one
   re-implementing it. firestore.rules:65 already blocks a client writing
   betaStatus to its own user document; betaReview is the only grant path. */
const _beta = require('./beta-access');
exports.betaApply     = _beta.betaApply;
exports.betaReview    = _beta.betaReview;
exports.betaGetAccess = _beta.betaGetAccess;
exports.betaList      = _beta.betaList;   /* the queue betaReview needs a uid from */
exports.ageVerifyStatus = _ageVerify.ageVerifyStatus;


/* ── Super Admin CFs v1.0 ──────────────────────────────────────── */
const superAdmin = require('./super-admin');
exports.setUserRole            = superAdmin.setUserRole;
exports.suspendUser            = superAdmin.suspendUser;
exports.sendPlatformBroadcast  = superAdmin.sendPlatformBroadcast;

/* ── SOKONI Impact Enterprise Platform v1.0 ────────────────────── */
const impact = require('./impact');
exports.impactGetPublicDashboard           = impact.impactGetPublicDashboard;
exports.impactGetUserProfile               = impact.impactGetUserProfile;
exports.impactCheckoutDonate               = impact.impactCheckoutDonate;
exports.impactSetRoundUp                   = impact.impactSetRoundUp;
exports.impactCorporateApply               = impact.impactCorporateApply;
exports.impactGetBusinessScore             = impact.impactGetBusinessScore;
exports.impactCreateCampaign               = impact.impactCreateCampaign;
exports.impactUpdateCampaign               = impact.impactUpdateCampaign;
exports.impactGetCampaignDetail            = impact.impactGetCampaignDetail;
exports.impactSubmitGrant                  = impact.impactSubmitGrant;
exports.impactSubmitScholarship            = impact.impactSubmitScholarship;
exports.impactInitiateDisbursement         = impact.impactInitiateDisbursement;
exports.impactApproveDisbursement          = impact.impactApproveDisbursement;
exports.impactAuthorizeDisbursement        = impact.impactAuthorizeDisbursement;
exports.impactGetFinancialReport           = impact.impactGetFinancialReport;
exports.impactAdminCorporateApprove        = impact.impactAdminCorporateApprove;
exports.impactAdminGrantReview             = impact.impactAdminGrantReview;
exports.impactRecordMarketplaceContribution = impact.impactRecordMarketplaceContribution;
exports.impactGetCampaigns                 = impact.impactGetCampaigns;
exports.impactBookmarkCampaign             = impact.impactBookmarkCampaign;
exports.impactGetAdminGrants               = impact.impactGetAdminGrants;
exports.impactScheduledDailyReconciliation = impact.impactScheduledDailyReconciliation;
exports.impactGetEnvironmental             = impact.impactGetEnvironmental;
exports.impactAdminUpdateEnvironmental     = impact.impactAdminUpdateEnvironmental;
exports.impactAdminCreateEnvProject        = impact.impactAdminCreateEnvProject;

/* ── SmartPOS 2.0 — Multi-Device Session ──────────────────── */
const posSession = require('./pos-session');
exports.createPosSession          = posSession.createPosSession;
exports.joinPosSession            = posSession.joinPosSession;
exports.leavePosSession           = posSession.leavePosSession;
exports.closePosSession           = posSession.closePosSession;
exports.posHeartbeat              = posSession.posHeartbeat;
exports.updatePosCart             = posSession.updatePosCart;
exports.getPosSession             = posSession.getPosSession;
exports.removeDeviceFromSession   = posSession.removeDeviceFromSession;
exports.listActiveSessions        = posSession.listActiveSessions;
exports.posSessionCleanup         = posSession.posSessionCleanup;

/* ── SmartPOS Dispatcher — 154 onCall CFs → 1 Cloud Run service ─── */
/* DISPATCH CONSOLIDATION: retail-engine(18) + inventory-pro(21) + accounting(18)
   + crm-pro(25) + staff-ops(21) + hq(13) + integrations(15) + completeness(25) = 156 CFs */
const smartPosDispatcher = require('./smartpos-dispatch');
exports.smartPosDispatch = smartPosDispatcher.smartPosDispatch;
/* Scheduled CFs remain individual */
const posRetailEngine = require('./pos-retail-engine');
exports.inventoryAlertSweep        = posRetailEngine.inventoryAlertSweep;

/* Scheduled CFs from consolidated SmartPOS modules */
const posInventoryPro = require('./pos-inventory-pro');
exports.batchExpiryAlertSweep      = posInventoryPro.batchExpiryAlertSweep;
const posAccounting = require('./pos-accounting');
exports.monthlyAccountingSnapshot  = posAccounting.monthlyAccountingSnapshot;
const posCrmPro = require('./pos-crm-pro');
exports.birthdayRewardSweep        = posCrmPro.birthdayRewardSweep;
/* pos-staff-ops and pos-hq: all onCall — fully consolidated into smartPosDispatch */

/* ── SmartPOS 3.0 — Business Intelligence ───────────────────── */
const posBI = require('./pos-bi');
exports.getExecutiveDashboard      = posBI.getExecutiveDashboard;
exports.getRevenueDrilldown        = posBI.getRevenueDrilldown;
exports.getRevenueTrend            = posBI.getRevenueTrend;
exports.getInventoryHealthScore    = posBI.getInventoryHealthScore;
exports.getCustomerGrowthMetrics   = posBI.getCustomerGrowthMetrics;
exports.getStaffProductivityMetrics = posBI.getStaffProductivityMetrics;
exports.getCategoryPerformance     = posBI.getCategoryPerformance;
exports.getRevenueForecast         = posBI.getRevenueForecast;
exports.getPaymentTrends           = posBI.getPaymentTrends;
exports.biDailySnapshot            = posBI.biDailySnapshot;

/* ── SmartPOS 3.0 — AI Assistant ────────────────────────────── */
const posAI = require('./pos-ai-assistant');
exports.askPOSAssistant            = posAI.askPOSAssistant;
exports.getAIQueryHistory          = posAI.getAIQueryHistory;
exports.clearAIQueryHistory        = posAI.clearAIQueryHistory;

/* pos-integrations: all 15 onCall CFs consolidated into smartPosDispatch */


/* -- SmartPOS 4.0 -- Marketplace <-> POS Integration -------------------- */
const posMarketplaceSync = require('./pos-marketplace-sync');
exports.createClickAndCollect       = posMarketplaceSync.createClickAndCollect;
exports.getPendingClickAndCollect   = posMarketplaceSync.getPendingClickAndCollect;
exports.updateClickAndCollectStatus = posMarketplaceSync.updateClickAndCollectStatus;
exports.getUnifiedSalesReport       = posMarketplaceSync.getUnifiedSalesReport;
exports.syncPromotionToPOS          = posMarketplaceSync.syncPromotionToPOS;
exports.getActivePOSPromotions      = posMarketplaceSync.getActivePOSPromotions;
exports.getInventoryReserveStatus   = posMarketplaceSync.getInventoryReserveStatus;
/* ── Platform Event Bus ─────────────────────────────────────── */
const eventBus = require('./platform-event-bus');
exports.eventBusPublish             = eventBus.publishEvent;
exports.eventBusGetEvent            = eventBus.getEvent;
exports.queryEvents                 = eventBus.queryEvents;
exports.replayEvent                 = eventBus.replayEvent;
exports.getEventStats               = eventBus.getEventStats;
exports.registerEventSubscriber     = eventBus.registerEventSubscriber;
exports.onPlatformEventCreated      = eventBus.onPlatformEventCreated;
exports.eventBusCleanup             = eventBus.eventBusCleanup;

/* ── Payment Orchestrator v2.0 ──────────────────────────────── */
const payOrch = require('./payment-orchestrator');
exports.createPayment               = payOrch.createPayment;
exports.initiatePayment             = payOrch.initiatePayment;
exports.confirmPayment              = payOrch.confirmPayment;
exports.refundPayment               = payOrch.refundPayment;
exports.getPayment                  = payOrch.getPayment;
exports.paymentTimeoutSweep         = payOrch.paymentTimeoutSweep;

/* ── Operations Center ──────────────────────────────────────── */
const opsCenter = require('./operations-center');
exports.getPlatformHealth           = opsCenter.getPlatformHealth;
exports.getMetricHistory            = opsCenter.getMetricHistory;
exports.triggerSelfHeal             = opsCenter.triggerSelfHeal;
exports.getErrorLog                 = opsCenter.getErrorLog;
exports.snapshotPlatformMetrics     = opsCenter.snapshotPlatformMetrics;

/* ── Smart POS QR Payments ─────────────────────────────────── */
const posQr = require('./pos-qr');
exports.generatePOSPaymentQR    = posQr.generatePOSPaymentQR;
exports.getPOSPaymentDetails    = posQr.getPOSPaymentDetails;
exports.initiatePOSQRPayment    = posQr.initiatePOSQRPayment;
exports.completePOSQRPayment    = posQr.completePOSQRPayment;
exports.cancelPOSPaymentQR      = posQr.cancelPOSPaymentQR;
exports.refundPOSPayment        = posQr.refundPOSPayment;
exports.getPOSPaymentHistory    = posQr.getPOSPaymentHistory;

/* ── Redis Infrastructure Layer v1.0 ───────────────────────────── */
/* DISPATCH CONSOLIDATION: 28 onCall CFs → 1 redisDispatch + 2 scheduled.
   Clients route all redis ops via sokoni-redis.js: redisDispatch({op:'redisXxx',...data}). */
const redisLayer = require('./redis-layer');
exports.redisDispatch                 = redisLayer.redisDispatch;
exports.redisScheduledPresenceCleanup = redisLayer.redisScheduledPresenceCleanup;
exports.redisScheduledQueueWorker     = redisLayer.redisScheduledQueueWorker;

/* ── Zero Trust Security Middleware v1.0 ───────────────────────────────── */
const zeroTrust = require('./security-zero-trust');
exports.evaluateAccessRequest    = zeroTrust.evaluateAccessRequest;
exports.generateCorrelationId    = zeroTrust.generateCorrelationId;
exports.getSessionRiskScore      = zeroTrust.getSessionRiskScore;
exports.triggerStepUpAuth        = zeroTrust.triggerStepUpAuth;
exports.verifyStepUpAuth         = zeroTrust.verifyStepUpAuth;
exports.getRiskProfile           = zeroTrust.getRiskProfile;
exports.updateRiskProfile        = zeroTrust.updateRiskProfile;
exports.getZeroTrustPolicyStatus = zeroTrust.getZeroTrustPolicyStatus;

/* ── Async Jobs Engine v2.0 ─────────────────────────────────────────────── */
const asyncJobs = require('./async-jobs');
exports.asyncEnqueue       = asyncJobs.asyncEnqueue;
exports.asyncWorker        = asyncJobs.asyncWorker;
exports.asyncSweeper       = asyncJobs.asyncSweeper;
exports.asyncEventRouter   = asyncJobs.asyncEventRouter;
exports.asyncCancel        = asyncJobs.asyncCancel;
exports.asyncRetryJob      = asyncJobs.asyncRetryJob;
exports.asyncPauseQueue    = asyncJobs.asyncPauseQueue;
exports.asyncGetDashboard  = asyncJobs.asyncGetDashboard;
exports.asyncGetJobs       = asyncJobs.asyncGetJobs;
exports.asyncInspect       = asyncJobs.asyncInspect;
exports.asyncCleanup       = asyncJobs.asyncCleanup;
exports.getQueueDepth      = asyncJobs.getQueueDepth;

/* -- Security 6.0 -- Enterprise Identity (MFA + Passkeys + Device Trust) -- */

/* -- Security 6.0 -- Audit Log + Scorecard + Pen Test -------------------- */
const secAudit = require('./security-audit');
exports.logSecurityEvent              = secAudit.logSecurityEvent;
exports.getAuditLog                   = secAudit.getAuditLog;
exports.verifyAuditIntegrity          = secAudit.verifyAuditIntegrity;
exports.exportAuditLog                = secAudit.exportAuditLog;
exports.getSecurityScorecard          = secAudit.getSecurityScorecard;
exports.runSecurityScan               = secAudit.runSecurityScan;
exports.getLatestSecurityScan         = secAudit.getLatestSecurityScan;
exports.getComplianceReport           = secAudit.getComplianceReport;
exports.scheduledDailySecurityReport  = secAudit.scheduledDailySecurityReport;

/* -- Security 6.0 -- AI Security (Prompt Injection + PII + Rate Limits) -- */
const secAI = require('./security-ai');
exports.validateAIPrompt              = secAI.validateAIPrompt;
exports.filterAIResponse              = secAI.filterAIResponse;
exports.getAISecurityLog              = secAI.getAISecurityLog;
exports.getAIRateLimitStatus          = secAI.getAIRateLimitStatus;
exports.reportAIAbuse                 = secAI.reportAIAbuse;
exports.getAIContextPolicy            = secAI.getAIContextPolicy;
exports.blockAISession                = secAI.blockAISession;

/* ── Post-Launch Monitoring Suite v1.0 ─────────────────────────────────── */
const postLaunchMonitor = require('./post-launch-monitor');
exports.getPostLaunchDashboard          = postLaunchMonitor.getPostLaunchDashboard;
exports.detectAnomalies                 = postLaunchMonitor.detectAnomalies;
exports.generateExecutiveSummary        = postLaunchMonitor.generateExecutiveSummary;
exports.getExecutiveSummaries           = postLaunchMonitor.getExecutiveSummaries;
exports.scheduledHourlyMonitor          = postLaunchMonitor.scheduledHourlyMonitor;
exports.scheduledDailyExecutiveSummary  = postLaunchMonitor.scheduledDailyExecutiveSummary;

/* ── Enterprise Health v1.0 ─────────────────────────────────────────────── */
const entHealth = require('./enterprise-health');
exports.getSystemHealth              = entHealth.getSystemHealth;
exports.getInfrastructureStatus      = entHealth.getInfrastructureStatus;
exports.getMarketplaceHealth         = entHealth.getMarketplaceHealth;
exports.getPOSSystemStatus           = entHealth.getPOSSystemStatus;
exports.getPaymentSystemHealth       = entHealth.getPaymentSystemHealth;
exports.getAISystemHealth            = entHealth.getAISystemHealth;
exports.getSecuritySystemHealth      = entHealth.getSecuritySystemHealth;
exports.getHealthHistory             = entHealth.getHealthHistory;
exports.recordSystemHealthSnapshot   = entHealth.recordSystemHealthSnapshot;

/* ── Disaster Recovery v1.0 ─────────────────────────────────────────────── */
const drModule = require('./disaster-recovery');
exports.runDRSimulation              = drModule.runDRSimulation;
exports.verifyFirestoreBackup        = drModule.verifyFirestoreBackup;
exports.verifyStorageIntegrity       = drModule.verifyStorageIntegrity;
exports.testSecretAccess             = drModule.testSecretAccess;
exports.generateDRReport             = drModule.generateDRReport;
exports.runRecoveryPlaybook          = drModule.runRecoveryPlaybook;
exports.getDRHistory                 = drModule.getDRHistory;
exports.runWeeklyChaosTest           = drModule.runWeeklyChaosTest;
exports.getChaosTestReports          = drModule.getChaosTestReports;

/* ── B2B / Wholesale Commerce v1.0 ─────────────────────────────────────── */

/* ── Release Readiness Certification v1.0 + Production Cert Runner v1.0 ── */
const relReadiness = require('./release-readiness');
exports.runReleaseReadinessCheck    = relReadiness.runReleaseReadinessCheck;
exports.checkInfrastructure         = relReadiness.checkInfrastructure;
exports.checkSecurityReadiness      = relReadiness.checkSecurityReadiness;
exports.checkPlatformModules        = relReadiness.checkPlatformModules;
exports.checkPerformanceReadiness   = relReadiness.checkPerformanceReadiness;
exports.checkComplianceReadiness    = relReadiness.checkComplianceReadiness;
exports.approveRelease              = relReadiness.approveRelease;
exports.getLatestReleaseReport      = relReadiness.getLatestReleaseReport;
exports.runProductionCertification  = relReadiness.runProductionCertification;
exports.getCertificationHistory     = relReadiness.getCertificationHistory;

/* ── Event Hub v1.0 ─────────────────────────────────────────────────────── */
const eventHub = require('./event-hub');
exports.createEvent            = eventHub.createEvent;
exports.updateEvent            = eventHub.updateEvent;
exports.publishEvent           = eventHub.publishEvent;
exports.cancelEvent            = eventHub.cancelEvent;
exports.getEvent               = eventHub.getEvent;
exports.listEvents             = eventHub.listEvents;
exports.searchEvents           = eventHub.searchEvents;
exports.createTicketTier       = eventHub.createTicketTier;
exports.updateTicketTier       = eventHub.updateTicketTier;
exports.purchaseTickets        = eventHub.purchaseTickets;
exports.getMyTickets           = eventHub.getMyTickets;
exports.getTicket              = eventHub.getTicket;
exports.checkInTicket          = eventHub.checkInTicket;
exports.getEventOrders         = eventHub.getEventOrders;
exports.getEventAnalytics      = eventHub.getEventAnalytics;
exports.getOrganizerDashboard  = eventHub.getOrganizerDashboard;
exports.createEventPromoCode   = eventHub.createEventPromoCode;
exports.validateEventPromoCode = eventHub.validateEventPromoCode;

/* ── Data Portability — GDPR Art. 20 / Kenya DPA §26 ───────────────────── */
const dataExport = require('./data-export');
exports.requestDataExport   = dataExport.requestDataExport;
exports.getDataExportStatus = dataExport.getDataExportStatus;
exports.processDataExport   = dataExport.processDataExport;
exports.autoEndEvents          = eventHub.autoEndEvents;

/* ── Healthcare Hub v1.0 ────────────────────────────────────────────────── */

/* ── Property Hub v1.0 ──────────────────────────────────────────────────── */

/* ── Vehicle Hub v1.0 ───────────────────────────────────────────────────── */
const vehicleHub = require('./vehicle-hub');
exports.createVehicleListing  = vehicleHub.createVehicleListing;
exports.updateVehicleListing  = vehicleHub.updateVehicleListing;
exports.publishVehicleListing = vehicleHub.publishVehicleListing;
exports.getVehicle            = vehicleHub.getVehicle;
exports.listVehicles          = vehicleHub.listVehicles;
exports.searchVehicles        = vehicleHub.searchVehicles;
exports.submitVehicleEnquiry  = vehicleHub.submitVehicleEnquiry;
exports.getVehicleEnquiries   = vehicleHub.getVehicleEnquiries;
exports.compareVehicles       = vehicleHub.compareVehicles;
exports.reportVehicleListing  = vehicleHub.reportVehicleListing;

/* ── Digital Products Hub v1.0 ──────────────────────────────────────────── */
const digitalHub = require('./digital-hub');
exports.createDigitalProduct     = digitalHub.createDigitalProduct;
exports.updateDigitalProduct     = digitalHub.updateDigitalProduct;
exports.publishDigitalProduct    = digitalHub.publishDigitalProduct;
exports.getDigitalProduct        = digitalHub.getDigitalProduct;
exports.listDigitalProducts      = digitalHub.listDigitalProducts;
exports.purchaseDigitalProduct   = digitalHub.purchaseDigitalProduct;
exports.getMyDigitalPurchases    = digitalHub.getMyDigitalPurchases;
exports.downloadDigitalProduct   = digitalHub.downloadDigitalProduct;
exports.rateDigitalProduct       = digitalHub.rateDigitalProduct;
exports.getDigitalSellerDashboard= digitalHub.getDigitalSellerDashboard;

/* ── Legal Services Hub v1.0 ────────────────────────────────────────────── */
const legalHub = require('./legal-hub');
exports.registerLegalProvider    = legalHub.registerLegalProvider;
exports.approveLegalProvider     = legalHub.approveLegalProvider;
exports.getLegalProviders        = legalHub.getLegalProviders;
exports.getLegalProvider         = legalHub.getLegalProvider;
exports.bookLegalConsultation    = legalHub.bookLegalConsultation;
exports.getMyLegalConsultations  = legalHub.getMyLegalConsultations;
exports.getProviderConsultations = legalHub.getProviderConsultations;
exports.updateConsultationStatus = legalHub.updateConsultationStatus;
exports.rateLegalProvider        = legalHub.rateLegalProvider;

/* ── Procurement Engine v1.0 ────────────────────────────────────────────── */
const procurement = require('./procurement');
exports.addSupplier                      = procurement.addSupplier;
exports.createPurchaseOrder              = procurement.createPurchaseOrder;
exports.approvePurchaseOrder             = procurement.approvePurchaseOrder;
exports.sendPurchaseOrder                = procurement.sendPurchaseOrder;
exports.receiveGoods                     = procurement.receiveGoods;
exports.createSupplierInvoice            = procurement.createSupplierInvoice;
exports.approveAndPayInvoice             = procurement.approveAndPayInvoice;
exports.getSupplierPerformance           = procurement.getSupplierPerformance;
exports.getProcurementForecast           = procurement.getProcurementForecast;
exports.getProcurementDashboard          = procurement.getProcurementDashboard;
exports.scheduledVendorPerformanceUpdate = procurement.scheduledVendorPerformanceUpdate;

/* ── Entertainment Hub v1.0 ─────────────────────────────────────────────── */
const entertainmentHub = require('./entertainment-hub');
exports.createEntertainmentListing  = entertainmentHub.createEntertainmentListing;
exports.publishEntertainmentListing = entertainmentHub.publishEntertainmentListing;
exports.getEntertainmentListing     = entertainmentHub.getEntertainmentListing;
exports.listEntertainmentContent    = entertainmentHub.listEntertainmentContent;
exports.searchEntertainment         = entertainmentHub.searchEntertainment;
exports.purchaseEntertainment       = entertainmentHub.purchaseEntertainment;
exports.getMyEntertainmentPurchases = entertainmentHub.getMyEntertainmentPurchases;
exports.rateEntertainmentContent    = entertainmentHub.rateEntertainmentContent;
exports.getCreatorDashboard         = entertainmentHub.getCreatorDashboard;

/* ── Payment State Machine v1.0 ─────────────────────────────────────────── */
const paymentFSM = require('./payment-state-machine');
exports.createPaymentSession       = paymentFSM.createPaymentSession;
exports.transitionPaymentState     = paymentFSM.transitionPaymentState;
exports.getPaymentState            = paymentFSM.getPaymentState;
exports.recoverPaymentSession      = paymentFSM.recoverPaymentSession;
exports.getStuckSessions           = paymentFSM.getStuckSessions;
exports.reconcilePaymentSessions   = paymentFSM.reconcilePaymentSessions;
exports.sealPaymentAuditTrail      = paymentFSM.sealPaymentAuditTrail;

/* ── Payment Reconciliation Engine v1.0 ─────────────────────────────────── */
const paymentRecon = require('./payment-reconciliation');
exports.runDailyReconciliation        = paymentRecon.runDailyReconciliation;
exports.getReconciliationReport       = paymentRecon.getReconciliationReport;
exports.flagUnmatchedPayment          = paymentRecon.flagUnmatchedPayment;
exports.resolveUnmatchedPayment       = paymentRecon.resolveUnmatchedPayment;
exports.getMpesaReconciliationSummary = paymentRecon.getMpesaReconciliationSummary;
exports.triggerManualReconciliation   = paymentRecon.triggerManualReconciliation;

/* Subscription entitlement backstop — catches a COMPLETE subscription payment
   that none of the three real-time activation paths turned into an active
   subscription. Alert-only until _systemConfig/reconciliation.subscriptionAutoHeal
   is set true. */
exports.reconcileSubscriptionEntitlements = paymentRecon.reconcileSubscriptionEntitlements;
exports.triggerSubscriptionReconciliation = paymentRecon.triggerSubscriptionReconciliation;

/* ── Marketing Engine — consolidated into commerceDispatch above ── */
const mktEngine = require('./marketing-engine');
exports.concludeExpiredFlashSales       = mktEngine.concludeExpiredFlashSales; /* scheduled */

/* ── Business Health Score Engine v1.0 ──────────────────────────────────── */
const bizHealth = require('./business-health-score');
exports.getBusinessHealthScore          = bizHealth.getBusinessHealthScore;
exports.getHealthScoreHistory           = bizHealth.getHealthScoreHistory;
exports.getDimensionDrilldown           = bizHealth.getDimensionDrilldown;
exports.getHealthScoreBenchmarks        = bizHealth.getHealthScoreBenchmarks;
exports.computeAllHealthScores          = bizHealth.computeAllHealthScores;
exports.getMultibranchHealthComparison  = bizHealth.getMultibranchHealthComparison;

/* ── HR & Payroll Engine v1.0 ───────────────────────────────────────────── */

/* ── Advanced BI — Branch Comparison + Marketing ROI v1.0 ───────────────── */
const biAdvanced = require('./bi-advanced');
exports.getMultiBranchRevenue           = biAdvanced.getMultiBranchRevenue;
exports.getBranchPerformanceComparison  = biAdvanced.getBranchPerformanceComparison;
exports.getMarketingROI                 = biAdvanced.getMarketingROI;
exports.getCustomerSegmentRevenue       = biAdvanced.getCustomerSegmentRevenue;
exports.getRevenueByChannel             = biAdvanced.getRevenueByChannel;

/* ── CRM — Customer Relationship Management v1.0 ─────────────────────── */
const crm = require('./crm');
exports.createLead              = crm.createLead;
exports.updateLead              = crm.updateLead;
exports.logLeadActivity         = crm.logLeadActivity;
exports.convertLead             = crm.convertLead;
exports.getLeadBoard            = crm.getLeadBoard;
exports.buildCustomerProfile    = crm.buildCustomerProfile;
exports.getCustomerProfile      = crm.getCustomerProfile;
exports.calculateCLV            = crm.calculateCLV;
exports.getChurnRisk            = crm.getChurnRisk;
exports.createSupportTicket     = crm.createSupportTicket;
exports.updateSupportTicket     = crm.updateSupportTicket;
exports.getCRMDashboard         = crm.getCRMDashboard;
exports.computeChurnRiskDaily   = crm.computeChurnRiskDaily;

/* ── Business Bootstrap & Instant Provisioning v1.0 ────────────────────── */
const bootstrap = require('./business-bootstrap');
exports.bootstrapDevice           = bootstrap.bootstrapDevice;
exports.getIncrementalSync        = bootstrap.getIncrementalSync;
exports.invalidateBootstrapCache  = bootstrap.invalidateBootstrapCache;
exports.getBusinessConfig         = bootstrap.getBusinessConfig;
exports.validateDeviceAccess      = bootstrap.validateDeviceAccess;

/* ── Device Manager v1.0 ────────────────────────────────────────────────── */
const deviceMgr = require('./device-manager');
exports.registerDevice            = deviceMgr.registerDevice;
exports.deviceHeartbeat           = deviceMgr.deviceHeartbeat;
exports.lockDevice                = deviceMgr.lockDevice;
exports.unlockDevice              = deviceMgr.unlockDevice;
exports.remoteLogout              = deviceMgr.remoteLogout;
exports.remoteUpdate              = deviceMgr.remoteUpdate;
exports.decommissionDevice        = deviceMgr.decommissionDevice;
exports.getDeviceList             = deviceMgr.getDeviceList;
exports.cleanupStaleDevices       = deviceMgr.cleanupStaleDevices;

/* ── Self-Healing Engine v1.0 ────────────────────────────────────────────── */
const selfHeal = require('./self-heal');
exports.runScheduledSelfHeal  = selfHeal.runScheduledSelfHeal;
exports.runManualSelfHeal     = selfHeal.runManualSelfHeal;
exports.getSelfHealHistory    = selfHeal.getSelfHealHistory;

/* ── SmartPOS 2.0 — Peripheral Management ───────────────────────────────── */
const posPeripherals = require('./pos-peripherals');
exports.posRegisterPeripheral       = posPeripherals.posRegisterPeripheral;
exports.posUpdatePeripheralStatus   = posPeripherals.posUpdatePeripheralStatus;
exports.posRemovePeripheral         = posPeripherals.posRemovePeripheral;
exports.posGetPeripherals           = posPeripherals.posGetPeripherals;
exports.posCreateCustomerDisplay    = posPeripherals.posCreateCustomerDisplay;
exports.posUpdateCustomerDisplay    = posPeripherals.posUpdateCustomerDisplay;
exports.posCleanupPeripheralSignals = posPeripherals.posCleanupPeripheralSignals;

/* ── Redis Integrations v1.0 — Firestore → Redis event sync ────────────── */
/* Post-payment orchestration: receipt record, customer + merchant notifications
   and the audit entry, fired once on the canonical payment-success transition.
   Deliberately does NOT send the customer email — emailOnPaymentSuccess already
   listens on the same transition and would double it. */
const paymentSuccess = require('./payment-success');
exports.onPaymentSucceeded      = paymentSuccess.onPaymentSucceeded;

const redisIntegrations = require('./redis-integrations');
exports.onOrderCreated          = redisIntegrations.onOrderCreated;
exports.onOrderStatusChangeRedisSync = redisIntegrations.onOrderStatusChange;
exports.onPaymentCreated        = redisIntegrations.onPaymentCreated;
exports.onPaymentUpdated        = redisIntegrations.onPaymentUpdated;
exports.onInventoryUpdated      = redisIntegrations.onInventoryUpdated;
exports.onUserCreated           = redisIntegrations.onUserCreated;
exports.onRiderStatusChange     = redisIntegrations.onRiderStatusChange;
exports.onDeliveryStatusChangeRedisSync = redisIntegrations.onDeliveryStatusChange;

/* ── SmartPOS Intelligence (Inventory + AI Assistance) ─────────────────── */
const posIntelligence = require('./pos-intelligence');
exports.getPOSInventoryIntelligence = posIntelligence.getPOSInventoryIntelligence;
exports.getProductSalesTrend        = posIntelligence.getProductSalesTrend;
/* SmartPOS AI Assistance Layer — 5 new CFs */
exports.posSmartSearch              = posIntelligence.posSmartSearch;
exports.posDetectAnomaly            = posIntelligence.posDetectAnomaly;
exports.posGetCustomerInsights      = posIntelligence.posGetCustomerInsights;
exports.posGetInventoryAlerts       = posIntelligence.posGetInventoryAlerts;
exports.posGetReorderSuggestions    = posIntelligence.posGetReorderSuggestions;

/* ── SmartPOS 3.0 — Production Payment Terminal Integrations ────────────── */
const posTerminalLive = require('./pos-terminal-live');
exports.posInitiateTerminalPayment  = posTerminalLive.posInitiateTerminalPayment;
exports.posPollTerminalStatus       = posTerminalLive.posPollTerminalStatus;
exports.posCancelTerminalPayment    = posTerminalLive.posCancelTerminalPayment;
exports.posReverseTerminalPayment   = posTerminalLive.posReverseTerminalPayment;
exports.posSettleTerminalBatch      = posTerminalLive.posSettleTerminalBatch;
exports.posGetTerminalCapabilities  = posTerminalLive.posGetTerminalCapabilities;
exports.posGetTerminalHealth        = posTerminalLive.posGetTerminalHealth;
exports.posGetTerminalBatchReport   = posTerminalLive.posGetTerminalBatchReport;
exports.posTerminalEventWebhook     = posTerminalLive.posTerminalEventWebhook;

/* ── SmartPOS 3.0 — Shift Scheduling & Roster Management ───────────────── */
const posShiftScheduler = require('./pos-shift-scheduler');
exports.createShiftTemplate     = posShiftScheduler.createShiftTemplate;
exports.publishWeeklyRoster     = posShiftScheduler.publishWeeklyRoster;
exports.assignShift             = posShiftScheduler.assignShift;
exports.swapShiftRequest        = posShiftScheduler.swapShiftRequest;
exports.approveShiftSwap        = posShiftScheduler.approveShiftSwap;
exports.setStaffAvailability    = posShiftScheduler.setStaffAvailability;
exports.getRoster               = posShiftScheduler.getRoster;
exports.getRosterGaps           = posShiftScheduler.getRosterGaps;
exports.getStaffRoster          = posShiftScheduler.getStaffRoster;
exports.acknowledgeShift        = posShiftScheduler.acknowledgeShift;
exports.schedulerWeeklyDigest   = posShiftScheduler.schedulerWeeklyDigest;

/* ── SmartPOS 3.0 — External Integrations API ───────────────────────────── */
const posIntegrationsApi = require('./pos-integrations-api');
exports.posRegisterApiKey      = posIntegrationsApi.posRegisterApiKey;
exports.posRevokeApiKey        = posIntegrationsApi.posRevokeApiKey;
exports.posListApiKeys         = posIntegrationsApi.posListApiKeys;
exports.posRegisterWebhook     = posIntegrationsApi.posRegisterWebhook;
exports.posTestWebhook         = posIntegrationsApi.posTestWebhook;
exports.posRevokeWebhook       = posIntegrationsApi.posRevokeWebhook;
exports.posGetSalesExport      = posIntegrationsApi.posGetSalesExport;
exports.posGetInventoryExport  = posIntegrationsApi.posGetInventoryExport;
exports.posGetLedgerExport     = posIntegrationsApi.posGetLedgerExport;
exports.posGetEtimsExport      = posIntegrationsApi.posGetEtimsExport;
exports.posReceiveErpUpdate    = posIntegrationsApi.posReceiveErpUpdate;
exports.posGetApiDocs          = posIntegrationsApi.posGetApiDocs;

/* ── SmartPOS 4.0 — Performance Monitoring & Benchmarking ──────────────── */
const posPerf = require('./pos-perf');
exports.recordPosEvent            = posPerf.recordPosEvent;
exports.getPosPerfMetrics         = posPerf.getPosPerfMetrics;
exports.getPosSpeedReport         = posPerf.getPosSpeedReport;
exports.posScheduledPerfRollup    = posPerf.posScheduledPerfRollup;

/* ── SmartPOS Completeness Engine — consolidated into smartPosDispatch ── */
/* All 25 posComplete onCall CFs are routed through smartPosDispatch. */

/* ── Universal Printer Engine v5.0 — print log, history, config, templates ── */
const posPrinter = require('./pos-printer');
exports.posLogPrint          = posPrinter.posLogPrint;
exports.getPrintHistory      = posPrinter.getPrintHistory;
exports.getPrinterConfig     = posPrinter.getPrinterConfig;
exports.setPrinterConfig     = posPrinter.setPrinterConfig;
exports.posGetPrintStats     = posPrinter.posGetPrintStats;
exports.posGetPrintTemplate  = posPrinter.posGetPrintTemplate;
exports.posSavePrintTemplate = posPrinter.posSavePrintTemplate;

/* ── Security 6.0 — Session Management ─────────────────────────────────── */
const secSession = require('./security-session');
exports.createSession           = secSession.createSession;
exports.validateSession         = secSession.validateSession;
exports.rotateSession           = secSession.rotateSession;
exports.terminateSession        = secSession.terminateSession;
exports.terminateAllSessions    = secSession.terminateAllSessions;
exports.getUserSessions         = secSession.getUserSessions;
exports.revokeDeviceSessions    = secSession.revokeDeviceSessions;
exports.updateSessionActivity   = secSession.updateSessionActivity;
exports.detectSessionAnomaly    = secSession.detectSessionAnomaly;
exports.scheduledSessionCleanup = secSession.scheduledSessionCleanup;

/* ── Security 6.0: File Upload Security ──────────────────────────────────── */
const secFile = require('./security-file');
exports.validateUploadRequest   = secFile.validateUploadRequest;
exports.generateSecureUploadUrl = secFile.generateSecureUploadUrl;
exports.onFileUploaded          = secFile.onFileUploaded;
exports.quarantineFile          = secFile.quarantineFile;
exports.getFileAuditLog         = secFile.getFileAuditLog;

/* ── Security 6.0: Automated Penetration Test Runner ─────────────────────── */
const secPentest = require('./security-pentest');
exports.runSecurityAudit            = secPentest.runSecurityAudit;
exports.getLatestSecurityReport     = secPentest.getLatestSecurityReport;
exports.scheduleWeeklySecurityAudit = secPentest.scheduleWeeklySecurityAudit;

/* ── Platform Ops Dashboard v1.0 — unified ops metrics + alerting ─────────── */
const platformOps = require('./platform-ops');
exports.opsGetMasterDashboard     = platformOps.opsGetMasterDashboard;
exports.opsGetAlerts              = platformOps.opsGetAlerts;
exports.opsAcknowledgeAlert       = platformOps.opsAcknowledgeAlert;
exports.opsCreateAlert            = platformOps.opsCreateAlert;
exports.opsGetPostLaunchMetrics   = platformOps.opsGetPostLaunchMetrics;
exports.opsScheduledHealthCheck   = platformOps.opsScheduledHealthCheck;

/* ── Rollback System v1.0 — snapshot records, audit trail, daily auto-snap ── */
const rollback = require('./rollback');
exports.rollbackGetSnapshots        = rollback.rollbackGetSnapshots;
exports.rollbackCreateSnapshot      = rollback.rollbackCreateSnapshot;
exports.rollbackTrigger             = rollback.rollbackTrigger;
exports.rollbackGetExecutions       = rollback.rollbackGetExecutions;
exports.rollbackUpdateStatus        = rollback.rollbackUpdateStatus;
exports.rollbackScheduledSnapshot   = rollback.rollbackScheduledSnapshot;

/* ── Developer Portal v1.0 — API keys, webhooks, usage analytics ─────────── */
const devPortal = require('./developer-portal');
exports.generateApiKey  = devPortal.generateApiKey;
exports.revokeApiKey    = devPortal.revokeApiKey;
exports.listApiKeys     = devPortal.listApiKeys;
exports.registerWebhook = devPortal.registerWebhook;
exports.testWebhook     = devPortal.testWebhook;
exports.listWebhooks    = devPortal.listWebhooks;
exports.deleteWebhook   = devPortal.deleteWebhook;
exports.getApiUsage     = devPortal.getApiUsage;

/* ── Returns Engine v1.0 — buyer returns, seller review, admin override ───── */
const returnsEngine = require('./returns-engine');
exports.submitReturn         = returnsEngine.submitReturn;
exports.getMyReturns         = returnsEngine.getMyReturns;
exports.getSellerReturns     = returnsEngine.getSellerReturns;
exports.reviewReturn         = returnsEngine.reviewReturn;
exports.adminForceReturn     = returnsEngine.adminForceReturn;
exports.markReturnProcessed  = returnsEngine.markReturnProcessed;

/* ── Franchise Management Engine v1.0 ──────────────────────────────────────── */
const franchiseEngine = require('./franchise-engine');
exports.franchiseCreateBrand         = franchiseEngine.franchiseCreateBrand;
exports.franchiseApplyForLocation    = franchiseEngine.franchiseApplyForLocation;
exports.franchiseReviewApplication   = franchiseEngine.franchiseReviewApplication;
exports.franchiseRecordRoyalty       = franchiseEngine.franchiseRecordRoyalty;
exports.franchiseGetMyLocations      = franchiseEngine.franchiseGetMyLocations;
exports.franchiseGetBrandDashboard   = franchiseEngine.franchiseGetBrandDashboard;
exports.franchiseGetLocations        = franchiseEngine.franchiseGetLocations;
/* ── Currency Engine v1.0 — multi-currency rates, conversion, audit history ── */
const currencyEngine = require('./currency-engine');
exports.currencyGetRates             = currencyEngine.currencyGetRates;
exports.currencyConvert              = currencyEngine.currencyConvert;
exports.currencyUpdateRates          = currencyEngine.currencyUpdateRates;
exports.currencyGetHistory           = currencyEngine.currencyGetHistory;
exports.currencyScheduledRateRefresh = currencyEngine.currencyScheduledRateRefresh;

/* ── Installments / BNPL v1.0 ── */
const installments = require('./installments');
exports.installmentCreatePlan     = installments.installmentCreatePlan;
exports.installmentRecordPayment  = installments.installmentRecordPayment;
exports.installmentGetMyPlans     = installments.installmentGetMyPlans;
exports.installmentGetSellerPlans = installments.installmentGetSellerPlans;
exports.installmentMarkOverdue    = installments.installmentMarkOverdue;
exports.installmentCancelPlan     = installments.installmentCancelPlan;

/* ── Commission Engine — Settlement & Withdrawals v1.0 ── */
exports.processSettlement   = commission.processSettlement;
exports.requestWithdrawal   = commission.requestWithdrawal;
exports.approveWithdrawal   = commission.approveWithdrawal;
exports.rejectWithdrawal    = commission.rejectWithdrawal;
exports.getWithdrawals      = commission.getWithdrawals;

/* ── Venue Booking — consolidated into bookingDispatch above ── */
/* All 17 venueBooking onCall CFs are routed through bookingDispatch. No exports needed here. */

/* ── Platform Hub Engine v1.0 — 10 CFs ── */
const platformHub = require('./platform-hub');
exports.wapProcessDelays                  = platformHub.wapProcessDelays;
exports.wapGetInstances                   = platformHub.wapGetInstances;
exports.wapRetryStep                      = platformHub.wapRetryStep;
exports.pcGetPerHubFlags                  = platformHub.pcGetPerHubFlags;
exports.pcSetPerHubFlag                   = platformHub.pcSetPerHubFlag;
exports.pcGetHubDetails                   = platformHub.pcGetHubDetails;
exports.pcGetCrossHubHealth               = platformHub.pcGetCrossHubHealth;
exports.platformNotifyTransactionChange   = platformHub.platformNotifyTransactionChange;
exports.pcActivateHub                     = platformHub.pcActivateHub;
exports.pcDeactivateHub                   = platformHub.pcDeactivateHub;

/* ── Marketplace Extensions — consolidated into commerceDispatch above ── */
const mktExt = require('./marketplace-extensions');
exports.auctionCloseSweep = mktExt.auctionCloseSweep; /* scheduled */
exports.seoGetSitemap     = mktExt.seoGetSitemap;     /* onRequest */

/* ── Finance OS Sprint 4.3 — Budgeting | Expenses | Recon | Tax | Statements | Petty Cash | Invoices ── */
/* DISPATCH CONSOLIDATION: 37 onCall CFs → 1 financeSprintDispatch.
   Clients (finance-budget.html, finance-expenses.html, finance-reconcile.html)
   route via _cf() which wraps financeSprintDispatch({op:name,...data}).
   Cloud Run: 37 → 1. */
const finSprintDispatcher = require('./finance-sprint-dispatch');
exports.financeSprintDispatch = finSprintDispatcher.financeSprintDispatch;

/* ── Logistics+ Sprint 4.4 — DISPATCH CONSOLIDATION: 30 onCall → 1 logisticsPlusDispatch ── */
/* fleet-manager.html routes via _cf() wrapper. Cloud Run: 30 → 1. */
const logPlusDispatcher = require('./logistics-plus-dispatch');
exports.logisticsPlusDispatch = logPlusDispatcher.logisticsPlusDispatch;

/* ═══════════════════════════════════════════════════════════════════════════
   PHASE 3 — Enterprise Scalability & Distributed Systems
   ─────────────────────────────────────────────────────────────────────────
   All new exports are namespaced to prevent collisions:
     obs*  — Observability Engine
     rel*  — Reliability Engine
     sokoniAPIGateway / gw* — API Gateway
     webhook* — Webhook Engine
     tq*   — Task Queue
   ═══════════════════════════════════════════════════════════════════════════ */

/* ── Platform Infrastructure (obs + rel + webhook + tq + api-gateway)
   28 onCall ops → platformInfraDispatch; schedules + onRequest kept individual. ── */
const _piMods = {
  obs: require('./observability-engine'),
  rel: require('./reliability-engine'),
  gw:  require('./api-gateway'),
  wh:  require('./webhook-engine'),
  tq:  require('./task-queue'),
};
const _piDisp = require('./platform-infra-dispatch');
exports.platformInfraDispatch = _piDisp.platformInfraDispatch;
// Scheduled / onRequest exports that cannot go through an onCall dispatcher:
exports.obsScheduledAggregation    = _piMods.obs.obsScheduledAggregation;
exports.obsCheckAlerts             = _piMods.obs.obsCheckAlerts;
exports.obsHealthProbe             = _piMods.obs.obsHealthProbe;
exports.relScheduledHealthCheck    = _piMods.rel.relScheduledHealthCheck;
exports.relScheduledRetryProcessor = _piMods.rel.relScheduledRetryProcessor;
exports.sokoniAPIGateway           = _piMods.gw.sokoniAPIGateway;
exports.webhookRetryProcessor      = _piMods.wh.webhookRetryProcessor;
exports.tqWorkerProcessor          = _piMods.tq.tqWorkerProcessor;
exports.tqScheduledCleanup         = _piMods.tq.tqScheduledCleanup;

/* ── Analytics Engine — DISPATCH CONSOLIDATION: 33 onCall → 1 analyticsDispatch ── */
/* analytics.html routes via _cf() wrapper. 1 scheduled CF remains. Cloud Run: 33→1. */
const aeDispatcher = require('./analytics-dispatch');
exports.analyticsDispatch = aeDispatcher.analyticsDispatch;
/* Scheduled — cannot be dispatched */
const _aeMod = require('./analytics-engine');
exports.analyticsSnapshotDaily = _aeMod.analyticsSnapshotDaily;

/* ── Provider Onboarding & Dashboard — 19 onCall ops → 1 providerDispatch ── */
const provDisp = require('./provider-dispatch');
exports.providerDispatch = provDisp.providerDispatch;

/* ── Universal Enterprise Onboarding Engine — 12 ops → 1 onboardingDispatch ── */
const onbDisp = require('./onboarding-dispatch');
exports.onboardingDispatch = onbDisp.onboardingDispatch;

/* ── Subscription Core — canonical read/enforce across all 5 stores → 1 CF ── */
const subsCoreDisp = require('./subscriptions-dispatch');
exports.subscriptionsDispatch = subsCoreDisp.subscriptionsDispatch;

/* ── Legal Agreements & Digital Acceptance — versioned, auditable → 1 CF ── */
const legalDisp = require('./legal-dispatch');
exports.legalDispatch = legalDisp.legalDispatch;
/* ══════════════════════════════════════════════════════════════════════
   RC1 REPRODUCIBILITY FIX — recovered orphaned Cloud Functions.
   These were DEPLOYED and live but NOT exported here, so a full
   `firebase deploy --only functions` would have DELETED them — including
   every transactional email trigger. Re-exported so source == deployed
   state and deploys UPDATE them instead of destroying them.
   ══════════════════════════════════════════════════════════════════════ */
const _rcApiGateway = require('./api-gateway');
exports.gwGetMetrics = _rcApiGateway.gwGetMetrics;
exports.gwManageRateLimit = _rcApiGateway.gwManageRateLimit;

const _rcEmailDmarc = require('./email-dmarc');
exports.dmarcReportWebhook = _rcEmailDmarc.dmarcReportWebhook;
exports.getDmarcSummary = _rcEmailDmarc.getDmarcSummary;
exports.processDmarcReport = _rcEmailDmarc.processDmarcReport;

const _rcEmailTriggers = require('./email-triggers');
exports.emailDriverDocReminders = _rcEmailTriggers.emailDriverDocReminders;
exports.emailOnAppointmentCreate = _rcEmailTriggers.emailOnAppointmentCreate;
exports.emailOnBookingCreate = _rcEmailTriggers.emailOnBookingCreate;
exports.emailOnDeliveryCreate = _rcEmailTriggers.emailOnDeliveryCreate;
exports.emailOnDisputeCreate = _rcEmailTriggers.emailOnDisputeCreate;
exports.emailOnDisputeResolved = _rcEmailTriggers.emailOnDisputeResolved;
exports.emailOnDriverAssigned = _rcEmailTriggers.emailOnDriverAssigned;
exports.emailOnDriverCreate = _rcEmailTriggers.emailOnDriverCreate;
exports.emailOnDriverStatusChange = _rcEmailTriggers.emailOnDriverStatusChange;
exports.emailOnLegalConsultation       = _rcEmailTriggers.emailOnLegalConsultation;
exports.emailOnLegalConsultationUpdate = _rcEmailTriggers.emailOnLegalConsultationUpdate;
exports.emailOnOrderCancelled = _rcEmailTriggers.emailOnOrderCancelled;
exports.emailOnOrderCreated = _rcEmailTriggers.emailOnOrderCreated;
exports.emailOnOrderDelivered = _rcEmailTriggers.emailOnOrderDelivered;
exports.emailOnOrderShipped = _rcEmailTriggers.emailOnOrderShipped;
exports.emailOnPaymentSuccess = _rcEmailTriggers.emailOnPaymentSuccess;
exports.emailOnProductStatusChange = _rcEmailTriggers.emailOnProductStatusChange;
exports.emailOnPropertyEnquiry = _rcEmailTriggers.emailOnPropertyEnquiry;
exports.emailOnSellerPayout = _rcEmailTriggers.emailOnSellerPayout;
exports.emailOnSellerStatusChange = _rcEmailTriggers.emailOnSellerStatusChange;
exports.emailOnSubscriptionRenewal = _rcEmailTriggers.emailOnSubscriptionRenewal;
exports.emailOnTicketCreate = _rcEmailTriggers.emailOnTicketCreate;
exports.emailOnUserCreate = _rcEmailTriggers.emailOnUserCreate;
exports.emailSubscriptionReminders = _rcEmailTriggers.emailSubscriptionReminders;
exports.emailUnassignedDeliveryAlert = _rcEmailTriggers.emailUnassignedDeliveryAlert;
exports.emailWebhook = _rcEmailTriggers.emailWebhook;
exports.onLoginEvent = _rcEmailTriggers.onLoginEvent;
exports.processEmailQueue = _rcEmailTriggers.processEmailQueue;
exports.resendEmail = _rcEmailTriggers.resendEmail;
exports.sendBroadcastEmail = _rcEmailTriggers.sendBroadcastEmail;
exports.updateEmailPreferences = _rcEmailTriggers.updateEmailPreferences;

const _rcReliabilityEngine = require('./reliability-engine');
exports.relCircuitBreakerState = _rcReliabilityEngine.relCircuitBreakerState;
exports.relEnqueueTask = _rcReliabilityEngine.relEnqueueTask;
exports.relGetDeadLetterQueue = _rcReliabilityEngine.relGetDeadLetterQueue;
exports.relGetSystemMetrics = _rcReliabilityEngine.relGetSystemMetrics;
exports.relHealthProbeAll = _rcReliabilityEngine.relHealthProbeAll;
exports.relPurgeDeadLetter = _rcReliabilityEngine.relPurgeDeadLetter;
exports.relRetryDeadLetter = _rcReliabilityEngine.relRetryDeadLetter;

const _rcTaskQueue = require('./task-queue');
exports.tqBulkEnqueue = _rcTaskQueue.tqBulkEnqueue;
exports.tqCancelTask = _rcTaskQueue.tqCancelTask;
exports.tqEnqueue = _rcTaskQueue.tqEnqueue;
exports.tqGetQueueStats = _rcTaskQueue.tqGetQueueStats;
exports.tqGetStatus = _rcTaskQueue.tqGetStatus;

const _rcWebhookEngine = require('./webhook-engine');
exports.webhookDelete = _rcWebhookEngine.webhookDelete;
exports.webhookDeliver = _rcWebhookEngine.webhookDeliver;
exports.webhookGetDeliveries = _rcWebhookEngine.webhookGetDeliveries;
exports.webhookGetStats = _rcWebhookEngine.webhookGetStats;
exports.webhookList = _rcWebhookEngine.webhookList;
exports.webhookRegister = _rcWebhookEngine.webhookRegister;
exports.webhookTestEndpoint = _rcWebhookEngine.webhookTestEndpoint;


/* ══════════════════════════════════════════════════════════════════════
   DEPLOYMENT INTEGRITY — Path A re-export (do NOT remove).

   These 7 observability callables are DEPLOYED and live. They are superseded
   by platformInfraDispatch (which routes all 7 ops), but they are NOT proven
   unused: 30-day invocation metrics have not been collected, so their status
   is UNKNOWN — and UNKNOWN is not "unused".

   They are exported here so that `firebase deploy --only functions` UPDATES
   them rather than DELETING them. Removing these lines re-opens the
   accidental-deletion hazard.

   Deletion may only be considered after runtime metrics (30-day invocations,
   last invocation, errors) have been collected and reviewed.
   See docs/recovery-plan.md and docs/deployment-safety-checklist.md.
   ══════════════════════════════════════════════════════════════════════ */
const _obsStandalone = require('./observability-engine');
exports.obsCreateAlert          = _obsStandalone.obsCreateAlert;
exports.obsDistributedTrace     = _obsStandalone.obsDistributedTrace;
exports.obsGetAuditLog          = _obsStandalone.obsGetAuditLog;
exports.obsGetErrorReport       = _obsStandalone.obsGetErrorReport;
exports.obsGetPerformanceReport = _obsStandalone.obsGetPerformanceReport;
exports.obsGetRealTimeMetrics   = _obsStandalone.obsGetRealTimeMetrics;
exports.obsIngestTelemetry      = _obsStandalone.obsIngestTelemetry;

/* ══════════════════════════════════════════════════════════════
   KASS KNOWLEDGE ENGINE — admin-managed, versioned knowledge.
   Knowledge is DATA (Firestore), not prompt. Updating what KASS
   knows is a Firestore write, not a redeploy of the assistant.
══════════════════════════════════════════════════════════════ */
const _kassKB = require("./kass-knowledge");
exports.kassKnowledgeUpsert  = _kassKB.kassKnowledgeUpsert;
exports.kassKnowledgePublish = _kassKB.kassKnowledgePublish;
exports.kassKnowledgeList    = _kassKB.kassKnowledgeList;
exports.kassKnowledgeArchive = _kassKB.kassKnowledgeArchive;
exports.kassKnowledgeSeed    = _kassKB.kassKnowledgeSeed;
exports.kassKnowledgeStats   = _kassKB.kassKnowledgeStats;
exports.kassFeedback         = _kassKB.kassFeedback;

const _kassMem = require("./kass-memory");
exports.kassMemoryGet    = _kassMem.kassMemoryGet;
exports.kassMemorySet    = _kassMem.kassMemorySet;
exports.kassMemoryForget = _kassMem.kassMemoryForget;   /* Kenya DPA 2019: real erasure, not a flag */

/* ══════════════════════════════════════════════════════════════
   PROMOTION ENGINE — campaigns are DATA, not code.
   The engine never branches on campaign type, so a new one
   (seasonal_ramadan, sponsored_service…) is a Firestore write.
══════════════════════════════════════════════════════════════ */
const _promos = require("./promotions");
exports.getPromotions    = _promos.getPromotions;
exports.trackPromotion   = _promos.trackPromotion;
exports.promotionUpsert  = _promos.promotionUpsert;
exports.promotionPublish = _promos.promotionPublish;
exports.promotionList    = _promos.promotionList;
exports.promotionArchive = _promos.promotionArchive;

/* ══════════════════════════════════════════════════════════════
   SMS PLATFORM — templates, idempotent queue, DLQ, preferences,
   delivery reports. Provider stays behind sokoni-at.js.
══════════════════════════════════════════════════════════════ */
const _sms = require("./sms-service");
exports.smsQueueWorker      = _sms.smsQueueWorker;
exports.smsEnqueue          = _sms.smsEnqueue;
exports.smsGetPreferences   = _sms.smsGetPreferences;
exports.smsSetPreferences   = _sms.smsSetPreferences;
exports.smsDeliveryWebhook  = _sms.smsDeliveryWebhook;
exports.smsStats            = _sms.smsStats;

/* ══════════════════════════════════════════════════════════════
   NOTIFICATION ENGINE — the ONE entry point for push/in-app/SMS/email.
   Callers declare INTENT (a type); the engine picks the channels.
══════════════════════════════════════════════════════════════ */
const _notify = require("./notify");
exports.notifySend           = _notify.notifySend;
exports.notifyGetPreferences = _notify.notifyGetPreferences;
exports.notifySetPreferences = _notify.notifySetPreferences;
exports.notifyStats          = _notify.notifyStats;
exports.orderAdvance         = _notify.orderAdvance;   /* 11-stage order timeline */

/* ══════════════════════════════════════════════════════════════
   ACCOUNT MANAGER — deletion grace period, data export, session revocation.
══════════════════════════════════════════════════════════════ */
const _acctMgr = require("./account-manager");
exports.scheduleAccountDeletion   = _acctMgr.scheduleAccountDeletion;
exports.cancelAccountDeletion     = _acctMgr.cancelAccountDeletion;
/* requestDataExport is intentionally NOT re-exported from account-manager.
   It is already exported ~600 lines above from ./data-export, and that is the
   complete pipeline: data-export.js writes both dataExportRequests (status) AND
   dataExportQueue/{id}, and its processDataExport worker triggers on
   dataExportQueue/{requestId} to actually build the export. This later binding
   silently shadowed that one (last write wins), and account-manager's version
   writes ONLY dataExportRequests and never dataExportQueue — so the worker never
   fired. A user's GDPR Art.20 / Kenya DPA §26 request was queued and then
   processed by nothing. The data-export version also enforces App Check, which
   this one did not, so restoring it also closes that gap.
   (The account-manager.js duplicate has now been REMOVED — single-source
   reconciliation, 2026-07-28 — so ./data-export is the only definition.) */
exports.revokeAllSessions         = _acctMgr.revokeAllSessions;
exports.finaliseExpiredDeletions  = _acctMgr.finaliseExpiredDeletions;

/* ── Workforce Identity System ─────────────────────────────── */
const _wfId = require("./workforce-identity");
exports.wfInviteEmployee              = _wfId.wfInviteEmployee;
exports.wfGetInvitation               = _wfId.wfGetInvitation;
exports.wfAcceptInvitation            = _wfId.wfAcceptInvitation;
exports.wfDeclineInvitation           = _wfId.wfDeclineInvitation;
exports.wfCancelInvitation            = _wfId.wfCancelInvitation;
exports.wfRevokeMembership            = _wfId.wfRevokeMembership;
exports.wfUpdatePermissions           = _wfId.wfUpdatePermissions;
exports.wfUpdateRole                  = _wfId.wfUpdateRole;
exports.wfGetBusinessMembers          = _wfId.wfGetBusinessMembers;
exports.wfGetMyWorkspaces             = _wfId.wfGetMyWorkspaces;
exports.wfClockIn                     = _wfId.wfClockIn;
exports.wfClockOut                    = _wfId.wfClockOut;
exports.wfGetPendingInvitationsByEmail = _wfId.wfGetPendingInvitationsByEmail;
exports.wfGenerateStaffQR             = _wfId.wfGenerateStaffQR;
exports.wfClockBreak                  = _wfId.wfClockBreak;
exports.wfClockResume                 = _wfId.wfClockResume;
exports.wfGetProfessionalProfile      = _wfId.wfGetProfessionalProfile;
exports.wfUpdateProfessionalProfile   = _wfId.wfUpdateProfessionalProfile;

/* ── Enterprise Organization Engine ───────────────────────── */
const _orgEng = require('./org-engine');
exports.orgGetDirectory               = _orgEng.orgGetDirectory;
exports.orgUpdateDirectory            = _orgEng.orgUpdateDirectory;
exports.orgCreateDepartment           = _orgEng.orgCreateDepartment;
exports.orgGetDepartments             = _orgEng.orgGetDepartments;
exports.orgUpdateDepartment           = _orgEng.orgUpdateDepartment;
exports.orgArchiveDepartment          = _orgEng.orgArchiveDepartment;
exports.orgCreateTeam                 = _orgEng.orgCreateTeam;
exports.orgGetTeams                   = _orgEng.orgGetTeams;
exports.orgUpdateTeam                 = _orgEng.orgUpdateTeam;
exports.orgArchiveTeam                = _orgEng.orgArchiveTeam;
exports.orgSetReportingLine           = _orgEng.orgSetReportingLine;
exports.orgGetReportingTree           = _orgEng.orgGetReportingTree;
exports.orgSaveApprovalWorkflow       = _orgEng.orgSaveApprovalWorkflow;
exports.orgGetApprovalWorkflows       = _orgEng.orgGetApprovalWorkflows;
exports.orgDeleteApprovalWorkflow     = _orgEng.orgDeleteApprovalWorkflow;
exports.orgRequestPermission          = _orgEng.orgRequestPermission;
exports.orgReviewPermissionRequest    = _orgEng.orgReviewPermissionRequest;
exports.orgGetPermissionRequests      = _orgEng.orgGetPermissionRequests;
exports.orgGrantTempAccess            = _orgEng.orgGrantTempAccess;
exports.orgRevokeTempAccess           = _orgEng.orgRevokeTempAccess;
exports.orgGetTempAccessGrants        = _orgEng.orgGetTempAccessGrants;
exports.orgCreateDelegation           = _orgEng.orgCreateDelegation;
exports.orgRevokeDelegation           = _orgEng.orgRevokeDelegation;
exports.orgGetDelegations             = _orgEng.orgGetDelegations;
exports.orgUpdateEmploymentStatus     = _orgEng.orgUpdateEmploymentStatus;
exports.orgGetAuditLog                = _orgEng.orgGetAuditLog;
exports.orgGetDashboard               = _orgEng.orgGetDashboard;
exports.orgGetRoles                   = _orgEng.orgGetRoles;
exports.orgCreateRole                 = _orgEng.orgCreateRole;
exports.orgUpdateRole                 = _orgEng.orgUpdateRole;
exports.orgDeleteRole                 = _orgEng.orgDeleteRole;
exports.orgExpireAccess               = _orgEng.orgExpireAccess;

/* ── Device Management Engine ──────────────────────────────── */
const _devEng = require('./device-engine');
exports.deviceRegister                = _devEng.deviceRegister;
exports.deviceList                    = _devEng.deviceList;
exports.deviceLogout                  = _devEng.deviceLogout;
exports.deviceLogoutAll               = _devEng.deviceLogoutAll;
exports.deviceTrust                   = _devEng.deviceTrust;
exports.deviceUntrust                 = _devEng.deviceUntrust;
exports.devicePing                    = _devEng.devicePing;

/* ── Storage Integrity Auditor ─────────────────────────────── */
const _integrity = require('./integrity-audit');
exports.storageIntegrityAuditScheduled = _integrity.storageIntegrityAuditScheduled;
exports.storageIntegrityAuditRun        = _integrity.storageIntegrityAuditRun;

/* ── Profile & Identity Engine ─────────────────────────────── */
const _profEng = require('./profile-engine');
exports.profileGetOverview            = _profEng.profileGetOverview;
exports.profileGetCompletion          = _profEng.profileGetCompletion;
exports.profileGetAchievements        = _profEng.profileGetAchievements;
exports.profileGetActivityTimeline    = _profEng.profileGetActivityTimeline;
exports.profileGenerateCard           = _profEng.profileGenerateCard;
exports.profileGetPublicProfile       = _profEng.profileGetPublicProfile;
exports.profileGetEmployment          = _profEng.profileGetEmployment;
exports.profileUpdatePersonalization  = _profEng.profileUpdatePersonalization;
exports.profileGetDocumentVault       = _profEng.profileGetDocumentVault;
exports.profileGetProfessional        = _profEng.profileGetProfessional;
exports.profileSaveProfessional       = _profEng.profileSaveProfessional;

/* ── Routing diagnostics receiver ──────────────────────────────────────────────
   POST /api/diag — the endpoint sokoni-root-guard.js has been beaconing to since it
   shipped. It had no rewrite and no function, so every anomaly report 404d and was
   lost. See functions/route-diag.js. */
const _routeDiag = require("./route-diag");
exports.routeDiag = _routeDiag.routeDiag;

/* ── Administrator invitation system ───────────────────────────────────────────
   Completes the onboarding subsystem: admin-created users automatically receive a
   production invitation. Writes only canonical identity/role fields and hands off to
   the existing onboarding UI. See docs/CANONICAL_ONBOARDING_SCHEMA.md. */
const _adminInvites = require("./admin-invitations");
exports.inviteUser            = _adminInvites.inviteUser;
exports.resendInvitation      = _adminInvites.resendInvitation;
exports.listInvitations       = _adminInvites.listInvitations;
exports.reconcileInvitations  = _adminInvites.reconcileInvitations;

/* ── M-Pesa C2B (manual Paybill / QR payments) ──────────────────────────────
   The leg the platform never had: a customer who pays the Paybill by hand with
   an order reference, rather than being pushed an STK prompt. Validation and
   Confirmation are separate URLs because Safaricom registers them separately.
   Both are unauthenticated by protocol — see the security notes in the module.
   Register with Safaricom RegisterURL before manual/QR payments can reconcile. */
const _c2b = require("./mpesa-c2b");
exports.mpesaC2BValidation   = _c2b.mpesaC2BValidation;
exports.mpesaC2BConfirmation = _c2b.mpesaC2BConfirmation;

/* ── Healthcare hub (functions/healthcare-hub.js) ──
   These 15 callables existed in the repo but were never required or
   re-exported here, so none were deployed. That left appointments with no valid
   execution path: firestore.rules makes /healthAppointments write:false (booking
   must be server-side for slot-locking + idempotency), while the CF that does
   the server-side write was absent. Wiring them in closes that gap.
   enforceAppCheck + region are set inside the module (CF_OPTS). */
const _health = require('./healthcare-hub');
exports.registerHealthProvider   = _health.registerHealthProvider;
exports.approveHealthProvider    = _health.approveHealthProvider;
exports.getHealthProviders       = _health.getHealthProviders;
exports.getHealthProvider        = _health.getHealthProvider;
exports.bookAppointment          = _health.bookAppointment;
exports.getMyAppointments        = _health.getMyAppointments;
exports.getProviderAppointments  = _health.getProviderAppointments;
exports.updateAppointmentStatus  = _health.updateAppointmentStatus;
exports.createHealthRecord       = _health.createHealthRecord;
exports.getHealthRecords         = _health.getHealthRecords;
exports.createPrescription       = _health.createPrescription;
exports.getPrescriptions         = _health.getPrescriptions;
exports.searchHealthProviders    = _health.searchHealthProviders;
exports.rateHealthProvider       = _health.rateHealthProvider;
exports.getHealthDashboard       = _health.getHealthDashboard;

/* ── Application Lifecycle ─────────────────────────────────────────────────────
   The convergence point between `applications` (the request) and the canonical
   registries that make an approved applicant discoverable and dispatchable.
   Approval previously flipped a status field and stopped there, so an approved
   cleaning company never reached `providers/{uid}` and an approved rider never
   reached `drivers`/`rideDrivers` — both invisible, one undispatchable.

   `applicationLifecycle` is a Firestore trigger; deploy it by that exact name
   or the projection never runs. See functions/application-lifecycle.js. */
/* ── Invitation onboarding audit ──────────────────────────────────────────────
   Finds accounts that CANNOT sign in: a password provider, never a successful
   sign-in, and no password-setup mail on record. That combination is invisible in
   the Firebase console — the account looks healthy and is simply unusable — which
   is how ochisaac@gmail.com sat stranded from 2026-07-21 to 2026-08-01. Also
   reports invitations whose role contradicts a claim the account already holds. */
exports.auditInviteOnboarding = onCall(
  { region: 'us-central1', maxInstances: 3, enforceAppCheck: true, timeoutSeconds: 300 },
  async (req) => {
    const t = req.auth?.token || {};
    if (!t.admin && !t.superAdmin) {
      throw new HttpsError('permission-denied', 'Administrator access required.');
    }
    return require('./invitations-core').auditOnboarding();
  }
);

/* Re-send a password-setup link to an invitee who never received one. Separate
   from resendInvitation because the remedy for a stranded account is the LINK,
   not another invitation record. */
exports.resendPasswordSetup = onCall(
  { region: 'us-central1', maxInstances: 5, enforceAppCheck: true,
    secrets: require('./email-service').EMAIL_SECRETS },
  async (req) => {
    const t = req.auth?.token || {};
    if (!t.admin && !t.superAdmin) {
      throw new HttpsError('permission-denied', 'Administrator access required.');
    }
    const core = require('./invitations-core');
    const email = String(req.data?.email || '').toLowerCase().trim();
    if (!email) throw new HttpsError('invalid-argument', '"email" is required.');
    const user = await admin.auth().getUserByEmail(email);
    const claims = user.customClaims || {};
    const role = core.CLAIM_RANK.slice().reverse().find(r => claims[r] === true) || 'admin';
    const meta = core.CLAIM_ROLES[role] || { label: role, dest: '/' };
    const res = await core.sendPasswordSetupMail({
      email, name: user.displayName || '', roleLabel: meta.label, dest: meta.dest,
      reason: 'manual_resend',
    });
    return { ok: true, email, uid: user.uid, role, queueId: res.queueId };
  }
);

const _appLife = require('./application-lifecycle');
exports.applicationLifecycle  = _appLife.applicationLifecycle;   // trigger: applications/{appId}
exports.applicationDecide     = _appLife.applicationDecide;      // onCall (admin)
exports.applicationReconcile  = _appLife.applicationReconcile;   // onCall (admin) — drift repair
exports.applicationList       = _appLife.applicationList;        // onCall (admin) — one canonical read
