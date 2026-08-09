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

const scriptRegex = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
const srcRegex = /src\s*=\s*['\"]([^'\"]+)['\"]/i;
const files = walk(path.join(__dirname, '..'));
const pageResults = [];
let modifiedCount = 0;

for (const file of files) {
  const rel = path.relative(path.join(__dirname, '..'), file).replace(/\\/g, '/');
  const text = fs.readFileSync(file, 'utf8');
  const requiresAuth = /data-require-auth\s*=\s*['\"]true['\"]/i.test(text);
  const requiresRole = /data-require-role\s*=/.test(text);
  if (!requiresAuth && !requiresRole) continue;

  const scripts = [];
  let match;
  while ((match = scriptRegex.exec(text))) {
    const srcMatch = srcRegex.exec(match[1]);
    scripts.push({
      start: match.index,
      end: scriptRegex.lastIndex,
      tag: match[0],
      src: srcMatch ? srcMatch[1] : null,
    });
  }

  const authIndex = scripts.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const initIndex = scripts.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));
  const sharedHeaderIndex = scripts.findIndex(s => s.src && /shared-header\.js$/.test(s.src));
  const hasAuthGuard = authIndex >= 0;
  const hasSharedHeader = sharedHeaderIndex >= 0;

  if (!hasAuthGuard) {
    pageResults.push({ file: rel, status: 'skipped', reason: 'missing auth-guard.js' });
    continue;
  }
  if (!hasSharedHeader) {
    pageResults.push({ file: rel, status: 'skipped', reason: 'missing shared-header.js' });
    continue;
  }

  const validInitBeforeAuth = initIndex >= 0 && initIndex < authIndex;
  const validAuthBeforeHeader = authIndex < sharedHeaderIndex;
  const alreadyValid = validInitBeforeAuth && validAuthBeforeHeader;
  if (alreadyValid) {
    pageResults.push({ file: rel, status: 'compliant' });
    continue;
  }

  const scriptOrder = scripts.map(s => s.src || '[inline]');
  let modified = false;
  let working = scripts.slice();

  const moveScript = (fromIndex, toIndex) => {
    if (fromIndex === toIndex) return;
    const [item] = working.splice(fromIndex, 1);
    const insertIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
    working.splice(insertIndex, 0, item);
    modified = true;
  };

  const insertInitBefore = (index) => {
    const initTag = '<script type="module" src="sokoni-init.js"></script>';
    working.splice(index, 0, { start: -1, end: -1, tag: initTag, src: 'sokoni-init.js' });
    modified = true;
  };

  if (!hasAuthGuard) {
    pageResults.push({ file: rel, status: 'failed', reason: 'protected page without auth-guard.js' });
    continue;
  }

  if (!hasSharedHeader) {
    pageResults.push({ file: rel, status: 'failed', reason: 'protected page without shared-header.js' });
    continue;
  }

  if (authIndex > sharedHeaderIndex) {
    moveScript(authIndex, sharedHeaderIndex);
  }

  const currentAuthIndex = working.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const currentInitIndex = working.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));

  if (currentInitIndex === -1) {
    insertInitBefore(currentAuthIndex >= 0 ? currentAuthIndex : 0);
  } else if (currentInitIndex > currentAuthIndex) {
    moveScript(currentInitIndex, currentAuthIndex);
  }

  const finalAuthIndex = working.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const finalInitIndex = working.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));
  const finalSharedHeaderIndex = working.findIndex(s => s.src && /shared-header\.js$/.test(s.src));
  const finalValid = finalInitIndex >= 0 && finalInitIndex < finalAuthIndex && finalAuthIndex < finalSharedHeaderIndex;

  if (!finalValid) {
    pageResults.push({ file: rel, status: 'failed', reason: 'could not safely reorder scripts', original: scriptOrder });
    continue;
  }

  if (!modified) {
    pageResults.push({ file: rel, status: 'compliant' });
    continue;
  }

  // Rebuild HTML by replacing script tags from back to front
  let patched = text;
  const replacementRanges = [];
  for (let i = 0; i < scripts.length; i++) {
    replacementRanges.push({ start: scripts[i].start, end: scripts[i].end, original: scripts[i].tag });
  }
  replacementRanges.sort((a, b) => b.start - a.start);
  for (const range of replacementRanges) {
    patched = patched.slice(0, range.start) + `{{SCRIPT_PLACEHOLDER_${range.start}}}` + patched.slice(range.end);
  }

  for (const range of replacementRanges) {
    patched = patched.replace(`{{SCRIPT_PLACEHOLDER_${range.start}}}`, '');
  }

  // Build new script section with working tags in original order and inserted ones
  const rebuilt = working.map(item => item.tag).join('\n');

  // Replace first removed block with rebuilt section
  const minStart = Math.min(...replacementRanges.map(r => r.start));
  const maxEnd = Math.max(...replacementRanges.map(r => r.end));
  patched = patched.slice(0, minStart) + rebuilt + patched.slice(maxEnd);

  fs.writeFileSync(file, patched, 'utf8');
  modifiedCount++;
  pageResults.push({ file: rel, status: 'modified', original: scriptOrder, newOrder: working.map(s => s.src || '[inline]') });
}

console.log(JSON.stringify({ modifiedCount, pages: pageResults }, null, 2));
