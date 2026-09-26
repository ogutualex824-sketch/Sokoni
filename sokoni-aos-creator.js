/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-aos-creator.js — AdminOS › Creator Hub controls.

   Mount contract (same as sokoni-aos-products / -security):
     window.SokoniAOSCreator.mount({ host, call }) → true when rendered
   `call(op, data)` is AdminOS's own _call(): every op below is whitelisted in
   sokoni-aos.js and routes through adminOsDispatch, whose handlers
   (functions/creator-hub.js _adminH) each re-check the admin claim. Nothing
   here writes Firestore; nothing here decides money — it asks the server.

   Unknown figures render "—", never 0 (CLAUDE.md UI Data Integrity).
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const TABS = [
    ['creators', 'Creators'], ['verification', 'Verification'], ['films', 'Films & review'], ['settlement', 'Royalty settlement'],
    ['ledger', 'Ledger'], ['exceptions', 'Exceptions'], ['refunds', 'Refunds'], ['oversight', 'Oversight'], ['security', 'Playback security'], ['config', 'Config'],
  ];

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  /** cents → "KES 1,234.50"; null/undefined → "—" (never a fabricated 0). */
  function kes(cents) {
    if (cents == null || !Number.isFinite(Number(cents))) return '—';
    const n = Number(cents) / 100;
    return 'KES ' + n.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  const pct = (bps) => (Number.isFinite(Number(bps)) ? (Number(bps) / 100).toFixed(2).replace(/\.00$/, '') + '%' : '—');
  const when = (ms) => (ms ? new Date(ms).toLocaleString('en-KE') : '—');
  const safeHref = (u) => { try { const x = new URL(u); return x.protocol === 'https:' ? x.href : null; } catch (_) { return null; } };
  const chip = (s) => `<span class="aos-badge" data-state="${esc(s)}">${esc(s || '—')}</span>`;

  function mount(opts) {
    const host = opts && opts.host;
    const call = opts && opts.call;
    if (!host || typeof call !== 'function') return false;
    let tab = 'creators';

    host.innerHTML = `
      <div class="aoscr-tabs" role="tablist">${TABS.map(([k, l]) => `<button type="button" role="tab" class="aos-btn aos-btn-ghost" data-tab="${k}">${esc(l)}</button>`).join('')}</div>
      <div class="aoscr-msg" id="aoscrMsg" role="status" aria-live="polite"></div>
      <div id="aoscrBody"><div class="aos-spinner"><div></div></div></div>`;
    const body = host.querySelector('#aoscrBody');
    const msg = (t, bad) => { const m = host.querySelector('#aoscrMsg'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };

    async function act(op, data, okText) {
      msg('Working…');
      try { const r = await call(op, data); msg(okText || 'Done.'); await render(); return r; }
      catch (e) { msg((e && e.message) || 'Failed.', true); return null; }
    }
    /* Inline reason form — AdminOS has no window.prompt in its UX, and a reason
       is REQUIRED server-side for suspend / reject / hold / revoke. */
    function ask(label, onOk) {
      const d = document.createElement('div');
      d.className = 'aoscr-ask';
      d.innerHTML = `<label>${esc(label)}<textarea rows="2" maxlength="500"></textarea></label>
        <button type="button" class="aos-btn">Confirm</button> <button type="button" class="aos-btn aos-btn-ghost">Cancel</button>`;
      body.prepend(d);
      const [ok, cancel] = d.querySelectorAll('button');
      cancel.onclick = () => d.remove();
      ok.onclick = () => { const v = d.querySelector('textarea').value.trim(); if (v.length < 5) { msg('Give at least 5 characters.', true); return; } d.remove(); onOk(v); };
      d.querySelector('textarea').focus();
    }

    const R = {
      /* REFUND REVIEW — the existing refund authority (financial-os): approve /
         reject = fosApproveRefund (admin), resolve an unknown outcome =
         fosResolveRefund (super admin + IntaSend evidence). No second lifecycle. */
      async refunds() {
        const r = await call('creatorAdminRefundCases', {});
        const act1 = (c) => {
          if (['pending', 'approved', 'failed'].includes(c.status)) return `<button class="aos-btn" data-a="rf-approve" data-id="${esc(c.refundId)}">Approve &amp; refund</button> <button class="aos-btn aos-btn-ghost" data-a="rf-reject" data-id="${esc(c.refundId)}">Reject…</button>`;
          if (c.status === 'outcome_unknown' || c.status === 'provider_succeeded') return `<button class="aos-btn aos-btn-ghost" data-a="rf-resolve" data-id="${esc(c.refundId)}" data-st="${esc(c.status)}">Resolve with evidence (super admin)…</button>`;
          return '';
        };
        const rows = (r.cases || []).map((c) => `<tr>
          <td class="aos-mono">${esc(c.refundId)}<div class="aos-muted">${c.filmPurchase ? '🎬 film ' + esc(c.filmId || '') : 'other payment'}</div></td>
          <td class="aos-mono">${esc(c.payRef || '—')}</td><td>${c.amountKES == null ? '—' : 'KES ' + esc(c.amountKES)}</td>
          <td>${esc(c.reason || '—')}</td><td>${chip(c.status)}${c.outcomeUnknown ? ' <b style="color:#ff9800">provider outcome unknown — never retried</b>' : ''}</td>
          <td class="aos-muted">${esc(c.providerRefundId || c.error || '')}${c.resolution ? '<div>resolved ' + esc(c.resolution.outcome) + ' by ' + esc(c.resolution.by) + '</div>' : ''}</td>
          <td class="aos-muted">${c.history == null ? '—' : c.history.map((h) => esc(h.action) + ' · ' + esc(h.actorUid || '') + ' · ' + when(h.atMs)).join('<br>')}</td>
          <td>${act1(c)}</td></tr>`).join('');
        return rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Refund</th><th>Payment</th><th>Amount</th><th>Reason</th><th>State</th><th>Provider</th><th>History</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No refund requests.</p>';
      },
      /* CREATOR OVERSIGHT — aggregates only; "—" where a figure could not be read in full. */
      async oversight() {
        const o = await call('creatorAdminOverview', {});
        const n = (v) => (v == null ? '—' : esc(Number(v).toLocaleString('en-KE')));
        const k = (v) => (v == null ? '—' : 'KES ' + Number(v).toLocaleString('en-KE'));
        const cell = (l, v) => `<div class="aos-kpi"><span class="aos-muted">${esc(l)}</span><b>${v}</b></div>`;
        const sa = o.sales; const cr = o.creators; const pp = o.participantPayouts;
        return `<div class="aoscr-kpis">
          ${cell('Creators', cr ? n(cr.total) : '—')}${cell('Active', cr ? n((cr.byState || {}).ACTIVE || 0) : '—')}${cell('Pending approval', cr ? n((cr.byState || {}).PENDING || 0) : '—')}${cell('Suspended', cr ? n((cr.byState || {}).SUSPENDED || 0) : '—')}
          ${cell('Verification awaiting review', n(o.pendingVerification))}${cell('Published films', n(o.publishedFilms))}
          ${cell('Purchases', sa ? n(sa.purchases) : '—')}${cell('Gross film sales', sa ? kes(sa.grossCents) : '—')}${cell('Provider fees', sa ? kes(sa.providerFeeCents) : '—')}
          ${cell('SOKONI 30% (of net)', sa ? kes(sa.commissionCents) : '—')}${cell('Creator pool 70% (of net)', sa ? kes(sa.poolCents) : '—')}${cell('Refunds', sa ? n(sa.refunds) + ' · ' + kes(sa.refundedCents) : '—')}
          ${cell('Royalty released to wallets', k(o.releasedRoyaltyKes))}${cell('Participant payouts withdrawn*', pp ? k(pp.withdrawnKes) : '—')}${cell('Participant payouts pending*', pp ? k(pp.pendingKes) : '—')}${cell('Outcome unknown payouts*', pp ? n(pp.outcomeUnknownCount) + ' · ' + k(pp.outcomeUnknownKes) : '—')}
        </div><p class="aos-muted">${sa ? esc(sa.policy) : ''}. * ${pp ? esc(pp.note) : 'Participant payouts could not be read in full.'} Viewer identities are never shown here.</p>`;
      },
      async creators() {
        const r = await call('creatorAdminList', {});
        const rows = (r.creators || []).map((c) => `<tr>
          <td>${esc(c.displayName)}<div class="aos-muted aos-mono">${esc(c.creatorId)}</div></td>
          <td>${chip(c.state)}</td><td>${esc(c.country || '—')}</td><td>${esc(c.verification)}</td>
          <td class="aos-muted">${esc(c.reviewNote || '')}</td>
          <td>${c.state === 'PENDING' ? `<button class="aos-btn" data-a="cr-approve" data-id="${esc(c.creatorId)}">Approve</button> <button class="aos-btn aos-btn-ghost" data-a="cr-reject" data-id="${esc(c.creatorId)}">Reject</button>` : ''}
              ${c.state === 'ACTIVE' ? `<button class="aos-btn aos-btn-ghost" data-a="cr-suspend" data-id="${esc(c.creatorId)}">Suspend</button>` : ''}
              ${c.state === 'SUSPENDED' ? `<button class="aos-btn" data-a="cr-approve" data-id="${esc(c.creatorId)}">Reinstate</button>` : ''}
              <button class="aos-btn aos-btn-ghost" data-a="cr-hold" data-id="${esc(c.creatorId)}">Hold payouts…</button> <button class="aos-btn aos-btn-ghost" data-a="cr-release" data-id="${esc(c.creatorId)}">Release hold</button></td></tr>`).join('');
        return rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Creator</th><th>State</th><th>Country</th><th>Verification</th><th>Note</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No creators have registered yet.</p>';
      },
      async verification() {
        const r = await call('creatorAdminVerifications', {});
        const order = { SUBMITTED: 0, UNDER_REVIEW: 1, MORE_INFORMATION_REQUIRED: 2, APPROVED: 3, SUSPENDED: 4, REJECTED: 5, DRAFT: 6 };
        const apps = (r.applications || []).sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9));
        const rows = apps.map((a) => `<tr>
          <td><button class="aos-link" data-a="ver-detail" data-id="${esc(a.creatorId)}">${esc(a.displayName || a.creatorId)}</button><div class="aos-muted">${esc(a.legalName)} · ${esc(a.creatorType || '—')} · ${esc(a.country || '—')}</div></td>
          <td>${chip(a.status)}</td><td>v${esc(a.version)}</td><td>${esc(a.documents.length)}</td>
          <td>${a.submittedAtMs ? when(a.submittedAtMs) : '—'}</td></tr>`).join('');
        return (rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Creator</th><th>Status</th><th>Ver.</th><th>Docs</th><th>Submitted</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No verification applications.</p>') + '<div id="aoscrDetail"></div>';
      },
      async films() {
        const r = await call('creatorAdminFilms', {});
        const order = { SUBMITTED: 0, UNDER_REVIEW: 1, APPROVED: 2, PUBLISHED: 3, SUSPENDED: 4, REJECTED: 5, DRAFT: 6 };
        const films = (r.films || []).sort((a, b) => (order[a.pubState] ?? 9) - (order[b.pubState] ?? 9));
        const btn = (f, to, label, ghost) => `<button class="aos-btn${ghost ? ' aos-btn-ghost' : ''}" data-a="film-to" data-id="${esc(f.filmId)}" data-to="${to}">${label}</button>`;
        const rows = films.map((f) => `<tr>
          <td><button class="aos-link" data-a="film-detail" data-id="${esc(f.filmId)}">${esc(f.title)}</button><div class="aos-muted">${esc(f.subcategoryLabel || f.subcategory)} · ${esc(f.creatorName || f.creatorUid)}</div></td>
          <td>${chip(f.pubState)}</td><td>${kes(f.priceCents)} ${esc(f.accessType)}${f.rentalDays ? ' · ' + f.rentalDays + 'd' : ''}</td>
          <td>${f.mediaReady ? 'verified' : '<span class="aos-muted">missing</span>'}</td>
          <td>${f.agreementVersion ? 'v' + f.agreementVersion + ' locked' : '<span class="aos-muted">unlocked</span>'}</td>
          <td>${f.pubState === 'SUBMITTED' ? btn(f, 'UNDER_REVIEW', 'Start review') : ''}
              ${f.pubState === 'UNDER_REVIEW' ? btn(f, 'APPROVED', 'Approve + lock split') + ' ' + btn(f, 'REJECTED', 'Reject', true) : ''}
              ${f.pubState === 'SUBMITTED' ? btn(f, 'REJECTED', 'Reject', true) : ''}
              ${f.pubState === 'APPROVED' ? btn(f, 'PUBLISHED', 'Publish') : ''}
              ${['PUBLISHED', 'APPROVED'].includes(f.pubState) ? btn(f, 'SUSPENDED', 'Suspend', true) : ''}
              ${f.pubState === 'SUSPENDED' ? btn(f, 'PUBLISHED', 'Reinstate') : ''}</td></tr>`).join('');
        return (rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Film</th><th>State</th><th>Price</th><th>Master</th><th>Royalty split</th><th>Review</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No films submitted yet.</p>') + '<div id="aoscrDetail"></div>';
      },
      async settlement() {
        const r = await call('creatorAdminPeriods', {});
        const cur = r.current || {};
        const rows = (r.periods || []).map((p) => `<tr><td class="aos-mono">${esc(p.periodId)}</td><td>${chip(p.status)}</td>
          <td>${p.totals ? esc(p.totals.participants) : '—'}</td><td>${p.totals ? 'KES ' + Number(p.totals.releaseKes).toLocaleString('en-KE') : '—'}</td>
          <td class="aos-muted">${esc(p.calculatedBy || '—')} / ${esc(p.approvedBy || '—')}</td>
          <td>${['OPEN', 'CALCULATED'].includes(p.status) ? `<button class="aos-btn aos-btn-ghost" data-a="per-calc" data-id="${esc(p.periodId)}">Recalculate</button>` : ''}
              ${p.status === 'CALCULATED' ? `<button class="aos-btn" data-a="per-approve" data-id="${esc(p.periodId)}">Approve</button>` : ''}
              ${['APPROVED', 'PAYABLE'].includes(p.status) ? `<button class="aos-btn" data-a="per-dist" data-id="${esc(p.periodId)}">Distribute to wallets</button><div class="aos-muted">Dual control: ${esc(p.approvedBy || 'the approver')} approved — a different admin must distribute.</div>` : ''}
              ${p.status === 'PAYABLE' ? `<button class="aos-btn aos-btn-ghost" data-a="per-close" data-id="${esc(p.periodId)}">Close</button>` : ''}
              <button class="aos-btn aos-btn-ghost" data-a="per-stmts" data-id="${esc(p.periodId)}">Statements</button></td></tr>`).join('');
        return `<p class="aos-muted">Current quarter <b class="aos-mono">${esc(cur.periodId || '—')}</b> ends ${when(cur.endMs)} (EAT). A quarter can be calculated only after it ends; approval must be by a different admin; distribution credits the canonical wallet once per participant per quarter.</p>
          <form class="aoscr-inline" data-f="per-calc-new"><input name="periodId" placeholder="e.g. 2026-Q3" pattern="\\d{4}-Q[1-4]" required> <button class="aos-btn">Calculate quarter</button></form>
          ${rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Quarter</th><th>Status</th><th>Participants</th><th>To release</th><th>Calculated / approved by</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No quarter has been calculated yet.</p>'}
          <div id="aoscrDetail"></div>`;
      },
      async ledger() {
        return `<form class="aoscr-inline" data-f="ledger"><input name="filmId" placeholder="filmId"> <input name="uid" placeholder="participant uid"> <input name="paymentRef" placeholder="payment ref"> <input name="periodId" placeholder="2026-Q3"> <button class="aos-btn">Search ledger</button></form><div id="aoscrDetail"><p class="aos-muted">The ledger is append-only: earnings are never edited or deleted; refunds add REVERSAL rows.</p></div>`;
      },
      async exceptions() {
        const r = await call('creatorAdminExceptions', {});
        const rows = (r.exceptions || []).map((x) => `<tr><td>${chip(x.kind)}</td><td class="aos-mono">${esc(x.paymentRef)}</td><td class="aos-muted">${esc(x.detail)}</td>
          <td><button class="aos-btn" data-a="ex-retry" data-id="${esc(x.paymentRef)}">Retry accrual</button>
          ${x.kind === 'fee_unreported' ? `<button class="aos-btn aos-btn-ghost" data-a="ex-fee" data-id="${esc(x.paymentRef)}">Attest fee (super admin)</button>` : ''}</td></tr>`).join('');
        return rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Kind</th><th>Payment</th><th>Detail</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No open royalty exceptions.</p>';
      },
      async security() {
        const r = await call('creatorAdminSecurityEvents', {});
        const rows = (r.events || []).map((e) => `<tr><td>${when(e.atMs)}</td><td>${chip(e.event)}</td><td class="aos-mono">${esc(e.uid)}</td><td class="aos-mono">${esc(e.filmId)}</td>
          <td>${esc(e.reason || '')}${e.risk && e.risk.suspicious ? ' <b style="color:#ff9800">⚑ ' + esc(e.risk.flags.join(', ')) + '</b>' : ''}</td></tr>`).join('');
        return `<form class="aoscr-inline" data-f="revoke"><input name="paymentRef" placeholder="payment ref to revoke" required> <button class="aos-btn aos-btn-ghost">Revoke entitlement…</button></form>` +
          (rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>When</th><th>Event</th><th>Viewer</th><th>Film</th><th>Detail</th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="aos-muted">No playback events recorded.</p>');
      },
      async config() {
        const c = await call('creatorAdminConfig', {});
        return `<p>Film purchases: <b>${c.purchasesEnabled ? 'OPEN' : 'CLOSED'}</b></p>
          <p class="aos-muted">Keep CLOSED until the webhook's film branch is deployed — the old webhook would credit the payer. Changing this needs super admin.</p>
          <button class="aos-btn${c.purchasesEnabled ? ' aos-btn-ghost' : ''}" data-a="cfg-purchases" data-to="${c.purchasesEnabled ? '0' : '1'}">${c.purchasesEnabled ? 'Close purchases' : 'Open purchases'}</button>
          <h4>Card &amp; other methods (IntaSend hosted checkout)</h4>
          <p>Status: <b>${c.hostedCheckoutEnabled ? 'ON for films' : 'OFF'}</b></p>
          <p class="aos-muted">Opens only when at least one method below is LIVE_AND_PROVEN with evidence — the server refuses otherwise. Buyers are offered the PROVEN methods only.</p>
          ${c.hostedCheckoutSwitch && !c.hostedCheckoutEnabled ? '<p class="aos-muted"><b>Switch is on, but no method is proven — buyers see M-PESA only.</b></p>' : ''}
          <button class="aos-btn aos-btn-ghost" data-a="cfg-hosted" data-to="${c.hostedCheckoutEnabled ? '0' : '1'}">${c.hostedCheckoutEnabled ? 'Turn hosted checkout off' : 'Turn hosted checkout on'}</button>
          <h4>Guest checkout (buy without an account)</h4>
          <p>Status: <b>${c.guestCheckoutEnabled ? 'ON' : 'OFF'}</b></p>
          <p class="aos-muted">Needs Firebase Anonymous Auth, which is a PLATFORM-WIDE change: anonymous users would pass every "signed-in" rule and callable. Keep OFF until that decision is made.</p>
          <button class="aos-btn aos-btn-ghost" data-a="cfg-guest" data-to="${c.guestCheckoutEnabled ? '0' : '1'}">${c.guestCheckoutEnabled ? 'Turn guest checkout off' : 'Turn guest checkout on'}</button>
          <h4>Payment methods offered to buyers</h4>
          <p>${(c.checkoutMethods || []).length ? c.checkoutMethods.map(esc).join(' · ') : '—'}</p>
          ${await capabilitySection()}`;
      },
    };

    /* IntaSend method capability — the evidence record behind every method a
       buyer is offered. Listed for every admin; the server lets only a Super
       Admin record, and requires evidence for LIVE_AND_PROVEN / UNSUPPORTED. */
    async function capabilitySection() {
      let r;
      try { r = await call('creatorAdminPaymentCapability', {}); }
      catch (e) { return '<p class="aos-muted">Capability record unavailable: ' + esc(e.message) + '</p>'; }
      const rows = (r.methods || []).map((m) => `<tr><td class="aos-mono">${esc(m.method)}</td><td>${esc(m.label)}</td><td>${chip(m.status)}</td>
        <td>${m.evidence ? esc(m.evidence.type) + ' · <span class="aos-mono">' + esc(m.evidence.reference) + '</span>' : '—'}</td><td>${esc(m.note || '—')}</td><td class="aos-mono">${esc(m.recordedBy || '—')}</td><td>${when(m.recordedAtMs)}</td></tr>`).join('');
      const opt = (xs) => xs.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join('');
      return `<h4>IntaSend method capability (live account)</h4>
        <p class="aos-muted">IntaSend has no read-only "enabled methods" endpoint. Evidence is a COMPLETE invoice on the live account for that method, a live probe session, or IntaSend's written confirmation. Nothing is offered on the strength of a name in code.</p>
        <div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Method</th><th></th><th>Status</th><th>Evidence</th><th>Note</th><th>By</th><th>When</th></tr></thead><tbody>${rows}</tbody></table></div>
        <form class="aoscr-inline" data-f="cfg-capability">
          <select name="method" aria-label="Method" required>${opt((r.methods || []).map((m) => m.method))}</select>
          <select name="status" aria-label="Status" required>${opt(r.statuses || [])}</select>
          <select name="evType" aria-label="Evidence type"><option value="">(no evidence)</option>${opt(Object.keys(r.evidenceTypes || {}))}</select>
          <input name="evRef" aria-label="Evidence reference" placeholder="invoice / probe / ticket ref" maxlength="120">
          <input name="note" aria-label="What was checked" placeholder="What was checked (min 20 chars)" required minlength="20" maxlength="1000">
          <button class="aos-btn">Record (super admin)</button>
        </form>`;
    }

    async function detailVerification(uid) {
      const d = await call('creatorAdminVerificationDetail', { uid });
      const a = d.application;
      const st = a.status;
      const act = (action, label, ghost) => `<button class="aos-btn${ghost ? ' aos-btn-ghost' : ''}" data-a="ver-act" data-id="${esc(uid)}" data-act="${action}">${label}</button>`;
      const buttons = {
        SUBMITTED: act('start_review', 'Start review') + act('request_info', 'Request information', true) + act('reject', 'Reject', true),
        UNDER_REVIEW: act('approve', 'Approve') + act('request_info', 'Request information', true) + act('reject', 'Reject', true),
        APPROVED: act('suspend', 'Suspend', true),
        SUSPENDED: act('reinstate', 'Reinstate'),
      }[st] || '';
      const docs = (d.documents || []).map((x) => {
        const href = x.url && safeHref(x.url);
        return `<li>${href ? `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer">${esc(x.name)}</a>` : esc(x.name)} · ${esc(x.contentType)} · ${(Number(x.sizeBytes) / 1024).toFixed(0)} KB${x.present === false ? ' <b style="color:#ff6b6b">MISSING</b>' : ''}${x.changedAfterSubmit ? ' <b style="color:#ff9800">⚠ changed after submission</b>' : ''}</li>`;
      }).join('');
      const links = (a.portfolio || []).concat(a.links || []).map((u) => { const h = safeHref(u); return h ? `<li><a href="${esc(h)}" target="_blank" rel="noopener noreferrer nofollow">${esc(h)}</a></li>` : ''; }).join('');
      host.querySelector('#aoscrDetail').innerHTML = `<div class="aoscr-card"><h3>${esc(a.displayName)} ${chip(st)}</h3>
        <p><b>Legal name:</b> ${esc(a.legalName)} · <b>Type:</b> ${esc(a.creatorType || '—')} · <b>Country:</b> ${esc(a.country || '—')}</p>
        <p><b>Identity:</b> ${a.identity ? esc(a.identity.documentType) + ' ending ' + esc(a.identity.documentLast4) : '—'} · <b>Contact:</b> ${esc(a.contactEmail || '—')} ${esc(a.contactPhone || '')}</p>
        <p><b>Ownership statement</b> (${a.ownershipAttested ? 'attested' : 'NOT attested'}):<br>${esc(a.ownershipStatement)}</p>
        <p class="aos-muted">${esc(a.bio)}</p>
        <h4>Documents (links expire in 5 minutes)</h4><ul>${docs || '<li class="aos-muted">none</li>'}</ul>
        <h4>Portfolio &amp; links</h4><ul>${links || '<li class="aos-muted">none</li>'}</ul>
        <div class="aoscr-inline">${buttons}</div>
        <h4>History</h4><ul>${(d.events || []).map((e) => `<li>${when(e.atMs)} — ${esc(e.from)} → <b>${esc(e.to)}</b> by ${esc(e.role)} <span class="aos-mono">${esc(e.actor)}</span>${e.reason ? ': ' + esc(e.reason) : ''}</li>`).join('')}</ul></div>`;
    }

    async function detailFilm(id) {
      const d = await call('creatorAdminFilmDetail', { filmId: id });
      const el = host.querySelector('#aoscrDetail');
      const ags = (d.agreements || []).map((a) => `<div class="aoscr-card"><b>v${a.version}</b> ${chip(a.status)} ${a.effectiveFrom ? 'from ' + when(a.effectiveFrom) : ''}${a.effectiveUntil ? ' until ' + when(a.effectiveUntil) : ''}
        <table class="aos-table"><tbody>${(a.participants || []).map((p) => `<tr><td>${esc(p.displayName || p.participantId)}</td><td>${esc(p.participantType)}</td><td class="aos-mono">${esc(p.uid)}</td><td>${pct(p.bps)}</td></tr>`).join('')}</tbody></table>
        ${a.status === 'DRAFT' ? `<button class="aos-btn" data-a="ag-lock" data-id="${esc(id)}" data-v="${a.version}">Lock v${a.version}${a.fullyAllocated ? '' : ' (must total 100%)'}</button>` : ''}</div>`).join('');
      const accs = (d.accruals || []).slice(0, 50).map((a) => `<tr><td class="aos-mono">${esc(a.paymentRef)}</td><td>${chip(a.status)}</td><td>${kes(a.grossCents)}</td>
        <td>${kes(a.deductions && a.deductions.providerFeeCents)}</td><td>${kes(a.deductions && a.deductions.commissionCents)}</td><td>${kes(a.poolCents)}</td><td>v${esc(a.agreementVersion)}</td><td>${esc(a.periodId)}</td></tr>`).join('');
      el.innerHTML = `<div class="aoscr-card"><h3>${esc(d.film.title)}</h3>
        <p class="aos-muted">Master: ${d.media ? esc(d.media.contentType) + ' · ' + (d.media.sizeBytes / 1048576).toFixed(1) + ' MB · verified ' + when(d.media.verifiedAt) : 'not uploaded'} — the master location is never shown or linked.</p>
        <h4>Ownership / royalty agreements</h4>${ags || '<p class="aos-muted">No agreement.</p>'}
        <h4>Accruals</h4>${accs ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Payment</th><th>Status</th><th>Gross</th><th>Fee</th><th>Commission</th><th>Pool</th><th>Ver.</th><th>Quarter</th></tr></thead><tbody>${accs}</tbody></table></div>` : '<p class="aos-muted">No sales recognised.</p>'}</div>`;
    }

    host.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-tab],[data-a]');
      if (!t) return;
      if (t.dataset.tab) { tab = t.dataset.tab; render(); return; }
      const id = t.dataset.id;
      switch (t.dataset.a) {
        case 'cr-approve': act('creatorAdminSetState', { uid: id, to: 'ACTIVE' }, 'Creator active.'); break;
        case 'cr-reject': ask('Why is this creator rejected?', (r) => act('creatorAdminSetState', { uid: id, to: 'REJECTED', reason: r })); break;
        case 'cr-suspend': ask('Why is this creator suspended?', (r) => act('creatorAdminSetState', { uid: id, to: 'SUSPENDED', reason: r })); break;
        case 'cr-hold': ask('Reason for holding royalty payouts for this participant:', (r) => act('creatorAdminSetPayoutHold', { uid: id, hold: true, reason: r }, 'Payout hold set.')); break;
        case 'cr-release': act('creatorAdminSetPayoutHold', { uid: id, hold: false }, 'Payout hold released — run Distribute to release held statements.'); break;
        case 'film-detail': detailFilm(id).catch((e) => msg(e.message, true)); break;
        case 'ver-detail': detailVerification(id).catch((e) => msg(e.message, true)); break;
        case 'ver-act': {
          const a = t.dataset.act;
          const needsReason = ['request_info', 'reject', 'suspend', 'reinstate'].includes(a);
          const done = () => detailVerification(id).catch(() => {});
          if (needsReason) ask(`Reason (${a.replace('_', ' ')}) — shown to the creator:`, (r) => act('creatorAdminVerificationDecision', { uid: id, action: a, reason: r }, 'Decision recorded.').then(done));
          else act('creatorAdminVerificationDecision', { uid: id, action: a }, 'Decision recorded.').then(done);
          break;
        }
        case 'film-to': {
          const to = t.dataset.to;
          if (to === 'REJECTED' || to === 'SUSPENDED') ask(`Note for the creator (${to.toLowerCase()}):`, (n) => act('creatorAdminFilmTransition', { filmId: id, to, note: n }));
          else act('creatorAdminFilmTransition', { filmId: id, to }, `Film → ${to}.`);
          break;
        }
        case 'ag-lock': act('creatorAdminLockAgreement', { filmId: id, version: Number(t.dataset.v) }, 'Agreement locked — it now governs new revenue.'); break;
        case 'per-calc': act('creatorAdminCalculatePeriod', { periodId: id }, 'Quarter calculated.'); break;
        case 'per-approve': act('creatorAdminApprovePeriod', { periodId: id }, 'Quarter approved.'); break;
        case 'per-dist': act('creatorAdminDistribute', { periodId: id }, 'Distribution run complete.'); break;
        case 'per-close': act('creatorAdminClosePeriod', { periodId: id }, 'Quarter closed.'); break;
        case 'per-stmts': call('creatorAdminStatements', { periodId: id }).then((r) => {
          host.querySelector('#aoscrDetail').innerHTML = `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Participant</th><th>Earned</th><th>Reversed</th><th>Carry in</th><th>Release</th><th>Carry out</th><th>State</th></tr></thead><tbody>${(r.statements || []).map((s) => `<tr><td class="aos-mono">${esc(s.uid)}</td><td>${kes(s.earnedCents)}</td><td>${kes(s.reversedCents)}</td><td>${kes(s.carryInCents)}</td><td>KES ${esc(s.releaseKes)}</td><td>${kes(s.carryOutCents)}</td><td>${s.released ? 'released' : s.held ? '<b style="color:#ff9800">held</b>' : 'pending'}</td></tr>`).join('')}</tbody></table></div>`;
        }).catch((e) => msg(e.message, true)); break;
        case 'ex-retry': act('creatorAdminRetryAccrual', { paymentRef: id }, 'Accrual retried.'); break;
        case 'ex-fee': {
          const d = document.createElement('form'); d.className = 'aoscr-ask';
          d.innerHTML = '<label>IntaSend fee (KES)<input name="fee" type="number" min="0" step="0.01" required></label><label>Evidence (IntaSend dashboard ref)<input name="ev" required minlength="5"></label><button class="aos-btn">Attest</button>';
          body.prepend(d);
          d.onsubmit = (e) => { e.preventDefault(); act('creatorAdminAttestFee', { paymentRef: id, feeKes: Number(d.fee.value), evidence: d.ev.value }, 'Fee attested; accrual attempted.'); };
          break;
        }
        case 'rf-approve': act('fosApproveRefund', { refundId: id }, 'Refund executed through the refund authority.'); break;
        case 'rf-reject': ask('Reason for rejecting this refund:', (r) => act('fosApproveRefund', { refundId: id, reject: true, rejectReason: r }, 'Refund rejected.')); break;
        case 'rf-resolve': {
          const d = document.createElement('form'); d.className = 'aoscr-ask';
          d.innerHTML = `<label>IntaSend shows<select name="outcome">${t.dataset.st === 'provider_succeeded' ? '' : '<option value="not_refunded">no refund was made</option>'}<option value="refunded">the refund was made</option></select></label><label>Evidence (IntaSend reference)<input name="ev" required minlength="5"></label><button class="aos-btn">Resolve</button>`;
          body.prepend(d);
          d.onsubmit = (e) => { e.preventDefault(); act('fosResolveRefund', { refundId: id, outcome: d.outcome.value, evidence: d.ev.value }, 'Refund resolved.'); };
          break;
        }
        case 'cfg-purchases': act('creatorAdminConfig', { set: { purchasesEnabled: t.dataset.to === '1' } }, 'Saved.'); break;
        case 'cfg-hosted': act('creatorAdminConfig', { set: { hostedCheckout: t.dataset.to === '1' } }, 'Saved.'); break;
        case 'cfg-guest': act('creatorAdminConfig', { set: { guestCheckoutEnabled: t.dataset.to === '1' } }, 'Saved.'); break;
        default:
      }
    });
    host.addEventListener('submit', (ev) => {
      const f = ev.target.closest('form[data-f]');
      if (!f) return;
      ev.preventDefault();
      const v = Object.fromEntries(new FormData(f).entries());
      if (f.dataset.f === 'per-calc-new') act('creatorAdminCalculatePeriod', { periodId: v.periodId.trim() }, 'Quarter calculated.');
      if (f.dataset.f === 'cfg-capability') act('creatorAdminPaymentCapability', { set: { method: v.method, status: v.status, note: v.note,
        ...(v.evType ? { evidence: { type: v.evType, reference: (v.evRef || '').trim() } } : {}) } }, 'Capability recorded.');
      if (f.dataset.f === 'revoke') ask('Reason for revoking this entitlement:', (r) => act('creatorAdminRevokeEntitlement', { paymentRef: v.paymentRef.trim(), reason: r }, 'Entitlement revoked.'));
      if (f.dataset.f === 'ledger') {
        const q = {}; for (const k of ['filmId', 'uid', 'paymentRef', 'periodId']) if (v[k] && v[k].trim()) q[k] = v[k].trim();
        call('creatorAdminLedger', q).then((r) => {
          host.querySelector('#aoscrDetail').innerHTML = (r.entries || []).length ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Entry</th><th>Kind</th><th>Bucket</th><th>Participant</th><th>Share</th><th>Amount</th><th>Ver.</th><th>Quarter</th></tr></thead><tbody>${r.entries.map((e) => `<tr><td class="aos-mono">${esc(e.entryId)}</td><td>${chip(e.kind)}</td><td>${esc(e.bucket)}</td><td class="aos-mono">${esc(e.uid || '—')}</td><td>${e.bps == null ? '—' : pct(e.bps)}</td><td>${e.kind === 'REVERSAL' ? '−' : ''}${kes(e.amountCents)}</td><td>${esc(e.agreementVersion)}</td><td>${esc(e.periodId)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="aos-muted">No matching entries.</p>';
        }).catch((e) => msg(e.message, true));
      }
    });

    async function render() {
      host.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try { body.innerHTML = await R[tab](); }
      catch (e) { body.innerHTML = `<p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}. Creator Hub ops need adminOsDispatch redeployed.</p>`; }
    }
    render();
    return true;
  }

  const OPS = ['creatorAdminList', 'creatorAdminSetState', 'creatorAdminFilms', 'creatorAdminFilmDetail', 'creatorAdminFilmTransition',
    'creatorAdminLockAgreement', 'creatorAdminLedger', 'creatorAdminPeriods', 'creatorAdminCalculatePeriod', 'creatorAdminApprovePeriod',
    'creatorAdminDistribute', 'creatorAdminClosePeriod', 'creatorAdminSetPayoutHold', 'creatorAdminStatements', 'creatorAdminSecurityEvents',
    'creatorAdminExceptions', 'creatorAdminRetryAccrual', 'creatorAdminAttestFee', 'creatorAdminRevokeEntitlement', 'creatorAdminConfig',
    'creatorAdminVerifications', 'creatorAdminVerificationDetail', 'creatorAdminVerificationDecision', 'creatorAdminPaymentCapability',
    'creatorAdminRefundCases', 'creatorAdminOverview'];

  root.SokoniAOSCreator = { mount, OPS, _kes: kes, _pct: pct, _esc: esc };
}(typeof window !== 'undefined' ? window : globalThis));
