#!/usr/bin/env node
/* test-kass-page-boundary.js — the KASS page boundary set by the owner (2026-09-28):
 *
 *     HOME → KASS ✅   SERVICES → KASS ✅   ALL SERVICE / BUSINESS HUBS → KASS ✅   PROFILE → KASS ❌
 *
 *   node scripts/test-kass-page-boundary.js                 # working tree — must PASS
 *   COUNTERPROOF=1 node scripts/test-kass-page-boundary.js  # 4e9607b — the profile checks fail there
 *
 * PROVES
 *   B1  profile.html loads no KASS chat widget
 *   B2  profile.html has no "Ask KASS" entry (piOpenKass)
 *   B3  profile.html has no "KASS — Action Items" card, no "KASS Recommendations" card, no 🤖 KASS brief line
 *   B4  profile.html keeps no profile-only KASS code (the strip loader, _kassRec7, their CSS) — nothing left unused
 *   B5  the KASS-only profileGetCompletion re-fetch is gone (one fewer callable invocation per profile session)
 *   B6  the profile page still parses and still renders its profile-completion steps (control)
 *   K1  home (index.html) and services.html still load KASS
 *   K2  EVERY page that loaded KASS at 4e9607b, except profile.html, still loads it — the shared KASS code and every
 *       hub are untouched (compared against the baseline tree, not a hand-kept list)
 *   K3  the shared widget file itself still exists and still boots its FAB (kassBtn)
 */
'use strict';
const fs = require('fs'), path = require('path'), cp = require('child_process'), vm = require('vm');
const ROOT = path.resolve(__dirname, '..');
const BASE = '4e9607b', CPM = !!process.env.COUNTERPROOF;
const git = (args) => cp.execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 256e6 });
const read = (f) => (CPM ? git(['show', BASE + ':' + f]) : fs.readFileSync(path.join(ROOT, f), 'utf8'));
const exists = (f) => { try { read(f); return true; } catch (e) { return false; } };
let pass = 0, fail = 0;
const ck = (n, ok, d) => { if (ok) { pass++; console.log('  PASS  ' + n); } else { fail++; console.log('  FAIL  ' + n + (d !== undefined ? '   ' + JSON.stringify(d).slice(0, 400) : '')); } };
/* a page loads KASS by a <script src> tag OR by naming the file in a lazy-loader list (index.html's LAZY) */
const LOADS_KASS = /<script[^>]*\bsrc=["'][^"']*kass-widget\.js|["']\/?kass-widget\.js["']/;
/* HTML comments are history, not surfaces. JS/CSS block comments are NOT stripped by regex: a "/*" inside a string
   (accept="image/*") would swallow real code. The checks below look for code tokens, which comments do not carry. */
const code = (h) => h.replace(/<!--[\s\S]*?-->/g, '');

console.log('\nSOURCE: ' + (CPM ? BASE + ' (before) — profile failures below ARE the defects' : 'working tree'));
const P = read('profile.html'), PC = code(P);
ck('B1  profile.html loads no KASS chat widget', !LOADS_KASS.test(PC));
ck('B2  profile.html has no "Ask KASS" entry (no piOpenKass action, no Ask KASS label in markup or data)', !/piOpenKass|lbl:'Ask KASS'|l:'Ask KASS'|>Ask KASS|'Ask KASS —/.test(PC), (PC.match(/piOpenKass/g) || []).length);
const cards = { actionItems: /KASS — Action Items|id="piKassCard"/.test(PC), recommendations: /KASS Recommendations|id="piRecoCard"/.test(PC), briefLine: /pi7-brief-kass|'🤖'|>🤖</.test(PC) };
ck('B3  no KASS Action Items / KASS Recommendations cards, no 🤖 KASS brief line', !cards.actionItems && !cards.recommendations && !cards.briefLine, cards);
const leftovers = ['_kassRec7', '_s4Loaded._kass', 'piKassStrip', 'pi-kass-', 'piRecoList', 'pi-reco-'].filter((t) => PC.includes(t));
ck('B4  no profile-only KASS code or CSS left behind', leftovers.length === 0, leftovers);
const calls = (h) => (code(h).match(/_call\('profileGetCompletion'\)/g) || []).length;
const baseCalls = calls(git(['show', BASE + ':profile.html']));
ck('B5  the KASS-only profileGetCompletion re-fetch is gone', CPM ? calls(P) < baseCalls : calls(P) === baseCalls - 1, { now: calls(P), base: baseCalls });
let parses = true, why = '';
const re = /<script(?![^>]*\bsrc=)([^>]*)>([\s\S]*?)<\/script>/gi; let m;
while ((m = re.exec(P))) { if (/type="(module|application\/ld\+json)"/.test(m[1])) continue; try { new vm.Script(m[2]); } catch (e) { parses = false; why = e.message; } }
ck('B6  profile.html inline scripts parse, and the completion step list still renders (control)', parses && /id="piStepsList"/.test(P) && /list\.innerHTML = steps\.map/.test(P), why);

/* the other side of the boundary: KASS stays everywhere else */
const htmlAt = (ref) => git(['ls-tree', '-r', '--name-only', ref]).split('\n').filter((f) => /^[^/]+\.html$/.test(f));
const baseKass = htmlAt(BASE).filter((f) => LOADS_KASS.test(code(git(['show', BASE + ':' + f]))));
const nowFiles = CPM ? baseKass : baseKass.filter((f) => fs.existsSync(path.join(ROOT, f)));
ck('K1  home (index.html) and services.html still load KASS', ['index.html', 'services.html'].every((f) => LOADS_KASS.test(code(read(f)))));
const lost = nowFiles.filter((f) => f !== 'profile.html' && !LOADS_KASS.test(code(read(f))));
ck(`K2  every page that loaded KASS at ${BASE} (except profile) still does — ${baseKass.length - 1} pages`, lost.length === 0 && baseKass.length > 20, { lost, baseline: baseKass.length });
ck('K3  the shared widget still exists and still boots its FAB', exists('kass-widget.js') && /_btn\.id = 'kassBtn'/.test(read('kass-widget.js')));

console.log(`\n${pass} passed, ${fail} failed`);
if (CPM) console.log('(counter-proof: B1–B5 failing ARE the profile AI surfaces; B6/K1–K3 are controls and pass in both modes)');
process.exit(fail ? 1 : 0);
