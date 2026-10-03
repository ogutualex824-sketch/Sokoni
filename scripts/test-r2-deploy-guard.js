#!/usr/bin/env node
'use strict';
/* R2 deploy guard — the control must REFUSE, not just document (owner 2026-10-03, via sokoni-b2).
     G1  the hook ABORTS a bare / unscoped deploy (no SOKONI_R2_SCOPE) — real process, exit 1, ABORT banner
     G2  the hook ABORTS any IntaSend webhook handler and the own-tree functions (webhookIntasend, intasendWebhook,
         processTypesenseQueue, bookingDispatch, any *webhook* / *intasend* name), alone or mixed into an allowed list
     G3  an allowed scoped list passes and prints "R2 SCOPE GUARD: PASS" (the banner a deploy log must contain)
     G4  BOTH firebase.json and firebase.r2deploy.json run the guard FIRST, in the relative form that actually executes
         (never the quoted "$RESOURCE_DIR" form that silently never ran)
     G5  the wrapper refuses a forbidden list before launching anything (--dry-run)
   node scripts/test-r2-deploy-guard.js */
const path = require('path'), fs = require('fs'), cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
let pass = 0, fail = 0;
const ck = (l, ok, d) => { console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + l + (ok || d === undefined ? '' : '  -> ' + JSON.stringify(d).slice(0, 240))); ok ? pass++ : fail++; };
const hook = (scope) => { const env = Object.assign({}, process.env); delete env.SOKONI_R2_SCOPE; if (scope !== undefined) env.SOKONI_R2_SCOPE = scope;
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy/guard-r2-scope.js')], { env, encoding: 'utf8' }); return { code: r.status, out: (r.stdout || '') + (r.stderr || '') }; };

const g1 = hook(undefined), g1b = hook('');
ck('G1 bare / unscoped deploy → hook exits 1 with "R2 SCOPE GUARD: ABORT"', g1.code === 1 && /R2 SCOPE GUARD: ABORT — UNSCOPED/.test(g1.out) && g1b.code === 1, [g1, g1b]);
const forb = ['webhookIntasend', 'intasendWebhook', 'processTypesenseQueue', 'bookingDispatch', 'webhookStripe', 'intasendRefundCallback', 'providerDispatch,webhookIntasend', 'functions:webhookIntasend'];
const g2 = forb.map((s) => [s, hook(s).code]);
ck('G2 every webhook / own-tree function is refused, alone or mixed into an allowed list', g2.every(([, c]) => c === 1), g2);
const g3 = hook('providerDispatch,createPaymentIntent');
ck('G3 an allowed scoped list passes and prints the banner', g3.code === 0 && /R2 SCOPE GUARD: PASS — providerDispatch, createPaymentIntent/.test(g3.out), g3);
const first = (f) => { const j = JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8')); const fns = Array.isArray(j.functions) ? j.functions : [j.functions]; return fns.map((x) => (x.predeploy || [])[0]); };
const a = first('firebase.json'), b = first('firebase.r2deploy.json');
ck('G4 firebase.json and firebase.r2deploy.json run the guard FIRST in the executing relative form', [...a, ...b].every((h) => h === 'node scripts/deploy/guard-r2-scope.js'), { a, b });
const w = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy/r2-deploy.js'), 'providerDispatch,webhookIntasend', '--dry-run'], { encoding: 'utf8' });
const w2 = cp.spawnSync(process.execPath, [path.join(ROOT, 'scripts/deploy/r2-deploy.js'), 'providerDispatch', '--dry-run'], { encoding: 'utf8' });
ck('G5 wrapper refuses a forbidden list before launching; an allowed list builds a scoped --only command', w.status === 1 && /REFUSED/.test(w.stderr) && w2.status === 0 && /--only functions:providerDispatch /.test(w2.stdout), { w: w.stderr, w2: w2.stdout });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
