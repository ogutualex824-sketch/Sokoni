/* run-rules-suite.js — run ONE emulator-backed Firestore rules suite on a PRIVATE port, against an explicit
 * ruleset file (default: the served firestore.rules.build). Never touches 8080 (another agent's emulator)
 * and never a real project.
 *
 *   node scripts/run-rules-suite.js scripts/test-follow-rules.js [rulesFile]
 *
 * rulesFile is resolved from the repo root, or absolute. A suite that reads process.env.RULES_FILE
 * (relative to the repo root) is pointed at it; the file is also what the emulator is started with.
 * Used to classify a failure as NEW (fails on the candidate ruleset) or BASELINE (fails on HEAD's too).
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const suiteArg = process.argv[2];
if (!suiteArg) { console.error('usage: node scripts/run-rules-suite.js <suite.js> [rulesFile]'); process.exit(64); }
const rulesAbs = path.resolve(ROOT, process.argv[3] || 'firestore.rules.build');
if (!fs.existsSync(rulesAbs)) { console.error('rules file not found: ' + rulesAbs); process.exit(64); }
const FS_PORT = 18461, HUB_PORT = 18464, LOG_PORT = 18465;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rules-suite-'));
fs.copyFileSync(rulesAbs, path.join(dir, 'firestore.rules'));
const cfg = path.join(dir, 'firebase.json');
fs.writeFileSync(cfg, JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  emulators: { firestore: { port: FS_PORT }, hub: { port: HUB_PORT }, ui: { enabled: false }, logging: { port: LOG_PORT } },
}, null, 2));
const suite = path.resolve(ROOT, suiteArg).replace(/\\/g, '/');
/* Several legacy suites hardcode host 127.0.0.1:8080 in initializeTestEnvironment — whoever holds 8080
   would answer them. A preloaded hook rewrites the Firestore host/port to THIS private emulator; the
   suite's own code and rules text are otherwise untouched. */
const hook = path.join(dir, 'private-port-hook.js');
fs.writeFileSync(hook, `
const Module = require('module'); const orig = Module._load;
const [H, P] = (process.env.FIRESTORE_EMULATOR_HOST || '').split(':');
Module._load = function (req, ...rest) {
  const m = orig.call(this, req, ...rest);
  if (req === '@firebase/rules-unit-testing' && m && m.initializeTestEnvironment && !m.__privatePort) {
    const init = m.initializeTestEnvironment;
    const wrapped = Object.assign({}, m, { __privatePort: true, initializeTestEnvironment: (cfg) => init(Object.assign({}, cfg, { firestore: Object.assign({}, cfg && cfg.firestore, { host: H, port: Number(P) }) })) });
    return wrapped;
  }
  return m;
};`);
const cmd = `npx firebase emulators:exec --project demo-rules-suite --config "${cfg}" --only firestore "node -r ${hook.replace(/\\/g, '/')} ${suite}"`;
const r = spawnSync(cmd, { cwd: dir, shell: true, stdio: 'inherit',
  env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules'), RULES_FILE: path.relative(ROOT, rulesAbs), FIRESTORE_EMULATOR_HOST: `127.0.0.1:${FS_PORT}` } });
fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status == null ? 2 : r.status);
