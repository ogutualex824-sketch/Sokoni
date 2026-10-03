/* ═══════════════════════════════════════════════════════════════════════════════════
   sokoni-merchant-mktpro.js — merchant-v2 › Marketing services (the MARKETER workspace; Marketing Hub MK6, 2026-10-03)
   Owner: provider mode in merchant-v2 (one shell for merchants AND providers) — this module mounts in the PROVIDER
   session for an approved marketer (group requires:'marketing', granted only when the server's businessWorkspace answer
   says marketing === true — decision-record backed). Not to be confused with sokoni-merchant-marketing.js (a merchant
   promoting their own shop).

   ONE module, ten views (mkt-*), ONE store. Every read and write is an EXISTING server op — nothing new in the browser:
     services / rates   NOT here — mkt-services / mkt-rates mount sokoni-e3's ONE rate-card editor directly (approved categories)
                        (the server re-checks the category against the APPROVED set on every write — 9319925 / e4f9b7d)
     leads / quotes     providerDispatch leadListForProvider · leadMarkViewed · leadDecline · leadSendQuote (the ONE lead engine)
     bookings           providerDispatch providerGetBookings
     campaigns/projects workDispatch workListMine · workGet · workCreate (from an ACCEPTED quote) · workUpdateScope ·
                        workTransition · workMilestoneDeliver · workProposeChange · workAddEvidence
     earnings           providerDispatch providerGetEarnings          reviews   providerGetReviews
     verification       marketingDispatch marketingMyStatus
   The category picker shows ONLY ctx.categories() (the server's approved set); the server refuses anything else anyway.
   Money is never computed here: prices are entered in KES and sent as integer cents; totals come back from the server.
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kes = (c) => (c == null ? '—' : 'KES ' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-KE'));
  const toCents = (v) => { const n = Number(String(v == null ? '' : v).replace(/[, ]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0; };
  const TONE = { active: 'paid', confirmed: 'pending', completed: 'paid', paid_held: 'pending', settled: 'paid', pending: 'pending', cancelled: 'cancelled', declined: 'failed', draft: '', proposed: 'pending', accepted: 'paid', paused: 'pending', archived: '', approved: 'paid', rejected: 'failed', suspended: 'failed' };
  const badge = (s) => '<span class="badge ' + (TONE[s] || '') + '">' + esc(String(s || '—').replace(/_/g, ' ')) + '</span>';
  const state = (ico, t, sub) => '<div class="state"><span class="ico">' + ico + '</span><b>' + esc(t) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  const stat = (v, l, neutral) => '<div class="stat' + (neutral ? ' neutral' : '') + '"><b>' + esc(v) + '</b><small>' + esc(l) + '</small></div>';
  const card = (top, sub, extra) => '<div class="ord"><div class="ord-top">' + top + '</div>' + (sub ? '<div class="ord-sub">' + sub + '</div>' : '') + (extra || '') + '</div>';
  const SK = '<div class="sk"><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:35%"></div></div>';
  /* mkt-services / mkt-rates are NOT views of this module: they mount sokoni-e3's ONE rate-card editor directly. */
  const VIEWS = ['overview', 'leads', 'quotes', 'bookings', 'campaigns', 'projects', 'earnings', 'verification'];

  function mount(host, ctx) {
    if (!host || !ctx) return null;
    const T = root.SokoniMarketingTaxonomy || null;
    const lab = (c) => (T && T.label(c)) || c;
    const view = VIEWS.indexOf(ctx.view) >= 0 ? ctx.view : 'overview';
    const pd = (op, data) => ctx.call('providerDispatch', Object.assign({ op }, data || {}));
    const wd = (op, data) => ctx.call('workDispatch', Object.assign({ op }, data || {}));
    const md = (op, data) => ctx.call('marketingDispatch', Object.assign({ op }, data || {}));
    const errText = (e) => (e && e.message) || 'The server did not answer.';
    let alive = true;
    /* P0-F (sokoni-e3): actions only when the provider session's server decision is editable === true; otherwise every
       view is READ-ONLY with the decision's own reason, and no mutating op is called. */
    const canEdit = () => !!(ctx.editable && ctx.editable() === true);
    const roNote = () => (canEdit() ? '' : '<div class="note"><b>Read-only.</b> ' + esc((ctx.readOnlyReason && ctx.readOnlyReason()) || 'Editing is not available for this account right now.') + '</div>');
    const paint = (html) => { if (alive) host.innerHTML = html; };
    const fail = (e) => paint('<div class="note err"><b>Could not load.</b> ' + esc(errText(e)) + ' This is not an empty list.</div>');
    const toast = (t) => { try { ctx.onToast && ctx.onToast(t); } catch (_) {} };

    /* Belt and braces: the shell already gates on the server 'marketing' capability; the module re-asks the server. */
    async function gate() {
      if (!ctx.uid()) { paint(state('🔒', 'Sign in to open Marketing services')); return null; }
      let st;
      try { st = await md('marketingMyStatus'); } catch (e) { fail(e); return null; }
      const m = st && st.marketer;
      if (!(m && m.listed && (m.categories || []).length)) {
        paint(state('📣', 'Marketing services open once SOKONI approves you', 'Apply or check your application on the Marketing Hub. You are listed only for the services an admin approved.')
          + '<div class="actions" style="max-width:340px;margin:0 auto"><a class="act" href="marketing-hub.html#become">Open the Marketing Hub</a></div>');
        return null;
      }
      return st;
    }

    async function overview(st) {
      paint('<div class="stats">' + SK + SK + '</div>');
      let earn = null, svc = null;
      try { [earn, svc] = await Promise.all([pd('providerGetEarnings').catch(() => null), pd('providerListServices').catch(() => null)]); } catch (_) {}
      const mine = ((svc && svc.services) || []).filter((s) => s.hub === 'marketing' && s.active !== false && !s.removedAt);
      const m = st.marketer;
      paint('<div class="greet"><b>Marketing services</b><small>' + esc((m.marketingType || 'marketer').replace(/^./, (c) => c.toUpperCase())) + ' · approved for ' + esc(m.categories.length) + ' service' + (m.categories.length === 1 ? '' : 's') + '</small></div>'
        + '<div class="stats">' + stat(mine.length, 'Live services', !mine.length)
        + stat(earn ? kes(earn.pending) : '—', 'Pending earnings', !earn || !earn.pending)
        + stat(earn ? kes(earn.net) : '—', 'Net earned', !earn || !earn.net)
        + stat(earn ? earn.count : '—', 'Completed bookings', !earn || !earn.count) + '</div>'
        + '<div class="sec-t">Approved services</div><div class="badges">' + m.categories.map((c) => '<span class="tag">' + esc(lab(c)) + '</span>').join('') + '</div>'
        + '<div class="sec-t">Go to</div><div class="actions">'
        + [['mkt-services', '🧾 Services & rates'], ['mkt-leads', '📨 Leads'], ['mkt-bookings', '📅 Bookings'], ['mkt-campaigns', '📣 Campaigns'], ['mkt-projects', '📐 Projects'], ['mkt-earnings', '💰 Earnings']]
          .map(([r, l]) => (ctx.hasRoute(r) ? '<button type="button" class="act ghost" data-go="' + r + '">' + esc(l) + '</button>' : '')).join('') + '</div>'
        + '<div class="note">Payments are made through SOKONI (IntaSend), held until the customer enters the completion PIN, then released to your business wallet less the SOKONI commission. Nothing here moves money.</div>');
    }

    async function bookings() {
      paint('<div class="ord-list">' + SK + SK + '</div>');
      const r = await pd('providerGetBookings', { limit: 50 });
      const list = ((r && r.bookings) || []).filter((b) => b.serviceHub === 'marketing');
      paint('<div class="greet"><b>Bookings</b><small>Marketing bookings. The price is the snapshot taken when the customer booked.</small></div>'
        + (list.length ? '<div class="ord-list">' + list.map((b) => card(
          '<span class="ord-id">' + esc(b.service || 'Booking') + '</span><span class="ord-amt">' + esc(kes(b.price)) + '</span>',
          '<span>' + esc(lab(b.serviceCategory)) + '</span>' + badge(b.status) + badge(b.paymentStatus) + '<span class="when">' + esc(b.date || '') + ' ' + esc(b.startTime || '') + '</span>',
          '<div class="actions" style="margin-top:4px"><a class="act ghost" href="messages.html?tx=service_booking&txId=' + encodeURIComponent(b.id) + '">💬 Message customer</a></div>')).join('') + '</div>'
          : state('📅', 'No marketing bookings yet')));
    }

    /* ── campaigns / projects (Work/Job Engine) ── */
    async function work(kind) {
      paint('<div class="ord-list">' + SK + SK + '</div>');
      const [mine, leads] = await Promise.all([wd('workListMine'), pd('leadListForProvider').catch(() => ({ leads: [] }))]);
      const items = ((mine && mine.items) || []).filter((i) => i.skin === 'marketing' && i.kind === kind && i.role === 'provider');
      const accepted = ((leads && leads.leads) || []).filter((l) => l.status === 'quote_accepted');
      const noun = kind === 'campaign' ? 'campaign' : 'project';
      paint('<div class="greet"><b>' + (kind === 'campaign' ? 'Campaigns' : 'Projects') + '</b><small>Scope, milestones and approvals. The customer accepts the scope and approves every change; milestones are paid through SOKONI and released on the completion PIN.</small></div>'
        + roNote()
        + (accepted.length && canEdit() ? '<div class="sec-t">Accepted quotes you can turn into a ' + noun + '</div><div class="ord-list">' + accepted.map((l) => card(
          '<span class="ord-id">' + esc((l.quote && l.quote.description) || l.message || 'Accepted quote') + '</span><span class="ord-amt">' + esc(kes(l.quote && l.quote.amountCents)) + '</span>', '',
          '<div class="actions" style="margin-top:4px"><button type="button" class="act" data-work-create="' + esc(l.id) + '" data-kind="' + kind + '">Start ' + noun + '</button></div>')).join('') + '</div>' : '')
        + '<div class="sec-t">Your ' + noun + 's</div>'
        + (items.length ? '<div class="ord-list">' + items.map((i) => card(
          '<span class="ord-id">' + esc(i.title || 'Untitled') + '</span><span class="ord-amt">' + esc(kes(i.totalCents)) + '</span>',
          badge(i.status) + (i.openChanges ? '<span class="badge pending">' + esc(i.openChanges) + ' change pending</span>' : ''),
          '<div class="actions" style="margin-top:4px"><button type="button" class="act ghost" data-work-open="' + esc(i.id) + '">Open</button></div>')).join('') + '</div>'
          : state(kind === 'campaign' ? '📣' : '📐', 'No ' + noun + 's yet', 'A ' + noun + ' starts from a quote the customer accepted.')));
    }
    async function workDetail(id) {
      paint('<div class="ord-list">' + SK + '</div>');
      const p = (await wd('workGet', { projectId: id })).project;
      const sc = p.scope || {}, draft = p.status === 'draft';
      const next = { draft: [['proposed', 'Send proposal to customer']], accepted: [['active', 'Start work']], active: [['paused', 'Pause']], paused: [['active', 'Resume']] }[p.status] || [];
      paint('<button type="button" class="act ghost" data-work-back="' + esc(p.kind) + '">← Back</button>'
        + '<div class="greet" style="margin-top:12px"><b>' + esc(sc.title || 'Untitled') + '</b><small>' + esc(p.kind) + ' · total ' + esc(kes(p.totalCents)) + '</small></div><div class="badges">' + badge(p.status) + '</div>'
        + '<div class="sec-t">Scope lines</div>' + ((sc.lines || []).length ? '<div class="ord-list">' + sc.lines.map((l) => card('<span class="ord-id">' + esc(l.description) + '</span><span class="ord-amt">' + esc(kes(l.amountCents)) + '</span>', '<span>' + esc(l.kind) + '</span><span>' + esc(l.qty + ' ' + l.unit + ' × ' + kes(l.rateCents)) + '</span>')).join('') + '</div>' : state('🧾', 'No scope lines yet'))
        + '<div class="sec-t">Milestones</div>' + ((sc.milestones || []).length ? '<div class="ord-list">' + sc.milestones.map((m) => card('<span class="ord-id">' + esc(m.title) + '</span><span class="ord-amt">' + esc(kes(m.amountCents)) + '</span>',
          badge(m.status || 'planned') + (m.payment && m.payment.bookingId ? '<span class="mono">' + esc(m.payment.bookingId) + '</span>' : ''),
          (canEdit() && p.status === 'active' && (m.status || 'planned') === 'planned' ? '<div class="actions" style="margin-top:4px"><button type="button" class="act ghost" data-ms-deliver="' + esc(m.id) + '">Mark delivered</button></div>' : ''))).join('') + '</div>' : state('🏁', 'No milestones yet'))
        + (draft && canEdit() ? '<div class="sec-t">Edit the proposal</div><form class="note" data-scope-form style="margin-top:0"><label class="fld">Title<input name="title" maxlength="160" value="' + esc(sc.title || '') + '"></label>'
          + '<label class="fld">Milestones — one per line: title | amount in KES<textarea name="milestones" rows="4">' + esc((sc.milestones || []).map((m) => m.title + ' | ' + (m.amountCents / 100)).join('\n')) + '</textarea></label>'
          + '<div class="msg" data-scope-msg role="alert"></div><div class="actions"><button type="submit" class="act">Save proposal</button></div></form>' : '')
        + ((p.changeRequests || []).length ? '<div class="sec-t">Change requests</div><div class="ord-list">' + p.changeRequests.map((c) => card('<span class="ord-id">' + esc(c.reason) + '</span><span class="ord-amt">' + esc((c.deltaCents >= 0 ? '+' : '') + kes(c.deltaCents)) + '</span>', badge(c.status === 'approved' ? 'accepted' : c.status === 'declined' ? 'declined' : 'pending'))).join('') + '</div>' : '')
        + '<div class="msg" data-work-msg role="alert"></div>'
        + roNote() + '<div class="actions">' + (canEdit() ? next.map(([to, l]) => '<button type="button" class="act" data-work-move="' + to + '">' + esc(l) + '</button>').join('') : '')
        + '<a class="act ghost" href="messages.html?tx=work_project&txId=' + encodeURIComponent(p.id) + '">💬 Message customer</a></div>'
        + '<div class="note">The customer accepts the scope, approves changes and confirms completion from their side. A paid milestone cannot be cancelled into a refund — disputes go through SOKONI.</div>');
      host._wp = p;
    }

    /* ── leads / quotes — the ONE lead engine (service-leads via providerDispatch); the server owns every transition ── */
    const LEAD_LABEL = { created: 'New', viewed: 'Opened', quote_sent: 'Quote sent', clarification_requested: 'Customer asked a question', quote_accepted: 'Quote accepted', quote_declined: 'Quote declined', declined: 'Declined', converted: 'Booked', closed: 'Closed by customer' };
    const QUOTE_STATES = ['quote_sent', 'clarification_requested', 'quote_accepted', 'quote_declined', 'converted'];
    async function leads(which) {
      paint('<div class="ord-list">' + SK + SK + '</div>');
      const [r, sv] = await Promise.all([pd('leadListForProvider'), pd('providerListServices').catch(() => ({ services: [] }))]);
      host._svcs = ((sv && sv.services) || []).filter((x) => x.hub === 'marketing' && x.active !== false && !x.removedAt);
      const list = ((r && r.leads) || []).filter((l) => (which === 'quotes' ? QUOTE_STATES.indexOf(l.status) >= 0 : QUOTE_STATES.indexOf(l.status) < 0));
      const tone = (st) => (st === 'quote_accepted' || st === 'converted' ? 'paid' : /declin|closed/.test(st) ? 'failed' : 'pending');
      paint('<div class="greet"><b>' + (which === 'leads' ? 'Leads' : 'Quotes') + '</b><small>'
        + (which === 'leads' ? 'Customer requests. Open one, reply in Messages, and send a quote.' : 'Quotes you sent. The customer accepts on their side; an accepted quote can be booked or turned into a campaign / project.') + '</small></div>'
        + (list.length ? '<div class="ord-list">' + list.map((l) => card(
          '<span class="ord-id">' + esc(l.message || 'Request') + '</span><span class="ord-amt">' + esc(l.quote && l.quote.amountCents ? kes(l.quote.amountCents) : '') + '</span>',
          '<span class="badge ' + tone(l.status) + '">' + esc(LEAD_LABEL[l.status] || l.status) + '</span>',
          !canEdit() ? '<div class="actions" style="margin-top:4px"><a class="act ghost" href="messages.html?tx=service_lead&txId=' + encodeURIComponent(l.id) + '">💬 Messages</a></div>' : '<div class="actions" style="margin-top:4px">'
            + (l.status === 'created' ? '<button type="button" class="act ghost" data-lead-view="' + esc(l.id) + '">Mark opened</button>' : '')
            + (['created', 'viewed', 'clarification_requested', 'quote_declined'].indexOf(l.status) >= 0 ? '<button type="button" class="act" data-lead-quote="' + esc(l.id) + '">Send quote</button>' : '')
            + (['created', 'viewed', 'clarification_requested'].indexOf(l.status) >= 0 ? '<button type="button" class="act danger" data-lead-decline="' + esc(l.id) + '">Decline</button>' : '')
            + '<a class="act ghost" href="messages.html?tx=service_lead&txId=' + encodeURIComponent(l.id) + '">💬 Messages</a></div><div data-quote-slot="' + esc(l.id) + '"></div>')).join('') + '</div>'
          : state('📨', which === 'leads' ? 'No open leads' : 'No quotes yet', which === 'leads' ? 'Customers reach you from the Marketing Hub.' : 'Send a quote from a lead.')));
    }
    function quoteForm(leadId) {
      const svc = host._svcs || [];
      if (!svc.length) return '<div class="note err">Create a marketing service first — a quote is for one of your services.</div>';
      return '<form class="note" data-quote-form data-lead="' + esc(leadId) + '"><label class="fld">Service<select name="serviceId">' + svc.map((x) => '<option value="' + esc(x.id) + '">' + esc(x.name) + '</option>').join('') + '</select></label>'
        + '<label class="fld">Amount (KES)<input name="amount" inputmode="decimal" required></label><label class="fld">What is included<textarea name="description" rows="3" maxlength="1000"></textarea></label>'
        + '<label class="fld">Valid for (days)<input name="validDays" type="number" min="1" max="30" value="7"></label><div class="msg" data-quote-msg role="alert"></div>'
        + '<div class="actions"><button type="submit" class="act">Send quote</button></div></form>';
    }

    async function earnings() {
      paint('<div class="stats">' + SK + SK + '</div>');
      const e = await pd('providerGetEarnings');
      paint('<div class="greet"><b>Earnings</b><small>From settled bookings (all your services). Commission is SOKONI\'s catalogue rate for the BOOKED service.</small></div>'
        + '<div class="stats">' + stat(kes(e.gross), 'Gross', !e.gross) + stat(kes(e.commission), 'SOKONI commission', !e.commission) + stat(kes(e.net), 'Net to you', !e.net)
        + stat(kes(e.pending), 'Pending (held)', !e.pending) + stat(kes(e.settled), 'Settled to wallet', !e.settled) + '</div>'
        + '<div class="note">Your business wallet, payouts and receipts open from the Financial Center once it is available to provider accounts.</div>');
    }
    async function verification(st) {
      const a = st.application || {}, m = st.marketer || {};
      paint('<div class="greet"><b>Verification</b><small>Your Marketing approval, as SOKONI\'s server records it.</small></div><div class="badges">' + badge(a.status) + (a.reviewStage ? badge(a.reviewStage) : '') + '</div>'
        + '<div class="sec-t">Approved services</div><div class="badges">' + (m.categories || []).map((c) => '<span class="tag">' + esc(lab(c)) + '</span>').join('') + '</div>'
        + ((a.declinedCategories || []).length ? '<div class="sec-t">Not approved</div><div class="badges">' + a.declinedCategories.map((c) => '<span class="tag" style="opacity:.6">' + esc(lab(c)) + '</span>').join('') + '</div>' : '')
        + '<div class="actions" style="margin-top:14px"><a class="act ghost" href="marketing-hub.html#become">Marketing Hub</a></div>');
    }

    async function run() {
      const st = await gate(); if (!st || !alive) return;
      try {
        if (view === 'overview') return await overview(st);
        if (view === 'leads' || view === 'quotes') return await leads(view);
        if (view === 'bookings') return await bookings();
        if (view === 'campaigns') return await work('campaign');
        if (view === 'projects') return await work('project');
        if (view === 'earnings') return await earnings();
        if (view === 'verification') return await verification(st);
      } catch (e) { fail(e); }
    }

    async function onClick(e) {
      const b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
      const d = b.dataset;
      if (d.go) return ctx.go(d.go);
      if ((d.leadView || d.leadDecline || d.leadQuote || d.workCreate || d.workMove || d.msDeliver) && !canEdit()) { toast('Read-only: editing is not available for this account right now.'); return; }
      if (d.leadView) { b.disabled = true; try { await pd('leadMarkViewed', { leadId: d.leadView }); await run(); } catch (er) { b.disabled = false; toast(errText(er)); } return; }
      if (d.leadDecline) { b.disabled = true; try { await pd('leadDecline', { leadId: d.leadDecline }); await run(); } catch (er) { b.disabled = false; toast(errText(er)); } return; }
      if (d.leadQuote) { const slot = host.querySelector('[data-quote-slot="' + d.leadQuote + '"]'); if (slot) slot.innerHTML = quoteForm(d.leadQuote); return; }
      if (d.workCreate) { b.disabled = true; try { const r = await wd('workCreate', { skin: 'marketing', kind: d.kind, originType: 'service_lead', leadId: d.workCreate }); await workDetail(r.projectId); } catch (er) { b.disabled = false; toast(errText(er)); } return; }
      if (d.workOpen) { try { await workDetail(d.workOpen); } catch (er) { fail(er); } return; }
      if (d.workBack) return work(d.workBack);
      const wm = host.querySelector('[data-work-msg]');
      if (d.workMove) { b.disabled = true; try { await wd('workTransition', { projectId: host._wp.id, to: d.workMove }); await workDetail(host._wp.id); } catch (er) { b.disabled = false; if (wm) { wm.textContent = errText(er); wm.className = 'msg bad'; } } return; }
      if (d.msDeliver) { b.disabled = true; try { await wd('workMilestoneDeliver', { projectId: host._wp.id, milestoneId: d.msDeliver }); await workDetail(host._wp.id); } catch (er) { b.disabled = false; if (wm) { wm.textContent = errText(er); wm.className = 'msg bad'; } } return; }
    }
    async function onSubmit(e) {
      const f = e.target;
      if (f.matches && (f.matches('[data-quote-form]') || f.matches('[data-scope-form]')) && !canEdit()) { e.preventDefault(); toast('Read-only: editing is not available for this account right now.'); return; }
      if (f.matches && f.matches('[data-quote-form]')) {
        e.preventDefault();
        const qm = f.querySelector('[data-quote-msg]'), amountCents = toCents(f.elements.amount.value);
        if (!amountCents) { qm.textContent = 'Enter the quote amount.'; qm.className = 'msg bad'; return; }
        qm.textContent = 'Sending…'; qm.className = 'msg';
        try {
          await pd('leadSendQuote', { leadId: f.dataset.lead, serviceId: f.elements.serviceId.value, amountCents, description: f.elements.description.value, validDays: Math.max(1, Math.min(30, Number(f.elements.validDays.value) || 7)) });
          toast('Quote sent.'); await run();
        } catch (er) { qm.textContent = errText(er); qm.className = 'msg bad'; }
        return;
      }
      if (f.matches && f.matches('[data-scope-form]')) {
        e.preventDefault();
        const msg = f.querySelector('[data-scope-msg]');
        const milestones = String(f.elements.milestones.value || '').split(/\n/).map((x) => x.split('|')).filter((p) => p[0] && p[0].trim())
          .map((p) => ({ title: p[0].trim(), amountCents: toCents(p[1]) }));
        try {
          await wd('workUpdateScope', { projectId: host._wp.id, scope: { title: f.elements.title.value, milestones } });
          await workDetail(host._wp.id);
        } catch (er) { msg.textContent = errText(er); msg.className = 'msg bad'; }
      }
    }
    host.addEventListener('click', onClick);
    host.addEventListener('submit', onSubmit);
    run();
    return { destroy() { alive = false; try { host._rc && host._rc.destroy && host._rc.destroy(); } catch (_) {} host.removeEventListener('click', onClick); host.removeEventListener('submit', onSubmit); } };
  }
  root.SokoniMerchantMktPro = { mount, VIEWS, _pure: { toCents, kes } };
})(typeof window !== 'undefined' ? window : this);
