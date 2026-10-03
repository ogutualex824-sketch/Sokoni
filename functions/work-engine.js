'use strict';
/**
 * SOKONI Work/Job Engine — server (WE1, 2026-10-03). ONE callable: workDispatch({ op, ... }).
 * Category-neutral core (owner architecture 2026-09-28); Marketing campaigns/projects are the first skin, Construction
 * (BOQ / tender via rfqDispatch / variations) the next — on the SAME records, never a fork (shape agreed with sokoni-f3).
 *
 *   workProjects/{id}   server-write only; readable by its parties + admin (rules block → f3's combined rules file)
 *     skin, kind                 'marketing' · 'campaign' | 'project'
 *     customerUid, providerUid   parties, derived on the server (from the accepted quote, or the provider + a named customer)
 *     providerBusinessId         optional — a business the provider OWNS (businesses/{id}.ownerId === providerUid)
 *     origin                     { type: 'service_lead' | 'direct', leadId, quoteVersion, acceptedQuote snapshot }
 *                                ('rfq' is Construction's — refused here until it is wired to rfqDispatch)
 *     scope                      { title, description, deliverables, startDate, endDate, lines[], milestones[] }
 *                                lines {lineId, kind material|labour|equipment|other, description, unit, qty, rateCents,
 *                                amountCents = qty × rate (server)} · totalCents = Σ lines (server) · milestones partition it
 *     status                     work-engine.js STATES; every move checked by actor (work-engine.js MOVES)
 *     changeRequests[]           {crId, addLines, removeLineIds, deltaCents, milestone?, reason, status proposed|approved|declined}
 *                                — nothing above the accepted scope is added without the CUSTOMER approving a CR
 *     evidence[]                 {milestoneId, type photo|inspection|note|checklist, ref, note, by, atMs}
 *     completion                 {kind delivered|practical_completion|handover, acceptedBy, atMs}
 *     commercial                 {fee: {configured, enabled, ...}, charged: false} — READ from config; never charged here
 *
 * Money is NOT in WE1: a milestone is paid through the canonical booking/IntaSend/hold/PIN/settlement path (WE2). This
 * module never prices a payment, never charges a fee and never credits a wallet.
 */
const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const W = require('./shared/work-engine');

const _OPTS = { region: 'us-central1', enforceAppCheck: true, timeoutSeconds: 60, memory: '256MiB' };
const db = () => admin.firestore();
const _ts = () => admin.firestore.FieldValue.serverTimestamp();
const LINE_KINDS = ['material', 'labour', 'equipment', 'other'];
const EVIDENCE_TYPES = ['photo', 'inspection', 'note', 'checklist'];
const COMPLETION_KINDS = ['delivered', 'practical_completion', 'handover'];

function _uid(req) { if (!req.auth || !req.auth.uid) throw new HttpsError('unauthenticated', 'Sign in to continue.'); return req.auth.uid; }
const _isAdmin = (req) => !!(req.auth && req.auth.token && (req.auth.token.admin === true || req.auth.token.superAdmin === true));
const _s = (v, max) => (v == null ? '' : String(v).replace(/[<>]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max));
const _int = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const _wrap = (e) => { if (e instanceof W.WorkError) throw new HttpsError(e.code === 'WORK_MOVE_REFUSED' ? 'permission-denied' : 'failed-precondition', e.message, { code: e.code }); throw e; };

/** Scope lines → server amounts. qty is a decimal (3 dp); rate is integer cents; amount = round(qty × rate). */
function _lines(list, prefix) {
  return (Array.isArray(list) ? list : []).slice(0, 200).map((l, i) => {
    const qty = Math.round(Math.max(0, Math.min(1e6, Number(l && l.qty) || 0)) * 1000) / 1000;
    const rate = _int(l && l.rateCents, 0, 1e11) || 0;
    return { lineId: (prefix || 'l') + (i + 1), kind: LINE_KINDS.indexOf(l && l.kind) >= 0 ? l.kind : 'other', description: _s(l && l.description, 300),
      unit: _s(l && l.unit, 20) || 'item', qty, rateCents: rate, amountCents: Math.round(qty * rate) };
  }).filter((l) => l.description && l.qty > 0);
}
const _total = (lines) => lines.reduce((s, l) => s + l.amountCents, 0);

/** The disabled-by-default fee hook (sokoni-f3 #6): read configuration; absent ⇒ not configured; NEVER charged here. */
function _commercial(skin, kind) {
  let fee = { configured: false, enabled: false, source: 'none' };
  try {
    const cc = require('./commission-config');
    if (typeof cc.workFeeFor === 'function') { const f = cc.workFeeFor(skin, kind) || {}; fee = { configured: !!f.configured, enabled: f.enabled === true, pct: f.pct == null ? null : Number(f.pct), effectiveFrom: f.effectiveFrom || null, source: 'commission-config' }; }
  } catch (_) { /* no config module on this tree → not configured (never a default rate) */ }
  return { fee, charged: false };
}

async function _load(id) {
  const ref = db().collection('workProjects').doc(_s(id, 160));
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Project not found.');
  return { ref, p: snap.data() || {} };
}
function _actor(req, p, allowAdmin) {
  const uid = _uid(req);
  if (uid === p.providerUid) return 'provider';
  if (uid === p.customerUid) return 'customer';
  if (allowAdmin && _isAdmin(req)) return 'admin';
  throw new HttpsError('permission-denied', 'Not a party to this project.');
}
function _view(id, p) {
  return { id, skin: p.skin, kind: p.kind, status: p.status, customerUid: p.customerUid, providerUid: p.providerUid, providerBusinessId: p.providerBusinessId || null,
    origin: p.origin || null, scope: p.scope || {}, totalCents: p.totalCents || 0, changeRequests: p.changeRequests || [], evidence: p.evidence || [],
    completion: p.completion || null, commercial: p.commercial || null, history: (p.history || []).slice(-50) };
}
const _ev = (actor, uid, action, extra) => Object.assign({ actor, by: uid, action, atMs: Date.now() }, extra || {});

const _h = {
  /** Provider: draft a project. From an accepted quote (origin service_lead, idempotent per lead + quote version), or
   *  directly for a named customer (origin direct). Parties always come from the server. */
  async workCreate(req) {
    const uid = _uid(req);
    const d = req.data || {};
    const skin = W.SKINS[d.skin] ? d.skin : null;
    if (!skin) throw new HttpsError('invalid-argument', 'Unknown skin.', { code: 'WORK_SKIN' });
    if (W.SKINS[skin].kinds.indexOf(d.kind) < 0) throw new HttpsError('invalid-argument', 'Unknown kind for this skin.', { code: 'WORK_KIND' });
    let customerUid, origin, id, seedLines = [];
    if (d.originType === 'service_lead') {
      const leadId = _s(d.leadId, 128);
      const ls = await db().collection('serviceLeads').doc(leadId).get();
      if (!ls.exists) throw new HttpsError('not-found', 'Lead not found.');
      const lead = ls.data() || {};
      if (lead.providerId !== uid) throw new HttpsError('permission-denied', 'Not your lead.');
      if (lead.status !== 'quote_accepted') throw new HttpsError('failed-precondition', 'The customer must accept your quote first.', { code: 'WORK_QUOTE_NOT_ACCEPTED' });
      const q = lead.quote || {};
      customerUid = lead.customerUid;
      id = 'wp_lead_' + leadId + '_v' + (q.version || 1);
      origin = { type: 'service_lead', leadId, quoteVersion: q.version || 1, acceptedQuote: { amountCents: Math.round(Number(q.amountCents) || 0), serviceId: q.serviceId || null, description: _s(q.description, 1000) } };
      seedLines = [{ lineId: 'l1', kind: 'other', description: origin.acceptedQuote.description || 'Accepted quote', unit: 'item', qty: 1, rateCents: origin.acceptedQuote.amountCents, amountCents: origin.acceptedQuote.amountCents }];
    } else if (d.originType === 'direct') {
      customerUid = _s(d.customerUid, 128);
      if (!customerUid || customerUid === uid) throw new HttpsError('invalid-argument', 'Name the customer (not yourself).', { code: 'WORK_CUSTOMER' });
      const cu = await db().collection('users').doc(customerUid).get();
      if (!cu.exists) throw new HttpsError('not-found', 'Customer account not found.');
      origin = { type: 'direct' };
      id = db().collection('workProjects').doc().id;
    } else {
      throw new HttpsError('invalid-argument', 'originType must be service_lead or direct (rfq is wired by Construction).', { code: 'WORK_ORIGIN_UNSUPPORTED' });
    }
    let providerBusinessId = null;
    if (d.providerBusinessId) {
      const b = await db().collection('businesses').doc(_s(d.providerBusinessId, 128)).get();
      if (!b.exists || (b.data() || {}).ownerId !== uid) throw new HttpsError('permission-denied', 'You do not own that business.', { code: 'WORK_BUSINESS' });
      providerBusinessId = b.id;
    }
    if (skin === 'marketing') {
      const pr = await db().collection('providers').doc(uid).get();
      const p = pr.exists ? pr.data() : null;
      if (!(p && p.marketingStatus === 'active' && p.marketingListed === true)) throw new HttpsError('permission-denied', 'Only an approved SOKONI marketer can create marketing campaigns or projects.', { code: 'WORK_NOT_APPROVED' });
    }
    const scope = W.sanitizeScope(d.scope);
    const lines = _lines(d.scope && d.scope.lines).length ? _lines(d.scope && d.scope.lines) : seedLines;
    const ref = db().collection('workProjects').doc(id);
    const out = await db().runTransaction(async (t) => {
      const cur = await t.get(ref);
      if (cur.exists) return { existing: true };       /* idempotent per accepted quote */
      t.set(ref, { skin, kind: d.kind, status: 'draft', customerUid, providerUid: uid, providerBusinessId, origin,
        scope: Object.assign(scope, { lines }), totalCents: _total(lines), changeRequests: [], evidence: [], completion: null,
        commercial: _commercial(skin, d.kind), parties: [uid, customerUid], history: [_ev('provider', uid, 'created', { origin: origin.type })], createdAt: _ts(), updatedAt: _ts() });
      return { existing: false };
    });
    return { ok: true, projectId: id, existing: out.existing };
  },

  /** Provider edits scope while the project is a DRAFT. Totals are recomputed server-side. */
  async workUpdateScope(req) {
    const { ref, p } = await _load((req.data || {}).projectId);
    const actor = _actor(req, p, false);
    if (actor !== 'provider') throw new HttpsError('permission-denied', 'Only the provider edits the proposal.');
    if (!W.scopeEditable(p.status)) throw new HttpsError('failed-precondition', 'The scope is locked once proposed. Use a change request.', { code: 'WORK_SCOPE_LOCKED' });
    const d = req.data || {};
    const scope = W.sanitizeScope(Object.assign({}, p.scope, d.scope || {}));
    const lines = d.scope && d.scope.lines !== undefined ? _lines(d.scope.lines) : (p.scope && p.scope.lines) || [];
    await ref.update({ scope: Object.assign(scope, { lines }), totalCents: _total(lines), updatedAt: _ts(),
      history: (p.history || []).concat([_ev('provider', req.auth.uid, 'scope_updated')]).slice(-100) });
    return { ok: true, totalCents: _total(lines) };
  },

  /** Lifecycle moves (work-engine.js MOVES). Proposing checks the scope; accepting LOCKS it; completing records the kind. */
  async workTransition(req) {
    const d = req.data || {};
    const { ref, p } = await _load(d.projectId);
    const actor = _actor(req, p, true);
    const to = String(d.to || '');
    try { W.assertMove(p.status, to, actor); } catch (e) { _wrap(e); }
    const patch = { status: to, updatedAt: _ts() };
    if (to === 'proposed') {
      const sc = p.scope || {};
      const lines = sc.lines || [], ms = sc.milestones || [];
      if (!sc.title || !lines.length) throw new HttpsError('failed-precondition', 'Add a title and at least one scope line before proposing.', { code: 'WORK_SCOPE_EMPTY' });
      if (ms.length && W.budgetOf(ms) !== _total(lines)) throw new HttpsError('failed-precondition', 'Milestones must add up to the scope total.', { code: 'WORK_MILESTONES_MISMATCH' });
      if (p.origin && p.origin.type === 'service_lead' && _total(lines) !== p.origin.acceptedQuote.amountCents) {
        throw new HttpsError('failed-precondition', 'The scope total must equal the quote the customer accepted. Changes after acceptance go through a change request.', { code: 'WORK_TOTAL_NOT_QUOTE' });
      }
    }
    if (to === 'accepted') patch.acceptedScope = { totalCents: p.totalCents || 0, lineIds: ((p.scope || {}).lines || []).map((l) => l.lineId), atMs: Date.now() };
    if (to === 'completed') {
      const kind = COMPLETION_KINDS.indexOf(d.completionKind) >= 0 ? d.completionKind : 'delivered';
      patch.completion = { kind, acceptedBy: req.auth.uid, atMs: Date.now() };
    }
    if (to === 'cancelled') patch.cancelReason = _s(d.reason, 500) || null;
    patch.history = (p.history || []).concat([_ev(actor, req.auth.uid, 'moved', { from: p.status, to })]).slice(-100);
    await db().runTransaction(async (t) => {
      const cur = await t.get(ref);
      if ((cur.data() || {}).status !== p.status) throw new HttpsError('aborted', 'The project changed. Reload and try again.', { code: 'WORK_STALE' });
      t.update(ref, patch);
    });
    return { ok: true, status: to };
  },

  /** Provider proposes a change after acceptance (a "variation"). Only the CUSTOMER can approve it. */
  async workProposeChange(req) {
    const d = req.data || {};
    const { ref, p } = await _load(d.projectId);
    const actor = _actor(req, p, false);
    if (actor !== 'provider') throw new HttpsError('permission-denied', 'Only the provider proposes a change.');
    if (['accepted', 'active', 'paused'].indexOf(p.status) < 0) throw new HttpsError('failed-precondition', 'Changes are proposed after the customer accepts the scope.', { code: 'WORK_CR_STATE' });
    const crs = p.changeRequests || [];
    if (crs.filter((c) => c.status === 'proposed').length >= 3) throw new HttpsError('resource-exhausted', 'Resolve the open change requests first.', { code: 'WORK_CR_OPEN' });
    const crId = 'cr' + (crs.length + 1);
    const addLines = _lines(d.addLines, crId + '-l');
    const live = ((p.scope || {}).lines || []).map((l) => l.lineId);
    const removeLineIds = (Array.isArray(d.removeLineIds) ? d.removeLineIds : []).map((x) => _s(x, 40)).filter((x) => live.indexOf(x) >= 0).slice(0, 50);
    const removed = ((p.scope || {}).lines || []).filter((l) => removeLineIds.indexOf(l.lineId) >= 0);
    const deltaCents = _total(addLines) - _total(removed);
    if (!addLines.length && !removeLineIds.length) throw new HttpsError('invalid-argument', 'A change request adds or removes scope lines.', { code: 'WORK_CR_EMPTY' });
    const reason = _s(d.reason, 500);
    if (reason.length < 5) throw new HttpsError('invalid-argument', 'Explain the change (at least 5 characters).', { code: 'WORK_CR_REASON' });
    let milestone = null;
    if (deltaCents > 0) {
      const t = _s(d.milestoneTitle, 160) || 'Change ' + crId;
      milestone = { id: 'm-' + crId, title: t, dueDate: null, deliverables: [], amountCents: deltaCents, status: 'planned' };
    }
    const cr = { crId, addLines, removeLineIds, deltaCents, milestone, reason, status: 'proposed', proposedBy: req.auth.uid, atMs: Date.now() };
    await ref.update({ changeRequests: crs.concat([cr]), updatedAt: _ts(), history: (p.history || []).concat([_ev('provider', req.auth.uid, 'change_proposed', { crId, deltaCents })]).slice(-100) });
    return { ok: true, crId, deltaCents };
  },

  /** Customer approves / declines a change. Approval applies the lines and (for an increase) adds the delta milestone, so
   *  milestones still partition the new total. A decrease is recorded; refunds of paid milestones are WE2 / disputes. */
  async workDecideChange(req) {
    const d = req.data || {};
    const { ref, p } = await _load(d.projectId);
    const actor = _actor(req, p, false);
    if (actor !== 'customer') throw new HttpsError('permission-denied', 'Only the customer decides a change request.', { code: 'WORK_CR_CUSTOMER_ONLY' });
    const decision = d.decision === 'approve' ? 'approved' : d.decision === 'decline' ? 'declined' : null;
    if (!decision) throw new HttpsError('invalid-argument', 'decision must be approve or decline.');
    await db().runTransaction(async (t) => {
      const cur = (await t.get(ref)).data() || {};
      const crs = (cur.changeRequests || []).slice();
      const i = crs.findIndex((c) => c.crId === _s(d.crId, 40));
      if (i < 0) throw new HttpsError('not-found', 'Change request not found.');
      if (crs[i].status !== 'proposed') throw new HttpsError('failed-precondition', 'This change request was already decided.', { code: 'WORK_CR_DECIDED' });
      crs[i] = Object.assign({}, crs[i], { status: decision, decidedBy: req.auth.uid, decidedAtMs: Date.now() });
      const patch = { changeRequests: crs, updatedAt: _ts(), history: (cur.history || []).concat([_ev('customer', req.auth.uid, 'change_' + decision, { crId: crs[i].crId })]).slice(-100) };
      if (decision === 'approved') {
        const sc = Object.assign({}, cur.scope);
        const lines = (sc.lines || []).filter((l) => crs[i].removeLineIds.indexOf(l.lineId) < 0).concat(crs[i].addLines);
        sc.lines = lines;
        if (crs[i].milestone) sc.milestones = (sc.milestones || []).concat([crs[i].milestone]);
        patch.scope = sc; patch.totalCents = _total(lines);
      }
      t.update(ref, patch);
    });
    return { ok: true, status: decision };
  },

  /** Evidence on a milestone (before / during / after). A ref is an https URL or a storage path UNDER this project. */
  async workAddEvidence(req) {
    const d = req.data || {};
    const { ref, p } = await _load(d.projectId);
    const actor = _actor(req, p, false);
    if (W.TERMINAL.indexOf(p.status) >= 0) throw new HttpsError('failed-precondition', 'This project is closed.', { code: 'WORK_TERMINAL' });
    const mId = _s(d.milestoneId, 40);
    if (mId && !(((p.scope || {}).milestones) || []).some((m) => m.id === mId)) throw new HttpsError('not-found', 'Milestone not found.');
    const type = EVIDENCE_TYPES.indexOf(d.type) >= 0 ? d.type : null;
    if (!type) throw new HttpsError('invalid-argument', 'type must be photo, inspection, note or checklist.');
    const raw = _s(d.ref, 400);
    const okRef = !raw || /^https:\/\/[^\s]+$/i.test(raw) || raw.indexOf('workProjects/' + ref.id + '/') === 0;
    if (!okRef) throw new HttpsError('invalid-argument', 'Evidence must be an https link or a file stored under this project.', { code: 'WORK_EVIDENCE_REF' });
    const note = _s(d.note, 1000);
    if (!raw && !note) throw new HttpsError('invalid-argument', 'Add a file or a note.');
    const ev = (p.evidence || []);
    if (ev.length >= 500) throw new HttpsError('resource-exhausted', 'Evidence limit reached for this project.');
    const item = { milestoneId: mId || null, type, ref: raw || null, note: note || null, by: req.auth.uid, actor, atMs: Date.now() };
    await ref.update({ evidence: ev.concat([item]), updatedAt: _ts() });
    return { ok: true };
  },

  async workGet(req) {
    const d = req.data || {};
    const { ref, p } = await _load(d.projectId);
    _actor(req, p, true);
    return { ok: true, project: _view(ref.id, p) };
  },

  /** My projects as provider or customer (parties array-contains). */
  async workListMine(req) {
    const uid = _uid(req);
    const snap = await db().collection('workProjects').where('parties', 'array-contains', uid).limit(100).get();
    const items = snap.docs.map((x) => { const p = x.data() || {}; return { id: x.id, skin: p.skin, kind: p.kind, status: p.status, title: (p.scope || {}).title || '', totalCents: p.totalCents || 0,
      role: p.providerUid === uid ? 'provider' : 'customer', openChanges: (p.changeRequests || []).filter((c) => c.status === 'proposed').length }; });
    return { ok: true, items };
  },

  /** AdminOS: projects by skin / status (read-only). */
  async workAdminList(req) {
    if (!_isAdmin(req)) throw new HttpsError('permission-denied', 'Administrator access required.');
    const d = req.data || {};
    const skin = W.SKINS[d.skin] ? d.skin : null;
    let q = db().collection('workProjects');
    if (skin) q = q.where('skin', '==', skin);
    const snap = await q.limit(300).get();
    let items = snap.docs.map((x) => _view(x.id, x.data() || {}));
    if (W.STATES.indexOf(d.status) >= 0) items = items.filter((i) => i.status === d.status);
    return { ok: true, items };
  },
};

exports._h = _h;
exports._internal = { _lines, _total, _commercial };
exports.workDispatch = onCall(_OPTS, async (req) => {
  const op = req.data && req.data.op;
  const valid = Object.keys(_h).join(', ');
  if (!op || typeof op !== 'string') throw new HttpsError('invalid-argument', '"op" is required. Valid: ' + valid);
  const handler = Object.prototype.hasOwnProperty.call(_h, op) ? _h[op] : null;
  if (typeof handler !== 'function') throw new HttpsError('not-found', 'Unknown op "' + op + '". Valid: ' + valid);
  return handler(req);
});
