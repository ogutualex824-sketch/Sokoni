/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniEducationLearn — the LEARNER's dashboard shell (education-learn.html), Education E2 2026-10-03
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Owner: "like merchant-v2.html with the side bar … yes lener dash also". The sidebar is the server's learner module
   answer (educationWorkspace.learner.modules): AVAILABLE opens; LOCKED says it needs an age check or a guardian link;
   NOT_IMPLEMENTED says "Soon". Nothing is inferred: access, workspaces and applications are the server's words, and an
   unanswered request shows "—". The profile view is SokoniEducation's ONE learner profile form (no second store).
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fn = function (name) { return function (data) { return G.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r.data; }); }; };
  /* sidebar = the server's LEARNER_MODULES; discover / courses leave the shell for the catalogue (like merchant-v2 exits) */
  var NAV = [
    ['Learn', [['overview', 'Overview', '🏠'], ['myLearning', 'My learning', '📖'], ['discover', 'Discover', '🔎', 'education.html'], ['courses', 'Courses', '📚', 'education.html']]],
    ['Live', [['liveClasses', 'Live classes', '🎥'], ['tutoring', 'Tutoring', '🧑‍🏫'], ['bookings', 'Bookings', '📅']]],
    ['Records', [['certificates', 'Certificates', '🎓'], ['receipts', 'Receipts', '🧾']]],
    ['Connect', [['messages', 'Messages', '💬']]],
    ['You', [['profile', 'Profile', '👤'], ['settings', 'Settings', '⚙️']]],
  ];
  var ACCESS = {
    verified_adult: 'Age verified — full access as features open.',
    guardian_linked: 'Guardian linked — full access as features open.',
    unverified: 'Free self-paced courses. Live classes, tutoring, messaging teachers and paid learning need an age check or a guardian link (Profile).',
  };
  var WS_LABEL = { teacher: 'Teacher workspace', institution: 'Institution workspace', enterprise: 'Company training' };
  var APP_LABEL = { tutor: 'Teacher application', school: 'Institution application', 'online-course': 'Institution application', 'education-enterprise': 'Company application' };
  var S = { ws: null, enrol: null, view: 'overview', course: null, lesson: null, certs: null };
  var lessonsCall = function (op, data) { return fn('courseLessons')(Object.assign({ op: op }, data || {})); };
  var STATE_LABEL = { not_started: 'Not started', in_progress: 'In progress', completed: 'Completed' };
  var $ = function (id) { return document.getElementById(id); };

  function item(key) { for (var i = 0; i < NAV.length; i++) for (var j = 0; j < NAV[i][1].length; j++) if (NAV[i][1][j][0] === key) return NAV[i][1][j]; return null; }
  function stateOf(key) {
    if (key === 'overview') return 'AVAILABLE';
    var m = S.ws && S.ws.learner && S.ws.learner.modules && S.ws.learner.modules[key];
    return (m && m.state) || 'UNKNOWN';
  }
  var TAG = { LOCKED: '🔒', NOT_IMPLEMENTED: 'Soon' };

  function renderNav() {
    var nav = $('entNav'); if (!nav) return;
    nav.innerHTML = NAV.map(function (g) {
      return '<div class="side-group">' + esc(g[0]) + '</div>' + g[1].map(function (it) {
        var st = stateOf(it[0]); var on = S.view === it[0];
        return '<button type="button" class="nav-item' + (on ? ' on' : '') + '" data-ln-nav="' + esc(it[0]) + '"' + (st === 'AVAILABLE' ? '' : ' aria-disabled="true"')
          + (on ? ' aria-current="page"' : '') + '><span class="ico" aria-hidden="true">' + it[2] + '</span><span class="lbl">' + esc(it[1]) + '</span>'
          + (st === 'AVAILABLE' ? '' : '<span class="tag">' + (TAG[st] || '—') + '</span>') + '</button>';
      }).join('');
    }).join('');
  }

  function viewOverview() {
    var ws = S.ws; var a = (ws.learner || {}).access || null;
    var spaces = (ws.dashboards || []).filter(function (d) { return d.actor !== 'learner'; }).map(function (d) {
      var l = WS_LABEL[d.actor] || '—';
      return d.state === 'AVAILABLE' && d.route ? '<a class="btn" href="' + esc(d.route) + '">' + esc(l) + ' →</a>' : '<span class="muted">' + esc(l) + ': ' + esc(d.state === 'LOCKED' ? 'suspended' : '—') + '</span>';
    }).join(' ');
    var apps = ws.applications === null ? '<p class="muted">Applications: —</p>' : (ws.applications || []).map(function (x) {
      return '<div class="row"><div><strong>' + esc(APP_LABEL[x.category] || 'Application') + '</strong> · ' + esc(x.status || '—')
        + ((x.missing || []).length ? '<br><span class="muted">SOKONI needs: ' + x.missing.map(esc).join('; ') + '</span>' : '') + '</div><a class="btn2" href="complete-application.html">Track</a></div>';
    }).join('');
    return '<div class="card"><b>Your learning access</b><p class="muted">' + esc(a && a.ageStatus ? (ACCESS[a.ageStatus] || '—') : '—') + '</p></div>'
      + (spaces ? '<div class="card"><b>Your workspaces</b><p>' + spaces + '</p></div>' : '')
      + (apps ? '<div class="card"><b>Your applications</b>' + apps + '</div>' : '')
      + '<div class="card"><b>Teach on SOKONI</b><p class="muted">Teachers, schools and training companies apply once; SOKONI checks their documents.</p><button type="button" class="btn2" data-ln-apply>Apply to teach</button></div>';
  }
  /* ── D/E: My learning → course → lesson (every view is the SERVER's learner-safe answer) ── */
  function viewMyLearning() {
    if (S.lesson) return viewLesson();
    if (S.course) return viewCourse();
    if (S.enrol === null) return '<div class="card"><p class="muted">Your courses are unavailable right now (—).</p></div>';
    var rows = S.enrol.map(function (e) {
      var c = e.course || {};
      return '<div class="row"><div><strong>' + esc(c.title || '—') + '</strong><br><span class="muted">' + esc(Math.round(Number(e.progress) || 0)) + '% complete · ' + esc(c.lessonCount || 0) + ' lessons</span></div>'
        + '<button type="button" class="btn2" data-ln-course="' + esc(e.courseId) + '">Open</button></div>';
    }).join('');
    return '<div class="card"><b>My learning</b>' + (rows || '<p class="muted">You have not enrolled in a course yet. Browse courses to start.</p>') + '</div>';
  }

  function viewCourse() {
    var c = S.course;
    if (c.error) return '<div class="card"><p class="muted">This course is unavailable right now (—). ' + esc(c.error) + '</p><button type="button" class="btn2" data-ln-back>← My learning</button></div>';
    var rows = (c.lessons || []).map(function (l, i) {
      return '<div class="row"><div><strong>' + esc((i + 1) + '. ' + l.title) + '</strong><br><span class="muted">' + esc(STATE_LABEL[l.state] || '—') + (l.durationMinutes ? ' · ' + esc(l.durationMinutes) + ' min' : '') + (l.freePreview ? ' · free preview' : '') + '</span></div>'
        + (l.locked ? '<span class="muted">🔒 Enrol to open</span>' : '<button type="button" class="btn2" data-ln-lesson="' + esc(l.lessonId) + '">Open</button>') + '</div>';
    }).join('');
    return '<div class="card"><button type="button" class="btn2" data-ln-back>← My learning</button>'
      + '<div style="font-size:18px;font-weight:800;margin:8px 0">' + esc((c.course || {}).title || '—') + '</div>'
      + '<div class="muted">' + (c.enrolled ? 'Progress: ' + esc(c.progress) + '%' : 'Not enrolled — free-preview lessons only') + '</div>'
      + (c.certificate ? '<p>🎓 Certificate ' + esc(c.certificate.serial) + ' · ' + esc(c.certificate.status === 'revoked' ? 'Revoked' : 'Issued') + '</p>' : '') + '</div>'
      + '<div class="card">' + (rows || '<p class="muted">No lessons yet.</p>') + '</div>';
  }
  function viewLesson() {
    var L = S.lesson; var c = S.course || {}; var list = c.lessons || [];
    if (L.error) return '<div class="card"><p class="muted">This lesson is unavailable (—). ' + esc(L.error) + '</p><button type="button" class="btn2" data-ln-back-course>← Lessons</button></div>';
    var l = L.lesson || {};
    var idx = list.findIndex(function (x) { return x.lessonId === l.lessonId; });
    var open = function (j) { return list[j] && !list[j].locked ? list[j].lessonId : null; };
    var prev = open(idx - 1), next = open(idx + 1);
    var me = list[idx] || {};
    return '<div class="card"><button type="button" class="btn2" data-ln-back-course>← Lessons</button>'
      + '<div style="font-size:18px;font-weight:800;margin:8px 0">' + esc(l.title || '—') + '</div>'
      + (me.description ? '<div class="muted">' + esc(me.description) + '</div>' : '') + (me.durationMinutes ? '<div class="muted">' + esc(me.durationMinutes) + ' min</div>' : '')
      + (l.body ? '<div style="white-space:pre-wrap;margin-top:10px">' + esc(l.body) + '</div>' : '')
      + (l.videoUrl ? '<p><a class="btn2" href="' + esc(l.videoUrl) + '" target="_blank" rel="noopener noreferrer">Watch the video</a></p>' : '')
      + (l.materialUrl ? '<p><a class="btn2" href="' + esc(l.materialUrl) + '" target="_blank" rel="noopener noreferrer">Open the lesson file</a> <span class="muted">(this link expires in ' + esc(l.materialExpiresInMinutes || 15) + ' min — reopen the lesson for a new one)</span></p>' : '')
      + '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px">'
      + (prev ? '<button type="button" class="btn2" data-ln-lesson="' + esc(prev) + '">← Previous</button>' : '')
      + (c.enrolled ? (me.state === 'completed' ? '<span class="muted">✓ Completed</span>' : '<button type="button" class="btn" data-ln-complete="' + esc(l.lessonId) + '">Mark complete</button>') : '')
      + (next ? '<button type="button" class="btn2" data-ln-lesson="' + esc(next) + '">Next →</button>' : '') + '</div>'
      + (L.notice ? '<p class="muted">' + esc(L.notice) + '</p>' : '') + '</div>';
  }
  /* ── F: certificates ── */
  function viewCertificates() {
    if (S.certs === null) return '<div class="card"><p class="muted">Your certificates are unavailable right now (—).</p></div>';
    var rows = (S.certs || []).map(function (c) {
      var verify = 'certificate-verify.html?serial=' + encodeURIComponent(c.serial);
      return '<div class="row"><div><strong>' + esc(c.courseTitle || '—') + '</strong><br><span class="muted">' + esc(c.serial) + ' · ' + esc(c.status === 'revoked' ? 'Revoked' : 'Issued')
        + ' · ' + esc(c.issuer || 'SOKONI Education') + (c.providerName ? ' · ' + esc(c.providerName) : '') + (c.issuedAtMs ? ' · ' + esc(new Date(c.issuedAtMs).toISOString().slice(0, 10)) : '') + '</span></div>'
        + '<a class="btn2" href="' + esc(verify) + '">Verify</a></div>';
    }).join('');
    return '<div class="card"><b>Certificates</b><p class="muted">Issued when you complete every lesson of a course. Anyone can check one with its number.</p>'
      + (rows || '<p class="muted">No certificates yet.</p>') + '</div>';
  }

  function openCourse(courseId) {
    S.view = 'myLearning'; S.lesson = null; S.course = { loading: true };
    renderView();
    return lessonsCall('learnerCourse', { courseId: courseId }).then(function (r) { S.course = r; }).catch(function (e) { S.course = { error: (e && e.message) || '' }; }).then(renderView);
  }
  function openLesson(lessonId) {
    var courseId = S.course && S.course.course && S.course.course.courseId;
    if (!courseId) return Promise.resolve();
    return lessonsCall('content', { courseId: courseId, lessonId: lessonId }).then(function (r) { S.lesson = r; })
      .catch(function (e) { S.lesson = { error: (e && e.message) || '' }; })
      /* opening marks the lesson in progress on the server — refresh the course states */
      .then(function () { return lessonsCall('learnerCourse', { courseId: courseId }).then(function (r) { S.course = r; }).catch(function () {}); })
      .then(renderView);
  }
  function complete(lessonId) {
    var courseId = S.course && S.course.course && S.course.course.courseId;
    return lessonsCall('complete', { courseId: courseId, lessonId: lessonId }).then(function (r) {
      S.lesson = Object.assign({}, S.lesson, { notice: r && r.certificateIssued ? 'Course complete — your certificate is in Certificates.' : (r && r.message) || null });
      return lessonsCall('learnerCourse', { courseId: courseId }).then(function (c) { S.course = c; });
    }).catch(function (e) { S.lesson = Object.assign({}, S.lesson, { notice: (e && e.message) || 'Could not record completion.' }); }).then(renderView);
  }

  function renderView() {
    var root = $('entRoot'); if (!root) return;
    var key = S.view; var it = item(key); var st = stateOf(key);
    if ($('entTitle')) $('entTitle').textContent = it ? it[1] : 'My learning';
    if (st !== 'AVAILABLE') {
      root.innerHTML = '<div class="card"><b>' + esc(it ? it[1] : '—') + '</b><p class="muted">' + (st === 'LOCKED' ? 'This needs an age check or a guardian link — see Profile.' : st === 'NOT_IMPLEMENTED' ? 'Coming soon.' : 'Unavailable (—).') + '</p></div>';
      return;
    }
    if (key === 'myLearning') { root.innerHTML = S.course && S.course.loading ? '<div class="card"><p class="muted">Loading…</p></div>' : viewMyLearning(); return; }
    if (key === 'certificates') {
      if (S.certs === undefined || S.certs === 'loading') { root.innerHTML = '<div class="card"><p class="muted">Loading…</p></div>'; return; }
      root.innerHTML = viewCertificates(); return;
    }
    if (key === 'profile') {
      root.innerHTML = '<div class="card"><section id="eduLearnerProfile" aria-label="My learner profile"></section></div>';
      if (G.SokoniEducation && G.SokoniEducation.loadLearnerProfile) G.SokoniEducation.loadLearnerProfile();
      return;
    }
    root.innerHTML = viewOverview();
  }

  function go(key) {
    var it = item(key); if (!it) return;
    if (stateOf(key) !== 'AVAILABLE') { S.view = key; renderNav(); renderView(); drawer(false); return; }   /* shows WHY, opens nothing */
    if (it[3]) { G.location.href = it[3]; return; }   /* catalogue exits */
    S.view = key; renderNav(); renderView(); drawer(false);
    try { G.history && G.history.replaceState && G.history.replaceState(null, '', '#' + key); } catch (_) {}
  }
  function drawer(open) {
    var side = $('entSide'), scrim = $('entScrim'), btn = $('entMenu');
    if (side) side.classList[open ? 'add' : 'remove']('open');
    if (scrim) scrim.classList[open ? 'add' : 'remove']('on');
    if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function load() {
    return fn('educationWorkspace')({}).then(function (ws) {
      S.ws = ws || null;
      if (!S.ws) throw new Error('empty');
      var a = (S.ws.learner || {}).access;
      if ($('entSub')) $('entSub').textContent = a && a.ageStatus === 'verified_adult' ? 'Age verified' : a && a.ageStatus === 'guardian_linked' ? 'Guardian linked' : a ? 'Self-paced access' : '—';
      return fn('getMyEnrollments')({}).then(function (r) { S.enrol = (r && r.enrollments) || []; }).catch(function () { S.enrol = null; });
    }).then(function () {
      var h = String((G.location && G.location.hash) || '').replace('#', '');
      if (h && item(h) && !item(h)[3]) S.view = h;
      renderNav(); renderView();
    }).catch(function () {
      S.ws = null;
      if ($('entNav')) $('entNav').innerHTML = '';
      if ($('entSub')) $('entSub').textContent = '—';
      $('entRoot').innerHTML = '<div class="card"><p>Your learning dashboard is unavailable right now (—).</p></div>';
    });
  }

  function onClick(ev) {
    var t = ev.target; if (!t || !t.closest) return;
    var nv = t.closest('[data-ln-nav]');
    if (nv) {
      var k = nv.getAttribute('data-ln-nav'); S.course = null; S.lesson = null;
      if (k === 'certificates' && stateOf('certificates') === 'AVAILABLE') {
        S.certs = 'loading';
        lessonsCall('myCertificates').then(function (r) { S.certs = (r && r.certificates) || []; }).catch(function () { S.certs = null; }).then(renderView);
      }
      go(k); return;
    }
    var oc = t.closest('[data-ln-course]'); if (oc) { openCourse(oc.getAttribute('data-ln-course')); return; }
    var ol = t.closest('[data-ln-lesson]'); if (ol) { openLesson(ol.getAttribute('data-ln-lesson')); return; }
    var cp = t.closest('[data-ln-complete]'); if (cp) { cp.disabled = true; complete(cp.getAttribute('data-ln-complete')); return; }
    if (t.closest('[data-ln-back]')) { S.course = null; S.lesson = null; renderView(); return; }
    if (t.closest('[data-ln-back-course]')) { S.lesson = null; renderView(); return; }
    if (t.closest('[data-ln-apply]')) { if (G.HubRegister) G.HubRegister.open({ hub: 'education', category: 'tutor' }); else G.location.href = 'complete-application.html'; }
  }

  function init() {
    document.body.addEventListener('click', onClick);
    var m = $('entMenu'); if (m) m.addEventListener('click', function () { drawer(!$('entSide').classList.contains('open')); });
    var sc = $('entScrim'); if (sc) sc.addEventListener('click', function () { drawer(false); });
    G.firebase.auth().onAuthStateChanged(function (u) {
      if (!u) { if ($('entNav')) $('entNav').innerHTML = ''; $('entRoot').innerHTML = '<div class="card"><p>Sign in to see your learning.</p><a class="btn" href="login.html?return=education-learn.html">Sign in</a></div>'; return; }
      load();
    });
  }
  G.SokoniEducationLearn = { init: init, go: go, openCourse: openCourse, openLesson: openLesson, complete: complete, _state: S, _load: load, _renderView: renderView };
})(typeof window !== 'undefined' ? window : this);
