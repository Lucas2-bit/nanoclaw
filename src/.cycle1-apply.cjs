// Cycle 1 — hang hardening (finding 1): make outputChain always settle so the
// container 'close' handler's outputChain.then(resolve) can never be stranded by
// a rejected onOutput. Fail-loud: refuses unless the exact anchor matches once.
const fs = require('fs');
const f = '/Users/lucascarroll/nanoclaw/src/container-runner.ts';
const oldS = "            outputChain = outputChain.then(() => onOutput(parsed));";
const newS = [
  "            outputChain = outputChain",
  "              .then(() => onOutput(parsed))",
  "              .catch((err) => {",
  "                logger.warn(",
  "                  { group: group.name, error: err },",
  "                  'onOutput handler rejected; continuing so the run can still resolve',",
  "                );",
  "              });",
].join("\n");
let c = fs.readFileSync(f, 'utf8');
const n = c.split(oldS).length - 1;
if (n !== 1) {
  console.log('FAIL: anchor count=' + n + ' (expected 1). Live differs from snapshot. No change written.');
  process.exit(1);
}
c = c.replace(oldS, newS);
fs.writeFileSync(f, c);
console.log('OK: applied .catch hardening to container-runner.ts (anchor replaced exactly once).');
