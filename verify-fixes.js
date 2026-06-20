const { chromium } = require('playwright');

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext();
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));

  const results = [];
  function pass(label) { results.push('  ✅ ' + label); }
  function fail(label, detail) { results.push('  ❌ ' + label + (detail ? ': ' + detail : '')); }

  /* ── 1. Sports Hub — no scheduleGame JS error ── */
  errs.length = 0;
  await p.goto('https://sokoni-aeb26.web.app/sports-hub.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await p.waitForTimeout(3000);
  const sgErrs = errs.filter(e => e.includes('scheduleGame'));
  if (sgErrs.length === 0) pass('Sports Hub: no scheduleGame error');
  else fail('Sports Hub: scheduleGame JS error', sgErrs[0]);

  /* ── 2. Sports Hub — fixture functions exposed ── */
  const hasFx = await p.evaluate(() => typeof window.generateFixtures === 'function');
  const hasDetail = await p.evaluate(() => typeof window.showTourneyDetail === 'function');
  const hasRecord = await p.evaluate(() => typeof window.recordMatchResult === 'function');
  if (hasFx && hasDetail && hasRecord) pass('Sports Hub: fixture functions exposed');
  else fail('Sports Hub: missing functions', (!hasFx?'generateFixtures ':'')+(!hasDetail?'showTourneyDetail ':'')+(!hasRecord?'recordMatchResult':''));

  /* ── 3. Track.html — hooks exposed ── */
  errs.length = 0;
  await p.goto('https://sokoni-aeb26.web.app/track.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await p.waitForTimeout(2000);
  const hasUOS = await p.evaluate(() => typeof window.updateOrderStatus === 'function');
  const hasUDM = await p.evaluate(() => typeof window.updateDriverMarker === 'function');
  if (hasUOS) pass('track.html: updateOrderStatus exposed');
  else fail('track.html: updateOrderStatus missing');
  if (hasUDM) pass('track.html: updateDriverMarker exposed');
  else fail('track.html: updateDriverMarker missing');

  /* ── 4. Wallet — Withdraw tab & panel ── */
  await p.goto('https://sokoni-aeb26.web.app/wallet.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await p.waitForTimeout(1500);
  const hasWdTab = await p.evaluate(() => !!document.querySelector('[onclick*="withdraw"]'));
  const hasWdPanel = await p.evaluate(() => !!document.getElementById('wlpanel-withdraw'));
  const hasWithdrawFn = await p.evaluate(() => typeof window.withdrawFunds === 'function');
  if (hasWdTab) pass('Wallet: Withdraw tab present');
  else fail('Wallet: Withdraw tab missing');
  if (hasWdPanel) pass('Wallet: Withdraw panel present');
  else fail('Wallet: Withdraw panel missing');
  if (hasWithdrawFn) pass('Wallet: withdrawFunds() exposed');
  else fail('Wallet: withdrawFunds() missing');

  /* ── 5. Foundation — Firestore addDoc wired ── */
  await p.goto('https://sokoni-aeb26.web.app/foundation.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await p.waitForTimeout(1500);
  const fnSrc = await p.evaluate(() => window.submitApplication ? window.submitApplication.toString() : '');
  if (fnSrc.includes('addDoc')) pass('Foundation: addDoc (Firestore write) wired');
  else fail('Foundation: Firestore write missing');

  /* ── 6. Profile — Firestore bookings listener wired ── */
  await p.goto('https://sokoni-aeb26.web.app/profile.html', { waitUntil: 'domcontentloaded', timeout: 25000 });
  await p.waitForTimeout(2500);
  const profileBody = await p.evaluate(() => document.body.innerHTML);
  if (profileBody.includes('onSnapshot') || profileBody.includes('sokoniAuthReady')) {
    pass('Profile: Firestore bookings listener script present');
  } else {
    // Try checking source
    const src = await p.evaluate(() => Array.from(document.scripts).map(s => s.textContent).join(' '));
    if (src.includes('onSnapshot')) pass('Profile: Firestore bookings listener wired');
    else fail('Profile: Firestore listener not found in page');
  }

  await b.close();

  console.log('\n📋 Verification Results:');
  results.forEach(r => console.log(r));
  const failed = results.filter(r => r.includes('❌'));
  console.log('\n' + (failed.length === 0 ? '✅ All checks passed!' : '⚠️ ' + failed.length + ' check(s) failed'));
})();
