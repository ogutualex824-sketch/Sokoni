/* ═══════════════════════════════════════════════════════════════════
   SOKONI eTIMS Frontend SDK  v1.0
   KRA Electronic Tax Invoice Management System — Client Module

   Usage
   ─────
   All pages include this via <script src="sokoni-etims.js"></script>
   Then call window.SokoniETIMS.* methods.

   Firebase Cloud Functions called:
     etimsRegisterSeller    etimsGetProfile        etimsUpdateProfile
     etimsValidatePin       etimsGenerateInvoice   etimsResubmitInvoice
     etimsBulkGenerate      etimsPlatformInvoice   etimsGetBuyerReceipts
     etimsGetSellerStats    etimsGetAdminStats      etimsDownloadReceipt
═══════════════════════════════════════════════════════════════════ */
(function (global) {
  "use strict";

  /* ── Firebase callable helper ──────────────────────────────────── */
  function _call(name, data) {
    if (typeof firebase === "undefined" || !firebase.functions)
      return Promise.reject(new Error("Firebase not initialised"));
    const fn = firebase.functions().httpsCallable(name);
    return fn(data).then(r => r.data);
  }

  /* ── Auth token helper (for onRequest endpoints) ─────────────── */
  async function _token() {
    const user = firebase.auth?.().currentUser;
    if (!user) throw new Error("Not signed in");
    return user.getIdToken();
  }

  /* ── Lightweight toast (falls back to alert) ─────────────────── */
  function _toast(msg, ok = true) {
    if (typeof SokoniUI !== "undefined" && SokoniUI.toast) {
      SokoniUI.toast(msg, ok ? "success" : "error");
    } else {
      console[ok ? "log" : "warn"]("[SokoniETIMS]", msg);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     PROFILE
  ══════════════════════════════════════════════════════════════ */

  /** Fetch signed-in seller's eTIMS profile. */
  function getProfile() {
    return _call("etimsGetProfile");
  }

  /**
   * Register or re-register eTIMS for the signed-in seller.
   * @param {Object} data
   *   kraPin, businessName, branchId, deviceSerial, taxpayerSecret,
   *   vatStatus ("registered"|"zero_rated"|"exempt"),
   *   taxCategory, invoicePrefix, address, phone
   */
  function register(data) {
    return _call("etimsRegisterSeller", data);
  }

  /** Update non-credential profile fields. */
  function updateProfile(data) {
    return _call("etimsUpdateProfile", data);
  }

  /** Validate KRA PIN format client-side (no network). */
  function validatePinFormat(pin) {
    return /^[A-Z]\d{9}[A-Z]$/i.test((pin || "").trim());
  }

  /** Deep-validate PIN against KRA (callable). */
  function validatePin(kraPin) {
    return _call("etimsValidatePin", { kraPin });
  }

  /* ══════════════════════════════════════════════════════════════
     SELLER INVOICE OPERATIONS
  ══════════════════════════════════════════════════════════════ */

  /** Generate (or retrieve existing) invoice for a completed order. */
  function generateInvoice(orderId, buyerKraPin = null) {
    return _call("etimsGenerateInvoice", { orderId, buyerKraPin });
  }

  /** Resubmit a failed or stuck invoice. */
  function resubmitInvoice(invoiceId) {
    return _call("etimsResubmitInvoice", { invoiceId });
  }

  /**
   * Generate a bulk/periodic invoice covering all completed orders
   * between periodStart and periodEnd (ISO strings).
   * billingPeriod: "daily" | "weekly" | "monthly" | "custom"
   */
  function generateBulkInvoice(periodStart, periodEnd, billingPeriod = "custom") {
    return _call("etimsBulkGenerate", { periodStart, periodEnd, billingPeriod });
  }

  /** Get seller's eTIMS statistics and recent invoices. */
  function getSellerStats() {
    return _call("etimsGetSellerStats");
  }

  /* ══════════════════════════════════════════════════════════════
     BUYER PORTAL
  ══════════════════════════════════════════════════════════════ */

  /** Get all receipts for the signed-in buyer. */
  function getBuyerReceipts(limit = 20) {
    return _call("etimsGetBuyerReceipts", { limit });
  }

  /* ══════════════════════════════════════════════════════════════
     ADMIN OPERATIONS
  ══════════════════════════════════════════════════════════════ */

  /** Get platform-wide eTIMS statistics (admin only). */
  function getAdminStats() {
    return _call("etimsGetAdminStats");
  }

  /**
   * Generate a SOKONI platform invoice for commission/fees (admin only).
   * feeType: commission | subscription | advertising | delivery | verification | premium
   */
  function platformInvoice({ sellerUid, feeType, amount, reference, description }) {
    return _call("etimsPlatformInvoice", { sellerUid, feeType, amount, reference, description });
  }

  /* ══════════════════════════════════════════════════════════════
     RECEIPT DOWNLOAD
  ══════════════════════════════════════════════════════════════ */

  /**
   * Open the HTML receipt in a new tab for printing/saving as PDF.
   * Requires the user to be signed in — auth token is attached.
   */
  async function downloadReceipt(invoiceId) {
    try {
      const token = await _token();
      const base  = global.SOKONI_CF_BASE
        || "https://us-central1-sokoni-aeb26.cloudfunctions.net";
      const url   = `${base}/etimsDownloadReceipt?id=${encodeURIComponent(invoiceId)}`;

      /* Open as authenticated request via fetch → blob → object URL */
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const html = await resp.text();
      const blob = new Blob([html], { type: "text/html" });
      const obj  = URL.createObjectURL(blob);
      const win  = global.open(obj, "_blank");
      if (!win) {
        /* Popup blocked — fall back to anchor download */
        const a = document.createElement("a");
        a.href = obj;
        a.download = `sokoni-invoice-${invoiceId}.html`;
        a.click();
      }
      /* Revoke after 60 s */
      setTimeout(() => URL.revokeObjectURL(obj), 60_000);
    } catch (e) {
      _toast("Could not open receipt: " + e.message, false);
    }
  }

  /* ══════════════════════════════════════════════════════════════
     UI HELPERS  — render eTIMS status badge, invoice table rows, etc.
  ══════════════════════════════════════════════════════════════ */

  const STATUS_BADGE = {
    accepted:           '<span class="etims-badge etims-ok">✓ KRA Accepted</span>',
    pending_submission: '<span class="etims-badge etims-pending">⏳ Queued</span>',
    draft:              '<span class="etims-badge etims-pending">Draft</span>',
    failed:             '<span class="etims-badge etims-fail">✕ Failed</span>',
    cancelled:          '<span class="etims-badge etims-muted">Cancelled</span>',
  };

  function statusBadge(status) {
    return STATUS_BADGE[status] || `<span class="etims-badge etims-muted">${status}</span>`;
  }

  function formatKES(n) {
    return "KES " + Number(n || 0).toLocaleString("en-KE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /**
   * Render an invoice list into a container element.
   * invoices: array from getSellerStats().recentInvoices or getBuyerReceipts().invoices
   */
  function renderInvoiceTable(containerId, invoices, { showSeller = false, onDownload = null } = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    if (!invoices || !invoices.length) {
      el.innerHTML = '<p class="etims-empty">No invoices yet.</p>';
      return;
    }

    const rows = invoices.map(inv => `
      <tr>
        <td>${_esc(inv.invoiceNumber)}</td>
        ${showSeller ? `<td>${_esc(inv.seller?.name || "—")}</td>` : ""}
        <td>${_esc(inv.orderId || "Bulk")}</td>
        <td>${new Date(inv.createdAt).toLocaleDateString("en-KE")}</td>
        <td class="r">${formatKES(inv.total ?? inv.totalAmount)}</td>
        <td class="r">${formatKES(inv.vat ?? inv.vatAmount)}</td>
        <td>${statusBadge(inv.status)}</td>
        <td>${inv.receiptNumber ? _esc(inv.receiptNumber) : "—"}</td>
        <td>
          ${inv.pdfUrl
            ? `<a class="etims-link" href="${_esc(inv.pdfUrl)}" target="_blank">View</a>`
            : inv.invoiceId
              ? `<button class="etims-link-btn" onclick="SokoniETIMS.downloadReceipt('${inv.invoiceId}')">Download</button>`
              : "—"}
          ${inv.status === "failed" && inv.invoiceId
            ? `<button class="etims-link-btn etims-retry" onclick="SokoniETIMS.resubmitInvoice('${inv.invoiceId}').then(r=>SokoniETIMS._toast(r.message||'Queued',true))">Retry</button>`
            : ""}
          ${inv.verificationUrl
            ? `<a class="etims-link" href="${_esc(inv.verificationUrl)}" target="_blank" title="Verify at KRA">KRA ↗</a>`
            : ""}
        </td>
      </tr>`).join("");

    el.innerHTML = `
      <table class="etims-table">
        <thead><tr>
          <th>Invoice #</th>
          ${showSeller ? "<th>Seller</th>" : ""}
          <th>Order</th>
          <th>Date</th>
          <th class="r">Total</th>
          <th class="r">VAT</th>
          <th>Status</th>
          <th>KRA Receipt #</th>
          <th>Actions</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  function _esc(s) {
    return String(s || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }

  /** Inject shared eTIMS styles once. */
  function injectStyles() {
    if (document.getElementById("etims-styles")) return;
    const css = `
      .etims-badge{display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:20px;font-size:11px;font-weight:700;white-space:nowrap}
      .etims-ok{background:rgba(113,255,0,0.12);color:#71ff00;border:1px solid rgba(113,255,0,0.3)}
      .etims-pending{background:rgba(255,180,0,0.12);color:#ffb400;border:1px solid rgba(255,180,0,0.3)}
      .etims-fail{background:rgba(255,68,68,0.12);color:#ff4444;border:1px solid rgba(255,68,68,0.3)}
      .etims-muted{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.4);border:1px solid rgba(255,255,255,0.08)}
      .etims-table{width:100%;border-collapse:collapse;font-size:13px}
      .etims-table th{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.5);font-size:11px;text-transform:uppercase;letter-spacing:.4px;padding:8px 10px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.06)}
      .etims-table td{padding:9px 10px;border-bottom:1px solid rgba(255,255,255,0.04);color:rgba(255,255,255,0.8);vertical-align:middle}
      .etims-table tr:hover td{background:rgba(255,255,255,0.02)}
      .etims-table .r{text-align:right}
      .etims-link{color:#71ff00;text-decoration:none;font-size:11px;margin-right:6px}
      .etims-link:hover{text-decoration:underline}
      .etims-link-btn{background:none;border:none;color:#71ff00;font-size:11px;cursor:pointer;padding:0;margin-right:6px}
      .etims-link-btn:hover{text-decoration:underline}
      .etims-retry{color:#ffb400!important}
      .etims-empty{color:rgba(255,255,255,0.3);font-size:13px;padding:20px 0;text-align:center}
      .etims-card{background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);border-radius:12px;padding:18px 20px}
      .etims-stat{display:flex;flex-direction:column;gap:4px}
      .etims-stat .val{font-size:22px;font-weight:800;color:#fff}
      .etims-stat .lbl{font-size:11px;color:rgba(255,255,255,0.4);text-transform:uppercase;letter-spacing:.4px}
      .etims-pin-valid{color:#71ff00;font-size:11px}
      .etims-pin-invalid{color:#ff4444;font-size:11px}
    `;
    const s   = document.createElement("style");
    s.id      = "etims-styles";
    s.textContent = css;
    document.head.appendChild(s);
  }

  /* ══════════════════════════════════════════════════════════════
     PUBLIC API
  ══════════════════════════════════════════════════════════════ */
  const SokoniETIMS = {
    /* Profile */
    getProfile,
    register,
    updateProfile,
    validatePinFormat,
    validatePin,
    /* Seller */
    generateInvoice,
    resubmitInvoice,
    generateBulkInvoice,
    getSellerStats,
    /* Buyer */
    getBuyerReceipts,
    /* Admin */
    getAdminStats,
    platformInvoice,
    /* Download */
    downloadReceipt,
    /* UI helpers */
    statusBadge,
    formatKES,
    renderInvoiceTable,
    injectStyles,
    _toast,
  };

  global.SokoniETIMS = SokoniETIMS;

  /* Auto-inject styles when DOM is ready */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", injectStyles);
  } else {
    injectStyles();
  }

})(window);
