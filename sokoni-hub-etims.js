/* ═══════════════════════════════════════════════════════════════════
   SOKONI Hub eTIMS Frontend SDK  v1.0
   sokoni-hub-etims.js

   Covers hub management, operational document generation,
   hub tax invoices, audit trail, and hub stats.

   Usage: include via <script src="sokoni-hub-etims.js"></script>
   Then call window.SokoniHubETIMS.* methods.
═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  /* ── Firebase callable helper ─────────────────────────────────── */
  function _call(name, data) {
    if (typeof firebase === "undefined" || !firebase.functions)
      return Promise.reject(new Error("Firebase not initialised"));
    return firebase.functions().httpsCallable(name)(data).then(r => r.data);
  }

  async function _token() {
    const user = firebase.auth?.().currentUser;
    if (!user) throw new Error("Not signed in");
    return user.getIdToken();
  }

  /* ── Toast ────────────────────────────────────────────────────── */
  function _toast(msg, ok) {
    if (typeof SokoniUI !== "undefined" && SokoniUI.toast) {
      SokoniUI.toast(msg, ok ? "success" : "error");
    } else {
      console[ok ? "log" : "warn"]("[SokoniHubETIMS]", msg);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     HUB MANAGEMENT
  ══════════════════════════════════════════════════════════════ */

  function createHub(data)          { return _call("hubCreate",         data); }
  function updateHub(data)          { return _call("hubUpdate",          data); }
  function getHubProfile(hubId)     { return _call("hubGetProfile",      { hubId }); }
  function updateTaxConfig(hubId, taxConfig) { return _call("hubUpdateTaxConfig", { hubId, taxConfig }); }

  function registerHubEtims({ hubId, deviceSerial, taxpayerSecret, kraPin, branchId }) {
    return _call("hubRegisterEtims", { hubId, deviceSerial, taxpayerSecret, kraPin, branchId });
  }

  /* ══════════════════════════════════════════════════════════════
     OPERATIONAL DOCUMENTS
  ══════════════════════════════════════════════════════════════ */

  /**
   * Generate any operational document.
   * docType: pickup_receipt | warehouse_receipt | dispatch_note | return_confirmation | transfer_note
   */
  function generateDocument(hubId, docType, data) {
    return _call("hubGenerateDocument", { hubId, docType, ...data });
  }

  /** Convenience wrappers for each document type */
  const generatePickupReceipt      = (hubId, d) => generateDocument(hubId, "pickup_receipt",      d);
  const generateWarehouseReceipt   = (hubId, d) => generateDocument(hubId, "warehouse_receipt",   d);
  const generateDispatchNote       = (hubId, d) => generateDocument(hubId, "dispatch_note",       d);
  const generateReturnConfirmation = (hubId, d) => generateDocument(hubId, "return_confirmation", d);
  const generateTransferNote       = (hubId, d) => generateDocument(hubId, "transfer_note",       d);

  function getDocuments(filters) { return _call("hubGetDocuments", filters); }

  /* ══════════════════════════════════════════════════════════════
     INVOICES (selling hubs)
  ══════════════════════════════════════════════════════════════ */

  function generateInvoice(hubId, orderId, buyerKraPin) {
    return _call("hubGenerateInvoice", { hubId, orderId, buyerKraPin });
  }

  function resubmitInvoice(invoiceId) {
    return _call("hubResubmitInvoice", { invoiceId });
  }

  /* ══════════════════════════════════════════════════════════════
     AUDIT TRAIL
  ══════════════════════════════════════════════════════════════ */

  function getAuditTrail(orderId) { return _call("hubGetAuditTrail", { orderId }); }

  /* ══════════════════════════════════════════════════════════════
     STATS
  ══════════════════════════════════════════════════════════════ */

  function getHubStats(hubId)   { return _call("hubGetStats",         { hubId }); }
  function getAdminStats()      { return _call("hubAdminGetAllStats",  {}); }

  /* ══════════════════════════════════════════════════════════════
     DOCUMENT DOWNLOAD
  ══════════════════════════════════════════════════════════════ */

  /** Open a hub document (or hub invoice) HTML in a new tab */
  async function downloadDocument(docId, isInvoice) {
    try {
      const token = await _token();
      const base  = global.SOKONI_CF_BASE || "https://us-central1-sokoni-aeb26.cloudfunctions.net";
      const path  = isInvoice ? "etimsDownloadReceipt" : "hubDownloadDocument";
      const url   = `${base}/${path}?id=${encodeURIComponent(docId)}`;
      const resp  = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html  = await resp.text();
      const blob  = new Blob([html], { type: "text/html" });
      const obj   = URL.createObjectURL(blob);
      const win   = global.open(obj, "_blank");
      if (!win) {
        const a  = document.createElement("a");
        a.href   = obj;
        a.download = `sokoni-hub-doc-${docId}.html`;
        a.click();
      }
      setTimeout(() => URL.revokeObjectURL(obj), 60_000);
    } catch (e) {
      _toast("Could not open document: " + e.message, false);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     UI HELPERS
  ══════════════════════════════════════════════════════════════ */

  const DOC_TYPE_LABELS = {
    pickup_receipt:      "Pickup Receipt",
    warehouse_receipt:   "Warehouse Receipt",
    dispatch_note:       "Dispatch Note",
    return_confirmation: "Return Confirmation",
    transfer_note:       "Transfer Note",
  };

  const DOC_ICONS = {
    pickup_receipt:      "📦",
    warehouse_receipt:   "🏭",
    dispatch_note:       "🚚",
    return_confirmation: "↩",
    transfer_note:       "🔄",
  };

  function docTypeLabel(type) { return DOC_TYPE_LABELS[type] || type; }
  function docTypeIcon(type)  { return DOC_ICONS[type]       || "📄"; }

  function hubTypeBadge(type) {
    const map = {
      logistics:   { label: "Logistics",   css: "chip-blue"  },
      selling:     { label: "Selling",     css: "chip-ok"    },
      marketplace: { label: "Marketplace", css: "chip-warn"  },
      hybrid:      { label: "Hybrid",      css: "chip-purple"},
    };
    const t = map[type] || { label: type, css: "chip-muted" };
    return `<span class="chip ${t.css}">${t.label}</span>`;
  }

  function statusBadge(status) {
    const map = {
      accepted:           '<span class="chip chip-ok">✓ KRA Accepted</span>',
      pending_submission: '<span class="chip chip-warn">⏳ Queued</span>',
      draft:              '<span class="chip chip-muted">Draft</span>',
      failed:             '<span class="chip chip-fail">✕ Failed</span>',
      issued:             '<span class="chip chip-ok">Issued</span>',
      voided:             '<span class="chip chip-muted">Voided</span>',
    };
    return map[status] || `<span class="chip chip-muted">${_esc(status)}</span>`;
  }

  function formatKES(n) {
    return "KES " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * Render a list of hub documents into a table.
   * @param {string}   containerId
   * @param {Array}    docs
   * @param {Object}   opts  { showHub, onDownload }
   */
  function renderDocumentTable(containerId, docs, opts = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!docs || !docs.length) {
      el.innerHTML = '<p class="etims-empty">No documents found.</p>';
      return;
    }
    const rows = docs.map(d => `<tr>
      <td>${docTypeIcon(d.docType)} ${docTypeLabel(d.docType)}</td>
      <td><code style="font-size:11px">${_esc(d.docNumber)}</code></td>
      ${opts.showHub ? `<td>${_esc(d.hubId)}</td>` : ""}
      <td>${d.orderId ? _esc(d.orderId.slice(-10)) : "—"}</td>
      <td>${new Date(d.issuedAt).toLocaleDateString("en-KE")}</td>
      <td>${statusBadge(d.status)}</td>
      <td>
        ${d.htmlUrl
          ? `<a class="etims-link" href="${_esc(d.htmlUrl)}" target="_blank">Download</a>`
          : `<button class="etims-link-btn" onclick="SokoniHubETIMS.downloadDocument('${d.docId}')">Download</button>`}
      </td>
    </tr>`).join("");

    el.innerHTML = `<table class="etims-table">
      <thead><tr>
        <th>Type</th><th>Ref #</th>
        ${opts.showHub ? "<th>Hub</th>" : ""}
        <th>Order</th><th>Date</th><th>Status</th><th>Actions</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
  }

  /**
   * Render audit trail timeline into a container.
   */
  function renderAuditTimeline(containerId, trail) {
    const el = document.getElementById(containerId);
    if (!el || !trail) return;

    const icons = { order: "🛒", document: "📄", invoice: "🧾", delivery: "🚚" };
    const colors = { order: "#4488ff", document: "#ffb400", invoice: "#71ff00", delivery: "#aa44ff" };

    const items = (trail.timeline || []).map(e => `
      <div style="display:flex;gap:12px;margin-bottom:12px;align-items:flex-start">
        <div style="width:32px;height:32px;border-radius:50%;background:${colors[e.type]||"#555"};display:flex;align-items:center;justify-content:center;font-size:14px;flex-shrink:0">${icons[e.type]||"●"}</div>
        <div style="flex:1">
          <div style="font-size:13px;font-weight:600;color:#fff">${_esc(e.event)}</div>
          <div style="font-size:11px;color:rgba(255,255,255,0.4);margin-top:2px">${e.at ? new Date(e.at).toLocaleString("en-KE") : ""}</div>
          ${e.docNumber   ? `<div style="font-size:11px;color:#ffb400;margin-top:2px">Ref: ${_esc(e.docNumber)}${e.htmlUrl ? ` &nbsp;<a class="etims-link" href="${_esc(e.htmlUrl)}" target="_blank">View</a>` : ""}</div>` : ""}
          ${e.kraReceiptNumber ? `<div style="font-size:11px;color:#71ff00;margin-top:2px">KRA: ${_esc(e.kraReceiptNumber)}</div>` : ""}
        </div>
      </div>`).join("");

    const audit = trail.audit || {};
    el.innerHTML = `
      ${audit.duplicateRisk
        ? `<div style="background:rgba(255,68,68,0.1);border:1px solid rgba(255,68,68,0.3);border-radius:8px;padding:10px 14px;margin-bottom:14px;color:#ff4444;font-size:13px">⚠ ${_esc(audit.warning)}</div>`
        : `<div style="background:rgba(113,255,0,0.06);border:1px solid rgba(113,255,0,0.2);border-radius:8px;padding:8px 14px;margin-bottom:14px;color:#71ff00;font-size:12px">✓ No duplicate invoice risk detected</div>`}
      <div>${items || '<p class="etims-empty">No events yet.</p>'}</div>`;
  }

  function _esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  /* ── Inject shared CSS (shared with sokoni-etims.js if both loaded) ── */
  function injectStyles() {
    if (document.getElementById("hub-etims-styles")) return;
    const css = `
      .chip{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}
      .chip-ok{background:rgba(113,255,0,0.1);color:#71ff00;border:1px solid rgba(113,255,0,0.25)}
      .chip-warn{background:rgba(255,180,0,0.1);color:#ffb400;border:1px solid rgba(255,180,0,0.25)}
      .chip-fail{background:rgba(255,68,68,0.1);color:#ff4444;border:1px solid rgba(255,68,68,0.25)}
      .chip-blue{background:rgba(68,136,255,0.1);color:#4488ff;border:1px solid rgba(68,136,255,0.25)}
      .chip-purple{background:rgba(170,68,255,0.1);color:#aa44ff;border:1px solid rgba(170,68,255,0.25)}
      .chip-muted{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.08)}
      .etims-table{width:100%;border-collapse:collapse;font-size:13px}
      .etims-table th{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06)}
      .etims-table td{padding:9px 10px;border-bottom:1px solid rgba(255,255,255,0.04);color:rgba(255,255,255,0.8);vertical-align:middle}
      .etims-table tr:hover td{background:rgba(255,255,255,0.02)}
      .etims-link{color:#71ff00;text-decoration:none;font-size:11px;margin-right:6px}
      .etims-link:hover{text-decoration:underline}
      .etims-link-btn{background:none;border:none;color:#71ff00;font-size:11px;cursor:pointer;padding:0;margin-right:6px}
      .etims-link-btn:hover{text-decoration:underline}
      .etims-empty{color:rgba(255,255,255,0.3);font-size:13px;padding:20px 0;text-align:center}
    `;
    const s   = document.createElement("style");
    s.id      = "hub-etims-styles";
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ── Public API ──────────────────────────────────────────────── */
  const SokoniHubETIMS = {
    /* Hub management */
    createHub, updateHub, getHubProfile, updateTaxConfig, registerHubEtims,
    /* Operational docs */
    generateDocument,
    generatePickupReceipt, generateWarehouseReceipt, generateDispatchNote,
    generateReturnConfirmation, generateTransferNote,
    getDocuments,
    /* Invoices (selling hubs) */
    generateInvoice, resubmitInvoice,
    /* Audit */
    getAuditTrail,
    /* Stats */
    getHubStats, getAdminStats,
    /* Download */
    downloadDocument,
    /* UI */
    docTypeLabel, docTypeIcon, hubTypeBadge, statusBadge, formatKES,
    renderDocumentTable, renderAuditTimeline,
    injectStyles, _toast,
  };

  global.SokoniHubETIMS = SokoniHubETIMS;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectStyles);
  } else {
    injectStyles();
  }

})(window);
