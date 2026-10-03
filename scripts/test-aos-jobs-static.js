#!/usr/bin/env node
/* AdminOS › Jobs static certification (sokoni-aos-jobs.js + admin-os.html + sokoni-aos.js hooks).
   PARITY: the buttons the panel shows per vacancy status must equal what the server's ADMIN_ACTIONS allows
   (functions/jobs.js J2). The server file is read from JOBS_FN (default: the J2 worktree); if it cannot be read the
   parity rows FAIL — an unchecked parity is not a pass. */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ok = (id, c, m) => { console.log('  ' + (c ? 'PASS' : 'FAIL') + '  ' + id + '  ' + m); c ? pass++ : fail++; };
const mod = fs.readFileSync(path.join(R, 'sokoni-aos-jobs.js'), 'utf8');
const html = fs.readFileSync(path.join(R, 'admin-os.html'), 'utf8');
const aos = fs.readFileSync(path.join(R, 'sokoni-aos.js'), 'utf8');

/* S — load the module DOM-free */
const sb = { window: {} }; sb.window.window = sb.window;
let loaded = true; try { vm.runInNewContext(mod, sb.window, { timeout: 2000 }); } catch (e) { loaded = false; }
const M = sb.window.SokoniAOSJobs;
ok('S1', loaded && M && typeof M.load === 'function' && typeof M.open === 'function', 'module loads and exposes SokoniAOSJobs.load/open');

/* P — parity with the server */
const fnPath = process.env.JOBS_FN || 'C:/temp/sok-jobs-fn/functions/jobs.js';
let server = null;
try {
  const src = fs.readFileSync(fnPath, 'utf8');
  const a = src.indexOf('const ADMIN_ACTIONS = {'), b = src.indexOf('};', a) + 2;
  const l = src.indexOf('const JOB_LABEL = {'), le = src.indexOf('};', l) + 2;
  const ctx = {}; vm.runInNewContext(src.slice(l, le).replace('const JOB_LABEL', 'JOB_LABEL') + src.slice(a, b).replace('const ADMIN_ACTIONS', 'ADMIN_ACTIONS'), ctx);
  server = { actions: ctx.ADMIN_ACTIONS, labels: ctx.JOB_LABEL };
} catch (e) { server = null; }
ok('P0', !!server, 'server ADMIN_ACTIONS read from ' + fnPath);
if (server && M) {
  const statuses = Object.keys(server.labels);
  const allowed = (st) => Object.keys(server.actions).filter((k) => server.actions[k].from.includes(st)).sort();
  const mism = statuses.filter((st) => JSON.stringify((M.ACTIONS[st] || []).slice().sort()) !== JSON.stringify(allowed(st)));
  ok('P1', mism.length === 0, 'panel buttons per status == server ADMIN_ACTIONS' + (mism.length ? ' (mismatch: ' + mism.join(',') + ')' : ''));
  const srvReason = Object.keys(server.actions).filter((k) => server.actions[k].reason).sort();
  ok('P2', JSON.stringify(Object.keys(M.NEEDS_REASON).sort()) === JSON.stringify(srvReason), 'reason-required actions == server (' + srvReason.join(',') + ')');
} else { ok('P1', false, 'parity NOT checked (server or module unavailable)'); ok('P2', false, 'reason parity NOT checked'); }

/* X — safety / honesty */
const used = Array.from(new Set((mod.match(/call\('([A-Za-z]+)'/g) || []).map((m) => m.slice(6, -1)))).sort();
ok('X1', JSON.stringify(used) === '["adminGetJob","adminListJobs","adminModerateJob"]', 'only the three J2 admin ops are called (' + used.join(',') + ')');
ok('X2', !/\.collection\(|setDoc|updateDoc|addDoc|\.set\(|\.update\(/.test(mod), 'module never writes Firestore directly');
ok('X3', /httpsCallable\('servicesDispatch'\)/.test(mod), 'calls go through servicesDispatch');
ok('X4', /'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'/.test(mod), 'esc() escapes all five HTML characters');
ok('X5', /This is not an empty list/.test(mod), 'a load failure is never rendered as an empty list');
ok('X6', /success is shown only after the server confirmed/.test(mod) && /\.then\(function \(r\) \{[\s\S]{0,200}toast\(/.test(mod), 'success toast only after the callable resolves');
ok('X7', !/localStorage|wa\.me|whatsapp/i.test(mod), 'no localStorage business state, no WhatsApp');
ok('X8', /if \(NEEDS_REASON\[action\] && reason\.length < 3\)/.test(mod), 'client asks for the reason before calling (server enforces too)');

/* W — wiring in the ONE canonical workspace */
ok('W1', /data-section="jobs"[^>]*onclick="SokoniAOS\.navigate\('jobs'\)/.test(html), 'sidebar has a Jobs nav item');
ok('W2', /<div class="aos-panel" id="panel-jobs" hidden>[\s\S]{0,200}id="jobsAdminBody"/.test(html), 'panel-jobs with jobsAdminBody exists');
ok('W3', html.indexOf('<script src="sokoni-aos-jobs.js"></script>') > html.indexOf('<script src="sokoni-aos.js"></script>'), 'module script loads after sokoni-aos.js');
ok('W4', /jobs:\s+\(\) => window\.SokoniAOSJobs && window\.SokoniAOSJobs\.load\(\)/.test(aos), 'sokoni-aos.js loader routes jobs → SokoniAOSJobs.load');
ok('W5', /toast:\s+\(m, k\) => _toast\(m, k\)/.test(aos), 'SokoniAOS exposes toast for modules');
console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
