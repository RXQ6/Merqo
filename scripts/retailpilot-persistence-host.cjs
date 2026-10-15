// Can run in Node or ELECTRON_RUN_AS_NODE. The host never imports bun:sqlite.
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const result = spawnSync(process.env.CRAFT_BUN || 'bun', [path.join(root, 'scripts/retailpilot-sqlite-probe.ts')], {
  cwd: root, env, encoding: 'utf8', windowsHide: true, timeout: 30000,
});
if (result.error || result.status !== 0) throw result.error || new Error(result.stderr);
const probe = JSON.parse(result.stdout.trim());
if (probe.ok !== true) throw new Error('Persistence probe failed');
console.log(JSON.stringify({ host: process.versions.electron ? 'electron-node' : 'node', node: process.versions.node, electron: process.versions.electron || null, ...probe }, null, 2));
