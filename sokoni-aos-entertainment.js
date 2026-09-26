/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-aos-entertainment.js — AdminOS › Entertainment controls.

   Mount contract (same as sokoni-aos-creator):
     window.SokoniAOSEntertainment.mount({ host, call }) → true when rendered
   `call(op, data)` is AdminOS's own _call(). The eventAdmin* / entAdmin* ops are
   whitelisted in sokoni-aos.js (via OPS below) and route through adminOsDispatch,
   whose handlers (functions/event-settlement.js, functions/entertainment-admin.js)
   each re-check the admin claim. Refunds are submitted through the CANONICAL
   fosSubmitRefund (financial-os) — this panel never moves money itself.

   Creator Hub keeps its own panel (sokoni-aos-creator.js); Streaming is a Creator
   content type and is administered there. This panel covers Events, venue and
   artist moderation, and the category / commercial-policy matrix.

   Unknown figures render "—", never 0 (CLAUDE.md UI Data Integrity).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const TABS = [
    ['overview', 'Overview'], ['investigate', 'Investigate'], ['events', 'Events'], ['eventops', 'Staff & gate'], ['settlements', 'Settlements'],
    ['refunds', 'Refund queue'], ['refundreq', 'Refund requests'], ['receivables', 'Receivables'], ['fiscal', 'Fiscal (KRA)'],
    ['exceptions', 'Exceptions'], ['listings', 'Venues & artists'], ['matrix', 'Categories & policy'],
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  function kes(cents) {
    if (cents == null || !Number.isFinite(Number(cents))) return '—';
    return 'KES ' + (Number(cents) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-KE'));
  const when = (v) => { if (!v) return '—'; const t = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(t) ? new Date(t).toLocaleString('en-KE') : '—'; };
  const chip = (s) => `<span class="aos-badge" data-state="${esc(s)}">${esc(s || '—')}</span>`;
  const table = (head, rows, empty) => (rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="aos-muted">${esc(empty)}</p>`);
  const counts = (o) => (o == null ? '—' : Object.entries(o).map(([k, v]) => `${esc(k)}: ${num(v)}`).join(' · ') || 'none');

  function mount(opts) {
    const host = opts && opts.host;
    const call = opts && opts.call;
    if (!host || typeof call !== 'function') return false;
    let tab = 'overview';
    let listingKind = 'venue', listingStatus = 'pending';
    /* Investigation state survives a re-render (after an action) — the PIN itself is never kept. */
    let search = null, traced = null, opsEvent = '', rqStatus = '', rvStatus = 'OUTSTANDING', fView = '';

    host.innerHTML = `
      <div class="aoscr-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" class="aos-btn aos-btn-ghost" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <div class="aoscr-msg" id="aosentMsg" role="status" aria-live="polite"></div>
      <div id="aosentBody"><div class="aos-spinner"><div></div></div></div>`;
    const body = host.querySelector('#aosentBody');
    const msg = (t, bad) => { const m = host.querySelector('#aosentMsg'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };

    async function act(op, data, okText) {
      msg('Working…');
      try { const r = await call(op, data); msg(okText || 'Done.'); await render(); return r; }
      catch (e) { msg((e && e.message) || 'Failed.', true); return null; }
    }
    /* Inline reason form (no window.prompt) — reasons are required server-side. */
    function ask(label, fields, onOk) {
      const d = document.createElement('div');
      d.className = 'aoscr-ask';
      d.innerHTML = `${fields.map((f) => `<label>${esc(f.label)}${f.area ? '<textarea rows="2" maxlength="500"></textarea>' : `<input type="${f.type || 'text'}" ${f.step ? `step="${f.step}"` : ''}>`}</label>`).join('')}
        <button type="button" class="aos-btn">${esc(label)}</button> <button type="button" class="aos-btn aos-btn-ghost">Cancel</button>`;
      body.prepend(d);
      const inputs = d.querySelectorAll('input,textarea');
      const [ok, cancel] = d.querySelectorAll('button');
      cancel.onclick = () => d.remove();
      ok.onclick = () => { const vals = [...inputs].map((i) => i.value); d.remove(); onOk(vals); };
      if (inputs[0]) inputs[0].focus();
    }

    /* ── Event investigation helpers ─────────────────────────────────────────────── */
    const BY = [['event', 'Event id'], ['ticketNumber', 'Ticket number (SK-EVT-YYYY-NNNNNN)'], ['ticket', 'Ticket id'], ['order', 'Order id'], ['sale', 'Sale id'],
      ['paymentRef', 'Payment reference'], ['buyer', 'Buyer uid'], ['cashier', 'Cashier uid'], ['cardRef', 'Card terminal reference'], ['pin', 'Ticket PIN (with event id)'],
      ['admissionStatus', 'Admission status (with event id)'], ['refundStatus', 'Refund status (with event id)'], ['fiscalStatus', 'Fiscal status (KRA)']];
    const fchip = (f) => chip(f && f.status ? f.status : '—');
    const trBtn = (kind, id) => `<button type="button" class="aos-btn aos-btn-ghost" data-trace-${kind}="${esc(id)}">Trace</button>`;
    /* A record's plain fields; *Cents render as money, nested objects are summarised. */
    function kv(o) {
      if (!o) return '<span class="aos-muted">—</span>';
      const rows = Object.entries(o).filter(([, v]) => v == null || typeof v !== 'object').slice(0, 24)
        .map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td class="aos-mono">${/Cents$/.test(k) ? kes(v) : /(At|Date|After)$/.test(k) && typeof v === 'number' ? when(v) : esc(v == null ? '—' : v)}</td></tr>`).join('');
      return `<div class="aos-table-wrap"><table class="aos-table">${rows}</table></div>`;
    }
    function traceView(t) {
      const body = (s) => {
        if (s.stage === 'tickets') {
          return table(['Ticket', 'Tier', 'Status', 'Admission', 'Refund'], (s.record || []).map((x) => `<tr><td class="aos-mono">${esc(x.ticketNumber || x.id)}</td><td>${esc(x.tierName)}</td>
            <td>${chip(x.status)}</td><td>${x.admission ? 'admitted ' + when(x.admission.admittedAt) + ' by ' + esc(x.admission.admittedBy) : esc(x.admissionStatus || '—')}</td><td>${chip(x.refundStatus)}</td></tr>`).join(''), 'No tickets.');
        }
        if (s.stage === 'refund') return s.record && (s.record.request || s.record.refund) ? `<h5>Request</h5>${kv(s.record.request)}<h5>Refund authority</h5>${kv(s.record.refund)}` : '';
        return s.record ? kv(s.record) : '';
      };
      return `<p><button type="button" class="aos-btn aos-btn-ghost" data-untrace="1">← Back to results</button></p>
        <h4>Financial trace · ${esc(t.orderId || t.saleId)} · ${esc(t.channel)}${t.paymentRef ? ' · payment ' + esc(t.paymentRef) : ''}</h4>
        <ol class="aos-trace">${t.stages.map((s) => `<li><strong>${esc(s.stage.replace('_', ' '))}</strong> ${chip(s.state)}${s.note ? `<div class="aos-muted">${esc(s.note)}</div>` : ''}${body(s)}</li>`).join('')}</ol>`;
    }

    /* A fiscal (KRA eTIMS) record: KRA values shown only as KRA returned them; retry reuses eTIMS. */
    const FISCAL_HEAD = ['Sale', 'Event', 'Channel', 'Gross', 'Fiscal', 'Invoice', 'KRA receipt', 'Reversal', ''];
    function fiscalRow(f) {
      const v = f.view || {};
      const canRetry = v.status && v.status !== 'CONFIRMED' && v.status !== 'NOT_APPLICABLE';
      const tr = f.orderId ? trBtn('order', f.orderId) : (f.saleId ? trBtn('sale', f.saleId) : '');
      return `<tr><td class="aos-mono">${esc(f.saleKey || f.id)}</td><td class="aos-mono">${esc(f.eventId)}</td><td>${esc(f.channel)}</td><td>${kes(f.grossCents)}</td>
        <td>${chip(v.status)}${f.error ? `<div class="aos-muted">${esc(f.error)}</div>` : ''}</td><td class="aos-mono">${esc(v.invoiceNumber || f.invoiceNumber || '—')}</td>
        <td class="aos-mono">${esc(v.receiptNumber || '—')}</td><td>${f.reversal ? chip(f.reversal.status) : '—'}</td>
        <td>${canRetry ? `<button type="button" class="aos-btn aos-btn-ghost" data-fiscal-retry="${esc(f.saleKey || f.id)}">Retry</button> ` : ''}${tr}</td></tr>`;
    }

    const R = {
      async fiscal() {
        const r = await call('eventAdminFiscal', fView ? { view: fView } : {});
        const filt = `<div class="aos-filters"><label>Show <select data-fview><option value="">Everything needing attention</option>${['FAILED', 'PENDING', 'NOT_REGISTERED', 'CREDIT_NOTE_REQUIRED'].map((x) => `<option ${x === fView ? 'selected' : ''}>${x}</option>`).join('')}</select></label></div>`;
        return filt + '<p class="aos-muted">Event ticket sales on KRA eTIMS (invoices under the organizer). Payment, ticket and admission never depend on this: a ticket stays valid while its fiscal record is reconciled. Nothing here is fabricated — a KRA receipt and QR exist only when KRA accepted the invoice.</p>'
          + table(FISCAL_HEAD, (r.fiscal || []).map(fiscalRow).join(''), 'Nothing to reconcile.');
      },
      async investigate() {
        const cur = search ? search.q : { by: 'event' };
        const form = `<form class="aos-filters" data-evsearch>
          <label>Search by <select name="by">${BY.map(([k, l]) => `<option value="${k}" ${k === cur.by ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select></label>
          <label>Value <input name="value" autocomplete="off" spellcheck="false" maxlength="128" value="${cur.by === 'pin' ? '' : esc(cur.value || '')}"></label>
          <label>Event id (PIN / status search) <input name="eventId" autocomplete="off" maxlength="128" value="${esc(cur.eventId || '')}"></label>
          <button type="submit" class="aos-btn">Search</button></form>
          <p class="aos-muted">Every PIN search is audited. PINs show as •••• — never displayed or stored; a PIN search returns only the ticket it belongs to.</p>`;
        if (traced) return form + traceView(traced);
        if (!search) return form;
        const r = search.result;
        const tix = r.tickets.map((x) => `<tr><td class="aos-mono">${esc(x.ticketNumber || x.id)}</td><td class="aos-mono">${esc(x.pinDisplay || '—')}</td><td class="aos-mono">${esc(x.eventId)}</td><td>${esc(x.tierName)}</td><td>${chip(x.status)}</td>
          <td>${esc(x.admissionStatus || '—')}</td><td>${chip(x.refundStatus)}</td><td>${fchip(x.fiscal)}</td><td class="aos-mono">${esc(x.buyerUid || (x.soldBy ? 'walk-in · ' + x.soldBy : '—'))}</td><td>${trBtn('ticket', x.id)}</td></tr>`).join('');
        const ords = r.orders.map((o) => `<tr><td class="aos-mono">${esc(o.id)}</td><td class="aos-mono">${esc(o.eventId)}</td><td class="aos-mono">${esc(o.buyerUid)}</td><td>${num(o.quantity)}</td>
          <td>${o.totalAmount == null ? '—' : 'KES ' + num(o.totalAmount)}</td><td>${chip(o.status)}</td><td>${fchip(o.fiscal)}</td><td>${trBtn('order', o.id)}</td></tr>`).join('');
        const sales = r.sales.map((x) => `<tr><td class="aos-mono">${esc(x.id)}</td><td class="aos-mono">${esc(x.eventId)}</td><td>${esc(x.tender)}</td><td class="aos-mono">${esc(x.cashierUid)}</td>
          <td>${num(x.quantity)}</td><td>${kes(x.grossCents)}</td><td>${chip(x.status)}</td><td>${fchip(x.fiscal)}</td><td>${trBtn('sale', x.id)}</td></tr>`).join('');
        const fis = (r.fiscal || []).map(fiscalRow).join('');
        return form + (r.truncated ? '<p class="aos-muted">Showing the first 100 of each — narrow the search.</p>' : '') +
          (search.q.by === 'fiscalStatus' ? `<h4>Fiscal records</h4>${table(FISCAL_HEAD, fis, 'No fiscal records in that state.')}`
          : `<h4>Tickets</h4>${table(['Ticket', 'PIN', 'Event', 'Tier', 'Status', 'Admission', 'Refund', 'Fiscal', 'Buyer / sold by', ''], tix, 'No tickets.')}
          <h4>Orders</h4>${table(['Order', 'Event', 'Buyer', 'Tickets', 'Amount', 'Status', 'Fiscal', ''], ords, 'No orders.')}
          <h4>Door &amp; cashier sales</h4>${table(['Sale', 'Event', 'Tender', 'Cashier', 'Tickets', 'Gross', 'Status', 'Fiscal', ''], sales, 'No sales.')}`);
      },
      async eventops() {
        const form = `<form class="aos-filters" data-evops><label>Event id <input name="eventId" autocomplete="off" maxlength="128" value="${esc(opsEvent)}"></label>
          <button type="submit" class="aos-btn">Load</button></form>`;
        if (!opsEvent) return form + '<p class="aos-muted">Enter an event id to see its temporary staff, invitations, admissions and PIN lockouts.</p>';
        const [st, ad] = await Promise.all([call('eventAdminStaff', { eventId: opsEvent }), call('eventAdminAdmissions', { eventId: opsEvent })]);
        const staff = st.staff.map((s) => `<tr><td class="aos-mono">${esc(s.uid)}</td><td>${esc(s.email)}</td><td>${esc(s.role)}</td><td>${chip(s.status)}</td>
          <td>${s.activeNow ? 'yes' : 'no'}</td><td>${when(s.startAt)}</td><td>${when(s.endAt)}</td>
          <td>${s.status !== 'revoked' ? `<button type="button" class="aos-btn aos-btn-ghost" data-revoke="${esc(s.uid)}">Revoke access</button>` : ''}</td></tr>`).join('');
        const inv = st.invites.map((i) => `<tr><td>${esc(i.email)}</td><td>${esc(i.role)}</td><td>${chip(i.status)}</td><td>${when(i.endAt)}</td></tr>`).join('');
        const adm = ad.admissions.map((a) => `<tr><td class="aos-mono">${esc(a.ticketId)}</td><td class="aos-mono">${esc(a.admittedBy)}</td><td>${esc(a.admittedRole)}</td><td>${esc(a.method)}</td><td>${when(a.admittedAt)}</td></tr>`).join('');
        const att = ad.attempts.map((a) => `<tr><td class="aos-mono">${esc(a.id)}</td><td>${num(a.fails)}</td><td>${when(a.windowStart)}</td></tr>`).join('');
        return form + `<h4>Staff</h4>${table(['Uid', 'Email', 'Role', 'Status', 'Active now', 'From', 'Until', ''], staff, 'No staff.')}
          <h4>Invitations</h4>${table(['Email', 'Role', 'Status', 'Expires'], inv, 'No invitations.')}
          <h4>Admissions${ad.truncated ? ' (first 200)' : ''}</h4>${table(['Ticket', 'Admitted by', 'Role', 'Method', 'When'], adm, 'Nobody admitted yet.')}
          <h4>Wrong-PIN counters</h4>${table(['Counter', 'Fails in window', 'Window start'], att, 'No failed PINs.')}`;
      },
      async refundreq() {
        const r = await call('eventAdminRefundRequests', rqStatus ? { status: rqStatus } : {});
        const filt = `<div class="aos-filters"><label>Status <select data-rqstatus><option value="">All</option>${['SUBMITTING', 'PENDING_REVIEW', 'DUPLICATE', 'REJECTED', 'REFUNDED'].map((s) => `<option ${s === rqStatus ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>`;
        const rows = r.requests.map((q) => `<tr><td class="aos-mono">${esc(q.id)}</td><td class="aos-mono">${esc(q.eventId)}</td><td class="aos-mono">${esc(q.buyerUid)}</td>
          <td>${esc(q.reasonLabel || q.reasonCode)}</td><td>${chip(q.eligibility)}</td><td>${q.requestedAmountKes == null ? '—' : 'KES ' + num(q.requestedAmountKes)}</td>
          <td>${chip(q.status)}</td><td>${when(q.createdAt)}</td><td>${trBtn('order', q.id)}</td></tr>`).join('');
        return filt + '<p class="aos-muted">Buyer requests from the Refund Wizard. Approval and payment happen in the canonical refund queue (Financial OS) — not here.</p>' +
          table(['Order', 'Event', 'Buyer', 'Reason', 'Eligible', 'Amount', 'Status', 'Requested', ''], rows, 'No refund requests.');
      },
      async receivables() {
        const r = await call('eventAdminReceivables', rvStatus ? { status: rvStatus } : {});
        const filt = `<div class="aos-filters"><label>Status <select data-rvstatus><option value="">All</option>${['OUTSTANDING', 'COLLECTED'].map((s) => `<option ${s === rvStatus ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>`;
        const rows = r.receivables.map((x) => `<tr><td class="aos-mono">${esc(x.saleId || x.id)}</td><td class="aos-mono">${esc(x.eventId)}</td><td class="aos-mono">${esc(x.organizerUid)}</td>
          <td>${esc(x.source)}</td><td>${kes(x.amountCents)}</td><td>${kes(x.collectedCents)}</td><td>${chip(x.status)}</td><td>${trBtn('sale', x.saleId || x.id)}</td></tr>`).join('');
        return filt + '<p class="aos-muted">SOKONI commission on cash and organizer-terminal card sales. Netted automatically from the organizer\'s next online ticket release.</p>' +
          table(['Sale', 'Event', 'Organizer', 'Tender', 'Owed', 'Collected', 'Status', ''], rows, 'No receivables.');
      },
      async overview() {
        const o = await call('eventAdminOverview', {});
        return `<div class="aos-kpis">
          <div class="aos-kpi"><div class="aos-kpi-l">Events by status</div><div class="aos-kpi-v">${counts(o.events)}</div></div>
          <div class="aos-kpi"><div class="aos-kpi-l">Settlements by status</div><div class="aos-kpi-v">${counts(o.settlements)}</div></div>
          <div class="aos-kpi"><div class="aos-kpi-l">Held for organizers</div><div class="aos-kpi-v">${kes(o.heldOrganizerNetCents)}</div></div>
          <div class="aos-kpi"><div class="aos-kpi-l">Ticket commission booked</div><div class="aos-kpi-v">${kes(o.commissionCents)}</div></div>
          <div class="aos-kpi"><div class="aos-kpi-l">Open exceptions</div><div class="aos-kpi-v">${num(o.openExceptions)}</div></div>
          <div class="aos-kpi"><div class="aos-kpi-l">Orders awaiting refund</div><div class="aos-kpi-v">${num(o.ordersAwaitingRefund)}</div></div>
          <div class="aos-kpi"><div class="aos-kpi-l">Ticket commission policy</div><div class="aos-kpi-v">${o.policy == null ? '—' : esc(o.policy) + '% of net'}</div></div>
        </div>`;
      },
      async events() {
        const r = await call('eventAdminEvents', {});
        const rows = (r.events || []).map((e) => `<tr><td>${esc(e.title)}</td><td>${chip(e.status)}</td><td class="aos-mono">${esc(e.organizerUid)}</td>
          <td>${when(e.startDate)}</td><td>${num(e.totalTicketsSold)}</td>
          <td>${e.status !== 'cancelled' && e.status !== 'ended' ? `<button type="button" class="aos-btn aos-btn-ghost" data-cancel="${esc(e.id)}">Cancel event</button>` : ''}</td></tr>`).join('');
        return table(['Event', 'Status', 'Organizer', 'Starts', 'Tickets sold', ''], rows, 'No events yet.');
      },
      async settlements() {
        const r = await call('eventAdminSettlements', {});
        const rows = (r.settlements || []).map((s) => `<tr><td class="aos-mono">${esc(s.paymentRef)}</td><td>${chip(s.status)}</td><td>${kes(s.grossCents)}</td>
          <td>${kes(s.providerFeeCents)}</td><td>${kes(s.commissionCents)}</td><td>${kes(s.organizerNetCents)}</td><td>${when(s.releaseAfter)}</td>
          <td>${s.status === 'FEE_UNREPORTED' ? `<button type="button" class="aos-btn aos-btn-ghost" data-attest="${esc(s.paymentRef)}">Attest fee (super admin)</button>` : ''}</td></tr>`).join('');
        return table(['Payment', 'Status', 'Gross', 'Provider fee', 'Commission', 'Organizer', 'Release after', ''], rows, 'No ticket settlements yet.');
      },
      async refunds() {
        const r = await call('eventAdminRefundQueue', {});
        const rows = (r.orders || []).map((o) => `<tr><td class="aos-mono">${esc(o.id)}</td><td class="aos-mono">${esc(o.buyerUid)}</td><td>${num(o.quantity)}</td>
          <td>${o.totalAmount == null ? '—' : 'KES ' + num(o.totalAmount)}</td><td>${when(o.cancelledAt)}</td>
          <td>${o.paymentRef ? `<button type="button" class="aos-btn" data-refund="${esc(o.paymentRef)}" data-amount="${esc(o.totalAmount)}">Submit refund</button>` : '<span class="aos-muted">no payment ref</span>'}</td></tr>`).join('');
        return `<p class="aos-muted">Orders from cancelled events. Refunds run through the canonical refund authority (financial-os); the tickets and the held settlement are reversed exactly once when it completes.</p>` +
          table(['Order', 'Buyer', 'Tickets', 'Amount', 'Cancelled', ''], rows, 'No orders are waiting for a refund.');
      },
      async exceptions() {
        const r = await call('eventAdminExceptions', {});
        const rows = (r.exceptions || []).map((x) => `<tr><td>${chip(x.kind)}</td><td class="aos-mono">${esc(x.paymentRef)}</td><td>${esc(x.detail || x.reason || x.code || '')}</td><td>${when(x.updatedAt || x.createdAt)}</td></tr>`).join('');
        return table(['Kind', 'Payment', 'Detail', 'When'], rows, 'No open event exceptions.');
      },
      async listings() {
        const r = await call('entAdminListings', { kind: listingKind, status: listingStatus });
        const filters = `<div class="aos-filters">
          <label>Type <select data-lkind><option value="venue" ${listingKind === 'venue' ? 'selected' : ''}>Venues</option><option value="artist" ${listingKind === 'artist' ? 'selected' : ''}>Artists</option></select></label>
          <label>Status <select data-lstatus>${['pending', 'active', 'suspended', 'rejected'].map((s) => `<option ${s === listingStatus ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>`;
        const acts = (l) => {
          const st = l.status || 'pending';
          const b = (d, t) => `<button type="button" class="aos-btn aos-btn-ghost" data-ldecide="${d}" data-lid="${esc(l.id)}">${t}</button>`;
          if (st === 'pending') return b('approve', 'Approve') + ' ' + b('reject', 'Reject');
          if (st === 'active' || st === 'approved') return b('suspend', 'Suspend');
          return b('restore', 'Restore');
        };
        const rows = (r.listings || []).map((l) => `<tr><td>${esc(l.name || l.stageName || l.title || l.id)}</td><td>${esc(l.type || l.category || l.venueType || '')}</td>
          <td class="aos-mono">${esc(l.uid)}</td><td>${chip(l.status)}</td><td>${when(l.createdAt)}</td><td>${acts(l)}</td></tr>`).join('');
        return filters + table(['Name', 'Type', 'Owner', 'Status', 'Created', ''], rows, 'Nothing here.');
      },
      async matrix() {
        const m = await call('entAdminMatrix', {});
        const cats = (m.categories || []).map((c) => `<tr><td><strong>${esc(c.label)}</strong><div class="aos-muted">${esc(c.id)}${c.contentTypeOf ? ' · content type of ' + esc(c.contentTypeOf) : ''}</div></td>
          <td>${esc(c.application && c.application.path)}</td><td>${esc(c.approval && c.approval.authority)}</td><td>${esc(c.role && c.role.key)}</td>
          <td>${esc(c.dashboard && c.dashboard.path)} ${chip(c.dashboard && c.dashboard.tier)}</td><td>${esc(c.payment && (c.payment.purpose || 'none'))}</td>
          <td>${esc(c.commercialPolicy)}</td><td>${esc(c.refund)}</td></tr>`).join('');
        const pol = (m.commercialPolicies || []).map((p) => `<tr><td>${esc(p.key)}</td><td>${esc(p.transactionType)}</td><td><strong>${esc(p.pct)}%</strong></td><td>${esc(p.basis)}</td><td class="aos-mono">${esc(p.source)}</td><td>${esc(p.settlement)}</td></tr>`).join('');
        return `${m.orphans && m.orphans.length ? `<p style="color:#ff6b6b">Categories missing a lifecycle step: ${esc(m.orphans.join(', '))}</p>` : '<p class="aos-muted">Every category has an application path, approval, role, dashboard, payment, refund, policy and AdminOS surface.</p>'}
          <h4>Entertainment categories</h4>${table(['Category', 'Apply', 'Approval', 'Role', 'Dashboard', 'Payment', 'Policy', 'Refund'], cats, 'No categories.')}
          <h4>Commercial policies (rates from their owning authority — read-only here)</h4>${table(['Policy', 'Transaction', 'Rate', 'Basis', 'Source', 'Settlement'], pol, 'No policies.')}`;
      },
    };

    host.addEventListener('click', async (ev) => {
      const t = ev.target.closest('button');
      if (!t) return;
      if (t.dataset.tab) { tab = t.dataset.tab; return render(); }
      if (t.dataset.traceOrder || t.dataset.traceSale || t.dataset.traceTicket) {
        const q = t.dataset.traceOrder ? { orderId: t.dataset.traceOrder } : t.dataset.traceSale ? { saleId: t.dataset.traceSale } : { ticketId: t.dataset.traceTicket };
        msg('Tracing…');
        try { traced = await call('eventAdminTrace', q); msg(''); tab = 'investigate'; }
        catch (e) { msg((e && e.message) || 'Trace failed.', true); return undefined; }
        return render();
      }
      if (t.dataset.untrace) { traced = null; return render(); }
      if (t.dataset.fiscalRetry) return act('eventAdminFiscalRetry', { saleKey: t.dataset.fiscalRetry }, 'Fiscal retry queued through eTIMS.');
      if (t.dataset.revoke) {
        return ask('Revoke access', [{ label: 'Reason (kept in the audit log)', area: true }], ([reason]) => {
          if (String(reason || '').trim().length < 5) return msg('A reason is required.', true);
          act('eventAdminRevokeStaff', { eventId: opsEvent, uid: t.dataset.revoke, reason }, 'Access revoked. It ends immediately.');
        });
      }
      if (t.dataset.cancel) {
        return ask('Cancel event', [{ label: 'Reason (shown to buyers)', area: true }], ([reason]) => {
          if (String(reason || '').trim().length < 5) return msg('A reason is required.', true);
          act('cancelEvent', { eventId: t.dataset.cancel, reason }, 'Event cancelled. Paid orders moved to the refund queue.');
        });
      }
      if (t.dataset.attest) {
        return ask('Attest fee', [{ label: 'Provider fee (KES)', type: 'number', step: '0.01' }, { label: 'Evidence (IntaSend dashboard reference)', area: true }], ([fee, evidence]) =>
          act('eventAdminAttestFee', { paymentRef: t.dataset.attest, feeKes: Number(fee), evidence }, 'Fee attested; settlement is now held for release.'));
      }
      if (t.dataset.refund) {
        return ask('Submit refund', [{ label: 'Reason', area: true }], ([reason]) => {
          if (String(reason || '').trim().length < 5) return msg('A reason is required.', true);
          act('fosSubmitRefund', { payRef: t.dataset.refund, amountKES: Number(t.dataset.amount), reason, refundType: 'full' }, 'Refund submitted to the refund authority.');
        });
      }
      if (t.dataset.ldecide) {
        const decision = t.dataset.ldecide;
        if (decision === 'approve') return act('entAdminSetListingStatus', { kind: listingKind, id: t.dataset.lid, decision }, 'Approved.');
        return ask(decision[0].toUpperCase() + decision.slice(1), [{ label: 'Reason', area: true }], ([reason]) =>
          act('entAdminSetListingStatus', { kind: listingKind, id: t.dataset.lid, decision, reason }, 'Saved.'));
      }
      return undefined;
    });
    host.addEventListener('submit', async (ev) => {
      const f = ev.target;
      if (f.matches('[data-evops]')) { ev.preventDefault(); opsEvent = f.eventId.value.trim(); return render(); }
      if (!f.matches('[data-evsearch]')) return undefined;
      ev.preventDefault();
      const q = { by: f.by.value, value: f.value.value.trim() };
      if (f.eventId.value.trim()) q.eventId = f.eventId.value.trim();
      if (!q.value) return msg('Enter something to search for.', true);
      msg('Searching…');
      try {
        const result = await call('eventAdminInvestigate', q);
        if (q.by === 'pin') q.value = '';          /* the PIN is not kept in page state */
        search = { q, result }; traced = null; msg('');
      } catch (e) { msg((e && e.message) || 'Search failed.', true); return undefined; }
      f.value.value = '';
      return render();
    });
    host.addEventListener('change', (ev) => {
      if (ev.target.matches('[data-rqstatus]')) { rqStatus = ev.target.value; render(); }
      if (ev.target.matches('[data-rvstatus]')) { rvStatus = ev.target.value; render(); }
      if (ev.target.matches('[data-fview]')) { fView = ev.target.value; render(); }
      if (ev.target.matches('[data-lkind]')) { listingKind = ev.target.value; render(); }
      if (ev.target.matches('[data-lstatus]')) { listingStatus = ev.target.value; render(); }
    });

    async function render() {
      host.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try { body.innerHTML = await R[tab](); }
      catch (e) { body.innerHTML = `<p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}. Entertainment ops need adminOsDispatch redeployed.</p>`; }
    }
    render();
    return true;
  }

  const OPS = ['eventAdminOverview', 'eventAdminEvents', 'eventAdminSettlements', 'eventAdminRefundQueue', 'eventAdminExceptions',
    'eventAdminAttestFee', 'entAdminMatrix', 'entAdminListings', 'entAdminSetListingStatus',
    'eventAdminInvestigate', 'eventAdminTrace', 'eventAdminStaff', 'eventAdminAdmissions', 'eventAdminRefundRequests',
    'eventAdminReceivables', 'eventAdminRevokeStaff', 'eventAdminFiscal', 'eventAdminFiscalRetry'];

  root.SokoniAOSEntertainment = { mount, OPS, _kes: kes, _esc: esc };
}(typeof window !== 'undefined' ? window : globalThis));
