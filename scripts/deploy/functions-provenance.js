#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FUNCTIONS PROVENANCE — read what revision a DEPLOYED function is running
   ══════════════════════════════════════════════════════════════════════════════
   The chain, established empirically (B1.1):

     gcloud functions describe <fn> --region <r>
        -> buildConfig.source.storageSource {bucket, object, generation}
        -> gs://<bucket>/<object>#<generation>          immutable, per function
        -> the archive is functions/ VERBATIM
        -> functions/build-info.js inside it            the deployed commit

   Proven across a callable, a Firestore trigger, a DYNAMICALLY EXPORTED trigger
   (Object.assign) and both regions: functions from one release share a
   byte-identical archive; a later release has a different one. So a per-function
   read is truthful about which release THAT function came from.

   DELIBERATELY NOT USED: the `firebase-functions-hash` label. It is a
   per-function config hash, not a commit, and firebase-tools rewrites the label
   set on every deploy. There is no fallback to it — see classify().

   ENVIRONMENT NOTES (learned the hard way on this machine)
     * gcloud needs CLOUDSDK_PYTHON pointed at the SDK's bundled interpreter, or
       every call dies with "Python was not found".
     * gcloud writes this output to stderr and resists shell capture, so every
       call here redirects to a FILE and reads the file back.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCHEMA_VERSION = 1;
const SHA_RE = /^[0-9a-f]{40}$/i;

const BUNDLED_PYTHON =
  'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';

function gcloudEnv () {
  const env = Object.assign({}, process.env);
  if (!env.CLOUDSDK_PYTHON && fs.existsSync(BUNDLED_PYTHON)) env.CLOUDSDK_PYTHON = BUNDLED_PYTHON;
  return env;
}

/* Run gcloud, capturing via a file because shell capture is unreliable here.
   Returns { ok, text, why }. Never throws — callers decide what a failure means,
   and for this guard every failure means REFUSE. */
function gcloud (args, timeoutMs) {
  const out = path.join(os.tmpdir(), 'fnprov-' + process.pid + '-' + Math.random().toString(36).slice(2) + '.txt');
  try {
    cp.execSync('gcloud ' + args + ' > "' + out + '" 2>&1', {
      env: gcloudEnv(), timeout: timeoutMs || 120000, stdio: 'ignore', shell: true,
    });
  } catch (e) {
    /* fall through — the file usually still holds gcloud's own error text */
  }
  let text = '';
  try { text = fs.readFileSync(out, 'utf8'); } catch (e) { /* nothing written */ }
  try { fs.unlinkSync(out); } catch (e) {}
  if (!text.trim()) return { ok: false, text: '', why: 'gcloud produced no output' };
  if (/^ERROR:/m.test(text)) return { ok: false, text: text, why: (text.match(/^ERROR:.*/m) || [''])[0].trim() };
  return { ok: true, text: text };
}

/* ── the candidate side: read the stamp from the working tree ───────────────── */
function readCandidateStamp (root) {
  const p = path.join(root || ROOT, 'functions', 'build-info.js');
  if (!fs.existsSync(p)) return { ok: false, why: 'functions/build-info.js is absent from the candidate' };
  let mod;
  try {
    delete require.cache[require.resolve(p)];
    mod = require(p);
  } catch (e) {
    return { ok: false, why: 'candidate build-info.js does not load: ' + e.message };
  }
  return validateStamp(mod, 'candidate');
}

/* ── validation. A stamp that is present but wrong is worse than absent. ────── */
function validateStamp (obj, label) {
  if (!obj || typeof obj !== 'object') return { ok: false, why: label + ' stamp is not an object' };
  if (obj.schemaVersion !== SCHEMA_VERSION) {
    return { ok: false, why: label + ' stamp schemaVersion is ' + JSON.stringify(obj.schemaVersion) + ', expected ' + SCHEMA_VERSION };
  }
  if (!SHA_RE.test(String(obj.commit || ''))) {
    return { ok: false, why: label + ' stamp commit is not a 40-hex sha: ' + JSON.stringify(obj.commit) };
  }
  return { ok: true, stamp: obj };
}

/* ── the live side: find a deployed function's source archive ───────────────── */
function describeDeployed (fnName, region, project) {
  const r = gcloud('functions describe "' + fnName + '" --region=' + region +
    ' --project=' + project + ' --format=json');
  if (!r.ok) return { ok: false, why: 'cannot describe ' + fnName + ' in ' + region + ': ' + r.why };
  let j;
  try { j = JSON.parse(r.text); } catch (e) { return { ok: false, why: 'describe output is not JSON for ' + fnName }; }
  const src = j && j.buildConfig && j.buildConfig.source && j.buildConfig.source.storageSource;
  if (!src || !src.bucket || !src.object) {
    return { ok: false, why: fnName + ' has no buildConfig.source.storageSource (Gen1, or not deployed from source)' };
  }
  return {
    ok: true,
    bucket: src.bucket,
    object: src.object,
    generation: src.generation ? String(src.generation) : '',
    updateTime: j.updateTime || '',
  };
}

/* Pin to the generation so we read the exact deployed artifact, not whatever
   currently sits at that path. */
function archiveUrl (loc) {
  return 'gs://' + loc.bucket + '/' + loc.object + (loc.generation ? '#' + loc.generation : '');
}

function fetchDeployedStamp (fnName, region, project) {
  const loc = describeDeployed(fnName, region, project);
  if (!loc.ok) return { ok: false, why: loc.why };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnprov-'));
  const zip = path.join(dir, 'src.zip');
  /* GCS downloads flake. One transient failure previously turned five section-3b
     assertions red on a stamp that was demonstrably present. Retry once before
     concluding anything — and note the caller still distinguishes a FAILED READ
     from an ABSENT stamp, because only the second is a real provenance failure. */
  let dl = gcloud('storage cp "' + archiveUrl(loc) + '" "' + zip + '" --project=' + project, 180000);
  if (!fs.existsSync(zip)) {
    dl = gcloud('storage cp "' + archiveUrl(loc) + '" "' + zip + '" --project=' + project, 180000);
  }
  if (!fs.existsSync(zip)) {
    cleanup(dir);
    return { ok: false, why: 'could not download ' + archiveUrl(loc) + (dl.why ? ' — ' + dl.why : '') };
  }

  /* -p writes to stdout; -o to a directory. Directory form, because stdout
     capture is exactly what is unreliable in this environment. */
  let extracted = false;
  try {
    cp.execSync('unzip -o -q "' + zip + '" build-info.js -d "' + dir + '"', { stdio: 'ignore', shell: true });
    extracted = fs.existsSync(path.join(dir, 'build-info.js'));
  } catch (e) { extracted = false; }

  if (!extracted) {
    cleanup(dir);
    return {
      ok: false,
      absent: true,
      archive: archiveUrl(loc),
      updateTime: loc.updateTime,
      why: 'the deployed archive for ' + fnName + ' contains no build-info.js (deployed before provenance existed)',
    };
  }

  let mod;
  try {
    const txt = fs.readFileSync(path.join(dir, 'build-info.js'), 'utf8');
    const m = txt.match(/module\.exports\s*=\s*(\{[\s\S]*?\})\s*;/);
    if (!m) throw new Error('no module.exports object literal found');
    mod = JSON.parse(m[1]);
  } catch (e) {
    cleanup(dir);
    return { ok: false, why: 'deployed build-info.js for ' + fnName + ' is malformed: ' + e.message };
  }
  cleanup(dir);

  const v = validateStamp(mod, 'deployed(' + fnName + ')');
  if (!v.ok) return v;
  return { ok: true, stamp: v.stamp, archive: archiveUrl(loc), updateTime: loc.updateTime };
}

function cleanup (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }

/* ── the decision. Lineage, never equality. ─────────────────────────────────────
   Equality alone would let a candidate built on an older tree replace a newer
   live payment fix, because the shas merely "differ". The question is whether
   the live commit is CONTAINED in the candidate. */
function classify (liveCommit, candidateCommit, root) {
  if (!SHA_RE.test(String(liveCommit || ''))) return { verdict: 'REFUSE', why: 'live commit is not a 40-hex sha' };
  if (!SHA_RE.test(String(candidateCommit || ''))) return { verdict: 'REFUSE', why: 'candidate commit is not a 40-hex sha' };
  if (liveCommit === candidateCommit) return { verdict: 'NOOP', why: 'candidate is identical to what is deployed' };

  const opts = { cwd: root || ROOT, stdio: 'ignore' };
  /* NO `^{commit}` here: execSync goes through cmd.exe on Windows, where `^` is
     the escape character, so the suffix is silently stripped and EVERY existence
     check fails — which read as 'live commit unknown' and turned a legitimate
     ALLOW into a REFUSE. `cat-file -t` needs no shell metacharacters. */
  const known = (sha) => {
    try {
      const t = cp.execSync('git cat-file -t ' + sha, { cwd: root || ROOT, encoding: 'utf8', stdio: ['ignore','pipe','ignore'] });
      return String(t).trim() === 'commit';
    } catch (e) { return false; }
  };
  if (!known(liveCommit)) return { verdict: 'REFUSE', why: 'the live commit ' + liveCommit.slice(0, 7) + ' is not in this object store — fetch it; an unknown live commit is treated as diverged' };
  if (!known(candidateCommit)) return { verdict: 'REFUSE', why: 'the candidate commit is not in this object store' };

  try {
    cp.execSync('git merge-base --is-ancestor ' + liveCommit + ' ' + candidateCommit, opts);
    return { verdict: 'ALLOW', why: 'candidate contains the deployed commit ' + liveCommit.slice(0, 7) };
  } catch (e) {
    return { verdict: 'REFUSE', why: 'DIVERGED — the deployed commit ' + liveCommit.slice(0, 7) + ' is not contained in the candidate; deploying would revert it' };
  }
}

module.exports = {
  SCHEMA_VERSION,
  readCandidateStamp,
  validateStamp,
  describeDeployed,
  fetchDeployedStamp,
  classify,
  archiveUrl,
  _gcloud: gcloud,
};
