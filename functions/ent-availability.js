/* SOKONI — Entertainment Availability Authority  functions/ent-availability.js
 * ============================================================================================
 * ONE availability authority for every bookable Entertainment provider — artists, entertainment
 * services, venues (and every other provider on the service-appointment engine). There are no
 * per-category calendars: a calendar is a KEY, and category only changes its configuration.
 *
 *   svc_<providerUid>   the service-appointment engine (providerBookings, booking-service.js)
 *   ven_<venueId>       the venue engine (bookings, booking.js)
 *
 * WHAT IT OWNS
 *   · occupancy — entAvailability/{calKey}/months/{YYYY-MM}  (server-only; never read by a client)
 *   · the realtime signal — entAvailabilityPublic/{calKey} and /{calKey}_{YYYY-MM}: a counter and
 *     nothing else, so a storefront can listen (bounded: one calendar doc + one month doc) and
 *     re-ask the server when it moves. No slot, reason, booking or buyer is in a public doc.
 *   · the audit — entAvailabilityAudit (every configuration change, block, open, intervention)
 *
 * WHAT IT DOES NOT OWN
 *   the booking (booking-service.js / booking.js), the payment (payment-purposes → webhook), the
 *   PIN (entertainment-bookings.js), the refund (financial-os), the wallet. A reservation is made
 *   INSIDE the owning engine's transaction through claim(); a slot opens again only through
 *   release(), which the engines call in the SAME transaction that moves the booking to its
 *   canonical terminal state. Nothing here reopens a slot because a refund was REQUESTED.
 *
 * TRANSACTION CONTRACT (Admin SDK: every read before any write)
 *   const plan = await planReservation({...});         outside — config, bookability, validation
 *   await db.runTransaction(async (txn) => {
 *     ...engine reads...
 *     const st = await readPlan(txn, plan);              read the month docs
 *     const r = claim(txn, plan, st, { kind });          decide + stage writes (no more reads)
 *   });
 * Every booking that holds a slot carries `availability: { calKey, itemId, months }` so a later
 * transition can find its item without a query (planFromRecord).
 *
 * Decisions live in functions/shared/ent-availability-core.js (pure). Design:
 * docs/ENTERTAINMENT_AVAILABILITY.md.
 */
'use strict';
const admin = require('firebase-admin');
const { HttpsError } = require('firebase-functions/v2/https');
const CORE = require('./shared/ent-availability-core');

const COL = Object.freeze({
  CAL: 'entAvailability', MONTHS: 'months', PUB: 'entAvailabilityPublic', AUDIT: 'entAvailabilityAudit',
  POLICY: 'platformConfig', POLICY_DOC: 'entAvailabilityPolicy',
});
const KEY_RE = /^(svc|ven)_[A-Za-z0-9_-]{1,128}$/;
const MAX_ITEMS_PER_MONTH = 3000;
const MAX_RESERVATION_MS = 8 * CORE.DAY_MS;
/* Payment states that are NOT a final answer: while a payment for a booking sits in one of
   these, the slot is protected — never reopened by a timer (the webhook's terminal answer, or an
   authorised reconciliation, is what releases it). */
const PAYMENT_FINAL = new Set(['COMPLETE', 'COMPLETED', 'PAID', 'SUCCESS', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED',
  'EXPIRED', 'REJECTED', 'REVERSED', 'REFUNDED', 'TIMEOUT', 'CHARGEBACK']);

/* Fallback policy. The live policy is platformConfig/entAvailabilityPolicy (AdminOS, super admin);
   these values apply only while that document does not exist. They are limits and gates, not a
   provider's configuration — the provider sets their own hours, durations, buffers and horizon. */
const DEFAULT_POLICY = Object.freeze({
  categories: {
    ARTIST: { requiresVerification: true, maxHorizonDays: 730, baseMaxHorizonDays: 365 },
    SERVICE: { requiresVerification: true, maxHorizonDays: 730, baseMaxHorizonDays: 365 },
    VENUE: { requiresVerification: true, maxHorizonDays: 730, baseMaxHorizonDays: 365 },
    PROVIDER: { requiresVerification: false, maxHorizonDays: 365, baseMaxHorizonDays: 365 },
  },
  advancedFeature: 'advanced_availability',
  advancedTiers: ['premium', 'equipped', 'pro', 'business', 'enterprise', 'elite'],
});

const _db = () => admin.firestore();
const _FV = () => admin.firestore.FieldValue;
let _now = () => Date.now();
const fail = (code, msg, details) => { throw new HttpsError(code, msg, details); };
const _san = (s, n) => String(s == null ? '' : s).replace(/[<>]/g, '').trim().slice(0, n || 200);
const _uidOf = (req) => (req && req.auth && req.auth.uid) || null;
const _need = (req) => { const u = _uidOf(req); if (!u) fail('unauthenticated', 'Sign in required.'); return u; };
const _claims = (req) => (req && req.auth && req.auth.token) || {};
const _isAdmin = (req) => { const t = _claims(req); return t.admin === true || t.superAdmin === true || t.role === 'admin' || t.role === 'superAdmin'; };
const _isSuper = (req) => { const t = _claims(req); return t.superAdmin === true || t.role === 'superAdmin'; };

/* ── policy ───────────────────────────────────────────────────────────────────────────── */
let _policyCache = null; let _policyAt = 0;
async function policy() {
  if (_policyCache && _now() - _policyAt < 60000) return _policyCache;
  let live = null;
  try { const s = await _db().collection(COL.POLICY).doc(COL.POLICY_DOC).get(); live = s.exists ? s.data() : null; } catch (_) { live = null; }
  const p = { categories: Object.assign({}, DEFAULT_POLICY.categories), advancedFeature: DEFAULT_POLICY.advancedFeature, advancedTiers: DEFAULT_POLICY.advancedTiers.slice() };
  if (live && live.categories && typeof live.categories === 'object') {
    for (const k of Object.keys(p.categories)) if (live.categories[k]) p.categories[k] = Object.assign({}, p.categories[k], live.categories[k]);
  }
  if (live && Array.isArray(live.advancedTiers)) p.advancedTiers = live.advancedTiers.map(String);
  if (live && typeof live.advancedFeature === 'string') p.advancedFeature = live.advancedFeature;
  _policyCache = p; _policyAt = _now();
  return p;
}
function _catPolicy(pol, category) { return pol.categories[category] || pol.categories.PROVIDER; }

/* Premium / Equipped entitlement, from the canonical subscription resolver — never the client. */
async function isAdvanced(ownerUid) {
  if (!ownerUid) return false;
  const pol = await policy();
  try {
    const sub = require('./subscription-core');
    const s = await sub.resolveSubscription(ownerUid, { role: 'provider' });
    if (!s || !s.found || !sub.isActive(s.status)) return false;
    if (s.features && s.features[pol.advancedFeature]) return true;
    return pol.advancedTiers.includes(String(s.tier || '').toLowerCase());
  } catch (_) { return false; }
}

/* ── calendar resolution (adapters: stored config → one normalized config) ────────────── */
function calKeyFor(o) {
  if (o && o.calKey && KEY_RE.test(o.calKey)) return o.calKey;
  if (o && o.venueId) { const k = 'ven_' + String(o.venueId); if (KEY_RE.test(k)) return k; }
  if (o && o.providerId) { const k = 'svc_' + String(o.providerId); if (KEY_RE.test(k)) return k; }
  return null;
}
function _parseKey(calKey) { const i = calKey.indexOf('_'); return { kind: calKey.slice(0, i) === 'ven' ? 'venue' : 'provider', id: calKey.slice(i + 1) }; }

/* providerAvailability/{uid} (the canonical provider config, availability.normalizeAvailabilityConfig) */
function _fromProviderConfig(pa, extraClosed) {
  const a = pa || {}; const appt = a.appt || {};
  const weekly = []; const breaks = [];
  for (let i = 0; i < 7; i++) {
    const day = a.schedule && a.schedule[CORE.DOW_LONG[i]];
    weekly.push(day && !day.closed ? (day.periods || []) : []);
    breaks.push(day && !day.closed ? (day.breaks || []) : []);
  }
  const travel = Number(appt.travelMins) || 0; const buf = Number(appt.bufferMins) || 0;
  const closed = Object.assign({}, a.closedDates || {});
  (extraClosed || []).forEach((d) => { closed[d] = true; });
  return CORE.normalizeConfig({
    open247: Array.isArray(a.modes) && a.modes.includes('open_24_7'),
    weekly, breaks, closedDates: closed,
    vacation: a.isOnVacation === true ? { from: a.vacationStartDate || CORE.dateOf(_now()), to: a.vacationEndDate || null } : null,
    durationMins: appt.durationMins, stepMins: appt.slotStepMins,
    bufferBeforeMins: appt.bufferBeforeMins != null ? appt.bufferBeforeMins : buf + travel,
    bufferAfterMins: appt.bufferAfterMins != null ? appt.bufferAfterMins : buf + travel,
    minNoticeMins: appt.minNoticeHours != null ? Number(appt.minNoticeHours) * 60 : 60,
    horizonDays: appt.maxDaysAhead != null ? appt.maxDaysAhead : 30,
    capacity: a.cap && a.cap.maxSimultaneous, maxPerDay: a.cap && a.cap.maxPerDay,
    allowSameDay: appt.allowSameDay !== false,
    reopenAfterCancel: a.reopenAfterCancel !== false, cooldownMins: a.cooldownMins,
  });
}
/* venues/{id} (the venue engine's own record) */
function _fromVenue(v) {
  const x = v || {}; const oh = x.openingHours || {};
  const weekly = [];
  for (let i = 0; i < 7; i++) { const h = oh[CORE.DOW[i]]; weekly.push(h && !h.closed && h.open && h.close ? [{ open: h.open, close: h.close }] : []); }
  const cfg = x.config || {};
  return CORE.normalizeConfig({
    weekly, closedDates: x.closedDates || {},
    durationMins: x.slotDurationMins || cfg.slotDuration || 60, stepMins: x.slotStepMins || null,
    bufferBeforeMins: x.bufferBeforeMins || 0,
    bufferAfterMins: (Number(x.bufferAfterMins) || 0) + (Number(cfg.cleaningBuffer) || 0),
    minNoticeMins: x.minNoticeHours != null ? Number(x.minNoticeHours) * 60 : 60,
    horizonDays: x.bookingHorizonDays != null ? x.bookingHorizonDays : 365,
    capacity: x.capacity && x.capacity.concurrent, maxPerDay: x.maxBookingsPerDay,
    allowSameDay: x.allowSameDay !== false,
    reopenAfterCancel: x.reopenAfterCancel !== false, cooldownMins: x.cooldownMins,
  });
}

/* Premium / Equipped settings are honoured only for an entitled owner — enforced where the calendar
   is USED, so it holds however the configuration was written (a callable, or the owner's own
   direct write to providerAvailability that merchant pages still make). Without the plan:
   one booking at a time, the base horizon, and one buffer (the larger of the two — never less
   protection than the provider asked for). */
function _enforcePlan(cfg, cp, advanced) {
  cfg.horizonDays = Math.min(cfg.horizonDays, advanced ? cp.maxHorizonDays : Math.min(cp.maxHorizonDays, cp.baseMaxHorizonDays));
  if (!advanced) {
    cfg.capacity = 1;
    const b = Math.max(cfg.bufferBeforeMins, cfg.bufferAfterMins);
    cfg.bufferBeforeMins = b; cfg.bufferAfterMins = b;
  }
  return cfg;
}

/**
 * Load a calendar: its owner, category, normalized configuration and whether it may take public
 * bookings now. `bookable.code` is PRIVATE (the provider's dashboard and AdminOS may show it; the
 * public API never does).
 */
async function loadCalendar(keyOrOpts) {
  const calKey = typeof keyOrOpts === 'string' ? keyOrOpts : calKeyFor(keyOrOpts);
  if (!calKey || !KEY_RE.test(calKey)) fail('invalid-argument', 'Unknown calendar.');
  const { kind, id } = _parseKey(calKey);
  const pol = await policy();
  if (kind === 'venue') {
    const vs = await _db().collection('venues').doc(id).get();
    if (!vs.exists) fail('not-found', 'Not found.');
    const v = vs.data() || {};
    const cfg = _fromVenue(v);
    const cp = _catPolicy(pol, 'VENUE');
    const advanced = await isAdvanced(v.ownerId);
    _enforcePlan(cfg, cp, advanced);
    let code = null;
    if (v.status !== 'active') code = v.status === 'suspended' ? 'SUSPENDED' : 'NOT_APPROVED';
    else if (v.acceptsBookings === false) code = 'NOT_ACCEPTING';
    return { calKey, kind, id, ownerUid: v.ownerId || null, category: 'VENUE', name: v.name || null, cfg, raw: v, advanced,
      bookable: { ok: !code, code } };
  }
  const [pa, ps] = await Promise.all([
    _db().collection('providerAvailability').doc(id).get(),
    _db().collection('providers').doc(id).get(),
  ]);
  let overrides = [];
  try {
    const os = await _db().collection('providerAvailability').doc(id).collection('overrides').where('closed', '==', true).limit(400).get();
    overrides = os.docs.map((d) => (d.data() && d.data().date) || d.id).filter(CORE.isDate);
  } catch (_) { overrides = []; }
  const p = ps.exists ? ps.data() : null;
  const cls = await require('./provider-hub').resolveProviderClassification(_db(), id);
  const idCls = require('./shared/ent-booking-identity');
  /* An account that PRESENTS as entertainment (its self-editable profile says so) but has no
     decided entertainment application is an UNVERIFIED entertainment provider. */
  const claimsEnt = p ? !!idCls.classifyApplication({ category: p.category, subcategory: p.subcategory, hub: p.hubType }) : false;
  const category = cls.entClass || (claimsEnt ? 'ARTIST' : 'PROVIDER');
  /* An approved provider that has not set hours is bookable under the platform default (the SAME
     pure default the booking gate applies — availability.withDefaults). */
  const cfg = _fromProviderConfig(require('./availability').withDefaults(pa.exists ? pa.data() : null), overrides);
  const cp = _catPolicy(pol, category);
  const advanced = await isAdvanced(id);
  _enforcePlan(cfg, cp, advanced);
  let code = null;
  if (!p || !['active', 'approved'].includes(p.status)) code = p && p.status === 'suspended' ? 'SUSPENDED' : 'NOT_APPROVED';
  else if (p.suspended === true) code = 'SUSPENDED';
  else if (p.acceptsBookings === false) code = 'NOT_ACCEPTING';
  else if (cp.requiresVerification && category !== 'PROVIDER' && !cls.entClass) code = 'NOT_VERIFIED';
  return { calKey, kind, id, ownerUid: id, category, entClass: cls.entClass || null, name: (p && (p.businessName || p.name)) || null,
    cfg, raw: pa.exists ? pa.data() : null, advanced, bookable: { ok: !code, code } };
}

/* The service a view / reservation is for (service engine only). */
async function loadService(cal, serviceId) {
  if (!serviceId || cal.kind !== 'provider') return null;
  const s = await _db().collection('providerServices').doc(String(serviceId)).get();
  if (!s.exists) fail('not-found', 'Service not found.');
  const svc = Object.assign({ id: s.id }, s.data());
  if (svc.providerId !== cal.id) fail('failed-precondition', 'Service does not belong to this provider.');
  if (svc.active === false || svc.removedAt) fail('failed-precondition', 'This service is not available.');
  /* per-service availability is a Premium setting — ignored (not an error) without the plan */
  if (!cal.advanced && svc.availability) svc.availability = null;
  return svc;
}

/* ── storage ──────────────────────────────────────────────────────────────────────────── */
function monthRef(calKey, month) { return _db().collection(COL.CAL).doc(calKey).collection(COL.MONTHS).doc(month); }
function pubRef(calKey, month) { return _db().collection(COL.PUB).doc(month ? `${calKey}_${month}` : calKey); }
/* Months an item must be stored in: every month its BUFFERED interval touches, so any candidate
   whose buffered interval touches it reads at least one doc that holds it. */
function monthsFor(s, e, bb, ba) {
  const set = new Set();
  for (const d of CORE.datesTouched(s - (bb || 0), e + (ba || 0))) set.add(CORE.monthOf(d));
  return [...set].sort();
}

/**
 * Plan a reservation (outside any transaction). Throws for anything that does not depend on the
 * occupancy (not bookable, invalid window, beyond the horizon); the occupancy itself is decided
 * in claim() inside the caller's transaction.
 */
async function planReservation(o) {
  const cal = o.cal || await loadCalendar(o);
  if (!o.skipBookable && !cal.bookable.ok) fail('failed-precondition', 'This provider is not taking bookings right now.', { code: 'NOT_BOOKABLE' });
  const svc = o.service !== undefined ? o.service : await loadService(cal, o.serviceId);
  const cfg = CORE.forService(cal.cfg, svc);
  const s = Number(o.startMs); const e = Number(o.endMs);
  if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s || e - s > MAX_RESERVATION_MS) fail('invalid-argument', 'Invalid time.');
  const c = CORE.candidate(cfg, s, e);
  const itemId = String(o.itemId || '');
  if (!/^[A-Za-z0-9_-]{3,160}$/.test(itemId)) fail('invalid-argument', 'Invalid reservation id.');
  return { calKey: cal.calKey, cal, cfg, svc, cand: c, itemId, ref: o.ref || null,
    months: monthsFor(c.s, c.e, c.bb, c.ba), serviceId: svc ? svc.id : (o.serviceId || null), excludeId: o.excludeId || null };
}
/* A booking's existing item, from the record it carries. No I/O. */
function planFromRecord(av) {
  if (!av || !KEY_RE.test(String(av.calKey || '')) || !av.itemId || !Array.isArray(av.months) || !av.months.length) return null;
  return { calKey: av.calKey, itemId: String(av.itemId), months: av.months.map(String).slice(0, 4) };
}
/** Read the month docs a plan (or several) needs. Call BEFORE any write in the transaction. */
async function readPlan(txn, ...plans) {
  const st = { docs: {} };
  for (const p of plans) {
    if (!p) continue;
    for (const m of p.months) {
      const k = `${p.calKey}|${m}`;
      if (st.docs[k]) continue;
      const ref = monthRef(p.calKey, m);
      const snap = await txn.get(ref);
      st.docs[k] = { ref, calKey: p.calKey, month: m, items: snap.exists ? (snap.data().items || []).slice() : [], rev: snap.exists ? Number(snap.data().rev) || 0 : 0, dirty: false };
    }
  }
  return st;
}
function _itemsFor(st, p) {
  const out = []; const seen = new Set();
  for (const m of p.months) for (const it of (st.docs[`${p.calKey}|${m}`] || { items: [] }).items) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
  return out;
}
function _stage(txn, st, extra) {
  const FV = _FV(); const touched = new Set();
  for (const d of Object.values(st.docs)) {
    if (!d.dirty) continue;
    if (d.items.length > MAX_ITEMS_PER_MONTH) fail('resource-exhausted', 'This calendar month is full.');
    txn.set(d.ref, { calKey: d.calKey, month: d.month, items: d.items, rev: d.rev + 1, updatedAt: FV.serverTimestamp() });
    txn.set(pubRef(d.calKey, d.month), { calKey: d.calKey, month: d.month, rev: FV.increment(1), updatedAt: FV.serverTimestamp() }, { merge: true });
    touched.add(d.calKey);
  }
  for (const k of touched) {
    txn.set(_db().collection(COL.CAL).doc(k), Object.assign({ calKey: k, updatedAt: FV.serverTimestamp() }, (extra && extra[k]) || {}), { merge: true });
  }
}

/**
 * Claim the plan's slot inside the caller's transaction (after readPlan). Returns
 *   { ok:true, record }   — record goes on the booking as `availability`
 *   { ok:false, code, message } — nothing staged; the caller refuses the booking.
 */
function claim(txn, plan, st, opts) {
  const o = opts || {};
  const kind = o.kind === CORE.KIND.BOOKING ? CORE.KIND.BOOKING : o.kind === CORE.KIND.BLOCK ? CORE.KIND.BLOCK : CORE.KIND.HOLD;
  const items = _itemsFor(st, plan);
  if (items.some((it) => it.id === plan.itemId && it.k !== CORE.KIND.COOLDOWN) && !plan.excludeId) {
    return { ok: true, record: { calKey: plan.calKey, itemId: plan.itemId, months: plan.months }, already: true };
  }
  if (kind !== CORE.KIND.BLOCK) {
    const r = CORE.evaluate(plan.cfg, items, plan.cand, _now(), { excludeId: plan.excludeId });
    if (!r.ok) return { ok: false, code: r.code, message: CORE.refusalMessage(r.code) };
  } else {
    /* A block may not be laid over a live booking or hold — that booking must be cancelled
       through its own authority first (which then opens the time). */
    const hit = items.find((it) => (it.k === CORE.KIND.BOOKING || it.k === CORE.KIND.HOLD) && it.s < plan.cand.e && it.e > plan.cand.s);
    if (hit) return { ok: false, code: CORE.REFUSAL.ALREADY_BOOKED, message: 'That time already has a booking. Cancel or move the booking first.' };
  }
  const item = CORE.makeItem(plan.cfg, { id: plan.itemId, kind, startMs: plan.cand.s, endMs: plan.cand.e, serviceId: plan.serviceId,
    ref: plan.ref, label: o.label, until: o.until });
  for (const m of plan.months) {
    const d = st.docs[`${plan.calKey}|${m}`];
    d.items = d.items.filter((it) => it.id !== plan.itemId);
    d.items.push(item); d.dirty = true;
  }
  _stage(txn, st, { [plan.calKey]: { kind: plan.cal ? plan.cal.kind : null, ownerUid: plan.cal ? plan.cal.ownerUid : null, category: plan.cal ? plan.cal.category : null } });
  return { ok: true, record: { calKey: plan.calKey, itemId: plan.itemId, months: plan.months } };
}

/** Change an item's kind (HOLD → BOOKING when the payment is authoritatively confirmed). */
function setKind(txn, rec, st, kind) {
  let hit = false;
  for (const m of rec.months) {
    const d = st.docs[`${rec.calKey}|${m}`]; if (!d) continue;
    d.items = d.items.map((it) => { if (it.id !== rec.itemId) return it; hit = true; const n = Object.assign({}, it, { k: kind }); delete n.until; return n; });
    if (hit) d.dirty = true;
  }
  if (hit) _stage(txn, st);
  return hit;
}

/**
 * Release an item — ONLY from a caller that is moving the booking to its canonical terminal state
 * in the same transaction. With cooldown (the calendar's policy after a cancellation) the time
 * becomes UNAVAILABLE instead of AVAILABLE.
 */
function release(txn, rec, st, opts) {
  const o = opts || {}; let found = null;
  for (const m of rec.months) {
    const d = st.docs[`${rec.calKey}|${m}`]; if (!d) continue;
    const before = d.items.length;
    d.items = d.items.filter((it) => { if (it.id === rec.itemId) { found = it; return false; } return true; });
    if (d.items.length !== before) d.dirty = true;
  }
  if (found && o.cooldown) {
    const until = o.cooldownMins > 0 ? Math.min(found.e, found.s + o.cooldownMins * 60000) : found.e;
    const cd = { id: 'cd_' + rec.itemId, k: CORE.KIND.COOLDOWN, s: found.s, e: Math.max(found.s + 60000, until), u: 1 };
    for (const m of rec.months) { const d = st.docs[`${rec.calKey}|${m}`]; if (d) { d.items = d.items.filter((it) => it.id !== cd.id); d.items.push(cd); d.dirty = true; } }
  }
  if (found) _stage(txn, st);
  return !!found;
}

/**
 * Atomic move (reschedule): the new slot is claimed and the old one released in ONE transaction.
 * The new time is evaluated with the booking's own item excluded; if it is refused nothing moves.
 */
function move(txn, fromRec, toPlan, st, opts) {
  const kind = (_itemsFor(st, fromRec).find((it) => it.id === fromRec.itemId) || {}).k || (opts && opts.kind) || CORE.KIND.HOLD;
  const items = _itemsFor(st, toPlan);
  const r = CORE.evaluate(toPlan.cfg, items, toPlan.cand, _now(), { excludeId: fromRec.itemId });
  if (!r.ok) return { ok: false, code: r.code, message: CORE.refusalMessage(r.code) };
  for (const m of fromRec.months) { const d = st.docs[`${fromRec.calKey}|${m}`]; if (d) { d.items = d.items.filter((it) => it.id !== fromRec.itemId); d.dirty = true; } }
  const item = CORE.makeItem(toPlan.cfg, { id: toPlan.itemId, kind, startMs: toPlan.cand.s, endMs: toPlan.cand.e, serviceId: toPlan.serviceId, ref: toPlan.ref });
  for (const m of toPlan.months) { const d = st.docs[`${toPlan.calKey}|${m}`]; d.items = d.items.filter((it) => it.id !== toPlan.itemId); d.items.push(item); d.dirty = true; }
  _stage(txn, st);
  return { ok: true, record: { calKey: toPlan.calKey, itemId: toPlan.itemId, months: toPlan.months } };
}

/* A buyer-safe HttpsError for a refusal code. */
function refusalError(code) {
  const busy = code === CORE.REFUSAL.ALREADY_BOOKED || code === CORE.REFUSAL.TEMPORARILY_HELD || code === CORE.REFUSAL.DAY_FULL;
  return new HttpsError(busy ? 'already-exists' : 'failed-precondition', CORE.refusalMessage(code), { code: busy ? 'SLOT_UNAVAILABLE' : code });
}

/**
 * Is a payment for this resource still in flight? A slot whose payment may have succeeded is
 * NEVER reopened by a timer. Reads the server-minted intents for the resource and the payment
 * records their STK pushes created.
 */
async function paymentInFlight(resourceId) {
  if (!resourceId) return false;
  try {
    const is = await _db().collection('paymentIntents').where('resourceId', '==', String(resourceId)).limit(10).get();
    for (const d of is.docs) {
      const ref = d.id;
      const p = await _db().collection('payments').doc(ref).get();
      if (p.exists && !PAYMENT_FINAL.has(String(p.data().status || '').toUpperCase())) return true;
      const ist = String(d.data().status || '').toLowerCase();
      if (['processing', 'submitted', 'stk_sent', 'unknown', 'outcome_unknown'].includes(ist)) return true;
    }
  } catch (_) { return true; }   /* cannot tell → protect the slot */
  return false;
}

/* ── audit ────────────────────────────────────────────────────────────────────────────── */
async function _audit(entry) {
  try {
    await _db().collection(COL.AUDIT).add(Object.assign({ at: _now(), createdAt: _FV().serverTimestamp() }, entry));
  } catch (e) { console.error('[ent-availability] audit write failed', e.message); }
}

/* ── views ────────────────────────────────────────────────────────────────────────────── */
async function _monthItems(calKey, month) {
  const [y, m] = month.split('-').map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;
  const next = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`;
  const snaps = await Promise.all([prev, month, next].map((mm) => monthRef(calKey, mm).get()));
  const out = []; const seen = new Set();
  for (const s of snaps) if (s.exists) for (const it of s.data().items || []) if (!seen.has(it.id)) { seen.add(it.id); out.push(it); }
  return out;
}
function _monthOk(month, nowMs) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return false;
  const cur = CORE.monthOf(CORE.dateOf(nowMs));
  const [cy] = cur.split('-').map(Number); const [y] = month.split('-').map(Number);
  return month >= cur.slice(0, 4) + '-01' && y <= cy + 2;     /* current year … two years ahead */
}

const _h = {};

/**
 * PUBLIC month view — day states only. { calKey, month, bookable, horizonEnd, days: { date: STATE } }
 * `bookable:false` renders every day UNAVAILABLE and never says why.
 */
_h.entAvailMonth = async (req) => {
  const d = req.data || {};
  const cal = await loadCalendar(d);
  const month = String(d.month || CORE.monthOf(CORE.dateOf(_now())));
  if (!_monthOk(month, _now())) fail('invalid-argument', 'Choose a month in this year or the next.');
  const svc = await loadService(cal, d.serviceId);
  const cfg = CORE.forService(cal.cfg, svc);
  const now = _now();
  const days = {};
  const dates = CORE.monthDays(month);
  const horizonEnd = CORE.dateOf(CORE.horizonEndMs(cfg, now) - 1);
  if (!cal.bookable.ok) {
    for (const dt of dates) days[dt] = CORE.PUBLIC_STATE.UNAVAILABLE;
    return { calKey: cal.calKey, month, bookable: false, horizonEnd, days };
  }
  const allBeyond = CORE.dayStartMs(dates[0]) >= CORE.horizonEndMs(cfg, now);
  const items = allBeyond ? [] : await _monthItems(cal.calKey, month);
  for (const dt of dates) {
    if (CORE.dayStartMs(dt) + CORE.DAY_MS <= now) { days[dt] = CORE.PUBLIC_STATE.UNAVAILABLE; continue; }
    if (CORE.dayStartMs(dt) >= CORE.horizonEndMs(cfg, now)) { days[dt] = CORE.PUBLIC_STATE.BOOKING_NOT_OPEN; continue; }
    days[dt] = CORE.dayState(cfg, dt, CORE.publicSlots(cfg, dt, items, now), now);
  }
  return { calKey: cal.calKey, month, bookable: true, horizonEnd, days };
};

/** PUBLIC day view — { date, bookable, durationMins, slots: [{ start, end, state }] } */
_h.entAvailDay = async (req) => {
  const d = req.data || {};
  const date = String(d.date || '');
  if (!CORE.isDate(date)) fail('invalid-argument', 'Choose a date.');
  const cal = await loadCalendar(d);
  const svc = await loadService(cal, d.serviceId);
  const cfg = CORE.forService(cal.cfg, svc);
  const now = _now();
  if (!cal.bookable.ok) return { calKey: cal.calKey, date, bookable: false, durationMins: cfg.durationMins, slots: [] };
  if (CORE.dayStartMs(date) >= CORE.horizonEndMs(cfg, now)) return { calKey: cal.calKey, date, bookable: true, state: CORE.PUBLIC_STATE.BOOKING_NOT_OPEN, durationMins: cfg.durationMins, slots: [] };
  const items = await _monthItems(cal.calKey, CORE.monthOf(date));
  const slots = CORE.publicSlots(cfg, date, items, now);
  return { calKey: cal.calKey, date, bookable: true, state: CORE.dayState(cfg, date, slots, now), durationMins: cfg.durationMins, slots };
};

/**
 * PUBLIC summary for cards and marketing: whether a provider is taking bookings and the next
 * open date. { results: { calKey: { state, next } } }  state ∈ BOOKINGS_OPEN · LIMITED ·
 * FULLY_BOOKED · NOT_BOOKABLE. Bounded: ≤ 24 calendars, 3 month docs each.
 */
async function summaryFor(keyOpts, serviceId) {
  const cal = await loadCalendar(keyOpts);
  if (!cal.bookable.ok) return { calKey: cal.calKey, state: 'NOT_BOOKABLE', next: null };
  const svc = serviceId ? await loadService(cal, serviceId).catch(() => null) : null;
  const cfg = CORE.forService(cal.cfg, svc);
  const now = _now(); const today = CORE.dateOf(now);
  const months = [CORE.monthOf(today), CORE.monthOf(CORE.addDays(today, 31)), CORE.monthOf(CORE.addDays(today, 62))];
  const items = []; const seen = new Set();
  for (const m of [...new Set(months)]) {
    const s = await monthRef(cal.calKey, m).get();
    if (s.exists) for (const it of s.data().items || []) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); }
  }
  let next = null; let limitedDays = 0; let openDays = 0; let consideredDays = 0;
  for (let i = 0; i < 60; i++) {
    const dt = CORE.addDays(today, i);
    if (CORE.dayStartMs(dt) >= CORE.horizonEndMs(cfg, now)) break;
    const st = CORE.dayState(cfg, dt, CORE.publicSlots(cfg, dt, items, now), now);
    if (st === CORE.PUBLIC_STATE.UNAVAILABLE && !CORE.slotStarts(cfg, dt).length) continue;
    consideredDays++;
    if (st === CORE.PUBLIC_STATE.AVAILABLE || st === CORE.PUBLIC_STATE.LIMITED) { openDays++; if (!next) next = dt; if (st === CORE.PUBLIC_STATE.LIMITED) limitedDays++; }
  }
  const state = !consideredDays ? 'NOT_BOOKABLE' : !openDays ? 'FULLY_BOOKED' : (openDays <= Math.max(2, Math.floor(consideredDays / 5)) || limitedDays >= openDays) ? 'LIMITED' : 'BOOKINGS_OPEN';
  return { calKey: cal.calKey, state, next };
}
_h.entAvailSummary = async (req) => {
  const d = req.data || {};
  const list = (Array.isArray(d.calendars) ? d.calendars : []).slice(0, 24);
  const results = {};
  for (const k of list) {
    const key = calKeyFor(k);
    if (!key) continue;
    try { results[key] = await summaryFor(key, k && k.serviceId); } catch (_) { results[key] = { calKey: key, state: 'NOT_BOOKABLE', next: null }; }
  }
  return { results };
};

/**
 * PUBLIC service list for a storefront (signed-in or not): active services of a bookable provider —
 * name, duration and the listed price only. Per-service availability, deposits, add-on pricing and
 * private rate cards stay on the server.
 */
_h.entServicesPublic = async (req) => {
  const d = req.data || {};
  const cal = await loadCalendar(d);
  if (cal.kind !== 'provider') return { services: [] };
  if (!cal.bookable.ok) return { bookable: false, services: [] };
  const s = await _db().collection('providerServices').where('providerId', '==', cal.id).limit(50).get();
  const services = s.docs.map((x) => Object.assign({ id: x.id }, x.data())).filter((v) => v.active !== false && !v.removedAt)
    .map((v) => ({ id: v.id, name: _san(v.name, 120), durationMins: Number(v.durationMins) || null,
      priceCents: v.priceType === 'quotation' ? null : (Number(v.price) || null), quote: v.priceType === 'quotation' }));
  return { bookable: true, services };
};

/* ── owner (provider / venue owner) ─────────────────────────────────────────────────────── */
async function _ownCalendar(req, d) {
  const uid = _need(req);
  const key = calKeyFor(d) || ('svc_' + uid);
  const cal = await loadCalendar(key);
  if (cal.ownerUid !== uid) fail('permission-denied', 'This calendar is not yours.');
  return { uid, cal };
}

/** The provider's own month: private states, their own items (bookings by reference, blocks with labels). */
_h.entAvailProviderMonth = async (req) => {
  const d = req.data || {};
  const { cal } = await _ownCalendar(req, d);
  const month = String(d.month || CORE.monthOf(CORE.dateOf(_now())));
  if (!_monthOk(month, _now())) fail('invalid-argument', 'Choose a month in this year or the next two.');
  const svc = await loadService(cal, d.serviceId);
  const cfg = CORE.forService(cal.cfg, svc);
  const items = await _monthItems(cal.calKey, month);
  const now = _now(); const days = {};
  for (const dt of CORE.monthDays(month)) {
    const slots = CORE.privateSlots(cfg, dt, items, now);
    const counts = {};
    slots.forEach((s) => { counts[s.state] = (counts[s.state] || 0) + 1; });
    days[dt] = { counts, beyondHorizon: CORE.dayStartMs(dt) >= CORE.horizonEndMs(cfg, now) };
  }
  const own = items.filter((it) => CORE.monthOf(CORE.dateOf(it.s)) === month || CORE.monthOf(CORE.dateOf(it.e - 1)) === month)
    .map((it) => ({ id: it.id, kind: it.k === 'B' ? 'BOOKED' : it.k === 'H' ? 'PENDING' : 'BLOCKED', start: it.s, end: it.e, ref: it.ref || null, label: it.label || null, serviceId: it.svc || null }));
  return { calKey: cal.calKey, month, bookable: cal.bookable, category: cal.category, horizonDays: cfg.horizonDays, days, items: own };
};
_h.entAvailProviderDay = async (req) => {
  const d = req.data || {};
  const { cal } = await _ownCalendar(req, d);
  const date = String(d.date || '');
  if (!CORE.isDate(date)) fail('invalid-argument', 'Choose a date.');
  const svc = await loadService(cal, d.serviceId);
  const cfg = CORE.forService(cal.cfg, svc);
  const items = await _monthItems(cal.calKey, CORE.monthOf(date));
  return { calKey: cal.calKey, date, slots: CORE.privateSlots(cfg, date, items, _now()) };
};

/** Block time (private commitment, travel, holiday …). The label is private to the owner. */
_h.entAvailBlock = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownCalendar(req, d);
  const date = String(d.date || ''); const endDate = CORE.isDate(d.endDate) ? d.endDate : date;
  if (!CORE.isDate(date)) fail('invalid-argument', 'Choose a date.');
  const sMin = d.start ? CORE.toMins(d.start) : 0; const eMin = d.end ? CORE.toMins(d.end) : 1440;
  const s = CORE.dayStartMs(date) + sMin * 60000; const e = CORE.dayStartMs(endDate) + eMin * 60000;
  if (!(e > s)) fail('invalid-argument', 'The end must be after the start.');
  if (s < _now() - CORE.DAY_MS) fail('invalid-argument', 'That time has passed.');
  const blockId = 'blk_' + require('crypto').randomBytes(8).toString('hex');
  const plan = await planReservation({ cal, service: null, startMs: s, endMs: e, itemId: blockId, skipBookable: true });
  let res;
  await _db().runTransaction(async (txn) => {
    const st = await readPlan(txn, plan);
    res = claim(txn, plan, st, { kind: CORE.KIND.BLOCK, label: _san(d.label, 120) || null });
  });
  if (!res.ok) fail('failed-precondition', res.message, { code: res.code });
  await _audit({ calKey: cal.calKey, actor: uid, role: 'owner', action: 'block', itemId: blockId, start: s, end: e });
  return { ok: true, blockId };
};
_h.entAvailUnblock = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownCalendar(req, d);
  const blockId = String(d.blockId || '');
  if (!/^blk_[a-f0-9]{16}$/.test(blockId) && !/^cd_[A-Za-z0-9_-]{3,160}$/.test(blockId)) fail('invalid-argument', 'Unknown block.');
  const month = CORE.isDate(d.date) ? CORE.monthOf(d.date) : null;
  if (!month) fail('invalid-argument', 'The block date is required.');
  const rec = { calKey: cal.calKey, itemId: blockId, months: [month] };
  /* The block may span into the next month; read the next one too. */
  const [y, m] = month.split('-').map(Number);
  rec.months.push(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}`);
  let ok = false;
  await _db().runTransaction(async (txn) => {
    const st = await readPlan(txn, rec);
    const items = _itemsFor(st, rec).filter((it) => it.id === blockId);
    if (!items.length || items.some((it) => it.k !== CORE.KIND.BLOCK && it.k !== CORE.KIND.COOLDOWN)) return;
    ok = release(txn, rec, st);
  });
  if (!ok) fail('not-found', 'That block was not found.');
  await _audit({ calKey: cal.calKey, actor: uid, role: 'owner', action: 'open', itemId: blockId });
  return { ok: true };
};

/* Configuration — the provider / venue owner. Advanced settings require the plan. */
const ADVANCED_FIELDS = ['capacity', 'perService', 'splitBuffers', 'extendedHorizon'];
function _advancedUsed(input, cfgPolicy) {
  const used = [];
  if (Number(input.capacity) > 1) used.push('capacity');
  if (input.bufferBeforeMins != null && input.bufferAfterMins != null && Number(input.bufferBeforeMins) !== Number(input.bufferAfterMins)) used.push('splitBuffers');
  if (Number(input.horizonDays) > cfgPolicy.baseMaxHorizonDays) used.push('extendedHorizon');
  return used;
}
_h.entAvailGetConfig = async (req) => {
  const d = req.data || {};
  const { cal } = await _ownCalendar(req, d);
  const advanced = await isAdvanced(cal.ownerUid);
  const pol = await policy();
  const cp = _catPolicy(pol, cal.category);
  return { calKey: cal.calKey, kind: cal.kind, category: cal.category, bookable: cal.bookable, advanced,
    limits: { maxHorizonDays: advanced ? cp.maxHorizonDays : Math.min(cp.maxHorizonDays, cp.baseMaxHorizonDays), advancedFields: ADVANCED_FIELDS },
    config: Object.assign({}, cal.cfg, { closedDates: Object.keys(cal.cfg.closedDates || {}).sort() }) };
};
_h.entAvailSetConfig = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownCalendar(req, d);
  const input = d.config || {};
  const pol = await policy();
  const cp = _catPolicy(pol, cal.category);
  const advanced = await isAdvanced(cal.ownerUid);
  const used = _advancedUsed(input, cp);
  if (used.length && !advanced) fail('permission-denied', 'These settings are part of the Premium plan: ' + used.join(', ') + '.', { code: 'PLAN_REQUIRED', fields: used });
  const horizon = Math.min(Number(input.horizonDays) || cal.cfg.horizonDays, cp.maxHorizonDays);
  const weekly = Array.isArray(input.weekly) ? input.weekly : null;
  const closed = Array.isArray(input.closedDates) ? input.closedDates.filter(CORE.isDate).slice(0, 400) : null;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));
  if (cal.kind === 'venue') {
    const patch = { updatedAt: Date.now() };
    if (weekly) {
      const oh = {};
      for (let i = 0; i < 7; i++) {
        const p = (weekly[i] || [])[0];
        oh[CORE.DOW[i]] = p && p.open && p.close ? { open: String(p.open).slice(0, 5), close: String(p.close).slice(0, 5), closed: false } : { closed: true };
      }
      patch.openingHours = oh;
    }
    if (input.durationMins != null) patch.slotDurationMins = clamp(input.durationMins, 15, 1440);
    if (input.stepMins != null) patch.slotStepMins = clamp(input.stepMins, 15, 1440);
    if (input.bufferBeforeMins != null) patch.bufferBeforeMins = clamp(input.bufferBeforeMins, 0, 720);
    if (input.bufferAfterMins != null) patch.bufferAfterMins = clamp(input.bufferAfterMins, 0, 720);
    if (input.minNoticeHours != null) patch.minNoticeHours = clamp(input.minNoticeHours, 0, 24 * 60);
    if (input.horizonDays != null) patch.bookingHorizonDays = clamp(horizon, 1, 730);
    if (input.capacity != null) patch['capacity.concurrent'] = clamp(input.capacity, 1, 100);
    if (input.maxPerDay != null) patch.maxBookingsPerDay = clamp(input.maxPerDay, 0, 9999);
    if (input.reopenAfterCancel != null) patch.reopenAfterCancel = input.reopenAfterCancel !== false;
    if (input.cooldownMins != null) patch.cooldownMins = clamp(input.cooldownMins, 0, 60 * 24 * 7);
    if (input.allowSameDay != null) patch.allowSameDay = input.allowSameDay !== false;
    if (closed) { const m = {}; closed.forEach((x) => { m[x] = true; }); patch.closedDates = m; }
    await _db().collection('venues').doc(cal.id).update(patch);
  } else {
    /* Providers: the ONE normalizer (availability.normalizeAvailabilityConfig) persists it. */
    const av = require('./availability');
    const cur = cal.raw || {};
    const schedule = Object.assign({}, cur.schedule || {});
    if (weekly) {
      for (let i = 0; i < 7; i++) {
        const periods = (weekly[i] || []).filter((p) => p && p.open && p.close).map((p) => ({ open: String(p.open).slice(0, 5), close: String(p.close).slice(0, 5) }));
        const prev = schedule[CORE.DOW_LONG[i]] || {};
        schedule[CORE.DOW_LONG[i]] = { closed: !periods.length, periods, breaks: prev.breaks || [] };
      }
    }
    const appt = Object.assign({}, cur.appt || {});
    if (input.durationMins != null) appt.durationMins = clamp(input.durationMins, 5, 1440);
    if (input.stepMins != null) appt.slotStepMins = clamp(input.stepMins, 15, 1440);
    if (input.bufferBeforeMins != null) appt.bufferBeforeMins = clamp(input.bufferBeforeMins, 0, 720);
    if (input.bufferAfterMins != null) appt.bufferAfterMins = clamp(input.bufferAfterMins, 0, 720);
    if (input.minNoticeHours != null) appt.minNoticeHours = clamp(input.minNoticeHours, 0, 72);
    if (input.horizonDays != null) appt.maxDaysAhead = clamp(horizon, 1, 730);
    if (input.allowSameDay != null) appt.allowSameDay = input.allowSameDay !== false;
    appt.enabled = true;
    const cap = Object.assign({}, cur.cap || {});
    if (input.capacity != null) cap.maxSimultaneous = clamp(input.capacity, 1, 100);
    if (input.maxPerDay != null) cap.maxPerDay = input.maxPerDay > 0 ? clamp(input.maxPerDay, 1, 9999) : null;
    const next = Object.assign({}, cur, { schedule, appt, cap, modes: (cur.modes && cur.modes.length) ? cur.modes : ['appointments'],
      vacation: { active: !!cur.isOnVacation, startDate: cur.vacationStartDate, endDate: cur.vacationEndDate, message: cur.vacationMessage } });
    const config = av.normalizeAvailabilityConfig(next, uid);
    if (closed) { const m = {}; closed.forEach((x) => { m[x] = true; }); config.closedDates = m; }
    if (input.reopenAfterCancel != null) config.reopenAfterCancel = input.reopenAfterCancel !== false;
    if (input.cooldownMins != null) config.cooldownMins = clamp(input.cooldownMins, 0, 60 * 24 * 7);
    delete config.createdAt;
    await _db().collection('providerAvailability').doc(uid).set(config, { merge: true });
    await _db().collection('availabilityStatus').doc(uid).set(av._buildStatusDoc ? av._buildStatusDoc(config) : { updatedAt: _FV().serverTimestamp() }, { merge: false }).catch(() => {});
  }
  await _db().collection(COL.PUB).doc(cal.calKey).set({ calKey: cal.calKey, rev: _FV().increment(1), updatedAt: _FV().serverTimestamp() }, { merge: true });
  await _audit({ calKey: cal.calKey, actor: uid, role: 'owner', action: 'config', fields: Object.keys(input).slice(0, 30) });
  return { ok: true, calKey: cal.calKey };
};

/** Per-service availability (Premium): duration, buffers, weekdays, notice, horizon for ONE service. */
_h.entAvailSetServiceAvailability = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownCalendar(req, d);
  if (cal.kind !== 'provider') fail('failed-precondition', 'Venues book the whole space.');
  if (!(await isAdvanced(uid))) fail('permission-denied', 'Per-service availability is part of the Premium plan.', { code: 'PLAN_REQUIRED', fields: ['perService'] });
  const svc = await loadService(cal, d.serviceId);
  if (!svc) fail('invalid-argument', 'Choose a service.');
  const a = d.availability || {};
  const clamp = (v, lo, hi) => (v == null ? null : Math.min(hi, Math.max(lo, Math.round(Number(v) || 0))));
  const out = {
    durationMins: clamp(a.durationMins, 15, 1440), bufferBeforeMins: clamp(a.bufferBeforeMins, 0, 720), bufferAfterMins: clamp(a.bufferAfterMins, 0, 720),
    minNoticeMins: clamp(a.minNoticeMins, 0, 86400), horizonDays: clamp(a.horizonDays, 1, 730),
    days: Array.isArray(a.days) ? a.days.map(Number).filter((x) => x >= 0 && x <= 6).slice(0, 7) : null,
  };
  Object.keys(out).forEach((k) => { if (out[k] == null) delete out[k]; });
  await _db().collection('providerServices').doc(svc.id).update({ availability: out, updatedAt: _FV().serverTimestamp() });
  await _db().collection(COL.PUB).doc(cal.calKey).set({ calKey: cal.calKey, rev: _FV().increment(1), updatedAt: _FV().serverTimestamp() }, { merge: true });
  await _audit({ calKey: cal.calKey, actor: uid, role: 'owner', action: 'service_availability', serviceId: svc.id });
  return { ok: true };
};

/** The provider's booking statistics. Unknown figures are null (rendered —), never 0. */
_h.entAvailStats = async (req) => {
  const d = req.data || {};
  const { uid, cal } = await _ownCalendar(req, d);
  const advanced = await isAdvanced(uid);
  const now = _now(); const today = CORE.dateOf(now);
  const months = [...new Set([CORE.monthOf(CORE.addDays(today, -30)), CORE.monthOf(today), CORE.monthOf(CORE.addDays(today, 30))])];
  const items = []; const seen = new Set();
  for (const m of months) { const s = await monthRef(cal.calKey, m).get(); if (s.exists) for (const it of s.data().items || []) if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } }
  const from = now - 30 * CORE.DAY_MS; const to = now + 30 * CORE.DAY_MS;
  const inWin = items.filter((it) => it.e > from && it.s < to);
  const bookings = inWin.filter((it) => it.k === CORE.KIND.BOOKING);
  const bookedMins = bookings.reduce((a, it) => a + (Math.min(it.e, to) - Math.max(it.s, from)) / 60000, 0);
  let availableMins = 0;
  for (let i = -30; i < 30; i++) {
    const dt = CORE.addDays(today, i);
    if (cal.cfg.closedDates[dt]) continue;
    for (const [o, c] of (cal.cfg.open247 ? [[0, 1440]] : (cal.cfg.weekly[CORE.dowOf(dt)] || []))) availableMins += c - o;
  }
  const out = {
    window: { from: CORE.dateOf(from), to: CORE.dateOf(to) },
    bookings: bookings.length, upcoming: bookings.filter((it) => it.s > now).length,
    pending: inWin.filter((it) => it.k === CORE.KIND.HOLD).length, blocks: inWin.filter((it) => it.k === CORE.KIND.BLOCK).length,
    cancellations: null, refunds: null, bookedHours: null, availableHours: null, utilization: null, repeatCustomers: null, advanced,
  };
  /* Cancellations / refunds from the booking authority (bounded). */
  try {
    const col = cal.kind === 'venue' ? 'bookings' : 'providerBookings';
    const fld = cal.kind === 'venue' ? 'venueId' : 'providerId';
    const snap = await _db().collection(col).where(fld, '==', cal.id).limit(500).get();
    const rows = snap.docs.map((x) => x.data());
    out.cancellations = rows.filter((b) => b.status === 'cancelled' || b.status === 'declined').length;
    out.refunds = rows.filter((b) => b.paymentStatus === 'refunded' || b.refundStatus === 'completed').length;
    if (advanced) {
      const per = {}; const cust = cal.kind === 'venue' ? 'customerId' : 'customerUid';
      rows.filter((b) => b.status !== 'cancelled' && b[cust]).forEach((b) => { per[b[cust]] = (per[b[cust]] || 0) + 1; });
      out.repeatCustomers = Object.values(per).filter((n) => n > 1).length;
    }
  } catch (_) { /* leave null — unknown, not zero */ }
  if (advanced) {
    out.bookedHours = Math.round(bookedMins / 6) / 10;
    out.availableHours = Math.round(availableMins / 6) / 10;
    out.utilization = availableMins > 0 ? Math.round((bookedMins / availableMins) * 1000) / 10 : null;
  }
  return out;
};

/* ── AdminOS ─────────────────────────────────────────────────────────────────────────── */
const _adminH = {};
_adminH.entAdminAvailability = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  const cal = await loadCalendar(d);
  const month = String(d.month || CORE.monthOf(CORE.dateOf(_now())));
  if (!/^\d{4}-\d{2}$/.test(month)) fail('invalid-argument', 'month is YYYY-MM.');
  const items = (await _monthItems(cal.calKey, month))
    .filter((it) => CORE.monthOf(CORE.dateOf(it.s)) === month || CORE.monthOf(CORE.dateOf(it.e - 1)) === month)
    .sort((a, b) => a.s - b.s)
    /* References and states only. Block labels are the provider's private notes — shown only to
       a super admin, and only because an intervention may need them. */
    .map((it) => ({ id: it.id, state: it.k === 'B' ? 'BOOKED' : it.k === 'H' ? 'TEMPORARILY_HELD' : 'BLOCKED', start: it.s, end: it.e,
      bookingRef: it.ref || null, serviceId: it.svc || null, label: _isSuper(req) ? (it.label || null) : undefined, holdUntil: it.until || null }));
  const audit = await _db().collection(COL.AUDIT).where('calKey', '==', cal.calKey).limit(50).get().catch(() => ({ docs: [] }));
  return { calKey: cal.calKey, kind: cal.kind, category: cal.category, ownerUid: cal.ownerUid, bookable: cal.bookable,
    config: { horizonDays: cal.cfg.horizonDays, durationMins: cal.cfg.durationMins, capacity: cal.cfg.capacity, bufferBeforeMins: cal.cfg.bufferBeforeMins, bufferAfterMins: cal.cfg.bufferAfterMins, minNoticeMins: cal.cfg.minNoticeMins },
    month, items, audit: audit.docs.map((x) => x.data()).sort((a, b) => (b.at || 0) - (a.at || 0)) };
};
/**
 * Super-admin intervention (reason required, audited): block · unblock · release_orphan.
 * release_orphan only removes an item whose booking is MISSING or already terminal — it can never
 * open a live booking's time.
 */
_adminH.entAdminAvailabilityIntervene = async (req) => {
  if (!_isSuper(req)) fail('permission-denied', 'Super admin only.');
  const d = req.data || {};
  const reason = _san(d.reason, 500);
  if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
  const cal = await loadCalendar(d);
  const action = String(d.action || '');
  const actor = _uidOf(req);
  if (action === 'block') {
    const s = Number(d.startMs); const e = Number(d.endMs);
    const blockId = 'blk_' + require('crypto').randomBytes(8).toString('hex');
    const plan = await planReservation({ cal, service: null, startMs: s, endMs: e, itemId: blockId, skipBookable: true });
    let res;
    await _db().runTransaction(async (txn) => { const st = await readPlan(txn, plan); res = claim(txn, plan, st, { kind: CORE.KIND.BLOCK, label: 'AdminOS: ' + reason.slice(0, 100) }); });
    if (!res.ok) fail('failed-precondition', res.message);
    await _audit({ calKey: cal.calKey, actor, role: 'superAdmin', action: 'admin_block', itemId: blockId, reason, start: s, end: e });
    return { ok: true, itemId: blockId };
  }
  if (action === 'unblock' || action === 'release_orphan') {
    const itemId = String(d.itemId || ''); const month = String(d.month || '');
    if (!itemId || !/^\d{4}-\d{2}$/.test(month)) fail('invalid-argument', 'itemId and month are required.');
    const rec = { calKey: cal.calKey, itemId, months: [month] };
    let found = null;
    const pre = await monthRef(cal.calKey, month).get();
    found = pre.exists ? (pre.data().items || []).find((it) => it.id === itemId) : null;
    if (!found) fail('not-found', 'Item not found.');
    if (action === 'unblock' && !(found.k === 'X' || found.k === 'C')) fail('failed-precondition', 'Only a block can be unblocked. A booking opens through its own cancellation.');
    if (action === 'release_orphan') {
      if (!(found.k === 'B' || found.k === 'H') || !found.ref) fail('failed-precondition', 'Only a booking item can be released.');
      const src = await _db().doc(found.ref).get();
      const b = src.exists ? src.data() : null;
      const TERMINAL = ['cancelled', 'declined', 'no_show', 'rejected', 'expired'];
      if (b && !TERMINAL.includes(String(b.status || '').toLowerCase())) fail('failed-precondition', 'That booking is still live. It opens only through its own cancellation.');
      rec.months = Array.from(new Set([month, ...monthsFor(found.s, found.e, found.bb, found.ba)]));
    }
    let ok = false;
    await _db().runTransaction(async (txn) => { const st = await readPlan(txn, rec); ok = release(txn, rec, st); });
    await _audit({ calKey: cal.calKey, actor, role: 'superAdmin', action: 'admin_' + action, itemId, reason });
    return { ok };
  }
  return fail('invalid-argument', 'Unknown action.');
};
_adminH.entAdminAvailabilityPolicy = async (req) => {
  if (!_isAdmin(req)) fail('permission-denied', 'Admin only.');
  const d = req.data || {};
  if (d.set) {
    if (!_isSuper(req)) fail('permission-denied', 'Super admin only.');
    const reason = _san(d.reason, 500);
    if (reason.length < 5) fail('invalid-argument', 'A reason is required.');
    const cats = {};
    for (const k of Object.keys(DEFAULT_POLICY.categories)) {
      const x = (d.set.categories || {})[k]; if (!x) continue;
      cats[k] = { requiresVerification: x.requiresVerification !== false,
        maxHorizonDays: Math.min(730, Math.max(1, Math.round(Number(x.maxHorizonDays) || DEFAULT_POLICY.categories[k].maxHorizonDays))),
        baseMaxHorizonDays: Math.min(730, Math.max(1, Math.round(Number(x.baseMaxHorizonDays) || DEFAULT_POLICY.categories[k].baseMaxHorizonDays))) };
    }
    await _db().collection(COL.POLICY).doc(COL.POLICY_DOC).set({ categories: cats, updatedAt: _FV().serverTimestamp(), updatedBy: _uidOf(req) }, { merge: true });
    _policyCache = null;
    await _audit({ calKey: '*', actor: _uidOf(req), role: 'superAdmin', action: 'policy', reason });
  }
  return { policy: await policy() };
};

module.exports = {
  COL, DEFAULT_POLICY, KEY_RE, _h, _adminH,
  policy, isAdvanced, calKeyFor, loadCalendar, loadService, planReservation, planFromRecord, readPlan, claim, setKind,
  release, move, refusalError, paymentInFlight, summaryFor, monthsFor, monthRef, pubRef,
  _setClock: (fn) => { _now = fn || (() => Date.now()); }, _resetPolicy: () => { _policyCache = null; },
};
