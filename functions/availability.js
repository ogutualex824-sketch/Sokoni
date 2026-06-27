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

const CF_OPTIONS = { enforceAppCheck: false, region: "us-central1" };

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

/* ══════════════════════════════════════════════════════════════════════════
   CF 1 — setProviderAvailability
   Save the provider's complete availability configuration.
   Writes to providerAvailability/{uid} and denormalises into availabilityStatus/{uid}.
══════════════════════════════════════════════════════════════════════════ */
exports.setProviderAvailability = onCall(CF_OPTIONS, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
  const uid = request.auth.uid;
  const d = request.data;

  // Allow admins to configure any provider
  const targetUid = request.auth.token?.admin && d.providerId ? d.providerId : uid;

  /* Validate modes */
  const modes = (Array.isArray(d.modes) ? d.modes : [d.mode]).filter((m) => VALID_MODES.has(m));
  if (modes.length === 0) {
    throw new HttpsError("invalid-argument", "At least one valid availability mode is required.");
  }

  /* Validate hubType */
  const hubType = VALID_HUB_TYPES.has(d.hubType) ? d.hubType : "general";

  /* Parse & sanitise schedule */
  const schedule = _sanitiseSchedule(d.schedule);

  /* Appointment settings */
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

  /* Capacity */
  const cap = {
    maxPerDay:       d.cap?.maxPerDay  != null ? _clamp(d.cap.maxPerDay,  1, 9999, null) : null,
    maxPerWeek:      d.cap?.maxPerWeek != null ? _clamp(d.cap.maxPerWeek, 1, 9999, null) : null,
    maxSimultaneous: d.cap?.maxSim     != null ? _clamp(d.cap.maxSim,     1,  100, null) : null,
    todayCount:      0,
    todayDate:       _nairobiNow().date,
  };

  /* Vacation */
  const vacationActive = Boolean(d.vacation?.active);
  const now = _nairobiNow();

  const config = {
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

  const batch = db.batch();
  const configRef = db.collection("providerAvailability").doc(targetUid);
  batch.set(configRef, config, { merge: true });
  batch.set(
    db.collection("availabilityStatus").doc(targetUid),
    _buildStatusDoc(config),
    { merge: false },
  );
  await batch.commit();

  return { success: true, isOpen: _computeIsOpen(config) };
});

/* ══════════════════════════════════════════════════════════════════════════
   CF 2 — setLiveStatus
   Instantly change a provider's live status. Takes effect across the
   platform within seconds via Firestore real-time listeners.
══════════════════════════════════════════════════════════════════════════ */
exports.setLiveStatus = onCall(CF_OPTIONS, async (request) => {
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
exports.getAvailabilitySlots = onCall(CF_OPTIONS, async (request) => {
  const { providerId, startDate, days = 7 } = request.data;
  if (!providerId) throw new HttpsError("invalid-argument", "providerId required.");

  const configSnap = await db.collection("providerAvailability").doc(providerId).get();
  if (!configSnap.exists) {
    throw new HttpsError("not-found", "Provider has not configured availability.");
  }
  const cfg = configSnap.data();

  // Enforce minNoticeHours — earliest bookable time
  const minNoticeMs = (cfg.appt?.minNoticeHours || 1) * 3_600_000;
  const earliestBookable = new Date(Date.now() + minNoticeMs);

  const safeStart = startDate || _nairobiNow().date;
  const numDays   = Math.max(1, Math.min(30, Number(days) || 7));

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

    if (dayClosed || !cfg.appt?.enabled || periods.length === 0) {
      results.push({ date: dateStr, available: false, closedReason: dayClosed ? "closed" : "no_slots", slots: [] });
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

    /* ── Generate slots ── */
    const dur  = cfg.appt.durationMins;
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
        const endT   = `${String(Math.floor(endC / 60)).padStart(2, "0")}:${String(endC % 60).padStart(2, "0")}`;

        // Enforce minimum notice
        const slotDatetime = new Date(`${dateStr}T${startT}:00+03:00`);
        const tooSoon      = slotDatetime < earliestBookable && !cfg.appt.allowSameDay;

        daySlots.push({
          startTime: startT,
          endTime:   endT,
          available: !bookedTimes.has(startT) && !tooSoon,
          booked:    bookedTimes.has(startT),
        });
        cur += step;
      }
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
exports.reserveSlot = onCall(CF_OPTIONS, async (request) => {
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
exports.releaseSlot = onCall(CF_OPTIONS, async (request) => {
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
