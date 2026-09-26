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
    ['overview', 'Overview'], ['events', 'Events'], ['settlements', 'Settlements'], ['refunds', 'Refund queue'],
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

    const R = {
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
    host.addEventListener('change', (ev) => {
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
    'eventAdminAttestFee', 'entAdminMatrix', 'entAdminListings', 'entAdminSetListingStatus'];

  root.SokoniAOSEntertainment = { mount, OPS, _kes: kes, _esc: esc };
}(typeof window !== 'undefined' ? window : globalThis));
