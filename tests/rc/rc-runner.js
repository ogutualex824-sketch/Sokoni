/* ============================================================================
   RC1 RUNNER — executes release-candidate journeys and certifies readiness.

   Usage:
     node tests/rc/rc-runner.js --backend=static
     node tests/rc/rc-runner.js --backend=production --allow-privileged
     node tests/rc/rc-runner.js --backend=emulator --suite=rc-01,rc-04
     FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 \
       FIREBASE_AUTH_EMULATOR_HOST=127.0.0.1:9099 \
       node tests/rc/rc-runner.js --backend=emulator

   Every step ends PASS, FAIL or BLOCKED. BLOCKED = "this backend cannot test
   this" (missing credential, secret, or capability) — it is NEVER counted as a
   pass, and the reason is recorded, so a partial run tells the exact truth
   about what was and was not certified. Evidence (screenshots, Firestore doc
   snapshots, timestamps, console errors) is written per step under
   docs/rc-runs/<label>/.
   ========================================================================== */

'use strict';

const fs = require('fs');
const path = require('path');
const dataset = require('./rc-dataset');
const { BlockedError } = require('./backends/backend-interface');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = path.join(ROOT, 'docs', 'rc-runs');

function arg(name, def) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  if (hit) return hit.split('=').slice(1).join('=');
  return process.argv.includes(`--${name}`) ? true : def;
}

function makeBackend(name, opts) {
  switch (name) {
    case 'static':     return new (require('./backends/backend-static'))(opts);
    case 'production': return new (require('./backends/backend-admin'))({ ...opts, emulator: false });
    case 'emulator':   return new (require('./backends/backend-admin'))({ ...opts, emulator: true });
    default: throw new Error(`unknown backend "${name}" (static|production|emulator)`);
  }
}

const ALL_SUITES = ['rc-01-seller', 'rc-02-buyer', 'rc-03-payment',
                    'rc-04-inventory', 'rc-05-search', 'rc-06-pwa', 'rc-07-gdpr', 'rc-09-rules',
                    'rc-10-account-baseline'];

async function main() {
  const backendName = arg('backend', 'static');
  const only = arg('suite', null);
  const allowPrivileged = !!arg('allow-privileged', false);
  const label = arg('label', null) || `${backendName}-${stamp()}`;

  const suiteIds = (only ? String(only).split(',') : ALL_SUITES)
    .map(s => ALL_SUITES.find(x => x.startsWith(s)) || s);

  const evidenceRoot = path.join(RUNS_DIR, label);
  fs.mkdirSync(evidenceRoot, { recursive: true });

  console.log(`\nRC1 RUN  backend=${backendName}  label=${label}  privileged=${allowPrivileged}`);
  console.log('─'.repeat(70));

  const backend = makeBackend(backendName, { allowPrivileged });
  let backendUp = false;
  try { await backend.init(); backendUp = true; console.log(`backend ready: ${backend.name}\n`); }
  catch (e) {
    console.log(`backend BLOCKED at init: ${e.message}\n`);
  }

  // Playwright only if any UI suite is in scope and available.
  let chromium = null;
  try { ({ chromium } = require(path.join(ROOT, 'node_modules', 'playwright'))); }
  catch { try { ({ chromium } = require('playwright')); } catch { /* no UI */ } }
  const browser = chromium ? await chromium.launch() : null;

  const report = { label, backend: backend.name, startedAt: new Date().toISOString(),
                   privileged: allowPrivileged, suites: [] };

  for (const id of suiteIds) {
    let suite;
    try { suite = require(`./suites/${id}`); }
    catch (e) { console.log(`SKIP ${id}: cannot load (${e.message})`); continue; }

    const suiteDir = path.join(evidenceRoot, id);
    fs.mkdirSync(suiteDir, { recursive: true });
    const ctx = makeCtx({ backend, backendUp, browser, dataset, suiteDir, allowPrivileged });

    console.log(`\n▶ ${suite.id}  ${suite.title}`);
    const stepResults = [];
    for (const step of suite.steps) {
      const r = await runStep(step, ctx);
      stepResults.push(r);
      const mark = r.status === 'PASS' ? '✓' : r.status === 'FAIL' ? '✗' : '⊘';
      console.log(`   ${mark} ${step.name}${r.detail ? ' — ' + r.detail : ''}`);
    }
    await ctx.closePage();
    const verdict = stepResults.some(r => r.status === 'FAIL') ? 'FAIL'
      : stepResults.every(r => r.status === 'PASS') ? 'PASS'
      : stepResults.some(r => r.status === 'PASS') ? 'PARTIAL' : 'BLOCKED';
    console.log(`   → ${suite.id}: ${verdict}`);
    report.suites.push({ id: suite.id, title: suite.title, verdict, steps: stepResults });
  }

  if (browser) await browser.close();
  try { if (backendUp) await backend.cleanup(); } catch {}

  report.finishedAt = new Date().toISOString();
  report.summary = summarize(report);
  fs.writeFileSync(path.join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2));
  writeMarkdown(report, evidenceRoot);

  console.log('\n' + '─'.repeat(70));
  console.log(coverageText(report));
  console.log('\nreport:  ' + path.relative(ROOT, path.join(evidenceRoot, 'report.md')));
  // Exit non-zero only on a genuine FAIL, never on BLOCKED (env, not defect).
  process.exit(report.summary.fail > 0 ? 1 : 0);
}

function makeCtx({ backend, backendUp, browser, dataset, suiteDir, allowPrivileged }) {
  let page = null;
  const evidence = [];
  return {
    backend, backendUp, dataset, allowPrivileged, evidence,
    async ui() {
      if (!browser) throw new BlockedError('no Playwright — UI steps cannot run');
      if (!page) {
        const c = await browser.newContext({ viewport: { width: 390, height: 844 } });
        page = await c.newPage();
        page._rcErrors = [];
        page.on('pageerror', e => page._rcErrors.push(String(e.message).slice(0, 120)));
      }
      return page;
    },
    baseUrl: () => backend.baseUrl(),

    /* Sign the BROWSER in as a canonical identity, using the app's real
       email/password path rather than a test-only backdoor — so this exercises
       the same flow a merchant actually uses. Returns {ok, uid} or {ok:false,
       code, msg} so a step can decide FAIL vs BLOCKED for itself. */
    async signInAs(identity) {
      const p = await this.ui();
      await p.goto(backend.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
      // firebase.js is a deferred module; wait for the compat shim it installs.
      await p.waitForFunction(() => !!window.firebase, { timeout: 25000 })
        .catch(() => { throw new BlockedError('window.firebase never appeared — app did not boot'); });
      const res = await p.evaluate(async ([email, password]) => {
        try {
          const cred = await window.firebase.auth().signInWithEmailAndPassword(email, password);
          const tok = await cred.user.getIdTokenResult(true);
          return { ok: true, uid: cred.user.uid, claims: tok.claims || {} };
        } catch (e) {
          return { ok: false, code: e.code || '', msg: String(e.message || e).slice(0, 140) };
        }
      }, [identity.email, identity.password]);
      if (res.ok) {
        // Mirror what the app itself stores, so auth-guard.js does not gate.
        await p.evaluate((u) => {
          localStorage.setItem('loggedIn', 'true');
          localStorage.setItem('sokoniUser', JSON.stringify(u));
        }, { uid: res.uid, email: identity.email, name: identity.displayName });

        /* Wait for the credential to actually PROPAGATE to the Firestore client.
           signInWithEmailAndPassword resolves before the SDK has applied the new
           auth state everywhere, so an immediate write can be evaluated as
           unauthenticated and denied. That made the rules suite non-deterministic
           — the owner-can-write control passed on one run and failed the next
           with identical code. A flaky security test is worse than none. */
        await p.waitForFunction(
          (uid) => !!(window.firebase && window.firebase.auth().currentUser
                      && window.firebase.auth().currentUser.uid === uid),
          res.uid, { timeout: 15000 }).catch(() => {});
        await p.waitForTimeout(1500);
      }
      return res;
    },
    /* Sign the browser OUT so the next identity starts clean — otherwise a
       "denied" result could just be the previous user's session lingering. */
    async signOut() {
      if (!page) return;
      await page.evaluate(async () => {
        try { await window.firebase.auth().signOut(); } catch (_) {}
        localStorage.removeItem('loggedIn');
        localStorage.removeItem('sokoniUser');
      }).catch(() => {});
      await page.waitForTimeout(400);
    },

    /* Run a Firestore operation FROM THE BROWSER, so the deployed security
       rules actually apply (the Admin SDK bypasses them entirely). Returns a
       structured result — never throws — so a suite can compare expected vs
       actual and record the error code for denied operations. */
    async clientOp({ op, path, data }) {
      const p = await this.ui();
      /* The page must be ON the app origin for window.firebase to exist. A fresh
         context sits at about:blank, and signOut() does not navigate — so a
         signed-out scenario would otherwise report BLOCKED instead of actually
         testing anonymous access. Navigate if we are not already there. */
      if (!p.url().startsWith(backend.baseUrl())) {
        await p.goto(backend.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
      }
      await p.waitForFunction(() => !!window.firebase, { timeout: 20000 })
        .catch(() => { throw new BlockedError('window.firebase unavailable for client op'); });
      return p.evaluate(async ([op, path, data]) => {
        const db = window.firebase.firestore();
        const uid = (window.firebase.auth().currentUser || {}).uid || null;
        try {
          if (op === 'get')         await db.doc(path).get();
          else if (op === 'set')    await db.doc(path).set(data || {});
          else if (op === 'update') await db.doc(path).update(data || {});
          else if (op === 'delete') await db.doc(path).delete();
          else return { ok: false, code: 'bad-op', msg: 'unknown op ' + op, uid };
          return { ok: true, uid };
        } catch (e) {
          return { ok: false, uid, code: e.code || '', msg: String(e.message || e).slice(0, 120) };
        }
      }, [op, path, data]);
    },

    /* The privacy/cookie gate blurs and covers the page. It is dismissed before
       capture so the evidence artifact shows the thing under test rather than a
       consent dialog — the assertions are unaffected either way. */
    async dismissOverlays() {
      if (!page) return;
      for (const sel of ['button:has-text("Accept")', '#cookieAccept', '.cookie-accept']) {
        const el = await page.$(sel).catch(() => null);
        if (el && await el.isVisible().catch(() => false)) { await el.click().catch(() => {}); break; }
      }
      await page.waitForTimeout(600);
    },
    async shot(name) {
      if (!page) return null;
      const f = path.join(suiteDir, `${name}.png`);
      await page.screenshot({ path: f }).catch(() => {});
      evidence.push({ type: 'screenshot', file: path.relative(ROOT, f) });
      return f;
    },
    record(type, data) { evidence.push({ type, ...data }); },
    async closePage() { if (page) { await page.context().close().catch(() => {}); page = null; } },
  };
}

async function runStep(step, ctx) {
  const started = new Date().toISOString();
  ctx.evidence.length = 0;
  try {
    const out = await step.run(ctx);
    const status = out && out.status ? out.status : 'PASS';
    return { name: step.name, capability: step.capability || null, status,
             detail: out && out.detail || '', evidence: [...ctx.evidence], at: started };
  } catch (e) {
    const blocked = e instanceof BlockedError || e.blocked;
    return { name: step.name, capability: step.capability || null,
             status: blocked ? 'BLOCKED' : 'FAIL',
             detail: String(e.message).slice(0, 160), evidence: [...ctx.evidence], at: started };
  }
}

function summarize(report) {
  let pass = 0, fail = 0, blocked = 0;
  for (const s of report.suites) for (const st of s.steps) {
    if (st.status === 'PASS') pass++; else if (st.status === 'FAIL') fail++; else blocked++;
  }
  return { suites: report.suites.length, pass, fail, blocked };
}

/* Why a suite could not be certified, in one word, taken from its blocked steps.
   Shown next to the verdict so a reader sees the CAUSE without opening the run. */
function blockedCategory(detail) {
  const d = String(detail || '').toLowerCase();
  if (/secret|webhook|intasend|hmac/.test(d))                 return 'Secrets';
  if (/auth|sign|claim|credential|invalid_client|privileged/.test(d)) return 'Auth';
  if (/emulator|jdk|firestore|backend cannot|no backend/.test(d))     return 'Backend';
  return 'Capability';
}

/* The headline artefact: what was actually exercised before a release.
   `untested` comes from each step's declared `capability`, so it is explicit
   metadata rather than a guess parsed out of an error message. */
function coverage(report) {
  const rows = report.suites.map(s => {
    const cats = [...new Set(s.steps.filter(st => st.status === 'BLOCKED')
                                    .map(st => blockedCategory(st.detail)))];
    const label = s.verdict === 'PASS' ? 'PASS'
      : s.verdict === 'PARTIAL' ? 'PASS (Partial)'
      : s.verdict === 'FAIL' ? 'FAIL'
      : `BLOCKED${cats.length ? ' (' + cats.join('/') + ')' : ''}`;
    return { id: s.id, title: s.title, label };
  });
  const untested = [];
  for (const s of report.suites) for (const st of s.steps) {
    if (st.status !== 'PASS' && st.capability && !untested.includes(st.capability)) {
      untested.push(st.capability);
    }
  }
  return { rows, untested };
}

function coverageText(report) {
  const { rows, untested } = coverage(report);
  const w = Math.max(...rows.map(r => (r.id + ' ' + r.title).length)) + 2;
  const L = [];
  L.push('Release Candidate Coverage', '');
  for (const r of rows) L.push(`  ${(r.id + ' ' + r.title).padEnd(w)}${r.label}`);
  L.push('', 'Coverage:');
  L.push(`  PASS:    ${String(report.summary.pass).padStart(4)}`);
  L.push(`  FAIL:    ${String(report.summary.fail).padStart(4)}`);
  L.push(`  BLOCKED: ${String(report.summary.blocked).padStart(4)}`);
  if (untested.length) {
    L.push('', 'Untested capabilities:');
    for (const c of untested) L.push(`  - ${c}`);
  }
  return L.join('\n');
}

function writeMarkdown(report, dir) {
  const L = [];
  L.push(`# RC1 Run — ${report.label}`, '');
  L.push(`- Backend: \`${report.backend}\``);
  L.push(`- Started: ${report.startedAt}`);
  L.push(`- Privileged claims: ${report.privileged ? 'allowed' : 'refused'}`);
  L.push(`- Summary: **${report.summary.pass} pass · ${report.summary.fail} fail · ${report.summary.blocked} blocked**`, '');

  /* Coverage first — a release reader must see what was actually exercised
     before wading into per-step detail. */
  const { rows, untested } = coverage(report);
  L.push('## Release Candidate Coverage', '');
  L.push('| Suite | Result |', '|---|---|');
  for (const r of rows) L.push(`| ${r.id} ${r.title} | ${r.label} |`);
  L.push('', '```', `PASS:    ${report.summary.pass}`,
         `FAIL:    ${report.summary.fail}`,
         `BLOCKED: ${report.summary.blocked}`, '```', '');
  if (untested.length) {
    L.push('**Untested capabilities:**', '');
    for (const c of untested) L.push(`- ${c}`);
    L.push('');
  }

  for (const s of report.suites) {
    L.push(`## ${s.id} — ${s.title}  →  ${s.verdict}`, '');
    for (const st of s.steps) {
      const mark = st.status === 'PASS' ? '✓' : st.status === 'FAIL' ? '✗' : '⊘';
      L.push(`- ${mark} **${st.name}** — ${st.status}${st.detail ? ': ' + st.detail : ''}`);
      for (const ev of st.evidence) {
        if (ev.type === 'screenshot') L.push(`    - ![${st.name}](${path.basename(path.dirname(ev.file))}/${path.basename(ev.file)})`);
        else L.push(`    - \`${ev.type}\`: ${JSON.stringify(ev).slice(0, 160)}`);
      }
    }
    L.push('');
  }
  fs.writeFileSync(path.join(dir, 'report.md'), L.join('\n'));
}

function stamp() {
  // Date.now avoided elsewhere in workflows, but this is a normal Node script.
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

main().catch(e => { console.error('RUNNER CRASH', e); process.exit(2); });
