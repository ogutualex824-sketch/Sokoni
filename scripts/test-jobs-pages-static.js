#!/usr/bin/env node
/* Jobs pages static certification (jobs.html, job-post.html, sokoni-jobs.js) against the J1/J2 server contract.
   PARITY: the employer status dropdown (NEXT) must equal the server's EMPLOYER_TRANSITIONS, read from JOBS_FN
   (default: the J2 worktree). If the server file cannot be read the parity rows FAIL. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (id, c, m) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m); c ? pass++ : fail++; };
const js = fs.readFileSync(path.join(R, 'sokoni-jobs.js'), 'utf8');
const jobs = fs.readFileSync(path.join(R, 'jobs.html'), 'utf8');
const post = fs.readFileSync(path.join(R, 'job-post.html'), 'utf8');

let parsed = true; try { new vm.Script(js); } catch (e) { parsed = false; }
ok('S1', parsed, 'sokoni-jobs.js parses');

/* O — every op the pages call exists on the server */
const fnPath = process.env.JOBS_FN || 'C:/temp/sok-jobs-fn/functions/jobs.js';
let srv = null; try { srv = fs.readFileSync(fnPath, 'utf8'); } catch (e) { srv = null; }
ok('O0', !!srv, 'server jobs.js read from ' + fnPath);
const used = Array.from(new Set((js.match(/_callable\('([A-Za-z]+)'\)/g) || []).map((m) => m.slice(11, -2)))).sort();
const srvOps = srv ? Array.from(new Set((srv.match(/exports\._h\.([A-Za-z]+)\s*=/g) || []).map((m) => m.replace(/exports\._h\.|\s*=/g, '')))) : [];
const missing = used.filter((o) => !srvOps.includes(o));
ok('O1', !!srv && used.length > 0 && missing.length === 0, 'every page op exists on the server' + (missing.length ? ' (missing: ' + missing.join(',') + ')' : ''));

/* P — employer dropdown parity with EMPLOYER_TRANSITIONS */
let srvNext = null, pageNext = null;
try { const a = srv.indexOf('const EMPLOYER_TRANSITIONS = {'), b = srv.indexOf('};', a) + 2; const c = {}; vm.runInNewContext(srv.slice(a, b).replace('const ', ''), c); srvNext = c.EMPLOYER_TRANSITIONS; } catch (e) { srvNext = null; }
try { const a = js.indexOf('const NEXT = {'), b = js.indexOf('};', a) + 2; const c = {}; vm.runInNewContext(js.slice(a, b).replace('const ', ''), c); pageNext = c.NEXT; } catch (e) { pageNext = null; }
ok('P1', !!srvNext && !!pageNext && JSON.stringify(srvNext) === JSON.stringify(pageNext), 'employer dropdown == server EMPLOYER_TRANSITIONS');
ok('P2', /if \(status === 'rejected'\) \{[\s\S]{0,200}reason\.length < 3/.test(js) && /\{ applicationId: appId, status, reason, expectedVersion \}/.test(js), 'rejection asks for a reason; expectedVersion is sent');

/* A — applicant actions */
ok('A1', /SokoniJobs\.withdrawApp\(/.test(js) && /_callable\('withdrawApplication'\)/.test(js) && /app\.canWithdraw \?/.test(js), 'Withdraw shown only when the server says canWithdraw');
ok('A2', /app\.canRespondToOffer \?/.test(js) && /_callable\('respondToJobOffer'\)\(\{ applicationId, accept: accept === true \}\)/.test(js), 'Accept/Decline shown only on an open offer; accept sent as a strict boolean');
ok('A3', /_callable\('getApplicationHistory'\)/.test(js), 'history view uses getApplicationHistory');
ok('A4', /app\.statusLabel \|\| STATUS_LABELS\[app\.status\]/.test(js), 'server statusLabel preferred over local labels');
ok('A5', /withdrawApp,\s*\n\s*respondToOffer,\s*\n\s*showAppHistory,/.test(js), 'applicant actions exported on SokoniJobs');

/* J — J2 honesty */
ok('J1', !/It is now live/.test(js), 'no "now live" claim after posting (a vacancy is published only after review)');
ok('J2', /submit:\s+true/.test(js) && /submitted for SOKONI review/.test(js), 'the post form submits for review and says so');
ok('J3', /pending_review:'Pending review'/.test(js) && /active:'Published'/.test(js), 'employer cards label review states');
ok('J4', /moderationReason/.test(js), 'the employer sees SOKONI\'s review reason');

/* T — types + freshness + safety */
ok('T1', /'freelance-gig'/.test(js) && /'freelance-gig':'Freelance \/ Gig'/.test(js) && /value="freelance-gig"/.test(post), 'Freelance / Gig type in the filters and the post form');
ok('T2', /<script src="\/sw-register\.js" defer><\/script>\s*<\/body>/.test(jobs) && /<script src="\/sw-register\.js" defer><\/script>\s*<\/body>/.test(post), 'both pages self-update after deploys (sw-register.js)');
ok('T3', !/wa\.me|whatsapp/i.test(js + jobs + post), 'no WhatsApp hand-offs');
ok('T4', /function _esc\(s\)/.test(js) && !/innerHTML = [^;]*app\.rejectionReason(?![^;]*_esc)/.test(js), 'rejection reasons are escaped before rendering');
/* M — Jobs messages (sokoni-b2 J4): parties are derived by the server from the application */
const mi = js.indexOf('function messageApp');
ok('M1', /window\.SokoniInbox\.openForTransaction\('job_application', applicationId\)/.test(js) && /\/messages\.html\?tx=job_application&txId=/.test(js), 'Message opens the job_application conversation, with the messages.html fallback');
ok('M2', /SokoniJobs\.messageApp\('\$\{appId\}'\)">💬 Message employer/.test(js) && /SokoniJobs\.messageApp\('\$\{id\}'\)">💬 Message applicant/.test(js), 'Message employer (candidate) and Message applicant (employer) buttons');
ok('M3', mi > 0 && !/participant|seekerUid|employerUid/.test(js.slice(mi, mi + 500)), 'the page sends only the application id, never participant ids');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
