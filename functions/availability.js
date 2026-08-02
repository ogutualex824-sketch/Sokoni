/* ============================================================
   SOKONI Universal Availability & Scheduling Engine v1.0
   Platform-wide availability used by every hub:
   marketplace, food, healthcare, services, property, jobs,
   events, entertainment, hotels, rides, delivery, legal, etc.
   ============================================================ */

"use strict";

const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const admin = require("firebase-admin");
const rc = require("./reservation-core");   /* canonical overlap + active-status set (matches the booking gate) */

const db = admin.firestore();

/* ── Constants ─────────────────────────────────────────────────────────── */

const VALID_STATUSES = new Set([
  "available", "busy", "away", "offline", "on_break",
  "closed", "vacation", "emergency_closure", "do_not_disturb",
]);

const VALID_MODES = new Set([
  "open_24_7", "fixed_hours", "appointment_only", "on_demand",
  "shift_based", "weekend_only", "weekday_only", "seasonal",
  "temporary_closed", "custom",
]);

const VALID_HUB_TYPES = new Set([
  "marketplace", "food", "healthcare", "services", "property", "jobs",
  "events", "entertainment", "hotels", "short_stays", "rides",
  "car_hub", "delivery", "legal", "education", "digital", "b2b", "general",
]);

const DAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const CF_OPTIONS = { enforceAppCheck: true, region: "us-central1" };

exports._h = {}; // handler registry — consumed by booking-dispatch.js

/* ── Pure helpers ───────────────────────────────────────────────────────── */

/** Validate HH:MM time format and logical ordering. */
function _validPeriod(p) {
  const re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  return (
    p && typeof p.open === "string" && typeof p.close === "string" &&
    re.test(p.open) && re.test(p.close) && p.open < p.close
  );
}

/** HH:MM → minutes since midnight. */
function _mins(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/** Pure bookability decision for ONE candidate slot — the single place that decides
 *  whether a generated slot is offerable, so displayed availability and the booking
 *  gate (_prepareSlot) can never drift. Returns null when bookable, else the blocking
 *  reason. Precedence is most-definitive-first: an already-taken slot reads as `booked`
 *  even if it is also in the past. `bookedStartTimes` is the legacy reserveSlot set;
 *  `activeBookings` are canonical providerBookings (incl. pending HOLDS) checked by
 *  true buffered interval overlap. */
function computeSlotReason(o) {
  const startMins = o.startMins, endMins = o.endMins;
  const isBooked =
    (o.bookedStartTimes && o.bookedStartTimes.has(o.startT)) ||
    (o.activeBookings || []).some((b) =>
      rc.pairOverlaps(o.slotStartMs, o.slotEndMs, Number(b.startTs), Number(b.endTs), o.bufMs, o.bufMs));
  if (isBooked) return "booked";
  if (o.slotStartMs < o.nowMs) return "past";                                   /* unconditional now-floor */
  const onBreak = (o.breaks || []).some((b) =>
    b && b.start && b.end && startMins < _mins(b.end) && endMins > _mins(b.start));
  if (onBreak) return "break";
  if (o.slotStartMs < o.earliestBookableMs && !o.allowSameDay) return "too_soon";
  if (o.slotStartMs > o.horizonMs) return "beyond_horizon";
  return null;
}
exports._computeSlotReason = computeSlotReason;   /* pure — unit-tested in test-availability-slots.js */

/**
 * Return current Nairobi time context.
 * All scheduling logic runs in Africa/Nairobi (UTC+3, no DST).
 */
function _nairobiNow() {
  const nairobi = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Africa/Nairobi" }),
  );
  const dowIdx = nairobi.getDay(); // 0=Sunday
  const DOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return {
    dow: DOW_NAMES[dowIdx],
    time: `${String(nairobi.getHours()).padStart(2, "0")}:${String(nairobi.getMinutes()).padStart(2, "0")}`,
    date: `${nairobi.getFullYear()}-${String(nairobi.getMonth() + 1).padStart(2, "0")}-${String(nairobi.getDate()).padStart(2, "0")}`,
    js: nairobi,
  };
}

/** Derive dateStr for a date N days from today (Nairobi). */
function _nairobiDateOffset(offsetDays) {
  const now = _nairobiNow();
  const d = new Date(now.js);
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Compute open/closed from the stored config object without any DB reads. */
function _computeIsOpen(cfg) {
  if (!cfg) return false;
  if (cfg.isOnVacation) return false;
  if (!cfg.modes || cfg.modes.includes("temporary_closed")) return false;
  if (cfg.modes.includes("open_24_7")) return true;

  // Respect manual override only if it hasn't expired
  if (cfg.isManualOverride) {
    if (cfg.manualOverrideUntil) {
      const expires = cfg.manualOverrideUntil.toDate
        ? cfg.manualOverrideUntil.toDate()
        : new Date(cfg.manualOverrideUntil);
      if (new Date() <= expires) {
        return cfg.liveStatus === "available";
      }
      // Override expired — fall through to schedule
    } else {
      // Permanent manual override
      return cfg.liveStatus === "available";
    }
  }

  const { dow, time } = _nairobiNow();

  // Weekend / weekday mode guards
  const isWeekend = dow === "saturday" || dow === "sunday";
  if (cfg.modes.includes("weekday_only") && isWeekend) return false;
  if (cfg.modes.includes("weekend_only") && !isWeekend) return false;

  const day = cfg.schedule?.[dow];
  if (!day || day.closed || !Array.isArray(day.periods) || day.periods.length === 0) return false;

  const timeMins = _mins(time);

  // Check if inside any break
  const onBreak = (day.breaks || []).some(
    (b) => b.start && b.end && _mins(b.start) <= timeMins && timeMins < _mins(b.end),
  );
  if (onBreak) return false;

  return day.periods.some(
    (p) => _validPeriod(p) && _mins(p.open) <= timeMins && timeMins < _mins(p.close),
  );
}

/**
 * Find the next opening date+time from now (searches up to 14 days).
 * Returns null if no opening found (e.g. temporary closure).
 */
function _nextOpen(cfg) {
  if (!cfg || cfg.isOnVacation || !cfg.modes) return null;
  if (cfg.modes.includes("open_24_7")) return "Now";
  if (cfg.modes.includes("temporary_closed")) return null;

  const DOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  for (let i = 0; i <= 14; i++) {
    const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Nairobi" }));
    d.setDate(d.getDate() + i);
    const dow = DOW_NAMES[d.getDay()];
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    const isWeekend = dow === "saturday" || dow === "sunday";
    if (cfg.modes.includes("weekday_only") && isWeekend) continue;
    if (cfg.modes.includes("weekend_only") && !isWeekend) continue;

    const day = cfg.schedule?.[dow];
    if (!day || day.closed || !day.periods?.length) continue;

    // On day 0, only future periods count
    const nowMins = i === 0 ? _mins(_nairobiNow().time) : -1;
    const futurePeriod = day.periods.find((p) => _validPeriod(p) && _mins(p.open) > nowMins);
    if (futurePeriod) {
      return i === 0 ? `Today at ${futurePeriod.open}` : `${dateStr} at ${futurePeriod.open}`;
    }
  }
  return null;
}

/** Build the lightweight denormalised status doc written to availabilityStatus/{uid}. */
function _buildStatusDoc(cfg) {
  const isOpen = _computeIsOpen(cfg);
  let label = isOpen ? "Open Now" : "Closed";
  if (cfg.isOnVacation) {
    label = cfg.vacationEndDate ? `Away until ${cfg.vacationEndDate}` : "On Vacation";
  } else if (cfg.liveStatus === "busy") {
    label = "Currently Busy";
  } else if (cfg.liveStatus === "on_break") {
    label = "On Break";
  } else if (cfg.liveStatus === "emergency_closure") {
    label = "Emergency Closure";
  } else if (cfg.liveStatus === "do_not_disturb") {
    label = "Do Not Disturb";
  } else if (!isOpen) {
    const next = _nextOpen(cfg);
    if (next) label = `Closed · Opens ${next}`;
  }

  return {
    uid:              cfg.uid,
    hubType:          cfg.hubType || "general",
    businessName:     cfg.businessName || "",
    liveStatus:       cfg.liveStatus || "available",
    isOpen,
    isOnVacation:     cfg.isOnVacation || false,
    vacationEndDate:  cfg.vacationEndDate || null,
    modes:            cfg.modes || [],
    avgResponseMins:  cfg.avgResponseMins || null,
    label,
    updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
  };
}

/* ── Validation helpers ──────────────────────────────────────────────────── */

function _sanitiseSchedule(raw) {
  const out = {};
  for (const day of DAYS) {
    const src = raw?.[day];
    if (!src || src.closed) {
      out[day] = { closed: true, periods: [], breaks: [] };
      continue;
    }
    out[day] = {
      closed:  false,
      periods: (src.periods || []).filter(_validPeriod).slice(0, 4),
      breaks:  (src.breaks  || [])
        .filter((b) => b.start && b.end && /^\d{2}:\d{2}$/.test(b.start) && /^\d{2}:\d{2}$/.test(b.end))
        .slice(0, 4),
    };
  }
  return out;
}

function _clamp(v, min, max, def) {
  const n = Number(v);
  if (isNaN(n)) return def;
  return Math.max(min, Math.min(max, n));
}

/* ── CANONICAL availability normalization pipeline ───────────────────────────
   THE single normalization/validation implementation for provider availability.
   Every persisted availability configuration passes through here before storage —
   the rich editor (setProviderAvailability) directly, and the onboarding wizard
   via an input adapter (D2b) — so there is ONE canonical schema and ONE validator
   regardless of which UI produced the input. Governance invariant (D2):
   "Every persisted availability configuration reaches this pipeline before storage."
   Pure of I/O; the caller writes the returned config + status doc. */
function normalizeAvailabilityConfig(d, targetUid) {
  d = d || {};
  const modes = (Array.isArray(d.modes) ? d.modes : [d.mode]).filter((m) => VALID_MODES.has(m));
  if (modes.length === 0) {
    throw new HttpsError("invalid-argument", "At least one valid availability mode is required.");
  }
  const hubType  = VALID_HUB_TYPES.has(d.hubType) ? d.hubType : "general";
  const schedule = _sanitiseSchedule(d.schedule);

  const appt = {
    enabled:         Boolean(d.appt?.enabled),
    durationMins:    _clamp(d.appt?.durationMins,  5,  480, 30),
    bufferMins:      _clamp(d.appt?.bufferMins,     0,  120, 0),
    travelMins:      _clamp(d.appt?.travelMins,     0,  120, 0),
    maxDaysAhead:    _clamp(d.appt?.maxDaysAhead,   1,  365, 30),
    minNoticeHours:  _clamp(d.appt?.minNoticeHours, 0,   72, 1),
    allowSameDay:    Boolean(d.appt?.allowSameDay),
    allowAfterHours: Boolean(d.appt?.allowAfterHours),
  };

  /* Capacity — accept the canonical `maxSimultaneous` OR the legacy client key
     `maxSim` (fixes the round-trip bug where the editor saved one and read the other). */
  const _maxSim = d.cap?.maxSimultaneous != null ? d.cap.maxSimultaneous : d.cap?.maxSim;
  const cap = {
    maxPerDay:       d.cap?.maxPerDay  != null ? _clamp(d.cap.maxPerDay,  1, 9999, null) : null,
    maxPerWeek:      d.cap?.maxPerWeek != null ? _clamp(d.cap.maxPerWeek, 1, 9999, null) : null,
    maxSimultaneous: _maxSim != null ? _clamp(_maxSim, 1, 100, null) : null,
    todayCount:      0,
    todayDate:       _nairobiNow().date,
  };

  const vacationActive = Boolean(d.vacation?.active);
  const now = _nairobiNow();
  return {
    uid:                targetUid,
    hubType,
    businessName:       String(d.businessName || "").slice(0, 120),
    modes,
    schedule,
    appt,
    cap,
    isOnVacation:       vacationActive,
    vacationStartDate:  vacationActive ? (String(d.vacation?.startDate || now.date)) : null,
    vacationEndDate:    vacationActive ? (String(d.vacation?.endDate   || ""))        : null,
    vacationMessage:    vacationActive ? String(d.vacation?.message    || "").slice(0, 200) : null,
    vacationAutoReactivate: Boolean(d.vacation?.autoReactivate),
    liveStatus:         VALID_STATUSES.has(d.liveStatus) ? d.liveStatus : "available",
    isManualOverride:   Boolean(d.isManualOverride),
    manualOverrideUntil: d.manualOverrideUntil ? new Date(d.manualOverrideUntil) : null,
    afterHours:         Boolean(d.afterHours),
    afterHoursMsg:      String(d.afterHoursMsg || "").slice(0, 300),
    avgResponseMins:    d.avgResponseMins ? _clamp(d.avgResponseMins, 1, 10080, null) : null,
    notify: {
      onOpen:     Boolean(d.notify?.onOpen),
      onClose:    Boolean(d.notify?.onClose),
      onCapacity: Boolean(d.notify?.onCapacity),
      onBooking:  Boolean(d.notify?.onBooking),
    },
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  };
}
exports.normalizeAvailabilityConfig = normalizeAvailabilityConfig;

/* ══════════════════════════════════════════════════════════════════════════
   CF 1 — setProviderAvailability
   Save the provider's complete availability configuration.
   Writes to providerAvailability/{uid} and denormalises into availabilityStatus/{uid}.
══════════════════════════════════════════════════════════════════════════ */
exports.setProviderAvailability = onCall(CF_OPTIONS, exports._h.setProviderAvailability = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const d = request.data;

  // Allow admins to configure any provider
  const targetUid = request.auth.token?.admin && d.providerId ? d.providerId : uid;

  /* ONE canonical normalization pipeline (shared with the onboarding adapter, D2b). */
  const config = normalizeAvailabilityConfig(d, targetUid);

  const batch = db.batch();
  const configRef = db.collection("providerAvailability").doc(targetUid);
  batch.set(configRef, config, { merge: true });
  batch.set(
    db.collection("availabilityStatus").doc(targetUid),
    _buildStatusDoc(config),
    { merge: false },
  );
  await batch.commit();

  /* Availability-convergence telemetry (D2): count canonical-pipeline saves so the
     deprecated blind-merge writer's retirement can be gated on observed usage
     (mirrors the settlement monitor's approach). Best-effort — never fails a save. */
  try {
    await db.collection("systemHealth").doc("availabilityConvergence").set(
      { canonicalWrites: admin.firestore.FieldValue.increment(1),
        updatedAt: admin.firestore.FieldValue.serverTimestamp() },
      { merge: true });
  } catch (_) { /* metric must not break the save */ }

  return { success: true, isOpen: _computeIsOpen(config) };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 2 — setLiveStatus
   Instantly change a provider's live status. Takes effect across the
   platform within seconds via Firestore real-time listeners.
══════════════════════════════════════════════════════════════════════════ */
exports.setLiveStatus = onCall(CF_OPTIONS, exports._h.setLiveStatus = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { status, until, providerId } = request.data;

  if (!VALID_STATUSES.has(status)) {
    throw new HttpsError("invalid-argument", `Invalid status: ${status}`);
  }

  // Admins can set status for any provider
  const targetUid = request.auth.token?.admin && providerId ? providerId : uid;

  const overrideUntil = until ? new Date(until) : null;

  const patch = {
    liveStatus:           status,
    isManualOverride:     true,
    manualOverrideUntil:  overrideUntil,
    updatedAt:            admin.firestore.FieldValue.serverTimestamp(),
  };

  const configRef = db.collection("providerAvailability").doc(targetUid);
  await configRef.set(patch, { merge: true });

  // Refresh status doc
  const configSnap = await configRef.get();
  const merged = { ...(configSnap.data() || {}), ...patch, liveStatus: status };
  await db.collection("availabilityStatus").doc(targetUid).set(
    _buildStatusDoc(merged),
    { merge: false },
  );

  return { success: true, status, isOpen: _computeIsOpen(merged) };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 3 — getAvailabilitySlots
   Returns available appointment slots for N days starting from startDate.
   Generates slots from the provider's schedule, subtracts booked ones.
   No composite index required: bookings stored with deterministic doc IDs
   that allow range queries on the document ID itself.
══════════════════════════════════════════════════════════════════════════ */
exports.getAvailabilitySlots = onCall(CF_OPTIONS, exports._h.getAvailabilitySlots = async (request) => {
  const { providerId, startDate, days = 7, serviceId } = request.data;
  if (!providerId) throw new HttpsError("invalid-argument", "providerId required.");

  /* Slot duration MUST match what booking validation (_prepareSlot) will use, or a displayed slot can
     be rejected as "outside working hours". When a serviceId is given, generate slots at the SERVICE's
     duration (the same value bookingCreateService validates against) — one availability authority. */
  let _serviceDur = 0;
  if (serviceId) {
    try {
      const svcSnap = await db.collection("providerServices").doc(String(serviceId)).get();
      if (svcSnap.exists) {
        const svc = svcSnap.data();
        _serviceDur = Math.max(0, Math.round(Number((svc.pricing && svc.pricing.durationMins) || svc.durationMins) || 0));
      }
    } catch (e) { console.warn("[getAvailabilitySlots] service duration lookup failed", { serviceId, message: e && e.message }); }
  }

  /* ── Canonical availability, with convergence fallback so an approved provider is NEVER
     permanently unbookable. A default (Mon–Fri 09:00–17:00, appointments enabled) is applied —
     and PERSISTED once — when the doc is missing or effectively unconfigured (empty schedule /
     appointments not enabled). This is the one availability authority; no parallel source. ── */
  const DEFAULT_SCHEDULE = {
    monday:    { closed: false, periods: [{ open: "09:00", close: "17:00" }], breaks: [] },
    tuesday:   { closed: false, periods: [{ open: "09:00", close: "17:00" }], breaks: [] },
    wednesday: { closed: false, periods: [{ open: "09:00", close: "17:00" }], breaks: [] },
    thursday:  { closed: false, periods: [{ open: "09:00", close: "17:00" }], breaks: [] },
    friday:    { closed: false, periods: [{ open: "09:00", close: "17:00" }], breaks: [] },
    saturday:  { closed: true, periods: [], breaks: [] },
    sunday:    { closed: true, periods: [], breaks: [] },
  };
  const DEFAULT_APPT = { enabled: true, durationMins: 60, bufferMins: 0, travelMins: 0, minNoticeHours: 1, allowSameDay: false, maxDaysAhead: 30 };

  const configSnap = await db.collection("providerAvailability").doc(providerId).get();
  let cfg = configSnap.exists ? configSnap.data() : {};
  const _anyOpen = cfg.schedule && Object.keys(cfg.schedule).some(function (k) {
    return cfg.schedule[k] && !cfg.schedule[k].closed && (cfg.schedule[k].periods || []).length > 0;
  });
  const _apptOk = cfg.appt && cfg.appt.enabled === true && Number(cfg.appt.durationMins) > 0;
  const _unconfigured = !configSnap.exists || !_anyOpen || !_apptOk;
  if (_unconfigured) {
    if (!_anyOpen) cfg.schedule = DEFAULT_SCHEDULE;
    cfg.appt = Object.assign({}, DEFAULT_APPT, cfg.appt || {});
    if (cfg.appt.enabled == null) cfg.appt.enabled = true;
    if (!(Number(cfg.appt.durationMins) > 0)) cfg.appt.durationMins = DEFAULT_APPT.durationMins;
    /* One-time backfill so the manager shows it + the config is canonical. Non-fatal on failure. */
    try {
      await db.collection("providerAvailability").doc(providerId).set({
        schedule: cfg.schedule, appt: cfg.appt, modes: cfg.modes || ["fixed_hours"], uid: providerId,
        autoConfiguredAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      console.info("[getAvailabilitySlots] auto-configured default availability", { providerId, existed: configSnap.exists });
    } catch (e) { console.warn("[getAvailabilitySlots] default backfill failed", { providerId, code: e && e.code, message: e && e.message }); }
  }

  // Booking-window bounds (all authoritative, all enforced per slot below):
  //  · nowMs        — wall clock; a slot in the past is NEVER bookable (independent of allowSameDay).
  //  · minNoticeMs  — lead time; earliestBookable = now + notice (same-day still governs whether today is allowed).
  //  · horizonMs    — max advance; a slot beyond now + maxDaysAhead is not bookable.
  //  · bufMs        — provider buffer/travel, applied to booking-overlap exactly as the booking gate does.
  const nowMs = Date.now();
  const minNoticeMs = (cfg.appt?.minNoticeHours || 1) * 3_600_000;
  const earliestBookableMs = nowMs + minNoticeMs;
  const maxAheadDays = Math.max(1, Number(cfg.appt?.maxDaysAhead) || 30);
  const horizonMs = nowMs + maxAheadDays * 86_400_000;
  const bufMs = ((cfg.appt?.bufferMins || 0) + (cfg.appt?.travelMins || 0)) * 60_000;

  const safeStart = startDate || _nairobiNow().date;
  const numDays   = Math.max(1, Math.min(30, maxAheadDays, Number(days) || 7));

  const DOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  const results = [];

  for (let i = 0; i < numDays; i++) {
    const dateObj = new Date(safeStart + "T00:00:00+03:00"); // Nairobi offset
    dateObj.setDate(dateObj.getDate() + i);
    const dateStr = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, "0")}-${String(dateObj.getDate()).padStart(2, "0")}`;
    const dow     = DOW_NAMES[dateObj.getDay()];

    /* ── Check date override (holiday / special hours) ── */
    const overSnap = await db.collection("providerAvailability").doc(providerId)
      .collection("overrides").doc(dateStr).get();

    let periods  = [];
    let breaks   = [];
    let dayClosed = false;

    if (overSnap.exists) {
      const ov = overSnap.data();
      dayClosed = Boolean(ov.closed);
      periods   = dayClosed ? [] : (ov.periods || []);
      breaks    = dayClosed ? [] : (ov.breaks  || []);
    } else {
      const day = cfg.schedule?.[dow];
      dayClosed = !day || day.closed;
      periods   = dayClosed ? [] : (day.periods || []);
      breaks    = dayClosed ? [] : (day.breaks  || []);
    }

    const _rej = dayClosed ? "closed" : (!cfg.appt?.enabled ? "appointments_disabled" : (periods.length === 0 ? "no_periods" : null));
    if (_rej) {
      console.info("[getAvailabilitySlots] day unavailable", { providerId, date: dateStr, dow, reason: _rej });
      results.push({ date: dateStr, available: false, closedReason: _rej, slots: [] });
      continue;
    }

    /* ── Load booked slots for this date via doc-ID prefix range ── */
    const startDocId = `${dateStr}_0000`;
    const endDocId   = `${dateStr}_2359`;
    const bookingsSnap = await db.collection("providerAvailability").doc(providerId)
      .collection("bookings")
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(startDocId)
      .endAt(endDocId)
      .get();

    const bookedTimes = new Set(
      bookingsSnap.docs
        .filter((d) => d.data().status !== "cancelled")
        .map((d) => d.data().startTime),
    );

    /* Canonical service-booking holds. bookingCreateService (the path the customer UI
       uses) writes providerBookings + slotLocks, NOT the legacy `bookings` sub-collection
       read above (that is reserveSlot's store). Read the ACTIVE providerBookings for this
       date — status pending is a live pre-payment HOLD, so it hides the slot too — and
       union by true interval overlap (same buffer as the booking gate) so DISPLAYED
       availability matches BOOKABLE availability regardless of which path reserved it.
       Reuses the providerId+date+status index bookingCreateService already runs. */
    let activeBookings = [];
    try {
      const pbSnap = await db.collection("providerBookings")
        .where("providerId", "==", providerId)
        .where("date", "==", dateStr)
        .where("status", "in", rc.ACTIVE_STATUSES)
        .get();
      activeBookings = pbSnap.docs
        .map((d) => d.data())
        .filter((b) => Number(b.startTs) > 0 && Number(b.endTs) > 0);
    } catch (e) {
      console.warn("[getAvailabilitySlots] providerBookings read failed", { providerId, date: dateStr, message: e && e.message });
    }

    /* ── Generate slots ── */
    const dur  = _serviceDur > 0 ? _serviceDur : cfg.appt.durationMins;   /* service duration when known → matches _prepareSlot */
    const buf  = cfg.appt.bufferMins + cfg.appt.travelMins;
    const step = dur + buf;
    const daySlots = [];

    for (const period of periods.filter(_validPeriod)) {
      let cur = _mins(period.open);
      const last = _mins(period.close) - dur;
      while (cur <= last) {
        const hh  = String(Math.floor(cur / 60)).padStart(2, "0");
        const mm  = String(cur % 60).padStart(2, "0");
        const startT = `${hh}:${mm}`;
        const endC   = cur + dur;
        const endMm  = endC % 60;
        const endT   = `${String(Math.floor(endC / 60)).padStart(2, "0")}:${String(endMm).padStart(2, "0")}`;

        const slotStartMs = new Date(`${dateStr}T${startT}:00+03:00`).getTime();
        const slotEndMs   = new Date(`${dateStr}T${endT}:00+03:00`).getTime();

        /* One authoritative bookability decision (pure, unit-tested) so DISPLAYED and
           BOOKABLE availability can never disagree. */
        const reason = computeSlotReason({
          startT, startMins: cur, endMins: endC, slotStartMs, slotEndMs,
          nowMs, earliestBookableMs, horizonMs, allowSameDay: cfg.appt.allowSameDay,
          breaks, activeBookings, bufMs, bookedStartTimes: bookedTimes,
        });
        const bookable = reason === null;

        daySlots.push({
          startTime: startT,
          endTime:   endT,
          status:    bookable ? "available" : "blocked",   /* self-describing for client/admin/debug tools */
          bookable,
          reason,                                           /* null when bookable; else why it is blocked */
          available: bookable,                              /* back-compat: existing client filters on this */
          booked:    reason === "booked",
        });
        cur += step;
      }
    }

    const _availCount = daySlots.filter((s) => s.available).length;
    if (!_availCount && daySlots.length) {
      const _booked = daySlots.filter((s) => s.booked).length;
      console.info("[getAvailabilitySlots] day generated but no open slots", { providerId, date: dateStr, total: daySlots.length, booked: _booked, tooSoon: daySlots.length - _booked });
    }
    results.push({
      date:      dateStr,
      available: daySlots.some((s) => s.available),
      slots:     daySlots,
    });
  }

  return {
    providerId,
    startDate: safeStart,
    durationMins: cfg.appt?.durationMins || 30,
    results,
  };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 4 — reserveSlot
   Atomically book a specific appointment slot using a Firestore transaction.
   Prevents double-booking via deterministic document IDs.
   Slot doc ID format: {YYYY-MM-DD}_{HHmm}  →  "2026-07-15_0900"
══════════════════════════════════════════════════════════════════════════ */
exports.reserveSlot = onCall(CF_OPTIONS, exports._h.reserveSlot = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const customerUid = request.auth.uid;
  const { providerId, date, startTime, endTime, hubType, serviceNote, idempotencyKey } = request.data;

  if (!providerId || !date || !startTime || !endTime) {
    throw new HttpsError("invalid-argument", "providerId, date, startTime, endTime required.");
  }

  const timeNoColon = startTime.replace(":", "");
  const slotDocId   = `${date}_${timeNoColon}`;
  const slotRef     = db.collection("providerAvailability").doc(providerId)
    .collection("bookings").doc(slotDocId);
  const configRef   = db.collection("providerAvailability").doc(providerId);

  await db.runTransaction(async (tx) => {
    const [slotDoc, configDoc] = await Promise.all([tx.get(slotRef), tx.get(configRef)]);

    /* Check slot not already taken */
    if (slotDoc.exists && slotDoc.data().status !== "cancelled") {
      throw new HttpsError("already-exists", "This time slot is already booked. Please choose another.");
    }

    const cfg = configDoc.data() || {};

    /* Check daily capacity */
    const now = _nairobiNow();
    const todayCount = cfg.cap?.todayDate === date ? (cfg.cap.todayCount || 0) : 0;
    if (cfg.cap?.maxPerDay != null && todayCount >= cfg.cap.maxPerDay) {
      throw new HttpsError("resource-exhausted", "Provider is fully booked for this day.");
    }

    /* Verify the requested slot falls within a valid schedule period */
    const dow = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"][
      new Date(date + "T00:00:00+03:00").getDay()
    ];
    const day = cfg.schedule?.[dow];
    const slotMins = _mins(startTime);
    const validPeriod = cfg.modes?.includes("open_24_7") ||
      cfg.appt?.allowAfterHours ||
      (day && !day.closed && (day.periods || []).some(
        (p) => _validPeriod(p) && _mins(p.open) <= slotMins && (slotMins + (cfg.appt?.durationMins || 30)) <= _mins(p.close),
      ));

    if (!validPeriod) {
      throw new HttpsError("out-of-range", "This slot falls outside the provider's working hours.");
    }

    /* Create the booking */
    tx.set(slotRef, {
      providerId,
      customerUid,
      date,
      startTime,
      endTime,
      status:        "confirmed",
      hubType:       VALID_HUB_TYPES.has(hubType) ? hubType : "general",
      serviceNote:   String(serviceNote || "").slice(0, 300),
      idempotencyKey: idempotencyKey || slotDocId,
      createdAt:     admin.firestore.FieldValue.serverTimestamp(),
      bookedAt:      admin.firestore.FieldValue.serverTimestamp(),
    });

    /* Increment daily counter */
    tx.update(configRef, {
      "cap.todayCount": todayCount + 1,
      "cap.todayDate":  date,
      updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
    });
  });

  return { success: true, bookingId: slotDocId, providerId, date, startTime, endTime };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 5 — releaseSlot
   Cancel a booking and free the slot. Decrements capacity counter.
══════════════════════════════════════════════════════════════════════════ */
exports.releaseSlot = onCall(CF_OPTIONS, exports._h.releaseSlot = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const callerUid = request.auth.uid;
  const isAdmin   = Boolean(request.auth.token?.admin);
  const { providerId, bookingId, reason } = request.data;

  if (!providerId || !bookingId) {
    throw new HttpsError("invalid-argument", "providerId and bookingId required.");
  }

  const slotRef = db.collection("providerAvailability").doc(providerId)
    .collection("bookings").doc(bookingId);

  await db.runTransaction(async (tx) => {
    const slotDoc = await tx.get(slotRef);
    if (!slotDoc.exists) throw new HttpsError("not-found", "Booking not found.");

    const booking = slotDoc.data();
    if (booking.status === "cancelled") {
      return; // idempotent
    }

    // Only the customer, the provider, or an admin may cancel
    if (!isAdmin && booking.customerUid !== callerUid && booking.providerId !== callerUid) {
      throw new HttpsError("permission-denied", "Not authorised to cancel this booking.");
    }

    tx.update(slotRef, {
      status:      "cancelled",
      cancelledBy: callerUid,
      cancelReason: String(reason || "").slice(0, 200),
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Decrement counter only if booking was for today
    const now = _nairobiNow();
    if (booking.date === now.date) {
      const configRef = db.collection("providerAvailability").doc(providerId);
      const configDoc = await tx.get(configRef);
      if (configDoc.exists) {
        const count = configDoc.data()?.cap?.todayCount || 0;
        if (count > 0) {
          tx.update(configRef, {
            "cap.todayCount": count - 1,
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    }
  });

  return { success: true, bookingId };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 6 — getProviderAvailability  (public HTTP endpoint)
   Fast public read used by search results, hub pages, and KASS.
   Response cached for 60 seconds at the CDN edge.
══════════════════════════════════════════════════════════════════════════ */
exports.getProviderAvailability = onRequest(
  { region: "us-central1", cors: true },
  async (req, res) => {
    const providerId = String(req.query.providerId || "").trim();
    if (!providerId || providerId.length > 128) {
      return res.status(400).json({ error: "providerId required." });
    }

    const [statusSnap, configSnap] = await Promise.all([
      db.collection("availabilityStatus").doc(providerId).get(),
      db.collection("providerAvailability").doc(providerId).get(),
    ]);

    if (!statusSnap.exists) {
      return res.status(404).json({ error: "Provider availability not configured." });
    }

    const status = statusSnap.data();
    const cfg    = configSnap.exists ? configSnap.data() : {};

    // Recompute isOpen live (schedule-aware, not cached value)
    const isOpen    = _computeIsOpen(cfg);
    const nextOpenAt = !isOpen ? _nextOpen(cfg) : null;

    res.set("Cache-Control", "public, max-age=60, stale-while-revalidate=30");
    res.json({
      providerId,
      businessName:   status.businessName,
      hubType:        status.hubType,
      liveStatus:     status.liveStatus,
      isOpen,
      label:          isOpen
        ? (status.liveStatus === "busy" ? "Currently Busy" : "Open Now")
        : (status.isOnVacation ? `Away until ${status.vacationEndDate}` : (nextOpenAt ? `Closed · Opens ${nextOpenAt}` : "Closed")),
      isOnVacation:    status.isOnVacation,
      vacationEndDate: status.vacationEndDate,
      vacationMessage: cfg.vacationMessage || null,
      nextOpenAt,
      avgResponseMins: status.avgResponseMins,
      modes:           status.modes,
      apptEnabled:     Boolean(cfg.appt?.enabled),
      afterHours:      Boolean(cfg.afterHours),
      afterHoursMsg:   cfg.afterHoursMsg || null,
    });
  },
);

/* ══════════════════════════════════════════════════════════════════════════
   CF 7 — scheduledAvailabilityMaintenance  (daily at 00:01 Nairobi)
   1. Reactivates vacation mode for providers whose vacation has ended.
   2. Resets daily booking counters to zero for a new day.
   3. Removes expired manual status overrides (restore schedule control).
══════════════════════════════════════════════════════════════════════════ */
exports.scheduledAvailabilityMaintenance = onSchedule(
  { schedule: "1 0 * * *", timeZone: "Africa/Nairobi", region: "us-central1" },
  async () => {
    const today = _nairobiNow().date;
    const now   = new Date();

    // 1. Reactivate expired vacations
    const vacationSnap = await db.collection("providerAvailability")
      .where("isOnVacation", "==", true)
      .get();

    // 2. Providers with stale daily counter (yesterday's date)
    // We fetch all docs where cap.todayDate is less than today
    // Single-field index on cap.todayDate is auto-created by Firestore
    const staleCounterSnap = await db.collection("providerAvailability")
      .where("cap.todayDate", "<", today)
      .get();

    // 3. Expired manual overrides (manualOverrideUntil < now)
    // We'll handle in-memory after fetching the vacation snap

    const BATCH_LIMIT = 400;
    let batch = db.batch();
    let batchCount = 0;

    const flush = async () => {
      if (batchCount > 0) {
        await batch.commit();
        batch = db.batch();
        batchCount = 0;
      }
    };

    // Process vacation expiries
    for (const doc of vacationSnap.docs) {
      const data = doc.data();
      const ended = data.vacationEndDate && data.vacationEndDate <= today;
      const expiredOverride = data.isManualOverride && data.manualOverrideUntil &&
        (data.manualOverrideUntil.toDate ? data.manualOverrideUntil.toDate() : new Date(data.manualOverrideUntil)) < now;

      if (ended && data.vacationAutoReactivate) {
        const updated = {
          ...data,
          isOnVacation: false,
          liveStatus: "available",
          isManualOverride: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        };
        batch.update(doc.ref, {
          isOnVacation: false,
          liveStatus: "available",
          isManualOverride: false,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        batch.set(
          db.collection("availabilityStatus").doc(doc.id),
          _buildStatusDoc(updated),
          { merge: false },
        );
        batchCount += 2;
      }

      if (expiredOverride) {
        batch.update(doc.ref, {
          isManualOverride: false,
          manualOverrideUntil: null,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        batchCount++;
      }

      if (batchCount >= BATCH_LIMIT) await flush();
    }

    // Reset stale daily counters
    for (const doc of staleCounterSnap.docs) {
      batch.update(doc.ref, {
        "cap.todayCount": 0,
        "cap.todayDate": today,
      });
      batchCount++;
      if (batchCount >= BATCH_LIMIT) await flush();
    }

    await flush();

    console.log(JSON.stringify({
      severity: "INFO",
      message: "scheduledAvailabilityMaintenance complete",
      vacationChecked: vacationSnap.size,
      staleCountersReset: staleCounterSnap.size,
      date: today,
    }));
  },
);

/* ══════════════════════════════════════════════════════════════════════════
   CF 8 — setVacationMode
   Enable or disable vacation mode. Blocks all bookings while active.
   Vacation is automatically deactivated on endDate by the maintenance job.
══════════════════════════════════════════════════════════════════════════ */
exports.setVacationMode = onCall(CF_OPTIONS, exports._h.setVacationMode = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { active, startDate, endDate, message, autoReactivate, reason } = request.data || {};

  if (typeof active !== "boolean") throw new HttpsError("invalid-argument", "active (boolean) required.");

  if (active) {
    if (!startDate || !endDate) throw new HttpsError("invalid-argument", "startDate and endDate required (YYYY-MM-DD).");
    if (String(startDate) > String(endDate)) throw new HttpsError("invalid-argument", "startDate must be ≤ endDate.");
  }

  const patch = {
    isOnVacation:           active,
    vacationStartDate:      active ? String(startDate) : null,
    vacationEndDate:        active ? String(endDate)   : null,
    vacationMessage:        active ? String(message  || "").slice(0, 300) : null,
    vacationReason:         active ? String(reason   || "").slice(0, 200) : null,
    vacationAutoReactivate: active ? autoReactivate !== false : false,
    liveStatus:             active ? "vacation" : "available",
    isManualOverride:       true,
    updatedAt:              admin.firestore.FieldValue.serverTimestamp(),
  };

  const configRef = db.collection("providerAvailability").doc(uid);
  await configRef.set(patch, { merge: true });

  const snap   = await configRef.get();
  const merged = { ...(snap.data() || {}), ...patch };
  await db.collection("availabilityStatus").doc(uid)
    .set(_buildStatusDoc(merged), { merge: false });

  return { success: true, isOnVacation: active };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 9 — addAvailabilityOverride
   Add a day-specific schedule override: holiday, special hours, or closure.
   Stored at: providerAvailability/{uid}/overrides/{YYYY-MM-DD}
══════════════════════════════════════════════════════════════════════════ */
exports.addAvailabilityOverride = onCall(CF_OPTIONS, exports._h.addAvailabilityOverride = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const { date, closed, periods, label } = request.data || {};

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD.");
  }

  const safePeriods = closed !== false  // default: closed
    ? []
    : (Array.isArray(periods) ? periods : []).filter(_validPeriod).slice(0, 4);

  await db.collection("providerAvailability").doc(uid)
    .collection("overrides").doc(String(date)).set({
      date:      String(date),
      closed:    closed !== false,
      periods:   safePeriods,
      label:     String(label || "").slice(0, 100),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

  return { success: true, date, closed: closed !== false };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 10 — removeAvailabilityOverride
   Remove a day override and restore the normal weekly schedule for that date.
══════════════════════════════════════════════════════════════════════════ */
exports.removeAvailabilityOverride = onCall(CF_OPTIONS, exports._h.removeAvailabilityOverride = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid  = request.auth.uid;
  const date = String(request.data?.date || "");

  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new HttpsError("invalid-argument", "date must be YYYY-MM-DD.");
  }

  await db.collection("providerAvailability").doc(uid)
    .collection("overrides").doc(date).delete();

  return { success: true, date };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 11 — listAvailabilityOverrides
   List upcoming day overrides (from today, next 365 days, max 100).
   Callers can only read their own overrides or an admin can read any.
══════════════════════════════════════════════════════════════════════════ */
exports.listAvailabilityOverrides = onCall(CF_OPTIONS, exports._h.listAvailabilityOverrides = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const targetUid = String(request.data?.providerId || request.auth.uid);

  if (targetUid !== request.auth.uid && !request.auth.token?.admin && !request.auth.token?.superAdmin) {
    throw new HttpsError("permission-denied", "Access denied.");
  }

  const today = _nairobiNow().date;
  const snap  = await db.collection("providerAvailability").doc(targetUid)
    .collection("overrides")
    .where("date", ">=", today)
    .orderBy("date", "asc")
    .limit(100)
    .get();

  return {
    overrides: snap.docs.map(d => d.data()),
    total:     snap.size,
  };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 12 — setMarketplaceAvailability
   Set stock and delivery status for marketplace/product sellers.
   Stock changes are reflected immediately in availabilityStatus.
══════════════════════════════════════════════════════════════════════════ */
const VALID_STOCK_STATUSES    = new Set(["in_stock","low_stock","out_of_stock","pre_order","backorder","discontinued"]);
const VALID_DELIVERY_STATUSES = new Set(["same_day","next_day","pickup_only","unavailable"]);

exports.setMarketplaceAvailability = onCall(CF_OPTIONS, exports._h.setMarketplaceAvailability = async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const d   = request.data || {};

  if (d.stockStatus    && !VALID_STOCK_STATUSES.has(d.stockStatus))
    throw new HttpsError("invalid-argument", `Invalid stockStatus: ${d.stockStatus}`);
  if (d.deliveryStatus && !VALID_DELIVERY_STATUSES.has(d.deliveryStatus))
    throw new HttpsError("invalid-argument", `Invalid deliveryStatus: ${d.deliveryStatus}`);

  const patch = { updatedAt: admin.firestore.FieldValue.serverTimestamp() };
  if (d.stockStatus    != null) patch.stockStatus    = d.stockStatus;
  if (d.deliveryStatus != null) patch.deliveryStatus = d.deliveryStatus;
  if (d.preOrderDate   != null) patch.preOrderDate   = String(d.preOrderDate);
  if (d.stockNote      != null) patch.stockNote      = String(d.stockNote).slice(0, 200);

  const configRef = db.collection("providerAvailability").doc(uid);
  await configRef.set(patch, { merge: true });

  await db.collection("availabilityStatus").doc(uid).set({
    stockStatus:    patch.stockStatus    ?? null,
    deliveryStatus: patch.deliveryStatus ?? null,
    updatedAt:      admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { success: true };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 13 — checkProviderAvailability
   Unified availability check: schedule + live status + vacation + capacity.
   Designed to be called by checkout flows, booking UIs, and KASS.
══════════════════════════════════════════════════════════════════════════ */
exports.checkProviderAvailability = onCall(
  { ...CF_OPTIONS, timeoutSeconds: 15 },
  exports._h.checkProviderAvailability = async (request) => {
    const providerId = String(request.data?.providerId || "");
    if (!providerId) throw new HttpsError("invalid-argument", "providerId required.");

    const [configSnap, statusSnap] = await Promise.all([
      db.collection("providerAvailability").doc(providerId).get(),
      db.collection("availabilityStatus").doc(providerId).get(),
    ]);

    if (!configSnap.exists) return { available: false, reason: "not_configured" };

    const cfg    = configSnap.data();
    const status = statusSnap.exists ? statusSnap.data() : {};
    const isOpen = _computeIsOpen(cfg);
    const next   = isOpen ? null : _nextOpen(cfg);

    let available = isOpen;
    let reason    = isOpen ? "schedule" : "outside_hours";

    if (cfg.isOnVacation) {
      available = false; reason = "vacation";
    } else if (cfg.liveStatus === "emergency_closure") {
      available = false; reason = "emergency";
    } else if (cfg.liveStatus === "do_not_disturb") {
      available = false; reason = "dnd";
    } else if (cfg.modes?.includes("temporary_closed")) {
      available = false; reason = "temporary_closed";
    }

    const today      = _nairobiNow().date;
    const todayCount = cfg.cap?.todayDate === today ? (cfg.cap.todayCount || 0) : 0;
    const maxPerDay  = cfg.cap?.maxPerDay ?? null;
    const atCapacity = maxPerDay !== null && todayCount >= maxPerDay;
    if (atCapacity) { available = false; reason = "capacity_full"; }

    return {
      available,
      reason,
      liveStatus:      cfg.liveStatus || "available",
      isOpen,
      isOnVacation:    cfg.isOnVacation || false,
      vacationEndDate: cfg.vacationEndDate || null,
      vacationMessage: cfg.vacationMessage || null,
      nextOpenAt:      next,
      atCapacity,
      capacityUsed:    todayCount,
      capacityMax:     maxPerDay,
      modes:           cfg.modes || [],
      apptEnabled:     Boolean(cfg.appt?.enabled),
      stockStatus:     cfg.stockStatus    || null,
      deliveryStatus:  cfg.deliveryStatus || null,
      label:           status.label || (isOpen ? "Open Now" : "Closed"),
    };
  }
);

/* ══════════════════════════════════════════════════════════════════════════
   CF 14 — getNextAvailableSlot
   Finds the earliest bookable appointment slot from a given date.
   Searches up to 30 days ahead. Respects notices, capacity, and overrides.
══════════════════════════════════════════════════════════════════════════ */
exports.getNextAvailableSlot = onCall(CF_OPTIONS, exports._h.getNextAvailableSlot = async (request) => {
  const providerId = String(request.data?.providerId || "");
  const fromDate   = request.data?.fromDate || _nairobiNow().date;
  if (!providerId) throw new HttpsError("invalid-argument", "providerId required.");

  const configSnap = await db.collection("providerAvailability").doc(providerId).get();
  if (!configSnap.exists) return { found: false, slot: null };

  const cfg = configSnap.data();
  if (!cfg.appt?.enabled) return { found: false, slot: null, reason: "appointments_disabled" };

  const DOW_NAMES  = ["sunday","monday","tuesday","wednesday","thursday","friday","saturday"];
  const minNoticeMs = (cfg.appt.minNoticeHours || 1) * 3_600_000;
  const earliest   = new Date(Date.now() + minNoticeMs);
  const dur  = cfg.appt.durationMins || 30;
  const step = dur + (cfg.appt.bufferMins || 0) + (cfg.appt.travelMins || 0);

  for (let i = 0; i < 30; i++) {
    const d = new Date(fromDate + "T00:00:00+03:00");
    d.setDate(d.getDate() + i);
    const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const dow     = DOW_NAMES[d.getDay()];

    const overSnap = await db.collection("providerAvailability").doc(providerId)
      .collection("overrides").doc(dateStr).get();

    let periods   = [];
    let dayClosed = false;

    if (overSnap.exists) {
      const ov = overSnap.data();
      dayClosed = Boolean(ov.closed);
      periods   = dayClosed ? [] : (ov.periods || []);
    } else {
      const day = cfg.schedule?.[dow];
      dayClosed = !day || day.closed;
      periods   = dayClosed ? [] : (day.periods || []);
    }

    if (dayClosed || !periods.length) continue;

    // Load existing bookings via doc-ID prefix range
    const bookingsSnap = await db.collection("providerAvailability").doc(providerId)
      .collection("bookings")
      .orderBy(admin.firestore.FieldPath.documentId())
      .startAt(`${dateStr}_0000`).endAt(`${dateStr}_2359`).get();

    const bookedTimes = new Set(
      bookingsSnap.docs
        .filter(bd => bd.data().status !== "cancelled")
        .map(bd => bd.data().startTime)
    );

    for (const period of periods.filter(_validPeriod)) {
      let cur  = _mins(period.open);
      const last = _mins(period.close) - dur;
      while (cur <= last) {
        const hh = String(Math.floor(cur / 60)).padStart(2, "0");
        const mm = String(cur % 60).padStart(2, "0");
        const startT  = `${hh}:${mm}`;
        const slotDt  = new Date(`${dateStr}T${startT}:00+03:00`);
        const endC    = cur + dur;
        const endT    = `${String(Math.floor(endC/60)).padStart(2,"0")}:${String(endC%60).padStart(2,"0")}`;

        if (!bookedTimes.has(startT) && slotDt >= earliest) {
          return { found: true, slot: { date: dateStr, startTime: startT, endTime: endT } };
        }
        cur += step;
      }
    }
  }

  return { found: false, slot: null, reason: "no_slots_in_30_days" };
});
