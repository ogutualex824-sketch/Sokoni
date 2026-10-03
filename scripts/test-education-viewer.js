#!/usr/bin/env node
/* EDUCATION D / E / F — learner lesson viewer, progress, certificates (sokoni-education-learn.js) + the PUBLIC certificate
 * check (certificate-verify.html / sokoni-certificate-verify.js).
 *   node scripts/test-education-viewer.js        BASE=506b9c8 node scripts/test-education-viewer.js (must FAIL)
 * EXECUTES both modules in a vm against stub server answers: every view is the server's learner-safe answer; locked
 * lessons cannot be opened; completion goes to the server; certificates come from the server; the public check never
 * says "valid" unless the server found it, shows initials only and keeps revoked certificates visible as revoked. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const read = (f) => { try { return process.env.BASE ? execSync('git show ' + process.env.BASE + ':' + f, { cwd: ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }) : fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch (_) { return ''; } };
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + JSON.stringify(got).slice(0, 240) + ']')); ok ? pass++ : fail++; };
console.log('\neducation lesson viewer + certificates   ' + (process.env.BASE ? 'BASE=' + process.env.BASE : 'this tree') + '\n');
const tick = () => new Promise((r) => setTimeout(r, 5));
const sent = []; let reply = null;
const mkFb = () => ({ functions: () => ({ httpsCallable: (n) => async (d) => { sent.push([n, d]); return { data: await reply(n, d) }; } }) });

/* ── learner shell ── */
const els = {}; ['entNav', 'entRoot', 'entTitle', 'entCoName', 'entSub', 'entSide', 'entScrim', 'entMenu'].forEach((i) => { els[i] = { id: i, innerHTML: '', textContent: '', classList: { add() {}, remove() {}, contains: () => false }, setAttribute() {}, addEventListener() {} }; });
const document = { getElementById: (i) => els[i] || null, body: { addEventListener: (t, h) => { els._click = h; } } };
let authCb = null;
const G = { location: { hash: '', href: '' }, history: { replaceState() {} }, SokoniEducation: { loadLearnerProfile() {} } };
G.firebase = Object.assign(mkFb(), { auth: () => ({ onAuthStateChanged: (cb) => { authCb = cb; } }) });
let M = null; try { vm.runInNewContext(read('sokoni-education-learn.js'), { window: G, document, Object, String, Number, Promise, JSON, Math, Array, Date, encodeURIComponent }); M = G.SokoniEducationLearn; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
const click = (attr, val) => els._click({ target: { closest: (s) => (s === '[' + attr + ']' ? { getAttribute: () => val, disabled: false } : null) } });
const WS = { learner: { access: { ageStatus: 'verified_adult', interactive: true }, modules: { myLearning: { state: 'AVAILABLE' }, certificates: { state: 'AVAILABLE' }, profile: { state: 'AVAILABLE' } } }, dashboards: [], applications: [] };
const COURSE = (states) => ({ ok: true, course: { courseId: 'c1', title: 'Algebra <b>' }, enrolled: true, progress: 50, certificate: null,
  lessons: [{ lessonId: 'a', title: 'Intro', state: states[0], durationMinutes: 10, locked: false }, { lessonId: 'b', title: 'Video', state: states[1], locked: false }, { lessonId: 'z', title: 'Gated', state: 'not_started', locked: true }] });
(async () => {
  const hasViewer = M && typeof M.openCourse === 'function';
  if (!hasViewer) { for (let i = 1; i <= 9; i++) ck('V-' + i, false, 'viewer present'); }
  else {
    M.init();
    reply = (n, d) => (n === 'educationWorkspace' ? WS : n === 'getMyEnrollments' ? { enrollments: [{ courseId: 'c1', progress: 50, course: { title: 'Algebra', lessonCount: 3 } }] }
      : d.op === 'learnerCourse' ? COURSE(['completed', 'not_started']) : d.op === 'content' ? { lesson: { lessonId: 'b', title: 'Video', body: 'Hello <script>x</script>', materialUrl: 'https://signed/x', materialExpiresInMinutes: 15 } }
      : d.op === 'complete' ? { progress: 100, certificateIssued: true, certificateId: 'learner1_c1' } : d.op === 'myCertificates' ? { certificates: [{ courseTitle: 'Algebra', serial: 'SOK-EDU-ABCDEF1234', status: 'revoked', issuer: 'SOKONI Education', issuedAtMs: 1700000000000 }] } : {});
    authCb({ uid: 'learner1' }); await tick(); await tick();
    M.go('myLearning');
    ck('V-1', /data-ln-course="c1"/.test(els.entRoot.innerHTML), 'My learning lists the server\'s enrolments with Open');
    click('data-ln-course', 'c1'); await tick(); await tick();
    let H = els.entRoot.innerHTML;
    ck('V-2', /Algebra &lt;b&gt;/.test(H) && /Completed/.test(H) && /Not started/.test(H) && /Progress: 50%/.test(H) && /🔒 Enrol to open/.test(H) && !/data-ln-lesson="z"/.test(H),
      'the course view is the SERVER\'s learnerCourse: states, progress, and a LOCKED lesson cannot be opened (no Open button)', H.slice(0, 300));
    click('data-ln-lesson', 'b'); await tick(); await tick(); await tick();
    H = els.entRoot.innerHTML;
    ck('V-3', /Hello &lt;script&gt;/.test(H) && !/<script>x/.test(H) && /expires in 15 min/.test(H) && /data-ln-lesson="a"[^>]*>← Previous/.test(H) && /data-ln-complete="b"/.test(H) && !/Next →/.test(H),
      'the lesson view: escaped content, an expiring material link, Previous (an unlocked lesson), Mark complete — no Next into a LOCKED lesson', H.slice(0, 400));
    ck('V-4', sent.filter(([n, d]) => d.op === 'learnerCourse').length >= 2, 'opening a lesson refreshes the course states from the server (opening marks it in progress server-side)');
    sent.length = 0;
    click('data-ln-complete', 'b'); await tick(); await tick(); await tick();
    ck('V-5', sent.some(([n, d]) => d.op === 'complete' && d.courseId === 'c1' && d.lessonId === 'b' && Object.keys(d).length === 3) && /certificate is in Certificates/.test(els.entRoot.innerHTML),
      'Mark complete sends ONLY {op, courseId, lessonId} to the server (never "completed: true") and reports the server\'s certificate', sent);
    click('data-ln-back-course', ''); await tick();
    ck('V-6', /data-ln-lesson="a"/.test(els.entRoot.innerHTML), '← Lessons returns to the course');
    /* certificates */
    els._click({ target: { closest: (s) => (s === '[data-ln-nav]' ? { getAttribute: () => 'certificates' } : null) } }); await tick(); await tick();
    H = els.entRoot.innerHTML;
    ck('V-7', /SOK-EDU-ABCDEF1234/.test(H) && /Revoked/.test(H) && /certificate-verify\.html\?serial=SOK-EDU-ABCDEF1234/.test(H), 'Certificates lists the server\'s certificates (a revoked one shown as Revoked) with a Verify link', H.slice(0, 300));
    reply = () => { throw new Error('down'); };
    await M.openCourse('c1');
    ck('V-8', /This course is unavailable right now \(—\)/.test(els.entRoot.innerHTML), 'course unavailable (opened from another view): My learning shows "—", nothing inferred', els.entRoot.innerHTML);
  }
  ck('V-9', /data-ln-complete/.test(read('sokoni-education-learn.js')) && !/completed:\s*true/.test(read('sokoni-education-learn.js')), 'the viewer never sends a completed flag');

  /* ── public verification ── */
  const VH = read('certificate-verify.html');
  ck('P-1', /<script src="\/sw-register\.js" defer><\/script>/.test(VH) && /sokoni-certificate-verify\.js/.test(VH) && /viewport-fit=cover/.test(VH), 'the public check page self-updates and is mobile-ready');
  const vEls = { cvResult: { hidden: true, innerHTML: '' }, cvSerial: { value: '' }, cvForm: { addEventListener() {} } };
  const G2 = { firebase: mkFb(), location: { search: '' } };
  let V = null; try { vm.runInNewContext(read('sokoni-certificate-verify.js'), { window: G2, document: { getElementById: (i) => vEls[i], addEventListener() {} }, String, Promise, Date, encodeURIComponent, decodeURIComponent }); V = G2.SokoniCertificateVerify; } catch (e) { console.log('  LOAD ERROR ' + e.message); }
  if (!V) { for (let i = 2; i <= 6; i++) ck('P-' + i, false, 'verify module present'); }
  else {
    sent.length = 0;
    reply = () => ({ found: true, status: 'issued', courseTitle: 'Algebra <i>', providerName: 'Bright', issuer: 'SOKONI Education', issuedAtMs: 1700000000000, holderInitials: 'W. A.', kind: 'self_paced_completion' });
    await V.check('sok-edu-abcdef1234');
    ck('P-2', /genuine and valid/.test(vEls.cvResult.innerHTML) && /W\. A\./.test(vEls.cvResult.innerHTML) && /Algebra &lt;i&gt;/.test(vEls.cvResult.innerHTML) && sent[0][1].serial === 'SOK-EDU-ABCDEF1234', 'a found certificate: valid, initials only, escaped; the serial is normalised', vEls.cvResult.innerHTML);
    reply = () => ({ found: true, status: 'revoked', revokedReason: 'Misconduct', courseTitle: 'Algebra', holderInitials: 'W. A.' });
    await V.check('SOK-EDU-ABCDEF1234');
    ck('P-3', /REVOKED/.test(vEls.cvResult.innerHTML) && /Misconduct/.test(vEls.cvResult.innerHTML) && !/genuine and valid/.test(vEls.cvResult.innerHTML), 'a revoked certificate stays discoverable as REVOKED with its reason');
    reply = () => ({ found: false });
    await V.check('SOK-EDU-0000000000');
    ck('P-4', /No certificate with the number/.test(vEls.cvResult.innerHTML) && !/valid/.test(vEls.cvResult.innerHTML), 'an unknown number is "no certificate", never valid');
    reply = () => { throw new Error('down'); };
    await V.check('SOK-EDU-0000000000');
    ck('P-5', /\(—\)/.test(vEls.cvResult.innerHTML) && !/valid/.test(vEls.cvResult.innerHTML), 'server unavailable: "could not check (—)", never valid');
    sent.length = 0;
    await V.check('<script>');
    ck('P-6', sent.length === 0 && /Enter a number like/.test(vEls.cvResult.innerHTML), 'a malformed number is rejected before any call');
  }
  console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log('CRASH (no verdict): ' + (e && e.stack || e)); process.exit(2); });
