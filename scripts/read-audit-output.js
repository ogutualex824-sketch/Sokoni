const fs = require('fs');
const path = require('path');
const filePath = path.join(__dirname, 'audit-protected-bootstrap-output.json');
const raw = fs.readFileSync(filePath);
const text = raw.toString('utf16le');
console.log(text);
