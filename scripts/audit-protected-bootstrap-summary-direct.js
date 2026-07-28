const fs = require('fs');
const path = require('path');
function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(fullPath, files);
    else if (entry.isFile() && entry.name.endsWith('.html')) files.push(fullPath);
  }
  return files;
}
const scriptTag = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
const srcAttr = /src\s*=\s*['\"]([^'\"]+)['\"]/i;
const files = walk(path.join(__dirname, '..'));
const invalid = [];
for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const requiresAuth = /data-require-auth\s*=\s*['\"]true['\"]/i.test(text);
  const requiresRole = /data-require-role\s*=/.test(text);
  if (!requiresAuth && !requiresRole) continue;
  const scripts = [];
  let m;
  while ((m = scriptTag.exec(text))) {
    const attrs = m[1];
    const srcMatch = srcAttr.exec(attrs);
    scripts.push({ src: srcMatch ? srcMatch[1] : null });
  }
  const authIndex = scripts.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const initIndex = scripts.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));
  const firebaseIndex = scripts.findIndex(s => s.src && /firebase\.js$/.test(s.src));
  const sharedHeaderIndex = scripts.findIndex(s => s.src && /shared-header\.js$/.test(s.src));
  const hasAuthGuard = authIndex >= 0;
  const hasInit = initIndex >= 0;
  const validInitBeforeAuth = hasInit && hasAuthGuard && initIndex < authIndex;
  if (!validInitBeforeAuth) {
    const issues = [];
    if (!hasInit) issues.push('missing sokoni-init.js');
    else if (initIndex > authIndex) issues.push('sokoni-init.js after auth-guard.js');
    invalid.push({ file: rel, issues, authIndex, initIndex, sharedHeaderIndex, scriptOrder: scripts.map((s, i) => ({ index: i, src: s.src })) });
  }
}
console.log(JSON.stringify({ total: invalid.length, invalid }, null, 2));
