// Isolated native Electron UI check, including an actual restart. No external model calls.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const profile = path.join(root, '.runtime', `member-check-${Date.now()}`);
const out = path.join(root, 'artifacts', 'members'); fs.mkdirSync(out, { recursive: true });
async function run(phase) {
  const env = { ...process.env, RETAILPILOT_M1_PROFILE: profile, RETAILPILOT_M1_PHASE: phase };
  delete env.ELECTRON_RUN_AS_NODE; delete env.RETAILPILOT_VERIFY_VISIBLE;
  const log = fs.createWriteStream(path.join(out, `${phase}.log`));
  const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'scripts/retailpilot-m1-host.cjs')], { cwd: root, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Member ${phase} timed out`)); }, 120000);
    child.on('error', e => { clearTimeout(timer); log.end(); reject(e); });
    child.on('exit', code => { clearTimeout(timer); log.end(); code === 0 ? resolve() : reject(new Error(`Member ${phase} failed; see ${out}`)); });
  });
  const result = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/m1', `e2e-${phase}.json`), 'utf8'));
  if (!result.ok || result.profile !== profile || result.phase !== phase || result.error || result.failures?.length) throw new Error('Missing matching successful member verification');
  fs.writeFileSync(path.join(out, `${phase}.json`), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ phase, ok: result.ok, checks: result.checks.length }));
}
(async () => { await run('members'); await run('members-restart'); })().catch(error => { console.error(error); process.exitCode = 1; });
