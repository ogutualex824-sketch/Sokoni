const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'patch-protected-bootstrap-safe-output.json');
const raw = fs.readFileSync(file);
let data = raw.toString('utf16le');
if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
const json = JSON.parse(data);
console.log('modifiedCount', json.modifiedCount);
console.log('skippedCount', json.skippedCount);
console.log('failedCount', json.failedCount);
json.report.forEach(item => {
  if (item.status !== 'compliant') {
    console.log(item.page, item.status, item.reason || '');
  }
});
