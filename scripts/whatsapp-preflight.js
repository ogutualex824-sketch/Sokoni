#!/usr/bin/env node
/* ============================================================================
   scripts/whatsapp-preflight.js
   ============================================================================
   Read-only readiness check for the WhatsApp rail. It answers ONE question per
   row — "is this actually in place?" — and refuses to guess.

   WHY A CHECKER RATHER THAN A CHECKLIST
   --------------------------------------
   A checklist records what someone believed when they wrote it. Provisioning
   spans Meta's console, Secret Manager, a Git export and a deploy, and every
   one of those can be done, half-done, or done in the wrong project. This reads
   the actual state each time, so "ready" is a measurement rather than a memory.

   THE VOCABULARY IS THE PLATFORM'S, AND IT IS NOT COLLAPSED
   ----------------------------------------------------------
     observed       checked, and it is there
     absent         checked, and it is NOT there
     unreadable     could not check — NOT the same as absent
     not-attempted  deliberately not checked here
     n/a            the question does not apply

   `unreadable` never becomes `absent`. An unreadable Secret Manager reported as
   "secret missing" invites someone to create a credential that already exists,
   which is precisely the RC-1 defect this platform already paid for.

   IT NEVER READS A SECRET VALUE. `secrets list` returns NAMES and metadata;
   `versions access` returns payloads and is never called.
   ============================================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');

const wa = require(path.join(ROOT, 'functions/whatsapp-webhook.js'));
const PROJECT = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
const REGION = 'us-central1';
const FN_NAME = 'webhookWhatsapp';   /* house convention: webhook<Provider> */

const rows = [];
const add = (step, state, detail) => rows.push({ step, state, detail: detail || '' });

/* gcloud on Windows needs the bundled interpreter, or it fails with a Python
   error that is indistinguishable from "no results" — an empty answer that
   means "the tool broke", reported as "nothing found", is how a false all-clear
   gets made. */
function gcloud (args) {
  const env = Object.assign({}, process.env);
  if (!env.CLOUDSDK_PYTHON) {
    const bundled = path.join(process.env.LOCALAPPDATA || '',
      'Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe');
    if (fs.existsSync(bundled)) env.CLOUDSDK_PYTHON = bundled;
  }
  /* shell: true is required, not preferred. Node 24 on Windows refuses to spawn
     a .cmd shim directly (EINVAL), and gcloud is exactly that. The first run of
     this checker hit it — and reported `unreadable` rather than `absent`, which
     is the vocabulary doing its job: a broken tool must never read as "the
     secret is not there".

     With a shell the arguments go through a command line, so each is quoted. */
  if (process.platform === 'win32') {
    const q = (s) => '"' + String(s).replace(/"/g, '\\"') + '"';
    return execSync('gcloud.cmd ' + args.map(q).join(' '),
      { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return execFileSync('gcloud', args, { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/* ── 1 · THE SECRETS ───────────────────────────────────────────────────────
   Names only, with a POSITIVE CONTROL: an existing secret must be found by the
   same query. Without it, an empty result cannot be told apart from a query
   that matches nothing it should. */
function checkSecrets () {
  let names;
  try {
    names = gcloud(['secrets', 'list', '--project', PROJECT, '--format=value(name)'])
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    const why = String((e && e.message) || 'gcloud failed').split('\n')[0].slice(0, 90);
    add('Secret Manager readable', 'unreadable', why);
    Object.values(wa.SECRET_NAMES).forEach((n) =>
      add('secret ' + n, 'unreadable', 'inventory could not be read — NOT evidence of absence'));
    return;
  }
  add('Secret Manager readable', 'observed', names.length + ' secrets in ' + PROJECT);

  const control = names.indexOf('FACEBOOK_APP_SECRET') > -1;
  add('POSITIVE CONTROL — a known secret is found', control ? 'observed' : 'absent',
      control ? 'FACEBOOK_APP_SECRET' : 'the control is MISSING: an absent result below proves nothing');

  Object.keys(wa.SECRET_NAMES).forEach((k) => {
    const n = wa.SECRET_NAMES[k];
    add('secret ' + n, names.indexOf(n) > -1 ? 'observed' : 'absent',
        names.indexOf(n) > -1 ? '' : 'create before exporting the function');
  });
}

/* ── 2 · THE CODE ──────────────────────────────────────────────────────────
   Committed state, not working-tree state: a deploy ships what is committed. */
function checkCode () {
  const modPath = path.join(ROOT, 'functions/whatsapp-webhook.js');
  add('receiver module present', fs.existsSync(modPath) ? 'observed' : 'absent',
      'functions/whatsapp-webhook.js');

  const index = fs.readFileSync(path.join(ROOT, 'functions/index.js'), 'utf8');
  const exported = /require\(['"]\.\/whatsapp-webhook['"]\)/.test(index);
  add('exported from functions/index.js', exported ? 'observed' : 'absent',
      exported ? '' : 'INTENTIONALLY absent until the secrets exist — exporting binds ' +
                      'defineSecret and would break the next functions deploy');

  try {
    const suite = execFileSync(process.execPath,
      [path.join(ROOT, 'scripts/test-whatsapp-webhook.js')],
      { encoding: 'utf8', cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    const m = /(\d+) passed, (\d+) failed/.exec(suite);
    add('receiver certification', m && m[2] === '0' ? 'observed' : 'absent', m ? m[0] : 'no tally');
  } catch (e) {
    add('receiver certification', 'absent', 'the suite exited non-zero');
  }
}

/* ── 3 · THE DEPLOYED FUNCTION ─────────────────────────────────────────────── */
function checkDeployed () {
  let out;
  try {
    out = gcloud(['functions', 'describe', FN_NAME, '--region', REGION,
      '--project', PROJECT, '--format=value(serviceConfig.uri)']).trim();
  } catch (e) {
    const msg = String((e && e.message) || '');
    /* 404 / 'was not found' is what gcloud actually returns for an undeployed
       function — the first run classified it as unreadable because the pattern
       did not match the real message. An ABSENT function is a known fact; only
       an unrecognised failure stays unreadable. */
    if (/status=[404]|was not found|NOT_FOUND|does not exist|Could not find/i.test(msg)) {
      add('function deployed', 'absent', FN_NAME + ' is not deployed');
      add('callback URL', 'n/a', 'there is no endpoint until it is deployed');
      return;
    }
    add('function deployed', 'unreadable', msg.split('\n')[0].slice(0, 90));
    add('callback URL', 'unreadable', '');
    return;
  }
  add('function deployed', out ? 'observed' : 'absent', out || '');
  add('callback URL', out ? 'observed' : 'absent',
      out || 'give this to Meta as the webhook URL once deployed');
}

/* ── 4 · WHAT ONLY META CAN TELL US ────────────────────────────────────────
   Named rather than omitted. A checklist that stops at our own boundary
   implies everything beyond it is fine. */
function checkMetaSide () {
  ['WhatsApp Business Account (WABA)', 'business phone number + phone-number-id',
   'webhook subscribed in the Meta app', 'verification handshake completed']
    .forEach((s) => add(s, 'not-attempted', 'lives in the Meta console; not observable from here'));
}

checkSecrets();
checkCode();
checkDeployed();
checkMetaSide();

/* ── REPORT ────────────────────────────────────────────────────────────────── */
const MARK = { observed: '[ok]', absent: '[--]', unreadable: '[??]',
               'not-attempted': '[  ]', 'n/a': '[n/a]' };
const width = rows.reduce((m, r) => Math.max(m, r.step.length), 0);
console.log('\n  WhatsApp rail preflight — project ' + PROJECT + '\n');
rows.forEach((r) => console.log('  ' + (MARK[r.state] || '[?]').padEnd(6) +
  r.step.padEnd(width + 2) + r.state.padEnd(15) + r.detail));

const counts = rows.reduce((m, r) => { m[r.state] = (m[r.state] || 0) + 1; return m; }, {});
console.log('\n  ' + Object.keys(counts).map((k) => k + '=' + counts[k]).join(' · '));

const blockers = rows.filter((r) => r.state === 'absent' &&
  !/exported from|function deployed|callback URL/.test(r.step));
const unreadable = rows.filter((r) => r.state === 'unreadable');

if (unreadable.length) {
  console.log('\n  NOT READY — and partly UNKNOWN. ' + unreadable.length + ' check(s) could not be');
  console.log('  made, which is not the same as passing them.');
} else if (blockers.length) {
  console.log('\n  NOT READY. Next: ' + blockers.map((b) => b.step).join(', '));
} else {
  console.log('\n  Secrets and code are in place. The Meta-side rows above are');
  console.log('  NOT-ATTEMPTED, so this does not say the rail works.');
}
console.log('');
process.exit(0);   /* a report, not a gate: it never fails a build */
