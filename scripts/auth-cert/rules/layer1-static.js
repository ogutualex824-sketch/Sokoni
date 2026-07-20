/* Layer 1 — static repository validation. No network, no credentials.

   These rules assert things that are knowable from source alone. They can
   never confirm production health — that is Layer 2's job — but they catch the
   drift that CAUSES production failures: a config that disagrees with itself,
   a blocking-function import with no definition, a placeholder secret that
   shipped.

   Deliberately NOT asserted here: authorized domains, IAM, Cloud Run health.
   Those live only in deployed state. Claiming them from source would be the
   exact "infer production state" failure this validator exists to prevent. */
'use strict';
const fs = require('fs');
const path = require('path');
const { STATUS } = require('../engine');

const read = (root, rel) => {
  const p = path.join(root, rel);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
};

module.exports = [
  {
    id: 'static.config.present',
    layer: 1,
    title: 'Firebase client configuration files exist',
    run: (ctx) => {
      const missing = ['sokoni-config.js', 'firebase.js'].filter((f) => read(ctx.root, f) === null);
      return missing.length
        ? { status: STATUS.FAIL, evidence: 'missing: ' + missing.join(', '),
            remediation: 'Restore the Firebase client config; auth cannot initialise without it.' }
        : { status: STATUS.PASS, evidence: 'sokoni-config.js and firebase.js present' };
    },
  },

  {
    id: 'static.authdomain.consistent',
    layer: 1,
    title: 'authDomain agrees across every client config',
    severity: 'critical',
    run: (ctx) => {
      const found = [];
      for (const f of ['sokoni-config.js', 'firebase.js']) {
        const src = read(ctx.root, f);
        if (!src) continue;
        const m = src.match(/authDomain\s*:\s*["'`]([^"'`]+)["'`]/);
        if (m) found.push({ file: f, value: m[1] });
      }
      if (!found.length) return { status: STATUS.FAIL, evidence: 'no authDomain declared in any config file' };

      const distinct = [...new Set(found.map((f) => f.value))];
      return distinct.length === 1
        ? { status: STATUS.PASS, evidence: 'authDomain = ' + distinct[0] + ' (' + found.length + ' files agree)' }
        : { status: STATUS.FAIL,
            evidence: 'authDomain DIVERGES: ' + found.map((f) => f.file + '=' + f.value).join('  |  '),
            remediation: 'A split authDomain sends OAuth redirects to a host that may not be authorised. Unify them.' };
    },
  },

  {
    id: 'static.appcheck.sitekey',
    layer: 1,
    title: 'App Check reCAPTCHA site key is present and not a placeholder',
    run: (ctx) => {
      const src = read(ctx.root, 'sokoni-appcheck.js');
      if (!src) return { status: STATUS.SKIPPED, evidence: 'sokoni-appcheck.js not found — App Check may not be in use' };

      const m = src.match(/SITE_KEY\s*=\s*["'`]([^"'`]+)["'`]/);
      if (!m) return { status: STATUS.FAIL, evidence: 'SITE_KEY not declared in sokoni-appcheck.js' };

      const key = m[1];
      const bad = /^(TODO|CHANGEME|PLACEHOLDER|xxx|your[-_]?key)/i.test(key) || key.length < 20;
      return bad
        ? { status: STATUS.FAIL, evidence: 'SITE_KEY looks like a placeholder: ' + key }
        : { status: STATUS.PASS, evidence: 'SITE_KEY present (' + key.slice(0, 12) + '…, ' + key.length + ' chars)' };
    },
  },

  {
    /* This rule exists because of a real finding: functions/email-triggers.js
       imports beforeUserCreated and never calls it. An import with no
       definition is the fingerprint of a blocking function that was deleted
       from source — while its Identity Platform REGISTRATION, which lives in
       project config rather than code, survives and keeps calling a dead
       endpoint. That failure returns auth/internal-error for EVERY sign-in
       provider at once.

       Static analysis cannot see the registration, so this never FAILs on its
       own evidence. It raises the flag and hands off to Layer 2, which can. */
    id: 'static.blocking.orphan-import',
    layer: 1,
    title: 'No orphaned blocking-function imports (beforeUserCreated / beforeUserSignedIn)',
    severity: 'critical',
    run: (ctx) => {
      const dir = path.join(ctx.root, 'functions');
      if (!fs.existsSync(dir)) return { status: STATUS.SKIPPED, evidence: 'functions/ not found' };

      const orphans = [];
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        for (const name of ['beforeUserCreated', 'beforeUserSignedIn']) {
          const imported = new RegExp('(require|import)[^\\n]*\\b' + name + '\\b|\\b' + name + '\\s*[,}]').test(src);
          const invoked = new RegExp('\\b' + name + '\\s*\\(').test(src);
          if (imported && !invoked) orphans.push(f + ' imports ' + name + ' but never calls it');
        }
      }

      return orphans.length
        ? { status: STATUS.FAIL,
            evidence: orphans.join('; '),
            remediation:
              'Remove the unused import, THEN verify with Layer 2 that Identity Platform has no ' +
              'blockingFunctions.triggers pointing at a deleted service. A stale registration ' +
              'breaks every sign-in provider with auth/internal-error.' }
        : { status: STATUS.PASS, evidence: 'no orphaned blocking-function imports in functions/*.js' };
    },
  },

  {
    id: 'static.blocking.defined-are-exported',
    layer: 1,
    title: 'Any defined blocking function is exported from functions/index.js',
    severity: 'critical',
    run: (ctx) => {
      const dir = path.join(ctx.root, 'functions');
      const index = read(ctx.root, 'functions/index.js');
      if (!fs.existsSync(dir) || !index) return { status: STATUS.SKIPPED, evidence: 'functions/index.js not found' };

      const defined = [];
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
        const src = fs.readFileSync(path.join(dir, f), 'utf8');
        const re = /exports\.(\w+)\s*=\s*(?:beforeUserCreated|beforeUserSignedIn)\s*\(/g;
        let m;
        while ((m = re.exec(src))) defined.push({ name: m[1], file: f });
      }
      if (!defined.length) return { status: STATUS.PASS, evidence: 'no blocking functions defined in source' };

      const unexported = defined.filter((d) => d.file !== 'index.js' && !new RegExp('\\b' + d.name + '\\b').test(index));
      return unexported.length
        ? { status: STATUS.FAIL,
            evidence: 'defined but not re-exported: ' + unexported.map((u) => u.name + ' (' + u.file + ')').join(', '),
            remediation: 'A blocking function that is not exported is not deployed. If Identity Platform ' +
                         'is configured to call it, every sign-in fails.' }
        : { status: STATUS.PASS, evidence: defined.map((d) => d.name).join(', ') + ' — all exported' };
    },
  },

  {
    id: 'static.secrets.no-plaintext',
    layer: 1,
    title: 'No plaintext private keys or service-account JSON committed',
    severity: 'critical',
    run: (ctx) => {
      const hits = [];
      const scan = (dir, depth) => {
        if (depth > 3) return;
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (/^(node_modules|\.git|dist|build)$/.test(e.name)) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) { scan(full, depth + 1); continue; }
          if (!/\.(js|json|env|txt|html)$/.test(e.name)) continue;
          let src;
          try { src = fs.readFileSync(full, 'utf8'); } catch (_) { continue; }
          if (/-----BEGIN (RSA )?PRIVATE KEY-----/.test(src)) hits.push(path.relative(ctx.root, full) + ' (private key block)');
          if (/"type"\s*:\s*"service_account"/.test(src)) hits.push(path.relative(ctx.root, full) + ' (service account JSON)');
        }
      };
      scan(ctx.root, 0);

      return hits.length
        ? { status: STATUS.FAIL, evidence: hits.slice(0, 5).join('; '),
            remediation: 'Move to Secret Manager and rotate the exposed credential immediately.' }
        : { status: STATUS.PASS, evidence: 'no plaintext private keys or service-account JSON found' };
    },
  },

  {
    id: 'static.auth.error-mapping',
    layer: 1,
    title: 'Auth error handler maps codes rather than emitting one generic string',
    severity: 'medium',
    run: (ctx) => {
      const src = read(ctx.root, 'auth.js');
      if (!src) return { status: STATUS.SKIPPED, evidence: 'auth.js not found' };

      const mapped = (src.match(/auth\/[a-z-]+/g) || []).filter((v, i, a) => a.indexOf(v) === i);
      return mapped.length >= 8
        ? { status: STATUS.PASS, evidence: mapped.length + ' distinct auth/* codes mapped to user-facing messages' }
        : { status: STATUS.FAIL,
            evidence: 'only ' + mapped.length + ' auth/* codes mapped — failures will collapse into a generic message',
            remediation: 'A single generic string makes outages undiagnosable from user reports.' };
    },
  },
];
