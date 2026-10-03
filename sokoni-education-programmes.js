/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniEducationProgrammes — the institution's Programmes workspace on provider-dashboard (Education E2, 2026-10-03)
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: functions/education-programmes.js manageMyProgrammes (approved INSTITUTION only — the business
   workspace makes eduProgrammes AVAILABLE; a teacher never sees it). A programme groups the institution's OWN courses
   (picked from manageMyCourses list — the server re-checks ownership); "active" needs a published course. This module
   renders and calls; nothing says "saved / active" until the server answered.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var fn = function (name) { return function (data) { return G.firebase.functions().httpsCallable(name)(data || {}).then(function (r) { return r.data; }); }; };
  var prog = function (op, data) { return fn('manageMyProgrammes')(Object.assign({ op: op }, data || {})); };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };
  var LEVELS = [['certificate', 'Certificate'], ['diploma', 'Diploma'], ['degree', 'Degree'], ['short_course', 'Short course'], ['cbc', 'CBC'], ['other', 'Other']];
  var STATUS = { draft: 'Draft', active: 'Active' };
  var inputCss = 'width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:8px;padding:9px;margin:4px 0 8px';
  var btnCss = 'background:#71ff00;color:#000;border:0;border-radius:9px;padding:9px 14px;font-weight:800;cursor:pointer';
  var btn2Css = 'background:#222;color:#eee;border:1px solid #333;border-radius:9px;padding:8px 12px;cursor:pointer';
  var _el = null, _progs = [], _courses = [];

  function courseTitle(id) { var c = _courses.filter(function (x) { return x.courseId === id; })[0]; return c ? c.title : '—'; }

  function form(p) {
    p = p || {};
    var picked = p.courseIds || [];
    var boxes = _courses.map(function (c) {
      return '<label style="display:block;font-size:13px"><input type="checkbox" data-pc value="' + esc(c.courseId) + '"' + (picked.indexOf(c.courseId) >= 0 ? ' checked' : '') + '> '
        + esc(c.title) + ' <span style="opacity:.6">(' + esc(c.status === 'published' ? 'published' : c.status === 'pending_review' ? 'in review' : 'draft') + ')</span></label>';
    }).join('') || '<div style="opacity:.65;font-size:13px">Create courses first (Courses).</div>';
    return '<div data-pg-form="' + esc(p.programmeId || '') + '" style="border:1px solid #2a2a2a;border-radius:12px;padding:14px;margin:10px 0">'
      + '<div style="font-weight:800;margin-bottom:6px">' + (p.programmeId ? 'Edit programme' : 'New programme') + '</div>'
      + '<label>Title<input data-f="title" maxlength="120" style="' + inputCss + '" value="' + esc(p.title || '') + '"></label>'
      + '<label>Level<select data-f="level" style="' + inputCss + '">' + LEVELS.map(function (l) { return '<option value="' + l[0] + '"' + (l[0] === (p.level || 'certificate') ? ' selected' : '') + '>' + l[1] + '</option>'; }).join('') + '</select></label>'
      + '<label>Duration (weeks)<input data-f="durationWeeks" type="number" min="0" max="520" style="' + inputCss + '" value="' + esc(p.durationWeeks || '') + '"></label>'
      + '<div style="font-size:12px;opacity:.7;margin-top:4px">Your courses in this programme</div>' + boxes
      + '<div data-pg-err style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<button type="button" data-pg-save style="' + btnCss + '">Save</button> <button type="button" data-pg-cancel style="' + btn2Css + '">Cancel</button></div>';
  }

  function render() {
    if (!_el) return;
    var rows = _progs.map(function (p) {
      var toggle = p.status === 'active'
        ? '<button type="button" data-pg-status="draft" data-pg-id="' + esc(p.programmeId) + '" style="' + btn2Css + '">Deactivate</button>'
        : '<button type="button" data-pg-status="active" data-pg-id="' + esc(p.programmeId) + '" style="' + btnCss + '">Activate</button>';
      return '<div style="border-bottom:1px solid #222;padding:10px 0"><div style="font-weight:700">' + esc(p.title) + '</div>'
        + '<div style="font-size:12px;opacity:.7">' + esc(STATUS[p.status] || '—') + ' · ' + esc((p.courseIds || []).length) + ' courses'
        + ((p.courseIds || []).length ? ': ' + (p.courseIds || []).map(function (id) { return esc(courseTitle(id)); }).join(', ') : '') + '</div>'
        + '<div style="margin-top:6px"><button type="button" data-pg-edit="' + esc(p.programmeId) + '" style="' + btn2Css + '">Edit</button> ' + toggle + '</div></div>';
    }).join('');
    _el.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><div style="font-size:13px;opacity:.75">' + _progs.length + ' programme' + (_progs.length === 1 ? '' : 's') + '</div>'
      + '<button type="button" data-pg-new style="' + btnCss + '">+ New programme</button></div><div data-pg-formslot></div>'
      + (rows || '<div style="opacity:.65;padding:14px 0">No programmes yet. A programme groups your courses; it goes live once it includes a published course.</div>');
  }

  function load() {
    if (!_el) return Promise.resolve();
    _el.innerHTML = '<div style="opacity:.65">Loading your programmes…</div>';
    return Promise.all([prog('list'), fn('manageMyCourses')({ op: 'list' }).catch(function () { return { courses: [] }; })])
      .then(function (r) { _progs = (r[0] && r[0].programmes) || []; _courses = (r[1] && r[1].courses) || []; render(); })
      .catch(function (e) { _el.innerHTML = '<div style="opacity:.75">Your programmes are unavailable right now (—). ' + esc(errText(e)) + '</div>'; });
  }

  function onClick(e) {
    var t = e.target; if (!t || !t.closest) return;
    var slot = _el.querySelector('[data-pg-formslot]');
    if (t.closest('[data-pg-new]')) { slot.innerHTML = form(null); return; }
    var ed = t.closest('[data-pg-edit]');
    if (ed) { var id = ed.getAttribute('data-pg-edit'); slot.innerHTML = form(_progs.filter(function (x) { return x.programmeId === id; })[0]); return; }
    if (t.closest('[data-pg-cancel]')) { slot.innerHTML = ''; return; }
    var sv = t.closest('[data-pg-save]');
    if (sv) {
      var box = sv.closest('[data-pg-form]'); var pid = box.getAttribute('data-pg-form'); var err = box.querySelector('[data-pg-err]');
      var v = function (k) { var x = box.querySelector('[data-f="' + k + '"]'); return x ? x.value : ''; };
      var ids = Array.prototype.map.call(box.querySelectorAll('input[data-pc]:checked') || [], function (x) { return x.value; });
      var data = { title: v('title').trim(), level: v('level'), durationWeeks: Number(v('durationWeeks')) || 0, courseIds: ids };
      sv.disabled = true;
      (pid ? prog('update', { programmeId: pid, programme: data }) : prog('create', { programme: data }))
        .then(function () { slot.innerHTML = ''; return load(); })
        .catch(function (x) { sv.disabled = false; err.textContent = errText(x); });
      return;
    }
    var st = t.closest('[data-pg-status]');
    if (st) {
      st.disabled = true;
      prog('setStatus', { programmeId: st.getAttribute('data-pg-id'), status: st.getAttribute('data-pg-status') }).then(load)
        .catch(function (x) { st.disabled = false; G.alert && G.alert(errText(x)); });
    }
  }

  function mount(el) {
    if (!el) return;
    if (_el !== el) { _el = el; el.addEventListener('click', onClick); }
    return load();
  }
  G.SokoniEducationProgrammes = { mount: mount };
})(typeof window !== 'undefined' ? window : this);
