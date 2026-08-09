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

const pageData = invalidPages.map(file => {
  const text = fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const scripts=[];
  let m;
  while ((m = scriptRegex.exec(text))) {
    const attrs = m[1];
    const srcMatch = srcRegex.exec(attrs);
    scripts.push(srcMatch ? srcMatch[1] : null);
  }
  const auth = scripts.findIndex(s=>s&&/auth-guard\.js$/.test(s));
  const init = scripts.findIndex(s=>s&&/sokoni-init\.js$/.test(s));
  const shared = scripts.findIndex(s=>s&&/shared-header\.js$/.test(s));
  const firebase = scripts.filter(s=>s&&(/firebase\.js$/.test(s) || /firebase-app-compat\.js$/.test(s) || /firebase-auth-compat\.js$/.test(s) || /firebase-functions-compat\.js$/.test(s) || /firebase-app-check-compat\.js$/.test(s)));
  return { file, auth, init, shared, firebase, scriptOrder: scripts };
});
const hasFirebase = pageData.filter(p=>p.firebase.length>0);
const hasInit = pageData.filter(p=>p.init>=0 && p.firebase.length===0);
const missingInit = pageData.filter(p=>p.init<0 && p.firebase.length===0);
console.log('TOTAL', pageData.length);
console.log('HAS FIREBASE', hasFirebase.length, hasFirebase.map(p=>p.file).join(', '));
console.log('HAS INIT', hasInit.length, hasInit.map(p=>p.file).join(', '));
console.log('MISSING INIT', missingInit.length, missingInit.map(p=>p.file).join(', '));
