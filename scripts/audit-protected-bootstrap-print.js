const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'audit-protected-bootstrap-direct-output.json');
const raw = fs.readFileSync(file);
let data = raw.toString('utf16le');
if (data.charCodeAt(0) === 0xfeff) data = data.slice(1);
const json = JSON.parse(data);
console.log(json.invalidCount);
json.invalid.forEach(p => console.log(p.file));
