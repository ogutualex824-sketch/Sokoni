const fs = require('fs');
const path = require('path');
function walk(dir) {
  const files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(p));
    else if (entry.isFile() && p.endsWith('.html')) files.push(p);
  }
  return files;
}
const root = process.cwd();
const missing = [];
for (const filePath of walk(root)) {
  const content = fs.readFileSync(filePath, 'utf8');
  const protectedPage = /data-require-auth="true"/.test(content);
  const hasAuthGuard = /src="auth-guard\.js"/.test(content) || /src="sokoni-guards\.js"/.test(content);
  if (protectedPage && !hasAuthGuard) {
    missing.push(path.relative(root, filePath));
  }
}
console.log(JSON.stringify(missing, null, 2));
