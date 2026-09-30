#!/usr/bin/env node
/* environment-preflight.js — is THIS MACHINE fit to certify or deploy right now?
 *
 *   node scripts/environment-preflight.js                 report, exit 0 READY / 1 NOT_READY
 *   node scripts/environment-preflight.js --json          machine-readable record on stdout too
 *   node scripts/environment-preflight.js --reap          also terminate PARENT-DEAD WebKit/Playwright
 *                                                              orphans (never a process whose parent is alive)
 *   node scripts/environment-preflight.js --acquire NAME  take the peer browser lock for this run
 *   node scripts/environment-preflight.js --release NAME  release it
 *   node scripts/environment-preflight.js --for hosting|functions|browser|syntax
 *                                                              which deploy/test window is being asked for
 *
 * Why this exists (2026-09-30). Two owner-authorized hosting deploys were blocked by gates that
 * reported code failures which were not code failures:
 *   1. the browser gate reported a required suite 38/1 — Playwright clicks and navigations timed
 *      out because another session was running WebKit suites on the same machine;
 *   2. the syntax gate reported "1 file does not parse" — its `node --check` child had died of
 *      "Fatal process out of memory": ~35 parent-dead WebKitNetworkProcess.exe (~258 MB each) had
 *      taken system commit to the ceiling.
 * Both are MACHINE states. This preflight names them BEFORE a 1,700-file gate or a 33-suite run
 * starts, and fails closed with a reason code. It is test/deploy infrastructure only: it touches
 * no application code, no App Check, no payment path and no deployment configuration.
 *
 * Checks and reason codes
 *   RAM available        free physical / free virtual (commit headroom)           OOM_RISK
 *   Orphan WebKit        parent-dead WebKit or Playwright processes                  ORPHAN_BROWSER_PROCESSES
 *   Peer browser lock    another run holds the lock, or live browser-suite procs   PEER_BROWSER_SESSION_ACTIVE
 *   Node capacity        count of node.exe (runaway test runners)                  NODE_SATURATION
 *   Functions deploy     a `firebase deploy` with functions in scope is running     DEPLOYMENT_IN_PROGRESS
 *   Hosting deploy       a `firebase deploy` with hosting in scope is running       DEPLOYMENT_IN_PROGRESS
 *   Emulator ports       listeners on 4400/4500/8080/9099 (a peer's emulator-backed gate)  EMULATOR_IN_USE
 *   Cloud Build          an ongoing build (gcloud); unknown = UNPROVEN, fail closed CLOUD_BUILD_ACTIVE / CLOUD_BUILD_UNKNOWN
 *
 * Every run writes a record (counts, ownership, cleanup result, start/end time) under
 * %LOCALAPPDATA%\Temp\sokoni-preflight\ and prints its path. The record is evidence for a later
 * "why was that release blocked" question; nothing else reads it.
 *
 * Windows-first (this repo's agents run on Windows). On other platforms the process checks report
 * UNPROVEN and the result is NOT_READY — a preflight that cannot see the machine must not say READY.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const FOR = opt('--for') || 'browser';
const JSON_OUT = flag('--json');
const REAP = flag('--reap');
const ACQUIRE = opt('--acquire');
const RELEASE = opt('--release');

/* Thresholds — deliberately conservative; a false NOT_READY costs a minute, a false READY costs a
   blocked release and a misdiagnosis. */
const T = {
  minFreePhysicalMB: 1500,
  minFreeVirtualMB: 3000,           /* the OOM seen 2026-09-30 struck at ~400 MB free virtual */
  maxOrphanBrowserProcs: 0,
  maxNodeProcs: 40,
};

const LOCK_DIR = path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'Temp', 'sokoni-preflight');
const LOCK_FILE = path.join(LOCK_DIR, 'browser-suite.lock');
try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch (_) {}

/* Which checks a window needs. A parser sweep needs memory and a sane process table; a browser
   run additionally needs exclusivity and no deploy churning beside it; a deploy needs all of it
   including the cloud side. Asking for less than the window needs is not an option here. */
const SCOPE = {
  syntax:    ['RAM available', 'Orphan WebKit', 'Node capacity'],
  browser:   ['RAM available', 'Orphan WebKit', 'Peer browser lock', 'Node capacity', 'Functions deploy', 'Hosting deploy'],
  /* the emulator-backed inventory gate (test-inventory.js --gate) needs the Firebase emulator ports */
  gate:      ['RAM available', 'Orphan WebKit', 'Node capacity', 'Emulator ports'],
  hosting:   ['RAM available', 'Orphan WebKit', 'Peer browser lock', 'Node capacity', 'Functions deploy', 'Hosting deploy', 'Emulator ports', 'Cloud Build'],
  functions: ['RAM available', 'Orphan WebKit', 'Peer browser lock', 'Node capacity', 'Functions deploy', 'Hosting deploy', 'Emulator ports', 'Cloud Build'],
};
if (!SCOPE[FOR]) { console.error('unknown --for ' + FOR + ' (syntax|browser|gate|hosting|functions)'); process.exit(2); }
const wants = (name) => SCOPE[FOR].includes(name);

const startedAt = new Date().toISOString();
const checks = [];
const add = (name, status, detail, reason) => { if (wants(name)) checks.push({ name, status, detail: detail || '', reason: reason || null }); };

/* ── machine facts (Windows: CIM via PowerShell) ─────────────────────────────────────────────── */
function ps(script) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 60000 });
  if (r.error || r.status !== 0) return null;
  return String(r.stdout || '').trim();
}

function processes() {
  if (process.platform !== 'win32') return null;
  const out = ps("Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ConvertTo-Json -Compress -Depth 2");
  if (!out) return null;
  let rows; try { rows = JSON.parse(out); } catch (_) { return null; }
  if (!Array.isArray(rows)) rows = [rows];
  const alive = new Set(rows.map((r) => Number(r.ProcessId)));
  return rows.map((r) => ({
    pid: Number(r.ProcessId), ppid: Number(r.ParentProcessId), name: String(r.Name || ''),
    cmd: String(r.CommandLine || ''), parentAlive: alive.has(Number(r.ParentProcessId)),
  }));
}

function memory() {
  const freePhysicalMB = Math.round(os.freemem() / 1048576);
  const totalPhysicalMB = Math.round(os.totalmem() / 1048576);
  let freeVirtualMB = null, totalVirtualMB = null;
  if (process.platform === 'win32') {
    const out = ps("$o = Get-CimInstance Win32_OperatingSystem; \"$($o.FreeVirtualMemory) $($o.TotalVirtualMemorySize)\"");
    if (out) { const [f, t] = out.split(/\s+/).map(Number); if (isFinite(f)) freeVirtualMB = Math.round(f / 1024); if (isFinite(t)) totalVirtualMB = Math.round(t / 1024); }
  }
  return { freePhysicalMB, totalPhysicalMB, freeVirtualMB, totalVirtualMB };
}

/* ── classify processes ──────────────────────────────────────────────────────────────────────── */
const isBrowserProc = (p) => /^(WebKitNetworkProcess|WebKitWebProcess|WebKitGPUProcess|Playwright|MiniBrowser)\.exe$/i.test(p.name)
  || (/^(chrome|msedge|chromium|firefox)\.exe$/i.test(p.name) && /--headless|--remote-debugging-pipe|--enable-automation|ms-playwright/i.test(p.cmd));
const isSuiteRunner = (p) => /^node\.exe$/i.test(p.name) && /scripts[\\/](test-[^\s"']+\.js|predeploy-browser-suites\.js)/i.test(p.cmd);
const isDeploy = (p) => /^node\.exe$/i.test(p.name) && /firebase(-tools)?[\\/"'\s].*\bdeploy\b/i.test(p.cmd);
const deployScope = (p) => {
  const m = p.cmd.match(/--only\s+([^\s"']+)/i);
  if (!m) return 'all';
  return m[1];
};

/* ── lock ────────────────────────────────────────────────────────────────────────────────────── */
function readLock() {
  try { const l = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf8')); return l; } catch (_) { return null; }
}
function lockHolderAlive(lock, procs) {
  if (!lock || !lock.pid) return false;
  if (!procs) return true;                 /* cannot see processes → assume the holder is alive (fail closed) */
  return procs.some((p) => p.pid === Number(lock.pid));
}

/* ── main ────────────────────────────────────────────────────────────────────────────────────── */
(function main() {
  const procs = processes();
  const mem = memory();
  const mine = new Set([process.pid, process.ppid]);
  const record = { startedAt, for: FOR, host: os.hostname(), thresholds: T, memory: mem, processes: {}, lock: null, cleanup: null, checks: [], result: null, reason: null, endedAt: null };

  /* release / acquire are explicit run-window operations */
  if (RELEASE) {
    const l = readLock();
    if (l && l.name === RELEASE) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} console.log('  [preflight] browser lock released by ' + RELEASE); }
    else console.log('  [preflight] no lock held by ' + RELEASE + (l ? ' (held by ' + l.name + ' pid ' + l.pid + ')' : ''));
    process.exit(0);
  }

  /* RAM. Commit headroom (free virtual) is the predictor of the failure actually seen: the
     2026-09-30 OOM struck at ~400 MB free virtual. Available physical memory on this shared box
     sits at 300–700 MB for hours while nothing fails (Windows keeps it as standby cache), so
     physical is a HARD floor only at 512 MB and a recorded WARN between 512 and 1,500 MB. */
  const freeV = mem.freeVirtualMB;
  const physHard = 512;
  if (mem.freePhysicalMB < physHard || (freeV !== null && freeV < T.minFreeVirtualMB))
    add('RAM available', 'FAIL', `free physical ${mem.freePhysicalMB} MB, free virtual ${freeV === null ? 'unknown' : freeV + ' MB'} (hard floors ${physHard} / ${T.minFreeVirtualMB})`, 'OOM_RISK');
  else if (freeV === null && process.platform === 'win32')
    add('RAM available', 'UNPROVEN', `free physical ${mem.freePhysicalMB} MB; commit headroom could not be read`, 'OOM_RISK');
  else
    add('RAM available', 'PASS', `free physical ${mem.freePhysicalMB} MB${mem.freePhysicalMB < T.minFreePhysicalMB ? ' (WARN: below ' + T.minFreePhysicalMB + ')' : ''}, free virtual ${freeV === null ? 'n/a' : freeV + ' MB'}`);

  if (!procs) {
    add('Orphan WebKit', 'UNPROVEN', 'process table unavailable', 'ORPHAN_BROWSER_PROCESSES');
    add('Peer browser lock', 'UNPROVEN', 'process table unavailable', 'PEER_BROWSER_SESSION_ACTIVE');
    add('Node capacity', 'UNPROVEN', 'process table unavailable', 'NODE_SATURATION');
    add('Functions deploy', 'UNPROVEN', 'process table unavailable', 'DEPLOYMENT_IN_PROGRESS');
    add('Hosting deploy', 'UNPROVEN', 'process table unavailable', 'DEPLOYMENT_IN_PROGRESS');
  } else {
    const browser = procs.filter(isBrowserProc);
    const orphans = browser.filter((p) => !p.parentAlive);
    const owned = browser.filter((p) => p.parentAlive);
    const runners = procs.filter(isSuiteRunner).filter((p) => !mine.has(p.pid) && !mine.has(p.ppid));
    const nodes = procs.filter((p) => /^node\.exe$/i.test(p.name));
    const deploys = procs.filter(isDeploy).filter((p) => !mine.has(p.pid) && !mine.has(p.ppid));
    record.processes = {
      browserTotal: browser.length, browserOrphans: orphans.length, browserOwned: owned.length,
      orphanPids: orphans.map((p) => p.pid), suiteRunners: runners.map((p) => ({ pid: p.pid, cmd: p.cmd.slice(0, 140) })),
      nodeCount: nodes.length, deploys: deploys.map((p) => ({ pid: p.pid, scope: deployScope(p) })),
    };

    /* orphans — report, and reap only with --reap and only parent-dead */
    let cleanup = null;
    if (orphans.length && REAP) {
      /* CIM Terminate, not taskkill: on 2026-09-30 taskkill answered "no running instance" for
         every one of 12 parent-dead WebKitNetworkProcess rows that CIM still listed (and that were
         still charged to commit), while Invoke-CimMethod Terminate returned 0 and freed them —
         the same method sokoni-4d used to bring commit from 24.1 GB to 17.2 GB. The pid list is
         built HERE from parent-dead rows only; a live parent's process is never in it. */
      const pids = orphans.map((p) => p.pid);
      const out = ps("$ids = @(" + pids.join(',') + "); $ok=@(); $bad=@(); foreach ($id in $ids) { $p = Get-CimInstance Win32_Process -Filter \"ProcessId = $id\"; if (-not $p) { $ok += $id; continue }; try { $r = Invoke-CimMethod -InputObject $p -MethodName Terminate; if ($r.ReturnValue -eq 0) { $ok += $id } else { $bad += $id } } catch { $bad += $id } }; \"$($ok -join ',')|$($bad -join ',')\"");
      const [okS, badS] = String(out || '|').split('|');
      const killed = okS ? okS.split(',').filter(Boolean).map(Number) : [];
      const failed = badS ? badS.split(',').filter(Boolean).map(Number) : (out === null ? pids : []);
      cleanup = { attempted: orphans.length, method: 'CIM Terminate', killed, failed };
      record.cleanup = cleanup;
    }
    const remaining = cleanup ? cleanup.failed.length : orphans.length;
    if (remaining > T.maxOrphanBrowserProcs)
      add('Orphan WebKit', 'FAIL', `${orphans.length} parent-dead browser process(es)` + (cleanup ? `; reaped ${cleanup.killed.length}, ${cleanup.failed.length} left` : ' (run with --reap to terminate them; live parents are never touched)'), 'ORPHAN_BROWSER_PROCESSES');
    else
      add('Orphan WebKit', 'PASS', cleanup ? `reaped ${cleanup.killed.length} orphan(s)` : `${orphans.length} orphan browser processes, ${owned.length} owned by live runs`);

    /* peer browser window: a lock held by a live holder, or live suite runners / owned browsers */
    const lock = readLock();
    record.lock = lock;
    const holderAlive = lockHolderAlive(lock, procs);
    if (lock && !holderAlive) { try { fs.unlinkSync(LOCK_FILE); } catch (_) {} record.lock = Object.assign({}, lock, { stale: true, cleared: true }); }
    const peerLock = lock && holderAlive && (!ACQUIRE || lock.name !== ACQUIRE);
    if (peerLock)
      add('Peer browser lock', 'FAIL', `lock held by ${lock.name} (pid ${lock.pid}) since ${lock.since}`, 'PEER_BROWSER_SESSION_ACTIVE');
    else if (runners.length || owned.length)
      add('Peer browser lock', 'FAIL', `${runners.length} suite runner(s) and ${owned.length} live browser process(es) belong to another run: ` + runners.map((r) => r.cmd.replace(/^.*scripts[\\/]/, '').slice(0, 40)).join(', '), 'PEER_BROWSER_SESSION_ACTIVE');
    else {
      add('Peer browser lock', 'PASS', lock && !holderAlive ? 'stale lock cleared' : 'no peer browser run');
      if (ACQUIRE) {
        const l = { name: ACQUIRE, pid: process.ppid, since: new Date().toISOString(), for: FOR };
        try { fs.writeFileSync(LOCK_FILE, JSON.stringify(l)); record.lock = l; } catch (e) { add('Peer browser lock', 'UNPROVEN', 'could not write lock: ' + e.message, 'PEER_BROWSER_SESSION_ACTIVE'); }
      }
    }

    /* Emulator ports. 2026-09-30: gate-inventory (firebase emulators:exec) died twice with
       "Could not start Authentication Emulator, port taken" because another session was running the
       same emulator-backed gate. Listeners on the emulator ports mean the gate cannot start here now;
       the owning pid is named so the operator can tell a peer's run from a stale one. */
    if (wants('Emulator ports')) {
      const EMU_PORTS = [4400, 4500, 8080, 9099];
      const out = ps("Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in " + EMU_PORTS.join(',') + " } | ForEach-Object { \"$($_.LocalPort):$($_.OwningProcess)\" } | Sort-Object -Unique");
      const rows = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (out === null) add('Emulator ports', 'UNPROVEN', 'listener table unavailable', 'EMULATOR_IN_USE');
      else if (rows.length) {
        const pids = [...new Set(rows.map((r) => r.split(':')[1]))];
        const owners = pids.map((pid) => { const p = procs.find((x) => String(x.pid) === pid); return pid + (p ? '=' + p.name + (/(emulators:exec|emulators:start)/.test(p.cmd) ? '(firebase emulator)' : '') : ''); });
        add('Emulator ports', 'FAIL', 'listening: ' + rows.join(' ') + ' — owner pid ' + owners.join(', '), 'EMULATOR_IN_USE');
      } else add('Emulator ports', 'PASS', 'ports ' + EMU_PORTS.join('/') + ' free');
    }

    if (nodes.length > T.maxNodeProcs) add('Node capacity', 'FAIL', `${nodes.length} node.exe processes (limit ${T.maxNodeProcs})`, 'NODE_SATURATION');
    else add('Node capacity', 'PASS', `${nodes.length} node.exe processes`);

    const fn = deploys.filter((p) => /^all$|functions/i.test(deployScope(p)));
    const ho = deploys.filter((p) => /^all$|hosting/i.test(deployScope(p)));
    if (fn.length) add('Functions deploy', 'FAIL', `firebase deploy running (pid ${fn.map((p) => p.pid).join(',')}, scope ${fn.map(deployScope).join(',')})`, 'DEPLOYMENT_IN_PROGRESS');
    else add('Functions deploy', 'PASS', 'no functions deploy running on this machine');
    if (ho.length) add('Hosting deploy', 'FAIL', `firebase deploy running (pid ${ho.map((p) => p.pid).join(',')}, scope ${ho.map(deployScope).join(',')})`, 'DEPLOYMENT_IN_PROGRESS');
    else add('Hosting deploy', 'PASS', 'no hosting deploy running on this machine');
  }

  /* Cloud Build — the only check that leaves the machine. gcloud needs its bundled Python on this
     box (reference_gcloud_python_fix). Unknown is UNPROVEN, and UNPROVEN fails closed. */
  (function cloudBuild() {
    if (!wants('Cloud Build')) return;
    const env = Object.assign({}, process.env);
    if (!env.CLOUDSDK_PYTHON) {
      const base = 'C:/Users/' + (env.USERNAME || 'USER1') + '/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform';
      try { const d = fs.readdirSync(base).find((n) => /^bundledpython/.test(n)); if (d) env.CLOUDSDK_PYTHON = path.join(base, d, 'python.exe'); } catch (_) {}
    }
    /* Node ≥ 20 refuses to spawn a .cmd without a shell (EINVAL); the arguments are constants. */
    const r = spawnSync(process.platform === 'win32' ? 'gcloud.cmd' : 'gcloud', ['builds', 'list', '--ongoing', '--project', 'sokoni-aeb26', '--format=value(id,status,createTime)', '--limit', '10'], { encoding: 'utf8', timeout: 60000, env, shell: process.platform === 'win32' });
    if (r.error || r.status !== 0) { add('Cloud Build', 'UNPROVEN', 'gcloud unavailable: ' + String(r.error ? r.error.message : (r.stderr || '')).trim().slice(0, 120), 'CLOUD_BUILD_UNKNOWN'); return; }
    const lines = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean);
    if (lines.length) add('Cloud Build', 'FAIL', lines.length + ' ongoing build(s): ' + lines.slice(0, 3).join(' | '), 'CLOUD_BUILD_ACTIVE');
    else add('Cloud Build', 'PASS', 'no ongoing builds');
  })();

  /* verdict — fail closed: any FAIL or UNPROVEN → NOT_READY, first reason wins */
  const bad = checks.find((c) => c.status !== 'PASS');
  record.checks = checks;
  record.result = bad ? 'NOT_READY' : 'READY';
  record.reason = bad ? bad.reason : null;
  record.endedAt = new Date().toISOString();
  const file = path.join(LOCK_DIR, 'preflight-' + startedAt.replace(/[:.]/g, '-') + '.json');
  try { fs.writeFileSync(file, JSON.stringify(record, null, 2)); } catch (_) {}

  const pad = (s, n) => (s + ' '.repeat(n)).slice(0, n);
  console.log('\nENVIRONMENT PREFLIGHT  (for: ' + FOR + ')');
  console.log('────────────────────────────');
  checks.forEach((c) => console.log(pad(c.name, 20) + pad(c.status, 10) + c.detail));
  console.log('');
  console.log('RESULT: ' + record.result + (bad ? '\nREASON: ' + bad.reason + ' — ' + bad.name + ': ' + bad.detail : ''));
  console.log('record: ' + file);
  if (JSON_OUT) console.log(JSON.stringify(record));
  process.exit(bad ? 1 : 0);
})();
