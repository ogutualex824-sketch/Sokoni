/* ═══════════════════════════════════════════════════════════════════════════════════
   sokoni-work-customer.js — the CUSTOMER side of campaigns / projects (Work/Job Engine; Marketing E2E, 2026-10-03)
   Server authority: functions/work-engine.js `workDispatch`. This module renders and calls; it never decides a state,
   a total or a price:
     list          workListMine (role customer)
     detail        workGet — scope (lines, deliverables, timeline, milestones, terms, documents), provider, status, changes
     accept        workTransition {to:'accepted', expectedScopeVersion}  — the SERVER's stored scope at the version shown;
                   a proposal edited since is refused (WORK_SCOPE_CHANGED) and reloaded. No total is ever sent.
     request changes  workTransition {to:'draft', reason}   ·   decline  {to:'cancelled'} (proposed)
     cancel        {to:'cancelled'} (accepted, before work starts)   ·   complete  {to:'completed', completionKind}
     changes       workDecideChange approve / decline (the customer is the ONLY approver)
     pay milestone workPayMilestone → SokoniBookService.payExisting (createPaymentIntent → IntaSend → held → PIN → release)
     messages      messages.html?tx=work_project&txId=<id>
   ═══════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const kes = (c) => (c == null ? '—' : 'KES ' + (Math.round(Number(c) || 0) / 100).toLocaleString('en-KE'));
  const $ = (id) => G.document.getElementById(id);
  const call = (op, data) => G.firebase.functions().httpsCallable('workDispatch')(Object.assign({ op }, data || {})).then((r) => r.data);
  const errText = (e) => (e && e.message) || 'Something went wrong — please try again.';
  const TONE = { draft: '', proposed: 'pending', accepted: 'paid', active: 'paid', paused: 'pending', completed: 'paid', archived: '', cancelled: 'cancelled', planned: '', delivered: 'pending' };
  const LABEL = { draft: 'Being prepared by the provider', proposed: 'Waiting for your decision', accepted: 'Accepted — work not started', active: 'In progress', paused: 'Paused', completed: 'Completed', archived: 'Archived', cancelled: 'Cancelled' };
  const badge = (s, label) => '<span class="badge ' + (TONE[s] || '') + '">' + esc(label || String(s || '—').replace(/_/g, ' ')) + '</span>';
  const card = (top, sub, extra) => '<div class="ord"><div class="ord-top">' + top + '</div>' + (sub ? '<div class="ord-sub">' + sub + '</div>' : '') + (extra || '') + '</div>';
  const state = (ico, t, sub) => '<div class="state"><span class="ico">' + ico + '</span><b>' + esc(t) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>';
  let current = null;

  function msg(t, bad) { const m = $('wcMsg'); if (m) { m.textContent = t || ''; m.className = 'msg' + (t ? (bad ? ' bad' : ' ok') : ''); } }

  async function list() {
    const el = $('wcBody'); current = null; msg('');
    el.innerHTML = '<div class="sk"><div class="sk-line" style="width:60%"></div><div class="sk-line" style="width:30%"></div></div>';
    try {
      const r = await call('workListMine');
      const items = ((r && r.items) || []).filter((i) => i.role === 'customer');
      el.innerHTML = '<div class="greet"><b>My campaigns &amp; projects</b><small>Proposals from providers you hired on SOKONI. You accept the scope, approve every change, pay each milestone through SOKONI and confirm completion.</small></div>'
        + (items.length ? '<div class="ord-list">' + items.map((i) => card('<span class="ord-id">' + esc(i.title || 'Untitled') + '</span><span class="ord-amt">' + esc(kes(i.totalCents)) + '</span>',
          badge(i.status, LABEL[i.status]) + '<span>' + esc(i.kind) + '</span>' + (i.openChanges ? '<span class="badge pending">' + esc(i.openChanges) + ' change to review</span>' : ''),
          '<div class="actions" style="margin-top:4px"><button type="button" class="act ghost" data-open="' + esc(i.id) + '">Open</button></div>')).join('') + '</div>'
          : state('📐', 'No campaigns or projects yet', 'When a provider turns your accepted quote into a campaign or project, it appears here.'));
    } catch (e) { el.innerHTML = '<div class="note err"><b>Could not load.</b> ' + esc(errText(e)) + ' This is not an empty list.</div>'; }
  }

  async function open(id, keepMsg) {
    const el = $('wcBody'); if (!keepMsg) msg('');
    el.innerHTML = '<div class="sk"><div class="sk-line" style="width:60%"></div></div>';
    let p;
    try { p = (await call('workGet', { projectId: id })).project; } catch (e) { el.innerHTML = '<div class="note err">' + esc(errText(e)) + '</div>'; return; }
    current = p;
    const live = p.scope || {}, acc = p.acceptedScope && p.acceptedScope.snapshot;
    /* after acceptance the customer sees EXACTLY what they accepted (the snapshot), plus approved changes below */
    const sc = acc || live;
    const lines = (sc.lines || []).map((l) => card('<span class="ord-id">' + esc(l.description) + '</span><span class="ord-amt">' + esc(kes(l.amountCents)) + '</span>', '<span>' + esc(l.kind) + '</span><span>' + esc(l.qty + ' ' + l.unit + ' × ' + kes(l.rateCents)) + '</span>')).join('');
    const ms = (live.milestones || []).map((m) => {
      const paid = m.payment && m.payment.bookingId;
      const canPay = p.status === 'active' || p.status === 'accepted';
      return card('<span class="ord-id">' + esc(m.title) + '</span><span class="ord-amt">' + esc(kes(m.amountCents)) + '</span>',
        badge(m.status || 'planned') + (m.dueDate ? '<span class="when">Due ' + esc(m.dueDate) + '</span>' : ''),
        canPay ? '<div class="actions" style="margin-top:4px"><button type="button" class="act" data-pay="' + esc(m.id) + '">' + (paid ? 'Continue / check payment' : 'Pay milestone') + '</button></div>' : '');
    }).join('');
    const crs = (p.changeRequests || []).map((c) => card('<span class="ord-id">' + esc(c.reason) + '</span><span class="ord-amt">' + esc((c.deltaCents >= 0 ? '+' : '') + kes(c.deltaCents)) + '</span>',
      badge(c.status === 'proposed' ? 'proposed' : c.status === 'approved' ? 'accepted' : 'cancelled', c.status === 'proposed' ? 'Waiting for you' : c.status),
      c.status === 'proposed' ? '<div class="actions" style="margin-top:4px"><button type="button" class="act" data-cr-approve="' + esc(c.crId) + '">Approve change</button><button type="button" class="act ghost" data-cr-decline="' + esc(c.crId) + '">Decline change</button></div>' : '')).join('');
    const docs = (sc.documents || []).map((d) => (/^https:/i.test(d) ? '<li><a href="' + esc(d) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(d.replace(/^https:\/\//, '')) + '</a></li>' : '<li class="mono">' + esc(d) + '</li>')).join('');
    const act = [];
    if (p.status === 'proposed') {
      act.push('<button type="button" class="act" data-accept="' + esc(String(p.scopeVersion)) + '">Accept this proposal (' + esc(kes(p.totalCents)) + ')</button>');
      act.push('<button type="button" class="act ghost" data-changes>Request changes</button>');
      act.push('<button type="button" class="act danger" data-move="cancelled">Decline</button>');
    }
    if (p.status === 'accepted') act.push('<button type="button" class="act danger" data-move="cancelled">Cancel (before work starts)</button>');
    if (p.status === 'active' || p.status === 'paused') act.push('<button type="button" class="act ghost" data-move="' + (p.status === 'active' ? 'paused' : 'active') + '">' + (p.status === 'active' ? 'Pause' : 'Resume') + '</button>');
    if (p.status === 'active') act.push('<button type="button" class="act" data-move="completed">Confirm the work is complete</button>');
    el.innerHTML = '<button type="button" class="act ghost" data-back>← My campaigns &amp; projects</button>'
      + '<div class="greet" style="margin-top:12px"><b>' + esc(sc.title || 'Untitled') + '</b><small>' + esc(p.kind) + ' · ' + esc(kes(p.totalCents)) + (acc ? ' · accepted version ' + esc(p.acceptedScope.scopeVersion) : ' · version ' + esc(p.scopeVersion)) + '</small></div>'
      + '<div class="badges">' + badge(p.status, LABEL[p.status]) + '</div>'
      + (p.changesRequested && p.status === 'draft' ? '<div class="note"><b>You asked for changes:</b> ' + esc(p.changesRequested.reason) + '</div>' : '')
      + (sc.description ? '<div class="note" style="white-space:pre-line">' + esc(sc.description) + '</div>' : '')
      + ((sc.deliverables || []).length ? '<div class="sec-t">Deliverables</div><div class="badges">' + sc.deliverables.map((d) => '<span class="tag">' + esc(d) + '</span>').join('') + '</div>' : '')
      + ((sc.startDate || sc.endDate) ? '<div class="sec-t">Timeline</div><div class="note" style="margin-top:0">' + esc(sc.startDate || '—') + ' → ' + esc(sc.endDate || '—') + '</div>' : '')
      + '<div class="sec-t">Pricing' + (acc ? ' (as accepted)' : '') + '</div>' + (lines ? '<div class="ord-list">' + lines + '</div>' : state('🧾', 'No scope lines yet'))
      + '<div class="sec-t">Milestones</div>' + (ms ? '<div class="ord-list">' + ms + '</div>' : state('🏁', 'No milestones yet'))
      + (sc.terms || sc.paymentTerms ? '<div class="sec-t">Terms</div><div class="note" style="margin-top:0;white-space:pre-line">' + esc(sc.terms || '') + (sc.paymentTerms ? '\n\nPayment: ' + esc(sc.paymentTerms) : '') + '</div>' : '')
      + (docs ? '<div class="sec-t">Documents</div><ul class="note" style="margin-top:0;padding-left:28px">' + docs + '</ul>' : '')
      + (crs ? '<div class="sec-t">Change requests</div><div class="ord-list">' + crs + '</div>' : '')
      + '<div data-changes-slot></div>'
      + '<div class="actions" style="margin-top:14px">' + act.join('') + '<a class="act ghost" href="messages.html?tx=work_project&txId=' + encodeURIComponent(p.id) + '">💬 Message the provider</a></div>'
      + '<div class="note">Payments go through SOKONI (IntaSend) and are held until you confirm, with your completion PIN, that the milestone was delivered. A paid milestone is never cancelled into a refund automatically — raise a dispute instead.</div>';
  }

  async function move(to, extra) {
    if (!current) return;
    try {
      await call('workTransition', Object.assign({ projectId: current.id, to }, extra || {}));
      msg(to === 'accepted' ? 'Proposal accepted — the terms are now locked.' : 'Updated.');
      await open(current.id, true);
    } catch (e) {
      const code = e && e.details && e.details.code;
      if (code === 'WORK_SCOPE_CHANGED') { msg('The provider changed the proposal since you opened it. Review the latest version, then accept.', true); await open(current.id, true); return; }
      msg(errText(e), true);
    }
  }

  async function onClick(e) {
    const b = e.target.closest ? e.target.closest('button') : null; if (!b) return;
    const d = b.dataset || {};
    if (d.open) return open(d.open);
    if ('back' in d) return list();
    if (d.accept !== undefined && current) { b.disabled = true; return move('accepted', { expectedScopeVersion: Number(d.accept) }); }
    if (d.move) {
      if (d.move === 'cancelled' && !G.confirm('Are you sure?')) return;
      b.disabled = true;
      return move(d.move, d.move === 'completed' ? { completionKind: 'delivered' } : {});
    }
    if ('changes' in d) {
      const slot = G.document.querySelector('[data-changes-slot]');
      if (slot) slot.innerHTML = '<form class="note" data-changes-form><label class="fld">What should the provider change?<textarea name="reason" rows="3" maxlength="1000" required></textarea></label><div class="actions"><button type="submit" class="act">Send to provider</button></div></form>';
      return;
    }
    if (d.crApprove || d.crDecline) {
      b.disabled = true;
      try { await call('workDecideChange', { projectId: current.id, crId: d.crApprove || d.crDecline, decision: d.crApprove ? 'approve' : 'decline' }); msg('Change ' + (d.crApprove ? 'approved.' : 'declined.')); await open(current.id); }
      catch (er) { b.disabled = false; msg(errText(er), true); }
      return;
    }
    if (d.pay) {
      b.disabled = true;
      try {
        const r = await call('workPayMilestone', { projectId: current.id, milestoneId: d.pay });
        if (G.SokoniBookService && typeof G.SokoniBookService.payExisting === 'function') G.SokoniBookService.payExisting({ bookingId: r.bookingId, serviceName: 'Milestone' });
        else msg('Payment could not start on this page. Refresh and try again.', true);
      } catch (er) { msg(errText(er), true); }
      b.disabled = false;
    }
  }
  async function onSubmit(e) {
    if (!(e.target && e.target.matches && e.target.matches('[data-changes-form]'))) return;
    e.preventDefault();
    const reason = String(e.target.elements.reason.value || '').trim();
    if (reason.length < 5) { msg('Tell the provider what to change (at least 5 characters).', true); return; }
    await move('draft', { reason });
  }

  async function init() {
    for (let i = 0; i < 100 && !(G.firebase && G.firebase.functions && G.firebase.auth); i++) await new Promise((r) => setTimeout(r, 100));
    G.document.addEventListener('click', onClick);
    G.document.addEventListener('submit', onSubmit);
    const u = await new Promise((res) => { try { const un = G.firebase.auth().onAuthStateChanged((x) => { try { un(); } catch (_) {} res(x || null); }); } catch (_) { res(null); } });
    if (!u) { $('wcBody').innerHTML = state('🔒', 'Sign in to see your campaigns and projects') + '<div class="actions" style="max-width:300px;margin:0 auto"><a class="act" href="login.html?next=my-projects.html">Sign in</a></div>'; return; }
    const id = new URLSearchParams(G.location.search || '').get('id');
    if (id) open(id); else list();
  }
  G.SokoniWorkCustomer = { init, _internal: { open, list, move, onClick, onSubmit, get current() { return current; } } };
  if (G.document && G.document.readyState !== 'loading') init(); else if (G.document) G.document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
