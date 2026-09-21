#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   SOURCE -> REGISTRATION PROVENANCE — Phase 3

   READ-ONLY against the repository and against production. It parses source,
   loads modules in THIS process, and reads a recorded snapshot. It deploys
   nothing, deletes nothing, contacts no Google API, and RECOMMENDS NOTHING
   FOR RETIREMENT.

   ─────────────────────────────────────────────────────────────────────────
   THE CHAIN, WITH EACH LINK NAMED SEPARATELY
   ─────────────────────────────────────────────────────────────────────────
     definition           the symbol is created somewhere in functions/
     registration         it reaches `exports` on index.js — literally, or
                          through Object.assign
     deployable identity  the value carries Firebase's __endpoint/__trigger
                          marker. A registered symbol that is a plain object
                          or an ordinary function is NOT a deployment unit
     deployed snapshot    the name appears in the 2026-09-19 recorded list

   Collapsing any two of these produces a number that looks authoritative and
   answers no real question. EXPORTED is not REGISTERED-AS-DEPLOYABLE, and
   neither is DEPLOYED.

   ─────────────────────────────────────────────────────────────────────────
   TWO INDEPENDENT RESOLUTION METHODS, AND THEIR DISAGREEMENTS REPORTED
   ─────────────────────────────────────────────────────────────────────────
   Bulk registration — `Object.assign(exports, mod)` — ships every symbol a
   module exports, and the fan-out factories mint their names as COMPUTED KEYS
   (`[`algoliaSync_${col}_create`]`) that appear nowhere literally. Phase 1
   resolved these by requiring the module. That works, but a single method
   cannot detect its own blind spot, so both are run:

     STATIC       parse the factory call sites `..._makeTriggers('stores')`
                  and the computed-key template, and predict the names
     RUNTIME_LOAD require() the module in this process and read Object.keys

   Where they agree the name is CONFIRMED_BY_BOTH. Where they disagree the
   disagreement is printed. An agreement between two methods is evidence; a
   single method's confidence is not.

   A MODULE THAT WILL NOT LOAD IS A FINDING, NOT A SKIP. Phase 1 swallowed
   load errors with `catch (e) { continue; }`. That is the same failure shape
   as the bulk-export gap: the module's exports silently vanish from the
   registry, and its deployed functions then present as orphan candidates —
   a deletion list manufactured by an unreported error. Load failures are
   recorded and surfaced here.

   ─────────────────────────────────────────────────────────────────────────
   WHAT require() COSTS, STATED PLAINLY
   ─────────────────────────────────────────────────────────────────────────
   Loading a functions module executes its top-level code in THIS process:
   defineSecret declarations, registry construction, trigger factories. It does
   not authenticate, does not reach Firestore, and does not touch production —
   but it is execution, not inspection, and it is why the static method exists
   beside it rather than being replaced by it.

   ─────────────────────────────────────────────────────────────────────────
   ABSENCE IS NOT A RETIREMENT RECOMMENDATION
   ─────────────────────────────────────────────────────────────────────────
   Phase 2 established that static absence cannot establish absence of a
   dependency: 15 trigger sites watch template-literal paths built at module
   load. That prohibition carries forward unchanged. A name deployed but not
   registered here is a QUESTION — it may be a dispatcher handler, deployed
   from another branch, or left by an unfinished refactor.

       UNKNOWN DOES NOT MEAN OBSOLETE.

   Nothing in this output authorises a deletion, and no count here is a
   reduction target.

     node scripts/function-registration-provenance.js
     node scripts/function-registration-provenance.js --json
     node scripts/function-registration-provenance.js --name <functionName>
     node scripts/function-registration-provenance.js --unregistered
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FDIR = path.join(ROOT, 'functions');

const ARGS    = process.argv.slice(2);
const hasF    = (f) => ARGS.indexOf(f) !== -1;
const argOf   = (f) => (hasF(f) ? ARGS[ARGS.indexOf(f) + 1] : null);
const AS_JSON = hasF('--json');
const ONE     = argOf('--name');
const UNREG   = hasF('--unregistered');

const EV = {
  BOTH:    'CONFIRMED_BY_BOTH',
  STATIC:  'STATIC_SOURCE_ONLY',
  RUNTIME: 'RUNTIME_LOAD_ONLY',
  LITERAL: 'OBSERVED_SOURCE',
  RECORD:  'RECORDED_SNAPSHOT',
  NONE:    'NOT_ESTABLISHED',
};

/* ── RESOLUTION STATES ───────────────────────────────────────────────────
   Six states, none collapsible into another. The distinction that matters
   most is the last pair:

     RESOLVED                  a literal registration was observed
     RESOLVED_VIA_BULK_EXPORT  reached exports through Object.assign
     LOAD_ERROR                the module threw when required
     PARSE_ERROR               the source could not be read or scanned
     UNRESOLVED                a registration site exists but its target
                               could not be determined
     NOT_PRESENT               the name does not appear at all

   A LOAD_ERROR is a statement about THE ANALYZER'S ability to resolve a
   module. It is not evidence that the production function does not exist.
   Phase 1 collapsed LOAD_ERROR into NOT_PRESENT — pos-retail-mirror threw,
   its exports vanished from the registry, and its live, deployed
   mirrorPosTransactionToRetail was reported as an orphan candidate. A
   deletion question produced by the analyzer's own failure to load a file.

   PARSE_ERROR is kept apart from LOAD_ERROR for the same reason: "I could not
   read it" and "it threw while executing" are different observations with
   different remedies, and neither is "it is not there". */
const RS = {
  RESOLVED:    'RESOLVED',
  BULK:        'RESOLVED_VIA_BULK_EXPORT',
  LOAD_ERROR:  'LOAD_ERROR',
  PARSE_ERROR: 'PARSE_ERROR',
  UNRESOLVED:  'UNRESOLVED',
  NOT_PRESENT: 'NOT_PRESENT',
};

const INDEX_SRC = fs.readFileSync(path.join(FDIR, 'index.js'), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const INDEX = strip(INDEX_SRC);
if (INDEX.length >= INDEX_SRC.length) {
  console.error('FATAL: comment stripper is a no-op on index.js. Refusing to report.');
  process.exit(2);
}

/* The registry of every registered name, keyed by name. */
const reg = new Map();
function record (name, patch) {
  const cur = reg.get(name) || { name: name, definedIn: null, registration: null,
    resolution: RS.NOT_PRESENT,
    deployable: null, deployableEvidence: EV.NONE, resolvedBy: [], notes: [] };
  Object.keys(patch).forEach((k) => {
    if (k === 'resolvedBy' || k === 'notes') { cur[k] = cur[k].concat(patch[k]); return; }
    cur[k] = patch[k];
  });
  reg.set(name, cur);
}

/* ── LINK 1+2: literal registration ──────────────────────────────────────
   `exports.X = …` on index.js. The RHS says whether the body is inline or
   lives in a module re-exported through a bound symbol. */
const bindings = {};
{
  const b = /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m; while ((m = b.exec(INDEX))) bindings[m[1]] = m[2];
}
{
  const re = /^exports\.([A-Za-z0-9_]+)\s*=\s*([^;\n]*)/gm;
  let m;
  while ((m = re.exec(INDEX))) {
    const rhs = (m[2] || '').trim();
    const inline = /^(onCall|onRequest|onSchedule|onDocument|onObject|onMessage|onTask|functions\.)/.test(rhs);
    const sym = inline ? null : (rhs.split(/[.\s(]/)[0] || null);
    record(m[1], {
      definedIn: inline ? 'functions/index.js' : (bindings[sym] || (sym ? '(symbol ' + sym + ')' : null)),
      registration: inline ? 'LITERAL_INLINE' : 'LITERAL_REEXPORT',
      resolution: RS.RESOLVED,
      resolvedBy: ['literal-source'],
      deployableEvidence: EV.LITERAL,
    });
  }
}
const literalCount = reg.size;

/* ── LINK 1+2: bulk registration, resolved TWO ways ──────────────────────── */
const bulkSites = [];
{
  const re = /Object\.assign\(\s*(?:module\.)?exports\s*,\s*([^)]+)\)/g;
  let m;
  while ((m = re.exec(INDEX))) {
    const expr = m[1].trim();
    /* No closing paren required. The outer `[^)]+` capture stops at the FIRST
       `)`, so an inline `Object.assign(exports, require('./x'))` yields the
       expression `require('./x'` — truncated. Demanding `\)` here silently
       dropped catalogue-repair's whole export set and reported the site as
       "MODULE UNRESOLVED". A parser that loses a module is the same defect
       class as one that loses a name. */
    let rel = (/require\(\s*['"]([^'"]+)['"]/.exec(expr) || [])[1];
    if (!rel) rel = bindings[expr.replace(/[^A-Za-z0-9_$]/g, '')] || null;
    bulkSites.push({ expr: expr, module: rel });
  }
}

/* METHOD A — STATIC. Predict computed names from the factory call sites and
   the computed-key template, without executing anything. */
const parseErrors = [];
function staticKeys (relPath) {
  const abs = path.join(FDIR, relPath.replace(/^\.\//, '') +
    (/\.js$/.test(relPath) ? '' : '.js'));
  let src;
  try { src = strip(fs.readFileSync(abs, 'utf8')); }
  catch (e) {
    /* PARSE_ERROR, kept distinct from LOAD_ERROR. "I could not read it" and
       "it threw while executing" are different observations with different
       remedies, and neither one is "it is not there". */
    parseErrors.push({ module: relPath, error: String(e && e.message).split('\n')[0] });
    return null;
  }
  const keys = new Set();

  /* Plain static keys on the exported object literal, and `exports.X =`. */
  let m;
  const plain = /^\s*exports\.([A-Za-z0-9_]+)\s*=/gm;
  while ((m = plain.exec(src))) keys.add(m[1]);

  /* Computed-key templates, e.g. [`algoliaSync_${col}_create`]. Capture the
     template and the variable it interpolates. */
  const templates = [];
  const tre = /\[\s*`([A-Za-z0-9_]*)\$\{([A-Za-z0-9_$.]+)\}([A-Za-z0-9_]*)`\s*\]\s*:/g;
  while ((m = tre.exec(src))) templates.push({ pre: m[1], varName: m[2], post: m[3] });

  /* The literal arguments every factory is spread with: ..._makeX('stores'). */
  const args = [];
  const are = /\.\.\.\s*_?[A-Za-z0-9_]*[Mm]ake[A-Za-z0-9_]*\(\s*['"]([A-Za-z0-9_]+)['"]/g;
  while ((m = are.exec(src))) args.push(m[1]);

  /* A safeKey transform is applied in some factories; record it rather than
     modelling it, so a mismatch shows up as a disagreement instead of a
     silently wrong name. */
  const usesSafeKey = /safeKey/.test(src);

  templates.forEach((t) => args.forEach((a) => keys.add(t.pre + a + t.post)));
  return { keys: keys, templates: templates.length, args: args.length, usesSafeKey: usesSafeKey };
}

/* METHOD B — RUNTIME LOAD. Execute the module and read its keys, testing each
   for Firebase's deployability marker. */
const loadFailures = [];
function runtimeKeys (relPath) {
  let mod;
  try { mod = require(path.join(FDIR, relPath.replace(/^\.\//, ''))); }
  catch (e) {
    loadFailures.push({ module: relPath, error: String(e && e.message).split('\n')[0] });
    return null;
  }
  const deployable = new Set(), nonDeployable = new Set();
  Object.keys(mod || {}).forEach((k) => {
    const v = mod[k];
    if (v && (v.__endpoint || v.__trigger)) deployable.add(k); else nonDeployable.add(k);
  });
  return { deployable: deployable, nonDeployable: nonDeployable };
}

const bulkReport = [];
bulkSites.forEach((site) => {
  if (!site.module) {
    bulkReport.push({ expr: site.expr, module: null, unresolved: true });
    return;
  }
  const st = staticKeys(site.module);
  const rt = runtimeKeys(site.module);
  const sKeys = st ? st.keys : new Set();
  const rAll = rt ? new Set([].concat([...rt.deployable], [...rt.nonDeployable])) : new Set();

  const onlyStatic  = [...sKeys].filter((k) => !rAll.has(k));
  const onlyRuntime = [...rAll].filter((k) => !sKeys.has(k));

  rAll.forEach((k) => {
    const isDep = rt.deployable.has(k);
    record(k, {
      definedIn: 'functions/' + site.module.replace(/^\.\//, '') +
        (/\.js$/.test(site.module) ? '' : '.js'),
      registration: sKeys.has(k) ? 'BULK_COMPUTED_OR_STATIC' : 'BULK_RUNTIME_ONLY',
      resolution: RS.BULK,
      deployable: isDep,
      deployableEvidence: sKeys.has(k) ? EV.BOTH : EV.RUNTIME,
      resolvedBy: sKeys.has(k) ? ['static', 'runtime-load'] : ['runtime-load'],
      notes: isDep ? [] : ['NOT a deployable function identity — no __endpoint/__trigger. ' +
                          'Registered on exports, but Firebase has no deployment unit for it.'],
    });
  });

  /* ── A name the static method found but the runtime method could not ────
     When a module throws on load, discarding what static parsing established
     would repeat the very defect this phase exists to correct: Phase 1's
     silent `catch (e) { continue; }` dropped pos-retail-mirror, and its live,
     registered `mirrorPosTransactionToRetail` then surfaced as an ORPHAN
     CANDIDATE — a deletion question manufactured by an unreported error.

     So the name is recorded, with deployability UNKNOWN rather than assumed.
     One method found it; the other could not run. That is weaker evidence than
     agreement, and it is labelled as such — but it is not nothing, and it is
     emphatically not absence. */
  onlyStatic.forEach((k) => {
    record(k, {
      definedIn: 'functions/' + site.module.replace(/^\.\//, '') +
        (/\.js$/.test(site.module) ? '' : '.js'),
      registration: 'BULK_STATIC_ONLY',
      resolution: rt === null ? RS.LOAD_ERROR : RS.UNRESOLVED,
      deployable: null,
      deployableEvidence: EV.STATIC,
      resolvedBy: ['static'],
      notes: rt === null
        ? ['Module failed to load in this process, so deployability could not be ' +
           'confirmed. Registration IS established from source. Absence of runtime ' +
           'confirmation is NOT evidence of absence.']
        : ['Predicted statically but not present at runtime — investigate.'],
    });
  });

  bulkReport.push({
    expr: site.expr, module: site.module,
    staticKeys: sKeys.size, runtimeKeys: rAll.size,
    deployable: rt ? rt.deployable.size : null,
    nonDeployable: rt ? [...rt.nonDeployable] : null,
    agreement: onlyStatic.length === 0 && onlyRuntime.length === 0,
    onlyStatic: onlyStatic, onlyRuntime: onlyRuntime,
    usesSafeKey: st ? st.usesSafeKey : null,
    loadFailed: rt === null,
  });
});

/* ── LINK 3: deployability for literally registered names ────────────────
   Established from the RHS form rather than by loading index.js, which would
   execute the whole estate. Recorded as such, not overstated. */
reg.forEach((v) => {
  if (v.deployable !== null) return;
  v.deployable = /^LITERAL_/.test(v.registration) ? true : null;
  if (v.deployable === true) {
    v.notes.push('Deployability inferred from the registration form on index.js, ' +
                 'not from a loaded value.');
  }
});

/* ── LINK 4: the recorded snapshot ───────────────────────────────────────── */
let snapshot = null, snapshotErr = null;
try {
  snapshot = new Set(fs.readFileSync(path.join(ROOT, 'scripts/infra/deployed-functions.txt'), 'utf8')
    .split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
} catch (e) { snapshotErr = String(e && e.message); }

/* Dispatcher handlers have no deployment identity of their own. */
const handlerNames = new Set();
(function () {
  const walk = (dir, pre) => {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (f === 'node_modules' || f === 'test' || f.charAt(0) === '.') continue;
        walk(full, pre + f + '/'); continue;
      }
      if (!/\.js$/.test(f)) continue;
      let s; try { s = strip(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }
      /* TWO SHAPES. 529 sites write `exports._h.X =` directly; 198 more bind
         `const _h = {}` first and write `_h.X =`, then attach the table to
         exports. A detector that sees only the prefixed form misses 198 of
         727 handlers — and every one it misses would present as a deployed
         name with no registration, i.e. as an orphan candidate. */
      let m;
      const re = /(?:^|[^A-Za-z0-9_.])(?:exports\.)?_h\.([A-Za-z0-9_]+)\s*=/gm;
      while ((m = re.exec(s))) handlerNames.add(m[1]);
    }
  };
  walk(FDIR, '');
})();

/* ── DEFINED-ANYWHERE-IN-THIS-WORKTREE ───────────────────────────────────
   The decisive question for a deployed name that index.js does not register:
   does this worktree contain it AT ALL? If the source does not define it, the
   name cannot be an orphan of this lineage — it belongs to a different one. */
const definedSomewhere = new Set();
(function () {
  const walk = (dir, pre) => {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (f === 'node_modules' || f === 'test' || f.charAt(0) === '.') continue;
        walk(full, pre + f + '/'); continue;
      }
      if (!/\.js$/.test(f)) continue;
      let s; try { s = strip(fs.readFileSync(full, 'utf8')); } catch (e) { continue; }
      let m;
      const re = /(?:^|\s)(?:exports\.|exports\._h\.|module\.exports\.)([A-Za-z0-9_]+)\s*=/gm;
      while ((m = re.exec(s))) definedSomewhere.add(m[1]);
      const key = /\[\s*`?([A-Za-z0-9_]+)`?\s*\]\s*:/g;
      while ((m = key.exec(s))) definedSomewhere.add(m[1]);
    }
  };
  walk(FDIR, '');
})();

let branch = null;
try {
  branch = fs.readFileSync(path.join(ROOT, '.git/HEAD'), 'utf8').trim()
    .replace(/^ref:\s*refs\/heads\//, '');
} catch (e) { branch = '(unknown)'; }

const names = [...reg.keys()];
const registeredDeployable    = names.filter((n) => reg.get(n).deployable === true);
const registeredNotDeployable = names.filter((n) => reg.get(n).deployable === false);
const registeredUnknownDeploy = names.filter((n) => reg.get(n).deployable === null);

const inSnapshot   = snapshot ? registeredDeployable.filter((n) => snapshot.has(n)) : [];
const notInSnap    = snapshot ? registeredDeployable.filter((n) => !snapshot.has(n)) : [];
const notRegistered = snapshot ? [...snapshot].filter((n) => !reg.has(n)).sort() : [];
const notRegHandler = notRegistered.filter((n) => handlerNames.has(n));
const notRegRest    = notRegistered.filter((n) => !handlerNames.has(n));

/* ── THE JOIN IS CROSS-LINEAGE, AND THAT CHANGES WHAT THE RESIDUE MEANS ──
   Production functions were deployed from a different lineage than this
   worktree's branch. So a deployed name missing from index.js has two very
   different explanations, and only one of them is about this branch at all:

     NOT_IN_THIS_LINEAGE   the name is not defined ANYWHERE in this worktree.
                           It is registered on other branches. This is drift
                           between lineages, not an orphan
     UNREGISTERED_HERE     the source defines it but index.js does not register
                           it. A genuine question FOR THIS BRANCH

   Without the split, a lineage difference reads as a retirement list. That is
   how a routine branch divergence becomes a deletion proposal. */
const notRegOtherLineage = notRegRest.filter((n) => !definedSomewhere.has(n));
const notRegUnknown      = notRegRest.filter((n) => definedSomewhere.has(n));

/* An empty "dispatcher handler" bucket must be distinguishable from a detector
   that cannot match. 529 `exports._h.X =` sites exist; if the detector finds
   none, the zero is an artifact and the classification below is void. */
const handlerDetector = {
  distinctHandlerNames: handlerNames.size,
  pass: handlerNames.size > 0,
  why: 'A measured zero and a broken detector look identical in the output. ' +
       'This proves the detector can match before its zero is believed.',
};

/* ── POSITIVE CONTROL ────────────────────────────────────────────────────
   An empty "deployed but not registered" list would be indistinguishable from
   a join that cannot match at all. intasendWebhook is known deployed and known
   absent from index.js, so the join MUST find it. If it does not, the detector
   is broken and every other figure here is suspect. */
const CONTROL = 'intasendWebhook';
const control = {
  name: CONTROL,
  inSnapshot: snapshot ? snapshot.has(CONTROL) : null,
  registered: reg.has(CONTROL),
  classifiedUnregistered: notRegistered.indexOf(CONTROL) !== -1,
  pass: snapshot ? (snapshot.has(CONTROL) && !reg.has(CONTROL) &&
                    notRegistered.indexOf(CONTROL) !== -1) : null,
  why: 'Known deployed, known absent from index.js. The join must surface it; ' +
       'if it does not, an empty unregistered list would prove nothing.',
};

const resolutionTally = {};
reg.forEach((v) => {
  const k = v.resolution || RS.NOT_PRESENT;
  resolutionTally[k] = (resolutionTally[k] || 0) + 1;
});
if (parseErrors.length) resolutionTally[RS.PARSE_ERROR] = parseErrors.length;

/* ── NAMED FINDING ───────────────────────────────────────────────────────
   Carried as data so nothing downstream has to re-derive it from prose. */
const PROVENANCE_GAP_MERCHANT_IDENTITY = {
  id: 'PROVENANCE GAP — merchant-identity',
  severity: 'DEPLOYMENT SAFETY',
  module: 'functions/merchant-identity.js',
  callables: ['employeeSaleAuthorize', 'adminLinkMerchantAccounts'],
  liveInProduction: true,
  registeredByThisBranch: false,
  moduleReachable: 'YES — pos-zero-friction.js requires it for ._internal.resolveActor, ' +
                   'so the file ships. Only the two callables lack a registration path.',
  basenameCollision: 'index.js requires ./shared/merchant-identity, a DIFFERENT module with ' +
                     'the same basename. The collision makes the gap easy to miss.',
  notARegression: 'The registering commit f194c02 is NOT an ancestor of HEAD, and no commit ' +
                  'on this branch ever touched the registration. 98 branches carry it; this ' +
                  'one never did. This is lineage divergence, not a lost edit.',
  whyNoCasualFix: 'The production estate is a UNION of deploys from several lineages: ' +
                  'release/multishop-checkout-certified does NOT register it either, while ' +
                  'release/multishop-on-e52fdc5 does. No single branch index.js explains the ' +
                  'deployed set, so composing one here would invent a registration no lineage ' +
                  'has. This needs a lineage decision, not an edit.',
  consequence: 'A functions deploy from this worktree omits both callables, and Firebase ' +
               'deletes what a deploy does not contain.',
  resolveBefore: 'ANY functions deployment from this branch, including the GCP reader.',
};

const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  resolutionStates: resolutionTally,
  namedFindings: [PROVENANCE_GAP_MERCHANT_IDENTITY],
  method: {
    static: 'source parse of factory call sites and computed-key templates',
    runtimeLoad: 'require() in this process; executes module top-level code. ' +
                 'No authentication, no Firestore, no production contact.',
    note: 'Both are run so that neither method has to detect its own blind spot.',
  },
  loadFailures: loadFailures,
  positiveControl: control,
  handlerDetector: handlerDetector,
  lineage: {
    branch: branch,
    warning: 'Production functions were deployed from a DIFFERENT lineage than this branch. ' +
             'Both join residues are therefore substantially lineage drift, not orphans.',
  },
  registration: {
    literalOnIndex: literalCount,
    bulkSites: bulkSites.length,
    totalRegisteredNames: reg.size,
    deployableIdentities: registeredDeployable.length,
    registeredButNotDeployable: registeredNotDeployable.length,
    deployabilityUnknown: registeredUnknownDeploy.length,
  },
  bulk: bulkReport,
  snapshotJoin: snapshot ? {
    snapshotCount: snapshot.size,
    registeredAndDeployed: inSnapshot.length,
    registeredNotInSnapshot: notInSnap.length,
    deployedNotRegistered: notRegistered.length,
    ofWhichDispatcherHandlers: notRegHandler.length,
    notDefinedInThisWorktree: notRegOtherLineage.length,
    openQuestions: notRegUnknown.length,
  } : { error: snapshotErr },
  lists: {
    registeredButNotDeployable: registeredNotDeployable,
    registeredNotInSnapshot: notInSnap,
    notDefinedInThisWorktree: notRegOtherLineage,
    openQuestions: notRegUnknown,
  },
  prohibition: 'No figure here is a reduction target. A name deployed but not registered is a ' +
               'QUESTION — a dispatcher handler, another branch, or an unfinished refactor. ' +
               'Phase 2 established that static absence cannot establish absence of a ' +
               'dependency; that prohibition carries forward. UNKNOWN DOES NOT MEAN OBSOLETE.',
};

if (ONE) {
  const v = reg.get(ONE);
  console.log('PROVENANCE — ' + ONE);
  if (!v) {
    console.log('  NOT registered on index.js.');
    console.log('  in recorded snapshot : ' + (snapshot ? (snapshot.has(ONE) ? 'YES' : 'no') : '—'));
    console.log('  dispatcher handler   : ' + (handlerNames.has(ONE) ? 'YES — its deployment ' +
      'identity is its dispatcher, not itself' : 'no'));
    console.log('  => A QUESTION, not a retirement candidate.');
    process.exit(0);
  }
  console.log('  defined in           : ' + v.definedIn);
  console.log('  registration form    : ' + v.registration);
  console.log('  deployable identity  : ' +
    (v.deployable === null ? 'UNKNOWN' : v.deployable ? 'yes (__endpoint/__trigger)' : 'NO'));
  console.log('  resolved by          : ' + (v.resolvedBy.join(' + ') || '—'));
  console.log('  evidence             : ' + v.deployableEvidence);
  console.log('  in recorded snapshot : ' + (snapshot ? (snapshot.has(ONE) ? 'YES' : 'no') : '—'));
  v.notes.forEach((n) => console.log('  note                 : ' + n));
  process.exit(0);
}
if (UNREG) {
  console.log('DEPLOYED BUT NOT REGISTERED ON index.js');
  console.log('These are QUESTIONS. Nothing here is a retirement candidate.');
  console.log('');
  console.log('  dispatcher handlers (identity is their dispatcher) : ' + notRegHandler.length);
  console.log('  NOT defined in this worktree (other lineage)       : ' + notRegOtherLineage.length);
  console.log('  defined here but unregistered — OPEN QUESTIONS     : ' + notRegUnknown.length);
  console.log('');
  console.log('  -- other lineage: registered on other branches, NOT orphans --');
  notRegOtherLineage.forEach((n) => console.log('  ' + n));
  console.log('');
  console.log('  -- open questions for THIS branch --');
  if (!notRegUnknown.length) console.log('  none');
  notRegUnknown.forEach((n) => console.log('  ' + n));
  process.exit(0);
}
if (AS_JSON) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); process.exit(0); }

const P = (n) => String(n === null ? '—' : n).padStart(6);
console.log('══════════════════════════════════════════════════════════════════');
console.log('  SOURCE -> REGISTRATION PROVENANCE — PHASE 3 (read-only)');
console.log('══════════════════════════════════════════════════════════════════');
console.log('');
console.log('  ── POSITIVE CONTROL: ' + CONTROL + ' ────────────────────────');
console.log('  in snapshot ' + (control.inSnapshot ? 'YES' : 'no') +
            ' · registered ' + (control.registered ? 'yes' : 'NO') +
            ' · surfaced ' + (control.classifiedUnregistered ? 'YES' : 'NO') +
            '  =>  ' + (control.pass ? 'PASS' : 'FAIL'));
if (!control.pass) {
  console.log('  The join cannot find a name it is KNOWN to contain. Every figure');
  console.log('  below is suspect. An empty result would have proved nothing.');
}
console.log('');
console.log('  ── CONTROL: can the handler detector match at all? ─────────────');
console.log('  distinct exports._h.X names found: ' + handlerDetector.distinctHandlerNames +
            '   =>  ' + (handlerDetector.pass ? 'PASS' : 'FAIL — its zero is an artifact'));
console.log('');
console.log('  ── MODULE LOAD FAILURES (a finding, never a skip) ──────────────');
if (!loadFailures.length) console.log('  none');
loadFailures.forEach((f) => console.log('  ' + f.module + ' :: ' + f.error));
console.log('');
console.log('  ── LINK 2: REGISTRATION ────────────────────────────────────────');
console.log('  ' + P(literalCount) + '  literal exports.X = on index.js');
console.log('  ' + P(bulkSites.length) + '  Object.assign bulk sites');
console.log('  ' + P(reg.size) + '  registered names, total');
console.log('');
console.log('  ── BULK SITES, RESOLVED TWO WAYS ───────────────────────────────');
bulkReport.forEach((b) => {
  if (b.unresolved) { console.log('  ' + b.expr + '  -> MODULE UNRESOLVED'); return; }
  console.log('  ' + (b.module + '                        ').slice(0, 26) +
    ' static=' + String(b.staticKeys).padStart(3) +
    ' runtime=' + String(b.runtimeKeys).padStart(3) +
    ' deployable=' + String(b.deployable).padStart(3) +
    (b.agreement ? '  AGREE' : '  DISAGREE'));
  if (!b.agreement) {
    if (b.onlyStatic.length)
      console.log('        static-only : ' + b.onlyStatic.slice(0, 6).join(', ') +
        (b.onlyStatic.length > 6 ? ' …+' + (b.onlyStatic.length - 6) : ''));
    if (b.onlyRuntime.length)
      console.log('        runtime-only: ' + b.onlyRuntime.slice(0, 6).join(', ') +
        (b.onlyRuntime.length > 6 ? ' …+' + (b.onlyRuntime.length - 6) : ''));
  }
  if (b.nonDeployable && b.nonDeployable.length)
    console.log('        NOT deployable: ' + b.nonDeployable.join(', '));
});
console.log('');
console.log('  ── LINK 3: EXPORTED IS NOT DEPLOYABLE ──────────────────────────');
console.log('  ' + P(registeredDeployable.length) + '  carry __endpoint/__trigger');
console.log('  ' + P(registeredNotDeployable.length) +
            '  registered but NOT a deployment unit');
console.log('  ' + P(registeredUnknownDeploy.length) + '  deployability unknown');
if (registeredNotDeployable.length) {
  console.log('');
  console.log('  Assigned to exports by Object.assign, but Firebase has no');
  console.log('  deployment unit for them: ' + registeredNotDeployable.join(', '));
}
console.log('');
console.log('  ── LINK 4: THE RECORDED SNAPSHOT (2026-09-19, not live) ────────');
if (!snapshot) { console.log('  UNAVAILABLE :: ' + snapshotErr); }
else {
  console.log('  ' + P(snapshot.size) + '  names in the snapshot');
  console.log('  ' + P(inSnapshot.length) + '  registered AND deployed');
  console.log('  ' + P(notInSnap.length) + '  registered, NOT in the snapshot');
  console.log('  ' + P(notRegistered.length) + '  deployed, NOT registered');
  console.log('  ' + P(notRegHandler.length) + '    of which are dispatcher handlers');
  console.log('  ' + P(notRegOtherLineage.length) +
              '    NOT defined in this worktree -> OTHER LINEAGE');
  console.log('  ' + P(notRegUnknown.length) +
              '    defined here but unregistered -> OPEN QUESTIONS');
  console.log('');
  console.log('  This branch is ' + branch + '. Production functions were');
  console.log('  deployed from a DIFFERENT lineage, so both residues above are');
  console.log('  substantially lineage drift. Without that split, a routine branch');
  console.log('  divergence reads as a retirement list.');
}
console.log('');
console.log('  ── RESOLUTION STATES (none collapsible into another) ───────────');
Object.keys(resolutionTally).sort().forEach((k) =>
  console.log('  ' + P(resolutionTally[k]) + '  ' + k));
console.log('');
console.log('  LOAD_ERROR is a statement about THE ANALYZER, not about production.');
console.log('  Phase 1 collapsed it into NOT_PRESENT and produced a false orphan.');
console.log('');
console.log('  ── NAMED FINDING: PROVENANCE GAP — merchant-identity ───────────');
console.log('  functions/merchant-identity.js defines employeeSaleAuthorize and');
console.log('  adminLinkMerchantAccounts. Both are LIVE in production. Neither is');
console.log('  registered by this branch\'s index.js.');
console.log('');
console.log('  The module is NOT unreachable: pos-zero-friction.js requires it for');
console.log('  ._internal.resolveActor, so the file ships. Only the two callables');
console.log('  have no registration path.');
console.log('');
console.log('  index.js requires ./shared/merchant-identity — a DIFFERENT module');
console.log('  with the same basename. The collision makes the gap easy to miss.');
console.log('');
console.log('  NOT a regression on this line: the registering commit f194c02 is');
console.log('  NOT an ancestor of HEAD, and no commit on this branch ever touched');
console.log('  the registration. 98 branches carry it; this one never did.');
console.log('');
console.log('  DO NOT "FIX" THIS BY ADDING THE EXPORT HERE. The production estate');
console.log('  is a UNION of deploys from several lineages — release/multishop-');
console.log('  checkout-certified does not register it either, while release/');
console.log('  multishop-on-e52fdc5 does. No single branch index.js explains the');
console.log('  deployed set, so composing one here would invent a registration no');
console.log('  lineage has. This needs a lineage decision, not an edit.');
console.log('');
console.log('  CONSEQUENCE, STATED PLAINLY: a functions deploy from this worktree');
console.log('  omits both callables, and Firebase deletes what a deploy does not');
console.log('  contain. That is a deployment-safety gate, not an estate question.');
console.log('');
console.log('  ── PROHIBITION ─────────────────────────────────────────────────');
console.log('  No figure here is a reduction target. A name deployed but not');
console.log('  registered is a QUESTION — a dispatcher handler, another branch,');
console.log('  or an unfinished refactor. Phase 2 established that static absence');
console.log('  cannot establish absence of a dependency, and that carries forward.');
console.log('  UNKNOWN DOES NOT MEAN OBSOLETE.');
console.log('══════════════════════════════════════════════════════════════════');
