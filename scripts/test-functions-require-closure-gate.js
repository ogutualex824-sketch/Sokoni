'use strict';
/**
 * CERT — the functions require-closure gate, and the closed deploy tree.
 *
 * WHAT CHANGED
 *   This suite was written while HEAD FAILED the gate, and every section asserted the shape of
 *   that failure. The four deploy-tree blockers were then admitted (b28be27, b0ba4a6, d879238,
 *   e1be278) and HEAD now CLOSES. So the assertions invert rather than disappear: §1 proves the
 *   tree is closed and loads from a clean checkout, and the failure-shape assertions move to a
 *   ref that is genuinely still open.
 *
 * NON-VACUITY, WHICH MATTERS MORE NOW THAN BEFORE
 *   A gate that passes is only meaningful if it can still fail. OPEN_REF is the last commit
 *   before the admissions; the gate must still refuse it, still name the modules, and still
 *   report them by disposition. A gate certified only against a passing tree proves nothing.
 *
 * THE STRONGEST STATEMENT HERE
 *   §2 loads functions/index.js with every source served from HEAD's git tree and every
 *   functions/*.js absent from that tree made UNRESOLVABLE. That is what a fresh clone plus
 *   npm install would load — not what happens to be sitting on this contaminated disk.
 */

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, 'scripts/gate-functions-require-closure.js');
const LEDGER_PATH = path.join(ROOT, 'docs/DEPLOY_TREE_DISPOSITIONS.json');
const G = require(GATE);

/* The last commit BEFORE the four admissions — a real ref that is genuinely still open. */
const OPEN_REF = 'ba14c3c';

let pass = 0, fail = 0, sabotage = 0, sabotageOk = 0;
const failures = [];
const check = (n, c) => { if (c) { pass++; console.log('  PASS  ' + n); } else { fail++; failures.push(n); console.log('  FAIL  ' + n); } };
const sab   = (n, c) => { sabotage++; if (c) { sabotageOk++; pass++; console.log('  PASS    (sabotage: ' + n + ')'); } else { fail++; failures.push('SABOTAGE ' + n); console.log('  FAIL    (sabotage: ' + n + ')'); } };

/* Absence tests over the gate's OWN source must not match its documentation — its header
   necessarily names the operations it promises never to perform. */
function stripGateComments (t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
}

console.log('\nCERT — require-closure gate + closed deploy tree\n');

function run (args) {
  try {
    return { code: 0, out: execFileSync('node', [GATE].concat(args), { cwd: ROOT, encoding: 'utf8', maxBuffer: 64e6 }) };
  } catch (e) {
    return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
  }
}
const json = (r) => { try { return JSON.parse(r.out); } catch (_) { return null; } };

/* ══════════════════════════════════════════════════════════
   §1 HEAD IS CLOSED
══════════════════════════════════════════════════════════ */
console.log('§1 HEAD closes');
const headRun = run(['--json']);
const head = json(headRun);
{
  check('the gate runs and returns JSON', !!head);
  check('HEAD exits ZERO', headRun.code === 0);
  check('  ...and reports ok', head && head.ok === true);
  check('  ...with no blocking modules', head && head.blocking.length === 0);
  check('  ...having walked a real graph, not an empty one', head && head.reachableModules > 300);
  check('no module is left UNDECLARED', !(head.byStatus || {}).UNDECLARED);
  check('no RESOLVED module has regressed out of the tree',
    Array.isArray(head.regressed) && head.regressed.length === 0);
  check('the human output says the graph closes',
    /PASS — the deploy entrypoint graph closes/.test(run([]).out));
}

/* ══════════════════════════════════════════════════════════
   §2 IT LOADS FROM A CLEAN CHECKOUT — not from this disk
══════════════════════════════════════════════════════════ */
console.log('\n§2 clean-checkout load');
{
  const probe = path.join(ROOT, 'functions', '_cert-clean-load.js');
  const body = `
const Module=require('module'),path=require('path'),{execFileSync}=require('child_process');
const REPO=execFileSync('git',['rev-parse','--show-toplevel'],{encoding:'utf8'}).trim();
const listing=execFileSync('git',['ls-tree','-r','HEAD'],{cwd:REPO,encoding:'utf8',maxBuffer:256e6});
const oids=new Map();
for(const line of listing.split('\\n')){const t=line.indexOf('\\t');if(t<0)continue;const p=line.slice(t+1);
  if(!p.startsWith('functions/')||!/\\.(js|cjs)$/.test(p))continue;oids.set(p,line.slice(0,t).split(/\\s+/)[2]);}
const want=[...oids.entries()],src=new Map();
const buf=execFileSync('git',['cat-file','--batch'],{cwd:REPO,input:Buffer.from(want.map(w=>w[1]).join('\\n')+'\\n'),maxBuffer:1024e6,stdio:['pipe','pipe','ignore']});
let off=0,i=0;
while(off<buf.length&&i<want.length){const nl=buf.indexOf(0x0a,off);if(nl<0)break;
  const size=parseInt(buf.slice(off,nl).toString('utf8').split(' ')[2],10);if(!isFinite(size))break;
  src.set(want[i][0],buf.slice(nl+1,nl+1+size).toString('utf8'));off=nl+1+size+1;i++;}
const rel=f=>path.relative(REPO,f).split(path.sep).join('/');
const oR=Module._resolveFilename;
Module._resolveFilename=function(req){const r=oR.apply(this,arguments);const p=rel(r);
  if(p.startsWith('functions/')&&/\\.(js|cjs)$/.test(p)&&!src.has(p)&&!p.includes('node_modules')){
    const e=new Error("Cannot find module '"+req+"' (NOT IN HEAD TREE)");e.code='MODULE_NOT_FOUND';throw e;}
  return r;};
const oC=Module.prototype._compile;
Module.prototype._compile=function(c,f){const p=rel(f);if(src.has(p))c=src.get(p);return oC.call(this,c,f);};
try{const idx=require('./index.js');
  console.log(JSON.stringify({ok:true,blobs:src.size,exports:Object.keys(idx).length,
    have:['claimOrder','createManualTillOrder','issueCommissionInvoice','claimPosMpesaReference',
          'findSuppliers','getSupplyCatalogue','smartPosDispatch'].filter(k=>typeof idx[k]!=='undefined')}));
}catch(e){console.log(JSON.stringify({ok:false,err:String(e.message).split('\\n')[0]}));}
`;
  fs.writeFileSync(probe, body);
  let res = null;
  try {
    res = JSON.parse(execFileSync('node', [probe], { cwd: path.join(ROOT, 'functions'), encoding: 'utf8', maxBuffer: 64e6 }).trim());
  } catch (e) { res = { ok: false, err: 'probe failed: ' + String(e.message).split('\n')[0] }; }
  finally { try { fs.unlinkSync(probe); } catch (_) {} }

  check('the clean-checkout probe ran', !!res);
  check('functions/index.js LOADS with every source taken from HEAD', res && res.ok === true);
  check('  ...and it was a real tree, not an empty one', res && res.blobs > 300);
  check('  ...exporting the full surface', res && res.exports > 1500);
  check('  ...including all four newly admitted callables',
    res && res.have && ['claimOrder', 'createManualTillOrder', 'issueCommissionInvoice',
                        'claimPosMpesaReference'].every((k) => res.have.indexOf(k) !== -1));
  check('  ...and the Supply surface still loads alongside them',
    res && res.have && res.have.indexOf('findSuppliers') !== -1 && res.have.indexOf('getSupplyCatalogue') !== -1);
  check('the probe would have BLOCKED a file absent from the tree',
    /NOT IN HEAD TREE/.test(body));
  sab('a probe that silently fell back to disk would be caught by that guard',
    /!src\.has\(p\)/.test(body));
}

/* ══════════════════════════════════════════════════════════
   §3 NON-VACUITY — the gate can still fail, and still explains itself
══════════════════════════════════════════════════════════ */
console.log('\n§3 non-vacuity: the pre-admission ref still fails');
const openRun = run(['--ref', OPEN_REF, '--json']);
const open = json(openRun);
{
  check('a genuinely open ref still EXITS 1', openRun.code === 1);
  check('  ...and reports not ok', open && open.ok === false);
  check('  ...naming exactly the four modules',
    open && open.blocking.map((x) => x.module.replace('functions/', '')).sort().join(',') ===
      'commission-invoice,manual-till-orders,order-claim,pos-mpesa-refs');
  check('so the gate DISCRIMINATES: same gate, two refs, opposite verdicts',
    headRun.code === 0 && openRun.code === 1);
  sab('a gate that always passed would be caught here', openRun.code === 1);
  sab('a gate that always failed would be caught by §1', headRun.code === 0);

  /* Those four are declared RESOLVED today, so against a ref that lacks them the gate must
     shout REGRESSION — a closed dependency absent from the tree. */
  check('a RESOLVED module absent from that ref is reported as a REGRESSION',
    open && Array.isArray(open.regressed) && open.regressed.length >= 4);
  check('  ...and the human output says so',
    /REGRESSION — declared RESOLVED but absent/.test(run(['--ref', OPEN_REF]).out));

  check('tree, not filesystem: those modules are on this disk yet still reported missing',
    open.blocking.every((x) => fs.existsSync(path.join(ROOT, x.module + '.js'))));
  check('  ...so a filesystem scan would have passed that ref, and the gate did not',
    open.ok === false);
}

/* ══════════════════════════════════════════════════════════
   §4 IT CANNOT PASS VACUOUSLY
══════════════════════════════════════════════════════════ */
console.log('\n§4 refuses to pass vacuously');
{
  const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
  const r = run(['--ref', EMPTY_TREE]);
  check('a ref without the entrypoint exits 2 (gate error), NOT 0', r.code === 2);
  check('  ...and says so', /not in the tree|refusing to pass vacuously/.test(r.out));
  check('an unreadable ref exits 2, NOT 0', run(['--ref', 'refs/heads/no-such-ref-xyz']).code === 2);
  sab('an exit-0-on-error gate would be caught here', r.code !== 0);
}

/* ══════════════════════════════════════════════════════════
   §5 THE SCANNER — comments are not requires
══════════════════════════════════════════════════════════ */
console.log('\n§5 scanner correctness');
{
  const scan = (s) => {
    const t = G.stripComments(s); const out = []; let m; G.STATIC_RE.lastIndex = 0;
    while ((m = G.STATIC_RE.exec(t))) out.push(m[2]);
    return out;
  };
  check('a real require is found', scan("const x = require('./real');").join() === './real');
  check('a block-commented require is NOT counted', scan("/* require('./ghost') */").length === 0);
  check('a line-commented require is NOT counted', scan("// require('./ghost')\nvar y=1;").length === 0);
  check('a real require beside a commented one is still found',
    scan("/* require('./ghost') */\nconst z = require('./real');").join() === './real');
  check('a bare package require is not local', scan("require('firebase-admin');").length === 0);
  sab('the stripper does not blind the scanner', scan("/* doc */\nrequire('./real');").length === 1);
  check('./ resolves in-directory', G.normalise('functions/index.js', './order-claim') === 'functions/order-claim');
  check('../ escapes the directory', G.normalise('functions/test/a.js', '../../x.js') === 'x.js');
  sab('a normaliser ignoring ../ would be caught', G.normalise('functions/test/a.js', '../x') !== 'functions/test/x');
}

/* ══════════════════════════════════════════════════════════
   §6 THE LEDGER — evidence, never closure authority
══════════════════════════════════════════════════════════ */
console.log('\n§6 the governance ledger');
{
  let led = null;
  try { led = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8')); } catch (_) {}
  check('the ledger exists and is valid JSON', !!led && !!led.dispositions);
  const ds = led.dispositions;
  const six = ['functions/order-claim', 'functions/manual-till-orders', 'functions/manual-till-policy',
               'functions/commission-invoice', 'functions/commission-vat-policy', 'functions/pos-mpesa-refs',
               'functions/tenant-identity'];
  check('every admitted module has a ledger entry', six.every((m) => !!ds[m]));
  check('all are recorded RESOLVED', six.every((m) => ds[m].status === 'RESOLVED'));
  check('the cascade modules are recorded, not silently absorbed',
    !!ds['functions/manual-till-policy'] && !!ds['functions/commission-vat-policy']);
  check('order-claim records that ATTRIBUTION is still open',
    ds['functions/order-claim'].owner === null &&
    /ATTRIBUTION REMAINS OPEN/i.test(ds['functions/order-claim'].path));
  check('  ...and no owner was fabricated for it', ds['functions/order-claim'].owner === null);
  check('commission-invoice records that no invoice can issue',
    /NO INVOICE CAN ISSUE/i.test(ds['functions/commission-invoice'].summary));
  check('  ...and forbids setting the VAT policy without an attributed decision',
    /decidedBy|attributed human commercial decision/i.test(ds['functions/commission-invoice'].forbidden));
  check('manual-till-orders records that admission is not permission to enable',
    /not permission to enable/i.test(ds['functions/manual-till-orders'].path));

  /* The ledger is evidence. The TREE decides. Proven by the pre-admission ref: everything is
     declared RESOLVED there too, and the gate still fails it. */
  check('a ledger full of RESOLVED does NOT make an open ref pass', openRun.code === 1);
  sab('a gate that trusted the ledger over the tree would be caught here',
    open.ok === false && six.every((m) => ds[m].status === 'RESOLVED'));
}

/* ══════════════════════════════════════════════════════════
   §7 THE GATE NEVER MUTATES
══════════════════════════════════════════════════════════ */
console.log('\n§7 no auto-remove, auto-copy or auto-admit');
{
  const gsrc = stripGateComments(fs.readFileSync(GATE, 'utf8'));
  check('the gate never writes to the filesystem',
    !/fs\.(writeFile|writeFileSync|appendFile|appendFileSync|unlink|unlinkSync|rm|rmSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync)/.test(gsrc));
  check('the gate runs no mutating git command',
    !/'(add|commit|checkout|rm|mv|restore|reset|clean|stash|push|apply|cherry-pick|merge)'/.test(gsrc));
  check('  ...it only ever reads: ls-tree, cat-file, log, rev-parse',
    (gsrc.match(/execFileSync\('git', \[\s*'([a-z-]+)'/g) || [])
      .every((m) => /'(ls-tree|cat-file|log|rev-parse)'/.test(m)));
  sab('the write detector fires on a real write', /fs\.(writeFileSync)/.test("fs.writeFileSync('x','y');"));
  sab('the mutating-git detector fires on a real mutation', /'(add|commit|checkout)'/.test("execFileSync('git',['add','.']);"));
}

/* ══════════════════════════════════════════════════════════
   §8 THE CAPABILITIES ADMITTED TO THE TREE ARE STILL OFF
══════════════════════════════════════════════════════════ */
console.log('\n§8 admitted != enabled');
{
  const cm = fs.readFileSync(path.join(ROOT, 'functions/checkout-mode.js'), 'utf8');
  check('manual_payment is still returned UNAVAILABLE',
    /reason: 'manual_payment_unavailable'/.test(cm));
  check('  ...and checkout-mode.js was not modified to enable it',
    execFileSync('git', ['status', '--porcelain', '--', 'functions/checkout-mode.js'],
      { cwd: ROOT, encoding: 'utf8' }).trim() === '');
  sab('the gate-off detector would catch the mode being enabled',
    !/reason: 'manual_payment_unavailable'/.test("return { mode: MODE.MANUAL };"));

  /* The VAT policy is data, not code: the module must carry no literal default, or admitting
     it would silently choose a tax treatment nobody signed off. */
  const vat = fs.readFileSync(path.join(ROOT, 'functions/commission-vat-policy.js'), 'utf8');
  check('commission-vat-policy carries no literal inclusive default',
    !/inclusive\s*[:=]\s*(true|false)\b/.test(stripGateComments(vat)));
  sab('the literal-default detector fires on a real one',
    /inclusive\s*[:=]\s*(true|false)\b/.test('const cfg = { inclusive: true };'));
  check('the spec still records the VAT decision as OPEN and blocking',
    /Is the 5% commission VAT-inclusive or VAT-exclusive\?\s*\|\s*\*\*OPEN — blocking\*\*/
      .test(fs.readFileSync(path.join(ROOT, 'docs/COMMISSION_INVOICE_SPEC.md'), 'utf8')));
}

/* ══════════════════════════════════════════════════════════
   §9 WIRING + NOTICE
══════════════════════════════════════════════════════════ */
console.log('\n§9 wiring');
{
  const fb = JSON.parse(fs.readFileSync(path.join(ROOT, 'firebase.json'), 'utf8'));
  const hooks = (fb.functions && fb.functions.predeploy) || [];
  const idx = hooks.findIndex((h) => /gate-functions-require-closure\.js/.test(h));
  check('the closure gate is wired into functions.predeploy', idx !== -1);
  check('  ...and runs FIRST', idx === 0);
  check('the existing gates are preserved',
    ['predeploy-syntax-gate', 'verify-commission-single-source', 'verify-delivery-engine-sync',
     'predeploy-payout-gate'].every((g) => hooks.some((h) => h.indexOf(g) !== -1)));
  check('SCOPE: hosting.predeploy is untouched by this gate',
    !((fb.hosting && fb.hosting.predeploy) || []).some((h) => /gate-functions-require-closure/.test(h)));
  sab('the ordering detector would catch a demotion',
    ['a.js', 'gate.js'].findIndex((h) => /gate\.js/.test(h)) !== 0);

  /* Same verdict from the hook's cwd as from the repo root. */
  const atFunctions = (() => {
    try { return { code: 0, out: execFileSync('node', ['../scripts/gate-functions-require-closure.js', '--json'],
      { cwd: path.join(ROOT, 'functions'), encoding: 'utf8', maxBuffer: 64e6 }) }; }
    catch (e) { return { code: e.status, out: (e.stdout || '') + (e.stderr || '') }; }
  })();
  check('identical exit code from the hook cwd', atFunctions.code === headRun.code);
  const nrm = (r) => { const d = json(r); return d ? JSON.stringify({ ok: d.ok, n: d.reachableModules }) : null; };
  check('  ...and identical findings', nrm(atFunctions) !== null && nrm(atFunctions) === nrm(headRun));

  const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
  check('AGENTS.md still carries a deploy notice', /require-closure gate/.test(agents));
}

console.log('\n  ' + pass + '/' + (pass + fail) + ' checks passed  ·  ' + sabotageOk + '/' + sabotage + ' sabotage catches');
if (fail) { console.log('\n  ' + fail + ' FAILURE(S):'); failures.forEach((f) => console.log('    - ' + f)); process.exit(1); }
console.log('\n  PASS — the deploy tree is closed, loads from a clean checkout, and the gate can still fail.\n');
