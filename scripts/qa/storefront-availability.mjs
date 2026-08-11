/**
 * Storefront availability + calendar QA.
 *
 * The response is mocked at the network layer so each availability state can be
 * driven deterministically — including the ones that need a seller to flip a
 * switch or a date to arrive. What is being tested is that the page RENDERS the
 * server's decision and never re-derives it, so the fixtures are the contract:
 * the page is given a reason and must show the matching label.
 */

const SCHEDULE = {
  hours: {
    mon: { closed: false, periods: [{ open: '08:00', close: '17:00' }] },
    tue: { closed: false, periods: [{ open: '08:00', close: '12:00' }, { open: '13:00', close: '17:00' }] },
    wed: { closed: false, periods: [{ open: '08:00', close: '17:00' }] },
    thu: { closed: false, periods: [{ open: '08:00', close: '17:00' }] },
    fri: { closed: false, periods: [{ open: '08:00', close: '17:00' }] },
    sat: { closed: false, periods: [{ open: '09:00', close: '13:00' }] },
    sun: { closed: true, periods: [] },
  },
  overrides: null,
};

function payload(availability, schedule) {
  return {
    shop: { id: 'qa-shop', name: 'QA Shop', category: 'grocery', description: 'QA' },
    config: { tagline: 'QA tagline' },
    products: [], reviews: [], totalProducts: 0, followerCount: 0,
    availability, schedule,
  };
}

const CASES = [
  { name: 'open within hours',
    av: { open: true,  reason: 'within_hours', delivery: true,  pickup: true,  acceptingOrders: true },
    sched: SCHEDULE, expectLabel: 'Open', expectCls: 'open', expectHours: true, expectFulfil: true },

  { name: 'seller switched offline',
    av: { open: false, reason: 'offline', delivery: true, pickup: true, acceptingOrders: false },
    sched: SCHEDULE, expectLabel: 'Temporarily unavailable', expectCls: 'unavailable',
    expectHours: true, expectFulfil: false },

  { name: 'closed by timetable',
    av: { open: false, reason: 'outside_hours', delivery: true, pickup: false, acceptingOrders: true },
    sched: SCHEDULE, expectLabel: 'Closed', expectCls: 'closed', expectHours: true, expectFulfil: false },

  { name: 'special closure override',
    av: { open: false, reason: 'closed_today', delivery: false, pickup: false, acceptingOrders: true },
    sched: Object.assign({}, SCHEDULE, {
      overrides: { [new Date(Date.now() + 180 * 60000).toISOString().slice(0, 10)]: { closed: true } },
    }),
    expectLabel: 'Closed today', expectCls: 'closed', expectHours: true, expectFulfil: false,
    expectOverride: true },

  { name: 'availability unresolved → neutral, never guessed',
    av: null, sched: null,
    expectHidden: true, expectHours: false },

  { name: 'open but no timetable → badge shows, calendar stays hidden',
    av: { open: true, reason: 'no_schedule', delivery: false, pickup: true, acceptingOrders: true },
    sched: { hours: null, overrides: null },
    expectLabel: 'Open', expectCls: 'open', expectHours: false, expectFulfil: true },
];

export default async function run(page) {
  const results = [];

  /* The storefront registers a service worker (via shared-header.js). Once it takes
     control it serves fetches itself, which bypasses page.route entirely — so the
     first case saw the mock and every later one hit the real network and got a 404.
     Neutralise registration, and clear any worker that already claimed this origin. */
  await page.context().addInitScript(() => {
    try {
      if (navigator.serviceWorker) {
        navigator.serviceWorker.register = () => Promise.resolve({
          update() {}, unregister() { return Promise.resolve(true); },
        });
      }
    } catch (_) { /* nothing to stub */ }
  });
  await page.goto('http://localhost:3111/minishop.html', { waitUntil: 'domcontentloaded' });
  await page.evaluate(async () => {
    if (!navigator.serviceWorker || !navigator.serviceWorker.getRegistrations) return;
    for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  });

  for (const c of CASES) {
    await page.route('**/getMinishopPublic*', route =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: JSON.stringify(payload(c.av, c.sched)),
      }));

    await page.goto('http://localhost:3111/minishop.html?handle=qa', { waitUntil: 'domcontentloaded' });
    /* Wait for the shop name to land so we are reading a rendered page, not an
       empty one that would pass a "badge hidden" assertion for the wrong reason. */
    await page.waitForFunction(
      () => (document.getElementById('msShopName') || {}).textContent === 'QA Shop',
      { timeout: 15000 }).catch(() => {});

    const got = await page.evaluate(() => {
      const os = document.getElementById('msOpenStatus');
      const fu = document.getElementById('msFulfilment');
      const hr = document.getElementById('msHours');
      const ov = document.getElementById('msHoursOverride');
      const rows = [...document.querySelectorAll('#msHoursBody .ms-hours-row')]
        .map(r => r.textContent.trim().replace(/\s+/g, ' '));
      return {
        shopName: (document.getElementById('msShopName') || {}).textContent,
        notFound: /Shop Not Found/i.test(document.body.innerText || ''),
        badgeHidden: !os || os.hidden,
        label: os ? os.textContent.trim() : null,
        cls: os ? os.className.replace('ms-open-status', '').trim() : null,
        fulfilHidden: !fu || fu.hidden,
        fulfilText: fu ? fu.textContent.trim() : null,
        hoursHidden: !hr || hr.hidden,
        overrideHidden: !ov || ov.hidden,
        overrideText: ov ? ov.textContent.trim() : null,
        rowCount: rows.length,
        todayRows: [...document.querySelectorAll('#msHoursBody .ms-hours-row.is-today')].length,
        sampleRows: rows.slice(0, 3),
      };
    });

    const fails = [];
    if (c.expectHidden) {
      if (!got.badgeHidden) fails.push('badge should be hidden when availability is null, got "' + got.label + '"');
    } else {
      if (got.badgeHidden) fails.push('badge hidden but expected "' + c.expectLabel + '"');
      if (got.label !== c.expectLabel) fails.push('label "' + got.label + '" != "' + c.expectLabel + '"');
      if (got.cls !== c.expectCls) fails.push('class "' + got.cls + '" != "' + c.expectCls + '"');
    }
    if (got.hoursHidden === c.expectHours) {
      fails.push('hours ' + (got.hoursHidden ? 'hidden' : 'shown') + ' but expected the opposite');
    }
    if (c.expectHours && got.rowCount !== 7) fails.push('expected 7 day rows, got ' + got.rowCount);
    if (c.expectHours && got.todayRows !== 1) fails.push('expected exactly 1 today row, got ' + got.todayRows);
    if (c.expectFulfil !== undefined && got.fulfilHidden === c.expectFulfil) {
      fails.push('fulfilment ' + (got.fulfilHidden ? 'hidden' : 'shown') + ' but expected the opposite');
    }
    if (c.expectOverride && got.overrideHidden) fails.push('override notice missing');

    results.push({ case: c.name, pass: fails.length === 0, fails, got });
    await page.unroute('**/getMinishopPublic*');
  }

  return {
    passed: results.filter(r => r.pass).length,
    failed: results.filter(r => !r.pass).length,
    results,
  };
}
