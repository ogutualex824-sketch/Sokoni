/* ═══════════════════════════════════════════════════════════════════════════
   sokoni-reputation.js — followers, ratings, reviews and sharing for providers,
   venues and creators. ONE client over ONE authority (functions/reputation.js via
   bookingDispatch). Displays only; never computes a rating or a count, never writes
   Firestore. Unknown figures render "—" (CLAUDE.md UI Data Integrity).

     SokoniRep.identity(host, { type, id, name })   ★ rating · reviews · followers · Follow · Share
     SokoniRep.reviews(host, { type, id })          distribution + published reviews + report
     SokoniRep.myReviews(host)                      what I can review · my reviews (edit)
     SokoniRep.dashboard(host, { type, id })        Audience · Reputation · Reported · Sharing
     SokoniRep.share({ type, id, serviceId, title }) a clean SOKONI link (no uid / phone / email)
   ═══════════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toLocaleString('en-KE'));
  const when = (ms) => (ms ? new Date(Number(ms)).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
  const stars = (r) => { const n = Math.round(Number(r) || 0); return '★'.repeat(n) + '☆'.repeat(5 - n); };
  const REASONS = { HARASSMENT: 'Harassment', SPAM: 'Spam', PERSONAL_INFORMATION: 'Personal information', FRAUD_ALLEGATION: 'Fraud / scam allegation', IRRELEVANT: 'Irrelevant', ABUSIVE: 'Abusive', OTHER: 'Other' };
  /* Pages on the MODULAR SDK (creator.html) hand in their own callable + current user. */
  let CFG = {};
  function configure(c) { CFG = Object.assign({}, CFG, c || {}); }
  function call(op, data, fnName) {
    const d = Object.assign({ op }, data || {});
    if (typeof CFG.callable === 'function') return CFG.callable(fnName || 'bookingDispatch', d);
    if (root.firebase && root.firebase.functions) return root.firebase.functions().httpsCallable(fnName || 'bookingDispatch')(d).then((r) => r.data);
    if (root.__sokoniFns) return root.__sokoniFns.httpsCallable(fnName || 'bookingDispatch')(d).then((r) => r.data);
    return Promise.reject(new Error('Unavailable right now.'));
  }
  const me = () => { try { if (typeof CFG.user === 'function') return CFG.user(); return root.firebase && root.firebase.auth && root.firebase.auth().currentUser; } catch (_) { return null; } };
  const CSS = `
  .skrep{color:#eee;font-size:14px}.skrep *{box-sizing:border-box}
  .skrep-strip{display:flex;flex-wrap:wrap;align-items:center;gap:10px}
  .skrep-stars{color:#f5c542;letter-spacing:1px}
  .skrep-btn{min-height:44px;padding:8px 14px;border-radius:22px;border:1px solid #262626;background:#141414;color:#eee;font-weight:700;cursor:pointer;font-size:14px}
  .skrep-btn.pri{background:#71ff00;color:#04120a;border-color:#71ff00}.skrep-btn.on{border-color:#71ff00;color:#71ff00}
  .skrep-btn[disabled]{opacity:.55;cursor:not-allowed}
  .skrep-muted{color:#9a9a9a;font-size:13px}
  .skrep-card{background:#0f0f0f;border:1px solid #1d1d1d;border-radius:14px;padding:12px;margin:8px 0;overflow-wrap:anywhere}
  .skrep-dist{display:grid;grid-template-columns:28px 1fr 38px;gap:4px 8px;align-items:center;font-size:12px;max-width:360px}
  .skrep-bar{height:6px;border-radius:3px;background:#1d1d1d;overflow:hidden}.skrep-bar span{display:block;height:100%;background:#f5c542}
  .skrep-in{width:100%;min-height:44px;background:#141414;border:1px solid #262626;color:#eee;border-radius:10px;padding:8px;font-size:16px;margin-top:6px}
  .skrep-starpick button{min-height:44px;min-width:40px;background:none;border:none;font-size:26px;cursor:pointer;color:#555}
  .skrep-starpick button.on{color:#f5c542}
  .skrep-msg{font-size:13px;margin-top:6px}.skrep-err{color:#ff6b6b}.skrep-ok{color:#71ff00}
  .skrep-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:8px}
  .skrep-kpi{background:#121212;border:1px solid #1f1f1f;border-radius:12px;padding:10px}.skrep-kpi b{display:block;font-size:1.2rem;color:#71ff00}
  `;
  function css() { if (!document.getElementById('skrep-css')) { const s = document.createElement('style'); s.id = 'skrep-css'; s.textContent = CSS; document.head.appendChild(s); } }

  /* ── share ─────────────────────────────────────────────────────────────────────── */
  async function share(o) {
    const r = await call('repShareLink', { type: o.type, id: o.id, serviceId: o.serviceId || undefined });
    let channel = 'copy'; let copied = false; let shared = false;
    try {
      if (navigator.share) { await navigator.share({ title: r.title || 'SOKONI', url: r.url }); channel = 'native'; shared = true; }
      else if (navigator.clipboard) { await navigator.clipboard.writeText(r.url); copied = true; }
    } catch (e) { if (e && e.name === 'AbortError') return Object.assign({}, r, { cancelled: true }); }
    /* Only a share that actually left the page is an event; a failed copy just shows the link. */
    if ((shared || copied) && o.type !== 'event') call('repShareEvent', { type: o.type, id: o.id, channel }).catch(() => {});
    return Object.assign({}, r, { copied, shared });
  }

  /* ── identity strip ────────────────────────────────────────────────────────────── */
  function identity(host, o) {
    if (!host) return null; css();
    host.innerHTML = '<div class="skrep"><div class="skrep-strip" data-strip><span class="skrep-muted">Loading…</span></div><div class="skrep-msg" data-msg role="status" aria-live="polite"></div></div>';
    const strip = host.querySelector('[data-strip]'); const msg = host.querySelector('[data-msg]');
    let following = false; let followers = null;
    async function render() {
      let s = null;
      try { s = (await call('repSummary', { items: [{ type: o.type, id: o.id }] })).summaries[`${o.type}:${o.id}`]; } catch (_) { s = null; }
      if (me()) { try { following = !!(await call('repFollowState', { items: [{ type: o.type, id: o.id }] })).following[`${o.type}:${o.id}`]; } catch (_) { following = false; } }
      followers = s ? s.followerCount : null;
      const rating = s && s.rating != null ? `<span class="skrep-stars" aria-hidden="true">${stars(s.rating)}</span> <strong>${Number(s.rating).toFixed(1)}</strong> <span class="skrep-muted">· ${num(s.reviewCount)} review${s.reviewCount === 1 ? '' : 's'}</span>` : '<span class="skrep-muted">No reviews yet</span>';
      strip.innerHTML = `<span aria-label="Rating">${rating}</span>
        <span class="skrep-muted" data-followers>${num(followers)} follower${followers === 1 ? '' : 's'}</span>
        ${s && s.verified ? '<span class="skrep-muted">✓ Verified</span>' : ''}
        <button type="button" class="skrep-btn${following ? ' on' : ' pri'}" data-follow aria-pressed="${following}">${following ? 'Following' : 'Follow'}</button>
        <button type="button" class="skrep-btn" data-share>Share</button>
        ${following ? '<label class="skrep-muted" style="display:flex;gap:6px;align-items:center;min-height:44px"><input type="checkbox" data-showme style="width:20px;height:20px"> Let them see my first name</label>' : ''}`;
    }
    host.addEventListener('change', async (ev) => {
      if (!ev.target.matches('[data-showme]')) return;
      try { await call('repFollowVisibility', { type: o.type, id: o.id, showMe: ev.target.checked }); msg.className = 'skrep-msg skrep-ok'; msg.textContent = ev.target.checked ? 'They can see your first name.' : 'You follow privately.'; }
      catch (e) { ev.target.checked = !ev.target.checked; msg.className = 'skrep-msg skrep-err'; msg.textContent = (e && e.message) || 'That did not work.'; }
    });
    host.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-follow')) {
        if (!me()) { location.href = 'login.html?next=' + encodeURIComponent(location.pathname + location.search); return; }
        b.disabled = true;
        try {
          const r = await call(following ? 'repUnfollow' : 'repFollow', { type: o.type, id: o.id });
          following = !!r.following; followers = r.followerCount;
          msg.textContent = '';
          await render();
        } catch (e) { msg.className = 'skrep-msg skrep-err'; msg.textContent = (e && e.message) || 'That did not work.'; }
        finally { b.disabled = false; }
      }
      if (b.hasAttribute('data-share')) {
        try { const r = await share({ type: o.type, id: o.id, title: o.name }); if (r.cancelled || r.shared) { msg.textContent = ''; return; } msg.className = 'skrep-msg skrep-ok'; msg.textContent = (r.copied ? 'Link copied: ' : 'Copy this link: ') + r.url; }
        catch (e) { msg.className = 'skrep-msg skrep-err'; msg.textContent = (e && e.message) || 'Could not share.'; }
      }
    });
    render();
    return { refresh: render };
  }

  /* ── public reviews ────────────────────────────────────────────────────────────── */
  function reviews(host, o) {
    if (!host) return null; css();
    let before = null; let rows = [];
    host.innerHTML = '<div class="skrep"><div data-dist></div><div data-list><p class="skrep-muted">Loading reviews…</p></div><div class="skrep-msg" data-msg role="status"></div></div>';
    async function load(more) {
      try {
        const [sum, r] = await Promise.all([more ? Promise.resolve(null) : call('repSummary', { items: [{ type: o.type, id: o.id }] }), call('repReviews', { type: o.type, id: o.id, before: more ? before : undefined, limit: 10 })]);
        if (sum) {
          const s = sum.summaries[`${o.type}:${o.id}`];
          const dist = s && s.ratingDist; const total = s ? s.reviewCount : 0;
          host.querySelector('[data-dist]').innerHTML = s && s.rating != null ? `<p><span class="skrep-stars">${stars(s.rating)}</span> <strong>${Number(s.rating).toFixed(1)}</strong> <span class="skrep-muted">· ${num(total)} verified review${total === 1 ? '' : 's'}</span></p>` +
            (dist ? `<div class="skrep-dist">${[5, 4, 3, 2, 1].map((k) => `<span>${k}★</span><div class="skrep-bar"><span style="width:${total ? Math.round(100 * (dist[k] || 0) / total) : 0}%"></span></div><span class="skrep-muted">${num(dist[k] || 0)}</span>`).join('')}</div>` : '') : '';
        }
        rows = more ? rows.concat(r.reviews) : r.reviews;
        before = rows.length ? rows[rows.length - 1].createdAt : null;
        const list = host.querySelector('[data-list]');
        list.innerHTML = rows.length ? rows.map((x) => `<article class="skrep-card"><div><span class="skrep-stars" aria-label="${x.rating} of 5">${stars(x.rating)}</span> <strong>${esc(x.author)}</strong>
          ${x.verified ? '<span class="skrep-muted">· Verified booking</span>' : ''} <span class="skrep-muted">· ${esc(when(x.createdAt))}${x.edited ? ' · edited' : ''}${x.service ? ' · ' + esc(x.service) : ''}</span></div>
          ${x.text ? `<p>${esc(x.text)}</p>` : ''}
          ${x.reply ? `<div class="skrep-card" style="margin-left:14px"><strong>Response from the provider</strong><p>${esc(x.reply.text)}</p></div>` : ''}
          ${me() && !x.mine ? `<details><summary class="skrep-muted" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Report</summary>
            <select class="skrep-in" data-reason="${esc(x.id)}">${Object.keys(REASONS).map((k) => `<option value="${k}">${esc(REASONS[k])}</option>`).join('')}</select>
            <button type="button" class="skrep-btn" data-report="${esc(x.id)}">Send report</button></details>` : ''}</article>`).join('') +
          (r.more ? '<button type="button" class="skrep-btn" data-more>More reviews</button>' : '') : '<p class="skrep-muted">No reviews yet.</p>';
      } catch (e) { host.querySelector('[data-list]').innerHTML = `<p class="skrep-err">${esc((e && e.message) || 'Reviews are unavailable.')}</p>`; }
    }
    host.addEventListener('click', async (ev) => {
      const b = ev.target.closest('button'); if (!b) return;
      if (b.hasAttribute('data-more')) return load(true);
      if (b.dataset.report) {
        const reason = b.closest("details").querySelector("[data-reason]").value;   /* NB: CSS here is the stylesheet string, not window.CSS */
        b.disabled = true;
        const m = host.querySelector('[data-msg]');
        try { await call('repReportReview', { reviewId: b.dataset.report, reason }); m.className = 'skrep-msg skrep-ok'; m.textContent = 'Thank you — SOKONI will review it. Reporting does not change the rating.'; }
        catch (e) { b.disabled = false; m.className = 'skrep-msg skrep-err'; m.textContent = (e && e.message) || 'Could not send the report.'; }
      }
      return undefined;
    });
    load(false);
    return { reload: () => load(false) };
  }

  /* ── my reviews (buyer) ────────────────────────────────────────────────────────── */
  function myReviews(host) {
    if (!host) return null; css();
    async function load() {
      host.innerHTML = '<div class="skrep"><p class="skrep-muted">Loading…</p></div>';
      let r;
      try { r = await call('repMyReviews', {}); } catch (e) { host.innerHTML = /unauthenticated/.test(String(e && (e.code || e.message))) ? '' : `<p class="skrep-err">${esc((e && e.message) || 'Unavailable.')}</p>`; return; }
      const now = Date.now();
      host.innerHTML = `<div class="skrep">
        ${r.eligible.length ? '<h4 style="margin:6px 0">Rate a completed booking</h4>' + r.eligible.map((e) => `<form class="skrep-card" data-rate="${esc(e.source)}|${esc(e.bookingId)}">
          <strong>${esc(e.service || 'Your booking')}</strong> <span class="skrep-muted">${esc(e.date || '')}</span>
          <div class="skrep-starpick" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" aria-label="${n} star${n > 1 ? 's' : ''}">★</button>`).join('')}</div>
          <textarea class="skrep-in" name="text" rows="3" maxlength="1000" placeholder="Tell others about your experience (optional)"></textarea>
          <button class="skrep-btn pri" type="submit">Post review</button><div class="skrep-msg"></div></form>`).join('') : ''}
        ${r.reviews.length ? '<h4 style="margin:10px 0 6px">Your reviews</h4>' + r.reviews.map((x) => `<div class="skrep-card"><span class="skrep-stars">${stars(x.rating)}</span> <span class="skrep-muted">${esc(x.service || '')} · ${esc(x.status)}</span>
          ${x.text ? `<p>${esc(x.text)}</p>` : ''}${x.reply ? `<p class="skrep-muted">Provider: ${esc(x.reply)}</p>` : ''}
          ${x.status === 'published' && x.edits < 3 && now < x.editableUntil ? `<details><summary class="skrep-muted" style="cursor:pointer;min-height:44px;display:flex;align-items:center">Edit</summary><form data-edit="${esc(x.id)}">
            <div class="skrep-starpick">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-star="${n}" class="${n <= x.rating ? 'on' : ''}">★</button>`).join('')}</div>
            <textarea class="skrep-in" name="text" rows="3" maxlength="1000">${esc(x.text || '')}</textarea><button class="skrep-btn" type="submit">Save</button><div class="skrep-msg"></div></form></details>` : ''}</div>`).join('') : ''}
        ${!r.eligible.length && !r.reviews.length ? '<p class="skrep-muted">After a completed booking you can rate it here.</p>' : ''}</div>`;
    }
    host.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-star]'); if (!b) return;
      const f = b.closest('form'); const n = Number(b.dataset.star);
      f.dataset.rating = n; f.querySelectorAll('[data-star]').forEach((x) => x.classList.toggle('on', Number(x.dataset.star) <= n));
    });
    host.addEventListener('submit', async (ev) => {
      const f = ev.target; ev.preventDefault();
      const m = f.querySelector('.skrep-msg'); const btn = f.querySelector('button[type=submit]');
      const rating = Number(f.dataset.rating || 0);
      try {
        btn.disabled = true;
        if (f.dataset.rate) {
          if (!rating) throw new Error('Choose a star rating.');
          const [source, bookingId] = f.dataset.rate.split('|');
          await call('repSubmitReview', { source, bookingId, rating, text: f.text.value });
        } else if (f.dataset.edit) {
          await call('repEditReview', { reviewId: f.dataset.edit, rating: rating || undefined, text: f.text.value });
        }
        load();
      } catch (e) { btn.disabled = false; m.className = 'skrep-msg skrep-err'; m.textContent = (e && e.message) || 'That did not work.'; }
    });
    load();
    return { reload: load };
  }

  /* ── provider dashboard ────────────────────────────────────────────────────────── */
  function dashboard(host, o) {
    if (!host) return null; css();
    async function load() {
      host.innerHTML = '<div class="skrep"><p class="skrep-muted">Loading…</p></div>';
      let d, f;
      try { [d, f] = await Promise.all([call('repDashboard', { type: o.type, id: o.id }), call('repFollowers', { type: o.type, id: o.id })]); }
      catch (e) { host.innerHTML = `<p class="skrep-err">${esc((e && e.message) || 'Unavailable.')}</p>`; return; }
      const rep = d.reputation || {}; const dist = rep.ratingDist; const total = rep.reviewCount || 0;
      const k = (l, v) => `<div class="skrep-kpi"><span>${esc(l)}</span><b>${esc(v)}</b></div>`;
      host.innerHTML = `<div class="skrep">
        <h4 style="margin:4px 0 8px">Audience</h4>
        <div class="skrep-grid">${k('Followers', num(f.followerCount))}${k('Shown by name', num(f.visible.length))}${k('Private followers', num(f.hiddenCount))}</div>
        ${f.visible.length ? `<div class="skrep-card">${f.visible.slice(0, 50).map((x) => `<div>${esc(x.name)} <span class="skrep-muted">· since ${esc(when(x.since))}</span></div>`).join('')}</div>` : '<p class="skrep-muted">Followers who choose to be seen appear here by first name. Their contact details are never shared.</p>'}
        <h4 style="margin:14px 0 8px">Reputation</h4>
        <div class="skrep-grid">${k('Average rating', rep.rating == null ? '—' : Number(rep.rating).toFixed(1) + ' ★')}${k('Reviews', num(total))}${k('Needs attention', num((d.reported || []).length))}</div>
        ${dist ? `<div class="skrep-dist" style="margin:8px 0">${[5, 4, 3, 2, 1].map((n) => `<span>${n}★</span><div class="skrep-bar"><span style="width:${total ? Math.round(100 * (dist[n] || 0) / total) : 0}%"></span></div><span class="skrep-muted">${num(dist[n] || 0)}</span>`).join('')}</div>` : ''}
        ${(d.recent || []).map((x) => `<article class="skrep-card"><span class="skrep-stars">${stars(x.rating)}</span> <strong>${esc(x.author)}</strong> <span class="skrep-muted">· ${esc(when(x.createdAt))}${x.status !== 'published' ? ' · ' + esc(x.status) : ''}${x.reportCount ? ' · reported ' + x.reportCount + '×' : ''}</span>
          ${x.text ? `<p>${esc(x.text)}</p>` : ''}
          ${x.reply ? `<p class="skrep-muted">Your reply: ${esc(x.reply)}</p>` : `<form data-reply="${esc(x.id)}"><textarea class="skrep-in" name="reply" rows="2" maxlength="1000" placeholder="Reply publicly (you cannot change the customer's review)"></textarea><button class="skrep-btn" type="submit">Reply</button><div class="skrep-msg"></div></form>`}</article>`).join('') || '<p class="skrep-muted">No reviews yet. Reviews come only from customers with a completed booking.</p>'}
        <h4 style="margin:14px 0 8px">Sharing</h4>
        <div class="skrep-grid">${k('Share events', num(d.sharing.shareCount))}</div>
        <p class="skrep-muted">A share event is one share action by a signed-in person per day — not a follower and not a rating.</p>
        <button type="button" class="skrep-btn pri" data-share>Share your profile</button> <span class="skrep-msg" data-sharemsg></span></div>`;
    }
    host.addEventListener('submit', async (ev) => {
      const f = ev.target; if (!f.dataset.reply) return; ev.preventDefault();
      const m = f.querySelector('.skrep-msg');
      try { await call('providerReplyReview', { reviewId: f.dataset.reply, reply: f.reply.value }, 'providerDispatch'); load(); }
      catch (e) { m.className = 'skrep-msg skrep-err'; m.textContent = (e && e.message) || 'Could not reply.'; }
    });
    host.addEventListener('click', async (ev) => {
      if (!ev.target.closest('[data-share]')) return;
      const m = host.querySelector('[data-sharemsg]');
      try { const r = await share({ type: o.type, id: o.id }); m.className = 'skrep-msg skrep-ok'; m.textContent = r.url; }
      catch (e) { m.className = 'skrep-msg skrep-err'; m.textContent = (e && e.message) || 'Could not share.'; }
    });
    load();
    return { reload: load };
  }

  root.SokoniRep = { identity, reviews, myReviews, dashboard, share, configure, _esc: esc };
}(typeof window !== 'undefined' ? window : globalThis));
