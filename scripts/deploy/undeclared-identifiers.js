'use strict';
/* ══════════════════════════════════════════════════════════════════════════════
   USED BUT NEVER DECLARED — the clean-merge defect that node --check cannot see
   scripts/deploy/undeclared-identifiers.js                      B9.31 Step 21F-2b.1f
   ══════════════════════════════════════════════════════════════════════════════
   `git merge-file` has already put an undeclared `taxConfig` into etims.js through a
   hunk it merged CLEANLY, and pos-zero-friction's CH3 would do the same with
   `resolvedShiftId`, whose declaration lives only in the half of C12 that was refused.
   Both parse. Both pass `node --check`. Both throw at the counter.

   WHY THIS IS NOT A REGEX. The first version of this check was one, and it reported
   two hundred "undeclared" names — `regio`, `statu`, `enforceAppChec` — because a
   negative lookahead for `:` matched every object-literal key one character short.
   A detector that produces confident nonsense is worse than no detector: the real
   finding sits in the noise. Property keys, member accesses and shorthand are
   syntactic categories, so they are read from the syntax tree, not guessed at.

   FLAT, DELIBERATELY. This asks "is this name declared ANYWHERE in the file", not
   "is it in scope here". A name declared in the wrong scope is a different defect and
   a flat set cannot produce a false alarm for it — which is the direction that matters
   for a tool whose failures stop a release.

   FAILS CLOSED. Without a parser it returns ok:false with a reason, and never an
   empty finding list that a caller would read as a clean file.
   ══════════════════════════════════════════════════════════════════════════════ */

const path = require('path');

/* The parser ships with the Functions runtime rather than the repo root, so it is
   resolved explicitly and its absence is REPORTED, never silently tolerated. */
function loadParser() {
  const candidates = [
    path.join(__dirname, '..', '..', 'functions', 'node_modules', '@babel', 'parser'),
    '@babel/parser',
  ];
  for (const c of candidates) {
    try { return { parser: require(c), from: c }; } catch (_) { /* try the next */ }
  }
  return null;
}

/* Names the file may use without declaring them. Anything not here and not declared
   is reported — including a genuine global this list has missed, which is the safe
   direction: a false alarm is investigated, a false pass ships. */
const AMBIENT = new Set([
  'require', 'module', 'exports', '__dirname', '__filename', 'global', 'globalThis',
  'process', 'console', 'Buffer', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'queueMicrotask',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'EvalError', 'ReferenceError',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Intl',
  'ArrayBuffer', 'DataView', 'Uint8Array', 'Int8Array', 'Uint16Array', 'Int16Array',
  'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent', 'decodeURIComponent',
  'encodeURI', 'decodeURI', 'structuredClone', 'fetch', 'AbortController', 'undefined',
  'NaN', 'Infinity', 'arguments', 'AggregateError', 'FinalizationRegistry', 'WeakRef',
  /* Node 18+ globals. Omitting these produced eight false findings on the first
     tree-wide run and nearly buried the one real one. */
  'AbortSignal', 'Blob', 'File', 'FormData', 'Headers', 'Request', 'Response',
  'crypto', 'performance', 'Event', 'EventTarget', 'MessageChannel', 'MessagePort',
  'BroadcastChannel', 'ReadableStream', 'WritableStream', 'TransformStream',
  'atob', 'btoa', 'CustomEvent', 'DOMException', 'Iterator',
]);

/* Browser globals a module shared between the browser and the Functions runtime may
   name. They are NOT ambient in Node, so a bare use IS a defect — but a use guarded by
   `typeof window !== 'undefined'` is the correct idiom and throws nothing. The rule is
   therefore about the SYNTAX of the use, not a name allowlist: an identifier whose every
   occurrence is the operand of `typeof` cannot throw, whatever it is called. */

function collectPatternNames(node, out) {
  if (!node || typeof node !== 'object') return;
  switch (node.type) {
    case 'Identifier': out.add(node.name); return;
    case 'ObjectPattern':
      for (const p of node.properties) {
        if (p.type === 'RestElement') collectPatternNames(p.argument, out);
        else collectPatternNames(p.value, out);
      }
      return;
    case 'ArrayPattern':
      for (const el of node.elements) if (el) collectPatternNames(el, out);
      return;
    case 'AssignmentPattern': collectPatternNames(node.left, out); return;
    case 'RestElement': collectPatternNames(node.argument, out); return;
    default: return;
  }
}

/* One recursive walk. `parentKey` tells an Identifier which syntactic slot it sits in,
   which is the whole reason this is an AST walk and not a text scan. */
function walk(node, visit, parent, key) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const n of node) walk(n, visit, parent, key); return; }
  if (typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    if (k === 'loc' || k === 'range' || k === 'leadingComments' || k === 'trailingComments') continue;
    const v = node[k];
    if (v && typeof v === 'object') walk(v, visit, node, k);
  }
}

/* Returns { ok, reason, undeclared: [{ name, line }], declaredCount, usedCount }. */
function findUndeclared(src, opts) {
  const extraAmbient = (opts && opts.ambient) || [];
  const loaded = loadParser();
  if (!loaded) {
    return { ok: false, reason: 'no JavaScript parser available (@babel/parser not resolvable) — ' +
      'refusing to report a clean result from a check that did not run', undeclared: [] };
  }
  let ast;
  try {
    ast = loaded.parser.parse(src, { sourceType: 'script', errorRecovery: false, ranges: false });
  } catch (e) {
    return { ok: false, reason: 'parse failed: ' + (e && e.message), undeclared: [] };
  }

  const declared = new Set(extraAmbient);
  const used = new Map();       /* name -> first line seen */
  const typeofOnly = new Map(); /* name -> true while every use so far is `typeof name` */

  walk(ast.program, (node, parent, key) => {
    switch (node.type) {
      case 'VariableDeclarator': collectPatternNames(node.id, declared); return;
      case 'FunctionDeclaration':
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
      case 'ObjectMethod':
      case 'ClassMethod':
        if (node.id) declared.add(node.id.name);
        for (const p of (node.params || [])) collectPatternNames(p, declared);
        return;
      case 'ClassDeclaration':
      case 'ClassExpression':
        if (node.id) declared.add(node.id.name);
        return;
      case 'CatchClause':
        if (node.param) collectPatternNames(node.param, declared);
        return;
      case 'Identifier': {
        if (!parent) return;
        /* a.b — `b` is a property, not a binding */
        if (parent.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
        if (parent.type === 'OptionalMemberExpression' && key === 'property' && !parent.computed) return;
        /* { b: 1 } and { b } — `b` in key position is a property name */
        if ((parent.type === 'ObjectProperty' || parent.type === 'Property') && key === 'key' && !parent.computed) return;
        if ((parent.type === 'ObjectMethod' || parent.type === 'ClassMethod' ||
             parent.type === 'ClassProperty' || parent.type === 'ClassPrivateProperty') &&
            key === 'key' && !parent.computed) return;
        /* labels, and the names in declaration/param position, which are bindings */
        if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' ||
            parent.type === 'ContinueStatement') return;
        if (parent.type === 'VariableDeclarator' && key === 'id') return;
        if (key === 'params' || parent.type === 'ObjectPattern' || parent.type === 'ArrayPattern' ||
            parent.type === 'RestElement' || (parent.type === 'AssignmentPattern' && key === 'left')) return;
        if ((parent.type === 'FunctionDeclaration' || parent.type === 'FunctionExpression' ||
             parent.type === 'ClassDeclaration' || parent.type === 'ClassExpression' ||
             parent.type === 'ArrowFunctionExpression') && key === 'id') return;
        if (parent.type === 'MetaProperty') return;
        if (!used.has(node.name)) used.set(node.name, (node.loc && node.loc.start.line) || 0);
        /* `typeof x` never throws on an undeclared x — it is the guard idiom. Tracked
           per-name: one BARE use is enough to make the name a finding again. */
        const guarded = !!(parent.type === 'UnaryExpression' && parent.operator === 'typeof');
        typeofOnly.set(node.name, (typeofOnly.has(node.name) ? typeofOnly.get(node.name) : true) && guarded);
        return;
      }
      default: return;
    }
  }, null, null);

  const undeclared = [...used.entries()]
    .filter(([name]) => !declared.has(name) && !AMBIENT.has(name) && !typeofOnly.get(name))
    .map(([name, line]) => ({ name, line }))
    .sort((a, b) => a.line - b.line);

  return { ok: true, reason: 'parsed with ' + loaded.from, undeclared,
    declaredCount: declared.size, usedCount: used.size };
}

module.exports = { findUndeclared, AMBIENT };
