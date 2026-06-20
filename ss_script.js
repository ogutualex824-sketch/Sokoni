const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ args: ['--disable-web-security', '--no-sandbox'] });
  const ctx = await browser.newContext({
    viewport:{ width:390, height:844 },
    deviceScaleFactor:2,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await ctx.addInitScript(() => {
    localStorage.setItem('sokoniWelcomeSeen','1');
    localStorage.setItem('sokoniPWADismissed','1');
    localStorage.setItem('sokoniDemoSeeded','6');
    localStorage.setItem('sokoniInstallDismissed', (Date.now()+9999999).toString());
    localStorage.setItem('sokoniInstallVer','v19');
    localStorage.setItem('sokoniNotifDismissed', (Date.now()+9999999).toString());
  });
  await page.goto('http://localhost:3000/index.html',{ waitUntil:'domcontentloaded', timeout:15000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el=>{
      const s=window.getComputedStyle(el);
      const z=parseInt(s.zIndex||0,10);
      if(s.position==='fixed' && z>50 && el.getBoundingClientRect().height > 50) {
        el.remove();
      }
    });
    document.body.style.overflow='auto';
    document.documentElement.style.overflow='auto';
  });
  await page.waitForTimeout(300);
  await page.evaluate(()=>{
    const el=document.querySelector('.ptrend-grid, #productsContainer');
    if(el) el.scrollIntoView({behavior:'instant',block:'start'});
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path:'ss_cards2.png', timeout: 10000 });
  await page.evaluate(()=>{
    const el=document.querySelector('.ptrend-view-all-row');
    if(el) el.scrollIntoView({behavior:'instant',block:'center'});
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path:'ss_viewall2.png', timeout: 10000 });
  await browser.close();
  console.log('ok');
})().catch(e=>{ console.error(e.message); process.exit(1); });
