'use strict';
/* AST check for the Route B Daraja port (owner 2026-10-03): after removing 093fd4f's declaration set from this
   lineage, NO module under functions/ may still REFERENCE a removed name (an identifier that would now be undeclared
   at runtime) or require the deleted ./mpesa-c2b module. Parsed with @babel/parser — not a regex: comments and string
   mentions are not references; member properties (x.darajaSTKPush) and object keys are reported separately because
   they are not undeclared-identifier faults.
     node scripts/check-daraja-removed-names.js        (exit 0 = clean; 1 = a reference remains; 2 = could not parse) */
const fs = require('fs'), path = require('path');
const NM = process.env.SOKONI_NODE_MODULES || 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules';
const { parse } = require(require.resolve('@babel/parser', { paths: [NM] }));
const ROOT = path.join(__dirname, '..', 'functions');
const REMOVED = new Set(['darajaSTKPush', 'darajaSTKCallback', 'sendTestSTKPush', 'validateDarajaCredentials', 'webhookMpesa',
  'mpesaC2BValidation', 'mpesaC2BConfirmation', '_normalizeMsisdn', '_darajaToken', '_darajaTimestamp', 'DARAJA_UTC_OFFSET_MS',
  'SAFARICOM_CALLBACK_IPS', '_DARAJA_SANDBOX_SELLER_UIDS', '_DARAJA_IPS', '_c2b']);
const files = [];
(function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
  const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.(c?js|mjs)$/.test(e.name)) files.push(p); } })(ROOT);
const refs = [], props = [], reqs = [], bad = [];
for (const f of files) {
  let ast; const src = fs.readFileSync(f, 'utf8');
  try { ast = parse(src, { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: false, plugins: [] }); }
  catch (e) { bad.push(path.relative(ROOT, f) + ': ' + e.message.slice(0, 80)); continue; }
  const declared = new Set();
  (function visit(n, parent, key) {
    if (!n || typeof n.type !== 'string') return;
    if (n.type === 'Identifier' && REMOVED.has(n.name)) {
      const isProp = parent && ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && key === 'property' && !parent.computed);
      const isKey = parent && (parent.type === 'ObjectProperty' || parent.type === 'ObjectMethod') && key === 'key' && !parent.computed;
      const isDecl = parent && ((parent.type === 'VariableDeclarator' && key === 'id') || ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration') && key === 'id'));
      if (isDecl) declared.add(n.name);
      else (isProp || isKey ? props : refs).push(path.relative(ROOT, f) + ':' + n.loc.start.line + ' ' + n.name + (isProp ? ' (member property)' : isKey ? ' (object key)' : ''));
    }
    if (n.type === 'CallExpression' && n.callee && n.callee.name === 'require' && n.arguments[0] && /mpesa-c2b/.test(String(n.arguments[0].value || ''))) {
      reqs.push(path.relative(ROOT, f) + ':' + n.loc.start.line + ' require("' + n.arguments[0].value + '")');
    }
    for (const k of Object.keys(n)) { if (k === 'loc' || k === 'start' || k === 'end' || k === 'extra') continue; const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, n, k)); else if (v && typeof v.type === 'string') visit(v, n, k); }
  })(ast.program, null, null);
  /* a name re-declared locally in the same file is that file's own binding, not a dangling reference */
  for (let i = refs.length - 1; i >= 0; i--) { const [loc, nm] = refs[i].split(' '); if (loc.startsWith(path.relative(ROOT, f) + ':') && declared.has(nm)) refs.splice(i, 1); }
}
console.log('\nDaraja removed-name AST check — ' + files.length + ' modules under functions/\n');
console.log('  undeclared references : ' + refs.length); refs.forEach((r) => console.log('    ' + r));
console.log('  require("./mpesa-c2b"): ' + reqs.length); reqs.forEach((r) => console.log('    ' + r));
console.log('  member props / keys   : ' + props.length + ' (not faults; listed for review)'); props.slice(0, 30).forEach((r) => console.log('    ' + r));
if (bad.length) { console.log('  UNPARSED: ' + bad.length); bad.forEach((b) => console.log('    ' + b)); }
const ok = !refs.length && !reqs.length && !bad.length;
console.log('\n' + (ok ? 'CLEAN' : 'NOT CLEAN') + '\n');
process.exit(bad.length ? 2 : ok ? 0 : 1);
