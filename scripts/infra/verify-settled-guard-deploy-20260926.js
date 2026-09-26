'use strict';
/* READ-ONLY post-deploy verification for the double-credit guard deploy (2026-09-26).
   Every check is a describe/list/download. Prints PASS/FAIL per assertion; exit 1 on any FAIL. */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const P = 'sokoni-aeb26', R = 'us-central1';
/* The deploy directory holds baseline/ (pre-deploy describes — they contain env VALUES, so they are
   never committed) and functions/ (the patched tree). Default: where the 2026-09-26 deploy ran. */
const ROOT = process.env.DEPLOY_DIR || 'C:/temp/sok-dc-deploy';
const B = path.join(ROOT, 'baseline');
const OUT = path.join(ROOT, 'verify');
fs.mkdirSync(OUT, { recursive: true });
const sh = (c) => execSync(c, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, env: process.env });
const j = (c) => JSON.parse(sh(c));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('PASS', m); } else { fail++; console.log('FAIL', m); } };
const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === 'object' && !Array.isArray(v))
  ? Object.keys(v).sort().reduce((a, x) => (a[x] = v[x], a), {}) : v);
const ann = (rev, k) => ((rev.metadata || {}).annotations || {})[k];

const TARGETS = [
  { fn: 'onOrderStatusChange', svc: 'onorderstatuschange', oldRev: 'onorderstatuschange-00062-yoz', stuck: 'onorderstatuschange-00063-8sk', min: '1', max: '99' },
  { fn: 'expireOldEscrows', svc: 'expireoldescrows', oldRev: 'expireoldescrows-00032-gul', stuck: null, min: undefined, max: '99' },
];
const PATCHED = { 'order-settlement.js': path.join(ROOT, 'functions', 'order-settlement.js'),
                  'index.js': path.join(ROOT, 'functions', 'index.js') };

for (const t of TARGETS) {
  console.log(`\n== ${t.fn}`);
  const preFn = require(path.join(B, `${t.fn}.fn.json`));
  const preRun = require(path.join(B, `${t.svc}.run.json`));
  const fn = j(`gcloud functions describe ${t.fn} --gen2 --region ${R} --project ${P} --format=json`);
  const run = j(`gcloud run services describe ${t.svc} --region ${R} --project ${P} --format=json`);
  fs.writeFileSync(path.join(OUT, `${t.fn}.fn.json`), JSON.stringify(fn, null, 1));
  const st = run.status || {};
  const ready = (st.conditions || []).find((c) => c.type === 'Ready') || {};
  const newRev = st.latestReadyRevisionName;

  /* 1 */ ok(newRev && newRev !== t.oldRev && ready.status === 'True' && st.latestCreatedRevisionName === newRev,
    `[1] new revision ${newRev} Ready=True and latestCreated==latestReady`);
  const traffic = (st.traffic || []).filter((x) => x.percent === 100);
  /* 2 */ ok(traffic.length === 1 && (traffic[0].revisionName === newRev || traffic[0].latestRevision === true),
    `[2] 100% traffic on ${newRev}`);
  const rev = j(`gcloud run revisions describe ${newRev} --region ${R} --project ${P} --format=json`);
  const minS = ann(rev, 'autoscaling.knative.dev/minScale'), maxS = ann(rev, 'autoscaling.knative.dev/maxScale');
  /* 3 */ ok(String(minS || '') === String(t.min || '') && String(maxS) === t.max,
    `[3] scaling-neutral: minScale=${minS || '(blank)'} maxScale=${maxS} (want ${t.min || '(blank)'} / ${t.max})`);
  const image = rev.spec.containers[0].image;
  const digest = (rev.status && rev.status.imageDigest) || image;
  let present = false;
  try { sh(`gcloud artifacts docker images describe "${digest}" --project ${P} --format=json`); present = true; } catch (_) {}
  /* 4 */ ok(present, `[4] serving image present in Artifact Registry: ${digest}`);
  /* 5 */ if (t.stuck) ok(st.latestCreatedRevisionName !== t.stuck, `[5] stuck ${t.stuck} is no longer latestCreatedRevisionName`);
  /* 6 — eventFilters is compared as a SET, and only that. OBSERVED 2026-09-26: two describes of
     the same, unchanged function returned the three filters in different orders (run 1 PASS,
     run 2 FAIL on order alone), so the API's array order is not part of the trigger contract.
     Every other field, and every filter's content, must still match exactly. */
  const trig = (e) => e ? Object.assign({}, e, { eventFilters: (e.eventFilters || []).map(canon).sort() }) : null;
  ok(canon(trig(fn.eventTrigger)) === canon(trig(preFn.eventTrigger)),
    `[6] eventTrigger structurally identical pre vs post (eventFilters as a set)`);
  const sc = fn.serviceConfig || {}, psc = preFn.serviceConfig || {};
  for (const k of ['availableMemory', 'availableCpu', 'timeoutSeconds', 'maxInstanceRequestConcurrency', 'ingressSettings', 'serviceAccountEmail']) {
    /* 7 */ ok(canon(sc[k]) === canon(psc[k]), `[7] ${k} unchanged (${psc[k]} -> ${sc[k]})`);
  }
  ok(canon(sc.environmentVariables ? Object.keys(sc.environmentVariables).filter((k) => !/^(LOG_EXECUTION_ID|EVENTARC_CLOUD_EVENT_SOURCE)$/.test(k)).sort().reduce((a, k) => (a[k] = sc.environmentVariables[k], a), {}) : {}) ===
     canon(psc.environmentVariables ? Object.keys(psc.environmentVariables).filter((k) => !/^(LOG_EXECUTION_ID|EVENTARC_CLOUD_EVENT_SOURCE)$/.test(k)).sort().reduce((a, k) => (a[k] = psc.environmentVariables[k], a), {}) : {}),
     '[env] environment variables identical (values compared, never printed)');
  ok(canon((sc.secretEnvironmentVariables || []).map((s) => s.key + ':' + s.secret).sort()) ===
     canon((psc.secretEnvironmentVariables || []).map((s) => s.key + ':' + s.secret).sort()), '[env] secret bindings identical');

  /* PROVENANCE: serving revision -> build -> source archive -> the bytes we patched */
  const src = fn.buildConfig.source.storageSource;
  const zip = path.join(OUT, `${t.fn}.zip`), dir = path.join(OUT, t.fn);
  sh(`gcloud storage cp "gs://${src.bucket}/${src.object}#${src.generation}" "${zip}"`);
  fs.rmSync(dir, { recursive: true, force: true });
  sh(`unzip -q -o "${zip}" -d "${dir}"`);
  ok(src.generation !== preFn.buildConfig.source.storageSource.generation, `[prov] new source generation ${src.generation}`);
  for (const [f, local] of Object.entries(PATCHED)) {
    ok(sha(path.join(dir, f)) === sha(local), `[prov] deployed ${f} is byte-identical to the patched deploy tree`);
  }
  ok(/isAlreadySettled\(st\)/.test(fs.readFileSync(path.join(dir, 'order-settlement.js'), 'utf8')), '[prov] deployed settleOrder uses isAlreadySettled');
  const build = fn.buildConfig.build;
  let bj = null;
  try { bj = j(`gcloud builds describe ${build.split('/').pop()} --region ${R} --project ${P} --format=json`); } catch (e) { console.log('   (build describe failed:', e.message.split('\n')[0], ')'); }
  if (bj) {
    /* GCF builds carry NO build.source and NO results.images: the archive arrives through the
       _GOOGLE_LABEL_SOURCE substitution and buildpacks push the image by tag. Assert on the fields
       GCF actually writes, or the check cannot pass even when the chain is intact. */
    const label = String((bj.substitutions || {})._GOOGLE_LABEL_SOURCE || '');
    const m = /\/([^/]+)\/function-source\.zip#(\d+)$/.exec(label);
    const labelOk = label === `gs://${src.bucket}/${src.object}#${src.generation}`;
    let twinOk = false;
    if (!labelOk && m && m[1] !== t.fn) {   /* a codebase build reused for a byte-identical twin archive */
      const twinZip = path.join(OUT, m[1] + '.zip');
      const twinFn = path.join(OUT, m[1] + '.fn.json');
      twinOk = fs.existsSync(twinZip) && fs.existsSync(twinFn) && sha(twinZip) === sha(zip) &&
        JSON.parse(fs.readFileSync(twinFn, 'utf8')).buildConfig.source.storageSource.generation === m[2];
    }
    ok(bj.status === 'SUCCESS' && (labelOk || twinOk),
      `[prov] build ${bj.id} SUCCESS, fed ${labelOk ? 'exactly this archive' : 'a byte-identical twin archive'} (${label})`);
    const pkg = image.split('@')[0].split(':')[0];
    const tags = j(`gcloud artifacts docker images list ${pkg} --include-tags --project ${P} --format=json`);
    const servingDigest = String(digest).split('@')[1];
    const row = tags.find((x) => x.version === servingDigest) || {};
    const up = Date.parse(row.createTime || row.updateTime || 0);
    const b0 = Date.parse(bj.startTime || bj.createTime), b1 = Date.parse(bj.finishTime);
    ok(/version_1/.test(String(row.tags || '')) && up >= b0 - 1000 && up <= b1 + 1000,
      `[prov] serving digest ${String(servingDigest).slice(0, 19)} is version_1, uploaded ${row.createTime} inside build window`);
  } else { ok(false, '[prov] build readable'); }
}

console.log('\n== estate');
const n = sh(`gcloud functions list --v2 --project ${P} --format="value(name)"`).split(/\r?\n/).filter(Boolean).length;
/* 8 */ ok(n === 1723, `[8] function count exactly 1723 (got ${n})`);
const ctl = j(`gcloud run services describe profilegetpublicprofile --region ${R} --project ${P} --format=json`);
const cst = ctl.status || {};
const crd = (cst.conditions || []).find((c) => c.type === 'Ready') || {};
const ctlRev = j(`gcloud run revisions describe profilegetpublicprofile-00007-xaz --region ${R} --project ${P} --format=json`);
let ctlImg = false;
try { sh(`gcloud artifacts docker images describe "${ctlRev.status.imageDigest}" --project ${P} --format=json`); ctlImg = true; } catch (_) {}
/* 9 */ ok(crd.status === 'True' && (cst.traffic || []).some((x) => x.percent === 100 && (x.revisionName === 'profilegetpublicprofile-00007-xaz' || cst.latestReadyRevisionName === 'profilegetpublicprofile-00007-xaz'))
  && !ann(ctlRev, 'autoscaling.knative.dev/minScale') && ctlImg, '[9] control profilegetpublicprofile-00007-xaz Ready, 100%, minScale blank, image present');
const T = require(path.join(B, 'onOrderStatusChange.fn.json')).eventTrigger.trigger;
const ea = j(`gcloud eventarc triggers describe ${T.split('/').pop()} --location nam5 --project ${P} --format=json`);
const pea = require(path.join(B, 'eventarc.json'));
/* eventFilters as a SET — same observed API order instability as assertion 6 (run 2 PASS, run 3
   FAIL on order alone, run 4 read byte-identical to baseline). Everything else compared exactly. */
const strip = (o) => { const c = Object.assign({}, o); delete c.updateTime; delete c.etag;
  c.eventFilters = (c.eventFilters || []).map(canon).sort(); return c; };
ok(canon(strip(ea)) === canon(strip(pea)), '[6b] Eventarc trigger identical (excluding updateTime/etag)');
const sj = j(`gcloud scheduler jobs describe firebase-schedule-expireOldEscrows-us-central1 --location ${R} --project ${P} --format=json`);
const psj = require(path.join(B, 'scheduler.json'));
ok(sj.schedule === psj.schedule && sj.state === psj.state && canon(sj.httpTarget && sj.httpTarget.uri) === canon(psj.httpTarget && psj.httpTarget.uri),
  `[sched] scheduler job unchanged (${sj.schedule}, ${sj.state})`);

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail ? 1 : 0);
