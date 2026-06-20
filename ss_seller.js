const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--disable-remote-fonts','--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport:{ width:390, height:844 },
    deviceScaleFactor:2,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await ctx.addInitScript(() => {
    localStorage.setItem('sokoniVisited','true');
    localStorage.setItem('sokoniInstallDismissed',(Date.now()+9999999).toString());
    localStorage.setItem('sokoniInstallVer','v19');
    localStorage.setItem('sokoniNotifDismissed',(Date.now()+9999999).toString());
  });
  await page.goto('http://localhost:3000/driver.html',{ waitUntil:'domcontentloaded', timeout:12000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el=>{
      const s=window.getComputedStyle(el);
      if(s.position==='fixed' && parseInt(s.zIndex||0)>50 && el.getBoundingClientRect().height>50) el.remove();
    });
    document.body.style.overflow='auto';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path:'ss_driver_fixed.png', timeout:10000, animations:'disabled' });
  await browser.close();
  console.log('done');
})().catch(e=>{ console.error(e.message); process.exit(1); });
