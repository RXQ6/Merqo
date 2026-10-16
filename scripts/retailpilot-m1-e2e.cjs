const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, '.runtime', `m1-e2e-${Date.now()}`);
fs.mkdirSync(path.join(root, 'artifacts/m1'), { recursive: true });
async function run(phase) {
  const env = { ...process.env, RETAILPILOT_M1_PROFILE: profile, RETAILPILOT_M1_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE; delete env.RETAILPILOT_VERIFY_VISIBLE;
  const log = fs.createWriteStream(path.join(root, 'artifacts/m1', `process-${phase}.log`));
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'scripts/retailpilot-m1-host.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('M1 process timeout')); }, 100000);
    child.on('error', error => { clearTimeout(timer); log.end(); reject(error); });
    child.on('exit', code => { clearTimeout(timer); log.end(); if (code !== 0) reject(new Error(`M1 ${phase} failed, see artifacts/m1/e2e-${phase}.json`)); else resolve(); });
  });
  console.log(fs.readFileSync(path.join(root, 'artifacts/m1', `e2e-${phase}.json`), 'utf8'));
}
(async () => { await run('initial'); await run('restart'); })().catch(error => { console.error(error); process.exitCode = 1; });
