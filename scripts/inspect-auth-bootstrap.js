const fs = require('fs');
const path = require('path');
const pages = [
  'b2b-dashboard.html','b2b-orders.html','b2b-rfq.html','b2b-seller-dashboard.html','b2b-supplier.html',
  'business-os.html','cart.html','delivery.html','dispute-portal.html','ent-organizer.html','fleet-monitor.html',
  'food-rider.html','invoice.html','notifications.html','org-directory.html','org-structure.html','org-workflows.html',
  'pos-workspace.html','professional-profile.html','property-agent-dashboard.html','property-dashboard.html','provider.html',
  'referral.html','requests.html','ride-book.html','verification.html','wishlist.html'
];
const scriptTag = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
const srcAttr = /src\s*=\s*['"]([^'"]+)['"]/i;
for (const page of pages) {
  const p = path.join(__dirname, '..', page);
  const html = fs.readFileSync(p, 'utf8');
  const scripts = [];
  let m;
  while ((m = scriptTag.exec(html))) {
    const attrs = m[1];
    const srcMatch = srcAttr.exec(attrs);
    scripts.push({ src: srcMatch ? srcMatch[1] : null, attrs });
  }
  const authIndex = scripts.findIndex(s => s.src && s.src.includes('auth-guard.js'));
  const initIndex = scripts.findIndex(s => s.src && s.src.includes('sokoni-init.js'));
  const firebaseIndex = scripts.findIndex(s => s.src && s.src.includes('firebase.js'));
  const beforeAuth = initIndex >= 0 && initIndex < authIndex;
  const pageResult = {
    page,
    authIndex,
    initIndex,
    firebaseIndex,
    beforeAuth,
    hasInit: initIndex >= 0,
    hasFirebase: firebaseIndex >= 0,
    scripts: scripts.map((s, i) => ({ index: i, src: s.src })),
  };
  console.log(JSON.stringify(pageResult));
}
