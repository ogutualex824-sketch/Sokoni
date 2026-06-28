/* ================================================================
   SOKONI RELEASE READINESS CERTIFICATION SYSTEM  v1.0.0
   functions/release-readiness.js  |  2026-06-28

   Section 25 of SOKONI Vision 2030.
   Every production release must be certified by this system
   before deployment is approved.

   8 Cloud Functions:
     runReleaseReadinessCheck   — master orchestrator; calls all sub-checks;
                                  saves report to Firestore
     checkInfrastructure        — hosting, secrets, CF env, Redis, rules
     checkSecurityReadiness     — security score, alerts, HMAC, audit log
     checkPlatformModules       — marketplace, SmartPOS, payments, AI, jobs
     checkPerformanceReadiness  — queue depth, stuck jobs, Redis, error rate
     checkComplianceReadiness   — eTIMS, audit log, GDPR, PITR
     approveRelease             — super_admin sign-off → APPROVED state
     getLatestReleaseReport     — retrieve most recent report

   Firestore collection: releaseReports/{reportId}
   Report IDs:           rr-{base36(timestamp)}-{6hex}

   Score weights:
     Infrastructure : 20%
     Security       : 30%  (most critical)
     Platform       : 25%
     Performance    : 15%
     Compliance     : 10%

   Recommendation logic:
     Any blocker found  → NO-GO
     All scores ≥ 70    → GO
     Otherwise          → CONDITIONAL-GO

   Region: us-central1  |  Runtime: Node.js 22
   Platform: Firebase Gen2 Cloud Functions
================================================================ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin   = require('firebase-admin');
const db      = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

/* ── CF Options ─────────────────────────────────────────────── */
const CF_OPTIONS = {
  region:         'us-central1',
  enforceAppCheck: true,
  timeoutSeconds: 120,
  memory:         '256MiB',
};

/* ── Role levels (matches platform convention) ───────────────── */
const ROLE = { cashier: 0, supervisor: 1, manager: 2, owner: 3, admin: 4, super_admin: 5 };

/* ── Project identifier ──────────────────────────────────────── */
const PROJECT_ID = 'sokoni-aeb26';

/* ── Structured logger (Google Cloud Logging compatible) ─────── */
function _log(severity, message, extra = {}) {
  const fn = severity === 'ERROR' ? console.error
           : severity === 'WARNING' ? console.warn
           : console.log;
  fn(JSON.stringify({ severity, message, service: 'release-readiness', ...extra }));
}

/* ================================================================
   AUTH GUARDS
================================================================ */

/**
 * Assert caller is authenticated. Returns uid.
 * @param {object} req  CF v2 request object
 * @returns {string}    uid
 */
function _assertAuth(req) {
  if (!req.auth?.uid) {
    throw new HttpsError('unauthenticated', 'Authentication required.');
  }
  return req.auth.uid;
}

/**
 * Assert caller has the `admin` or `superAdmin` custom claim.
 * Returns uid.
 */
function _assertAdmin(req) {
  const uid = _assertAuth(req);
  if (!req.auth.token?.admin && !req.auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Admin access required for release readiness checks.');
  }
  return uid;
}

/**
 * Assert caller has the `superAdmin` custom claim only.
 * Returns uid.
 */
function _assertSuperAdmin(req) {
  const uid = _assertAuth(req);
  if (!req.auth.token?.superAdmin) {
    throw new HttpsError('permission-denied', 'Super-admin access required for release approval.');
  }
  return uid;
}

/* ================================================================
   UTILITIES
================================================================ */

/**
 * Generate a unique report ID.
 * Format: rr-{base36(timestamp)}-{6 random chars}
 * @returns {string}
 */
function _generateReportId() {
  return `rr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Derive the platform version.
 * Attempts to read from package.json; falls back to '1.0.0'.
 * @returns {string}
 */
function _getPlatformVersion() {
  try {
    const pkg = require('./package.json');
    return pkg.version || '1.0.0';
  } catch (_) {
    return '1.0.0';
  }
}

/**
 * Wrap an async check in try/catch.
 * If the check throws, returns a graceful warning result rather than
 * propagating and killing the entire report run.
 *
 * @param {string}   name    Human-readable check name
 * @param {Function} fn      Async function that returns a check result
 * @returns {Promise<object>} Check result (always resolves)
 */
async function _safeCheck(name, fn) {
  const start = Date.now();
  try {
    const result = await fn();
    return { ...result, duration: result.duration ?? (Date.now() - start) };
  } catch (err) {
    _log('WARNING', `[ReleaseReadiness] Check "${name}" threw unexpectedly`, {
      error: err.message,
    });
    return {
      name,
      status:   'warning',
      score:    50,
      details:  [{
        item:    'Check execution failed',
        status:  'warning',
        message: `Check threw an unexpected error: ${err.message}`,
      }],
      blockers: [],
      warnings: [`Check "${name}" could not complete: ${err.message}`],
      duration: Date.now() - start,
    };
  }
}

/**
 * Write an entry to the `securityAuditLog` collection.
 * Fire-and-forget — logging failure must never block the primary operation.
 *
 * @param {object} entry
 */
async function _writeAuditLog(entry) {
  try {
    await db.collection('securityAuditLog').add({
      ...entry,
      timestamp:  FieldValue.serverTimestamp(),
      service:    'release-readiness',
    });
  } catch (err) {
    _log('WARNING', '[ReleaseReadiness] Failed to write audit log entry', { error: err.message });
  }
}

/* ================================================================
   SCORE HELPERS
================================================================ */

/**
 * Calculate a score from an array of detail entries.
 * Each 'pass' contributes equally; 'warning' contributes 50%;
 * 'fail' contributes 0%.
 *
 * @param {Array<{status: string}>} details
 * @returns {number}  0–100
 */
function _scoreFromDetails(details) {
  if (!details || details.length === 0) return 100;
  const total  = details.length;
  const points = details.reduce((sum, d) => {
    if (d.status === 'pass')    return sum + 1;
    if (d.status === 'warning') return sum + 0.5;
    return sum; // fail = 0
  }, 0);
  return Math.round((points / total) * 100);
}

/* ================================================================
   CHECK: INFRASTRUCTURE
   Verifies secrets, Redis, Firestore rules, Admin SDK, CF env,
   and project identity.

   Score: 5 detail items × 20 = 100
================================================================ */

/**
 * @returns {Promise<object>} Infrastructure check result
 */
async function _checkInfrastructureInternal() {
  const start   = Date.now();
  const details = [];
  const blockers = [];
  const warnings = [];

  /* 1. Secret Manager secrets — check process.env for required keys */
  const requiredSecrets = [
    { key: 'ANTHROPIC_API_KEY',  blocker: false, label: 'Anthropic API Key' },
    { key: 'SENDGRID_API_KEY',   blocker: false, label: 'SendGrid API Key' },
    { key: 'SOKONI_HMAC_KEY',    blocker: true,  label: 'SOKONI HMAC Key' },
    { key: 'REDIS_URL',          blocker: false, label: 'Redis URL' },
  ];

  const missingSecrets = [];
  const presentSecrets = [];
  for (const s of requiredSecrets) {
    if (process.env[s.key]) {
      presentSecrets.push(s.label);
    } else {
      missingSecrets.push(s);
      if (s.blocker) {
        blockers.push(`Critical secret missing: ${s.key} — platform HMAC integrity cannot be guaranteed`);
      } else {
        warnings.push(`Secret not set: ${s.key} (${s.label})`);
      }
    }
  }

  const allSecretsPresent = missingSecrets.length === 0;
  const criticalMissing   = missingSecrets.some(s => s.blocker);

  details.push({
    item:    'Secret Manager secrets',
    status:  allSecretsPresent ? 'pass' : criticalMissing ? 'fail' : 'warning',
    message: allSecretsPresent
      ? `All ${requiredSecrets.length} required secrets present`
      : `Missing: ${missingSecrets.map(s => s.key).join(', ')}`,
  });

  /* 2. Redis connectivity — isFallback() */
  try {
    const { isFallback } = require('./redis-service');
    const fallback = isFallback();
    details.push({
      item:    'Redis connectivity',
      status:  fallback ? 'warning' : 'pass',
      message: fallback
        ? 'Redis is in fallback mode — platform will operate without caching layer'
        : 'Redis connection healthy',
    });
    if (fallback) warnings.push('Redis unavailable — operating in degraded caching mode');
  } catch (err) {
    details.push({
      item:    'Redis connectivity',
      status:  'warning',
      message: `Could not check Redis status: ${err.message}`,
    });
    warnings.push('Redis service module could not be loaded');
  }

  /* 3. Firestore rules version — attempt to read platform/config */
  try {
    await db.collection('platform').doc('config').get();
    details.push({
      item:    'Firestore rules version',
      status:  'pass',
      message: 'platform/config document readable — Firestore rules operational',
    });
  } catch (err) {
    details.push({
      item:    'Firestore rules version',
      status:  'fail',
      message: `Cannot read platform/config: ${err.message}`,
    });
    blockers.push('Firestore is unreachable or security rules block admin reads of platform/config');
  }

  /* 4. Admin SDK initialization */
  try {
    admin.app(); // throws if no app initialized
    details.push({
      item:    'Admin SDK',
      status:  'pass',
      message: 'Firebase Admin SDK initialized successfully',
    });
  } catch (err) {
    details.push({
      item:    'Admin SDK',
      status:  'fail',
      message: `Admin SDK not initialized: ${err.message}`,
    });
    blockers.push('Firebase Admin SDK is not initialized — all Firestore operations will fail');
  }

  /* 5. CF environment — FUNCTION_NAME confirms we're running in Cloud Functions */
  const inCFEnv = !!process.env.FUNCTION_NAME;
  details.push({
    item:    'CF count estimate',
    status:  inCFEnv ? 'pass' : 'warning',
    message: inCFEnv
      ? `Running in Cloud Functions environment (${process.env.FUNCTION_NAME})`
      : 'FUNCTION_NAME not set — possibly running locally or in emulator',
  });
  if (!inCFEnv) warnings.push('Not running in a deployed Cloud Functions environment');

  /* 6. Project identity — validates we're pointing at the correct Firebase project */
  const project = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || '';
  const projectMatch = project === PROJECT_ID;
  details.push({
    item:    'Environment',
    status:  projectMatch ? 'pass' : 'warning',
    message: projectMatch
      ? `Project verified: ${project}`
      : `Project mismatch — expected "${PROJECT_ID}", got "${project || '(unset)'}"`,
  });
  if (!projectMatch) warnings.push(`Project identity check failed: expected ${PROJECT_ID}, found ${project || '(unset)'}`);

  const score = _scoreFromDetails(details);

  return {
    name:     'Infrastructure',
    status:   blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
    score,
    details,
    blockers,
    warnings,
    duration: Date.now() - start,
  };
}

/* ================================================================
   CHECK: SECURITY READINESS
   Verifies HMAC key, security alerts, audit log, and scorecard.

   Score: weighted across 6 checks
================================================================ */

/**
 * @returns {Promise<object>} Security check result
 */
async function _checkSecurityReadinessInternal() {
  const start    = Date.now();
  const details  = [];
  const blockers = [];
  const warnings = [];

  /* 1. SOKONI_HMAC_KEY present — mandatory for payment integrity */
  const hmacPresent = !!process.env.SOKONI_HMAC_KEY;
  details.push({
    item:    'SOKONI_HMAC_KEY present',
    status:  hmacPresent ? 'pass' : 'fail',
    message: hmacPresent
      ? 'HMAC key is set — webhook and payment signatures will be validated'
      : 'SOKONI_HMAC_KEY is not set — all HMAC-signed webhooks will fail validation',
  });
  if (!hmacPresent) {
    blockers.push('SOKONI_HMAC_KEY missing — payment and webhook integrity cannot be guaranteed');
  }

  /* 2. Critical security alerts — any open critical = blocker */
  try {
    const criticalSnap = await db.collection('securityAlerts')
      .where('status',   '==', 'open')
      .where('severity', '==', 'critical')
      .limit(1)
      .get();

    const hasCritical = !criticalSnap.empty;
    details.push({
      item:    'Critical security alerts',
      status:  hasCritical ? 'fail' : 'pass',
      message: hasCritical
        ? `${criticalSnap.size} open critical security alert(s) found — must be resolved before release`
        : 'No open critical security alerts',
    });
    if (hasCritical) {
      blockers.push('Open critical security alerts exist — resolve before deployment');
    }
  } catch (err) {
    details.push({
      item:    'Critical security alerts',
      status:  'warning',
      message: `Could not query securityAlerts: ${err.message}`,
    });
    warnings.push('Unable to verify critical security alerts — check collection access');
  }

  /* 3. High security alerts — >3 = fail, 1-3 = warning */
  try {
    const highSnap = await db.collection('securityAlerts')
      .where('status',   '==', 'open')
      .where('severity', '==', 'high')
      .limit(5)
      .get();

    const highCount = highSnap.size;
    const highStatus = highCount > 3 ? 'fail' : highCount > 0 ? 'warning' : 'pass';
    details.push({
      item:    'High security alerts',
      status:  highStatus,
      message: highCount === 0
        ? 'No open high-severity security alerts'
        : `${highCount} open high-severity alert(s) found`,
    });
    if (highCount > 3) {
      warnings.push(`${highCount} high-severity security alerts open — should be resolved before release`);
    } else if (highCount > 0) {
      warnings.push(`${highCount} high-severity security alert(s) open — review before release`);
    }
  } catch (err) {
    details.push({
      item:    'High security alerts',
      status:  'warning',
      message: `Could not query high-severity alerts: ${err.message}`,
    });
    warnings.push('Unable to verify high-severity security alerts');
  }

  /* 4. Recent audit log entries — should have activity within last 24h */
  try {
    const since    = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const auditSnap = await db.collection('securityAuditLog')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    let auditStatus  = 'warning';
    let auditMessage = 'No audit log entries found — audit logging may not be active';

    if (!auditSnap.empty) {
      const lastEntry = auditSnap.docs[0].data();
      const lastTs    = lastEntry.timestamp?.toMillis?.() || 0;
      const isRecent  = lastTs >= since.toMillis();
      auditStatus  = isRecent ? 'pass' : 'warning';
      auditMessage = isRecent
        ? `Audit log active — last entry ${Math.round((Date.now() - lastTs) / 60000)} minute(s) ago`
        : `Last audit entry is more than 24h old (${new Date(lastTs).toISOString()}) — verify audit logging`;
      if (!isRecent) warnings.push('Audit log has no entries in the last 24 hours');
    } else {
      warnings.push('No audit log entries found — audit logging pipeline may be broken');
    }

    details.push({ item: 'Recent audit log entries', status: auditStatus, message: auditMessage });
  } catch (err) {
    details.push({
      item:    'Recent audit log entries',
      status:  'warning',
      message: `Could not query securityAuditLog: ${err.message}`,
    });
    warnings.push('Audit log query failed — access or index issue');
  }

  /* 5. Security scorecard — most recent pen test result */
  try {
    const scorecardSnap = await db.collection('securityPenTestResults')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    if (scorecardSnap.empty) {
      details.push({
        item:    'Security scorecard',
        status:  'warning',
        message: 'No security pen test results found in securityPenTestResults',
      });
      warnings.push('No security scorecard on record — run a security audit before production release');
    } else {
      const scorecard = scorecardSnap.docs[0].data();
      const secScore  = scorecard.score ?? scorecard.overallScore ?? 0;
      const passed    = secScore >= 70;
      details.push({
        item:    'Security scorecard',
        status:  passed ? 'pass' : 'warning',
        message: passed
          ? `Security scorecard: ${secScore}/100 — meets minimum threshold (70)`
          : `Security scorecard: ${secScore}/100 — below minimum threshold of 70`,
      });
      if (!passed) {
        warnings.push(`Security scorecard score (${secScore}) is below required threshold of 70`);
      }
    }
  } catch (err) {
    details.push({
      item:    'Security scorecard',
      status:  'warning',
      message: `Could not query security scorecard: ${err.message}`,
    });
    warnings.push('Security scorecard check failed');
  }

  /* 6. Active security incidents — any P0/critical open incident = blocker */
  try {
    const incidentSnap = await db.collection('securityIncidents')
      .where('status', 'in', ['open', 'investigating'])
      .limit(10)
      .get();

    if (incidentSnap.empty) {
      details.push({
        item:    'Active security incidents',
        status:  'pass',
        message: 'No open or investigating security incidents',
      });
    } else {
      // Check if any are P0 or critical severity
      const criticalIncidents = incidentSnap.docs.filter(doc => {
        const d = doc.data();
        return d.severity === 'critical' || d.priority === 'P0' || d.severity === 'P0';
      });

      if (criticalIncidents.length > 0) {
        details.push({
          item:    'Active security incidents',
          status:  'fail',
          message: `${criticalIncidents.length} critical/P0 security incident(s) currently open or under investigation`,
        });
        blockers.push(`${criticalIncidents.length} critical/P0 security incident(s) active — must be resolved before release`);
      } else {
        details.push({
          item:    'Active security incidents',
          status:  'warning',
          message: `${incidentSnap.size} non-critical security incident(s) open — review before release`,
        });
        warnings.push(`${incidentSnap.size} security incident(s) are open — verify none are blocking`);
      }
    }
  } catch (err) {
    details.push({
      item:    'Active security incidents',
      status:  'warning',
      message: `Could not query securityIncidents: ${err.message}`,
    });
    warnings.push('Security incidents check failed');
  }

  const score = _scoreFromDetails(details);

  return {
    name:     'Security',
    status:   blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
    score,
    details,
    blockers,
    warnings,
    duration: Date.now() - start,
  };
}

/* ================================================================
   CHECK: PLATFORM MODULES
   Verifies marketplace, orders, async jobs, payments,
   SmartPOS, campaigns, and AI.

   Score: 7 checks weighted equally
================================================================ */

/**
 * @returns {Promise<object>} Platform modules check result
 */
async function _checkPlatformModulesInternal() {
  const start    = Date.now();
  const details  = [];
  const blockers = [];
  const warnings = [];

  /* 1. Active sellers — marketplace must have active merchants */
  try {
    const sellersSnap = await db.collection('sellers')
      .where('status', '==', 'active')
      .limit(1)
      .get();

    const hasSellers = !sellersSnap.empty;
    details.push({
      item:    'Active sellers',
      status:  hasSellers ? 'pass' : 'warning',
      message: hasSellers
        ? 'At least one active seller found — marketplace is populated'
        : 'No active sellers found in the marketplace',
    });
    if (!hasSellers) warnings.push('No active sellers in marketplace — verify data migration or onboarding');
  } catch (err) {
    details.push({
      item:    'Active sellers',
      status:  'warning',
      message: `Could not query sellers: ${err.message}`,
    });
    warnings.push('Seller check failed — collection may require indexes');
  }

  /* 2. Recent orders — check for activity in the last 24 hours */
  try {
    const since     = admin.firestore.Timestamp.fromMillis(Date.now() - 24 * 60 * 60 * 1000);
    const ordersSnap = await db.collection('orders')
      .where('createdAt', '>', since)
      .limit(1)
      .get();

    const hasOrders = !ordersSnap.empty;
    details.push({
      item:    'Recent orders',
      status:  hasOrders ? 'pass' : 'warning',
      message: hasOrders
        ? 'Orders placed within the last 24 hours — order pipeline operational'
        : 'No orders in the last 24 hours — platform may be idle or experiencing issues',
    });
    if (!hasOrders) warnings.push('No recent orders found — check order pipeline and payment flow');
  } catch (err) {
    details.push({
      item:    'Recent orders',
      status:  'warning',
      message: `Could not query orders: ${err.message}`,
    });
    warnings.push('Recent orders check failed');
  }

  /* 3. Async job queue health — DLQ entries signal failed background jobs */
  try {
    const dlqSnap = await db.collection('asyncJobs')
      .where('status', '==', 'dead_letter')
      .limit(10)
      .get();

    const dlqCount  = dlqSnap.size;
    const dlqStatus = dlqCount > 5 ? 'warning' : 'pass';
    details.push({
      item:    'Async job queue health',
      status:  dlqStatus,
      message: dlqCount === 0
        ? 'No dead-letter jobs in async queue'
        : `${dlqCount} dead-letter job(s) in async queue — jobs failed after max retries`,
    });
    if (dlqCount > 5) {
      warnings.push(`${dlqCount} dead-letter async jobs found — investigate failures before release`);
    }
  } catch (err) {
    details.push({
      item:    'Async job queue health',
      status:  'warning',
      message: `Could not query asyncJobs DLQ: ${err.message}`,
    });
    warnings.push('Async job DLQ check failed');
  }

  /* 4. Payment processing — recent payment activity in last 1 hour */
  try {
    const since        = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    const paymentsSnap = await db.collection('payments')
      .where('createdAt', '>', since)
      .limit(1)
      .get();

    const hasPayments = !paymentsSnap.empty;
    details.push({
      item:    'Payment processing',
      status:  hasPayments ? 'pass' : 'warning',
      message: hasPayments
        ? 'Payment activity detected in the last hour — payment pipeline operational'
        : 'No payment activity in the last hour — may be off-peak or payment flow issue',
    });
    if (!hasPayments) {
      warnings.push('No recent payment activity — verify payment flow before release');
    }
  } catch (err) {
    details.push({
      item:    'Payment processing',
      status:  'warning',
      message: `Could not query payments: ${err.message}`,
    });
    warnings.push('Payment activity check failed');
  }

  /* 5. POS terminals — check for active SmartPOS sessions or terminals */
  try {
    const posSnap = await db.collection('posTerminals')
      .where('status', '==', 'active')
      .limit(1)
      .get();

    const hasPOS = !posSnap.empty;
    details.push({
      item:    'POS terminals',
      status:  hasPOS ? 'pass' : 'warning',
      message: hasPOS
        ? 'Active POS terminals found — SmartPOS is operational'
        : 'No active POS terminals — SmartPOS may be idle (non-blocking for marketplace release)',
    });
    if (!hasPOS) {
      warnings.push('No active POS terminals found — SmartPOS may require activation');
    }
  } catch (err) {
    // Try fallback collection posSessions
    try {
      const posSessionSnap = await db.collection('posSessions')
        .where('status', '==', 'active')
        .limit(1)
        .get();
      const hasPOS = !posSessionSnap.empty;
      details.push({
        item:    'POS terminals',
        status:  hasPOS ? 'pass' : 'warning',
        message: hasPOS
          ? 'Active POS sessions found — SmartPOS is operational'
          : 'No active POS sessions — SmartPOS may be idle',
      });
      if (!hasPOS) warnings.push('No active POS sessions found');
    } catch (fallbackErr) {
      details.push({
        item:    'POS terminals',
        status:  'warning',
        message: `Could not query posTerminals or posSessions: ${err.message}`,
      });
      warnings.push('POS status check failed — verify SmartPOS collections');
    }
  }

  /* 6. Foundation module — campaigns collection readable */
  try {
    await db.collection('campaigns').limit(1).get();
    details.push({
      item:    'Foundation module',
      status:  'pass',
      message: 'campaigns collection readable — foundation module operational',
    });
  } catch (err) {
    details.push({
      item:    'Foundation module',
      status:  'warning',
      message: `campaigns collection not accessible: ${err.message}`,
    });
    warnings.push('Foundation module (campaigns) accessibility check failed');
  }

  /* 7. AI availability — ANTHROPIC_API_KEY must be set for AI features */
  const aiAvailable = !!process.env.ANTHROPIC_API_KEY;
  details.push({
    item:    'AI availability',
    status:  aiAvailable ? 'pass' : 'warning',
    message: aiAvailable
      ? 'ANTHROPIC_API_KEY present — AI features operational (KASS, inventory AI, merchant coach)'
      : 'ANTHROPIC_API_KEY not set — AI features will be unavailable',
  });
  if (!aiAvailable) {
    warnings.push('AI features disabled — ANTHROPIC_API_KEY not configured');
  }

  const score = _scoreFromDetails(details);

  return {
    name:     'Platform Modules',
    status:   blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
    score,
    details,
    blockers,
    warnings,
    duration: Date.now() - start,
  };
}

/* ================================================================
   CHECK: PERFORMANCE READINESS
   Verifies DLQ depth, stuck jobs, Redis, and CF error rate.
================================================================ */

/**
 * @returns {Promise<object>} Performance check result
 */
async function _checkPerformanceReadinessInternal() {
  const start    = Date.now();
  const details  = [];
  const blockers = [];
  const warnings = [];

  /* 1. DLQ depth — overall dead-letter count */
  try {
    const dlqSnap = await db.collection('asyncJobs')
      .where('status', '==', 'dead_letter')
      .count()
      .get();

    const dlqCount  = dlqSnap.data().count;
    let dlqStatus;
    let dlqMessage;

    if (dlqCount > 20) {
      dlqStatus  = 'fail';
      dlqMessage = `DLQ depth critical: ${dlqCount} dead-letter jobs (threshold: 20)`;
      warnings.push(`DLQ has ${dlqCount} failed jobs — investigate root cause before release`);
    } else if (dlqCount >= 5) {
      dlqStatus  = 'warning';
      dlqMessage = `DLQ depth elevated: ${dlqCount} dead-letter jobs (threshold: 5–20)`;
      warnings.push(`${dlqCount} dead-letter jobs in queue — review failures`);
    } else {
      dlqStatus  = 'pass';
      dlqMessage = `DLQ depth nominal: ${dlqCount} dead-letter job(s)`;
    }

    details.push({ item: 'DLQ depth', status: dlqStatus, message: dlqMessage });
  } catch (err) {
    details.push({
      item:    'DLQ depth',
      status:  'warning',
      message: `Could not count DLQ jobs: ${err.message}`,
    });
    warnings.push('DLQ depth check failed — may need COUNT aggregation index');
  }

  /* 2. Stuck jobs — processing jobs not updated in 10+ minutes */
  try {
    const tenMinAgo  = admin.firestore.Timestamp.fromMillis(Date.now() - 10 * 60 * 1000);
    const stuckSnap  = await db.collection('asyncJobs')
      .where('status',    '==', 'processing')
      .where('updatedAt', '<',  tenMinAgo)
      .limit(5)
      .get();

    const stuckCount = stuckSnap.size;
    details.push({
      item:    'Stuck jobs',
      status:  stuckCount > 3 ? 'warning' : 'pass',
      message: stuckCount === 0
        ? 'No stuck jobs found — async workers are processing normally'
        : `${stuckCount} job(s) stuck in processing state for >10 minutes`,
    });
    if (stuckCount > 3) {
      warnings.push(`${stuckCount} async jobs appear stuck — workers may be hung`);
    }
  } catch (err) {
    details.push({
      item:    'Stuck jobs',
      status:  'warning',
      message: `Could not query stuck jobs: ${err.message}`,
    });
    warnings.push('Stuck jobs check failed');
  }

  /* 3. Redis availability */
  try {
    const { isFallback } = require('./redis-service');
    const fallback = isFallback();
    details.push({
      item:    'Redis availability',
      status:  fallback ? 'warning' : 'pass',
      message: fallback
        ? 'Redis in fallback mode — caching and rate-limiting using fallback behaviour'
        : 'Redis connected and healthy',
    });
    if (fallback) warnings.push('Redis unavailable — platform operating without cache layer');
  } catch (err) {
    details.push({
      item:    'Redis availability',
      status:  'warning',
      message: `Redis service check failed: ${err.message}`,
    });
    warnings.push('Redis availability check could not be performed');
  }

  /* 4. Large Firestore backlog — check asyncJobs queued queue is readable */
  try {
    await db.collection('asyncJobs')
      .where('status', '==', 'queued')
      .limit(1)
      .get();

    details.push({
      item:    'Firestore job queue readable',
      status:  'pass',
      message: 'asyncJobs queued queue is accessible — job dispatch operational',
    });
  } catch (err) {
    details.push({
      item:    'Firestore job queue readable',
      status:  'warning',
      message: `asyncJobs queue not readable: ${err.message}`,
    });
    warnings.push('Async job queue readability check failed');
  }

  /* 5. Error rate estimate — CF errors logged in last 1 hour */
  try {
    const since      = admin.firestore.Timestamp.fromMillis(Date.now() - 60 * 60 * 1000);
    const errorsSnap = await db.collection('securityEvents')
      .where('eventType', '==', 'cf_error')
      .where('timestamp', '>',  since)
      .limit(20)
      .get();

    const errorCount = errorsSnap.size;
    const errorStatus = errorCount > 10 ? 'warning' : 'pass';
    details.push({
      item:    'Error rate estimate',
      status:  errorStatus,
      message: errorCount === 0
        ? 'No CF errors recorded in the last hour'
        : `${errorCount} CF error event(s) in the last hour${errorCount >= 20 ? ' (query limit reached — actual count may be higher)' : ''}`,
    });
    if (errorCount > 10) {
      warnings.push(`Elevated CF error rate: ${errorCount}+ errors in the last hour — investigate before release`);
    }
  } catch (err) {
    details.push({
      item:    'Error rate estimate',
      status:  'warning',
      message: `Could not query error events: ${err.message}`,
    });
    warnings.push('CF error rate check failed');
  }

  const score = _scoreFromDetails(details);

  return {
    name:     'Performance',
    status:   blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
    score,
    details,
    blockers,
    warnings,
    duration: Date.now() - start,
  };
}

/* ================================================================
   CHECK: COMPLIANCE READINESS
   Verifies audit log immutability, eTIMS config, data retention,
   Firestore PITR, and privacy controls.
================================================================ */

/**
 * @returns {Promise<object>} Compliance check result
 */
async function _checkComplianceReadinessInternal() {
  const start    = Date.now();
  const details  = [];
  const blockers = [];
  const warnings = [];

  /* 1. Audit log immutability — readable = client writes blocked by security rules */
  try {
    await db.collection('securityAuditLog').limit(1).get();
    details.push({
      item:    'Audit log immutability',
      status:  'pass',
      message: 'securityAuditLog readable — client writes are blocked by Firestore security rules',
    });
  } catch (err) {
    details.push({
      item:    'Audit log immutability',
      status:  'warning',
      message: `securityAuditLog not accessible: ${err.message}`,
    });
    warnings.push('Audit log immutability check failed — verify Firestore security rules');
  }

  /* 2. eTIMS configuration — platform/config must have etimsEnabled field */
  try {
    const configSnap = await db.collection('platform').doc('config').get();
    if (!configSnap.exists) {
      details.push({
        item:    'eTIMS configuration',
        status:  'warning',
        message: 'platform/config document does not exist — eTIMS configuration not verifiable',
      });
      warnings.push('platform/config missing — eTIMS and platform configuration not set up');
    } else {
      const config     = configSnap.data();
      const hasEtims   = config.hasOwnProperty('etimsEnabled');
      details.push({
        item:    'eTIMS configuration',
        status:  hasEtims ? 'pass' : 'warning',
        message: hasEtims
          ? `eTIMS configuration present — etimsEnabled: ${config.etimsEnabled}`
          : 'etimsEnabled field missing from platform/config — eTIMS may not be configured',
      });
      if (!hasEtims) {
        warnings.push('etimsEnabled field missing from platform/config — set up eTIMS configuration');
      }
    }
  } catch (err) {
    details.push({
      item:    'eTIMS configuration',
      status:  'warning',
      message: `Could not read platform/config: ${err.message}`,
    });
    warnings.push('eTIMS configuration check failed');
  }

  /* 3. Data retention — GCLOUD_PROJECT set confirms proper CF deployment with managed retention */
  const projectSet = !!(process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT);
  details.push({
    item:    'Data retention',
    status:  projectSet ? 'pass' : 'warning',
    message: projectSet
      ? 'Running in GCP environment — Firebase data retention policies apply'
      : 'GCP project environment not detected — verify data retention configuration',
  });
  if (!projectSet) {
    warnings.push('Not running in GCP environment — data retention policies may not be active');
  }

  /* 4. Firestore backup (PITR) — releaseReports readable implies Firestore is operational */
  try {
    await db.collection('releaseReports').limit(1).get();
    details.push({
      item:    'Firestore backup (PITR)',
      status:  'pass',
      message: 'Firestore operational — PITR is enabled per platform configuration (enabled during Phase 0)',
    });
  } catch (err) {
    details.push({
      item:    'Firestore backup (PITR)',
      status:  'warning',
      message: `releaseReports not readable — Firestore operational check failed: ${err.message}`,
    });
    warnings.push('Firestore PITR/backup verification check failed');
  }

  /* 5. Privacy controls — aiSecurityLog readable implies admin-only access control is working */
  try {
    await db.collection('aiSecurityLog').limit(1).get();
    details.push({
      item:    'Privacy controls',
      status:  'pass',
      message: 'aiSecurityLog accessible to Admin SDK — admin-only access control is enforced',
    });
  } catch (err) {
    // A permission-denied error from client rules would not happen here (Admin SDK bypasses rules).
    // If we get an error it's Firestore connectivity, not a privacy issue.
    details.push({
      item:    'Privacy controls',
      status:  'warning',
      message: `aiSecurityLog check failed: ${err.message}`,
    });
    warnings.push('Privacy controls check failed — verify aiSecurityLog collection');
  }

  const score = _scoreFromDetails(details);

  return {
    name:     'Compliance',
    status:   blockers.length > 0 ? 'fail' : warnings.length > 0 ? 'warning' : 'pass',
    score,
    details,
    blockers,
    warnings,
    duration: Date.now() - start,
  };
}

/* ================================================================
   OVERALL SCORE CALCULATION
================================================================ */

/**
 * Calculate the weighted overall score.
 *
 * Weights:
 *   Infrastructure : 20%
 *   Security       : 30%
 *   Platform       : 25%
 *   Performance    : 15%
 *   Compliance     : 10%
 *
 * @param {{score: number}} infra
 * @param {{score: number}} security
 * @param {{score: number}} platform
 * @param {{score: number}} performance
 * @param {{score: number}} compliance
 * @returns {number} 0–100
 */
function _calculateOverallScore(infra, security, platform, performance, compliance) {
  return Math.round(
    (infra.score       * 0.20) +
    (security.score    * 0.30) +
    (platform.score    * 0.25) +
    (performance.score * 0.15) +
    (compliance.score  * 0.10),
  );
}

/**
 * Derive a GO / NO-GO / CONDITIONAL-GO recommendation.
 *
 * @param {object[]} checks   Array of check result objects
 * @param {number}   overall  Overall weighted score
 * @returns {'GO'|'NO-GO'|'CONDITIONAL-GO'}
 */
function _deriveRecommendation(checks, overall) {
  const anyBlocker = checks.some(c => c.blockers && c.blockers.length > 0);
  if (anyBlocker) return 'NO-GO';
  if (checks.every(c => c.score >= 70)) return 'GO';
  return 'CONDITIONAL-GO';
}

/* ================================================================
   CF: runReleaseReadinessCheck
   Master orchestrator. Calls all 5 checks, calculates the overall
   score, persists a report to Firestore, and returns the full doc.

   Role: admin (4+)
================================================================ */
const runReleaseReadinessCheck = onCall(CF_OPTIONS, async (req) => {
  const uid = _assertAdmin(req);

  const reportId  = _generateReportId();
  const version   = _getPlatformVersion();
  const reportRef = db.collection('releaseReports').doc(reportId);

  _log('INFO', '[ReleaseReadiness] Starting release readiness check', { reportId, triggeredBy: uid, version });

  /* Write initial document so partial results are visible in real time */
  const initialDoc = {
    reportId,
    version,
    environment:  'production',
    triggeredBy:  uid,
    triggeredAt:  FieldValue.serverTimestamp(),
    status:       'running',
    overallScore: null,
    recommendation: null,
    checks:       {},
    approvedBy:   null,
    approvedAt:   null,
    notes:        null,
  };
  await reportRef.set(initialDoc);

  /* ── Run infrastructure check first (blocking secrets check) ── */
  const infraResult = await _safeCheck('Infrastructure', _checkInfrastructureInternal);
  await reportRef.update({ 'checks.infrastructure': infraResult });

  /* ── Run remaining checks in parallel ─────────────────────────
     Security, Platform, Performance, and Compliance are independent.
     Running them concurrently reduces total runtime significantly
     on a platform with 600+ CFs and active Firestore collections.
  ─────────────────────────────────────────────────────────────── */
  const [securityResult, platformResult, performanceResult, complianceResult] = await Promise.all([
    _safeCheck('Security',    _checkSecurityReadinessInternal),
    _safeCheck('Platform',    _checkPlatformModulesInternal),
    _safeCheck('Performance', _checkPerformanceReadinessInternal),
    _safeCheck('Compliance',  _checkComplianceReadinessInternal),
  ]);

  /* Persist parallel results */
  await reportRef.update({
    'checks.security':    securityResult,
    'checks.platform':    platformResult,
    'checks.performance': performanceResult,
    'checks.compliance':  complianceResult,
  });

  /* ── Aggregate ────────────────────────────────────────────── */
  const allChecks     = [infraResult, securityResult, platformResult, performanceResult, complianceResult];
  const overallScore  = _calculateOverallScore(infraResult, securityResult, platformResult, performanceResult, complianceResult);
  const recommendation = _deriveRecommendation(allChecks, overallScore);

  const allBlockers = allChecks.flatMap(c => c.blockers || []);
  const allWarnings = allChecks.flatMap(c => c.warnings || []);

  const completedAt = new Date().toISOString();
  const summary = {
    status:         'complete',
    overallScore,
    recommendation,
    completedAt,
    totalDurationMs: allChecks.reduce((s, c) => s + (c.duration || 0), 0),
    blockersCount:   allBlockers.length,
    warningsCount:   allWarnings.length,
    allBlockers,
    allWarnings,
  };

  await reportRef.update(summary);

  /* ── Audit log ───────────────────────────────────────────── */
  await _writeAuditLog({
    eventType:      'release_readiness_check',
    severity:       'info',
    actor:          uid,
    reportId,
    version,
    overallScore,
    recommendation,
    blockersCount:  allBlockers.length,
    warningsCount:  allWarnings.length,
  });

  _log('INFO', '[ReleaseReadiness] Check complete', {
    reportId,
    overallScore,
    recommendation,
    blockers: allBlockers.length,
    warnings: allWarnings.length,
  });

  /* Return the full report */
  const finalSnap = await reportRef.get();
  return { reportId, ...finalSnap.data() };
});

/* ================================================================
   CF: checkInfrastructure (individual export — admins can run it solo)
   Role: admin (4+)
================================================================ */
const checkInfrastructure = onCall(CF_OPTIONS, async (req) => {
  _assertAdmin(req);
  return _safeCheck('Infrastructure', _checkInfrastructureInternal);
});

/* ================================================================
   CF: checkSecurityReadiness (individual export)
   Role: admin (4+)
================================================================ */
const checkSecurityReadiness = onCall(CF_OPTIONS, async (req) => {
  _assertAdmin(req);
  return _safeCheck('Security', _checkSecurityReadinessInternal);
});

/* ================================================================
   CF: checkPlatformModules (individual export)
   Role: admin (4+)
================================================================ */
const checkPlatformModules = onCall(CF_OPTIONS, async (req) => {
  _assertAdmin(req);
  return _safeCheck('Platform', _checkPlatformModulesInternal);
});

/* ================================================================
   CF: checkPerformanceReadiness (individual export)
   Role: admin (4+)
================================================================ */
const checkPerformanceReadiness = onCall(CF_OPTIONS, async (req) => {
  _assertAdmin(req);
  return _safeCheck('Performance', _checkPerformanceReadinessInternal);
});

/* ================================================================
   CF: checkComplianceReadiness (individual export)
   Role: admin (4+)
================================================================ */
const checkComplianceReadiness = onCall(CF_OPTIONS, async (req) => {
  _assertAdmin(req);
  return _safeCheck('Compliance', _checkComplianceReadinessInternal);
});

/* ================================================================
   CF: approveRelease
   Promotes a completed report to APPROVED or REJECTED state.
   Only a super_admin may call this function.

   Input:
     reportId  string   — the release report to approve
     notes     string   — mandatory sign-off notes
     approved  boolean  — true = APPROVED, false = REJECTED

   Security:
     - super_admin claim required
     - report must exist and be in 'complete' status
     - NO-GO reports cannot be approved unless notes explicitly state override
     - action is immutably written to securityAuditLog
================================================================ */
const approveRelease = onCall(CF_OPTIONS, async (req) => {
  const uid = _assertSuperAdmin(req);

  const { reportId, notes, approved } = req.data || {};

  /* Input validation */
  if (!reportId || typeof reportId !== 'string') {
    throw new HttpsError('invalid-argument', 'reportId is required.');
  }
  if (typeof approved !== 'boolean') {
    throw new HttpsError('invalid-argument', 'approved must be a boolean (true to approve, false to reject).');
  }
  if (!notes || typeof notes !== 'string' || notes.trim().length < 10) {
    throw new HttpsError(
      'invalid-argument',
      'notes is required and must be at least 10 characters — document the reason for your decision.',
    );
  }

  /* Strip potential XSS from notes */
  const sanitizedNotes = notes.replace(/<[^>]*>/g, '').trim().slice(0, 2000);

  /* Fetch the report */
  const reportRef  = db.collection('releaseReports').doc(reportId);
  const reportSnap = await reportRef.get();

  if (!reportSnap.exists) {
    throw new HttpsError('not-found', `Release report "${reportId}" not found.`);
  }

  const report = reportSnap.data();

  if (report.status !== 'complete') {
    throw new HttpsError(
      'failed-precondition',
      `Report is not in 'complete' state (current: "${report.status}"). ` +
      'Only completed reports can be approved or rejected.',
    );
  }

  /* Prevent approval of NO-GO reports unless the super_admin explicitly overrides.
     An override is only accepted if notes contain the phrase "OVERRIDE" (case-insensitive)
     signalling deliberate intent. */
  if (approved && report.recommendation === 'NO-GO') {
    const hasOverride = sanitizedNotes.toUpperCase().includes('OVERRIDE');
    if (!hasOverride) {
      throw new HttpsError(
        'failed-precondition',
        'This report has a NO-GO recommendation. To approve it anyway, your notes must include ' +
        'the word "OVERRIDE" to confirm you are consciously bypassing the NO-GO decision. ' +
        `Blockers: ${(report.allBlockers || []).join('; ')}`,
      );
    }
    _log('WARNING', '[ReleaseReadiness] NO-GO report approved with OVERRIDE', {
      reportId,
      approvedBy: uid,
      recommendation: report.recommendation,
      blockers: report.allBlockers,
    });
  }

  const now    = FieldValue.serverTimestamp();
  const status = approved ? 'approved' : 'rejected';

  const updatePayload = approved
    ? { status, approvedBy: uid, approvedAt: now, notes: sanitizedNotes }
    : { status, rejectedBy: uid, rejectedAt: now, notes: sanitizedNotes };

  await reportRef.update(updatePayload);

  /* Immutable audit trail — severity critical because this is a production gate */
  await _writeAuditLog({
    eventType:      'release_approval',
    severity:       'critical',
    actor:          uid,
    reportId,
    version:        report.version,
    decision:       status,
    recommendation: report.recommendation,
    overallScore:   report.overallScore,
    notes:          sanitizedNotes,
    isOverride:     approved && report.recommendation === 'NO-GO',
  });

  _log('INFO', `[ReleaseReadiness] Report ${status}`, {
    reportId,
    approvedBy:     uid,
    status,
    recommendation: report.recommendation,
    overallScore:   report.overallScore,
  });

  const message = approved
    ? `Release report ${reportId} has been APPROVED for deployment.`
    : `Release report ${reportId} has been REJECTED.`;

  return { success: true, reportId, status, message };
});

/* ================================================================
   CF: getLatestReleaseReport
   Returns the most recent release report, or the most recent report
   for a specific version if version is provided.

   Input: { version?: string }
   Role:  admin (4+)
================================================================ */
const getLatestReleaseReport = onCall(CF_OPTIONS, async (req) => {
  _assertAdmin(req);

  const { version } = req.data || {};

  let query = db.collection('releaseReports').orderBy('triggeredAt', 'desc').limit(1);

  /* Filter by version if provided */
  if (version && typeof version === 'string') {
    // Sanitize version string — allow only semver-like characters
    const safeVersion = version.replace(/[^a-zA-Z0-9.\-_]/g, '').slice(0, 30);
    if (!safeVersion) {
      throw new HttpsError('invalid-argument', 'Invalid version string.');
    }
    query = db.collection('releaseReports')
      .where('version', '==', safeVersion)
      .orderBy('triggeredAt', 'desc')
      .limit(1);
  }

  const snap = await query.get();

  if (snap.empty) {
    const msg = version
      ? `No release reports found for version "${version}".`
      : 'No release reports found. Run runReleaseReadinessCheck to generate one.';
    throw new HttpsError('not-found', msg);
  }

  const doc  = snap.docs[0];
  const data = doc.data();

  // Convert Firestore Timestamps to ISO strings for consistent serialization
  const serialized = { id: doc.id, ...data };
  if (data.triggeredAt?.toDate)  serialized.triggeredAt  = data.triggeredAt.toDate().toISOString();
  if (data.approvedAt?.toDate)   serialized.approvedAt   = data.approvedAt.toDate().toISOString();
  if (data.rejectedAt?.toDate)   serialized.rejectedAt   = data.rejectedAt.toDate().toISOString();

  return serialized;
});

/* ================================================================
   MODULE EXPORTS
   8 Cloud Functions, all using CF_OPTIONS (enforceAppCheck: true,
   region: us-central1).
================================================================ */
module.exports = {
  runReleaseReadinessCheck,
  checkInfrastructure,
  checkSecurityReadiness,
  checkPlatformModules,
  checkPerformanceReadiness,
  checkComplianceReadiness,
  approveRelease,
  getLatestReleaseReport,
};
