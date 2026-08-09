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
const pages = [];
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
    scripts.push({ src: srcMatch ? srcMatch[1] : null, attrs });
  }
  const authIndex = scripts.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const initIndex = scripts.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));
  const firebaseIndex = scripts.findIndex(s => s.src && /firebase\.js$/.test(s.src));
  const sharedHeaderIndex = scripts.findIndex(s => s.src && /shared-header\.js$/.test(s.src));
  const hasAuthGuard = authIndex >= 0;
  const hasInit = initIndex >= 0;
  const hasFirebase = firebaseIndex >= 0;
  const hasSharedHeader = sharedHeaderIndex >= 0;
  const validInitBeforeAuth = hasInit && hasAuthGuard && initIndex < authIndex;
  const validAuthBeforeHeader = hasAuthGuard && hasSharedHeader && authIndex < sharedHeaderIndex;
  const valid = validInitBeforeAuth && validAuthBeforeHeader;
  const issues = [];
  if (!hasInit) issues.push('missing sokoni-init.js');
  if (!hasAuthGuard && requiresAuth) issues.push('missing auth-guard.js');
  if (hasInit && hasAuthGuard && initIndex > authIndex) issues.push('sokoni-init.js after auth-guard.js');
  if (hasAuthGuard && hasSharedHeader && authIndex > sharedHeaderIndex) issues.push('auth-guard.js after shared-header.js');
  if (requiresRole && !hasAuthGuard) issues.push('role-protected without auth-guard');
  if (hasInit && hasFirebase) issues.push('both sokoni-init.js and firebase.js present');
  if (!hasInit && hasFirebase) issues.push('firebase.js loaded directly');
  pages.push({ file: rel, requiresAuth, requiresRole, hasInit, hasFirebase, hasAuthGuard, hasSharedHeader, initIndex, authIndex, sharedHeaderIndex, firebaseIndex, validInitBeforeAuth, validAuthBeforeHeader, valid, issues, scriptOrder: scripts.map((s, i) => ({ index: i, src: s.src })) });
}
const validCount = pages.filter(p => p.valid).length;
console.log(JSON.stringify({ total: pages.length, validCount, invalidCount: pages.length - validCount, allValid: validCount === pages.length, pages }, null, 2));
