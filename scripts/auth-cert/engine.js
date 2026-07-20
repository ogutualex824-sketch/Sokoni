/* Authentication Certification Validator — rule engine.
   ═══════════════════════════════════════════════════════

   Core contract, deliberately small so it never needs to change when rules are
   added. A rule is a plain object:

     { id, layer, title, requires?, run(ctx) -> { status, evidence, detail? } }

   Adding a check means adding a rule file. It means editing nothing here.

   ── The status vocabulary is the point of this tool ──

   PASS      the check ran and the assertion held
   FAIL      the check ran and the assertion did not hold
   SKIPPED   the check COULD NOT RUN (missing credentials, missing prerequisite)

   SKIPPED is not PASS. It never contributes to a passing certification, and it
   is never collapsed into the pass count. This exists because the outage that
   prompted this validator was invisible precisely BECAUSE unverifiable state
   was treated as healthy state. A validator that reports "all green" while
   silently skipping every live check is worse than no validator, so the
   reporter is required to surface skips as loudly as failures.

   ERROR     the rule itself threw — a bug in the rule, not a finding about the
             platform. Kept distinct so tooling defects never masquerade as
             production defects.  */
'use strict';

const LAYERS = {
  1: { key: 'static', label: 'Layer 1 — static repository validation', needsGcp: false },
  2: { key: 'gcp',    label: 'Layer 2 — live Google Cloud validation',  needsGcp: true  },
  3: { key: 'smoke',  label: 'Layer 3 — authentication smoke tests',    needsGcp: false },
};

const STATUS = { PASS: 'PASS', FAIL: 'FAIL', SKIPPED: 'SKIPPED', ERROR: 'ERROR' };

class Registry {
  constructor() { this.rules = []; }

  /* Rules self-register. Duplicate ids are a hard error: a silently shadowed
     rule is a check the operator believes is running when it is not. */
  add(rule) {
    for (const f of ['id', 'layer', 'title', 'run']) {
      if (!rule[f]) throw new Error('rule missing required field "' + f + '": ' + JSON.stringify(rule.id || rule));
    }
    if (!LAYERS[rule.layer]) throw new Error('rule ' + rule.id + ' declares unknown layer ' + rule.layer);
    if (this.rules.some((r) => r.id === rule.id)) throw new Error('duplicate rule id: ' + rule.id);
    this.rules.push(rule);
    return this;
  }

  addAll(rules) { rules.forEach((r) => this.add(r)); return this; }

  byLayer(n) { return this.rules.filter((r) => r.layer === n); }
}

/* ── Execution ───────────────────────────────────────────────────────────── */

async function runRule(rule, ctx) {
  const started = ctx.clock();

  /* A rule may declare prerequisites it cannot satisfy itself. Unmet
     prerequisites produce SKIPPED with the reason attached — never a pass. */
  if (typeof rule.requires === 'function') {
    let gate;
    try { gate = await rule.requires(ctx); }
    catch (e) { gate = { ok: false, reason: 'prerequisite check threw: ' + e.message }; }
    if (gate && gate.ok === false) {
      return finish(rule, { status: STATUS.SKIPPED, evidence: gate.reason || 'prerequisite not met' }, started, ctx);
    }
  }

  try {
    const out = await rule.run(ctx);
    if (!out || !STATUS[out.status]) {
      return finish(rule, {
        status: STATUS.ERROR,
        evidence: 'rule returned an invalid result: ' + JSON.stringify(out),
      }, started, ctx);
    }
    return finish(rule, out, started, ctx);
  } catch (e) {
    return finish(rule, { status: STATUS.ERROR, evidence: e.message, detail: (e.stack || '').split('\n').slice(0, 4) }, started, ctx);
  }
}

function finish(rule, out, started, ctx) {
  return {
    id: rule.id,
    layer: rule.layer,
    layerLabel: LAYERS[rule.layer].label,
    title: rule.title,
    severity: rule.severity || 'high',
    status: out.status,
    evidence: out.evidence || '',
    detail: out.detail || null,
    remediation: out.remediation || rule.remediation || null,
    ms: ctx.clock() - started,
  };
}

async function run(registry, ctx, opts) {
  const only = (opts && opts.layers) || [1, 2, 3];
  const results = [];

  for (const n of [1, 2, 3]) {
    if (!only.includes(n)) continue;
    for (const rule of registry.byLayer(n)) {
      results.push(await runRule(rule, ctx));
    }
  }
  return summarise(results);
}

function summarise(results) {
  const count = (s) => results.filter((r) => r.status === s).length;
  const failed = count(STATUS.FAIL);
  const errored = count(STATUS.ERROR);
  const skipped = count(STATUS.SKIPPED);

  /* CERTIFIED requires that every rule ran AND passed. A skipped rule means
     the platform's state on that dimension is UNKNOWN, and unknown is not
     certified — this is the whole reason the tool exists. */
  let verdict;
  if (failed > 0 || errored > 0) verdict = 'FAILED';
  else if (skipped > 0) verdict = 'INCOMPLETE';
  else verdict = 'CERTIFIED';

  return {
    verdict,
    totals: { total: results.length, passed: count(STATUS.PASS), failed, skipped, errored },
    results,
  };
}

module.exports = { Registry, STATUS, LAYERS, run, summarise };
