const fs = require('fs');
const path = require('path');
const invalidPages = [
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
const results = [];
for (const file of invalidPages) {
  const text = fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const scripts=[];
  let m;
  while ((m = scriptRegex.exec(text))) {
    const attrs=m[1];
    const srcMatch=srcRegex.exec(attrs);
    scripts.push({ src: srcMatch ? srcMatch[1] : null, tag: m[0], attrs });
  }
  const auth = scripts.findIndex(s=>s.src&&/auth-guard\.js$/.test(s.src));
  const init = scripts.findIndex(s=>s.src&&/sokoni-init\.js$/.test(s.src));
  const firebase = scripts.filter(s=>s.src&&(s.src.includes('firebase.js')||s.src.includes('firebase-app-compat.js'))).map(s=>s.src);
  const shared = scripts.findIndex(s=>s.src&&/shared-header\.js$/.test(s.src));
  results.push({ file, auth, init, shared, firebase, countFirebase: firebase.length, scriptOrder: scripts.map(s=>s.src||'[inline]') });
}
const grouped = results.reduce((acc, item)=>{
  const key = item.countFirebase > 0 ? 'hasFirebase' : item.init >=0 ? 'hasInit' : 'missingInit';
  acc[key] = acc[key]||[];
  acc[key].push(item);
  return acc;
}, {});
console.log(JSON.stringify({ totals: { all: results.length, hasFirebase: grouped.hasFirebase?.length||0, hasInit: grouped.hasInit?.length||0, missingInit: grouped.missingInit?.length||0 }, grouped}, null, 2));
