/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-aos-reputation.js — AdminOS › Reviews & Reputation.

   Mount contract (same as sokoni-aos-entertainment):
     window.SokoniAOSReputation.mount({ host, call }) → true when rendered
   Ops (functions/reputation.js _adminH via adminOsDispatch, each re-checks the claim):
     repAdminReviews · repAdminModerate (hide / restore: admin · remove: super admin) ·
     repAdminEntity · repAdminRecount (super admin)
   Moderation never touches the booking that made a review eligible; every action needs a
   reason and is audited. Unknown figures render "—".
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-KE'));
  const when = (v) => (v ? new Date(Number(v)).toLocaleString('en-KE') : '—');
  const chip = (s) => `<span class="aos-badge" data-state="${esc(s)}">${esc(s || '—')}</span>`;
  const table = (head, rows, empty) => (rows ? `<div class="aos-table-wrap"><table class="aos-table"><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="aos-muted">${esc(empty)}</p>`);

  function mount(opts) {
    const host = opts && opts.host; const call = opts && opts.call;
    if (!host || typeof call !== 'function') return false;
    let q = { reported: true }; let ent = null;
    host.innerHTML = `<form class="aos-filters" data-q>
        <label>Show <select name="view"><option value="reported">Reported reviews</option><option value="hidden">Hidden</option><option value="removed">Removed</option><option value="published">Published</option><option value="entity">One profile</option></select></label>
        <label>Profile <select name="type"><option value="provider">Provider</option><option value="venue">Venue</option><option value="creator">Creator</option></select></label>
        <label>Id <input name="id" placeholder="provider uid / venue id"></label>
        <button class="aos-btn" type="submit">Show</button></form>
      <div class="aoscr-msg" data-msg role="status" aria-live="polite"></div><div data-body><div class="aos-spinner"><div></div></div></div>`;
    const body = host.querySelector('[data-body]');
    const msg = (t, bad) => { const m = host.querySelector('[data-msg]'); m.textContent = t || ''; m.style.color = bad ? '#ff6b6b' : '#71ff00'; };
    function ask(label, onOk) {
      const d = document.createElement('div'); d.className = 'aoscr-ask';
      d.innerHTML = `<label>Reason (kept in the audit log)<textarea rows="2" maxlength="500"></textarea></label><button type="button" class="aos-btn">${esc(label)}</button> <button type="button" class="aos-btn aos-btn-ghost">Cancel</button>`;
      body.prepend(d);
      const [ok, cancel] = d.querySelectorAll('button');
      cancel.onclick = () => d.remove();
      ok.onclick = () => { const v = d.querySelector('textarea').value; d.remove(); onOk(v); };
    }
    async function render() {
      body.innerHTML = '<div class="aos-spinner"><div></div></div>';
      try {
        let html = '';
        if (ent) {
          const e = await call('repAdminEntity', ent);
          html += `<h4>${esc(e.name)} ${chip(e.type)} ${e.isPublic ? chip('PUBLIC') : chip('NOT PUBLIC')}</h4>
            <p>Rating <strong>${e.reputation.rating == null ? '—' : Number(e.reputation.rating).toFixed(2)}</strong> · reviews ${num(e.reputation.reviewCount)} · followers ${num(e.reputation.followerCount)} · share events ${num(e.shareCount)}</p>
            <button type="button" class="aos-btn aos-btn-ghost" data-recount>Recount from records (super admin)</button>
            <h4>Audit</h4>${table(['When', 'Actor', 'Role', 'Action', 'Reason'], (e.audit || []).map((a) => `<tr><td>${when(a.at)}</td><td class="aos-mono">${esc(a.actor)}</td><td>${esc(a.role)}</td><td>${esc(a.action)}</td><td>${esc(a.reason || '')}</td></tr>`).join(''), 'No moderation yet.')}`;
        }
        const r = await call('repAdminReviews', q);
        html += '<h4>Reviews</h4>' + table(['Review', 'Profile', 'Rating', 'Status', 'Reports', 'Experience', ''], (r.reviews || []).map((x) => `<tr>
            <td style="max-width:320px">${esc(x.text || '')}<div class="aos-muted">${when(x.createdAt)}</div></td>
            <td class="aos-mono">${esc(x.entityType)} ${esc(x.entityId)}</td><td>${esc(x.rating)}★</td><td>${chip(x.status)}${x.moderation ? `<div class="aos-muted">${esc(x.moderation.action)}: ${esc(x.moderation.reason)}</div>` : ''}</td>
            <td>${num(x.reportCount)}${x.reports.length ? '<div class="aos-muted">' + x.reports.map((p) => esc(p.reason) + (p.role === 'provider' ? ' (provider)' : '')).join(', ') + '</div>' : ''}</td>
            <td class="aos-mono">${esc(x.sourceRef || '—')}</td>
            <td>${x.status === 'published' ? `<button type="button" class="aos-btn aos-btn-ghost" data-mod="hide" data-id="${esc(x.id)}">Hide</button>` : ''}
              ${x.status === 'hidden' ? `<button type="button" class="aos-btn aos-btn-ghost" data-mod="restore" data-id="${esc(x.id)}">Restore</button>` : ''}
              ${x.status !== 'removed' ? `<button type="button" class="aos-btn aos-btn-ghost" data-mod="remove" data-id="${esc(x.id)}">Remove (super admin)</button>` : ''}</td></tr>`).join(''), 'Nothing here.');
        body.innerHTML = html + '<p class="aos-muted">Hiding or removing a review takes it out of the public rating. The booking behind it is never changed.</p>';
      } catch (e) { body.innerHTML = `<p class="aos-muted">Could not load: ${esc((e && e.message) || 'error')}. Reputation ops need adminOsDispatch redeployed.</p>`; }
    }
    host.addEventListener('submit', (ev) => {
      if (!ev.target.matches('[data-q]')) return;
      ev.preventDefault();
      const f = ev.target; const v = f.view.value; const id = f.id.value.trim();
      ent = null;
      if (v === 'entity') { if (!id) return msg('Enter the profile id.', true); ent = { type: f.type.value, id }; q = { entityType: f.type.value, entityId: id }; }
      else if (v === 'reported') q = { reported: true };
      else q = { status: v };
      msg(''); render();
    });
    host.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.dataset.mod) {
        ask(b.textContent, async (reason) => {
          msg('Working…');
          try { await call('repAdminModerate', { reviewId: b.dataset.id, action: b.dataset.mod, reason }); msg('Done (audited).'); render(); }
          catch (e) { msg((e && e.message) || 'Refused.', true); }
        });
      }
      if (b.hasAttribute('data-recount') && ent) {
        ask('Recount', async (reason) => {
          try { await call('repAdminRecount', Object.assign({}, ent, { reason })); msg('Recounted (audited).'); render(); }
          catch (e) { msg((e && e.message) || 'Refused.', true); }
        });
      }
    });
    render();
    return true;
  }

  const OPS = ['repAdminReviews', 'repAdminModerate', 'repAdminEntity', 'repAdminRecount'];
  root.SokoniAOSReputation = { mount, OPS };
}(typeof window !== 'undefined' ? window : globalThis));
