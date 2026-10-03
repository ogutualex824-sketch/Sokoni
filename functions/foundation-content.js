/* ============================================================================
   SOKONI Foundation — stories, testimonials and the Media House (2026-10-01)
   ----------------------------------------------------------------------------
   ONE content record per story/testimonial: foundationStories/{id}. Many views (Foundation home,
   below the donation wizard, a programme page, the Banking Hub Foundation module) are QUERIES over
   it via `destinations` — never copies.

   AUTHORITY (owner-sanctioned, sokoni-aa 2026-10-01): pre-publication approval lives HERE, not in the
   product-moderation queue. State names match that queue so the two read side by side:
       moderation.status: pending | approved | rejected | changes_requested | archived | removed
   Story lifecycle → moderation.status:
       DRAFT     = status 'draft' (admin-authored, not yet submitted; no public effect)
       REVIEW    = pending
       APPROVED  = approved
       PUBLISHED = approved AND server-written publishAt <= now
       ARCHIVED  = archived
   Only this module writes `moderation`, `publishAt`, `kind`, media tokens. foundationStories has NO
   rules match (client deny); every read and write is this callable.

   CONSENT (testimonials): explicit and stored with the record (version + time). Publishing needs
   consent.publish; the name is shown only with consent.showName, media only with consent.showMedia.
   The submitter can withdraw at any time → archived + media revoked.

   MEDIA: uploaded by the browser to Storage under foundation-media/{uid}/ (testimonials) or
   foundation-media/admin/ (Media House). The server re-reads each object's metadata (type, size) —
   the browser's word is never taken. Public access is a Firebase download token that exists ONLY while
   the story is approved and published; the foundationStoryMediaGuard trigger revokes tokens on any
   other state. No server transcoding exists on the platform: videos are capped (80 MB, mp4/webm/mov),
   the client compresses images and captures a thumbnail; transcoding is a documented gap.

   NO FABRICATION: nothing is seeded; an empty Foundation shows an invitation, not invented proof.
   ============================================================================ */
'use strict';
const crypto = require('crypto');
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const { onDocumentWritten } = require('firebase-functions/v2/firestore');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp();
const db = () => admin.firestore();
const lim = require('./shared/durable-limit');

const OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB', minInstances: 0 };
const COL = 'foundationStories';
const STATES = ['draft', 'pending', 'approved', 'rejected', 'changes_requested', 'archived', 'removed'];
const DESTINATIONS = ['foundation_home', 'donation_wizard', 'programme', 'banking_hub'];
const CONSENT_VERSION = '2026-10-01';
const MEDIA = {
  image: { types: ['image/jpeg', 'image/png', 'image/webp'], max: 15 * 1024 * 1024 },
  video: { types: ['video/mp4', 'video/webm', 'video/quicktime'], max: 80 * 1024 * 1024 },
};
/* action → { from: allowed current states, to } */
const DECISIONS = {
  approve:         { from: ['pending'], to: 'approved' },
  reject:          { from: ['pending'], to: 'rejected' },
  request_changes: { from: ['pending'], to: 'changes_requested' },
  archive:         { from: ['approved'], to: 'archived' },
  restore:         { from: ['archived'], to: 'pending' },
  remove:          { from: ['draft', 'pending', 'approved', 'rejected', 'changes_requested', 'archived'], to: 'removed' },
};
const NOTE_REQUIRED = new Set(['reject', 'request_changes', 'remove']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,160}$/;
const bad = (m) => { throw new HttpsError('invalid-argument', m); };
const ts = () => admin.firestore.FieldValue.serverTimestamp();
const ms = (v) => (v && typeof v.toMillis === 'function' ? v.toMillis() : (typeof v === 'number' ? v : null));
const isAdmin = (req) => { const t = (req.auth && req.auth.token) || {}; return !!req.auth && (t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'super_admin' || t.role === 'superAdmin'); };
function text(v, max, label, required) {
  if (v == null || v === '') { if (required) bad(label + ' is required.'); return null; }
  if (typeof v !== 'string') bad(label + ' must be text.');
  const s = v.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f<>]/g, ' ').replace(/[ \t]+/g, ' ').trim();
  if (!s) { if (required) bad(label + ' is required.'); return null; }
  if (s.length > max) bad(label + ' is too long (max ' + max + ').');
  return s;
}
const excerpt = (body) => { const s = String(body || '').replace(/\s+/g, ' ').trim(); return s.length > 220 ? s.slice(0, 217).trimEnd() + '…' : s; };

async function programme(id) {
  if (id == null || id === '') return null;
  if (typeof id !== 'string' || !ID_RE.test(id)) bad('Invalid programme.');
  const s = await db().collection('impactCampaigns').doc(id).get();
  if (!s.exists || s.data().status !== 'active') bad('That programme is not active.');
  return id;
}
function destinations(v, fallback) {
  const list = Array.isArray(v) ? v.filter((d) => DESTINATIONS.includes(d)) : [];
  const out = [...new Set(list)];
  return out.length ? out : fallback;
}

/* Re-read every uploaded object server-side; the browser's type/size claims are ignored. */
async function media(paths, prefix) {
  if (paths == null) return [];
  if (!Array.isArray(paths) || paths.length > 4) bad('Attach at most 4 photos or videos.');
  const bucket = admin.storage().bucket();
  const out = [];
  for (const p of paths) {
    if (typeof p !== 'string' || !p.startsWith(prefix) || p.includes('..') || p.length > 300 || !/^[A-Za-z0-9/_.-]+$/.test(p)) bad('Invalid media file.');
    let meta;
    try { [meta] = await bucket.file(p).getMetadata(); } catch (_) { bad('A media file was not found. Upload it again.'); }
    const ct = String(meta.contentType || '').toLowerCase(), size = Number(meta.size || 0);
    const type = MEDIA.image.types.includes(ct) ? 'image' : (MEDIA.video.types.includes(ct) ? 'video' : null);
    if (!type) bad('Only JPEG, PNG or WebP photos and MP4, WebM or MOV videos are accepted.');
    if (!(size > 0) || size > MEDIA[type].max) bad(type === 'video' ? 'Videos must be 80 MB or smaller.' : 'Photos must be 15 MB or smaller.');
    out.push({ path: p, type, contentType: ct, size, mediaId: mediaIdOf(p) });
  }
  if (out.filter((m) => m.type === 'video').length > 1) bad('Attach at most one video.');
  return out;
}

/* Public media is a COPY at a neutral path (foundation-published/{storyId}/{n}) — the participant's upload path
   carries their uid and must never appear in a public URL. Publishing creates the copy + a download token;
   revoking deletes the copy, so an old URL stops working. */
/* Server-side processing (media-worker codebase, foundationMediaProcess): every upload is quarantined,
   probe-validated, transcoded/compressed with a thumbnail, and recorded in foundationMedia/{mediaId} as
   UPLOADED | PROCESSING | READY | FAILED | REJECTED — written ONLY by the worker. Public content consumes ONLY
   READY derivatives; the original upload is never published. */
const mediaIdOf = (sourcePath) => crypto.createHash('sha256').update(String(sourcePath)).digest('hex').slice(0, 32);
async function processingStates(items) {
  const list = items || [];
  if (!list.length) return [];
  const refs = list.map((m) => db().collection('foundationMedia').doc(m.mediaId || mediaIdOf(m.path)));
  const snaps = await db().getAll(...refs);
  return snaps.map((x) => (x.exists ? x.data() : null));
}
async function requireReady(items) {
  const recs = await processingStates(items);
  const out = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i], m = items[i];
    const st = r ? r.state : 'UPLOADED';
    if (st === 'REJECTED' || st === 'FAILED') throw new HttpsError('failed-precondition', 'A media file was ' + (st === 'REJECTED' ? 'rejected' : 'not processed') + ' (' + String((r.error && r.error.reason) || st).slice(0, 60) + '). Remove it or upload it again.', { code: 'MEDIA_' + st });
    if (st !== 'READY' || !r.derivatives || !r.derivatives.main || r.kind !== m.type) throw new HttpsError('failed-precondition', 'Media is still processing. Try publishing again in a few minutes.', { code: 'MEDIA_NOT_READY' });
    out.push(r.derivatives);
  }
  return out;
}
async function setTokens(items, on, storyId, derivs) {
  const bucket = admin.storage().bucket();
  const res = [];
  for (let i = 0; i < (items || []).length; i++) {
    const m = items[i];
    try {
      if (on) {
        const dv = derivs && derivs[i];
        if (!dv || !dv.main) throw new Error('no READY derivative');
        const stem = 'foundation-published/' + storyId + '/' + i + '-' + crypto.randomBytes(6).toString('hex');
        const pub = m.publicPath || (stem + (dv.main.contentType === 'video/mp4' ? '.mp4' : '.webp'));
        const token = m.token || crypto.randomUUID();
        if (!m.publicPath) await bucket.file(dv.main.path).copy(bucket.file(pub));
        await bucket.file(pub).setMetadata({ metadata: { firebaseStorageDownloadTokens: token }, contentType: dv.main.contentType });
        let thumb = m.thumb || null;
        if (!thumb && dv.thumb) {
          const tp = stem + '-thumb.jpg', tt = crypto.randomUUID();
          await bucket.file(dv.thumb.path).copy(bucket.file(tp));
          await bucket.file(tp).setMetadata({ metadata: { firebaseStorageDownloadTokens: tt }, contentType: 'image/jpeg' });
          thumb = { publicPath: tp, token: tt };
        }
        res.push({ ...m, publicPath: pub, token, publishedContentType: dv.main.contentType, thumb });
      } else {
        for (const pth of [m.publicPath, m.thumb && m.thumb.publicPath]) {
          if (pth) { try { await bucket.file(pth).delete(); } catch (e) { if (!/No such object|not found|404/i.test(e.message || '')) throw e; } }
        }
        const { token, publicPath, thumb, publishedContentType, ...rest } = m; res.push(rest);
      }
    } catch (e) {
      logger.warn('[foundation-content] media publish/revoke failed', { story: storyId, on, err: e.message });
      if (on) throw new HttpsError('unavailable', 'Could not prepare the media for publishing. Try again.');
      res.push(m);
    }
  }
  return res;
}

async function transition(tx, ref, entry) {
  tx.set(ref.collection('transitions').doc(), { ...entry, at: ts() });
}

/* ── Public ───────────────────────────────────────────────────────────────────────────────── */
function publicRow(id, s, bucketName) {
  const isT = s.kind === 'testimonial';
  const c = s.consent || {};
  const subj = s.subject || {};
  let name = null;
  if (!isT) name = subj.displayName || null;
  else if (c.showName && subj.displayName) name = subj.displayPreference === 'first_name' ? String(subj.displayName).split(/\s+/)[0] : subj.displayName;
  const mediaOk = !isT || c.showMedia === true;
  const url = (m) => (m.token && m.publicPath ? 'https://firebasestorage.googleapis.com/v0/b/' + bucketName + '/o/' + encodeURIComponent(m.publicPath) + '?alt=media&token=' + m.token : null);
  return {
    id, kind: s.kind, title: s.title, excerpt: s.excerpt, body: s.body,
    name: name || (isT ? 'A SOKONI Foundation beneficiary' : null),
    location: subj.location || null, programmeId: s.programmeId || null,
    media: mediaOk ? (s.media || []).filter((m) => m.token && m.publicPath).map((m) => ({ type: m.type, contentType: m.publishedContentType || null, url: url(m), thumbUrl: m.thumb && m.thumb.token ? url(m.thumb) : null })) : [],
    publishedAt: ms(s.publishAt),
  };
}
async function listPublished(req, d) {
  await lim.limit(db(), admin, { bucket: 'fcPublic', key: lim.clientKey(req.rawRequest), max: 240, windowSec: 600 });
  let q = db().collection(COL).where('moderation.status', '==', 'approved');
  if (d.destination) q = q.where('destinations', 'array-contains', DESTINATIONS.includes(d.destination) ? d.destination : bad('Invalid destination.'));
  if (d.programmeId) { if (!ID_RE.test(d.programmeId)) bad('Invalid programme.'); q = q.where('programmeId', '==', d.programmeId); }
  q = q.where('publishAt', '<=', admin.firestore.Timestamp.now()).orderBy('publishAt', 'desc');
  const size = Math.min(Math.max(Number(d.limit) || 6, 1), 12);
  if (d.cursor) { if (!ID_RE.test(d.cursor)) bad('Invalid cursor.'); const c = await db().collection(COL).doc(d.cursor).get(); if (c.exists) q = q.startAfter(c); }
  const s = await q.limit(size).get();
  const bucketName = admin.storage().bucket().name;
  return { rows: s.docs.map((doc) => publicRow(doc.id, doc.data(), bucketName)), next: s.docs.length === size ? s.docs[s.docs.length - 1].id : null };
}

/* ── Participants ─────────────────────────────────────────────────────────────────────────── */
async function submitTestimonial(req, d) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in to share your story.');
  const uid = req.auth.uid;
  if (typeof d.requestId !== 'string' || !UUID_RE.test(d.requestId)) bad('Invalid request.');
  const c = d.consent || {};
  if (c.publish !== true) bad('Tick the box to agree that SOKONI Foundation may publish your story.');
  const pref = ['name', 'first_name', 'anonymous'].includes(d.displayPreference) ? d.displayPreference : 'anonymous';
  const f = {
    title: text(d.title, 120, 'Title', true),
    body: text(d.body, 5000, 'Your story', true),
    programmeId: await programme(d.programmeId),
    subject: { displayName: text(d.displayName, 80, 'Name', pref !== 'anonymous'), displayPreference: pref, location: text(d.location, 60, 'Location (town or county)') },
  };
  const m = await media(d.media, 'foundation-media/' + uid + '/');
  await lim.limit(db(), admin, { bucket: 'fcTestimonial', key: lim.sha(uid).slice(0, 32), max: 3, windowSec: 86400 });
  /* the id is public (it appears in links) — derived, never the raw uid */
  const ref = db().collection(COL).doc('T_' + crypto.createHash('sha256').update(uid + '|' + d.requestId).digest('hex').slice(0, 28));
  let already = false;
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists) { already = true; return; }
    tx.create(ref, {
      kind: 'testimonial', ...f, excerpt: excerpt(f.body), media: m,
      destinations: ['foundation_home', 'donation_wizard', ...(f.programmeId ? ['programme'] : [])],
      consent: { publish: true, showName: pref !== 'anonymous' && c.showName !== false, showMedia: c.showMedia === true, version: CONSENT_VERSION, at: ts() },
      submittedBy: uid, createdBy: uid, createdAt: ts(), updatedAt: ts(),
      moderation: { status: 'pending', decidedAt: null, decidedBy: null, note: null }, publishAt: null,
    });
    await transition(tx, ref, { action: 'submit', to: 'pending', actor: uid, role: 'participant' });
  });
  return { ok: true, id: ref.id, status: 'pending', alreadySubmitted: already };
}
async function listMine(req) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in.');
  const s = await db().collection(COL).where('submittedBy', '==', req.auth.uid).limit(20).get();
  return { rows: s.docs.map((doc) => { const x = doc.data(); return { id: doc.id, title: x.title, status: (x.moderation || {}).status, note: (x.moderation || {}).note || null, published: (x.moderation || {}).status === 'approved' && !!x.publishAt, createdAt: ms(x.createdAt) }; }) };
}
async function withdrawMine(req, d) {
  if (!req.auth) throw new HttpsError('unauthenticated', 'Sign in.');
  if (!ID_RE.test(d.id || '')) bad('Invalid story.');
  const ref = db().collection(COL).doc(d.id);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().submittedBy !== req.auth.uid) throw new HttpsError('not-found', 'Story not found.');
    const st = (s.data().moderation || {}).status;
    if (st === 'removed' || st === 'archived') return;
    tx.update(ref, { 'moderation.status': 'archived', 'moderation.decidedAt': ts(), 'moderation.decidedBy': req.auth.uid, 'moderation.note': 'Consent withdrawn by the participant', 'consent.publish': false, 'consent.withdrawnAt': ts(), publishAt: null, updatedAt: ts() });
    await transition(tx, ref, { action: 'withdraw_consent', from: st, to: 'archived', actor: req.auth.uid, role: 'participant' });
  });
  return { ok: true };
}

/* ── Media House (admins) ─────────────────────────────────────────────────────────────────── */
async function adminSaveStory(req, d) {
  const f = {
    title: text(d.title, 120, 'Title', true),
    body: text(d.body, 5000, 'Story', true),
    programmeId: await programme(d.programmeId),
    subject: { displayName: text(d.displayName, 80, 'Byline'), displayPreference: 'name', location: text(d.location, 60, 'Location') },
  };
  const m = await media(d.media, 'foundation-media/admin/');
  const dest = destinations(d.destinations, ['foundation_home', 'donation_wizard']);
  const store = db();
  if (d.id) {
    if (!ID_RE.test(d.id)) bad('Invalid story.');
    const ref = store.collection(COL).doc(d.id);
    await store.runTransaction(async (tx) => {
      const s = await tx.get(ref);
      if (!s.exists || s.data().kind !== 'story') throw new HttpsError('not-found', 'Story not found.');
      const st = s.data().moderation.status;
      if (!['draft', 'changes_requested', 'pending'].includes(st)) throw new HttpsError('failed-precondition', 'Archive or restore this story before editing it.');
      const to = st === 'changes_requested' ? 'pending' : st;   /* an edit answering "changes requested" goes back for review */
      tx.update(ref, { ...f, excerpt: excerpt(f.body), media: m, destinations: dest, 'moderation.status': to, updatedAt: ts(), updatedBy: req.auth.uid });
      await transition(tx, ref, { action: 'edit', from: st, to, actor: req.auth.uid, role: 'admin' });
    });
    return { ok: true, id: d.id };
  }
  if (typeof d.requestId !== 'string' || !UUID_RE.test(d.requestId)) bad('Invalid request.');
  const ref = store.collection(COL).doc('S_' + d.requestId);
  await store.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (s.exists) return;
    tx.create(ref, {
      kind: 'story', ...f, excerpt: excerpt(f.body), media: m, destinations: dest,
      createdBy: req.auth.uid, createdAt: ts(), updatedAt: ts(),
      moderation: { status: d.submit === true ? 'pending' : 'draft', decidedAt: null, decidedBy: null, note: null }, publishAt: null,
    });
    await transition(tx, ref, { action: 'create', to: d.submit === true ? 'pending' : 'draft', actor: req.auth.uid, role: 'admin' });
  });
  return { ok: true, id: ref.id };
}
async function adminSubmit(req, d) {
  if (!ID_RE.test(d.id || '')) bad('Invalid story.');
  const ref = db().collection(COL).doc(d.id);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().moderation.status !== 'draft') throw new HttpsError('failed-precondition', 'Only a draft can be sent for review.');
    tx.update(ref, { 'moderation.status': 'pending', updatedAt: ts() });
    await transition(tx, ref, { action: 'submit', from: 'draft', to: 'pending', actor: req.auth.uid, role: 'admin' });
  });
  return { ok: true, status: 'pending' };
}
async function adminDecide(req, d) {
  if (!ID_RE.test(d.id || '')) bad('Invalid story.');
  const rule = DECISIONS[d.action];
  if (!rule) bad('Invalid action.');
  const note = text(d.note, 500, 'Note', NOTE_REQUIRED.has(d.action));
  const ref = db().collection(COL).doc(d.id);
  let from = null;
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Story not found.');
    const x = s.data();
    from = x.moderation.status;
    if (!rule.from.includes(from)) throw new HttpsError('failed-precondition', 'This story is "' + from + '" — that action is not possible now.');
    if (d.action === 'approve') {
      if (x.createdBy === req.auth.uid) throw new HttpsError('permission-denied', 'Another administrator must approve a story you wrote.');
      if (x.kind === 'testimonial' && !(x.consent && x.consent.publish === true)) throw new HttpsError('failed-precondition', 'The participant has not consented to publication.');
    }
    const patch = { 'moderation.status': rule.to, 'moderation.decidedAt': ts(), 'moderation.decidedBy': req.auth.uid, 'moderation.note': note, updatedAt: ts() };
    if (rule.to !== 'approved') patch.publishAt = null;
    tx.update(ref, patch);
    await transition(tx, ref, { action: d.action, from, to: rule.to, actor: req.auth.uid, role: 'admin', note });
    tx.set(db().collection('adminActions').doc(), { type: 'foundation_story_decision', storyId: d.id, action: d.action, from, to: rule.to, adminUid: req.auth.uid, at: ts() });
  });
  return { ok: true, status: rule.to };
}
async function adminPublish(req, d) {
  if (!ID_RE.test(d.id || '')) bad('Invalid story.');
  const ref = db().collection(COL).doc(d.id);
  const snap = await ref.get();
  if (!snap.exists || snap.data().moderation.status !== 'approved') throw new HttpsError('failed-precondition', 'Approve the story before publishing it.');
  const x = snap.data();
  let at = Date.now();
  if (d.publishAt != null) { at = Number(d.publishAt); if (!Number.isFinite(at) || at < Date.now() - 60000 || at > Date.now() + 90 * 86400000) bad('Schedule within the next 90 days.'); }
  const showMedia = x.kind !== 'testimonial' || (x.consent && x.consent.showMedia === true);
  const derivs = showMedia ? await requireReady(x.media) : null;   /* refuses unless every item is READY */
  const withTokens = showMedia ? await setTokens(x.media, true, d.id, derivs) : x.media;
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists || s.data().moderation.status !== 'approved') throw new HttpsError('failed-precondition', 'The story is no longer approved.');
    tx.update(ref, { publishAt: admin.firestore.Timestamp.fromMillis(at), media: withTokens, publishedBy: req.auth.uid, updatedAt: ts() });
    await transition(tx, ref, { action: 'publish', actor: req.auth.uid, role: 'admin', publishAt: at });
    tx.set(db().collection('adminActions').doc(), { type: 'foundation_story_publish', storyId: d.id, adminUid: req.auth.uid, publishAt: at, at: ts() });
  });
  return { ok: true, publishAt: at };
}
async function adminUnpublish(req, d) {
  if (!ID_RE.test(d.id || '')) bad('Invalid story.');
  const ref = db().collection(COL).doc(d.id);
  await db().runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) throw new HttpsError('not-found', 'Story not found.');
    tx.update(ref, { publishAt: null, updatedAt: ts() });
    await transition(tx, ref, { action: 'unpublish', actor: req.auth.uid, role: 'admin' });
  });
  return { ok: true };   /* the media guard trigger revokes the tokens */
}
async function adminList(req, d) {
  let q = db().collection(COL);
  if (d.status) q = q.where('moderation.status', '==', STATES.includes(d.status) ? d.status : bad('Invalid status.'));
  if (d.kind) q = q.where('kind', '==', ['story', 'testimonial'].includes(d.kind) ? d.kind : bad('Invalid kind.'));
  const s = await q.orderBy('updatedAt', 'desc').limit(50).get();
  const states = await Promise.all(s.docs.map((doc) => processingStates(doc.data().media).catch(() => [])));
  return { rows: s.docs.map((doc, di) => { const x = doc.data(); return {
    id: doc.id, kind: x.kind, title: x.title, excerpt: x.excerpt, programmeId: x.programmeId || null,
    status: x.moderation.status, note: x.moderation.note || null, published: x.moderation.status === 'approved' && !!x.publishAt && ms(x.publishAt) <= Date.now(),
    scheduledFor: ms(x.publishAt), destinations: x.destinations || [], media: (x.media || []).map((m, mi) => ({ type: m.type, size: m.size, path: m.path, processing: (states[di][mi] && states[di][mi].state) || 'UPLOADED', reason: (states[di][mi] && states[di][mi].error && states[di][mi].error.reason) || null })),
    consent: x.kind === 'testimonial' ? { publish: !!(x.consent || {}).publish, showName: !!(x.consent || {}).showName, showMedia: !!(x.consent || {}).showMedia } : null,
    displayName: (x.subject || {}).displayName || null, createdBy: x.createdBy, updatedAt: ms(x.updatedAt) }; }) };
}
async function adminCounts() {
  const c = async (q) => { try { return (await q.count().get()).data().count; } catch (_) { return null; } };
  const col = db().collection(COL);
  const [pending, approved, changes, testimonials, stories] = await Promise.all([
    c(col.where('moderation.status', '==', 'pending')), c(col.where('moderation.status', '==', 'approved')),
    c(col.where('moderation.status', '==', 'changes_requested')), c(col.where('kind', '==', 'testimonial')), c(col.where('kind', '==', 'story')),
  ]);
  return { pending, approved, changesRequested: changes, testimonials, stories };
}

/* ── Dispatch ─────────────────────────────────────────────────────────────────────────────── */
const ADMIN_OPS = { adminSaveStory, adminSubmit, adminDecide, adminPublish, adminUnpublish, adminList, adminCounts };
async function handle(req) {
  const d = (req.data && typeof req.data === 'object') ? req.data : {};
  switch (d.op) {
    case 'listPublished': return listPublished(req, d);
    case 'submitTestimonial': return submitTestimonial(req, d);
    case 'listMine': return listMine(req);
    case 'withdrawMine': return withdrawMine(req, d);
    default: break;
  }
  const fn = ADMIN_OPS[d.op];
  if (!fn) bad('Unknown op.');
  if (!isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
  return fn(req, d);
}
exports.foundationContentDispatch = onCall(OPTS, async (req) => {
  try { return await handle(req); }
  catch (e) {
    if (e instanceof HttpsError) throw e;
    logger.error('[foundation-content] unexpected', { op: req.data && req.data.op, err: e.message });
    throw new HttpsError('internal', 'Something went wrong. Please try again.');
  }
});

/* Media is public ONLY while approved AND published. Any other state (unpublish, archive, remove,
   consent withdrawal, a re-review) revokes every download token. Idempotent. */
async function guard(before, after) {
  const live = after && after.moderation && after.moderation.status === 'approved' && after.publishAt
    && (after.kind !== 'testimonial' || (after.consent && after.consent.publish === true && after.consent.showMedia === true));
  const dropped = (before && before.media ? before.media : []).filter((m) => m.token && !(after && (after.media || []).some((n) => n.path === m.path)));
  const revokeNow = live ? [] : (after && after.media ? after.media : []).filter((m) => m.token);
  const all = [...dropped, ...revokeNow];
  if (!all.length) return { revoked: 0 };
  await setTokens(all, false, null);
  return { revoked: all.length, clearDoc: revokeNow.length > 0 };
}
const stripTokens = (list) => (list || []).map((m) => { const { token, publicPath, thumb, publishedContentType, ...rest } = m; return rest; });
exports.foundationStoryMediaGuard = onDocumentWritten({ document: COL + '/{id}', region: 'us-central1' }, async (event) => {
  const before = event.data && event.data.before && event.data.before.exists ? event.data.before.data() : null;
  const after = event.data && event.data.after && event.data.after.exists ? event.data.after.data() : null;
  const r = await guard(before, after);
  if (r.clearDoc && event.data.after.exists) {
    await event.data.after.ref.update({ media: stripTokens(after.media) });
  }
  if (r.revoked) logger.info('[foundation-content] media tokens revoked', { id: event.params.id, count: r.revoked });
});
exports._test = { handle, guard, stripTokens, publicRow, DECISIONS, mediaIdOf };
