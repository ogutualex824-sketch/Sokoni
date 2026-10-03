/* ══════════════════════════════════════════════════════════════════════════════
   FUNCTIONS IMPLEMENTATION CONTAINMENT — what production RUNS, not what it NAMES
   scripts/deploy/functions-surface.js                            B9.31 Step 21C-L3
   ══════════════════════════════════════════════════════════════════════════════
   WHY THIS EXISTS

   Step 19's Functions clause asks one question:

       are production's live export NAMES contained in the candidate?

   Step 21C-L proved that question passes while production regresses. 1709 live names
   were contained in 1747 candidate names — and the candidate still lacked
   `rider-eligibility.js` and `vehicle-classes.js` entirely, so deploying it would have
   re-opened DL-01's server half. Step 21C-L2 then found two more live regressions the
   same way: Gate C's `assertNoCheckoutPricing` / `resolveQuoteForCheckout` on the live
   checkout money path, and RES-1's carried quote in `webhookIntasend`.

   The name test was never wrong. It was answering a narrower question than "is it safe
   to deploy". This module asks the wider one:

       every LIVE production implementation the release replaces is
       content-equivalent, an explicitly certified successor, or an
       authorized retirement — and every module it REQUIRES is present.

   THREE THINGS THIS ENCODES THAT A NAME TEST CANNOT

   1. A module need not be EXPORTED to be release-critical. `rider-eligibility.js`
      binds no export at all; it is required by `dispatch.js`. Step 21C-L2's first
      matrix scored it "0 live exports" and classified it out-of-scope — the exact
      inversion of the truth. Dependency containment is therefore its own clause, over
      the TRANSITIVE require closure.

   2. Some files cannot be owned by either side. `dispatch.js` and `index.js` moved on
      BOTH lineages, so neither "take production" nor "take candidate" is correct; they
      need three-way reconciliation and the guard must refuse until that is recorded.

   3. Direction is not safety. Step 21C-L2 classified 88 files as candidate-supersedes
      by proving production's copy is byte-identical to the merge-base. That is a sound
      DIRECTION proof, and it still does not prove the candidate's version kept the
      embedded money and security controls. So the money-path clause is checked
      independently of classification.

   THE PRODUCTION BASELINE IS THE DEPLOYED ARCHIVE

   Not commit ancestry — this chain has established repeatedly that ancestry answers a
   different question. Every GEN_2 function carries its own source zip in GCS; that is
   what production actually runs, and it is downloadable per function.

   FAIL CLOSED everywhere. A guard that cannot see production must never conclude
   production is fine.

   The evaluators are PURE — evidence in, verdict out, no I/O.
   ══════════════════════════════════════════════════════════════════════════════ */
'use strict';

const ALLOW = (reason, detail, extra) => Object.assign({ allow: true, reason, detail }, extra || {});
const REFUSE = (reason, detail, extra) => Object.assign({ allow: false, reason, detail }, extra || {});

const FN_REASON = {
  OK: 'ok',
  IMPLEMENTATION_DRIFT: 'unapproved_implementation_drift',
  DEPENDENCY_ABSENT: 'live_dependency_absent',
  MONEY_CONTROL_LOST: 'money_path_control_lost',
  UNRECONCILED: 'three_way_file_unreconciled',
  NO_EVIDENCE: 'no_evidence',
};

const SQ = String.fromCharCode(39);
const DQ = String.fromCharCode(34);
const BT = String.fromCharCode(96);

/* ── REGEX LITERALS, AND WHY BOTH STRIPPERS MUST KNOW ABOUT THEM ─────────────
   A pattern like /['"]/ contains quote characters. A stripper that only knows about
   comments and strings sees that apostrophe, enters string mode, and swallows live code
   until the next matching quote — silently, with the line count intact because newlines
   inside a string are preserved.

   That is not hypothetical. It reported ZERO FieldValue.increment calls on a file
   containing twenty-seven, and an under-count reads exactly like a clean result. Five of
   the twenty-nine production-live Functions were unreadable for this reason.

   Telling a regex from a division is decided by what precedes the slash: after a value
   (identifier, number, closing bracket) a `/` divides; after an operator, a comma, an
   opening bracket or a keyword, it starts a pattern. `lastSignificant` tracks that, and
   `skipRegex` consumes the literal including its character classes, where an unescaped
   `/` is NOT the terminator. */
const REGEX_CANNOT_FOLLOW = /[A-Za-z0-9_$)\]]$/;
const KEYWORD_BEFORE_REGEX = /\b(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/;

function regexAllowedAfter(prefix) {
  const t = prefix.replace(/\s+$/, '');
  if (t === '') return true;
  if (KEYWORD_BEFORE_REGEX.test(t)) return true;
  return !REGEX_CANNOT_FOLLOW.test(t);
}

/* index just past a regex literal beginning at i (src[i] === '/') */
function skipRegex(src, i) {
  const n = src.length;
  let k = i + 1;
  let inClass = false;
  while (k < n) {
    const c = src[k];
    if (c === '\\') { k += 2; continue; }
    if (c === '\n') return k;                 /* unterminated — not a regex after all */
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { k++; break; }
    k++;
  }
  while (k < n && /[a-z]/.test(src[k])) k++;  /* flags */
  return k;
}

/* ── comment stripping, quote-aware ──────────────────────────────────────────
   The certification machinery reads its own prose otherwise: a control named in a
   comment would satisfy a check for that control. Template literals count as strings
   here too, since a require() inside one is not a real require. */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; out += ' '; continue;
    }
    /* a regex literal is neither comment nor string; its quotes must not open one */
    if (c === '/' && regexAllowedAfter(out)) {
      const end = skipRegex(src, i);
      out += src.slice(i, end).replace(/[^\n]/g, ' ');
      i = end;
      continue;
    }
    if (c === SQ || c === DQ || c === BT) {
      const q = c;
      out += ' ';
      i++;
      while (i < n && src[i] !== q) {
        /* An ESCAPE SKIPS TWO CHARACTERS, AND EITHER OF THEM MAY BE A NEWLINE.
           Skipping both without emitting it drops a line from the output, and every line
           after that point is misaligned by one — so a census that indexes by line number
           reads the wrong line, and a brace balance goes wrong at the first escaped
           newline in any string. That is what made two files look like they had swallowed
           code when the real fault was here. */
        if (src[i] === '\\') {
          if (src[i] === '\n') out += '\n';
          if (src[i + 1] === '\n') out += '\n';
          i += 2;
          continue;
        }
        if (src[i] === '\n') out += '\n';
        i++;
      }
      if (i < n) i++;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/* ── comment stripping that KEEPS string contents ────────────────────────────
   Two jobs need two strippers, and conflating them is a real defect rather than a
   tidiness point.

   `stripComments` above BLANKS string contents, which is what a symbol check needs:
   a control named inside a string or a comment must not satisfy a check for that
   control. But a require SPECIFIER *is* a string, so running the blanking stripper
   before require extraction destroys the very thing being extracted —
   `require('./rider-eligibility')` becomes `require( )`, every require reads as
   COMPUTED, and the live closure comes back empty of exactly the modules it exists
   to protect. That happened while building this file's own manifest: 0 literal
   requires and 10 "computed" ones on dispatch.js.

   So: comments go, string contents stay. */
function stripCommentsKeepStrings(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) { if (src[i] === '\n') out += '\n'; i++; }
      i += 2; out += ' '; continue;
    }
    /* same regex handling — kept VERBATIM rather than shared, because the two strippers
       must stay independently readable; a divergence here is a silent classification bug */
    if (c === '/' && regexAllowedAfter(out)) {
      const end = skipRegex(src, i);
      out += src.slice(i, end);
      i = end;
      continue;
    }
    if (c === SQ || c === DQ || c === BT) {
      const q = c;
      out += c; i++;
      while (i < n && src[i] !== q) {
        if (src[i] === '\\' && i + 1 < n) { out += src[i] + src[i + 1]; i += 2; continue; }
        out += src[i]; i++;
      }
      if (i < n) { out += q; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/* ── require extraction ───────────────────────────────────────────────────────
   Finds requires ANYWHERE — top level, inside a function body, inside a branch. A
   dependency moved into a nested require is still a dependency; that is exactly how
   one would hide from a header scan.

   A COMPUTED require is reported as indeterminate rather than ignored. We cannot
   resolve it statically, and silently skipping it would let a real dependency vanish
   from the closure — the failure mode this whole gate exists to prevent. */
function extractRequires(src) {
  const s = stripCommentsKeepStrings(src);
  const literal = [];
  const re = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(s)) !== null) literal.push(m[1]);
  /* a require( whose argument is not a plain string literal */
  let indeterminate = 0;
  const any = /require\s*\(/g;
  let a;
  while ((a = any.exec(s)) !== null) {
    const tail = s.slice(a.index, a.index + 400);
    if (!/^require\s*\(\s*["'][^"']+["']\s*\)/.test(tail)) indeterminate++;
  }
  return { literal, indeterminate };
}

/* ── IS THE STRIPPED OUTPUT TRUSTWORTHY AT ALL? ──────────────────────────────
   stripComments is not a JavaScript lexer. It does not understand regex literals, so a
   pattern like /['"]/ puts it into string mode and it swallows live code until the next
   matching quote — silently, and with the line count intact, because newlines inside a
   string are preserved. A census built on that output UNDER-COUNTS, and an under-count
   reads exactly like a clean result.

   This was not hypothetical: on one file the blanking stripper reported ZERO
   FieldValue.increment calls where the string-preserving one reported twenty-seven.

   Brace BALANCE is the detector that cannot be fooled. Removing comments cannot change it,
   and blanking a string's CONTENT cannot either, because a brace inside a string is not
   structural. So if the blanked output is unbalanced while the source is not, the stripper
   ate code — and the caller must be told instead of handed plausible garbage.

   Callers that certify anything should refuse on a false verdict rather than proceed. */
function stripIntegrity(src) {
  const bal = (s) => (s.match(/\{/g) || []).length - (s.match(/\}/g) || []).length;
  const blanked = bal(stripComments(src));
  const kept = bal(stripCommentsKeepStrings(src));
  const lines = (s) => s.split('\n').length;

  /* THE SIGNAL IS THE BLANKED BALANCE, NOT THE COMPARISON.
     My first version compared blanked against kept and was wrong in both directions: a
     template literal holding CSS or HTML puts unbalanced braces into the KEPT output where
     they are not structural at all, so the comparison flagged healthy files; and it would
     have agreed on two files that were both wrong.

     Valid JavaScript with comments and string CONTENTS removed must have balanced braces.
     If the blanked output does not, the stripper mis-parsed something — a nested template
     literal, or an escape it mishandled — and every count taken from it is suspect.

     Line drift is the second signal: comment removal and content blanking both preserve
     newlines, so a change in line count means a line was swallowed and any line-indexed
     read is reading the wrong line. */
  const balanced = blanked === 0;
  const aligned = lines(stripComments(src)) === lines(src);
  const ok = balanced && aligned;
  return {
    ok, blanked, kept, aligned,
    reason: ok ? null
      : (!balanced
        ? 'the blanked output has brace balance ' + blanked + ', but valid JavaScript with ' +
          'comments and string contents removed must balance to 0 — the stripper mis-parsed ' +
          'something (a nested template literal, or a regex it did not recognise). Every ' +
          'count from that output is suspect, and an under-count reads exactly like a clean ' +
          'result.'
        : 'the blanked output lost ' + (lines(src) - lines(stripComments(src))) + ' line(s); ' +
          'any line-indexed read is now off by that much.'),
  };
}

const norm = (p) => String(p).replace(/\\/g, '/').replace(/^\.\//, '');

/* resolve a relative specifier against a file list */
function resolveDep(fromRel, spec, fileSet) {
  if (!/^\.\.?\//.test(spec)) return null;           /* a package, not a local module */
  const parts = norm(fromRel).split('/');
  parts.pop();
  for (const seg of norm(spec).split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  const base = parts.join('/');
  for (const c of [base, base + '.js', base + '/index.js']) if (fileSet.has(c)) return c;
  return null;
}

/* ── transitive closure over the require graph ────────────────────────────────
   `seeds` are the modules that back a live export. index.js is deliberately NOT a
   seed: it requires every module whether its handler is deployed or not, so seeding
   it marks the entire tree live and the undeployed leaves disappear. That mistake
   produced a matrix with zero out-of-scope files in Step 21C-L2. */
function liveClosure(o) {
  const opts = o || {};
  const files = opts.files || [];
  const read = opts.read;
  const seeds = opts.seeds || [];
  const extra = opts.extraEdges || {};
  if (!files.length || typeof read !== 'function') {
    return { ok: false, error: 'no archive files or no reader' };
  }
  const fileSet = new Set(files);
  const reachable = new Set();
  const unresolved = [];
  let computed = 0;
  const stack = seeds.slice();
  while (stack.length) {
    const cur = stack.pop();
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    const src = read(cur);
    if (src === null || src === undefined) { unresolved.push(cur); continue; }
    const { literal, indeterminate } = extractRequires(src);
    computed += indeterminate;
    for (const spec of literal) {
      const dep = resolveDep(cur, spec, fileSet);
      if (dep && !reachable.has(dep)) stack.push(dep);
    }
    for (const dep of (extra[cur] || [])) if (fileSet.has(dep) && !reachable.has(dep)) stack.push(dep);
  }
  return { ok: true, reachable, unresolved, computedRequires: computed };
}

/* ── CLAUSE 1 — live implementation containment ──────────────────────────────── */
function evaluateImplementationContainment(o) {
  const opts = o || {};
  const archive = opts.archive;          /* { file -> hash } as DEPLOYED */
  const candidate = opts.candidate;      /* { file -> hash } in the release */
  const live = opts.liveFiles;           /* [file] reachable from a live export */
  if (!archive || !candidate || !Array.isArray(live)) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'archive, candidate or live-file set unavailable');
  }
  if (!Object.keys(archive).length) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'the production archive is EMPTY — treated as unavailable, never as "nothing to protect"');
  }
  if (!live.length) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'ZERO live files resolved — a closure failure, not a clean release');
  }
  const successors = opts.certifiedSuccessors || {};
  const retired = new Set(opts.authorizedRetirements || []);
  /* A THREE-WAY-RECONCILED file is its own disposition, not a successor. Forcing it into
     certifiedSuccessors as well would give it TWO dispositions, and "exactly one
     disposition per live implementation" is the property that makes this manifest
     readable as a decision record rather than a pile of overlapping claims. */
  const reconciled = new Map();
  for (const r of (opts.threeWayReconciled || [])) {
    if (r && r.file) reconciled.set(r.file, r);
  }

  const drifted = [], unproven = [];
  for (const f of live) {
    if (retired.has(f)) continue;
    const a = archive[f];
    const c = candidate[f];
    if (a === undefined) continue;
    if (c !== undefined && a === c) continue;        /* content-equivalent */
    const rec = reconciled.get(f);
    if (rec && rec.reconciled === true && rec.evidence) continue;
    if (rec && rec.reconciled === true && !rec.evidence) { unproven.push(f); continue; }
    const s = successors[f];
    if (s && s.certified === true && s.evidence) continue;
    if (s && s.certified === true && !s.evidence) { unproven.push(f); continue; }
    drifted.push(f + (c === undefined ? ' (ABSENT from candidate)' : ''));
  }
  if (unproven.length) {
    return REFUSE(FN_REASON.IMPLEMENTATION_DRIFT,
      unproven.length + ' successor(s) DECLARED but carry no evidence: ' + unproven.slice(0, 6).join(', ') +
      '. A declaration is not a certification.');
  }
  if (drifted.length) {
    return REFUSE(FN_REASON.IMPLEMENTATION_DRIFT,
      drifted.length + ' live production implementation(s) replaced with neither equivalence nor a ' +
      'certified successor: ' + drifted.slice(0, 8).join(', '));
  }
  return ALLOW(FN_REASON.OK, live.length + ' live implementation(s) equivalent or certified');
}

/* ── CLAUSE 2 — live dependency containment ──────────────────────────────────
   A module does not have to be exported to be release-critical. */
function evaluateDependencyContainment(o) {
  const opts = o || {};
  const closure = opts.closure;
  const candidateFiles = opts.candidateFiles;
  if (!closure || closure.ok !== true) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'the live require closure could not be computed' +
      (closure && closure.error ? ': ' + closure.error : ''));
  }
  if (!Array.isArray(candidateFiles)) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'candidate file list unavailable');
  }
  if (closure.unresolved && closure.unresolved.length) {
    return REFUSE(FN_REASON.NO_EVIDENCE,
      closure.unresolved.length + ' module(s) in the closure could not be READ: ' +
      closure.unresolved.slice(0, 5).join(', '));
  }
  if (closure.computedRequires) {
    return REFUSE(FN_REASON.NO_EVIDENCE,
      closure.computedRequires + ' COMPUTED require(s) in the live closure — a dependency that ' +
      'cannot be resolved statically cannot be proved present. Refusing rather than skipping it.');
  }
  const have = new Set(candidateFiles);
  const replacements = opts.certifiedReplacements || {};
  const missing = [];
  for (const dep of closure.reachable) {
    if (have.has(dep)) continue;
    const r = replacements[dep];
    if (r && r.certified === true && r.evidence) continue;
    missing.push(dep);
  }
  if (missing.length) {
    return REFUSE(FN_REASON.DEPENDENCY_ABSENT,
      missing.length + ' module(s) required by a LIVE function are absent from the candidate with no ' +
      'certified replacement: ' + missing.slice(0, 8).join(', '));
  }
  return ALLOW(FN_REASON.OK, closure.reachable.size + ' live-reachable module(s) present');
}

/* ── CLAUSE 3 — money-path controls ──────────────────────────────────────────
   Checked INDEPENDENTLY of classification. A file can be correctly classified as
   candidate-supersedes on direction and still have dropped an embedded control. */
function evaluateMoneyPathControls(o) {
  const opts = o || {};
  const controls = opts.controls;
  const read = opts.readCandidate;
  if (!Array.isArray(controls) || !controls.length) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'no money-path controls were supplied to check');
  }
  if (typeof read !== 'function') {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'no candidate reader supplied');
  }
  const lost = [], indeterminate = [];
  for (const ctl of controls) {
    if (!ctl || !ctl.id || !ctl.symbol || !ctl.callSiteFile) { indeterminate.push(String(ctl && ctl.id)); continue; }
    if (ctl.successor && ctl.successor.certified === true && ctl.successor.evidence) continue;
    const src = read(ctl.callSiteFile);
    if (src === null || src === undefined) { indeterminate.push(ctl.id + ' (call site unreadable)'); continue; }
    const stripped = stripComments(src);
    /* a bare mention is not a call — require the symbol followed by ( or = */
    const re = new RegExp('\\b' + ctl.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*[(=]');
    if (!re.test(stripped)) lost.push(ctl.id + ' [' + ctl.symbol + ' in ' + ctl.callSiteFile + ']');
  }
  if (indeterminate.length) {
    return REFUSE(FN_REASON.NO_EVIDENCE,
      indeterminate.length + ' control(s) could not be evaluated: ' + indeterminate.slice(0, 5).join(', '));
  }
  if (lost.length) {
    return REFUSE(FN_REASON.MONEY_CONTROL_LOST,
      lost.length + ' live money-path control(s) absent from the candidate with no certified successor: ' +
      lost.join(' | '));
  }
  return ALLOW(FN_REASON.OK, controls.length + ' money-path control(s) present or certified');
}

/* ── CLAUSE 4 — three-way files ──────────────────────────────────────────────
   Files that moved on BOTH lineages. Neither side owns them; the guard refuses until
   a reconciliation is recorded with evidence. */
function evaluateThreeWayReconciliation(o) {
  const opts = o || {};
  const files = opts.threeWay;
  if (!Array.isArray(files)) {
    return REFUSE(FN_REASON.NO_EVIDENCE, 'no three-way file record supplied');
  }
  if (!files.length) return ALLOW(FN_REASON.OK, 'no three-way files declared');
  const open = files.filter((f) => !(f && f.reconciled === true && f.evidence));
  if (open.length) {
    /* Two different obligations share this clause and must not be described as one:
       a file that moved on BOTH lineages needs a merge, while a MUST-FOLLOW file is
       simply absent from the candidate. Reporting the second as the first would
       misstate the finding. */
    const both = open.filter((f) => f.kind !== 'must-follow');
    const absent = open.filter((f) => f.kind === 'must-follow');
    const parts = [];
    if (both.length) {
      parts.push(both.length + ' file(s) moved on BOTH lineages and need a three-way merge (' +
        both.map((f) => f.file || '?').join(', ') +
        ') — neither "take production" nor "take candidate" is correct');
    }
    if (absent.length) {
      parts.push(absent.length + ' MUST-FOLLOW file(s) are unresolved (' +
        absent.map((f) => f.file || '?').join(', ') +
        ') — production runs them and the candidate does not');
    }
    return REFUSE(FN_REASON.UNRECONCILED, parts.join(' | '));
  }
  return ALLOW(FN_REASON.OK, files.length + ' three-way file(s) reconciled with evidence');
}

/* ── CLAUSE 5 — the production baseline itself ───────────────────────────────── */
function evaluateArchiveEvidence(o) {
  const opts = o || {};
  const a = opts.archiveMeta;
  if (!a) return REFUSE(FN_REASON.NO_EVIDENCE, 'no production archive metadata — the baseline is unknown');
  if (a.available !== true) {
    return REFUSE(FN_REASON.NO_EVIDENCE,
      'the production source archive is UNAVAILABLE' + (a.error ? ': ' + a.error : '') +
      '. Refusing rather than assuming production matches the candidate.');
  }
  if (!a.fileCount) return REFUSE(FN_REASON.NO_EVIDENCE, 'the archive resolved to ZERO files');
  if (a.pinnedGeneration && a.observedGeneration && a.pinnedGeneration !== a.observedGeneration) {
    return REFUSE(FN_REASON.NO_EVIDENCE,
      'production has been REDEPLOYED since this baseline was pinned (generation ' +
      a.pinnedGeneration + ' -> ' + a.observedGeneration + '). Re-adjudicate; do not re-pin to pass.');
  }
  return ALLOW(FN_REASON.OK,
    'baseline: ' + a.fileCount + ' files from ' + (a.provenance || 'the deployed archive'));
}

function combineFunctions(verdicts) {
  const names = Object.keys(verdicts || {});
  if (!names.length) return { allow: false, blocking: [], detail: 'nothing was evaluated — refusing rather than assuming' };
  const blocking = names.filter((n) => !verdicts[n].allow);
  return {
    allow: blocking.length === 0,
    blocking,
    detail: names.map((n) => n + ': ' + verdicts[n].reason).join(' | '),
  };
}

module.exports = {
  FN_REASON,
  stripComments,
  stripCommentsKeepStrings,
  stripIntegrity,
  extractRequires,
  resolveDep,
  liveClosure,
  evaluateImplementationContainment,
  evaluateDependencyContainment,
  evaluateMoneyPathControls,
  evaluateThreeWayReconciliation,
  evaluateArchiveEvidence,
  combineFunctions,
};
