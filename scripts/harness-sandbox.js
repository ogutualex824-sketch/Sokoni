'use strict';
/* ────────────────────────────────────────────────────────────────────────────
   harness-sandbox.js — guards "extract-and-eval" test harnesses against drift.

   Several suites (e.g. test-booking-payment-auth) assert the SHIPPED logic by
   pulling a real code block out of a production file and executing it inside a
   new Function(...) sandbox. That sandbox is a bare function scope: it exposes
   the JS globals (console, process, Buffer, setTimeout, …) but NOT the
   CommonJS module wrapper bindings (require, module, exports, __dirname,
   __filename). Production code may legitimately use those.

   When production later gains such a dependency — say a new
   require('./shared/constants') — the sandbox silently lacks it and the suite
   dies mid-run with a cryptic "ReferenceError: require is not defined",
   fail-closing the deploy gate on what looks like a real defect but is really
   the harness lagging behind runtime.

   assertSandboxProvides() converts that into an early, actionable message that
   names the missing binding and points at the fix (add it to the parameter
   list), so harness drift is caught the moment a new import lands rather than
   surfacing as a mystery gate block later.
   ──────────────────────────────────────────────────────────────────────────── */

/* The CommonJS module wrapper arguments. A plain new Function() scope does NOT
   expose these; ordinary JS globals (console/process/Buffer/…) it does, so they
   are deliberately absent here to avoid false positives. */
const DEP_PROBES = [
  { name: 'require',    re: /\brequire\s*\(/ },
  { name: 'module',     re: /\bmodule\b/ },
  { name: 'exports',    re: /(?<!\w)exports\b/ },
  { name: '__dirname',  re: /\b__dirname\b/ },
  { name: '__filename', re: /\b__filename\b/ },
];

/** Names the extracted block references that a bare function scope won't supply
 *  and the harness has not provided. Empty array = the sandbox is faithful. */
function missingSandboxDeps(block, providedNames) {
  const provided = new Set(providedNames || []);
  return DEP_PROBES
    .filter((p) => p.re.test(block) && !provided.has(p.name))
    .map((p) => p.name);
}

/** Throw a clear, actionable error if the sandbox omits any dependency the
 *  extracted block uses. Call this BEFORE running assertions. */
function assertSandboxProvides(block, providedNames, label) {
  const missing = missingSandboxDeps(block, providedNames);
  if (missing.length) {
    throw new Error(
      'HARNESS DRIFT (' + (label || 'sandbox') + '): the extracted production ' +
      'block references [' + missing.join(', ') + '] which the new Function() ' +
      'sandbox does not provide. Add ' +
      missing.map((m) => JSON.stringify(m)).join(', ') +
      ' to the parameter list and pass a runtime-faithful value. Production ' +
      'gained a module dependency the harness has not mirrored.'
    );
  }
}

module.exports = { DEP_PROBES, missingSandboxDeps, assertSandboxProvides };
