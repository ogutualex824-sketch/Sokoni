#!/usr/bin/env node
'use strict';
/* Admin (admin-os.html) + Super Admin (super-admin.html) sidebars in the merchant-v2 shell style (owner 2026-10-03).
   STYLE ONLY. Static checks on both pages + admin-sidebar-shell.css. The rendered check (desktop / collapsed / phone
   screenshots, the menu scrolls to its last item, sign-out stays visible) is OWED to a browser run at >= 512 MB free. */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
let pass = 0, fail = 0;
const ck = (id, ok, m, got) => { console.log('  ' + (ok ? 'PASS' : 'FAIL') + ' ' + id + ' ' + m + (ok || got === undefined ? '' : '   [got ' + String(got).slice(0, 160) + ']')); ok ? pass++ : fail++; };
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const live = (f) => execSync('git show 72dca56:' + f, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 << 20 });
const CSS = read('admin-sidebar-shell.css'), MV2 = read('merchant-v2.html');
const CODE = CSS.replace(/\/\*[\s\S]*?\*\//g, '');
const tok = (src, name) => { const m = src.match(new RegExp('--' + name + '\\s*:\\s*([^;]+);')); return m ? m[1].trim() : null; };
const LINK = '<link rel="stylesheet" href="sokoni-admin-responsive.css">\n</head>';
const LINK_NEW = '<link rel="stylesheet" href="sokoni-admin-responsive.css">\n<!-- Sidebar in the merchant-v2.html shell style (same size, fixed, header/footer pinned, menu scrolls).\n     STYLE ONLY, loaded last so it wins; no markup or behaviour change (owner 2026-10-03). -->\n<link rel="stylesheet" href="admin-sidebar-shell.css">\n</head>';

for (const [page, pre] of [['admin-os.html', 'aos'], ['super-admin.html', 'sa']]) {
  const H = read(page), head = H.slice(0, H.indexOf('</head>'));
  const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((m) => m[1]);
  /* (2026-10-04) the Finance Center stylesheet now follows it; it is scoped to .sfc, so order relative to it is irrelevant —
     what matters is that the shell wins over the page's own styles and the responsive module. */
  ck(pre + '-1', links.indexOf('admin-sidebar-shell.css') > links.indexOf('sokoni-admin-responsive.css') && links.indexOf('admin-sidebar-shell.css') > Math.max(links.indexOf('sokoni-tokens.css'), -1) && links.slice(links.indexOf('admin-sidebar-shell.css') + 1).every((l) => l === 'sokoni-finance-center.css'),
    page + ': the shell stylesheet loads after the page styles and the responsive module (only the .sfc-scoped Finance Center may follow)', links.join(','));
  const asideOf = (h) => h.slice(h.indexOf('<aside class="' + pre + '-sidebar"'), h.indexOf('</aside>', h.indexOf('<aside class="' + pre + '-sidebar"')));
  ck(pre + '-2', asideOf(H).replace(/\r/g, '') === asideOf(live(page)).replace(/\r/g, '') && asideOf(H).length > 200 && H.replace(/\r/g, '').includes(LINK_NEW.split('\n</head>')[0].split('\n').pop()),
    page + ': SIDEBAR STYLE ONLY — the sidebar markup (every nav item and control) is byte-identical to live 72dca56; the shell <link> is present');
  ck(pre + '-3', new RegExp('\\.' + pre + '-sidebar[,)]').test(CSS) && new RegExp('\\.' + pre + '-sidebar-footer').test(CSS) && new RegExp('\\.' + pre + '-logo').test(CSS),
    page + ': its sidebar, logo header and footer are styled by the shell');
  ck(pre + '-4', /shared-header\.js|sw-register\.js/.test(H), page + ': still self-updates after deploys');
}
/* owner 2026-10-03: "admin-os.html and super-admin.html" — not admin.html (nor the legacy superadmin.html) */
ck('X-1', ['admin.html', 'superadmin.html'].every((f) => read(f).replace(/\r/g, '') === live(f).replace(/\r/g, '')),
  'SCOPE: only admin-os.html and super-admin.html change; admin.html and superadmin.html are byte-identical to live');
ck('S-1', tok(CSS, 'adm-rail-w') === tok(MV2, 'rail-w') && tok(CSS, 'adm-rail-collapsed') === tok(MV2, 'rail-collapsed') && /--aos-sidebar-w:var\(--adm-rail-w\)/.test(CSS) && /--sidebar-w:var\(--adm-rail-w\)/.test(CSS),
  'SAME SIZE as merchant-v2 on BOTH pages: rail ' + tok(MV2, 'rail-w') + ', collapsed ' + tok(MV2, 'rail-collapsed'));
ck('S-2', ['surface', 'line', 'txt', 'txt2', 'txt3', 'acc', 'acc-dim', 'acc-line'].every((n) => tok(CSS, 'adm-side-' + n) === tok(MV2, n)),
  "SAME STYLE: surface, hairline, text and accent tokens are merchant-v2's exact values");
const rail = (CODE.match(/:is\(\.aos-sidebar,\.sa-sidebar\)\{[^}]*\}/) || [''])[0];
ck('S-3', /position:fixed/.test(rail) && /overflow-y:auto/.test(rail) && /min-height:0/.test(rail) && /height:100dvh/.test(rail),
  'FIXED and SCROLLABLE: fixed full-height rail that scrolls (min-height:0, so it scrolls instead of clipping)', rail);
ck('S-4', /:is\(\.aos-logo,\.sa-logo\)\{[^}]*position:sticky;top:0/.test(CODE) && /:is\(\.aos-sidebar-footer,\.sa-sidebar-footer\)\{[^}]*position:sticky;bottom:0/.test(CODE),
  'the logo header and the sign-out footer are PINNED on both pages — only the menu scrolls');
ck('S-5', /width:min\(84vw,var\(--adm-rail-w\)\)/.test(CODE), "phone drawer uses merchant-v2's width rule min(84vw, rail)");
ck('S-6', !/pointer-events|display:none|visibility:hidden|(^|[;{\s])content:|onclick|cursor:\s*not-allowed/.test(CODE), 'the stylesheet hides, disables or adds NO control (style only)');
ck('S-7', /\.nav-item\.active\{[^}]*--adm-side-acc-dim[^}]*--adm-side-acc\)[^}]*--adm-side-acc-line/.test(CODE.replace(/\s+/g, '')), 'the active item is the merchant-v2 accent pill');
console.log('\nRESULT: ' + pass + ' passed, ' + fail + ' failed  (rendered check OWED: browser at >= 512 MB)');
process.exit(fail ? 1 : 0);
