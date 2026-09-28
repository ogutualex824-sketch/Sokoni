'use strict';
/**
 * CERTIFICATION — webhookSmartpos is retired (security containment, owner-authorized 2026-09-28).
 *
 * webhookSmartpos was a PUBLIC onRequest (invoker allUsers) that passed no secretKey to _processWebhook, so the
 * signature check was skipped, and it .add()-ed the raw request body to posTransactions. The deployed triggers turn a
 * posTransactions document into a COMPLETED posRetailSales sale for the merchant the body names
 * (mirrorPosTransactionToRetail) and into M-Pesa reference claims (onPosTransactionMpesaRef). This suite proves the
 * source can no longer produce that ingress, and that nothing else was changed along with it.
 *
 *   W-1  functions/index.js exports no webhookSmartpos (parsed, not grepped: a comment does not count)
 *   W-2  no exported onRequest handler .add()s a raw request body to posTransactions (the vulnerable SHAPE, under any name)
 *   W-3  neither batch deploy list names it (a scripted deploy cannot recreate it)
 *   W-4  the downstream triggers are still exported, unchanged in name: mirrorPosTransactionToRetail,
 *        onPosTransactionMpesaRef, claimPosMpesaReference (their authority is a separate decision)
 *   W-5  the other webhook ingresses are still exported (webhookIntasend, webhookMpesa, webhookStripe)
 *
 *   REPAIR_ROOT  tree under test (default: this repo).
 */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(process.env.REPAIR_ROOT || path.join(__dirname, '..'));
const FN = path.join(ROOT, 'functions');

let pass = 0, fail = 0;
const ok = (c, id, m) => { if (c) pass++; else fail++; process.stdout.write('  ' + (c ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + '\n'); };

const parser = require(require.resolve('@babel/parser', { paths: [FN, 'C:/Users/USER1/OneDrive/Desktop/SOKONI/functions/node_modules'] }));
const src = fs.readFileSync(path.join(FN, 'index.js'), 'utf8');
const ast = parser.parse(src, { sourceType: 'script', allowReturnOutsideFunction: true });

/* exported names: `exports.X = …` at top level, plus the names Object.assign(exports, require('./m')) brings in */
const exported = new Set();
const assigned = [];
for (const st of ast.program.body) {
  if (st.type !== 'ExpressionStatement') continue;
  const e = st.expression;
  if (e.type === 'AssignmentExpression' && e.left.type === 'MemberExpression' && e.left.object.name === 'exports') {
    exported.add(e.left.property.name || e.left.property.value);
    assigned.push({ name: e.left.property.name, node: e.right });
  }
  if (e.type === 'CallExpression' && e.callee.type === 'MemberExpression' && e.callee.object.name === 'Object'
      && e.callee.property.name === 'assign' && e.arguments[0] && e.arguments[0].name === 'exports') {
    for (const a of e.arguments.slice(1)) {
      let mod = null;
      if (a.type === 'Identifier') {
        const decl = ast.program.body.find((s) => s.type === 'VariableDeclaration' && s.declarations.some((d) => d.id.name === a.name));
        const d = decl && decl.declarations.find((x) => x.id.name === a.name);
        if (d && d.init && d.init.type === 'CallExpression' && d.init.callee.name === 'require') mod = d.init.arguments[0].value;
      } else if (a.type === 'CallExpression' && a.callee.name === 'require') mod = a.arguments[0].value;
      if (mod) {
        const p = path.join(FN, mod.replace(/^\.\//, '') + (mod.endsWith('.js') ? '' : '.js'));
        if (fs.existsSync(p)) for (const m of fs.readFileSync(p, 'utf8').matchAll(/exports\.([A-Za-z0-9_]+)\s*=/g)) exported.add(m[1]);
      }
    }
  }
}

process.stdout.write(`\nwebhookSmartpos retirement   (tree: ${ROOT})\n\n`);
ok(!exported.has('webhookSmartpos'), 'W-1', 'functions/index.js exports no webhookSmartpos (parsed exports: ' + exported.size + ')');

const code = (n) => src.slice(n.start, n.end);
const vulnerable = assigned.filter(({ node }) => {
  const c = code(node);
  return /onRequest\s*\(/.test(c) && /collection\(\s*["']posTransactions["']\s*\)\s*\.add\(/.test(c);
}).map((x) => x.name);
ok(vulnerable.length === 0, 'W-2', 'no exported onRequest handler adds a request body to posTransactions' + (vulnerable.length ? ': ' + vulnerable.join(', ') : ''));

const lists = ['deploy-batches.ps1', 'scripts/batch_deploy.sh'].map((f) => [f, fs.existsSync(path.join(ROOT, f)) ? fs.readFileSync(path.join(ROOT, f), 'utf8') : '']);
const named = lists.filter(([, t]) => /webhookSmartpos(?![A-Za-z])/.test(t.replace(/#.*$/gm, ''))).map(([f]) => f);
ok(lists.every(([, t]) => t.length > 0) && named.length === 0, 'W-3', 'neither batch deploy list names webhookSmartpos' + (named.length ? ' — still in: ' + named.join(', ') : ''));

const triggers = ['mirrorPosTransactionToRetail', 'onPosTransactionMpesaRef', 'claimPosMpesaReference'];
const missingT = triggers.filter((t) => !exported.has(t));
ok(missingT.length === 0, 'W-4', 'the downstream triggers are still exported (untouched): ' + (missingT.length ? 'MISSING ' + missingT.join(', ') : triggers.join(', ')));

const hooks = ['webhookIntasend', 'webhookMpesa', 'webhookStripe'];
const missingH = hooks.filter((h) => !exported.has(h));
ok(missingH.length === 0, 'W-5', 'the other webhook ingresses are still exported: ' + (missingH.length ? 'MISSING ' + missingH.join(', ') : hooks.join(', ')));

process.stdout.write(`\n  ${pass} pass / ${fail} fail\n`);
process.exit(fail ? 1 : 0);
