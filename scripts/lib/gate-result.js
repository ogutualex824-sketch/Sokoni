'use strict';
/**
 * scripts/lib/gate-result.js — a gate outcome that carries its own provenance.
 *
 * THE PROBLEM THIS SOLVES
 * A two-valued result (PASS / FAIL) has nowhere to put "the test could not
 * make a reliable observation". Both wrong answers follow: a blocked check
 * reported as FAIL sends someone hunting a bug that does not exist, and — far
 * worse — a blocked check that happens to produce the expected-looking
 * response gets reported as PASS.
 *
 * That is not hypothetical here. The provider self-publish check originally
 * reported
 *
 *     create status:"active" → HTTP 403 DENIED (correct)
 *
 * when in fact App Check had rejected the request before Firestore rules ran.
 * Every case was denied identically; nothing had been tested. A PASS was
 * printed for an assertion that was never exercised.
 *
 * So: three outcomes, and every record states what it observed, where, and at
 * which commit.
 *
 *   PASS    — a valid observation confirmed the expected behaviour
 *   FAIL    — a valid observation confirmed incorrect behaviour
 *   BLOCKED — no reliable observation was possible (App Check, credentials,
 *             an unreachable backend, a missing fixture). NOT a pass, NOT a
 *             failure, and never silently folded into either.
 *
 * A gate with any FAIL is FAIL. A gate with no FAIL but any BLOCKED is
 * BLOCKED — because an unobserved assertion cannot contribute to confidence.
 * Only an all-PASS gate is PASS.
 *
 * Records are written to docs/release-gates/<name>-<commit>.json, matching the
 * existing convention in that directory.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const PASS = 'PASS', FAIL = 'FAIL', BLOCKED = 'BLOCKED';

function shortCommit() {
  try {
    return execSync('git rev-parse --short HEAD',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (e) { return 'unknown'; }
}

function dirty() {
  try {
    return execSync('git status --porcelain', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().length > 0;
  } catch (e) { return null; }
}

/**
 * new Gate({ name, evidence, environment, confidence })
 *   evidence    — how the observation was made: 'browser-run', 'production-probe',
 *                 'integration-test', 'static-analysis'
 *   environment — 'production' | 'staging' | 'local'
 *   confidence  — optional 'high' | 'medium' | 'low'; defaults to high for a
 *                 direct production probe, medium otherwise, and is forced to
 *                 low whenever anything is BLOCKED.
 */
function Gate(opts) {
  this.name        = opts.name;
  this.evidence    = opts.evidence || 'unspecified';
  this.environment = opts.environment || 'unknown';
  this.confidence  = opts.confidence || null;
  this.notes       = [];
  this.assertions  = [];
  this.startedAt   = new Date().toISOString();
}

Gate.prototype.pass    = function (label, detail) { return this._add(PASS, label, detail); };
Gate.prototype.fail    = function (label, detail) { return this._add(FAIL, label, detail); };
/** reason is REQUIRED: "blocked" with no cause is indistinguishable from a shrug. */
Gate.prototype.blocked = function (label, reason)  { return this._add(BLOCKED, label, reason); };

Gate.prototype._add = function (status, label, detail) {
  this.assertions.push({ status, label, detail: detail || null });
  const tag = status === PASS ? 'PASS' : status === FAIL ? '** FAIL **' : 'BLOCKED';
  console.log('  ' + tag.padEnd(11) + label + (detail ? '   ' + detail : ''));
  return this;
};

Gate.prototype.note = function (text) { this.notes.push(text); return this; };

Gate.prototype.status = function () {
  if (this.assertions.some(a => a.status === FAIL)) return FAIL;
  if (this.assertions.some(a => a.status === BLOCKED)) return BLOCKED;
  return this.assertions.length ? PASS : BLOCKED;   /* nothing run is not a pass */
};

Gate.prototype.counts = function () {
  return this.assertions.reduce((a, x) => {
    a[x.status.toLowerCase()] = (a[x.status.toLowerCase()] || 0) + 1; return a;
  }, { pass: 0, fail: 0, blocked: 0 });
};

/**
 * Print the summary and persist the record. Returns the process exit code:
 * 0 for PASS, 1 for FAIL, 2 for BLOCKED — distinct so CI can treat "could not
 * observe" differently from "observed and wrong".
 */
Gate.prototype.finish = function (opts) {
  opts = opts || {};
  const status = this.status();
  const c = this.counts();
  const commit = shortCommit();

  let confidence = this.confidence;
  if (!confidence) {
    confidence = (this.environment === 'production' && this.evidence === 'production-probe')
      ? 'high' : 'medium';
  }
  /* An unobserved assertion cannot support confidence, whatever the caller says. */
  if (c.blocked > 0) confidence = 'low';

  const record = {
    gate: this.name,
    status,
    counts: c,
    evidence: this.evidence,
    environment: this.environment,
    commit,
    workingTreeDirty: dirty(),
    confidence,
    startedAt: this.startedAt,
    finishedAt: new Date().toISOString(),
    assertions: this.assertions,
    notes: this.notes,
  };

  console.log('\n  ' + this.name + ': ' + status +
              '   (' + c.pass + ' pass · ' + c.fail + ' fail · ' + c.blocked + ' blocked)');
  console.log('  evidence ' + this.evidence + ' · env ' + this.environment +
              ' · commit ' + commit + (record.workingTreeDirty ? ' (tree dirty)' : '') +
              ' · confidence ' + confidence);
  if (status === BLOCKED) {
    console.log('  BLOCKED is not a pass. These assertions were never observed:');
    this.assertions.filter(a => a.status === BLOCKED)
      .forEach(a => console.log('    · ' + a.label + (a.detail ? ' — ' + a.detail : '')));
  }
  this.notes.forEach(n => console.log('  note: ' + n));

  if (opts.write !== false) {
    try {
      const dir = path.join('docs', 'release-gates');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, this.name + '-' + commit + '.json');
      fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
      console.log('  record: ' + file);
    } catch (e) {
      console.log('  (could not write gate record: ' + e.message + ')');
    }
  }
  console.log('');
  return status === PASS ? 0 : status === FAIL ? 1 : 2;
};

module.exports = { Gate, PASS, FAIL, BLOCKED };
