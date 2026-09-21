#!/usr/bin/env node
/* ══════════════════════════════════════════════════════════════════════════════
   FUNCTION DEPENDENCY GRAPH — scripts/function-dependency-graph.js      PHASE 2

   READ-ONLY. Parses source. Deploys nothing, deletes nothing, contacts nothing,
   and CLASSIFIES nothing as obsolete.

   ─────────────────────────────────────────────────────────────────────────
   EVERY EDGE CARRIES ITS EVIDENCE TYPE
   ─────────────────────────────────────────────────────────────────────────
   A graph whose arrows all look alike invites a reader to treat a guess as a
   measurement. Each edge states what it is entitled to claim:

     OBSERVED_SOURCE    written in the source — a require, a definition site,
                        a defineSecret, a trigger registration
     SOURCE_REFERENCE   a literal appears in source. Does NOT establish that
                        the referenced thing exists in production
     DERIVED            two observations joined. A module references a
                        collection a trigger watches, so the trigger MAY fire.
                        Plausible, not witnessed
     NOT_ESTABLISHED    needs runtime evidence this phase cannot obtain

   "module A -> references collection X -> SOURCE_REFERENCE" is the strongest
   honest claim available here. NOT "uses Firestore collection X", and never
   "collection X exists" — the reader that would establish that is implemented
   and NOT DEPLOYED.

   ─────────────────────────────────────────────────────────────────────────
   TWO PARSER GAPS WERE FOUND BY PROBING, NOT BY TRUSTING THE FIRST REGEX
   ─────────────────────────────────────────────────────────────────────────
   The first draft of this script silently produced two wrong populations.

   1. TRIGGERS. A regex for onDocumentCreated('path' saw 14 of 22 sites. The
      other 8 use the options-object form
      onDocumentCreated({ ...OPTS, document: 'orders/{orderId}' }, …), and
      ALL EIGHT live in redis-integrations.js: orders, payments, products,
      users, riders, deliveries — the busiest collections on the platform, and
      they include onOrderCreated and onOrderStatusChange from the AR recovery
      manifest. The derived write->trigger edges for those collections were not
      wrong; they were ABSENT, and an absent edge looks exactly like a
      collection nothing listens to. Both forms are parsed now.

      This is the Phase 1 lesson recurring: there, Object.assign(exports, mod)
      hid 90 live functions and presented them as retirement candidates. A
      parser gap does not announce itself — it produces a clean-looking report.

   2. COLLECTIONS ARE A FLOOR, NOT A TOTAL. Of 5,326 .collection( sites, 547
      take a variable or template literal — .collection(COL.SESSIONS), or a
      template path built from a tenant id. They are counted as an
      UNRESOLVED_DYNAMIC population and never guessed at. The distinct-name
      figure is therefore a LOWER BOUND. Pinning a census to a total it cannot
      support is how a floor gets read as an inventory.

   ─────────────────────────────────────────────────────────────────────────
   THE COLLECTION DISCREPANCY IS A FINDING, NOT A RECONCILIATION TASK
   ─────────────────────────────────────────────────────────────────────────
   Source references N distinct collection literals. The Firestore estate has
   been cited elsewhere at 217 root collections. These are kept as INDEPENDENT
   populations with the relation marked UNRESOLVED.

   No reconciliation is attempted, because the difference has at least five
   causes this script cannot distinguish: subcollections counted as roots, the
   dynamic paths, references to collections that no longer exist, collections
   outside the measured population, and archived code. Guessing which is which
   would make this graph a second source of fabricated inventory — the thing
   the estate map exists to prevent.

   ─────────────────────────────────────────────────────────────────────────
   THE GRAPH CANNOT SUPPORT A NEGATIVE CLAIM
   ─────────────────────────────────────────────────────────────────────────
   15 of 108 trigger sites register a TEMPLATE-LITERAL path — a collection
   taken from a loop variable — in the fan-out factories algolia-sync,
   typesense-sync, search-sync, async-jobs, shop-name-sync, typesense-analytics
   and wap. What each one watches is decided at module load, so it cannot be
   resolved from source.

   Those are precisely the highest-fan-out triggers in the estate: the same
   factories whose bulk exports Phase 1 nearly presented as 90 retirement
   candidates. Because their watched collections are unknown, a collection may
   have listeners this graph cannot see.

   THEREFORE: "no trigger watches collection X" is NOT a conclusion this graph
   licenses, and neither is "nothing depends on this module". An absent edge
   means NOT OBSERVED, never NOT PRESENT. Every population below is a FLOOR,
   and nothing may be retired on the strength of an absence.

   ─────────────────────────────────────────────────────────────────────────
   POPULATIONS, DELIBERATELY NOT EQUATED
   ─────────────────────────────────────────────────────────────────────────
     source definitions       every trigger definition site in functions/,
                              including helpers, dead code, and definitions
                              never exported
     literal exports          exports.X = in index.js. EXCLUDES bulk
                              Object.assign exports by construction — Phase 1
                              resolves those and reports the larger figure
     deployed snapshot        recorded 2026-09-19, not live truth
     observed at runtime      NOT ESTABLISHED

   These are different numbers. Reconciling them is Phases 3-5; collapsing them
   here would destroy the gap those phases exist to explain.

     node scripts/function-dependency-graph.js
     node scripts/function-dependency-graph.js --json
     node scripts/function-dependency-graph.js --module <path>
     node scripts/function-dependency-graph.js --collection <name>
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const fs   = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
const FDIR = path.join(ROOT, 'functions');

const ARGS    = process.argv.slice(2);
const has     = (f) => ARGS.indexOf(f) !== -1;
const argOf   = (f) => (has(f) ? ARGS[ARGS.indexOf(f) + 1] : null);
const AS_JSON = has('--json');
const ONE_MOD = argOf('--module');
const ONE_COL = argOf('--collection');

const EV = {
  OBSERVED:  'OBSERVED_SOURCE',
  REFERENCE: 'SOURCE_REFERENCE',
  DERIVED:   'DERIVED',
  NONE:      'NOT_ESTABLISHED',
};

/* ── ZONES ────────────────────────────────────────────────────────────────
   Not every .js under functions/ is deployment surface. archive/ is retired by
   definition and scripts/ is operator tooling; counting their collection
   references into the deployable population would inflate it with code that
   never runs in production. They are parsed and reported, but SEPARATELY.
   test/ is excluded outright — a fixture naming a collection is not a
   reference to it. */
function zoneOf (rel) {
  if (rel === 'index.js') return 'entry';
  if (rel.indexOf('archive/') === 0) return 'archive';
  if (rel.indexOf('scripts/') === 0) return 'tooling';
  if (rel.indexOf('shared/') === 0) return 'shared';
  return 'core';
}
const DEPLOYABLE = { entry: 1, core: 1, shared: 1 };

function readModules () {
  const out = new Map();
  (function walk (dir, prefix) {
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      let st; try { st = fs.statSync(full); } catch (e) { continue; }
      if (st.isDirectory()) {
        if (f === 'node_modules' || f === 'test' || f.charAt(0) === '.') continue;
        walk(full, prefix + f + '/');
        continue;
      }
      if (!/\.js$/.test(f)) continue;
      let src; try { src = fs.readFileSync(full, 'utf8'); } catch (e) { continue; }
      out.set(prefix + f, src);
    }
  })(FDIR, '');
  return out;
}

const modules = readModules();

/* Comments are not code. A require inside a comment is not a dependency and a
   collection name in prose is not a reference. */
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const stripped = new Map();
modules.forEach((raw, k) => stripped.set(k, strip(raw)));

/* The stripper must not be a no-op, and must not blank the file. */
const stripControl = (function () {
  let shrank = 0, emptied = 0;
  modules.forEach(function (raw, k) {
    const s = stripped.get(k);
    if (s.length < raw.length) shrank++;
    if (raw.trim().length > 200 && s.trim().length === 0) emptied++;
  });
  return { modulesWithCommentsRemoved: shrank, modulesBlanked: emptied };
})();

const graph = { nodes: {}, edges: [] };
const node = (id, type, extra) => {
  if (!graph.nodes[id]) graph.nodes[id] = Object.assign({ id: id, type: type }, extra || {});
  return graph.nodes[id];
};
const addEdge = (from, to, kind, evidence, detail) =>
  graph.edges.push({ from: from, to: to, kind: kind, evidence: evidence, detail: detail || null });

modules.forEach((_, name) => node(name, 'module', { zone: zoneOf(name) }));

/* ── module -> module, OBSERVED_SOURCE ───────────────────────────────────
   Resolved relative to the REQUIRING module's directory. Resolving against
   functions/ instead makes every "./x" inside shared/ point at a top-level
   file that may not exist, producing dangling edges that read as missing
   modules. Unresolved targets are counted, never silently dropped. */
const dangling = [];
const dataRequires = [];
modules.forEach((_, name) => {
  const dir = path.posix.dirname(name);
  const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(stripped.get(name)))) {
    const spec = m[1];
    /* A require of a .json is a DATA dependency, not a missing module. Filing
       it under "unresolved" would invent a defect: all five in this repo are
       index manifests and package.json, every one of them present on disk. */
    if (/\.json$/.test(spec)) { dataRequires.push({ from: name, spec: spec }); continue; }
    const t = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, spec));
    const cand = /\.js$/.test(t) ? [t] : [t + '.js', t + '/index.js'];
    const hit = cand.filter((c) => modules.has(c))[0];
    if (!hit) { dangling.push({ from: name, spec: spec, resolvedTo: cand[0] }); continue; }
    addEdge(name, hit, 'requires', EV.OBSERVED);
  }
});

/* ── module -> secret, OBSERVED_SOURCE ───────────────────────────────────── */
modules.forEach((_, name) => {
  const re = /defineSecret\(\s*['"]([A-Z0-9_]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(stripped.get(name)))) {
    node('secret:' + m[1], 'secret');
    addEdge(name, 'secret:' + m[1], 'needs-secret', EV.OBSERVED);
  }
});

/* ── module -> collection LITERAL, SOURCE_REFERENCE ──────────────────────
   Plus the dynamic remainder, counted and never guessed. */
const dynamicByModule = {};
let dynamicTotal = 0, literalSites = 0;
modules.forEach((_, name) => {
  const src = stripped.get(name);
  const all = (src.match(/\.collection\(/g) || []).length;
  const seen = {};
  const re = /\.collection\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
  let m, lit = 0;
  while ((m = re.exec(src))) {
    lit++;
    if (seen[m[1]]) continue;
    seen[m[1]] = 1;
    node('collection:' + m[1], 'collection-literal');
    addEdge(name, 'collection:' + m[1], 'references-collection', EV.REFERENCE);
  }
  literalSites += lit;
  const dyn = all - lit;
  if (dyn > 0) { dynamicByModule[name] = dyn; dynamicTotal += dyn; }
});

/* ── trigger registration, OBSERVED_SOURCE ───────────────────────────────
   BOTH forms. The options-object form is not an edge case here: it is the form
   every redis-integrations trigger uses. */
const triggers = [];
function recordTrigger (mod, event, watchPath) {
  const root = (watchPath.split('/')[0] || '').replace(/[{}]/g, '');
  if (!root) return;
  triggers.push({ module: mod, event: event, path: watchPath, rootCollection: root });
  node('collection:' + root, 'collection-literal');
  addEdge('collection:' + root, mod, 'triggers', EV.OBSERVED, event + ' on ' + watchPath);
}
const dynamicTriggers = [];
modules.forEach((_, name) => {
  const src = stripped.get(name);
  let m;
  const direct = /on(DocumentCreated|DocumentUpdated|DocumentWritten|DocumentDeleted)\(\s*['"]([^'"]+)['"]/g;
  while ((m = direct.exec(src))) recordTrigger(name, 'on' + m[1], m[2]);
  const opts = /on(DocumentCreated|DocumentUpdated|DocumentWritten|DocumentDeleted)\(\s*\{[^}]*?document:\s*['"]([^'"]+)['"]/g;
  while ((m = opts.exec(src))) recordTrigger(name, 'on' + m[1], m[2]);

  /* ── The residue, counted rather than discarded ──────────────────────
     Every trigger site the two resolvers did NOT claim. Subtracting matched
     from total is what makes the gap visible at all: a resolver that simply
     ignores what it cannot parse reports a complete-looking list. */
  const every = /on(DocumentCreated|DocumentUpdated|DocumentWritten|DocumentDeleted)\s*\(/g;
  const resolvable = /^on(?:DocumentCreated|DocumentUpdated|DocumentWritten|DocumentDeleted)\(\s*(?:['"][^'"]+['"]|\{[^}]*?document:\s*['"][^'"]+['"])/;
  while ((m = every.exec(src))) {
    const tail = src.slice(m.index, m.index + 160);
    if (resolvable.test(tail)) continue;
    const expr = (/document:\s*([^,\n]+)/.exec(tail) || [])[1];
    dynamicTriggers.push({
      module: name, event: 'on' + m[1],
      pathExpression: expr ? expr.trim() : '(unparsed)',
      watchedCollection: null, evidence: EV.NONE,
    });
  }
});

/* ── write -> trigger, DERIVED ───────────────────────────────────────────
   Two observations joined: module M references collection C; trigger module T
   watches C. Therefore M MAY cause T to fire. Nothing is witnessed. Labelled
   DERIVED so it can never be read as an invocation. */
const listeners = new Map();
triggers.forEach((t) => {
  if (!listeners.has(t.rootCollection)) listeners.set(t.rootCollection, new Set());
  listeners.get(t.rootCollection).add(t.module);
});
graph.edges.filter((e) => e.kind === 'references-collection').slice().forEach((e) => {
  const col = e.to.slice('collection:'.length);
  const ls = listeners.get(col);
  if (!ls) return;
  ls.forEach((mod) => {
    if (mod === e.from) return;
    addEdge(e.from, mod, 'may-trigger', EV.DERIVED,
      e.from + ' references "' + col + '"; ' + mod + ' watches it');
  });
});

/* ── function -> function, OBSERVED_SOURCE but LIMITED ───────────────────── */
modules.forEach((_, name) => {
  const re = /httpsCallable\(\s*['"]([A-Za-z0-9_]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(stripped.get(name)))) {
    node('function:' + m[1], 'callable-name');
    addEdge(name, 'function:' + m[1], 'calls-callable', EV.OBSERVED);
  }
});

/* ── reachability from index.js, OBSERVED_SOURCE ─────────────────────────
   A module unreachable through requires is NOT thereby obsolete: it may be a
   dispatcher handler loaded dynamically, operator tooling, or deployed from
   another branch. UNKNOWN DOES NOT MEAN OBSOLETE. Reported as a question. */
const requireIndex = new Map();
graph.edges.forEach((e) => {
  if (e.kind !== 'requires') return;
  if (!requireIndex.has(e.from)) requireIndex.set(e.from, []);
  requireIndex.get(e.from).push(e.to);
});
const reach = new Set();
(function dfs (n) {
  if (!n || reach.has(n) || !modules.has(n)) return;
  reach.add(n);
  (requireIndex.get(n) || []).forEach(dfs);
})('index.js');

const zones = {};
modules.forEach((_, n) => {
  const z = zoneOf(n);
  if (!zones[z]) zones[z] = { modules: 0, reachable: 0 };
  zones[z].modules++;
  if (reach.has(n)) zones[z].reachable++;
});

/* ── Collection populations, by zone, unreconciled ───────────────────────── */
function distinctIn (pred) {
  const s = new Set();
  graph.edges.forEach((e) => {
    if (e.kind !== 'references-collection') return;
    if (!pred(zoneOf(e.from))) return;
    s.add(e.to);
  });
  return s.size;
}

const populations = {
  sourceDefinitions: {
    count: (function () {
      let n = 0;
      modules.forEach((_, k) => {
        const s = stripped.get(k);
        ['onCall(', 'onRequest(', 'onSchedule(', 'onDocumentCreated(', 'onDocumentUpdated(',
         'onDocumentWritten(', 'onDocumentDeleted(', 'onObjectFinalized(']
          .forEach((t) => { n += s.split(t).length - 1; });
      });
      return n;
    })(),
    evidence: EV.OBSERVED,
    note: 'Every trigger definition site in functions/ (test/ excluded). Includes helpers, ' +
          'dead code and definitions never exported. NOT a count of deployment units.',
  },
  literalExportsInIndex: {
    count: (fs.readFileSync(path.join(FDIR, 'index.js'), 'utf8')
      .match(/^exports\.[A-Za-z0-9_]+\s*=/gm) || []).length,
    evidence: EV.OBSERVED,
    note: 'Literal "exports.X =" only. EXCLUDES bulk Object.assign exports BY CONSTRUCTION; ' +
          'Phase 1 resolves those and reports the larger registry. This figure is a FLOOR ' +
          'and must not be quoted as the export count.',
  },
  deployedSnapshot: {
    count: (function () {
      try {
        return fs.readFileSync(path.join(ROOT, 'scripts/infra/deployed-functions.txt'), 'utf8')
          .split(/\r?\n/).filter((l) => l.trim()).length;
      } catch (e) { return null; }
    })(),
    evidence: EV.REFERENCE,
    note: 'Recorded 2026-09-19. Not live truth; re-capture before acting.',
  },
  observedAtRuntime: {
    count: null, evidence: EV.NONE,
    note: 'Requires the GCP evidence reader, which is implemented and NOT DEPLOYED.',
  },
};

const collections = {
  distinctLiterals: {
    all: distinctIn(() => true),
    deployableZonesOnly: distinctIn((z) => !!DEPLOYABLE[z]),
    evidence: EV.REFERENCE,
    note: 'Distinct .collection("literal") names. A LOWER BOUND — see unresolvedDynamic.',
  },
  unresolvedDynamic: {
    sites: dynamicTotal,
    totalSites: literalSites + dynamicTotal,
    evidence: EV.NONE,
    note: 'Call sites whose argument is a variable, constant or template literal. NOT resolved ' +
          'and NOT guessed. Their collections may or may not appear in the literal set, so the ' +
          'distinct-name figure cannot be treated as a total.',
  },
  deployedRootCollections: {
    count: null, evidence: EV.NONE,
    note: 'Needs documents:listCollectionIds via the GCP reader. A figure of 217 has been cited ' +
          'elsewhere; this script did not measure it and does not adopt it.',
  },
  relation: 'UNRESOLVED — the difference may be subcollections, the ' + dynamicTotal +
            ' dynamic paths, stale references, collections outside the measured population, ' +
            'or archived code. This script does not guess which.',
};

const report = {
  generatedAt: new Date().toISOString(),
  readOnly: true,
  parserIntegrity: {
    commentStripper: stripControl,
    danglingRequires: dangling.length,
    danglingSample: dangling.slice(0, 8),
    dataRequires: dataRequires.length,
    triggerFormsParsed: ['onDocumentX(string)', 'onDocumentX({ document: string })'],
    triggersResolved: triggers.length,
    triggersDynamicUnresolved: dynamicTriggers.length,
    triggerSitesTotal: triggers.length + dynamicTriggers.length,
  },
  negativeClaimProhibition:
    'An absent edge means NOT OBSERVED, never NOT PRESENT. ' + dynamicTriggers.length +
    ' trigger sites watch a template-literal path that cannot be resolved from source, ' +
    'so a collection may have listeners this graph cannot see. Do not conclude that ' +
    'nothing watches a collection, that nothing depends on a module, or that anything ' +
    'is unused. Every population here is a FLOOR.',
  dynamicTriggers: dynamicTriggers,
  zones: zones,
  populations: populations,
  collections: collections,
  triggers: triggers,
  dynamicCollectionSitesByModule: dynamicByModule,
};

/* ── Query modes ─────────────────────────────────────────────────────────── */
if (ONE_MOD) {
  const out = graph.edges.filter((e) => e.from === ONE_MOD || e.to === ONE_MOD);
  console.log('EDGES TOUCHING ' + ONE_MOD + '  (' + out.length + ')  zone=' + zoneOf(ONE_MOD) +
              '  reachableFromIndex=' + (reach.has(ONE_MOD) ? 'yes' : 'NO'));
  out.forEach((e) => console.log('  [' + e.evidence + '] ' + e.from +
    ' --' + e.kind + '--> ' + e.to + (e.detail ? '  // ' + e.detail : '')));
  process.exit(0);
}
if (ONE_COL) {
  const id = 'collection:' + ONE_COL;
  console.log('COLLECTION LITERAL "' + ONE_COL + '" — SOURCE_REFERENCE only.');
  console.log('Existence in production is NOT ESTABLISHED by this script.');
  console.log('');
  const refs = graph.edges.filter((e) => e.to === id && e.kind === 'references-collection');
  const trg  = graph.edges.filter((e) => e.from === id && e.kind === 'triggers');
  console.log('  referenced by ' + refs.length + ' module(s):');
  refs.forEach((e) => console.log('    ' + e.from + '  [' + zoneOf(e.from) + ']'));
  console.log('  watched by ' + trg.length + ' trigger registration(s):');
  trg.forEach((e) => console.log('    ' + e.to + '   // ' + e.detail));
  process.exit(0);
}
if (AS_JSON) {
  process.stdout.write(JSON.stringify(
    Object.assign({}, report, { graph: graph }), null, 2) + '\n');
  process.exit(0);
}

const byEv = {}, byKind = {};
graph.edges.forEach((e) => {
  byEv[e.evidence] = (byEv[e.evidence] || 0) + 1;
  byKind[e.kind] = (byKind[e.kind] || 0) + 1;
});
const P = (n, w) => String(n === null ? '—' : n).padStart(w || 6);

console.log('══════════════════════════════════════════════════════════════════');
console.log('  FUNCTION DEPENDENCY GRAPH — PHASE 2 (read-only)');
console.log('══════════════════════════════════════════════════════════════════');
console.log('  modules parsed : ' + modules.size + '   (functions/test excluded)');
console.log('  nodes          : ' + Object.keys(graph.nodes).length);
console.log('  edges          : ' + graph.edges.length);
console.log('');
console.log('  ── PARSER INTEGRITY ────────────────────────────────────────────');
console.log('  comment stripper changed        : ' + stripControl.modulesWithCommentsRemoved +
            ' modules  (0 would mean it is a no-op)');
console.log('  modules blanked by the stripper : ' + stripControl.modulesBlanked +
            '  (must be 0)');
console.log('  trigger sites, path RESOLVED    : ' + triggers.length +
            '   string and options-object forms');
console.log('  trigger sites, path DYNAMIC     : ' + dynamicTriggers.length +
            '   template literal, NOT resolved');
console.log('  trigger sites, total            : ' +
            (triggers.length + dynamicTriggers.length));
console.log('  .json data requires             : ' + dataRequires.length +
            '   data, not missing modules');
console.log('  genuinely unresolved requires   : ' + dangling.length);
console.log('');
console.log('  ── EDGES BY EVIDENCE TYPE ──────────────────────────────────────');
[EV.OBSERVED, EV.REFERENCE, EV.DERIVED].forEach((k) =>
  console.log('  ' + P(byEv[k] || 0) + '  ' + k));
console.log('');
console.log('  ── EDGES BY KIND ───────────────────────────────────────────────');
Object.keys(byKind).sort((a, b) => byKind[b] - byKind[a]).forEach((k) =>
  console.log('  ' + P(byKind[k]) + '  ' + k));
console.log('');
console.log('  ── ZONES  (archive/ and tooling/ are NOT deployment surface) ───');
Object.keys(zones).sort().forEach((z) =>
  console.log('  ' + P(zones[z].modules) + '  ' + z + '  ->  ' +
    zones[z].reachable + ' reachable from index.js'));
console.log('');
console.log('  A module unreachable through requires is NOT obsolete. It may be a');
console.log('  dispatcher handler, operator tooling, or deployed from another');
console.log('  branch. UNKNOWN DOES NOT MEAN OBSOLETE.');
console.log('');
console.log('  ── POPULATIONS, NOT EQUATED ────────────────────────────────────');
Object.keys(populations).forEach((k) =>
  console.log('  ' + P(populations[k].count) + '  ' + k + '  ' + populations[k].evidence));
console.log('');
console.log('  Different numbers, deliberately. literalExportsInIndex is a FLOOR:');
console.log('  it cannot see bulk Object.assign exports, which Phase 1 resolves.');
console.log('  Reconciling these is Phases 3-5.');
console.log('');
console.log('  ── COLLECTIONS: INDEPENDENT POPULATIONS ────────────────────────');
console.log('  ' + P(collections.distinctLiterals.all) +
            '  distinct literals, all zones     ' + EV.REFERENCE);
console.log('  ' + P(collections.distinctLiterals.deployableZonesOnly) +
            '  distinct literals, deployable    ' + EV.REFERENCE);
console.log('  ' + P(collections.unresolvedDynamic.sites) +
            '  UNRESOLVED dynamic call sites    ' + EV.NONE +
            '  of ' + collections.unresolvedDynamic.totalSites + ' total');
console.log('  ' + P(null) + '  deployed root collections        ' + EV.NONE);
console.log('');
console.log('  The distinct-literal figure is a LOWER BOUND, not a total: ' +
            collections.unresolvedDynamic.sites + ' sites');
console.log('  take a variable or template literal and are not guessed at.');
console.log('');
console.log('  ' + collections.relation);
console.log('');
console.log('  ── THE GRAPH CANNOT SUPPORT A NEGATIVE CLAIM ───────────────────');
console.log('  ' + dynamicTriggers.length + ' trigger sites watch a template-literal path ' +
            'built at module');
console.log('  load, in the fan-out factories. Their collections are UNKNOWN, so a');
console.log('  collection may have listeners this graph cannot see.');
console.log('');
console.log('  An absent edge means NOT OBSERVED, never NOT PRESENT. Do not');
console.log('  conclude that nothing watches a collection, that nothing depends on');
console.log('  a module, or that anything is unused. Every figure above is a FLOOR,');
console.log('  and NOTHING may be retired on the strength of an absence.');
console.log('');
console.log('  ── WHAT IS NOT ESTABLISHED ─────────────────────────────────────');
console.log('  runtime invocation · whether any trigger actually fires · whether');
console.log('  a referenced collection exists · which function called which.');
console.log('  A may-trigger edge is DERIVED — two observations joined, nothing');
console.log('  witnessed. It must never be read as an invocation.');
console.log('══════════════════════════════════════════════════════════════════');
