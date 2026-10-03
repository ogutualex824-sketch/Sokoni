/* ═══════════════════════════════════════════════════════════════════════════════════
   sokoni-aos-marketing.js — AdminOS › Marketing  (Marketing Hub MK5b, 2026-10-03)

   Mount contract (same as sokoni-aos-legal):  window.SokoniAOSMarketing.mount({ host, call, navigate }) → true
   Reads (functions/marketing-hub.js marketingDispatch — every op re-checks the admin claim server-side):
     marketingAdminOverview · marketingAdminApplication · marketingAdminProviders · marketingAdminServices · marketingAdminBookings
   The decision is the EXISTING application decision — applicationDecide — so there is ONE approval authority:
     mark_under_review / mark_verified (review stages, no projection) · request_info · approve WITH approvedCategories
     (the reviewer ticks ONLY the categories actually reviewed; the server refuses anything outside the request) ·
     reject · suspend · revoke (terminal, reason required). Nothing here writes Firestore.
   Leads, payments, receipts, wallets, commissions, settlements, subscriptions, reviews and audit are the canonical
   AdminOS sections — this panel links to them; it never keeps a second copy.
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const when = (v) => (v ? new Date(Number(v)).toLocaleString('en-KE') : '—');
  const kes = (c) => (c == null ? '—' : 'KES ' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-KE'));
  const chip = (s) => '<span class="aos-badge" data-state="' + esc(s) + '">' + esc(s || '—') + '</span>';
  const TYPE = { individual: 'Individual', agency: 'Agency', specialist: 'Specialist' };
  const table = (head, rows, empty) => (rows ? '<div class="aos-table-wrap"><table class="aos-table"><thead><tr>' + head.map((h) => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows + '</tbody></table></div>'
    : '<p class="aos-muted">' + esc(empty) + '</p>');
  const LINKS = [['Leads & quotes', 'services'], ['Bookings (all)', 'bookings'], ['Payments', 'payments'], ['Receipts, wallets, commissions & settlements', 'financial'],
    ['Reviews & moderation', 'content'], ['Fraud & trust', 'fraud'], ['Subscriptions & plans', 'config'], ['Audit', 'audit']];

  function mount(opts) {
    const host = opts && opts.host, call = opts && opts.call;
    const nav = (opts && opts.navigate) || ((s) => { if (root.SokoniAOS && root.SokoniAOS.navigate) root.SokoniAOS.navigate(s); });
    if (!host || typeof call !== 'function') return false;
    const T = root.SokoniMarketingTaxonomy || null;
    const lab = (c) => (T && T.label(c)) || c;
    const mk = (op, data) => call('marketingDispatch', Object.assign({ op }, data || {}));
    let tab = 'applications', filter = { status: 'pending', type: '' };
    host.innerHTML = '<div class="aos-tabs" role="tablist" data-tabs>'
      + [['dashboard', 'Dashboard'], ['applications', 'Applications'], ['marketers', 'Marketers'], ['services', 'Services'], ['bookings', 'Bookings'], ['more', 'Leads · Money · Reviews · Audit']]
        .map(([k, l]) => '<button type="button" class="aos-btn" role="tab" data-tab="' + k + '">' + esc(l) + '</button>').join('')
      + '</div><div class="aoscr-msg" data-msg role="status" aria-live="polite"></div><div data-body><div class="aos-spinner"><div></div></div></div>';
    const body = host.querySelector('[data-body]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };
    const fail = (e) => { body.innerHTML = '<p class="aos-muted" style="color:#ff6b6b">' + esc((e && e.message) || 'Could not load.') + '</p>'; };

    async function dashboard() {
      const r = await mk('marketingAdminOverview');
      const c = r.counts || {};
      const kv = (o) => Object.keys(o || {}).length ? Object.keys(o).map((k) => '<tr><td>' + esc(k) + '</td><td>' + esc(o[k]) + '</td></tr>').join('') : '';
      body.innerHTML = '<div class="aos-kpis"><div class="aos-kpi"><b>' + esc(c.listed == null ? '—' : c.listed) + '</b><span>Listed marketers</span></div>'
        + '<div class="aos-kpi"><b>' + esc((c.byStatus && c.byStatus.pending) || 0) + '</b><span>Applications awaiting a decision</span></div></div>'
        + '<h3>Applications by status</h3>' + table(['Status', 'Count'], kv(c.byStatus), 'No applications yet.')
        + '<h3>Applications by type</h3>' + table(['Type', 'Count'], kv(c.byType), 'No applications yet.')
        + '<h3>Listed marketers by service</h3>' + table(['Service', 'Marketers'], Object.keys(c.byCategory || {}).map((k) => '<tr><td>' + esc(lab(k)) + '</td><td>' + esc(c.byCategory[k]) + '</td></tr>').join(''), 'No listed marketers yet.');
    }

    async function applications() {
      const r = await mk('marketingAdminOverview');
      let items = r.items || [];
      if (filter.status) items = items.filter((i) => (filter.status === 'pending' ? ['pending', 'info_requested'].indexOf(i.status) >= 0 : i.status === filter.status));
      if (filter.type) items = items.filter((i) => i.marketingType === filter.type);
      body.innerHTML = '<form class="aos-filters" data-afilter><label>Status <select name="status">'
        + [['pending', 'Awaiting decision'], ['', 'All'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['suspended', 'Suspended / revoked'], ['withdrawn', 'Withdrawn']]
          .map(([v, l]) => '<option value="' + v + '"' + (filter.status === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select></label>'
        + '<label>Type <select name="type"><option value="">All types</option>' + Object.keys(TYPE).map((k) => '<option value="' + k + '"' + (filter.type === k ? ' selected' : '') + '>' + TYPE[k] + '</option>').join('') + '</select></label>'
        + '<button class="aos-btn" type="submit">Show</button></form>'
        + table(['Applicant', 'Type', 'Requested services', 'Status', 'Stage', 'Received', ''], items.map((i) => '<tr><td>' + esc(i.name) + '<div class="aos-muted">' + esc(i.county) + '</div></td><td>' + esc(TYPE[i.marketingType] || '—') + '</td><td>'
          + esc((i.requestedCategories || []).map(lab).join(', ')) + '</td><td>' + chip(i.status) + '</td><td>' + chip(i.reviewStage || '—') + '</td><td>' + esc(when(i.receivedAtMs)) + '</td><td><button type="button" class="aos-btn" data-review="' + esc(i.id) + '">Review</button></td></tr>').join(''),
        'No applications match.');
    }

    async function review(id) {
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      const r = await mk('marketingAdminApplication', { applicationId: id });
      const a = r.application, rec = r.decisionRecord, live = ['pending', 'info_requested'].indexOf(a.status) >= 0;
      const terminal = a.reviewStage === 'revoked';
      const boxes = (a.requestedCategories || []).map((c) => '<label class="aos-check"><input type="checkbox" name="cat" value="' + esc(c) + '"' + ((a.approvedCategories || []).indexOf(c) >= 0 ? ' checked' : '') + (terminal ? ' disabled' : '') + '> ' + esc(lab(c)) + '</label>').join('');
      const ag = a.agency ? '<div><b>Registration:</b> ' + esc(a.agency.registrationNumber || '—') + ' · <b>Team:</b> ' + esc(a.agency.teamSize || '—') + ' · <b>KRA PIN:</b> ' + esc(a.agency.kraPin || '—') + '</div>' : '';
      body.innerHTML = '<button type="button" class="aos-btn" data-back>← Applications</button>'
        + '<h3>' + esc(a.name) + ' — ' + esc(TYPE[a.marketingType] || '') + ' ' + chip(a.status) + ' ' + chip(a.reviewStage || '—') + '</h3>'
        + '<div class="aos-card"><div><b>County:</b> ' + esc(a.county) + ' · <b>Phone:</b> ' + esc(a.phone) + ' · <b>Email:</b> ' + esc(a.email || '—') + ' · <b>Experience:</b> ' + esc(a.yearsExperience == null ? '—' : a.yearsExperience + ' yrs') + '</div>' + ag
        + '<p style="white-space:pre-line">' + esc(a.description) + '</p>'
        + '<div><b>Portfolio / documents:</b> ' + ((a.portfolio || []).length ? (a.portfolio || []).map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(u) + '</a>').join(' · ') : '—') + '</div>'
        + '<div><b>Resubmissions:</b> ' + esc(a.resubmissions) + ' · <b>Received:</b> ' + esc(when(a.receivedAtMs)) + (a.reviewReason ? ' · <b>Last reviewer note:</b> ' + esc(a.reviewReason) : '') + '</div></div>'
        + '<h4>Server decision record</h4>' + (rec ? '<p>' + chip(rec.status) + ' by <span class="aos-mono">' + esc(rec.decidedBy) + '</span> · ' + esc(when(rec.atMs)) + '</p>' : '<p class="aos-muted">No server decision record yet.</p>')
        + '<h4>Review history (immutable audit)</h4>' + table(['When', 'Action', 'By', 'Reason'], (r.history || []).map((h) => '<tr><td>' + esc(when(h.atMs)) + '</td><td>' + esc(h.action) + '</td><td class="aos-mono">' + esc(h.by) + '</td><td>' + esc(h.reason || '') + '</td></tr>').join(''), 'No decisions yet.')
        + (r.marketer ? '<h4>Live marketing listing</h4><p>' + chip(r.marketer.status) + ' ' + (r.marketer.listed ? chip('LISTED') : chip('NOT LISTED')) + ' ' + esc((r.marketer.categories || []).map(lab).join(', ')) + '</p>' : '')
        + '<h4>Decide</h4>' + (terminal ? '<p class="aos-muted">Revoked — terminal. No further decision is possible.</p>'
          : '<p class="aos-muted">Tick ONLY the services you actually reviewed. The applicant is listed only for those.</p><div class="aos-checks" data-cats>' + boxes + '</div>'
          + '<label>Reason / note <input data-reason maxlength="500" style="width:100%"></label>'
          + '<div class="aos-actions">'
          + (live ? '<button type="button" class="aos-btn" data-decide="mark_under_review">Mark under review</button><button type="button" class="aos-btn" data-decide="mark_verified">Mark verified</button><button type="button" class="aos-btn" data-decide="request_info">Request more information</button>' : '')
          + '<button type="button" class="aos-btn aos-btn-primary" data-decide="approve">Approve ticked services</button>'
          + '<button type="button" class="aos-btn" data-decide="reject">Reject</button><button type="button" class="aos-btn" data-decide="suspend">Suspend</button><button type="button" class="aos-btn" data-decide="revoke">Revoke (final)</button></div>');
      body.dataset.app = id;
    }

    async function decide(decision) {
      const id = body.dataset.app; if (!id) return;
      const reason = (body.querySelector('[data-reason]') || {}).value || '';
      const cats = Array.prototype.slice.call(body.querySelectorAll('[data-cats] input[name="cat"]')).filter((x) => x.checked).map((x) => x.value);
      if (decision === 'approve' && !cats.length) { msg('Tick at least one service to approve.', true); return; }
      if ((decision === 'revoke' || decision === 'request_info' || decision === 'reject') && reason.trim().length < 5) { msg('Give a reason (at least 5 characters).', true); return; }
      const btns = body.querySelectorAll('[data-decide]'); Array.prototype.forEach.call(btns, (b) => { b.disabled = true; });
      try {
        await call('applicationDecide', Object.assign({ applicationId: id, decision, reason }, decision === 'approve' ? { approvedCategories: cats } : {}));
        msg('Decision recorded by the server (audited).');
        await review(id);
      } catch (e) {
        Array.prototype.forEach.call(btns, (b) => { b.disabled = false; });
        msg((e && e.message) || 'The server refused this decision.', true);
      }
    }

    async function marketers() {
      const r = await mk('marketingAdminProviders', { type: filter.type || undefined });
      body.innerHTML = table(['Marketer', 'Type', 'Marketing', 'Listed', 'Approved services', 'Rating', 'Completed'], (r.items || []).map((m) => '<tr><td>' + esc(m.name) + '<div class="aos-muted aos-mono">' + esc(m.uid) + '</div></td><td>' + esc(TYPE[m.marketingType] || '—') + '</td><td>' + chip(m.marketingStatus) + '</td><td>' + (m.listed ? 'Yes' : 'No') + '</td><td>'
        + esc((m.categories || []).map(lab).join(', ')) + '</td><td>' + (m.reviewCount > 0 && m.rating != null ? esc(m.rating.toFixed(1) + ' (' + m.reviewCount + ')') : 'No reviews yet') + '</td><td>' + esc(m.jobsCompleted) + '</td></tr>').join(''), 'No marketers yet.');
    }
    async function services() {
      const r = await mk('marketingAdminServices');
      body.innerHTML = table(['Service', 'Category', 'Provider', 'Pricing', 'Price', 'Book / Quote', 'Active'], (r.items || []).map((s) => '<tr><td>' + esc(s.name) + '</td><td>' + esc(lab(s.category)) + '</td><td class="aos-mono">' + esc(s.providerId) + '</td><td>' + esc(s.pricingModel || '—') + '</td><td>' + esc(s.priceCents ? kes(s.priceCents) : '—') + '</td><td>'
        + esc((s.capabilities.booking ? 'Book' : '') + (s.capabilities.booking && s.capabilities.quote ? ' · ' : '') + (s.capabilities.quote ? 'Quote' : '')) + '</td><td>' + (s.active ? 'Yes' : 'No') + '</td></tr>').join(''), 'No marketing services yet.');
    }
    async function bookings() {
      const r = await mk('marketingAdminBookings');
      body.innerHTML = table(['Booking', 'Service', 'Category', 'Price', 'Status', 'Payment', 'Commission', 'Created'], (r.items || []).map((b) => '<tr><td class="aos-mono">' + esc(b.id) + '</td><td>' + esc(b.service) + '</td><td>' + esc(lab(b.serviceCategory)) + '</td><td>' + esc(kes(b.priceCents)) + '</td><td>' + chip(b.status) + '</td><td>' + chip(b.paymentStatus) + '</td><td>'
        + esc(b.commissionCents == null ? 'On completion' : kes(b.commissionCents)) + '</td><td>' + esc(when(b.createdAtMs)) + '</td></tr>').join(''), 'No marketing bookings yet.');
    }
    function more() {
      body.innerHTML = '<p class="aos-muted">These are the canonical AdminOS sections — Marketing records appear there with every other hub. Nothing is copied here.</p><div class="aos-actions">'
        + LINKS.map(([l, s]) => '<button type="button" class="aos-btn" data-nav="' + esc(s) + '">' + esc(l) + ' →</button>').join('') + '</div>';
    }

    const VIEWS = { dashboard, applications, marketers, services, bookings, more };
    async function show(t) {
      tab = t; msg('');
      Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'), (b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try { await VIEWS[t](); } catch (e) { fail(e); }
    }
    host.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.dataset.tab) return show(b.dataset.tab);
      if (b.dataset.review) return review(b.dataset.review).catch(fail);
      if ('back' in b.dataset) return show('applications');
      if (b.dataset.decide) return decide(b.dataset.decide);
      if (b.dataset.nav) return nav(b.dataset.nav);
    });
    host.addEventListener('submit', (e) => {
      if (!e.target.matches('[data-afilter]')) return;
      e.preventDefault(); const f = e.target; filter = { status: f.status.value, type: f.type.value }; show('applications');
    });
    show(tab);
    return true;
  }
  root.SokoniAOSMarketing = { mount, _internal: { LINKS } };
})(typeof window !== 'undefined' ? window : this);
