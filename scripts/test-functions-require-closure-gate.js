'use strict';
/**
 * CERT — the functions require-closure gate.
 *
 * WHAT THIS GATE IS FOR
 *   `functions/index.js` has required modules committed nowhere since fa5082b. That was known
 *   and the mitigation was a sentence in a commit message — "NEVER deploy FULL index.js" — with
 *   no mechanism behind it. `predeploy-syntax-gate.js` runs `node --check`, which parses and
 *   never resolves a require, so it cannot catch this class.
 *
 * THE INVARIANT
 *   The gate must measure the GIT TREE, not the filesystem. Every module it reports as missing
 *   at HEAD is sitting on this disk right now as another workstream's untracked file. A gate
 *   that looked at the disk would pass, and that is exactly the error this suite exists to
 *   prevent recurring — it is the error I made when I reported "the graph is closed".
 *
 * NON-VACUITY
 *   A gate that always fails proves nothing. §2 runs it against a real ref whose graph really
 *   does close (`fa5082b^`, the commit before the broken requires landed) and requires a PASS.
 */

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts/gate-functions-require-closure.js');
const G = require(GATE);

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

console.log('\nCERT — functions require-closure gate\n');

function run (args) {
  try {
    const out = execFileSync('node', [GATE].concat(args), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const json = (r) => { try { return JSON.parse(r.out); } catch (_) { return null; } };

/* ══════════════════════════════════════════════════════════
   §1 the gate FAILS at HEAD, and names exactly the right modules
══════════════════════════════════════════════════════════ */
console.log('§1 HEAD is not closed');
{
  const r = run(['--json']);
  const d = json(r);
  check('the gate runs and returns JSON', !!d);
  check('it exits non-zero at HEAD', r.code === 1);
  check('it reports HEAD as not ok', d && d.ok === false);
  const mods = (d.blocking || []).map((x) => x.module.replace('functions/', '')).sort();
  check('it names exactly the four known modules',
    mods.join(',') === 'commission-invoice,manual-till-orders,order-claim,pos-mpesa-refs');
  check('each is attributed to index.js',
    d.blocking.every((x) => x.requiredBy.indexOf('functions/index.js') !== -1));
  check('it reached a real graph, not an empty one', d.reachableModules > 250);
  check('the entrypoint is the deploy entrypoint', d.entry === 'functions/index.js');
}

/* ══════════════════════════════════════════════════════════
   §2 NON-VACUITY — it PASSES on a ref that genuinely closes
══════════════════════════════════════════════════════════ */
console.log('\n§2 non-vacuity');
{
  const r = run(['--ref', 'fa5082b^', '--json']);
  const d = json(r);
  check('a ref whose graph closes EXITS ZERO', r.code === 0);
  check('  ...and reports ok', d && d.ok === true);
  check('  ...with no blocking modules', d && d.blocking.length === 0);
  check('  ...having walked a real graph', d && d.reachableModules > 250);
  /* The differential is the point: same gate, same repo, two refs, opposite verdicts. */
  check('so the gate DISCRIMINATES between refs, it does not always fail',
    run(['--json']).code === 1 && r.code === 0);
  sab('a gate that always failed would be caught here', 1 === 1 && r.code === 0);
}

/* ══════════════════════════════════════════════════════════
   §3 IT READS THE TREE, NOT THE DISK — the error this prevents
══════════════════════════════════════════════════════════ */
console.log('\n§3 tree, not filesystem');
{
  const fs = require('fs');
  const d = json(run(['--json']));
  const onDisk = d.blocking.filter((x) => fs.existsSync(path.join(ROOT, x.module + '.js')));
  check('every module it calls missing IS present on this disk right now',
    onDisk.length === d.blocking.length && onDisk.length === 4);
  check('  ...so a filesystem scan would have passed, and the gate still fails',
    d.ok === false);
  check('it labels them present-UNTRACKED rather than silently ignoring them',
    d.blocking.filter((x) => x.workingTree === 'present-UNTRACKED').length === 4);
  check('the human output states that disk presence is not closure',
    /NOT CLOSURE: a deploy uses a checkout/.test(run([]).out));
  check('it distinguishes a module committed elsewhere from one with no provenance', (function () {
    const byMod = {}; d.blocking.forEach((x) => { byMod[x.module.replace('functions/', '')] = x; });
    return byMod['pos-mpesa-refs'].committedElsewhere !== null &&
           byMod['order-claim'].committedElsewhere === null;
  })());
  sab('the disk-vs-tree detector would fire if the gate consulted the disk',
    fs.existsSync(path.join(ROOT, 'functions/order-claim.js')));
}

/* ══════════════════════════════════════════════════════════
   §4 IT CANNOT PASS VACUOUSLY
══════════════════════════════════════════════════════════ */
console.log('\n§4 refuses to pass vacuously');
{
  /* Git's canonical EMPTY TREE. An earlier version of this check used the repository's root
     commit, assuming it predated functions/ — it does not: the root commit carries
     functions/index.js and its 35-module graph legitimately closes, so exit 0 was correct
     there and the test was wrong, not the gate. The empty tree is unambiguous. */
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const r = run(['--ref', EMPTY_TREE]);
  check('a ref without the entrypoint exits 2 (gate error), NOT 0', r.code === 2);
  check('  ...and says so', /not in the tree|refusing to pass vacuously/.test(r.out));
  const bad = run(['--ref', 'refs/heads/definitely-not-a-real-ref-xyz']);
  check('an unreadable ref exits 2, NOT 0', bad.code === 2);
  sab('an exit-0-on-error gate would be caught here', r.code !== 0);

  /* And the converse, which is the stronger statement: a SMALL graph that really does close
     must pass. The root commit is exactly that — 35 modules, all resolving. */
  const root = execFileSync('git', ['rev-list', '--max-parents=0', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n')[0];
  const rootRun = run(['--ref', root, '--json']);
  const rootJson = json(rootRun);
  check('a small graph that genuinely closes PASSES', rootRun.code === 0);
  check('  ...and it really was small, so size is not what decides the verdict',
    rootJson && rootJson.reachableModules > 0 && rootJson.reachableModules < 100);
}

/* ══════════════════════════════════════════════════════════
   §5 THE SCANNER ITSELF — comments are not requires
══════════════════════════════════════════════════════════ */
console.log('\n§5 scanner correctness');
{
  const scan = (src) => {
    const s = G.stripComments(src);
    const out = []; let m; G.STATIC_RE.lastIndex = 0;
    while ((m = G.STATIC_RE.exec(s))) out.push(m[2]);
    return out;
  };
  check('a real require is found', scan("const x = require('./real');").join() === './real');
  check('a block-commented require is NOT counted',
    scan("/* require('./ghost') */\nconst y = 1;").length === 0);
  check('a line-commented require is NOT counted',
    scan("// require('./ghost')\nconst y = 1;").length === 0);
  check('prose naming a module does not become a require',
    scan("/* never require('./order-claim') again */\nconst y = 1;").length === 0);
  check('a real require next to a commented one is still found',
    scan("/* require('./ghost') */\nconst z = require('./real');").join() === './real');
  sab('the stripper does not blind the scanner to real code',
    scan("/* doc */\nrequire('./real');").length === 1);
  check('a bare package require is not treated as local',
    scan("const a = require('firebase-admin');").length === 0);
  check('a URL in a comment does not break line-stripping',
    scan("// see https://x.example/y\nconst z = require('./real');").join() === './real');

  check('./ resolves within the same directory',
    G.normalise('functions/index.js', './order-claim') === 'functions/order-claim');
  check('../ escapes the directory, so a root module is not falsely missing',
    G.normalise('functions/test/a.test.js', '../../sokoni-delivery-engine.js') === 'sokoni-delivery-engine.js');
  check('nested ./ resolves',
    G.normalise('functions/index.js', './sub/mod') === 'functions/sub/mod');
  sab('a normaliser that ignored ../ would be caught',
    G.normalise('functions/test/a.js', '../x') !== 'functions/test/x');
}

/* ══════════════════════════════════════════════════════════
   §6 SCOPE — blocking vs non-blocking is a real distinction
══════════════════════════════════════════════════════════ */
console.log('\n§6 blocking vs non-blocking');
{
  const d = json(run(['--json']));
  check('non-blocking findings are reported separately', Array.isArray(d.nonBlocking));
  check('they do not affect the verdict — the four blockers alone decide it',
    d.blocking.length === 4);
  check('a file the entrypoint never loads is not in the blocking set',
    d.blocking.every((x) => !/\/test\/|probe-/.test(x.requiredBy.join(','))));
  check('the gate does not wire itself into any deploy path — that is a separate decision',
    !/predeploy|firebase deploy/.test(require('fs').readFileSync(GATE, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')));
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
console.log('\n  PASS — the gate measures the tree, discriminates between refs, and cannot pass vacuously.\n');
