#!/usr/bin/env node
/* EDUCATION E2 — the educator lesson editor (sokoni-education-lessons.js) inside Courses on provider-dashboard.
 *   node scripts/test-education-lessons-ui.js        BASE=66d9578 node scripts/test-education-lessons-ui.js (must FAIL)
 * EXECUTES the module in a vm with stub callables + a stub storage SDK: it offers only the actions the SERVER state
 * allows, uploads to the SERVER-named path (never getDownloadURL), sends only lesson fields, shows the server's change
 * summary before submitting, labels a pending preview, and escapes everything. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\neducation lesson editor   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const PD = read('provider-dashboard.html'), CR = read('sokoni-education-courses.js');
ck('P-1', /<script src="sokoni-education-lessons\.js" defer><\/script>/.test(PD) && /data-edu-lessons=/.test(CR) && /G\.SokoniEducationLessons\.mount\(_el, lc/.test(CR), 'Courses → "Lessons" opens the lesson editor (script loaded; mounted in the Courses panel)');
const SRC = read('sokoni-education-lessons.js');
const sent = []; const uploads = []; let reply = null; let confirmAns = true; const confirms = [];
const slot = () => ({ innerHTML: '' });
const mkEl = () => { const slots = { '[data-ls-slot]': slot(), '[data-ls-preview-slot]': slot() }; const e = { innerHTML: '', __lsBound: false, addEventListener: (t, h) => { e['_' + t] = h; }, contains: () => true, querySelector: (q) => slots[q] || null }; return e; };
const G = { alert() {}, confirm: (t) => { confirms.push(t); return confirmAns; }, firebaseStorage: { tag: 'storage' },
  firebase: { functions: () => ({ httpsCallable: (n) => async (d) => { sent.push([n, d]); return { data: await reply(n, d) }; } }) } };
/* import() of the storage SDK: replaced via a global the module's dynamic import resolves to */
const STORAGE = { ref: (st, p) => ({ p }), uploadBytes: async (r, f, m) => { uploads.push({ p: r.p, m }); }, getDownloadURL: async () => { uploads.push({ DOWNLOAD_URL_REQUESTED: true }); return 'x'; } };
const SRC2 = SRC.replace(/import\(SDK \+ 'firebase-storage\.js'\)/g, 'Promise.resolve(__STORAGE__)');
let M = null; try { vm.runInNewContext(SRC2, { window: G, Object, String, Number, Promise, JSON, Math, Array, __STORAGE__: STORAGE }); M = G.SokoniEducationLessons; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
const tick = () => new Promise((r) => setTimeout(r, 5));
const LESSONS = [{ lessonId: 'a', title: '<b>Intro</b>', status: 'published', version: 2, durationMinutes: 10, freePreview: true },
  { lessonId: 'b', title: 'Video', status: 'published', version: 1, hasPendingRevision: true }, { lessonId: 'c', title: 'New', status: 'draft', version: 1, stagedForReview: true }];
(async () => {
  if (!M) { for (let i = 1; i <= 10; i++) ck('E-' + i, false, 'module present'); }
  else {
    /* LIVE course */
    let el = mkEl();
    reply = (n, d) => (d.op === 'list' ? { lessons: LESSONS, revisionPending: false, revisionNote: null } : { ok: true });
    await M.mount(el, { courseId: 'c1', title: 'Algebra', status: 'published' });
    let H = el.innerHTML;
    ck('E-1', /&lt;b&gt;Intro/.test(H) && !/<b>Intro/.test(H) && /v2/.test(H) && /10 min/.test(H) && /free preview/.test(H), 'the list shows order, title (escaped), version, duration and flags from the server');
    ck('E-2', /data-ls-status="unpublished" data-ls-id="a"/.test(H) && !/data-ls-remove="a"/.test(H) && /data-ls-remove="c"/.test(H), 'LIVE course: a published lesson offers Unpublish, never Delete; an unpublished-to-learners draft can be deleted');
    ck('E-3', /2 changes waiting to be submitted — learners still see the reviewed version/.test(H) && /data-ls-submit/.test(H) && /data-ls-preview-pending="b"/.test(H) && /edited — pending review/.test(H), 'staged changes are announced with "Submit changes for review" and "Preview changes"');
    /* submit with summary */
    sent.length = 0; confirms.length = 0;
    reply = (n, d) => (d.op === 'revisionSummary' ? { summary: { newLessons: 1, editedLessons: 1, republished: 0, reordered: true, materialsChanged: 2 } } : d.op === 'list' ? { lessons: LESSONS, revisionPending: true } : { ok: true });
    el._click({ target: { closest: (s) => (s === '[data-ls-submit]' ? {} : null) } }); await tick(); await tick();
    ck('E-4', /1 new lesson\(s\)\n1 lesson\(s\) edited/.test(confirms[0] || '') && /Lesson order changed/.test(confirms[0]) && /2 material\(s\) changed/.test(confirms[0]) && sent.some(([n, d]) => d.op === 'submitRevision'),
      'Submit first shows the SERVER\'s change summary, then submits', [confirms, sent]);
    H = el.innerHTML;
    ck('E-5', /Changes are under review\. Editing is temporarily locked\./.test(H) && !/data-ls-edit=/.test(H) && !/data-ls-new/.test(H) && !/data-ls-remove=/.test(H), 'while in review: locked notice, no edit / add / delete offered');
    /* declined summary submits nothing */
    sent.length = 0; confirmAns = false;
    reply = (n, d) => (d.op === 'revisionSummary' ? { summary: {} } : d.op === 'list' ? { lessons: LESSONS } : { ok: true });
    await M.mount(el, { courseId: 'c1', title: 'Algebra', status: 'published' });
    el._click({ target: { closest: (s) => (s === '[data-ls-submit]' ? {} : null) } }); await tick();
    ck('E-6', !sent.some(([n, d]) => d.op === 'submitRevision'), 'cancelling the summary submits nothing'); confirmAns = true;
    /* pending preview labelled */
    reply = (n, d) => (d.op === 'content' ? { preview: 'pending', notice: 'Previewing pending changes — learners cannot see these changes yet.', lesson: { title: 'Video <i>2</i>', materialUrl: 'https://signed/x', materialExpiresInMinutes: 15 } } : { lessons: LESSONS });
    el._click({ target: { closest: (s) => (s === '[data-ls-preview-pending]' ? { getAttribute: () => 'b' } : null) } }); await tick();
    const pv = el.querySelector('[data-ls-preview-slot]').innerHTML;
    ck('E-7', /Previewing pending changes — learners cannot see these changes yet\./.test(pv) && /Video &lt;i&gt;2/.test(pv) && /expires in 15 min/.test(pv) && sent.some(([n, d]) => d.op === 'content' && d.version === 'pending'), 'the pending preview is labelled, escaped, and its material link says it expires', pv);
    /* upload: server-named path, no download URL */
    uploads.length = 0; sent.length = 0;
    reply = (n, d) => (d.op === 'uploadTarget' ? { path: 'course-materials/teach1/c1/123_notes.pdf', contentType: 'application/pdf' } : { lessons: LESSONS });
    const hidden = { value: '' }; const upOut = { textContent: '' };
    const box = { querySelector: (q) => (q === '[data-ls-upload]' ? upOut : q === '[data-f="materialPath"]' ? hidden : null) };
    el._change({ target: { matches: (s) => s === '[data-ls-file]', files: [{ name: 'notes.pdf', type: 'application/pdf', size: 2048 }], closest: () => box } });
    await tick(); await tick();
    ck('E-8', sent.some(([n, d]) => d.op === 'uploadTarget' && d.fileName === 'notes.pdf' && d.size === 2048) && uploads.length === 1 && uploads[0].p === 'course-materials/teach1/c1/123_notes.pdf' && hidden.value === uploads[0].p,
      'upload goes to the path the SERVER named (uploadTarget) and only that path is kept', [sent, uploads, hidden]);
    ck('E-9', !uploads.some((u) => u.DOWNLOAD_URL_REQUESTED) && !/getDownloadURL/.test(SRC), 'no download URL is ever requested (it would make the file shareable)');
    /* save payload */
    sent.length = 0;
    const vals = { title: 'L', description: 'd', kind: 'text', durationMinutes: '5', body: 'b', videoUrl: '', materialPath: 'course-materials/teach1/c1/123_notes.pdf' };
    const fbox = { getAttribute: () => '', querySelector: (q) => { const m = /data-f="(\w+)"/.exec(q); if (m) return m[1] === 'freePreview' || m[1] === 'publish' ? { checked: m[1] === 'publish' } : { value: vals[m[1]] }; return { textContent: '' }; } };
    reply = () => ({ lessons: LESSONS });
    el._click({ target: { closest: (s) => (s === '[data-ls-save]' ? { disabled: false, closest: () => fbox } : null) } }); await tick();
    const sv = sent.find(([n, d]) => d.op === 'save');
    ck('E-10', !!sv && Object.keys(sv[1].lesson).sort().join() === 'body,description,durationMinutes,freePreview,kind,materialPath,status,title,videoUrl' && !('ownerUid' in sv[1]) && sv[1].lesson.status === 'published',
      'save sends ONLY lesson fields (status is a REQUEST the server applies through review) — never an owner or a folder', sv && sv[1]);
    /* DRAFT course: delete offered for any lesson */
    el = mkEl(); reply = () => ({ lessons: LESSONS });
    await M.mount(el, { courseId: 'c2', title: 'Draft', status: 'draft' });
    ck('E-11', /data-ls-remove="a"/.test(el.innerHTML) && !/data-ls-status="unpublished"/.test(el.innerHTML), 'DRAFT course: lessons can be deleted freely; no unpublish (nothing is live)');
    reply = () => { throw new Error('Only an approved SOKONI teacher or institution can manage lessons.'); };
    el = mkEl(); await M.mount(el, { courseId: 'c2', title: 'Draft', status: 'draft' });
    ck('E-12', /\(—\)/.test(el.innerHTML) && /approved SOKONI teacher/.test(el.innerHTML), 'refused / unavailable: "—" + the server\'s reason');
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
