/* JR — Jobs Board containment (sokoni-f3, 2026-10-03). Emulator-backed, against a rules FILE.
   Run: node scripts/build-firestore-rules.js
        RULES_FILE=firestore.rules.build FIRESTORE_PORT=<port> \
          firebase emulators:exec --only firestore --project demo-jobs-rules "node scripts/zz-test-jobs-rules.js"
   Baseline (LIVE): RULES_FILE=firestore.rules.served-f259c0b5 — JR-J1, JR-J2, JR-J3, JR-A1, JR-A2 and JR-P1 must FAIL
   there (they are the live holes); the controls must PASS on both. CR-1/CR-2 (construction open RFQ PII) must also FAIL
   there. */
'use strict';
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const fs = require('fs'), path = require('path');
const { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, query, where, getDocs } = require('firebase/firestore');
let pass = 0, fail = 0;
const ck = (id, ok, m, d) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m + (ok || !d ? '' : '   [' + String(d).slice(0, 90) + ']')); ok ? pass++ : fail++; };
const allows = async (id, m, p) => { try { await assertSucceeds(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
const denies = async (id, m, p) => { try { await assertFails(p); ck(id, true, m); } catch (e) { ck(id, false, m, e.message); } };
(async () => {
  const file = process.env.RULES_FILE || 'firestore.rules.build';
  const env = await initializeTestEnvironment({ projectId: 'demo-jobs-rules',
    firestore: { rules: fs.readFileSync(path.resolve(__dirname, '..', file), 'utf8'), host: '127.0.0.1', port: Number(process.env.FIRESTORE_PORT || 8080) } });
  console.log('\nJR jobs board   RULES_FILE=' + file + '\n');
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (c) => {
    const f = c.firestore();
    await setDoc(doc(f, 'jobs/j1'), { employerUid: 'emp', status: 'active', title: 'Cashier', applicationCount: 0, featured: false });
    await setDoc(doc(f, 'jobs/j2'), { employerUid: 'emp', status: 'closed', title: 'Old' });
    await setDoc(doc(f, 'jobApplications/j1_seek'), { jobId: 'j1', seekerUid: 'seek', employerUid: 'emp', status: 'pending' });
    await setDoc(doc(f, 'jobSeekerProfiles/seek'), { uid: 'seek', name: 'Seeker', cvUrl: 'https://cv.example/seek.pdf' });
  });
  const anon = env.unauthenticatedContext().firestore();
  const att = env.authenticatedContext('att').firestore(), emp = env.authenticatedContext('emp').firestore();
  const seek = env.authenticatedContext('seek').firestore();
  const admin = env.authenticatedContext('admin1', { admin: true }).firestore();
  const legacyJob = { uid: 'att', title: 'Fake job', company: 'X', description: 'pay a fee to apply', contactEmail: 'a@b.c' };
  // jobs: server-written only
  await denies('JR-J1', 'signed-in user publishes an active job directly (bypasses validation + moderation)', setDoc(doc(att, 'jobs/fake1'), Object.assign({ status: 'active', employerUid: 'att', featured: true }, legacyJob)));
  await denies('JR-J2', 'attacker creates a job attributed to another employer', setDoc(doc(att, 'jobs/fake2'), Object.assign({ status: 'active', employerUid: 'emp' }, legacyJob)));
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'jobs/own'), Object.assign({ status: 'pending' }, legacyJob)); });
  await denies('JR-J3', 'legacy poster flips own job to active / featured counters', updateDoc(doc(att, 'jobs/own'), { status: 'active', applicationCount: 999 }));
  await denies('JR-J4', 'signed-out create with applicants: 0 (the 10-01 precedence bug stays closed)', setDoc(doc(anon, 'jobs/fake3'), Object.assign({ applicants: 0 }, legacyJob)));
  await denies('JR-J5', 'employer edits own server job status directly', updateDoc(doc(emp, 'jobs/j1'), { status: 'closed' }));
  await allows('JR-J6', 'CONTROL: public reads an active job', getDoc(doc(anon, 'jobs/j1')));
  await denies('JR-J7', 'CONTROL: public cannot read a closed job', getDoc(doc(anon, 'jobs/j2')));
  await allows('JR-J8', 'CONTROL: employer lists own jobs (sokoni-jobs.js:981 query)', getDocs(query(collection(emp, 'jobs'), where('employerUid', '==', 'emp'))));
  await allows('JR-J9', 'CONTROL: admin deletes a job', deleteDoc(doc(admin, 'jobs/own')));
  // applications: only applyForJob's transaction creates
  await denies('JR-A1', 'attacker pre-creates {jobId}_{victim} to block the victim (alreadyApplied)', setDoc(doc(att, 'jobApplications/j1_victim'), { jobId: 'j1', uid: 'att', name: 'x', email: 'x', phone: 'x', coverLetter: 'x', appliedAt: 1, status: 'pending' }));
  await denies('JR-A2', 'attacker plants an application into an employer\'s list', setDoc(doc(att, 'jobApplications/j1_att'), { jobId: 'j1', uid: 'att', seekerUid: 'att', employerUid: 'emp', name: 'x', email: 'x', phone: 'x', coverLetter: 'x', appliedAt: 1, status: 'shortlisted' }));
  await denies('JR-A3', 'applicant promotes own application to hired', updateDoc(doc(seek, 'jobApplications/j1_seek'), { status: 'hired' }));
  await allows('JR-A4', 'CONTROL: applicant reads own application', getDoc(doc(seek, 'jobApplications/j1_seek')));
  await allows('JR-A5', 'CONTROL: employer reads an application to its job', getDoc(doc(emp, 'jobApplications/j1_seek')));
  await denies('JR-A6', 'CONTROL: a third party cannot read the application', getDoc(doc(att, 'jobApplications/j1_seek')));
  // seeker profiles: owner/admin raw; everyone else via the redacting callable
  await denies('JR-P1', 'any signed-in user reads a seeker\'s raw profile (cvUrl harvesting)', getDoc(doc(att, 'jobSeekerProfiles/seek')));
  await denies('JR-P2', 'an employer reads a seeker\'s raw profile', getDoc(doc(emp, 'jobSeekerProfiles/seek')));
  await allows('JR-P3', 'CONTROL: seeker reads own profile', getDoc(doc(seek, 'jobSeekerProfiles/seek')));
  await allows('JR-P4', 'CONTROL: admin reads a profile', getDoc(doc(admin, 'jobSeekerProfiles/seek')));
  await denies('JR-P5', 'seeker writes own profile directly (server saveJobSeekerProfile only)', setDoc(doc(seek, 'jobSeekerProfiles/seek'), { cvUrl: 'javascript:alert(1)' }));
  // construction containment (owner 2026-10-03): open RFQs were publicly readable with the buyer's name + phone
  await env.withSecurityRulesDisabled(async (c) => { await setDoc(doc(c.firestore(), 'constructRFQs/r1'), { uid: 'seek', status: 'open', name: 'Buyer', phone: '0700000000' }); });
  await denies('CR-1', 'signed-out read of an OPEN construction RFQ (name + phone)', getDoc(doc(anon, 'constructRFQs/r1')));
  await denies('CR-2', 'another signed-in user reads an open construction RFQ', getDoc(doc(att, 'constructRFQs/r1')));
  await allows('CR-3', 'CONTROL: the RFQ owner reads it', getDoc(doc(seek, 'constructRFQs/r1')));
  await allows('CR-4', 'CONTROL: admin reads it', getDoc(doc(admin, 'constructRFQs/r1')));
  await env.cleanup();
  console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR (not a rules result):', e.message); process.exit(2); });
