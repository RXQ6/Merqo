const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'artifacts/m0'), { recursive: true });
const log = fs.createWriteStream(path.join(root, 'artifacts/m0/desktop-process.log'));
const env = { ...process.env, ELECTRON_ENABLE_LOGGING: '1' };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(path.join(root, 'node_modules/electron/dist/electron.exe'), [path.join(root, 'scripts/retailpilot-desktop-smoke.cjs')], {
  cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
});
child.stdout.pipe(log, { end: false });
child.stderr.pipe(log, { end: false });
const timeout = setTimeout(() => { child.kill(); console.error('Desktop process timed out'); process.exitCode = 1; }, 75000);
child.on('error', error => { console.error(error); clearTimeout(timeout); process.exitCode = 1; log.end(); });
child.on('exit', code => {
  clearTimeout(timeout); log.end(); process.exitCode = code ?? 1;
  const result = path.join(root, 'artifacts/m0/desktop-smoke.json');
  console.log(fs.existsSync(result) ? fs.readFileSync(result, 'utf8') : `No smoke result; exit code ${code}`);
});
