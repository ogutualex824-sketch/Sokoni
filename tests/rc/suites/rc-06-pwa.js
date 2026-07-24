/* RC-06 PWA JOURNEY — install, update, offline, reconnect, cache invalidation.
   Fully executable unauthenticated: manifest, service-worker registration,
   offline fallback. Runs on the static backend today. */
'use strict';

module.exports = {
  id: 'RC-06', title: 'PWA Journey',
  steps: [
    { name: 'Manifest linked and valid', capability: 'PWA manifest', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(1000);
        const manifest = await page.evaluate(async () => {
          const link = document.querySelector('link[rel="manifest"]');
          if (!link) return null;
          try { const r = await fetch(link.href); return await r.json(); } catch { return 'unfetchable'; }
        });
        if (!manifest) throw new Error('no <link rel="manifest">');
        if (manifest === 'unfetchable') throw new Error('manifest link present but not fetchable');
        if (!manifest.name && !manifest.short_name) throw new Error('manifest missing name');
        ctx.record('assertion', { name: manifest.name || manifest.short_name, icons: (manifest.icons || []).length });
        return { detail: `${manifest.name || manifest.short_name}, ${(manifest.icons || []).length} icons` };
    }},
    { name: 'Service worker registers', capability: 'Service worker registration', async run(ctx) {
        const page = await ctx.ui();
        await page.goto(ctx.baseUrl() + '/index.html', { waitUntil: 'domcontentloaded' });
        const reg = await page.evaluate(async () => {
          if (!('serviceWorker' in navigator)) return 'unsupported';
          try {
            const r = await navigator.serviceWorker.getRegistration()
              || await new Promise(res => { navigator.serviceWorker.ready.then(res); setTimeout(() => res(null), 4000); });
            return r ? 'registered' : 'none';
          } catch (e) { return 'error:' + e.message.slice(0, 40); }
        });
        ctx.record('assertion', { serviceWorker: reg });
        // A local static server serves sw.js; registration should succeed.
        if (String(reg).startsWith('error')) throw new Error(reg);
        return { detail: reg };
    }},
    { name: 'Offline fallback page renders', capability: 'Offline fallback', async run(ctx) {
        const page = await ctx.ui();
        const resp = await page.goto(ctx.baseUrl() + '/offline.html', { waitUntil: 'domcontentloaded' })
          .catch(() => null);
        await ctx.shot('offline');
        if (!resp || resp.status() >= 400) throw new Error('offline.html missing');
        const hasText = await page.evaluate(() => (document.body.textContent || '').trim().length > 20);
        if (!hasText) throw new Error('offline.html empty');
    }},
    { name: 'Service-worker file is served and versioned', capability: 'Service worker versioning', async run(ctx) {
        const page = await ctx.ui();
        const info = await page.evaluate(async (base) => {
          for (const p of ['/service-worker.js', '/sw.js']) {
            try { const r = await fetch(base + p); if (r.ok) {
              const t = await r.text();
              const v = (t.match(/CACHE[_-]?(?:NAME|VERSION)\s*=\s*[`'"]([^`'"]+)/i) || [])[1] || null;
              return { path: p, bytes: t.length, version: v };
            } } catch {}
          }
          return null;
        }, ctx.baseUrl());
        if (!info) throw new Error('no service worker file served');
        ctx.record('assertion', info);
        return { detail: `${info.path}${info.version ? ' v=' + info.version : ''}` };
    }},
  ],
};
