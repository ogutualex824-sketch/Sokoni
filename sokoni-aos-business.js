/* ═══════════════════════════════════════════════════════════
   sokoni-aos-business.js — AdminOS › Business Categories  (CHANGELOG 236, convergence C1)

   Mount contract (same as sokoni-aos-legal):
     window.SokoniAOSBusiness.mount({ host, call }) → true when rendered
   Ops (functions/business-category-admin.js _adminH via adminOsDispatch; each re-checks the admin claim):
     bizAdminProviders · bizAdminClassify · bizAdminShops · bizAdminClassifyShop

   The category of an approved business is decided in ONE place: stamped by the server at approval from an exact
   match on the application, or decided here by an administrator — with a reason, in the audit log. The UNCLASSIFIED
   queue is the default view: those businesses were never given a guessed category. Categories owned by their own
   authority (Legal, Event organizer, Delivery) and the Healthcare boundary cannot be crossed from here — the server
   refuses them too. The commercial lane is shown, and is not changed by a reclassification.

   SELLER SHOPS (2026-09-28, the shop discovery authority): the same decision for shops/{id}.business, which the one
   discovery gate (business-category.shopEligibility) reads. Classifying never approves, activates or un-suspends a
   shop; a shop with no approval record needs the administrator's explicit attestation (recorded in the audit log).
   ═══════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const LANE = { healthcare: 'Healthcare 5%', entertainment: 'Entertainment 5%', provider: 'Plan rate' };
  /* shopEligibility reason codes → plain words (never an internal code on screen) */
  const WHY = { NOT_ACTIVE: 'not active', SUSPENDED: 'suspended', NOT_SEARCHABLE: 'hidden from search', NOT_PUBLIC: 'not public',
    UNCLASSIFIED: 'no SOKONI category', NOT_VISIBLE: 'account deactivated', DEACTIVATED: 'account deactivated', LOCKED: 'security lock' };
  const APPROVAL = { application: 'approved in Applications', admin: 'classified by an administrator', none: 'NO approval record' };

  function mount(opts) {
    const host = opts && opts.host; const call = opts && opts.call;
    if (!host || typeof call !== 'function') return false;
    let registry = 'providers'; let view = 'unclassified'; let cats = [];
    host.innerHTML = `<form class="aos-filters" data-q>
        <label>Registry <select name="registry" data-registry><option value="providers">Service businesses</option><option value="shops">Seller shops</option></select></label>
        <label>Show <select name="view" data-view></select></label>
        <button class="aos-btn" type="submit">Show</button></form>
      <p class="aos-muted" data-help></p>
      <div class="aoscr-msg" data-msg role="status" aria-live="polite"></div><div data-body><div class="aos-spinner"><div></div></div></div>`;
    const body = host.querySelector('[data-body]');
    const sel = host.querySelector('[data-view]');
    const reg = host.querySelector('[data-registry]');
    const help = host.querySelector('[data-help]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };
    const HELP = {
      providers: 'A category is stamped at approval only on an exact match with the application; anything else waits here. A reason is required and kept in the audit log.',
      shops: 'A shop appears publicly only when it is approved, active and has a SOKONI category. Classifying does not approve or un-suspend a shop. A reason is required and kept in the audit log.',
    };
    function resetViews() {
      cats = [];
      sel.innerHTML = `<option value="unclassified">Unclassified — decision needed</option><option value="all">${registry === 'shops' ? 'All shops' : 'All businesses'}</option>`;
      sel.value = view = 'unclassified';
      help.textContent = HELP[registry];
    }
    function fillCategories(list) {
      if (cats.length) return;
      cats = list || [];
      sel.insertAdjacentHTML('beforeend', cats.map((c) => `<option value="${esc(c.id)}">${esc(c.group + ' · ' + c.label)}</option>`).join(''));
      sel.value = view;
    }

    function options(row) {
      return cats.filter((c) => !c.authority && (!!row.healthcare) === (c.group === 'Healthcare'))
        .map((c) => `<option value="${esc(c.id)}"${c.id === row.category ? ' selected' : ''}>${esc(c.group + ' · ' + c.label)}</option>`).join('');
    }
    function shopOptions(row) {
      return cats.map((c) => `<option value="${esc(c.id)}"${c.id === row.category ? ' selected' : ''}>${esc(c.group + ' · ' + c.label)}</option>`).join('');
    }

    async function renderProviders() {
      const r = await call('bizAdminProviders', { view });
      fillCategories(r.categories);
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
    }

    async function renderShops() {
      const r = await call('bizAdminShops', { view });
      fillCategories(r.categories);
      const rows = r.shops || [];
      if (!rows.length) { body.innerHTML = `<p class="aos-muted" data-empty>${view === 'unclassified' ? 'No shop is waiting for a category.' : 'No shops in this view.'}</p>`; return; }
      body.innerHTML = `<div class="aos-table-wrap"><table class="aos-table"><thead><tr><th>Shop</th><th>Status</th><th>SOKONI category</th><th>Public?</th><th>Decide</th></tr></thead><tbody>${rows.map((s) => `<tr data-shop-row="${esc(s.shopId)}">
        <td>${esc(s.name || '—')}<div class="aos-muted aos-mono">${esc(s.shopId)}</div>${s.ownerWording ? `<div class="aos-muted">Owner calls it: “${esc(s.ownerWording)}”</div>` : ''}${s.city ? `<div class="aos-muted">${esc(s.city)}</div>` : ''}</td>
        <td><span class="aos-badge">${esc(s.status || '—')}</span><div class="aos-muted"${s.approval === 'none' ? ' style="color:#ff9800"' : ''}>${esc(APPROVAL[s.approval] || '—')}</div></td>
        <td>${s.category ? esc(s.categoryLabel) : '<span class="aos-badge" style="color:#ff9800">UNCLASSIFIED</span>'}<div class="aos-muted">${esc(s.source === 'admin' ? 'set by an administrator' : s.source === 'application' ? 'from the application' : 'never classified')}</div></td>
        <td>${s.eligible ? '<span class="aos-badge" style="color:#71ff00">Listed</span>' : `<span class="aos-badge">Not listed</span><div class="aos-muted">${esc((s.reasons || []).map((k) => WHY[k] || k).join(', '))}</div>`}</td>
        <td><form data-classify-shop="${esc(s.shopId)}" data-approval="${esc(s.approval)}" class="aos-inline-form"><select name="category" required aria-label="Category for ${esc(s.name || s.shopId)}"><option value="">Choose…</option>${shopOptions(s)}</select>
          <input name="reason" required minlength="3" maxlength="500" placeholder="Reason (audit log)" aria-label="Reason">
          ${s.approval === 'none' ? '<label class="aos-muted"><input type="checkbox" name="attest"> I verified this business</label>' : ''}
          <button class="aos-btn" type="submit">Save</button></form>
          <button class="aos-btn" type="button" data-docs="${esc(s.shopId)}" style="margin-top:6px">📄 Documents</button></td></tr>
        <tr data-docs-row="${esc(s.shopId)}" hidden><td colspan="5" data-docs-body="${esc(s.shopId)}"></td></tr>`).join('')}</tbody></table></div>`;
    }

    /* ── BUSINESS DOCUMENTS (universal catalogue U6, 2026-09-29) ─────────────────────────────────────────────────
       The documents THIS kind of business is asked for, each with its honest state. Open → a 5-minute signed link;
       Verify (optional expiry) / Reject (reason required). The server decides who may decide: the verification-reviewer
       capability — an admin claim alone is refused, and the refusal is shown, never hidden. */
    const DOC_STATE = { unsubmitted: 'Not provided', declared: 'Declared — number only', pending_review: 'Awaiting review',
      verified_on_file: 'Verified', rejected: 'Rejected', expired: 'Expired' };
    async function renderDocs(shopId) {
      const cell = host.querySelector('[data-docs-body="' + CSS.escape(shopId) + '"]');
      const row = host.querySelector('[data-docs-row="' + CSS.escape(shopId) + '"]');
      if (!cell || !row) return;
      row.hidden = false; cell.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try {
        const r = await call('bizAdminShopCompliance', { shopId });
        cell.innerHTML = '<div class="aos-muted" style="margin-bottom:6px">Documents a ' + esc(r.category || 'not-yet-classified') + ' business is asked for.</div>' +
          (r.docs || []).map((d) => '<div data-doc="' + esc(d.kind) + '" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 0;border-top:1px solid rgba(255,255,255,.08)">' +
            '<b style="min-width:220px">' + esc(d.title) + '</b>' +
            '<span class="aos-badge" data-doc-state="' + esc(d.state) + '"' + (d.state === 'verified_on_file' ? ' style="color:#71ff00"' : d.state === 'rejected' || d.state === 'expired' ? ' style="color:#ff9800"' : '') + '>' + esc(DOC_STATE[d.state] || d.state) + '</span>' +
            (d.number ? '<span class="aos-muted aos-mono">' + esc(d.number) + '</span>' : '') +
            (d.note ? '<span class="aos-muted">' + esc(d.note) + '</span>' : '') +
            (d.path ? '<button class="aos-btn" type="button" data-doc-open="' + esc(shopId) + '" data-kind="' + esc(d.kind) + '">Open</button>' +
              '<form class="aos-inline-form" data-doc-verify="' + esc(shopId) + '" data-kind="' + esc(d.kind) + '"><input type="date" name="expires" aria-label="Valid until (optional)"><button class="aos-btn" type="submit">Verify</button></form>' +
              '<form class="aos-inline-form" data-doc-reject="' + esc(shopId) + '" data-kind="' + esc(d.kind) + '"><input name="note" minlength="3" maxlength="500" placeholder="Why (the seller sees this)" aria-label="Rejection reason"><button class="aos-btn" type="submit">Reject</button></form>'
              : '<span class="aos-muted">No document uploaded — a number alone cannot be verified.</span>') +
            '</div>').join('');
      } catch (e) { cell.innerHTML = '<p class="aos-muted">Could not load documents: ' + esc((e && e.message) || 'error') + '</p>'; }
    }
    host.addEventListener('click', async (ev) => {
      const b = ev.target.closest && ev.target.closest('[data-docs],[data-doc-open]');
      if (!b || !host.contains(b)) return;
      if (b.hasAttribute('data-docs')) return renderDocs(b.getAttribute('data-docs'));
      b.disabled = true;
      try {
        const r = await call('bizAdminDocumentUrl', { shopId: b.getAttribute('data-doc-open'), kind: b.getAttribute('data-kind') });
        if (r && r.url) window.open(r.url, '_blank', 'noopener');
      } catch (e) { msg((e && e.message) || 'Could not open the document.', true); }
      b.disabled = false;
    });

    async function render() {
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try { await (registry === 'shops' ? renderShops() : renderProviders()); }
      catch (e) { body.innerHTML = `<p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}. Business category ops need adminOsDispatch redeployed.</p>`; }
    }

    reg.addEventListener('change', () => { registry = reg.value === 'shops' ? 'shops' : 'providers'; msg(''); resetViews(); render(); });

    host.addEventListener('submit', async (ev) => {
      const f = ev.target;
      ev.preventDefault();
      if (f.hasAttribute('data-q')) { view = sel.value; msg(''); return render(); }
      const vShop = f.getAttribute('data-doc-verify'), rShop = f.getAttribute('data-doc-reject');
      if (vShop || rShop) {
        const shopId = vShop || rShop, kind = f.getAttribute('data-kind');
        const payload = { shopId, kind, decision: vShop ? 'verified_on_file' : 'rejected' };
        if (vShop && f.expires && f.expires.value) payload.expiresAt = Date.parse(f.expires.value + 'T23:59:59+03:00');
        if (rShop) { payload.note = (f.note.value || '').trim(); if (payload.note.length < 3) { msg('Say why the document is rejected — the seller sees this.', true); return; } }
        const btn = f.querySelector('button'); btn.disabled = true;
        try {
          await call('bizAdminReviewPermit', payload);
          msg(vShop ? 'Verified. The storefront shows it to buyers. Recorded in the audit log.' : 'Rejected. The seller sees your reason. Recorded in the audit log.');
          await renderDocs(shopId);
        } catch (e) { msg((e && e.message) || 'Could not save the decision.', true); btn.disabled = false; }
        return;
      }
      const uid = f.getAttribute('data-classify'); const shopId = f.getAttribute('data-classify-shop');
      if (!uid && !shopId) return;
      const category = f.category.value; const reason = f.reason.value.trim();
      if (!category || reason.length < 3) { msg('Choose a category and give a reason.', true); return; }
      const attestApproval = !!(f.attest && f.attest.checked);
      if (shopId && f.getAttribute('data-approval') === 'none' && !attestApproval) { msg('This shop has no approval record. Tick “I verified this business”, or decide its application in Applications.', true); return; }
      const btn = f.querySelector('button'); btn.disabled = true;
      try {
        const r = shopId
          ? await call('bizAdminClassifyShop', { shopId, category, reason, attestApproval })
          : await call('bizAdminClassify', { uid, category, reason });
        /* only after the server answered */
        msg(shopId
          ? `Saved: ${r.label}. ${r.eligible ? 'The shop is now listed publicly.' : 'Not listed yet: ' + (r.reasons || []).map((k) => WHY[k] || k).join(', ') + '.'} Recorded in the audit log.`
          : `Saved: ${r.label}. Recorded in the audit log.`);
        await render();
      } catch (e) { msg((e && e.message) || 'Could not save.', true); btn.disabled = false; }
    });
    resetViews();
    render();
    return true;
  }

  const OPS = ['bizAdminProviders', 'bizAdminClassify', 'bizAdminShops', 'bizAdminClassifyShop',
    /* U6: business documents */
    'bizAdminShopCompliance', 'bizAdminReviewPermit', 'bizAdminDocumentUrl'];
  root.SokoniAOSBusiness = { mount, OPS };
})(typeof window !== 'undefined' ? window : globalThis);
