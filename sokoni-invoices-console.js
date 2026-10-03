/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   SOKONI Invoices Console — ONE read-only invoices page for AdminOS and Super Admin (owner 2026-10-04)
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   Source: THE canonical invoice store (`invoices`, restructured — owner decision) through adminInvoicesList.
   Requires sokoni-products-console.js first (shared styles).   Mount: SokoniInvoicesConsole.mount(el, { call, toast })

   MONEY TRUTH (owner): "Confirmed paid" is the server's sum of VERIFIED payment allocations only. A merchant- or
   admin-entered reference is a PAYMENT CLAIM — shown as "Unverified claim — awaiting verification", counted
   separately, and never part of confirmed paid, revenue, settlement, wallet or commission figures. Unclassified and
   not-yet-migrated documents are EXCLUDED from totals and shown as a count.
   DATA INTEGRITY: every figure is a server aggregate; one the server marks unavailable renders "—" + the reason, never
   0. Money arrives in integer cents. Not shown because the server does not compute them: average days to pay, trends,
   card brand / last-4.
   READ-ONLY: no New / Send / Void / Mark-paid (there is no admin invoice write authority). Export is a SERVER query
   (adminInvoicesExport) — complete, permission-checked, sensitive fields restricted and AUDITED — never a dump of the
   browser's rows.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SokoniInvoicesConsole) return;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const int = (v) => (Number.isInteger(v) ? v : null);
  const kes = (cents, cur) => { const c = int(cents); return c === null ? '—' : (cur || 'KES') + ' ' + (c / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const kesBig = (cents) => { const c = int(cents); return c === null ? '—' : 'KES ' + Math.round(c / 100).toLocaleString('en-KE'); };
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  const day = (iso) => { if (!iso) return '—'; const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };

  const CSS = `
  .sic-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
  .sic-kpi{display:flex;gap:12px;align-items:center;padding:14px}
  .sic-ico{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;flex:0 0 40px}
  .sic-kpi small{display:block;color:var(--spc-muted);font-size:12px}
  .sic-kpi b{font-size:20px;display:block;line-height:1.2}
  .sic-aging{padding:16px;margin-bottom:14px}
  .sic-ag-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-top:12px}
  .sic-ag small{color:var(--spc-muted);font-size:12px;display:block} .sic-ag b{font-size:17px}
  .sic-bar{height:5px;border-radius:5px;background:var(--spc-card2);margin-top:8px;overflow:hidden} .sic-bar i{display:block;height:100%;border-radius:5px}
  .sic-sub{font-size:11px;color:var(--spc-muted)} .sic-sub.bad{color:var(--spc-bad)} .sic-sub.ok{color:var(--spc-ok)} .sic-sub.warn{color:var(--spc-warn)}
  .sic-dl{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:13px;margin:12px 0} .sic-dl dt{color:var(--spc-muted)} .sic-dl dd{margin:0;text-align:right}
  .sic-items{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px} .sic-items td{padding:6px 0;border-bottom:1px solid var(--spc-line)} .sic-items td:last-child{text-align:right}
  .sic-unav{font-size:11px;color:var(--spc-muted)}
  .sic-note{font-size:12px;color:var(--spc-muted);margin:-6px 0 12px}
  `;
  function injectCss() {
    if (window.SokoniConsoleStyles) window.SokoniConsoleStyles.inject();
    if (document.getElementById('sic-css')) return;
    const s = document.createElement('style'); s.id = 'sic-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  const TABS = [
    { key: 'all', label: 'All' }, { key: 'draft', label: 'Draft' }, { key: 'issued', label: 'Issued' }, { key: 'partially_paid', label: 'Partially paid' },
    { key: 'overdue', label: 'Overdue', tone: 'warn' }, { key: 'paid', label: 'Paid' }, { key: 'void', label: 'Void' },
    { key: 'unverified', label: 'Unverified claims', tone: 'warn' }, { key: 'unclassified', label: 'Unclassified', tone: 'bad' },
  ];
  const STATUS = { draft: ['Draft', 'muted'], issued: ['Issued', 'warn'], partially_paid: ['Partially paid', 'accent'], overdue: ['Overdue', 'bad'], paid: ['Paid', 'ok'], void: ['Void', 'muted'], unknown: ['Unclassified', 'bad'] };
  const SOURCE = { order: 'Order', booking: 'Booking', quote: 'Quote', subscription: 'Subscription', commission: 'Commission bill', manual: 'Manual merchant invoice' };
  const UNAV = { index_missing: 'database index not deployed yet', unavailable: 'not available right now' };

  function mount(root, opts) {
    if (!root) return null;
    injectCss();
    const o = opts || {};
    const call = o.call, toast = o.toast || (() => {});
    const st = { tab: 'all', q: '', rows: [], summary: null, cursor: null, loading: false, more: false, exporting: false, error: null, sel: null };
    root.classList.add('spc');

    async function load(append) {
      if (typeof call !== 'function') { st.error = 'This page has no server connection.'; render(); return; }
      st.loading = !append; st.more = !!append; st.error = null; render();
      try {
        const r = await call('adminInvoicesList', { tab: st.tab, limit: 25, cursor: append ? st.cursor : undefined, withSummary: !append });
        const rows = Array.isArray(r && r.invoices) ? r.invoices : [];
        st.rows = append ? st.rows.concat(rows) : rows;
        st.cursor = (r && r.cursor) || null;
        if (!append) st.summary = (r && r.summary) || null;
      } catch (e) { if (!append) st.rows = []; st.error = (e && e.message) ? String(e.message) : 'Invoices could not be loaded.'; }
      st.loading = false; st.more = false;
      if (st.sel && !st.rows.some((x) => x.id === st.sel)) st.sel = null;
      render();
    }

    const sm = () => st.summary || {};
    const why = (label) => { const u = sm().unavailable || {}; return u[label] ? (UNAV[u[label]] || u[label]) : null; };
    const count = (key) => { const v = num((sm().counts || {})[key]); return v === null ? '—' : v.toLocaleString('en-KE'); };
    const shown = () => { const q = st.q.toLowerCase(); return q ? st.rows.filter((x) => [x.invoiceNumber, x.clientName, x.clientEmail, x.shopName, x.id, x.transactionRef && x.transactionRef.id].some((v) => v && String(v).toLowerCase().includes(q))) : st.rows; };
    const pill = (x) => { const key = x.classification === 'unknown' ? 'unknown' : x.display; const s = STATUS[key] || [x.display || '—', 'muted']; return '<span class="spc-pill ' + s[1] + '">' + esc(s[0]) + '</span>'; };
    function payCell(x) {
      if (x.paymentClaim && x.paymentClaim.status === 'unverified') return '<span class="sic-sub warn">Unverified claim — awaiting verification</span>';
      if (x.paymentStatus === 'succeeded') return '<span class="sic-sub ok">Verified' + (x.allocationCount ? ' (' + esc(x.allocationCount) + ')' : '') + '</span>';
      if (x.paymentStatus === 'refunded') return '<span class="sic-sub">Refunded</span>';
      return '<span class="sic-sub">' + esc(x.paymentStatus || '—') + '</span>';
    }
    function dueSub(x) {
      if (x.display === 'overdue') return '<div class="sic-sub bad">' + esc(x.daysOverdue) + ' day' + (x.daysOverdue === 1 ? '' : 's') + ' overdue</div>';
      if (x.display === 'paid' && x.paidAt) return '<div class="sic-sub ok">Paid (verified) ' + esc(day(x.paidAt)) + '</div>';
      if (x.display === 'void' && x.voidedAt) return '<div class="sic-sub">Voided ' + esc(day(x.voidedAt)) + '</div>';
      return '';
    }
    function kpi(ico, bg, label, value, unavLabel, note) {
      const w = unavLabel ? why(unavLabel) : null;
      return '<div class="spc-card sic-kpi"><span class="sic-ico" style="background:' + bg + '" aria-hidden="true">' + ico + '</span><div><small>' + esc(label) + '</small><b>' + esc(value) + '</b>' + (w ? '<span class="sic-unav">' + esc(w) + '</span>' : (note ? '<span class="sic-unav">' + esc(note) + '</span>' : '')) + '</div></div>';
    }
    function aging() {
      const a = sm().aging || {}, total = int(sm().openBalanceCents);
      const parts = [['Current (not yet due)', a.current, 'a_current', 'var(--spc-ok)'], ['1–30 days overdue', a.d1_30, 'a_1_30', 'var(--spc-warn)'], ['31–60 days', a.d31_60, 'a_31_60', '#fb923c'], ['61–90 days', a.d61_90, 'a_61_90', 'var(--spc-bad)'], ['91+ days', a.d91plus, 'a_91', '#ef4444']];
      return '<div class="spc-card sic-aging"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><strong>Aging of open balances</strong><div class="sic-sub">Open balance ' + esc(kesBig(total)) + (int(a.undated) ? ' · ' + esc(kesBig(a.undated)) + ' on invoices with no due date' : '') + '</div></div><div class="sic-sub">As of ' + esc(day(sm().asOf)) + '</div></div><div class="sic-ag-grid">' +
        parts.map(([l, v, k, c]) => { const n = int(v); const pct = n !== null && total ? Math.round((n / total) * 1000) / 10 : null; const w = why(k);
          return '<div class="sic-ag"><small>' + esc(l) + '</small><b>' + esc(kesBig(n)) + '</b> <span class="sic-sub">' + (pct === null ? '' : pct + '%') + '</span>' + (w ? '<div class="sic-unav">' + esc(w) + '</div>' : '<div class="sic-bar" aria-hidden="true"><i style="width:' + (pct || 0) + '%;background:' + c + '"></i></div>') + '</div>'; }).join('') + '</div></div>';
    }

    function render() {
      const rows = shown(), sel = st.sel ? st.rows.find((x) => x.id === st.sel) : null, s = sm(), ex = s.excluded || {};
      const excludedN = [num(ex.unclassified), num(ex.unmigrated)];
      root.innerHTML =
        '<div class="spc-head"><div><h2 class="spc-title">Invoices</h2><p class="spc-sub">The canonical invoice record — confirmed money comes only from verified payments.</p></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="spc-btn" data-act="export"' + (st.exporting ? ' disabled' : '') + ' title="Server export of the current tab — complete, audited">' + (st.exporting ? 'Exporting…' : '⤓ Export') + '</button><button class="spc-btn" data-act="refresh">↻ Refresh</button></div></div>' +
        '<div class="spc-tabs" role="tablist" aria-label="Invoice status">' + TABS.map((t) => '<button class="spc-tab" role="tab" data-tab="' + t.key + '" aria-selected="' + (t.key === st.tab) + '">' + esc(t.label) + ' <span class="spc-count' + (t.tone ? ' ' + t.tone : '') + '">' + count(t.key) + '</span></button>').join('') + '</div>' +
        (st.summary ? '<div class="sic-kpis">' +
          kpi('🧾', 'rgba(109,93,252,.18)', 'Total invoiced', kesBig(s.totalInvoicedCents), 'invoiced') +
          kpi('✓', 'rgba(52,211,153,.16)', 'Confirmed paid (verified)', kesBig(s.confirmedPaidCents), 'confirmedPaid') +
          kpi('◷', 'rgba(245,158,11,.16)', 'Open balance', kesBig(s.openBalanceCents), 'open') +
          kpi('!', 'rgba(248,113,113,.16)', 'Overdue balance', kesBig(s.overdueBalanceCents), 'overdue') +
          kpi('?', 'rgba(245,158,11,.12)', 'Unverified payment claims', num(s.unverifiedClaims) === null ? '—' : num(s.unverifiedClaims).toLocaleString('en-KE'), 'claims', 'not counted as paid') +
        '</div>' +
        (excludedN.some((v) => v) ? '<p class="sic-note">Excluded from every total: ' + (excludedN[0] ? excludedN[0] + ' unclassified' : '') + (excludedN[0] && excludedN[1] ? ' · ' : '') + (excludedN[1] ? excludedN[1] + ' not yet migrated' : '') + '.</p>' : (excludedN.some((v) => v === null) ? '<p class="sic-note">Excluded documents: —</p>' : '')) +
        aging() : '') +
        (st.error ? '<div class="spc-err" role="alert">Could not load invoices — ' + esc(st.error) + '</div>' : '') +
        '<div class="spc-bar"><input class="spc-input" type="search" data-in="q" placeholder="Search the loaded invoices by number, customer, shop or transaction…" value="' + esc(st.q) + '" aria-label="Search invoices"></div>' +
        '<div class="spc-layout' + (sel ? ' has-drawer' : '') + '"><div class="spc-card">' +
          (st.loading ? '<div class="spc-empty">Loading invoices…</div>' : !rows.length ? '<div class="spc-empty">' + (st.error ? 'No invoices to show.' : st.q ? 'No loaded invoice matches.' : 'No invoices.') + '</div>' :
            '<div class="spc-tablewrap"><table class="spc-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Source</th><th>Status</th><th>Payment</th><th>Due</th><th style="text-align:right">Total</th><th style="text-align:right">Balance</th></tr></thead><tbody>' +
            rows.map((x) => '<tr class="spc-row" data-open="' + esc(x.id) + '" aria-selected="' + (x.id === st.sel) + '" tabindex="0">' +
              '<td class="spc-mono" style="color:#a5b4fc">' + esc(x.invoiceNumber || x.id) + '</td>' +
              '<td><div class="spc-pname">' + esc(x.clientName || '—') + '</div><div class="spc-meta">' + esc(x.shopName || x.clientEmail || '') + '</div></td>' +
              '<td class="spc-meta">' + esc(SOURCE[x.source] || (x.classification === 'unknown' ? 'Unclassified' : '—')) + '</td>' +
              '<td>' + pill(x) + '</td><td>' + payCell(x) + '</td>' +
              '<td>' + esc(day(x.dueDate)) + dueSub(x) + '</td>' +
              '<td style="text-align:right;font-weight:600">' + esc(kes(x.totalCents, x.currency)) + '</td>' +
              '<td style="text-align:right;' + (x.display === 'overdue' ? 'color:var(--spc-bad);font-weight:600' : '') + '">' + esc(kes(x.balanceCents, x.currency)) + '</td></tr>').join('') + '</tbody></table></div>') +
          '<div class="spc-foot"><span>' + (st.loading ? '' : 'Showing ' + rows.length + ' of ' + st.rows.length + ' loaded' + (st.q ? ' (search applies to loaded rows)' : '')) + '</span>' +
            (st.cursor ? '<button class="spc-btn" data-act="more"' + (st.more ? ' disabled' : '') + '>' + (st.more ? 'Loading…' : 'Load more') + '</button>' : '') + '</div>' +
        '</div>' + (sel ? drawer(sel) : '') + '</div>';
    }

    function drawer(x) {
      const items = Array.isArray(x.items) ? x.items : [];
      const tr = x.transactionRef;
      return '<aside class="spc-card spc-drawer" role="dialog" aria-label="Invoice ' + esc(x.invoiceNumber || x.id) + '">' +
        '<div class="spc-dh"><div style="flex:1;min-width:0"><h3 class="spc-dtitle">Invoice ' + esc(x.invoiceNumber || x.id) + '</h3><div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' + pill(x) + dueSub(x).replace('<div', '<span').replace('</div>', '</span>') + '</div></div><button class="spc-x" data-act="close" aria-label="Close details">×</button></div>' +
        '<div class="spc-box"><div class="spc-pname">' + esc(x.clientName || '—') + '</div><div class="spc-meta">' + esc(x.clientEmail || '') + '</div><div class="spc-meta" style="margin-top:4px">Billed by ' + esc(x.shopName || x.shopId || x.sellerUid || '—') + '</div></div>' +
        '<dl class="sic-dl"><dt>Source</dt><dd>' + esc(SOURCE[x.source] || (x.classification === 'unknown' ? 'Unclassified — excluded from totals' : '—')) + '</dd>' +
          '<dt>Transaction</dt><dd>' + (tr && tr.id ? esc((tr.kind || 'ref') + ' ' + tr.id) : '—') + '</dd>' +
          '<dt>Issued</dt><dd>' + esc(day(x.issuedAt)) + '</dd><dt>Due</dt><dd>' + esc(day(x.dueDate)) + '</dd><dt>Currency</dt><dd>' + esc(x.currency || '—') + '</dd></dl>' +
        (items.length ? '<div class="spc-sec">Line items (' + esc(x.itemCount) + ')</div><table class="sic-items">' + items.map((i) => '<tr><td>' + esc(i.description || '—') + (num(i.quantity) !== null ? ' <span class="spc-meta">× ' + esc(i.quantity) + '</span>' : '') + '</td><td>' + esc(num(i.total) === null ? '—' : (x.currency || 'KES') + ' ' + Number(i.total).toLocaleString('en-KE', { minimumFractionDigits: 2 })) + '</td></tr>').join('') + '</table>' : '') +
        '<dl class="sic-dl"><dt><strong>Total</strong></dt><dd><strong>' + esc(kes(x.totalCents, x.currency)) + '</strong></dd><dt>Paid (verified)</dt><dd>' + esc(kes(x.paidCents, x.currency)) + '</dd>' +
          '<dt><strong>Balance</strong></dt><dd><strong style="' + (x.display === 'overdue' ? 'color:var(--spc-bad)' : '') + '">' + esc(kes(x.balanceCents, x.currency)) + '</strong></dd></dl>' +
        '<div class="spc-sec">Payment</div><div class="spc-meta">' + payCell(x) + '</div>' +
        (x.paymentClaim ? '<div class="spc-meta" style="margin-top:6px">Claim reference ' + esc(x.paymentClaim.reference || '—') + (x.paymentClaim.method ? ' · ' + esc(x.paymentClaim.method) : '') + ' — a reference entered by a person, not a verified payment.</div>' : '') +
        (x.reviewFlag ? '<div class="sic-sub warn" style="margin-top:6px">Flagged for review: ' + esc(x.reviewFlag) + '</div>' : '') +
        '<div class="spc-sec">Audit</div><dl class="sic-dl"><dt>Created</dt><dd>' + esc(day(x.createdAt)) + (x.createdBy ? ' · ' + esc(x.createdBy) : '') + '</dd><dt>Last updated</dt><dd>' + esc(day(x.updatedAt)) + '</dd>' +
          (x.migratedAt ? '<dt>Migrated</dt><dd>' + esc(day(x.migratedAt)) + '</dd>' : '') +
          (x.legacy && x.legacy.status ? '<dt>Before migration</dt><dd>' + esc(x.legacy.status === 'paid' ? 'marked paid ' + day(x.legacy.markedPaidAt) + ' (unverified)' : x.legacy.status) + '</dd>' : '') + '</dl>' +
        '<p class="spc-note">Read-only. Payments are recorded only by the verified payment path; sending and voiding are the merchant\'s own actions.</p></aside>';
    }

    async function doExport() {
      st.exporting = true; render();
      try {
        const r = await call('adminInvoicesExport', { tab: st.tab });
        if (!r || typeof r.csv !== 'string') throw new Error('The server did not return an export.');
        const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sokoni-invoices-' + st.tab + '-' + new Date().toISOString().slice(0, 10) + '.csv';
        document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
        toast('Exported ' + r.rows + ' invoice' + (r.rows === 1 ? '' : 's') + (r.truncated ? ' (first 5,000 — narrow the tab for the rest)' : '') + ' — recorded in the audit log', 'success');
      } catch (e) { toast('Export failed — ' + ((e && e.message) || 'the server did not respond'), 'error'); }
      st.exporting = false; render();
    }

    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab],[data-act],[data-open]'); if (!t || !root.contains(t)) return;
      if (t.dataset.tab) { if (st.tab !== t.dataset.tab) { st.tab = t.dataset.tab; st.sel = null; load(false); } return; }
      if (t.dataset.open && !t.dataset.act) { st.sel = t.dataset.open; render(); return; }
      const a = t.dataset.act;
      if (a === 'close') { st.sel = null; render(); } else if (a === 'refresh') load(false); else if (a === 'more' && st.cursor) load(true); else if (a === 'export' && !st.exporting) doExport();
    });
    root.addEventListener('keydown', (e) => {
      const r = e.target.closest && e.target.closest('tr[data-open]');
      if (r && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); st.sel = r.dataset.open; render(); }
      if (e.key === 'Escape' && st.sel) { st.sel = null; render(); }
    });
    root.addEventListener('input', (e) => {
      if (e.target.dataset.in !== 'q') return;
      st.q = e.target.value.slice(0, 80); const pos = e.target.selectionStart; render();
      const i = root.querySelector('[data-in="q"]'); if (i) { i.focus(); try { i.setSelectionRange(pos, pos); } catch (_) {} }
    });
    load(false);
    return { reload: () => load(false), _state: st };
  }

  window.SokoniInvoicesConsole = { mount };
})();
