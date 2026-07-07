/**
 * SOKONI Universal Availability SDK v1.0
 * ───────────────────────────────────────────────────────────────────────────
 * Works on every SOKONI hub page. Provides:
 *   • Real-time live-status badges via Firestore onSnapshot
 *   • Schedule-aware isOpenNow() computed client-side (no extra reads)
 *   • Appointment slot fetching and booking
 *   • Provider admin helpers (save config, set status, vacation mode)
 *
 * Quick start — display a badge on any element:
 *   <div data-avail-provider="PROVIDER_UID"></div>
 *
 * The SDK auto-initialises on DOMContentLoaded.
 */

(function (global) {
  "use strict";

  /* ── DOM safety ──────────────────────────────────────────────────────── */
  function _esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /* ── Time helpers (timezone-independent, works client-side) ─────────── */
  const DOW_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

  function _nairobiNow() {
    const nairobi = new Date(
      new Date().toLocaleString("en-US", { timeZone: "Africa/Nairobi" }),
    );
    return {
      dow:  DOW_NAMES[nairobi.getDay()],
      time: `${String(nairobi.getHours()).padStart(2, "0")}:${String(nairobi.getMinutes()).padStart(2, "0")}`,
      date: `${nairobi.getFullYear()}-${String(nairobi.getMonth() + 1).padStart(2, "0")}-${String(nairobi.getDate()).padStart(2, "0")}`,
    };
  }

  function _mins(t) {
    const [h, m] = t.split(":").map(Number);
    return h * 60 + m;
  }

  function _validPeriod(p) {
    return p && typeof p.open === "string" && typeof p.close === "string" && p.open < p.close;
  }

  /** Compute open/closed from the config object entirely client-side. */
  function _computeIsOpen(cfg) {
    if (!cfg) return false;
    if (cfg.isOnVacation) return false;
    if (!cfg.modes) return false;
    if (cfg.modes.includes("temporary_closed")) return false;
    if (cfg.modes.includes("open_24_7")) return true;

    if (cfg.isManualOverride) {
      const expires = cfg.manualOverrideUntil
        ? (cfg.manualOverrideUntil.toDate ? cfg.manualOverrideUntil.toDate() : new Date(cfg.manualOverrideUntil))
        : null;
      if (!expires || new Date() <= expires) {
        return cfg.liveStatus === "available";
      }
    }

    const { dow, time } = _nairobiNow();
    const isWeekend = dow === "saturday" || dow === "sunday";
    if (cfg.modes.includes("weekday_only") && isWeekend) return false;
    if (cfg.modes.includes("weekend_only") && !isWeekend) return false;

    const day = cfg.schedule?.[dow];
    if (!day || day.closed || !day.periods?.length) return false;

    const timeMins = _mins(time);
    const onBreak  = (day.breaks || []).some(
      (b) => b.start && b.end && _mins(b.start) <= timeMins && timeMins < _mins(b.end),
    );
    if (onBreak) return false;

    return day.periods.some(
      (p) => _validPeriod(p) && _mins(p.open) <= timeMins && timeMins < _mins(p.close),
    );
  }

  /** Find next opening within 14 days. Returns a short human string. */
  function _nextOpen(cfg) {
    if (!cfg || cfg.isOnVacation || !cfg.modes) return null;
    if (cfg.modes.includes("open_24_7")) return "Now";
    if (cfg.modes.includes("temporary_closed")) return null;

    for (let i = 0; i <= 14; i++) {
      const d = new Date(new Date().toLocaleString("en-US", { timeZone: "Africa/Nairobi" }));
      d.setDate(d.getDate() + i);
      const dow = DOW_NAMES[d.getDay()];
      const isWeekend = dow === "saturday" || dow === "sunday";
      if (cfg.modes.includes("weekday_only") && isWeekend) continue;
      if (cfg.modes.includes("weekend_only") && !isWeekend) continue;

      const day = cfg.schedule?.[dow];
      if (!day || day.closed || !day.periods?.length) continue;

      const nowMins = i === 0 ? _mins(_nairobiNow().time) : -1;
      const next = day.periods.find((p) => _validPeriod(p) && _mins(p.open) > nowMins);
      if (next) {
        const label = i === 0 ? "Today" : d.toLocaleDateString("en-KE", { weekday: "short", month: "short", day: "numeric" });
        return `${label} at ${next.open}`;
      }
    }
    return null;
  }

  /* ── Status colour & label maps ─────────────────────────────────────── */
  const STATUS_COLORS = {
    available:         "#10b981",
    busy:              "#f59e0b",
    away:              "#6b7280",
    offline:           "#9ca3af",
    on_break:          "#f59e0b",
    closed:            "#ef4444",
    vacation:          "#a8ff58",
    emergency_closure: "#ef4444",
    do_not_disturb:    "#dc2626",
  };

  const STATUS_ICONS = {
    available: "●", busy: "◑", away: "○", offline: "○",
    on_break: "◑", closed: "●", vacation: "✈", emergency_closure: "⚠", do_not_disturb: "⊘",
  };

  /* ══════════════════════════════════════════════════════════════════════
     SokoniAvailability — main class
  ══════════════════════════════════════════════════════════════════════ */
  class SokoniAvailability {
    /**
     * @param {string} providerId  Firestore UID of the provider.
     * @param {object} [opts]      { db: FirestoreInstance }
     */
    constructor(providerId, opts = {}) {
      this.providerId = providerId;
      this._db        = opts.db || (global.db ? global.db : null);
      this._status    = null;    // live status doc (availabilityStatus/{uid})
      this._config    = null;    // full config (providerAvailability/{uid})
      this._unsub     = null;    // Firestore listener unsubscribe
      this._callbacks = [];
    }

    /** Load the lightweight status doc once (no realtime). */
    async load() {
      if (!this._db) throw new Error("Firestore db not available. Pass opts.db.");
      const snap = await this._db.collection("availabilityStatus").doc(this.providerId).get();
      if (snap.exists) this._status = snap.data();
      return this;
    }

    /** Load the full provider config. */
    async loadConfig() {
      if (!this._db) throw new Error("Firestore db not available. Pass opts.db.");
      const snap = await this._db.collection("providerAvailability").doc(this.providerId).get();
      if (snap.exists) this._config = snap.data();
      return this;
    }

    /**
     * Subscribe to real-time status changes.
     * @param {function} cb  Called with the status object whenever it changes.
     */
    subscribe(cb) {
      if (!this._db) return;
      this._callbacks.push(cb);
      if (!this._unsub) {
        this._unsub = this._db.collection("availabilityStatus").doc(this.providerId)
          .onSnapshot((snap) => {
            if (snap.exists) {
              this._status = snap.data();
              this._callbacks.forEach((fn) => fn(this._status));
            }
          });
      }
    }

    /** Stop listening. */
    unsubscribe() {
      if (this._unsub) { this._unsub(); this._unsub = null; }
      this._callbacks = [];
    }

    /** Returns true if the provider is currently open, computed from config. */
    isOpenNow() {
      return _computeIsOpen(this._config || this._status);
    }

    /** Human-readable status label. */
    getLabel() {
      const status = this._status;
      if (!status) return "Unknown";
      const isOpen = this.isOpenNow();
      if (status.isOnVacation) {
        return status.vacationEndDate ? `Away until ${status.vacationEndDate}` : "On Vacation";
      }
      if (!isOpen) {
        const next = _nextOpen(this._config);
        return next ? `Closed · Opens ${next}` : "Closed";
      }
      const labels = {
        busy: "Currently Busy", on_break: "On Break",
        emergency_closure: "Emergency Closure", do_not_disturb: "Do Not Disturb",
      };
      return labels[status.liveStatus] || "Open Now";
    }

    /** Render an availability badge into the given DOM element. */
    renderBadge(el, opts = {}) {
      if (!el) return;
      const status  = (this._status?.liveStatus) || "offline";
      const isOpen  = this.isOpenNow();
      const label   = this.getLabel();
      const color   = STATUS_COLORS[status] || (isOpen ? "#10b981" : "#6b7280");
      const icon    = STATUS_ICONS[status]  || "●";
      const compact = opts.compact || false;

      el.innerHTML = "";   // clear safely

      const badge = document.createElement("span");
      badge.className = "sokoni-avail-badge";
      badge.style.cssText = `
        display: inline-flex; align-items: center; gap: 4px;
        font-size: ${compact ? "11px" : "12px"}; font-weight: 600;
        color: ${color}; white-space: nowrap;
      `;

      const dot = document.createElement("span");
      dot.textContent = icon;
      dot.style.cssText = `
        width: 8px; height: 8px; border-radius: 50%;
        background: ${color}; display: inline-block; flex-shrink: 0;
        ${isOpen ? "animation: sokoni-pulse 2s ease infinite;" : ""}
      `;

      const text = document.createElement("span");
      text.textContent = label;

      if (this._status?.avgResponseMins && isOpen && !compact) {
        const resp = document.createElement("span");
        resp.style.cssText = "font-weight:400; color:#6b7280; margin-left:4px;";
        resp.textContent = `· Responds in ~${this._status.avgResponseMins}m`;
        badge.appendChild(dot);
        badge.appendChild(text);
        badge.appendChild(resp);
      } else {
        badge.appendChild(dot);
        badge.appendChild(text);
      }

      el.appendChild(badge);
      _ensurePulseKeyframes();
    }

    /**
     * Render a full availability card (used in booking flows).
     * Includes next open time and vacation message.
     */
    renderCard(el) {
      if (!el) return;
      const isOpen  = this.isOpenNow();
      const label   = this.getLabel();
      const status  = this._status?.liveStatus || "offline";
      const color   = STATUS_COLORS[status] || (isOpen ? "#10b981" : "#6b7280");

      const card = document.createElement("div");
      card.style.cssText = `
        display: flex; align-items: center; gap: 12px;
        padding: 12px 16px; border-radius: 10px;
        background: ${isOpen ? "#f0fdf4" : "#fef2f2"};
        border: 1px solid ${isOpen ? "#bbf7d0" : "#fecaca"};
        margin: 8px 0;
      `;

      const dot = document.createElement("span");
      dot.style.cssText = `
        width: 12px; height: 12px; border-radius: 50%;
        background: ${color}; flex-shrink: 0;
        ${isOpen ? "animation: sokoni-pulse 2s ease infinite;" : ""}
      `;

      const info = document.createElement("div");
      const main = document.createElement("div");
      main.style.cssText = "font-weight: 600; font-size: 14px;";
      main.textContent = label;

      if (!isOpen && this._status?.isOnVacation && this._config?.vacationMessage) {
        const msg = document.createElement("div");
        msg.style.cssText = "font-size: 12px; color: #6b7280; margin-top: 2px;";
        msg.textContent = this._config.vacationMessage;
        info.appendChild(main);
        info.appendChild(msg);
      } else {
        info.appendChild(main);
      }

      card.appendChild(dot);
      card.appendChild(info);

      el.innerHTML = "";
      el.appendChild(card);
      _ensurePulseKeyframes();
    }
  }

  /* ── CSS pulse animation (injected once) ────────────────────────────── */
  function _ensurePulseKeyframes() {
    if (document.getElementById("__sokoni_avail_css")) return;
    const s = document.createElement("style");
    s.id = "__sokoni_avail_css";
    s.textContent = `
      @keyframes sokoni-pulse {
        0%,100%{ opacity:1; } 50%{ opacity:0.4; }
      }
    `;
    document.head.appendChild(s);
  }

  /* ══════════════════════════════════════════════════════════════════════
     Auto-widget initialisation
     Any element with data-avail-provider="UID" gets a live badge.
  ══════════════════════════════════════════════════════════════════════ */
  function _initWidgets(root) {
    const db = global.db || null;
    if (!db) return;
    (root || document).querySelectorAll("[data-avail-provider]").forEach(async (el) => {
      const pid = el.dataset.availProvider;
      if (!pid) return;
      const compact = el.dataset.availCompact === "true";
      const avail = new SokoniAvailability(pid, { db });
      try {
        await Promise.all([avail.load(), avail.loadConfig()]);
        avail.renderBadge(el, { compact });
        avail.subscribe(() => avail.renderBadge(el, { compact }));
      } catch (_) { /* non-fatal */ }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     Callable CF wrappers (provider admin & buyer actions)
  ══════════════════════════════════════════════════════════════════════ */

  /** Save full availability configuration. */
  async function saveProviderAvailability(config) {
    const fn = firebase.functions().httpsCallable("setProviderAvailability");
    return (await fn(config)).data;
  }

  /** Instantly change live status. status ∈ VALID_STATUSES. */
  async function setLiveStatus(status, untilISO = null) {
    const fn = firebase.functions().httpsCallable("setLiveStatus");
    return (await fn({ status, until: untilISO })).data;
  }

  /**
   * Fetch available appointment slots.
   * @param {string} providerId
   * @param {string} [startDate]  YYYY-MM-DD (defaults to today)
   * @param {number} [days]       Number of days to look ahead (1–30)
   */
  async function getAvailabilitySlots(providerId, startDate, days = 7) {
    const fn = firebase.functions().httpsCallable("getAvailabilitySlots");
    return (await fn({ providerId, startDate, days })).data;
  }

  /**
   * Reserve an appointment slot.
   * @param {object} params { providerId, date, startTime, endTime, hubType, serviceNote, idempotencyKey }
   */
  async function reserveAppointmentSlot(params) {
    if (!params.idempotencyKey) {
      params = { ...params, idempotencyKey: `${params.date}_${params.startTime}_${Date.now()}` };
    }
    const fn = firebase.functions().httpsCallable("reserveSlot");
    return (await fn(params)).data;
  }

  /**
   * Cancel / release a booked slot.
   * @param {object} params { providerId, bookingId, reason }
   */
  async function releaseAppointmentSlot(params) {
    const fn = firebase.functions().httpsCallable("releaseSlot");
    return (await fn(params)).data;
  }

  /**
   * Set vacation mode.
   * @param {object} vac { startDate, endDate, message, autoReactivate }
   */
  async function setVacationMode(vac) {
    const existingConfig = {};
    try {
      const db = global.db;
      const uid = firebase.auth().currentUser?.uid;
      if (db && uid) {
        const snap = await db.collection("providerAvailability").doc(uid).get();
        if (snap.exists) Object.assign(existingConfig, snap.data());
      }
    } catch (_) { /* proceed */ }

    return saveProviderAvailability({
      ...existingConfig,
      vacation: { active: true, ...vac },
    });
  }

  /** Clear vacation mode and return to normal schedule. */
  async function clearVacationMode() {
    const fn = firebase.functions().httpsCallable("setProviderAvailability");
    const db = global.db;
    const uid = firebase.auth().currentUser?.uid;
    let cfg = {};
    if (db && uid) {
      const snap = await db.collection("providerAvailability").doc(uid).get();
      if (snap.exists) cfg = snap.data();
    }
    return (await fn({ ...cfg, vacation: { active: false } })).data;
  }

  /* ══════════════════════════════════════════════════════════════════════
     Availability filter helpers (for search / listing pages)
  ══════════════════════════════════════════════════════════════════════ */

  /**
   * Filter an array of provider objects by current availability.
   * Providers must have a .uid field for the lookup.
   * Optionally fetches live status from Firestore in bulk.
   *
   * @param {Array}   providers  Array of provider objects (must have .uid)
   * @param {string}  filter     'open_now' | 'today' | 'weekend' | '24_7' | 'appointments'
   */
  async function filterByAvailability(providers, filter) {
    const db = global.db;
    if (!db || !providers.length) return providers;

    const uids = providers.map((p) => p.uid || p.id).filter(Boolean);
    const statusDocs = await Promise.all(
      uids.map((uid) => db.collection("availabilityStatus").doc(uid).get()),
    );
    const statusMap = {};
    statusDocs.forEach((snap) => {
      if (snap.exists) statusMap[snap.id] = snap.data();
    });

    return providers.filter((p) => {
      const uid    = p.uid || p.id;
      const status = statusMap[uid];
      if (!status) return false;
      switch (filter) {
        case "open_now":      return status.isOpen;
        case "24_7":          return status.modes?.includes("open_24_7");
        case "appointments":  return !status.isOnVacation;
        case "today": {
          // open now or has future hours today
          if (status.isOpen) return true;
          // Check if there's a future period today
          const cfg = statusMap[uid];
          const { dow, time } = _nairobiNow();
          const day = cfg.schedule?.[dow];
          if (!day || day.closed) return false;
          const t = _mins(time);
          return (day.periods || []).some((per) => _validPeriod(per) && _mins(per.open) > t);
        }
        default: return true;
      }
    });
  }

  /* ══════════════════════════════════════════════════════════════════════
     Slot picker UI builder
     Renders a compact slot selector into a target element.
  ══════════════════════════════════════════════════════════════════════ */
  async function renderSlotPicker(el, providerId, opts = {}) {
    if (!el || !providerId) return;

    el.innerHTML = '<div style="color:#6b7280;font-size:13px;padding:8px;">Loading available slots…</div>';

    let slotsData;
    try {
      slotsData = await getAvailabilitySlots(providerId, opts.startDate, opts.days || 5);
    } catch (e) {
      el.innerHTML = '<div style="color:#ef4444;font-size:13px;padding:8px;">Unable to load slots. Please try again.</div>';
      return;
    }

    const container = document.createElement("div");
    container.style.cssText = "display:flex;flex-direction:column;gap:12px;";

    let hasAnySlot = false;

    for (const day of (slotsData.results || [])) {
      if (!day.available) continue;
      hasAnySlot = true;

      const dateLabel = new Date(day.date + "T12:00:00Z").toLocaleDateString("en-KE", {
        weekday: "short", month: "short", day: "numeric",
      });

      const section = document.createElement("div");
      const heading = document.createElement("div");
      heading.style.cssText = "font-size:12px;font-weight:600;color:#374151;margin-bottom:6px;text-transform:uppercase;letter-spacing:.05em;";
      heading.textContent = dateLabel;
      section.appendChild(heading);

      const grid = document.createElement("div");
      grid.style.cssText = "display:flex;flex-wrap:wrap;gap:6px;";

      for (const slot of (day.slots || [])) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.textContent = slot.startTime;
        btn.disabled = !slot.available;
        btn.style.cssText = `
          padding: 6px 12px; border-radius: 8px; font-size: 13px; font-weight: 500;
          border: 1.5px solid ${slot.available ? "#2563eb" : "#e5e7eb"};
          background: ${slot.available ? "#eff6ff" : "#f9fafb"};
          color: ${slot.available ? "#2563eb" : "#9ca3af"};
          cursor: ${slot.available ? "pointer" : "not-allowed"};
          transition: background .15s, border-color .15s;
        `;
        if (slot.available) {
          btn.addEventListener("mouseenter", () => {
            btn.style.background = "#2563eb";
            btn.style.color = "#fff";
          });
          btn.addEventListener("mouseleave", () => {
            btn.style.background = "#eff6ff";
            btn.style.color = "#2563eb";
          });
          btn.addEventListener("click", () => {
            el.querySelectorAll(".sokoni-slot-btn-selected").forEach((b) => {
              b.style.background = "#eff6ff";
              b.style.color = "#2563eb";
              b.classList.remove("sokoni-slot-btn-selected");
            });
            btn.style.background = "#1d4ed8";
            btn.style.color = "#fff";
            btn.classList.add("sokoni-slot-btn-selected");
            if (opts.onSelect) {
              opts.onSelect({ date: day.date, startTime: slot.startTime, endTime: slot.endTime });
            }
          });
        }
        grid.appendChild(btn);
      }
      section.appendChild(grid);
      container.appendChild(section);
    }

    if (!hasAnySlot) {
      container.innerHTML = `<div style="color:#6b7280;font-size:13px;padding:8px;text-align:center;">
        No available slots in the next ${opts.days || 5} days.
      </div>`;
    }

    el.innerHTML = "";
    el.appendChild(container);
  }

  /* ── DOMContentLoaded auto-init ─────────────────────────────────────── */
  function _boot() {
    // Delay init to let Firebase SDK fully load
    setTimeout(() => _initWidgets(), 800);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", _boot);
  } else {
    _boot();
  }

  /* ── Public API ─────────────────────────────────────────────────────── */
  global.SokoniAvailability      = SokoniAvailability;
  global.saveProviderAvailability  = saveProviderAvailability;
  global.setLiveStatus             = setLiveStatus;
  global.getAvailabilitySlots      = getAvailabilitySlots;
  global.reserveAppointmentSlot    = reserveAppointmentSlot;
  global.releaseAppointmentSlot    = releaseAppointmentSlot;
  global.setVacationMode           = setVacationMode;
  global.clearVacationMode         = clearVacationMode;
  global.filterByAvailability      = filterByAvailability;
  global.renderSlotPicker          = renderSlotPicker;

}(window));
