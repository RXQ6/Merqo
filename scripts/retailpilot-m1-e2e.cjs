const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const restartOnly = process.argv.includes('--restart');
const initial = restartOnly ? JSON.parse(fs.readFileSync(path.join(root, 'artifacts/m1/e2e-initial.json'), 'utf8')) : null;
const profile = initial ? path.resolve(initial.profile) : path.join(root, '.runtime', `m1-e2e-${Date.now()}`);
if(initial && (!initial.ok || !profile.startsWith(path.join(root, '.runtime') + path.sep))) throw new Error('Restart requires a successful isolated initial run');
fs.mkdirSync(path.join(root, 'artifacts/m1'), { recursive: true });
async function run(phase) {
  const env = { ...process.env, RETAILPILOT_M1_PROFILE: profile, RETAILPILOT_M1_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE; delete env.RETAILPILOT_VERIFY_VISIBLE;
  const log = fs.createWriteStream(path.join(root, 'artifacts/m1', `process-${phase}.log`));
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'scripts/retailpilot-m1-host.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('M1 process timeout')); }, 310000);
    child.on('error', error => { clearTimeout(timer); log.end(); reject(error); });
    child.on('exit', code => { clearTimeout(timer); log.end(); if (code !== 0) reject(new Error(`M1 ${phase} failed, see artifacts/m1/e2e-${phase}.json`)); else resolve(); });
  });
  const result=JSON.parse(fs.readFileSync(path.join(root, 'artifacts/m1', `e2e-${phase}.json`), 'utf8'));
  if(result.ok!==true||result.profile!==profile||result.phase!==phase||result.error||result.failures?.length)throw new Error(`M1 ${phase} did not produce a matching successful result`);
  console.log(JSON.stringify(result,null,2));
}
(async () => { if (!restartOnly) await run('initial'); await run('restart'); })().catch(error => { console.error(error); process.exitCode = 1; });
