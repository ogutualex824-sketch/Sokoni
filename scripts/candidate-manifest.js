#!/usr/bin/env node
/* candidate-manifest.js — exact source/blob manifest + absence proof for the providerDispatch shell-gate candidate.
 *
 *   node scripts/candidate-manifest.js --candidate <worktree> --archive <extracted archive dir> --gate <gate line functions dir> --out <json>
 *
 * READ ONLY. Emits: every file under functions/ with its git blob hash and origin (archive | gate | dispatcher-edit),
 * the dispatcher closure, the excluded-module proof (each must be ARCHIVE-IDENTICAL or ABSENT), and the diff against the pin.
 */
'use strict';
const fs = require('fs'); const P = require('path'); const cp = require('child_process');
const args = process.argv.slice(2); const arg = (k) => args[args.indexOf(k) + 1];
const CAND = arg('--candidate'), ARCH = arg('--archive'), GATE = arg('--gate'), OUT = arg('--out');
const blob = (p) => cp.execFileSync('git', ['hash-object', p], { encoding: 'utf8' }).trim();
const walk = (dir, base) => { const out = []; for (const e of fs.readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === '.env') continue; const p = P.join(dir, e.name); const rel = P.posix.join(base || '', e.name); if (e.isDirectory()) out.push(...walk(p, rel)); else out.push(rel); } return out; };
const candFiles = walk(P.join(CAND, 'functions')).sort();
const GATE_SET = ['business-workspace.js', 'shared/approval-remediation.js', 'shared/business-capabilities.js', 'shared/business-scope.js', 'shared/cleanup-claimed-ids.json', 'business-category.js', 'capability-authority.js', 'healthcare-category.js', 'healthcare-plans.js', 'healthcare-workspace.js'];
const EXCLUDED = ['commission-config.js', 'finos-utils.js', 'subscription-core.js', 'subscription-catalog.js', 'notify.js', 'sms-service.js', 'provider-onboarding.js', 'provider-ops.js', 'booking-service.js', 'booking-payment-sweep.js', 'availability.js', 'legal-agreements.js', 'provider-shop.js', 'sokoni-till.js', 'sokoni-qr-authority.js', 'event-ops.js', 'entertainment-bookings.js', 'ent-availability.js', 'ent-rate-cards.js', 'ent-enquiries.js', 'creator-hub.js', 'financial-os.js', 'venue-payments.js', 'provider-directory.js', 'reputation.js', 'provider-hub.js', 'kasshop.js', 'application-lifecycle.js', 'role-authority.js', 'business-wallet.js', 'money-authority.js', 'seller-trial.js', 'tenant-identity.js', 'shop-employees.js', 'business-approval-admin.js', 'universal-onboarding.js'];
const files = candFiles.map((f) => { const cp_ = P.join(CAND, 'functions', f), ap = P.join(ARCH, f), gp = P.join(GATE, f); const b = blob(cp_); const inArch = fs.existsSync(ap); const archB = inArch ? blob(ap) : null; const gateB = fs.existsSync(gp) ? blob(gp) : null; let origin; if (f === 'provider-dispatch.js') origin = 'dispatcher-edit (archive + 2 edits)'; else if (inArch && archB === b) origin = 'archive'; else if (GATE_SET.includes(f) && gateB === b) origin = 'gate (identical to slice/c4-capability-consumer)'; else origin = 'UNEXPECTED'; return { file: f, blob: b, origin, archiveBlob: archB, gateBlob: gateB }; });
const unexpected = files.filter((x) => x.origin === 'UNEXPECTED');
const excluded = EXCLUDED.map((f) => { const cp_ = P.join(CAND, 'functions', f), ap = P.join(ARCH, f); if (!fs.existsSync(cp_)) return { file: f, state: 'ABSENT' }; if (fs.existsSync(ap) && blob(cp_) === blob(ap)) return { file: f, state: 'ARCHIVE-IDENTICAL' }; return { file: f, state: 'CHANGED — VIOLATION' }; });
const closure = JSON.parse(cp.execFileSync(process.execPath, [(process.env.CLOSURE_JS || P.join(__dirname, 'lib', 'require-closure.js')), P.join(CAND, 'functions'), 'provider-dispatch.js'], { encoding: 'utf8' }));
const archOnly = walk(ARCH).filter((f) => !fs.existsSync(P.join(CAND, 'functions', f)));
const out = { at: new Date().toISOString(), candidate: { worktree: CAND, tip: cp.execFileSync('git', ['-C', CAND, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(), branch: cp.execFileSync('git', ['-C', CAND, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8' }).trim(), pinCommit: cp.execFileSync('git', ['-C', CAND, 'log', '--format=%h', '--grep=pin(providerDispatch)', '-1'], { encoding: 'utf8' }).trim(), base: '8c1c4fe' }, archive: { source: 'gs://gcf-v2-sources-24799054989-us-central1/providerDispatch/function-source.zip#1787386174474483', uploaded: '2026-08-22T08:09:34Z', files: walk(ARCH).length, filesMissingFromCandidate: archOnly }, counts: { total: files.length, archive: files.filter((x) => x.origin === 'archive').length, gate: files.filter((x) => x.origin.startsWith('gate')).length, dispatcherEdit: 1, unexpected: unexpected.length }, dispatcherClosure: closure.files, dispatcherClosureSize: closure.size, excludedProof: excluded, excludedViolations: excluded.filter((e) => /VIOLATION/.test(e.state)).length, unexpected, files };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
console.log(JSON.stringify({ tip: out.candidate.tip, counts: out.counts, closure: out.dispatcherClosureSize, excludedViolations: out.excludedViolations, archiveFilesMissingFromCandidate: archOnly.length }));
console.log('excluded:', excluded.map((e) => e.file + '=' + e.state).join(' '));
