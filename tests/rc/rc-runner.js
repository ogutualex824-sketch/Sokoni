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
                    'rc-04-inventory', 'rc-05-search', 'rc-06-pwa'];

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
  console.log('SUMMARY  ' + JSON.stringify(report.summary));
  console.log('report:  ' + path.relative(ROOT, path.join(evidenceRoot, 'report.md')));
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
    return { name: step.name, status, detail: out && out.detail || '',
             evidence: [...ctx.evidence], at: started };
  } catch (e) {
    const blocked = e instanceof BlockedError || e.blocked;
    return { name: step.name, status: blocked ? 'BLOCKED' : 'FAIL',
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

function writeMarkdown(report, dir) {
  const L = [];
  L.push(`# RC1 Run — ${report.label}`, '');
  L.push(`- Backend: \`${report.backend}\``);
  L.push(`- Started: ${report.startedAt}`);
  L.push(`- Privileged claims: ${report.privileged ? 'allowed' : 'refused'}`);
  L.push(`- Summary: **${report.summary.pass} pass · ${report.summary.fail} fail · ${report.summary.blocked} blocked**`, '');
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
