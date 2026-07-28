const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'audit-protected-bootstrap-output.json');
const raw = fs.readFileSync(file);
const json = JSON.parse(raw.toString('utf16le'));
console.log('total', json.total, 'valid', json.validCount, 'invalid', json.invalidCount);
json.pages.filter(p => !p.valid).forEach(page => {
  console.log('PAGE:', page.file);
  console.log('  ISSUES:', page.issues.join('; '));
  console.log('  ORDER:', page.scriptOrder.map(s => s.src || '[inline]').join(' | '));
});
