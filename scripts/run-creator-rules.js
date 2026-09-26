/* run-creator-rules.js — start PRIVATE-PORT Firestore + Storage emulators and
 * run scripts/test-creator-rules.js against them. Private ports (not 8080/9199)
 * so this can never hit — or be hit by — another agent's emulator.
 *
 *   node scripts/run-creator-rules.js
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const FS_PORT = 18381, ST_PORT = 18382, UI_PORT = 18383, HUB_PORT = 18384;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'creator-rules-'));
const cfg = path.join(dir, 'firebase.json');
/* Rules here only satisfy the CLI; the suite loads the served text itself. */
fs.copyFileSync(path.join(ROOT, 'firestore.rules.build'), path.join(dir, 'firestore.rules'));
fs.copyFileSync(path.join(ROOT, 'storage.rules'), path.join(dir, 'storage.rules'));
fs.writeFileSync(cfg, JSON.stringify({
  firestore: { rules: 'firestore.rules' },
  storage: { rules: 'storage.rules' },
  emulators: { firestore: { port: FS_PORT }, storage: { port: ST_PORT }, hub: { port: HUB_PORT }, ui: { enabled: false, port: UI_PORT }, logging: { port: 18385 } },
}, null, 2));
const suite = path.join(__dirname, 'test-creator-rules.js').replace(/\\/g, '/');
const env = { ...process.env, FIREBASE_STORAGE_EMULATOR_HOST: `127.0.0.1:${ST_PORT}` };
const cmd = `npx firebase emulators:exec --project demo-creator-rules --config "${cfg}" --only firestore,storage "node ${suite}"`;
const r = spawnSync(cmd, { cwd: dir, env, stdio: 'inherit', shell: true });
fs.rmSync(dir, { recursive: true, force: true });
process.exit(r.status == null ? 2 : r.status);
