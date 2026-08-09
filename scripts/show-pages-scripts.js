const fs = require('fs');
const path = require('path');
const pages = [
  'pos-workspace.html', 'my-orders.html', 'checkout.html', 'delivery-tracking.html', 'dispatch.html', 'dispute-portal.html',
  'driver-success.html', 'driver.html', 'finos.html', 'fleet-monitor.html', 'inventory.html', 'landlord.html',
  'profile.html', 'provider-dashboard.html', 'seller-delivery.html', 'seller.html', 'wallet.html'
];
const scriptRegex = /<script\s+([^>]*?)>([\s\S]*?)<\/script>/gi;
for (const page of pages) {
  const file = path.join(__dirname, '..', page);
  const text = fs.readFileSync(file, 'utf8');
  console.log('---', page);
  let m;
  let i = 0;
  while ((m = scriptRegex.exec(text))) {
    i++;
    const attrs = m[1];
    console.log(i, attrs.trim());
  }
}
