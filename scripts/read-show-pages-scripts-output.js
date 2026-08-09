const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, 'show-pages-scripts-output.txt');
const raw = fs.readFileSync(file);
let text = raw.toString('utf16le');
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
console.log(text);
