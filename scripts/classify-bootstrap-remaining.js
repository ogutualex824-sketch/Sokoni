const fs = require('fs');
const path = require('path');
const pages = [
  'pos-workspace.html','my-orders.html','checkout.html','delivery-tracking.html','dispatch.html','dispute-portal.html','driver-success.html','driver.html','finos.html','fleet-monitor.html','inventory.html','landlord.html','profile.html','provider-dashboard.html','seller-delivery.html','seller.html','wallet.html'
];
const scriptTag = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
const srcAttr = /src\s*=\s*['\"]([^'\"]+)['\"]/i;
const firebasePattern = /(?:firebase\.js$|firebase-app-compat\.js$|firebase-auth-compat\.js$|firebase-functions-compat\.js$|firebase-app-check-compat\.js$)/;
for (const page of pages) {
  const file = path.join(__dirname, '..', page);
  const text = fs.readFileSync(file, 'utf8');
  const scripts = [];
  let match;
  while ((match = scriptTag.exec(text))) {
    const attrs = match[1];
    const srcMatch = srcAttr.exec(attrs);
    const src = srcMatch ? srcMatch[1] : null;
    scripts.push({ src, attrs, index: scripts.length + 1 });
  }
  const authIndex = scripts.findIndex(s => s.src && /auth-guard\.js$/.test(s.src));
  const sharedIndex = scripts.findIndex(s => s.src && /shared-header\.js$/.test(s.src));
  const initIndex = scripts.findIndex(s => s.src && /sokoni-init\.js$/.test(s.src));
  const firebaseScripts = scripts.filter(s => s.src && firebasePattern.test(s.src));
  const otherModules = scripts.filter(s => s.src && s.attrs.includes('type="module"') && !/firebase\.js$/.test(s.src));
  const hasDirectFirebase = firebaseScripts.some(s => /firebase\.js$/.test(s.src));
  const hasCompat = firebaseScripts.some(s => /compat/.test(s.src));
  const result = {
    page,
    authIndex: authIndex + 1 || null,
    sharedIndex: sharedIndex + 1 || null,
    initIndex: initIndex + 1 || null,
    firebaseScripts: firebaseScripts.map(s => ({ src: s.src, index: s.index })),
    hasDirectFirebase,
    hasCompat,
    scripts: scripts.map(s => ({ index: s.index, src: s.src, attrs: s.attrs.replace(/\s+/g, ' ') }))
  };
  console.log(JSON.stringify(result, null, 2));
}
