/* ═══════════════════════════════════════════════════════════
   sokoni-aos-business.js — AdminOS › Business Categories  (CHANGELOG 236, convergence C1)

   Mount contract (same as sokoni-aos-legal):
     window.SokoniAOSBusiness.mount({ host, call }) → true when rendered
   Ops (functions/business-category-admin.js _adminH via adminOsDispatch; each re-checks the admin claim):
     bizAdminProviders · bizAdminClassify

   The category of an approved business is decided in ONE place: stamped by the server at approval from an exact
   match on the application, or decided here by an administrator — with a reason, in the audit log. The UNCLASSIFIED
   queue is the default view: those businesses were never given a guessed category. Categories owned by their own
   authority (Legal, Event organizer, Delivery) and the Healthcare boundary cannot be crossed from here — the server
   refuses them too. The commercial lane is shown, and is not changed by a reclassification.
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const LANE = { healthcare: 'Healthcare 5%', entertainment: 'Entertainment 5%', provider: 'Plan rate' };

  function mount(opts) {
    const host = opts && opts.host; const call = opts && opts.call;
    if (!host || typeof call !== 'function') return false;
    let view = 'unclassified'; let cats = [];
    host.innerHTML = `<form class="aos-filters" data-q><label>Show <select name="view" data-view><option value="unclassified">Unclassified — decision needed</option><option value="all">All businesses</option></select></label>
        <button class="aos-btn" type="submit">Show</button></form>
      <p class="aos-muted">A category is stamped at approval only on an exact match with the application; anything else waits here. A reason is required and kept in the audit log.</p>
      <div class="aoscr-msg" data-msg role="status" aria-live="polite"></div><div data-body><div class="aos-spinner"><div></div></div></div>`;
    const body = host.querySelector('[data-body]');
    const sel = host.querySelector('[data-view]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };

    function options(row) {
      return cats.filter((c) => !c.authority && (!!row.healthcare) === (c.group === 'Healthcare'))
        .map((c) => `<option value="${esc(c.id)}"${c.id === row.category ? ' selected' : ''}>${esc(c.group + ' · ' + c.label)}</option>`).join('');
    }

    async function render() {
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try {
        const r = await call('bizAdminProviders', { view });
        if (!cats.length) {
          cats = r.categories || [];
          sel.insertAdjacentHTML('beforeend', cats.map((c) => `<option value="${esc(c.id)}">${esc(c.group + ' · ' + c.label)}</option>`).join(''));
          sel.value = view;
        }
        const rows = r.providers || [];
        if (!rows.length) { body.innerHTML = `<p class="aos-muted" data-empty>${view === 'unclassified' ? 'No business is waiting for a category.' : 'No businesses in this view.'}</p>`; return; }
        body.innerHTML = `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Business</th><th>Status</th><th>Category</th><th>Commercial lane</th><th>Decide</th></tr></thead><tbody>${rows.map((p) => `<tr data-row="${esc(p.uid)}">
          <td>${esc(p.name || '—')}<div class="aos-muted aos-mono">${esc(p.uid)}</div>${p.city ? `<div class="aos-muted">${esc(p.city)}</div>` : ''}</td>
          <td><span class="aos-badge">${esc(p.status || '—')}</span></td>
          <td>${p.category ? esc(p.categoryLabel) : '<span class="aos-badge" style="color:#ff9800">UNCLASSIFIED</span>'}<div class="aos-muted">${esc(p.source === 'admin' ? 'set by an administrator' : p.source === 'legacy' ? 'approved before categories existed (legacy)' : 'from the application')}</div></td>
          <td>${esc(LANE[p.lane] || '—')}<div class="aos-muted">not changed by a reclassification</div></td>
          <td><form data-classify="${esc(p.uid)}" class="aos-inline-form"><select name="category" required aria-label="Category for ${esc(p.name || p.uid)}"><option value="">Choose…</option>${options(p)}</select>
            <input name="reason" required minlength="3" maxlength="500" placeholder="Reason (audit log)" aria-label="Reason">
            <button class="aos-btn" type="submit">Save</button></form></td></tr>`).join('')}</tbody></table></div>`;
      } catch (e) { body.innerHTML = `<p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}. Business category ops need adminOsDispatch redeployed.</p>`; }
    }

    host.addEventListener('submit', async (ev) => {
      const f = ev.target;
      ev.preventDefault();
      if (f.hasAttribute('data-q')) { view = sel.value; msg(''); return render(); }
      const uid = f.getAttribute('data-classify'); if (!uid) return;
      const category = f.category.value; const reason = f.reason.value.trim();
      if (!category || reason.length < 3) { msg('Choose a category and give a reason.', true); return; }
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        const r = await call('bizAdminClassify', { uid, category, reason });
        msg(`Saved: ${r.label}. Recorded in the audit log.`);   /* only after the server answered */
        await render();
      } catch (e) { msg((e && e.message) || 'Could not save.', true); btn.disabled = false; }
    });
    render();
    return true;
  }

  const OPS = ['bizAdminProviders', 'bizAdminClassify'];
  root.SokoniAOSBusiness = { mount, OPS };
})(typeof window !== 'undefined' ? window : globalThis);
