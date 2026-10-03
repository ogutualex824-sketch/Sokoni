#!/usr/bin/env node
/* test-merchant-jobs-workspace.js — Jobs EMPLOYER WORKSPACE in merchant-v2 (J5 hosting).

   The REAL module (sokoni-merchant-jobs.js) runs in a node VM with the canonical escapeHTML lifted from security.js,
   a fake host element and a fake servicesDispatch. Every server answer comes from
   scripts/fixtures/jobs-workspace-server.json, which scripts/gen-jobs-workspace-fixtures.js produced by RUNNING the
   handlers of functions/jobs.js at a515270 (J2 moderation) and ffa2c47 (J1) in memory — the shapes, the error codes
   and the error messages are the server's, not hand-written. The legal-button matrix is compared against the
   server's own EMPLOYER_TRANSITIONS table lifted from that source, not against the page's copy.

   Rows
     A  application actions: legal buttons only, for every status · reject needs a reason (client blocks empty; the
        server's refusal is shown verbatim) · expectedVersion sent · version conflict → "This application changed —
        reload" + refetch · history
     J  vacancy actions (a515270): buttons per status · Save draft / Submit for review, never Publish · re-review
        warning before saving a reviewed field on a live vacancy, none for salary · backToReview reflected ·
        refusals verbatim · featured is a badge with no control · Closed — expired · admin pause → no Resume
     C  closeJob: confirm step, closedApplications from the server
     L  ffa2c47 fallback: "Post vacancy", no submit flag, no pause/submit buttons · unknown op list → form withheld
     H  honest surfaces: Wallet / Products "Not available yet" · Messages disabled "Messaging for applications is
        coming" · unknown counts '—', canonical zero '0' · staff sign-in loads nothing
     S  safety: no Firestore writes, no wa.me / WhatsApp / mailto hand-off, escaping of every server string
     R  registry + shell: 11 routes in the Jobs group, validate() clean, module wiring, mobile CSS
     N  negative controls — each mutant must FAIL its named row:
          N1 illegal transition button shown       → A1
          N2 expectedVersion omitted               → A3
          N3 0 rendered for an unknown count       → H3
          N4 a "Publish" button                    → J2
          N5 a feature toggle                      → J5
          N6 moderationReason rendered unescaped   → S3
   node scripts/test-merchant-jobs-workspace.js */
'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const FX = JSON.parse(read('scripts/fixtures/jobs-workspace-server.json'));
const V2 = FX.versions.a515270, V1 = FX.versions.ffa2c47;
const NOW = FX.generatedAtMs + 60000;
const SRC = read('sokoni-merchant-jobs.js');

/* canonical escapeHTML, lifted verbatim from security.js */
const SEC = read('security.js');
const escAt = SEC.indexOf('function escapeHTML(str){');
const ESC_SRC = SEC.slice(escAt, SEC.indexOf('\n  }', escAt) + 4);

const dec = (s) => String(s).replace(/&#x27;/g, "'").replace(/&#x2F;/g, '/').replace(/&#x60;/g, '`').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const hydrate = (v) => { if (v && typeof v === 'object') { if (typeof v._seconds === 'number') { const m = v._seconds * 1000 + Math.round(v._nanoseconds / 1e6); return { toMillis: () => m }; } if (Array.isArray(v)) return v.map(hydrate); const o = {}; for (const k of Object.keys(v)) o[k] = hydrate(v[k]); return o; } return v; };
const clone = (o) => JSON.parse(JSON.stringify(o));

function load (src) {
  class FakeDate extends Date { constructor (...a) { a.length ? super(...a) : super(NOW); } static now () { return NOW; } }
  const ctx = { console, Promise, Date: FakeDate, setTimeout, Math, JSON, Object, Array, String, Number, RegExp, isFinite, Error };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(ESC_SRC + '\nwindow.escapeHTML = escapeHTML;', ctx, { filename: 'security.js#escapeHTML' });
  vm.runInContext(src, ctx, { filename: 'sokoni-merchant-jobs.js' });
  return ctx.SokoniMerchantJobs;
}

/* ── fake host: innerHTML in, buttons / fields parsed back out ── */
function attrs (tag) { const o = {}; for (const m of tag.matchAll(/([a-zA-Z-]+)(?:="([^"]*)")?/g)) o[m[1]] = m[2] == null ? '' : dec(m[2]); return o; }
function mkHost () {
  const h = { innerHTML: '', _h: {}, vals: {}, ownerDocument: null,
    addEventListener (t, f) { this._h[t] = f; }, removeEventListener () {},
    querySelector (sel) {
      const m = /^\[data-reason="(.+)"\]$/.exec(sel);
      if (!m) return null;
      if (!this.innerHTML.includes('data-reason="' + m[1] + '"')) return null;
      return { value: this.vals['reason:' + m[1]] != null ? this.vals['reason:' + m[1]] : '' };
    },
    querySelectorAll (sel) {
      if (sel !== '[data-f]') return [];
      const out = [], html = this.innerHTML;
      for (const m of html.matchAll(/<input([^>]*data-f="([^"]+)"[^>]*)>/g)) out.push({ n: m[2], v: dec((/value="([^"]*)"/.exec(m[1]) || [, ''])[1]) });
      for (const m of html.matchAll(/<textarea[^>]*data-f="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out.push({ n: m[1], v: dec(m[2]) });
      for (const m of html.matchAll(/<select data-f="([^"]+)">([\s\S]*?)<\/select>/g)) out.push({ n: m[1], v: dec((/<option value="([^"]*)" selected>/.exec(m[2]) || [, ''])[1]) });
      return out.map((x) => ({ value: this.vals['f:' + x.n] != null ? this.vals['f:' + x.n] : x.v, getAttribute: () => x.n }));
    } };
  return h;
}
function buttons (host) {
  return [...host.innerHTML.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => Object.assign(attrs(m[1]), { __text: dec(m[2].replace(/<[^>]+>/g, '')).trim() }));
}
async function flush () { for (let i = 0; i < 12; i++) await new Promise((r) => setImmediate(r)); }
async function click (host, pred) {
  const b = buttons(host).find(pred);
  if (!b) return false;
  const el = { disabled: 'disabled' in b, getAttribute: (n) => (n in b ? b[n] : null),
    closest: (sel) => { const k = /^\[([a-z-]+)\]$/.exec(sel); return k && (k[1] in b) ? el : null; } };
  await host._h.click({ target: el });
  await flush();
  return true;
}

/* ── fake server ── */
/* 'active' and 'closed' are the SAME live vacancy recorded before and after closeJob; the employer list holds it once. */
function defaultJobs (version) { return Object.entries(version.jobs).filter(([k]) => k !== 'closed').map(([, j]) => j); }
function mkServer (version, over) {
  const calls = [];
  const jobs = over && over.jobs ? over.jobs : defaultJobs(version);
  const dispatch = (payload) => {
    calls.push(clone(payload));
    const op = payload.op;
    if (over && over[op]) { const r = over[op](payload, calls); return r instanceof Error || (r && r.__err) ? Promise.reject(r) : Promise.resolve({ data: r }); }
    if (op === '') return Promise.reject(Object.assign(new Error(version.opsMessage), { code: 'functions/invalid-argument' }));
    if (op === 'getJobApplications') {
      const r = payload.jobId === version.applications.liveJobId ? version.responses.getJobApplications : { applications: [] };
      return Promise.resolve({ data: clone(r) });
    }
    if (version.responses[op]) return Promise.resolve({ data: clone(version.responses[op]) });
    return Promise.reject(Object.assign(new Error('Unknown services operation: "' + op + '".'), { code: 'functions/not-found' }));
  };
  return { calls, dispatch, readMyJobs: () => Promise.resolve(hydrate(clone(jobs))) };
}
const err = (e) => Object.assign(new Error(e.message), { code: 'functions/' + e.code });

async function mountView (M, view, server, extra) {
  M._reset();
  const host = mkHost();
  const ui = M.mount(host, Object.assign({ view, uid: () => 'emp', role: () => 'owner', companyName: () => 'Mama Mboga Ltd',
    dispatch: server.dispatch, readMyJobs: server.readMyJobs, go: () => {}, onToast: () => {} }, extra || {}));
  await flush();
  return { host, ui };
}
const appCard = (host, id) => { const i = host.innerHTML.indexOf('data-appcard="' + id + '"'); if (i < 0) return ''; const j = host.innerHTML.indexOf('data-appcard="', i + 10); return host.innerHTML.slice(i, j < 0 ? undefined : j); };
const jobCard = (host, id) => { const i = host.innerHTML.indexOf('data-jobcard="' + id + '"'); if (i < 0) return ''; const j = host.innerHTML.indexOf('data-jobcard="', i + 10); return host.innerHTML.slice(i, j < 0 ? undefined : j); };
const btnsIn = (html) => buttons({ innerHTML: html });

/* ══ the rows, as functions of the module source (so mutants can re-run them) ══ */
const ROWS = {};
ROWS.A1 = { label: 'A1  every application status shows ONLY the server-legal moves (matrix vs a515270 EMPLOYER_TRANSITIONS, all 11 statuses)', fn: async (M) => {
  const T = V2.tables.EMPLOYER_TRANSITIONS, statuses = Object.keys(V2.tables.STATUS_LABEL), bad = [];
  for (const st of statuses) {
    const app = Object.assign(clone(V2.responses.getJobApplications.applications[0]), { id: 'x_' + st, status: st, statusLabel: V2.tables.STATUS_LABEL[st], statusVersion: 3 });
    const s = mkServer(V2, { getJobApplications: () => ({ applications: [app] }) });
    const { host } = await mountView(M, 'applications', s);
    const shown = btnsIn(appCard(host, 'x_' + st)).filter((b) => b['data-act'] === 'move').map((b) => b['data-to']).sort();
    const want = (T[st] || []).slice().sort();
    if (JSON.stringify(shown) !== JSON.stringify(want)) bad.push({ st, shown, want });
  }
  return { ok: bad.length === 0 && statuses.length === 11, got: bad };
} };
ROWS.A2 = { label: 'A2  Reject with an empty reason is blocked in the page (no call); a short reason reaches the server and its refusal is shown VERBATIM', fn: async (M) => {
  const s = mkServer(V2, { updateApplicationStatus: (p) => (p.reason && p.reason.length < 3 ? err(V2.errors.err_reject_no_reason) : { success: true, status: 'rejected', statusVersion: 2 }) });
  const { host } = await mountView(M, 'applications', s);
  const id = V2.applications.liveJobId + '_s6';
  await click(host, (b) => b['data-act'] === 'move' && b['data-app'] === id && b['data-to'] === 'rejected');
  const blocked = !s.calls.some((c) => c.op === 'updateApplicationStatus') && appCard(host, id).includes('Give the applicant a reason before rejecting.');
  host.vals['reason:' + id] = 'no';
  await click(host, (b) => b['data-act'] === 'move' && b['data-app'] === id && b['data-to'] === 'rejected');
  const sent = s.calls.filter((c) => c.op === 'updateApplicationStatus');
  const verbatim = dec(appCard(host, id)).includes(V2.errors.err_reject_no_reason.message);
  return { ok: blocked && sent.length === 1 && sent[0].reason === 'no' && verbatim, got: { blocked, sent, verbatim } };
} };
ROWS.A3 = { label: 'A3  every move sends expectedVersion = the server\'s statusVersion for that application', fn: async (M) => {
  const s = mkServer(V2, { updateApplicationStatus: () => ({ success: true, status: 'interview', statusVersion: 5 }) });
  const { host } = await mountView(M, 'applications', s);
  const app = V2.responses.getJobApplications.applications.find((a) => a.status === 'interview');
  await click(host, (b) => b['data-act'] === 'move' && b['data-app'] === app.id && b['data-to'] === 'offer');
  const c = s.calls.find((x) => x.op === 'updateApplicationStatus');
  return { ok: !!c && c.expectedVersion === app.statusVersion && c.applicationId === app.id && c.status === 'offer', got: c };
} };
ROWS.A4 = { label: 'A4  a version conflict (server "aborted") shows "This application changed — reload" and REFETCHES the applications', fn: async (M) => {
  const s = mkServer(V2, { updateApplicationStatus: () => err(V2.errors.err_stale_version) });
  const { host } = await mountView(M, 'applications', s);
  const id = V2.applications.liveJobId + '_s6';
  const before = s.calls.filter((c) => c.op === 'getJobApplications').length;
  await click(host, (b) => b['data-act'] === 'move' && b['data-app'] === id && b['data-to'] === 'reviewing');
  const after = s.calls.filter((c) => c.op === 'getJobApplications').length;
  return { ok: dec(appCard(host, id)).includes('This application changed — reload') && after === before + 1, got: { before, after } };
} };
ROWS.A5 = { label: 'A5  History lists the server events (getApplicationHistory) with their labels', fn: async (M) => {
  const s = mkServer(V2); const { host } = await mountView(M, 'applications', s);
  const id = V2.responses.getApplicationHistory.applicationId;
  await click(host, (b) => b['data-act'] === 'history' && b['data-app'] === id);
  const card = dec(appCard(host, id));
  return { ok: V2.responses.getApplicationHistory.events.every((e) => card.includes(e.label)), got: card.slice(0, 300) };
} };
ROWS.A6 = { label: 'A6  Interviews / Offers are FILTERED application views (status interview; offer|offer_accepted|offer_declined) — no other source', fn: async (M) => {
  const s = mkServer(V2);
  const a = await mountView(M, 'interviews', s); const iv = [...a.host.innerHTML.matchAll(/data-appcard="([^"]+)"/g)].map((m) => m[1]);
  const b = await mountView(M, 'offers', s); const of = [...b.host.innerHTML.matchAll(/data-appcard="([^"]+)"/g)].map((m) => m[1]);
  const apps = V2.responses.getJobApplications.applications;
  const wantI = apps.filter((x) => x.status === 'interview').map((x) => x.id), wantO = apps.filter((x) => ['offer', 'offer_accepted', 'offer_declined'].includes(x.status)).map((x) => x.id);
  const hire = btnsIn(appCard(b.host, apps.find((x) => x.status === 'offer_accepted').id)).some((x) => x['data-to'] === 'hired');
  return { ok: JSON.stringify(iv.sort()) === JSON.stringify(wantI.sort()) && JSON.stringify(of.sort()) === JSON.stringify(wantO.sort()) && hire, got: { iv, of, hire } };
} };

const JOB_EXPECT = {
  draft:             ['edit', 'submit-job', 'close-ask'],
  pending_review:    ['edit', 'close-ask'],
  changes_requested: ['edit', 'submit-job', 'close-ask'],
  featured_active:   ['edit', 'pause-job', 'close-ask', 'see-apps'],
  paused:            ['edit', 'resume-job', 'close-ask', 'see-apps'],
  admin_paused:      ['edit', 'close-ask', 'see-apps'],
  closed_expired:    ['see-apps'],
  rejected:          [],
  archived:          []
};
ROWS.J1 = { label: 'J1  vacancy buttons per status (a515270 fixtures): draft/changes → Submit; Published → Pause; paused+approved → Resume; admin-paused → no Resume; rejected/archived → none', fn: async (M) => {
  const s = mkServer(V2); const { host } = await mountView(M, 'jobs', s); const bad = [];
  for (const [k, want] of Object.entries(JOB_EXPECT)) {
    const j = V2.jobs[k]; const got = btnsIn(jobCard(host, j.id)).map((b) => b['data-act']);
    if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ k, got, want });
  }
  return { ok: bad.length === 0, got: bad };
} };
ROWS.J2 = { label: 'J2  new-vacancy form (J2 server): "Save draft" sends submit:false, "Submit for review" submit:true; NO "Publish" button anywhere; result labelled from the server status', fn: async (M) => {
  const s = mkServer(V2, { createJob: (p) => (p.submit ? clone(V2.responses.createJob_pending) : clone(V2.responses.createJob_draft)) });
  const { host } = await mountView(M, 'jobs', s);
  await click(host, (b) => b['data-act'] === 'new');
  const labels = buttons(host).map((b) => b.__text);
  const publish = labels.some((t) => /\bpublish\b/i.test(t) && !/published/i.test(t));
  Object.assign(host.vals, { 'f:title': 'Cashier', 'f:description': 'We need a reliable cashier for weekday shifts.', 'f:type': 'freelance-gig', 'f:category': 'retail' });
  await click(host, (b) => b['data-act'] === 'create' && b['data-submit'] === '0');
  const c1 = s.calls.filter((c) => c.op === 'createJob')[0];
  const drafted = dec(host.innerHTML).includes('is now: Draft.');
  await click(host, (b) => b['data-act'] === 'new');
  Object.assign(host.vals, { 'f:title': 'Cashier', 'f:description': 'We need a reliable cashier for weekday shifts.', 'f:type': 'full-time', 'f:category': 'retail' });
  await click(host, (b) => b['data-act'] === 'create' && b['data-submit'] === '1');
  const c2 = s.calls.filter((c) => c.op === 'createJob')[1];
  const pending = dec(host.innerHTML).includes('is now: Pending review.');
  return { ok: labels.includes('Save draft') && labels.includes('Submit for review') && !publish && c1 && c1.submit === false && c1.type === 'freelance-gig' && c2 && c2.submit === true && drafted && pending,
    got: { labels, publish, c1, c2, drafted, pending } };
} };
ROWS.J3 = { label: 'J3  editing a REVIEWED field on a Published vacancy warns BEFORE saving (no call until confirmed), then reflects backToReview', fn: async (M) => {
  const s = mkServer(V2, { updateJob: () => clone(V2.responses.updateJob_content_backToReview) });
  const { host } = await mountView(M, 'jobs', s);
  const id = V2.jobs.featured_active.id;
  await click(host, (b) => b['data-act'] === 'edit' && b['data-job'] === id);
  host.vals['f:title'] = 'Senior cashier (renamed)';
  await click(host, (b) => b['data-act'] === 'save-edit');
  const warned = dec(host.innerHTML).includes('Editing these fields sends the job back for review; it will be hidden until approved') && !s.calls.some((c) => c.op === 'updateJob');
  await click(host, (b) => b['data-act'] === 'save-edit' && b.__text === 'Save and send for review');
  const c = s.calls.find((x) => x.op === 'updateJob');
  const reflected = dec(jobCard(host, id)).includes('went back to review');
  return { ok: warned && !!c && c.title === 'Senior cashier (renamed)' && !('salaryMin' in c) && reflected, got: { warned, c, reflected } };
} };
ROWS.J4 = { label: 'J4  a salary / location / closing-date edit on a Published vacancy saves with NO warning', fn: async (M) => {
  const s = mkServer(V2, { updateJob: () => clone(V2.responses.updateJob_salary) });
  const { host } = await mountView(M, 'jobs', s);
  const id = V2.jobs.featured_active.id;
  await click(host, (b) => b['data-act'] === 'edit' && b['data-job'] === id);
  Object.assign(host.vals, { 'f:salaryMin': '26000', 'f:location': 'Thika', 'f:expiresInDays': '14' });
  await click(host, (b) => b['data-act'] === 'save-edit');
  const c = s.calls.find((x) => x.op === 'updateJob');
  return { ok: !!c && c.salaryMin === 26000 && c.location === 'Thika' && c.expiresInDays === 14 && !('title' in c) && !dec(host.innerHTML).includes('sends the job back for review;'), got: c };
} };
ROWS.J5 = { label: 'J5  featured is a BADGE only: "Featured" shown on the featured vacancy, and no control anywhere names feature / promote / boost', fn: async (M) => {
  const s = mkServer(V2); const { host } = await mountView(M, 'jobs', s);
  const card = jobCard(host, V2.jobs.featured_active.id);
  const badge = /data-badge="featured">Featured</.test(card);
  const controls = buttons(host).filter((b) => /feature|promot|boost/i.test(b.__text + ' ' + (b['data-act'] || '')));
  const others = defaultJobs(V2).map((j) => [j.id, j]).filter(([, j]) => j.featured !== true).every(([, j]) => !jobCard(host, j.id).includes('data-badge="featured"'));
  return { ok: badge && controls.length === 0 && others, got: { badge, controls, others } };
} };
ROWS.J6 = { label: 'J6  pause / resume / submit refusals (failed-precondition) are shown VERBATIM; success reloads the list', fn: async (M) => {
  const s = mkServer(V2, { pauseJob: () => err(V2.errors.err_pauseJob_draft) });
  const { host } = await mountView(M, 'jobs', s);
  const id = V2.jobs.featured_active.id;
  await click(host, (b) => b['data-act'] === 'pause-job' && b['data-job'] === id);
  const shown = dec(jobCard(host, id)).includes(V2.errors.err_pauseJob_draft.message);
  const s2 = mkServer(V2); const m2 = await mountView(M, 'jobs', s2);
  const reads0 = s2.calls.length;
  await click(m2.host, (b) => b['data-act'] === 'submit-job' && b['data-job'] === V2.jobs.draft.id);
  const sub = s2.calls.find((c) => c.op === 'submitJob');
  return { ok: shown && !!sub && sub.jobId === V2.jobs.draft.id && dec(jobCard(m2.host, V2.jobs.draft.id)).includes('Status: Pending review'), got: { shown, sub, reads0 } };
} };
ROWS.J7 = { label: 'J7  labels: Published / Changes requested / Closed — expired; moderationReason (changes_requested, rejected, admin pause) shown ESCAPED', fn: async (M) => {
  const s = mkServer(V2); const { host } = await mountView(M, 'jobs', s);
  const lab = (k) => dec((/data-status="[^"]*">([^<]*)</.exec(jobCard(host, V2.jobs[k].id)) || [])[1] || '');
  const chg = jobCard(host, V2.jobs.changes_requested.id);
  const ok = lab('featured_active') === 'Published' && lab('changes_requested') === 'Changes requested' && lab('closed_expired') === 'Closed — expired' &&
    lab('rejected') === 'Rejected' && lab('archived') === 'Archived' && lab('draft') === 'Draft' && lab('pending_review') === 'Pending review' &&
    dec(chg).includes('SOKONI review: ' + V2.jobs.changes_requested.moderationReason) &&
    dec(jobCard(host, V2.jobs.rejected.id)).includes(V2.jobs.rejected.moderationReason) &&
    dec(jobCard(host, V2.jobs.admin_paused.id)).includes('Paused by SOKONI: ' + V2.jobs.admin_paused.moderationReason);
  return { ok, got: ['featured_active', 'changes_requested', 'closed_expired', 'rejected'].map(lab) };
} };

ROWS.C1 = { label: 'C1  Close vacancy asks first (no call), then shows closedApplications FROM THE SERVER and refetches that vacancy\'s applications', fn: async (M) => {
  const s = mkServer(V2, { closeJob: () => ({ success: true, closedApplications: 7 }) });
  const { host } = await mountView(M, 'jobs', s);
  const id = V2.jobs.featured_active.id;
  await click(host, (b) => b['data-act'] === 'close-ask' && b['data-job'] === id);
  const asked = !s.calls.some((c) => c.op === 'closeJob') && dec(jobCard(host, id)).includes('cannot be re-opened');
  const before = s.calls.filter((c) => c.op === 'getJobApplications' && c.jobId === id).length;
  await click(host, (b) => b['data-act'] === 'close-confirm' && b['data-job'] === id);
  const after = s.calls.filter((c) => c.op === 'getJobApplications' && c.jobId === id).length;
  const fx = mkServer(V2); const m2 = await mountView(M, 'jobs', fx);
  await click(m2.host, (b) => b['data-act'] === 'close-ask' && b['data-job'] === V2.jobs.featured_active.id);
  await click(m2.host, (b) => b['data-act'] === 'close-confirm');
  const fromFixture = dec(jobCard(m2.host, V2.jobs.featured_active.id)).includes('Applications closed: ' + V2.responses.closeJob.closedApplications);
  return { ok: asked && dec(jobCard(host, id)).includes('Applications closed: 7') && after === before + 1 && fromFixture, got: { asked, before, after, fromFixture } };
} };

ROWS.L1 = { label: 'L1  ffa2c47 fallback (no submitJob in the op list): one "Post vacancy" that says it goes live, no submit flag sent, no Pause / Submit buttons', fn: async (M) => {
  const s = mkServer(V1, { createJob: () => clone(V1.responses.createJob_submit) });
  const { host } = await mountView(M, 'jobs', s);
  const pause = buttons(host).some((b) => ['pause-job', 'submit-job', 'resume-job'].includes(b['data-act']));
  await click(host, (b) => b['data-act'] === 'new');
  const labels = buttons(host).map((b) => b.__text);
  Object.assign(host.vals, { 'f:title': 'Cashier', 'f:description': 'We need a reliable cashier for weekday shifts.', 'f:type': 'full-time', 'f:category': 'retail' });
  await click(host, (b) => b['data-act'] === 'create');
  const c = s.calls.find((x) => x.op === 'createJob');
  return { ok: !pause && labels.includes('Post vacancy') && !labels.includes('Save draft') && !labels.includes('Submit for review') && dec(host.innerHTML).includes('is now: Published.') && !!c && !('submit' in c),
    got: { pause, labels, c } };
} };
ROWS.L2 = { label: 'L2  op list unreadable → the form is WITHHELD with the reason and a retry; nothing is posted or guessed', fn: async (M) => {
  const s = mkServer(V2, { '': () => Object.assign(new Error('internal'), { code: 'functions/internal', __err: true }) });
  const { host } = await mountView(M, 'jobs', s);
  await click(host, (b) => b['data-act'] === 'new');
  const acts = buttons(host).map((b) => b['data-act']);
  return { ok: !acts.includes('create') && acts.includes('retry-ops') && dec(host.innerHTML).includes('Could not confirm how vacancies are published'), got: acts };
} };

ROWS.H1 = { label: 'H1  Wallet and Products are honest: "Not available yet", no pay / buy / top-up control, no call beyond loading', fn: async (M) => {
  const out = [];
  for (const v of ['wallet', 'products']) { const s = mkServer(V2); const { host } = await mountView(M, v, s); out.push({ v, na: host.innerHTML.includes('Not available yet'), btn: buttons(host).length, ops: s.calls.map((c) => c.op).filter((o) => !['', 'getJobApplications'].includes(o)) }); }
  return { ok: out.every((x) => x.na && x.btn === 0 && x.ops.length === 0), got: out };
} };
ROWS.H2 = { label: 'H2  Messages: a DISABLED "Messaging for applications is coming" (view + every application card); no inbox call, no hand-off', fn: async (M) => {
  const s = mkServer(V2); const a = await mountView(M, 'messages', s); const b = await mountView(M, 'applications', s);
  const dis = (h) => buttons(h).filter((x) => x.__text === 'Messaging for applications is coming');
  const cards = (b.host.innerHTML.match(/data-appcard=/g) || []).length;
  return { ok: dis(a.host).length === 1 && dis(a.host).every((x) => 'disabled' in x) && dis(b.host).length === cards && cards > 0 && dis(b.host).every((x) => 'disabled' in x) && !/openForTransaction|openChat/.test(SRC), got: { cards, n: dis(b.host).length } };
} };
ROWS.H3 = { label: 'H3  unknown counts render "—", never 0: applications unloadable → every application tile "—"; an EMPTY account → canonical "0"', fn: async (M) => {
  const s = mkServer(V2, { getJobApplications: () => Object.assign(new Error('Operation failed unexpectedly.'), { code: 'functions/internal', __err: true }) });
  const { host } = await mountView(M, 'overview', s);
  const tiles = [...host.innerHTML.matchAll(/<div class="jw-tile"><b>([^<]*)<\/b><small>([^<]*)<\/small>/g)].map((m) => [dec(m[2]), dec(m[1])]);
  const appTiles = tiles.filter(([l]) => ['Applications', 'New (submitted)', 'Interviews', 'Offers open'].includes(l));
  const s0 = mkServer(V2, { jobs: [] }); const e = await mountView(M, 'overview', s0);
  const zero = [...e.host.innerHTML.matchAll(/<div class="jw-tile"><b>([^<]*)<\/b>/g)].map((m) => m[1]);
  const an = await mountView(M, 'analytics', s);
  const anTiles = [...an.host.innerHTML.matchAll(/<div class="jw-tile"><b>([^<]*)<\/b>/g)].map((m) => m[1]);
  return { ok: appTiles.length === 4 && appTiles.every(([, v]) => v === '—') && zero.length === 8 && zero.every((v) => v === '0') && anTiles.length > 0 && anTiles.every((v) => v === '—'), got: { appTiles, zero, anTiles } };
} };
ROWS.H4 = { label: 'H4  loaded counts are derived from the server responses: Published / Pending review / Drafts from the job list; Applications / Interviews from getJobApplications', fn: async (M) => {
  const s = mkServer(V2); const { host } = await mountView(M, 'overview', s);
  const t = Object.fromEntries([...host.innerHTML.matchAll(/<div class="jw-tile"><b>([^<]*)<\/b><small>([^<]*)<\/small>/g)].map((m) => [dec(m[2]), m[1]]));
  const J = defaultJobs(V2), A = V2.responses.getJobApplications.applications;
  const want = { 'Published vacancies': J.filter((j) => j.status === 'active').length, 'Pending review': J.filter((j) => j.status === 'pending_review').length,
    Drafts: J.filter((j) => j.status === 'draft').length, Applications: A.length, Interviews: A.filter((a) => a.status === 'interview').length };
  return { ok: Object.entries(want).every(([k, v]) => t[k] === String(v)), got: { t, want } };
} };
ROWS.H5 = { label: 'H5  a STAFF sign-in (server-resolved role ≠ owner) is told hiring runs from the owner\'s account and makes NO call', fn: async (M) => {
  const s = mkServer(V2); const { host } = await mountView(M, 'jobs', s, { role: () => 'cashier' });
  return { ok: s.calls.length === 0 && host.innerHTML.includes('owner') && buttons(host).length === 0, got: s.calls };
} };
ROWS.H6 = { label: 'H6  Candidates are derived from applications (one card per seekerUid), Company shows the shop name read-only', fn: async (M) => {
  const s = mkServer(V2); const a = await mountView(M, 'candidates', s);
  const n = (a.host.innerHTML.match(/class="jw-card"/g) || []).length;
  const uniq = new Set(V2.responses.getJobApplications.applications.map((x) => x.seekerUid)).size;
  const c = await mountView(M, 'company', s);
  return { ok: n === uniq && c.host.innerHTML.includes('Mama Mboga Ltd') && !/data-f=|<input/.test(c.host.innerHTML), got: { n, uniq } };
} };

ROWS.S1 = { label: 'S1  the module performs NO Firestore write and holds no client write API (writes are servicesDispatch only)', fn: async () => {
  const hits = SRC.match(/\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b|\.(set|add|update|delete)\(\s*\{|firestore\(\)/g) || [];
  const shell = read('merchant-v2.html'); const at = shell.indexOf('function _jobsCtx'); const ctxSrc = shell.slice(at, shell.indexOf('\n  }\n', at));
  const shellHits = ctxSrc.match(/setDoc|addDoc|updateDoc|deleteDoc|runTransaction|writeProduct|writeMirror/g) || [];
  return { ok: hits.length === 0 && at > 0 && shellHits.length === 0 && /_callable\('servicesDispatch'\)/.test(ctxSrc) && /collection: 'jobs', where: \[\['employerUid', '==', u\]\]/.test(ctxSrc), got: { hits, shellHits } };
} };
ROWS.S2 = { label: 'S2  no WhatsApp / wa.me / mailto / tel hand-off anywhere in the module or its shell wiring', fn: async () => {
  const shell = read('merchant-v2.html'); const at = shell.indexOf('function _jobsCtx'); const ctxSrc = shell.slice(at, shell.indexOf('\n  }\n', at));
  const re = /wa\.me|whatsapp|mailto:|tel:/i;
  return { ok: !re.test(SRC) && !re.test(ctxSrc), got: (SRC.match(re) || [])[0] };
} };
ROWS.S3 = { label: 'S3  every server string is escaped: cover letter <img onerror>, job title, CV link — no raw tag reaches innerHTML', fn: async (M) => {
  const evil = '<img src=x onerror=alert(1)>';
  const jobs = defaultJobs(V2).map((j) => Object.assign(clone(j), j.status === 'active' ? { title: evil, location: '"><script>x</script>' } : {}, j.status === 'changes_requested' ? { moderationReason: '<b>bold</b>' + evil } : {}));
  const apps = clone(V2.responses.getJobApplications.applications).map((a) => Object.assign(a, { seekerProfile: { name: evil, headline: evil, skills: [evil] } }));
  apps[0].cvUrl = 'javascript:alert(1)';
  const s = mkServer(V2, { jobs, getJobApplications: () => ({ applications: apps }) });
  const raw = [];
  for (const v of ['jobs', 'applications', 'candidates', 'analytics', 'overview']) { const { host } = await mountView(M, v, s); if (/<img|<script|<b>bold|href="(?!https:)/i.test(host.innerHTML) || /"><script/.test(host.innerHTML)) raw.push(v); }
  return { ok: raw.length === 0, got: raw };
} };

ROWS.R1 = { label: 'R1  registry: 11 Jobs routes (native, tier more) in ONE "Jobs" group, each in exactly one group; validate() clean', fn: async () => {
  delete require.cache[require.resolve(path.join(ROOT, 'sokoni-merchant-routes.js'))];
  const C = require(path.join(ROOT, 'sokoni-merchant-routes.js'));
  const ids = ['jobs-overview', 'jobs', 'jobs-applications', 'jobs-candidates', 'jobs-interviews', 'jobs-offers', 'jobs-messages', 'jobs-company', 'jobs-wallet', 'jobs-products', 'jobs-analytics'];
  const g = C.MORE_GROUPS.find((x) => x.key === 'jobs');
  const all = C.MORE_GROUPS.flatMap((x) => x.ids);
  const routes = ids.map((id) => C.ROUTES.find((r) => r.id === id));
  const names = C.ROUTES.map((r) => r.name); const dupNames = names.filter((n, i) => names.indexOf(n) !== i);
  return { ok: !!g && g.label === 'Jobs' && JSON.stringify(g.ids) === JSON.stringify(ids) && ids.every((id) => all.filter((x) => x === id).length === 1) &&
    routes.every((r) => r && r.kind === 'native' && r.tier === 'more') && C.validate().length === 0 && dupNames.length === 0, got: { g, errs: C.validate(), dupNames } };
} };
ROWS.R2 = { label: 'R2  shell: script tag, one MODULES entry per Jobs route → SokoniMerchantJobs with the matching view key, module VIEWS cover them', fn: async (M) => {
  const shell = read('merchant-v2.html');
  const ents = [...shell.matchAll(/^ {4}'(jobs[a-z-]*)': \{ global: 'SokoniMerchantJobs', ctx: function \(\) \{ return _jobsCtx\('([a-z]+)'\); \} \},$/gm)].map((m) => [m[1], m[2]]);
  const ok = /<script src="sokoni-merchant-jobs\.js"><\/script>/.test(shell) && ents.length === 11 && ents.every(([id, v]) => M.ROUTE_OF[v] === id) && M.VIEWS.length === 11;
  return { ok, got: ents };
} };
ROWS.R3 = { label: 'R3  mobile-first: no fixed width over 390px, grids use minmax(0,1fr), the analytics table scrolls inside its own box, 16px inputs', fn: async () => {
  const css = SRC.slice(SRC.indexOf('var CSS = ['), SRC.indexOf('].join', SRC.indexOf('var CSS = [')));
  const wide = (css.match(/(?:^|[^-])width:\s*(\d+)px/g) || []).map((x) => +x.replace(/\D/g, '')).filter((n) => n > 390);
  return { ok: wide.length === 0 && /repeat\(2,minmax\(0,1fr\)\)/.test(css) && /\.jw-scroll\{overflow-x:auto/.test(css) && /<div class="jw-scroll"><table/.test(SRC) && /font-size:16px/.test(css), got: wide };
} };

/* ══ runner ══ */
(async () => {
  let pass = 0, fail = 0;
  const run = async (src) => { const M = load(src); const res = {}; for (const [k, r] of Object.entries(ROWS)) { try { res[k] = await r.fn(M); } catch (e) { res[k] = { ok: false, got: String(e && e.stack || e).slice(0, 300) }; } } return res; };
  console.log('\nJOBS EMPLOYER WORKSPACE — merchant-v2 (server fixtures: a515270 + ffa2c47, generated ' + new Date(FX.generatedAtMs).toISOString() + ')\n');
  const res = await run(SRC);
  for (const [k, r] of Object.entries(ROWS)) { const ok = res[k].ok; console.log('  ' + (ok ? 'PASS  ' : 'FAIL  ') + r.label + (ok ? '' : '   [got ' + JSON.stringify(res[k].got).slice(0, 400) + ']')); ok ? pass++ : fail++; }

  console.log('\nNegative controls (each mutant must FAIL its named row)');
  const MUT = [
    ['N1 illegal transition button shown', 'A1', "pending:        ['reviewing', 'shortlisted', 'rejected'],", "pending:        ['reviewing', 'shortlisted', 'rejected', 'hired'],"],
    ['N2 expectedVersion omitted', 'A3', 'var payload = { applicationId: appId, status: to, expectedVersion: v };', 'var payload = { applicationId: appId, status: to };'],
    ['N3 0 rendered for an unknown count', 'H3', "return (typeof n === 'number' && isFinite(n)) ? String(n) : '—';", "return (typeof n === 'number' && isFinite(n)) ? String(n) : '0';"],
    ['N4 a "Publish" button', 'J2', '>Save draft</button>', '>Publish</button>'],
    ['N6 moderationReason rendered raw', 'S3', "esc(j.moderationReason) + '</div>' : '';", "j.moderationReason + '</div>' : '';"],
    ['N5 a feature toggle', 'J5', "if (a === 'edit') return", "if (a === 'edit') return '<button class=\"jw-btn\" type=\"button\" data-act=\"feature\" data-job=\"' + esc(j.id) + '\">Feature this vacancy</button>' +"]
  ];
  for (const [name, row, a, b] of MUT) {
    if (SRC.split(a).length !== 2) { console.log('  FAIL  ' + name + ' — mutation anchor not found exactly once'); fail++; continue; }
    const M = load(SRC.replace(a, b)); let r;
    try { r = await ROWS[row].fn(M); } catch (e) { r = { ok: false }; }
    const caught = !r.ok;
    console.log('  ' + (caught ? 'PASS  ' : 'FAIL  ') + name + ' → ' + row + (caught ? ' fails, as it must' : ' STILL PASSES — the row cannot see this defect'));
    caught ? pass++ : fail++;
  }
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})();
