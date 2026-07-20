/* Layer 2 — live Google Cloud validation. Requires `gcloud auth login`.

   Every rule here is READ-ONLY. Nothing in this layer mutates project state:
   confirming a root cause and remediating it are separate decisions, and the
   second one is not a validator's to make.

   When credentials are absent every rule returns SKIPPED with the reason. It
   must never return PASS — "I could not look" and "I looked and it was fine"
   are different facts, and conflating them is how the current outage stayed
   invisible. */
'use strict';
const { execFileSync } = require('child_process');
const { STATUS } = require('../engine');

const PROJECT = process.env.SOKONI_GCP_PROJECT || 'sokoni-aeb26';

function gcloud(args) {
  /* gcloud ships a bundled Python; on Windows the system Python is often wrong
     or absent, and gcloud misdiagnoses this as "install Python 3". Point at the
     bundled interpreter when we can find it. */
  const env = { ...process.env };
  if (!env.CLOUDSDK_PYTHON && process.platform === 'win32') {
    const guess = 'C:/Users/' + (process.env.USERNAME || '') +
      '/AppData/Local/Google/Cloud SDK/google-cloud-sdk/platform/bundledpython/python.exe';
    try { require('fs').accessSync(guess); env.CLOUDSDK_PYTHON = guess; } catch (_) { /* leave unset */ }
  }
  /* gcloud on Windows is a .cmd shim. Node 20+ refuses to spawn .cmd directly
     (EINVAL) unless a shell is used — without this the validator reports
     "gcloud unavailable" on a machine where gcloud is installed and working,
     which would be a tooling defect masquerading as a platform finding. */
  const win = process.platform === 'win32';
  return execFileSync(win ? 'gcloud.cmd' : 'gcloud', args,
    { encoding: 'utf8', env, timeout: 90000, stdio: ['ignore', 'pipe', 'pipe'], shell: win });
}

/* Shared prerequisite: is there a credentialed account at all? Cached on ctx so
   we shell out once per run rather than once per rule. */
function requiresGcloud(ctx) {
  if (ctx._gcloud === undefined) {
    try {
      const out = gcloud(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']).trim();
      ctx._gcloud = out ? { ok: true, account: out.split('\n')[0] } : { ok: false, reason: 'no active gcloud account — run: gcloud auth login' };
    } catch (e) {
      ctx._gcloud = { ok: false, reason: 'gcloud unavailable: ' + String(e.message).split('\n')[0].slice(0, 120) };
    }
  }
  return ctx._gcloud;
}

module.exports = [
  {
    id: 'gcp.auth.active',
    layer: 2,
    title: 'An authenticated Google Cloud account is available',
    run: (ctx) => {
      const g = requiresGcloud(ctx);
      return g.ok
        ? { status: STATUS.PASS, evidence: 'active account: ' + g.account }
        : { status: STATUS.SKIPPED, evidence: g.reason,
            remediation: 'Run `gcloud auth login`. Every Layer 2 check is blocked until this succeeds.' };
    },
  },

  {
    id: 'gcp.project.active',
    layer: 2,
    title: 'Active project matches the expected SOKONI project',
    requires: requiresGcloud,
    run: () => {
      const active = gcloud(['config', 'get-value', 'project']).trim();
      return active === PROJECT
        ? { status: STATUS.PASS, evidence: 'active project = ' + active }
        : { status: STATUS.FAIL, evidence: 'active project is "' + active + '", expected "' + PROJECT + '"',
            remediation: 'gcloud config set project ' + PROJECT };
    },
  },

  {
    /* THE rule this validator was built for.

       A blocking function registered in Identity Platform is invoked
       server-side on every sign-in. If its Cloud Run service was deleted,
       renamed, or never deployed, Identity Platform gets a 5xx and returns
       auth/internal-error to the client — for EVERY provider simultaneously,
       with no failing request visible in the browser. That signature is
       indistinguishable from "auth is mysteriously broken" without this check. */
    id: 'gcp.identity.blocking-functions-resolve',
    layer: 2,
    title: 'Every registered blocking function resolves to a live service',
    severity: 'critical',
    requires: requiresGcloud,
    run: async () => {
      let raw;
      try {
        raw = gcloud(['beta', 'identity-platform', 'config', 'describe', '--project=' + PROJECT, '--format=json']);
      } catch (e) {
        return { status: STATUS.SKIPPED,
          evidence: 'could not read Identity Platform config: ' + String(e.message).split('\n')[0].slice(0, 160),
          remediation: 'Needs the beta component and Identity Platform read access. ' +
                       'Equivalent: GET https://identitytoolkit.googleapis.com/admin/v2/projects/' + PROJECT + '/config' };
      }

      const cfg = JSON.parse(raw);
      const triggers = (cfg.blockingFunctions && cfg.blockingFunctions.triggers) || {};
      const names = Object.keys(triggers);

      if (!names.length) {
        return { status: STATUS.PASS, evidence: 'no blocking functions registered — cannot be the cause of a sign-in failure' };
      }

      const dead = [];
      for (const n of names) {
        const uri = triggers[n].functionUri;
        if (!uri) { dead.push(n + ': registered with no functionUri'); continue; }
        try {
          /* An unauthenticated probe. 401/403 means the service EXISTS and is
             enforcing auth — healthy. Only a transport failure or 404 means the
             endpoint is genuinely gone. */
          const res = await fetch(uri, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
          if (res.status === 404) dead.push(n + ': ' + uri + ' -> HTTP 404 (service does not exist)');
          else if (res.status >= 500) dead.push(n + ': ' + uri + ' -> HTTP ' + res.status + ' (service failing)');
        } catch (e) {
          dead.push(n + ': ' + uri + ' -> unreachable (' + String(e.message).slice(0, 60) + ')');
        }
      }

      return dead.length
        ? { status: STATUS.FAIL,
            evidence: 'ORPHANED REGISTRATION — ' + dead.join('; '),
            remediation: 'Identity Platform calls this on every sign-in and gets a failure, which surfaces to ' +
                         'users as auth/internal-error on ALL providers. Either redeploy the function or ' +
                         'unregister the trigger (Console -> Authentication -> Settings -> Blocking functions).' }
        : { status: STATUS.PASS, evidence: names.length + ' blocking function(s) registered, all resolving: ' + names.join(', ') };
    },
  },

  {
    id: 'gcp.identity.authorized-domains',
    layer: 2,
    title: 'Authorized domains include every production host',
    requires: requiresGcloud,
    run: async (ctx) => {
      const expected = ctx.expectedDomains || ['mysokoni.co.ke', 'www.mysokoni.co.ke', 'sokoni-aeb26.web.app'];
      let cfg;
      try {
        cfg = JSON.parse(gcloud(['beta', 'identity-platform', 'config', 'describe', '--project=' + PROJECT, '--format=json']));
      } catch (e) {
        return { status: STATUS.SKIPPED, evidence: 'could not read Identity Platform config: ' + String(e.message).split('\n')[0].slice(0, 120) };
      }
      const got = cfg.authorizedDomains || [];
      const missing = expected.filter((d) => !got.includes(d));
      return missing.length
        ? { status: STATUS.FAIL, evidence: 'missing authorized domains: ' + missing.join(', ') + ' (present: ' + got.join(', ') + ')',
            remediation: 'Google Sign-In AND the phone-OTP reCAPTCHA verifier both fail on an unauthorised host.' }
        : { status: STATUS.PASS, evidence: 'all expected hosts authorised: ' + expected.join(', ') };
    },
  },

  {
    id: 'gcp.runtime.auth-services-healthy',
    layer: 2,
    title: 'Cloud Run services backing auth are serving traffic',
    severity: 'medium',
    requires: requiresGcloud,
    run: () => {
      let list;
      try {
        list = JSON.parse(gcloud(['run', 'services', 'list', '--project=' + PROJECT, '--format=json']));
      } catch (e) {
        return { status: STATUS.SKIPPED, evidence: 'could not list Cloud Run services: ' + String(e.message).split('\n')[0].slice(0, 120) };
      }
      const unhealthy = list.filter((s) => {
        const c = ((s.status || {}).conditions || []).find((c) => c.type === 'Ready');
        return c && c.status !== 'True';
      }).map((s) => s.metadata.name);

      return unhealthy.length
        ? { status: STATUS.FAIL, evidence: unhealthy.length + ' service(s) not Ready: ' + unhealthy.slice(0, 10).join(', ') }
        : { status: STATUS.PASS, evidence: list.length + ' Cloud Run services, all Ready' };
    },
  },
];
