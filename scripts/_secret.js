'use strict';
/**
 * scripts/_secret.js — fetch a Firebase secret WITHOUT ever letting the value
 * reach stdout, stderr, or an error dump.
 *
 * Why this exists: calling
 *   execSync('firebase functions:secrets:access NAME')
 * captures the value into the child-process result — and if the CLI exits
 * non-zero (the firebase CLI hits a libuv assertion on Windows *after* printing
 * the value), Node throws an Error whose `output` array contains that stdout
 * and prints the whole object. That leaked an admin key into a session
 * transcript once; this module exists so it cannot happen again.
 *
 * Guarantees:
 *   - stdout is captured to a pipe, never inherited
 *   - on failure we throw a SCRUBBED error that carries no captured output
 *   - the value is returned to the caller only; nothing here logs it
 */
const { spawnSync } = require('child_process');

function getSecret(name, project) {
  /* shell:true is required on Windows to resolve npx.cmd via PATHEXT. */
  const res = spawnSync(
    'npx',
    ['-y', 'firebase-tools@latest', 'functions:secrets:access', name,
     '--project', project || 'sokoni-aeb26'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], shell: true }
  );

  /* Take stdout regardless of exit code: the CLI can print the value and THEN
     crash on exit. Never surface res.stderr/res.error verbatim — on some
     failures the runtime echoes captured stdout alongside it. */
  const value = (res.stdout || '').trim();
  if (value) return value;

  throw new Error(
    'Could not read secret "' + name + '" (exit ' + res.status +
    '). Value withheld from this error deliberately.'
  );
}

module.exports = { getSecret };
