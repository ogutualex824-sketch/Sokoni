#!/usr/bin/env node
/* run-browser-gate.js — run ONE browser suite only when the memory floor holds; otherwise record it BLOCKED (exit 3).
 *   node scripts/run-browser-gate.js <suite.js> [--min-mb 700] [--label "marketing golden path"]
 * The floor is checked HERE, before the suite (and therefore before Chromium/WebKit) starts, and re-checked by any suite
 * that calls assertMemoryFloor itself. Owner rule 2026-10-03: never mark a browser test passed because the process
 * started or printed the expected output under insufficient memory. */
'use strict';
const path = require('path'), cp = require('child_process');
const { assertMemoryFloor } = require('./lib/memory-floor');
const args = process.argv.slice(2);
const suite = args.find((a) => /\.js$/.test(a));
const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
if (!suite) { console.error('usage: node scripts/run-browser-gate.js <suite.js> [--min-mb N] [--label TEXT]'); process.exit(2); }
const minMB = Number(flag('--min-mb') || 512);
assertMemoryFloor({ minMB, label: flag('--label') || path.basename(suite) });
const r = cp.spawnSync(process.execPath, [path.resolve(suite)], { stdio: 'inherit', env: Object.assign({}, process.env, { SOKONI_MEMORY_FLOOR_MB: String(minMB) }) });
process.exit(r.status == null ? 1 : r.status);
