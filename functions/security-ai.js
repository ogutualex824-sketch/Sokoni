'use strict';

/**
 * SOKONI Security 6.0 — AI Security Module
 * Protects AI systems from prompt injection, unauthorized data exposure,
 * sensitive information leakage, role bypass via prompts, and rate abuse.
 * Wraps all KASS / Claude API calls with a security envelope.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const crypto = require('crypto');

const CF_OPTIONS = { region: 'us-central1', enforceAppCheck: true };
const db = admin.firestore();
const FieldValue = admin.firestore.FieldValue;

const ROLE = { cashier: 0, supervisor: 1, manager: 2, owner: 3, admin: 4, super_admin: 5 };

function _requireAuth(auth) {
  if (!auth) throw new HttpsError('unauthenticated', 'Sign in required.');
}
function _roleLevel(auth) {
  const r = auth?.token?.role;
  return typeof r === 'number' ? r : (ROLE[r] ?? 0);
}
function _requireRole(auth, minRole) {
  _requireAuth(auth);
  if (_roleLevel(auth) < minRole) throw new HttpsError('permission-denied', 'Insufficient role.');
}

// ── Prompt injection detection patterns ──────────────────────────────────────
// Covers jailbreak attempts, role-switching, system prompt overrides,
// data exfiltration attempts, and instruction-injection patterns.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|your)\s+(instructions?|prompts?|context|rules?|system)/i,
  /you\s+are\s+now\s+(a\s+)?(new|different|another|unrestricted|evil|jailbroken)/i,
  /act\s+as\s+(if\s+you\s+are\s+)?(a\s+)?(different|new|another|unrestricted|evil|dan|jailbreak)/i,
  /forget\s+(your\s+)?(training|instructions?|rules?|guidelines?|previous|system)/i,
  /\[SYSTEM\]|\[INST\]|\[PROMPT\]|<\|system\|>|<\|im_start\|>|<<SYS>>/i,
  /jailbreak|DAN\s+mode|developer\s+mode|god\s+mode|uncensored\s+mode/i,
  /reveal\s+(your\s+)?(system\s+)?prompt|show\s+(me\s+)?your\s+(instructions?|context|training)/i,
  /pretend\s+(you\s+(have\s+no|don'?t\s+have)\s+(restrictions?|rules?|guidelines?))/i,
  /bypass\s+(the\s+)?(safety|filter|restriction|rule|policy|guideline)/i,
  /roleplay\s+(as\s+)?an?\s+(ai|assistant|model)\s+(without|that\s+(doesn'?t|has\s+no))/i,
  /translate\s+the\s+following\s+(to|into)\s+(code|sql|shell|bash|python)/i,
  /execute\s+(the\s+following\s+)?(command|code|script|query|sql)/i,
  /\$\{.*\}|`[^`]+`\s*;|\beval\s*\(|process\.env\.|require\s*\('/i,
];

// PII patterns to scrub from AI responses before returning to client
const PII_PATTERNS = [
  { pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, replacement: '[EMAIL]' },
  { pattern: /\b(?:\+?254|0)[17]\d{8}\b/g, replacement: '[PHONE]' },
  { pattern: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, replacement: '[CARD]' },
  { pattern: /\bA\d{9}\b/g, replacement: '[KRA_PIN]' },
  { pattern: /\b[A-Z]\d{8}\b/g, replacement: '[ID_NUMBER]' },
];

// Maximum prompt length per role (characters)
const MAX_PROMPT_LENGTH = { 0: 500, 1: 1000, 2: 2000, 3: 3000, 4: 5000, 5: 10000 };

// AI call rate limits per role (calls per hour)
const HOURLY_RATE_LIMIT = { 0: 5, 1: 10, 2: 20, 3: 50, 4: 100, 5: 500 };

/* ── Internal helpers ───────────────────────────────────────────────────────── */

function _detectInjection(text) {
  const detected = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(text)) {
      detected.push(pattern.source.substring(0, 40));
    }
  }
  return detected;
}

function _sanitizeForAI(text) {
  if (typeof text !== 'string') return '';
  // Remove null bytes, control characters (except newlines/tabs), and HTML tags
  return text
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
    .replace(/<[^>]*>/g, '')
    .trim();
}

function _scrubPII(text) {
  let scrubbed = text;
  for (const { pattern, replacement } of PII_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed;
}

async function _checkRateLimit(userId, role) {
  const limit = HOURLY_RATE_LIMIT[role] ?? 5;
  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  const snap = await db.collection('aiSecurityLog')
    .where('userId', '==', userId)
    .where('createdAt', '>=', windowStart)
    .count()
    .get();
  const count = snap.data().count;
  if (count >= limit) {
    throw new HttpsError('resource-exhausted', `AI rate limit: ${limit} calls/hour. Try again later.`);
  }
  return count;
}

async function _logAIEvent(event) {
  try {
    await db.collection('aiSecurityLog').add({
      ...event,
      createdAt: FieldValue.serverTimestamp(),
    });
  } catch (_) { /* fire-and-forget */ }
}

/* ── 1. validateAIPrompt ────────────────────────────────────────────────────
   Pre-flight security check called before any AI API invocation.
   Returns a sanitized prompt or throws if injection detected.
   ─────────────────────────────────────────────────────────────────────────── */
exports.validateAIPrompt = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireAuth(auth);
  const role = _roleLevel(auth);
  const { prompt, context, sessionId } = data;

  if (!prompt || typeof prompt !== 'string')
    throw new HttpsError('invalid-argument', 'prompt is required.');

  const maxLen = MAX_PROMPT_LENGTH[role] ?? 500;
  if (prompt.length > maxLen)
    throw new HttpsError('invalid-argument', `Prompt exceeds ${maxLen} character limit for your role.`);

  // Rate limit first — reject bots before doing any expensive work
  await _checkRateLimit(auth.uid, role);

  const sanitized = _sanitizeForAI(prompt);
  const injections = _detectInjection(sanitized);

  if (injections.length > 0) {
    await _logAIEvent({
      type: 'PROMPT_INJECTION_BLOCKED',
      userId: auth.uid,
      role,
      sessionId: sessionId || null,
      injectionPatterns: injections,
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16),
      severity: 'high',
    });
    await db.collection('securityAlerts').add({
      type: 'PROMPT_INJECTION',
      userId: auth.uid,
      severity: 'high',
      status: 'open',
      metadata: { patterns: injections, sessionId },
      createdAt: FieldValue.serverTimestamp(),
    });
    throw new HttpsError('permission-denied', 'Request contains disallowed content.');
  }

  await _logAIEvent({
    type: 'PROMPT_VALIDATED',
    userId: auth.uid,
    role,
    sessionId: sessionId || null,
    promptLength: sanitized.length,
    severity: 'info',
  });

  return { sanitizedPrompt: sanitized, approved: true };
});

/* ── 2. filterAIResponse ────────────────────────────────────────────────────
   Post-processing: scrub PII from AI responses before sending to client.
   Also checks for accidental data exposure patterns.
   ─────────────────────────────────────────────────────────────────────────── */
exports.filterAIResponse = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireAuth(auth);
  const { response, sessionId, queryType } = data;

  if (!response || typeof response !== 'string')
    throw new HttpsError('invalid-argument', 'response is required.');

  const scrubbed = _scrubPII(response);

  // Detect if model accidentally included system prompt fragments
  const SYSTEM_LEAK_PATTERNS = [
    /You are KASS/i,
    /your system prompt/i,
    /SOKONI_SYSTEM_CONTEXT/i,
    /ANTHROPIC_API_KEY/i,
    /sk-ant-/i,
    /firebase.*config/i,
    /storageBucket.*sokoni/i,
  ];
  const leaks = SYSTEM_LEAK_PATTERNS.filter((p) => p.test(response));

  if (leaks.length > 0) {
    await _logAIEvent({
      type: 'AI_RESPONSE_LEAK_BLOCKED',
      userId: auth.uid,
      sessionId: sessionId || null,
      leakPatterns: leaks.map((p) => p.source.slice(0, 30)),
      severity: 'critical',
    });
    await db.collection('securityAlerts').add({
      type: 'AI_DATA_LEAK',
      userId: auth.uid,
      severity: 'critical',
      status: 'open',
      metadata: { sessionId, queryType },
      createdAt: FieldValue.serverTimestamp(),
    });
    return { filteredResponse: '[Response blocked: security review required]', blocked: true };
  }

  await _logAIEvent({
    type: 'AI_RESPONSE_FILTERED',
    userId: auth.uid,
    sessionId: sessionId || null,
    piiScrubbed: scrubbed !== response,
    severity: 'info',
  });

  return { filteredResponse: scrubbed, blocked: false };
});

/* ── 3. getAISecurityLog ────────────────────────────────────────────────────
   Admin-only view of AI security events (prompt injections, rate limits,
   blocked responses, data leaks).
   ─────────────────────────────────────────────────────────────────────────── */
exports.getAISecurityLog = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 4); // admin+
  const { type, userId, severity, limit = 50, startDate, endDate } = data;

  let q = db.collection('aiSecurityLog').orderBy('createdAt', 'desc');

  if (type)     q = q.where('type', '==', type);
  if (userId)   q = q.where('userId', '==', userId);
  if (severity) q = q.where('severity', '==', severity);
  if (startDate) q = q.where('createdAt', '>=', new Date(startDate));
  if (endDate)   q = q.where('createdAt', '<=', new Date(endDate));

  q = q.limit(Math.min(limit, 200));
  const snap = await q.get();

  return {
    events: snap.docs.map((d) => ({
      id: d.id,
      ...d.data(),
      createdAt: d.data().createdAt?.toDate?.()?.toISOString() ?? null,
    })),
    count: snap.size,
  };
});

/* ── 4. getAIRateLimitStatus ────────────────────────────────────────────────
   Returns the caller's current AI usage vs. limit for the rolling hour.
   ─────────────────────────────────────────────────────────────────────────── */
exports.getAIRateLimitStatus = onCall(CF_OPTIONS, async ({ auth }) => {
  _requireAuth(auth);
  const role = _roleLevel(auth);
  const limit = HOURLY_RATE_LIMIT[role] ?? 5;

  const windowStart = new Date(Date.now() - 60 * 60 * 1000);
  const snap = await db.collection('aiSecurityLog')
    .where('userId', '==', auth.uid)
    .where('createdAt', '>=', windowStart)
    .count()
    .get();

  const used = snap.data().count;
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: new Date(Date.now() + (60 - new Date().getMinutes()) * 60 * 1000).toISOString(),
  };
});

/* ── 5. reportAIAbuse ───────────────────────────────────────────────────────
   User-initiated abuse report for AI responses (hallucinations, harmful
   content, privacy violations). Creates a security alert for review.
   ─────────────────────────────────────────────────────────────────────────── */
exports.reportAIAbuse = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireAuth(auth);
  const { sessionId, queryId, abuseType, description } = data;

  const VALID_TYPES = ['hallucination', 'harmful_content', 'privacy_violation', 'data_leak', 'other'];
  if (!VALID_TYPES.includes(abuseType))
    throw new HttpsError('invalid-argument', 'Invalid abuseType.');

  const reportId = db.collection('aiAbuseReports').doc().id;
  await db.collection('aiAbuseReports').doc(reportId).set({
    reportId,
    reportedBy: auth.uid,
    sessionId: sessionId || null,
    queryId: queryId || null,
    abuseType,
    description: description?.slice(0, 1000) || '',
    status: 'open',
    createdAt: FieldValue.serverTimestamp(),
  });

  // High-severity types immediately create a security alert
  if (['data_leak', 'privacy_violation'].includes(abuseType)) {
    await db.collection('securityAlerts').add({
      type: 'AI_ABUSE_REPORT',
      userId: auth.uid,
      severity: 'high',
      status: 'open',
      metadata: { reportId, abuseType, sessionId },
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return { reportId, status: 'received' };
});

/* ── 6. getAIContextPolicy ──────────────────────────────────────────────────
   Returns what data the AI is allowed to access for the requesting user's
   role. Used by the client to build appropriate context bundles.
   Prevents over-privileged context injection.
   ─────────────────────────────────────────────────────────────────────────── */
exports.getAIContextPolicy = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireAuth(auth);
  const role = _roleLevel(auth);
  const { sellerId } = data;

  // Build allowed context scopes per role
  const policy = {
    role,
    allowedDataSources: [],
    forbiddenTopics: [
      'system_prompts', 'api_keys', 'passwords', 'other_sellers_data',
      'admin_credentials', 'firebase_config', 'secret_manager',
    ],
    maxContextTokens: Math.min(1000 + role * 500, 4000),
    requireSellerOwnership: role < 4,
    canAccessFinancials: role >= 2,
    canAccessStaffData: role >= 2,
    canAccessCustomerPII: role >= 1,
    canAccessSystemMetrics: role >= 4,
  };

  if (role >= 0) policy.allowedDataSources.push('pos_sales', 'inventory_summary', 'product_list');
  if (role >= 1) policy.allowedDataSources.push('customer_summary', 'daily_metrics', 'order_history');
  if (role >= 2) policy.allowedDataSources.push('staff_summary', 'financial_summary', 'analytics');
  if (role >= 3) policy.allowedDataSources.push('full_financials', 'all_staff_data', 'bi_reports');
  if (role >= 4) policy.allowedDataSources.push('platform_metrics', 'all_sellers', 'security_events');

  // Log context policy access for audit
  await _logAIEvent({
    type: 'CONTEXT_POLICY_ACCESSED',
    userId: auth.uid,
    role,
    sellerId: sellerId || null,
    severity: 'info',
  });

  return { policy };
});

/* ── 7. blockAISession ──────────────────────────────────────────────────────
   Admin action: block a user's AI access (after abuse or security event).
   ─────────────────────────────────────────────────────────────────────────── */
exports.blockAISession = onCall(CF_OPTIONS, async ({ auth, data }) => {
  _requireRole(auth, 4); // admin+
  const { targetUserId, reason, duration } = data;

  if (!targetUserId) throw new HttpsError('invalid-argument', 'targetUserId required.');

  const expiresAt = duration
    ? new Date(Date.now() + duration * 60 * 1000)
    : null; // null = permanent until manually unblocked

  await db.doc(`aiBlocks/${targetUserId}`).set({
    userId: targetUserId,
    blockedBy: auth.uid,
    reason: reason || 'Security violation',
    blockedAt: FieldValue.serverTimestamp(),
    expiresAt: expiresAt ? admin.firestore.Timestamp.fromDate(expiresAt) : null,
    active: true,
  });

  await _logAIEvent({
    type: 'AI_ACCESS_BLOCKED',
    userId: auth.uid,
    targetUserId,
    reason,
    expiresAt: expiresAt?.toISOString() ?? 'permanent',
    severity: 'high',
  });

  return { blocked: true, targetUserId, expiresAt: expiresAt?.toISOString() ?? null };
});
