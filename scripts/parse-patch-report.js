const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'patch-protected-bootstrap-safe-output.json');
let raw = fs.readFileSync(file);
let data = raw.toString('utf16le');
if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
const json = JSON.parse(data);
console.log(JSON.stringify(json.report.map(r => ({ page: r.page, status: r.status, reason: r.reason || null })), null, 2));
