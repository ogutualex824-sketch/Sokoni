#!/usr/bin/env node
/**
 * POS BOOT DEGRADATION — a stalled initialisation must still leave a USABLE till.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * pos.js wrapped every boot step in try/catch and documented that a failure "can NEVER
 * blank the shell". That is true only for a THROW. The failure that actually reaches
 * merchants is a promise that NEVER SETTLES — an IndexedDB open blocked by another tab,
 * a storage eviction mid-transaction, or `PosNotify.requestPermission()` waiting on a
 * browser prompt the merchant never answers. A catch cannot see any of those, and every
 * step that reveals or wires the till sat BELOW them:
 *
 *   - a stall before the wizard/launch decision  -> neither wizard nor app: a BLACK page
 *   - a stall after the reveal but before nav.init() -> a till that renders and
 *     responds to NOTHING (nav.init() was the last statement, behind eight awaits)
 *
 * No string assertion can express "never settles", so this suite extracts the REAL
 * boot()/launchApp() source verbatim from pos.js and runs it against a PosDB that hangs.
 *
 * MUTATIONS ARE THE POINT
 * -----------------------
 * The guards are layered, so a passing run proves little on its own — the watchdog can
 * mask a broken bound and vice versa. Each mutation below disables one layer and names
 * the failure that must come back. A mutation that changes nothing observable means the
 * layer it removed is untested, and this suite exits non-zero for it.
 *
 * Run: node scripts/test-pos-boot-degradation.js
 */
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const POS = path.join(ROOT, 'pos.js');

/* ── verbatim extraction ──────────────────────────────────────────────────── */
function fnSource (src, header) {
  const i = src.indexOf(header);
  if (i === -1) return null;
  let depth = 0;
  for (let k = src.indexOf('{', i); k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (depth === 0) return src.slice(i, k + 1); }
  }
  return null;
}
const HEADERS = [
  '  function _stage(n)',
  '  function _activate ()',
  '  function _bounded (p, ms, fallback, label)',
  '  function _launchAuthority ()',
  '  function _showPosDbDegradedStatus()',
  '  async function launchApp()',
  '  async function boot()',
];
function extract () {
  const src = fs.readFileSync(POS, 'utf8');
  const parts = HEADERS.map(h => fnSource(src, h)).filter(Boolean);
  const joined = parts.join('\n\n');
  if (joined.indexOf('async function boot()') === -1) throw new Error('boot() not extracted from pos.js');
  if (joined.indexOf('async function launchApp()') === -1) throw new Error('launchApp() not extracted from pos.js');
  return joined;
}

/* ── a DOM just real enough to answer "what does the merchant see?" ───────── */
function makeEl (id, hidden) {
  const cls = new Set(hidden ? ['hidden'] : []);
  return {
    id, textContent: '',
    style: { display: '', opacity: '', pointerEvents: '', transition: '', cssText: '' },
    classList: { contains: c => cls.has(c), add: c => cls.add(c), remove: c => cls.delete(c) },
    appendChild () {}, addEventListener () {}, remove () {},
  };
}
const NEVER = () => new Promise(() => {});   /* the failure mode under test */

/* The guards wait 3-15 REAL seconds, and seven scenarios plus four mutations must each
   outlive the longest of them. Sleeping for that took ~110s and the release gate kills a
   suite at 60s — a suite that dies at the budget is lost coverage, not evidence. So the
   extracted copy has its timer DURATIONS divided; the control flow under test is untouched.
   Acceleration could hide a duration regression, so the real values are asserted separately
   against the unaccelerated source below. */
const DIVISOR = 20;
function accelerate (code) {
  return code
    .replace('      }, ms);', '      }, Math.max(15, Math.round(ms / ' + DIVISOR + ')));')
    .replace('      }, 15000);', '      }, ' + Math.round(15000 / DIVISOR) + ');')
    .replace('setTimeout(_activate, 8000);', 'setTimeout(_activate, ' + Math.round(8000 / DIVISOR) + ');');
}

function run (code, scenario, ms) {
  return new Promise((resolve) => {
    const app = makeEl('pos-app', true);
    const wiz = makeEl('pos-wizard', false);
    const els = { 'pos-app': app, 'pos-wizard': wiz };
    const seen = { navInit: 0, stages: [] };
    const ok = v => Promise.resolve(v);

    const sandbox = {
      console: { warn () {}, log () {}, error () {} },
      setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
      Promise, JSON, Date, String, Number, Array, Object, Set, Math, parseInt,
      state: { settings: {}, ready: false, invTab: null },
      PosDB: {
        init:       () => scenario === 'hang-init' ? NEVER() : ok(),
        isDegraded: () => false,
        settings:   { getAll: () => scenario === 'hang-settings' ? NEVER() : ok({ setupComplete: true }),
                      set: ok, setMany: ok },
        categories: { seedDefaults: () => scenario === 'hang-seed' ? NEVER() : ok(), getAll: () => ok([]) },
        products:   { getLowStock: () => ok([]), getAll: () => ok([]), get: () => ok(null),
                      delete: ok, save: ok, upsertCanonical: ok },
        cashiers:   { getAll: () => scenario === 'hang-cashiers' ? NEVER() : ok([]) },
      },
      document: {
        getElementById: id => els[id] || null,
        createElement: id => makeEl(id, false),
        body: makeEl('body', false), documentElement: makeEl('html', false),
        addEventListener () {},
      },
      localStorage: { getItem: k => (k === 'loggedIn' ? 'true' : null), setItem () {} },
      navigator: { onLine: true },
      products: { reload: () => { if (scenario === 'throw-products') throw new Error('catalogue exploded'); return ok(); } },
      ui:       { loadCategories: () => ok() },
      inv:      { renderProducts () {}, renderLowStock () {} },
      nav:      { init () { seen.navInit++; } },
      cashier:  { restoreSession: () => ok(true), showSwitchDialog () {} },
      settings: { loadIntoForm () {} },
      profile:  { reflectInHeader () {}, seedBusinessDefaults: () => ok(), syncBusinessProfile () {} },
      sync:     { run () {} },
      PosBarcode:   { init: () => ok(), setCallback () {} },
      PosNotify:    { requestPermission: () => scenario === 'hang-notify' ? NEVER() : ok('granted') },
      PosPlugins:   { installBuiltins () {}, restoreEnabled: () => ok(), emit () {} },
      PosTerminals: { init: () => ok() },
      handleBarcodeGlobal () {}, updateClock () {}, updateOnlineStatus () {},
      _setVal () {}, _seedCatalogueFromCanonical: () => ok(0),
      refreshInventoryFromCanonical: () => ok(0),
    };
    sandbox.window = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.sokoniStage = n => seen.stages.push(n);

    try { vm.runInContext(code + '\n;boot();', vm.createContext(sandbox), { timeout: 5000 }); }
    catch (_) { /* a throw is a legitimate outcome; the assertions judge the result */ }

    setTimeout(() => resolve({
      revealed:    !app.classList.contains('hidden'),
      interactive: seen.navInit > 0,
      covered:     wiz.style.display !== 'none' && wiz.style.pointerEvents !== 'none',
      stages:      seen.stages,
      degraded:    !!sandbox._posDbDegraded,
    }), ms);
  });
}

/* Waits exceed the longest guard they must outlive (watchdog 15s). */
/* Comfortably outlives every accelerated guard (longest chain: a 750ms watchdog then a
   400ms backstop), with margin for a loaded machine. */
const W = 2500;
const SCENARIOS = [
  ['healthy',                             'none',          W],
  ['IndexedDB init hangs',                'hang-init',     W],
  ['settings read hangs',                 'hang-settings', W],
  ['category seed hangs',                 'hang-seed',     W],
  ['cashier read hangs (after reveal)',   'hang-cashiers', W],
  ['notification prompt never answered',  'hang-notify',   W],
  ['catalogue load throws',               'throw-products',W],
];

let pass = 0, fail = 0;
const ck = (l, c, why) => { c ? pass++ : fail++;
  console.log('  ' + (c ? 'OK   ' : 'FAIL ') + l + (why && !c ? '   <- ' + why : '')); };

(async () => {
  const CODE = extract();

  console.log('\n=== every stall must still leave a usable till ===');
  const res = {};
  for (const [name, sc, ms] of SCENARIOS) {
    const r = res[sc] = await run(accelerate(CODE), sc, ms);
    ck(name + ' -> REVEALED',    r.revealed);
    ck(name + ' -> INTERACTIVE', r.interactive, 'a till that renders and answers nothing is not a working till');
    ck(name + ' -> not covered', !r.covered);
  }

  console.log('\n=== the REAL durations (the accelerated copy must not hide a change) ===');
  const RAW = fs.readFileSync(POS, 'utf8');
  [['db-init 8s',             '_bounded(PosDB.init(), 8000'],
   ['db-settings 5s',         "_bounded(PosDB.settings.getAll(), 5000, state.settings || {}, 'db-settings')"],
   ['db-seed 5s',             '_bounded(PosDB.categories.seedDefaults(), 5000'],
   ['launch-settings 5s',     "5000, state.settings || {}, 'launch-settings'"],
   ['notify-permission 3s',   '_bounded(PosNotify.requestPermission(), 3000'],
   ['watchdog 15s',           '      }, 15000);'],
   ['activation backstop 8s', 'setTimeout(_activate, 8000);'],
  ].forEach(([label, needle]) => ck('duration unchanged: ' + label, RAW.indexOf(needle) > -1,
    'the accelerated runs would still pass against a shortened guard'));

  console.log('\n=== breadcrumbs: ?diag=crash must NAME the stall ===');
  ck('a stalled settings read is named',
     res['hang-settings'].stages.some(s => /db-settings:TIMEOUT/.test(s)),
     'a stall with no stage is indistinguishable from every other death');
  ck('an unanswered notification prompt is named',
     res['hang-notify'].stages.some(s => /notify-permission:TIMEOUT/.test(s)));
  ck('reaching usable is recorded', res['none'].stages.some(s => /interactive/.test(s)));

  console.log('\n=== the healthy path must not LIE about being degraded ===');
  ck('healthy boot records no TIMEOUT', !res['none'].stages.some(s => /TIMEOUT/.test(s)),
     'Promise.race does not cancel the loser: an uncancelled timer marks a healthy POS degraded');
  ck('healthy boot is not flagged degraded', !res['none'].degraded,
     'a false "local storage unavailable" banner is a fabricated status');

  /* ── MUTATIONS ─────────────────────────────────────────────────────────── */
  console.log('\n=== mutations: each removes ONE layer and must bring its failure back ===');
  const MUTATIONS = [
    { name: 'boot bounds + watchdog disabled', scenario: 'hang-settings', wait: W,
      edits: [['      }, ms);', '      }, 9000000);'], ['      }, 15000);', '      }, 9000000);']],
      expect: r => !r.revealed,
      says:   'without both, a stalled settings read is a BLACK page' },

    { name: 'post-reveal bound + activation backstop disabled', scenario: 'hang-notify', wait: W,
      edits: [["await _bounded(PosNotify.requestPermission(), 3000, undefined, 'notify-permission');",
               'await PosNotify.requestPermission();'],
              ['setTimeout(_activate, 8000);', 'setTimeout(_activate, 9000000);']],
      expect: r => r.revealed && !r.interactive,
      says:   'an unanswered prompt then renders a till that answers nothing' },

    /* The 6-space `_activate();` is a SUBSTRING of the watchdog's 12-space one, so a bare
       anchor mutates the wrong site and the mutant survives for the wrong reason. Anchor
       on the comment that is unique to the degrade path. */
    { name: 'degrade-path activation + backstop disabled', scenario: 'throw-products', wait: W,
      edits: [["dead screen. */\n      _activate();", 'dead screen. */\n      '],
              ['setTimeout(_activate, 8000);', 'setTimeout(_activate, 9000000);']],
      expect: r => r.revealed && !r.interactive,
      says:   'the catch reveals the app but never wires navigation' },

    /* Two independent things stop a settled step from reporting a stall: clearTimeout
       cancels the timer, and the latch ignores it if it fires anyway. EITHER alone is
       sufficient, so a mutation removing just one correctly survives — remove both, or
       this layer is only apparently tested. */
    { name: 'timer cancellation AND latch removed', scenario: 'none', wait: W,
      edits: [['        done = true; try { clearTimeout(timer); } catch (_) {}', '        done = true;', 2],
              ['        if (done) return;\n        done = true;\n        try { window._posDbDegraded = true; }',
               '        done = true;\n        try { window._posDbDegraded = true; }']],
      expect: r => r.degraded || r.stages.some(s => /TIMEOUT/.test(s)),
      says:   'a healthy boot is then falsely reported as degraded, banner and all' },
  ];

  let survivors = 0;
  for (const m of MUTATIONS) {
    let mutated = CODE, applied = 0;
    for (const [from, to, want] of m.edits) {
      const expected = want || 1;
      const n = mutated.split(from).length - 1;
      if (n !== expected) {
        console.log('  FAIL mutation "' + m.name + '" anchor matched ' + n + ', expected ' + expected +
                    ': ' + JSON.stringify(from.slice(0, 60)));
        fail++; applied = -1; break;
      }
      mutated = mutated.split(from).join(to);
      applied++;
    }
    if (applied !== m.edits.length) continue;                 /* a no-op mutation proves nothing */
    if (mutated === CODE) { ck('mutation "' + m.name + '" changed the source', false, 'no-op mutation'); continue; }
    /* Order matters: mutations anchor on the REAL duration literals, which acceleration
       rewrites. Mutate first, then accelerate what survives. */
    const r = await run(accelerate(mutated), m.scenario, m.wait);
    const killed = m.expect(r);
    if (!killed) survivors++;
    ck('KILLED: ' + m.name, killed,
       'mutant SURVIVED — ' + m.says + ', but the suite did not notice, so that layer is untested');
  }
  ck('no mutant survived', survivors === 0);

  console.log('\n  ' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('SUITE ERROR:', e && e.stack || e); process.exit(1); });
