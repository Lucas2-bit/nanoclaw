const fs = require('fs');
const p = require('path').join(__dirname, 'index.ts');
let s = fs.readFileSync(p, 'utf8');
s = s.replace(
  '  let sessionId = sessions[group.folder];',
  '  let sessionId: string | undefined = sessions[group.folder];'
);
fs.writeFileSync(p, s, 'utf8');
console.log('Type annotation fixed.');
