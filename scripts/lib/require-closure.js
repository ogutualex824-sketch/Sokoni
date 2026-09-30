/* require-closure of one functions module (static, ./-relative requires only). usage: node closure.js <functionsDir> <entry.js> */
const fs = require('fs'), P = require('path');
const FN = process.argv[2], entry = process.argv[3];
const seen = new Set(); const q = [entry];
while (q.length) {
  const f = q.shift(); if (seen.has(f)) continue; seen.add(f);
  const p = P.join(FN, f); if (!fs.existsSync(p)) continue;
  const s = fs.readFileSync(p, 'utf8'); const re = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g; let m;
  while ((m = re.exec(s))) { let r = P.posix.normalize(P.posix.join(P.posix.dirname(f), m[1])); if (!/\.(js|json)$/.test(r)) r += '.js'; if (!seen.has(r)) q.push(r); }
}
const list = [...seen].sort();
console.log(JSON.stringify({ entry, size: list.length, universalOnboarding: list.includes('universal-onboarding.js'), approvalRemediation: list.includes('shared/approval-remediation.js'), applicationLifecycle: list.includes('application-lifecycle.js'), businessApprovalAdmin: list.includes('business-approval-admin.js'), merchantIdentity: list.includes('merchant-identity.js'), files: list }, null, 1));
