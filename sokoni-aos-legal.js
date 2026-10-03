/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-aos-legal.js — AdminOS › Legal Verification  (CHANGELOG 220)

   Mount contract (same as sokoni-aos-reputation):
     window.SokoniAOSLegal.mount({ host, call }) → true when rendered
   Ops (functions/legal-verification.js _adminH via adminOsDispatch; each re-checks the admin claim):
     legalAdminList · legalAdminGet · legalAdminRecordLsk (Mode B) · legalAdminRunLskCheck (Mode A)
     legalAdminRequestRecheck · legalAdminOpenReview
   The SOKONI decision is the EXISTING application decision — applicationDecide (a direct callable,
   deliberately not in the dispatcher whitelist) — so there is one approval authority, not two.

   An advocate is BOOKABLE only when the server says so (admin approved AND LSK verified AND current).
   There is no control here that sets "bookable" — it is always the server's derived answer.
   Manual LSK checks are labelled as manual; nothing here claims an automated LSK integration.
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const when = (v) => (v ? new Date(Number(v)).toLocaleString('en-KE') : '—');
  const day = (v) => (v ? new Date(Number(v)).toLocaleDateString('en-KE') : '—');
  const chip = (s, tone) => `<span class="aos-badge" data-state="${esc(s)}"${tone ? ` style="color:${tone}"` : ''}>${esc(s || '—')}</span>`;
  const table = (head, rows, empty) => (rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="aos-muted">${esc(empty)}</p>`);
  const ELIG = (e) => (e && e.bookable ? chip('BOOKABLE', '#71ff00') : chip('NOT BOOKABLE', '#ff6b6b') + (e && e.code ? ` <span class="aos-muted aos-mono">${esc(e.code)}</span>` : ''));
  const PRACTICE = ['Active', 'Inactive', 'Struck Off', 'Suspended', 'Unknown', 'Deceased'];

  function mount(opts) {
    const host = opts && opts.host; const call = opts && opts.call;
    if (!host || typeof call !== 'function') return false;
    let view = 'all'; let current = null; let etype = '';
    const T = root.SokoniLegalTaxonomy || null;
    const areaLabels = (a) => (a || []).map((x) => (T && T.label(x)) || x).join(', ');
    host.innerHTML = `<form class="aos-filters" data-q>
        <label>Show <select name="view"><option value="all">All advocates</option><option value="pending">Not yet bookable</option><option value="bookable">Bookable</option><option value="quarantined">Quarantined legacy records</option></select></label>
        <label>Type <select name="etype"><option value="">Lawyers &amp; law firms</option><option value="advocate">Lawyers</option><option value="firm">Law firms</option></select></label>
        <button class="aos-btn" type="submit">Show</button></form>
      <div class="aoscr-msg" data-msg role="status" aria-live="polite"></div><div data-body><div class="aos-spinner"><div></div></div></div>`;
    const body = host.querySelector('[data-body]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };

    async function renderList() {
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try {
        const r = await call('legalAdminList', etype ? { view, entityType: etype } : { view });
        let html = `<p class="aos-muted" data-lsk-integration>${esc(r.lskIntegration ? r.lskIntegration.statement : '')}</p>`;
        if (view === 'quarantined') {
          html += table(['Legacy identity', 'Label', 'Reason', 'Removed', 'Script'], (r.quarantined || []).map((q) => `<tr><td class="aos-mono">${esc(q.uid)}</td><td>${esc(q.label || '—')}</td><td>${esc(q.reason || '—')}</td><td>${when(q.removedAtMs)}</td><td class="aos-mono">${esc(q.scriptVersion || '—')}</td></tr>`).join(''), 'No quarantined records.');
        } else {
          html += table(['Advocate / firm', 'Type', 'Practice areas', 'SOKONI review', 'LSK', 'Practising status', 'Checked', 'Booking eligibility', ''], (r.advocates || []).map((a) => `<tr>
            <td>${esc(a.entityType === 'firm' ? (a.firmName || a.name) : a.name)}${a.entityType === 'firm' ? `<div class="aos-muted">responsible advocate: ${esc(a.name)}${a.firm ? ' · ' + esc(a.firm.offices) + ' office(s) · ' + esc(a.firm.teamDeclared) + ' declared advocate(s), not verified' : ''}</div>` : (a.firmName ? `<div class="aos-muted">${esc(a.firmName)}</div>` : '')}${a.legacyUnverified ? `<div class="aos-muted">legacy record — never verified</div>` : ''}</td>
            <td>${chip(a.entityType === 'firm' ? 'LAW FIRM' : 'LAWYER')}</td><td class="aos-muted">${esc(areaLabels(a.practiceAreas) || '—')}</td>
            <td>${chip(a.admin)}</td><td>${chip(a.lsk.status)}${a.lsk.stale ? ' ' + chip('STALE', '#ff9800') : ''}</td>
            <td>${esc(a.lsk.practiceStatus || '—')}</td><td>${day(a.lsk.checkedAtMs)}</td><td>${ELIG(a.eligibility)}</td>
            <td><button type="button" class="aos-btn aos-btn-ghost" data-open="${esc(a.uid)}">Open</button></td></tr>`).join(''), 'No advocates.');
        }
        body.innerHTML = html;
      } catch (e) { body.innerHTML = `<p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}. Legal verification ops need adminOsDispatch redeployed.</p>`; }
    }

    async function renderOne(uid) {
      current = uid;
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try {
        const g = await call('legalAdminGet', { uid });
        const a = g.advocate; const pv = g.private || {}; const adm = pv.admin || {}; const lsk = pv.lsk || {};
        const app = (g.applications || [])[0] || null;
        const link = a.providerLink;
        body.innerHTML = `
          <p><button type="button" class="aos-btn aos-btn-ghost" data-back>← All advocates</button></p>
          <h4>Identity</h4>
          <p><strong>${esc(a.name)}</strong>${a.firmName ? ' · ' + esc(a.firmName) : ''} · registered P.105 <span class="aos-mono">${esc(a.registeredP105 || '— (none)')}</span>
            <br><span class="aos-muted">Account <span class="aos-mono">${esc(a.uid)}</span> · practice areas (self-declared, not LSK-certified): ${esc((a.specializations || []).join(', ') || '—')}</span></p>
          <p>Canonical SOKONI provider: ${link ? chip(link.status) + (link.reason ? ` <span class="aos-muted">${esc(link.reason)}</span>` : '') : chip('not linked')}
            ${g.provider ? ` · providers status ${chip(g.provider.status)}` : ''}</p>

          <h4>Booking eligibility <span class="aos-muted">(derived by the server — never set by hand)</span></h4>
          <p data-eligibility>${ELIG(a.eligibility)}${g.bookingEnabled ? '' : ' <span class="aos-muted">· Legal payment is not connected yet — even an eligible advocate takes no paid bookings.</span>'}</p>

          <h4>1 · SOKONI verification</h4>
          <p>${chip(a.admin)} · reviewer <span class="aos-mono">${esc(adm.reviewedBy || '—')}</span> · ${when(adm.reviewedAtMs)}${adm.reason ? ` · “${esc(adm.reason)}”` : ''}</p>
          <p>Application: ${app ? `<span class="aos-mono">${esc(app.id)}</span> ${chip(app.status)}` : '<em>none</em>'}</p>
          ${app ? `<div class="aos-filters">
              <button type="button" class="aos-btn" data-decide="approve" data-app="${esc(app.id)}">Approve (SOKONI)</button>
              <button type="button" class="aos-btn aos-btn-ghost" data-decide="reject" data-app="${esc(app.id)}">Reject</button>
              <button type="button" class="aos-btn aos-btn-ghost" data-decide="suspend" data-app="${esc(app.id)}">Suspend</button></div>
              <p class="aos-muted">A SOKONI approval does not mean LSK verified. The advocate becomes bookable only when the LSK check below is also verified and current.</p>`
            : `<button type="button" class="aos-btn" data-open-review>Open an application for review</button>`}

          <h4>2 · LSK professional verification</h4>
          <p>${chip(a.lsk.status)}${a.lsk.stale ? ' ' + chip('STALE — re-verify', '#ff9800') : ''} · practising status <strong>${esc(a.lsk.practiceStatus || '—')}</strong>
            · checked ${day(a.lsk.checkedAtMs)} · current until ${day(a.lsk.validUntilMs)}</p>
          <p class="aos-muted">Source: ${esc(a.lsk.sourceLabel || '—')}${lsk.p105Number ? ` · P.105 <span class="aos-mono">${esc(lsk.p105Number)}</span>` : ''}${lsk.verifiedName ? ` · name returned “${esc(lsk.verifiedName)}”` : ''}${lsk.nameMatched === false ? ' · <strong>NAME DID NOT MATCH</strong>' : ''}
            ${lsk.evidenceRef ? ` · evidence <span class="aos-mono">${esc(lsk.evidenceRef)}</span>` : ''}${lsk.reviewedBy ? ` · recorded by <span class="aos-mono">${esc(lsk.reviewedBy)}</span>` : ''}</p>
          <p class="aos-muted" data-lsk-integration>${esc(g.lskIntegration.statement)}</p>
          <form data-lsk class="aos-filters" style="flex-wrap:wrap">
            <label>P.105 (as LSK shows it) <input name="p105Number" required placeholder="P.105/1234/05" value="${esc(a.registeredP105 || '')}"></label>
            <label>Name LSK returned <input name="verifiedName" required maxlength="120"></label>
            <label>Practising status <select name="practiceStatus">${PRACTICE.map((p) => `<option>${esc(p)}</option>`).join('')}</select></label>
            <label>Checked on <input name="checkedAt" type="date" required></label>
            <label>Evidence reference <input name="evidenceRef" required maxlength="300" placeholder="what you checked + where the capture is kept"></label>
            <label>Notes <input name="notes" maxlength="500"></label>
            <button class="aos-btn" type="submit">Record official-source check (manual)</button>
          </form>
          <p><button type="button" class="aos-btn aos-btn-ghost" data-lsk-auto>Check via authorized LSK integration</button>
             <button type="button" class="aos-btn aos-btn-ghost" data-recheck>Request re-verification</button></p>

          <h4>3 · Specialist practice areas <span class="aos-muted">(criminal · immigration · tax — public only once confirmed here)</span></h4>
          ${(a.specialistRequested || []).length ? '<div class="aos-filters" style="flex-wrap:wrap">' + (a.specialistRequested || []).map((sp) => {
              const on = (a.specialistConfirmed || []).indexOf(sp) > -1;
              return `<span>${chip(sp)} ${on ? chip('CONFIRMED', '#71ff00') : chip('requested')} <button type="button" class="aos-btn${on ? ' aos-btn-ghost' : ''}" data-spec="${esc(sp)}" data-spec-confirm="${on ? '0' : '1'}">${on ? 'Revoke' : 'Confirm'}</button></span>`;
            }).join(' ') + '</div>' : '<p class="aos-muted">No specialist area requested.</p>'}

          <h4>Audit history</h4>
          ${table(['When', 'Actor', 'Action', 'Previous', 'Next', 'Reason / evidence'], (g.events || []).map((e) => `<tr><td>${when(e.atMs)}</td><td class="aos-mono">${esc(e.actor || '—')}</td><td>${esc(e.action)}</td>
            <td>${esc(typeof e.previous === 'object' && e.previous ? (e.previous.status || '') + (e.previous.practiceStatus ? ' · ' + e.previous.practiceStatus : '') : (e.previous || '—'))}</td>
            <td>${esc(typeof e.next === 'object' && e.next ? (e.next.status || '') + (e.next.practiceStatus ? ' · ' + e.next.practiceStatus : '') : (e.next || '—'))}</td>
            <td>${esc(e.reason || '')}${e.evidenceRef ? ` <span class="aos-mono">${esc(e.evidenceRef)}</span>` : ''}</td></tr>`).join(''), 'No verification events yet.')}`;
      } catch (e) { body.innerHTML = `<p><button type="button" class="aos-btn aos-btn-ghost" data-back>← All advocates</button></p><p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}</p>`; }
    }

    function ask(label, onOk) {
      const d = document.createElement('div'); d.className = 'aoscr-ask';
      d.innerHTML = `<label>Reason (kept in the audit log)<textarea rows="2" maxlength="500"></textarea></label><button type="button" class="aos-btn">${esc(label)}</button> <button type="button" class="aos-btn aos-btn-ghost">Cancel</button>`;
      body.prepend(d);
      const [ok, cancel] = d.querySelectorAll('button');
      cancel.onclick = () => d.remove();
      ok.onclick = () => { const v = d.querySelector('textarea').value.trim(); if (v.length < 3) { msg('A reason is required.', true); return; } d.remove(); onOk(v); };
    }
    async function act(fn, done) {
      msg('Working…');
      try { await fn(); msg(done); await renderOne(current); } catch (e) { msg((e && e.message) || 'Refused.', true); }
    }

    host.addEventListener('submit', (ev) => {
      if (ev.target.matches('[data-q]')) { ev.preventDefault(); view = ev.target.view.value; etype = ev.target.etype ? ev.target.etype.value : ''; current = null; msg(''); renderList(); return; }
      if (ev.target.matches('[data-lsk]')) {
        ev.preventDefault();
        const f = ev.target;
        const data = { uid: current, p105Number: f.p105Number.value, verifiedName: f.verifiedName.value, practiceStatus: f.practiceStatus.value,
          /* the START of the chosen day in Nairobi (CHANGELOG 228): noon made a check recorded the same
             morning read as "in the future" and the server refused it */
          checkedAt: f.checkedAt.value ? Date.parse(f.checkedAt.value + 'T00:00:00+03:00') : null, evidenceRef: f.evidenceRef.value, notes: f.notes.value };
        act(() => call('legalAdminRecordLsk', data), 'LSK check recorded (audited).');
      }
    });
    host.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.open) { renderOne(b.dataset.open); return; }
      if (b.hasAttribute('data-back')) { current = null; renderList(); return; }
      if (b.dataset.decide) {
        ask(b.textContent, (reason) => act(() => call('applicationDecide', { applicationId: b.dataset.app, decision: b.dataset.decide, reason }), 'Decision recorded (audited).'));
        return;
      }
      if (b.dataset.spec) {
        const confirm = b.dataset.specConfirm === '1';
        ask((confirm ? 'Confirm ' : 'Revoke ') + b.dataset.spec, (reason) => act(() => call('legalAdminConfirmSpecialist', { uid: current, area: b.dataset.spec, confirm, reason }), (confirm ? 'Specialist area confirmed' : 'Specialist area revoked') + ' (audited).'));
        return;
      }
      if (b.hasAttribute('data-open-review')) { act(() => call('legalAdminOpenReview', { uid: current }), 'Application opened for review.'); return; }
      if (b.hasAttribute('data-recheck')) { ask('Request re-verification', (reason) => act(() => call('legalAdminRequestRecheck', { uid: current, reason }), 'Re-verification requested — not bookable until a new check is recorded.')); return; }
      if (b.hasAttribute('data-lsk-auto')) {
        msg('Working…');
        call('legalAdminRunLskCheck', { uid: current })
          .then((r) => { if (r && r.available === false) msg(r.statement, true); else { msg('LSK integration result recorded (audited).'); renderOne(current); } })
          .catch((e) => msg((e && e.message) || 'Refused.', true));
      }
    });
    renderList();
    return true;
  }

  const OPS = ['legalAdminList', 'legalAdminGet', 'legalAdminRecordLsk', 'legalAdminRunLskCheck', 'legalAdminRequestRecheck', 'legalAdminOpenReview', 'legalAdminConfirmSpecialist'];
  root.SokoniAOSLegal = { mount, OPS };
}(typeof window !== 'undefined' ? window : globalThis));
