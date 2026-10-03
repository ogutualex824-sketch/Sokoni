/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniEducationCourses — the educator's Courses workspace on provider-dashboard (Education E2, 2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: functions/education.js — manageMyCourses (list OWN courses, edit OWN drafts), createCourse and
   publishCourse {action:'submit'}. Shown only when the business workspace answers eduCourses AVAILABLE (an approved
   teacher / institution — server type, never this page). This module renders and calls; it never decides a status,
   an owner or a price. Nothing says "submitted" / "saved" until the server answered.
     mount(el)   list + create + edit a draft + submit for review
   Paid enrolment stays OFF platform-wide (owner): a price can be set, learners see "Paid enrolment coming soon".
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fn = function (name) { return function (data) { return G.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r.data; }); }; };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };
  var STATUS = { draft: 'Draft', pending_review: 'In review', published: 'Published' };
  var CATS = [['technology', 'Technology'], ['business', 'Business'], ['design', 'Design'], ['marketing', 'Marketing'], ['personal-development', 'Personal development'],
    ['language', 'Language'], ['arts', 'Arts'], ['health', 'Health'], ['cooking', 'Cooking'], ['music', 'Music'], ['other', 'Other']];
  var LEVELS = [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']];
  var inputCss = 'width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:8px;padding:9px;margin:4px 0 8px';
  var btnCss = 'background:#71ff00;color:#000;border:0;border-radius:9px;padding:9px 14px;font-weight:800;cursor:pointer';
  var btn2Css = 'background:#222;color:#eee;border:1px solid #333;border-radius:9px;padding:8px 12px;cursor:pointer';
  var _el = null, _courses = [];

  function opts(list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? ' selected' : '') + '>' + esc(o[1]) + '</option>'; }).join(''); }

  function form(c) {
    c = c || {};
    return '<div data-edu-form="' + esc(c.courseId || '') + '" style="border:1px solid #2a2a2a;border-radius:12px;padding:14px;margin:10px 0">'
      + '<div style="font-weight:800;margin-bottom:6px">' + (c.courseId ? 'Edit draft' : 'New course') + '</div>'
      + '<label>Title<input data-f="title" maxlength="100" style="' + inputCss + '" value="' + esc(c.title || '') + '"></label>'
      + '<label>Description<textarea data-f="description" rows="3" maxlength="3000" style="' + inputCss + '">' + esc(c.description || '') + '</textarea></label>'
      + '<label>Category<select data-f="category" style="' + inputCss + '">' + opts(CATS, c.category || 'other') + '</select></label>'
      + '<label>Level<select data-f="level" style="' + inputCss + '">' + opts(LEVELS, c.level || 'beginner') + '</select></label>'
      + '<label>Number of lessons<input data-f="lessonCount" type="number" min="1" max="500" style="' + inputCss + '" value="' + esc(c.lessonCount || 1) + '"></label>'
      + '<label>Price (KES, 0 = free)<input data-f="price" type="number" min="0" style="' + inputCss + '" value="' + esc(c.price || 0) + '"></label>'
      + '<div style="font-size:12px;opacity:.65">Paid enrolment opens when SOKONI switches on Education payments. Until then learners see the price and "coming soon".</div>'
      + '<div data-edu-err style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<button type="button" data-edu-save style="' + btnCss + '">' + (c.courseId ? 'Save draft' : 'Create draft') + '</button> '
      + '<button type="button" data-edu-cancel style="' + btn2Css + '">Cancel</button></div>';
  }

  function read(box) {
    var v = function (k) { var e = box.querySelector('[data-f="' + k + '"]'); return e ? e.value : ''; };
    return { title: v('title').trim(), description: v('description').trim(), category: v('category'), level: v('level'),
      lessonCount: Number(v('lessonCount')) || 1, price: Number(v('price')) || 0 };
  }

  function render() {
    if (!_el) return;
    var rows = _courses.map(function (c) {
      var actions = (c.status === 'draft'
        ? '<button type="button" data-edu-edit="' + esc(c.courseId) + '" style="' + btn2Css + '">Edit</button> <button type="button" data-edu-submit="' + esc(c.courseId) + '" style="' + btnCss + '">Submit for review</button> '
        : '') + '<button type="button" data-edu-lessons="' + esc(c.courseId) + '" style="' + btn2Css + '">Lessons</button>';
      return '<div style="border-bottom:1px solid #222;padding:10px 0"><div style="font-weight:700">' + esc(c.title) + '</div>'
        + '<div style="font-size:12px;opacity:.7">' + esc(STATUS[c.status] || '—') + ' · ' + esc(c.lessonCount || 0) + ' lessons · ' + esc(c.enrollmentCount || 0) + ' learners'
        + (c.price > 0 ? ' · KES ' + esc(Number(c.price).toLocaleString('en-KE')) : ' · Free') + '</div>'
        + (c.reviewNote ? '<div style="font-size:12px;color:#ffb347">SOKONI review note: ' + esc(c.reviewNote) + '</div>' : '')
        + '<div style="margin-top:6px">' + actions + '</div></div>';
    }).join('');
    _el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:13px;opacity:.75">' + _courses.length + ' course' + (_courses.length === 1 ? '' : 's') + '</div>'
      + '<button type="button" data-edu-new style="' + btnCss + '">+ New course</button></div><div data-edu-formslot></div>'
      + (rows || '<div style="opacity:.65;padding:14px 0">No courses yet. Create a draft, then submit it — SOKONI reviews every course before learners can see it.</div>');
  }

  function load() {
    if (!_el) return Promise.resolve();
    _el.innerHTML = '<div style="opacity:.65">Loading your courses…</div>';
    return fn('manageMyCourses')({ op: 'list' }).then(function (r) { _courses = (r && r.courses) || []; render(); })
      .catch(function (e) { _el.innerHTML = '<div style="opacity:.75">Your courses are unavailable right now (—). ' + esc(errText(e)) + '</div>'; });
  }

  function onClick(e) {
    var t = e.target; if (!t || !t.closest) return;
    var slot = _el.querySelector('[data-edu-formslot]');
    if (t.closest('[data-edu-new]')) { slot.innerHTML = form(null); return; }
    var ed = t.closest('[data-edu-edit]');
    if (ed) { var id = ed.getAttribute('data-edu-edit'); var c = _courses.filter(function (x) { return x.courseId === id; })[0]; slot.innerHTML = form(c); return; }
    if (t.closest('[data-edu-cancel]')) { slot.innerHTML = ''; return; }
    var sv = t.closest('[data-edu-save]');
    if (sv) {
      var box = sv.closest('[data-edu-form]'); var cid = box.getAttribute('data-edu-form'); var err = box.querySelector('[data-edu-err]');
      var data = read(box); sv.disabled = true; sv.textContent = 'Saving…';
      var p = cid ? fn('manageMyCourses')({ op: 'update', courseId: cid, course: data }) : fn('createCourse')(data);
      p.then(function () { slot.innerHTML = ''; return load(); })
        .catch(function (x) { sv.disabled = false; sv.textContent = cid ? 'Save draft' : 'Create draft'; err.textContent = errText(x); });
      return;
    }
    /* Lessons: the lesson editor (sokoni-education-lessons.js) takes over this panel; "← Courses" returns */
    var ls = t.closest('[data-edu-lessons]');
    if (ls && G.SokoniEducationLessons) {
      var lc = _courses.filter(function (x) { return x.courseId === ls.getAttribute('data-edu-lessons'); })[0];
      if (lc) G.SokoniEducationLessons.mount(_el, lc, function () { load(); });
      return;
    }
    var sb = t.closest('[data-edu-submit]');
    if (sb) {
      sb.disabled = true; sb.textContent = 'Submitting…';
      fn('publishCourse')({ courseId: sb.getAttribute('data-edu-submit'), action: 'submit' }).then(load)
        .catch(function (x) { sb.disabled = false; sb.textContent = 'Submit for review'; G.alert && G.alert(errText(x)); });
    }
  }

  function mount(el) {
    if (!el) return;
    if (_el !== el) { _el = el; el.addEventListener('click', onClick); }
    return load();
  }

  G.SokoniEducationCourses = { mount: mount, _render: render, _setCourses: function (c) { _courses = c || []; } };
})(typeof window !== 'undefined' ? window : this);
