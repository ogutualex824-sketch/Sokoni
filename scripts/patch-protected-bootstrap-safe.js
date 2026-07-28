const fs = require('fs');
const path = require('path');

const pages = [
  'account-centre.html','b2b-dashboard.html','b2b-orders.html','b2b-rfq.html','b2b-seller-dashboard.html','b2b-supplier.html',
  'bnb-manage.html','business-os.html','cart.html','checkout.html','delivery-tracking.html','delivery.html','digital-esoko-seller.html',
  'dispatch.html','dispute-portal.html','driver-success.html','driver.html','ent-organizer.html','finos.html','fleet-monitor.html',
  'food-dashboard.html','food-rider.html','inventory.html','invoice.html','landlord.html','my-orders.html','notifications.html',
  'org-directory.html','org-structure.html','org-workflows.html','pos-workspace.html','professional-profile.html','profile.html',
  'property-agent-dashboard.html','property-dashboard.html','provider-dashboard.html','provider.html','referral.html','requests.html',
  'ride-book.html','seller-delivery.html','seller.html','staff-management.html','subscriptions.html','verification.html','wallet.html','wishlist.html'
];

const scriptRegex = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
const srcRegex = /src\s*=\s*['\"]([^'\"]+)['\"]/i;
function parseScriptTags(text) {
  const scripts = [];
  let match;
  while ((match = scriptRegex.exec(text))) {
    const attrs = match[1];
    const srcMatch = srcRegex.exec(attrs);
    scripts.push({
      tag: match[0],
      src: srcMatch ? srcMatch[1] : null,
      attrs,
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return scripts;
}

function buildPatchedText(text, scripts, initTag, authTag, sharedTag, authIndex, sharedIndex, initIndex) {
  const insertionStart = Math.min(
    authIndex >= 0 ? scripts[authIndex].start : Number.MAX_SAFE_INTEGER,
    sharedIndex >= 0 ? scripts[sharedIndex].start : Number.MAX_SAFE_INTEGER,
    initIndex >= 0 ? scripts[initIndex].start : Number.MAX_SAFE_INTEGER
  );
  const removed = new Set();
  if (initIndex >= 0) removed.add(initIndex);
  removed.add(authIndex);
  removed.add(sharedIndex);

  let output = text.slice(0, insertionStart);
  output += `${initTag}\n${authTag}\n${sharedTag}`;
  let cursor = insertionStart;

  for (let idx = 0; idx < scripts.length; idx++) {
    const script = scripts[idx];
    if (script.start < insertionStart) continue;
    output += text.slice(cursor, script.start);
    if (!removed.has(idx)) {
      output += script.tag;
    }
    cursor = script.end;
  }

  output += text.slice(cursor);
  return output;
}
const report = [];
let modifiedCount = 0;
let skippedCount = 0;
let failedCount = 0;

const isFirebaseSrc = src => src && (/firebase\.js$/.test(src) || /firebase-app-compat\.js$/.test(src) || /firebase-auth-compat\.js$/.test(src) || /firebase-functions-compat\.js$/.test(src) || /firebase-app-check-compat\.js$/.test(src));

for (const page of pages) {
  const file = path.join(__dirname, '..', page);
  let text = fs.readFileSync(file, 'utf8');
  const scripts = parseScriptTags(text);

  const authIndex = scripts.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const initIndex = scripts.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));
  const sharedIndex = scripts.findIndex(s => s.src && /shared-header\.js$/.test(s.src));
  const firebaseScripts = scripts.filter(s => isFirebaseSrc(s.src));
  const hasFirebase = firebaseScripts.length > 0;
  const hasAuth = authIndex >= 0;
  const hasShared = sharedIndex >= 0;

  if (!hasAuth || !hasShared) {
    report.push({ page, status: 'skipped', reason: !hasAuth ? 'missing auth-guard.js' : 'missing shared-header.js' });
    skippedCount++;
    continue;
  }
  if (hasFirebase) {
    report.push({ page, status: 'skipped', reason: 'direct Firebase scripts present', firebase: firebaseScripts.map(s => s.src) });
    skippedCount++;
    continue;
  }

  const alreadyValid = initIndex >= 0 && initIndex < authIndex && authIndex < sharedIndex;
  if (alreadyValid) {
    report.push({ page, status: 'compliant' });
    continue;
  }

  const authTag = scripts[authIndex].tag;
  const sharedTag = scripts[sharedIndex].tag;
  const initTag = initIndex >= 0 ? scripts[initIndex].tag : '<script type="module" src="sokoni-init.js"></script>';
  const patched = buildPatchedText(text, scripts, initTag, authTag, sharedTag, authIndex, sharedIndex, initIndex);

  // Verify the result
  const resultScripts = [];
  let resMatch;
  while ((resMatch = scriptRegex.exec(patched))) {
    const attrs = resMatch[1];
    const srcMatch = srcRegex.exec(attrs);
    resultScripts.push(srcMatch ? srcMatch[1] : null);
  }
  const resultAuthIndex = resultScripts.findIndex(s => s && /auth-guard\.js$/.test(s));
  const resultInitIndex = resultScripts.findIndex(s => s && /sokoni-init\.js$/.test(s));
  const resultSharedIndex = resultScripts.findIndex(s => s && /shared-header\.js$/.test(s));
  const valid = resultInitIndex >= 0 && resultInitIndex < resultAuthIndex && resultAuthIndex < resultSharedIndex;

  if (!valid) {
    report.push({ page, status: 'failed', reason: 'verification failed after patch', resultScripts });
    failedCount++;
    continue;
  }

  fs.writeFileSync(file, patched, 'utf8');
  report.push({ page, status: 'modified', original: scripts.map(s => s.src || '[inline]'), newOrder: resultScripts });
  modifiedCount++;
}

console.log(JSON.stringify({ modifiedCount, skippedCount, failedCount, report }, null, 2));
