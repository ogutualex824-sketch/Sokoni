/* Per-function deployed state from the Cloud Functions v2 API. READ-ONLY.
   The deploy log was truncated and the CLI exited 0 while reporting four errors, so
   neither can establish which functions actually carry the new revision. This asks
   Google directly: updateTime, state, and the revision the service is serving. */
const path = require('path');
const ADMIN = path.join('C:/temp/sok-release-admin', 'functions', 'node_modules');
const { GoogleAuth } = require(path.join(ADMIN, 'google-auth-library'));

const PROJECT = 'sokoni-aeb26';
const REGION = 'us-central1';

const TARGETS = [
  ['onOrderStatusChange',      '76436b1  calls settleOrder'],
  ['getPlatformHealthScores',  'f4422b4  index fix + attribution'],
  ['getTopBusinessPriorities', 'f4422b4  same funnelStats defect'],
  ['onPackageRequestChanged',  '0e108d4  NEW trigger'],
  /* the four the CLI reported as failed — their state matters for the retry decision */
  ['accountDeactivate',        'REPORTED FAILED (update)'],
  ['getTypesenseSearchKey',    'REPORTED FAILED (update)'],
  ['emailSubscriptionReminders', 'REPORTED FAILED (set invoker)'],
  ['searchQueueCoordinator',   'REPORTED FAILED (set invoker)'],
];

(async () => {
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const client = await auth.getClient();
  const token = (await client.getAccessToken()).token;

  const rows = [];
  for (const [id, why] of TARGETS) {
    const url = `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/functions/${id}`;
    let r;
    try {
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (!res.ok) { rows.push({ id, why, err: res.status + ' ' + res.statusText }); continue; }
      r = await res.json();
    } catch (e) { rows.push({ id, why, err: e.message }); continue; }
    rows.push({
      id, why,
      state: r.state,
      updateTime: r.updateTime,
      revision: (r.serviceConfig && r.serviceConfig.revision) || null,
    });
  }

  const times = rows.filter(r => r.updateTime).map(r => Date.parse(r.updateTime)).sort((a, b) => b - a);
  console.log('\n  PER-FUNCTION DEPLOYED STATE  (Cloud Functions v2 API)\n');
  const w = 28;
  for (const r of rows) {
    if (r.err) { console.log('  ERROR    ' + r.id.padEnd(w) + r.err + '   ' + r.why); continue; }
    console.log('  ' + String(r.state || '?').padEnd(8) + ' ' + r.id.padEnd(w)
      + (r.updateTime || '(no updateTime)') + '   ' + r.why);
  }
  if (times.length) {
    console.log('\n  newest updateTime across targets: ' + new Date(times[0]).toISOString());
    console.log('  oldest updateTime across targets: ' + new Date(times[times.length - 1]).toISOString());
  }
  console.log('\n  updateTime is the evidence that a function carries THIS release.');
  console.log('  ACTIVE state alone only means the previous revision is still serving.\n');
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
