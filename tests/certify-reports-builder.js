/* ============================================================================
   CERTIFICATION — Reports Builder
   tests/certify-reports-builder.js
   ============================================================================
   Certifies sokoni-reports-builder.js and the two consoles that mount it.

   THE DEFECT THIS SUITE EXISTS TO PREVENT
   ---------------------------------------
   `scheduledDailyOpsReport` writes **null** when a sub-query fails, so a null in
   `ops_reports` means "not measured", never "none". A builder that plots null as
   zero invents a collapse in payment success that never happened, and it invents
   it in a document an executive will act on.

   So the null path is certified in BOTH directions, which is the only way it
   means anything:

     • a null must render as a GAP / em dash and be excluded from maths
     • a genuine measured 0 must STILL render as 0

   A suite that only checked the first would pass a module that hid every zero,
   which is the same class of lie pointing the other way.

   Every absence assertion is paired with a positive control in the same render.
   The harness fails closed: a throw is a failure, a case with no assertions is a
   failure, and a run shorter than MIN_ASSERTIONS is a failure.

   RUN
     node tests/certify-reports-builder.js
   ========================================================================== */
'use strict';

const fs   = require('fs');
const path = require('path');
const vm   = require('vm');

const ROOT = path.resolve(__dirname, '..');
const MIN_ASSERTIONS = 70;

let PASS = 0, FAIL = 0, ASSERTS = 0;
const FAILURES = [];
let _caseAsserts = 0;

function ok(label, cond, detail) {
  ASSERTS++; _caseAsserts++;
  if (cond) { PASS++; return true; }
  FAIL++;
  FAILURES.push(label + (detail ? '  — ' + detail : ''));
  return false;
}

function runCase(name, fn) {
  _caseAsserts = 0;
  try { fn(); }
  catch (e) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] THREW: ' + (e && e.stack ? e.stack.split('\n')[0] : e));
    return;
  }
  if (_caseAsserts === 0) {
    ASSERTS++; FAIL++;
    FAILURES.push('[' + name + '] registered NO assertions — a silent case is a failure.');
  }
}

/* ── DOM + storage + Firestore stubs ─────────────────────────────────── */
function makeEnv(plan, storageMode) {
  const byId = {};
  const head = { appendChild(el) { if (el.id) byId[el.id] = el; } };
  const doc = {
    head,
    getElementById: (id) => byId[id] || null,
    createElement: () => ({ id: '', textContent: '' }),
  };

  let store = {};
  const localStorage = {
    getItem: (k) => {
      if (storageMode === 'throw') throw new Error('storage blocked');
      return k in store ? store[k] : null;
    },
    setItem: (k, v) => {
      if (storageMode === 'throw') throw new Error('storage blocked');
      store[k] = String(v);
    },
  };

  const firestore = {
    collection() {
      return {
        doc(id) {
          return {
            get() {
              if (plan.deny) return Promise.reject(new Error(plan.deny));
              const d = plan.docs && plan.docs[id];
              return Promise.resolve(d
                ? { exists: true, data: () => Object.assign({}, d) }
                : { exists: false, data: () => null });
            },
          };
        },
      };
    },
  };

  const sandbox = {
    window: {}, document: doc, localStorage,
    firebase: { firestore: () => firestore },
    console, setTimeout, Date, Math, Object, JSON, isFinite, parseInt,
  };
  sandbox.window.document = doc;
  sandbox.window.print = () => { sandbox.__printed = true; };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'sokoni-reports-builder.js'), 'utf8'),
                  sandbox, { filename: 'sokoni-reports-builder.js' });

  const el = { id: 'root', innerHTML: '' };
  byId.root = el;
  return { sandbox, api: sandbox.window.SokoniReports, el };
}

/** Mount and settle, then optionally drive the API, returning rendered HTML. */
function render(plan, steps, storageMode) {
  const env = makeEnv(plan, storageMode);
  env.api.mount(env.el);
  return Promise.resolve()
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => new Promise((r) => setTimeout(r, 0)))
    .then(() => { if (steps) steps(env.api, env); return env.el.innerHTML; });
}

/* ── Fixtures ────────────────────────────────────────────────────────── */
function dayId(offset) {
  const d = new Date();
  d.setDate(d.getDate() - offset);
  return d.toISOString().split('T')[0];
}

/** Build ops_reports documents from a per-day value map for one metric. */
function docsFrom(spec) {
  const docs = {};
  spec.forEach((v, i) => {
    if (v === undefined) return;            /* day absent entirely */
    docs[dayId(i)] = Object.assign({
      orders24h: 10, paidOrders24h: 8, failedPayments24h: 1,
      paymentSuccessRate: 95, emailFailed24h: 0, cspViolations24h: 0,
      openFeedback: 2, generatedAt: new Date().toISOString(),
    }, v);
  });
  return docs;
}

/* 7 days: day 2 unmeasured (null), day 4 absent entirely. */
const GAPPY = docsFrom([
  { orders24h: 10 }, { orders24h: 12 }, { orders24h: null }, { orders24h: 14 },
  undefined, { orders24h: 16 }, { orders24h: 18 },
]);

/* Same shape, fully measured — the control for every gap assertion. */
const SOLID = docsFrom([
  { orders24h: 10 }, { orders24h: 12 }, { orders24h: 13 }, { orders24h: 14 },
  { orders24h: 15 }, { orders24h: 16 }, { orders24h: 18 },
]);

/* A genuine, measured zero. Must survive as 0 — the inverting control. */
const REAL_ZERO = docsFrom([
  { orders24h: 0, failedPayments24h: 0, paymentSuccessRate: 0 },
  { orders24h: 0, failedPayments24h: 0, paymentSuccessRate: 0 },
]);

const ALL_NULL = docsFrom([
  { orders24h: null }, { orders24h: null }, { orders24h: null },
]);

(async function main() {

  const gappy = await render({ docs: GAPPY }, (a) => { a.days(7); });
  const solid = await render({ docs: SOLID }, (a) => { a.days(7); });
  const zero  = await render({ docs: REAL_ZERO }, (a) => { a.days(7); });
  const nulls = await render({ docs: ALL_NULL }, (a) => { a.days(7); });
  const denied = await render({ deny: 'PERMISSION_DENIED' });
  const emptyR = await render({ docs: {} });

  /* A table module on the gappy data, so the unmeasured-cell markup is present. */
  const await_table = await render({ docs: GAPPY }, (a) => {
    a.days(7); a.template('blank'); a.add('table');
  });

  /* 14 measured days at 7-day range: current and previous periods both have
     data, so a real delta percentage must appear. */
  const compared = await render({
    docs: docsFrom(Array.from({ length: 14 }, (_, i) => ({ orders24h: 10 + i })))
  }, (a) => { a.days(7); });

  /* Save path, both outcomes. */
  const savedOk   = await render({ docs: SOLID }, (a) => { a.save(); });
  const savedFail = await render({ docs: SOLID }, (a) => { a.save(); }, 'throw');

  const count = (h, needle) => h.split(needle).length - 1;

  /* ── A. Null is a gap. A real zero is a zero. ────────────────────── */

  runCase('A1 an unmeasured day breaks the line instead of dipping to zero', () => {
    /* POSITIVE CONTROL — a fully measured series draws ONE continuous path. */
    ok('A1 control: a solid series is one path', count(solid, 'class="rb-line"') === 1,
       'paths=' + count(solid, 'class="rb-line"'));
    /* The gappy series has a null AND an absent day, so it must be split. */
    ok('A1 a gap splits the path', count(gappy, 'class="rb-line"') > 1,
       'paths=' + count(gappy, 'class="rb-line"'));
    ok('A1 the gap is disclosed to the reader', /unmeasured/.test(gappy));
    ok('A1 control: a solid series claims no gaps', !/unmeasured — shown as gaps/.test(solid));
  });

  runCase('A2 a metric measured on no day renders an em dash, not zero', () => {
    ok('A2 control: the KPI block rendered', /rb-kpi-v/.test(nulls));
    const v = /<div class="rb-kpi-v">(.*?)<\/div>/.exec(nulls);
    ok('A2 the value is an em dash', v && v[1] === '—', 'got ' + (v && v[1]));
    ok('A2 the value is not 0', !v || v[1] !== '0');
    ok('A2 it says it was not measured', /not measured/.test(nulls));
  });

  runCase('A3 a genuine measured zero still renders as zero', () => {
    /* THE INVERTING CONTROL. Without this, a module that hid every zero as an
       em dash would pass A2 and be just as wrong, in the other direction. */
    const v = /<div class="rb-kpi-v">(.*?)<\/div>/.exec(zero);
    ok('A3 control: the KPI block rendered', !!v);
    ok('A3 a measured 0 renders as "0"', v && v[1] === '0', 'got ' + (v && v[1]));
    ok('A3 a measured 0 is NOT an em dash', !v || v[1] !== '—');
    ok('A3 a measured 0 counts as measured', /days measured/.test(zero));
  });

  /* The series assertions need the settled state, so they run against the live
     API rather than against rendered markup. */
  const seriesEnv = makeEnv({ docs: GAPPY });
  seriesEnv.api.mount(seriesEnv.el);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  seriesEnv.api.days(7);
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));

  runCase('A4b the series carries nulls as nulls and omits absent days', () => {
    const s = seriesEnv.api._series('orders24h', 0, 6);
    ok('A4b control: the series is populated', s.length > 0, 'len=' + s.length);
    /* 7 slots, one day absent entirely -> 6 points, never 7 with a zero filler. */
    ok('A4b an absent day produces no point', s.length === 6, 'len=' + s.length);
    const nullPts = s.filter((p) => p.value === null).length;
    ok('A4b the unmeasured day is a null point', nullPts === 1, 'nulls=' + nullPts);
    ok('A4b no point was coerced to 0', s.every((p) => p.value !== 0));
  });

  runCase('A5 the data table marks unmeasured cells rather than printing 0', () => {
    ok("A5 control: the table rendered", /rb-table/.test(await_table));
    const tbl = await_table;
    ok('A5 an unmeasured cell is flagged', /rb-na/.test(tbl), 'no rb-na cell');
    ok('A5 the flagged cell shows an em dash', /class="rb-na"[^>]*>—</.test(tbl));
    ok('A5 it is explained, not left ambiguous', /is not zero/.test(tbl));
  });

  /* ── B. Deltas need two measured periods ─────────────────────────── */

  runCase('B1 no comparable baseline yields no percentage', () => {
    ok('B1 control: deltas are rendered at all', /rb-delta/.test(gappy));
    ok('B1 a missing baseline says so', /no baseline/.test(gappy));
  });

  runCase('B2 a real baseline yields a real percentage', () => {
    ok('B2 control: the compared render has delta markup', /rb-delta/.test(compared));
    ok('B2 a percentage is shown', /rb-delta (good|bad|flat)">[↑↓→] [\d.]+%/.test(compared),
       'no signed percentage found');
    ok("B2 the compared render used a real baseline", /rb-delta (good|bad|flat)/.test(compared));
  });

  /* ── C. Failure and emptiness are different states ───────────────── */

  runCase('C1 an unreadable spine is not reported as an empty history', () => {
    ok('C1 the failure is stated', /could not be read/.test(denied));
    ok('C1 it does NOT claim the range is empty', !/No daily reports exist/.test(denied));
    ok('C1 nothing is charted', !/class="rb-line"/.test(denied));
  });

  runCase('C2 a readable but empty range is not reported as a failure', () => {
    /* The pair of C1. Both messages must exist and must never be swapped. */
    ok('C2 the empty state is stated', /No daily reports exist/.test(emptyR));
    ok('C2 it does NOT claim a read failure', !/could not be read/.test(emptyR));
    ok('C2 it warns against reading empty as zero activity',
       /does not mean the platform recorded zero activity/.test(emptyR));
  });

  /* ── D. Registry integrity ───────────────────────────────────────── */

  const sched = fs.readFileSync(path.join(ROOT, 'functions/scheduled-reports.js'), 'utf8');
  const api = seriesEnv.api;

  runCase('D1 every offered metric is one the scheduler actually writes', () => {
    ok('D1 control: the scheduler source was read', sched.length > 500);
    api._metrics.forEach((m) => {
      ok('D1 ' + m.key + ' appears in scheduled-reports.js', sched.indexOf(m.key) !== -1);
    });
  });

  runCase('D2 templates reference only real modules and real metrics', () => {
    const types = api._modules.map((m) => m.type);
    const keys  = api._metrics.map((m) => m.key);
    ok('D2 control: templates exist', api._templates.length > 1);
    api._templates.forEach((t) => {
      (t.blocks || []).forEach((b) => {
        ok('D2 ' + t.id + ' block type "' + b.type + '" is a real module', types.indexOf(b.type) !== -1);
        if (b.metric) ok('D2 ' + t.id + ' metric "' + b.metric + '" is real', keys.indexOf(b.metric) !== -1);
        (b.metrics || []).forEach((k) => {
          ok('D2 ' + t.id + ' KPI metric "' + k + '" is real', keys.indexOf(k) !== -1);
        });
      });
    });
  });

  runCase('D3 no module is offered that has no canonical source', () => {
    const types = api._modules.map((m) => m.type);
    ok('D3 control: the palette is populated', types.length > 5);
    ['map', 'image'].forEach((t) => {
      ok('D3 "' + t + '" is not offered', types.indexOf(t) === -1);
    });
  });

  /* ── E. No writes, no lying controls ─────────────────────────────── */

  runCase('E1 the module never writes to Firestore', () => {
    /* This module RENDERS its own onclick handlers, so its source contains the
       literal text `SokoniReports.add(` inside a quoted string. A substring
       scan reads that as a Firestore `.add(` write and fails on the console's
       own UI markup.

       So the scan discriminates by SYNTAX: comments go, then the CONTENTS of
       every string literal go while the quotes stay. Real call syntax survives
       (`.collection('x')` keeps its `.collection(`), embedded handler text does
       not. The controls below prove the stripper did not simply blank the file
       — a stripper that ate everything would pass every absence check. */
    let src = fs.readFileSync(path.join(ROOT, 'sokoni-reports-builder.js'), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '')
                .replace(/^\s*\/\/.*$/gm, '')
                .replace(/'(?:[^'\\]|\\.)*'/g, "''")
                .replace(/"(?:[^"\\]|\\.)*"/g, '""');

    ok('E1 control: stripped source kept the collection read', /\.collection\(/.test(src));
    ok('E1 control: stripped source kept the document get', /\.doc\([^)]*\)\.get\(\)/.test(src));
    ok('E1 control: stripping removed the embedded handler text',
       src.indexOf('SokoniReports.add(') === -1,
       'string literals were not stripped — the scan below proves nothing');

    ['.set(', '.update(', '.delete(', '.add(', 'httpsCallable', 'writeBatch', 'runTransaction']
      .forEach((w) => {
        ok('E1 no ' + w + ' in the builder', src.indexOf(w) === -1);
      });
  });

  runCase('E2 unavailable actions are disabled and explain themselves', () => {
    ok('E2 control: the action bar rendered', /rb-btn/.test(gappy));
    ok('E2 Publish is disabled', /<button class="rb-btn" disabled[^>]*>\s*Publish/.test(gappy));
    ok('E2 the reason is given in Settings', /No canonical store exists for a report definition/.test(gappy));
    ok('E2 scheduling states it is unavailable', /Scheduled delivery is fixed in platform code/.test(gappy));

    /* "No frequency picker" cannot be checked by searching for the word
       "frequency" — the notice EXPLAINING its absence contains it, so the
       check would fail on its own documentation. The real question is whether
       a CONTROL exists, so the assertions target control markup and the public
       API instead of prose. */
    ok('E2 control: the settings pane rendered real inputs', /class="rb-in"/.test(gappy));
    ok('E2 no schedule control is bound in the markup',
       !/SokoniReports\.(frequency|schedule|timezone|deliver|publish)\b/i.test(gappy));
    ['frequency', 'schedule', 'timezone', 'publish', 'deliver'].forEach((k) => {
      ok('E2 the API exposes no "' + k + '" method',
         typeof api[k] !== 'function');
    });
  });

  runCase('E3 a failed save is never reported as a success', () => {
    /* POSITIVE CONTROL FIRST — the working path really does report success. */
    ok('E3 control: a working save reports success', /Draft saved on this device only/.test(savedOk));
    ok('E3 control: it is labelled device-local', /not shared, not backed up/.test(savedOk));
    /* With storage throwing, the same click must report FAILURE. */
    ok('E3 a refused write reports failure', /Draft NOT saved/.test(savedFail));
    ok('E3 a refused write does NOT claim success', !/Draft saved on this device only/.test(savedFail));
  });

  /* ── F. Console wiring ───────────────────────────────────────────── */

  const strip = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
  const adminOs    = strip(fs.readFileSync(path.join(ROOT, 'admin-os.html'), 'utf8'));
  const superAdmin = strip(fs.readFileSync(path.join(ROOT, 'super-admin.html'), 'utf8'));
  const adminHtml  = strip(fs.readFileSync(path.join(ROOT, 'admin.html'), 'utf8'));
  const aos = fs.readFileSync(path.join(ROOT, 'sokoni-aos.js'), 'utf8')
                .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  runCase('F1 AdminOS mounts the builder from its existing sidebar', () => {
    ok('F1 sidebar entry exists', /data-section="reports"/.test(adminOs));
    ok('F1 it uses the console router', /SokoniAOS\.navigate\('reports'\)/.test(adminOs));
    ok('F1 the panel exists', /id="panel-reports"/.test(adminOs));
    ok('F1 exactly one mount point', (adminOs.match(/id="reportsRoot"/g) || []).length === 1);
    ok('F1 the script is served', /sokoni-reports-builder\.js/.test(adminOs));
    ok('F1 the loader is on the panel map (stripped code)',
       /reports:\s*\(\)\s*=>\s*_loadReports\(\)/.test(aos));
    ok('F1 the loader mounts the module', /SokoniReports\.mount\(root\)/.test(aos));
  });

  runCase('F2 Super Admin mounts the same module from its existing sidebar', () => {
    ok('F2 sidebar entry exists', /data-section="reports"/.test(superAdmin));
    ok('F2 it uses SA\'s router', /SA\.nav\('reports'\)/.test(superAdmin));
    ok('F2 the panel exists', /id="panel-reports"/.test(superAdmin));
    ok('F2 exactly one mount point', (superAdmin.match(/id="reportsRoot"/g) || []).length === 1);
    ok('F2 the lazy-load branch exists', /section==='reports'\)this\.loadReports\(\)/.test(superAdmin));
    ok('F2 the loader mounts the module', /SokoniReports\.mount\(root\)/.test(superAdmin));
    ok('F2 the script is served', /sokoni-reports-builder\.js/.test(superAdmin));
  });

  runCase('F3 admin.html is deliberately not a consumer', () => {
    ok('F3 control: admin.html was actually read', adminHtml.length > 1000);
    ok('F3 admin.html does not mount the builder',
       !/reportsRoot/.test(adminHtml) && !/sokoni-reports-builder\.js/.test(adminHtml));
  });

  runCase('F4 export is real, not a stub', () => {
    ok('F4 a print stylesheet exists', /@media print/.test(
      fs.readFileSync(path.join(ROOT, 'sokoni-reports-builder.js'), 'utf8')));
    ok('F4 print hides the console chrome', /\.rb-side,\.rb-acts/.test(
      fs.readFileSync(path.join(ROOT, 'sokoni-reports-builder.js'), 'utf8')));
    ok('F4 the export button invokes it', /SokoniReports\.print\(\)/.test(gappy));
  });

  /* ── Summary ─────────────────────────────────────────────────────── */
  if (ASSERTS < MIN_ASSERTIONS) {
    FAIL++;
    FAILURES.push('Suite ran only ' + ASSERTS + ' assertions; at least ' + MIN_ASSERTIONS +
                  ' expected. A short run is a FAILURE.');
  }

  console.log('\n' + '='.repeat(66));
  console.log('  REPORTS BUILDER — CERTIFICATION');
  console.log('='.repeat(66));
  console.log('  assertions : ' + ASSERTS);
  console.log('  passed     : ' + PASS);
  console.log('  failed     : ' + FAIL);
  if (FAILURES.length) {
    console.log('\n  FAILURES');
    FAILURES.forEach((f) => console.log('   ✗ ' + f));
  }
  console.log('='.repeat(66));
  console.log(FAIL === 0 ? '  RESULT: CERTIFIED\n' : '  RESULT: NOT CERTIFIED\n');
  process.exit(FAIL === 0 ? 0 : 1);

})().catch((e) => {
  console.error('\n  ✗ HARNESS CRASHED — certification did not complete');
  console.error('  ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
