/* ════════════════════════════════════════════════════════════════════════════════════════════════════════
   SOKONI Invoices Console — ONE invoices page for AdminOS and Super Admin (owner 2026-10-04)
   ────────────────────────────────────────────────────────────────────────────────────────────────────────
   Scope (owner decision): MERCHANT invoices only — the `invoices` store. Read through ONE server call,
   adminInvoicesList (admin / superAdmin, read-only). Requires sokoni-products-console.js first (shared styles).

   Mount:  SokoniInvoicesConsole.mount(rootEl, { call, toast })

   DATA INTEGRITY: every figure is the server's — counts / totals / aging are Firestore aggregates computed by
   adminInvoicesList over the whole collection; a figure the server marks unavailable renders "—" with the reason,
   never 0 and never an estimate. Status (incl. overdue + days) is server-derived. Aging percentages are arithmetic
   on the server's own bucket sums. There is no "average days to pay" and no "vs last 30 days" trend — the server does
   not compute them, so they are not shown. Card brand / last-4 are not stored on an invoice, so they are not shown.
   "Paid" on a merchant invoice is RECORDED by the merchant (invoiceMarkPaid takes the merchant's own reference) — it is
   labelled "marked paid", never presented as a verified payment.
   This page is READ-ONLY: there is no admin invoice write authority (void / send / mark-paid are the merchant's,
   shop-scoped), so it offers no buttons that would do nothing. Export downloads the rows shown.
   ════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.SokoniInvoicesConsole) return;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
  const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
  const money = (v, cur) => { const n = num(v); return n === null ? '—' : (cur || 'KES') + ' ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  const big = (v) => { const n = num(v); return n === null ? '—' : 'KES ' + n.toLocaleString('en-KE', { maximumFractionDigits: 0 }); };
  const day = (iso) => { if (!iso) return '—'; const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };

  const CSS = `
  .sic-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin-bottom:14px}
  .sic-kpi{display:flex;gap:12px;align-items:center;padding:14px}
  .sic-ico{width:40px;height:40px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;flex:0 0 40px}
  .sic-kpi small{display:block;color:var(--spc-muted);font-size:12px}
  .sic-kpi b{font-size:20px;display:block;line-height:1.2}
  .sic-aging{padding:16px;margin-bottom:14px}
  .sic-ag-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:16px;margin-top:12px}
  .sic-ag small{color:var(--spc-muted);font-size:12px;display:block}
  .sic-ag b{font-size:17px}
  .sic-bar{height:5px;border-radius:5px;background:var(--spc-card2);margin-top:8px;overflow:hidden}
  .sic-bar i{display:block;height:100%;border-radius:5px}
  .sic-sub{font-size:11px;color:var(--spc-muted)} .sic-sub.bad{color:var(--spc-bad)} .sic-sub.ok{color:var(--spc-ok)}
  .sic-dl{display:grid;grid-template-columns:auto 1fr;gap:8px 12px;font-size:13px;margin:12px 0}
  .sic-dl dt{color:var(--spc-muted)} .sic-dl dd{margin:0;text-align:right}
  .sic-items{width:100%;border-collapse:collapse;font-size:12px;margin-top:6px}
  .sic-items td{padding:6px 0;border-bottom:1px solid var(--spc-line)} .sic-items td:last-child{text-align:right}
  .sic-unav{font-size:11px;color:var(--spc-muted)}
  `;
  function injectCss() {
    if (window.SokoniConsoleStyles) window.SokoniConsoleStyles.inject();
    if (document.getElementById('sic-css')) return;
    const s = document.createElement('style'); s.id = 'sic-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  const TABS = [
    { key: 'all', label: 'All Invoices' }, { key: 'draft', label: 'Draft' }, { key: 'open', label: 'Open' },
    { key: 'overdue', label: 'Overdue', tone: 'warn' }, { key: 'paid', label: 'Paid' }, { key: 'void', label: 'Void', tone: 'bad' },
  ];
  const STATUS = { draft: ['Draft', 'muted'], open: ['Open', 'warn'], overdue: ['Overdue', 'bad'], paid: ['Paid', 'ok'], void: ['Void', 'muted'] };
  const UNAV = { index_missing: 'database index not deployed yet', unavailable: 'not available right now' };

  function mount(root, opts) {
    if (!root) return null;
    injectCss();
    const o = opts || {};
    const call = o.call, toast = o.toast || (() => {});
    const st = { tab: 'all', q: '', rows: [], summary: null, cursor: null, loading: false, more: false, error: null, sel: null };
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
      } catch (e) {
        if (!append) st.rows = [];
        st.error = (e && e.message) ? String(e.message) : 'Invoices could not be loaded.';
      }
      st.loading = false; st.more = false;
      if (st.sel && !st.rows.some((x) => x.id === st.sel)) st.sel = null;
      render();
    }

    const sm = () => st.summary || {};
    const why = (label) => { const u = sm().unavailable || {}; return u[label] ? (UNAV[u[label]] || u[label]) : null; };
    function count(key) { const c = sm().counts || {}; const v = num(c[key]); return v === null ? '—' : v.toLocaleString('en-KE'); }
    function shown() {
      const q = st.q.toLowerCase();
      return q ? st.rows.filter((x) => [x.invoiceNumber, x.clientName, x.clientEmail, x.shopName, x.id].some((v) => v && String(v).toLowerCase().includes(q))) : st.rows;
    }
    function pill(x) { const s = STATUS[x.display] || [x.display || '—', 'muted']; return '<span class="spc-pill ' + s[1] + '">' + esc(s[0]) + '</span>'; }
    function dueSub(x) {
      if (x.display === 'overdue') return '<div class="sic-sub bad">' + esc(x.daysOverdue) + ' day' + (x.daysOverdue === 1 ? '' : 's') + ' overdue</div>';
      if (x.display === 'open' && x.daysLeft !== null && x.daysLeft !== undefined) return '<div class="sic-sub">' + esc(x.daysLeft) + ' day' + (x.daysLeft === 1 ? '' : 's') + ' left</div>';
      if (x.display === 'paid' && x.paidAt) return '<div class="sic-sub ok">Marked paid ' + esc(day(x.paidAt)) + '</div>';
      if (x.display === 'void' && x.voidedAt) return '<div class="sic-sub">Voided on ' + esc(day(x.voidedAt)) + '</div>';
      return '';
    }
    function kpi(ico, bg, label, value, unavLabel) {
      const w = unavLabel ? why(unavLabel) : null;
      return '<div class="spc-card sic-kpi"><span class="sic-ico" style="background:' + bg + '" aria-hidden="true">' + ico + '</span><div><small>' + esc(label) + '</small><b>' + esc(value) + '</b>' + (w ? '<span class="sic-unav">' + esc(w) + '</span>' : '') + '</div></div>';
    }
    function aging() {
      const a = sm().aging || {};
      const parts = [['Current (not yet due)', a.current, 'agingCurrent', 'var(--spc-ok)'], ['1–30 days overdue', a.d1_30, 'aging1_30', 'var(--spc-warn)'], ['31–60 days', a.d31_60, 'aging31_60', '#fb923c'], ['61–90 days', a.d61_90, 'aging61_90', 'var(--spc-bad)'], ['91+ days', a.d91plus, 'aging91', '#ef4444']];
      const total = num(sm().openAmount);
      return '<div class="spc-card sic-aging"><div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap"><div><strong>Aging summary</strong><div class="sic-sub">Open amount ' + esc(big(total)) + (num(a.undated) ? ' · ' + esc(big(a.undated)) + ' on invoices with no due date' : '') + '</div></div>' +
        '<div class="sic-sub">As of ' + esc(day(sm().asOf)) + '</div></div><div class="sic-ag-grid">' + parts.map(([l, v, k, c]) => {
          const n = num(v); const pct = n !== null && total ? Math.round((n / total) * 1000) / 10 : null; const w = why(k);
          return '<div class="sic-ag"><small>' + esc(l) + '</small><b>' + esc(big(n)) + '</b> <span class="sic-sub">' + (pct === null ? '' : pct + '%') + '</span>' +
            (w ? '<div class="sic-unav">' + esc(w) + '</div>' : '<div class="sic-bar" aria-hidden="true"><i style="width:' + (pct || 0) + '%;background:' + c + '"></i></div>') + '</div>';
        }).join('') + '</div></div>';
    }

    function render() {
      const rows = shown();
      const sel = st.sel ? st.rows.find((x) => x.id === st.sel) : null;
      const s = sm();
      root.innerHTML =
        '<div class="spc-head"><div><h2 class="spc-title">Invoices</h2><p class="spc-sub">Merchant invoices across SOKONI — totals, aging and status, computed by the server.</p></div>' +
          '<div style="display:flex;gap:8px;flex-wrap:wrap"><button class="spc-btn" data-act="export"' + (rows.length ? '' : ' disabled') + '>⤓ Export</button><button class="spc-btn" data-act="refresh">↻ Refresh</button></div></div>' +
        '<div class="spc-tabs" role="tablist" aria-label="Invoice status">' + TABS.map((t) => '<button class="spc-tab" role="tab" data-tab="' + t.key + '" aria-selected="' + (t.key === st.tab) + '">' + esc(t.label) + ' <span class="spc-count' + (t.tone ? ' ' + t.tone : '') + '">' + count(t.key) + '</span></button>').join('') + '</div>' +
        (st.summary ? '<div class="sic-kpis">' +
          kpi('🧾', 'rgba(109,93,252,.18)', 'Total invoiced (sent + paid)', big(s.totalInvoiced), 'invoiced') +
          kpi('✓', 'rgba(52,211,153,.16)', 'Marked paid (last 30 days)', big(s.paidLast30Days), 'paid30') +
          kpi('◷', 'rgba(245,158,11,.16)', 'Open amount', big(s.openAmount), 'open') +
          kpi('!', 'rgba(248,113,113,.16)', 'Overdue amount', big(s.overdueAmount), 'overdue') +
        '</div>' + aging() : '') +
        (st.error ? '<div class="spc-err" role="alert">Could not load invoices — ' + esc(st.error) + '</div>' : '') +
        '<div class="spc-bar"><input class="spc-input" type="search" data-in="q" placeholder="Search the loaded invoices by number, customer or shop…" value="' + esc(st.q) + '" aria-label="Search invoices"></div>' +
        '<div class="spc-layout' + (sel ? ' has-drawer' : '') + '"><div class="spc-card">' +
          (st.loading ? '<div class="spc-empty">Loading invoices…</div>' : !rows.length ? '<div class="spc-empty">' + (st.error ? 'No invoices to show.' : st.q ? 'No loaded invoice matches.' : 'No invoices.') + '</div>' :
            '<div class="spc-tablewrap"><table class="spc-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Shop</th><th>Status</th><th>Due date</th><th style="text-align:right">Total</th><th style="text-align:right">Balance due</th><th>Payment</th></tr></thead><tbody>' +
            rows.map((x) => '<tr class="spc-row" data-open="' + esc(x.id) + '" aria-selected="' + (x.id === st.sel) + '" tabindex="0">' +
              '<td class="spc-mono" style="color:#a5b4fc">' + esc(x.invoiceNumber || x.id) + '</td>' +
              '<td><div class="spc-pname">' + esc(x.clientName || '—') + '</div><div class="spc-meta">' + esc(x.clientEmail || '') + '</div></td>' +
              '<td class="spc-meta">' + esc(x.shopName || x.shopId || '—') + '</td>' +
              '<td>' + pill(x) + '</td>' +
              '<td>' + esc(day(x.dueDate)) + dueSub(x) + '</td>' +
              '<td style="text-align:right;font-weight:600">' + esc(money(x.total, x.currency)) + '</td>' +
              '<td style="text-align:right;' + (x.display === 'overdue' ? 'color:var(--spc-bad);font-weight:600' : '') + '">' + esc(money(x.balanceDue, x.currency)) + '</td>' +
              '<td class="spc-meta">' + esc(x.paymentMethod || '—') + '</td></tr>').join('') + '</tbody></table></div>') +
          '<div class="spc-foot"><span>' + (st.loading ? '' : 'Showing ' + rows.length + ' of ' + st.rows.length + ' loaded' + (st.q ? ' (search applies to loaded rows)' : '')) + '</span>' +
            (st.cursor ? '<button class="spc-btn" data-act="more"' + (st.more ? ' disabled' : '') + '>' + (st.more ? 'Loading…' : 'Load more') + '</button>' : '') + '</div>' +
        '</div>' + (sel ? drawer(sel) : '') + '</div>';
    }

    function drawer(x) {
      const items = Array.isArray(x.items) ? x.items : [];
      const paid = x.status === 'paid' ? num(x.total) : (x.status === 'void' ? null : 0);
      return '<aside class="spc-card spc-drawer" role="dialog" aria-label="Invoice ' + esc(x.invoiceNumber || x.id) + '">' +
        '<div class="spc-dh"><div style="flex:1;min-width:0"><h3 class="spc-dtitle">Invoice ' + esc(x.invoiceNumber || x.id) + '</h3>' +
          '<div style="margin-top:6px;display:flex;gap:6px;align-items:center;flex-wrap:wrap">' + pill(x) + dueSub(x).replace('<div', '<span').replace('</div>', '</span>') + '</div></div>' +
          '<button class="spc-x" data-act="close" aria-label="Close details">×</button></div>' +
        '<div class="spc-box"><div class="spc-pname">' + esc(x.clientName || '—') + '</div><div class="spc-meta">' + esc(x.clientEmail || '') + (x.clientPhone ? ' · ' + esc(x.clientPhone) : '') + '</div>' +
          '<div class="spc-meta" style="margin-top:4px">Billed by ' + esc(x.shopName || x.shopId || '—') + '</div></div>' +
        '<dl class="sic-dl"><dt>Invoice date</dt><dd>' + esc(day(x.createdAt)) + '</dd><dt>Due date</dt><dd>' + esc(day(x.dueDate)) + '</dd>' +
          (x.sentAt ? '<dt>Sent</dt><dd>' + esc(day(x.sentAt)) + '</dd>' : '') + '<dt>Currency</dt><dd>' + esc(x.currency || '—') + '</dd>' +
          '<dt>Billing</dt><dd>' + (x.recurring === true ? 'Recurring' : x.recurring ? esc(x.recurring) : '—') + '</dd></dl>' +
        (items.length ? '<div class="spc-sec">Line items (' + esc(x.itemCount) + ')</div><table class="sic-items">' + items.map((i) => '<tr><td>' + esc(i.description || '—') + (num(i.quantity) !== null ? ' <span class="spc-meta">× ' + esc(i.quantity) + '</span>' : '') + '</td><td>' + esc(money(i.total, x.currency)) + '</td></tr>').join('') + '</table>' : '') +
        '<dl class="sic-dl"><dt>Subtotal</dt><dd>' + esc(money(x.subtotal, x.currency)) + '</dd><dt>Tax' + (num(x.taxRate) !== null ? ' (' + esc(x.taxRate) + '%)' : '') + '</dt><dd>' + esc(money(x.tax, x.currency)) + '</dd>' +
          '<dt><strong>Total</strong></dt><dd><strong>' + esc(money(x.total, x.currency)) + '</strong></dd>' +
          '<dt>Marked paid</dt><dd>' + esc(paid === null ? '—' : money(paid, x.currency)) + '</dd>' +
          '<dt><strong>Balance due</strong></dt><dd><strong style="' + (x.display === 'overdue' ? 'color:var(--spc-bad)' : '') + '">' + esc(money(x.balanceDue, x.currency)) + '</strong></dd></dl>' +
        '<div class="spc-sec">Payment</div><div class="spc-meta">' + (x.paymentMethod ? 'Method: ' + esc(x.paymentMethod) : 'No payment recorded') + (x.paymentReferenced ? ' · a payment reference was entered by the merchant (not a verified payment)' : '') + '</div>' +
        (x.notes ? '<div class="spc-sec">Notes</div><div class="spc-meta" style="white-space:pre-wrap">' + esc(x.notes) + '</div>' : '') +
        '<p class="spc-note">Read-only. Sending, voiding and recording payment are the merchant\'s own actions on their invoice.</p></aside>';
    }

    function exportCsv() {
      const rows = shown();
      const head = ['id', 'invoiceNumber', 'clientName', 'clientEmail', 'shop', 'status', 'dueDate', 'total', 'balanceDue', 'currency', 'paymentMethod', 'createdAt'];
      const cell = (v) => { const s = v == null ? '' : String(v); const safe = /^[=+\-@\t\r]/.test(s) ? "'" + s : s; return '"' + safe.replace(/"/g, '""') + '"'; };
      const lines = [head.join(',')].concat(rows.map((x) => [x.id, x.invoiceNumber, x.clientName, x.clientEmail, x.shopName || x.shopId, x.display, x.dueDate, x.total, x.balanceDue, x.currency, x.paymentMethod, x.createdAt].map(cell).join(',')));
      const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = 'sokoni-invoices-' + new Date().toISOString().slice(0, 10) + '.csv';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    }

    root.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab],[data-act],[data-open]'); if (!t || !root.contains(t)) return;
      if (t.dataset.tab) { if (st.tab !== t.dataset.tab) { st.tab = t.dataset.tab; st.sel = null; load(false); } return; }
      if (t.dataset.open && !t.dataset.act) { st.sel = t.dataset.open; render(); return; }
      const a = t.dataset.act;
      if (a === 'close') { st.sel = null; render(); } else if (a === 'refresh') load(false); else if (a === 'more' && st.cursor) load(true); else if (a === 'export') exportCsv();
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
