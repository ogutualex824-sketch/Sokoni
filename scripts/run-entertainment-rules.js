/* run-entertainment-rules.js — start a PRIVATE-PORT Firestore emulator and run
 * scripts/test-entertainment-rules.js against it. Private ports (not 8080) so this can never hit —
 * or be hit by — another agent's emulator.
 *
 *   node scripts/run-entertainment-rules.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FS_PORT = 18391, HUB_PORT = 18394;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ent-rules-'));
const cfg = path.join(dir, 'firebase.json');
/* Rules here only satisfy the CLI; the suite loads the served text itself. */
fs.copyFileSync(path.join(ROOT, 'firestore.rules.build'), path.join(dir, 'firestore.rules'));
fs.writeFileSync(cfg, JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  emulators: { firestore: { port: FS_PORT }, hub: { port: HUB_PORT }, ui: { enabled: false }, logging: { port: 18395 } },
}, null, 2));
const suite = path.join(__dirname, 'test-entertainment-rules.js').replace(/\\/g, '/');
const cmd = `npx firebase emulators:exec --project demo-ent-rules --config "${cfg}" --only firestore "node ${suite}"`;
const r = spawnSync(cmd, { cwd: dir, env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') }, stdio: 'inherit', shell: true });
fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status == null ? 2 : r.status);
