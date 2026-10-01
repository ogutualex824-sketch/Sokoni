/* ============================================================================
   SOKONI Foundation — public page (client) — 2026-10-01
   Contract: FOUNDATION_CONTRACT (see docs/SOKONI_FOUNDATION.md).

   Rules this file keeps:
   - The server is the only authority for amounts, pledge state, totals and stories.
     Nothing money- or state-related is stored in localStorage; sessionStorage holds
     ONE thing — the donation requestId, so a retry reuses it (idempotent pledge).
   - Unknown numbers render '—', never 0. A failed/undeployed callable is
     "not available right now", never "empty".
   - The thank-you is shown ONLY when impactGetMyPledge returns status 'completed'.
   - Every server string that reaches innerHTML goes through esc(); URLs through safeUrl().
   - No inline handlers: one delegated listener per section.
   ============================================================================ */
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var safeUrl = function (u) { return (typeof u === 'string' && /^https:\/\/[^\s"'<>]+$/i.test(u)) ? u : ''; };
  var money = function (n) { return (typeof n === 'number' && isFinite(n)) ? 'KES ' + n.toLocaleString('en-KE') : '—'; };
  var MIN = 10, MAX = 100000;
  var REQ_KEY = 'sk_foundation_donation_request';
  var UNAVAILABLE = ['not-found', 'unavailable', 'internal', 'unimplemented', 'deadline-exceeded', 'unknown'];

  /* The ONE transport. Every callable this page uses is named at its call site
     (call('impactGetCampaigns', …)) so the static suite can enumerate them. */
  function call(name, data) {
    return window.waitForFirebaseReady().then(function () {
      return window.sokoniCallable(name)(data || {});
    }).then(function (r) { return r && r.data; });
  }
  function code(e) { return String((e && e.code) || '').replace(/^functions\//, ''); }
  function isUnavailable(e) { var c = code(e); return !c || UNAVAILABLE.indexOf(c) > -1; }
  function uuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    var b = new Uint8Array(16); window.crypto.getRandomValues(b);
    b[6] = (b[6] & 15) | 64; b[8] = (b[8] & 63) | 128;
    var h = Array.prototype.map.call(b, function (x) { return (x + 256).toString(16).slice(1); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }
  function setStatus(el, text, kind) { el.textContent = text || ''; el.className = 'status' + (kind ? ' ' + kind : ''); }
  function currentUser() { return (window.firebaseAuth && window.firebaseAuth.currentUser) || null; }
  function loginUrl(hash) {
    var back = location.pathname.replace(/^\//, '') + location.search + (hash || '');
    return 'login.html?redirect=' + encodeURIComponent(back);
  }
  var params = new URLSearchParams(location.search);

  /* ── Programmes (shared by the donation picker and the testimonial form) ─────────── */
  var programmes = null;   /* null = not loaded / unavailable; [] = loaded, none */
  function programmeTitle(id) {
    if (!id) return 'General Foundation fund';
    var p = (programmes || []).filter(function (x) { return x.id === id; })[0];
    return p ? p.title : 'Selected programme';
  }
  function loadProgrammes() {
    return call('impactGetCampaigns', { limit: 24 }).then(function (r) {
      var list = (r && (r.campaigns || r.rows)) || (Array.isArray(r) ? r : []);
      programmes = list.filter(function (p) { return p && typeof p.id === 'string' && p.title; });
    }).catch(function () { programmes = null; }).then(fillProgrammePickers);
  }
  function fillProgrammePickers() {
    ['fdProgramme', 'tsProgramme'].forEach(function (id) {
      var sel = $(id); if (!sel) return;
      while (sel.options.length > 1) sel.remove(1);
      (programmes || []).forEach(function (p) {
        var o = document.createElement('option'); o.value = p.id; o.textContent = p.title; sel.appendChild(o);
      });
    });
    var note = $('fdProgrammeNote');
    if (programmes === null) note.textContent = "Programmes can't be loaded right now — your gift will go to the general Foundation fund.";
    else if (!programmes.length) note.textContent = 'No programmes are open right now — your gift will go to the general Foundation fund.';
    else note.textContent = 'Choose a programme, or leave it on the general fund.';
    var want = D.programmeId || params.get('programme') || '';
    if (want) preselectProgramme(want, false);
  }
  function preselectProgramme(id, announce) {
    var ok = (programmes || []).some(function (p) { return p.id === id; });
    if (ok) { D.programmeId = id; $('fdProgramme').value = id; }
    else if (programmes !== null) {
      D.programmeId = ''; $('fdProgramme').value = '';
      $('fdProgrammeNote').textContent = "That programme isn't open for donations right now — your gift will go to the general Foundation fund.";
    } else {
      D.programmeId = id;   /* list unreadable: hold the request; the server validates it at pledge time */
    }
    if (announce) setStatus($('fdStatus'), ok ? 'Programme selected: ' + programmeTitle(id) + '.' : '', '');
  }

  /* ── 2. DONATION WIZARD ───────────────────────────────────────────────────────────── */
  var D = { step: 1, amount: null, programmeId: '', purpose: 'GENERAL_FOUNDATION', anonymous: false, busy: false, pledgeId: null, pollTimer: null };

  function parseAmount(raw) {
    var s = String(raw == null ? '' : raw).replace(/[\s,]/g, '');
    if (!s) return { err: 'Enter an amount.' };
    if (!/^\d+$/.test(s)) return { err: 'Enter whole shillings only, e.g. 500.' };
    var n = Number(s);
    if (n < MIN) return { err: 'The smallest donation is KES 10.' };
    if (n > MAX) return { err: 'The largest single donation is KES 100,000.' };
    return { value: n };
  }
  function showStep(n) {
    D.step = n;
    document.querySelectorAll('#donateForm .wiz-step').forEach(function (fs) { fs.hidden = Number(fs.getAttribute('data-step')) !== n; });
    document.querySelectorAll('#donateForm .wiz-steps li').forEach(function (li, i) { li.classList.toggle('on', i < n); });
    $('donateStepLabel').textContent = 'Step ' + n + ' of 4';
    $('fdBack').hidden = n === 1;
    $('fdNext').textContent = n === 4 ? 'Pledge and pay' : 'Continue';
    $('fdCheck').hidden = true;
    if (n === 3) renderAuthBox();
    if (n === 4) renderReview();
    var first = document.querySelector('#donateForm .wiz-step[data-step="' + n + '"] input, #donateForm .wiz-step[data-step="' + n + '"] select');
    if (first && document.activeElement && document.activeElement.closest && document.activeElement.closest('#donateForm')) first.focus({ preventScroll: true });
  }
  function renderAuthBox() {
    var box = $('fdAuthBox'), u = currentUser();
    box.textContent = '';
    if (u) { box.textContent = 'Signed in. Your receipt will be linked to your SOKONI account.'; return; }
    box.appendChild(document.createTextNode('You need to sign in to donate, so we can link your receipt to your account. '));
    var a = document.createElement('a');
    var q = new URLSearchParams();
    if (D.amount) q.set('amount', String(D.amount));
    if (D.programmeId) q.set('programme', D.programmeId);
    a.href = 'login.html?redirect=' + encodeURIComponent('foundation.html' + (q.toString() ? '?' + q.toString() : '') + '#donate');
    a.textContent = 'Sign in to continue';
    box.appendChild(a);
  }
  function renderReview() {
    var rows = [
      ['Amount', money(D.amount)],
      ['Programme', programmeTitle(D.programmeId)],
      ['Purpose', $('fdPurpose').options[$('fdPurpose').selectedIndex].text],
      ['Show my name', D.anonymous ? 'No — anonymous' : 'Yes']
    ];
    $('fdReview').innerHTML = rows.map(function (r) { return '<dt>' + esc(r[0]) + '</dt><dd>' + esc(r[1]) + '</dd>'; }).join('');
    var u = currentUser(), ph = $('fdPhone');
    if (u && u.phoneNumber && !ph.value) ph.value = '0' + String(u.phoneNumber).replace(/^\+?254/, '');
  }
  function validateStep(n) {
    if (n === 1) {
      var a = parseAmount($('fdAmount').value);
      $('fdAmountErr').textContent = a.err || '';
      if (a.err) { $('fdAmount').setAttribute('aria-invalid', 'true'); $('fdAmount').focus(); return false; }
      $('fdAmount').removeAttribute('aria-invalid');
      D.amount = a.value; return true;
    }
    if (n === 2) { D.programmeId = $('fdProgramme').value || (programmes === null ? D.programmeId : ''); D.purpose = $('fdPurpose').value; return true; }
    if (n === 3) {
      D.anonymous = $('fdAnon').checked;
      if (!currentUser()) { renderAuthBox(); var l = $('fdAuthBox').querySelector('a'); if (l) l.focus(); return false; }
      return true;
    }
    return true;
  }
  function normPhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (/^0[17]\d{8}$/.test(d)) d = '254' + d.slice(1);
    else if (/^[17]\d{8}$/.test(d)) d = '254' + d;
    return /^254[17]\d{8}$/.test(d) ? d : '';
  }

  /* requestId lives in sessionStorage keyed to the exact pledge details: a retry of
     the same pledge reuses it (the server answers alreadyPledged with the same
     pledgeId); changing any detail is a new pledge and gets a new id. */
  function pledgeSig() { return [D.amount, D.programmeId || '', D.purpose, D.anonymous ? 1 : 0].join('|'); }
  function requestIdFor(sig, fresh) {
    var rec = null;
    try { rec = JSON.parse(sessionStorage.getItem(REQ_KEY) || 'null'); } catch (_) { rec = null; }
    if (!fresh && rec && rec.sig === sig && typeof rec.rid === 'string') return rec.rid;
    var rid = uuid();
    try { sessionStorage.setItem(REQ_KEY, JSON.stringify({ sig: sig, rid: rid })); } catch (_) { /* private mode: in-memory id still works for this attempt */ }
    return rid;
  }
  function clearRequestId() { try { sessionStorage.removeItem(REQ_KEY); } catch (_) {} }

  function pledgeError(e) {
    var c = code(e);
    if (c === 'unauthenticated') return 'Please sign in again, then try once more.';
    if (c === 'already-exists') return 'This donation request was already used with different details. Please review and try again.';
    if (c === 'failed-precondition') return "This donation can't be accepted right now — the programme may be closed or donations paused. Please try the general fund or come back later.";
    if (c === 'invalid-argument') return 'Something in the donation details was not accepted. Please check the amount and try again.';
    if (c === 'resource-exhausted') return 'Too many attempts. Please wait a minute and try again.';
    if (c === 'permission-denied') return "Your account can't make donations right now. Please contact support.";
    return "Donations aren't available yet. No payment was requested — please try again later.";
  }

  function submitDonation() {
    if (D.busy) return;
    var phone = normPhone($('fdPhone').value);
    $('fdPhoneErr').textContent = phone ? '' : 'Enter a valid M-Pesa number, e.g. 0712 345 678.';
    if (!phone) { $('fdPhone').focus(); return; }
    if (!currentUser()) { showStep(3); return; }
    D.busy = true;
    var btn = $('fdNext'), st = $('fdStatus');
    btn.disabled = true; $('fdBack').disabled = true;
    setStatus(st, 'Recording your pledge…', 'wait');
    var sig = pledgeSig();
    var body = { amount: D.amount, requestId: requestIdFor(sig, false), purpose: D.purpose, anonymous: D.anonymous };
    if (D.programmeId) body.programmeId = D.programmeId;
    var pledge;
    call('impactPledgeDonation', body).then(function (r) {
      if (!r || !r.pledgeId) throw { code: 'internal' };
      if (r.amount !== D.amount) { var m = { code: 'mismatch' }; throw m; }
      pledge = r; D.pledgeId = r.pledgeId;
      setStatus(st, 'Preparing your M-Pesa request…', 'wait');
      return call('createPaymentIntent', { purpose: 'donation', pledgeId: r.pledgeId }).catch(function (e) { e.stage = 'intent'; throw e; });
    }).then(function (intent) {
      if (!intent || !intent.ref || intent.amount !== pledge.amount) { var m = { code: 'mismatch', stage: 'intent' }; throw m; }
      if (!window.SokoniIntaSend || typeof window.SokoniIntaSend.initiateSTKPush !== 'function') { var u = { code: 'unavailable', stage: 'pay' }; throw u; }
      setStatus(st, 'Check your phone and enter your M-Pesa PIN to confirm.', 'wait');
      /* The existing IntaSend helper (sokoni-intasend.js) — amount and ref are the
         server's; initiateSTKPush re-checks the amount against the minted intent. */
      return window.SokoniIntaSend.initiateSTKPush(phone, intent.amount, intent.ref,
        { category: 'donation', serviceDesc: 'SOKONI Foundation donation' }).catch(function (e) { e.stage = 'pay'; throw e; });
    }).then(function () {
      setStatus(st, 'Confirming your payment…', 'wait');
      poll(0);
    }).catch(function (e) {
      D.busy = false; btn.disabled = false; $('fdBack').disabled = false;
      if (e && e.code === 'mismatch') { setStatus(st, "The amount recorded doesn't match what you entered, so we stopped before asking for payment. Please contact support.", 'bad'); return; }
      if (e && e.code === 'already-exists') requestIdFor(sig, true);
      if (e && e.stage === 'intent') { setStatus(st, isUnavailable(e) ? "Payment isn't available yet. Your pledge is saved — try again later and it will be reused." : pledgeError(e), 'bad'); return; }
      if (e && e.stage === 'pay') { setStatus(st, (e.message && !e.code) ? String(e.message) : "We couldn't send the M-Pesa request. Your pledge is saved — you can try again.", 'bad'); btn.textContent = 'Try payment again'; return; }
      setStatus(st, pledgeError(e), 'bad');
    });
  }

  var POLL_EVERY = 3000, POLL_MAX = 40;   /* ~2 minutes, then hand the user a "Check again" */
  function poll(n) {
    clearTimeout(D.pollTimer);
    call('impactGetMyPledge', { pledgeId: D.pledgeId }).then(function (r) {
      var s = r && r.status;
      if (s === 'completed') return done(r);
      if (s === 'failed') return finish("The payment didn't go through. You can try again.", 'bad', true);
      if (s === 'refunded' || s === 'partially_refunded') return finish('This donation has been refunded.', 'bad', false);
      if (s === 'review') setStatus($('fdStatus'), "We're checking this payment. This page will update when it's confirmed.", 'wait');
      next(n);
    }).catch(function () { next(n); });
  }
  function next(n) {
    if (n + 1 >= POLL_MAX) {
      setStatus($('fdStatus'), "We'll confirm shortly. If you approved the M-Pesa prompt, your donation is being processed — check again in a minute.", 'wait');
      $('fdCheck').hidden = false; return;
    }
    D.pollTimer = setTimeout(function () { poll(n + 1); }, POLL_EVERY);
  }
  function done(r) {
    clearRequestId();
    var st = $('fdStatus');
    st.className = 'status ok'; st.textContent = '';
    var h = document.createElement('strong');
    h.textContent = 'Thank you — your donation of ' + money(typeof r.amount === 'number' ? r.amount : D.amount) + ' is confirmed.';
    st.appendChild(h);
    if (r.receiptId) { st.appendChild(document.createElement('br')); st.appendChild(document.createTextNode('Receipt ' + r.receiptId)); }
    $('fdNext').hidden = true; $('fdBack').hidden = true; $('fdCheck').hidden = true;
    D.busy = false;
  }
  function finish(text, kind, retry) {
    setStatus($('fdStatus'), text, kind);
    D.busy = false; $('fdBack').disabled = false;
    $('fdNext').disabled = !retry; $('fdNext').textContent = retry ? 'Try again' : 'Pledge and pay';
    if (retry) clearRequestId();
  }

  function bindDonation() {
    var form = $('donateForm');
    form.addEventListener('submit', function (ev) { ev.preventDefault(); });
    form.addEventListener('click', function (ev) {
      var pick = ev.target.closest('.pick');
      if (pick) {
        $('fdAmount').value = pick.getAttribute('data-amount');
        form.querySelectorAll('.pick').forEach(function (p) { p.setAttribute('aria-pressed', p === pick ? 'true' : 'false'); });
        $('fdAmountErr').textContent = '';
        return;
      }
      var id = ev.target.closest('button') && ev.target.closest('button').id;
      if (id === 'fdNext') {
        if (D.step < 4) { if (validateStep(D.step)) showStep(D.step + 1); }
        else submitDonation();
      } else if (id === 'fdBack' && !D.busy) {
        showStep(Math.max(1, D.step - 1));
      } else if (id === 'fdCheck') {
        $('fdCheck').hidden = true; setStatus($('fdStatus'), 'Confirming your payment…', 'wait'); poll(POLL_MAX - 10);
      }
    });
    $('fdAmount').addEventListener('input', function () {
      form.querySelectorAll('.pick').forEach(function (p) { p.setAttribute('aria-pressed', p.getAttribute('data-amount') === $('fdAmount').value.replace(/[\s,]/g, '') ? 'true' : 'false'); });
    });
    $('fdAmount').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); $('fdNext').click(); } });
    var pre = parseAmount(params.get('amount'));
    if (!pre.err) $('fdAmount').value = String(pre.value);   /* a valid prefill only — never a substitute */
    /* "Continue your donation" pill while the wizard is off-screen and in progress. */
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        var started = D.step > 1 || $('fdAmount').value;
        $('fdResume').hidden = es[0].isIntersecting || !started || !$('fdNext').offsetParent;
      }, { threshold: 0.15 }).observe(form);
    }
    $('fdResume').addEventListener('click', function () { form.scrollIntoView({ block: 'start' }); var f = form.querySelector('.wiz-step:not([hidden]) input, .wiz-step:not([hidden]) select'); if (f) f.focus({ preventScroll: true }); });
    showStep(1);
  }

  /* "Support this work" — from stories, programmes, or ?programme= in the URL. */
  function supportProgramme(id) {
    if (!D.busy) {
      preselectProgramme(id, true);
      if (D.step === 4 || D.step === 3) showStep(2);
    }
    $('donate').scrollIntoView({ block: 'start' });
    var f = $('fdAmount'); if (D.step === 1 && f) f.focus({ preventScroll: true });
  }

  /* ── 3. STORIES ───────────────────────────────────────────────────────────────────── */
  var storyCursor = null;
  function mediaHtml(m, title) {
    if (!m) return '';
    var url = safeUrl(m.url), thumb = safeUrl(m.thumbUrl);
    if (m.type === 'video' && url) {
      return '<video class="story-media" controls playsinline preload="none"' + (thumb ? ' poster="' + esc(thumb) + '"' : '') +
        ' src="' + esc(url) + '" aria-label="' + esc('Video: ' + title) + '"></video>';
    }
    if (m.type === 'image' && (thumb || url)) {
      return '<img class="story-media" loading="lazy" decoding="async" src="' + esc(thumb || url) + '" alt="' + esc('Photo shared with the story: ' + title) + '">';
    }
    return '';
  }
  function storyCard(r, i) {
    var id = 'st-' + esc(String(r.id || i).replace(/[^\w-]/g, '')) + '-' + i;
    var who = [r.name, r.location].filter(Boolean).join(' · ');
    return '<article class="story">' + mediaHtml((r.media || [])[0], r.title || 'Story') +
      '<div class="story-body">' +
        '<span class="tag">' + esc(r.kind === 'testimonial' ? 'Testimonial' : 'Story') + '</span>' +
        '<h3>' + esc(r.title || 'Untitled') + '</h3>' +
        (who ? '<div class="story-who">' + esc(who) + '</div>' : '') +
        '<p>' + esc(r.excerpt || '') + '</p>' +
        '<div class="story-full" id="' + id + '" hidden>' + esc(r.body || '') + '</div>' +
        '<div class="story-actions">' +
          (r.body ? '<button type="button" class="btn-link" data-read="' + id + '" aria-expanded="false" aria-controls="' + id + '">Read story</button>' : '') +
          (r.programmeId ? '<button type="button" class="btn btn-sm btn-acc" data-support="' + esc(r.programmeId) + '">Support this work</button>' : '') +
        '</div>' +
      '</div></article>';
  }
  function loadStories(more) {
    var st = $('storyStatus'), btn = $('storyMore');
    btn.disabled = true;
    var q = { op: 'listPublished', destination: 'donation_wizard', limit: 6 };
    if (more && storyCursor) q.cursor = storyCursor;
    st.textContent = more ? 'Loading more stories…' : 'Loading stories…';
    call('foundationContentDispatch', q).then(function (r) {
      var rows = (r && Array.isArray(r.rows)) ? r.rows : [];
      storyCursor = (r && r.next) || null;
      var grid = $('storyGrid');
      var start = grid.querySelectorAll('.story').length;
      if (!more && !rows.length) {
        st.textContent = '';
        grid.innerHTML = '<div class="empty"><h3>Share your SOKONI Foundation story</h3><p class="muted">No stories have been published yet. Has the Foundation helped you or your community?</p><a class="btn btn-acc" href="#share">Share your story</a></div>';
      } else {
        grid.insertAdjacentHTML('beforeend', rows.map(function (row, i) { return storyCard(row, start + i); }).join(''));
        st.textContent = more ? rows.length + ' more stories loaded.' : '';
      }
      btn.hidden = !storyCursor; btn.disabled = false;
    }).catch(function () {
      st.textContent = more ? "More stories can't be loaded right now." : "Stories aren't available right now. Please check back soon.";
      btn.disabled = false; btn.hidden = !storyCursor;
    });
  }
  function bindStories() {
    $('stories').addEventListener('click', function (ev) {
      var rd = ev.target.closest('[data-read]');
      if (rd) {
        var body = $(rd.getAttribute('data-read')); if (!body) return;
        body.hidden = !body.hidden;
        rd.setAttribute('aria-expanded', body.hidden ? 'false' : 'true');
        rd.textContent = body.hidden ? 'Read story' : 'Show less';
        return;
      }
      var sp = ev.target.closest('[data-support]');
      if (sp) { supportProgramme(sp.getAttribute('data-support')); return; }
      if (ev.target.id === 'storyMore') loadStories(true);
    });
  }

  /* ── 4. TESTIMONIAL WIZARD ────────────────────────────────────────────────────────── */
  var IMG_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  var VID_TYPES = { 'video/mp4': 'mp4', 'video/webm': 'webm', 'video/quicktime': 'mov' };
  var IMG_MAX = 15 * 1024 * 1024, VID_MAX = 80 * 1024 * 1024;
  var T = { files: [], requestId: null, busy: false };

  function renderFiles() {
    $('tsFileList').innerHTML = T.files.map(function (f, i) {
      return '<li><span>' + esc(f.name) + ' (' + esc((f.size / 1048576).toFixed(1)) + ' MB)</span>' +
        '<button type="button" class="btn btn-sm" data-remove="' + i + '" aria-label="' + esc('Remove ' + f.name) + '">Remove</button></li>';
    }).join('');
  }
  function addFiles(list) {
    var err = '';
    Array.prototype.forEach.call(list, function (f) {
      var isImg = IMG_TYPES.indexOf(f.type) > -1, isVid = !!VID_TYPES[f.type];
      if (T.files.length >= 4) { err = 'You can add up to 4 files.'; return; }
      if (!isImg && !isVid) { err = f.name + ' is not a supported photo or video type.'; return; }
      if (isImg && f.size > IMG_MAX) { err = f.name + ' is larger than 15 MB.'; return; }
      if (isVid && f.size > VID_MAX) { err = f.name + ' is larger than 80 MB.'; return; }
      if (isVid && T.files.some(function (x) { return !!VID_TYPES[x.type]; })) { err = 'Only one video per story.'; return; }
      T.files.push(f);
    });
    $('tsFilesErr').textContent = err;
    renderFiles();
  }
  function randomName() { return uuid().replace(/-/g, ''); }
  function uploadAll(uid) {
    var U = window.SokoniUpload;
    if (!T.files.length) return Promise.resolve([]);
    if (!U || typeof U.uploadToStorage !== 'function') return Promise.reject(new Error('upload-unavailable'));
    var paths = [];
    return T.files.reduce(function (p, f, i) {
      return p.then(function () {
        setStatus($('tsStatus'), 'Uploading file ' + (i + 1) + ' of ' + T.files.length + '…', 'wait');
        var isImg = IMG_TYPES.indexOf(f.type) > -1;
        var prep = isImg && typeof U.compressImage === 'function'
          ? U.compressImage(f, { maxW: 1600, maxH: 1600, quality: 0.82, format: 'webp' }).then(function (b) { return { blob: b, ext: 'webp' }; })
              .catch(function () { return { blob: f, ext: f.type === 'image/png' ? 'png' : f.type === 'image/webp' ? 'webp' : 'jpg' }; })
          : Promise.resolve({ blob: f, ext: VID_TYPES[f.type] || 'bin' });
        return prep.then(function (x) {
          var path = 'foundation-media/' + uid + '/' + randomName() + '.' + x.ext;
          var file = x.blob instanceof File ? x.blob : new File([x.blob], path.split('/').pop(), { type: x.blob.type || f.type });
          return U.uploadToStorage(file, path).then(function () { paths.push(path); });
        });
      });
    }, Promise.resolve()).then(function () { return paths; });
  }
  function displayPref() { var r = document.querySelector('input[name="displayPreference"]:checked'); return r ? r.value : 'anonymous'; }
  function validateTestimonial() {
    var ok = true, title = $('tsTitle').value.trim(), body = $('tsBody').value.trim();
    $('tsTitleErr').textContent = title ? '' : 'Give your story a title.';
    $('tsBodyErr').textContent = body.length >= 20 ? '' : 'Please tell us a little more (at least 20 characters).';
    $('tsConsentErr').textContent = $('tsConsentPublish').checked ? '' : 'We can only publish your story with your permission.';
    if (!title) { ok = false; $('tsTitle').focus(); }
    else if (body.length < 20) { ok = false; $('tsBody').focus(); }
    else if (!$('tsConsentPublish').checked) { ok = false; $('tsConsentPublish').focus(); }
    return ok;
  }
  function submitTestimonial(textOnly) {
    if (T.busy) return;
    var u = currentUser();
    if (!u) { renderShareAuth(); return; }
    if (!validateTestimonial()) return;
    T.busy = true; $('tsSubmit').disabled = true; $('tsTextOnly').hidden = true;
    if (!T.requestId) T.requestId = uuid();
    var pref = displayPref(), name = $('tsName').value.trim();
    var upload = textOnly ? Promise.resolve([]) : uploadAll(u.uid).catch(function () {
      var e = new Error('upload'); e.upload = true; throw e;
    });
    upload.then(function (paths) {
      setStatus($('tsStatus'), 'Sending your story…', 'wait');
      var body = {
        op: 'submitTestimonial', requestId: T.requestId,
        title: $('tsTitle').value.trim().slice(0, 120), body: $('tsBody').value.trim().slice(0, 5000),
        displayPreference: pref,
        consent: { publish: true, showName: pref !== 'anonymous' && $('tsConsentName').checked, showMedia: paths.length > 0 && $('tsConsentMedia').checked }
      };
      if ($('tsProgramme').value) body.programmeId = $('tsProgramme').value;
      if (pref === 'name' && name) body.displayName = name.slice(0, 80);
      if (pref === 'first_name' && name) body.displayName = name.split(/\s+/)[0].slice(0, 40);
      var loc = $('tsLocation').value.trim(); if (loc) body.location = loc.slice(0, 60);
      if (paths.length) body.media = paths;
      return call('foundationContentDispatch', body);
    }).then(function (r) {
      if (!r || !r.ok) throw { code: 'internal' };
      setStatus($('tsStatus'), 'Thank you — our team reviews every story before it appears.', 'ok');
      $('tsForm').reset(); T.files = []; T.requestId = null; renderFiles(); syncNameField();
      loadMine();
    }).catch(function (e) {
      if (e && e.upload) {
        setStatus($('tsStatus'), "Photos/videos can't be uploaded right now — you can send your story as text.", 'bad');
        $('tsTextOnly').hidden = false;
      } else {
        var c = code(e);
        setStatus($('tsStatus'),
          c === 'invalid-argument' ? 'Something in your story was not accepted. Please check the title, length and location.' :
          c === 'already-exists' ? 'This story was already sent. You can see it under My stories.' :
          c === 'unauthenticated' ? 'Please sign in again, then send your story.' :
          c === 'resource-exhausted' ? 'You have sent several stories recently. Please try again later.' :
          "Stories can't be sent yet. Please keep your text and try again later.", 'bad');
        if (c === 'already-exists') loadMine();
      }
    }).then(function () { T.busy = false; $('tsSubmit').disabled = false; });
  }
  var STATUS_WORDS = {
    draft: 'Draft', pending: 'Waiting for review', approved: 'Approved', published: 'Published',
    rejected: 'Not published', changes_requested: 'Changes requested', archived: 'Archived',
    removed: 'Removed', withdrawn: 'Consent withdrawn'
  };
  function loadMine() {
    var st = $('tsMineStatus');
    st.textContent = 'Loading your stories…';
    call('foundationContentDispatch', { op: 'listMine' }).then(function (r) {
      var rows = (r && Array.isArray(r.rows)) ? r.rows : [];
      st.textContent = rows.length ? '' : "You haven't shared a story yet.";
      $('tsMine').innerHTML = rows.map(function (row) {
        var s = String(row.status || '');
        var canWithdraw = ['withdrawn', 'removed'].indexOf(s) === -1 && !row.consentWithdrawn;
        return '<li><span><b>' + esc(row.title || 'Untitled') + '</b></span>' +
          '<span class="pill">' + esc(STATUS_WORDS[s] || 'Status unknown') + '</span>' +
          (canWithdraw ? '<button type="button" class="btn btn-sm" data-withdraw="' + esc(row.id) + '">Withdraw consent</button>' : '') + '</li>';
      }).join('');
    }).catch(function () { st.textContent = "Your stories can't be loaded right now."; $('tsMine').innerHTML = ''; });
  }
  function withdraw(id, btn) {
    if (!window.confirm('Withdraw your consent? The story will be taken down and not shown again.')) return;
    btn.disabled = true;
    call('foundationContentDispatch', { op: 'withdrawMine', id: id }).then(function () {
      $('tsMineStatus').textContent = 'Consent withdrawn.';
      loadMine();
    }).catch(function () { btn.disabled = false; $('tsMineStatus').textContent = "We couldn't withdraw consent right now. Please try again."; });
  }
  function syncNameField() {
    var anon = displayPref() === 'anonymous';
    $('tsNameField').hidden = anon;
    $('tsConsentName').disabled = anon; if (anon) $('tsConsentName').checked = false;
  }
  function renderShareAuth() {
    var u = currentUser(), box = $('tsAuthBox');
    box.textContent = '';
    $('tsForm').hidden = !u; $('tsMineWrap').hidden = !u;
    if (u) {
      box.hidden = true;
      if (!$('tsName').value && u.displayName) $('tsName').value = u.displayName;
      return;
    }
    box.hidden = false;
    box.appendChild(document.createTextNode('Sign in to share your story — it lets you follow its review and withdraw consent at any time. '));
    var a = document.createElement('a'); a.href = loginUrl('#share'); a.textContent = 'Sign in';
    box.appendChild(a);
  }
  function bindTestimonial() {
    var form = $('tsForm');
    form.addEventListener('submit', function (ev) { ev.preventDefault(); submitTestimonial(false); });
    form.addEventListener('change', function (ev) {
      if (ev.target.id === 'tsFiles') { addFiles(ev.target.files); ev.target.value = ''; }
      if (ev.target.name === 'displayPreference') syncNameField();
    });
    form.addEventListener('click', function (ev) {
      var rm = ev.target.closest('[data-remove]');
      if (rm) { T.files.splice(Number(rm.getAttribute('data-remove')), 1); renderFiles(); $('tsFilesErr').textContent = ''; return; }
      if (ev.target.id === 'tsTextOnly') submitTestimonial(true);
    });
    $('tsMine').addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-withdraw]');
      if (b) withdraw(b.getAttribute('data-withdraw'), b);
    });
    syncNameField();
  }

  /* ── 5. TRANSPARENCY ──────────────────────────────────────────────────────────────── */
  function loadDashboard() {
    call('impactGetPublicDashboard', {}).then(function (r) {
      var b = (r && r.balance) || {};
      $('trAvail').textContent = money(b.available);
      $('trRecv').textContent = money(b.totalReceived);
      $('trOut').textContent = money(b.totalDisbursed);
      var camps = (r && Array.isArray(r.campaigns)) ? r.campaigns : [];
      $('trProgStatus').textContent = camps.length ? '' : 'No programmes are published yet.';
      /* recentActivity is deliberately NOT rendered: no donor identities on a public page. */
      $('trProgs').innerHTML = camps.map(function (c) {
        var hasBar = typeof c.goal === 'number' && c.goal > 0 && typeof c.raised === 'number' && isFinite(c.raised);
        var pct = hasBar ? Math.max(0, Math.min(100, Math.round(c.raised / c.goal * 100))) : 0;
        return '<div class="prog"><h3>' + esc(c.title || 'Programme') + '</h3>' +
          (c.description ? '<p class="muted">' + esc(c.description) + '</p>' : '') +
          '<div>Raised <b>' + esc(money(c.raised)) + '</b> of ' + esc(money(c.goal)) + '</div>' +
          (hasBar ? '<div class="bar" role="img" aria-label="' + esc(pct + '% of goal') + '"><i style="width:' + pct + '%"></i></div>' : '') +
          (c.id ? '<button type="button" class="btn btn-sm" data-support="' + esc(c.id) + '">Support this programme</button>' : '') + '</div>';
      }).join('');
    }).catch(function () {
      ['trAvail', 'trRecv', 'trOut'].forEach(function (id) { $(id).textContent = '—'; });
      $('trProgStatus').textContent = "Figures aren't available right now.";
    });
    $('transparency').addEventListener('click', function (ev) {
      var sp = ev.target.closest('[data-support]');
      if (sp) supportProgramme(sp.getAttribute('data-support'));
    });
  }

  /* ── Boot ─────────────────────────────────────────────────────────────────────────── */
  function boot() {
    bindDonation(); bindStories(); bindTestimonial();
    boot2();
  }
  var booted = false, waits = 0;
  function boot2() {
    if (booted) return;
    if (typeof window.waitForFirebaseReady !== 'function') {
      if (++waits > 30) {   /* ~12 s: Firebase never loaded — say so, never render blanks as zero */
        $('storyStatus').textContent = "Stories aren't available right now. Please check back soon.";
        $('trProgStatus').textContent = "Figures aren't available right now.";
        $('fdProgrammeNote').textContent = "Programmes can't be loaded right now — your gift will go to the general Foundation fund.";
        $('fdAuthBox').textContent = $('tsAuthBox').textContent = "Sign-in isn't available right now. Please reload the page.";
        return;
      }
      setTimeout(boot2, 400); return;
    }
    booted = true;
    loadProgrammes(); loadStories(false); loadDashboard();
    window.waitForFirebaseReady().then(function () {
      var sdk = window.firebaseSDK;
      var onAuth = function () {
        renderShareAuth();
        if (D.step === 3) renderAuthBox();
        if (currentUser()) loadMine();
      };
      if (sdk && typeof sdk.onAuthStateChanged === 'function') sdk.onAuthStateChanged(onAuth); else onAuth();
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}());
