const fs = require('fs');
const path = require('path');
const pages = [
  'b2b-dashboard.html','b2b-orders.html','b2b-rfq.html','b2b-seller-dashboard.html','b2b-supplier.html',
  'business-os.html','cart.html','delivery.html','dispute-portal.html','ent-organizer.html','fleet-monitor.html',
  'food-rider.html','invoice.html','notifications.html','org-directory.html','org-structure.html','org-workflows.html',
  'pos-workspace.html','professional-profile.html','property-agent-dashboard.html','property-dashboard.html','provider.html',
  'referral.html','requests.html','ride-book.html','verification.html','wishlist.html'
];

function getScriptTags(html) {
  const regex = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
  const tags = [];
  let m;
  while ((m = regex.exec(html))) {
    const attrs = m[1];
    const srcMatch = /src\s*=\s*['\"]([^'\"]+)['\"]/i.exec(attrs);
    const src = srcMatch ? srcMatch[1] : null;
    const defer = /\bdefer\b/i.test(attrs);
    const typeMatch = /type\s*=\s*['\"]([^'\"]+)['\"]/i.exec(attrs);
    const type = typeMatch ? typeMatch[1] : null;
    const async = /\basync\b/i.test(attrs);
    tags.push({ src, defer, async, type, attrs: attrs.trim() });
  }
  return tags;
}

for (const page of pages) {
  const file = path.join(__dirname, '..', page);
  if (!fs.existsSync(file)) {
    console.log(`PAGE ${page} MISSING`);
    continue;
  }
  const html = fs.readFileSync(file, 'utf8');
  const scripts = getScriptTags(html);
  const authIndex = scripts.findIndex(s => s.src && s.src.includes('auth-guard.js'));
  const firebaseIndex = scripts.findIndex(s => s.src && s.src.includes('firebase.js'));
  const preAuth = scripts.slice(0, authIndex >= 0 ? authIndex : scripts.length);
  const hasPreFirebase = firebaseIndex >= 0 && firebaseIndex < authIndex;
  console.log(`PAGE ${page}`);
  console.log(`  auth-guard index: ${authIndex}`);
  console.log(`  firebase.js index: ${firebaseIndex}`);
  console.log(`  firebase before auth-guard: ${hasPreFirebase}`);
  preAuth.forEach((s, i) => console.log(`    ${i + 1}. ${s.src || '[inline]'} defer=${s.defer} async=${s.async} type=${s.type || ''}`));
  if (authIndex >= 0) {
    console.log(`  scripts after auth-guard until end:`);
    scripts.slice(authIndex + 1).forEach((s, i) => console.log(`    + ${i + 1}. ${s.src || '[inline]'} defer=${s.defer} async=${s.async} type=${s.type || ''}`));
  }
  console.log('');
}
