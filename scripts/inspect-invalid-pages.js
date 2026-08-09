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
for (const file of invalidPages) {
  const text = fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const scripts=[];
  let m;
  while ((m = scriptRegex.exec(text))) {
    const attrs=m[1];
    const srcMatch=srcRegex.exec(attrs);
    scripts.push(srcMatch ? srcMatch[1] : null);
  }
  const authCount=scripts.filter(s=>s&&s.includes('auth-guard.js')).length;
  const initCount=scripts.filter(s=>s&&s.includes('sokoni-init.js')).length;
  const firebaseCount=scripts.filter(s=>s&&s.includes('firebase.js')).length;
  const sharedCount=scripts.filter(s=>s&&s.includes('shared-header.js')).length;
  console.log(file, 'auth', authCount, 'init', initCount, 'firebase', firebaseCount, 'shared', sharedCount);
  console.log('ORDER', scripts.map(s=>s||'[inline]').join(' | '));
}
