/* ============================================================================
   SOKONI — Financial Partner Workspace (client) — 2026-10-01
   Talks ONLY to the financialPartnerDispatch callable; the server decides who is a partner, which
   category tools appear, and every count. Nothing here is cached in localStorage and no figure is
   computed on the client: an unknown count renders '—', never 0.
   ============================================================================ */
(function () {
  'use strict';
  var ICONS = { overview: '🏠', registration: '🪪', members: '👥', products: '🧾', enquiries: '✉️', team: '🧑‍💼', profile: '⚙️' };
  var S = { ws: null, view: 'overview', members: [], memberNext: null, memberFilter: {} };
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
      show(ws.config.modules.indexOf(want) >= 0 ? want : 'overview');
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
    var names = { overview: 'Overview', registration: 'Registration', members: c.memberLabel, products: c.productLabel, enquiries: 'Enquiries', team: 'Team', profile: 'Public profile' };
    /* only known module keys ever reach markup or show() */
    var visible = c.modules.filter(function (m) { return Object.prototype.hasOwnProperty.call(ICONS, m); }).filter(function (m) {
      if (m === 'registration' || m === 'team') return isOwner() || (m === 'team' && canManage());
      if (m === 'products' || m === 'profile') return canManage();
      return true;
    });
    $('sbNav').innerHTML = visible.map(function (m) {
      var badge = (m === 'enquiries' && S.ws.counts.newEnquiries) ? '<span class="sb-badge" aria-label="new">' + esc(S.ws.counts.newEnquiries) + '</span>' : '';
      return '<button type="button" class="sb-item" data-nav="' + m + '"><span aria-hidden="true">' + ICONS[m] + '</span>' + esc(names[m]) + badge + '</button>';
    }).join('');
  }
  function show(view) {
    S.view = view;
    if (history.replaceState) history.replaceState(null, '', '#' + view);
    Array.prototype.forEach.call(document.querySelectorAll('[data-nav]'), function (b) {
      if (b.getAttribute('data-nav') === view) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
    });
    var v = $('view'); v.innerHTML = '<div class="state muted">Loading…</div>';
    ({ overview: vOverview, registration: vRegistration, members: vMembers, products: vProducts, enquiries: vEnquiries, team: vTeam, profile: vProfile }[view] || vOverview)(v);
    $('main').focus({ preventScroll: true });
  }

  /* ── Views ──────────────────────────────────────────────────────────────────────────── */
  function regPill(r) {
    var st = (r && r.status) || 'not_submitted';
    var map = { verified: ['ok', 'Verified by SOKONI'], under_review: ['warn', 'Under review'], rejected: ['err', 'Not accepted'], not_submitted: ['warn', 'Not submitted'] };
    var m = map[st] || ['warn', label(st)];
    return '<span class="pill ' + m[0] + '">' + esc(m[1]) + '</span>';
  }
  function vOverview(v) {
    var w = S.ws, c = w.config, n = w.counts;
    var cards = [];
    if (c.modules.indexOf('members') >= 0) { cards.push(['Total ' + c.memberLabel.toLowerCase(), n.members]); cards.push(['Active ' + c.memberLabel.toLowerCase(), n.activeMembers]); }
    cards.push(['Published ' + c.productLabel.toLowerCase(), n.publishedProducts]);
    cards.push(['New enquiries', n.newEnquiries]);
    v.innerHTML = '<h1>Welcome, ' + esc(w.listing.name || 'partner') + '</h1>' +
      '<p class="muted">' + esc(c.label) + ' workspace · listing <span class="pill ok">Approved</span> · registration ' + regPill(w.registration) + '</p>' +
      '<div class="cards">' + cards.map(function (x) { return '<div class="card"><div class="k">' + esc(x[0]) + '</div><div class="v">' + shown(x[1]) + '</div></div>'; }).join('') + '</div>' +
      (w.registration.status !== 'verified' && isOwner() ? '<div class="notice">Your registration details are <strong>' + esc(label(w.registration.status)) + '</strong>. Until SOKONI verifies them, your public listing says the details are self-declared. <button class="btn" type="button" data-nav="registration" style="margin-left:8px">Open registration</button></div>' : '') +
      '<h2>Quick actions</h2><div class="actions">' +
      (c.modules.indexOf('members') >= 0 ? '<button class="btn primary" type="button" data-nav="members">Add ' + esc(c.memberLabel.toLowerCase().replace(/s$/, '')) + '</button>' : '') +
      (canManage() ? '<button class="btn" type="button" data-nav="products">Manage ' + esc(c.productLabel.toLowerCase()) + '</button>' : '') +
      '<button class="btn" type="button" data-nav="enquiries">Enquiries</button>' +
      (canManage() ? '<button class="btn" type="button" data-nav="profile">Edit public profile</button>' : '') + '</div>';
  }

  function vRegistration(v) {
    var r = S.ws.registration || {}, c = S.ws.config;
    var locked = r.status === 'under_review' || r.status === 'verified';
    v.innerHTML = '<h1>Registration</h1><p class="muted">Your licence or registration with the regulator. SOKONI checks it before your listing shows it as verified.</p>' +
      '<div class="panel"><p>Status: ' + regPill(r) + (r.reviewNote ? ' <span class="muted">— ' + esc(r.reviewNote) + '</span>' : '') + '</p>' +
      (r.regulator ? '<p class="muted" style="margin-top:6px">' + esc(r.regulator) + (r.registrationNumber ? ' · ' + esc(r.registrationNumber) : '') + '</p>' : '') + '</div>' +
      (locked ? '<div class="notice">' + (r.status === 'verified' ? 'Verified. To change these details, contact SOKONI support.' : 'Submitted — SOKONI is reviewing it. You will see the result here.') + '</div>' :
      '<form class="panel" id="regForm" novalidate><div class="row">' +
      '<div><label for="rg1">Regulator</label><select id="rg1" name="regulator" required>' + c.regulators.map(function (x) { return '<option' + (x === r.regulator ? ' selected' : '') + '>' + esc(x) + '</option>'; }).join('') + '</select></div>' +
      '<div><label for="rg2">Registered name</label><input id="rg2" name="registeredName" maxlength="120" required value="' + esc(r.registeredName || '') + '"></div>' +
      '<div><label for="rg3">Registration / licence number</label><input id="rg3" name="registrationNumber" maxlength="40" value="' + esc(r.registrationNumber || '') + '"></div>' +
      '<div><label for="rg4">KRA PIN (optional)</label><input id="rg4" name="kraPin" maxlength="11" autocomplete="off" value="' + esc(r.kraPin || '') + '"></div>' +
      '<div><label for="rg5">Valid until (optional)</label><input id="rg5" name="validUntil" type="date" value="' + esc(r.validUntil || '') + '"></div>' +
      '</div><div class="actions"><button class="btn primary" type="submit">Submit for review</button></div></form>');
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
    var p = S.ws.profile || {};
    v.innerHTML = '<h1>Public profile</h1><p class="muted">What people see on your Banking Hub listing.</p>' +
      '<form class="panel" id="profileForm" novalidate>' +
      '<div><label for="f1">About</label><textarea id="f1" name="description" maxlength="1000">' + esc(p.description || '') + '</textarea></div><div class="row" style="margin-top:12px">' +
      '<div><label for="f2">Website (https://)</label><input id="f2" name="website" type="url" maxlength="200" value="' + esc(p.website || '') + '"></div>' +
      '<div><label for="f3">Contact phone</label><input id="f3" name="contactPhone" inputmode="tel" value="' + esc(p.contactPhone ? '+' + p.contactPhone : '') + '"></div>' +
      '<div><label for="f4">Contact email</label><input id="f4" name="contactEmail" type="email" maxlength="120" value="' + esc(p.contactEmail || '') + '"></div>' +
      '<div><label for="f5">Opening hours</label><input id="f5" name="hours" maxlength="120" value="' + esc(p.hours || '') + '"></div></div>' +
      '<div style="margin-top:12px"><label for="f6">Services (one per line, up to 20)</label><textarea id="f6" name="services">' + esc((p.services || []).join('\n')) + '</textarea></div>' +
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
    if (form.id === 'regForm') { req = { op: 'submitRegistration', regulator: d.regulator, registeredName: d.registeredName, registrationNumber: d.registrationNumber, kraPin: d.kraPin, validUntil: d.validUntil }; after = function () { toast('Submitted for review.'); refresh('registration'); }; }
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
    if (form.id === 'teamForm') { req = { op: 'addTeamMember', email: d.email, role: d.role }; after = function () { toast('Added to your team.'); show('team'); }; }
    if (form.id === 'profileForm') {
      var lines = function (s) { return String(s || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean); };
      req = { op: 'updateProfile', description: d.description, website: d.website, contactPhone: d.contactPhone, contactEmail: d.contactEmail, hours: d.hours, services: lines(d.services), branches: lines(d.branches) };
      after = function () { toast('Profile saved.'); refresh('profile'); };
    }
    if (!req) return;
    busy(btn, true);
    call(req).then(after).catch(function (e) { toast(errMsg(e), true); }).then(function () { busy(btn, false); });
  });
  function refresh(view) { call({ op: 'getWorkspace' }).then(function (ws) { S.ws = ws; renderNav(); show(view); }).catch(function (e) { toast(errMsg(e), true); }); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
