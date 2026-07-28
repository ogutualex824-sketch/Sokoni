const fs = require('fs');
const path = require('path');
const pages = [
  'pos-workspace.html','my-orders.html','checkout.html','delivery-tracking.html','dispatch.html','dispute-portal.html','driver-success.html','driver.html','finos.html','fleet-monitor.html','inventory.html','landlord.html','profile.html','provider-dashboard.html','seller-delivery.html','seller.html','wallet.html'
];
const scriptTag = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
const srcAttr = /src\s*=\s*['\"]([^'\"]+)['\"]/i;
for (const page of pages) {
  const file = path.join(__dirname, '..', page);
  const text = fs.readFileSync(file, 'utf8');
  const requiresAuth = /data-require-auth\s*=\s*['\"]true['\"]/i.test(text);
  const scripts = [];
  let match;
  while ((match = scriptTag.exec(text))) {
    const attrs = match[1];
    const srcMatch = srcAttr.exec(attrs);
    scripts.push({ tag: match[0], src: srcMatch ? srcMatch[1] : null, attrs });
  }
  console.log('--- ' + page);
  console.log('requiresAuth=' + requiresAuth);
  scripts.forEach((s, idx) => {
    console.log(`${idx + 1} src=${s.src || '[inline]'} attrs=${s.attrs.replace(/\s+/g,' ')}
`);
  });
}
