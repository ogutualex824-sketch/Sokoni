/* ═══════════════════════════════════════════════════════════
   SokoniMarketingHub — the Marketing Hub page controller (Marketing Hub MK3, 2026-10-03)
   ═══════════════════════════════════════════════════════════
   Server authority: functions/marketing-hub.js `marketingDispatch` (taxonomy / directory / profile / apply / withdraw /
   my status) + the shared application review (applicationDecide approvedCategories → providers/{uid} marketing block).
   This module renders and calls; it never decides a state, a category or a price:
     directory      a FILTERED VIEW of approved marketers only (marketingDirectory) — no seeded agencies, no invented stats
     profile        marketingProfile → Request a quote (SokoniLeads.ask → leadCreate, the ONE lead/quote engine)
                    · Book (SokoniBookService.open → bookingCreateService → IntaSend → held → PIN → business wallet)
     become a marketer   three SEPARATE application types (individual / agency / specialist) → marketingApply
                    → applications/marketing_{uid} → AdminOS. The applicant can never pick a status or approve a category.
     my status      marketingMyStatus: under review / needs info (resubmit) / approved categories / declined / suspended
   Nothing here says "sent" / "submitted" until the server answered.
   ═══════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var T = function () { return G.SokoniMarketingTaxonomy; };
  var call = function (op, data) { return G.firebase.functions().httpsCallable('marketingDispatch')(Object.assign({ op: op }, data || {})).then(function (r) { return r.data; }); };
  var $ = function (id) { return G.document.getElementById(id); };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };
  var TYPE_LABEL = { individual: 'Individual marketer', agency: 'Agency', specialist: 'Specialist' };
  var STATUS_TEXT = {
    pending: ['⏳ Under review', 'Your application is with the SOKONI review team. You will be notified of the decision.'],
    info_requested: ['📝 More information needed', 'The reviewer asked for more information. Update your application and resubmit.'],
    rejected: ['✕ Not approved', 'Your application was not approved. You can update it and apply again.'],
    withdrawn: ['↩︎ Withdrawn', 'You withdrew this application. You can apply again at any time.'],
    approved: ['✅ Approved', 'You are an approved SOKONI marketer.'],
    suspended: ['⛔ Suspended', 'Your marketing listing is suspended. Contact SOKONI support.'],
    revoked: ['⛔ Approval revoked', 'SOKONI revoked this approval. It cannot be resubmitted — contact SOKONI support.'],
  };
  /* Review sub-stages from the ONE application engine (reviewStage; status stays canonical). Verified is NOT approved. */
  var STAGE_TEXT = { submitted: 'Submitted — waiting for a reviewer.', under_review: 'A reviewer is checking your application now.',
    verified: 'Your details are verified. SOKONI is deciding which services to approve.' };
  var S = { group: '', category: '', type: '', q: '', me: null, wiz: { step: 0, type: '', cats: [] } };

  async function ready() {
    for (var i = 0; i < 100 && !(G.firebase && G.firebase.functions && G.firebase.auth && T()); i++) await new Promise(function (r) { setTimeout(r, 100); });
    return !!(G.firebase && G.firebase.functions && T());
  }
  var signedIn = function () { return !!(G.firebase && G.firebase.auth && G.firebase.auth().currentUser); };
  function authReady() {
    return new Promise(function (res) {
      try { var un = G.firebase.auth().onAuthStateChanged(function (u) { try { un(); } catch (_) {} res(u || null); }); } catch (_) { res(null); }
    });
  }

  /* ── categories ── */
  function renderGroups() {
    var el = $('mhGroups'); if (!el) return;
    var html = '<button type="button" class="mh-chip' + (S.group ? '' : ' on') + '" data-group="">All</button>';
    T().GROUPS.forEach(function (g) { html += '<button type="button" class="mh-chip' + (S.group === g.id ? ' on' : '') + '" data-group="' + esc(g.id) + '">' + esc(g.icon + ' ' + g.label) + '</button>'; });
    el.innerHTML = html;
    var sub = $('mhServices');
    if (sub) {
      var g = T().GROUPS.filter(function (x) { return x.id === S.group; })[0];
      sub.innerHTML = g ? g.services.map(function (s) { return '<button type="button" class="mh-chip sm' + (S.category === s.id ? ' on' : '') + '" data-cat="' + esc(s.id) + '">' + esc(s.label) + '</button>'; }).join('') : '';
      sub.hidden = !g;
    }
  }

  /* ── directory ── */
  function card(m) {
    var cats = (m.categories || []).slice(0, 3).map(function (c) { return '<span class="mh-tag">' + esc(T().label(c)) + '</span>'; }).join('');
    var more = (m.categories || []).length > 3 ? '<span class="mh-tag">+' + ((m.categories.length - 3)) + '</span>' : '';
    var rating = m.reviewCount > 0 && typeof m.rating === 'number' ? '★ ' + m.rating.toFixed(1) + ' (' + m.reviewCount + ')' : 'No reviews yet';
    return '<button type="button" class="mh-card" data-uid="' + esc(m.uid) + '">'
      + '<div class="mh-card-top"><div class="mh-avatar">' + (m.photoURL ? '<img src="' + esc(m.photoURL) + '" alt="" loading="lazy">' : esc((m.name || '?').charAt(0).toUpperCase())) + '</div>'
      + '<div class="mh-card-id"><div class="mh-card-name">' + esc(m.name) + '</div><div class="mh-card-sub">' + esc(TYPE_LABEL[m.marketingType] || 'Marketer') + (m.city ? ' · ' + esc(m.city) : '') + '</div></div></div>'
      + '<div class="mh-card-desc">' + esc(m.description) + '</div>'
      + '<div class="mh-tags">' + cats + more + '</div>'
      + '<div class="mh-card-foot"><span>' + esc(rating) + '</span><span>' + (m.jobsCompleted > 0 ? esc(m.jobsCompleted + ' completed on SOKONI') : 'New on SOKONI') + '</span></div>'
      + '</button>';
  }
  var _dirSeq = 0;
  async function loadDirectory() {
    var el = $('mhList'), info = $('mhListInfo'); if (!el) return;
    var seq = ++_dirSeq;
    el.innerHTML = '<div class="mh-empty">Loading marketers…</div>';
    try {
      var r = await call('marketingDirectory', { group: S.group || undefined, category: S.category || undefined, type: S.type || undefined, q: S.q || undefined, limit: 48 });
      if (seq !== _dirSeq) return;
      var items = (r && r.items) || [];
      if (info) info.textContent = items.length ? items.length + ' approved marketer' + (items.length === 1 ? '' : 's') : '';
      el.innerHTML = items.length ? items.map(card).join('')
        : '<div class="mh-empty"><b>No approved marketers here yet.</b><br>Are you a marketer? <a href="#become" data-scroll-become>Apply to be listed</a>.</div>';
    } catch (e) {
      if (seq !== _dirSeq) return;
      if (info) info.textContent = '';
      el.innerHTML = '<div class="mh-empty err">We couldn\'t load marketers right now. <button type="button" class="mh-link" data-retry>Try again</button></div>';
    }
  }

  /* ── profile ── */
  function modal(html) {
    closeModal();
    var o = G.document.createElement('div'); o.id = 'mhModal'; o.className = 'mh-modal-overlay'; o.setAttribute('role', 'dialog'); o.setAttribute('aria-modal', 'true');
    o.innerHTML = '<div class="mh-modal"><button type="button" class="mh-x" data-close aria-label="Close">×</button>' + html + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o || (e.target.closest && e.target.closest('[data-close]'))) closeModal(); });
    G.document.body.appendChild(o);
    return o;
  }
  function closeModal() { var o = $('mhModal'); if (o) o.remove(); }
  async function openProfile(uid) {
    var m = modal('<div class="mh-empty">Loading…</div>');
    try {
      var p = (await call('marketingProfile', { uid: uid })).profile;
      var cats = (p.categories || []).map(function (c) { return '<span class="mh-tag">' + esc(T().label(c)) + '</span>'; }).join('');
      var port = (p.portfolio || []).map(function (u) { return '<li><a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer nofollow">' + esc(u.replace(/^https:\/\//, '')) + '</a></li>'; }).join('');
      var rating = p.reviewCount > 0 && typeof p.rating === 'number' ? '★ ' + p.rating.toFixed(1) + ' from ' + p.reviewCount + ' review' + (p.reviewCount === 1 ? '' : 's') : 'No reviews yet';
      m.querySelector('.mh-modal').innerHTML = '<button type="button" class="mh-x" data-close aria-label="Close">×</button>'
        + '<div class="mh-prof-head"><div class="mh-avatar lg">' + (p.photoURL ? '<img src="' + esc(p.photoURL) + '" alt="">' : esc((p.name || '?').charAt(0).toUpperCase())) + '</div>'
        + '<div><h2>' + esc(p.name) + '</h2><div class="mh-card-sub">' + esc(TYPE_LABEL[p.marketingType] || 'Marketer') + (p.city ? ' · ' + esc(p.city) : '') + ' · <span class="mh-verified">✔ Approved by SOKONI</span></div>'
        + '<div class="mh-card-sub">' + esc(rating) + '</div></div></div>'
        + '<p class="mh-prof-desc">' + esc(p.description) + '</p>'
        + '<div class="mh-sec-label">Approved services</div><div class="mh-tags">' + cats + '</div>'
        + (port ? '<div class="mh-sec-label">Portfolio</div><ul class="mh-port">' + port + '</ul>' : '')
        + '<div class="mh-prof-actions">'
        + '<button type="button" class="mh-btn" data-quote="' + esc(p.uid) + '" data-name="' + esc(p.name) + '">💬 Request a quote</button>'
        + '<button type="button" class="mh-btn ghost" data-book="' + esc(p.uid) + '" data-name="' + esc(p.name) + '">📅 Book a session</button>'
        + '</div>'
        + '<div class="mh-fine">Payments are made through SOKONI and held until you confirm the work is done.</div>';
    } catch (e) {
      m.querySelector('.mh-modal').innerHTML = '<button type="button" class="mh-x" data-close aria-label="Close">×</button><div class="mh-empty err">' + esc(errText(e)) + '</div>';
    }
  }

  /* ── my status ── */
  async function loadMine() {
    var el = $('mhMine'); if (!el) return;
    if (!signedIn()) { S.me = null; el.innerHTML = ''; renderWizard(); return; }
    try { S.me = await call('marketingMyStatus'); } catch (e) { S.me = { error: errText(e) }; }
    renderMine(); renderWizard();
  }
  function renderMine() {
    var el = $('mhMine'); if (!el) return;
    var me = S.me;
    if (!me || me.error || !me.application) { el.innerHTML = me && me.error ? '<div class="mh-note err">' + esc(me.error) + '</div>' : ''; return; }
    var a = me.application, st = a.reviewStage === 'revoked' ? 'revoked' : (me.marketer && me.marketer.status === 'suspended') ? 'suspended' : a.status;
    var t = STATUS_TEXT[st] || ['⏳ ' + st, ''];
    var lab = function (ids) { return (ids || []).map(function (c) { return '<span class="mh-tag">' + esc(T().label(c)) + '</span>'; }).join(''); };
    var html = '<div class="mh-status"><div class="mh-status-head">' + esc(t[0]) + ' · ' + esc(TYPE_LABEL[a.marketingType] || '') + '</div><p>' + esc(t[1]) + '</p>';
    if (st === 'pending' && STAGE_TEXT[a.reviewStage]) html += '<div class="mh-note"><b>Stage:</b> ' + esc(STAGE_TEXT[a.reviewStage]) + '</div>';
    if (a.reviewReason) html += '<div class="mh-note"><b>Reviewer:</b> ' + esc(a.reviewReason) + '</div>';
    if (st === 'approved') {
      html += '<div class="mh-sec-label">Approved services</div><div class="mh-tags">' + lab(a.approvedCategories) + '</div>';
      if ((a.declinedCategories || []).length) html += '<div class="mh-sec-label">Not approved</div><div class="mh-tags dim">' + lab(a.declinedCategories) + '</div>';
      html += '<div class="mh-prof-actions"><a class="mh-btn" href="provider-dashboard.html">Open my dashboard</a></div>';
    } else {
      html += '<div class="mh-sec-label">Requested services</div><div class="mh-tags">' + lab(a.requestedCategories) + '</div>';
      if (st === 'pending' || st === 'info_requested') html += '<div class="mh-prof-actions"><button type="button" class="mh-btn ghost" data-withdraw>Withdraw application</button></div>';
    }
    el.innerHTML = html + '</div>';
  }

  /* ── become a marketer: the wizard ── */
  var canApply = function () { var a = S.me && S.me.application; return !a || ['info_requested', 'rejected', 'withdrawn'].indexOf(a.status) >= 0; };
  function renderWizard() {
    var el = $('mhWizard'); if (!el) return;
    if (!signedIn()) { el.innerHTML = '<div class="mh-note">Sign in to apply. <a class="mh-link" href="login.html?next=' + encodeURIComponent('marketing-hub.html#become') + '">Sign in</a></div>'; return; }
    if (!canApply()) { el.innerHTML = ''; return; }
    var w = S.wiz, a = (S.me && S.me.application) || {};
    if (!w.type && a.marketingType) { w.type = a.marketingType; w.cats = (a.requestedCategories || []).slice(); }
    var types = T().TYPES;
    var steps = ['Type', 'Services', 'Details', 'Review'];
    var head = '<ol class="mh-steps">' + steps.map(function (s, i) { return '<li class="' + (i === w.step ? 'on' : i < w.step ? 'done' : '') + '">' + esc(s) + '</li>'; }).join('') + '</ol>';
    var body = '';
    if (w.step === 0) {
      body = '<p class="mh-fine">Choose how you work. Each type is reviewed separately — this is not the general business application.</p><div class="mh-types">'
        + Object.keys(types).map(function (k) {
          var d = { individual: 'A freelancer or independent marketer.', agency: 'A registered company with staff and clients.', specialist: 'An expert in ONE marketing service.' }[k];
          return '<button type="button" class="mh-type' + (w.type === k ? ' on' : '') + '" data-type="' + esc(k) + '"><b>' + esc(types[k].label) + '</b><span>' + esc(d) + '</span><span class="mh-fine">Up to ' + types[k].maxCategories + ' service' + (types[k].maxCategories === 1 ? '' : 's') + '</span></button>';
        }).join('') + '</div>';
    } else if (w.step === 1) {
      var max = (types[w.type] || {}).maxCategories || 1;
      body = '<p class="mh-fine">Choose the services you want to offer (' + w.cats.length + ' / ' + max + '). SOKONI approves each one separately.</p>'
        + T().GROUPS.map(function (g) {
          return '<div class="mh-sec-label">' + esc(g.icon + ' ' + g.label) + '</div><div class="mh-tags">' + g.services.map(function (s) {
            var on = w.cats.indexOf(s.id) >= 0;
            return '<button type="button" class="mh-chip sm' + (on ? ' on' : '') + '" data-pick="' + esc(s.id) + '" aria-pressed="' + on + '">' + esc(s.label) + '</button>';
          }).join('') + '</div>';
        }).join('');
    } else if (w.step === 2) {
      var v = function (k, d) { return esc(w[k] != null ? w[k] : (a[k] != null ? a[k] : (d || ''))); };
      body = '<label class="mh-f">' + (w.type === 'agency' ? 'Agency (business) name' : 'Your name or brand') + '<input id="mwName" maxlength="120" value="' + v('name') + '" required></label>'
        + '<label class="mh-f">Describe your work (what you do, for whom, results)<textarea id="mwDesc" rows="4" maxlength="2000" required>' + v('description') + '</textarea></label>'
        + '<div class="mh-f2"><label class="mh-f">County<input id="mwCounty" maxlength="80" value="' + v('county') + '" required></label>'
        + '<label class="mh-f">M-PESA / mobile number<input id="mwPhone" inputmode="tel" maxlength="16" placeholder="07XX XXX XXX" value="' + v('phone') + '" required></label></div>'
        + '<label class="mh-f">Years of experience<input id="mwYears" type="number" min="0" max="60" value="' + v('yearsExperience') + '"></label>'
        + '<label class="mh-f">Portfolio links (https, one per line, up to 8)<textarea id="mwPort" rows="3" maxlength="3000" placeholder="https://…">' + esc((w.portfolio || a.portfolio || []).join('\n')) + '</textarea></label>'
        + (w.type === 'agency' ? '<div class="mh-f2"><label class="mh-f">Business registration number<input id="mwReg" maxlength="60" value="' + esc(w.registrationNumber || (a.agency && a.agency.registrationNumber) || '') + '" required></label>'
          + '<label class="mh-f">Team size<input id="mwTeam" type="number" min="2" max="5000" value="' + esc(w.teamSize || (a.agency && a.agency.teamSize) || '') + '" required></label></div>'
          + '<label class="mh-f">KRA PIN (optional)<input id="mwKra" maxlength="20" value="' + esc(w.kraPin || (a.agency && a.agency.kraPin) || '') + '"></label>' : '');
    } else {
      body = '<div class="mh-review"><div><b>Type:</b> ' + esc((types[w.type] || {}).label || '') + '</div><div><b>Name:</b> ' + esc(w.name) + '</div><div><b>County:</b> ' + esc(w.county) + '</div>'
        + '<div class="mh-sec-label">Services requested</div><div class="mh-tags">' + w.cats.map(function (c) { return '<span class="mh-tag">' + esc(T().label(c)) + '</span>'; }).join('') + '</div>'
        + '<p class="mh-fine">SOKONI reviews your application and approves each service separately. You are listed only for approved services.</p></div>';
    }
    var nextLabel = w.step === 3 ? (a.status ? 'Resubmit application' : 'Submit application') : 'Continue';
    el.innerHTML = head + '<div class="mh-wiz-body">' + body + '</div><div id="mwErr" class="mh-err" role="alert"></div>'
      + '<div class="mh-prof-actions">' + (w.step > 0 ? '<button type="button" class="mh-btn ghost" data-wback>Back</button>' : '') + '<button type="button" class="mh-btn" id="mwNext" data-wnext>' + esc(nextLabel) + '</button></div>';
  }
  function readDetails() {
    var w = S.wiz, g = function (id) { var e = $(id); return e ? e.value.trim() : ''; };
    w.name = g('mwName'); w.description = g('mwDesc'); w.county = g('mwCounty'); w.phone = g('mwPhone'); w.yearsExperience = g('mwYears');
    w.portfolio = g('mwPort').split(/\s+/).filter(Boolean).slice(0, 8);
    if (w.type === 'agency') { w.registrationNumber = g('mwReg'); w.teamSize = g('mwTeam'); w.kraPin = g('mwKra'); }
  }
  function wizErr(t) { var e = $('mwErr'); if (e) e.textContent = t || ''; }
  async function wizNext() {
    var w = S.wiz, types = T().TYPES;
    wizErr('');
    if (w.step === 0) { if (!types[w.type]) return wizErr('Choose how you work.'); w.cats = w.cats.slice(0, types[w.type].maxCategories); w.step = 1; return renderWizard(); }
    if (w.step === 1) { if (!w.cats.length) return wizErr('Choose at least one service.'); w.step = 2; return renderWizard(); }
    if (w.step === 2) {
      readDetails();
      if (w.name.length < 2) return wizErr('Enter your name or brand.');
      if (w.description.length < 30) return wizErr('Describe your work in at least 30 characters.');
      if (!w.county) return wizErr('Enter your county.');
      if (!/^(?:\+?254|0)[17]\d{8}$/.test(w.phone.replace(/\s/g, ''))) return wizErr('Enter a valid Kenyan mobile number.');
      if (w.type === 'agency' && (!w.registrationNumber || !(Number(w.teamSize) >= 2))) return wizErr('An agency needs its registration number and a team size of 2 or more.');
      w.step = 3; return renderWizard();
    }
    var b = $('mwNext'); if (b) { b.disabled = true; b.textContent = 'Submitting…'; }
    try {
      await call('marketingApply', { marketingType: w.type, categories: w.cats, name: w.name, description: w.description, county: w.county, phone: w.phone.replace(/\s/g, ''),
        yearsExperience: w.yearsExperience === '' ? undefined : Number(w.yearsExperience), portfolio: w.portfolio,
        registrationNumber: w.registrationNumber, teamSize: w.teamSize === undefined ? undefined : Number(w.teamSize), kraPin: w.kraPin });
      S.wiz = { step: 0, type: '', cats: [] };
      await loadMine();
      var m = $('mhMine'); if (m && m.scrollIntoView) m.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      if (b) { b.disabled = false; b.textContent = 'Submit application'; }
      wizErr(errText(e));
    }
  }

  /* ── events (one delegated listener; no inline handlers) ── */
  function onClick(e) {
    var t = e.target.closest ? e.target.closest('button,a') : null; if (!t) return;
    var d = t.dataset || {};
    if ('group' in d && t.closest('#mhGroups')) { S.group = d.group; S.category = ''; renderGroups(); return loadDirectory(); }
    if (d.cat) { S.category = S.category === d.cat ? '' : d.cat; renderGroups(); return loadDirectory(); }
    if (d.uid && t.classList.contains('mh-card')) return openProfile(d.uid);
    if ('retry' in d) return loadDirectory();
    if (d.quote) { closeModal(); if (G.SokoniLeads) G.SokoniLeads.ask({ providerId: d.quote, providerName: d.name, placeholder: 'e.g. We need a 3-month Instagram campaign for our bakery in Nairobi — what would you propose?' }); return; }
    if (d.book) { closeModal(); if (!signedIn()) { G.location.href = 'login.html?next=' + encodeURIComponent('marketing-hub.html'); return; } if (G.SokoniBookService) G.SokoniBookService.open({ providerId: d.book, providerName: d.name }); return; }
    if ('scrollBecome' in d) { e.preventDefault(); var bc = $('become'); if (bc && bc.scrollIntoView) bc.scrollIntoView({ behavior: 'smooth' }); return; }
    if ('withdraw' in d) {
      t.disabled = true;
      return call('marketingWithdraw').then(loadMine).catch(function (er) { t.disabled = false; var el = $('mhMine'); if (el) el.insertAdjacentHTML('beforeend', '<div class="mh-note err">' + esc(errText(er)) + '</div>'); });
    }
    if (d.type && t.closest('#mhWizard')) { S.wiz.type = d.type; return renderWizard(); }
    if (d.pick) {
      var w = S.wiz, i = w.cats.indexOf(d.pick), max = (T().TYPES[w.type] || {}).maxCategories || 1;
      if (i >= 0) w.cats.splice(i, 1); else if (max === 1) w.cats = [d.pick]; else if (w.cats.length < max) w.cats.push(d.pick); else return wizErr('You can choose up to ' + max + ' services.');
      return renderWizard();
    }
    if ('wback' in d) { if (S.wiz.step === 2) readDetails(); S.wiz.step = Math.max(0, S.wiz.step - 1); return renderWizard(); }
    if ('wnext' in d) return wizNext();
  }

  async function init() {
    if (!(await ready())) { var el = $('mhList'); if (el) el.innerHTML = '<div class="mh-empty err">SOKONI could not start. Refresh the page.</div>'; return; }
    G.document.addEventListener('click', onClick);
    var q = $('mhSearch'), qt = null;
    if (q) q.addEventListener('input', function () { clearTimeout(qt); qt = setTimeout(function () { S.q = q.value.trim(); loadDirectory(); }, 300); });
    var ty = $('mhType'); if (ty) ty.addEventListener('change', function () { S.type = ty.value; loadDirectory(); });
    var usp = new URLSearchParams(G.location.search || '');
    if (T().AREA[usp.get('category')]) { S.category = usp.get('category'); S.group = T().groupOf(S.category); }
    else if (T().GROUPS.some(function (g) { return g.id === usp.get('group'); })) S.group = usp.get('group');
    renderGroups();
    loadDirectory();
    await authReady();
    loadMine();
  }
  G.SokoniMarketingHub = { init: init, _internal: { S: S, card: card, renderWizard: renderWizard, wizNext: wizNext, canApply: canApply, renderMine: renderMine, onClick: onClick } };
  if (G.document && G.document.readyState !== 'loading') init(); else if (G.document) G.document.addEventListener('DOMContentLoaded', init);
})(typeof window !== 'undefined' ? window : this);
