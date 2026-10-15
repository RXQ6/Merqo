const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'docs/baseline/upstream-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
let checked = 0;
for (const file of manifest.files) {
  const bytes = fs.readFileSync(path.join(manifest.source, file.path));
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Original source changed: ${file.path}`);
  checked++;
}
console.log(`Original source unchanged: ${checked} SHA-256 matches`);
