/* SOKONI SmartPOS — Audit & Compliance Module v1.0
   Requirement 39: Immutable audit log, tamper-evidence,
   compliance reports, GDPR data export, activity timeline. */

'use strict';

const PosAudit = (() => {

  /* ── Action categories ─────────────────────────────────────── */
  const ACTION_TYPES = {
    sale:             { label: 'Sale Completed',        icon: '🛒', level: 'info'    },
    sale_void:        { label: 'Sale Voided',           icon: '🗑️', level: 'warning' },
    refund:           { label: 'Refund Processed',      icon: '↩️', level: 'warning' },
    login:            { label: 'Cashier Login',         icon: '🔑', level: 'info'    },
    logout:           { label: 'Cashier Logout',        icon: '🔒', level: 'info'    },
    shift_open:       { label: 'Shift Opened',          icon: '🌅', level: 'info'    },
    shift_close:      { label: 'Shift Closed',          icon: '🌇', level: 'info'    },
    product_created:  { label: 'Product Created',       icon: '➕', level: 'info'    },
    product_updated:  { label: 'Product Updated',       icon: '✏️', level: 'info'    },
    product_deleted:  { label: 'Product Deleted',       icon: '🗑️', level: 'warning' },
    stock_adjusted:   { label: 'Stock Adjusted',        icon: '📦', level: 'info'    },
    price_changed:    { label: 'Price Changed',         icon: '💰', level: 'warning' },
    discount_applied: { label: 'Discount Applied',      icon: '🏷️', level: 'info'    },
    settings_changed: { label: 'Settings Changed',      icon: '⚙️', level: 'warning' },
    cashier_added:    { label: 'Cashier Added',         icon: '👤', level: 'info'    },
    cashier_removed:  { label: 'Cashier Removed',       icon: '👤', level: 'warning' },
    clock_in:         { label: 'Clock In',              icon: '🕐', level: 'info'    },
    clock_out:        { label: 'Clock Out',             icon: '🕐', level: 'info'    },
    data_export:      { label: 'Data Exported',         icon: '📤', level: 'warning' },
    data_reset:       { label: 'Data Reset',            icon: '⚠️', level: 'critical'},
    failed_login:     { label: 'Failed Login Attempt',  icon: '🚨', level: 'critical'},
    fraud_alert:      { label: 'Fraud Alert',           icon: '🚨', level: 'critical'},
    mpesa_initiated:  { label: 'M-PESA STK Sent',       icon: '📱', level: 'info'    },
    supplier_po:      { label: 'Purchase Order Created', icon: '📋', level: 'info'   },
    plugin_enabled:   { label: 'Plugin Enabled',         icon: '🔌', level: 'info'   },
    plugin_disabled:  { label: 'Plugin Disabled',        icon: '🔌', level: 'warning'},
  };

  /* ── Session fingerprint for tamper evidence ───────────────── */
  let _sessionId = null;
  let _sequence  = 0;
  let _prevHash  = '0';

  async function _getSessionId() {
    if (_sessionId) return _sessionId;
    _sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    return _sessionId;
  }

  async function _hash(data) {
    const text = JSON.stringify(data);
    if (window.crypto?.subtle) {
      const buf  = new TextEncoder().encode(text);
      const hash = await crypto.subtle.digest('SHA-256', buf);
      return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2,'0')).join('').slice(0, 16);
    }
    /* Fallback: djb2 */
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h) + text.charCodeAt(i) | 0;
    return Math.abs(h).toString(16).padStart(16, '0');
  }

  /* ── Core: log an action ───────────────────────────────────── */
  async function log(action, data = {}) {
    try {
      const sessionId = await _getSessionId();
      const ts        = Date.now();
      _sequence++;

      /* Cashier + shift context from SPos */
      const cashierName = window.SPos?.state?.cashier?.name || 'System';
      const cashierId   = window.SPos?.state?.cashier?.id   || 'system';
      const shiftId     = window.SPos?.state?.shift?.id     || null;

      const entry = {
        action, data, ts,
        cashierName, cashierId, shiftId,
        sessionId,
        sequence: _sequence,
        prevHash: _prevHash,
        userAgent: navigator.userAgent.slice(0, 80),
      };

      entry.hash = await _hash(entry);
      _prevHash  = entry.hash;

      await PosDB.audit_logs.add(entry);

      /* If critical, also push to Firestore for off-device storage */
      const info = ACTION_TYPES[action];
      if (info?.level === 'critical' && navigator.onLine) {
        _pushToFirestore(entry).catch(() => {});
      }
    } catch (e) {
      console.error('[PosAudit] Log error:', e);
    }
  }

  async function _pushToFirestore(entry) {
    const { getFirestore, collection, addDoc } = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js');
    const db     = getFirestore(window._firebaseApp);
    const bizPin = window.SPos?.state?.settings?.bizPin;
    if (!bizPin) return;
    await addDoc(collection(db, `businesses/${bizPin}/audit_logs`), {
      ...entry, data: JSON.stringify(entry.data),
    });
  }

  /* ── Query & filter ────────────────────────────────────────── */
  async function getLogs(opts = {}) {
    const all = await PosDB.audit_logs.getAll();
    let logs  = all;
    if (opts.since)     logs = logs.filter(l => l.ts >= opts.since);
    if (opts.until)     logs = logs.filter(l => l.ts <= opts.until);
    if (opts.action)    logs = logs.filter(l => l.action === opts.action);
    if (opts.cashierId) logs = logs.filter(l => l.cashierId === opts.cashierId);
    if (opts.level) {
      const lvl = opts.level;
      logs = logs.filter(l => ACTION_TYPES[l.action]?.level === lvl);
    }
    return logs.sort((a, b) => b.ts - a.ts).slice(0, opts.limit || 500);
  }

  /* ── Tamper check: verify hash chain ───────────────────────── */
  async function verifyIntegrity(logs) {
    const sorted  = [...logs].sort((a, b) => a.sequence - b.sequence);
    const results = [];
    let   prevHash = '0';

    for (const entry of sorted) {
      const { hash: storedHash, ...payload } = entry;
      const computedHash = await _hash(payload);
      const ok = computedHash === storedHash && entry.prevHash === prevHash;
      results.push({ id: entry.id, ts: entry.ts, action: entry.action, ok });
      prevHash = storedHash;
    }
    return results;
  }

  /* ── Compliance report ─────────────────────────────────────── */
  async function generateComplianceReport(startTs, endTs) {
    const logs    = await getLogs({ since: startTs, until: endTs });
    const report  = await PosDB.reports.forDateRange(startTs, endTs).catch(() => ({}));
    const byLevel = { info: 0, warning: 0, critical: 0 };
    const byAction = {};

    for (const l of logs) {
      const info = ACTION_TYPES[l.action] || { level: 'info' };
      byLevel[info.level] = (byLevel[info.level] || 0) + 1;
      byAction[l.action]  = (byAction[l.action]  || 0) + 1;
    }

    const criticals = logs.filter(l => ACTION_TYPES[l.action]?.level === 'critical');

    return {
      period:     { start: startTs, end: endTs },
      totalEvents: logs.length,
      byLevel, byAction,
      criticals,
      sales:      report.count || 0,
      revenue:    report.total || 0,
      generated:  Date.now(),
    };
  }

  /* ── GDPR: export all data for a customer ──────────────────── */
  async function exportCustomerData(customerId) {
    const [customer, transactions, loyalty] = await Promise.all([
      PosDB.customers.get(customerId).catch(() => null),
      PosDB.transactions.getAll().then(txns => txns.filter(t => t.customerId === customerId)),
      PosDB.customers.get(customerId).then(c => c?.points || 0).catch(() => 0),
    ]);

    const exportData = {
      exportDate:  new Date().toISOString(),
      exportedBy:  window.SPos?.state?.cashier?.name || 'System',
      customer:    customer ? { name: customer.name, phone: customer.phone, email: customer.email } : null,
      transactions: transactions.map(t => ({
        receiptNo: t.receiptNo, date: new Date(t.completedAt).toISOString(),
        total: t.total, items: t.items?.length || 0, method: t.paymentMethod,
      })),
      loyaltyPoints: loyalty,
    };

    await log('data_export', { customerId, recordCount: transactions.length });

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `sokoni_gdpr_${customerId}_${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(url);
  }

  /* ── Render audit log UI ────────────────────────────────────── */
  async function renderLog(containerId, opts = {}) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div class="bos-loading">Loading audit log…</div>';

    const logs = await getLogs({ limit: 200, ...opts });

    if (!logs.length) {
      el.innerHTML = '<div class="bos-all-good">No audit events in this period.</div>'; return;
    }

    const levelColor = { info: 'var(--txt2)', warning: '#f59e0b', critical: 'var(--red)' };

    el.innerHTML = `
      <div style="display:flex;gap:8px;margin-bottom:10px;flex-wrap:wrap;align-items:center">
        <input type="text" id="audit-search" class="form-inp" placeholder="Filter events…" style="font-size:14px;flex:1;min-width:120px"
          oninput="PosAudit._filterLog(this.value,'${containerId}')">
        <select id="audit-level" class="form-inp" style="font-size:14px" onchange="PosAudit._filterLog(document.getElementById('audit-search').value,'${containerId}')">
          <option value="">All levels</option>
          <option value="info">Info</option>
          <option value="warning">Warning</option>
          <option value="critical">Critical</option>
        </select>
        <button class="bos-action-btn" onclick="PosAudit._verifyAndShow('${containerId}')">🔍 Verify</button>
      </div>
      <div id="audit-log-rows">
        ${logs.map(l => _renderRow(l, levelColor)).join('')}
      </div>
    `;
    el._allLogs = logs;
  }

  function _renderRow(l, levelColor) {
    const info = ACTION_TYPES[l.action] || { icon: '•', level: 'info', label: l.action };
    const col  = (levelColor || { info: 'var(--txt2)', warning: '#f59e0b', critical: 'var(--red)' })[info.level];
    return `
      <div class="audit-row" data-action="${l.action}" data-level="${info.level}">
        <span class="audit-icon">${info.icon}</span>
        <div class="audit-content">
          <div class="audit-action" style="color:${col}">${info.label}</div>
          <div class="audit-meta">${l.cashierName} · ${new Date(l.ts).toLocaleString()}</div>
          ${l.data && Object.keys(l.data).length
            ? `<div class="audit-data">${Object.entries(l.data).map(([k,v]) => `${k}: ${JSON.stringify(v)}`).join(' · ')}</div>`
            : ''}
        </div>
        <div class="audit-hash" title="Chain hash">${l.hash?.slice(0, 8) || '—'}</div>
      </div>
    `;
  }

  function _filterLog(query, containerId) {
    const el   = document.getElementById(containerId);
    const rows = document.getElementById('audit-log-rows');
    if (!el || !rows) return;

    const q     = query.toLowerCase();
    const level = document.getElementById('audit-level')?.value || '';
    const logs  = el._allLogs || [];

    const filtered = logs.filter(l => {
      const info = ACTION_TYPES[l.action] || { level: 'info' };
      if (level && info.level !== level) return false;
      if (!q) return true;
      return (
        l.action.includes(q) ||
        (l.cashierName || '').toLowerCase().includes(q) ||
        JSON.stringify(l.data || {}).toLowerCase().includes(q) ||
        (ACTION_TYPES[l.action]?.label || '').toLowerCase().includes(q)
      );
    });

    rows.innerHTML = filtered.length
      ? filtered.map(l => _renderRow(l, null)).join('')
      : '<div class="bos-all-good">No matching events.</div>';
  }

  async function _verifyAndShow(containerId) {
    const el   = document.getElementById(containerId);
    const logs = el?._allLogs || [];
    if (!logs.length) return;
    const results = await verifyIntegrity(logs);
    const broken  = results.filter(r => !r.ok);
    if (!broken.length) {
      if (window.SPos) SPos.toast('✓ Audit log integrity verified — no tampering detected', 'success');
    } else {
      if (window.SPos) SPos.toast(`⚠️ ${broken.length} log entries may have been tampered!`, 'error');
    }
  }

  /* ── Render compliance hub ─────────────────────────────────── */
  async function renderHub(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    const now        = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const monthEnd   = Date.now();
    const report     = await generateComplianceReport(monthStart, monthEnd);

    el.innerHTML = `
      <div class="bos-kpi-strip">
        <div class="bos-kpi-tile"><div class="bos-kpi-label">Total Events</div><div class="bos-kpi-val">${report.totalEvents}</div></div>
        <div class="bos-kpi-tile ${report.byLevel.critical > 0 ? 'amber' : 'green'}">
          <div class="bos-kpi-label">Critical</div>
          <div class="bos-kpi-val ${report.byLevel.critical > 0 ? 'text-red' : ''}">${report.byLevel.critical}</div>
        </div>
        <div class="bos-kpi-tile"><div class="bos-kpi-label">Warnings</div><div class="bos-kpi-val" style="color:#f59e0b">${report.byLevel.warning}</div></div>
        <div class="bos-kpi-tile"><div class="bos-kpi-label">Sales Logged</div><div class="bos-kpi-val">${report.sales}</div></div>
      </div>
      ${report.criticals.length ? `
        <div class="bos-section" style="border-color:rgba(239,68,68,.3)">
          <div class="bos-section-title" style="color:var(--red)">🚨 Critical Events This Month</div>
          ${report.criticals.map(l => `
            <div class="bos-fraud-alert bos-fraud-warning" style="background:rgba(239,68,68,.08)">
              <span>${ACTION_TYPES[l.action]?.icon || '⚠️'}</span>
              <span>${ACTION_TYPES[l.action]?.label || l.action} — ${l.cashierName} — ${new Date(l.ts).toLocaleString()}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="bos-all-good" style="margin-bottom:14px">✓ No critical events this month</div>'}
      <div id="audit-log-body"></div>
    `;

    await renderLog('audit-log-body', { since: monthStart });
  }

  return { log, getLogs, verifyIntegrity, generateComplianceReport, exportCustomerData, renderLog, renderHub, _filterLog, _verifyAndShow, ACTION_TYPES };
})();

window.PosAudit = PosAudit;
