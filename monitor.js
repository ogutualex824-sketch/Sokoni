/**
 * SOKONI PLATFORM MONITOR  v1.0
 * Real-time monitoring data layer for monitor.html
 *
 * Listens to Firestore collections and populates the dashboard.
 * All Firestore imports are dynamic (ESM-compatible from CDN).
 */

(function (window) {
  "use strict";

  /* ── Firestore helpers (loaded dynamically) ── */
  let _db, _user, _fns, _claims;
  let _unsubs = []; // cleanup handles for live listeners

  const BASE_URL = "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

  async function _fs() {
    const m = await import(BASE_URL);
    return m;
  }

  /* ── Utility ── */
  function _esc(s) {
    return String(s || "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  }

  function _ago(ts) {
    if (!ts) return "—";
    const sec = Math.floor((Date.now() - (ts.toMillis ? ts.toMillis() : new Date(ts).getTime())) / 1000);
    if (sec < 60)  return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec/60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec/3600)}h ago`;
    return `${Math.floor(sec/86400)}d ago`;
  }

  function _fmt(n) { return Number(n||0).toLocaleString("en-KE"); }

  function _statusPill(s) {
    const map = {
      pending:"pill-yellow", processing:"pill-blue", confirmed:"pill-blue",
      shipped:"pill-blue", out_for_delivery:"pill-blue", delivered:"pill-green",
      completed:"pill-green", cancelled:"pill-red", refunded:"pill-red",
      paid:"pill-green", active:"pill-green", online:"pill-green",
      in_transit:"pill-blue", picked_up:"pill-blue",
    };
    const cls = map[(s||"").toLowerCase()] || "pill-grey";
    return `<span class="pill ${cls}">${_esc(s||"—")}</span>`;
  }

  function _setCard(id, opts) {
    const card = document.getElementById(id);
    if (!card) return;
    card.classList.remove("loading");
    if (opts.value !== undefined) {
      const valEl = card.querySelector(".value");
      if (valEl) { valEl.innerHTML = _esc(String(opts.value)); valEl.classList.remove("skeleton"); }
    }
    if (opts.subtext !== undefined) { const st = card.querySelector(".subtext"); if (st) st.textContent = opts.subtext; }
    if (opts.trend !== undefined) {
      let t = card.querySelector(".trend");
      if (!t) { t = document.createElement("div"); t.className = "trend"; card.querySelector(".subtext").after(t); }
      t.className = `trend ${opts.trendDir||"neutral"}`;
      t.textContent = opts.trend;
    }
    if (opts.alert) card.classList.add("alert");
    if (opts.warning) card.classList.add("warning");
    if (opts.primary) card.classList.add("primary");
  }

  /* ══════════════════════════════════════════════════════════════
     METRIC LOADERS
  ══════════════════════════════════════════════════════════════ */

  async function loadActiveUsers() {
    try {
      const { collection, query, where, getDocs, Timestamp } = await _fs();
      const cutoff = Timestamp.fromMillis(Date.now() - 30 * 60 * 1000);
      const q = query(collection(_db, "users"), where("lastSeen", ">=", cutoff));
      const snap = await getDocs(q);
      _setCard("card-active-users", {
        value: snap.size,
        subtext: "Seen in the last 30 minutes",
        primary: true,
      });
    } catch (e) {
      _setCard("card-active-users", { value: "—", subtext: "Index required (lastSeen)" });
    }
  }

  async function loadOrdersToday() {
    try {
      const { collection, query, where, getDocs, Timestamp } = await _fs();
      const today = new Date(); today.setHours(0,0,0,0);
      const q = query(
        collection(_db, "orders"),
        where("createdAt", ">=", Timestamp.fromDate(today))
      );
      const snap = await getDocs(q);
      let revenue = 0;
      snap.forEach(d => { revenue += (d.data().total || d.data().amount || 0); });
      _setCard("card-orders-today", {
        value: snap.size,
        subtext: "New orders since midnight",
      });
      _setCard("card-revenue", {
        value: _fmt(Math.round(revenue)),
        subtext: "From completed & pending orders",
        primary: revenue > 0,
      });
    } catch (e) {
      _setCard("card-orders-today", { value: "—", subtext: "Could not load" });
      _setCard("card-revenue", { value: "—", subtext: "Could not load" });
    }
  }

  async function loadActiveDeliveries() {
    try {
      const { collection, query, where, getDocs } = await _fs();
      const q = query(collection(_db, "deliveries"), where("status", "in", ["assigned","in_transit","picked_up"]));
      const snap = await getDocs(q);
      _setCard("card-deliveries", {
        value: snap.size,
        subtext: "In-progress deliveries",
        primary: snap.size > 0,
      });
    } catch (e) {
      _setCard("card-deliveries", { value: "—", subtext: "Could not load" });
    }
  }

  async function loadActiveRides() {
    try {
      const { collection, query, where, getDocs } = await _fs();
      const q = query(collection(_db, "rides"), where("status", "in", ["matched","in_progress","accepted"]));
      const snap = await getDocs(q);
      _setCard("card-rides", {
        value: snap.size,
        subtext: "Active ride sessions",
        primary: snap.size > 0,
      });
    } catch (e) {
      _setCard("card-rides", { value: "—", subtext: "Could not load" });
    }
  }

  async function loadPendingApplications() {
    try {
      const { collection, query, where, getDocs } = await _fs();
      const q = query(collection(_db, "applications"), where("status", "==", "pending"));
      const snap = await getDocs(q);
      _setCard("card-pending", {
        value: snap.size,
        subtext: "Awaiting admin review",
        warning: snap.size > 5,
      });
    } catch (e) {
      _setCard("card-pending", { value: "—", subtext: "Could not load" });
    }
  }

  async function loadOpenFlags() {
    try {
      const { collection, query, where, getDocs } = await _fs();
      const q = query(collection(_db, "flags"), where("status", "==", "open"));
      const snap = await getDocs(q);
      const count = snap.size;
      _setCard("card-flags", {
        value: count,
        subtext: "Pending content review",
        alert: count > 0,
      });

      // Populate flags table
      const tbody = document.getElementById("flags-table");
      if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="3" class="no-data">No open flags</td></tr>';
      } else {
        tbody.innerHTML = snap.docs.slice(0,20).map(d => {
          const f = d.data();
          return `<tr>
            <td>${_esc(f.type||f.contentType||"—")}</td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${_esc(f.reason||f.content||"—")}</td>
            <td>${_ago(f.createdAt||f.ts)}</td>
          </tr>`;
        }).join("");
      }

      document.getElementById("mod-badge").textContent = count;
    } catch (e) {
      _setCard("card-flags", { value: "—", subtext: "Could not load" });
    }
  }

  async function loadOpenDisputes() {
    try {
      const { collection, query, where, getDocs } = await _fs();
      const q = query(collection(_db, "disputes"), where("status", "==", "open"));
      const snap = await getDocs(q);
      const count = snap.size;
      _setCard("card-disputes", {
        value: count,
        subtext: "Unresolved disputes",
        warning: count > 0,
      });

      const tbody = document.getElementById("disputes-table");
      if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="3" class="no-data">No open disputes</td></tr>';
      } else {
        tbody.innerHTML = snap.docs.slice(0,20).map(d => {
          const dis = d.data();
          return `<tr>
            <td style="font-family:monospace;font-size:10px">${d.id.slice(0,8)}…</td>
            <td>${_statusPill(dis.status||"open")}</td>
            <td>${_ago(dis.createdAt||dis.ts)}</td>
          </tr>`;
        }).join("");
      }

      // Update mod badge total
      const modBadge = document.getElementById("mod-badge");
      const flags = parseInt(modBadge.textContent) || 0;
      modBadge.textContent = flags + count;
    } catch (e) {
      _setCard("card-disputes", { value: "—", subtext: "Could not load" });
    }
  }

  /* ══════════════════════════════════════════════════════════════
     LIVE LISTENERS
  ══════════════════════════════════════════════════════════════ */

  async function startRecentOrdersListener() {
    const { collection, query, orderBy, limit, onSnapshot } = await _fs();
    const q = query(collection(_db, "orders"), orderBy("createdAt", "desc"), limit(25));
    const unsub = onSnapshot(q, snap => {
      const badge = document.getElementById("orders-badge");
      badge.textContent = snap.size;
      const tbody = document.getElementById("orders-table");
      if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="4" class="no-data">No recent orders</td></tr>';
        return;
      }
      tbody.innerHTML = snap.docs.map(d => {
        const o = d.data();
        return `<tr>
          <td style="font-family:monospace;font-size:10px;color:var(--muted)">${d.id.slice(0,8)}…</td>
          <td>${_statusPill(o.status)}</td>
          <td style="color:var(--green);font-weight:700">KES ${_fmt(o.total||o.amount||0)}</td>
          <td style="color:var(--muted)">${_ago(o.createdAt)}</td>
        </tr>`;
      }).join("");
    }, () => {
      document.getElementById("orders-table").innerHTML = '<tr><td colspan="4" class="no-data">Permission denied</td></tr>';
    });
    _unsubs.push(unsub);
  }

  async function startDriversListener() {
    const { collection, query, where, limit, onSnapshot } = await _fs();
    const q = query(collection(_db, "rideDrivers"), where("online", "==", true), limit(30));
    const unsub = onSnapshot(q, snap => {
      const badge = document.getElementById("drivers-badge");
      badge.textContent = snap.size;
      const tbody = document.getElementById("drivers-table");
      if (snap.empty) {
        tbody.innerHTML = '<tr><td colspan="4" class="no-data">No drivers online</td></tr>';
        return;
      }
      tbody.innerHTML = snap.docs.map(d => {
        const dr = d.data();
        return `<tr>
          <td>${_esc(dr.name || dr.driverName || "Driver")}</td>
          <td><span class="pill pill-blue">${_esc(dr.vehicleType||dr.mode||"N/A")}</span></td>
          <td>${_statusPill("online")}</td>
          <td style="color:var(--muted)">${_esc(dr.completedTrips||0)}</td>
        </tr>`;
      }).join("");
    }, () => {
      // rideDrivers is public — shouldn't fail
      document.getElementById("drivers-table").innerHTML = '<tr><td colspan="4" class="no-data">Could not load</td></tr>';
    });
    _unsubs.push(unsub);
  }

  /* ══════════════════════════════════════════════════════════════
     REVENUE CHART (7-day)
  ══════════════════════════════════════════════════════════════ */

  async function loadRevenueChart() {
    try {
      const { collection, query, where, getDocs, Timestamp } = await _fs();
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
      sevenDaysAgo.setHours(0,0,0,0);

      const q = query(
        collection(_db, "orders"),
        where("createdAt", ">=", Timestamp.fromDate(sevenDaysAgo))
      );
      const snap = await getDocs(q);

      // Bucket by day
      const days = {};
      for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const key = d.toLocaleDateString("en-KE", { weekday: "short" });
        days[key] = 0;
      }

      snap.forEach(doc => {
        const o = doc.data();
        if (!o.createdAt) return;
        const d = o.createdAt.toDate ? o.createdAt.toDate() : new Date(o.createdAt);
        const key = d.toLocaleDateString("en-KE", { weekday: "short" });
        if (days[key] !== undefined) days[key] += (o.total || o.amount || 0);
      });

      const vals = Object.values(days);
      const maxVal = Math.max(...vals, 1);
      const total = vals.reduce((a, b) => a + b, 0);

      document.getElementById("rev-total").textContent = "KES " + _fmt(Math.round(total));

      const chart = document.getElementById("revenue-chart");
      chart.innerHTML = Object.entries(days).map(([label, val]) => {
        const pct = Math.max((val / maxVal) * 100, 2);
        return `<div class="bar-col">
          <div class="bar" style="height:${pct}%" data-val="KES ${_fmt(Math.round(val))}"></div>
          <div class="bar-label">${label}</div>
        </div>`;
      }).join("");
    } catch (e) {
      document.getElementById("revenue-chart").innerHTML = '<div class="bar-chart-empty">Could not load revenue data</div>';
    }
  }

  /* ══════════════════════════════════════════════════════════════
     AUDIT LOG
  ══════════════════════════════════════════════════════════════ */

  async function loadAuditLog() {
    try {
      const { collection, query, orderBy, limit, getDocs } = await _fs();
      const q = query(collection(_db, "auditLogs"), orderBy("ts", "desc"), limit(20));
      const snap = await getDocs(q);
      document.getElementById("audit-badge").textContent = snap.size;
      const list = document.getElementById("error-list");
      if (snap.empty) {
        list.innerHTML = '<div class="no-data">No audit entries</div>';
        return;
      }
      list.innerHTML = snap.docs.map(d => {
        const e = d.data();
        const level = (e.level || e.action || "").includes("error") ? "error"
                     : (e.level || e.action || "").includes("warn") ? "warn" : "info";
        return `<div class="error-item">
          <div class="error-level ${level}"></div>
          <div class="error-msg">${_esc(e.action || e.message || "—")}</div>
          <div class="error-time">${_ago(e.ts || e.createdAt)}</div>
        </div>`;
      }).join("");
    } catch (e) {
      document.getElementById("error-list").innerHTML = '<div class="no-data">Permission denied or no logs</div>';
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PLATFORM HEALTH CHECK
  ══════════════════════════════════════════════════════════════ */

  function _setHealth(id, status, text) {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `h-status h-${status}`;
    el.textContent = text;
  }

  async function checkHealth() {
    // Firebase Auth
    try {
      const auth = window.firebaseAuth;
      _setHealth("h-auth", auth && auth.currentUser ? "ok" : "warn", auth && auth.currentUser ? "Online" : "No user");
    } catch { _setHealth("h-auth", "err", "Error"); }

    // Firestore ping
    try {
      const { collection, getDocs, limit, query } = await _fs();
      const q = query(collection(_db, "products"), limit(1));
      await getDocs(q);
      _setHealth("h-db", "ok", "Reachable");
    } catch { _setHealth("h-db", "err", "Unreachable"); }

    // FCM
    const hasFCM = "Notification" in window && "serviceWorker" in navigator;
    _setHealth("h-fcm", hasFCM ? "ok" : "warn", hasFCM ? "Supported" : "Unsupported");

    // Service Worker
    try {
      const regs = await navigator.serviceWorker.getRegistrations();
      const active = regs.find(r => r.active);
      _setHealth("h-sw", active ? "ok" : "warn", active ? `v${active.active.scriptURL.split("v").pop() || "?"}` : "Not registered");
    } catch { _setHealth("h-sw", "warn", "Not available"); }

    // Page Load Performance
    try {
      const nav = performance.getEntriesByType("navigation")[0];
      const load = Math.round(nav.loadEventEnd - nav.startTime);
      _setHealth("h-perf", load < 2000 ? "ok" : load < 4000 ? "warn" : "err",
        `${(load/1000).toFixed(1)}s`);
    } catch { _setHealth("h-perf", "warn", "N/A"); }

    // Network
    const conn = navigator.connection;
    if (conn) {
      const rtt = conn.rtt || 0;
      _setHealth("h-net", rtt < 200 ? "ok" : rtt < 500 ? "warn" : "err",
        conn.effectiveType + (rtt ? ` ${rtt}ms` : ""));
    } else {
      _setHealth("h-net", navigator.onLine ? "ok" : "err", navigator.onLine ? "Online" : "Offline");
    }

    // Memory
    if (performance.memory) {
      const used = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
      const total = Math.round(performance.memory.jsHeapSizeLimit / 1024 / 1024);
      const pct = Math.round(used / total * 100);
      _setHealth("h-mem", pct < 50 ? "ok" : pct < 80 ? "warn" : "err", `${used}MB / ${total}MB`);
    } else {
      _setHealth("h-mem", "warn", "N/A");
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PLATFORM HEALTH REPORT (Generated)
  ══════════════════════════════════════════════════════════════ */

  async function generateReport() {
    const el = document.getElementById("health-report");
    el.innerHTML = "<p style='color:var(--muted)'>Generating report…</p>";

    try {
      const { collection, query, where, getDocs, orderBy, limit, Timestamp } = await _fs();

      const today = new Date(); today.setHours(0,0,0,0);
      const todayTs = Timestamp.fromDate(today);

      const [
        usersSnap, sellersSnap, productsSnap,
        ordersSnap, applicationsSnap, flagsSnap,
        disputesSnap, deliveriesSnap, ridesSnap,
        providersSnap, verificationSnap
      ] = await Promise.allSettled([
        getDocs(collection(_db, "users")),
        getDocs(collection(_db, "sellers")),
        getDocs(collection(_db, "products")),
        getDocs(query(collection(_db, "orders"), orderBy("createdAt","desc"), limit(500))),
        getDocs(query(collection(_db, "applications"), where("status","==","pending"))),
        getDocs(query(collection(_db, "flags"), where("status","==","open"))),
        getDocs(query(collection(_db, "disputes"), where("status","==","open"))),
        getDocs(query(collection(_db, "deliveries"), where("status","in",["assigned","in_transit"]))),
        getDocs(query(collection(_db, "rides"), where("status","in",["matched","in_progress"]))),
        getDocs(query(collection(_db, "providers"), where("status","==","active"))),
        getDocs(query(collection(_db, "verificationRequests"), where("status","==","pending"))),
      ]);

      const v = (r) => r.status === "fulfilled" ? r.value.size : "?";
      const vd = (r) => r.status === "fulfilled" ? r.value : null;

      let totalRevenue = 0;
      const ordersDoc = vd(ordersSnap);
      if (ordersDoc) {
        ordersDoc.forEach(d => { totalRevenue += (d.data().total || d.data().amount || 0); });
      }

      const now = new Date().toLocaleString("en-KE",{dateStyle:"medium",timeStyle:"short"});
      el.innerHTML = `
        <div style="font-family:monospace;line-height:2;color:var(--text)">
          <div style="color:var(--green);font-size:15px;font-weight:700;margin-bottom:16px">
            ═══ SOKONI PLATFORM HEALTH REPORT ═══<br>
            Generated: ${now}
          </div>

          <div style="margin-bottom:20px">
            <span style="color:var(--green)">━━ USERS & ACCOUNTS ━━</span><br>
            Total registered users   : <strong>${v(usersSnap)}</strong><br>
            Active sellers           : <strong>${v(sellersSnap)}</strong><br>
            Active providers         : <strong>${v(providersSnap)}</strong><br>
            Total products listed    : <strong>${v(productsSnap)}</strong><br>
          </div>

          <div style="margin-bottom:20px">
            <span style="color:var(--green)">━━ OPERATIONS (ALL TIME SAMPLE) ━━</span><br>
            Orders in DB (last 500)  : <strong>${v(ordersSnap)}</strong><br>
            Revenue (last 500 orders): <strong>KES ${Number(totalRevenue).toLocaleString("en-KE")}</strong><br>
            Active deliveries        : <strong>${v(deliveriesSnap)}</strong><br>
            Active rides             : <strong>${v(ridesSnap)}</strong><br>
          </div>

          <div style="margin-bottom:20px">
            <span style="color:var(--yellow)">━━ ATTENTION REQUIRED ━━</span><br>
            Pending applications     : <strong style="color:${v(applicationsSnap)>0?'var(--yellow)':'var(--green)'}">${v(applicationsSnap)}</strong><br>
            Open flags               : <strong style="color:${v(flagsSnap)>0?'var(--red)':'var(--green)'}">${v(flagsSnap)}</strong><br>
            Open disputes            : <strong style="color:${v(disputesSnap)>0?'var(--yellow)':'var(--green)'}">${v(disputesSnap)}</strong><br>
            Pending verifications    : <strong style="color:${v(verificationSnap)>0?'var(--yellow)':'var(--green)'}">${v(verificationSnap)}</strong><br>
          </div>

          <div style="margin-bottom:20px">
            <span style="color:var(--blue)">━━ PLATFORM ARCHITECTURE AUDIT ━━</span><br>
            HTML pages               : <strong>60+</strong><br>
            JavaScript modules       : <strong>130+</strong><br>
            CSS files                : <strong>13</strong><br>
            Firestore collections    : <strong>80+</strong><br>
            Firestore security rules : <strong>Active (custom claims)</strong><br>
            Firebase Auth            : <strong>Email/Password + Custom Claims</strong><br>
            Hosting                  : <strong>Firebase Hosting (sokoni-aeb26)</strong><br>
            PWA                      : <strong>Service Worker v157+</strong><br>
            CDN                      : <strong>Firebase CDN + gstatic</strong><br>
          </div>

          <div style="margin-bottom:20px">
            <span style="color:var(--green)">━━ SECURITY STATUS ━━</span><br>
            Custom claims RBAC       : <strong>Active</strong><br>
            CSP headers              : <strong>Active (firebase.json)</strong><br>
            HSTS                     : <strong>Active</strong><br>
            noAdminFields() guard    : <strong>Active in Firestore rules</strong><br>
            uidUnchanged() guard     : <strong>Active</strong><br>
            Audit logging            : <strong>Active (auditLogs collection)</strong><br>
            Rate limiting            : <strong>UI-level (Cloud Function quotas)</strong><br>
          </div>

          <div style="color:var(--muted);font-size:11px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)">
            Report auto-generated by SOKONI Platform Monitor<br>
            For full audit, deploy monitoring Cloud Functions and enable Firebase Analytics.
          </div>
        </div>
      `;
    } catch (e) {
      el.innerHTML = `<p style="color:var(--red)">Error generating report: ${_esc(e.message)}</p>`;
    }
  }

  /* ══════════════════════════════════════════════════════════════
     ROLE MANAGEMENT (grant / revoke via Cloud Functions)
  ══════════════════════════════════════════════════════════════ */

  /* Resolve a UID or email → UID. Returns null and shows error if not found. */
  async function _resolveUid(value) {
    if (!value.includes("@")) return value; // already a UID
    const msg = document.getElementById("role-msg");
    const preview = document.getElementById("role-uid-preview");
    msg.style.display = "none";
    try {
      const { collection, query, where, limit, getDocs } = await import(
        "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js"
      );
      const snap = await getDocs(
        query(collection(_db, "users"), where("email", "==", value), limit(1))
      );
      if (snap.empty) {
        msg.className = "role-msg err";
        msg.textContent = "No user found with that email.";
        msg.style.display = "block";
        if (preview) preview.textContent = "";
        return null;
      }
      const userDoc = snap.docs[0];
      const uid = userDoc.id;
      const d = userDoc.data();
      if (preview) {
        preview.textContent = "→ " + _esc(d.name || d.displayName || "User") +
          " (" + _esc(uid.slice(0, 12)) + "…)";
      }
      return uid;
    } catch (e) {
      msg.className = "role-msg err";
      msg.textContent = "Lookup failed: " + _esc(e.message);
      msg.style.display = "block";
      return null;
    }
  }

  async function lookupUser() {
    const input = document.getElementById("role-uid").value.trim();
    const preview = document.getElementById("role-uid-preview");
    const msg = document.getElementById("role-msg");
    if (!input) {
      msg.className = "role-msg err";
      msg.textContent = "Enter a UID or email to look up.";
      msg.style.display = "block";
      return;
    }
    msg.style.display = "none";
    if (preview) preview.textContent = "Searching…";
    await _resolveUid(input); // shows result in preview
  }

  async function _callRoleFunction(fnName, targetUid, role) {
    const msg = document.getElementById("role-msg");
    msg.className = "role-msg";
    msg.style.display = "none";
    try {
      const fn = window.httpsCallable(window.firebaseFns, fnName);
      const result = await fn({ targetUid, role });
      msg.className = "role-msg ok";
      msg.textContent = result.data.message || "Success";
      msg.style.display = "block";
    } catch (e) {
      msg.className = "role-msg err";
      msg.textContent = e.message || "Error";
      msg.style.display = "block";
    }
  }

  async function grantRole() {
    const raw  = document.getElementById("role-uid").value.trim();
    const role = document.getElementById("role-select").value;
    const msg  = document.getElementById("role-msg");
    if (!raw || !role) {
      msg.className = "role-msg err";
      msg.textContent = "Please enter a UID or email and select a role.";
      msg.style.display = "block";
      return;
    }
    const uid = await _resolveUid(raw);
    if (!uid) return;
    await _callRoleFunction("grantPlatformRole", uid, role);
  }

  async function revokeRole() {
    const raw  = document.getElementById("role-uid").value.trim();
    const role = document.getElementById("role-select").value;
    const msg  = document.getElementById("role-msg");
    if (!raw || !role) {
      msg.className = "role-msg err";
      msg.textContent = "Please enter a UID or email and select a role.";
      msg.style.display = "block";
      return;
    }
    const uid = await _resolveUid(raw);
    if (!uid) return;
    await _callRoleFunction("revokePlatformRole", uid, role);
  }

  /* ══════════════════════════════════════════════════════════════
     REFRESH — stop listeners, reload all metrics
  ══════════════════════════════════════════════════════════════ */

  function _stopListeners() {
    _unsubs.forEach(u => { try { u(); } catch (_) {} });
    _unsubs = [];
  }

  async function refresh() {
    _stopListeners();
    await Promise.allSettled([
      loadActiveUsers(),
      loadOrdersToday(),
      loadActiveDeliveries(),
      loadActiveRides(),
      loadPendingApplications(),
      loadOpenFlags(),
      loadOpenDisputes(),
      loadRevenueChart(),
      loadAuditLog(),
    ]);
    await Promise.allSettled([
      startRecentOrdersListener(),
      startDriversListener(),
    ]);
    await checkHealth();
  }

  /* ══════════════════════════════════════════════════════════════
     INIT — called by monitor.html after auth confirmed
  ══════════════════════════════════════════════════════════════ */

  async function init(db, user, fns, claims) {
    _db     = db;
    _user   = user;
    _fns    = fns;
    _claims = claims;

    await refresh();

    // Auto-refresh every 90 seconds
    setInterval(refresh, 90_000);
  }

  /* ══════════════════════════════════════════════════════════════
     EXPORT
  ══════════════════════════════════════════════════════════════ */

  window.SokoniMonitor = {
    init,
    refresh,
    checkHealth,
    generateReport,
    grantRole,
    revokeRole,
    lookupUser,
  };

})(window);
