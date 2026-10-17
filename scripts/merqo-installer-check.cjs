const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const release = require('../packaging/windows-release.json');
const out = path.join(root, 'artifacts/windows/verification'); fs.mkdirSync(out, { recursive: true });
const install = fs.mkdtempSync(path.join(out, 'installed-'));
const installer = path.join(root, `artifacts/windows/${release.version}/Merqo-Setup-${release.version}-x64.exe`);
const exe = path.join(install, 'Merqo.exe');
const checks = [];
async function run(executable, args, logName) {
  const log = fs.createWriteStream(path.join(out, logName));
  const child = spawn(executable, args, { cwd: root, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error(`${logName}: timed out`)); }, 240000);
    child.once('error', error => { clearTimeout(timer); log.end(); reject(error); });
    child.once('exit', code => { clearTimeout(timer); log.end(); code === 0 ? resolve() : reject(new Error(`${logName}: exit ${code}`)); });
  });
}
async function main() {
  await run(installer, ['/S', `/D=${install}`], 'install.log'); assert.ok(fs.existsSync(exe));
  checks.push('per-user NSIS silent install succeeds into isolated directory');
  await run(process.execPath, [path.join(__dirname, 'merqo-packaged-smoke.cjs'), exe], 'installed-smoke.log');
  const smoke = JSON.parse(fs.readFileSync(path.join(out, 'packaged-smoke.json'), 'utf8')); assert.equal(smoke.ok, true);
  checks.push(...smoke.checks);
  await run(installer, ['/S', `/D=${install}`], 'reinstall.log');
  await run(process.execPath, [path.join(__dirname, 'merqo-packaged-smoke.cjs'), exe, '--restore-profile', smoke.profile], 'restored-smoke.log');
  const restored = JSON.parse(fs.readFileSync(path.join(out, 'packaged-restored.json'), 'utf8'));
  assert.equal(restored.ok, true); assert.equal(restored.receiptId, smoke.receiptId); checks.push(...restored.checks);
  const name = fs.readdirSync(install).find(name => /^Uninstall.*\.exe$/i.test(name)); assert.ok(name);
  await run(path.join(install, name), ['/S'], 'uninstall.log');
  const deadline = Date.now() + 60000;
  while (fs.existsSync(exe) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 250));
  assert.equal(fs.existsSync(exe), false); assert.ok(fs.existsSync(path.join(smoke.profile, 'config/config.json')));
  checks.push('NSIS uninstall removes installed executable and retains isolated user configuration');
  const report = { ok: true, installer, install, signed: false, checks, modelFixture: true, liveModelQuality: false, limits: ['same-version reinstall; cross-version upgrade not tested', 'isolated custom user-data paths; real user profile untouched', 'no SmartScreen reputation or code-signing certificate', 'no clean Windows VM tested'] };
  fs.writeFileSync(path.join(out, 'installer-lifecycle.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
main().catch(error => { fs.writeFileSync(path.join(out, 'installer-lifecycle.json'), JSON.stringify({ ok: false, error: String(error), checks, install }, null, 2)); console.error(error); process.exitCode = 1; });
