/* ════════════════════════════════════════════════════════════════════════════
   SOKONI FINANCE CENTER — window.SokoniFinanceCenter
   ONE renderer for every financial record view in AdminOS and Super Admin (owner 2026-10-04):
   KPI tiles · status tabs with counts · aging summary · records table with status pills ·
   right-hand detail drawer. Pairs with sokoni-finance-center.css (everything under .sfc).

   It FETCHES NOTHING and DECIDES NOTHING. Each page passes the rows its existing callables
   returned and the actions it already had; this module only lays them out. Rules it keeps:
     • UI DATA INTEGRITY — a KPI value that is null/undefined renders "—", never 0, and the
       module never sums rows into a total. Counts are only "rows in this list".
     • Actions are real functions (no onclick strings built from record ids), so a record id
       can never inject script; every text value is escaped.
   ════════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  const REG = {};          /* tableId → { rows, cfg } */
  let SEQ = 0;

  const esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const isNum = (v) => typeof v === 'number' && isFinite(v);
  /** KES from shillings. Unknown → "—" (never 0). */
  const kes = (v) => (isNum(v) ? 'KES ' + Math.round(v).toLocaleString('en-KE') : '—');
  const kesCents = (v) => (isNum(v) ? 'KES ' + (v / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—');
  const num = (v) => (isNum(v) ? v.toLocaleString('en-KE') : '—');
  const pct = (v) => (isNum(v) ? (v * (Math.abs(v) <= 1 ? 100 : 1)).toFixed(1) + '%' : '—');
  const date = (v) => {
    if (!v) return '—';
    try {
      const d = v.toDate ? v.toDate() : (v._seconds ? new Date(v._seconds * 1000) : (v.seconds ? new Date(v.seconds * 1000) : new Date(v)));
      return isNaN(d) ? '—' : d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
    } catch (_) { return '—'; }
  };
  const ms = (v) => {
    if (!v) return null;
    try { const d = v.toDate ? v.toDate() : (v._seconds ? new Date(v._seconds * 1000) : (v.seconds ? new Date(v.seconds * 1000) : new Date(v))); return isNaN(d) ? null : d.getTime(); } catch (_) { return null; }
  };

  const TONE = {
    complete: 'green', completed: 'green', paid: 'green', success: 'green', successful: 'green', settled: 'green', released: 'green', approved: 'green', active: 'green', resolved: 'green',
    pending: 'amber', requested: 'amber', processing: 'amber', held: 'violet', open: 'amber', review: 'amber', partially_released: 'blue', queued: 'blue',
    failed: 'red', rejected: 'red', cancelled: 'red', canceled: 'red', refunded: 'blue', refund_due: 'red', overdue: 'red', disputed: 'red', void: '',
  };
  const pill = (status) => { const s = String(status || '—'); const k = s.toLowerCase().replace(/\s+/g, '_'); return '<span class="sfc-pill ' + (TONE[k] || '') + '">' + esc(s.replace(/_/g, ' ')) + '</span>'; };

  /* ── building blocks ── */
  function header(o) {
    return '<div class="sfc-head"><div><div class="sfc-title"><span class="sfc-dot"></span>' + esc(o.title) + '</div>'
      + (o.subtitle ? '<div class="sfc-sub">' + esc(o.subtitle) + '</div>' : '') + '</div>'
      + '<div class="sfc-actions">' + (o.actionsHtml || '') + '</div></div>';
  }
  /** tabs: [{ key, label, count? }] — count shown only when the caller knows it */
  function tabs(list, active, group) {
    return '<div class="sfc-tabs" role="tablist">' + list.map((t) => '<button type="button" class="sfc-tab' + (t.key === active ? ' on' : '') + '" role="tab" aria-selected="' + (t.key === active) + '" data-sfc-tab="' + esc(t.key) + '" data-sfc-group="' + esc(group || '') + '">'
      + esc(t.label) + (isNum(t.count) ? '<span class="sfc-count">' + num(t.count) + '</span>' : '') + '</button>').join('') + '</div>';
  }
  /** kpis: [{ label, value (preformatted string|null), tone, icon, sub }] — null → "—" */
  function kpis(list) {
    return '<div class="sfc-kpis">' + list.map((k) => {
      const unknown = k.value == null || k.value === '—';
      return '<div class="sfc-kpi"><div class="sfc-kpi-ico ' + esc(k.tone || 'violet') + '" aria-hidden="true">' + (k.icon || '◆') + '</div><div style="min-width:0">'
        + '<div class="sfc-kpi-l">' + esc(k.label) + '</div><div class="sfc-kpi-v' + (unknown ? ' unknown' : '') + '">' + (unknown ? '—' : esc(k.value)) + '</div>'
        + (k.sub ? '<div class="sfc-kpi-s">' + esc(k.sub) + '</div>' : '') + '</div></div>';
    }).join('') + '</div>';
  }
  /** aging: { title, note, buckets:[{ label, sub, value (string), share (0..1|null), tone }] } */
  function aging(o) {
    return '<div class="sfc-card"><div class="sfc-card-h"><div><b>' + esc(o.title) + '</b>' + (o.subtitle ? '<div class="sfc-sub">' + esc(o.subtitle) + '</div>' : '') + '</div>'
      + (o.note ? '<small>' + esc(o.note) + '</small>' : '') + '</div><div class="sfc-aging">' + o.buckets.map((b) =>
      '<div><div class="sfc-age-l">' + esc(b.label) + '</div>' + (b.sub ? '<div class="sfc-age-sub">' + esc(b.sub) + '</div>' : '')
      + '<div class="sfc-age-row"><span class="sfc-age-v">' + esc(b.value) + '</span><span class="sfc-age-p">' + (isNum(b.share) ? (b.share * 100).toFixed(1) + '%' : '') + '</span></div>'
      + '<div class="sfc-bar"><i class="' + esc(b.tone || 'green') + '" style="width:' + (isNum(b.share) ? Math.max(0, Math.min(100, b.share * 100)) : 0) + '%"></i></div></div>').join('') + '</div></div>';
  }
  /**
   * table({ columns:[{ label, align:'r', render(row)→html }], rows, title, searchText(row)→string,
   *         detail(row)→{ title, status, subtitle, fields:[[label, html]], sections:[{ title, fields }], actions:[{ label, tone, run(row) }], note },
   *         empty, footNote })
   */
  function table(cfg) {
    const id = 'sfct' + (++SEQ);
    REG[id] = { rows: cfg.rows || [], cfg };
    const rows = REG[id].rows;
    const head = '<tr>' + cfg.columns.map((c) => '<th class="' + (c.align === 'r' ? 'r' : '') + '">' + esc(c.label) + '</th>').join('') + '</tr>';
    const body = rows.length ? rows.map((r, i) => '<tr data-sfc-row="' + i + '" data-sfc-table="' + id + '" tabindex="0">' + cfg.columns.map((c) =>
      '<td class="' + (c.align === 'r' ? 'r ' : '') + (c.mono ? 'mono' : '') + '">' + c.render(r) + '</td>').join('') + '</tr>').join('')
      : '<tr><td colspan="' + cfg.columns.length + '"><div class="sfc-empty">' + esc(cfg.empty || 'No records') + '</div></td></tr>';
    return '<div class="sfc-tablecard"><div class="sfc-toolbar"><input class="sfc-search" type="search" placeholder="Search ' + esc(cfg.title || 'records') + '…" aria-label="Search" data-sfc-search="' + id + '">'
      + '<span class="sfc-meta" data-sfc-meta="' + id + '">' + num(rows.length) + ' in this list</span></div>'
      + '<div class="sfc-scroll"><table class="sfc-table" id="' + id + '"><thead>' + head + '</thead><tbody>' + body + '</tbody></table></div>'
      + (cfg.footNote ? '<div class="sfc-foot">' + esc(cfg.footNote) + '</div>' : '') + '</div>';
  }

  /* ── drawer ── */
  let drawer = null, scrim = null, current = null;
  function ensureDrawer() {
    if (drawer) return;
    scrim = document.createElement('div'); scrim.className = 'sfc sfc-dscrim';
    drawer = document.createElement('aside'); drawer.className = 'sfc sfc-drawer'; drawer.setAttribute('role', 'dialog'); drawer.setAttribute('aria-modal', 'true'); drawer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(scrim); document.body.appendChild(drawer);
    scrim.addEventListener('click', close);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) close(); });
  }
  function dl(fields) { return '<dl class="sfc-dl">' + (fields || []).map(([l, v]) => '<dt>' + esc(l) + '</dt><dd>' + (v == null || v === '' ? '—' : v) + '</dd>').join('') + '</dl>'; }
  function open(d, row) {
    ensureDrawer(); current = { d, row };
    drawer.innerHTML = '<div class="sfc-dh"><div style="min-width:0"><b>' + esc(d.title || 'Record') + '</b><div class="sfc-sub">' + (d.status ? pill(d.status) : '') + (d.subtitle ? '<span>' + esc(d.subtitle) + '</span>' : '') + '</div></div>'
      + '<button type="button" class="sfc-x" aria-label="Close" data-sfc-close>×</button></div>'
      + '<div class="sfc-db">' + dl(d.fields) + (d.sections || []).map((s) => '<div class="sfc-dsec"><h4>' + esc(s.title) + '</h4>' + dl(s.fields) + '</div>').join('')
      + (d.note ? '<div class="sfc-note">' + esc(d.note) + '</div>' : '') + '</div>'
      + ((d.actions && d.actions.length) ? '<div class="sfc-df">' + d.actions.map((a, i) => '<button type="button" class="sfc-btn sm ' + esc(a.tone || '') + '" data-sfc-act="' + i + '">' + esc(a.label) + '</button>').join('') + '</div>' : '');
    drawer.classList.add('open'); scrim.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    const x = drawer.querySelector('[data-sfc-close]'); if (x) x.focus();
  }
  function close() { if (!drawer) return; drawer.classList.remove('open'); scrim.classList.remove('open'); drawer.setAttribute('aria-hidden', 'true');
    document.querySelectorAll('.sfc-table tr.on').forEach((t) => t.classList.remove('on')); current = null; }

  /* ── one delegated handler for every mounted view ── */
  const tabHandlers = {};
  function onTab(group, fn) { tabHandlers[group] = fn; }
  document.addEventListener('click', (e) => {
    const t = e.target.closest && e.target.closest('[data-sfc-tab]');
    if (t) { const g = t.getAttribute('data-sfc-group'); if (tabHandlers[g]) tabHandlers[g](t.getAttribute('data-sfc-tab')); return; }
    if (e.target.closest && e.target.closest('[data-sfc-close]')) { close(); return; }
    const a = e.target.closest && e.target.closest('[data-sfc-act]');
    if (a && current) { const act = current.d.actions[Number(a.getAttribute('data-sfc-act'))]; if (act && typeof act.run === 'function') { close(); act.run(current.row); } return; }
    const tr = e.target.closest && e.target.closest('tr[data-sfc-row]');
    if (tr) { const reg = REG[tr.getAttribute('data-sfc-table')]; if (!reg || !reg.cfg.detail) return;
      document.querySelectorAll('.sfc-table tr.on').forEach((x) => x.classList.remove('on')); tr.classList.add('on');
      const row = reg.rows[Number(tr.getAttribute('data-sfc-row'))]; open(reg.cfg.detail(row), row); }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return; const tr = e.target.closest && e.target.closest('tr[data-sfc-row]'); if (tr) tr.click();
  });
  document.addEventListener('input', (e) => {
    const id = e.target.getAttribute && e.target.getAttribute('data-sfc-search'); if (!id || !REG[id]) return;
    const q = e.target.value.trim().toLowerCase(); const reg = REG[id]; let shown = 0;
    document.querySelectorAll('#' + id + ' tbody tr[data-sfc-row]').forEach((tr) => {
      const row = reg.rows[Number(tr.getAttribute('data-sfc-row'))];
      const hay = (reg.cfg.searchText ? reg.cfg.searchText(row) : JSON.stringify(row)).toLowerCase();
      const ok = !q || hay.indexOf(q) >= 0; tr.style.display = ok ? '' : 'none'; if (ok) shown++;
    });
    const meta = document.querySelector('[data-sfc-meta="' + id + '"]'); if (meta) meta.textContent = (q ? shown + ' of ' : '') + reg.rows.length + ' in this list';
  });

  /** age buckets for a list of dates (counts only — never a money total over a partial list) */
  function ageBuckets(rows, dateOf, now) {
    const n = now || Date.now(); const b = [0, 0, 0, 0]; let known = 0;
    rows.forEach((r) => { const t = ms(dateOf(r)); if (t == null) return; known++; const d = (n - t) / 86400000; b[d <= 7 ? 0 : d <= 30 ? 1 : d <= 60 ? 2 : 3]++; });
    const lab = [['0–7 days', 'green'], ['8–30 days', 'amber'], ['31–60 days', 'red'], ['60+ days', 'red']];
    return { known, buckets: b.map((c, i) => ({ label: lab[i][0], value: num(c) + (c === 1 ? ' request' : ' requests'), share: known ? c / known : null, tone: lab[i][1] })) };
  }

  window.SokoniFinanceCenter = { esc, kes, kesCents, num, pct, date, pill, header, tabs, kpis, aging, table, open, close, onTab, ageBuckets, _reg: REG };
})();
