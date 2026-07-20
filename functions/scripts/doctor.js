'use strict';
/**
 * SOKONI — environment & Admin SDK doctor.
 *
 *   node functions/scripts/doctor.js
 *   node functions/scripts/doctor.js --json
 *
 * Turns "invalid_client" into a report that says which credential source was
 * tried, why it failed, and the one action that fixes it.
 *
 * READ-ONLY AND SECRET-SAFE
 *  - reads no user records and lists no users
 *  - never prints a token, key, private_key or client_secret
 *  - modifies no credential, no claim and no document
 *  - the only Firestore read is a single doc in _systemConfig, to prove
 *    connectivity; the only Auth call is a listUsers(1) reachability probe
 *    whose RESULT is discarded and never displayed
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const JSON_OUT = process.argv.includes('--json');
const rows = [];
const add = (name, status, detail, fix) => rows.push({ name, status, detail: detail || '', fix: fix || null });

const PASS = 'PASS', FAIL = 'FAIL', WARN = 'WARN', SKIP = 'SKIP';

/* Never echo a credential. Shows enough to identify a value, never enough to use it. */
function redact(v) {
  if (!v) return '(unset)';
  const s = String(v);
  if (s.length <= 12) return s;
  return s.slice(0, 6) + '…' + s.slice(-4) + ' (' + s.length + " chars)";
}

/* Probing CLI tools on Windows needs care, and getting it wrong produces
   confident wrong answers. Two traps hit this script in its first two runs:

     1. `firebase` and `gcloud` are .cmd shims. Bare execFileSync gives ENOENT
        (no PATHEXT), and execFileSync('firebase.cmd') gives EINVAL — Node 24
        refuses to spawn a .cmd without a shell. The tool is installed and
        working; the probe simply could not launch it. The report claimed "not
        on PATH" for a CLI I had just used successfully.
     2. Windows ships a `python` App Execution Alias that EXITS SUCCESSFULLY
        while printing "Python was not found". Treating any output as a version
        marks a missing interpreter as PASS.

   So: use a shell on Windows, and require the output to actually look like a
   version before believing it. */
const VERSION_RE = /\d+\.\d+/;

function tryExec(cmd, args) {
  const useShell = process.platform === 'win32';
  let out = null;
  try {
    out = execFileSync(cmd, args, {
      encoding: 'utf8', timeout: 25000, stdio: ['ignore', 'pipe', 'pipe'], shell: useShell,
    });
  } catch (e) {
    out = (e && (e.stdout || e.stderr)) ? String(e.stdout || e.stderr) : null;
  }
  if (!out) return null;
  const text = out.trim();
  if (!text) return null;
  /* "Python was not found…" and "'x' is not recognized…" contain no version. */
  if (/was not found|not recognized|command not found/i.test(text)) return null;
  return VERSION_RE.test(text) ? text : null;
}

/* ── PHASE 1 — environment ─────────────────────────────────────────────── */
function phaseEnvironment() {
  const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
  add('Node.js', nodeMajor >= 18 ? PASS : FAIL, process.version + ' on ' + os.platform() + '/' + os.arch(),
    nodeMajor >= 18 ? null : 'Firebase Admin SDK v12 requires Node 18+.');

  const fb = tryExec('firebase', ['--version']);
  add('Firebase CLI', fb ? PASS : WARN, fb || 'not on PATH',
    fb ? null : 'Not required for the Admin SDK, but useful: npm i -g firebase-tools');

  /* gcloud matters only because it is how ADC is normally refreshed.

     Probed with a real SUBCOMMAND, not --version. On Windows `gcloud --version`
     is answered by a shim that does not need Python, so it reports a healthy
     SDK while every command that does anything fails. An earlier version of
     this script passed gcloud on that basis — a green tick on a tool that
     cannot run a single useful command. */
  /* gcloud SHIPS ITS OWN PYTHON. If the system `python` is missing, gcloud only
     fails because CLOUDSDK_PYTHON is unset — it never looks in its own install
     directory. This cost this project two separate diagnoses ("gcloud absent",
     then "install Python 3") before anyone looked in the SDK folder. Detect the
     bundled interpreter and use it, rather than reporting a broken toolchain
     that is one environment variable away from working. */
  if (!process.env.CLOUDSDK_PYTHON) {
    const candidates = [
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'platform', 'bundledpython', 'python.exe'),
      path.join('C:', 'Program Files (x86)', 'Google', 'Cloud SDK', 'google-cloud-sdk', 'platform', 'bundledpython', 'python.exe'),
    ];
    const found = candidates.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (found) {
      process.env.CLOUDSDK_PYTHON = found;
      add('gcloud bundled Python', PASS, 'found and used — ' + found.slice(-46),
        'Set CLOUDSDK_PYTHON permanently so gcloud works in every shell.');
    }
  }

  const gcVersion = tryExec('gcloud', ['--version']);

  /* Exit code, not output. tryExec insists on version-like text — correct for a
     --version probe, wrong here: `gcloud config list --format=none` succeeds
     while printing nothing, so tryExec discarded a passing result and the
     report claimed the SDK was broken when it had just been repaired. */
  const gcWorks = (() => {
    try {
      execFileSync('gcloud', ['config', 'get-value', 'project'], {
        encoding: 'utf8', timeout: 60000, stdio: ['ignore', 'pipe', 'pipe'],
        shell: process.platform === 'win32',
      });
      return true;
    } catch (_) { return false; }
  })();
  add('gcloud CLI', gcWorks ? PASS : WARN,
    gcWorks ? (gcVersion || 'ok').split('\n')[0]
            : gcVersion
              ? 'installed (' + gcVersion.split('\n')[0] + ') but SUBCOMMANDS FAIL — Python missing'
              : 'not on PATH',
    gcWorks ? null
            : 'Install Python 3 and reopen the shell, then `gcloud auth application-default login` ' +
              'refreshes ADC without needing a downloadable key.');

  const py = tryExec('python', ['--version']) || tryExec('python3', ['--version']);
  add('Python (system)', py ? PASS : (gcWorks ? SKIP : WARN),
    py ? py : (gcWorks ? 'absent, and not needed — gcloud uses its bundled interpreter'
                       : 'absent, and gcloud has no bundled interpreter either'),
    (py || gcWorks) ? null : 'Install Python 3 so gcloud can run.');
}

/* ── PHASE 3 — credential discovery ───────────────────────────────────────
   Reported in the order the Admin SDK actually consults them, so the report
   reads the same way the failure happens. */
function phaseCredentials() {
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac) {
    if (!fs.existsSync(gac)) {
      add('GOOGLE_APPLICATION_CREDENTIALS', FAIL, 'set but the file does not exist: ' + gac,
        'Fix the path or unset the variable.');
    } else {
      let kind = 'unreadable', proj = null, email = null, ok = false;
      try {
        const j = JSON.parse(fs.readFileSync(gac, 'utf8'));
        kind = j.type || 'unknown';
        proj = j.project_id || null;
        email = j.client_email || null;
        ok = kind === 'service_account' && !!j.private_key && !!proj;
      } catch (_) {}
      add('GOOGLE_APPLICATION_CREDENTIALS', ok ? PASS : FAIL,
        'type=' + kind + (proj ? ' project=' + proj : '') +
        (email ? ' sa=' + email.split('@')[0] + '@…' : ''),
        ok ? null : 'File is not a valid service-account key.');
    }
  } else {
    add('GOOGLE_APPLICATION_CREDENTIALS', SKIP, 'unset — falling through to ADC');
  }

  const adcPath = process.platform === 'win32'
    ? path.join(process.env.APPDATA || '', 'gcloud', 'application_default_credentials.json')
    : path.join(os.homedir(), '.config', 'gcloud', 'application_default_credentials.json');

  if (!fs.existsSync(adcPath)) {
    add('Application Default Credentials', SKIP, 'no ADC file at ' + adcPath);
  } else {
    let t = 'unknown', hasRefresh = false, age = null;
    try {
      const j = JSON.parse(fs.readFileSync(adcPath, 'utf8'));
      t = j.type || 'unknown';
      hasRefresh = !!j.refresh_token;
      age = Math.round((Date.now() - fs.statSync(adcPath).mtimeMs) / 86400000);
    } catch (_) {}
    /* Present is not the same as valid — an authorized_user ADC whose refresh
       token has been revoked looks identical on disk to a working one. Only the
       live probe below can tell them apart, so this is a WARN, never a PASS. */
    add('Application Default Credentials', WARN,
      'type=' + t + ' refresh_token=' + hasRefresh + (age !== null ? ' age=' + age + 'd' : '') +
      ' — presence does not prove validity',
      'If the probe below fails with invalid_client, this token is revoked.');
  }

  const projEnv = process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || null;
  add('Project ID (env)', projEnv ? PASS : SKIP, projEnv || 'unset — scripts default to sokoni-aeb26');
}

/* ── PHASE 2 + 6 — live Admin SDK probes ─────────────────────────────────── */
async function phaseAdminSdk() {
  let admin;
  try {
    admin = require('firebase-admin');
  } catch (e) {
    add('Admin SDK module', FAIL, e.message, 'Run npm install inside functions/.');
    return null;
  }
  add('Admin SDK module', PASS, 'firebase-admin loaded');

  const projectId = process.env.GCLOUD_PROJECT || 'sokoni-aeb26';
  let app;
  try {
    app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId });
    add('admin.initializeApp()', PASS, 'projectId=' + projectId +
      ' — note this succeeds even with bad credentials; they are resolved lazily');
  } catch (e) {
    add('admin.initializeApp()', FAIL, e.message);
    return null;
  }

  /* The real test. Credentials are only exercised on the first authenticated
     call, which is why initializeApp() above is not evidence of anything. */
  const classify = (e) => {
    const m = String((e && e.message) || e);
    if (/invalid_client/i.test(m)) {
      /* Recommend the SAFER fix when it is actually available. gcloud working
         means a scoped, revocable user credential is one command away, and a
         downloadable full-project key is no longer the only option — which is
         what earlier reports wrongly concluded when gcloud looked broken. */
      const viaGcloud = !!process.env.CLOUDSDK_PYTHON || !!tryExec('gcloud', ['--version']);
      return ['Stored credentials are REVOKED (invalid_client). The file exists; the token behind it no longer works.',
        viaGcloud
          ? 'gcloud is working. Run: gcloud auth login  then  gcloud auth application-default login. Scoped, revocable, no key file. (Set CLOUDSDK_PYTHON to the bundled interpreter first if gcloud complains about Python.)'
          : 'Generate a service-account key: Firebase Console -> Project Settings -> Service Accounts -> Generate new private key, then set GOOGLE_APPLICATION_CREDENTIALS to it.'];
    }
    if (/Could not load the default credentials|Unable to detect a Project Id|default credentials/i.test(m)) {
      return ['No credentials found at all.',
        'Set GOOGLE_APPLICATION_CREDENTIALS to a service-account key.'];
    }
    if (/PERMISSION_DENIED|permission-denied|IAM/i.test(m)) {
      return ['Credentials are valid but lack permission on this project.',
        'The service account needs Firebase Admin / Editor on ' + projectId + '.'];
    }
    if (/API .* not enabled|SERVICE_DISABLED/i.test(m)) {
      return ['A required Google API is disabled on the project.', 'Enable it in the Cloud Console and retry.'];
    }
    if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|network/i.test(m)) {
      return ['Network could not reach Google APIs.', 'Check connectivity or proxy settings.'];
    }
    return [m.slice(0, 160), null];
  };

  let authOk = false;
  try {
    /* Reachability only — listUsers(1) is the smallest authenticated Auth call.
       The result is DISCARDED and never displayed; no user data is read out. */
    await admin.auth().listUsers(1);
    authOk = true;
    add('Firebase Auth access', PASS, 'authenticated (probe result discarded, no user data read)');
  } catch (e) {
    const [detail, fix] = classify(e);
    add('Firebase Auth access', FAIL, detail, fix);
  }

  try {
    await admin.firestore().collection('_systemConfig').doc('bootstrap').get();
    add('Firestore access', PASS, 'read _systemConfig/bootstrap');
  } catch (e) {
    const [detail, fix] = classify(e);
    add('Firestore access', FAIL, detail, fix);
  }

  return authOk;
}

/* ── PHASE 9 — secret hygiene ────────────────────────────────────────────── */
function phaseSecurity() {
  let gi = '';
  try { gi = fs.readFileSync('.gitignore', 'utf8'); } catch (_) {}
  const protectedSa = /service-account|firebase-adminsdk/i.test(gi);
  add('.gitignore protects keys', protectedSa ? PASS : FAIL,
    protectedSa ? '*service-account*.json and *firebase-adminsdk*.json ignored' : 'no service-account pattern found',
    protectedSa ? null : 'Add *service-account*.json and *firebase-adminsdk*.json to .gitignore.');

  /* A key inside the working tree is one `git add -A` from being published. */
  const stray = [];
  const scan = (dir, depth) => {
    if (depth > 2) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { scan(p, depth + 1); continue; }
      if (!e.name.endsWith('.json')) continue;
      try {
        const head = fs.readFileSync(p, 'utf8').slice(0, 400);
        if (/"type"\s*:\s*"service_account"/.test(head)) stray.push(p);
      } catch (_) {}
    }
  };
  scan('.', 0);
  add('No key inside the repo', stray.length === 0 ? PASS : FAIL,
    stray.length ? stray.join(', ') : 'none found',
    stray.length ? 'Move it outside the working tree and rotate it — it may already be in git history.' : null);

  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac) {
    const inside = path.resolve(gac).startsWith(path.resolve('.'));
    add('Key stored outside the tree', inside ? WARN : PASS,
      inside ? 'key is inside the repo directory' : 'outside the working tree',
      inside ? 'Move it elsewhere; gitignore is a safety net, not a guarantee.' : null);
  }
}

/* ── report ─────────────────────────────────────────────────────────────── */
(async () => {
  phaseEnvironment();
  phaseCredentials();
  const authOk = await phaseAdminSdk();
  phaseSecurity();

  const counts = rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
  const ready = !!authOk && !rows.some((r) => r.status === FAIL && /Firestore|Auth/.test(r.name));

  if (JSON_OUT) {
    console.log(JSON.stringify({ ready, counts, rows }, null, 2));
    process.exit(ready ? 0 : 1);
  }

  const icon = { PASS: '✓', FAIL: '✗', WARN: '!', SKIP: '·' };
  console.log('\n' + '═'.repeat(78));
  console.log('  SOKONI — environment & Admin SDK doctor');
  console.log('═'.repeat(78));
  rows.forEach((r) => {
    console.log('  ' + (icon[r.status] || '?') + ' ' + r.name.padEnd(34) + r.status);
    if (r.detail) console.log('      ' + r.detail);
  });
  console.log('═'.repeat(78));
  console.log('  ' + Object.entries(counts).map(([k, v]) => k + ' ' + v).join('  ·  '));

  const fixes = rows.filter((r) => r.status === FAIL && r.fix);
  if (fixes.length) {
    console.log('\n  TO FIX, IN ORDER:');
    fixes.forEach((r, i) => {
      console.log('    ' + (i + 1) + '. ' + r.name);
      console.log('       ' + r.fix);
    });
  }

  console.log('\n  BOOTSTRAP READINESS: ' + (ready ? 'READY' : 'NOT READY'));
  console.log(ready
    ? '  Next: node functions/scripts/seed-bootstrap.js --phone +254705726803 --dry-run\n'
    : '  seed-bootstrap and set-admin-claim will fail until the above is resolved.\n');

  process.exit(ready ? 0 : 1);
})();
