/* Education storage (sokoni-5b, 2026-10-03). Emulator-backed, against a rules FILE.
   Run: firebase emulators:exec --only storage,firestore --project demo-sokoni-edu "node scripts/zz-test-education-storage.js"
        STORAGE_RULES=<file> to test another rules file (default storage.rules).
   Contract:
     learner-photos/{uid}/{file}                learners may be MINORS: owner + admin read ONLY; owner write, safe image < 2 MB,
                                                file-name pattern; owner delete
     course-materials/{ownerUid}/{courseId}/…   NOT world-readable (paid): owner + admin read; owner write while the course
                                                is a DRAFT and they are its instructor (firestore.get cross-service check)
   Every allow has a matching deny on the same path. NOTE: the cross-service rows need the Firestore emulator running
   alongside storage; in production they need the Storage service agent's Firestore access, or those writes FAIL CLOSED. */
'use strict';
const fs = require('fs'), path = require('path');
const { initializeTestEnvironment, assertSucceeds, assertFails } = require('@firebase/rules-unit-testing');
const { ref, uploadBytes, getBytes } = require('firebase/storage');
const { doc, setDoc } = require('firebase/firestore');

let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok ? '' : '   [' + d + ']')); ok ? pass++ : fail++; };
const allows = async (l, p) => { try { await assertSucceeds(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };
const denies = async (l, p) => { try { await assertFails(p); ck(l, true); } catch (e) { ck(l, false, e.message); } };
const IMG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const BIG = new Uint8Array(2 * 1024 * 1024 + 1);
const png = { contentType: 'image/png' }, pdf = { contentType: 'application/pdf' };

(async () => {
  const file = process.env.STORAGE_RULES || 'storage.rules';
  const [host, port] = (process.env.FIREBASE_STORAGE_EMULATOR_HOST || '127.0.0.1:9199').split(':');
  const [fhost, fport] = (process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8080').split(':');
  const env = await initializeTestEnvironment({ projectId: 'demo-sokoni-edu',
    storage: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host, port: Number(port) },
    firestore: { rules: 'rules_version = "2"; service cloud.firestore { match /databases/{d}/documents { match /{p=**} { allow read: if true; } } }', host: fhost, port: Number(fport) } });
  console.log('\nEducation storage   STORAGE_RULES=' + file + '\n');
  await env.clearStorage();
  await env.withSecurityRulesDisabled(async (c) => {
    await uploadBytes(ref(c.storage(), 'learner-photos/kid/me.png'), IMG, png);
    await uploadBytes(ref(c.storage(), 'course-materials/teach/c1/notes.pdf'), IMG, pdf);
    await setDoc(doc(c.firestore(), 'courses/c1'), { instructorUid: 'teach', status: 'draft' });
    await setDoc(doc(c.firestore(), 'courses/c2'), { instructorUid: 'teach', status: 'published' });
  });
  const kid = env.authenticatedContext('kid').storage(), other = env.authenticatedContext('other').storage();
  const teach = env.authenticatedContext('teach').storage(), anon = env.unauthenticatedContext().storage();
  const admin = env.authenticatedContext('adm', { admin: true }).storage();
  // learner photos
  await allows('ES-P1 learner uploads own photo (png, small, valid name)', uploadBytes(ref(kid, 'learner-photos/kid/photo1.png'), IMG, png));
  await denies('ES-P2 learner uploads a non-image', uploadBytes(ref(kid, 'learner-photos/kid/x.png'), IMG, { contentType: 'text/html' }));
  await denies('ES-P3 learner uploads > 2 MB', uploadBytes(ref(kid, 'learner-photos/kid/big.png'), BIG, png));
  await denies('ES-P4 bad file name (path tricks / no extension)', uploadBytes(ref(kid, 'learner-photos/kid/.htaccess'), IMG, png));
  await denies('ES-P5 another user uploads into the learner\'s folder', uploadBytes(ref(other, 'learner-photos/kid/evil.png'), IMG, png));
  await allows('ES-P6 learner reads own photo', getBytes(ref(kid, 'learner-photos/kid/me.png')));
  await denies('ES-P7 another signed-in user reads a MINOR\'s photo', getBytes(ref(other, 'learner-photos/kid/me.png')));
  await denies('ES-P8 signed-out read of a learner photo', getBytes(ref(anon, 'learner-photos/kid/me.png')));
  await allows('ES-P9 admin reads a learner photo', getBytes(ref(admin, 'learner-photos/kid/me.png')));
  // course materials
  await allows('ES-M1 instructor uploads a pdf to their own DRAFT course', uploadBytes(ref(teach, 'course-materials/teach/c1/week1.pdf'), IMG, pdf));
  await denies('ES-M2 instructor uploads to a PUBLISHED course', uploadBytes(ref(teach, 'course-materials/teach/c2/week1.pdf'), IMG, pdf));
  await denies('ES-M3 a user uploads into another owner\'s folder', uploadBytes(ref(other, 'course-materials/teach/c1/x.pdf'), IMG, pdf));
  await denies('ES-M4 an executable / html upload', uploadBytes(ref(teach, 'course-materials/teach/c1/run.html'), IMG, { contentType: 'text/html' }));
  await denies('ES-M5 a learner reads paid material directly (signed URL only)', getBytes(ref(kid, 'course-materials/teach/c1/notes.pdf')));
  await denies('ES-M6 signed-out read of course material', getBytes(ref(anon, 'course-materials/teach/c1/notes.pdf')));
  await allows('ES-M7 the instructor reads own material', getBytes(ref(teach, 'course-materials/teach/c1/notes.pdf')));
  await allows('ES-M8 admin reads course material', getBytes(ref(admin, 'course-materials/teach/c1/notes.pdf')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
