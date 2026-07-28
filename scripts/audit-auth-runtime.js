const fs = require('fs');
const path = require('path');

function walk(dir, fileList = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, fileList);
    } else if (entry.isFile() && fullPath.endsWith('.html')) {
      fileList.push(fullPath);
    }
  }
  return fileList;
}

const files = walk(path.join(__dirname, '..'));
const results = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const requiresAuth = /data-require-auth=\"true\"/.test(text);
  const requiresRole = /data-require-role=/.test(text);
  if (!requiresAuth && !requiresRole) continue;
  const hasFirebase = /firebase\.js/.test(text);
  const hasAuthGuard = /auth-guard\.js/.test(text) || /sokoni-guards\.js/.test(text);
  results.push({
    file: path.relative(path.join(__dirname, '..'), file),
    requiresAuth,
    requiresRole,
    hasFirebase,
    hasAuthGuard,
  });
}

const missingFirebase = results.filter(r => !r.hasFirebase);
const missingGuard = results.filter(r => !r.hasAuthGuard);
const missingAuth = results.filter(r => r.requiresAuth && !/auth-guard\.js/.test(fs.readFileSync(path.join(__dirname, '..', r.file), 'utf8')));

console.log(JSON.stringify({ total: results.length, missingFirebase: missingFirebase.length, missingGuard: missingGuard.length, missingAuth: missingAuth.length, missingFirebase, missingGuard, missingAuth }, null, 2));
