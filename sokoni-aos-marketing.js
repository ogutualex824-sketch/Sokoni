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
  /* merchant-v2 badge tones (sokoni-mv2-skin.css): green = done/approved, amber = waiting, red = refused/cancelled */
  const TONE = { approved: 'paid', active: 'paid', LISTED: 'paid', paid_held: 'pending', settled: 'paid', completed: 'paid', verified: 'paid', pending: 'pending', info_requested: 'pending', under_review: 'pending', submitted: 'pending', rejected: 'failed', suspended: 'failed', revoked: 'failed', cancelled: 'cancelled', 'NOT LISTED': 'failed', withdrawn: '' };
  const chip = (s) => '<span class="badge ' + (TONE[s] || '') + '" data-state="' + esc(s) + '">' + esc(String(s || '—').replace(/_/g, ' ')) + '</span>';
  const tags = (arr) => '<div class="badges">' + (arr || []).map((x) => '<span class="tag">' + esc(x) + '</span>').join('') + '</div>';
  const empty = (ico, t, sub) => '<div class="state"><span class="ico">' + ico + '</span><b>' + esc(t) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  const card = (top, sub, extra, attrs) => '<' + (attrs ? 'button type="button" ' + attrs : 'div') + ' class="ord"><div class="ord-top">' + top + '</div>' + (sub ? '<div class="ord-sub">' + sub + '</div>' : '') + (extra || '') + '</' + (attrs ? 'button' : 'div') + '>';
  const stat = (v, label, neutral) => '<div class="stat' + (neutral ? ' neutral' : '') + '"><b>' + esc(v) + '</b><small>' + esc(label) + '</small></div>';
  const TYPE = { individual: 'Individual', agency: 'Agency', specialist: 'Specialist' };
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
    host.classList && host.classList.add('mv2s');          /* merchant-v2 design language (sokoni-mv2-skin.css), scoped */
    host.innerHTML = '<div class="greet"><b>Marketing</b><small>Applications, marketers, services and bookings. Decisions are the server\'s (applicationDecide).</small></div>'
      + '<div class="segs" role="tablist" data-tabs>'
      + [['dashboard', 'Dashboard'], ['applications', 'Applications'], ['marketers', 'Marketers'], ['services', 'Services'], ['bookings', 'Bookings'], ['more', 'Leads · Money · Reviews · Audit']]
        .map(([k, l]) => '<button type="button" class="seg" role="tab" data-tab="' + k + '">' + esc(l) + '</button>').join('')
      + '</div><div class="msg" data-msg role="status" aria-live="polite"></div><div data-body></div>';
    const body = host.querySelector('[data-body]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.className = 'msg' + (t ? (bad ? ' bad' : ' ok') : ''); };
    const skeleton = () => '<div class="ord-list">' + [1, 2, 3].map(() => '<div class="sk"><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:35%"></div></div>').join('') + '</div>';
    const fail = (e) => { body.innerHTML = '<div class="note err"><b>Could not load.</b> ' + esc((e && e.message) || 'The server did not answer.') + ' This is not an empty list.</div>'; };

    async function dashboard() {
      const r = await mk('marketingAdminOverview');
      const c = r.counts || {}, st = c.byStatus || {}, ty = c.byType || {};
      const n = (v) => (v == null ? '—' : v);
      body.innerHTML = '<div class="stats">'
        + stat(n(c.listed), 'Listed marketers', !c.listed)
        + stat((st.pending || 0) + (st.info_requested || 0), 'Awaiting a decision', !((st.pending || 0) + (st.info_requested || 0)))
        + stat(st.approved || 0, 'Approved applications', !st.approved)
        + stat((ty.agency || 0), 'Agencies', !ty.agency) + '</div>'
        + '<div class="sec-t">Applications by status</div>' + (Object.keys(st).length ? tags(Object.keys(st).map((k) => k.replace(/_/g, ' ') + ' · ' + st[k])) : empty('📭', 'No applications yet'))
        + '<div class="sec-t">Applications by type</div>' + (Object.keys(ty).length ? tags(Object.keys(ty).map((k) => (TYPE[k] || k) + ' · ' + ty[k])) : empty('📭', 'No applications yet'))
        + '<div class="sec-t">Listed marketers by service</div>' + (Object.keys(c.byCategory || {}).length ? tags(Object.keys(c.byCategory).map((k) => lab(k) + ' · ' + c.byCategory[k])) : empty('📣', 'No listed marketers yet', 'A marketer is listed only for the services an admin approved.'));
    }

    async function applications() {
      const r = await mk('marketingAdminOverview');
      let items = r.items || [];
      if (filter.status) items = items.filter((i) => (filter.status === 'pending' ? ['pending', 'info_requested'].indexOf(i.status) >= 0 : i.status === filter.status));
      if (filter.type) items = items.filter((i) => i.marketingType === filter.type);
      const fs = [['pending', 'Awaiting decision'], ['', 'All'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['suspended', 'Suspended / revoked'], ['withdrawn', 'Withdrawn']];
      body.innerHTML = '<div class="segs">' + fs.map(([v, l]) => '<button type="button" class="seg' + (filter.status === v ? ' on' : '') + '" data-fstatus="' + v + '">' + esc(l) + '</button>').join('') + '</div>'
        + '<div class="segs">' + [['', 'All types']].concat(Object.keys(TYPE).map((k) => [k, TYPE[k]])).map(([v, l]) => '<button type="button" class="seg' + (filter.type === v ? ' on' : '') + '" data-ftype="' + v + '">' + esc(l) + '</button>').join('') + '</div>'
        + (items.length ? '<div class="ord-list">' + items.map((i) => card(
          '<span class="ord-id">' + esc(i.name) + '</span><span class="ord-amt" style="color:var(--txt2);font-size:12px">' + esc(TYPE[i.marketingType] || '—') + '</span>',
          '<span>' + esc(i.county) + '</span>' + chip(i.status) + (i.reviewStage ? chip(i.reviewStage) : '') + '<span class="when">' + esc(when(i.receivedAtMs)) + '</span>',
          tags((i.requestedCategories || []).map(lab)), 'data-review="' + esc(i.id) + '"')).join('') + '</div>'
          : empty('📭', 'No applications match', 'Change the filter above.'));
    }

    async function review(id) {
      body.innerHTML = skeleton();
      const r = await mk('marketingAdminApplication', { applicationId: id });
      const a = r.application, rec = r.decisionRecord, live = ['pending', 'info_requested'].indexOf(a.status) >= 0;
      const terminal = a.reviewStage === 'revoked';
      const boxes = (a.requestedCategories || []).map((c) => '<label class="check"><input type="checkbox" name="cat" value="' + esc(c) + '"' + ((a.approvedCategories || []).indexOf(c) >= 0 ? ' checked' : '') + '> ' + esc(lab(c)) + '</label>').join('');
      const ag = a.agency ? '<div><b>Registration:</b> ' + esc(a.agency.registrationNumber || '—') + ' · <b>Team:</b> ' + esc(a.agency.teamSize || '—') + ' · <b>KRA PIN:</b> ' + esc(a.agency.kraPin || '—') + '</div>' : '';
      body.innerHTML = '<button type="button" class="act ghost" data-back>← Applications</button>'
        + '<div class="greet" style="margin-top:14px"><b>' + esc(a.name) + '</b><small>' + esc(TYPE[a.marketingType] || '') + ' · ' + esc(a.county) + '</small></div>'
        + '<div class="badges">' + chip(a.status) + (a.reviewStage ? chip(a.reviewStage) : '') + '</div>'
        + '<div class="note"><div><b>Phone:</b> ' + esc(a.phone) + ' · <b>Email:</b> ' + esc(a.email || '—') + ' · <b>Experience:</b> ' + esc(a.yearsExperience == null ? '—' : a.yearsExperience + ' yrs') + '</div>' + ag
        + '<p style="white-space:pre-line;margin:8px 0">' + esc(a.description) + '</p>'
        + '<div><b>Portfolio / documents:</b> ' + ((a.portfolio || []).length ? (a.portfolio || []).map((u) => '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(u) + '</a>').join(' · ') : '—') + '</div>'
        + '<div><b>Resubmissions:</b> ' + esc(a.resubmissions) + ' · <b>Received:</b> ' + esc(when(a.receivedAtMs)) + (a.reviewReason ? ' · <b>Last reviewer note:</b> ' + esc(a.reviewReason) : '') + '</div></div>'
        + '<div class="sec-t">Server decision record</div>' + (rec ? '<div class="note">' + chip(rec.status) + ' by <span class="mono">' + esc(rec.decidedBy) + '</span> · ' + esc(when(rec.atMs)) + '</div>' : '<div class="note">No server decision record yet.</div>')
        + '<div class="sec-t">Review history (immutable audit)</div>' + ((r.history || []).length ? '<div class="ord-list">' + r.history.map((h) => card('<span class="ord-id">' + esc(h.action) + '</span><span class="when" style="margin-left:auto;color:var(--txt3);font-size:11.5px">' + esc(when(h.atMs)) + '</span>', '<span class="mono">' + esc(h.by) + '</span>' + (h.reason ? '<span>' + esc(h.reason) + '</span>' : ''))).join('') + '</div>' : empty('🗂', 'No decisions yet'))
        + (r.marketer ? '<div class="sec-t">Live marketing listing</div><div class="badges">' + chip(r.marketer.status) + (r.marketer.listed ? chip('LISTED') : chip('NOT LISTED')) + '</div>' + tags((r.marketer.categories || []).map(lab)) : '')
        + '<div class="sec-t">Decide</div>' + (terminal ? '<div class="note"><b>Revoked — terminal.</b> No further decision is possible.</div>'
          : '<div class="note" style="margin-top:0">Tick ONLY the services you actually reviewed. The applicant is listed only for those.</div><div class="checks" data-cats style="margin-top:10px">' + boxes + '</div>'
          + '<label class="fld">Reason / note<input data-reason maxlength="500"></label>'
          + '<div class="actions">'
          + (live ? '<button type="button" class="act ghost" data-decide="mark_under_review">Mark under review</button><button type="button" class="act ghost" data-decide="mark_verified">Mark verified</button><button type="button" class="act ghost" data-decide="request_info">Request more information</button>' : '')
          + '<button type="button" class="act" data-decide="approve">Approve ticked services</button>'
          + '<button type="button" class="act danger" data-decide="reject">Reject</button><button type="button" class="act danger" data-decide="suspend">Suspend</button><button type="button" class="act danger" data-decide="revoke">Revoke (final)</button></div>');
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
      const items = r.items || [];
      body.innerHTML = items.length ? '<div class="ord-list">' + items.map((m) => card(
        '<span class="ord-id">' + esc(m.name) + '</span><span class="ord-amt" style="color:var(--txt2);font-size:12px">' + esc(TYPE[m.marketingType] || '—') + '</span>',
        chip(m.marketingStatus) + (m.listed ? chip('LISTED') : chip('NOT LISTED')) + '<span>' + (m.reviewCount > 0 && m.rating != null ? esc('★ ' + m.rating.toFixed(1) + ' (' + m.reviewCount + ')') : 'No reviews yet') + '</span><span class="when">' + esc(m.jobsCompleted) + ' completed</span>',
        tags((m.categories || []).map(lab)) + '<div class="mono">' + esc(m.uid) + '</div>')).join('') + '</div>' : empty('📣', 'No marketers yet');
    }
    async function services() {
      const r = await mk('marketingAdminServices');
      const items = r.items || [];
      body.innerHTML = items.length ? '<div class="ord-list">' + items.map((s) => card(
        '<span class="ord-id">' + esc(s.name) + '</span><span class="ord-amt">' + esc(s.priceCents ? kes(s.priceCents) : 'By quote') + '</span>',
        '<span>' + esc(lab(s.category)) + '</span><span>' + esc(s.pricingModel || '—') + '</span>' + (s.active ? chip('active') : chip('withdrawn')) + '<span class="when">' + esc((s.capabilities.booking ? 'Book' : '') + (s.capabilities.booking && s.capabilities.quote ? ' · ' : '') + (s.capabilities.quote ? 'Quote' : '')) + '</span>',
        '<div class="mono">' + esc(s.providerId) + '</div>')).join('') + '</div>' : empty('🧾', 'No marketing services yet', 'Approved marketers create services only inside their approved categories.');
    }
    async function bookings() {
      const r = await mk('marketingAdminBookings');
      const items = r.items || [];
      body.innerHTML = items.length ? '<div class="ord-list">' + items.map((b) => card(
        '<span class="ord-id">' + esc(b.service) + '</span><span class="ord-amt">' + esc(kes(b.priceCents)) + '</span>',
        '<span>' + esc(lab(b.serviceCategory)) + '</span>' + chip(b.status) + chip(b.paymentStatus) + '<span class="when">' + esc(when(b.createdAtMs)) + '</span>',
        '<div class="ord-sub"><span>Commission: ' + esc(b.commissionCents == null ? 'On completion' : kes(b.commissionCents)) + '</span><span class="mono">' + esc(b.id) + '</span></div>')).join('') + '</div>' : empty('📅', 'No marketing bookings yet');
    }
    function more() {
      body.innerHTML = '<div class="note" style="margin-top:0">These are the canonical AdminOS sections — Marketing records appear there with every other hub. Nothing is copied here.</div><div class="actions" style="margin-top:12px">'
        + LINKS.map(([l, s]) => '<button type="button" class="act ghost" data-nav="' + esc(s) + '">' + esc(l) + ' →</button>').join('') + '</div>';
    }

    const VIEWS = { dashboard, applications, marketers, services, bookings, more };
    async function show(t) {
      tab = t; msg('');
      Array.prototype.forEach.call(host.querySelectorAll('[data-tab]'), (b) => b.setAttribute('aria-selected', String(b.dataset.tab === t)));
      body.innerHTML = skeleton();
      try { await VIEWS[t](); } catch (e) { fail(e); }
    }
    host.addEventListener('click', (e) => {
      const b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      if (b.dataset.tab) return show(b.dataset.tab);
      if (b.dataset.review) return review(b.dataset.review).catch(fail);
      if ('back' in b.dataset) return show('applications');
      if (b.dataset.decide) return decide(b.dataset.decide);
      if (b.dataset.nav) return nav(b.dataset.nav);
      if (b.dataset.fstatus !== undefined) { filter.status = b.dataset.fstatus; return show('applications'); }
      if (b.dataset.ftype !== undefined) { filter.type = b.dataset.ftype; return show('applications'); }
    });
    show(tab);
    return true;
  }
  root.SokoniAOSMarketing = { mount, _internal: { LINKS } };
})(typeof window !== 'undefined' ? window : this);
