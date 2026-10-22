const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const release = require('../packaging/windows-release.json');
const out = path.join(root, 'artifacts/windows/verification',release.version); fs.mkdirSync(out, { recursive: true });
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
  await run(process.execPath,[path.join(__dirname,'merqo-commerce-extension-check.cjs'),exe],'commerce-smoke.log');
  const commerce=JSON.parse(fs.readFileSync(path.join(out,'commerce-smoke.log'),'utf8').trim());assert.equal(commerce.ok,true);checks.push(...commerce.checks);
  fs.copyFileSync(path.join(commerce.out,'result.json'),path.join(out,'commerce-installed.json'));
  await run(process.execPath,[path.join(__dirname,'merqo-deepseek-models-check.cjs'),exe],'deepseek-smoke.log');
  const deepseek=JSON.parse(fs.readFileSync(path.join(out,'deepseek-smoke.log'),'utf8').trim());assert.equal(deepseek.ok,true);checks.push(...deepseek.checks);
  fs.copyFileSync(path.join(deepseek.out,'result.json'),path.join(out,'deepseek-installed.json'));
  const previousPreviewProfile=process.env.MERQO_PREVIEW_PROFILE;
  process.env.MERQO_PREVIEW_PROFILE=smoke.profile;
  try {
    await run(process.execPath,[path.join(__dirname,'merqo-update-ui-check.cjs'),exe],'update-smoke.log');
  } finally {
    if(previousPreviewProfile===undefined)delete process.env.MERQO_PREVIEW_PROFILE;else process.env.MERQO_PREVIEW_PROFILE=previousPreviewProfile;
  }
  const update=JSON.parse(fs.readFileSync(path.join(out,'update-smoke.log'),'utf8').trim());assert.equal(update.ok,true);checks.push(...update.checks);
  fs.copyFileSync(path.join(update.out,'result.json'),path.join(out,'update-installed.json'));
  const previousTestExe=process.env.MERQO_TEST_EXE;
  process.env.MERQO_TEST_EXE=exe;
  try { await run(process.execPath,[path.join(__dirname,'merqo-three-batches-check.cjs')],'three-batches-installed.log'); }
  finally { if(previousTestExe===undefined)delete process.env.MERQO_TEST_EXE;else process.env.MERQO_TEST_EXE=previousTestExe; }
  const business=JSON.parse(fs.readFileSync(path.join(out,'three-batches-installed.log'),'utf8').trim().split(/\r?\n/).at(-1));assert.equal(business.ok,true);
  const businessResult=JSON.parse(fs.readFileSync(path.join(business.out,'result.json'),'utf8'));assert.equal(businessResult.packaged,true);checks.push(...businessResult.checks);
  fs.copyFileSync(path.join(business.out,'result.json'),path.join(out,'three-batches-installed.json'));
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
