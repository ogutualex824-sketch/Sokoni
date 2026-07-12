/* ══════════════════════════════════════════════════════════════════════════
   KASS KNOWLEDGE ENGINE  —  kass-knowledge.js

   WHY THIS EXISTS
   KASS's knowledge used to live inside a hardcoded system-prompt string in
   functions/index.js. Every content change — a new fee, a new hub, a policy
   tweak — meant editing the assistant's source and redeploying it. Knowledge
   and behaviour were fused, so business updates carried code risk.

   This module separates them:
     • BEHAVIOUR  (persona, safety rules, tool policy) stays in the prompt.
     • KNOWLEDGE  (facts, policies, prices, Kenya reference) lives in Firestore,
       is versioned, is edited by admins, and is RETRIEVED per question.

   A knowledge change is now a Firestore write, not a deploy.

   RETRIEVAL — deliberately lexical, not vector
   Scoring is token overlap + tag/category boosts. No embeddings, no vector DB.
   That is a considered trade-off: the corpus is small and hand-curated
   (hundreds of entries, not millions of documents), the questions are short,
   and a lexical index needs no new infrastructure, no per-query embedding cost
   and no re-indexing pipeline. It is also debuggable — an admin can see exactly
   why an entry matched. If the corpus ever outgrows this, swap _score() for an
   embedding lookup; nothing else in the system changes.

   Collections
     kassKnowledge    — versioned entries (draft | published | archived)
     kassUnanswered   — questions KASS could not ground in knowledge
     kassFeedback     — thumbs up/down on answers
═════════════════════════════════════════════════════════════════════════ */
'use strict';

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin  = require('firebase-admin');
const logger = require('firebase-functions/logger');

if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();

const REGION      = 'us-central1';
const COL_KB      = 'kassKnowledge';
const COL_UNANS   = 'kassUnanswered';
const COL_FEED    = 'kassFeedback';

/* Retrieval budget. The prompt must stay small: knowledge is injected on EVERY
   turn, so an oversized block costs latency and money on every message. */
const MAX_ENTRIES  = 6;
const MAX_CHARS    = 6000;
const MIN_SCORE    = 2;      /* below this, a match is noise — better to say "I don't know" */

/* ── Admin guard ──────────────────────────────────────────────────────────
   Knowledge is what KASS tells users is TRUE. Anyone who can write it can make
   the assistant assert anything — so writes are admin-only, server-side. */
async function _assertAdmin(request) {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');
  const snap = await db().collection('users').doc(uid).get();
  const u = snap.exists ? snap.data() : {};
  const roles = Array.isArray(u.roles) ? u.roles : (u.role ? [u.role] : []);
  const isAdmin = roles.includes('admin') || roles.includes('superadmin');
  if (!isAdmin) throw new HttpsError('permission-denied', 'Admin access required.');
  return uid;
}

/* ── Text normalisation ───────────────────────────────────────────────────
   Kenyan users mix English, Kiswahili and Sheng in one sentence. We fold case,
   strip punctuation, and drop stopwords in BOTH languages so "nataka kununua
   simu" and "I want to buy a phone" reduce to comparable token sets. */
const STOPWORDS = new Set([
  /* English */
  'the','a','an','is','are','was','were','be','to','of','and','or','in','on','for','with',
  'i','you','he','she','it','we','they','my','your','me','do','does','did','can','how','what',
  'where','when','why','which','who','this','that','there','here','please','want','need','get',
  'have','has','from','at','by','as','if','so','not','no','yes','ok','okay','am',
  /* Kiswahili / Sheng function words — without these, every query matches everything */
  'na','ya','wa','za','la','ni','kwa','katika','kuna','nina','nataka','naomba','nipe','hii',
  'hiyo','hizi','ile','yangu','yako','yake','mimi','wewe','yeye','sisi','nyinyi','wao',
  'je','sasa','tu','pia','lakini','ama','au','gani','wapi','nini','vipi','kama',
  'unaweza','naweza','tafadhali','asante','sawa','poa','boss','buda','manze','fam',
  /* NOTE: 'ngapi' (how much / how many) is deliberately NOT a stopword. It is the
     core token of every price and fee question — "inachukua ngapi", "ni ngapi" —
     and dropping it made those queries retrieve nothing useful. */
]);

function _tokens(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOPWORDS.has(t));
}

/* ── Scoring ──────────────────────────────────────────────────────────────
   Tags and question-patterns are curated by a human, so a hit there is a much
   stronger signal than an incidental word in the body. Weights reflect that. */
function _score(queryTokens, entry) {
  if (!queryTokens.length) return 0;
  const q = new Set(queryTokens);
  let score = 0;

  for (const tag of (entry.tags || [])) {
    if (q.has(String(tag).toLowerCase())) score += 3;          /* curated tag hit */
  }
  for (const t of _tokens((entry.questions || []).join(' '))) {
    if (q.has(t)) score += 2;                                   /* curated question phrasing */
  }
  for (const t of _tokens(entry.title)) {
    if (q.has(t)) score += 2;
  }
  const bodyTokens = new Set(_tokens(entry.content));
  for (const t of q) {
    if (bodyTokens.has(t)) score += 1;                          /* incidental body hit */
  }
  /* Policy/pricing entries are authoritative — surface them ahead of general prose
     when both match, so KASS quotes the rule rather than paraphrasing around it. */
  if (score > 0 && (entry.category === 'policy' || entry.category === 'pricing')) score += 1;
  return score;
}

/* ── Public retrieval API (used by sokoniChat) ────────────────────────────
   Returns { block, entries, grounded }.
   `grounded` is the honesty signal: false means we found nothing solid, and the
   caller must tell KASS to say it doesn't know rather than improvise. */
let _cache = { at: 0, entries: [] };
const CACHE_MS = 5 * 60 * 1000;   /* knowledge changes rarely; re-reading it per chat turn would be wasteful */

async function _loadPublished() {
  const now = Date.now();
  if (_cache.entries.length && (now - _cache.at) < CACHE_MS) return _cache.entries;
  const snap = await db().collection(COL_KB).where('status', '==', 'published').limit(1000).get();
  const entries = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  _cache = { at: now, entries };
  return entries;
}

async function retrieve(query, opts = {}) {
  const entries = await _loadPublished();
  if (!entries.length) return { block: '', entries: [], grounded: false };

  /* PINNED entries are BEHAVIOUR (persona, language policy, uncertainty rules).
     They are always injected and never scored.

     They must be excluded from scoring, not merely boosted: the language entry
     contains literal example phrases ("Nataka kuuza simu"), so if it competed on
     content overlap it would out-rank the actual answer for the very phrases it
     documents — the guide would hijack the question it was written to explain.
     Observed in testing; this is the fix. */
  const pinned = entries.filter(e => e.pinned === true);
  const pool   = entries.filter(e => e.pinned !== true);

  const qt = _tokens(query);
  const scored = pool
    .map(e => ({ e, s: _score(qt, e) }))
    .filter(x => x.s >= MIN_SCORE)
    .sort((a, b) => b.s - a.s)
    .slice(0, opts.max || MAX_ENTRIES);

  /* `grounded` reflects ONLY the scored, factual matches. Pinned behaviour must
     never make an ungrounded question look answered — otherwise the "I don't
     know" path would never fire and KASS would improvise. */
  const grounded = scored.length > 0;

  let used = 0;
  const parts = [];
  const chosen = [];

  for (const e of pinned) {
    const chunk = `[${e.category || 'general'}] ${e.title}\n${e.content}`;
    used += chunk.length;
    parts.push(chunk);
  }
  for (const { e, s } of scored) {
    const chunk = `[${e.category || 'general'}] ${e.title}\n${e.content}`;
    if (used + chunk.length > MAX_CHARS) break;
    used += chunk.length;
    parts.push(chunk);
    chosen.push({ id: e.id, title: e.title, score: s, version: e.version || 1 });
  }

  return {
    block: parts.join('\n\n---\n\n'),
    entries: chosen,     /* factual matches only — what feedback/analytics attribute to */
    grounded,
  };
}

/* ── Unanswered-question capture ──────────────────────────────────────────
   The single most valuable analytics signal: what users ask that KASS cannot
   ground. This is the backlog for the next knowledge update. */
async function logUnanswered({ query, uid, sessionId, reason }) {
  try {
    await db().collection(COL_UNANS).add({
      query: String(query || '').slice(0, 500),
      uid: uid || null,
      sessionId: sessionId || null,
      reason: reason || 'no_knowledge_match',
      resolved: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (err) {
    /* Analytics must never break a user's chat. */
    logger.warn('[KASS] logUnanswered failed', { error: err.message });
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   ADMIN CALLABLES — knowledge is managed, versioned and auditable
═════════════════════════════════════════════════════════════════════════ */

/* Create or update an entry. Every write bumps `version` and stamps the editor,
   so a wrong answer can be traced to who published it and when. */
exports.kassKnowledgeUpsert = onCall({ region: REGION }, async (request) => {
  const uid = await _assertAdmin(request);
  const { id, title, content, category, tags, questions, status, locale, source } = request.data || {};

  if (!title || !content) throw new HttpsError('invalid-argument', 'title and content are required.');
  if (String(content).length > 8000) throw new HttpsError('invalid-argument', 'content exceeds 8000 characters.');

  const ref = id ? db().collection(COL_KB).doc(id) : db().collection(COL_KB).doc();
  const existing = id ? await ref.get() : null;
  const prevVersion = existing && existing.exists ? (existing.data().version || 1) : 0;

  const doc = {
    title: String(title).slice(0, 200),
    content: String(content),
    category: category || 'general',
    tags: Array.isArray(tags) ? tags.map(t => String(t).toLowerCase()).slice(0, 25) : [],
    questions: Array.isArray(questions) ? questions.slice(0, 25) : [],
    locale: locale || 'ke',
    source: source || 'admin',
    status: status === 'published' ? 'published' : 'draft',
    version: prevVersion + 1,
    updatedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!existing || !existing.exists) doc.createdAt = admin.firestore.FieldValue.serverTimestamp();

  await ref.set(doc, { merge: true });
  _cache = { at: 0, entries: [] };   /* published set changed — drop the cache */

  return { ok: true, id: ref.id, version: doc.version, status: doc.status };
});

/* Publish / unpublish. Draft entries are never retrieved, so an admin can stage
   a change and review it before KASS starts asserting it to users. */
exports.kassKnowledgePublish = onCall({ region: REGION }, async (request) => {
  const uid = await _assertAdmin(request);
  const { id, publish } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');

  await db().collection(COL_KB).doc(id).update({
    status: publish === false ? 'draft' : 'published',
    updatedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  _cache = { at: 0, entries: [] };
  return { ok: true, id, status: publish === false ? 'draft' : 'published' };
});

exports.kassKnowledgeList = onCall({ region: REGION }, async (request) => {
  await _assertAdmin(request);
  const { status, category, limit } = request.data || {};
  let q = db().collection(COL_KB);
  if (status)   q = q.where('status', '==', status);
  if (category) q = q.where('category', '==', category);
  const snap = await q.limit(Math.min(Number(limit) || 200, 500)).get();
  return {
    ok: true,
    entries: snap.docs.map(d => {
      const e = d.data();
      return {
        id: d.id, title: e.title, category: e.category, tags: e.tags,
        status: e.status, version: e.version, updatedBy: e.updatedBy,
        preview: String(e.content || '').slice(0, 160),
      };
    }),
  };
});

/* Archive rather than hard-delete: a knowledge entry is a record of what the
   assistant was telling users at a point in time. */
exports.kassKnowledgeArchive = onCall({ region: REGION }, async (request) => {
  const uid = await _assertAdmin(request);
  const { id } = request.data || {};
  if (!id) throw new HttpsError('invalid-argument', 'id is required.');
  await db().collection(COL_KB).doc(id).update({
    status: 'archived', updatedBy: uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  _cache = { at: 0, entries: [] };
  return { ok: true, id, status: 'archived' };
});

/* Seed / re-sync the curated corpus. Idempotent: entries are keyed by a stable
   slug, so re-running updates in place instead of duplicating. */
exports.kassKnowledgeSeed = onCall({ region: REGION, timeoutSeconds: 300 }, async (request) => {
  const uid = await _assertAdmin(request);
  const { CORPUS, CORPUS_VERSION } = require('./kass-corpus');

  let written = 0;
  /* Firestore caps a batch at 500 writes. */
  for (let i = 0; i < CORPUS.length; i += 400) {
    const batch = db().batch();
    for (const e of CORPUS.slice(i, i + 400)) {
      const ref = db().collection(COL_KB).doc(e.slug);
      batch.set(ref, {
        title: e.title,
        content: e.content,
        category: e.category,
        tags: e.tags || [],
        questions: e.questions || [],
        locale: 'ke',
        source: `corpus@${CORPUS_VERSION}`,
        status: 'published',
        version: CORPUS_VERSION,
        updatedBy: uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      written++;
    }
    await batch.commit();
  }
  _cache = { at: 0, entries: [] };
  logger.info('[KASS] corpus seeded', { written, version: CORPUS_VERSION });
  return { ok: true, written, corpusVersion: CORPUS_VERSION };
});

/* ── Feedback loop ────────────────────────────────────────────────────────
   A thumbs-down paired with the retrieved entry IDs tells us exactly which
   knowledge produced a bad answer — that is what makes the loop actionable. */
exports.kassFeedback = onCall({ region: REGION }, async (request) => {
  const { sessionId, query, answer, rating, comment, knowledgeIds } = request.data || {};
  if (!['up', 'down'].includes(rating)) throw new HttpsError('invalid-argument', 'rating must be up or down.');

  await db().collection(COL_FEED).add({
    sessionId: sessionId || null,
    uid: (request.auth && request.auth.uid) || null,
    query: String(query || '').slice(0, 500),
    answer: String(answer || '').slice(0, 2000),
    rating,
    comment: String(comment || '').slice(0, 500),
    knowledgeIds: Array.isArray(knowledgeIds) ? knowledgeIds.slice(0, 10) : [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/* Analytics: what KASS is failing to answer, and which knowledge is failing. */
exports.kassKnowledgeStats = onCall({ region: REGION }, async (request) => {
  await _assertAdmin(request);

  const [kb, unans, feed] = await Promise.all([
    db().collection(COL_KB).limit(1000).get(),
    db().collection(COL_UNANS).where('resolved', '==', false)
      .orderBy('createdAt', 'desc').limit(100).get(),
    db().collection(COL_FEED).orderBy('createdAt', 'desc').limit(200).get(),
  ]);

  const byStatus = {};
  const byCategory = {};
  kb.docs.forEach(d => {
    const e = d.data();
    byStatus[e.status] = (byStatus[e.status] || 0) + 1;
    byCategory[e.category] = (byCategory[e.category] || 0) + 1;
  });

  /* Cluster unanswered questions by their content words so the backlog reads as
     themes ("how do refunds work") rather than 100 near-duplicate strings. */
  const clusters = {};
  unans.docs.forEach(d => {
    const key = _tokens(d.data().query).slice(0, 4).sort().join(' ') || '(empty)';
    clusters[key] = clusters[key] || { count: 0, examples: [] };
    clusters[key].count++;
    if (clusters[key].examples.length < 3) clusters[key].examples.push(d.data().query);
  });

  const ratings = feed.docs.map(d => d.data().rating);
  const down = feed.docs.filter(d => d.data().rating === 'down');
  const failingKnowledge = {};
  down.forEach(d => (d.data().knowledgeIds || []).forEach(id => {
    failingKnowledge[id] = (failingKnowledge[id] || 0) + 1;
  }));

  return {
    ok: true,
    knowledge: { total: kb.size, byStatus, byCategory },
    satisfaction: {
      up: ratings.filter(r => r === 'up').length,
      down: ratings.filter(r => r === 'down').length,
      sample: ratings.length,
    },
    unansweredTop: Object.entries(clusters)
      .sort((a, b) => b[1].count - a[1].count).slice(0, 20)
      .map(([theme, v]) => ({ theme, count: v.count, examples: v.examples })),
    knowledgeNeedingReview: Object.entries(failingKnowledge)
      .sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([id, downvotes]) => ({ id, downvotes })),
  };
});

/* Internal API for sokoniChat */
module.exports.retrieve = retrieve;
module.exports.logUnanswered = logUnanswered;
