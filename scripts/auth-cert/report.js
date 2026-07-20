/* Reporters — console, JSON, HTML.

   One rule governs all three: SKIPPED is rendered as prominently as FAIL.
   A reader skimming any of these outputs must not be able to come away
   believing the platform is certified when half the checks never ran. */
'use strict';
const fs = require('fs');
const path = require('path');

const MARK = { PASS: '  PASS   ', FAIL: '  FAIL   ', SKIPPED: '  SKIP   ', ERROR: '  ERROR  ' };

function console_(sum, ctx) {
  const byLayer = {};
  sum.results.forEach((r) => { (byLayer[r.layer] = byLayer[r.layer] || []).push(r); });

  for (const n of Object.keys(byLayer).sort()) {
    console.log('\n' + byLayer[n][0].layerLabel);
    console.log('─'.repeat(72));
    for (const r of byLayer[n]) {
      console.log(MARK[r.status] + r.title);
      console.log('           ' + r.evidence);
      if (r.status !== 'PASS' && r.remediation) console.log('           -> ' + r.remediation);
    }
  }

  const t = sum.totals;
  console.log('\n' + '═'.repeat(72));
  console.log('  ' + t.passed + ' passed   ' + t.failed + ' failed   ' + t.skipped + ' skipped   ' + t.errored + ' errored');
  console.log('  VERDICT: ' + sum.verdict);
  if (sum.verdict === 'INCOMPLETE') {
    console.log('\n  INCOMPLETE is not a pass. ' + t.skipped + ' check(s) could not run, so the');
    console.log('  platform state they cover is UNKNOWN — not healthy.');
  }
  console.log('═'.repeat(72) + '\n');
  return sum;
}

function json_(sum, ctx) {
  const doc = {
    tool: 'sokoni-auth-cert',
    version: 1,
    generatedAt: ctx.now,
    project: process.env.SOKONI_GCP_PROJECT || 'sokoni-aeb26',
    origin: process.env.SOKONI_SMOKE_ORIGIN || 'https://mysokoni.co.ke',
    verdict: sum.verdict,
    totals: sum.totals,
    results: sum.results,
  };
  const out = path.join(ctx.outDir, 'auth-certification.json');
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(doc, null, 2));
  return out;
}

const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function html_(sum, ctx) {
  const COLOR = { PASS: '#71ff00', FAIL: '#ff4d4d', SKIPPED: '#ffb020', ERROR: '#c77dff' };
  const rows = sum.results.map((r) => `
    <tr>
      <td><span class="pill" style="--c:${COLOR[r.status]}">${esc(r.status)}</span></td>
      <td><div class="ttl">${esc(r.title)}</div><div class="id">${esc(r.id)}</div></td>
      <td class="ev">${esc(r.evidence)}${r.remediation && r.status !== 'PASS'
        ? `<div class="rem">${esc(r.remediation)}</div>` : ''}</td>
    </tr>`).join('');

  const t = sum.totals;
  const vColor = sum.verdict === 'CERTIFIED' ? '#71ff00' : sum.verdict === 'INCOMPLETE' ? '#ffb020' : '#ff4d4d';

  const doc = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SOKONI — Authentication Certification</title><style>
*{box-sizing:border-box}body{margin:0;background:#050505;color:#e8e8e8;
font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;padding:32px 20px}
.wrap{max-width:1000px;margin:0 auto}h1{font-size:20px;letter-spacing:.04em;text-transform:uppercase;margin:0 0 4px}
.sub{color:#8a8a8a;font-size:13px;margin-bottom:28px}
.verdict{border:1px solid var(--c);color:var(--c);border-radius:10px;padding:18px 22px;margin-bottom:8px}
.verdict b{font-size:26px;letter-spacing:.06em}
.note{background:#1a1206;border-left:3px solid #ffb020;padding:12px 16px;border-radius:6px;
color:#ffd89b;font-size:13px;margin:14px 0 26px}
.tot{display:flex;gap:22px;font-size:13px;color:#9a9a9a;margin:14px 0 26px;flex-wrap:wrap}
.tot b{color:#e8e8e8;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse}td{padding:13px 10px;border-bottom:1px solid #1b1b1b;vertical-align:top}
.pill{display:inline-block;border:1px solid var(--c);color:var(--c);border-radius:999px;
padding:2px 11px;font-size:11px;letter-spacing:.08em;white-space:nowrap}
.ttl{font-weight:600}.id{color:#6a6a6a;font-size:11.5px;font-family:ui-monospace,monospace;margin-top:3px}
.ev{color:#b4b4b4;font-size:13px}.rem{color:#ffb020;font-size:12.5px;margin-top:7px}
@media(max-width:620px){td{display:block;border:0;padding:4px 0}tr{display:block;border-bottom:1px solid #1b1b1b;padding:12px 0}}
</style></head><body><div class="wrap">
<h1>Authentication Certification</h1>
<div class="sub">${esc(ctx.now)} &nbsp;·&nbsp; ${esc(process.env.SOKONI_SMOKE_ORIGIN || 'https://mysokoni.co.ke')}</div>
<div class="verdict" style="--c:${vColor}"><b>${esc(sum.verdict)}</b></div>
${sum.verdict === 'INCOMPLETE' ? `<div class="note"><b>INCOMPLETE is not a pass.</b> ${t.skipped}
check(s) could not run — the platform state they cover is UNKNOWN, not healthy. Certification
requires every check to run and pass.</div>` : ''}
<div class="tot"><span>passed <b>${t.passed}</b></span><span>failed <b>${t.failed}</b></span>
<span>skipped <b>${t.skipped}</b></span><span>errored <b>${t.errored}</b></span></div>
<table>${rows}</table></div></body></html>`;

  const out = path.join(ctx.outDir, 'auth-certification.html');
  fs.mkdirSync(ctx.outDir, { recursive: true });
  fs.writeFileSync(out, doc);
  return out;
}

module.exports = { console: console_, json: json_, html: html_ };
