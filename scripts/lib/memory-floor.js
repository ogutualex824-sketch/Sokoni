'use strict';
/**
 * memory-floor.js — the HARD gate before any browser (Chromium / WebKit / Playwright) starts. Owner rule 2026-10-03:
 * a browser result produced under insufficient memory is NOT evidence — the suite must stop BEFORE the browser launches.
 *
 *   const { assertMemoryFloor } = require('./lib/memory-floor');
 *   assertMemoryFloor({ minMB: 700, label: 'marketing golden path' });   // exits 3 (BLOCKED) when below the floor
 *
 * Reads AVAILABLE physical memory: Windows → Win32_OperatingSystem.FreePhysicalMemory (what the 512 MB floor has always
 * been measured with); elsewhere → os.freemem(). An unreadable reading is treated as BELOW the floor (fail closed).
 * Exit code 3 = BLOCKED (memory floor) — distinct from 0 pass / 1 fail, so a gate can never count it as either.
 */
const os = require('os');
const cp = require('child_process');

const DEFAULT_MIN_MB = 512;
const BLOCKED_EXIT = 3;

function availableMB() {
  if (process.env.SOKONI_FAKE_FREE_MB !== undefined) return Number(process.env.SOKONI_FAKE_FREE_MB);   /* tests only */
  if (process.platform === 'win32') {
    try {
      const out = cp.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory'], { encoding: 'utf8', timeout: 20000 });
      const kb = Number(String(out).trim());
      if (Number.isFinite(kb) && kb > 0) return Math.round(kb / 1024);
    } catch (_) { /* fall through */ }
    return NaN;
  }
  return Math.round(os.freemem() / (1024 * 1024));
}

/** Returns { ok, freeMB, minMB }. Never launches anything. */
function checkMemoryFloor(opts) {
  const minMB = Math.max(DEFAULT_MIN_MB, Number((opts && opts.minMB) || DEFAULT_MIN_MB));
  const freeMB = availableMB();
  return { ok: Number.isFinite(freeMB) && freeMB >= minMB, freeMB, minMB };
}

/** Hard stop: prints a BLOCKED line and exits 3 when below the floor. Call it BEFORE requiring/launching any browser. */
function assertMemoryFloor(opts) {
  const r = checkMemoryFloor(opts);
  const label = (opts && opts.label) || 'browser suite';
  if (!r.ok) {
    console.log('BLOCKED (memory floor) — ' + label + ': ' + (Number.isFinite(r.freeMB) ? r.freeMB + ' MB available' : 'available memory unreadable') + ', need ≥ ' + r.minMB + ' MB. No browser was started. This is NOT a pass and NOT a fail.');
    process.exit(BLOCKED_EXIT);
  }
  console.log('memory floor ok — ' + label + ': ' + r.freeMB + ' MB available (≥ ' + r.minMB + ' MB)');
  return r;
}

module.exports = { assertMemoryFloor, checkMemoryFloor, availableMB, DEFAULT_MIN_MB, BLOCKED_EXIT };
