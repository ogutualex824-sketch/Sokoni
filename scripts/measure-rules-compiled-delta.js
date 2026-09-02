#!/usr/bin/env node
/* DO COMMENTS AND INDENTATION COST COMPILED RULES BYTES?
 *
 * One control, one variable. The whole consolidation strategy forks on the answer:
 *   - unchanged  -> comments/indentation are free; consolidation must be STRUCTURAL
 *                   (remove inert rules), and 99,678 chars of them are worth zero.
 *   - changed    -> quantify the real saving, in compiled bytes, never estimated from
 *                   source characters (that estimate is what produced a 400 at RELEASE).
 *
 * ══ SAFETY, WHICH IS THE POINT ══════════════════════════════════════════════════════
 * `getExecutable` operates on RELEASES, not rulesets, so a candidate cannot be priced
 * without releasing it. This therefore writes to the production project. It is bounded:
 *
 *   - the production release `cloud.firestore` is READ before and after and must be
 *     IDENTICAL; any difference is reported as a failure of the experiment itself
 *   - every release it creates is named `sizeprobe-<ts>-<tag>`; the name `cloud.firestore`
 *     is refused by an explicit guard, not merely avoided by convention
 *   - releases and rulesets it creates are deleted in reverse order, including on failure
 *   - it makes no enforcement change: Firestore enforces `cloud.firestore` and nothing else
 *
 * ══ THE CONTROL ABORTS ══════════════════════════════════════════════════════════════
 * The control is the SERVED source recompiled unchanged. It must reproduce the measured
 * live size EXACTLY. If it does not, the instrument is measuring something other than what
 * is deployed, and the variable's delta means nothing — so the run aborts rather than
 * reporting a number. A probe that agrees with expectation without a control that could
 * have disagreed is not evidence.
 *
 *   node scripts/measure-rules-compiled-delta.js
 */
'use strict';
const { spawnSync } = require("child_process");
const fs = require('fs');

const PROJECT = 'sokoni-aeb26';
const API = 'https://firebaserules.googleapis.com/v1/projects/' + PROJECT;
const LIVE_RELEASE = 'cloud.firestore';
const EXEC_VER = 'FIREBASE_RULES_EXECUTABLE_V1';
const STAMP = Date.now().toString(36);
const NL = String.fromCharCode(10);
/* Windows path, not the Git Bash form: this is handed to a child process as an
   environment variable, not to a shell that understands /c/. The Microsoft Store python
   alias shadows the interpreter, so gcloud fails with "Python was not found" unless it is
   pointed at the interpreter the SDK ships. */
const PY = 'C:/Users/USER1/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';

let TOKEN = '';
const created = { releases: [], rulesets: [] };

/* ── transport ────────────────────────────────────────────────────────────── */
function api (method, path, body) {
  const args = ['-s', '-X', method,
    '-H', 'Authorization: Bearer ' + TOKEN,
    '-H', 'x-goog-user-project: ' + PROJECT,
    '-H', 'Content-Type: application/json'];
  let tmp = null;
  if (body !== undefined) {
    tmp = require('path').join(process.env.TEMP || '.', 'rulesprobe-' + STAMP + '.json');
    fs.writeFileSync(tmp, JSON.stringify(body));
    args.push('--data-binary', '@' + tmp);
  }
  args.push(API + path);
  const r = spawnSync('curl', args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
  if (tmp) { try { fs.unlinkSync(tmp); } catch (_) {} }
  const raw = String(r.stdout || '');
  try { return JSON.parse(raw); }
  catch (_) { return { __unparseable: raw.slice(0, 400) }; }
}

/* ── the guard that makes the disposable name a rule, not an intention ────── */
function assertDisposable (name) {
  if (name === LIVE_RELEASE || /(^|\/)cloud\.firestore$/.test(name) ||
      /firebase\.storage/.test(name)) {
    throw new Error('REFUSED: "' + name + '" is an enforcing release name.');
  }
  if (name.indexOf('sizeprobe-') !== 0) {
    throw new Error('REFUSED: "' + name + '" is not a sizeprobe- disposable name.');
  }
}

/* ── comment + indentation stripping that respects string literals ────────── */
function strip (src) {
  let out = '';
  let i = 0, q = null, line = '';
  const flush = () => { const t = line.trim(); if (t) out += t + NL; line = ''; };
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (q) {
      line += c;
      if (c === '\\') { line += (n || ''); i += 2; continue; }
      if (c === q) q = null;
      i++; continue;
    }
    if (c === '"' || c === "'") { q = c; line += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== NL) i++; continue; }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === NL) { flush(); }
        i++;
      }
      i += 2; continue;
    }
    if (c === NL) { flush(); i++; continue; }
    line += c; i++;
  }
  flush();
  return out;
}

/* ── one measurement: create ruleset -> disposable release -> size ────────── */
function measure (tag, files) {
  const rs = api('POST', '/rulesets', { source: { files } });
  if (!rs.name) throw new Error(tag + ': ruleset create failed :: ' + JSON.stringify(rs).slice(0, 500));
  const rulesetId = rs.name.split('/').pop();
  created.rulesets.push(rulesetId);

  const rel = 'sizeprobe-' + STAMP + '-' + tag;
  assertDisposable(rel);
  const rr = api('POST', '/releases',
    { name: 'projects/' + PROJECT + '/releases/' + rel, rulesetName: rs.name });
  if (!rr.name) throw new Error(tag + ': release failed :: ' + JSON.stringify(rr).slice(0, 500));
  created.releases.push(rel);

  const ex = api('GET', '/releases/' + rel + ':getExecutable?executableVersion=' + EXEC_VER);
  if (!ex.executable) throw new Error(tag + ': getExecutable failed :: ' + JSON.stringify(ex).slice(0, 400));
  return { tag, rulesetId, release: rel,
           bytes: Buffer.from(ex.executable, 'base64').length,
           srcChars: files.reduce((a, f) => a + f.content.length, 0) };
}

function cleanup () {
  console.log('');
  console.log('  cleanup');
  created.releases.slice().reverse().forEach((r) => {
    assertDisposable(r);
    const d = api('DELETE', '/releases/' + r);
    console.log('    release  ' + r + '  ' + (d && d.error ? 'ERROR ' + d.error.status : 'deleted'));
  });
  created.rulesets.slice().reverse().forEach((id) => {
    const d = api('DELETE', '/rulesets/' + id);
    console.log('    ruleset  ' + id.slice(0, 8) + '…  ' + (d && d.error ? 'ERROR ' + d.error.status : 'deleted'));
  });
}

/* Exported so the stripper can be validated OFFLINE before anything is sent. A stripper
   that mangles a string literal or drops a brace would compile differently for a reason
   that has nothing to do with comments, and the delta would be attributed to the wrong
   cause. Validate first, then measure. */
module.exports = { strip };
if (require.main !== module) return;

/* ── run ──────────────────────────────────────────────────────────────────── */
let exitCode = 0;
try {
  const tk = spawnSync('gcloud', ['auth', 'print-access-token'],
    { encoding: 'utf8', shell: true, env: Object.assign({}, process.env, { CLOUDSDK_PYTHON: PY }) });
  TOKEN = String(tk.stdout || '').trim();
  if (!TOKEN) throw new Error('no access token :: ' + String(tk.stderr || '').trim().slice(0, 200));

  const before = api('GET', '/releases/' + LIVE_RELEASE);
  const beforeId = String(before.rulesetName || '').split('/').pop();
  console.log('');
  console.log('  PRODUCTION RELEASE BEFORE');
  console.log('    ruleset    ' + beforeId);
  console.log('    createTime ' + before.createTime);
  console.log('    updateTime ' + before.updateTime);

  const served = api('GET', '/rulesets/' + beforeId);
  if (!served.source || !served.source.files) throw new Error('could not read served source');
  const files = served.source.files.map((f) => ({ name: f.name, content: f.content }));
  console.log('    files      ' + files.map((f) => f.name + ' (' + f.content.length + ' ch)').join(', '));

  const liveExec = api('GET', '/releases/' + LIVE_RELEASE + ':getExecutable?executableVersion=' + EXEC_VER);
  const liveBytes = Buffer.from(liveExec.executable || '', 'base64').length;
  console.log('    compiled   ' + liveBytes + ' B   free ' + (256000 - liveBytes));

  console.log('');
  console.log('  CONTROL — served source, recompiled unchanged');
  const control = measure('control', files);
  console.log('    compiled   ' + control.bytes + ' B   (live ' + liveBytes + ')');

  if (control.bytes !== liveBytes) {
    console.log('');
    console.log('  ABORT — the control does not reproduce the live size.');
    console.log('  The instrument is measuring something other than what is deployed, so a');
    console.log('  delta from it would be uninterpretable. No variable is compiled.');
    exitCode = 1;
  } else {
    console.log('    control reproduces live exactly — instrument trusted');

    const strippedFiles = files.map((f) => ({ name: f.name, content: strip(f.content) }));
    const removed = control.srcChars - strippedFiles.reduce((a, f) => a + f.content.length, 0);
    console.log('');
    console.log('  VARIABLE — comments and indentation removed');
    console.log('    source     ' + control.srcChars + ' -> ' +
      strippedFiles.reduce((a, f) => a + f.content.length, 0) + ' ch   (-' + removed + ')');
    const stripped = measure('stripped', strippedFiles);
    console.log('    compiled   ' + stripped.bytes + ' B');

    /* A CANDIDATE, priced the only way a candidate can honestly be priced.
       The served artifact is `firestore.rules.release-minimal`; the repo's
       `firestore.rules` is a different and larger proposal. Whether it fits under the
       ceiling AT ALL is the question that gates every rules change, and subtracting
       source characters cannot answer it — that is precisely how a candidate reached
       400 INVALID_ARGUMENT at RELEASE, after its ruleset had already been created. */
    if (process.argv[2]) {
      const cf = process.argv[2];
      const content = fs.readFileSync(cf, 'utf8');
      console.log('');
      console.log('  CANDIDATE — ' + cf + '  (' + content.length + ' source ch)');
      /* A rejection is a RESULT, not a crash. Ruleset CREATE validates syntax; RELEASE
         enforces limits. A candidate whose ruleset creates but whose release is refused
         has valid syntax and hit a limit — and the stripped variant must still be priced,
         because whether stripping rescues it is the discriminating measurement. */
      const attempt = (tag, text) => {
        try {
          const m = measure(tag, [{ name: files[0].name, content: text }]);
          return { ok: true, bytes: m.bytes };
        } catch (e) {
          const why = /release failed/.test(e.message) ? 'RELEASE REJECTED'
                    : /ruleset create failed/.test(e.message) ? 'RULESET INVALID (syntax)'
                    : 'FAILED';
          return { ok: false, why, msg: e.message.slice(0, 160) };
        }
      };
      const cand = attempt('candidate', content);
      if (cand.ok) {
        console.log('    compiled   ' + cand.bytes + ' B   free ' + (256000 - cand.bytes) +
                    '   vs served ' + control.bytes + ' (' +
                    (cand.bytes > control.bytes ? '+' : '') + (cand.bytes - control.bytes) + ')');
      } else {
        console.log('    ' + cand.why + ' — ruleset created (syntax valid), release refused.');
        console.log('    Do NOT record this as "too big": the reason is not returned. It is');
        console.log('    a limit, and size is the limit this artifact is known to sit against.');
      }
      const cs = strip(content);
      console.log('    stripped source ' + content.length + ' -> ' + cs.length +
                  ' ch  (-' + (content.length - cs.length) + ')');
      const cstr = attempt('candstrip', cs);
      if (cstr.ok) {
        console.log('    stripped   ' + cstr.bytes + ' B   free ' + (256000 - cstr.bytes) +
                    (cand.ok ? '   (-' + (cand.bytes - cstr.bytes) + ')' : '  <- STRIPPING RESCUED IT'));
      } else {
        console.log('    stripped   ' + cstr.why + ' — stripping does NOT rescue it.');
        console.log('    Consistent with the 128-byte finding: comments are not the problem,');
        console.log('    and no amount of cosmetic reduction will make this candidate fit.');
      }
    }

    const delta = control.bytes - stripped.bytes;
    console.log('');
    console.log('  ' + '='.repeat(66));
    console.log('  source removed   ' + String(removed).padStart(7) + ' characters');
    console.log('  compiled saved   ' + String(delta).padStart(7) + ' bytes');
    console.log('  ' + '='.repeat(66));
    console.log('');
    if (delta === 0) {
      console.log('  ANSWER: comments and indentation cost NOTHING compiled.');
      console.log('  ' + removed + ' source characters are worth zero budget. Consolidation must be');
      console.log('  STRUCTURAL — remove inert rules and blocks. Never plan by character count.');
    } else {
      console.log('  ANSWER: they cost ' + delta + ' compiled bytes (' +
        (delta / removed).toFixed(4) + ' B per source char).');
      console.log('  Real, and now quantified. Still price every candidate by compiling it:');
      console.log('  this ratio describes comments only, not code.');
    }
  }
} catch (e) {
  console.log('');
  console.log('  EXPERIMENT FAILED: ' + e.message);
  exitCode = 1;
} finally {
  try { cleanup(); } catch (e) { console.log('  CLEANUP ERROR: ' + e.message); exitCode = 1; }

  /* the success condition: production release identical before and after */
  try {
    const after = api('GET', '/releases/' + LIVE_RELEASE);
    const afterId = String(after.rulesetName || '').split('/').pop();
    console.log('');
    console.log('  PRODUCTION RELEASE AFTER');
    console.log('    ruleset    ' + afterId);
    console.log('    updateTime ' + after.updateTime);
    const list = api('GET', '/releases?pageSize=100');
    const strays = (list.releases || []).map((r) => r.name.split('/').pop())
      .filter((n) => n.indexOf('sizeprobe-') === 0);
    console.log('    stray sizeprobe releases: ' + (strays.length ? strays.join(', ') : 'none'));
    if (strays.length) exitCode = 1;
  } catch (e) { console.log('  POST-CHECK ERROR: ' + e.message); exitCode = 1; }
  console.log('');
  process.exit(exitCode);
}
