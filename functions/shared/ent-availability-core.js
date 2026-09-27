/* SOKONI — Entertainment availability core (pure).
 * ============================================================================================
 * The ONE definition of what a slot is, whether it is free, and what the PUBLIC may be told
 * about it. Pure: no Firestore, no clock of its own (every function takes nowMs), so the same
 * logic runs inside the reservation transaction, in the storefront view and in the tests.
 *
 * The authority that stores and reserves is functions/ent-availability.js. This file decides;
 * it never writes.
 *
 * TIME. All calendars are Africa/Nairobi (UTC+3, no daylight saving). A date is 'YYYY-MM-DD',
 * a time of day is minutes since local midnight.
 *
 * OCCUPANCY ITEMS (private; never leave the server):
 *   { id, k, s, e, bb, ba, u, svc, ref, label, until }
 *     k   'B' booking (paid, or free and confirmed) · 'H' hold (reserved, payment not settled)
 *         'X' provider block (private commitment, holiday, travel …) · 'C' cooldown after a cancel
 *     s,e the booked interval (epoch ms) · bb,ba buffer before / after (ms)
 *     u   capacity units (1) · svc service id · ref source document path · label (X only)
 *
 * PUBLIC STATES (the only words a buyer ever sees):
 *   AVAILABLE · LIMITED · BOOKED · UNAVAILABLE · BOOKING_NOT_OPEN · TEMPORARILY_HELD
 * A buffer, a block, travel, a private commitment, closed hours and minimum notice all become
 * UNAVAILABLE. Who booked, what, why, and for how much never appear.
 */
'use strict';

const TZ_OFFSET_MS = 3 * 3600000;                 /* Africa/Nairobi, fixed */
const DAY_MS = 86400000;
const MIN_MS = 60000;

const PUBLIC_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE', LIMITED: 'LIMITED', BOOKED: 'BOOKED', UNAVAILABLE: 'UNAVAILABLE',
  BOOKING_NOT_OPEN: 'BOOKING_NOT_OPEN', TEMPORARILY_HELD: 'TEMPORARILY_HELD',
});
/* The provider's own view (dashboard): distinguishes what the public must not see. */
const PRIVATE_STATE = Object.freeze({
  AVAILABLE: 'AVAILABLE', BOOKED: 'BOOKED', PENDING: 'PENDING', BLOCKED: 'BLOCKED',
  UNAVAILABLE: 'UNAVAILABLE', BOOKING_NOT_OPEN: 'BOOKING_NOT_OPEN',
});
const KIND = Object.freeze({ BOOKING: 'B', HOLD: 'H', BLOCK: 'X', COOLDOWN: 'C' });
/* Refusal codes a reservation can return. The caller maps them to a buyer-safe message. */
const REFUSAL = Object.freeze({
  ALREADY_BOOKED: 'ALREADY_BOOKED', TEMPORARILY_HELD: 'TEMPORARILY_HELD', SLOT_UNAVAILABLE: 'SLOT_UNAVAILABLE',
  BOOKING_NOT_OPEN: 'BOOKING_NOT_OPEN', TOO_SOON: 'TOO_SOON', OUTSIDE_HOURS: 'OUTSIDE_HOURS', PAST: 'PAST',
  DAY_FULL: 'DAY_FULL', INVALID: 'INVALID',
});
const DOW = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const DOW_LONG = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/* ── time ─────────────────────────────────────────────────────────────────────────────── */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
function isDate(d) { return typeof d === 'string' && DATE_RE.test(d) && Number.isFinite(Date.parse(d + 'T00:00:00Z')); }
function dayStartMs(date) { return Date.parse(date + 'T00:00:00+03:00'); }
function dateOf(ms) { return new Date(Number(ms) + TZ_OFFSET_MS).toISOString().slice(0, 10); }
function minsOf(ms) { const d = new Date(Number(ms) + TZ_OFFSET_MS); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function dowOf(date) { return new Date(date + 'T00:00:00Z').getUTCDay(); }
function addDays(date, n) { return dateOf(dayStartMs(date) + n * DAY_MS + 3600000); }
function hhmm(m) { const x = Math.max(0, Math.round(m)); return String(Math.floor(x / 60)).padStart(2, '0') + ':' + String(x % 60).padStart(2, '0'); }
function toMins(t) { const p = String(t || '').split(':'); const h = Number(p[0]); const m = Number(p[1] || 0); return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : NaN; }
function monthOf(date) { return String(date).slice(0, 7); }
function monthDays(month) {
  if (!MONTH_RE.test(String(month))) return [];
  const [y, m] = month.split('-').map(Number);
  const n = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const out = []; for (let d = 1; d <= n; d++) out.push(`${month}-${String(d).padStart(2, '0')}`);
  return out;
}
/* Every local date an interval touches (bounded: a reservation never spans more than 8 days). */
function datesTouched(s, e) {
  const out = []; let d = dateOf(s); const last = dateOf(Math.max(s, e - 1));
  for (let i = 0; i < 9; i++) { out.push(d); if (d === last) break; d = addDays(d, 1); }
  return out;
}

const _int = (v, lo, hi, dflt) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };

/* ── configuration ────────────────────────────────────────────────────────────────────── */
/* Periods: [[openMin, closeMin], ...] per weekday (0 = Sunday). */
function _periods(list) {
  return (Array.isArray(list) ? list : []).map((p) => {
    if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
    if (p && typeof p === 'object') return [toMins(p.open != null ? p.open : p.start), toMins(p.close != null ? p.close : p.end)];
    return null;
  }).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]) && p[1] > p[0] && p[0] >= 0 && p[1] <= 1440)
    .sort((a, b) => a[0] - b[0]).slice(0, 8);
}
/**
 * The one normalized calendar configuration. Adapters in ent-availability.js turn the stored
 * provider / venue configuration into this; nothing else is read by the decisions below.
 */
function normalizeConfig(raw) {
  const r = raw || {};
  const weekly = []; const breaks = [];
  for (let i = 0; i < 7; i++) {
    weekly.push(_periods(r.weekly && r.weekly[i]));
    breaks.push(_periods(r.breaks && r.breaks[i]));
  }
  const closedDates = {};
  (Array.isArray(r.closedDates) ? r.closedDates : Object.keys(r.closedDates || {})).forEach((d) => { if (isDate(d)) closedDates[d] = true; });
  return {
    open247: r.open247 === true,
    weekly, breaks, closedDates,
    vacation: r.vacation && isDate(r.vacation.from) ? { from: r.vacation.from, to: isDate(r.vacation.to) ? r.vacation.to : null } : null,
    durationMins: _int(r.durationMins, 15, 1440, 60),
    stepMins: _int(r.stepMins, 15, 1440, 0) || null,
    bufferBeforeMins: _int(r.bufferBeforeMins, 0, 720, 0),
    bufferAfterMins: _int(r.bufferAfterMins, 0, 720, 0),
    minNoticeMins: _int(r.minNoticeMins, 0, 60 * 24 * 60, 60),
    horizonDays: _int(r.horizonDays, 1, 730, 90),
    capacity: _int(r.capacity, 1, 100, 1),
    maxPerDay: _int(r.maxPerDay, 0, 9999, 0),
    allowSameDay: r.allowSameDay !== false,
    reopenAfterCancel: r.reopenAfterCancel !== false,
    cooldownMins: _int(r.cooldownMins, 0, 60 * 24 * 7, 0),
  };
}
/**
 * The effective configuration for one SERVICE: its duration, buffers, bookable weekdays, notice
 * and horizon narrow (never widen) the calendar's. `svc.availability` is the provider's
 * per-service override; absent → the calendar's own values.
 */
function forService(cfg, svc) {
  if (!svc) return cfg;
  const a = svc.availability || {};
  const days = Array.isArray(a.days) ? a.days.map(Number).filter((d) => d >= 0 && d <= 6) : null;
  return Object.assign({}, cfg, {
    durationMins: _int(a.durationMins != null ? a.durationMins : svc.durationMins, 15, 1440, cfg.durationMins),
    bufferBeforeMins: a.bufferBeforeMins != null ? _int(a.bufferBeforeMins, 0, 720, cfg.bufferBeforeMins) : cfg.bufferBeforeMins,
    bufferAfterMins: a.bufferAfterMins != null ? _int(a.bufferAfterMins, 0, 720, cfg.bufferAfterMins) : cfg.bufferAfterMins,
    minNoticeMins: Math.max(cfg.minNoticeMins, a.minNoticeMins != null ? _int(a.minNoticeMins, 0, 86400, 0) : 0),
    horizonDays: Math.min(cfg.horizonDays, a.horizonDays != null ? _int(a.horizonDays, 1, 730, cfg.horizonDays) : cfg.horizonDays),
    serviceDays: days && days.length ? days : null,
    serviceId: svc.id || null,
  });
}

/* ── decisions ─────────────────────────────────────────────────────────────────────────── */
function horizonEndMs(cfg, nowMs) { return dayStartMs(dateOf(nowMs)) + (cfg.horizonDays + 1) * DAY_MS; }
function beyondHorizon(cfg, startMs, nowMs) { return startMs >= horizonEndMs(cfg, nowMs); }

/* Is [s,e) inside the day's working periods and clear of its breaks? (local minutes) */
function withinHours(cfg, date, sMin, eMin) {
  if (cfg.closedDates[date]) return false;
  if (cfg.vacation && date >= cfg.vacation.from && (!cfg.vacation.to || date <= cfg.vacation.to)) return false;
  const dow = dowOf(date);
  if (cfg.serviceDays && !cfg.serviceDays.includes(dow)) return false;
  if (cfg.open247) return true;
  const inPeriod = (cfg.weekly[dow] || []).some(([o, c]) => o <= sMin && eMin <= c);
  if (!inPeriod) return false;
  return !(cfg.breaks[dow] || []).some(([o, c]) => sMin < c && eMin > o);
}

/* Candidate interval with the buffers that apply to it. */
function candidate(cfg, startMs, endMs) {
  return { s: startMs, e: endMs, bb: cfg.bufferBeforeMins * MIN_MS, ba: cfg.bufferAfterMins * MIN_MS };
}
const rawOverlap = (a, b) => a.s < b.e && a.e > b.s;
/* A candidate conflicts with an item when either one's buffer runs into the other's booked
   time. Two buffers may touch each other (travel windows can overlap); a buffer may never run
   into a booking, a hold, or a provider block. */
function touches(c, it) {
  const ibb = it.k === KIND.BLOCK || it.k === KIND.COOLDOWN ? 0 : Number(it.bb) || 0;
  const iba = it.k === KIND.BLOCK || it.k === KIND.COOLDOWN ? 0 : Number(it.ba) || 0;
  return (c.s < it.e + iba && c.e > it.s - ibb) || (c.s - c.bb < it.e && c.e + c.ba > it.s);
}

/**
 * Evaluate one candidate against the occupancy. Returns
 *   { ok:true, used, capacity }                      — free (used < capacity)
 *   { ok:false, code: REFUSAL.*, publicState, privateState }
 * `items` is every item on every date the candidate touches (dedupe by id). `excludeId` lets a
 * reschedule ignore the booking's own current item.
 */
function evaluate(cfg, items, c, nowMs, opts) {
  const o = opts || {};
  if (!(c.e > c.s)) return _no(REFUSAL.INVALID, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.UNAVAILABLE);
  const date = dateOf(c.s);
  if (c.s <= nowMs) return _no(REFUSAL.PAST, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.UNAVAILABLE);
  if (beyondHorizon(cfg, c.s, nowMs)) return _no(REFUSAL.BOOKING_NOT_OPEN, PUBLIC_STATE.BOOKING_NOT_OPEN, PRIVATE_STATE.BOOKING_NOT_OPEN);
  const sMin = minsOf(c.s); const eMin = dateOf(c.e - 1) === date ? (minsOf(c.e) || 1440) : 1440 + minsOf(c.e);
  const hoursOk = eMin <= 1440 ? withinHours(cfg, date, sMin, eMin) : cfg.open247 && !cfg.closedDates[date];
  if (!hoursOk) return _no(REFUSAL.OUTSIDE_HOURS, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.UNAVAILABLE);
  const seen = new Set(); let used = 0; let rawB = false; let rawH = false; let block = false; let bufferOnly = false;
  let dayCount = 0;
  for (const it of items || []) {
    if (!it || seen.has(it.id) || (o.excludeId && it.id === o.excludeId)) continue;
    seen.add(it.id);
    if ((it.k === KIND.BOOKING || it.k === KIND.HOLD) && dateOf(it.s) === date) dayCount++;
    if (!touches(c, it)) continue;
    if (it.k === KIND.BLOCK || it.k === KIND.COOLDOWN) { block = true; continue; }
    used += Math.max(1, Number(it.u) || 1);
    if (rawOverlap(c, it)) { if (it.k === KIND.BOOKING) rawB = true; else rawH = true; } else bufferOnly = true;
  }
  if (block) return _no(REFUSAL.SLOT_UNAVAILABLE, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.BLOCKED);
  if (used >= cfg.capacity) {
    if (rawB) return _no(REFUSAL.ALREADY_BOOKED, PUBLIC_STATE.BOOKED, PRIVATE_STATE.BOOKED);
    if (rawH) return _no(REFUSAL.TEMPORARILY_HELD, PUBLIC_STATE.TEMPORARILY_HELD, PRIVATE_STATE.PENDING);
    return _no(REFUSAL.SLOT_UNAVAILABLE, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.UNAVAILABLE);
  }
  if (cfg.maxPerDay > 0 && dayCount >= cfg.maxPerDay) return _no(REFUSAL.DAY_FULL, PUBLIC_STATE.BOOKED, PRIVATE_STATE.BOOKED);
  /* Notice is checked AFTER occupancy on purpose: a slot someone booked stays BOOKED to the
     public even inside the notice window, which is the honest answer. */
  if (c.s < nowMs + cfg.minNoticeMins * MIN_MS) return _no(REFUSAL.TOO_SOON, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.UNAVAILABLE);
  if (!cfg.allowSameDay && date === dateOf(nowMs)) return _no(REFUSAL.TOO_SOON, PUBLIC_STATE.UNAVAILABLE, PRIVATE_STATE.UNAVAILABLE);
  void bufferOnly;
  return { ok: true, used, capacity: cfg.capacity,
    publicState: used > 0 ? PUBLIC_STATE.LIMITED : PUBLIC_STATE.AVAILABLE, privateState: PRIVATE_STATE.AVAILABLE };
}
function _no(code, publicState, privateState) { return { ok: false, code, publicState, privateState }; }

/* The slot grid for one date: every start the configuration offers, stepping by stepMins (or
   the duration). Bounded: at most 96 slots a day. */
function slotStarts(cfg, date) {
  const dur = cfg.durationMins; const step = cfg.stepMins || dur;
  const periods = cfg.open247 ? [[0, 1440]] : (cfg.weekly[dowOf(date)] || []);
  const out = [];
  for (const [o, c] of periods) {
    for (let t = o; t + dur <= c && out.length < 96; t += step) out.push(t);
  }
  return out;
}

/**
 * Public slots for one date. Each entry is ONLY { start, end, state } — no ids, no reasons.
 */
function publicSlots(cfg, date, items, nowMs) {
  const base = dayStartMs(date);
  return slotStarts(cfg, date).map((t) => {
    const c = candidate(cfg, base + t * MIN_MS, base + (t + cfg.durationMins) * MIN_MS);
    const r = evaluate(cfg, items, c, nowMs);
    return { start: hhmm(t), end: hhmm(t + cfg.durationMins), state: r.ok ? r.publicState : r.publicState };
  });
}
/** The provider's own slots: PRIVATE_STATE plus, for their own items, the item behind it. */
function privateSlots(cfg, date, items, nowMs) {
  const base = dayStartMs(date);
  return slotStarts(cfg, date).map((t) => {
    const c = candidate(cfg, base + t * MIN_MS, base + (t + cfg.durationMins) * MIN_MS);
    const r = evaluate(cfg, items, c, nowMs);
    const cover = (items || []).filter((it) => rawOverlap(c, it)).map((it) => ({ id: it.id, k: it.k, ref: it.ref || null, label: it.label || null }));
    return { start: hhmm(t), end: hhmm(t + cfg.durationMins), state: r.privateState, items: cover };
  });
}

/* One word for a whole day, from its public slots. */
function dayState(cfg, date, slots, nowMs) {
  if (dayStartMs(date) >= horizonEndMs(cfg, nowMs)) return PUBLIC_STATE.BOOKING_NOT_OPEN;
  if (!slots.length) return PUBLIC_STATE.UNAVAILABLE;
  const open = slots.filter((s) => s.state === PUBLIC_STATE.AVAILABLE || s.state === PUBLIC_STATE.LIMITED).length;
  if (!open) {
    if (slots.some((s) => s.state === PUBLIC_STATE.BOOKED || s.state === PUBLIC_STATE.TEMPORARILY_HELD)) return PUBLIC_STATE.BOOKED;
    if (slots.every((s) => s.state === PUBLIC_STATE.BOOKING_NOT_OPEN)) return PUBLIC_STATE.BOOKING_NOT_OPEN;
    return PUBLIC_STATE.UNAVAILABLE;
  }
  const busy = slots.some((s) => s.state === PUBLIC_STATE.BOOKED || s.state === PUBLIC_STATE.TEMPORARILY_HELD || s.state === PUBLIC_STATE.LIMITED);
  return busy && open <= Math.max(1, Math.floor(slots.length / 4)) ? PUBLIC_STATE.LIMITED : PUBLIC_STATE.AVAILABLE;
}

/* Buyer-safe wording for a refusal. Never names a reason behind UNAVAILABLE. */
function refusalMessage(code) {
  switch (code) {
    case REFUSAL.ALREADY_BOOKED: case REFUSAL.DAY_FULL: return 'That time was just booked. Please choose another time.';
    case REFUSAL.TEMPORARILY_HELD: return 'Someone is completing a booking for that time. Please choose another time.';
    case REFUSAL.BOOKING_NOT_OPEN: return 'Bookings are not open for that date yet.';
    case REFUSAL.TOO_SOON: return 'That time is too soon to book.';
    case REFUSAL.PAST: return 'That time has passed.';
    default: return 'That time is not available. Please choose another time.';
  }
}

/* Serialisable item from a reservation request. */
function makeItem(cfg, { id, kind, startMs, endMs, units, serviceId, ref, label, until }) {
  const it = { id: String(id), k: kind, s: Number(startMs), e: Number(endMs), u: Math.max(1, Number(units) || 1) };
  if (kind === KIND.BOOKING || kind === KIND.HOLD) { it.bb = cfg.bufferBeforeMins * MIN_MS; it.ba = cfg.bufferAfterMins * MIN_MS; }
  if (serviceId) it.svc = String(serviceId);
  if (ref) it.ref = String(ref);
  if (label && kind === KIND.BLOCK) it.label = String(label).slice(0, 120);
  if (until) it.until = Number(until);
  return it;
}

module.exports = {
  TZ_OFFSET_MS, DAY_MS, PUBLIC_STATE, PRIVATE_STATE, KIND, REFUSAL, DOW, DOW_LONG,
  isDate, dayStartMs, dateOf, minsOf, dowOf, addDays, hhmm, toMins, monthOf, monthDays, datesTouched,
  normalizeConfig, forService, horizonEndMs, beyondHorizon, withinHours, candidate, touches, evaluate,
  slotStarts, publicSlots, privateSlots, dayState, refusalMessage, makeItem,
};
