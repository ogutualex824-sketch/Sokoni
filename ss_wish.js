const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    args: ['--disable-remote-fonts', '--no-sandbox', '--blink-settings=imagesEnabled=true']
  });
  const ctx = await browser.newContext({
    viewport:{ width:390, height:844 },
    deviceScaleFactor:2,
    userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'
  });
  const page = await ctx.newPage();
  page.setDefaultTimeout(20000);
  await ctx.addInitScript(() => {
    const items = [
      { id:"F1", name:"Samsung Galaxy A55 5G", price:52000, category:"electronics", image:"https://images.unsplash.com/photo-1511707171634-5f897ff02aa9?w=400&q=70", savedAt: new Date().toISOString(), savedPrice: 52000 },
      { id:"F2", name:"Vitenge Flare Dress", price:3200, category:"fashion", image:"https://images.unsplash.com/photo-1515372039744-b8f02a3ae446?w=400&q=70", savedAt: new Date().toISOString(), savedPrice: 3200 },
      { id:"F6", name:"Kenyan Arabica Coffee 1kg", price:1800, category:"food", image:"https://images.unsplash.com/photo-1559056199-641a0ac8b55e?w=400&q=70", savedAt: new Date().toISOString(), savedPrice: 1800 }
    ];
    localStorage.setItem('wishlist', JSON.stringify(items));
    localStorage.setItem('sokoniWelcomeSeen','1');
    localStorage.setItem('sokoniVisited','true');
    localStorage.setItem('sokoniInstallDismissed', (Date.now()+9999999).toString());
    localStorage.setItem('sokoniInstallVer','v19');
    localStorage.setItem('sokoniNotifDismissed', (Date.now()+9999999).toString());
  });

  await page.goto('http://localhost:3000/wishlist.html',{ waitUntil:'domcontentloaded', timeout:12000 });
  await page.waitForTimeout(2000);
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el=>{
      const s=window.getComputedStyle(el);
      if(s.position==='fixed' && parseInt(s.zIndex||0)>50 && el.getBoundingClientRect().height>50) el.remove();
    });
    document.body.style.overflow='auto';
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path:'ss_wish2.png', timeout:18000, animations:'disabled' });
  console.log('wish done');

  await page.goto('http://localhost:3000/index.html',{ waitUntil:'domcontentloaded', timeout:12000 });
  await page.waitForTimeout(2500);
  await page.evaluate(() => {
    document.querySelectorAll('*').forEach(el=>{
      const s=window.getComputedStyle(el);
      if(s.position==='fixed' && parseInt(s.zIndex||0)>50 && el.getBoundingClientRect().height>50) el.remove();
    });
    document.body.style.overflow='auto';
    const el=document.querySelector('.ptrend-grid, #productsContainer');
    if(el) el.scrollIntoView({behavior:'instant',block:'start'});
  });
  await page.waitForTimeout(700);
  await page.screenshot({ path:'ss_trend2.png', timeout:18000, animations:'disabled' });
  console.log('trend done');

  await browser.close();
  console.log('all done');
})().catch(e=>{ console.error(e.message); process.exit(1); });
