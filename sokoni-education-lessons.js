/* ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   SokoniEducationLessons — the educator's lesson editor (Courses → a course → Lessons), Education E2 2026-10-03
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════
   Server authority: functions/education-lessons.js courseLessons (list / save / setLessonStatus / remove / reorder /
   revisionSummary / submitRevision / uploadTarget / content{version}). This module renders the SERVER's state and
   offers only the actions the server's state machine allows; it never decides a status, a path or what learners see.
     • Draft course: lessons save as written; the course is reviewed on submit (Courses list).
     • Live course (owner rule): new / edited / republished lessons and reorders are STAGED; "Submit changes" shows the
       server's change summary, then freezes the course for SOKONI review. Unpublish is immediate.
     • Uploads: the SERVER names the destination (uploadTarget); the file goes to the educator's own folder; the lesson
       stores only the storage path.
   ═══════════════════════════════════════════════════════════════════════════════════════════════════════════════════ */
(function (G) {
  'use strict';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var call = function (op, data) { return G.firebase.functions().httpsCallable('courseLessons')(Object.assign({ op: op }, data || {})).then(function (r) { return r.data; }); };
  var errText = function (e) { return (e && e.message) || 'Something went wrong — please try again.'; };
  var SDK = 'https://www.gstatic.com/firebasejs/10.12.2/';
  var STATUS = { draft: 'Draft', published: 'Published', unpublished: 'Unpublished' };
  var inputCss = 'width:100%;box-sizing:border-box;background:#1a1a1a;border:1px solid #333;color:#eee;border-radius:8px;padding:9px;margin:4px 0 8px';
  var btnCss = 'background:#71ff00;color:#000;border:0;border-radius:9px;padding:8px 13px;font-weight:800;cursor:pointer';
  var btn2Css = 'background:#222;color:#eee;border:1px solid #333;border-radius:9px;padding:7px 11px;cursor:pointer';
  var S = { el: null, course: null, data: null };

  function locked() { return !!(S.data && S.data.revisionPending); }
  function live() { return S.course && S.course.status === 'published'; }
  function editable() { return S.course && (S.course.status === 'draft' || S.course.status === 'published') && !locked(); }

  function header() {
    var c = S.course || {}; var d = S.data || {};
    var staged = (d.lessons || []).filter(function (l) { return l.stagedForReview || l.hasPendingRevision; }).length;
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap"><div>'
      + '<button type="button" data-ls-back style="' + btn2Css + '">← Courses</button> '
      + '<strong style="font-size:15px">' + esc(c.title || '—') + '</strong> <span style="opacity:.7;font-size:12px">' + esc(c.status === 'published' ? 'Live' : c.status === 'pending_review' ? 'In review' : 'Draft') + ' · ' + esc((d.lessons || []).length) + ' lessons</span></div>'
      + (editable() ? '<button type="button" data-ls-new style="' + btnCss + '">+ Add lesson</button>' : '') + '</div>'
      + (locked() ? '<div style="margin:8px 0;padding:8px 10px;border:1px solid #444;border-radius:10px;font-size:13px">Changes are under review. Editing is temporarily locked.</div>' : '')
      + (d.revisionNote ? '<div style="margin:8px 0;padding:8px 10px;border:1px solid #ffb347;border-radius:10px;font-size:13px;color:#ffb347">SOKONI review: ' + esc(d.revisionNote) + '</div>' : '')
      + (live() && !locked() && staged ? '<div style="margin:8px 0;display:flex;gap:8px;align-items:center;flex-wrap:wrap"><span style="font-size:13px">' + staged + ' change' + (staged === 1 ? '' : 's') + ' waiting to be submitted — learners still see the reviewed version.</span><button type="button" data-ls-submit style="' + btnCss + '">Submit changes for review</button></div>' : '')
      + (S.course && S.course.status === 'pending_review' ? '<div style="margin:8px 0;font-size:13px;opacity:.8">This course is in SOKONI review. Lessons can be changed once it is reviewed.</div>' : '');
  }

  function row(l, i, n) {
    var acts = [];
    acts.push('<button type="button" data-ls-preview="' + esc(l.lessonId) + '" style="' + btn2Css + '">Preview</button>');
    if (l.stagedForReview || l.hasPendingRevision) acts.push('<button type="button" data-ls-preview-pending="' + esc(l.lessonId) + '" style="' + btn2Css + '">Preview changes</button>');
    if (editable()) {
      acts.push('<button type="button" data-ls-edit="' + esc(l.lessonId) + '" style="' + btn2Css + '">Edit</button>');
      if (i > 0) acts.push('<button type="button" data-ls-up="' + esc(l.lessonId) + '" aria-label="Move up" style="' + btn2Css + '">↑</button>');
      if (i < n - 1) acts.push('<button type="button" data-ls-down="' + esc(l.lessonId) + '" aria-label="Move down" style="' + btn2Css + '">↓</button>');
      if (live() && l.status === 'published') acts.push('<button type="button" data-ls-status="unpublished" data-ls-id="' + esc(l.lessonId) + '" style="' + btn2Css + '">Unpublish</button>');
      if (live() && l.status !== 'published' && !l.stagedForReview) acts.push('<button type="button" data-ls-status="published" data-ls-id="' + esc(l.lessonId) + '" style="' + btn2Css + '">Publish (via review)</button>');
      if (!live() || l.status !== 'published') acts.push('<button type="button" data-ls-remove="' + esc(l.lessonId) + '" style="' + btn2Css + '">Delete</button>');
    }
    var flags = [];
    if (l.stagedForReview) flags.push('waiting for review');
    if (l.hasPendingRevision) flags.push('edited — pending review');
    if (l.freePreview) flags.push('free preview');
    if (l.materialPath) flags.push('📎 material');
    return '<div style="border-bottom:1px solid #222;padding:10px 0"><div style="font-weight:700">' + esc((i + 1) + '. ' + l.title) + '</div>'
      + '<div style="font-size:12px;opacity:.7">' + esc(STATUS[l.status] || '—') + ' · v' + esc(l.version || 1) + (l.durationMinutes ? ' · ' + esc(l.durationMinutes) + ' min' : '') + (flags.length ? ' · ' + esc(flags.join(' · ')) : '') + '</div>'
      + (l.reviewNote ? '<div style="font-size:12px;color:#ffb347">Review note: ' + esc(l.reviewNote) + '</div>' : '')
      + '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + acts.join('') + '</div></div>';
  }

  function form(l) {
    l = l || {};
    var kind = l.kind || 'text';
    return '<div data-ls-form="' + esc(l.lessonId || '') + '" style="border:1px solid #2a2a2a;border-radius:12px;padding:14px;margin:10px 0">'
      + '<div style="font-weight:800;margin-bottom:6px">' + (l.lessonId ? 'Edit lesson' : 'New lesson') + '</div>'
      + (live() ? '<div style="font-size:12px;opacity:.75;margin-bottom:6px">This course is live: your changes are saved for review and learners keep the current version until SOKONI approves them.</div>' : '')
      + '<label>Title<input data-f="title" maxlength="140" style="' + inputCss + '" value="' + esc(l.title || '') + '"></label>'
      + '<label>Description<textarea data-f="description" rows="2" maxlength="600" style="' + inputCss + '">' + esc(l.description || '') + '</textarea></label>'
      + '<label>Type<select data-f="kind" style="' + inputCss + '"><option value="text"' + (kind === 'text' ? ' selected' : '') + '>Text</option><option value="video"' + (kind === 'video' ? ' selected' : '') + '>Video (YouTube / Vimeo link)</option><option value="file"' + (kind === 'file' ? ' selected' : '') + '>File</option></select></label>'
      + '<label>Duration (minutes)<input data-f="durationMinutes" type="number" min="0" max="1440" style="' + inputCss + '" value="' + esc(l.durationMinutes || '') + '"></label>'
      + '<label>Lesson content<textarea data-f="body" rows="5" maxlength="20000" style="' + inputCss + '">' + esc(l.body || '') + '</textarea></label>'
      + '<label>Video link (https YouTube / Vimeo)<input data-f="videoUrl" maxlength="300" style="' + inputCss + '" value="' + esc(l.videoUrl || '') + '"></label>'
      + '<div style="font-size:13px;margin-top:4px">Material ' + (l.materialPath ? '<span style="opacity:.7">(attached)</span>' : '') + '</div>'
      + '<input type="file" data-ls-file accept=".pdf,.png,.jpg,.jpeg,.webp,.docx,.pptx,.xlsx,.txt" style="margin:6px 0">'
      + '<div data-ls-upload style="font-size:12px;opacity:.75"></div>'
      + '<input type="hidden" data-f="materialPath" value="' + esc(l.materialPath || '') + '">'
      + '<label style="display:block;font-size:13px;margin:6px 0"><input type="checkbox" data-f="freePreview"' + (l.freePreview ? ' checked' : '') + '> Free preview (anyone may open this lesson)</label>'
      + '<label style="display:block;font-size:13px;margin:6px 0"><input type="checkbox" data-f="publish"' + (l.status === 'published' ? ' checked' : '') + '> ' + (live() ? 'Publish after review' : 'Published when the course is approved') + '</label>'
      + '<div data-ls-err style="color:#ff6b6b;font-size:12px;min-height:16px"></div>'
      + '<button type="button" data-ls-save style="' + btnCss + '">Save</button> <button type="button" data-ls-cancel style="' + btn2Css + '">Cancel</button></div>';
  }

  function render() {
    if (!S.el) return;
    var ls = (S.data && S.data.lessons) || [];
    S.el.innerHTML = header() + '<div data-ls-slot></div><div data-ls-preview-slot></div>'
      + (ls.length ? ls.map(function (l, i) { return row(l, i, ls.length); }).join('') : '<div style="opacity:.65;padding:12px 0">No lessons yet.</div>');
  }

  function load() {
    S.el.innerHTML = '<div style="opacity:.65">Loading lessons…</div>';
    return call('list', { courseId: S.course.courseId }).then(function (d) { S.data = d; render(); })
      .catch(function (e) { S.el.innerHTML = '<div style="opacity:.75">Lessons are unavailable right now (—). ' + esc(errText(e)) + '</div>'; });
  }

  /* upload: ask the SERVER for the destination, then put the bytes there (the educator's own folder) — no download URL */
  function upload(box, file) {
    var out = box.querySelector('[data-ls-upload]');
    out.textContent = 'Checking ' + file.name + '…';
    return call('uploadTarget', { courseId: S.course.courseId, fileName: file.name, contentType: file.type, size: file.size }).then(function (t) {
      out.textContent = 'Uploading ' + file.name + ' (' + Math.ceil(file.size / 1024) + ' KB)…';
      return import(SDK + 'firebase-storage.js').then(function (st) {
        var ref = st.ref(G.firebaseStorage, t.path);
        return st.uploadBytes(ref, file, { contentType: t.contentType }).then(function () {
          box.querySelector('[data-f="materialPath"]').value = t.path;
          out.textContent = 'Uploaded ' + file.name + '. Save the lesson to attach it.';
        });
      });
    }).catch(function (e) { out.textContent = errText(e); });
  }

  function readForm(box) {
    var v = function (k) { var x = box.querySelector('[data-f="' + k + '"]'); return x ? x.value : ''; };
    var chk = function (k) { var x = box.querySelector('[data-f="' + k + '"]'); return !!(x && x.checked); };
    return { title: v('title').trim(), description: v('description').trim(), kind: v('kind'), durationMinutes: Number(v('durationMinutes')) || 0,
      body: v('body'), videoUrl: v('videoUrl').trim() || null, materialPath: v('materialPath') || null, freePreview: chk('freePreview'), status: chk('publish') ? 'published' : 'draft' };
  }

  function showPreview(r) {
    var slot = S.el.querySelector('[data-ls-preview-slot]'); var l = r.lesson || {};
    slot.innerHTML = '<div style="border:1px solid ' + (r.preview === 'pending' ? '#ffb347' : '#2a2a2a') + ';border-radius:12px;padding:14px;margin:10px 0">'
      + '<div style="font-size:12px;font-weight:800;color:' + (r.preview === 'pending' ? '#ffb347' : '#71ff00') + '">' + esc(r.preview === 'pending' ? (r.notice || 'Previewing pending changes — learners cannot see these changes yet.') : 'Preview — what learners see now') + '</div>'
      + '<div style="font-weight:800;margin:6px 0">' + esc(l.title) + '</div>' + (l.description ? '<div style="opacity:.8;font-size:13px">' + esc(l.description) + '</div>' : '')
      + (l.body ? '<div style="white-space:pre-wrap;font-size:14px;margin-top:8px">' + esc(l.body) + '</div>' : '')
      + (l.videoUrl ? '<div style="margin-top:8px"><a href="' + esc(l.videoUrl) + '" target="_blank" rel="noopener noreferrer">Open video</a></div>' : '')
      + (l.materialUrl ? '<div style="margin-top:8px"><a href="' + esc(l.materialUrl) + '" target="_blank" rel="noopener noreferrer">Open material</a> <span style="opacity:.6;font-size:12px">(link expires in ' + esc(l.materialExpiresInMinutes || 15) + ' min)</span></div>' : '')
      + '<div style="margin-top:8px"><button type="button" data-ls-close-preview style="' + btn2Css + '">Close preview</button></div></div>';
  }

  function onClick(e) {
    var t = e.target; if (!t || !t.closest || !S.el || !S.el.contains(t)) return;
    var slot = S.el.querySelector('[data-ls-slot]');
    var lessons = (S.data && S.data.lessons) || [];
    var find = function (id) { return lessons.filter(function (x) { return x.lessonId === id; })[0]; };
    var q = function (sel) { return t.closest(sel); };
    if (q('[data-ls-back]')) { if (S.onBack) S.onBack(); return; }
    if (q('[data-ls-new]')) { slot.innerHTML = form(null); return; }
    if (q('[data-ls-cancel]')) { slot.innerHTML = ''; return; }
    if (q('[data-ls-close-preview]')) { S.el.querySelector('[data-ls-preview-slot]').innerHTML = ''; return; }
    var ed = q('[data-ls-edit]'); if (ed) { slot.innerHTML = form(find(ed.getAttribute('data-ls-edit'))); return; }
    var pv = q('[data-ls-preview]') || q('[data-ls-preview-pending]');
    if (pv) {
      var pending = !!q('[data-ls-preview-pending]');
      var id = pv.getAttribute(pending ? 'data-ls-preview-pending' : 'data-ls-preview');
      call('content', Object.assign({ courseId: S.course.courseId, lessonId: id }, pending ? { version: 'pending' } : {})).then(showPreview).catch(function (x) { G.alert && G.alert(errText(x)); });
      return;
    }
    var sv = q('[data-ls-save]');
    if (sv) {
      var box = sv.closest('[data-ls-form]'); var lid = box.getAttribute('data-ls-form'); var err = box.querySelector('[data-ls-err]');
      sv.disabled = true;
      call('save', Object.assign({ courseId: S.course.courseId, lesson: readForm(box) }, lid ? { lessonId: lid } : {}))
        .then(function () { slot.innerHTML = ''; return load(); })
        .catch(function (x) { sv.disabled = false; err.textContent = errText(x); });
      return;
    }
    var st = q('[data-ls-status]');
    if (st) { st.disabled = true; call('setLessonStatus', { courseId: S.course.courseId, lessonId: st.getAttribute('data-ls-id'), status: st.getAttribute('data-ls-status') }).then(load).catch(function (x) { st.disabled = false; G.alert && G.alert(errText(x)); }); return; }
    var rm = q('[data-ls-remove]');
    if (rm) { if (G.confirm && !G.confirm('Delete this lesson?')) return; rm.disabled = true; call('remove', { courseId: S.course.courseId, lessonId: rm.getAttribute('data-ls-remove') }).then(load).catch(function (x) { rm.disabled = false; G.alert && G.alert(errText(x)); }); return; }
    var up = q('[data-ls-up]'), dn = q('[data-ls-down]');
    if (up || dn) {
      var ids = lessons.map(function (x) { return x.lessonId; });
      var mid = (up || dn).getAttribute(up ? 'data-ls-up' : 'data-ls-down'); var i = ids.indexOf(mid); var j = up ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= ids.length) return;
      var tmp = ids[i]; ids[i] = ids[j]; ids[j] = tmp;
      call('reorder', { courseId: S.course.courseId, order: ids }).then(load).catch(function (x) { G.alert && G.alert(errText(x)); });
      return;
    }
    if (q('[data-ls-submit]')) {
      call('revisionSummary', { courseId: S.course.courseId }).then(function (r) {
        var m = r.summary || {};
        var text = 'Submit these changes for SOKONI review?\n\n' + (m.newLessons || 0) + ' new lesson(s)\n' + (m.editedLessons || 0) + ' lesson(s) edited\n'
          + (m.republished || 0) + ' lesson(s) to republish\n' + (m.reordered ? 'Lesson order changed\n' : '') + (m.materialsChanged || 0) + ' material(s) changed\n\nEditing is locked until the review is done.';
        if (G.confirm && !G.confirm(text)) return null;
        return call('submitRevision', { courseId: S.course.courseId }).then(load);
      }).catch(function (x) { G.alert && G.alert(errText(x)); });
    }
  }

  function onChange(e) {
    var t = e.target;
    if (t && t.matches && t.matches('[data-ls-file]') && t.files && t.files[0]) upload(t.closest('[data-ls-form]'), t.files[0]);
  }

  /* mount(el, course, onBack) — course = { courseId, title, status } from manageMyCourses list */
  function mount(el, course, onBack) {
    if (!el || !course) return;
    S.el = el; S.course = course; S.onBack = onBack || null;
    if (!el.__lsBound) { el.addEventListener('click', onClick); el.addEventListener('change', onChange); el.__lsBound = true; }
    return load();
  }
  G.SokoniEducationLessons = { mount: mount, _state: S, _render: render };
})(typeof window !== 'undefined' ? window : this);
