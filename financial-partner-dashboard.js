/* ============================================================================
   SOKONI — Financial Partner Workspace (client) — 2026-10-01
   Talks ONLY to the financialPartnerDispatch callable; the server decides who is a partner, which
   category tools appear, and every count. Nothing here is cached in localStorage and no figure is
   computed on the client: an unknown count renders '—', never 0.
   ============================================================================ */
(function () {
  'use strict';
  var ICONS = { overview: '🏠', registration: '🪪', members: '👥', products: '🧾', enquiries: '✉️', promote: '📣', plan: '💳', team: '🧑‍💼', profile: '⚙️' };
  var S = { ws: null, view: 'overview', members: [], memberNext: null, memberFilter: {}, com: null, paying: false, pollTimer: null };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var shown = function (n) { return (typeof n === 'number' && isFinite(n)) ? n.toLocaleString('en-KE') : '—'; };
  var when = function (ms) { return ms ? new Date(ms).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' }) : '—'; };
  var label = function (k) { return String(k || '').replace(/_/g, ' ').replace(/^./, function (c) { return c.toUpperCase(); }); };

  function toast(msg, isErr) {
    var t = $('toast'); t.textContent = msg; t.className = 'toast' + (isErr ? ' err' : ''); t.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(function () { t.hidden = true; }, 4200);
  }
  function call(data) {
    return window.waitForFirebaseReady().then(function () {
      return window.sokoniCallable('financialPartnerDispatch')(data);
    }).then(function (r) { return r.data; });
  }
  function errMsg(e) { return (e && e.message ? String(e.message).replace(/^.*?:\s*/, '') : '') || 'Something went wrong. Please try again.'; }
  function busy(btn, on) { if (btn) { btn.disabled = on; if (on) btn.setAttribute('aria-busy', 'true'); else btn.removeAttribute('aria-busy'); } }
  function formData(form) { var o = {}; new FormData(form).forEach(function (v, k) { o[k] = typeof v === 'string' ? v.trim() : v; }); return o; }
  var isOwner = function () { return S.ws && S.ws.role === 'owner'; };
  var canManage = function () { return S.ws && (S.ws.role === 'owner' || S.ws.role === 'manager'); };

  /* ── Boot ───────────────────────────────────────────────────────────────────────────── */
  function boot() {
    call({ op: 'getWorkspace' }).then(function (ws) {
      S.ws = ws;
      $('sbName').textContent = ws.listing.name || 'Your institution';
      $('sbCat').textContent = ws.config.label + ' · ' + label(ws.role);
      renderNav();
      $('boot').hidden = true; $('view').hidden = false;
      var want = (location.hash || '').slice(1);
      show(ws.config.modules.indexOf(want) >= 0 || (want === 'plan' && canManage()) ? want : 'overview');
    }).catch(function (e) {
      var d = (e && e.details) || {};
      var b = $('boot');
      if (d.code === 'NOT_A_PARTNER' || d.code === 'PARTNER_NOT_APPROVED') {
        var pending = d.listingStatus === 'pending' || d.listingStatus === 'under_review' || d.listingStatus === 'changes_requested';
        b.innerHTML = '<h1>' + (pending ? 'Your application is being reviewed' : 'Partner workspace') + '</h1>' +
          '<p class="muted" style="margin-top:8px">' + esc(pending
            ? 'SOKONI is reviewing your listing. This workspace opens as soon as it is approved.'
            : (d.code === 'NOT_A_PARTNER' ? 'This workspace is for banks, SACCOs, chamas, microfinance institutions, insurers, forex bureaus and accountants listed on SOKONI.' : 'Your listing is not active right now. Contact SOKONI support for details.')) + '</p>' +
          '<div class="actions" style="justify-content:center"><a class="btn primary" href="business-apply.html?offer=financial">' + (pending ? 'View application' : 'Apply to be listed') + '</a><a class="btn" href="banking.html">Back to Banking Hub</a></div>';
      } else {
        b.innerHTML = '<h1>We could not open your workspace</h1><p class="muted" style="margin-top:8px">' + esc(errMsg(e)) + '</p><div class="actions" style="justify-content:center"><button class="btn primary" type="button" data-act="retry">Try again</button></div>';
      }
    });
  }
  function renderNav() {
    var c = S.ws.config;
    var names = { overview: 'Overview', registration: 'Registration', members: c.memberLabel, products: c.productLabel, enquiries: 'Enquiries', promote: 'Promote', plan: 'Plan & billing', team: 'Team', profile: 'Public profile' };
    /* only known module keys ever reach markup or show(). 'plan' is workspace-level (not category-specific), so
       it is appended here rather than coming from config.modules; the server still authorises every call. */
    var visible = c.modules.filter(function (m) { return Object.prototype.hasOwnProperty.call(ICONS, m); }).concat(['plan']).filter(function (m) {
      if (m === 'plan') return canManage();
      if (m === 'registration' || m === 'team') return isOwner() || (m === 'team' && canManage());
      if (m === 'products' || m === 'profile' || m === 'promote') return canManage();
      return true;
    });
    $('sbNav').innerHTML = visible.map(function (m) {
      var badge = (m === 'enquiries' && S.ws.counts.newEnquiries) ? '<span class="sb-badge" aria-label="new">' + esc(S.ws.counts.newEnquiries) + '</span>' : '';
      return '<button type="button" class="sb-item" data-nav="' + m + '"><span aria-hidden="true">' + ICONS[m] + '</span>' + esc(names[m]) + badge + '</button>';
    }).join('');
  }
  function show(view) {
    S.view = view;
    clearTimeout(S.pollTimer); S.paying = false;   /* a confirmation poll belongs to the view that started it */
    if (history.replaceState) history.replaceState(null, '', '#' + view);
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (b) {
      if (b.getAttribute('data-nav') === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var v = $('view'); v.innerHTML = '<div class="state muted">Loading…</div>';
    ({ overview: vOverview, registration: vRegistration, members: vMembers, products: vProducts, enquiries: vEnquiries, promote: vPromote, plan: vPlan, team: vTeam, profile: vProfile }[view] || vOverview)(v);
    $('main').focus({ preventScroll: true });
  }

  /* ── Views ──────────────────────────────────────────────────────────────────────────── */
  /* 'verified' is the legacy server name for 'approved'. The badge itself is shown ONLY from the server's
     markers.registrationReviewed (never inferred from a status string or from a paid plan). */
  var regApproved = function (r) { return !!r && (r.status === 'approved' || r.status === 'verified'); };
  var markers = function () { return (S.ws && S.ws.markers) || {}; };
  function regPill(r) {
    var st = (r && r.status) || 'not_submitted';
    var map = { approved: ['ok', 'Reviewed'], verified: ['ok', 'Reviewed'], under_review: ['warn', 'Under review'], needs_information: ['warn', 'Needs information'], rejected: ['err', 'Not accepted'], not_submitted: ['warn', 'Not submitted'] };
    var m = map[st] || ['warn', label(st)];
    return '<span class="pill ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  /* "Registration reviewed by SOKONI" + the server's tooltip, exposed to assistive tech as well as on hover. */
  function reviewBadge(mk) {
    if (!mk || mk.registrationReviewed !== true) return '';
    var rb = mk.reviewBadge || {};
    var tip = rb.tooltip || '';
    return '<span class="pill ok"' + (tip ? ' title="' + esc(tip) + '" aria-describedby="rbTip"' : '') + '>Registration reviewed by SOKONI</span>' +
      (tip ? '<span class="vh" id="rbTip">' + esc(tip) + '</span>' : '');
  }
  /* A licence is a separate fact from the registration review: only an admin's check against the issuing
     authority's register produces a line, and a past expiry says so. Returns plain text (escape at use). */
  function licenceLine(l) {
    if (!l || !l.issuingAuthority) return '';
    if (l.status === 'expired') return 'Licence expired (' + (l.expiryDate || '—') + ')';
    if (l.status === 'verified_against_register') return 'Licence checked against the ' + l.issuingAuthority + ' register on ' + when(l.checkedAt);
    return '';
  }
  function vOverview(v) {
    var w = S.ws, c = w.config, n = w.counts;
    var cards = [];
    if (c.modules.indexOf('members') >= 0) { cards.push(['Total ' + c.memberLabel.toLowerCase(), n.members]); cards.push(['Active ' + c.memberLabel.toLowerCase(), n.activeMembers]); }
    cards.push(['Published ' + c.productLabel.toLowerCase(), n.publishedProducts]);
    cards.push(['New enquiries', n.newEnquiries]);
    /* analytics exists only when the plan grants it (server decides); absent → no card at all, never 0 */
    if (w.analytics && typeof w.analytics === 'object') cards.push(['Enquiries, last 30 days', w.analytics.enquiries30d]);
    var reg = w.registration || {};
    v.innerHTML = '<h1>Welcome, ' + esc(w.listing.name || 'partner') + '</h1>' +
      '<p class="muted">' + esc(c.label) + ' workspace · listing <span class="pill ok">Approved</span> · registration ' + regPill(reg) + ' ' + reviewBadge(markers()) + '</p>' +
      '<div class="cards">' + cards.map(function (x) { return '<div class="card"><div class="k">' + esc(x[0]) + '</div><div class="v">' + shown(x[1]) + '</div></div>'; }).join('') + '</div>' +
      (!regApproved(reg) && isOwner() ? '<div class="notice">Your registration details are <strong>' + esc(label(reg.status || 'not_submitted')) + '</strong>. Until SOKONI reviews them, your public listing shows them as self-declared. <button class="btn" type="button" data-nav="registration" style="margin-left:8px">Open registration</button></div>' : '') +
      '<h2>Quick actions</h2><div class="actions">' +
      (c.modules.indexOf('members') >= 0 ? '<button class="btn primary" type="button" data-nav="members">Add ' + esc(c.memberLabel.toLowerCase().replace(/s$/, '')) + '</button>' : '') +
      (canManage() ? '<button class="btn" type="button" data-nav="products">Manage ' + esc(c.productLabel.toLowerCase()) + '</button>' : '') +
      '<button class="btn" type="button" data-nav="enquiries">Enquiries</button>' +
      (canManage() ? '<button class="btn" type="button" data-nav="profile">Edit public profile</button>' : '') + '</div>';
  }

  function vRegistration(v) {
    var r = S.ws.registration || {}, c = S.ws.config, mk = markers(), lc = r.licenceClaim || {};
    var approved = regApproved(r);
    var resubmit = r.status === 'needs_information' || r.status === 'rejected';
    var locked = r.status === 'under_review' || approved;
    var lic = licenceLine(mk.licenceVerification);
    v.innerHTML = '<h1>Registration</h1><p class="muted">Your registration with the regulator. SOKONI reviews the information you submit — a SOKONI review is not a government licence, a professional certification or a regulator\'s approval.</p>' +
      '<div class="panel"><p>Status: ' + regPill(r) + ' ' + reviewBadge(mk) + '</p>' +
      (r.regulator ? '<p class="muted" style="margin-top:6px">' + esc(r.regulator) + (r.registrationNumber ? ' · ' + esc(r.registrationNumber) : '') + '</p>' : '') +
      (lic ? '<p style="margin-top:6px">' + esc(lic) + '</p>' : '') +
      (resubmit && r.reviewNote ? '<div class="notice"><strong>Note from the SOKONI reviewer:</strong> ' + esc(r.reviewNote) + '</div>' : '') + '</div>' +
      (locked ? '<div class="notice">' + (approved ? 'Reviewed by SOKONI. To change these details, contact SOKONI support.' : 'Submitted — SOKONI is reviewing it. You will see the result here.') + '</div>' :
      '<form class="panel" id="regForm" novalidate>' + (resubmit ? '<h2 style="margin-top:0">' + (r.status === 'needs_information' ? 'Add the missing information and resubmit' : 'Correct and resubmit') + '</h2>' : '') + '<div class="row">' +
      '<div><label for="rg1">Regulator</label><select id="rg1" name="regulator" required>' + c.regulators.map(function (x) { return '<option' + (x === r.regulator ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="rg2">Registered name</label><input id="rg2" name="registeredName" maxlength="120" required value="' + esc(r.registeredName || '') + '"></div>' +
      '<div><label for="rg3">Registration / licence number</label><input id="rg3" name="registrationNumber" maxlength="40" value="' + esc(r.registrationNumber || '') + '"></div>' +
      '<div><label for="rg4">KRA PIN (optional)</label><input id="rg4" name="kraPin" maxlength="11" autocomplete="off" value="' + esc(r.kraPin || '') + '"></div>' +
      '<div><label for="rg5">Valid until (optional)</label><input id="rg5" name="validUntil" type="date" value="' + esc(r.validUntil || '') + '"></div>' +
      '</div><fieldset style="border:0;margin-top:16px"><legend style="font-weight:700">Licence (optional)</legend>' +
      '<p class="muted" style="font-size:12px;margin:4px 0 8px">Self-declared until SOKONI checks the issuing authority\'s register.</p><div class="row">' +
      '<div><label for="rg6">Licence type</label><input id="rg6" name="licenceType" maxlength="60" value="' + esc(lc.licenceType || '') + '"></div>' +
      '<div><label for="rg7">Licence number</label><input id="rg7" name="licenceNumber" maxlength="40" value="' + esc(lc.licenceNumber || '') + '"></div>' +
      '<div><label for="rg8">Issuing authority</label><input id="rg8" name="issuingAuthority" maxlength="80" value="' + esc(lc.issuingAuthority || '') + '"></div>' +
      '<div><label for="rg9">Licence expiry</label><input id="rg9" name="licenceExpiry" type="date" value="' + esc(lc.expiryDate || '') + '"></div>' +
      '</div></fieldset><div class="actions"><button class="btn primary" type="submit">' + (resubmit ? 'Resubmit for review' : 'Submit for review') + '</button></div></form>');
  }

  function vMembers(v) {
    var c = S.ws.config;
    v.innerHTML = '<h1>' + esc(c.memberLabel) + '</h1><p class="muted">Your register on SOKONI. Only your team can see it.</p>' +
      '<div class="panel"><div class="toolbar">' +
      '<div><label for="mq">Find by phone or number</label><input id="mq" placeholder="07… or member number"></div>' +
      '<div><label for="mf">Status</label><select id="mf"><option value="">All</option><option value="active">Active</option><option value="suspended">Suspended</option><option value="exited">Exited</option></select></div>' +
      '<div style="flex:0"><button class="btn" type="button" data-act="mSearch">Search</button></div></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Number</th><th>Joined</th><th>Status</th><th><span class="skip">Actions</span></th></tr></thead><tbody id="mRows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div>' +
      '<div class="actions"><button class="btn" type="button" id="mMore" data-act="mMore" hidden>Load more</button></div></div>' +
      '<form class="panel" id="memberForm" novalidate><h2 style="margin-top:0">Add to register</h2><div class="row">' +
      '<div><label for="m1">Full name</label><input id="m1" name="name" maxlength="100" required autocomplete="off"></div>' +
      '<div><label for="m2">Phone</label><input id="m2" name="phone" inputmode="tel" required autocomplete="off" placeholder="07XX XXX XXX"></div>' +
      '<div><label for="m3">Member / client number (optional)</label><input id="m3" name="memberNo" maxlength="40"></div>' +
      '<div><label for="m4">Joined on (optional)</label><input id="m4" name="joinedOn" type="date"></div></div>' +
      '<div style="margin-top:12px"><label for="m5">Note (optional)</label><input id="m5" name="note" maxlength="200"></div>' +
      '<label class="check"><input type="checkbox" name="consent" required> <span>This person agreed to be recorded on SOKONI by us.</span></label>' +
      '<div class="actions"><button class="btn primary" type="submit">Add</button></div></form>' +
      '<form class="panel" id="importForm" novalidate><h2 style="margin-top:0">Import many</h2><p class="muted">One per line: <code>name, phone, number, joined (YYYY-MM-DD)</code>. Up to 200 lines at a time. Or choose a .csv file.</p>' +
      '<div style="margin-top:8px"><label for="i0">CSV file</label><input id="i0" type="file" accept=".csv,text/csv"></div>' +
      '<div style="margin-top:8px"><label for="i1">Rows</label><textarea id="i1" name="rows" placeholder="Jane Wanjiru, 0712345678, S-001, 2025-01-15"></textarea></div>' +
      '<label class="check"><input type="checkbox" name="consent" required> <span>Every person listed agreed to be recorded on SOKONI by us.</span></label>' +
      '<div class="actions"><button class="btn primary" type="submit">Import</button></div><div id="importResult"></div></form>';
    S.memberFilter = {}; loadMembers(true);
  }
  function loadMembers(reset) {
    var req = { op: 'listMembers' };
    var f = S.memberFilter;
    if (f.phone) req.phone = f.phone; else if (f.memberNo) req.memberNo = f.memberNo; else if (f.status) req.status = f.status;
    if (!reset && S.memberNext) req.cursor = S.memberNext;
    call(req).then(function (r) {
      S.members = reset ? r.rows : S.members.concat(r.rows); S.memberNext = r.next;
      var tb = $('mRows'); if (!tb) return;
      tb.innerHTML = S.members.length ? S.members.map(memberTr).join('') : '<tr><td colspan="6" class="muted">No one here yet.</td></tr>';
      $('mMore').hidden = !S.memberNext;
    }).catch(function (e) { var tb = $('mRows'); if (tb) tb.innerHTML = '<tr><td colspan="6" class="muted">Could not load the register: ' + esc(errMsg(e)) + '</td></tr>'; });
  }
  function memberTr(m) {
    var st = { active: 'ok', suspended: 'warn', exited: 'err' }[m.status] || 'warn';
    var acts = (m.status !== 'active' ? '<button class="btn" type="button" data-act="mStatus" data-id="' + esc(m.id) + '" data-status="active">Activate</button>' : '<button class="btn" type="button" data-act="mStatus" data-id="' + esc(m.id) + '" data-status="suspended">Suspend</button>') +
      (m.status !== 'exited' ? '<button class="btn" type="button" data-act="mStatus" data-id="' + esc(m.id) + '" data-status="exited">Mark exited</button>' : '') +
      (canManage() ? '<button class="btn danger" type="button" data-act="mDelete" data-id="' + esc(m.id) + '">Delete</button>' : '');
    return '<tr><td>' + esc(m.name) + (m.note ? '<div class="muted" style="font-size:12px">' + esc(m.note) + '</div>' : '') + '</td><td>' + esc('+' + m.phone) + '</td><td>' + esc(m.memberNo || '—') + '</td><td>' + esc(m.joinedOn || '—') + '</td><td><span class="pill ' + st + '">' + esc(label(m.status)) + '</span></td><td><div class="actions" style="margin:0">' + acts + '</div></td></tr>';
  }
  function parseRows(text) {
    return String(text || '').split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean)
      .filter(function (l, i) { return !(i === 0 && /^name\s*,/i.test(l)); })
      .map(function (l) { var p = l.split(',').map(function (x) { return x.trim().replace(/^"|"$/g, ''); }); return { name: p[0] || '', phone: p[1] || '', memberNo: p[2] || '', joinedOn: p[3] || '' }; });
  }

  function vProducts(v) {
    var c = S.ws.config, isRate = c.productKinds.length === 1 && c.productKinds[0] === 'rate';
    v.innerHTML = '<h1>' + esc(c.productLabel) + '</h1><p class="muted">Published items appear on your public listing in the Banking Hub. Rates and prices you enter are shown as provided by you.</p>' +
      '<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>' + (isRate ? 'Buy / Sell' : 'Rate / price') + '</th><th>Status</th><th>Updated</th><th><span class="skip">Actions</span></th></tr></thead><tbody id="pRows"><tr><td colspan="6" class="muted">Loading…</td></tr></tbody></table></div></div>' +
      '<form class="panel" id="productForm" novalidate><h2 style="margin-top:0" id="pTitle">Add</h2><input type="hidden" name="id"><div class="row">' +
      '<div><label for="p1">' + (isRate ? 'Currency name' : 'Name') + '</label><input id="p1" name="name" maxlength="80" required></div>' +
      '<div><label for="p2">Type</label><select id="p2" name="kind">' + c.productKinds.map(function (k) { return '<option value="' + esc(k) + '">' + esc(label(k)) + '</option>'; }).join('') + '</select></div>' +
      (isRate ? '<div><label for="p3">Currency code</label><input id="p3" name="currency" maxlength="3" placeholder="USD" required></div><div><label for="p4">We buy at (KES)</label><input id="p4" name="buy" type="number" step="0.0001" min="0" required></div><div><label for="p5">We sell at (KES)</label><input id="p5" name="sell" type="number" step="0.0001" min="0" required></div>'
        : '<div><label for="p6">Rate / price (as you advertise it)</label><input id="p6" name="rateText" maxlength="60" placeholder="e.g. 12% p.a."></div><div><label for="p7">Minimum amount, KES (optional)</label><input id="p7" name="minAmount" type="number" min="0"></div>') +
      '<div><label for="p8">Status</label><select id="p8" name="status"><option value="draft">Draft</option><option value="published">Published</option><option value="archived">Archived</option></select></div></div>' +
      (isRate ? '' : '<div style="margin-top:12px"><label for="p9">Description</label><textarea id="p9" name="description" maxlength="600"></textarea></div>') +
      '<div class="actions"><button class="btn primary" type="submit">Save</button><button class="btn" type="reset" data-act="pReset">Clear</button></div></form>';
    loadProducts();
  }
  function loadProducts() {
    call({ op: 'listProducts' }).then(function (r) {
      S.products = r.rows;
      var tb = $('pRows'); if (!tb) return;
      tb.innerHTML = r.rows.length ? r.rows.map(function (p) {
        var price = p.kind === 'rate' ? (shown(p.buy) + ' / ' + shown(p.sell)) : esc(p.rateText || '—');
        var st = { published: 'ok', draft: 'warn', archived: 'err' }[p.status] || 'warn';
        return '<tr><td>' + esc(p.name) + '</td><td>' + esc(label(p.kind)) + '</td><td>' + price + '</td><td><span class="pill ' + st + '">' + esc(label(p.status)) + '</span></td><td>' + esc(when(p.updatedAt)) + '</td><td><button class="btn" type="button" data-act="pEdit" data-id="' + esc(p.id) + '">Edit</button></td></tr>';
      }).join('') : '<tr><td colspan="6" class="muted">Nothing listed yet.</td></tr>';
    }).catch(function (e) { var tb = $('pRows'); if (tb) tb.innerHTML = '<tr><td colspan="6" class="muted">Could not load: ' + esc(errMsg(e)) + '</td></tr>'; });
  }

  function vEnquiries(v) {
    v.innerHTML = '<h1>Enquiries</h1><p class="muted">People who contacted you from the Banking Hub. They agreed to share these contact details with you.</p>' +
      '<div class="panel"><div class="toolbar"><div><label for="ef">Status</label><select id="ef" data-act="eFilter"><option value="">All</option><option value="new">New</option><option value="contacted">Contacted</option><option value="closed">Closed</option></select></div></div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>From</th><th>Topic</th><th>Message</th><th>Received</th><th>Status</th></tr></thead><tbody id="eRows"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody></table></div></div>';
    loadEnquiries('');
  }
  function loadEnquiries(status) {
    var req = { op: 'listEnquiries' }; if (status) req.status = status;
    call(req).then(function (r) {
      var tb = $('eRows'); if (!tb) return;
      tb.innerHTML = r.rows.length ? r.rows.map(function (e) {
        return '<tr><td>' + esc(e.name) + '<div class="muted" style="font-size:12px"><a href="tel:+' + esc(e.phone) + '">+' + esc(e.phone) + '</a></div></td><td>' + esc(e.topic) + '</td><td style="max-width:320px;white-space:pre-wrap">' + esc(e.message) + '</td><td>' + esc(when(e.createdAt)) + '</td><td><select aria-label="Status" data-act="eStatus" data-id="' + esc(e.id) + '">' +
          ['new', 'contacted', 'closed'].map(function (s) { return '<option value="' + s + '"' + (s === e.status ? ' selected' : '') + '>' + label(s) + '</option>'; }).join('') + '</select></td></tr>';
      }).join('') : '<tr><td colspan="5" class="muted">No enquiries yet.</td></tr>';
    }).catch(function (e) { var tb = $('eRows'); if (tb) tb.innerHTML = '<tr><td colspan="5" class="muted">Could not load: ' + esc(errMsg(e)) + '</td></tr>'; });
  }

  var PLACEMENTS = { banking_hub_category: 'Top of your Banking Hub category', banking_hub_search: 'Banking Hub search results', foundation_partners: 'SOKONI Foundation partners section' };
  var PAID_PLACEMENTS = { banking_hub_category: 'Top of your Banking Hub category', banking_hub_featured: 'Featured in your Banking Hub category', homepage_spotlight: 'SOKONI homepage spotlight' };
  var REVIEW_REASONS = { amount_mismatch: 'The amount paid did not match the price', listing_not_approved: 'Your listing was not approved when the payment arrived', unknown_product: 'The product could not be matched' };
  function vPromote(v) {
    v.innerHTML = '<h1>Promote</h1><p class="muted">Promotion ranks your listing and is marked Promoted; it never verifies or endorses you.</p>' +
      '<div class="panel"><h2 style="margin-top:0">Paid promotion</h2>' +
      (isOwner() ? phoneField() : '<p class="muted">Only the account owner can pay for promotion.</p>') +
      '<div id="promoProducts" class="cards"><div class="muted">Loading…</div></div>' +
      '<div id="payStatus" class="pay-status" role="status" aria-live="polite"></div></div>' +
      '<div class="panel"><h2 style="margin-top:0">Paid campaigns</h2><div id="campList" class="muted">Loading…</div></div>' +
      '<form class="panel" id="promoForm" novalidate><h2 style="margin-top:0">Request a free promotion</h2><p class="muted">SOKONI reviews each free request. Nothing is charged.</p><div class="row">' +
      '<div><label for="pr1">Where</label><select id="pr1" name="placement">' + Object.keys(PLACEMENTS).map(function (k) { return '<option value="' + esc(k) + '">' + esc(PLACEMENTS[k]) + '</option>'; }).join('') + '</select></div></div>' +
      '<div style="margin-top:12px"><label for="pr2">What would you like to highlight? (optional)</label><textarea id="pr2" name="message" maxlength="300"></textarea></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Send request</button></div></form>' +
      '<div class="panel"><h2 style="margin-top:0">Your free promotions</h2><div id="promoList" class="muted">Loading…</div></div>';
    loadPromotions();
    loadCommercial().then(function (com) { renderPromoProducts(com); renderCampaigns(com); }).catch(function (e) {
      var msg = commercialUnavailable(e);
      ['promoProducts', 'campList'].forEach(function (id) { var el = $(id); if (el) el.textContent = msg; });
    });
  }
  function loadPromotions() {
    call({ op: 'listMyPromotions' }).then(function (r) {
      var el = $('promoList'); if (!el) return;
      var live = r.promotions.map(function (x) {
        var on = x.status === 'active' && x.endsAt && x.endsAt > Date.now();
        return '<li>' + esc(PLACEMENTS[x.placement] || label(x.placement)) + ' — <span class="pill ' + (on ? 'ok' : 'warn') + '">' + (on ? 'Live until ' + esc(when(x.endsAt)) : 'Ended') + '</span></li>';
      });
      var reqs = r.requests.map(function (x) {
        var st = { pending: ['warn', 'Waiting for SOKONI'], granted: ['ok', 'Granted'], declined: ['err', 'Declined'] }[x.status] || ['warn', label(x.status)];
        return '<li>' + esc(PLACEMENTS[x.placement] || label(x.placement)) + ' · requested ' + esc(when(x.createdAt)) + ' <span class="pill ' + st[0] + '">' + esc(st[1]) + '</span>' + (x.note ? ' <span class="muted">— ' + esc(x.note) + '</span>' : '') + '</li>';
      });
      el.innerHTML = (live.length ? '<h3 style="font-size:14px;margin:6px 0">Live</h3><ul style="margin-left:18px">' + live.join('') + '</ul>' : '') +
        (reqs.length ? '<h3 style="font-size:14px;margin:10px 0 6px">Requests</h3><ul style="margin-left:18px">' + reqs.join('') + '</ul>' : '') ||
        'No promotions yet.';
    }).catch(function (e) { var el = $('promoList'); if (el) el.textContent = 'Could not load: ' + errMsg(e); });
  }

  /* ── Plan & billing + paid promotion (2026-10-03) ─────────────────────────────────────
     Plans, promotion products and every price come ONLY from getCommercial.catalogue (the server's one
     configuration); nothing is priced here. A purchase is createPaymentIntent (server computes the amount)
     → the existing SokoniIntaSend.initiateSTKPush on the intent's ref/amount → a bounded poll of
     getCommercial. Success is shown ONLY when getCommercial shows the plan active with a later expiry, or a
     campaign whose campaignId === the intent ref is active. A sent M-Pesa prompt is never success. */
  var PAY_UNAVAILABLE = ['not-found', 'unavailable', 'internal', 'unimplemented', 'deadline-exceeded'];
  var codeOf = function (e) { return String((e && e.code) || '').replace(/^functions\//, ''); };
  var kes = function (n) { return (typeof n === 'number' && isFinite(n)) ? 'KES ' + n.toLocaleString('en-KE') : '—'; };
  function commercialUnavailable(e) { var c = codeOf(e); return (!c || PAY_UNAVAILABLE.indexOf(c) >= 0) ? 'Paid plans and promotion are not available yet.' : errMsg(e); }
  function loadCommercial() { return call({ op: 'getCommercial' }).then(function (r) { S.com = r || {}; return S.com; }); }
  function payCall(data) {
    return window.waitForFirebaseReady().then(function () {
      return window.sokoniCallable('createPaymentIntent')(data);
    }).then(function (r) { return r.data; });
  }
  function normPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
    else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
    return /^254[17]\d{8}$/.test(d) ? d : '';
  }
  function phoneField() { return '<div style="max-width:280px"><label for="payPhone">M-Pesa number to pay from</label><input id="payPhone" inputmode="tel" autocomplete="tel" placeholder="07XX XXX XXX"></div>'; }
  function payStatus(text, kind) { var el = $('payStatus'); if (!el) return; el.className = 'pay-status' + (kind ? ' ' + kind : ''); el.textContent = text; }
  function limitHint(msg) { return /your plan allows/i.test(msg) ? msg + ' See Plan & billing.' : msg; }

  function planBlock(p) {
    if (!p || typeof p !== 'object') return '<p class="muted">Your plan details are not available yet.</p>';
    var lim = p.limits || {};
    var pill = p.active === true ? '<span class="pill ok">Active</span>' : '<span class="pill warn">No paid plan</span>';
    var dates = p.active === true ? '<p class="muted">Paid until ' + esc(when(p.expiresAt)) + '</p>' : (p.expiresAt ? '<p class="muted">Last plan ended ' + esc(when(p.expiresAt)) + '</p>' : '');
    return '<p><strong>' + esc(p.name || 'Free listing') + '</strong> ' + pill + '</p>' + dates +
      '<p class="muted">Up to ' + shown(lim.maxProducts) + ' published items · up to ' + shown(lim.maxTeam) + ' team members</p>';
  }
  function vPlan(v) {
    v.innerHTML = '<h1>Plan &amp; billing</h1><p class="muted">A plan adds capacity and placement tools. It never buys the registration review badge, listing approval or licence status — those come only from SOKONI reviews.</p>' +
      '<div class="panel"><h2 style="margin-top:0">Current plan</h2><div id="curPlan">' + planBlock(S.ws.plan) + '</div></div>' +
      '<div class="panel"><h2 style="margin-top:0">Plans</h2>' +
      (isOwner() ? phoneField() : '<p class="muted">Only the account owner can pay for a plan.</p>') +
      '<div id="planCards" class="cards"><div class="muted">Loading…</div></div>' +
      '<div id="payStatus" class="pay-status" role="status" aria-live="polite"></div></div>';
    loadCommercial().then(renderPlans).catch(function (e) { var el = $('planCards'); if (el) el.textContent = commercialUnavailable(e); });
  }
  function renderPlans(com) {
    var el = $('planCards'); if (!el) return;
    var cat = (com && com.catalogue) || {}, plans = Array.isArray(cat.plans) ? cat.plans : [];
    var cur = (com && com.plan) || S.ws.plan || {};
    var cp = $('curPlan'); if (cp && com && com.plan) cp.innerHTML = planBlock(com.plan);
    if (!plans.length) { el.textContent = 'No plans are offered right now.'; return; }
    el.innerHTML = plans.map(function (p) {
      var mine = cur.active === true && cur.planId === p.planId;
      var lim = p.limits || {};
      var price = p.selfServe === true ? kes(p.priceKES) + ' / ' + shown(p.periodDays) + ' days' : (p.priceNote || 'Custom pricing');
      var btn = p.selfServe !== true ? '<a class="btn" href="contact.html">Contact SOKONI</a>' :
        (isOwner() ? '<button class="btn primary" type="button" data-act="buyPlan" data-id="' + esc(p.planId) + '">' + (mine ? 'Renew' : 'Buy') + '</button>' : '');
      var caps = Array.isArray(p.capabilities) ? p.capabilities : [];
      return '<div class="card plan-card' + (mine ? ' current' : '') + '"><div class="k">' + esc(p.name) + (mine ? ' · your plan' : '') + '</div>' +
        '<div class="v">' + esc(price) + '</div>' +
        (p.limits ? '<div class="muted" style="font-size:12px">Up to ' + shown(lim.maxProducts) + ' items · ' + shown(lim.maxTeam) + ' team members</div>' : '') +
        (caps.length ? '<ul>' + caps.map(function (x) { return '<li>' + esc(label(x)) + '</li>'; }).join('') + '</ul>' : '') +
        '<div class="actions" style="margin-top:auto">' + btn + '</div></div>';
    }).join('');
  }
  function renderPromoProducts(com) {
    var el = $('promoProducts'); if (!el) return;
    var list = Array.isArray(com && com.catalogue && com.catalogue.promotions) ? com.catalogue.promotions : [];
    if (!list.length) { el.textContent = 'No paid promotion is offered right now.'; return; }
    el.innerHTML = list.map(function (p) {
      var price = p.perDay === true ? kes(p.priceKES) + ' per day' : kes(p.priceKES) + (p.days ? ' for ' + shown(p.days) + ' days' : '');
      var days = '';
      if (p.perDay === true) {
        var lo = Math.max(1, p.minDays || 1), hi = Math.min(30, p.maxDays || 30), opts = '';
        for (var d = lo; d <= hi; d++) opts += '<option value="' + d + '"' + (d === Math.min(7, hi) ? ' selected' : '') + '>' + d + (d === 1 ? ' day' : ' days') + '</option>';
        days = '<div style="margin-top:6px"><label>Days<select data-days-for="' + esc(p.productId) + '">' + opts + '</select></label></div>';
      }
      return '<div class="card plan-card"><div class="k">' + esc(p.name) + '</div><div class="v">' + esc(price) + '</div>' +
        '<div class="muted" style="font-size:12px">' + esc(PAID_PLACEMENTS[p.placement] || label(p.placement)) + '</div>' + days +
        (isOwner() ? '<div class="actions" style="margin-top:auto"><button class="btn primary" type="button" data-act="buyPromo" data-id="' + esc(p.productId) + '">Buy</button></div>' : '') + '</div>';
    }).join('');
  }
  function campaignState(c) {
    if (c.status === 'active' && typeof c.endAt === 'number' && c.endAt > Date.now()) return ['ok', 'Active until ' + when(c.endAt), ''];
    if (c.status === 'review') return ['warn', 'Under review', (REVIEW_REASONS[c.reviewReason] || 'SOKONI is reviewing this payment') + '. It starts only if the review clears it.'];
    if (c.status === 'stopped') return ['err', 'Stopped by SOKONI', ''];
    return ['warn', 'Ended', ''];
  }
  function renderCampaigns(com) {
    var el = $('campList'); if (!el) return;
    var rows = Array.isArray(com && com.campaigns) ? com.campaigns.slice() : [];
    var names = {};
    ((com && com.catalogue && com.catalogue.promotions) || []).forEach(function (p) { names[p.productId] = p.name; });
    if (!rows.length) { el.textContent = 'No paid campaigns yet.'; return; }
    rows.sort(function (a, b) { return (b.startAt || 0) - (a.startAt || 0); });
    el.innerHTML = '<ul style="margin-left:18px">' + rows.map(function (c) {
      var st = campaignState(c);
      return '<li>' + esc(names[c.productId] || label(c.productId)) + ' · ' + esc(PAID_PLACEMENTS[c.placement] || label(c.placement)) + ' · ' + esc(kes(c.amountKES)) +
        ' <span class="pill ' + st[0] + '">' + esc(st[1]) + '</span>' + (st[2] ? ' <span class="muted">— ' + esc(st[2]) + '</span>' : '') + '</li>';
    }).join('') + '</ul>';
  }

  function buy(act, id, btn) {
    var cat = (S.com && S.com.catalogue) || {};
    if (act === 'buyPlan') {
      var p = (cat.plans || []).filter(function (x) { return x.planId === id; })[0];
      if (!p || p.selfServe !== true) return;
      var cur = (S.com && S.com.plan) || {};
      if (cur.active === true && cur.planId && cur.planId !== p.planId &&
        !window.confirm('Switching plans starts ' + p.name + ' when the payment is confirmed. Time left on ' + (cur.name || 'your current plan') + ' is not carried over. Continue?')) return;
      startPayment('plan', { purpose: 'partner_subscription', planId: p.planId }, p.name + ' — SOKONI partner plan', btn);
      return;
    }
    var q = (cat.promotions || []).filter(function (x) { return x.productId === id; })[0];
    if (!q) return;
    var req = { purpose: 'promotion_purchase', productId: q.productId }, desc = q.name;
    if (q.perDay === true) {
      var sel = Array.prototype.filter.call(document.querySelectorAll('[data-days-for]'), function (s) { return s.getAttribute('data-days-for') === q.productId; })[0];
      var days = sel ? parseInt(sel.value, 10) : NaN;
      if (!(days >= Math.max(1, q.minDays || 1) && days <= Math.min(30, q.maxDays || 30))) { payStatus('Choose how many days (1–30).', 'err'); return; }
      req.days = days; desc += ' × ' + days + ' days';
    }
    startPayment('promo', req, desc, btn);
  }
  function startPayment(kind, req, desc, btn) {
    if (S.paying) return;
    var phone = normPhone(($('payPhone') || {}).value);
    if (!phone) { payStatus('Enter the M-Pesa number to pay from, e.g. 0712 345 678.', 'err'); if ($('payPhone')) $('payPhone').focus(); return; }
    if (!window.SokoniIntaSend || typeof window.SokoniIntaSend.initiateSTKPush !== 'function') { payStatus('Payments are not available on this page right now. Nothing was charged.', 'err'); return; }
    var cur = (S.com && S.com.plan) || S.ws.plan || {};
    var before = { planId: cur.active === true ? cur.planId : null, expiresAt: typeof cur.expiresAt === 'number' ? cur.expiresAt : 0 };
    S.paying = true; busy(btn, true);
    payStatus('Preparing your M-Pesa request…', 'wait');
    payCall(req).catch(function (e) { e.stage = 'intent'; throw e; }).then(function (intent) {
      if (!intent || typeof intent.ref !== 'string' || !intent.ref || typeof intent.amount !== 'number' || !(intent.amount > 0)) { var m = { code: 'mismatch' }; throw m; }
      payStatus('Check your phone and enter your M-Pesa PIN to pay ' + kes(intent.amount) + '.', 'wait');
      /* ALWAYS pass the options object: initiateSTKPush reads options.* unguarded. */
      return window.SokoniIntaSend.initiateSTKPush(phone, intent.amount, intent.ref, { category: kind === 'plan' ? 'partner_plan' : 'promotion', serviceDesc: desc })
        .then(function () { return intent; }, function (e) { e.stage = 'pay'; throw e; });
    }).then(function (intent) {
      payStatus('M-Pesa request sent. Waiting for SOKONI to confirm the payment…', 'wait');
      pollCommercial(kind, intent.ref, req, before, 0, btn);
    }).catch(function (e) {
      S.paying = false; busy(btn, false);
      if (e && e.code === 'mismatch') { payStatus('SOKONI could not prepare this payment, so no M-Pesa request was sent.', 'err'); return; }
      if (e && e.stage === 'pay') { payStatus((e.message ? String(e.message) + ' ' : 'We could not send the M-Pesa request. ') + 'Nothing has been confirmed.', 'err'); return; }
      payStatus(limitHint(commercialUnavailable(e)) + ' Nothing was charged.', 'err');
    });
  }
  var PAY_POLL_EVERY = 4000, PAY_POLL_MAX = 30;   /* ~2 minutes, then a "Check again" button */
  function pollCommercial(kind, ref, req, before, n, btn) {
    clearTimeout(S.pollTimer);
    var view = kind === 'plan' ? 'plan' : 'promote';
    function next() {
      if (S.view !== view) return;
      if (n + 1 >= PAY_POLL_MAX) {
        S.paying = false; busy(btn, false);
        S.pending = { kind: kind, ref: ref, req: req, before: before };
        var el = $('payStatus'); if (!el) return;
        el.className = 'pay-status wait';
        el.innerHTML = esc('Not confirmed yet. If you approved the M-Pesa prompt, SOKONI is still confirming the payment, or reviewing it if something did not match. Nothing changes here until it is confirmed.') +
          ' <button class="btn" type="button" data-act="payCheck">Check again</button>';
        return;
      }
      S.pollTimer = setTimeout(function () { pollCommercial(kind, ref, req, before, n + 1, btn); }, PAY_POLL_EVERY);
    }
    loadCommercial().then(function (com) {
      if (S.view !== view) return;
      if (kind === 'plan') {
        var p = com.plan || {};
        /* success ONLY when the server shows the bought plan active with a later expiry (or newly this plan) */
        if (p.active === true && p.planId === req.planId && typeof p.expiresAt === 'number' && (before.planId !== req.planId || p.expiresAt > before.expiresAt)) {
          return paid('Payment confirmed — ' + (p.name || 'your plan') + ' is active until ' + when(p.expiresAt) + '.', btn, kind);
        }
      } else {
        var c = (com.campaigns || []).filter(function (x) { return x.campaignId === ref; })[0];
        if (c && c.status === 'active') return paid('Payment confirmed — your promotion is live until ' + when(c.endAt) + '.', btn, kind);
        if (c && c.status === 'review') {
          S.paying = false; busy(btn, false); renderCampaigns(com);
          payStatus('Payment received — SOKONI is reviewing this payment. ' + (REVIEW_REASONS[c.reviewReason] ? REVIEW_REASONS[c.reviewReason] + '. ' : '') + 'The promotion starts only if the review clears it.', 'wait');
          return;
        }
      }
      next();
    }).catch(next);
  }
  function paid(text, btn, kind) {
    S.paying = false; busy(btn, false);
    payStatus(text, 'ok');
    if (kind === 'plan') { renderPlans(S.com); call({ op: 'getWorkspace' }).then(function (ws) { S.ws = ws; }).catch(function () {}); }
    else renderCampaigns(S.com);
  }

  function vTeam(v) {
    v.innerHTML = '<h1>Team</h1><p class="muted">People who work this workspace with you. Managers can do everything except team and registration; officers handle the register and enquiries.</p>' +
      '<div class="panel"><div class="tbl-wrap"><table><thead><tr><th>Email</th><th>Role</th><th>Added</th><th><span class="skip">Actions</span></th></tr></thead><tbody id="tRows"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody></table></div></div>' +
      (isOwner() ? '<form class="panel" id="teamForm" novalidate><h2 style="margin-top:0">Add a team member</h2><p class="muted">They need a SOKONI account with this email.</p><div class="row">' +
        '<div><label for="t1">Email</label><input id="t1" name="email" type="email" maxlength="120" required autocomplete="off"></div>' +
        '<div><label for="t2">Role</label><select id="t2" name="role"><option value="officer">Officer</option><option value="manager">Manager</option></select></div></div>' +
        '<div class="actions"><button class="btn primary" type="submit">Add</button></div></form>' : '');
    call({ op: 'listTeam' }).then(function (r) {
      var tb = $('tRows'); if (!tb) return;
      tb.innerHTML = r.rows.length ? r.rows.map(function (t) {
        return '<tr><td>' + esc(t.email) + '</td><td>' + esc(label(t.role)) + '</td><td>' + esc(when(t.addedAt)) + '</td><td>' + (isOwner() ? '<button class="btn danger" type="button" data-act="tRemove" data-id="' + esc(t.uid) + '">Remove</button>' : '') + '</td></tr>';
      }).join('') : '<tr><td colspan="4" class="muted">Just you so far.</td></tr>';
    }).catch(function (e) { var tb = $('tRows'); if (tb) tb.innerHTML = '<tr><td colspan="4" class="muted">Could not load: ' + esc(errMsg(e)) + '</td></tr>'; });
  }

  function vProfile(v) {
    var p = S.ws.profile || {}, c = S.ws.config, max = c.descriptionMax || 300;
    var svc = c.services || [], cty = c.counties || [], have = p.services || [];
    v.innerHTML = '<h1>Public profile</h1><p class="muted">What people see on your Banking Hub listing. Your name and institution type come from your approved application — changing them needs a new application.</p>' +
      '<form class="panel" id="profileForm" novalidate>' +
      '<div><label for="f1">About (up to ' + esc(max) + ' characters)</label><textarea id="f1" name="description" maxlength="' + esc(max) + '">' + esc(p.description || '') + '</textarea></div>' +
      '<fieldset style="border:0;margin-top:12px"><legend class="muted" style="font-size:12px;margin-bottom:6px">Services you offer (at least one, up to 8)</legend><div class="row">' +
      svc.map(function (s, i) { return '<label class="check" style="margin:0"><input type="checkbox" name="services" value="' + esc(s) + '"' + (have.indexOf(s) >= 0 ? ' checked' : '') + ' id="sv' + i + '"> <span>' + esc(label(String(s).toLowerCase())) + '</span></label>'; }).join('') +
      '</div></fieldset><div class="row" style="margin-top:12px">' +
      '<div><label for="f8">County</label><select id="f8" name="county"><option value="">Not set</option>' + cty.map(function (x) { return '<option' + (x === p.county ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="f2">Website (https://)</label><input id="f2" name="website" type="url" maxlength="200" value="' + esc(p.website || '') + '"></div>' +
      '<div><label for="f3">Contact phone</label><input id="f3" name="businessPhone" inputmode="tel" value="' + esc(p.businessPhone || '') + '"></div>' +
      '<div><label for="f4">Contact email</label><input id="f4" name="businessEmail" type="email" maxlength="120" value="' + esc(p.businessEmail || '') + '"></div>' +
      '<div><label for="f5">Opening hours</label><input id="f5" name="hours" maxlength="120" value="' + esc(p.hours || '') + '"></div></div>' +
      '<div style="margin-top:12px"><label for="f7">Branches (one per line)</label><textarea id="f7" name="branches">' + esc((p.branches || []).join('\n')) + '</textarea></div>' +
      '<div class="actions"><button class="btn primary" type="submit">Save profile</button></div></form>';
  }

  /* ── Events (delegated; no inline handlers) ─────────────────────────────────────────── */
  document.addEventListener('click', function (ev) {
    var nav = ev.target.closest('[data-nav]');
    if (nav) { show(nav.getAttribute('data-nav')); return; }
    var a = ev.target.closest('[data-act]'); if (!a || a.tagName === 'SELECT') return;
    var act = a.getAttribute('data-act'), id = a.getAttribute('data-id');
    if (act === 'retry') { location.reload(); return; }
    if (act === 'buyPlan' || act === 'buyPromo') { buy(act, id, a); return; }
    if (act === 'payCheck') {
      var pend = S.pending; if (!pend || S.paying) return;
      S.paying = true; payStatus('Checking with SOKONI…', 'wait');
      pollCommercial(pend.kind, pend.ref, pend.req, pend.before, PAY_POLL_MAX - 5, null);
      return;
    }
    if (act === 'mSearch') {
      var q = ($('mq').value || '').trim(), f = $('mf').value;
      S.memberFilter = /^[+\d\s()-]{9,}$/.test(q) ? { phone: q } : (q ? { memberNo: q } : (f ? { status: f } : {}));
      loadMembers(true); return;
    }
    if (act === 'mMore') { loadMembers(false); return; }
    if (act === 'mStatus') {
      busy(a, true);
      call({ op: 'updateMember', id: id, status: a.getAttribute('data-status') }).then(function () { toast('Updated.'); loadMembers(true); })
        .catch(function (e) { toast(errMsg(e), true); }).then(function () { busy(a, false); });
      return;
    }
    if (act === 'mDelete') {
      if (!window.confirm('Delete this record permanently? Use this when the person asks to be removed.')) return;
      busy(a, true);
      call({ op: 'deleteMember', id: id }).then(function () { toast('Deleted.'); loadMembers(true); })
        .catch(function (e) { toast(errMsg(e), true); }).then(function () { busy(a, false); });
      return;
    }
    if (act === 'pEdit') {
      var p = (S.products || []).filter(function (x) { return x.id === id; })[0]; var form = $('productForm'); if (!p || !form) return;
      ['id', 'name', 'kind', 'currency', 'buy', 'sell', 'rateText', 'minAmount', 'status', 'description'].forEach(function (k) { if (form.elements[k]) form.elements[k].value = p[k] == null ? '' : p[k]; });
      $('pTitle').textContent = 'Edit'; form.scrollIntoView({ behavior: 'smooth' }); return;
    }
    if (act === 'pReset') { var pf = $('productForm'); if (pf) { pf.elements.id.value = ''; $('pTitle').textContent = 'Add'; } return; }
    if (act === 'tRemove') {
      if (!window.confirm('Remove this person from your team?')) return;
      busy(a, true);
      call({ op: 'removeTeamMember', uid: id }).then(function () { toast('Removed.'); show('team'); })
        .catch(function (e) { toast(errMsg(e), true); busy(a, false); });
    }
  });
  document.addEventListener('change', function (ev) {
    var s = ev.target;
    if (s.id === 'i0' && s.files && s.files[0]) {
      var file = s.files[0];
      if (file.size > 512 * 1024) { toast('That file is too large (max 512 KB).', true); s.value = ''; return; }
      file.text().then(function (t) { $('i1').value = t; });
      return;
    }
    var act = s.getAttribute && s.getAttribute('data-act');
    if (act === 'eFilter') loadEnquiries(s.value);
    if (act === 'eStatus') {
      s.disabled = true;
      call({ op: 'updateEnquiry', id: s.getAttribute('data-id'), status: s.value }).then(function () { toast('Updated.'); })
        .catch(function (e) { toast(errMsg(e), true); }).then(function () { s.disabled = false; });
    }
  });
  document.addEventListener('submit', function (ev) {
    var form = ev.target; ev.preventDefault();
    var btn = form.querySelector('[type="submit"]'), d = formData(form), req = null, after = null;
    if (form.id === 'regForm') {
      var anyLic = d.licenceType || d.licenceNumber || d.issuingAuthority || d.licenceExpiry;
      if (anyLic && !d.licenceNumber) { toast('Add the licence number, or clear the licence fields.', true); return; }
      if (d.licenceNumber && !d.issuingAuthority) { toast('Add the issuing authority for the licence.', true); return; }
      req = { op: 'submitRegistration', regulator: d.regulator, registeredName: d.registeredName, registrationNumber: d.registrationNumber, kraPin: d.kraPin, validUntil: d.validUntil };
      if (d.licenceNumber) { req.licenceType = d.licenceType; req.licenceNumber = d.licenceNumber; req.issuingAuthority = d.issuingAuthority; req.licenceExpiry = d.licenceExpiry; }
      after = function () { toast('Submitted for review.'); refresh('registration'); };
    }
    if (form.id === 'memberForm') {
      if (!form.elements.consent.checked) { toast('Please confirm the person agreed to be recorded.', true); return; }
      req = { op: 'addMember', name: d.name, phone: d.phone, memberNo: d.memberNo, joinedOn: d.joinedOn, note: d.note, consentAttested: true };
      after = function () { toast('Added.'); form.reset(); loadMembers(true); };
    }
    if (form.id === 'importForm') {
      if (!form.elements.consent.checked) { toast('Please confirm everyone agreed to be recorded.', true); return; }
      var rows = parseRows(d.rows);
      if (!rows.length) { toast('Paste at least one row.', true); return; }
      if (rows.length > 200) { toast('Import at most 200 rows at a time.', true); return; }
      req = { op: 'importMembers', rows: rows, consentAttested: true };
      after = function (r) {
        var bad = r.results.filter(function (x) { return !x.ok; });
        $('importResult').innerHTML = '<p style="margin-top:10px">' + esc(r.added) + ' added, ' + esc(r.failed) + ' not added.</p>' +
          (bad.length ? '<ul class="muted" style="margin:6px 0 0 18px">' + bad.slice(0, 50).map(function (x) { return '<li>Row ' + esc(x.row) + ': ' + esc(x.reason) + '</li>'; }).join('') + '</ul>' : '');
        loadMembers(true);
      };
    }
    if (form.id === 'productForm') {
      req = { op: 'saveProduct', id: d.id || undefined, name: d.name, kind: d.kind, status: d.status, description: d.description, rateText: d.rateText, minAmount: d.minAmount, currency: d.currency ? d.currency.toUpperCase() : undefined, buy: d.buy, sell: d.sell };
      after = function () { toast('Saved.'); form.reset(); form.elements.id.value = ''; $('pTitle').textContent = 'Add'; loadProducts(); };
    }
    if (form.id === 'promoForm') { req = { op: 'requestPromotion', placement: d.placement, message: d.message }; after = function () { toast('Request sent — SOKONI will review it.'); form.reset(); loadPromotions(); }; }
    if (form.id === 'teamForm') { req = { op: 'addTeamMember', email: d.email, role: d.role }; after = function () { toast('Added to your team.'); show('team'); }; }
    if (form.id === 'profileForm') {
      var lines = function (s) { return String(s || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); };
      var picked = Array.prototype.map.call(form.querySelectorAll('input[name="services"]:checked'), function (x) { return x.value; });
      if (!picked.length) { toast('Choose at least one service.', true); return; }
      if (picked.length > 8) { toast('Choose up to 8 services.', true); return; }
      req = { op: 'updateProfile', description: d.description, services: picked, county: d.county, website: d.website, businessPhone: d.businessPhone, businessEmail: d.businessEmail, hours: d.hours, branches: lines(d.branches) };
      after = function () { toast('Profile saved.'); refresh('profile'); };
    }
    if (!req) return;
    busy(btn, true);
    call(req).then(after).catch(function (e) { toast(limitHint(errMsg(e)), true); }).then(function () { busy(btn, false); });
  });
  function refresh(view) { call({ op: 'getWorkspace' }).then(function (ws) { S.ws = ws; renderNav(); show(view); }).catch(function (e) { toast(errMsg(e), true); }); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
